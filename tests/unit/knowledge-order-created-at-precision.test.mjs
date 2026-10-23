// GY-I07 / #7 · 亚毫秒（PG 微秒）tie-break：**三面对照**（SQL 直查 == HTTP 分页 == 服务层 list）。
//
// 缺陷（`docs/verification/gy-r33-contract-ledger-20261023.md` §3.6，已复现未修）：
//   两行仅 `created_at` 的微秒部分不同、且 id 顺序与时间顺序相反时，
//   SQL 按全精度给出「时间新的在前」，而旧实现把 timestamptz 解成毫秒 `Date` ⇒ 同刻 ⇒ 退 `id DESC`
//   ⇒ 顺序**相反**。用户裁定：以 SQL 全精度为准（同刻完全相等时才退 id DESC）。
//
// 引擎说明：本文件跑在 **PGlite（内嵌真实 PostgreSQL，WASM）**上 —— 它同样按 PG 的微秒精度存储
// `timestamptz`、同样被 JS 驱动截成毫秒 `Date`，因此上述差异在本文件里**可复现**（不是模拟）。
// 真实 PG 17.11 上的同口径三面对照由本片的一次性真库脚本另行取证（见交接）；本文件的定位是
// 「回归钉子」：谁把读语句里的全精度内部列去掉、或把比较器改回毫秒，这里立即变红。
//
// 四组断言：
//   组1 微秒反序 tie：三面均为 [X, Y]，且响应封套**不新增字段**；
//   组2 毫秒对齐夹具未回归：三面均为 [C, B, A, E, D]（同刻三行仍由 id DESC 决出）；
//   组3 种子归并路径：`extraRows` 的 0/1/3/6 位小数与不可解析行按契约插入、确定性、不抛错；
//   组4 内部列存在性自证：读语句确实投影了 `created_at_micros`（防止"靠毫秒恰好通过"）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createKnowledgeService } from '../../services/api/src/knowledge/service.ts';

const read = (p) => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
const mig = (name) => read('services/api/db/migrations/' + name + '.sql');
/** 0012 之前的迁移链（与既有 knowledge 单元测试同集合）。 */
const PRE_0012 = ['0001_initial_schema', '0002_knowledge_catalog', '0003_privacy_consent',
  '0005_catalog_read_views', '0008_auth_session', '0009_consent_policy', '0010_knowledge_read_views'];
const RUNTIME_ROLE = 'gy_i07_precision_runtime';
/** 响应封套的冻结字段集（组1 用它证明「不新增响应字段」）。 */
const ITEM_KEYS = ['body', 'conditions', 'dose_cards', 'id', 'reference_state', 'revision', 'source', 'title', 'type'];

/** 全精度读数（只在测试侧用 `to_char`；生产读语句用的是 `created_at_micros` 内部列）。 */
const PRECISION_SQL = `SELECT id, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS us
  FROM catalog_read.current_knowledge ORDER BY created_at DESC, id DESC`;
const ORDER_SQL = 'SELECT id FROM catalog_read.current_knowledge ORDER BY created_at DESC, id DESC';

