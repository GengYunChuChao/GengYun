/**
 * GY-I09 识别任务状态机与候选硬约束（只读消费冻结契约，不新增契约字段）。
 *
 * 契约来源：packages/contracts/openapi.json（1.0.0，已冻结）
 *   JobState    = queued | running | succeeded | uncertain | failed | timed_out | cancelled（共 7 类）
 *   Candidate   = { species_id(1..80), rank(1..3), model_score(0..1 | null) }，全部必填
 *   Recognition = { candidates maxItems=3, uncertainty_reasons maxItems=10, selected_species_id|null, model_version }
 *
 * 本文件承载「缺项 ≠ 可执行」的硬规则（监工 2026-10-11 对 #82 的 CHANGES_REQUESTED 口径）：
 * 任何必要条件未知（无候选 / 无分数 / 提供者自述不确定 / 提供者无响应 / 超时）**一律不得**
 * 落到 succeeded；必须落 uncertain / failed / timed_out，并如实写出 uncertainty_reasons 或 error_code。
 * 「只记原因、不改状态」在本模块是被禁止的写法。
 */

/** packages/contracts/openapi.json -> components.schemas.JobState.enum（逐项一致，不得扩展）。 */
export const JOB_STATES = [
  'queued',
  'running',
  'succeeded',
  'uncertain',
  'failed',
  'timed_out',
  'cancelled',
] as const;
export type JobState = (typeof JOB_STATES)[number];

/** 终态：到达后不得再迁移（旧回调不复活）。 */
export const TERMINAL_JOB_STATES = ['succeeded', 'uncertain', 'failed', 'timed_out', 'cancelled'] as const;

/** Candidate.rank 的契约上限，同时是 candidates 的 maxItems。 */
export const MAX_CANDIDATES = 3;
/** Recognition.uncertainty_reasons.maxItems。 */
export const MAX_UNCERTAINTY_REASONS = 10;
/** Recognition.uncertainty_reasons.items.maxLength。 */
export const MAX_REASON_LENGTH = 80;
/** Candidate.species_id.maxLength。 */
export const MAX_SPECIES_ID_LENGTH = 80;

/**
 * 实现层「可信」门槛（**不是契约字段**，契约没有阈值）。
 * 仅用于把「有分数但分数不可信」判成 uncertain；调整该值属于能力评估口径变化，
 * 须同步 #9 的评估证据，不得用它把无分数候选抬成 succeeded。
 */
export const MIN_TRUSTED_TOP_SCORE = 0.5;

export function isJobState(value: unknown): value is JobState {
  return typeof value === 'string' && (JOB_STATES as readonly string[]).includes(value);
}

export function isTerminalJobState(state: JobState): boolean {
  return (TERMINAL_JOB_STATES as readonly string[]).includes(state);
}

/**
 * 允许的状态迁移。终态不可离开；cancelled/timed_out 优先于任何迟到结果。
 * queued → failed/timed_out 覆盖「还没开始就超过截止时间」的情形。
 */
export function canTransitionJob(from: JobState, to: JobState): boolean {
  if (isTerminalJobState(from)) return false;
  if (from === 'queued') return to === 'running' || to === 'cancelled' || to === 'failed' || to === 'timed_out';
  if (from === 'running') return isTerminalJobState(to);
  return false;
}

/** 契约 Candidate 投影。 */
export interface Candidate {
  species_id: string;
  rank: number;
  model_score: number | null;
}

/** 提供者输出被拒的原因（fail-closed，不透出提供者原文）。 */
export class CandidateProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CandidateProtocolError';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 校验**单个**候选（先判 typeof 再判值，`undefined` 一律拒绝）。
 * 不使用类型断言后直接读取字段的写法，避免 undefined 被静默放过。
 */
export function validateCandidate(raw: unknown, index: number): Candidate {
  if (!isPlainObject(raw)) throw new CandidateProtocolError(`候选 ${index} 不是对象`);
  if ('species_id' in raw === false || 'rank' in raw === false || 'model_score' in raw === false) {
    throw new CandidateProtocolError(`候选 ${index} 缺少必填字段`);
  }
  const speciesId = raw['species_id'];
  const rank = raw['rank'];
  const score = raw['model_score'];
  if (typeof speciesId !== 'string' || speciesId.length < 1 || speciesId.length > MAX_SPECIES_ID_LENGTH) {
    throw new CandidateProtocolError(`候选 ${index} 的 species_id 非法`);
  }
  if (!Number.isInteger(rank) || (rank as number) < 1 || (rank as number) > MAX_CANDIDATES) {
    throw new CandidateProtocolError(`候选 ${index} 的 rank 非法`);
  }
  if (score !== null && (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1)) {
    throw new CandidateProtocolError(`候选 ${index} 的 model_score 非法`);
  }
  return { species_id: speciesId, rank: rank as number, model_score: score as number | null };
}

