// GY-I19（#19）· `GET /me/exports`（契约 `listExports`）的**隐私红线**验收。
//
// 与 `tests/unit/exports-route-http.test.mjs` 的分工（两片不重复，各自钉不同的东西）：
//   · 那片钉**契约外形**：封套/排序/分页/游标签名绑定/参数 4xx/会话重验；
//   · 本片钉**隐私与 fail-closed 红线**，逐条对应派单要求：
//       ① 本人可导出 —— 期望键集/枚举**从 `packages/contracts/openapi.json` 现读**，不手抄常量；
//       ② 他人不可 —— b 只看到自己那几行，a 的游标在 b 手里被拒；
//       ③ ⛔ 不许接受任意 userId 参数越权导出 —— `?user_id=`/`?userId=`/`?owner_id=` 一律 400，
//          永不 200（身份只来自服务端会话存储，查询串里没有"用户"维度）；
//       ④ 未接线/无池 fail-closed —— 无池 503、运行时角色缺 `public.exports` 读面 503、
//          签名密钥缺失 503；**且**同样一件实例在"通但空"时是 200 空页 ⇒ 503 不是空页的伪装；
//       ⑤ 响应里**没有**内部列/密文/令牌（黑名单断言，含真实插入的哨兵值）。
//
// 合成资料：账号由 stub 微信登录生成，导出行为本测试插入的合成行；**不是**原生 PG17、
// 不是真实外发、也不证明"导出文件生成"（本 operation 只描述外发账本条目）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';
import { createExportsListService } from '../../services/api/src/privacy/exports-list.ts';

const KEY = 'synthetic-exports-privacy-key';
const readText = url => readFileSync(url, 'utf8');
/** 契约原文（期望形状的唯一来源：契约改了键集/枚举，本测试跟着变，不靠手抄常量自证）。 */
const CONTRACT = JSON.parse(readText(new URL('../../packages/contracts/openapi.json', import.meta.url)));
const SCHEMAS = CONTRACT.components.schemas;
const ITEM_KEYS = Object.keys(SCHEMAS.Export.properties).sort();
const ITEM_REQUIRED = [...SCHEMAS.Export.required].sort();
const OBJECT_REF_KEYS = Object.keys(SCHEMAS.TargetRef.properties).sort();
const TARGET_TYPES = SCHEMAS.TargetRef.properties.type.enum;
const PURPOSES = SCHEMAS.ConsentPurpose.enum;
const EXPORT_STATES = SCHEMAS.Export.properties.state.enum;
const THIRD_PARTY_STATES = SCHEMAS.ThirdPartyState.enum;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/** `exports` 表里有、但契约 `Export` 里**没有**的内部列名：一个都不许出现在响应里。 */
const INTERNAL_KEYS = [
  'user_id', 'userId', 'auth_epoch', 'authEpoch',
  'recipient_config_version', 'recipientConfigVersion', 'required_consents',
  'consent_id', 'consentId', 'object_key', 'objectKey', 'source_version', 'sourceVersion',
  'provider_request_ref_cipher', 'error_code', 'errorCode',
  'job_id', 'jobId', 'cancelled_at', 'cancellation_reason', 'requested_at', 'updated_at',
];
/** 凭据/去身份线索类字段：任何形态都不许借这个接口出去。 */
const SECRET_KEYS = [
  'sessionSigningKey', 'session_signing_key', 'access_token', 'refresh_token', 'token_hash',
  'password', 'secret', 'author_id', 'authorId', 'anonymized_author_ref',
  'objectStorageKey', 'storage_key', 'signed_url', 'signedUrl',
];
/** 插入账本行的哨兵值：这些**必须**留在库里，不得进响应（响应里出现即红线）。 */
const MARKERS = Object.freeze({
  configVersion: 'cfg-MARKER-7f3a',
  sourceVersion: 'src-MARKER-2b91',
  providerRef: 'cipher-MARKER-94de',
  consentId: 'cccccccc-7777-4777-8777-777777777777',
});

const config = (extra = {}) => ({
  ...loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent', ...extra }),
  sessionSigningKey: KEY,
});
const dbFile = name => readText(new URL('../../services/api/db/' + name, import.meta.url));

