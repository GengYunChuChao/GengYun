/**
 * 本地受控环境（`npm run local:up|down|status`）的**纯逻辑**。
 *
 * 本文件刻意不 import `node:fs` / `node:child_process` / `node:net`：所有判定都只吃「已经算好的输入」，
 * 因此单测可以注入假的端口占用表、假的迁移 stderr、假的密钥值，**不需要真起 PG、也不需要真起服务**。
 * 副作用（建簇、起进程、写文件、发 HTTP）全部留在 `tools/local-env.mjs`。
 *
 * 三条本文件要负责消灭的坑（每一轮手搓都在踩）：
 *   1. 端口照抄文档 ⇒ 撞上无关进程（本机 3100 被 QQ 桥占着，任何路径回 401，看起来像「API 起好了但鉴权失败」）。
 *      判据在 {@link planPort}：占用必须**点名 pid 与命令行**，回退要显式留痕，`--strict-port` 下必须失败。
 *   2. 密钥泄进摘要/日志 ⇒ 判据在 {@link findSecretLeaks} / {@link assertNoSecretLeaks}。
 *   3. `db:migrate` 失败被当成「起好了」⇒ 判据在 {@link classifyMigrateFailure}（非零退出 + 分类 + 原文脱敏）。
 */
import { isAbsolute } from 'node:path';

/** 摘要 JSON 的 schema 标识（形状变化必须改它，避免旧读者把新形状当旧形状读）。 */
export const SCHEMA_ID = 'gengyun.local-env/1';

/**
 * 默认端口：**故意与历史默认错开**，避免和同一台机器上别人的工作树/旧脚本撞车。
 * - PG 5555（历史手搓用 5544、`tools/local-dev` 用 55436）；
 * - API 3111（README/`tools/local-dev` 用 3100，而 3100 在本机常被无关进程占着）。
 */
export const DEFAULT_PORTS = Object.freeze({ pg: 5555, api: 3111 });

/** 端口被占后最多往后试多少个号（含首选）；超过即判定「这一段端口都被占」，不无限扫。 */
export const PORT_MAX_OFFSET = 20;

/** 端口号合法区间（与 `services/api/src/config.ts` 的 `API_PORT` 判据同口径）。 */
export const PORT_RANGE = Object.freeze([1024, 65535]);

/**
 * `up` 结束时必须打到的 6 个端点。
 *
 * 顺序即输出顺序（摘要 JSON 逐字节稳定的一部分）：先 `/health`，再用 `POST /auth/wechat` 换会话，
 * 剩下 4 条带 `Authorization: Bearer`。`auth: true` 的端点**未带会话**时按设计回 401，
 * 所以「打到 200」这件事必须靠前面那次登录，不能靠放宽鉴权。
 */
export const REQUIRED_ENDPOINTS = Object.freeze([
  Object.freeze({ name: 'health', method: 'GET', path: '/health', auth: false, expected: 200 }),
  Object.freeze({ name: 'auth_wechat', method: 'POST', path: '/api/v1/auth/wechat', auth: false, expected: 200 }),
  Object.freeze({ name: 'me_profile', method: 'GET', path: '/api/v1/me/profile', auth: true, expected: 200 }),
  Object.freeze({ name: 'knowledge', method: 'GET', path: '/api/v1/knowledge', auth: true, expected: 200 }),
  Object.freeze({ name: 'catalog_crops', method: 'GET', path: '/api/v1/catalog/crops', auth: true, expected: 200 }),
  Object.freeze({ name: 'herbicides', method: 'GET', path: '/api/v1/herbicides', auth: true, expected: 200 }),
]);

/**
 * `initdb` 的缺省参数（**固化**上一轮手搓的形状）。
 *
 * - `-U postgres`：超级用户固定，连接串才不用带用户名变量；
 * - `-A trust`：本机回环 + 临时簇，不设口令（也**绝不**把口令写进任何文件）；
 * - `--locale=C` + `--encoding=UTF8`：C locale 让排序/大小写行为稳定，迁移与断言不随系统区域设置漂移。
 */
export const INITDB_DEFAULTS = Object.freeze({
  superuser: 'postgres',
  authMethod: 'trust',
  locale: 'C',
  encoding: 'UTF8',
});

/** 默认数据库名（迁移脚本与 `DATABASE_URL` 里用的是同一个）。 */
export const DEFAULT_DATABASE = 'gengyun';

