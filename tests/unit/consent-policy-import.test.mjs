/**
 * `consent_policies` 导入路径的测试：**纯逻辑全量** + **真 PG17 集成四连**。
 *
 * ## 为什么这条路径值得一套专门的门禁
 *
 * `public.consent_policies` 是四类用途（`CONSENT_PURPOSES` 闭集）的**第一道闸**：`privacy/grant-pg.ts`
 * 的 `persistConsentGrant` 在库里找不到「enabled + reviewed_at<=now + valid_from<=now + valid_until>now」
 * 的行就抛 `CONSENT_REQUIRED` ⇒ `POST /posts`、媒体上传、OCR/识别/问答外发全部 403，审核代码根本不执行。
 * 而这张表在 `0009` 里明令「No production policy or recipient seeds」，产品代码/后台路由/运维工具/种子
 * 都没有写入途径 —— 全仓唯一写过它的是测试夹具。`tools/import-consent-policy.mjs` 是补上的那条路径，
 * 所以它的每一条约束都必须有对着的用例，否则「导入了」和「闸门开了」就是两件事。
 *
 * ## 两个部分
 *
 * ① **纯逻辑**（`tools/lib/consent-policy-import.mjs`，零 I/O）：闭集来自代码真值、正文强校验、
 *    sha 自算与行尾无关、版本自然序与单调、幂等判定、`--enable` 的单条语义、绑定形状、
 *    `verified` 冒充夹具的启发式、只能告警不能拒绝的两件事、报告不含正文。
 * ② **真 PG17**（本机临时 `initdb` 簇 + 真 `0001/0003/0009` 迁移 + 真命令子进程）：
 *    `dry-run → apply → 重放(unchanged) → 失败回滚` 四连，另加版本冲突、原地改正文被触发器挡住、
 *    复核主体不存在、绑定指向不存在的接收方、以及「`external_inference` 空绑定」的告警。
 *
 * ## 纪律
 *
 * - ⛔ 不内置任何政策正文：样品正文只有 `syntheticBody()` / `neutralBody()` 两处函数，**显式标注
 *   synthetic**，运行时写进系统临时区的清单，**不入仓**、不写进库（表里只有 sha256）。
 * - ⛔ 不依赖 `process.cwd()`：仓库根由本文件位置推出。集群数据根取自 `GY_CONSENT_IMPORT_PG_ROOT`
 *   或系统临时区（⛔ 不往仓内建库）。
 * - ⛔ 不依赖未清的环境变量：派生子进程前显式删掉 `CI` / `GITHUB_ACTIONS` / `CONTINUOUS_INTEGRATION`
 *   （三者任一命中都会让「写模式」类的门禁拒绝执行），也不继承外部的 `DATABASE_URL`。
 * - 拿不到 PG 二进制时**显式 skip 并打印原因**，不静默通过；跳过路径本身也有正控制用例守着。
 *
 * 单跑：`node --test tests/unit/consent-policy-import.test.mjs`
 * 指定集群：`$env:GY_PG_BIN='<...>/pgsql/bin'`（本机已实测 17.11）。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { CONSENT_PURPOSES } from '../../services/api/src/privacy/consent-pg.ts';
import { RECIPIENT_CAPABILITIES, UNPUBLISHED_POLICY_VERSION } from '../../services/api/src/privacy/privacy-policy.ts';
import {
  CONSENT_PURPOSE_CLOSED_SET,
  EXIT_CODES,
  FAILURE_KINDS,
  MAX_POLICY_VERSION_CHARS,
  MIN_BODY_CHARS,
  PLAN_ACTIONS,
  POLICY_MANIFEST_KEYS,
  RECIPIENT_CAPABILITY_CLOSED_SET,
  comparePolicyVersions,
  contentSha256ForBody,
  exitCodeFor,
  isContentSha256,
  isUuid,
  maxPolicyVersion,
  normalizePolicyBody,
  planConsentPolicyImport,
  policyImportWarnings,
  readPolicyManifest,
  renderPolicyImportReport,
  validateRecipientBindings,
} from '../../tools/lib/consent-policy-import.mjs';
import { pickFreePort } from '../integration/lib/free-port.mjs';

/** 仓库根：由本文件位置推出（`tests/unit/` 的上两级）。⛔ 不用 `process.cwd()`。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOOL = join(REPO_ROOT, 'tools', 'import-consent-policy.mjs');
/** 复核人夹具（`admin_accounts.id` 形状；真库里由集成用例插一行，纯逻辑用例只验形状）。 */
const REVIEWER = '0f8fad5b-d9cb-469f-a165-70867728950e';

// ===========================================================================
// 一、纯逻辑
// ===========================================================================

/**
 * 合成样品正文。**⛔ 不是政策文本**：它显式标注 synthetic，只用来把「长度下界 + 占位词筛查」之外
 * 的路径跑通。刻意避开全部占位词（含 `placeholder` 这个词本身）。
 */
function syntheticBody(marker = 'v1') {
  const lines = [
    'SYNTHETIC TEST FIXTURE — NOT A REAL PRIVACY POLICY AND NOT FOR DISCLOSURE.',
    'This text exists only to exercise the consent-policy import path against a temporary database.',
    `Fixture marker: ${marker}.`,
    '它明确标注为 synthetic：不描述任何真实主体的数据处理活动，也不构成对用户的政策披露。',
  ];
  for (let index = 1; index <= 6; index += 1) {
    lines.push(`Synthetic paragraph ${index}: filler-free prose keeps the length floor and the screening rules off.`);
  }
  return lines.join('\n');
}

/**
 * 中性长正文：**不含**夹具措辞，用来单独触发「`source_kind=verified` 的形状是否成立」这一条。
 * 同样不是政策文本 —— 它只说「自己是一段填充叙述」。
 */
function neutralBody() {
  const lines = ['以下文字仅用于把正文长度的下界与实际内容筛查跑通，不含任何真实主体的处理活动描述。'];
  for (let index = 1; index <= 8; index += 1) {
    lines.push(`第 ${index} 段：这是一段普通的叙述性文字，用于把正文长度推到判据下界之上，既不描述真实业务，也不构成任何承诺。`);
  }
  return lines.join('\n');
}

/** 一份形状合法的清单（`synthetic`），后续用例逐字段覆盖。 */
function manifest(overrides = {}) {
  return {
    purpose: 'public_posting',
    policy_version: '2026.10-1',
    source_kind: 'synthetic',
    source_ref: 'fixture://consent-import/policy-terms',
    review_evidence_ref: 'fixture://consent-import/policy-review',
    recipient_bindings: {},
    body: syntheticBody(),
    valid_until: '2099-12-31T00:00:00Z',
    ...overrides,
  };
}

/** 读清单的便捷包装：返回 `{ ok, policy, text }`，失败信息拼成一条字符串方便断言。 */
function readManifest(overrides = {}, now = new Date('2026-10-29T00:00:00Z')) {
  const result = readPolicyManifest(manifest(overrides), { now });
  return { ...result, text: result.ok === true ? '' : result.errors.join(' / ') };
}

