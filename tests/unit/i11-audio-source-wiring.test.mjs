/**
 * GY-I11 · **真实录音字节来源（`AudioSource`）** 接线回归（全离线：不打腾讯云、不读任何凭据、不写台账）。
 *
 * 背景（本片要关的卡点）：`services/api/src/speech/provider.ts` 原先注入
 * `createUnwiredAudioSource('真实对象存储未接线…')`，它 `read()` 恒返回 `null` ⇒ 产品路径
 * 一个字节都发不出去。本片把它换成 `createObjectStoreAudioSource()`：按
 * `jobId → 任务归属 → media_id+revision → 媒体登记册 → 对象存储端口` 取字节，并做归属校验、
 * 版本一致与字节身份（长度 + sha256）校验。
 *
 * 四条必须一直成立的事（删任一条即红）：
 *  A. **字节真的流到适配器**：经**产品装配**（`createSpeechProvider`）＋真实服务链路，
 *     对象存储端口里的那一段字节逐字节出现在 ASR 请求体的 `Data` 里（恰好一次发送）。
 *  B. **剖面校验照旧拦截**：字节来源"取得到"不等于"可以发"——MP3 / 超 60 秒 / 空字节
 *     仍由 `requireLiveAsrWav` 本地拒绝（零预留、零发包）。
 *  C. **fail-closed 逐条可指**：任务缺失 / 越权 / 版本不符 / 未就绪 / 非音频用途 /
 *     对象缺失 / 字节身份不符 / 端口未接线 ⇒ `read()` 返回 `null` 且留下**既有契约错误码**，
 *     适配器一律 `failed PROVIDER_UNAVAILABLE`、零预留、零发包。**绝不返回空字节或替身字节**。
 *  D. **零外呼**：本文件所有用例都不联网；`globalThis.fetch` 在需要时换成捕获/绊线实现，
 *     断言"该发的一次""不该发的一次都没有"。
 *
 * ⚠ 本文件的字节全部是**合成音频**（正弦/静音 PCM），不含任何真人录音；
 *    转写文本是合成占位串，**不构成任何准确率或转写质量证据**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { MEDIA_PURPOSE_KIND, MEDIA_PURPOSES } from '../../packages/media/constants.mjs';
import { sha256Hex as mediaSha256Hex } from '../../packages/media/validate.mjs';
import { mp3Bytes } from '../media/_fixtures.mjs';

import {
  SPEECH_AUDIO_FAILURE_CODES,
  SPEECH_AUDIO_PURPOSES,
  createObjectStoreAudioSource,
} from '../../services/api/src/ai/asr-audio-source.ts';
import { createLiveSpeechProviderFromConfig, requireLiveAsrWav } from '../../services/api/src/ai/asr-live-adapter.ts';
import { AsrLocalInputError } from '../../services/api/src/ai/asr-live-ports.ts';
import { PRODUCT_GATE_AUTHORIZATION } from '../../services/api/src/ai/live-gate.ts';
import { ERROR_CODES } from '../../services/api/src/contract.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createSubstituteObjectStore, createUnwiredObjectStore } from '../../services/api/src/media/object-store.ts';
import { createMemoryMediaStore } from '../../services/api/src/media/store.ts';
import { createSubstituteMediaPort } from '../../services/api/src/speech/media.ts';
import { createSpeechProvider } from '../../services/api/src/speech/provider.ts';
import { createSpeechService } from '../../services/api/src/speech/service.ts';
import { createMemorySpeechStore } from '../../services/api/src/speech/store.ts';

const REPO = new URL('../../', import.meta.url);
const readRepoText = (relative) => readFileSync(new URL(relative, REPO), 'utf8');

const JOB_ID = '11111111-2222-4333-8444-555555555555';
const MEDIA_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OTHER_MEDIA_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const OWNER = 'user-owner-i11-audiosrc';
const OTHER_OWNER = 'user-other-i11-audiosrc';
const OBJECT_KEY = 'media-objects/synthetic-i11-recording-0001';
const TRANSCRIPTION_ID = '99999999-8888-4777-8666-555555555555';
const HMAC_KEY = 'synthetic-not-a-real-hmac-key-i11-audiosrc';
const REQUEST_ID = '01234567-89ab-cdef-0123-456789abcdef';
/** 合成占位转写（不是任何真人语音的识别结果）。 */
const SYNTHETIC_TEXT = '合成转写：稻田稗草三到五叶期。';

