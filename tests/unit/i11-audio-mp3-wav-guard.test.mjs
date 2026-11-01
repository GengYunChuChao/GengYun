/**
 * GY-R31-I11 · 「音频解码 MP3→WAV 未实现」缺口的**结构性守卫**（全离线、零发包、零数据库）。
 *
 * 裁定见 `docs/verification/gy-r31-i11-audio-20261022.md`：本版**不做** MP3→PCM 解码
 * （仓内与运行环境都没有解码器，引依赖须先裁定），缺口登记为 planned。
 *
 * 本文件冻结的不是「现状不可改」，而是三件**必须一直成立**的事：
 *  A. **媒体层确实接收 MP3**（真实类型 `audio/mpeg`、真实时长可解析、伪扩展名防线放行）——
 *     所以这个缺口不能用「把 mp3 从白名单里删掉」蒙过去，删了本文件会红。
 *  B. **ASR 层对 MP3 必须本地 fail-closed**：报 WAV 要求、不裁剪、不转码、零预留、零发包，
 *     绝不把 MP3 字节当 WAV 发给供应商，也绝不伪造转写文本。
 *  C. **契约与冻结档位不撒谎**：openapi 的 `UploadInput.mime` 至今含 `audio/mpeg`，
 *     而 ASR 档位钉死 `voiceFormat: 'wav'` / 16000Hz / 单声道 / ≤60s。
 *
 * ## GY-R72-I11：两条 `todo` 已变成真断言（不再是缺口登记）
 *
 * 修法有两条，都**不新增错误码**（`MEDIA_TYPE_UNSUPPORTED` 早就在契约里，映射 415）：
 *  D. **受理期就拦**：`SpeechMediaPort.resolve()` 多回一个 `mime`（real 分支的唯一来源是
 *     媒体登记册），`createTranscription` 在**幂等占位之前**判非 WAV 家族 ⇒ 415。因此
 *     MP3 今天拿到的是点名 WAV 的 4xx，而不再是「202 受理 → 后台 failed」。
 *  E. **失败码分流**：转写期仍先做本地剖面校验（零预留、零发包、不转码），但**拿到字节却
 *     认得出是另一种音频容器**（MP3/AAC）时报 `MEDIA_TYPE_UNSUPPORTED`，不再冒充
 *     `PROVIDER_UNAVAILABLE`；**字节来源没接线/读不到/认不出**仍报 `PROVIDER_UNAVAILABLE`
 *     （那条口径由 `i11-audio-source-wiring`、`ai-live-provider-wiring` 单独钉住，本文件不重复）。
 *
 * `mime` **未知时放行**（fail-open）是刻意的：替身端口恒 `null`、历史行可能缺字段，
 * 把它们判成「格式不支持」等于凭空拒绝一批合法请求——见下面的 fail-open 正控。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { detectMediaType } from '../../packages/media/detect.mjs';
import { computeAudioDurationMs } from '../../packages/media/audio.mjs';
import { assertBytesMatchDeclaration } from '../../packages/media/validate.mjs';
import { mp3Bytes } from '../media/_fixtures.mjs';
import {
  LIVE_ASR_FROZEN_PROFILE,
  createLiveSpeechProvider,
  requireLiveAsrWav,
} from '../../services/api/src/ai/asr-live-adapter.ts';
import { AsrLocalInputError } from '../../services/api/src/ai/asr-live-ports.ts';
import { createMemoryMediaStore } from '../../services/api/src/media/store.ts';
import { createRealMediaPort, createSubstituteMediaPort } from '../../services/api/src/speech/media.ts';
import { createSpeechProvider } from '../../services/api/src/speech/provider.ts';
import { createSpeechService } from '../../services/api/src/speech/service.ts';
import { createMemorySpeechStore } from '../../services/api/src/speech/store.ts';

const REPO = new URL('../../', import.meta.url);
const readJson = (relative) => JSON.parse(readFileSync(new URL(relative, REPO), 'utf8'));
const readText = (relative) => readFileSync(new URL(relative, REPO), 'utf8');

const JOB_ID = '11111111-2222-4333-8444-555555555555';
const MEDIA_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

/** 5 个 MPEG1 Layer3 帧（44100Hz / 128kbps）⇒ 5×1152/44100 ≈ 130.6ms。 */
const MP3 = mp3Bytes({ frames: 5 });

