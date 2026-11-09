/**
 * 本机演示栈（`tools/demo-stack.mjs`）的纯逻辑层。
 *
 * ⛔ 本文件**不**起 PostgreSQL、**不**起 API、**不**发 HTTP、**不**读环境变量、**不**碰文件系统：
 * 参数解析、env 组装、健康轮询判据、失败分类、日志截尾、状态三行全部是纯函数，
 * 由 `tests/unit/demo-stack.test.mjs` 直接喂输入断言；真起服务的部分只在 `tools/demo-stack.mjs`
 * 与运行手册的手动 smoke 里（见 `docs/demo/本地演示-stack.md`）。
 *
 * 约定：
 * - 任何函数都不打印、不落盘；密钥只在返回值里以「键名」出现，值不进入日志（调用方负责）。
 * - 端口一律 1..65535 的整数，非法值抛 `UsageError`（命令行错误，退出码 1）。
 */
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { AI_ENDPOINTS } from '../ai-config.mjs';
import { CAPABILITY_GROUPS } from './real-capability-config.mjs';

/** 演示栈状态文件/pid 文件的版本标识；换格式时递增，读旧文件直接拒绝。 */
export const DEMO_SCHEMA = 'gengyun-demo-stack/1';

export const SUBCOMMANDS = ['up', 'down', 'status', 'logs', 'reset'];

export const MODES = ['stub', 'real'];

/** API 与一次性 PG 簇的默认端口（PG 刻意避开 5432/55436 这些既有实例）。 */
export const DEFAULT_PORTS = { api: 3000, pg: 55510 };

/**
 * 附加到 API 进程的 argv 标记。API 启动器只扫描它认识的
 * `--approve-real-media-wiring` / `--approve-moderation-live-wiring`，未知参数被忽略
 * （`services/api/src/server.ts:38-52`），所以这个标记只用于 `down` 时确认「这个 pid 是本工具起的」。
 */
export const INSTANCE_FLAG = '--gy-demo-stack-instance=';

/** real 模式必须齐备的 9 项（与 `services/api/src/config.ts:147-157` 的 REQUIRED_WHEN_REAL 同源）。 */
export const REQUIRED_REAL_ENV = [
  'DATABASE_URL',
  'SESSION_SIGNING_KEY',
  'DELETION_LEDGER_KEY',
  'WECHAT_APP_ID',
  'WECHAT_APP_SECRET',
  'OBJECT_STORAGE_ENDPOINT',
  'OBJECT_STORAGE_BUCKET',
  'OBJECT_STORAGE_ACCESS_KEY',
  'OBJECT_STORAGE_SECRET_KEY',
];

/** 本工具自己能生成的两项（本地签名用，只在 real 模式需要；值写进 state-dir/secrets.env）。 */
export const GENERATED_KEYS = ['SESSION_SIGNING_KEY', 'DELETION_LEDGER_KEY'];

/** 只能由调用方提供的 6 项（微信 2 项 + 对象存储 4 项）：工具不生成、不猜测。 */
export const EXTERNAL_KEYS = REQUIRED_REAL_ENV.filter((key) => !GENERATED_KEYS.includes(key) && key !== 'DATABASE_URL');

/**
 * 「域内必填、启动不必填」的键：`services/api/src/config.ts` 只在 real 启动时校验
 * `REQUIRED_REAL_ENV` 那 9 项；`MEDIA_OBJECT_REF_KEY`、`RECOGNITION_PROVIDER_*` 这类键缺了照样
 * 起得来，只是对应域按域拒绝（媒体域整域 503、识别受理 503）——详见
 * `tools/lib/real-capability-config.mjs` 的文件头。
 *
 * 演示栈的口径：env 文件里**给了就透传**，没给不报错也不生成（缺了由 API 自己按域拒绝，
 * 错误信息比这里猜的准）。名单从 `CAPABILITY_GROUPS` 派生，避免和真实能力清单各写一份。
 * `RECOGNITION_PROVIDER_PROFILE` / `RECOGNITION_PROVIDER_MODEL` 不在能力组里，但
 * `services/api/src/app.ts:1124` 直接读它们，所以一并登记。
 */
export const OPTIONAL_REAL_ENV = Object.freeze([
  ...new Set([
    ...CAPABILITY_GROUPS.flatMap((group) => group.fields.map((item) => item.name)),
    'RECOGNITION_PROVIDER_PROFILE',
    'RECOGNITION_PROVIDER_MODEL',
  ]),
]
  .filter((key) => !REQUIRED_REAL_ENV.includes(key))
  .sort());

export const ENV_FILE_TEMPLATE = `# 演示栈 env 文件（不要提交；值从 E:\\GengYunPrivate\\credentials.local.json 取）
# DATABASE_URL 由 tools/demo-stack.mjs 按自己的簇生成，这里写了也会被覆盖。
WECHAT_APP_ID=...
WECHAT_APP_SECRET=...
OBJECT_STORAGE_ENDPOINT=https://...
OBJECT_STORAGE_BUCKET=...
OBJECT_STORAGE_ACCESS_KEY=...
OBJECT_STORAGE_SECRET_KEY=...
# 可选：不写则由工具生成并保存在 state-dir/secrets.env
# SESSION_SIGNING_KEY=...
# DELETION_LEDGER_KEY=...
`;

/** 命令行用法错误：消息直接给用户看，退出码 1。 */
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

const PORT_MIN = 1;
const PORT_MAX = 65535;

function parseInteger(raw, label, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  const text = String(raw ?? '').trim();
  if (!/^\d+$/u.test(text)) throw new UsageError(`${label} 必须是 ${min}..${max} 的整数，收到「${text}」`);
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new UsageError(`${label} 必须是 ${min}..${max} 的整数，收到「${text}」`);
  }
  return value;
}

