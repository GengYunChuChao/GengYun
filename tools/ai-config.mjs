// Server-side configuration and offline request preparation only. No network executor.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const AI_ENDPOINTS = Object.freeze({
  weedRecognition: { group: 'weedRecognition', endpoint: 'https://tokenhub.tencentmaas.com/v1/chat/completions', auth: 'Bearer', model: 'hy-vision-2.0-instruct', keyEnv: 'TOKENHUB_API_KEY' },
  ocr: { group: 'ocr', endpoint: 'https://ocr.tencentcloudapi.com', auth: 'TC3-HMAC-SHA256', action: 'GeneralAccurateOCR', version: '2018-11-19', sdk: 'ocr', sdkVersion: '4.1.322' },
  asr: { group: 'asr', endpoint: 'https://asr.tencentcloudapi.com', auth: 'TC3-HMAC-SHA256', action: 'SentenceRecognition', version: '2019-06-14', sdk: 'asr', sdkVersion: '4.1.315' },
  tts: { group: 'tts', endpoint: 'https://tts.tencentcloudapi.com', auth: 'TC3-HMAC-SHA256', action: 'TextToVoice', version: '2019-08-23', sdk: 'tts', sdkVersion: '4.1.237' },
  llm: { group: 'llm', endpoint: 'https://api.deepseek.com/chat/completions', auth: 'Bearer', model: 'deepseek-flash', keyEnv: 'DEEPSEEK_API_KEY' },
  moderationText: { group: 'moderation', endpoint: 'https://tms.tencentcloudapi.com', auth: 'TC3-HMAC-SHA256', action: 'TextModeration', version: '2020-12-29', sdk: 'tms', sdkVersion: '4.1.311' },
  moderationImage: { group: 'moderation', endpoint: 'https://ims.tencentcloudapi.com', auth: 'TC3-HMAC-SHA256', action: 'ImageModeration', version: '2020-12-29', sdk: 'ims', sdkVersion: '4.1.321' }
});
const ENV_FIELDS = Object.freeze({ appsecret: 'WECHAT_APP_SECRET', deepseekApiKey: 'DEEPSEEK_API_KEY', tencentSecretId: 'TENCENTCLOUD_SECRET_ID', tencentSecretKey: 'TENCENTCLOUD_SECRET_KEY', tencentAsrSecretId: 'TENCENTCLOUD_ASR_SECRET_ID', tencentAsrSecretKey: 'TENCENTCLOUD_ASR_SECRET_KEY', tencentAsrSessionToken: 'TENCENTCLOUD_ASR_SESSION_TOKEN', tencentSessionToken: 'TENCENTCLOUD_SESSION_TOKEN', tokenhubApiKey: 'TOKENHUB_API_KEY', databaseUrl: 'GENGYUN_DATABASE_URL' });
const validText = value => typeof value === 'string' && Boolean(value.trim());
const fail = code => { throw new Error(code); };

