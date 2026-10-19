/**
 * GY-I13 普通话 TTS 合成域 · 服务层端到端单元回归（Refs #13）。
 *
 * 走**真实服务链路**（内存 store + 替身/脚本提供者 + 替身核对源 + 替身产物存储），覆盖
 * `POST /speech/synthesis`（`createSynthesis`）的 fail-closed 语义：
 * 只播报已核对内容、未通过核对一律拒绝、修订绑定、不接受自由文本、
 * 提供者失败不得写成功、幂等原子占位与并发收敛、失效（过期）口径、越权同形。
 *
 * 每条「应当拒绝」的情形都是**一条可单独指出的用例**（矩阵条数本身不证明 fail-closed）。
 * 断言一律先判 `typeof` / `Array.isArray` 再判值；不使用「只要不抛错就算过」的写法。
 *
 * **证据口径**：真实 TTS 样本为 **0**（`docs/evaluation/sample-gap-register.md` 的 `tts`
 * 要求 30 段、实际 0），本文件**不产生也不声称任何合成质量、音色、自然度或听感结论**；
 * 替身产物是明文标注的**非音频**占位，不可播放，也不能当作任何语音证据。
 * 本片**不注册任何 HTTP 路由**（app.ts / routes/** 属他人的阶段 2 接线）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { STUB_IDEMPOTENCY_HMAC_KEY } from '../../services/api/src/auth/service.ts';
import {
  JOB_EXPIRY_GRACE_MS,
  SYNTHESIS_ACCEPTED_STATUS,
  createSynthesisService,
} from '../../services/api/src/tts/service.ts';
import { createMemorySynthesisStore } from '../../services/api/src/tts/store.ts';
import {
  SUBSTITUTE_ARTIFACT_CONTENT_TYPE,
  createStubTtsProvider,
  createTtsProvider,
  substituteArtifactBody,
} from '../../services/api/src/tts/provider.ts';
import {
  createCheckedContentPort,
  createUnwiredCheckedContentPort,
} from '../../services/api/src/tts/content.ts';
import {
  createSynthesisMediaPort,
  createSubstituteMediaPort,
  createUnwiredMediaPort,
} from '../../services/api/src/tts/media.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const openapi = JSON.parse(readFileSync(resolve(root, 'packages/contracts/openapi.json'), 'utf8'));

const HMAC_KEY = STUB_IDEMPOTENCY_HMAC_KEY ?? 'gengyun-stub-idempotency-hmac-key';
const USER = 'user-owner-0001';
const OTHER_USER = 'user-other-0002';
const REF = { type: 'answer', id: 'answer-approved', revision: 3 };
const TEXT = '合成用例文本：稻田稗草三到五叶期，每亩用 25% 制剂 40 毫升。';

// ---------------------------------------------------------------- 辅助

function assertString(value, label) {
  assert.equal(typeof value, 'string', `${label} 必须是 string，实际是 ${typeof value}`);
  return value;
}

function assertNumber(value, label) {
  assert.equal(typeof value, 'number', `${label} 必须是 number，实际是 ${typeof value}`);
  return value;
}

function assertArray(value, label) {
  assert.ok(Array.isArray(value), `${label} 必须是数组，实际是 ${typeof value}`);
  return value;
}

function assertObject(value, label) {
  assert.equal(typeof value, 'object', `${label} 必须是 object，实际是 ${typeof value}`);
  assert.notEqual(value, null, `${label} 不得为 null`);
  assert.equal(Array.isArray(value), false, `${label} 不得是数组`);
  return value;
}

/** 断言抛出指定契约错误码的 ApiError。 */
async function assertApiError(operation, code, label) {
  await assert.rejects(operation, (error) => {
    assert.equal(error.name, 'ApiError', `${label} 应抛 ApiError，实际 ${error.name}: ${error.message}`);
    assert.equal(error.code, code, `${label} 错误码应为 ${code}，实际 ${error.code}`);
    return true;
  });
}

/** 捕获并断言错误，返回该错误对象（用于比对「越权与不存在同形」等）。 */
async function captureApiError(operation, code, label) {
  try {
    await operation();
  } catch (error) {
    assert.equal(error.name, 'ApiError', `${label} 应抛 ApiError，实际 ${error.name}: ${error.message}`);
    assert.equal(error.code, code, `${label} 错误码应为 ${code}，实际 ${error.code}`);
    return error;
  }
  assert.fail(`${label} 应当抛错，但成功返回了`);
}

