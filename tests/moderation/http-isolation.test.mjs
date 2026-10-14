/**
 * GY-I14（#14）审核 HTTP 装配片 · **版本重审、发布隔离、下架与读取时重查**（AC16 / AC19）。
 *
 * 声明：全部输入是合成夹具；模型端口是合成替身（不发网络请求、无凭据）。
 * 本文件不调任何真实 TMS/IMS（未授权付费），不得被引用为模型准确率证据。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RULES } from '../../packages/moderation/index.mjs';
import {
  ADMIN,
  USER_A,
  USER_B,
  captureError,
  countingPort,
  makeExtraRule,
  makeHarness,
  seedAuthority,
  textContent,
} from './_http-fixtures.mjs';

const TARGET_V1 = { type: 'post', id: 'post-1001', revision: 1 };
const TARGET_V2 = { type: 'post', id: 'post-1001', revision: 2 };
const EDITED_TEXT = '编辑后的正文：记录苗情、轮换做法与标签条件，不再提其他内容。';

test('筛查通过与发布分开：approved 只是必要条件；未显式发布则不可见，发布后才可见', async () => {
  const tms = countingPort('tms');
  const h = makeHarness({ ports: { tms: tms.port } });
  const content = textContent();
  seedAuthority(h.authority, TARGET_V1, { visibility: 'private', owner_id: USER_A.userId });

  const screening = await h.service.submitScreening({ actor: USER_A, content });
  assert.equal(screening.tasks[0].decision, 'approved');
  assert.equal(screening.overall.publishable, true);

  // 筛查通过**没有**改变可见性：权威侧仍是 private，且没有"已发布 revision"
  assert.equal(h.authority.get(TARGET_V1).visibility, 'private');
  assert.equal(await h.authority.publishedRevision(TARGET_V1), null);
  const ownerView = await h.service.readView({ actor: USER_A, target_ref: TARGET_V1 });
  assert.equal(ownerView.visible, true, '所有者可读自己的未公开内容');
  assert.equal(ownerView.visibility, 'private', '但它**未发布**（筛查通过不等于发布）');
  const stranger = await h.service.readView({ actor: USER_B, target_ref: TARGET_V1 });
  assert.equal(stranger.visible, false, '未发布的草案对他人不可见');
  assert.ok(stranger.reason_codes.includes('SCOPE_DENIED'));

  // 显式发布（第二步）
  const published = await h.service.publish({ actor: USER_A, content });
  assert.equal(published.published, true);
  assert.equal(published.visibility, 'published');
  assert.equal(published.published_revision, 1);
  assert.equal(h.authority.get(TARGET_V1).visibility, 'published');
  assert.equal(await h.authority.publishedRevision(TARGET_V1), 1);
  assert.equal((await h.service.readView({ actor: USER_A, target_ref: TARGET_V1 })).visible, true);
});

test('编辑生成新版本并重审：旧版本审核结果不得套新版本（负例），旧链接也不得可见', async () => {
  const tms = countingPort('tms');
  const h = makeHarness({ ports: { tms: tms.port } });
  const v1 = textContent();
  seedAuthority(h.authority, TARGET_V1, { visibility: 'private', owner_id: USER_A.userId });
  const first = await h.service.submitScreening({ actor: USER_A, content: v1 });
  await h.service.publish({ actor: USER_A, content: v1 });
  assert.equal((await h.service.readView({ actor: USER_A, target_ref: TARGET_V1 })).visible, true);

  // 编辑 ⇒ 新版本 revision=2（权威侧当前版本推进）
  const v2 = textContent({ target_ref: TARGET_V2, text: EDITED_TEXT });
  seedAuthority(h.authority, TARGET_V2, { visibility: 'private', owner_id: USER_A.userId, current_revision: 2 });

  // 负例：新版本**没有**审核结论 ⇒ 直接发布必须被拒（旧结论不得套用）
  const refused = await captureError(() => h.service.publish({ actor: USER_A, content: v2 }));
  assert.equal(refused.code, 'INPUT_UNCERTAIN');
  assert.ok(
    refused.details.some((detail) => detail.code.includes('NOT_SCREENED')),
    JSON.stringify(refused.details),
  );

  // 旧链接（revision=1）在权威侧版本推进后不得可见
  const oldLink = await h.service.readView({ actor: USER_A, target_ref: TARGET_V1 });
  assert.equal(oldLink.visible, false);
  assert.ok(oldLink.reason_codes.includes('REVISION_SUPERSEDED'), oldLink.reason_codes.join(','));

  // 新版本重审 ⇒ 新的版本级任务（新 job_id、新输入绑定），通过后才可发布
  const second = await h.service.submitScreening({ actor: USER_A, content: v2 });
  assert.notEqual(second.tasks[0].job_id, first.tasks[0].job_id, '新版本必须生成新的版本级任务');
  assert.notEqual(
    second.tasks[0].evidence.input_binding_digest,
    first.tasks[0].evidence.input_binding_digest,
    '新版本任务的输入绑定必须指向新内容',
  );
  await h.service.publish({ actor: USER_A, content: v2 });
  const visible = await h.service.readView({ actor: USER_A, target_ref: TARGET_V2 });
  assert.equal(visible.visible, true);
  assert.equal(h.ledger.byJobId(first.tasks[0].job_id).decision, 'approved', '旧版本结论仍留档（审计）');
});

test('发布闸门重跑证据链：同一 target/revision 换正文（同 revision 篡改）一律拒绝', async () => {
  const tms = countingPort('tms');
  const h = makeHarness({ ports: { tms: tms.port } });
  const content = textContent();
  seedAuthority(h.authority, TARGET_V1, { visibility: 'private', owner_id: USER_A.userId });
  await h.service.submitScreening({ actor: USER_A, content });

  const swapped = textContent({ text: '同一 revision 下换成完全不同的正文。' });
  const error = await captureError(() => h.service.publish({ actor: USER_A, content: swapped }));
  assert.equal(error.code, 'REVISION_CONFLICT');
  assert.ok(
    error.details.some((detail) => detail.code.includes('MODEL_LAYER_INPUT_BINDING_MISMATCH')),
    JSON.stringify(error.details),
  );
  assert.equal(h.authority.get(TARGET_V1).visibility, 'private', '被拒的发布不得改变可见性');
});

test('版本变化 ⇒ 旧结论失效（规则集升级 / 模型版本变化），发布被拒且重审报告可判别', async () => {
  const h1 = makeHarness({ ports: { tms: countingPort('tms').port } });
  const content = textContent();
  seedAuthority(h1.authority, TARGET_V1, { visibility: 'private', owner_id: USER_A.userId });
  await h1.service.submitScreening({ actor: USER_A, content });

  // ① 规则集升级（新增一条命中"稗草"的规则）⇒ rule_version 变化
  const upgraded = makeHarness({
    ledger: h1.ledger,
    cache: h1.cache,
    authority: h1.authority,
    ports: { tms: countingPort('tms').port },
    ruleOptions: { rules: [...RULES, makeExtraRule()] },
  });
  const report = await upgraded.service.reReview({ actor: USER_A, target_ref: TARGET_V1 });
  assert.equal(report.tasks.length, 1);
  assert.equal(report.tasks[0].stale, true);
  assert.equal(report.tasks[0].action, 're_review');
  assert.ok(report.tasks[0].reason_codes.includes('RULE_VERSION_CHANGED'), report.tasks[0].reason_codes.join(','));
  assert.equal(report.publishable, false);
  const refused = await captureError(() => upgraded.service.publish({ actor: USER_A, content }));
  assert.equal(refused.code, 'REVISION_CONFLICT');
  assert.equal(h1.authority.get(TARGET_V1).visibility, 'private');

  // ② 模型版本变化（同一规则集、不同模型端口声明）⇒ 旧结论同样失效
  const newModel = makeHarness({
    ledger: h1.ledger,
    cache: h1.cache,
    authority: h1.authority,
    ports: { tms: countingPort('tms', { model_version: 'synthetic-tms-model@9.9' }).port },
  });
  const modelReport = await newModel.service.reReview({ actor: USER_A, target_ref: TARGET_V1 });
  assert.equal(modelReport.tasks[0].stale, true);
  assert.ok(modelReport.tasks[0].reason_codes.includes('MODEL_VERSION_CHANGED'), modelReport.tasks[0].reason_codes.join(','));
  const modelRefused = await captureError(() => newModel.service.publish({ actor: USER_A, content }));
  assert.equal(modelRefused.code, 'REVISION_CONFLICT');
});

test('下架：仅管理员可下架，驱动整链缓存失效；该版本永久不可再发布；新版本重审后方可由管理员恢复', async () => {
  const tms = countingPort('tms');
  const h = makeHarness({ ports: { tms: tms.port } });
  const content = textContent();
  seedAuthority(h.authority, TARGET_V1, { visibility: 'private', owner_id: USER_A.userId });
  await h.service.submitScreening({ actor: USER_A, content });
  await h.service.publish({ actor: USER_A, content });

  // 读两次：发布时已写入缓存条目 ⇒ 第一次读就命中（缓存只作提示，仍以权威为准）
  assert.equal(h.cache.size(), 1, '发布写入缓存条目（仅作提示）');
  const firstRead = await h.service.readView({ actor: USER_A, target_ref: TARGET_V1 });
  assert.equal(firstRead.visible, true);
  assert.equal(firstRead.cache_hit, true);
  const secondRead = await h.service.readView({ actor: USER_A, target_ref: TARGET_V1 });
  assert.equal(secondRead.visible, true);
  assert.equal(secondRead.cache_hit, true);
  assert.equal(h.cache.size(), 1);

  // 非管理员下架 ⇒ 403 SCOPE_DENIED（且不改变可见性）
  const denied = await captureError(() =>
    h.service.withdraw({ actor: USER_A, target_ref: TARGET_V1, reason_code: 'synthetic-takedown' }),
  );
  assert.equal(denied.code, 'SCOPE_DENIED');
  assert.equal(denied.status, 403);
  assert.equal(h.authority.get(TARGET_V1).visibility, 'published');

  // 管理员下架 ⇒ 可见性 hidden + 已发布版本置空 + 缓存整链失效
  const takedown = await h.service.withdraw({ actor: ADMIN, target_ref: TARGET_V1, reason_code: 'synthetic-takedown' });
  assert.equal(takedown.withdrawn, true);
  assert.equal(takedown.visibility, 'hidden');
  assert.deepEqual(takedown.invalidated_cache_keys, ['post|post-1001|1']);
  assert.equal(h.cache.size(), 0);
  assert.equal(takedown.event.kind, 'moderation.takedown');
  assert.equal(JSON.stringify(takedown.event).includes(content.text), false, '下架事件不得携带正文');

  const after = await h.service.readView({ actor: USER_A, target_ref: TARGET_V1 });
  assert.equal(after.visible, false);
  assert.ok(after.reason_codes.includes('CONTENT_HIDDEN'));

  // 下架版本**永久**不可再发布（连管理员也不行）
  for (const actor of [USER_A, ADMIN]) {
    const refused = await captureError(() => h.service.publish({ actor, content }));
    assert.equal(refused.code, 'OBJECT_UNAVAILABLE', `${actor.role} 不得复活已下架版本`);
  }

  // 新版本（revision=2）重审后：普通作者仍不可发布（内容处于下架态），管理员可恢复
  const v2 = textContent({ target_ref: TARGET_V2, text: EDITED_TEXT });
  seedAuthority(h.authority, TARGET_V2, { visibility: 'hidden', owner_id: USER_A.userId, current_revision: 2 });
  await h.service.submitScreening({ actor: USER_A, content: v2 });
  const authorRefused = await captureError(() => h.service.publish({ actor: USER_A, content: v2 }));
  assert.equal(authorRefused.code, 'OBJECT_UNAVAILABLE');
  assert.ok(authorRefused.details.some((detail) => detail.code === 'TARGET_WITHDRAWN'));
  const restored = await h.service.publish({ actor: ADMIN, content: v2 });
  assert.equal(restored.published, true);
  assert.equal((await h.service.readView({ actor: USER_A, target_ref: TARGET_V2 })).visible, true);
});

test('读取时重查可见性（负例）：缓存、隐藏、账号停用/去身份、旧链接都不得重新公开', async () => {
  const tms = countingPort('tms');
  const h = makeHarness({ ports: { tms: tms.port } });
  const content = textContent();
  const target = TARGET_V1;
  seedAuthority(h.authority, target, { visibility: 'private', owner_id: USER_A.userId });
  await h.service.submitScreening({ actor: USER_A, content });
  await h.service.publish({ actor: USER_A, content });
  assert.equal((await h.service.readView({ actor: USER_A, target_ref: target })).visible, true);
  assert.equal(h.cache.size(), 1, '可见读取会写入缓存条目（仅作提示）');

  // ① 权威侧变 hidden（外部下架/失效）⇒ 缓存说 published 也不得放行，并失效该缓存条目
  h.authority.setVisibility(target, 'hidden');
  const hidden = await h.service.readView({ actor: USER_A, target_ref: target });
  assert.equal(hidden.visible, false);
  assert.ok(hidden.reason_codes.includes('CONTENT_HIDDEN'));
  assert.ok(hidden.cache_keys_invalidated.length > 0, '缓存与权威不一致必须立即失效');
  assert.equal(h.cache.size(), 0);

  // ② 已删除
  h.authority.setVisibility(target, 'deleted');
  const deleted = await h.service.readView({ actor: USER_A, target_ref: target });
  assert.equal(deleted.visible, false);
  assert.ok(deleted.reason_codes.includes('CONTENT_DELETED'));

  // ③ 恢复 published 但账号停用 ⇒ 不得公开
  h.authority.setVisibility(target, 'published');
  h.authority.setAuthorState(target, 'inactive');
  const inactive = await h.service.readView({ actor: USER_A, target_ref: target });
  assert.equal(inactive.visible, false);
  assert.ok(inactive.reason_codes.includes('ACCOUNT_INACTIVE'));

  // ④ 注销去身份 ⇒ 不得公开
  h.authority.setAuthorState(target, 'anonymized');
  const anonymized = await h.service.readView({ actor: USER_A, target_ref: target });
  assert.equal(anonymized.visible, false);
  assert.ok(anonymized.reason_codes.includes('AUTHOR_ANONYMIZED'));

  // ⑤ 账号恢复但已发布版本被清空（下架/失效）⇒ 不得公开
  h.authority.setAuthorState(target, 'active');
  await h.authority.setPublishedRevision(target, null);
  const unpublished = await h.service.readView({ actor: USER_A, target_ref: target });
  assert.equal(unpublished.visible, false);
  assert.ok(unpublished.reason_codes.includes('NOT_PUBLISHED'));

  // ⑥ 旧链接：权威侧当前版本已推进到 2 ⇒ revision=1 的链接不得可见
  await h.authority.setPublishedRevision(target, 1);
  h.authority.setCurrentRevision(target, 2);
  const oldLink = await h.service.readView({ actor: USER_A, target_ref: target });
  assert.equal(oldLink.visible, false);
  assert.ok(oldLink.reason_codes.includes('REVISION_SUPERSEDED'));

  // ⑦ private ⇒ 仅所有者可见；他人 403 语义（SCOPE_DENIED），且不得泄露存在性以外的信息
  h.authority.setCurrentRevision(target, 1);
  h.authority.setVisibility(target, 'private');
  await h.authority.setPublishedRevision(target, 1);
  const foreign = await h.service.readView({ actor: USER_B, target_ref: target });
  assert.equal(foreign.visible, false);
  assert.ok(foreign.reason_codes.includes('SCOPE_DENIED'));
  const owner = await h.service.readView({ actor: USER_A, target_ref: target });
  assert.equal(owner.visible, true);

  // ⑧ 无会话 / 目标不存在
  const guest = await h.service.readView({ actor: null, target_ref: target });
  assert.equal(guest.visible, false);
  assert.ok(guest.reason_codes.includes('SESSION_REQUIRED'));
  const missing = await h.service.readView({ actor: USER_A, target_ref: { type: 'post', id: 'post-404', revision: 1 } });
  assert.equal(missing.visible, false);
  assert.ok(missing.reason_codes.includes('NOT_FOUND'));

  // ⑨ 主体校验：缺 userId 一律按无会话处理
  const badActor = await captureError(() =>
    h.service.readView({ actor: { userId: '', role: 'user', authEpoch: 1 }, target_ref: target }),
  );
  assert.equal(badActor.code, 'SESSION_REQUIRED');
});
