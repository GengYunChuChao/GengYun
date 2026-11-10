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
  APPROVAL_FLAGS,
  CONSENT_EMPTY_WARNING,
  DEFAULT_PORTS,
  DEMO_CONSENT_NOTICE,
  DEMO_CONSENT_POLICY_VERSION,
  DEMO_FLAG_KEYS,
  DEMO_FLAG_REASON,
  DEMO_RECIPIENT_ID,
  DEMO_SCHEMA,
  ENV_FILE_TEMPLATE,
  EXTERNAL_KEYS,
  GENERATED_KEYS,
  INSTANCE_FLAG,
  OPTIONAL_REAL_ENV,
  REQUIRED_REAL_ENV,
  UsageError,
  approvalRestartLines,
  assembleApiEnv,
  buildApiApprovalArgs,
  buildConsentReadinessSql,
  buildDemoConsentSql,
  buildDemoConsentStatements,
  buildDemoFlagSql,
  buildDemoFlagStatements,
  buildPidRecord,
  buildPsqlFileArgs,
  classifyFailure,
  commandHasInstance,
  describeEnvSources,
  desiredApprovals,
  detectApprovals,
  healthVerdict,
  nextPollDelay,
  nextStepsLines,
  parseArgs,
  parseConsentReadiness,
  parsePidRecord,
  planRunningStack,
  readEnvFile,
  readSecretsFile,
  renderSecretsFile,
  requiredEnvMissing,
  resolveApprovals,
  resolvePaths,
  statusLines,
  tailLines,
  usage,
  withDemoAccessOrigin,
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
  assert.equal(defaults.demo, false);
  assert.equal(defaults.seedDemo, false);
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
    '--demo',
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
  assert.equal(custom.demo, true);
  assert.equal(custom.seedDemo, false);
});

test('parseArgs：--seed-demo 是显式开关，默认不开，且只配 real', () => {
  assert.equal(parseArgs(['up', '--seed-demo']).seedDemo, true);
  assert.equal(parseArgs(['up', '--seed-demo', '--reset']).seedDemo, true);
  assert.equal(parseArgs(['up']).seedDemo, false);
  // 配错模式要报错，不能静默忽略（否则用户以为灌了演示资料，实际没灌）
  assert.throws(() => parseArgs(['up', '--mode', 'stub', '--seed-demo']), UsageError);
  assert.throws(() => parseArgs(['up', '--seed-demo', '--mode=stub']), /--seed-demo 只在 real 模式生效/u);
});

