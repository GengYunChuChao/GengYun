// 读取时重查对象权限与当前可见性 —— 含**针对性负例**：缓存或旧链接不得让已隐藏/失效/注销对象重新公开。
//
// 服务层测试（内存 store + 可控替身端口；不是端到端证据，见 fixtures 的声明）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FAVORITE_KEYS,
  HISTORY_KEYS,
  REFERENCE_UNAVAILABLE_REASONS,
  USER_A,
  USER_B,
  appendHistory,
  assertApiErrorShape,
  captureError,
  makeControllableJobPort,
  makeControllableVisibility,
  makeFavoritesHarness,
  makeHistoryHarness,
  makeJunkVisibility,
  makeThrowingVisibility,
  createUnwiredVisibilityPort,
} from './favorites-history-fixtures.mjs';
import {
  FAVORITE_PROJECTION_FIELDS,
  favoriteEligibleForRecommendation,
} from '../../services/api/src/favorites/service.ts';
import { HISTORY_PROJECTION_FIELDS } from '../../services/api/src/history/service.ts';
import { isFailureJobState } from '../../services/api/src/history/types.ts';

const REASONS = new Set(REFERENCE_UNAVAILABLE_REASONS);
const UNWIRED_REASON = REFERENCE_UNAVAILABLE_REASONS[1];
const READ_FAILED_REASON = REFERENCE_UNAVAILABLE_REASONS[2];
const OBJECT_REASON = REFERENCE_UNAVAILABLE_REASONS[0];

const SPECIES = { type: 'species', id: 'spc-1', revision: 1 };
const HERBICIDE = { type: 'herbicide', id: 'hb-1', revision: 3 };

function assertUnavailable(item) {
  assert.equal(item.reference_state, 'unavailable');
  // 说明必须是冻结闭集内的一条 —— 端口/存储里混进自由文本也不得进入响应。
  assert.ok(REASONS.has(item.unavailable_reason), `说明必须落在冻结闭集内：${item.unavailable_reason}`);
}

/** 历史契约 `History` **没有** `unavailable_reason`（只有 `reference_state`）。 */
function assertHistoryUnavailable(item) {
  assert.equal(item.reference_state, 'unavailable');
  assert.equal(Object.hasOwn(item, 'unavailable_reason'), false, '历史投影不得多出契约外字段');
}

test('投影字段集恰等契约：收藏 6 项 / 历史 7 项，且历史不含候选或人工选择字段', () => {
  assert.deepEqual([...FAVORITE_PROJECTION_FIELDS].sort(), [...FAVORITE_KEYS].sort());
  assert.deepEqual([...HISTORY_PROJECTION_FIELDS].sort(), [...HISTORY_KEYS].sort());
  // 「候选与人工选择分开」「OCR 核对」「来源版本」属**详情**页（`getRecognition`/`getOCR`），
  // 历史响应里不得复制这些字段（契约 History 没有它们）。
  for (const forbidden of ['candidates', 'selected_species_id', 'model_version', 'raw_fields', 'corrected_fields', 'verification', 'used', 'usage']) {
    assert.equal([...HISTORY_PROJECTION_FIELDS].includes(forbidden), false, `历史投影不应含 ${forbidden}`);
  }
  for (const forbidden of ['used', 'usage', 'used_at', 'quantity', 'dose_card']) {
    assert.equal([...FAVORITE_PROJECTION_FIELDS].includes(forbidden), false, `收藏投影不应含 ${forbidden}`);
  }
});

