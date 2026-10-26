/**
 * S4-S3 P2-b 真库臂：迁移 0044 第三方删除持久化 —— **库层函数**的运行时语义。
 *
 * 这条臂只碰库：自己 `initdb` 出一次性 PG 17 集群 → 跑全链迁移 → 建一个**只有 EXECUTE** 的运行时角色
 * → 以该角色**直调 SQL 函数**（不经端口、不经 HTTP、不 import 本仓 `services/**` 的任何模块）。
 * 为什么是「自起集群」而不是接既有 env：本臂要断言「表对运行时身份仍是 forbidden」，而共享 CI 集群里
 * 角色与授权是**跨库残留**的（`real-pg-integration.yml:210-218` 记的正是这件事）；自起集群能保证
 * 空库 → 全链迁移 → 干净角色 → 跑完 `pg_ctl stop` 并删数据目录 ⇒ 零残留。
 *
 * ## 8 条断言 ↔ `services/api/db/migrations/0044_third_party_deletion_persistence.sql` 行号
 *
 * | # | 读数 | 库层依据（0044 行号） |
 * |---|------|------------------------|
 * | [A] | ① 首次写 `requested` 落行；`requested_at` == 传入 `p_at`（UTC 同形）；读回八列的顺序与值 | 写函数签名 `:97-105`、参数自检 `:119-128`、两列同写 `:179`、时刻序列化 `:254-255`；读面八列声明 `:271-280`、时刻 `:297-298` |
 * | [B] | ② 同 `(request_id, recipient_id, NULL)` 重复写 `requested` ⇒ **幂等且不刷新** `requested_at` | `:190` `requested_at = COALESCE(d.requested_at, EXCLUDED.requested_at)`（uuid 支 `:214` 同形） |
 * | [C] | ③ `p_state='not_requested'`（函数写白名单闭集外）⇒ `G0001`，且**不落行** | 白名单 `:112`（`requested/confirmed/failed/unsupported`，⛔ 不含 `not_requested`）+ `:119-128` |
 * | [D] | ④ `p_state='failed'` 缺 `p_error_code` ⇒ `G0001`（**报错，不落行**）；带 `error_code` 才落行；超 80 字符 ⇒ `G0001` | `:150-153`（`IF p_error_code IS NULL OR btrim(p_error_code) = ''` ⇒ `RAISE … 'G0001'`）、长度上界 `:130-132` |
 * | [E] | ⑤ `confirmed` → 再写 `requested`（终态回退）⇒ `G0003`；同参数重放仍幂等；被拒后整行一字未改 | 单调守卫 `:194-195`／`:218-219`、回读比对 `:224-246`（`G0003` 在 `:244`，幂等重放在 `:241-242`） |
 * | [F] | ⑥ 读面按 **`request_id`** 隔离：同 `recipient_id` 在两个 request 下互不可见；同一 request 下两个 recipient **都**可见（库层真实语义） | 签名 `:270`、`WHERE d.request_id = p_request_id` `:302`、`ORDER BY d.recipient_id, d.export_ref` `:303`、`p_request_id IS NULL` ⇒ `G0001` `:288-290` |
 * | [G] | ⑦ 运行时身份**直写/直读表**恰 `42501`；表级四权限全 false，两函数 EXECUTE 全 true | `:309-310`（`REVOKE ALL ON FUNCTION … FROM PUBLIC`；表上零授权，授 EXECUTE 只在 `deploy/postgres-cvm/sql/20-login-roles.sql` 的 D5 区） |
 * | [H] | ⑧ `p_export_ref` 为 `NULL` 与为 uuid **两种都落行**，同一 `(request, recipient)` 下并存 2 行；未知 uuid ⇒ `G0002` | NULL 支 `:172-196`（冲突键 `WHERE export_ref IS NULL`）、uuid 支 `:198-221`（三元组）、`exports` 自检 `:165-169` ⇒ `G0002` |
 *
 * ## ⚠ 与「任务书背景」不符、**以实测为准**处（⛔ 未改迁移，只钉住现状）
 * 1. 任务书说读函数签名是 `list_third_party_deletions(p_recipient_id uuid)`；**实际是
 *    `list_third_party_deletions(p_request_id uuid)`（0044:270）**，过滤条件 `d.request_id = p_request_id`
 *    （`:302`）。⇒「按 recipient_id 隔离、两个接收方互不可见」**照不出来**：真实语义是按 `request_id`
 *    隔离，同一 request 下的两个 recipient 会**一起返回**。[F] 把真实语义两头都钉住
 *    （跨 request 不可见 + 同 request 多 recipient 全可见），而不是去钉一条不存在的语义。
 * 2. 任务书说 `failed` 缺 `error_code` 时「报错或落行，二选一以实测为准」；**实测是报错**
 *    `G0001 INVALID_REQUEST`（`:150-153`），不落行。[D] 钉的就是这条。
 * 3. 任务书说表有 `state` 列；**实际列名是 `online_status` / `backup_status`**（`0003_privacy_consent.sql:185-215`），
 *    且库层没有「只改一侧」的入口 —— 一次调用把**两列写成同一个 `p_state`**（`:179`／`:204`）。
 *    所以本臂的读数一律「两列同值」。
 * 4. 任务书说 `not_requested` 是「闭集外」；它确实是 `third_party_state` 枚举成员（`0003:42-44`）且是
 *    两列的 DEFAULT，但**不在函数的写白名单**里（`:112`）⇒ 写它必 `G0001`。这与 [C] 的期望一致，
 *    只是「闭集」指的是「函数可写的闭集」，不是「列类型的闭集」。
 *
 * ## 0046 追加的四组读数（`[I]`–`[L]`，`#18` S2 收尾片的库层一半）
 *
 * | # | 读数 | 库层依据（0046 行号见迁移文件） |
 * |---|------|------------------------------|
 * | [I] | ⑨ 运行时身份**能**执行 `record_admin_scope_denial`，且恰好落一行：`action='admin_scope.deny'` / `result='denied'` / `scope` 原样 / `target_ref IS NULL` / `target_hint='admin_account:<target>'` / `reason_code` 原样 / `request_id` 原样；`p_audit_id` 给值就用调用方的 id、给 NULL 就由函数生成 | 写死的列与 `RETURNING` 的 id |
 * | [J] | ⑩ 运行时身份**不能**直写 `admin_audit_events`：表级 S/I/U/D 全 `false`、函数 `EXECUTE` `true`；直接 `INSERT`/`SELECT`/`UPDATE`/`DELETE` 全部恰好 `42501`，被拒的直写**零落行**，且已落的那行 `result` 仍是 `denied`（证明它只能走函数，绕不过函数里写死的列） | 表上零授权（授 `EXECUTE` 只在 `20-login-roles.sql` 的 `gy-r64-pr4a-denial-trace-grant`） |
 * | [K] | ⑪ 闭集外 `reason_code`（`scope_granted` / `job_cancelled` / 大写变体）与闭集外 `scope`（`user` / `public` / `receipt`）⇒ 一律 `G0001`，且**不落行**（行数不变） | 四值理由闭集 + 13 项 scope 闭集 + `RAISE … 'G0001'` |
 * | [L] | ⑫ **只核 actor 存在**：`state='suspended'` 且**零** `scopes:write`（`admin_scopes` 全表 0 个有效持有者）的 actor **照样**留痕；actor 不存在 ⇒ `G0002`（⛔ 不核 active、⛔ 不核持有面 —— 被拒的正是这件事） | 0017/0041/0043 同形的 `G0002`，且函数体内无 `admin_scopes`/`state` |
 *
 * ## 为什么这四组读数**落在这个文件**（而不是新开一个 `admin-scope-denial-*-pg.mjs`）
 * `.github/workflows/real-pg-integration.yml` 是**逐文件列举**跑 `tests/integration/*.mjs` 的
 * （每个 step 一行 `psql -c 'CREATE DATABASE …' && node tests/integration/<脚本>.mjs`）⇒
 * **新建**的集成脚本不会被任何 job 跑到，等于「写了断言、CI 上从未执行」。
 * 而本文件恰好是仓内**形状最贴近**的那一条：它**自起一次性 PG 17 集群**（56000–56499 先探活再起）、
 * 跑**全链迁移**（因此 0046 自动被应用）、建一个**只有 EXECUTE** 的运行时身份、并已经用
 * 「表对运行时 forbidden + 函数对运行时放行」这一对判据钉住 `0044` 的两条窄函数 ——
 * 0046 要证明的正是同一对判据在**审计面**上的版本（`admin_audit_events` 零表级权限 + 一条写函数）。
 * 它不依赖 service 集群、不建组角色、跑完 `pg_ctl stop` 并删数据目录 ⇒ 追加在这里对前后 step 零耦合，
 * 也不需要动 workflow（新增 step 会改 CI 门禁面，属另一类改动）。
 *
 * ## 用法
 *   $env:GY_PG_BIN     = 'E:\GengYunCommander\.pg17\pgsql\bin'   # 必填：含 initdb/pg_ctl 的**服务端** bin 目录
 *   $env:GY_S4_PG_ROOT = 'E:\GengYunCommander\.pg17\tmp'         # 选填：数据目录根（默认 os.tmpdir()）
 *   node tests/integration/third-party-deletion-sql-pg.mjs
 *
 * 退出码：`0` = 12 条读数（0044 的 ①–⑧ ＋ 0046 的 ⑨–⑫）全取得且末行 `[ALL PASS]`；`1` = 断言失败或缺依赖；`77` = ⛔ 缺 `GY_PG_BIN`
 * 未取得（POSIX skipped 惯例：**未取得 ≠ 通过**）。本脚本**刻意不提供** `--allow-skip` / `GY_ALLOW_SKIP`：
 * 取不到真库就没有读数，任何把 77 读成绿的开关都会把缺口重新藏起来。
 *
 * 端口：56000–56499 里**先探活再起**（同机上别人留下的临时集群必须先避开）。数据目录
 * `<root>/gy-s4-p2b-pg-<hex>`：收尾 `pg_ctl stop` + 删目录。运行时身份是一次性集群内的角色，随目录一起
 * 消失，无需 DROP。
 *
 * `pg` 驱动**在闸门之后**动态 import：静态 `import 'pg'` 会被提升到闸门之上，在没有 node_modules 的树上
 * 直接 `ERR_MODULE_NOT_FOUND`（exit 1）—— 那会把「缺驱动」伪装成「臂失败」，也让 77 语义失效。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

// ---------------------------------------------------------------------------
// 闸门：缺 `GY_PG_BIN` ⇒ SKIP + 77（⛔ 不是通过）
// ---------------------------------------------------------------------------
const binDir = process.env.GY_PG_BIN ?? '';
if (binDir === '') {
  console.log(
    'SKIP: 未设置 GY_PG_BIN（postgres 二进制目录，含 initdb/pg_ctl）⇒ 真库臂跳过，'
      + '没有取得「0044 两条库层函数的运行时语义」的真库读数（未取得，不是通过）。',
  );
  console.log('EXITCODE=77 表示未取得，不是通过（POSIX 惯例 skipped；本脚本刻意不提供 --allow-skip）。');
  process.exit(77);
}

let pg;
try {
  ({ default: pg } = await import('pg'));
} catch (error) {
  console.log(`FAIL: GY_PG_BIN 已设置（${binDir}）但本树解析不到 pg 依赖：${error.code ?? error.message}`);
  console.log('EXITCODE=1（环境缺依赖，不是 skipped）');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 常量与一次性目录
// ---------------------------------------------------------------------------
const DB_NAME = 'gengyun_third_party_deletion_sql_test';
/** 运行时身份：只有两条函数的 EXECUTE，表上零权限（镜像 `20-login-roles.sql` D5 区的授予面）。 */
const RUNTIME_ROLE = 'gy_s4_p2b_runtime';
const RECORD_SIGNATURE = 'public.record_third_party_deletion(uuid,text,uuid,text,text,text,timestamptz)';
const LIST_SIGNATURE = 'public.list_third_party_deletions(uuid)';
/** 迁移 0046 的留痕写函数（读数 [I]–[L]）；同样只授运行时 EXECUTE，审计表本身仍零表级权限。 */
const DENIAL_SIGNATURE = 'public.record_admin_scope_denial(uuid,uuid,text,text,uuid,uuid)';
/** 后台权限闭集 + 拒绝理由闭集（读数 [K] 用它构造闭集外取值；取值必须与 0041/0046 反着来）。 */
const DENIAL_BAD_REASONS = ['scope_granted', 'job_cancelled', 'LAST_SCOPE_MANAGER'];
const DENIAL_BAD_SCOPES = ['user', 'public', 'receipt'];
/** 读面八列：顺序即 `RETURNS TABLE` 声明序（0044:271-280），也必须是脚本读回的列序。 */
const EIGHT_COLUMNS = Object.freeze([
  'recipient_id',
  'export_ref',
  'online_state',
  'backup_state',
  'requested_at',
  'confirmed_at',
  'evidence_ref',
  'error_code',
]);

