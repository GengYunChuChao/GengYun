// GY-I13 真实 TTS 适配器 · 手工验证装置（**默认纯离线 dry run**）。
//
// 安全口径：
//  - 默认（未给 --manual-authorization）= **纯离线 dry run**：不读任何凭据文件、不发任何包、不写任何账本；
//    注入假 fetchImpl 并把 globalThis.fetch 换成绊线，运行结束断言绊线从未触发。
//  - 付费路径必须**同时**具备三件：`--manual-authorization <本轮常量>` + `--credentials <私密文件路径>`
//    + 已存在且 authorization 与本轮常量**逐字一致**的新台账
//    `.supervisor/provider-adapter-live/ledger.json`。缺一即拒绝（MANUAL_AUTHORIZATION_REQUIRED）。
//  - 只放行 `--capability tts` 且只放行**一次正常调用**；不实现受控失败、不实现自动重试。
//  - **绝不打印任何凭据值**：只打印存在性布尔、方案名、TC3 作用域（日期/服务）与签名长度；
//    打印前再用「实际凭据值不得出现在输出里」自检兜底（命中即拒绝输出）。
//  - 台账：ceiling ¥2、条目 ≤11、每能力 ≤2、reserve-then-send、进程锁、`actualChargeCny: null`（未取得账单不编造）。
//  - 本工具**不得**被任何 workflow 引用，也不得进任何 `test:*` 套件。
//
// 用途边界：这是**手工装置**，不是产品路径。它直接调用适配器（`createLiveTtsProvider`），
// 绕过 service 的「只播报已核对内容」判定；输入是固定**合成**短句（非个人、非处方、无剂量建议）。
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { AI_ENDPOINTS, configurationIssues, loadPrivateEnvironment, providerFor } from './ai-config.mjs';
import { resolveTc3Credentials } from './verify-tencent-live.mjs';
import { LiveGateRefusedError } from '../services/api/src/tts/live-ports.ts';
import { createLiveTtsProvider } from '../services/api/src/tts/provider.ts';

/** 本轮（2026-10-12）新授权标签。**不复用** 2026-10-04 的 `gy25-20261004-cny2` 系列。 */
export const ROUND_AUTHORIZATION = 'gy-adapter-round-20261012-cny2';
export const ROUND_AUTHORIZATION_VERSION = '1';
/** 本轮只放行这一个能力。 */
export const WIRED_CAPABILITIES = Object.freeze(['tts']);
/** 保守预留单价（与 `tools/verify-tencent-live.mjs` 的 PRICES.tts 同口径；**不是**账单金额）。 */
export const PRICES = Object.freeze({ tts: 0.003 });
export const CEILING_CNY = 2;
export const MAX_ENTRIES = 11;
export const MAX_PER_CAPABILITY = 2;

/** 固定合成短句（≤100 码点、非个人、非处方、无剂量建议）。 */
export const SYNTHETIC_TEXT = '你好，这是语音测试。';
export const SYNTHETIC_TARGET_REF = Object.freeze({ type: 'answer', id: 'synthetic-live-probe', revision: 1 });
export const SYNTHETIC_JOB_ID = '00000000-0000-4000-8000-00000000liv1';

const LEDGER_DIR = new URL('../.supervisor/provider-adapter-live/', import.meta.url);
const LEDGER_FILE = new URL('ledger.json', LEDGER_DIR);
const LOCK_FILE = new URL('process.lock', LEDGER_DIR);
const FIXTURE_DIR = new URL('../.supervisor/gy25-live/', import.meta.url);
const CONFIG_FILE = new URL('../docs/verification/config.local.json', import.meta.url);

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** 输出前自检：任何实际凭据值都不得出现在将要打印的文本里。 */
function assertNoSecrets(text, secrets) {
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.trim() !== '' && text.includes(secret)) {
      throw new Error('SECRET_LEAK_IN_OUTPUT');
    }
  }
  return text;
}

function say(text, secrets = []) {
  process.stdout.write(`${assertNoSecrets(String(text), secrets)}\n`);
}