test('可见性 fail-closed：未接线 / 抛错 / 非闭集取值 一律 unavailable，且不外泄原始错误文本', async () => {
  // 未接线端口：收藏与历史都恒 unavailable。
  const unwiredFavorites = makeFavoritesHarness({ visibility: createUnwiredVisibilityPort() });
  const created = await unwiredFavorites.service.createFavorite(USER_A, { target_ref: SPECIES }, { idempotencyKey: 'idem-0001' });
  assert.equal(created.reference_state, 'unavailable');
  assert.equal(created.unavailable_reason, UNWIRED_REASON);

  const unwiredHistory = makeHistoryHarness({ visibility: createUnwiredVisibilityPort() });
  await appendHistory(unwiredHistory.service);
  const unwiredPage = await unwiredHistory.service.listHistory(USER_A);
  assert.equal(unwiredPage.items[0].reference_state, 'unavailable');

  // 端口抛错：折叠为"读取失败"这一条闭集说明，原始异常文本绝不外泄。
  const throwing = makeFavoritesHarness({ visibility: makeThrowingVisibility() });
  const fromThrow = await throwing.service.createFavorite(USER_A, { target_ref: SPECIES }, { idempotencyKey: 'idem-0002' });
  assert.equal(fromThrow.reference_state, 'unavailable');
  assert.equal(fromThrow.unavailable_reason, READ_FAILED_REASON);
  assert.equal(fromThrow.unavailable_reason.includes('合成故障'), false, '原始错误文本不得进入响应');

  // 端口返回非闭集取值（`true` / 任意字符串 / 空对象）：都不算可用。
  for (const junk of [true, 'yes', {}, { state: 'maybe' }, null]) {
    const harness = makeFavoritesHarness({ visibility: makeJunkVisibility(junk) });
    const item = await harness.service.createFavorite(USER_A, { target_ref: SPECIES }, { idempotencyKey: 'idem-0003' });
    assertUnavailable(item);
  }
});

test('读取时重查（无缓存）：可用↔不可见 逐次重新派生，调用次数随读取增长', async () => {
  const visibility = makeControllableVisibility(['species:spc-1']);
  const harness = makeFavoritesHarness({ visibility: visibility.port });
  const item = await harness.service.createFavorite(USER_A, { target_ref: SPECIES }, { idempotencyKey: 'idem-0010' });
  assert.equal(item.reference_state, 'available');
  assert.equal(item.unavailable_reason, null);
  const callsAfterCreate = visibility.calls.length;

  const before = await harness.service.listFavorites(USER_A);
  assert.equal(before.items[0].reference_state, 'available');
  const hiddenBefore = { ...before.items[0] };

  // 目标隐藏（模拟下架/失效/删除/注销后不可读）：**下一次读取**必须立刻反映，不得复用旧结论。
  visibility.hide('species', 'spc-1');
  const afterHide = await harness.service.listFavorites(USER_A);
  assertUnavailable(afterHide.items[0]);
  assert.equal(afterHide.items[0].id, hiddenBefore.id, '同一行（同一 id/版本）在失效后不得沿用旧的可用结论');
  assert.equal(afterHide.items[0].revision, hiddenBefore.revision);

  // 多次读取会多次询问端口（不缓存）。
  await harness.service.listFavorites(USER_A);
  assert.ok(visibility.calls.length >= callsAfterCreate + 3, '每次读取都应重新派生可见性');

  // 目标重新可见：读取时如实恢复（这是真实变化，不是缓存复活）。
  visibility.show('species', 'spc-1');
  const back = await harness.service.listFavorites(USER_A);
  assert.equal(back.items[0].reference_state, 'available');
});

test('负例：隐藏/失效后不得因缓存或旧链接重新公开，旧收藏也不恢复推荐资格', async () => {
  const visibility = makeControllableVisibility(['species:spc-1', 'herbicide:hb-1']);
  const harness = makeFavoritesHarness({ visibility: visibility.port });
  const oldFavorite = await harness.service.createFavorite(USER_A, { target_ref: SPECIES }, { idempotencyKey: 'idem-0020' });
  const herbFavorite = await harness.service.createFavorite(USER_A, { target_ref: HERBICIDE }, { idempotencyKey: 'idem-0021' });
  assert.equal(favoriteEligibleForRecommendation(oldFavorite), true);
  assert.equal(favoriteEligibleForRecommendation(herbFavorite), true);

  // 很久之后（"旧收藏"）目标失效：资格**不因收藏时间久远而保留**。
  harness.clock.advance(90 * 24 * 3600 * 1000);
  visibility.hide('species', 'spc-1');
  const page = await harness.service.listFavorites(USER_A);
  const stale = page.items.find((item) => item.id === oldFavorite.id);
  assertUnavailable(stale);
  assert.equal(favoriteEligibleForRecommendation(stale), false, '旧收藏不得恢复失效目标的推荐资格');

  // 旧链接（直接用 id 反复读同一行）也不得复活：读取走的是同一条服务路径。
  const again = await harness.service.listFavorites(USER_A);
  assert.equal(favoriteEligibleForRecommendation(again.items.find((item) => item.id === oldFavorite.id)), false);
  // 仍然可用的那条不受影响（不因为"另有一条失效收藏"而连带失效）。
  assert.equal(favoriteEligibleForRecommendation(again.items.find((item) => item.id === herbFavorite.id)), true);

  // 目标侧不可用说明对所有收藏都是**同一条**非披露文本：不区分"已隐藏"与"不存在"。
  assert.equal(
    again.items.find((item) => item.id === oldFavorite.id).unavailable_reason,
    OBJECT_REASON,
  );
});