// ---------------------------------------------------------------- 合成夹具

/** `loadConfig` 的 real 模式必填项（全部合成占位，不连任何真实资源）。 */
const REAL_ENV = {
  APP_EXECUTION_MODE: 'real',
  DATABASE_URL: 'postgres://synthetic_local_only@127.0.0.1:5432/gengyun_synthetic_never_connected',
  SESSION_SIGNING_KEY: 'synthetic-not-a-real-signing-key',
  DELETION_LEDGER_KEY: 'synthetic-not-a-real-ledger-key',
  WECHAT_APP_ID: 'synthetic-not-a-real-appid',
  WECHAT_APP_SECRET: 'synthetic-not-a-real-appsecret',
  OBJECT_STORAGE_ENDPOINT: 'https://example.invalid',
  OBJECT_STORAGE_BUCKET: 'synthetic-not-a-real-bucket',
  OBJECT_STORAGE_ACCESS_KEY: 'synthetic-not-a-real-access-key',
  OBJECT_STORAGE_SECRET_KEY: 'synthetic-not-a-real-secret-key',
};

/** 三域凭据齐备的**被校验快照**（经 `loadConfig` 得到，不是手搓对象）。 */
const CONFIGURED = loadConfig({
  ...REAL_ENV,
  LOG_LEVEL: 'silent',
  TENCENTCLOUD_SECRET_ID: 'synthetic-shared-secret-id-i11',
  TENCENTCLOUD_SECRET_KEY: 'synthetic-shared-secret-key-i11',
  TENCENTCLOUD_ASR_SECRET_ID: 'synthetic-asr-secret-id-i11',
  TENCENTCLOUD_ASR_SECRET_KEY: 'synthetic-asr-secret-key-i11',
}).aiProviders;

/** 16kHz / 单声道 / 16bit PCM 的合成 WAV（无任何真人录音；时长可控）。 */
function syntheticWav(seconds = 0.4) {
  const samples = Math.round(16000 * seconds);
  const dataLength = samples * 2;
  const buffer = Buffer.alloc(44 + dataLength);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16000, 24);
  buffer.writeUInt32LE(32000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataLength, 40);
  // 合成波形：440Hz 正弦，幅度 1/8 FS（不是任何人声）。
  for (let index = 0; index < samples; index += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * 440 * index) / 16000) * 4096);
    buffer.writeInt16LE(value, 44 + index * 2);
  }
  return new Uint8Array(buffer);
}

/** 媒体登记册行（默认与"已就绪的 voice_question 录音"一致；overrides 用来制造各种不合格）。 */
function recordingRecord(bytes, overrides = {}) {
  const at = Date.parse('2026-10-24T00:00:00.000Z');
  return {
    id: MEDIA_ID,
    ownerId: OWNER,
    revision: 1,
    purpose: 'voice_question',
    mime: 'audio/wav',
    bytes: bytes.length,
    duration_ms: null,
    sha256: mediaSha256Hex(bytes),
    state: 'ready',
    failure_code: null,
    rawRef: OBJECT_KEY,
    derivativeRef: null,
    createdAt: at,
    updatedAt: at,
    expiresAt: at + 3_600_000,
    ...overrides,
  };
}

/** 转写任务行（归属源 `SpeechStore.getJob` 的取值面；overrides 用来制造缺失/错位）。 */
function jobRow(overrides = {}) {
  const at = new Date('2026-10-24T00:00:00.000Z');
  return {
    id: JOB_ID,
    revision: 2,
    kind: 'transcription',
    ownerUserId: OWNER,
    transcriptionId: TRANSCRIPTION_ID,
    mediaId: MEDIA_ID,
    mediaRevision: 1,
    state: 'running',
    deadlineAt: new Date(at.getTime() + 30_000),
    createdAt: at,
    updatedAt: new Date(at.getTime() + 1_000),
    errorCode: null,
    ...overrides,
  };
}