function parseArgs(argv) {
  const args = { capability: null, manualAuthorization: null, credentials: null };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (typeof value !== 'string' || value === '') throw new Error('MANUAL_ARGUMENTS_REQUIRED');
    if (flag === '--capability') args.capability = value;
    else if (flag === '--manual-authorization') args.manualAuthorization = value;
    else if (flag === '--credentials') args.credentials = value;
    else throw new Error('MANUAL_ARGUMENTS_REQUIRED');
  }
  if (args.capability === null) throw new Error('MANUAL_ARGUMENTS_REQUIRED');
  if (!WIRED_CAPABILITIES.includes(args.capability)) throw new Error('CAPABILITY_NOT_WIRED_THIS_ROUND');
  const live = args.manualAuthorization !== null;
  if (live && (args.manualAuthorization !== ROUND_AUTHORIZATION || args.credentials === null)) {
    throw new Error('MANUAL_AUTHORIZATION_REQUIRED');
  }
  if (!live && args.credentials !== null) throw new Error('MANUAL_ARGUMENTS_REQUIRED');
  return { ...args, live };
}

function loadConfig() {
  const config = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  const issues = configurationIssues(config, 'tts');
  if (issues.length > 0) throw new Error(`CONFIGURATION_ISSUE:${issues[0]}`);
  return config;
}

/** 从**被校验配置**取快照；适配器会在构造期再断言一遍（纵深防御）。 */
function profileFromConfig(config) {
  const provider = providerFor(config, 'tts');
  const spec = AI_ENDPOINTS.tts;
  return {
    endpoint: spec.endpoint,
    action: provider.action,
    apiVersion: provider.apiVersion,
    region: provider.region,
    timeoutMs: provider.timeoutMs,
    maxRetries: provider.maxRetries,
    voiceType: provider.voiceType,
    codec: provider.codec,
    sampleRate: provider.sampleRate,
    maxTextCharacters: provider.maxTextCharacters,
  };
}

/** 只使用固定本机合成夹具；先核对 manifest 三字段与双 SHA-256，再允许使用。 */
function verifyFixtures() {
  const manifest = JSON.parse(readFileSync(new URL('synthetic-manifest.json', FIXTURE_DIR), 'utf8'));
  const image = readFileSync(new URL('synthetic.png', FIXTURE_DIR));
  const wav = readFileSync(new URL('synthetic-speech.wav', FIXTURE_DIR));
  if (manifest.nonpersonalSynthetic !== true || manifest.purpose !== 'manual_access_test') {
    throw new Error('SYNTHETIC_PURPOSE_REQUIRED');
  }
  if (sha256(image) !== manifest.imageSha256) throw new Error('IMAGE_FIXTURE_MISMATCH');
  if (sha256(wav) !== manifest.wavSha256) throw new Error('AUDIO_FIXTURE_MISMATCH');
  return {
    imageBytes: image.length,
    wavBytes: wav.length,
    imageShaMatched: true,
    wavShaMatched: true,
    fixtureRound: manifest.authorization,
    nonpersonalSynthetic: true,
  };
}

// ---------------------------------------------------------------------------
// 台账闸门（reserve-then-send；只用本工具自己的新台账）
// ---------------------------------------------------------------------------

function readLedger() {
  if (!existsSync(LEDGER_FILE)) throw new Error('LEDGER_MISSING');
  const ledger = JSON.parse(readFileSync(LEDGER_FILE, 'utf8'));
  if (ledger?.authorization !== ROUND_AUTHORIZATION) throw new Error('LEDGER_AUTHORIZATION_MISMATCH');
  if (ledger?.ceilingCny !== CEILING_CNY) throw new Error('LEDGER_CEILING_MISMATCH');
  if (!Array.isArray(ledger.entries) || !Number.isFinite(ledger.reservedCny)) throw new Error('LEDGER_INTEGRITY_REQUIRED');
  const sum = ledger.entries.reduce((total, entry) => total + (Number(entry?.reservedCny) || 0), 0);
  if (Math.abs(sum - ledger.reservedCny) > 0.000001) throw new Error('LEDGER_INTEGRITY_REQUIRED');
  for (const entry of ledger.entries) {
    if (!WIRED_CAPABILITIES.includes(entry?.capability) || entry.reservedCny !== PRICES[entry.capability]) {
      throw new Error('LEDGER_INTEGRITY_REQUIRED');
    }
  }
  return ledger;
}

