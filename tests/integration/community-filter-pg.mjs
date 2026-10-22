/**
 * GY-I15（#15）/ #444 §S5 残留缺口 · 社区域**列表筛选下推 + 分页确定性**的真库读数 +
 * **举报状态推进通道**的缺口登记（PostgreSQL 17）。
 *
 * 为什么需要这一条（既有脚本的分工，逐条点名）：
 *   - `tests/integration/community-pg.mjs` 只发过 `POST /api/v1/posts`（:517），**没有任何
 *     `GET /api/v1/posts?...`**，因此「`crop_id` / `region_code` / `mine` 三类筛选在真库上回什么」
 *     **从来没有读数**；它只断言过建帖时写进去的 `crop_id='crop-wheat'`/`region_code='330100'`
 *     能原样读回（:205-206）。
 *   - `tests/unit/community-http.test.mjs:202-207` 用内存 store 证明过筛选的**语义**（三个正例）、
 *     `:414-416` 证明 `mine` 能看见自己的非公开版本、`:750` 证明 `mine=maybe` ⇒ 400。
 *     但内存 store 的 `listPosts()` 与 PG 的 `listPosts()` **是两种实现**：内存实现天生就是全量数组，
 *     PG 实现是一条真 SQL。语义在内存臂上绿，不等于「同一组查询参数打到真 PG 库仍然只回该回的」。
 *   - 本脚本就是补这一块：**真库 + 真 HTTP 面 + 真 store**，逐条对照 `community_posts` 的同条件
 *     `SELECT`（不是"状态码 200 就算过"）。
 *
 * 本脚本证明什么（每条都有正/负读数）：
 *   1. `GET /posts` 无筛选：只回公开可见（`published` + `approved`），`hidden`/`deleted` 一律不出现在公开列表；
 *   2. `?crop_id=` / `?region_code=` / 两者组合：返回集合与**真库同条件 SELECT 的 id 序列逐位相等**
 *      （顺序也相等：`created_at DESC, id DESC`）；
 *   3. `?mine=true`：回主体自己的**非删除**内容（含 `hidden` 版本），且**他人**拿到的集合不同
 *      ⇒ 同一请求在不同主体下读数不同，不是"忽略 mine 参数"的假实现；
 *   4. 游标**绑定筛选集 + 主体 + 路由 + 排序**：同条件续页不重不漏；把同一游标换个筛选集/换个主体
 *      复用 ⇒ 400 `INVALID_CURSOR`（不串页）；篡改签名 ⇒ 也是 400；
 *   5. 查询参数闭集：多余参数（`additionalProperties:false`）、`mine=maybe`、`region_code=999999`、
 *      `limit=0/51`、空 `crop_id` 全部 400 —— 没有被静默忽略的"宽松过滤"；
 *   6. **语句读数**：捕获 `GET /posts?crop_id=…&region_code=…&limit=…` 这条请求真正下发给 PG 的
 *      SQL **与绑定参数**，断言 SQL 含 `WHERE`、`LIMIT` 是参数、占位符 `$1..$n` 不跳号且
 *      `crop_id=$1 / region_code=$2 / LIMIT $3` 位序与 `values` 下标一一对应；同时断言公开列表
 *      **没有** `author_id` 谓词、`mine=true` 列表的 `author_id=$1` 绑定的是会话主体；
 *   7. **索引读数**：直接 `EXPLAIN` 服务层真的下发的那条语句（连同它的真实参数）⇒ 计划里
 *      **不再**出现 `Seq Scan on community_posts`，而是 `Index Scan using community_posts_feed_idx`
 *      + `Limit`；空结果的同类谓词同样不走全表扫；
 *   8. **分页确定性**：40 行同一 `created_at` 的夹具，`limit=9` 逐页遍历 ⇒ 40 行全覆盖、无重复、
 *      顺序与库内 `created_at DESC, id DESC` 逐位相等；游标严格前进（第二页从全序第 10 行开始）；
 *      B 拿 `mine=true&crop_id=crop-tie` 看不到 A 的同刻行（越权负控制，库里 B 本来也没有）。
 *
 * 本脚本**不**证明什么（必须如实登记，不许被引用成功能证据）：
 *   - 举报 `state` 的推进：`POST /reports` 落库的 `state` 恒为 `received`（服务层 `service.ts:1402`
 *     硬编码），store 接口只有 `insertReport`/`getReport`，契约只有 `createReport`/`getOwnReport`，
 *     没有任何 `/admin/reports` 面。本脚本第 8 节把这条写成**缺口登记**（断言"推不动"），
 *     不是"举报闭环已验证"；B 片把它补上时，这一节必须跟着改。
 *   - 筛选下推 SQL 的性能：本脚本只读 `EXPLAIN` 的**计划形状**（选没选索引），不报执行时间，
 *     也不构成容量/延迟结论。
 *   - 真实审核供应商：全程注入 `provider.synthetic === true` 的合成审核端口（不联网、无凭据），
 *     只用于让内容"可发布"，不代表真实 `tms`/`ims` 已接通。
 *
 * 运行（专用测试库必须是**空库**，脚本会先断言 public 下没有任何表）：
 *   createdb gengyun_community_filter_test
 *   COMMUNITY_FILTER_PG_TEST_URL=postgres://postgres@127.0.0.1:55432/gengyun_community_filter_test \
 *     node tests/integration/community-filter-pg.mjs
 * 也接受 argv 形态（与 `messages-pg.mjs` 一族同义）：`node tests/integration/community-filter-pg.mjs <ownerUrl>`。
 * 未设置 `COMMUNITY_FILTER_PG_TEST_URL`（且 argv 里没有 `postgres://`）⇒ 打印 `SKIP` 并以 **77** 退出
 *   （POSIX「skipped」：本次运行**没有**验证真库，不是通过；本机明知无真库时可显式 `--allow-skip` 取 0，
 *   ⛔ 不得用于门禁）。
 * `npm run test:integration:http` 不包含本文件（它需要真库），需显式运行。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';
import { createPool } from '../../services/api/src/db/pool.ts';
import { applyMigrations, discoverMigrations } from '../../services/api/src/db/migrate.ts';
import { createPostgresCommunityStore } from '../../services/api/src/community/store-pg.ts';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';
import { makeGate, makeSyntheticPassPort } from '../unit/community-fixtures.mjs';
// 投稿面（`POST /posts` 等）的 `public_posting` 授权闸：本脚本只读列表，不写帖子，
// 但同一份 app 装配里写入面仍需要这份合成授权账本，避免"列表读数"被无关的 403 干扰。
import { createPublicPostingConsent } from '../unit/community-posting-consent-fixtures.mjs';

const ENV = 'COMMUNITY_FILTER_PG_TEST_URL';
const argvUrl = process.argv.slice(2).find((value) => /^postgres(ql)?:\/\//.test(value));
const rawUrl = argvUrl ?? process.env[ENV];
// 缺真库时的出口：默认 77（未取得，不是通过）；只有显式 `--allow-skip` / `GY_ALLOW_SKIP=1` 才降级为 0。
const ALLOW_SKIP = process.argv.includes('--allow-skip') || process.env.GY_ALLOW_SKIP === '1';
if (rawUrl === undefined || rawUrl.trim() === '') {
  console.log(
    `SKIP real PG17: ${ENV} 未设置（argv 也没有 postgres URL）—— 本次运行没有取到筛选/举报的真库读数（不是通过）。`,
  );
  if (ALLOW_SKIP) {
    console.log('EXITCODE=0（--allow-skip / GY_ALLOW_SKIP=1 已显式授权：仅本机开发，⛔ 不得接进门禁）。');
    process.exit(0);
  }
  console.log(
    'EXITCODE=77 表示未取得，不是通过（POSIX 惯例 skipped；本机明知无真库时可显式加 --allow-skip 取 0）。',
  );
  process.exit(77);
}
const url = new URL(rawUrl);
assert.ok(['postgres:', 'postgresql:'].includes(url.protocol), `${ENV} 必须是 postgres URL`);
assert.equal(url.search, '', '连接参数由脚本控制，测试 URL 不带查询串');
assert.ok(
  ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname),
  `只允许回环地址，实际 ${url.hostname}`,
);
assert.equal(url.pathname, '/gengyun_community_filter_test', '只允许专用测试库 gengyun_community_filter_test');

let passed = 0;
const say = (message) => {
  passed += 1;
  console.log(`PASS ${passed}: ${message}`);
};
const note = (message) => console.log(`      ${message}`);

const digest = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const contractJson = (name) => JSON.parse(readFileSync(new URL(`../../packages/contracts/${name}`, import.meta.url), 'utf8'));

/** 种子帖的时间戳（相差 1 分钟，保证 `created_at DESC` 的次序唯一确定，不靠 uuid 排序碰运气）。 */
const AT = (minutes) => new Date(Date.parse('2026-10-18T02:00:00.000Z') + minutes * 60_000).toISOString();

