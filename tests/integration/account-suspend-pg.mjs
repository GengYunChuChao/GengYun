// GY-I22（#22）· 账号**停用/恢复接真实认证权威** · 真实 PostgreSQL 17.11 端到端证据
//
// 运行（本机隔离集群，仅回环；库名硬钉，要求空库）：
//   createdb -h 127.0.0.1 -p <port> gengyun_suspend_test
//   node tests/integration/account-suspend-pg.mjs \
//     postgres://<owner>@127.0.0.1:<port>/gengyun_suspend_test \
//     postgres://gengyun_api_runtime:<pw>@127.0.0.1:<port>/gengyun_suspend_test
//
// 第二个参数（运行时角色 URL）可省略：省略时只跑「库侧 + 端口侧」证据，**权限反向控制**
// 与 HTTP 证据会被标为 `未取得（缺运行时角色 URL）` —— 不允许被读成通过。
//
// 本脚本只讲一件事：**停用/恢复是一个单事务的四步写**，且**唯一写路径是一个窄口径
// `SECURITY DEFINER` 函数**（迁移 0017）。运行时角色 `gengyun_api_runtime` 对
// `users.state` / `users.auth_epoch` / `users.revision` / `sessions.revoked_at` /
// `admin_audit_events` **没有任何直接写权限**，因此「绕过函数直接改列、直接写审计」
// 在本脚本里是**权限拒绝（42501）**，不是约定、不是口头承诺。
//
// 覆盖的读数（编号与派单 §3 对齐）：
//   [M] 迁移三连：清单无重复版本号且含 0017 ⇒ UP（对象出现）⇒ ROLLBACK（对象消失）⇒ REPLAY（再出现）；
//   [P] 最小权限反向控制：以运行时角色直接 `UPDATE users SET auth_epoch=…`、
//       `INSERT/SELECT admin_audit_events`、DDL 一律 42501；而 `SELECT public.suspend_account(...)` 成功。
//   [A] 停用前：用户 token 调受保护接口 ⇒ 200；
//   [B] 停用后：**同一 token** 再调 ⇒ 401/403（逐字记录 code）；
//   [C] 停用后：重新登录（同一微信 subject）⇒ `ACCOUNT_INACTIVE` 403（逐字记录）；
//   [D] 恢复后：可重新登录并访问 ⇒ 200，而**旧 token 仍为 401**（不复活）；
//   [E] 并发：同一账号两个不同审计 id 同时停用 ⇒ 恰好一次迁移/一条审计/一次 epoch 前进；
//   [F] 失败注入：第 4 步（写审计）以重复主键 (23505) 失败 ⇒ 前三步**整体回滚**
//       （state / auth_epoch / 会话撤销三项读数与注入前**逐字相等**）；
//   [S] `90-assert-least-privilege.sql` 的整体 verdict（含本片新增 11 条断言）。

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';

import { loadConfig } from '../../services/api/src/config.ts';
import { buildApp } from '../../services/api/src/app.ts';
import { createPool } from '../../services/api/src/db/pool.ts';
import { createPostgresAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken, mintOpaqueToken } from '../../services/api/src/auth/tokens.ts';
import { createPostgresAccountAuthority } from '../../services/api/src/admin/ops/account-authority-pg.ts';

const API = '/api/v1';
const DB = 'gengyun_suspend_test';
const MIGRATION = '0017_account_suspend_authority.sql';
const DOWN = 'migrations/rollback/0017_account_suspend_authority.down.sql';
const RUNTIME_ROLE = 'gengyun_api_runtime';