/**
 * 真库臂的连接池包装：每条连接先 `SET ROLE`，释放时 `RESET ROLE`。
 * 角色由**测试自己**建（`roles/auth_privacy.sql` 只授 `exports.user_id` 一列），因此能如实复现
 * 「运行时角色对 `public.exports` 没有读面 ⇒ 42501 ⇒ 503」这一现状。
 */
function makePool(db, role) {
  let queue = Promise.resolve();
  const pool = {
    async connect() {
      const before = queue;
      let unlock;
      queue = new Promise(resolve => { unlock = resolve; });
      await before;
      await db.query(`SET ROLE ${role}`);
      return { query: (...args) => db.query(...args), release() { db.query('RESET ROLE').finally(unlock); } };
    },
    async query(...args) {
      const client = await this.connect();
      try { return await client.query(...args); } finally { client.release(); }
    },
  };
  return { pool, drained: () => queue };
}

test('① 未接线（无连接池）⇒ 503 PROVIDER_UNAVAILABLE，且不拿空清单冒充成功', async t => {
  const app = buildApp({ config: config(), pool: null });
  t.after(() => app.close());
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  const login = await fetch(base + '/auth/wechat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'exports-redlines-nopool-login' },
    body: JSON.stringify({ code: 'synthetic-redlines-nopool' }),
  });
  assert.equal(login.status, 200);
  const token = (await login.json()).data.access_token;

  // 鉴权先于"后端未配置"：未登录 401，不泄露"能力存在但不可用"。
  const anonymous = await fetch(base + '/me/exports');
  assert.equal(anonymous.status, 401);
  assert.equal((await anonymous.json()).error.code, 'SESSION_REQUIRED');

  const response = await fetch(base + '/me/exports', { headers: { authorization: `Bearer ${token}` } });
  const raw = await response.text();
  assert.equal(response.status, 503);
  const body = JSON.parse(raw);
  assert.equal(body.error.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(body.error.retryable, false, '未接线属能力未装配，不得标可重试');
  assert.equal(body.data, undefined, '⛔ 503 上不得附带成功封套');
  assert.equal(raw.includes('"items"'), false, '⛔ 不得用 {items:[]} 冒充"你没有导出记录"');
  assert.equal(raw.includes('"next_cursor"'), false);
});

test('④ 签名配置缺失 ⇒ 503，且一次都不触库（不降级成无签名游标）', async () => {
  let touched = 0;
  const probePool = { async query() { touched += 1; throw new Error('本臂不应触库'); } };
  const service = createExportsListService({ pool: probePool, hmacKey: '' });
  await assert.rejects(
    () => service.list({ userId: 'aaaaaaaa-0000-4000-8000-000000000001', authEpoch: 1 }, { limit: 20 }),
    error => error.code === 'PROVIDER_UNAVAILABLE' && error.status === 503,
  );
  assert.equal(touched, 0, '签名密钥不可用时必须在读库之前就 fail-closed');
});

