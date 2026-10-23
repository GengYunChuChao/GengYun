import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AI_ENDPOINTS, auditAIConfiguration, loadPrivateEnvironment, parseJsonc, prepareOfflineRequest, describeOfflineRequest,
  PRIVATE_ENV_PAIRS, MAPPED_ENV_NAMES, REQUIRED_WHEN_REAL_FIELDS, MISSING_REQUIRED_FIELDS, envMappingIssues,
  CHAT_LLM_DEFAULT_ENV, applyChatProviderDefaults, missingRealModeEnv, assertRealModeEnv,
} from '../tools/ai-config.mjs';
const example = JSON.parse(readFileSync(new URL('../docs/verification/config.example.json', import.meta.url), 'utf8'));
const fixture = () => { const config = structuredClone(example); config.providers.moderation.bizType = 'synthetic_text'; config.providers.moderation.image.bizType = 'synthetic_image'; return config; };
const env = { TOKENHUB_API_KEY: 'synthetic-tokenhub-secret', DEEPSEEK_API_KEY: 'synthetic-deepseek-secret', TENCENTCLOUD_SECRET_ID: 'synthetic-id', TENCENTCLOUD_SECRET_KEY: 'synthetic-tencent-secret' };
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l2kAAAAASUVORK5CYII=', 'base64');
function wav(seconds = 1) {
  const dataLength = seconds * 32000, result = Buffer.alloc(44 + dataLength);
  result.write('RIFF'); result.writeUInt32LE(result.length - 8, 4); result.write('WAVEfmt ', 8); result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20); result.writeUInt16LE(1, 22); result.writeUInt32LE(16000, 24); result.writeUInt32LE(32000, 28); result.writeUInt16LE(2, 32); result.writeUInt16LE(16, 34); result.write('data', 36); result.writeUInt32LE(dataLength, 40);
  return result;
}
test('seven endpoints of six categories compile offline without secrets or execution', () => {
  const original = globalThis.fetch; globalThis.fetch = () => { throw new Error('NETWORK_FORBIDDEN'); };
  try {
    const config = fixture(), report = auditAIConfiguration(config, env);
    assert.equal(report.categories, 6); assert.equal(report.endpointCount, 7); assert.equal(report.budgetLocked, true);
    for (const [key, row] of Object.entries(report.endpoints)) {
      assert.equal(row.parameterConfigurationComplete, true, key); assert.equal(row.credentialPresent, true); assert.equal(row.executionAllowed, false); assert.equal(row.capabilityVerified, false);
      const request = prepareOfflineRequest(config, key, { image, wav: wav(), text: '合成非个人验证文本' });
      assert.equal(request.endpoint, AI_ENDPOINTS[key].endpoint); assert.equal(request.maxRetries, 0); assert.equal(request.executionAllowed, false);
      const summary = describeOfflineRequest(request); assert.equal(summary.mode, 'OFFLINE_PREPARED'); assert.equal(summary.executionAllowed, false);
      for (const value of ['合成非个人验证文本', image.toString('base64'), ...Object.values(env)]) assert.equal(JSON.stringify(summary).includes(value), false);
    }
    for (const value of Object.values(env)) assert.equal(JSON.stringify(report).includes(value), false);
  } finally { globalThis.fetch = original; }
});
test('real example preserves missing TokenHub key and both BizTypes as blockers', () => {
  const report = auditAIConfiguration(example, { ...env, TOKENHUB_API_KEY: '' });
  assert.equal(report.endpoints.weedRecognition.credentialPresent, false);
  for (const key of ['moderationText', 'moderationImage']) { assert.equal(report.endpoints[key].parameterConfigurationComplete, false); assert.ok(report.endpoints[key].issues.includes('MISSING_OR_INVALID_BIZTYPE')); }
  assert.equal(report.executionAllowed, false);
});
test('ASR-only TC3 credentials are selected explicitly without falling back to the shared pair', () => {
  const config=fixture();config.providers.asr.secretIdEnv='TENCENTCLOUD_ASR_SECRET_ID';config.providers.asr.apiKeyEnv='TENCENTCLOUD_ASR_SECRET_KEY';
  assert.equal(auditAIConfiguration(config,env).endpoints.asr.credentialPresent,false);
  const separate={...env,TENCENTCLOUD_ASR_SECRET_ID:'synthetic-asr-id',TENCENTCLOUD_ASR_SECRET_KEY:'synthetic-asr-key'};
  assert.equal(auditAIConfiguration(config,separate).endpoints.asr.credentialPresent,true);assert.equal(auditAIConfiguration(config,separate).endpoints.ocr.credentialPresent,true);
  assert.equal(prepareOfflineRequest(config,'asr',{wav:wav()}).body.EngSerViceType,'16k_zh');
  config.providers.ocr.apiKeyEnv='TENCENTCLOUD_ASR_SECRET_KEY';assert.throws(()=>prepareOfflineRequest(config,'ocr',{image}),/TC3_CREDENTIAL_NAMES_REQUIRED/);
});
test('endpoint credential exfiltration, old vision API, model substitution and automatic retries are rejected', () => {
  for (const endpoint of ['http://tokenhub.tencentmaas.com/v1/chat/completions', 'https://attacker.invalid', 'https://tokenhub.tencentmaas.com/v1/chat/completions?secret=synthetic', 'https://hunyuan.ai.tencentcloudapi.com']) {
    const config = fixture(); config.providers.weedRecognition.endpoint = endpoint;
    assert.throws(() => prepareOfflineRequest(config, 'weedRecognition', { image, text: 'synthetic' }), /ENDPOINT_NOT_ALLOWLISTED/);
  }
  const model = fixture(); model.providers.weedRecognition.model = 'deepseek-v4-pro';
  assert.throws(() => prepareOfflineRequest(model, 'weedRecognition', { image, text: 'synthetic' }), /MODEL_NOT_ALLOWLISTED/);
  const secret = fixture(); secret.providers.llm.apiKey = 'synthetic-private';
  assert.throws(() => prepareOfflineRequest(secret, 'llm', { text: 'synthetic' }), /INLINE_SECRET_FORBIDDEN/);
  const retry = fixture(); retry.providers.ocr.maxRetries = 1;
  assert.throws(() => prepareOfflineRequest(retry, 'ocr', { image }), /AUTOMATIC_RETRIES_DISABLED_REQUIRED/);
  const unsafe = fixture(); unsafe.budget.liveInferenceAllowed = true;
  assert.equal(auditAIConfiguration(unsafe, env).budgetLocked, false); assert.equal(auditAIConfiguration(unsafe, env).executionAllowed, false);
});
test('media and text constraints reject URL-only, oversized, wrong WAV and overlong input before dispatch', () => {
  const config = fixture();
  assert.throws(() => prepareOfflineRequest(config, 'ocr', { imageUrl: 'https://attacker.invalid/media' }), /IMAGE_SIZE_OR_TYPE_INVALID/);
  assert.throws(() => prepareOfflineRequest(config, 'ocr', { image: Buffer.alloc(2097153) }), /IMAGE_SIZE_OR_TYPE_INVALID/);
  assert.throws(() => prepareOfflineRequest(config, 'moderationImage', { image: Buffer.from('not-image') }), /IMAGE_HEADER_INVALID/);
  assert.throws(() => prepareOfflineRequest(config, 'asr', { wav: wav(61) }), /AUDIO_DURATION_EXCEEDED/);
  assert.throws(() => prepareOfflineRequest(config, 'asr', { wav: wav(74) }), /AUDIO_BASE64_TOO_LARGE/);
  const stereo = wav(); stereo.writeUInt16LE(2, 22);
  assert.throws(() => prepareOfflineRequest(config, 'asr', { wav: stereo }), /WAV_PROFILE_INVALID/);
  assert.throws(() => prepareOfflineRequest(config, 'tts', { text: '字'.repeat(101) }), /TEXT_SIZE_OR_TYPE_INVALID/);
  assert.throws(() => prepareOfflineRequest(config, 'llm', { text: '字'.repeat(201) }), /TEXT_SIZE_OR_TYPE_INVALID/);
  assert.throws(() => prepareOfflineRequest(config, 'UNKNOWN', {}), /UNKNOWN_CAPABILITY/);
});
test('ASR length is decoded bytes, TMS is UTF8 base64, images stay inline, output bounds remain explicit', () => {
  const config = fixture(), audio = wav();
  config.providers.moderation.bizType = 'synthetic-text'; config.providers.moderation.image.bizType = 'x';
  assert.equal(auditAIConfiguration(config, env).endpoints.moderationImage.parameterConfigurationComplete, true);
  const asr = prepareOfflineRequest(config, 'asr', { wav: audio });
  assert.equal(asr.body.DataLen, audio.length); assert.equal(asr.body.Data, audio.toString('base64')); assert.equal(asr.body.SourceType, 1);
  const tms = prepareOfflineRequest(config, 'moderationText', { text: '合成样例' }); assert.equal(Buffer.from(tms.body.Content, 'base64').toString('utf8'), '合成样例'); assert.equal(tms.body.Type, 'TEXT');
  const llm = prepareOfflineRequest(config, 'llm', { text: '合成样例' }); assert.equal(llm.body.max_tokens, 128); assert.deepEqual(llm.body.thinking, { type: 'disabled' });
  const vision = prepareOfflineRequest(config, 'weedRecognition', { text: '合成样例', image }); assert.ok(vision.body.messages[0].content[0].image_url.url.startsWith('data:image/png;base64,'));
});
test('private loading uses explicit account and allowlisted fields, suppressing raw JSON errors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gy25-ai-'));
  try {
    const file = join(dir, 'synthetic.json'); writeFileSync(file, '{"secret":"sensitive-malformed');
    assert.throws(() => loadPrivateEnvironment(file), /^Error: PRIVATE_FILE_UNAVAILABLE$/);
    writeFileSync(file, JSON.stringify({ appid: 'wrong', tokenhubApiKey: 'synthetic-key' })); assert.throws(() => loadPrivateEnvironment(file), /PRIVATE_ACCOUNT_MISMATCH/);
    writeFileSync(file, JSON.stringify({ appid: 'wx4407a4b908a69a54', tokenhubApiKey: 'synthetic-tokenhub', tencentSessionToken: 'synthetic-session', tencentAsrSessionToken: 'synthetic-asr-session', unexpectedSecret: 'ignore-me' }));
    const loaded = loadPrivateEnvironment(file); assert.equal(loaded.TOKENHUB_API_KEY, 'synthetic-tokenhub'); assert.equal(loaded.TENCENTCLOUD_SESSION_TOKEN, 'synthetic-session'); assert.equal(loaded.TENCENTCLOUD_ASR_SESSION_TOKEN, 'synthetic-asr-session'); assert.equal(loaded.unexpectedSecret, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
// 以下 JSONC 用例全部用**合成字符串**：不读、不引用任何真实凭据文件。
const SYNTHETIC_APPID = 'wx4407a4b908a69a54';
const SYNTHETIC_JSONC = [
  '{',
  '  // 整行注释：JSONC 允许注释，严格 JSON 解析会整体失败',
  '  "appid": "' + SYNTHETIC_APPID + '",',
  '  "databaseUrl": "postgres://synthetic-synthetic@db.invalid:5432/synthetic?sslmode=require", // 行尾注释',
  '  "deepseekApiKey": "synthetic-deepseek",',
  '  "sessionSigningKey": "synthetic-session-signing-key",',
  '  "deletionLedgerKey": "synthetic-deletion-ledger-key",',
  '  "objectStorageEndpoint": "https://cos.ap-shanghai.myqcloud.invalid",',
  '  "objectStorageBucket": "synthetic-bucket-1250000000",',
  '  "objectStorageAccessKey": "synthetic-oss-access-key",',
  '  "objectStorageSecretKey": "synthetic-oss-secret-key",',
  '  "callbackUrl": "https://example.invalid//double-slash-in-string",',
  '  "escaped": "quote \\" then // still inside a string",',
  '  /* 块注释：',
  '     "tokenhubApiKey" 这一行被注释掉，不应出现 */',
  '  "tokenhubApiKey": "synthetic-tokenhub",',
  '  "nested": { "a": [1, 2, 3,], },',
  '}',
].join('\n');
test('JSONC parser removes line/block comments and trailing commas without touching string content', () => {
  const value = parseJsonc(SYNTHETIC_JSONC);
  assert.equal(value.appid, SYNTHETIC_APPID);
  assert.equal(value.databaseUrl, 'postgres://synthetic-synthetic@db.invalid:5432/synthetic?sslmode=require');
  assert.equal(value.callbackUrl, 'https://example.invalid//double-slash-in-string');
  assert.equal(value.escaped, 'quote " then // still inside a string');
  assert.equal(value.tokenhubApiKey, 'synthetic-tokenhub');
  assert.deepEqual(value.nested, { a: [1, 2, 3] });
  assert.deepEqual(parseJsonc('{"s":"a,] ,} // c"}'), { s: 'a,] ,} // c' });
  assert.deepEqual(parseJsonc('\uFEFF{"bom":true}'), { bom: true });
  assert.deepEqual(parseJsonc('{\r\n  "crlf": 1, // x\r\n}'), { crlf: 1 });
  assert.deepEqual(parseJsonc('{"keep":"\\/\\/ not a comment"}'), { keep: '// not a comment' });
});
test('JSONC parse failures stay controlled, name the code only and never echo content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gy25-jsonc-'));
  try {
    const file = join(dir, 'synthetic.jsonc');
    writeFileSync(file, '{"appid": "' + SYNTHETIC_APPID + '", "deepseekApiKey": "synthetic-leak-marker" "x": 1}');
    assert.throws(() => loadPrivateEnvironment(file), (error) => error.message === 'PRIVATE_FILE_UNAVAILABLE' && error.message.includes('synthetic-leak-marker') === false);
    writeFileSync(file, '{"appid": "' + SYNTHETIC_APPID + '", /* 未闭合块注释');
    assert.throws(() => loadPrivateEnvironment(file), /^Error: PRIVATE_FILE_UNAVAILABLE$/);
    assert.throws(() => loadPrivateEnvironment(join(dir, 'absent.jsonc')), /^Error: PRIVATE_FILE_UNAVAILABLE$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('mapping table appends the six real-mode fields without renaming any existing variable', () => {
  const variablesFor = field => PRIVATE_ENV_PAIRS.filter(([name]) => name === field).map(([, variable]) => variable);
  // 既有映射一个都不改：`databaseUrl` 仍先出旧名 `GENGYUN_DATABASE_URL`，新名只是追加。
  assert.deepEqual(variablesFor('databaseUrl'), ['GENGYUN_DATABASE_URL', 'DATABASE_URL']);
  assert.deepEqual(variablesFor('appsecret'), ['WECHAT_APP_SECRET']);
  assert.deepEqual(variablesFor('tokenhubApiKey'), ['TOKENHUB_API_KEY']);
  assert.deepEqual(variablesFor('tencentAsrSessionToken'), ['TENCENTCLOUD_ASR_SESSION_TOKEN']);
  assert.deepEqual(variablesFor('appid'), ['WECHAT_APP_ID']);
  // 六条新增映射：JSON 字段名 → 真实模式环境变量名，逐条钉住。
  const appended = [
    ['sessionSigningKey', 'SESSION_SIGNING_KEY'],
    ['deletionLedgerKey', 'DELETION_LEDGER_KEY'],
    ['objectStorageEndpoint', 'OBJECT_STORAGE_ENDPOINT'],
    ['objectStorageBucket', 'OBJECT_STORAGE_BUCKET'],
    ['objectStorageAccessKey', 'OBJECT_STORAGE_ACCESS_KEY'],
    ['objectStorageSecretKey', 'OBJECT_STORAGE_SECRET_KEY'],
  ];
  for (const [field, variable] of appended) assert.deepEqual(variablesFor(field), [variable]);
  for (const name of MAPPED_ENV_NAMES) assert.match(name, /^[A-Z][A-Z0-9_]*$/);
  // 补齐六条后没有「私密文件映射不到」的必需项：missingFields 派生结果为 0 项。
  assert.deepEqual([...MISSING_REQUIRED_FIELDS], []);
});
test('JSONC private file maps appid/databaseUrl plus six real-mode fields additively and settles missingFields at zero', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gy25-jsonc-'));
  try {
    const file = join(dir, 'synthetic.jsonc'); writeFileSync(file, SYNTHETIC_JSONC);
    const loaded = loadPrivateEnvironment(file, { PATH: 'synthetic-path' });
    assert.equal(loaded.PATH, 'synthetic-path');
    assert.equal(loaded.WECHAT_APP_ID, SYNTHETIC_APPID);
    assert.equal(loaded.DATABASE_URL, 'postgres://synthetic-synthetic@db.invalid:5432/synthetic?sslmode=require');
    assert.equal(loaded.GENGYUN_DATABASE_URL, loaded.DATABASE_URL);
    assert.equal(loaded.DEEPSEEK_API_KEY, 'synthetic-deepseek');
    // 六条新映射：合成 JSONC 里的值真的落到了真实模式读的那个变量名上。
    assert.equal(loaded.SESSION_SIGNING_KEY, 'synthetic-session-signing-key');
    assert.equal(loaded.DELETION_LEDGER_KEY, 'synthetic-deletion-ledger-key');
    assert.equal(loaded.OBJECT_STORAGE_ENDPOINT, 'https://cos.ap-shanghai.myqcloud.invalid');
    assert.equal(loaded.OBJECT_STORAGE_BUCKET, 'synthetic-bucket-1250000000');
    assert.equal(loaded.OBJECT_STORAGE_ACCESS_KEY, 'synthetic-oss-access-key');
    assert.equal(loaded.OBJECT_STORAGE_SECRET_KEY, 'synthetic-oss-secret-key');
    // 六条补齐后没有「私密文件映射不到」的必需项。
    assert.deepEqual(loaded.missingFields, []);
    assert.ok(Object.isFrozen(loaded.missingFields));
    assert.equal(Object.getOwnPropertyDescriptor(loaded, 'missingFields').writable, false);
    assert.equal(Object.keys(loaded).includes('missingFields'), false);
    assert.equal(Object.keys(loaded).includes('sessionSigningKey'), false); // 只导出变量名，不回显 JSON 字段名
    writeFileSync(file, '{ "appid": "wx0000000000000000", // 账号不符\n "x": 1, }');
    assert.throws(() => loadPrivateEnvironment(file), /PRIVATE_ACCOUNT_MISMATCH/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('mapped and missingFields stay in step with REQUIRED_WHEN_REAL in both directions', () => {
  const source = readFileSync(new URL('../services/api/src/config.ts', import.meta.url), 'utf8');
  const body = source.match(/export const REQUIRED_WHEN_REAL = \[([\s\S]*?)\] as const;/);
  assert.ok(body, 'REQUIRED_WHEN_REAL 形状变了：同步本测试与 tools/ai-config.mjs 的 REQUIRED_WHEN_REAL_FIELDS');
  const required = [...body[1].matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map(match => match[1]);
  // 模块镜像必须与 config.ts 同序同名，否则下面所有比较都建在假地基上。
  assert.deepEqual([...REQUIRED_WHEN_REAL_FIELDS], required);
  // `mapped` 从模块派生，不再在测试里手抄名单。
  const mapped = [...MAPPED_ENV_NAMES];
  assert.deepEqual([...new Set(mapped)], mapped);
  const dir = mkdtempSync(join(tmpdir(), 'gy25-jsonc-'));
  try {
    const file = join(dir, 'synthetic.jsonc'); writeFileSync(file, SYNTHETIC_JSONC);
    const missing = [...loadPrivateEnvironment(file).missingFields];
    // 映射表还带 `DEEPSEEK_API_KEY` 这类必需项之外的凭据名，故只在 required 一侧取交集。
    const mappedRequired = mapped.filter(name => required.includes(name));
    // 方向一：`(mapped ∩ required) ∪ missing` 覆盖 REQUIRED_WHEN_REAL（旧守卫只有这一半）。
    assert.deepEqual([...new Set([...mappedRequired, ...missing])].sort(), [...required].sort());
    // 方向二：交集为空——同一变量名不得既「可映射」又「无法映射」。
    assert.deepEqual(mapped.filter(name => missing.includes(name)), []);
    // 生产守卫与测试共用同一实现，对真实数据零问题。
    assert.deepEqual(envMappingIssues({ mapped, missing, required }), []);
    assert.deepEqual(envMappingIssues(), []);
    // 六条补齐后每一项必需值都真的有映射来源（missingFields 为空时，这就是「全覆盖」）。
    assert.deepEqual(required.filter(name => !mapped.includes(name)), []);
    // 派生式 MISSING_REQUIRED_FIELDS 就是「必需项 ∖ 已映射」，不是手写死名单。
    assert.deepEqual([...MISSING_REQUIRED_FIELDS], REQUIRED_WHEN_REAL_FIELDS.filter(name => !mapped.includes(name)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('two-sided guard rejects a mapping added without pruning missingFields even though the union check stays green', () => {
  // 测试内构造，不改生产语义：模拟「新增 BETA_KEY 映射，却忘了从 missingFields 删掉同名项」。
  const required = ['ALPHA_KEY', 'BETA_KEY'];
  const mapped = ['ALPHA_KEY', 'BETA_KEY'];
  const staleMissing = ['BETA_KEY'];
  // 单向（只查并集）看不出问题：这正是上一轮漏检的那个洞。
  assert.deepEqual([...new Set([...mapped, ...staleMissing])].sort(), [...required].sort());
  // 双向守卫必须点名「同名项同时躺在两侧」。
  assert.deepEqual(envMappingIssues({ mapped, missing: staleMissing, required }), ['MAPPED_AND_MISSING:BETA_KEY']);
  // 反向缺口同样要点名：必需项两边都没有 → UNACCOUNTED；missing 里混入非必需项 → MISSING_NOT_REQUIRED。
  assert.deepEqual(envMappingIssues({ mapped: ['ALPHA_KEY'], missing: [], required }), ['UNACCOUNTED:BETA_KEY']);
  assert.deepEqual(envMappingIssues({ mapped, missing: ['GAMMA_KEY'], required }), ['MISSING_NOT_REQUIRED:GAMMA_KEY']);
  // 空问题数组只属于真正一致的三元组。
  assert.deepEqual(envMappingIssues({ mapped: ['ALPHA_KEY'], missing: ['BETA_KEY'], required }), []);
});

// ── real 模式起服务：私密文件 13 键全映射、9 项前置、只含字段名的报错、默认值与优先级 ──────────
// 以下全部是合成值：不读、不引用任何真实凭据文件；断言只比对合成标记，不把任何值写进输出。
const PRIVATE_DOC_KEYS = Object.freeze([
  'appid', 'appsecret', 'deepseekApiKey', 'tencentSecretId', 'tencentSecretKey', 'tokenhubApiKey', 'databaseUrl',
  'sessionSigningKey', 'deletionLedgerKey',
  'objectStorageEndpoint', 'objectStorageBucket', 'objectStorageAccessKey', 'objectStorageSecretKey',
]);
// 映射表里另有 4 个可选字段：私密文件不写就不导出，写了也不参与真实模式判定。
const PRIVATE_OPTIONAL_KEYS = Object.freeze(['tencentAsrSecretId', 'tencentAsrSecretKey', 'tencentAsrSessionToken', 'tencentSessionToken']);
const syntheticPrivate = (extra = {}) => {
  const data = { appid: SYNTHETIC_APPID };
  for (const key of PRIVATE_DOC_KEYS) if (key !== 'appid') data[key] = 'synthetic-' + key + '-value';
  return { ...data, ...extra };
};
// 17 键版（13 个真有键的 + 4 个可选）：只为逐对验证映射，不代表真实文件里一定有那 4 个。
const syntheticFull = () => syntheticPrivate(Object.fromEntries(PRIVATE_OPTIONAL_KEYS.map(key => [key, 'synthetic-' + key + '-value'])));
const withPrivateFile = (data, run) => {
  const dir = mkdtempSync(join(tmpdir(), 'gy25-real-'));
  try { const file = join(dir, 'synthetic.json'); writeFileSync(file, JSON.stringify(data)); return run(file); }
  finally { rmSync(dir, { recursive: true, force: true }); }
};
test('all thirteen documented private keys map to allowlisted variable names, none to zero', () => {
  const unique = [...new Set(PRIVATE_ENV_PAIRS.map(([field]) => field))];
  // 13 键逐一有映射：漏一个，real 模式就得靠外部脚本逐对补环境变量。
  assert.deepEqual(PRIVATE_DOC_KEYS.filter(key => !unique.includes(key)), []);
  // 表内字段名恰好是「13 个真有键的 + 4 个可选」：多一个少一个都要同步改这里与文档。
  assert.deepEqual([...unique].sort(), [...PRIVATE_DOC_KEYS, ...PRIVATE_OPTIONAL_KEYS].sort());
  // 只有 databaseUrl 一个字段出两个变量名（旧名保留、新名追加），其余一对一。
  assert.deepEqual(PRIVATE_ENV_PAIRS.filter(([field]) => field === 'databaseUrl').map(([, variable]) => variable), ['GENGYUN_DATABASE_URL', 'DATABASE_URL']);
  assert.equal(PRIVATE_ENV_PAIRS.length, unique.length + 1);
  for (const name of MAPPED_ENV_NAMES) assert.match(name, /^[A-Z][A-Z0-9_]*$/);
});
test('thirteen-key private file alone satisfies every required real-mode variable with the right value', () => {
  withPrivateFile(syntheticFull(), (file) => {
    const loaded = loadPrivateEnvironment(file, {});
    // 每个字段的合成标记落在它自己的变量名上：证明的是映射对不对，不是「有没有值」。
    // `appid` 例外：它必须逐字等于白名单账号，否则 loader 直接 `PRIVATE_ACCOUNT_MISMATCH`。
    const marker = field => field === 'appid' ? SYNTHETIC_APPID : 'synthetic-' + field + '-value';
    for (const [field, variable] of PRIVATE_ENV_PAIRS) assert.equal(loaded[variable], marker(field), variable);
    assert.deepEqual([...loaded.missingFields], []);
  });
  // 真实文件的 13 键版：4 个可选字段缺席不影响 9/9。
  withPrivateFile(syntheticPrivate(), (file) => {
    const loaded = loadPrivateEnvironment(file, {});
    for (const [field, variable] of PRIVATE_ENV_PAIRS) if (PRIVATE_OPTIONAL_KEYS.includes(field)) assert.equal(Object.hasOwn(loaded, variable), false, variable);
    // 9/9 前置项：只给私密文件、不补任何环境变量，全部 nonempty（不需要调用方逐对补映射）。
    assert.deepEqual(missingRealModeEnv(loaded), []);
    assert.deepEqual(REQUIRED_WHEN_REAL_FIELDS.filter(name => !loaded[name].trim()), []);
    assert.equal(assertRealModeEnv(loaded), loaded);
    assert.deepEqual([...loaded.missingFields], []);
  });
});
test('the real-mode gap report names variables only and never echoes a value', () => {
  withPrivateFile(syntheticPrivate(), (file) => {
    const loaded = loadPrivateEnvironment(file, {});
    for (const name of ['SESSION_SIGNING_KEY', 'OBJECT_STORAGE_BUCKET']) delete loaded[name];
    assert.deepEqual(missingRealModeEnv(loaded), ['SESSION_SIGNING_KEY', 'OBJECT_STORAGE_BUCKET']);
    let error;
    try { assertRealModeEnv(loaded); } catch (caught) { error = caught; }
    assert.equal(error.message, 'MISSING_REAL_MODE_ENV:SESSION_SIGNING_KEY,OBJECT_STORAGE_BUCKET');
    assert.match(error.message, /^MISSING_REAL_MODE_ENV:[A-Z][A-Z0-9_]*(?:,[A-Z][A-Z0-9_]*)*$/);
    // 报错进日志/工单：任何一个私密值出现在里面都算泄密，逐条合成值反查（消息里只带下标，不带值）。
    Object.values(syntheticPrivate()).forEach((value, index) => assert.equal(error.message.includes(value), false, 'synthetic value #' + index));
  });
});
test('CHAT_LLM defaults come from the allowlist, lose to explicit env, and never appear without a key', () => {
  assert.deepEqual({ ...CHAT_LLM_DEFAULT_ENV }, { CHAT_LLM_ENDPOINT: AI_ENDPOINTS.llm.endpoint, CHAT_LLM_MODEL: AI_ENDPOINTS.llm.model });
  assert.equal(Object.isFrozen(CHAT_LLM_DEFAULT_ENV), true);
  assert.match(CHAT_LLM_DEFAULT_ENV.CHAT_LLM_ENDPOINT, /^https:\/\//);
  // 没有 key 的 env 原样返回（同一个对象、一个键都不加）：不凭空制造「配错了 LLM」。
  const untouched = {};
  assert.equal(applyChatProviderDefaults(untouched), untouched);
  assert.deepEqual(untouched, {});
  withPrivateFile(syntheticPrivate(), (file) => {
    // 显式环境变量 > 私密文件默认值：给足两个就一个字符都不改。
    const full = loadPrivateEnvironment(file, { CHAT_LLM_ENDPOINT: 'https://explicit.invalid/chat', CHAT_LLM_MODEL: 'synthetic-explicit-model' });
    assert.equal(full.CHAT_LLM_ENDPOINT, 'https://explicit.invalid/chat');
    assert.equal(full.CHAT_LLM_MODEL, 'synthetic-explicit-model');
    // 只给一半时只补另一半，已给的那个保留。
    const partial = loadPrivateEnvironment(file, { CHAT_LLM_MODEL: 'synthetic-explicit-model' });
    assert.equal(partial.CHAT_LLM_MODEL, 'synthetic-explicit-model');
    assert.equal(partial.CHAT_LLM_ENDPOINT, AI_ENDPOINTS.llm.endpoint);
  });
  withPrivateFile({ appid: SYNTHETIC_APPID }, (file) => {
    // 私密文件只有 appid：没有 chat key ⇒ 不补端点/模型，也不凭空虚造 CHAT_LLM_API_KEY。
    const bare = loadPrivateEnvironment(file, {});
    assert.equal(bare.CHAT_LLM_ENDPOINT, undefined);
    assert.equal(bare.CHAT_LLM_MODEL, undefined);
    assert.equal(Object.hasOwn(bare, 'CHAT_LLM_API_KEY'), false);
    // 显式 CHAT_LLM_API_KEY 也算拿到 key，默认值同样生效。
    const viaExplicitKey = loadPrivateEnvironment(file, { CHAT_LLM_API_KEY: 'synthetic-chat-key' });
    assert.equal(viaExplicitKey.CHAT_LLM_API_KEY, 'synthetic-chat-key');
    assert.equal(viaExplicitKey.CHAT_LLM_ENDPOINT, AI_ENDPOINTS.llm.endpoint);
    assert.equal(viaExplicitKey.CHAT_LLM_MODEL, AI_ENDPOINTS.llm.model);
  });
});