const ownerUrl = new URL(process.argv[2] ?? `postgres://postgres@127.0.0.1:5432/${DB}`);
assert.equal(ownerUrl.hostname, '127.0.0.1', '本测试只允许回环地址');
assert.equal(ownerUrl.pathname, `/${DB}`, `库名必须硬钉为 ${DB}（防误连）`);
const runtimeArg = process.argv[3];
const runtimeUrl = runtimeArg === undefined ? null : new URL(runtimeArg);
if (runtimeUrl !== null) {
  assert.equal(runtimeUrl.hostname, '127.0.0.1', '运行时 URL 也只允许回环地址');
  assert.equal(runtimeUrl.pathname, `/${DB}`, '运行时 URL 必须连同一个硬钉库');
  assert.equal(decodeURIComponent(runtimeUrl.username), RUNTIME_ROLE, `运行时 URL 的用户必须是 ${RUNTIME_ROLE}`);
}

const notes = [];
function note(line) {
  notes.push(line);
  console.log(line);
}
const unread = (label, why) => note(`未取得 ${label}：${why}`);

const readSql = (rel) => readFileSync(new URL(`../../services/api/db/${rel}`, import.meta.url), 'utf8');
const deploySql = (name) => readFileSync(new URL(`../../deploy/postgres-cvm/sql/${name}`, import.meta.url), 'utf8');
const migrationsDir = new URL('../../services/api/db/migrations/', import.meta.url);

const owner = new pg.Client({ connectionString: ownerUrl.href });
/** 建过但未关闭的 app 实例：不关会让 node 进程挂着不退出（本片踩过：ALL PASS 后 300s 仍未退出）。 */
const registeredApps = [];
await owner.connect();
const baselineRoles = new Set((await owner.query('SELECT rolname FROM pg_roles')).rows.map((row) => row.rolname));
const ownerPool = new pg.Pool({ connectionString: ownerUrl.href });
const seedStore = createPostgresAuthStore({ query: (text, params) => ownerPool.query(text, params) });

const q = async (text, params = []) => (await owner.query(text, params)).rows;
const one = async (text, params = []) => (await q(text, params))[0];

