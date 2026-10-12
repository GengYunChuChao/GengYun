/**
 * GY-I14 模型层（第二片）· prompt 版本派生（与规则层 `rule-version.mjs` 同构）。
 *
 * 核心要求（派单 §3.3）：`prompt_version` 必须由**规范化后的 prompt 定义内容**派生，
 * **不得**手填固定字符串、**不得**由人工版本号决定，**改了 prompt 文本 ⇒ 版本必变**
 * （否则同一份旧结论会在 prompt 变更后被静默复用）。
 *
 * 派生输入（全部内容化，复用规则层的 `stableStringify` 以保证同一套稳定序列化）：
 *   1) schema 与 domain 标识；
 *   2) 参与本次筛查的**全部** prompt 定义（按 id 排序，顺序不影响结果）；
 *   3) 每个定义的全部文本字段（system / user_template / purpose / policy_notes 原文，逐字符参与）、
 *      占位符（排序去重）、要求端口回报的字段（排序去重）、verdict 标签（排序去重）、其它选项。
 *
 * 保守选择（与规则层同方向）：宁多失效，不静默复用。
 *   - 说明文案、policy 备注改错别字也会换版本；
 *   - 占位符／输出字段／verdict 标签集合变化也会换版本（它们同样是"我们对模型的口径"的一部分）。
 *
 * 版本串形如 `mp1+sha256:<32 位十六进制>`（≤80 字符，符合契约 `prompt_version` 的 1..80）。
 *
 * ⚠️ 本节**只有派生的单 prompt 版本**与**按需组合的集合版本**两种情况：
 *   `prompt_version` 契约字段取"本次实际用到的那组 prompt"的集合版本，
 *   因为一个目标可能同时用到文本与图片两个 prompt，只用其中一个的版本会让另一个的变更**不失效**。
 */
import { createHash } from 'node:crypto';

import { VERSION_MAX_LENGTH } from './constants.mjs';
import { PROMPT_DEFINITIONS } from './prompts.mjs';
import { stableStringify } from './rule-version.mjs';

/** 派生方案标识（进入哈希输入，并与摘要一起构成可读版本串）。 */
export const PROMPT_VERSION_SCHEMA = 'mp1';
/** 哈希域分隔，避免与其它组件的摘要混淆。 */
export const PROMPT_VERSION_DOMAIN = 'gengyun.moderation.model-prompts';
/** 展示用摘要长度（十六进制字符）。 */
export const PROMPT_VERSION_DIGEST_LENGTH = 32;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sortedUniqueStrings(values) {
  const list = Array.isArray(values) ? values.filter((item) => typeof item === 'string') : [];
  return [...new Set(list)].sort();
}

/**
 * 把各种调用形态归一成"按 id 排序的 prompt 定义数组"。
 * 接受：undefined（= 出厂全部定义）／单个定义／定义数组／`id -> 定义` 映射。
 *
 * **`null` 不算"缺省"**：显式传 `null` 一律归成"非法定义"并让派生抛错——
 * 静默回落到出厂定义就是规则层明确拒绝的"选项给错却按默认值跑一遍"形态。
 */
export function normalizePromptList(prompts) {
  if (prompts === undefined) return Object.values(PROMPT_DEFINITIONS);
  if (Array.isArray(prompts)) return [...prompts];
  if (isPlainObject(prompts)) {
    if (typeof prompts.id === 'string') return [prompts];
    return Object.values(prompts);
  }
  return [prompts];
}

/**
 * prompt 定义自检。
 * 与规则层同理：**"定义写错了"不等于"按出厂定义跑一遍就算通过"**。
 *
 * @returns {string[]} 问题清单（空数组 = 合法）
 */
export function validatePromptDefinition(prompt) {
  const problems = [];
  if (!isPlainObject(prompt)) return ['prompt 定义必须是对象'];
  if (typeof prompt.id !== 'string' || prompt.id.length === 0) problems.push('prompt.id 必须是非空字符串');
  for (const field of ['purpose', 'system', 'user_template']) {
    if (typeof prompt[field] !== 'string' || prompt[field].trim().length === 0) {
      problems.push(`prompt.${field} 必须是非空字符串`);
    }
  }
  for (const field of ['placeholders', 'required_output_fields', 'verdict_labels', 'policy_notes']) {
    if (!Array.isArray(prompt[field])) {
      problems.push(`prompt.${field} 必须是数组`);
      continue;
    }
    if (prompt[field].some((item) => typeof item !== 'string' || item.length === 0)) {
      problems.push(`prompt.${field} 只能包含非空字符串`);
    }
  }
  if (Array.isArray(prompt.placeholders) && typeof prompt.user_template === 'string') {
    for (const placeholder of prompt.placeholders) {
      if (typeof placeholder === 'string' && !prompt.user_template.includes(`{{${placeholder}}}`)) {
        problems.push(`prompt.placeholders 里的 ${placeholder} 未出现在 user_template 中`);
      }
    }
  }
  if (Array.isArray(prompt.required_output_fields) && !prompt.required_output_fields.includes('label')) {
    problems.push('prompt.required_output_fields 必须包含 label（否则无法判定通过与否）');
  }
  return problems;
}

