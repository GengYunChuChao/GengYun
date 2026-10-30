/**
 * `tools/lib/local-env.mjs` 的纯逻辑回归。
 *
 * ⛔ 本文件**不**起 PostgreSQL、**不**起 API、**不**发 HTTP、**不**读环境变量：
 * 端口占用表、迁移输出、密钥值全部由用例注入。真起服务的部分只走手动 smoke
 * （见 `docs/reference/local-env-runbook.md`），不进 CI。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';

import {
  API_PID_SCHEMA,
  DEFAULT_DATABASE,
  DEFAULT_PORTS,
  INSTANCE_FLAG_PREFIX,
  OWNERSHIP,
  OWNERSHIP_CHECKS,
  PORT_MAX_OFFSET,
  REQUIRED_ENDPOINTS,
  ROOT_FLAG_PREFIX,
  SCHEMA_ID,
  SPAWNED_API_STOP,
  START_TIME_TOLERANCE_MS,
  allEndpointsExpected,
  apiStatusLabel,
  applyApiStop,
  assertNoSecretLeaks,
  assertSqlIdentifier,
  assessApiOwnership,
  buildConsentPoliciesCountSql,
  buildCreateDatabaseSql,
  buildDatabaseExistsSql,
  buildDatabaseUrl,
  buildInitdbArgs,
  buildInstanceFlags,
  buildPgStartArgs,
  buildPgStopArgs,
  buildPsqlArgs,
  buildSummary,
  canonicalize,
  classifyMigrateFailure,
  describeHolder,
  describeOwnershipChecks,
  findSecretLeaks,
  keyDescriptor,
  knownBoundaryLines,
  normalizeOccupancy,
  parseApiPidFile,
  parseMigrateOutput,
  planPort,
  planSpawnedApiStop,
  redactConnectionStrings,
  redactSecrets,
  serializeApiPidFile,
  serializeSummary,
} from '../../tools/lib/local-env.mjs';

/** 假的端口占用表：3100 被无关进程占着（本机的真实形状：QQ 桥 `node src/bridge.js`）。 */
const OCCUPIED_3100 = [
  {
    port: 3100,
    pid: 28328,
    name: 'node.exe',
    commandLine: 'node src/bridge.js',
  },
];

// ---------------------------------------------------------------------------
// ① 端口探测与回退策略
// ---------------------------------------------------------------------------

test('端口：首选空闲就用首选，不产生 skipped', () => {
  const decision = planPort({ preferred: DEFAULT_PORTS.api, occupied: OCCUPIED_3100 });
  assert.equal(decision.ok, true);
  assert.equal(decision.port, DEFAULT_PORTS.api);
  assert.deepEqual(decision.skipped, []);
});

test('端口：首选被占 ⇒ 自动换下一个可用号，并点名持有进程（pid/进程名/命令行）', () => {
  const decision = planPort({ preferred: 3100, occupied: OCCUPIED_3100 });
  assert.equal(decision.ok, true);
  assert.equal(decision.port, 3101);
  assert.equal(decision.skipped.length, 1);
  assert.equal(decision.skipped[0].port, 3100);
  assert.equal(decision.skipped[0].holder.pid, 28328);
  assert.equal(decision.skipped[0].holder.name, 'node.exe');
  assert.match(decision.detail, /3100/);
  assert.match(decision.detail, /28328/);
  assert.match(decision.detail, /node src\/bridge\.js/);
});

test('端口：--strict-port 下被占必须失败并点名进程，⛔ 不许换号', () => {
  const decision = planPort({ preferred: 3100, occupied: OCCUPIED_3100, strict: true });
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'PORT_OCCUPIED_STRICT');
  assert.equal(decision.port, 3100);
  assert.equal(decision.holder.pid, 28328);
  assert.match(decision.holder_detail, /pid 28328/);
  assert.match(decision.holder_detail, /node\.exe/);
  assert.match(decision.detail, /--strict-port/);
});

test('端口：连续被占且超出回退上限 ⇒ 明确报「耗尽」，不静默返回被占端口', () => {
  const occupied = Array.from({ length: PORT_MAX_OFFSET + 1 }, (_unused, offset) => ({ port: 5555 + offset, pid: offset + 1 }));
  const decision = planPort({ preferred: 5555, occupied });
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'PORT_RANGE_EXHAUSTED');
  assert.equal(decision.port, null);
  assert.equal(decision.skipped.length, PORT_MAX_OFFSET + 1);
});

test('端口：API 不能选到 PG 已选定的同一个号（reserved 生效）', () => {
  const decision = planPort({ preferred: 5555, occupied: [], reserved: [5555] });
  assert.equal(decision.ok, true);
  assert.equal(decision.port, 5556);
  assert.equal(decision.skipped[0].port, 5555);
});

test('端口：非法端口直接判 INVALID_PORT（⛔ 不夹取、不猜）', () => {
  for (const preferred of [80, 70000, 3111.5, Number.NaN]) {
    const decision = planPort({ preferred });
    assert.equal(decision.ok, false, `preferred=${String(preferred)}`);
    assert.equal(decision.reason, 'INVALID_PORT');
  }
});

test('端口：占用表三种注入形状（数组/普通对象/Map）归一结果一致', () => {
  const entry = { pid: 111, name: 'x.exe', commandLine: 'x --y' };
  const asArray = normalizeOccupancy([{ port: 3100, ...entry }]);
  const asObject = normalizeOccupancy({ 3100: entry });
  const asMap = normalizeOccupancy(new Map([[3100, entry]]));
  assert.deepEqual(asArray.get(3100), { port: 3100, pid: 111, name: 'x.exe', commandLine: 'x --y' });
  assert.deepEqual(asObject.get(3100), asArray.get(3100));
  assert.deepEqual(asMap.get(3100), asArray.get(3100));
  // 缺字段不猜：pid 归一成 null，describeHolder 如实说「未知」。
  assert.equal(normalizeOccupancy([{ port: 3111 }]).get(3111).pid, null);
  assert.match(describeHolder(null), /占用者未知/);
});

test('端口：只有 1 个端口被占时，PowerShell 的 ConvertTo-Json 会退化成单条记录（必须照样读得出持有进程）', () => {
  // 实测形状：`@($rows) | ConvertTo-Json` 在只有一条时输出对象而不是数组。
  const single = normalizeOccupancy({ port: 3100, pid: 28328, name: 'node.exe', commandLine: 'node src/bridge.js' });
  assert.equal(single.size, 1);
  assert.equal(single.get(3100).pid, 28328);
  assert.equal(single.get(3100).name, 'node.exe');
  const decision = planPort({ preferred: 3100, occupied: single, strict: true });
  assert.equal(decision.ok, false);
  assert.match(decision.holder_detail, /pid 28328/);
});

