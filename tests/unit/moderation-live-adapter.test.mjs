/**
 * GY-I14（#14）· 真实审核端口（TMS 文本 / IMS 图片）**离线**回归。Refs #14。
 *
 * 目标：证明「真实审核端口」库件＋接线框架**默认关闭**（无凭据 fail-closed 503、永不回退替身），
 * 且任何失败**绝不产出通过**：
 *   ① 签名绑定的是**实际发出的那串字节**（用独立第二实现复算 canonical request 与 Authorization）；
 *   ② 请求形状逐字段钉死（Action/Version/Region/BizType/Content|FileContent，无多余字段）；
 *   ③ `Suggestion` 三档 + 未知标签的映射（`Review`／未知**绝不**是"通过"）；
 *   ④ 失败矩阵逐条不通过（超时／429／401／400／5xx／非 JSON／缺 `Response`）；
 *   ⑤ 控制字段注入（供应商回体自带角色/来源/可见性…）⇒ **整条拒绝**，且合流层不发布；
 *   ⑥ 结构回归：`resolveModerationPorts({executionMode:'real'})` 默认 `fail_closed:true`；`live` 显式接线才打开，**永不回退替身**；
 *   ⑦ 策略闸门：`policySelectionVerified`/`executionAllowed` 任一不为 `true` ⇒ **构造硬拒**。
 *
 * **全离线**：所有请求都打到 `127.0.0.1` 上由本文件用 `node:http` 起的假服务器（随机端口），
 * 零真实外呼、零凭据文件、零环境变量、零账本。真实可达性不属本片，见证据页「未取得」。
 *
 * 证据口径：`docs/evaluation/sample-gap-register.md` 已确认 `ai_moderation_risk` / `ai_moderation_normal`
 * 真实样本**各为 0** ⇒ 本文件**不产生、也不声称**任何准确率/召回率/误放行率结论。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AI_ENDPOINTS } from '../../tools/ai-config.mjs';
import {
  MODEL_FAILURE_CLASSES,
  MODEL_PORT_SEAMS,
  classifyModelFailure,
  validateModelPort,
} from '../../packages/moderation/model-ports.mjs';
import { MODEL_VERDICT_LABELS, normalizeModelVerdict } from '../../packages/moderation/model-verdict.mjs';
import { mergeModeration } from '../../packages/moderation/merge.mjs';
import { AUDIT_STATES } from '../../packages/moderation/constants.mjs';
import { CLEAN_RULE_RESULT, makeContent } from '../moderation/_model-fixtures.mjs';

import {
  MODERATION_PORT_SEAMS,
  declaredModelVersion,
  declaredProvider,
  resolveModerationPorts,
} from '../../services/api/src/moderation/provider.ts';
import { guardModelPort, scanForbiddenControlFields } from '../../services/api/src/moderation/nonbypass.ts';
import {
  MODERATION_FAILURE_CLASSES,
  MODERATION_MAX_IMAGE_BYTES,
  MODERATION_MAX_TEXT_CHARACTERS,
  MODERATION_VERDICT_LABELS,
  MODERATION_VENDOR_ACTIONS,
  MODERATION_VENDOR_ENDPOINTS,
  MODERATION_VENDOR_REGION,
  ModerationPortError,
  ModerationWiringError,
  assertModerationPolicyOpen,
} from '../../services/api/src/moderation/live-ports.ts';
import {
  MODERATION_TC3_ALGORITHM,
  MODERATION_TC3_SIGNED_HEADERS,
  buildModerationCanonicalRequest,
  resolveModerationVendorTarget,
  signModerationTc3Request,
} from '../../services/api/src/moderation/live-tc3.ts';
import {
  LIVE_MODERATION_TEXT_MODEL_VERSION,
  createLiveModerationTextPort,
} from '../../services/api/src/moderation/tms-live-adapter.ts';
import {
  LIVE_MODERATION_IMAGE_MODEL_VERSION,
  createLiveModerationImagePort,
} from '../../services/api/src/moderation/ims-live-adapter.ts';
import { createUnwiredModerationImageSource } from '../../services/api/src/moderation/live-vendor.ts';
import { createLiveModerationPortsFromWiring } from '../../services/api/src/moderation/live-wiring.ts';
import { createModerationService } from '../../services/api/src/moderation/service.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

const CREDENTIALS = Object.freeze({
  secretId: 'synthetic-secret-id-not-a-secret',
  secretKey: 'synthetic-secret-key-not-a-secret',
  sessionToken: '',
});

const POLICY = Object.freeze({
  policySelectionVerified: true,
  executionAllowed: true,
  source: 'tests/unit/moderation-live-adapter.test.mjs',
});

const TEXT_PROFILE_BASE = Object.freeze({
  action: 'TextModeration',
  apiVersion: '2020-12-29',
  region: 'ap-shanghai',
  timeoutMs: 1000,
  maxRetries: 0,
  bizType: 'gy-test-biz',
});

const IMAGE_PROFILE_BASE = Object.freeze({
  ...TEXT_PROFILE_BASE,
  action: 'ImageModeration',
  maxImageBytes: MODERATION_MAX_IMAGE_BYTES,
  mediaTransport: 'inlineBase64',
});

/** 干净文本（与规则层夹具同源，不含任何命中形态）；长度远低于 200 码点上限。 */
const SAMPLE_TEXT = '今年雨水多，田里的稗草长得快，准备按标签说明选择登记药剂，先看苗情再说。';

/** 一张**合成** PNG 头（只需通过头部嗅探，不是真图、不含任何真实照片）。 */
const FAKE_PNG = Buffer.concat([
  Buffer.from('89504e470d0a1a0a', 'hex'),
  Buffer.from('0000000d49484452', 'hex'),
  Buffer.from('0000001000000010', 'hex'),
  Buffer.alloc(16, 0),
]);

const b64 = (value) => Buffer.from(value).toString('base64');

// ---------------------------------------------------------------- 基础设施

/**
 * 在 `127.0.0.1` 的随机端口起一个假供应商。
 *
 * `responder(entry, index)` 返回 `{ status?, json? , text? }`；返回 `null` ⇒ **永不响应**
 * （用来触发客户端的 `AbortSignal.timeout`）。
 */
async function startFakeServer(responder) {
  const state = { requests: [] };
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const entry = { method: request.method, url: request.url, headers: request.headers, body };
      state.requests.push(entry);
      const outcome = responder(entry, state.requests.length);
      if (outcome === null) return;
      response.writeHead(outcome.status ?? 200, { 'content-type': 'application/json' });
      response.end(outcome.text ?? JSON.stringify(outcome.json));
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  return {
    base,
    state,
    async close() {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise((done) => server.close(done));
    },
  };
}

/**
 * **独立第二实现**的 TC3-HMAC-SHA256（照 TC3 规范从零写，**不 import 被测实现**）。
 *
 * 这就是本文件"签名正确性"的判据：期望值由这份实现算出，而不是拿被测函数自己算一遍。
 */
function independentTc3(input) {
  const date = new Date(input.timestampSeconds * 1000).toISOString().slice(0, 10);
  const sha256 = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
  const canonicalRequest = [
    'POST',
    '/',
    '',
    'content-type:application/json',
    `host:${input.host}`,
    '',
    'content-type;host',
    sha256(input.body),
  ].join('\n');
  const scope = `${date}/${input.service}/tc3_request`;
  const stringToSign = ['TC3-HMAC-SHA256', String(input.timestampSeconds), scope, sha256(canonicalRequest)].join('\n');
  const keyDate = createHmac('sha256', 'TC3' + input.credentials.secretKey).update(date).digest();
  const keyService = createHmac('sha256', keyDate).update(input.service).digest();
  const keySigning = createHmac('sha256', keyService).update('tc3_request').digest();
  const signature = createHmac('sha256', keySigning).update(stringToSign).digest('hex');
  return {
    canonicalRequest,
    stringToSign,
    scope,
    signature,
    authorization:
      `TC3-HMAC-SHA256 Credential=${input.credentials.secretId}/${scope}, ` +
      `SignedHeaders=content-type;host, Signature=${signature}`,
  };
}

