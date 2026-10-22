#!/usr/bin/env node
/**
 * GY-R32 · #19 · 到期清除**调度层**的 fail-closed 门禁 —— **纯静态**：
 * ⛔ 不连库、不起服务、不读凭据、不写任何文件、不联网、无第三方依赖。
 *
 * ## 它要堵的缺口（本片开工前实测，基线 `4de2af7d`）
 * 驱动者是完整的（`services/api/src/privacy/online-purge-driver.ts` 696 行、
 * `backup-purge-driver.ts` 564 行），`package.json` 也有 `purge:online-data` /
 * `purge:backup-copies`，但**调度层是空的**：
 *   · 15 个 workflow 里 `schedule:` / `cron:` **零命中**；
 *   · `deploy/` 下一个 `.timer` 都没有（唯一的 `.service` 是 PG 服务端自己那份）；
 *   · `services/api/src` 里 `setInterval` 只出现在**注释**里（这正是设计：命令由外部调度）；
 *   · 仓内唯一的「调度」是一段文档示例（`docs/verification/gy-r28-w6-deletion-clock-20261021.md`
 *     里那段「每 10 分钟一次」的 cron 示例），而那份文档自己写着「仓内没有 cron/systemd timer/workflow 接线」。
 * ⇒ 「7 日到期」在当时只有**执行者**、没有**时钟**。本脚本把「时钟接好了」变成可判定。
 *
 * ## 判据与退出码（0 = 通过，1 = 有硬错，2 = 用法错误）
 *
 *   [surface]      本目录必须存在且**至少 1 个 `.service` + 1 个 `.timer`**。
 *                  扫到 0 个单元按红处理 ——「什么都没扫到」也是一种绿，不能放行。
 *   [pair]         `.service` ↔ `.timer` 必须成对：每个 service 有同名 timer；每个 timer 的
 *                  `Unit=`（缺省＝同名 service）必须指向真实存在的 service 文件。
 *                  只有 service 没 timer ⇒ 命令永远不会被叫醒（缺口原形）；只 timer 没 service
 *                  ⇒ systemd 起不来（`Unit=` 悬空）。
 *   [calendar]     每个 `.timer` 必须有 `OnCalendar=` 或 `OnUnitActiveSec=`，且**展开后的最大间隔
 *                  ≤ 60 分钟**。`OnCalendar` 是被**展开**算的（`*:00/10:00` ⇒ 10 分钟），
 *                  不是「写了 OnCalendar 就放行」：写 `*-*-* 02:00:00`（每天一次）也满足语法，
 *                  但对「7 日到期」等同于没有时钟。看不懂的日历形态（`hourly` / `Mon..Fri` /
 *                  非每天）一律红并点名，⛔ 不猜。
 *   [execstart]    每个 `.service` 的 `ExecStart=` 必须
 *                  ① 给出**绝对路径**的入口文件（systemd 本身也要求绝对路径）；
 *                  ② 该入口在**本树上真实存在**（按最长真实后缀映射回仓库相对路径）；
 *                  ③ 与 `GY-SCHEDULE: npm-script=<name>` 指向的 `package.json` script **同一个入口文件**
 *                     （按仓库相对路径比对；部署根 `/opt/gengyun/app` 这类前缀不影响判定）。
 *                  为什么必须同源：运维照着 `npm run purge:online-data` 手动补跑、与调度跑的是
 *                  两条命令时，任何一次口径改动都会只改一边 —— 那是最难发现的一类漂移。
 *   [cursor]       **在线**单元（入口＝`tools/purge-expired-online-data.mjs`）必须带 `--cursor-file=`
 *                  且值是**绝对路径**，⛔ 不得出现 `--no-cursor`。
 *                  依据：`services/api/src/privacy/online-purge-cursor.ts` 的缺省游标是**相对 cwd**
 *                  的（`DEFAULT_ONLINE_PURGE_CURSOR_FILE`，该文件自陈「cron 里 cwd 是谁就写谁下面」）
 *                  ⇒ 在 systemd/cron 下相对路径会随 cwd 漂移、每轮从队首重扫、进度丢失。
 *                  另：若同时给了 `StateDirectory=`，游标必须落在 `/var/lib/<StateDirectory>/` 里 ——
 *                  否则 systemd 不会创建/chown 那个目录，写游标会 EACCES（每轮退出码 2）。
 *                  **比对前先做 POSIX 归一化**（折叠 `.`/`..`）：`/var/lib/<state>/../../etc/passwd`
 *                  归一化后是 `/var/etc/passwd`（`<state>` 的两级 `..` 回到 `/var`）⇒ 逃出状态目录、判红。
 *                  只做字符串前缀比对会把这种「逃出状态目录」的写法放过去（门禁假绿、部署 EACCES），
 *                  所以这里必须归一化后**再**比前缀。
 *   [secrets]      单元里⛔ 不得出现内联连接串或口令键（`…://`、`DATABASE_URL=`、`PGPASSWORD=`、
 *                  以及任何 `*PASS*` / `*PWD*` / `*SECRET*` / `*TOKEN*` / `*APIKEY*` / `*DSN*` /
 *                  `*URL*` 命名的内联键 —— 含 `Environment=DB_PASS=…` 这种非常见键名），且每个
 *                  `.service` **必须**有 `EnvironmentFile=`。凭据只能经该文件进入（systemd 路线
 *                  root:root 0600；cron 路线 root:<同名组> 0640，见 deploy/purge-schedule/README.md）。
 *                  扫描面含注释行：注释里的真连接串一样会被 `git log`/工单带出去。
 *   [setinterval]  `services/api/src/**` 里的 `setInterval(` **调用**计数必须为 **0**。识别口径不是
 *                  字面子串，而是：① `setInterval(`；② 任意前缀（含 `globalThis.`）后的
 *                  `setInterval(`；③ 标识符与 `(` 之间带空白的 `setInterval (`；④ 计算成员写法
 *                  `['setInterval'](`。
 *                  这是把「无进程内调度器」从**注释里的声明**变成**机器可判的判据**：
 *                  驱动模块的文件头写着「⛔ 不用 setInterval 常驻定时器」，但此前没有任何门禁
 *                  阻止后人在 API 进程里加一个 —— 那会让多副本重复执行、重启丢语义、并与 CI/真库臂
 *                  抢同一批行。计数口径刻意从严（**含注释**）：注释里的 `setInterval(` 常常就是
 *                  下一次复制成代码的那一行。
 *   [npm-script]   单元必须用注释指令 `# GY-SCHEDULE: npm-script=<name>` 声明它驱动哪条 npm script，
 *                  且该 name **必须存在于 `package.json` 的 `scripts`**（改名/删除 script 而单元没跟
 *                  ⇒ 红）。缺指令也红：没有它就无法证明「单元跑的就是那条 script」。
 *   [hygiene]      每个 `.service` 必须有 `User=`（且⛔ 不是 `root`）、`StateDirectory=`、
 *                  `TimeoutStartSec=`（> 0）。前两条是权限面（⛔ 不以 root 跑、状态目录由 systemd
 *                  创建并 chown）；`TimeoutStartSec=` 是**防重叠**的第二道：oneshot 单实例语义
 *                  保证「上一轮没跑完不会起第二轮」，超时上界保证「卡住的连接不会永远占着实例」。
 *   [coverage]     `REQUIRED_NPM_SCRIPTS` 里的**每条**命令都必须被至少一个 `.service` 覆盖。
 *                  防的是「删掉一整条单元就变绿」：只判形态不判覆盖时，两条命令少接一条也能过。
 *
 * ## 刻意**不做**（不冒充能力）
 *   · ⛔ 不证明外部调度真的在跑：单元文件在仓里只说明「装上去应按这个周期跑」。
 *     `systemctl list-timers` 有读数、`/etc/cron.d/*` 存在、日志在长，才算运行侧取得 —— 那是运维动作，
 *     仓库里没有它的证据（见 `deploy/purge-schedule/README.md` 的「本目录不证明的事」）。
 *   · ⛔ 不执行任何单元、不调 `systemd-analyze`、不校验 `EnvironmentFile=` 指向的文件是否存在
 *     （那是**目标宿主机**上的路径，仓里不存在是正常的）。
 *   · ⛔ 不判断 `OnCalendar=` 的语义是否「合理」（只判间隔上界与可解析性）。
 *   · ⛔ 不查 `crontab.example` 与 `README.md`（判据面就是 `.service` / `.timer`；cron 路线的等价性
 *     靠人读 README 的逐项对应表）。
 *
 * ## 用法
 *   node tools/verify-purge-schedule.mjs                  # 扫仓内默认目录
 *   node tools/verify-purge-schedule.mjs --json           # 机读：failures[] / counts{} / units[] / readings[]
 *   node tools/verify-purge-schedule.mjs --root <目录>    # 换仓库根（负控制/夹具用）
 *   node tools/verify-purge-schedule.mjs --dir <相对路径> # 换调度目录（相对 --root）
 *   node tools/verify-purge-schedule.mjs --help
 *
 * 退出码：0 = 全部判据满足；1 = 有硬错；2 = 用法错误（⛔ 不是「通过」）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根：由本脚本自身位置推出（`tools/` 的上一级），⛔ 不用 `process.cwd()`。 */
