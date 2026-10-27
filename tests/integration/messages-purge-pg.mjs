// GY-R28-W11（#17）· 消息域注销清理 · **真实 PostgreSQL 17** 行数证据
//
// 运行（自起自停的临时集群，只走 127.0.0.1）：
//   $env:GY_PG_BIN = 'E:\GengYunCommander\.pg17\pgsql\bin'      # 必填：含 initdb/pg_ctl 的目录
//   $env:GY_W11_PG_ROOT = 'E:\GengYunCommander\.pg17\tmp'       # 选填：数据目录根（默认 os.tmpdir()）
//   node tests/integration/messages-purge-pg.mjs
// 未设置 `GY_PG_BIN` ⇒ 打印 SKIP 并以 **77** 退出（POSIX「skipped」/未取得，**不是通过**）：
// 本机/CI 没有 PG 二进制时如实跳过，不伪造 PASS。本脚本**不**提供 `--allow-skip` —— 本片的结论是
// 「行数入证据」，取不到真库就没有读数，任何把 77 读成绿的开关都会把缺口重新藏起来。
//
// ## 本脚本自证的**唯一**事情（E6 关闭材料点出的 C5 缺口）
//
// `docs/verification/gy-r28-e6-closure-materials-20261021.md` 记的是：#17 的 C5 判据
// 「注销时点该域行被硬删且行数入证据」此前**只在 PGlite 与内存 store 上证过**；既有真库臂
// `tests/integration/favorites-history-pg.mjs:456-460` 自陈**没有 `public.messages` 表**（走内存
// store ⇒ `messages:online-purged:0` 恒成立）。本脚本把那条臂缺的东西补上：
//   [1] 真库里有 `public.messages`（迁移 0019）与共享台账 `public.idempotency_keys`（迁移 0008）；
//   [2] 造数：**两个主体各若干消息行 + 各自若干幂等台账行**（含他人数据、含本主体在**其它域**的台账行）；
//   [3] 注销清理走**产品真实路径**：`services/api/src/privacy/user-data-deletion.ts` 的协调器 →
//       `messages/store-pg.ts` 的 `purgeOwnerData`（同一事务 `DELETE … RETURNING`，**不是**本脚本自己拼 SQL）；
//   [4] 断言：本主体消息 **0 行**（硬删）/ 他人消息**原样** / 本主体台账按 `scope` 前缀**删到 0** /
//       他人台账**原样** / 证据串含 `messages:online-purged:<n>` 与 `messages:idempotency-purged:<m>` 两个计数；
//   [5] **负控制**：另立一个主体，全程**不跑清理**只读 ⇒ 行数非 0（证明上面的 0 行不是恒真断言）。
//
// ## 为什么是「自起临时集群」而不是接既有 env（二选一，这里给理由）
//
// 生产路径要两个身份：库属主（建表/迁移/造 `users` 行）＋运行时角色 `gengyun_api_runtime`
// （真正执行清理）。共享 CI 集群里角色与授权是**跨库残留**的（`real-pg-integration.yml:109` 的注释
// 就是在讲这件事），接既有库要么复用别人的角色（拿不到「本片授权够不够」的读数），要么在别人库里
// 建角色（留下残留）。自起集群能保证：空库 ⇒ 全链迁移 ⇒ 干净角色 ⇒ 两个区域 ⇒ 跑完 `pg_ctl stop`
// 并删数据目录，**零残留**。代价：需要有 `GY_PG_BIN`（缺则 77）。
// 端口取 55700–55999 且**先探活再 initdb**：同机可能已有别人的临时集群（本片开发机上就有一个
// 55436 的遗留集群，**必须避开**）。
//
// ## 权限口径（本片最容易搞错的地方）
//
// 运行时角色对 `public.messages` 的 DELETE 是**表级**授权（`deploy/postgres-cvm/sql/20-login-roles.sql`
// 的 `gy-r28-runtime-domain-grants` 区域 `:449-454`，PU 无列级 DELETE）；对**共享**台账
// `public.idempotency_keys` 的 DELETE 来自域组角色 `gengyun_auth_privacy`
// （`services/api/db/roles/auth_privacy.sql:33`）。本脚本把清理**跑在运行时角色上**并在断言里
// 实测这两项授权（`has_table_privilege`），因为「属主能删」不等于「生产身份能删」。
// 反向也实测：运行时角色对 `public.users` **没有** DELETE —— 消息行是被那条 DELETE 删的，
// 不是 `messages.owner_id … ON DELETE CASCADE` 顺手带走的。

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import pg from 'pg';

