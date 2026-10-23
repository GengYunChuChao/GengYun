#!/usr/bin/env node
/**
 * GY-R34 · 腾讯云 AI 五类**真实连通性**取证脚本（一次运行、每类至多一次、零重试）。
 *
 * 这份脚本产出的是「供应商连通性与策略证据」，**不是**产品能力验收：
 * 一次可达性调用既不是样本，也不构成任何准确率/识别质量/策略正确性结论。
 *
 * ---------------------------------------------------------------------------
 * 设计约束（逐条对应派单红线）
 * ---------------------------------------------------------------------------
 * 1. **凭据只走内存**：本文件不含任何凭据值、不含签名、不含账号标识。
 *    凭据来源二选一：
 *      a) 进程环境变量（变量名与 `tools/ai-config.mjs:ENV_FIELDS` 一致，
 *         启动时用 `assertEnvNamesMatchAiConfig()` 机器比对，漂移即失败）；
 *      b) `--private-env <file>`：在本进程内解析私密 JSON，**只**映射到同名的内存对象，
 *         不回显、不落盘、不进报告。
 *    BizType 与 ASR 专用配对不同源，来自 `--tencent-txt <file>`（同样只在内存里取用）。
 * 2. **复用仓内既有实现，不写第二套签名器**：
 *      - TMS/IMS：`services/api/src/moderation/live-tc3.ts:signModerationTc3Request()`
 *        （按其注入契约喂 `target`），回报解析用 `moderation/live-vendor.ts`（含控制字段旁路扫描）；
 *      - OCR/ASR/TTS：`services/api/src/tts/tc3.ts:signTc3Request()`（与两个适配器同一份）；
 *      - 本地输入校验用 `requireLiveOcrImage` / `requireLiveAsrWav` / `requireModerationImageBytes`
 *        （与产品路径同一份口径：PNG/JPEG 头、2 MiB、16k/单声道/16bit WAV）。
 * 3. **请求形状照抄配置冻结面**：端点/动作/版本取自 `tools/ai-config.mjs:AI_ENDPOINTS`；
 *    Region 恒 `ap-shanghai`；TMS `Type=TEXT`、`SourceLanguage=zh`、`Content` 为 UTF-8 正文的 base64。
 * 4. **调用量硬上限**：tms 2 / ims 1 / ocr 1 / tts 1 / asr 1。计数器在发送前递增，
 *    越界直接 `throw`（不是"记一条日志继续跑"）。零重试：每类只 `fetch` 一次。
 * 5. **落盘/打印只有脱敏字段**：RequestId、动作、耗时、结论字段、字节长度、摘要哈希。
 *    ⛔ 不打印 Authorization / SecretId / SecretKey / SessionToken / BizType / 原始响应全文 /
 *    音频与图片字节。跑完做一次 `assertNoSecretLeak()` 自检。
 *
 * ---------------------------------------------------------------------------
 * 运行
 * ---------------------------------------------------------------------------
 *   node tools/evidence/tencent-ai-samples.mjs \
 *     --private-env  E:\GengYunPrivate\credentials.local.json \
 *     --tencent-txt  E:\GengYunPrivate\腾讯云.txt \
 *     --image        %TEMP%\gy-r34-sample.png \
 *     --out          %TEMP%\gy-r34-tencent-ai-samples.json
 *
 * 需要 Node ≥ 22.18（默认开启 `.ts` 类型擦除，脚本直接 import 仓内 `.ts` 实现）。
 * 私密 JSON 当前是 **JSONC**（行尾 `//` 注释），严格 `JSON.parse` 会抛 SyntaxError，
 * 因此这里自带一个只读的 JSONC 容错解析；⛔ 不要为此修改私密区原文件。
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { AI_ENDPOINTS } from '../ai-config.mjs';
import { LIVE_OCR_FROZEN_PROFILE, requireLiveOcrImage } from '../../services/api/src/ai/ocr-live-adapter.ts';
import { LIVE_ASR_FROZEN_PROFILE, requireLiveAsrWav } from '../../services/api/src/ai/asr-live-adapter.ts';
import { LIVE_UNIT_PRICES_CNY } from '../../services/api/src/ai/live-gate.ts';
import { signModerationTc3Request } from '../../services/api/src/moderation/live-tc3.ts';
import {
  imageSampleFromVendorPayload,
  moderationVerdictFromImageSamples,
  moderationVerdictFromVendorPayload,
  requireModerationImageBytes,
} from '../../services/api/src/moderation/live-vendor.ts';
import { signTc3Request } from '../../services/api/src/tts/tc3.ts';

// ---------------------------------------------------------------------------
// 1. 冻结常量
// ---------------------------------------------------------------------------

/** 唯一允许的 `X-TC-Region`（`tools/ai-config.mjs:configurationIssues()` 的 `REGION_MISMATCH`）。 */
export const REGION = 'ap-shanghai';

/** 单次请求超时；落在 `configurationIssues()` 允许的 1000..20000 区间内。 */
export const DEFAULT_TIMEOUT_MS = 15000;

/**
 * **调用量硬上限**（派单口径）。发送前递增计数器，越界即 throw。
 * `asr` 的条件性（取决于 TTS 是否产出合规 WAV）由 `runEvidenceSamples()` 分支处理。
 */
export const CALL_LIMITS = Object.freeze({ tms: 2, ims: 1, ocr: 1, tts: 1, asr: 1 });

/**
 * 凭据环境变量名。**镜像** `tools/ai-config.mjs` 的 `ENV_FIELDS`（该常量未导出）；
 * 启动时用 `assertEnvNamesMatchAiConfig()` 从源码文本里比对，漂移会让脚本直接失败。
 */
