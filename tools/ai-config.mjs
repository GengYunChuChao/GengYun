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
  try { data = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch (_) { fail('PRIVATE_FILE_UNAVAILABLE'); }
  if (!data || data.appid !== 'wx4407a4b908a69a54') fail('PRIVATE_ACCOUNT_MISMATCH');
  const env = { ...baseEnv };
  for (const [field, variable] of Object.entries(ENV_FIELDS)) if (validText(data[field])) env[variable] = data[field];
  return env; // Never log or serialize this object. Caller owns its in-memory lifetime.
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
