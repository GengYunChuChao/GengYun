// GY-I12（#12）D3：检索集合的**有效性判定**回归（纯代码，无真实外发）。
//
// 覆盖（派单 §1.4 三条判据）：
//  1) `expired` / `withdrawn` / `conflicting`（外加 `rejected` / `unknown`）三/五条资料的行为读数：
//     过期 ⇒ 不引用、撤回 ⇒ 不引用、冲突 ⇒ 不引用**并如实标注「来源相互冲突」**（不解释冲突内容）；
//  2) 同一 ≥60 条资料集、同六个提问，top-3 命中率**父版（`54ce029`）vs 新实现**两组数字 ——
//     **同一合规读面**（真实 `paginateKnowledge`，`limit = RETRIEVAL_LIMIT`）同比、同一跑出；
//     实测读数为**相同**（父版 3/6，新实现 3/6），因此这里断言"无提升"，不写任何提升结论；
//  3) 集合仍来自**同一个读面实例**（`face` 身份 + 单次 `list` + 原样查询参数 + 装配层单实例静态断言）。
//
// 另覆盖：`UNPROVABLE_CONDITIONS` 短路与 `SESSION_REQUIRED` 既有行为不变、
// 读面无视上限时"按读面顺序截断"（真实装配不可达，仅记录兜底语义）、
// 以及"本层不做提问排序"（排序在真实装配下不可观测，故整族删除，避免死代码）。
//
// 全部资料为**合成替身**（`example.invalid`、`测试替身`），不读真实资料库、不接真实模型、不发外发调用。
// 本文件是**新增文件**：不改动任何既有 `conversation-*` 断言（派单 §1.5）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { conversationFixture, JOBS, retrievalItem, retrievalSet } from './conversation-fixtures.mjs';
import { createWiredRetrievalPort } from '../../services/api/src/conversations/guard.ts';
import { ApiError } from '../../services/api/src/errors.ts';
import { paginateKnowledge } from '../../services/api/src/knowledge/pagination.ts';
import { RELEVANCE_RULE, createDeterministicAnswerComposer } from '../../services/api/src/conversations/service.ts';
import {
  RETRIEVAL_LIMIT,
  createKnowledgeRetrievalPort,
  knowledgeQueryOf,
  retrievalItemOf,
  retrievalItemsOf,
  validityVerdictOf,
} from '../../services/api/src/conversations/retrieval.ts';

// ---------------------------------------------------------------------------
// 判据与替身
// ---------------------------------------------------------------------------

/**
 * 六种有效性/审核态的合成条目（同一 `face` 一次返回）。
 *
 * `id` 互不相同且 `source.id` 跟随条目 id（`retrievalItem` 的既有约束），
 * 这样"哪一条进了集合"可以用 id 精确判定。
 */
function validityCase({ id, term, validity, reviewStatus }) {
  return retrievalItem({
    id,
    title: `合成资料：${term}的识别（测试替身）`,
    body: `关于${term}的合成正文：仅用于回归，不含真实用量建议。`,
    source: { validity, review_status: reviewStatus ?? 'unverified' },
  });
}

const CASE_VALID = validityCase({
  id: '2a000000-0000-4000-8000-000000000001', term: '稻瘟病', validity: 'valid',
});
const CASE_EXPIRED = validityCase({
  id: '2a000000-0000-4000-8000-000000000002', term: '稻飞虱', validity: 'expired',
});
const CASE_WITHDRAWN = validityCase({
  id: '2a000000-0000-4000-8000-000000000003', term: '稻曲病', validity: 'withdrawn',
});
const CASE_CONFLICTING = validityCase({
  id: '2a000000-0000-4000-8000-000000000004', term: '稻纵卷叶螟', validity: 'conflicting',
});
const CASE_UNKNOWN = validityCase({
  id: '2a000000-0000-4000-8000-000000000005', term: '二化螟', validity: 'unknown',
});
const CASE_REJECTED = validityCase({
  id: '2a000000-0000-4000-8000-000000000006', term: '三化螟', validity: 'valid', reviewStatus: 'rejected',
});

/** 一个**只有**单条资料的读面替身（用它的提问，就能读出"该条是否被当依据"）。 */
function singleFace(item, calls = []) {
  return {
    calls,
    async list(input, query) {
      calls.push({ input, query });
      return { items: [item] };
    },
  };
}

