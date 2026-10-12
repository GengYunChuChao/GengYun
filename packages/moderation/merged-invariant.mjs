/**
 * GY-I14 模型层（第二片）· **合流合法性**（返修 1 · 监工 `5488195507` P2）。
 *
 * 为什么单独一个模块：合流层（`merge.mjs`）与两个放行闸门（`model-review.mjs`）都必须用**同一套**
 * 合法性口径。此前 `checkMergedInvariant` 只被合流层"生产"、却不被闸门"消费"，
 * 于是闸门各自只比版本，放行了一个**自身声明就不合法**的结论：
 *
 *   监工独立构造：`decision='approved'`、`hard_rule_passed=true`、三版本匹配、`reason_codes=['MODEL_TIMEOUT']`
 *   ⇒ `checkMergedInvariant` 早已判 `ok=false`，但 `isModelLayerPublishable` 返回 `publishable=true`、
 *   `evaluateModelReReview` 返回 `action='reuse'/publishable=true`。
 *
 * 本模块把"合流合法性"抽成**单一事实来源**，供三处共用（合流层自查 + 两个闸门前置条件）。
 *
 * 合流层的判定不变式（与规则层**刻意不同**，必须显式声明）：
 *   - 规则层：`approved ⟺ hard_rule_passed === true`（该层唯一判定者是硬规则）；
 *   - 合流层：只有**单向**必要条件 `approved ⟹ hard_rule_passed === true 且无任何 fail-closed 原因码
 *     且全部所需端口实际通过 且输入绑定已验证`。
 *   反向不成立而且必须不成立：规则通过但模型没跑／没结论 ⇒ `hard_rule_passed=true` + `quarantined`。
 */
import { isAuditState } from './constants.mjs';
import { canonicalModerationInput, readInputBinding } from './input-binding.mjs';
import { MODEL_FAILURE_REASON_CODES } from './model-reason-codes.mjs';

/** 出现即不得放行／不得复用的合流层原因码（模型层失败类 + 明确 blocked）。 */
export const MERGED_FAILURE_REASON_CODES = Object.freeze([
  ...MODEL_FAILURE_REASON_CODES,
  'MODEL_BLOCKED',
]);

/** 文本端口：**任何**内容都必须有它的执行证据。 */
export const REQUIRED_TEXT_PORT_KIND = 'tms';
/** 图片端口：**内容里有媒体**时必须额外有它的执行证据。 */
export const REQUIRED_MEDIA_PORT_KIND = 'ims';

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 由**内容本身**决定需要哪些模型端口的执行证据（返修 2 · 监工 `5489050358` P1）。
 *
 * 关键纪律：**所需端口只能由内容决定**（有媒体 ⇒ 需要 `ims`），
 * **不得**由"结论里有没有 `kinds`"决定——那正是本次缺陷（缺证据反而被跳过检查）。
 */
export function requiredModelPortKinds(content) {
  const canonical = canonicalModerationInput(content);
  const required = [REQUIRED_TEXT_PORT_KIND];
  if (typeof canonical.media_count === 'number' && canonical.media_count > 0) {
    required.push(REQUIRED_MEDIA_PORT_KIND);
  }
  return required;
}

/**
 * 模型执行证据核对（返修 2 · 监工 `5489050358` P1）：**"没有证据" ≠ "全部通过"**。
 *
 * 规则：
 *   - 任何内容都要求 `tms` 的执行证据；内容带媒体时额外要求 `ims`（由内容决定，见上）；
 *   - `model_layer.kinds` 缺失、空对象、缺所需端口、或**任一端口状态不是 `pass`** ⇒ 全部算不通过；
 *   - 所需端口无法确定（既没有当前输入、绑定里也没有 `media_count`）⇒ 同样不得视为通过（fail-closed）；
 *   - 结论自报的 `media_count` 与**本次实际内容**不一致 ⇒ 视为自报形状不可信 ⇒ 不得通过
 *     （否则可以用伪造的 `media_count` 把"需要 IMS"降级成"只需要 TMS"）。
 *
 * @param {unknown} merged 合流结论
 * @param {{ input?: unknown }} [options] `input` = 本次要发布/复用的内容
 * @returns {{ok: boolean, violations: string[], required: string[], media_count: number|null}}
 */