export function loadPrivateEnvironment(file, baseEnv = {}) {
  let data;
  try { data = parseJsonc(readFileSync(file, 'utf8')); } catch (_) { fail('PRIVATE_FILE_UNAVAILABLE'); }
  if (!data || data.appid !== 'wx4407a4b908a69a54') fail('PRIVATE_ACCOUNT_MISMATCH');
  const env = { ...baseEnv };
  for (const [field, variable] of PRIVATE_ENV_PAIRS) if (validText(data[field])) env[variable] = data[field];
  return Object.defineProperty(applyChatProviderDefaults(env), 'missingFields', { value: MISSING_REQUIRED_FIELDS, enumerable: false, writable: false }); // Never log or serialize this object. Caller owns its in-memory lifetime.
}
export function providerFor(config, key) {
  const spec = AI_ENDPOINTS[key];
  if (!spec) fail('UNKNOWN_CAPABILITY');
  const parent = config?.providers?.[spec.group];
  return key === 'moderationImage' ? { ...parent, ...parent?.image } : parent;
}
export function configurationIssues(config, key) {
  const spec = AI_ENDPOINTS[key];
  if (!spec) return ['UNKNOWN_CAPABILITY'];
  const p = providerFor(config, key), errors = [];
  const check = (ok, code) => { if (!ok) errors.push(code); };
  check(!p || !['apiKey', 'secretKey', 'secretId', 'token', 'appsecret'].some(field => Object.hasOwn(p, field)), 'INLINE_SECRET_FORBIDDEN');
  check(config?.env === 'dev', 'DEV_ENV_REQUIRED');
  check(config?.privacy?.allowUserDataForTraining === false && config?.privacy?.sendRealUserDataBeforeConsent === false, 'PRIVACY_DECLARATION_REQUIRED');
  check(p?.endpoint === spec.endpoint, 'ENDPOINT_NOT_ALLOWLISTED');
  check(p?.authentication === spec.auth, 'AUTHENTICATION_MISMATCH');
  check(Number.isInteger(p?.timeoutMs) && p.timeoutMs >= 1000 && p.timeoutMs <= 20000, 'INVALID_TIMEOUT');
  check(p?.maxRetries === 0, 'AUTOMATIC_RETRIES_DISABLED_REQUIRED');
  check(p?.maxVerificationCalls === 2, 'INVALID_PLANNED_CALL_LIMIT');
  if (spec.sdk) {
    check(p?.action === spec.action && p?.apiVersion === spec.version, 'API_ACTION_OR_VERSION_MISMATCH');
    check((p?.apiKeyEnv === 'TENCENTCLOUD_SECRET_KEY' && p?.secretIdEnv === 'TENCENTCLOUD_SECRET_ID') || (key === 'asr' && p?.apiKeyEnv === 'TENCENTCLOUD_ASR_SECRET_KEY' && p?.secretIdEnv === 'TENCENTCLOUD_ASR_SECRET_ID'), 'TC3_CREDENTIAL_NAMES_REQUIRED');
    check(p?.sdkVersion === spec.sdkVersion, 'SDK_VERSION_NOT_PINNED');
    check(p?.region === 'ap-shanghai', 'REGION_MISMATCH');
  } else {
    check(p?.model === spec.model, 'MODEL_NOT_ALLOWLISTED');
    check(p?.apiKeyEnv === spec.keyEnv, 'BEARER_CREDENTIAL_NAME_MISMATCH');
    check(p?.maxOutputTokens === 128 && p?.stream === false, 'UNBOUNDED_OUTPUT');
    if (key === 'llm') check(p?.thinking === 'disabled', 'THINKING_MUST_BE_DISABLED');
  }
  if (['weedRecognition', 'ocr', 'moderationImage'].includes(key)) check(p?.maxImageBytes === 2097152 && p?.mediaTransport === 'inlineBase64', 'IMAGE_LIMIT_OR_TRANSPORT_MISMATCH');
  if (key === 'asr') check(p?.model === '16k_zh' && p?.voiceFormat === 'wav' && p?.sampleRate === 16000 && p?.channels === 1 && p?.maxAudioSeconds === 60 && p?.maxAudioBase64Bytes === 3145728, 'AUDIO_PROFILE_MISMATCH');
  if (key === 'tts') check(p?.voiceType === 101001 && p?.codec === 'mp3' && p?.sampleRate === 16000 && p?.maxTextCharacters === 100, 'VOICE_PROFILE_MISMATCH');
  if (key.startsWith('moderation')) check(validText(p?.bizType) && /^[A-Za-z0-9_-]{1,32}$/.test(p.bizType), 'MISSING_OR_INVALID_BIZTYPE');
  return errors;
}
export function auditAIConfiguration(config, env = {}) {
  const endpoints = {};
  for (const [key, spec] of Object.entries(AI_ENDPOINTS)) {
    const p = providerFor(config, key), issues = configurationIssues(config, key);
    const credentialPresent = spec.sdk ? validText(env[p?.secretIdEnv]) && validText(env[p?.apiKeyEnv]) : validText(env[spec.keyEnv]);
    endpoints[key] = { parameterConfigurationComplete: issues.length === 0, credentialPresent, issues,
      authenticationVerifiedThisRun: false, serviceActivationVerified: false, quotaVerified: false, capabilityVerified: false,
      policySelectionVerified: key.startsWith('moderation') ? false : undefined, executionAllowed: false };
  }
  const budgetLocked = config?.budget?.liveInferenceAllowed === false && config?.budget?.maxVerificationCalls === 0 && config?.budget?.maximumCharge === 0;
  return { scope: 'offline_ai_configuration_only', categories: 6, endpointCount: 7, budgetLocked, taskVerified: false, executionAllowed: false, endpoints };
}
function imageInfo(image) {
  if (!Buffer.isBuffer(image) || image.length === 0 || image.length > 2097152) fail('IMAGE_SIZE_OR_TYPE_INVALID');
  if (image.length >= 24 && image.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && image.toString('ascii', 12, 16) === 'IHDR' && image.readUInt32BE(16) > 0 && image.readUInt32BE(20) > 0) return 'image/png';
  if (image.length >= 4 && image[0] === 255 && image[1] === 216 && image[2] === 255 && image[image.length - 2] === 255 && image[image.length - 1] === 217) return 'image/jpeg';
  fail('IMAGE_HEADER_INVALID'); // Header check only; not a full decoder, EXIF stripper or media permission check.
}
function checkedWav(wav) {
  if (!Buffer.isBuffer(wav) || wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE' || wav.readUInt32LE(4) + 8 !== wav.length) fail('WAV_INVALID');
  if (4 * Math.ceil(wav.length / 3) > 3145728) fail('AUDIO_BASE64_TOO_LARGE');
  let fmt, dataLength, offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4), length = wav.readUInt32LE(offset + 4), start = offset + 8;
    if (start + length > wav.length) fail('WAV_INVALID');
    if (id === 'fmt ') { if (fmt || length < 16) fail('WAV_INVALID'); fmt = wav.subarray(start, start + length); }
    if (id === 'data') { if (dataLength !== undefined) fail('WAV_INVALID'); dataLength = length; }
    offset = start + length + (length % 2);
  }
  if (offset !== wav.length || !fmt || !dataLength || dataLength % 2 || fmt.readUInt16LE(0) !== 1 || fmt.readUInt16LE(2) !== 1 || fmt.readUInt32LE(4) !== 16000 || fmt.readUInt32LE(8) !== 32000 || fmt.readUInt16LE(12) !== 2 || fmt.readUInt16LE(14) !== 16) fail('WAV_PROFILE_INVALID');
  if (dataLength / 32000 > 60) fail('AUDIO_DURATION_EXCEEDED');
  return dataLength / 32000;
}
function textInput(input, maxCharacters) {
  if (!validText(input?.text) || Array.from(input.text).length > maxCharacters) fail('TEXT_SIZE_OR_TYPE_INVALID');
  return input.text;
}
export function prepareOfflineRequest(config, key, input) {
  const issues = configurationIssues(config, key);
  if (issues.length) fail(issues[0]);
  const spec = AI_ENDPOINTS[key], p = providerFor(config, key);
  let body;
  if (key === 'weedRecognition') {
    const mime = imageInfo(input?.image), text = textInput(input, 200);
    body = { model: p.model, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + input.image.toString('base64') } }, { type: 'text', text }] }], max_tokens: 128, stream: false };
  } else if (key === 'ocr') { imageInfo(input?.image); body = { ImageBase64: input.image.toString('base64') }; }
  else if (key === 'asr') {
    checkedWav(input?.wav);
    body = { ProjectId: 0, SubServiceType: 2, EngSerViceType: '16k_zh', SourceType: 1, VoiceFormat: 'wav', Data: input.wav.toString('base64'), DataLen: input.wav.length, UsrAudioKey: 'gy25-' + createHash('sha256').update(input.wav).digest('hex').slice(0, 24) };
  } else if (key === 'tts') body = { Text: textInput(input, 100), SessionId: 'gy25-offline', ModelType: 1, VoiceType: 101001, PrimaryLanguage: 1, SampleRate: 16000, Codec: 'mp3', Speed: 0, Volume: 0 };
  else if (key === 'llm') body = { model: p.model, messages: [{ role: 'user', content: textInput(input, 200) }], max_tokens: 128, stream: false, thinking: { type: 'disabled' } };
  else if (key === 'moderationText') body = { Content: Buffer.from(textInput(input, 200), 'utf8').toString('base64'), BizType: p.bizType, Type: 'TEXT', SourceLanguage: 'zh' };
  else { imageInfo(input?.image); body = { FileContent: input.image.toString('base64'), BizType: p.bizType }; }
  return { key, endpoint: spec.endpoint, action: spec.action, apiVersion: spec.version, authentication: spec.auth, timeoutMs: p.timeoutMs, maxRetries: 0, executionAllowed: false, body };
}
export function describeOfflineRequest(request) {
  // Never include body values, sample data, headers, credentials, signatures or identity in reports.
  return { key: request.key, authentication: request.authentication, timeoutMs: request.timeoutMs, maxRetries: request.maxRetries, executionAllowed: false, requestFields: Object.keys(request.body), encodedBodyBytes: Buffer.byteLength(JSON.stringify(request.body)), mode: 'OFFLINE_PREPARED' };
}

