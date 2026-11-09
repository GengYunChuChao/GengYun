/**
 * `tools/lib/demo-stack.mjs` 的纯逻辑回归。
 *
 * ⛔ 本文件**不**起 PostgreSQL、**不**起 API、**不**发 HTTP、**不**读环境变量、**不**写文件：
 * 端口、env、日志、pid 记录全部由用例注入。真起服务的部分只走手动 smoke
 * （见 `docs/demo/本地演示-stack.md`），不进 CI。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PORTS,
  DEMO_SCHEMA,
  ENV_FILE_TEMPLATE,
  EXTERNAL_KEYS,
  GENERATED_KEYS,
  INSTANCE_FLAG,
  REQUIRED_REAL_ENV,
  UsageError,
  assembleApiEnv,
  buildPidRecord,
  buildPsqlFileArgs,
  classifyFailure,
  commandHasInstance,
  describeEnvSources,
  healthVerdict,
  nextPollDelay,
  nextStepsLines,
  parseArgs,
  parsePidRecord,
  readEnvFile,
  readSecretsFile,
  renderSecretsFile,
  requiredEnvMissing,
  resolvePaths,
  statusLines,
  tailLines,
  usage,
} from '../../tools/lib/demo-stack.mjs';

const ENV_FILE_TEXT = [
  '# 注释行',
  'WECHAT_APP_ID=wx_local_demo',
  'export WECHAT_APP_SECRET="secret-value"',
  "OBJECT_STORAGE_ENDPOINT='https://oss.example.com'",
  'OBJECT_STORAGE_BUCKET=demo-bucket',
  'OBJECT_STORAGE_ACCESS_KEY=ak',
  'OBJECT_STORAGE_SECRET_KEY=sk',
  '',
].join('\n');

function realEnvFile() {
  return readEnvFile(ENV_FILE_TEXT).values;
}

test('parseArgs：默认值与各选项都落在预期位置', () => {
  const defaults = parseArgs([]);
  assert.equal(defaults.command, 'up');
  assert.equal(defaults.mode, 'real');
  assert.equal(defaults.apiPort, DEFAULT_PORTS.api);
  assert.equal(defaults.pgPort, DEFAULT_PORTS.pg);
  assert.equal(defaults.envFile, null);
  assert.equal(defaults.reset, false);
  assert.equal(defaults.timeoutMs, 90_000);

  const custom = parseArgs([
    'up',
    '--mode',
    'stub',
    '--port',
    '3111',
    '--pg-port=55512',
    '--env-file',
    'D:/secrets/demo.env',
    '--state-dir',
    'D:/tmp/demo-state',
    '--timeout-ms',
    '5000',
    '--lines',
    '12',
    '--reset',
    '--yes',
  ]);
  assert.equal(custom.mode, 'stub');
  assert.equal(custom.apiPort, 3111);
  assert.equal(custom.pgPort, 55512);
  assert.equal(custom.envFile, 'D:/secrets/demo.env');
  assert.equal(custom.stateDir, 'D:/tmp/demo-state');
  assert.equal(custom.timeoutMs, 5000);
  assert.equal(custom.lines, 12);
  assert.equal(custom.reset, true);
  assert.equal(custom.yes, true);
});

test('parseArgs：子命令与 --help', () => {
  assert.equal(parseArgs(['down']).command, 'down');
  assert.equal(parseArgs(['status']).command, 'status');
  assert.equal(parseArgs(['logs']).command, 'logs');
  assert.equal(parseArgs(['reset', '--yes']).command, 'reset');
  assert.equal(parseArgs(['--help']).help, true);
  assert.match(usage(), /node tools\/demo-stack\.mjs <up\|down\|status\|logs\|reset>/u);
  assert.match(usage(), /--pg-port/u);
});

test('parseArgs：非法输入必须报错（不静默 fallback）', () => {
  assert.throws(() => parseArgs(['--mode', 'prod']), UsageError);
  assert.throws(() => parseArgs(['bogus']), UsageError);
  assert.throws(() => parseArgs(['up', 'down']), UsageError);
  assert.throws(() => parseArgs(['--port', '0']), UsageError);
  assert.throws(() => parseArgs(['--port', '70000']), UsageError);
  assert.throws(() => parseArgs(['--port', 'abc']), UsageError);
  assert.throws(() => parseArgs(['--unknown']), UsageError);
  assert.throws(() => parseArgs(['--env-file']), UsageError);
  assert.throws(() => parseArgs(['--timeout-ms', '999']), UsageError);
});

test('readEnvFile：注释/空行/export/引号都被正确剥离', () => {
  const { values, errors } = readEnvFile(ENV_FILE_TEXT);
  assert.deepEqual(errors, []);
  assert.equal(values.WECHAT_APP_ID, 'wx_local_demo');
  assert.equal(values.WECHAT_APP_SECRET, 'secret-value');
  assert.equal(values.OBJECT_STORAGE_ENDPOINT, 'https://oss.example.com');
  assert.equal(values.OBJECT_STORAGE_BUCKET, 'demo-bucket');
});

test('readEnvFile：坏行要带行号报出来，好行仍然保留', () => {
  const { values, errors } = readEnvFile(['GOOD=1', 'not-a-pair', '=empty-key', 'BAD KEY=x'].join('\n'));
  assert.equal(values.GOOD, '1');
  assert.equal(errors.length, 3);
  assert.deepEqual(errors.map((item) => item.line), [2, 3, 4]);
});

test('readEnvFile：记事本存的 UTF-8 with BOM 也能读到第一个键', () => {
  const { values, errors } = readEnvFile('\uFEFFWECHAT_APP_ID=wx_bom\r\nOBJECT_STORAGE_BUCKET=demo-bucket\r\n');
  assert.deepEqual(errors, []);
  assert.equal(values.WECHAT_APP_ID, 'wx_bom');
  assert.equal(values.OBJECT_STORAGE_BUCKET, 'demo-bucket');
});

test('requiredEnvMissing：stub 不要求任何项；real 按 9 项顺序点名', () => {
  assert.deepEqual(requiredEnvMissing({}, 'stub'), []);
  assert.deepEqual(requiredEnvMissing({}, 'real'), REQUIRED_REAL_ENV);
  const partial = requiredEnvMissing({ DATABASE_URL: 'postgres://x', SESSION_SIGNING_KEY: '  ' }, 'real');
  assert.ok(partial.includes('SESSION_SIGNING_KEY'));
  assert.ok(!partial.includes('DATABASE_URL'));
});

test('assembleApiEnv：real 组装出 9 项，外部 6 项只来自 env 文件/进程，工具只生成签名钥匙', () => {
  const { env, sources, generated, missing } = assembleApiEnv({
    mode: 'real',
    apiPort: 3000,
    databaseUrl: 'postgres://postgres@127.0.0.1:55510/gengyun',
    envFile: realEnvFile(),
    ambient: {},
    generate: () => 'generated-key-value',
  });
  assert.deepEqual(missing, []);
  assert.deepEqual(generated.sort(), [...GENERATED_KEYS].sort());
  assert.equal(env.APP_EXECUTION_MODE, 'real');
  assert.equal(env.API_HOST, '127.0.0.1');
  assert.equal(env.API_PORT, '3000');
  assert.equal(env.DATABASE_URL, 'postgres://postgres@127.0.0.1:55510/gengyun');
  assert.equal(sources.DATABASE_URL, 'tool');
  for (const key of EXTERNAL_KEYS) {
    assert.equal(env[key] !== undefined && env[key] !== '', true, `${key} 应已组装`);
    assert.equal(sources[key], 'env-file', `${key} 应标为 env 文件来源`);
  }
  assert.equal(env.SESSION_SIGNING_KEY, 'generated-key-value');
  assert.equal(sources.SESSION_SIGNING_KEY, 'generated');
});

test('assembleApiEnv：缺外部凭据时 missing 点名且不生成假值', () => {
  const { env, missing } = assembleApiEnv({
    mode: 'real',
    apiPort: 3000,
    databaseUrl: 'postgres://postgres@127.0.0.1:55510/gengyun',
    envFile: {},
    ambient: {},
    generate: () => 'k',
  });
  assert.deepEqual(missing.sort(), [...EXTERNAL_KEYS].sort());
  for (const key of EXTERNAL_KEYS) assert.equal(env[key], undefined);
  // 工具自己的两项仍然生成，不耽误「先补齐外部 6 项」这件事。
  assert.equal(env.SESSION_SIGNING_KEY, 'k');
  assert.equal(env.DELETION_LEDGER_KEY, 'k');
});

test('assembleApiEnv：state-dir 里的旧钥匙优先于新生成（重启后会话不失效）', () => {
  const first = assembleApiEnv({
    mode: 'real',
    apiPort: 3000,
    databaseUrl: 'postgres://x',
    envFile: realEnvFile(),
    existingGenerated: { SESSION_SIGNING_KEY: 'old-session', DELETION_LEDGER_KEY: 'old-ledger' },
    generate: () => 'new-key',
  });
  assert.equal(first.env.SESSION_SIGNING_KEY, 'old-session');
  assert.equal(first.env.DELETION_LEDGER_KEY, 'old-ledger');
  assert.deepEqual(first.generated, []);
  assert.equal(first.sources.SESSION_SIGNING_KEY, 'state-dir');
});

test('assembleApiEnv：进程环境可兜底，且 DATABASE_URL 永远指向本栈的簇', () => {
  const { env, sources } = assembleApiEnv({
    mode: 'real',
    apiPort: 3111,
    databaseUrl: 'postgres://postgres@127.0.0.1:55510/gengyun',
    envFile: { DATABASE_URL: 'postgres://someone@elsewhere:5432/other' },
    ambient: { WECHAT_APP_ID: 'from-process' },
    existingGenerated: {},
    generate: () => 'k',
  });
  assert.equal(env.DATABASE_URL, 'postgres://postgres@127.0.0.1:55510/gengyun');
  assert.equal(sources.DATABASE_URL, 'tool');
  assert.equal(env.WECHAT_APP_ID, 'from-process');
  assert.equal(sources.WECHAT_APP_ID, 'process');
  assert.equal(env.API_PORT, '3111');
});

test('assembleApiEnv：stub 模式不写凭据、不加 DATABASE_URL', () => {
  const { env, missing, generated } = assembleApiEnv({ mode: 'stub', apiPort: 3100, envFile: realEnvFile() });
  assert.deepEqual(missing, []);
  assert.deepEqual(generated, []);
  assert.deepEqual(Object.keys(env).sort(), ['API_HOST', 'API_PORT', 'APP_EXECUTION_MODE', 'LOG_LEVEL']);
  assert.equal(env.APP_EXECUTION_MODE, 'stub');
});

test('healthVerdict：200 ok 才算就绪，503/404/连不上都要继续等', () => {
  const ready = healthVerdict({ statusCode: 200, body: { status: 'ok', checks: { database: { status: 'ok' } }, meta: { execution_mode: 'real' } } });
  assert.equal(ready.state, 'ready');
  assert.equal(ready.retryable, false);
  assert.match(ready.reason, /200 ok/u);

  const degraded = healthVerdict({ statusCode: 503, body: { status: 'degraded', checks: { database: { status: 'error', category: 'connection' } } } });
  assert.equal(degraded.state, 'degraded');
  assert.equal(degraded.retryable, true);
  assert.match(degraded.reason, /503/u);

  const notFound = healthVerdict({ statusCode: 404, body: { message: 'not found' } });
  assert.equal(notFound.state, 'unexpected');
  assert.equal(notFound.retryable, true);
  assert.match(notFound.reason, /\/api\/v1/u);

  const refused = healthVerdict({ error: 'ECONNREFUSED' });
  assert.equal(refused.state, 'unreachable');
  assert.equal(refused.retryable, true);

  const fake200 = healthVerdict({ statusCode: 200, body: { status: 'degraded' } });
  assert.equal(fake200.state, 'degraded');
});

test('nextPollDelay：退避递增且封顶 2000ms', () => {
  const delays = [0, 1, 2, 3, 4, 10].map((attempt) => nextPollDelay(attempt));
  assert.equal(delays[0], 400);
  for (let index = 1; index < delays.length; index += 1) {
    assert.ok(delays[index] >= delays[index - 1]);
  }
  assert.equal(Math.max(...delays), 2000);
  assert.equal(nextPollDelay(-1), 400);
  assert.equal(nextPollDelay(3, { initialMs: 100, factor: 2, maxMs: 500 }), 500);
});

test('classifyFailure：端口/缺 env/超时/迁移漂移各有专属结论', () => {
  const port = classifyFailure({ stage: 'api-start', output: 'listen EADDRINUSE: address already in use 127.0.0.1:3000' });
  assert.equal(port.code, 'PORT_IN_USE');
  assert.match(port.hint, /--port/u);

  const config = classifyFailure({ stage: 'api-start', output: '  - WECHAT_APP_ID [MISSING] 必填' });
  assert.equal(config.code, 'API_CONFIG_MISSING');
  assert.match(config.hint, /--env-file/u);

  const timeout = classifyFailure({ stage: 'health', timedOut: true, output: 'starting...' });
  assert.equal(timeout.code, 'HEALTH_TIMEOUT');
  assert.match(timeout.hint, /API 日志/u);

  const drift = classifyFailure({ stage: 'migrate', output: '迁移校验和 drift：0002 已应用但文件变了' });
  assert.equal(drift.code, 'MIGRATION_DRIFT');
  assert.match(drift.hint, /reset --yes/u);

  const pgStart = classifyFailure({ stage: 'pg-start', output: 'pg_ctl: could not start server' });
  assert.equal(pgStart.code, 'PG_START_FAILED');

  const unknown = classifyFailure({});
  assert.equal(unknown.code, 'UNKNOWN');
});

test('tailLines：只留最后 n 行，CRLF 归一，空文本返回空串', () => {
  const text = Array.from({ length: 40 }, (_, index) => `line-${index + 1}`).join('\n');
  const tail = tailLines(text, 30).split('\n');
  assert.equal(tail.length, 30);
  assert.equal(tail[0], 'line-11');
  assert.equal(tail.at(-1), 'line-40');
  assert.equal(tailLines('a\r\nb\r\n\r\n', 5), 'a\nb');
  assert.equal(tailLines('', 30), '');
  assert.equal(tailLines('only', 30), 'only');
});

test('buildPsqlFileArgs：种子用 -f 且失败即停', () => {
  const args = buildPsqlFileArgs({ port: 55510, database: 'gengyun', file: 'E:/repo/db/seeds/seed_reference.sql' });
  assert.deepEqual(args.slice(0, 2), ['-v', 'ON_ERROR_STOP=1']);
  assert.equal(args[args.indexOf('-f') + 1], 'E:/repo/db/seeds/seed_reference.sql');
  assert.ok(!args.includes('--database'));
  assert.equal(args[args.indexOf('-d') + 1], 'gengyun');
});

test('pid 记录：往返一致，格式不对就当作没有（不猜 pid）', () => {
  const record = buildPidRecord({ pid: 4321, port: 3000, mode: 'real', instanceId: 'abc-123', startedAt: '2026-11-09T10:00:00.000Z', logFile: 'E:/state/api.log' });
  assert.equal(record.schema, DEMO_SCHEMA);
  assert.deepEqual(parsePidRecord(JSON.stringify(record)), record);
  assert.equal(parsePidRecord(''), null);
  assert.equal(parsePidRecord('{'), null);
  assert.equal(parsePidRecord(JSON.stringify({ ...record, schema: 'other/1' })), null);
  assert.equal(parsePidRecord(JSON.stringify({ ...record, pid: '4321' })), null);
  assert.equal(parsePidRecord(JSON.stringify({ ...record, instanceId: '' })), null);
});

test('commandHasInstance：只认带实例标记的命令行', () => {
  assert.equal(commandHasInstance(`node server.ts ${INSTANCE_FLAG}abc-123`, 'abc-123'), true);
  assert.equal(commandHasInstance('node server.ts', 'abc-123'), false);
  assert.equal(commandHasInstance(null, 'abc-123'), false);
  assert.equal(commandHasInstance('node server.ts', ''), false);
});

test('statusLines：固定三行，分别是进程/端口/健康', () => {
  const lines = statusLines({
    api: { running: false, pidFile: false },
    port: { port: 3000, listening: false },
    health: { state: 'unreachable', reason: '连不上：ECONNREFUSED' },
  });
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^进程：/u);
  assert.match(lines[1], /^端口：/u);
  assert.match(lines[2], /^健康：/u);
  assert.match(lines[1], /空闲/u);

  const up = statusLines({
    api: { running: true, pid: 111, mode: 'real', owned: true },
    port: { port: 3000, listening: true, pid: 111, name: 'node.exe' },
    health: { state: 'ready', reason: '200 ok（database=ok, mode=real）' },
  });
  assert.match(up[0], /pid 111/u);
  assert.match(up[1], /pid 111/u);
  assert.match(up[2], /200 ok/u);
});

test('nextStepsLines：指向根路径 /health，并说清 apiBaseUrl 与 prepare-wechat', () => {
  const real = nextStepsLines({ mode: 'real', apiPort: 3000 }).join('\n');
  assert.match(real, /prepare-wechat\.mjs local/u);
  assert.match(real, /http:\/\/127\.0\.0\.1:3000\/api\/v1/u);
  assert.match(real, /127\.0\.0\.1:3000\/health/u);
  assert.match(real, /404/u);
  assert.match(real, /暂无资料/u);

  const stub = nextStepsLines({ mode: 'stub', apiPort: 3100 }).join('\n');
  assert.match(stub, /503/u);
  assert.match(stub, /3100/u);
});

test('resolvePaths：日志/pid/数据目录都挂在一个状态根下', () => {
  const paths = resolvePaths({ stateDir: 'E:/state/demo-stack', repoRoot: 'E:/repo' });
  assert.equal(paths.stateDir, 'E:/state/demo-stack');
  assert.ok(paths.dataDir.endsWith('pgdata'));
  assert.ok(paths.apiLog.endsWith('api.log'));
  assert.ok(paths.pgLog.endsWith('pg.log'));
  assert.ok(paths.pidFile.endsWith('api.pid'));
  assert.ok(paths.secretsFile.endsWith('secrets.env'));
  assert.equal(paths.repoRoot, 'E:/repo');
});

test('secrets.env：往返只保留两把生成的钥匙，值可读回', () => {
  const text = renderSecretsFile({ SESSION_SIGNING_KEY: 's1', DELETION_LEDGER_KEY: 'd1', WECHAT_APP_ID: 'should-not-be-here' });
  assert.match(text, /^#/u);
  assert.ok(!text.includes('should-not-be-here'));
  const back = readSecretsFile(text);
  assert.deepEqual(back, { SESSION_SIGNING_KEY: 's1', DELETION_LEDGER_KEY: 'd1' });
});

test('describeEnvSources：只出现键名与来源，不出现值', () => {
  const lines = describeEnvSources({ DATABASE_URL: 'tool', WECHAT_APP_ID: 'env-file', SESSION_SIGNING_KEY: 'generated' });
  const text = lines.join('\n');
  assert.match(text, /DATABASE_URL ← 本工具生成/u);
  assert.match(text, /WECHAT_APP_ID ← env 文件/u);
  assert.match(text, /SESSION_SIGNING_KEY ← 新生成并已保存/u);
  assert.ok(!text.includes('wx_local_demo'));
});

test('ENV_FILE_TEMPLATE：模板覆盖外部 6 项且提示不提交', () => {
  for (const key of EXTERNAL_KEYS) assert.match(ENV_FILE_TEMPLATE, new RegExp(`^${key}=`, 'mu'));
  assert.match(ENV_FILE_TEMPLATE, /不要提交/u);
});
