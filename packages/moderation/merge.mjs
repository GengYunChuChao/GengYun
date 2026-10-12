/**
 * GY-I14 模型层（第二片）· **合流层**（本片核心，派单 §3.2／§3.5／§3.6）。
 *
 * 职责：把**规则层结论**与**模型层结论**合流成**完整且合法**的契约 `Moderation`
 * （`id` 除外——它属持久层，本层**不产出、不伪造**）。
 *
 * 复用纪律（派单 §2「必须复用，不许另起一套」）：
 *   - 入口读规则层输出的 **`pending_model_layer_fields`**：只有规则层诚实声明
 *     "`model_version` / `prompt_version` 尚未产出"时，本层才允许去补；声明缺失或不对
 *     ⇒ `MODEL_LAYER_DECLARATION_MISSING`；规则层若自己带了这两个字段 ⇒
 *     `MODEL_LAYER_FIELD_SPOOFED`（**不允许互相冒充**），且**绝不**采信其值、绝不填占位。
 *   - 缺失字段清单复用规则层 `missingContractFields()`（它是"规则层不产出什么"的唯一权威），
 *     本层把 model/prompt 两项补上后，剩余缺失必须**收窄到 `id`**；补不上的**如实报缺**。
 *   - 排序复用规则层 `orderReasonCodes` / `truncateReasonCodes`（fail-closed 码优先、截断置顶）。
 *   - 发布与重审复用 `evaluateModelReReview` / `isModelLayerPublishable`
 *     （它们内部又复用规则层 `evaluateReReview` / `isPublishable`）。
 *
 * 三条不可动摇的口径：
 *   1) **`hard_rule_passed` 只反映规则层事实**：本层逐字节回填规则层的值，模型结论**不得**改写它。
 *   2) **绝不升级**：规则层为 `rejected` / `quarantined` 时，合流结论只能是它本身；
 *      模型"通过"不得把它变 `approved`。
 *   3) **"没跑"≠"通过"**：缺端口、端口非法、BizType 未核验、超时、配额、鉴权失败、载荷非法、
 *      形状未知、端口抛错、模型 `unsure`、版本缺失 —— 一律不得 `approved`，落 `quarantined`
 *      （口径理由见 docs/moderation/model-layer.md §4）。
 *
 * ⚠️ 已知的口径后果（必须如实声明，不得读成"AI 筛查已完成"）：
 *   规则层对**带媒体**的目标一律不判通过（`MEDIA_NOT_EVALUATED_BY_RULE_LAYER`，且硬规则一条都没跑）。
 *   因此本层对该类目标**不会**、也**不可能**只靠图片端口把它抬成 `approved`
 *   （`hard_rule_passed` 恒为 false，抬成通过就等于"没跑硬规则却通过"）。
 *   要让图片目标真正可达 `approved`，必须改规则层的覆盖／媒体口径 → **跨片依赖**，本片不擅自改。
 *
 * ⚠️ 本片**不注册路由、不改 `services/api/**`**，因此**本层暂无 HTTP 消费者**；
 *   不存在应用装配调用点（由 tests/moderation/model-merge.test.mjs 扫描仓库断言）。
 */
import {
  DECISION_APPROVED,
  DECISION_QUARANTINED,
  DECISION_REJECTED,
  MODEL_LAYER_FIELDS,
  REASON_CODES_MAX_ITEMS,
  REASON_CODE_MAX_LENGTH,
  REASON_CODE_MIN_LENGTH,
  TARGET_ID_MAX_LENGTH,
  TARGET_ID_MIN_LENGTH,
  TARGET_REVISION_MIN,
  VERSION_MAX_LENGTH,
  isAuditState,
  isTargetType,
} from './constants.mjs';
import { orderReasonCodes, truncateReasonCodes } from './engine.mjs';
import { MODEL_REASON_CODES } from './model-reason-codes.mjs';
import {
  MODEL_PORT_KINDS,
  buildModelRequest,
  classifyModelFailure,
  modelFailureReasonCode,
  normalizeMediaRef,
  validateModelPort,
} from './model-ports.mjs';
import { normalizeModelVerdict } from './model-verdict.mjs';
import { evaluateModelReReview, isModelLayerPublishable } from './model-review.mjs';
import { promptDefinition, promptIdForPortKind } from './prompts.mjs';
import { derivePromptVersionForIds } from './prompt-version.mjs';
import { missingContractFields } from './review.mjs';
import { RULES } from './rules.mjs';