/** 只记次数的预算闸：本地拒绝必须**撞不到**它（`reserves === 0` 即"未拆封"）。 */
function fakeGate() {
  const state = { reserves: 0, settles: 0 };
  return {
    state,
    gate: {
      async reserve(input) {
        state.reserves += 1;
        return {
          capability: input.capability,
          authorization: input.authorization,
          reservedCny: 0.0032,
          attemptKey: input.attemptKey,
        };
      },
      async settle() {
        state.settles += 1;
      },
    },
  };
}

/** 捕获型 fetch：记录每一次调用与请求体，返回合成成功响应（**不联网**）。 */
function captureFetch(payload) {
  const state = { calls: 0, urls: [], bodies: [], inits: [] };
  const fn = async (url, init) => {
    state.calls += 1;
    state.urls.push(String(url));
    state.bodies.push(init?.body);
    state.inits.push(init);
    return {
      ok: true,
      status: 200,
      async json() {
        return { Response: payload };
      },
    };
  };
  return { state, fn };
}

/** 绊线 fetch：任何一次调用都算失败（用来证明"零外呼"）。 */
function tripwireFetch() {
  const state = { calls: 0 };
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    state.calls += 1;
    throw new Error(`绊线被触发：本测试不得发出任何真实请求（${String(url)}）`);
  };
  return {
    state,
    restore() {
      globalThis.fetch = original;
    },
  };
}

/**
 * 组装一条**只注入端口**的装配（与产品链同一个构造器 `createObjectStoreAudioSource`）：
 * 归属源＋登记册＋对象存储三个端口全部是显式注入，且对象存储是仓内**明确标注替身**的
 * 进程内实现（`createSubstituteObjectStore`：不发网络、重启即丢）。
 */
async function assemble(spec = {}) {
  const storedBytes = spec.storedBytes ?? syntheticWav(0.2);
  const objectStore = spec.objectStore ?? createSubstituteObjectStore({ note: '测试注入：进程内对象存储（明确标注替身）' });
  if (spec.putObject !== false && objectStore.kind === 'substitute') {
    await objectStore.putObject(spec.objectKey ?? OBJECT_KEY, storedBytes, 'audio/wav');
  }
  const mediaRecords = spec.mediaRecords ?? createMemoryMediaStore();
  if (spec.record !== null) {
    await mediaRecords.createMedia(recordingRecord(storedBytes, spec.record ?? {}));
  }
  const jobs = spec.jobs ?? createMemorySpeechStore();
  if (spec.job !== null) {
    await jobs.insertJob(jobRow(spec.job ?? {}));
  }
  const source = createObjectStoreAudioSource({ jobs, mediaRecords, objectStore });
  const gateBag = fakeGate();
  const fetched = captureFetch({ RequestId: REQUEST_ID, Result: SYNTHETIC_TEXT, AudioDuration: 200 });
  const provider = createLiveSpeechProviderFromConfig(CONFIGURED.asr, {
    authorization: PRODUCT_GATE_AUTHORIZATION,
    audioSource: source,
    liveGate: gateBag.gate,
    fetchImpl: fetched.fn,
  });
  return { source, provider, gateBag, fetched, objectStore, mediaRecords, jobs, storedBytes };
}

// ---------------------------------------------------------------- A. 字节真的流到适配器