function tmsPort(endpoint, overrides = {}) {
  const { profile: profileOverride, ...rest } = overrides;
  return createLiveModerationTextPort({
    policy: POLICY,
    profile: { endpoint, ...TEXT_PROFILE_BASE, ...profileOverride },
    credentials: CREDENTIALS,
    ...rest,
  });
}

function imsPort(endpoint, overrides = {}) {
  const { profile: profileOverride, imageSource, ...rest } = overrides;
  return createLiveModerationImagePort({
    policy: POLICY,
    profile: { endpoint, ...IMAGE_PROFILE_BASE, ...profileOverride },
    credentials: CREDENTIALS,
    imageSource: imageSource ?? wiredImageSource(new Map()),
    ...rest,
  });
}

/** 按 `media_id` 发字节的合成来源（**不是**真实对象存储，也不读磁盘）。 */
function wiredImageSource(byId) {
  const reads = [];
  return {
    kind: 'wired',
    note: 'synthetic test source',
    reads,
    async read({ mediaId }) {
      reads.push(mediaId);
      return byId.get(mediaId) ?? null;
    },
  };
}

function tmsRequest(text = SAMPLE_TEXT) {
  return {
    schema: 'gengyun/moderation/model-request@1',
    kind: 'tms',
    prompt_id: 'text_moderation',
    prompt_version: 'pv-test',
    required_output_fields: ['label', 'reason_codes', 'summary'],
    verdict_labels: ['pass', 'block', 'unsure'],
    target_ref: { type: 'post', id: 'post-1001', revision: 1 },
    content: { text },
  };
}

function imsRequest(ids) {
  return {
    schema: 'gengyun/moderation/model-request@1',
    kind: 'ims',
    prompt_id: 'image_moderation',
    prompt_version: 'pv-test',
    required_output_fields: ['label', 'reason_codes', 'summary'],
    verdict_labels: ['pass', 'block', 'unsure'],
    target_ref: { type: 'post', id: 'post-1001', revision: 1 },
    content: { media_refs: ids.map((id) => ({ media_id: id, media_revision: 1, mime: 'image/png' })) },
  };
}

async function captureFailure(operation) {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  assert.fail('该路径必须抛错（任何失败都不得产出通过）');
}

function vendorPass(label = 'Normal', score = 99) {
  return { json: { Response: { RequestId: 'req-1', Suggestion: 'Pass', Label: label, Score: score } } };
}

// ===========================================================================
// 0. 常量与上游一致（漂移会立刻变红，不靠口头声明）
// ===========================================================================

test('常量与 tools/ai-config.mjs、packages/moderation 的闭集逐项一致', () => {
  assert.equal(MODERATION_VENDOR_ENDPOINTS.tms, AI_ENDPOINTS.moderationText.endpoint);
  assert.equal(MODERATION_VENDOR_ENDPOINTS.ims, AI_ENDPOINTS.moderationImage.endpoint);
  assert.equal(MODERATION_VENDOR_ACTIONS.tms.action, AI_ENDPOINTS.moderationText.action);
  assert.equal(MODERATION_VENDOR_ACTIONS.tms.apiVersion, AI_ENDPOINTS.moderationText.version);
  assert.equal(MODERATION_VENDOR_ACTIONS.ims.action, AI_ENDPOINTS.moderationImage.action);
  assert.equal(MODERATION_VENDOR_ACTIONS.ims.apiVersion, AI_ENDPOINTS.moderationImage.version);
  assert.equal(AI_ENDPOINTS.moderationText.auth, MODERATION_TC3_ALGORITHM);
  assert.equal(AI_ENDPOINTS.moderationImage.auth, MODERATION_TC3_ALGORITHM);
  assert.equal(MODERATION_VENDOR_REGION, 'ap-shanghai');
  assert.equal(MODERATION_MAX_IMAGE_BYTES, 2097152);
  assert.equal(MODERATION_MAX_TEXT_CHARACTERS, 200);
  assert.equal(MODERATION_TC3_SIGNED_HEADERS, 'content-type;host');

  // 标签/失败类别/seam 三份闭集：本片是**局部**副本，必须与上游逐项相同（否则就是静默分叉）。
  assert.deepEqual([...MODERATION_VERDICT_LABELS], [...MODEL_VERDICT_LABELS]);
  assert.deepEqual([...MODERATION_FAILURE_CLASSES], [...MODEL_FAILURE_CLASSES]);
  assert.deepEqual([...MODERATION_PORT_SEAMS], [...MODEL_PORT_SEAMS]);
});

// ===========================================================================
// 1. 端口形状（必须与 ModerationPortLike 一致，且能过合流层的端口校验）
// ===========================================================================

test('端口形状：kind/model_version/provider/seams 齐全，且过 validateModelPort', async () => {
  const server = await startFakeServer(() => vendorPass());
  try {
    const port = tmsPort(server.base);
    assert.equal(port.kind, 'tms');
    assert.equal(port.model_version, LIVE_MODERATION_TEXT_MODEL_VERSION);
    assert.equal(typeof port.evaluate, 'function');
    assert.deepEqual(Object.keys(port.seams).sort(), [...MODEL_PORT_SEAMS].sort());
    for (const seam of MODEL_PORT_SEAMS) assert.notEqual(port.seams[seam], null);
    assert.equal(port.provider.biz_type, TEXT_PROFILE_BASE.bizType);
    assert.equal(port.provider.biz_type_selection_verified, true);
    assert.equal(port.provider.synthetic, false);
    assert.equal(port.provider.timeout_ms, TEXT_PROFILE_BASE.timeoutMs);
    assert.equal(declaredModelVersion(port), LIVE_MODERATION_TEXT_MODEL_VERSION);
    assert.deepEqual(declaredProvider(port), { biz_type: TEXT_PROFILE_BASE.bizType, synthetic: false });

    const report = validateModelPort(port, 'tms');
    assert.deepEqual(report.reason_codes, [], `端口必须被合流层接受：${JSON.stringify(report.details)}`);
    assert.equal(report.valid, true);
    // 串端口仍然被拒（tms 端口不能当 ims 用）。
    assert.equal(validateModelPort(port, 'ims').valid, false);

    // 未调用前零外呼：构造本身不发包。
    assert.equal(server.state.requests.length, 0, '构造端口不得发包');
  } finally {
    await server.close();
  }

  const imageServer = await startFakeServer(() => vendorPass());
  try {
    const port = imsPort(imageServer.base);
    assert.equal(port.kind, 'ims');
    assert.equal(port.model_version, LIVE_MODERATION_IMAGE_MODEL_VERSION);
    assert.equal(validateModelPort(port, 'ims').valid, true);
    assert.equal(validateModelPort(port, 'tms').valid, false);
  } finally {
    await imageServer.close();
  }
});

// ===========================================================================
// 2. ① 签名正确性 — 独立第二实现复算（不是拿被测函数自己算期望值）
// ===========================================================================