/** 合流层接受并只记录的执行模式闭集（镜像契约 `ExecutionMode`；**不影响是否跑端口**）。 */
export const MERGE_EXECUTION_MODES = Object.freeze(['real', 'stub', 'preset_demo']);

/**
 * **契约 `Moderation` 的字段全集**（去 `id`）。
 * 用于合流输出的形状核对：多一个字段就违反 `additionalProperties:false`。
 */
export const MODERATION_CONTRACT_FIELDS = Object.freeze([
  'target_ref',
  'decision',
  'reason_codes',
  'hard_rule_passed',
  'model_version',
  'prompt_version',
  'rule_version',
]);

const MODEL_REASON_ORDER = new Map(MODEL_REASON_CODES.map((code, index) => [code, index]));

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

function isVersionString(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= VERSION_MAX_LENGTH;
}

function targetRefProblems(ref) {
  if (!isPlainObject(ref)) return ['target_ref 必须是对象'];
  const problems = [];
  if (!isTargetType(ref.type)) problems.push('target_ref.type 不在契约闭集内');
  if (
    typeof ref.id !== 'string' ||
    ref.id.length < TARGET_ID_MIN_LENGTH ||
    ref.id.length > TARGET_ID_MAX_LENGTH
  ) {
    problems.push('target_ref.id 必须是 1..80 的非空字符串');
  }
  if (typeof ref.revision !== 'number' || !Number.isSafeInteger(ref.revision) || ref.revision < TARGET_REVISION_MIN) {
    problems.push('target_ref.revision 必须是 ≥1 的正整数');
  }
  return problems;
}

/**
 * 合流排序（**复用**规则层排序，再追加模型层闭集码）。
 *
 * 顺序 = 规则层 `orderReasonCodes` 的结果（fail-closed 码在前、规则命中码按声明序）
 *        ++ 模型层码（按 `MODEL_REASON_CODES` 声明序）++
 *        ++ 未知码（保持出现顺序，排在最后）。
 * 去重后若超契约上限 30，则**截断**并把 `REASON_CODES_TRUNCATED`（规则层既有码）置顶。
 */
export function mergeReasonCodes(ruleCodes, modelCodes, rules = RULES) {
  const ruleOrdered = orderReasonCodes(Array.isArray(ruleCodes) ? ruleCodes : [], rules);
  const modelInput = Array.isArray(modelCodes) ? modelCodes : [];
  const modelOrdered = [...new Set(modelInput)].sort((a, b) => {
    const aIndex = MODEL_REASON_ORDER.has(a) ? MODEL_REASON_ORDER.get(a) : Number.MAX_SAFE_INTEGER;
    const bIndex = MODEL_REASON_ORDER.has(b) ? MODEL_REASON_ORDER.get(b) : Number.MAX_SAFE_INTEGER;
    if (aIndex !== bIndex) return aIndex - bIndex;
    return modelInput.indexOf(a) - modelInput.indexOf(b);
  });
  const seen = new Set();
  const full = [];
  for (const code of [...ruleOrdered, ...modelOrdered]) {
    if (typeof code !== 'string' || seen.has(code)) continue;
    seen.add(code);
    full.push(code);
  }
  // 契约上界处理（**裁**，不是**拒**；理由见 docs/moderation/model-layer.md §7）：
  //   1) 长度越界（<1 或 >80）的项一律裁掉，并置顶 REASON_CODES_TRUNCATED 表示"原因不全"；
  //   2) 去重后仍超过 30 条时从**尾部**截断（规则层既有语义排在前面，优先保留）；
  //   3) 诊断字段 `full` 保留合流全量（不含被裁的非法长度项之外的内容）；
  //   4) **裁码绝不改变决策**：决策由 decision 决定，原因码只是证据标签。
  const valid = full.filter(
    (code) => typeof code === 'string' && code.length >= REASON_CODE_MIN_LENGTH && code.length <= REASON_CODE_MAX_LENGTH,
  );
  const invalidDroppedCount = full.length - valid.length;
  const needsFlag = invalidDroppedCount > 0 || valid.length > REASON_CODES_MAX_ITEMS;
  const flagged = needsFlag
    ? ['REASON_CODES_TRUNCATED', ...valid.filter((code) => code !== 'REASON_CODES_TRUNCATED')]
    : valid;
  const contract = flagged.length > REASON_CODES_MAX_ITEMS ? flagged.slice(0, REASON_CODES_MAX_ITEMS) : flagged;
  /* c8 ignore next 3 -- 防御：常量被改坏时截断函数是规则层唯一权威实现 */
  if (contract.length > REASON_CODES_MAX_ITEMS) {
    return { full, contract: truncateReasonCodes(contract), invalid_dropped_count: invalidDroppedCount, marked_truncated: needsFlag };
  }
  return { full, contract, invalid_dropped_count: invalidDroppedCount, marked_truncated: needsFlag };
}