function parsePort(raw, label) {
  return parseInteger(raw, label, { min: PORT_MIN, max: PORT_MAX });
}

/**
 * 解析 argv（不含 `node` 与脚本名）。
 *
 * 未知参数**报错**而不是忽略：演示栈最怕「参数写错了但看起来起来了」，
 * 例如把 `--mode real` 敲成 `--mode=real` 时静默 fallback 到 stub 会让首页 503。
 */
export function parseArgs(argv = []) {
  const args = [...argv];
  const options = {
    command: 'up',
    mode: 'real',
    apiPort: DEFAULT_PORTS.api,
    pgPort: DEFAULT_PORTS.pg,
    envFile: null,
    stateDir: null,
    pgBin: null,
    timeoutMs: 90_000,
    reset: false,
    yes: false,
    demo: false,
    lines: 40,
    json: false,
    help: false,
    apiPortExplicit: false,
    pgPortExplicit: false,
  };
  const positionals = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--help' || token === '-h') {
      options.help = true;
      continue;
    }
    if (token === '--json') {
      options.json = true;
      continue;
    }
    if (token === '--reset') {
      options.reset = true;
      continue;
    }
    if (token === '--yes' || token === '-y') {
      options.yes = true;
      continue;
    }
    if (token === '--demo') {
      options.demo = true;
      continue;
    }
    if (!token.startsWith('-')) {
      positionals.push(token);
      continue;
    }
    const [flag, inline] = token.includes('=') ? [token.slice(0, token.indexOf('=')), token.slice(token.indexOf('=') + 1)] : [token, null];
    const takeValue = () => {
      if (inline !== null) return inline;
      const next = args[index + 1];
      if (next === undefined || next.startsWith('--')) throw new UsageError(`${flag} 需要一个值`);
      index += 1;
      return next;
    };
    switch (flag) {
      case '--mode':
        options.mode = takeValue();
        break;
      case '--port':
        options.apiPort = parsePort(takeValue(), '--port');
        options.apiPortExplicit = true;
        break;
      case '--pg-port':
        options.pgPort = parsePort(takeValue(), '--pg-port');
        options.pgPortExplicit = true;
        break;
      case '--env-file':
        options.envFile = takeValue();
        break;
      case '--state-dir':
        options.stateDir = takeValue();
        break;
      case '--pg-bin':
        options.pgBin = takeValue();
        break;
      case '--timeout-ms':
        options.timeoutMs = parseInteger(takeValue(), '--timeout-ms', { min: 1000, max: 3_600_000 });
        break;
      case '--lines':
        options.lines = parseInteger(takeValue(), '--lines', { min: 1, max: 5000 });
        break;
      default:
        throw new UsageError(`未知参数「${flag}」；跑 \`node tools/demo-stack.mjs --help\` 看可用参数`);
    }
  }

  if (positionals.length > 1) throw new UsageError(`只接受一个子命令，收到：${positionals.join(' ')}`);
  if (positionals.length === 1) options.command = positionals[0];
  if (!SUBCOMMANDS.includes(options.command)) {
    throw new UsageError(`未知子命令「${options.command}」；可用：${SUBCOMMANDS.join(' / ')}`);
  }
  if (!MODES.includes(options.mode)) {
    throw new UsageError(`--mode 只能是 ${MODES.join(' 或 ')}，收到「${options.mode}」`);
  }
  if (options.timeoutMs < 1000) throw new UsageError('--timeout-ms 至少 1000');

  return options;
}

export function usage() {
  return [
    '用法：node tools/demo-stack.mjs <up|down|status|logs|reset> [选项]',
    '',
    '子命令：',
    '  up       起一次性 PG 簇 → 建库 → 迁移 →（real）种子 → 后台起 API → 等 /health 200',
    '  down     停 API 与 PG 簇（保留数据目录，下次 up 直接复用）',
    '  status   打印「进程 / 端口 / 健康」三行结论',
    '  logs     打印 API 日志与 PG 日志的尾部',
    '  reset    停栈并删除数据目录（需 --yes；下次 up 会重新 initdb）',
    '',
    '选项：',
    '  --mode stub|real   执行模式，默认 real（real 才能让首页返回 200，见运行手册）',
    '  --port <n>         API 端口，默认 3000',
    '  --pg-port <n>      PG 端口，默认 55510（只监听 127.0.0.1）',
    '  --env-file <path>  real 模式的凭据 env 文件（KEY=VALUE；不提交）',
    '  --state-dir <dir>  状态目录（数据目录/日志/pid），默认 <仓库上级>/.pg17/demo-stack',
    '  --pg-bin <dir>     PostgreSQL bin 目录，默认 <仓库上级>/.pg17/pgsql/bin',
    '  --timeout-ms <n>   等 /health 200 的上限，默认 90000',
    '  --lines <n>        logs 打印行数，默认 40',
    '  --demo             演示档：把三个 feature flag 置为开启（仅本机演示；幂等）',
    '  --reset            up 前先重来一遍（停栈 + 删数据目录）',
    '  --yes, -y          reset 的确认开关',
    '',
    '示例：',
    '  node tools/demo-stack.mjs up --mode real --env-file .secrets/demo.env',
    '  node tools/demo-stack.mjs status',
    '  node tools/demo-stack.mjs down',
  ].join('\n');
}

/**
 * 解析 `KEY=VALUE` env 文件（允许空行、`#` 注释、`export ` 前缀、单双引号包裹的值）。
 * 只做语法解析，不判断「是不是合法凭据」——那是 API 自己的 config 校验。
 */
