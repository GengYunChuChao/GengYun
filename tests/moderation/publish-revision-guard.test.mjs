/**
 * GY-I14（#14）发布闸门 · **权威 revision 先核对 + 写路径零副作用**（AC16 / AC19）。
 *
 * 覆盖诊断 `.pg17/analysis/i14-moderation-gaps-20261019.md` P1-2 的两处缺陷：
 *   1. `publish` 读取权威快照后**先**核对 `current_revision === target.revision`：不一致
 *      ⇒ `REVISION_CONFLICT`，且**在任何写之前**拒绝（此前会先 `setVisibility` 成功、
 *      再在写后核对里抛错 ⇒ 半发布状态 + 旧请求写到新版本上）；
 *   2. 内容权威的 `setVisibility`/`setPublishedRevision` 的 CAS 期望版本取自
 *      `target.revision`（不取行自身当前值），旧 revision 的写入一律拒绝且不改行；
 *   3. 写路径可补偿：写后核对抛错时回写写前可见性，不留"已发布但版本未声明"的中间态。
 *
 * 声明：模型端口是**合成替身**（`provider.synthetic === true`），不发起任何真实模型/付费调用。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../../services/api/src/errors.ts';
import { createSubstituteContentAuthority } from '../../services/api/src/moderation/visibility.ts';
import {
  USER_A,
  captureError,
  countingPort,
  makeHarness,
  seedAuthority,
  textContent,
} from './_http-fixtures.mjs';

const TARGET_V1 = { type: 'post', id: 'post-9101', revision: 1 };

/** 包一层替身权威，记录"到底写了什么"（断言写次数/写前状态用）。 */
function observingAuthority(inner, options = {}) {
  const writes = [];
  return {
    origin: inner.origin,
    writes,
    read: (target) => inner.read(target),
    publishedRevision: (target) => inner.publishedRevision(target),
    setVisibility: async (target, visibility) => {
      writes.push({ op: 'setVisibility', target: { ...target }, visibility });
      if (options.beforeVisibilityWrite !== undefined) options.beforeVisibilityWrite({ target, visibility, inner });
      return inner.setVisibility(target, visibility);
    },
    setPublishedRevision: async (target, revision) => {
      writes.push({ op: 'setPublishedRevision', target: { ...target }, revision });
      if (options.failPublishedRevision === true) {
        throw new ApiError('REVISION_CONFLICT', '写后核对失败（测试注入：模拟外部权威拒绝）');
      }
      return inner.setPublishedRevision(target, revision);
    },
    // 透传替身权威的调试面（测试用它造状态、读快照）。
    seed: (target, snapshot) => inner.seed(target, snapshot),
    get: (target) => inner.get(target),
    setAuthorState: (target, state) => inner.setAuthorState(target, state),
    setCurrentRevision: (target, revision) => inner.setCurrentRevision(target, revision),
  };
}

test('RG-1. 权威版本已推进 ⇒ publish **在任何写之前**以 REVISION_CONFLICT 拒绝，行状态零副作用', async () => {
  const tms = countingPort('tms');
  const authority = observingAuthority(createSubstituteContentAuthority());
  const h = makeHarness({ authority, ports: { tms: tms.port } });
  const content = textContent({ target_ref: TARGET_V1 });
  // 权威侧当前是 revision=2 那一版；请求仍指向 revision=1（旧链接/旧结论）。
  seedAuthority(authority, TARGET_V1, { visibility: 'private', owner_id: USER_A.userId, current_revision: 2 });

  const screening = await h.service.submitScreening({ actor: USER_A, content });
  assert.equal(screening.overall.publishable, true, '前提：revision=1 这一版确有"通过"结论');

  const refused = await captureError(() => h.service.publish({ actor: USER_A, content }));
  assert.equal(refused.code, 'REVISION_CONFLICT', '旧版本发布必须按版本冲突拒绝');
  assert.ok(
    refused.details.some((detail) => detail.code.startsWith('REVISION_SUPERSEDED')),
    JSON.stringify(refused.details),
  );
  // 零副作用（缺陷形态：此前先写 published，再在写后核对抛错）。
  assert.deepEqual(authority.writes, [], '拒绝路径不得产生任何权威写入');
  assert.equal(authority.get(TARGET_V1).visibility, 'private', '可见性必须保持写前值');
  assert.equal(await authority.publishedRevision(TARGET_V1), null, '不得声明"已发布版本"');
});