/** 身份/授权/备份相关环境变量名：值只进进程环境与仓外临时文件，⛔ 不进摘要、不进日志。 */
export const SECRET_ENV_NAMES = Object.freeze(['SESSION_SIGNING_KEY', 'DELETION_LEDGER_KEY']);

/** 密钥最小字节数（32 字节 CSPRNG ⇒ base64url 后 43 字符；这里按字符长度做下限校验）。 */
export const SECRET_MIN_LENGTH = 32;

/** 已知边界：`consent_policies` 空表 ⇒ 社区发帖在授权层被 403 挡掉（需要单独的导入工具，本工具不插行）。 */
export const CONSENT_POLICIES_BOUNDARY_ID = 'consent_policies_empty';

/** 已知边界文案（`up` 与摘要共用一处，⛔ 不在 CLI 里另写一份）。 */
export function knownBoundaryLines(consentPolicyRows) {
  const rows = Number.isInteger(consentPolicyRows) ? consentPolicyRows : null;
  const counted = rows === null ? '行数未知（查询失败）' : `${rows} 行`;
  return [
    {
      id: CONSENT_POLICIES_BOUNDARY_ID,
      rows,
      detail:
        `consent_policies ${counted} ⇒ 社区发帖在授权层被 403 挡掉；` +
        '需要单独的导入工具，本工具⛔不往库里插任何政策行。',
    },
  ];
}

// ---------------------------------------------------------------------------
// 端口探测与回退
// ---------------------------------------------------------------------------

/** 端口合法性：整数且落在 {@link PORT_RANGE}。返回 `{ok, port}` / `{ok:false, detail}`。 */
export function normalizePort(value) {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(parsed) || parsed < PORT_RANGE[0] || parsed > PORT_RANGE[1]) {
    return { ok: false, detail: `端口必须是 ${PORT_RANGE[0]}..${PORT_RANGE[1]} 的整数` };
  }
  return { ok: true, port: parsed };
}

/**
 * 把「探测到的占用表」归一成 `Map<port, holder>`。
 *
 * 接受四种形状（方便单测注入）：数组 `[{port,pid,name,commandLine}]`、以端口为键的普通对象、
 * Map，以及**单条记录**——`ConvertTo-Json` 对单元素数组会退化成对象（实测：只有 1 个端口被占时
 * 输出 `{"port":3100,...}` 而不是 `[{...}]`），不认这个形状会把持有进程读丢，只剩「pid 未知」。
 * 非法端口项直接丢掉（**不**猜），缺失字段归一成 `null`。
 */
export function normalizeOccupancy(entries) {
  const map = new Map();
  const list = [];
  if (Array.isArray(entries)) list.push(...entries);
  else if (entries instanceof Map) for (const [key, value] of entries) list.push({ port: key, ...(value ?? {}) });
  else if (entries !== null && typeof entries === 'object') {
    if (Object.prototype.hasOwnProperty.call(entries, 'port') || Object.prototype.hasOwnProperty.call(entries, 'Port')) {
      list.push(entries);
    } else {
      for (const [key, value] of Object.entries(entries)) list.push({ port: key, ...(value ?? {}) });
    }
  }
  for (const entry of list) {
    const port = Number(entry?.port ?? entry?.Port);
    if (!Number.isInteger(port)) continue;
    const rawPid = entry.pid ?? entry.Pid ?? entry.OwningProcess;
    const pid = Number.isInteger(Number(rawPid)) && rawPid !== null && rawPid !== undefined && rawPid !== ''
      ? Number(rawPid)
      : null;
    map.set(port, {
      port,
      pid,
      name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : null,
      commandLine: typeof entry.commandLine === 'string' && entry.commandLine.trim() !== '' ? entry.commandLine.trim() : null,
    });
  }
  return map;
}

/** 把占用者渲染成一行人话（pid + 进程名 + 命令行），供「点名」与摘要。 */
export function describeHolder(holder) {
  if (holder === null || holder === undefined) return '占用者未知';
  const pid = holder.pid === null || holder.pid === undefined ? 'pid 未知' : `pid ${holder.pid}`;
  const name = holder.name === null || holder.name === undefined ? '进程名未知' : holder.name;
  const command = holder.commandLine === null || holder.commandLine === undefined
    ? '命令行未知'
    : holder.commandLine.length > 160
      ? `${holder.commandLine.slice(0, 157)}...`
      : holder.commandLine;
  return `${pid} (${name}, ${command})`;
}

