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
 * 12. 就绪探测 `featureFlagsTableReady`：只有 `to_regclass(...) IS NOT NULL` 严格为 `true` 才就绪，
 *    缺表/形状不符/抛错/没有池一律 `false`（子集迁移库里没有 0020 的表）；
 * 13. `armingProbe`：false 或抛错 ⇒ 门**永久降级未武装**且**不预取**（不把探测错误变成用户面 503）；
 *    true ⇒ 保持武装、探测只跑一次而预取逐次刷新。
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
} from '../../services/api/src/admin/ops/flags-pg.ts';
import {
  createFeatureFlagGate,
  createFlagGatedGuards,
  createPortFlagReader,
} from '../../services/api/src/admin/ops/flag-gate.ts';
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
  };
  const port = {
    persistent: true,
    async list() {
      state.listCalls += 1;
      if (state.failList) throw new Error('connection reset');
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

test('端口读取抛错 ⇒ 503 PROVIDER_UNAVAILABLE（可重试，读面幂等）', async () => {
  const { state, port } = fakePort();
  state.failList = true;
  const { service } = harness(port);

  await assert.rejects(service.listFlags(opsContext()), (error) => {
    assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(error.retryable, true);
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

// ---------------------------------------------------------------- 就绪探测与武装降级（T-R12-08R）

test('featureFlagsTableReady：只有 to_regclass 严格为 true 才就绪；缺表/形状不符/抛错/无池一律 false', async () => {
  const seen = [];
  const readyPool = {
    query: async (text) => {
      seen.push(text);
      return { rows: [{ ready: true }] };
    },
  };
  assert.equal(await featureFlagsTableReady(readyPool), true);
  assert.match(seen[0], /to_regclass\('public\.feature_flags'\) IS NOT NULL AS ready/, '探测必须是这一条只读 SQL');

  const missingTable = { query: async () => ({ rows: [{ ready: false }] }) };
  assert.equal(await featureFlagsTableReady(missingTable), false, '表不存在（to_regclass IS NULL）⇒ 未就绪');

  const oddShape = { query: async () => ({ rows: [] }) };
  assert.equal(await featureFlagsTableReady(oddShape), false, '形状不符不得被当成就绪');

  const denied = {
    query: async () => {
      const failure = new Error('permission denied for schema public');
      failure.code = '42501';
      throw failure;
    },
  };
  assert.equal(await featureFlagsTableReady(denied), false, '探测抛错（42501/连接失败）必须降级 false，不得抛给调用方');

  assert.equal(await featureFlagsTableReady(null), false);
  assert.equal(await featureFlagsTableReady({}), false, '没有 query 能力的池一律未就绪');
});

test('armingProbe=false ⇒ 门永久降级未武装：不预取、不判、不 503（子集迁移库场景）', async () => {
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

test('armingProbe 抛错（42501/连接失败）⇒ 同样降级未武装，且错误只吞在门内', async () => {
  const { state, port } = fakePort();
  const reader = createPortFlagReader(port);
  let refreshes = 0;
  const gate = createFeatureFlagGate({
    reader,
    armed: true,
    armingProbe: async () => {
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
  assert.equal(gate.armed, false);
  assert.equal(refreshes, 0);
  assert.equal(state.listCalls, 0);
  const verdict = gate.verdictFor('specific_herbicide_output_enabled', 'GET /api/v1/herbicides');
  assert.equal(verdict.state, 'open');
  assert.equal(verdict.decidedBy, 'unavailable');
  assert.doesNotThrow(() => gate.assertSurfaceOpen('GET', '/api/v1/herbicides'));
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
