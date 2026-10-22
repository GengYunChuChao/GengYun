// GY-I12（#12）· **引用可溯源**真库臂 · PostgreSQL 17（迁移 0001/0002/0005/0008/0010/0012/0013）
//
// 运行（本机隔离集群，仅回环；库名硬钉 `gengyun_qa_citations_test`，要求**空库**）：
//   createdb -h 127.0.0.1 -p <port> gengyun_qa_citations_test
//   $env:QA_CITATIONS_PG_TEST_URL='postgres://postgres@127.0.0.1:<port>/gengyun_qa_citations_test'
//   node tests/integration/qa-citations-pg.mjs
//
// 本文件与 `tests/integration/conversations-pg.mjs` **分工不同、不重叠**：那份证明"会话链接在真库上端到端
// 成立"（解析、幂等、重启读回、写穿、注入阻断）；这份只回答 #12 验收核心的一句话——
// **每个回答的来源引用都必须能回溯到已入库的数据行，零命中必须拒答**。
//
// 覆盖的读数（派单 §3 四问逐条对应）：
//   [M] 迁移子集按序应用 + 二连跑 `applied.length === 0`（读面视图依赖 0012 的 `created_at`）。
//   [A] 读面准入：published + verified + valid 的两行进 `catalog_read.current_knowledge`；
//       `rejected` 与 `expired` 两行 0 行进（视图条件即产品判据，不是测试自造的过滤）。
//   [S] **引用可溯源（主证）**：一条真轮次落库后，把 `conversation_answers.citations` 的十键
//       **反向**用 SQL 从 `sources` / `source_versions` 重新算一遍，与落库值逐字段相等；
//       且每条引用的 `id` 在 `catalog_read.current_knowledge` 里恰好 1 行（∈ 本次检索集合的读面快照）。
//       ⇒ 引用不是模型自由文本，而是入库行的投影。
//   [O] **顺序（composer 先于 guard、且看到同一批来源）**：`retrieval.read` 与 `composer.compose`
//       都换成**转调真实现**的记录壳（只加观测、不改行为，守卫不替身）；断言调用序
//       `retrieval → compose`，composer 拿到的条目集与检索端口返回的逐条相同，且它据该集合产出的
//       两条引用**原样**出现在 HTTP 回答与 `conversation_answers.citations` 里
//       ⇒ 守卫校验的正是"模型真正看到的那批来源"。
//   [F] **反向控制（产品守卫，未替身）**：composer 替身模拟"模型输出了被拒/过期来源的引用"
//       ⇒ 回答整条 `blocked`、`check_state=blocked`、零引用，且 `conversation_answers.citations` 零引用。
//       （守卫若失效，本节与 [P] 立刻红 —— 这是本项目"模型输出越界引用"的真红入口。）
//   [B] **零命中必拒答**：清空知识集合 ⇒ 检索端口 `items=[]` ⇒ 端到端 `insufficient`/`passed`、
//       零引用、零用量卡，落库行同口径；拒答文案非空且不含编造依据。
//   [P] 不变量对账：全库落库引用的 id 集合恒 ⊆ 已入库且通过准入的来源；被拒/过期 id 0 次出现；
//       所有引用 URL 均为 https（契约可表达）。
//
// 真红口径（本文件是"证据片"，不改产品代码；红/绿由产品源一次性变异取证，见证据页）：
//   NC-1 去掉引用校验（`conversations/guard.ts` 的逐字段/集合内判定短路成"照单全收"）⇒ [F] 与 [P] 必须红；
//   NC-2 零命中仍作答（guard 把空集合分支改成 `answered`）⇒ [B] 必须红。
//   两轮变异后 `git checkout -- <file>` 恢复，`Get-FileHash` 前后一致才写结论。
//
// 未配置 `QA_CITATIONS_PG_TEST_URL` ⇒ 打印 SKIP 并以 **77** 退出（POSIX「skipped」＝未取得，不是通过）。
// 仓内 `tests/unit/integration-script-coverage.test.mjs` 的「整链跳过必须给 77」守卫逐文件扫描
// `tests/integration/*.mjs`，把「打印 SKIP 却 exit 0」判成假绿并点名（⛔ 不得放宽）；
// 本机明知无真库时用 `--allow-skip` / `GY_ALLOW_SKIP=1` 显式取 0。

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';

