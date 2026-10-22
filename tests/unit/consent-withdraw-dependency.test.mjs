/**
 * GY-R31-I29 · 撤授权**依赖判定臂**的只读回归钉（不改变生产行为）。
 *
 * 结论前置（详见 `docs/verification/gy-r31-i29-withdraw-deps-20261014.md`）：
 * `services/api/src/privacy/consent-pg.ts:171-196` 早已有依赖判定与 409 分支，且产品装配
 * （`services/api/src/app.ts:860-870` → `:1419-1422`）**必然注入** `egressRevoker`，
 * 所以「有依赖」在装配后的语义是**撤回成功并先撤销在途外发**，不是 409。
 * 因此本片**不加**新的 409，只把**当前**语义钉死，防止将来被无声改成「一律 409」或
 * 「缺消费者就放行」。
 *
 * 本文件钉死的六点：
 *  1. 有依赖 + 已注入消费者 ⇒ 撤回成功（**200 语义**），消费者在同一事务内被调用一次；
 *  2. 依赖与撤回**同事务且先判后写**：`BEGIN` → 依赖查询 → `UPDATE consent_records` → `COMMIT`；
 *  3. 依赖查询只带**调用者本人** `userId`（不跨主体探测，不泄露他人依赖）；
 *  4. **依赖清空** + 未注入消费者 ⇒ 撤回成功：缺消费者**不等于**一律拒绝，判定真的在查库；
 *  5. 有依赖 + 未注入消费者 ⇒ 409 `OBJECT_UNAVAILABLE`（`retryable:false`），不留幂等回执、
 *     不写撤回、不递增 epoch（`ROLLBACK`）；
 *  6. 消费者抛错（如账本未就绪）⇒ 仍是 409 `OBJECT_UNAVAILABLE`（**不得**退化成 503
 *     `PROVIDER_UNAVAILABLE`），同样不留回执。
 *
 * 第 1–6 点全部跑在**明确标注的合成 PG 替身**上（canned `query` 结果，不连任何数据库）。
 * 真库读数不在此文件：既有 `docs/verification/gy-i27-egress-ledger-pg-20261014.md`（PASS 8
 * HTTP 撤回 200 + 在途置 `failed`）与 `tests/integration/auth-privacy-pg.mjs:329-333`
 * （真库有依赖 ⇒ 409、依赖清空后 ⇒ 200）覆盖；本片不重复、也不冒充已跑真库。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresConsentService } from '../../services/api/src/privacy/consent-pg.ts';

const USER_ID = '11111111-1111-4111-8111-1111111111aa';
const SESSION_ID = '22222222-2222-4222-8222-2222222222bb';
const RECORD_ID = '33333333-3333-4333-8333-3333333333cc';
const PURPOSE = 'external_inference';
const GRANTED_AT = new Date('2026-10-14T00:00:00.000Z');
const WITHDRAWN_AT = new Date('2026-10-14T01:00:00.000Z');

/**
 * **合成** PG 替身：按 SQL 片段返回 canned 结果。`present` 决定依赖判定臂的三态输入，
 * `queries` 保留**顺序**用于断言「同事务 + 先判后写」。
 */
function syntheticPool({ present }) {
  const consentRow = (state) => ({
    id: RECORD_ID,
    user_id: USER_ID,
    purpose: PURPOSE,
    policy_version: '1.0.0',
    recipient_ids: ['fixture-llm'],
    state,
    epoch: 1,
    granted_at: GRANTED_AT,
    withdrawn_at: state === 'granted' ? null : WITHDRAWN_AT,
    revision: state === 'granted' ? 1 : 2,
    epoch_state: state,
    current_epoch: 1,
  });
  const queries = [];
  const client = {
    async query(text, values) {
      const sql = String(text);
      queries.push({ text: sql, values });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.startsWith('SET LOCAL')) return { rows: [] };
      if (sql.includes('FROM public.sessions')) return { rows: [{ id: SESSION_ID }] };
      if (sql.includes('FROM public.users')) return { rows: [{ id: USER_ID, state: 'active', auth_epoch: 1, revision: 1 }] };
      if (sql.includes('DELETE FROM public.idempotency_keys')) return { rows: [] };
      if (sql.includes('SELECT request_hash,outcome FROM public.idempotency_keys')) return { rows: [] };
      if (sql.includes('JOIN public.consent_records')) return { rows: [consentRow('granted')] };
      // 依赖判定：jobs / media / exports / author_links 四臂合成成一条 EXISTS 并集。
      if (sql.includes('AS present')) return { rows: [{ present }] };
      if (sql.includes('UPDATE public.consent_records')) return { rows: [consentRow('withdrawn')] };
      if (sql.includes('UPDATE public.privacy_epochs')) return { rows: [{ user_id: USER_ID }] };
      return { rows: [] };
    },
    release() {},
  };
  return { queries, async connect() { return client; } };
}

