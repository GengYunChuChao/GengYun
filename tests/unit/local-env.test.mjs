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

import {
  DEFAULT_DATABASE,
  DEFAULT_PORTS,
  PORT_MAX_OFFSET,
  REQUIRED_ENDPOINTS,
  SCHEMA_ID,
  allEndpointsExpected,
  assertNoSecretLeaks,
  assertSqlIdentifier,
  buildConsentPoliciesCountSql,
  buildCreateDatabaseSql,
  buildDatabaseExistsSql,
  buildDatabaseUrl,
  buildInitdbArgs,
  buildPgStartArgs,
  buildPgStopArgs,
  buildPsqlArgs,
  buildSummary,
  canonicalize,
  classifyMigrateFailure,
  describeHolder,
  findSecretLeaks,
  keyDescriptor,
  knownBoundaryLines,
  normalizeOccupancy,
  parseMigrateOutput,
  planPort,
  redactConnectionStrings,
  redactSecrets,
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
