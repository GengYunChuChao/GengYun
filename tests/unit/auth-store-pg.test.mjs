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
 * GY-I04 数据库产物回归：迁移 0004（幂等键台账）与认证存储的 PostgreSQL SQL。
 *
 * 使用内存 PostgreSQL 引擎（PGlite 0.5.8，PostgreSQL 18.x 内核）。
 * 注意：这只证明 SQL 可执行且语义正确，**不构成目标 PostgreSQL 17.11 的实库验收**。
 * 0004 只依赖 0001 的对象，且不引用 0003 的任何对象（0003 尚未合入 main）。
 */
const root = resolve(import.meta.dirname, '../..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');

const M0001 = read('services/api/db/migrations/0001_initial_schema.sql');
const M0004 = read('services/api/db/migrations/0004_auth_session.sql');
const DOWN0004 = read('services/api/db/migrations/rollback/0004_auth_session.down.sql');

async function freshDb() {
  const db = new PGlite();
  await db.exec(M0001);
  await db.exec(M0004);
  return db;
}

const future = () => new Date(Date.now() + 60_000);

test('0004 不引用 0003/0002 的对象，只新增幂等键台账（静态）', () => {
  const code = M0004.replace(/--[^\n]*/g, '');
  assert.match(code, /CREATE TABLE idempotency_keys/);
  for (const forbidden of ['0003', 'formulations', 'registrations', 'applicability', 'knowledge_dataset_modes', 'consents']) {
    assert.ok(!code.includes(forbidden), `0004 不应引用：${forbidden}`);
  }
  // 不重复创建、不修改 0001 的身份表
  for (const owned of ['CREATE TABLE users', 'CREATE TABLE sessions', 'ALTER TABLE users']) {
    assert.ok(!code.includes(owned), `0004 不应改动 0001 对象：${owned}`);
  }
});

test('0001→0004 在内存引擎可整体执行，幂等键台账结构齐备', async () => {
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

test('0004 down 可执行：删除幂等键台账，保留 0001 对象', async () => {
  const db = await freshDb();
  await db.exec(DOWN0004);
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

test('PostgreSQL 幂等台账：只存不含凭据的结果引用，同键不覆盖，到期可实际清理', async () => {
  const db = await freshDb();
  const store = createPostgresIdempotencyStore(db);
  assert.equal(store.persistent, true);

  const scope = 'anonymous\nPOST\n/admin/auth/session';
  const keyHash = 'd'.repeat(64);
  assert.equal(await store.find(scope, keyHash), null);

  // P1-①：台账只保存 sessionId + audience 这类结果引用，**绝不**保存令牌明文。
  await store.save(scope, keyHash, {
    requestHash: 'e'.repeat(64),
    responseStatus: 200,
    outcome: { sessionId: '11111111-1111-4111-8111-111111111111', audience: 'admin' },
    expiresAt: future(),
  });
  const stored = await store.find(scope, keyHash);
  assert.equal(stored.requestHash, 'e'.repeat(64));
  assert.equal(stored.responseStatus, 200);
  assert.deepEqual(stored.outcome, { sessionId: '11111111-1111-4111-8111-111111111111', audience: 'admin' });

  // 直查原表：列名不再是 response_body，且整行不含任何访问令牌字段。
  const raw = await db.query('SELECT outcome::text AS outcome_text FROM idempotency_keys WHERE scope = $1', [scope]);
  assert.equal(raw.rows[0].outcome_text.includes('access_token'), false, '台账行不得包含 access_token');
  assert.equal(raw.rows[0].outcome_text.includes('Bearer'), false, '台账行不得包含 Bearer 令牌');

  // 同键再次保存不覆盖（ON CONFLICT DO NOTHING）
  await store.save(scope, keyHash, {
    requestHash: 'f'.repeat(64),
    responseStatus: 200,
    outcome: { sessionId: '22222222-2222-4222-8222-222222222222', audience: 'admin' },
    expiresAt: future(),
  });
  assert.equal((await store.find(scope, keyHash)).requestHash, 'e'.repeat(64));

  // 到期清理：purgeExpired 做**实际删除**（而非只写 TTL 字段）。
  const shortTtlKey = '2'.repeat(64);
  await store.save(scope, shortTtlKey, {
    requestHash: 'a'.repeat(64),
    responseStatus: 200,
    outcome: { accepted: true },
    expiresAt: new Date(Date.now() + 40),
  });
  await new Promise((r) => setTimeout(r, 90));
  const beforePurge = await store.find(scope, shortTtlKey);
  assert.equal(beforePurge.expiresAt.getTime() < Date.now(), true, '短 TTL 记录应已过期');
  const removed = await store.purgeExpired(new Date());
  assert.ok(removed >= 1, 'purgeExpired 应实际删除已到期条目');
  const gone = await db.query('SELECT count(*)::int AS c FROM idempotency_keys WHERE key_hash = decode($1, \'hex\')', [shortTtlKey]);
  assert.equal(gone.rows[0].c, 0, '已到期条目应从表中物理删除');

  // 清理后可重新写入同键（save 会先删过期行）
  await store.save(scope, shortTtlKey, {
    requestHash: 'b'.repeat(64),
    responseStatus: 200,
    outcome: { accepted: true },
    expiresAt: future(),
  });
  const rewritten = await store.find(scope, shortTtlKey);
  assert.equal(rewritten.requestHash, 'b'.repeat(64));
  await db.close();
});
