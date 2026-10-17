/**
 * GY-I07 · 知识列表排序的**测谎钉子（SQL 半边）**：
 * **DB 侧 `ORDER BY` 的方向必须自己承重，不许被 JS 归并重排接管后仍显绿。**
 *
 * 为什么需要这条钉子（对抗性审查实测的覆盖缺口，不是推测）：
 * 服务端有**两处**排序（`services/api/src/knowledge/service.ts`）——
 *   ① SQL：`:76` 的 `'SELECT * FROM catalog_read.current_knowledge ORDER BY created_at DESC, id DESC'`；
 *   ② JS：`:83-84` 的 `[...dbResult.rows, ...extra.filter(...)].sort(compareKnowledgeRows)`。
 * ② 把 ① 的次序**整个重排**，于是「只把 ① 改成 `ASC, ASC`」时既有用例**一条都不会红**
 * （审查方实测：该变异下既有测试 `pass 6 / fail 0`；而删掉 ② 的 `.sort()` 后，同一反向立刻 3 条子测试红）
 * ⇒ 既有用例对 JS 半边有牙、对 **SQL 半边无独立牙**。本文件补的正是那半边。
 *
 * 四条判据，**都不经过 JS 重排**：
 *   ① 走**真实读路径**，捕获**实际发往 DB 的语句文本**，断言其 `ORDER BY` 子句逐字 = 冻结契约方向
 *      （`service.ts:76` 的注释行先去掉，再对子句本体逐字比较）⇒ 只改 SQL 方向即红；
 *   ② 把**同一条**捕获到的语句原样交给引擎执行（不是另写一条 SELECT），断言引擎返回的行序本身
 *      = `created_at` 全降 + 同刻 `id` 降；夹具含「两个不同时刻」＋「同刻两行」，
 *      故方向可分辨（`ASC` 会给出严格逆序）；
 *   ③ 反向控制：同一函数、同一份夹具行，注入的 `ASC` 口径必须给出与契约口径**严格互逆**的序列；
 *      若把口径改成「不比较方向」（只断行数／只断集合／`created_at` 全同），本条即红 ⇒ 它自身可验伪；
 *   ④ 零放宽自证：本文件不得含软化钩子（跳过/独占/待办标记），且被测实现里必须仍**字面**存在冻结契约子句。
 *
 * 引擎边界（如实声明，不得外推）：本文件跑在内存 PostgreSQL 引擎（PGlite）的全新隔离库上，
 * **不连接真实 PG、不读任何生产凭据、不主张目标 PostgreSQL 17.11 的部署验收**。
 * 它证明的是「SQL 文本的方向」＋「该文本在真实 PG 语义下的返回行序」，
 * 不是「云端/生产库已通过」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createKnowledgeService } from '../../services/api/src/knowledge/service.ts';
import { STUB_IDEMPOTENCY_HMAC_KEY } from '../../services/api/src/auth/service.ts';

const read = (p) => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
const mig = (name) => read('services/api/db/migrations/' + name + '.sql');
/** 0012 之前的迁移链（与既有 `knowledge-order-created-at.test.mjs` / `knowledge-api.test.mjs` 同集合）。 */
const PRE_0012 = ['0001_initial_schema', '0002_knowledge_catalog', '0003_privacy_consent',
  '0005_catalog_read_views', '0008_auth_session', '0009_consent_policy', '0010_knowledge_read_views'];
/** 受限运行期角色（0012 之后建，与生产"先迁移再授权角色"同序）。 */
const RUNTIME_ROLE = 'gy_i07_sql_teeth_runtime';
/** 冻结契约：排序第一分量 `created_at` 降序、第二分量 `id` 降序。 */
const REQUIRED_ORDER_BY = 'ORDER BY created_at DESC, id DESC';

const iso = (v) => new Date(v).toISOString();
/** 固定 UUID（仅小写十六进制）——让「id 升序」与契约序**逐位可分辨**。 */
const uid = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');

/**
 * 从**实际发往 DB 的语句**里取 `ORDER BY` 子句：去掉 SQL 行尾注释与整行注释（注释是说明、不是判据），
 * 子句本体（含逗号、方向关键字、大小写）**逐字保留**后与合同字面比较 ⇒ 任何方向/键位改动都会失败。
 */
