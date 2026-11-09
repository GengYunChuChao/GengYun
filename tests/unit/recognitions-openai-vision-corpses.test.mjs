/**
 * GY-R94 · `openai-vision-v1` 解析阶梯的**真尸体**回归（零网络：所有 fetch 都是假实现）。
 *
 * 夹具来源：用生产代码生成请求体、直连供应商连打 120 次，12 次失败**全部**是「HTTP 200 但
 * `message.content` 解析不出 JSON 对象」，连接断类 0 次。12 个原始响应体整份抄进
 * `tests/fixtures/openai-vision-corpse/`（**只有 body 文本，没有图片、没有凭据**）：
 * - 7 个结构类（`finish_reason=stop`）：正文里有候选对象，尾巴上多了 `$` / 散文 / 回显的
 *   `{"type": "json_object"}` / `^` / 同一对象两遍 / 缺 `}` / 多出 `]}`；
 * - 5 个预算类（`finish_reason=length`，`max_tokens=512` 与「思考」共用预算）：4 个 `content=""`，
 *   1 个断在 `reason` 字符串中间。
 *
 * 断言四类（与任务书一一对应）：
 * 1. 7 个结构类尸体**全部**解出候选（闭集内），不再落 `PROVIDER_OUTCOME_UNKNOWN`；
 * 2. 预算类仍返回 `null`（⇒ `PROVIDER_OUTCOME_UNKNOWN`），**不抛错**——解析器不猜；
 * 3. 正常 JSON（含围栏）不受影响；
 * 4. 恶意/垃圾内容不会产出闭集外的 `species_id`（安全网仍在 `normalizeOpenAiVisionCandidates`）。
 *
 * 这不是准确率证据，也不证明供应商可用：本文件只喂历史失败响应体。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createOpenAiVisionRecognitionProvider } from '../../services/api/src/recognitions/openai-vision-adapter.ts';
import {
  contentJsonCandidates,
  firstBalancedJsonObject,
  parseVisionJsonObject,
} from '../../services/api/src/recognitions/openai-vision-content.ts';

const FIXTURES = new URL('../fixtures/openai-vision-corpse/', import.meta.url);

/** 闭集取尸体里出现过的 id + 一个反例位，**顺序无关**（normalize 自己按分数排）。 */
const ALLOWED = ['species_barnyardgrass', 'species_crabgrass', 'species_goosegrass', 'species_lambsquarters'];

/** 最小合法 PNG 头（IHDR + 非零宽高），与 `requireLiveRecognitionImage` 的判据一致。 */
function pngBytes() {
  const header = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001', 'hex');
  return new Uint8Array(header);
}

function bodyOf(name) {
  return readFileSync(new URL(name, FIXTURES)).toString('utf8');
}

function imageSourceOf(bytes) {
  return { async read() { return bytes; } };
}

function gateStub() {
  return {
    async reserve() { return { id: 't1' }; },
    async settle() {},
  };
}

function provider(overrides = {}) {
  return createOpenAiVisionRecognitionProvider({
    endpoint: 'https://vision.example.invalid/v1/chat/completions',
    apiKey: 'k-test',
    model: 'vision-model-test',
    speciesIds: ALLOWED,
    imageSource: imageSourceOf(pngBytes()),
    liveGate: gateStub(),
    now: () => 1_000,
    ...overrides,
  });
}

/** 用一份历史响应体当回包。 */
function replyWith(bodyText) {
  return provider({ fetchImpl: async () => new Response(bodyText, { status: 200 }) });
}

const JOB = { jobId: 'job-1', mediaId: 'media-1', mediaRevision: 2 };

/** 7 个结构类尸体（原始响应体文件名 → 人话形态）。 */
const STRUCTURE_CORPSES = [
  ['structure-trailing-dollar.txt', '尾随 `$`'],
  ['structure-trailing-prose.txt', '尾随散文 `The answer has been given.`'],
  ['structure-echoed-json-object.txt', '回显请求里的 `{"type": "json_object"}`'],
  ['structure-trailing-caret.txt', '尾随 `^`'],
  ['structure-duplicated-object.txt', '同一候选对象连吐两遍'],
  ['structure-missing-brace.txt', '缺最后一个 `}`'],
  ['structure-array-tail.txt', '多出数组闭合 `]}`'],
];