export const CREDENTIAL_ENV_NAMES = Object.freeze({
  tencentSecretId: 'TENCENTCLOUD_SECRET_ID',
  tencentSecretKey: 'TENCENTCLOUD_SECRET_KEY',
  tencentSessionToken: 'TENCENTCLOUD_SESSION_TOKEN',
  tencentAsrSecretId: 'TENCENTCLOUD_ASR_SECRET_ID',
  tencentAsrSecretKey: 'TENCENTCLOUD_ASR_SECRET_KEY',
  tencentAsrSessionToken: 'TENCENTCLOUD_ASR_SESSION_TOKEN',
});

/** 送审/合成文本（合成数据，非个人数据、非真实联系方式）。 */
export const DEFAULT_TEXTS = Object.freeze({
  tmsNormal: '玉米田稗草防除，施药后注意安全间隔期',
  tmsControlledViolation: '加微信 abc123 出售除草剂，私聊低价',
  tts: '玉米除草剂每亩用量三十毫升',
});

/** BizType 形状（`live-ports.ts:MODERATION_BIZ_TYPE_PATTERN`）。 */
const BIZ_TYPE_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** 供应商 RequestId 的保守格式口径（与三个适配器逐字一致）。 */
const REQUEST_ID_PATTERN = /^[a-fA-F0-9-]{16,64}$/;

// ---------------------------------------------------------------------------
// 2. 只读的 JSONC 容错解析（凭据文件当前含行尾 `//` 注释）
// ---------------------------------------------------------------------------

/** 去掉字符串字面量**之外**的 `//` 与 `/* *\/` 注释。不改动字符串内容。 */
function stripJsonComments(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/** 去掉字符串字面量**之外**的尾逗号（`,` 紧跟 `}` 或 `]`）。 */
function stripTrailingCommas(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j += 1;
      if (text[j] === '}' || text[j] === ']') continue;
    }
    out += ch;
  }
  return out;
}

/** JSONC → 对象。失败时抛固定短标签（不含任何片段）。 */
export function parseJsonc(text) {
  const stripped = stripTrailingCommas(stripJsonComments(text.replace(/^\uFEFF/, '')));
  try {
    return JSON.parse(stripped);
  } catch {
    throw new Error('PRIVATE_JSONC_UNPARSABLE');
  }
}

// ---------------------------------------------------------------------------
// 3. 凭据装载（只在内存；诊断只出字段名与存在性）
// ---------------------------------------------------------------------------

/**
 * 装载私密 JSON（TC3 共享配对）与 `腾讯云.txt`（两个 BizType + ASR 专用配对）。
 *
 * 返回值里的 `env` 才是"凭据"；`diagnostics` 只有字段名/存在性/长度形态，
 * **绝不含值**。取不到时如实置空，由调用方把该类别记为「未取得（凭据结构不符）」。
 */
export function loadCredentialSources({ credentialsFile = null, tencentTxtFile = null, baseEnv = process.env } = {}) {
  const diagnostics = { credentialsFile: 'absent', credentialsFields: {}, tencentTxt: 'absent', bizTypeFields: {}, asrPairSource: 'none' };
  const env = {};
  for (const name of Object.values(CREDENTIAL_ENV_NAMES)) {
    if (typeof baseEnv[name] === 'string' && baseEnv[name].trim() !== '') env[name] = baseEnv[name];
  }

  if (credentialsFile !== null) {
    let parsed = null;
    try {
      parsed = parseJsonc(readFileSync(credentialsFile, 'utf8'));
      diagnostics.credentialsFile = 'parsed';
    } catch (error) {
      diagnostics.credentialsFile = error.message === 'PRIVATE_JSONC_UNPARSABLE' ? 'unparsable' : 'unreadable';
    }
    if (parsed !== null && typeof parsed === 'object') {
      for (const [field, variable] of Object.entries(CREDENTIAL_ENV_NAMES)) {
        const value = parsed[field];
        const present = typeof value === 'string' && value.trim() !== '';
        // 只登记"这个字段在不在"，不登记值、不登记前缀。
        diagnostics.credentialsFields[field] = present ? 'present' : 'missing';
        if (present && env[variable] === undefined) env[variable] = value;
      }
    }
  }

  const bizTypes = { tms: null, ims: null };
  let asrPair = null;
  if (tencentTxtFile !== null) {
    let text = null;
    try {
      text = readFileSync(tencentTxtFile, 'utf8');
      diagnostics.tencentTxt = 'parsed';
    } catch {
      diagnostics.tencentTxt = 'unreadable';
    }
    if (text !== null) {
      bizTypes.ims = findBizTypeValue(text, '图片');
      bizTypes.tms = findBizTypeValue(text, '文本');
      diagnostics.bizTypeFields = {
        ims: bizTypes.ims === null ? 'missing' : 'present',
        tms: bizTypes.tms === null ? 'missing' : 'present',
      };
      asrPair = findAsrPair(text);
    }
  }

  if (asrPair !== null) {
    env[CREDENTIAL_ENV_NAMES.tencentAsrSecretId] = asrPair.secretId;
    env[CREDENTIAL_ENV_NAMES.tencentAsrSecretKey] = asrPair.secretKey;
    diagnostics.asrPairSource = 'tencentTxt';
  } else if (env[CREDENTIAL_ENV_NAMES.tencentSecretId] !== undefined) {
    // 只在文件里没有专用配对时才回落到共享配对；回落事实写进诊断，不静默。
    diagnostics.asrPairSource = 'sharedPairFallback';
  }

  return { env, bizTypes, diagnostics };
}

/**
 * 从 `腾讯云.txt` 取某个 BizType（`label` 为 `图片` 或 `文本`）。
 * 支持两种形态：值在下一行的裸值、或 `图片BizType: VALUE` 同行。
 */