import { idempotencyKeyHashHex, idempotencyScope } from '../../services/api/src/auth/idempotency.ts';
import { createMemoryConversationStore } from '../../services/api/src/conversations/store.ts';
import { createMemoryFavoritesStore } from '../../services/api/src/favorites/store.ts';
import { createMemoryHistoryStore } from '../../services/api/src/history/store.ts';
import { createPostgresMessagesStore } from '../../services/api/src/messages/store-pg.ts';
import { createUserDataDeletion } from '../../services/api/src/privacy/user-data-deletion.ts';
import { pickFreePort } from './lib/free-port.mjs';

const binDir = process.env.GY_PG_BIN ?? '';
if (binDir === '') {
  console.log(
    'SKIP: 未设置 GY_PG_BIN（postgres 二进制目录，含 initdb/pg_ctl）⇒ 真库臂跳过，'
      + '没有取得「message 域注销行数」的真库读数（未取得，不是通过）。',
  );
  console.log('EXITCODE=77 表示未取得，不是通过（POSIX 惯例 skipped；本脚本刻意不提供 --allow-skip）。');
  process.exit(77);
}

const DB_NAME = 'gengyun_messages_purge_test';
const RUNTIME_ROLE = 'gengyun_api_runtime';
const serverLog = process.env.GY_W11_PG_LOG ?? join(tmpdir(), `gy-w11-pg-${randomBytes(3).toString('hex')}.log`);

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

// ---------------------------------------------------------------------------
// 临时集群（数据目录随机；端口向内核要一个此刻空闲的 —— ⛔ 不再用 `55700 + randomInt(0, 300)`：
// 那套挑法落在 Linux 默认 ephemeral 区间 32768–60999 里，会被出站连接的源端口占住）
// ---------------------------------------------------------------------------
const rootDir = process.env.GY_W11_PG_ROOT ?? tmpdir();
const dataDir = join(rootDir, `gy-w11-messages-purge-pg-${randomBytes(4).toString('hex')}`);
let port = 0;
let adminBase = '';
let targetUrl = '';
const tool = (name) => join(binDir, process.platform === 'win32' ? `${name}.exe` : name);

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
 * POSIX 上**必须**显式把 unix socket 指到本集群自己的数据目录：Debian/Ubuntu（含 PGDG 的
 * `postgresql-17`）把编译默认 `unix_socket_directories` 钉成 `/var/run/postgresql`，
 * runner 的普通用户既写不了那个目录、只装包没启服务时该目录甚至不存在 ⇒ `pg_ctl start` 直接失败
 * （`could not create lock file`），而 `server.log` 随后会被 `stopCluster()` 一起删掉。
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
  port = await pickFreePort();
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
  assert.ok(basename(dataDir).startsWith('gy-w11-messages-purge-pg-'), `拒绝删除非本脚本创建的目录：${dataDir}`);
  if (existsSync(join(dataDir, 'PG_VERSION'))) runTool('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop']);
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10 });
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

/** 本主体在共享台账里的行（`scope` 前缀 `<uuid>\n`，与 `purgeOwnerData` 的谓词逐字同口径）。 */
const ledgerOf = async (subject) =>
  (
    await owner.query(
      `SELECT scope, encode(key_hash, 'hex') AS key_hash
         FROM public.idempotency_keys
        WHERE left(scope, char_length($1::text) + 1) = $1::text || chr(10)
        ORDER BY scope, key_hash`,
      [subject],
    )
  ).rows;

const messageIdsOf = async (subject) =>
  (await owner.query('SELECT id FROM public.messages WHERE owner_id = $1::uuid ORDER BY id', [subject])).rows.map(
    (row) => row.id,
  );

/**
 * 通过**真实 store**（`insertMessage`）造消息行：本片要证明的是「注销时这些行真的没了」，
 * 行就必须是产品自己写进去的形状（8 列、`target_ref` 是 jsonb 对象、`event_key` 非空）。
 */
async function seedMessages(store, ownerId, count, label) {
  const ids = [];
  for (let index = 0; index < count; index += 1) {
    const id = randomUUID();
    const inserted = await store.insertMessage({
      id,
      revision: 1,
      owner_id: ownerId,
      type: 'like',
      target_ref: { type: 'post', id: `post-${label}-${index}`, revision: 1 },
      read_at: null,
      created_at: new Date(Date.now() - index * 60_000).toISOString(),
      event_key: `${label}:${index}:${randomUUID()}`,
    });
    assert.equal(inserted, 'inserted', `造数失败：消息行 ${id} 没有被写入（${inserted}）`);
    ids.push(id);
  }
  return ids;
}