/** 直接读一次检索端口（不经 HTTP），拿到逐条留痕的 `note`。 */
async function readOnce(port, fixture, question, conditions = null) {
  return port.read({
    identity: { userId: fixture.a.user.id },
    question,
    token: fixture.a.token,
    conditions,
  });
}

/** 跑一条提问到回答结算，返回契约 `Answer`（与既有 HTTP 用例同一路径：会话 → 轮次 → 作业）。 */
async function askAndAnswer(fixture, question, tag) {
  const created = await fixture.createConversation({}, { tag: `c-${tag}` });
  assert.equal(created.status, 201, `建会话应 201：${JSON.stringify(created.body)}`);
  const accepted = await fixture.createTurn(
    created.body.data.id,
    1,
    { input_type: 'text', text: question },
    { tag: `t-${tag}` },
  );
  assert.equal(accepted.status, 202, `受理轮次应 202：${JSON.stringify(accepted.body)}`);
  const job = await fixture.call('GET', `${JOBS}/${accepted.body.data.id}`);
  assert.equal(job.status, 200, `作业读面应 200：${JSON.stringify(job.body)}`);
  assert.equal(job.body.data.state, 'succeeded', `作业必须结算成功：${JSON.stringify(job.body.data.error_code)}`);
  return job.body.data.result.value;
}

function citationIds(answer) {
  return answer.citations.map((citation) => citation.id);
}

// ---------------------------------------------------------------------------
// ① 有效性判定：不进集合 + 逐条留痕 + 措辞取自既有口径
// ---------------------------------------------------------------------------

test('有效性判定：expired/withdrawn/conflicting/unknown/rejected 一律不进集合，valid 保留，逐类留痕', async (t) => {
  const items = [CASE_VALID, CASE_EXPIRED, CASE_WITHDRAWN, CASE_CONFLICTING, CASE_UNKNOWN, CASE_REJECTED];
  const port = createKnowledgeRetrievalPort({ face: { list: async () => ({ items }) } });

  const fixture = await conversationFixture(t, { injection: { retrieval: port } });
  const set = await readOnce(port, fixture, '稻瘟病怎么防除？');

  assert.deepEqual(
    set.items.map((item) => item.id),
    [CASE_VALID.id],
    '只有 validity=valid 且 review_status 非 rejected 的条目能进集合',
  );
  // 来源字段**逐行如实透出**：集合内的那条仍是读面给的 valid/unverified，没有被"洗白"。
  assert.equal(set.items[0].source.validity, 'valid');
  assert.equal(set.items[0].source.review_status, 'unverified');

  // 逐条留痕（不静默丢弃）：每一类都必须出现在 note 里，且原因措辞与 reference 包既有口径一致。
  assert.match(set.note, /有效性判定剔除 5 条/u);
  assert.match(set.note, /validity=expired 1 条：来源已过期/u);
  assert.match(set.note, /validity=withdrawn 1 条：来源已撤回/u);
  assert.match(set.note, /validity=conflicting 1 条：来源相互冲突/u);
  assert.match(set.note, /validity=unknown 1 条：来源有效期未知/u);
  assert.match(set.note, /review_status=rejected 1 条：未通过核对/u);
  assert.match(set.note, /本次检索集合：1 条（读面 \/knowledge 同一快照；上限 50 条，未翻页）/u);

  // 判定读数（反向控制的观测点：过滤被去掉时这一段必红）。
  assert.deepEqual(validityVerdictOf(CASE_VALID.source), { usable: true });
  for (const item of [CASE_EXPIRED, CASE_WITHDRAWN, CASE_CONFLICTING, CASE_UNKNOWN, CASE_REJECTED]) {
    assert.equal(validityVerdictOf(item.source).usable, false, `${item.source.validity}/${item.source.review_status} 必须判为不可用`);
  }
  assert.equal(validityVerdictOf(CASE_CONFLICTING.source).conflicting, true, 'conflicting 必须被单独标注');
  assert.equal(validityVerdictOf(CASE_EXPIRED.source).conflicting, false, 'expired 不是 conflicting');
});

// ---------------------------------------------------------------------------
// ② 三条资料的行为读数（真实回环 HTTP）：不引用 / 不引用 / 说明冲突
// ---------------------------------------------------------------------------