test('A·产品链：录音字节按 media_id+revision 从对象存储端口取出，并逐字节进入 ASR 请求体（恰好一次发送）', async () => {
  const wav = syntheticWav(0.4);
  const objectStore = createSubstituteObjectStore({ note: '测试注入：进程内对象存储（明确标注替身）' });
  await objectStore.putObject(OBJECT_KEY, wav, 'audio/wav');
  const mediaRecords = createMemoryMediaStore();
  await mediaRecords.createMedia(recordingRecord(wav, { ownerId: OWNER, revision: 1 }));
  const store = createMemorySpeechStore();

  // ⚠ 顺序是硬要求：真实适配器在**构造期**就把 `globalThis.fetch` 捕获成 `fetchImpl`
  // （见 `asr-live-adapter.ts` 的 `const fetchImpl = ports.fetchImpl ?? globalThis.fetch`），
  // 所以捕获型 fetch 必须**先**装好，再构造产品装配 —— 否则这一行会拿真 fetch 去打真端点。
  const fetched = captureFetch({ RequestId: REQUEST_ID, Result: SYNTHETIC_TEXT, AudioDuration: 400 });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetched.fn;
  try {
    // **产品装配**（`services/api/src/speech/provider.ts` 的唯一构造点）：只给端口，不读 env。
    const provider = createSpeechProvider({
      executionMode: 'real',
      aiProviders: CONFIGURED.asr,
      audioMedia: { jobs: store, mediaRecords, objectStore },
    });
    assert.equal(provider.available, true, '端口齐备 ⇒ 真实适配器可用');
    assert.equal(provider.executionMode, 'real');

    const service = createSpeechService({
      store,
      provider,
      media: createSubstituteMediaPort(),
      idempotencyHmacKey: HMAC_KEY,
    });

    const { job } = await service.createTranscription({
      userId: OWNER,
      body: { media_id: MEDIA_ID, media_revision: 1 },
      idempotencyKey: 'synthetic-i11-audiosrc-0001',
    });
    await service.settle();
    const settled = await service.getJob({ userId: OWNER, jobId: job.id });
    assert.equal(settled.error_code, null, '字节取到且剖面合法 ⇒ 不得有任何失败码');
    assert.equal(settled.state, 'succeeded', '字节取到且剖面合法 ⇒ 任务可以成功');

    const transcription = await service.getTranscription({ userId: OWNER, transcriptionId: settled.target_ref.id });
    assert.equal(transcription.raw_text, SYNTHETIC_TEXT, '转写文本原样来自供应商 Result');

    // ① 字节确实流到适配器：请求体里的 Data 就是对象存储端口里的那一段字节。
    assert.equal(fetched.state.calls, 1, '恰好发送一次');
    assert.equal(fetched.state.urls[0], 'https://asr.tencentcloudapi.com');
    assert.equal(fetched.state.inits[0].method, 'POST');
    assert.equal(fetched.state.inits[0].redirect, 'manual');
    const body = JSON.parse(fetched.state.bodies[0]);
    assert.equal(body.DataLen, wav.length, 'DataLen 必须是真实字节数');
    assert.equal(
      Buffer.compare(Buffer.from(body.Data, 'base64'), Buffer.from(wav)),
      0,
      '请求体字节必须与对象存储端口里的录音逐字节相同（不是空、不是占位、不是别的媒体）',
    );
    assert.equal(body.VoiceFormat, 'wav');
    assert.equal(body.EngSerViceType, '16k_zh');
    assert.equal(body.SourceType, 1);
    assert.match(body.UsrAudioKey, /^gy28-[a-f0-9]{24}$/);
    // 对象存储是替身端口：构造与取值都不发网络（真实存储未接线，本片不开）。
    assert.equal(objectStore.externalRequestCount, 0, '取字节不得触发任何外部请求');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('A·产品链·负向：media_revision 与登记册不一致 ⇒ 任务 failed PROVIDER_UNAVAILABLE，零发包、不写记录', async () => {
  const wav = syntheticWav(0.2);
  const objectStore = createSubstituteObjectStore({ note: '测试注入：进程内对象存储（明确标注替身）' });
  await objectStore.putObject(OBJECT_KEY, wav, 'audio/wav');
  const mediaRecords = createMemoryMediaStore();
  // 登记册里这一行是 revision 1；下面故意用 revision 2 申请转写。
  await mediaRecords.createMedia(recordingRecord(wav, { revision: 1 }));
  const store = createMemorySpeechStore();
  // 同上：捕获型 fetch 必须**先**装（构造期捕获），否则零外呼这条断言就只是空话。
  const fetched = captureFetch({ RequestId: REQUEST_ID, Result: SYNTHETIC_TEXT, AudioDuration: 200 });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetched.fn;
  try {
    const provider = createSpeechProvider({
      executionMode: 'real',
      aiProviders: CONFIGURED.asr,
      audioMedia: { jobs: store, mediaRecords, objectStore },
    });
    const service = createSpeechService({
      store,
      provider,
      media: createSubstituteMediaPort(),
      idempotencyHmacKey: HMAC_KEY,
    });
    const { job } = await service.createTranscription({
      userId: OWNER,
      body: { media_id: MEDIA_ID, media_revision: 2 },
      idempotencyKey: 'synthetic-i11-audiosrc-0002',
    });
    await service.settle();
    const settled = await service.getJob({ userId: OWNER, jobId: job.id });
    assert.equal(settled.state, 'failed');
    assert.equal(settled.error_code, 'PROVIDER_UNAVAILABLE');
    assert.equal(settled.result, null, '失败任务不得产出转写记录');
    assert.equal(fetched.state.calls, 0, '取不到字节 ⇒ 一次请求都不许发');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------- B. 剖面校验照旧拦截

test('B·剖面校验仍拦在适配器层：MP3 / 超 60 秒 / 空字节"取得到但不合格" ⇒ 零预留零发包，且与 requireLiveAsrWav 同判据', async () => {
  const cases = [
    // GY-R72-I11：三例都**取得到字节**、都被本地剖面校验拒绝（零预留零发包不变），
    // 但对外错误码要分流——认得出是另一种音频容器（MP3）⇒ 415 类格式码；
    // 认不出/空字节/WAV 只是超长 ⇒ 仍是「字节不可用」（PROVIDER_UNAVAILABLE）。
    ['MP3 编码（上传合法、转写不合法）', mp3Bytes({ frames: 5 }), 'MEDIA_TYPE_UNSUPPORTED'],
    ['WAV 时长 61 秒（超 60 秒上限）', syntheticWav(61), 'PROVIDER_UNAVAILABLE'],
    ['空字节', new Uint8Array(0), 'PROVIDER_UNAVAILABLE'],
  ];
  for (const [label, bytes, expectCode] of cases) {
    // 字节来源这一层**通过**（字节身份、归属、版本、用途全合法）——证明拒绝发生在剖面校验。
    const bag = await assemble({ storedBytes: bytes });
    assert.equal(bag.source.kind, 'wired', label);
    const read = await bag.source.read({ jobId: JOB_ID, mediaId: MEDIA_ID, mediaRevision: 1 });
    assert.ok(read instanceof Uint8Array, `${label}：字节来源应当取到字节（拒绝必须发生在适配器层）`);
    assert.equal(read.length, bytes.length, label);
    assert.equal(bag.source.lastFailure(), null, label);

    const outcome = await bag.provider.transcribe({ jobId: JOB_ID, mediaId: MEDIA_ID, mediaRevision: 1 });
    assert.deepEqual(outcome, { kind: 'failed', code: expectCode }, label);
    assert.equal(bag.gateBag.state.reserves, 0, `${label}：不得预留预算`);
    assert.equal(bag.gateBag.state.settles, 0, `${label}：没预留就没有结算`);
    assert.equal(bag.fetched.state.calls, 0, `${label}：不得发给供应商`);
  }
  // 判据同源：同一批字节在 `requireLiveAsrWav`（适配器实际调用的那个函数）上逐条抛 AsrLocalInputError。
  const profile = {
    endpoint: 'https://asr.tencentcloudapi.com',
    action: 'SentenceRecognition',
    apiVersion: '2019-06-14',
    region: 'ap-shanghai',
    timeoutMs: 8000,
    maxRetries: 0,
    model: '16k_zh',
    voiceFormat: 'wav',
    sampleRate: 16000,
    channels: 1,
    maxAudioSeconds: 60,
    maxAudioBase64Bytes: 3145728,
  };
  for (const [label, bytes] of cases) {
    assert.throws(() => requireLiveAsrWav(bytes, profile), (error) => error instanceof AsrLocalInputError, label);
  }
  // 正控制：0.2 秒的合成 WAV 在同一个函数上放行（说明上面不是"什么都拒"）。
  assert.equal(requireLiveAsrWav(syntheticWav(0.2), profile).durationMs, 200);
});

// ---------------------------------------------------------------- C. fail-closed 逐条可指

test('C·fail-closed 矩阵：任务缺失 / 越权 / 版本不符 / 未就绪 / 非音频用途 / 对象缺失 / 字节身份不符 / 端口未接线', async () => {
  const wav = syntheticWav(0.2);
  const otherBytes = syntheticWav(0.3);
  const cases = [
    { label: '任务不存在（jobId 查不到）', expect: 'NOT_FOUND', spec: { job: null } },
    { label: '请求的媒体 ≠ 任务授权的媒体', expect: 'NOT_FOUND', spec: { job: { mediaId: OTHER_MEDIA_ID } } },
    { label: '媒体属于别人（越权与不存在同形）', expect: 'NOT_FOUND', spec: { record: { ownerId: OTHER_OWNER } } },
    { label: '任务授权 revision ≠ 请求 revision', expect: 'REVISION_CONFLICT', spec: { job: { mediaRevision: 2 } } },
    { label: '登记册 revision 已推进', expect: 'REVISION_CONFLICT', spec: { record: { revision: 2 } } },
    { label: '媒体未就绪（uploaded）', expect: 'OBJECT_UNAVAILABLE', spec: { record: { state: 'uploaded' } } },
    { label: '用途不是音频（label_ocr 照片）', expect: 'OBJECT_UNAVAILABLE', spec: { record: { purpose: 'label_ocr' } } },
    { label: '没有对象键（rawRef=null）', expect: 'OBJECT_UNAVAILABLE', spec: { record: { rawRef: null } } },
    { label: '对象不存在（键里没有对象）', expect: 'OBJECT_UNAVAILABLE', spec: { putObject: false } },
    { label: '对象字节数 ≠ 登记册', expect: 'OBJECT_UNAVAILABLE', spec: { record: { bytes: otherBytes.length } } },
    {
      label: '对象 sha256 ≠ 登记册（取错对象）',
      expect: 'OBJECT_UNAVAILABLE',
      spec: { record: { sha256: mediaSha256Hex(otherBytes) } },
    },
    {
      label: '对象存储端口未接线',
      expect: 'PROVIDER_UNAVAILABLE',
      spec: { objectStore: createUnwiredObjectStore('测试：真实对象存储未接线') },
    },
  ];
  for (const item of cases) {
    const bag = await assemble(item.spec);
    const read = await bag.source.read({ jobId: JOB_ID, mediaId: MEDIA_ID, mediaRevision: 1 });
    assert.equal(read, null, `${item.label}：必须返回 null（绝不返回空字节/替身字节）`);
    assert.equal(bag.source.lastFailure(), item.expect, `${item.label}：内部失败码`);
    assert.equal(bag.fetched.state.calls, 0, `${item.label}：不得发包`);

    const outcome = await bag.provider.transcribe({ jobId: JOB_ID, mediaId: MEDIA_ID, mediaRevision: 1 });
    assert.deepEqual(outcome, { kind: 'failed', code: 'PROVIDER_UNAVAILABLE' }, `${item.label}：对外一律 fail-closed`);
    assert.equal(bag.gateBag.state.reserves, 0, `${item.label}：不得预留预算`);
    assert.equal(bag.gateBag.state.settles, 0, `${item.label}：没预留就没有结算`);
    assert.equal(bag.source.readAttempts, 2, `${item.label}：两次 read 都被计数（诊断读数）`);
  }
  // 正控制：同一条装配在"全部合格"时**能**取到字节，说明矩阵不是恒 null。
  const ok = await assemble({ storedBytes: wav });
  const bytes = await ok.source.read({ jobId: JOB_ID, mediaId: MEDIA_ID, mediaRevision: 1 });
  assert.equal(bytes instanceof Uint8Array, true);
  assert.equal(Buffer.compare(Buffer.from(bytes), Buffer.from(wav)), 0);
  assert.equal(ok.source.lastFailure(), null);
});

test('C·端口未配置（缺归属源 / 缺登记册 / 缺对象存储 / 全缺）⇒ unwired 形态、恒 null、码为 PROVIDER_UNAVAILABLE', async () => {
  const jobs = createMemorySpeechStore();
  const mediaRecords = createMemoryMediaStore();
  const objectStore = createSubstituteObjectStore();
  const cases = [
    ['全缺', {}],
    ['缺归属源', { mediaRecords, objectStore }],
    ['缺登记册', { jobs, objectStore }],
    ['缺对象存储', { jobs, mediaRecords }],
  ];
  for (const [label, ports] of cases) {
    const source = createObjectStoreAudioSource(ports);
    assert.equal(source.kind, 'unwired', label);
    assert.match(source.note, /未接线/, `${label}：note 必须如实说明未接线`);
    const read = await source.read({ jobId: JOB_ID, mediaId: MEDIA_ID, mediaRevision: 1 });
    assert.equal(read, null, label);
    assert.equal(source.lastFailure(), 'PROVIDER_UNAVAILABLE', label);
    assert.equal(source.readAttempts, 1, label);
  }
  // 三个端口齐备 ⇒ wired（同一构造器，端口是唯一判据）。
  const wired = createObjectStoreAudioSource({ jobs, mediaRecords, objectStore });
  assert.equal(wired.kind, 'wired');
  assert.equal(wired.note.includes('不伪造字节'), true);
});

// ---------------------------------------------------------------- D. 零外呼

test('D·零外呼：端口未配置时产品装配仍 fail-closed，globalThis.fetch 绊线一次都不触发', async () => {
  const tripwire = tripwireFetch();
  try {
    // ① 完全不给端口（与"接线前"同一结局：一个字节都发不出去，但**不再**是写死的替身，
    //    而是真实实现的"端口未配置"形态）。
    const bare = createSpeechProvider({ executionMode: 'real', aiProviders: CONFIGURED.asr });
    assert.equal(bare.available, true);
    assert.deepEqual(await bare.transcribe({ jobId: JOB_ID, mediaId: MEDIA_ID, mediaRevision: 1 }), {
      kind: 'failed',
      code: 'PROVIDER_UNAVAILABLE',
    });
    // ② 只给一部分端口（缺对象存储）⇒ 同样 fail-closed，绝不改用别的来源补字节。
    const partial = createSpeechProvider({
      executionMode: 'real',
      aiProviders: CONFIGURED.asr,
      audioMedia: { jobs: createMemorySpeechStore(), mediaRecords: createMemoryMediaStore() },
    });
    assert.deepEqual(await partial.transcribe({ jobId: JOB_ID, mediaId: MEDIA_ID, mediaRevision: 1 }), {
      kind: 'failed',
      code: 'PROVIDER_UNAVAILABLE',
    });
    assert.equal(tripwire.state.calls, 0, '端口未配置时绝不允许发出任何请求');
  } finally {
    tripwire.restore();
  }
});

// ---------------------------------------------------------------- E. 结构性自证

test('E·结构性自证：字节来源不读 ambient env / 不碰文件系统；失败码全在契约闭集；音频用途与 packages/media 一致', () => {
  const source = readRepoText('services/api/src/ai/asr-audio-source.ts');
  // 去掉注释后再断言：注释里**必须**能写出这条纪律，代码里**一次都不许出现**。
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(code.includes('process.env'), false, '不得读 ambient env');
  assert.equal(code.includes('node:fs'), false, '不得碰文件系统（无磁盘默认路径回退）');
  assert.equal(code.includes('process.cwd'), false, '不得按工作目录推断路径');
  assert.equal(/\breadFileSync\b|\breadFile\b/.test(code), false, '不得读文件');
  assert.equal(code.includes('fetch('), false, '字节来源本身不得发包（只有适配器发）');

  // 失败码闭集：全部是既有契约错误码（**不新造**）。
  assert.deepEqual([...SPEECH_AUDIO_FAILURE_CODES].sort(), [
    'NOT_FOUND',
    'OBJECT_UNAVAILABLE',
    'PROVIDER_UNAVAILABLE',
    'REVISION_CONFLICT',
  ]);
  for (const code2 of SPEECH_AUDIO_FAILURE_CODES) {
    assert.equal(ERROR_CODES.includes(code2), true, `${code2} 必须是契约既有错误码`);
  }

  // 音频用途只许"音频类"（当前唯一一条 voice_question）：与 packages/media 逐条对齐，防两处漂移。
  const audioPurposes = MEDIA_PURPOSES.filter((purpose) => MEDIA_PURPOSE_KIND[purpose] === 'audio');
  assert.deepEqual([...SPEECH_AUDIO_PURPOSES], audioPurposes);

  // 装配点不得再退回写死的"未接线"替身：`speech/provider.ts` 只能经真实构造器装字节来源。
  const providerSource = readRepoText('services/api/src/speech/provider.ts');
  assert.equal(providerSource.includes('createUnwiredAudioSource'), false, '装配点不得再注入未接线替身');
  assert.equal(providerSource.includes('createObjectStoreAudioSource(input.audioMedia)'), true);
});
