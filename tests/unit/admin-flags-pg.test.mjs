/**
 * GY-I18（#18）· 开关持久化（PG 端口）**单元测试**：用假端口钉住服务层接线口径。
 *
 * 覆盖（对应派单 §2.4 与裁定 §4 的可离线验证部分）：
 * 1. `listFlags` 有端口 ⇒ 从端口读、按契约声明序返回（与端口返回顺序无关）；
 * 2. `setFlag` 正确 If-Match ⇒ 端口完成 CAS，服务层回传 `changedBy/reason/requestId`，
 *    revision 递增、ETag 同步；内存审计文本保持既有口径（既有单测依赖，逐字不变）；
 * 3. `setFlag` revision 不符 ⇒ 409 `REVISION_CONFLICT`，且**不写审计**（读时拦）；
 * 4. 读时 revision 仍匹配、提交时被并发抢走（端口回 `REVISION_CONFLICT`）⇒ 同一个 409，审计零行；
 * 5. 值未变 ⇒ 200 幂等短路，**不调** `commitIfCurrent`、不写审计、revision 不变；
 * 6. 无端口 ⇒ 既有内存 store 路径逐字不变（stub 分支不回归）；
 * 7. 端口缺键 / 形状非法 ⇒ 503 `PROVIDER_UNAVAILABLE`（`FLAG_UNRECOGNIZED`，不可重试），
 *    ⛔ 不返回"三键全 false"的假封套；
 * 8. `createPortFlagReader`：未预取 ⇒ `unrecognized`；读取抛错 ⇒ `read_error` 且**丢弃旧快照**；
 * 9. `createFlagGatedGuards`：只对受控面预取，判定仍是同步的；
 * 10. `flagReasonCode`：理由归一短码（纯中文/空 ⇒ `ADMIN_SET_FLAG`）；
 * 11. 适配层错误映射：`55P03`/`57014` ⇒ 504 `PROVIDER_TIMEOUT`(retryable:true)，`42501` ⇒ 503 对照
 *    （防两类 SQLSTATE 被折叠成一个分支）；
 * 12. 就绪探测 `probeFeatureFlagsTable`：三态 `ready`/`missing`/`unknown`。
 *    `ready` 仅当 `to_regclass(...) IS NOT NULL` **严格为 `true`**；严格 `false` ⇒ `missing`
 *    （子集迁移库里没有 0020 的表）；形状不符/抛错/没有池 ⇒ `unknown`（**不是** `missing`）。
 *    布尔便捷形式 `featureFlagsTableReady` 只有 `ready` 才是 `true`。
 * 13. `armingProbe`：`missing`（含布尔 `false`）⇒ 门**降级未武装**且**不预取**（不把"确认缺表"
 *    变成用户面 503）；`ready`/`true` ⇒ 保持武装、探测只跑一次而预取逐次刷新。
 * 14. **#282 P1 回归**：`armingProbe` **抛错/返回读不懂的形状** ⇒ `unknown`（未知 ≠ 未安装）⇒
 *    门**保持武装**、仍然刷新并按库判定（`false` 继续阻断），且下一次判前**重探**；
 *    ⛔ 绝不退回 `armed=false` + `verdict=open`（那是永久 fail-open，本片要修的缺陷）。
 * 15. **关键路径**：首次探测异常、之后恢复、库里真实开关仍关闭 ⇒ 受控面仍被阻断，
 *    且断言恢复后**确实重新探测 + 重新读库**。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdminOpsService } from '../../services/api/src/admin/ops/service.ts';
import { createAdminOpsStore } from '../../services/api/src/admin/ops/store.ts';
import { CONTRACT_FLAG_KEYS } from '../../services/api/src/admin/ops/flags.ts';
import {
  DEFAULT_FLAG_REASON_CODE,
  createPostgresFeatureFlags,
  featureFlagsTableReady,
  flagReasonCode,
  probeFeatureFlagsTable,
} from '../../services/api/src/admin/ops/flags-pg.ts';
import {
  createFeatureFlagGate,
  createFlagGatedGuards,
  createPortFlagReader,
} from '../../services/api/src/admin/ops/flag-gate.ts';
import { buildApp } from '../../services/api/src/app.ts';
import { ApiError } from '../../services/api/src/errors.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';
import {
  ADMIN_USER_ID,
  OPS_SIGNING_KEY,
  makeUuid,
  opsContext,
  opsKey,
} from './admin-ops-fixtures.mjs';

/** 三个契约键的初始状态：全 false、revision=1（与迁移 0020 的种子一致）。 */
function seedRows() {
  return CONTRACT_FLAG_KEYS.map((key) => ({ key, enabled: false, revision: 1 }));
}

/**
 * 假端口：行为与 `createPostgresFeatureFlags` 的可观察契约一致（CAS + 失败原因），
 * 但把每次调用记下来，供断言"服务层到底把什么交给了端口"。
 */
