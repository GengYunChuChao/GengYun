/**
 * GY-I14 模型层（第二片）· 版本绑定与**重审失效**（派单 §3.4）。
 *
 * 目标：结论必须绑定三元组 `rule_version` + `model_version` + `prompt_version`（外加 `TargetRef`）；
 * **任一**变化 ⇒ 既有结论失效，不得静默复用。
 *
 * 复用纪律（派单 §2「必须复用，不许另起一套」）：
 *   - 规则版本／目标绑定／结构自洽这三件事**全部委派**给规则层的 `evaluateReReview`；
 *   - 发布口径**委派**给规则层的 `isPublishable`，本层只**追加**模型／prompt 版本两项必要条件；
 *   - 动作与落点沿用规则层的 `REVIEW_ACTIONS` / `REVIEW_LANDINGS` 闭集（`reuse|re_review`、`pending|quarantined`）。
 *
 * 落点口径（与规则层完全一致，不另立标准）：
 *   - `pending`：**版本变化**（rule / model / prompt 任一）⇒ 旧判定失去强制力，内容回到待筛查队列自动重跑；
 *   - `quarantined`：**证据不可信／未知**（版本号缺失或非法、decision 非法、自相矛盾、绑定对象已变）。
 *
 * 为什么 model/prompt 版本变化落 `pending` 而不是 `quarantined`：
 *   与规则层"规则集变化 ⇒ pending"同类——变化本身是可确定重跑的情形，不是证据不可信。
 *   而"不知道用的哪个模型／哪版 prompt"是**未知**，与 `RULE_VERSION_UNKNOWN` 同类 ⇒ `quarantined`。
 */
import { isAuditState } from './constants.mjs';
import { REVIEW_ACTIONS, REVIEW_LANDINGS, evaluateReReview, isPublishable } from './review.mjs';
import { RULE_VERSION } from './rule-version.mjs';

/** 结论必须绑定的版本三元组（顺序即文档与测试的核对顺序）。 */
export const MODEL_BINDING_FIELDS = Object.freeze(['rule_version', 'model_version', 'prompt_version']);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeGet(holder, key) {
  try {
    return { ok: true, present: key in holder, value: holder[key] };
  } catch {
    return { ok: false, present: false, value: undefined };
  }
}

function isVersionString(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 80;
}

/** 从任意既有结论／草稿里取出绑定三元组（缺项为 `null`，**不**填占位）。 */
export function modelBindingOf(holder) {
  const binding = { rule_version: null, model_version: null, prompt_version: null };
  if (!isPlainObject(holder)) return binding;
  for (const field of MODEL_BINDING_FIELDS) {
    const read = safeGet(holder, field);
    binding[field] = read.ok && isVersionString(read.value) ? read.value : null;
  }
  return binding;
}

/**
 * 判定既有审核结果是否因**任一版本**变化或证据不可信而失效、须重审。
 *
 * @param {unknown} existing 既有结论（合流层的输出形态即可直接传入）
 * @param {{
 *   rule_version?: string,
 *   model_version?: string,
 *   prompt_version?: string,
 *   target_ref?: {type:string,id:string,revision:number},
 * }} [options]
 */