/** 一条完整的接收方绑定（形状与 `grant-pg` 逐项比对的那七项对齐）。 */
function binding(overrides = {}) {
  return {
    config_version: 'fixture-config-v1',
    policy_version: 'fixture-recipient-v1',
    capability: 'llm',
    retention_online_days: 0,
    retention_backup_days: 0,
    no_training_evidence_ref: 'fixture://proof/no-training',
    deletion_evidence_ref: 'fixture://proof/deletion',
    ...overrides,
  };
}

test('闭集 purpose 来自代码真值（不另抄一份），越界一律判 INVALID_POLICY', () => {
  // 真值来源：`privacy/consent-pg.ts` 的 `CONSENT_PURPOSES`（运行时 `dto()` 与 grant-pg 用的就是它）。
  assert.deepEqual([...CONSENT_PURPOSE_CLOSED_SET], [...CONSENT_PURPOSES]);
  assert.deepEqual([...CONSENT_PURPOSE_CLOSED_SET], ['recording', 'media_processing', 'external_inference', 'public_posting']);
  // 接收方能力闭集同样来自代码真值，不另抄。
  assert.deepEqual([...RECIPIENT_CAPABILITY_CLOSED_SET], [...RECIPIENT_CAPABILITIES]);

  for (const purpose of CONSENT_PURPOSE_CLOSED_SET) {
    assert.equal(readManifest({ purpose }).ok, true, `闭集成员 ${purpose} 必须通过`);
  }
  for (const bad of ['training', 'PUBLIC_POSTING', 'public_posting ', '', null, 42]) {
    const result = readManifest({ purpose: bad });
    assert.equal(result.ok, false, `非闭集 purpose ${JSON.stringify(bad)} 必须被拒`);
    assert.equal(result.code, FAILURE_KINDS.INVALID_POLICY);
    assert.match(result.text, /CONSENT_PURPOSES/);
  }
});

test('正文强校验：空 / 太短 / 占位词全部判 INVALID_POLICY', () => {
  assert.equal(readManifest({ body: '' }).ok, false);
  assert.match(readManifest({ body: '   \n\n  ' }).text, /不许为空/);

  const short = readManifest({ body: 'x'.repeat(MIN_BODY_CHARS - 1) });
  assert.equal(short.ok, false);
  assert.match(short.text, new RegExp(`太短（${MIN_BODY_CHARS - 1} < ${MIN_BODY_CHARS}`));

  // 长度够但仍是用占位标记凑出来的正文：必须是红，否则「导入了一行假政策」也能过。
  for (const token of ['TODO', 'TBD', 'FIXME', 'lorem', 'ipsum', 'placeholder', '占位', '待填', '待补']) {
    const result = readManifest({ body: `${token}\n${'a'.repeat(MIN_BODY_CHARS)}` });
    assert.equal(result.ok, false, `占位词 ${token} 必须被拒`);
    assert.match(result.text, /占位词/);
  }
  // 拉丁占位词要求词边界：`todos` 不该被当成 `todo`（避免把正常英文正文判红）。
  assert.equal(readManifest({ body: 'todos are listed here. '.repeat(20) }).ok, true);
});

test('content_sha256 由工具自算：清单里带这个键或 reviewed_by ⇒ 直接拒收', () => {
  const sha = readManifest({ content_sha256: 'a'.repeat(64) });
  assert.equal(sha.ok, false);
  assert.equal(sha.code, FAILURE_KINDS.INVALID_POLICY);
  assert.match(sha.text, /content_sha256 由工具自算/);

  // 复核主体不是清单字段：否则「清单自带 reviewer」等于让文件给自己签字。
  const reviewer = readManifest({ reviewed_by: REVIEWER });
  assert.equal(reviewer.ok, false);
  assert.match(reviewer.text, /--reviewed-by/);

  const ok = readManifest();
  assert.equal(ok.ok, true);
  assert.equal(isContentSha256(ok.policy.content_sha256), true);
  assert.equal(/^[0-9a-f]{64}$/.test(ok.policy.content_sha256), true);
});