/**
 * 端口决策：首选可用就用首选；被占就往后试到 {@link PORT_MAX_OFFSET}；`--strict-port` 下**直接失败**。
 *
 * 返回值（不抛异常，便于单测逐字段断言）：
 * - `{ok:true, port, skipped, detail}`；
 * - `{ok:false, reason:'PORT_OCCUPIED_STRICT', port, holder, holder_detail, skipped, detail}`
 *   —— `holder_detail` 就是「点名」的那一行；
 * - `{ok:false, reason:'PORT_RANGE_EXHAUSTED', ...}`；
 * - `{ok:false, reason:'INVALID_PORT'|'AMBIGUOUS_WITH_RESERVED', ...}`。
 *
 * `reserved`：本次运行**其它**组件已经占用的端口（例如 PG 已选定 5555 时，API 不能再选 5555）。
 */
export function planPort({ preferred, occupied = [], strict = false, maxOffset = PORT_MAX_OFFSET, reserved = [] } = {}) {
  const normalized = normalizePort(preferred);
  if (!normalized.ok) {
    return { ok: false, reason: 'INVALID_PORT', port: null, holder: null, holder_detail: null, skipped: [], detail: normalized.detail };
  }
  const base = normalized.port;
  const taken = normalizeOccupancy(occupied);
  const reservedSet = new Set((reserved ?? []).map((item) => Number(item)).filter((item) => Number.isInteger(item)));
  const skipped = [];

  for (let offset = 0; offset <= Math.max(0, maxOffset); offset += 1) {
    const candidate = base + offset;
    if (candidate > PORT_RANGE[1]) break;
    const holder = taken.get(candidate) ?? null;
    if (holder !== null) {
      skipped.push({ port: candidate, holder });
      if (strict && offset === 0) {
        return {
          ok: false,
          reason: 'PORT_OCCUPIED_STRICT',
          port: candidate,
          holder,
          holder_detail: describeHolder(holder),
          skipped,
          detail: `端口 ${candidate} 已被占用：${describeHolder(holder)}（--strict-port ⇒ 直接失败，不换号）`,
        };
      }
      continue;
    }
    if (reservedSet.has(candidate)) {
      skipped.push({ port: candidate, holder: { port: candidate, pid: null, name: null, commandLine: '本次运行已占用' } });
      if (strict && offset === 0) {
        return {
          ok: false,
          reason: 'AMBIGUOUS_WITH_RESERVED',
          port: candidate,
          holder: null,
          holder_detail: `端口 ${candidate} 已被本次运行的其它组件占用`,
          skipped,
          detail: `端口 ${candidate} 与本次运行已选定的组件端口相同（--strict-port ⇒ 直接失败）`,
        };
      }
      continue;
    }
    if (skipped.length > 0) {
      const reasons = skipped
        .map((item) => `${item.port}: ${describeHolder(item.holder)}`)
        .join('；');
      return { ok: true, port: candidate, skipped, detail: `首选端口被占，改用 ${candidate}（${reasons}）` };
    }
    return { ok: true, port: candidate, skipped, detail: `端口 ${candidate} 空闲` };
  }

  return {
    ok: false,
    reason: 'PORT_RANGE_EXHAUSTED',
    port: null,
    holder: null,
    holder_detail: null,
    skipped,
    detail: `从 ${base} 起连续 ${skipped.length} 个端口都被占用（上限 ${maxOffset}），放弃换号`,
  };
}

// ---------------------------------------------------------------------------
// 参数拼装（initdb / pg_ctl / psql）
// ---------------------------------------------------------------------------

/** 绝对路径断言：⛔ 不允许相对路径（相对路径按进程 cwd 解析，是上一轮的第三个坑）。 */
function requireAbsolute(value, field) {
  if (typeof value !== 'string' || value === '') throw new TypeError(`${field} 必须是非空字符串（绝对路径）`);
  if (!isAbsolute(value)) throw new TypeError(`${field} 必须是绝对路径，实际：${value}`);
  return value;
}