test('① 签名：Authorization 与 canonical request 由独立第二实现复算，且签名绑定实际发出的字节', async () => {
  const server = await startFakeServer(() => vendorPass());
  try {
    const port = tmsPort(server.base);
    const verdict = await port.evaluate(tmsRequest());
    assert.equal(verdict.label, 'pass');
    assert.equal(server.state.requests.length, 1, '必须恰好一次外呼');

    const request = server.state.requests[0];
    const timestampSeconds = Number(request.headers['x-tc-timestamp']);
    assert.equal(Number.isSafeInteger(timestampSeconds), true, 'X-TC-Timestamp 必须是整数秒');

    // 端点审计：loopback 端点的 host 就是"主机:端口"（生产端点是 <service>.tencentcloudapi.com）。
    const target = resolveModerationVendorTarget(server.base, 'tms');
    assert.equal(target.kind, 'loopback');
    assert.equal(target.service, 'tms');
    assert.equal(target.host, server.base.replace('http://', ''));

    const expected = independentTc3({
      service: 'tms',
      host: target.host,
      timestampSeconds,
      // ⚠ 期望值绑定的是**服务器实际收到的 body**，不是测试自己拼的 body。
      body: request.body,
      credentials: CREDENTIALS,
    });

    assert.equal(request.headers.authorization, expected.authorization, 'Authorization 与独立复算不一致');
    assert.equal(
      buildModerationCanonicalRequest({ host: target.host, body: request.body }),
      expected.canonicalRequest,
      'canonical request 与独立复算不一致',
    );
    assert.equal(request.headers['content-type'], 'application/json');
    assert.equal(request.headers['x-tc-action'], 'TextModeration');
    assert.equal(request.headers['x-tc-version'], '2020-12-29');
    assert.equal(request.headers['x-tc-region'], 'ap-shanghai');
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/');
    // 凭据泄露负控制：SecretKey 绝不出现在任何请求头/URL 里（SecretId 按 TC3 规范在 Authorization 里）。
    const wire = `${JSON.stringify(request.headers)} ${request.url}`;
    assert.equal(wire.includes(CREDENTIALS.secretKey), false, 'SecretKey 不得出现在线上字节里');
    assert.equal(request.headers.authorization.includes(CREDENTIALS.secretId), true);
    // 长期密钥没有临时令牌 ⇒ 不得出现 X-TC-Token。
    assert.equal(request.headers['x-tc-token'], undefined);
  } finally {
    await server.close();
  }
});

test('① 签名：临时令牌存在时才带 X-TC-Token；sessionToken 变化会改变签名作用域外的头（不是签名）', async () => {
  const server = await startFakeServer(() => vendorPass());
  try {
    const port = createLiveModerationTextPort({
      policy: POLICY,
      profile: { endpoint: server.base, ...TEXT_PROFILE_BASE },
      credentials: { ...CREDENTIALS, sessionToken: 'synthetic-session-token' },
    });
    await port.evaluate(tmsRequest());
    const request = server.state.requests[0];
    assert.equal(request.headers['x-tc-token'], 'synthetic-session-token');

    const timestampSeconds = Number(request.headers['x-tc-timestamp']);
    const expected = independentTc3({
      service: 'tms',
      host: server.base.replace('http://', ''),
      timestampSeconds,
      body: request.body,
      credentials: CREDENTIALS,
    });
    // TC3 的签名面不含 X-TC-Token ⇒ 加 token 不改签名（这是规范事实，不是本片的取舍）。
    assert.equal(request.headers.authorization, expected.authorization);
  } finally {
    await server.close();
  }
});

// ===========================================================================
// 3. ② 请求形状
// ===========================================================================

test('② 文本请求形状：只有 Content/BizType/Type/SourceLanguage 四个字段，Content 是原文的 base64', async () => {
  const server = await startFakeServer(() => vendorPass());
  try {
    const port = tmsPort(server.base);
    await port.evaluate(tmsRequest());
    const body = JSON.parse(server.state.requests[0].body);
    assert.deepEqual(Object.keys(body).sort(), ['BizType', 'Content', 'SourceLanguage', 'Type']);
    assert.equal(body.BizType, TEXT_PROFILE_BASE.bizType);
    assert.equal(body.Type, 'TEXT');
    assert.equal(body.SourceLanguage, 'zh');
    assert.equal(Buffer.from(body.Content, 'base64').toString('utf8'), SAMPLE_TEXT);
    assert.equal(server.state.requests[0].headers['x-tc-action'], 'TextModeration');
  } finally {
    await server.close();
  }
});

test('② 图片请求形状：只有 BizType/FileContent 两个字段，FileContent 是原字节的 base64（inlineBase64）', async () => {
  const server = await startFakeServer(() => vendorPass());
  try {
    const source = wiredImageSource(new Map([['media-a', FAKE_PNG]]));
    const port = imsPort(server.base, { imageSource: source });
    await port.evaluate(imsRequest(['media-a']));
    const body = JSON.parse(server.state.requests[0].body);
    assert.deepEqual(Object.keys(body).sort(), ['BizType', 'FileContent']);
    assert.equal(body.BizType, TEXT_PROFILE_BASE.bizType);
    assert.equal(Buffer.from(body.FileContent, 'base64').equals(FAKE_PNG), true);
    assert.equal(server.state.requests[0].headers['x-tc-action'], 'ImageModeration');
    assert.deepEqual(source.reads, ['media-a']);
  } finally {
    await server.close();
  }
});

// ===========================================================================
// 4. ③ 三档映射 + 未知标签（Review／未知绝不映射为通过）
// ===========================================================================

test('③ 映射：Pass⇒pass、Block⇒block、Review⇒unsure、未知⇒unsure；Label 进原因码，Score 只进摘要', async () => {
  const cases = [
    { suggestion: 'Pass', label: 'Normal', score: 99, expect: 'pass', suggestionCode: 'MODERATION_PROVIDER_SUGGESTION_PASS' },
    { suggestion: 'Block', label: 'Porn', score: 88, expect: 'block', suggestionCode: 'MODERATION_PROVIDER_SUGGESTION_BLOCK' },
    { suggestion: 'Review', label: 'Ad', score: 61, expect: 'unsure', suggestionCode: 'MODERATION_PROVIDER_SUGGESTION_REVIEW' },
    { suggestion: 'Maybe', label: 'Ad', score: 12, expect: 'unsure', suggestionCode: 'MODERATION_PROVIDER_SUGGESTION_UNKNOWN' },
  ];
  let index = 0;
  const server = await startFakeServer(() => {
    const item = cases[index];
    index += 1;
    return { json: { Response: { Suggestion: item.suggestion, Label: item.label, Score: item.score } } };
  });
  try {
    const port = tmsPort(server.base);
    for (const item of cases) {
      const verdict = await port.evaluate(tmsRequest());
      assert.equal(verdict.label, item.expect, `${item.suggestion} 的映射不对`);
      assert.equal(verdict.reason_codes.includes(item.suggestionCode), true, `缺 ${item.suggestionCode}`);
      assert.equal(verdict.reason_codes.includes(`MODERATION_PROVIDER_LABEL_${item.label.toUpperCase()}`), true);
      assert.equal(verdict.summary.includes(`Score=${item.score}`), true, 'Score 只进摘要');
      // 闭集三键：多一个键都不行（控制类字段不可能混进 verdict）。
      assert.deepEqual(Object.keys(verdict).sort(), ['label', 'reason_codes', 'summary']);
      // 供应商回报里的 Score / Label 不得成为任何控制字段。
      assert.equal(Object.keys(verdict).includes('score'), false);
      assert.equal(Object.keys(verdict).includes('label_raw'), false);
    }
    assert.equal(server.state.requests.length, cases.length);
  } finally {
    await server.close();
  }
});

test('③ 未知标签：自由文本形态的 Label 只落闭集原因码，不进 reason_codes 原文', async () => {
  const weird = { Suggestion: 'Pass', Label: '带空格 bad <script>', Score: 50 };
  const server = await startFakeServer(() => ({ json: { Response: weird } }));
  try {
    const port = tmsPort(server.base);
    const verdict = await port.evaluate(tmsRequest());
    assert.equal(verdict.label, 'pass');
    assert.equal(verdict.reason_codes.includes('MODERATION_PROVIDER_LABEL_UNRECOGNIZED'), true);
    assert.equal(verdict.reason_codes.some((code) => code.includes('script')), false);
    assert.equal(verdict.reason_codes.some((code) => /[\s<>]/.test(code)), false, '原因码不得含空白或尖括号');
    for (const code of verdict.reason_codes) {
      assert.equal(code.length >= 1 && code.length <= 80, true, `原因码长度越界：${code}`);
    }
  } finally {
    await server.close();
  }
});