import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createPostgresAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';
import { createPool } from '../../services/api/src/db/pool.ts';
import { applyMigrations, discoverMigrations } from '../../services/api/src/db/migrate.ts';

const DB = 'gengyun_qa_citations_test';
const ENV = 'QA_CITATIONS_PG_TEST_URL';
const API = '/api/v1';

// 迁移子集同 `conversations-pg.mjs`：0001 基础 → 0002 知识/来源 → 0005 读面来源视图
// → 0008 幂等键 → 0010 读面知识视图 → 0012 `created_at` 列 + 视图重建 → 0013 会话三表。
const MIGRATION_VERSIONS = Object.freeze(['0001', '0002', '0005', '0008', '0010', '0012', '0013']);

// 合成农业文本：不含危险混配/不定量用量/注入话术，保证筛查层放行（本文件不测注入阻断）。
const QUESTION = '水稻田杂草怎么防除？';
const BODY = '水稻田杂草以防除稗草、鸭舌草为主：先人工清除，再按登记标签选用登记制剂，用量以标签为准，雨后及时补查。';

const ALLOW_SKIP = process.argv.includes('--allow-skip') || process.env.GY_ALLOW_SKIP === '1';
const raw = (process.env[ENV] ?? '').trim();
if (raw === '') {
  console.log(`SKIP real PG17: ${ENV} 未设置 —— 本次运行没有验证"引用可溯源"的真库口径（不是通过，也不是失败）。`);
  console.log(
    `     运行方式：${ENV}=postgres://postgres@127.0.0.1:<port>/${DB} node tests/integration/qa-citations-pg.mjs` +
      '（一次性集群可用 E:\\GengYunCommander\\.pg17\\pgsql\\bin 起，收工 pg_ctl stop -m fast）',
  );
  if (ALLOW_SKIP) {
    console.log('EXITCODE=0（--allow-skip / GY_ALLOW_SKIP=1 已显式授权：仅本机开发，⛔ 不得接进门禁）。');
    process.exit(0);
  }
  console.log('EXITCODE=77 表示未取得，不是通过（POSIX 惯例 skipped；本机明知无真库时可显式加 --allow-skip 取 0）。');
  process.exit(77);
}

const url = new URL(raw);
assert.ok(['postgres:', 'postgresql:'].includes(url.protocol), '只接受 postgres:// / postgresql://');
assert.equal(url.search, '', 'URL 不允许查询参数（防误连）');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), '本测试只允许回环地址');
assert.equal(url.pathname, `/${DB}`, `库名必须硬钉为 ${DB}（防误连）`);

let passes = 0;
function say(line) {
  passes += 1;
  console.log(`PASS ${line}`);
}

const owner = new pg.Client({ connectionString: url.href });
await owner.connect();
const apps = [];
let pool = null;
const q = async (text, params = []) => (await owner.query(text, params)).rows;
const one = async (text, params = []) => (await q(text, params))[0];
const countOf = async (text, params = []) => Number((await one(text, params)).v);

/** 契约 `SourceRef` 十键（与 `conversations/view.ts` 的 `sourceRefViewOf` 同形同序）。 */
function sourceRefOf(row) {
  return {
    id: row.sourceId,
    version: row.version,
    title: row.title,
    url: row.url,
    publisher: row.publisher,
    source_kind: row.sourceKind,
    evidence_kind: row.evidenceKind,
    validity: row.validity,
    review_status: row.reviewStatus,
    updated_at: row.retrievedAt.toISOString(),
  };
}

const REVIEWER = randomUUID();

/**
 * 播种"来源 + 来源版本 + 知识行"。
 * 硬约束：`knowledge_versions.knowledge_id` **必须等于** `sources.id`
 * （`conversations/retrieval.ts` 的 `retrievalItemOf` 逐条断言 `source.id === id`，不等即整条链 503）。
 */