/** 规则层结果形状校验（不合法 ⇒ 合流层只能隔离，不得产出契约对象）。 */
function checkRuleLayerResult(ruleResult) {
  const problems = [];
  if (!isPlainObject(ruleResult)) {
    return { ok: false, problems: ['规则层结果必须是对象'], inputValid: false, targetRef: null, mediaCount: null };
  }
  const decisionRead = safeGet(ruleResult, 'decision');
  const hardRead = safeGet(ruleResult, 'hard_rule_passed');
  const ruleVersionRead = safeGet(ruleResult, 'rule_version');
  const targetRefRead = safeGet(ruleResult, 'target_ref');
  const reasonCodesRead = safeGet(ruleResult, 'reason_codes');
  const inputRead = safeGet(ruleResult, 'input');

  if (!isAuditState(decisionRead.value)) problems.push('decision 不是 AuditState 闭集值');
  if (typeof hardRead.value !== 'boolean') problems.push('hard_rule_passed 必须是 boolean');
  if (!isVersionString(ruleVersionRead.value)) problems.push('rule_version 必须是 1..80 的字符串');
  if (targetRefProblems(targetRefRead.value).length > 0) problems.push('target_ref 结构非法');
  if (!Array.isArray(reasonCodesRead.value)) problems.push('reason_codes 必须是数组');
  // 自相矛盾（规则层自身不变式）：hard_rule_passed=true 却不是 approved。
  if (hardRead.value === true && decisionRead.value !== DECISION_APPROVED) {
    problems.push('hard_rule_passed=true 但 decision 不是 approved（规则层结果自相矛盾）');
  }
  if (decisionRead.value === DECISION_APPROVED && hardRead.value !== true) {
    problems.push('decision=approved 但 hard_rule_passed 不为 true（规则层结果自相矛盾）');
  }
  const inputValid = isPlainObject(inputRead.value) && inputRead.value.valid === true;
  const mediaCount = isPlainObject(inputRead.value) && typeof inputRead.value.media_count === 'number'
    ? inputRead.value.media_count
    : null;

  return {
    ok: problems.length === 0,
    problems,
    inputValid,
    targetRef: targetRefProblems(targetRefRead.value).length === 0 ? targetRefRead.value : null,
    mediaCount,
  };
}

/** 统一的"合流产不出契约对象"返回形状（绝不返回半成品冒充完整对象）。 */
function buildMerged(fields) {
  const reason_codes = fields.reason_codes ?? [];
  return {
    // —— 与契约 Moderation 同名的绑定与判定字段（便于直接喂给规则层 review 函数）——
    target_ref: fields.target_ref ?? null,
    decision: fields.decision,
    reason_codes,
    hard_rule_passed: fields.hard_rule_passed === true,
    rule_version: fields.rule_version ?? null,
    model_version: fields.model_version ?? null,
    prompt_version: fields.prompt_version ?? null,
    // —— 组件内诊断（**不得**写进契约 Moderation）——
    reason_codes_full: fields.reason_codes_full ?? reason_codes,
    contract_value: fields.contract_value ?? null,
    moderation_result: fields.contract_value
      ? { kind: 'moderation', value: fields.contract_value }
      : null,
    missing_contract_fields: fields.missing_contract_fields ?? missingContractFields(),
    remaining_contract_fields: (fields.missing_contract_fields ?? missingContractFields()).filter(
      (field) => field !== 'id',
    ),
    model_layer: fields.model_layer ?? null,
    rule_layer: {
      decision: fields.rule_decision ?? null,
      hard_rule_passed: fields.hard_rule_passed === true,
      rule_version: fields.rule_version ?? null,
      counts: fields.rule_counts ?? null,
      rule_statuses: fields.rule_statuses ?? null,
    },
    wired_to_http: false,
    component: 'packages/moderation',
  };
}