test('③ 与上游归一器对接：pass/block 被接受，unsure 记 MODEL_NOT_EVALUATED（不是通过）', async () => {
  const responses = [
    { Suggestion: 'Pass', Label: 'Normal', Score: 99 },
    { Suggestion: 'Block', Label: 'Porn', Score: 90 },
    { Suggestion: 'Review', Label: 'Ad', Score: 60 },
  ];
  let index = 0;
  const server = await startFakeServer(() => ({ json: { Response: responses[index++] } }));
  try {
    const port = tmsPort(server.base);
    const context = {
      required_output_fields: ['label', 'reason_codes', 'summary'],
      declared_model_version: LIVE_MODERATION_TEXT_MODEL_VERSION,
    };
    const first = normalizeModelVerdict(await port.evaluate(tmsRequest()), context);
    assert.equal(first.ok, true);
    assert.equal(first.label, 'pass');
    assert.deepEqual(Object.keys(first.reported).sort(), ['reason_code_count', 'summary_length', 'summary_present']);

    const second = normalizeModelVerdict(await port.evaluate(tmsRequest()), context);
    assert.equal(second.ok, true);
    assert.equal(second.label, 'block');

    const third = normalizeModelVerdict(await port.evaluate(tmsRequest()), context);
    assert.equal(third.ok, false, 'unsure 不得被归一成"有结论"');
    assert.equal(third.label, 'unsure');
    assert.equal(third.reason_codes.includes('MODEL_NOT_EVALUATED'), true);
  } finally {
    await server.close();
  }
});

// ===========================================================================
// 5. ④ 失败矩阵（逐条断言不通过）
// ===========================================================================

test('④ 失败矩阵：超时/429/401/400/5xx/非 JSON/缺 Response 逐条不通过', async () => {
  const cases = [
    { name: '500', status: 500, expect: 'port_error' },
    { name: '503', status: 503, expect: 'port_error' },
    { name: '429', status: 429, expect: 'quota_exceeded' },
    { name: '401', status: 401, expect: 'auth_failed' },
    { name: '403', status: 403, expect: 'auth_failed' },
    { name: '400', status: 400, expect: 'payload_invalid' },
    { name: '413', status: 413, expect: 'payload_invalid' },
    { name: '422', status: 422, expect: 'payload_invalid' },
  ];
  for (const item of cases) {
    const server = await startFakeServer(() => ({ status: item.status, json: { Response: {} } }));
    try {
      const port = tmsPort(server.base);
      const error = await captureFailure(() => port.evaluate(tmsRequest()));
      assert.equal(error instanceof ModerationPortError, true, `${item.name}: 必须是 ModerationPortError`);
      assert.equal(error.model_failure, item.expect, `${item.name}: 失败类别不对`);
      // 既有分类器（合流层真正读的那个）必须同意我们的声明。
      assert.equal(classifyModelFailure(error), item.expect, `${item.name}: 与既有分类器不一致`);
      assert.equal(error.http_status, item.status);
    } finally {
      await server.close();
    }
  }
});

test('④ 失败矩阵：非 JSON / 缺 Response / 供应商业务错误 一律不通过', async () => {
  const responses = [
    { name: '非 JSON', text: 'this is not json', expect: 'port_error' },
    { name: '缺 Response', json: { Nope: 1 }, expect: 'port_error' },
    { name: 'Response 不是对象', json: { Response: 'x' }, expect: 'port_error' },
    { name: '供应商配额错误', json: { Response: { Error: { Code: 'RequestLimitExceeded' } } }, expect: 'quota_exceeded' },
    { name: '供应商鉴权错误', json: { Response: { Error: { Code: 'AuthFailure.SignatureFailure' } } }, expect: 'auth_failed' },
    { name: '供应商参数错误', json: { Response: { Error: { Code: 'InvalidParameter' } } }, expect: 'payload_invalid' },
    { name: '供应商内部错误', json: { Response: { Error: { Code: 'InternalError' } } }, expect: 'port_error' },
  ];
  for (const item of responses) {
    const server = await startFakeServer(() => ({ ...item, status: 200 }));
    try {
      const port = tmsPort(server.base);
      const error = await captureFailure(() => port.evaluate(tmsRequest()));
      assert.equal(error.model_failure, item.expect, `${item.name}: 失败类别不对`);
      assert.equal(classifyModelFailure(error), item.expect, `${item.name}: 与既有分类器不一致`);
      assert.equal(error.message.includes('this is not json'), false, '错误消息不得含响应正文');
    } finally {
      await server.close();
    }
  }
});

test('④ 失败矩阵：超时 ⇒ timeout（不重试、不重发）', async () => {
  const server = await startFakeServer(() => null);
  try {
    const port = tmsPort(server.base);
    const error = await captureFailure(() => port.evaluate(tmsRequest()));
    assert.equal(error instanceof ModerationPortError, true);
    assert.equal(error.model_failure, 'timeout');
    assert.equal(classifyModelFailure(error), 'timeout');
    assert.equal(server.state.requests.length, 1, '超时臂也只允许一次发送（零重试）');
    assert.equal(error.result_may_have_been_processed, true);
  } finally {
    await server.close();
  }
});

test('④ 失败矩阵：传输层抛错 ⇒ timeout/port_error，且绝不重发', async () => {
  const abortError = Object.assign(new Error('synthetic abort'), { name: 'AbortError' });
  const abortingPort = tmsPort('http://127.0.0.1:41234', {
    fetchImpl: async () => {
      throw abortError;
    },
  });
  const timeoutError = await captureFailure(() => abortingPort.evaluate(tmsRequest()));
  assert.equal(timeoutError.model_failure, 'timeout');

  let calls = 0;
  const transportPort = tmsPort('http://127.0.0.1:41234', {
    fetchImpl: async () => {
      calls += 1;
      throw Object.assign(new Error('synthetic ECONNRESET'), { name: 'TypeError' });
    },
  });
  const transportError = await captureFailure(() => transportPort.evaluate(tmsRequest()));
  assert.equal(transportError.model_failure, 'port_error');
  assert.equal(calls, 1, '零重试');
});

test('④ 失败矩阵：失败经过合流层后绝不发布（decision 不是 approved）', async () => {
  const server = await startFakeServer(() => ({ status: 500, json: { Response: {} } }));
  try {
    const port = tmsPort(server.base);
    const merged = await mergeModeration(CLEAN_RULE_RESULT, { content: makeContent(), ports: { tms: port } });
    assert.equal(AUDIT_STATES.includes(merged.decision), true);
    assert.notEqual(merged.decision, 'approved');
    assert.equal(merged.model_layer.status, 'attempted');
    assert.equal(merged.model_layer.kinds.tms.status, 'failed');
    assert.equal(merged.model_layer.kinds.tms.failure_class, 'port_error');
    assert.equal(merged.model_layer.publishable.publishable, false);
  } finally {
    await server.close();
  }
});

// ===========================================================================
// 6. ⑤ 控制字段注入（整条拒绝 + 不发布语义）
// ===========================================================================

test('⑤ 控制字段注入：供应商回体带角色/来源/可见性/发布 ⇒ 整条拒绝（response_shape_unknown）', async () => {
  const injected = [
    { Suggestion: 'Pass', Label: 'Normal', Score: 99, Role: 'admin' },
    { Suggestion: 'Pass', Label: 'Normal', Score: 99, Source: 'verified_seed' },
    { Suggestion: 'Pass', Label: 'Normal', Score: 99, Visibility: 'published' },
    { Suggestion: 'Pass', Label: 'Normal', Score: 99, Publish: true },
    { Suggestion: 'Pass', Label: 'Normal', Score: 99, Decision: 'approved' },
    { Suggestion: 'Pass', Label: 'Normal', Score: 99, Human_review: 'approved' },
  ];
  for (const response of injected) {
    const server = await startFakeServer(() => ({ json: { Response: response } }));
    try {
      const port = tmsPort(server.base);
      const error = await captureFailure(() => port.evaluate(tmsRequest()));
      assert.equal(error instanceof ModerationPortError, true);
      assert.equal(error.model_failure, 'response_shape_unknown', `未拒绝：${Object.keys(response).join(',')}`);
      assert.equal(classifyModelFailure(error), 'response_shape_unknown');
      // 错误里只允许出现**键名**，不允许出现值。
      assert.equal(error.message.includes('admin'), false);
    } finally {
      await server.close();
    }
  }
});

