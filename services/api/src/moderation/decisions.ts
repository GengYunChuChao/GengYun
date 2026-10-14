/**
 * GY-I14（#14）审核 HTTP 装配片 · **版本级审核任务台账**与判定投影。
 *
 * 台账（对照数据字典 `docs/architecture/data-dictionary.md` 的 `moderation_decisions`）：
 *   `id; target_type/id/revision; job_id; decision enum; reason_codes jsonb; checked_media_hashes jsonb;
 *    rule/prompt/model_version; hard_rule_passed boolean`，唯一键 `(target_type,target_id,revision,job_id)`
 *   —— 本模块用**内存**实现（PG 迁移不属本片），键集合与语义逐项对齐。
 *
 * **文字与图片各自成版本级任务**（派单 §2.1）：同一 `(target,revision)` 下按 `content_kind`
 * 各有一条当前任务（各有独立 `job_id`、端口类别、prompt 模板与结论行）。
 *
 * 判定投影（`projectKindScreening`）**不改写**任何已合并口径：
 *   - 规则层 `rejected` ⇒ 两类任务都是 `rejected`，**模型端口不跑**（规则先挡）；
 *   - 规则层未能求值（输入非法／超时／引擎异常／媒体未评估）⇒ `quarantined` + `uncertain`；
 *   - 规则层通过后：该端口 `blocked` ⇒ `rejected`；`pass` ⇒ `approved`；
 *     其余（失败／超时／未求值／无结论／缺证据）⇒ `quarantined` + `uncertain`。
 * 这与 `packages/moderation/merge.mjs` 的判定完全同向（规则未通过时结论只能是规则层结论，
 * 通过时才由端口证据决定），因此**不需要**第二套规则引擎或第二套合流判定。
 */
import {
  orderReasonCodes,
  truncateReasonCodes,
} from '../../../../packages/moderation/engine.mjs';
import type { MergedModeration, MergedKindEntry } from '../../../../packages/moderation/merge.mjs';
import { collectResultValueIssues } from '../jobs/result-shape.ts';
import {
  CONTENT_KINDS,
  PORT_KIND_BY_CONTENT_KIND,
  PROMPT_ID_BY_CONTENT_KIND,
} from './types.ts';
import type {
  AuditState,
  ContentKind,
  ContractModeration,
  GateHolder,
  GateKindEntry,
  JobState,
  ModerationTaskRecord,
  ModerationTaskView,
  TargetRef,
  TaskEvidence,
} from './types.ts';

/** 契约 `Moderation.reason_codes` 上限（maxItems 30）。 */
export const REASON_CODES_MAX_ITEMS = 30;

/** 内容带媒体时，哪些内容类别需要版本级任务（文字恒有；有媒体时图片另有）。 */
export function contentKindsFor(mediaCount: number): ContentKind[] {
  return mediaCount > 0 ? ['text', 'image'] : ['text'];
}

/** 内容需要的端口类别（与 `merged-invariant.requiredModelPortKinds` 同口径：有媒体额外要 ims）。 */
export function requiredPortKindsFor(mediaCount: number): Array<'tms' | 'ims'> {
  return mediaCount > 0 ? ['tms', 'ims'] : ['tms'];
}

/** 台账键：`<内容类别>|<类型>|<id>|<revision>`（唯一键的等价表达，含 content_kind）。 */
export function taskKey(target: TargetRef, kind: ContentKind): string {
  return `${kind}|${target.type}|${target.id}|${target.revision}`;
}

/** 内容级键（同一目标同一 revision 的两类任务共享它）。 */
export function targetKey(target: TargetRef): string {
  return `${target.type}|${target.id}|${target.revision}`;
}

/** 判定 ⇒ 作业状态（隔离一律 `uncertain`：调用方**读得到**隔离原因，见 `errorCodeFor`）。 */
export function jobStateForDecision(decision: AuditState): JobState {
  if (decision === 'approved' || decision === 'rejected') return 'succeeded';
  if (decision === 'pending') return 'queued';
  return 'uncertain';
}