/** 库名/角色名白名单：只允许 `[a-z_][a-z0-9_]{0,62}`，因此可以安全内联进 SQL。 */
export function assertSqlIdentifier(value, field) {
  if (typeof value !== 'string' || !/^[a-z_][a-z0-9_]{0,62}$/.test(value)) {
    throw new TypeError(`${field} 必须是 [a-z_][a-z0-9_]{0,62} 的标识符，实际：${String(value)}`);
  }
  return value;
}

/**
 * `initdb` 参数（顺序固定，便于单测逐项比对）。
 *
 * `--locale=C` 与 `--encoding=UTF8` 用 `=` 形式：PostgreSQL 17 的 `initdb` 同时接受空格形式，
 * 但 `=` 形式在 PowerShell/`spawn` 下不会被误当成另一个参数。
 */
export function buildInitdbArgs({ dataDir, superuser = INITDB_DEFAULTS.superuser, authMethod = INITDB_DEFAULTS.authMethod, locale = INITDB_DEFAULTS.locale, encoding = INITDB_DEFAULTS.encoding } = {}) {
  requireAbsolute(dataDir, 'dataDir');
  return [
    '-D',
    dataDir,
    '-U',
    String(superuser),
    '-A',
    String(authMethod),
    `--locale=${String(locale)}`,
    `--encoding=${String(encoding)}`,
  ];
}

/** `pg_ctl start` 参数：`-w` 等就绪、`-t` 给上限，`-o` 里固定回环地址与端口。 */
export function buildPgStartArgs({ dataDir, port, host = '127.0.0.1', logFile, waitSeconds = 30 } = {}) {
  requireAbsolute(dataDir, 'dataDir');
  if (logFile !== undefined) requireAbsolute(logFile, 'logFile');
  const normalized = normalizePort(port);
  if (!normalized.ok) throw new TypeError(normalized.detail);
  const args = ['-D', dataDir];
  if (logFile !== undefined) args.push('-l', logFile);
  args.push('-o', `-h ${host} -p ${normalized.port}`, '-w', '-t', String(waitSeconds), 'start');
  return args;
}

/** `pg_ctl stop` 参数：fast 模式（不丢已提交事务，也不等客户端断开）。 */
export function buildPgStopArgs({ dataDir, mode = 'fast', waitSeconds = 30 } = {}) {
  requireAbsolute(dataDir, 'dataDir');
  return ['-D', dataDir, '-m', mode, '-w', '-t', String(waitSeconds), 'stop'];
}

/** `pg_ctl status` 参数（退出码 0=在跑，3=没跑）。 */
export function buildPgStatusArgs({ dataDir } = {}) {
  requireAbsolute(dataDir, 'dataDir');
  return ['-D', dataDir, 'status'];
}

/** `psql` 参数：单条语句、只回值（`-tA`）、出错即停（`ON_ERROR_STOP=1`），不落交互提示。 */
export function buildPsqlArgs({ port, host = '127.0.0.1', user = INITDB_DEFAULTS.superuser, database = 'postgres', sql } = {}) {
  const normalized = normalizePort(port);
  if (!normalized.ok) throw new TypeError(normalized.detail);
  if (typeof sql !== 'string' || sql === '') throw new TypeError('sql 必须是非空字符串');
  return [
    '-v',
    'ON_ERROR_STOP=1',
    '-h',
    host,
    '-p',
    String(normalized.port),
    '-U',
    String(user),
    '-d',
    String(database),
    '-tA',
    '-c',
    sql,
  ];
}

/** 「库是否存在」的查询（结果为空 ⇒ 不存在）。 */
export function buildDatabaseExistsSql(database) {
  return `SELECT 1 FROM pg_database WHERE datname = '${assertSqlIdentifier(database, 'database')}'`;
}

/** 建库语句（库名已过白名单校验，可安全内联）。 */
export function buildCreateDatabaseSql(database) {
  return `CREATE DATABASE ${assertSqlIdentifier(database, 'database')}`;
}

/** 库内查询：`consent_policies` 行数（已知边界自检项，只读）。 */
export function buildConsentPoliciesCountSql() {
  return 'SELECT count(*) FROM consent_policies';
}

/** 连接串：回环 + trust，刻意**不带口令**（临时簇，口令只会多一处泄露面）。 */
export function buildDatabaseUrl({ user = INITDB_DEFAULTS.superuser, host = '127.0.0.1', port, database = DEFAULT_DATABASE } = {}) {
  const normalized = normalizePort(port);
  if (!normalized.ok) throw new TypeError(normalized.detail);
  return `postgres://${String(user)}@${host}:${normalized.port}/${assertSqlIdentifier(database, 'database')}`;
}

