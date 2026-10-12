/**
 * GY-I14 模型层（第二片）· 模型审核**端口**（可注入、默认关闭）。
 *
 * 派单 §3.1 的两条硬要求，本文件用**结构性手段**（而不是运行期开关）落实：
 *
 *  1) **本包不含任何联网能力**：没有 HTTP 客户端调用、没有 Node HTTP 模块、没有供应商 SDK、
 *     没有环境变量读取、没有凭据常量。网络能力只能来自**注入方**持有的 seam：
 *     `fetchImpl` / `credentials` / `liveGate` / `now`（见 `MODEL_PORT_SEAMS`）。
 *     本包对这四个 seam **没有任何默认实现**（`MODEL_PORT_SEAM_DEFAULTS` 全部为 `null`），
 *     因此"默认关闭"不依赖任何运行期判断，而是"类型上没有默认实现"。
 *  2) **应用装配路径永不提供端口**：本包不导出任何端口实现、不读取配置、不构造端口。
 *     缺端口时 `execution_mode === 'real'` 的行为与"未接线"**逐字节相同**（合流层只用注入
 *     的端口，不看 `execution_mode` 决定要不要跑），两者都 fail-closed。
 *
 * ⚠️ 本阶段**不发起任何真实审核/联网请求**：
 *   真实 `tms`/`ims` 调用需要用户交接两个真实 `BizType`（现为自描述占位值，
 *   `tools/ai-config.mjs` 的 `policySelectionVerified` 恒为 `false`）。
 *   因此合流层要求端口显式声明 `provider.biz_type_selection_verified === true`
 *   **才会调用** `evaluate`；本仓库当前不存在这样的端口，测试里的端口是
 *   `provider.synthetic === true` 的合成替身，只作确定性回归，**不得**读成"真实审核已接通"。
 *
 * 隐私：请求对象里允许出现待筛查正文（端口需要它），但本包**不落盘、不打印、不序列化**它；
 * 图片一律只传**不透明引用**（media_id / mime / 字节数），**不传图片字节**。
 */
import {
  REASON_CODE_MAX_LENGTH,
  REASON_CODE_MIN_LENGTH,
  TARGET_ID_MAX_LENGTH,
  TARGET_ID_MIN_LENGTH,
  TARGET_REVISION_MIN,
} from './constants.mjs';

/** 端口种类闭集：`tms` = 文本审核端口，`ims` = 图片审核端口（命名沿用 tools/ai-config.mjs）。 */
export const MODEL_PORT_KINDS = Object.freeze(['tms', 'ims']);

/** 端口的唯一执行入口名。 */
export const MODEL_PORT_ENTRY = 'evaluate';

/** 真实网络能力的载体 seam：必须由**注入方**持有，本包一律不内置、也不读取其值。 */
export const MODEL_PORT_SEAMS = Object.freeze(['fetchImpl', 'credentials', 'liveGate', 'now']);

/**
 * 本包对这些 seam 的"默认实现"——**全部为 `null`**。
 * 这是"默认关闭靠类型上没有默认实现"的**可断言证据**（见 tests/moderation/model-ports.test.mjs）。
 */
export const MODEL_PORT_SEAM_DEFAULTS = Object.freeze({
  fetchImpl: null,
  credentials: null,
  liveGate: null,
  now: null,
  evaluate: null,
});

/** 端口必须声明的顶层字段。 */
export const MODEL_PORT_REQUIRED_FIELDS = Object.freeze([
  'kind',
  'model_version',
  'evaluate',
  'seams',
  'provider',
]);

/** 端口 provider 绑定必须声明的字段（声明式；本包不据此发包，只据此决定"要不要跑"）。 */
export const MODEL_PROVIDER_REQUIRED_FIELDS = Object.freeze([
  'biz_type',
  'biz_type_selection_verified',
  'synthetic',
]);

/** 图片引用允许的字段（只允许不透明引用与元数据，**不允许**字节）。 */
export const MEDIA_REF_FIELDS = Object.freeze(['media_id', 'media_revision', 'mime', 'bytes']);