export function evaluateModelReReview(existing, options = {}) {
  const ruleVersionCurrent = options.rule_version ?? RULE_VERSION;
  const modelVersionCurrent = options.model_version;
  const promptVersionCurrent = options.prompt_version;
  const targetRef = options.target_ref ?? null;

  const ruleOutcome = evaluateReReview(existing, { rule_version: ruleVersionCurrent, target_ref: targetRef });

  const reason_codes = [...ruleOutcome.reason_codes];
  const details = [...ruleOutcome.details];
  let stale = ruleOutcome.stale;
  let landing = ruleOutcome.landing;

  const mark = (code, field, quarantine) => {
    if (!reason_codes.includes(code)) reason_codes.push(code);
    details.push({ field, code });
    stale = true;
    if (quarantine) landing = 'quarantined';
    else if (landing !== 'quarantined') landing = 'pending';
  };

  const holder = isPlainObject(existing) ? existing : null;
  const existingModelVersion = holder === null ? undefined : safeGet(holder, 'model_version').value;
  const existingPromptVersion = holder === null ? undefined : safeGet(holder, 'prompt_version').value;

  // ---- 模型版本：未知（当前或既有）⇒ 隔离；变化 ⇒ 待重审 ----
  if (!isVersionString(modelVersionCurrent) || !isVersionString(existingModelVersion)) {
    mark('MODEL_VERSION_UNKNOWN', 'model_version', true);
  } else if (existingModelVersion !== modelVersionCurrent) {
    mark('MODEL_VERSION_CHANGED', 'model_version', false);
  }

  // ---- prompt 版本：同上口径 ----
  if (!isVersionString(promptVersionCurrent) || !isVersionString(existingPromptVersion)) {
    mark('MODEL_PROMPT_VERSION_UNKNOWN', 'prompt_version', true);
  } else if (existingPromptVersion !== promptVersionCurrent) {
    mark('MODEL_PROMPT_VERSION_CHANGED', 'prompt_version', false);
  }

  // ---- 发布口径：复用规则层 isPublishable，再追加模型／prompt 两项必要条件 ----
  const rulePublishable = isPublishable(existing, ruleVersionCurrent);
  const modelBindingOk =
    !reason_codes.includes('MODEL_VERSION_CHANGED') &&
    !reason_codes.includes('MODEL_VERSION_UNKNOWN') &&
    !reason_codes.includes('MODEL_PROMPT_VERSION_CHANGED') &&
    !reason_codes.includes('MODEL_PROMPT_VERSION_UNKNOWN');
  const publishable = rulePublishable.publishable && !stale && modelBindingOk;
  if (!publishable && !reason_codes.includes('NOT_PUBLISHABLE')) reason_codes.push('NOT_PUBLISHABLE');

  const action = stale ? 're_review' : 'reuse';
  /* c8 ignore next 3 -- 闭集防御：常量表被改坏时这里会命中 */
  if (!REVIEW_ACTIONS.includes(action) || (stale && !REVIEW_LANDINGS.includes(landing))) {
    throw new Error('重审动作或落点越出规则层闭集');
  }

  return {
    rule_version_current: ruleVersionCurrent,
    model_version_current: isVersionString(modelVersionCurrent) ? modelVersionCurrent : null,
    prompt_version_current: isVersionString(promptVersionCurrent) ? promptVersionCurrent : null,
    binding_fields: [...MODEL_BINDING_FIELDS],
    stale,
    action,
    landing: stale ? landing : null,
    publishable,
    reason_codes,
    details,
    rule_layer: ruleOutcome,
    target_ref: targetRef,
  };
}

/**
 * 发布口径独立判定：**复用**规则层 `isPublishable`，再要求 model / prompt 版本与当前一致。
 * 任一不满足即不得发布——"旧版本审核结果不能套新版本"（AC19 的模型层延伸）。
 */
export function isModelLayerPublishable(result, options = {}) {
  const ruleVersionCurrent = options.rule_version ?? RULE_VERSION;
  const rulePublishable = isPublishable(result, ruleVersionCurrent);
  const reason_codes = [...rulePublishable.reason_codes];
  const binding = modelBindingOf(result);
  const add = (code) => {
    if (!reason_codes.includes(code)) reason_codes.push(code);
  };

  if (!isVersionString(options.model_version)) add('MODEL_VERSION_UNKNOWN');
  else if (binding.model_version === null) add('MODEL_VERSION_UNKNOWN');
  else if (binding.model_version !== options.model_version) add('MODEL_VERSION_CHANGED');

  if (!isVersionString(options.prompt_version)) add('MODEL_PROMPT_VERSION_UNKNOWN');
  else if (binding.prompt_version === null) add('MODEL_PROMPT_VERSION_UNKNOWN');
  else if (binding.prompt_version !== options.prompt_version) add('MODEL_PROMPT_VERSION_CHANGED');

  const publishable = reason_codes.length === 0;
  if (!publishable && !reason_codes.includes('NOT_PUBLISHABLE')) reason_codes.push('NOT_PUBLISHABLE');
  return {
    publishable,
    reason_codes,
    binding: { ...binding, rule_version_current: ruleVersionCurrent },
    rule_layer: rulePublishable,
    decision_is_audit_state: isPlainObject(result) ? isAuditState(result.decision) : false,
  };
}
