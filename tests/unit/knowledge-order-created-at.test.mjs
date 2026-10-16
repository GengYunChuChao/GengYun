// GY-I07 · 知识列表排序契约落地（created_at DESC, id DESC）——真实投影 + 真实 HTTP 读取。
// 全部记录与身份均为合成数据，跑在内存 PostgreSQL 引擎（PGlite）的全新隔离库上；
// 不连接真实 PG、不读任何生产凭据，也不主张目标 PostgreSQL 17.11 的部署验收。
//
// 覆盖三组 + 反向控制：
//   组1（排序）：列表次序 = (created_at DESC, id DESC)，且排序键不出现在响应封套里；
//   组2（翻页稳定性）：逐页拼接 = 整体次序，无重复无空洞，固定 15 分钟截止不滑动；
//   组3（回填确定性）：0012 对历史行的回填是单一冻结常量、与运行时刻无关、重放不改写；
//   反向控制：游标自述排序被写死绑定，id_asc 自述的旧游标必须被拒（改回 id_asc 即变红）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID, randomBytes, createHmac } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';

const read = (p) => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
const mig = (name) => read('services/api/db/migrations/' + name + '.sql');
/** 0012 之前的迁移链（与既有 knowledge 单元测试同集合）。 */
const PRE_0012 = ['0001_initial_schema', '0002_knowledge_catalog', '0003_privacy_consent',
  '0005_catalog_read_views', '0008_auth_session', '0009_consent_policy', '0010_knowledge_read_views'];
/** 0012 第 2 节的确定性回填常量（= 浙江首批批次日期；⛔ 不得改成运行期时钟）。 */
const BACKFILL = '2026-10-14T00:00:00Z';
const iso = (v) => new Date(v).toISOString();
/** 固定 UUID（仅小写十六进制，满足游标 after 的 UUID 校验）——让「id 升序」与契约序**逐位可分辨**。 */
const uid = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
/** 冻结契约排序 (created_at DESC, id DESC) 的独立实现：不复用被测代码。 */
function order(pairs) {
  return [...pairs]
    .sort((a, b) => (iso(a[0]) === iso(b[0]) ? 0 : iso(a[0]) > iso(b[0]) ? -1 : 1) || (a[1] > b[1] ? -1 : a[1] < b[1] ? 1 : 0))
    .map((p) => p[1]);
}
/** `res` 是 http 助手的 `{status,data}`；响应体形如 `{data:{items,next_cursor}}`。 */
const pageOf = (res) => res.data.data.items.map((x) => x.id);
const cursorValue = (cursor) => JSON.parse(Buffer.from(cursor.split('.')[0], 'base64url').toString('utf8'));