const INPUT_FAILURE_CODES = new Set([
  'INPUT_NOT_OBJECT',
  'INPUT_UNKNOWN_FIELD',
  'INPUT_TYPE_INVALID',
  'INPUT_ID_INVALID',
  'INPUT_REVISION_INVALID',
  'INPUT_TEXT_MISSING',
  'INPUT_TEXT_TOO_LONG',
  'INPUT_TEXT_ENCODING_INVALID',
  'INPUT_MEDIA_INVALID',
  'INPUT_COVERAGE_UNKNOWN',
  'INPUT_INVALID',
  'MEDIA_NOT_EVALUATED_BY_RULE_LAYER',
]);

/**
 * 隔离 ⇒ 契约 `ErrorCode`（闭集内取值，**不新造错误码**）。
 *
 * 口径说明（必须与文档一致）：本片**不合成** `timed_out` 作业状态——审核语义里
 * "超时"就是"无结论"，用 `uncertain` 才能把隔离原因码一并发出；因此这里只映射 `error_code`。
 */
export function errorCodeFor(args: {
  ruleReasonCodes: readonly string[];
  modelReasonCodes: readonly string[];
  modelStatus: GateKindEntry['status'] | null;
}): string | null {
  const codes = [...args.ruleReasonCodes, ...args.modelReasonCodes];
  if (codes.includes('RULE_TIMEOUT') || codes.includes('MODEL_TIMEOUT')) return 'PROVIDER_TIMEOUT';
  if (codes.some((code) => INPUT_FAILURE_CODES.has(code))) return 'INPUT_UNCERTAIN';
  if (codes.includes('MODEL_LAYER_PORT_MISSING') || codes.includes('MODEL_BIZTYPE_UNVERIFIED')) {
    return 'PROVIDER_UNAVAILABLE';
  }
  if (
    codes.includes('RULE_ENGINE_ERROR') ||
    codes.includes('ENGINE_INVARIANT_VIOLATION') ||
    codes.includes('RULE_SCAN_TRUNCATED') ||
    codes.includes('REASON_CODES_TRUNCATED')
  ) {
    return 'PROVIDER_OUTCOME_UNKNOWN';
  }
  if (args.modelStatus === 'failed' || args.modelStatus === 'not_invoked') return 'PROVIDER_OUTCOME_UNKNOWN';
  return 'INPUT_UNCERTAIN';
}

/** 单类内容的判定投影结果。 */
export interface KindProjection {
  content_kind: ContentKind;
  decision: AuditState;
  state: JobState;
  reason_codes: string[];
  hard_rule_passed: boolean;
  rule_reason_codes: string[];
  model_reason_codes: string[];
  reasons: string[];
  error_code: string | null;
  rule_version: string | null;
  model_version: string | null;
  prompt_version: string | null;
}

/** 有序、去重、截断到契约上限（复用规则层的原因码排序，保证跨组件一致）。 */
export function orderedReasonCodes(codes: readonly string[]): string[] {
  const filtered = codes.filter((code) => typeof code === 'string' && code.length >= 1 && code.length <= 80);
  return truncateReasonCodes(orderReasonCodes([...new Set(filtered)]), REASON_CODES_MAX_ITEMS);
}

/**
 * 把（规则层结论 + 合流结论）投影成**某一类内容**的版本级判定。
 *
 * `merged === null` 表示模型层尚未求值（异步供应商模式下的 `queued`）。
 */
