/**
 * GY-I19（#19）第 2 步 · 接收方删除 **请求／完成／失败三态投影** 单测。
 *
 * 本文件同时是**回归用例**：状态机用 `packages/privacy/deletion.mjs` + `deletion-modules.mjs`
 * 的**既有实现**跑（不另起一套），投影层只读消费 `thirdPartyStatuses()`；
 * 并显式记录两处**真实空白**（未到期也能自称 completed / 契约 `third_party_state` 从不被填）。
 *
 * 覆盖：请求→完成、请求→失败（带原因码）、**未到期不得 completed**、重复/幂等调用、
 * 越权与未知主体 fail-closed、无接收方不得完成、契约 `ThirdPartyState` 闭集对齐。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeletionRegistry } from '../../packages/privacy/deletion.mjs';
import { createDeletionCoordinator } from '../../packages/privacy/deletion-modules.mjs';
import { THIRD_PARTY_STATES } from '../../packages/privacy/constants.mjs';
import {
  THIRD_PARTY_PROJECTION_REASON_CODES as REASON,
  THIRD_PARTY_PROJECTION_STATES,
  projectThirdPartyDeletion,
  thirdPartyReceiptState,
} from '../../services/api/src/privacy/third-party-deletion-projection.ts';

const T = '2026-10-01T00:00:00.000Z';
const T_MS = Date.parse(T);
const HOUR1 = new Date(T_MS + 3600 * 1000).toISOString();
const DAY7 = '2026-10-08T00:00:00.000Z';
const DAY30 = '2026-10-31T00:00:00.000Z';

/** 用**既有已合并协议**搭一套真实现：注册一个模块 + 一个删除请求。 */
function setup({ requestedAt = T, module = 'media' } = {}) {
  const registry = createDeletionRegistry({ now: () => new Date(requestedAt) });
  const coordinator = createDeletionCoordinator({
    registry,
    requiredModules: [module],
    now: () => new Date(requestedAt),
  });
  coordinator.registerModule(module, async () => ({
    onlineState: 'completed',
    backupState: 'completed',
    evidenceRef: `${module}:online-purged:1`,
  }));
  const request = coordinator.createDeletionRequest({ generation: 1 });
  return { registry, coordinator, request, requestId: String(request.id) };
}

/** 手工来源：用于构造既有协议不会产生的"不可信行形状"（fail-closed 用例）。 */
function manualSource(rows, request = { id: 'req-manual' }) {
  return {
    thirdPartyStatuses: () => rows,
    getRequest: () => request,
  };
}

/** 全量不变量：三态闭集、completed 的口径、原因码必非空、契约闭集对齐。 */
function assertProjectionInvariants(projection, label = '') {
  const where = label.length > 0 ? `${label}：` : '';
  assert.ok(THIRD_PARTY_PROJECTION_STATES.includes(projection.state), `${where}state 必属三态闭集`);
  assert.equal(typeof projection.completed, 'boolean');
  assert.ok(Object.isFrozen(projection), `${where}投影应为冻结对象`);
  assert.ok(Array.isArray(projection.reasons), `${where}reasons 应为数组`);

  if (projection.completed) {
    assert.equal(projection.reason_code, null, `${where}完成时不得有原因码`);
    assert.ok(projection.recipients.length > 0, `${where}完成必须有接收方（空集合不得完成）`);
    assert.equal(projection.receipt_third_party_state, 'confirmed', where);
    assert.deepEqual([...projection.reasons], [], where);
  } else {
    assert.equal(typeof projection.reason_code, 'string', `${where}未完成必须带可判别原因码`);
    assert.ok(projection.reason_code.length > 0, where);
    assert.ok([...projection.reasons].includes(projection.reason_code), `${where}reason_code 应出现在 reasons 里`);
  }

  // 契约闭集：receipt_third_party_state ∈ ThirdPartyState | null。
  if (projection.receipt_third_party_state !== null) {
    assert.ok(
      THIRD_PARTY_STATES.includes(projection.receipt_third_party_state),
      `${where}receipt_third_party_state 必须落在契约 ThirdPartyState 闭集内：${projection.receipt_third_party_state}`,
    );
  }

  for (const recipient of projection.recipients) {
    for (const phase of [recipient.online, recipient.backup]) {
      assert.ok(THIRD_PARTY_PROJECTION_STATES.includes(phase.state), `${where}阶段三态必属闭集`);
      // 铁律：未到期不得 completed。
      if (!phase.due) assert.equal(phase.completed, false, `${where}${phase.phase} 未到期不得 completed`);
      if (phase.completed) assert.equal(phase.reason_code, null, where);
      else {
        assert.equal(typeof phase.reason_code, 'string', `${where}${phase.phase} 未完成必须带原因码`);
        assert.ok(phase.reason_code.length > 0, where);
      }
      assert.ok(THIRD_PARTY_STATES.includes(phase.protocol_state) || phase.reason_code === REASON.INPUT_INVALID, where);
    }
    // 未完成绝不对外表现为 confirmed。
    assert.equal(recipient.receipt_third_party_state === 'confirmed', recipient.completed, where);
    if (!recipient.completed) assert.ok(recipient.reason_code && recipient.reason_code.length > 0, where);
  }
}