const dataRoot = process.env.GY_S4_PG_ROOT ?? tmpdir();
const runTag = `gy-s4-p2b-pg-${randomBytes(4).toString('hex')}`;
const dataDir = join(dataRoot, runTag);
// ⚠ 日志**不能**放进 dataDir：runTool 用 `openSync(serverLog, 'a')` 先把文件建出来，而 initdb 拒绝在
// 非空目录里初始化（`directory "…" exists but is not empty`），失败时日志反而还是空的。放在 dataDir 之外。
const serverLog = join(dataRoot, `${runTag}.log`);
// ⚠ `pg_ctl -l` 指向的**必须**是另一个文件：若和上面那个 fd 同一个文件，Windows 下 postgres 继承句柄再打开
// 会撞 `The process cannot access the file because it is being used by another process.`（库永远起不来）。
const postgresLog = join(dataDir, 'server.log');
const migrationsDir = new URL('../../services/api/db/migrations/', import.meta.url);

/** 读数行：`[A]`…`[H]`（workflow 侧按 `awk '/^\[[A-Z]\]/'` 统计，`[ALL PASS]` 不会被计入）。 */
let readings = 0;
const mark = (id, text) => {
  assert.match(id, /^[A-Z]$/, `读数行 id 必须是单个大写字母（workflow 统计口径），收到 ${id}`);
  readings += 1;
  console.log(`[${id}] ${text}`);
  return readings;
};

/** 读数行下面补一行「依据 …」：让读数与迁移行号对上，失败时不用再翻文件。 */
const because = (line) => console.log(`  - ${line}`);

// ---------------------------------------------------------------------------
// 临时集群：initdb / pg_ctl / psql 全走 GY_PG_BIN
// ---------------------------------------------------------------------------
const tool = (name) => join(binDir, process.platform === 'win32' ? `${name}.exe` : name);
let port = 0;
let clusterStarted = false;

/** 同步睡一下（清理重试用）：⛔ 不用 spawn 一个子进程，那会把「删目录」变成进程风暴。 */
const sleepSync = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** 端口先探活：同机可能已有别人的临时集群，撞端口会让 initdb 之后的一切假红。 */
const portIsFree = (candidate) =>
  new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen({ port: candidate, host: '127.0.0.1', exclusive: true });
  });

async function pickPort() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const candidate = 56000 + randomInt(0, 500);
    // eslint-disable-next-line no-await-in-loop
    if (await portIsFree(candidate)) return candidate;
  }
  throw new Error('56000–56499 里找不到空闲端口（同机临时集群过多），本臂不猜端口');
}