export function projectKindScreening(args: {
  contentKind: ContentKind;
  ruleDecision: AuditState;
  ruleReasonCodes: readonly string[];
  ruleInputValid: boolean;
  /** 规则层事实（`merged === null` 时结论里也必须如实登记它，否则"待回调"任务会丢掉规则层事实）。 */
  ruleHardPassed: boolean;
  /** 模型层是否**按调用方要求**留待回调（异步供应商路径）。 */
  modelDeferred?: boolean;
  merged: MergedModeration | null;
}): KindProjection {
  const portKind = PORT_KIND_BY_CONTENT_KIND[args.contentKind];
  const modelLayer = args.merged === null ? null : args.merged.model_layer;
  const kindEntry: MergedKindEntry | null = modelLayer?.kinds?.[portKind] ?? null;
  const modelReasonCodes = [
    ...(modelLayer?.reason_codes ?? []),
    ...(kindEntry?.reason_codes ?? []),
  ];
  const reasons: string[] = [];
  let decision: AuditState;
  let state: JobState;
  let errorCode: string | null = null;

  if (!args.ruleInputValid) {
    decision = 'quarantined';
    state = 'uncertain';
    errorCode = errorCodeFor({ ruleReasonCodes: args.ruleReasonCodes, modelReasonCodes: [], modelStatus: null });
    reasons.push('rule_input_not_usable');
  } else if (args.ruleDecision === 'rejected') {
    // 规则先挡：模型端口**不跑**（`merged` 必须为 null）。
    decision = 'rejected';
    state = 'succeeded';
    reasons.push('rule_rejected');
  } else if (args.merged === null && args.modelDeferred === true) {
    // 版本级任务已建立、模型层待回调（异步供应商路径）；`pending` 不得发布。
    decision = 'pending';
    state = 'queued';
    reasons.push('model_screening_pending');
  } else if (args.merged === null) {
    // 规则层**未得出可放行结论** ⇒ 装配层不外发（见 service 的 modelLayerReachable）⇒ 隔离。
    // 这不是"等回调"：没有任何端口会被调用，因此不得落在 `pending`（那会被误读为"在跑"）。
    decision = 'quarantined';
    state = 'uncertain';
    errorCode = errorCodeFor({ ruleReasonCodes: args.ruleReasonCodes, modelReasonCodes: [], modelStatus: null });
    reasons.push('model_not_attempted');
  } else if (args.ruleDecision !== 'approved') {
    decision = 'quarantined';
    state = 'uncertain';
    errorCode = errorCodeFor({
      ruleReasonCodes: args.ruleReasonCodes,
      modelReasonCodes,
      modelStatus: kindEntry?.status ?? null,
    });
    reasons.push('rule_fail_closed');
  } else if (kindEntry?.status === 'blocked') {
    decision = 'rejected';
    state = 'succeeded';
    reasons.push('model_blocked');
  } else if (kindEntry?.status === 'pass') {
    decision = 'approved';
    state = 'succeeded';
    reasons.push('rule_and_model_pass');
  } else {
    decision = 'quarantined';
    state = 'uncertain';
    errorCode = errorCodeFor({
      ruleReasonCodes: args.ruleReasonCodes,
      modelReasonCodes,
      modelStatus: kindEntry?.status ?? null,
    });
    reasons.push('model_no_conclusion');
  }

  return {
    content_kind: args.contentKind,
    decision,
    state,
    reason_codes: orderedReasonCodes([...args.ruleReasonCodes, ...modelReasonCodes]),
    hard_rule_passed: args.merged === null ? args.ruleHardPassed : args.merged.hard_rule_passed === true,
    rule_reason_codes: [...args.ruleReasonCodes],
    model_reason_codes: [...new Set(modelReasonCodes)],
    reasons,
    error_code: errorCode,
    rule_version: args.merged === null ? null : args.merged.rule_version,
    model_version: args.merged === null ? null : args.merged.model_version,
    prompt_version: args.merged === null ? null : args.merged.prompt_version,
  };
}

/** 由台账记录构造**契约合法**的 `Moderation`；不合法（缺 model/prompt 版本等）⇒ `null`。 */
export function buildContractModeration(
  record: {
    job_id: string;
    target_ref: TargetRef;
    decision: AuditState;
    reason_codes: string[];
    hard_rule_passed: boolean;
    model_version: string | null;
    prompt_version: string | null;
    rule_version: string | null;
  },
): ContractModeration | null {
  if (
    typeof record.model_version !== 'string' ||
    typeof record.prompt_version !== 'string' ||
    typeof record.rule_version !== 'string'
  ) {
    // 缺任一版本串 ⇒ 契约 `Moderation` 装配不出来：**绝不**填占位串（`missing_contract_fields` 的既有口径）。
    return null;
  }
  const candidate: ContractModeration = {
    id: record.job_id,
    target_ref: record.target_ref,
    decision: record.decision,
    reason_codes: record.reason_codes.slice(0, REASON_CODES_MAX_ITEMS),
    hard_rule_passed: record.hard_rule_passed,
    model_version: record.model_version,
    prompt_version: record.prompt_version,
    rule_version: record.rule_version,
  };
  // 用共享的契约镜像做**逐项**自检（键集合恰好 8 个、闭集、上界），不合规就返回 null：
  // 出口宁可"没有结论可读"（fail-closed），也不发一个不合契约的 `Moderation`。
  const issues = collectResultValueIssues('moderation', candidate);
  return issues.length === 0 ? candidate : null;
}