test('sha 只由归一化正文决定：行尾差异不变、改一个字就变', () => {
  const lines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}: ${'a'.repeat(MIN_BODY_CHARS / 6)}`);
  const lf = lines.join('\n');
  const crlf = `${lines.join('\r\n')}\r\n`;
  const cr = lines.join('\r');
  assert.equal(normalizePolicyBody(crlf).includes('\r'), false);
  assert.equal(normalizePolicyBody(cr).includes('\r'), false);
  const lfSha = contentSha256ForBody(normalizePolicyBody(lf));
  assert.equal(contentSha256ForBody(normalizePolicyBody(crlf)), lfSha, 'CRLF 与 LF 必须同 sha');
  assert.equal(contentSha256ForBody(normalizePolicyBody(cr)), lfSha, 'CR 与 LF 必须同 sha');

  assert.notEqual(contentSha256ForBody(normalizePolicyBody(`${lf.slice(0, -1)}b`)), lfSha, '改一个字符 sha 必须变');

  // 尾部空白不参与哈希（归一化时被去掉），但正文中间的空白参与 —— 判据要能被解释。
  assert.equal(contentSha256ForBody(normalizePolicyBody(`${lf}\n\n  `)), lfSha);
  assert.notEqual(contentSha256ForBody(normalizePolicyBody(`${lf.slice(0, 40)} ${lf.slice(40)}`)), lfSha, '正文中间多一个空格必须改变 sha');
});

test('返回的 policy 里没有正文，只有首行长度与总长', () => {
  const ok = readManifest();
  assert.equal(ok.ok, true);
  assert.deepEqual(Object.keys(ok.policy).sort(), [
    'body_chars', 'body_first_line_chars', 'content_sha256', 'policy_version', 'purpose',
    'recipient_bindings', 'review_evidence_ref', 'source_kind', 'source_ref',
    'valid_from', 'valid_until',
  ]);
  assert.equal(ok.policy.body_chars, [...normalizePolicyBody(syntheticBody())].length);
  assert.equal(ok.policy.body_first_line_chars, [...syntheticBody().split('\n')[0]].length);
  assert.equal(JSON.stringify(ok.policy).includes('Synthetic paragraph 1'), false);
});

test('policy_version：长度上下界、空白、保留哨兵 unpublished 全部判 INVALID_POLICY', () => {
  assert.equal(readManifest({ policy_version: '' }).ok, false);
  assert.equal(readManifest({ policy_version: 'v'.repeat(MAX_POLICY_VERSION_CHARS) }).ok, true);
  assert.equal(readManifest({ policy_version: 'v'.repeat(MAX_POLICY_VERSION_CHARS + 1) }).ok, false);
  assert.equal(readManifest({ policy_version: ' v1' }).ok, false);
  assert.equal(readManifest({ policy_version: 'v 1' }).ok, false);

  const reserved = readManifest({ policy_version: UNPUBLISHED_POLICY_VERSION });
  assert.equal(reserved.ok, false);
  assert.match(reserved.text, /保留哨兵/);
});

test('valid_until / valid_from：形状、先后、以及「导入即过期」', () => {
  const now = new Date('2026-10-29T00:00:00Z');
  assert.equal(readManifest({ valid_until: undefined }, now).ok, false);
  assert.equal(readManifest({ valid_until: '2027-10-29' }, now).ok, false, '裸日期不带时区 ⇒ 拒');
  assert.equal(readManifest({ valid_until: '2027-10-29T00:00:00' }, now).ok, false, '缺时区 ⇒ 拒');
  assert.equal(readManifest({ valid_until: '2026-01-01T00:00:00Z' }, now).ok, false, '早于 now ⇒ 拒');
  assert.equal(readManifest({ valid_until: '2026-10-29T00:00:01Z' }, now).ok, true);

  const inverted = readManifest({ valid_from: '2027-06-01T00:00:00Z', valid_until: '2027-05-01T00:00:00Z' }, now);
  assert.equal(inverted.ok, false);
  assert.match(inverted.text, /valid_from 必须早于 valid_until/);

  // valid_from 缺省 ⇒ 由库钟决定（null），不是本机时钟写死一个值。
  assert.equal(readManifest({}, now).policy.valid_from, null);
  assert.equal(readManifest({ valid_from: '2026-10-01T00:00:00Z' }, now).policy.valid_from, '2026-10-01T00:00:00.000Z');
});

test('来源 / 复核证据形状与 grant-pg 的 evidence() 同口径', () => {
  // synthetic ⇒ 只认 fixture://<路径>
  assert.equal(readManifest({ source_kind: 'synthetic', source_ref: 'https://policy.gengyun.app/x' }).ok, false);
  assert.equal(readManifest({ source_kind: 'synthetic', source_ref: 'fixture://a/b' }).ok, true);
  // verified ⇒ 只认无凭据的 https URL
  assert.equal(readManifest({ source_kind: 'verified', source_ref: 'fixture://a/b', review_evidence_ref: 'fixture://a/c' }).ok, false);
  assert.equal(readManifest({
    source_kind: 'verified', source_ref: 'https://policy.gengyun.app/consent/v1', review_evidence_ref: 'https://policy.gengyun.app/review/v1', body: neutralBody(),
  }).ok, true);
  assert.equal(readManifest({ source_kind: 'verified', source_ref: 'https://user:secret@policy.gengyun.app/t', body: neutralBody() }).ok, false, 'URL 里带凭据 ⇒ 拒');
  assert.equal(readManifest({ source_kind: 'verified', source_ref: 'http://policy.gengyun.app/t', body: neutralBody() }).ok, false, 'http ⇒ 拒');
  // source_kind 闭集
  assert.equal(readManifest({ source_kind: 'official' }).ok, false);
});

test('verified 不许拿夹具冒充：不存在的域 / 夹具措辞都会被挡（启发式，不是证明）', () => {
  const badHost = readManifest({
    source_kind: 'verified', source_ref: 'https://example.invalid/terms', review_evidence_ref: 'https://policy.gengyun.app/review', body: neutralBody(),
  });
  assert.equal(badHost.ok, false);
  assert.match(badHost.text, /指向不存在的域/);

  const badWording = readManifest({
    source_kind: 'verified',
    source_ref: 'https://policy.gengyun.app/consent/v1',
    review_evidence_ref: 'https://policy.gengyun.app/review/v1',
    body: syntheticBody(),
  });
  assert.equal(badWording.ok, false);
  assert.match(badWording.text, /夹具措辞/);

  // 如实标 synthetic 时，同一份样品正文完全合法 —— 这条筛只打「冒充」，不打「诚实标注」。
  assert.equal(readManifest({ source_kind: 'synthetic', body: syntheticBody() }).ok, true);
});

test('recipient_bindings：JSON 对象 + 七个字段逐条校验（留存上限照契约）', () => {
  assert.equal(readManifest({ recipient_bindings: [] }).ok, false);
  assert.equal(readManifest({ recipient_bindings: null }).ok, false, 'null 不许被静默当成 {}');
  assert.equal(readManifest({ recipient_bindings: { 'fixture-llm': binding() } }).ok, true);
  assert.equal(readManifest({ recipient_bindings: { 'fixture-llm': { capability: 'llm' } } }).ok, false, '缺字段 ⇒ 拒');

  assert.deepEqual(validateRecipientBindings({ 'fixture-llm': binding() }, { synthetic: true }), []);
  const cases = [
    [{ capability: 'training' }, /capability/],
    [{ retention_online_days: 8 }, /retention_online_days/],
    [{ retention_backup_days: 31 }, /retention_backup_days/],
    [{ retention_online_days: 1.5 }, /retention_online_days/],
    [{ config_version: '' }, /config_version/],
    [{ policy_version: 'x'.repeat(81) }, /policy_version/],
    [{ no_training_evidence_ref: 'https://policy.gengyun.app/x' }, /no_training_evidence_ref/],
    [{ deletion_evidence_ref: 'fixture://' }, /deletion_evidence_ref/],
  ];
  for (const [overrides, pattern] of cases) {
    const errors = validateRecipientBindings({ 'fixture-llm': binding(overrides) }, { synthetic: true });
    assert.equal(errors.length > 0, true, `${JSON.stringify(overrides)} 必须被拒`);
    assert.match(errors.join(' '), pattern);
  }
  // 值不是对象
  assert.equal(validateRecipientBindings({ 'fixture-llm': 'llm' }, { synthetic: true }).length > 0, true);
  // 键太长
  assert.equal(validateRecipientBindings({ ['k'.repeat(81)]: binding() }, { synthetic: true }).length > 0, true);
});

test('键白名单：未知字段判 INVALID_POLICY，合法键集固定', () => {
  const unknown = readManifest({ enabled: true });
  assert.equal(unknown.ok, false);
  assert.match(unknown.text, /未知字段「enabled」/);
  assert.deepEqual([...POLICY_MANIFEST_KEYS].sort(), [
    'body', 'policy_version', 'purpose', 'recipient_bindings', 'review_evidence_ref',
    'source_kind', 'source_ref', 'valid_from', 'valid_until',
  ]);
});

test('清单解析失败是 CONFIG（不是内容校验）；uuid 判据单一', () => {
  assert.equal(readPolicyManifest('{ not json').code, FAILURE_KINDS.CONFIG);
  assert.equal(readPolicyManifest('[]').code, FAILURE_KINDS.CONFIG);
  assert.equal(readPolicyManifest('null').code, FAILURE_KINDS.CONFIG);

  assert.equal(isUuid(REVIEWER), true);
  assert.equal(isUuid('NOT-A-UUID'), false);
  assert.equal(isUuid(REVIEWER.toUpperCase()), false, '只认小写');
  assert.equal(isUuid(null), false);
});

test('退出码映射：四类失败码 + 成功码', () => {
  assert.deepEqual(EXIT_CODES, { OK: 0, CONFIG: 2, INVALID_POLICY: 3, POLICY_CONFLICT: 4, DB_ERROR: 5 });
  assert.equal(exitCodeFor(FAILURE_KINDS.INVALID_POLICY), 3);
  assert.equal(exitCodeFor(FAILURE_KINDS.POLICY_CONFLICT), 4);
  assert.equal(exitCodeFor(FAILURE_KINDS.DB_ERROR), 5);
  assert.equal(exitCodeFor(FAILURE_KINDS.CONFIG), 2);
  assert.equal(exitCodeFor('不是个类别'), 2, '未知类别退回 CONFIG（不静默当成功）');
});

test('版本自然序：数字段按数值比，前缀更短者小', () => {
  assert.equal(comparePolicyVersions('v2', 'v10'), -1);
  assert.equal(comparePolicyVersions('v10', 'v2'), 1);
  assert.equal(comparePolicyVersions('2026.10-1', '2026.10-2'), -1);
  assert.equal(comparePolicyVersions('v1', 'v1.1'), -1);
  assert.equal(comparePolicyVersions('v007', 'v7'), 0);
  assert.equal(comparePolicyVersions('a', 'a'), 0);
  assert.equal(comparePolicyVersions('v1', 'vX') < 0, true);
  assert.equal(comparePolicyVersions('vX', 'v1') > 0, true);
  assert.equal(maxPolicyVersion(['v2', 'v10', 'v9']), 'v10');
  assert.equal(maxPolicyVersion([]), null);
});

/** 现库行的简写（`planConsentPolicyImport` 的 `existing` 元素形状）。 */
const row = (policy_version, sha, enabled = false, reviewed_at = null) => ({ policy_version, content_sha256: sha, enabled, reviewed_at });

test('幂等判定：同 (purpose, policy_version) 同正文 ⇒ unchanged，且不要求任何写操作', () => {
  const { policy } = readManifest();
  const existing = [row('2026.10-1', policy.content_sha256)];
  const plan = planConsentPolicyImport({ policy, existing, wantEnable: false });
  assert.equal(plan.ok, true);
  assert.equal(plan.action, PLAN_ACTIONS.UNCHANGED);
  assert.deepEqual(plan.disabled_others, [], 'unchanged 不许顺手关别人（否则就不是零行改动）');
  assert.equal(plan.enabled_after, false);

  // 已存在 + 未启用 + 再要求启用 ⇒ 那是 enable（不是 unchanged），但也不是「再插一行」。
  const enable = planConsentPolicyImport({ policy, existing, wantEnable: true, reviewedBy: REVIEWER });
  assert.equal(enable.ok, true);
  assert.equal(enable.action, PLAN_ACTIONS.ENABLE);
  assert.deepEqual(enable.disabled_others, []);

  // 已经启用 + 再要求启用 ⇒ 仍然 unchanged（重放不制造第二次写）。
  const alreadyEnabled = planConsentPolicyImport({
    policy, existing: [row('2026.10-1', policy.content_sha256, true, new Date())], wantEnable: true, reviewedBy: REVIEWER,
  });
  assert.equal(alreadyEnabled.action, PLAN_ACTIONS.UNCHANGED);
  assert.equal(alreadyEnabled.enabled_after, true);
  assert.deepEqual(alreadyEnabled.disabled_others, []);
});

test('同版本不同正文 ⇒ POLICY_CONFLICT（不许静默覆盖历史）', () => {
  const { policy } = readManifest();
  const plan = planConsentPolicyImport({
    policy, existing: [row('2026.10-1', 'f'.repeat(64), false, new Date())], wantEnable: false,
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.code, FAILURE_KINDS.POLICY_CONFLICT);
  assert.match(plan.reason, /正文 sha256 不同/);
  assert.match(plan.reason, /新的 policy_version/);
});

test('版本单调不回退：新版本必须严格大于该 purpose 已有最大版本', () => {
  const { policy } = readManifest({ policy_version: '2026.10-0' });
  const newer = [row('2026.10-1', 'a'.repeat(64))];
  const rollback = planConsentPolicyImport({ policy, existing: newer, wantEnable: false });
  assert.equal(rollback.ok, false);
  assert.equal(rollback.code, FAILURE_KINDS.POLICY_CONFLICT);
  assert.match(rollback.reason, /回退/);

  const { policy: next } = readManifest({ policy_version: '2026.11-1' });
  assert.equal(planConsentPolicyImport({ policy: next, existing: newer, wantEnable: false }).action, PLAN_ACTIONS.INSERT);

  // 别的 purpose 的历史不影响本 purpose。
  const { policy: media } = readManifest({ purpose: 'media_processing', policy_version: '2026.10-0' });
  assert.equal(planConsentPolicyImport({ policy: media, existing: [], wantEnable: false }).action, PLAN_ACTIONS.INSERT);
});

test('--enable 的单条语义：关掉同 purpose 其它行，且不许回退到更旧的版本', () => {
  const { policy } = readManifest({ policy_version: '2026.10-2' });
  const existing = [
    row('2026.10-1', 'a'.repeat(64), true, new Date()),
    row('2026.10-2', policy.content_sha256, false, new Date()),
  ];
  const enable = planConsentPolicyImport({ policy, existing, wantEnable: true, reviewedBy: REVIEWER });
  assert.equal(enable.action, PLAN_ACTIONS.ENABLE);
  assert.deepEqual(enable.disabled_others, ['2026.10-1']);
  assert.equal(enable.enabled_after, true);

  // 不加 --enable 时只插/不动，绝不顺手关掉现役行。
  assert.equal(planConsentPolicyImport({ policy, existing, wantEnable: false }).action, PLAN_ACTIONS.UNCHANGED);

  // 目标行是旧版本（库里还有更新的）⇒ 启用它就是回退 ⇒ 冲突。
  const old = readManifest({ policy_version: '2026.10-1' });
  const rollback = planConsentPolicyImport({
    policy: old.policy,
    existing: [row('2026.10-1', old.policy.content_sha256, false, new Date()), row('2026.10-2', 'b'.repeat(64), true, new Date())],
    wantEnable: true,
    reviewedBy: REVIEWER,
  });
  assert.equal(rollback.ok, false);
  assert.equal(rollback.code, FAILURE_KINDS.POLICY_CONFLICT);
  assert.match(rollback.reason, /回退/);
});

test('--enable 必须有 --reviewed-by（0009 的 CHECK 决定），否则判 INVALID_POLICY', () => {
  const { policy } = readManifest();
  const insert = planConsentPolicyImport({ policy, existing: [], wantEnable: true });
  assert.equal(insert.ok, false);
  assert.equal(insert.code, FAILURE_KINDS.INVALID_POLICY);
  assert.match(insert.reason, /--reviewed-by/);

  // 不加 --enable 的草稿行不需要复核主体。
  assert.equal(planConsentPolicyImport({ policy, existing: [], wantEnable: false }).action, PLAN_ACTIONS.INSERT);

  // 已有行缺 reviewed_at 时，启用也要复核主体。
  assert.equal(planConsentPolicyImport({
    policy, existing: [row('2026.10-1', policy.content_sha256, false, null)], wantEnable: true,
  }).ok, false);

  assert.equal(planConsentPolicyImport({ policy, existing: [], wantEnable: true, reviewedBy: REVIEWER }).action, PLAN_ACTIONS.INSERT);
  // 形状不对的 uuid 在纯逻辑层就挡（不去撞数据库的 22P02）。
  const badShape = planConsentPolicyImport({ policy, existing: [], wantEnable: true, reviewedBy: 'NOT-A-UUID' });
  assert.equal(badShape.ok, false);
  assert.match(badShape.reason, /uuid/);
});

test('库钟复核：valid_until 早于 clock_timestamp() 一律拒（本机时钟说了不算）', () => {
  const { policy } = readManifest({ valid_until: '2030-01-01T00:00:00Z' });
  assert.equal(planConsentPolicyImport({
    policy, existing: [], wantEnable: false, dbNow: new Date('2029-12-31T23:59:59Z'),
  }).action, PLAN_ACTIONS.INSERT);
  const late = planConsentPolicyImport({ policy, existing: [], wantEnable: false, dbNow: new Date('2030-01-01T00:00:00Z') });
  assert.equal(late.ok, false);
  assert.equal(late.code, FAILURE_KINDS.INVALID_POLICY);
  assert.match(late.reason, /clock_timestamp/);
});

test('只能告警的两件事：external_inference 空绑定、valid_from 在未来', () => {
  const { policy: external } = readManifest({ purpose: 'external_inference' });
  const warnings = policyImportWarnings({ policy: external, dbNow: new Date() });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /recipients/);
  assert.match(warnings[0], /403/);

  // 有绑定时不再告警。
  const { policy: bound } = readManifest({ purpose: 'external_inference', recipient_bindings: { 'fixture-llm': binding() } });
  assert.deepEqual(policyImportWarnings({ policy: bound, dbNow: new Date() }), []);

  // 别的 purpose 空绑定是正常的（`public_posting` 不需要接收方）。
  const { policy: posting } = readManifest();
  assert.deepEqual(policyImportWarnings({ policy: posting, dbNow: new Date() }), []);

  // 未来生效
  const { policy: future } = readManifest({ valid_from: '2099-01-01T00:00:00Z' });
  const futureWarnings = policyImportWarnings({ policy: future, dbNow: new Date('2026-10-29T00:00:00Z') });
  assert.equal(futureWarnings.length, 1);
  assert.match(futureWarnings[0], /尚未生效/);
});

test('dry-run 报告：形状齐全，但一个字的正文都不出现', () => {
  const { policy } = readManifest();
  const plan = planConsentPolicyImport({ policy, existing: [], wantEnable: true, reviewedBy: REVIEWER });
  const lines = renderPolicyImportReport({
    policy, plan, mode: 'dry-run', file: 'synthetic.json', enabledAfter: true, reviewedBy: REVIEWER,
  });
  const text = lines.join('\n');
  for (const key of [
    'purpose', 'policy_version', 'content_sha256', 'enabled_after', 'valid_from', 'valid_until',
    'body_first_line_chars', 'body_chars', 'reviewed_by',
  ]) {
    assert.match(text, new RegExp(`^${key}=`, 'm'), `报告缺少 ${key}`);
  }
  assert.match(text, /^action=insert$/m);
  assert.match(text, /^unchanged=false$/m);
  // ⛔ 正文不得出现（首行、段首、任意一行都不行）
  for (const bodyLine of syntheticBody().split('\n')) {
    assert.equal(text.includes(bodyLine), false, 'dry-run 报告里出现了正文行');
  }
  assert.equal(text.replace(/\s/g, '').includes('SYNTHETICTESTFIXTURE'), false);

  const unchanged = renderPolicyImportReport({
    policy,
    plan: planConsentPolicyImport({ policy, existing: [row('2026.10-1', policy.content_sha256)], wantEnable: false }),
    mode: 'apply',
    file: 'synthetic.json',
    enabledAfter: false,
    reviewedBy: null,
  }).join('\n');
  assert.match(unchanged, /^unchanged=true$/m);
  assert.match(unchanged, /^action=unchanged$/m);
  assert.match(unchanged, /^enabled_after=false$/m);
  assert.match(unchanged, /^reviewed_by=\(null\)$/m);
});

// ===========================================================================
// 二、真 PG17 集成
// ===========================================================================

/**
 * PG 二进制目录：`GY_PG_BIN`（与仓内其它自起集群脚本同名）优先，其次 `<repo>/.pg17/pgsql/bin`，
 * 最后在 `PATH` 里找 `initdb`。找不到 ⇒ 显式 skip（⛔ 不静默通过）。
 */
function resolvePgBin() {
  const configured = process.env.GY_PG_BIN ?? process.env.GY_CONSENT_IMPORT_PG_BIN;
  const candidates = configured
    ? [configured]
    : [join(REPO_ROOT, '.pg17', 'pgsql', 'bin'), ...(process.env.PATH ?? '').split(delimiter).filter((dir) => dir !== '')];
  for (const dir of candidates) {
    if (existsSync(join(dir, 'initdb.exe')) || existsSync(join(dir, 'initdb'))) return dir;
  }
  return null;
}

const PG_BIN = resolvePgBin();

/** 跳过原因（非空的、以 `SKIP` 开头的字符串）：拿不到 PG 时必须打印它。 */
const SKIP_REASON = PG_BIN === null
  ? 'SKIP 真 PG17 集成：找不到 PostgreSQL 的 bin 目录（设 GY_PG_BIN 指向含 initdb 的目录，或把 initdb 放进 PATH）。纯逻辑用例不受影响。'
  : '';

/**
 * `node:test` 的选项：**有原因才给 `skip`**。
 * ⚠ 别写成 `{ skip: SKIP_REASON }` 一把梭 —— `skip: ''` 会让报告把它标成 `# SKIP`（哪怕函数体真跑了），
 * 于是「真跑过」与「跳过了」在读数上分不开。
 */
const integrationOptions = SKIP_REASON === '' ? {} : { skip: SKIP_REASON };

/**
 * 集群数据根：`GY_CONSENT_IMPORT_PG_ROOT` 优先。
 *
 * ⚠ 本机实测（2026-10-29）：`initdb` 在 **node 的 `mkdtempSync` 于 `os.tmpdir()` 下建出的目录**里
 * 会以 `initdb: error: could not create directory "…/data": Permission denied` 失败（同一台机器上
 * `E:\…` 下完全正常）。所以默认根取**仓库根的兄弟目录**（`<repo>/../.gy-consent-import-pg`），
 * ⛔ 不落系统 TEMP；`GY_CONSENT_IMPORT_PG_ROOT` 可以把它指到任何可写目录。
 */
function clusterRoot() {
  if (typeof process.env.GY_CONSENT_IMPORT_PG_ROOT === 'string' && process.env.GY_CONSENT_IMPORT_PG_ROOT !== '') {
    return process.env.GY_CONSENT_IMPORT_PG_ROOT;
  }
  return join(REPO_ROOT, '..', '.gy-consent-import-pg');
}

function pgTool(binDir, name) {
  return join(binDir, existsSync(join(binDir, `${name}.exe`)) ? `${name}.exe` : name);
}

/** 逐个文件删除（⛔ 不用递归删除：工作树里可能有指向源码的目录联接）。 */
function removeTreeByEntry(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) removeTreeByEntry(full);
    else unlinkSync(full);
  }
  rmdirSync(dir);
}