let keyCounter = 0;
function nextKey() {
  keyCounter += 1;
  return `tts-test-key-${String(keyCounter).padStart(6, '0')}`;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function body(ref = REF, overrides = {}) {
  return { checked_content_ref: { ...ref }, locale: 'zh-CN', ...overrides };
}

/** 默认替身核对源条目（**合成**内容，非真实资料库、非真实审核结论）。 */
function contentEntries() {
  return [
    { type: 'answer', id: 'answer-approved', revision: 3, auditState: 'approved', text: TEXT },
    { type: 'answer', id: 'answer-approved-alt', revision: 4, auditState: 'approved', text: '合成用例文本：另一份已核对内容。' },
    { type: 'answer', id: 'answer-pending', revision: 1, auditState: 'pending', text: '未核对文本（绝不得朗读）' },
    { type: 'answer', id: 'answer-rejected', revision: 2, auditState: 'rejected', text: '已驳回文本（绝不得朗读）' },
    { type: 'answer', id: 'answer-quarantined', revision: 1, auditState: 'quarantined', text: '已隔离文本（绝不得朗读）' },
    { type: 'answer', id: 'answer-unknown-state', revision: 1, auditState: 'some_new_state', text: '状态不明文本（绝不得朗读）' },
    { type: 'answer', id: 'answer-foreign', revision: 1, auditState: 'approved', ownerUserId: OTHER_USER, text: '他人内容（绝不得朗读）' },
    { type: 'answer', id: 'answer-no-text', revision: 1, auditState: 'approved', text: '' },
  ];
}

/** 组装一个按执行模式接线的服务（可覆盖提供者 / 核对源 / 产物存储 / store / 时钟）。 */
function boot(overrides = {}) {
  const executionMode = overrides.executionMode ?? 'stub';
  const store = overrides.store ?? createMemorySynthesisStore();
  const provider = overrides.provider ?? createTtsProvider({ executionMode });
  const media = overrides.media ?? createSynthesisMediaPort(executionMode);
  const content = overrides.content ?? createCheckedContentPort(executionMode, overrides.entries ?? contentEntries());
  const service = createSynthesisService({
    store,
    provider,
    media,
    content,
    idempotencyHmacKey: HMAC_KEY,
    jobDeadlineMs: overrides.jobDeadlineMs ?? 30 * 1000,
    idempotencyWaitMs: overrides.idempotencyWaitMs ?? 300,
    now: overrides.now,
    idFactory: overrides.idFactory,
  });
  return { store, service, provider, media, content };
}

/**
 * **测试脚本提供者**：直接给出提供者结局（completed / failed），或用函数延迟决定。
 * 这是测试夹具，不是生产替身；生产装配只有 `createTtsProvider` 一条路径。
 */
function scriptedProvider(script, options = {}) {
  const state = { calls: 0, texts: [], inputs: [] };
  const provider = {
    executionMode: options.executionMode ?? 'stub',
    providerVersion: options.providerVersion ?? 'stub-scripted-v1',
    note: '测试脚本提供者（非生产替身；不产生真实音频，不构成任何合成质量证据）',
    available: options.available ?? true,
    unavailableReason: options.unavailableReason ?? null,
    async synthesize(input) {
      state.calls += 1;
      state.texts.push(input.text);
      state.inputs.push(input);
      return typeof script === 'function' ? script(input, state) : script;
    },
  };
  return { state, provider };
}

/** 合规的替身结局（服务端读出的正文进产物标注；**不是**音频）。 */
function substituteOutcome(input) {
  return {
    kind: 'completed',
    artifact: {
      contentType: SUBSTITUTE_ARTIFACT_CONTENT_TYPE,
      body: substituteArtifactBody(input.targetRef, input.text),
      substitute: true,
    },
  };
}

/** 可变的核对源 + 执行期读取闸门（用于确定性地构造「受理后内容被修订／撤销」）。 */
function gatedContentPort(initialSnapshot) {
  const state = { snapshot: initialSnapshot, reads: 0, gateSecondRead: true };
  let release = () => {};
  const gate = new Promise((resolveGate) => {
    release = resolveGate;
  });
  return {
    state,
    releaseExecutionRead: () => release(),
    port: {
      kind: 'substitute',
      note: '测试用可变核对源（合成内容，非真实资料库）',
      async read() {
        state.reads += 1;
        // 第 1 次读 = 受理前判定；第 2 次读 = 执行期重读，挂起直到测试放行。
        if (state.reads === 2 && state.gateSecondRead) await gate;
        return { ...state.snapshot };
      },
    },
  };
}

/** 包一层计数：`insertedJobs` = 真正落库的任务数（证明「同键只建 1 个任务」）。 */
function withStoreSpy(inner) {
  const state = { insertedJobs: 0 };
  const store = {
    ...inner,
    async insertJob(row) {
      state.insertedJobs += 1;
      return inner.insertJob(row);
    },
  };
  return { state, store };
}

/** 包一层计数并留存产物（用于证明「产物不是真实音频」）。 */
function withMediaSpy(inner) {
  const state = { puts: 0, artifacts: [], results: [] };
  const media = {
    ...inner,
    async put(input) {
      state.puts += 1;
      state.artifacts.push(input.artifact);
      const result = await inner.put(input);
      state.results.push(result);
      return result;
    },
  };
  return { state, media };
}

/** 受理一个合成任务并等它落定，返回 job / settled / synthesis 投影。 */
async function createAndSettle(service, userId, ref = REF, options = {}) {
  const created = await service.createSynthesis({
    userId,
    body: options.body ?? body(ref),
    idempotencyKey: options.idempotencyKey ?? nextKey(),
  });
  await service.settle();
  const settled = await service.inspectJob({ userId, jobId: created.job.id });
  return { created, job: created.job, settled, synthesis: settled.result === null ? null : settled.result.value };
}

// ---------------------------------------------------------------- 范围与契约投影

test('范围·服务层不注册任何 HTTP 路由，也不暴露契约里没有的读/删入口', () => {
  const { service } = boot();
  for (const name of ['createSynthesis', 'inspectJob', 'verifyUsable', 'settle', 'describe']) {
    assert.equal(typeof service[name], 'function', `service.${name} 必须是函数`);
  }
  for (const name of ['getSynthesis', 'deleteSynthesis', 'confirmSynthesis', 'listSyntheses', 'getJob']) {
    assert.equal(service[name], undefined, `不得暴露契约里没有的入口 ${name}`);
  }
  const post = openapi.paths['/speech/synthesis'];
  assert.deepEqual(Object.keys(post), ['post'], '契约只有 POST /speech/synthesis');
  assert.equal(SYNTHESIS_ACCEPTED_STATUS, 202);
  // 服务层源码不得引入路由/装配点。
  for (const name of ['state.ts', 'content.ts', 'provider.ts', 'media.ts', 'store.ts', 'service.ts']) {
    const text = readFileSync(resolve(root, 'services/api/src/tts', name), 'utf8');
    assert.equal(/fastify/i.test(text), false, `${name} 不得引入 fastify`);
    assert.equal(/from '\.\.\/app\.ts'/.test(text), false, `${name} 不得引入 app.ts`);
    assert.equal(/routes\//.test(text), false, `${name} 不得引入 routes/**`);
  }
});

test('正控制·approved + locale=zh-CN ⇒ 202 受理，最终 succeeded 且回绑 revision 与 media_id', async () => {
  const spy = withStoreSpy(createMemorySynthesisStore());
  const mediaSpy = withMediaSpy(createSubstituteMediaPort());
  const { service } = boot({ store: spy.store, media: mediaSpy.media });

  const created = await service.createSynthesis({ userId: USER, body: body(), idempotencyKey: nextKey() });
  // 受理语义：202 + queued + 不带结果。
  assert.equal(created.status, SYNTHESIS_ACCEPTED_STATUS, '受理状态必须是 202');
  assert.equal(created.status, 202);
  assert.equal(created.replayed, false);
  const job = assertObject(created.job, 'created.job');
  assertString(job.id, 'job.id');
  assert.equal(UUID_PATTERN.test(job.id), true, 'job.id 必须是 uuid');
  assertNumber(job.revision, 'job.revision');
  assert.equal(job.revision, 1);
  assert.equal(job.kind, 'synthesis');
  assert.equal(job.state, 'queued', '受理时必须 queued');
  assert.equal(job.result, null, '受理时不得带出结果');
  assert.equal(job.error_code, null);
  assertString(job.deadline_at, 'job.deadline_at');
  assertString(job.created_at, 'job.created_at');
  assert.deepEqual(job.target_ref, REF, 'job.target_ref 必须是已核对目标引用');
  assert.deepEqual(
    Object.keys(job).sort(),
    ['created_at', 'deadline_at', 'error_code', 'id', 'kind', 'result', 'revision', 'state', 'target_ref'],
    'Job 投影键集合必须与契约九字段一致',
  );

  await service.settle();
  const settled = await service.inspectJob({ userId: USER, jobId: job.id });
  assert.equal(settled.state, 'succeeded', '已核对内容 + zh-CN 必须最终 succeeded');
  assert.equal(settled.error_code, null);
  assertObject(settled.result, 'settled.result');
  assert.equal(settled.result.kind, 'synthesis');
  assert.deepEqual(settled.target_ref, settled.result.value.checked_content_ref, '结果必须属于同一 target_ref');

  const synthesis = assertObject(settled.result.value, 'Synthesis');
  assertString(synthesis.id, 'synthesis.id');
  assert.equal(UUID_PATTERN.test(synthesis.id), true);
  assertNumber(synthesis.revision, 'synthesis.revision');
  assert.equal(synthesis.revision, 1);
  assert.deepEqual(synthesis.checked_content_ref, REF, '必须回绑实际用于合成的 revision');
  assertString(synthesis.media_id, 'synthesis.media_id');
  assert.equal(UUID_PATTERN.test(synthesis.media_id), true, 'media_id 必须是 uuid');
  assert.deepEqual(
    Object.keys(synthesis).sort(),
    ['checked_content_ref', 'id', 'media_id', 'revision'],
    'Synthesis 投影键集合必须恰为契约四字段',
  );

  // 产物是明确标注的**非音频**替身，且不接真实对象存储。
  assert.equal(mediaSpy.state.puts, 1);
  const artifact = mediaSpy.state.artifacts[0];
  assertString(artifact.contentType, 'artifact.contentType');
  assert.equal(artifact.contentType.toLowerCase().startsWith('audio/'), false, '替身产物不得是 audio/*');
  assert.equal(artifact.substitute, true, '替身产物必须标注 substitute=true');
  const bytes = artifact.body;
  assert.equal(bytes instanceof Uint8Array, true);
  const head = Buffer.from(bytes.subarray(0, 3)).toString('latin1');
  assert.notEqual(head, 'ID3', '替身产物不得带 MP3 ID3 头（不得伪造真实音频）');
  const described = await mediaSpy.media.describeObject(synthesis.media_id);
  assertObject(described, 'described');
  assert.equal(described.substitute, true);
  assert.equal(described.contentType.toLowerCase().startsWith('audio/'), false);
  assert.equal(spy.state.insertedJobs, 1, '恰好 1 个任务');
});

test('正控制·提供者收到的正文是服务端从核对源读出的正文（不是客户端文本）', async () => {
  const scripted = scriptedProvider((input) => substituteOutcome(input));
  const { service } = boot({ provider: scripted.provider });
  const { settled } = await createAndSettle(service, USER);
  assert.equal(settled.state, 'succeeded');
  assert.equal(scripted.state.calls, 1, '提供者恰好被调用一次');
  assertString(scripted.state.texts[0], 'provider input.text');
  assert.equal(scripted.state.texts[0], TEXT, '提供者必须收到核对源正文');
  const input = assertObject(scripted.state.inputs[0], 'provider input');
  assert.deepEqual(input.targetRef, REF);
  assert.equal(input.locale, 'zh-CN');
  assertString(input.jobId, 'provider input.jobId');
});

// ---------------------------------------------------------------- 未通过核对 / 取不到核对状态（fail-closed）

test('反例·未核对/待审 pending ⇒ 受理前 422 INPUT_UNCERTAIN，不建任务、不调提供者', async () => {
  const spy = withStoreSpy(createMemorySynthesisStore());
  const scripted = scriptedProvider((input) => substituteOutcome(input));
  const { service } = boot({ store: spy.store, provider: scripted.provider });
  const error = await captureApiError(
    () =>
      service.createSynthesis({
        userId: USER,
        body: body({ type: 'answer', id: 'answer-pending', revision: 1 }),
        idempotencyKey: nextKey(),
      }),
    'INPUT_UNCERTAIN',
    'pending 内容',
  );
  assert.equal(error.details[0].code, 'AUDIT_PENDING');
  assert.equal(spy.state.insertedJobs, 0, '被拒请求不得建任务');
  assert.equal(scripted.state.calls, 0, '被拒请求不得调用提供者');
});

test('反例·已驳回 rejected ⇒ 受理前 409 OBJECT_UNAVAILABLE，不建任务、不调提供者', async () => {
  const spy = withStoreSpy(createMemorySynthesisStore());
  const scripted = scriptedProvider((input) => substituteOutcome(input));
  const { service } = boot({ store: spy.store, provider: scripted.provider });
  const error = await captureApiError(
    () =>
      service.createSynthesis({
        userId: USER,
        body: body({ type: 'answer', id: 'answer-rejected', revision: 2 }),
        idempotencyKey: nextKey(),
      }),
    'OBJECT_UNAVAILABLE',
    'rejected 内容',
  );
  assert.equal(error.details[0].code, 'AUDIT_REJECTED');
  assert.equal(spy.state.insertedJobs, 0);
  assert.equal(scripted.state.calls, 0);
});

test('反例·已隔离 quarantined ⇒ 受理前 409 OBJECT_UNAVAILABLE，不建任务、不调提供者', async () => {
  const scripted = scriptedProvider((input) => substituteOutcome(input));
  const { service } = boot({ provider: scripted.provider });
  const error = await captureApiError(
    () =>
      service.createSynthesis({
        userId: USER,
        body: body({ type: 'answer', id: 'answer-quarantined', revision: 1 }),
        idempotencyKey: nextKey(),
      }),
    'OBJECT_UNAVAILABLE',
    'quarantined 内容',
  );
  assert.equal(error.details[0].code, 'AUDIT_QUARANTINED');
  assert.equal(scripted.state.calls, 0);
});

test('反例·取不到核对状态（未知状态值）⇒ 409 OBJECT_UNAVAILABLE / AUDIT_STATE_UNREADABLE', async () => {
  const { service } = boot();
  const error = await captureApiError(
    () =>
      service.createSynthesis({
        userId: USER,
        body: body({ type: 'answer', id: 'answer-unknown-state', revision: 1 }),
        idempotencyKey: nextKey(),
      }),
    'OBJECT_UNAVAILABLE',
    '状态不明内容',
  );
  assert.equal(error.details[0].code, 'AUDIT_STATE_UNREADABLE');
});

test('反例·取不到核对状态（核对源未接线/读取抛错）⇒ 409 OBJECT_UNAVAILABLE，绝不当作 approved', async () => {
  for (const [label, content] of [
    ['未接线端口', createUnwiredCheckedContentPort()],
    [
      '读取抛错的端口',
      {
        kind: 'substitute',
        note: '测试用故障核对源',
        async read() {
          throw new Error('核对源查询失败');
        },
      },
    ],
  ]) {
    const { service } = boot({ content });
    const error = await captureApiError(
      () => service.createSynthesis({ userId: USER, body: body(), idempotencyKey: nextKey() }),
      'OBJECT_UNAVAILABLE',
      label,
    );
    assert.equal(error.details[0].code, 'AUDIT_STATE_UNREADABLE', label);
  }
});

test('反例·内容不存在 ⇒ 404 NOT_FOUND', async () => {
  const { service } = boot();
  await assertApiError(
    () => service.createSynthesis({ userId: USER, body: body({ type: 'answer', id: 'nope-1', revision: 1 }), idempotencyKey: nextKey() }),
    'NOT_FOUND',
    '不存在的内容',
  );
});

test('反例·他人内容 ⇒ NOT_FOUND，且与「不存在」完全同形（不泄露存在性）', async () => {
  const { service } = boot();
  const foreign = await captureApiError(
    () =>
      service.createSynthesis({
        userId: USER,
        body: body({ type: 'answer', id: 'answer-foreign', revision: 1 }),
        idempotencyKey: nextKey(),
      }),
    'NOT_FOUND',
    '他人内容',
  );
  const missing = await captureApiError(
    () =>
      service.createSynthesis({
        userId: USER,
        body: body({ type: 'answer', id: 'no-such-content', revision: 1 }),
        idempotencyKey: nextKey(),
      }),
    'NOT_FOUND',
    '不存在内容',
  );
  assert.equal(foreign.message, missing.message, '越权与不存在必须同形');
  assert.deepEqual(foreign.details, missing.details);
});

test('反例·approved 但取不到可朗读正文 ⇒ 409 OBJECT_UNAVAILABLE / CONTENT_UNREADABLE', async () => {
  const { service } = boot();
  const error = await captureApiError(
    () =>
      service.createSynthesis({
        userId: USER,
        body: body({ type: 'answer', id: 'answer-no-text', revision: 1 }),
        idempotencyKey: nextKey(),
      }),
    'OBJECT_UNAVAILABLE',
    '核对通过但无正文',
  );
  assert.equal(error.details[0].code, 'CONTENT_UNREADABLE');
});

test('反例·revision 与内容当前 revision 不一致 ⇒ 409 REVISION_CONFLICT（不复用旧审核）', async () => {
  const scripted = scriptedProvider((input) => substituteOutcome(input));
  const { service } = boot({ provider: scripted.provider });
  const error = await captureApiError(
    () => service.createSynthesis({ userId: USER, body: body({ ...REF, revision: 2 }), idempotencyKey: nextKey() }),
    'REVISION_CONFLICT',
    'revision 落后',
  );
  assert.equal(error.details[0].code, 'REVISION_MISMATCH');
  await assertApiError(
    () => service.createSynthesis({ userId: USER, body: body({ ...REF, revision: 4 }), idempotencyKey: nextKey() }),
    'REVISION_CONFLICT',
    'revision 超前',
  );
  assert.equal(scripted.state.calls, 0, 'revision 不一致不得调用提供者');
});

// ---------------------------------------------------------------- 入参拒绝（不接受自由文本）

test('反例·checked_content_ref.type 不在闭集（含 post / comment / conversation）⇒ 400 INVALID_REQUEST', async () => {
  const { service } = boot();
  for (const type of ['post', 'comment', 'conversation', 'transcription', 'ocr', 'recognition', 'synthesis', 'job', 'source', 'media', 'ANSWER', 1, null]) {
    await assertApiError(
      () =>
        service.createSynthesis({
          userId: USER,
          body: body({ type, id: 'x-1', revision: 1 }),
          idempotencyKey: nextKey(),
        }),
      'INVALID_REQUEST',
      `type=${String(type)}`,
    );
  }
});

test('反例·客户端自带自由文本字段（text / script / openid）⇒ 400 INVALID_REQUEST，绝不进入合成', async () => {
  const scripted = scriptedProvider((input) => substituteOutcome(input));
  const { service } = boot({ provider: scripted.provider });
  for (const extra of [{ text: '请朗读这段未经核对的文本' }, { script: 'x' }, { openid: 'o-123' }]) {
    await assertApiError(
      () => service.createSynthesis({ userId: USER, body: body(REF, extra), idempotencyKey: nextKey() }),
      'INVALID_REQUEST',
      `多余字段 ${Object.keys(extra)[0]}`,
    );
  }
  assert.equal(scripted.state.calls, 0);
});

test('反例·locale 非 zh-CN ⇒ 400 INVALID_REQUEST，不建任务', async () => {
  const spy = withStoreSpy(createMemorySynthesisStore());
  const { service } = boot({ store: spy.store });
  await assertApiError(
    () => service.createSynthesis({ userId: USER, body: body(REF, { locale: 'en-US' }), idempotencyKey: nextKey() }),
    'INVALID_REQUEST',
    'locale=en-US',
  );
  await assertApiError(
    () => service.createSynthesis({ userId: USER, body: { checked_content_ref: { ...REF } }, idempotencyKey: nextKey() }),
    'INVALID_REQUEST',
    'locale 缺失',
  );
  assert.equal(spy.state.insertedJobs, 0);
});

test('反例·id 为空 / 超 80 码点 / revision 为 0 或非整数 ⇒ 400 INVALID_REQUEST', async () => {
  const { service } = boot();
  const cases = [
    [{ ...REF, id: '' }, 'id 空'],
    [{ ...REF, id: 'a'.repeat(81) }, 'id 81 码点'],
    [{ ...REF, revision: 0 }, 'revision 0'],
    [{ ...REF, revision: 1.5 }, 'revision 1.5'],
    [{ ...REF, revision: '3' }, 'revision 字符串'],
  ];
  for (const [ref, label] of cases) {
    await assertApiError(
      () => service.createSynthesis({ userId: USER, body: body(ref), idempotencyKey: nextKey() }),
      'INVALID_REQUEST',
      label,
    );
  }
});

test('反例·缺失或非法 Idempotency-Key（undefined / 短键 / 非字符串）⇒ IDEMPOTENCY_KEY_REQUIRED', async () => {
  const { service } = boot();
  for (const key of [undefined, null, '', 'short', 123, 'x'.repeat(129)]) {
    await assertApiError(
      () => service.createSynthesis({ userId: USER, body: body(), idempotencyKey: key }),
      'IDEMPOTENCY_KEY_REQUIRED',
      `key=${String(key).slice(0, 12)}`,
    );
  }
});

// ---------------------------------------------------------------- 提供者与产物（fail-closed）

test('反例·real 缺凭据 ⇒ 受理前 503 PROVIDER_UNAVAILABLE，不建任务、不调提供者、不回退替身', async () => {
  const provider = createTtsProvider({ executionMode: 'real' });
  assert.equal(provider.available, false);
  assert.notEqual(provider.providerVersion, 'stub-tts-v1', '不得静默回退替身');
  const spy = withStoreSpy(createMemorySynthesisStore());
  const { service } = boot({ store: spy.store, provider });
  const error = await captureApiError(
    () => service.createSynthesis({ userId: USER, body: body(), idempotencyKey: nextKey() }),
    'PROVIDER_UNAVAILABLE',
    'real 缺凭据',
  );
  assertString(error.message, 'error.message');
  assert.equal(error.retryable, false, 'real 缺凭据＝能力未接线 ⇒ 需运维介入，同一请求重试不会成功');
  assert.equal(spy.state.insertedJobs, 0, '不得排队');
});

test('反例·提供者不可用（脚本 provider available=false）⇒ 受理前 503，且不读核对源也不建任务', async () => {
  const scripted = scriptedProvider({ kind: 'failed', code: 'PROVIDER_UNAVAILABLE' }, { available: false, unavailableReason: '凭据缺失（fail-closed）' });
  const spy = withStoreSpy(createMemorySynthesisStore());
  let reads = 0;
  const content = {
    kind: 'substitute',
    note: '测试核对源',
    async read() {
      reads += 1;
      return null;
    },
  };
  const { service } = boot({ store: spy.store, provider: scripted.provider, content });
  await assertApiError(
    () => service.createSynthesis({ userId: USER, body: body(), idempotencyKey: nextKey() }),
    'PROVIDER_UNAVAILABLE',
    'provider 不可用',
  );
  assert.equal(spy.state.insertedJobs, 0);
  assert.equal(reads, 0, '提供者不可用时应先 fail-closed，不读核对源');
});

test('反例·产物存储未接线 ⇒ 受理前 409 OBJECT_UNAVAILABLE（不产生必然失败的任务）', async () => {
  const scripted = scriptedProvider((input) => substituteOutcome(input));
  const spy = withStoreSpy(createMemorySynthesisStore());
  const { service } = boot({ store: spy.store, provider: scripted.provider, media: createUnwiredMediaPort() });
  await assertApiError(
    () => service.createSynthesis({ userId: USER, body: body(), idempotencyKey: nextKey() }),
    'OBJECT_UNAVAILABLE',
    '产物存储未接线',
  );
  assert.equal(spy.state.insertedJobs, 0);
  assert.equal(scripted.state.calls, 0);
});

test('反例·提供者超时 ⇒ 任务 timed_out + PROVIDER_TIMEOUT，绝不 succeeded', async () => {
  const scripted = scriptedProvider(() => new Promise(() => {}));
  const { service } = boot({ provider: scripted.provider, jobDeadlineMs: 30 });
  const { settled, synthesis } = await createAndSettle(service, USER);
  assert.equal(settled.state, 'timed_out');
  assert.equal(settled.error_code, 'PROVIDER_TIMEOUT');
  assert.equal(settled.result, null, '超时不得带出结果');
  assert.equal(synthesis, null);
  assert.equal(scripted.state.calls, 1);
});

test('反例·提供者配额 ⇒ 任务 failed + PROVIDER_QUOTA_EXCEEDED，绝不 succeeded', async () => {
  const scripted = scriptedProvider({ kind: 'failed', code: 'PROVIDER_QUOTA_EXCEEDED' });
  const { service } = boot({ provider: scripted.provider });
  const { settled } = await createAndSettle(service, USER);
  assert.equal(settled.state, 'failed');
  assert.equal(settled.error_code, 'PROVIDER_QUOTA_EXCEEDED');
  assert.equal(settled.result, null);
});

test('反例·提供者结果未知 ⇒ 任务 failed + PROVIDER_OUTCOME_UNKNOWN，绝不 succeeded', async () => {
  const scripted = scriptedProvider({ kind: 'failed', code: 'PROVIDER_OUTCOME_UNKNOWN' });
  const { service } = boot({ provider: scripted.provider });
  const { settled } = await createAndSettle(service, USER);
  assert.equal(settled.state, 'failed');
  assert.equal(settled.error_code, 'PROVIDER_OUTCOME_UNKNOWN');
  assert.equal(settled.result, null);
});

test('反例·提供者抛异常 ⇒ 任务 failed + PROVIDER_OUTCOME_UNKNOWN，绝不 succeeded', async () => {
  const scripted = scriptedProvider(() => {
    throw new Error('提供者内部异常');
  });
  const { service } = boot({ provider: scripted.provider });
  const { settled, synthesis } = await createAndSettle(service, USER);
  assert.equal(settled.state, 'failed');
  assert.equal(settled.error_code, 'PROVIDER_OUTCOME_UNKNOWN');
  assert.equal(synthesis, null, '异常不得产出合成记录');
});

test('反例·产物形状非法（空 body / 缺字段 / 多字段 / 非 Uint8Array / 替身伪装成音频）⇒ failed + PROVIDER_OUTCOME_UNKNOWN', async () => {
  const badArtifacts = [
    ['空 body', { contentType: 'application/x-a', body: new Uint8Array(0), substitute: true }],
    ['缺 substitute', { contentType: 'application/x-a', body: new Uint8Array([1]) }],
    ['多余字段', { contentType: 'application/x-a', body: new Uint8Array([1]), substitute: true, extra: 1 }],
    ['body 非 Uint8Array', { contentType: 'application/x-a', body: 'text', substitute: true }],
    ['替身伪装成 audio/mpeg', { contentType: 'audio/mpeg', body: new Uint8Array([1, 2, 3]), substitute: true }],
    ['非对象', 'audio'],
  ];
  for (const [label, artifact] of badArtifacts) {
    const scripted = scriptedProvider({ kind: 'completed', artifact });
    const mediaSpy = withMediaSpy(createSubstituteMediaPort());
    const { service } = boot({ provider: scripted.provider, media: mediaSpy.media });
    const { settled, synthesis } = await createAndSettle(service, USER);
    assert.equal(settled.state, 'failed', `${label} 必须落 failed`);
    assert.equal(settled.error_code, 'PROVIDER_OUTCOME_UNKNOWN', label);
    assert.equal(synthesis, null, `${label} 不得写记录`);
    assert.equal(mediaSpy.state.puts, 0, `${label} 非法产物不得落库`);
  }
});

test('反例·替身提供者声称产出真实音频（substitute=false）⇒ failed，不得伪造真实音频', async () => {
  const scripted = scriptedProvider({
    kind: 'completed',
    artifact: { contentType: 'audio/mpeg', body: new Uint8Array([0x49, 0x44, 0x33, 0x03]), substitute: false },
  });
  const { service } = boot({ provider: scripted.provider });
  const { settled, synthesis } = await createAndSettle(service, USER);
  assert.equal(settled.state, 'failed');
  assert.equal(settled.error_code, 'PROVIDER_OUTCOME_UNKNOWN');
  assert.equal(synthesis, null);
});

test('反例·替身产物正文带 MP3 头 ⇒ 存储层拒绝（纵深防御）⇒ failed + MEDIA_TYPE_UNSUPPORTED', async () => {
  const mp3ish = new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00]); // 'ID3'
  const scripted = scriptedProvider({
    kind: 'completed',
    artifact: { contentType: SUBSTITUTE_ARTIFACT_CONTENT_TYPE, body: mp3ish, substitute: true },
  });
  const { service } = boot({ provider: scripted.provider });
  const { settled, synthesis } = await createAndSettle(service, USER);
  assert.equal(settled.state, 'failed');
  assert.equal(settled.error_code, 'MEDIA_TYPE_UNSUPPORTED');
  assert.equal(synthesis, null);
});