// ---------------------------------------------------------------------------
// 迁移输出解析与失败分类
// ---------------------------------------------------------------------------

/** 迁移失败分类闭集（`kind` 只可能是这些之一；未知一律 `UNKNOWN`，⛔ 不猜）。 */
export const MIGRATE_FAILURE_KINDS = Object.freeze([
  'OK',
  'COMMAND_NOT_FOUND',
  'DATABASE_URL_MISSING',
  'CONNECTION_REFUSED',
  'AUTH_FAILED',
  'DATABASE_MISSING',
  'MIGRATION_DRIFT',
  'DUPLICATE_VERSION',
  'MIGRATION_SQL_FAILED',
  'UNKNOWN',
]);

/**
 * 迁移失败的判据表：**按顺序**匹配，先命中先赢（drift/重复版本必须在通用「执行失败」之前，
 * 否则会把「台账与磁盘不一致」读成「某条 SQL 写错了」）。
 */
const MIGRATE_FAILURE_RULES = Object.freeze([
  { kind: 'COMMAND_NOT_FOUND', pattern: /ENOENT|不是内部或外部命令|is not recognized/i, retryable: false, hint: '迁移命令本身没跑起来（可执行文件/脚本路径不对），先修命令再重试' },
  { kind: 'DATABASE_URL_MISSING', pattern: /缺少 DATABASE_URL|DATABASE_URL.*(缺失|未配置)/i, retryable: false, hint: '迁移运行器拒绝在无连接串时假装成功：检查 DATABASE_URL 是否真的进了子进程环境' },
  { kind: 'CONNECTION_REFUSED', pattern: /ECONNREFUSED|connect ECONNREFUSED|连接被拒|Connection refused/i, retryable: true, hint: 'PG 端口没人监听：簇没起来或端口选错了，先 `local:status` 看 PG 是否在跑' },
  { kind: 'AUTH_FAILED', pattern: /28P01|28000|password authentication failed|认证失败/i, retryable: false, hint: '认证方式变了：临时簇应当 initdb -A trust，别手工改成 scram 而忘了口令' },
  { kind: 'DATABASE_MISSING', pattern: /3D000|database .* does not exist|数据库 .* 不存在/i, retryable: false, hint: '库没建出来：先建库（本工具在迁移前建库），再确认连的是同一个端口' },
  { kind: 'MIGRATION_DRIFT', pattern: /drift|校验和.*不一致/i, retryable: false, hint: '已应用迁移的校验和变了：⛔ 不要改历史迁移文件，也不要把台账表清空当修好' },
  { kind: 'DUPLICATE_VERSION', pattern: /版本号重复|迁移文件名不合规/i, retryable: false, hint: '迁移文件名/版本号冲突：两份迁移抢同一个号，先解决编号再跑' },
  { kind: 'MIGRATION_SQL_FAILED', pattern: /执行失败|syntax error|relation .* does not exist|permission denied/i, retryable: false, hint: '某条迁移的 SQL 在真库上失败：看 evidence 里点名的那一条，修 SQL 或修库状态' },
]);

/**
 * 失败分类：只吃「退出码 + 输出」，不碰网络、不看环境。
 *
 * - `failed`：**只看退出码**（`null` 也判失败——进程没跑起来却当成功是更坏的一种假绿）；
 * - `kind`：闭集之一；
 * - `evidence`：命中的那一行原文，**脱敏**（连接串口令、`*_KEY=` 值一律打码），最长 240 字符；
 * - `hint`：给人看的下一步（不含任何密钥）。
 */
export function classifyMigrateFailure({ exitCode, stdout = '', stderr = '', secrets = [] } = {}) {
  const failed = !(exitCode === 0);
  if (!failed) return { failed: false, kind: 'OK', retryable: false, evidence: null, hint: null };
  const combined = `${stderr}\n${stdout}`;
  const rules = MIGRATE_FAILURE_RULES;
  for (const rule of rules) {
    if (!rule.pattern.test(combined)) continue;
    return {
      failed: true,
      kind: rule.kind,
      retryable: rule.retryable,
      evidence: firstMatchingLine(combined, rule.pattern, secrets),
      hint: rule.hint,
    };
  }
  return {
    failed: true,
    kind: 'UNKNOWN',
    retryable: false,
    evidence: firstMatchingLine(combined, /[\s\S]/, secrets),
    hint: '未归类的迁移失败：看 evidence（已脱敏）与 <state-dir>/migrate.log 原文，⛔ 不要当成「起好了」继续打端点',
  };
}