export function modelExecutionEvidence(merged, options = {}) {
  const violations = [];
  const binding = readInputBinding(merged);
  const hasInput = options.input !== undefined && options.input !== null;
  let contentMediaCount = null;
  let required = null;

  if (hasInput) {
    const canonical = canonicalModerationInput(options.input);
    contentMediaCount = canonical.media_count;
    required = requiredModelPortKinds(options.input);
    if (binding.present && typeof binding.media_count === 'number' && binding.media_count !== contentMediaCount) {
      violations.push(
        `结论自报 media_count=${binding.media_count} 与本次内容 media_count=${String(contentMediaCount)} 不一致`,
      );
    }
  } else if (binding.present && typeof binding.media_count === 'number') {
    // 没有当前输入时，按结论自报的内容形状（存储回读路径）；形状不可信的风险由上面的交叉核对在上游拦住。
    contentMediaCount = binding.media_count;
    required = [
      REQUIRED_TEXT_PORT_KIND,
      ...(binding.media_count > 0 ? [REQUIRED_MEDIA_PORT_KIND] : []),
    ];
  }

  if (required === null) {
    violations.push(
      '无法确定本次内容需要哪些模型端口（既未提供当前输入，绑定里也没有 media_count）⇒ 不得视为全部通过',
    );
    return { ok: false, violations, required: [], media_count: null };
  }

  const modelLayer = isPlainObject(merged) ? merged.model_layer : null;
  const kinds = isPlainObject(modelLayer) ? modelLayer.kinds : null;
  if (!isPlainObject(kinds) || Object.keys(kinds).length === 0) {
    violations.push(
      `缺少模型执行证据（model_layer.kinds 缺失或为空）⇒ 无法证明 ${required.join(' / ')} 已实际通过`,
    );
    return { ok: false, violations, required, media_count: contentMediaCount };
  }
  for (const kind of required) {
    if (!Object.hasOwn(kinds, kind)) violations.push(`缺少 ${kind} 端口的执行证据`);
  }
  for (const [kind, entry] of Object.entries(kinds)) {
    if (!isPlainObject(entry) || entry.status !== 'pass') {
      violations.push(`${kind} 端口存在但状态不是通过（status=${String(entry?.status)}）`);
    }
  }
  return { ok: violations.length === 0, violations, required, media_count: contentMediaCount };
}

/** 结论里出现的合流层失败原因码（去重、保序）。 */
export function mergedFailureCodes(holder) {
  if (!isPlainObject(holder)) return [];
  const codes = holder.reason_codes;
  if (!Array.isArray(codes)) return [];
  return [...new Set(codes.filter((code) => typeof code === 'string' && MERGED_FAILURE_REASON_CODES.includes(code)))];
}

/**
 * 合流合法性检查（**三处共用**：合流层自查、`isModelLayerPublishable`、`evaluateModelReReview`）。
 * 先 `typeof` 再判值，确保 `undefined` 一定被抓到。
 *
 * 返修 2（监工 `5489050358` P1）：`approved` 还要求**所需端口的执行证据齐备且均为通过**——
 * 此前"`kinds` 缺失就跳过检查"等于把"没有证据"当成"全部通过"。
 *
 * @param {unknown} merged 合流结论
 * @param {{ input?: unknown }} [options] `input` = 本次要发布/复用的内容（决定需要哪些端口）
 * @returns {{ok: boolean, violations: string[], evidence: object}}
 */
export function checkMergedInvariant(merged, options = {}) {
  const violations = [];
  if (!isPlainObject(merged)) {
    return { ok: false, violations: ['合流结果不是对象'], evidence: null };
  }
  const { decision, hard_rule_passed: hardRulePassed, reason_codes: reasonCodes } = merged;
  if (typeof decision !== 'string' || !isAuditState(decision)) {
    violations.push(`decision 不是 AuditState 闭集值：${typeof decision}`);
  }
  if (typeof hardRulePassed !== 'boolean') {
    violations.push(`hard_rule_passed 必须是 boolean，实际 ${typeof hardRulePassed}`);
  }
  if (!Array.isArray(reasonCodes)) {
    violations.push(`reason_codes 必须是数组，实际 ${typeof reasonCodes}`);
  } else if (reasonCodes.length > 30) {
    violations.push('reason_codes 超过契约上限 30');
  }
  // 所需端口的执行证据：**无论** decision 都先算出来（供诊断与闸门复用）；
  // 只有 `approved` 才把它当硬条件（隔离/驳回结论本来就不放行）。
  const evidence = modelExecutionEvidence(merged, options);
  if (decision === 'approved') {
    if (hardRulePassed !== true) violations.push('decision=approved 但 hard_rule_passed 不为 true');
    const failureCodes = (Array.isArray(reasonCodes) ? reasonCodes : []).filter(
      (code) => typeof code === 'string' && MERGED_FAILURE_REASON_CODES.includes(code),
    );
    if (failureCodes.length > 0) {
      violations.push(`approved 但存在合流层失败原因码：${[...new Set(failureCodes)].join(',')}`);
    }
    // 返修 2 · P1：所需端口的**执行证据**必须齐备且均为通过（"没有证据" ≠ "全部通过"）。
    // 这条取代了返修 1 里"只在 kinds 存在时才检查"的写法——那种写法会让缺失/空对象直接跳过。
    for (const violation of evidence.violations) violations.push(violation);
    // 返修 1 · P1：approved 必须绑定"它实际检查过的输入"，且绑定已被重算比对通过。
    const binding = readInputBinding(merged);
    if (!binding.present || binding.digest === null) {
      violations.push('approved 但缺少可用的输入绑定（input_binding 缺失或摘要非法）');
    } else if (binding.verified !== true) {
      violations.push('approved 但输入绑定未被验证通过（input_binding.verified 不为 true）');
    }
  }
  return { ok: violations.length === 0, violations, evidence };
}