// ── 私密凭据文件的 JSONC 解析与真实模式映射缺口 ──────────────────────────────
// 刻意追加在文件末尾、不前插：`docs/verification/*` 用 `tools/ai-config.mjs:10/14/43/57/69/91/115`
// 这类行号引用本文；前插会让它们整体漂移，而 `verify-doc-anchors` 只判结构、不判语义，漂移不会报红。

// 真实模式（`services/api/src/config.ts` 的 `REQUIRED_WHEN_REAL`）需要、但 `ENV_FIELDS` 原先漏掉的映射。
// 既有变量名一个都不动：`databaseUrl` 继续导出 `GENGYUN_DATABASE_URL`（`docs/verification/config.example.json`
// 与运维流程按此名读取），这里只是**追加** `DATABASE_URL`；`appid` 原先只校验、不导出，这里追加 `WECHAT_APP_ID`。
// 用「字段 → 变量名」的**有序对**而不是对象合并：一个字段可以映射出多个变量名，对象字面量的同名键会互相覆盖。
// 末尾六条补齐真实模式必需、而私密 JSON 的字段名从未登记过的项：`SESSION_SIGNING_KEY` / `DELETION_LEDGER_KEY`
// 与对象存储四键此前只能靠真实环境变量提供，`missingFields` 因此长期非空。
const EXTRA_ENV_PAIRS = Object.freeze([
  ['appid', 'WECHAT_APP_ID'], ['databaseUrl', 'DATABASE_URL'],
  ['sessionSigningKey', 'SESSION_SIGNING_KEY'], ['deletionLedgerKey', 'DELETION_LEDGER_KEY'],
  ['objectStorageEndpoint', 'OBJECT_STORAGE_ENDPOINT'], ['objectStorageBucket', 'OBJECT_STORAGE_BUCKET'],
  ['objectStorageAccessKey', 'OBJECT_STORAGE_ACCESS_KEY'], ['objectStorageSecretKey', 'OBJECT_STORAGE_SECRET_KEY'],
]);
// 唯一的「字段 → 变量名」映射表。导出只为让测试**从模块派生** `mapped`，而不是在测试里手抄一份名单：
// 手抄的名单会和实现分叉，那正是「stays in step」守卫单向漏检的同一类毛病。
export const PRIVATE_ENV_PAIRS = Object.freeze([...Object.entries(ENV_FIELDS), ...EXTRA_ENV_PAIRS]);
/** 已映射的环境变量名（去重、保序）；只含名字，绝不含值。 */
export const MAPPED_ENV_NAMES = Object.freeze([...new Set(PRIVATE_ENV_PAIRS.map(([, variable]) => variable))]);