/** 只取规则层结果里**确定性**的诊断子集（不含真实墙钟 `budget.elapsed_ms`，保证可逐字节复现）。 */
function deterministicRuleProjection(ruleResult) {
  const countsRead = safeGet(ruleResult, 'counts');
  const rulesRead = safeGet(ruleResult, 'rules');
  return {
    counts: isPlainObject(countsRead.value)
      ? {
          total: countsRead.value.total ?? null,
          evaluated: countsRead.value.evaluated ?? null,
          hits: countsRead.value.hits ?? null,
          errors: countsRead.value.errors ?? null,
          timeouts: countsRead.value.timeouts ?? null,
          truncated: countsRead.value.truncated ?? null,
          not_evaluated: countsRead.value.not_evaluated ?? null,
        }
      : null,
    rule_statuses: Array.isArray(rulesRead.value)
      ? rulesRead.value.map((item) => [item?.id ?? null, item?.status ?? null])
      : null,
  };
}

function withTimeout(promise, deadlineMs, onTimeout) {
  if (!(typeof deadlineMs === 'number' && Number.isFinite(deadlineMs) && deadlineMs > 0)) return promise;
  let timer = null;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(onTimeout()), deadlineMs);
    /* c8 ignore next -- 定时器不需要阻止进程退出（Node 保持进程存活，不受影响） */
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

/**
 * 合流：规则层结论 + 模型层结论 ⇒ 完整合法契约 `Moderation`（`id` 除外）。
 *
 * @param {unknown} ruleResult `evaluateHardRules(...)` 的返回值（必须是**规则层**结果）
 * @param {{
 *   content?: { target_ref: object, text: string, media: Array<object> },
 *   ports?: { tms?: object, ims?: object },
 *   execution_mode?: 'real'|'stub'|'preset_demo',
 *   deadline_ms?: number,
 *   rules?: Array<object>,
 * }} [options]
 * @returns {Promise<object>} 合流结果（含 `contract_value` / `missing_contract_fields` / `model_layer`）
 */
