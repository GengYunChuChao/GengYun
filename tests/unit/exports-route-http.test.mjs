// GY-I19（#19）· `GET /me/exports`（契约 `listExports`）的 HTTP 层验收。
//
// 覆盖（每条都走**真实产品 HTTP**，不直接调服务）：
//   ① 200 封套与分页形状（`{items,next_cursor}` + `meta` + `Cache-Control: no-store` + 无 ETag）；
//   ② 排序口径 `(created_at DESC, id DESC)`；
//   ③ 游标：签名、主体绑定、登录版本绑定、域分隔、有效期；
//   ④ 他人不可见（跨用户游标/跨用户清单）；
//   ⑤ 无池 ⇒ 503 `PROVIDER_UNAVAILABLE`（不冒充持久化）；
//   ⑥ 参数校验 4xx（limit 0/51/小数、cursor 超长）；
//   ⑦ 运行时角色缺 `public.exports` 的 SELECT 面 ⇒ 503 fail-closed（如实复现真库现状）。
//
// 合成资料：账号由 stub 微信登录生成，导出行为本测试插入的合成行；**不是**原生 PG17、
// 不是真实外发、也不证明"导出文件生成"（本片只做清单读面）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';
import { createExportsListService } from '../../services/api/src/privacy/exports-list.ts';

