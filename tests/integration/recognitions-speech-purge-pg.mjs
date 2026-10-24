// GY-R34-I19-CLOSURE2（#19 延续片）· 识别域 + 语音域注销清理 · **真实 PostgreSQL 17** 行数证据
//
// 运行（自起自停的临时集群，只走 127.0.0.1）：
//   $env:GY_PG_BIN = 'E:\GengYunCommander\.pg17\pgsql\bin'      # 必填：含 initdb/pg_ctl 的目录
//   $env:GY_R34_PG_ROOT = 'E:\GengYunCommander\.pg17\tmp'       # 选填：数据目录根（默认 os.tmpdir()）
//   node tests/integration/recognitions-speech-purge-pg.mjs
// 未设置 `GY_PG_BIN` ⇒ 打印 SKIP 并以 **77** 退出（POSIX「skipped」/未取得，**不是通过**）：
// 本脚本不提供 `--allow-skip` —— 本片的结论是「行数入证据」，取不到真库就没有读数。
//
// ## 本脚本自证的**唯一**事情
//
// 本片把识别域四表（`recognition_jobs` / `recognition_records` / `recognition_selections` /
// `recognition_idempotency`，迁移 0025）与语音域三表（`speech_jobs` / `transcriptions` /
// `speech_idempotency`，迁移 0026）接进了注销闭集。此前这两域**既没有按主体清空的存储原语、
// 也没有运行时角色的表级 DELETE 授权**（`20-login-roles.sql` 的旧注释声称「账号注销经
// `request_account_deletion()` 的属主级联」，但该函数并不删 `public.users` 行 ⇒ 那条级联永不触发）。
// 所以本脚本要证的是四段闭环：
//   [1] 迁移 0025/0026/0034 的七张真实表与两条清理函数在岗；
//   [2] 生产清理身份（`gengyun_api_runtime`）的真实授权面：**两条函数可执行**（EXECUTE=true），
//       而对五张正文/任务表**一条 DELETE 都没有**（false），对 `public.users` 也没有 DELETE；
//   [3] 成对的反向控制：以运行时身份**直接** `DELETE FROM public.recognition_records /
//       speech_jobs …` 必须恰好 `42501` —— 证明 0 行不是靠表权限删出来的，而是函数删的；
//   [4] 走产品真实路径（`privacy/user-data-deletion.ts` 协调器 → 两个 PG 存储的
//       `purgeOwnerData` → 迁移 0034 的 definer 函数）跑注销，断言：本主体七表**删到 0 行**、
//       他人行**逐字原样**、证据串两个计数逐项等于清理前读数、重放幂等两个计数都是 0、
//       回执两域 `online_state=completed` 而 `backup_state=pending`（未接线备份端口 ⇒ 不谎称完成）。
//   外加负控制：另立一主体全程**不跑清理**只读 ⇒ 行数非 0（证明上面的 0 行不是恒真断言）。
//
// ## 权限口径（本片最容易搞错的地方，也是上一版被 gate 打回的原因）
//
// 七张表里三张台账（`recognition_idempotency` / 语音 `speech_idempotency`）本来就有表级 DELETE
// （release / purge 两条路径）；五张正文/任务表**不是**、也不许是 ——
// `deploy/postgres-cvm/evidence/probe-runtime-grants.sql` 把「运行时直接 DELETE 这五张表」
// 锁成刻意的禁止面（deploy-sql-gate 逐条断言 42501，18 条 / 9 个对象）。
// PG 没有列级 DELETE ⇒ 清理只能经 `SECURITY DEFINER` 函数（迁移 0034），
// 由 `20-login-roles.sql` 的 `gy-r34-i19-owner-content-purge-grant` 区域只授 EXECUTE。
// 清理**跑在运行时角色上**，并在断言里实测两侧：能执行函数 ≠ 能删表。
//
// ## R34 片 3 的分岔（别把两域的口径套到 OCR 上）
//
// 同一个闭集里 `ocr` 域走的是**相反**的路：`ocr_jobs` / `ocr_records` 拿到的是
// **表级 `GRANT DELETE`**（用户 2026-10-24 批准的**唯一**例外，与早已表级的
// `ocr_idempotency` 统一成一条路线），由 `ocr/store-pg.ts` 的 `purgeOwnerRows` 直接
// `DELETE … RETURNING`，不经 definer 函数。所以本臂对这两张表断言的是
// `has_table_privilege(...,'DELETE') = true`，并真的把模板里那两条 GRANT 跑一遍
// （`ocrGrantBlock()`）—— 少了授权，`ocr` 域会 fail-closed 折成 `blocked`，
// 下面的回执断言立刻红。⛔ 这两条授权**只限**这两张表：`public.media` 与五张禁止面一律不变。

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import pg from 'pg';

import { idempotencyKeyHashHex, idempotencyScope } from '../../services/api/src/auth/idempotency.ts';
import { createMemoryConversationStore } from '../../services/api/src/conversations/store.ts';
import { createMemoryFavoritesStore } from '../../services/api/src/favorites/store.ts';
import { createMemoryHistoryStore } from '../../services/api/src/history/store.ts';
import { createPostgresOcrStore } from '../../services/api/src/ocr/store-pg.ts';
import { createUserDataDeletion } from '../../services/api/src/privacy/user-data-deletion.ts';
import { createPostgresRecognitionStore } from '../../services/api/src/recognitions/store-pg.ts';
import { createPostgresSpeechStore } from '../../services/api/src/speech/store-pg.ts';

const binDir = process.env.GY_PG_BIN ?? '';
if (binDir === '') {
  console.log(
    'SKIP: 未设置 GY_PG_BIN（postgres 二进制目录，含 initdb/pg_ctl）⇒ 真库臂跳过，'
      + '没有取得「识别域/语音域注销行数」的真库读数（未取得，不是通过）。',
  );
  console.log('EXITCODE=77 表示未取得，不是通过（POSIX 惯例 skipped；本脚本刻意不提供 --allow-skip）。');
  process.exit(77);
}

const DB_NAME = 'gengyun_recs_speech_purge_test';
const RUNTIME_ROLE = 'gengyun_api_runtime';
/**
 * R34 片 3 起运行时**真的有**表级 `DELETE` 的两张表（用户 2026-10-24 批准的例外）。
 * 与 `OWNER_PURGE_TABLES`（识别/语音的五张禁止面，`DELETE` 必须 `false`）方向相反：
 * 这里是 `true` 才是设计。`ocr_idempotency` 本来就有表级 DELETE，不在本表里。
 */
const OCR_DELETE_GRANT_TABLES = ['ocr_jobs', 'ocr_records'];
const serverLog =
  process.env.GY_R34_PG_LOG ?? join(tmpdir(), `gy-r34-rec-speech-pg-${randomBytes(3).toString('hex')}.log`);