// ---------------------------------------------------------------------------
// ② initdb / pg_ctl / psql 参数拼装
// ---------------------------------------------------------------------------

// 跨平台的绝对路径夹具。⛔ 不写字面量 'C:\\tmp\\pg-data'：在 POSIX 上它不是绝对路径，
// 会被 buildInitdbArgs / buildPgStartArgs 判成相对路径并抛错（本仓口径要求同一份代码
// 在两种分隔符语义下都成立，⛔ 不用 process.platform 分支绕）。
const ABS_TMP = path.resolve(path.sep, 'tmp');
const DATA_DIR = path.join(ABS_TMP, 'pg-data');
const LOG_FILE = path.join(ABS_TMP, 'pg.log');

test('initdb 参数：顺序与取值逐字固定（-U postgres -A trust --locale=C --encoding=UTF8）', () => {
  const args = buildInitdbArgs({ dataDir: DATA_DIR });
  assert.deepEqual(args, [
    '-D',
    DATA_DIR,
    '-U',
    'postgres',
    '-A',
    'trust',
    '--locale=C',
    '--encoding=UTF8',
  ]);
});

test('initdb 参数：相对路径直接抛错（相对路径按进程 cwd 解析，是上一轮的坑）', () => {
  assert.throws(() => buildInitdbArgs({ dataDir: '.local-env/pg-data' }), /绝对路径/);
  assert.throws(() => buildInitdbArgs({ dataDir: '' }), /绝对路径/);
});

test('pg_ctl 参数：start 带 -w/-t 且端口进 -o，stop 用 fast', () => {
  const start = buildPgStartArgs({ dataDir: DATA_DIR, port: 5555, logFile: LOG_FILE, waitSeconds: 60 });
  assert.deepEqual(start, [
    '-D',
    DATA_DIR,
    '-l',
    LOG_FILE,
    '-o',
    '-h 127.0.0.1 -p 5555',
    '-w',
    '-t',
    '60',
    'start',
  ]);
  assert.deepEqual(buildPgStopArgs({ dataDir: DATA_DIR }), [
    '-D',
    DATA_DIR,
    '-m',
    'fast',
    '-w',
    '-t',
    '30',
    'stop',
  ]);
});

test('SQL 拼装：库名过白名单后才允许内联，注入串直接抛错', () => {
  assert.equal(buildCreateDatabaseSql(DEFAULT_DATABASE), `CREATE DATABASE ${DEFAULT_DATABASE}`);
  assert.match(buildDatabaseExistsSql(DEFAULT_DATABASE), /datname = 'gengyun'/);
  assert.equal(buildConsentPoliciesCountSql(), 'SELECT count(*) FROM consent_policies');
  assert.throws(() => assertSqlIdentifier("gengyun'; DROP TABLE users; --", 'database'), /标识符/);
  assert.throws(() => buildCreateDatabaseSql('GengYun'), /标识符/);
});

test('连接串与 psql 参数：回环 + trust（不带口令），ON_ERROR_STOP 就位', () => {
  assert.equal(
    buildDatabaseUrl({ port: 5555, database: DEFAULT_DATABASE }),
    'postgres://postgres@127.0.0.1:5555/gengyun',
  );
  const args = buildPsqlArgs({ port: 5555, sql: 'SELECT 1' });
  assert.deepEqual(args.slice(0, 2), ['-v', 'ON_ERROR_STOP=1']);
  assert.ok(args.includes('-tA'));
  assert.equal(args[args.indexOf('-c') + 1], 'SELECT 1');
});

// ---------------------------------------------------------------------------
// ③ migrate 失败的错误分类（+ 原文脱敏）
// ---------------------------------------------------------------------------

test('migrate：exit 0 才算成功（不分类、不提示）', () => {
  const verdict = classifyMigrateFailure({ exitCode: 0, stdout: '已应用：（无）', stderr: '' });
  assert.equal(verdict.failed, false);
  assert.equal(verdict.kind, 'OK');
});

test('migrate：进程没跑起来（exitCode=null）也判失败，⛔ 不当成功', () => {
  const verdict = classifyMigrateFailure({ exitCode: null, stdout: '', stderr: 'spawn npm ENOENT' });
  assert.equal(verdict.failed, true);
  assert.equal(verdict.kind, 'COMMAND_NOT_FOUND');
});

test('migrate：失败分类闭集逐条命中，且 retryable 只给「稍后重试可能成功」的那一类', () => {
  const cases = [
    { stderr: 'Error: connect ECONNREFUSED 127.0.0.1:5555', kind: 'CONNECTION_REFUSED', retryable: true },
    { stderr: '迁移失败： 缺少 DATABASE_URL：迁移需要真实数据库连接串，未配置时拒绝运行。', kind: 'DATABASE_URL_MISSING', retryable: false },
    { stderr: 'error: password authentication failed for user "postgres"', kind: 'AUTH_FAILED', retryable: false },
    { stderr: 'error: database "gengyun" does not exist', kind: 'DATABASE_MISSING', retryable: false },
    { stderr: '迁移校验和 drift，拒绝继续：0009(磁盘 abc != 台账 def)', kind: 'MIGRATION_DRIFT', retryable: false },
    { stderr: '迁移版本号重复：0009 同时出现在 a.sql 与 b.sql', kind: 'DUPLICATE_VERSION', retryable: false },
    { stderr: '迁移 0031_x.sql 执行失败：syntax error at or near "SELEC"', kind: 'MIGRATION_SQL_FAILED', retryable: false },
    { stderr: 'something odd happened', kind: 'UNKNOWN', retryable: false },
  ];
  for (const item of cases) {
    const verdict = classifyMigrateFailure({ exitCode: 1, stdout: '', stderr: item.stderr });
    assert.equal(verdict.failed, true, item.kind);
    assert.equal(verdict.kind, item.kind);
    assert.equal(verdict.retryable, item.retryable, item.kind);
    assert.equal(typeof verdict.hint, 'string');
  }
});