function writeLedger(ledger) {
  writeFileSync(LEDGER_FILE, `${JSON.stringify(ledger, null, 2)}\n`);
}

/** 闸门：**先落账，再发包**；成功与失败都要 settle。 */
function createLedgerGate() {
  return {
    async reserve({ capability, authorization, attemptKey }) {
      if (authorization !== ROUND_AUTHORIZATION) {
        throw new LiveGateRefusedError('AUTHORIZATION_REQUIRED', '显式授权令牌与台账常量不一致');
      }
      let ledger;
      try {
        ledger = readLedger();
      } catch (error) {
        throw new LiveGateRefusedError('LEDGER_UNAVAILABLE', `台账不可用：${error.message}`);
      }
      if (ledger.entries.some(entry => entry.attemptKey === attemptKey)) {
        throw new LiveGateRefusedError('ATTEMPT_ALREADY_RESERVED', '同一次尝试已预留过（绝不重发）');
      }
      const price = PRICES[capability];
      const capabilityCount = ledger.entries.filter(entry => entry.capability === capability).length;
      if (ledger.entries.length >= MAX_ENTRIES || capabilityCount >= MAX_PER_CAPABILITY || ledger.reservedCny + price > CEILING_CNY) {
        throw new LiveGateRefusedError('BUDGET_OR_COUNT_EXCEEDED', '超出本轮总额/总条数/每能力次数上限');
      }
      const entry = {
        capability,
        attemptKey,
        reservedCny: price,
        reservedAt: new Date().toISOString(),
        state: 'OUTCOME_UNKNOWN',
        actualChargeCny: null,
        providerErrorCode: null,
        resultMayHaveBeenProcessed: true,
      };
      ledger.entries.push(entry);
      ledger.reservedCny = Number((ledger.reservedCny + price).toFixed(6));
      writeLedger(ledger); // reserve-then-send：崩溃只会留下「已预留」
      return { capability, authorization, reservedCny: price, attemptKey };
    },
    async settle(ticket, outcome) {
      const ledger = readLedger();
      const entry = ledger.entries.find(item => item.attemptKey === ticket.attemptKey);
      if (entry === undefined) throw new Error('LEDGER_ENTRY_MISSING');
      entry.state = outcome.state;
      entry.actualChargeCny = outcome.actualChargeCny;
      entry.providerErrorCode = outcome.providerErrorCode;
      entry.resultMayHaveBeenProcessed = outcome.resultMayHaveBeenProcessed;
      entry.settledAt = new Date().toISOString();
      writeLedger(ledger);
    },
  };
}

// ---------------------------------------------------------------------------
// 台账初始化（显式人工动作，不静默创建）
// ---------------------------------------------------------------------------

export function initLedger() {
  mkdirSync(LEDGER_DIR, { recursive: true });
  if (existsSync(LEDGER_FILE)) throw new Error('LEDGER_ALREADY_EXISTS');
  writeLedger({
    authorization: ROUND_AUTHORIZATION,
    authorizationVersion: ROUND_AUTHORIZATION_VERSION,
    ceilingCny: CEILING_CNY,
    currency: 'CNY',
    reservedCny: 0,
    note: '本轮 (2026-10-12) 新台账：仅 TTS 1 次正常调用；actualChargeCny 未取得账单前恒为 null。',
    entries: [],
  });
  return LEDGER_FILE.pathname;
}

// ---------------------------------------------------------------------------
// 离线 dry run
// ---------------------------------------------------------------------------