export function readEnvFile(text) {
  const values = {};
  const errors = [];
  // 记事本/VS Code「UTF-8 with BOM」存出来的文件首键会带上 U+FEFF，剥掉再解析（否则第一项永远缺）。
  const lines = String(text ?? '').replace(/^\uFEFF/u, '').split(/\r?\n/u);
  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) return;
    const withoutExport = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) {
      errors.push({ line: index + 1, reason: '不是 KEY=VALUE 形式' });
      return;
    }
    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      errors.push({ line: index + 1, reason: `键名不合法：${key}` });
      return;
    }
    let value = withoutExport.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    values[key.toUpperCase()] = value;
  });
  return { values, errors };
}

/** 合并后的 env 里，real 模式还缺哪几项（顺序同 REQUIRED_REAL_ENV，便于照着补）。 */
export function requiredEnvMissing(env, mode) {
  if (mode !== 'real') return [];
  return REQUIRED_REAL_ENV.filter((key) => {
    const value = env?.[key];
    return typeof value !== 'string' || value.trim() === '';
  });
}

/**
 * 组装 API 子进程的 env 覆盖层。
 *
 * - `APP_EXECUTION_MODE` / `API_HOST` / `API_PORT` 由本工具决定，覆盖 env 文件里的同名值；
 * - `DATABASE_URL` 永远指向本次的簇（env 文件里写了别的库也不采用，避免「连到别的库还以为是演示栈」）；
 * - `SESSION_SIGNING_KEY` / `DELETION_LEDGER_KEY` 缺了就生成（生成值由调用方持久化，重启沿用）；
 * - 微信/对象存储 6 项缺了**不生成**：返回 `missing` 让调用方报错，绝不伪造 https 端点；
 * - `OPTIONAL_REAL_ENV`（`MEDIA_OBJECT_REF_KEY`、`RECOGNITION_PROVIDER_*` 等）给了就透传，
 *   没给不算缺：缺了 API 起得来、对应域按域拒绝（媒体 503），这里不替它编值。
 */
export function assembleApiEnv({
  mode,
  apiPort,
  host = '127.0.0.1',
  databaseUrl,
  envFile = {},
  ambient = {},
  existingGenerated = {},
  generate = () => randomBytes(32).toString('base64url'),
} = {}) {
  if (!MODES.includes(mode)) throw new UsageError(`mode 只能是 ${MODES.join(' 或 ')}`);
  if (!Number.isInteger(apiPort) || apiPort < PORT_MIN || apiPort > PORT_MAX) throw new UsageError('apiPort 非法');

  const env = {
    APP_EXECUTION_MODE: mode,
    API_HOST: host,
    API_PORT: String(apiPort),
    LOG_LEVEL: ambient.LOG_LEVEL ?? 'info',
  };
  const sources = { APP_EXECUTION_MODE: 'tool', API_HOST: 'tool', API_PORT: 'tool', LOG_LEVEL: ambient.LOG_LEVEL ? 'process' : 'default' };
  const generated = [];

  if (mode !== 'real') return { env, sources, generated, missing: [] };

  env.DATABASE_URL = databaseUrl;
  sources.DATABASE_URL = 'tool';

  for (const key of REQUIRED_REAL_ENV) {
    if (key === 'DATABASE_URL') continue;
    const fromFile = envFile[key];
    const fromAmbient = ambient[key];
    const fromExisting = existingGenerated[key];
    if (typeof fromFile === 'string' && fromFile.trim() !== '') {
      env[key] = fromFile.trim();
      sources[key] = 'env-file';
    } else if (typeof fromAmbient === 'string' && fromAmbient.trim() !== '') {
      env[key] = fromAmbient.trim();
      sources[key] = 'process';
    } else if (GENERATED_KEYS.includes(key)) {
      const value = typeof fromExisting === 'string' && fromExisting.trim() !== '' ? fromExisting.trim() : generate();
      env[key] = value;
      sources[key] = typeof fromExisting === 'string' && fromExisting.trim() !== '' ? 'state-dir' : 'generated';
      if (sources[key] === 'generated') generated.push(key);
    }
  }

  const missing = requiredEnvMissing(env, mode);
  for (const key of missing) delete env[key];

  for (const key of OPTIONAL_REAL_ENV) {
    const fromFile = envFile[key];
    const fromAmbient = ambient[key];
    const fromExisting = existingGenerated[key];
    if (typeof fromFile === 'string' && fromFile.trim() !== '') {
      env[key] = fromFile.trim();
      sources[key] = 'env-file';
    } else if (typeof fromAmbient === 'string' && fromAmbient.trim() !== '') {
      env[key] = fromAmbient.trim();
      sources[key] = 'process';
    } else if (typeof fromExisting === 'string' && fromExisting.trim() !== '') {
      env[key] = fromExisting.trim();
      sources[key] = 'state-dir';
    }
  }

  return { env, sources, generated, missing };
}

/**
 * 一次健康探测的判据。
 * @param {{statusCode?: number|null, body?: unknown, error?: string|null}} probe
 * @returns {{state: 'ready'|'degraded'|'unreachable'|'unexpected', retryable: boolean, reason: string}}
 */