test('RG-2. 版本一致 ⇒ 发布成功，且权威写入恰好是"可见性 + 已发布版本"各一次', async () => {
  const tms = countingPort('tms');
  const authority = observingAuthority(createSubstituteContentAuthority());
  const h = makeHarness({ authority, ports: { tms: tms.port } });
  const content = textContent({ target_ref: TARGET_V1 });
  seedAuthority(authority, TARGET_V1, { visibility: 'private', owner_id: USER_A.userId });

  await h.service.submitScreening({ actor: USER_A, content });
  const published = await h.service.publish({ actor: USER_A, content });
  assert.equal(published.published, true);
  assert.equal(published.published_revision, 1);
  assert.deepEqual(
    authority.writes,
    [
      { op: 'setVisibility', target: TARGET_V1, visibility: 'published' },
      { op: 'setPublishedRevision', target: TARGET_V1, revision: 1 },
    ],
    '正常路径只写两次，且都针对本次要核对的那一版',
  );
  assert.equal(authority.get(TARGET_V1).visibility, 'published');
  assert.equal(await authority.publishedRevision(TARGET_V1), 1);
});

test('RG-3. 内容权威本身也拒绝旧 revision 的可见性写入（setVisibility / setPublishedRevision 双口）', async () => {
  const tms = countingPort('tms');
  const h = makeHarness({ ports: { tms: tms.port } });
  seedAuthority(h.authority, TARGET_V1, { visibility: 'published', owner_id: USER_A.userId, current_revision: 2 });

  const visibilityRefused = await captureError(() => h.authority.setVisibility(TARGET_V1, 'hidden'));
  assert.equal(visibilityRefused.code, 'REVISION_CONFLICT', '旧版本不得被改可见性（含下架）');
  assert.equal(h.authority.get(TARGET_V1).visibility, 'published', '拒绝路径不得改写行');
  assert.equal(h.authority.get(TARGET_V1).current_revision, 2);

  const declarationRefused = await captureError(() => h.authority.setPublishedRevision(TARGET_V1, 1));
  assert.equal(declarationRefused.code, 'REVISION_CONFLICT', '旧版本不得声明"已发布版本"');
  assert.equal(await h.authority.publishedRevision(TARGET_V1), null);

  // 正向对照：版本一致时才允许写（否则上面的拒绝可能只是"一律拒绝"）。
  const current = { type: 'post', id: 'post-9102', revision: 3 };
  seedAuthority(h.authority, current, { visibility: 'private', owner_id: USER_A.userId, current_revision: 3 });
  await h.authority.setVisibility(current, 'published');
  await h.authority.setPublishedRevision(current, 3);
  assert.equal(h.authority.get(current).visibility, 'published');
  assert.equal(await h.authority.publishedRevision(current), 3);
});

test('RG-4. 写后核对抛错 ⇒ 补偿回写写前可见性（不留半发布中间态，且原始错误照常抛出）', async () => {
  const tms = countingPort('tms');
  const inner = createSubstituteContentAuthority();
  const authority = observingAuthority(inner, { failPublishedRevision: true });
  const h = makeHarness({ authority, ports: { tms: tms.port } });
  const content = textContent({ target_ref: TARGET_V1 });
  seedAuthority(authority, TARGET_V1, { visibility: 'private', owner_id: USER_A.userId });

  await h.service.submitScreening({ actor: USER_A, content });
  const refused = await captureError(() => h.service.publish({ actor: USER_A, content }));
  assert.equal(refused.code, 'REVISION_CONFLICT', '原始错误必须照常抛出（补偿不得吞错）');
  assert.deepEqual(
    authority.writes.map((write) => write.op),
    ['setVisibility', 'setPublishedRevision', 'setVisibility'],
    '写后核对失败 ⇒ 追加一次补偿回写',
  );
  assert.equal(authority.writes[2].visibility, 'private', '补偿回写到写前可见性');
  assert.equal(inner.get(TARGET_V1).visibility, 'private', '行不得停在 published（半发布）');
  assert.equal(await inner.publishedRevision(TARGET_V1), null);
});