test('migrate：失败证据必须脱敏（连接串口令与密钥值都不许出现在 evidence 里）', () => {
  const secret = 'S'.repeat(43);
  const stderr = '连接失败：postgres://postgres:sup3rs3cret@127.0.0.1:5555/gengyun ECONNREFUSED key=' + secret;
  const verdict = classifyMigrateFailure({ exitCode: 1, stdout: '', stderr, secrets: [secret] });
  assert.equal(verdict.kind, 'CONNECTION_REFUSED');
  assert.doesNotMatch(verdict.evidence, /sup3rs3cret/);
  assert.doesNotMatch(verdict.evidence, new RegExp(secret));
  assert.match(verdict.evidence, /\[REDACTED\]/);
});

test('migrate：stdout 解析读得懂「发现/已应用/已存在跳过」，解析不出来一律 null', () => {
  const ok = parseMigrateOutput(
    '发现 3 个迁移：0001_a.sql, 0002_b.sql, 0003_c.sql\n已应用：0001, 0002\n已存在跳过：（无）\n',
  );
  assert.deepEqual(ok, {
    discovered: 3,
    applied: ['0001', '0002'],
    skipped: [],
    appliedCount: 2,
    skippedCount: 0,
  });
  const nothing = parseMigrateOutput('已应用：（无）\n已存在跳过：0001, 0009\n');
  assert.deepEqual(nothing.applied, []);
  assert.deepEqual(nothing.skipped, ['0001', '0009']);
  const unparsable = parseMigrateOutput('npm ERR! something exploded');
  assert.equal(unparsable.discovered, null);
  assert.equal(unparsable.applied, null);
  assert.equal(unparsable.appliedCount, null);
});

// ---------------------------------------------------------------------------
// ④ 摘要 JSON 的稳定形状
// ---------------------------------------------------------------------------

const SENTINEL_SESSION = 'session-sentinel-'.padEnd(43, 'A');
const SENTINEL_DELETION = 'deletion-sentinel-'.padEnd(43, 'B');

function summaryFixture() {
  return buildSummary({
    generatedAt: '2026-01-01T00:00:00.000Z',
    repoRoot: 'C:\\repo',
    stateDir: 'C:\\state',
    outPath: 'C:\\state\\summary.json',
    ports: {
      pg: { preferred: 5555, actual: 5556, skipped: [{ port: 5555, holder: { port: 5555, pid: 42, name: 'node.exe', commandLine: 'node bridge.js' } }] },
      api: { preferred: 3111, actual: 3111, skipped: [] },
    },
    postgres: { version: '17.11', port: 5556, dataDir: 'C:\\state\\pg-data', database: 'gengyun', ready: true },
    api: { baseUrl: 'http://127.0.0.1:3111', port: 3111, pid: 4242, executionMode: 'stub', health: 'ok' },
    migrations: { discovered: 48, appliedCount: 48, skippedCount: 0, applied: ['0001', '0002'] },
    keys: {
      SESSION_SIGNING_KEY: keyDescriptor(SENTINEL_SESSION),
      DELETION_LEDGER_KEY: keyDescriptor(SENTINEL_DELETION),
      storage: 'C:\\state\\secrets.env',
    },
    endpoints: REQUIRED_ENDPOINTS.map((endpoint) => ({
      name: endpoint.name,
      method: endpoint.method,
      path: endpoint.path,
      expected_status: endpoint.expected,
      status: 200,
      ok: true,
    })),
    consentPoliciesRows: 0,
  });
}

test('摘要：同输入两次序列化逐字节相同（键名排序 + 固定端点顺序）', () => {
  const first = serializeSummary(summaryFixture());
  const second = serializeSummary(summaryFixture());
  assert.equal(first, second);
  assert.ok(first.endsWith('\n'));
  // 再跑一次 canonicalize 幂等：形状不含无序来源。
  assert.equal(JSON.stringify(canonicalize(JSON.parse(first))), JSON.stringify(JSON.parse(first)));
});

test('摘要：形状稳定（schema/6 个端点/端口回退留痕/已知边界），且没有任何密钥字段', () => {
  const summary = JSON.parse(serializeSummary(summaryFixture()));
  assert.equal(summary.schema, SCHEMA_ID);
  assert.equal(summary.endpoints.length, REQUIRED_ENDPOINTS.length);
  assert.deepEqual(
    summary.endpoints.map((row) => row.name),
    ['health', 'auth_wechat', 'me_profile', 'knowledge', 'catalog_crops', 'herbicides'],
  );
  assert.deepEqual(summary.ports.pg.skipped, [{ port: 5555, pid: 42, name: 'node.exe' }]);
  assert.equal(summary.checks.consent_policies_rows, 0);
  assert.equal(summary.migrations.applied_count, 48);
  // keys 段只允许「读数」：布尔 + 长度，⛔ 不许有 value/secret/token 这类键。
  assert.deepEqual(Object.keys(summary.keys).sort(), ['DELETION_LEDGER_KEY', 'SESSION_SIGNING_KEY', 'storage']);
  for (const name of ['SESSION_SIGNING_KEY', 'DELETION_LEDGER_KEY']) {
    assert.deepEqual(Object.keys(summary.keys[name]).sort(), ['generated', 'length', 'length_ok']);
    assert.equal(typeof summary.keys[name].generated, 'boolean');
    assert.equal(typeof summary.keys[name].length_ok, 'boolean');
  }
  const serialized = JSON.stringify(summary);
  for (const banned of ['value', 'secret', 'token', 'password']) {
    assert.equal(Object.prototype.hasOwnProperty.call(summary.keys, banned), false);
    assert.doesNotMatch(serialized, new RegExp(`"${banned}"`));
  }
});

test('摘要：已知边界固定点名 consent_policies 空表 ⇒ 发帖 403（⛔ 不许写成「已修复」）', () => {
  const lines = knownBoundaryLines(0);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].id, 'consent_policies_empty');
  assert.match(lines[0].detail, /consent_policies 0 行/);
  assert.match(lines[0].detail, /403/);
  assert.match(lines[0].detail, /导入工具/);
  // 行数未知时也要如实说「未知」，不许四舍五入成 0。
  assert.match(knownBoundaryLines(null)[0].detail, /行数未知/);
  assert.match(knownBoundaryLines(3)[0].detail, /consent_policies 3 行/);
});

test('摘要：端点读数不齐即判「不符合预期」（⛔ 不许把 401/503 当成功）', () => {
  const healthy = summaryFixture().endpoints;
  assert.equal(allEndpointsExpected(healthy), true);
  const degraded = healthy.map((row, index) => (index === 0 ? { ...row, status: 503, ok: false } : row));
  assert.equal(allEndpointsExpected(degraded), false);
  assert.equal(allEndpointsExpected(healthy.slice(0, 5)), false);
});