export function healthVerdict(probe = {}) {
  if (probe.error) {
    return { state: 'unreachable', retryable: true, reason: `连不上：${probe.error}` };
  }
  const statusCode = probe.statusCode ?? null;
  const body = probe.body;
  const mode = body && typeof body === 'object' ? body.meta?.execution_mode : null;
  if (statusCode === 200) {
    if (body && typeof body === 'object' && body.status === 'ok') {
      const database = body.checks?.database?.status ?? '未知';
      return { state: 'ready', retryable: false, reason: `200 ok（database=${database}${mode ? `, mode=${mode}` : ''}）` };
    }
    return { state: 'degraded', retryable: true, reason: `200 但 status=${String(body?.status)}` };
  }
  if (statusCode === 503) {
    const database = body?.checks?.database;
    const detail = database ? `database=${String(database.status)}${database.category ? `/${database.category}` : ''}` : '无响应体';
    return { state: 'degraded', retryable: true, reason: `503 ${detail}` };
  }
  if (statusCode === 404) {
    return { state: 'unexpected', retryable: true, reason: '404：健康端点在根路径 /health，不在 /api/v1 下' };
  }
  if (statusCode === 401 || statusCode === 403) {
    return { state: 'unexpected', retryable: true, reason: `HTTP ${String(statusCode)}：这个端口上的服务不是本栈 API（本栈 /health 不需要鉴权）` };
  }
  return { state: 'unexpected', retryable: true, reason: `HTTP ${String(statusCode)}` };
}

/** 轮询退避：400ms 起，×1.5，封顶 2000ms（纯函数，便于断言「不会立刻打满」）。 */
export function nextPollDelay(attempt, { initialMs = 400, factor = 1.5, maxMs = 2000 } = {}) {
  const index = Number.isInteger(attempt) && attempt > 0 ? attempt : 0;
  return Math.min(maxMs, Math.round(initialMs * factor ** index));
}

/**
 * 失败分类：把「起不来」收敛成一组可执行结论，而不是让用户读栈。
 * @param {{stage?: string, timedOut?: boolean, exitCode?: number|null, output?: string}} failure
 * @returns {{code: string, hint: string}}
 */
export function classifyFailure(failure = {}) {
  const stage = failure.stage ?? 'unknown';
  const output = String(failure.output ?? '');

  const rules = [
    {
      code: 'PORT_IN_USE',
      test: /EADDRINUSE|address already in use|无法绑定|bind.*in use/iu,
      hint: '端口被占用：看 status 里点名的 PID，换 --port（API）或 --pg-port（PG），或先关掉占用进程',
    },
    {
      code: 'API_CONFIG_MISSING',
      test: /\[MISSING\]|缺少必填|ConfigError/iu,
      hint: 'real 模式缺 env：按上面的字段名补 --env-file（微信与对象存储 6 项必须来自真实凭据）',
    },
    {
      code: 'AUTH_FAILED',
      test: /password authentication failed|认证失败/iu,
      hint: 'PG 认证失败：本工具用 trust 认证的一次性簇；若改成口令簇，请删掉数据目录重来（reset --yes）',
    },
    {
      code: 'DB_UNREACHABLE',
      test: /ECONNREFUSED|connection refused|连接被拒绝|could not connect/iu,
      hint: '连不上 PG：先 `status` 看簇在不在，或 `logs` 看 pg.log；必要时 reset --yes 重建',
    },
    {
      code: 'MIGRATION_DRIFT',
      test: /drift|校验和不一致|checksum/iu,
      hint: '迁移台账与文件不一致：数据目录是旧的，reset --yes 重建（会丢本机演示数据）',
    },
  ];
  for (const rule of rules) {
    if (rule.test.test(output)) return { code: rule.code, hint: rule.hint };
  }

  if (failure.timedOut && stage === 'health') {
    return {
      code: 'HEALTH_TIMEOUT',
      hint: 'API 进程没在时限内变成 200：看上面 API 日志尾部；real 模式常见原因是 DATABASE_URL 连不上或缺 env',
    };
  }
  const byStage = {
    'pg-init': { code: 'PG_INIT_FAILED', hint: 'initdb 失败：确认 --pg-bin 指向 PG 17 的 bin 目录，且数据目录可写' },
    'pg-start': { code: 'PG_START_FAILED', hint: '簇没起来：看 pg.log 尾部（端口占用/数据目录被别的版本占用最常见）' },
    createdb: { code: 'CREATEDB_FAILED', hint: '建库失败：看上面的 psql 报错；多半是簇没起或权限问题' },
    migrate: { code: 'MIGRATE_FAILED', hint: '迁移失败：把上面的 psql 报错原文发出来；reset --yes 可重来' },
    seed: { code: 'SEED_FAILED', hint: '种子失败：种子 SQL 期望先跑完迁移；reset --yes 后重试' },
    'demo-profile': { code: 'DEMO_PROFILE_FAILED', hint: '演示开关写入失败：确认迁移 0020 已应用、psql 能连上库；reset --yes 后重试' },
    'api-start': { code: 'API_EXITED', hint: 'API 进程退出了：看上面 API 日志尾部（缺 env / 端口占用 / 语法错）' },
    health: { code: 'HEALTH_NOT_READY', hint: '健康检查没通过：看 API 日志尾部与 `status` 输出' },
  };
  if (failure.stage === 'api-start' && failure.exitCode === 0) {
    return { code: 'API_EXITED', hint: 'API 进程立刻退出了（exit 0）：多半是被别的实例抢占或被信号终止' };
  }
  return byStage[stage] ?? { code: 'UNKNOWN', hint: '看上面的输出；仍然看不懂就 `logs` 取尾部日志' };
}

/** 取文本最后 n 行（CRLF 归一；末尾空行丢掉）；空文本返回空串。 */
export function tailLines(text, n = 30) {
  const clean = String(text ?? '').replace(/\r\n/gu, '\n');
  if (clean.trim() === '') return '';
  const lines = clean.split('\n');
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.slice(Math.max(0, lines.length - Math.max(1, n))).join('\n');
}