const KEY = 'synthetic-exports-route-test-key';
const DOMAIN = 'export-list/v1';
const read = name => readFileSync(new URL('../../services/api/db/' + name, import.meta.url), 'utf8');
const sign = text => createHmac('sha256', KEY).update(`${DOMAIN}\n${text}`).digest('base64url');
/** 用已知测试密钥**重签**被改过的载荷 —— 只为证明"即使签名合法，错域/错主体/过期仍被拒"。 */
const rewrite = (cursor, change) => {
  const value = JSON.parse(Buffer.from(cursor.split('.')[0], 'base64url'));
  change(value);
  const encoded = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encoded}.${sign(encoded)}`;
};

/** 合成导出账本行（列面见 `services/api/db/migrations/0003_privacy_consent.sql` 的 exports）。 */
const EXPORT_ROW = Object.freeze({
  object_type: 'media',
  object_id: '11111111-1111-4111-8111-111111111111',
  object_revision: 1,
  purpose: 'media_processing',
  consent_epoch: 1,
  recipient_id: 'synthetic-recipient',
  recipient_config_version: 'cfg-1',
  auth_epoch: 1,
  state: 'sent',
});

function makePool(db) {
  let queue = Promise.resolve();
  const pool = {
    async connect() {
      const before = queue;
      let unlock;
      queue = new Promise(resolve => { unlock = resolve; });
      await before;
      await db.query('SET ROLE gy_exports_route_runtime');
      return { query: (...args) => db.query(...args), release() { db.query('RESET ROLE').finally(unlock); } };
    },
    async query(...args) { const client = await this.connect(); try { return await client.query(...args); } finally { client.release(); } },
  };
  return { pool, drained: () => queue };
}

test('无池 ⇒ GET /me/exports 返回 503 PROVIDER_UNAVAILABLE（不冒充持久账本）', async t => {
  const app = buildApp({ config: { ...loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }) , sessionSigningKey: KEY }, pool: null });
  t.after(() => app.close());
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  const login = await fetch(base + '/auth/wechat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'exports-nopool-login' },
    body: JSON.stringify({ code: 'synthetic-nopool' }),
  });
  assert.equal(login.status, 200);
  const token = (await login.json()).data.access_token;

  // 未登录先撞鉴权：401 在 503 之前（不因为后端未配置而泄露"服务存在但不可用"）。
  const anonymous = await fetch(base + '/me/exports');
  assert.equal(anonymous.status, 401);
  assert.equal((await anonymous.json()).error.code, 'SESSION_REQUIRED');

  const response = await fetch(base + '/me/exports', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(body.error.retryable, false, '未接线属能力未装配，不得标可重试');
  assert.equal(body.data, undefined, '⛔ 不得在 503 上附带成功封套');
});

test('连接池形状不合：装配期不抛（buildApp 能起），请求期 fail-closed 503', async t => {
  // 负控制：只要还有人把「解析账本」搬到装配期，`buildApp` 就会在这里直接抛错（本片返修前正是如此，
  // 由 `tests/unit/api-health.test.mjs` 的假池用例抓到）。
  const halfShapedPool = { async query() { throw new Error('connection refused'); } };
  const app = buildApp({ config: { ...loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }), sessionSigningKey: KEY }, pool: halfShapedPool });
  t.after(() => app.close());
  const anonymous = await app.inject({ method: 'GET', url: '/api/v1/me/exports' });
  assert.equal(anonymous.statusCode, 401, '路由已装配，鉴权在账本之前');
  // 直接打服务：池形状不合 ⇒ 契约 503（不是裸 Error/500）。
  const service = createExportsListService({ pool: halfShapedPool, hmacKey: KEY });
  await assert.rejects(
    () => service.list({ userId: 'aaaaaaaa-0000-4000-8000-000000000001', authEpoch: 1 }, { limit: 20 }),
    error => error.code === 'PROVIDER_UNAVAILABLE' && error.status === 503,
  );
});

test('GET /me/exports：封套/排序/分页/游标绑定/他人不可见/参数校验（PGlite 合成资料）', async t => {
  const db = new PGlite();
  let app;
  const { pool, drained } = makePool(db);
  t.after(async () => { await app?.close(); await drained(); await db.close(); });
  for (const name of ['0001_initial_schema', '0003_privacy_consent', '0008_auth_session']) {
    await db.exec(read(`migrations/${name}.sql`));
  }
  await db.exec(read('roles/auth_privacy.sql'));
  // 与真库现状一致：运行期角色**没有** `public.exports` 的 SELECT 面（`auth_privacy.sql` 只授了
  // `user_id` 一列；`egress_ledger` 组未部署也未被继承）——下面第一条臂就先验证这一点。
  await db.exec('CREATE ROLE gy_exports_route_runtime NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; GRANT gengyun_auth_privacy TO gy_exports_route_runtime');
  app = buildApp({ config: { ...loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }), sessionSigningKey: KEY }, pool });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  const http = async (path, token, options = {}) => {
    const response = await fetch(base + path, {
      ...options,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...options.headers },
    });
    return {
      status: response.status,
      body: await response.json(),
      cache: response.headers.get('cache-control'),
      etag: response.headers.get('etag'),
    };
  };
  async function login(code) {
    const response = await http('/auth/wechat', null, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `exports-login-${code}` },
      body: JSON.stringify({ code }),
    });
    assert.equal(response.status, 200);
    const token = response.body.data.access_token;
    await drained();
    const row = (await db.query("SELECT user_id FROM sessions WHERE token_hash=decode($1,'hex')", [hashToken(token)])).rows[0];
    return { id: row.user_id, token };
  }
  const a = await login('synthetic-exports-a');
  const b = await login('synthetic-exports-b');

  // 合成账本行：a 四条（含一对 created_at 相同、按 id 降序区分），b 一条。
  const ids = {
    a1: 'aaaaaaaa-0000-4000-8000-000000000001',
    a2: 'aaaaaaaa-0000-4000-8000-000000000002',
    a3: 'aaaaaaaa-0000-4000-8000-000000000003',
    a4: 'aaaaaaaa-0000-4000-8000-000000000004',
    b1: 'bbbbbbbb-0000-4000-8000-000000000001',
  };
  const rows = [
    [ids.a1, a.id, '2026-10-01T00:00:00Z'],
    [ids.a2, a.id, '2026-10-02T00:00:00Z'],
    [ids.a3, a.id, '2026-10-03T00:00:00Z'],
    [ids.a4, a.id, '2026-10-02T00:00:00Z'],
    [ids.b1, b.id, '2026-10-02T12:00:00Z'],
  ];
  for (const [id, userId, createdAt] of rows) {
    await db.query(
      `INSERT INTO exports(id,user_id,object_type,object_id,object_revision,purpose,consent_epoch,
         recipient_id,recipient_config_version,auth_epoch,state,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, userId, EXPORT_ROW.object_type, EXPORT_ROW.object_id, EXPORT_ROW.object_revision,
        EXPORT_ROW.purpose, EXPORT_ROW.consent_epoch, EXPORT_ROW.recipient_id,
        EXPORT_ROW.recipient_config_version, EXPORT_ROW.auth_epoch, EXPORT_ROW.state, createdAt],
    );
  }

  // ① fail-closed：运行期角色拿不到 `public.exports` 的列面 ⇒ 42501 ⇒ 503（不可重试）。
  const unwired = await http('/me/exports', a.token);
  assert.equal(unwired.status, 503, '运行时角色缺 SELECT 面时必须 503，不得 200 空页');
  assert.equal(unwired.body.error.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(unwired.body.error.retryable, false);

  // 授权面补齐（对应真库里"给运行时角色开 exports 读面"这一运维动作；本片不改授权文件）。
  await db.exec('GRANT SELECT ON public.exports TO gengyun_auth_privacy');

  // ② 200 封套 + 形状 + 排序 + 头。
  const first = await http('/me/exports?limit=2', a.token);
  assert.equal(first.status, 200);
  assert.equal(first.cache, 'no-store');
  assert.equal(first.etag, null, '契约：列表无 ETag 头');
  assert.equal(first.body.meta.contract_version, '1.0.0');
  assert.equal(first.body.meta.execution_mode, 'stub');
  assert.match(first.body.meta.request_id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(Object.keys(first.body).sort(), ['data', 'meta']);
  assert.deepEqual(Object.keys(first.body.data).sort(), ['items', 'next_cursor']);
  assert.deepEqual(first.body.data.items.map(item => item.id), [ids.a3, ids.a4], 'created_at DESC, id DESC');
  for (const item of first.body.data.items) {
    assert.deepEqual(Object.keys(item).sort(), [
      'consent_epoch', 'deletion_state', 'id', 'object_ref', 'purpose', 'recipient_id', 'sent_at', 'state',
    ].sort(), '契约 Export 的 8 个必需字段，别的键一个都不能多（additionalProperties:false）');
    assert.deepEqual(Object.keys(item.object_ref).sort(), ['id', 'revision', 'type']);
    assert.equal(item.state, 'sent');
    assert.equal(item.sent_at, null);
    assert.equal(item.deletion_state, 'not_requested');
    assert.equal(item.purpose, 'media_processing');
    assert.equal(item.consent_epoch, 1);
  }
  assert.ok(!JSON.stringify(first.body).includes('user_id'), '响应不得出现账本外键/内部列');

  // ③ 翻页：next_cursor 非空、走完为 null、limit 可变、末页不重复不漏项。
  const cursor = first.body.data.next_cursor;
  assert.ok(typeof cursor === 'string' && cursor.length > 0 && cursor.length <= 2048);
  const second = await http(`/me/exports?limit=2&cursor=${encodeURIComponent(cursor)}`, a.token);
  assert.equal(second.status, 200);
  assert.deepEqual(second.body.data.items.map(item => item.id), [ids.a2, ids.a1]);
  assert.equal(second.body.data.next_cursor, null);
  const third = await http(`/me/exports?limit=50&cursor=${encodeURIComponent(cursor)}`, a.token);
  assert.equal(third.status, 200);
  assert.deepEqual(third.body.data.items.map(item => item.id), [ids.a2, ids.a1], '改变 limit 不得重复已读页');

  // ④ 他人不可见：b 只看到自己那条；a 的游标在 b 手里一律 400。
  const otherPage = await http('/me/exports', b.token);
  assert.equal(otherPage.status, 200);
  assert.deepEqual(otherPage.body.data.items.map(item => item.id), [ids.b1]);
  assert.equal(otherPage.body.data.next_cursor, null);

  // ⑤ 游标：跨主体 / 跨登录版本 / 跨列表域 / 过期 / 篡改 / 形状 全部 400 INVALID_CURSOR。
  const crossDomain = await http(`/me/consents?cursor=${encodeURIComponent(cursor)}`, a.token);
  assert.equal(crossDomain.status, 400, '导出游标不得在授权列表上被接受（域分隔）');
  assert.equal(crossDomain.body.error.code, 'INVALID_CURSOR');
  for (const [label, path, token] of [
    ['他人游标', `/me/exports?cursor=${encodeURIComponent(cursor)}`, b.token],
    ['签名被改', `/me/exports?cursor=${encodeURIComponent(cursor.replace(/\.[^.]+$/, '.invalid'))}`, a.token],
    ['只给锚点', `/me/exports?cursor=${encodeURIComponent(Buffer.from(ids.a3).toString('base64url'))}`, a.token],
    ['追加段', `/me/exports?cursor=${encodeURIComponent(cursor + '.extra')}`, a.token],
    ['空游标', '/me/exports?cursor=', a.token],
    ['超长游标（2047，过 schema 但超解码上限）', `/me/exports?cursor=${'x'.repeat(2047)}`, a.token],
    ['登录版本', `/me/exports?cursor=${encodeURIComponent(rewrite(cursor, v => { v.auth_epoch = 2; }))}`, a.token],
    ['列表域', `/me/exports?cursor=${encodeURIComponent(rewrite(cursor, v => { v.kind = 'consents'; }))}`, a.token],
    ['排序域', `/me/exports?cursor=${encodeURIComponent(rewrite(cursor, v => { v.sort = 'granted_at_desc_id_desc'; }))}`, a.token],
    ['已过期', `/me/exports?cursor=${encodeURIComponent(rewrite(cursor, v => { v.expires = Date.now() - 1; }))}`, a.token],
    ['额外字段', `/me/exports?cursor=${encodeURIComponent(rewrite(cursor, v => { v.owner = 'forged'; }))}`, a.token],
  ]) {
    const rejected = await http(path, token);
    assert.equal(rejected.status, 400, `${label} 必须 400`);
    assert.equal(rejected.body.error.code, 'INVALID_CURSOR', `${label} 必须 INVALID_CURSOR`);
  }

  // ⑥ 参数校验 4xx（schema 层，先于读库）。
  for (const query of ['?limit=0', '?limit=51', '?limit=1.5', '?limit=abc', '?unknown=1', `?cursor=${'x'.repeat(2049)}`]) {
    const rejected = await http(`/me/exports${query}`, a.token);
    assert.equal(rejected.status, 400, `${query} 必须 400`);
    assert.equal(rejected.body.error.code, 'INVALID_REQUEST', `${query} 必须 INVALID_REQUEST`);
  }
  assert.equal((await http('/me/exports', null)).status, 401, '无会话必须 401');

  // ⑦ 退出后旧令牌立刻 401（会话在服务端重验，不只看游标绑定）。
  const logout = await http('/auth/logout', a.token, { method: 'POST', headers: { 'idempotency-key': 'exports-logout-a' } });
  assert.equal(logout.status, 200);
  const expired = await http(`/me/exports?cursor=${encodeURIComponent(cursor)}`, a.token);
  assert.equal(expired.status, 401);
  assert.equal(expired.body.error.code, 'SESSION_EXPIRED');

  console.log('PASS loopback HTTP + PGlite limited SET ROLE; envelope/order/pagination/signed-subject-bound cursor/other-user invisibility/no-pool 503/param 4xx; synthetic identity/data only, not native PG17, not real egress, not export-file generation');
});
