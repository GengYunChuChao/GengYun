/**
 * GY-I22（#22）· 外发账本「按对象三元组查预留行」的**属主过滤 fail-closed**回归。
 *
 * 改前缺陷：`findReservedByObject({ …, userId })` 里
 *   `const scoped = typeof userId === 'string' && UUID.test(userId);`
 * ⇒ 传了**非 uuid** 的 userId 时 `scoped === false`，SQL 的 `AND user_id=$4::uuid` 整段被省掉，
 * 查询**静默**退回「该对象最新 reserved 行」—— 很可能是**别人属主**的行（跨用户串行 / 越权外发）。
 * 改后：`userId` 传了就必须是合法 uuid，非法值抛 `SESSION_REQUIRED`（401）且**一次查询都不发**。
 *
 * 本用例用假 pool（零端口、零网络、零真库）：SQL 过滤由文件内的极小模拟器执行，
 * 因此「把属主过滤省掉」会立刻被下面的对照断言打红 —— 这正是本片要钉住的东西。
 * 钉住三条口径：
 *   1. 非法 userId ⇒ 抛 `SESSION_REQUIRED`，文案固定、不含入参、零查询（绝不静默退回）；
 *   2. 合法 uuid：命中 ⇒ **自己的行**（即便同 object 另一属主有**更新的** reserved）；未命中 ⇒ null；
 *   3. **未提供** userId ⇒ 既有语义逐字不变（不带属主过滤、参数仍是 3 个，返回最新 reserved 行，
 *      媒体维 `task-egress` 依赖此口径）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresExportLedger } from '../../services/api/src/privacy/ledger-pg.ts';
import { PrivacyError, toErrorEnvelope } from '../../packages/privacy/errors.mjs';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const USER_C = '33333333-3333-4333-8333-333333333333';
const MEDIA_ID = '44444444-4444-4444-8444-444444444444';
const TEXT_KEY = 'checked_content-0001';
const SENTINEL = '00000000-0000-0000-0000-000000000000';
const EXPORT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EXPORT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** 与 `toRecord` 入参同形的账本行（只给本用例断言用到的列，其余列按真实表默认给值）。 */
function exportRow(overrides) {
  return {
    id: EXPORT_A,
    user_id: USER_A,
    object_type: 'media',
    object_id: MEDIA_ID,
    object_key: null,
    object_revision: 1,
    purpose: 'external_inference',
    consent_id: '55555555-5555-4555-8555-555555555555',
    consent_epoch: 1,
    required_consents: { media_processing: 1, external_inference: 1 },
    recipient_id: 'fixture-weed',
    recipient_config_version: 'fixture-config-v1',
    source_version: null,
    state: 'reserved',
    auth_epoch: 1,
    revision: 1,
    error_code: null,
    job_id: null,
    cancelled_at: null,
    cancellation_reason: null,
    deletion_state: 'active',
    requested_at: '2026-01-01T00:00:00.000Z',
    sent_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * 假连接池：记录每次查询，并按 `findReservedByObject` 真实 SQL 的**过滤条件**筛选夹具行
 * （object_type / 对象标识列 / object_revision / 属主 / state / cancelled_at / ORDER BY created_at DESC LIMIT 1）。
 * 属主过滤一旦从 SQL 里消失（`scoped` 判错），这里就会把别人的行返回给用例。
 */
function createFakePool(rows) {
  const queries = [];
  return {
    queries,
    // `createPostgresExportLedger` 要求连接池同时具备 `connect` 与 `query`；本用例只覆盖**只读查询**，
    // 一旦有路径真的去开事务（`pool.connect`），立刻显式失败而不是静默通过。
    async connect() {
      throw new Error('本用例只覆盖只读查询：不应开启事务（pool.connect）');
    },
    async query(text, params = []) {
      queries.push({ text: String(text), params });
      const byKey = /object_key=\$2/.test(text);
      const scoped = /AND user_id=\$4::uuid/.test(text);
      const [objectType, ident, revision, userId] = params;
      const matched = rows
        .filter((row) => row.object_type === objectType && row.object_revision === revision)
        .filter((row) => (byKey ? row.object_key === ident : row.object_id === ident))
        .filter((row) => (scoped ? row.user_id === userId : true))
        .filter((row) => row.state === 'reserved' && row.cancelled_at === null)
        .sort((left, right) => (left.created_at < right.created_at ? 1 : left.created_at > right.created_at ? -1 : 0))
        .slice(0, 1);
      return { rows: matched };
    },
  };
}

function build(rows) {
  const pool = createFakePool(rows);
  return { ledger: createPostgresExportLedger({ pool }), pool };
}

test('非法 userId：抛 SESSION_REQUIRED（401、固定文案、不含入参），且一次查询都不发（不静默退回全局最新行）', async () => {
  const illegal = [
    ['空串', ''],
    ['非 uuid 文本', 'abc'],
    ['纯数字', '123'],
    ['合法 uuid 前带空格', ` ${USER_A}`],
    ['合法 uuid 后带空格', `${USER_A} `],
    ['长度短一位', '123e4567-e89b-12d3-a456-42661417400'],
    ['长度长一位', '123e4567-e89b-12d3-a456-4266141740000'],
    ['去掉连字符', '123e4567e89b12d3a456426614174000'],
    ['合法 uuid 加垃圾后缀', `${USER_A}-x`],
    ['花括号包裹', `{${USER_A}}`],
  ];
  const codes = new Set();
  const messages = new Set();
  for (const [label, value] of illegal) {
    // 夹具里**放一条别人的 reserved 行**：若实现退回「全局最新 reserved」，本用例会拿到它而打红。
    const { ledger, pool } = build([exportRow({ id: EXPORT_B, user_id: USER_B })]);
    await assert.rejects(
      () => ledger.findReservedByObject({ objectType: 'media', objectId: MEDIA_ID, objectRevision: 1, userId: value }),
      (error) => {
        assert.ok(error instanceof PrivacyError, `${label}：必须是契约错误`);
        assert.equal(error.code, 'SESSION_REQUIRED', `${label}：错误码必须稳定`);
        assert.equal(error.message, '缺少身份上下文', `${label}：文案必须固定且不含入参`);
        assert.equal(error.status, 401, `${label}：HTTP 401`);
        assert.equal(error.retryable, false, `${label}：不标可重试`);
        if (value.length > 0) {
          // 消息与整份错误封套都不得回显入参（入参可能夹带用户数据/注入片段）。
          assert.equal(error.message.includes(value), false, `${label}：消息不得含入参`);
          assert.equal(JSON.stringify(toErrorEnvelope(error)).includes(value), false, `${label}：封套不得含入参`);
        }
        codes.add(error.code);
        messages.add(error.message);
        return true;
      },
      `${label}：非法 userId 必须被拒绝`,
    );
    assert.equal(pool.queries.length, 0, `${label}：拒绝必须发生在任何查询之前（不得退回全局最新 reserved 行）`);
  }
  assert.equal(codes.size, 1, '所有非法入参的错误码必须完全一致');
  assert.equal(messages.size, 1, '所有非法入参的文案必须完全一致');
});

test('媒体维对照：同 object 另一属主有**更新的** reserved ⇒ 只命中自己的行；无行 ⇒ null（且仍带属主过滤）', async () => {
  // B 的行更晚（created_at 更新）：改前的「不带属主过滤」查询会先命中它。
  const rows = [
    exportRow({ id: EXPORT_A, user_id: USER_A, created_at: '2026-01-01T00:00:00.000Z' }),
    exportRow({ id: EXPORT_B, user_id: USER_B, created_at: '2026-01-01T00:00:05.000Z' }),
  ];
  const { ledger, pool } = build(rows);

  const forA = await ledger.findReservedByObject({ objectType: 'media', objectId: MEDIA_ID, objectRevision: 1, userId: USER_A });
  assert.ok(forA, 'A 自己有一条 reserved，必须命中');
  assert.equal(forA.id, EXPORT_A, '不得命中 B 的（更新的）预留行');
  assert.equal(forA.userId, USER_A);
  assert.equal(forA.state, 'reserved');
  assert.match(pool.queries[0].text, /AND user_id=\$4::uuid/, 'SQL 必须带属主过滤');
  assert.deepEqual(pool.queries[0].params, ['media', MEDIA_ID, 1, USER_A]);

  const forB = await ledger.findReservedByObject({ objectType: 'media', objectId: MEDIA_ID, objectRevision: 1, userId: USER_B });
  assert.equal(forB.id, EXPORT_B, 'B 命中自己的行');

  const forC = await ledger.findReservedByObject({ objectType: 'media', objectId: MEDIA_ID, objectRevision: 1, userId: USER_C });
  assert.equal(forC, null, '合法 uuid 但本属主无 reserved ⇒ null（不得借到 A/B 的行）');
  assert.match(pool.queries[2].text, /AND user_id=\$4::uuid/, '未命中也必须真的按属主过滤过');
});

test('非媒体维（object_key）同样按属主过滤：另一属主有更新的 reserved ⇒ 只命中自己的行', async () => {
  const rows = [
    exportRow({
      id: EXPORT_A,
      user_id: USER_A,
      object_type: 'checked_content',
      object_id: SENTINEL,
      object_key: TEXT_KEY,
      required_consents: { external_inference: 1 },
      created_at: '2026-01-01T00:00:00.000Z',
    }),
    exportRow({
      id: EXPORT_B,
      user_id: USER_B,
      object_type: 'checked_content',
      object_id: SENTINEL,
      object_key: TEXT_KEY,
      required_consents: { external_inference: 1 },
      created_at: '2026-01-01T00:00:05.000Z',
    }),
  ];
  const { ledger, pool } = build(rows);

  const hitA = await ledger.findReservedByObject({ objectType: 'checked_content', objectKey: TEXT_KEY, objectRevision: 1, userId: USER_A });
  assert.equal(hitA.id, EXPORT_A, '文本键维度同样只命中自己属主的行');
  assert.equal(hitA.objectId, TEXT_KEY, '非媒体维的 objectId 投影为文本键');
  assert.match(pool.queries[0].text, /object_key=\$2/, '文本键维度走 object_key 列');
  assert.deepEqual(pool.queries[0].params, ['checked_content', TEXT_KEY, 1, USER_A]);

  const missB = await ledger.findReservedByObject({ objectType: 'checked_content', objectKey: 'checked_content-9999', objectRevision: 1, userId: USER_A });
  assert.equal(missB, null, '同属主但对象键未命中 ⇒ null');
});

test('未提供 userId：既有语义逐字不变（不带属主过滤、参数 3 个、返回最新 reserved 行）', async () => {
  const rows = [
    exportRow({ id: EXPORT_A, user_id: USER_A, created_at: '2026-01-01T00:00:00.000Z' }),
    exportRow({ id: EXPORT_B, user_id: USER_B, created_at: '2026-01-01T00:00:05.000Z' }),
  ];
  const { ledger, pool } = build(rows);

  const newest = await ledger.findReservedByObject({ objectType: 'media', objectId: MEDIA_ID, objectRevision: 1 });
  assert.equal(newest.id, EXPORT_B, '不传属主时仍是「该对象最新 reserved 行」（媒体维 task-egress 依赖此口径）');
  assert.equal(/user_id=\$4/.test(pool.queries[0].text), false, '不传属主时 SQL 不得出现属主过滤');
  assert.deepEqual(pool.queries[0].params, ['media', MEDIA_ID, 1], '不传属主时参数仍只有 3 个');

  // 维度非法仍然逐字 `return null`（既有口径，不受本次收紧影响）。
  const badId = await ledger.findReservedByObject({ objectType: 'media', objectId: 'not-a-uuid', objectRevision: 1, userId: USER_A });
  assert.equal(badId, null);
  assert.equal(pool.queries.length, 1, '对象标识非法时不得发查询');
});
