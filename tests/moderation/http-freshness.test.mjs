/**
 * GY-I14（#14）审核 HTTP 装配片 · **结论新鲜度：源版本前进 ⇒ 待重评，读面不得当"已审"返回**
 * （诊断 `.pg17/analysis/i14-moderation-gaps-20261019.md` 的 4-3 / 派单 P2-2）。
 *
 * 口径（为什么这样表达）：
 *   - 契约状态**不新增**：过期沿用引擎既有原因码（`MODEL_VERSION_CHANGED` /
 *     `RULE_VERSION_CHANGED` / `*_UNKNOWN`），对外表现为 `visible:false`；面向用户的
 *     "待重评"由社区读面既有的 `audit_state: 'pending'` 表达（见 `community-moderation-freshness`）；
 *   - 新鲜度是**读时派生**，不落库：同一个台账/权威/缓存上换一个声明了新模型版本的服务实例，
 *     旧结论就必须立刻不再等于"已审"——台账里的历史结论本身不被改写。
 *
 * 声明：全部输入是合成夹具；模型端口是合成替身（不发网络请求、无凭据、非真实供应商证据）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { USER_A, countingPort, makeHarness, seedAuthority, textContent } from './_http-fixtures.mjs';

const TARGET_V1 = { type: 'post', id: 'post-1001', revision: 1 };

test('模型版本前进 ⇒ 已发布内容的旧结论过期：任务视图 stale + 读面不可见（RESCREEN_REQUIRED）+ 缓存清空', async () => {
  const h = makeHarness({ ports: { tms: countingPort('tms').port } });
  const content = textContent();
  seedAuthority(h.authority, TARGET_V1, { visibility: 'private', owner_id: USER_A.userId });
  await h.service.submitScreening({ actor: USER_A, content });
  await h.service.publish({ actor: USER_A, content });
  const before = await h.service.readView({ actor: USER_A, target_ref: TARGET_V1 });
  assert.equal(before.visible, true, '前提：发布后读面可见');
  assert.ok(!before.reason_codes.includes('RESCREEN_REQUIRED'), '前提：版本未前进时不得报过期');

  // 版本前进：**同一个台账/权威/缓存**，端口声明的模型版本从 @1.0 前进到 @2.0。
  const upgraded = makeHarness({
    ledger: h.ledger,
    cache: h.cache,
    authority: h.authority,
    ports: { tms: countingPort('tms', { model_version: 'synthetic-tms-model@2.0' }).port },
  });

  // 任务视图：过期是**读时派生**的（台账里的历史结论不动），理由必须可判别。
  const tasks = await upgraded.service.tasks(TARGET_V1);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].decision, 'approved', '台账里的历史结论不被改写（过期只是派生视图）');
  assert.equal(tasks[0].stale, true, '源版本前进后旧结论必须被判过期');
  assert.deepEqual(tasks[0].stale_reason_codes, ['MODEL_VERSION_CHANGED'],
    '过期理由必须是"模型版本变了"，而不是别的噪声');

  // 读面：不再按"已审"返回（缓存只知道可见性，不知道结论新鲜度 ⇒ 一并清掉）。
  assert.equal(upgraded.cache.size(), 1, '前提：过期判断前缓存里确有该条目');
  const view = await upgraded.service.readView({ actor: USER_A, target_ref: TARGET_V1 });
  assert.equal(view.visible, false, '版本前进后不得再把旧结论当"已审"返回');
  assert.equal(view.reason_codes[0], 'RESCREEN_REQUIRED', '过期必须显式给出"待重评"原因');
  assert.ok(view.reason_codes.includes('MODEL_VERSION_CHANGED'), '原因里必须能看到是哪一维版本变了');
  assert.equal(upgraded.cache.size(), 0, '过期内容的缓存条目必须清掉（否则脏条目会继续被读）');

  // 负控制：同台账/权威，用**同版本**端口再建一个实例 ⇒ 仍然可见、不过期。
  // （证明上面变红来自"版本前进"，不是"换了个服务实例"。）
  const same = makeHarness({
    ledger: h.ledger,
    cache: h.cache,
    authority: h.authority,
    ports: { tms: countingPort('tms').port },
  });
  const sameTasks = await same.service.tasks(TARGET_V1);
  assert.equal(sameTasks[0].stale, false, '同版本不得被判过期');
  assert.deepEqual(sameTasks[0].stale_reason_codes, []);
  const sameView = await same.service.readView({ actor: USER_A, target_ref: TARGET_V1 });
  assert.equal(sameView.visible, true, '同版本下不得误伤可见性');
  assert.ok(!sameView.reason_codes.includes('RESCREEN_REQUIRED'));
});
