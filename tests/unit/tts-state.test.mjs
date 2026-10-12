/**
 * GY-I13 普通话 TTS 合成域 · 状态与判定单元回归（Refs #13）。
 *
 * 本文件只覆盖**纯函数**部分：契约闭集事实、入参形状校验、
 * 「是否播报已核对内容」的核心判定（`decideCheckedContent`）、与提供者产物校验。
 * 端到端（受理/执行/幂等/并发/失效口径）在 `tts-service.test.mjs`。
 *
 * 断言一律先判 `typeof` / `Array.isArray` 再判值；不使用「只要不抛错就算过」的写法。
 * 每条「应当拒绝」的情形都是**一条可单独指出**的用例。
 *
 * 证据口径：真实 TTS 样本为 **0**（`docs/evaluation/sample-gap-register.md` 的 `tts` 要求 30 段、实际 0），
 * 本文件不产生也不声称任何合成质量、音色、自然度或听感结论。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AUDIT_STATES,
  CHECKED_CONTENT_REFUSAL_REASONS,
  FORBIDDEN_SYNTHESIS_TARGET_TYPES,
  JOB_STATES,
  JOB_TRANSITIONS,
  MAX_TARGET_ID_CODE_POINTS,
  SYNTHESIS_ALLOWED_AUDIT_STATE,
  SYNTHESIS_LOCALE,
  SYNTHESIS_TARGET_TYPES,
  SynthesisArtifactError,
  TtsProtocolError,
  canTransitionJob,
  codePointLength,
  decideCheckedContent,
  isAuditState,
  isJobState,
  isSynthesisTargetType,
  normalizeSynthesisInput,
  normalizeSynthesisTargetRef,
  requireSynthesisArtifact,
  stateForProviderFailure,
} from '../../services/api/src/tts/state.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const openapi = JSON.parse(readFileSync(resolve(root, 'packages/contracts/openapi.json'), 'utf8'));
const states = JSON.parse(readFileSync(resolve(root, 'packages/contracts/states.json'), 'utf8'));

const USER = 'user-owner-0001';
const OTHER_USER = 'user-other-0002';

// ---------------------------------------------------------------- 辅助

function assertString(value, label) {
  assert.equal(typeof value, 'string', `${label} 必须是 string，实际是 ${typeof value}`);
}

function assertArray(value, label) {
  assert.ok(Array.isArray(value), `${label} 必须是数组，实际是 ${typeof value}`);
  return value;
}

/** 断言抛 TtsProtocolError（入参形状层拒绝）。 */
function assertProtocolError(operation, label) {
  assert.throws(operation, (error) => {
    assert.equal(error.name, 'TtsProtocolError', `${label} 应抛 TtsProtocolError，实际 ${error.name}: ${error.message}`);
    return true;
  });
}

function approvedSnapshot(overrides = {}) {
  return {
    type: 'answer',
    id: 'answer-0001',
    revision: 3,
    auditState: 'approved',
    ownerUserId: null,
    text: '合成用例文本：稻田稗草三到五叶期，每亩用 25% 制剂 40 毫升。',
    ...overrides,
  };
}

function decision(overrides = {}, requested = undefined) {
  return decideCheckedContent({
    requested: requested ?? { type: 'answer', id: 'answer-0001', revision: 3 },
    callerUserId: USER,
    snapshot: approvedSnapshot(overrides),
  });
}

// ---------------------------------------------------------------- 契约事实（冻结源逐项比对）

test('契约事实·SynthesisTarget.type 闭集恰为 6 值，且与 openapi SynthesisTarget.enum 逐项一致', () => {
  const schemaEnum = openapi.components.schemas.SynthesisTarget.properties.type.enum;
  assertArray(schemaEnum, 'openapi SynthesisTarget.type.enum');
  assert.equal(schemaEnum.length, 6, `闭集必须恰为 6 值，实际 ${schemaEnum.length}`);
  assert.deepEqual([...SYNTHESIS_TARGET_TYPES].sort(), [...schemaEnum].sort());
  for (const type of SYNTHESIS_TARGET_TYPES) {
    assert.equal(isSynthesisTargetType(type), true, `${type} 应被判为合法合成目标`);
  }
});

