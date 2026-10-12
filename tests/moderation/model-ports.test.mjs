/**
 * GY-I14 模型层（第二片）· **端口契约与"默认关闭"的结构性证据**。
 *
 * 本文件要证明的不是"我们记得别联网"，而是**结构上不可能联网**：
 *   1) 本包对真实网络 seam（fetchImpl / credentials / liveGate / now）**没有任何默认实现**
 *      （`MODEL_PORT_SEAM_DEFAULTS` 全为 `null`）⇒"默认关闭"不依赖任何运行期开关；
 *   2) 本包源码里**没有**任何网络原语、环境变量读取或凭据常量（逐文件正则扫描，零命中）；
 *   3) 本包**不导出**任何端口实现；
 *   4) 仓库内（services/api、apps/admin、miniprogram、tools）**没有任何**合流层调用点
 *      ⇒ 本包暂无 HTTP 消费者、应用装配路径未接线（不可读成"AI 筛查已上线"）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import * as moderation from '../../packages/moderation/index.mjs';
import {
  MEDIA_REF_FIELDS,
  MODEL_FAILURE_CLASSES,
  MODEL_FAILURE_REASON_CODE_BY_CLASS,
  MODEL_PORT_KINDS,
  MODEL_PORT_REQUIRED_FIELDS,
  MODEL_PORT_SEAMS,
  MODEL_PORT_SEAM_DEFAULTS,
  MODEL_PORT_ENTRY,
  buildModelRequest,
  classifyModelFailure,
  modelFailureReasonCode,
  normalizeMediaRef,
  validateModelPort,
} from '../../packages/moderation/model-ports.mjs';
import { MODEL_REASON_CODES } from '../../packages/moderation/model-reason-codes.mjs';
import { MODEL_REPORTED_FIELDS, MODEL_VERDICT_LABELS, normalizeModelVerdict } from '../../packages/moderation/model-verdict.mjs';
import { PROMPT_DEFINITIONS } from '../../packages/moderation/prompts.mjs';
import { makePort, modelFailureError } from './_model-fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const packageDir = join(repoRoot, 'packages', 'moderation');

/** 网络原语／凭据扫描规则（只扫 `.mjs` 源码文本）。 */
const NETWORK_PATTERNS = [
  { label: 'HTTP 客户端调用', pattern: /\bfetch\s*\(/ },
  { label: 'Node HTTP 模块', pattern: /node:https?['"]/ },
  { label: 'require("http")', pattern: /require\(\s*['"]https?['"]\s*\)/ },
  { label: 'XMLHttpRequest', pattern: /XMLHttpRequest/ },
  { label: '环境变量读取', pattern: /process\.env/ },
  { label: '第三方 HTTP 客户端', pattern: /\bundici\b|\baxios\b|\bgot\b|node-fetch/ },
  { label: '裸 TCP 连接', pattern: /createConnection|net\.connect/ },
  { label: '绝对 URL 字面量', pattern: /https?:\/\// },
];

function walkFiles(dir, extension, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, extension, out);
    else if (entry.name.endsWith(extension)) out.push(full);
  }
  return out;
}

test('默认关闭：本包对真实网络 seam 没有任何默认实现（全部为 null）', () => {
  assert.deepEqual([...MODEL_PORT_SEAMS], ['fetchImpl', 'credentials', 'liveGate', 'now']);
  assert.deepEqual(Object.keys(MODEL_PORT_SEAM_DEFAULTS).sort(), [...MODEL_PORT_SEAMS, MODEL_PORT_ENTRY].sort());
  for (const [seam, value] of Object.entries(MODEL_PORT_SEAM_DEFAULTS)) {
    assert.equal(value, null, `${seam} 不得有默认实现（默认关闭必须靠"类型上就没有实现"）`);
  }
});

test('默认关闭：包内源码零命中网络原语与环境变量读取（结构性证据，非口头声明）', () => {
  const files = walkFiles(packageDir, '.mjs');
  assert.ok(files.length >= 10, `本包源文件数异常：${files.length}`);
  const hits = [];
  for (const file of files) {
    if (statSync(file).size > 512 * 1024) continue;
    const text = readFileSync(file, 'utf8');
    for (const rule of NETWORK_PATTERNS) {
      if (rule.pattern.test(text)) hits.push(`${file.replace(repoRoot, '')} :: ${rule.label}`);
    }
  }
  assert.deepEqual(hits, []);
});

test('默认关闭：本包不导出任何端口实现（没有 create*Port 之类的工厂）', () => {
  const suspicious = Object.keys(moderation).filter(
    (name) => /^create/i.test(name) && /port/i.test(name),
  );
  assert.deepEqual(suspicious, []);
  // 端口入口名只是一个字符串常量；真正的实现必须来自注入方。
  assert.equal(MODEL_PORT_ENTRY, 'evaluate');
  assert.equal(typeof moderation.mergeModeration, 'function');
  assert.equal(moderation.MODEL_PORT_SEAM_DEFAULTS.evaluate, null);
});

test('文书边界：仓库内没有任何合流层调用点（应用装配未接线，暂无 HTTP 消费者）', () => {
  const scanRoots = ['services', 'apps', 'miniprogram', 'tools'];
  const hits = [];
  for (const root of scanRoots) {
    const dir = join(repoRoot, root);
    let files = [];
    try {
      files = walkFiles(dir, '.mjs')
        .concat(walkFiles(dir, '.cjs'))
        .concat(walkFiles(dir, '.js'))
        .concat(walkFiles(dir, '.ts'));
    } catch {
      continue;
    }
    for (const file of files) {
      if (file.includes('node_modules')) continue;
      const text = readFileSync(file, 'utf8');
      if (text.includes('mergeModeration') || text.includes('packages/moderation')) {
        hits.push(file.replace(repoRoot, ''));
      }
    }
  }
  assert.deepEqual(hits, [], '本片不注册路由、不改 services/api/**，不应存在任何消费者');
});

// ---------------------------------------------------------------------------
// validateModelPort
// ---------------------------------------------------------------------------

const PORT_CASES = [
  { name: '端口不是对象', port: 'tms', expectValid: false, code: 'MODEL_LAYER_PORT_INVALID' },
  { name: 'kind 越界', port: makePort({ kind: 'xms' }), expectValid: false, code: 'MODEL_LAYER_PORT_INVALID' },
  { name: 'kind 与用途不符', port: makePort({ kind: 'ims' }), expectedKind: 'tms', expectValid: false, code: 'MODEL_LAYER_PORT_INVALID' },
  { name: 'evaluate 缺失', port: makePort({ drop: ['evaluate'] }), expectValid: false, code: 'MODEL_LAYER_PORT_INVALID' },
  { name: 'seams 缺失', port: makePort({ drop: ['seams'] }), expectValid: false, code: 'MODEL_LAYER_PORT_INVALID' },
  { name: 'seams.now 未声明', port: makePort({ seams: { fetchImpl: () => {}, credentials: {}, liveGate: {} } }), expectValid: false, code: 'MODEL_LAYER_PORT_INVALID' },
  { name: 'provider 缺失', port: makePort({ drop: ['provider'] }), expectValid: false, code: 'MODEL_LAYER_PORT_INVALID' },
  { name: 'provider.synthetic 非布尔', port: makePort({ provider: { synthetic: 'yes' } }), expectValid: false, code: 'MODEL_LAYER_PORT_INVALID' },
  { name: 'model_version 为空串', port: makePort({ model_version: '' }), expectValid: false, code: 'MODEL_VERSION_MISSING' },
  { name: 'model_version 超 80', port: makePort({ model_version: 'v'.repeat(81) }), expectValid: false, code: 'MODEL_VERSION_MISSING' },
  { name: 'BizType 未核验', port: makePort({ provider: { biz_type_selection_verified: false } }), expectValid: false, code: 'MODEL_BIZTYPE_UNVERIFIED' },
  { name: '合法端口', port: makePort(), expectValid: true, code: null },
];

for (const item of PORT_CASES) {
  test(`validateModelPort：${item.name}`, () => {
    const report = validateModelPort(item.port, item.expectedKind ?? 'tms');
    assert.equal(typeof report.valid, 'boolean');
    assert.equal(report.valid, item.expectValid, `原因码：${report.reason_codes.join(',')}`);
    if (item.code !== null) {
      assert.equal(report.reason_codes.includes(item.code), true, `缺 ${item.code}`);
    }
    for (const code of report.reason_codes) {
      assert.equal(typeof code, 'string');
      assert.equal(MODEL_REASON_CODES.includes(code), true, `${code} 不在模型层闭集`);
    }
    assert.equal(report.details.length >= report.reason_codes.length, true);
  });
}

test('validateModelPort：合法端口的 provider 声明被原样回报（供证据留痕）', () => {
  const report = validateModelPort(makePort(), 'tms');
  assert.equal(report.valid, true);
  assert.equal(report.synthetic, true);
  assert.equal(report.timeout_ms, 1000);
  assert.equal(report.model_version, 'synthetic-tms-model@1.0');
});

// ---------------------------------------------------------------------------
// classifyModelFailure / modelFailureReasonCode
// ---------------------------------------------------------------------------

const FAILURE_CLASS_CASES = [
  { name: 'TimeoutError 名字', error: Object.assign(new Error('x'), { name: 'TimeoutError' }), expected: 'timeout' },
  { name: 'ETIMEDOUT 码', error: Object.assign(new Error('x'), { code: 'ETIMEDOUT' }), expected: 'timeout' },
  { name: 'HTTP 401', error: Object.assign(new Error('x'), { http_status: 401 }), expected: 'auth_failed' },
  { name: 'HTTP 403', error: Object.assign(new Error('x'), { status: 403 }), expected: 'auth_failed' },
  { name: 'HTTP 429', error: Object.assign(new Error('x'), { statusCode: 429 }), expected: 'quota_exceeded' },
  { name: 'HTTP 400', error: Object.assign(new Error('x'), { status: 400 }), expected: 'payload_invalid' },
  { name: 'HTTP 413', error: Object.assign(new Error('x'), { status: 413 }), expected: 'payload_invalid' },
  { name: 'QUOTA 码', error: Object.assign(new Error('x'), { code: 'QUOTA_EXCEEDED' }), expected: 'quota_exceeded' },
  { name: '显式声明', error: modelFailureError('auth_failed'), expected: 'auth_failed' },
  { name: '未知异常', error: new Error('x'), expected: 'port_error' },
  { name: '非 Error 值', error: 'boom', expected: 'port_error' },
  { name: 'undefined', error: undefined, expected: 'port_error' },
];

for (const item of FAILURE_CLASS_CASES) {
  test(`classifyModelFailure：${item.name} ⇒ ${item.expected}`, () => {
    const actual = classifyModelFailure(item.error);
    assert.equal(typeof actual, 'string');
    assert.equal(actual, item.expected);
    assert.equal(MODEL_FAILURE_CLASSES.includes(actual), true);
    const code = modelFailureReasonCode(actual);
    assert.equal(typeof code, 'string');
    assert.equal(MODEL_FAILURE_REASON_CODE_BY_CLASS[actual], code);
    assert.equal(MODEL_REASON_CODES.includes(code), true);
  });
}

test('modelFailureReasonCode：未知类别回落 MODEL_PORT_ERROR，绝不回落成"通过"', () => {
  assert.equal(modelFailureReasonCode('something_new'), 'MODEL_PORT_ERROR');
  assert.equal(modelFailureReasonCode(undefined), 'MODEL_PORT_ERROR');
  assert.equal(modelFailureReasonCode(null), 'MODEL_PORT_ERROR');
  assert.notEqual(modelFailureReasonCode(undefined), null);
});

test('模型层原因码闭集本身合规：1..80 字符、互不重复、且与规则层闭集零重叠', async () => {
  const { RULE_REASON_CODES, FAIL_CLOSED_REASON_CODES } = await import('../../packages/moderation/constants.mjs');
  assert.equal(new Set(MODEL_REASON_CODES).size, MODEL_REASON_CODES.length);
  for (const code of MODEL_REASON_CODES) {
    assert.equal(typeof code, 'string');
    assert.ok(code.length >= 1 && code.length <= 80, `${code} 长度越界`);
    assert.equal(code.startsWith('MODEL_'), true);
    assert.equal(RULE_REASON_CODES.includes(code), false, `${code} 与规则层命中码重叠`);
    assert.equal(FAIL_CLOSED_REASON_CODES.includes(code), false, `${code} 与规则层 fail-closed 码重叠`);
  }
});

// ---------------------------------------------------------------------------
// buildModelRequest / normalizeMediaRef / normalizeModelVerdict
// ---------------------------------------------------------------------------

test('buildModelRequest：文本请求带正文，图片请求只带不透明引用、**不带字节**', () => {
  const prompt = PROMPT_DEFINITIONS.text_moderation;
  const textRequest = buildModelRequest({
    kind: 'tms',
    prompt,
    prompt_version: 'mp1+sha256:' + 'a'.repeat(32),
    target_ref: { type: 'post', id: 'p-1', revision: 1 },
    text: '合成文本',
    media_refs: [],
  });
  assert.equal(textRequest.content.text, '合成文本');
  assert.equal(textRequest.kind, 'tms');
  assert.deepEqual(textRequest.required_output_fields, [...prompt.required_output_fields]);
  assert.equal(JSON.stringify(textRequest).includes('credential'), false);

  const imagePrompt = PROMPT_DEFINITIONS.image_moderation;
  const imageRequest = buildModelRequest({
    kind: 'ims',
    prompt: imagePrompt,
    prompt_version: 'mp1+sha256:' + 'b'.repeat(32),
    target_ref: { type: 'post', id: 'p-1', revision: 1 },
    text: '合成文本',
    media_refs: [{ media_id: '22222222-2222-4222-8222-222222222222', media_revision: 1, mime: 'image/png' }],
  });
  assert.equal(Object.hasOwn(imageRequest.content, 'text'), false, '图片请求不得携带正文');
  assert.equal(Array.isArray(imageRequest.content.media_refs), true);
  assert.equal(Object.hasOwn(imageRequest.content.media_refs[0], 'bytes'), false);
  assert.equal(JSON.stringify(imageRequest).includes('base64'), false);
});

test('normalizeMediaRef：只接受不透明引用＋元数据，夹带 bytes／非图片一律拒', () => {
  const ok = normalizeMediaRef({ media_id: 'id-1', media_revision: 2, mime: 'image/jpeg' });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.ref, { media_id: 'id-1', media_revision: 2, mime: 'image/jpeg' });
  assert.deepEqual([...MEDIA_REF_FIELDS].sort(), ['bytes', 'media_id', 'media_revision', 'mime']);

  const cases = [
    ['非对象', 'image', 'MODEL_PAYLOAD_INVALID'],
    ['夹带 bytes', { media_id: 'id-1', bytes: 10 }, 'MODEL_PAYLOAD_INVALID'],
    ['未知字段', { media_id: 'id-1', mime: 'image/png', url: 'https://x' }, 'MODEL_PAYLOAD_INVALID'],
    ['缺标识', { mime: 'image/png' }, 'MODEL_PAYLOAD_INVALID'],
    ['revision 为 0', { media_id: 'id-1', media_revision: 0, mime: 'image/png' }, 'MODEL_PAYLOAD_INVALID'],
    ['非图片', { media_id: 'id-1', mime: 'video/mp4' }, 'MODEL_MEDIA_UNSUPPORTED'],
  ];
  for (const [name, item, code] of cases) {
    const report = normalizeMediaRef(item);
    assert.equal(report.ok, false, `${name} 应被拒`);
    assert.equal(report.reason_codes.includes(code), true, `${name} 缺 ${code}`);
    assert.equal(report.ref, null);
  }
});

test('normalizeModelVerdict：形状齐备但**丢弃全部自由文本**（只留计数，杜绝 PII 抄入结果）', () => {
  const raw = {
    label: 'block',
    reason_codes: ['SENSITIVE_LOOKING_CODE'],
    summary: '原文里出现了 13812345678 这样的内容',
  };
  const verdict = normalizeModelVerdict(raw, {
    required_output_fields: ['label', 'reason_codes', 'summary'],
    declared_model_version: 'synthetic-tms-model@1.0',
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.label, 'block');
  assert.deepEqual(Object.keys(verdict.reported).sort(), [...MODEL_REPORTED_FIELDS].sort());
  const serialized = JSON.stringify(verdict);
  assert.equal(serialized.includes('13812345678'), false, '自由文本不得进入结果');
  assert.equal(serialized.includes('SENSITIVE_LOOKING_CODE'), false, '模型自报原因码不得进入结果');
  assert.equal(verdict.reported.reason_code_count, 1);
  assert.equal(verdict.reported.summary_length, raw.summary.length);

  assert.deepEqual([...MODEL_VERDICT_LABELS], ['pass', 'block', 'unsure']);
});

test('normalizeModelVerdict：缺必报字段／label 越界／reason_codes 非数组 ⇒ 形状未知', () => {
  const context = { required_output_fields: ['label', 'reason_codes', 'summary'], declared_model_version: 'm@1' };
  const cases = [
    ['非对象', null],
    ['缺 label', { reason_codes: [], summary: 'x' }],
    ['label 越界', { label: 'ok', reason_codes: [], summary: 'x' }],
    ['缺 summary', { label: 'pass', reason_codes: [] }],
    ['reason_codes 非数组', { label: 'pass', reason_codes: 'x', summary: 's' }],
  ];
  for (const [name, raw] of cases) {
    const verdict = normalizeModelVerdict(raw, context);
    assert.equal(verdict.ok, false, `${name} 应判形状未知`);
    assert.equal(verdict.reason_codes.includes('MODEL_RESPONSE_SHAPE_UNKNOWN'), true, `${name} 缺形状码`);
  }
});

test('normalizeModelVerdict：unsure ⇒ MODEL_NOT_EVALUATED（"没结论"≠"通过"）', () => {
  const verdict = normalizeModelVerdict(
    { label: 'unsure', reason_codes: [], summary: 'synthetic unsure' },
    { required_output_fields: ['label', 'reason_codes', 'summary'], declared_model_version: 'm@1' },
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.label, 'unsure');
  assert.equal(verdict.reason_codes.includes('MODEL_NOT_EVALUATED'), true);
});

test('端口种类闭集与必填字段清单稳定（变更即需同步文档与用例）', () => {
  assert.deepEqual([...MODEL_PORT_KINDS], ['tms', 'ims']);
  assert.deepEqual([...MODEL_PORT_REQUIRED_FIELDS].sort(), ['evaluate', 'kind', 'model_version', 'provider', 'seams']);
});
