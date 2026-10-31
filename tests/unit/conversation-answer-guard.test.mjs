// GY-I12（#12）：输出守卫与**负控制**回归。
//
// 本文件的三条负控制按派单要求给出「注入即红 / 改前红·改后绿」的原始可观测差异：
//   NC1 候选引用超出本次检索集合 ⇒ 真守卫必须 `blocked` 并给出可判据的拒绝原因；
//       把守卫换成"恒通过"的替身，同一次调用就会把集合外的引用写进回答（**注入即红**）。
//   NC2 替身自称"真实模型" ⇒ 落库与读面仍必须是 `unimplemented:no-real-*`；
//       判据 `versionProblems` 对真实模型串返回问题（**红**），对真实输出为空（**绿**）。
//   NC4 候选引用的字段被改写（id 对得上但正文/来源被换）⇒ 必须 `source_mismatch`，不得放行。
//
// 本文件里的资料来源与用量卡**全部是合成替身**，不读真实资料库、不接真实模型。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversationFixture, retrievalItem, retrievalSet, assertShape, shapeIssues, loadSchema, CONVERSATIONS, JOBS } from './conversation-fixtures.mjs';
import { createAnswerGuard, createUnwiredDoseAuthority, groundedRegistrationNumbersOf, registrationNumbersInText } from '../../services/api/src/conversations/guard.ts';
import { createWiredRetrievalPort } from '../../services/api/src/conversations/guard.ts';
import { UNIMPLEMENTED_VERSION_PREFIX } from '../../services/api/src/conversations/types.ts';
import { createDeterministicDoseAuthority } from '../../services/api/src/conversations/dose.ts';

const QUESTION = '稻田杂草怎么防除？';
const ITEM = retrievalItem({
  id: '8de526e2-ada8-514a-bbab-a0da3e784b0d',
  title: '合成条目甲：稻田杂草防除要点（测试替身）',
  body: '稻田杂草防除要点：合成正文，仅用于回归，不含真实用量建议。',
});
const OUTSIDE = retrievalItem({
  id: '0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e',
  title: '集合外条目：从未被本次检索读到（测试替身）',
  body: '集合外正文。',
});

/** 「未接真实模型」的机器判据（与 HTTP 测试同一口径，重复定义以免跨文件耦合）。 */
function versionProblems(answer) {
  const problems = [];
  for (const key of ['model_version', 'prompt_version', 'rule_version']) {
    const value = answer[key];
    if (typeof value !== 'string' || !value.startsWith(UNIMPLEMENTED_VERSION_PREFIX)) {
      problems.push(`${key} 未标注"未接真实模型"：${JSON.stringify(value)}`);
    }
  }
  return problems;
}