function findBizTypeValue(text, label) {
  const lines = text.split(/\r?\n/);
  // 标签的实际写法是 `图片biztype` / `文本biztype`（小写），因此大小写不敏感。
  const inline = new RegExp(`^\\s*${label}\\s*biztype\\s*[:：]\\s*(\\S+)\\s*$`, 'i');
  const bare = new RegExp(`^\\s*${label}\\s*biztype\\s*$`, 'i');
  for (let i = 0; i < lines.length; i += 1) {
    const sameLine = inline.exec(lines[i]);
    if (sameLine !== null) return BIZ_TYPE_PATTERN.test(sameLine[1]) ? sameLine[1] : null;
    if (bare.test(lines[i])) {
      for (let j = i + 1; j < lines.length; j += 1) {
        const candidate = lines[j].trim();
        if (candidate === '') continue;
        // 下一行若不是"裸值"而是另一个标签，说明这个标签没带值。
        if (/[:：]/.test(candidate)) return null;
        return BIZ_TYPE_PATTERN.test(candidate) ? candidate : null;
      }
    }
  }
  return null;
}

/** 从 `腾讯云.txt` 的 `API ASR` 段落取专用配对（`SecretId: ...` / `SecretKey: ...`）。 */
function findAsrPair(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.replace(/\s+/g, '').toUpperCase() === 'APIASR');
  const from = start === -1 ? 0 : start + 1;
  let secretId = null;
  let secretKey = null;
  for (let i = from; i < lines.length; i += 1) {
    const idMatch = /^\s*SecretId\s*[:：]\s*(\S+)\s*$/.exec(lines[i]);
    if (idMatch !== null && secretId === null) secretId = idMatch[1];
    const keyMatch = /^\s*SecretKey\s*[:：]\s*(\S+)\s*$/.exec(lines[i]);
    if (keyMatch !== null && secretKey === null) secretKey = keyMatch[1];
    if (secretId !== null && secretKey !== null) return { secretId, secretKey };
    // 走出 ASR 段就停（避免误取别的段落里的同名键）。
    if (start !== -1 && /^(轻量化服务器|微信云托管|云服务器)$/.test(lines[i].replace(/\s+/g, ''))) break;
  }
  return secretId !== null && secretKey !== null ? { secretId, secretKey } : null;
}

// ---------------------------------------------------------------------------
// 4. 凭据 -> 仅内存的三元组
// ---------------------------------------------------------------------------

function credentialTriple(env, idName, keyName, tokenName) {
  const secretId = env[idName];
  const secretKey = env[keyName];
  if (typeof secretId !== 'string' || secretId.trim() === '') return null;
  if (typeof secretKey !== 'string' || secretKey.trim() === '') return null;
  const token = env[tokenName];
  return Object.freeze({ secretId, secretKey, sessionToken: typeof token === 'string' ? token : '' });
}

// ---------------------------------------------------------------------------
// 5. 单次发送（零重试）
// ---------------------------------------------------------------------------

function signHeaders({ service, endpoint, action, apiVersion, body, credentials, timestampSeconds }) {
  if (service === 'tms' || service === 'ims') {
    // 复用 `live-tc3.ts` 的签名：按它的注入契约给 target（service/host 分开）。
    return signModerationTc3Request({
      target: { endpoint, service, host: `${service}.tencentcloudapi.com`, kind: 'production' },
      action,
      apiVersion,
      region: REGION,
      timestampSeconds,
      body,
      credentials,
    });
  }
  return signTc3Request({ endpoint, action, apiVersion, region: REGION, timestampSeconds, body, credentials });
}

/** 恰好一次发送。**永不抛错**：一切异常都落成可判别状态。 */
async function sendOnce({ service, endpoint, action, apiVersion, body, credentials, timeoutMs, fetchImpl, now }) {
  const startedAt = now();
  const headers = signHeaders({
    service,
    endpoint,
    action,
    apiVersion,
    body,
    credentials,
    timestampSeconds: Math.floor(startedAt / 1000),
  });
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      body,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = typeof error === 'object' && error !== null ? error.name : undefined;
    const timedOut = name === 'TimeoutError' || name === 'AbortError';
    return {
      state: timedOut ? 'TIMEOUT' : 'OUTCOME_UNKNOWN',
      httpStatus: null,
      payload: null,
      elapsedMs: now() - startedAt,
      sendAttempts: 1,
    };
  }
  const elapsedMs = now() - startedAt;
  if (!response.ok) {
    // 网关/传输层异常：不解析错误页正文（避免把 HTML 当供应商载荷）。
    return { state: 'HTTP_ERROR', httpStatus: response.status, payload: null, elapsedMs, sendAttempts: 1 };
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    return { state: 'OUTCOME_UNKNOWN', httpStatus: response.status, payload: null, elapsedMs, sendAttempts: 1 };
  }
  return { state: 'RECEIVED', httpStatus: response.status, payload, elapsedMs, sendAttempts: 1 };
}

/**
 * 取供应商 RequestId 用于取证对账。
 *
 * 两个口径并存：
 * - `requestId`：本函数自己用的**较宽**轨迹口径 `^[A-Za-z0-9-]{8,64}$`（证据页要能按它去控制台查单）；
 * - `requestIdMatchesAdapterPattern`：仓内三个适配器用的严格口径 `^[a-fA-F0-9-]{16,64}$` 的判定结果，
 *   用来如实说明"产品路径会不会接受这个 RequestId"。
 * 两种口径都只允许字母数字与连字符 ⇒ 供应商塞不进空格/引号/换行/中文。
 */
const TRACE_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

function readRequestId(response) {
  const raw = response?.RequestId;
  if (typeof raw !== 'string' || !TRACE_ID_PATTERN.test(raw)) return null;
  return raw;
}

function requestIdMatchesAdapterPattern(response) {
  const raw = response?.RequestId;
  return typeof raw === 'string' && REQUEST_ID_PATTERN.test(raw);
}