/** psql 执行 SQL 文件（种子用）：-f 而不是 -c，避免超长语句被命令行截断。 */
export function buildPsqlFileArgs({ port, database = 'gengyun', file, host = '127.0.0.1', user = 'postgres' }) {
  return ['-v', 'ON_ERROR_STOP=1', '-h', host, '-p', String(port), '-U', user, '-d', database, '-q', '-f', file];
}

/** `--demo` 要打开的三个契约开关；顺序与迁移 0020 的闭集一致。 */
export const DEMO_FLAG_KEYS = Object.freeze(['submissions_enabled', 'specific_herbicide_output_enabled', 'ai_enabled']);

/** 演示档写入的 reason：固定字面量，既用于审计，也用于重复 `up` 的幂等判定。 */
export const DEMO_FLAG_REASON = 'demo-stack local demo profile (non-production)';

/**
 * `--demo` 的 SQL 语句（纯函数：不执行、不读库、不读环境变量）。
 *
 * 不带 `--demo` 返回空数组，调用方据此**完全不碰** `public.feature_flags`；
 * 带则每个键一条 UPDATE，由调用方拼成 **一个** `psql -c` 参数执行（单条 simple query，
 * PostgreSQL 会把它当同一事务；任一语句失败则整组回滚）。
 *
 * 幂等策略：只有「`enabled` 不是 true」或「`reason` 还不是演示档」的行才 `revision + 1`；
 * 已经是目标状态的行不更新，所以重复 `up --demo` 不会把 revision 继续抬高。
 */
export function buildDemoFlagStatements({ demo = false } = {}) {
  if (!demo) return [];
  return DEMO_FLAG_KEYS.map((key) =>
    [
      'UPDATE public.feature_flags',
      '   SET enabled = true,',
      '       revision = revision + 1,',
      `       reason = '${DEMO_FLAG_REASON}',`,
      '       changed_at = now()',
      ` WHERE key = '${key}'`,
      `   AND (enabled IS DISTINCT FROM true OR reason IS DISTINCT FROM '${DEMO_FLAG_REASON}')`,
      'RETURNING key;',
    ].join('\n'),
  );
}

/** 把三条 UPDATE 拼成 psql 的单条 `-c` SQL；未开演示档返回 null。 */
export function buildDemoFlagSql(options = {}) {
  const statements = buildDemoFlagStatements(options);
  return statements.length === 0 ? null : statements.join('\n');
}

// ---------------------------------------------------------------- 演示隐私政策（--demo）

/**
 * `--demo` 写入的演示政策版本。两个 purpose 共用同一串：`GET /me/privacy-policy`
 * 只把 `public.recipients.policy_version` 等于「当前生效政策版本」的行挂到读面上
 * （`services/api/src/privacy/privacy-policy.ts`），版本串对不上读面就看不到接收方。
 *
 * 为什么是 `-2`：`-1` 只给 `external_inference` 绑了接收方，`media_processing` 是空绑定；
 * 但外发预留（`services/api/src/privacy/ledger-pg.ts:548-555`）要求**每一个**必需用途的
 * 授权记录里都列出同一个接收方，识别动线因此 403「用途 media_processing 未绑定接收方」。
 * 政策行一旦复核就不可改（`consent_policy_immutable`），所以形状变化只能发新版本；
 * `--demo` 会把自家旧版本（`LIKE 'demo-stack-local-%'`）停用后再启用新版本。
 */
export const DEMO_CONSENT_POLICY_VERSION = 'demo-stack-local-2';

/**
 * 演示接收方 id；`--demo` 的**两条**政策都绑定这一条。
 *
 * 只绑 `external_inference` 不够：外发预留要求每个必需用途的授权记录都列出同一接收方，
 * 而识别动线同时要 `media_processing` + `external_inference` 两个用途
 * （`services/api/src/routes/recognitions.ts` + `privacy/ledger-pg.ts:548-555`）。
 */
export const DEMO_RECIPIENT_ID = 'demo-stack-weed-vision';

/** 演示接收方配置版本；必须与政策 `recipient_bindings[].config_version` 逐字相等。 */
export const DEMO_RECIPIENT_CONFIG_VERSION = 'demo-stack-config-1';

/**
 * 演示复核账号的登录名。`consent_policies.reviewed_by` 外键指向 `admin_accounts`，
 * 而种子不写这张表，所以启用政策必须先有一条复核人；这条账号的 `credential_hash`
 * 是字面量占位符，任何登录尝试都不可能通过（它不是任何口令的哈希）。
 */
export const DEMO_REVIEWER_LOGIN = 'demo-stack-operator';

/** 演示政策的 purpose；顺序固定（日志与测试按这个顺序读）。 */
export const DEMO_CONSENT_PURPOSES = Object.freeze(['media_processing', 'external_inference']);

/** 识别供应商端点域名：与 `tools/ai-config.mjs` 的 `AI_ENDPOINTS.weedRecognition` 同源。 */
const WEED_ENDPOINT_HOST = new URL(AI_ENDPOINTS.weedRecognition.endpoint).host;

/**
 * 演示接收方展示名。这两张隐私表**没有 note/reason 列**，演示标记逐字落在
 * `display_name` / `source_ref` / `review_evidence_ref` 里，用
 * `LIKE '%demo-stack local demo profile (non-production)%'` 就能把演示行全部反查出来。
 */