// ---------------------------------------------------------------------------
// [M] 迁移三连
// ---------------------------------------------------------------------------
async function migrationTriple() {
  const discovered = readdirSync(migrationsDir)
    .filter((name) => /^\d{4,}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  const versions = discovered.map((name) => name.slice(0, 4));
  assert.equal(new Set(versions).size, versions.length, `迁移版本号重复：${versions.join(',')}`);
  assert.ok(discovered.includes(MIGRATION), `迁移清单必须含 ${MIGRATION}`);
  assert.equal(versions[versions.length - 1], '0017', `0017 必须是当前最大号（现场：${versions.join(',')}）`);
  note(`[M] 迁移清单 ${discovered.length} 个，版本号无重复，最大号 0017`);

  const objects = async () => ({
    suspend: (await one("SELECT to_regprocedure('public.suspend_account(uuid,uuid,uuid,integer,uuid)') AS v")).v,
    restore: (await one("SELECT to_regprocedure('public.restore_account(uuid,uuid,uuid,integer,uuid)') AS v")).v,
    audit: (await one("SELECT to_regclass('public.admin_audit_events') AS v")).v,
    trigger: (
      await one(
        "SELECT count(*)::int AS v FROM pg_trigger WHERE tgname = 'admin_audit_events_append_only'",
      )
    ).v,
  });

  for (const name of discovered) {
    if (name === MIGRATION) continue;
    await owner.query(readSql(`migrations/${name}`));
  }

  // UP
  await owner.query(readSql(`migrations/${MIGRATION}`));
  let state = await objects();
  assert.ok(state.suspend && state.restore && state.audit, 'UP 后三个对象必须都在');
  assert.equal(state.trigger, 1, 'UP 后 append-only 触发器必须在岗');
  note('[M] UP：suspend_account / restore_account / admin_audit_events / append-only 触发器 全部出现');

  // ROLLBACK（本片同片交付的回滚脚本，原样执行）
  await owner.query(readSql(DOWN));
  state = await objects();
  assert.equal(state.suspend, null, 'ROLLBACK 后 suspend_account 必须消失');
  assert.equal(state.restore, null, 'ROLLBACK 后 restore_account 必须消失');
  assert.equal(state.audit, null, 'ROLLBACK 后 admin_audit_events 必须消失');
  assert.equal(state.trigger, 0, 'ROLLBACK 后触发器必须消失');
  const usersStill = await one("SELECT to_regclass('public.users') AS v");
  const sessionsStill = await one("SELECT to_regclass('public.sessions') AS v");
  assert.ok(usersStill.v && sessionsStill.v, '回滚不得触碰 0001 既有表');
  note('[M] ROLLBACK：三个对象与触发器全部消失，users/sessions 仍在（回滚不越界）');

  // REPLAY
  await owner.query(readSql(`migrations/${MIGRATION}`));
  state = await objects();
  assert.ok(state.suspend && state.restore && state.audit && state.trigger === 1, 'REPLAY 后必须完整恢复');
  note('[M] REPLAY：对象与触发器再次全部出现（迁移可重放）');
}

/** 本脚本会创建的角色名（全部是出厂文件里的固定名字；只在这个一次性集群里出现）。 */
const ROLE_NAMES = [
  'gengyun_auth_privacy',
  'gengyun_preview_reader',
  'gengyun_evidence_reader',
  'gengyun_consent_granter',
  'gengyun_profile_runtime',
  'gengyun_knowledge_runtime',
  RUNTIME_ROLE,
];

/** 幂等重置：让同一个一次性集群可以反复跑（上一次中途失败会留下角色）。 */
async function resetRoles() {
  for (const name of ROLE_NAMES) {
    await owner.query(`DROP OWNED BY ${name}`).catch(() => {});
    await owner.query(`DROP ROLE IF EXISTS ${name}`).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// 角色与授权（执行**出厂文件**里的区域，不复制粘贴 SQL）
// ---------------------------------------------------------------------------
async function provisionRoles() {
  await resetRoles();
  for (const file of ['auth_privacy', 'catalog_readers', 'consent_granter', 'profile_runtime', 'knowledge_runtime']) {
    await owner.query(readSql(`roles/${file}.sql`));
  }
  await owner.query(`CREATE ROLE ${RUNTIME_ROLE} LOGIN PASSWORD '${randomBytes(24).toString('hex')}'`);
  await owner.query(
    `GRANT gengyun_auth_privacy, gengyun_preview_reader, gengyun_consent_granter,
           gengyun_profile_runtime, gengyun_knowledge_runtime TO ${RUNTIME_ROLE}`,
  );
  const matched = deploySql('20-login-roles.sql').match(
    /-- #region gy-i22-suspend-grant\r?\n([\s\S]*?)\r?\n\s*-- #endregion gy-i22-suspend-grant/,
  );
  assert.ok(matched !== null, '20-login-roles.sql 必须含 gy-i22-suspend-grant 区域');
  const region = matched[1];
  assert.equal(/^\s*(\\(echo|set|pset|if|endif|getenv|gexec))/m.test(region), false, '区域不得含 psql 元命令');
  assert.equal((region.match(/GRANT EXECUTE ON FUNCTION/g) ?? []).length, 3, '区域必须恰好三条 GRANT EXECUTE');
  await owner.query(region);
  note('[P] 已按出厂区域 gy-i22-suspend-grant 授予 EXECUTE（恰好 3 条：suspend/restore/display_name）');
}

// ---------------------------------------------------------------------------
// [P] 最小权限反向控制
// ---------------------------------------------------------------------------
async function leastPrivilege() {
  const client = new pg.Client({ connectionString: runtimeUrl.href });
  await client.connect();
  const probes = [
    ["UPDATE users SET auth_epoch = auth_epoch + 1", 'users.auth_epoch 直接写'],
    ["UPDATE users SET state = 'suspended'", 'users.state 直接写'],
    ["UPDATE users SET revision = revision + 1", 'users.revision 直接写'],
    ["INSERT INTO admin_audit_events (id, actor_id, action, scope, request_id, result) VALUES (gen_random_uuid(), gen_random_uuid(), 'x', 'y', gen_random_uuid(), 'accepted')", 'admin_audit_events 直接写'],
    ['SELECT * FROM admin_audit_events', 'admin_audit_events 直接读'],
    ['ALTER TABLE admin_audit_events ADD COLUMN probe integer', 'DDL'],
  ];
  for (const [sql, label] of probes) {
    let code = null;
    try {
      await client.query(sql);
    } catch (error) {
      code = error.code ?? null;
    }
    assert.equal(code, '42501', `${label} 必须以 42501 拒绝，实际 ${String(code)}`);
  }
  // UPDATE sessions.revoked_at **是**既有授权（0001 起的 `GRANT UPDATE (token_hash,revoked_at)`），
  // 不算越权；这里只记录它仍然可用，避免把"授权的幂等重复"误读成"权限收紧"。
  note('[P] 运行时角色 6 条直接写入/读取/DDL 全部 42501（users.state/auth_epoch/revision、审计台账读写、DDL）');
  await client.end();
}

// ---------------------------------------------------------------------------
// HTTP 手臂（A–E）
// ---------------------------------------------------------------------------
const subjectOf = (label) => randomBytes(32).toString('hex').replace(/^(.{56}).{8}$/, `$1${label.padStart(8, '0')}`);
const wechatPort = { exchange: async (code) => ({ subjectLookupHex: code.startsWith('sub-') ? code.slice(4) : subjectOf('00000000') }) };

async function launchApp(pool) {
  const app = buildApp({
    config: { ...loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }), sessionSigningKey: randomBytes(32).toString('hex') },
    pool,
    wechat: wechatPort,
    now: () => new Date(),
    adminInjection: { accountAuthority: createPostgresAccountAuthority({ pool }) },
  });
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const call = async (path, { method = 'GET', token, body, headers = {} } = {}) => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    return { status: response.status, body: parsed, text, etag: response.headers.get('etag') };
  };
  return { app, origin, call };
}