async function fixture() {
  const db = new PGlite();
  const app0 = { app: null, queue: Promise.resolve() };
  try {
    for (const name of PRE_0012) await db.exec(mig(name));
    for (const name of ['auth_privacy', 'knowledge_runtime']) await db.exec(read('services/api/db/roles/' + name + '.sql'));
    await db.exec(mig('0012_knowledge_created_at'));
    await db.exec(`CREATE ROLE ${RUNTIME_ROLE} NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;`
      + ' GRANT gengyun_auth_privacy,gengyun_knowledge_runtime TO ' + RUNTIME_ROLE);
    let queue = Promise.resolve();
    const pool = {
      async connect() {
        const before = queue; let unlock; queue = new Promise((r) => { unlock = r; });
        await before; await db.query('SET ROLE ' + RUNTIME_ROLE);
        return { query: (...a) => db.query(...a), release() { db.query('RESET ROLE').finally(unlock); } };
      },
      async query(...a) { const c = await this.connect(); try { return await c.query(...a); } finally { c.release(); } },
    };
    app0.queue = queue;
    const cursorKey = randomBytes(32).toString('hex');
    const app = buildApp({ config: loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent', SESSION_SIGNING_KEY: cursorKey }), pool });
    app0.app = app;
    await app.listen({ host: '127.0.0.1', port: 0 });
    const origin = 'http://127.0.0.1:' + app.server.address().port;
    const http = async (path, token) => {
      const r = await fetch(origin + '/api/v1' + path, { headers: token ? { authorization: 'Bearer ' + token } : {} });
      return { status: r.status, data: await r.json() };
    };
    let token = null;
    const login = async (code) => {
      const r = await fetch(origin + '/api/v1/auth/wechat', { method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'precision-login-' + code },
        body: JSON.stringify({ code }) });
      assert.equal(r.status, 200, '合成身份登录必须成功（否则夹具不可信）');
      token = (await r.json()).data.access_token;
      return token;
    };
    /** 受鉴权身份：与既有用例同口径（从真实登录落库的会话取 userId/authEpoch/sessionId）。 */
    const identityOf = async (sessionToken) => {
      const account = await db.query('SELECT id,auth_epoch FROM public.users ORDER BY created_at LIMIT 1');
      assert.equal(account.rows.length, 1);
      const session = await db.query("SELECT id FROM public.sessions WHERE audience='user' ORDER BY created_at DESC LIMIT 1");
      assert.equal(session.rows.length, 1);
      return { token: sessionToken, identity: { role: 'user', userId: account.rows[0].id,
        authEpoch: Number(account.rows[0].auth_epoch), sessionId: session.rows[0].id } };
    };
    /** 建来源 + 逐条 (id, created_at)，`created_at` 原样落库（微秒不会被夹具抹平）。 */
    const seed = async (rows) => {
      const admin = randomUUID(), source = randomUUID(), version = randomUUID();
      await db.query('INSERT INTO admin_accounts(id,login_name,credential_hash) VALUES($1,$2,\'synthetic-not-login\')',
        [admin, 'synthetic-precision-' + admin]);
      await db.query("INSERT INTO knowledge_dataset_modes(mode,description,accepts_database,accepts_verified_seed) VALUES('real','precision fixture only',true,true) ON CONFLICT (mode) DO NOTHING");
      await db.query("INSERT INTO knowledge_dataset_config(key,value,mode) VALUES('active_mode','real','real'),('database_connected','true','real') ON CONFLICT (key) DO NOTHING");
      await db.query("INSERT INTO sources(id,title,canonical_url,publisher,source_kind,evidence_kind) VALUES($1,'Precision source','https://example.invalid/precision','Precision publisher','verified_seed','research')", [source]);
      await db.query("INSERT INTO source_versions(id,source_id,version,content_hash,locator,retrieved_at,valid_from,validity,review_status,reviewed_by,reviewed_at) VALUES($1,$2,'precision-v1',repeat('b',64),'synthetic:precision',now(),now()-interval '1 day','valid','verified',$3,now())", [version, source, admin]);
      await db.query('UPDATE sources SET current_version_id=$1 WHERE id=$2', [version, source]);
      for (const [index, row] of rows.entries()) {
        await db.query('INSERT INTO knowledge_versions(id,knowledge_id,revision,title,body,type,source_version_id,crop_ids,species_ids,region_codes,visibility,created_at)'
          + " VALUES($1,$2,1,$3,'Synthetic educational body only','species',$4,'[\"crop_rice\"]','[\"synthetic_weed\"]','[\"330102\"]','published',$5)",
          [randomUUID(), row.id, 'Precision row ' + index, version, row.created_at]);
      }
      return rows;
    };
    /** HTTP 分页次序：逐页拼接（`limit` 控制每页条数，用来真正走 `next_cursor` 分支）。 */
    const httpOrder = async (sessionToken, limit) => {
      const seen = [];
      for (let cursor, pages = 0; pages < 20; pages += 1) {
        const r = await http('/knowledge?limit=' + limit + (cursor === undefined ? '' : '&cursor=' + encodeURIComponent(cursor)), sessionToken);
        assert.equal(r.status, 200, '读路径必须 200：' + String(r.data?.error?.code ?? '') + ' ' + String(r.data?.error?.message ?? ''));
        seen.push(...r.data.data.items);
        cursor = r.data.data.next_cursor;
        if (cursor === null) return seen;
        assert.ok(pages < 19, '不得无限翻页');
      }
      throw new Error('HTTP 分页未收敛');
    };
    const serviceOrder = async (identity, extraRows) => {
      const service = createKnowledgeService(pool, cursorKey, extraRows === undefined ? {} : { extraRows });
      const page = await service.list(identity, { limit: 50 });
      return page.items;
    };
    return { db, pool, app, http, login, identityOf, seed,
      sqlOrder: async () => (await db.query(ORDER_SQL)).rows.map((row) => row.id),
      sqlPrecision: async () => (await db.query(PRECISION_SQL)).rows,
      httpOrder, serviceOrder, cursorKey,
      async close() { await app0.app.close(); await queue; await db.close(); } };
  } catch (error) {
    if (app0.app) await app0.app.close();
    await db.close().catch(() => {});
    throw error;
  }
}

/** 每个子测试独享一个全新隔离库并登录（列表查询面是全局投影，不得跨组共用连接）。 */
async function connected() {
  const f = await fixture();
  const token = await f.login('precision-' + randomUUID());
  return { f, identity: await f.identityOf(token) };
}

test('知识列表亚毫秒 tie-break：SQL 直查 == HTTP 分页 == 服务层 list（微秒为准）', async (t) => {
  await t.test('组1 微秒反序 tie：三面均为 [X, Y]；响应封套不新增字段', async () => {
    const { f, identity } = await connected();
    try {
      // §3.6 夹具：X 的微秒更新（.000500Z），但 id 逐码元低于 Y（aaaa…）⇒ 毫秒口径会把 Y 排前面。
      const X = '11111111-1111-4111-8111-111111111111';
      const Y = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const rows = await f.seed([{ id: X, created_at: '2026-10-20T12:00:00.000500Z' },
        { id: Y, created_at: '2026-10-20T12:00:00.000100Z' }]);
      assert.deepEqual(rows.map((row) => row.id), [X, Y]);

      // ① SQL 直查（全精度）：读数必须是 .000500Z / .000100Z，次序 [X, Y]。
      assert.deepEqual((await f.sqlPrecision()).map((row) => [row.id, row.us]),
        [[X, '2026-10-20T12:00:00.000500Z'], [Y, '2026-10-20T12:00:00.000100Z']],
        'PG 侧必须真的存着微秒差（夹具自证）');
      assert.deepEqual(await f.sqlOrder(), [X, Y], 'SQL 直查次序');

      // ② HTTP 分页（limit=1 ⇒ 真正走两页 + next_cursor）。
      const httpItems = await f.httpOrder(identity.token, 1);
      assert.deepEqual(httpItems.map((item) => item.id), [X, Y], 'HTTP 分页次序必须与 SQL 全精度一致');
      for (const item of httpItems) {
        assert.deepEqual(Object.keys(item).sort(), ITEM_KEYS, '响应封套字段集不得变化（排序键不得外泄）');
        assert.equal(Object.hasOwn(item, 'created_at'), false);
        assert.equal(Object.hasOwn(item, 'created_at_micros'), false);
      }

      // ③ 服务层 list（同一 pool，绕过 HTTP）。
      assert.deepEqual((await f.serviceOrder(identity)).map((item) => item.id), [X, Y], '服务层次序必须与 SQL 全精度一致');
    } finally { await f.close(); }
  });

  await t.test('组2 毫秒对齐夹具未回归：三面均为 [C, B, A, E, D]（同刻三行仍 id DESC）', async () => {
    const { f, identity } = await connected();
    try {
      const rows = [
        { id: 'c0000000-0000-4000-8000-00000000000c', created_at: '2026-10-22T00:00:00Z' },
        { id: 'bbbbbbbb-0000-4000-8000-00000000000b', created_at: '2026-10-20T12:00:00Z' },
        { id: 'aaaaaaaa-0000-4000-8000-00000000000a', created_at: '2026-10-20T12:00:00Z' },
        { id: '5e5e5e5e-0000-4000-8000-000000000005', created_at: '2026-10-20T12:00:00Z' },
        { id: 'dddddddd-0000-4000-8000-00000000000d', created_at: '2026-10-19T00:00:00Z' },
      ];
      await f.seed(rows);
      const expected = [rows[0].id, rows[1].id, rows[2].id, rows[3].id, rows[4].id];
      assert.deepEqual(await f.sqlOrder(), expected, 'SQL 直查（同刻由 id DESC 决出）');
      assert.deepEqual((await f.httpOrder(identity.token, 2)).map((item) => item.id), expected, 'HTTP 两页拼接');
      assert.deepEqual((await f.serviceOrder(identity)).map((item) => item.id), expected, '服务层 list');
    } finally { await f.close(); }
  });

  await t.test('组3 种子归并：0/1/3/6 位小数 + 不可解析行按契约插入、确定性、不抛错', async () => {
    const { f, identity } = await connected();
    try {
      // DB 行：整毫秒，作为「刻度」。种子行在同一秒内以 1 微秒/1 毫秒级插值。
      const base = '00000000-0000-4000-8000-000000000010';
      await f.seed([{ id: base, created_at: '2026-10-20T12:00:00.000300Z' }]);
      const seedRow = (id, created_at) => ({ id, created_at, updated_at: '2026-10-20T12:00:00.000Z', revision: 1,
        title: 'Seed ' + id, body: 'Synthetic seed body only', type: 'species', source_id: randomUUID(),
        source_version: 'seed-v1', source_title: 'Seed source', url: 'https://example.invalid/seed',
        publisher: 'Seed publisher', source_kind: 'verified_seed', evidence_kind: 'research',
        review_status: 'unverified', crop_ids: ['crop_rice'], species_ids: ['synthetic_weed'], region_codes: ['330102'] });
      const extraRows = () => [
        seedRow('aaaaaaaa-0000-4000-8000-0000000000f1', '2026-10-20T12:00:00.000100Z'), // 3 位，早于 DB 行
        seedRow('bbbbbbbb-0000-4000-8000-0000000000f2', '2026-10-20T12:00:00.0005Z'),   // 4 位，晚于 DB 行
        seedRow('cccccccc-0000-4000-8000-0000000000f3', '2026-10-20T12:00:00Z'),        // 0 位
        seedRow('dddddddd-0000-4000-8000-0000000000f4', '2026-10-20T12:00:00.0Z'),      // 1 位
        seedRow('eeeeeeee-0000-4000-8000-0000000000f5', 'not-a-date'),                  // 不可解析
        seedRow('ffffffff-0000-4000-8000-0000000000f6', null),                          // null
      ];
      const first = await f.serviceOrder(identity, extraRows);
      const second = await f.serviceOrder(identity, extraRows);
      const ids = first.map((item) => item.id);
      assert.deepEqual(ids, second.map((item) => item.id), '同一份快照必须恒得同一次序（确定性）');
      // 期望：5e-4(种子) > 3e-4(DB) > 1e-4(种子) > 0(种子，0/1 位两行同刻 ⇒ id DESC) > 不可解析组(id DESC)。
      assert.deepEqual(ids, ['bbbbbbbb-0000-4000-8000-0000000000f2', base,
        'aaaaaaaa-0000-4000-8000-0000000000f1', 'dddddddd-0000-4000-8000-0000000000f4',
        'cccccccc-0000-4000-8000-0000000000f3', 'ffffffff-0000-4000-8000-0000000000f6',
        'eeeeeeee-0000-4000-8000-0000000000f5'], '种子行的微秒必须与 DB 行的微秒同尺度比较');
    } finally { await f.close(); }
  });

  await t.test('组4 内部列自证：读语句确实投影 created_at_micros（防"靠毫秒恰好通过"）', async () => {
    const source = read('services/api/src/knowledge/service.ts');
    assert.equal(source.includes('AS created_at_micros'), true,
      '读语句必须投影内部微秒列（否则同毫秒 tie 又会退回 id DESC）');
    assert.equal(source.includes('ORDER BY created_at DESC, id DESC'), true,
      '冻结契约的 ORDER BY 子句必须仍在（内部列不得替代 SQL 侧排序）');
    // 微秒列必须是「与 SQL 同源」的表达式，而不是 JS 侧再算一遍毫秒。
    assert.equal(/extract\(epoch from created_at\)/.test(source), true, '微秒键必须由 SQL 从同一列取全精度');
  });
});