test('请求态：接收方删除请求已发出 ⇒ 三态为 requested，绝不等于完成（并记录契约空白）', () => {
  const { coordinator, requestId } = setup();
  coordinator.requestThirdPartyDeletion({ requestId, recipientId: 'vendor-a', exportRef: 'exp-1' });

  const statuses = coordinator.thirdPartyStatuses(requestId);
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].online_status, 'requested');
  assert.equal(statuses[0].backup_status, 'requested');
  assert.equal(statuses[0].completed, false, '既有协议：requested 不等于 confirmed');

  const projection = projectThirdPartyDeletion({ source: coordinator, requestId, requestedAt: T, now: HOUR1 });
  assertProjectionInvariants(projection, '请求态');
  assert.equal(projection.state, 'requested');
  assert.equal(projection.completed, false);
  assert.equal(projection.reason_code, REASON.REQUESTED);
  assert.equal(projection.receipt_third_party_state, 'requested');
  assert.deepEqual(projection.summary, { total: 1, requested: 1, completed: 0, failed: 0 });
  assert.equal(projection.recipients[0].online.protocol_state, 'requested');
  assert.equal(projection.recipients[0].export_ref, 'exp-1');
  assert.equal(projection.recipients[0].requested_at, T);

  // 真实空白证据：契约 `DeletionHandler.third_party_state` 在已合并回执里**恒为 null**
  // （deletion.mjs::receiptProjection 硬编码 null）—— 本片补的正是这个洞，不改既有文件。
  const receipt = coordinator.receipt(requestId);
  assert.equal(receipt.handlers[0].third_party_state, null, '既有回执从不填 third_party_state');
  assert.equal(thirdPartyReceiptState({ source: coordinator, requestId, requestedAt: T, now: HOUR1 }), 'requested');
});