/** prompt 集合自检：逐个检查 + id 唯一。 */
export function validatePromptSet(prompts) {
  const list = normalizePromptList(prompts);
  const errors = [];
  const seen = new Set();
  if (list.length === 0) errors.push('prompt 集合为空：零个 prompt 不构成"已筛查"');
  for (const prompt of list) {
    for (const problem of validatePromptDefinition(prompt)) errors.push(problem);
    const id = isPlainObject(prompt) ? prompt.id : undefined;
    if (typeof id === 'string') {
      if (seen.has(id)) errors.push(`prompt id 重复：${id}`);
      seen.add(id);
    }
  }
  return { valid: errors.length === 0, errors };
}

/** 单条 prompt -> 规范化描述符（可读、稳定、顺序无关）。 */
export function canonicalPrompt(prompt) {
  const declared = new Set([
    'id',
    'purpose',
    'system',
    'user_template',
    'placeholders',
    'required_output_fields',
    'verdict_labels',
    'policy_notes',
  ]);
  const options = {};
  for (const key of Object.keys(prompt).sort()) {
    if (declared.has(key)) continue;
    options[key] = prompt[key];
  }
  return {
    id: prompt.id,
    purpose: prompt.purpose,
    system: prompt.system,
    user_template: prompt.user_template,
    placeholders: sortedUniqueStrings(prompt.placeholders),
    required_output_fields: sortedUniqueStrings(prompt.required_output_fields),
    verdict_labels: sortedUniqueStrings(prompt.verdict_labels),
    policy_notes: Array.isArray(prompt.policy_notes) ? [...prompt.policy_notes] : [],
    options,
  };
}

/** 参与哈希的完整载荷（导出以便测试直接复核派生输入）。 */
export function canonicalPromptPayload(prompts = PROMPT_DEFINITIONS) {
  const list = normalizePromptList(prompts).map((prompt) => canonicalPrompt(prompt));
  list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    schema: PROMPT_VERSION_SCHEMA,
    domain: PROMPT_VERSION_DOMAIN,
    prompts: list,
  };
}

/** prompt 集合完整摘要（64 位十六进制）。 */
export function promptSetDigest(prompts = PROMPT_DEFINITIONS) {
  const report = validatePromptSet(prompts);
  if (!report.valid) {
    throw new Error(`prompt 定义非法，无法派生版本：${report.errors.join('；')}`);
  }
  return createHash('sha256')
    .update(stableStringify(canonicalPromptPayload(prompts)), 'utf8')
    .digest('hex');
}

/** 由 prompt 定义内容派生版本串（形如 `mp1+sha256:xxxxxxxx…`，≤80 字符）。 */
export function derivePromptVersion(prompts = PROMPT_DEFINITIONS) {
  const digest = promptSetDigest(prompts).slice(0, PROMPT_VERSION_DIGEST_LENGTH);
  const version = `${PROMPT_VERSION_SCHEMA}+sha256:${digest}`;
  /* c8 ignore next 3 -- 契约上界防御：摘要长度固定，命中说明常量被改坏 */
  if (version.length > VERSION_MAX_LENGTH) {
    throw new Error(`派生 prompt_version 超出契约上界 ${VERSION_MAX_LENGTH}`);
  }
  return version;
}

/** 是否为本方案派生出来的版本串（用于拒绝手填的固定串）。 */
export function isDerivedPromptVersion(value) {
  if (typeof value !== 'string') return false;
  return new RegExp(`^${PROMPT_VERSION_SCHEMA}\\+sha256:[0-9a-f]{${PROMPT_VERSION_DIGEST_LENGTH}}$`).test(value);
}

/** 每个 prompt **单独**的版本（用于逐项审计与变更定界）。 */
export const PROMPT_VERSIONS_BY_ID = Object.freeze(
  Object.fromEntries(
    Object.entries(PROMPT_DEFINITIONS).map(([id, prompt]) => [id, derivePromptVersion(prompt)]),
  ),
);

/** 出厂全部 prompt 的集合版本。 */
export const ALL_PROMPTS_VERSION = derivePromptVersion(PROMPT_DEFINITIONS);

/**
 * 本次实际用到的 prompt 集合版本（合流层写进契约 `prompt_version` 的那个值）。
 *
 * @param {string[]} promptIds 允许为空数组（= 没有 prompt 参与 ⇒ 调用方必须 fail-closed，
 *   本函数对空数组抛错，避免"零个 prompt 也算派生出版本"）。
 */
export function derivePromptVersionForIds(promptIds) {
  const ids = sortedUniqueStrings(promptIds);
  if (ids.length === 0) throw new Error('没有 prompt 参与筛查，不得派生 prompt_version');
  const prompts = ids.map((id) => {
    const prompt = PROMPT_DEFINITIONS[id];
    if (!prompt) throw new Error(`未知 prompt id：${id}`);
    return prompt;
  });
  return derivePromptVersion(prompts);
}