test('⑤ 控制字段注入：嵌套位置同样被扫到（不是只看顶层）', async () => {
  const server = await startFakeServer(() => ({
    json: { Response: { Suggestion: 'Pass', Label: 'Normal', DetailResults: [{ Role: 'admin' }] } },
  }));
  try {
    const port = tmsPort(server.base);
    const error = await captureFailure(() => port.evaluate(tmsRequest()));
    assert.equal(error.model_failure, 'response_shape_unknown');
  } finally {
    await server.close();
  }
});

test('⑤ 控制字段注入：即使被注入端口"吞掉"错误，guardModelPort 与合流层仍然拒绝', async () => {
  // 构造一个**故意撒谎**的端口：把带控制字段的回报原样返回（模拟未来有人绕过白名单重建）。
  const lying = {
    kind: 'tms',
    model_version: 'synthetic-liar@1',
    provider: { biz_type: 'gy-test-biz', biz_type_selection_verified: true, synthetic: true, timeout_ms: 1000 },
    seams: { fetchImpl: () => {}, credentials: {}, liveGate: {}, now: () => 0 },
    evaluate: () => ({ label: 'pass', reason_codes: [], summary: 'ok', Role: 'admin' }),
  };
  const guarded = guardModelPort(lying);
  const error = await captureFailure(() => guarded.evaluate(tmsRequest()));
  assert.equal(error.model_failure, 'response_shape_unknown');

  const merged = await mergeModeration(CLEAN_RULE_RESULT, {
    content: makeContent(),
    ports: { tms: guardModelPort(lying) },
  });
  assert.notEqual(merged.decision, 'approved');
  assert.equal(merged.reason_codes.includes('MODEL_RESPONSE_SHAPE_UNKNOWN'), true);
});

test('⑤ 不发布语义：供应商回体带控制字段 ⇒ 合流层 quarantined 且不可发布', async () => {
  const server = await startFakeServer(() => ({
    json: { Response: { Suggestion: 'Pass', Label: 'Normal', Score: 99, User_id: 'someone-else' } },
  }));
  try {
    const port = tmsPort(server.base);
    const merged = await mergeModeration(CLEAN_RULE_RESULT, { content: makeContent(), ports: { tms: port } });
    assert.equal(merged.decision, 'quarantined');
    assert.equal(merged.model_layer.publishable.publishable, false);
    assert.equal(merged.model_layer.kinds.tms.status, 'failed');
    assert.equal(merged.model_layer.kinds.tms.failure_class, 'response_shape_unknown');
  } finally {
    await server.close();
  }
});

test('⑤ 正控制：干净回报的 verdict 只含闭集三键，自身也过控制字段扫描', async () => {
  const server = await startFakeServer(() => vendorPass());
  try {
    const port = tmsPort(server.base);
    const verdict = await port.evaluate(tmsRequest());
    assert.deepEqual(Object.keys(verdict).sort(), ['label', 'reason_codes', 'summary']);
    assert.equal(scanForbiddenControlFields(verdict).ok, true);
    // 端口回报里不得带 model_version（否则归一器会拿它跟端口声明比对；本片让它走"声明值"）。
    assert.equal(Object.hasOwn(verdict, 'model_version'), false);

    const merged = await mergeModeration(CLEAN_RULE_RESULT, { content: makeContent(), ports: { tms: port } });
    assert.equal(merged.decision, 'approved', '干净回体 + 规则通过才允许 approved');
    assert.equal(merged.model_version, LIVE_MODERATION_TEXT_MODEL_VERSION);
    assert.deepEqual(merged.model_layer.synthetic_ports, [], '真实端口的 provider.synthetic 是 false');
  } finally {
    await server.close();
  }
});

// ===========================================================================
// 7. 图片端口的本地闸门（2 MiB / 头部 / 取不到字节 / 多图）
// ===========================================================================

test('图片：2 MiB 上限按 tools/ai-config.mjs，超限 fail-closed 且**零外呼**（不压缩、不裁剪）', async () => {
  const server = await startFakeServer(() => vendorPass());
  try {
    const tooBig = Buffer.concat([FAKE_PNG, Buffer.alloc(MODERATION_MAX_IMAGE_BYTES)]);
    assert.equal(tooBig.length > MODERATION_MAX_IMAGE_BYTES, true);
    const source = wiredImageSource(new Map([['media-big', tooBig]]));
    const port = imsPort(server.base, { imageSource: source });
    const error = await captureFailure(() => port.evaluate(imsRequest(['media-big'])));
    assert.equal(error.model_failure, 'payload_invalid');
    assert.equal(server.state.requests.length, 0, '本地拒绝不得外呼');

    const badHeader = wiredImageSource(new Map([['media-bad', Buffer.from('<html>not an image</html>')]]));
    const badPort = imsPort(server.base, { imageSource: badHeader });
    const headerError = await captureFailure(() => badPort.evaluate(imsRequest(['media-bad'])));
    assert.equal(headerError.model_failure, 'payload_invalid');

    const missing = wiredImageSource(new Map());
    const missingPort = imsPort(server.base, { imageSource: missing });
    const missingError = await captureFailure(() => missingPort.evaluate(imsRequest(['media-none'])));
    assert.equal(missingError.model_failure, 'payload_invalid');

    const unwiredPort = imsPort(server.base, { imageSource: createUnwiredModerationImageSource('对象存储属媒体域') });
    const unwiredError = await captureFailure(() => unwiredPort.evaluate(imsRequest(['media-a'])));
    assert.equal(unwiredError.model_failure, 'payload_invalid');
    assert.equal(server.state.requests.length, 0, '以上全部为本地拒绝，一次都没有外呼');
  } finally {
    await server.close();
  }
});

test('图片：多图逐张各一次，任一 Block ⇒ block，全 Pass 才 pass，其余 unsure', async () => {
  const plans = [
    { suggestions: ['Block', 'Pass'], expect: 'block' },
    { suggestions: ['Pass', 'Pass'], expect: 'pass' },
    { suggestions: ['Review', 'Pass'], expect: 'unsure' },
    { suggestions: ['Pass', 'Maybe'], expect: 'unsure' },
  ];
  for (const plan of plans) {
    let index = 0;
    const server = await startFakeServer(() => {
      const suggestion = plan.suggestions[index];
      index += 1;
      return { json: { Response: { Suggestion: suggestion, Label: 'Normal', Score: 90 } } };
    });
    try {
      const ids = plan.suggestions.map((_, position) => `media-${position}`);
      const source = wiredImageSource(new Map(ids.map((id) => [id, FAKE_PNG])));
      const port = imsPort(server.base, { imageSource: source });
      const verdict = await port.evaluate(imsRequest(ids));
      assert.equal(verdict.label, plan.expect, `${plan.suggestions.join('+')} 的合成不对`);
      assert.equal(server.state.requests.length, ids.length, '每张图各一次请求');
      assert.deepEqual(Object.keys(verdict).sort(), ['label', 'reason_codes', 'summary']);
    } finally {
      await server.close();
    }
  }
});

test('图片：张数超上界整条 fail-closed（绝不"只审一张就放行"）', async () => {
  const server = await startFakeServer(() => vendorPass());
  try {
    const ids = Array.from({ length: 10 }, (_, index) => `media-${index}`);
    const source = wiredImageSource(new Map(ids.map((id) => [id, FAKE_PNG])));
    const port = imsPort(server.base, { imageSource: source });
    const error = await captureFailure(() => port.evaluate(imsRequest(ids)));
    assert.equal(error.model_failure, 'payload_invalid');
    assert.equal(server.state.requests.length, 0);
    assert.equal(source.reads.length, 0, '连字节都不去读');
  } finally {
    await server.close();
  }
});