test('请求→完成：到达 7/30 日窗口且证据齐全才 completed；未到期一律不得 completed', () => {
  const { coordinator, requestId } = setup();
  coordinator.requestThirdPartyDeletion({ requestId, recipientId: 'vendor-a', exportRef: 'exp-1' });
  coordinator.confirmThirdPartyDeletion({ requestId, recipientId: 'vendor-a', exportRef: 'exp-1', evidenceRef: 'vendor-receipt-1' });

  // 既有访问器：只看 confirmed ⇒ 立刻自称 completed（**不看到期**，这正是本片补的空白）。
  assert.equal(coordinator.thirdPartyStatuses(requestId)[0].completed, true, '既有实现不看到期窗口');

  // 同一时刻用投影判定：未到期 ⇒ 不得 completed（协议原值如实保留为 confirmed）。
  const early = projectThirdPartyDeletion({ source: coordinator, requestId, requestedAt: T, now: HOUR1 });
  assertProjectionInvariants(early, '未到期');
  assert.equal(early.completed, false, '未到期不得 completed');
  assert.equal(early.state, 'requested');
  assert.equal(early.reason_code, REASON.NOT_DUE);
  assert.equal(early.receipt_third_party_state, 'requested');
  assert.equal(early.recipients[0].online.protocol_state, 'confirmed');
  assert.equal(early.recipients[0].online.completed, false);
  assert.equal(early.recipients[0].online.due, false);
  assert.equal(early.recipients[0].confirmed_at, T);

  // 第 7 日当天：在线到期并完成，备份仍未到期 ⇒ 整单仍不得完成。
  const atDay7 = projectThirdPartyDeletion({ source: coordinator, requestId, requestedAt: T, now: DAY7 });
  assertProjectionInvariants(atDay7, '第7日');
  assert.equal(atDay7.recipients[0].online.completed, true);
  assert.equal(atDay7.recipients[0].online.due_at, DAY7);
  assert.equal(atDay7.recipients[0].backup.completed, false);
  assert.equal(atDay7.completed, false);
  assert.ok(atDay7.reasons.includes(REASON.NOT_DUE));

  // 第 30 日当天：两阶段都到期且有证据 ⇒ 才算完成。
  const atDay30 = projectThirdPartyDeletion({ source: coordinator, requestId, requestedAt: T, now: DAY30 });
  assertProjectionInvariants(atDay30, '第30日');
  assert.equal(atDay30.completed, true);
  assert.equal(atDay30.state, 'completed');
  assert.equal(atDay30.reason_code, null);
  assert.deepEqual(atDay30.summary, { total: 1, requested: 0, completed: 1, failed: 0 });
  assert.equal(atDay30.receipt_third_party_state, 'confirmed');
  assert.equal(atDay30.recipients[0].online.due_at, DAY7);
  assert.equal(atDay30.recipients[0].backup.due_at, DAY30);

  // 到期但缺证据同样不得完成（空白证据不算证据）。
  const noEvidence = projectThirdPartyDeletion({
    source: manualSource([
      { recipient_id: 'vendor-x', online_status: 'confirmed', backup_status: 'confirmed', evidence_ref: '   ' },
    ]),
    requestId,
    requestedAt: T,
    now: DAY30,
  });
  assertProjectionInvariants(noEvidence, '缺证据');
  assert.equal(noEvidence.completed, false);
  assert.equal(noEvidence.reason_code, REASON.NO_EVIDENCE);
});

test('请求→失败：三态为 failed 且必带可判别原因码；非白名单原文不透出', () => {
  const { coordinator, requestId } = setup();
  coordinator.requestThirdPartyDeletion({ requestId, recipientId: 'vendor-b', exportRef: null });
  coordinator.failThirdPartyDeletion({ requestId, recipientId: 'vendor-b', exportRef: null, errorCode: 'THIRD_PARTY_FAILED' });

  const failed = projectThirdPartyDeletion({ source: coordinator, requestId, requestedAt: T, now: DAY30 });
  assertProjectionInvariants(failed, '失败');
  assert.equal(failed.state, 'failed');
  assert.equal(failed.completed, false);
  assert.equal(failed.reason_code, 'THIRD_PARTY_FAILED');
  assert.equal(failed.recipients[0].online.state, 'failed');
  assert.equal(failed.recipients[0].online.protocol_state, 'failed');
  assert.equal(failed.recipients[0].online.recorded_error_code, 'THIRD_PARTY_FAILED');
  assert.equal(failed.receipt_third_party_state, 'failed', '失败绝不对外表现为 confirmed');
  assert.deepEqual(failed.summary, { total: 1, requested: 0, completed: 0, failed: 1 });

  // 既有协议会把非白名单错误码折叠为固定分类 ⇒ 投影原样透出该固定分类。
  const { coordinator: c2, requestId: r2 } = setup();
  c2.requestThirdPartyDeletion({ requestId: r2, recipientId: 'vendor-c', exportRef: null });
  c2.failThirdPartyDeletion({ requestId: r2, recipientId: 'vendor-c', exportRef: null, errorCode: 'RAW_VENDOR_SDK_TEXT_should_not_leak' });
  const foldedByProtocol = projectThirdPartyDeletion({ source: c2, requestId: r2, requestedAt: T, now: HOUR1 });
  assert.equal(foldedByProtocol.reason_code, 'THIRD_PARTY_FAILED');
  assert.equal(JSON.stringify(foldedByProtocol).includes('RAW_VENDOR'), false, '原文不得透出');

  // 投影层同样折叠：手工构造"既有协议不会产出"的自由文本错误码。
  const foldedByProjection = projectThirdPartyDeletion({
    source: manualSource([
      { recipient_id: 'vendor-z', online_status: 'failed', backup_status: 'failed', evidence_ref: null, error_code: 'RAW_VENDOR_SDK_TEXT_should_not_leak' },
    ]),
    requestId: 'req-manual',
    requestedAt: T,
    now: HOUR1,
  });
  assertProjectionInvariants(foldedByProjection, '折叠');
  assert.equal(foldedByProjection.reason_code, REASON.FAILED);
  assert.equal(foldedByProjection.recipients[0].online.recorded_error_code, null);
  assert.equal(JSON.stringify(foldedByProjection).includes('RAW_VENDOR'), false, '投影不得透出原文');

  // 无法删除 / 无法证实：与失败同样阻塞，绝不等价于"已证实完成"。
  const { coordinator: c3, requestId: r3 } = setup();
  c3.requestThirdPartyDeletion({ requestId: r3, recipientId: 'vendor-d', exportRef: null });
  c3.markUnsupported({ requestId: r3, recipientId: 'vendor-d', exportRef: null });
  const unsupported = projectThirdPartyDeletion({ source: c3, requestId: r3, requestedAt: T, now: DAY30 });
  assertProjectionInvariants(unsupported, 'unsupported');
  assert.equal(unsupported.state, 'failed');
  assert.equal(unsupported.completed, false);
  assert.equal(unsupported.reason_code, REASON.UNSUPPORTED);
  assert.equal(unsupported.receipt_third_party_state, 'unsupported');
});