function readVendorErrorCode(response) {
  const raw = response?.Error?.Code;
  if (typeof raw !== 'string' || raw === '') return null;
  return /^[A-Za-z0-9.]{1,100}$/.test(raw) ? raw : 'UNRECOGNIZED_ERROR';
}

// ---------------------------------------------------------------------------
// 6. 五个类别的单次取证
// ---------------------------------------------------------------------------

function baseRecord(category, action, apiVersion, endpoint, startedAtIso) {
  return {
    category,
    action,
    apiVersion,
    region: REGION,
    endpoint,
    startedAt: startedAtIso,
    requestId: null,
    status: 'NOT_ATTEMPTED',
    httpStatus: null,
    sendAttempts: 0,
    elapsedMs: null,
    conclusion: null,
    errorCode: null,
    notObtainedReason: null,
  };
}

/** 统一把 `sendOnce` 的结局翻译成记录的 status / errorCode。 */
function applyTransportOutcome(record, outcome) {
  record.httpStatus = outcome.httpStatus;
  record.sendAttempts = outcome.sendAttempts;
  record.elapsedMs = outcome.elapsedMs;
  if (outcome.state === 'RECEIVED') return true;
  record.status = outcome.state;
  record.errorCode = outcome.state === 'TIMEOUT' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_OUTCOME_UNKNOWN';
  record.notObtainedReason = outcome.state === 'TIMEOUT' ? '请求超时' : '未取到可解析的供应商载荷';
  return false;
}

async function runTms({ text, category, credentials, bizType, timeoutMs, fetchImpl, now }) {
  const spec = AI_ENDPOINTS.moderationText;
  const record = baseRecord(category, spec.action, spec.version, spec.endpoint, new Date(now()).toISOString());
  if (credentials === null) {
    record.notObtainedReason = '未取得（凭据结构不符：缺 TENCENTCLOUD_SECRET_ID/KEY）';
    return record;
  }
  if (typeof bizType !== 'string' || !BIZ_TYPE_PATTERN.test(bizType)) {
    record.notObtainedReason = '未取得（凭据结构不符：私密文本里取不到符合 ^[A-Za-z0-9_-]{1,32}$ 的文本 BizType）';
    return record;
  }
  // 请求体与 `tools/ai-config.mjs:prepareOfflineRequest()` 的 moderationText 同形。
  const body = JSON.stringify({
    Content: Buffer.from(text, 'utf8').toString('base64'),
    BizType: bizType,
    Type: 'TEXT',
    SourceLanguage: 'zh',
  });
  const outcome = await sendOnce({
    service: 'tms',
    endpoint: spec.endpoint,
    action: spec.action,
    apiVersion: spec.version,
    body,
    credentials,
    timeoutMs,
    fetchImpl,
    now,
  });
  if (!applyTransportOutcome(record, outcome)) return record;

  const response = outcome.payload?.Response;
  if (response === null || typeof response !== 'object') {
    record.status = 'OUTCOME_UNKNOWN';
    record.errorCode = 'PROVIDER_OUTCOME_UNKNOWN';
    record.notObtainedReason = '供应商回报缺 Response';
    return record;
  }
  record.requestId = readRequestId(response);
  record.requestIdMatchesAdapterPattern = requestIdMatchesAdapterPattern(response);
  const vendorError = readVendorErrorCode(response);
  if (vendorError !== null) {
    record.status = 'SERVICE_ERROR';
    record.errorCode = vendorError;
    record.notObtainedReason = '供应商业务错误';
    return record;
  }
  // 结论由仓内唯一映射点给出（含控制字段旁路扫描；失败会抛 ModerationPortError）。
  try {
    const verdict = moderationVerdictFromVendorPayload({ payload: outcome.payload, httpStatus: outcome.httpStatus });
    record.status = 'BUSINESS_RESPONSE';
    record.conclusion = { label: verdict.label, reasonCodes: [...verdict.reason_codes] };
  } catch (error) {
    record.status = 'PORT_ERROR';
    record.errorCode = error?.provider_error_code ?? error?.model_failure ?? 'PORT_ERROR';
    record.notObtainedReason = '供应商回报未能映射到闭集结论';
    return record;
  }
  const suggestion = typeof response.Suggestion === 'string' ? response.Suggestion : null;
  const label = typeof response.Label === 'string' && response.Label !== '' ? response.Label : null;
  const score = typeof response.Score === 'number' && Number.isFinite(response.Score) ? response.Score : null;
  record.suggestion = suggestion;
  record.label = label;
  record.score = score;
  return record;
}

