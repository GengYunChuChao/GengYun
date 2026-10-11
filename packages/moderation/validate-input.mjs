/**
 * GY-I14 确定性硬规则审核层 · 输入校验（fail-closed 第一道闸）。
 *
 * 语义（派单 §4.1）：缺字段、类型不符、空文本、超长、编码异常、未知字段
 * **一律不得通过**；校验失败时规则根本不会求值，因此 `hard_rule_passed` 必须保持 false。
 *
 * 设计取舍：本模块**只**回答"输入是否可被确定性规则层处理"，不回答内容是否合规。
 * 任何"不确定"都归到不通过一侧（隔离），而不是放过。
 */
import {
  ALLOWED_INPUT_FIELDS,
  COVERED_TARGET_TYPES,
  MAX_TEXT_LENGTH,
  TARGET_ID_MAX_LENGTH,
  TARGET_ID_MIN_LENGTH,
  TARGET_REVISION_MIN,
  isTargetType,
} from './constants.mjs';

/** 落单代理项（不成对 UTF-16 代理）：编码异常的确定性信号。 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/** 除常见空白外不可打印的控制字符。 */
const DISALLOWED_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
/** 替换字符：解码损坏信号（代码仓库文字规则亦禁 U+FFFD）。 */
const REPLACEMENT_CHAR = '\uFFFD';

function collect(reason_codes, details, code, field) {
  if (!reason_codes.includes(code)) reason_codes.push(code);
  details.push({ field, code });
}

/** 读取属性但不容许异常逃逸成"未命中"（getter 抛错也算输入不可用）。 */
function safeGet(holder, key) {
  try {
    return { ok: true, present: key in holder, value: holder[key] };
  } catch {
    return { ok: false, present: false, value: undefined };
  }
}

/** target type 是否被本片规则层覆盖。 */
export function isCoveredTargetType(type) {
  return typeof type === 'string' && COVERED_TARGET_TYPES.includes(type);
}

/**
 * 校验并归一审核输入。
 *
 * @param {unknown} input `{ target_ref:{type,id,revision}, text:string, media:Array }`
 * @param {{ max_text_length?: number }} [options]
 * @returns {{
 *   valid: boolean,
 *   reason_codes: string[],
 *   details: Array<{field: string|null, code: string}>,
 *   target_ref: {type:string,id:string,revision:number}|null,
 *   text: string|null,
 *   media_count: number|null,
 *   covered: boolean,
 *   media_declared: boolean,
 *   has_media: boolean,
 * }}
 */
export function validateModerationInput(input, options = {}) {
  const maxTextLength = options.max_text_length ?? MAX_TEXT_LENGTH;
  const reason_codes = [];
  const details = [];

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    collect(reason_codes, details, 'INPUT_NOT_OBJECT', null);
    return {
      valid: false,
      reason_codes,
      details,
      target_ref: null,
      text: null,
      media_count: null,
      covered: false,
      media_declared: false,
      has_media: false,
    };
  }

  // 未知顶层键：可能承载我们没读懂的条件，"没读懂"不等于"没关系"。
  for (const key of Object.keys(input)) {
    if (!ALLOWED_INPUT_FIELDS.includes(key)) collect(reason_codes, details, 'INPUT_UNKNOWN_FIELD', key);
  }

  // ---- target_ref ----
  const refRead = safeGet(input, 'target_ref');
  if (!refRead.ok) {
    collect(reason_codes, details, 'INPUT_READ_FAILED', 'target_ref');
  }
  const ref = refRead.value;
  let target_ref = null;
  if (typeof ref !== 'object' || ref === null || Array.isArray(ref)) {
    collect(reason_codes, details, 'INPUT_TARGET_REF_INVALID', 'target_ref');
  } else {
    const typeRead = safeGet(ref, 'type');
    const idRead = safeGet(ref, 'id');
    const revisionRead = safeGet(ref, 'revision');
    const type = typeRead.ok ? typeRead.value : undefined;
    const id = idRead.ok ? idRead.value : undefined;
    const revision = revisionRead.ok ? revisionRead.value : undefined;

    if (!isTargetType(type)) collect(reason_codes, details, 'INPUT_TARGET_TYPE_INVALID', 'target_ref.type');
    if (typeof id !== 'string' || id.length < TARGET_ID_MIN_LENGTH || id.length > TARGET_ID_MAX_LENGTH) {
      collect(reason_codes, details, 'INPUT_TARGET_ID_INVALID', 'target_ref.id');
    }
    if (
      typeof revision !== 'number' ||
      !Number.isSafeInteger(revision) ||
      revision < TARGET_REVISION_MIN
    ) {
      collect(reason_codes, details, 'INPUT_TARGET_REVISION_INVALID', 'target_ref.revision');
    }
    if (
      isTargetType(type) &&
      typeof id === 'string' &&
      id.length >= TARGET_ID_MIN_LENGTH &&
      id.length <= TARGET_ID_MAX_LENGTH &&
      typeof revision === 'number' &&
      Number.isSafeInteger(revision) &&
      revision >= TARGET_REVISION_MIN
    ) {
      target_ref = { type, id, revision };
    }
  }

  // ---- text ----
  const textRead = safeGet(input, 'text');
  if (!textRead.ok) {
    collect(reason_codes, details, 'INPUT_READ_FAILED', 'text');
  }
  let text = null;
  if (!textRead.present) {
    collect(reason_codes, details, 'INPUT_TEXT_MISSING', 'text');
  } else if (typeof textRead.value !== 'string') {
    collect(reason_codes, details, 'INPUT_TEXT_NOT_STRING', 'text');
  } else {
    const value = textRead.value;
    if (value.trim().length === 0) {
      collect(reason_codes, details, 'INPUT_TEXT_EMPTY', 'text');
    } else if (value.length > maxTextLength) {
      collect(reason_codes, details, 'INPUT_TEXT_TOO_LONG', 'text');
    } else if (
      LONE_SURROGATE.test(value) ||
      DISALLOWED_CONTROL.test(value) ||
      value.includes(REPLACEMENT_CHAR)
    ) {
      collect(reason_codes, details, 'INPUT_TEXT_ENCODING_INVALID', 'text');
    } else {
      text = value;
    }
  }

  // ---- media ----
  // 必须**显式**声明：省略 media ≠ 没有媒体。图片审核属模型层，
  // 规则层不能替它下结论，所以"未知是否有媒体"同样不放行。
  const mediaRead = safeGet(input, 'media');
  if (!mediaRead.ok) {
    collect(reason_codes, details, 'INPUT_READ_FAILED', 'media');
  }
  let media_count = null;
  if (!mediaRead.present) {
    collect(reason_codes, details, 'INPUT_MEDIA_MISSING', 'media');
  } else if (!Array.isArray(mediaRead.value)) {
    collect(reason_codes, details, 'INPUT_MEDIA_NOT_ARRAY', 'media');
  } else {
    media_count = mediaRead.value.length;
  }

  const covered = isCoveredTargetType(target_ref?.type);
  const has_media = typeof media_count === 'number' && media_count > 0;

  return {
    valid: reason_codes.length === 0,
    reason_codes,
    details,
    target_ref,
    text,
    media_count,
    covered,
    media_declared: typeof media_count === 'number',
    has_media,
  };
}