// ---------------------------------------------------------------------------
// ⑤ 泄密回归（负控制）
// ---------------------------------------------------------------------------

test('泄密回归：真实摘要里不出现任何密钥值（哨兵值不在序列化文本里）', () => {
  const text = serializeSummary(summaryFixture());
  assert.equal(findSecretLeaks(text, [SENTINEL_SESSION, SENTINEL_DELETION]).length, 0);
  assert.equal(assertNoSecretLeaks('摘要 JSON', text, [SENTINEL_SESSION, SENTINEL_DELETION]), true);
  assert.doesNotMatch(text, new RegExp(SENTINEL_SESSION));
  assert.doesNotMatch(text, new RegExp(SENTINEL_DELETION));
});

test('泄密回归：往摘要里塞进密钥值必须被抓住（并点名路径，⛔ 错误信息自身不回显密钥）', () => {
  const leaked = summaryFixture();
  // 模拟「实现把密钥值写进了 keys 段」——这正是要防的回归。
  leaked.keys.SESSION_SIGNING_KEY = { generated: true, length_ok: true, length: 43, value: SENTINEL_SESSION };
  const text = serializeSummary(leaked);
  // 用例本身有意义：文本里确实出现了哨兵值。
  assert.match(text, new RegExp(SENTINEL_SESSION));

  // 按对象查能点名到具体字段；按序列化文本查只报「整段文本」（CLI 打印前走的正是后者）。
  assert.deepEqual(findSecretLeaks(leaked, [SENTINEL_SESSION, SENTINEL_DELETION]), ['$.keys.SESSION_SIGNING_KEY.value']);
  assert.deepEqual(findSecretLeaks(text, [SENTINEL_SESSION, SENTINEL_DELETION]), ['$']);

  assert.throws(
    () => assertNoSecretLeaks('摘要 JSON', text, [SENTINEL_SESSION, SENTINEL_DELETION]),
    (error) => {
      assert.match(error.message, /摘要 JSON 里出现了密钥值（路径：\$）/);
      assert.doesNotMatch(error.message, new RegExp(SENTINEL_SESSION));
      return true;
    },
  );
});

test('泄密回归：密钥作为「键名」出现也算泄漏', () => {
  const leaked = { nested: { [SENTINEL_SESSION]: 'x' } };
  assert.deepEqual(findSecretLeaks(leaked, [SENTINEL_SESSION]), ['$.nested.<key>']);
});

test('泄密回归：短值不参与判定（避免普通文本误命中），空密钥表恒判干净', () => {
  assert.deepEqual(findSecretLeaks({ note: 'short-secret' }, ['short-secret']), []);
  assert.deepEqual(findSecretLeaks({ note: 'anything' }, []), []);
});

test('keyDescriptor：只回读数、不回值（长度满足下限才算 ok）', () => {
  assert.deepEqual(keyDescriptor('a'.repeat(43)), { generated: true, length_ok: true, length: 43 });
  assert.deepEqual(keyDescriptor('a'.repeat(10)), { generated: true, length_ok: false, length: 10 });
  assert.deepEqual(keyDescriptor(null), { generated: false, length_ok: false, length: 0 });
  assert.equal(JSON.stringify(keyDescriptor(SENTINEL_SESSION)).includes(SENTINEL_SESSION), false);
});

test('脱敏：连接串口令与密钥值逐字打码（长的先替换）', () => {
  const secret = 'k'.repeat(43);
  assert.equal(redactConnectionStrings('postgres://postgres:pw@127.0.0.1:5555/gengyun'), 'postgres://postgres@127.0.0.1:5555/gengyun');
  assert.equal(redactSecrets(`KEY=${secret} 以及 ${secret}`, [secret]), 'KEY=[REDACTED] 以及 [REDACTED]');
  assert.equal(redactSecrets('nothing to redact', []), 'nothing to redact');
});

// ---------------------------------------------------------------------------
// ⑥ 停止前的归属核实（PID 复用 / 端口归属 / 旧格式兼容）
//
// 现场的每一块都由用例注入：进程元数据、监听者、`/health` 读数。⛔ 单测里**不真杀进程**
// （`kill` 是注入的假函数，只记调用次数），也不起服务、不发 HTTP。
// ---------------------------------------------------------------------------

/** 跨平台绝对路径夹具（沿用本文件既有口径：⛔ 不写字面量 Windows 路径）。 */
const WORK_TREE_ROOT = path.resolve(path.sep, 'wt', 'localenv');
const OTHER_WORK_TREE = path.resolve(path.sep, 'wt', 'other');

/** 本实例 UUID（真实运行时每次 `up` 现生成；这里固定一份便于断言）。 */
const INSTANCE_TOKEN = '11111111-2222-4333-8444-555555555555';
const FOREIGN_TOKEN = '99999999-8888-4777-8666-555555555555';

/** pid 文件写入时刻（工具侧，毫秒级）。 */
const PID_FILE_WRITTEN_AT = '2026-10-30T06:00:00.000Z';
/** 进程 OS 启动时刻（`Win32_Process.CreationDate`，秒级）。 */
const PROCESS_STARTED_AT = '2026-10-30T06:00:00Z';
/** 判定用的「当前时刻」：距进程启动 300 秒。 */
const ASSESS_NOW = new Date('2026-10-30T06:05:00.000Z');

function v2PidRecord(overrides = {}) {
  return {
    format: 'v2',
    pid: 4321,
    instanceToken: INSTANCE_TOKEN,
    startedAt: PID_FILE_WRITTEN_AT,
    workTreeRoot: WORK_TREE_ROOT,
    apiPort: DEFAULT_PORTS.api,
    detail: null,
    ...overrides,
  };
}

/** 本工具自己 `spawn` 出来的那个进程：命令行带实例标识与工作树根。 */
function ownedProcess(overrides = {}) {
  return {
    pid: 4321,
    alive: true,
    startTime: PROCESS_STARTED_AT,
    commandLine: [
      path.join(path.sep, 'Program Files', 'nodejs', 'node.exe'),
      path.join(WORK_TREE_ROOT, 'services', 'api', 'src', 'server.ts'),
      `${INSTANCE_FLAG_PREFIX}${INSTANCE_TOKEN}`,
      `${ROOT_FLAG_PREFIX}${WORK_TREE_ROOT}`,
    ].join(' '),
    detail: null,
    ...overrides,
  };
}

function ownedListener(overrides = {}) {
  return { port: DEFAULT_PORTS.api, listening: true, pid: 4321, psError: null, ...overrides };
}