// ⚠ 这条 SQL 会被 `psql -c` 传参：Windows 上 psql 用 ANSI 代码页解释命令行参数，
// 非 ASCII 字面量会在服务端报 `invalid byte sequence for encoding "UTF8"`。
// ⇒ 写进库的名字只用 ASCII；中文提示只走 stdout（见 DEMO_CONSENT_NOTICE）。
export const DEMO_RECIPIENT_DISPLAY_NAME = `Demo local weed recognition provider ${WEED_ENDPOINT_HOST} (demo-stack local demo profile (non-production))`;

const DEMO_POLICY_BODY = `本机演示政策，仅用于本地演示栈联调，不是生产核验。${DEMO_FLAG_REASON}`;
const DEMO_POLICY_SHA256 = createHash('sha256').update(DEMO_POLICY_BODY, 'utf8').digest('hex');

const sqlLiteral = (value) => `'${String(value).replace(/'/gu, "''")}'`;

const demoEvidenceRef = (purpose, kind) =>
  `https://demo-stack.local/${DEMO_FLAG_REASON}/${purpose}/${kind}`;

/** 演示政策的 `recipient_bindings`（jsonb 字面量）：字段与演示接收方行逐字段相等。 */
const DEMO_RECIPIENT_BINDINGS = JSON.stringify({
  [DEMO_RECIPIENT_ID]: {
    capability: 'weed',
    config_version: DEMO_RECIPIENT_CONFIG_VERSION,
    policy_version: DEMO_CONSENT_POLICY_VERSION,
    retention_online_days: 0,
    retention_backup_days: 0,
    no_training_evidence_ref: demoEvidenceRef('external_inference', 'no-training'),
    deletion_evidence_ref: demoEvidenceRef('external_inference', 'deletion'),
  },
});

/**
 * `--demo` 的隐私政策 SQL（纯函数：不执行、不读库、不读环境变量）。
 *
 * 顺序：复核账号 → 演示接收方 → 两条政策 → 兜底启用。四步都塞进调用方的**一个**
 * `psql -c`，simple query 就是一个事务：任一步失败整组回滚，不会留下半套政策。
 *
 * 幂等：`ON CONFLICT DO NOTHING` + 只在内容确有差异时 `DO UPDATE`；重复 `up --demo`
 * 不再写 `updated_at`，也不改 `revision`（那是 feature flag 的列）。
 *
 * fail-closed：若某个 purpose 已经有一条**别的版本**在启用，`consent_policies_enabled_purpose`
 * 部分唯一索引会以 23505 拒绝整组写入。演示档不替用户禁用既有政策——那种「为了跑通
 * 而改授权面」的行为正是本工具要避免的。
 */
export function buildDemoConsentStatements({ demo = false } = {}) {
  // 只认字面 `true`：这是写隐私表的分支，`'false'` 这类真值字符串不能把演示政策放进来（fail-closed）。
  if (demo !== true) return [];

  const reviewer = `(SELECT id FROM public.admin_accounts WHERE login_name = ${sqlLiteral(DEMO_REVIEWER_LOGIN)})`;
  const policyColumns = [
    'INSERT INTO public.consent_policies',
    '  (purpose, policy_version, source_kind, source_ref, review_evidence_ref, content_sha256,',
    '   recipient_bindings, valid_from, valid_until, reviewed_by, reviewed_at, enabled)',
  ].join('\n');

  const policyValues = (purpose, bindings) =>
    [
      'VALUES (',
      `  ${sqlLiteral(purpose)}, ${sqlLiteral(DEMO_CONSENT_POLICY_VERSION)}, 'verified',`,
      `  ${sqlLiteral(demoEvidenceRef(purpose, 'source'))},`,
      `  ${sqlLiteral(demoEvidenceRef(purpose, 'review'))},`,
      `  ${sqlLiteral(DEMO_POLICY_SHA256)},`,
      `  ${sqlLiteral(bindings)}::jsonb,`,
      "  clock_timestamp() - interval '1 hour',",
      "  clock_timestamp() + interval '3650 days',",
      `  ${reviewer}, clock_timestamp(), true)`,
    ].join('\n');

  return [
    [
      'INSERT INTO public.admin_accounts (login_name, credential_hash)',
      `VALUES (${sqlLiteral(DEMO_REVIEWER_LOGIN)}, ${sqlLiteral(`${DEMO_FLAG_REASON}: placeholder, not a login credential`)})`,
      'ON CONFLICT (login_name) DO NOTHING',
      'RETURNING login_name;',
    ].join('\n'),
    [
      'INSERT INTO public.recipients',
      '  (id, display_name, capability, policy_version, retention_online_days, retention_backup_days,',
      '   no_training_verified, deletion_verified, enabled, config_version)',
      'VALUES (',
      `  ${sqlLiteral(DEMO_RECIPIENT_ID)}, ${sqlLiteral(DEMO_RECIPIENT_DISPLAY_NAME)}, 'weed',`,
      `  ${sqlLiteral(DEMO_CONSENT_POLICY_VERSION)}, 0, 0, true, true, true,`,
      `  ${sqlLiteral(DEMO_RECIPIENT_CONFIG_VERSION)})`,
      'ON CONFLICT (id) DO UPDATE',
      '   SET display_name = EXCLUDED.display_name,',
      '       capability = EXCLUDED.capability,',
      '       policy_version = EXCLUDED.policy_version,',
      '       retention_online_days = EXCLUDED.retention_online_days,',
      '       retention_backup_days = EXCLUDED.retention_backup_days,',
      '       no_training_verified = EXCLUDED.no_training_verified,',
      '       deletion_verified = EXCLUDED.deletion_verified,',
      '       enabled = EXCLUDED.enabled,',
      '       config_version = EXCLUDED.config_version,',
      '       updated_at = clock_timestamp()',
      " WHERE (recipients.display_name, recipients.capability, recipients.policy_version,",
      '        recipients.retention_online_days, recipients.retention_backup_days,',
      '        recipients.no_training_verified, recipients.deletion_verified,',
      '        recipients.enabled, recipients.config_version)',
      '       IS DISTINCT FROM',
      '       (EXCLUDED.display_name, EXCLUDED.capability, EXCLUDED.policy_version,',
      '        EXCLUDED.retention_online_days, EXCLUDED.retention_backup_days,',
      '        EXCLUDED.no_training_verified, EXCLUDED.deletion_verified,',
      '        EXCLUDED.enabled, EXCLUDED.config_version)',
      'RETURNING id;',
    ].join('\n'),
    [
      'UPDATE public.consent_policies',
      '   SET enabled = false, updated_at = clock_timestamp()',
      ` WHERE purpose IN (${DEMO_CONSENT_PURPOSES.map(sqlLiteral).join(', ')})`,
      `   AND policy_version LIKE ${sqlLiteral('demo-stack-local-%')}`,
      `   AND policy_version <> ${sqlLiteral(DEMO_CONSENT_POLICY_VERSION)}`,
      '   AND enabled',
      'RETURNING purpose, policy_version;',
    ].join('\n'),
    ...[
      ['media_processing', DEMO_RECIPIENT_BINDINGS],
      ['external_inference', DEMO_RECIPIENT_BINDINGS],
    ].map(([purpose, bindings]) =>
      [policyColumns, policyValues(purpose, bindings), 'ON CONFLICT (purpose, policy_version) DO NOTHING', 'RETURNING purpose;'].join('\n'),
    ),
    [
      'UPDATE public.consent_policies',
      '   SET enabled = true, updated_at = clock_timestamp()',
      ` WHERE purpose IN (${DEMO_CONSENT_PURPOSES.map(sqlLiteral).join(', ')})`,
      `   AND policy_version = ${sqlLiteral(DEMO_CONSENT_POLICY_VERSION)}`,
      '   AND enabled IS DISTINCT FROM true',
      'RETURNING purpose;',
    ].join('\n'),
  ];
}

