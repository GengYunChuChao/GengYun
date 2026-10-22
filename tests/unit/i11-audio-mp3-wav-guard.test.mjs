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
 * 末尾两条 `todo` 是**缺口本体**（今天不成立，故不阻断 CI）：把 `{ todo }` 去掉即可复现——
 * 受理期给的是 202 而不是点名 WAV 的 4xx；作业失败码被归为 `PROVIDER_UNAVAILABLE`。
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

const REPO = new URL('../../', import.meta.url);
const readJson = (relative) => JSON.parse(readFileSync(new URL(relative, REPO), 'utf8'));
const readText = (relative) => readFileSync(new URL(relative, REPO), 'utf8');

const JOB_ID = '11111111-2222-4333-8444-555555555555';
const MEDIA_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

/** 5 个 MPEG1 Layer3 帧（44100Hz / 128kbps）⇒ 5×1152/44100 ≈ 130.6ms。 */
const MP3 = mp3Bytes({ frames: 5 });

const sha256Hex = (bytes) => createHash('sha256').update(Buffer.from(bytes)).digest('hex');

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
  assert.deepEqual(outcome, { kind: 'failed', code: 'PROVIDER_UNAVAILABLE' });
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

// ---------------------------------------------------------------- D. 缺口本体（未修）

test(
  'I11·缺口本体（未修）：受理期就该给点名 WAV 的 4xx，而不是 202 之后异步 failed',
  {
    todo:
      '需 SpeechMediaPort.resolve 回真实 mime（端口形状变更），或在受理期读对象存储头部 12 字节；' +
      '两者都要指挥裁定，本版不动。去掉本 todo 即复现缺口。',
  },
  () => {
    assert.fail(
      '今天 MP3 的 POST /speech/transcriptions 返回 202，随后后台作业 failed；' +
        '客户端拿不到任何「请上传 WAV」的文案。',
    );
  },
);

test(
  'I11·缺口本体（未修）：MP3 的作业失败码不得报成供应商故障',
  { todo: '需新增格式类错误码（如 MEDIA_FORMAT_UNSUPPORTED）并同步 ErrorCode 闭集与 openapi 枚举；本版不动。' },
  async () => {
    const provider = createLiveSpeechProvider({
      liveGate: fakeGate().gate,
      authorization: 'gy-r31-i11-offline-test',
      profile: ASR_PROFILE,
      credentials: { secretId: 'synthetic-i11-secret-id', secretKey: 'synthetic-i11-secret-key', sessionToken: '' },
      audioSource: fixedSource(MP3),
      fetchImpl: fakeFetch(() => okResponse({})).fn,
    });
    const outcome = await provider.transcribe({ jobId: JOB_ID, mediaId: MEDIA_ID, mediaRevision: 1 });
    assert.notEqual(
      outcome.code,
      'PROVIDER_UNAVAILABLE',
      '格式问题是客户端可修复的，不该显示成「供应商不可用」',
    );
  },
);