async function runIms({ imageBytes, credentials, bizType, timeoutMs, fetchImpl, now }) {
  const spec = AI_ENDPOINTS.moderationImage;
  const record = baseRecord('ims', spec.action, spec.version, spec.endpoint, new Date(now()).toISOString());
  if (credentials === null) {
    record.notObtainedReason = '未取得（凭据结构不符：缺 TENCENTCLOUD_SECRET_ID/KEY）';
    return record;
  }
  if (typeof bizType !== 'string' || !BIZ_TYPE_PATTERN.test(bizType)) {
    record.notObtainedReason = '未取得（凭据结构不符：私密文本里取不到符合 ^[A-Za-z0-9_-]{1,32}$ 的图片 BizType）';
    return record;
  }
  let bytes;
  try {
    bytes = requireModerationImageBytes(imageBytes, 2097152);
  } catch {
    record.notObtainedReason = '未取得（本地 fail-closed：合成样张缺失或头部不是 PNG/JPEG）';
    return record;
  }
  record.imageBytes = bytes.length;
  record.imageSha256 = createHash('sha256').update(bytes).digest('hex');
  const body = JSON.stringify({ FileContent: Buffer.from(bytes).toString('base64'), BizType: bizType });
  const outcome = await sendOnce({
    service: 'ims',
    endpoint: spec.endpoint,
    action: spec.action,
    apiVersion: spec.version,
    body,
    credentials,
    timeoutMs,
    fetchImpl,
    now,
  });
  if (!applyTransportOutcome(record, outcome)) return record;

  const response = outcome.payload?.Response;
  if (response === null || typeof response !== 'object') {
    record.status = 'OUTCOME_UNKNOWN';
    record.errorCode = 'PROVIDER_OUTCOME_UNKNOWN';
    record.notObtainedReason = '供应商回报缺 Response';
    return record;
  }
  record.requestId = readRequestId(response);
  record.requestIdMatchesAdapterPattern = requestIdMatchesAdapterPattern(response);
  const vendorError = readVendorErrorCode(response);
  if (vendorError !== null) {
    record.status = 'SERVICE_ERROR';
    record.errorCode = vendorError;
    record.notObtainedReason = '供应商业务错误';
    return record;
  }
  try {
    const sample = imageSampleFromVendorPayload({ payload: outcome.payload, httpStatus: outcome.httpStatus });
    const verdict = moderationVerdictFromImageSamples([sample]);
    record.status = 'BUSINESS_RESPONSE';
    record.conclusion = { label: verdict.label, reasonCodes: [...verdict.reason_codes] };
    record.suggestion = sample.suggestion;
    record.label = sample.labelToken;
    record.score = sample.score;
  } catch (error) {
    record.status = 'PORT_ERROR';
    record.errorCode = error?.provider_error_code ?? error?.model_failure ?? 'PORT_ERROR';
    record.notObtainedReason = '供应商回报未能映射到闭集结论';
  }
  return record;
}

async function runOcr({ imageBytes, credentials, timeoutMs, fetchImpl, now }) {
  const spec = AI_ENDPOINTS.ocr;
  const record = baseRecord('ocr', spec.action, spec.version, spec.endpoint, new Date(now()).toISOString());
  if (credentials === null) {
    record.notObtainedReason = '未取得（凭据结构不符：缺 TENCENTCLOUD_SECRET_ID/KEY）';
    return record;
  }
  let bytes;
  try {
    bytes = requireLiveOcrImage(imageBytes, LIVE_OCR_FROZEN_PROFILE.maxImageBytes);
  } catch {
    record.notObtainedReason = '未取得（本地 fail-closed：合成样张缺失或头部不是 PNG/JPEG）';
    return record;
  }
  record.imageBytes = bytes.length;
  record.imageSha256 = createHash('sha256').update(bytes).digest('hex');
  const body = JSON.stringify({ ImageBase64: Buffer.from(bytes).toString('base64') });
  const outcome = await sendOnce({
    service: 'ocr',
    endpoint: spec.endpoint,
    action: spec.action,
    apiVersion: spec.version,
    body,
    credentials,
    timeoutMs,
    fetchImpl,
    now,
  });
  if (!applyTransportOutcome(record, outcome)) return record;

  const response = outcome.payload?.Response;
  if (response === null || typeof response !== 'object') {
    record.status = 'OUTCOME_UNKNOWN';
    record.errorCode = 'PROVIDER_OUTCOME_UNKNOWN';
    record.notObtainedReason = '供应商回报缺 Response';
    return record;
  }
  record.requestId = readRequestId(response);
  record.requestIdMatchesAdapterPattern = requestIdMatchesAdapterPattern(response);
  const vendorError = readVendorErrorCode(response);
  if (vendorError !== null) {
    record.status = 'SERVICE_ERROR';
    record.errorCode = vendorError;
    record.notObtainedReason = '供应商业务错误';
    return record;
  }
  const detections = Array.isArray(response.TextDetections) ? response.TextDetections : null;
  if (detections === null) {
    record.status = 'RESPONSE_EVIDENCE_INCOMPLETE';
    record.errorCode = 'PROVIDER_OUTCOME_UNKNOWN';
    record.notObtainedReason = '回报里没有 TextDetections 数组';
    return record;
  }
  const lines = [];
  const confidences = [];
  for (const item of detections) {
    const text = typeof item?.DetectedText === 'string' ? item.DetectedText.trim() : '';
    if (text !== '') lines.push(text);
    // `Confidence` 为 0..100 的整数百分比；非数值一律不计入区间。
    if (typeof item?.Confidence === 'number' && Number.isFinite(item.Confidence)) confidences.push(item.Confidence);
  }
  record.status = 'BUSINESS_RESPONSE';
  record.detectionCount = lines.length;
  record.detectedText = lines.join('\n');
  record.confidenceMin = confidences.length === 0 ? null : Math.min(...confidences);
  record.confidenceMax = confidences.length === 0 ? null : Math.max(...confidences);
  record.conclusion = {
    label: lines.length > 0 ? 'recognized' : 'no_text_detected',
    reasonCodes: [],
  };
  return record;
}

