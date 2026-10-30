/**
 * 本地受控环境（`npm run local:up|down|status`）的**纯逻辑**。
 *
 * 本文件刻意不 import `node:fs` / `node:child_process` / `node:net`：所有判定都只吃「已经算好的输入」，
 * 因此单测可以注入假的端口占用表、假的迁移 stderr、假的密钥值，**不需要真起 PG、也不需要真起服务**。
 * 副作用（建簇、起进程、写文件、发 HTTP）全部留在 `tools/local-env.mjs`。
 *
 * 四条本文件要负责消灭的坑（每一轮手搓都在踩）：
 *   1. 端口照抄文档 ⇒ 撞上无关进程（本机 3100 被 QQ 桥占着，任何路径回 401，看起来像「API 起好了但鉴权失败」）。
 *      判据在 {@link planPort}：占用必须**点名 pid 与命令行**，回退要显式留痕，`--strict-port` 下必须失败。
 *   2. 密钥泄进摘要/日志 ⇒ 判据在 {@link findSecretLeaks} / {@link assertNoSecretLeaks}。
 *   3. `db:migrate` 失败被当成「起好了」⇒ 判据在 {@link classifyMigrateFailure}（非零退出 + 分类 + 原文脱敏）。
 *   4. **按 pid 文件里的 pid 直接发终止信号** ⇒ API 自行退出、pid 被系统复用时**误杀无关进程**
 *      （并且可能丢掉对方未保存的工作）。判据在 {@link assessApiOwnership}：
 *      必须用**可核实的身份**（进程命令行上的实例标识 + 进程启动时间 + 端口套接字归属 + `/health` 身份回显）
 *      证明「这个 pid 属于本工具的 API 实例」，任一不成立 ⇒ 不杀。⛔ 不看「pid 活着」、⛔ 不看「端口在听」。
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
// API 进程的归属核实（停止前必须核实：⛔ 不能只看 pid 活着 / 端口在听）
// ---------------------------------------------------------------------------

/**
 * `api.pid` 的 schema 标识。
 *
 * v1（历史格式）是**纯数字**一行；v2 是结构化 JSON，带 `instanceToken` / `startedAt` / `workTreeRoot`。
 * 形状变化必须改这个串：旧读者（只会 `Number(text)` 的那种）拿到 v2 会读出 `NaN`，
 * 于是走「没有 pid 记录」这条路——**不会**被读成一个能杀的 pid。
 */
export const API_PID_SCHEMA = 'gengyun.local-env.api-pid/2';

/**
 * 本实例的唯一标识在**进程命令行**上的两次落点。
 *
 * 为什么放命令行而不是只放环境变量：Windows 上读**别的进程**的环境块没有可用的标准接口
 * （`Get-CimInstance Win32_Process` 只给 `CommandLine`），而命令行是 OS 自己记的、pid 复用时
 * 一定跟着换人。`instanceToken` 每次 `up` 现生成（UUID），所以「命令行里有它」这件事
 * 只有**本工具启动的那个进程**才可能满足。
 */
export const INSTANCE_FLAG_PREFIX = '--gy-local-env-instance=';
export const ROOT_FLAG_PREFIX = '--gy-local-env-root=';

/** 对应的环境变量名（同时注入，供 API 侧将来回显；当前 API 不回显，见 {@link assessApiOwnership}）。 */
export const INSTANCE_ENV_NAME = 'GY_LOCAL_ENV_INSTANCE';

/**
 * 「进程启动时间不早于 pid 文件写入时间」的容差（毫秒）。
 *
 * 进程启动时间来自 OS（`Win32_Process.CreationDate`，秒级、取整方向不保证），
 * pid 文件写入时间来自 JS（毫秒级）。留 2 秒既吸收取整，也吸收 spawn → 记录之间那几十毫秒。
 */
export const START_TIME_TOLERANCE_MS = 2000;

/**
 * `/health` 的 `uptime_s` 反推启动时刻允许的偏差（毫秒）。
 *
 * `uptime_s` 是 `Math.round(process.uptime())` 的整数秒，反推出来本身有 ±500ms 误差，
 * 再叠一次请求往返。5 秒足够区分「同一个进程」（秒级偏差）与「换了一个进程」（差出分钟/小时）。
 */
export const UPTIME_TOLERANCE_MS = 5000;

