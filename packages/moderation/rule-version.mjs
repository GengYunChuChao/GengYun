/**
 * GY-I14 确定性硬规则审核层 · `rule_version` 派生。
 *
 * 核心要求（派单 §3、§4.2）：`rule_version` 必须由规则集**内容**派生，
 * **不得**手填固定字符串、**不得**由人工版本号决定。
 *
 * 派生输入（全部内容化）：
 *   1) schema 与 domain 标识；
 *   2) 匹配器指纹：匹配器 id + 版本号 + **实现源码**（`Function.prototype.toString()`）；
 *   3) 每条规则的完整描述符：id／类别／原因码／标题／说明／严重级别／匹配器／模式（source+flags 排序后）／其它选项。
 *
 * 因此：改规则、改模式、改匹配器实现、甚至改规则说明文案，都会改变 `rule_version`，
 * 既有审核结果随之失效（见 review.mjs）。这是**有意的保守选择**：宁多失效，不静默复用。
 * 残留限制（如实登记）：文本格式重排（例如整体格式化）也会改变哈希——方向安全（多失效），
 * 代价是可能产生"仅格式变化"的版本抖动。
 */
import { createHash } from 'node:crypto';
import { RULES, matcherFingerprint } from './rules.mjs';
import { MATCHERS, MATCHER_REVISIONS } from './matchers.mjs';
import { VERSION_MAX_LENGTH } from './constants.mjs';

/** 派生方案标识（进入哈希输入，并与摘要一起构成可读版本串）。 */
export const RULE_VERSION_SCHEMA = 'mr1';
/** 哈希域分隔，避免与其它组件的摘要混淆。 */
export const RULE_VERSION_DOMAIN = 'gengyun.moderation.hard-rules';
/** 展示用摘要长度（十六进制字符）。 */
export const RULE_VERSION_DIGEST_LENGTH = 32;

const DESCRIPTOR_KEYS = new Set([
  'id',
  'category',
  'reason_code',
  'title',
  'description',
  'severity',
  'matcher',
  'patterns',
]);

function normalizeFlags(flags) {
  return typeof flags === 'string' ? [...flags].sort().join('') : '';
}

/** 稳定序列化：键排序；RegExp 归一为 source+flags；特殊值显式标注。 */
export function stableStringify(value) {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'string') return JSON.stringify(value);
  if (type === 'number' || type === 'boolean') return JSON.stringify(value);
  if (type === 'undefined') return '"<undefined>"';
  if (type === 'function') return JSON.stringify({ __function__: String(value) });
  if (value instanceof RegExp) {
    return JSON.stringify({ __regexp__: value.source, flags: normalizeFlags(value.flags) });
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (type === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(`<${type}>`);
}

/** 单条规则 -> 规范化描述符（含模式与全部附加选项）。 */
export function canonicalRule(rule) {
  const options = {};
  for (const key of Object.keys(rule).sort()) {
    if (DESCRIPTOR_KEYS.has(key)) continue;
    options[key] = rule[key];
  }
  return {
    id: rule.id,
    category: rule.category,
    reason_code: rule.reason_code,
    title: rule.title,
    description: rule.description,
    severity: rule.severity,
    matcher: rule.matcher,
    patterns: (rule.patterns ?? []).map((pattern) => ({
      source: pattern.source,
      flags: normalizeFlags(pattern.flags),
    })),
    options,
  };
}

/** 参与哈希的完整载荷（导出以便测试直接复核派生输入）。 */
export function canonicalRuleSetPayload(
  rules = RULES,
  matchers = MATCHERS,
  revisions = MATCHER_REVISIONS,
) {
  return {
    schema: RULE_VERSION_SCHEMA,
    domain: RULE_VERSION_DOMAIN,
    matchers: matcherFingerprint(matchers, revisions),
    rules: rules.map((rule) => canonicalRule(rule)),
  };
}

/** 规则集完整摘要（64 位十六进制）。 */
export function ruleSetDigest(rules = RULES, matchers = MATCHERS, revisions = MATCHER_REVISIONS) {
  const payload = canonicalRuleSetPayload(rules, matchers, revisions);
  return createHash('sha256').update(stableStringify(payload), 'utf8').digest('hex');
}

/** 由规则集内容派生 `rule_version`（形如 `mr1+sha256:xxxxxxxx…`，≤80 字符）。 */
export function deriveRuleVersion(rules = RULES, matchers = MATCHERS, revisions = MATCHER_REVISIONS) {
  const digest = ruleSetDigest(rules, matchers, revisions).slice(0, RULE_VERSION_DIGEST_LENGTH);
  const version = `${RULE_VERSION_SCHEMA}+sha256:${digest}`;
  /* c8 ignore next 3 -- 契约上界防御：摘要长度固定，命中说明常量被改坏 */
  if (version.length > VERSION_MAX_LENGTH) {
    throw new Error(`派生 rule_version 超出契约上界 ${VERSION_MAX_LENGTH}`);
  }
  return version;
}

/** 是否为本方案派生出来的版本串（用于拒绝手填的固定串）。 */
export function isDerivedRuleVersion(value) {
  if (typeof value !== 'string') return false;
  return new RegExp(`^${RULE_VERSION_SCHEMA}\\+sha256:[0-9a-f]{${RULE_VERSION_DIGEST_LENGTH}}$`).test(value);
}

/** 出厂规则集的 `rule_version`（由上面函数实时派生，不是手填字面量）。 */
export const RULE_VERSION = deriveRuleVersion();

/** 出厂规则集完整摘要。 */
export const RULE_SET_DIGEST = ruleSetDigest();