/** 模型侧失败类别闭集（用于把异常归类成可判别原因，不是契约枚举）。 */
export const MODEL_FAILURE_CLASSES = Object.freeze([
  'timeout',
  'quota_exceeded',
  'auth_failed',
  'payload_invalid',
  'response_shape_unknown',
  'port_error',
]);

/** 失败类别 -> 原因码（合流层据此写 `reason_codes`）。 */
export const MODEL_FAILURE_REASON_CODE_BY_CLASS = Object.freeze({
  timeout: 'MODEL_TIMEOUT',
  quota_exceeded: 'MODEL_QUOTA_EXCEEDED',
  auth_failed: 'MODEL_AUTH_FAILED',
  payload_invalid: 'MODEL_PAYLOAD_INVALID',
  response_shape_unknown: 'MODEL_RESPONSE_SHAPE_UNKNOWN',
  port_error: 'MODEL_PORT_ERROR',
});

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
  return typeof value === 'string' && value.length >= REASON_CODE_MIN_LENGTH && value.length <= 80;
}

/**
 * 校验注入的端口是否可用。
 *
 * @param {unknown} port
 * @param {'tms'|'ims'} expectedKind 本次用途（tms 端口不得承担图片审核，反之亦然）
 * @returns {{valid: boolean, reason_codes: string[], details: Array<{field: string|null, code: string}>,
 *   model_version: string|null, synthetic: boolean|null, timeout_ms: number|null}}
 */
export function validateModelPort(port, expectedKind) {
  const reason_codes = [];
  const details = [];
  const add = (code, field) => {
    if (!reason_codes.includes(code)) reason_codes.push(code);
    details.push({ field, code });
  };
  const fail = {
    valid: false,
    reason_codes,
    details,
    model_version: null,
    synthetic: null,
    timeout_ms: null,
  };

  if (!isPlainObject(port)) {
    add('MODEL_LAYER_PORT_INVALID', 'port');
    return fail;
  }

  // 1) 端口种类必须与用途一致（串端口 = 用文本端口判断图片）。
  const kindRead = safeGet(port, 'kind');
  if (!kindRead.ok || typeof kindRead.value !== 'string' || !MODEL_PORT_KINDS.includes(kindRead.value)) {
    add('MODEL_LAYER_PORT_INVALID', 'kind');
  } else if (kindRead.value !== expectedKind) {
    add('MODEL_LAYER_PORT_INVALID', 'kind');
  }

  // 2) 执行入口必须是函数（缺入口 ⇒ 永远不会跑，等价于未接线）。
  const entryRead = safeGet(port, MODEL_PORT_ENTRY);
  if (!entryRead.ok || typeof entryRead.value !== 'function') {
    add('MODEL_LAYER_PORT_INVALID', MODEL_PORT_ENTRY);
  }

  // 3) 网络 seam 必须由注入方**显式**声明持有：缺一个即拒（"忘了接线"不得被当成"跑过了"）。
  const seamsRead = safeGet(port, 'seams');
  if (!seamsRead.ok || !isPlainObject(seamsRead.value)) {
    add('MODEL_LAYER_PORT_INVALID', 'seams');
  } else {
    for (const seam of MODEL_PORT_SEAMS) {
      const seamRead = safeGet(seamsRead.value, seam);
      if (!seamRead.ok || seamRead.value === undefined || seamRead.value === null) {
        add('MODEL_LAYER_PORT_INVALID', `seams.${seam}`);
      }
    }
  }

  // 4) 模型版本标识：缺/空/越界 ⇒ 单独报"版本缺失"，**绝不**填占位串。
  const versionRead = safeGet(port, 'model_version');
  const modelVersion = versionRead.ok ? versionRead.value : undefined;
  if (!isVersionString(modelVersion)) {
    add('MODEL_VERSION_MISSING', 'model_version');
  }

  // 5) provider 绑定声明（BizType 选择是否已核验）。
  const providerRead = safeGet(port, 'provider');
  let synthetic = null;
  let timeoutMs = null;
  if (!providerRead.ok || !isPlainObject(providerRead.value)) {
    add('MODEL_LAYER_PORT_INVALID', 'provider');
  } else {
    const provider = providerRead.value;
    for (const field of MODEL_PROVIDER_REQUIRED_FIELDS) {
      const read = safeGet(provider, field);
      if (!read.ok || read.value === undefined) add('MODEL_LAYER_PORT_INVALID', `provider.${field}`);
    }
    const syntheticRead = safeGet(provider, 'synthetic');
    if (syntheticRead.ok && syntheticRead.value !== undefined) {
      if (typeof syntheticRead.value !== 'boolean') add('MODEL_LAYER_PORT_INVALID', 'provider.synthetic');
      else synthetic = syntheticRead.value;
    }
    // 未核验的 BizType ⇒ 不调用（这正是"占位 BizType ⇒ 不发真实请求"的闸门）。
    const verifiedRead = safeGet(provider, 'biz_type_selection_verified');
    if (verifiedRead.ok && verifiedRead.value !== true) {
      add('MODEL_BIZTYPE_UNVERIFIED', 'provider.biz_type_selection_verified');
    }
    const timeoutRead = safeGet(provider, 'timeout_ms');
    if (timeoutRead.ok && typeof timeoutRead.value === 'number' && Number.isFinite(timeoutRead.value) && timeoutRead.value > 0) {
      timeoutMs = timeoutRead.value;
    }
  }

  return {
    valid: reason_codes.length === 0,
    reason_codes,
    details,
    model_version: isVersionString(modelVersion) ? modelVersion : null,
    synthetic,
    timeout_ms: timeoutMs,
  };
}

