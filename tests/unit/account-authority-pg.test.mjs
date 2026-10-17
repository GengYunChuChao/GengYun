/**
 * GY-I22（#22）· 账号停用/恢复 PG 适配层单元回归（**只新增**，不改任何既有断言）。
 *
 * 真库读数（迁移三连 / A–F / 最小权限）由 `tests/integration/account-suspend-pg.mjs` 在隔离
 * PG 17.11 集群上取得（见交接）。本文件钉住**不依赖数据库**就能核对的部分：
 *  1. 事务边界逐条：`BEGIN` → `SET LOCAL lock_timeout='4s'` → **唯一一条** `SELECT public.suspend_account(...)`
 *     → `COMMIT` → `release()`；参数顺序固定 `[actor, audit, user, expectedRevision, requestId]`；
 *  2. 任何失败都 `ROLLBACK` 后 `release()`（不留租借连接、不半途提交）；
 *  3. G 码映射到**既有**契约码（G0001/2/3/4、57014/55P03、42501/42883），⛔ 不新增错误码；
 *  4. 无事务能力 / 参数非法时**在开事务之前**失败关闭，且一条语句都不发；
 *  5. 函数返回形状不符 ⇒ `PROVIDER_UNAVAILABLE`（不把读不懂的返回当成功）；
 *  6. 幂等返回（`changed=false`、`audit_id=null`、`revoked_sessions=0`）如实透传，不被误判成失败；
 *  7. `restore` 走 `public.restore_account`，与 `suspend` 同参同序（恢复＝反向，同一事务形状）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SUSPEND_ACCOUNT_FUNCTION,
  RESTORE_ACCOUNT_FUNCTION,
  createPostgresAccountAuthority,
} from '../../services/api/src/admin/ops/account-authority-pg.ts';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const AUDIT = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const REQUEST = '44444444-4444-4444-8444-444444444444';

const ACTION = {
  actorId: ACTOR,
  auditId: AUDIT,
  userId: USER,
  expectedRevision: 3,
  requestId: REQUEST,
};

/** 函数返回的 `result` jsonb 成功形状（值的类型刻意混用 string/number：真库 bigint 以字符串回来）。 */
function outcomeResult(overrides = {}) {
  return {
    id: USER,
    state: 'suspended',
    revision: 4,
    auth_epoch: 2,
    display_name: '耕云用户A1B2',
    revoked_sessions: '1',
    changed: true,
    audit_id: AUDIT,
    ...overrides,
  };
}

/**
 * 记录型假池：按发生顺序记下每条语句；`onSelect(text)` 提供 `SELECT … AS result` 的 result 值
 * （抛错即模拟数据库报错）。非 SELECT 一律返回空行集。`connect()` 被调用次数单独计数，
 * 用来证明"参数非法时根本不开连接"。
 */
function recordingPool(onSelect) {
  const statements = [];
  let connects = 0;
  const pool = {
    async connect() {
      connects += 1;
      return {
        async query(text, values) {
          statements.push({ text, values });
          if (!text.startsWith('SELECT')) return { rows: [] };
          return { rows: [{ result: await onSelect(text) }] };
        },
        release() {
          statements.push({ text: '<release>' });
        },
      };
    },
  };
  return { pool, statements, connects: () => connects };
}

/** 断言：语句序列正是 BEGIN / lock_timeout / 函数调用 / COMMIT / release。 */
function expectTransactionShape(statements, functionName) {
  assert.equal(
    statements.length,
    5,
    `应恰好 5 条语句（含 release），实际 ${statements.length}：${statements.map((s) => s.text).join(' ; ')}`,
  );
  assert.equal(statements[0].text, 'BEGIN');
  assert.equal(statements[1].text, "SET LOCAL lock_timeout = '4s'");
  assert.ok(
    statements[2].text.startsWith(`SELECT ${functionName}(`),
    `第 3 条必须是函数调用，实际 ${statements[2].text}`,
  );
  assert.equal(statements[2].values.length, 5);
  assert.equal(statements[3].text, 'COMMIT');
  assert.equal(statements[4].text, '<release>');
}

test('停用：单事务五条语句 + 参数顺序固定 + 返回值按字段类型映射', async () => {
  const { pool, statements } = recordingPool(() => outcomeResult());
  const authority = createPostgresAccountAuthority({ pool });

  const outcome = await authority.suspend(ACTION);

  expectTransactionShape(statements, SUSPEND_ACCOUNT_FUNCTION);
  assert.deepEqual(statements[2].values, [ACTOR, AUDIT, USER, 3, REQUEST]);
  assert.equal(outcome.changed, true);
  assert.equal(outcome.authEpoch, 2, 'bigint 字符串必须被转成数字');
  assert.equal(outcome.revokedSessions, 1, 'ROW_COUNT 字符串必须被转成数字');
  assert.deepEqual(outcome.account, {
    id: USER,
    revision: 4,
    state: 'suspended',
    display_name: '耕云用户A1B2',
  });
});