test('图片：失败矩阵同样不通过（5xx / 非 JSON / 缺 Response）', async () => {
  const responses = [
    { name: '5xx', status: 503, json: { Response: {} }, expect: 'port_error' },
    { name: '非 JSON', status: 200, text: 'nope', expect: 'port_error' },
    { name: '缺 Response', status: 200, json: { X: 1 }, expect: 'port_error' },
    { name: '429', status: 429, json: { Response: {} }, expect: 'quota_exceeded' },
  ];
  for (const item of responses) {
    const server = await startFakeServer(() => ({ ...item, status: item.status }));
    try {
      const source = wiredImageSource(new Map([['media-a', FAKE_PNG]]));
      const port = imsPort(server.base, { imageSource: source });
      const error = await captureFailure(() => port.evaluate(imsRequest(['media-a'])));
      assert.equal(error.model_failure, item.expect, `${item.name} 的失败类别不对`);
      assert.equal(classifyModelFailure(error), item.expect);
    } finally {
      await server.close();
    }
  }
});

// ===========================================================================
// 8. ⑥ 结构回归：real 行为一字不变
// ===========================================================================

test('⑥ 结构回归：resolveModerationPorts({executionMode:"real"}) 默认 fail_closed；live 显式接线才打开', () => {
  // 默认关闭：无 live ⇒ 仍整域 fail-closed（ports 恒空）。
  const bare = resolveModerationPorts({ executionMode: 'real' });
  assert.deepEqual(bare, { execution_mode: 'real', ports: {}, substitutes: [], fail_closed: true });

  // `injected` 在 real 下仍被忽略（那些只可能是合成替身）。
  const fakePort = {
    kind: 'tms',
    model_version: 'synthetic-x@1',
    evaluate: () => ({}),
    seams: { fetchImpl: () => {}, credentials: {}, liveGate: {}, now: () => 0 },
    provider: { biz_type: 'x', biz_type_selection_verified: true, synthetic: true },
  };
  const injected = resolveModerationPorts({ executionMode: 'real', injected: { tms: fakePort, ims: fakePort } });
  assert.deepEqual(injected, { execution_mode: 'real', ports: {}, substitutes: [], fail_closed: true });
  assert.equal(Object.keys(injected.ports).length, 0);

  // 缺任一真实端口（只给 tms）⇒ 仍整域 fail-closed，**绝不**为缺失的 ims 回退替身。
  const partial = resolveModerationPorts({ executionMode: 'real', live: { tms: fakePort } });
  assert.deepEqual(partial, { execution_mode: 'real', ports: {}, substitutes: [], fail_closed: true });

  // 显式给全 tms+ims ⇒ 打开（fail_closed:false、substitutes 恒空、两端口都有守卫包装）。
  const realTms = { ...fakePort, provider: { ...fakePort.provider, synthetic: false } };
  const realIms = { ...fakePort, kind: 'ims', provider: { ...fakePort.provider, synthetic: false } };
  const wired = resolveModerationPorts({ executionMode: 'real', live: { tms: realTms, ims: realIms } });
  assert.equal(wired.fail_closed, false);
  assert.deepEqual(wired.substitutes, []);
  assert.equal(wired.ports.tms !== undefined && wired.ports.tms !== null, true);
  assert.equal(wired.ports.ims !== undefined && wired.ports.ims !== null, true);
});

test('⑥ 结构回归：app.ts / server.ts 与统一出口都不 import 本片的真实适配器', () => {
  // 判据同 `tests/integration/tts-http.mjs` 的 S01：**去注释后**的产品源码里零命中。
  const strip = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const relative of ['services/api/src/app.ts', 'services/api/src/server.ts']) {
    const code = strip(readFileSync(join(repoRoot, relative), 'utf8'));
    for (const symbol of [
      'tms-live-adapter',
      'ims-live-adapter',
      'live-tc3',
      'live-vendor',
      'createLiveModerationTextPort',
      'createLiveModerationImagePort',
    ]) {
      assert.equal(code.includes(symbol), false, `${relative} 不得引用 ${symbol}`);
    }
  }
  // 统一出口也不导出它们：装配路径连"顺手 import 一下"的入口都没有。
  const barrel = strip(readFileSync(join(repoRoot, 'services/api/src/moderation/index.ts'), 'utf8'));
  assert.equal(barrel.includes('live-'), false, 'moderation/index.ts 不得 re-export 真实适配器');
});

const MODERATION_SRC_DIR = join(repoRoot, 'services/api/src/moderation');