export const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 默认调度目录（相对仓库根）。 */
export const DEFAULT_SCHEDULE_DIR = 'deploy/purge-schedule';

/**
 * 必须被调度覆盖的 npm script。加一条＝收紧门禁（同时要有一条对应的 `.service`），刻意留 diff。
 * 两条命令各对应一个到期窗口：在线 7 日（`deletion_requests.online_due_at`）与备份副本 30 日
 * （`user_backup_copies.retention_until`）。
 */
export const REQUIRED_NPM_SCRIPTS = Object.freeze(['purge:online-data', 'purge:backup-copies']);

/** 需要「绝对路径游标」的入口文件（仓库相对路径）。 */
export const CURSOR_REQUIRED_ENTRY = 'tools/purge-expired-online-data.mjs';

/** 调度间隔上界（分钟）：到期清除的「时钟」不能比这更稀。 */
export const MAX_INTERVAL_MINUTES = 60;

/** `setInterval(` 禁令的扫描面（仓库相对目录）。 */
export const SETINTERVAL_SCAN_DIR = 'services/api/src';

/** 扫描面里的代码扩展名（只数这些；`.md` / `.sql` 里的说明不算代码）。 */
const CODE_EXTS = Object.freeze(['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs', '.jsx']);

/** 判据编号（也是报告里 `FAIL[<id>]` 的前缀）。 */
export const CRITERIA = Object.freeze([
  'surface',
  'pair',
  'calendar',
  'execstart',
  'cursor',
  'secrets',
  'setinterval',
  'npm-script',
  'hygiene',
  'coverage',
]);

/** 单元里必须出现的注释指令：`# GY-SCHEDULE: npm-script=<name>`。 */
export const NPM_SCRIPT_DIRECTIVE = /GY-SCHEDULE:\s*npm-script=([A-Za-z0-9:_-]+)/;

/**
 * 内联凭据键名的保守子集（见文件头 [secrets]）。
 * 刻意**不**收 `KEY`／`AUTH`／`USER`／`HOST` 这类常见但不必然保密的词：判据宁可窄一点，
 * 也不要因为误报让运维把整条 `Environment=` 关掉；`PASSWORD`/`PGPASSWORD`/`POSTGRES_PASSWORD`
 * 都被 `PASS` 覆盖，`DATABASE_URL`/`REDIS_URL` 被 `URL` 覆盖。
 */
const CREDENTIAL_NAME = '(?:PASS|PWD|SECRET|TOKEN|APIKEY|API_KEY|CREDENTIAL|DSN|CONNSTR|CONNECTION|URL)';