test('停用：数据库错误码逐条映射到既有契约码，且每次失败都 ROLLBACK 后 release', async () => {
  const cases = [
    ['G0001', 'INVALID_REQUEST', 400, false],
    ['G0002', 'NOT_FOUND', 404, false],
    ['G0003', 'REVISION_CONFLICT', 409, false],
    ['G0004', 'OBJECT_UNAVAILABLE', 409, false],
    ['57014', 'PROVIDER_TIMEOUT', 504, true],
    ['55P03', 'PROVIDER_TIMEOUT', 504, true],
    ['42501', 'PROVIDER_UNAVAILABLE', 503, false],
    ['42883', 'PROVIDER_UNAVAILABLE', 503, false],
    ['23505', 'PROVIDER_UNAVAILABLE', 503, false],
    ['XX000', 'PROVIDER_UNAVAILABLE', 503, false],
  ];
  for (const [sqlState, code, status, retryable] of cases) {
    const { pool, statements } = recordingPool(() => {
      throw Object.assign(new Error(`synthetic ${sqlState}`), { code: sqlState });
    });
    const authority = createPostgresAccountAuthority({ pool });
    await assert.rejects(
      () => authority.suspend(ACTION),
      (error) => {
        assert.equal(error.code, code, `${sqlState} 应映射 ${code}`);
        assert.equal(error.status, status, `${sqlState} HTTP 状态`);
        assert.equal(error.retryable, retryable, `${sqlState} retryable`);
        return true;
      },
    );
    const tail = statements.map((s) => s.text).slice(-2);
    assert.deepEqual(tail, ['ROLLBACK', '<release>'], `${sqlState} 必须 ROLLBACK 再 release`);
  }
});

test('无事务能力：一条语句都不发就失败关闭（retryable=false），绝不假装成功', async () => {
  const { pool } = recordingPool(() => outcomeResult());
  const authority = createPostgresAccountAuthority({ pool: { query: pool.query } });
  await assert.rejects(
    () => authority.suspend(ACTION),
    (error) => {
      assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
      assert.equal(error.retryable, false);
      return true;
    },
  );
});

test('参数校验先于开事务：非法 uuid / 非法 expectedRevision ⇒ INVALID_REQUEST 且零连接', async () => {
  const { pool, statements, connects } = recordingPool(() => outcomeResult());
  const authority = createPostgresAccountAuthority({ pool });

  for (const bad of [
    { ...ACTION, userId: 'not-a-uuid' },
    { ...ACTION, actorId: '' },
    { ...ACTION, auditId: 'x' },
    { ...ACTION, requestId: 'not-a-uuid' },
    { ...ACTION, expectedRevision: 0 },
    { ...ACTION, expectedRevision: 1.5 },
  ]) {
    await assert.rejects(
      () => authority.suspend(bad),
      (error) => {
        assert.equal(error.code, 'INVALID_REQUEST');
        return true;
      },
    );
  }
  assert.equal(connects(), 0, '参数非法时不得从池里取连接');
  assert.equal(statements.length, 0);
});

test('返回形状不符 ⇒ PROVIDER_UNAVAILABLE（事务已提交，不在解析阶段再发 ROLLBACK）', async () => {
  const broken = [
    null,
    [],
    { ...outcomeResult(), state: 'deleted' },
    { ...outcomeResult(), display_name: undefined },
    { ...outcomeResult(), changed: 'yes' },
    { ...outcomeResult(), revision: 'abc' },
    { ...outcomeResult(), audit_id: 42 },
  ];
  for (const result of broken) {
    const { pool, statements } = recordingPool(() => result);
    const authority = createPostgresAccountAuthority({ pool });
    await assert.rejects(
      () => authority.suspend(ACTION),
      (error) => {
        assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
        assert.equal(error.retryable, true);
        return true;
      },
    );
    assert.equal(statements.filter((s) => s.text === 'ROLLBACK').length, 0, '解析失败不得再回滚已提交事务');
    assert.equal(statements.at(-1).text, '<release>');
  }
});

test('幂等重放（changed=false / audit_id=null / revoked_sessions=0）如实透传，不当失败', async () => {
  const { pool } = recordingPool(() =>
    outcomeResult({ changed: false, audit_id: null, revoked_sessions: 0, revision: 4, auth_epoch: 2 }),
  );
  const authority = createPostgresAccountAuthority({ pool });
  const outcome = await authority.suspend(ACTION);
  assert.equal(outcome.changed, false);
  assert.equal(outcome.auditId, null);
  assert.equal(outcome.revokedSessions, 0);
  assert.equal(outcome.account.state, 'suspended');
});

test('恢复：走 restore_account，与停用同参同序（反向仍是同一事务形状）', async () => {
  const { pool, statements } = recordingPool(() =>
    outcomeResult({ state: 'active', revision: 5, auth_epoch: 3, revoked_sessions: 0, audit_id: null }),
  );
  const authority = createPostgresAccountAuthority({ pool });
  const outcome = await authority.restore(ACTION);

  expectTransactionShape(statements, RESTORE_ACCOUNT_FUNCTION);
  assert.deepEqual(statements[2].values, [ACTOR, AUDIT, USER, 3, REQUEST]);
  assert.equal(outcome.account.state, 'active');
  assert.equal(outcome.authEpoch, 3);
});

test('两个函数常量与迁移里的精确签名逐字一致（改名必须同时改 90-assert）', () => {
  assert.equal(SUSPEND_ACCOUNT_FUNCTION, 'public.suspend_account');
  assert.equal(RESTORE_ACCOUNT_FUNCTION, 'public.restore_account');
});