function fakePort(initialRows = seedRows()) {
  const state = {
    rows: initialRows.map((row) => ({ ...row })),
    listCalls: 0,
    getCalls: 0,
    commits: [],
    /** 为真时，`commitIfCurrent` 一律返回 revision 冲突（模拟读后写前被并发抢走）。 */
    forceConflict: false,
    /** 为真时，`list()` 抛错（模拟库暂时不可用）。 */
    failList: false,
    /** `failList` 为真时抛出的错误所带 SQLSTATE/驱动码；缺省 `null` = 无 code 的「无法归类」错误。 */
    failCode: null,
  };
  const port = {
    persistent: true,
    async list() {
      state.listCalls += 1;
      if (state.failList) {
        const failure = new Error('connection reset');
        if (state.failCode !== null) failure.code = state.failCode;
        throw failure;
      }
      return state.rows.map((row) => ({ ...row }));
    },
    async get(key) {
      state.getCalls += 1;
      return state.rows.find((row) => row.key === key) ?? null;
    },
    async commitIfCurrent(key, expectedRevision, patch, meta) {
      state.commits.push({
        key,
        expectedRevision,
        patch: { ...patch },
        meta: { ...meta },
      });
      if (state.forceConflict) return { ok: false, reason: 'REVISION_CONFLICT' };
      const row = state.rows.find((entry) => entry.key === key);
      if (row === undefined) return { ok: false, reason: 'NOT_FOUND' };
      if (row.revision !== expectedRevision) return { ok: false, reason: 'REVISION_CONFLICT' };
      if (row.enabled !== patch.enabled) {
        row.enabled = patch.enabled;
        row.revision += 1;
      }
      return { ok: true, record: { ...row } };
    },
  };
  return { state, port };
}

function harness(port) {
  const store = createAdminOpsStore();
  const service = createAdminOpsService({
    store,
    signingKey: OPS_SIGNING_KEY,
    executionMode: 'real',
    ...(port === undefined ? {} : { flagsPort: port }),
  });
  return { store, service };
}

test('listFlags：有端口 ⇒ 从端口读，按契约声明序返回，不落内存审计', async () => {
  const { state, port } = fakePort([...seedRows()].reverse());
  const { service, store } = harness(port);

  const response = await service.listFlags(opsContext());

  assert.equal(response.status, 200);
  assert.deepEqual(
    response.body.data.items.map((flag) => flag.key),
    [...CONTRACT_FLAG_KEYS],
    '顺序必须按 CONTRACT_FLAG_KEYS 声明序，而不是端口返回顺序',
  );
  for (const flag of response.body.data.items) {
    assert.equal(flag.enabled, false);
    assert.equal(flag.revision, 1);
  }
  assert.equal(state.listCalls, 1, '三行应一次读出（不逐键 N+1）');
  assert.equal(store.audit.list().length, 0, '只读不得写审计');
  assert.equal(response.headers['Cache-Control'], 'no-store');
});

test('setFlag：正确 If-Match ⇒ 端口 CAS，changedBy/reason/requestId 原样传入，revision+1', async () => {
  const { state, port } = fakePort();
  const { service, store } = harness(port);
  const requestId = makeUuid(4242);

  const response = await service.setFlag(
    { ...opsContext(), requestId, idempotencyKey: opsKey('pgf'), ifMatch: '"1"' },
    'specific_herbicide_output_enabled',
    { enabled: true, reason: '比赛演示需要展示药剂输出' },
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.data.enabled, true);
  assert.equal(response.body.data.revision, 2);
  assert.equal(response.headers['ETag'], '"2"');
  assert.equal(state.commits.length, 1);
  assert.equal(state.commits[0].key, 'specific_herbicide_output_enabled');
  assert.equal(state.commits[0].expectedRevision, 1);
  assert.deepEqual(state.commits[0].patch, { enabled: true });
  assert.equal(state.commits[0].meta.changedBy, ADMIN_USER_ID);
  assert.equal(state.commits[0].meta.reason, '比赛演示需要展示药剂输出');
  assert.equal(state.commits[0].meta.requestId, requestId, '请求 id 必须进审计行');

  // 内存台账文本保持既有口径（`tests/unit/admin-ops-operations.test.mjs` 依赖，逐字不变）。
  const audit = store.audit.list();
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, 'flag.set');
  assert.equal(audit[0].scope, 'flags:write');
  assert.equal(audit[0].target_ref, null);
  assert.equal(audit[0].target_hint, 'flag:specific_herbicide_output_enabled');
  assert.equal(audit[0].result, 'accepted');
});

test('setFlag：If-Match 与当前 revision 不符 ⇒ 409 REVISION_CONFLICT，不调 commit、不写审计', async () => {
  const { state, port } = fakePort([
    { key: 'submissions_enabled', enabled: false, revision: 3 },
    { key: 'specific_herbicide_output_enabled', enabled: false, revision: 1 },
    { key: 'ai_enabled', enabled: false, revision: 1 },
  ]);
  const { service, store } = harness(port);

  await assert.rejects(
    service.setFlag(
      { ...opsContext(), idempotencyKey: opsKey('pgc'), ifMatch: '"1"' },
      'submissions_enabled',
      { enabled: true, reason: '示例：陈旧修订' },
    ),
    (error) => error.code === 'REVISION_CONFLICT',
  );
  assert.equal(state.commits.length, 0, '修订不符必须在提交前拦下');
  assert.equal(store.audit.list().length, 0, '失败不得写审计');
});

