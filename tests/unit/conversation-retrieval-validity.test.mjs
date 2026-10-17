// GY-I12（#12）D3：检索集合的**有效性判定**与**按提问预排序**回归（纯代码，无真实外发）。
//
// 覆盖（派单 §1.4 三条判据）：
//  1) `expired` / `withdrawn` / `conflicting`（外加 `rejected` / `unknown`）三/五条资料的行为读数：
//     过期 ⇒ 不引用、撤回 ⇒ 不引用、冲突 ⇒ 不引用**并如实标注「来源相互冲突」**（不解释冲突内容）；
//  2) 同一 ≥60 条资料集、同六个提问，top-3 命中率**改动前 vs 改动后**两组数字（同一跑出，相对比较）；
//  3) 集合仍来自**同一个读面实例**（`face` 身份 + 单次 `list` + 原样查询参数 + 装配层单实例静态断言）。
//
// 另覆盖：`UNPROVABLE_CONDITIONS` 短路与 `SESSION_REQUIRED` 既有行为不变、排序稳定且不放宽过滤、
// 候选池超出上限时"排序先于截断"。
//
// 全部资料为**合成替身**（`example.invalid`、`测试替身`），不读真实资料库、不接真实模型、不发外发调用。
// 本文件是**新增文件**：不改动任何既有 `conversation-*` 断言（派单 §1.5）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { conversationFixture, JOBS, retrievalItem, retrievalSet } from './conversation-fixtures.mjs';
import { createWiredRetrievalPort } from '../../services/api/src/conversations/guard.ts';
import {
  RELEVANCE_RULE,
  createDeterministicAnswerComposer,
  relevanceScore,
  relevanceShingles,
} from '../../services/api/src/conversations/service.ts';
import {
  RETRIEVAL_LIMIT,
  RETRIEVAL_RANK_RULE,
  createKnowledgeRetrievalPort,
  questionMatchScore,
  questionShingles,
  rankByQuestion,
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
// ③ top-3 命中率：改动前 vs 改动后（同一资料集、同一提问集）
// ---------------------------------------------------------------------------

const CORPUS_SIZE = 60;
const COVERED_TERMS = ['稗草', '千金子', '鸭舌草', '矮慈姑', '水莎草', '异型莎草'];
/** 目标条目的读面位置：前三个在"读面顺序前 50 条"内，后三个在**之外**（改动前根本读不到）。 */
const COVERED_POSITIONS = [4, 20, 40, 52, 56, 59];

function corpusId(index) {
  return `5eed0000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

/**
 * ≥60 条合成资料：六个"目标条目"（各自带一个**只在本条出现**的主题词）+ 54 条填充条目。
 *
 * 填充正文刻意与六个提问**零字面重合**：字面打分对它们恒为 0，所以命中与否只取决于
 * "目标条目是否在候选池里、是否排在前面"这两件事 —— 这正是 D3② 要测的东西。
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

test(`top-3 命中率（同一 ${CORPUS_SIZE} 条资料集、同 ${COVERED_QUESTIONS.length} 个提问）：改动后不低于改动前`, async (t) => {
  // 「改动前」的读法替身：同一资料集，按**读面顺序**取前 RETRIEVAL_LIMIT 条（不判有效性、不排序）。
  const baselinePort = createWiredRetrievalPort({
    note: '基线替身：改动前的读法（读面顺序前 50 条，不判有效性、不按提问排序）',
    async read({ identity }) {
      return retrievalSet(identity.userId, CORPUS.slice(0, RETRIEVAL_LIMIT));
    },
  });
  // 「改动后」：真实装配（`createKnowledgeRetrievalPort` + 同一 `face` 返回同一资料集）。
  const newPort = createKnowledgeRetrievalPort({ face: { list: async () => ({ items: CORPUS }) } });

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
    rows.push({
      term,
      baseline: baselineIds.includes(target.id),
      after: newIds.includes(target.id),
      baselineIds,
      newIds,
      newTop: newIds[0],
      targetId: target.id,
    });
  }

  const baselineHits = rows.filter((row) => row.baseline).length;
  const newHits = rows.filter((row) => row.after).length;
  const total = rows.length;
  const baselineRate = baselineHits / total;
  const newRate = newHits / total;
  t.diagnostic(
    `top-3 命中率：改动前 ${baselineHits}/${total}=${(baselineRate * 100).toFixed(1)}% → 改动后 ${newHits}/${total}=${(newRate * 100).toFixed(1)}%（同一 ${CORPUS_SIZE} 条资料集、同 ${total} 个提问）`,
  );
  for (const row of rows) {
    t.diagnostic(`  ${row.term}：改动前 ${row.baseline ? '命中' : '未命中'} ${JSON.stringify(row.baselineIds)} → 改动后 ${row.after ? '命中' : '未命中'} ${JSON.stringify(row.newIds)}`);
  }

  // 硬判据：改动后不低于改动前（派单 §1.4②）。
  assert.ok(
    newHits >= baselineHits,
    `top-3 命中率不得回落：改动前 ${baselineHits}/${total}，改动后 ${newHits}/${total}`,
  );
  // 读数落点：前三个目标在改动前也能命中（它们在"读面顺序前 50 条"里），后三个必然读不到。
  assert.equal(baselineHits, 3, `改动前的基线读数应为 3/${total}（读面顺序前 50 条只覆盖前三个目标），实得 ${baselineHits}`);
  assert.equal(newHits, total, `改动后应 ${total}/${total} 全命中（排序把读面顺序第 50 条以后的目标提到前面），实得 ${newHits}`);
  // 排在最前的是目标条目本身（不是"碰巧也在 top-3 里"）。
  for (const row of rows) assert.equal(row.newTop, row.targetId, `${row.term}：预排序后第一条必须是与提问最重合的目标条目`);
  assert.equal(RETRIEVAL_RANK_RULE, 'cjk-bigram+word-match/1');
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
// ⑤ 既有行为不变：UNPROVABLE_CONDITIONS 短路、SESSION_REQUIRED、候选池先排序后截断
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

test('候选池超出上限：先按提问排序再截断，保留的是最重合的条目（不是读面顺序的尾部）', async (t) => {
  const port = createKnowledgeRetrievalPort({ face: { list: async () => ({ items: CORPUS }) } });
  const fixture = await conversationFixture(t, { injection: { retrieval: port } });

  // 「异型莎草」的目标条目在读面顺序第 59 位（远超上限 50）——排序必须先于截断才留得住它。
  const term = '异型莎草';
  const target = COVERED_TARGETS.get(term);
  const set = await readOnce(port, fixture, `${term}怎么处理？`);

  assert.equal(set.items.length, RETRIEVAL_LIMIT, `集合长度必须是上限 ${RETRIEVAL_LIMIT}`);
  assert.equal(set.items[0].id, target.id, '与提问最重合的条目必须排第一（且不被截断丢掉）');
  assert.match(set.note, new RegExp(`候选池 ${CORPUS_SIZE} 条超出上限`, 'u'));
  assert.match(set.note, /按与提问的字面重合度（cjk-bigram\+word-match\/1）保留前 50 条/u);
  // 截断后集合内仍是"有效"条目：没有把剔除项混回来。
  for (const item of set.items) assert.equal(validityVerdictOf(item.source).usable, true);
});

test('预排序：按提问字面重合度降序、同分保持读面顺序（稳定），不放宽过滤', () => {
  const shingles = questionShingles('稗草怎么处理？');
  assert.ok(shingles.has('稗草'), '中文必须切成 bigram（稗草 应命中）');
  assert.ok(shingles.size > 0);

  const low = retrievalItem({ id: corpusId(0), title: '合成资料：与本轮无关', body: '占位正文。' });
  const high = retrievalItem({ id: corpusId(1), title: '合成资料：稗草的识别', body: '关于稗草的正文。' });
  const tie = retrievalItem({ id: corpusId(2), title: '合成资料：稗草相关', body: '关于稗草的正文。' });
  assert.ok(questionMatchScore(shingles, high) > questionMatchScore(shingles, low), '重合度高者分数必须更高');

  const ranked = rankByQuestion([low, high, tie], '稗草怎么处理？');
  assert.deepEqual(ranked.map((item) => item.id), [high.id, tie.id, low.id], '分数降序、同分保持输入顺序');
  assert.equal(ranked.length, 3, '排序不增删条目（过滤由有效性判定负责，不由排序负责）');
  // 空提问 ⇒ 不排序，读面顺序原样（不因为"没有提问"就把集合清空）。
  assert.deepEqual(rankByQuestion([low, high], '').map((item) => item.id), [low.id, high.id]);

  // 规则与回答器一致：本层不 import `service.ts`（D2 改动面），所以由这条断言锁住"两处规则同源"。
  // 一旦任一侧的规则名/分词/评分漂移，这里必红。
  const question = '稗草怎么处理？';
  assert.equal(RETRIEVAL_RANK_RULE, RELEVANCE_RULE, '预排序规则名必须与回答器一致');
  assert.deepEqual(
    [...questionShingles(question)].sort(),
    [...relevanceShingles(question)].sort(),
    '分词必须与回答器逐字一致',
  );
  for (const item of [low, high, tie]) {
    assert.equal(
      questionMatchScore(questionShingles(question), item),
      relevanceScore(relevanceShingles(question), item),
      '评分必须与回答器一致',
    );
  }
  // 回答器引用的顺序 = 本层预排序（本条资料集里分数两两不同，二者可逐位比较）。
  const composed = createDeterministicAnswerComposer().compose({
    question,
    conditions: null,
    set: { user_id: '11111111-1111-4111-8111-111111111111', items: [low, high, tie], note: '合成检索集合（测试替身）' },
  });
  assert.deepEqual(
    composed.citations.map((source) => source.id),
    rankByQuestion([low, high, tie], question).filter((item) => questionMatchScore(questionShingles(question), item) > 0)
      .slice(0, composed.citations.length)
      .map((item) => item.source.id),
    '预排序顺序必须与回答器引用顺序一致',
  );
});
