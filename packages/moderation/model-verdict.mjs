/**
 * GY-I14 模型层（第二片）· 模型回报形状（verdict）归一。
 *
 * 设计口径（必须显式，因为它决定"什么算模型给了结论"）：
 *   1) **形状必须齐备**：端口回报必须是对象，且 `label` 必须是闭集值，
 *      prompt 声明的 `required_output_fields` 必须全部出现；缺一项即 `MODEL_RESPONSE_SHAPE_UNKNOWN`
 *      （形状未知不得当作通过）。
 *   2) **自由文本一律丢弃**：模型自报的 `reason_codes` / `summary` 是**外部不可信文本**，
 *      既不进契约 `reason_codes`（那里只用本组件闭集），也不进结果与日志——
 *      只保留**计数与长度**（`reported`），避免把原文、PII、坐标或供应商措辞抄进审核记录。
 *      形状仍然逐项校验，所以"缺字段"照样 fail-closed。
 *   3) `unsure` 不是通过：`unsure` 归到 `MODEL_NOT_EVALUATED`（"没结论"≠"通过"）。
 *   4) 回报里若带 `model_version`，必须与端口声明**一致**，不一致即视为自相矛盾 ⇒ 形状未知。
 */

/** verdict 标签闭集。 */
export const MODEL_VERDICT_LABELS = Object.freeze(['pass', 'block', 'unsure']);

/** 标签 -> 本组件含义（供文档与测试比对；`unsure` 明确不是通过）。 */
export const MODEL_VERDICT_MEANINGS = Object.freeze({
  pass: '模型侧未发现风险（仍需规则层通过才可能整体通过）',
  block: '模型侧判定不得通过（整体降为 rejected，绝不升为 approved）',
  unsure: '模型未能判定（按 fail-closed 处理，绝不当作通过）',
});

/**
 * 归一后允许保留的"回报计量"字段闭集——**全部是数字/布尔**，不含任何原文。
 * 用例直接断言结果的键集恰好等于它，避免某天有人把外部自由文本顺手抄进结果。
 */
export const MODEL_REPORTED_FIELDS = Object.freeze([
  'reason_code_count',
  'summary_length',
  'summary_present',
]);

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

/**
 * 归一模型回报。
 *
 * @param {unknown} raw 端口返回值
 * @param {{ required_output_fields: string[], declared_model_version: string|null }} context
 * @returns {{
 *   ok: boolean,
 *   label: 'pass'|'block'|'unsure'|null,
 *   model_version: string|null,
 *   reported: object,
 *   reason_codes: string[],
 *   details: Array<{field: string|null, code: string}>,
 * }}
 */
export function normalizeModelVerdict(raw, context = {}) {
  const requiredOutputFields = Array.isArray(context.required_output_fields)
    ? context.required_output_fields.filter((field) => typeof field === 'string')
    : [];
  const declaredModelVersion =
    typeof context.declared_model_version === 'string' ? context.declared_model_version : null;
  const reason_codes = [];
  const details = [];
  const add = (code, field) => {
    if (!reason_codes.includes(code)) reason_codes.push(code);
    details.push({ field, code });
  };
  const fail = (code, field) => {
    add(code, field);
    return {
      ok: false,
      label: null,
      model_version: null,
      reported: { reason_code_count: 0, summary_length: 0, summary_present: false },
      reason_codes,
      details,
    };
  };

  if (!isPlainObject(raw)) return fail('MODEL_RESPONSE_SHAPE_UNKNOWN', 'verdict');

  const labelRead = safeGet(raw, 'label');
  if (!labelRead.ok || typeof labelRead.value !== 'string' || !MODEL_VERDICT_LABELS.includes(labelRead.value)) {
    return fail('MODEL_RESPONSE_SHAPE_UNKNOWN', 'verdict.label');
  }
  const label = labelRead.value;

  // prompt 声明的必报字段必须全部出现（形状齐备，但内容丢弃）。
  for (const field of requiredOutputFields) {
    const read = safeGet(raw, field);
    if (!read.ok || !read.present) return fail('MODEL_RESPONSE_SHAPE_UNKNOWN', `verdict.${field}`);
  }

  const reasonCodesRead = safeGet(raw, 'reason_codes');
  if (reasonCodesRead.ok && reasonCodesRead.present && !Array.isArray(reasonCodesRead.value)) {
    return fail('MODEL_RESPONSE_SHAPE_UNKNOWN', 'verdict.reason_codes');
  }
  if (
    reasonCodesRead.ok &&
    Array.isArray(reasonCodesRead.value) &&
    reasonCodesRead.value.some((item) => typeof item !== 'string')
  ) {
    return fail('MODEL_RESPONSE_SHAPE_UNKNOWN', 'verdict.reason_codes');
  }
  const summaryRead = safeGet(raw, 'summary');
  if (summaryRead.ok && summaryRead.present && typeof summaryRead.value !== 'string') {
    return fail('MODEL_RESPONSE_SHAPE_UNKNOWN', 'verdict.summary');
  }

  let modelVersion = declaredModelVersion;
  const versionRead = safeGet(raw, 'model_version');
  if (versionRead.ok && versionRead.present && versionRead.value !== undefined) {
    if (typeof versionRead.value !== 'string' || versionRead.value.length === 0) {
      return fail('MODEL_VERSION_MISSING', 'verdict.model_version');
    }
    if (declaredModelVersion !== null && versionRead.value !== declaredModelVersion) {
      return fail('MODEL_RESPONSE_SHAPE_UNKNOWN', 'verdict.model_version');
    }
    modelVersion = versionRead.value;
  }
  if (typeof modelVersion !== 'string' || modelVersion.length === 0) {
    return fail('MODEL_VERSION_MISSING', 'verdict.model_version');
  }

  const reported = {
    reason_code_count: Array.isArray(reasonCodesRead.value) ? reasonCodesRead.value.length : 0,
    summary_length: typeof summaryRead.value === 'string' ? summaryRead.value.length : 0,
    summary_present: summaryRead.ok && summaryRead.present === true,
  };

  // `unsure` = 模型没有结论：按 fail-closed 记为"未求值"，绝不当作通过。
  if (label === 'unsure') {
    add('MODEL_NOT_EVALUATED', 'verdict.label');
    return { ok: false, label, model_version: modelVersion, reported, reason_codes, details };
  }

  return { ok: true, label, model_version: modelVersion, reported, reason_codes, details };
}