export async function mergeModeration(ruleResult, options = {}) {
  const executionMode = options.execution_mode ?? 'real';
  const rules = Array.isArray(options.rules) ? options.rules : RULES;
  const ports = isPlainObject(options.ports) ? options.ports : {};

  // ---- 0) 选项与规则层结果形状 ----
  if (typeof executionMode !== 'string' || !MERGE_EXECUTION_MODES.includes(executionMode)) {
    const merged = mergeReasonCodes([], ['MODEL_MERGE_INPUT_INVALID'], rules);
    return buildMerged({
      decision: DECISION_QUARANTINED,
      reason_codes: merged.contract,
      reason_codes_full: merged.full,
      model_layer: { execution_mode: null, status: 'not_attempted', reason_codes: ['MODEL_MERGE_INPUT_INVALID'] },
    });
  }

  const ruleShape = checkRuleLayerResult(ruleResult);
  if (!ruleShape.ok) {
    const merged = mergeReasonCodes([], ['MODEL_MERGE_INPUT_INVALID'], rules);
    return buildMerged({
      decision: DECISION_QUARANTINED,
      reason_codes: merged.contract,
      reason_codes_full: merged.full,
      model_layer: { execution_mode: executionMode, status: 'not_attempted', problems: ruleShape.problems },
    });
  }

  const ruleDecisionRead = safeGet(ruleResult, 'decision');
  const ruleHardPassed = safeGet(ruleResult, 'hard_rule_passed').value;
  const ruleVersion = safeGet(ruleResult, 'rule_version').value;
  const reasonCodesRead = safeGet(ruleResult, 'reason_codes');
  const ruleReasonCodes = Array.isArray(reasonCodesRead.value) ? reasonCodesRead.value : [];
  const projection = deterministicRuleProjection(ruleResult);

  const modelCodes = [];
  const modelDetails = [];
  const addModelCode = (code, field) => {
    if (!modelCodes.includes(code)) modelCodes.push(code);
    modelDetails.push({ field: field ?? null, code });
  };

  // ---- 1) 复用规则层的"待补字段"声明；检测冒充 ----
  const pendingRead = safeGet(ruleResult, 'pending_model_layer_fields');
  const declared = Array.isArray(pendingRead.value) ? pendingRead.value : null;
  const declarationOk =
    declared !== null &&
    declared.length === MODEL_LAYER_FIELDS.length &&
    MODEL_LAYER_FIELDS.every((field) => declared.includes(field));
  if (!declarationOk) addModelCode('MODEL_LAYER_DECLARATION_MISSING', 'pending_model_layer_fields');
  for (const field of MODEL_LAYER_FIELDS) {
    const read = safeGet(ruleResult, field);
    if (read.ok && read.present && read.value !== null && read.value !== undefined && read.value !== '') {
      addModelCode('MODEL_LAYER_FIELD_SPOOFED', field);
    }
  }

  // ---- 2) 输入闸门不通过 ⇒ 不尝试模型层（模型层只对"规则层输入可用"的目标求值）----
  const modelAttempted = ruleShape.inputValid;
  const modelLayer = {
    execution_mode: executionMode,
    status: modelAttempted ? 'attempted' : 'not_attempted',
    reason_codes: [],
    kinds: {},
    declaration: {
      pending_model_layer_fields: declared,
      declaration_ok: declarationOk,
      spoofed_fields: modelDetails.filter((item) => item.code === 'MODEL_LAYER_FIELD_SPOOFED').map((i) => i.field),
    },
    details: modelDetails,
    synthetic_ports: [],
    unused_port_kinds: [],
  };

  if (!modelAttempted) {
    const merged = mergeReasonCodes(ruleReasonCodes, modelCodes, rules);
    return buildMerged({
      target_ref: ruleShape.targetRef,
      decision: ruleDecisionRead.value,
      reason_codes: merged.contract,
      reason_codes_full: merged.full,
      hard_rule_passed: ruleHardPassed,
      rule_version: ruleVersion,
      rule_decision: ruleDecisionRead.value,
      rule_counts: projection.counts,
      rule_statuses: projection.rule_statuses,
      model_layer: { ...modelLayer, reason_codes: [...modelCodes] },
      missing_contract_fields: missingContractFields(),
    });
  }

  // ---- 3) content 必须与规则层看到的输入一致（不一致 ⇒ 不得产出结论）----
  const content = isPlainObject(options.content) ? options.content : null;
  const contentProblems = [];
  if (content === null) {
    contentProblems.push('content 必须是对象');
  } else {
    const refRead = safeGet(content, 'target_ref');
    if (targetRefProblems(refRead.value).length > 0) {
      contentProblems.push('content.target_ref 结构非法');
    } else if (
      refRead.value.type !== ruleShape.targetRef.type ||
      refRead.value.id !== ruleShape.targetRef.id ||
      refRead.value.revision !== ruleShape.targetRef.revision
    ) {
      contentProblems.push('content.target_ref 与规则层结果不一致');
    }
    const textRead = safeGet(content, 'text');
    if (typeof textRead.value !== 'string' || textRead.value.trim().length === 0) {
      contentProblems.push('content.text 必须是非空字符串');
    }
    const mediaRead = safeGet(content, 'media');
    if (!Array.isArray(mediaRead.value)) {
      contentProblems.push('content.media 必须是数组');
    } else if (mediaRead.value.length !== ruleShape.mediaCount) {
      contentProblems.push('content.media 数量与规则层结果不一致');
    }
  }
  if (contentProblems.length > 0) {
    addModelCode('MODEL_MERGE_INPUT_INVALID', 'content');
    const merged = mergeReasonCodes(ruleReasonCodes, modelCodes, rules);
    return buildMerged({
      target_ref: ruleShape.targetRef,
      decision: DECISION_QUARANTINED,
      reason_codes: merged.contract,
      reason_codes_full: merged.full,
      hard_rule_passed: ruleHardPassed,
      rule_version: ruleVersion,
      rule_decision: ruleDecisionRead.value,
      rule_counts: projection.counts,
      rule_statuses: projection.rule_statuses,
      model_layer: {
        ...modelLayer,
        status: 'not_attempted',
        reason_codes: [...modelCodes],
        problems: contentProblems,
      },
      missing_contract_fields: missingContractFields(),
    });
  }

  const contentText = content.text;
  const contentMedia = content.media;
  const mediaCount = contentMedia.length;

  // ---- 4) 本次需要的端口 / 使用的 prompt ----
  const neededKinds = ['tms'];
  if (mediaCount > 0) neededKinds.push('ims');
  for (const kind of MODEL_PORT_KINDS) {
    if (!neededKinds.includes(kind) && isPlainObject(ports[kind])) modelLayer.unused_port_kinds.push(kind);
  }
  const promptIds = neededKinds.map((kind) => promptIdForPortKind(kind));
  let promptVersion = null;
  try {
    promptVersion = derivePromptVersionForIds(promptIds);
  } catch {
    addModelCode('MODEL_PROMPT_DEFINITION_INVALID', 'prompt');
  }

  // ---- 5) 图片引用归一（只传不透明引用，不传字节）----
  const mediaRefs = [];
  if (mediaCount > 0) {
    for (const item of contentMedia) {
      const normalized = normalizeMediaRef(item);
      if (!normalized.ok) for (const code of normalized.reason_codes) addModelCode(code, 'media');
      else mediaRefs.push(normalized.ref);
    }
  }

  // ---- 6) 端口存在性与合法性（缺端口 = 未接线 = 不得通过）----
  const portReports = {};
  for (const kind of neededKinds) {
    const port = ports[kind];
    if (!isPlainObject(port)) {
      addModelCode('MODEL_LAYER_PORT_MISSING', kind);
      portReports[kind] = { valid: false, not_invoked: true, reason_codes: ['MODEL_LAYER_PORT_MISSING'] };
      continue;
    }
    const report = validateModelPort(port, kind);
    portReports[kind] = {
      valid: report.valid,
      not_invoked: !report.valid,
      reason_codes: [...report.reason_codes],
      synthetic: report.synthetic,
      timeout_ms: report.timeout_ms,
    };
    for (const code of report.reason_codes) addModelCode(code, `${kind}.port`);
    if (report.synthetic === true) modelLayer.synthetic_ports.push(kind);
  }

  // ---- 7) 逐个端口求值（失败逐项隔离，互不影响）----
  // 载荷不合法时**不得**调用该端口：一个明知非法的请求发出去，"它返回 pass"也不可信。
  const payloadOk = mediaRefs.length === mediaCount;
  const resolvedVersions = new Set();
  for (const kind of neededKinds) {
    const report = portReports[kind];
    const entry = {
      kind,
      status: 'not_invoked',
      label: null,
      reason_codes: [...report.reason_codes],
      reported: null,
      synthetic: report.synthetic === true,
    };
    modelLayer.kinds[kind] = entry;
    if (!report.valid) continue;
    if (kind === 'ims' && !payloadOk) {
      entry.reason_codes = [...new Set([...entry.reason_codes, 'MODEL_PAYLOAD_INVALID'])];
      continue;
    }

    const promptId = promptIdForPortKind(kind);
    const definition = promptDefinition(promptId);
    /* c8 ignore next 3 -- 闭集防御：kind 来自 MODEL_PORT_KINDS，定义表覆盖全部 kind */
    if (definition === null) {
      addModelCode('MODEL_PROMPT_DEFINITION_INVALID', `${kind}.prompt`);
      continue;
    }
    const port = ports[kind];
    const request = buildModelRequest({
      kind,
      prompt: definition,
      prompt_version: promptVersion,
      target_ref: ruleShape.targetRef,
      text: contentText,
      media_refs: mediaRefs,
    });
    const declaredModelVersion =
      typeof safeGet(port, 'model_version').value === 'string' ? safeGet(port, 'model_version').value : null;

    let raw;
    try {
      raw = await withTimeout(
        Promise.resolve(port.evaluate(request)),
        options.deadline_ms ?? report.timeout_ms ?? undefined,
        () => Object.assign(new Error('model port deadline exceeded'), { model_failure: 'timeout' }),
      );
    } catch (error) {
      const failureClass = classifyModelFailure(error);
      const code = modelFailureReasonCode(failureClass);
      entry.status = 'failed';
      entry.reason_codes = [...new Set([...entry.reason_codes, code])];
      entry.failure_class = failureClass;
      addModelCode(code, `${kind}.evaluate`);
      if (declaredModelVersion !== null) resolvedVersions.add(declaredModelVersion);
      continue;
    }

    const verdict = normalizeModelVerdict(raw, {
      required_output_fields: definition.required_output_fields,
      declared_model_version: declaredModelVersion,
    });
    entry.label = verdict.label;
    entry.reported = verdict.reported;
    entry.reason_codes = [...new Set([...entry.reason_codes, ...verdict.reason_codes])];
    for (const code of verdict.reason_codes) addModelCode(code, `${kind}.verdict`);
    if (verdict.model_version !== null) resolvedVersions.add(verdict.model_version);

    if (!verdict.ok) {
      entry.status = 'failed';
      continue;
    }
    if (verdict.label === 'block') {
      entry.status = 'blocked';
      entry.reason_codes = [...new Set([...entry.reason_codes, 'MODEL_BLOCKED'])];
      addModelCode('MODEL_BLOCKED', `${kind}.verdict.label`);
      continue;
    }
    entry.status = 'pass';
  }

  // ---- 8) 模型版本：契约只有一个字段；两个 kind 回报不同模型 ⇒ 无法表达 ⇒ 不得通过 ----
  let modelVersion = null;
  if (resolvedVersions.size === 1) {
    modelVersion = [...resolvedVersions][0];
  } else if (resolvedVersions.size > 1) {
    addModelCode('MODEL_VERSION_CONFLICT', 'model_version');
  }

  // ---- 9) 决策：绝不升级；只有"规则层通过 + 全部所需端口实际求值且通过"才 approved ----
  const hardRulePassed = ruleHardPassed === true;
  const kindsAllPass = neededKinds.every((kind) => modelLayer.kinds[kind]?.status === 'pass');
  const kindsAnyBlocked = neededKinds.some((kind) => modelLayer.kinds[kind]?.status === 'blocked');
  const failClosedCodes = modelCodes.filter((code) => code !== 'MODEL_BLOCKED');

  let decision;
  if (ruleDecisionRead.value === DECISION_APPROVED) {
    if (kindsAnyBlocked) decision = DECISION_REJECTED;
    else if (failClosedCodes.length > 0 || !kindsAllPass || !hardRulePassed) decision = DECISION_QUARANTINED;
    else decision = DECISION_APPROVED;
  } else {
    decision = ruleDecisionRead.value;
  }
  // 最后一道闸：只有"规则层事实为真 + 无任何 fail-closed 原因 + 全部所需端口通过"才允许通过。
  if (decision === DECISION_APPROVED && (hardRulePassed !== true || failClosedCodes.length > 0 || !kindsAllPass)) {
    decision = DECISION_QUARANTINED;
  }

  // ---- 10) 原因码合流（规则层在前，模型层按闭集声明序在后）----
  const mergedCodes = mergeReasonCodes(ruleReasonCodes, [...modelCodes], rules);

  // ---- 11) 契约对象装配（缺一项就不装配，如实报缺，绝不填占位串）----
  const candidate = {
    target_ref: ruleShape.targetRef,
    decision,
    reason_codes: mergedCodes.contract,
    hard_rule_passed: hardRulePassed,
    model_version: modelVersion,
    prompt_version: promptVersion,
    rule_version: ruleVersion,
  };
  const missing = missingContractFields().filter((field) => {
    const value = candidate[field];
    if (field === 'id') return true;
    if (field === 'hard_rule_passed') return typeof value !== 'boolean';
    if (field === 'reason_codes') return !Array.isArray(value) || value.length > 30;
    if (field === 'target_ref') return targetRefProblems(value).length > 0;
    if (field === 'decision') return !isAuditState(value);
    return !isVersionString(value);
  });
  const remaining = missing.filter((field) => field !== 'id');
  const contractValue = remaining.length === 0
    ? Object.fromEntries(MODERATION_CONTRACT_FIELDS.map((field) => [field, candidate[field]]))
    : null;

  const merged = buildMerged({
    target_ref: ruleShape.targetRef,
    decision,
    reason_codes: mergedCodes.contract,
    reason_codes_full: mergedCodes.full,
    hard_rule_passed: hardRulePassed,
    rule_version: ruleVersion,
    model_version: modelVersion,
    prompt_version: promptVersion,
    contract_value: contractValue,
    missing_contract_fields: missing,
    rule_decision: ruleDecisionRead.value,
    rule_counts: projection.counts,
    rule_statuses: projection.rule_statuses,
    model_layer: { ...modelLayer, reason_codes: [...modelCodes] },
  });

  // ---- 12) 复用规则层 review 口径：本结果当前是否可复用／可发布 ----
  const binding = {
    rule_version: ruleVersion,
    model_version: modelVersion,
    prompt_version: promptVersion,
    target_ref: ruleShape.targetRef,
  };
  merged.model_layer.re_review = evaluateModelReReview(merged, binding);
  merged.model_layer.publishable = isModelLayerPublishable(merged, binding);
  return merged;
}