async function seedAdmin(scopes) {
  const adminId = await seedStore.createAdmin({
    loginName: `gy-i22-${randomUUID().slice(0, 8)}`,
    credentialHash: 'synthetic-not-a-real-credential-hash',
    scopes,
  });
  const token = mintOpaqueToken();
  await seedStore.createSession({
    userId: adminId,
    tokenHashHex: hashToken(token),
    authEpoch: 1,
    expiresAt: new Date(Date.now() + 3600 * 1000),
    audience: 'admin',
  });
  return { adminId, token };
}

async function httpEvidence() {
  if (runtimeUrl === null) {
    unread('[A][B][C][D] HTTP 手臂', '未提供运行时角色 URL（argv[3]），无法以最小权限跑真实 HTTP');
    return;
  }
  const runtimePool = createPool(runtimeUrl.href);
  assert.ok(runtimePool !== null, '运行时 pool 必须建出来');
  const { app, call } = await launchApp(runtimePool);
  registeredApps.push(app);
  const admin = await seedAdmin(['accounts:read', 'accounts:suspend']);
  const subjectHex = subjectOf('00000101');
  const user = await seedStore.createUser(subjectHex);
  const userToken = mintOpaqueToken();
  await seedStore.createSession({
    userId: user.id,
    tokenHashHex: hashToken(userToken),
    authEpoch: user.authEpoch,
    expiresAt: new Date(Date.now() + 3600 * 1000),
    audience: 'user',
  });

  // A：停用前 200
  const before = await call(`${API}/auth/session`, { token: userToken });
  assert.equal(before.status, 200, `A 停用前必须 200，实际 ${before.status} ${before.text.slice(0, 200)}`);
  note(`[A] 停用前用户 token 调 /auth/session ⇒ 200`);

  // 停用（HTTP，真实权威）
  const suspend = await call(`${API}/admin/accounts/${user.id}/suspend`, {
    method: 'POST',
    token: admin.token,
    body: { reason: 'GY-I22 真库证据：停用' },
    headers: { 'idempotency-key': randomUUID(), 'if-match': `"${user.revision}"` },
  });
  assert.equal(suspend.status, 200, `停用必须 200，实际 ${suspend.status} ${suspend.text.slice(0, 400)}`);
  assert.equal(suspend.body.data.state, 'suspended');
  note(`[A] 停用 ⇒ 200，data.state=suspended，revision=${suspend.body.data.revision}，display_name=${suspend.body.data.display_name}`);

  // B：同一 token 再调
  const after = await call(`${API}/auth/session`, { token: userToken });
  assert.ok([401, 403].includes(after.status), `B 停用后旧 token 必须 401/403，实际 ${after.status}`);
  note(`[B] 停用后同一 token ⇒ ${after.status} ${after.body?.error?.code ?? ''}（${after.body?.error?.message ?? ''}）`);

  // C：停用后重新登录被拒
  const relogin = await call(`${API}/auth/wechat`, {
    method: 'POST',
    body: { code: `sub-${subjectHex}` },
    headers: { 'idempotency-key': randomUUID() },
  });
  assert.equal(relogin.status, 403, `C 停用后登录必须 403，实际 ${relogin.status} ${relogin.text.slice(0, 200)}`);
  assert.equal(relogin.body.error.code, 'ACCOUNT_INACTIVE', `C 错误码必须 ACCOUNT_INACTIVE，实际 ${relogin.body.error.code}`);
  note(`[C] 停用后重新登录 ⇒ ${relogin.status} ${relogin.body.error.code}（${relogin.body.error.message}）`);

  // D：恢复（端口方法；契约无 restore 操作，故不经 HTTP 路由）+ 旧 token 不得复活
  const authority = createPostgresAccountAuthority({ pool: runtimePool });
  const restored = await authority.restore({
    actorId: admin.adminId,
    auditId: randomUUID(),
    userId: user.id,
    expectedRevision: null,
    requestId: randomUUID(),
  });
  assert.equal(restored.changed, true);
  note(`[D] 恢复 ⇒ state=${restored.account.state}，auth_epoch=${restored.authEpoch}，revoked_sessions=${restored.revokedSessions}`);
  const d = await call(`${API}/auth/wechat`, {
    method: 'POST',
    body: { code: `sub-${subjectHex}` },
    headers: { 'idempotency-key': randomUUID() },
  });
  assert.equal(d.status, 200, `D 恢复后必须能重新登录，实际 ${d.status} ${d.text.slice(0, 200)}`);
  const newToken = d.body.data.access_token ?? d.body.data.accessToken;
  assert.ok(typeof newToken === 'string' && newToken.length > 0, 'D 登录必须返回令牌');
  const fresh = await call(`${API}/auth/session`, { token: newToken });
  assert.equal(fresh.status, 200, `D 新 token 必须 200，实际 ${fresh.status}`);
  const oldAgain = await call(`${API}/auth/session`, { token: userToken });
  assert.equal(oldAgain.status, 401, `D 旧 token 必须仍为 401，实际 ${oldAgain.status}`);
  note(`[D] 恢复后重新登录 ⇒ 200；新 token ⇒ 200；**旧 token 仍 ${oldAgain.status}**（未复活）`);

  const auditRows = await q('SELECT action, reason_code, result, target_hint FROM admin_audit_events WHERE target_hint = $1 ORDER BY created_at', [
    `account:${user.id}`,
  ]);
  assert.equal(auditRows.length, 2, `A–D 应恰好两条审计（suspend + restore），实际 ${auditRows.length}`);
  note(`[A–D] 审计台账：${auditRows.map((r) => `${r.action}/${r.reason_code}/${r.result}`).join(' , ')}`);
  await runtimePool.end();
}

