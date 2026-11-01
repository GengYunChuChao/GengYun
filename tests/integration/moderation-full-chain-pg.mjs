/**
 * GY-I14（#14）片 C · 版本重审 + 失败隔离 + 下架缓存失效 · **真库臂整线联调**。
 *
 * ## 为什么需要这一条（既有脚本的分工，逐条点名）
 *   - `tests/moderation/*.test.mjs` 与 `tests/unit/community-moderation-*.test.mjs` 用**内存 store** 证明过
 *     版本重审（`publish-revision-guard` / `community-moderation-revision-guard`）、失败隔离
 *     （`isolation` / `fail-closed` / `community-gate` 反例）与下架缓存失效
 *     （`community-moderation-takedown`）的**语义**；但内存 store 的 CAS/唯一键/落库都不是真 PG。
 *   - `tests/integration/community-pg.mjs` 只发过 `POST /api/v1/posts` 建帖，**没有**编辑（PATCH）、
 *     没有后台下架（`POST /admin/posts/{id}/hide`）、没有审核域读缓存（`moderation.readView`）的
 *     真库读数；`admin-community-posts-pg.mjs` 是 **real 装配**（审核域整域 fail-closed，不做联动），
 *     只证存储/路由/审计链，不证"合成端口 + 真库"下的**审核联动**。
 *   - 本脚本补的正是这一块：**合成模型端口（`provider.synthetic === true`）+ 真 PG** 跑
 *     `post → edit → review → takedown` 全链，用真库证明三态：
 *       1. 旧版本结论不套新版本（编辑后必须重审）——编辑产生新 revision，旧结论按 revision 定位失效，
 *          新 revision 必须重新送审并写**独立的**结论行；
 *       2. 超时 / 结构错误不发布（隔离）——规则层超时（`RULE_TIMEOUT`）或整体抛错
 *          （`RULE_ENGINE_ERROR`）⇒ 一律 `quarantined`，HTTP 422，**不落内容行**；
 *       3. 下架驱动缓存失效——后台 `hidePost` 生效后驱动审核域 `withdraw`：读缓存**整链失效**
 *          （该目标全部 revision 的缓存键清零）、`moderation_withdrawals` 落库（withdrawn 标记持久化）。
 *
 * ## 本脚本只调用既有代码，不改产品行为
 *   - 装配走真实 `buildApp`（`stub` + 真 pool + 合成端口 + 合成 gate）；社区 store 是
 *     `createPostgresCommunityStore`（`persistent === true`），审核台账是
 *     `createPostgresModerationLedger`（迁移 0028 落库）。
 *   - 合成模型端口 `provider.synthetic === true`（不联网、无凭据）——**不是**真实 `tms`/`ims` 证据。
 *
 * ## 未取得（如实登记）
 *   - 真实审核供应商（全程注入仓内合成端口，不联网）、真实媒体、下架后的真实 UI。
 *
 * ## 运行（自起一次性 PG 17 集群，仅回环；**空库**由 `CREATE DATABASE` 保证）
 *   $env:GY_PG_BIN = 'E:\GengYunCommander\.pg17\pgsql\bin'   # 必填：含 initdb/pg_ctl 的目录
 *   node tests/integration/moderation-full-chain-pg.mjs
 * 未设置 `GY_PG_BIN`（或目录里没有 initdb/pg_ctl）⇒ 打印 SKIP 并以 **77** 退出（未取得，不是通过；
 * 不提供 --allow-skip —— 缺 PG 二进制就如实跳过，不伪造 PASS）。
 * 可选 `GY_I14C_PG_ROOT`：临时集群数据目录的父目录（默认 `os.tmpdir()`）。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import pg from 'pg';

import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createPool } from '../../services/api/src/db/pool.ts';
import { applyMigrations, discoverMigrations } from '../../services/api/src/db/migrate.ts';
import { createPostgresCommunityStore } from '../../services/api/src/community/store-pg.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken, mintOpaqueToken } from '../../services/api/src/auth/tokens.ts';
import {
  CLEAN_BODY,
  CLEAN_BODY_NO_HIT,
  CLEAN_TITLE,
  CLEAN_TITLE_NO_HIT,
  FROZEN_CLOCK,
  makeGate,
  makeSyntheticPassPort,
  scriptedClock,
} from '../unit/community-fixtures.mjs';
import { createPublicPostingConsent } from '../unit/community-posting-consent-fixtures.mjs';
import { pickFreePort } from './lib/free-port.mjs';

const API = '/api/v1';
const DB_NAME = 'gengyun_moderation_chain_test';
/** 后台下架 scope（契约 `OPS_SCOPES.hidePost`）。 */
const HIDE_SCOPE = 'sources:write';
/**
 * 本脚本只 apply 它**真正依赖**的迁移（⛔ 不是 `discoverMigrations()` 全链）：
 *   0001 身份底座（`users`、`job_state`/`visibility`/`audit_state` 枚举）；
 *   0022 社区六表（含 `community_moderation_decisions`，读面 `effectiveState()` 每次都要它）；
 *   0028 审核判定台账（`moderation_decisions` + `moderation_withdrawals`——审核域台账落库）；
 *   0030 帖/评行级作者注销引用（`POST_COLUMNS` 含 `anonymized_author_ref`）；
 *   0032 举报者行内注销引用（与 0030 同口径）；0045 审核台账 `community_moderation_decisions.decided_by`（人工 approve/reject 的运营者快照列，台账 INSERT/SELECT 都写读它，缺它 ⇒ 42703 ⇒ 社区域 503）；
 *   0017 `public.admin_audit_events` + 0047 下架审计函数（`record_admin_post_hide_audit`）：
 *     第 3 段的 `hidePost` 现在把 `post.hide` 审计与可见性变更写在**同一事务**里，
 *     缺 0047 ⇒ 下架 fail-closed 成 503（这是运行时依赖，不是可选装饰）。
 */