test('setFlag：读后写前被并发抢走（端口回 REVISION_CONFLICT）⇒ 409，审计零行', async () => {
  const { state, port } = fakePort();
  state.forceConflict = true;
  const { service, store } = harness(port);

  await assert.rejects(
    service.setFlag(
      { ...opsContext(), idempotencyKey: opsKey('pgr'), ifMatch: '"1"' },
      'ai_enabled',
      { enabled: true, reason: '示例：并发' },
    ),
    (error) => error.code === 'REVISION_CONFLICT',
  );
  assert.equal(state.commits.length, 1, '端口必须被调用一次（冲突由库端判定）');
  assert.equal(store.audit.list().length, 0, '冲突不得记"accepted"审计');
});

test('setFlag：值未变 ⇒ 200 幂等短路，不调 commit、不写审计、revision 不变', async () => {
  const { state, port } = fakePort();
  const { service, store } = harness(port);

  const response = await service.setFlag(
    { ...opsContext(), idempotencyKey: opsKey('pgi'), ifMatch: '"1"' },
    'ai_enabled',
    { enabled: false, reason: '示例：重复设置同值' },
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.data.revision, 1);
  assert.equal(response.headers['ETag'], '"1"');
  assert.equal(state.commits.length, 0, '值未变不得进入写事务');
  assert.equal(store.audit.list().length, 0, '值未变不得写审计');
});

test('无端口（stub 分支）：内存 store 路径逐字不变', async () => {
  const { service, store } = harness(undefined);

  const initial = await service.listFlags(opsContext());
  assert.equal(initial.body.data.items.length, 3);
  assert.deepEqual(
    initial.body.data.items.map((flag) => flag.enabled),
    [false, false, false],
  );

  const written = await service.setFlag(
    { ...opsContext(), idempotencyKey: opsKey('mem'), ifMatch: '"1"' },
    'ai_enabled',
    { enabled: true, reason: '示例：内存分支' },
  );
  assert.equal(written.body.data.revision, 2);
  assert.equal(store.listFlags().find((flag) => flag.key === 'ai_enabled').enabled, true);
  assert.equal(store.audit.list().length, 1, '内存分支仍写既有审计');
});

test('端口缺键 ⇒ 503 PROVIDER_UNAVAILABLE（FLAG_UNRECOGNIZED），不伪造三键全 false', async () => {
  const { port } = fakePort(seedRows().slice(0, 2));
  const { service } = harness(port);

  await assert.rejects(service.listFlags(opsContext()), (error) => {
    assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(error.status, 503);
    assert.equal(error.retryable, false, '缺行是数据/配置事故，重试不会成功');
    assert.deepEqual(error.details, [{ field: 'flags', code: 'FLAG_UNRECOGNIZED' }]);
    return true;
  });
});

test('端口读取抛 ECONNRESET（连接层抖动）⇒ 503 PROVIDER_UNAVAILABLE（可重试，读面幂等）', async () => {
  const { state, port } = fakePort();
  state.failList = true;
  state.failCode = 'ECONNRESET';
  const { service } = harness(port);

  await assert.rejects(service.listFlags(opsContext()), (error) => {
    assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(error.status, 503);
    assert.equal(error.retryable, true, '连接被掐是同一请求重试可能成功的瞬时故障');
    assert.deepEqual(error.details, [
      { field: 'flags', code: 'FLAG_READ_FAILED' },
      { field: 'db_error_code', code: 'ECONNRESET' },
    ]);
    return true;
  });
});

test('端口读取抛无 code 的无法归类错误 ⇒ 503 但 retryable:false（fail-closed）', async () => {
  const { state, port } = fakePort();
  state.failList = true;
  const { service } = harness(port);

  await assert.rejects(service.listFlags(opsContext()), (error) => {
    assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(error.status, 503);
    assert.equal(error.retryable, false, '无法归类 ⇒ 默认不可重试；缺 code 不等于瞬时态');
    assert.deepEqual(error.details, [{ field: 'flags', code: 'FLAG_READ_FAILED' }]);
    return true;
  });
});

test('端口读取抛 42703（列缺失）⇒ 503 且 retryable:false，原始 SQLSTATE 留在 details', async () => {
  const { state, port } = fakePort();
  state.failList = true;
  state.failCode = '42703';
  const { service } = harness(port);

  await assert.rejects(service.listFlags(opsContext()), (error) => {
    assert.equal(error.status, 503);
    assert.equal(error.retryable, false, '库结构与代码不一致，重试永远不会成功');
    assert.deepEqual(error.details, [
      { field: 'flags', code: 'FLAG_READ_FAILED' },
      { field: 'db_error_code', code: '42703' },
    ]);
    return true;
  });
});