test('契约事实·社区帖/评论/会话/转写等 TargetRef 类型**不在**合成闭集内（禁止照文本念）', () => {
  const targetRefEnum = openapi.components.schemas.TargetRef.properties.type.enum;
  assertArray(targetRefEnum, 'openapi TargetRef.type.enum');
  // 合成闭集必须是 TargetRef 的子集（否则契约自相矛盾）。
  for (const type of SYNTHESIS_TARGET_TYPES) {
    assert.equal(targetRefEnum.includes(type), true, `${type} 应存在于 TargetRef 闭集`);
  }
  for (const type of FORBIDDEN_SYNTHESIS_TARGET_TYPES) {
    assert.equal(targetRefEnum.includes(type), true, `${type} 应在 TargetRef 闭集内但不得可合成`);
    assert.equal(schemaEnumIncludes(type), false, `${type} 不得出现在合成闭集内`);
    assert.equal(isSynthesisTargetType(type), false, `${type} 不得被判为合法合成目标`);
  }
  function schemaEnumIncludes(type) {
    return openapi.components.schemas.SynthesisTarget.properties.type.enum.includes(type);
  }
});

test('契约事实·SynthesisInput / SynthesisTarget / Synthesis 的必填字段与 additionalProperties 与 openapi 一致', () => {
  const input = openapi.components.schemas.SynthesisInput;
  assert.deepEqual([...input.required].sort(), ['checked_content_ref', 'locale']);
  assert.equal(input.additionalProperties, false, 'SynthesisInput 必须 additionalProperties:false');
  assert.equal(input.properties.locale.const, SYNTHESIS_LOCALE);
  assert.equal(input.properties.locale.type, undefined, 'locale 是 const 而非自由字符串');

  const target = openapi.components.schemas.SynthesisTarget;
  assert.deepEqual([...target.required].sort(), ['id', 'revision', 'type']);
  assert.equal(target.additionalProperties, false);
  assert.equal(target.properties.id.minLength, 1);
  assert.equal(target.properties.id.maxLength, MAX_TARGET_ID_CODE_POINTS);
  assert.equal(target.properties.revision.minimum, 1);

  const synthesis = openapi.components.schemas.Synthesis;
  assert.deepEqual([...synthesis.required].sort(), ['checked_content_ref', 'id', 'media_id', 'revision']);
  assert.equal(synthesis.additionalProperties, false, 'Synthesis 只允许四字段');
});

test('契约事实·JobState 闭集与 job_transitions 与 states.json 逐项一致', () => {
  assert.deepEqual([...JOB_STATES].sort(), [...states.states.JobState].sort());
  for (const [from, targets] of Object.entries(states.job_transitions)) {
    assert.equal(isJobState(from), true, `${from} 必须是合法 JobState`);
    assert.deepEqual([...JOB_TRANSITIONS[from]].sort(), [...targets].sort(), `${from} 的迁移表必须一致`);
    for (const to of targets) assert.equal(canTransitionJob(from, to), true, `${from} → ${to} 应被允许`);
  }
  // 终态不得离开。
  for (const terminal of ['succeeded', 'uncertain', 'failed', 'timed_out', 'cancelled']) {
    for (const to of JOB_STATES) {
      assert.equal(canTransitionJob(terminal, to), false, `${terminal} 不得迁移到 ${to}`);
    }
  }
  assert.deepEqual([...AUDIT_STATES].sort(), [...states.states.AuditState].sort());
  assert.equal(SYNTHESIS_ALLOWED_AUDIT_STATE, 'approved');
});

