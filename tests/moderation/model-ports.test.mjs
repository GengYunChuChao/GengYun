/**
 * GY-I14 模型层（第二片）· **端口契约与"默认关闭"的结构性证据**。
 *
 * 本文件要证明的不是"我们记得别联网"，而是**结构上不可能联网**：
 *   1) 本包对真实网络 seam（fetchImpl / credentials / liveGate / now）**没有任何默认实现**
 *      （`MODEL_PORT_SEAM_DEFAULTS` 全为 `null`）⇒"默认关闭"不依赖任何运行期开关；
 *   2) 本包源码里**没有**任何网络原语、环境变量读取或凭据常量（逐文件正则扫描，零命中）；
 *   3) 本包**不导出**任何端口实现；
 *   4) 仓库内（services/api、apps/admin、miniprogram、tools）**除受信的审核域装配路径
 *      `services/api/src/moderation/**`（GY-I14 装配片）外没有任何**合流层调用点**
 *      ⇒ 应用装配路径未接线；该受信消费者经 `GET /jobs/{id}` 只读暴露结论，
 *      **真实供应商仍未接线**（real 整域 fail-closed 503），不可读成"AI 筛查已上线"。
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

/**
 * 本片**模型合流**的对外 API 符号（返修 3 · 监工 `4248262118`）。
 *
 * 判据从"扫 `packages/moderation` 这个包路径"改成"扫**模型合流的 API 符号**"：
 * 已合并的 #94（community）等线**合法使用规则层**（`evaluateHardRules` / `evaluateReReview` /
 * `isPublishable` / `deriveRuleVersion` …），它们引用同一个包路径但**不是本片模型合流的消费者**，
 * 用包路径当判据会把合法消费误判为越界。这里只认"本片模型合流"的符号。
 */
const MODEL_MERGE_API_SYMBOLS = Object.freeze([
  // 合流与合法性
  'mergeModeration',
  'mergeReasonCodes',
  'checkMergedContractShape',
  'checkMergedInvariant',
  'mergedFailureCodes',
  'MERGED_FAILURE_REASON_CODES',
  // 放行/复用闸门
  'isModelLayerPublishable',
  'evaluateModelReReview',
  'modelBindingOf',
  // 输入绑定
  'evaluateBoundHardRules',
  'bindRuleResult',
  'moderationInputDigest',
  'isDerivedInputDigest',
  'verifyInputBinding',
  'readInputBinding',
  'INPUT_BINDING_SCHEMA',
  'requiredModelPortKinds',
  'modelExecutionEvidence',
  // 端口与回报
  'MODEL_PORT_SEAMS',
  'MODEL_PORT_SEAM_DEFAULTS',
  'MODEL_REASON_CODES',
  'validateModelPort',
  'classifyModelFailure',
  'buildModelRequest',
  'normalizeMediaRef',
  'normalizeModelVerdict',
  'MODEL_VERDICT_LABELS',
  // prompt 版本（模型层增量）
  'derivePromptVersion',
  'derivePromptVersionForIds',
  'isDerivedPromptVersion',
  'PROMPT_VERSIONS_BY_ID',
  'PROMPT_DEFINITIONS',
  'promptDefinition',
]);

/** 在一段源码文本里找出"本片模型合流接线"命中的符号（词边界匹配，避免子串误报）。 */
function findModelMergeWiring(text) {
  if (typeof text !== 'string') return [];
  const hits = [];
  for (const symbol of MODEL_MERGE_API_SYMBOLS) {
    if (new RegExp(`\\b${symbol}\\b`).test(text)) hits.push(symbol);
  }
  return hits;
}

/**
 * GY-I14 装配片（#14 · HTTP 审核域）更新本控制的口径（2026-10-14）——**这是"前提被达成后
 * 对既有负控制的同步更新"，不是绕过或放宽**：
 *
 *   - **原判据**：全仓（services/apps/miniprogram/tools）**零命中**模型合流 API 符号；
 *   - **它当时的前提**：模型层片的边界声明是"**本包暂无 HTTP 消费者**、应用装配路径未接线"，
 *     所以"零命中"等价于"还没有人接线"；
 *   - **前提如何被本任务达成**：`#14` 的 HTTP 装配片**按设计**给模型层接入**唯一受信消费者**
 *     ——`services/api/src/moderation/**`（审核域；结论经 `GET /jobs/{id}` 只读暴露，
 *     real 模式整域 fail-closed）。不引用这些符号就不可能完成装配 ⇒ 该负控制必须同步；
 *   - **改动只放宽"受信装配路径"这一处**：白名单是**逐个文件**列出的（不是目录通配），
 *     其余判据与负例一律不变——其它任何目录（#15 `community/**`、#18 `admin/**`、
 *     `tools/**`、`apps/**`、`miniprogram/**`）以及**该目录里未列出的新文件**命中仍判失败，
 *     防止绕过审核域直连模型层；
 *   - **一行回退**：删除下面这个文件清单即可恢复"全仓零命中"。
 */