test('幂等与重复调用：同入参同输出、入参不被修改、重复确认/重复请求行为如实反映', () => {
  const { coordinator, requestId } = setup();
  coordinator.requestThirdPartyDeletion({ requestId, recipientId: 'vendor-a', exportRef: 'exp-1' });

  const input = Object.freeze({ source: coordinator, requestId, requestedAt: T, now: DAY30 });
  const first = projectThirdPartyDeletion(input);
  const second = projectThirdPartyDeletion(input);
  assert.deepEqual(second, first);
  assert.equal(JSON.stringify(second), JSON.stringify(first));

  // 重复确认（同证据）不改变投影结论（幂等重放）。
  coordinator.confirmThirdPartyDeletion({ requestId, recipientId: 'vendor-a', exportRef: 'exp-1', evidenceRef: 'ev-1' });
  const afterConfirm = projectThirdPartyDeletion(input);
  coordinator.confirmThirdPartyDeletion({ requestId, recipientId: 'vendor-a', exportRef: 'exp-1', evidenceRef: 'ev-1' });
  const afterReplay = projectThirdPartyDeletion(input);
  assert.deepEqual(afterReplay, afterConfirm, '重复确认后投影不变');
  assert.equal(afterConfirm.completed, true);
  assert.deepEqual(projectThirdPartyDeletion(input), afterConfirm, '同入参再次调用仍逐字段相同');

  // 重复发起同一接收方请求：既有协议是 append-only（不去重）⇒ 投影如实反映两行，不擅自合并。
  coordinator.requestThirdPartyDeletion({ requestId, recipientId: 'vendor-a', exportRef: 'exp-1' });
  const duplicated = projectThirdPartyDeletion(input);
  assertProjectionInvariants(duplicated, '重复请求');
  assert.equal(duplicated.summary.total, 2);
  assert.equal(duplicated.recipients.length, 2);
  // 第二行仍是 requested ⇒ 整单不得算完成（不得用"有一行完成"掩盖另一行未完成）。
  assert.equal(duplicated.completed, false);
  assert.equal(duplicated.state, 'requested');
  assert.equal(duplicated.reason_code, REASON.REQUESTED);
});