const gate = makeGate();
const RULE_VERSION = gate.currentRuleVersion();
assert.equal(typeof RULE_VERSION, 'string', '合成规则集必须能派生出当前规则版本（否则任何内容都无法公开可见）');

/** 帖子被"公开可见"要求：`visibility='published'` + 结论 `approved`（`rule_version` 为当前派生版本）
 *  + `text_digest` 与 `title\nbody` 的 sha256 相等（`service.ts:482`）。种子必须逐条满足，否则列表读数是假的。 */
const postRecord = (id, authorId, overrides = {}) => ({
  id,
  revision: 1,
  author_id: authorId,
  title: `筛选读数帖子-${overrides.tag ?? 'x'}`,
  body: `筛选读数正文-${overrides.tag ?? 'x'}`,
  crop_id: null,
  region_code: null,
  media_ids: [],
  linked_knowledge_ref: null,
  visibility: 'published',
  audit_state: 'approved',
  created_at: AT(0),
  updated_at: AT(0),
  ...overrides,
});

const verdictFor = (type, record, revision = record.revision) => ({
  id: randomUUID(),
  target_ref: { type, id: record.id, revision },
  decision: 'approved',
  reason_codes: [],
  hard_rule_passed: true,
  rule_version: RULE_VERSION,
  text_digest: digest(`${record.title}\n${record.body}`),
  contract_complete: true,
  missing_contract_fields: [],
  created_at: record.created_at,
});