test('行为读数：过期 ⇒ 不引用；撤回 ⇒ 不引用；冲突 ⇒ 不引用并如实标注「来源相互冲突」', async (t) => {
  const readings = [];

  for (const [label, item, question] of [
    ['expired', CASE_EXPIRED, '稻飞虱怎么防除？'],
    ['withdrawn', CASE_WITHDRAWN, '稻曲病怎么防除？'],
    ['conflicting', CASE_CONFLICTING, '稻纵卷叶螟怎么防除？'],
  ]) {
    const port = createKnowledgeRetrievalPort({ face: singleFace(item) });
    const fixture = await conversationFixture(t, { injection: { retrieval: port } });
    const answer = await askAndAnswer(fixture, question, `validity-${label}`);

    // 行为读数 1：回答侧**不引用**（该条已退出检索集合 ⇒ 无可核对依据）。
    assert.deepEqual(citationIds(answer), [], `${label}：不得产出任何引用`);
    assert.deepEqual(answer.dose_cards, [], `${label}：不得产出用量卡`);
    assert.equal(answer.status, 'insufficient', `${label}：应如实判资料不足`);
    assert.equal(answer.check_state, 'passed');
    assert.match(answer.checked_text, /资料不足/u, `${label}：既有"资料不足"话术必须保留`);

    // 行为读数 2：读面侧**说明冲突**（note 是既有解释通道；它不进响应体，见交接的未取得项）。
    const set = await readOnce(port, fixture, question);
    assert.deepEqual(set.items, [], `${label}：集合必须为空`);
    readings.push({ label, note: set.note });
  }

  const byLabel = new Map(readings.map((entry) => [entry.label, entry.note]));
  assert.match(byLabel.get('expired'), /来源已过期/u);
  assert.match(byLabel.get('withdrawn'), /来源已撤回/u);

  const conflictNote = byLabel.get('conflicting');
  assert.match(conflictNote, /来源相互冲突/u, '冲突必须被单独标注（复用既有措辞）');
  assert.match(conflictNote, /其中 1 条为 conflicting/u);
  assert.match(conflictNote, /该条资料不足/u, '只说到"证不成"，如实说明资料不足');
  assert.match(conflictNote, /不解释冲突内容/u);
  // ⛔ 不得自行编造冲突解释：说明里不许出现因果/推测/建议式措辞。
  assert.doesNotMatch(conflictNote, /因为|原因是|可能是|推测|建议/u, '冲突说明不得编造解释');
});

// ---------------------------------------------------------------------------
// ③ top-3 命中率：父版 vs 新实现 —— **同一个合规读面**（真实分页，limit = RETRIEVAL_LIMIT）
// ---------------------------------------------------------------------------

const CORPUS_SIZE = 60;
const COVERED_TERMS = ['稗草', '千金子', '鸭舌草', '矮慈姑', '水莎草', '异型莎草'];
/**
 * 目标条目的**语料位置**：前三个 < `RETRIEVAL_LIMIT`（合规读面读得到），
 * 后三个 >= `RETRIEVAL_LIMIT`（合规读面本来就读不到）。
 */
const COVERED_POSITIONS = [4, 20, 40, 52, 56, 59];