async function seedSource(label, overrides = {}) {
  const spec = {
    label,
    title: `水稻田杂草防除要点（合成·${label}）`,
    version: `synthetic-${label}-v1`,
    validity: 'valid',
    reviewStatus: 'verified',
    ...overrides,
  };
  const sourceId = randomUUID();
  const versionId = randomUUID();
  const knowledgeRowId = randomUUID();
  const sourceUrl = `https://synthetic.invalid/qa-citations/${label}`;
  const publisher = '合成资料（非生产）';
  await q(
    'INSERT INTO sources (id,title,canonical_url,publisher,source_kind,evidence_kind) VALUES ($1::uuid,$2,$3,$4,$5,$6)',
    [sourceId, spec.title, sourceUrl, publisher, 'database', 'research'],
  );
  const retrievedAt = new Date(spec.retrievedAtMs);
  await q(
    `INSERT INTO source_versions
       (id,source_id,version,content_hash,locator,retrieved_at,valid_from,valid_to,validity,review_status,reviewed_by,reviewed_at)
     VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,$11::uuid,$12)`,
    [
      versionId,
      sourceId,
      spec.version,
      randomBytes(32).toString('hex'),
      `synthetic://qa-citations/${label}`,
      retrievedAt,
      new Date(spec.validFromMs),
      new Date(spec.validToMs),
      spec.validity,
      spec.reviewStatus,
      REVIEWER,
      retrievedAt,
    ],
  );
  await q('UPDATE sources SET current_version_id=$1::uuid WHERE id=$2::uuid', [versionId, sourceId]);
  await q(
    `INSERT INTO knowledge_versions (id,knowledge_id,revision,title,body,type,source_version_id,visibility)
     VALUES ($1::uuid,$2::uuid,1,$3,$4,'species',$5::uuid,'published')`,
    [knowledgeRowId, sourceId, spec.title, spec.body ?? BODY, versionId],
  );
  return {
    sourceId,
    versionId,
    knowledgeRowId,
    title: spec.title,
    url: sourceUrl,
    publisher,
    version: spec.version,
    sourceKind: 'database',
    evidenceKind: 'research',
    validity: spec.validity,
    reviewStatus: spec.reviewStatus,
    retrievedAt,
  };
}

/**
 * 从**基表**重新算一条来源的十键投影。
 *
 * 这是本文件的主证手段：期望值不由播种变量提供（那等于拿夹具自证夹具），而是用 SQL
 * 重新读 `sources` + `sources.current_version_id → source_versions`，独立算出落库引用"应该"是什么。
 */
async function projectionOfRow(sourceId) {
  const row = await one(
    `SELECT s.id AS source_id, s.title, s.canonical_url, s.publisher,
            s.source_kind::text AS source_kind, s.evidence_kind::text AS evidence_kind,
            sv.version, sv.validity::text AS validity, sv.review_status::text AS review_status,
            sv.retrieved_at
       FROM sources s
       JOIN source_versions sv ON sv.id = s.current_version_id
      WHERE s.id = $1::uuid`,
    [sourceId],
  );
  assert.ok(row !== undefined, `来源行必须存在：${sourceId}`);
  return {
    id: row.source_id,
    version: row.version,
    title: row.title,
    url: row.canonical_url,
    publisher: row.publisher,
    source_kind: row.source_kind,
    evidence_kind: row.evidence_kind,
    validity: row.validity,
    review_status: row.review_status,
    updated_at: row.retrieved_at.toISOString(),
  };
}

async function launchApp(conversationInjection) {
  const config = {
    ...loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
    logLevel: 'silent',
    executionMode: 'real',
    requiresRealCredentials: true,
    sessionSigningKey: randomBytes(32).toString('hex'),
  };
  // 主链不传注入：真 store / 真检索 / 真守卫 / 真读面都由 app 自己装配。
  // 只有 [O]（记录壳，转调真实现）与 [F]（composer 替身，扮演"模型输出越界引用"）会传注入，
  // 且**从不**替换 guard —— 守卫是本节被验对象，替身它等于绕开证据。
  const app = buildApp({
    config,
    pool,
    now: () => new Date(),
    ...(conversationInjection === undefined ? {} : { conversationInjection }),
  });
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  apps.push(app);
  const call = async (path, { method = 'GET', token, headers = {}, body } = {}) => {
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
    return { status: response.status, body: parsed, text };
  };
  return { app, origin, call, config };
}