/** 把演示政策语句拼成 psql 的单条 `-c` SQL；未开演示档返回 null。 */
export function buildDemoConsentSql(options = {}) {
  const statements = buildDemoConsentStatements(options);
  return statements.length === 0 ? null : statements.join('\n');
}

/** 演示档写入后给人看的一句总结（⛔ 不要把这段当成生产核验结论）。 */
export const DEMO_CONSENT_NOTICE =
  '这是本机演示政策，不是生产核验：只覆盖本机演示栈，external_inference 绑定的是本机演示接收方';

/**
 * 未开 `--demo` 时探测「识别动线会不会 403」的只读查询：数一数有没有
 * 启用且已核验、且在有效期内的政策（判据与 `services/api/src/privacy/grant-pg.ts:47-53` 相同）。
 */
export const buildConsentReadinessSql = () =>
  [
    "SELECT 'enabled_verified_policies=' || count(*)",
    '  FROM public.consent_policies',
    ' WHERE enabled',
    "   AND source_kind = 'verified'",
    '   AND reviewed_at IS NOT NULL',
    '   AND valid_from <= clock_timestamp()',
    '   AND valid_until > clock_timestamp();',
  ].join('\n');

/** 从 psql 输出里取 `enabled_verified_policies=N`；取不到返回 null（不猜）。 */
export function parseConsentReadiness(output) {
  const match = /enabled_verified_policies=(\d+)/u.exec(String(output ?? ''));
  return match ? Number(match[1]) : null;
}

/** 未开 `--demo` 且政策为空时的显式警告（原样打印给用户，包含下一步怎么做）。 */
export const CONSENT_EMPTY_WARNING =
  '识别动线会 403：没有已核验政策，用 --demo 或先跑 import-consent-policy/recipient';

/** pid 文件内容：带上实例标记与端口，`down`/`status` 靠它判断「这是不是本工具起的」。 */
export function buildPidRecord({ pid, port, mode, instanceId, startedAt, logFile }) {
  return {
    schema: DEMO_SCHEMA,
    pid,
    port,
    mode,
    instanceId,
    startedAt,
    logFile,
  };
}

/** 解析 pid 文件；不合规直接返回 null（当作「没有 pid 文件」，不猜 pid）。 */
export function parsePidRecord(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.schema !== DEMO_SCHEMA) return null;
  if (!Number.isInteger(parsed.pid) || parsed.pid <= 0) return null;
  if (!Number.isInteger(parsed.port) || parsed.port <= 0 || parsed.port > PORT_MAX) return null;
  if (typeof parsed.instanceId !== 'string' || parsed.instanceId === '') return null;
  return parsed;
}

/** 命令行里是否含本实例标记（`down` 只杀带标记的进程，防 pid 复用误杀）。 */
export function commandHasInstance(commandLine, instanceId) {
  if (typeof commandLine !== 'string' || commandLine === '') return false;
  if (typeof instanceId !== 'string' || instanceId === '') return false;
  return commandLine.includes(`${INSTANCE_FLAG}${instanceId}`);
}

/** `status` 的三行结论：进程 / 端口 / 健康。 */
export function statusLines({ api, port, health }) {
  const processLine = api?.running
    ? `进程：API 在跑（pid ${api.pid}${api.mode ? `，mode=${api.mode}` : ''}${api.owned ? '' : '，⚠ 不是本工具起的'}）`
    : `进程：API 未运行${api?.pidFile === false ? '（无 pid 文件）' : ''}`;

  const portLine = port?.listening
    ? `端口：TCP 127.0.0.1:${port.port} 被占用${port.pid ? `（pid ${port.pid}${port.name ? `，${port.name}` : ''}）` : '（持有进程未知）'}`
    : `端口：TCP 127.0.0.1:${port?.port ?? '?'} 空闲`;

  const healthLine = health?.state ? `健康：GET /health → ${health.reason}` : '健康：未探测';

  return [processLine, portLine, healthLine];
}