/** 当前 API 不回显 instanceToken ⇒ 端口侧走 uptime 反推（300s 前启动 ⇒ 与 OS 启动时刻对齐）。 */
function ownedHealth(overrides = {}) {
  return { reachable: true, instanceToken: null, uptimeSeconds: 300, detail: null, ...overrides };
}

function assess(overrides = {}) {
  return assessApiOwnership({
    pidRecord: v2PidRecord(),
    workTreeRoot: WORK_TREE_ROOT,
    processInfo: ownedProcess(),
    listener: ownedListener(),
    health: ownedHealth(),
    now: ASSESS_NOW,
    ...overrides,
  });
}

/** 假 killer：⛔ 绝不真杀进程，只记调用次数与参数。 */
function fakeKiller() {
  const calls = [];
  return { calls, kill: (pid) => { calls.push(pid); } };
}

function failingCheckIds(assessment) {
  return assessment.checks.filter((item) => item.status === 'fail').map((item) => item.id);
}

test('归属核实：四条判据全成立 ⇒ 判「在跑」，且 kill 恰好一次', () => {
  const assessment = assess();
  assert.equal(assessment.verdict, OWNERSHIP.OWNED);
  assert.equal(assessment.killAllowed, true);
  assert.equal(assessment.statusLabel, '在跑');
  assert.deepEqual(
    assessment.checks.map((item) => `${item.side}/${item.id}:${item.status}`),
    [
      'pid/work_tree:pass',
      'pid/instance_marker:pass',
      'pid/start_time:pass',
      'port/port_owner:pass',
      'port/instance_echo:pass',
    ],
  );
  const killer = fakeKiller();
  const outcome = applyApiStop({ assessment, kill: killer.kill });
  assert.equal(outcome.killed, true);
  assert.equal(outcome.killCalls, 1);
  assert.deepEqual(killer.calls, [4321]);
  assert.equal(describeOwnershipChecks(assessment).length, 5);
});

test('归属核实：pid 存在但命令行不含实例标识 ⇒ 「不属本工具」，零 kill 调用', () => {
  // 现场：API 自行退出 ⇒ 系统把同一个 pid 复用给了一个无关进程（命令行里当然没有我们的 UUID）。
  const assessment = assess({
    processInfo: ownedProcess({ commandLine: `${path.join(path.sep, 'node.exe')} ${path.join(OTHER_WORK_TREE, 'bridge.js')}` }),
    listener: ownedListener({ listening: false, pid: null }),
  });
  assert.equal(assessment.verdict, OWNERSHIP.NOT_OWNED);
  assert.equal(assessment.killAllowed, false);
  assert.equal(assessment.statusLabel, '已复用（不属本工具）');
  assert.deepEqual(failingCheckIds(assessment), [OWNERSHIP_CHECKS.INSTANCE_MARKER]);
  assert.match(assessment.headline, /PID 已复用 \/ 归属不符，已跳过/);

  const killer = fakeKiller();
  const outcome = applyApiStop({ assessment, kill: killer.kill });
  assert.equal(outcome.killed, false);
  assert.equal(outcome.killCalls, 0);
  assert.deepEqual(killer.calls, []);
});

test('归属核实：进程启动时间早于 pid 文件写入 ⇒ 「不属本工具」，零 kill 调用', () => {
  // 现场：pid 文件是旧的，pid 上坐着一个**比它更老**的进程 ⇒ 一定不是我们的。
  // （health 的 uptime 与那个更老的进程自洽：900s 前启动 ⇒ 只剩 start_time 这一条判红。）
  const assessment = assess({
    processInfo: ownedProcess({ startTime: '2026-10-30T05:50:00Z' }),
    health: ownedHealth({ uptimeSeconds: 900 }),
  });
  assert.equal(assessment.verdict, OWNERSHIP.NOT_OWNED);
  assert.equal(assessment.killAllowed, false);
  assert.deepEqual(failingCheckIds(assessment), [OWNERSHIP_CHECKS.START_TIME]);
  assert.match(assessment.headline, /早于 pid 文件写入时间/);

  const killer = fakeKiller();
  assert.equal(applyApiStop({ assessment, kill: killer.kill }).killCalls, 0);
  assert.deepEqual(killer.calls, []);
});

test('归属核实：启动时间容差 —— 差 1 秒内算「不早于」，差 2 秒以上判复用', () => {
  assert.equal(assess({ processInfo: ownedProcess({ startTime: '2026-10-30T05:59:59Z' }) }).verdict, OWNERSHIP.OWNED);
  assert.equal(assess({ processInfo: ownedProcess({ startTime: '2026-10-30T05:59:57Z' }) }).verdict, OWNERSHIP.NOT_OWNED);
  assert.equal(START_TIME_TOLERANCE_MS, 2000);
});

test('归属核实：/health 回显别人的 instanceToken ⇒ 不杀（⛔ 不看状态码、不看固定字符串）', () => {
  const assessment = assess({ health: ownedHealth({ instanceToken: FOREIGN_TOKEN }) });
  assert.equal(assessment.verdict, OWNERSHIP.NOT_OWNED);
  assert.equal(assessment.killAllowed, false);
  assert.deepEqual(failingCheckIds(assessment), [OWNERSHIP_CHECKS.INSTANCE_ECHO]);
  assert.match(assessment.headline, /instanceToken/);

  const killer = fakeKiller();
  assert.equal(applyApiStop({ assessment, kill: killer.kill }).killCalls, 0);
  assert.deepEqual(killer.calls, []);
});

test('归属核实：旧格式 pid 文件（纯数字）⇒ 降级成「无法核实」：不杀 + 提示', () => {
  const assessment = assess({ pidRecord: parseApiPidFile('4321\n') });
  assert.equal(assessment.verdict, OWNERSHIP.UNVERIFIABLE);
  assert.equal(assessment.killAllowed, false);
  assert.equal(assessment.statusLabel, '无法核实（旧格式 pid 文件）');
  assert.match(assessment.headline, /无法核实/);
  assert.match(assessment.detail, /处理/);

  const killer = fakeKiller();
  const outcome = applyApiStop({ assessment, kill: killer.kill });
  assert.equal(outcome.killCalls, 0);
  assert.deepEqual(killer.calls, []);
});

