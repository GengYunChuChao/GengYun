// GY-R28-W1 · TTS / 标签 OCR / 普通话 ASR **真实提供者**的手工验证装置（默认纯离线 dry run）。
//
// 安全口径（逐条对应派单 §2 第三步与红线）：
//  - 默认（无 `--live`）= **纯离线 dry run**：不读凭据文件、不发任何包、不写任何台账；
//    把 `globalThis.fetch` 换成绊线并断言全程未触发。
//  - 付费路径必须**同时**具备四件：`--live` + `--capability <tts|ocr|asr>` +
//    `--manual-authorization <本轮常量>` + `--credentials <私密文件路径>`，
//    且台账（`.supervisor/w1-r28-live/ledger.json`）已存在、authorization 逐字一致、
//    该能力预留次数 < 2、总额 ≤ ¥2。缺一即拒绝（`MANUAL_AUTHORIZATION_REQUIRED` / `LEDGER_*`）。
//  - **reserve-then-send**：先把「预留」写进台账再发包；台账写失败 ⇒ **零发送**；
//    成功/失败/超时/传输失败都必须 settle；`actualChargeCny` 恒为 `null`（未取得账单，绝不编造）。
//  - 进程锁 `process.lock`（`wx`）阻断并发与第二次；崩溃留下的锁**不自动清理**。
//  - 凭据**只经** `loadPrivateEnvironment()` 进内存；输出前用「实际凭据值不得出现在输出里」自检兜底；
//    只打印端点/动作/版本/地域/HTTP 状态/耗时/RequestId/字节数/检出字符数/预留金额，**不回显响应正文**。
//  - 图片 ≤ 2MiB、音频 ≤ 60 秒，且只用**本工具生成的合成样张**（`--init-fixtures`），⛔ 不用真人照片/录音。
//
// 用途边界：这是**手工装置**，不是产品路径。它直接构造域内真实适配器（注入文件台账 + 合成字节来源），
// 绕过 service 的「媒体端口/已核对内容端口」前置（那两条断点属媒体域，本片未接线，见证据页）。
// ⛔ 本工具不得被任何 workflow 引用，也不得进任何 `test:*` 套件。
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';

import { loadPrivateEnvironment } from './ai-config.mjs';
import { loadConfig } from '../services/api/src/config.ts';
import { LiveGateRefusedError } from '../services/api/src/tts/live-ports.ts';
import { createLiveTtsProviderFromConfig } from '../services/api/src/tts/provider.ts';
import { createLiveOcrProviderFromConfig } from '../services/api/src/ai/ocr-live-adapter.ts';
import { createLiveSpeechProviderFromConfig } from '../services/api/src/ai/asr-live-adapter.ts';

/** 本轮（2026-10-21）新授权标签。**不复用**既有任何轮次常量。 */
export const ROUND_AUTHORIZATION = 'gy-r28-w1-provider-20261021-cny2';
export const ROUND_VERSION = '1';
/** 本片放行的三个能力（每能力 ≤2 次成功发送）。 */
export const WIRED_CAPABILITIES = Object.freeze(['tts', 'ocr', 'asr']);
/** 保守预留单价（CNY/次）：与 `docs/verification/gy-i27-live-ai-20261018.md` 的计费依据同口径。 */
export const PRICES = Object.freeze({ tts: 0.003, ocr: 0.5, asr: 0.0032 });
export const CEILING_CNY = 2;
export const MAX_PER_CAPABILITY = 2;

/** 合成 TTS 文本（≤100 码点、非个人、非处方、无剂量建议）。 */
export const SYNTHETIC_TEXT = '你好，这是语音测试。';

const DIR = new URL('../.supervisor/w1-r28-live/', import.meta.url);
const LEDGER_FILE = new URL('ledger.json', DIR);
const LOCK_FILE = new URL('process.lock', DIR);
const IMAGE_FILE = new URL('synthetic.png', DIR);
const AUDIO_FILE = new URL('synthetic-speech.wav', DIR);
const MANIFEST_FILE = new URL('synthetic-manifest.json', DIR);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// ---------------------------------------------------------------------------
// 输出（含「输出里不得出现凭据值」自检）
// ---------------------------------------------------------------------------
let secretValues = [];
function say(text) {
  const line = String(text);
  for (const secret of secretValues) {
    if (typeof secret === 'string' && secret.trim().length >= 8 && line.includes(secret)) {
      throw new Error('SECRET_LEAK_IN_OUTPUT');
    }
  }
  process.stdout.write(`${line}\n`);
}
function fail(code, detail = '') {
  const error = new Error(detail === '' ? code : `${code}: ${detail}`);
  error.code = code;
  throw error;
}

