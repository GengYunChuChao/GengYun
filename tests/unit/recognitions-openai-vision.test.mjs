/**
 * GY-R79 · `openai-vision-v1` 剖面骨架的负控制测试（**零网络**：所有 fetch 都是假实现）。
 *
 * 覆盖的四类断言：
 * 1. 构造期拒绝（端点非 https / 模型名空 / 闭集空 / 缺字节端口）——一律抛 `RecognitionWiringError`，
 *    由 `recognitions/provider.ts` 回落 fail-closed，不构造替代实现；
 * 2. 本地拒绝**先于**预留：取不到字节或字节非法时不调用 fetch、不 reserve；
 * 3. 错误码只取 `PROVIDER_FAILURE_CODES` 的四个成员（超时 / 配额 / 结果未知 / 不可用）；
 * 4. 回包解析：闭集过滤、分数夹紧、上限截断、`none` 与不可解析内容的分叉。
 *
 * 这不是准确率证据，也不证明任何真实供应商可用：本文件只喂假响应。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OPENAI_VISION_PROTOCOL,
  buildOpenAiVisionPrompt,
  createOpenAiVisionRecognitionProvider,
  normalizeOpenAiVisionCandidates,
} from '../../services/api/src/recognitions/openai-vision-adapter.ts';
import { RecognitionWiringError } from '../../services/api/src/recognitions/live-ports.ts';

const ALLOWED = ['species_barnyardgrass', 'species_lambsquarters', 'species_goosegrass'];

/** 最小合法 PNG 头（IHDR + 非零宽高），与 `requireLiveRecognitionImage` 的判据一致。 */
function pngBytes() {
  const header = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001', 'hex');
  return new Uint8Array(header);
}

function imageSourceOf(bytes) {
  return { async read() { return bytes; } };
}

function gateStub() {
  const calls = { reserve: 0, settle: 0 };
  return {
    calls,
    async reserve() { calls.reserve += 1; return { id: 't1' }; },
    async settle() { calls.settle += 1; },
  };
}

function provider(overrides = {}) {
  const gate = overrides.liveGate ?? gateStub();
  return createOpenAiVisionRecognitionProvider({
    endpoint: 'https://vision.example.invalid/v1/chat/completions',
    apiKey: 'k-test',
    model: 'vision-model-test',
    speciesIds: ALLOWED,
    imageSource: imageSourceOf(pngBytes()),
    liveGate: gate,
    now: () => 1_000,
    ...overrides,
  });
}

const JOB = { jobId: 'job-1', mediaId: 'media-1', mediaRevision: 2 };

test('构造期拒绝：端点必须 https', () => {
  assert.throws(
    () => provider({ endpoint: 'http://vision.example.invalid/v1' }),
    (error) => error instanceof RecognitionWiringError,
  );
});

test('构造期拒绝：缺模型名 / 闭集为空 / 缺字节端口', () => {
  assert.throws(() => provider({ model: '   ' }), RecognitionWiringError);
  assert.throws(() => provider({ speciesIds: [] }), RecognitionWiringError);
  assert.throws(() => provider({ imageSource: null }), RecognitionWiringError);
});

test('本地拒绝先于预留：取不到字节 ⇒ PROVIDER_UNAVAILABLE 且零发包零预留', async () => {
  const gate = gateStub();
  let fetched = 0;
  const p = provider({
    liveGate: gate,
    imageSource: { async read() { return null; } },
    fetchImpl: async () => { fetched += 1; throw new Error('must not be called'); },
  });
  const outcome = await p.recognize(JOB);
  assert.deepEqual(outcome, { kind: 'failed', code: 'PROVIDER_UNAVAILABLE' });
  assert.equal(fetched, 0);
  assert.equal(gate.calls.reserve, 0);
});

test('图片头非法（既非 PNG 也非 JPEG）⇒ 本地拒绝', async () => {
  const p = provider({ imageSource: imageSourceOf(new Uint8Array([1, 2, 3, 4, 5])) });
  assert.deepEqual(await p.recognize(JOB), { kind: 'failed', code: 'PROVIDER_UNAVAILABLE' });
});

test('超时 ⇒ PROVIDER_TIMEOUT（settle 仍发生）', async () => {
  const gate = gateStub();
  const p = provider({
    liveGate: gate,
    fetchImpl: async () => {
      const error = new Error('timed out');
      error.name = 'TimeoutError';
      throw error;
    },
  });
  assert.deepEqual(await p.recognize(JOB), { kind: 'failed', code: 'PROVIDER_TIMEOUT' });
  assert.equal(gate.calls.settle, 1);
});