/** `up`/`status` 之后给用户看的「下一步」：开发者工具里要做什么。 */
export function nextStepsLines({ mode, apiPort }) {
  const base = `http://127.0.0.1:${apiPort}`;
  return [
    '',
    '下一步（微信开发者工具）：',
    '  1) 准备小程序工程：',
    `       node tools/prepare-wechat.mjs local --config config/debug.local.json`,
    `     其中 apiBaseUrl 写 ${base}/api/v1，port 写 ${apiPort}，bindHost 写 127.0.0.1`,
    '  2) 开发者工具 → 导入项目 → 选 prepare-wechat 打印的 LOCAL import root 目录',
    '  3) 模拟器里点「首页」：只有 real 模式才是 200；stub 模式首页必然 503（这是既有契约，不是本栈故障）',
    mode === 'real'
      ? '  4) 首页可能显示「暂无资料」：库内已核对来源为 0 条，属资料接入缺项（见运行手册「首页为什么是空的」）'
      : '  4) 现在起的是 stub：首页会 503，本栈只用于验证「进程/端口/健康」链路是否通',
    '',
    `本机自检：curl.exe -s -o NUL -w "%{http_code}" ${base}/health     （应输出 200；/api/v1/health 是 404）`,
  ];
}

/** 状态目录布局；dataDir 与日志全部落在仓库外，避免误提交。 */
export function resolvePaths({ stateDir, repoRoot }) {
  return {
    stateDir,
    dataDir: join(stateDir, 'pgdata'),
    pgLog: join(stateDir, 'pg.log'),
    apiLog: join(stateDir, 'api.log'),
    pidFile: join(stateDir, 'api.pid'),
    stateFile: join(stateDir, 'state.json'),
    secretsFile: join(stateDir, 'secrets.env'),
    repoRoot,
  };
}

/** 从 secrets.env 文本读生成的两把钥匙（只在内存里用，不回显）。 */
export function readSecretsFile(text) {
  const { values } = readEnvFile(text);
  const out = {};
  for (const key of GENERATED_KEYS) {
    if (typeof values[key] === 'string' && values[key] !== '') out[key] = values[key];
  }
  return out;
}

/** 写 secrets.env 的文本（键名可见、值不打印；调用方负责 0600 与「不提交」）。 */
export function renderSecretsFile(secrets) {
  const lines = ['# 由 tools/demo-stack.mjs 生成，本地签名用；不要提交、不要贴进聊天记录'];
  for (const key of GENERATED_KEYS) {
    if (typeof secrets[key] === 'string' && secrets[key] !== '') lines.push(`${key}=${secrets[key]}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * `--demo` 且 `real` 时随 API 启动参数传「真实媒体接线的显式批准」。
 *
 * 批准开关（`--approve-real-media-wiring`）是 `services/api/src/server.ts` 唯一的铸造点：
 * 不给它，媒体域整域 503（`PROVIDER_UNAVAILABLE`），演示栈连上传都做不了。演示档本来就是
 * 一次显式的「本机非生产」选择，所以由同一次 `--demo` 派生；**不带 `--demo` 时逐字不变**（不传）。
 */
export function buildApiApprovalArgs({ demo = false, mode } = {}) {
  return demo === true && mode === 'real' ? ['--approve-real-media-wiring'] : [];
}

/**
 * 演示档的取图原点兜底：带 `--approve-real-media-wiring` 启动时，
 * `MEDIA_ACCESS_GRANT_ORIGIN` 缺省会被 `assertAccessGrantOriginDeployable` 判成
 * 「指向占位域」并拒绝启动（`media/real-ports.ts:260-278`）。
 *
 * 演示栈是**本机 http** 服务，这里给一个 `https://127.0.0.1:<apiPort>` 只为过启动校验；
 * 它只影响取图句柄的 host，识别链路由服务端直读对象存储、不经过这个句柄。env 文件里显式
 * 给了就尊重 env 文件，不覆盖。⛔ 不带 `--demo` 时一个键都不动。
 */
export function withDemoAccessOrigin(assembled, { demo = false, mode, apiPort } = {}) {
  if (demo !== true || mode !== 'real') return assembled;
  const current = assembled?.env?.MEDIA_ACCESS_GRANT_ORIGIN;
  if (typeof current === 'string' && current.trim() !== '') return assembled;
  return {
    ...assembled,
    env: { ...assembled.env, MEDIA_ACCESS_GRANT_ORIGIN: `https://127.0.0.1:${apiPort}` },
    sources: { ...assembled.sources, MEDIA_ACCESS_GRANT_ORIGIN: 'demo' },
  };
}

/** 索引用的「env 来源摘要」：只出现键名与来源，绝不出现值。 */
export function describeEnvSources(sources) {
  const order = ['DATABASE_URL', ...REQUIRED_REAL_ENV.filter((key) => key !== 'DATABASE_URL'), ...OPTIONAL_REAL_ENV];
  const lines = [];
  for (const key of order) {
    const source = sources?.[key];
    if (!source) continue;
    const label = { tool: '本工具生成', 'env-file': 'env 文件', process: '当前进程环境', generated: '新生成并已保存', 'state-dir': 'state-dir 复用', demo: '演示档默认（非生产）' }[source] ?? source;
    lines.push(`${key} ← ${label}`);
  }
  return lines;
}
