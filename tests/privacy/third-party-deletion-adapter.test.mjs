/**
 * GY-I19（#19）片 E · 第三方删除适配器**接线框架** 单测。
 *
 * 覆盖（含门禁要求的负例）：
 *   - 无凭据 fail-closed：不调用 fetch、`OBJECT_UNAVAILABLE`、绝不判完成；
 *   - 不回退替身：未接线时即使注入了 fetch 也不得经它产出 confirmed；
 *   - 观测脱敏：审计/日志不含凭据、不含供应商异常原文、不含回执引用原文；
 *   - 有凭据正向：经注入点**单次**调用，登记 requestId/耗时/状态；
 *   - fetch 回执映射：deleted+引用⇒confirmed，deleted 无引用⇒不得完成，
 *     not_found/unsupported/failed/未知状态 ⇒ 一律不判完成。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createThirdPartyDeletionAdapter,
  THIRD_PARTY_DELETION_UNAVAILABLE_CODE,
  THIRD_PARTY_DELETION_OUTCOME_STATES,
  THIRD_PARTY_DELETION_FETCH_STATUSES,
} from '../../services/api/src/privacy/third-party-deletion-adapter.ts';

const T0 = new Date('2026-10-01T00:00:00.000Z');

function fixedClock(initialMs = T0.getTime()) {
  let t = initialMs;
  return {
    now: () => new Date(t),
    advance: (ms) => {
      t += ms;
    },
  };
}

test('无凭据 fail-closed：不调用 fetch、OBJECT_UNAVAILABLE、不判完成', async () => {
  let called = 0;
  const adapter = createThirdPartyDeletionAdapter({
    credentials: null,
    fetch: async () => {
      called += 1;
      return { status: 'deleted', reference: 'ref-1' };
    },
    now: () => T0,
  });

  assert.equal(adapter.available, false);
  assert.equal(adapter.transportKind, 'unwired');
  assert.ok(adapter.unavailableReason && adapter.unavailableReason.length > 0);
  assert.ok(adapter.note && adapter.note.length > 0);

  const outcome = await adapter.dispatch({ requestId: 'req-1', recipientId: 'vendor-a', exportRef: null });
  assert.equal(called, 0, '无凭据绝不调用 fetch');
  assert.equal(outcome.status, 'unavailable');
  assert.equal(outcome.completed, false);
  assert.equal(outcome.error_code, THIRD_PARTY_DELETION_UNAVAILABLE_CODE);
  assert.equal(outcome.error_code, 'OBJECT_UNAVAILABLE');
  assert.equal(outcome.evidence_ref, null);
  assert.equal(outcome.duration_ms, null);
  assert.equal(outcome.attempted_at, null);

  const audit = adapter.audit();
  assert.equal(audit.length, 1);
  assert.equal(audit[0].request_id, 'req-1');
  assert.equal(audit[0].status, 'unavailable');
  assert.equal(audit[0].completed, false);
  assert.equal(audit[0].error_code, 'OBJECT_UNAVAILABLE');
});

test('无 fetch（有凭据）同样 fail-closed：不发出调用', async () => {
  const adapter = createThirdPartyDeletionAdapter({
    credentials: { token: 't' },
    fetch: null,
    now: () => T0,
  });
  assert.equal(adapter.available, false);
  const outcome = await adapter.dispatch({ requestId: 'req-1', recipientId: 'vendor-a', exportRef: null });
  assert.equal(outcome.status, 'unavailable');
  assert.equal(outcome.completed, false);
  assert.equal(outcome.error_code, 'OBJECT_UNAVAILABLE');
});

test('不回退替身：未接线时即使注入 fetch 也不得经它产出 confirmed', async () => {
  let called = 0;
  // 凭据缺省（undefined）但 fetch 存在 ⇒ 仍 fail-closed，fetch 不得被当作替身调用。
  const adapter = createThirdPartyDeletionAdapter({
    fetch: async () => {
      called += 1;
      return { status: 'deleted', reference: 'ref-stub' };
    },
    now: () => T0,
  });
  assert.equal(adapter.available, false);
  const outcome = await adapter.dispatch({ requestId: 'req-1', recipientId: 'vendor-a', exportRef: null });
  assert.equal(called, 0);
  assert.equal(outcome.status, 'unavailable');
  assert.equal(outcome.completed, false);
  assert.ok(outcome.status !== 'confirmed', '绝不回退替身成功');
  assert.equal(JSON.stringify(adapter.audit()).includes('ref-stub'), false);
});

test('观测脱敏：审计/日志不含凭据、不含供应商异常原文、不含回执引用', async () => {
  const logs = [];
  const adapter = createThirdPartyDeletionAdapter({
    credentials: { token: 'SECRET_TOKEN_ABC', api_key: 'KEY-SECRET-123' },
    fetch: async () => {
      throw new Error('VENDOR_RAW_SECRET_LEAK_987');
    },
    now: () => T0,
    logSink: (entry) => logs.push(entry),
  });

  const outcome = await adapter.dispatch({ requestId: 'req-1', recipientId: 'vendor-a', exportRef: null });
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.completed, false);
  assert.equal(outcome.error_code, 'THIRD_PARTY_FAILED');

  const auditJson = JSON.stringify(adapter.audit());
  const logJson = JSON.stringify(logs);
  for (const secret of ['SECRET_TOKEN_ABC', 'KEY-SECRET-123', 'VENDOR_RAW_SECRET_LEAK_987']) {
    assert.equal(auditJson.includes(secret), false, `审计不得含 ${secret}`);
    assert.equal(logJson.includes(secret), false, `日志不得含 ${secret}`);
  }
  // 证据条目只含白名单字段。
  assert.deepEqual(Object.keys(adapter.audit()[0]).sort(), [
    'attempted_at',
    'completed',
    'duration_ms',
    'error_code',
    'recipient_id',
    'request_id',
    'status',
  ]);
});

test('有凭据正向：经注入点单次调用，登记 requestId/耗时/状态，观测不含回执引用', async () => {
  let called = 0;
  const logs = [];
  const clock = fixedClock();
  const adapter = createThirdPartyDeletionAdapter({
    credentials: { token: 'SECRET_TOKEN_ABC' },
    fetch: async ({ requestId, recipientId, exportRef }) => {
      called += 1;
      assert.equal(requestId, 'req-1');
      assert.equal(recipientId, 'vendor-a');
      assert.equal(exportRef, 'exp-1');
      clock.advance(25);
      return { status: 'deleted', reference: 'VENDOR_RECEIPT_REF_777' };
    },
    now: clock.now,
    logSink: (entry) => logs.push(entry),
  });

  assert.equal(adapter.available, true);
  assert.equal(adapter.transportKind, 'real');
  assert.equal(adapter.unavailableReason, null);

  const outcome = await adapter.dispatch({ requestId: 'req-1', recipientId: 'vendor-a', exportRef: 'exp-1' });
  assert.equal(called, 1, '经注入点单次调用');
  assert.equal(outcome.status, 'confirmed');
  assert.equal(outcome.completed, true);
  assert.equal(outcome.error_code, null);
  assert.equal(outcome.evidence_ref, 'VENDOR_RECEIPT_REF_777');
  assert.equal(outcome.duration_ms, 25);
  assert.equal(outcome.attempted_at, T0.toISOString());

  const audit = adapter.audit();
  assert.equal(audit.length, 1);
  assert.equal(audit[0].request_id, 'req-1');
  assert.equal(audit[0].recipient_id, 'vendor-a');
  assert.equal(audit[0].status, 'confirmed');
  assert.equal(audit[0].completed, true);
  assert.equal(audit[0].error_code, null);
  assert.equal(audit[0].duration_ms, 25);
  assert.equal(audit[0].attempted_at, T0.toISOString());

  // 回执引用与凭据不进观测（观测只记 requestId/耗时/状态）。
  const auditJson = JSON.stringify(audit);
  const logJson = JSON.stringify(logs);
  assert.equal(auditJson.includes('VENDOR_RECEIPT_REF_777'), false, '回执引用不进观测');
  assert.equal(logJson.includes('VENDOR_RECEIPT_REF_777'), false, '回执引用不进日志');
  assert.equal(auditJson.includes('SECRET_TOKEN_ABC'), false, '凭据不进观测');
  assert.equal(logJson.includes('SECRET_TOKEN_ABC'), false, '凭据不进日志');
});

test('fetch 回执映射：deleted 缺引用 / not_found / unsupported / failed / 未知状态 一律不判完成', async () => {
  const cases = [
    { status: 'deleted', reference: null, expect: 'unsupported', errorCode: 'EVIDENCE_REQUIRED' },
    { status: 'deleted', reference: '   ', expect: 'unsupported', errorCode: 'EVIDENCE_REQUIRED' },
    { status: 'not_found', reference: null, expect: 'unsupported', errorCode: null },
    { status: 'unsupported', reference: null, expect: 'unsupported', errorCode: null },
    { status: 'failed', reference: null, expect: 'failed', errorCode: 'THIRD_PARTY_FAILED' },
    { status: 'WEIRD_VENDOR_STATUS', reference: null, expect: 'failed', errorCode: 'THIRD_PARTY_FAILED' },
  ];

  for (const c of cases) {
    const adapter = createThirdPartyDeletionAdapter({
      credentials: { token: 't' },
      fetch: async () => ({ status: c.status, reference: c.reference }),
      now: () => T0,
    });
    const outcome = await adapter.dispatch({ requestId: 'req-1', recipientId: 'vendor-a', exportRef: null });
    assert.equal(outcome.status, c.expect, `status=${c.status}`);
    assert.equal(outcome.completed, false, `status=${c.status} 绝不判完成`);
    assert.equal(outcome.error_code, c.errorCode, `status=${c.status}`);
    assert.equal(outcome.evidence_ref, null, `status=${c.status} 无证据引用`);
    assert.equal(adapter.audit()[0].completed, false);
  }
});

test('输入不可信（空 requestId/recipientId）⇒ fail-closed，不调用 fetch', async () => {
  let called = 0;
  const adapter = createThirdPartyDeletionAdapter({
    credentials: { token: 't' },
    fetch: async () => {
      called += 1;
      return { status: 'deleted', reference: 'ref-1' };
    },
    now: () => T0,
  });
  assert.equal(adapter.available, true);

  for (const input of [
    { requestId: '', recipientId: 'vendor-a', exportRef: null },
    { requestId: 'req-1', recipientId: '', exportRef: null },
    { requestId: '   ', recipientId: 'vendor-a', exportRef: null },
  ]) {
    const outcome = await adapter.dispatch(input);
    assert.equal(outcome.status, 'unavailable');
    assert.equal(outcome.completed, false);
    assert.equal(outcome.error_code, 'OBJECT_UNAVAILABLE');
  }
  assert.equal(called, 0, '输入不可信时不得调用 fetch');
});

test('闭集完整性：结果状态与回执状态闭集冻结且为只读数组', () => {
  assert.ok(THIRD_PARTY_DELETION_OUTCOME_STATES.includes('confirmed'));
  assert.ok(THIRD_PARTY_DELETION_OUTCOME_STATES.includes('unavailable'));
  assert.ok(THIRD_PARTY_DELETION_FETCH_STATUSES.includes('deleted'));
  assert.ok(Object.isFrozen(THIRD_PARTY_DELETION_OUTCOME_STATES));
  assert.ok(Object.isFrozen(THIRD_PARTY_DELETION_FETCH_STATUSES));
});