test('status 三态：在跑 / 已复用（不属本工具）/ 已退出 三条互不相同，⛔ 复用的 pid 不许报成「在跑」', () => {
  const owned = assess();
  const reused = assess({
    processInfo: ownedProcess({ commandLine: `${path.join(path.sep, 'node.exe')} other.js` }),
    listener: ownedListener({ listening: false, pid: null }),
  });
  const exited = assess({ processInfo: { pid: 4321, alive: false, startTime: null, commandLine: null, detail: null } });
  const labels = [owned.statusLabel, reused.statusLabel, exited.statusLabel];
  assert.deepEqual(labels, ['在跑', '已复用（不属本工具）', '已退出']);
  assert.equal(new Set(labels).size, 3);
  assert.notEqual(reused.statusLabel, '在跑');
  assert.equal(apiStatusLabel(OWNERSHIP.EXITED), '已退出');
  // 旧格式是第四种降级读数，⛔ 不许并进「在跑」。
  assert.equal(apiStatusLabel(OWNERSHIP.UNVERIFIABLE), '无法核实（旧格式 pid 文件）');
  assert.equal(apiStatusLabel('something-else'), '状态未知');
});

test('pid 文件 v2：序列化 + 解析往返一致、两次逐字节相同，且不含任何密钥字段', () => {
  const record = {
    pid: 4321,
    instanceToken: INSTANCE_TOKEN,
    startedAt: PID_FILE_WRITTEN_AT,
    workTreeRoot: WORK_TREE_ROOT,
    apiPort: DEFAULT_PORTS.api,
  };
  const text = serializeApiPidFile(record);
  assert.equal(serializeApiPidFile(record), text);
  assert.equal(JSON.parse(text).schema, API_PID_SCHEMA);
  const parsed = parseApiPidFile(text);
  assert.equal(parsed.format, 'v2');
  assert.deepEqual(
    {
      pid: parsed.pid,
      instanceToken: parsed.instanceToken,
      startedAt: parsed.startedAt,
      workTreeRoot: parsed.workTreeRoot,
      apiPort: parsed.apiPort,
    },
    record,
  );
  for (const banned of ['SESSION_SIGNING_KEY', 'DELETION_LEDGER_KEY', 'password', 'secret']) {
    assert.equal(text.includes(banned), false, banned);
  }
});

test('pid 文件向后兼容：纯数字读成 legacy、坏输入读成 invalid（⛔ 都不许读成一个「能杀」的 pid）', () => {
  const legacy = parseApiPidFile('4321\n');
  assert.equal(legacy.format, 'legacy');
  assert.equal(legacy.pid, 4321);
  assert.match(legacy.detail, /旧格式/);
  for (const text of ['', '   \n', 'not a pid', '{"schema":"x"}']) {
    const parsed = parseApiPidFile(text);
    assert.notEqual(parsed.format, 'v2', text);
    assert.equal(parsed.instanceToken, null, text);
  }
  // v2 形状但缺 instanceToken ⇒ invalid（⛔ 不许当作「有 pid 就能杀」）。
  const partial = parseApiPidFile(
    JSON.stringify({ schema: API_PID_SCHEMA, pid: 4321, startedAt: PID_FILE_WRITTEN_AT, workTreeRoot: WORK_TREE_ROOT }),
  );
  assert.equal(partial.format, 'invalid');
  assert.match(partial.detail, /缺字段/);
  // 序列化只接受完整身份：⛔ 缺一项就抛错，不许写半份。
  assert.throws(() => serializeApiPidFile({ pid: 0, instanceToken: INSTANCE_TOKEN, startedAt: PID_FILE_WRITTEN_AT, workTreeRoot: WORK_TREE_ROOT }), /pid/);
  assert.throws(() => serializeApiPidFile({ pid: 4321, instanceToken: '', startedAt: PID_FILE_WRITTEN_AT, workTreeRoot: WORK_TREE_ROOT }), /instanceToken/);
  assert.throws(() => serializeApiPidFile({ pid: 4321, instanceToken: INSTANCE_TOKEN, startedAt: 'nope', workTreeRoot: WORK_TREE_ROOT }), /startedAt/);
  assert.throws(() => serializeApiPidFile({ pid: 4321, instanceToken: INSTANCE_TOKEN, startedAt: PID_FILE_WRITTEN_AT, workTreeRoot: '.local-env' }), /绝对路径/);
});

test('实例标识：命令行上的两个落点与判据口径一致（含空格路径被加引号后仍成立）', () => {
  const flags = buildInstanceFlags({ instanceToken: INSTANCE_TOKEN, workTreeRoot: WORK_TREE_ROOT });
  assert.deepEqual(flags, [`${INSTANCE_FLAG_PREFIX}${INSTANCE_TOKEN}`, `${ROOT_FLAG_PREFIX}${WORK_TREE_ROOT}`]);
  const commandLine = ['node.exe', 'services/api/src/server.ts', ...flags].join(' ');
  assert.equal(assess({ processInfo: ownedProcess({ commandLine }) }).verdict, OWNERSHIP.OWNED);

  // 工作树根含空格时，OS 读回来的命令行会带引号 ⇒ 判据必须去引号后比较，否则假红。
  const spacedRoot = path.resolve(path.sep, 'wt dir', 'localenv');
  const spacedFlags = buildInstanceFlags({ instanceToken: INSTANCE_TOKEN, workTreeRoot: spacedRoot });
  const quoted = `"node.exe" "server.ts" "${spacedFlags[0]}" "${spacedFlags[1]}"`;
  const spaced = assessApiOwnership({
    pidRecord: v2PidRecord({ workTreeRoot: spacedRoot }),
    workTreeRoot: spacedRoot,
    processInfo: ownedProcess({ commandLine: quoted }),
    listener: ownedListener(),
    health: ownedHealth(),
    now: ASSESS_NOW,
  });
  assert.equal(spaced.verdict, OWNERSHIP.OWNED);

  assert.throws(() => buildInstanceFlags({ instanceToken: '', workTreeRoot: WORK_TREE_ROOT }), /instanceToken/);
  assert.throws(() => buildInstanceFlags({ instanceToken: 'a b', workTreeRoot: WORK_TREE_ROOT }), /instanceToken/);
  assert.throws(() => buildInstanceFlags({ instanceToken: INSTANCE_TOKEN, workTreeRoot: '.local-env' }), /绝对路径/);
});

test('归属核实：pid 文件属于另一个工作树 ⇒ 不杀', () => {
  const assessment = assess({ pidRecord: v2PidRecord({ workTreeRoot: OTHER_WORK_TREE }) });
  assert.equal(assessment.verdict, OWNERSHIP.NOT_OWNED);
  assert.ok(failingCheckIds(assessment).includes(OWNERSHIP_CHECKS.WORK_TREE));
  assert.match(assessment.headline, /PID 已复用 \/ 归属不符，已跳过/);
  const killer = fakeKiller();
  assert.equal(applyApiStop({ assessment, kill: killer.kill }).killCalls, 0);
  assert.deepEqual(killer.calls, []);
});