/** 与 knowledge-api.test.mjs 同构的最小装配：真实 HTTP + 受限运行期角色（无旁路读私表）。 */
async function fixture() {
  const db = new PGlite();
  // 真实落库顺序：0010 → 角色脚本（建立运行期只读 GRANT）→ 0012。
  // 顺序本身也是断言的一部分：0012 用 CREATE OR REPLACE VIEW，视图 ACL 必须存活。
  for (const name of PRE_0012) await db.exec(mig(name));
  for (const name of ['auth_privacy', 'knowledge_runtime']) await db.exec(read('services/api/db/roles/' + name + '.sql'));
  await db.exec(mig('0012_knowledge_created_at'));
  await db.exec('CREATE ROLE gy_i07_order_runtime NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;'
    + ' GRANT gengyun_auth_privacy,gengyun_knowledge_runtime TO gy_i07_order_runtime');
  let queue = Promise.resolve();
  const pool = {
    async connect() {
      const before = queue; let unlock; queue = new Promise((r) => { unlock = r; });
      await before; await db.query('SET ROLE gy_i07_order_runtime');
      return { query: (...a) => db.query(...a), release() { db.query('RESET ROLE').finally(unlock); } };
    },
    async query(...a) { const c = await this.connect(); try { return await c.query(...a); } finally { c.release(); } },
  };
  const cursorKey = randomBytes(32).toString('hex');
  const app = buildApp({ config: loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent', SESSION_SIGNING_KEY: cursorKey }), pool });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const origin = 'http://127.0.0.1:' + app.server.address().port;
  const http = async (path, token) => {
    const r = await fetch(origin + '/api/v1' + path, { headers: token ? { authorization: 'Bearer ' + token } : {} });
    return { status: r.status, data: await r.json(), etag: r.headers.get('etag') };
  };
  /** 与既有 knowledge-api.test.mjs 同口径：显式断言 200 并打印错误码，避免"未配置库"被当成排序失败。 */
  const ok = async (path, token) => {
    const r = await http(path, token);
    assert.equal(r.status, 200, path + ' ⇒ ' + String(r.data?.error?.code) + ' ' + String(r.data?.error?.message));
    return r;
  };
  let token = null;
  async function login(code) {
    const r = await fetch(origin + '/api/v1/auth/wechat', { method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'order-login-' + code },
      body: JSON.stringify({ code }) });
    assert.equal(r.status, 200);
    token = (await r.json()).data.access_token;
    return token;
  }
  /** 建来源 + 逐条 (created_at, 标题)，返回按契约排序的期望 id 序列。 */
  async function seed(rows) {
    const admin = randomUUID(), source = randomUUID(), version = randomUUID();
    await db.query('INSERT INTO admin_accounts(id,login_name,credential_hash) VALUES($1,$2,\'synthetic-not-login\')',
      [admin, 'synthetic-order-' + admin]);
    await db.query("INSERT INTO knowledge_dataset_modes(mode,description,accepts_database,accepts_verified_seed) VALUES('real','synthetic fixture only',true,true) ON CONFLICT (mode) DO NOTHING");
    await db.query("INSERT INTO knowledge_dataset_config(key,value,mode) VALUES('active_mode','real','real'),('database_connected','true','real') ON CONFLICT (key) DO NOTHING");
    await db.query("INSERT INTO sources(id,title,canonical_url,publisher,source_kind,evidence_kind) VALUES($1,'Synthetic order source','https://example.invalid/synthetic','Synthetic publisher','verified_seed','research')", [source]);
    await db.query("INSERT INTO source_versions(id,source_id,version,content_hash,locator,retrieved_at,valid_from,validity,review_status,reviewed_by,reviewed_at) VALUES($1,$2,'synthetic-v1',repeat('a',64),'synthetic:order',now(),now()-interval '1 day','valid','verified',$3,now())", [version, source, admin]);
    await db.query('UPDATE sources SET current_version_id=$1 WHERE id=$2', [version, source]);
    const ids = [];
    for (const [i, row] of rows.entries()) {
      const id = row.id ?? randomUUID();
      ids.push(id);
      await db.query('INSERT INTO knowledge_versions(id,knowledge_id,revision,title,body,type,source_version_id,crop_ids,species_ids,region_codes,visibility,created_at)'
        + " VALUES($1,$2,1,$3,'Synthetic educational body only','species',$4,'[\"crop_rice\"]','[\"synthetic_weed\"]','[\"330102\"]','published',$5)",
        [randomUUID(), id, row.title ?? 'Synthetic row ' + i, version, row.created_at]);
    }
    return { source, version, ids, expected: order(rows.map((row, i) => [row.created_at, ids[i]])) };
  }
  return { db, pool, app, http, ok, login, seed, cursorKey, token: () => token,
    async close() { await app.close(); await queue; await db.close(); } };
}

/**
 * 每个子测试独享一个全新隔离库并登录：列表查询面是**全局投影**，
 * 同一库里前一组播种的行会进入后一组的列表，故不得跨组共用连接。
 */
async function connected() {
  const f = await fixture();
  await f.login('synthetic-order-' + randomUUID());
  return f;
}

test('知识列表排序契约：created_at DESC, id DESC（真实投影 + 真实 HTTP）', async (t) => {
  await t.test('组1 排序：created_at 降序、同刻按 id 降序；排序键不进入响应封套', async () => {
    const f = await connected();
    try {
      const s = await f.seed([
        { id: uid(1), title: 'Synthetic oldest', created_at: '2026-10-11T00:00:00Z' },
        { id: uid(2), title: 'Synthetic newest', created_at: '2026-10-14T00:00:00Z' },
        { id: uid(3), title: 'Synthetic tie-a', created_at: '2026-10-12T00:00:00Z' },
        { id: uid(4), title: 'Synthetic tie-b', created_at: '2026-10-12T00:00:00Z' },
      ]);
      const got = await f.ok('/knowledge?limit=50', f.token());
      assert.deepEqual(pageOf(got), s.expected, '列表次序必须是 (created_at DESC, id DESC)');
      // 同刻两行（tie-a/tie-b）必须由 id DESC 决定 ⇒ 钉住第二分量；id 升序会给出 [1,2,3,4]。
      assert.deepEqual(s.expected, [uid(2), uid(4), uid(3), uid(1)]);
      assert.equal(got.data.data.items[0].title, 'Synthetic newest', '首项必须是 created_at 最新项');
      assert.equal(got.data.data.items.at(-1).title, 'Synthetic oldest');
      for (const item of got.data.data.items) {
        assert.equal(Object.hasOwn(item, 'created_at'), false, '内部排序键不得进入响应');
        assert.equal(Object.hasOwn(item.source, 'created_at'), false);
      }
    } finally { await f.close(); }
  });

  await t.test('组2 翻页稳定性：逐页拼接 = 整体次序，无重复无空洞，15 分钟截止不滑动', async () => {
    const f = await connected();
    try {
      const s = await f.seed([
        { id: uid(11), title: 'Synthetic p1', created_at: '2026-10-10T00:00:00Z' },
        { id: uid(12), title: 'Synthetic p2', created_at: '2026-10-13T00:00:00Z' },
        { id: uid(13), title: 'Synthetic p3', created_at: '2026-10-13T00:00:00Z' },
        { id: uid(14), title: 'Synthetic p4', created_at: '2026-10-09T00:00:00Z' },
        { id: uid(15), title: 'Synthetic p5', created_at: '2026-10-12T00:00:00Z' },
      ]);
      assert.deepEqual(s.expected, [uid(13), uid(12), uid(15), uid(11), uid(14)]);
      const seen = [], deadlines = [];
      let cursor, pages = 0;
      for (;;) {
        const r = await f.ok('/knowledge?limit=2' + (cursor === undefined ? '' : '&cursor=' + encodeURIComponent(cursor)), f.token());
        seen.push(...pageOf(r));
        cursor = r.data.data.next_cursor;
        if (cursor === null) break;
        const value = cursorValue(cursor);
        assert.equal(value.sort, 'created_at_desc', '游标自述排序必须与实现一致');
        deadlines.push(value.expires);
        pages += 1;
        assert.ok(pages < 10, '不得无限翻页');
      }
      assert.deepEqual(seen, s.expected, '逐页拼接必须等于契约排序的整体次序');
      assert.equal(new Set(seen).size, seen.length, '不得跨页重复');
      assert.equal(seen.length, s.ids.length, '不得有空洞');
      assert.equal(deadlines.length, 2);
      assert.equal(new Set(deadlines).size, 1, '后续页必须沿用第一页的固定截止（非滑动）');
    } finally { await f.close(); }
  });

  await t.test('反向控制：排序绑定写死后，id_asc 自述的旧游标必须被拒（改回 id_asc 即变红）', async () => {
    const f = await connected();
    try {
      const s = await f.seed([
        { id: uid(21), title: 'Synthetic r1', created_at: '2026-10-01T00:00:00Z' },
        { id: uid(22), title: 'Synthetic r2', created_at: '2026-10-02T00:00:00Z' },
        { id: uid(23), title: 'Synthetic r3', created_at: '2026-10-03T00:00:00Z' },
      ]);
      const first = await f.ok('/knowledge?limit=1', f.token());
      const cursor = first.data.data.next_cursor;
      assert.ok(cursor);
      const value = cursorValue(cursor);
      assert.equal(value.sort, 'created_at_desc', '游标必须自述新排序（写死绑定；退回 id_asc 时该断言即变红）');
      const resign = (payload) => {
        const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
        return encoded + '.' + createHmac('sha256', f.cursorKey).update('knowledge-list/v1\n' + encoded).digest('base64url');
      };
      const stale = await f.http('/knowledge?limit=1&cursor=' + encodeURIComponent(resign({ ...value, sort: 'id_asc' })), f.token());
      assert.equal(stale.status, 400);
      assert.equal(stale.data.error.code, 'INVALID_CURSOR');
      assert.deepEqual(pageOf(first), [s.expected[0]], '首页首项必须是 created_at 最新项（id_asc 会给出另一项）');
      assert.deepEqual(pageOf(first), [uid(23)], 'id_asc 首项应为 uid(21)，故本条同时钉住排序方向');
    } finally { await f.close(); }
  });

  await t.test('组3 回填确定性：0012 对历史行的回填是单一冻结常量、与运行时刻无关、重放不改写', async () => {
    // 单独重放「0012 之前 → 建历史行 → 0012」，以真正走到回填语句（fixture 里已跑过 0012，故另起一库）。
    const db = new PGlite();
    try {
      for (const name of PRE_0012) await db.exec(mig(name));
      for (const name of ['auth_privacy', 'knowledge_runtime']) await db.exec(read('services/api/db/roles/' + name + '.sql'));
      await db.query("INSERT INTO admin_accounts(id,login_name,credential_hash) VALUES($1,'synthetic-backfill-reviewer','synthetic-not-login')", [randomUUID()]);
      const source = randomUUID(), version = randomUUID();
      await db.query("INSERT INTO sources(id,title,canonical_url,publisher,source_kind,evidence_kind) VALUES($1,'Synthetic backfill source','https://example.invalid/synthetic','Synthetic publisher','verified_seed','research')", [source]);
      await db.query("INSERT INTO source_versions(id,source_id,version,content_hash,locator,retrieved_at,valid_from,validity,review_status) VALUES($1,$2,'synthetic-v1',repeat('c',64),'synthetic:backfill','2026-10-14',now()-interval '1 day','valid','verified')", [version, source]);
      await db.query('UPDATE sources SET current_version_id=$1 WHERE id=$2', [version, source]);
      for (let i = 0; i < 3; i++) {
        await db.query("INSERT INTO knowledge_versions(id,knowledge_id,revision,title,body,type,source_version_id,visibility) VALUES($1,$2,1,$3,'Synthetic educational body only','species',$4,'published')",
          [randomUUID(), randomUUID(), 'Synthetic historical ' + i, version]);
      }
      // 回填前提：0012 之前没有该列（列缺失证明"历史行无创建时点"这一阻塞事实）。
      await assert.rejects(db.query('SELECT created_at FROM public.knowledge_versions'),
        (e) => e.code === '42703', '0012 之前不得存在 created_at 列');
      assert.equal((await db.query('SELECT count(*)::int AS n FROM public.knowledge_versions')).rows[0].n, 3);
      await db.exec(mig('0012_knowledge_created_at'));
      const after = await db.query('SELECT created_at, count(*)::int AS n FROM public.knowledge_versions GROUP BY created_at');
      assert.equal(after.rows.length, 1, '全部历史行必须回填到**同一个**值（单一常量，非逐行当前时间）');
      assert.equal(iso(after.rows[0].created_at), iso(BACKFILL), '回填值必须是冻结的批次日期常量');
      assert.equal(after.rows[0].n, 3);
      const column = (await db.query("SELECT is_nullable,column_default FROM information_schema.columns WHERE table_name='knowledge_versions' AND column_name='created_at'")).rows[0];
      assert.equal(column.is_nullable, 'NO', '排序键不得可空');
      assert.equal(column.column_default, 'clock_timestamp()');
      const index = (await db.query("SELECT indexdef FROM pg_indexes WHERE indexname='knowledge_versions_created_idx'")).rows[0].indexdef;
      assert.match(index, /\(created_at DESC, knowledge_id DESC\)/);
      // 新行落表默认（不影响已回填历史行）：不显式给 created_at 也能写入。
      await db.query("INSERT INTO knowledge_versions(id,knowledge_id,revision,title,body,type,source_version_id,visibility) VALUES($1,$2,1,'Synthetic post-migration','Synthetic educational body only','species',$3,'published')",
        [randomUUID(), randomUUID(), version]);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM public.knowledge_versions WHERE created_at IS NULL')).rows[0].n, 0);
      // 重放幂等：只匹配 created_at IS NULL，已回填历史行（含被改过的值）不得被改写。
      // 必须挑一条**历史行**（按标题定位）；按 knowledge_id 排序会随机落到迁移后才插入的新行，
      // 那样两条断言都会失去意义。
      const touched = (await db.query(
        "SELECT knowledge_id FROM public.knowledge_versions WHERE title = 'Synthetic historical 0'",
      )).rows[0].knowledge_id;
      await db.query("UPDATE public.knowledge_versions SET created_at = timestamptz '2099-01-01T00:00:00Z' WHERE knowledge_id = $1", [touched]);
      await db.exec(mig('0012_knowledge_created_at'));
      assert.equal(iso((await db.query('SELECT created_at FROM public.knowledge_versions WHERE knowledge_id = $1', [touched])).rows[0].created_at),
        iso('2099-01-01T00:00:00Z'), '重放回填不得改写已有 created_at');
      const counted = (await db.query(`SELECT count(*) FILTER (WHERE created_at = timestamptz '2026-10-14T00:00:00Z')::int AS constant,
        count(*) FILTER (WHERE created_at IS NULL)::int AS nulls, count(*)::int AS total FROM public.knowledge_versions`)).rows[0];
      assert.deepEqual(counted, { constant: 2, nulls: 0, total: 4 }, '重放后：2 条历史行仍是常量、新行保留自身时点、无 NULL');
    } finally { await db.close(); }
  });

  await t.test('投影：created_at 由知识行自身提供，且运行期角色仍只能读视图', async () => {
    const f = await connected();
    try {
      const s = await f.seed([{ id: uid(31), title: 'Synthetic projection', created_at: '2026-10-07T00:00:00Z' }]);
      const view = (await f.pool.query('SELECT id, created_at FROM catalog_read.current_knowledge WHERE id = $1', [s.ids[0]])).rows;
      assert.equal(view.length, 1);
      assert.equal(iso(view[0].created_at), iso('2026-10-07T00:00:00Z'), '投影必须带知识行自身的创建时点');
      assert.notEqual(iso(view[0].created_at), iso('2026-10-14T00:00:00Z'), '不得用来源检索时间/批次常量冒充该行创建时点');
      assert.ok(s.ids.includes(view[0].id));
      // 0012 以 CREATE OR REPLACE VIEW 替换视图：视图对象与其 ACL 一并保留，
      // 角色脚本（0010 之后运行）建立的运行期只读授权必须存活。若退回 DROP VIEW + CREATE VIEW，
      // 这里的两项断言会变红，上面的读面查询也会以 42501 失败（生产同样会立刻读不到资料）。
      const acl = (await f.db.query(
        "SELECT has_table_privilege('gy_i07_order_runtime','catalog_read.current_knowledge','SELECT') AS runtime_select,"
        + " has_table_privilege('public','catalog_read.current_knowledge','SELECT') AS public_select",
      )).rows[0];
      assert.equal(acl.runtime_select, true, '0012 之后运行期角色仍须保有视图 SELECT（重建视图不得丢授权）');
      assert.equal(acl.public_select, false, '视图不得对 PUBLIC 开放');
      for (const sql of ['SELECT created_at FROM knowledge_versions', 'SELECT retrieved_at FROM source_versions',
        'SELECT canonical_url FROM sources']) {
        await assert.rejects(f.pool.query(sql), (e) => e.code === '42501', sql);
      }
    } finally { await f.close(); }
  });
});
