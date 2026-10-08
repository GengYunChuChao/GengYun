import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { createPostgresAuthStore } from '../../services/api/src/auth/store.ts';
import { createPostgresIdempotencyStore } from '../../services/api/src/auth/idempotency.ts';
import { hashPassword, verifyPassword } from '../../services/api/src/auth/password.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';

/**
 * GY-I04 数据库产物回归：迁移 0008（幂等键台账）与认证存储的 PostgreSQL SQL。
 *
 * 使用内存 PostgreSQL 引擎（PGlite 0.5.8，PostgreSQL 18.x 内核）。
 * 注意：这只证明 SQL 可执行且语义正确，**不构成目标 PostgreSQL 17.11 的实库验收**。
 * 0008 只依赖 0001 的对象，不引用 0003，也不引用 Codex #51–#55 的 0004~0007 对象。
 * （本迁移原为 0004；rebase 到新 main 后因 0004~0007 已被 #51–#55 占用而重编号为 0008。）
 */
const root = resolve(import.meta.dirname, '../..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');

const M0001 = read('services/api/db/migrations/0001_initial_schema.sql');
const M0008 = read('services/api/db/migrations/0008_auth_session.sql');
const DOWN0008 = read('services/api/db/migrations/rollback/0008_auth_session.down.sql');

async function freshDb() {
  const db = new PGlite();
  await db.exec(M0001);
  await db.exec(M0008);
  return db;
}

const future = () => new Date(Date.now() + 60_000);

test('0008 不引用 0003 与 #51–#55（0004~0007）对象，只新增幂等键台账（静态）', () => {
  const code = M0008.replace(/--[^\n]*/g, '');
  assert.match(code, /CREATE TABLE idempotency_keys/);
  for (const forbidden of [
    // 0003（GY-I27）对象
    '0003', 'formulations', 'registrations', 'applicability', 'knowledge_dataset_modes', 'consents',
    // Codex #51–#55（0004~0007）新增对象
    'staging_intake', 'knowledge_staging', 'catalog_read', 'catalog_ops',
    'workbook_batches', 'workbook_rows',
  ]) {
    assert.ok(!code.includes(forbidden), `0008 不应引用：${forbidden}`);
  }
  // 不重复创建、不修改 0001 的身份表
  for (const owned of ['CREATE TABLE users', 'CREATE TABLE sessions', 'ALTER TABLE users']) {
    assert.ok(!code.includes(owned), `0008 不应改动 0001 对象：${owned}`);
  }
});