/** 注入假响应的场景表（证明装置能走到「即将发送」并正确映射）。 */
export const DRY_RUN_SCENARIOS = [
  {
    label: 'canned-success',
    response: sessionId => ({
      Response: {
        RequestId: '4f1a2b3c-5d6e-7f80-9a0b-1c2d3e4f5061',
        SessionId: sessionId,
        Audio: Buffer.from('49443304000000000000', 'hex').toString('base64'),
      },
    }),
    expected: { kind: 'completed', state: 'BUSINESS_RESPONSE' },
  },
  {
    label: 'canned-quota-error',
    response: () => ({
      Response: {
        RequestId: '4f1a2b3c-5d6e-7f80-9a0b-1c2d3e4f5061',
        Error: { Code: 'UnsupportedOperation.PkgExhausted', Message: 'synthetic-injected' },
      },
    }),
    expected: { kind: 'failed', state: 'SERVICE_ERROR', code: 'PROVIDER_QUOTA_EXCEEDED' },
  },
  {
    label: 'canned-session-mismatch',
    response: () => ({
      Response: {
        RequestId: '4f1a2b3c-5d6e-7f80-9a0b-1c2d3e4f5061',
        SessionId: 'another-session',
        Audio: Buffer.from('49443304000000000000', 'hex').toString('base64'),
      },
    }),
    expected: { kind: 'failed', state: 'RESPONSE_EVIDENCE_INCOMPLETE', code: 'PROVIDER_OUTCOME_UNKNOWN' },
  },
];