test('范围·tts 域只做服务层：不 import fastify / app.ts / routes/**，也不 import 他人目录', () => {
  for (const name of ['state.ts', 'content.ts', 'provider.ts', 'media.ts', 'store.ts', 'service.ts']) {
    const text = readFileSync(resolve(root, 'services/api/src/tts', name), 'utf8');
    assert.equal(/fastify/i.test(text), false, `${name} 不得引入 fastify（阶段 1 不注册路由）`);
    assert.equal(/routes\//.test(text), false, `${name} 不得引入 routes/**`);
    assert.equal(/from '\.\.\/app\.ts'/.test(text), false, `${name} 不得引入 app.ts`);
    assert.equal(/from '\.\.\/(speech|recognitions|ocr)\//.test(text), false, `${name} 不得耦合他人目录`);
  }
});

// ---------------------------------------------------------------- 入参校验

test('入参·合法 SynthesisInput 原样通过（两字段、闭集、码点长度、revision 整数）', () => {
  const parsed = normalizeSynthesisInput({
    checked_content_ref: { type: 'dose_card', id: 'dose-0001', revision: 7 },
    locale: 'zh-CN',
  });
  assertString(parsed.locale, 'locale');
  assert.equal(parsed.locale, 'zh-CN');
  assert.equal(typeof parsed.checked_content_ref, 'object');
  assert.equal(parsed.checked_content_ref.type, 'dose_card');
  assert.equal(parsed.checked_content_ref.id, 'dose-0001');
  assert.equal(parsed.checked_content_ref.revision, 7);
  assert.deepEqual(Object.keys(parsed).sort(), ['checked_content_ref', 'locale']);
});

test('反例·locale 非 zh-CN（en-US / 空 / 缺失 / null）一律拒绝', () => {
  const ref = { type: 'answer', id: 'answer-0001', revision: 1 };
  for (const [label, locale] of [
    ['en-US', 'en-US'],
    ['空串', ''],
    ['zh-cn（大小写不同）', 'zh-cn'],
    ['null', null],
    ['数字', 1],
  ]) {
    assertProtocolError(
      () => normalizeSynthesisInput({ checked_content_ref: { ...ref }, locale }),
      `locale=${label}`,
    );
  }
  assertProtocolError(() => normalizeSynthesisInput({ checked_content_ref: ref }), 'locale 缺失');
});

test('反例·body 多余字段（自带 text / script / openid）一律 INVALID_REQUEST（不接受自由文本）', () => {
  const base = { checked_content_ref: { type: 'answer', id: 'answer-0001', revision: 1 }, locale: 'zh-CN' };
  for (const extra of ['text', 'script', 'openid', 'content', 'voice_type']) {
    assertProtocolError(
      () => normalizeSynthesisInput({ ...base, [extra]: '客户端自带内容' }),
      `多余字段 ${extra}`,
    );
  }
});

test('反例·checked_content_ref.type 不在 6 值闭集（逐个列出）一律拒绝', () => {
  for (const type of FORBIDDEN_SYNTHESIS_TARGET_TYPES) {
    assertProtocolError(
      () => normalizeSynthesisInput({ checked_content_ref: { type, id: 'x-1', revision: 1 }, locale: 'zh-CN' }),
      `type=${type}`,
    );
  }
  for (const type of ['', 'ANSWER', 1, null, undefined, {}]) {
    assertProtocolError(
      () => normalizeSynthesisInput({ checked_content_ref: { type, id: 'x-1', revision: 1 }, locale: 'zh-CN' }),
      `type=${String(type)}`,
    );
  }
});

test('反例·checked_content_ref.id 为空串 / 超 80 码点 / 非字符串 / 缺失一律拒绝；恰好 80 码点放行', () => {
  const withId = (id) => () => normalizeSynthesisTargetRef({ type: 'answer', id, revision: 1 });
  assertProtocolError(withId(''), '空串');
  assertProtocolError(withId('a'.repeat(MAX_TARGET_ID_CODE_POINTS + 1)), '81 码点');
  assertProtocolError(withId(123), '数字');
  assertProtocolError(withId(null), 'null');
  assertProtocolError(() => normalizeSynthesisTargetRef({ type: 'answer', revision: 1 }), 'id 缺失');
  // 边界：恰好 80 码点（含代理对时按码点而不是 UTF-16 码元计数）。
  const emoji = '🌾';
  const atLimit = emoji.repeat(40) + 'x'.repeat(40);
  assert.equal(codePointLength(atLimit), MAX_TARGET_ID_CODE_POINTS);
  const parsed = normalizeSynthesisTargetRef({ type: 'answer', id: atLimit, revision: 1 });
  assert.equal(parsed.id, atLimit);
});

test('反例·checked_content_ref.revision 为 0 / 负数 / 非整数 / 字符串 / 缺失一律拒绝', () => {
  const withRevision = (revision) => () => normalizeSynthesisTargetRef({ type: 'answer', id: 'a-1', revision });
  for (const revision of [0, -1, 1.5, '1', null, Number.NaN, Number.POSITIVE_INFINITY]) {
    assertProtocolError(withRevision(revision), `revision=${String(revision)}`);
  }
  assertProtocolError(() => normalizeSynthesisTargetRef({ type: 'answer', id: 'a-1' }), 'revision 缺失');
  assert.equal(normalizeSynthesisTargetRef({ type: 'answer', id: 'a-1', revision: 1 }).revision, 1);
});

test('反例·checked_content_ref 非对象 / 含多余字段 / 缺失字段一律拒绝', () => {
  for (const raw of [null, 'answer-0001', 42, [], undefined]) {
    assertProtocolError(() => normalizeSynthesisTargetRef(raw), `checked_content_ref=${String(raw)}`);
  }
  assertProtocolError(
    () => normalizeSynthesisTargetRef({ type: 'answer', id: 'a-1', revision: 1, text: '自带文本' }),
    'checked_content_ref 多余字段',
  );
  assertProtocolError(() => normalizeSynthesisInput('{"locale":"zh-CN"}'), 'body 非对象');
  assertProtocolError(() => normalizeSynthesisInput(null), 'body 为 null');
});

// ---------------------------------------------------------------- 核心判定表

test('判定·approved + revision 一致 ⇒ 放行，并回绑该 revision 与核对正文', () => {
  const result = decision();
  assert.equal(result.ok, true, '核对通过的内容必须放行');
  assert.equal(typeof result.revision, 'number');
  assert.equal(result.revision, 3, '必须回绑实际 revision');
  assertString(result.text, 'result.text');
  assert.equal(result.text, approvedSnapshot().text, '正文必须来自核对源，不得改写');
});

test('反例·快照为 null（内容不存在）⇒ 404 NOT_FOUND / TARGET_NOT_FOUND', () => {
  const result = decideCheckedContent({
    requested: { type: 'answer', id: 'answer-0001', revision: 3 },
    callerUserId: USER,
    snapshot: null,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NOT_FOUND');
  assert.equal(result.reason, 'TARGET_NOT_FOUND');
});

test('反例·内容归属他人 ⇒ 与不存在同形 NOT_FOUND（不泄露存在性）', () => {
  const result = decision({ ownerUserId: OTHER_USER });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NOT_FOUND');
  assert.equal(result.reason, 'TARGET_FOREIGN_OWNER');
  const missing = decideCheckedContent({
    requested: { type: 'answer', id: 'answer-0001', revision: 3 },
    callerUserId: USER,
    snapshot: null,
  });
  // 两种情形的对外信息必须完全同形。
  assert.equal(result.code, missing.code);
  assert.equal(result.message, missing.message, '越权与不存在必须同形，不泄露存在性');
});

test('反例·取不到核对状态（未知值 / 缺失 / 非字符串）⇒ 409 OBJECT_UNAVAILABLE / AUDIT_STATE_UNREADABLE', () => {
  for (const auditState of ['unknown', 'APPROVED', '', null, undefined, 1, {}, ['approved']]) {
    const result = decision({ auditState });
    assert.equal(result.ok, false, `auditState=${String(auditState)} 必须拒绝`);
    assert.equal(result.code, 'OBJECT_UNAVAILABLE', `auditState=${String(auditState)} 应 409`);
    assert.equal(result.reason, 'AUDIT_STATE_UNREADABLE');
  }
  assert.equal(isAuditState('approved'), true);
  assert.equal(isAuditState('unknown'), false);
});

test('反例·未核对/待审 pending ⇒ 422 INPUT_UNCERTAIN / AUDIT_PENDING', () => {
  const result = decision({ auditState: 'pending' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INPUT_UNCERTAIN');
  assert.equal(result.reason, 'AUDIT_PENDING');
});

test('反例·已驳回 rejected ⇒ 409 OBJECT_UNAVAILABLE / AUDIT_REJECTED', () => {
  const result = decision({ auditState: 'rejected' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'OBJECT_UNAVAILABLE');
  assert.equal(result.reason, 'AUDIT_REJECTED');
});

test('反例·已隔离 quarantined ⇒ 409 OBJECT_UNAVAILABLE / AUDIT_QUARANTINED', () => {
  const result = decision({ auditState: 'quarantined' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'OBJECT_UNAVAILABLE');
  assert.equal(result.reason, 'AUDIT_QUARANTINED');
});

test('反例·revision 与内容当前 revision 不一致 ⇒ 409 REVISION_CONFLICT / REVISION_MISMATCH', () => {
  const result = decision({ revision: 4 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'REVISION_CONFLICT');
  assert.equal(result.reason, 'REVISION_MISMATCH');
  // 低版本与高版本都不放行（不复用旧审核、也不静默回填新 revision）。
  assert.equal(decision({ revision: 2 }).reason, 'REVISION_MISMATCH');
});

test('判定顺序·未核对内容不因 revision 巧合而不一致就放行（核对状态先于版本）', () => {
  // revision 不一致 + pending：必须报「未核对」，而不是变成「版本冲突后可刷新重试」。
  const pendingMismatch = decision({ auditState: 'pending', revision: 99 });
  assert.equal(pendingMismatch.reason, 'AUDIT_PENDING');
  assert.equal(pendingMismatch.code, 'INPUT_UNCERTAIN');
  // rejected + revision 不一致：同样先报已驳回。
  assert.equal(decision({ auditState: 'rejected', revision: 99 }).reason, 'AUDIT_REJECTED');
});

test('反例·approved 但正文取不到（空 / 纯空白 / 非字符串）⇒ 409 OBJECT_UNAVAILABLE / CONTENT_UNREADABLE', () => {
  for (const text of ['', '   \n\t ', null, undefined, 42, {}]) {
    const result = decision({ text });
    assert.equal(result.ok, false, `text=${String(text)} 必须拒绝`);
    assert.equal(result.code, 'OBJECT_UNAVAILABLE');
    assert.equal(result.reason, 'CONTENT_UNREADABLE');
  }
});

test('反例·核对源返回的目标与请求不一致 ⇒ 409 OBJECT_UNAVAILABLE / TARGET_MISMATCH（不得拿别的内容顶替）', () => {
  assert.equal(decision({ id: 'answer-9999' }).reason, 'TARGET_MISMATCH');
  assert.equal(decision({ type: 'scheme' }).reason, 'TARGET_MISMATCH');
});

test('反例·快照 revision 非法（0 / 非整数）⇒ 409 OBJECT_UNAVAILABLE（状态自洽性无法验证）', () => {
  for (const revision of [0, 1.5, Number.NaN, '3']) {
    const result = decision({ revision });
    assert.equal(result.ok, false, `快照 revision=${String(revision)} 必须拒绝`);
    assert.equal(result.code, 'OBJECT_UNAVAILABLE');
  }
});

test('判定·所有拒绝分支的错误码都落在契约 ErrorCode 闭集内，且原因可枚举', () => {
  const codes = new Set();
  const reasons = new Set();
  const cases = [
    { snapshot: null },
    { snapshot: approvedSnapshot({ ownerUserId: OTHER_USER }) },
    { snapshot: approvedSnapshot({ auditState: 'unknown' }) },
    { snapshot: approvedSnapshot({ auditState: 'pending' }) },
    { snapshot: approvedSnapshot({ auditState: 'rejected' }) },
    { snapshot: approvedSnapshot({ auditState: 'quarantined' }) },
    { snapshot: approvedSnapshot({ id: 'other-1' }) },
    { snapshot: approvedSnapshot({ revision: 9 }) },
    { snapshot: approvedSnapshot({ text: '' }) },
  ];
  const contractCodes = openapi.components.schemas.ErrorCode.enum;
  for (const item of cases) {
    const result = decideCheckedContent({
      requested: { type: 'answer', id: 'answer-0001', revision: 3 },
      callerUserId: USER,
      snapshot: item.snapshot,
    });
    assert.equal(result.ok, false);
    assertString(result.code, 'result.code');
    assert.equal(contractCodes.includes(result.code), true, `${result.code} 必须在契约闭集内`);
    codes.add(result.code);
    reasons.add(result.reason);
  }
  assert.equal(codes.size >= 4, true, `拒绝分支应覆盖多个契约错误码，实际 ${[...codes].join(',')}`);
  for (const reason of reasons) {
    assert.equal(CHECKED_CONTENT_REFUSAL_REASONS.includes(reason), true, `${reason} 必须是登记过的原因`);
  }
});

// ---------------------------------------------------------------- 提供者产物校验

test('产物·合法替身产物（非音频标注 + substitute=true）通过，且字段原样保留', () => {
  const body = new TextEncoder().encode('替身占位产物（非真实音频、不可播放）');
  const artifact = requireSynthesisArtifact({
    contentType: 'application/x-gengyun-tts-substitute',
    body,
    substitute: true,
  });
  assertString(artifact.contentType, 'contentType');
  assert.equal(artifact.contentType, 'application/x-gengyun-tts-substitute');
  assert.equal(artifact.body instanceof Uint8Array, true);
  assert.equal(artifact.body.byteLength, body.byteLength);
  assert.equal(artifact.substitute, true);
});

test('反例·产物空 body / 非 Uint8Array / 缺字段 / 多字段 / contentType 非法一律拒绝', () => {
  const cases = [
    ['空 body', { contentType: 'application/x-a', body: new Uint8Array(0), substitute: true }],
    ['body 不是 Uint8Array', { contentType: 'application/x-a', body: 'text', substitute: true }],
    ['缺 substitute', { contentType: 'application/x-a', body: new Uint8Array([1]) }],
    ['缺 contentType', { body: new Uint8Array([1]), substitute: true }],
    ['多余字段', { contentType: 'application/x-a', body: new Uint8Array([1]), substitute: true, extra: 1 }],
    ['contentType 空', { contentType: '', body: new Uint8Array([1]), substitute: true }],
    ['contentType 非字符串', { contentType: 1, body: new Uint8Array([1]), substitute: true }],
    ['substitute 非布尔', { contentType: 'application/x-a', body: new Uint8Array([1]), substitute: 'true' }],
    ['非对象', 'audio'],
  ];
  for (const [label, raw] of cases) {
    assert.throws(() => requireSynthesisArtifact(raw), SynthesisArtifactError, `${label} 必须被拒绝`);
  }
});

test('反例·替身产物伪装成 audio/* ⇒ 拒绝（不得伪造真实音频）', () => {
  for (const contentType of ['audio/mpeg', 'audio/wav', 'AUDIO/MP3']) {
    assert.throws(
      () => requireSynthesisArtifact({ contentType, body: new Uint8Array([1, 2, 3]), substitute: true }),
      SynthesisArtifactError,
      `替身产物 contentType=${contentType} 必须被拒绝`,
    );
  }
  // 真实适配器（substitute=false）的 audio/* 在形状层是合法的（本片不产真实音频）。
  const real = requireSynthesisArtifact({ contentType: 'audio/mpeg', body: new Uint8Array([1]), substitute: false });
  assert.equal(real.substitute, false);
});

test('映射·提供者失败码 → 终态：超时落 timed_out，其余落 failed，绝不落 succeeded', () => {
  assert.equal(stateForProviderFailure('PROVIDER_TIMEOUT'), 'timed_out');
  for (const code of ['PROVIDER_QUOTA_EXCEEDED', 'PROVIDER_OUTCOME_UNKNOWN', 'PROVIDER_UNAVAILABLE']) {
    assert.equal(stateForProviderFailure(code), 'failed', `${code} 必须落 failed`);
  }
  for (const code of ['PROVIDER_TIMEOUT', 'PROVIDER_QUOTA_EXCEEDED', 'PROVIDER_OUTCOME_UNKNOWN']) {
    assert.notEqual(stateForProviderFailure(code), 'succeeded', `${code} 不得落 succeeded`);
  }
});

test('范围·本片不实现任何 HTTP 读/删端点：契约里只有 POST /speech/synthesis', () => {
  const path = openapi.paths['/speech/synthesis'];
  assert.deepEqual(Object.keys(path), ['post'], '契约只有 POST，本片不得自造 GET/DELETE');
  assert.equal(path.post.operationId, 'createSynthesis');
  const responses = Object.keys(path.post.responses);
  assert.equal(responses.includes('202'), true, '受理必须映射 202');
  assert.equal(path.post.parameters.some((item) => item.$ref.includes('IdempotencyKey')), true);
  assertString(path.post.description, 'createSynthesis.description');
});

test('契约闭集·源码里构造的每一个 ApiError / 判定错误码都在 openapi ErrorCode 闭集内（不得新增错误码）', () => {
  const contractCodes = openapi.components.schemas.ErrorCode.enum;
  const collected = [];
  for (const name of ['state.ts', 'service.ts', 'store.ts', 'provider.ts', 'media.ts', 'content.ts']) {
    const text = readFileSync(resolve(root, 'services/api/src/tts', name), 'utf8');
    // new ApiError('CODE', ...)
    for (const match of text.matchAll(/new ApiError\(\s*'([A-Z][A-Z_]+)'/g)) collected.push([name, match[1]]);
    // refuse(reason, 'CODE', ...)
    for (const match of text.matchAll(/refuse\(\s*'[A-Z_]+'\s*,\s*'([A-Z][A-Z_]+)'/g)) collected.push([name, match[1]]);
    // { ok: false, code: 'CODE', ... }
    for (const match of text.matchAll(/ok:\s*false\s*,\s*code:\s*'([A-Z][A-Z_]+)'/g)) collected.push([name, match[1]]);
    // stateForProviderFailure('CODE')
    for (const match of text.matchAll(/stateForProviderFailure\(\s*'([A-Z][A-Z_]+)'/g)) collected.push([name, match[1]]);
    // errorCode: 'CODE'
    for (const match of text.matchAll(/errorCode:\s*'([A-Z][A-Z_]+)'/g)) collected.push([name, match[1]]);
  }
  assert.equal(collected.length >= 20, true, `应至少收集到 20 处错误码，实际 ${collected.length}`);
  for (const [file, code] of collected) {
    assert.equal(contractCodes.includes(code), true, `${file} 里的 ${code} 不在契约 ErrorCode 闭集内（不得新增错误码）`);
  }
  const distinct = new Set(collected.map(([, code]) => code));
  for (const code of ['IDEMPOTENCY_CONFLICT', 'PROVIDER_UNAVAILABLE', 'OBJECT_UNAVAILABLE', 'INPUT_UNCERTAIN', 'NOT_FOUND', 'REVISION_CONFLICT']) {
    assert.equal(distinct.has(code), true, `本域应当使用契约错误码 ${code}`);
  }
});