/**
 * postgres 的 stdout/stderr 直接写文件（`stdio: ['ignore', fd, fd]`）：**不能**用管道收集 ——
 * 沙箱/Windows 下管道要求 EOF，而 postgres 是常驻进程，`spawnSync` 会一直等下去。
 */
function runTool(name, args, { allowFailure = false } = {}) {
  const fd = openSync(serverLog, 'a');
  let result;
  try {
    result = spawnSync(tool(name), args, {
      stdio: ['ignore', fd, fd],
      env: { ...process.env, PGCONNECT_TIMEOUT: '5' },
      timeout: 180_000,
      windowsHide: true,
    });
  } finally {
    closeSync(fd);
  }
  if (!allowFailure && (result.status !== 0 || result.error !== undefined)) {
    throw new Error(
      `${name} ${args.join(' ')} 失败（status=${result.status}，error=${result.error?.message ?? 'none'}）：`
        + `日志见 ${serverLog}`,
    );
  }
  return result;
}

/** `-o` 的取值必须用**空格**拼成**一个**参数：逗号会让 postgres 收到 `-p 56001,-c …` 这类坏值。 */
function serverOptions() {
  const options = [`-p ${port}`, '-c listen_addresses=127.0.0.1', '-c max_connections=32'];
  // 非 win32 才加 unix socket 目录：Windows 上没有 `-k`，传了直接 FATAL。
  if (process.platform !== 'win32') options.push(`-k ${dataDir}`);
  return options;
}

function startCluster() {
  assert.ok(existsSync(tool('initdb')), `GY_PG_BIN 指向的目录里没有 initdb：${binDir}`);
  mkdirSync(dataRoot, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  runTool('initdb', ['-D', dataDir, '--no-sync', '--encoding=UTF8', '--locale=C', '-U', 'postgres', '-A', 'trust']);
  // `-W`（不等待）+ 后面用 `connectWithRetry` 轮询就绪：`pg_ctl -w start` 在本机会挂住，⛔ 不要用。
  runTool('pg_ctl', ['-D', dataDir, '-l', postgresLog, '-o', serverOptions().join(' '), '-t', '60', '-W', 'start']);
  clusterStarted = true;
}

function stopCluster() {
  if (clusterStarted) {
    runTool('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop'], { allowFailure: true });
    clusterStarted = false;
  }
  // 目录名自证：⛔ 绝不 rm 一个不是本脚本造的目录。
  assert.ok(basename(dataDir).startsWith('gy-s4-p2b-pg-'), `拒删非本脚本的数据目录：${dataDir}`);
  assert.ok(basename(serverLog).startsWith('gy-s4-p2b-pg-'), `拒删非本脚本的日志：${serverLog}`);
  for (const target of [dataDir, serverLog]) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        rmSync(target, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        sleepSync(250);
      }
    }
  }
}

/**
 * 只对「服务还没起来」这类**瞬时**失败重试；库名/角色名写错这类永久错误立刻抛，⛔ 不要用 60 次重试把它
 * 淹没成一句「连不上」。
 */
const TRANSIENT_CONNECT_ERRORS = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  '57P03', // cannot_connect_now：启动中/正在恢复
]);

async function connectWithRetry(connectionString, attempts = 60) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const client = new pg.Client({ connectionString, connectionTimeoutMillis: 2_000 });
    try {
      // eslint-disable-next-line no-await-in-loop
      await client.connect();
      return client;
    } catch (error) {
      lastError = error;
      // eslint-disable-next-line no-await-in-loop
      await client.end().catch(() => {});
      if (!TRANSIENT_CONNECT_ERRORS.has(error.code)) {
        throw new Error(
          `连库失败（${error.code ?? '无 code'}，不可重试）：${error.message}（连接串 ${maskedUrl(connectionString)}）`,
        );
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(250);
    }
  }
  throw new Error(
    `连不上临时集群（${attempts} 次重试后）：${lastError?.message ?? 'unknown'}（日志 ${serverLog}）`,
  );
}

/** 连接串打日志前先抹掉口令：⛔ 口令只在内存里，不落任何输出。 */
const maskedUrl = (url) => url.replace(/:\/\/([^:/@]+):[^@]*@/, '://$1:***@');

/**
 * 🔴 库名必须写进 URL 的 path：`pg` 里 `connectionString` 与显式 `database` 同时给时，路径优先/显式键被
 * 忽略的坑会让人误连到与角色同名的库（本机实测 FATAL: database "gy_s4_p2b_runtime" does not exist）。
 */
const baseUrl = (user, database, password) =>
  `postgresql://${user}${password === undefined ? '' : `:${password}`}@127.0.0.1:${port}/${database}`;

/** 全链迁移：目录原始扫描后逐文件 `query`（`pg` 的简单查询协议能一次执行多语句文件）。 */
async function applyMigrations(db) {
  const files = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort();
  assert.ok(
    files.includes('0044_third_party_deletion_persistence.sql'),
    `迁移目录里没有 0044 三期删除迁移（目录里 ${files.length} 个 .sql）`,
  );
  for (const name of files) {
    // eslint-disable-next-line no-await-in-loop
    await db.query(readFileSync(new URL(name, migrationsDir), 'utf8'));
  }
  return files;
}

// ---------------------------------------------------------------------------
// 断言工具
// ---------------------------------------------------------------------------
const RECORD_SQL =
  'SELECT public.record_third_party_deletion($1::uuid, $2::text, $3::uuid, $4::text, $5::text, $6::text, $7::timestamptz) AS rec';
const LIST_SQL = 'SELECT * FROM public.list_third_party_deletions($1::uuid) AS t';
/** 迁移 0046：六个位置参数（`$6` 传 NULL 等价于走函数的 `p_audit_id DEFAULT NULL` 分支）。 */
const DENIAL_SQL =
  'SELECT public.record_admin_scope_denial($1::uuid, $2::uuid, $3::text, $4::text, $5::uuid, $6::uuid) AS audit_id';

/** 调写函数；返回 jsonb 解出来的对象（`pg` 会把 jsonb 解析成 JS 值）。 */
const record = async (client, args) => (await client.query(RECORD_SQL, args)).rows[0].rec;
const listRows = async (client, requestId) => (await client.query(LIST_SQL, [requestId])).rows;
/** 调 0046 的留痕函数；返回写入行的 `admin_audit_events.id`。 */
const recordDenial = async (client, args) => (await client.query(DENIAL_SQL, args)).rows[0].audit_id;
/** 审计台账里 `action='admin_scope.deny'` 的行数（读数 [K] 的「不落行」判据）。 */
const countDenials = async (client) =>
  (await client.query("SELECT count(*)::int AS n FROM public.admin_audit_events WHERE action = 'admin_scope.deny'"))
    .rows[0].n;

/**
 * 钉住 SQLSTATE：库层用 `RAISE EXCEPTION USING ERRCODE = 'G0001'` 这类自定义五位码，`pg` 把 SQLSTATE
 * 放在 `error.code` 上。⛔ 不能只断言「报错了」——那对「换了个错」也是绿的。
 */