const MIGRATIONS = ['0001', '0017', '0022', '0028', '0030', '0032', '0045', '0047'];

// ---------------------------------------------------------------------------
// GY_PG_BIN 闸门（含 initdb/pg_ctl 的目录）；缺 ⇒ SKIP + 77
// ---------------------------------------------------------------------------
const binDir = (process.env.GY_PG_BIN ?? '').trim();
const tool = (name) => join(binDir, process.platform === 'win32' ? `${name}.exe` : name);
if (binDir === '' || !existsSync(tool('initdb')) || !existsSync(tool('pg_ctl'))) {
  console.log(
    'SKIP: 未设置 GY_PG_BIN（含 initdb/pg_ctl 的目录）⇒ 真库臂跳过，'
      + '没有验证「版本重审 / 失败隔离 / 下架缓存失效」三态整线联调（未取得，不是通过）。',
  );
  console.log('EXITCODE=77 表示未取得，不是通过（POSIX 惯例 skipped；本脚本不提供 --allow-skip）。');
  process.exit(77);
}

const rootDir = process.env.GY_I14C_PG_ROOT ?? tmpdir();
const dataDir = join(rootDir, `gy-i14c-moderation-chain-${randomBytes(4).toString('hex')}`);
const serverLog = join(rootDir, `gy-i14c-moderation-chain-client-${randomBytes(4).toString('hex')}.log`);
let port = 0;
let adminBase = '';
let targetUrl = '';

let passed = 0;
const say = (label) => {
  passed += 1;
  console.log(`PASS ${passed}: ${label}`);
};
const note = (line) => console.log(`  · ${line}`);

const digest = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const postText = (title, body) => `${title}\n${body}`;

/** 子进程输出去**文件**：本机 sandbox 禁命名管道，用管道收集会等到超时。 */
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

function serverOptions() {
  const options = [`-p ${port}`, '-c listen_addresses=127.0.0.1', '-c max_connections=32'];
  if (process.platform !== 'win32') options.push(`-k ${dataDir}`);
  return options.join(' ');
}

function tailOfFile(file, maxLines = 15) {
  try {
    return readFileSync(file, 'utf8').replace(/\s+$/, '').split('\n').slice(-maxLines).join('\n');
  } catch (error) {
    return `（读不到 ${file}：${error.message}）`;
  }
}