/** 5 个预算类尸体（`finish_reason=length`）。 */
const BUDGET_CORPSES = [
  'budget-empty-a.txt',
  'budget-empty-b.txt',
  'budget-empty-c.txt',
  'budget-empty-d.txt',
  'budget-truncated-string.txt',
];

test('① 结构类尸体：7/7 解出闭集内候选，不再 PROVIDER_OUTCOME_UNKNOWN', async () => {
  for (const [file, shape] of STRUCTURE_CORPSES) {
    const outcome = await replyWith(bodyOf(file)).recognize(JOB);
    assert.equal(outcome.kind, 'completed', `${file}（${shape}）应判 completed，实际 ${JSON.stringify(outcome)}`);
    assert.ok(outcome.candidates.length >= 1, `${file}（${shape}）应至少解出一个候选`);
    for (const candidate of outcome.candidates) {
      assert.ok(ALLOWED.includes(candidate.species_id), `${file} 解出闭集外 id：${candidate.species_id}`);
    }
    // 7 个尸体里的 species_id 都是 species_goosegrass（见 fixtures 的 README）。
    assert.equal(outcome.candidates[0].species_id, 'species_goosegrass', file);
    assert.equal(outcome.candidates[0].rank, 1, file);
  }
});

test('② 预算类尸体：仍返回 null（PROVIDER_OUTCOME_UNKNOWN），不抛错', async () => {
  for (const file of BUDGET_CORPSES) {
    const outcome = await replyWith(bodyOf(file)).recognize(JOB);
    assert.deepEqual(outcome, { kind: 'failed', code: 'PROVIDER_OUTCOME_UNKNOWN' }, file);
  }
});

test('②′ 解析器对空串/空白不抛错，且不产生候选文本', () => {
  for (const text of ['', '   ', '\n']) {
    assert.deepEqual(contentJsonCandidates(text), []);
    assert.equal(firstBalancedJsonObject(text), null);
    assert.equal(parseVisionJsonObject(text), null);
  }
});

test('③ 正常 JSON 不受影响：单对象 / 围栏 / 数组根', async () => {
  const plain = JSON.stringify({ species_id: 'species_goosegrass', confidence: 0.6, reason: '正常回包' });
  const plainOutcome = await replyWith(JSON.stringify({ choices: [{ message: { content: plain } }] })).recognize(JOB);
  assert.equal(plainOutcome.kind, 'completed');
  assert.deepEqual(plainOutcome.candidates, [{ species_id: 'species_goosegrass', rank: 1, model_score: 0.6 }]);

  const fenced = '```json\n' + JSON.stringify({ candidates: [{ species_id: 'species_crabgrass', confidence: 0.4 }] }) + '\n```';
  const fencedOutcome = await replyWith(JSON.stringify({ choices: [{ message: { content: fenced } }] })).recognize(JOB);
  assert.equal(fencedOutcome.kind, 'completed');
  assert.deepEqual(fencedOutcome.candidates, [{ species_id: 'species_crabgrass', rank: 1, model_score: 0.4 }]);

  // L3：根是数组时取首个元素（`[{"species_id":…}]` 是实测见过的形态）。
  const arrayRoot = JSON.stringify([{ species_id: 'species_lambsquarters', confidence: 0.9 }]);
  const arrayOutcome = await replyWith(JSON.stringify({ choices: [{ message: { content: arrayRoot } }] })).recognize(JOB);
  assert.equal(arrayOutcome.kind, 'completed');
  assert.deepEqual(arrayOutcome.candidates, [{ species_id: 'species_lambsquarters', rank: 1, model_score: 0.9 }]);
});