test('负例：注销（账号不可读）后所有目标统一不可用，且不复活、不泄露存在性', async () => {
  const visibility = makeControllableVisibility(['species:spc-1', 'herbicide:hb-1', 'scheme:sc-1']);
  const harness = makeFavoritesHarness({ visibility: visibility.port });
  for (const [index, ref] of [SPECIES, HERBICIDE, { type: 'scheme', id: 'sc-1', revision: 1 }].entries()) {
    await harness.service.createFavorite(USER_A, { target_ref: ref }, { idempotencyKey: `idem-003${index}` });
  }
  assert.equal((await harness.service.listFavorites(USER_A)).items.every((item) => item.reference_state === 'available'), true);

  // 注销/账号停用后：目标对当前主体一律不可读（端口是唯一判据）。
  for (const ref of [SPECIES, HERBICIDE, { type: 'scheme', id: 'sc-1', revision: 1 }]) {
    visibility.hide(ref.type, ref.id);
  }
  const afterDeletion = await harness.service.listFavorites(USER_A);
  assert.equal(afterDeletion.items.length, 3, '行仍在（不因注销隐藏用户数据），但都不得再公开目标');
  for (const item of afterDeletion.items) assertUnavailable(item);
  // 说明同形：不因目标类型或存在性给出可区分信号。
  assert.deepEqual(
    new Set(afterDeletion.items.map((item) => item.unavailable_reason)),
    new Set([OBJECT_REASON]),
  );
});

test('历史：失败/超时/取消/不确定 原样可见，且不会被折叠成成功或被隐藏', async () => {
  const job = makeControllableJobPort();
  const visibility = makeControllableVisibility();
  const harness = makeHistoryHarness({ visibility: visibility.port, job: job.port });
  const states = ['failed', 'timed_out', 'cancelled', 'uncertain', 'queued', 'succeeded'];
  for (const [index, state] of states.entries()) {
    await appendHistory(harness.service, {
      target_ref: { type: 'recognition', id: `rec-${index}`, revision: 1 },
      job_id: `job-${index}`,
      job_state: state,
      event_key: `evt-${index}`,
    });
    job.set(`job-${index}`, state);
  }
  const page = await harness.service.listHistory(USER_A);
  assert.equal(page.items.length, states.length, '历史不得隐藏任何终态（含失败）');
  const byJob = new Map(page.items.map((item) => [item.target_ref.id, item]));
  for (const [index, state] of states.entries()) {
    assert.equal(byJob.get(`rec-${index}`).job_state, state);
  }
  assert.equal(isFailureJobState(byJob.get('rec-0').job_state), true);
  assert.equal(isFailureJobState(byJob.get('rec-5').job_state), false);
  // 目标不可见时，历史行仍然存在（失败记录真实可见），只是 reference_state 如实为不可用。
  assert.equal(page.items.every((item) => item.reference_state === 'unavailable'), true);
});