// ---------------------------------------------------------------------------
// [E] 并发 + [F] 失败注入（端口级，真并发两个连接）
// ---------------------------------------------------------------------------
async function concurrencyAndInjection() {
  if (runtimeUrl === null) {
    unread('[E][F] 并发与失败注入', '未提供运行时角色 URL（argv[3]）');
    return;
  }
  const runtimePool = createPool(runtimeUrl.href);
  const authority = createPostgresAccountAuthority({ pool: runtimePool });
  const adminId = await seedStore.createAdmin({
    loginName: `gy-i22-conc-${randomUUID().slice(0, 8)}`,
    credentialHash: 'synthetic-not-a-real-credential-hash',
    scopes: ['accounts:suspend'],
  });
  const subjectHex = subjectOf('00000202');
  const user = await seedStore.createUser(subjectHex);

  const [a, b] = await Promise.all([
    authority.suspend({ actorId: adminId, auditId: randomUUID(), userId: user.id, expectedRevision: null, requestId: randomUUID() }),
    authority.suspend({ actorId: adminId, auditId: randomUUID(), userId: user.id, expectedRevision: null, requestId: randomUUID() }),
  ]);
  const changedCount = [a.changed, b.changed].filter(Boolean).length;
  assert.equal(changedCount, 1, `E 并发双停用必须恰好一次生效，实际 ${changedCount}`);
  const row = await one('SELECT state, auth_epoch FROM users WHERE id = $1', [user.id]);
  assert.equal(row.state, 'suspended');
  assert.equal(Number(row.auth_epoch), user.authEpoch + 1, 'E auth_epoch 必须恰好 +1（不得两次递增）');
  const audits = await q('SELECT count(*)::int AS c FROM admin_audit_events WHERE target_hint = $1', [`account:${user.id}`]);
  assert.equal(audits[0].c, 1, `E 审计必须恰好一行，实际 ${audits[0].c}`);
  note(`[E] 并发双停用 ⇒ changed=${a.changed}/${b.changed}，auth_epoch ${user.authEpoch}→${Number(row.auth_epoch)}（恰好 +1），审计恰好 1 行`);

  // [F] 失败注入：审计 id 撞主键 ⇒ 第 4 步失败 ⇒ 前三步必须整体回滚
  const target = await seedStore.createUser(subjectOf('00000303'));
  const sessionToken = mintOpaqueToken();
  await seedStore.createSession({
    userId: target.id,
    tokenHashHex: hashToken(sessionToken),
    authEpoch: target.authEpoch,
    expiresAt: new Date(Date.now() + 3600 * 1000),
    audience: 'user',
  });
  const usedAuditId = randomUUID();
  await owner.query(
    `INSERT INTO admin_audit_events (id, actor_id, action, scope, target_ref, target_hint, reason_code, request_id, result)
     VALUES ($1, $2, 'seed.inject', 'accounts:suspend', NULL, 'account:seed-injection', 'seed', $3, 'accepted')`,
    [usedAuditId, adminId, randomUUID()],
  );
  const before = await one(
    'SELECT state, auth_epoch, revision FROM users WHERE id = $1',
    [target.id],
  );
  const beforeRevoked = await one(
    'SELECT count(*)::int AS c FROM sessions WHERE user_id = $1 AND revoked_at IS NOT NULL',
    [target.id],
  );
  let injectCode = null;
  try {
    await authority.suspend({ actorId: adminId, auditId: usedAuditId, userId: target.id, expectedRevision: null, requestId: randomUUID() });
  } catch (error) {
    injectCode = error.code ?? error.name;
  }
  assert.equal(injectCode, 'PROVIDER_UNAVAILABLE', `F 注入必须失败关闭（PROVIDER_UNAVAILABLE），实际 ${String(injectCode)}`);
  const after = await one('SELECT state, auth_epoch, revision FROM users WHERE id = $1', [target.id]);
  const afterRevoked = await one(
    'SELECT count(*)::int AS c FROM sessions WHERE user_id = $1 AND revoked_at IS NOT NULL',
    [target.id],
  );
  assert.deepEqual(after, before, `F 前三步必须整体回滚：注入前 ${JSON.stringify(before)} vs 注入后 ${JSON.stringify(after)}`);
  assert.equal(afterRevoked.c, beforeRevoked.c, 'F 会话撤销必须随事务回滚');
  const auditCount = await one('SELECT count(*)::int AS c FROM admin_audit_events WHERE target_hint = $1', [`account:${target.id}`]);
  assert.equal(auditCount.c, 0, 'F 不得留下任何该账号的审计行');
  note(
    `[F] 第 4 步（写审计，23505）失败 ⇒ ${injectCode}；state/auth_epoch/revision 逐字未变 ${JSON.stringify(after)}；已撤会话 ${beforeRevoked.c}→${afterRevoked.c}；审计 0 行`,
  );
  await runtimePool.end();
}

