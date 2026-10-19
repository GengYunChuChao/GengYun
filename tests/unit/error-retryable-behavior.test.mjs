// GY-I22（#22）· `retryable` 口径的**行为**回归（不只断言状态码）。
//
// 背景：#233 的「全站统一」把「未接线／配置与权限类 `PROVIDER_UNAVAILABLE` ⇒ retryable:false」写进了
// `services/api/src/errors.ts:28-40`，但**调用点**仍有一批无条件 `retryable: true`。行为层症状是：
// 客户端收到 503 后会**自动重试**，而那些失败重试一万次也不会好（缺权限、缺函数、库不存在、返回形状不符…）。
//
// 因此本文件对每一处改点同时断言三件事：
//   ① `error.code`（契约码，决定 HTTP 状态）；② `error.status`（503/504）；③ `error.retryable`（口径）；
// 并对两个必测臂（`deletion-requests-pg`、`conversations/store-pg`）再断言 `buildErrorEnvelope()` 的
// **线上信封** `error.retryable`——即客户端真正会读到的那个字段（只看 status 无法区分是否可重试）。
//
// 同时保留**反向对照**：瞬时类（40001 串行化 / 40P01 死锁 / 08xxx 连接层 / ECONNREFUSED / 57014 超时）
// 仍必须是 `retryable: true`——本片只收紧「不是时间能解决的」那一类，没有把可重试面一并砍掉。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildErrorEnvelope } from '../../services/api/src/errors.ts';
import { readHomePreviews, readRegistrationEvidence } from '../../services/api/src/db/catalog.ts';
import { createPostgresConversationStore } from '../../services/api/src/conversations/store-pg.ts';
import { createPostgresDeletionRequestStore } from '../../services/api/src/privacy/deletion-requests-pg.ts';

const DRIVER_SECRET = 'PRIVATE_DSN postgres://user:pw@10.0.0.9/sql';
const META = { request_id: 'test-rid', execution_mode: 'real' };

/** 捕获**拒绝值**（若意外 resolve 则抛错，不允许静默通过）。 */
async function capture(promise) {
  let caught;
  await promise.then(
    () => { throw new Error('EXPECTED_REJECTION：该调用本应失败'); },
    (error) => { caught = error; },
  );
  return caught;
}

/** 契约错误的最小白名单断言：码 + HTTP 状态 + retryable + 不泄露驱动原文。 */
function assertApiError(error, expected) {
  assert.equal(error.code, expected.code, `契约码不符：${error.code} ≠ ${expected.code}`);
  assert.equal(error.status, expected.status, `HTTP 状态不符：${error.status} ≠ ${expected.status}`);
  assert.equal(error.retryable, expected.retryable, `retryable 不符：${error.retryable} ≠ ${expected.retryable}`);
  assert.equal(String(error.message).includes('PRIVATE_DSN'), false, '错误消息不得带驱动原文');
}

/** 线上信封断言：客户端真正读到的 `error.retryable`。 */
function assertEnvelope(error, expected) {
  const envelope = buildErrorEnvelope(error, META);
  assert.equal(envelope.error.code, expected.code);
  assert.equal(envelope.error.retryable, expected.retryable);
  assert.equal(JSON.stringify(envelope).includes('PRIVATE_DSN'), false);
}

const dbError = (code) => Object.assign(new Error(DRIVER_SECRET), { code });

// ---------------------------------------------------------------- 资料读面（db/catalog.ts）

test('资料读面：权限/配置/无法归类 ⇒ 503 且 retryable:false（改前一律 true）', async () => {
  for (const code of ['42501', '28P01', '3D000', '42P01', '42883', undefined]) {
    const pool = { async query() { throw dbError(code); } };
    const home = await capture(readHomePreviews(pool, 'real'));
    assertApiError(home, { code: 'PROVIDER_UNAVAILABLE', status: 503, retryable: false });
    assertEnvelope(home, { code: 'PROVIDER_UNAVAILABLE', retryable: false });

    const registration = await capture(readRegistrationEvidence(pool, 'real', '国药准字H20090001'));
    assertApiError(registration, { code: 'PROVIDER_UNAVAILABLE', status: 503, retryable: false });
  }
});