test('HTTP 状态映射：429 配额 / 500 不可用 / 401 不可用 / 422 结果未知', async () => {
  const cases = [
    [429, 'PROVIDER_QUOTA_EXCEEDED'],
    [500, 'PROVIDER_UNAVAILABLE'],
    [401, 'PROVIDER_UNAVAILABLE'],
    [422, 'PROVIDER_OUTCOME_UNKNOWN'],
  ];
  for (const [status, code] of cases) {
    const p = provider({ fetchImpl: async () => new Response('{}', { status }) });
    assert.deepEqual(await p.recognize(JOB), { kind: 'failed', code }, `status=${status}`);
  }
});

test('回包不可解析 ⇒ PROVIDER_OUTCOME_UNKNOWN 且标记可重发', async () => {
  const p = provider({
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: '不是 JSON' } }] }), { status: 200 }),
  });
  // GY-R94：200 + 内容解析不出 ⇒ 「已发出但拿不到可用结果」这一支，`retryable` 置真，
  // 由派发层决定再打一次；对 4xx/429/5xx、超时、闸门拒绝与本文件其余负例一律不置。
  assert.deepEqual(await p.recognize(JOB), { kind: 'failed', code: 'PROVIDER_OUTCOME_UNKNOWN', retryable: true });
});

test('成功回包 ⇒ completed + 闭集过滤 + 分数夹紧 + 名次从 1 开始', async () => {
  const content = JSON.stringify({
    candidates: [
      { species_id: 'species_lambsquarters', confidence: 1.4 },
      { species_id: 'not_in_catalog', confidence: 0.99 },
      { species_id: 'species_barnyardgrass', confidence: 0.7 },
      { species_id: 'species_lambsquarters', confidence: 0.2 },
    ],
  });
  const p = provider({
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 }),
  });
  const outcome = await p.recognize(JOB);
  assert.equal(outcome.kind, 'completed');
  assert.deepEqual(outcome.candidates, [
    { species_id: 'species_lambsquarters', rank: 1, model_score: 1 },
    { species_id: 'species_barnyardgrass', rank: 2, model_score: 0.7 },
  ]);
});

test('`none` 或空列表 ⇒ completed 空候选（由 decideOutcome 判 uncertain）', async () => {
  const p = provider({
    fetchImpl: async () => new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify({ species_id: 'none', confidence: 1, reason: '画面里没有植物主体' }) } }] }),
      { status: 200 },
    ),
  });
  const outcome = await p.recognize(JOB);
  assert.equal(outcome.kind, 'completed');
  assert.deepEqual(outcome.candidates, []);
  assert.deepEqual(outcome.uncertainty_reasons, ['画面里没有植物主体']);
});

test('围栏 JSON 也能解析；上限 3 条', async () => {
  const content = '```json\n' + JSON.stringify({ candidates: [
    { species_id: 'species_barnyardgrass', confidence: 0.9 },
    { species_id: 'species_lambsquarters', confidence: 0.8 },
    { species_id: 'species_goosegrass', confidence: 0.7 },
  ] }) + '\n```';
  const p = provider({
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 }),
  });
  const outcome = await p.recognize(JOB);
  assert.equal(outcome.kind, 'completed');
  assert.equal(outcome.candidates.length, 3);
});

test('normalizeOpenAiVisionCandidates：空输入与未知 id 一律丢弃', () => {
  assert.deepEqual(normalizeOpenAiVisionCandidates({}, ALLOWED), []);
  assert.deepEqual(normalizeOpenAiVisionCandidates({ candidates: [] }, ALLOWED), []);
  assert.deepEqual(
    normalizeOpenAiVisionCandidates({ candidates: [{ species_id: 'x', confidence: 1 }] }, ALLOWED),
    [],
  );
});

test('提示词写出闭集与非植物分支', () => {
  const prompt = buildOpenAiVisionPrompt(ALLOWED);
  for (const id of ALLOWED) assert.ok(prompt.includes(id), id);
  assert.ok(prompt.includes('none'));
  assert.ok(prompt.includes('JSON'));
});

test('剖面名与 model_version 一致（本基线不写供应商模型名）', () => {
  const p = provider();
  assert.equal(p.modelVersion, OPENAI_VISION_PROTOCOL);
  assert.equal(p.executionMode, 'real');
  assert.equal(p.available, true);
});