function firstMatchingLine(text, pattern, secrets) {
  const lines = String(text).split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
  const hit = lines.find((line) => pattern.test(line)) ?? lines[0] ?? '';
  const redacted = redactSecrets(redactConnectionStrings(hit), secrets);
  return redacted.length > 240 ? `${redacted.slice(0, 237)}...` : redacted;
}

/**
 * 解析 `npm run db:migrate` 的 stdout。
 *
 * 输出形状（`services/api/src/db/migrate.ts` 的 `main`）：
 *   `发现 N 个迁移：0001_..., 0002_...`
 *   `已应用：0003, 0004` / `已应用：（无）`
 *   `已存在跳过：（无）`
 * 解析不出来一律 `null`（⛔ 不把「没解析到」当 0 或当成功）。
 */
export function parseMigrateOutput(stdout = '') {
  const text = String(stdout);
  const discoveredMatch = /发现\s*(\d+)\s*个迁移/.exec(text);
  const listOf = (label) => {
    const match = new RegExp(`${label}：([^\\r\\n]*)`).exec(text);
    if (match === null) return null;
    const raw = match[1].trim();
    if (raw === '' || raw === '（无）' || raw === '(无)' || raw === '无') return [];
    return raw
      .split(/[,，、]\s*/)
      .map((item) => item.trim())
      .filter((item) => item !== '');
  };
  const applied = listOf('已应用');
  const skipped = listOf('已存在跳过');
  return {
    discovered: discoveredMatch === null ? null : Number(discoveredMatch[1]),
    applied,
    skipped,
    appliedCount: applied === null ? null : applied.length,
    skippedCount: skipped === null ? null : skipped.length,
  };
}

// ---------------------------------------------------------------------------
// 脱敏与泄密回归
// ---------------------------------------------------------------------------

/** 把给定密钥值在文本里逐字打码（长的先替换，避免短值先命中把长值切碎）。 */
export function redactSecrets(text, secrets = []) {
  let output = String(text);
  const list = (secrets ?? [])
    .filter((item) => typeof item === 'string' && item.length >= 4)
    .sort((a, b) => b.length - a.length);
  for (const secret of list) output = output.split(secret).join('[REDACTED]');
  return output;
}

/** 连接串里的口令段打码：`postgres://user:pass@host` ⇒ `postgres://user@host`。 */
export function redactConnectionStrings(text) {
  return String(text).replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+):[^\s@/]*@/gi, '$1@');
}

/**
 * 泄密回归：在**任意 JSON 可序列化值**里找出「密钥值逐字出现」的位置，返回路径列表（不含值本身）。
 *
 * 为什么按路径而不是布尔：失败信息要能点名「哪一段泄漏了」，同时自身不能再泄露一次。
 * 只有长度 ≥ {@link SECRET_MIN_LENGTH} 的字符串才算密钥（太短的值会在普通文本里误命中）。
 */
export function findSecretLeaks(value, secrets = []) {
  const list = (secrets ?? []).filter((item) => typeof item === 'string' && item.length >= SECRET_MIN_LENGTH);
  if (list.length === 0) return [];
  const hits = [];
  const walk = (node, path) => {
    if (typeof node === 'string') {
      for (const secret of list) {
        if (node.includes(secret)) {
          hits.push(path);
          return;
        }
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const [key, item] of Object.entries(node)) {
        for (const secret of list) {
          if (key.includes(secret)) hits.push(`${path}.<key>`);
        }
        walk(item, `${path}.${key}`);
      }
    }
  };
  walk(value, '$');
  return [...new Set(hits)].sort();
}

/** 泄密断言：命中即抛错（错误信息只列路径，⛔ 不回显密钥）。 */
export function assertNoSecretLeaks(label, text, secrets = []) {
  const leaks = findSecretLeaks(text, secrets);
  if (leaks.length > 0) {
    throw new Error(`${label} 里出现了密钥值（路径：${leaks.join(', ')}）；⛔ 修实现，不要放宽断言`);
  }
  return true;
}