/** 契约形状的合成用量卡（只在"权威路径放行"这条正向通道里用）。 */
function syntheticDoseCard(overrides = {}) {
  return {
    id: '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f',
    revision: 1,
    formulation: {
      id: '4d5e6f70-8b9c-4d0e-9f1a-2b3c4d5e6f70',
      registration_number: 'PD-SYNTHETIC-0001',
      producer: '合成生产者（测试替身）',
      dosage_form: '水分散粒剂',
      ingredients: [{ name: '合成有效成分', content_text: '20', unit_text: '%' }],
    },
    conditions: {
      crop_id: 'rice',
      region_code: '330100',
      species_id: 'synthetic-weed',
      growth_stage: '苗后',
      planting_method: '移栽',
      use_scene: '稻田',
    },
    original_text: '合成标签原文（测试替身，不是真实标签）。',
    unit_text: '克/亩',
    method_text: '合成施用方法（测试替身）。',
    precautions_text: '合成注意事项（测试替身）。',
    source: {
      id: '5e6f7081-9cad-4e1f-8a2b-3c4d5e6f7081',
      version: 'synthetic-2026.1',
      title: '合成登记信息（测试替身）',
      url: 'https://example.invalid/gengyun/synthetic-dose-source',
      publisher: '合成发布方（测试替身）',
      source_kind: 'database',
      evidence_kind: 'research',
      validity: 'valid',
      review_status: 'verified',
      updated_at: '2026-01-01T00:00:00.000Z',
    },
    locator: '合成定位串',
    content_hash: 'a'.repeat(64),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// NC1：引用只能取自本次检索集合
// ---------------------------------------------------------------------------

test('NC1 红：把守卫换成"恒通过"的替身，同一次调用会把集合外的引用写进回答（泄漏可见）', async (t) => {
  const hostileGuard = {
    dose: createUnwiredDoseAuthority(),
    check({ candidate }) {
      return {
        status: 'answered',
        check_state: 'passed',
        checked_text: candidate.text,
        citations: [...candidate.citations],
        dose_cards: candidate.dose_cards.map((entry) => entry.card),
        accepted_citations: candidate.citations.length,
        rejected_citations: [],
        rejected_dose_cards: [],
      };
    },
  };
  const hostileComposer = {
    kind: 'deterministic_guard_only',
    note: '负控制替身：故意给出集合外的引用',
    compose: () => ({ text: '（负控制）集合外引用', citations: [OUTSIDE.source], dose_cards: [] }),
  };
  const fixture = await conversationFixture(t, {
    injection: {
      guard: hostileGuard,
      composer: hostileComposer,
      retrieval: createWiredRetrievalPort({ note: '负控制：集合只含 ITEM', read: async (input) => retrievalSet(input.identity.userId, [ITEM]) }),
    },
  });
  const created = await fixture.createConversation({}, { tag: 'nc1' });
  const accepted = await fixture.call('POST', `${CONVERSATIONS}/${created.body.data.id}/turns`, fixture.a, {
    payload: { input_type: 'text', text: QUESTION },
    headers: { 'idempotency-key': 'idem-nc1-red', 'if-match': '"1"' },
  });
  assert.equal(accepted.status, 202);
  await fixture.app.conversationService.drain();
  const answer = (await fixture.call('GET', `${JOBS}/${accepted.body.data.id}`)).body.data.result.value;
  // 这就是"改前"的读数：泄漏**确实**会发生 —— 判据必须能看见它。
  assert.equal(answer.status, 'answered');
  assert.deepEqual(answer.citations.map((citation) => citation.id), [OUTSIDE.id]);
  const leaked = answer.citations.filter((citation) => citation.id !== ITEM.id);
  assert.equal(leaked.length, 1, '泄漏必须可被逐条检出（否则判据无意义）');
  assert.equal(fixture.conversationStore.snapshot().answers[0].citations[0].id, OUTSIDE.id, '泄漏也写进了持久层');
});

test('NC1 绿：真守卫拒绝对同一候选的集合外引用（blocked + 可判据原因 + 不落违规正文）', async (t) => {
  const fixture = await conversationFixture(t, {
    injection: {
      composer: {
        kind: 'deterministic_guard_only',
        note: '负控制替身：故意给出集合外的引用',
        compose: () => ({ text: '（负控制）集合外引用', citations: [OUTSIDE.source], dose_cards: [] }),
      },
      retrieval: createWiredRetrievalPort({ note: '负控制：集合只含 ITEM', read: async (input) => retrievalSet(input.identity.userId, [ITEM]) }),
    },
  });
  const created = await fixture.createConversation({}, { tag: 'nc1g' });
  const accepted = await fixture.call('POST', `${CONVERSATIONS}/${created.body.data.id}/turns`, fixture.a, {
    payload: { input_type: 'text', text: QUESTION },
    headers: { 'idempotency-key': 'idem-nc1-green', 'if-match': '"1"' },
  });
  await fixture.app.conversationService.drain();
  const job = await fixture.call('GET', `${JOBS}/${accepted.body.data.id}`);
  const answer = job.body.data.result.value;
  assert.equal(answer.status, 'blocked', `集合外引用必须被拒：${JSON.stringify(answer)}`);
  assert.equal(answer.check_state, 'blocked');
  assert.deepEqual(answer.citations, [], '被拒的引用不得出现在回答里');
  assert.equal(answer.checked_text.includes('（负控制）集合外引用'), false, '阻断时不得产出违规正文');
  assert.match(answer.checked_text, /输出守卫阻断/);
  assert.deepEqual(versionProblems(answer), []);
  const stored = fixture.conversationStore.snapshot().answers[0];
  assert.deepEqual(stored.citations, [], '持久层也不得留下被拒的引用');
});

test('守卫单元：集合外引用 / 字段被改写 / 重复 / 契约表达不了的来源，逐条拒绝且原因可判据', () => {
  const guard = createAnswerGuard({ dose: createUnwiredDoseAuthority() });
  const set = retrievalSet('user-1', [ITEM]);
  const text = '候选正文';
  const base = { question: QUESTION, conditions: null };

  const outside = guard.check({ candidate: { text, citations: [OUTSIDE.source], dose_cards: [] }, set, ...base });
  assert.equal(outside.status, 'blocked');
  assert.deepEqual(outside.rejected_citations, [`not_in_retrieval_set:${OUTSIDE.id}`]);
  assert.equal(outside.accepted_citations, 0);

  // NC4：id 对得上，但来源内容被换过 ⇒ 必须 source_mismatch（不得只看 id 就放行）。
  const rewritten = { ...ITEM.source, title: '被改写的标题' };
  const mismatch = guard.check({ candidate: { text, citations: [rewritten], dose_cards: [] }, set, ...base });
  assert.equal(mismatch.status, 'blocked');
  assert.deepEqual(mismatch.rejected_citations, [`source_mismatch:${ITEM.id}`]);

  const duplicated = guard.check({ candidate: { text, citations: [ITEM.source, ITEM.source], dose_cards: [] }, set, ...base });
  assert.equal(duplicated.status, 'blocked');
  assert.deepEqual(duplicated.rejected_citations, [`duplicate_citation:${ITEM.id}`]);

  // 契约表达不了的来源（http 而非 https）：不得静默丢弃后当作 answered 交付。
  const httpItem = retrievalItem({ id: '6f708192-ade0-4f2a-9b3c-4d5e6f708192', source: { url: 'http://example.invalid/x' } });
  const notRepresentable = guard.check({
    candidate: { text, citations: [httpItem.source], dose_cards: [] },
    set: retrievalSet('user-1', [httpItem]),
    ...base,
  });
  assert.equal(notRepresentable.status, 'blocked');
  assert.equal(notRepresentable.rejected_citations.length, 1);
  assert.match(notRepresentable.rejected_citations[0], /^source_not_representable:/);
  assert.match(notRepresentable.rejected_citations[0], /url_not_https/);

  // 正向：集合内引用逐字通过。
  const ok = guard.check({ candidate: { text, citations: [ITEM.source], dose_cards: [] }, set, ...base });
  assert.equal(ok.status, 'answered');
  assert.equal(ok.check_state, 'passed');
  assert.deepEqual(ok.citations, [ITEM.source]);
  assert.equal(ok.accepted_citations, 1);

  // 集合为 null（检索端口未接线）⇒ 如实 insufficient，且候选里的引用被记为拒绝而不是默默丢掉。
  const none = guard.check({ candidate: { text, citations: [ITEM.source], dose_cards: [] }, set: null, ...base });
  assert.equal(none.status, 'insufficient');
  assert.equal(none.check_state, 'passed');
  assert.deepEqual(none.rejected_citations, ['no_retrieval_set']);
  assert.deepEqual(none.citations, []);
});

test('守卫单元：正文层面的越界（生成侧自报 / 未检索链接）⇒ 整条阻断，不得挂合法引用洗白', () => {
  const guard = createAnswerGuard({ dose: createUnwiredDoseAuthority() });
  const set = retrievalSet('user-1', [ITEM]);
  const base = { question: QUESTION, conditions: null };

  // ① 生成侧自报正文越界（适配器扫到 [99] 后回空正文 + 违规项）⇒ 阻断；连"看起来合法"的
  //    引用也一并撤回 —— 否则等于用一份合法 citation 给被拒正文背书。
  const declared = guard.check({
    candidate: {
      text: '疑似越界正文',
      citations: [ITEM.source],
      dose_cards: [],
      text_violations: ['citation_marker_out_of_range:[99]'],
    },
    set,
    ...base,
  });
  assert.equal(declared.status, 'blocked');
  assert.equal(declared.check_state, 'blocked');
  assert.deepEqual(declared.rejected_text, ['citation_marker_out_of_range:[99]']);
  assert.deepEqual(declared.citations, [], '正文被拒时不得再挂合法引用');
  assert.equal(declared.checked_text.includes('疑似越界正文'), false, '阻断话术不得含被拒正文片段');

  // ② 上游没自报，但正文里有集合外链接 ⇒ 守卫**独立复核**同样拦（不依赖生成侧自检）。
  const ungrounded = guard.check({
    candidate: {
      text: '来源 https://fabricated.invalid/not-in-retrieval 。',
      citations: [ITEM.source],
      dose_cards: [],
    },
    set,
    ...base,
  });
  assert.equal(ungrounded.status, 'blocked', '未检索链接必须被守卫拦下');
  assert.deepEqual(ungrounded.rejected_text, ['unattributed_url:https://fabricated.invalid/not-in-retrieval']);
  assert.deepEqual(ungrounded.citations, []);

  // ③ 正控制：来源自带的 url ⇒ 放行（有出处，不是虚构链接）。
  const okSource = guard.check({
    candidate: { text: `识别要点见 ${ITEM.source.url} 。`, citations: [ITEM.source], dose_cards: [] },
    set,
    ...base,
  });
  assert.equal(okSource.status, 'answered');
  assert.deepEqual(okSource.rejected_text, []);
  assert.match(okSource.checked_text, /example\.invalid/u);

  // ④ 正控制：链接逐字出现在来源正文里 ⇒ 同样算有出处（确定性回答器会原样搬资料原文）。
  const withUrl = retrievalItem({
    id: '1a2b3c4d-5e6f-4a70-8b1c-2d3e4f5a6b7c',
    title: '合成条目乙：带链接的正文（测试替身）',
    body: '合成正文见 https://docs.invalid/synthetic-note 。',
  });
  const okBody = guard.check({
    candidate: { text: '识别要点见 https://docs.invalid/synthetic-note 。', citations: [withUrl.source], dose_cards: [] },
    set: retrievalSet('user-1', [withUrl]),
    ...base,
  });
  assert.equal(okBody.status, 'answered');
});

test('守卫单元：正文里的登记证号必须出自本次检索集合（未背书 ⇒ 整条阻断，与正文链接对称）', () => {
  const guard = createAnswerGuard({ dose: createUnwiredDoseAuthority() });
  const base = { question: QUESTION, conditions: null };

  // 两条**带登记证号**的合成条目：号码就写在 body 首行（真实资料同一形态：
  // `packages/reference/records.mjs` 的 `buildKnowledgeBody` 首行 `登记证号：…`）。
  const NUMBERED = retrievalItem({
    id: '7f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f',
    title: '合成条目丙：带登记证号的正文（测试替身）',
    body: '登记证号：PD20161371\n登记名称：合成药剂丙（测试替身）\n说明：不含真实用量建议。',
  });
  const OTHER_NUMBERED = retrievalItem({
    id: '6e5d4c3b-2a19-4b8c-9d0e-1f2a3b4c5d6e',
    title: '合成条目丁：另一条带登记证号的正文（测试替身）',
    body: '登记证号：PD20211218\n登记名称：合成药剂丁（测试替身）\n说明：不含真实用量建议。',
  });

  // 抽号：只认 `PD` + 正好 8 位，去重保序；背书集合逐字取自 body。
  assert.deepEqual(registrationNumbersInText('XPD20161371 / PD201613710 / PD20161371'), ['PD20161371']);
  assert.deepEqual([...groundedRegistrationNumbersOf([ITEM])], [], '正文里没有号码 ⇒ 没有任何可背书的号码');
  assert.deepEqual(
    [...groundedRegistrationNumbersOf([NUMBERED, OTHER_NUMBERED])].sort(),
    ['PD20161371', 'PD20211218'],
  );

  // T1 集合内号码 ⇒ 仍 answered（不得为堵漏误杀：确定性回答器会原样搬资料原文）。
  const grounded = guard.check({
    candidate: { text: '据资料 PD20161371，识别要点如上。', citations: [NUMBERED.source], dose_cards: [] },
    set: retrievalSet('user-1', [NUMBERED]),
    ...base,
  });
  assert.equal(grounded.status, 'answered');
  assert.deepEqual(grounded.rejected_text, []);
  assert.equal(grounded.checked_text.includes('PD20161371'), true);

  // T2 集合外号码 ⇒ 整条阻断，原因可判据（与 `unattributed_url:…` 同型）。
  const fabricated = guard.check({
    candidate: { text: '登记证号 PD20991234 可湿性粉剂，识别要点如上。', citations: [NUMBERED.source], dose_cards: [] },
    set: retrievalSet('user-1', [NUMBERED]),
    ...base,
  });
  assert.equal(fabricated.status, 'blocked', '未背书登记证号必须被守卫拦下');
  assert.deepEqual(fabricated.rejected_text, ['unattributed_registration_number:PD20991234']);
  assert.deepEqual(fabricated.citations, [], '正文被拒时不得再挂合法引用');
  assert.equal(fabricated.checked_text.includes('PD20991234'), false, '阻断话术不得含被拒号码');

  // T3 张冠李戴：号码真实存在，但属于**不在本次集合里**的条目 ⇒ 同样未背书。
  const borrowed = guard.check({
    candidate: { text: '登记证号 PD20211218 适用。', citations: [NUMBERED.source], dose_cards: [] },
    set: retrievalSet('user-1', [ITEM, NUMBERED]),
    ...base,
  });
  assert.equal(borrowed.status, 'blocked');
  assert.deepEqual(borrowed.rejected_text, ['unattributed_registration_number:PD20211218']);

  // T3b 已知边界（写进断言，免得把本判据误当成"号码与条目的绑定核对"）：两条**都在**集合里时，
  //     引用甲条目却报乙条目的号码**不**会被这一条拦下 —— 本判据只判「号码是否出自本次集合」。
  const bothInSet = guard.check({
    candidate: { text: '登记证号 PD20211218 适用[1]。', citations: [NUMBERED.source], dose_cards: [] },
    set: retrievalSet('user-1', [NUMBERED, OTHER_NUMBERED]),
    ...base,
  });
  assert.equal(bothInSet.status, 'answered', '集合内号码一律放行（语义绑定不在这条判据的范围内）');

  // T4 边界：`XPD20161371` / `PD201613710` 都不算号码（不许误杀长数字串里的片段）。
  const boundary = guard.check({
    candidate: { text: 'XPD20161371 与 PD201613710 都不是登记证号形态。', citations: [ITEM.source], dose_cards: [] },
    set: retrievalSet('user-1', [ITEM]),
    ...base,
  });
  assert.equal(boundary.status, 'answered');
  assert.deepEqual(boundary.rejected_text, []);

  // T5 没有本次检索集合（`set === null`）⇒ 仍是"资料不足"，不被新判据改道成 blocked。
  const noSet = guard.check({
    candidate: { text: '登记证号 PD20991234 的识别要点。', citations: [], dose_cards: [] },
    set: null,
    ...base,
  });
  assert.equal(noSet.status, 'insufficient');
  assert.equal(noSet.check_state, 'passed');
  assert.deepEqual(noSet.rejected_text, []);
});

test('守卫单元：登记证号形态边界 —— 尾随字母不算登记证号（T4b 尾随字母：不被背书，也不被拦下）', () => {
  const guard = createAnswerGuard({ dose: createUnwiredDoseAuthority() });
  const base = { question: QUESTION, conditions: null };

  const NUMBERED = retrievalItem({
    id: '7f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f',
    title: '合成条目丙：带登记证号的正文（测试替身）',
    body: '登记证号：PD20161371\n登记名称：合成药剂丙（测试替身）\n说明：不含真实用量建议。',
  });
  const TRAILING_LETTER = retrievalItem({
    id: '5c4b3a29-1807-4a6b-8c9d-0e1f2a3b4c5d',
    title: '合成条目己：登记证号尾随字母的正文（测试替身）',
    body: '登记证号：PD20161371X\n登记名称：合成药剂己（测试替身）\n说明：不含真实用量建议。',
  });

  // 抽号：尾粘字母（大写/小写）都不是本判据的形态 ⇒ 不许从长串里截出 `PD20161371`。
  assert.deepEqual(registrationNumbersInText('PD20161371X'), []);
  assert.deepEqual(registrationNumbersInText('PD20161371x'), []);
  assert.deepEqual(registrationNumbersInText('登记证号：PD20161371X。'), []);
  assert.deepEqual(
    [...groundedRegistrationNumbersOf([TRAILING_LETTER])],
    [],
    '尾粘字母的正文不得背书 PD20161371',
  );

  // 守卫口径：正文写 `PD20161371X` 时，它既不算"集合内号码"也不算"集合外号码" —— 本判据不认这个
  // 形态，因此**既不背书、也不拦下**（注释里 ⚠️ 那句"形态之外会漏"的具体落点，写进断言免得日后误读）。
  const trailing = guard.check({
    candidate: { text: '登记证号 PD20161371X 适用。', citations: [NUMBERED.source], dose_cards: [] },
    set: retrievalSet('user-1', [NUMBERED]),
    ...base,
  });
  assert.equal(trailing.status, 'answered');
  assert.deepEqual(trailing.rejected_text, []);
  assert.equal(trailing.checked_text.includes('PD20161371X'), true);

  // 关键判别：集合里**没有** `PD20161371` 时，`PD20161371X` 也不得被截成"未背书号码"去拦 ——
  // 尾边界还是 `(?![0-9])` 时这里会 blocked 且 rejected_text 报出一个正文里根本不存在的号码。
  const trailingAgainstPlain = guard.check({
    candidate: { text: '登记证号 PD20161371X 适用。', citations: [ITEM.source], dose_cards: [] },
    set: retrievalSet('user-1', [ITEM]),
    ...base,
  });
  assert.equal(trailingAgainstPlain.status, 'answered', '尾粘字母的串不得被截成 PD20161371 再判未背书');
  assert.deepEqual(trailingAgainstPlain.rejected_text, []);

  // 反向对照：同一集合，去掉尾字母就是本判据的形态 ⇒ 集合外号码照旧被拦（防止上面的"通过"掩盖判据失效）。
  const control = guard.check({
    candidate: { text: '登记证号 PD20161372 适用。', citations: [NUMBERED.source], dose_cards: [] },
    set: retrievalSet('user-1', [NUMBERED]),
    ...base,
  });
  assert.equal(control.status, 'blocked');
  assert.deepEqual(control.rejected_text, ['unattributed_registration_number:PD20161372']);
});

test('守卫单元：用量卡只能取自确定性权威路径 —— 集合外/未获权威放行的一律拒绝', () => {
  const unwired = createAnswerGuard({ dose: createUnwiredDoseAuthority() });
  const authoritative = createAnswerGuard({ dose: createDeterministicDoseAuthority() });
  const set = retrievalSet('user-1', [ITEM]);
  const card = syntheticDoseCard();
  const base = { question: QUESTION, conditions: null, text: '候选正文' };

  // 卡声称来自集合外的条目 ⇒ 拒绝。
  const orphan = unwired.check({ candidate: { ...base, citations: [], dose_cards: [{ card, source_item_id: OUTSIDE.id }] }, set, question: QUESTION, conditions: null });
  assert.equal(orphan.status, 'blocked');
  assert.deepEqual(orphan.rejected_dose_cards, [`dose_card_without_retrieval_item:${card.id}`]);
  assert.deepEqual(orphan.dose_cards, []);

  // 来源条目在集合内，但确定性权威路径不放行 ⇒ 拒绝，原因取权威自述（措辞不是本域编的）。
  const notAuthoritative = unwired.check({ candidate: { ...base, citations: [], dose_cards: [{ card, source_item_id: ITEM.id }] }, set, question: QUESTION, conditions: null });
  assert.equal(notAuthoritative.status, 'blocked');
  assert.deepEqual(notAuthoritative.rejected_dose_cards, ['dose_not_authoritative:dose_authority_unwired']);

  // 真实确定性权威（本基线对所有条目恒 renderable:false）⇒ 同样拒绝，理由来自域库描述子。
  const realAuthority = authoritative.check({ candidate: { ...base, citations: [], dose_cards: [{ card, source_item_id: ITEM.id }] }, set, question: QUESTION, conditions: null });
  assert.equal(realAuthority.status, 'blocked');
  assert.equal(realAuthority.rejected_dose_cards.length, 1);
  assert.match(realAuthority.rejected_dose_cards[0], /^dose_not_authoritative:/);
  assert.notEqual(realAuthority.rejected_dose_cards[0], 'dose_not_authoritative:dose_authority_unwired', '必须给出域库的真实理由，不是"未接线"');

  // 正向通道：唯一能让卡通过的办法是权威路径明确 renderable:true ⇒ 证明放行口真实存在（不是恒 false）。
  const permissive = createAnswerGuard({
    dose: { kind: 'wired', note: '负控制：恒放行的权威替身', available: true, ruleVersion: 'synthetic/1', authorize: () => ({ renderable: true, reason: 'synthetic_allowed' }) },
  });
  const allowed = permissive.check({ candidate: { ...base, citations: [], dose_cards: [{ card, source_item_id: ITEM.id }] }, set, question: QUESTION, conditions: null });
  assert.equal(allowed.status, 'answered');
  assert.equal(allowed.dose_cards.length, 1);
  assert.deepEqual(shapeIssues(loadSchema('DoseCard'), allowed.dose_cards[0], 'DoseCard'), [], '放行的卡必须是契约形状');
  assert.equal('source_item_id' in allowed.dose_cards[0], false, '来源条目 id 是守卫输入，不得进响应');

  // 用量卡上限 10：超出的必须被截断并如实记录。
  const eleven = Array.from({ length: 11 }, (_, index) => ({ card: syntheticDoseCard({ id: `7a8b9c0d-1e2f-4a3b-8c4d-5e6f708192${String(index).padStart(2, '0')}` }), source_item_id: ITEM.id }));
  const clipped = permissive.check({ candidate: { ...base, citations: [], dose_cards: eleven }, set, question: QUESTION, conditions: null });
  assert.equal(clipped.dose_cards.length, 10);
  assert.deepEqual(clipped.rejected_dose_cards, ['dose_card_over_limit']);
  for (const emitted of clipped.dose_cards) assert.deepEqual(shapeIssues(loadSchema('DoseCard'), emitted, 'DoseCard'), []);
});

test('守卫单元：空正文必须抛错（拒绝产出空回答），不得落一条空 answered', () => {
  const guard = createAnswerGuard({ dose: createUnwiredDoseAuthority() });
  assert.throws(
    () => guard.check({ candidate: { text: '   ', citations: [ITEM.source], dose_cards: [] }, set: retrievalSet('user-1', [ITEM]), question: QUESTION, conditions: null }),
    (error) => error.code === 'PROVIDER_UNAVAILABLE' && /空正文/.test(error.message),
  );
  // 无引用无卡时是 insufficient（不是抛错）：这是"资料不足"的合法结论。
  const empty = guard.check({ candidate: { text: '', citations: [], dose_cards: [] }, set: retrievalSet('user-1', [ITEM]), question: QUESTION, conditions: null });
  assert.equal(empty.status, 'insufficient');
  assert.equal(empty.check_state, 'passed');
});

// ---------------------------------------------------------------------------
// NC2：诚实标注（替身不得被表述为真实模型结果）
// ---------------------------------------------------------------------------

test('NC2 红：判据必须抓住"替身标成真实模型"', () => {
  for (const lie of ['gpt-4o-mini', 'claude-3-5-sonnet', 'qwen-max', 'real-model/2026', 'text-qa-v1']) {
    const problems = versionProblems({ model_version: lie, prompt_version: `${UNIMPLEMENTED_VERSION_PREFIX}prompt/x`, rule_version: `${UNIMPLEMENTED_VERSION_PREFIX}rule/x` });
    assert.equal(problems.length, 1, `判据必须抓住 model_version=${lie}`);
    assert.match(problems[0], /model_version/);
  }
  assert.equal(versionProblems({ model_version: 42, prompt_version: null, rule_version: undefined }).length, 3, '非字符串也必须被抓');
  assert.deepEqual(versionProblems({ model_version: `${UNIMPLEMENTED_VERSION_PREFIX}model/text-qa-deterministic`, prompt_version: `${UNIMPLEMENTED_VERSION_PREFIX}prompt/citation-guard-only`, rule_version: `${UNIMPLEMENTED_VERSION_PREFIX}rule/x` }), []);
});

test('NC2 绿：回答器无法决定版本串 —— 注入自称"真实模型"的替身，落库与读面仍是未接真实模型', async (t) => {
  // 替身在候选里塞进真实的模型标识（含额外键）：这些键**结构上**流不进 `Answer`。
  const lyingComposer = {
    kind: 'deterministic_guard_only',
    note: '负控制替身：自称真实模型',
    compose: () => ({
      text: '（负控制）自称真实模型',
      citations: [ITEM.source],
      dose_cards: [],
      model_version: 'gpt-4o-mini',
      prompt_version: 'prompt/production-v9',
      rule_version: 'rule/production-v9',
    }),
  };
  const fixture = await conversationFixture(t, {
    injection: {
      composer: lyingComposer,
      retrieval: createWiredRetrievalPort({ note: '负控制：集合含 ITEM', read: async (input) => retrievalSet(input.identity.userId, [ITEM]) }),
    },
  });
  const created = await fixture.createConversation({}, { tag: 'nc2' });
  const accepted = await fixture.call('POST', `${CONVERSATIONS}/${created.body.data.id}/turns`, fixture.a, {
    payload: { input_type: 'text', text: QUESTION },
    headers: { 'idempotency-key': 'idem-nc2', 'if-match': '"1"' },
  });
  await fixture.app.conversationService.drain();
  const answer = (await fixture.call('GET', `${JOBS}/${accepted.body.data.id}`)).body.data.result.value;

  assert.deepEqual(versionProblems(answer), [], `替身不得把自己标成真实模型：${JSON.stringify(answer)}`);
  assert.equal(answer.model_version, `${UNIMPLEMENTED_VERSION_PREFIX}model/text-qa-deterministic`);
  assert.equal(answer.prompt_version, `${UNIMPLEMENTED_VERSION_PREFIX}prompt/citation-guard-only`);
  assert.equal(answer.model_version.includes('gpt'), false);
  assert.equal(answer.prompt_version.includes('production'), false, '版本串只由服务层填充，替身的键不得透出');
  // 持久层与读面同源：两处都必须是不含谎言的同一份。
  const stored = fixture.conversationStore.snapshot().answers[0];
  assert.equal(stored.model_version, answer.model_version);
  assert.deepEqual(versionProblems(stored), []);
  assertShape('Answer', answer, 'Answer');
});

// ---------------------------------------------------------------------------
// NC3：删除级联（会话 ⇒ 轮次 ⇒ 回答）
// ---------------------------------------------------------------------------

test('NC3 绿：删除会话 ⇒ 轮次与回答一并消失（同一条断言在"只删会话"的实现下必红）', async (t) => {
  const fixture = await conversationFixture(t, {
    injection: { retrieval: createWiredRetrievalPort({ note: 'NC3：集合含 ITEM', read: async (input) => retrievalSet(input.identity.userId, [ITEM]) }) },
  });
  const created = await fixture.createConversation({}, { tag: 'nc3' });
  const conversationId = created.body.data.id;
  const accepted = await fixture.call('POST', `${CONVERSATIONS}/${conversationId}/turns`, fixture.a, {
    payload: { input_type: 'text', text: QUESTION },
    headers: { 'idempotency-key': 'idem-nc3', 'if-match': '"1"' },
  });
  assert.equal(accepted.status, 202);
  await fixture.app.conversationService.drain();
  const before = fixture.conversationStore.snapshot();
  assert.deepEqual(
    { conversations: before.conversations.length, turns: before.turns.length, answers: before.answers.length },
    { conversations: 1, turns: 1, answers: 1 },
    '前置：一条会话 + 一条轮次 + 一条回答',
  );

  const removed = await fixture.call('DELETE', `${CONVERSATIONS}/${conversationId}`, fixture.a, {
    headers: { 'idempotency-key': 'idem-nc3-del', 'if-match': '"1"' },
  });
  assert.equal(removed.status, 202);

  // ↓ 这条断言就是"漏级联"检测器：只删会话的实现会留下 turns/answers ⇒ 立即变红。
  const after = fixture.conversationStore.snapshot();
  assert.deepEqual(
    { conversations: after.conversations.length, turns: after.turns.length, answers: after.answers.length },
    { conversations: 0, turns: 0, answers: 0 },
    '删除会话必须级联到轮次与回答（内存实现显式级联；PG 实现靠 ON DELETE CASCADE）',
  );
  // 删除后同一 id 如实 404（不是 200 空壳）。
  const gone = await fixture.call('GET', `${CONVERSATIONS}/${conversationId}`);
  assert.equal(gone.status, 404);
  // 轮次与回答也不可再被读到（作业读面同样 404，不泄漏已删资源）。
  const job = await fixture.call('GET', `${JOBS}/${accepted.body.data.id}`);
  assert.equal(job.status, 404);
  assert.equal(job.body.error.code, 'NOT_FOUND');
});