test('④ 恶意/垃圾内容不会产出闭集外的 species_id', async () => {
  const hostile = [
    // 闭集外的 id：必须在 normalize 被丢掉。
    { species_id: 'species_deadly_nightshade', confidence: 1 },
    // 路径穿越 / 注入式 id。
    { candidates: [{ species_id: '../../etc/passwd', confidence: 1 }, { species_id: 'species_goosegrass', confidence: 0.3 }] },
    // 把 id 藏在嵌套对象里：不该被当成候选。
    { a: { b: { species_id: 'species_goosegrass', confidence: 1 } } },
  ];
  for (const payload of hostile) {
    const content = JSON.stringify(payload) + '尾部垃圾';
    const outcome = await replyWith(JSON.stringify({ choices: [{ message: { content } }] })).recognize(JOB);
    assert.equal(outcome.kind, 'completed', JSON.stringify(payload));
    for (const candidate of outcome.candidates) {
      assert.ok(ALLOWED.includes(candidate.species_id), `闭集外 id 漏出：${candidate.species_id}`);
    }
  }

  // 分数越界仍被夹紧到 [0,1]，即使正文带尾随垃圾。
  const clamped = await replyWith(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ species_id: 'species_goosegrass', confidence: 9 }) + '$' } }],
  })).recognize(JOB);
  assert.deepEqual(clamped.candidates, [{ species_id: 'species_goosegrass', rank: 1, model_score: 1 }]);

  // 恶意内容若连候选都拿不到，最差只能是空候选（⇒ 调用方判 uncertain），绝不假成功。
  const empty = await replyWith(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ species_id: 'species_deadly_nightshade', confidence: 1 }) } }],
  })).recognize(JOB);
  assert.deepEqual(empty.candidates, []);
});

test('④′ 括号配平是字符串感知的：字符串里的 `{` `}` 与转义不参与计数', () => {
  const tricky = '{"species_id":"species_goosegrass","confidence":0.5,"reason":"含 } 与 { 和 \\" 的说明"}尾部';
  const balanced = firstBalancedJsonObject(tricky);
  assert.ok(balanced !== null);
  assert.equal(balanced.length, tricky.indexOf('}尾部') + 1);
  const parsed = parseVisionJsonObject(balanced);
  assert.equal(parsed.species_id, 'species_goosegrass');
  assert.equal(parsed.reason, '含 } 与 { 和 " 的说明');

  // 截断在字符串中间 ⇒ 补一个 `}` 也救不回来（引号未闭合），必须返回 null。
  const truncated = '{"species_id":"species_crabgrass","confidence":0.45,"reason":"多枚细长穗从同一点辐射';
  assert.ok(contentJsonCandidates(truncated).every((candidate) => parseVisionJsonObject(candidate) === null));
});

test('⑤ 请求体用 maxTokens=1024（预算类根因的调参面）', async () => {
  let sent = null;
  const p = provider({
    fetchImpl: async (_url, init) => {
      sent = JSON.parse(init.body);
      return new Response(bodyOf('structure-trailing-dollar.txt').toString('utf8'), { status: 200 });
    },
  });
  await p.recognize(JOB);
  assert.equal(sent.max_tokens, 1024);
  assert.deepEqual(sent.response_format, { type: 'json_object' });
});

test('⑥ 失败观测带 finish_reason / completion_tokens / content.length，且不含正文', async () => {
  const observations = [];
  const budget = await provider({
    onObservation: (observation) => observations.push(observation),
    fetchImpl: async () => new Response(bodyOf('budget-truncated-string.txt'), { status: 200 }),
  }).recognize(JOB);
  assert.deepEqual(budget, { kind: 'failed', code: 'PROVIDER_OUTCOME_UNKNOWN' });
  assert.equal(observations.length, 1);
  assert.equal(observations[0].state, 'RESPONSE_EVIDENCE_INCOMPLETE');
  assert.equal(observations[0].finishReason, 'length');
  assert.equal(observations[0].completionTokens, 512);
  assert.equal(observations[0].contentLength, 73);
  // 观测里只有结构读数：不得出现正文片段。
  const serialized = JSON.stringify(observations[0]);
  assert.ok(!serialized.includes('多枚细长穗'), '观测不得携带 message.content 正文');
});

test('⑥′ 结构类废尸失败时也能被归因成「结构类」（stop + 非零 content.length）', async () => {
  const observations = [];
  const outcome = await provider({
    onObservation: (observation) => observations.push(observation),
    // 一个真实里没出现过、解析器也救不回来的结构废尸：对象键没写完。
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: '{"species_id":' } }],
      usage: { completion_tokens: 12 },
    }), { status: 200 }),
  }).recognize(JOB);
  assert.deepEqual(outcome, { kind: 'failed', code: 'PROVIDER_OUTCOME_UNKNOWN' });
  assert.equal(observations[0].finishReason, 'stop');
  assert.equal(observations[0].completionTokens, 12);
  assert.equal(observations[0].contentLength, '{"species_id":'.length);
});