function corpusId(index) {
  return `5eed0000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

/**
 * ≥60 条合成资料：六个"目标条目"（各自带一个**只在本条出现**的主题词）+ 54 条填充条目。
 *
 * 填充正文刻意与六个提问**零字面重合**：字面打分对它们恒为 0，所以"是否命中"只取决于
 * "目标条目是否在读面本次返回的 50 条里"这一件事 —— 这正是要测的读面读数。
 */
function buildCorpus() {
  const targets = new Map();
  const corpus = [];
  for (let index = 0; index < CORPUS_SIZE; index += 1) {
    const position = COVERED_POSITIONS.indexOf(index);
    if (position === -1) {
      corpus.push(
        retrievalItem({
          id: corpusId(index),
          title: `合成填充条目 ${index}（测试替身）`,
          body: `第 ${index} 段占位正文：与本轮提问无关，仅用于把候选池撑到 ${CORPUS_SIZE} 条。`,
        }),
      );
      continue;
    }
    const term = COVERED_TERMS[position];
    const item = retrievalItem({
      id: corpusId(index),
      title: `合成资料：${term}的识别（测试替身）`,
      body: `关于${term}的合成正文：仅用于回归，不含真实用量建议。`,
    });
    targets.set(term, item);
    corpus.push(item);
  }
  return { corpus, targets };
}

const { corpus: CORPUS, targets: COVERED_TARGETS } = buildCorpus();
const COVERED_QUESTIONS = COVERED_TERMS.map((term) => ({ term, question: `${term}怎么处理？` }));

/**
 * 合规读面：**真实** `paginateKnowledge`（`services/api/src/knowledge/pagination.ts`）。
 *
 * 它做 `limit` 的 1..50 校验并按 `query.limit` 切片 —— 这就是 `/knowledge` 与检索端口
 * 实际共享的那一层。两个端口都接**同一个** face 实例，因此看到的是**同一份** 50 条。
 */
function compliantFace(items, calls = []) {
  return {
    calls,
    async list(input, query) {
      calls.push(query);
      return paginateKnowledge(items, {
        userId: input.identity.userId,
        authEpoch: 1,
        hmacKey: 'synthetic-i12-hmac-key',
        filter: {},
        snapshot: items,
        limit: query.limit,
      });
    },
  };
}

/**
 * 父版（`54ce029`）读法：把读面返回的条目**原样透出**。
 *
 * 父版原句是 `const items = retrievalItemsOf(result).map((row, index) => retrievalItemOf(row, \`#${index}\`));`
 * —— 不判有效性、不排序、**不截断**。基线必须与父版同形，才谈得上"同一读面同比"；
 * 上一版给基线强加 `CORPUS.slice(0, RETRIEVAL_LIMIT)` 正是虚假提升的来源（父版没有这句）。
 */
function parentBaselinePort(face) {
  return createWiredRetrievalPort({
    note: '基线：父版读法（同一读面原样透出，不判有效性、不排序、不截断）',
    async read({ identity, token, conditions }) {
      const { query } = knowledgeQueryOf(conditions);
      if (token === null) throw new ApiError('SESSION_REQUIRED', '检索集合读取需要受理时捕获的用户会话凭据');
      const result = await face.list({ identity, token }, query);
      const items = retrievalItemsOf(result).map((row, index) => retrievalItemOf(row, `#${index}`));
      return retrievalSet(identity.userId, items);
    },
  });
}

test(`top-3 命中率（同一合规读面、同一 ${CORPUS_SIZE} 条资料集、同 ${COVERED_QUESTIONS.length} 个提问）：父版与新实现读数相同`, async (t) => {
  const faceCalls = [];
  const face = compliantFace(CORPUS, faceCalls);
  const baselinePort = parentBaselinePort(face);
  const newPort = createKnowledgeRetrievalPort({ face });

  const baselineFixture = await conversationFixture(t, { injection: { retrieval: baselinePort } });
  const newFixture = await conversationFixture(t, { injection: { retrieval: newPort } });

  const rows = [];
  for (const [index, { term, question }] of COVERED_QUESTIONS.entries()) {
    const target = COVERED_TARGETS.get(term);
    const baselineAnswer = await askAndAnswer(baselineFixture, question, `base-${index}`);
    const newAnswer = await askAndAnswer(newFixture, question, `new-${index}`);
    const baselineIds = citationIds(baselineAnswer);
    const newIds = citationIds(newAnswer);
    assert.ok(baselineIds.length <= 3 && newIds.length <= 3, 'top-3 判据：引用条数不得超过 3');

    // 集合层读数：同一读面下两个端口拿到的成员与顺序逐一相同（不靠 HTTP 反推）。
    const baselineSet = await readOnce(baselinePort, baselineFixture, question);
    const newSet = await readOnce(newPort, newFixture, question);
    assert.ok(
      baselineSet.items.length === RETRIEVAL_LIMIT && newSet.items.length === RETRIEVAL_LIMIT,
      `${term}：两个端口都只拿到读面给的 ${RETRIEVAL_LIMIT} 条（上限来自读面，不是测试侧切片）`,
    );
    assert.deepEqual(
      newSet.items.map((item) => item.id),
      baselineSet.items.map((item) => item.id),
      `${term}：同一读面下检索集合必须逐条相同（成员与顺序）`,
    );

    rows.push({
      term,
      baseline: baselineIds.includes(target.id),
      after: newIds.includes(target.id),
      baselineIds,
      newIds,
      targetId: target.id,
    });
  }

  const baselineHits = rows.filter((row) => row.baseline).length;
  const newHits = rows.filter((row) => row.after).length;
  const total = rows.length;
  const baselineRate = baselineHits / total;
  const newRate = newHits / total;
  t.diagnostic(
    `top-3 命中率（同一合规读面，limit=${RETRIEVAL_LIMIT}）：父版 ${baselineHits}/${total}=${(baselineRate * 100).toFixed(1)}% → 新实现 ${newHits}/${total}=${(newRate * 100).toFixed(1)}%（差 ${newHits - baselineHits}）`,
  );
  for (const row of rows) {
    t.diagnostic(`  ${row.term}：父版 ${row.baseline ? '命中' : '未命中'} ${JSON.stringify(row.baselineIds)} → 新实现 ${row.after ? '命中' : '未命中'} ${JSON.stringify(row.newIds)}`);
  }

  // 读数落点（**实测，不美化**）：同一合规读面下父版 3/6、新实现 3/6，差 0 —— 没有提升可宣称。
  assert.equal(baselineHits, 3, `父版读数应为 3/${total}（读面只给出前 ${RETRIEVAL_LIMIT} 条，只覆盖前三个目标），实得 ${baselineHits}`);
  assert.equal(newHits, baselineHits, `同一读面下不得声称任何提升：父版 ${baselineHits}/${total}，新实现 ${newHits}/${total}`);
  assert.equal(newHits, 3, `新实现读数应为 3/${total}（与父版相同），实得 ${newHits}`);
  // 每个提问的引用逐条相同（顺序也相同）——这是"同一读面同一读数"的直接证据。
  for (const row of rows) {
    assert.deepEqual(row.newIds, row.baselineIds, `${row.term}：同一读面下引用必须逐条相同`);
  }
  // 未命中项正是"读面读不到"的那三个（位置 >= 上限）：原因是读面上限，不是排序。
  assert.deepEqual(
    rows.filter((row) => !row.after).map((row) => row.term),
    ['矮慈姑', '水莎草', '异型莎草'],
    '未命中的必须是位置 >= RETRIEVAL_LIMIT 的三个目标',
  );
  assert.deepEqual(COVERED_POSITIONS.filter((position) => position >= RETRIEVAL_LIMIT), [52, 56, 59]);
  // 读面确实按 limit=RETRIEVAL_LIMIT 被调用（合规读面的上限即检索端口的读面上限）。
  assert.deepEqual([...new Set(faceCalls.map((query) => query.limit))], [RETRIEVAL_LIMIT], '读面调用必须带 limit=RETRIEVAL_LIMIT');
  assert.ok(COVERED_POSITIONS.some((position) => position >= RETRIEVAL_LIMIT), '语料必须覆盖"读面读不到"的位置，否则测不出上限');
});

// ---------------------------------------------------------------------------
// ④ 同一读面实例：`face` 身份、单次 `list`、原样查询参数、装配层单实例
// ---------------------------------------------------------------------------

test('集合仍来自同一读面实例：face 身份不变、一次读取只调一次 list、查询参数原样透传', async (t) => {
  const seen = [];
  const face = {
    async list(input, query) {
      seen.push({ input, query, self: this });
      return { items: [CASE_VALID] };
    },
  };
  const port = createKnowledgeRetrievalPort({ face });
  const fixture = await conversationFixture(t, { injection: { retrieval: port } });
  seen.length = 0;

  const set = await readOnce(port, fixture, '稻瘟病怎么防除？', { crop_id: 'rice', region_code: '330100' });

  assert.equal(seen.length, 1, '一次检索集合读取只能调用读面一次（不翻页、不预取、不重读）');
  assert.equal(seen[0].self, face, '必须调用装配时传入的那个 face 实例（同一读面对象身份）');
  assert.equal(seen[0].input.identity.userId, fixture.a.user.id, '同一会话身份');
  assert.equal(seen[0].input.token, fixture.a.token, '同一会话凭据（异步阶段不跳过鉴权）');
  assert.deepEqual(seen[0].query, { limit: RETRIEVAL_LIMIT, crop_id: 'rice', region_code: '330100' });
  assert.equal('q' in seen[0].query, false, '不得把提问塞进读面的 q 过滤（那会是第二套读法，改变同一快照语义）');
  assert.deepEqual(set.items.map((item) => item.id), [CASE_VALID.id]);

  // 装配层：`/knowledge` 与本域共用**同一个** `knowledgeQueryFace` 实例。
  const appSource = readFileSync(new URL('../../services/api/src/app.ts', import.meta.url), 'utf8');
  assert.equal(
    (appSource.match(/createKnowledgeService\(/gu) ?? []).length,
    1,
    'app.ts 里只允许构造一个资料读面实例',
  );
  assert.match(appSource, /const knowledgeQueryFace = pool === null/u);
  assert.match(appSource, /createKnowledgeRetrievalPort\(\{ face: knowledgeQueryFace \}\)/u, '检索端口必须接这个实例');
  assert.match(appSource, /service: knowledgeQueryFace,/u, '/knowledge 路由必须接同一个实例');

  // 本文件侧：不得另起第二套读法（无 SQL、无连接池、无缓存、无自建读面）。
  const source = readFileSync(new URL('../../services/api/src/conversations/retrieval.ts', import.meta.url), 'utf8');
  // 只看**可执行代码**：文件头注释会解释"不建第二个连接池/不复制 createKnowledgeService"，注释不是读法。
  const code = source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '');
  assert.doesNotMatch(code, /\bSELECT\b|\bpool\b|new PgPool|createKnowledgeService|from 'pg'/u, '检索端口不得自建第二套读法');
  assert.doesNotMatch(code, /\bcache\b|cached/u, '检索端口不得缓存快照');
  assert.equal((code.match(/face\.list\(/gu) ?? []).length, 1, '读面调用点必须唯一');
});

// ---------------------------------------------------------------------------
// ⑤ 既有行为不变：UNPROVABLE_CONDITIONS 短路、SESSION_REQUIRED
// ---------------------------------------------------------------------------

test('既有短路话术与凭据行为不变：无法证成的条件直接空集合（不读面）、缺凭据仍抛 SESSION_REQUIRED', async (t) => {
  const seen = [];
  const face = {
    async list(input, query) {
      seen.push({ input, query });
      return { items: [CASE_VALID] };
    },
  };
  const port = createKnowledgeRetrievalPort({ face });
  const fixture = await conversationFixture(t, { injection: { retrieval: port } });

  const unprovable = await readOnce(port, fixture, '稻瘟病怎么防除？', { crop_id: 'rice', growth_stage: 'seedling' });
  assert.deepEqual(unprovable.items, [], '无法证成的条件 ⇒ 空集合（既有口径：证不成就没有依据）');
  assert.match(unprovable.note, /growth_stage 在当前读面无法证成/u);
  assert.equal(seen.length, 0, '无法证成的条件必须在读面之前短路（不发起读取）');

  await assert.rejects(
    port.read({ identity: { userId: fixture.a.user.id }, question: 'x', token: null, conditions: null }),
    (error) => error.code === 'SESSION_REQUIRED',
    '缺凭据必须如实失败，不得绕过会话校验',
  );
});

test('读面无视上限（真实装配不可达）：按读面顺序截断保留前 50 条，不放宽过滤，也不声称相关性取舍', async (t) => {
  // 违约读面：忽略 `query.limit` 一次返回全部。真实装配下不可达（见本用例末尾的机械判据），
  // 这里只用来把"兜底截断"的语义与措辞钉死，不当作能力宣称。
  const violatingFace = { async list() { return { items: CORPUS }; } };
  const port = createKnowledgeRetrievalPort({ face: violatingFace });
  const fixture = await conversationFixture(t, { injection: { retrieval: port } });

  const term = '异型莎草';
  const target = COVERED_TARGETS.get(term);
  const set = await readOnce(port, fixture, `${term}怎么处理？`);

  assert.equal(set.items.length, RETRIEVAL_LIMIT, `集合长度必须是上限 ${RETRIEVAL_LIMIT}`);
  assert.equal(set.items[0].id, CORPUS[0].id, '顺序就是读面顺序（本层不按提问重排）');
  assert.equal(
    set.items.some((item) => item.id === target.id),
    false,
    '读面顺序第 59 位的目标被上限截掉 —— 如实为未命中，不靠排序把它"提"进来',
  );
  assert.match(set.note, new RegExp(`候选池 ${CORPUS_SIZE} 条超出上限`, 'u'));
  assert.match(set.note, /按读面顺序保留前 50 条/u);
  assert.doesNotMatch(set.note, /重合度|cjk-bigram|相关性/u, '不得声称任何"按相关性取舍"的效果');
  // 截断后集合内仍是"有效"条目：没有把剔除项混回来。
  for (const item of set.items) assert.equal(validityVerdictOf(item.source).usable, true);

  // 机械判据：这一读面在真实装配下不可达 —— 真实分页对 limit > 50 直接拒绝。
  assert.throws(
    () => paginateKnowledge(CORPUS, {
      userId: '11111111-1111-4111-8111-111111111111',
      authEpoch: 1,
      hmacKey: 'synthetic-i12-hmac-key',
      filter: {},
      snapshot: CORPUS,
      limit: RETRIEVAL_LIMIT + 1,
    }),
    (error) => error.code === 'INVALID_REQUEST',
    `真实读面对 limit > ${RETRIEVAL_LIMIT} 必须拒绝（因此读面不会返回超过上限的候选池）`,
  );
  assert.equal(RETRIEVAL_LIMIT, 50, '读面上限即检索上限（同一个数，不另立一套）');
});

test('无死代码：本层不做提问排序（排序族已整族删除），排序规则只在回答器且引用顺序与集合顺序无关', async (t) => {
  // 行为判据：同一读面、不同提问 ⇒ 集合成员与顺序逐一相同。
  // （若本层按提问排序，两个提问的相对顺序不可能恒等 —— 本用例的语料里目标条目分数两两不同。）
  const face = { async list() { return { items: CORPUS }; } };
  const port = createKnowledgeRetrievalPort({ face });
  const fixture = await conversationFixture(t, { injection: { retrieval: port } });
  const first = await readOnce(port, fixture, '稗草怎么处理？');
  const second = await readOnce(port, fixture, '异型莎草怎么处理？');
  assert.deepEqual(
    first.items.map((item) => item.id),
    second.items.map((item) => item.id),
    '提问不得影响集合顺序（本层不排序）',
  );
  assert.deepEqual(
    first.items.map((item) => item.id),
    CORPUS.slice(0, RETRIEVAL_LIMIT).map((item) => item.id),
    '集合顺序 = 读面顺序',
  );
  assert.ok(first.items.length === RETRIEVAL_LIMIT, `集合长度应为 ${RETRIEVAL_LIMIT}`);

  // 源码判据：排序族不得以任何形式留存（删除即删除，不留"半死"分支）。
  const source = readFileSync(new URL('../../services/api/src/conversations/retrieval.ts', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '');
  assert.doesNotMatch(code, /rankByQuestion|questionShingles|questionMatchScore|RETRIEVAL_RANK_RULE/u, '排序死代码必须整族移除');
  assert.doesNotMatch(code, /重合度/u, '注释之外的代码里不得再出现"按相关性排序"的措辞');
  assert.equal((code.match(/validityVerdictOf\(item\.source\)/gu) ?? []).length, 1, '有效性判定必须保留且只有唯一一处调用点');
  assert.equal((source.match(/来源相互冲突/u) ?? []).length, 1, '冲突措辞逐字复用既有口径，不新增解释');

  // 回答器侧：规则名不变；引用顺序由分数 + id 决定，与集合顺序无关。
  assert.equal(RELEVANCE_RULE, 'cjk-bigram+word-match/1');
  const question = '稗草怎么处理？';
  const items = [
    retrievalItem({ id: corpusId(0), title: '合成资料：稗草的识别（测试替身）', body: '关于稗草的合成正文。' }),
    retrievalItem({ id: corpusId(1), title: '合成资料：稗草相关（测试替身）', body: '关于稗草的合成正文。' }),
  ];
  const userId = '11111111-1111-4111-8111-111111111111';
  const forward = createDeterministicAnswerComposer().compose({
    question, conditions: null, set: retrievalSet(userId, items),
  });
  const reversed = createDeterministicAnswerComposer().compose({
    question, conditions: null, set: retrievalSet(userId, [...items].reverse()),
  });
  assert.deepEqual(
    forward.citations.map((source) => source.id),
    reversed.citations.map((source) => source.id),
    '引用顺序必须与集合顺序无关（集合顺序因此不是可观测输出）',
  );
  assert.deepEqual(forward.checked_text, reversed.checked_text, 'checked_text 必须与集合顺序无关');
  assert.ok(forward.citations.length > 0, '合成条目必须真被引用（否则上面的"顺序无关"是空断言）');
});