/**
 * 记录型连接池包装：把**真正下发给 PG 的语句与绑定参数**原样收下来（只读、不改语义）。
 *
 * 为什么必须这样做：本脚本要证明"筛选真的写进了 WHERE、参数按占位符位序下发"，而"看源码认为它写了"是
 * **静态断言**；捕获运行期实际语句 + 实际参数才算读数——服务层将来若退回内存过滤，这里立刻看不到 `WHERE`。
 */
function tapPool(realPool, statements) {
  return {
    query(text, values) {
      statements.push({
        text: typeof text === 'string' ? text : String(text?.text ?? ''),
        values: Array.isArray(values) ? [...values] : [],
      });
      return realPool.query(text, values);
    },
    connect() {
      return realPool.connect();
    },
    end() {
      return realPool.end();
    },
  };
}

async function main() {
  const owner = new pg.Client({ connectionString: url.href });
  await owner.connect();
  let pool = null;
  let app = null;
  try {
    // ---- 1. 环境与迁移 ---------------------------------------------------
    const version = (await owner.query("SELECT current_setting('server_version') AS version")).rows[0].version;
    assert.match(version, /^17\./, `requires PostgreSQL 17，实际 ${version}`);
    const emptyTables = (await owner.query(
      "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'",
    )).rows[0].n;
    assert.equal(emptyTables, 0, 'fresh DB required（专用测试库必须是空的；本脚本会建表/灌数据）');

    const all = discoverMigrations();
    const versions = all.map((m) => m.version);
    assert.equal(versions.includes('0022'), true, '迁移目录里必须有 0022（社区六表）');
    // 0030（F13 行级作者注销引用）是**运行时依赖**，不是可选项：`store-pg` 的列常量现在含
    // `anonymized_author_ref`，缺它真库会 42703（`undefined_column`）⇒ 整个社区域 503。
    const migrations = all.filter((m) => ['0001', '0022', '0030'].includes(m.version));
    assert.deepEqual(
      (await applyMigrations(owner, migrations)).applied,
      ['0001', '0022', '0030'],
      '0001（users/枚举底座）+ 0022（社区六表）+ 0030（行内注销引用列与 CHECK）：筛选与举报只依赖这三支',
    );
    assert.equal((await applyMigrations(owner, migrations)).applied.length, 0, '重跑迁移必须是 no-op');
    say(`迁移 apply 可重入：迁移目录 ${versions.length} 个，本脚本只取 0001 + 0022 + 0030（PG ${version}）`);

    // ---- 2. 两个真实用户（作者 A / 他人 B） ------------------------------
    const auth = createMemoryAuthStore();
    const account = async (tag) => {
      const user = await auth.createUser(tag.repeat(64));
      const token = `synthetic-i15-filter-${tag}`;
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
    const a = await account('a');
    const b = await account('b');

    // ---- 3. 种子帖：5 条，覆盖 作物×地区×作者×可见性 ---------------------
    pool = createPool(url.href);
    const statements = [];
    const store = createPostgresCommunityStore({ pool });
    assert.equal(store.persistent, true, 'PG 实现必须自述持久化（app.ts 的放行判据）');

    const p1 = postRecord(randomUUID(), a.user.id, {
      tag: 'wheat-a', crop_id: 'crop-wheat', region_code: '330100', created_at: AT(1), updated_at: AT(1),
    });
    const p2 = postRecord(randomUUID(), a.user.id, {
      tag: 'rice-a', crop_id: 'crop-rice', region_code: '330200', created_at: AT(2), updated_at: AT(2),
    });
    const p3 = postRecord(randomUUID(), b.user.id, {
      tag: 'wheat-b', crop_id: 'crop-wheat', region_code: '330100', created_at: AT(3), updated_at: AT(3),
    });
    const p4 = postRecord(randomUUID(), a.user.id, {
      tag: 'wheat-a-hidden', crop_id: 'crop-wheat', region_code: '330100',
      visibility: 'hidden', created_at: AT(4), updated_at: AT(4),
    });
    const p5 = postRecord(randomUUID(), a.user.id, {
      tag: 'wheat-a-deleted', crop_id: 'crop-wheat', region_code: '330100',
      visibility: 'deleted', created_at: AT(5), updated_at: AT(5),
    });
    for (const record of [p1, p2, p3, p4, p5]) {
      assert.equal(await store.insertPost(record, verdictFor('post', record)), true, `种子帖 ${record.id} 必须落库`);
    }
    assert.equal((await owner.query('SELECT count(*)::int AS n FROM community_posts')).rows[0].n, 5,
      '五条种子必须各占一行（重复插入不得覆盖）');
    say('种子：5 条帖（作物×地区×作者×可见性各不相同：published×3 / hidden×1 / deleted×1）真落库');

    // ---- 4. 真 HTTP 面（stub 配置 + 真 pool + 合成审核端口） --------------
    const publicPosting = createPublicPostingConsent();
    await publicPosting.grant(a.user.id);
    await publicPosting.grant(b.user.id);
    const baseConfig = loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' });
    const tapped = tapPool(pool, statements);
    app = buildApp({
      config: baseConfig,
      store: auth,
      pool: tapped,
      now: () => new Date(),
      privacyInjection: { consent: publicPosting.gate },
      communityInjection: { gate },
      moderationInjection: { ports: { tms: makeSyntheticPassPort('tms') } },
    });
    assert.notEqual(app.communityService, null, 'stub + 真 pool ⇒ 社区服务必须开启（否则列表 503，读数无效）');
    await app.listen({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const call = async (method, path, extra = {}) => {
      const response = await fetch(base + path, {
        method,
        headers: {
          authorization: `Bearer ${extra.token ?? a.token}`,
          ...(extra.payload === undefined ? {} : { 'content-type': 'application/json' }),
          ...(extra.headers ?? {}),
        },
        ...(extra.payload === undefined ? {} : { body: JSON.stringify(extra.payload) }),
      });
      const text = await response.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      return { status: response.status, body };
    };
    const idsOf = (body) => (Array.isArray(body?.data?.items) ? body.data.items.map((item) => item.id) : null);

    // ---- 5. 真库对照 SELECT（口径与列表一致，用来判断"只回该回的"） ------
    // 公开列表口径：`visibility='published'` 且当前版本审核通过（种子全部 approved ⇒ SQL 侧就是 published）。
    const sqlPublic = async ({ cropId = null, regionCode = null } = {}) => {
      const rows = (await owner.query(
        `SELECT id FROM community_posts
          WHERE visibility = 'published'
            AND ($1::text IS NULL OR crop_id = $1)
            AND ($2::text IS NULL OR region_code = $2)
          ORDER BY created_at DESC, id DESC`,
        [cropId, regionCode],
      )).rows;
      return rows.map((row) => row.id);
    };
    // `mine` 口径：本人 + 非删除（含 hidden/pending 版本）。
    const sqlMine = async (userId, { cropId = null, regionCode = null } = {}) => {
      const rows = (await owner.query(
        `SELECT id FROM community_posts
          WHERE author_id = $1::uuid
            AND visibility <> 'deleted'
            AND ($2::text IS NULL OR crop_id = $2)
            AND ($3::text IS NULL OR region_code = $3)
          ORDER BY created_at DESC, id DESC`,
        [userId, cropId, regionCode],
      )).rows;
      return rows.map((row) => row.id);
    };
    const expectPublic = async (path, expected, extra = {}) => {
      const response = await call('GET', path, extra);
      assert.equal(response.status, 200, `${path} ⇒ ${response.status} ${JSON.stringify(response.body)}`);
      assert.deepEqual(idsOf(response.body), expected, `${path} 的 id 序列必须与真库同条件 SELECT 逐位相等`);
      return response.body;
    };

    // ---- 6. 读数 A：无筛选（只回公开可见） ------------------------------
    await expectPublic('/api/v1/posts', await sqlPublic());
    await expectPublic('/api/v1/posts', [p3.id, p2.id, p1.id]);
    note('无筛选公开列表 = [p3(他人,最新), p2, p1]；p4(hidden) 与 p5(deleted) 不在其中');
    assert.equal((await call('GET', '/api/v1/posts', { token: b.token })).status, 200, '另一主体的公开列表同样可读');
    say('`GET /posts` 无筛选：只回 published+approved（hidden/deleted 不出现），与真库 SELECT 逐位一致');

    // ---- 7. 读数 B：crop_id / region_code / 组合 -------------------------
    await expectPublic('/api/v1/posts?crop_id=crop-wheat', [p3.id, p1.id]);
    await expectPublic('/api/v1/posts?crop_id=crop-rice', [p2.id]);
    await expectPublic('/api/v1/posts?crop_id=crop-maize', [], );
    await expectPublic('/api/v1/posts?region_code=330100', [p3.id, p1.id]);
    await expectPublic('/api/v1/posts?region_code=330200', [p2.id]);
    await expectPublic('/api/v1/posts?region_code=330999', []);
    await expectPublic('/api/v1/posts?crop_id=crop-wheat&region_code=330100', [p3.id, p1.id]);
    await expectPublic('/api/v1/posts?crop_id=crop-wheat&region_code=330200', []);
    await expectPublic('/api/v1/posts?crop_id=crop-rice&region_code=330100', []);
    note('作物筛选 3 条读数（crop-wheat=2 / crop-rice=1 / 不存在=0）× 地区 3 条 × 组合 3 条，全部与 SQL 对照相等');
    say('`?crop_id=` / `?region_code=` / 组合：各自只回该回的，集合与顺序都与真库同条件 SELECT 相等');

    // ---- 8. 读数 C：mine（含自己的非公开版本；他人看不到） ----------------
    await expectPublic('/api/v1/posts?mine=true', await sqlMine(a.user.id));
    await expectPublic('/api/v1/posts?mine=true', [p4.id, p2.id, p1.id]);
    await expectPublic('/api/v1/posts?mine=true', [p3.id], { token: b.token });
    await expectPublic('/api/v1/posts?mine=true&crop_id=crop-rice', [p2.id]);
    await expectPublic('/api/v1/posts?mine=true&region_code=330100', [p4.id, p1.id]);
    assert.equal(
      (await owner.query("SELECT count(*)::int AS n FROM community_posts WHERE visibility = 'deleted'")).rows[0].n,
      1,
      'p5 必须是 deleted（`mine` 不返回它，是服务层 skip 而不是库里没有）',
    );
    note('mine(a) = [p4(hidden), p2, p1]（3 条）；mine(b) = [p3]（1 条）；p5(deleted) 两边都不出现');
    say('`?mine=true`：本人拿到自己的 hidden 版本（3 条）、他人拿到 1 条 ⇒ mine 真的按主体生效，deleted 恒排除');

    // ---- 9. 读数 D：游标绑定筛选集/主体（同条件续页，换条件 400） ---------
    const firstPage = await expectPublic('/api/v1/posts?crop_id=crop-wheat&limit=1', [p3.id]);
    const cursor = firstPage.data.next_cursor;
    assert.equal(typeof cursor, 'string', '两条匹配 + limit=1 ⇒ 必须给出 next_cursor');
    const secondPage = await expectPublic(
      `/api/v1/posts?crop_id=crop-wheat&limit=1&cursor=${encodeURIComponent(cursor)}`,
      [p1.id],
    );
    assert.equal(secondPage.data.next_cursor, null, '第二页只剩 1 条 ⇒ 不再给游标（不制造空页）');
    say('游标同条件续页：p3 → p1，两页合起来无重复无遗漏，末页 next_cursor=null');

    // 确定性篡改：把前 8 位签名换个字符（不会碰巧等于原值）。
    const dashed = cursor.indexOf('.');
    assert.ok(dashed > 0, '游标必须是 <body>.<signature> 两段');
    const flipped = cursor[0] === 'A' ? 'B' : 'A';
    const tampered = `${flipped}${cursor.slice(1)}`;
    assert.notEqual(tampered, cursor);

    const rejected = [
      ['换筛选集（crop-rice）', `/api/v1/posts?crop_id=crop-rice&limit=1&cursor=${encodeURIComponent(cursor)}`, {}],
      ['换筛选集（mine=true）', `/api/v1/posts?mine=true&limit=1&cursor=${encodeURIComponent(cursor)}`, {}],
      ['换主体（B 复用 A 的游标）', `/api/v1/posts?crop_id=crop-wheat&limit=1&cursor=${encodeURIComponent(cursor)}`, { token: b.token }],
      ['篡改签名', `/api/v1/posts?crop_id=crop-wheat&limit=1&cursor=${encodeURIComponent(tampered)}`, {}],
    ];
    for (const [label, path, extra] of rejected) {
      const response = await call('GET', path, extra);
      assert.equal(response.status, 400, `${label} 必须 400，实际 ${response.status} ${JSON.stringify(response.body)}`);
      assert.equal(response.body?.error?.code, 'INVALID_CURSOR', `${label} 的错误码必须是 INVALID_CURSOR`);
    }
    say('游标绑定筛选集 + 主体 + 签名：跨筛选集/跨主体/篡改签名复用一律 400 INVALID_CURSOR（不串页）');

    // ---- 10. 读数 E：查询参数闭集（没有被静默忽略的过滤参数） ------------
    const badQueries = [
      ['多余参数', '/api/v1/posts?foo=1'],
      ['mine 非布尔', '/api/v1/posts?mine=maybe'],
      ['region_code 越界', '/api/v1/posts?region_code=999999'],
      ['region_code 形态', '/api/v1/posts?region_code=33010'],
      ['limit=0', '/api/v1/posts?limit=0'],
      ['limit=51', '/api/v1/posts?limit=51'],
      ['crop_id 空串', '/api/v1/posts?crop_id='],
    ];
    for (const [label, path] of badQueries) {
      const response = await call('GET', path);
      assert.equal(response.status, 400, `${label}（${path}）必须 400，实际 ${response.status}`);
      assert.equal(response.body?.error?.code, 'INVALID_REQUEST', `${label} 的错误码必须是 INVALID_REQUEST`);
    }
    say('参数闭集：多余参数 / mine=maybe / region_code 越界·形态 / limit 0·51 / 空 crop_id 全部 400（additionalProperties:false 真生效）');

    // ---- 11. 语句读数：筛选写进了 WHERE，参数按占位符位序下发 -------------
    const listStatements = statements.filter((entry) => entry.text.includes('FROM community_posts'));
    assert.ok(listStatements.length >= 1, '列表读取必须真的下发过一条 community_posts 查询（否则上面的读数不是从库来的）');
    for (const entry of listStatements) {
      assert.match(entry.text, /\bWHERE\b/, `列表语句必须带 WHERE（筛选项已下推），实际：${entry.text}`);
      assert.match(entry.text, /LIMIT \$\d+::int/, `LIMIT 必须是绑定参数（分页在过滤之后），实际：${entry.text}`);
      const indexes = [...entry.text.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
      const largest = Math.max(0, ...indexes);
      assert.equal(entry.values.length, largest, `占位符 $1..$${largest} 必须与下发参数个数相等，实际 ${entry.values.length}`);
      for (let index = 1; index <= largest; index += 1) {
        assert.ok(indexes.includes(index), `占位符不得跳号：缺 $${index}（${entry.text}）`);
      }
    }

    // 逐位核对「crop_id → region_code → limit」的绑定顺序：占位符位序与 values 下标必须一一对应，
    // 否则"同一条 SQL 换个参数顺序"这种回归在真库上只会表现为"结果怪"，不会红。
    // 只取**这一次请求**新下发的语句（前面各节的语句已经混在同一个捕获数组里）。
    const beforeOrdered = statements.length;
    const orderedRequest = await call('GET', '/api/v1/posts?crop_id=crop-wheat&region_code=330100&limit=2');
    assert.equal(orderedRequest.status, 200, JSON.stringify(orderedRequest.body));
    const orderedStatements = statements
      .slice(beforeOrdered)
      .filter((entry) => entry.text.includes('FROM community_posts'));
    assert.ok(orderedStatements.length >= 1, '带 crop+region 的列表请求必须真的下发列表 SQL');
    const pushedStatement = orderedStatements[0];
    assert.match(pushedStatement.text, /crop_id = \$1\b/, `crop_id 必须是 $1，实际：${pushedStatement.text}`);
    assert.match(pushedStatement.text, /region_code = \$2\b/, `region_code 必须是 $2，实际：${pushedStatement.text}`);
    assert.match(pushedStatement.text, /LIMIT \$3::int/, `LIMIT 必须是 $3，实际：${pushedStatement.text}`);
    assert.deepEqual(pushedStatement.values.slice(0, 2), ['crop-wheat', '330100'], '值位序必须是 [crop_id, region_code]');
    assert.equal(pushedStatement.values.at(-1), 3, '服务层多要 1 行判「还有下一页」⇒ limit=2 的页下发 LIMIT 3');

    // 公开列表不得带 author 谓词（归属只由服务层按会话判；客户端拿不到 author 参数），
    // `mine` 列表必须把 author_id 写进 SQL 且绑定的是**会话主体**——这是 S8(b) 的第二道防线。
    const publicStatements = listStatements.filter((entry) => !/author_id = \$/.test(entry.text));
    assert.ok(publicStatements.length >= 1, '公开列表必须有下标：至少一条不带 author 谓词的列表语句');
    for (const entry of publicStatements) {
      assert.match(entry.text, /visibility = 'published'/, `公开列表的候选集必须是 published，实际：${entry.text}`);
    }
    const beforeMine = statements.length;
    await expectPublic('/api/v1/posts?mine=true&crop_id=crop-rice', [p2.id]);
    const mineStatement = statements
      .slice(beforeMine)
      .filter((entry) => entry.text.includes('FROM community_posts'))
      .at(0);
    assert.ok(mineStatement !== undefined, 'mine 请求必须真的下发列表 SQL');
    assert.match(mineStatement.text, /author_id = \$1::uuid/, `mine 列表必须把 author_id 下推，实际：${mineStatement.text}`);
    assert.match(mineStatement.text, /visibility <> 'deleted'/, 'mine 列表的 deleted 排除必须下推');
    assert.equal(mineStatement.values[0], a.user.id, 'author_id 绑定的必须是会话主体（不是客户端可传的参数）');
    note(`实际下发语句（节选）：${pushedStatement.text.replace(/\s+/g, ' ').slice(0, 180)}…`);
    note(`实际下发参数：${JSON.stringify(pushedStatement.values)}`);
    say(`语句读数：${listStatements.length} 条列表查询全部含 WHERE 与绑定 LIMIT；crop_id=$1 / region_code=$2 / LIMIT $3 位序正确，`
      + '公开列表无 author 谓词、mine 列表 author_id=$1 绑定会话主体');

    // ---- 12. 举报：state 恒 received（缺口登记，不是功能验证） -----------
    const reported = await call('POST', '/api/v1/reports', {
      token: b.token,
      payload: {
        target_ref: { type: 'post', id: p1.id, revision: p1.revision },
        reason_code: 'misleading',
        detail: '举报 state 缺口登记用（合成数据）',
      },
      headers: { 'idempotency-key': 'community-filter-pg-report-1' },
    });
    assert.equal(reported.status, 201, JSON.stringify(reported.body));
    const reportId = reported.body.data.id;
    assert.equal(reported.body.data.state, 'received', '创建时的 state 只能是 received');

    const ownReport = await call('GET', `/api/v1/reports/${reportId}`, { token: b.token });
    assert.equal(ownReport.status, 200);
    assert.equal(ownReport.body.data.state, 'received', '读回仍是 received');
    assert.equal((await call('GET', `/api/v1/reports/${reportId}`)).status, 404,
      '他人读他人举报必须 404（只回本人）');

    const dbState = (await owner.query('SELECT state::text AS state, revision FROM community_reports WHERE id = $1::uuid', [reportId])).rows[0];
    assert.deepEqual(dbState, { state: 'received', revision: 1 }, '库里就是 received，不是只在响应里写成 received');

    // 真库闭集：`community_reports.state` 是 `varchar(16)` + CHECK（不是 enum），
    // 三个值里只有 received 有写入端 —— 这才是"缺口"的可核对形态。
    const stateChecks = (await owner.query(
      `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
        WHERE t.relname = 'community_reports' AND c.contype = 'c'
          AND pg_get_constraintdef(c.oid) LIKE '%received%'`,
    )).rows.map((row) => row.def);
    assert.equal(stateChecks.length, 1, 'community_reports 必须恰有一条 state 闭集 CHECK');
    for (const label of ['received', 'isolated', 'closed']) {
      assert.match(stateChecks[0], new RegExp(`'${label}'`), `state CHECK 必须含 ${label}`);
    }
    note(`真库 state 闭集：${stateChecks[0]}`);

    // 推进通道：HTTP 面没有，store 没有，契约没有 —— 三处都要如实红着登记。
    for (const [label, method, path] of [
      ['PATCH /reports/{id}', 'PATCH', `/api/v1/reports/${reportId}`],
      ['POST /reports/{id}/state', 'POST', `/api/v1/reports/${reportId}/state`],
      ['PATCH /admin/reports/{id}', 'PATCH', `/api/v1/admin/reports/${reportId}`],
      ['POST /admin/reports/{id}/isolate', 'POST', `/api/v1/admin/reports/${reportId}/isolate`],
    ]) {
      const response = await call(method, path, { token: b.token });
      assert.equal(response.status, 404, `${label} 目前不存在（推进通道缺口），实际 ${response.status}`);
    }
    assert.equal('updateReport' in store, false, 'PG store 不得有改 state 的方法（缺口登记：有的话本行必须红）');
    assert.equal('setReportState' in store, false);

    const operations = (() => {
      const parsed = contractJson('operations.json');
      return Array.isArray(parsed) ? parsed : (parsed.operations ?? Object.values(parsed));
    })();
    const reportOps = operations
      .filter((operation) => JSON.stringify(operation).toLowerCase().includes('report'))
      .map((operation) => `${operation.method.toUpperCase()} ${operation.path}`)
      .sort();
    assert.deepEqual(reportOps, ['GET /reports/{id}', 'POST /reports'], '契约里举报只有创建 + 读自己两条（无更新/无管理端列表）');
    const openapi = contractJson('openapi.json');
    assert.deepEqual(
      Object.keys(openapi.paths).filter((path) => path.includes('report')).sort(),
      ['/reports', '/reports/{id}'],
      '契约 paths 里没有任何 /admin/reports* 面',
    );

    note('GAP（缺口登记，不是功能验证）：举报 state 写入端只有 `received`（service.ts:1402 硬编码）；'
      + 'store 只有 insertReport/getReport；契约只有 createReport/getOwnReport；/admin/reports* 不存在。'
      + '真库闭集 3 值，可达 1 值。');
    say('举报缺口登记：真库 state=received 落库可读、他人读 404；推进通道在 HTTP/store/契约三处都不存在（B 片待补）');

    // ---- 13. EXPLAIN：下推后的真实语句不再全表扫 -------------------------
    // 灌 1200 行合成数据，让规划器对"全表读 + 排序" vs "高选择性谓词"做出真实选择（不是 3 行时的小表假象）。
    await owner.query(
      `INSERT INTO community_posts
         (id, author_id, revision, title, body, crop_id, region_code, media_ids, visibility, audit_state, created_at, updated_at)
       SELECT gen_random_uuid(), $1::uuid, 1, 'EXPLAIN 读数 ' || g, 'EXPLAIN 读数正文 ' || g,
              'crop-explain-' || (g % 40), '33' || lpad((100 + (g % 90))::text, 4, '0'), '{}'::text[],
              'published', 'approved',
              timestamptz '2026-09-01' + (g || ' seconds')::interval,
              timestamptz '2026-09-01' + (g || ' seconds')::interval
         FROM generate_series(1, 1200) g`,
      [a.user.id],
    );
    await owner.query('ANALYZE community_posts');
    const rowsNow = (await owner.query('SELECT count(*)::int AS n FROM community_posts')).rows[0].n;
    assert.equal(rowsNow, 1205, '5 条种子 + 1200 条 EXPLAIN 夹具');

    const planOf = async (sql, values = []) => (await owner.query(`EXPLAIN (FORMAT TEXT) ${sql}`, values))
      .rows.map((row) => String(Object.values(row)[0]));
    const planText = (lines) => lines.join('\n');

    // 直接 EXPLAIN **服务层真的下发的那条语句**（含它的真实参数），不是另写一条"等价式"。
    const emittedPlan = await planOf(pushedStatement.text, pushedStatement.values);
    note(`下推语句计划：${planText(emittedPlan).replace(/\s+/g, ' ')}`);
    assert.equal(/\bSeq Scan on community_posts\b/.test(planText(emittedPlan)), false,
      '筛选下推后不得再退化成 community_posts 全表扫');
    assert.match(planText(emittedPlan), /community_posts_feed_idx/,
      'crop_id/region_code 前导列的索引必须被选中（筛选下推才有意义）');
    assert.match(planText(emittedPlan), /Limit/, 'LIMIT 必须在计划里（分页在过滤之后）');

    // 同一条件的两条查询：一条真 key（命中 2 行）、一条高位区（命中 0 行），都必须非 Seq Scan。
    const emptyKeyPlan = await planOf(pushedStatement.text, ['crop-explain-999', '330100', 3]);
    note(`空结果计划：${planText(emptyKeyPlan).replace(/\s+/g, ' ')}`);
    assert.equal(/\bSeq Scan on community_posts\b/.test(planText(emptyKeyPlan)), false,
      '高选择性谓词下不应退化成全表扫');

    say('EXPLAIN 读数：服务层下发的真实语句 = Index Scan using community_posts_feed_idx + LIMIT（不再 Seq Scan）');

    // ---- 14. 分页确定性：同 created_at 的行靠 id 做 tie-breaker，翻页不重不漏 ----
    // 40 行**同一时刻**创建：没有 `ORDER BY created_at DESC, id DESC` 的 tie-breaker 时，
    // `LIMIT/OFFSET` 或 keyset 都会因为行序不稳定而重复/漏行。
    const tieIds = (await owner.query(
      `INSERT INTO community_posts
         (id, author_id, revision, title, body, crop_id, region_code, media_ids, visibility, audit_state, created_at, updated_at)
       SELECT gen_random_uuid(), $1::uuid, 1, '同刻 ' || g, '同刻正文 ' || g, 'crop-tie', '330101', '{}'::text[],
              'published', 'approved', timestamptz '2026-08-01 00:00:00+00', timestamptz '2026-08-01 00:00:00+00'
         FROM generate_series(1, 40) g
       RETURNING id`,
      [a.user.id],
    )).rows.map((row) => row.id);
    assert.equal(tieIds.length, 40, '同刻夹具必须灌满 40 行');
    await owner.query('ANALYZE community_posts');

    const walk = async (path, pageSize) => {
      const seen = [];
      let cursor = null;
      for (let guard = 0; guard < 50; guard += 1) {
        const suffix = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
        const response = await call('GET', `${path}${suffix}&limit=${pageSize}`);
        assert.equal(response.status, 200, JSON.stringify(response.body));
        seen.push(...response.body.data.items.map((item) => item.id));
        cursor = response.body.data.next_cursor;
        if (cursor === null) break;
      }
      assert.equal(cursor, null, '游标遍历必须在 50 页内收口（否则是空转）');
      return seen;
    };
    const tieWalk = await walk('/api/v1/posts?mine=true&crop_id=crop-tie', 7);
    assert.equal(tieWalk.length, 40, `同刻 40 行必须被页遍历完整覆盖，实际 ${tieWalk.length}`);
    assert.equal(new Set(tieWalk).size, 40, '翻页不得重复行（tie-breaker 缺失时同刻行会在页边界重复）');
    const tieOrder = (await owner.query(
      `SELECT id FROM community_posts WHERE crop_id = 'crop-tie' ORDER BY created_at DESC, id DESC`,
    )).rows.map((row) => row.id);
    assert.deepEqual(tieWalk, tieOrder, '翻页顺序必须与库内 `created_at DESC, id DESC` 逐位相等');

    // 同刻行的 keyset 边界：游标必须严格按 (created_at, id) 前进——第二页从第 10 行开始，不包含游标行本身。
    const tiePage1 = await call('GET', '/api/v1/posts?mine=true&crop_id=crop-tie&limit=9');
    assert.equal(tiePage1.status, 200, JSON.stringify(tiePage1.body));
    assert.equal(tiePage1.body.data.items.length, 9, '第一页必须满 9 行');
    assert.equal(tiePage1.body.data.items.at(-1).id, tieOrder[8], '第一页最后一行必须是全序第 9 行');
    const tieCursor = tiePage1.body.data.next_cursor;
    assert.equal(typeof tieCursor, 'string', '40 行 + limit=9 ⇒ 必须给 next_cursor');
    const tiePage2 = await call(
      'GET',
      `/api/v1/posts?mine=true&crop_id=crop-tie&limit=9&cursor=${encodeURIComponent(tieCursor)}`,
    );
    assert.equal(tiePage2.status, 200, JSON.stringify(tiePage2.body));
    assert.equal(tiePage2.body.data.items[0].id, tieOrder[9], '第二页必须从全序第 10 行开始（keyset 严格小于游标行）');

    // 越权负控制（S8 的同一族）：同一条 `mine=true` 换个主体 ⇒ 看不到对方的同刻行。
    const foreignTie = await call('GET', '/api/v1/posts?mine=true&crop_id=crop-tie&limit=50', { token: b.token });
    assert.equal(foreignTie.status, 200, JSON.stringify(foreignTie.body));
    assert.deepEqual(foreignTie.body.data.items, [], 'B 的 mine 列表不得出现 A 的同刻 40 行（author 谓词由服务层按会话给）');
    const foreignCount = (await owner.query(
      "SELECT count(*)::int AS n FROM community_posts WHERE author_id = $1::uuid AND crop_id = 'crop-tie'",
      [b.user.id],
    )).rows[0].n;
    assert.equal(foreignCount, 0, '库里 B 本来就没有同刻行 ⇒ 上面空列表不是"过滤把有变无"');
    note(`分页确定性：40 条同刻行、pageSize=7 ⇒ 翻页 ${tieWalk.length} 条、无重复、顺序与库内一致`);
    say('分页确定性：同 created_at 的 40 行走 id tie-breaker 翻页不重不漏、顺序与库内一致；B 看不到 A 的同刻行（越权负控制）');
  } finally {
    if (app !== null) await app.close().catch(() => {});
    if (pool !== null) await pool.end().catch(() => {});
    await owner.end().catch(() => {});
  }
}

// 失败要**干净地红**：打印失败点与已通过组数后 exit 1（而不是让未捕获拒绝把进程带崩，
// 那样的退出码在 Windows 上会变成 0xC0000409，看日志的人分不清是"断言失败"还是"运行时崩了"）。
try {
  await main();
  console.log(`\n全部 ${passed} 组真库断言通过。`);
} catch (error) {
  console.error(`\nFAIL（已通过 ${passed} 组，第 ${passed + 1} 组真库读数不满足）：`);
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  console.error('\nEXITCODE=1 —— 真库读数不满足，不是"跳过"，也不是"通过"。');
  // ⛔ 不用 `process.exit(1)`：本进程还挂着 fetch 的空闲连接，硬退在 Windows 上会撞
  // libuv 断言（0xC0000409），日志里就分不清"断言失败"和"运行时崩了"。置退出码后自然收尾。
  process.exitCode = 1;
}

