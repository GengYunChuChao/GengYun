/**
 * GY-I14 模型层（第二片）· **输入绑定**（返修 1 · 监工 `5488195507` P1）。
 *
 * 事故形态（监工独立复现）：
 *   对干净正文 A 跑 `evaluateHardRules` 得到 `approved`，然后**同一个 `target_ref` / `revision`**
 *   把 `content.text` 换成硬规则会明确 `rejected` 的正文 B，再注入一个返回 pass 的假模型端口，
 *   `mergeModeration` 会返回 **`approved`** —— 也就是**模型放行 B 时复用了 A 的硬规则结论**，
 *   绕过"模型不能翻案"的硬边界。根因：结论只绑了 `target_ref`/版本，**没有绑它实际检查过的内容**。
 *
 * 本模块的处置：给"实际参与硬规则检查的不可变输入"算一个**规范化摘要**，
 * 合流时**重算并比对**，不一致即隔离（绝不 approved）。
 *
 * 摘要覆盖的输入面 = 规则层**唯一接受**的输入面（`ALLOWED_INPUT_FIELDS`）：
 *   `target_ref{type,id,revision}` + `text` + `media`（**保序**，元素内容逐个进摘要）。
 *   - `target_ref` / `revision` 进摘要：同 id 换 revision、或换 type/id 都必须被识别；
 *   - `text` **原文逐字符**进摘要；
 *   - `media` **不得只看数量**（监工明确要求）：数量相同、内容不同的媒体列表摘要必然不同。
 *     选择**保序**而不是"集合"：媒体顺序变化对应不同的展示/发布内容，宁多失效不静默复用。
 *   - 未知顶层字段不进摘要：规则层本来就会把它们判成 `INPUT_UNKNOWN_FIELD`（fail-closed），
 *     摘要只覆盖"真正被检查的内容"。
 *
 * 与社区线（`#15` 阶段 1，`services/api/src/community/service.ts`）既有做法的关系：
 *   - **相同点**：都是"结论必须绑定这一份正文"，不只是绑 `revision`；
 *     社区线用 `text_digest: sha256Hex(text)`，回读时 `if (verdict.text_digest !== sha256Hex(text)) ⇒ 降级`。
 *   - **不同点（本模块故意更宽/更严）**：
 *     1) **范围更宽**：社区线只绑正文（其阶段 1 是文本路径），本模块按监工要求**把媒体引用集合也绑进摘要**；
 *     2) **输入结构化 + 域分隔**：本模块的输入是 `{target_ref, text, media}`，需要规范化序列化
 *        （复用规则层 `stableStringify`）并用域分隔串避免与其它组件摘要混淆
 *        （同 `rule-version.mjs` / `prompt-version.mjs` 的做法），形如 `mib1+sha256:<32 位十六进制>`；
 *        社区线的 `sha256Hex(text)` 是对纯字符串直接哈希，无结构与域的问题。
 *     理由：两者绑的对象不同（一个纯字符串，一个结构化输入），但**安全目标完全一致**；
 *     本模块不复用 `services/api` 的实现，避免"组件依赖上层服务"的反向耦合。
 *
 * 边界：本文件不做任何 I/O、不联网、不读环境变量；只做纯函数规范化与哈希。
 */
import { createHash } from 'node:crypto';

import { evaluateHardRules } from './engine.mjs';
import { stableStringify } from './rule-version.mjs';

/** 绑定方案标识（进入哈希输入，并与摘要一起构成可读串）。 */
export const INPUT_BINDING_SCHEMA = 'mib1';
/** 哈希域分隔，避免与其它组件的摘要混淆。 */
export const INPUT_BINDING_DOMAIN = 'gengyun.moderation.input-binding';
/** 展示用摘要长度（十六进制字符）。 */
export const INPUT_BINDING_DIGEST_LENGTH = 32;
/** 挂在规则层结论上的**非契约**字段名（契约 `Moderation` 没有这个字段，见文档"契约缺口"）。 */
export const INPUT_BINDING_FIELD = 'input_binding';

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeGet(holder, key) {
  if (!isPlainObject(holder)) return { ok: false, present: false, value: undefined };
  try {
    return { ok: true, present: key in holder, value: holder[key] };
  } catch {
    return { ok: false, present: false, value: undefined };
  }
}

/**
 * 规范化"参与硬规则检查的输入"（顺序无关的键、保序的媒体数组）。
 * 只读消费 `target_ref` / `text` / `media` 三个字段，不修改入参。
 */
export function canonicalModerationInput(input) {
  const refRead = safeGet(input, 'target_ref');
  const ref = refRead.value;
  const textRead = safeGet(input, 'text');
  const text = textRead.value;
  const mediaRead = safeGet(input, 'media');
  const media = mediaRead.value;
  return {
    schema: INPUT_BINDING_SCHEMA,
    domain: INPUT_BINDING_DOMAIN,
    target_ref: isPlainObject(ref)
      ? { type: ref.type ?? null, id: ref.id ?? null, revision: ref.revision ?? null }
      : null,
    text: typeof text === 'string' ? text : null,
    // 保序：媒体顺序变化即视为不同输入（宁多失效）。
    media: Array.isArray(media) ? media.map((item) => item) : null,
    media_count: Array.isArray(media) ? media.length : null,
  };
}