/** 归属判定的四种结局（闭集；`status` 的三态由 {@link apiStatusLabel} 映射）。 */
export const OWNERSHIP = Object.freeze({
  /** pid 是本工具的 API 实例，四条判据全部成立 ⇒ 允许停。 */
  OWNED: 'owned',
  /** pid 上坐着**别的**进程（复用），或端口/健康检查指向别的实例 ⇒ ⛔ 不杀。 */
  NOT_OWNED: 'not_owned',
  /** pid 已经不在（正常退出）⇒ 没有要停的东西。 */
  EXITED: 'exited',
  /** 旧格式 pid 文件 ⇒ 没有可核实的身份，只能降级成「不杀 + 提示」。 */
  UNVERIFIABLE: 'unverifiable',
});

/** 判据闭集（`checks[].id`），便于用例与日志逐条点名。 */
export const OWNERSHIP_CHECKS = Object.freeze({
  WORK_TREE: 'work_tree',
  INSTANCE_MARKER: 'instance_marker',
  START_TIME: 'start_time',
  PORT_OWNER: 'port_owner',
  INSTANCE_ECHO: 'instance_echo',
});

/** 三态文案（`status` 与 `down` 共用一处，⛔ 不在 CLI 里另写一份）。 */
const OWNERSHIP_LABELS = Object.freeze({
  owned: '在跑',
  not_owned: '已复用（不属本工具）',
  exited: '已退出',
  unverifiable: '无法核实（旧格式 pid 文件）',
});

/** 归属结局 ⇒ `status` 的三态文案。 */
export function apiStatusLabel(verdict) {
  return OWNERSHIP_LABELS[verdict] ?? '状态未知';
}

/** 路径比较口径：Windows 大小写不敏感、分隔符两种写法混用 ⇒ 归一后再比。 */
function normalizePathForCompare(value) {
  return String(value).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * 构造本实例的两个命令行标识。
 *
 * ⛔ 不允许空白字符进 token（否则从命令行读回时无法与别的参数区分）；根必须是绝对路径。
 */
export function buildInstanceFlags({ instanceToken, workTreeRoot } = {}) {
  if (typeof instanceToken !== 'string' || instanceToken === '' || /\s/.test(instanceToken)) {
    throw new TypeError('instanceToken 必须是非空且不含空白字符的字符串');
  }
  requireAbsolute(workTreeRoot, 'workTreeRoot');
  return [`${INSTANCE_FLAG_PREFIX}${instanceToken}`, `${ROOT_FLAG_PREFIX}${workTreeRoot}`];
}

/**
 * pid 文件 v2 的序列化（固定键序 + 末尾换行 ⇒ 同输入逐字节相同）。
 *
 * 只写「身份读数」：pid、实例 token、写入时刻、工作树根、端口。⛔ 不写密钥、不写令牌。
 */
export function serializeApiPidFile({ pid, instanceToken, startedAt, workTreeRoot, apiPort = null } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) throw new TypeError('pid 必须是正整数');
  if (typeof instanceToken !== 'string' || instanceToken === '') throw new TypeError('instanceToken 必须是非空字符串');
  if (typeof startedAt !== 'string' || !Number.isFinite(Date.parse(startedAt))) throw new TypeError('startedAt 必须是可解析的时间字符串');
  requireAbsolute(workTreeRoot, 'workTreeRoot');
  const record = {
    schema: API_PID_SCHEMA,
    pid,
    instanceToken,
    startedAt,
    workTreeRoot,
    apiPort: Number.isInteger(apiPort) ? apiPort : null,
  };
  return `${JSON.stringify(record, null, 2)}\n`;
}

/**
 * 读 pid 文件（**向后兼容** v1 纯数字）。
 *
 * 返回 `{format, pid, instanceToken, startedAt, workTreeRoot, apiPort, detail}`：
 * - `format: 'v2'`：结构化且字段齐全 ⇒ 可以核实归属；
 * - `format: 'legacy'`：纯数字（v1）⇒ **只能降级成「不可核实」**，⛔ 不许当成「有 pid 就能杀」；
 * - `format: 'invalid'`：空文件 / 坏 JSON / 缺字段 ⇒ 同样不可核实。
 *
 * `pid` 在三种形状下都尽量读出来（只用于「在不在」的读数，不用于放行终止信号）。
 */