async function runTts({ text, credentials, timeoutMs, fetchImpl, now }) {
  const spec = AI_ENDPOINTS.tts;
  const record = baseRecord('tts', spec.action, spec.version, spec.endpoint, new Date(now()).toISOString());
  if (credentials === null) {
    record.notObtainedReason = '未取得（凭据结构不符：缺 TENCENTCLOUD_SECRET_ID/KEY）';
    return record;
  }
  // 与 `tts/provider.ts` 的 payload 同形，仅 `Codec` 改为 `wav`：
  // 官方参数页写明「Codec 可取值 wav（默认）、mp3、pcm」，而 ASR 环回要求 16k/单声道/16bit WAV。
  const sessionId = `gy34-evidence-${createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)}`;
  const body = JSON.stringify({
    Text: text,
    SessionId: sessionId,
    ModelType: 1,
    PrimaryLanguage: 1,
    VoiceType: 101001,
    SampleRate: 16000,
    Codec: 'wav',
    Speed: 0,
    Volume: 0,
  });
  record.codec = 'wav';
  record.requestedTextCharacters = [...text].length;
  const outcome = await sendOnce({
    service: 'tts',
    endpoint: spec.endpoint,
    action: spec.action,
    apiVersion: spec.version,
    body,
    credentials,
    timeoutMs,
    fetchImpl,
    now,
  });
  if (!applyTransportOutcome(record, outcome)) return record;

  const response = outcome.payload?.Response;
  if (response === null || typeof response !== 'object') {
    record.status = 'OUTCOME_UNKNOWN';
    record.errorCode = 'PROVIDER_OUTCOME_UNKNOWN';
    record.notObtainedReason = '供应商回报缺 Response';
    return record;
  }
  record.requestId = readRequestId(response);
  record.requestIdMatchesAdapterPattern = requestIdMatchesAdapterPattern(response);
  const vendorError = readVendorErrorCode(response);
  if (vendorError !== null) {
    record.status = 'SERVICE_ERROR';
    record.errorCode = vendorError;
    record.notObtainedReason = '供应商业务错误';
    return record;
  }
  const audioBase64 = response.Audio;
  if (typeof audioBase64 !== 'string' || audioBase64 === '') {
    record.status = 'RESPONSE_EVIDENCE_INCOMPLETE';
    record.errorCode = 'PROVIDER_OUTCOME_UNKNOWN';
    record.notObtainedReason = '回报里没有 Audio 字段';
    return record;
  }
  const audio = Buffer.from(audioBase64, 'base64');
  record.status = 'BUSINESS_RESPONSE';
  record.audioBytes = audio.length;
  record.audioSha256 = createHash('sha256').update(audio).digest('hex');
  record.sessionEchoOk = response.SessionId === sessionId;
  record.conclusion = { label: 'audio_received', reasonCodes: [] };
  // 音频字节**不落库**：只留在内存里交给 ASR 环回，函数返回后由 GC 回收。
  record.audioInline = audio;
  return record;
}

async function runAsr({ wav, credentials, timeoutMs, fetchImpl, now, notAttemptedReason }) {
  const spec = AI_ENDPOINTS.asr;
  const record = baseRecord('asr', spec.action, spec.version, spec.endpoint, new Date(now()).toISOString());
  if (wav === null) {
    record.notObtainedReason = notAttemptedReason ?? '未取得（无合规 WAV 输入）';
    return record;
  }
  if (credentials === null) {
    record.notObtainedReason = '未取得（凭据结构不符：缺 TENCENTCLOUD_ASR_SECRET_ID/KEY）';
    return record;
  }
  let bytes;
  try {
    // 与产品路径同一份音频剖面校验（16k / 单声道 / 16bit PCM / ≤60s / base64 后 ≤3 MiB）。
    bytes = requireLiveAsrWav(wav, LIVE_ASR_FROZEN_PROFILE).bytes;
  } catch {
    record.notObtainedReason = '未取得（音频不满足 16k/单声道/16bit WAV 剖面，不裁剪、不转码）';
    return record;
  }
  record.audioBytes = bytes.length;
  record.audioDurationMs = requireLiveAsrWav(bytes, LIVE_ASR_FROZEN_PROFILE).durationMs;
  record.audioSha256 = createHash('sha256').update(bytes).digest('hex');
  const payload = {
    ProjectId: 0,
    SubServiceType: 2,
    EngSerViceType: '16k_zh',
    SourceType: 1,
    VoiceFormat: 'wav',
    Data: Buffer.from(bytes).toString('base64'),
    DataLen: bytes.length,
    UsrAudioKey: `gy34-${createHash('sha256').update(Buffer.from(bytes).toString('base64')).digest('hex').slice(0, 24)}`,
  };
  const body = JSON.stringify(payload);
  const outcome = await sendOnce({
    service: 'asr',
    endpoint: spec.endpoint,
    action: spec.action,
    apiVersion: spec.version,
    body,
    credentials,
    timeoutMs,
    fetchImpl,
    now,
  });
  if (!applyTransportOutcome(record, outcome)) return record;

  const response = outcome.payload?.Response;
  if (response === null || typeof response !== 'object') {
    record.status = 'OUTCOME_UNKNOWN';
    record.errorCode = 'PROVIDER_OUTCOME_UNKNOWN';
    record.notObtainedReason = '供应商回报缺 Response';
    return record;
  }
  record.requestId = readRequestId(response);
  record.requestIdMatchesAdapterPattern = requestIdMatchesAdapterPattern(response);
  const vendorError = readVendorErrorCode(response);
  if (vendorError !== null) {
    record.status = 'SERVICE_ERROR';
    record.errorCode = vendorError;
    record.notObtainedReason = '供应商业务错误';
    return record;
  }
  if (typeof response.Result !== 'string') {
    record.status = 'RESPONSE_EVIDENCE_INCOMPLETE';
    record.errorCode = 'PROVIDER_OUTCOME_UNKNOWN';
    record.notObtainedReason = '回报里没有 Result 字段';
    return record;
  }
  record.status = 'BUSINESS_RESPONSE';
  record.transcript = response.Result.trim();
  record.transcriptCharacters = [...record.transcript].length;
  record.providerAudioDurationMs =
    typeof response.AudioDuration === 'number' && Number.isFinite(response.AudioDuration) ? response.AudioDuration : null;
  record.conclusion = {
    label: record.transcript === '' ? 'empty_transcript' : 'transcribed',
    reasonCodes: [],
  };
  return record;
}

// ---------------------------------------------------------------------------
// 7. 编排：一次运行、每类至多一次
// ---------------------------------------------------------------------------