/**
 * 任意位置的「凭据键 = 值」：`DB_PASS=`、`PGPASSWORD=`、`MY_SECRET=`、`REDIS_URL=`、`DSN=` …
 * 前置 `(?<![A-Za-z0-9_])` 只排除「长标识符的中间」这一种情况（`XDB_PASS=` 仍会命中，
 * 因为键名本身就含 `PASS`）—— 口径是有 `=` 收尾的**赋值**，不要求出现在 `Environment=` 里。
 */
const INLINE_CREDENTIAL_ASSIGNMENT = new RegExp(
  `(?<![A-Za-z0-9_])[A-Za-z0-9_]*${CREDENTIAL_NAME}[A-Za-z0-9_]*\\s*=`,
  'i',
);

/** `Environment=KEY=VALUE` 形态里，只要键名落在上面的保守子集里就判红（非常见键名也拦）。 */
const ENVIRONMENT_CREDENTIAL_ASSIGNMENT = new RegExp(
  `\\bEnvironment\\s*=.*${CREDENTIAL_NAME}`,
  'i',
);

/** 内联凭据的硬判据（扫描面含注释行，见文件头 [secrets]）。 */
const INLINE_SECRET_PATTERNS = Object.freeze([
  { pattern: /[a-z][a-z0-9+.-]*:\/\//i, label: '内联连接串（形如 scheme://…）' },
  { pattern: /\bDATABASE_URL\s*=/, label: '内联 DATABASE_URL=' },
  { pattern: /\bPGPASSWORD\s*=/, label: '内联 PGPASSWORD=' },
  { pattern: /\bPOSTGRES_PASSWORD\s*=/, label: '内联 POSTGRES_PASSWORD=' },
  {
    pattern: INLINE_CREDENTIAL_ASSIGNMENT,
    label: '内联凭据键（*PASS* / *PWD* / *SECRET* / *TOKEN* / *APIKEY* / *DSN* / *URL* 等）',
  },
  {
    pattern: ENVIRONMENT_CREDENTIAL_ASSIGNMENT,
    label: 'Environment= 里内联口令/令牌/连接串键',
  },
]);

/**
 * `setInterval` 调用的识别口径（见文件头 [setinterval]）。
 * 刻意不用字面子串：`globalThis.setInterval(`（任意前缀）与 `setInterval (`（空白）都要算命中，
 * 否则「无进程内调度器」这条判据只要换个写法就绕过去了。下标写法 `['setInterval'](` 一并收。
 */
export const SETINTERVAL_PATTERNS = Object.freeze([
  { pattern: /\bsetInterval\s*\(/, label: 'setInterval(' },
  { pattern: /\[\s*['"]setInterval['"]\s*\]\s*\(/, label: "['setInterval'](" },
]);

/** systemd 时长单位（`OnUnitActiveSec=` 与 `TimeoutStartSec=` 共用）。 */
const DURATION_UNITS = Object.freeze({
  us: 1e-6, usec: 1e-6, ms: 1e-3, msec: 1e-3,
  s: 1, sec: 1, secs: 1, second: 1, seconds: 1,
  m: 60, min: 60, mins: 60, minute: 60, minutes: 60,
  h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600,
  d: 86400, day: 86400, days: 86400,
  w: 604800, week: 604800, weeks: 604800,
});

const USAGE = [
  '用法：',
  '  node tools/verify-purge-schedule.mjs                  # 扫 deploy/purge-schedule/',
  '  node tools/verify-purge-schedule.mjs --json           # 机读：failures[]/counts{}/units[]/readings[]',
  '  node tools/verify-purge-schedule.mjs --root <目录>     # 换仓库根（负控制/夹具用）',
  '  node tools/verify-purge-schedule.mjs --dir <相对路径>  # 换调度目录（相对 --root）',
  '  node tools/verify-purge-schedule.mjs --help',
  '',
  `判据：${CRITERIA.join(' / ')} —— 详见文件头注释。`,
  `每条 .timer 的间隔必须 ≤ ${MAX_INTERVAL_MINUTES} 分钟；${SETINTERVAL_SCAN_DIR}/** 的 setInterval 调用计数必须为 0。`,
  '退出码：0 = 全部满足；1 = 有硬错；2 = 用法错误。',
].join('\n');

/** 读文本，读不到返回 `null`（⛔ 不抛：缺文件由判据点名，而不是让脚本崩掉）。 */
function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** 目录判定：不抛异常，不存在/不是目录都返回 false。 */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 解析 systemd 单元：返回 `directives`（`key=value`，保留行号）与原始 `lines`。
 *
 * 注释行（`#` / `;` 开头）不进 `directives`，但 `[secrets]` 另行扫描**全文**（含注释）——
 * 因为「注释里的连接串」同样是泄漏（会被 `git log`、工单、`systemctl cat` 带出去）。
 */
export function parseUnit(text) {
  const directives = [];
  const lines = String(text).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    directives.push({
      key: trimmed.slice(0, eq).trim(),
      value: trimmed.slice(eq + 1).trim(),
      line: index + 1,
      text: trimmed,
    });
  }
  return { directives, lines };
}

/** 取某个指令的**第一个**值（systemd 允许重复键；这里只核对首值）。 */
export function firstDirective(directives, key) {
  return directives.find((directive) => directive.key === key) ?? null;
}

/**
 * 展开一个 systemd 日历字段（`*`、`N`、`N/M`、`N..M`、`N..M/S` 与逗号列表）。
 * 看不懂就返回 `null`（调用方据此判红，⛔ 不猜）。
 */
export function expandCalendarField(field, min, max) {
  const values = new Set();
  for (const rawPart of String(field).split(',')) {
    const spec = rawPart.trim();
    if (spec === '') return null;
    const match = /^(?:(\d+|\*)(?:\.\.(\d+))?)(?:\/(\d+))?$/.exec(spec);
    if (match === null) return null;
    const [, startRaw, endRaw, stepRaw] = match;
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) return null;
    let start;
    let end;
    if (startRaw === '*') {
      start = min;
      end = max;
    } else {
      start = Number(startRaw);
      end = endRaw === undefined ? (stepRaw === undefined ? start : max) : Number(endRaw);
    }
    if (start > end) return null;
    for (let value = start; value <= end; value += step) {
      if (value < min || value > max) return null;
      values.add(value);
    }
  }
  return [...values].sort((left, right) => left - right);
}

/**
 * 把一条 `OnCalendar=` 值展开成「一天内的触发秒偏移」列表（升序去重）。
 *
 * 支持面（刻意窄，看不懂就 `null`）：`*-*-* <HH>:<MM>[:<SS>]`，各字段支持
 * `*`、`N`、`N/M`、`N..M`、`N..M/S` 与逗号列表。
 * ⛔ 不支持 `hourly`/`daily`/`weekly` 之类助记符，也不支持星期/月份限定 —— 那些形态下
 * 「间隔 ≤ 60 分钟」要么恒假（daily）要么需要一套真正的日历求值器；与其猜，不如让人写成显式形态。
 */
export function calendarFireSeconds(value) {
  const parts = String(value).trim().split(/\s+/);
  if (parts.length !== 2) return null;
  const [datePart, timePart] = parts;
  if (!/^\*-\*-\*$/.test(datePart)) return null;
  const timeFields = timePart.split(':');
  if (timeFields.length < 2 || timeFields.length > 3) return null;
  const hours = expandCalendarField(timeFields[0], 0, 23);
  const minutes = expandCalendarField(timeFields[1], 0, 59);
  const seconds = timeFields.length === 3 ? expandCalendarField(timeFields[2], 0, 59) : [0];
  if (hours === null || minutes === null || seconds === null) return null;
  const offsets = new Set();
  for (const hour of hours) {
    for (const minute of minutes) {
      for (const second of seconds) offsets.add(hour * 3600 + minute * 60 + second);
    }
  }
  return [...offsets].sort((left, right) => left - right);
}

/** 一天内触发点的**最大间隔**（秒，含跨日那一跳）。空列表返回 `null`。 */
export function maxGapSeconds(offsets) {
  if (!Array.isArray(offsets) || offsets.length === 0) return null;
  const day = 24 * 60 * 60;
  if (offsets.length === 1) return day;
  let max = 0;
  for (let index = 1; index < offsets.length; index += 1) {
    max = Math.max(max, offsets[index] - offsets[index - 1]);
  }
  return Math.max(max, day - offsets[offsets.length - 1] + offsets[0]);
}

/** 解析 systemd 时长（`10min` / `900` / `1h30m`）；解析不了返回 `null`。 */
export function parseSystemdDurationSeconds(text) {
  const raw = String(text ?? '').trim();
  if (raw === '') return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  const pattern = /(\d+(?:\.\d+)?)\s*([a-z]+)/gi;
  let total = 0;
  let consumed = '';
  let match;
  while ((match = pattern.exec(raw)) !== null) {
    const unit = DURATION_UNITS[match[2].toLowerCase()];
    if (unit === undefined) return null;
    total += Number(match[1]) * unit;
    consumed += match[0];
  }
  if (consumed === '') return null;
  if (consumed.replace(/\s+/g, '') !== raw.replace(/\s+/g, '')) return null;
  return total;
}

/** 把一条命令值切成 token（去引号）；⛔ 不解释 shell 语法（systemd 也不解释）。 */
export function tokenizeCommand(value) {
  return String(value)
    .split(/\s+/)
    .map((token) => token.trim().replace(/^['"]|['"]$/g, ''))
    .filter((token) => token !== '');
}

/** 统一斜杠并去掉 `./` 前缀（Windows 上造夹具时也要能对上）。 */
function normalizeRepoPath(path) {
  return String(path).replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
}

/** `package.json` 里某条 npm script 的**入口文件**（仓库相对路径）；解析不了返回 `null`。 */
export function npmScriptEntry(scriptCommand) {
  const match = /\bnode\s+(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(String(scriptCommand ?? ''));
  if (match === null) return null;
  const entry = normalizeRepoPath((match[1] ?? match[2] ?? match[3] ?? '').trim());
  return entry === '' ? null : entry;
}

/** `ExecStart=` 里第一个形如 `*.mjs|*.js` 的 token（＝入口文件）；没有返回 `null`。 */
export function execStartEntry(value) {
  return tokenizeCommand(value).find((token) => /\.(?:mjs|cjs|js)$/i.test(token)) ?? null;
}

/**
 * 从 `ExecStart=` 里取游标参数。
 * 两种写法都认：`--cursor-file=<path>` 与 `--cursor-file <path>`；同时报告是否出现 `--no-cursor`。
 */
export function cursorArgs(value) {
  const tokens = tokenizeCommand(value);
  const files = [];
  let noCursor = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--no-cursor') {
      noCursor = true;
      continue;
    }
    if (token.startsWith('--cursor-file=')) {
      files.push(token.slice('--cursor-file='.length));
      continue;
    }
    if (token === '--cursor-file' && typeof tokens[index + 1] === 'string') {
      files.push(tokens[index + 1]);
      index += 1;
    }
  }
  return { files, noCursor };
}

/** 递归列出扫描面里的代码文件（跳过 `node_modules` / `.git`）。 */
function collectCodeFiles(dir, found = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      collectCodeFiles(full, found);
      continue;
    }
    if (entry.isFile() && CODE_EXTS.some((ext) => entry.name.toLowerCase().endsWith(ext))) found.push(full);
  }
  return found;
}

/**
 * `services/api/src/**` 里的 `setInterval(` 调用计数（含注释，口径见文件头 [setinterval]）。
 * 返回 `{ hits: [{file,line,form,text}], files }`；`form` 是命中的写法、`text` 是原行
 * （报告里点名用 —— 只报「有命中」而不给人看那一行，定位不到人）。
 */
export function findSetIntervalCalls(root, scanDir = SETINTERVAL_SCAN_DIR) {
  const base = join(root, scanDir);
  const files = collectCodeFiles(base).sort();
  const hits = [];
  for (const file of files) {
    const text = readText(file);
    if (text === null) continue;
    const relative = normalizeRepoPath(resolve(file).slice(resolve(root).length + 1));
    text.split(/\r?\n/).forEach((line, index) => {
      const matched = SETINTERVAL_PATTERNS.find(({ pattern }) => pattern.test(line));
      if (matched !== undefined) {
        hits.push({ file: relative, line: index + 1, form: matched.label, text: line.trim() });
      }
    });
  }
  return { hits, files: files.length };
}

/**
 * 把 `ExecStart=` 里的绝对入口映射回**仓库相对路径**：从最长后缀开始试探，
 * 第一个在树上真实存在的就认它。
 *
 * 为什么按后缀而不是「剥掉部署前缀」：部署根（`/opt/gengyun/app`）是**宿主机**的事实，
 * 仓里没有它、也不该硬编码。于是「同一入口文件」的判据与部署根无关。
 * 一个后缀都不存在时返回 `null`（调用方据此判红：文件不在树上）。
 */
export function repoRelativeEntry(root, absoluteEntry) {
  const normalized = normalizeRepoPath(absoluteEntry).replace(/^\/+/, '');
  const segments = normalized.split('/').filter((segment) => segment !== '');
  for (let start = 0; start < segments.length; start += 1) {
    const candidate = segments.slice(start).join('/');
    try {
      if (statSync(join(root, candidate)).isFile()) return candidate;
    } catch {
      // 继续缩短后缀
    }
  }
  return null;
}

/**
 * 跑全部判据。只读文件系统，不改任何东西。
 *
 * @param {{ root?: string, scheduleDir?: string }} [options]
 * @returns {{
 *   ok: boolean, failures: Array<{id: string, file: string, message: string}>,
 *   readings: string[], units: Array<object>, root: string, scheduleDir: string,
 *   counts: Record<string, number>,
 * }}
 */
export function verifyPurgeSchedule(options = {}) {
  const root = resolve(options.root ?? DEFAULT_ROOT);
  const scheduleDirRel = normalizeRepoPath(options.scheduleDir ?? DEFAULT_SCHEDULE_DIR);
  const scheduleDir = isAbsolute(scheduleDirRel) ? scheduleDirRel : join(root, scheduleDirRel);

  /** @type {Array<{id: string, file: string, message: string}>} */
  const failures = [];
  /** @type {string[]} */
  const readings = [];
  const fail = (id, file, message) => failures.push({ id, file, message });
  const display = (absolute) => normalizeRepoPath(
    absolute.startsWith(root) ? absolute.slice(root.length + 1) : absolute,
  );

  const counts = {
    services: 0, timers: 0, units: 0,
    setIntervalFiles: 0, setIntervalHits: 0,
    npmScripts: 0, coveredNpmScripts: 0,
  };
  /** @type {Array<Record<string, unknown>>} */
  const units = [];

  const done = () => ({
    ok: failures.length === 0,
    failures,
    readings,
    units,
    root,
    scheduleDir: scheduleDirRel,
    counts,
  });

  // ---------------------------------------------------------------- [surface]
  if (!isDirectory(scheduleDir)) {
    fail('surface', scheduleDirRel, `找不到调度目录：${scheduleDirRel}\n`
      + '  ⇒ 守着一个不存在的目录只会「扫到 0 个单元 ⇒ 全绿」，这是门禁最常见的假绿形态，故直接红。');
    return done();
  }

  const entries = readdirSync(scheduleDir, { withFileTypes: true });
  const serviceNames = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.service'))
    .map((entry) => entry.name).sort();
  const timerNames = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.timer'))
    .map((entry) => entry.name).sort();
  counts.services = serviceNames.length;
  counts.timers = timerNames.length;
  counts.units = serviceNames.length + timerNames.length;

  if (serviceNames.length === 0 || timerNames.length === 0) {
    fail('surface', scheduleDirRel, `扫描面不成对：.service ${serviceNames.length} 个 / .timer ${timerNames.length} 个\n`
      + '  ⇒ 两条都至少要有一个：只有 service 没有 timer ⇒ 命令永远不会被叫醒（「调度层是空的」原形）；'
      + '只有 timer 没有 service ⇒ systemd 起不来。扫到 0 个按红处理，不放行。');
  }

  // ---------------------------------------------------------------- package.json
  let scripts = {};
  const packageText = readText(join(root, 'package.json'));
  if (packageText === null) {
    fail('surface', 'package.json', '读不到 package.json：无法核对「单元 ↔ npm script」同源。');
  } else {
    try {
      const parsed = JSON.parse(packageText);
      scripts = (parsed && typeof parsed.scripts === 'object' && parsed.scripts !== null) ? parsed.scripts : {};
    } catch (error) {
      fail('surface', 'package.json', `package.json 不是合法 JSON（${error.message}）：无法核对「单元 ↔ npm script」同源。`);
    }
  }
  const scriptNames = Object.keys(scripts);
  counts.npmScripts = scriptNames.length;

  const coveredScripts = new Set();
  /** @type {Map<string, {entry: string|null, npmScript: string|null}>} */
  const serviceEntries = new Map();

  // ------------------------------------------- [npm-script]/[execstart]/[cursor]/[secrets]/[hygiene]
  for (const name of serviceNames) {
    const file = join(scheduleDir, name);
    const fileRel = display(file);
    const text = readText(file) ?? '';
    const { directives } = parseUnit(text);
    /** @type {{file: string, kind: string, npmScript: string|null, entry: string|null}} */
    const record = { file: fileRel, kind: 'service', npmScript: null, entry: null };
    units.push(record);

    // ---- [npm-script] 指令 + script 存在性
    const directive = NPM_SCRIPT_DIRECTIVE.exec(text);
    if (directive === null) {
      fail('npm-script', fileRel, '缺少注释指令 `# GY-SCHEDULE: npm-script=<name>`：\n'
        + '  ⇒ 没有它就无法证明「本单元跑的就是 package.json 里那条 script」（判据 [execstart] 也无从比对）。');
    } else {
      const npmScript = directive[1];
      record.npmScript = npmScript;
      if (!Object.prototype.hasOwnProperty.call(scripts, npmScript)) {
        fail('npm-script', fileRel, `指令引用的 npm script \`${npmScript}\` 不在 package.json 的 scripts 里`
          + `（现有 ${scriptNames.length} 条；改名/删除 script 必须同步改单元）。`);
      } else {
        coveredScripts.add(npmScript);
      }
    }

    // ---- [execstart] 绝对路径 + 真实存在 + 与 npm script 同一入口
    const execStart = firstDirective(directives, 'ExecStart');
    if (execStart === null) {
      fail('execstart', fileRel, '缺少 `ExecStart=`：单元不会执行任何东西。');
    } else {
      const entry = execStartEntry(execStart.value);
      if (entry === null) {
        fail('execstart', fileRel, `\`ExecStart=\` 里找不到入口文件（形如 *.mjs / *.js 的 token）：${execStart.value}`);
      } else {
        record.entry = entry;
        if (!isAbsolute(entry)) {
          fail('execstart', fileRel, `\`ExecStart=\` 的入口不是绝对路径：${entry}\n`
            + '  ⇒ systemd 要求可执行路径为绝对路径（相对路径直接拒载）；部署根换掉时必须一起改。');
        }
        const resolvedEntry = repoRelativeEntry(root, entry);
        if (resolvedEntry === null) {
          fail('execstart', fileRel, `\`ExecStart=\` 的入口在**本树上不存在**：${entry}\n`
            + '  ⇒ 无法映射到仓库内的任何真实文件（期望它以某个真实入口结尾，'
            + '例如 `/opt/gengyun/app/tools/purge-expired-online-data.mjs` ⇒ `tools/purge-expired-online-data.mjs`）。');
        } else {
          const npmScript = record.npmScript;
          if (npmScript !== null && Object.prototype.hasOwnProperty.call(scripts, npmScript)) {
            const expected = npmScriptEntry(scripts[npmScript]);
            if (expected === null) {
              fail('execstart', fileRel, `package.json 的 \`${npmScript}\` 里解析不到入口文件：${scripts[npmScript]}`);
            } else if (resolvedEntry !== expected) {
              fail('execstart', fileRel, `\`ExecStart=\` 的入口与 package.json 的 \`${npmScript}\` **不是同一个文件**：\n`
                + `  · 单元：${resolvedEntry}\n  · script：${expected}\n`
                + '  ⇒ 运维手动补跑与调度跑的是两条命令时，任何口径改动都会只改一边。');
            }
          }
        }
        serviceEntries.set(name, { entry: resolvedEntry, npmScript: record.npmScript });

        // ---- [cursor] 在线清理必须给绝对路径游标
        if (resolvedEntry === CURSOR_REQUIRED_ENTRY) {
          const { files, noCursor } = cursorArgs(execStart.value);
          if (noCursor) {
            fail('cursor', fileRel, '在线清理单元出现 `--no-cursor`：\n'
              + '  ⇒ 那等于每轮只跑一页、且永不落进度（`--no-cursor` 把 --max-batches 按 1 执行）。'
              + '到期集合超过一页时，队尾请求会被队首永远挡住（饿死）。');
          }
          if (files.length === 0) {
            fail('cursor', fileRel, '在线清理单元缺少 `--cursor-file=`：\n'
              + '  ⇒ 缺省游标（`DEFAULT_ONLINE_PURGE_CURSOR_FILE`）是**相对当前工作目录**的；'
              + '在 systemd/cron 下 cwd 由调度器决定 ⇒ 每轮从队首重扫、进度丢失。');
          }
          for (const cursorPath of files) {
            if (!isAbsolute(cursorPath)) {
              fail('cursor', fileRel, `\`--cursor-file\` 不是绝对路径：${cursorPath}\n`
                + '  ⇒ 相对路径随 cwd 漂移，进度会静默丢失（游标文件本身不会报错，只是一直对不上）。');
              continue;
            }
            const stateDirectory = firstDirective(directives, 'StateDirectory');
            if (stateDirectory !== null) {
              const first = (stateDirectory.value.split(/\s+/)[0] ?? '').replace(/^\//, '');
              const expectedPrefix = `/var/lib/${first}/`;
              // 先归一化（折叠 `.` / `..`）再比前缀：`/var/lib/<state>/../../etc/passwd` 归一化后
              // 是 `/var/etc/passwd`，只做字符串前缀比对的实现会把它当 PASS —— 那是门禁假绿。
              const normalizedCursor = posix.normalize(cursorPath);
              if (first !== '' && !normalizedCursor.startsWith(expectedPrefix)) {
                fail('cursor', fileRel, '`--cursor-file` 归一化后不在 `StateDirectory=` 建出来的目录里：\n'
                  + `  · 游标：${cursorPath}\n  · 归一化：${normalizedCursor}\n  · 期望前缀：${expectedPrefix}\n`
                  + '  ⇒ 前缀比对必须在 POSIX 归一化（折叠 `.`/`..`）之后做；只比字符串会让'
                  + ' `/var/lib/<state>/../../etc/passwd` 这类写法逃出状态目录并判 PASS（运行时 EACCES）。'
                  + 'systemd 只会创建并 chown StateDirectory 那一个目录，写别的路径每轮都是退出码 2。');
              }
            }
          }
        }
      }
    }

    // ---- [secrets] 环境文件 + 内联凭据
    if (firstDirective(directives, 'EnvironmentFile') === null) {
      fail('secrets', fileRel, '缺少 `EnvironmentFile=`：\n'
        + '  ⇒ 凭据只允许经该文件进入（root:root 0600，systemd 以 root 读入后降权执行）。'
        + '⛔ 不接受内联连接串或口令。');
    }
    text.split(/\r?\n/).forEach((line, index) => {
      for (const { pattern, label } of INLINE_SECRET_PATTERNS) {
        if (pattern.test(line)) {
          fail('secrets', fileRel, `第 ${index + 1} 行含${label}：${line.trim()}\n`
            + '  ⇒ 单元里不得出现连接串/口令（注释里的也一样：`systemctl cat`、`git log`、工单都会把它带出去）。');
        }
      }
    });

    // ---- [hygiene] User / StateDirectory / TimeoutStartSec
    const user = firstDirective(directives, 'User');
    if (user === null || user.value === '') {
      fail('hygiene', fileRel, '缺少 `User=`：单元会以 root 运行（DB 侧最小权限不替代 OS 侧最小权限）。');
    } else if ((user.value.split(/\s+/)[0] ?? '') === 'root') {
      fail('hygiene', fileRel, '`User=root`：⛔ 不允许以 root 运行到期清除命令。');
    }
    const stateDirectory = firstDirective(directives, 'StateDirectory');
    if (stateDirectory === null || stateDirectory.value === '') {
      fail('hygiene', fileRel, '缺少 `StateDirectory=`：状态目录必须由 systemd 创建并 chown 给 `User=`'
        + '（否则非 root 写不进去）。');
    }
    const timeout = firstDirective(directives, 'TimeoutStartSec');
    if (timeout === null || timeout.value === '') {
      fail('hygiene', fileRel, '缺少 `TimeoutStartSec=`：\n'
        + '  ⇒ 它是防重叠的第二道：oneshot 单实例语义保证「上一轮没跑完不起第二轮」，'
        + '超时上界保证「卡住的连接不会永远占着实例」。');
    } else {
      const seconds = parseSystemdDurationSeconds(timeout.value);
      if (seconds === null || seconds <= 0) {
        fail('hygiene', fileRel, `\`TimeoutStartSec=\` 不是正的 systemd 时长：${timeout.value}`);
      }
    }
  }

  // ---------------------------------------------------------------- [pair] / [calendar]
  const serviceNameSet = new Set(serviceNames);
  for (const name of serviceNames) {
    const expectedTimer = `${name.replace(/\.service$/, '')}.timer`;
    if (!timerNames.includes(expectedTimer)) {
      fail('pair', display(join(scheduleDir, name)), `缺少配对的 \`${expectedTimer}\`：\n`
        + '  ⇒ 命令永远不会被叫醒（这正是「驱动者存在、调度层为空」的原形）。');
    }
  }

  for (const name of timerNames) {
    const file = join(scheduleDir, name);
    const fileRel = display(file);
    const text = readText(file) ?? '';
    const { directives } = parseUnit(text);
    units.push({ file: fileRel, kind: 'timer' });

    // ---- [secrets]：timer 同样不许内联凭据
    text.split(/\r?\n/).forEach((line, index) => {
      for (const { pattern, label } of INLINE_SECRET_PATTERNS) {
        if (pattern.test(line)) {
          fail('secrets', fileRel, `第 ${index + 1} 行含${label}：${line.trim()}\n`
            + '  ⇒ timer 里同样不得出现连接串/口令（凭据只属于 service 的 EnvironmentFile=）。');
        }
      }
    });

    const unitDirective = firstDirective(directives, 'Unit');
    const target = unitDirective === null
      ? `${name.replace(/\.timer$/, '')}.service`
      : unitDirective.value.split(/\s+/)[0];
    if (!serviceNameSet.has(target)) {
      fail('pair', fileRel, `\`Unit=\` 指向的 service 不存在：${target}\n`
        + `  ⇒ 本目录只有 ${serviceNames.join('、') || '(无)'}。悬空的 Unit= 会让 timer 静默不做事。`);
    }

    // ---- [calendar] 必须有周期 + 展开后的最大间隔 ≤ 60 分钟
    const onCalendar = firstDirective(directives, 'OnCalendar');
    const onUnitActive = firstDirective(directives, 'OnUnitActiveSec');
    if (onCalendar === null && onUnitActive === null) {
      fail('calendar', fileRel, '缺少 `OnCalendar=` 或 `OnUnitActiveSec=`：timer 没有周期 ⇒ 永不触发。');
      continue;
    }
    if (onCalendar !== null) {
      const offsets = calendarFireSeconds(onCalendar.value);
      if (offsets === null) {
        fail('calendar', fileRel, `\`OnCalendar=\` 的形态无法展开：${onCalendar.value}\n`
          + '  ⇒ 只支持 `*-*-* <HH>:<MM>[:<SS>]`（各字段可用 * / N / N/M / *‍/M / N..M / 逗号列表）。'
          + '`hourly`/`daily`/星期限定这类形态请改写成显式形态 —— 看不懂就判红，⛔ 不猜间隔。');
      } else {
        const gap = maxGapSeconds(offsets);
        const minutes = gap === null ? null : gap / 60;
        if (minutes === null || minutes > MAX_INTERVAL_MINUTES) {
          fail('calendar', fileRel, `\`OnCalendar=\` 的最大间隔 ${minutes} 分钟 > ${MAX_INTERVAL_MINUTES} 分钟：${onCalendar.value}\n`
            + '  ⇒ 到期清除的时钟不能比这更稀（每天一次 = 「7 日到期」实际最多晚一天清）。');
        } else {
          readings.push(`[calendar] ${fileRel}：OnCalendar=${onCalendar.value} ⇒ 每天 ${offsets.length} 次触发，最大间隔 ${minutes} 分钟`);
        }
      }
    }
    if (onUnitActive !== null) {
      const seconds = parseSystemdDurationSeconds(onUnitActive.value);
      const minutes = seconds === null ? null : seconds / 60;
      if (minutes === null || minutes > MAX_INTERVAL_MINUTES) {
        fail('calendar', fileRel, `\`OnUnitActiveSec=\` 解析为 ${minutes} 分钟，必须 ≤ ${MAX_INTERVAL_MINUTES}：${onUnitActive.value}`);
      } else {
        readings.push(`[calendar] ${fileRel}：OnUnitActiveSec=${onUnitActive.value} ⇒ 最大间隔 ${minutes} 分钟`);
      }
    }
  }

  // ---------------------------------------------------------------- [coverage]
  if (serviceNames.length > 0) {
    for (const npmScript of REQUIRED_NPM_SCRIPTS) {
      if (!Object.prototype.hasOwnProperty.call(scripts, npmScript)) {
        fail('npm-script', 'package.json', `必需的 npm script \`${npmScript}\` 不在 scripts 里：`
          + '命令本身没了，调度层无从谈起（先修 package.json，再改本清单）。');
        continue;
      }
      if (!coveredScripts.has(npmScript)) {
        fail('coverage', scheduleDirRel, `npm script \`${npmScript}\` 没有被任何 \`.service\` 覆盖：\n`
          + '  ⇒ 只判形态不判覆盖时，「删掉一整条单元」也能变绿 —— 那正好把时钟拆回「文档里的一行示例」。');
      }
    }
    counts.coveredNpmScripts = REQUIRED_NPM_SCRIPTS.filter((name) => coveredScripts.has(name)).length;
  }

  // ---------------------------------------------------------------- [setinterval]
  const setIntervalScan = findSetIntervalCalls(root);
  counts.setIntervalFiles = setIntervalScan.files;
  counts.setIntervalHits = setIntervalScan.hits.length;
  if (setIntervalScan.files === 0) {
    fail('setinterval', SETINTERVAL_SCAN_DIR, '扫描面里一个代码文件都没扫到：\n'
      + '  ⇒ 「setInterval( 计数为 0」在空扫描面下恒真，这是假绿，按红处理（口径失效先修扫描器）。');
  }
  for (const hit of setIntervalScan.hits) {
    fail('setinterval', hit.file, `第 ${hit.line} 行出现 \`setInterval(\` 调用（形态：${hit.form}）：${hit.text}\n`
      + '  ⇒ 本仓**故意**没有进程内定时器：多副本会重复执行、重启丢语义、并与 CI/真库臂抢同一批行。'
      + '到期是日历事实，应由外部调度（deploy/purge-schedule/）反复调用运维命令。');
  }
  readings.push(`[setinterval] 扫 ${setIntervalScan.files} 个文件，\`setInterval(\` 命中 ${setIntervalScan.hits.length} 处`
    + '（口径：标识符调用，含 `globalThis.setInterval(`／`setInterval (`／`[\'setInterval\'](`，含注释）');

  readings.push(`[surface]  ${scheduleDirRel}：.service ${counts.services} 个 / .timer ${counts.timers} 个`);
  readings.push(`[npm-script] package.json scripts ${counts.npmScripts} 条；必需覆盖 ${counts.coveredNpmScripts}/${REQUIRED_NPM_SCRIPTS.length}`
    + `（${REQUIRED_NPM_SCRIPTS.join('、')}）`);
  for (const [name, info] of [...serviceEntries].sort((left, right) => left[0].localeCompare(right[0]))) {
    readings.push(`[execstart] ${name}：npm=${info.npmScript ?? '(未声明)'} ⇒ 入口 ${info.entry ?? '(未解析)'}`);
  }

  return done();
}

/** 把一次校验渲染成可贴进日志/证据页的文本。 */
export function renderReport(result) {
  const lines = [
    `到期清除调度层门禁（GY-R32 · #19 · 纯静态）· 目录 ${result.scheduleDir}`,
    ...result.readings,
  ];
  for (const failure of result.failures) {
    lines.push(`FAIL[${failure.id}] ${failure.file}：${failure.message}`);
  }
  if (result.ok) {
    lines.push(`PASS：${CRITERIA.length} 项判据全部满足（${CRITERIA.join(' / ')}）；`
      + `.service ${result.counts.services} 个 / .timer ${result.counts.timers} 个逐条有交代。`);
    return lines.join('\n');
  }
  const ids = [...new Set(result.failures.map((failure) => failure.id))];
  lines.push(`FAIL：${result.failures.length} 项不满足（${ids.join('、')}）；退出码 1。`);
  return lines.join('\n');
}

/** 机读报告（`--json`）。`failures[]` / `counts{}` / `units[]` 是稳定契约。 */
export function buildJsonReport(result) {
  return {
    tool: 'verify-purge-schedule',
    schemaVersion: 1,
    ok: result.ok,
    exitCode: result.ok ? 0 : 1,
    scheduleDir: result.scheduleDir,
    criteria: CRITERIA,
    maxIntervalMinutes: MAX_INTERVAL_MINUTES,
    requiredNpmScripts: REQUIRED_NPM_SCRIPTS,
    cursorRequiredEntry: CURSOR_REQUIRED_ENTRY,
    setIntervalScanDir: SETINTERVAL_SCAN_DIR,
    counts: result.counts,
    failures: result.failures,
    units: result.units,
    readings: result.readings,
  };
}

/** 命令行入口：返回退出码，方便单测直接调用。 */
export function main(argv = process.argv) {
  const args = argv.slice(2);
  let root = DEFAULT_ROOT;
  let scheduleDir = DEFAULT_SCHEDULE_DIR;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      return 0;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--root') {
      const value = args[index + 1];
      if (typeof value !== 'string' || value === '' || value.startsWith('--')) {
        console.error(`--root 需要一个目录参数\n\n${USAGE}`);
        return 2;
      }
      root = resolve(value);
      index += 1;
      continue;
    }
    if (arg === '--dir') {
      const value = args[index + 1];
      if (typeof value !== 'string' || value === '' || value.startsWith('--')) {
        console.error(`--dir 需要一个相对路径参数\n\n${USAGE}`);
        return 2;
      }
      scheduleDir = value;
      index += 1;
      continue;
    }
    console.error(`未知参数：${arg}\n\n${USAGE}`);
    return 2;
  }

  const result = verifyPurgeSchedule({ root, scheduleDir });
  // `--json` 时 stdout 必须是**纯 JSON**（不混读数），下游才敢直接 `JSON.parse`。
  console.log(json ? JSON.stringify(buildJsonReport(result), null, 2) : renderReport(result));
  return result.ok ? 0 : 1;
}

/** 是否被直接执行（`node tools/...mjs`）——被 import 时不得有任何副作用。 */
function isDirectExecution() {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry === '') return false;
  const invoked = resolve(entry);
  const self = resolve(fileURLToPath(import.meta.url));
  return process.platform === 'win32'
    ? invoked.toLowerCase() === self.toLowerCase()
    : invoked === self;
}

if (isDirectExecution()) {
  process.exitCode = main();
}