// `REQUIRED_WHEN_REAL` 的**仓内镜像**（只抄名字，绝不含值；顺序与 `services/api/src/config.ts` 一致）。
// 同步不靠人记：`tests/ai-config.test.mjs` 逐项比对两边，任一边增删都会红。
export const REQUIRED_WHEN_REAL_FIELDS = Object.freeze([
  'DATABASE_URL', 'SESSION_SIGNING_KEY', 'DELETION_LEDGER_KEY', 'WECHAT_APP_ID', 'WECHAT_APP_SECRET',
  'OBJECT_STORAGE_ENDPOINT', 'OBJECT_STORAGE_BUCKET', 'OBJECT_STORAGE_ACCESS_KEY', 'OBJECT_STORAGE_SECRET_KEY',
]);

// **派生**而非手写死名单：必需项里没有私密文件映射来源的变量名 = 必需项 ∖ 已映射变量名。
// 六条补齐后它自然是 0 项；将来加一条映射就自动少一项、删一条映射就自动多一项。
// 手写名单做不到这点：加了映射却忘删同名项时，同一个名字会同时躺在「能映射」和「无法映射」两侧。
// 注意语义是「这份文件**映射不到**的必需项」，不是「本次文件恰好没写」的清单；**只列名，绝不含值**。
export const MISSING_REQUIRED_FIELDS = Object.freeze(REQUIRED_WHEN_REAL_FIELDS.filter(name => !MAPPED_ENV_NAMES.includes(name)));