/** 动态枚举 `services/api/src/moderation/**`：**不写死文件清单**，将来新增的文件同样进扫描面。 */
function listModerationSourceFiles(dir = MODERATION_SRC_DIR, prefix = '') {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...listModerationSourceFiles(join(dir, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

test('⑥ 结构回归：moderation/** 目录级 —— 除本片 live-* 库件（含 tms/ims-live-adapter）外，真实适配器符号与模块名必须 0 命中', () => {
  const files = listModerationSourceFiles();
  // 反空转：枚举必须真的覆盖目录内容，且证据页点名的两个装配点必须在扫描面里。
  assert.ok(files.length >= 10, `扫描面异常：只枚举到 ${files.length} 个文件`);
  for (const required of ['provider.ts', 'service.ts', 'index.ts', 'types.ts', 'decisions.ts', 'nonbypass.ts']) {
    assert.equal(files.includes(required), true, `扫描面缺失 ${required}（枚举失效会让本用例假绿）`);
  }
  // 允许出现这些字样的文件只有本片的 live-* 库件本身：`live-ports/live-tc3/live-vendor`
  // 与两个适配器 `tms-live-adapter` / `ims-live-adapter`（白名单逐名，未来新增的 `*-live-adapter`
  // 也必须显式登记，不能因为命名相似就默认放行）。
  const isLiveAdapterFile = (relative) => {
    const name = relative.slice(relative.lastIndexOf('/') + 1);
    return /^live-.+\.ts$/.test(name) || name === 'tms-live-adapter.ts' || name === 'ims-live-adapter.ts';
  };
  const liveFiles = files.filter(isLiveAdapterFile);
  assert.ok(liveFiles.length >= 2, `至少应枚举到 live-*.ts，实际 ${liveFiles.join(',')}`);

  // 模块名与构造器名：出现在 `provider.ts` / `service.ts` / `index.ts` / 任何未来新增的非 live-* 文件里
  // 都意味着"真实适配器已经能被装配路径拿到" ⇒ 必须红。
  const symbols = [
    'createLiveModerationTextPort',
    'createLiveModerationImagePort',
    'tms-live-adapter',
    'ims-live-adapter',
  ];
  const offenders = [];
  for (const relative of files) {
    if (isLiveAdapterFile(relative)) continue;
    const source = readFileSync(join(MODERATION_SRC_DIR, relative), 'utf8');
    for (const symbol of symbols) {
      if (source.includes(symbol)) offenders.push(`${relative} → ${symbol}`);
    }
  }
  assert.deepEqual(offenders, [], `真实适配器只允许出现在本片 live-* 库件内部：${offenders.join('; ')}`);
  assert.ok(files.length > liveFiles.length, '扫描面必须包含 live-* 之外的文件');
});

// ===========================================================================
// 8b. 接线框架：默认关闭 / 显式打开 / 无凭据 503 / 脱敏观测
// ===========================================================================

test('接线框架：无凭据/未显式打开 ⇒ null（默认关闭，不回退替身）', () => {
  assert.equal(createLiveModerationPortsFromWiring(null), null);
  assert.equal(createLiveModerationPortsFromWiring(undefined), null);
  // 无凭据（缺 credentials 字段）。
  assert.equal(
    createLiveModerationPortsFromWiring({
      policy: POLICY,
      textProfile: { endpoint: MODERATION_VENDOR_ENDPOINTS.tms, ...TEXT_PROFILE_BASE },
      imageProfile: { endpoint: MODERATION_VENDOR_ENDPOINTS.ims, ...IMAGE_PROFILE_BASE },
    }),
    null,
  );
  // 有凭据但策略未显式打开（executionAllowed !== true）。
  assert.equal(
    createLiveModerationPortsFromWiring({
      policy: { ...POLICY, executionAllowed: false },
      textProfile: { endpoint: MODERATION_VENDOR_ENDPOINTS.tms, ...TEXT_PROFILE_BASE },
      imageProfile: { endpoint: MODERATION_VENDOR_ENDPOINTS.ims, ...IMAGE_PROFILE_BASE },
      credentials: CREDENTIALS,
    }),
    null,
  );
});

test('接线框架：有凭据 + 显式打开 ⇒ tms/ims 真实端口（synthetic:false），文本单次真调用', async () => {
  const server = await startFakeServer(() => vendorPass());
  try {
    const ports = createLiveModerationPortsFromWiring({
      policy: POLICY,
      textProfile: { endpoint: server.base, ...TEXT_PROFILE_BASE },
      imageProfile: { endpoint: server.base, ...IMAGE_PROFILE_BASE },
      credentials: CREDENTIALS,
      imageSource: wiredImageSource(new Map([['media-a', FAKE_PNG]])),
    });
    assert.notEqual(ports, null);
    assert.equal(ports.tms.kind, 'tms');
    assert.equal(ports.ims.kind, 'ims');
    assert.equal(ports.tms.provider.synthetic, false);
    assert.equal(ports.ims.provider.synthetic, false);
    const verdict = await ports.tms.evaluate(tmsRequest());
    assert.equal(verdict.label, 'pass');
    assert.equal(server.state.requests.length, 1, '文本恰好一次外呼');
  } finally {
    await server.close();
  }
});

test('接线框架：createModerationService real 无凭据 ⇒ 整域 503；有 liveWiring ⇒ 接线', async () => {
  // 无凭据/未接线：整域 fail-closed（写操作 503 PROVIDER_UNAVAILABLE + retryable:false）。
  const closed = createModerationService({ executionMode: 'real' });
  assert.equal(closed.execution_mode, 'real');
  assert.deepEqual(closed.capabilities(), {
    execution_mode: 'real',
    text: { content_kind: 'text', port_kind: 'tms', state: 'none', ready: false, origin: 'none' },
    image: { content_kind: 'image', port_kind: 'ims', state: 'none', ready: false, origin: 'none' },
  });
  await assert.rejects(
    () =>
      closed.submitScreening({
        actor: { userId: 'u-1', role: 'user', authEpoch: 1 },
        content: { target_ref: { type: 'post', id: 'p-1', revision: 1 }, text: 'x', media: [] },
      }),
    (error) => error?.code === 'PROVIDER_UNAVAILABLE' && error?.retryable === false,
  );

  // 有凭据 + 显式打开：文本/图片能力 ready，端口是真实端口（非替身）。
  const server = await startFakeServer(() => vendorPass());
  try {
    const wired = createModerationService({
      executionMode: 'real',
      liveWiring: {
        policy: POLICY,
        textProfile: { endpoint: server.base, ...TEXT_PROFILE_BASE },
        imageProfile: { endpoint: server.base, ...IMAGE_PROFILE_BASE },
        credentials: CREDENTIALS,
        imageSource: wiredImageSource(new Map([['media-a', FAKE_PNG]])),
      },
    });
    assert.equal(wired.execution_mode, 'real');
    const caps = wired.capabilities();
    assert.equal(caps.text.state, 'wired');
    assert.equal(caps.text.ready, true);
    assert.equal(caps.text.origin, 'injected');
    assert.equal(caps.image.state, 'wired');
    assert.equal(caps.image.ready, true);
    assert.deepEqual(wired.counts().substitutes, []);
  } finally {
    await server.close();
  }
});

test('观测：RequestId/耗时脱敏登记（不含密钥/明文）', async () => {
  const observations = [];
  const server = await startFakeServer(() => ({
    json: { Response: { RequestId: '3c140219-cfe9-470e-b241-907877d6fb03', Suggestion: 'Pass', Label: 'Normal', Score: 99 } },
  }));
  try {
    const ports = createLiveModerationPortsFromWiring({
      policy: POLICY,
      textProfile: { endpoint: server.base, ...TEXT_PROFILE_BASE },
      imageProfile: { endpoint: server.base, ...IMAGE_PROFILE_BASE },
      credentials: CREDENTIALS,
      imageSource: wiredImageSource(new Map()),
      onObservation: (observation) => observations.push(observation),
      now: () => 1_700_000_000_000,
    });
    const verdict = await ports.tms.evaluate(tmsRequest());
    assert.equal(verdict.label, 'pass');
    assert.equal(observations.length, 1);
    const obs = observations[0];
    assert.equal(obs.kind, 'tms');
    assert.equal(obs.requestId, '3c140219-cfe9-470e-b241-907877d6fb03');
    assert.equal(obs.elapsedMs, 0, '固定时钟下耗时为 0');
    assert.equal(obs.modelFailure, null);
    assert.equal(obs.httpStatus, 200);
    const serialized = JSON.stringify(obs);
    assert.equal(serialized.includes(CREDENTIALS.secretKey), false, '观测不得含 SecretKey');
    assert.equal(serialized.includes(CREDENTIALS.secretId), false, '观测不得含 SecretId');
    assert.equal(serialized.includes(SAMPLE_TEXT), false, '观测不得含待审文本');
  } finally {
    await server.close();
  }
});

// ===========================================================================
// 9. ⑦ 策略闸门：构造硬拒
// ===========================================================================

test('⑦ 闸门：policySelectionVerified 不为 true ⇒ 构造硬拒（不发包）', () => {
  for (const policy of [
    { policySelectionVerified: false, executionAllowed: true, source: 'x' },
    { policySelectionVerified: 'true', executionAllowed: true, source: 'x' },
    { policySelectionVerified: undefined, executionAllowed: true, source: 'x' },
    { policySelectionVerified: true, executionAllowed: false, source: 'x' },
    { policySelectionVerified: true, executionAllowed: 1, source: 'x' },
    { policySelectionVerified: true, executionAllowed: true },
    { policySelectionVerified: true, executionAllowed: true, source: '' },
    null,
  ]) {
    assert.throws(
      () =>
        createLiveModerationTextPort({
          policy,
          profile: { endpoint: MODERATION_VENDOR_ENDPOINTS.tms, ...TEXT_PROFILE_BASE },
          credentials: CREDENTIALS,
        }),
      (error) => error instanceof ModerationWiringError,
      `未硬拒：${JSON.stringify(policy)}`,
    );
    assert.throws(
      () =>
        createLiveModerationImagePort({
          policy,
          profile: { endpoint: MODERATION_VENDOR_ENDPOINTS.ims, ...IMAGE_PROFILE_BASE },
          credentials: CREDENTIALS,
          imageSource: createUnwiredModerationImageSource('x'),
        }),
      (error) => error instanceof ModerationWiringError,
    );
  }
  // 闸门函数本身也只认 `=== true`（不做真值强制）。
  assert.equal(assertModerationPolicyOpen(POLICY).policySelectionVerified, true);
  assert.throws(() => assertModerationPolicyOpen({ policySelectionVerified: 1, executionAllowed: true, source: 'x' }));
});

test('⑦ 闸门：配置/凭据/端点/字节来源任一不合法同样构造硬拒', () => {
  const base = {
    policy: POLICY,
    profile: { endpoint: MODERATION_VENDOR_ENDPOINTS.tms, ...TEXT_PROFILE_BASE },
    credentials: CREDENTIALS,
  };
  const rejects = [
    { ...base, profile: { ...base.profile, action: 'WrongAction' } },
    { ...base, profile: { ...base.profile, apiVersion: '2019-01-01' } },
    { ...base, profile: { ...base.profile, region: 'ap-beijing' } },
    { ...base, profile: { ...base.profile, timeoutMs: 999 } },
    { ...base, profile: { ...base.profile, timeoutMs: 20001 } },
    { ...base, profile: { ...base.profile, maxRetries: 1 } },
    { ...base, profile: { ...base.profile, bizType: '' } },
    { ...base, profile: { ...base.profile, bizType: '带空格 bad' } },
    { ...base, profile: { ...base.profile, endpoint: 'https://evil.example.com' } },
    { ...base, profile: { ...base.profile, endpoint: 'https://tms.tencentcloudapi.com/v1' } },
    { ...base, profile: { ...base.profile, endpoint: 'http://localhost:8080' } },
    { ...base, credentials: { ...CREDENTIALS, secretKey: '' } },
    { ...base, credentials: { ...CREDENTIALS, sessionToken: undefined } },
  ];
  for (const ports of rejects) {
    assert.throws(
      () => createLiveModerationTextPort(ports),
      (error) => error instanceof ModerationWiringError,
      `未硬拒：${JSON.stringify(ports.profile)}`,
    );
  }
  // 图片端口多一条：缺字节来源。
  assert.throws(
    () =>
      createLiveModerationImagePort({
        policy: POLICY,
        profile: { endpoint: MODERATION_VENDOR_ENDPOINTS.ims, ...IMAGE_PROFILE_BASE },
        credentials: CREDENTIALS,
        imageSource: undefined,
      }),
    (error) => error instanceof ModerationWiringError,
  );
});

test('⑦ 端点审计：生产端点逐字放行、loopback 只认 127.0.0.1 + 1024..65535（端口无前导零）', () => {
  const production = resolveModerationVendorTarget(MODERATION_VENDOR_ENDPOINTS.tms, 'tms');
  assert.deepEqual(production, {
    endpoint: MODERATION_VENDOR_ENDPOINTS.tms,
    service: 'tms',
    host: 'tms.tencentcloudapi.com',
    kind: 'production',
  });
  const loopback = resolveModerationVendorTarget('http://127.0.0.1:41234', 'tms');
  assert.equal(loopback.kind, 'loopback');
  assert.equal(loopback.host, '127.0.0.1:41234');
  // 区间两端仍放行（收紧只针对字面形态，不是缩小合法端口区间）。
  for (const endpoint of ['http://127.0.0.1:1024', 'http://127.0.0.1:65535']) {
    assert.equal(resolveModerationVendorTarget(endpoint, 'tms').kind, 'loopback', `应放行：${endpoint}`);
  }
  for (const endpoint of [
    'https://tms.tencentcloudapi.com/',
    'http://127.0.0.1:80',
    'https://127.0.0.1:41234',
    'http://0.0.0.0:41234',
    'http://[::1]:41234',
    // N1：`Number('01024') === 1024` 会把前导零写法放进来 ⇒ 字面必须钉死（端口段以 [1-9] 开头）。
    'http://127.0.0.1:01024',
    'http://127.0.0.1:041234',
    '',
    null,
  ]) {
    assert.throws(() => resolveModerationVendorTarget(endpoint, 'tms'), (error) => error instanceof ModerationWiringError);
  }
});

test('⑦ 文本本地闸门：空/超长/非字符串/串端口 ⇒ payload_invalid 且零外呼', async () => {
  const server = await startFakeServer(() => vendorPass());
  try {
    const port = tmsPort(server.base);
    const cases = [
      tmsRequest(''),
      tmsRequest('长'.repeat(MODERATION_MAX_TEXT_CHARACTERS + 1)),
      { ...tmsRequest(), content: { text: 123 } },
      { ...tmsRequest(), content: {} },
      { ...tmsRequest(), kind: 'ims' },
      {},
      null,
    ];
    for (const request of cases) {
      const error = await captureFailure(() => port.evaluate(request));
      assert.equal(error.model_failure, 'payload_invalid', `未拒绝：${JSON.stringify(request)?.slice(0, 40)}`);
      assert.equal(error.result_may_have_been_processed, false);
    }
    assert.equal(server.state.requests.length, 0, '全部本地拒绝，一次都没有外呼');
  } finally {
    await server.close();
  }
});

// ===========================================================================
// 10. 构造期快照（N2）与脱敏序列化（N5）
// ===========================================================================

test('N2 快照：构造后改写 profile.bizType 不影响线上 BizType 与端口自述', async () => {
  const server = await startFakeServer(() => vendorPass());
  try {
    const profile = { endpoint: server.base, ...TEXT_PROFILE_BASE };
    const port = createLiveModerationTextPort({ policy: POLICY, profile, credentials: { ...CREDENTIALS } });
    profile.bizType = 'mutated BAD/biz';
    await port.evaluate(tmsRequest());
    assert.equal(JSON.parse(server.state.requests[0].body).BizType, TEXT_PROFILE_BASE.bizType);
    assert.equal(port.provider.biz_type, TEXT_PROFILE_BASE.bizType);
    assert.equal(Object.isFrozen(port.provider), true);
    assert.equal(Object.isFrozen(profile), false, '快照是拷贝：不得反过来冻结调用方对象');
  } finally {
    await server.close();
  }
});

test('N2 快照：构造后改写 credentials.secretKey 不改签名（端口持有的是拷贝）', async () => {
  const server = await startFakeServer(() => vendorPass());
  try {
    const credentials = { ...CREDENTIALS };
    const port = createLiveModerationTextPort({
      policy: POLICY,
      profile: { endpoint: server.base, ...TEXT_PROFILE_BASE },
      credentials,
      now: () => 1_700_000_000_000,
    });
    await port.evaluate(tmsRequest());
    credentials.secretKey = 'mutated-secret-key-must-not-sign';
    await port.evaluate(tmsRequest());
    assert.equal(server.state.requests.length, 2);
    assert.equal(server.state.requests[1].body, server.state.requests[0].body);
    assert.equal(server.state.requests[1].headers.authorization, server.state.requests[0].headers.authorization);
    assert.equal(port.seams.credentials.secretKey, CREDENTIALS.secretKey);
    assert.equal(Object.isFrozen(port.seams.credentials), true);
    assert.equal(Object.isFrozen(credentials), false);
  } finally {
    await server.close();
  }
});

test('N2 快照：构造后改写 profile.timeoutMs 不会缩短已构造端口的超时', async () => {
  let captured = null;
  const fetchImpl = async (_url, init) => {
    captured = init;
    return new Response(
      JSON.stringify({ Response: { RequestId: 'req-1', Suggestion: 'Pass', Label: 'Normal', Score: 99 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  const profile = { endpoint: 'http://127.0.0.1:41234', ...TEXT_PROFILE_BASE };
  const port = createLiveModerationTextPort({ policy: POLICY, profile, credentials: { ...CREDENTIALS }, fetchImpl });
  profile.timeoutMs = 1;
  await port.evaluate(tmsRequest());
  assert.equal(port.provider.timeout_ms, TEXT_PROFILE_BASE.timeoutMs);
  await new Promise((done) => setTimeout(done, 50));
  assert.equal(captured.signal.aborted, false, '超时信号仍是构造期快照的 1000ms，不应在 1ms 后中止');
});

test('N5 脱敏序列化：JSON.stringify(port) 不含 SecretKey/SecretId，凭据只留 redacted 标记', () => {
  const port = createLiveModerationTextPort({
    policy: POLICY,
    profile: { endpoint: 'http://127.0.0.1:41234', ...TEXT_PROFILE_BASE },
    credentials: CREDENTIALS,
  });
  const text = JSON.stringify(port);
  assert.equal(text.includes(CREDENTIALS.secretKey), false, 'SecretKey 不得出现在序列化结果里');
  assert.equal(text.includes(CREDENTIALS.secretId), false, 'SecretId 也不得出现在序列化结果里');
  const view = JSON.parse(text);
  assert.equal(view.seams.credentials.kind, 'redacted');
  assert.equal(view.kind, 'tms');
  assert.equal(view.provider.biz_type, TEXT_PROFILE_BASE.bizType);
  assert.equal(view.seams.liveGate.source, POLICY.source);
  // 端口自己仍然按字段持有凭据（签名需要），只是不参与序列化。
  assert.equal(port.seams.credentials.secretKey, CREDENTIALS.secretKey);
});