test('反例·产物落库失败（对象存储不可用）⇒ failed + OBJECT_UNAVAILABLE，绝不凭空给出 media_id', async () => {
  const scripted = scriptedProvider((input) => substituteOutcome(input));
  const failingMedia = {
    kind: 'substitute',
    note: '测试用故障产物存储',
    async put() {
      return { ok: false, code: 'OBJECT_UNAVAILABLE' };
    },
    async exists() {
      return false;
    },
    async describeObject() {
      return null;
    },
  };
  const { service } = boot({ provider: scripted.provider, media: failingMedia });
  const { settled, synthesis } = await createAndSettle(service, USER);
  assert.equal(settled.state, 'failed');
  assert.equal(settled.error_code, 'OBJECT_UNAVAILABLE');
  assert.equal(settled.result, null);
  assert.equal(synthesis, null);
});

// ---------------------------------------------------------------- 修订绑定（执行期重读）

test('反例·受理后内容被修订 ⇒ 执行期 fail-closed REVISION_CONFLICT，不调提供者、不产出旧版本音频', async () => {
  const gated = gatedContentPort({
    type: 'answer',
    id: 'answer-approved',
    revision: 3,
    auditState: 'approved',
    ownerUserId: null,
    text: TEXT,
  });
  const scripted = scriptedProvider((input) => substituteOutcome(input));
  const { service } = boot({ provider: scripted.provider, content: gated.port });

  const created = await service.createSynthesis({ userId: USER, body: body(), idempotencyKey: nextKey() });
  assert.equal(created.status, 202);
  // 受理后内容被修订到 revision 4（新文本）。
  gated.state.snapshot = { ...gated.state.snapshot, revision: 4, text: '修订后的新文本（不得朗读旧版本）' };
  gated.releaseExecutionRead();
  await service.settle();

  const settled = await service.inspectJob({ userId: USER, jobId: created.job.id });
  assert.equal(settled.state, 'failed');
  assert.equal(settled.error_code, 'REVISION_CONFLICT');
  assert.equal(settled.result, null, '不得产出记录，也不得把新 revision 回填进旧任务');
  assert.equal(scripted.state.calls, 0, '内容已修订时不得调用提供者朗读旧文本');
  assert.deepEqual(settled.target_ref, REF, 'target_ref 必须保持受理时绑定的 revision');
});