/**
 * 跑完五类取证。
 *
 * `limits` 只是"再声明一次"的护栏：计数器在每次发送前 +1，越界直接 throw，
 * 确保没有人把它改成循环重试。
 */
export async function runEvidenceSamples(options) {
  const {
    env,
    bizTypes = { tms: null, ims: null },
    imageBytes = null,
    texts = DEFAULT_TEXTS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    limits = CALL_LIMITS,
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
  } = options;

  const used = { tms: 0, ims: 0, ocr: 0, tts: 0, asr: 0 };
  const charge = (category) => {
    used[category] += 1;
    if (used[category] > limits[category]) {
      throw new Error(`CALL_LIMIT_EXCEEDED:${category}（上限 ${limits[category]} 次，零重试）`);
    }
  };

  const sharedPair = credentialTriple(
    env,
    CREDENTIAL_ENV_NAMES.tencentSecretId,
    CREDENTIAL_ENV_NAMES.tencentSecretKey,
    CREDENTIAL_ENV_NAMES.tencentSessionToken,
  );
  const asrPair = credentialTriple(
    env,
    CREDENTIAL_ENV_NAMES.tencentAsrSecretId,
    CREDENTIAL_ENV_NAMES.tencentAsrSecretKey,
    CREDENTIAL_ENV_NAMES.tencentAsrSessionToken,
  );

  const calls = {};

  // ① TMS 正常文本
  charge('tms');
  calls.tmsNormal = await runTms({
    text: texts.tmsNormal,
    category: 'tms_normal',
    credentials: sharedPair,
    bizType: bizTypes.tms,
    timeoutMs,
    fetchImpl,
    now,
  });
  calls.tmsNormal.inputKind = '合成文本（农事说明，非个人数据）';

  // ② TMS 受控违规文本（明显的假联系方式，绝不写真实号码）
  charge('tms');
  calls.tmsControlledViolation = await runTms({
    text: texts.tmsControlledViolation,
    category: 'tms_controlled_violation',
    credentials: sharedPair,
    bizType: bizTypes.tms,
    timeoutMs,
    fetchImpl,
    now,
  });
  calls.tmsControlledViolation.inputKind = '合成文本（含明显假的联系方式，受控违规样本）';

  // ③ IMS 合成图
  charge('ims');
  calls.ims = await runIms({
    imageBytes,
    credentials: sharedPair,
    bizType: bizTypes.ims,
    timeoutMs,
    fetchImpl,
    now,
  });

  // ④ OCR 同一张合成图
  charge('ocr');
  calls.ocr = await runOcr({ imageBytes, credentials: sharedPair, timeoutMs, fetchImpl, now });

  // ⑤ TTS 合成一段播报
  charge('tts');
  calls.tts = await runTts({ text: texts.tts, credentials: sharedPair, timeoutMs, fetchImpl, now });

  // ⑥ ASR：只有在 TTS 产出**合规 16k/单声道/16bit WAV** 时才发；否则如实记"未取得"，不伪造。
  let asrInput = null;
  let asrSkipReason = null;
  if (calls.tts.status !== 'BUSINESS_RESPONSE' || !calls.tts.audioInline) {
    asrSkipReason = '未取得（TTS 未产出音频，无可喂给 ASR 的输入）';
  } else {
    try {
      requireLiveAsrWav(calls.tts.audioInline, LIVE_ASR_FROZEN_PROFILE);
      asrInput = calls.tts.audioInline;
    } catch {
      asrSkipReason = '未取得（无解码器：TTS 产物不是 16k/单声道/16bit WAV，不做转码、不伪造）';
    }
  }
  if (asrInput === null) {
    calls.asr = baseRecord('asr', AI_ENDPOINTS.asr.action, AI_ENDPOINTS.asr.version, AI_ENDPOINTS.asr.endpoint, new Date(now()).toISOString());
    calls.asr.notObtainedReason = asrSkipReason;
  } else {
    charge('asr');
    calls.asr = await runAsr({ wav: asrInput, credentials: asrPair ?? sharedPair, timeoutMs, fetchImpl, now });
    calls.asr.inputKind = 'TTS 环回产物（同一段音频，未落库）';
  }

  // 音频字节绝不出内存：从返回对象里摘掉。
  for (const record of Object.values(calls)) delete record.audioInline;

  return { calls, used };
}

// ---------------------------------------------------------------------------
// 8. 报告组装 + 脱敏自检
// ---------------------------------------------------------------------------

/** 费用估算：只对**真的拿到业务响应**的调用计数，单价取仓内预留口径（不是账单）。 */
export function estimateReserveCostCny(calls) {
  const unit = LIVE_UNIT_PRICES_CNY;
  const rows = [
    { category: 'tts', unitCny: unit.tts, charged: calls.tts?.status === 'BUSINESS_RESPONSE' },
    { category: 'ocr', unitCny: unit.ocr, charged: calls.ocr?.status === 'BUSINESS_RESPONSE' },
    { category: 'asr', unitCny: unit.asr, charged: calls.asr?.status === 'BUSINESS_RESPONSE' },
  ];
  let total = 0;
  for (const row of rows) if (row.charged) total += row.unitCny;
  return {
    unitPriceSource: 'services/api/src/ai/live-gate.ts:LIVE_UNIT_PRICES_CNY（仓内预算预留单价，非账单）',
    tts: rows[0].charged ? rows[0].unitCny : 0,
    ocr: rows[1].charged ? rows[1].unitCny : 0,
    asr: rows[2].charged ? rows[2].unitCny : 0,
    tms: null,
    ims: null,
    tmsImsNote: '仓内无预留单价；TMS/IMS 的真实计费以控制台账单为准，本次**未取得账单**（不猜数字）。',
    reservePriceTotalCny: Number(total.toFixed(4)),
    bill: null,
  };
}