/** 密钥读数：只有「生成了吗 / 长度够吗」，**绝不**保留值。 */
export function keyDescriptor(value) {
  const generated = typeof value === 'string' && value !== '';
  const length = generated ? value.length : 0;
  return { generated, length_ok: generated && length >= SECRET_MIN_LENGTH, length };
}

// ---------------------------------------------------------------------------
// 摘要 JSON
// ---------------------------------------------------------------------------

/** 递归按键名排序（摘要逐字节稳定的实现手段；数组顺序保持原样）。 */
export function canonicalize(value) {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value !== null && typeof value === 'object') {
    const output = {};
    for (const key of Object.keys(value).sort()) output[key] = canonicalize(value[key]);
    return output;
  }
  return value;
}

/**
 * 构造摘要（形状固定；**所有**字段都是「读数」而非「凭据」）。
 *
 * `keys` 段只接受 {@link keyDescriptor} 的结果（`{generated, length_ok, length}`）：
 * 传进来的是密钥值本身会被 `findSecretLeaks` 抓住，CLI 在打印前还会再断言一次。
 */
export function buildSummary({
  generatedAt,
  repoRoot,
  stateDir,
  outPath = null,
  ports,
  postgres,
  api,
  migrations,
  keys,
  endpoints,
  consentPoliciesRows,
  extraBoundaries = [],
} = {}) {
  const endpointRows = (endpoints ?? []).map((row) => ({
    name: row.name,
    method: row.method,
    path: row.path,
    expected_status: row.expected_status ?? row.expected ?? null,
    status: row.status ?? null,
    ok: row.ok === true,
    detail: row.detail ?? null,
  }));
  return {
    schema: SCHEMA_ID,
    generated_at: generatedAt ?? null,
    repo_root: repoRoot ?? null,
    state_dir: stateDir ?? null,
    summary_path: outPath,
    ports: {
      pg: {
        preferred: ports?.pg?.preferred ?? null,
        actual: ports?.pg?.actual ?? null,
        skipped: (ports?.pg?.skipped ?? []).map((item) => ({ port: item.port, pid: item.holder?.pid ?? null, name: item.holder?.name ?? null })),
      },
      api: {
        preferred: ports?.api?.preferred ?? null,
        actual: ports?.api?.actual ?? null,
        skipped: (ports?.api?.skipped ?? []).map((item) => ({ port: item.port, pid: item.holder?.pid ?? null, name: item.holder?.name ?? null })),
      },
    },
    postgres: {
      version: postgres?.version ?? null,
      host: postgres?.host ?? '127.0.0.1',
      port: postgres?.port ?? null,
      database: postgres?.database ?? null,
      data_dir: postgres?.dataDir ?? null,
      superuser: postgres?.superuser ?? INITDB_DEFAULTS.superuser,
      ready: postgres?.ready === true,
    },
    api: {
      base_url: api?.baseUrl ?? null,
      port: api?.port ?? null,
      pid: api?.pid ?? null,
      execution_mode: api?.executionMode ?? 'stub',
      health: api?.health ?? null,
    },
    migrations: {
      discovered: migrations?.discovered ?? null,
      applied_count: migrations?.appliedCount ?? null,
      skipped_count: migrations?.skippedCount ?? null,
      applied: migrations?.applied ?? null,
    },
    keys: {
      SESSION_SIGNING_KEY: keys?.SESSION_SIGNING_KEY ?? { generated: false, length_ok: false, length: 0 },
      DELETION_LEDGER_KEY: keys?.DELETION_LEDGER_KEY ?? { generated: false, length_ok: false, length: 0 },
      storage: keys?.storage ?? null,
    },
    endpoints: endpointRows,
    checks: { consent_policies_rows: Number.isInteger(consentPoliciesRows) ? consentPoliciesRows : null },
    known_boundaries: [...knownBoundaryLines(consentPoliciesRows), ...extraBoundaries],
  };
}

/** 摘要的**唯一**序列化方式：键名排序 + 2 空格缩进 + 末尾换行 ⇒ 同输入两次逐字节相同。 */
export function serializeSummary(summary) {
  return `${JSON.stringify(canonicalize(summary), null, 2)}\n`;
}

/** 端点读数是否全部符合预期（`up` 的退出码之一靠它）。 */
export function allEndpointsExpected(endpoints = []) {
  return endpoints.length === REQUIRED_ENDPOINTS.length && endpoints.every((row) => row.ok === true);
}