/**
 * 把端口抛出的异常归类成可判别原因。
 *
 * 优先采信注入方**显式声明**的 `error.model_failure`（应为 `MODEL_FAILURE_CLASSES` 之一）；
 * 其余按下表启发式归类（HTTP 状态 → 类别），未知一律 `port_error`（**绝不当成通过**）。
 */
export function classifyModelFailure(error) {
  if (isPlainObject(error)) {
    const declared = safeGet(error, 'model_failure');
    if (declared.ok && typeof declared.value === 'string' && MODEL_FAILURE_CLASSES.includes(declared.value)) {
      return declared.value;
    }
  }
  const name = isPlainObject(error) || error instanceof Error ? String(error?.name ?? '') : '';
  const code = isPlainObject(error) || error instanceof Error ? String(error?.code ?? '') : '';
  const statusRead = isPlainObject(error) || error instanceof Error
    ? [safeGet(error, 'http_status'), safeGet(error, 'status'), safeGet(error, 'statusCode')]
    : [];
  const statuses = statusRead
    .filter((read) => read.ok && typeof read.value === 'number')
    .map((read) => read.value);

  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  if (/TIMEOUT|ETIMEDOUT|ECONNABORTED|DEADLINE/.test(code)) return 'timeout';
  if (statuses.includes(401) || statuses.includes(403)) return 'auth_failed';
  if (statuses.includes(429)) return 'quota_exceeded';
  if (statuses.includes(400) || statuses.includes(413) || statuses.includes(422)) return 'payload_invalid';
  if (/QUOTA|RATE_LIMIT|THROTTL/i.test(code)) return 'quota_exceeded';
  if (/AUTH|UNAUTHORIZED|FORBIDDEN|CREDENTIAL/i.test(code)) return 'auth_failed';
  if (/PAYLOAD|MALFORMED|BAD_REQUEST|INVALID_REQUEST/i.test(code)) return 'payload_invalid';
  return 'port_error';
}

/** 失败类别 -> 原因码（未知类别回落 `MODEL_PORT_ERROR`，绝不回落成"通过"）。 */
export function modelFailureReasonCode(failureClass) {
  if (typeof failureClass !== 'string') return 'MODEL_PORT_ERROR';
  return MODEL_FAILURE_REASON_CODE_BY_CLASS[failureClass] ?? 'MODEL_PORT_ERROR';
}