const migrationsDir = new URL('../../services/api/db/migrations/', import.meta.url);
const readSql = (path) => readFileSync(new URL(`../../services/api/db/${path}`, import.meta.url), 'utf8');
const deploySqlFile = (name) => readFileSync(new URL(`../../deploy/postgres-cvm/sql/${name}`, import.meta.url), 'utf8');

let passed = 0;
const say = (label) => {
  passed += 1;
  console.log(`PASS ${passed}: ${label}`);
  return passed;
};
const note = (line) => console.log(`  - ${line}`);

// 七张表的名字（顺序 = 断言顺序；正文/任务在前、台账在后）。
const RECOGNITION_TABLES = ['recognition_selections', 'recognition_jobs', 'recognition_records'];
const SPEECH_TABLES = ['speech_jobs', 'transcriptions'];
// 五张正文/任务表：运行时**不许**有表级 DELETE（禁止面），清理只能经下面的两条函数。
const OWNER_PURGE_TABLES = [...RECOGNITION_TABLES, ...SPEECH_TABLES];
// 迁移 0034 的两条窄口径 SECURITY DEFINER 函数：运行时只有 EXECUTE。
const PURGE_FUNCTIONS = ['purge_owner_recognitions', 'purge_owner_speech'];

// ---------------------------------------------------------------------------
// 临时集群（数据目录与端口都随机；端口取 55700–55999，避开 55436 的遗留集群与本机 5432）
// ---------------------------------------------------------------------------
const rootDir = process.env.GY_R34_PG_ROOT ?? tmpdir();
const dataDir = join(rootDir, `gy-r34-rec-speech-pg-${randomBytes(4).toString('hex')}`);
let port = 0;
let adminBase = '';
let targetUrl = '';
const tool = (name) => join(binDir, process.platform === 'win32' ? `${name}.exe` : name);

/** 端口空闲？（只探 127.0.0.1：集群也只监听回环） */
function portIsFree(candidate) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(candidate, '127.0.0.1');
  });
}

async function pickPort() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const candidate = 55700 + randomInt(0, 300);
    // 开发机上已有一个 55436 的遗留临时集群：范围已避开，这里再硬挡一次，防止将来改范围时撞上。
    if (candidate === 55436) continue;
    if (await portIsFree(candidate)) return candidate;
  }
  throw new Error('557xx 区间内找不到空闲端口（同机临时集群过多）');
}

/**
 * 子进程统一把 stdout/stderr 重定向到**文件**：本机 sandbox 禁止命名管道，
 * 用管道收集 postgres/pg_ctl 的输出会让调用方等 EOF 等到超时。
 */
function runTool(name, args) {
  const fd = openSync(serverLog, 'a');
  try {
    return spawnSync(tool(name), args, {
      stdio: ['ignore', fd, fd],
      env: { ...process.env, PGCONNECT_TIMEOUT: '5' },
      timeout: 180_000,
      windowsHide: true,
    });
  } finally {
    closeSync(fd);
  }
}

/**
 * `pg_ctl -o` 的 postgres 参数。
 *
 * POSIX 上**必须**显式把 unix socket 指到本集群自己的数据目录（Debian/Ubuntu 的编译默认
 * `unix_socket_directories` 是 `/var/run/postgresql`，普通用户写不了 ⇒ `pg_ctl start` 直接失败）。
 */
function serverOptions() {
  const options = [`-p ${port}`, '-c listen_addresses=127.0.0.1', '-c max_connections=32'];
  if (process.platform !== 'win32') options.push(`-k ${dataDir}`);
  return options.join(' ');
}

function tailOfFile(file, maxLines = 15) {
  try {
    const lines = readFileSync(file, 'utf8').replace(/\s+$/, '').split('\n');
    return lines.slice(-maxLines).join('\n');
  } catch (error) {
    return `（读不到 ${file}：${error.message}）`;
  }
}

async function startCluster() {
  port = await pickPort();
  adminBase = `postgresql://postgres@127.0.0.1:${port}`;
  targetUrl = `${adminBase}/${DB_NAME}`;
  assert.ok(existsSync(tool('initdb')), `GY_PG_BIN 下没有 initdb：${tool('initdb')}`);
  mkdirSync(dataDir, { recursive: true });
  const init = runTool('initdb', ['-D', dataDir, '--no-sync', '--encoding=UTF8', '--locale=C', '-U', 'postgres', '--auth=trust']);
  assert.equal(init.status, 0, `initdb 失败（status=${init.status}，日志见 ${serverLog}）`);
  const start = runTool('pg_ctl', ['-D', dataDir, '-l', join(dataDir, 'server.log'), '-o', serverOptions(), '-t', '60', '-w', 'start']);
  assert.equal(
    start.status,
    0,
    `pg_ctl start 失败（status=${start.status}，工具日志见 ${serverLog}；`
      + `server.log 尾部：\n${tailOfFile(join(dataDir, 'server.log'))}）`,
  );
  note(`临时集群：数据目录 ${dataDir}，端口 ${port}（只监听 127.0.0.1）`);
}

function stopCluster() {
  // 只删本脚本自己建的那个目录（名字前缀硬钉，避免误删工作树/源码）。
  assert.ok(basename(dataDir).startsWith('gy-r34-rec-speech-pg-'), `拒绝删除非本脚本创建的目录：${dataDir}`);
  if (existsSync(join(dataDir, 'PG_VERSION'))) runTool('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop']);
  // Windows 上 postgres 刚停时句柄可能还没完全释放（杀毒/索引也会短暂持有），rmSync 偶发 EPERM。
  // 清理失败**不得覆盖**上面的真实断言错误：只警告并留下目录（名字带随机后缀，不会撞下次运行）。
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 10 });
      return;
    } catch (error) {
      if (attempt === 4) {
        note(`⚠️ 临时数据目录未能删除（${error.code ?? error.message}）：${dataDir}（需手工清理）`);
        return;
      }
      runTool('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop']);
    }
  }
}