function orderByClause(sql) {
  const start = sql.indexOf('ORDER BY');
  assert.notEqual(start, -1, `读语句里必须出现 ORDER BY，实际语句：${sql}`);
  return sql.slice(start)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('--'))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 从 `service.ts` 源码里取出**服务实际执行的那条读语句**（去掉块注释与行尾 `//` 注释后，
 * 定位 `SELECT * FROM catalog_read.current_knowledge`，再向两侧收拢到那对引号之间）。
 * 这条语句随后会被**原样执行**（判据②），因此若实现被改写成"文档写 DESC、执行写 ASC"，判据①/②都会红。
 */
function executedReadStatement(source) {
  const bare = source.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');
  const at = bare.indexOf('SELECT * FROM catalog_read.current_knowledge');
  assert.notEqual(at, -1, 'service.ts 必须仍发出 `SELECT * FROM catalog_read.current_knowledge`（读视图是唯一读面）');
  const open = at - 1;
  assert.equal(bare[open], "'", '读语句必须是**单引号字符串字面量**（不接受拼接/模板，避免"两处来源"）');
  const close = bare.indexOf("'", at);
  assert.notEqual(close, -1, '读语句的单引号字面量必须闭合');
  return bare.slice(at, close).split('\n').map((line) => line.trim()).filter((line) => line !== '').join(' ');
}

/**
 * 冻结契约排序 `(created_at DESC, id DESC)` 的独立实现：**不复用被测代码**。
 * `direction` 只用来做反向控制（把同一份夹具行按注入方向重排），生产口径恒为 `DESC`。
 */