test('资料读面：超时/连接层/串行化/管理员干预仍是可重试（反向对照，不许砍掉可重试面）', async () => {
  for (const code of ['ECONNREFUSED', 'ECONNRESET', '40001', '40P01', '08P01', '53300']) {
    const pool = { async query() { throw dbError(code); } };
    const home = await capture(readHomePreviews(pool, 'real'));
    assertApiError(home, { code: 'PROVIDER_UNAVAILABLE', status: 503, retryable: true });
    // 登记读面状态码保持既有 503（本片只订正 retryable，不额外改状态码）。
    const registration = await capture(readRegistrationEvidence(pool, 'real', '国药准字H20090001'));
    assertApiError(registration, { code: 'PROVIDER_UNAVAILABLE', status: 503, retryable: true });
  }
  const pool = { async query() { throw dbError('57014'); } };
  const home = await capture(readHomePreviews(pool, 'real'));
  assertApiError(home, { code: 'PROVIDER_TIMEOUT', status: 504, retryable: true });
  const registration = await capture(readRegistrationEvidence(pool, 'real', '国药准字H20090001'));
  assertApiError(registration, { code: 'PROVIDER_UNAVAILABLE', status: 503, retryable: true });
});

// ------------------------------------------------- 问答库事务（conversations/store-pg.ts）

/** 事务池替身：connect() 后每条语句都抛同一个数据库错误。 */
function explodingTransactionalPool(code) {
  const client = { async query() { throw dbError(code); }, release() {} };
  return { async query() { throw dbError(code); }, async connect() { return client; } };
}

test('问答库 CAS 删除：42501/42883/无法归类 ⇒ 503 且 retryable:false（含线上信封）', async () => {
  const store = createPostgresConversationStore(explodingTransactionalPool('42501'));
  for (const code of ['42501', '42883', '28P01', undefined]) {
    const failing = createPostgresConversationStore(explodingTransactionalPool(code));
    const error = await capture(failing.deleteConversation('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b2', 1));
    assertApiError(error, { code: 'PROVIDER_UNAVAILABLE', status: 503, retryable: false });
    assertEnvelope(error, { code: 'PROVIDER_UNAVAILABLE', retryable: false });
  }
  assert.equal(store.persistent, true);
});

test('问答库 CAS 删除：57014 ⇒ 504 可重试；40001/08xxx ⇒ 503 可重试（反向对照）', async () => {
  const timeout = await capture(
    createPostgresConversationStore(explodingTransactionalPool('57014'))
      .deleteConversation('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b2', 1),
  );
  assertApiError(timeout, { code: 'PROVIDER_TIMEOUT', status: 504, retryable: true });
  for (const code of ['40001', '08P01']) {
    const error = await capture(
      createPostgresConversationStore(explodingTransactionalPool(code))
        .deleteConversation('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b2', 1),
    );
    assertApiError(error, { code: 'PROVIDER_UNAVAILABLE', status: 503, retryable: true });
  }
});

// ------------------------------------------- 注销受理（privacy/deletion-requests-pg.ts）

const DELETION_ID = '00000000-0000-4000-8000-0000000000c1';
const DELETION_USER = '00000000-0000-4000-8000-0000000000c2';

function deletionInput() {
  return {
    id: DELETION_ID,
    userId: DELETION_USER,
    receiptHash: 'a'.repeat(64),
    generation: 1,
    requestedAt: '2026-10-14T06:00:00.000Z',
    onlineDueAt: '2026-10-21T06:00:00.000Z',
    backupDueAt: '2026-11-13T06:00:00.000Z',
    receiptIssuedAt: '2026-10-14T06:00:00.000Z',
    receiptExpiresAt: '2026-11-18T06:00:00.000Z',
  };
}

const isCall = (text) => String(text).includes('public.request_account_deletion');

/** 事务池替身：函数调用语句返回 `payload`（其余语句回空）。 */
function deletionPoolReturning(payload) {
  const respond = (text) => (isCall(text) ? { rows: [{ result: payload }] } : { rows: [] });
  const client = { async query(text) { return respond(text); }, release() {} };
  return { async query(text) { return respond(text); }, async connect() { return client; } };
}