test('②③⑤ 真库臂：未授权读面 503 → 本人可导出 → 他人不可 → 拒任意 userId 参数 → 无内部列/密文', async t => {
  const db = new PGlite();
  const role = 'gy_exports_privacy_runtime';
  const { pool, drained } = makePool(db, role);
  let app;
  t.after(async () => { await app?.close(); await drained(); await db.close(); });
  for (const name of ['0001_initial_schema', '0003_privacy_consent', '0008_auth_session']) {
    await db.exec(dbFile(`migrations/${name}.sql`));
  }
  await db.exec(dbFile('roles/auth_privacy.sql'));
  await db.exec(`CREATE ROLE ${role} NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; GRANT gengyun_auth_privacy TO ${role}`);

  app = buildApp({ config: config(), pool });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  const http = async (path, token, options = {}) => {
    const response = await fetch(base + path, {
      ...options,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...options.headers },
    });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) };
  };
  async function login(code) {
    const response = await http('/auth/wechat', null, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `redlines-login-${code}` },
      body: JSON.stringify({ code }),
    });
    assert.equal(response.status, 200);
    const token = response.body.data.access_token;
    await drained();
    const row = (await db.query("SELECT user_id FROM sessions WHERE token_hash=decode($1,'hex')", [hashToken(token)])).rows[0];
    return { id: row.user_id, token };
  }
  const a = await login('synthetic-redlines-a');
  const b = await login('synthetic-redlines-b');

  // ── ④ 未接线：运行时角色只有 `exports.user_id` 一列读面（`roles/auth_privacy.sql` 现状）⇒ 503。
  //     注意这与"空清单"必须可区分：下面补授权后同一实例给出 200 空页。
  const unwired = await http('/me/exports', a.token);
  assert.equal(unwired.status, 503, '运行时角色缺 public.exports 读面时必须 503，不得 200 空页');
  assert.equal(unwired.body.error.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(unwired.body.error.retryable, false);
  assert.equal(unwired.body.data, undefined);

  await db.exec('GRANT SELECT ON public.exports TO gengyun_auth_privacy');

  // 同一实例：账本读得到、但这个用户没有导出记录 ⇒ 200 空页（空数据 ≠ 未接线）。
  const empty = await http('/me/exports', a.token);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.data.items, []);
  assert.equal(empty.body.data.next_cursor, null);

  // 合成账本行：a 两条（一条已外发带 sent_at、一条 reserved），b 一条。
  const rows = [
    {
      id: 'aaaaaaaa-1111-4111-8111-000000000001', userId: a.id, objectType: 'media', purpose: 'external_inference',
      objectId: '11111111-1111-4111-8111-111111111111', recipient: 'synthetic-vendor-a', state: 'sent',
      sentAt: '2026-10-02T03:04:05Z', createdAt: '2026-10-02T03:00:00Z',
    },
    {
      id: 'aaaaaaaa-1111-4111-8111-000000000002', userId: a.id, objectType: 'media', purpose: 'media_processing',
      objectId: '22222222-2222-4222-8222-222222222222', recipient: 'synthetic-vendor-b', state: 'reserved',
      sentAt: null, createdAt: '2026-10-01T00:00:00Z',
    },
    {
      id: 'bbbbbbbb-1111-4111-8111-000000000001', userId: b.id, objectType: 'media', purpose: 'media_processing',
      objectId: '33333333-3333-4333-8333-333333333333', recipient: 'synthetic-vendor-c', state: 'failed',
      sentAt: null, createdAt: '2026-10-03T00:00:00Z',
    },
  ];
  for (const row of rows) {
    await db.query(
      `INSERT INTO exports(id,user_id,object_type,object_id,object_revision,purpose,consent_id,consent_epoch,
         required_consents,recipient_id,recipient_config_version,source_version,provider_request_ref_cipher,
         state,sent_at,auth_epoch,created_at)
       VALUES($1,$2,$3,$4,1,$5,$6,1,$7,$8,$9,$10,$11,$12,$13,1,$14)`,
      [row.id, row.userId, row.objectType, row.objectId, row.purpose, MARKERS.consentId,
        JSON.stringify({ media_processing: 1 }), row.recipient, MARKERS.configVersion,
        MARKERS.sourceVersion, MARKERS.providerRef, row.state, row.sentAt, row.createdAt],
    );
  }

  // ── ① 本人可导出：键集/枚举/必填**逐项对着契约文件**核。
  const mine = await http('/me/exports?limit=20', a.token);
  assert.equal(mine.status, 200);
  assert.equal(mine.body.data.items.length, 2, '只应看到自己的 2 条');
  assert.equal(mine.body.data.next_cursor, null);
  assert.deepEqual(mine.body.data.items.map(item => item.id), [
    'aaaaaaaa-1111-4111-8111-000000000001',
    'aaaaaaaa-1111-4111-8111-000000000002',
  ], 'created_at DESC, id DESC');
  for (const item of mine.body.data.items) {
    assert.deepEqual(Object.keys(item).sort(), ITEM_KEYS, 'Export 键集必须与契约 properties 逐项相同');
    // 契约自身的一致性（required ⊆ properties）也顺带核一遍：缺了它，「键集相同」可能掩盖必填项被降级成可选。
    for (const key of ITEM_REQUIRED) assert.ok(ITEM_KEYS.includes(key), `契约 required 键 ${key} 不在 properties 里`);
    for (const key of ITEM_REQUIRED) assert.ok(key in item, `契约必填键缺失：${key}`);
    assert.deepEqual(Object.keys(item.object_ref).sort(), OBJECT_REF_KEYS);
    assert.match(item.id, UUID, 'id 必须是 uuid');
    assert.match(item.object_ref.id, UUID, 'object_ref.id 必须是 uuid');
    assert.ok(Number.isInteger(item.object_ref.revision) && item.object_ref.revision >= 1);
    assert.ok(TARGET_TYPES.includes(item.object_ref.type), `object_ref.type 必须是契约枚举：${item.object_ref.type}`);
    assert.ok(PURPOSES.includes(item.purpose), `purpose 必须是契约枚举：${item.purpose}`);
    assert.ok(EXPORT_STATES.includes(item.state), `state 必须是契约枚举：${item.state}`);
    assert.ok(THIRD_PARTY_STATES.includes(item.deletion_state), `deletion_state 必须是契约枚举：${item.deletion_state}`);
    assert.ok(Number.isInteger(item.consent_epoch) && item.consent_epoch >= 1);
    assert.ok(item.recipient_id.length >= 1 && item.recipient_id.length <= 80);
    assert.ok(item.sent_at === null || DATE_TIME.test(item.sent_at), `sent_at 必须是 date-time 或 null：${item.sent_at}`);
  }
  const sent = mine.body.data.items[0];
  const reserved = mine.body.data.items[1];
  assert.equal(sent.state, 'sent');
  assert.equal(sent.sent_at, '2026-10-02T03:04:05.000Z', 'sent_at 如实透出（不是恒定 null）');
  assert.equal(sent.recipient_id, 'synthetic-vendor-a');
  assert.equal(sent.purpose, 'external_inference');
  assert.equal(sent.object_ref.id, '11111111-1111-4111-8111-111111111111');
  assert.equal(reserved.state, 'reserved');
  assert.equal(reserved.sent_at, null);

  // ── ② 他人不可：b 只看到自己那条；两条臂交叉验证"归属由会话决定，不由参数决定"。
  const otherPage = await http('/me/exports', b.token);
  assert.equal(otherPage.status, 200);
  assert.deepEqual(otherPage.body.data.items.map(item => item.id), ['bbbbbbbb-1111-4111-8111-000000000001']);
  assert.equal(otherPage.body.data.next_cursor, null);
  assert.equal(otherPage.text.includes(a.id), false, 'b 的响应里不得出现 a 的用户 id');
  assert.equal(otherPage.text.includes('synthetic-vendor-a'), false, 'b 不得看到 a 的外发记录');
  assert.equal(mine.text.includes(b.id), false, 'a 的响应里不得出现 b 的用户 id');

  // ── ③ 不接受任意 userId 参数：查询串 schema `additionalProperties:false` ⇒ 400，永不 200，也永不越权。
  for (const query of [`?user_id=${b.id}`, `?userId=${b.id}`, `?owner_id=${b.id}`, `?user=a`, `?limit=20&user_id=${b.id}`]) {
    const rejected = await http(`/me/exports${query}`, a.token);
    assert.equal(rejected.status, 400, `${query} 必须被拒（身份不得来自查询参数）`);
    assert.equal(rejected.body.error.code, 'INVALID_REQUEST', `${query} 必须是 INVALID_REQUEST`);
    assert.equal(rejected.body.data, undefined, `${query} 不得返回任何清单`);
  }

  // ── ⑤ 黑名单：内部列名 + 凭据类字段 + 真实插入的哨兵值，一个都不许出现在响应字节里。
  for (const raw of [mine.text, otherPage.text, empty.text ?? '']) {
    for (const key of [...INTERNAL_KEYS, ...SECRET_KEYS]) {
      assert.equal(raw.includes(`"${key}"`), false, `响应里不得出现内部/凭据字段「${key}」`);
    }
    for (const [name, marker] of Object.entries(MARKERS)) {
      assert.equal(raw.includes(marker), false, `哨兵「${name}」的库内值不得进响应：${marker}`);
    }
    assert.equal(raw.includes(KEY), false, '会签密钥不得进响应');
    assert.equal(raw.includes(a.token), false, '会话令牌不得进响应');
    assert.equal(raw.includes(hashToken(a.token)), false, '令牌摘要不得进响应');
  }

  console.log('PASS privacy redlines: no-pool 503/no empty-page spoof/signed-key fail-closed/contract-read key set+enums/owner isolation/arbitrary-userId rejected/internal-column+marker blacklist; synthetic identity/data only, not native PG17, not real egress');
});