function sequenceBy(rows, direction) {
  // 夹具行给的是 `at`、DB 行给的是 `created_at`；两者都取，且**都当瞬时量比较**。
  const timeOf = (row) => new Date(row.created_at ?? row.at).getTime();
  for (const row of rows) {
    assert.equal(Number.isNaN(timeOf(row)), false,
      '夹具/结果行必须带可解析的时间（created_at 或 at），否则排序方向无从谈起：' + JSON.stringify(row));
  }
  return [...rows]
    .sort((a, b) => {
      const at = timeOf(a);
      const bt = timeOf(b);
      if (at !== bt) return direction === 'DESC' ? bt - at : at - bt;
      return direction === 'DESC' ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .map((row) => row.id);
}

/** 记录池：把**实际发给 DB 的语句文本**原样捕获，同时完全不改读写语义（读写仍落到真实引擎）。 */
function recordingPool(inner) {
  const statements = [];
  return {
    statements,
    listStatements: () => statements.filter((sql) => sql.includes('catalog_read.current_knowledge')),
    pool: {
      async connect() {
        const client = await inner.connect();
        return {
          async query(sql, ...rest) { statements.push(String(sql)); return client.query(sql, ...rest); },
          release() { return client.release(); },
        };
      },
      async query(sql, ...rest) { statements.push(String(sql)); return inner.query(sql, ...rest); },
    },
  };
}

/**
 * 与既有 knowledge 用例同构的最小装配：真实 HTTP + 受限运行期角色（无旁路读私表）+
 * **记录池**（捕获真实语句）。夹具含 4 行：2 个不同 `created_at` 时刻 + 1 组同刻两行。
 * `created_at` 一律**显式写入**，不依赖列 DEFAULT（`clock_timestamp()` 会让方向断言失去分辨力）。
 */
async function fixture() {
  const db = new PGlite();
  let queue = Promise.resolve();
  let pool = null;
  let app = null;
  try {
    // 真实落库顺序：0010 → 角色脚本（建立运行期只读 GRANT）→ 0012。
    for (const name of PRE_0012) await db.exec(mig(name));
    for (const name of ['auth_privacy', 'knowledge_runtime']) await db.exec(read('services/api/db/roles/' + name + '.sql'));
    await db.exec(mig('0012_knowledge_created_at'));
    await db.exec(`CREATE ROLE ${RUNTIME_ROLE} NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;`
      + ' GRANT gengyun_auth_privacy,gengyun_knowledge_runtime TO ' + RUNTIME_ROLE);
    const runtimePool = {
      async connect() {
        const before = queue; let unlock; queue = new Promise((r) => { unlock = r; });
        await before; await db.query('SET ROLE ' + RUNTIME_ROLE);
        return { query: (...a) => db.query(...a), release() { db.query('RESET ROLE').finally(unlock); } };
      },
      async query(...a) { const c = await this.connect(); try { return await c.query(...a); } finally { c.release(); } },
    };
    const recorder = recordingPool(runtimePool);
    pool = recorder.pool;
    const cursorKey = randomBytes(32).toString('hex');
    app = buildApp({ config: loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent', SESSION_SIGNING_KEY: cursorKey }), pool });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const origin = 'http://127.0.0.1:' + app.server.address().port;
    const http = async (path, token) => {
      const r = await fetch(origin + '/api/v1' + path, { headers: token ? { authorization: 'Bearer ' + token } : {} });
      return { status: r.status, data: await r.json() };
    };
    /** 合成身份登录（stub 模式替身；不涉真实微信）；显式断言 200，避免"未配置库"被误当排序失败。 */
    let token = null;
    async function login(code) {
      const r = await fetch(origin + '/api/v1/auth/wechat', { method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'sql-teeth-login-' + code },
        body: JSON.stringify({ code }) });
      assert.equal(r.status, 200, '合成身份登录必须成功（否则夹具不可信）');
      token = (await r.json()).data.access_token;
      return token;
    }
    /** 4 行夹具：两个不同时刻 + 同刻两行（同刻组由 id DESC 决出，钉住第二分量）。 */
    async function seed() {
      const admin = randomUUID(), source = randomUUID(), version = randomUUID();
      await db.query("INSERT INTO admin_accounts(id,login_name,credential_hash) VALUES($1,$2,'sql-teeth-not-login')",
        [admin, 'sql-teeth-' + admin]);
      await db.query("INSERT INTO knowledge_dataset_modes(mode,description,accepts_database,accepts_verified_seed) VALUES('real','sql-teeth fixture only',true,true) ON CONFLICT (mode) DO NOTHING");
      await db.query("INSERT INTO knowledge_dataset_config(key,value,mode) VALUES('active_mode','real','real'),('database_connected','true','real') ON CONFLICT (key) DO NOTHING");
      await db.query("INSERT INTO sources(id,title,canonical_url,publisher,source_kind,evidence_kind) VALUES($1,'SQL teeth source','https://example.invalid/sql-teeth','SQL teeth publisher','verified_seed','research')", [source]);
      await db.query("INSERT INTO source_versions(id,source_id,version,content_hash,locator,retrieved_at,valid_from,validity,review_status,reviewed_by,reviewed_at) VALUES($1,$2,'sql-teeth-v1',repeat('a',64),'sql-teeth:page1',now(),now()-interval '1 day','valid','verified',$3,now())", [version, source, admin]);
      await db.query('UPDATE sources SET current_version_id=$1 WHERE id=$2', [version, source]);
      const rows = [
        { id: uid(1), at: '2026-10-14T00:00:00Z', title: 'SQL teeth oldest' },
        { id: uid(2), at: '2026-10-15T00:00:00Z', title: 'SQL teeth tie-a' },
        { id: uid(3), at: '2026-10-15T00:00:00Z', title: 'SQL teeth tie-b' },
        { id: uid(4), at: '2026-10-16T00:00:00Z', title: 'SQL teeth newest' },
      ];
      for (const row of rows) {
        await db.query('INSERT INTO knowledge_versions(id,knowledge_id,revision,title,body,type,source_version_id,crop_ids,species_ids,region_codes,visibility,created_at)'
          + " VALUES($1,$2,1,$3,'Synthetic educational body only','species',$4,'[\"crop_rice\"]','[\"synthetic_weed\"]','[\"330102\"]','published',$5)",
          [randomUUID(), row.id, row.title, version, row.at]);
      }
      return rows;
    }
    /** 受鉴权身份：从真实登录产生的会话里取 userId/authEpoch，与服务内 `read()` 的校验口径一致。 */
    async function identityOf(sessionToken) {
      const account = await db.query('SELECT id,auth_epoch FROM public.users ORDER BY created_at LIMIT 1');
      assert.equal(account.rows.length, 1, '登录后必须存在恰好一个受鉴权账号');
      const session = await db.query("SELECT id FROM public.sessions WHERE audience='user' ORDER BY created_at DESC LIMIT 1");
      assert.equal(session.rows.length, 1, '登录后必须存在恰好一个用户会话');
      return { token: sessionToken,
        identity: { role: 'user', userId: account.rows[0].id, authEpoch: Number(account.rows[0].auth_epoch), sessionId: session.rows[0].id } };
    }
    return { db, http, login, seed, identityOf, statements: recorder.statements,
      listStatements: recorder.listStatements,
      list: (identity) => createKnowledgeService(pool, cursorKey).list(identity, { limit: 50 }),
      async close() { if (app) await app.close(); await queue; await db.close(); } };
  } catch (error) {
    if (app) await app.close();
    await db.close().catch(() => {});
    throw error;
  }
}

/** 每个子测试独享一个全新隔离库并登录：列表查询面是**全局投影**，不得跨组共用连接。 */
async function connected() {
  const f = await fixture();
  const token = await f.login('sql-teeth-' + randomUUID());
  return { f, identity: await f.identityOf(token) };
}

test('钉子·SQL 半边：DB 侧 ORDER BY 方向必须自己承重，不许被 JS 归并重排掩盖（只翻转 SQL 方向即红）', async (t) => {
  await t.test('① 真实读路径发出的语句：ORDER BY 子句逐字 = 冻结契约方向，且不得出现 ASC', async () => {
    const { f, identity } = await connected();
    try {
      const rows = await f.seed();
      assert.equal(rows.length, 4);
      const got = await f.http('/knowledge?limit=50', identity.token);
      assert.equal(got.status, 200, '真实读路径必须 200：' + String(got.data?.error?.code ?? '') + ' ' + String(got.data?.error?.message ?? ''));
      assert.equal(got.data.data.items.length, 4, '夹具 4 行必须全部可见');

      const captured = f.listStatements();
      assert.equal(captured.length, 1, '读路径必须恰好发出 1 条当前知识读语句，实际 ' + captured.length + ' 条：'
        + captured.map((sql) => sql.replace(/\s+/g, ' ').slice(0, 90)).join(' | '));

      const clause = orderByClause(captured[0]);
      assert.equal(clause, REQUIRED_ORDER_BY,
        '实际发往 DB 的 ORDER BY 子句必须逐字等于冻结契约方向；若这里失败，说明 **SQL 侧**排序方向被改动'
        + '（哪怕 JS 归并重排仍能让列表"看起来对"）');
      assert.equal(/\bASC\b/.test(clause), false, 'ORDER BY 子句里不得出现 ASC（升序即偏离冻结契约）：' + clause);

      // 同一条语句也必须是实现里那条（防"文档写 DESC、执行写 ASC"的两处来源）。
      const executed = executedReadStatement(read('services/api/src/knowledge/service.ts'));
      assert.equal(executed, captured[0], '捕获到的语句必须与 service.ts 里执行的读语句逐字相同（两处来源不得漂移）');
    } finally { await f.close(); }
  });

  await t.test('② 同一条语句在真实 PG 引擎上的返回行序 = created_at 全降 + 同刻 id 降（含同刻组与异刻组）', async () => {
    const { f, identity } = await connected();
    try {
      const rows = await f.seed();
      await f.http('/knowledge?limit=50', identity.token);
      const captured = f.listStatements();
      assert.equal(captured.length, 1);

      // 夹具自检（让"方向可分辨"本身可验伪）：≥2 个不同时刻 + 恰好一组同刻两行。
      assert.equal(new Set(rows.map((row) => iso(row.at))).size, 3, '夹具必须含 3 个不同 created_at 时刻');
      assert.equal(rows.filter((row) => iso(row.at) === iso('2026-10-15T00:00:00Z')).length, 2, '夹具必须含一组同刻两行');

      // 断言用的是**独立算出的契约序**（不是实现算出来的序）；反向序列也必须与它不同。
      const contract = sequenceBy(rows, 'DESC');
      const inverted = sequenceBy(rows, 'ASC');
      assert.notDeepEqual(inverted, contract, '夹具必须让两种方向可分辨（否则本条无牙）');
      assert.deepEqual(contract, [uid(4), uid(3), uid(2), uid(1)], '契约序必须由 created_at DESC + 同刻 id DESC 决出');

      const ordered = (await f.db.query(captured[0])).rows;
      const seen = ordered.map((row) => row.id);
      assert.notDeepEqual(seen, inverted, '引擎返回的行序必须与升序不同；相同即说明夹具/断言分辨不出方向');
      assert.deepEqual(seen, contract, 'DB 返回的行序本身必须是 (created_at DESC, id DESC)；此断言不经过任何 JS 重排');
      const times = ordered.map((row) => new Date(row.created_at).getTime());
      for (let i = 1; i < times.length; i += 1) {
        assert.ok(times[i - 1] >= times[i], 'created_at 必须单调不增，实际 '
          + ordered.map((row) => iso(row.created_at)).join(' >= '));
      }
    } finally { await f.close(); }
  });

  await t.test('③ 反向控制：同一函数把方向注入成 ASC 时序列逐位相反；"方向失明"的口径会让本条变红', async () => {
    const { f, identity } = await connected();
    try {
      const rows = await f.seed();
      await f.http('/knowledge?limit=50', identity.token);
      const contract = sequenceBy(rows, 'DESC');
      const injected = sequenceBy(rows, 'ASC');
      assert.deepEqual(contract, [uid(4), uid(3), uid(2), uid(1)], '契约序必须是 (created_at DESC, id DESC)');
      assert.deepEqual(injected, [uid(1), uid(2), uid(3), uid(4)], '注入 ASC 后必须是严格升序（先 created_at、同刻再 id 升）');
      assert.equal(injected.join(' '), [...contract].reverse().join(' '),
        '两种方向必须**逐位相反**：只要把口径放宽成"比集合/比行数/比首项"，两者就分不开而本条即红');
      assert.notDeepEqual(injected, contract, '两种方向的结果必须不同');

      // 反例（方向失明）：把整批行的 created_at 压成同一时刻 ⇒ 只剩第二分量可按 id 判方向。
      const flattened = rows.map((row) => ({ id: row.id, created_at: '2026-10-15T00:00:00Z' }));
      assert.deepEqual(sequenceBy(flattened, 'ASC').slice().sort(), sequenceBy(flattened, 'DESC').slice().sort(),
        '方向失明示例：created_at 全同时两种方向只差整体倒序 —— 任何"只比较集合"的断言对它都无感');
      assert.notDeepEqual(sequenceBy(flattened, 'ASC'), sequenceBy(flattened, 'DESC'),
        '即便全同刻，两个序列本身仍不同 ⇒ 只断集合相等仍会漏判方向，故本钉子必须逐位比较序列');
    } finally { await f.close(); }
  });

  await t.test('④ 零放宽自证：断言只增不减、无软化钩子，且被测实现里仍字面存在冻结契约子句', async () => {
    const source = read('services/api/src/knowledge/service.ts');
    assert.equal(source.includes(REQUIRED_ORDER_BY), true,
      '被测实现里必须**字面**出现 `' + REQUIRED_ORDER_BY + '`（本钉子锚定的那句；漂移即红）');
    const self = readFileSync(new URL(import.meta.url), 'utf8');
    // 软化钩子必须是**拼出来**的正则字面量，免得本行自身的源码把本断言带红。
    const softening = new RegExp(['\\.on', 'ly\\('].join('') + '|' + ['\\.sk', 'ip\\('].join('') + '|' + ['\\bto', 'do\\b'].join(''));
    assert.equal(softening.test(self), false, '本文件不得含软化钩子（不得把断言软化成跳过）');
    assert.equal(self.includes("'ASC'"), true, '本文件必须把 ASC 当反例显式写出来（否则无法自证方向分辨力）');
    assert.equal(self.includes('REQUIRED_ORDER_BY'), true, '本文件的合同方向必须来自单一常量，不得散落多份字面量');
    // 既有用例（JS 半边 + 翻页稳定性 + 投影）不得被本片改动：只允许新增文件。
    // 它的读数来源是「投影后行序」而非 SQL 文本；本片不去改它，只核验它仍在钉同一份契约方向
    // （同刻两行按 id **降**序 ⇒ 期望串 [uid(2), uid(4), uid(3), uid(1)]）。它一旦被放宽，本行即红。
    assert.equal(read('tests/unit/knowledge-order-created-at.test.mjs')
      .includes('[uid(2), uid(4), uid(3), uid(1)]'), true,
    '既有 JS 半边用例必须仍是它自己的读数来源（本片不修改它，只新增本文件）');
  });
});