/** 由合流结论抽取闸门载体（只留摘要/计数/闭集码，不含原文）。 */
export function gateHolderFrom(args: {
  target_ref: TargetRef;
  decision: AuditState;
  reason_codes: string[];
  hard_rule_passed: boolean;
  rule_version: string | null;
  model_version: string | null;
  prompt_version: string | null;
  merged: MergedModeration | null;
}): GateHolder {
  const modelLayer = args.merged === null ? null : args.merged.model_layer;
  const kinds: Record<string, GateKindEntry> = {};
  if (modelLayer !== null) {
    for (const kind of ['tms', 'ims'] as const) {
      const entry = modelLayer.kinds?.[kind];
      if (entry === undefined) continue;
      kinds[kind] = {
        kind,
        status: entry.status,
        label: entry.label,
        reason_codes: [...entry.reason_codes],
        reported: entry.reported,
        synthetic: entry.synthetic === true,
      };
    }
  }
  const binding = args.merged === null ? null : args.merged.input_binding;
  return {
    target_ref: args.target_ref,
    decision: args.decision,
    reason_codes: [...args.reason_codes],
    hard_rule_passed: args.hard_rule_passed,
    rule_version: args.rule_version,
    model_version: args.model_version,
    prompt_version: args.prompt_version,
    input_binding:
      binding === null
        ? null
        : {
            schema: binding.schema,
            digest: binding.digest,
            media_count: binding.media_count,
            text_length: binding.text_length,
            verified: binding.verified === true,
          },
    model_layer:
      modelLayer === null
        ? null
        : {
            status: modelLayer.status,
            kinds,
            reason_codes: [...modelLayer.reason_codes],
            synthetic_ports: [...modelLayer.synthetic_ports],
          },
  };
}

/** 台账（内存实现；PG 迁移不属本片）。 */
export interface ModerationLedger {
  /** 建立新任务；同 `(target,revision,content_kind)` 已有当前任务时把它标记为 superseded。 */
  create(record: ModerationTaskRecord): ModerationTaskRecord;
  /** 按 `job_id` 更新（状态推进/回调落定）；不存在 ⇒ 抛错（调用方必须先 `create`）。 */
  update(record: ModerationTaskRecord): ModerationTaskRecord;
  byJobId(jobId: string): ModerationTaskRecord | null;
  /** 某目标某 revision 下的**当前**任务（未被 superseded）。 */
  current(target: TargetRef, kind: ContentKind): ModerationTaskRecord | null;
  /** 某目标某 revision 的当前任务列表（顺序固定：文本在前、图片在后）。 */
  forRevision(target: TargetRef): ModerationTaskRecord[];
  /** 某目标**全部**任务（含历史与 superseded），供审计。 */
  history(target: TargetRef): ModerationTaskRecord[];
  /** 下架标记：下架过的 `(target,revision)` 不得被旧回调复活。 */
  markWithdrawn(target: TargetRef): void;
  isWithdrawn(target: TargetRef): boolean;
  snapshotCounts(): { tasks: number; current: number; superseded: number; withdrawn: number };
}