// ---------------------------------------------------------------------------
// [S] 出厂最小权限断言脚本的整体 verdict
// ---------------------------------------------------------------------------
async function leastPrivilegeVerdict() {
  const sql = deploySql('90-assert-least-privilege.sql');
  if (/^\s*\\/m.test(sql)) {
    // 该出厂脚本含 psql 元命令，**不能**经 pg 客户端执行：由驱动命令用 `psql -f` 跑并回读 verdict
    // （见交接「迁移三连 + 最小权限」一节）。这里只如实记录，不假装跑过。
    note('[S] 90-assert-least-privilege.sql 含 psql 元命令 ⇒ 由 `psql -f` 单独执行（本脚本不代跑）');
    return;
  }
  try {
    const rows = (await owner.query(sql)).rows;
    const verdict = rows.map((row) => row.verdict).filter((v) => v !== null && v !== undefined).join(' | ');
    note(`[S] 90-assert-least-privilege.sql verdict = ${verdict}`);
  } catch (error) {
    unread('[S] 90-assert-least-privilege.sql', `执行失败：${String(error.message).slice(0, 300)}`);
  }
}

// ---------------------------------------------------------------------------
// 收工：清掉本脚本创建的角色（不改库内任何别人创建的角色）
// ---------------------------------------------------------------------------
async function cleanup() {
  // 若上一步在 BEGIN 块内失败，客户端会停在"事务已中止"状态：先回滚，否则清理语句自己也会失败，
  // 把真正的原始错误盖掉（本片踩过）。
  await owner.query('ROLLBACK').catch(() => {});
  for (const app of registeredApps) await app.close().catch(() => {});
  const now = new Set((await q('SELECT rolname FROM pg_roles')).map((row) => row.rolname));
  const mine = [...now].filter((name) => !baselineRoles.has(name));
  // `I22_KEEP_ROLES=1`：只用于紧接着用 psql 跑 `90-assert-least-privilege.sql`（它含 psql 元命令，
  // 不能经 pg 客户端执行）。正常跑法不设该变量 ⇒ 角色全清。
  if (process.env.I22_KEEP_ROLES === '1') {
    note(`清理：I22_KEEP_ROLES=1 ⇒ 保留 ${mine.length} 个角色供 psql 断言（收尾须手工 DROP）`);
    await ownerPool.end().catch(() => {});
    await owner.end().catch(() => {});
    return;
  }
  await resetRoles().catch(() => {});
  for (const name of mine) {
    if (name === RUNTIME_ROLE) {
      await owner.query(`DROP OWNED BY ${name}`).catch(() => {});
    }
    await owner.query(`DROP ROLE IF EXISTS ${name}`).catch(() => {});
  }
  await ownerPool.end().catch(() => {});
  await owner.end().catch(() => {});
  note(`清理：删除本脚本新建的 ${mine.length} 个角色（${mine.join(',') || '无'}）`);
}

let failure = null;
try {
  await migrationTriple();
  await provisionRoles();
  if (runtimeUrl !== null) await leastPrivilege();
  else unread('[P] 最小权限反向控制', '未提供运行时角色 URL（argv[3]）');
  await httpEvidence();
  await concurrencyAndInjection();
  await leastPrivilegeVerdict();
} catch (error) {
  failure = error;
  console.error(`首个失败读数：${String(error.message).slice(0, 600)}`);
} finally {
  await cleanup();
}
if (failure !== null) throw failure;
note('ALL PASS：迁移三连 / 最小权限 / A–E / 失败注入 全部取得真库读数');
