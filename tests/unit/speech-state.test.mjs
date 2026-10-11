/**
 * GY-I11 普通话录音与转写域 · 判定状态与契约边界单元回归（Refs #11）。
 *
 * 覆盖 state.ts 的全部 fail-closed 校验面，并**独立**用 `packages/contracts/openapi.json`
 * 逐项比对本域常量与闭集（不是自证：断言读的是契约原文）。
 *
 * 断言一律先判 `typeof` / `Array.isArray` 再判值；不使用「只要不抛错就算过」的写法。
 * 真实 ASR 样本为 0（`docs/evaluation/sample-gap-register.md` 的 `asr_utterances` /
 * `asr_speakers` 均为 0），本文件**不产生也不声称任何准确率或转写质量结论**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONFIRMATION_VALUE,
  JOB_STATES,
  MAX_CONFIRMED_TEXT_LENGTH,
  MAX_MODEL_VERSION_LENGTH,
  MAX_RAW_TEXT_LENGTH,
  MAX_SPAN_REASON_LENGTH,
  MAX_UNCERTAIN_SPANS,
  MIN_SPAN_REASON_LENGTH,
  SpeechProtocolError,
  TERMINAL_JOB_STATES,
  canTransitionJob,
  codePointLength,
  isEmptyTranscript,
  isJobState,
  isTerminalJobState,
  normalizeConfirmedText,
  normalizeModelVersion,
  normalizeUncertainSpan,
  normalizeUncertainSpans,
  requireTranscriptText,
} from '../../services/api/src/speech/state.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const openapi = JSON.parse(readFileSync(resolve(root, 'packages/contracts/openapi.json'), 'utf8'));

// ---------------------------------------------------------------- 辅助

function assertProtocolError(operation, label) {
  assert.throws(operation, (error) => {
    assert.equal(error instanceof SpeechProtocolError, true, `${label} 应抛 SpeechProtocolError，实际 ${error?.name}`);
    assert.equal(typeof error.message, 'string', `${label} 的 message 必须是 string`);
    assert.ok(error.message.length > 0, `${label} 的 message 不得为空`);
    return true;
  });
}

function assertString(value, label) {
  assert.equal(typeof value, 'string', `${label} 必须是 string，实际是 ${typeof value}`);
}

// ---------------------------------------------------------------- 契约一致性（读契约原文比对）

test('契约一致性·Transcription 七字段与长度上限逐项一致（additionalProperties:false）', () => {
  const transcription = openapi.components.schemas.Transcription;
  assert.equal(typeof transcription, 'object', 'openapi 必须存在 Transcription schema');
  assert.equal(transcription.additionalProperties, false);
  assert.deepEqual(
    [...transcription.required].sort(),
    ['confirmed_at', 'confirmed_text', 'id', 'model_version', 'raw_text', 'revision', 'uncertain_spans'],
  );
  assert.equal(transcription.properties.raw_text.type, 'string');
  assert.equal(transcription.properties.raw_text.maxLength, MAX_RAW_TEXT_LENGTH);
  assert.equal(MAX_RAW_TEXT_LENGTH, 8000);
  assert.equal(transcription.properties.uncertain_spans.maxItems, MAX_UNCERTAIN_SPANS);
  assert.equal(MAX_UNCERTAIN_SPANS, 100);
  assert.equal(transcription.properties.confirmed_text.anyOf[0].maxLength, MAX_CONFIRMED_TEXT_LENGTH);
  assert.equal(transcription.properties.confirmed_text.anyOf[1].type, 'null');
  assert.equal(transcription.properties.confirmed_at.anyOf[1].type, 'null');
  assert.equal(transcription.properties.model_version.maxLength, MAX_MODEL_VERSION_LENGTH);
});

test('契约一致性·UncertainSpan 三字段全必填且 reason 1..80', () => {
  const span = openapi.components.schemas.UncertainSpan;
  assert.equal(span.additionalProperties, false);
  assert.deepEqual([...span.required].sort(), ['end', 'reason', 'start']);
  assert.equal(span.properties.start.minimum, 0);
  assert.equal(span.properties.end.minimum, 1);
  assert.equal(span.properties.reason.minLength, MIN_SPAN_REASON_LENGTH);
  assert.equal(span.properties.reason.maxLength, MAX_SPAN_REASON_LENGTH);
});

test('契约一致性·ConfirmTranscriptionInput 常量与必填字段一致', () => {
  const confirm = openapi.components.schemas.ConfirmTranscriptionInput;
  assert.equal(confirm.additionalProperties, false);
  assert.deepEqual([...confirm.required].sort(), ['confirmation', 'confirmed_text']);
  assert.equal(confirm.properties.confirmation.const, CONFIRMATION_VALUE);
  assert.equal(confirm.properties.confirmed_text.maxLength, MAX_CONFIRMED_TEXT_LENGTH);
});

test('契约一致性·MediaJobInput 与 JobState 闭集逐项一致', () => {
  const mediaJobInput = openapi.components.schemas.MediaJobInput;
  assert.equal(mediaJobInput.additionalProperties, false);
  assert.deepEqual([...mediaJobInput.required].sort(), ['media_id', 'media_revision']);
  assert.equal(mediaJobInput.properties.media_id.format, 'uuid');
  assert.equal(mediaJobInput.properties.media_revision.minimum, 1);
  assert.deepEqual([...openapi.components.schemas.JobState.enum].sort(), [...JOB_STATES].sort());
  assert.equal(JOB_STATES.length, 7);
});

test('契约缺口如实登记·raw_text 无 minLength、UncertainSpan 无坐标上界（实现层不自行发明约束）', () => {
  const transcription = openapi.components.schemas.Transcription;
  const span = openapi.components.schemas.UncertainSpan;
  // 契约允许空串作为 raw_text 的字段值：本层据此把「空转写」判为不可用，
  // 而不是假装契约禁止它。
  assert.equal(transcription.properties.raw_text.minLength, undefined);
  // 契约没有规定 start/end 的坐标单位，也没有要求区间落在 raw_text 之内：
  // 本层只做 start<end 与类型/长度校验，不做越界拒绝，也不裁剪（不删改）。
  assert.equal(span.properties.end.maximum, undefined);
  assert.equal(span.properties.start.maximum, undefined);
});

// ---------------------------------------------------------------- uncertain_spans

test('uncertain_spans·合法区间原样保留：数量、内容与顺序都不得改动', () => {
  const input = [
    { start: 0, end: 3, reason: '地名不确定' },
    { start: 12, end: 18, reason: '剂量数字不确定' },
    { start: 40, end: 41, reason: '同音词不确定' },
  ];
  const normalized = normalizeUncertainSpans(input);
  assert.ok(Array.isArray(normalized), 'normalizeUncertainSpans 必须返回数组');
  assert.deepEqual(normalized, input, '区间不得被删改、补造或重排');
  assert.notEqual(normalized, input, '应返回新数组，避免调用方复用输入引用');
  // 逐项字段类型与值都按原样保留（含 reason 原文）。
  for (const [index, span] of normalized.entries()) {
    assert.equal(typeof span.start, 'number');
    assert.equal(typeof span.end, 'number');
    assertString(span.reason, `spans[${index}].reason`);
    assert.equal(span.reason, input[index].reason);
  }
  // 空数组是**有意义的**合法取值（提供者未上报任何不确定区间），不得被当成缺字段。
  assert.deepEqual(normalizeUncertainSpans([]), []);
});

test('反例·uncertain_spans 的 start>=end 一律被拒（不得自动交换两端）', () => {
  assertProtocolError(() => normalizeUncertainSpans([{ start: 5, end: 5, reason: '空区间' }]), 'start=end');
  assertProtocolError(() => normalizeUncertainSpans([{ start: 9, end: 4, reason: '倒置区间' }]), 'start>end');
  assertProtocolError(() => normalizeUncertainSpan({ start: 2, end: 1, reason: '倒置' }, 0), '单区间倒置');
});

test('反例·uncertain_spans 元素缺 reason / reason 为空 / reason 超 80 一律被拒', () => {
  assertProtocolError(() => normalizeUncertainSpans([{ start: 0, end: 3 }]), '缺 reason');
  assertProtocolError(() => normalizeUncertainSpans([{ start: 0, end: 3, reason: '' }]), 'reason 空串');
  assertProtocolError(
    () => normalizeUncertainSpans([{ start: 0, end: 3, reason: 'x'.repeat(MAX_SPAN_REASON_LENGTH + 1) }]),
    'reason 超 80',
  );
  // 恰好 80 通过（边界）。
  const atLimit = normalizeUncertainSpans([{ start: 0, end: 3, reason: 'x'.repeat(MAX_SPAN_REASON_LENGTH) }]);
  assert.equal(atLimit[0].reason.length, MAX_SPAN_REASON_LENGTH);
});

test('反例·uncertain_spans 元素含未定义字段 / 缺 start / 类型不符一律被拒', () => {
  assertProtocolError(
    () => normalizeUncertainSpans([{ start: 0, end: 3, reason: 'ok', confidence: 0.5 }]),
    '多余字段',
  );
  assertProtocolError(() => normalizeUncertainSpans([{ end: 3, reason: 'ok' }]), '缺 start');
  assertProtocolError(() => normalizeUncertainSpans([{ start: '0', end: 3, reason: 'ok' }]), 'start 是字符串');
  assertProtocolError(() => normalizeUncertainSpans([{ start: 0, end: 3.5, reason: 'ok' }]), 'end 非整数');
  assertProtocolError(() => normalizeUncertainSpans([{ start: -1, end: 3, reason: 'ok' }]), 'start 为负');
  assertProtocolError(() => normalizeUncertainSpans([{ start: 0, end: 0, reason: 'ok' }]), 'end=0');
  assertProtocolError(() => normalizeUncertainSpans([null]), '元素为 null');
  assertProtocolError(() => normalizeUncertainSpans(['0-3']), '元素为字符串');
});

test('反例·uncertain_spans 不是数组被拒；超过 100 条被拒且不截断', () => {
  assertProtocolError(() => normalizeUncertainSpans(undefined), 'undefined');
  assertProtocolError(() => normalizeUncertainSpans(null), 'null');
  assertProtocolError(() => normalizeUncertainSpans({ start: 0, end: 1, reason: 'x' }), '对象');

  const atLimit = Array.from({ length: MAX_UNCERTAIN_SPANS }, (_, index) => ({
    start: index * 2,
    end: index * 2 + 1,
    reason: `区间 ${index + 1}`,
  }));
  const normalized = normalizeUncertainSpans(atLimit);
  assert.equal(normalized.length, MAX_UNCERTAIN_SPANS, '恰好 100 条必须被接受且不得被裁剪');
  assert.deepEqual(normalized, atLimit);

  const overLimit = [...atLimit, { start: 9000, end: 9001, reason: '第 101 条' }];
  assertProtocolError(() => normalizeUncertainSpans(overLimit), '第 101 条');
});

// ---------------------------------------------------------------- raw_text 长度（fail-closed，不截断）

test('反例·raw_text 超长 fail-closed：8000 码点通过、8001 被拒且绝不截断', () => {
  const exact = '药'.repeat(MAX_RAW_TEXT_LENGTH);
  const accepted = requireTranscriptText(exact, 'raw_text');
  assert.equal(codePointLength(accepted), MAX_RAW_TEXT_LENGTH);
  assert.equal(accepted.length, MAX_RAW_TEXT_LENGTH, '8000 个汉字应被原样接受');

  const tooLong = '药'.repeat(MAX_RAW_TEXT_LENGTH + 1);
  assertProtocolError(() => requireTranscriptText(tooLong, 'raw_text'), '8001 码点');
  // 关键：不得有任何「截断到 8000」的路径可被观测到 —— 该函数要么原样返回，要么抛错。
  assert.throws(() => requireTranscriptText(tooLong, 'raw_text'));
});

test('反例·raw_text 非字符串一律被拒（先判 typeof，不靠隐式转换）', () => {
  for (const value of [undefined, null, 0, 1, true, {}, [], ['文本'], Symbol('x')]) {
    assertProtocolError(() => requireTranscriptText(value, 'raw_text'), `raw_text=${String(value)}`);
  }
});

test('长度口径·按 Unicode 码点计数（代理对算 1，避免提前越界或放过真超限）', () => {
  const emoji = '😀';
  assert.equal(emoji.length, 2, 'UTF-16 码元数为 2');
  assert.equal(codePointLength(emoji), 1, '码点数必须为 1');
  // 8000 个代理对 = 16000 码元但 8000 码点：必须通过（按契约 maxLength 口径）。
  const accepted = requireTranscriptText(emoji.repeat(MAX_RAW_TEXT_LENGTH), 'raw_text');
  assert.equal(codePointLength(accepted), MAX_RAW_TEXT_LENGTH);
  assertProtocolError(() => requireTranscriptText(emoji.repeat(MAX_RAW_TEXT_LENGTH + 1), 'raw_text'), '8001 码点');
});

// ---------------------------------------------------------------- 空转写

test('反例·空转写不可用（契约允许空串，但本层判不可用：不落 succeeded、不编造文本）', () => {
  assert.equal(isEmptyTranscript(''), true);
  assert.equal(isEmptyTranscript('   '), true);
  assert.equal(isEmptyTranscript('\n\t'), true);
  assert.equal(isEmptyTranscript('\u3000\u3000'), true, '全角空格同样是空白');
  assert.equal(isEmptyTranscript('药'), false);
  assert.equal(isEmptyTranscript(' 药 '), false);
  // 空串本身能通过长度校验（契约没有 minLength），可用性由 isEmptyTranscript 单独判定。
  assert.equal(requireTranscriptText('', 'raw_text'), '');
});

// ---------------------------------------------------------------- confirmed_text / model_version

test('反例·confirmed_text 非法被拒：非字符串 / 空串 / 超 8000（不得截断）', () => {
  for (const value of [undefined, null, 0, {}, []]) {
    assertProtocolError(() => normalizeConfirmedText(value), `confirmed_text=${String(value)}`);
  }
  assertProtocolError(() => normalizeConfirmedText(''), '空串');
  assertProtocolError(() => normalizeConfirmedText('药'.repeat(MAX_CONFIRMED_TEXT_LENGTH + 1)), '超 8000');
  // 恰好 8000 通过。
  assert.equal(normalizeConfirmedText('药'.repeat(MAX_CONFIRMED_TEXT_LENGTH)).length, MAX_CONFIRMED_TEXT_LENGTH);
  // 确认文本与 raw_text 无需相等：本层不做相似度校验，也不替用户改文本。
  const text = '用户核对后的文本（与模型原始输出不同）';
  assert.equal(normalizeConfirmedText(text), text);
});

test('反例·model_version 非法被拒（1..80）', () => {
  assertProtocolError(() => normalizeModelVersion(''), '空串');
  assertProtocolError(() => normalizeModelVersion(undefined), 'undefined');
  assertProtocolError(() => normalizeModelVersion('v'.repeat(MAX_MODEL_VERSION_LENGTH + 1)), '超 80');
  assert.equal(normalizeModelVersion('stub-v1'), 'stub-v1');
});

// ---------------------------------------------------------------- JobState 闭集与迁移

test('JobState·闭集判定与终态不可离开（迟到回调不复活任务）', () => {
  for (const state of JOB_STATES) assert.equal(isJobState(state), true, `${state} 应在闭集内`);
  assert.equal(isJobState('done'), false);
  assert.equal(isJobState(''), false);
  assert.equal(isJobState(undefined), false);
  assert.equal(isJobState(1), false);
  assert.equal(TERMINAL_JOB_STATES.length, 5);

  for (const terminal of TERMINAL_JOB_STATES) {
    assert.equal(isTerminalJobState(terminal), true);
    for (const target of JOB_STATES) {
      assert.equal(canTransitionJob(terminal, target), false, `${terminal} → ${target} 必须被禁止`);
    }
  }
  assert.equal(canTransitionJob('queued', 'running'), true);
  assert.equal(canTransitionJob('queued', 'cancelled'), true);
  assert.equal(canTransitionJob('queued', 'timed_out'), true);
  assert.equal(canTransitionJob('queued', 'failed'), true);
  assert.equal(canTransitionJob('queued', 'succeeded'), false, 'queued 不得直接 succeeded');
  assert.equal(canTransitionJob('running', 'succeeded'), true);
  assert.equal(canTransitionJob('running', 'uncertain'), true);
  assert.equal(canTransitionJob('running', 'failed'), true);
  assert.equal(canTransitionJob('running', 'timed_out'), true);
  assert.equal(canTransitionJob('running', 'queued'), false);
});