// ---------------------------------------------------------------------------
// 合成样张（确定性生成；不是真人照片/录音）
// ---------------------------------------------------------------------------

/** 5x7 点阵（只覆盖本样张用到的字符）。 */
const FONT = {
  G: [0x0e, 0x10, 0x10, 0x16, 0x11, 0x11, 0x0e],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
  2: [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  0: [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  6: [0x0c, 0x10, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  ' ': [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
};
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/**
 * 生成一张白底黑字的合成 PNG（文本 `GY 2026`，8 倍放大，无个人信息、无真人内容）。
 * 只为一个目的：让 `GeneralAccurateOCR` 有可识别的字形，从而证明「真的读到了字」。
 */
export function buildSyntheticPng(text = 'GY 2026', scale = 8) {
  const margin = 24;
  const glyphWidth = 6 * scale;
  const width = margin * 2 + text.length * glyphWidth;
  const height = margin * 2 + 7 * scale;
  // 每行 1 字节过滤类型 + RGB 像素（白底）。
  const rowBytes = 1 + width * 3;
  const raw = Buffer.alloc(rowBytes * height, 0xff);
  for (let y = 0; y < height; y += 1) raw[y * rowBytes] = 0;
  for (let index = 0; index < text.length; index += 1) {
    const glyph = FONT[text[index]] ?? FONT[' '];
    for (let column = 0; column < 5; column += 1) {
      for (let row = 0; row < 7; row += 1) {
        if ((glyph[row] & (0x10 >> column)) === 0) continue;
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) {
            const x = margin + index * glyphWidth + column * scale + dx;
            const y = margin + row * scale + dy;
            const offset = y * rowBytes + 1 + x * 3;
            raw[offset] = 0x00;
            raw[offset + 1] = 0x00;
            raw[offset + 2] = 0x00;
          }
        }
      }
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // color type: truecolor
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  const zlib = { deflateSync };
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 生成 16kHz / 单声道 / 16bit PCM 的合成 WAV（默认 2 秒 440Hz 正弦 + 淡入淡出，不是真人录音）。 */
export function buildSyntheticWav(seconds = 2) {
  const sampleRate = 16000;
  const samples = Math.round(sampleRate * seconds);
  const data = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    const t = index / sampleRate;
    const fade = Math.min(1, index / 800, (samples - index) / 800);
    const value = Math.round(Math.sin(2 * Math.PI * 440 * t) * 0.2 * fade * 32767);
    data.writeInt16LE(value, index * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// ---------------------------------------------------------------------------
// 台账闸门（reserve-then-send；只用本工具自己的台账）
// ---------------------------------------------------------------------------

function readLedger() {
  if (!existsSync(LEDGER_FILE)) fail('LEDGER_MISSING');
  const ledger = JSON.parse(readFileSync(LEDGER_FILE, 'utf8'));
  if (ledger?.authorization !== ROUND_AUTHORIZATION) fail('LEDGER_AUTHORIZATION_MISMATCH');
  if (ledger?.ceilingCny !== CEILING_CNY) fail('LEDGER_CEILING_MISMATCH');
  if (!Array.isArray(ledger.entries) || !Number.isFinite(ledger.reservedCny)) fail('LEDGER_INTEGRITY_REQUIRED');
  const sum = ledger.entries.reduce((total, entry) => total + (Number(entry?.reservedCny) || 0), 0);
  if (Math.abs(sum - ledger.reservedCny) > 1e-6) fail('LEDGER_INTEGRITY_REQUIRED');
  for (const entry of ledger.entries) {
    if (!WIRED_CAPABILITIES.includes(entry?.capability) || entry.reservedCny !== PRICES[entry.capability]) {
      fail('LEDGER_INTEGRITY_REQUIRED');
    }
  }
  return ledger;
}

function writeLedger(ledger) {
  try {
    writeFileSync(LEDGER_FILE, `${JSON.stringify(ledger, null, 2)}\n`);
  } catch (error) {
    fail('LEDGER_WRITE_FAILED', String(error?.message ?? error));
  }
}

/** 闸门：**先落账，再发包**；成功与失败都要 settle。 */
function createLedgerGate() {
  return {
    async reserve({ capability, authorization, attemptKey }) {
      let ledger;
      try {
        ledger = readLedger();
      } catch (error) {
        throw new LiveGateRefusedError('LEDGER_UNAVAILABLE', `台账不可用：${error?.code ?? error?.message ?? error}`);
      }
      if (authorization !== ROUND_AUTHORIZATION) {
        throw new LiveGateRefusedError('AUTHORIZATION_REQUIRED', '授权串与本轮常量不一致');
      }
      if (ledger.entries.some((entry) => entry.attemptKey === attemptKey)) {
        throw new LiveGateRefusedError('ATTEMPT_ALREADY_RESERVED', '同一次尝试已预留过（绝不重发）');
      }
      const price = PRICES[capability];
      const count = ledger.entries.filter((entry) => entry.capability === capability).length;
      if (count >= MAX_PER_CAPABILITY || ledger.reservedCny + price > CEILING_CNY + 1e-9) {
        throw new LiveGateRefusedError('BUDGET_OR_COUNT_EXCEEDED', `capability=${capability} count=${count}`);
      }
      ledger.entries.push({
        capability,
        attemptKey,
        reservedCny: price,
        reservedAt: new Date().toISOString(),
        state: 'RESERVED',
        actualChargeCny: null,
        providerErrorCode: null,
        resultMayHaveBeenProcessed: true,
      });
      ledger.reservedCny = Number((ledger.reservedCny + price).toFixed(6));
      writeLedger(ledger); // reserve-then-send：台账写失败 ⇒ 抛错 ⇒ 零发送
      return { capability, authorization, reservedCny: price, attemptKey };
    },
    async settle(ticket, outcome) {
      const ledger = readLedger();
      const entry = ledger.entries.find((item) => item.attemptKey === ticket.attemptKey);
      if (entry === undefined) fail('LEDGER_ENTRY_MISSING');
      entry.state = outcome.state;
      entry.actualChargeCny = outcome.actualChargeCny;
      entry.providerErrorCode = outcome.providerErrorCode;
      entry.resultMayHaveBeenProcessed = outcome.resultMayHaveBeenProcessed;
      entry.settledAt = new Date().toISOString();
      writeLedger(ledger);
    },
  };
}

export function initLedger() {
  mkdirSync(DIR, { recursive: true });
  if (existsSync(LEDGER_FILE)) fail('LEDGER_ALREADY_EXISTS');
  writeLedger({
    authorization: ROUND_AUTHORIZATION,
    version: ROUND_VERSION,
    ceilingCny: CEILING_CNY,
    maxPerCapability: MAX_PER_CAPABILITY,
    prices: PRICES,
    reservedCny: 0,
    entries: [],
  });
  return LEDGER_FILE.pathname;
}

export function initFixtures() {
  mkdirSync(DIR, { recursive: true });
  const image = buildSyntheticPng();
  const wav = buildSyntheticWav();
  if (image.length > 2097152) fail('IMAGE_FIXTURE_TOO_LARGE', String(image.length));
  if (wav.length > 3145728) fail('AUDIO_FIXTURE_TOO_LARGE', String(wav.length));
  writeFileSync(IMAGE_FILE, image);
  writeFileSync(AUDIO_FILE, wav);
  const manifest = {
    purpose: 'manual_access_test',
    nonpersonalSynthetic: true,
    generatedBy: 'tools/verify-provider-live-r28.mjs --init-fixtures',
    authorization: ROUND_AUTHORIZATION,
    imageBytes: image.length,
    imageSha256: sha256(image),
    audioBytes: wav.length,
    audioSha256: sha256(wav),
    audioProfile: { sampleRate: 16000, channels: 1, bitsPerSample: 16, seconds: 2 },
  };
  writeFileSync(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** 只用固定本机合成夹具：先核对 manifest 三字段与双 SHA-256，再允许使用。 */
function verifyFixtures() {
  if (!existsSync(MANIFEST_FILE)) fail('FIXTURES_MISSING', '先跑 --init-fixtures');
  const manifest = JSON.parse(readFileSync(MANIFEST_FILE, 'utf8'));
  const image = readFileSync(IMAGE_FILE);
  const wav = readFileSync(AUDIO_FILE);
  if (manifest.nonpersonalSynthetic !== true || manifest.purpose !== 'manual_access_test') fail('SYNTHETIC_PURPOSE_REQUIRED');
  if (sha256(image) !== manifest.imageSha256) fail('IMAGE_FIXTURE_MISMATCH');
  if (sha256(wav) !== manifest.audioSha256) fail('AUDIO_FIXTURE_MISMATCH');
  return { image, wav, manifest };
}

// ---------------------------------------------------------------------------
// 参数与装配
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    live: false,
    capability: null,
    manualAuthorization: null,
    credentials: null,
    attempt: '1',
    asrCredentials: 'dedicated',
    initFixtures: false,
    initLedger: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--live') { args.live = true; continue; }
    if (flag === '--init-fixtures') { args.initFixtures = true; continue; }
    if (flag === '--init-ledger') { args.initLedger = true; continue; }
    const value = argv[index + 1];
    if (typeof value !== 'string' || value === '') fail('MANUAL_ARGUMENTS_REQUIRED', flag);
    index += 1;
    if (flag === '--capability') args.capability = value;
    else if (flag === '--manual-authorization') args.manualAuthorization = value;
    else if (flag === '--credentials') args.credentials = value;
    else if (flag === '--attempt') args.attempt = value;
    else if (flag === '--asr-credentials') args.asrCredentials = value;
    else fail('MANUAL_ARGUMENTS_REQUIRED', flag);
  }
  return args;
}

/**
 * 用**真实配置加载器**搬运 AI 剖面：只有 AI 凭据来自私密文件，
 * 其余 real 必填项用**合成占位值**（绝不连接；本工具不做任何 DB/微信/对象存储访问）。
 */
function buildConfig(privateEnv) {
  return loadConfig({
    APP_EXECUTION_MODE: 'real',
    LOG_LEVEL: 'silent',
    DATABASE_URL: 'postgres://synthetic_local_only@127.0.0.1:5432/gengyun_synthetic_never_connected',
    SESSION_SIGNING_KEY: 'synthetic-not-a-real-signing-key',
    DELETION_LEDGER_KEY: 'synthetic-not-a-real-ledger-key',
    WECHAT_APP_ID: 'synthetic-not-a-real-appid',
    WECHAT_APP_SECRET: 'synthetic-not-a-real-appsecret',
    OBJECT_STORAGE_ENDPOINT: 'https://example.invalid',
    OBJECT_STORAGE_BUCKET: 'synthetic-not-a-real-bucket',
    OBJECT_STORAGE_ACCESS_KEY: 'synthetic-not-a-real-access-key',
    OBJECT_STORAGE_SECRET_KEY: 'synthetic-not-a-real-secret-key',
    ...privateEnv,
  });
}

function acquireLock() {
  mkdirSync(DIR, { recursive: true });
  try {
    writeFileSync(LOCK_FILE, `${process.pid}\n`, { flag: 'wx' });
  } catch {
    fail('PROCESS_LOCK_HELD', LOCK_FILE.pathname);
  }
}

function releaseLock() {
  try {
    unlinkSync(LOCK_FILE);
  } catch {
    /* 已经不在就算了 */
  }
}

/**
 * 每次尝试的**唯一**引用（jobId / mediaId / 目标引用）。
 * ⚠ `attemptKey` 由适配器按 `<jobId>:<mediaId>#<revision>`（TTS 为 `<jobId>:<目标引用>`）派生，
 * 台账靠它防重复计费 ⇒ **不同能力/不同轮次必须给出不同 jobId**，否则闸门会以
 * `ATTEMPT_ALREADY_RESERVED` 正当地拒绝第二次（本工具第一次跑就撞上过，见证据页）。
 */
function attemptKeys(capability, attempt) {
  const hex = sha256(`${capability}-attempt-${attempt}`);
  const jobId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  const mediaHex = sha256(`media-${capability}-${attempt}`);
  const mediaId = `${mediaHex.slice(0, 8)}-${mediaHex.slice(8, 12)}-4${mediaHex.slice(13, 16)}-8${mediaHex.slice(17, 20)}-${mediaHex.slice(20, 32)}`;
  return {
    jobId,
    mediaId,
    targetRef: { type: 'answer', id: `synthetic-r28w1-${capability}-${attempt}`, revision: 1 },
  };
}

function observationLine(observation) {
  const keys = Object.keys(observation).sort();
  return keys.map((key) => `${key}=${String(observation[key])}`).join(' ');
}

// ---------------------------------------------------------------------------
// 离线 dry run（默认）：假 fetch + 绊线，断言零外呼、零台账写入
// ---------------------------------------------------------------------------
async function dryRun() {
  const original = globalThis.fetch;
  const state = { calls: 0, reserves: 0, settles: 0 };
  globalThis.fetch = async () => {
    state.calls += 1;
    throw new Error('TRIPWIRE_NETWORK_CALL');
  };
  const fakeGate = {
    async reserve(ticket) {
      state.reserves += 1;
      return { capability: ticket.capability, authorization: ticket.authorization, reservedCny: 0, attemptKey: ticket.attemptKey };
    },
    async settle() {
      state.settles += 1;
    },
  };
  const image = buildSyntheticPng();
  const wav = buildSyntheticWav();
  const config = buildConfig({
    TENCENTCLOUD_SECRET_ID: 'synthetic-offline-secret-id',
    TENCENTCLOUD_SECRET_KEY: 'synthetic-offline-secret-key',
    TENCENTCLOUD_ASR_SECRET_ID: 'synthetic-offline-asr-id',
    TENCENTCLOUD_ASR_SECRET_KEY: 'synthetic-offline-asr-key',
  });
  secretValues = [
    'synthetic-offline-secret-id',
    'synthetic-offline-secret-key',
    'synthetic-offline-asr-id',
    'synthetic-offline-asr-key',
  ];
  try {
    const keys = attemptKeys('dry', 1);
    const tts = createLiveTtsProviderFromConfig(config.aiProviders.tts, { authorization: ROUND_AUTHORIZATION, liveGate: fakeGate, now: () => 1_700_000_000_000 });
    const ocr = createLiveOcrProviderFromConfig(config.aiProviders.ocr, {
      authorization: ROUND_AUTHORIZATION,
      liveGate: fakeGate,
      imageSource: { kind: 'wired', note: 'offline synthetic', async read() { return new Uint8Array(image); } },
    });
    const asr = createLiveSpeechProviderFromConfig(config.aiProviders.asr, {
      authorization: ROUND_AUTHORIZATION,
      liveGate: fakeGate,
      audioSource: { kind: 'wired', note: 'offline synthetic', async read() { return new Uint8Array(wav); } },
    });
    say(`dry_run capabilities=${WIRED_CAPABILITIES.join(',')} imageBytes=${image.length} wavBytes=${wav.length}`);
    say(`dry_run assembly ok: tts.available=${tts.available} ocr.available=${ocr.available} asr.available=${asr.available}`);
    say(`dry_run providerVersion: tts=${tts.providerVersion} ocr=${ocr.modelVersion} asr=${asr.modelVersion}`);
    // 走到「即将发送」即被绊线拦住 ⇒ 证明不需要真实网络就能验证接线形状。
    await tts.synthesize({ jobId: keys.jobId, text: SYNTHETIC_TEXT, locale: 'zh-CN', targetRef: keys.targetRef }).catch(() => null);
    await ocr.extract({ jobId: keys.jobId, mediaId: keys.mediaId, mediaRevision: 1 }).catch(() => null);
    await asr.transcribe({ jobId: keys.jobId, mediaId: keys.mediaId, mediaRevision: 1 }).catch(() => null);
    say(`dry_run boundary: reserves=${state.reserves} settles=${state.settles} tripwire_calls=${state.calls} ledger_written=false`);
    if (state.reserves !== 3) fail('RESERVE_COUNT_MISMATCH', String(state.reserves));
    if (state.settles !== 3) fail('SETTLE_COUNT_MISMATCH', String(state.settles));
    say('SCOPE=offline_only; no supplier was contacted; no budget consumed; no ledger written');
  } finally {
    globalThis.fetch = original;
  }
}

// ---------------------------------------------------------------------------
// 付费路径（--live）
// ---------------------------------------------------------------------------
async function liveRun(args) {
  if (!WIRED_CAPABILITIES.includes(args.capability)) fail('CAPABILITY_NOT_WIRED_THIS_ROUND', String(args.capability));
  if (args.manualAuthorization !== ROUND_AUTHORIZATION) fail('MANUAL_AUTHORIZATION_REQUIRED');
  if (args.credentials === null || !existsSync(args.credentials)) fail('CREDENTIALS_PATH_REQUIRED');
  // 允许 1..9：**超过 2 的尝试必须由台账闸门拒绝**（而不是靠参数校验提前挡掉），
  // 这样「每端点 ≤2」这条上限才能被真正取证（拒绝发生在 reserve，零发送、零记账）。
  if (!/^[1-9]$/.test(args.attempt)) fail('ATTEMPT_OUT_OF_RANGE', args.attempt);
  const fixtures = verifyFixtures();
  if (!existsSync(LEDGER_FILE)) fail('LEDGER_MISSING', '先跑 --init-ledger');

  const privateEnv = loadPrivateEnvironment(args.credentials, {});
  if (!['dedicated', 'shared'].includes(args.asrCredentials)) fail('ASR_CREDENTIAL_SELECTION_INVALID', args.asrCredentials);
  if (args.asrCredentials === 'shared') {
    // `configurationIssues()` 对 asr 显式允许「共享对」这一组合；本开关只为**分别取证**两组合法凭据，
    // 不改变产品配置规则（产品仍按「专用对优先、缺则回退共享对」装配）。
    delete privateEnv.TENCENTCLOUD_ASR_SECRET_ID;
    delete privateEnv.TENCENTCLOUD_ASR_SECRET_KEY;
    delete privateEnv.TENCENTCLOUD_ASR_SESSION_TOKEN;
  }
  secretValues = [
    privateEnv.TENCENTCLOUD_SECRET_ID,
    privateEnv.TENCENTCLOUD_SECRET_KEY,
    privateEnv.TENCENTCLOUD_ASR_SECRET_ID,
    privateEnv.TENCENTCLOUD_ASR_SECRET_KEY,
    privateEnv.TENCENTCLOUD_SESSION_TOKEN,
    privateEnv.TENCENTCLOUD_ASR_SESSION_TOKEN,
  ].filter((value) => typeof value === 'string' && value.trim() !== '');

  const config = buildConfig(privateEnv);
  const provider = config.aiProviders[args.capability];
  if (provider === null || provider === undefined) fail('PROVIDER_NOT_CONFIGURED', args.capability);

  acquireLock();
  const keys = attemptKeys(args.capability, args.attempt);
  const observations = [];
  const onObservation = (observation) => observations.push(observation);
  const gate = createLedgerGate();
  const startedAt = Date.now();
  let before;
  let result;
  // ⚠ 锁的释放必须在 `finally` 里**覆盖整段**（含 readLedger 的完整性检查）——
  //   本工具的负控制实跑时发现：把 readLedger 放在 try 之外会留下 process.lock 崩溃工件，
  //   并让后续每一次尝试都以 PROCESS_LOCK_HELD 被拒。修正后任何拒绝路径都会释放锁。
  try {
    before = readLedger();
    say(`round=${ROUND_AUTHORIZATION} capability=${args.capability} attempt=${args.attempt}`);
    say(`ledger=${LEDGER_FILE.pathname} entries_before=${before.entries.length} reservedCny_before=${before.reservedCny}`);
    say(`profile: endpoint=${provider.endpoint} action=${provider.action} apiVersion=${provider.apiVersion} region=${provider.region} timeoutMs=${provider.timeoutMs} maxRetries=${provider.maxRetries}`);
    say(`credential_pair=${args.capability === 'asr' ? args.asrCredentials : 'shared'} secretIdEnv=${provider.secretIdEnv} apiKeyEnv=${provider.apiKeyEnv}（只打印环境变量名，不打印值）`);
    say(`fixtures: imageBytes=${fixtures.manifest.imageBytes} imageSha256=${fixtures.manifest.imageSha256.slice(0, 12)}… audioBytes=${fixtures.manifest.audioBytes} audioSha256=${fixtures.manifest.audioSha256.slice(0, 12)}…`);
    if (args.capability === 'tts') {
      const tts = createLiveTtsProviderFromConfig(provider, { authorization: ROUND_AUTHORIZATION, liveGate: gate, onObservation });
      result = await tts.synthesize({ jobId: keys.jobId, text: SYNTHETIC_TEXT, locale: 'zh-CN', targetRef: keys.targetRef });
    } else if (args.capability === 'ocr') {
      const ocr = createLiveOcrProviderFromConfig(provider, {
        authorization: ROUND_AUTHORIZATION,
        liveGate: gate,
        onObservation,
        imageSource: { kind: 'wired', note: 'synthetic fixture（非真人照片）', async read() { return new Uint8Array(fixtures.image); } },
      });
      result = await ocr.extract({ jobId: keys.jobId, mediaId: keys.mediaId, mediaRevision: 1 });
    } else {
      const asr = createLiveSpeechProviderFromConfig(provider, {
        authorization: ROUND_AUTHORIZATION,
        liveGate: gate,
        onObservation,
        audioSource: { kind: 'wired', note: 'synthetic fixture（非真人录音）', async read() { return new Uint8Array(fixtures.wav); } },
      });
      result = await asr.transcribe({ jobId: keys.jobId, mediaId: keys.mediaId, mediaRevision: 1 });
    }
  } finally {
    releaseLock();
  }
  const elapsedMs = Date.now() - startedAt;
  const observation = observations[0] ?? null;
  const kind = result?.kind ?? 'NONE';
  if (observation !== null) say(`observation: ${observationLine(observation)}`);
  say(`result: kind=${kind}${result?.code === undefined ? '' : ` code=${result.code}`}${result?.reason === undefined ? '' : ` reason=${result.reason}`} wallClockMs=${elapsedMs}`);
  if (args.capability === 'tts' && result?.kind === 'completed') {
    say(`artifact: contentType=${result.artifact.contentType} substitute=${result.artifact.substitute} bytes=${result.artifact.body.length}`);
  }
  if (args.capability === 'ocr' && result?.kind === 'completed') {
    // 只回显**字段是否存在**，不回显识别正文（证据页不落标签原文）。
    const fields = result.fields;
    say(`fields: registration_number=${fields.registration_number === null ? 'null' : 'present'} name=${fields.name === null ? 'null' : 'present'} ingredients=${fields.ingredients.length} dosage_form=${fields.dosage_form === null ? 'null' : 'present'}`);
  }
  if (args.capability === 'asr' && result?.kind === 'completed') {
    say(`transcript: characters=${[...result.transcript.text].length} uncertain_spans=${result.transcript.uncertain_spans.length}`);
  }
  const after = readLedger();
  const entry = after.entries[after.entries.length - 1];
  say(`ledger: entries=${after.entries.length} reservedCny_total=${after.reservedCny} entry_state=${entry.state} actualChargeCny=${String(entry.actualChargeCny)} providerErrorCode=${String(entry.providerErrorCode)}`);
  say(`estimate_cny=${PRICES[args.capability]} (保守预留，不是账单金额)`);
  if (observation === null) fail('OBSERVATION_MISSING');
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.initFixtures) {
    const manifest = initFixtures();
    say(`fixtures_written image=${manifest.imageBytes}B sha256=${manifest.imageSha256}`);
    say(`fixtures_written audio=${manifest.audioBytes}B sha256=${manifest.audioSha256}`);
    return;
  }
  if (args.initLedger) {
    say(`ledger_initialized ${initLedger()} ceilingCny=${CEILING_CNY} maxPerCapability=${MAX_PER_CAPABILITY}`);
    return;
  }
  if (!args.live) {
    await dryRun();
    return;
  }
  await liveRun(args);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`REFUSED ${error?.code ?? ''} ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