test('归属核实：端口由别的 pid 持有 ⇒ 不杀（⛔「端口在听」不算归属）', () => {
  const assessment = assess({ listener: ownedListener({ pid: 9999 }) });
  assert.equal(assessment.verdict, OWNERSHIP.NOT_OWNED);
  assert.deepEqual(failingCheckIds(assessment), [OWNERSHIP_CHECKS.PORT_OWNER]);
  assert.match(assessment.headline, /9999/);
  const killer = fakeKiller();
  assert.equal(applyApiStop({ assessment, kill: killer.kill }).killCalls, 0);
  assert.deepEqual(killer.calls, []);
});

test('归属核实：端口在听但拿不到持有进程 / 没有端口读数 ⇒ fail-closed（不杀）', () => {
  const unknownOwner = assess({ listener: ownedListener({ pid: null }) });
  assert.equal(unknownOwner.verdict, OWNERSHIP.NOT_OWNED);
  assert.deepEqual(failingCheckIds(unknownOwner), [OWNERSHIP_CHECKS.PORT_OWNER]);

  const noProbe = assess({ listener: null });
  assert.equal(noProbe.verdict, OWNERSHIP.NOT_OWNED);
  assert.deepEqual(failingCheckIds(noProbe), [OWNERSHIP_CHECKS.PORT_OWNER]);

  for (const assessment of [unknownOwner, noProbe]) {
    const killer = fakeKiller();
    assert.equal(applyApiStop({ assessment, kill: killer.kill }).killCalls, 0);
    assert.deepEqual(killer.calls, []);
  }
});

test('归属核实：端口没在听但 PID 侧身份成立 ⇒ 允许停（没有端口归属可冲突）', () => {
  const assessment = assess({ listener: ownedListener({ listening: false, pid: null }) });
  assert.equal(assessment.verdict, OWNERSHIP.OWNED);
  assert.deepEqual(
    assessment.checks.filter((item) => item.side === 'port').map((item) => item.status),
    ['skipped', 'skipped'],
  );
});

test('归属核实：端口在听但 /health 无响应 ⇒ 不杀（⛔ 不「尽力而为」）', () => {
  const assessment = assess({ health: { reachable: false, instanceToken: null, uptimeSeconds: null, detail: '请求失败：TimeoutError' } });
  assert.equal(assessment.verdict, OWNERSHIP.NOT_OWNED);
  assert.deepEqual(failingCheckIds(assessment), [OWNERSHIP_CHECKS.INSTANCE_ECHO]);
  const killer = fakeKiller();
  assert.equal(applyApiStop({ assessment, kill: killer.kill }).killCalls, 0);
  assert.deepEqual(killer.calls, []);
});

test('归属核实：/health 的 uptime 反推启动时刻对不上 ⇒ 不杀（端口上应答的不是这个进程）', () => {
  // 30 秒前才启动 ≠ 300 秒前启动的那个 pid：差出分钟级 ⇒ 判「归属不符」。
  const assessment = assess({ health: ownedHealth({ uptimeSeconds: 30 }) });
  assert.equal(assessment.verdict, OWNERSHIP.NOT_OWNED);
  assert.deepEqual(failingCheckIds(assessment), [OWNERSHIP_CHECKS.INSTANCE_ECHO]);
  assert.match(assessment.headline, /相差/);
  // 读不到 uptime 的响应者（不是我们的 API）同样判红，⛔ 不许当「没法判就算过」。
  const noUptime = assess({ health: ownedHealth({ uptimeSeconds: null }) });
  assert.equal(noUptime.verdict, OWNERSHIP.NOT_OWNED);
  assert.deepEqual(failingCheckIds(noUptime), [OWNERSHIP_CHECKS.INSTANCE_ECHO]);
});

test('归属核实：没有 pid 记录 / 进程已退出 ⇒ 「已退出」，零 kill（旧格式 + 已退出也报「已退出」）', () => {
  const none = assessApiOwnership({ pidRecord: null, workTreeRoot: WORK_TREE_ROOT });
  assert.equal(none.verdict, OWNERSHIP.EXITED);
  assert.equal(none.statusLabel, '已退出');
  assert.equal(none.killAllowed, false);

  const dead = assess({ processInfo: { pid: 4321, alive: false, startTime: null, commandLine: null, detail: null } });
  assert.equal(dead.verdict, OWNERSHIP.EXITED);

  const legacyDead = assess({
    pidRecord: parseApiPidFile('4321'),
    processInfo: { pid: 4321, alive: false, startTime: null, commandLine: null, detail: null },
  });
  assert.equal(legacyDead.verdict, OWNERSHIP.EXITED);

  for (const assessment of [none, dead, legacyDead]) {
    const killer = fakeKiller();
    assert.equal(applyApiStop({ assessment, kill: killer.kill }).killCalls, 0);
    assert.deepEqual(killer.calls, []);
  }
});

test('applyApiStop：⛔ 没有 killAllowed 就一次都不调；pid 不合法/没给 killer 也不瞎杀', () => {
  const killer = fakeKiller();
  const blocked = { verdict: OWNERSHIP.NOT_OWNED, killAllowed: false, pid: 4321 };
  assert.equal(applyApiStop({ assessment: blocked, kill: killer.kill }).killCalls, 0);
  assert.equal(applyApiStop({ assessment: { verdict: OWNERSHIP.OWNED, killAllowed: true, pid: null }, kill: killer.kill }).killCalls, 0);
  assert.equal(applyApiStop({ assessment: { verdict: OWNERSHIP.OWNED, killAllowed: true, pid: 4321 }, kill: null }).killCalls, 0);
  assert.deepEqual(killer.calls, []);
  assert.throws(() => applyApiStop({}), /assessment/);
  assert.throws(() => applyApiStop({ assessment: blocked, kill: 'nope' }), /kill/);
});

import { stopSpawnedApi } from '../../tools/local-env.mjs';

// ---------------------------------------------------------------------------
// 回滚路径：⛔ 只认子进程句柄，不按整数 pid 杀
// （监工 R72 指出的 `up()` 回滚缺陷：子进程先退出 + 后续步骤失败 ⇒ 旧写法按号码杀会误杀别人）
// ---------------------------------------------------------------------------