/**
 * 校验并归一化候选列表。**fail-closed**：超过 3 条、rank 重复或不连续、
 * 字段缺失一律抛错（由调用方映射为提供者协议违规），**绝不**截断/补造/去重后当成功。
 */
export function normalizeCandidates(raw: unknown): Candidate[] {
  if (!Array.isArray(raw)) throw new CandidateProtocolError('candidates 不是数组');
  if (raw.length > MAX_CANDIDATES) throw new CandidateProtocolError('候选超过契约上限 3 条');
  const list = raw.map((item, index) => validateCandidate(item, index));
  const ranks = list.map((item) => item.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i += 1) {
    if (ranks[i] !== i + 1) throw new CandidateProtocolError('候选 rank 必须唯一且从 1 连续编号');
  }
  // 候选少于 3 条是允许的：**不补造**。
  return list.sort((a, b) => a.rank - b.rank);
}

/** 归一化不确定原因：去空白、去空串、限长、限条数（超出即协议违规，fail-closed）。 */
export function normalizeReasons(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new CandidateProtocolError('uncertainty_reasons 不是数组');
  const list: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') throw new CandidateProtocolError('uncertainty_reasons 含非字符串项');
    const trimmed = item.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.length > MAX_REASON_LENGTH) throw new CandidateProtocolError('不确定原因超过 80 字符');
    list.push(trimmed);
  }
  if (list.length > MAX_UNCERTAINTY_REASONS) throw new CandidateProtocolError('不确定原因超过契约上限 10 条');
  return list;
}

/** 服务端在提供者没给出原因时补的**如实说明**（不是候选、不是分数）。 */
export const REASON_NO_CANDIDATES = '模型未返回任何候选';
export const REASON_MISSING_SCORE = '部分候选缺少模型分数';
export const REASON_LOW_SCORE = '最高候选分数低于可信门槛';

export interface Decision {
  state: 'succeeded' | 'uncertain';
  candidates: Candidate[];
  uncertaintyReasons: string[];
}

/**
 * 由「提供者候选 + 提供者原因」判定终态。规则（逐条即回归用例）：
 * 1. 候选为空 → uncertain（且至少一条原因）；
 * 2. 提供者自述任何 uncertainty_reasons → uncertain（fail-closed：模型自己说不确定就不算成功）；
 * 3. 任一候选 model_score 为 null → uncertain（**不得**在该情形下写分数）；
 * 4. Top1 分数低于实现层门槛 → uncertain；
 * 5. 仅当以上都不成立时才是 succeeded，且此时 uncertainty_reasons 必为空。
 */
export function decideOutcome(rawCandidates: unknown, rawReasons: unknown): Decision {
  const candidates = normalizeCandidates(rawCandidates);
  const providerReasons = normalizeReasons(rawReasons);

  if (candidates.length === 0) {
    return {
      state: 'uncertain',
      candidates: [],
      uncertaintyReasons: dedupeReasons(providerReasons.length > 0 ? providerReasons : [REASON_NO_CANDIDATES]),
    };
  }
  if (providerReasons.length > 0) {
    return { state: 'uncertain', candidates, uncertaintyReasons: dedupeReasons(providerReasons) };
  }
  if (candidates.some((item) => item.model_score === null)) {
    return { state: 'uncertain', candidates, uncertaintyReasons: [REASON_MISSING_SCORE] };
  }
  const top = candidates[0];
  if (top === undefined || top.model_score === null || top.model_score < MIN_TRUSTED_TOP_SCORE) {
    return { state: 'uncertain', candidates, uncertaintyReasons: [REASON_LOW_SCORE] };
  }
  return { state: 'succeeded', candidates, uncertaintyReasons: [] };
}

function dedupeReasons(reasons: string[]): string[] {
  const seen: string[] = [];
  for (const reason of reasons) {
    if (!seen.includes(reason)) seen.push(reason);
  }
  if (seen.length === 0) seen.push(REASON_NO_CANDIDATES);
  return seen.slice(0, MAX_UNCERTAINTY_REASONS);
}