test('createPortFlagReader：未预取 ⇒ unrecognized；抛错 ⇒ read_error 且丢弃旧快照', async () => {
  let fail = false;
  const reader = createPortFlagReader({
    async list() {
      if (fail) throw new Error('connection reset');
      return seedRows();
    },
  });

  assert.deepEqual(reader.readWithCause('ai_enabled'), { kind: 'fail', cause: 'unrecognized' });
  assert.equal(reader.read('ai_enabled'), null);

  await reader.refresh();
  assert.equal(reader.read('ai_enabled').enabled, false);
  assert.equal(reader.valueOf('ai_enabled'), false);

  fail = true;
  await reader.refresh();
  assert.equal(reader.read('ai_enabled'), null, '库不可用时不得拿旧快照放行');
  assert.deepEqual(reader.readWithCause('ai_enabled'), { kind: 'fail', cause: 'read_error' });
});

test('createFlagGatedGuards：只对受控面预取；判定保持同步可用', async () => {
  let refreshes = 0;
  const { state, port } = fakePort([
    { key: 'submissions_enabled', enabled: false, revision: 1 },
    { key: 'specific_herbicide_output_enabled', enabled: true, revision: 2 },
    { key: 'ai_enabled', enabled: false, revision: 1 },
  ]);
  const reader = createPortFlagReader(port);
  const gate = createFeatureFlagGate({
    reader,
    armed: true,
    prepare: async () => {
      refreshes += 1;
      await reader.refresh();
    },
  });
  const guards = createFlagGatedGuards(
    {
      async requireUser() {},
      async requireAdmin() {},
      requireScope: () => async () => {},
    },
    gate,
  );

  await guards.requireUser({ method: 'GET', routeOptions: { url: '/api/v1/herbicides' } }, {});
  assert.equal(refreshes, 1, '受控面必须先预取再判定');
  // 同步判定仍是同步的（既有单测直接同步调用 `assertSurfaceOpen`）。
  assert.doesNotThrow(() => gate.assertSurfaceOpen('GET', '/api/v1/herbicides'));

  await guards.requireUser({ method: 'GET', routeOptions: { url: '/api/v1/not-gated' } }, {});
  assert.equal(refreshes, 1, '非受控面不得多打一次数据库');

  // 关掉开关后再预取 ⇒ 受控面必须 409 拒绝（库是唯一权威，不读旧快照）。
  state.rows.find((row) => row.key === 'specific_herbicide_output_enabled').enabled = false;
  await assert.rejects(
    guards.requireUser({ method: 'GET', routeOptions: { url: '/api/v1/herbicides' } }, {}),
    (error) => error.code === 'OBJECT_UNAVAILABLE',
  );
  assert.equal(refreshes, 2);
});

test('flagReasonCode：归一短码，纯中文/空理由回落到 ADMIN_SET_FLAG', () => {
  assert.equal(flagReasonCode('demo toggle for match'), 'DEMO_TOGGLE_FOR_MATCH');
  assert.equal(flagReasonCode('打开开关'), DEFAULT_FLAG_REASON_CODE);
  assert.equal(flagReasonCode(''), DEFAULT_FLAG_REASON_CODE);
  assert.equal(flagReasonCode(null), DEFAULT_FLAG_REASON_CODE);
  assert.equal(flagReasonCode('_weird__start'), 'WEIRD_START');
});

/**
 * 写面 stub pool：BEGIN / `SET LOCAL lock_timeout` 正常返回，**唯一一条函数调用**抛指定 SQLSTATE。
 * 用来钉住 `mapFlagWriteError` 的分支——不同 SQLSTATE 绝不能折叠成同一个 503。
 */
function stubWritePool(sqlState) {
  const calls = [];
  const client = {
    async query(text) {
      calls.push(text);
      if (typeof text === 'string' && text.includes('set_feature_flag')) {
        const failure = new Error(`synthetic ${sqlState}`);
        failure.code = sqlState;
        throw failure;
      }
      return { rows: [] };
    },
    release() {
      calls.push('release');
    },
  };
  return { calls, pool: { connect: async () => client } };
}

const stubCommitOptions = () => ({ changedBy: ADMIN_USER_ID, reason: 'synthetic mapping probe' });

test('55P03/57014 ⇒ 504 PROVIDER_TIMEOUT(retryable:true)，不得折叠成 503', async () => {
  for (const sqlState of ['55P03', '57014']) {
    const { calls, pool } = stubWritePool(sqlState);
    const port = createPostgresFeatureFlags({ pool });
    const error = await port
      .commitIfCurrent('ai_enabled', 1, { enabled: true }, stubCommitOptions())
      .then(() => null, (thrown) => thrown);
    assert.notEqual(error, null, `${sqlState} 必须抛出，不得返回成功`);
    assert.equal(error.code, 'PROVIDER_TIMEOUT', `${sqlState}（行锁不可用/语句超时）必须映射 PROVIDER_TIMEOUT`);
    assert.equal(error.status, 504, `${sqlState} 必须是 504`);
    assert.equal(error.retryable, true, `${sqlState} 是同一请求稍后重试可能成功的瞬时故障`);
    assert.notEqual(error.code, 'PROVIDER_UNAVAILABLE', `${sqlState} 不得与 42501 折叠成同一分支`);
    assert.ok(
      calls.some((text) => typeof text === 'string' && text.trim().toUpperCase() === 'ROLLBACK'),
      '失败必须回滚事务',
    );
    assert.ok(calls.includes('release'), '失败必须释放连接');
  }
});