test('反例·受理后核对被撤销（approved → pending）⇒ 执行期 fail-closed INPUT_UNCERTAIN，不调提供者', async () => {
  const gated = gatedContentPort({
    type: 'answer',
    id: 'answer-approved',
    revision: 3,
    auditState: 'approved',
    ownerUserId: null,
    text: TEXT,
  });
  const scripted = scriptedProvider((input) => substituteOutcome(input));
  const { service } = boot({ provider: scripted.provider, content: gated.port });

  const created = await service.createSynthesis({ userId: USER, body: body(), idempotencyKey: nextKey() });
  gated.state.snapshot = { ...gated.state.snapshot, auditState: 'pending' };
  gated.releaseExecutionRead();
  await service.settle();

  const settled = await service.inspectJob({ userId: USER, jobId: created.job.id });
  assert.equal(settled.state, 'failed');
  assert.equal(settled.error_code, 'INPUT_UNCERTAIN');
  assert.equal(settled.result, null);
  assert.equal(scripted.state.calls, 0, '核对被撤销后不得朗读');
});

test('反例·受理后核对源读取失败 ⇒ 执行期 fail-closed OBJECT_UNAVAILABLE，不调提供者', async () => {
  const state = { reads: 0, failSecond: true };
  const content = {
    kind: 'substitute',
    note: '测试用可控故障核对源',
    async read() {
      state.reads += 1;
      if (state.reads >= 2 && state.failSecond) throw new Error('核对源不可用');
      return {
        type: 'answer',
        id: 'answer-approved',
        revision: 3,
        auditState: 'approved',
        ownerUserId: null,
        text: TEXT,
      };
    },
  };
  const scripted = scriptedProvider((input) => substituteOutcome(input));
  const { service } = boot({ provider: scripted.provider, content });
  const { settled } = await createAndSettle(service, USER);
  assert.equal(settled.state, 'failed');
  assert.equal(settled.error_code, 'OBJECT_UNAVAILABLE');
  assert.equal(scripted.state.calls, 0);
});