test('fail-closed：越权 / 未能核实归属 / 未知请求 / 入参或行形状不可信 —— 一律不返回行且不得完成', () => {
  const { coordinator, requestId } = setup();
  coordinator.requestThirdPartyDeletion({ requestId, recipientId: 'vendor-a', exportRef: 'exp-1' });

  // 越权：主体不匹配 ⇒ 不返回任何接收方行（不替别人投影）。
  const mismatch = projectThirdPartyDeletion({
    source: coordinator,
    requestId,
    requestedAt: T,
    now: DAY30,
    subject: 'user-a',
    ownerOf: () => 'user-b',
  });
  assertProjectionInvariants(mismatch, '越权');
  assert.equal(mismatch.completed, false);
  assert.equal(mismatch.reason_code, REASON.SUBJECT_MISMATCH);
  assert.deepEqual(mismatch.recipients, []);
  assert.equal(mismatch.receipt_third_party_state, null);

  // 给出主体却无法核实归属 ⇒ fail-closed（不敢假定归属）。
  const unverified = projectThirdPartyDeletion({ source: coordinator, requestId, requestedAt: T, now: DAY30, subject: 'user-a' });
  assertProjectionInvariants(unverified, '归属未核实');
  assert.equal(unverified.reason_code, REASON.OWNERSHIP_UNVERIFIED);
  assert.deepEqual(unverified.recipients, []);

  // 主体匹配 ⇒ 正常投影（正向对照）。
  const owned = projectThirdPartyDeletion({
    source: coordinator,
    requestId,
    requestedAt: T,
    now: DAY30,
    subject: 'user-a',
    ownerOf: () => 'user-a',
  });
  assertProjectionInvariants(owned, '归属匹配');
  assert.equal(owned.summary.total, 1);

  // 未知请求 ⇒ fail-closed。
  const unknown = projectThirdPartyDeletion({
    source: { thirdPartyStatuses: () => [], getRequest: () => null },
    requestId: 'req-does-not-exist',
    requestedAt: T,
    now: DAY30,
  });
  assertProjectionInvariants(unknown, '未知请求');
  assert.equal(unknown.reason_code, REASON.REQUEST_UNKNOWN);
  assert.equal(unknown.completed, false);

  // 入参不可信：requestedAt 非严格 ISO / 阶段窗口算不出来 ⇒ fail-closed。
  for (const bad of ['2026/10/01 00:00:00', 'not-a-time', undefined]) {
    const projection = projectThirdPartyDeletion({ source: coordinator, requestId, requestedAt: bad, now: DAY30 });
    assertProjectionInvariants(projection, `入参非法(${String(bad)})`);
    assert.equal(projection.completed, false);
    assert.equal(projection.reason_code, REASON.INPUT_INVALID);
  }

  // 协议行状态不在闭集内 / 行不是对象 / 来源返回非数组 ⇒ 均不得完成。
  const weirdStatus = projectThirdPartyDeletion({
    source: manualSource([{ recipient_id: 'vendor-w', online_status: 'weird', backup_status: 'confirmed', evidence_ref: 'ev' }]),
    requestId: 'req-manual',
    requestedAt: T,
    now: DAY30,
  });
  assertProjectionInvariants(weirdStatus, '状态不在闭集');
  assert.equal(weirdStatus.completed, false);
  assert.equal(weirdStatus.recipients[0].online.state, 'failed');
  assert.equal(weirdStatus.recipients[0].online.reason_code, REASON.INPUT_INVALID);

  const notArray = projectThirdPartyDeletion({
    source: { thirdPartyStatuses: () => 'nope', getRequest: () => ({}) },
    requestId: 'req-manual',
    requestedAt: T,
    now: DAY30,
  });
  assert.equal(notArray.completed, false);
  assert.equal(notArray.reason_code, REASON.INPUT_INVALID);

  // 来源缺失/空主体 ⇒ fail-closed。
  const noSource = projectThirdPartyDeletion({ source: undefined, requestId, requestedAt: T, now: DAY30 });
  assert.equal(noSource.completed, false);
  assert.equal(noSource.reason_code, REASON.INPUT_INVALID);
  const emptyId = projectThirdPartyDeletion({ source: coordinator, requestId: '', requestedAt: T, now: DAY30 });
  assert.equal(emptyId.reason_code, REASON.INPUT_INVALID);
});

test('无接收方：空集合不得判完成（THIRD_PARTY_NONE），契约值给 null 而不是 confirmed', () => {
  const { coordinator, requestId } = setup();
  const projection = projectThirdPartyDeletion({ source: coordinator, requestId, requestedAt: T, now: DAY30 });
  assertProjectionInvariants(projection, '无接收方');
  assert.equal(projection.completed, false);
  assert.equal(projection.state, 'requested');
  assert.equal(projection.reason_code, REASON.NONE);
  assert.equal(projection.receipt_third_party_state, null, '没有接收方只能是 null，不得用 confirmed 冒充');
  assert.deepEqual(projection.summary, { total: 0, requested: 0, completed: 0, failed: 0 });
  assert.deepEqual(projection.recipients, []);

  // 手工来源返回空数组时同样口径。
  const manual = projectThirdPartyDeletion({
    source: manualSource([]),
    requestId: 'req-manual',
    requestedAt: T,
    now: DAY30,
  });
  assert.equal(manual.reason_code, REASON.NONE);
  assert.equal(manual.receipt_third_party_state, null);
});