/**
 * 「mapped 与 missingFields 必须踩准 REQUIRED_WHEN_REAL」的**双向**守卫：
 * `(mapped ∩ required) ∪ missing === required` **且** `mapped ∩ missing === ∅`。
 * 只查并集是单向的——新增映射却漏删 `missingFields` 同名项时并集仍相等、守卫仍绿，
 * 而同一变量名同时出现在两侧，自相矛盾。返回问题码数组（空数组才是一致），纯函数、不读文件、不含任何值。
 * 映射表还带着 `DEEPSEEK_API_KEY` 这类不在 `REQUIRED_WHEN_REAL` 里的凭据名（按能力单独校验），
 * 所以只在 `required` 这一侧取交集比较，不要求 `mapped ⊆ required`。
 */
export function envMappingIssues({ mapped = MAPPED_ENV_NAMES, missing = MISSING_REQUIRED_FIELDS, required = REQUIRED_WHEN_REAL_FIELDS } = {}) {
  const mappedSet = new Set(mapped), missingSet = new Set(missing), requiredSet = new Set(required);
  const issues = [];
  for (const name of missingSet) if (!requiredSet.has(name)) issues.push('MISSING_NOT_REQUIRED:' + name);
  for (const name of requiredSet) if (!mappedSet.has(name) && !missingSet.has(name)) issues.push('UNACCOUNTED:' + name);
  for (const name of mappedSet) if (missingSet.has(name)) issues.push('MAPPED_AND_MISSING:' + name);
  return issues;
}

// 逐字符扫描：字符串内的 `//`、`/*` 与尾逗号都不是结构。`escaped` 让 `\"` 不结束字符串
// （`"a\\" // b"` 里的 `//` 仍属字符串），这是「字符串里的 `//` 不能被误删」的关键。
function stripComments(source) {
  let out = '', inString = false, escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') { inString = true; out += char; }
    else if (char === '/' && source[index + 1] === '/') {
      while (index + 1 < source.length && source[index + 1] !== '\n' && source[index + 1] !== '\r') index += 1;
    } else if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      if (end === -1) fail('PRIVATE_FILE_UNAVAILABLE'); // 未闭合块注释按解析失败处理，不吞成半截对象
      out += source.slice(index, end + 2).replace(/[^\r\n]/g, ' ');
      index = end + 1;
    } else out += char;
  }
  return out;
}