// ---------------------------------------------------------------- 幂等与并发

test('并发·同键同体两请求 ⇒ 恰好 1 个任务、1 次提供者调用，两响应收敛同一任务', async () => {
  const spy = withStoreSpy(createMemorySynthesisStore());
  const scripted = scriptedProvider((input) => substituteOutcome(input));
  const { service } = boot({ store: spy.store, provider: scripted.provider });
  const key = nextKey();
  const results = await Promise.all([
    service.createSynthesis({ userId: USER, body: body(), idempotencyKey: key }),
    service.createSynthesis({ userId: USER, body: body(), idempotencyKey: key }),
  ]);
  for (const item of results) {
    assert.equal(item.status, 202, '两个响应都必须是 202 受理');
    assertString(item.job.id, 'job.id');
  }
  assert.equal(results[0].job.id, results[1].job.id, '并发同键必须收敛到同一个任务');
  assert.equal(spy.state.insertedJobs, 1, `同键并发只能落库 1 个任务，实际 ${spy.state.insertedJobs}`);
  assert.equal(scripted.state.calls, 1, `同键并发只能调用 1 次提供者，实际 ${scripted.state.calls}`);
  await service.settle();
  const settledA = await service.inspectJob({ userId: USER, jobId: results[0].job.id });
  const settledB = await service.inspectJob({ userId: USER, jobId: results[1].job.id });
  assert.equal(settledA.state, 'succeeded');
  assert.equal(settledB.state, 'succeeded');
  assert.equal(settledA.result.value.id, settledB.result.value.id, '两条响应指向同一合成记录');
});