test('parseArgs：子命令与 --help', () => {
  assert.equal(parseArgs(['down']).command, 'down');
  assert.equal(parseArgs(['status']).command, 'status');
  assert.equal(parseArgs(['logs']).command, 'logs');
  assert.equal(parseArgs(['reset', '--yes']).command, 'reset');
  assert.equal(parseArgs(['--help']).help, true);
  assert.match(usage(), /node tools\/demo-stack\.mjs <up\|down\|status\|logs\|reset>/u);
  assert.match(usage(), /--pg-port/u);
  assert.match(usage(), /--demo/u);
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

test('assembleApiEnv：域内可选键给了就透传、没给不算缺（真演示栈要 MEDIA_OBJECT_REF_KEY 才传得上）', () => {
  const base = {
    mode: 'real',
    apiPort: 3000,
    databaseUrl: 'postgres://postgres@127.0.0.1:55510/gengyun',
    ambient: {},
    generate: () => 'k',
  };
  const keyMaterial = 'a'.repeat(64);
  const withOptional = assembleApiEnv({
    ...base,
    envFile: {
      ...realEnvFile(),
      MEDIA_OBJECT_REF_KEY: keyMaterial,
      RECOGNITION_PROVIDER_URL: 'https://provider.invalid/v1/chat/completions',
      RECOGNITION_PROVIDER_MODEL: 'vision-1',
    },
  });
  assert.deepEqual(withOptional.missing, []);
  assert.equal(withOptional.env.MEDIA_OBJECT_REF_KEY, keyMaterial);
  assert.equal(withOptional.sources.MEDIA_OBJECT_REF_KEY, 'env-file');
  assert.equal(withOptional.env.RECOGNITION_PROVIDER_URL, 'https://provider.invalid/v1/chat/completions');
  assert.equal(withOptional.env.RECOGNITION_PROVIDER_MODEL, 'vision-1');
  assert.ok(OPTIONAL_REAL_ENV.includes('MEDIA_OBJECT_REF_KEY'));
  assert.ok(!REQUIRED_REAL_ENV.includes('MEDIA_OBJECT_REF_KEY'), '启动必填仍是 9 项，可选键不参与 missing');
  assert.ok(describeEnvSources(withOptional.sources).some((line) => line.startsWith('MEDIA_OBJECT_REF_KEY ← env 文件')));

  const without = assembleApiEnv({ ...base, envFile: realEnvFile() });
  assert.deepEqual(without.missing, [], '可选键缺了不算缺');
  for (const key of OPTIONAL_REAL_ENV) assert.equal(without.env[key], undefined, `${key} 没给就不该出现`);
  assert.deepEqual(
    describeEnvSources(without.sources).filter((line) => line.includes('MEDIA_OBJECT_REF_KEY')),
    [],
  );
});

test('buildApiApprovalArgs：只有 --demo + real 才传媒体批准开关（不带 --demo 逐字不变）', () => {
  assert.deepEqual(buildApiApprovalArgs({ demo: true, mode: 'real' }), ['--approve-real-media-wiring']);
  assert.deepEqual(buildApiApprovalArgs({ demo: true, mode: 'stub' }), []);
  assert.deepEqual(buildApiApprovalArgs({ demo: false, mode: 'real' }), []);
  assert.deepEqual(buildApiApprovalArgs({ demo: 'yes', mode: 'real' }), [], '真值字符串不算打开');
  assert.deepEqual(buildApiApprovalArgs({}), []);
});

test('withDemoAccessOrigin：演示档按 API 端口兜底 https 原点，显式值与环境不改动', () => {
  const base = { env: { API_PORT: '38110' }, sources: {} };
  const demo = withDemoAccessOrigin(base, { demo: true, mode: 'real', apiPort: 38110 });
  assert.equal(demo.env.MEDIA_ACCESS_GRANT_ORIGIN, 'https://127.0.0.1:38110');
  assert.equal(demo.sources.MEDIA_ACCESS_GRANT_ORIGIN, 'demo');
  assert.notStrictEqual(demo, base);
  assert.equal(base.env.MEDIA_ACCESS_GRANT_ORIGIN, undefined, '不改调用方的对象');

  const explicit = withDemoAccessOrigin(
    { env: { MEDIA_ACCESS_GRANT_ORIGIN: 'https://example.test' }, sources: { MEDIA_ACCESS_GRANT_ORIGIN: 'env-file' } },
    { demo: true, mode: 'real', apiPort: 38110 },
  );
  assert.equal(explicit.env.MEDIA_ACCESS_GRANT_ORIGIN, 'https://example.test');
  assert.equal(explicit.sources.MEDIA_ACCESS_GRANT_ORIGIN, 'env-file');

  assert.strictEqual(withDemoAccessOrigin(base, { demo: false, mode: 'real', apiPort: 38110 }), base);
  assert.strictEqual(withDemoAccessOrigin(base, { demo: true, mode: 'stub', apiPort: 38110 }), base);
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

test('buildDemoFlagStatements：--demo 才拼 3 条 UPDATE，不带时 0 条', () => {
  assert.deepEqual(buildDemoFlagStatements(), []);
  assert.deepEqual(buildDemoFlagStatements({ demo: false }), []);
  assert.equal(buildDemoFlagSql({ demo: false }), null);

  assert.deepEqual(DEMO_FLAG_KEYS, ['submissions_enabled', 'specific_herbicide_output_enabled', 'ai_enabled']);
  const statements = buildDemoFlagStatements({ demo: true });
  assert.equal(statements.length, 3);
  for (const [index, key] of DEMO_FLAG_KEYS.entries()) {
    const statement = statements[index];
    assert.ok(statement.startsWith('UPDATE public.feature_flags'));
    assert.ok(statement.includes(`WHERE key = '${key}'`));
    assert.ok(statement.includes('SET enabled = true'));
    assert.ok(statement.includes('revision = revision + 1'));
    assert.ok(statement.includes(`reason = '${DEMO_FLAG_REASON}'`));
    assert.ok(statement.includes('changed_at = now()'));
    assert.ok(statement.includes('enabled IS DISTINCT FROM true'));
    assert.ok(statement.endsWith('RETURNING key;'));
  }

  const sql = buildDemoFlagSql({ demo: true });
  assert.equal(sql.split('UPDATE public.feature_flags').length - 1, 3);
  assert.match(sql, /non-production/u);
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

test('pid 记录：档位与批准项一起落盘，旧格式读回是「未知」而不是「没批」', () => {
  const approved = buildPidRecord({
    pid: 4321,
    port: 38110,
    mode: 'real',
    instanceId: 'abc-123',
    startedAt: '2026-11-09T10:00:00.000Z',
    logFile: 'E:/state/api.log',
    demo: true,
    approvals: { media: true, moderation: false },
  });
  assert.equal(approved.demo, true);
  assert.deepEqual(approved.approvals, { media: true, moderation: false });
  assert.deepEqual(parsePidRecord(JSON.stringify(approved)), approved, '批准项必须能读回来');

  // 旧版本写的 pid 文件没有 demo / approvals：`demo` 当 false，`approvals` 当 null（不知道）。
  const legacy = {
    schema: DEMO_SCHEMA,
    pid: 4321,
    port: 38110,
    mode: 'real',
    instanceId: 'abc-123',
    startedAt: '2026-11-09T10:00:00.000Z',
    logFile: 'E:/state/api.log',
  };
  const parsedLegacy = parsePidRecord(JSON.stringify(legacy));
  assert.equal(parsedLegacy.demo, false);
  assert.equal(parsedLegacy.approvals, null, '旧文件没记批准项：不知道，不是「没批」');

  // 手改出来的坏形状也不许被当成「批过」。
  assert.deepEqual(buildPidRecord({ ...legacy, approvals: 'yes' }).approvals, null);
  assert.deepEqual(buildPidRecord({ ...legacy, approvals: { media: 'true' } }).approvals, { media: false, moderation: false });
});

test('批准项：要求项与真正拼进命令行的参数同源（批的是什么，记的就是什么）', () => {
  assert.equal(APPROVAL_FLAGS.media, '--approve-real-media-wiring');
  assert.equal(APPROVAL_FLAGS.moderation, '--approve-moderation-live-wiring');
  assert.deepEqual(desiredApprovals({ demo: true, mode: 'real' }), { media: true, moderation: false });
  assert.deepEqual(desiredApprovals({ demo: true, mode: 'stub' }), { media: false, moderation: false });
  assert.deepEqual(desiredApprovals({ demo: false, mode: 'real' }), { media: false, moderation: false });
});

test('detectApprovals / resolveApprovals：命令行是真值，读不到才退回 pid 记录', () => {
  assert.deepEqual(detectApprovals('node server.ts --gy-demo-stack-instance=x --approve-real-media-wiring'), { media: true, moderation: false });
  assert.deepEqual(detectApprovals('node server.ts --gy-demo-stack-instance=x'), { media: false, moderation: false });
  assert.equal(detectApprovals(null), null, '拿不到命令行 = 不知道，不是 false');
  assert.equal(detectApprovals(''), null);
  assert.equal(detectApprovals('   '), null);

  const record = { approvals: { media: true, moderation: false } };
  assert.deepEqual(resolveApprovals({ commandLine: 'node x --approve-real-media-wiring', record }), {
    approvals: { media: true, moderation: false },
    source: 'command-line',
  });
  assert.deepEqual(resolveApprovals({ commandLine: null, record }), { approvals: { media: true, moderation: false }, source: 'pid-record' });
  assert.deepEqual(resolveApprovals({ commandLine: 'node x', record }), { approvals: { media: false, moderation: false }, source: 'command-line' }, '能读到命令行就以它为准，不信旧记录');
  assert.deepEqual(resolveApprovals({ commandLine: null, record: { approvals: null } }), { approvals: null, source: 'unknown' });
  assert.deepEqual(resolveApprovals({}), { approvals: null, source: 'unknown' });
});

test('planRunningStack：已就绪但缺批准 ⇒ restart（这就是「不许静默通过」的判据）', () => {
  const record = buildPidRecord({ pid: 5592, port: 38110, mode: 'real', instanceId: 'inst-1', startedAt: '2026-11-09T10:00:00.000Z', logFile: 'E:/state/api.log' });
  const commandLine = `node server.ts --gy-demo-stack-instance=inst-1`;

  const missing = planRunningStack({ record, commandLine, demo: true, mode: 'real' });
  assert.equal(missing.action, 'restart');
  assert.equal(missing.reason, 'missing-approval');
  assert.deepEqual(missing.missing, ['media']);
  assert.deepEqual(missing.current, { media: false, moderation: false });
  assert.deepEqual(missing.desired, { media: true, moderation: false });
  assert.match(approvalRestartLines(missing).join('\n'), /检测到既有实例未带 --approve-real-media-wiring，已重启 API（数据目录保留）/u);
});

test('planRunningStack：同样档位重复 up 不重启；要撤批准也不打断在跑的演示', () => {
  const record = buildPidRecord({ pid: 5592, port: 38110, mode: 'real', instanceId: 'inst-1', startedAt: '2026-11-09T10:00:00.000Z', logFile: 'E:/state/api.log' });

  const same = planRunningStack({
    record,
    commandLine: 'node server.ts --gy-demo-stack-instance=inst-1 --approve-real-media-wiring',
    demo: true,
    mode: 'real',
  });
  assert.equal(same.action, 'reuse');
  assert.equal(same.reason, 'same-profile');
  assert.deepEqual(same.missing, []);

  // 不带 --demo 的 up 打到已批准的实例上：不重启（fail-closed 方向是安全的一侧，撤批准不是正确性要求）。
  const extra = planRunningStack({
    record,
    commandLine: 'node server.ts --gy-demo-stack-instance=inst-1 --approve-real-media-wiring',
    demo: false,
    mode: 'real',
  });
  assert.equal(extra.action, 'reuse');
  assert.equal(extra.reason, 'extra-approval');
  assert.deepEqual(extra.extra, ['media']);

  // stub 档不需要媒体批准：即使实例没带，也照样复用。
  const stub = planRunningStack({ record, commandLine: 'node server.ts --gy-demo-stack-instance=inst-1', demo: true, mode: 'stub' });
  assert.equal(stub.action, 'reuse');
});

test('planRunningStack：命令行与旧记录都读不到批准项时，按「没批」处理并说明原因', () => {
  const legacyRecord = { schema: DEMO_SCHEMA, pid: 5592, port: 38110, mode: 'real', instanceId: 'inst-1' };
  const parsed = parsePidRecord(JSON.stringify(legacyRecord));
  const unknown = planRunningStack({ record: parsed, commandLine: null, demo: true, mode: 'real' });
  assert.equal(unknown.action, 'restart');
  assert.equal(unknown.reason, 'approvals-unknown');
  assert.deepEqual(unknown.missing, ['media']);
  assert.match(approvalRestartLines(unknown).join('\n'), /批准项无法确认/u);
  assert.match(approvalRestartLines(unknown).join('\n'), /已重启 API（数据目录保留）/u);

  // 没有要求批准项时，「不知道」不构成重启理由。
  assert.equal(planRunningStack({ record: parsed, commandLine: null, demo: false, mode: 'real' }).action, 'reuse');
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

test('statusLines：进程行如实报媒体批准，未知就写未知（不写猜的「已带」）', () => {
  const base = {
    port: { port: 38110, listening: true, pid: 111, name: 'node.exe' },
    health: { state: 'ready', reason: '200 ok（database=ok, mode=real）' },
  };
  const render = (approvals) => statusLines({ ...base, api: { running: true, pid: 111, mode: 'real', owned: true, approvals } });

  const approved = render({ media: true, moderation: false });
  assert.equal(approved.length, 3, '仍是三行：批准项挂在进程行上');
  assert.match(approved[0], /媒体批准=已带/u);

  const missing = render({ media: false, moderation: false });
  assert.match(missing[0], /媒体批准=未带/u);

  const unknown = render(null);
  assert.match(unknown[0], /媒体批准=未知/u);
  assert.doesNotMatch(unknown[0], /已带/u);

  const dead = statusLines({ api: { running: false, pidFile: true }, port: { port: 38110, listening: false }, health: {} });
  assert.equal(dead[0], '进程：API 未运行', '没跑就别谈批准项');
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

test('nextStepsLines：带 --seed-demo 时改说「演示卡片」，不再说「暂无资料」', () => {
  const seeded = nextStepsLines({ mode: 'real', apiPort: 3000, seedDemo: true }).join('\n');
  assert.match(seeded, /--seed-demo/u);
  assert.match(seeded, /演示/u);
  assert.match(seeded, /非生产数据/u);
  assert.ok(!/暂无资料/u.test(seeded), '带 --seed-demo 还提示「暂无资料」会把用户引回空首页');

  // 默认（不传 seedDemo）保持原文案：不能因为新参数把老行为改了
  const plain = nextStepsLines({ mode: 'real', apiPort: 3000 }).join('\n');
  assert.match(plain, /暂无资料/u);
  // stub 分支不受影响
  assert.match(nextStepsLines({ mode: 'stub', apiPort: 3100, seedDemo: false }).join('\n'), /503/u);
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

test('演示政策：不带 --demo 一条语句都不生成（行为与旧版一致）', () => {
  for (const options of [undefined, {}, { demo: false }, { demo: 0 }, { demo: 'yes' }]) {
    assert.deepEqual(buildDemoConsentStatements(options), [], JSON.stringify(options));
    assert.equal(buildDemoConsentSql(options), null, JSON.stringify(options));
  }
  assert.deepEqual(buildDemoConsentStatements(), []);
});

test('演示政策：--demo 生成 7 条语句，顺序是 复核账号 → 两个接收方 → 停用旧演示版本 → 两条政策 → 启用', () => {
  const statements = buildDemoConsentStatements({ demo: true });
  assert.equal(statements.length, 7);
  assert.match(statements[0], /^INSERT INTO public\.admin_accounts/u);
  assert.match(statements[1], /^INSERT INTO public\.recipients/u);
  assert.match(statements[1], /'weed'/u);
  assert.match(statements[2], /^INSERT INTO public\.recipients/u);
  assert.match(statements[2], /'tts'/u, '合成域按 capability=tts 找唯一接收方（privacy/ledger-pg.ts 的 resolveRecipient）');
  assert.match(statements[3], /^UPDATE public\.consent_policies/u);
  assert.match(statements[3], /demo-stack-local-%/u, '只停自家旧版本');
  assert.match(statements[4], /^INSERT INTO public\.consent_policies/u);
  assert.match(statements[4], /'media_processing'/u);
  assert.match(statements[5], /^INSERT INTO public\.consent_policies/u);
  assert.match(statements[5], /'external_inference'/u);
  assert.match(statements[6], /^UPDATE public\.consent_policies/u);

  const sql = buildDemoConsentSql({ demo: true });
  assert.equal(typeof sql, 'string');
  assert.equal(sql.split('INSERT INTO public.consent_policies').length - 1, 2, '两条政策各一条 INSERT');
  assert.equal(sql.split('INSERT INTO public.recipients').length - 1, 2, '识别与合成各一个接收方');
  assert.equal(sql.split('INSERT INTO public.admin_accounts').length - 1, 1);
});

test('演示政策：两条 purpose 同版本且都绑同一接收方（外发预留要求每个必需用途都列出接收方）', () => {
  const [admin, recipient, ttsRecipient, retireOld, media, external, enable] = buildDemoConsentStatements({ demo: true });
  assert.match(admin, /demo-stack-operator/u);
  assert.ok(!(admin.includes('password') || admin.includes('scrypt$')), '演示复核账号不许写可用口令');
  assert.match(admin, /ON CONFLICT \(login_name\) DO NOTHING/u);

  assert.match(recipient, new RegExp(`'${DEMO_RECIPIENT_ID}'`, 'u'));
  assert.match(recipient, /'weed'/u);
  assert.match(recipient, new RegExp(`'${DEMO_CONSENT_POLICY_VERSION}'`, 'u'));
  assert.match(recipient, /tokenhub\.tencentmaas\.com/u, '接收方必须指向识别供应商端点域名');
  assert.match(recipient, /ON CONFLICT \(id\) DO UPDATE/u);
  assert.match(recipient, /IS DISTINCT FROM/u, '幂等：逐列比较，内容没变就不写');

  assert.match(ttsRecipient, /'demo-stack-tts-tencent'/u);
  assert.match(ttsRecipient, /'tts'/u, '合成外发只认 capability=tts 的接收方');
  assert.match(ttsRecipient, new RegExp(`'${DEMO_CONSENT_POLICY_VERSION}'`, 'u'));
  assert.match(ttsRecipient, /tts\.tencentcloudapi\.com/u, '接收方必须指向合成供应商端点域名');
  assert.match(ttsRecipient, /ON CONFLICT \(id\) DO UPDATE/u);
  assert.match(ttsRecipient, /IS DISTINCT FROM/u);

  assert.match(retireOld, /enabled = false/u);
  assert.match(retireOld, /policy_version LIKE 'demo-stack-local-%'/u);
  assert.match(retireOld, new RegExp(`policy_version <> '${DEMO_CONSENT_POLICY_VERSION}'`, 'u'));

  for (const statement of [media, external]) {
    assert.match(statement, new RegExp(`'${DEMO_CONSENT_POLICY_VERSION}'`, 'u'));
    assert.match(statement, /'verified'/u);
    assert.ok(statement.includes(DEMO_RECIPIENT_ID), '两条政策都绑定演示接收方');
    assert.ok(statement.includes('demo-stack-tts-tencent'), '两条政策都绑定合成接收方（外发预留按用途列接收方）');
  }
  assert.match(media, /'media_processing'/u);
  assert.match(external, /'external_inference'/u);

  assert.match(enable, /enabled IS DISTINCT FROM true/u);
  assert.match(enable, /RETURNING purpose;/u);
});

test('演示政策：所有字面量是 ASCII（psql -c 在 Windows 上按 ANSI 代码页传参）', () => {
  const sql = buildDemoConsentSql({ demo: true });
  assert.equal([...sql].filter((char) => char.codePointAt(0) > 0x7f).length, 0, 'SQL 里出现非 ASCII 会在服务端报 invalid byte sequence');
  assert.match(sql, /demo-stack local demo profile \(non-production\)/u, '标记必须逐字存在');
});

test('演示政策：标记落在既有可见列，且不下线别人的政策', () => {
  const statements = buildDemoConsentStatements({ demo: true });
  const all = statements.join('\n');
  const marker = 'demo-stack local demo profile (non-production)';
  assert.ok(statements[0].includes(marker), '复审账号的 credential_hash 带标记');
  assert.ok(statements[1].includes(marker), '接收方 display_name 带标记');
  const policyInserts = statements.filter((statement) => /^INSERT INTO public\.consent_policies/u.test(statement));
  assert.equal(policyInserts.length, 2);
  for (const statement of policyInserts) {
    assert.match(statement, /source_ref/u);
    assert.match(statement, /review_evidence_ref/u);
    assert.ok(statement.includes(marker), '政策 source_ref / review_evidence_ref 带标记');
  }
  assert.equal(/^\s*DELETE\s/mu.test(all), false, '⛔ 不删任何行');
  assert.equal(/^\s*TRUNCATE\s/mu.test(all), false, '⛔ 不截断');
  const disableStatements = statements.filter((statement) => /enabled\s*=\s*false/u.test(statement));
  assert.equal(disableStatements.length, 1, '只停自家的旧演示版本，别的一条都不动');
  assert.match(disableStatements[0], /policy_version LIKE 'demo-stack-local-%'/u);
  assert.ok(disableStatements[0].includes(`policy_version <> '${DEMO_CONSENT_POLICY_VERSION}'`), '当前版本不在此列');
});

test('演示政策：语料里明确写「不是生产核验」', () => {
  assert.match(DEMO_CONSENT_NOTICE, /这是本机演示政策，不是生产核验/u);
  assert.match(CONSENT_EMPTY_WARNING, /识别动线会 403/u);
  assert.match(CONSENT_EMPTY_WARNING, /--demo/u);
  assert.match(CONSENT_EMPTY_WARNING, /import-consent-policy\/recipient/u);
});

test('政策就绪读数：只数「已启用 + verified + 已复核 + 在有效期内」的行', () => {
  const sql = buildConsentReadinessSql();
  assert.match(sql, /FROM public\.consent_policies/u);
  assert.match(sql, /enabled/u);
  assert.match(sql, /source_kind\s*=\s*'verified'/u);
  assert.match(sql, /reviewed_at IS NOT NULL/u);
  assert.match(sql, /valid_from\s*<=\s*clock_timestamp\(\)/u);
  assert.match(sql, /valid_until\s*>\s*clock_timestamp\(\)/u);
});

test('政策就绪解析：数字读得出，读不出就是 null（不猜 0）', () => {
  assert.equal(parseConsentReadiness('enabled_verified_policies=2\n(1 row)\n'), 2);
  assert.equal(parseConsentReadiness('enabled_verified_policies=0'), 0);
  assert.equal(parseConsentReadiness(''), null);
  assert.equal(parseConsentReadiness('ERROR: relation "consent_policies" does not exist'), null);
  assert.equal(parseConsentReadiness(null), null);
  assert.equal(parseConsentReadiness('enabled_verified_policies=many'), null);
});