async function startCluster() {
  // 端口向内核要一个此刻空闲的（`lib/free-port.mjs`）：⛔ 原来 `55600 + Math.random()*400`
  // 整段落在 Linux 默认 ephemeral 区间（32768–60999）里，会被出站连接的源端口占住。
  port = await pickFreePort();
  adminBase = `postgresql://postgres@127.0.0.1:${port}`;
  targetUrl = `${adminBase}/${DB_NAME}`;
  mkdirSync(dataDir, { recursive: true });
  const init = runTool('initdb', ['-D', dataDir, '--no-sync', '--encoding=UTF8', '--locale=C', '-U', 'postgres', '--auth=trust']);
  assert.equal(init.status, 0, `initdb 失败（status=${init.status}，日志见 ${serverLog}）`);
  const start = runTool('pg_ctl', ['-D', dataDir, '-l', join(dataDir, 'server.log'), '-o', serverOptions(), '-t', '60', '-w', 'start']);
  assert.equal(
    start.status,
    0,
    `pg_ctl start 失败（status=${start.status}；server.log 尾部：\n${tailOfFile(join(dataDir, 'server.log'))}）`,
  );
  note(`临时集群：数据目录 ${dataDir}，端口 ${port}（只监听 127.0.0.1）`);
}

function stopCluster() {
  assert.ok(basename(dataDir).startsWith('gy-i14c-moderation-chain-'), `拒绝删除非本脚本创建的目录：${dataDir}`);
  if (existsSync(join(dataDir, 'PG_VERSION'))) runTool('pg_ctl', ['-D', dataDir, '-m', 'fast', '-w', 'stop']);
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10 });
}