test('并发·同键异体 ⇒ 一个成功、一个 IDEMPOTENCY_CONFLICT，且不产生第二个任务/第二次调用', async () => {
  const spy = withStoreSpy(createMemorySynthesisStore());
  const scripted = scriptedProvider((input) => substituteOutcome(input));
  const { service } = boot({ store: spy.store, provider: scripted.provider });
  const key = nextKey();
  const results = await Promise.allSettled([
    service.createSynthesis({ userId: USER, body: body(), idempotencyKey: key }),
    service.createSynthesis({
      userId: USER,
      body: body({ type: 'answer', id: 'answer-approved-alt', revision: 4 }),
      idempotencyKey: key,
    }),
  ]);
  const statuses = results.map((item) => item.status).sort();
  assert.deepEqual(statuses, ['fulfilled', 'rejected'], '同键异体必须恰好一个成功');
  const rejected = results.find((item) => item.status === 'rejected');
  assert.equal(rejected.reason.name, 'ApiError');
  assert.equal(rejected.reason.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(spy.state.insertedJobs, 1, '同键异体不得产生第二个任务');
  await service.settle();
  assert.equal(scripted.state.calls, 1, '同键异体不得产生第二次提供者调用');
});

test('幂等·已完成后同键同体重放 ⇒ 回放同一任务（replayed=true），不再建任务、不再调提供者', async () => {
  const spy = withStoreSpy(createMemorySynthesisStore());
  const scripted = scriptedProvider((input) => substituteOutcome(input));
  const { service } = boot({ store: spy.store, provider: scripted.provider });
  const key = nextKey();
  const first = await service.createSynthesis({ userId: USER, body: body(), idempotencyKey: key });
  await service.settle();
  const replay = await service.createSynthesis({ userId: USER, body: body(), idempotencyKey: key });
  assert.equal(replay.status, 202);
  assert.equal(replay.replayed, true, '重放必须标注 replayed');
  assert.equal(replay.job.id, first.job.id, '重放必须回到同一任务');
  assert.equal(replay.job.state, 'succeeded', '重放应带出当前任务状态');
  assert.equal(replay.job.result.kind, 'synthesis');
  assert.deepEqual(replay.job.result.value.checked_content_ref, REF);
  assert.equal(spy.state.insertedJobs, 1);
  assert.equal(scripted.state.calls, 1);
});

test('幂等·占位者落库失败必须释放占位：同键正常重试不被永久判成处理中', async () => {
  const base = createMemorySynthesisStore();
  let throwOnce = true;
  const store = {
    ...base,
    async insertJob(row) {
      if (throwOnce) {
        throwOnce = false;
        throw new Error('落库失败（模拟）');
      }
      return base.insertJob(row);
    },
  };
  const scripted = scriptedProvider((input) => substituteOutcome(input));
  const { service } = boot({ store, provider: scripted.provider });
  const key = nextKey();
  await assert.rejects(
    () => service.createSynthesis({ userId: USER, body: body(), idempotencyKey: key }),
    (error) => {
      assert.equal(error.message, '落库失败（模拟）');
      return true;
    },
    '首次落库失败必须如实抛错',
  );
  const retry = await service.createSynthesis({ userId: USER, body: body(), idempotencyKey: key });
  assert.equal(retry.status, 202, '释放占位后同键重试必须能受理');
  await service.settle();
  const settled = await service.inspectJob({ userId: USER, jobId: retry.job.id });
  assert.equal(settled.state, 'succeeded');
  assert.equal(scripted.state.calls, 1);
});

test('并发·占位者落定前等待预算用尽 ⇒ 如实 REQUEST_IN_PROGRESS，绝不重复执行副作用', async () => {
  const base = createMemorySynthesisStore();
  let releaseInsert = () => {};
  const insertGate = new Promise((resolveGate) => {
    releaseInsert = resolveGate;
  });
  let gateInsert = true;
  const store = {
    ...base,
    async insertJob(row) {
      // 占位成功后、落定前挂起：制造「同键请求仍在处理中」的窗口。
      if (gateInsert) {
        gateInsert = false;
        await insertGate;
      }
      return base.insertJob(row);
    },
  };
  const scripted = scriptedProvider((input) => substituteOutcome(input));
  const { service } = boot({ store, provider: scripted.provider, idempotencyWaitMs: 40 });
  const key = nextKey();
  const first = service.createSynthesis({ userId: USER, body: body(), idempotencyKey: key });
  await new Promise((resolveTick) => setTimeout(resolveTick, 10)); // 让首个请求先完成原子占位
  const second = service.createSynthesis({ userId: USER, body: body(), idempotencyKey: key });
  await assertApiError(() => second, 'REQUEST_IN_PROGRESS', '等待预算用尽');
  releaseInsert();
  const created = await first;
  assert.equal(created.status, 202);
  await service.settle();
  const settled = await service.inspectJob({ userId: USER, jobId: created.job.id });
  assert.equal(settled.state, 'succeeded');
  assert.equal(scripted.state.calls, 1, '落败者与等待超时都不得触发第二次提供者调用');
});

// ---------------------------------------------------------------- 失效（过期）口径

test('失效口径·approved 且 revision 一致 ⇒ usable=true；内容修订后旧音频视为过期（REVISION_CONFLICT）', async () => {
  const entry = { type: 'answer', id: 'answer-approved', revision: 3, auditState: 'approved', text: TEXT };
  const mutable = { snapshot: { ...entry, ownerUserId: null } };
  const content = {
    kind: 'substitute',
    note: '测试用可变核对源',
    async read() {
      return { ...mutable.snapshot };
    },
  };
  const scripted = scriptedProvider((input) => substituteOutcome(input));
  const { service } = boot({ provider: scripted.provider, content });
  const { settled } = await createAndSettle(service, USER);
  assert.equal(settled.state, 'succeeded');
  const synthesis = settled.result.value;

  const fresh = await service.verifyUsable({ userId: USER, synthesisId: synthesis.id });
  assert.equal(fresh.usable, true, '刚产出的合成在核对与版本未变时可用');
  assertString(fresh.media_id, 'fresh.media_id');
  assert.equal(fresh.media_id, synthesis.media_id);
  assert.equal(fresh.substitute, true, '替身产物必须如实标注，调用方不得当作真实音频');
  assert.deepEqual(fresh.checked_content_ref, REF);

  // 内容被修订到 revision 4：旧音频视为过期。
  mutable.snapshot = { ...mutable.snapshot, revision: 4, text: '修订后的新文本' };
  const stale = await service.verifyUsable({ userId: USER, synthesisId: synthesis.id });
  assert.equal(stale.usable, false);
  assert.equal(stale.code, 'REVISION_CONFLICT');
  assert.equal(stale.reason, 'REVISION_MISMATCH');

  // 核对被撤销（rejected）：同样不可用（不得复活旧音频）。
  mutable.snapshot = { ...mutable.snapshot, auditState: 'rejected' };
  const revoked = await service.verifyUsable({ userId: USER, synthesisId: synthesis.id });
  assert.equal(revoked.usable, false);
  assert.equal(revoked.code, 'OBJECT_UNAVAILABLE');
  assert.equal(revoked.reason, 'AUDIT_REJECTED');
});

test('失效口径·产物已不可用 ⇒ usable=false + OBJECT_UNAVAILABLE / MEDIA_MISSING', async () => {
  const base = createSubstituteMediaPort();
  const media = { ...base, async exists() { return false; } };
  const scripted = scriptedProvider((input) => substituteOutcome(input));
  const { service } = boot({ provider: scripted.provider, media });
  const { settled } = await createAndSettle(service, USER);
  assert.equal(settled.state, 'succeeded');
  const result = await service.verifyUsable({ userId: USER, synthesisId: settled.result.value.id });
  assert.equal(result.usable, false);
  assert.equal(result.code, 'OBJECT_UNAVAILABLE');
  assert.equal(result.reason, 'MEDIA_MISSING');
});

test('失效口径·他人合成记录与不存在的记录 ⇒ NOT_FOUND（不泄露存在性）', async () => {
  const { service } = boot();
  const { synthesis } = await createAndSettle(service, USER);
  await assertApiError(
    () => service.verifyUsable({ userId: OTHER_USER, synthesisId: synthesis.id }),
    'NOT_FOUND',
    '他人合成记录',
  );
  await assertApiError(
    () => service.verifyUsable({ userId: USER, synthesisId: '00000000-0000-4000-8000-ffffffffffff' }),
    'NOT_FOUND',
    '不存在的合成记录',
  );
  await assertApiError(
    () => service.verifyUsable({ userId: USER, synthesisId: 'not-a-uuid' }),
    'NOT_FOUND',
    '非法 id',
  );
});

// ---------------------------------------------------------------- 越权与投影

test('越权·inspectJob 对他人任务 ⇒ NOT_FOUND（与不存在同形）', async () => {
  const { service } = boot();
  const { job } = await createAndSettle(service, USER);
  await assertApiError(() => service.inspectJob({ userId: OTHER_USER, jobId: job.id }), 'NOT_FOUND', '他人任务');
  await assertApiError(
    () => service.inspectJob({ userId: USER, jobId: '00000000-0000-4000-8000-ffffffffffff' }),
    'NOT_FOUND',
    '不存在任务',
  );
});

test('存储不变量·终态任务不可被迟到结果复活（commitTerminal 返回 null 且不写第二份记录）', async () => {
  const store = createMemorySynthesisStore();
  const { service } = boot({ store });
  const { settled } = await createAndSettle(service, USER);
  assert.equal(settled.state, 'succeeded');
  const row = await store.getJob(settled.id);
  assertObject(row, 'job row');
  const resurrect = await store.commitTerminal(
    settled.id,
    row.revision,
    { state: 'failed', errorCode: 'PROVIDER_TIMEOUT' },
    null,
    new Date(),
  );
  assert.equal(resurrect, null, '已终态任务不得再迁移');
  const after = await store.getJob(settled.id);
  assert.equal(after.state, 'succeeded', '迟到结果不得改写已成功任务');
  assert.equal(after.errorCode, null);
});

// ---------------------------------------------------------------- 诊断与替身标注

test('describe()·替身如实标注（非真实音频、不产生音频、stub/preset_demo/real 各不相同）', async () => {
  const stub = boot({ executionMode: 'stub' });
  const preset = boot({ executionMode: 'preset_demo' });
  const real = boot({ executionMode: 'real' });
  for (const [label, service, expected] of [
    ['stub', stub.service, 'stub-tts-v1'],
    ['preset_demo', preset.service, 'preset-demo-tts-v1'],
  ]) {
    const described = service.describe();
    assertString(described.providerVersion, `${label}.providerVersion`);
    assert.equal(described.providerVersion, expected);
    assertString(described.providerNote, `${label}.providerNote`);
    assert.equal(described.providerNote.includes('非真实音频'), true, `${label} 的 note 必须明写「非真实音频」`);
    assert.equal(described.providerVersion.includes('stub') || described.providerVersion.includes('preset-demo'), true);
    assert.equal(described.realAudioProduced, false, '本片不得产生任何真实音频');
    assert.equal(described.storePersistent, false, '内存 store 必须如实标注为不持久');
    assert.equal(described.mediaPort, 'substitute');
    assert.equal(described.contentPort, 'substitute');
  }
  const realDescribed = real.service.describe();
  assert.equal(realDescribed.executionMode, 'real');
  assert.equal(realDescribed.providerAvailable, false);
  assertString(realDescribed.providerUnavailableReason, 'providerUnavailableReason');
  assert.equal(realDescribed.providerUnavailableReason.includes('fail-closed'), true);
  assert.equal(realDescribed.mediaPort, 'unwired', 'real 模式的产物存储必须未接线');
  assert.equal(realDescribed.contentPort, 'unwired', 'real 模式的核对源必须未接线（取不到核对状态即拒绝）');
  assert.equal(realDescribed.realAudioProduced, false);
});

test('替身提供者·确定性、非音频、不伪造时长与音色（不构成任何合成质量证据）', async () => {
  const provider = createStubTtsProvider({});
  assert.equal(provider.executionMode, 'stub');
  assert.equal(provider.available, true);
  const first = await provider.synthesize({ jobId: 'j-1', text: TEXT, locale: 'zh-CN', targetRef: REF });
  assert.equal(first.kind, 'completed');
  assertString(first.artifact.contentType, 'artifact.contentType');
  assert.equal(first.artifact.contentType, SUBSTITUTE_ARTIFACT_CONTENT_TYPE);
  assert.equal(first.artifact.contentType.toLowerCase().startsWith('audio/'), false);
  assert.equal(first.artifact.substitute, true);
  assert.equal(first.artifact.body instanceof Uint8Array, true);
  // 产物正文是明文标注：不是 MP3/ID3，也没有 MPEG 帧同步头。
  const head = Buffer.from(first.artifact.body.subarray(0, 3)).toString('latin1');
  assert.notEqual(head, 'ID3');
  assert.notEqual(first.artifact.body[0], 0xff);
  assert.equal(new TextDecoder().decode(first.artifact.body).startsWith('替身占位产物'), true, '产物正文必须自证是替身标注');
  // 同一输入必须得到同一产物（确定性、可离线复现）。
  const again = await provider.synthesize({ jobId: 'j-2', text: TEXT, locale: 'zh-CN', targetRef: REF });
  assert.deepEqual([...again.artifact.body], [...first.artifact.body]);
  // 不伪造真实供应商/音频能力。
  assert.equal(/audio\/mpeg/i.test(provider.note), false);
  assert.equal(provider.providerVersion.startsWith('real'), false);
  const preset = createStubTtsProvider({ executionMode: 'preset_demo' });
  assert.equal(preset.providerVersion, 'preset-demo-tts-v1');
  const real = createTtsProvider({ executionMode: 'real' });
  assert.equal(real.executionMode, 'real');
  assert.equal(real.available, false, 'real 缺凭据必须 fail-closed');
  assert.notEqual(real.providerVersion, 'stub-tts-v1', '不得静默回退替身');
});

// ---------------------------------------------------------------- 超时可见 / 重试幂等（AC-2）

test('超时裁定·执行器没落终态时，过截止（+宽限）的任务必须在读面显式落 timed_out，绝不永远报 queued', async () => {
  const START_MS = Date.parse('2026-10-14T06:00:00Z');
  const DEADLINE_MS = 60 * 1000;
  const clock = { ms: START_MS };
  const base = createMemorySynthesisStore();
  // 让执行器拿不到「queued → running」的那次 CAS：任务停在 queued
  // （等价于执行器缺失 / 进程在受理后重启 / store 写异常）。
  const store = {
    ...base,
    async updateJob() {
      return null;
    },
  };
  const spy = withStoreSpy(store);
  const scripted = scriptedProvider(substituteOutcome);
  const { service } = boot({
    store: spy.store,
    provider: scripted.provider,
    jobDeadlineMs: DEADLINE_MS,
    now: () => new Date(clock.ms),
  });

  const created = await service.createSynthesis({ userId: USER, body: body(), idempotencyKey: nextKey() });
  await service.settle();
  const stuck = await base.getJob(created.job.id);
  assert.equal(stuck.state, 'queued', '前置：执行器未能推进，任务停在 queued');
  assert.equal(stuck.revision, 1);

  // 宽限内：仍是 queued（不提前判死，给执行器留出提交窗口）。
  clock.ms = START_MS + DEADLINE_MS + JOB_EXPIRY_GRACE_MS - 1;
  const before = await service.inspectJob({ userId: USER, jobId: created.job.id });
  assert.equal(before.state, 'queued');
  assert.equal(before.result, null);

  // 越过宽限：读面必须显式裁定 timed_out，而不是继续报 queued。
  clock.ms += 1;
  const after = await service.inspectJob({ userId: USER, jobId: created.job.id });
  assert.equal(after.state, 'timed_out', '过截止的任务不得永远报 queued（超时必须在读面可见）');
  assert.equal(after.error_code, 'PROVIDER_TIMEOUT', '超时必须带契约闭集内的错误码');
  assert.equal(after.result, null, '超时不得携带任何产物');
  assert.equal(after.revision, before.revision + 1, '裁定必须是一次真实的 CAS 写入');
  assert.equal(Object.keys(after).sort().join(','), Object.keys(before).sort().join(','), '投影键集合不得变化');

  // 幂等读取：终态任务不会被每次读都改写。
  const again = await service.inspectJob({ userId: USER, jobId: created.job.id });
  assert.equal(again.state, 'timed_out');
  assert.equal(again.revision, after.revision, '终态任务的 revision 不得因再次读取而变化');

  // 裁定不补调提供者、不新建任务、不给产物。
  assert.equal(scripted.state.calls, 0, '超时裁定不得补调提供者');
  assert.equal(spy.state.insertedJobs, 1);
  const stored = await base.getJob(created.job.id);
  assert.equal(stored.state, 'timed_out');
  assert.equal(stored.errorCode, 'PROVIDER_TIMEOUT');
  assert.equal(await base.getSynthesis(stored.synthesisId), null, '超时不得写任何合成记录（不凭空给 media_id）');
});

test('重试·失败任务同键重放不复活、不再调提供者；换新键重试允许，旧失败任务保持原样且不留两条活跃任务', async () => {
  const spy = withStoreSpy(createMemorySynthesisStore());
  let failing = true;
  const scripted = scriptedProvider((input) =>
    failing ? { kind: 'failed', code: 'PROVIDER_QUOTA_EXCEEDED' } : substituteOutcome(input),
  );
  const provider = scripted.provider;
  const { service } = boot({ store: spy.store, provider });

  const firstKey = nextKey();
  const first = await service.createSynthesis({ userId: USER, body: body(), idempotencyKey: firstKey });
  await service.settle();
  const failed = await service.inspectJob({ userId: USER, jobId: first.job.id });
  assert.equal(failed.state, 'failed', '提供者配额失败必须落 failed（不得静默变成功）');
  assert.equal(failed.error_code, 'PROVIDER_QUOTA_EXCEEDED');
  assert.equal(failed.result, null);
  const callsAfterFailure = scripted.state.calls;
  assert.equal(callsAfterFailure, 1);

  // 同键重放：仍是同一条失败任务，不复活、不再调提供者、不新建任务（不重复计费）。
  const replay = await service.createSynthesis({ userId: USER, body: body(), idempotencyKey: firstKey });
  await service.settle();
  assert.equal(replay.replayed, true);
  assert.equal(replay.job.id, first.job.id);
  assert.equal(replay.job.state, 'failed', '重放不得把失败任务改写成 succeeded/queued');
  assert.equal(replay.job.error_code, 'PROVIDER_QUOTA_EXCEEDED');
  assert.equal(replay.job.result, null);
  assert.equal(scripted.state.calls, callsAfterFailure, '重放不得再调提供者（不重复计费语义）');
  assert.equal(spy.state.insertedJobs, 1, '重放不得新建任务');

  const stillFailed = await service.inspectJob({ userId: USER, jobId: first.job.id });
  assert.equal(stillFailed.state, 'failed');
  assert.equal(stillFailed.revision, failed.revision, '重放不得改写失败任务的 revision');

  // 换新键重试：允许（重试路径存在）⇒ 新任务；旧失败任务原样保留，任一时刻只有一条活跃任务。
  assert.equal(['failed', 'timed_out', 'cancelled', 'succeeded'].includes(stillFailed.state), true);
  failing = false;
  const second = await service.createSynthesis({ userId: USER, body: body(), idempotencyKey: nextKey() });
  await service.settle();
  assert.equal(second.replayed, false);
  assert.notEqual(second.job.id, first.job.id, '换新键重试必须是一条新任务');
  assert.equal(spy.state.insertedJobs, 2);
  assert.equal(scripted.state.calls, callsAfterFailure + 1, '每个新任务恰好一次提供者调用（不重复计费）');

  const retried = await service.inspectJob({ userId: USER, jobId: second.job.id });
  assert.equal(retried.state, 'succeeded');
  assert.equal(retried.result.kind, 'synthesis');
  const old = await service.inspectJob({ userId: USER, jobId: first.job.id });
  assert.equal(old.state, 'failed', '重试不得把旧的失败任务改写掉');
  assert.equal(old.error_code, 'PROVIDER_QUOTA_EXCEEDED');
  assert.equal(old.result, null);
});