/**
 * 合流结果的**契约形状核对**（含 `missingContractFields` 复用）：
 *   - 除 `id`（持久层）外，契约必填字段必须齐备且类型合法；
 *   - 不得出现契约之外的字段（`additionalProperties:false`）；
 *   - `reason_codes` 必须 ≤30 且每条 1..80。
 */
export function checkMergedContractShape(merged) {
  const problems = [];
  if (!isPlainObject(merged)) return { ok: false, problems: ['合流结果必须是对象'], missing_contract_fields: [], remaining_contract_fields: [] };
  const contractValue = merged.contract_value;
  const missingAll = missingContractFields();
  const missing = missingAll.filter((field) => {
    if (field === 'id') return true; // 持久层字段：本层永不产出，恒为"缺"
    if (contractValue === null || !isPlainObject(contractValue)) return true;
    const read = safeGet(contractValue, field);
    return !read.ok || !read.present || read.value === undefined || read.value === null || read.value === '';
  });
  const remaining = missing.filter((field) => field !== 'id');

  if (contractValue !== null) {
    if (!isPlainObject(contractValue)) problems.push('contract_value 必须是对象或 null');
    else {
      for (const field of MODERATION_CONTRACT_FIELDS) {
        if (!Object.hasOwn(contractValue, field)) problems.push(`契约字段缺失：${field}`);
      }
      for (const key of Object.keys(contractValue)) {
        if (!MODERATION_CONTRACT_FIELDS.includes(key)) problems.push(`契约外字段：${key}`);
      }
      if (!isAuditState(contractValue.decision)) problems.push('decision 不是 AuditState 闭集值');
      if (typeof contractValue.hard_rule_passed !== 'boolean') problems.push('hard_rule_passed 必须是 boolean');
      if (targetRefProblems(contractValue.target_ref).length > 0) problems.push('target_ref 结构非法');
      for (const field of ['rule_version', 'model_version', 'prompt_version']) {
        if (!isVersionString(contractValue[field])) problems.push(`${field} 必须是 1..80 的字符串`);
      }
      const codes = contractValue.reason_codes;
      if (!Array.isArray(codes)) problems.push('reason_codes 必须是数组');
      else {
        if (codes.length > 30) problems.push('reason_codes 超过契约上限 30');
        for (const code of codes) {
          if (
            typeof code !== 'string' ||
            code.length < REASON_CODE_MIN_LENGTH ||
            code.length > REASON_CODE_MAX_LENGTH
          ) {
            problems.push(`reason_code 越界：${String(code).slice(0, 20)}`);
            break;
          }
        }
      }
      // approved ⟹ hard_rule_passed === true（必要条件，单向）
      if (contractValue.decision === DECISION_APPROVED && contractValue.hard_rule_passed !== true) {
        problems.push('decision=approved 但 hard_rule_passed 不为 true');
      }
    }
  }
  for (const field of remaining) problems.push(`模型层未能补齐契约字段：${field}`);
  return {
    ok: problems.length === 0,
    problems,
    missing_contract_fields: missing,
    remaining_contract_fields: remaining,
  };
}

