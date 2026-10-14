/**
 * GY-I14（#14）审核 HTTP 装配片 · **供应商审核回调的验签与版本核对**（派单 §2.6）。
 *
 * 位置（架构决议，必须照抄口径）：`docs/architecture/adr-001-initial-architecture.md` §62 —
 * “供应商 callback 只允许服务端受信端点并验签，**不在客户端 OpenAPI 开放**；回调必须核对
 * job revision、lease token、账号/授权 epoch 和删除清单。”
 * ⇒ 回调**不是**一条契约路径（本片**不新增** `packages/contracts/**` 里的任何 path/字段），
 * 而是服务端受信 seam：`service.ingestCallback(...)` 由传输层（未来由指挥决定是否挂 HTTP 端点）调用。
 *
 * 拒绝口径（全部 fail-closed，且**不允许**被"再试一次"绕过）：
 *   - 伪造/篡改/缺失签名 ⇒ `CALLBACK_SIGNATURE_INVALID`（HMAC-SHA256 + 定时安全比较）；
 *   - 签发时间越出允许偏差 ⇒ `CALLBACK_EXPIRED`（过期回调）；
 *   - 回放（同一 `event_id` 已经落定过）⇒ `CALLBACK_REPLAY`；
 *   - `job_revision` / `lease_token` / `target_ref` / 授权 epoch 与当前任务不一致 ⇒ 各自原因码；
 *   - **过期版本**（rule / model / prompt 版本与当前不一致）⇒ 各自 `*_STALE`；
 *   - 输入摘要与任务登记的摘要不一致 ⇒ `CALLBACK_INPUT_DIGEST_MISMATCH`（换内容不换版本）；
 *   - 目标已下架 ⇒ `CALLBACK_TARGET_WITHDRAWN`（旧回调不得复活下架对象）；
 *   - 任务已终态（`succeeded`/`cancelled`）⇒ `CALLBACK_JOB_TERMINAL`（旧回调不复活）。
 *
 * 关键：**回调只完成"筛查"，绝不发布**。`ingestCallback` 的成功路径只把版本级任务落定，
 * 发布是独立的 `service.publish`（并在那时重跑全部闸门）。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { MODEL_VERDICT_LABELS } from '../../../../packages/moderation/model-verdict.mjs';
import { CONTENT_KINDS, TARGET_REF_TYPES } from './types.ts';
import type { ContentKind, JobState, TargetRef } from './types.ts';
import { MODEL_CONTROL_FIELD_FORBIDDEN, scanForbiddenControlFields } from './nonbypass.ts';

/** 回调信封方案标识（进签名载荷，便于将来并存新方案而不静默混用）。 */
export const CALLBACK_SCHEMA = 'gengyun/moderation/provider-callback@1';

/** 允许的签发时间偏差（毫秒）：超出即"过期回调"。 */
export const CALLBACK_MAX_SKEW_MS = 5 * 60 * 1000;

/** 回调拒绝原因码闭集（非契约错误码；传输层按契约闭集映射 HTTP 码）。 */
export const CALLBACK_REASON_CODES = Object.freeze([
  'CALLBACK_SIGNATURE_INVALID',
  'CALLBACK_PAYLOAD_INVALID',
  'CALLBACK_CONTROL_FIELD_FORBIDDEN',
  'CALLBACK_EXPIRED',
  'CALLBACK_JOB_UNKNOWN',
  'CALLBACK_REPLAY',
  'CALLBACK_JOB_REVISION_STALE',
  'CALLBACK_LEASE_MISMATCH',
  'CALLBACK_JOB_TERMINAL',
  'CALLBACK_TARGET_REVISION_STALE',
  'CALLBACK_EPOCH_REVOKED',
  'CALLBACK_RULE_VERSION_STALE',
  'CALLBACK_MODEL_VERSION_STALE',
  'CALLBACK_PROMPT_VERSION_STALE',
  'CALLBACK_INPUT_DIGEST_MISMATCH',
  'CALLBACK_TARGET_WITHDRAWN',
  'CALLBACK_CONTENT_KIND_MISMATCH',
]);

export interface CallbackVerdict {
  label: (typeof MODEL_VERDICT_LABELS)[number];
  reason_codes?: string[];
  summary?: string;
}

export interface CallbackEnvelope {
  schema: string;
  /** 供应商侧事件 id（**幂等键**：回放检测用它）。 */
  event_id: string;
  /** 供应商签发时间（ISO date-time）。 */
  issued_at: string;
  job_id: string;
  /** 回调必须回带**当前**作业版本（旧版本回调拒绝）。 */
  job_revision: number;
  /** 回调必须回带**当前**租约（旧租约/无租约拒绝）。 */
  lease_token: string;
  /** 供应商实际检查过的输入摘要（必须等于任务登记的摘要）。 */
  input_digest: string;
  target_ref: TargetRef;
  content_kind: ContentKind;
  rule_version: string;
  model_version: string;
  prompt_version: string;
  /** 账号/授权 epoch：撤回/注销后旧回调不得回写。 */
  authorization_epoch: number;
  verdict: CallbackVerdict;
}