test('42501（权限不足）仍映射 503 PROVIDER_UNAVAILABLE(retryable:false) 的对照支', async () => {
  const { pool } = stubWritePool('42501');
  const port = createPostgresFeatureFlags({ pool });
  const error = await port
    .commitIfCurrent('ai_enabled', 1, { enabled: true }, stubCommitOptions())
    .then(() => null, (thrown) => thrown);
  assert.notEqual(error, null, '42501 必须抛出');
  assert.equal(error.code, 'PROVIDER_UNAVAILABLE', '权限不足是「不可用」而不是「超时」');
  assert.equal(error.status, 503, '42501 必须是 503');
  assert.equal(error.retryable, false, '缺权限重试也不会成功，必须标不可重试');
});

test('读面兜底（mapFlagReadError）：无 code/未知 SQLSTATE ⇒ retryable:false，ECONNRESET ⇒ true', async () => {
  const readFailure = async (code) => {
    const pool = {
      async query() {
        const failure = new Error('read failed');
        if (code !== null) failure.code = code;
        throw failure;
      },
    };
    const port = createPostgresFeatureFlags({ pool });
    const error = await port.list().then(() => null, (thrown) => thrown);
    assert.notEqual(error, null, '读失败必须抛出，不得返回空快照');
    return error;
  };

  const unclassified = await readFailure(null);
  assert.equal(unclassified.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(unclassified.status, 503);
  assert.equal(
    unclassified.retryable,
    false,
    '无法归类的错误必须 fail-closed（与 db/pool.ts 的 isTransientDatabaseError 同口径：无 code ⇒ false）',
  );
  assert.deepEqual(unclassified.details, [{ field: 'flags', code: 'FLAG_READ_FAILED' }]);

  const schemaDrift = await readFailure('42703');
  assert.equal(schemaDrift.retryable, false, '42703（列缺失）是确定性缺陷，重试永远失败');
  assert.deepEqual(schemaDrift.details, [
    { field: 'flags', code: 'FLAG_READ_FAILED' },
    { field: 'db_error_code', code: '42703' },
  ]);

  const transient = await readFailure('ECONNRESET');
  assert.equal(transient.retryable, true, '连接层抖动仍应可重试（不得把瞬时面一起打死）');
  assert.deepEqual(transient.details, [
    { field: 'flags', code: 'FLAG_READ_FAILED' },
    { field: 'db_error_code', code: 'ECONNRESET' },
  ]);
});

// ---------------------------------------------------------------- 就绪探测与武装降级（T-R12-08R）

test('probeFeatureFlagsTable：三态 ready/missing/unknown；只有严格 true 才就绪，异常是 unknown（≠缺表）', async () => {
  const seen = [];
  const readyPool = {
    query: async (text) => {
      seen.push(text);
      return { rows: [{ ready: true }] };
    },
  };
  assert.deepEqual(await probeFeatureFlagsTable(readyPool), { state: 'ready' });
  assert.equal(await featureFlagsTableReady(readyPool), true, '布尔便捷形式：就绪即 true');
  assert.match(seen[0], /to_regclass\('public\.feature_flags'\) IS NOT NULL AS ready/, '探测必须是这一条只读 SQL');

  const missingTable = { query: async () => ({ rows: [{ ready: false }] }) };
  assert.deepEqual(await probeFeatureFlagsTable(missingTable), { state: 'missing' }, '严格 false ⇒ 确认缺表');
  assert.equal(await featureFlagsTableReady(missingTable), false);

  const oddShape = { query: async () => ({ rows: [] }) };
  assert.deepEqual(
    await probeFeatureFlagsTable(oddShape),
    { state: 'unknown', reason: 'unexpected_shape' },
    '形状不符是「未知」，⛔ 不得当成「缺表 ⇒ 可永久未武装」',
  );
  assert.equal(await featureFlagsTableReady(oddShape), false);

  const denied = {
    query: async () => {
      const failure = new Error('permission denied for schema public');
      failure.code = '42501';
      throw failure;
    },
  };
  assert.deepEqual(
    await probeFeatureFlagsTable(denied),
    { state: 'unknown', reason: 'probe_error' },
    '探测抛错（42501/连接失败）必须是 unknown —— 旧实现返回 false（=缺表）正是 #282 的缺陷',
  );
  assert.equal(await featureFlagsTableReady(denied), false, '布尔兼容形式仍不抛');

  assert.deepEqual(await probeFeatureFlagsTable(null), { state: 'unknown', reason: 'no_pool' });
  assert.deepEqual(await probeFeatureFlagsTable({}), { state: 'unknown', reason: 'no_pool' }, '没有 query 能力的池是未知');
});

test('armingProbe=missing（布尔 false）⇒ 门降级未武装：不预取、不判、不 503（确认缺表的子集迁移库场景）', async () => {
  const { state, port } = fakePort();
  const reader = createPortFlagReader(port);
  let refreshes = 0;
  const gate = createFeatureFlagGate({
    reader,
    armed: true,
    armingProbe: async () => false,
    prepare: async () => {
      refreshes += 1;
      await reader.refresh();
    },
  });

  assert.equal(gate.armed, true, '探测前的静态口径仍是武装（real 且已接端口）');
  await gate.prepare();
  assert.equal(gate.armed, false, '探测 false ⇒ 永久未武装');
  assert.equal(refreshes, 0, '表不可用时不得预取（否则预取失败会 503 打红无关面）');
  assert.equal(state.listCalls, 0, '不得为此打库');
  assert.equal(gate.verdictFor('ai_enabled', 'POST /recognitions').state, 'open', '未武装 ⇒ 不判开关');
  assert.doesNotThrow(() => gate.assertSurfaceOpen('POST', '/api/v1/recognitions'));

  await gate.prepare();
  assert.equal(state.listCalls, 0, '再次 prepare 也不得预取');
  assert.equal(refreshes, 0);
});

test('armingProbe 抛错（42501/连接失败）⇒ 未知**不得**退成 open：保持武装、仍刷新、按库关闭值阻断', async () => {
  const { state, port } = fakePort();
  const reader = createPortFlagReader(port);
  let probes = 0;
  let refreshes = 0;
  const gate = createFeatureFlagGate({
    reader,
    armed: true,
    armingProbe: async () => {
      probes += 1;
      const failure = new Error('permission denied for table feature_flags');
      failure.code = '42501';
      throw failure;
    },
    prepare: async () => {
      refreshes += 1;
      await reader.refresh();
    },
  });

  await assert.doesNotReject(() => gate.prepare(), '探测错误绝不能被当成请求错误抛出');

  // ⚠️ 这里曾是缺陷的"成功断言"：`armed=false` + `verdict=open`。修复后必须**反过来**。
  assert.equal(gate.armed, true, '探测异常是「未知」而不是「确认缺表」⇒ 门必须保持武装（旧实现退成 false=永久放行）');
  assert.equal(probes, 1, '首次判前探测一次');
  assert.equal(refreshes, 1, '未知态仍要刷新：库里的真实关闭值必须继续生效');
  assert.equal(state.listCalls, 1, '未知态确实重新读了库，而不是拿"探不了"当放行');

  const verdict = gate.verdictFor('specific_herbicide_output_enabled', 'GET /api/v1/herbicides');
  assert.equal(verdict.state, 'closed', '刷新成功且库里是 false ⇒ 关闭（不是 open）');
  assert.equal(verdict.decidedBy, 'configured');
  assert.equal(verdict.revision, 1);
  assert.throws(
    () => gate.assertSurfaceOpen('GET', '/api/v1/herbicides'),
    (error) => {
      assert.equal(error.code, 'OBJECT_UNAVAILABLE');
      assert.equal(error.status, 409);
      assert.deepEqual(error.details, [{ field: 'feature_flag', code: 'FLAG_CLOSED' }]);
      return true;
    },
    '受控面必须仍被关闭值阻断',
  );

  // `unknown` 是**不可缓存**的结论：异常是瞬时的，下一次判前必须重探。
  await gate.prepare();
  assert.equal(probes, 2, 'unknown 不得缓存：下一次判前必须重新探测');
  assert.equal(state.listCalls, 2, '重探之后照常刷新（逐次重试）');
});

test('armingProbe 抛错且库也读不出来 ⇒ 503 PROVIDER_UNAVAILABLE（fail-closed，可重试），⛔ 不得放行', async () => {
  const { state, port } = fakePort();
  state.failList = true; // 探测与读取同时抖动的极端瞬时态
  const reader = createPortFlagReader(port);
  const gate = createFeatureFlagGate({
    reader,
    armed: true,
    armingProbe: async () => {
      const failure = new Error('connect ECONNRESET');
      failure.code = 'ECONNRESET';
      throw failure;
    },
    prepare: async () => {
      await reader.refresh();
    },
  });

  await gate.prepare();
  assert.equal(gate.armed, true, '未知 ≠ 缺表：门不得降级');
  const verdict = gate.verdictFor('ai_enabled', 'POST /api/v1/recognitions');
  assert.equal(verdict.state, 'fail_closed', '读不出来 ⇒ fail-closed（503），不是 open');
  assert.equal(verdict.cause, 'read_error', '读取抛错是瞬时原因 ⇒ retryable');
  assert.throws(
    () => gate.assertSurfaceOpen('POST', '/api/v1/recognitions'),
    (error) => {
      assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
      assert.equal(error.status, 503);
      assert.equal(error.retryable, true);
      assert.deepEqual(error.details, [{ field: 'feature_flag', code: 'FLAG_UNRECOGNIZED' }]);
      return true;
    },
  );
});

test('createPortFlagReader 预取抛「自述不可重试」的 ApiError（权限/结构类）⇒ fail-closed 且 retryable:false', async () => {
  const reader = createPortFlagReader({
    async list() {
      // flags-pg 的 mapFlagReadError 对 42501/42703/42P01/42883/3D000 就是抛这个（retryable:false）。
      throw new ApiError('PROVIDER_UNAVAILABLE', '全局开关读取暂不可用', { retryable: false });
    },
  });
  const gate = createFeatureFlagGate({
    reader,
    armed: true,
    prepare: async () => {
      await reader.refresh();
    },
  });

  await gate.prepare();
  assert.equal(gate.armed, true, '读不出来 ≠ 缺表：门不得降级');
  const verdict = gate.verdictFor('ai_enabled', 'POST /api/v1/recognitions');
  assert.equal(verdict.state, 'fail_closed');
  assert.equal(
    verdict.cause,
    'read_unretryable',
    '权限/结构类读错必须与存储抖动（read_error）分开，不得让确定性失败继承「可重试」',
  );

  assert.throws(
    () => gate.assertSurfaceOpen('POST', '/api/v1/recognitions'),
    (error) => {
      assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
      assert.equal(error.status, 503, '仍是 503（契约不变）');
      assert.equal(error.retryable, false, '同一请求重试永远不会成功 ⇒ 不得标可重试');
      assert.deepEqual(error.details, [{ field: 'feature_flag', code: 'FLAG_UNRECOGNIZED' }]);
      assert.match(error.message, /读取失败/, '消息仍须给出具体机制（读取失败 + 需运维修复）');
      return true;
    },
  );
});

test('关键路径：首次探测异常 → 恢复后库里真实开关仍关闭 ⇒ 受控面仍被阻断，且恢复后确实重新读取', async () => {
  const { state, port } = fakePort([
    { key: 'submissions_enabled', enabled: true, revision: 1 },
    // 库里真实取值：**关闭**（受控面必须一直被阻断，跨"探测异常 → 恢复"两段）。
    { key: 'specific_herbicide_output_enabled', enabled: false, revision: 3 },
    { key: 'ai_enabled', enabled: true, revision: 1 },
  ]);
  const reader = createPortFlagReader(port);
  let probes = 0;
  let refreshes = 0;
  const gate = createFeatureFlagGate({
    reader,
    armed: true,
    armingProbe: async () => {
      probes += 1;
      if (probes === 1) {
        // 首次：权限/连接抖动 ⇒ unknown（旧实现会把这次异常永久变成 armed=false ⇒ 放行）。
        const failure = new Error('connection reset by peer');
        failure.code = 'ECONNRESET';
        throw failure;
      }
      // 恢复：真实探测函数在表可用时的返回值（三态对象）。
      return probeFeatureFlagsTable({ query: async () => ({ rows: [{ ready: true }] }) });
    },
    prepare: async () => {
      refreshes += 1;
      await reader.refresh();
    },
  });
  const guards = createFlagGatedGuards(
    {
      async requireUser() {},
      async requireAdmin() {},
      requireScope: () => async () => {},
    },
    gate,
  );
  const gatedRequest = { method: 'GET', routeOptions: { url: '/api/v1/herbicides' } };

  // 第 1 次请求（探测异常）：仍按库里的真实关闭值阻断，而不是 200 放行。
  await assert.rejects(
    () => guards.requireUser(gatedRequest, {}),
    (error) => error.code === 'OBJECT_UNAVAILABLE' && error.status === 409,
    '首次探测异常不得让受控面放行',
  );
  assert.equal(gate.armed, true, '异常后门仍是武装的');
  assert.equal(state.listCalls, 1, '异常当次也已经读了库（关闭值照常生效）');

  // 第 2 次请求（探测恢复）：必须重探 + 重新读库，且真实关闭值继续阻断。
  await assert.rejects(
    () => guards.requireUser(gatedRequest, {}),
    (error) => error.code === 'OBJECT_UNAVAILABLE' && error.status === 409,
    '恢复后真实关闭值必须继续阻断受控面',
  );
  assert.equal(probes, 2, '恢复后必须重新探测（unknown 不缓存）');
  assert.equal(refreshes, 2, '恢复后必须重新预取');
  assert.equal(state.listCalls, 2, '断言"恢复后确实重新读取"：库被第二次读到，而不是复用首次快照');
  const verdict = gate.verdictFor('specific_herbicide_output_enabled', 'GET /api/v1/herbicides');
  assert.equal(verdict.state, 'closed');
  assert.equal(verdict.decidedBy, 'configured');
  assert.equal(verdict.revision, 3, '判的是库里最新的真实 revision');

  // 非受控面不因探测/刷新被额外打库（本片不改变非受控面行为）。
  await guards.requireUser({ method: 'GET', routeOptions: { url: '/api/v1/not-gated' } }, {});
  assert.equal(state.listCalls, 2);
});

test('armingProbe=true ⇒ 保持武装并预取；探测只跑一次，预取逐次刷新', async () => {
  const { state, port } = fakePort();
  const reader = createPortFlagReader(port);
  let probes = 0;
  let refreshes = 0;
  const gate = createFeatureFlagGate({
    reader,
    armed: true,
    armingProbe: async () => {
      probes += 1;
      return true;
    },
    prepare: async () => {
      refreshes += 1;
      await reader.refresh();
    },
  });

  await gate.prepare();
  await gate.prepare();
  assert.equal(probes, 1, '就绪探测只跑一次');
  assert.equal(refreshes, 2, '预取必须逐次刷新（存储抖动是瞬时的，不得缓存失败）');
  assert.equal(gate.armed, true);
  assert.equal(state.listCalls, 2);
  const verdict = gate.verdictFor('specific_herbicide_output_enabled', 'GET /api/v1/herbicides');
  // 假端口种子全 false：武装后必须**按库判定**（closed/configured），而不是继续"未接线 ⇒ open"。
  assert.equal(verdict.state, 'closed');
  assert.equal(verdict.decidedBy, 'configured');
  assert.equal(verdict.revision, 1);
});

// ---------------------------------------------------------------- #282 P1 · HTTP 装配层关键路径

test('关键路径（真实装配）：onReady 探测异常 ⇒ /herbicides 仍按库里关闭值 409，且请求路径重探、重读', async () => {
  const base = loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent', SESSION_SIGNING_KEY: 'synthetic-i18-flags-probe-key-0123456789' });
  const config = { ...base, executionMode: 'real', requiresRealCredentials: true, logLevel: 'silent' };
  const store = createMemoryAuthStore();
  const { state, port } = fakePort([
    { key: 'submissions_enabled', enabled: true, revision: 1 },
    // 库里真实取值：关闭（revision 5）。受控面必须一直被它阻断。
    { key: 'specific_herbicide_output_enabled', enabled: false, revision: 5 },
    { key: 'ai_enabled', enabled: true, revision: 1 },
  ]);
  let probes = 0;
  // 真实装配里 `armingProbe` 用的就是 `probeFeatureFlagsTable(pool)`：这里让**池**抛错，
  // 即 #282 的触发条件（连接/权限抖动），而不是注入一个假的探测函数。
  //
  // ⚠ 计数口径（#538 / `Refs #18`）：`ready()` 阶段现在有**两条**就绪探测打同一个池 ——
  // 开关门（`public.feature_flags`）与内容存储（`public.admin_content_*`，见
  // `admin/content-readiness.ts`）。`probes` 只数**开关门**那条（断言口径逐字不变），
  // 内容存储的那条单独记 `contentProbes`，否则两条探针会被混成一个读数。
  let contentProbes = 0;
  const probePool = {
    async query(text) {
      if (typeof text === 'string' && text.includes('public.admin_content_')) {
        contentProbes += 1;
      } else {
        probes += 1;
      }
      const failure = new Error('connection reset by peer');
      failure.code = 'ECONNRESET';
      throw failure;
    },
  };
  const app = buildApp({ config, store, pool: probePool, adminInjection: { flagsPort: port } });
  try {
    await app.ready();
    assert.equal(probes, 1, 'onReady 必须在服务接请求之前探测（不是懒到首个受控面请求）');
    assert.equal(
      contentProbes,
      1,
      '内容存储的就绪探测也在 onReady 跑一次（#538 / Refs #18）；它不得抢占开关门的读数',
    );
    assert.equal(
      app.featureFlagGate.armed,
      true,
      '探测异常是 unknown：已接真实端口的门**不得**降级 —— 旧实现此处 armed=false ⇒ /herbicides 200（永久 fail-open）',
    );

    const token = 'synthetic-i18-flags-probe-error-token';
    const user = await store.createUser('synthetic-i18-flags-probe-error');
    await store.createSession({
      userId: user.id,
      tokenHashHex: hashToken(token),
      authEpoch: user.authEpoch,
      expiresAt: new Date(Date.now() + 3_600_000),
      audience: 'user',
    });

    const first = await app.inject({ method: 'GET', url: '/api/v1/herbicides', headers: { authorization: `Bearer ${token}` } });
    assert.equal(first.statusCode, 409, `探测异常时受控面必须仍被库里的关闭值阻断，实际 ${first.statusCode} ${first.body}`);
    assert.equal(first.json().error.code, 'OBJECT_UNAVAILABLE');
    assert.ok(
      (first.json().error.details ?? []).some((detail) => detail.code === 'FLAG_CLOSED'),
      '409 必须带 FLAG_CLOSED 证据（关闭语义，不是"未接线 ⇒ 放行"）',
    );
    assert.equal(probes, 2, 'unknown 不缓存：请求路径必须重新探测');
    assert.equal(state.listCalls, 2, '异常当次与本次请求各读了一次库（真实关闭值继续生效）');

    // 第二次请求：探测仍异常，门仍不降级、关闭值仍阻断（不是"第二次就放行"）。
    const second = await app.inject({ method: 'GET', url: '/api/v1/herbicides', headers: { authorization: `Bearer ${token}` } });
    assert.equal(second.statusCode, 409);
    assert.equal(app.featureFlagGate.armed, true);
    assert.equal(state.listCalls, 3);
  } finally {
    await app.close();
  }
});