// 去掉对象/数组收尾前的逗号；同样跳过字符串内容（字符串里的 `,` 不是结构）。
function stripTrailingCommas(source) {
  let out = '', inString = false, escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') { inString = true; out += char; }
    else if (char === ',') {
      let next = index + 1;
      while (next < source.length && /\s/.test(source[next])) next += 1;
      if (source[next] !== '}' && source[next] !== ']') out += char;
    } else out += char;
  }
  return out;
}

/**
 * JSONC（行注释、块注释、尾逗号）→ JS 值，其余按严格 JSON 处理；只删结构、不改值，返回只读用途的纯数据。
 * 失败统一抛 `PRIVATE_FILE_UNAVAILABLE`：`JSON.parse` 的异常消息会回显原文片段，绝不允许外泄。
 */
export function parseJsonc(text) {
  if (typeof text !== 'string') fail('PRIVATE_FILE_UNAVAILABLE');
  const source = text.replace(/^\uFEFF/, '');
  try { return JSON.parse(stripTrailingCommas(stripComments(source))); } catch (_) { fail('PRIVATE_FILE_UNAVAILABLE'); }
}

// ── `deepseekApiKey` 之后 `CHAT_LLM_*` 的两个公开默认值 ────────────────────────────
// `services/api/src/config.ts` 的 `asChatProvider()` 把 `DEEPSEEK_API_KEY` 当作 `CHAT_LLM_API_KEY`
// 的替代（`apiKeyFallback`）：私密文件一旦提供 `deepseekApiKey`，`CHAT_LLM_ENDPOINT` 与
// `CHAT_LLM_MODEL` 就升级为「有 key 则必须有」的必需项，缺任一即抛 `ConfigError`，real 模式直接起不来。
// 这两个值是**公开的**（端点与模型名都不是秘密），且早已登记在 `AI_ENDPOINTS.llm` 白名单里，
// 所以默认值从那张表取、不另造第二份常量：改白名单即改默认值，两处不可能分叉。
// 仍然**只补默认、不覆盖**：调用方显式给的 `CHAT_LLM_ENDPOINT` / `CHAT_LLM_MODEL` 一个字符都不改。
export const CHAT_LLM_DEFAULT_ENV = Object.freeze({
  CHAT_LLM_ENDPOINT: AI_ENDPOINTS.llm.endpoint,
  CHAT_LLM_MODEL: AI_ENDPOINTS.llm.model,
});

/**
 * 原地补齐 `CHAT_LLM_*` 的公开默认值，返回同一个对象（由 `loadPrivateEnvironment()` 在返回前调用）。
 * 生效条件：已经拿到 chat 的 key（显式 `CHAT_LLM_API_KEY` 或私密文件的 `deepseekApiKey`）。
 * 没有 key 时一个都不补——`asChatProvider()` 会返回 `null`，凭空补上端点只会把「没配 LLM」
 * 误判成「配错了 LLM」。优先级：显式环境变量 > 私密文件 `deepseekApiKey` > 本默认值。
 */
export function applyChatProviderDefaults(env = {}) {
  if (!validText(env.CHAT_LLM_API_KEY) && !validText(env.DEEPSEEK_API_KEY)) return env;
  for (const [name, value] of Object.entries(CHAT_LLM_DEFAULT_ENV)) if (!validText(env[name])) env[name] = value;
  return env;
}

/** 真实模式必需项在给定 env 里为空/未设的**变量名**（只列名，绝不返回值）。 */
export function missingRealModeEnv(env = {}) {
  return REQUIRED_WHEN_REAL_FIELDS.filter(name => !validText(env[name]));
}

/**
 * real 模式起服务前的缺口闸门：缺项时报 `MISSING_REAL_MODE_ENV:<逗号分隔的变量名>`。
 * 文案刻意只带变量名——报错会进日志与工单，塞进任何一个值都等于泄密。
 */
export function assertRealModeEnv(env = {}) {
  const missing = missingRealModeEnv(env);
  if (missing.length > 0) fail('MISSING_REAL_MODE_ENV:' + missing.join(','));
  return env;
}