export interface CallbackParseResult {
  ok: boolean;
  envelope: CallbackEnvelope | null;
  reason_codes: string[];
  issues: string[];
}

/**
 * 回调受理结果（**服务端受信 seam** 的返回值；本片不注册路由）。
 * `contract_error_code` 是给传输层用的契约错误码提示（见 `service.ts` 的映射表）。
 */
export interface CallbackOutcome {
  accepted: boolean;
  reason_codes: string[];
  issues: string[];
  /** 被落定的版本级任务投影（拒绝时为 `null`）。 */
  task: import('./types.ts').ModerationTaskView | null;
  /** 传输层可直接使用的契约 `ErrorCode`（拒绝时的建议映射；接受时为 `null`）。 */
  contract_error_code: string | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(holder: Record<string, unknown>, field: string, max = 200): string | null {
  const value = holder[field];
  if (typeof value !== 'string' || value.length < 1 || value.length > max) return null;
  return value;
}

function readPositiveInt(holder: Record<string, unknown>, field: string): number | null {
  const value = holder[field];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return null;
  return value;
}

/** 对**原始请求体**（逐字节）做 HMAC-SHA256，返回 base64url 签名。 */
export function signCallbackPayload(rawBody: string, signingKey: string): string {
  return createHmac('sha256', signingKey).update(rawBody, 'utf8').digest('base64url');
}

/**
 * 定时安全验签：缺失/非字符串/长度不符一律 `false`（**绝不**在长度不等时比较）。
 */
export function verifyCallbackSignature(rawBody: string, signature: unknown, signingKey: string): boolean {
  if (typeof signature !== 'string' || signature.length === 0) return false;
  const expected = signCallbackPayload(rawBody, signingKey);
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(signature, 'utf8');
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

/**
 * 解析并**静态校验**回调信封（签名之外的全部形状/闭集检查）。
 *
 * 同时跑**非绕过扫描**：回报里出现任何控制类字段（role/scope/source_kind/visibility/
 * expert_reviewed/vote/…）⇒ 整条拒绝（`CALLBACK_CONTROL_FIELD_FORBIDDEN`），
 * 与模型端口回报同一口径（见 `nonbypass.ts`）。
 */
export function parseCallbackEnvelope(rawBody: string): CallbackParseResult {
  const reason_codes: string[] = [];
  const issues: string[] = [];
  const fail = (code: string, issue: string): CallbackParseResult => {
    if (!reason_codes.includes(code)) reason_codes.push(code);
    issues.push(issue);
    return { ok: false, envelope: null, reason_codes, issues };
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return fail('CALLBACK_PAYLOAD_INVALID', '请求体不是合法 JSON');
  }
  if (!isPlainObject(parsed)) return fail('CALLBACK_PAYLOAD_INVALID', '回调信封必须是对象');

  const scan = scanForbiddenControlFields(parsed);
  if (!scan.ok) {
    return fail(
      'CALLBACK_CONTROL_FIELD_FORBIDDEN',
      `回调携带控制类字段（${scan.hits.map((hit) => hit.field).slice(0, 8).join(',')}）⇒ 拒绝`,
    );
  }

  if (parsed['schema'] !== CALLBACK_SCHEMA) {
    return fail('CALLBACK_PAYLOAD_INVALID', `schema 必须是 ${CALLBACK_SCHEMA}`);
  }
  const eventId = readString(parsed, 'event_id', 80);
  if (eventId === null) return fail('CALLBACK_PAYLOAD_INVALID', 'event_id 必须是 1..80 的字符串');
  const issuedAt = readString(parsed, 'issued_at', 40);
  if (issuedAt === null || Number.isNaN(Date.parse(issuedAt))) {
    return fail('CALLBACK_PAYLOAD_INVALID', 'issued_at 必须是可解析的 date-time');
  }
  const jobId = readString(parsed, 'job_id', 80);
  if (jobId === null) return fail('CALLBACK_PAYLOAD_INVALID', 'job_id 必须是 1..80 的字符串');
  const jobRevision = readPositiveInt(parsed, 'job_revision');
  if (jobRevision === null) return fail('CALLBACK_PAYLOAD_INVALID', 'job_revision 必须是 ≥1 的整数');
  const leaseToken = readString(parsed, 'lease_token', 200);
  if (leaseToken === null) return fail('CALLBACK_PAYLOAD_INVALID', 'lease_token 必须是 1..200 的字符串');
  const inputDigest = readString(parsed, 'input_digest', 80);
  if (inputDigest === null) return fail('CALLBACK_PAYLOAD_INVALID', 'input_digest 必须是 1..80 的字符串');
  const ruleVersion = readString(parsed, 'rule_version', 80);
  if (ruleVersion === null) return fail('CALLBACK_PAYLOAD_INVALID', 'rule_version 必须是 1..80 的字符串');
  const modelVersion = readString(parsed, 'model_version', 80);
  if (modelVersion === null) return fail('CALLBACK_PAYLOAD_INVALID', 'model_version 必须是 1..80 的字符串');
  const promptVersion = readString(parsed, 'prompt_version', 80);
  if (promptVersion === null) return fail('CALLBACK_PAYLOAD_INVALID', 'prompt_version 必须是 1..80 的字符串');
  const authorizationEpoch = readPositiveInt(parsed, 'authorization_epoch');
  if (authorizationEpoch === null) {
    return fail('CALLBACK_PAYLOAD_INVALID', 'authorization_epoch 必须是 ≥1 的整数');
  }
  const contentKind = parsed['content_kind'];
  if (typeof contentKind !== 'string' || !(CONTENT_KINDS as readonly string[]).includes(contentKind)) {
    return fail('CALLBACK_PAYLOAD_INVALID', 'content_kind 必须是 text|image');
  }
  const refRead = parsed['target_ref'];
  if (!isPlainObject(refRead)) return fail('CALLBACK_PAYLOAD_INVALID', 'target_ref 必须是对象');
  const refType = refRead['type'];
  if (typeof refType !== 'string' || !(TARGET_REF_TYPES as readonly string[]).includes(refType)) {
    return fail('CALLBACK_PAYLOAD_INVALID', 'target_ref.type 必须是契约闭集成员');
  }
  const refId = readString(refRead, 'id', 80);
  if (refId === null) return fail('CALLBACK_PAYLOAD_INVALID', 'target_ref.id 必须是 1..80 的字符串');
  const refRevision = readPositiveInt(refRead, 'revision');
  if (refRevision === null) return fail('CALLBACK_PAYLOAD_INVALID', 'target_ref.revision 必须是 ≥1 的整数');

  const verdictRead = parsed['verdict'];
  if (!isPlainObject(verdictRead)) return fail('CALLBACK_PAYLOAD_INVALID', 'verdict 必须是对象');
  const label = verdictRead['label'];
  if (typeof label !== 'string' || !(MODEL_VERDICT_LABELS as readonly string[]).includes(label)) {
    return fail('CALLBACK_PAYLOAD_INVALID', 'verdict.label 必须是 pass|block|unsure');
  }
  const verdictReasonCodes = verdictRead['reason_codes'];
  if (verdictReasonCodes !== undefined && !Array.isArray(verdictReasonCodes)) {
    return fail('CALLBACK_PAYLOAD_INVALID', 'verdict.reason_codes 必须是数组');
  }
  const summary = verdictRead['summary'];
  if (summary !== undefined && typeof summary !== 'string') {
    return fail('CALLBACK_PAYLOAD_INVALID', 'verdict.summary 必须是字符串');
  }

  return {
    ok: true,
    envelope: {
      schema: CALLBACK_SCHEMA,
      event_id: eventId,
      issued_at: issuedAt,
      job_id: jobId,
      job_revision: jobRevision,
      lease_token: leaseToken,
      input_digest: inputDigest,
      target_ref: { type: refType as TargetRef['type'], id: refId, revision: refRevision },
      content_kind: contentKind as ContentKind,
      rule_version: ruleVersion,
      model_version: modelVersion,
      prompt_version: promptVersion,
      authorization_epoch: authorizationEpoch,
      verdict: {
        label: label as CallbackVerdict['label'],
        ...(Array.isArray(verdictReasonCodes) ? { reason_codes: verdictReasonCodes.filter((code) => typeof code === 'string') } : {}),
        ...(typeof summary === 'string' ? { summary } : {}),
      },
    },
    reason_codes: [],
    issues: [],
  };
}

/** 签发时间是否越界（过期回调）。 */
export function isCallbackExpired(issuedAt: string, now: number, maxSkewMs = CALLBACK_MAX_SKEW_MS): boolean {
  const issued = Date.parse(issuedAt);
  if (Number.isNaN(issued)) return true;
  return Math.abs(now - issued) > maxSkewMs;
}

/**
 * 回放守卫：**只在成功落定后**消费 `event_id`（键 = `job_id|event_id`）。
 * 因此在版本/签名等前置校验就被拒的回调，不会把事件 id 提前烧掉（供应商可用同一 id 重试到成功）。
 */
export interface CallbackReplayGuard {
  /** 该事件是否已落定过。 */
  seen(jobId: string, eventId: string): boolean;
  markSettled(jobId: string, eventId: string): void;
  settledCount(): number;
}

export function createCallbackReplayGuard(): CallbackReplayGuard {
  const settled = new Set<string>();
  const key = (jobId: string, eventId: string): string => `${jobId}|${eventId}`;
  return {
    seen(jobId, eventId) {
      return settled.has(key(jobId, eventId));
    },
    markSettled(jobId, eventId) {
      settled.add(key(jobId, eventId));
    },
    settledCount() {
      return settled.size;
    },
  };
}

/** 任务已终态（旧回调不得复活）。 */
export function isTerminalTaskState(state: JobState): boolean {
  return state === 'succeeded' || state === 'cancelled';
}

/** 供文档/测试引用的字段名常量（非绕过：这些键出现在回调里即拒绝）。 */
export const CALLBACK_FORBIDDEN_FIELD_CODE = MODEL_CONTROL_FIELD_FORBIDDEN;