test('0001→0008 在内存引擎可整体执行，幂等键台账结构齐备', async () => {
  const db = await freshDb();
  const cols = await db.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='idempotency_keys' ORDER BY column_name`,
  );
  assert.deepEqual(
    cols.rows.map((r) => r.column_name),
    ['created_at', 'expires_at', 'id', 'key_hash', 'outcome', 'request_hash', 'response_status', 'scope'],
  );
  // 0001 的身份表仍在
  for (const table of ['users', 'sessions', 'admin_accounts', 'admin_sessions', 'admin_scopes']) {
    const r = await db.query('SELECT count(*)::int AS c FROM ' + table);
    assert.equal(r.rows[0].c, 0);
  }
  await db.close();
});

test('0008 down 可执行：删除幂等键台账，保留 0001 对象', async () => {
  const db = await freshDb();
  await db.exec(DOWN0008);
  const gone = await db.query(
    `SELECT count(*)::int AS c FROM information_schema.tables WHERE table_schema='public' AND table_name='idempotency_keys'`,
  );
  assert.equal(gone.rows[0].c, 0);
  const kept = await db.query('SELECT count(*)::int AS c FROM users');
  assert.equal(kept.rows[0].c, 0);
  await db.close();
});

test('PostgreSQL 认证存储：用户/会话/退出/epoch 递增语义正确', async () => {
  const db = await freshDb();
  const store = createPostgresAuthStore(db);
  assert.equal(store.persistent, true);

  const subject = 'a'.repeat(64);
  const created = await store.createUser(subject);
  assert.equal(created.state, 'active');
  assert.equal(created.authEpoch, 1);
  assert.equal(created.revision, 1);

  const found = await store.findUserBySubject(subject);
  assert.deepEqual(found, created);
  assert.equal(await store.findUserBySubject('b'.repeat(64)), null);

  const token = hashToken('opaque-token-1');
  const sessionId = await store.createSession({
    userId: created.id,
    tokenHashHex: token,
    authEpoch: created.authEpoch,
    expiresAt: future(),
    audience: 'user',
  });
  assert.ok(sessionId.length > 0);

  const session = await store.findSession(token, 'user');
  assert.equal(session.id, sessionId);
  assert.equal(session.userId, created.id);
  assert.equal(session.audience, 'user');
  assert.equal(session.authEpoch, 1);
  assert.equal(session.revokedAt, null);

  await store.revokeSession(sessionId, 'user');
  assert.notEqual((await store.findSession(token, 'user')).revokedAt, null);

  await store.bumpUserAuthEpoch(created.id);
  const bumped = await store.getUser(created.id);
  assert.equal(bumped.authEpoch, 2);
  assert.equal(bumped.revision, 2);
  await db.close();
});

test('PostgreSQL 认证存储：同 subject 并发注册收敛到同一用户（唯一索引 + 23505 回读）', async () => {
  const db = await freshDb();
  const store = createPostgresAuthStore(db);
  const subject = 'c'.repeat(64);
  const first = await store.createUser(subject);
  const second = await store.createUser(subject);
  assert.equal(second.id, first.id);
  const count = await db.query('SELECT count(*)::int AS c FROM users');
  assert.equal(count.rows[0].c, 1);
  await db.close();
});

test('PostgreSQL 认证存储：后台账号与 scope（凭据只存摘要）', async () => {
  const db = await freshDb();
  const store = createPostgresAuthStore(db);
  assert.equal(await store.countAdmins(), 0);

  const credentialHash = hashPassword('bootstrap-pass-123');
  const adminId = await store.createAdmin({ loginName: 'root', credentialHash, scopes: ['session:read', 'session:logout'] });
  assert.equal(await store.countAdmins(), 1);

  const byLogin = await store.findAdminByLoginName('root');
  assert.equal(byLogin.id, adminId);
  assert.equal(byLogin.state, 'active');
  assert.equal(byLogin.credentialHash, credentialHash);
  assert.equal(verifyPassword('bootstrap-pass-123', byLogin.credentialHash), true);
  assert.equal(verifyPassword('wrong-password-123', byLogin.credentialHash), false);

  assert.deepEqual(await store.listAdminScopes(adminId), ['session:logout', 'session:read']);

  const token = hashToken('admin-token-1');
  await store.createSession({ userId: adminId, tokenHashHex: token, authEpoch: 1, expiresAt: future(), audience: 'admin' });
  const session = await store.findSession(token, 'admin');
  assert.equal(session.userId, adminId);
  assert.equal(session.audience, 'admin');
  // 后台令牌不会出现在用户会话表中
  assert.equal(await store.findSession(token, 'user'), null);
  await db.close();
});

test('PostgreSQL 幂等台账：占位/完成/释放语义，只存不含凭据的结果引用，到期可实际清理', async () => {
  const db = await freshDb();
  const store = createPostgresIdempotencyStore(db);
  assert.equal(store.persistent, true);

  const scope = 'anonymous\nPOST\n/admin/auth/session';
  const keyHash = 'd'.repeat(64);
  assert.equal(await store.find(scope, keyHash), null);

  // 占位（claim）：插入 outcome IS NULL 的行；占位中的行不作为已完成结果返回给重放方。
  const pending = { requestHash: 'e'.repeat(64), responseStatus: 200, expiresAt: future() };
  assert.equal(await store.claim(scope, keyHash, pending), true);
  assert.equal(await store.find(scope, keyHash), null, '占位行不应作为已完成结果返回');

  // 同键并发再来一次：claim 必须失败（收敛到同一占位者）。
  assert.equal(await store.claim(scope, keyHash, pending), false, '同键已被占用时 claim 必须失败');

  // 完成（complete）：写入不含凭据的结果引用（sessionId + audience），绝不写入令牌明文。
  assert.equal(
    await store.complete(scope, keyHash, {
      requestHash: 'e'.repeat(64),
      responseStatus: 200,
      outcome: { sessionId: '11111111-1111-4111-8111-111111111111', audience: 'admin' },
      expiresAt: future(),
    }),
    true,
  );
  const stored = await store.find(scope, keyHash);
  assert.equal(stored.requestHash, 'e'.repeat(64));
  assert.equal(stored.responseStatus, 200);
  assert.deepEqual(stored.outcome, { sessionId: '11111111-1111-4111-8111-111111111111', audience: 'admin' });

  // 直查原表：整行不含任何访问令牌字段。
  const raw = await db.query('SELECT outcome::text AS outcome_text FROM idempotency_keys WHERE scope = $1', [scope]);
  assert.equal(raw.rows[0].outcome_text.includes('access_token'), false, '台账行不得包含 access_token');
  assert.equal(raw.rows[0].outcome_text.includes('Bearer'), false, '台账行不得包含 Bearer 令牌');

  // complete 只对未完成占位生效：已完成后再次 complete 不覆盖。
  assert.equal(
    await store.complete(scope, keyHash, {
      requestHash: 'f'.repeat(64),
      responseStatus: 200,
      outcome: { accepted: true },
      expiresAt: future(),
    }),
    false,
    'complete 只对未完成占位生效',
  );
  assert.equal((await store.find(scope, keyHash)).requestHash, 'e'.repeat(64));

  // release 只删未完成占位：对已完成行无效。
  await store.release(scope, keyHash);
  assert.notEqual(await store.find(scope, keyHash), null, 'release 不得删除已完成结果');

  // release 物理删除占位行。
  const pendingKey = '5'.repeat(64);
  assert.equal(await store.claim(scope, pendingKey, pending), true);
  await store.release(scope, pendingKey);
  assert.equal(await store.find(scope, pendingKey), null);
  const pendingGone = await db.query(
    'SELECT count(*)::int AS c FROM idempotency_keys WHERE key_hash = decode($1, \'hex\')',
    [pendingKey],
  );
  assert.equal(pendingGone.rows[0].c, 0, 'release 应物理删除占位行');

  // 到期清理：purgeExpired 做**实际删除**（而非只写 TTL 字段）。
  const shortTtlKey = '2'.repeat(64);
  const shortTtl = new Date(Date.now() + 40);
  assert.equal(await store.claim(scope, shortTtlKey, { requestHash: 'a'.repeat(64), responseStatus: 200, expiresAt: shortTtl }), true);
  await store.complete(scope, shortTtlKey, {
    requestHash: 'a'.repeat(64),
    responseStatus: 200,
    outcome: { accepted: true },
    expiresAt: shortTtl,
  });
  await new Promise((r) => setTimeout(r, 90));
  const removed = await store.purgeExpired(new Date());
  assert.ok(removed >= 1, 'purgeExpired 应实际删除已到期条目');
  const gone = await db.query('SELECT count(*)::int AS c FROM idempotency_keys WHERE key_hash = decode($1, \'hex\')', [shortTtlKey]);
  assert.equal(gone.rows[0].c, 0, '已到期条目应从表中物理删除');

  // 清理后可重新占位同键（claim 会先删过期行）。
  assert.equal(
    await store.claim(scope, shortTtlKey, { requestHash: 'b'.repeat(64), responseStatus: 200, expiresAt: future() }),
    true,
  );
  await db.close();
});