test('历史：job_state 读取时实时重查；核不到时退回入库值，绝不凭空升级为成功', async () => {
  const job = makeControllableJobPort();
  const harness = makeHistoryHarness({ job: job.port });

  // 入库 queued，实时为 failed ⇒ 必须显示 failed（"失败状态真实可见"）。
  await appendHistory(harness.service, { job_id: 'job-a', job_state: 'queued', event_key: 'evt-a' });
  job.set('job-a', 'failed');
  let page = await harness.service.listHistory(USER_A);
  assert.equal(page.items[0].job_state, 'failed');

  // 实时核不到（他人任务/任务不存在/读取失败）⇒ 退回入库值（queued），**不得**变成 succeeded。
  job.forget('job-a');
  page = await harness.service.listHistory(USER_A);
  assert.equal(page.items[0].job_state, 'queued');
  assert.notEqual(page.items[0].job_state, 'succeeded');

  // 入库即 failed、端口核不到 ⇒ 仍是 failed（不升级）。
  await appendHistory(harness.service, {
    target_ref: { type: 'ocr', id: 'ocr-1', revision: 1 },
    kind: 'ocr',
    job_id: 'job-b',
    job_state: 'failed',
    event_key: 'evt-b',
  });
  page = await harness.service.listHistory(USER_A);
  assert.equal(page.items.find((item) => item.kind === 'ocr').job_state, 'failed');

  // 端口抛错 ⇒ 同样退回入库值（不外泄原始错误、不升级）。
  const throwing = makeHistoryHarness({ job: makeControllableJobPort({}, { throwFor: 'job-c' }).port });
  await appendHistory(throwing.service, { job_id: 'job-c', job_state: 'timed_out', event_key: 'evt-c' });
  assert.equal((await throwing.service.listHistory(USER_A)).items[0].job_state, 'timed_out');
});

test('历史：目标失效后行仍在但不可用；归属隔离；越权与不存在同形', async () => {
  const visibility = makeControllableVisibility(['recognition:rec-1']);
  const harness = makeHistoryHarness({ visibility: visibility.port });
  const appended = await appendHistory(harness.service, {
    target_ref: { type: 'recognition', id: 'rec-1', revision: 1 },
    job_id: 'job-vis-1',
  });
  assert.equal(appended.created, true);
  const page = await harness.service.listHistory(USER_A);
  assert.equal(page.items[0].reference_state, 'available');

  visibility.hide('recognition', 'rec-1');
  const afterHide = await harness.service.listHistory(USER_A);
  assert.equal(afterHide.items.length, 1, '失效后历史行仍可见（不隐藏失败/失效记录）');
  assertHistoryUnavailable(afterHide.items[0]);
  assert.equal(FAVORITE_KEYS.length, 6);

  // 归属：B 看不到 A 的历史；B 删 A 的历史与删"不存在"同形（404 NOT_FOUND）。
  assert.deepEqual(await harness.service.listHistory(USER_B), { items: [], next_cursor: null });
  const foreign = await captureError(() =>
    harness.service.deleteHistory(USER_B, appended.history.id, { idempotencyKey: 'idem-0051', ifMatch: '"1"' }),
  );
  const absent = await captureError(() =>
    harness.service.deleteHistory(USER_B, '00000000-0000-4000-8f00-0000000000ff', { idempotencyKey: 'idem-0052', ifMatch: '"1"' }),
  );
  assertApiErrorShape(foreign, 'NOT_FOUND', 404);
  assertApiErrorShape(absent, 'NOT_FOUND', 404);
  assert.equal(foreign.message, absent.message);
  assert.deepEqual(foreign.details, absent.details);
  // 非本人**不得**拿到 409（版本故意写错也不泄露存在性）。
  const foreignStale = await captureError(() =>
    harness.service.deleteHistory(USER_B, appended.history.id, { idempotencyKey: 'idem-0053', ifMatch: '"9"' }),
  );
  assertApiErrorShape(foreignStale, 'NOT_FOUND', 404);

  // 后台会话在服务层被显式拒绝（第二道边界）。
  const admin = await captureError(() => harness.service.listHistory({ userId: USER_A.userId, role: 'admin', authEpoch: 1 }));
  assertApiErrorShape(admin, 'SCOPE_DENIED', 403);
});