/**
 * 构造给注入端口的请求对象（**离线构造，不发包**）。
 *
 * 用例可据此断言"请求里没有任何凭据、没有图片字节"，也可断言本包从不自己发包
 * （本函数只返回普通对象，不做任何 I/O）。
 */
export function buildModelRequest({ kind, prompt, prompt_version: promptVersion, target_ref: targetRef, text, media_refs: mediaRefs }) {
  return {
    schema: 'gengyun/moderation/model-request@1',
    kind,
    prompt_id: prompt.id,
    prompt_version: promptVersion,
    required_output_fields: [...prompt.required_output_fields],
    verdict_labels: [...prompt.verdict_labels],
    target_ref: targetRef,
    content: kind === 'ims' ? { media_refs: mediaRefs } : { text },
  };
}

/**
 * 归一一个图片引用：只接受**不透明引用 + 元数据**，不接受字节。
 *
 * @returns {{ok: boolean, ref: object|null, reason_codes: string[], details: Array<object>}}
 */
export function normalizeMediaRef(item) {
  const reason_codes = [];
  const details = [];
  const add = (code, field) => {
    if (!reason_codes.includes(code)) reason_codes.push(code);
    details.push({ field, code });
  };
  if (!isPlainObject(item)) {
    add('MODEL_PAYLOAD_INVALID', 'media');
    return { ok: false, ref: null, reason_codes, details };
  }
  for (const key of Object.keys(item)) {
    if (!MEDIA_REF_FIELDS.includes(key) && key !== 'kind') add('MODEL_PAYLOAD_INVALID', `media.${key}`);
  }
  const bytesRead = safeGet(item, 'bytes');
  if (bytesRead.ok && bytesRead.value !== undefined) add('MODEL_PAYLOAD_INVALID', 'media.bytes');
  const idRead = safeGet(item, 'media_id');
  const refRead = safeGet(item, 'ref');
  const id = idRead.ok && typeof idRead.value === 'string' ? idRead.value : null;
  const opaqueRef = refRead.ok && typeof refRead.value === 'string' ? refRead.value : null;
  const identifier = id ?? opaqueRef;
  if (
    typeof identifier !== 'string' ||
    identifier.length < TARGET_ID_MIN_LENGTH ||
    identifier.length > TARGET_ID_MAX_LENGTH
  ) {
    add('MODEL_PAYLOAD_INVALID', 'media.media_id');
  }
  const mimeRead = safeGet(item, 'mime');
  const kindRead = safeGet(item, 'kind');
  const mime = mimeRead.ok && typeof mimeRead.value === 'string' ? mimeRead.value : null;
  const declaredKind = kindRead.ok && typeof kindRead.value === 'string' ? kindRead.value : null;
  const imageLike = (typeof mime === 'string' && mime.startsWith('image/')) || declaredKind === 'image';
  if (!imageLike) add('MODEL_MEDIA_UNSUPPORTED', 'media.mime');
  if (typeof mime === 'string' && mime.length > REASON_CODE_MAX_LENGTH) add('MODEL_PAYLOAD_INVALID', 'media.mime');
  const revisionRead = safeGet(item, 'media_revision');
  let revision = null;
  if (revisionRead.ok && revisionRead.value !== undefined) {
    if (
      typeof revisionRead.value !== 'number' ||
      !Number.isSafeInteger(revisionRead.value) ||
      revisionRead.value < TARGET_REVISION_MIN
    ) {
      add('MODEL_PAYLOAD_INVALID', 'media.media_revision');
    } else {
      revision = revisionRead.value;
    }
  }
  if (reason_codes.length > 0) return { ok: false, ref: null, reason_codes, details };
  return {
    ok: true,
    ref: { media_id: identifier, media_revision: revision, mime: mime ?? 'image/unknown' },
    reason_codes,
    details,
  };
}