const identityInput = {
  identity: {
    userId: USER_ID,
    authEpoch: 1,
    role: 'user',
    sessionId: SESSION_ID,
    expiresAt: new Date(Date.now() + 3600_000),
    revision: 1,
    scopes: ['user'],
  },
  token: 'synthetic-opaque-token',
};

const withdrawInput = (idempotencyKey) => ({ purpose: PURPOSE, ifMatch: '"1"', idempotencyKey });
const sqlIndexOf = (pool, needle) => pool.queries.findIndex((q) => q.text.includes(needle));

test('依赖存在 + 已注入撤回消费者 ⇒ 撤回成功（现状不是 409），消费者同事务内先撤在途', async () => {
  const pool = syntheticPool({ present: true });
  const calls = [];
  const service = createPostgresConsentService(pool, 'synthetic-hmac-key', {
    egressRevoker: {
      onConsentWithdrawn: (input) => { calls.push(input); return { revokedInFlight: 3 }; },
      onAccountSuspendedOrDeleted: () => ({ revokedInFlight: 0 }),
    },
  });
  const result = await service.withdraw(identityInput, withdrawInput('synthetic-dep-key-0001'));

  // 当前语义：有依赖**不**阻断撤回。
  assert.equal(result.state, 'withdrawn');
  assert.equal(result.withdrawn_at, WITHDRAWN_AT.toISOString());
  assert.deepEqual(calls, [{ userId: USER_ID, purpose: PURPOSE }], '消费者必须被调用且只调用一次');

  // 同事务 + 先判后写：BEGIN → 依赖判定 → UPDATE consent_records → UPDATE privacy_epochs → COMMIT。
  const begin = pool.queries.findIndex((q) => q.text === 'BEGIN');
  const dependency = sqlIndexOf(pool, 'AS present');
  const updateRecord = sqlIndexOf(pool, 'UPDATE public.consent_records');
  const updateEpoch = sqlIndexOf(pool, 'UPDATE public.privacy_epochs');
  const commit = pool.queries.findIndex((q) => q.text === 'COMMIT');
  assert.ok(begin >= 0 && dependency > begin, '依赖判定必须在事务内');
  assert.ok(updateRecord > dependency, '依赖判定必须早于撤回写入（不是先写后补判）');
  assert.ok(updateEpoch > updateRecord, '撤回必须先撤在途、再撤回记录、再递增 epoch');
  assert.ok(commit > updateEpoch, '必须在同一事务内提交');
  assert.equal(pool.queries.some((q) => q.text === 'ROLLBACK'), false, '成功路径不得回滚');
});

test('依赖判定只带调用者本人 ⇒ 撤回只探测自己的主体，不跨主体', async () => {
  const pool = syntheticPool({ present: true });
  const service = createPostgresConsentService(pool, 'synthetic-hmac-key', {
    egressRevoker: { onConsentWithdrawn: () => ({ revokedInFlight: 1 }), onAccountSuspendedOrDeleted: () => ({ revokedInFlight: 0 }) },
  });
  await service.withdraw(identityInput, withdrawInput('synthetic-dep-key-0002'));

  const dependency = pool.queries[sqlIndexOf(pool, 'AS present')];
  assert.deepEqual(dependency.values, [USER_ID], '依赖判定只允许带当前用户 id');
  const updateRecord = pool.queries[sqlIndexOf(pool, 'UPDATE public.consent_records')];
  assert.deepEqual(updateRecord.values, [RECORD_ID, USER_ID], '撤回写入同样只落在本人主体上');
  // 全量核对：本路径出现的 uuid 参数只属于「本人」——本人 id / 本人会话 / 本人记录，
  // 没有第四个 uuid（即不可能探测到他人主体）。
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const uuids = pool.queries.flatMap(({ values }) => values ?? []).filter((v) => typeof v === 'string' && uuid.test(v));
  assert.deepEqual([...new Set(uuids)].sort(), [RECORD_ID, SESSION_ID, USER_ID].sort());
});