/**
 * 造共享台账行：`scope` 与 `key_hash` 都用产品自己的 `idempotencyScope` / `idempotencyKeyHashHex`
 * 拼（`<主体 uuid>\n<METHOD>\n<路径>`），不手写字符串模板——否则本片就在自证自己编的格式。
 */
async function seedLedger(client, entries) {
  for (const entry of entries) {
    const scope = idempotencyScope(entry.subject, entry.method, entry.routePath);
    const keyHashHex = idempotencyKeyHashHex(scope, entry.key);
    await client.query(
      `INSERT INTO public.idempotency_keys (scope, key_hash, request_hash, response_status, expires_at)
            VALUES ($1, decode($2, 'hex'), $3, 200, now() + interval '10 minutes')`,
      [scope, keyHashHex, randomBytes(32).toString('hex')],
    );
  }
}

/** 运行时角色的授权实测（本片的关键一条：生产身份能不能删这两张表）。 */
const privilegeOfRuntime = async () =>
  (
    await pool.query(
      `SELECT current_user AS role,
              has_table_privilege(current_user, 'public.messages', 'DELETE') AS messages_delete,
              has_table_privilege(current_user, 'public.idempotency_keys', 'DELETE') AS ledger_delete,
              has_table_privilege(current_user, 'public.users', 'DELETE') AS users_delete`,
    )
  ).rows[0];