/** 由输入内容派生绑定摘要（形如 `mib1+sha256:xxxxxxxx…`）。 */
export function moderationInputDigest(input) {
  const payload = canonicalModerationInput(input);
  const digest = createHash('sha256').update(stableStringify(payload), 'utf8').digest('hex');
  return `${INPUT_BINDING_SCHEMA}+sha256:${digest.slice(0, INPUT_BINDING_DIGEST_LENGTH)}`;
}

/** 是否为本方案派生出来的摘要串（拒绝手填的固定串）。 */
export function isDerivedInputDigest(value) {
  if (typeof value !== 'string') return false;
  return new RegExp(`^${INPUT_BINDING_SCHEMA}\\+sha256:[0-9a-f]{${INPUT_BINDING_DIGEST_LENGTH}}$`).test(value);
}

/**
 * 把规则层结论与"它实际检查过的输入"绑定：返回**浅拷贝**，新增非契约字段 `input_binding`。
 * 规则层原本的字段逐字节不动（规则层语义/断言不受影响）。
 */
export function bindRuleResult(ruleResult, input) {
  const canonical = canonicalModerationInput(input);
  return {
    ...ruleResult,
    [INPUT_BINDING_FIELD]: {
      schema: INPUT_BINDING_SCHEMA,
      digest: moderationInputDigest(input),
      media_count: canonical.media_count,
      text_length: typeof canonical.text === 'string' ? canonical.text.length : null,
    },
  };
}

/**
 * 规则层 + 输入绑定的**唯一推荐入口**：先跑规则层，再把结论绑到这次的输入上。
 * 合流层要求结论必须带绑定（缺绑定一律隔离），因此生产接线应使用本入口。
 */
export function evaluateBoundHardRules(input, options = {}) {
  return bindRuleResult(evaluateHardRules(input, options), input);
}

/**
 * 校验holder上的绑定与给定输入是否一致。
 *
 * @param {unknown} holder 带 `input_binding` 的结论（规则层结论 / 合流结果）
 * @param {unknown} input 本次要合流/发布的输入（`{target_ref, text, media}`）
 * @returns {{ok: boolean, reason_codes: string[], details: Array<{field: string|null, code: string}>,
 *   expected_digest: string|null, actual_digest: string|null, schema: string|null}}
 */
export function verifyInputBinding(holder, input) {
  const reason_codes = [];
  const details = [];
  const add = (code, field) => {
    if (!reason_codes.includes(code)) reason_codes.push(code);
    details.push({ field, code });
  };
  const read = safeGet(holder, INPUT_BINDING_FIELD);
  const binding = read.ok ? read.value : undefined;
  if (!read.ok || !read.present || !isPlainObject(binding)) {
    add('MODEL_LAYER_INPUT_BINDING_MISSING', INPUT_BINDING_FIELD);
    return { ok: false, reason_codes, details, expected_digest: null, actual_digest: null, schema: null };
  }
  const schema = typeof binding.schema === 'string' ? binding.schema : null;
  const actualDigest = typeof binding.digest === 'string' ? binding.digest : null;
  if (schema !== INPUT_BINDING_SCHEMA || !isDerivedInputDigest(actualDigest)) {
    // 有字段但不可用（方案不符／摘要非法）与"缺失"同归一类：不可作为证据。
    add('MODEL_LAYER_INPUT_BINDING_MISSING', `${INPUT_BINDING_FIELD}.digest`);
    return { ok: false, reason_codes, details, expected_digest: null, actual_digest: actualDigest, schema };
  }
  let expected = null;
  try {
    expected = moderationInputDigest(input);
  } catch {
    // 入参不可规范化 ⇒ 无法核验 ⇒ 不得放行（同样算"未验证"，不是"通过"）。
    add('MODEL_LAYER_INPUT_BINDING_UNVERIFIED', INPUT_BINDING_FIELD);
    return { ok: false, reason_codes, details, expected_digest: null, actual_digest: actualDigest, schema };
  }
  if (actualDigest !== expected) {
    add('MODEL_LAYER_INPUT_BINDING_MISMATCH', `${INPUT_BINDING_FIELD}.digest`);
  }
  return {
    ok: reason_codes.length === 0,
    reason_codes,
    details,
    expected_digest: expected,
    actual_digest: actualDigest,
    schema,
  };
}

/**
 * 读取结论上的绑定摘要（不做比对），供回读路径与诊断使用。
 * @returns {{present: boolean, schema: string|null, digest: string|null, media_count: number|null, text_length: number|null, verified: boolean}}
 */
export function readInputBinding(holder) {
  const empty = { present: false, schema: null, digest: null, media_count: null, text_length: null, verified: false };
  const read = safeGet(holder, INPUT_BINDING_FIELD);
  if (!read.ok || !isPlainObject(read.value)) return empty;
  const binding = read.value;
  return {
    present: true,
    schema: typeof binding.schema === 'string' ? binding.schema : null,
    digest: isDerivedInputDigest(binding.digest) ? binding.digest : null,
    media_count: typeof binding.media_count === 'number' ? binding.media_count : null,
    text_length: typeof binding.text_length === 'number' ? binding.text_length : null,
    verified: binding.verified === true,
  };
}