export function parseApiPidFile(text) {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (raw === '') {
    return { format: 'invalid', pid: null, instanceToken: null, startedAt: null, workTreeRoot: null, apiPort: null, detail: 'pid 文件为空' };
  }
  if (/^\d+$/.test(raw)) {
    const pid = Number(raw);
    return {
      format: 'legacy',
      pid: Number.isInteger(pid) && pid > 0 ? pid : null,
      instanceToken: null,
      startedAt: null,
      workTreeRoot: null,
      apiPort: null,
      detail: '旧格式 pid 文件（纯数字）：没有 instanceToken / 启动时间 / 工作树根，无法核实归属',
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { format: 'invalid', pid: null, instanceToken: null, startedAt: null, workTreeRoot: null, apiPort: null, detail: 'pid 文件不是合法 JSON' };
  }
  const pid = Number(parsed?.pid);
  const instanceToken = typeof parsed?.instanceToken === 'string' && parsed.instanceToken !== '' ? parsed.instanceToken : null;
  const startedAt = typeof parsed?.startedAt === 'string' && Number.isFinite(Date.parse(parsed.startedAt)) ? parsed.startedAt : null;
  const workTreeRoot = typeof parsed?.workTreeRoot === 'string' && isAbsolute(parsed.workTreeRoot) ? parsed.workTreeRoot : null;
  const apiPort = Number.isInteger(Number(parsed?.apiPort)) ? Number(parsed.apiPort) : null;
  const usable = parsed?.schema === API_PID_SCHEMA && Number.isInteger(pid) && pid > 0 && instanceToken !== null && startedAt !== null && workTreeRoot !== null;
  if (!usable) {
    return {
      format: 'invalid',
      pid: Number.isInteger(pid) && pid > 0 ? pid : null,
      instanceToken,
      startedAt,
      workTreeRoot,
      apiPort,
      detail:
        parsed?.schema === API_PID_SCHEMA
          ? 'pid 文件是 v2 形状但缺字段（pid / instanceToken / startedAt / workTreeRoot 必须都在）'
          : `pid 文件的 schema 不是 ${API_PID_SCHEMA}`,
    };
  }
  return { format: 'v2', pid, instanceToken, startedAt, workTreeRoot, apiPort, detail: null };
}

/**
 * **停止前的归属核实**：证明「pid 文件里的那个 pid 就是本工具启动的 API 实例」。
 *
 * 四条判据，**每条都必须成立**（`skipped` 只用于「端口根本没在听」这种不存在冲突的情形）：
 *
 * | 侧 | 判据 id | 问的问题 | 不成立时的处置 |
 * | --- | --- | --- | --- |
 * | PID | `work_tree` | pid 文件记的工作树根是**本 checkout** 吗？ | 不杀 |
 * | PID | `instance_marker` | 进程命令行带 `--gy-local-env-instance=<本实例 token>` 与 `--gy-local-env-root=<根>` 吗？ | 不杀 |
 * | PID | `start_time` | 进程启动时间**不早于** pid 文件写入时间吗？ | 不杀 |
 * | 端口 | `port_owner` | 监听套接字由**这个 pid** 持有吗？（不是「端口在听」） | 不杀 |
 * | 端口 | `instance_echo` | `/health` 的响应者是这个实例吗？（token 回显，或 uptime 反推启动时刻一致） | 不杀 |
 *
 * 为什么四条都要：`work_tree` + `instance_marker` 挡「pid 被**换成一个更新的**无关进程」
 * （新进程不可能带着我们刚生成的 UUID）；`start_time` 挡「pid 被**换成一个更老的**进程」
 * （pid 文件是旧的、进程比它还老 ⇒ 一定不是我们的）；`port_owner` 挡「端口被别的实例占了」；
 * `instance_echo` 挡「端口上应答的不是这个进程」。任一不成立就**没有资格**发终止信号。
 *
 * ⛔ 判据里**没有**「pid 活着」和「端口在听」这两条：它们恰恰是误杀的来源。
 *
 * 全部输入由调用方注入（进程元数据 / 监听者 / `/health` 读数 / 当前时刻），
 * 本函数不碰 fs、不碰网络、不杀进程 ⇒ 单测可以直接构造「pid 被复用」这类现场。
 *
 * @returns `{verdict, statusLabel, killAllowed, pid, headline, detail, checks, instanceToken}`
 */
export function assessApiOwnership({
  pidRecord = null,
  workTreeRoot = null,
  processInfo = null,
  listener = null,
  health = null,
  now = null,
  startTimeToleranceMs = START_TIME_TOLERANCE_MS,
  uptimeToleranceMs = UPTIME_TOLERANCE_MS,
} = {}) {
  const record = pidRecord ?? {
    format: 'invalid',
    pid: null,
    instanceToken: null,
    startedAt: null,
    workTreeRoot: null,
    apiPort: null,
    detail: '没有 pid 记录',
  };
  const pid = Number.isInteger(record.pid) && record.pid > 0 ? record.pid : null;
  const checks = [];
  const push = (side, id, status, detail) => checks.push({ side, id, status, detail });

  const finish = (verdict, extra = {}) => ({
    verdict,
    statusLabel: apiStatusLabel(verdict),
    killAllowed: verdict === OWNERSHIP.OWNED,
    pid,
    instanceToken: record.instanceToken ?? null,
    headline: extra.headline ?? null,
    detail: extra.detail ?? null,
    checks,
  });

  // ① 没有 pid 记录 ⇒ 没有要停的东西（这不是「归属不明」，是「本来就没起」）。
  if (pid === null) {
    return finish(OWNERSHIP.EXITED, {
      headline: '已退出：没有可用的 pid 记录（api.pid 与 state.json 都没有 pid）',
      detail: record.detail,
    });
  }

  // ② 进程不在了 ⇒ 已退出。**先判这一条**：没什么可杀的时候不需要身份。
  if (processInfo === null || processInfo === undefined || processInfo.alive !== true) {
    return finish(OWNERSHIP.EXITED, { headline: `已退出：pid ${pid} 不在了（进程已自行退出）` });
  }

  // ③ 旧格式 / 坏格式 ⇒ 没有可核实的身份，只能降级。⛔ 不许「尽力而为」地杀。
  if (record.format !== 'v2') {
    return finish(OWNERSHIP.UNVERIFIABLE, {
      headline: `归属无法核实（${record.detail ?? 'pid 文件不是 v2 格式'}）⇒ 已跳过，⛔ 不发送终止信号`,
      detail: '处理：确认没有残留的 local:up 进程后，删掉 api.pid 再跑一次 local:up（新版会写 v2 结构化记录）',
    });
  }

  // ---- PID 侧 -------------------------------------------------------------
  const thisRoot = typeof workTreeRoot === 'string' && workTreeRoot !== '' ? workTreeRoot : null;
  if (thisRoot === null) {
    push('pid', OWNERSHIP_CHECKS.WORK_TREE, 'fail', '调用方没有给当前工作树根 ⇒ 无法判断这份 pid 文件是不是本 checkout 的');
  } else if (normalizePathForCompare(record.workTreeRoot) !== normalizePathForCompare(thisRoot)) {
    push('pid', OWNERSHIP_CHECKS.WORK_TREE, 'fail', `pid 文件属于另一个工作树（${record.workTreeRoot}），当前是 ${thisRoot}`);
  } else {
    push('pid', OWNERSHIP_CHECKS.WORK_TREE, 'pass', `工作树根一致（${thisRoot}）`);
  }

  const commandLine = typeof processInfo.commandLine === 'string' ? processInfo.commandLine : null;
  // 读回来的命令行可能被 OS 加过引号（路径含空格时）：先去掉引号再做包含判断，避免假红。
  const haystack = commandLine === null ? null : commandLine.replace(/"/g, '').toLowerCase();
  const tokenNeedle = `${INSTANCE_FLAG_PREFIX}${record.instanceToken}`.toLowerCase();
  const rootNeedle = `${ROOT_FLAG_PREFIX}${record.workTreeRoot}`.toLowerCase();
  if (haystack === null) {
    push('pid', OWNERSHIP_CHECKS.INSTANCE_MARKER, 'fail', '读不到进程命令行 ⇒ 无法核实实例标识（⛔ 不靠 pid 猜）');
  } else if (!haystack.includes(tokenNeedle)) {
    push('pid', OWNERSHIP_CHECKS.INSTANCE_MARKER, 'fail', `进程命令行不含本实例标识（${INSTANCE_FLAG_PREFIX}${record.instanceToken}）⇒ pid 已被别的进程复用`);
  } else if (!haystack.includes(rootNeedle)) {
    push('pid', OWNERSHIP_CHECKS.INSTANCE_MARKER, 'fail', `进程命令行不含本工作树根标识（${ROOT_FLAG_PREFIX}${record.workTreeRoot}）⇒ 归属不符`);
  } else {
    push('pid', OWNERSHIP_CHECKS.INSTANCE_MARKER, 'pass', `进程命令行带本实例标识（${INSTANCE_FLAG_PREFIX}<instanceToken>）与工作树根`);
  }

  const startedAtMs = Date.parse(record.startedAt);
  const processStartMs = typeof processInfo.startTime === 'string' ? Date.parse(processInfo.startTime) : Number.NaN;
  if (!Number.isFinite(processStartMs)) {
    push('pid', OWNERSHIP_CHECKS.START_TIME, 'fail', '读不到进程启动时间（Win32_Process.CreationDate 为空）⇒ 无法核实，⛔ 不靠 pid 猜');
  } else if (!Number.isFinite(startedAtMs)) {
    push('pid', OWNERSHIP_CHECKS.START_TIME, 'fail', `pid 文件里的写入时间不可解析（${String(record.startedAt)}）`);
  } else if (processStartMs < startedAtMs - startTimeToleranceMs) {
    push(
      'pid',
      OWNERSHIP_CHECKS.START_TIME,
      'fail',
      `进程启动时间 ${new Date(processStartMs).toISOString()} 早于 pid 文件写入时间 ${record.startedAt} ⇒ pid 已被更老的进程复用`,
    );
  } else {
    push(
      'pid',
      OWNERSHIP_CHECKS.START_TIME,
      'pass',
      `进程启动时间 ${new Date(processStartMs).toISOString()} 不早于 pid 文件写入时间 ${record.startedAt}`,
    );
  }

  // ---- 端口侧 -------------------------------------------------------------
  const port = Number.isInteger(listener?.port) ? listener.port : (Number.isInteger(record.apiPort) ? record.apiPort : null);
  const portText = port === null ? '端口' : `端口 ${port}`;
  if (listener === null || listener === undefined || typeof listener.listening !== 'boolean') {
    // 没有端口读数 ⇒ 不能凭空放行（这也是「只判 pid 活着」那种实现会漏掉的地方）。
    push('port', OWNERSHIP_CHECKS.PORT_OWNER, 'fail', '没有端口探测读数 ⇒ 无法核实端口归属，⛔ 不发送终止信号');
    push('port', OWNERSHIP_CHECKS.INSTANCE_ECHO, 'skipped', '端口归属未核实 ⇒ 不做握手');
  } else if (listener.listening !== true) {
    // 端口没在听 ⇒ 不存在「端口被别的实例占着」这件事；身份由 PID 侧独立成立即可。
    push('port', OWNERSHIP_CHECKS.PORT_OWNER, 'skipped', `${portText}没有监听 ⇒ 没有端口归属可冲突（以 PID 侧身份为准）`);
    push('port', OWNERSHIP_CHECKS.INSTANCE_ECHO, 'skipped', `${portText}没有监听 ⇒ 无从握手`);
  } else if (Number.isInteger(listener.pid) && listener.pid === pid) {
    push('port', OWNERSHIP_CHECKS.PORT_OWNER, 'pass', `${portText}的监听套接字由 pid ${pid} 持有（端口 ↔ pid 绑定成立）`);
  } else if (!Number.isInteger(listener.pid)) {
    push('port', OWNERSHIP_CHECKS.PORT_OWNER, 'fail', `${portText}在听，但拿不到持有进程（PowerShell 探测失败）⇒ 无法核实`);
  } else {
    push('port', OWNERSHIP_CHECKS.PORT_OWNER, 'fail', `${portText}由 pid ${listener.pid} 持有，不是 pid ${pid} ⇒ 端口归属不符`);
  }

  const portOwnerFailed = checks.some((item) => item.id === OWNERSHIP_CHECKS.PORT_OWNER && item.status === 'fail');
  if (listener !== null && listener !== undefined && listener.listening === true && !portOwnerFailed) {
    const healthText = health ?? null;
    if (healthText === null || healthText.reachable !== true) {
      push('port', OWNERSHIP_CHECKS.INSTANCE_ECHO, 'fail', `${portText}在听，但 /health 没有响应 ⇒ 无法核实响应者是不是本实例，⛔ 不发送终止信号`);
    } else if (typeof healthText.instanceToken === 'string' && healthText.instanceToken !== '') {
      if (healthText.instanceToken !== record.instanceToken) {
        push('port', OWNERSHIP_CHECKS.INSTANCE_ECHO, 'fail', `/health 回显的 instanceToken（${healthText.instanceToken}）与本实例（${record.instanceToken}）不一致 ⇒ 端口上应答的不是本实例`);
      } else {
        push('port', OWNERSHIP_CHECKS.INSTANCE_ECHO, 'pass', '/health 回显的 instanceToken 与本实例一致');
      }
    } else if (!Number.isFinite(healthText.uptimeSeconds) || !Number.isFinite(processStartMs) || !Number.isFinite(nowMsOf(now))) {
      push('port', OWNERSHIP_CHECKS.INSTANCE_ECHO, 'fail', '/health 没有可用的身份读数（既无 instanceToken，也读不出 uptime / 启动时刻）⇒ 无法核实');
    } else {
      // 没有 token 回显时（当前 API 不回显）：用 uptime 反推启动时刻，与**本 pid 的 OS 启动时刻**对齐。
      // 换过人的进程不可能和这个时刻对得上（差出分钟级）。⛔ 不依赖状态码、不依赖固定字符串。
      const derivedMs = nowMsOf(now) - healthText.uptimeSeconds * 1000;
      const delta = Math.abs(derivedMs - processStartMs);
      if (delta <= uptimeToleranceMs) {
        push('port', OWNERSHIP_CHECKS.INSTANCE_ECHO, 'pass', `/health 的 uptime 反推启动时刻与本 pid 的 OS 启动时刻一致（相差 ${Math.round(delta / 1000)}s）`);
      } else {
        push('port', OWNERSHIP_CHECKS.INSTANCE_ECHO, 'fail', `/health 的 uptime 反推启动时刻（${new Date(derivedMs).toISOString()}）与 pid ${pid} 的 OS 启动时刻（${new Date(processStartMs).toISOString()}）相差 ${Math.round(delta / 1000)}s ⇒ 端口上应答的不是这个进程`);
      }
    }
  }

  const failures = checks.filter((item) => item.status === 'fail');
  if (failures.length === 0) {
    return finish(OWNERSHIP.OWNED, {
      headline: `归属已核实（pid ${pid}）：命令行带本实例标识、启动时间不早于 pid 文件、端口与 /health 都属于它`,
    });
  }
  const first = failures[0];
  return finish(OWNERSHIP.NOT_OWNED, {
    headline: `PID 已复用 / 归属不符，已跳过：${first.detail}`,
    detail: `未通过的判据：${failures.map((item) => `${item.side}/${item.id}`).join('、')}`,
  });
}

/** `now` 的归一：接受 Date / ISO 字符串 / 毫秒数；不认识就返回 `NaN`（调用方据此判「读不到」）。 */
function nowMsOf(now) {
  if (now === null || now === undefined) return Number.NaN;
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'number') return now;
  if (typeof now === 'string') return Date.parse(now);
  return Number.NaN;
}

/**
 * 只做「该不该杀」这一步：**归属核实通过才调用注入的 `kill`**，且只调一次。
 *
 * 把「决定」与「副作用」分开，单测才能用假 killer 断言「零 kill 调用」——
 * 真实的 `process.kill` 永远不进单测（⛔ 不在单测里真杀进程）。
 */
export function applyApiStop({ assessment = null, kill = null } = {}) {
  if (assessment === null || typeof assessment !== 'object') throw new TypeError('assessment 必须是 assessApiOwnership 的结果');
  if (kill !== null && typeof kill !== 'function') throw new TypeError('kill 必须是函数或 null');
  if (assessment.killAllowed !== true) {
    return { killed: false, killCalls: 0, pid: assessment.pid ?? null, verdict: assessment.verdict ?? null, skipped: true };
  }
  const pid = assessment.pid;
  if (!Number.isInteger(pid) || pid <= 0) {
    return { killed: false, killCalls: 0, pid: null, verdict: assessment.verdict ?? null, skipped: true };
  }
  if (kill === null) return { killed: false, killCalls: 0, pid, verdict: assessment.verdict, skipped: true };
  kill(pid);
  return { killed: true, killCalls: 1, pid, verdict: assessment.verdict, skipped: false };
}

/** 把判据表渲染成人话（`down` / `status` 逐条打印；`⛔` 不省略失败项）。 */
export function describeOwnershipChecks(assessment) {
  const checks = assessment?.checks ?? [];
  return checks.map((item) => {
    const mark = item.status === 'pass' ? '✓' : item.status === 'skip' || item.status === 'skipped' ? '–' : '✗';
    return `${mark} ${item.side}/${item.id}：${item.detail}`;
  });
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