/** 事务池替身：函数调用语句抛指定数据库错误（BEGIN 等语句照常成功）。 */
function deletionPoolThrowing(code) {
  const client = {
    async query(text) { if (isCall(text)) throw dbError(code); return { rows: [] }; },
    release() {},
  };
  return { async query() { return { rows: [] }; }, async connect() { return client; } };
}

test('注销受理：42501/42883/无法归类 ⇒ 503 且 retryable:false（含线上信封）', async () => {
  for (const code of ['42501', '42883', '3D000', undefined]) {
    const store = createPostgresDeletionRequestStore({ pool: deletionPoolThrowing(code) });
    const error = await capture(store.createRequest(deletionInput()));
    assertApiError(error, { code: 'PROVIDER_UNAVAILABLE', status: 503, retryable: false });
    assertEnvelope(error, { code: 'PROVIDER_UNAVAILABLE', retryable: false });
  }
});

test('注销受理：无事务能力（接线未完成）⇒ 503 且 retryable:false', async () => {
  for (const pool of [{ async query() { return { rows: [] }; } }, null]) {
    const store = createPostgresDeletionRequestStore({ pool });
    const error = await capture(store.createRequest(deletionInput()));
    assertApiError(error, { code: 'PROVIDER_UNAVAILABLE', status: 503, retryable: false });
    assertEnvelope(error, { code: 'PROVIDER_UNAVAILABLE', retryable: false });
  }
});

test('注销受理：函数返回形状不符（缺字段／非对象／非整数／时刻不可解析）⇒ 503 且 retryable:false', async () => {
  const payloads = [
    {}, // 缺全部字段
    'not-an-object', // 返回不是对象
    { ...validReceipt(), revision: '1.5' }, // 非整数
    { ...validReceipt(), requested_at: 'not-a-time' }, // 时刻不可解析
  ];
  for (const payload of payloads) {
    const store = createPostgresDeletionRequestStore({ pool: deletionPoolReturning(payload) });
    const error = await capture(store.createRequest(deletionInput()));
    assertApiError(error, { code: 'PROVIDER_UNAVAILABLE', status: 503, retryable: false });
    assertEnvelope(error, { code: 'PROVIDER_UNAVAILABLE', retryable: false });
  }
});

test('注销受理：成功形状不被误伤（对照组，证明上面的失败来自形状而不是通道本身）', async () => {
  const store = createPostgresDeletionRequestStore({ pool: deletionPoolReturning(validReceipt()) });
  const record = await store.createRequest(deletionInput());
  assert.equal(record.id, DELETION_ID);
  assert.equal(record.userId, DELETION_USER);
  assert.equal(record.revokedSessions, 0);
});

test('注销受理：57014/55P03 ⇒ 504 可重试；40001/08P01 ⇒ 503 可重试（反向对照）', async () => {
  for (const code of ['57014', '55P03']) {
    const store = createPostgresDeletionRequestStore({ pool: deletionPoolThrowing(code) });
    const error = await capture(store.createRequest(deletionInput()));
    assertApiError(error, { code: 'PROVIDER_TIMEOUT', status: 504, retryable: true });
  }
  for (const code of ['40001', '08P01']) {
    const store = createPostgresDeletionRequestStore({ pool: deletionPoolThrowing(code) });
    const error = await capture(store.createRequest(deletionInput()));
    assertApiError(error, { code: 'PROVIDER_UNAVAILABLE', status: 503, retryable: true });
  }
});

/** 函数成功返回的实测形状（`0016_account_deletion_persistence.sql` 的 `result`）。 */
function validReceipt() {
  return {
    id: DELETION_ID,
    user_id: DELETION_USER,
    state: 'requested',
    revision: 1,
    requested_at: '2026-10-14T06:00:00.000Z',
    online_due_at: '2026-10-21T06:00:00.000Z',
    backup_due_at: '2026-11-13T06:00:00.000Z',
    receipt_issued_at: '2026-10-14T06:00:00.000Z',
    receipt_expires_at: '2026-11-18T06:00:00.000Z',
    account_state: 'deletion_pending',
    auth_epoch: 2,
    account_revision: 3,
    revoked_sessions: 0,
  };
}