/**
 * 合流层的**判定不变式**（与规则层 `checkDecisionInvariant` 分开，口径不同，必须显式声明）：
 *   规则层不变式是 `approved ⟺ hard_rule_passed`（因为规则层唯一的判定者就是硬规则）；
 *   合流层的判定者有两个（规则 + 模型），因此只有**单向**必要条件：
 *     `decision === 'approved'` ⟹ `hard_rule_passed === true` 且无任何 fail-closed 原因码。
 *   **反向不成立**，而且**必须不成立**：规则层通过 + 模型不可用 ⇒ `hard_rule_passed=true` 但
 *   `decision='quarantined'`——"硬规则过了"不等于"整体过了"（这正是本片的 fail-closed 主线）。
 */
export function checkMergedInvariant(merged) {
  const violations = [];
  if (!isPlainObject(merged)) return { ok: false, violations: ['合流结果不是对象'] };
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
  if (decision === DECISION_APPROVED) {
    if (hardRulePassed !== true) violations.push('decision=approved 但 hard_rule_passed 不为 true');
    const failureCodes = (reasonCodes ?? []).filter((code) => MODEL_REASON_CODES.includes(code) && code !== 'MODEL_BLOCKED');
    if (failureCodes.length > 0) violations.push(`approved 但存在模型层 fail-closed 原因码：${failureCodes.join(',')}`);
    if (merged.model_layer?.kinds) {
      for (const [kind, entry] of Object.entries(merged.model_layer.kinds)) {
        if (entry?.status !== 'pass') violations.push(`approved 但 ${kind} 端口未实际通过（status=${String(entry?.status)}）`);
      }
    }
  }
  return { ok: violations.length === 0, violations };
}