/** 建会话 + 提问 + drain + 读回回答（三段重复调用抽成一处，避免读面前后口径漂移）。 */
async function askAndRead(target, token, text = QUESTION) {
  const created = await target.call(`${API}/conversations`, { method: 'POST', token, headers: { 'idempotency-key': `conv-${randomUUID()}` }, body: {} });
  assert.equal(created.status, 201, created.text);
  const conversationId = created.body.data.id;
  const accepted = await target.call(`${API}/conversations/${conversationId}/turns`, {
    method: 'POST',
    token,
    headers: { 'idempotency-key': `turn-${randomUUID()}`, 'if-match': '"1"' },
    body: { input_type: 'text', text },
  });
  assert.equal(accepted.status, 202, accepted.text);
  assert.equal(accepted.body.data.state, 'queued');
  assert.equal(accepted.body.data.result, null, '受理时不得提前给结果');
  await target.app.conversationService.drain();
  const listed = await target.call(`${API}/conversations/${conversationId}/turns?limit=50`, { token });
  assert.equal(listed.status, 200, listed.text);
  assert.equal(listed.body.data.items.length, 1);
  const turn = listed.body.data.items[0];
  assert.ok(turn.answer !== null, '轮次必须挂上回答');
  const jobRead = await target.call(`${API}/jobs/${accepted.body.data.id}`, { token });
  assert.equal(jobRead.status, 200, jobRead.text);
  assert.deepEqual(jobRead.body.data.result.value, turn.answer, '作业读面与轮次读面必须是同一份回答');
  return { conversationId, turnId: turn.id, answer: turn.answer, jobState: jobRead.body.data.state };
}

const kb = Math.floor(Date.now() / 1000) * 1000; // 整秒：Date → timestamptz → ISO 往返逐字不变
const seedWindow = { retrievedAtMs: kb - 3600_000, validFromMs: kb - 86_400_000, validToMs: kb + 86_400_000 };