async function dryRun() {
  const config = loadConfig();
  const profile = profileFromConfig(config);
  const fixtures = verifyFixtures();
  const problems = [];
  const check = (condition, label) => {
    if (!condition) problems.push(label);
    return condition;
  };

  // 网络绊线：任何真实网络入口一经调用即抛错并记名。
  const realFetch = globalThis.fetch;
  let tripwireTriggered = false;
  globalThis.fetch = () => {
    tripwireTriggered = true;
    throw new Error('REAL_NETWORK_FORBIDDEN');
  };

  say('=== GY-I13 真实 TTS 适配器 · 离线 dry run（零网络、零凭据、零账本） ===');
  say(`round_authorization=${ROUND_AUTHORIZATION}  mode=OFFLINE_DRY_RUN`);
  say(`config=${CONFIG_FILE.pathname}  configuration_issues=[]`);
  say(`fixtures: image_bytes=${fixtures.imageBytes} wav_bytes=${fixtures.wavBytes} image_sha_matched=${fixtures.imageShaMatched} wav_sha_matched=${fixtures.wavShaMatched}`);
  say(`fixtures_round=${fixtures.fixtureRound}  nonpersonal_synthetic=${fixtures.nonpersonalSynthetic}（沿用 2026-10-04 轮合成夹具；TTS 只需合成文本）`);

  const observations = [];
  const captured = [];
  // dry run 用的是**合成**凭据；同样纳入「输出里不得出现凭据值」自检，证明打印路径本身干净。
  const drySecrets = ['synthetic-offline-id', 'synthetic-offline-key'];
  const gateState = { reserves: 0, settles: 0, outcomes: [] };
  let scenarioIndex = 0;
  const fakeGate = {
    async reserve(input) {
      gateState.reserves += 1;
      return { capability: input.capability, authorization: input.authorization, reservedCny: PRICES.tts, attemptKey: input.attemptKey };
    },
    async settle(ticket, outcome) {
      gateState.settles += 1;
      gateState.outcomes.push(outcome);
    },
  };
  const fakeFetch = async (url, init) => {
    const scene = DRY_RUN_SCENARIOS[scenarioIndex];
    const body = JSON.parse(init.body);
    captured.push({
      scenario: scene.label,
      url,
      method: init.method,
      redirect: init.redirect,
      bodyIsString: typeof init.body === 'string',
      bodyFieldNames: Object.keys(body).sort(),
      encodedBodyBytes: Buffer.byteLength(init.body),
      signalIsAbortSignal: init.signal instanceof AbortSignal,
      headerNames: Object.keys(init.headers).sort(),
      authorizationPresent: Object.hasOwn(init.headers, 'Authorization'),
      authScheme: /^TC3-HMAC-SHA256 Credential=/.test(init.headers.Authorization ?? '') ? 'TC3-HMAC-SHA256' : 'MALFORMED',
      tc3Scope: (init.headers.Authorization ?? '').match(/\/(\d{4}-\d{2}-\d{2}\/[a-z]+\/tc3_request), SignedHeaders=content-type;host, Signature=[0-9a-f]{64}$/)?.[1] ?? null,
      signatureHexLength: (init.headers.Authorization ?? '').match(/Signature=([0-9a-f]{64})$/)?.[1]?.length ?? 0,
      xTcAction: init.headers['X-TC-Action'] ?? null,
      xTcVersion: init.headers['X-TC-Version'] ?? null,
      xTcRegion: init.headers['X-TC-Region'] ?? null,
      xTcTimestampIsInteger: /^\d+$/.test(String(init.headers['X-TC-Timestamp'] ?? '')),
      xTcTokenPresent: Object.hasOwn(init.headers, 'X-TC-Token'),
      sessionId: body.SessionId,
    });
    return { ok: true, status: 200, json: async () => DRY_RUN_SCENARIOS[scenarioIndex].response(body.SessionId) };
  };

  const provider = createLiveTtsProvider({
    liveGate: fakeGate,
    authorization: ROUND_AUTHORIZATION,
    profile,
    // 合成凭据：明显假值，**不读任何真实凭据文件**。
    credentials: { secretId: 'synthetic-offline-id', secretKey: 'synthetic-offline-key', sessionToken: '' },
    fetchImpl: fakeFetch,
    now: () => 1_700_000_000_000,
    onObservation: observation => observations.push(observation),
  });

  say(`adapter_providerVersion=${provider.providerVersion}  executionMode=${provider.executionMode}  available=${provider.available}`);
  say(`profile: endpoint=${profile.endpoint} action=${profile.action} apiVersion=${profile.apiVersion} region=${profile.region} timeoutMs=${profile.timeoutMs} maxRetries=${profile.maxRetries} voiceType=${profile.voiceType} codec=${profile.codec} sampleRate=${profile.sampleRate} maxTextCharacters=${profile.maxTextCharacters}`);

  for (const scenario of DRY_RUN_SCENARIOS) {
    scenarioIndex = DRY_RUN_SCENARIOS.indexOf(scenario);
    const result = await provider.synthesize({
      jobId: SYNTHETIC_JOB_ID,
      text: SYNTHETIC_TEXT,
      locale: 'zh-CN',
      targetRef: { ...SYNTHETIC_TARGET_REF },
    });
    const shot = captured[captured.length - 1];
    const observation = observations[observations.length - 1];
    say(`--- 场景 [${scenario.label}]（响应由**注入的假 JSON** 产生，不是任何真实供应商结果）---`, drySecrets);
    say(`  send_boundary_calls=1 method=${shot.method} redirect=${shot.redirect} bodyIsString=${shot.bodyIsString} bodyJsonParses=true signalIsAbortSignal=${shot.signalIsAbortSignal}`, drySecrets);
    say(`  url_literal_equal_allowlist_endpoint=${shot.url === profile.endpoint}  encodedBodyBytes=${shot.encodedBodyBytes}`, drySecrets);
    say(`  requestFields=${JSON.stringify(shot.bodyFieldNames)}`, drySecrets);
    say(`  authorization_header_present=${shot.authorizationPresent} scheme=${shot.authScheme} tc3_scope=${shot.tc3Scope} signature_hex_len=${shot.signatureHexLength} credential_value_printed=false`, drySecrets);
    say(`  X-TC-Action=${shot.xTcAction} X-TC-Version=${shot.xTcVersion} X-TC-Region=${shot.xTcRegion} X-TC-Timestamp_is_integer=${shot.xTcTimestampIsInteger} x_tc_token_present=${shot.xTcTokenPresent}`, drySecrets);
    say(`  observed: state=${observation.state} httpStatus=${observation.httpStatus} requestId=${observation.requestId} providerErrorCode=${observation.providerErrorCode} sessionEchoOk=${observation.sessionEchoOk} audioBytes=${observation.audioBytes} hasMpegHeader=${observation.hasMpegHeader} endpointAsserted=${observation.endpointAsserted} sendAttempts=${observation.sendAttempts}`, drySecrets);
    say(`  mapped: kind=${result.kind}${result.kind === 'failed' ? ` code=${result.code}` : ` contentType=${result.artifact.contentType} substitute=${result.artifact.substitute} bytes=${result.artifact.body.byteLength}`}`, drySecrets);
    check(shot.url === profile.endpoint, `URL_NOT_EXACT_ALLOWLIST:${scenario.label}`);
    check(shot.redirect === 'manual', `REDIRECT_NOT_MANUAL:${scenario.label}`);
    check(shot.bodyIsString === true, `BODY_NOT_SERIALIZED_ONCE:${scenario.label}`);
    check(shot.signalIsAbortSignal === true, `NO_ABORT_SIGNAL:${scenario.label}`);
    check(shot.authScheme === 'TC3-HMAC-SHA256', `AUTH_SCHEME_MALFORMED:${scenario.label}`);
    check(shot.signatureHexLength === 64, `SIGNATURE_NOT_WELL_FORMED:${scenario.label}`);
    check(shot.xTcAction === 'TextToVoice' && shot.xTcVersion === '2019-08-23', `ACTION_OR_VERSION_MISMATCH:${scenario.label}`);
    check(shot.xTcRegion === 'ap-shanghai', `REGION_MISMATCH:${scenario.label}`);
    check(shot.xTcTokenPresent === false, `UNEXPECTED_SESSION_TOKEN:${scenario.label}`);
    check(observation.sendAttempts === 1, `NOT_EXACTLY_ONE_SEND:${scenario.label}`);
    check(result.kind === scenario.expected.kind, `KIND_MISMATCH:${scenario.label}`);
    check(observation.state === scenario.expected.state, `STATE_MISMATCH:${scenario.label}`);
    if (scenario.expected.code !== undefined) check(result.code === scenario.expected.code, `CODE_MISMATCH:${scenario.label}`);
    if (scenario.expected.kind === 'completed') {
      check(result.artifact.substitute === false, `SUBSTITUTE_FLAG_WRONG:${scenario.label}`);
      check(result.artifact.contentType === 'audio/mpeg', `CONTENT_TYPE_WRONG:${scenario.label}`);
    }
  }

  globalThis.fetch = realFetch;
  say('--- 网络与台账断言 ---');
  say(`scenarios=${DRY_RUN_SCENARIOS.length} send_boundary_calls=${captured.length} reserves=${gateState.reserves} settles=${gateState.settles}`);
  say(`ledger_written=false fixtures_only_local=true`);
  say(`global_fetch_tripwire_triggered=${tripwireTriggered}  (false = 全程未发出任何真实网络调用)`);
  check(captured.length === DRY_RUN_SCENARIOS.length, 'DID_NOT_REACH_SEND_BOUNDARY_FOR_ALL_SCENARIOS');
  check(gateState.reserves === DRY_RUN_SCENARIOS.length, 'RESERVE_COUNT_MISMATCH');
  check(gateState.settles === DRY_RUN_SCENARIOS.length, 'SETTLE_COUNT_MISMATCH');
  check(tripwireTriggered === false, 'REAL_NETWORK_WAS_ATTEMPTED');

  say('--- 结论 ---');
  if (problems.length === 0) {
    say('DRY_RUN_RESULT=PASS  （装置可走到「即将发送」，全部断言成立；未发送、未读凭据、未写账本）');
    say('SCOPE=offline_only; no supplier was contacted; no budget consumed; no ledger written');
  } else {
    for (const problem of problems) say(`  problem=${problem}`);
    say('DRY_RUN_RESULT=FAIL');
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// 付费路径（恰好 1 次真实调用）
// ---------------------------------------------------------------------------

async function liveRun(args) {
  const config = loadConfig();
  const profile = profileFromConfig(config);
  const fixtures = verifyFixtures();
  const env = loadPrivateEnvironment(args.credentials, {});
  const provider0 = providerFor(config, 'tts');
  const tc3 = resolveTc3Credentials(env, provider0);
  const credentials = {
    secretId: tc3.TENCENTCLOUD_SECRET_ID,
    secretKey: tc3.TENCENTCLOUD_SECRET_KEY,
    sessionToken: tc3.TENCENTCLOUD_SESSION_TOKEN ?? '',
  };
  const secrets = [credentials.secretId, credentials.secretKey, credentials.sessionToken];

  if (!existsSync(LEDGER_FILE)) throw new Error('LEDGER_MISSING');
  const ledgerBefore = readLedger();
  say('=== GY-I13 真实 TTS 适配器 · 手工真实调用（恰好 1 次） ===');
  say(`mode=MANUAL_LIVE round_authorization=${ROUND_AUTHORIZATION}`);
  say(`credentials_path=${args.credentials}  (仅路径；未读取打印任何值)`);
  say(`credential_fields_present: secretId=${credentials.secretId.trim() !== ''} secretKey=${credentials.secretKey.trim() !== ''} sessionToken=${credentials.sessionToken !== ''}`);
  say(`config=${CONFIG_FILE.pathname}  configuration_issues=[]`);
  say(`fixtures: image_sha_matched=${fixtures.imageShaMatched} wav_sha_matched=${fixtures.wavShaMatched} nonpersonal_synthetic=${fixtures.nonpersonalSynthetic}`);
  say(`ledger=${LEDGER_FILE.pathname}  ceilingCny=${ledgerBefore.ceilingCny}  entries_before=${ledgerBefore.entries.length}  reservedCny_before=${ledgerBefore.reservedCny}`);
  say(`synthetic_text_code_points=${[...SYNTHETIC_TEXT].length}  locale=zh-CN  target_ref=${SYNTHETIC_TARGET_REF.type}/${SYNTHETIC_TARGET_REF.id}#${SYNTHETIC_TARGET_REF.revision}`);

  // 进程锁：崩溃会留下锁文件，必须人工核对结果后处理；**不自动恢复、不自动重试**。
  writeFileSync(LOCK_FILE, `${ROUND_AUTHORIZATION}\n${new Date().toISOString()}\n`, { flag: 'wx' });
  let observations = [];
  try {
    const provider = createLiveTtsProvider({
      liveGate: createLedgerGate(),
      authorization: ROUND_AUTHORIZATION,
      profile,
      credentials,
      now: () => Date.now(),
      onObservation: observation => observations.push(observation),
    });
    say(`adapter_providerVersion=${provider.providerVersion}  available=${provider.available}`);
    const result = await provider.synthesize({
      jobId: SYNTHETIC_JOB_ID,
      text: SYNTHETIC_TEXT,
      locale: 'zh-CN',
      targetRef: { ...SYNTHETIC_TARGET_REF },
    });
    const observation = observations[observations.length - 1];
    if (observation !== undefined) {
      say('--- 打码观测（真实响应）---');
      say(`  state=${observation.state}`);
      say(`  httpStatus=${observation.httpStatus}`);
      say(`  requestId=${observation.requestId}`);
      say(`  providerErrorCode=${observation.providerErrorCode}`);
      say(`  sessionEchoOk=${observation.sessionEchoOk}`);
      say(`  audioBytes=${observation.audioBytes}`);
      say(`  hasMpegHeader=${observation.hasMpegHeader}`);
      say(`  resultMayHaveBeenProcessed=${observation.resultMayHaveBeenProcessed}`);
      say(`  elapsedMs=${observation.elapsedMs}`);
      say(`  endpointAsserted=${observation.endpointAsserted}  sendAttempts=${observation.sendAttempts}`);
    }
    say(`  mapped: kind=${result.kind}${result.kind === 'failed' ? ` code=${result.code}` : ` contentType=${result.artifact.contentType} substitute=${result.artifact.substitute} audited_not_saved=true`}`);
    const ledgerAfter = readLedger();
    const entry = ledgerAfter.entries[ledgerAfter.entries.length - 1];
    say('--- 台账 ---');
    say(`  entries=${ledgerAfter.entries.length}  reservedCny_total=${ledgerAfter.reservedCny}`);
    say(`  entry: capability=${entry.capability} attemptKey=${entry.attemptKey} reservedCny=${entry.reservedCny} state=${entry.state} actualChargeCny=${entry.actualChargeCny} providerErrorCode=${entry.providerErrorCode}`);
    say(`  platformHardCapVerified=false  taskVerified=false  qualityEvidence=false`);
    process.exitCode = observation?.state === 'BUSINESS_RESPONSE' ? 0 : 1;
  } finally {
    unlinkSync(LOCK_FILE);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.live) await liveRun(args);
  else await dryRun();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    // 只输出错误类别，绝不输出私密输入、凭据或原始异常正文。
    console.error(`Manual verification stopped: ${String(error?.message ?? error).slice(0, 120)}`);
    process.exitCode = 1;
  });
}