test('依赖清空 + 未注入撤回消费者 ⇒ 撤回成功（缺消费者不等于一律 409）', async () => {
  const pool = syntheticPool({ present: false });
  const service = createPostgresConsentService(pool, 'synthetic-hmac-key');
  const result = await service.withdraw(identityInput, withdrawInput('synthetic-dep-key-0003'));

  assert.equal(result.state, 'withdrawn');
  assert.ok(sqlIndexOf(pool, 'AS present') >= 0, '即使无依赖也必须真的查过依赖（证明判定在库上）');
  assert.ok(sqlIndexOf(pool, 'UPDATE public.consent_records') >= 0, '无依赖必须真的写入撤回');
  assert.equal(pool.queries.some((q) => q.text === 'ROLLBACK'), false);
});

test('有依赖 + 未注入撤回消费者 ⇒ 409 OBJECT_UNAVAILABLE（确定性失败）且不留回执', async () => {
  const pool = syntheticPool({ present: true });
  const service = createPostgresConsentService(pool, 'synthetic-hmac-key');
  await assert.rejects(
    () => service.withdraw(identityInput, withdrawInput('synthetic-dep-key-0004')),
    (error) => {
      assert.equal(error.code, 'OBJECT_UNAVAILABLE');
      assert.equal(error.status, 409, '#451/#455 口径：409 是确定性失败');
      assert.equal(error.retryable, false, '不得声称可重试');
      assert.match(error.message, /撤回消费者尚未接入/);
      return true;
    },
  );
  // fail-closed：不写撤回、不递增 epoch、不留幂等回执（否则重放会拿到"成功"）。
  assert.equal(sqlIndexOf(pool, 'UPDATE public.consent_records'), -1);
  assert.equal(sqlIndexOf(pool, 'UPDATE public.privacy_epochs'), -1);
  assert.equal(sqlIndexOf(pool, 'INSERT INTO public.idempotency_keys'), -1);
  assert.ok(pool.queries.some((q) => q.text === 'ROLLBACK'), '拒绝必须回滚事务');
  assert.equal(pool.queries.some((q) => q.text === 'COMMIT'), false, '拒绝不得提交');
});

test('撤回消费者抛错 ⇒ 仍是 409 OBJECT_UNAVAILABLE，不得退化成 503', async () => {
  const pool = syntheticPool({ present: true });
  const service = createPostgresConsentService(pool, 'synthetic-hmac-key', {
    // 账本未就绪（缺 0011 迁移 / egress_ledger 角色）时的真实形态：驱动错误直接冒泡。
    egressRevoker: {
      onConsentWithdrawn: () => { const error = new Error('relation "egress_ledger" does not exist'); error.code = '42P01'; return Promise.reject(error); },
      onAccountSuspendedOrDeleted: () => ({ revokedInFlight: 0 }),
    },
  });
  await assert.rejects(
    () => service.withdraw(identityInput, withdrawInput('synthetic-dep-key-0005')),
    (error) => {
      assert.equal(error.code, 'OBJECT_UNAVAILABLE', '如实拒绝部分撤回，不得说成"授权服务不可用"');
      assert.notEqual(error.code, 'PROVIDER_UNAVAILABLE');
      assert.equal(error.status, 409);
      assert.equal(error.retryable, false);
      assert.match(error.message, /拒绝在途未撤销的部分撤回/);
      return true;
    },
  );
  assert.equal(sqlIndexOf(pool, 'UPDATE public.consent_records'), -1);
  assert.equal(sqlIndexOf(pool, 'INSERT INTO public.idempotency_keys'), -1);
  assert.ok(pool.queries.some((q) => q.text === 'ROLLBACK'));
});