try {
  // -------------------------------------------------------------------------
  // [M] 迁移子集：按序应用 + 二连跑
  // -------------------------------------------------------------------------
  const version = (await owner.query('SHOW server_version')).rows[0].server_version;
  assert.match(version, /^17\.[0-9]+(?:\D|$)/, `需要 PostgreSQL 17（现场：${version}）`);
  console.log(`Real PostgreSQL server_version: ${version}`);
  assert.equal(
    await countOf("SELECT count(*)::int AS v FROM pg_tables WHERE schemaname = 'public'"),
    0,
    '要求空库（防误连到有数据的库）',
  );
  const migrations = discoverMigrations().filter((m) => MIGRATION_VERSIONS.includes(m.version));
  assert.deepEqual(migrations.map((m) => m.version), [...MIGRATION_VERSIONS], '迁移子集必须齐、且按版本递增');
  const firstApply = await applyMigrations(owner, migrations);
  assert.deepEqual(firstApply.applied, [...MIGRATION_VERSIONS]);
  const secondApply = await applyMigrations(owner, migrations);
  assert.equal(secondApply.applied.length, 0, '二连跑不得重复应用');
  assert.equal(
    await countOf("SELECT count(*)::int AS v FROM information_schema.columns WHERE table_schema='public' AND table_name='knowledge_versions' AND column_name='created_at'"),
    1,
    '0012 必须真跑（读面排序依赖它）',
  );
  say(`[M] 真库 ${version}：迁移子集 ${MIGRATION_VERSIONS.join('/')} 按序应用，二连跑 applied=[]`);

  // -------------------------------------------------------------------------
  // [A] 播种与读数准入
  // -------------------------------------------------------------------------
  await q(
    "INSERT INTO knowledge_dataset_modes (mode,description,accepts_database,accepts_verified_seed) VALUES ('real','synthetic isolated qa-citations fixture only',true,true)",
  );
  await q(
    "INSERT INTO knowledge_dataset_config (key,value,mode) VALUES ('active_mode','real','real'),('database_connected','true','real')",
  );
  // `source_versions.reviewed_by` 的 FK 指向 `admin_accounts.id` ⇒ 核对人必须是真管理员行（只造主体，不授予权限）。
  await q(
    "INSERT INTO admin_accounts (id,login_name,credential_hash) VALUES ($1::uuid,'synthetic-qa-citations-reviewer','synthetic-not-a-credential')",
    [REVIEWER],
  );

  const first = await seedSource('accepted-1', seedWindow);
  const secondSource = await seedSource('accepted-2', { ...seedWindow, retrievedAtMs: kb - 1800_000 });
  const rejected = await seedSource('rejected', { reviewStatus: 'rejected', ...seedWindow });
  const expired = await seedSource('expired', { validity: 'expired', ...seedWindow });

  assert.equal(await countOf('SELECT count(*)::int AS v FROM catalog_read.current_knowledge'), 2, '读面只放行 2 条');
  for (const hidden of [rejected, expired]) {
    assert.equal(
      await countOf('SELECT count(*)::int AS v FROM catalog_read.current_knowledge WHERE id = $1::uuid', [hidden.sourceId]),
      0,
      `被拒/过期条目不得进读面：${hidden.title}`,
    );
  }
  say('[A] 读面准入：2 条 verified+valid 进行；rejected 与 expired 两行 0 行可见');

  // -------------------------------------------------------------------------
  // [G] 真装配
  // -------------------------------------------------------------------------
  assert.equal(pool, null);
  pool = createPool(url.href);
  assert.ok(pool !== null, 'createPool 必须返回连接池');
  const auth = createPostgresAuthStore({ query: (text, params) => pool.query(text, params) });
  const user = await auth.createUser(randomBytes(32).toString('hex'));
  const token = `qa-citations-${randomBytes(24).toString('hex')}`;
  const sessionId = await auth.createSession({
    userId: user.id,
    tokenHashHex: hashToken(token),
    authEpoch: user.authEpoch,
    expiresAt: new Date(Date.now() + 6 * 3600_000),
    audience: 'user',
  });
  const identity = {
    userId: user.id,
    authEpoch: user.authEpoch,
    role: 'user',
    sessionId,
    expiresAt: new Date(Date.now() + 6 * 3600_000),
    revision: user.revision,
    scopes: [],
  };

  const main = await launchApp();
  const service = main.app.conversationService;
  assert.ok(service !== null, 'real + pool 下会话服务必须非空');
  assert.equal(service.store.persistent, true, 'store 必须是 PG 实现');
  assert.equal(typeof service.guard.check, 'function', '守卫必须是真实现（本文件不替身守卫）');
  const set = await service.retrieval.read({ identity, token, conditions: null });
  assert.notEqual(set, null);
  // 集合顺序由读面排序（created_at 倒序）决定，测试不钉死顺序，只钉死"成员恰好是这两条"。
  const setIds = set.items.map((item) => item.id);
  assert.deepEqual([...setIds].sort(), [first.sourceId, secondSource.sourceId].sort(), '检索集合成员恰好是两条已准入来源');
  say('[G] 真装配：无注入 ⇒ PG store + 真检索端口 + 真守卫；检索集合 2 条');

  // -------------------------------------------------------------------------
  // [S] 引用可溯源（主证）：落库引用的十键 ← 基表 SQL 逐字段复算
  // -------------------------------------------------------------------------
  const normal = await askAndRead(main, token);
  assert.equal(normal.answer.status, 'answered', normal.answer.status);
  assert.equal(normal.answer.check_state, 'passed');
  assert.ok(normal.answer.citations.length >= 1, '有来源的回答必须带引用');
  assert.ok(normal.answer.citations.length <= 20, '契约 citations.maxItems = 20');
  assert.equal(normal.jobState, 'succeeded');
  for (const citation of normal.answer.citations) {
    assert.deepEqual(citation, await projectionOfRow(citation.id), '引用十键必须逐字段等于基表行的投影');
    assert.equal(
      await countOf('SELECT count(*)::int AS v FROM catalog_read.current_knowledge WHERE id = $1::uuid', [citation.id]),
      1,
      `引用 id 必须落在读面快照里（∈ 本次检索集合）：${citation.id}`,
    );
    assert.ok(citation.url.startsWith('https://'), '引用 URL 必须是契约可表达的 https');
  }
  const persisted = await q(
    'SELECT status, check_state, citations, dose_cards FROM conversation_answers WHERE turn_id = $1::uuid',
    [normal.turnId],
  );
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].status, 'answered');
  assert.deepEqual(persisted[0].citations, normal.answer.citations, '落库引用与 HTTP 回答必须逐字一致');
  say(
    `[S] 引用可溯源：${normal.answer.citations.length} 条引用的十键逐字段等于基表复算值，且 id 均 ∈ 读面快照（落库与读面同源）`,
  );

  // -------------------------------------------------------------------------
  // [O] 顺序与同快照：retrieval → compose，且守卫校验的就是模型看到的那一批
  // -------------------------------------------------------------------------
  // 记录壳**转调产品实现**（只加观测）；composer 扮演"守规矩的模型"：只引用它**从本次集合里读到**的条目。
  const order = [];
  let seenSet = null;
  let composedCandidate = null;
  const observed = await launchApp({
    retrieval: {
      read: async (input) => {
        order.push('retrieval');
        return service.retrieval.read(input);
      },
    },
    composer: {
      compose: ({ set: composerSet }) => {
        order.push('compose');
        seenSet = composerSet;
        const picked = composerSet === null ? [] : composerSet.items.slice(0, 2).map((item) => item.source);
        composedCandidate = { text: '（记录壳：只引用本次检索集合里的条目）', citations: picked, dose_cards: [] };
        return composedCandidate;
      },
    },
  });
  assert.equal(observed.app.conversationService.store.persistent, true, '只换检索/回答器，store 仍须是 PG 实现');
  const composed = await askAndRead(observed, token);
  assert.deepEqual(order, ['retrieval', 'compose'], '顺序必须是先读检索集合、再让回答器看见它');
  assert.notEqual(seenSet, null, '回答器必须收到检索集合（不是 null）');
  assert.deepEqual(
    seenSet.items.map((item) => item.id),
    setIds,
    '回答器看到的条目集必须与检索端口返回的逐条相同（含顺序）',
  );
  assert.equal(composed.answer.citations.length, 2, '回答器据集合产出的两条引用必须原样留在回答里');
  for (const [index, citation] of composed.answer.citations.entries()) {
    assert.deepEqual(citation, composedCandidate.citations[index], '守卫不得改写被接受的引用（逐字段原样保留）');
    assert.ok(seenSet.items.some((item) => item.id === citation.id), '被接受的引用必须来自模型看到的那批条目');
  }
  const composedRow = await one(
    'SELECT citations FROM conversation_answers WHERE turn_id = $1::uuid',
    [composed.turnId],
  );
  assert.deepEqual(composedRow.citations, composed.answer.citations, '落库引用必须是回答器给出的那两条');
  say('[O] 顺序与同快照：retrieval → compose；回答器拿到的条目集与端口返回一致；两条引用原样进入回答与落库行');

  // -------------------------------------------------------------------------
  // [F] 反向控制（产品守卫，未替身）：模型输出越界引用 ⇒ blocked + 零引用
  // -------------------------------------------------------------------------
  const strayRefs = [sourceRefOf(rejected), sourceRefOf(expired)];
  const writeThrough = await launchApp({
    composer: {
      compose: () => ({ text: '（替身：模型输出了被拒/过期来源的引用）', citations: strayRefs, dose_cards: [] }),
    },
  });
  const stray = await askAndRead(writeThrough, token);
  // `blocked` 只可能来自守卫的"引用被拒"分支：替身确实输出了越界引用，否则这里会是 `insufficient`（零引用）。
  assert.equal(stray.answer.status, 'blocked', '模型输出越界引用必须整条被拦下（不是 insufficient）');
  assert.equal(stray.answer.check_state, 'blocked');
  assert.deepEqual(stray.answer.citations, [], '被拒来源不得出现在回答引用里');
  assert.deepEqual(stray.answer.dose_cards, []);
  assert.equal(stray.jobState, 'succeeded');
  const strayRow = await one('SELECT status, check_state, citations FROM conversation_answers WHERE turn_id = $1::uuid', [stray.turnId]);
  assert.equal(strayRow.status, 'blocked');
  assert.deepEqual(strayRow.citations, [], '越界引用不得写进 conversation_answers.citations');
  say('[F] 反向控制：模型输出被拒/过期来源的引用 ⇒ 回答 blocked/blocked、落库零引用（守卫为产品实现，未替身）');

  // -------------------------------------------------------------------------
  // [B] 零命中必拒答
  // -------------------------------------------------------------------------
  await q('DELETE FROM knowledge_versions');
  const emptySet = await service.retrieval.read({ identity, token, conditions: null });
  assert.deepEqual(emptySet.items, [], '知识集合清空后检索端口必须给出空集合（不是 null）');
  assert.match(emptySet.note, /^本次检索集合：0 条/);
  const empty = await askAndRead(main, token);
  assert.equal(empty.answer.status, 'insufficient', '没有依据时必须如实 insufficient（不许编造）');
  assert.equal(empty.answer.check_state, 'passed');
  assert.deepEqual(empty.answer.citations, [], '零命中必须零引用');
  assert.deepEqual(empty.answer.dose_cards, []);
  assert.ok(empty.answer.checked_text.length > 0, '拒答也必须给出可读文案');
  assert.ok(!empty.answer.checked_text.includes('稗草'), '拒答文案不得夹带正文片段（不得自由发挥）');
  const emptyRow = await one('SELECT status, check_state, citations FROM conversation_answers WHERE turn_id = $1::uuid', [empty.turnId]);
  assert.equal(emptyRow.status, 'insufficient');
  assert.deepEqual(emptyRow.citations, [], '零命中落库必须零引用');
  assert.equal(empty.jobState, 'succeeded', '拒答是"成功结算"，不是作业失败');
  say('[B] 零命中必拒答：端口 items=[] ⇒ 端到端 insufficient/passed、零引用、落库同口径、作业 succeeded');

  // -------------------------------------------------------------------------
  // [P] 不变量对账
  // -------------------------------------------------------------------------
  const allAnswers = await q(
    'SELECT status, citations FROM conversation_answers WHERE owner_id = $1::uuid ORDER BY created_at, id',
    [user.id],
  );
  assert.equal(allAnswers.length, 4, '四次轮次（正常/记录壳/越界替身/零命中）必须各落一行回答');
  assert.deepEqual(allAnswers.map((row) => row.status).sort(), ['answered', 'answered', 'blocked', 'insufficient']);
  const citedIds = [...new Set(allAnswers.flatMap((row) => row.citations.map((citation) => citation.id)))];
  assert.deepEqual(citedIds.sort(), [...setIds].sort(), '落库引用 id 集合必须恰好是本次读面那两条');
  for (const forbidden of [rejected.sourceId, expired.sourceId]) {
    assert.ok(!citedIds.includes(forbidden), `被拒/过期来源不得写进 conversation_answers.citations：${forbidden}`);
  }
  for (const row of allAnswers) {
    for (const citation of row.citations) {
      assert.deepEqual(citation, await projectionOfRow(citation.id), '任一落库引用都必须能回溯到基表行');
    }
  }
  assert.equal(
    await countOf('SELECT count(*)::int AS v FROM conversation_turns WHERE owner_id = $1::uuid', [user.id]),
    4,
    '轮次表 4 行（含零命中那一轮）',
  );
  say(`[P] 不变量：3 行回答（answered×2 / blocked×1）+ 零命中 1 行；落库引用 id 恒 ⊆ {${citedIds.join(', ')}}，被拒/过期 id 0 次出现`);

  console.log(`\nqa-citations-pg：${passes} 条读数全部通过（真 PostgreSQL ${version}）`);
} finally {
  for (const app of apps) {
    try {
      await app.close();
    } catch {
      // 关闭失败不影响结论；进程退出前必须释放连接。
    }
  }
  if (pool !== null) await pool.end();
  await owner.end();
}