/** 派生子进程用的环境：显式清掉三个 CI 写模式触发键，且不继承外部 `DATABASE_URL`。 */
function toolEnv(databaseUrl) {
  const env = { ...process.env };
  delete env.CI;
  delete env.GITHUB_ACTIONS;
  delete env.CONTINUOUS_INTEGRATION;
  delete env.DATABASE_URL;
  delete env.GY_PG_BIN;
  delete env.GY_CONSENT_IMPORT_PG_BIN;
  if (databaseUrl !== undefined) env.DATABASE_URL = databaseUrl;
  return env;
}

function runTool(args, databaseUrl) {
  const result = spawnSync(process.execPath, [TOOL, ...args], {
    cwd: REPO_ROOT,
    env: toolEnv(databaseUrl),
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** 从 `key=value` 报告里取一个值（报告格式由 `renderPolicyImportReport` 固定）。 */
function reportValue(stdout, key) {
  const line = stdout.split(/\r?\n/).find((item) => item.startsWith(`${key}=`));
  return line === undefined ? null : line.slice(key.length + 1);
}

/** 全表快照（含 `xmin`）：用来证明「零行改动」与「失败没留半写」都是逐字段事实。 */
async function snapshot(client) {
  const { rows } = await client.query(
    `SELECT id::text,purpose,policy_version,source_kind,source_ref,content_sha256,review_evidence_ref,
            recipient_bindings::text AS recipient_bindings,valid_from,valid_until,reviewed_by::text AS reviewed_by,
            reviewed_at,enabled,updated_at,xmin::text AS xmin
       FROM public.consent_policies ORDER BY purpose,policy_version`,
  );
  return rows;
}

/** 去掉「允许变」的三列（`enabled` / `updated_at` / `xmin`）后再比其余列。 */
function stripVolatile(rows) {
  return rows.map(({ enabled, updated_at, xmin, ...rest }) => rest);
}

test('跳过路径是显式的：拿不到 PG 时必须给出以 SKIP 开头的原因', () => {
  if (PG_BIN === null) {
    console.log(SKIP_REASON);
    assert.match(SKIP_REASON, /^SKIP .*GY_PG_BIN/);
    assert.equal(SKIP_REASON.length > 20, true, '跳过原因不能是空字符串（那就成了静默通过）');
  } else {
    assert.equal(SKIP_REASON, '', '有 PG 时不该有跳过原因');
    console.log(`[consent-policy-import] 真 PG 二进制：${PG_BIN}`);
  }
});

test('真 PG17：dry-run → apply → 重放(unchanged) → 失败回滚 四连', integrationOptions, async () => {
  const root = clusterRoot();
  mkdirSync(root, { recursive: true });
  const workDir = mkdtempSync(join(root, 'gy-consent-import-'));
  const dataDir = join(workDir, 'data');
  const logFile = join(workDir, 'server.log');
  const filesDir = join(workDir, 'manifests');
  const pgBin = PG_BIN;
  let client = null;
  let started = false;
  let passed = 0;
  const say = (label) => {
    passed += 1;
    console.log(`PASS ${passed}: ${label}`);
  };

  try {
    // ── 一次性集群 ────────────────────────────────────────────────────────
    const port = await pickFreePort();
    const initdb = spawnSync(pgTool(pgBin, 'initdb'), ['-D', dataDir, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--locale=C'], { encoding: 'utf8', timeout: 180_000 });
    assert.equal(initdb.status, 0, `initdb 失败：${initdb.stderr ?? ''}`);
    const startArgs = ['-D', dataDir, '-l', logFile, '-w', '-t', '60', '-o', `-p ${port} -c listen_addresses=127.0.0.1`, 'start'];
    // ⛔ `pg_ctl` 不能给管道：它派生的 postgres 会继承管道句柄，父进程永远等不到 EOF。
    const start = spawnSync(pgTool(pgBin, 'pg_ctl'), startArgs, { stdio: 'ignore', timeout: 180_000 });
    assert.equal(start.status, 0, 'pg_ctl start 失败');
    started = true;

    const databaseUrl = `postgresql://postgres@127.0.0.1:${port}/postgres`;
    let connected = false;
    for (let attempt = 0; attempt < 100 && !connected; attempt += 1) {
      const probe = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 1000 });
      try {
        await probe.connect();
        await probe.query('SELECT 1');
        client = probe;
        connected = true;
      } catch {
        await probe.end().catch(() => {});
        await new Promise((done) => setTimeout(done, 200));
      }
    }
    assert.equal(connected, true, 'pg_ctl start 之后 20s 内连不上临时集群');
    const serverVersion = (await client.query('SHOW server_version')).rows[0].server_version;
    assert.match(serverVersion, /^17\./, `需要 PG 17（实测 ${serverVersion}）`);
    console.log(`[consent-policy-import] 临时集群：127.0.0.1:${port}，PostgreSQL ${serverVersion}，数据目录在仓外临时区`);

    // ── 真迁移：0001 / 0003 / 0009（`0009` 头注释：只依赖 0001、0003） ─────
    const migration = (name) => readFileSync(join(REPO_ROOT, 'services', 'api', 'db', 'migrations', name), 'utf8');
    for (const name of ['0001_initial_schema.sql', '0003_privacy_consent.sql', '0009_consent_policy.sql']) {
      await client.query(migration(name));
    }
    assert.equal((await client.query("SELECT to_regclass('public.consent_policies') AS table_name")).rows[0].table_name, 'consent_policies');
    assert.equal((await client.query('SELECT count(*)::int AS n FROM public.consent_policies')).rows[0].n, 0, '0009 不播种任何政策行');
    assert.equal((await client.query('SELECT count(*)::int AS n FROM public.recipients')).rows[0].n, 0, '0003 不播种任何接收方');
    // 迁移后的后台账号数：**0 行** ⇒ `--enable` 需要一个真实存在的 admin_accounts 行，而它不会自己出现。
    const adminCount = (await client.query('SELECT count(*)::int AS n FROM public.admin_accounts')).rows[0].n;
    console.log(`[consent-policy-import] 迁移后 public.admin_accounts = ${adminCount} 行（--enable 需要一行真复核人）`);
    assert.equal(adminCount, 0, '迁移不播种后台账号：--enable 的复核主体必须由运维提供');
    const reviewer = (await client.query(
      "INSERT INTO admin_accounts(login_name,credential_hash) VALUES('synthetic-consent-import-reviewer','synthetic-unused') RETURNING id::text AS id",
    )).rows[0].id;
    say(`${serverVersion} 临时簇 + 真迁移 0001/0003/0009：consent_policies 0 行、recipients 0 行、admin_accounts 0 行`);

    // ── 仓外清单（合成正文，只落在临时目录） ──────────────────────────────
    mkdirSync(filesDir, { recursive: true });
    const writeManifest = (name, overrides) => {
      const file = join(filesDir, name);
      writeFileSync(file, `${JSON.stringify(manifest(overrides), null, 2)}\n`, 'utf8');
      return file;
    };
    const bodyA = syntheticBody('A');
    const fileA = writeManifest('a.json', { body: bodyA });
    const expectedSha = contentSha256ForBody(normalizePolicyBody(bodyA));
    assert.deepEqual(await snapshot(client), []);

    // ── ① dry-run：算出形状、零行改动 ─────────────────────────────────────
    const dry = runTool(['policy', '--file', fileA], databaseUrl);
    assert.equal(dry.status, EXIT_CODES.OK, `dry-run 必须 exit 0：${dry.stderr}`);
    assert.match(dry.stdout, /^mode=dry-run$/m);
    assert.match(dry.stdout, /^action=insert$/m);
    assert.match(dry.stdout, /^unchanged=false$/m);
    assert.match(dry.stdout, /^changed_rows=0$/m);
    assert.equal(reportValue(dry.stdout, 'content_sha256'), expectedSha);
    assert.equal(reportValue(dry.stdout, 'purpose'), 'public_posting');
    assert.equal(reportValue(dry.stdout, 'policy_version'), '2026.10-1');
    assert.equal(reportValue(dry.stdout, 'enabled_after'), 'false');
    assert.equal(reportValue(dry.stdout, 'body_first_line_chars'), String([...bodyA.split('\n')[0]].length));
    // ⛔ 正文不得出现在任何输出通道
    for (const bodyLine of bodyA.split('\n')) {
      assert.equal(`${dry.stdout}${dry.stderr}`.includes(bodyLine), false, 'dry-run 输出里出现了正文行');
    }
    assert.deepEqual(await snapshot(client), [], 'dry-run 之后库里必须还是 0 行');
    say(`dry-run：exit 0、action=insert、changed_rows=0、sha 自算=${expectedSha.slice(0, 12)}…、正文零泄露`);

    // ── ①b 参数纪律：--enable 缺 --reviewed-by ⇒ exit 2；reviewed_by 不存在 ⇒ exit 3 ──
    const missingReviewer = runTool(['policy', '--file', fileA, '--apply', '--enable'], databaseUrl);
    assert.equal(missingReviewer.status, EXIT_CODES.CONFIG, '缺 --reviewed-by ⇒ exit 2');
    assert.match(missingReviewer.stderr, /--reviewed-by/);
    const ghostReviewer = runTool(['policy', '--file', fileA, '--apply', '--enable', '--reviewed-by', '11111111-2222-4333-8444-555555555555'], databaseUrl);
    assert.equal(ghostReviewer.status, EXIT_CODES.INVALID_POLICY, `复核主体不存在 ⇒ exit 3（实测 exit ${ghostReviewer.status}）：${ghostReviewer.stdout}${ghostReviewer.stderr}`);
    assert.match(ghostReviewer.stderr, /admin_accounts/);
    assert.deepEqual(await snapshot(client), [], '被拒后库里必须还是 0 行');
    say('--enable 缺 --reviewed-by ⇒ exit 2；复核主体不存在 ⇒ exit 3（应用层先查，不靠外键抛错）');

    // ── ② apply --enable：落一行并启用 ────────────────────────────────────
    const apply = runTool(['policy', '--file', fileA, '--apply', '--enable', '--reviewed-by', reviewer], databaseUrl);
    assert.equal(apply.status, EXIT_CODES.OK, `apply 必须 exit 0：${apply.stderr}`);
    assert.match(apply.stdout, /^mode=apply$/m);
    assert.match(apply.stdout, /^action=insert$/m);
    assert.match(apply.stdout, /^changed_rows=2$/m, 'insert 一行 + enable 一行');
    assert.match(apply.stdout, /^enabled_after=true$/m);
    assert.match(apply.stdout, /^transaction=commit$/m);
    const afterApply = await snapshot(client);
    assert.equal(afterApply.length, 1);
    assert.equal(afterApply[0].purpose, 'public_posting');
    assert.equal(afterApply[0].policy_version, '2026.10-1');
    assert.equal(afterApply[0].content_sha256, expectedSha, '库里的 sha 必须是工具自算的那个');
    assert.equal(afterApply[0].source_kind, 'synthetic');
    assert.equal(afterApply[0].enabled, true);
    assert.notEqual(afterApply[0].reviewed_at, null, 'enabled 行必须有 reviewed_at（0009 的 CHECK）');
    assert.equal(afterApply[0].reviewed_by, reviewer);
    assert.equal(afterApply[0].recipient_bindings, '{}');
    say('apply --enable：1 行落库、enabled=true、reviewed_at 非空、sha 与工具自算一致');

    // 闸门口的实测：`grant-pg.ts` 的当前生效政策查询能看见它（enabled + 时间窗都对）。
    const current = await client.query(
      `SELECT policy_version FROM public.consent_policies
        WHERE purpose=$1 AND enabled AND reviewed_at<=clock_timestamp()
          AND valid_from<=clock_timestamp() AND valid_until>clock_timestamp()`, ['public_posting'],
    );
    assert.deepEqual(current.rows.map((item) => item.policy_version), ['2026.10-1']);
    say('库内现役政策查询（与 grant-pg 同口径）返回这一行 ⇒ 第一道闸真的打开');

    // ── ③ 重放：unchanged=true、exit 0、零行改动（xmin 逐字段相同） ───────
    const replay = runTool(['policy', '--file', fileA, '--apply', '--enable', '--reviewed-by', reviewer], databaseUrl);
    assert.equal(replay.status, EXIT_CODES.OK, `重放必须 exit 0：${replay.stderr}`);
    assert.match(replay.stdout, /^action=unchanged$/m);
    assert.match(replay.stdout, /^unchanged=true$/m);
    assert.match(replay.stdout, /^changed_rows=0$/m);
    assert.match(replay.stdout, /^transaction=rollback（本次没有写任何行）$/m);
    const afterReplay = await snapshot(client);
    assert.deepEqual(afterReplay, afterApply, '重放必须零行改动：整行快照（含 xmin / updated_at）逐字段相同');
    assert.equal(afterReplay[0].xmin, afterApply[0].xmin, 'xmin 必须相同（UPDATE 一次就会换 xmin）');
    say('重放：unchanged=true、exit 0、changed_rows=0、xmin 与整行快照逐字段相同');

    // ── ④a 同版本不同正文：拒绝（exit 4），库内不动 ───────────────────────
    const tampered = writeManifest('a-tampered.json', { body: syntheticBody('A-tampered') });
    const conflict = runTool(['policy', '--file', tampered, '--apply'], databaseUrl);
    assert.equal(conflict.status, EXIT_CODES.POLICY_CONFLICT, `同版本不同正文必须 exit 4：${conflict.stdout}${conflict.stderr}`);
    assert.match(conflict.stderr, /POLICY_CONFLICT/);
    assert.match(conflict.stderr, /新的 policy_version/);
    assert.deepEqual(await snapshot(client), afterApply, '被拒后库内必须逐字段不变');
    say('同版本不同正文：exit 4、库内整行快照不变（不静默覆盖历史）');

    // ── ④b 版本回退：拒绝（exit 4） ───────────────────────────────────────
    const older = writeManifest('older.json', { policy_version: '2026.09-9' });
    const rollback = runTool(['policy', '--file', older, '--apply'], databaseUrl);
    assert.equal(rollback.status, EXIT_CODES.POLICY_CONFLICT, '版本回退必须 exit 4');
    assert.match(rollback.stderr, /回退/);
    assert.deepEqual(await snapshot(client), afterApply);
    say('版本回退：exit 4、库内不变');

    // ── ④b2 绑定指向不存在的接收方：exit 3 并点名，库内不动 ───────────────
    const ghostBinding = writeManifest('ghost-binding.json', {
      purpose: 'external_inference',
      policy_version: '2026.10-1',
      recipient_bindings: { 'fixture-not-registered': binding() },
    });
    const ghost = runTool(['policy', '--file', ghostBinding, '--apply'], databaseUrl);
    assert.equal(ghost.status, EXIT_CODES.INVALID_POLICY, '绑定指向不存在的 recipients.id ⇒ exit 3');
    assert.match(ghost.stderr, /fixture-not-registered/);
    assert.match(ghost.stderr, /public\.recipients/);
    assert.deepEqual(await snapshot(client), afterApply, '被拒后库内必须逐字段不变');
    say('绑定指向不存在的 recipients.id：exit 3、点名该 id、库内不变');

    // ── ④b3 external_inference 空绑定：能写，但必须告警「闸门没开」 ────────
    const externalDry = writeManifest('external-empty.json', { purpose: 'external_inference', policy_version: '2026.10-1' });
    const warned = runTool(['policy', '--file', externalDry], databaseUrl);
    assert.equal(warned.status, EXIT_CODES.OK);
    assert.match(warned.stdout, /^warning=.*recipients/m, 'external_inference 空绑定必须打印告警');
    assert.deepEqual(await snapshot(client), afterApply, 'dry-run 不写库');
    say('external_inference 空绑定：dry-run 照常出形状，但打印 warning=（半个门不许说成门已开）');

    // ── ④c 失败不留半写：INSERT 成功之后让 UPDATE 炸掉 ────────────────────
    // 故障注入（只在这个临时库里）：`consent_policies` 上的 BEFORE UPDATE 触发器直接抛错。
    // 于是 `--apply --enable` 的 INSERT 已经执行、enable 那条 UPDATE 必红 ⇒ 事务必须整体回滚。
    await client.query(`CREATE FUNCTION synthetic_fail_enable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'synthetic injected failure: enable must be rolled back' USING ERRCODE='P0001'; END $$`);
    await client.query('CREATE TRIGGER synthetic_fail_enable BEFORE UPDATE ON public.consent_policies FOR EACH ROW EXECUTE FUNCTION synthetic_fail_enable()');
    const halfWrite = writeManifest('half-write.json', { policy_version: '2026.11-1' });
    const injected = runTool(['policy', '--file', halfWrite, '--apply', '--enable', '--reviewed-by', reviewer], databaseUrl);
    assert.equal(injected.status, EXIT_CODES.DB_ERROR, `注入失败必须 exit 5：${injected.stdout}${injected.stderr}`);
    assert.match(injected.stderr, /DB_ERROR/);
    assert.equal(`${injected.stdout}${injected.stderr}`.includes('transaction=commit'), false, '失败时不许出现 commit');
    assert.deepEqual(await snapshot(client), afterApply, '失败后库内必须与执行前逐字段相等（INSERT 已被回滚）');
    assert.equal((await client.query('SELECT count(*)::int AS n FROM public.consent_policies')).rows[0].n, 1);
    say('失败不留半写：INSERT 之后的 UPDATE 被注入异常打红（exit 5），整行快照与执行前逐字段相等');

    // 撤掉注入 ⇒ 同一条清单必须能成功（证明上面红的是注入，不是清单）。
    await client.query('DROP TRIGGER synthetic_fail_enable ON public.consent_policies');
    await client.query('DROP FUNCTION synthetic_fail_enable()');
    const recovered = runTool(['policy', '--file', halfWrite, '--apply', '--enable', '--reviewed-by', reviewer], databaseUrl);
    assert.equal(recovered.status, EXIT_CODES.OK, `撤掉注入后必须成功：${recovered.stderr}`);
    assert.match(recovered.stdout, /^changed_rows=3$/m, 'insert 1 + 关旧行 1 + 开新行 1');
    assert.match(recovered.stdout, /^disabled_others=2026\.10-1$/m);
    const afterRecover = await snapshot(client);
    assert.equal(afterRecover.length, 2);
    assert.deepEqual(
      afterRecover.map((item) => `${item.policy_version}:${item.enabled}`),
      ['2026.10-1:false', '2026.11-1:true'],
      '启用新版本时旧行必须落 enabled=false（部分唯一索引要求单条 enabled）',
    );
    say('撤掉注入后复绿：changed_rows=3、旧行自动 enabled=false（同 purpose 只可能一条 enabled）');

    // ── ④d 原地改正文：被 0009 的不可变触发器挡住（23514） ───────────────
    const target = afterRecover.find((item) => item.policy_version === '2026.11-1');
    await assert.rejects(
      client.query("UPDATE public.consent_policies SET content_sha256=repeat('b',64) WHERE id=$1::uuid", [target.id]),
      (error) => {
        assert.equal(error.code, '23514', `必须是 23514（实测 ${error.code}）`);
        return true;
      },
    );
    // 只改 enabled / updated_at 是允许的（触发器刻意的窄口子）。
    await client.query('UPDATE public.consent_policies SET enabled=false, updated_at=clock_timestamp() WHERE id=$1::uuid', [target.id]);
    const whileDisabled = await snapshot(client);
    assert.equal(whileDisabled.find((item) => item.id === target.id).enabled, false);
    await client.query('UPDATE public.consent_policies SET enabled=true, updated_at=clock_timestamp() WHERE id=$1::uuid', [target.id]);
    const afterToggle = await snapshot(client);
    assert.equal(afterToggle.find((item) => item.id === target.id).enabled, true);
    // `enabled` / `updated_at` / `xmin` 本来就该变（触发器允许这三样），别的列一个都不许动。
    assert.deepEqual(stripVolatile(afterToggle), stripVolatile(afterRecover), '只翻 enabled 不该改动别的列');
    say('原地改正文被 23514 挡住；只翻 enabled/updated_at 允许 ⇒ 工具也没绕过这条不可变性');

    // ── ⑤ 参数/环境纪律 ───────────────────────────────────────────────────
    const noUrl = runTool(['policy', '--file', fileA], undefined);
    assert.equal(noUrl.status, EXIT_CODES.CONFIG);
    assert.match(noUrl.stderr, /DATABASE_URL/);
    assert.equal(`${noUrl.stdout}${noUrl.stderr}`.includes('postgresql://'), false, '报错里不许出现连接串');
    assert.equal(runTool([], databaseUrl).status, EXIT_CODES.CONFIG, '缺子命令 ⇒ exit 2');
    assert.match(runTool(['policy'], databaseUrl).stderr, /--file/, '缺 --file ⇒ exit 2');
    const recipient = runTool(['recipient', '--file', fileA], databaseUrl);
    assert.equal(recipient.status, EXIT_CODES.CONFIG);
    assert.match(recipient.stderr, /尚未交付/);
    assert.match(recipient.stderr, /external_inference/);
    const strayReviewer = runTool(['policy', '--file', fileA, '--reviewed-by', reviewer], databaseUrl);
    assert.equal(strayReviewer.status, EXIT_CODES.CONFIG, '--reviewed-by 只在 --enable 时有意义');
    assert.equal(runTool(['bogus'], databaseUrl).status, EXIT_CODES.CONFIG, '未知子命令 ⇒ exit 2');
    say('缺 DATABASE_URL / 缺子命令 / 缺 --file / recipient 未交付 / 多余 --reviewed-by：全部 exit 2 且不打印连接串');

    console.log(`[consent-policy-import] 真 PG 集成四连完成：${passed} 条读数，全部 exit 0`);
  } finally {
    if (client !== null) await client.end().catch(() => {});
    if (started) spawnSync(pgTool(pgBin, 'pg_ctl'), ['-D', dataDir, '-m', 'fast', '-w', '-t', '60', 'stop'], { stdio: 'ignore', timeout: 180_000 });
    removeTreeByEntry(workDir);
  }
});