const SANCTIONED_MODEL_CONSUMER_FILES = new Set([
  '/services/api/src/moderation/service.ts',
  '/services/api/src/moderation/provider.ts',
  '/services/api/src/moderation/decisions.ts',
  '/services/api/src/moderation/callback.ts',
  '/services/api/src/moderation/types.ts',
  '/services/api/src/moderation/packages.d.ts',
]);

test('文书边界：除受信装配路径（services/api/src/moderation/** 的受信文件清单）外，全仓不得出现"本片模型合流"的消费者', () => {
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
      const relative = file.replace(repoRoot, '').replaceAll('\\', '/');
      if (SANCTIONED_MODEL_CONSUMER_FILES.has(relative)) continue;
      const found = findModelMergeWiring(readFileSync(file, 'utf8'));
      if (found.length > 0) hits.push(`${file.replace(repoRoot, '')} :: ${found.join(',')}`);
    }
  }
  assert.deepEqual(
    hits,
    [],
    '除受信装配路径 services/api/src/moderation/** 的受信文件外，不应存在模型合流接线（规则层引用不算）',
  );
});

test('文书边界判据有精度也有牙齿：合法规则层消费放行、真实模型合流接线被抓', () => {
  // 合法（真实形态，取自已合并 #94 的 community 消费方）：引用同一个包，但只消费**规则层**。
  const legitRuleLayerConsumer = [
    "import {",
    '  RULES,',
    '  checkDecisionInvariant,',
    '  deriveRuleVersion,',
    '  evaluateHardRules,',
    '  evaluateReReview,',
    '  isPublishable,',
    '  makeQuarantineResult,',
    '  missingContractFields,',
    "} from '../../../../packages/moderation/index.mjs';",
  ].join('\n');
  assert.deepEqual(findModelMergeWiring(legitRuleLayerConsumer), [], '合法规则层消费不得被判越界');

  // 真实模型合流接线（三种形态）必须被抓。
  assert.deepEqual(
    findModelMergeWiring("import { mergeModeration } from '../../../../packages/moderation/merge.mjs';"),
    ['mergeModeration'],
  );
  assert.deepEqual(
    findModelMergeWiring('const merged = await mergeModeration(ruleResult, { content });'),
    ['mergeModeration'],
  );
  assert.deepEqual(
    findModelMergeWiring('if (!checkMergedInvariant(record, { input }).ok) return refuse();'),
    ['checkMergedInvariant'],
  );
  assert.equal(
    findModelMergeWiring('await isModelLayerPublishable(record, options);').includes('isModelLayerPublishable'),
    true,
  );
  assert.equal(findModelMergeWiring('evaluateBoundHardRules(input, options)').includes('evaluateBoundHardRules'), true);
  // 词边界：相似但不同的名字不得误报。
  assert.deepEqual(findModelMergeWiring('mergeModerationDraft(); checkMergedInvariantStatus();'), []);
  // 白名单本身：逐个文件列出（不是目录通配）——未列出的新文件、以及其它目录一律不在白名单。
  const sanctioned = (relative) => SANCTIONED_MODEL_CONSUMER_FILES.has(relative.replaceAll('\\', '/'));
  assert.equal(sanctioned('\\services\\api\\src\\moderation\\service.ts'), true, '审核域装配片是受信消费者');
  assert.equal(sanctioned('/services/api/src/moderation/evil.ts'), false, '该目录里未列出的新文件不在白名单');
  assert.equal(sanctioned('/services/api/src/community/service.ts'), false, '#15 社区线不在白名单');
  assert.equal(sanctioned('/services/api/src/admin/ops/service.ts'), false, '#18 后台线不在白名单');
  assert.equal(sanctioned('/tools/verify-moderation.mjs'), false, 'tools 不在白名单');
});

test('文书边界：已合并 #94 的 community 消费者是**合法规则层消费**（真实文件对证）', () => {
  const dir = join(repoRoot, 'services', 'api', 'src', 'community');
  let files = [];
  try {
    files = walkFiles(dir, '.ts');
  } catch {
    files = [];
  }
  assert.ok(files.length >= 5, `夹具前提：community 文件应存在（实际 ${files.length}）`);
  const consumesRulePackage = files.filter((file) => readFileSync(file, 'utf8').includes('packages/moderation'));
  assert.ok(consumesRulePackage.length > 0, '确实存在引用规则包的合法消费者（这正是旧判据误判的对象）');
  const wiring = files.flatMap((file) =>
    findModelMergeWiring(readFileSync(file, 'utf8')).map((symbol) => `${file.replace(repoRoot, '')}::${symbol}`),
  );
  assert.deepEqual(wiring, [], '合法规则层消费方不得被当成模型合流接线');
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