export function createModerationLedger(): ModerationLedger {
  const current = new Map<string, ModerationTaskRecord>();
  const byJob = new Map<string, ModerationTaskRecord>();
  const all: ModerationTaskRecord[] = [];
  const withdrawn = new Set<string>();

  return {
    create(record) {
      if (byJob.has(record.job_id)) throw new Error(`审核任务 job_id 重复：${record.job_id}`);
      const key = taskKey(record.target_ref, record.content_kind);
      const previous = current.get(key);
      if (previous !== undefined) {
        const superseded = { ...previous, superseded: true };
        byJob.set(previous.job_id, superseded);
        const index = all.findIndex((item) => item.job_id === previous.job_id);
        if (index >= 0) all[index] = superseded;
      }
      const stored = { ...record, superseded: false };
      current.set(key, stored);
      byJob.set(stored.job_id, stored);
      all.push(stored);
      return stored;
    },
    update(record) {
      if (!byJob.has(record.job_id)) throw new Error(`审核任务不存在，无法更新：${record.job_id}`);
      byJob.set(record.job_id, record);
      const index = all.findIndex((item) => item.job_id === record.job_id);
      if (index >= 0) all[index] = record;
      const key = taskKey(record.target_ref, record.content_kind);
      if (current.get(key)?.job_id === record.job_id) current.set(key, record);
      return record;
    },
    byJobId(jobId) {
      return byJob.get(jobId) ?? null;
    },
    current(target, kind) {
      const record = current.get(taskKey(target, kind));
      return record === undefined || record.superseded ? null : record;
    },
    forRevision(target) {
      const records: ModerationTaskRecord[] = [];
      for (const kind of CONTENT_KINDS) {
        const record = current.get(taskKey(target, kind));
        if (record !== undefined && !record.superseded) records.push(record);
      }
      return records;
    },
    history(target) {
      return all.filter(
        (record) =>
          record.target_ref.type === target.type &&
          record.target_ref.id === target.id &&
          record.target_ref.revision === target.revision,
      );
    },
    markWithdrawn(target) {
      withdrawn.add(targetKey(target));
    },
    isWithdrawn(target) {
      return withdrawn.has(targetKey(target));
    },
    snapshotCounts() {
      return {
        tasks: all.length,
        current: [...current.values()].filter((record) => !record.superseded).length,
        superseded: all.filter((record) => record.superseded).length,
        withdrawn: withdrawn.size,
      };
    },
  };
}

/** 台账记录 → 读面投影（不含租约、不含闸门载体内部的非必要字段）。 */
export function taskView(record: ModerationTaskRecord): ModerationTaskView {
  return {
    job_id: record.job_id,
    job_revision: record.job_revision,
    target_ref: record.target_ref,
    content_kind: record.content_kind,
    port_kind: record.port_kind,
    prompt_id: record.prompt_id,
    state: record.state,
    decision: record.decision,
    reason_codes: [...record.reason_codes],
    hard_rule_passed: record.hard_rule_passed,
    rule_version: record.rule_version,
    model_version: record.model_version,
    prompt_version: record.prompt_version,
    error_code: record.error_code,
    contract_value: record.contract_value === null ? null : { ...record.contract_value },
    evidence: {
      ...record.evidence,
      reasons: [...record.evidence.reasons],
      rule_reason_codes: [...record.evidence.rule_reason_codes],
      model_reason_codes: [...record.evidence.model_reason_codes],
      model_kinds: record.evidence.model_kinds.map((entry) => ({ ...entry, reason_codes: [...entry.reason_codes] })),
      checked_media_refs: [...record.evidence.checked_media_refs],
    },
    created_at: record.created_at,
    updated_at: record.updated_at,
    submitted_by: record.submitted_by,
    deadline_at: record.deadline_at,
    superseded: record.superseded,
  };
}

/** 该内容类别对应的 prompt 模板 id（唯一映射，不允许同一类别换模板而不换版本）。 */
export function promptIdForContentKind(kind: ContentKind): string {
  return PROMPT_ID_BY_CONTENT_KIND[kind];
}

/** 空证据载体（给"模型层未求值"的任务用；不填任何占位版本串）。 */
export function emptyEvidence(args: {
  execution_mode: TaskEvidence['execution_mode'];
  port_kind: 'tms' | 'ims';
  prompt_id: string;
  text_length: number | null;
  media_count: number;
  checked_media_refs: string[];
}): TaskEvidence {
  return {
    execution_mode: args.execution_mode,
    provider: null,
    model_template: args.prompt_id,
    input_binding_digest: null,
    input_binding_verified: false,
    text_length: args.text_length,
    media_count: args.media_count,
    checked_media_refs: args.checked_media_refs,
    rule_reason_codes: [],
    model_reason_codes: [],
    model_kinds: [],
    reasons: [],
    rule_counts: null,
  };
}