const sha256Hex = (bytes) => createHash('sha256').update(Buffer.from(bytes)).digest('hex');

const OWNER = 'user-owner-i11-mp3-guard';
const HMAC_KEY = 'synthetic-not-a-real-hmac-key-i11-mp3-guard';

function fixedSource(bytes) {
  return { kind: 'wired', note: 'I11 synthetic MP3 fixture', async read() { return bytes; } };
}

/** 只记次数的预算闸：MP3 必须**撞不到**它（reserves 恒为 0 即证明「本地拒绝先于预留」）。 */
function fakeGate() {
  const state = { reserves: 0, settles: 0 };
  return {
    state,
    gate: {
      async reserve(input) {
        state.reserves += 1;
        return { capability: input.capability, authorization: input.authorization, reservedCny: 0.5, attemptKey: input.attemptKey };
      },
      async settle() { state.settles += 1; },
    },
  };
}

function fakeFetch(responder) {
  const state = { calls: 0 };
  return {
    state,
    fn: async (url, init) => {
      state.calls += 1;
      return responder(url, init);
    },
  };
}

const okResponse = (Response) => ({ ok: true, status: 200, json: async () => ({ Response }) });

const ASR_PROFILE = {
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

/**
 * 计数用的 speech store 外衣：`insertedJobs` = 真正落库的任务数。
 * 受理期被格式闸拒掉的请求**一个都不许落库**（否则后台会多出一个必然失败的作业）。
 */
function countingStore(inner = createMemorySpeechStore()) {
  const state = { insertedJobs: 0 };
  return {
    state,
    store: {
      ...inner,
      async insertJob(row) {
        state.insertedJobs += 1;
        return inner.insertJob(row);
      },
    },
  };
}

/** 一个只回答 `mime` 的媒体端口替身（`kind` 明确标注替身，避免冒充真实端口）。 */
function mimePort(mime, kind = 'substitute') {
  const state = { resolves: 0 };
  return {
    state,
    port: {
      kind,
      note: `I11 合成媒体端口：只把 mime=${String(mime)} 交给受理期格式闸`,
      async resolve() {
        state.resolves += 1;
        return { ok: true, revision: 1, mime };
      },
    },
  };
}

/** 组装一个能跑到受理期格式闸的服务（提供者可用 ⇒ 闸门是第一个会拒绝的地方）。 */
function bootAcceptance(mediaPort, store = countingStore()) {
  const service = createSpeechService({
    store: store.store,
    provider: createSpeechProvider({ executionMode: 'stub' }),
    media: mediaPort,
    idempotencyHmacKey: HMAC_KEY,
    now: () => new Date(1_700_000_000_000),
    idFactory: (() => {
      let n = 0;
      return () => {
        n += 1;
        const suffix = String(n).padStart(12, '0');
        return `99999999-8888-4777-8666-${suffix}`;
      };
    })(),
  });
  return { service, store };
}

/** 捕获受理期抛出的 `ApiError`（要连 `status` 一起看：415 是契约映射，不是本文件自说自话）。 */
async function captureApiError(operation) {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  return assert.fail('应当抛出 ApiError，却成功返回了');
}

/** 一条「已就绪的音频媒体」登记册行（`media/store.ts` 的 `MediaRecord` 形状）。 */
function mediaRow(overrides = {}) {
  return {
    id: MEDIA_ID,
    ownerId: OWNER,
    revision: 1,
    purpose: 'voice_question',
    mime: 'audio/mpeg',
    bytes: MP3.length,
    duration_ms: 131,
    sha256: sha256Hex(MP3),
    state: 'ready',
    failure_code: null,
    rawRef: 'media-objects/i11-synthetic-mp3-0001',
    derivativeRef: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    expiresAt: 1_900_000_000_000,
    ...overrides,
  };
}

/** real 分支的媒体端口（登记册是 `mime` 的唯一事实源）。 */
function realPortWith(record) {
  const mediaRecords = {
    // 登记册只认这一条记录，其余 `mediaId` 一律「查无此媒体」（不泄露存在性）。
    async getMedia(mediaId) {
      return mediaId === record.id ? record : null;
    },
  };
  return createRealMediaPort({ objectStore: { kind: 's3_compatible' }, mediaRecords, mediaDomainRefusal: null });
}

// ---------------------------------------------------------------- A. 媒体层接收 MP3

test('I11·媒体层确实接收 MP3：真实类型 audio/mpeg、真实时长可解析、伪扩展名防线放行', () => {
  const detected = detectMediaType(MP3);
  assert.deepEqual([detected.mime, detected.container], ['audio/mpeg', 'mpeg']);

  // MP3 够格进 `voice_question`：真实时长是**逐帧累计样本数**算出来的，不是信调用方声明。
  const real = computeAudioDurationMs(MP3);
  assert.equal(real.ok, true, JSON.stringify(real));
  assert.equal(real.sampleRate, 44100);
  assert.equal(real.durationMs, 131);

  const verified = assertBytesMatchDeclaration({
    bytes: MP3,
    declared: {
      mime: 'audio/mpeg',
      bytes: MP3.length,
      sha256: sha256Hex(MP3),
      purpose: 'voice_question',
      duration_ms: real.durationMs,
    },
  });
  assert.equal(verified.mime, 'audio/mpeg');
  assert.equal(verified.durationMs, real.durationMs);

  // 反向对照：把 MP3 谎报成 audio/wav 会被伪扩展名防线拦下（说明「改声明」不是出路）。
  assert.throws(
    () =>
      assertBytesMatchDeclaration({
        bytes: MP3,
        declared: { mime: 'audio/wav', bytes: MP3.length, sha256: sha256Hex(MP3), purpose: 'voice_question' },
      }),
    (error) => error.code === 'MEDIA_TYPE_UNSUPPORTED',
  );
});

// ---------------------------------------------------------------- B. ASR 层本地拒绝

test('I11·ASR 层对 MP3 本地 fail-closed：报 WAV 要求、不转码、零预留零发包', async () => {
  // 纯函数层：WAV 校验器直接点名格式，且明说不转码。
  assert.throws(
    () => requireLiveAsrWav(MP3, ASR_PROFILE),
    (error) => {
      assert.ok(error instanceof AsrLocalInputError);
      assert.equal(error.code, 'OBJECT_UNAVAILABLE');
      assert.match(error.message, /录音 WAV 不合法/);
      assert.match(error.message, /RIFF\/WAVE/);
      assert.match(error.message, /不转码/);
      assert.match(error.message, /未发包/);
      return true;
    },
  );

  // 适配器层：MP3 字节走到 transcribe，必须零预留、零发包、不产出任何文本。
  const gateBag = fakeGate();
  const fetched = fakeFetch(() => okResponse({ RequestId: 'never', Result: '不该出现', AudioDuration: 500 }));
  const provider = createLiveSpeechProvider({
    liveGate: gateBag.gate,
    authorization: 'gy-r31-i11-offline-test',
    profile: ASR_PROFILE,
    credentials: { secretId: 'synthetic-i11-secret-id', secretKey: 'synthetic-i11-secret-key', sessionToken: '' },
    audioSource: fixedSource(MP3),
    fetchImpl: fetched.fn,
  });

  const outcome = await provider.transcribe({ jobId: JOB_ID, mediaId: MEDIA_ID, mediaRevision: 1 });
  // GY-R72-I11：格式问题是客户端可修复的 415，不得再冒充「供应商不可用」。
  assert.deepEqual(outcome, { kind: 'failed', code: 'MEDIA_TYPE_UNSUPPORTED' });
  assert.equal(gateBag.state.reserves, 0, 'MP3 不得预留预算');
  assert.equal(gateBag.state.settles, 0, '没预留就没有结算');
  assert.equal(fetched.state.calls, 0, 'MP3 不得发给供应商');
  assert.equal('transcript' in outcome, false, '拒绝路径不得夹带任何转写文本');
});

// ---------------------------------------------------------------- C. 契约与冻结档位

test('I11·契约面：MP3 是**上传**合法类型、WAV 是**转写**硬要求（两侧并不对称）', () => {
  const openapi = readJson('packages/contracts/openapi.json');
  const uploadInput = openapi.components.schemas.UploadInput;
  const mimes = uploadInput.properties.mime.enum;
  assert.ok(mimes.includes('audio/mpeg'), `UploadInput.mime 仍应含 audio/mpeg，实际：${mimes.join(',')}`);
  assert.ok(mimes.includes('audio/wav'));
  assert.ok(mimes.includes('audio/aac'));

  // 转写侧：档位是**冻结**的，只有 wav 一种载体（改它就等于换供应商契约）。
  assert.equal(LIVE_ASR_FROZEN_PROFILE.voiceFormat, 'wav');
  assert.equal(LIVE_ASR_FROZEN_PROFILE.sampleRate, 16000);
  assert.equal(LIVE_ASR_FROZEN_PROFILE.channels, 1);
  assert.equal(LIVE_ASR_FROZEN_PROFILE.maxAudioSeconds, 60);

  // 状态契约把 mp3 写成**候选**录制格式，且明确「仍待 GY-I25 验证」——这是缺口可被裁定
  // 为 planned 的**唯一**依据；这句话被删掉，本裁定就失效了。
  const stateContract = readText('docs/architecture/state-contract.md');
  assert.match(stateContract, /mp3\/wav\/aac/);
  assert.match(stateContract, /仍待GY-I25验证/);
});

// ---------------------------------------------------------------- D. 受理期格式闸（原 todo 1）

test('D·受理期：登记册说 audio/mpeg ⇒ 415 MEDIA_TYPE_UNSUPPORTED，不落作业，且不吃掉 Idempotency-Key', async () => {
  const port = mimePort('audio/mpeg');
  const { service, store } = bootAcceptance(port.port);
  const key = 'i11-mp3-acceptance-0001';
  const body = { media_id: MEDIA_ID, media_revision: 1 };

  const rejection = await captureApiError(() => service.createTranscription({ userId: OWNER, body, idempotencyKey: key }));
  assert.equal(rejection.name, 'ApiError', `应当抛 ApiError，实际 ${rejection.name}: ${rejection.message}`);
  assert.equal(rejection.code, 'MEDIA_TYPE_UNSUPPORTED', 'MP3 必须报格式不支持，而不是受理成 202');
  assert.equal(rejection.status, 415, '契约映射：MEDIA_TYPE_UNSUPPORTED ⇒ 415');
  assert.match(rejection.message, /WAV/, '文案必须点名 WAV（客户端要知道换成什么）');
  assert.match(rejection.message, /audio\/mpeg/, '文案要说清登记的类型是什么');
  assert.equal(store.state.insertedJobs, 0, '被格式闸拒掉的请求不得落任务（否则后台会多一个必然失败的作业）');

  // 同一个 Idempotency-Key 再打一次：仍然是 415，而不是 REQUEST_IN_PROGRESS、也不是回放。
  const second = await captureApiError(() => service.createTranscription({ userId: OWNER, body, idempotencyKey: key }));
  assert.equal(second.code, 'MEDIA_TYPE_UNSUPPORTED');
  assert.equal(second.status, 415);
  assert.equal(store.state.insertedJobs, 0, '重复被拒同样不落任务');

  // **键没有被消耗**：同一个键换成 WAV 类型再打 ⇒ 正常受理，且不是回放（replayed === false）。
  const wavPort = mimePort('audio/wav');
  const retried = bootAcceptance(wavPort.port, store);
  const { job, replayed } = await retried.service.createTranscription({ userId: OWNER, body, idempotencyKey: key });
  assert.equal(replayed, false, '被拒请求不该在幂等台账里留下回执（否则这里会变成回放）');
  assert.equal(job.state, 'queued');
  assert.equal(store.state.insertedJobs, 1, '放行后恰好落一个任务');
  await retried.service.settle();
});

test('D·受理期·fail-open：mime 未知（null / 空串 / 缺字段）一律放行，WAV 正控放行', async () => {
  const body = { media_id: MEDIA_ID, media_revision: 1 };

  // ① 替身端口：`createSubstituteMediaPort()` 恒回 `mime: null`（不读登记册、不猜格式）。
  const substitute = createSubstituteMediaPort();
  assert.equal((await substitute.resolve({ ownerUserId: OWNER, mediaId: MEDIA_ID, mediaRevision: 1 })).mime, null);
  const substituteBoot = bootAcceptance(substitute);
  const accepted = await substituteBoot.service.createTranscription({
    userId: OWNER,
    body,
    idempotencyKey: 'i11-failopen-substitute-0001',
  });
  assert.equal(accepted.replayed, false);
  assert.equal(accepted.job.state, 'queued', 'mime 未知 ⇒ 放行（fail-open），不得凭空拒绝');
  await substituteBoot.service.settle();

  // ② real 端口 + 登记册 `mime: ''`（历史行/外部登记册的真实形状）：同样放行。
  const emptyMime = await realPortWith(mediaRow({ mime: '' })).resolve({
    ownerUserId: OWNER,
    mediaId: MEDIA_ID,
    mediaRevision: 1,
  });
  assert.equal(emptyMime.mime, null, '空串归一成「未知」，不是「不是 WAV」');
  const emptyBoot = bootAcceptance(realPortWith(mediaRow({ mime: '   ' })));
  const emptyAccepted = await emptyBoot.service.createTranscription({
    userId: OWNER,
    body,
    idempotencyKey: 'i11-failopen-empty-mime-0001',
  });
  assert.equal(emptyAccepted.job.state, 'queued', 'mime 只有空白 ⇒ 未知 ⇒ 放行');
  await emptyBoot.service.settle();

  // ③ 正控：登记册说 audio/wav ⇒ 放行（闸门不是「一律拒绝」）。
  const wavBoot = bootAcceptance(realPortWith(mediaRow({ mime: 'audio/wav' })));
  const wavAccepted = await wavBoot.service.createTranscription({
    userId: OWNER,
    body,
    idempotencyKey: 'i11-failopen-wav-0001',
  });
  assert.equal(wavAccepted.job.state, 'queued');
  await wavBoot.service.settle();

  // ④ 反控：登记册说 audio/mpeg ⇒ real 端口也必须拒绝（闸门判踞来自登记册，不是端口类型）。
  const mp3Rejection = await captureApiError(() =>
    bootAcceptance(realPortWith(mediaRow({ mime: 'audio/mpeg' }))).service.createTranscription({
      userId: OWNER,
      body,
      idempotencyKey: 'i11-failopen-mp3-0001',
    }),
  );
  assert.equal(mp3Rejection.code, 'MEDIA_TYPE_UNSUPPORTED');
  assert.equal(mp3Rejection.status, 415);
});

// ---------------------------------------------------------------- E. 失败码分流（原 todo 2）

test('E·作业失败码：MP3 不再报成供应商故障；字节来源不可用/认不出的字节仍报 PROVIDER_UNAVAILABLE', async () => {
  const outcomeOf = async (bytes) => {
    const gateBag = fakeGate();
    const fetched = fakeFetch(() => okResponse({}));
    const provider = createLiveSpeechProvider({
      liveGate: gateBag.gate,
      authorization: 'gy-r31-i11-offline-test',
      profile: ASR_PROFILE,
      credentials: { secretId: 'synthetic-i11-secret-id', secretKey: 'synthetic-i11-secret-key', sessionToken: '' },
      audioSource: fixedSource(bytes),
      fetchImpl: fetched.fn,
    });
    return { outcome: await provider.transcribe({ jobId: JOB_ID, mediaId: MEDIA_ID, mediaRevision: 1 }), gateBag, fetched };
  };

  // ① MP3：格式问题 ⇒ MEDIA_TYPE_UNSUPPORTED（客户端换 WAV 即可），且仍然零预留零发包。
  const mp3 = await outcomeOf(MP3);
  assert.equal(mp3.outcome.kind, 'failed', '拒绝必须是 failed 结局，不得变成 uncertain/succeeded');
  assert.equal(mp3.outcome.code, 'MEDIA_TYPE_UNSUPPORTED');
  assert.notEqual(mp3.outcome.code, 'PROVIDER_UNAVAILABLE', '格式问题是客户端可修复的，不该显示成「供应商不可用」');
  assert.equal(mp3.gateBag.state.reserves, 0, '格式拒绝不占预算');
  assert.equal(mp3.fetched.state.calls, 0, '格式拒绝不发包');

  // ② 反面（不许顺手放宽）：认不出真实类型的字节仍归「字节不可用」⇒ PROVIDER_UNAVAILABLE。
  //    这条口径由 `i11-audio-source-wiring` / `ai-live-provider-wiring` 独立钉住，此处只做就地对照。
  const unrecognizable = await outcomeOf(new Uint8Array(100));
  assert.deepEqual(unrecognizable.outcome, { kind: 'failed', code: 'PROVIDER_UNAVAILABLE' });
  assert.equal(unrecognizable.gateBag.state.reserves, 0);
  assert.equal(unrecognizable.fetched.state.calls, 0);

  // ③ 空字节同样不得被说成「格式不支持」。
  const empty = await outcomeOf(new Uint8Array(0));
  assert.deepEqual(empty.outcome, { kind: 'failed', code: 'PROVIDER_UNAVAILABLE' });
});