/** 脱敏自检：序列化结果里不得出现任何凭据值、BizType 值或数据库连接串。 */
export function assertNoSecretLeak(serialized, secrets) {
  for (const [name, value] of secrets) {
    if (typeof value === 'string' && value.length >= 8 && serialized.includes(value)) {
      throw new Error(`REDACTION_FAILED:${name}`);
    }
  }
  return true;
}

export function buildReport({ calls, used, diagnostics, startedAt, finishedAt, gitHead }) {
  const notObtained = [];
  for (const record of Object.values(calls)) {
    if (record.status !== 'BUSINESS_RESPONSE') {
      notObtained.push({
        category: record.category,
        status: record.status,
        requestId: record.requestId ?? null,
        errorCode: record.errorCode ?? null,
        reason: record.notObtainedReason ?? '未取得（原因未记录）',
      });
    }
  }
  return {
    tool: 'tools/evidence/tencent-ai-samples.mjs',
    scope: 'tencent_ai_supplier_connectivity_and_policy_evidence_only',
    notAProductAcceptance: true,
    note: '这是供应商连通性与策略证据，不等于产品能力验收；一次可达性调用不构成样本，也不构成任何准确率结论。',
    gitHead,
    startedAt,
    finishedAt,
    credentialDiagnostics: diagnostics,
    calls,
    notObtained,
    budget: { limits: CALL_LIMITS, used },
    cost: estimateReserveCostCny(calls),
    selfCheck: {
      containsCredentialValue: false,
      imageBytesPersisted: false,
      audioBytesPersisted: false,
      rawVendorPayloadPersisted: false,
    },
  };
}

// ---------------------------------------------------------------------------
// 9. 自检：环境变量名与 ai-config.mjs 的 ENV_FIELDS 一致
// ---------------------------------------------------------------------------

/** 从 `tools/ai-config.mjs` 源码文本里取 `ENV_FIELDS` 的变量名集合，与本文件声明比对。 */
export function assertEnvNamesMatchAiConfig(aiConfigSource) {
  const block = /const ENV_FIELDS = Object\.freeze\(\{([\s\S]*?)\}\);/.exec(aiConfigSource);
  if (block === null) throw new Error('AI_CONFIG_ENV_FIELDS_NOT_FOUND');
  const names = new Set([...block[1].matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map((match) => match[1]));
  for (const name of Object.values(CREDENTIAL_ENV_NAMES)) {
    if (!names.has(name)) throw new Error(`ENV_FIELD_DRIFT:${name}`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// 10. CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    privateEnv: null,
    tencentTxt: null,
    image: null,
    out: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    gitHead: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--private-env') args.privateEnv = value;
    else if (flag === '--tencent-txt') args.tencentTxt = value;
    else if (flag === '--image') args.image = value;
    else if (flag === '--out') args.out = value;
    else if (flag === '--git-head') args.gitHead = value;
    else if (flag === '--timeout-ms') args.timeoutMs = Number(value);
    else if (flag === '--help') args.help = true;
    else if (!flag.startsWith('--')) continue;
    else throw new Error(`UNKNOWN_ARGUMENT:${flag}`);
    if (flag !== '--help') i += 1;
  }
  return args;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log('usage: node tools/evidence/tencent-ai-samples.mjs --private-env <file> --tencent-txt <file> --image <png> --out <json>');
    return 0;
  }
  // 变量名漂移自检（只读本地源码，零网络）。
  assertEnvNamesMatchAiConfig(readFileSync(new URL('../ai-config.mjs', import.meta.url), 'utf8'));

  const { env, bizTypes, diagnostics } = loadCredentialSources({
    credentialsFile: args.privateEnv,
    tencentTxtFile: args.tencentTxt,
  });

  let imageBytes = null;
  if (args.image !== null) {
    try {
      imageBytes = readFileSync(args.image);
    } catch {
      imageBytes = null;
    }
  }

  const startedAt = new Date().toISOString();
  const { calls, used } = await runEvidenceSamples({
    env,
    bizTypes,
    imageBytes,
    timeoutMs: args.timeoutMs,
  });
  const finishedAt = new Date().toISOString();

  const report = buildReport({ calls, used, diagnostics, startedAt, finishedAt, gitHead: args.gitHead });

  // 自检：报告里不得出现任何凭据值或 BizType 值。
  const secrets = [
    ['TENCENTCLOUD_SECRET_ID', env[CREDENTIAL_ENV_NAMES.tencentSecretId]],
    ['TENCENTCLOUD_SECRET_KEY', env[CREDENTIAL_ENV_NAMES.tencentSecretKey]],
    ['TENCENTCLOUD_SESSION_TOKEN', env[CREDENTIAL_ENV_NAMES.tencentSessionToken]],
    ['TENCENTCLOUD_ASR_SECRET_ID', env[CREDENTIAL_ENV_NAMES.tencentAsrSecretId]],
    ['TENCENTCLOUD_ASR_SECRET_KEY', env[CREDENTIAL_ENV_NAMES.tencentAsrSecretKey]],
    ['TMS_BIZTYPE', bizTypes.tms],
    ['IMS_BIZTYPE', bizTypes.ims],
  ];
  const serialized = JSON.stringify(report, null, 2);
  assertNoSecretLeak(serialized, secrets);
  report.selfCheck.containsCredentialValue = false;

  const text = JSON.stringify(report, null, 2);
  if (args.out !== null) writeFileSync(args.out, text, 'utf8');
  console.log(text);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      // 只打印固定标签/短码；不含任何响应正文或凭据。
      console.error(`EVIDENCE_RUN_FAILED:${error?.message ?? 'unknown'}`);
      process.exit(1);
    },
  );
}