/** 假子进程：只实现回滚路径真正用到的三样（exitCode / signalCode、kill、once + removeListener）。 */
function fakeChild({ exitCode = null, signalCode = null, exitOnSignal = false } = {}) {
  const calls = [];
  const listeners = new Map();
  const child = {
    exitCode,
    signalCode,
    calls,
    kill(signal) {
      calls.push(signal ?? null);
      if (exitOnSignal) {
        child.exitCode = 0;
        for (const cb of [...(listeners.get('exit') ?? [])]) cb();
      }
      return true;
    },
    once(event, cb) {
      const list = listeners.get(event) ?? [];
      list.push(cb);
      listeners.set(event, list);
      return child;
    },
    removeListener(event, cb) {
      const list = listeners.get(event) ?? [];
      const at = list.indexOf(cb);
      if (at >= 0) list.splice(at, 1);
      return child;
    },
  };
  return child;
}

test('回滚判据：没有句柄 / 句柄没有 kill ⇒ NOTHING_STARTED（⛔ 零终止信号）', () => {
  for (const child of [null, undefined, {}, { pid: 4321 }]) {
    const plan = planSpawnedApiStop(child);
    assert.equal(plan.action, SPAWNED_API_STOP.NOTHING_STARTED);
    assert.equal(plan.exited, true);
  }
});

test('回滚判据：子进程已自行退出（exitCode / signalCode）⇒ ALREADY_EXITED，并点名退出读数', () => {
  const byCode = planSpawnedApiStop({ exitCode: 1, kill() {} });
  assert.equal(byCode.action, SPAWNED_API_STOP.ALREADY_EXITED);
  assert.match(byCode.detail, /exitCode=1/);
  const bySignal = planSpawnedApiStop({ signalCode: 'SIGTERM', kill() {} });
  assert.equal(bySignal.action, SPAWNED_API_STOP.ALREADY_EXITED);
  assert.match(bySignal.detail, /signalCode=SIGTERM/);
});

test('回滚判据：句柄自报仍在运行 ⇒ SIGNAL；exitCode=0 算「已退出」，⛔ 不当成还活着', () => {
  assert.equal(planSpawnedApiStop({ exitCode: null, signalCode: null, kill() {} }).action, SPAWNED_API_STOP.SIGNAL);
  assert.equal(planSpawnedApiStop({ exitCode: 0, signalCode: null, kill() {} }).action, SPAWNED_API_STOP.ALREADY_EXITED);
});

test('回滚：子进程先退出 + 后续步骤失败 ⇒ 一次 kill 都不发，只删本次的 pid 文件', async () => {
  const child = fakeChild({ exitCode: 0 });
  const removed = [];
  const out = await stopSpawnedApi(child, 12345, '/tmp/api.pid', {
    log: () => {},
    warn: () => {},
    removePidFile: (file) => removed.push(file),
  });
  assert.equal(out.outcome, SPAWNED_API_STOP.ALREADY_EXITED);
  assert.equal(out.signalled, false);
  assert.equal(child.calls.length, 0);
  assert.deepEqual(removed, ['/tmp/api.pid']);
});

test('回滚：没有句柄（spawn 之前就失败）⇒ 零终止信号，pid 文件照样删', async () => {
  const removed = [];
  const out = await stopSpawnedApi(null, null, '/tmp/api.pid', {
    log: () => {},
    warn: () => {},
    removePidFile: (file) => removed.push(file),
  });
  assert.equal(out.outcome, SPAWNED_API_STOP.NOTHING_STARTED);
  assert.equal(out.signalled, false);
  assert.deepEqual(removed, ['/tmp/api.pid']);
});

test('回滚：句柄还在 ⇒ 只对该句柄发信号，一次就退 ⇒ SIGNALLED', async () => {
  const child = fakeChild({ exitOnSignal: false });
  const out = await stopSpawnedApi(child, 999, null, {
    log: () => {},
    warn: () => {},
    removePidFile: () => {},
    waitExit: () => Promise.resolve(true),
  });
  assert.equal(out.outcome, 'SIGNALLED');
  assert.deepEqual(child.calls, [null]);
});

test('回滚：第一次没退 ⇒ 用 SIGKILL 兜底（仍然只打在这个句柄上）', async () => {
  const child = fakeChild({ exitOnSignal: false });
  let waits = 0;
  const out = await stopSpawnedApi(child, 999, null, {
    log: () => {},
    warn: () => {},
    removePidFile: () => {},
    waitExit: () => {
      waits += 1;
      return Promise.resolve(waits >= 2);
    },
  });
  assert.equal(out.outcome, 'SIGNALLED_AND_KILLED');
  assert.deepEqual(child.calls, [null, 'SIGKILL']);
});

test('回滚：SIGKILL 之后仍没退 ⇒ STILL_RUNNING（⛔ 不谎报「已停」）', async () => {
  const child = fakeChild({ exitOnSignal: false });
  const out = await stopSpawnedApi(child, 999, null, {
    log: () => {},
    warn: () => {},
    removePidFile: () => {},
    waitExit: () => Promise.resolve(false),
  });
  assert.equal(out.outcome, 'STILL_RUNNING');
  assert.equal(out.signalled, true);
});

test('源码钉子：up() 回滚只走句柄级 stopSpawnedApi，⛔ 不出现 stopApi / process.kill', () => {
  const source = readFileSync(new URL('../../tools/local-env.mjs', import.meta.url), 'utf8');
  const at = source.indexOf('const rollback = async () => {');
  assert.ok(at > 0, '找不到 rollback 定义 —— 钉子需要跟着实现更新');
  // 只看代码行：注释里点名 `stopApi(apiPid, …)` 正是为了解释「为什么不用它」，不算违规。
  const body = source
    .slice(at, source.indexOf('};', at))
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  assert.match(body, /stopSpawnedApi\(apiChild/);
  assert.doesNotMatch(body, /stopApi\(/);
  assert.doesNotMatch(body, /process\.kill/);
});

test('源码钉子：stopSpawnedApi 用 child.kill 打句柄，⛔ 不碰 process.kill', () => {
  const source = readFileSync(new URL('../../tools/local-env.mjs', import.meta.url), 'utf8');
  const at = source.indexOf('export async function stopSpawnedApi');
  assert.ok(at > 0, '找不到 stopSpawnedApi —— 钉子需要跟着实现更新');
  const body = source.slice(at, source.indexOf('\n}\n', at) + 3);
  assert.match(body, /child\.kill\(/);
  assert.doesNotMatch(body, /process\.kill/);
});