/** 部署脚本里的具名区域（`-- #region <name>` … `-- #endregion <name>`），并拒绝 psql 元命令。 */
function deployRegion(name) {
  const matched = deploySqlFile('20-login-roles.sql').match(
    new RegExp(`-- #region ${name}\\r?\\n([\\s\\S]*?)\\r?\\n\\s*-- #endregion ${name}`),
  );
  assert.ok(matched !== null, `20-login-roles.sql 必须含 ${name} 区域`);
  const region = matched[1];
  assert.equal(/\\(echo|set|pset|if|endif|getenv|gexec)/.test(region), false, `${name} 区域不得含 psql 元命令`);
  return region;
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

  // ---- [0] 全链迁移：本片要的是 0001（users）/ 0008（共享台账）/ 0019（messages）三张真实表 ----
  const discovered = readdirSync(migrationsDir)
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  for (const name of discovered) await owner.query(readFileSync(new URL(name, migrationsDir), 'utf8'));
  const tables = (
    await owner.query(
      `SELECT to_regclass('public.users') AS users,
              to_regclass('public.messages') AS messages,
              to_regclass('public.idempotency_keys') AS ledger`,
    )
  ).rows[0];
  assert.equal(tables.users, 'users', '迁移后 public.users 必须存在（messages.owner_id 的外键目标）');
  assert.equal(tables.messages, 'messages', '迁移后 public.messages 必须存在（本片要证的域）');
  assert.equal(tables.ledger, 'idempotency_keys', '迁移后 public.idempotency_keys 必须存在（共享台账）');
  note(`[0] 全链迁移 ${discovered.length} 个已应用；users / messages / idempotency_keys 三张真实表在岗`);

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
  await owner.query(deployRegion('gy-r28-runtime-domain-grants'));

  pool = new pg.Pool({ connectionString: `postgresql://${RUNTIME_ROLE}:${password}@127.0.0.1:${port}/${DB_NAME}`, max: 6 });
  const privilege = await privilegeOfRuntime();
  assert.equal(privilege.role, RUNTIME_ROLE, '清理必须在**运行时角色**上跑（不是库属主）');
  assert.equal(privilege.messages_delete, true, '运行时角色必须能 DELETE public.messages（表级，20-login-roles.sql:454）');
  assert.equal(privilege.ledger_delete, true, '运行时角色必须能 DELETE public.idempotency_keys（经 gengyun_auth_privacy:33）');
  assert.equal(privilege.users_delete, false, '运行时角色不得能 DELETE public.users（消息行若被级联带走，本片就白测了）');
  say(
    '角色/授权：清理身份 = gengyun_api_runtime；messages DELETE = true（表级）、idempotency_keys DELETE = true'
      + '（域组角色）、users DELETE = false',
  );

  // ---- [2] 造数：三主体（A=被注销、B=他人、C=负控制），各若干消息行 + 各若干台账行 ----
  const messagesStore = createPostgresMessagesStore({ pool });
  const subjectA = randomUUID();
  const subjectB = randomUUID();
  const subjectC = randomUUID();
  for (const id of [subjectA, subjectB, subjectC]) {
    await owner.query('INSERT INTO public.users (id) VALUES ($1::uuid)', [id]);
  }

  const messagesA = await seedMessages(messagesStore, subjectA, 3, 'a');
  const messagesB = await seedMessages(messagesStore, subjectB, 2, 'b');
  const messagesC = await seedMessages(messagesStore, subjectC, 2, 'c');
  note(`[2] 消息行：A ${messagesA.length} / B ${messagesB.length} / C ${messagesC.length}（经真实 insertMessage 落库）`);

  // 台账：A/B/C 各有**消息域**行；A 与 B 另各有一条**其它域**（auth 登录/登出）行，
  // 用来把 `purgeOwnerData` 的跨域副作用（`messages/store-pg.ts:213-215` 显式知情的决策）如实量出来。
  const ledgerA = [
    { subject: subjectA, method: 'POST', routePath: '/messages', key: `a-post-${randomUUID()}` },
    { subject: subjectA, method: 'PUT', routePath: '/messages/{id}/read', key: `a-read-${randomUUID()}` },
    { subject: subjectA, method: 'POST', routePath: '/auth/logout', key: `a-logout-${randomUUID()}` },
  ];
  const ledgerB = [
    { subject: subjectB, method: 'POST', routePath: '/messages', key: `b-post-${randomUUID()}` },
    { subject: subjectB, method: 'PUT', routePath: '/messages/{id}/read', key: `b-read-${randomUUID()}` },
    { subject: subjectB, method: 'POST', routePath: '/auth/logout', key: `b-logout-${randomUUID()}` },
  ];
  const ledgerC = [
    { subject: subjectC, method: 'POST', routePath: '/messages', key: `c-post-${randomUUID()}` },
    { subject: subjectC, method: 'PUT', routePath: '/messages/{id}/read', key: `c-read-${randomUUID()}` },
  ];
  await seedLedger(pool, [...ledgerA, ...ledgerB, ...ledgerC]);
  note(
    `[2] 台账行：A ${ledgerA.length}（2 条消息域 + 1 条 auth 域）/ B ${ledgerB.length}（同形）/ C ${ledgerC.length}（消息域）`,
  );

  // 基线读数（**清理前**）：三主体的行数都必须非 0 —— 这是负控制的另一半（清理前的真值）。
  const baseline = {
    messagesA: await countOf('SELECT count(*)::int AS v FROM public.messages WHERE owner_id = $1::uuid', [subjectA]),
    messagesB: await countOf('SELECT count(*)::int AS v FROM public.messages WHERE owner_id = $1::uuid', [subjectB]),
    messagesC: await countOf('SELECT count(*)::int AS v FROM public.messages WHERE owner_id = $1::uuid', [subjectC]),
    ledgerA: (await ledgerOf(subjectA)).length,
    ledgerB: (await ledgerOf(subjectB)).length,
    ledgerC: (await ledgerOf(subjectC)).length,
  };
  assert.equal(baseline.messagesA, 3, '清理前 A 必须有 3 条消息行');
  assert.equal(baseline.messagesB, 2, '清理前 B 必须有 2 条消息行');
  assert.equal(baseline.messagesC, 2, '清理前 C 必须有 2 条消息行');
  assert.equal(baseline.ledgerA, 3, '清理前 A 必须有 3 条台账行（2 消息域 + 1 auth 域）');
  assert.equal(baseline.ledgerB, 3, '清理前 B 必须有 3 条台账行');
  assert.equal(baseline.ledgerC, 2, '清理前 C 必须有 2 条台账行');
  const ledgerTotalBefore = await countOf('SELECT count(*)::int AS v FROM public.idempotency_keys');
  assert.equal(ledgerTotalBefore, 8, '共享台账清理前必须共 8 行（A3 + B3 + C2）');
  const ledgerBBefore = await ledgerOf(subjectB);
  const ledgerCBefore = await ledgerOf(subjectC);
  say(
    `负控制基准（清理前）：A 消息 ${baseline.messagesA} 行 / 台账 ${baseline.ledgerA} 行；`
      + `B 消息 ${baseline.messagesB} 行 / 台账 ${baseline.ledgerB} 行；C 消息 ${baseline.messagesC} 行 / 台账 ${baseline.ledgerC} 行；`
      + `共享台账合计 ${ledgerTotalBefore} 行`,
  );

  // ---- [3] 跑注销清理：走**真实协调器** → 真实 `purgeOwnerData`（运行时角色）----
  const deletion = createUserDataDeletion({
    favoritesStore: createMemoryFavoritesStore(),
    historyStore: createMemoryHistoryStore(),
    messagesStore,
    conversationsStore: createMemoryConversationStore(),
  });
  const requiredModules = deletion.requiredModules();
  assert.ok(requiredModules.includes('messages'), '必需模块闭集必须含 messages');
  note(`[3] 注销闭集：${requiredModules.join(' / ')}（收藏/历史/会话语料在本片为空内存实现，只有 messages 接真库）`);

  const requestA = deletion.requestDeletionFor(subjectA);
  await deletion.executeHandlers(requestA.id);
  const evidenceA = deletion.evidenceOf(requestA.id);
  const evidenceMessages = String(evidenceA['messages'] ?? '');
  note(`[3] messages 证据串逐字：${evidenceMessages}`);

  const messageMatch = evidenceMessages.match(/^messages:online-purged:(\d+);messages:idempotency-purged:(\d+)$/);
  assert.ok(
    messageMatch !== null,
    `证据串必须是 messages:online-purged:N;messages:idempotency-purged:M（现场 ${JSON.stringify(evidenceMessages)}）`,
  );
  assert.equal(
    Number(messageMatch[1]),
    baseline.messagesA,
    `online-purged 计数必须等于清理前 A 的真实消息行数（${baseline.messagesA}）`,
  );
  assert.equal(
    Number(messageMatch[2]),
    baseline.ledgerA,
    `idempotency-purged 计数必须等于清理前 A 在共享台账里的真实行数（${baseline.ledgerA}，含 1 条 auth 域的跨域行）`,
  );
  say(
    `证据串：messages:online-purged:${messageMatch[1]};messages:idempotency-purged:${messageMatch[2]}`
      + `（计数取自 DELETE … RETURNING 的实际行数，且逐项等于清理前读数）`,
  );

  // ---- [4] 断言一：本主体消息 0 行（硬删）；他人消息原样 ----
  const afterA = await countOf('SELECT count(*)::int AS v FROM public.messages WHERE owner_id = $1::uuid', [subjectA]);
  assert.equal(afterA, 0, '注销清理后本主体 messages 必须 0 行');
  const columns = (
    await owner.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'messages' ORDER BY ordinal_position`,
    )
  ).rows.map((row) => row.column_name);
  assert.equal(columns.length, 8, 'messages 仍必须是 8 列（契约闭集）');
  assert.deepEqual(
    columns.filter((name) => /^(deleted_at|deleted|is_deleted|state|status)$/.test(name)),
    [],
    'messages 不得有软删列 ⇒ 「0 行」只能是硬删，不可能是打了个标记',
  );
  const messagesBAfter = await messageIdsOf(subjectB);
  assert.deepEqual(messagesBAfter, [...messagesB].sort(), '他人（B）的消息行必须**原样**（id 逐一相同）');
  const messagesCAfter = await messageIdsOf(subjectC);
  assert.deepEqual(messagesCAfter, [...messagesC].sort(), '负控制主体（C）的消息行必须**原样**');
  assert.equal(
    await countOf('SELECT count(*)::int AS v FROM public.users WHERE id = $1::uuid', [subjectA]),
    1,
    'A 的 users 行必须还在 —— 否则消息行可能是被 users 的 ON DELETE CASCADE 带走的（那就不是本片要证的 DELETE）',
  );
  say(
    '① 本主体 messages 注销后 = 0 行（表仍是 8 列、无软删列 ⇒ 硬删；A 的 users 行仍在 ⇒ 不是外键级联的副作用）；'
      + `他人 B = ${messagesBAfter.length} 行、负控制 C = ${messagesCAfter.length} 行，id 逐一原样`,
  );

  // ---- [5] 断言二：共享台账按 scope 前缀删到 0；他人台账原样（没被整表清空）----
  const ledgerAAfter = await ledgerOf(subjectA);
  assert.deepEqual(ledgerAAfter, [], '本主体（A）在共享台账里的行必须按 scope 前缀删到 0');
  const ledgerBAfter = await ledgerOf(subjectB);
  assert.deepEqual(ledgerBAfter, ledgerBBefore, '他人（B）的台账行必须逐字原样（scope 与 key_hash 都不许变）');
  const ledgerCAfter = await ledgerOf(subjectC);
  assert.deepEqual(ledgerCAfter, ledgerCBefore, '负控制主体（C）的台账行必须逐字原样');
  const ledgerTotalAfter = await countOf('SELECT count(*)::int AS v FROM public.idempotency_keys');
  assert.equal(ledgerTotalAfter, ledgerTotalBefore - baseline.ledgerA, '共享台账只许少掉本主体那几行，不许整表清空');
  assert.equal(ledgerTotalAfter, 5, '清理后共享台账必须还剩 5 行（B3 + C2）');
  say(
    `② 共享台账：本主体 A 前缀命中 = ${ledgerAAfter.length} 行（原 ${baseline.ledgerA} 行，含 1 条 auth 域跨域行）；`
      + `他人 B = ${ledgerBAfter.length} 行原样、C = ${ledgerCAfter.length} 行原样；整表 ${ledgerTotalBefore} → ${ledgerTotalAfter} 行（不是整表清空）`,
  );

  // ---- [6] 负控制：不跑清理只读 ⇒ 行数非 0（上面的 0 行不是恒真断言）----
  const control = {
    messagesC: await countOf('SELECT count(*)::int AS v FROM public.messages WHERE owner_id = $1::uuid', [subjectC]),
    ledgerC: (await ledgerOf(subjectC)).length,
    ledgerTotalAfter,
  };
  assert.equal(control.messagesC, 2, '负控制：没跑清理的 C 消息行必须仍是非 0');
  assert.equal(control.ledgerC, 2, '负控制：没跑清理的 C 台账行必须仍是非 0');
  assert.ok(control.ledgerTotalAfter > 0, '负控制：共享台账不许被整表清空（清理后合计必须仍 > 0）');
  say(
    `③ 负控制读数（同一库、同一连接、只读）：未清理主体 C 消息 ${control.messagesC} 行、台账 ${control.ledgerC} 行，`
      + `共享台账剩余 ${control.ledgerTotalAfter} 行 ⇒ 断言不是恒真`,
  );

  // ---- [7] 重放幂等：对同一主体再跑一次 ⇒ 两个计数都是 0（计数真的来自 RETURNING）----
  const requestA2 = deletion.requestDeletionFor(subjectA);
  await deletion.executeHandlers(requestA2.id);
  const evidenceA2 = String(deletion.evidenceOf(requestA2.id)['messages'] ?? '');
  assert.equal(
    evidenceA2,
    'messages:online-purged:0;messages:idempotency-purged:0',
    `第二次注销清理必须两个计数都为 0（现场 ${JSON.stringify(evidenceA2)}）`,
  );
  assert.deepEqual(await messageIdsOf(subjectB), [...messagesB].sort(), '重放不得碰到他人消息行');
  assert.deepEqual(await ledgerOf(subjectB), ledgerBBefore, '重放不得碰到他人台账行');
  say('重放幂等：同一主体第二次注销清理 = messages:online-purged:0;messages:idempotency-purged:0；他人两表原样');

  // ---- [8] 回执形状：messages 在线清除 completed、备份态 pending（未接线端口不谎称完成）----
  const receiptA = deletion.receipt(requestA.id);
  const handlerMessages = receiptA.handlers.find((row) => row.module === 'messages');
  assert.ok(handlerMessages !== undefined, '回执必须含 messages 处理器行');
  assert.equal(handlerMessages.online_state, 'completed', 'messages 在线清除必须 completed');
  assert.equal(handlerMessages.backup_state, 'pending', '备份态在本片未接线 ⇒ 只能是 pending（不谎称完成）');
  assert.equal(deletion.completionStatus(requestA.id).completed, false, '备份态 pending ⇒ 整笔未完成（如实）');
  say('回执：messages.online_state = completed（证据串即上面的行数）；backup_state = pending（本片未接备份端口，不谎称完成）');

  console.log(`\nALL PASS：${passed} 条真库断言（exit code 0）`);
  console.log(`EXITCODE=0`);
} finally {
  await pool?.end().catch(() => {});
  await owner?.end().catch(() => {});
  stopCluster();
}