async function connectWithRetry(connectionString, attempts = 60) {
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
let owner = null;
let pool = null;
let app = null;
let timeoutApp = null;
let structErrApp = null;

try {
  await startCluster();
  const admin = await connectWithRetry(`${adminBase}/postgres`);
  await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  await admin.end();

  owner = await connectWithRetry(targetUrl);
  note(`PostgreSQL ${(await owner.query('SHOW server_version')).rows[0].server_version}`);

  // ---- [M] 迁移与装配 ----
  const version = (await owner.query("SELECT current_setting('server_version') AS v")).rows[0].v;
  assert.match(version, /^17\./, `requires PostgreSQL 17，实际 ${version}`);
  const discovered = discoverMigrations();
  const versions = discovered.map((m) => m.version);
  assert.equal(new Set(versions).size, versions.length, `迁移版本号重复：${versions.join(',')}`);
  for (const required of MIGRATIONS) assert.ok(versions.includes(required), `迁移目录必须含 ${required}`);
  const picked = discovered.filter((m) => MIGRATIONS.includes(m.version));
  assert.deepEqual(picked.map((m) => m.version), MIGRATIONS, '本脚本依赖的八段迁移必须按目录序取到');
  assert.deepEqual((await applyMigrations(owner, picked)).applied, MIGRATIONS, '八段迁移必须逐条真正应用');
  assert.equal((await applyMigrations(owner, picked)).applied.length, 0, '重跑迁移必须是 no-op');
  say(`[M] PG ${version} · 迁移子集 ${MIGRATIONS.join('+')} 逐条 apply、二连跑 0 条（目录共 ${versions.length} 个迁移，版本号无重复）`);

  pool = createPool(targetUrl);
  const communityStore = createPostgresCommunityStore({ pool });
  assert.equal(communityStore.persistent, true, 'PG 社区 store 必须自述持久化');

  // ---- 夹具：用户 A / 后台管理员 ----
  const auth = createMemoryAuthStore();
  const createUser = async (tag) => {
    const user = await auth.createUser(tag.repeat(64));
    const token = mintOpaqueToken();
    await auth.createSession({
      userId: user.id,
      tokenHashHex: hashToken(token),
      authEpoch: user.authEpoch,
      expiresAt: new Date(Date.now() + 48 * 3600_000),
      audience: 'user',
    });
    await owner.query('INSERT INTO users (id) VALUES ($1::uuid)', [user.id]);
    return { user, token };
  };
  const author = await createUser('c');

  const createAdmin = async (loginName, scopes) => {
    const userId = await auth.createAdmin({ loginName, credentialHash: 'synthetic-not-a-real-credential-hash', scopes });
    const token = mintOpaqueToken();
    await auth.createSession({
      userId,
      tokenHashHex: hashToken(token),
      authEpoch: 1,
      expiresAt: new Date(Date.now() + 3600_000),
      audience: 'admin',
    });
    // 0047（以及 0043 这类同规的窄口径 definer）复核的是**库内**身份与有效 scope：
    // 内存 auth store 里的这位 admin 必须在 `admin_accounts` / `admin_scopes` 里有同 id 的镜像行，
    // 否则下架会被审计侧以 G0002/G0010 拒写（503）—— 那是 fail-closed 生效，不是本脚本要的路径。
    await owner.query(
      'INSERT INTO admin_accounts (id, login_name, credential_hash) VALUES ($1::uuid, $2, $3)',
      [userId, loginName, 'synthetic-not-a-real-credential-hash'],
    );
    for (const scope of scopes) {
      await owner.query(
        'INSERT INTO admin_scopes (admin_id, scope) VALUES ($1::uuid, $2)',
        [userId, scope],
      );
    }
    return { userId, token };
  };
  const hideAdmin = await createAdmin('synthetic-i14c-hide-admin', [HIDE_SCOPE]);

  // ---- 投稿面 `public_posting` 授权（真实 grant） ----
  const publicPosting = createPublicPostingConsent();
  await publicPosting.grant(author.user.id);

  // ---- 真实装配：stub + 真 pool + 合成端口 + 合成 gate ----
  const baseConfig = loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' });
  const buildWithGate = (gate) => buildApp({
    config: baseConfig,
    store: auth,
    pool,
    now: () => new Date(),
    privacyInjection: { consent: publicPosting.gate },
    communityInjection: { gate },
    // 合成端口 provider.synthetic === true（不联网）；规则层冻结时钟（内容判定与墙钟无关）。
    moderationInjection: { ports: { tms: makeSyntheticPassPort('tms') }, ruleOptions: { clock: FROZEN_CLOCK } },
  });
  app = buildWithGate(makeGate());
  assert.notEqual(app.communityService, null, 'stub + 真 pool ⇒ 社区服务必须开启');
  assert.notEqual(app.moderationService, null, 'stub + 合成端口 ⇒ 审核域必须开启');
  assert.ok(app.communityModerationLink !== null, '审核域联动端口必须已接线');
  assert.equal(app.moderationService.counts().authority_origin, 'community_store', '审核域权威必须同源社区 store');

  const call = async (token, method, path, extra = {}) => {
    const response = await app.inject({
      method,
      url: path,
      headers: {
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...(extra.payload === undefined ? {} : { 'content-type': 'application/json' }),
        ...(extra.headers ?? {}),
      },
      ...(extra.payload === undefined ? {} : { payload: extra.payload }),
    });
    let body = null;
    try { body = response.json(); } catch { body = null; }
    return { status: response.statusCode, headers: response.headers, body, text: response.body };
  };

  const postBody = (title, body) => ({ title, body, media_ids: [] });
  const verdictRow = async (id, revision) => (await owner.query(
    `SELECT decision, rule_version, text_digest, target_revision
       FROM community_moderation_decisions
      WHERE target_type = 'post' AND target_id = $1::uuid AND target_revision = $2`,
    [id, revision],
  )).rows[0] ?? null;
  const moderationTaskRows = async (id) => (await owner.query(
    `SELECT target_revision, decision, superseded FROM public.moderation_decisions
      WHERE target_type = 'post' AND target_id = $1 ORDER BY target_revision`,
    [id],
  )).rows;

  // =========================================================================
  // [1] 旧版本结论不套新版本（编辑后必须重审）
  // =========================================================================
  const created = await call(author.token, 'POST', `${API}/posts`, {
    payload: postBody(CLEAN_TITLE, CLEAN_BODY),
    headers: { 'idempotency-key': 'i14c-post-1' },
  });
  assert.equal(created.status, 201, `POST /posts ⇒ ${created.status} ${created.text.slice(0, 300)}`);
  const postId = created.body.data.id;
  assert.equal(created.body.data.revision, 1);
  assert.equal(created.body.data.visibility, 'published');

  // 建帖后：审核域**版本级任务**（moderation_decisions）与社区结论（community_moderation_decisions）各一行。
  const rev1Verdict = await verdictRow(postId, 1);
  assert.equal(rev1Verdict.decision, 'approved', 'rev1 社区结论必须 approved');
  assert.equal(rev1Verdict.text_digest, digest(postText(CLEAN_TITLE, CLEAN_BODY)), 'rev1 结论必须绑定 rev1 正文摘要');
  const tasksAtRev1 = await moderationTaskRows(postId);
  assert.equal(tasksAtRev1.length, 1, 'rev1 审核域必须恰好一条版本级任务');
  assert.equal(tasksAtRev1[0].target_revision, 1);
  say('[1] 建帖 ⇒ rev1 published；社区结论 + 审核域版本级任务各一条，摘要绑定 rev1 正文');

  // 编辑 ⇒ 新 revision：旧结论必须按 revision 失效，新 revision 重新送审。
  const edited = await call(author.token, 'PATCH', `${API}/posts/${postId}`, {
    payload: postBody(CLEAN_TITLE_NO_HIT, CLEAN_BODY_NO_HIT),
    headers: { 'idempotency-key': 'i14c-edit-1', 'if-match': '"1"' },
  });
  assert.equal(edited.status, 200, `PATCH /posts/{id} ⇒ ${edited.status} ${edited.text.slice(0, 300)}`);
  assert.equal(edited.body.data.revision, 2);

  const rev2Verdict = await verdictRow(postId, 2);
  const rev1After = await verdictRow(postId, 1);
  assert.equal(rev1After.text_digest, digest(postText(CLEAN_TITLE, CLEAN_BODY)), 'rev1 结论保持绑定 rev1 正文（不被覆盖）');
  assert.equal(rev2Verdict.decision, 'approved', 'rev2 社区结论必须 approved（重新送审后放行）');
  assert.equal(rev2Verdict.text_digest, digest(postText(CLEAN_TITLE_NO_HIT, CLEAN_BODY_NO_HIT)), 'rev2 结论必须绑定 rev2 新正文摘要');
  assert.notEqual(rev2Verdict.text_digest, rev1After.text_digest, 'rev2 结论摘要必须不同于 rev1（旧结论未套用）');
  const tasksAfterEdit = await moderationTaskRows(postId);
  assert.equal(tasksAfterEdit.length, 2, '编辑后审核域必须两条版本级任务（rev1 + rev2）');
  assert.deepEqual(tasksAfterEdit.map((r) => r.target_revision), [1, 2], '两条任务按 revision 定位');
  assert.equal(tasksAfterEdit.every((r) => r.superseded === false), true, 'rev1/rev2 是不同目标键，都应是现任（不互相 superseded）');
  say('[1] 编辑 ⇒ rev2；社区结论 rev1/rev2 各绑定各自正文摘要、审核域两条版本级任务（rev1+rev2），旧结论不套新版本');

  // =========================================================================
  // [2] 超时 / 结构错误不发布（隔离）
  // =========================================================================
  // 超时：脚本化时钟 [0, 1000] + 极小预算 ⇒ 规则层 RULE_TIMEOUT ⇒ quarantined。
  timeoutApp = buildWithGate(makeGate({ clock: scriptedClock([0, 1000]), budget_ms: 50 }));
  const timeoutPost = await timeoutApp.inject({
    method: 'POST',
    url: `${API}/posts`,
    headers: { authorization: `Bearer ${author.token}`, 'content-type': 'application/json', 'idempotency-key': 'i14c-timeout-1' },
    payload: postBody(CLEAN_TITLE, CLEAN_BODY),
  });
  assert.equal(timeoutPost.statusCode, 422, `超时投稿必须 422，实际 ${timeoutPost.statusCode}`);
  assert.equal(timeoutPost.json().error.code, 'INPUT_UNCERTAIN');
  assert.ok(
    timeoutPost.json().error.details.some((d) => d.code === 'RULE_TIMEOUT'),
    `超时投稿 reasons 必须含 RULE_TIMEOUT，实际 ${JSON.stringify(timeoutPost.json().error.details)}`,
  );

  // 结构错误：匹配器查表即炸 ⇒ 规则层整体抛错 ⇒ RULE_ENGINE_ERROR ⇒ quarantined。
  structErrApp = buildWithGate(makeGate({
    matchers: new Proxy({}, { get() { throw new Error('boom: matcher lookup'); } }),
  }));
  const structErrPost = await structErrApp.inject({
    method: 'POST',
    url: `${API}/posts`,
    headers: { authorization: `Bearer ${author.token}`, 'content-type': 'application/json', 'idempotency-key': 'i14c-structerr-1' },
    payload: postBody(CLEAN_TITLE, CLEAN_BODY),
  });
  assert.equal(structErrPost.statusCode, 422, `结构错误投稿必须 422，实际 ${structErrPost.statusCode}`);
  assert.equal(structErrPost.json().error.code, 'INPUT_UNCERTAIN');
  assert.ok(
    structErrPost.json().error.details.some((d) => d.code === 'RULE_ENGINE_ERROR'),
    `结构错误投稿 reasons 必须含 RULE_ENGINE_ERROR，实际 ${JSON.stringify(structErrPost.json().error.details)}`,
  );

  // 隔离的核心判据：两条被拒路径都**没有**把内容行落库（fail-closed，不是"改了行但拒绝"）。
  const postCount = (await owner.query('SELECT count(*)::int AS n FROM community_posts')).rows[0].n;
  assert.equal(postCount, 1, '超时/结构错误投稿不得落内容行（全表仍只有建帖那 1 行）');
  say('[2] 超时（RULE_TIMEOUT）与结构错误（RULE_ENGINE_ERROR）⇒ 422 INPUT_UNCERTAIN，内容行零落库（隔离）');

  // =========================================================================
  // [3] 下架驱动缓存失效
  // =========================================================================
  // 先让审核域**真的**把该版本读进缓存（否则"失效 0 键"是无意义断言）。
  // 说明：建帖/编辑两次 `publish` 已经把 rev1、rev2 两个键都写进审核域读缓存；
  // 本断言据此锁定"下架必须**恰好**失效被下架的那一版（rev2）"这一条精确口径。
  const moderationAdmin = { userId: hideAdmin.userId, role: 'admin', authEpoch: 1 };
  const beforeView = await app.moderationService.readView({
    actor: moderationAdmin,
    target_ref: { type: 'post', id: postId, revision: 2 },
  });
  assert.equal(beforeView.visible, true, '前提：下架前审核域读取面可见');
  const cacheBefore = app.moderationService.counts().cache_entries;
  assert.ok(cacheBefore >= 1, `前提：审核域读缓存非空（实际 ${cacheBefore}）`);

  const hidden = await call(hideAdmin.token, 'POST', `${API}/admin/posts/${postId}/hide`, {
    payload: { reason: '结构性文本：管理员下架违规社区帖（本脚本不评估理由内容）' },
    headers: { 'idempotency-key': 'i14c-hide-1', 'if-match': '"2"' },
  });
  assert.equal(hidden.status, 200, `POST /admin/posts/{id}/hide ⇒ ${hidden.status} ${hidden.text.slice(0, 300)}`);
  assert.deepEqual(hidden.body.data, { accepted: true });

  // 缓存失效 + withdrawn 标记：下架按 `invalidateTarget` 的既有口径**整链失效**
  // （清掉该目标**全部 revision** 的缓存键，不是只删被处置那一版），台账 withdrawn 计数、
  // 下架标记落库（持久化，不是只进内存）。
  const cacheAfter = app.moderationService.counts().cache_entries;
  assert.equal(cacheAfter, 0, `下架必须让审核域读缓存整链失效（${cacheBefore} → 0）`);
  assert.equal(app.moderationService.counts().withdrawn, 1, '审核域台账必须记 withdrawn');
  const withdrawalRows = (await owner.query(
    `SELECT count(*)::int AS n FROM public.moderation_withdrawals
      WHERE target_type = 'post' AND target_id = $1 AND target_revision = 2`,
    [postId],
  )).rows[0].n;
  assert.equal(withdrawalRows, 1, '下架标记必须落到 moderation_withdrawals（处置前 revision=2）');

  // 社区真实内容行：hidden + revision 推进（权威写入在社区 CAS）。
  const rowAfterHide = (await owner.query(
    `SELECT visibility::text AS visibility, revision FROM community_posts WHERE id = $1::uuid`,
    [postId],
  )).rows[0];
  assert.equal(rowAfterHide.visibility, 'hidden', '真库行 visibility 必须 hidden');
  assert.equal(rowAfterHide.revision, 3, '后台隐藏推进 revision（2 → 3）');

  // 下架后读取面：不可见 + 不再因缓存复活。
  const afterView = await app.moderationService.readView({
    actor: moderationAdmin,
    target_ref: { type: 'post', id: postId, revision: 2 },
  });
  assert.equal(afterView.visible, false, '下架后审核域读取面必须不可见');
  assert.equal(afterView.visibility, 'hidden');
  say(`[3] 后台 hidePost 生效 ⇒ 审核域读缓存整链失效（${cacheBefore} → 0）、withdrawn 落库（moderation_withdrawals 处置前版本）、社区行 hidden+rev3、读取面不再复活`);

  // =========================================================================
  // [R] 重启后：库里已下架的目标必须仍被拒绝（W45 · 持久台账回填 ⇒ 闸门才看得见）
  // =========================================================================
  // 现场形状：`[3]` 的 hidePost 已经写下架标记（`moderation_withdrawals` 一行，处置前 rev2），
  // 社区行 visibility=hidden、revision=3。下面在**同一个 pool** 上再 build 一个 app 实例模拟
  // "进程重启"：内存台账为空、只有库里的行——这正是本片缺陷链的窗口（老实例的内存标记随进程消失）。
  // 身份刻意用 **admin**：否则 `service.ts:939` 第一条 disjunct（`visibility === 'hidden'
  // && role !== 'admin'`）会先命中，读数就分不清"台账回填生效"与"权威侧本来就看得见"。
  // 夹具用**函数内动态 import**：本文件被 docs 按行号引用，顶部 import 块一个字都不能动。
  const RESTART_CALLBACK_KEY = 'gy-w45-restart-callback-key';
  /** `[R]` 节只打印、**不推进 `passed`**：`[ALL PASS] … 共 N 组 PASS` 的历史读数要能逐字复现。 */
  const trace = (label) => console.log(label);
  const { callbackEnvelope, captureError, signedCallback, textContent } = await import('../moderation/_http-fixtures.mjs');
  const WITHDRAWN_REVISION = 2;
  const restarted = buildApp({
    config: baseConfig,
    store: auth,
    pool,
    now: () => new Date(),
    privacyInjection: { consent: publicPosting.gate },
    communityInjection: { gate: makeGate() },
    moderationInjection: {
      ports: { tms: makeSyntheticPassPort('tms') },
      ruleOptions: { clock: FROZEN_CLOCK },
      // 回调验签密钥：不给就一律 CALLBACK_SIGNATURE_INVALID（`service.ts:1244`），测不到下游判定。
      callbackKey: RESTART_CALLBACK_KEY,
    },
  });
  try {
    assert.notEqual(restarted.moderationService, null, '重启实例：stub + 合成端口 ⇒ 审核域必须开启');
    const withdrawnBefore = restarted.moderationService.counts().withdrawn;
    assert.equal(withdrawnBefore, 0, `前提：重启实例的内存台账必须先为空（实际 ${withdrawnBefore}）`);

    // R1：重启后的第一个动作就是发布已下架的那一版 ⇒ 必须被闸门拒绝（不是"版本冲突"）。
    const publishError = await captureError(() => restarted.moderationService.publish({
      actor: moderationAdmin,
      content: textContent({
        target_ref: { type: 'post', id: postId, revision: WITHDRAWN_REVISION },
        text: postText(CLEAN_TITLE, CLEAN_BODY),
      }),
    }));
    assert.equal(
      publishError.code,
      'OBJECT_UNAVAILABLE',
      `重启后发布已下架版本必须 OBJECT_UNAVAILABLE，实际 ${publishError.code}：${publishError.message}`,
    );
    assert.deepEqual(
      (publishError.details ?? []).map((d) => d.code),
      ['TARGET_WITHDRAWN'],
      `原因码必须是 TARGET_WITHDRAWN（不是 REVISION_CONFLICT），实际 ${JSON.stringify(publishError.details)}`,
    );
    // 回填确实发生了：拒绝之后内存台账已经看得见库里那行 ⇒ 拒绝来源就是它，不是别的原因。
    const withdrawnAfter = restarted.moderationService.counts().withdrawn;
    assert.equal(withdrawnAfter, 1, `回填后内存台账必须记 1 条 withdrawn（实际 ${withdrawnAfter}）`);
    // 拒绝路径零可见性写入：社区行仍是 hidden + revision 3，没被"翻回 published"。
    const rowAfterRestart = (await owner.query(
      `SELECT visibility::text AS visibility, revision FROM community_posts WHERE id = $1::uuid`,
      [postId],
    )).rows[0];
    assert.equal(rowAfterRestart.visibility, 'hidden', `拒绝路径不得改可见性（实际 ${rowAfterRestart.visibility}）`);
    assert.equal(rowAfterRestart.revision, 3, `拒绝路径不得推进 revision（实际 ${rowAfterRestart.revision}）`);
    trace(`[R1] 重启实例（同 pool、内存台账空 withdrawn=${withdrawnBefore}）⇒ 已下架的 rev${WITHDRAWN_REVISION} publish 被拒 OBJECT_UNAVAILABLE+TARGET_WITHDRAWN；回填后 withdrawn=${withdrawnAfter}，社区行仍 hidden+rev${rowAfterRestart.revision}（拒绝路径零可见性写入）`);

    // R2：迟到回调的**现状表征**（如实登记，不是本片要修的东西）。
    // 库里真实存在的那条 rev2 任务，重启实例内存里没有 ⇒ `service.ts:1260` 的 `byJobId` 返回 null
    // ⇒ CALLBACK_JOB_UNKNOWN。要变成 CALLBACK_TARGET_WITHDRAWN，需要回调侧按 job_id 回填作业结论
    // （迁移 0052），**属另一片**；本片不改判定，只把这个读数钉住，避免后来者误以为已经修好。
    const jobRow = (await owner.query(
      `SELECT job_id FROM public.moderation_decisions
        WHERE target_type = 'post' AND target_id = $1::text AND target_revision = $2
        ORDER BY created_at LIMIT 1`,
      [postId, WITHDRAWN_REVISION],
    )).rows[0];
    assert.ok(jobRow !== undefined, '前提：rev2 的审核域任务必须已落库（否则本读数无意义）');
    const lateCallback = signedCallback(callbackEnvelope({
      event_id: 'evt-w45-restart-1',
      job_id: jobRow.job_id,
      // 必须落在 ±CALLBACK_MAX_SKEW_MS 内，否则先撞 CALLBACK_EXPIRED，测不到"job 未知"这条。
      issued_at: new Date().toISOString(),
      target_ref: { type: 'post', id: postId, revision: WITHDRAWN_REVISION },
    }), RESTART_CALLBACK_KEY);
    const lateOutcome = await restarted.moderationService.ingestCallback(lateCallback);
    assert.equal(lateOutcome.accepted, false, '重启后迟到的合法签名回调不得被接受');
    assert.ok(
      lateOutcome.reason_codes.includes('CALLBACK_JOB_UNKNOWN'),
      `现状表征：原因码必须是 CALLBACK_JOB_UNKNOWN，实际 ${JSON.stringify(lateOutcome.reason_codes)}`,
    );

    trace(`[R2] 迟到合法签名回调（库里真实存在的那条 rev${WITHDRAWN_REVISION} 任务）⇒ accepted=${lateOutcome.accepted} + ${lateOutcome.reason_codes.join(',')}（现状表征：重启后 byJobId 只问内存，service.ts:1288 的 CALLBACK_TARGET_WITHDRAWN 在该窗口不可达；要补需迁移 0052 回填作业结论，属另一片）`);
  } finally {
    await restarted.close().catch(() => {});
  }

  await app.close().catch(() => {});
  app = null;
  await timeoutApp.close().catch(() => {});
  timeoutApp = null;
  await structErrApp.close().catch(() => {});
  structErrApp = null;

  console.log(`[ALL PASS] 真库臂整线联调：post → edit → review → takedown 全链三态读数通过（共 ${passed} 组 PASS）`);
} catch (error) {
  console.error(`FAIL: ${error?.stack ?? error}`);
  console.error(`工具日志：${serverLog}`);
  process.exitCode = 1;
} finally {
  if (app !== null) await app.close().catch(() => {});
  if (timeoutApp !== null) await timeoutApp.close().catch(() => {});
  if (structErrApp !== null) await structErrApp.close().catch(() => {});
  if (pool !== null) await pool.end().catch(() => {});
  if (owner !== null) await owner.end().catch(() => {});
  try {
    stopCluster();
  } catch (error) {
    console.error(`清理临时集群失败：${error?.message ?? error}`);
    process.exitCode = process.exitCode === 0 ? 1 : process.exitCode;
  }
}