async function connectWithRetry(connectionString, attempts = 40) {
  let lastError;
  for (let index = 0; index < attempts; index += 1) {
    const client = new pg.Client({ connectionString, connectionTimeoutMillis: 2_000 });
    try {
      await client.connect();
      return client;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => {});
      await sleep(250);
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// 造数 / 读数 helper（读数一律用**库属主**视角，别把授权混进断言）
// ---------------------------------------------------------------------------
const countOf = async (sql, params) => Number((await owner.query(sql, params)).rows[0].v);

const idsOf = async (table, ownerId) =>
  (await owner.query(`SELECT id FROM public.${table} WHERE owner_user_id = $1::uuid ORDER BY id`, [ownerId])).rows.map(
    (row) => row.id,
  );

/** 域内台账行（`scope` 前缀 `<uuid>\n`，与 `purgeOwnerData` 的谓词逐字同口径）。 */
const ledgerOf = async (table, subject) =>
  (
    await owner.query(
      `SELECT scope, key_hash
         FROM public.${table}
        WHERE left(scope, char_length($1::text) + 1) = $1::text || chr(10)
        ORDER BY scope, key_hash`,
      [subject],
    )
  ).rows;

/**
 * 造识别域行：任务 + 记录 + 选择（选择引记录，故记录必须先插）。
 *
 * 用**库属主**直插而不是存储 API：本片要证的是「注销时这些行真的没了」，行形状严格按迁移
 * 0025 的列定义（`media_id` 无外键、`candidates` 是 jsonb 数组、`linkage` 是 jsonb 对象）。
 * 清理本身走产品路径（见 [5]），这一点没有妥协。
 */
async function seedRecognition(subject, label, count) {
  const created = [];
  for (let index = 0; index < count; index += 1) {
    const recordId = randomUUID();
    const jobId = randomUUID();
    const selectionId = randomUUID();
    const at = new Date(Date.now() - index * 60_000).toISOString();
    await owner.query(
      `INSERT INTO public.recognition_records
         (id, revision, owner_user_id, media_id, media_revision, candidates, uncertainty_reasons,
          selected_species_id, model_version, created_at, updated_at, deleted)
       VALUES ($1::uuid, 1, $2::uuid, $3::uuid, 1, '[]'::jsonb, '[]'::jsonb, NULL, 'test-model', $4, $4, false)`,
      [recordId, subject, randomUUID(), at],
    );
    await owner.query(
      `INSERT INTO public.recognition_jobs
         (id, revision, kind, owner_user_id, recognition_id, media_id, media_revision, state,
          deadline_at, created_at, updated_at, error_code)
       VALUES ($1::uuid, 1, 'recognition', $2::uuid, $3::uuid, $4::uuid, 1, 'succeeded', $5, $5, $5, NULL)`,
      [jobId, subject, recordId, randomUUID(), at],
    );
    await owner.query(
      `INSERT INTO public.recognition_selections
         (id, revision, recognition_id, owner_user_id, species_id, provenance, decided_at, linkage)
       VALUES ($1::uuid, 1, $2::uuid, $3::uuid, 'rice_blast', 'human', $4, '{"items":[],"excluded":[],"per_item":[]}'::jsonb)`,
      [selectionId, recordId, subject, at],
    );
    created.push({ recordId, jobId, selectionId });
  }
  note(`识别域造数 ${label}：${count} 组（record → job → selection，各 ${count} 行）`);
  return created;
}

/** 造语音域行：任务 + 转写记录（任务引 `transcription_id`，两正文表之间**无**外键）。 */
async function seedSpeech(subject, label, count) {
  const created = [];
  for (let index = 0; index < count; index += 1) {
    const transcriptionId = randomUUID();
    const jobId = randomUUID();
    const at = new Date(Date.now() - index * 60_000).toISOString();
    await owner.query(
      `INSERT INTO public.transcriptions
         (id, revision, owner_user_id, media_id, media_revision, raw_text, uncertain_spans,
          confirmed_text, confirmed_at, model_version, created_at, updated_at, deleted)
       VALUES ($1::uuid, 1, $2::uuid, $3::uuid, 1, $4, '[]'::jsonb, NULL, NULL, 'test-model', $5, $5, false)`,
      [transcriptionId, subject, randomUUID(), `原始转写 ${label}-${index}`, at],
    );
    await owner.query(
      `INSERT INTO public.speech_jobs
         (id, revision, kind, owner_user_id, transcription_id, media_id, media_revision, state,
          deadline_at, created_at, updated_at, error_code)
       VALUES ($1::uuid, 1, 'transcription', $2::uuid, $3::uuid, $4::uuid, 1, 'succeeded', $5, $5, $5, NULL)`,
      [jobId, subject, transcriptionId, randomUUID(), at],
    );
    created.push({ transcriptionId, jobId });
  }
  note(`语音域造数 ${label}：${count} 组（transcription → job，各 ${count} 行）`);
  return created;
}

/**
 * 造域内台账行：`scope` 与 `key_hash` 都用产品自己的 `idempotencyScope` / `idempotencyKeyHashHex`
 * 拼（`<主体 uuid>\n<METHOD>\n<路径>`），不手写字符串模板——否则本片就在自证自己编的格式。
 */
async function seedLedger(table, entries) {
  for (const entry of entries) {
    const scope = idempotencyScope(entry.subject, entry.method, entry.routePath);
    const keyHash = idempotencyKeyHashHex(scope, entry.key);
    await owner.query(
      `INSERT INTO public.${table} (scope, key_hash, request_hash, payload, pending, expires_at)
            VALUES ($1, $2, $3, '{}'::jsonb, false, now() + interval '10 minutes')`,
      [scope, keyHash, randomBytes(32).toString('hex')],
    );
  }
}

/**
 * 运行时角色的授权实测 —— 本片最关键的一条：生产身份**能执行清理函数**，
 * 但对五张正文/任务表**一条 DELETE 都没有**（禁止面），对 `public.users` 也没有。
 *
 * R34 片 3 起多测两列（`ocr_jobs` / `ocr_records` 的 `DELETE`）：这两张是**用户 2026-10-24
 * 批准**的表级 DELETE 例外，`true` 才是设计（与上面五张的 `false` 方向相反，别抄错）。
 */
const grantReadingsOfRuntime = async () => {
  const selected = OWNER_PURGE_TABLES
    .map((table) => `has_table_privilege(current_user, 'public.${table}', 'DELETE') AS ${table}`)
    .concat(PURGE_FUNCTIONS.map(
      (name) => `has_function_privilege(current_user, 'public.${name}(uuid)', 'EXECUTE') AS ${name}_execute`,
    ))
    .concat(OCR_DELETE_GRANT_TABLES.map(
      (table) => `has_table_privilege(current_user, 'public.${table}', 'DELETE') AS ${table}`,
    ))
    .concat("has_table_privilege(current_user, 'public.users', 'DELETE') AS users")
    .join(',\n              ');
  return (await pool.query(`SELECT current_user AS role,\n              ${selected}`)).rows[0];
};

/**
 * 部署脚本里 OCR 三表**整段**授权（`20-login-roles.sql` 的 `gy-r28-runtime-domain-grants` 区内，
 * OCR 相关的 SELECT/INSERT/UPDATE 列级 + 本片新增的两条表级 `DELETE`）。
 *
 * 为什么整段而不是只抽两条 `DELETE`：`purgeOwnerRows` 写的是
 * `DELETE FROM public.ocr_records WHERE owner_user_id = $1::uuid RETURNING id` ——
 * PG 要求 `WHERE` / `RETURNING` 引用的列也有 SELECT 权（否则照样 42501）。
 * 只授表级 DELETE、不授列级 SELECT，本臂就会把「授权面不完整」误报成「fail-closed 生效」。
 *
 * 抽法：在 region 内按 `;` 切语句，只保留「语句里出现 public.ocr_*」且以 GRANT 开头的那些，
 * 丢 `\echo`（纯输出）。断言三张表各有一条 SELECT / INSERT / UPDATE / DELETE，
 * 且每条都只授给运行时角色 —— 少了、多了、授错对象都直接失败。
 */
function ocrGrantBlock() {
  const text = deploySqlFile('20-login-roles.sql');
  const startMarker = '-- #region gy-r28-runtime-domain-grants';
  const endMarker = '-- #endregion gy-r28-runtime-domain-grants';
  const start = text.indexOf(startMarker);
  assert.ok(start > 0, `20-login-roles.sql 必须含运行时域授权区（锚点 ${startMarker}）`);
  const end = text.indexOf(endMarker, start);
  assert.ok(end > start, `运行时域授权区必须有结尾（锚点 ${endMarker}）`);
  const region = text.slice(text.indexOf('\n', start) + 1, end);
  const statements = region
    .split(';')
    .map((chunk) => chunk
      .split(/\r?\n/)
      .filter((line) => !/^\s*\\echo\b/.test(line))
      .join('\n')
      .trim())
    .filter((chunk) => /^\s*GRANT\s/m.test(chunk) && /public\.ocr_(jobs|records|idempotency)\b/.test(chunk));

  for (const table of ['ocr_jobs', 'ocr_records', 'ocr_idempotency']) {
    for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      const matched = statements.filter(
        (statement) => statement.includes(`public.${table}`) && new RegExp(`GRANT\\s+${priv}\\b`).test(statement),
      );
      assert.equal(
        matched.length,
        1,
        `20-login-roles.sql 里 public.${table} 的 ${priv} 授权必须恰好一条（实测 ${matched.length} 条）：`
          + '少一条 ⇒ 运行时要么删不掉、要么连 WHERE/RETURNING 的列都读不到（一样是 42501）',
      );
      assert.match(
        matched[0],
        new RegExp(`TO\\s+${RUNTIME_ROLE}\\b`),
        `public.${table} 的 ${priv} 只能授给运行时角色 ${RUNTIME_ROLE}`,
      );
    }
  }
  for (const table of OCR_DELETE_GRANT_TABLES) {
    const statement = `GRANT DELETE ON public.${table} TO ${RUNTIME_ROLE};`;
    assert.equal(
      text.split(statement).length - 1,
      1,
      `20-login-roles.sql 必须恰好有一条 \`${statement}\``,
    );
  }
  const block = `${statements.join(';\n')};`;
  assert.equal(
    /\\(set|gset|pset|if|endif|getenv|gexec|copytable)/.test(block),
    false,
    'OCR 授权段不得含 psql 元命令（\\echo 已丢弃）',
  );
  return block;
}


/**
 * 部署脚本里的识别域 + 语音域授权段（`20-login-roles.sql` 的 J 段 + K 段）。
 *
 * 为什么不像 `messages-purge-pg.mjs` 那样抽一个具名 `#region`：这两段写在
 * `-- #endregion gy-r28-runtime-domain-grants`（:625）**之后**，不在任何 `#region` 里
 * （`#region` 只有 :236/:263/:296/:329/:356/:386/:417/:471/:1159 九处）。整份文件也**不能**直接
 * 执行：文件头部用 psql 变量（`:'api_password'`）与 `\gset` 做前置判定。
 * 所以按两处**稳定注释锚点**切片，取到的就是生产部署真正跑的那些字节；
 * 段内唯一的 psql 元命令是 `\echo`（纯输出），丢掉不影响授权，其余元命令一律拒绝。
 */
function deployGrants() {
  const text = deploySqlFile('20-login-roles.sql');
  const startMarker = '-- J. 运行时域（识别）的列级授权';
  // 结尾锚点用**下一节的节标题**（`L.` 段的注释行），而不是 K 段自己的某条 `\echo` 文案：
  // `\echo` 是会随复核改写的说明文字，把它当切片边界等于让本臂依赖注释措辞。
  const endMarker = '-- L. 触发器函数的 PUBLIC EXECUTE 兜底收回';
  const start = text.indexOf(startMarker);
  assert.ok(start > 0, `20-login-roles.sql 必须含识别域授权段（锚点 ${startMarker}）`);
  const endLineStart = text.indexOf(endMarker, start);
  assert.ok(endLineStart > start, `20-login-roles.sql 必须含语音域授权段之后的 L 段（锚点 ${endMarker}）`);
  const block = text.slice(start, endLineStart);
  const withoutEcho = block
    .split(/\r?\n/)
    .filter((line) => !/^\s*\\echo\b/.test(line))
    .join('\n');
  assert.equal(
    /\\(set|gset|pset|if|endif|getenv|gexec|copytable)/.test(withoutEcho),
    false,
    '识别域/语音域授权段不得含除 \\echo 之外的 psql 元命令（否则本臂就不是在跑生产语句）',
  );
  return withoutEcho;
}

/**
 * 部署脚本里「注销内容清理」的授权段（`20-login-roles.sql` 的
 * `-- #region gy-r34-i19-owner-content-purge-grant` … `-- #endregion …`）。
 *
 * 与上面 J/K 段不同，这一段**本身就是一个具名 `#region`**（纯 SQL，只有 `\echo` 需要丢掉），
 * 所以按 region 边界原样抽取 —— 取到的就是生产部署真正跑的那些字节。
 * 段内若出现任何其它 psql 元命令，说明 region 边界被挪动过，直接失败。
 */
function purgeGrantBlock() {
  const text = deploySqlFile('20-login-roles.sql');
  const startMarker = '-- #region gy-r34-i19-owner-content-purge-grant';
  const endMarker = '-- #endregion gy-r34-i19-owner-content-purge-grant';
  const start = text.indexOf(startMarker);
  assert.ok(start > 0, `20-login-roles.sql 必须含注销内容清理授权区（锚点 ${startMarker}）`);
  const end = text.indexOf(endMarker, start);
  assert.ok(end > start, `注销内容清理授权区必须有结尾（锚点 ${endMarker}）`);
  const block = text.slice(text.indexOf('\n', start) + 1, end)
    .split(/\r?\n/)
    .filter((line) => !/^\s*\\echo\b/.test(line))
    .join('\n');
  assert.equal(
    /\\(set|gset|pset|if|endif|getenv|gexec|copytable)/.test(block),
    false,
    '注销内容清理授权区不得含 psql 元命令（否则本臂就不是在跑生产语句）',
  );
  assert.match(block, /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.purge_owner_recognitions\(uuid\)/i);
  assert.match(block, /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.purge_owner_speech\(uuid\)/i);
  return block;
}

// ---------------------------------------------------------------------------
let owner;
let pool;

try {
  await startCluster();
  const admin = await connectWithRetry(`${adminBase}/postgres`);
  await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  await admin.end();

  owner = await connectWithRetry(targetUrl);
  const version = (await owner.query('SHOW server_version')).rows[0].server_version;
  note(`PostgreSQL ${version}`);

  // ---- [0] 全链迁移：本片要的是 0025（识别域四表）/ 0026（语音域三表）/ 0034（清理函数）/ 0001（users）----
  const discovered = readdirSync(migrationsDir)
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  for (const name of discovered) await owner.query(readFileSync(new URL(name, migrationsDir), 'utf8'));
  const present = (
    await owner.query(
      `SELECT to_regclass('public.users') AS users,
              to_regprocedure('public.purge_owner_recognitions(uuid)') AS purge_owner_recognitions,
              to_regprocedure('public.purge_owner_speech(uuid)') AS purge_owner_speech,
              ${['recognition_jobs', 'recognition_records', 'recognition_selections', 'recognition_idempotency', 'speech_jobs', 'transcriptions', 'speech_idempotency']
                .map((table) => `to_regclass('public.${table}') AS ${table}`)
                .join(',\n              ')}`,
    )
  ).rows[0];
  assert.equal(present.users, 'users', '迁移后 public.users 必须存在（七张表的外键目标）');
  for (const table of [...OWNER_PURGE_TABLES, 'recognition_idempotency', 'speech_idempotency']) {
    assert.equal(present[table], table, `迁移后 public.${table} 必须存在（本片要证的域）`);
  }
  for (const name of PURGE_FUNCTIONS) {
    assert.equal(
      present[name],
      `${name}(uuid)`,
      `迁移 0034 必须建出 public.${name}(uuid)（清理唯一写路径）`,
    );
  }
  say(
    `[0] 全链迁移 ${discovered.length} 个已应用；识别域四表 + 语音域三表 + users 共查 8 张真实表，`
      + `外加迁移 0034 的两条清理函数 ${PURGE_FUNCTIONS.join(' / ')}，全部在岗`,
  );

  // ---- [1] 角色与授权：与出厂 provisioning 同形（5 个 NOLOGIN 域组 → 运行时 LOGIN → 两个区域）----
  for (const file of [
    'roles/auth_privacy.sql',
    'roles/catalog_readers.sql',
    'roles/consent_granter.sql',
    'roles/profile_runtime.sql',
    'roles/knowledge_runtime.sql',
  ]) {
    await owner.query(readSql(file));
  }
  const password = randomBytes(24).toString('hex');
  await owner.query(
    `CREATE ROLE ${RUNTIME_ROLE} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`,
  );
  await owner.query(`GRANT gengyun_auth_privacy TO ${RUNTIME_ROLE}`);
  await owner.query(deployGrants());
  await owner.query(purgeGrantBlock());
  // R34 片 3：OCR 三表的整段授权（列级 SELECT/INSERT/UPDATE + 两条表级 DELETE，缺一条 test 就红）
  await owner.query(ocrGrantBlock());

  pool = new pg.Pool({ connectionString: `postgresql://${RUNTIME_ROLE}:${password}@127.0.0.1:${port}/${DB_NAME}`, max: 6 });
  const grants = await grantReadingsOfRuntime();
  assert.equal(grants.role, RUNTIME_ROLE, '清理必须在**运行时角色**上跑（不是库属主）');
  for (const table of OWNER_PURGE_TABLES) {
    assert.equal(
      grants[table],
      false,
      `运行时角色**不得**能 DELETE public.${table}：它是 probe-runtime-grants.sql 锁定的禁止面`
        + `（直接 DELETE 必须 42501），清理只能经迁移 0034 的 definer 函数`,
    );
  }
  for (const name of PURGE_FUNCTIONS) {
    assert.equal(
      grants[`${name}_execute`],
      true,
      `运行时角色必须能执行 public.${name}(uuid)（迁移 0034 + 20-login-roles.sql 的 EXECUTE 授权）`,
    );
  }
  assert.equal(grants.users, false, '运行时角色不得能 DELETE public.users（否则下面的 0 行可能是级联带走的）');
  for (const table of OCR_DELETE_GRANT_TABLES) {
    assert.equal(
      grants[table],
      true,
      `运行时角色必须能 DELETE public.${table}：R34 片 3 起它是**用户 2026-10-24 批准**的表级例外`
        + '（`20-login-roles.sql` 的 OCR 段末两条 GRANT）；这里是 false 就说明授权面回退了',
    );
  }
  say(
    `[1] 授权实测（生产身份 ${RUNTIME_ROLE}）：${PURGE_FUNCTIONS.map((name) => `${name} EXECUTE=${grants[`${name}_execute`]}`).join('、')}；`
      + `${OWNER_PURGE_TABLES.map((table) => `${table} DELETE=${grants[table]}`).join('、')}；`
      + `${OCR_DELETE_GRANT_TABLES.map((table) => `${table} DELETE=${grants[table]}`).join('、')}（R34 片 3 例外）；`
      + 'users DELETE=false',
  );

  // ---- [1b] 成对的反向控制：运行时直接 DELETE 这五张表必须恰好 42501 ----
  // 这一条是上一版被 gate 打回的那条不变量的正面复述：**没给表权限**才是设计，
  // 所以「清了 0 行」只能是函数删的，不可能是表权限删的。
  for (const table of OWNER_PURGE_TABLES) {
    let denied = null;
    try {
      await pool.query(`DELETE FROM public.${table} WHERE false`);
    } catch (error) {
      denied = error;
    }
    assert.ok(denied !== null, `运行时直接 DELETE public.${table} 必须失败（禁止面），但居然成功了`);
    assert.equal(denied.code, '42501', `运行时直接 DELETE public.${table} 必须恰好 42501（permission denied），实际 ${denied.code}`);
  }
  say(
    `[1b] 反向控制（生产身份 ${RUNTIME_ROLE}）：直接 DELETE ${OWNER_PURGE_TABLES.join(' / ')} 全部 42501`
      + ' ⇒ 清理的 0 行只能来自迁移 0034 的 definer 函数，不是表权限',
  );

  // ---- [2] 造数：三主体（A=被注销、B=他人、C=负控制），各若干识别/语音行 + 各若干台账行 ----
  const recognitionStore = createPostgresRecognitionStore({ pool });
  const speechStore = createPostgresSpeechStore({ pool });
  // R34 片 3：OCR 三表（0024）也在 `[1]` 的全量迁移里就位，直接用运行时池接真库 store。
  const ocrStore = createPostgresOcrStore({ pool });
  const subjectA = randomUUID();
  const subjectB = randomUUID();
  const subjectC = randomUUID();
  for (const id of [subjectA, subjectB, subjectC]) {
    await owner.query('INSERT INTO public.users (id) VALUES ($1::uuid)', [id]);
  }

  const recognitionA = await seedRecognition(subjectA, 'A', 2);
  const recognitionB = await seedRecognition(subjectB, 'B', 1);
  const recognitionC = await seedRecognition(subjectC, 'C', 1);
  const speechA = await seedSpeech(subjectA, 'A', 2);
  const speechB = await seedSpeech(subjectB, 'B', 1);
  const speechC = await seedSpeech(subjectC, 'C', 1);

  const recognitionLedgerA = [
    { subject: subjectA, method: 'POST', routePath: '/recognitions', key: `rec-a1-${randomUUID()}` },
    { subject: subjectA, method: 'POST', routePath: '/recognitions/{id}/selections', key: `rec-a2-${randomUUID()}` },
  ];
  const recognitionLedgerB = [
    { subject: subjectB, method: 'POST', routePath: '/recognitions', key: `rec-b1-${randomUUID()}` },
  ];
  const recognitionLedgerC = [
    { subject: subjectC, method: 'POST', routePath: '/recognitions', key: `rec-c1-${randomUUID()}` },
  ];
  const speechLedgerA = [
    { subject: subjectA, method: 'POST', routePath: '/speech/transcriptions', key: `sp-a1-${randomUUID()}` },
    { subject: subjectA, method: 'PUT', routePath: '/speech/transcriptions/{id}', key: `sp-a2-${randomUUID()}` },
  ];
  const speechLedgerB = [
    { subject: subjectB, method: 'POST', routePath: '/speech/transcriptions', key: `sp-b1-${randomUUID()}` },
  ];
  const speechLedgerC = [
    { subject: subjectC, method: 'POST', routePath: '/speech/transcriptions', key: `sp-c1-${randomUUID()}` },
  ];
  await seedLedger('recognition_idempotency', [...recognitionLedgerA, ...recognitionLedgerB, ...recognitionLedgerC]);
  await seedLedger('speech_idempotency', [...speechLedgerA, ...speechLedgerB, ...speechLedgerC]);
  note(
    `台账造数：recognition_idempotency A ${recognitionLedgerA.length} / B ${recognitionLedgerB.length} / C ${recognitionLedgerC.length}；`
      + `speech_idempotency A ${speechLedgerA.length} / B ${speechLedgerB.length} / C ${speechLedgerC.length}`,
  );

  // 基线读数（**清理前**）：三主体的行数都必须非 0 —— 这是负控制的另一半（清理前的真值）。
  const baseline = {
    recognitionA: [
      await countOf('SELECT count(*)::int AS v FROM public.recognition_jobs WHERE owner_user_id = $1::uuid', [subjectA]),
      await countOf('SELECT count(*)::int AS v FROM public.recognition_records WHERE owner_user_id = $1::uuid', [subjectA]),
      await countOf('SELECT count(*)::int AS v FROM public.recognition_selections WHERE owner_user_id = $1::uuid', [subjectA]),
    ],
    speechA: [
      await countOf('SELECT count(*)::int AS v FROM public.speech_jobs WHERE owner_user_id = $1::uuid', [subjectA]),
      await countOf('SELECT count(*)::int AS v FROM public.transcriptions WHERE owner_user_id = $1::uuid', [subjectA]),
    ],
    ledgerRecognitionA: (await ledgerOf('recognition_idempotency', subjectA)).length,
    ledgerSpeechA: (await ledgerOf('speech_idempotency', subjectA)).length,
  };
  assert.deepEqual(
    baseline.recognitionA,
    [recognitionA.length, recognitionA.length, recognitionA.length],
    '清理前 A 的识别域三表行数必须都等于造数条数',
  );
  assert.deepEqual(
    baseline.speechA,
    [speechA.length, speechA.length],
    '清理前 A 的语音域两表行数必须都等于造数条数',
  );
  assert.equal(baseline.ledgerRecognitionA, recognitionLedgerA.length, '清理前 A 的识别域台账行数必须等于造数条数');
  assert.equal(baseline.ledgerSpeechA, speechLedgerA.length, '清理前 A 的语音域台账行数必须等于造数条数');

  const beforeB = {
    recognition: [
      await idsOf('recognition_jobs', subjectB),
      await idsOf('recognition_records', subjectB),
      await idsOf('recognition_selections', subjectB),
    ],
    speech: [await idsOf('speech_jobs', subjectB), await idsOf('transcriptions', subjectB)],
    ledgerRecognition: await ledgerOf('recognition_idempotency', subjectB),
    ledgerSpeech: await ledgerOf('speech_idempotency', subjectB),
  };
  const beforeC = {
    recognition: [
      await idsOf('recognition_jobs', subjectC),
      await idsOf('recognition_records', subjectC),
      await idsOf('recognition_selections', subjectC),
    ],
    speech: [await idsOf('speech_jobs', subjectC), await idsOf('transcriptions', subjectC)],
  };
  const ledgerTotalBefore = {
    recognition: await countOf('SELECT count(*)::int AS v FROM public.recognition_idempotency'),
    speech: await countOf('SELECT count(*)::int AS v FROM public.speech_idempotency'),
  };
  say(
    `[2] 清理前读数：A 识别域 ${baseline.recognitionA.join('/')} 行（jobs/records/selections）+ 台账 ${baseline.ledgerRecognitionA} 行；`
      + `A 语音域 ${baseline.speechA.join('/')} 行（jobs/transcriptions）+ 台账 ${baseline.ledgerSpeechA} 行；`
      + `B/C 与 A 同形造数；两本域内台账合计 ${ledgerTotalBefore.recognition}/${ledgerTotalBefore.speech} 行`,
  );

  // ---- [3] 装配注销闭集：两域按 app.ts 的口径接成 OwnerPurgeStore（缺原语即抛，不静默跳过）----
  const recognitionsDeletionStore = {
    async deleteAllByOwner(ownerId) {
      return recognitionStore.deleteAllByOwner(ownerId);
    },
    purgeOwnerData: (ownerId) => recognitionStore.purgeOwnerData(ownerId),
  };
  const speechDeletionStore = {
    async deleteAllByOwner(ownerId) {
      return (await speechStore.purgeOwnerData(ownerId)).records;
    },
    purgeOwnerData: (ownerId) => speechStore.purgeOwnerData(ownerId),
  };
  // R34 片 3：OCR 域也接真库（三表 `ocr_jobs` / `ocr_records` / `ocr_idempotency`）。
  // ⚠️ 与前两域方向**相反**：识别/语音零表级 DELETE、只能走 0034 的 definer 函数；
  // OCR 三表是用户 2026-10-24 批准的**表级** `GRANT DELETE` 例外，所以这里跑的是真 DELETE。
  // 本臂不造 OCR 行（行数口径由 `tests/unit/user-data-deletion-ocr.test.mjs` 与 PGlite 用例覆盖），
  // 但**语句会真的执行** ⇒ 一旦那两条 GRANT 回退，运行时会拿到 42501、该域折叠 blocked，下面全红。
  const ocrDeletionStore = {
    async deleteAllByOwner(ownerId) {
      return (await ocrStore.purgeOwnerData(ownerId)).records;
    },
    purgeOwnerData: (ownerId) => ocrStore.purgeOwnerData(ownerId),
  };
  const deletion = createUserDataDeletion({
    favoritesStore: createMemoryFavoritesStore(),
    historyStore: createMemoryHistoryStore(),
    // 消息/会话域在本片不接真库：用内存实现占位，本脚本只量识别/语音/OCR 三域的行数。
    messagesStore: { deleteAllByOwner: async () => 0 },
    conversationsStore: createMemoryConversationStore(),
    recognitionsStore: recognitionsDeletionStore,
    speechStore: speechDeletionStore,
    ocrStore: ocrDeletionStore,
  });
  const requiredModules = deletion.requiredModules();
  assert.deepEqual(
    requiredModules,
    ['favorites', 'history', 'messages', 'conversations', 'recognitions', 'speech', 'ocr'],
    `必需模块闭集必须是四域 + 识别 + 语音 + OCR（现场 ${requiredModules.join('/')}）`,
  );
  assert.deepEqual(deletion.coordinator.missingRegistrations(), [], '闭集内每个模块都必须已注册处理器');
  say(`[3] 注销闭集：${requiredModules.join(' / ')}（七项，missingRegistrations 为空）`);

  // ---- [4] 跑注销清理：走**真实协调器** → 三个真实 `purgeOwnerData`（运行时角色）----
  const requestA = deletion.requestDeletionFor(subjectA);
  await deletion.executeHandlers(requestA.id);
  const evidenceA = deletion.evidenceOf(requestA.id);
  const evidenceRecognition = String(evidenceA['recognitions'] ?? '');
  const evidenceSpeech = String(evidenceA['speech'] ?? '');
  const evidenceOcr = String(evidenceA['ocr'] ?? '');
  note(`[4] recognitions 证据串逐字：${evidenceRecognition}`);
  note(`[4] speech 证据串逐字：${evidenceSpeech}`);
  note(`[4] ocr 证据串逐字：${evidenceOcr}`);

  const recognitionMatch = evidenceRecognition.match(/^recognitions:online-purged:(\d+);recognitions:idempotency-purged:(\d+)$/);
  assert.ok(
    recognitionMatch !== null,
    `识别域证据串必须是 recognitions:online-purged:N;recognitions:idempotency-purged:M（现场 ${JSON.stringify(evidenceRecognition)}）`,
  );
  const recognitionRowsBefore = baseline.recognitionA.reduce((sum, value) => sum + value, 0);
  assert.equal(Number(recognitionMatch[1]), recognitionRowsBefore, `识别域 online-purged 必须等于清理前 A 的三表行数之和（${recognitionRowsBefore}）`);
  assert.equal(Number(recognitionMatch[2]), baseline.ledgerRecognitionA, `识别域 idempotency-purged 必须等于清理前 A 的台账行数（${baseline.ledgerRecognitionA}）`);
  const speechMatch = evidenceSpeech.match(/^speech:online-purged:(\d+);speech:idempotency-purged:(\d+)$/);
  assert.ok(
    speechMatch !== null,
    `语音域证据串必须是 speech:online-purged:N;speech:idempotency-purged:M（现场 ${JSON.stringify(evidenceSpeech)}）`,
  );
  const speechRowsBefore = baseline.speechA.reduce((sum, value) => sum + value, 0);
  assert.equal(Number(speechMatch[1]), speechRowsBefore, `语音域 online-purged 必须等于清理前 A 的两表行数之和（${speechRowsBefore}）`);
  assert.equal(Number(speechMatch[2]), baseline.ledgerSpeechA, `语音域 idempotency-purged 必须等于清理前 A 的台账行数（${baseline.ledgerSpeechA}）`);
  // OCR 域（R34 片 3）：三表是**表级 DELETE**，所以证据串比前两域多一段 `tables:` 分表读数
  // （键序 = 删除顺序：先 `ocr_records` 后 `ocr_jobs`）。本臂不造 OCR 行 ⇒ 逐表都是 0；
  // ⚠️ 这条同时是授权面哨兵：若两条 GRANT DELETE 回退 ⇒ 42501 ⇒ 该域折叠 blocked ⇒ 这里与
  // 回执的 `online_state=completed` 一起红（不会静默变成"0 行 = 清完了"）。
  assert.equal(
    evidenceOcr,
    'ocr:online-purged:0;ocr:idempotency-purged:0;ocr:tables:ocr_records=0,ocr_jobs=0',
    `OCR 域证据串必须带 tables 分表读数（现场 ${JSON.stringify(evidenceOcr)}）`,
  );
  assert.equal(
    await countOf('SELECT count(*)::int AS v FROM public.ocr_jobs WHERE owner_user_id = $1::uuid', [subjectA]),
    0,
    'OCR 域清理后本主体 ocr_jobs 必须 0 行',
  );
  assert.equal(
    await countOf('SELECT count(*)::int AS v FROM public.ocr_records WHERE owner_user_id = $1::uuid', [subjectA]),
    0,
    'OCR 域清理后本主体 ocr_records 必须 0 行',
  );
  say(
    `[4] 证据串：${evidenceRecognition} / ${evidenceSpeech} / ${evidenceOcr}（计数取自 DELETE … RETURNING 的实际行数，且逐项等于清理前读数）`,
  );

  // ---- [5] 断言一：本主体七表按 FK 先子后父删到 0 行；他人行原样；users 行仍在 ----
  const afterA = {
    recognition: [
      await countOf('SELECT count(*)::int AS v FROM public.recognition_jobs WHERE owner_user_id = $1::uuid', [subjectA]),
      await countOf('SELECT count(*)::int AS v FROM public.recognition_records WHERE owner_user_id = $1::uuid', [subjectA]),
      await countOf('SELECT count(*)::int AS v FROM public.recognition_selections WHERE owner_user_id = $1::uuid', [subjectA]),
    ],
    speech: [
      await countOf('SELECT count(*)::int AS v FROM public.speech_jobs WHERE owner_user_id = $1::uuid', [subjectA]),
      await countOf('SELECT count(*)::int AS v FROM public.transcriptions WHERE owner_user_id = $1::uuid', [subjectA]),
    ],
    ledgerRecognition: (await ledgerOf('recognition_idempotency', subjectA)).length,
    ledgerSpeech: (await ledgerOf('speech_idempotency', subjectA)).length,
  };
  assert.deepEqual(afterA.recognition, [0, 0, 0], '注销清理后本主体识别域三表必须 0 行（硬删）');
  assert.deepEqual(afterA.speech, [0, 0], '注销清理后本主体语音域两表必须 0 行（硬删）');
  assert.equal(afterA.ledgerRecognition, 0, '注销清理后本主体识别域台账必须按 scope 前缀删到 0');
  assert.equal(afterA.ledgerSpeech, 0, '注销清理后本主体语音域台账必须按 scope 前缀删到 0');

  const afterB = {
    recognition: [
      await idsOf('recognition_jobs', subjectB),
      await idsOf('recognition_records', subjectB),
      await idsOf('recognition_selections', subjectB),
    ],
    speech: [await idsOf('speech_jobs', subjectB), await idsOf('transcriptions', subjectB)],
    ledgerRecognition: await ledgerOf('recognition_idempotency', subjectB),
    ledgerSpeech: await ledgerOf('speech_idempotency', subjectB),
  };
  assert.deepEqual(afterB, beforeB, '他人（B）的七表行必须**逐字原样**（id / scope / key_hash 都不许变）');
  assert.equal(
    await countOf('SELECT count(*)::int AS v FROM public.users WHERE id = $1::uuid', [subjectA]),
    1,
    'A 的 users 行必须还在 —— 否则这些 0 行可能是被 users 的 ON DELETE CASCADE 带走的',
  );
  say(
    '① 本主体七表注销后全 0 行（识别三表 + 语音两表 + 两本域内台账）；A 的 users 行仍在 ⇒ 不是外键级联的副作用；'
      + '他人 B 的七表逐字原样',
  );

  // ---- [6] 负控制：不跑清理只读 ⇒ 行数非 0（上面的 0 行不是恒真断言）----
  const afterC = {
    recognition: [
      await idsOf('recognition_jobs', subjectC),
      await idsOf('recognition_records', subjectC),
      await idsOf('recognition_selections', subjectC),
    ],
    speech: [await idsOf('speech_jobs', subjectC), await idsOf('transcriptions', subjectC)],
    ledgerRecognition: (await ledgerOf('recognition_idempotency', subjectC)).length,
    ledgerSpeech: (await ledgerOf('speech_idempotency', subjectC)).length,
  };
  assert.deepEqual(afterC.recognition, beforeC.recognition, '负控制：没跑清理的 C 识别域行必须仍是非 0');
  assert.deepEqual(afterC.speech, beforeC.speech, '负控制：没跑清理的 C 语音域行必须仍是非 0');
  assert.equal(afterC.ledgerRecognition, recognitionLedgerC.length, '负控制：C 的识别域台账必须仍是非 0');
  assert.equal(afterC.ledgerSpeech, speechLedgerC.length, '负控制：C 的语音域台账必须仍是非 0');
  const ledgerTotalAfter = {
    recognition: await countOf('SELECT count(*)::int AS v FROM public.recognition_idempotency'),
    speech: await countOf('SELECT count(*)::int AS v FROM public.speech_idempotency'),
  };
  assert.equal(
    ledgerTotalAfter.recognition,
    ledgerTotalBefore.recognition - baseline.ledgerRecognitionA,
    '识别域台账只许少掉本主体那几行，不许整表清空',
  );
  assert.equal(
    ledgerTotalAfter.speech,
    ledgerTotalBefore.speech - baseline.ledgerSpeechA,
    '语音域台账只许少掉本主体那几行，不许整表清空',
  );
  say(
    `② 负控制读数（同库同连接、只读）：未清理主体 C 识别域 ${afterC.recognition.map((ids) => ids.length).join('/')} 行、`
      + `语音域 ${afterC.speech.map((ids) => ids.length).join('/')} 行、台账 ${afterC.ledgerRecognition}/${afterC.ledgerSpeech} 行；`
      + `两本台账整表 ${ledgerTotalBefore.recognition}/${ledgerTotalBefore.speech} → ${ledgerTotalAfter.recognition}/${ledgerTotalAfter.speech} 行（不是整表清空）`,
  );

  // ---- [7] 重放幂等：对同一主体再跑一次 ⇒ 各域计数都是 0（计数真的来自 RETURNING）----
  const requestA2 = deletion.requestDeletionFor(subjectA);
  await deletion.executeHandlers(requestA2.id);
  const replay = deletion.evidenceOf(requestA2.id);
  assert.equal(String(replay['recognitions'] ?? ''), 'recognitions:online-purged:0;recognitions:idempotency-purged:0');
  assert.equal(String(replay['speech'] ?? ''), 'speech:online-purged:0;speech:idempotency-purged:0');
  // OCR 域重放：第三段 `tables:` 也必须如实归 0（不是把整段省略掉）。
  assert.equal(
    String(replay['ocr'] ?? ''),
    'ocr:online-purged:0;ocr:idempotency-purged:0;ocr:tables:ocr_records=0,ocr_jobs=0',
  );
  assert.deepEqual(
    {
      recognition: [
        await idsOf('recognition_jobs', subjectB),
        await idsOf('recognition_records', subjectB),
        await idsOf('recognition_selections', subjectB),
      ],
      speech: [await idsOf('speech_jobs', subjectB), await idsOf('transcriptions', subjectB)],
      ledgerRecognition: await ledgerOf('recognition_idempotency', subjectB),
      ledgerSpeech: await ledgerOf('speech_idempotency', subjectB),
    },
    beforeB,
    '重放不得碰到他人七表',
  );
  say('重放幂等：同一主体第二次清理 = 四个计数全 0；他人七表原样');

  // ---- [8] 回执形状：三域在线清除 completed、备份态 pending（未接线端口不谎称完成）----
  const receiptA = deletion.receipt(requestA.id);
  for (const module of ['recognitions', 'speech', 'ocr']) {
    const row = receiptA.handlers.find((entry) => entry.module === module);
    assert.ok(row !== undefined, `回执必须含 ${module} 处理器行`);
    assert.equal(row.online_state, 'completed', `${module} 在线清除必须 completed`);
    assert.equal(row.backup_state, 'pending', `${module} 备份态在本片未接线 ⇒ 只能是 pending（不谎称完成）`);
  }
  assert.equal(deletion.completionStatus(requestA.id).completed, false, '备份态 pending ⇒ 整笔未完成（如实）');
  say('回执：recognitions / speech / ocr 的 online_state = completed（证据串即行数）；backup_state = pending（本片未接备份端口，不谎称完成）');

  console.log(`\nALL PASS：${passed} 条真库断言（exit code 0）`);
  console.log('EXITCODE=0');
} finally {
  await pool?.end().catch(() => {});
  await owner?.end().catch(() => {});
  stopCluster();
}