async function expectSqlState(promise, expectedCode, label) {
  let value;
  try {
    value = await promise;
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    assert.equal(
      error.code,
      expectedCode,
      `${label}：期望 SQLSTATE ${expectedCode}，实际 ${error.code ?? '(无 code)'} / ${error.message}`,
    );
    return error;
  }
  assert.fail(`${label}：期望 SQLSTATE ${expectedCode}，实际**成功返回**了 ${JSON.stringify(value)}`);
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------
const USER_ID = randomUUID();
const REQ_A = randomUUID(); // ① ② ⑥ —— 主路径
const REQ_B = randomUUID(); // ⑥ —— 同 recipient 的第二个 request
const REQ_C = randomUUID(); // ③ ④ ⑤ ⑧ —— 拒绝面与 export_ref 两支
const EXPORT_REF = randomUUID(); // ⑧ —— 真实 exports 行
const RECIPIENT_MAIN = 'acme-export';
const RECIPIENT_SECOND = 'beta-export';
const RECIPIENT_REJECT = 'gamma-export';
const RECIPIENT_FAILED = 'delta-export';
const RECIPIENT_CONFIRMED = 'epsilon-export';
const RECIPIENT_EXPORT = 'zeta-export';
const AT = '2026-04-01T00:00:00.000Z';
const LATER = '2026-04-02T03:04:05.006Z';

/**
 * 迁移 0046 的夹具（读数 [I]–[L]）。
 *
 * 两个管理员都**刻意不持有任何 scope**（`seedFixtures` 一条 `admin_scopes` 都不插）——
 * 这是 [L] 的判据：留痕函数必须**不**核「actor 是否持 `scopes:write`」，否则
 * 「因为不持 `scopes:write` 而被拒」的行会被它自己再拒一次，一条也留不下。
 * 第二个 actor 还特意是 `state='suspended'`：函数也**不**核 `active`（裁定 B 明写）。
 */
const ACTOR_ACTIVE = randomUUID();
const ACTOR_SUSPENDED = randomUUID();
const TARGET_ADMIN = randomUUID();
const DENIAL_REQUEST = randomUUID();
const EXPLICIT_AUDIT_ID = randomUUID();
const DENIAL_TARGET_HINT = `admin_account:${TARGET_ADMIN}`;

async function seedFixtures(db) {
  await db.query('INSERT INTO public.users (id) VALUES ($1)', [USER_ID]);
  for (const [requestId, hashChar] of [[REQ_A, 'a'], [REQ_B, 'b'], [REQ_C, 'c']]) {
    // eslint-disable-next-line no-await-in-loop
    await db.query(
      `INSERT INTO public.deletion_requests
         (id, user_id, receipt_hash, generation, online_due_at, backup_due_at, receipt_expires_at)
       VALUES ($1, $2, repeat($3::text, 64), 1,
               now() + interval '1 day', now() + interval '2 day', now() + interval '7 day')`,
      [requestId, USER_ID, hashChar],
    );
  }
  await db.query(
    `INSERT INTO public.exports
       (id, user_id, object_type, object_id, object_revision, purpose, consent_epoch,
        recipient_id, recipient_config_version, auth_epoch)
     VALUES ($1, $2, 'recording', $3, 1, 'recording', 1, $4, 'cfg-1', 1)`,
    [EXPORT_REF, USER_ID, randomUUID(), RECIPIENT_MAIN],
  );
  // 迁移 0046：两个管理员（凭证是**明显的合成值**，不是任何真实凭据的哈希）+ 一个被操作目标。
  // ⛔ 刻意不插 `admin_scopes` 行：本臂要证明「留痕函数不重核持有面」。
  await db.query(
    `INSERT INTO public.admin_accounts (id, login_name, credential_hash, state)
     VALUES ($1, 'gy-r64-pr4a-actor-active', 'synthetic-not-a-credential', 'active'),
            ($2, 'gy-r64-pr4a-actor-suspended', 'synthetic-not-a-credential', 'suspended'),
            ($3, 'gy-r64-pr4a-target', 'synthetic-not-a-credential', 'active')`,
    [ACTOR_ACTIVE, ACTOR_SUSPENDED, TARGET_ADMIN],
  );
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const clients = [];
let failure = null;

async function main() {
  port = await pickPort();
  startCluster();

  const bootstrap = await connectWithRetry(baseUrl('postgres', 'postgres'));
  try {
    await bootstrap.query(`CREATE DATABASE ${DB_NAME}`);
  } finally {
    await bootstrap.end();
  }

  const db = await connectWithRetry(baseUrl('postgres', DB_NAME));
  clients.push(db);
  const migrations = await applyMigrations(db);
  console.log(`  - 全链迁移 ${migrations.length} 个文件已应用（${migrations[0]} → ${migrations.at(-1)}）`);
  await seedFixtures(db);

  // 运行时身份：只有三条函数的 EXECUTE（表上零权限）。口令只在内存里。
  const password = randomBytes(24).toString('hex');
  await db.query(`CREATE ROLE ${RUNTIME_ROLE} LOGIN PASSWORD '${password}'`);
  await db.query(`GRANT USAGE ON SCHEMA public TO ${RUNTIME_ROLE}`);
  await db.query(`GRANT EXECUTE ON FUNCTION ${RECORD_SIGNATURE} TO ${RUNTIME_ROLE}`);
  await db.query(`GRANT EXECUTE ON FUNCTION ${LIST_SIGNATURE} TO ${RUNTIME_ROLE}`);
  // 迁移 0046 的留痕写函数（镜像 `20-login-roles.sql` 的 gy-r64-pr4a-denial-trace-grant：只授 EXECUTE）。
  await db.query(`GRANT EXECUTE ON FUNCTION ${DENIAL_SIGNATURE} TO ${RUNTIME_ROLE}`);
  const runtime = await connectWithRetry(baseUrl(RUNTIME_ROLE, DB_NAME, password));
  clients.push(runtime);
  because(`运行时身份 ${RUNTIME_ROLE}：只有三条函数的 EXECUTE（会话级，口令只在内存里）`);
  // 夹具自证：`admin_scopes` 里一条行都没有 ⇒ 「不持 scopes:write」不是"恰好没查"，而是可读的事实。
  // 若将来有人往夹具里补了一条 `scopes:write` 授权，[L] 的判据就失去依据 ⇒ 这里先把它钉死。
  const scopeRows = await db.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE scope = 'scopes:write' AND revoked_at IS NULL)::int AS write_holders
       FROM public.admin_scopes`,
  );
  assert.equal(scopeRows.rows[0].total, 0, `[I] 夹具里不得有任何 admin_scopes 行，实际 ${scopeRows.rows[0].total} 行`);
  assert.equal(
    scopeRows.rows[0].write_holders,
    0,
    `[I] 全表 scopes:write 有效持有者必须是 0，实际 ${scopeRows.rows[0].write_holders}`,
  );
  because('夹具自证：admin_scopes 全表 0 行 / scopes:write 有效持有者 0 个（[L] 的「不重核持有面」判据靠它）');

  // ── [A] ① 首次写 requested：落行 / requested_at == p_at / 读回八列 ─────────────────────────
  const first = await record(runtime, [REQ_A, RECIPIENT_MAIN, null, 'requested', null, null, AT]);
  assert.equal(first.request_id, REQ_A, '[A] 回显的 request_id 必须等于传入值');
  assert.equal(first.recipient_id, RECIPIENT_MAIN, '[A] 回显的 recipient_id 必须等于传入值');
  assert.equal(first.export_ref, null, '[A] NULL export_ref 必须原样回显 null');
  assert.equal(first.online_state, 'requested', '[A] 首次写 requested ⇒ online_state 必须是 requested');
  assert.equal(first.backup_state, 'requested', '[A] 库层一次调用把两列写成同一个 p_state ⇒ backup_state 也必须是 requested');
  assert.equal(first.requested_at, AT, `[A] requested_at 必须与传入 p_at 同形同值（UTC、毫秒精度），实际 ${first.requested_at}`);
  assert.equal(first.confirmed_at, null, '[A] requested 不是终态 ⇒ confirmed_at 必须为 null');
  assert.equal(first.evidence_ref, null, '[A] requested 不带证据 ⇒ evidence_ref 必须为 null');
  assert.equal(first.error_code, null, '[A] requested 不记错误码 ⇒ error_code 必须为 null');

  const physical = await db.query(
    `SELECT recipient_id, export_ref, online_status::text AS online_status, backup_status::text AS backup_status,
            requested_at, confirmed_at, evidence_ref, error_code
       FROM public.third_party_deletions WHERE request_id = $1`,
    [REQ_A],
  );
  assert.equal(physical.rowCount, 1, `[A] 首次写必须恰好落 1 行，实际 ${physical.rowCount} 行`);
  assert.equal(
    physical.rows[0].requested_at.toISOString(),
    AT,
    `[A] 库内 requested_at 列必须等于传入 p_at（timestamptz 往返），实际 ${physical.rows[0].requested_at.toISOString()}`,
  );
  assert.equal(physical.rows[0].online_status, 'requested', '[A] 库内 online_status 列必须是 requested');
  assert.equal(physical.rows[0].backup_status, 'requested', '[A] 库内 backup_status 列必须是 requested');

  const listedFirst = await listRows(db, REQ_A);
  assert.equal(listedFirst.length, 1, `[A] 读面必须返回 1 行，实际 ${listedFirst.length}`);
  assert.deepEqual(
    Object.keys(listedFirst[0]),
    [...EIGHT_COLUMNS],
    `[A] 读面八列的名字与顺序必须等于 RETURNS TABLE 声明序（0044:271-280），实际 ${Object.keys(listedFirst[0]).join(',')}`,
  );
  assert.deepEqual(
    { ...listedFirst[0] },
    {
      recipient_id: RECIPIENT_MAIN,
      export_ref: null,
      online_state: 'requested',
      backup_state: 'requested',
      requested_at: AT,
      confirmed_at: null,
      evidence_ref: null,
      error_code: null,
    },
    '[A] 读面八列的值必须与写入参数逐列一致',
  );
  mark('A', `① 首次写 requested 落行；requested_at=${AT} 与 p_at 同形；读回八列序 ${EIGHT_COLUMNS.join(',')}`);
  because('依据 0044:97-105 / :119-128 / :179（两列同写）/ :254-255、:297-298（UTC 同形时刻）/ :271-280（八列声明序）');

  // ── [B] ② 重复写：幂等，且 requested_at 不被刷新 ───────────────────────────────────────────
  const repeatSame = await record(runtime, [REQ_A, RECIPIENT_MAIN, null, 'requested', null, null, AT]);
  assert.deepEqual(repeatSame, first, '[B] 同参数重复写必须**原样返回**同一行（幂等，不是报错也不是新增）');
  const repeatLater = await record(runtime, [REQ_A, RECIPIENT_MAIN, null, 'requested', null, null, LATER]);
  assert.equal(
    repeatLater.requested_at,
    AT,
    `[B] 重复写**不得**刷新 requested_at（COALESCE 保留首次）：实际 ${repeatLater.requested_at}，期望 ${AT}`,
  );
  assert.equal(repeatLater.online_state, 'requested', '[B] 重复写后状态仍是 requested');
  const stillOne = await db.query(
    'SELECT count(*)::int AS n FROM public.third_party_deletions WHERE request_id = $1 AND recipient_id = $2',
    [REQ_A, RECIPIENT_MAIN],
  );
  assert.equal(stillOne.rows[0].n, 1, `[B] 重复写不得新增行（幂等 upsert），实际 ${stillOne.rows[0].n} 行`);
  mark('B', `② 同 (request, recipient, NULL) 重复写 requested ⇒ 幂等，requested_at 冻结在 ${AT}（未刷新为 ${LATER}）`);
  because('依据 0044:190 / :214（requested_at = COALESCE(d.requested_at, EXCLUDED.requested_at)）⇒ 库层实现是幂等，不是报错');

  // ── [C] ③ 函数写白名单闭集外 ⇒ G0001 ───────────────────────────────────────────────────────
  await expectSqlState(
    record(runtime, [REQ_C, RECIPIENT_REJECT, null, 'not_requested', null, null, AT]),
    'G0001',
    '[C] p_state=not_requested',
  );
  const rejectRows = await db.query(
    'SELECT count(*)::int AS n FROM public.third_party_deletions WHERE request_id = $1 AND recipient_id = $2',
    [REQ_C, RECIPIENT_REJECT],
  );
  assert.equal(rejectRows.rows[0].n, 0, `[C] 写白名单闭集外的 state 必须**不落行**，实际落了 ${rejectRows.rows[0].n} 行`);
  mark('C', '③ p_state=not_requested（写白名单闭集外）⇒ G0001 INVALID_REQUEST，且零落行');
  because('依据 0044:112（x_states 只含 requested/confirmed/failed/unsupported）+ :119-128（RAISE … ERRCODE=G0001）');

  // ── [D] ④ failed 缺 error_code ⇒ G0001；带 error_code 才落行；超长 ⇒ G0001 ───────────────────
  for (const bad of [null, '', '   ']) {
    // eslint-disable-next-line no-await-in-loop
    await expectSqlState(
      record(runtime, [REQ_C, RECIPIENT_FAILED, null, 'failed', null, bad, AT]),
      'G0001',
      `[D] p_state=failed 且 error_code=${JSON.stringify(bad)}`,
    );
  }
  const failedRows = await db.query(
    'SELECT count(*)::int AS n FROM public.third_party_deletions WHERE request_id = $1 AND recipient_id = $2',
    [REQ_C, RECIPIENT_FAILED],
  );
  assert.equal(failedRows.rows[0].n, 0, `[D] failed 缺 error_code 必须**不落行**，实际落了 ${failedRows.rows[0].n} 行`);

  const failedOk = await record(runtime, [REQ_C, RECIPIENT_FAILED, null, 'failed', null, 'SYNTHETIC_DOWNSTREAM_TIMEOUT', AT]);
  assert.equal(failedOk.online_state, 'failed', '[D] 带 error_code 的 failed 必须落行');
  assert.equal(failedOk.backup_state, 'failed', '[D] failed 同样两列同写');
  assert.equal(failedOk.error_code, 'SYNTHETIC_DOWNSTREAM_TIMEOUT', '[D] error_code 必须原样落库并回显');
  assert.equal(failedOk.confirmed_at, null, '[D] failed 不是终态 ⇒ confirmed_at 必须为 null');

  await expectSqlState(
    record(runtime, [REQ_C, RECIPIENT_FAILED, null, 'failed', null, 'X'.repeat(81), AT]),
    'G0001',
    '[D] error_code 超 80 字符',
  );
  mark('D', '④ failed 缺/空白 error_code ⇒ G0001 且零落行（**报错，不落行**）；带 27 字符 error_code 才落行；81 字符 ⇒ G0001');
  because("依据 0044:150-153（IF p_error_code IS NULL OR btrim(p_error_code)='' ⇒ RAISE G0001）+ :130-132（长度上界 80）");

  // ── [E] ⑤ 终态不可回退 ⇒ G0003 ──────────────────────────────────────────────────────────────
  const confirmed = await record(runtime, [REQ_C, RECIPIENT_CONFIRMED, null, 'confirmed', 'evidence://synthetic/1', null, AT]);
  assert.equal(confirmed.online_state, 'confirmed', '[E] confirmed 必须落行');
  assert.equal(confirmed.backup_state, 'confirmed', '[E] confirmed 同样两列同写');
  assert.equal(confirmed.confirmed_at, AT, `[E] confirmed_at 必须等于传入 p_at，实际 ${confirmed.confirmed_at}`);
  assert.equal(confirmed.evidence_ref, 'evidence://synthetic/1', '[E] confirmed 必须带证据并原样落库');

  const confirmedReplay = await record(runtime, [REQ_C, RECIPIENT_CONFIRMED, null, 'confirmed', 'evidence://synthetic/1', null, AT]);
  assert.deepEqual(
    confirmedReplay,
    confirmed,
    '[E] 终态**同参数重放**必须幂等原样返回（守卫挡下 upsert 后回读比对相同）',
  );

  await expectSqlState(
    record(runtime, [REQ_C, RECIPIENT_CONFIRMED, null, 'requested', null, null, LATER]),
    'G0003',
    '[E] confirmed → requested 终态回退',
  );
  const confirmedRow = (await listRows(db, REQ_C)).filter((row) => row.recipient_id === RECIPIENT_CONFIRMED);
  assert.equal(confirmedRow.length, 1, '[E] 回退被拒后仍必须恰好 1 行');
  assert.equal(confirmedRow[0].online_state, 'confirmed', '[E] 回退被拒后 online_state 不得被改写');
  assert.equal(confirmedRow[0].backup_state, 'confirmed', '[E] 回退被拒后 backup_state 不得被改写');
  assert.equal(confirmedRow[0].requested_at, AT, '[E] 回退被拒后 requested_at 不得被改写');
  assert.equal(confirmedRow[0].evidence_ref, 'evidence://synthetic/1', '[E] 回退被拒后证据不得丢失');
  mark('E', '⑤ confirmed → requested（终态回退）⇒ G0003 REVISION_CONFLICT；同参数重放仍幂等；被拒后整行一字未改');
  because("依据 0044:194-195 / :218-219（DO UPDATE … WHERE 两列 NOT IN ('confirmed','unsupported')）+ :224-246（回读比对 ⇒ G0003 @:244，幂等重放 @:241-242）");

  // ── [F] ⑥ 读面隔离：按 request_id（⛔ 不是 recipient_id）────────────────────────────────────
  await record(runtime, [REQ_B, RECIPIENT_MAIN, null, 'requested', null, null, LATER]);
  await record(runtime, [REQ_A, RECIPIENT_SECOND, null, 'requested', null, null, AT]);
  const listA = await listRows(db, REQ_A);
  const listB = await listRows(db, REQ_B);
  assert.equal(listA.length, 2, `[F] 同一 request 下两个 recipient 必须**都**返回（库层真实语义），实际 ${listA.length} 行`);
  assert.deepEqual(
    listA.map((row) => row.recipient_id),
    [RECIPIENT_MAIN, RECIPIENT_SECOND],
    '[F] 读面必须按 (recipient_id, export_ref) 排序',
  );
  assert.equal(listB.length, 1, `[F] REQ_B 只应有自己那 1 行，实际 ${listB.length} 行`);
  assert.equal(listB[0].recipient_id, RECIPIENT_MAIN, '[F] REQ_B 的 recipient_id 与 REQ_A 同名（隔离靠 request 而不是 recipient）');
  assert.equal(listB[0].requested_at, LATER, '[F] REQ_B 那行是它自己的时刻（LATER）⇒ 两个 request 的行互不可见、也不互相覆盖');
  assert.equal(listA[0].requested_at, AT, '[F] REQ_A 那行仍是它自己的 requested_at（未被 REQ_B 的同名 recipient 影响）');
  assert.ok(
    !listA.some((row) => row.recipient_id === RECIPIENT_CONFIRMED || row.recipient_id === RECIPIENT_FAILED),
    '[F] REQ_C 的行不得出现在 REQ_A 的读数里',
  );
  await expectSqlState(listRows(db, null), 'G0001', '[F] list(NULL)');
  mark('F', '⑥ 读面按 request_id 隔离：同 recipient 在两个 request 下互不可见；同 request 下两 recipient 均可见并按 (recipient, export_ref) 排序；list(NULL) ⇒ G0001');
  because('依据 0044:270（签名是 p_request_id，⛔ 不是 p_recipient_id）/ :302 / :303 / :288-290；⚠ 与任务书「按 recipient_id 隔离」不符，以实测为准');

  // ── [G] ⑦ 直写表被拒（只有 EXECUTE）──────────────────────────────────────────────────────────
  const whoami = await runtime.query('SELECT current_user AS me, session_user AS su');
  assert.equal(whoami.rows[0].me, RUNTIME_ROLE, `[G] 调用身份必须是 ${RUNTIME_ROLE}`);
  assert.equal(whoami.rows[0].su, RUNTIME_ROLE, `[G] session_user 也必须是 ${RUNTIME_ROLE}（没有 SET ROLE 伪装）`);
  const privileges = (
    await runtime.query(
      `SELECT has_table_privilege(current_user, 'public.third_party_deletions', 'SELECT') AS sel,
              has_table_privilege(current_user, 'public.third_party_deletions', 'INSERT') AS ins,
              has_table_privilege(current_user, 'public.third_party_deletions', 'UPDATE') AS upd,
              has_table_privilege(current_user, 'public.third_party_deletions', 'DELETE') AS del,
              has_function_privilege(current_user, $1, 'EXECUTE') AS rec_exec,
              has_function_privilege(current_user, $2, 'EXECUTE') AS list_exec`,
      [RECORD_SIGNATURE, LIST_SIGNATURE],
    )
  ).rows[0];
  assert.equal(privileges.sel, false, '[G] 运行时身份不得持有表 SELECT');
  assert.equal(privileges.ins, false, '[G] 运行时身份不得持有表 INSERT');
  assert.equal(privileges.upd, false, '[G] 运行时身份不得持有表 UPDATE');
  assert.equal(privileges.del, false, '[G] 运行时身份不得持有表 DELETE');
  assert.equal(privileges.rec_exec, true, '[G] 运行时身份必须持有写函数的 EXECUTE（否则整条臂就是空转）');
  assert.equal(privileges.list_exec, true, '[G] 运行时身份必须持有读函数的 EXECUTE');

  await expectSqlState(
    runtime.query('INSERT INTO public.third_party_deletions (request_id, recipient_id) VALUES ($1, $2)', [REQ_A, 'direct-write']),
    '42501',
    '[G] 运行时身份直 INSERT 表',
  );
  await expectSqlState(runtime.query('SELECT count(*) FROM public.third_party_deletions'), '42501', '[G] 运行时身份直 SELECT 表');
  await expectSqlState(
    runtime.query('UPDATE public.third_party_deletions SET evidence_ref = $1 WHERE request_id = $2', ['x', REQ_A]),
    '42501',
    '[G] 运行时身份直 UPDATE 表',
  );
  await expectSqlState(
    runtime.query('DELETE FROM public.third_party_deletions WHERE request_id = $1', [REQ_A]),
    '42501',
    '[G] 运行时身份直 DELETE 表',
  );
  const directRow = await db.query(
    "SELECT count(*)::int AS n FROM public.third_party_deletions WHERE recipient_id = 'direct-write'",
  );
  assert.equal(directRow.rows[0].n, 0, '[G] 被拒的直写不得留下任何行');
  mark('G', '⑦ 运行时身份直 INSERT/SELECT/UPDATE/DELETE 表全部恰好 42501；表级四权限全 false、两函数 EXECUTE 全 true、零落行');
  because('依据 0044:309-310（REVOKE ALL ON FUNCTION … FROM PUBLIC）+ 表上零授权（授 EXECUTE 只在 deploy/postgres-cvm/sql/20-login-roles.sql 的 D5 区）');

  // ── [H] ⑧ export_ref 为 NULL 与 uuid 两条路都能落行 ─────────────────────────────────────────
  const withNull = await record(runtime, [REQ_C, RECIPIENT_EXPORT, null, 'requested', null, null, AT]);
  assert.equal(withNull.export_ref, null, '[H] NULL export_ref 支必须落行并回显 null');
  const withUuid = await record(runtime, [REQ_C, RECIPIENT_EXPORT, EXPORT_REF, 'requested', null, null, AT]);
  assert.equal(withUuid.export_ref, EXPORT_REF, '[H] uuid export_ref 支必须落行并回显该 uuid');
  const bothRows = (await listRows(db, REQ_C)).filter((row) => row.recipient_id === RECIPIENT_EXPORT);
  assert.equal(
    bothRows.length,
    2,
    `[H] 同一 (request, recipient) 下 NULL 行与 uuid 行必须并存 2 行（两条部分唯一索引各管一支），实际 ${bothRows.length} 行`,
  );
  assert.equal(bothRows.filter((row) => row.export_ref === null).length, 1, '[H] 两行里必须恰有一行 export_ref 为 null');
  assert.equal(
    bothRows.filter((row) => row.export_ref === EXPORT_REF).length,
    1,
    `[H] 两行里必须恰有一行 export_ref 等于 ${EXPORT_REF}`,
  );
  await expectSqlState(
    record(runtime, [REQ_C, RECIPIENT_EXPORT, randomUUID(), 'requested', null, null, AT]),
    'G0002',
    '[H] export_ref 指向不存在的 exports 行',
  );
  mark('H', '⑧ export_ref=NULL 与 export_ref=uuid 两条路都落行且并存 2 行（两条部分唯一索引各管一支）；未知 uuid ⇒ G0002 NOT_FOUND');
  because('依据 0044:172-196（NULL 支 ON CONFLICT (request_id, recipient_id) WHERE export_ref IS NULL）/ :198-221（三元组支）/ :165-169（exports 自检 ⇒ G0002）');

  // ═══════════════════════════════════════════════════════════════════════════
  // 以下是**迁移 0046**（`#18` S2 收尾片的库层一半）的四组读数 [I]–[L]。
  // 与上面 0044 那八组共用同一套前提（自起集群 / 全链迁移 / 只有 EXECUTE 的运行时身份），
  // 因此不另开脚本 —— 新脚本不会被 `.github/workflows/real-pg-integration.yml` 逐文件列举跑到。
  // ═══════════════════════════════════════════════════════════════════════════

  // ── [I] ⑨ 留痕写入口：运行时**能**执行，且写死的列落库正确 ─────────────────────────────────
  const denialId = await recordDenial(runtime, [ACTOR_ACTIVE, TARGET_ADMIN, 'scopes:write', 'last_scope_manager', DENIAL_REQUEST, null]);
  assert.match(denialId ?? '', /^[0-9a-f-]{36}$/i, `[I] 函数必须返回一个 uuid（审计行 id），实际 ${JSON.stringify(denialId)}`);
  const denialRow = (
    await db.query(
      `SELECT actor_id, action, scope, target_ref, target_hint, reason_code, request_id, result, created_at
         FROM public.admin_audit_events WHERE id = $1`,
      [denialId],
    )
  ).rows;
  assert.equal(denialRow.length, 1, `[I] 一次调用必须恰好落 1 行，实际 ${denialRow.length} 行`);
  const denial = denialRow[0];
  assert.equal(denial.actor_id, ACTOR_ACTIVE, '[I] actor_id 必须等于 p_actor_id（函数不收「以谁的名义写」的旁路参数）');
  assert.equal(denial.action, 'admin_scope.deny', '[I] action 必须是写死的 admin_scope.deny');
  assert.equal(denial.result, 'denied', "[I] result 必须是写死的 'denied'（0017:87 的 CHECK 已经包含该值）");
  assert.equal(denial.scope, 'scopes:write', '[I] scope 必须原样等于 p_scope');
  assert.equal(denial.target_ref, null, '[I] target_ref 必须是 NULL（契约 TargetRef 闭集没有 account）');
  assert.equal(denial.target_hint, DENIAL_TARGET_HINT, `[I] target_hint 必须是 admin_account:<target>，实际 ${denial.target_hint}`);
  assert.equal(denial.reason_code, 'last_scope_manager', '[I] reason_code 必须原样等于 p_reason_code');
  assert.equal(denial.request_id, DENIAL_REQUEST, '[I] request_id 必须原样等于 p_request_id');
  assert.ok(denial.created_at instanceof Date, '[I] created_at 必须由库落值（审计行时刻）');

  // `p_audit_id` 两支：给值 ⇒ 用调用方的 id；给 NULL ⇒ 函数内 `gen_random_uuid()`（回显的 id 与第 6 参无关）。
  const explicitId = await recordDenial(runtime, [ACTOR_ACTIVE, TARGET_ADMIN, 'audit:read', 'scope_denied', DENIAL_REQUEST, EXPLICIT_AUDIT_ID]);
  assert.equal(explicitId, EXPLICIT_AUDIT_ID, '[I] p_audit_id 给值时，返回的必须是这一个 id（不另生成）');
  const explicitRow = await db.query(
    "SELECT action, result, scope, reason_code FROM public.admin_audit_events WHERE id = $1",
    [EXPLICIT_AUDIT_ID],
  );
  assert.equal(explicitRow.rows.length, 1, '[I] p_audit_id 指定的行必须真的落库');
  assert.equal(explicitRow.rows[0].scope, 'audit:read', '[I] 第二支的 scope 同样原样落库');
  assert.equal(explicitRow.rows[0].reason_code, 'scope_denied', '[I] 第二支的 reason_code 同样原样落库');
  assert.notEqual(denialId, explicitId, '[I] p_audit_id 为 NULL 的那一支必须是**另一个** id（函数自己生成的）');
  mark('I', '⑨ 运行时身份能执行 record_admin_scope_denial：写死 action=admin_scope.deny / result=denied / target_ref=NULL，target_hint=admin_account:<target>；p_audit_id 给值就用它、给 NULL 就由函数生成');
  because('依据 0046 的 INSERT 字面量（action/result/target_ref 写死、target_hint 由 p_target_id 重建）+ x_audit_id := COALESCE(p_audit_id, gen_random_uuid())');

  // ── [J] ⑩ 运行时**不能**直写审计表：它只能走这条函数，绕不过函数里写死的列 ─────────────────
  const auditPrivs = (
    await runtime.query(
      `SELECT has_table_privilege(current_user, 'public.admin_audit_events', 'SELECT') AS sel,
              has_table_privilege(current_user, 'public.admin_audit_events', 'INSERT') AS ins,
              has_table_privilege(current_user, 'public.admin_audit_events', 'UPDATE') AS upd,
              has_table_privilege(current_user, 'public.admin_audit_events', 'DELETE') AS del,
              has_function_privilege(current_user, $1, 'EXECUTE') AS denial_exec`,
      [DENIAL_SIGNATURE],
    )
  ).rows[0];
  assert.equal(auditPrivs.sel, false, '[J] 运行时身份不得持有 admin_audit_events 的 SELECT');
  assert.equal(auditPrivs.ins, false, '[J] 运行时身份不得持有 admin_audit_events 的 INSERT');
  assert.equal(auditPrivs.upd, false, '[J] 运行时身份不得持有 admin_audit_events 的 UPDATE');
  assert.equal(auditPrivs.del, false, '[J] 运行时身份不得持有 admin_audit_events 的 DELETE');
  assert.equal(auditPrivs.denial_exec, true, '[J] 运行时身份必须持有留痕函数的 EXECUTE（否则 [I] 就是空转）');

  const directDenial = [
    'INSERT INTO public.admin_audit_events (id, actor_id, action, scope, target_ref, target_hint, reason_code, request_id, result)',
    "VALUES ($1, $2, 'admin_scope.deny', 'scopes:write', NULL, $3, 'scope_denied', $4, 'denied')",
  ].join(' ');
  await expectSqlState(
    runtime.query(directDenial, [randomUUID(), ACTOR_ACTIVE, DENIAL_TARGET_HINT, DENIAL_REQUEST]),
    '42501',
    '[J] 运行时身份直 INSERT 审计表（想绕过函数自己写一行 denied）',
  );
  await expectSqlState(
    runtime.query('SELECT count(*) FROM public.admin_audit_events'),
    '42501',
    '[J] 运行时身份直 SELECT 审计表',
  );
  await expectSqlState(
    runtime.query("UPDATE public.admin_audit_events SET result = 'accepted' WHERE id = $1", [denialId]),
    '42501',
    '[J] 运行时身份直 UPDATE 审计表（想把 denied 改成 accepted）',
  );
  await expectSqlState(
    runtime.query('DELETE FROM public.admin_audit_events WHERE id = $1', [denialId]),
    '42501',
    '[J] 运行时身份直 DELETE 审计表',
  );
  const afterDirect = await db.query('SELECT result FROM public.admin_audit_events WHERE id = $1', [denialId]);
  assert.equal(afterDirect.rows.length, 1, '[J] 被拒的直写/直改/直删都不得动到那一行');
  assert.equal(afterDirect.rows[0].result, 'denied', '[J] 那一行的 result 必须仍是 denied（绕不过函数里写死的列）');
  mark('J', '⑩ 运行时身份对 admin_audit_events 表级 S/I/U/D 全 false、留痕函数 EXECUTE true；直 INSERT/SELECT/UPDATE/DELETE 全部恰好 42501；被拒后那一行仍是 result=denied');
  because('依据 0046 的 REVOKE ALL … FROM PUBLIC + 表上零授权（授 EXECUTE 只在 20-login-roles.sql 的 gy-r64-pr4a-denial-trace-grant）');

  // ── [K] ⑪ 闭集外取值 ⇒ G0001，且**不落行** ────────────────────────────────────────────────
  const denialsBefore = await countDenials(db);
  for (const badReason of DENIAL_BAD_REASONS) {
    // eslint-disable-next-line no-await-in-loop
    await expectSqlState(
      recordDenial(runtime, [ACTOR_ACTIVE, TARGET_ADMIN, 'scopes:write', badReason, DENIAL_REQUEST, null]),
      'G0001',
      `[K] 理由码闭集外的 reason_code=${badReason}`,
    );
  }
  for (const badScope of DENIAL_BAD_SCOPES) {
    // eslint-disable-next-line no-await-in-loop
    await expectSqlState(
      recordDenial(runtime, [ACTOR_ACTIVE, TARGET_ADMIN, badScope, 'scope_denied', DENIAL_REQUEST, null]),
      'G0001',
      `[K] 后台权限 13 项闭集外的 scope=${badScope}`,
    );
  }
  // 空 scope / 空 uuid 一律 G0001（入参自检，与闭集判定同一条分支）。
  await expectSqlState(
    recordDenial(runtime, [ACTOR_ACTIVE, TARGET_ADMIN, '   ', 'scope_denied', DENIAL_REQUEST, null]),
    'G0001',
    '[K] 空白 scope',
  );
  await expectSqlState(
    recordDenial(runtime, [null, TARGET_ADMIN, 'scopes:write', 'scope_denied', DENIAL_REQUEST, null]),
    'G0001',
    '[K] 空 p_actor_id',
  );
  await expectSqlState(
    recordDenial(runtime, [ACTOR_ACTIVE, null, 'scopes:write', 'scope_denied', DENIAL_REQUEST, null]),
    'G0001',
    '[K] 空 p_target_id',
  );
  await expectSqlState(
    recordDenial(runtime, [ACTOR_ACTIVE, TARGET_ADMIN, 'scopes:write', 'scope_denied', null, null]),
    'G0001',
    '[K] 空 p_request_id',
  );
  const denialsAfter = await countDenials(db);
  assert.equal(
    denialsAfter,
    denialsBefore,
    `[K] 被 G0001 拒掉的调用必须**不落行**：前后必须都是 ${denialsBefore} 行，实际 ${denialsAfter} 行`,
  );
  mark('K', `⑪ 理由码闭集外（${DENIAL_BAD_REASONS.join('/')}）与 scope 闭集外（${DENIAL_BAD_SCOPES.join('/')}）以及空 uuid/空 scope ⇒ 一律 G0001 INVALID_REQUEST，且**零落行**（admin_scope.deny 行数前后都是 ${denialsBefore}）`);
  because('依据 0046 的入参自检：`NOT (p_scope = ANY (x_scope_allowed))` / `NOT (p_reason_code = ANY (x_reason_allowed))` ⇒ RAISE ERRCODE=G0001');

  // ── [L] ⑫ 只核 actor **存在**：不核 active、不核 scopes:write ──────────────────────────────
  // 为什么这条最重要：留痕的正是「你不持 / 会归零 / 越权」。若函数顺手重核一遍，
  // 「因为不持 scopes:write 而被拒」的行会被它自己再拒一次 ⇒ 该记的行一条也留不下。
  const suspendedId = await recordDenial(runtime, [ACTOR_SUSPENDED, TARGET_ADMIN, 'flags:write', 'scope_not_held', DENIAL_REQUEST, null]);
  const suspendedRow = (
    await db.query('SELECT actor_id, result, scope, reason_code FROM public.admin_audit_events WHERE id = $1', [suspendedId])
  ).rows;
  assert.equal(suspendedRow.length, 1, '[L] `state=suspended` 的 actor 也必须能留痕（⛔ 函数不核 active）');
  assert.equal(suspendedRow[0].actor_id, ACTOR_SUSPENDED, '[L] 留痕的 actor 必须就是那个 suspended 的管理员');
  assert.equal(suspendedRow[0].result, 'denied', '[L] suspended actor 的行同样是 result=denied');
  assert.equal(suspendedRow[0].reason_code, 'scope_not_held', '[L] suspended actor 的行同样原样带 reason_code');

  const suspendedState = await db.query('SELECT state::text AS st FROM public.admin_accounts WHERE id = $1', [ACTOR_SUSPENDED]);
  assert.equal(suspendedState.rows[0].st, 'suspended', '[L] 夹具自证：那个 actor 真的是 suspended');
  const stillNoHolders = await db.query(
    "SELECT count(*)::int AS n FROM public.admin_scopes WHERE scope = 'scopes:write' AND revoked_at IS NULL",
  );
  assert.equal(
    stillNoHolders.rows[0].n,
    0,
    '[L] 夹具自证：全表 scopes:write 有效持有者仍是 0 ⇒ 两个 actor 都不持元权限，留痕却照样成功（证明没有重核持有面）',
  );
  await expectSqlState(
    recordDenial(runtime, [randomUUID(), TARGET_ADMIN, 'scopes:write', 'scope_denied', DENIAL_REQUEST, null]),
    'G0002',
    '[L] actor 不存在（唯一保留的那条核验）',
  );
  mark('L', '⑫ 只核 actor 存在：state=suspended 且全表 0 个 scopes:write 有效持有者的 actor 照样留痕（⛔ 不核 active、⛔ 不核持有面）；actor 不存在 ⇒ G0002 NOT_FOUND');
  because('依据 0046 文件头「这是应用层申报，不是库层证明」+ 函数体只有 `SELECT 1 … FROM public.admin_accounts WHERE id = p_actor_id` 一条核验');
}

/**
 * 失败时先回吐两份日志的尾部再清目录：initdb/pg_ctl 的输出在 serverLog，postgres 自己的 fatal 在
 * postgresLog，删掉就再也看不到。
 */
function dumpLog(path, tail = 30) {
  if (!existsSync(path)) {
    console.error(`  - 日志不存在：${path}`);
    return;
  }
  const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line !== '');
  const shown = lines.slice(-tail);
  console.error(`  - 日志尾部（${path}，共 ${lines.length} 行，以下 ${shown.length} 行）：`);
  for (const line of shown) console.error(`    ${line}`);
}

try {
  await main();
} catch (error) {
  failure = error;
} finally {
  for (const client of clients) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await client.end();
    } catch {
      /* 收尾时连接可能已被停库打断：忽略即可 */
    }
  }
  // 断言红的时候就别把 60 行 postgres ERROR 灌进 CI 日志：崩在库层才需要那两份日志。
  if (failure !== null && !(failure instanceof assert.AssertionError)) {
    dumpLog(serverLog);
    dumpLog(postgresLog);
  }
  try {
    stopCluster();
  } catch (error) {
    failure ??= error;
  }
}

if (failure !== null) {
  console.error(`FAIL: ${failure.message}`);
  process.exit(1);
}

assert.equal(readings, 12, `读数行必须是 12 条（[A]–[H] = 0044 的 8 条，[I]–[L] = 0046 的 4 条），实际 ${readings} 条`);
console.log(`[ALL PASS] 0044 两条库层函数运行时语义 ①–⑧ ＋ 0046 拒绝留痕 ⑨–⑫ 全部取得（共 ${readings} 组读数，exit code 0）`);
