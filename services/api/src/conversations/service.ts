/**
 * GY-I12（#12）· 文字问答子域服务层（契约 operation 的语义唯一实现）。
 *
 * 覆盖契约里**全部七个**问答 operation（`packages/contracts/operations.json` 逐字）：
 *   `createConversation` / `listConversations` / `getConversation` / `deleteConversation` /
 *   `createTurn` / `listTurns` / `deleteTurn`。
 * 本文件不新增契约外 path、不新增响应键（投影一律走 `./view.ts`，键集与契约逐键相等）。
 *
 * 沿用仓库既有约定（**不自造第二套**）：
 *   - 强 ETag 口径与 `history/service.ts` 逐字一致：`strongEtagOf(revision)` = `"<revision>"`；
 *   - 幂等键域口径与 `auth/idempotency.ts` 一致：`<主体>\n<METHOD>\n<路由路径>`，请求摘要 =
 *     HMAC(服务端密钥, [请求体, If-Match])，**同键异体 ⇒ 409 IDEMPOTENCY_CONFLICT**，
 *     占位中重放 ⇒ 有界等待后 409 `REQUEST_IN_PROGRESS`（retryable）；
 *   - 游标签名口径沿用资料读面（HMAC 签名 base64url，任何解析失败统一 `INVALID_CURSOR`）；
 *   - 越权与不存在**逐字节同形**（都 `NOT_FOUND`），不泄露存在性；
 *   - 版本不符 ⇒ 409 `REVISION_CONFLICT`；缺 If-Match ⇒ 428 `REVISION_REQUIRED`。
 *
 * 诚实标注（红线②）：`Answer.model_version` / `prompt_version` / `rule_version` 一律带
 * `UNIMPLEMENTED_VERSION_PREFIX`（`unimplemented:no-real-`）前缀 —— 本片**没有**接任何真实
 * 模型，回答正文只由「本次检索集合 + 确定性守卫」产出。替身结果**永远**带这个机器可判据的
 * 标记，不可能被读成真实模型结果；也**不**把任何未接线能力记为真实成功。
 *
 * 异步受理：`createTurn` 返回 202 + `Job(state='queued')`，随后在同一进程内推进
 * `queued → running → 终态`（沿用 `recognitions/service.ts` 的 `inFlight` 模式）。
 * 任何异常**绝不**落 `succeeded`：超时 ⇒ `timed_out`，其余 ⇒ `failed`（附契约错误码）。
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { API_PREFIX } from '../contract.ts';
import { ApiError } from '../errors.ts';
import { isErrorCode, type ErrorCode } from '../contract.ts';
import type { ContractJob, JobState } from '../jobs/registry.ts';
import { collectShapeIssues } from '../jobs/result-shape.ts';
import { idempotencyScope } from '../auth/idempotency.ts';
import type { AuthenticatedIdentity } from '../auth/types.ts';
import { createAnswerGuard, type AnswerGuard, type DoseAuthority, type DoseCardCandidate, type RetrievalPort } from './guard.ts';
import { createUnwiredTurnCascadePort, type CascadeDisclosure, type TurnCascadePort } from './cascade.ts';
import {
  CONTEXT_MAX_TURNS,
  createStoreConversationContext,
  type ContextTurn,
  type ConversationContextPort,
} from './context.ts';
import {
  UNIMPLEMENTED_VERSION_PREFIX,
  type AnswerRecord,
  type AnswerStatus,
  type AnswerView,
  type CheckState,
  type Conditions,
  type ConversationActor,
  type ConversationRecord,
  type ConversationView,
  type DoseCard,
  type SourceRef,
  type TurnInput,
  type TurnRecord,
  type TurnView,
} from './types.ts';
import { createModerationRiskScreen, RISK_BLOCK_TEXT, type RiskScreen } from './screen.ts';
import { parseListQuery, validateConversationInput, validateTurnInput } from './validate.ts';
import { answerViewOf, conversationViewOf, turnViewOf } from './view.ts';
import type { AnswerInsert, ConversationStore, ListPosition, TurnInsert } from './store.ts';

/** 与历史域同口径的强 ETag（契约 `deleteConversation`/`createTurn` 的 If-Match 就是它）。 */
export function strongEtagOf(revision: number): string {
  return `"${revision}"`;
}

/** 受理后作业的默认期限（毫秒）。超期未结算的轮次会被如实标成 `timed_out`，不谎称成功。 */
export const DEFAULT_JOB_DEADLINE_MS = 30 * 1000;
export const IDEMPOTENCY_KEY_MIN = 8;
export const IDEMPOTENCY_KEY_MAX = 128;
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const IDEMPOTENCY_WAIT_MS = 2000;
const IDEMPOTENCY_POLL_MS = 2;
const CURSOR_TTL_MS = 15 * 60 * 1000;
const CURSOR_VERSION = 1;
/** 列表多取一条以判定是否还有下一页（不把"是否有更多"猜成 true）。 */
const PROBE_EXTRA = 1;

/**
 * 「未接真实模型」的回答版本串（**机器可判据**：`^unimplemented:no-real-`）。
 * 三个串都必须在契约 `minLength 1 / maxLength 80` 之内（回归用例逐条断言）。
 */
export const ANSWER_MODEL_VERSION = `${UNIMPLEMENTED_VERSION_PREFIX}model/text-qa-deterministic`;
export const ANSWER_PROMPT_VERSION = `${UNIMPLEMENTED_VERSION_PREFIX}prompt/citation-guard-only`;

/**
 * 服务端生成回答时的确定性规则版本（`Answer.rule_version` 的来源；同样带未实现前缀）。
 * 串里同时写明**引用守卫规则**与**相关度规则**，让"这条回答是怎么来的"可被机器读出。
 * 长度必须留在契约 `maxLength 80` 之内（回归用例断言 `<= 80`）。
 */
export function answerRuleVersion(doseRuleVersion: string): string {
  return `${UNIMPLEMENTED_VERSION_PREFIX}rule/${RELEVANCE_RULE}+dose/${doseRuleVersion}`;
}

/** 从用量权威端口取规则版本；拿不到就**如实说拿不到**，不填默认值冒充。 */
export function doseRuleVersionOf(dose: DoseAuthority): string {
  const value = dose.ruleVersion;
  return typeof value === 'string' && value.length > 0 ? value : `${dose.kind}:no-rule-version`;
}

/** 幂等台账的结果引用（**只存引用**，不存正文、不存凭据 —— 重放时重读当前状态）。 */
export type ConversationOutcome =
  | { resource: 'conversation'; conversation_id: string }
  | { resource: 'turn'; conversation_id: string; turn_id: string };

/** 台账里的占位行（`outcome === null` 表示「同键请求正在 produce」）。 */
interface LedgerEntry {
  requestHash: string;
  responseStatus: number;
  outcome: ConversationOutcome | null;
  expiresAt: Date;
}

/**
 * 幂等台账（本域自带一套，**不**改动 `auth/idempotency.ts` 的凭据类结果联合 —— 那张表的
 * `outcome` 形状被 `tests/unit/auth-store-pg.test.mjs` 逐字锁住，本片不得放宽既有断言）。
 * 复用其**口径**（scope/key_hash/request_hash），只换存放处。
 */
export interface ConversationIdempotencyLedger {
  readonly persistent: boolean;
  /** 读取**已完成**的台账记录；占位中（`outcome === null`）与不存在都返回 `null`。 */
  find(scope: string, keyHashHex: string): Promise<LedgerEntry | null>;
  /** 原子占位：仅当 scope+key 不存在（或已到期）时插入占位行。 */
  claim(scope: string, keyHashHex: string, input: { requestHash: string; responseStatus: number; expiresAt: Date }): Promise<boolean>;
  /** 占位者写入最终结果；仅当该行仍是未完成占位时成功。 */
  complete(scope: string, keyHashHex: string, entry: LedgerEntry): Promise<boolean>;
  /** 放弃占位（produce 失败）；只删除未完成的占位行。 */
  release(scope: string, keyHashHex: string): Promise<void>;
}

export function createMemoryConversationIdempotencyLedger(): ConversationIdempotencyLedger {
  const rows = new Map<string, LedgerEntry>();
  const composite = (scope: string, keyHashHex: string): string => `${scope}\u0000${keyHashHex}`;
  return {
    persistent: false,
    async find(scope, keyHashHex) {
      const entry = rows.get(composite(scope, keyHashHex));
      if (entry === undefined || entry.outcome === null) return null;
      return { ...entry, expiresAt: new Date(entry.expiresAt) };
    },
    async claim(scope, keyHashHex, input) {
      const key = composite(scope, keyHashHex);
      const existing = rows.get(key);
      // 过期条目仍占用键：先清掉同键过期行，再插入占位（与 `auth/idempotency.ts` 的 PG 口径一致）。
      if (existing !== undefined && existing.expiresAt.getTime() > Date.now()) return false;
      rows.set(key, { ...input, outcome: null, expiresAt: new Date(input.expiresAt) });
      return true;
    },
    async complete(scope, keyHashHex, entry) {
      const key = composite(scope, keyHashHex);
      const existing = rows.get(key);
      if (existing === undefined || existing.outcome !== null) return false;
      rows.set(key, { ...entry, expiresAt: new Date(entry.expiresAt) });
      return true;
    },
    async release(scope, keyHashHex) {
      const key = composite(scope, keyHashHex);
      const existing = rows.get(key);
      if (existing !== undefined && existing.outcome === null) rows.delete(key);
    },
  };
}

/** 生成侧产出的候选（守卫是唯一能把它降级/阻断的地方）。 */
export interface ComposedCandidate {
  text: string;
  citations: readonly SourceRef[];
  dose_cards: readonly DoseCardCandidate[];
}

/** 回答生成端口。本片**只有确定性实现**：正文由守卫结论决定，没有语言模型。 */
export interface AnswerComposer {
  readonly kind: 'deterministic_guard_only';
  readonly note: string;
  compose(input: {
    question: string;
    conditions: Conditions | null;
    set: RetrievalSetLike;
    /**
     * 同一会话内的**追问上下文**（时间正序；首轮为 `[]`）。只由 `./context.ts` 的端口提供
     * （同会话 + 同主体 + 有界 + 不含本轮）。回答器**只能**用它如实标注"这是追问"，
     * **不得**用它扩大引用集合 —— 引用仍只按本问取自本次检索集合。
     */
    history?: readonly ContextTurn[];
  }): ComposedCandidate;
}

type RetrievalSetLike = Awaited<ReturnType<RetrievalPort['read']>>;

/**
 * 问题的**确定性**分词（CJK 二元字组 + 拉丁/数字词），用于从检索集合里挑出相关条目。
 *
 * 为什么需要一个明确的规则：契约要求引用只能取自本次检索集合，但**没有**规定"哪些条目
 * 才与本问相关"。所以这里给出一个可复现、可审查、**不含模型**的规则，并把它写进正文与
 * `rule_version`，让判据落在明处：命中数 0 ⇒ 一条依据都没有 ⇒ 如实置「资料不足」，
 * **不**退回"随便拿集合里前几条"充数。
 */
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;
const WORD_RUN = /[a-z0-9]{2,}/g;
export const RELEVANCE_RULE = 'cjk-bigram+word-match/1';

export function relevanceShingles(text: string): Set<string> {
  const lower = text.toLocaleLowerCase('zh-CN');
  const shingles = new Set<string>();
  for (const run of lower.match(CJK_RUN) ?? []) {
    if (run.length === 1) shingles.add(run);
    for (let index = 0; index + 2 <= run.length; index += 1) shingles.add(run.slice(index, index + 2));
  }
  for (const word of lower.match(WORD_RUN) ?? []) shingles.add(word);
  return shingles;
}

/** 一条检索条目与本问的**确定性**相关度（命中多少个问题字组；0 即"没有依据"）。 */
export function relevanceScore(questionShingles: ReadonlySet<string>, item: { title: string; body: string }): number {
  if (questionShingles.size === 0) return 0;
  const haystack = `${item.title}\n${item.body}`.toLocaleLowerCase('zh-CN');
  let score = 0;
  for (const shingle of questionShingles) {
    if (haystack.includes(shingle)) score += 1;
  }
  return score;
}

/** 一条回答最多引用几条依据（契约 `citations.maxItems = 20`，这里只取最相关的少数条）。 */
export const COMPOSER_MAX_CITATIONS = 3;

/** 单条依据正文在回答里最多透出多少字符。超出**必须显式标注**为节选（不得静默返回半截文本）。 */
export const COMPOSER_EXCERPT_MAX = 400;

/** 依据正文摘录：不超上限逐字照搬；超出则截断并显式标注（④「不得静默返回半截文本当完整答案」）。 */
export function excerptOf(body: string): string {
  if (body.length <= COMPOSER_EXCERPT_MAX) return body;
  return `${body.slice(0, COMPOSER_EXCERPT_MAX)}…（正文节选，原文更长）`;
}

/**
 * 确定性回答器：**没有语言模型**。它只把「本次检索集合」里**确有字面重合**的条目
 * 标题与正文摘录拼成可核对的骨架，并把这些条目自带的来源对象作为候选引用（守卫会逐字段
 * 核对它们确实来自本次集合）。命中数为 0 ⇒ 空正文（守卫据此如实置 `insufficient`）。
 */
export function createDeterministicAnswerComposer(): AnswerComposer {
  return {
    kind: 'deterministic_guard_only',
    note: `确定性回答器（未接真实模型·${RELEVANCE_RULE}）：只罗列本次检索集合内确有字面重合的条目，不做生成/推断，用量一律不给`,
    compose({ question, set, history = [] }) {
      if (set === null || set.items.length === 0) return { text: '', citations: [], dose_cards: [] };
      const shingles = relevanceShingles(question);
      const ranked = set.items
        .map((item) => ({ item, score: relevanceScore(shingles, item) }))
        .filter((entry) => entry.score > 0)
        // 同分按 id 升序：结果确定，不受读面返回顺序影响。
        .sort((left, right) =>
          right.score - left.score || (left.item.id < right.item.id ? -1 : left.item.id > right.item.id ? 1 : 0),
        )
        .slice(0, COMPOSER_MAX_CITATIONS);
      if (ranked.length === 0) return { text: '', citations: [], dose_cards: [] };
      const lines = ranked.map(({ item, score }) => `[${score}] ${item.title}：${excerptOf(item.body)}`);
      // 追问可见性：有上文时**在正文首行**如实标注"这是本会话内的追问、上文有界"，
      // 同时明说引用范围没有因为上文而扩大 —— 不让人误以为上下文被拿去检索/扩了出处。
      // 轮次序号**不**由 `history.length` 反推：上下文有上限，超过上限的会话会让序号说谎。
      const followUp =
        history.length === 0
          ? ''
          : `（本会话追问：上文只取自本会话最近 ${history.length} 轮提问（上限 ${CONTEXT_MAX_TURNS} 轮），` +
            '不跨会话；引用仍只按本问取自本次检索集合）\n';
      return {
        // 正文自带「未接真实模型」字样：即便客户端只看正文，也不会把它读成模型输出。
        text:
          followUp +
          `（未接真实模型·确定性检索结果·规则 ${RELEVANCE_RULE}）依据本次资料检索集合中与提问有字面重合的条目：\n` +
          lines.join('\n'),
        citations: ranked.map(({ item }) => item.source),
        dose_cards: [],
      };
    },
  };
}

/** 语音轮次核对端口（`TurnInput.input_type === 'speech'`）。未接线 ⇒ 一律 503，不假装受理。 */
export interface TranscriptionVerdict {
  ok: boolean;
  code?: 'NOT_FOUND' | 'REVISION_CONFLICT' | 'INPUT_UNCERTAIN';
  text?: string;
  ref?: { type: string; id: string; revision: number };
}

export interface TranscriptionPort {
  readonly available: boolean;
  readonly note: string;
  confirm(input: { userId: string; transcriptionId: string; transcriptionRevision: number }): Promise<TranscriptionVerdict>;
}

export function createUnwiredTranscriptionPort(
  note = '语音转写核对尚未接线（属语音域）：本端口不接受语音轮次，如实 503 而不假装受理',
): TranscriptionPort {
  return {
    available: false,
    note,
    async confirm() {
      return { ok: false, code: 'INPUT_UNCERTAIN' };
    },
  };
}

/** 接语音域读面的适配器：只调用既有 `getTranscription`，**不**新建媒体/转写存储。 */
export function createTranscriptionPort(options: {
  getTranscription: (input: { userId: string; transcriptionId: string }) => Promise<{ revision: number; confirmed_text: string | null }>;
  note?: string;
}): TranscriptionPort {
  return {
    available: true,
    note: options.note ?? '语音转写核对已接线（复用语音域读面，不新建媒体存储）',
    async confirm({ userId, transcriptionId, transcriptionRevision }) {
      let row: { revision: number; confirmed_text: string | null };
      try {
        row = await options.getTranscription({ userId, transcriptionId });
      } catch (error) {
        if (error instanceof ApiError && error.code === 'NOT_FOUND') return { ok: false, code: 'NOT_FOUND' };
        throw error;
      }
      if (row.revision !== transcriptionRevision) return { ok: false, code: 'REVISION_CONFLICT' };
      // 契约要求「confirmed 转写」：未经用户核对的 raw 文本不得进入问答输入。
      if (row.confirmed_text === null || row.confirmed_text.length === 0) return { ok: false, code: 'INPUT_UNCERTAIN' };
      return { ok: true, text: row.confirmed_text, ref: { type: 'transcription', id: transcriptionId, revision: row.revision } };
    },
  };
}

/**
 * 受理一次轮次要带上的**完整**调用方会话（HTTP 层在受理时捕获，原样交给服务层）。
 *
 * 为什么不能只带 `ConversationActor`：回答阶段的检索集合必须走 `/knowledge` 的**同一读面**，
 * 而读面自己会做会话校验（需要 `sessionId`）与凭据校验（需要 Bearer 令牌）。所以会话身份与
 * 令牌在**受理时**捕获、随异步任务一起传下去 —— 异步阶段**不重新鉴权、也不跳过鉴权**。
 */
export interface ConversationSession {
  identity: AuthenticatedIdentity;
  token: string | null;
}

export interface ConversationServiceDeps {
  store: ConversationStore;
  retrieval: RetrievalPort;
  guard: AnswerGuard;
  composer: AnswerComposer;
  /**
   * 问题与资料原文的风险/注入筛查（缺省接 `packages/moderation` 的
   * `dangerous_usage` + `prompt_injection` 规则层；注入只供负控制，不改默认行为）。
   */
  riskScreen?: RiskScreen;
  /** 幂等台账（缺省为进程内实现；real 模式下装配层拒绝把内存存储交给服务层）。 */
  ledger?: ConversationIdempotencyLedger;
  transcription?: TranscriptionPort;
  cascade?: TurnCascadePort;
  /**
   * 追问上下文端口（缺省按本会话 store 自建 `createStoreConversationContext(store)`）。
   * 只影响**回答器的追问标注**，不影响检索集合与引用范围。
   */
  context?: ConversationContextPort;
  /** 游标签名密钥（与其它域同口径：`config.sessionSigningKey`）。 */
  signingKey: string;
  now?: () => Date;
  newId?: () => string;
  jobDeadlineMs?: number;
  idempotencyTtlMs?: number;
  idempotencyWaitMs?: number;
}

/** 一次 operation 的语义结果（HTTP 层只负责封套与状态码）。 */
export interface ServiceOutcome<T> {
  status: number;
  data: T;
  etag?: string;
  cascade?: CascadeDisclosure;
}

export interface ConversationPage {
  items: ConversationView[];
  next_cursor: string | null;
}

export interface TurnPageView {
  items: TurnView[];
  next_cursor: string | null;
}

function sameHash(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function parseOutcome(raw: unknown): ConversationOutcome {
  const record = raw as Record<string, unknown> | null;
  if (
    record !== null &&
    typeof record === 'object' &&
    record['resource'] === 'turn' &&
    typeof record['turn_id'] === 'string' &&
    typeof record['conversation_id'] === 'string'
  ) {
    return { resource: 'turn', conversation_id: record['conversation_id'], turn_id: record['turn_id'] };
  }
  if (
    record !== null &&
    typeof record === 'object' &&
    record['resource'] === 'conversation' &&
    typeof record['conversation_id'] === 'string'
  ) {
    return { resource: 'conversation', conversation_id: record['conversation_id'] };
  }
  // 台账/端口/契约形状不可信 ⇒ 确定性缺陷（重试不会改善）：retryable 必须为 false。口径见 services/api/src/errors.ts 的 ApiError 注释。
  throw new ApiError('PROVIDER_UNAVAILABLE', '幂等台账结果引用格式非法（拒绝据此产出回答）', { retryable: false });
}

/**
 * 回答的**契约形状闸门**（落库前最后一道）。
 *
 * 复用既有契约镜像 `jobs/result-shape.ts#collectShapeIssues`（**不自建第二套 schema**）：
 * `GET /jobs/{id}` 出站时也会用同一份镜像校验，因此这里先过一次，**不把**任何违反冻结契约的
 * 回答写进库、也不让它出现在 `Turn.answer` 里。判不过 ⇒ 抛 503，由受理任务如实落
 * `failed` + `PROVIDER_UNAVAILABLE`（绝不"先存下再想办法"）。
 */
function assertAnswerContract(view: AnswerView): void {
  const issues = collectShapeIssues('Answer', view, 'Answer');
  if (issues.length > 0) {
    throw new ApiError(
      'PROVIDER_UNAVAILABLE',
      `回答不满足契约 Answer 形状（拒绝落库与外发）：${issues.slice(0, 5).join('; ')}`,
      // 台账/端口/契约形状不可信 ⇒ 确定性缺陷（重试不会改善）：retryable 必须为 false。口径见 services/api/src/errors.ts 的 ApiError 注释。
      { retryable: false },
    );
  }
}

/** 终态错误码：只接受**契约闭集内**的错误码（`isErrorCode` 查 `states.json` 的映射表）；域外异常一律折为 `PROVIDER_UNAVAILABLE`。 */
function settleCodeOf(error: unknown): ErrorCode {
  if (error instanceof ApiError && isErrorCode(error.code)) return error.code;
  return 'PROVIDER_UNAVAILABLE';
}

export function createConversationService(deps: ConversationServiceDeps) {
  const store = deps.store;
  const retrieval = deps.retrieval;
  const guard = deps.guard;
  const composer = deps.composer;
  const riskScreen = deps.riskScreen ?? createModerationRiskScreen();
  const ledger = deps.ledger ?? createMemoryConversationIdempotencyLedger();
  const transcription = deps.transcription ?? createUnwiredTranscriptionPort();
  const cascade = deps.cascade ?? createUnwiredTurnCascadePort();
  // 追问上下文的缺省实现直接挂在本服务自己的 store 上：归属与会话过滤由 store 的 `listTurns`
  // 保证，服务层不另开一条读路径（少一条路径 = 少一个跨会话泄漏面）。
  const context = deps.context ?? createStoreConversationContext(store);
  const signingKey = deps.signingKey;
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => randomUUID());
  const jobDeadlineMs = deps.jobDeadlineMs ?? DEFAULT_JOB_DEADLINE_MS;
  const idempotencyTtlMs = deps.idempotencyTtlMs ?? IDEMPOTENCY_TTL_MS;
  const idempotencyWaitMs = deps.idempotencyWaitMs ?? IDEMPOTENCY_WAIT_MS;
  const inFlight = new Set<Promise<void>>();

  // -------------------------------------------------------------------------
  // 校验与错误映射（与 `./validate.ts` 同口径；此处只做服务层内的兜底复核）
  // -------------------------------------------------------------------------
  function notFound(): ApiError {
    return new ApiError('NOT_FOUND', '资源不存在');
  }

  function requireUser(actor: ConversationActor | null | undefined): ConversationActor {
    if (actor === null || actor === undefined) throw new ApiError('SESSION_REQUIRED', '需要用户会话');
    if (actor.role !== 'user') throw new ApiError('SCOPE_DENIED', '问答读写需要用户会话，后台会话不得代替');
    return actor;
  }

  function requireKey(value: unknown): string {
    if (typeof value !== 'string' || value.length < IDEMPOTENCY_KEY_MIN || value.length > IDEMPOTENCY_KEY_MAX) {
      throw new ApiError('IDEMPOTENCY_KEY_REQUIRED', `需要 ${IDEMPOTENCY_KEY_MIN}..${IDEMPOTENCY_KEY_MAX} 字符的 Idempotency-Key`);
    }
    return value;
  }

  function requireStrongEtag(value: unknown): { raw: string; revision: number } {
    if (value === undefined || value === null || value === '') {
      throw new ApiError('REVISION_REQUIRED', '缺少 If-Match（目标当前强 ETag）');
    }
    if (typeof value !== 'string' || !/^"[1-9][0-9]*"$/.test(value)) {
      throw new ApiError('INVALID_REQUEST', 'If-Match 必须是形如 "3" 的强 ETag，且不允许 *', {
        details: [{ field: 'If-Match', code: 'INVALID_ETAG' }],
      });
    }
    return { raw: value, revision: Number(value.slice(1, -1)) };
  }

  function mapCas(reason: 'NOT_FOUND' | 'OWNER_CHANGED' | 'REVISION_CHANGED'): ApiError {
    if (reason === 'REVISION_CHANGED') return new ApiError('REVISION_CONFLICT', 'If-Match 与当前版本不一致');
    // 他人资源与不存在同形：不泄露存在性。
    return notFound();
  }

  async function delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  // -------------------------------------------------------------------------
  // 幂等（键域/摘要口径与 auth 域一致；结果引用只存 id，重放时重读当前状态）
  // -------------------------------------------------------------------------
  function hashKey(scope: string, key: string): string {
    return createHmac('sha256', signingKey).update(`${scope}\n${key}`, 'utf8').digest('hex');
  }

  function hashRequest(body: unknown, ifMatch: string | undefined): string {
    return createHmac('sha256', signingKey).update(JSON.stringify([body ?? null, ifMatch ?? null]), 'utf8').digest('hex');
  }

  async function withIdempotency<T>(input: {
    actor: ConversationActor;
    method: string;
    routePath: string;
    key: string;
    body: unknown;
    ifMatchRef: string | undefined;
    status: number;
    produce: () => Promise<{ outcome: ConversationOutcome; data: T; etag?: string; cascade?: CascadeDisclosure }>;
    replay: (outcome: ConversationOutcome) => Promise<{ data: T; etag?: string; cascade?: CascadeDisclosure }>;
  }): Promise<ServiceOutcome<T>> {
    const scope = idempotencyScope(input.actor.userId, input.method, input.routePath);
    const keyHash = hashKey(scope, input.key);
    const requestHash = hashRequest(input.body, input.ifMatchRef);
    const expiresAt = new Date(now().getTime() + idempotencyTtlMs);

    const settled = await ledger.find(scope, keyHash);
    if (settled !== null) {
      if (!sameHash(settled.requestHash, requestHash)) {
        throw new ApiError('IDEMPOTENCY_CONFLICT', '同键请求内容不一致');
      }
      const replayed = await input.replay(parseOutcome(settled.outcome));
      return { status: settled.responseStatus, ...replayed };
    }

    const claimed = await ledger.claim(scope, keyHash, { requestHash, responseStatus: input.status, expiresAt });
    if (!claimed) {
      const deadline = now().getTime() + idempotencyWaitMs;
      for (;;) {
        await delay(IDEMPOTENCY_POLL_MS);
        const record = await ledger.find(scope, keyHash);
        if (record !== null) {
          if (!sameHash(record.requestHash, requestHash)) throw new ApiError('IDEMPOTENCY_CONFLICT', '同键请求内容不一致');
          const replayed = await input.replay(parseOutcome(record.outcome));
          return { status: record.responseStatus, ...replayed };
        }
        if (now().getTime() >= deadline) break;
      }
      throw new ApiError('REQUEST_IN_PROGRESS', '同键请求正在处理中，请稍后重试', { retryable: true });
    }

    try {
      const produced = await input.produce();
      await ledger.complete(scope, keyHash, {
        requestHash,
        responseStatus: input.status,
        outcome: produced.outcome,
        expiresAt,
      });
      return {
        status: input.status,
        data: produced.data,
        ...(produced.etag === undefined ? {} : { etag: produced.etag }),
        ...(produced.cascade === undefined ? {} : { cascade: produced.cascade }),
      };
    } catch (error) {
      // produce 失败 ⇒ 放弃占位（否则同键重试永远 REQUEST_IN_PROGRESS）。
      await ledger.release(scope, keyHash);
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // 游标（`created_at DESC, id DESC` 的 keyset；签名口径沿用资料读面）
  // -------------------------------------------------------------------------
  function invalidCursor(message = '游标无效或已失效'): ApiError {
    return new ApiError('INVALID_CURSOR', message);
  }

  function cursorFor(actor: ConversationActor, routePath: string, position: ListPosition): string {
    const payload = {
      v: CURSOR_VERSION,
      kind: 'keyset',
      user: actor.userId,
      auth_epoch: actor.authEpoch,
      route: routePath,
      sort: 'created_desc',
      after: { created_at: position.created_at.toISOString(), id: position.id },
      expires: now().getTime() + CURSOR_TTL_MS,
    };
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const signature = createHmac('sha256', signingKey).update(body, 'utf8').digest('base64url');
    return `${body}.${signature}`;
  }

  function decodeCursor(cursor: string, actor: ConversationActor, routePath: string): ListPosition {
    const parts = cursor.split('.');
    if (parts.length !== 2) throw invalidCursor();
    const body = parts[0] as string;
    const signature = parts[1] as string;
    const expected = createHmac('sha256', signingKey).update(body, 'utf8').digest('base64url');
    if (!sameHash(signature, expected)) throw invalidCursor();
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
    } catch {
      throw invalidCursor();
    }
    if (payload['v'] !== CURSOR_VERSION) throw invalidCursor();
    if (payload['user'] !== actor.userId || payload['auth_epoch'] !== actor.authEpoch) throw invalidCursor();
    if (payload['route'] !== routePath) throw invalidCursor();
    const expires = payload['expires'];
    if (!isPositiveInteger(expires) || expires <= now().getTime()) throw invalidCursor();
    const after = payload['after'] as Record<string, unknown> | undefined;
    const createdAt = after?.['created_at'];
    const id = after?.['id'];
    if (typeof createdAt !== 'string' || typeof id !== 'string') throw invalidCursor();
    const parsed = new Date(createdAt);
    if (Number.isNaN(parsed.getTime())) throw invalidCursor();
    return { created_at: parsed, id };
  }

  // -------------------------------------------------------------------------
  // 会话
  // -------------------------------------------------------------------------
  async function createConversation(
    actor: ConversationActor,
    body: unknown,
    headers: { idempotencyKey: unknown },
  ): Promise<ServiceOutcome<ConversationView>> {
    const identity = requireUser(actor);
    const key = requireKey(headers.idempotencyKey);
    const input = validateConversationInput(body);
    return withIdempotency<ConversationView>({
      actor: identity,
      method: 'POST',
      routePath: `${API_PREFIX}/conversations`,
      key,
      body,
      ifMatchRef: undefined,
      status: 201,
      produce: async () => {
        const at = now();
        const record: ConversationRecord = {
          id: newId(),
          revision: 1,
          owner_id: identity.userId,
          conditions: input.conditions,
          created_at: at,
          updated_at: at,
        };
        const stored = await store.insertConversation(record);
        return {
          outcome: { resource: 'conversation', conversation_id: stored.id },
          data: conversationViewOf(stored),
          // 契约 `createConversation` 的 201 声明了强 ETag：新资源 revision = 1，如实下发。
          etag: strongEtagOf(stored.revision),
        };
      },
      replay: async (outcome) => {
        if (outcome.resource !== 'conversation') throw new ApiError('IDEMPOTENCY_CONFLICT', '同键请求内容不一致（结果引用不是会话）');
        const stored = await store.getConversation(outcome.conversation_id, identity.userId);
        // 台账命中但资源已被删除：如实 503（**不**重放一个已经不存在的资源）。
        // 台账/端口/契约形状不可信 ⇒ 确定性缺陷（重试不会改善）：retryable 必须为 false。口径见 services/api/src/errors.ts 的 ApiError 注释。
        if (stored === null) throw new ApiError('PROVIDER_UNAVAILABLE', '幂等台账命中但会话已不存在', { retryable: false });
        return { data: conversationViewOf(stored), etag: strongEtagOf(stored.revision) };
      },
    });
  }

  async function listConversations(
    actor: ConversationActor,
    query: unknown,
  ): Promise<ServiceOutcome<ConversationPage>> {
    const identity = requireUser(actor);
    // 契约默认值（`limit` 缺省 20、`cursor` 可省略）由服务层自己兜底，不依赖 HTTP 层 schema：
    // 直接调用服务层的路径同样要拿到契约语义，否则"没给游标"会变成崩溃而不是第一页。
    const { cursor, limit } = parseListQuery(query);
    const routePath = `${API_PREFIX}/conversations`;
    const after = cursor === null ? null : decodeCursor(cursor, identity, routePath);
    const rows = await store.listConversations(identity.userId, { limit: limit + PROBE_EXTRA, after });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const next_cursor =
      rows.length > limit && last !== undefined
        ? cursorFor(identity, routePath, { created_at: last.created_at, id: last.id })
        : null;
    return { status: 200, data: { items: page.map(conversationViewOf), next_cursor } };
  }

  async function getConversation(actor: ConversationActor, conversationId: string): Promise<ServiceOutcome<ConversationView>> {
    const identity = requireUser(actor);
    const stored = await store.getConversation(conversationId, identity.userId);
    if (stored === null) throw notFound();
    return { status: 200, data: conversationViewOf(stored), etag: strongEtagOf(stored.revision) };
  }

  async function deleteConversation(
    actor: ConversationActor,
    conversationId: string,
    headers: { idempotencyKey: unknown; ifMatch: unknown },
  ): Promise<ServiceOutcome<{ accepted: boolean }>> {
    const identity = requireUser(actor);
    const key = requireKey(headers.idempotencyKey);
    const ifMatch = requireStrongEtag(headers.ifMatch);
    return withIdempotency<{ accepted: boolean }>({
      actor: identity,
      method: 'DELETE',
      routePath: `${API_PREFIX}/conversations/${conversationId}`,
      key,
      body: null,
      ifMatchRef: ifMatch.raw,
      status: 202,
      produce: async () => {
        // 契约 `deleteConversation`：删除会话即级联其下轮次与回答（PG 外键 / 内存显式级联）。
        const result = await store.deleteConversation(conversationId, identity.userId, ifMatch.revision);
        if (!result.ok) throw mapCas(result.reason);
        return { outcome: { resource: 'conversation', conversation_id: conversationId }, data: { accepted: true } };
      },
      // 同键重放**不**再报 409：首次已受理，重放如实回 accepted（与幂等语义一致）。
      replay: async () => ({ data: { accepted: true } }),
    });
  }

  // -------------------------------------------------------------------------
  // 轮次
  // -------------------------------------------------------------------------
  async function createTurn(
    session: ConversationSession,
    conversationId: string,
    body: unknown,
    headers: { idempotencyKey: unknown; ifMatch: unknown },
  ): Promise<ServiceOutcome<ContractJob>> {
    const identity = requireUser(session.identity);
    const key = requireKey(headers.idempotencyKey);
    const ifMatch = requireStrongEtag(headers.ifMatch);
    const input: TurnInput = validateTurnInput(body);

    // 语音输入先核写转写（契约：同 owner 与 transcription revision 核对）；
    // 未接线的转写端口一律 503 INPUT_UNCERTAIN —— 绝不把语音轮次假装受理成文字轮次。
    let speech: { text: string; ref: { type: string; id: string; revision: number } } | null = null;
    if (input.input_type === 'speech') {
      const verdict = await transcription.confirm({
        userId: identity.userId,
        transcriptionId: input.transcription_id,
        transcriptionRevision: input.transcription_revision,
      });
      if (!verdict.ok) {
        const code = verdict.code ?? 'INPUT_UNCERTAIN';
        if (code === 'NOT_FOUND') throw notFound();
        if (code === 'REVISION_CONFLICT') throw new ApiError('REVISION_CONFLICT', '转写版本与 If-Match 不一致');
        throw new ApiError('INPUT_UNCERTAIN', transcription.available ? '转写尚未经用户核对（confirmed_text 为空）' : transcription.note, {
          // 两条路都不是"稍后自己会好"：端口未接线 ⇒ 需运维接线；已接线但 confirmed_text 为空 ⇒ 需**用户先核对**。
          // 口径（services/api/src/errors.ts 的 ApiError 注释）：true 仅当同一请求在**无人工/运维介入**下稍后重试可能成功。
          retryable: false,
        });
      }
      if (verdict.text === undefined || verdict.ref === undefined) {
        // 台账/端口/契约形状不可信 ⇒ 确定性缺陷（重试不会改善）：retryable 必须为 false。口径见 services/api/src/errors.ts 的 ApiError 注释。
        throw new ApiError('PROVIDER_UNAVAILABLE', '转写端口回传不完整（拒绝受理）', { retryable: false });
      }
      speech = { text: verdict.text, ref: verdict.ref };
    }

    return withIdempotency<ContractJob>({
      actor: identity,
      method: 'POST',
      routePath: `${API_PREFIX}/conversations/${conversationId}/turns`,
      key,
      body,
      ifMatchRef: ifMatch.raw,
      status: 202,
      produce: async () => {
        const conversation = await store.getConversation(conversationId, identity.userId);
        if (conversation === null) throw notFound();
        if (conversation.revision !== ifMatch.revision) {
          throw new ApiError('REVISION_CONFLICT', 'If-Match 与当前会话版本不一致');
        }
        const at = now();
        const record: TurnInsert = {
          id: newId(),
          conversation_id: conversationId,
          owner_id: identity.userId,
          input_text: speech === null ? (input as { text: string }).text : speech.text,
          transcription_ref: speech === null ? null : speech.ref,
          job_id: newId(),
          job_state: 'queued',
          job_deadline_at: new Date(at.getTime() + jobDeadlineMs),
          job_created_at: at,
          job_error_code: null,
          created_at: at,
        };
        const stored = await store.insertTurn(record);
        scheduleAnswer(session, stored, conversation.conditions);
        return {
          outcome: { resource: 'turn', conversation_id: conversationId, turn_id: stored.id },
          data: jobViewOf(stored, null),
          // 契约 `createTurn` 的 202 声明了强 ETag：作业有 revision（受理时 = 1），如实下发。
          etag: strongEtagOf(stored.revision),
        };
      },
      replay: async (outcome) => {
        if (outcome.resource !== 'turn') throw new ApiError('IDEMPOTENCY_CONFLICT', '同键请求内容不一致（结果引用不是轮次）');
        const found = await store.getTurn(conversationId, outcome.turn_id, identity.userId);
        // 台账/端口/契约形状不可信 ⇒ 确定性缺陷（重试不会改善）：retryable 必须为 false。口径见 services/api/src/errors.ts 的 ApiError 注释。
        if (found === null) throw new ApiError('PROVIDER_UNAVAILABLE', '幂等台账命中但轮次已不存在', { retryable: false });
        return { data: jobViewOf(found.turn, found.answer), etag: strongEtagOf(found.turn.revision) };
      },
    });
  }

  async function listTurns(
    actor: ConversationActor,
    conversationId: string,
    query: unknown,
  ): Promise<ServiceOutcome<TurnPageView>> {
    const identity = requireUser(actor);
    const { cursor, limit } = parseListQuery(query);
    const conversation = await store.getConversation(conversationId, identity.userId);
    if (conversation === null) throw notFound();
    const routePath = `${API_PREFIX}/conversations/${conversationId}/turns`;
    const after = cursor === null ? null : decodeCursor(cursor, identity, routePath);
    const rows = await store.listTurns(conversationId, identity.userId, { limit: limit + PROBE_EXTRA, after });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const next_cursor =
      rows.length > limit && last !== undefined
        ? cursorFor(identity, routePath, { created_at: last.turn.created_at, id: last.turn.id })
        : null;
    return { status: 200, data: { items: page.map((row) => turnViewOf(row.turn, row.answer)), next_cursor } };
  }

  async function deleteTurn(
    actor: ConversationActor,
    conversationId: string,
    turnId: string,
    headers: { idempotencyKey: unknown; ifMatch: unknown },
  ): Promise<ServiceOutcome<{ accepted: boolean }>> {
    const identity = requireUser(actor);
    const key = requireKey(headers.idempotencyKey);
    const ifMatch = requireStrongEtag(headers.ifMatch);
    return withIdempotency<{ accepted: boolean }>({
      actor: identity,
      method: 'DELETE',
      routePath: `${API_PREFIX}/conversations/${conversationId}/turns/${turnId}`,
      key,
      body: null,
      ifMatchRef: ifMatch.raw,
      status: 202,
      produce: async () => {
        const result = await store.deleteTurn(conversationId, turnId, identity.userId, ifMatch.revision);
        if (!result.ok) throw mapCas(result.reason);
        // 级联处置：失败**不**回滚已完成的删除，只如实披露（响应头 X-GY-Cascade）。
        let disclosure: CascadeDisclosure = 'unwired';
        try {
          const outcome = await cascade.initiate({
            userId: identity.userId,
            conversationId,
            turnId,
            transcriptionRef: result.record.transcription_ref,
            answerId: result.record.answer_id,
          });
          disclosure = outcome.disposition;
        } catch {
          disclosure = 'failed';
        }
        return {
          outcome: { resource: 'turn', conversation_id: conversationId, turn_id: turnId },
          data: { accepted: true },
          cascade: disclosure,
        };
      },
      replay: async () => ({ data: { accepted: true } }),
    });
  }

  // -------------------------------------------------------------------------
  // 作业读面（`GET /jobs/{id}` 的 `answer` 源；供跨 kind 注册表复用）
  // -------------------------------------------------------------------------
  async function findByJobId(input: {
    userId: string;
    jobId: string;
  }): Promise<{ turn: TurnRecord; answer: AnswerRecord | null } | null> {
    return store.findTurnByJobId(input.jobId, input.userId);
  }

  /**
   * 轮次的作业快照 → 契约 `Job`（九键）。
   * 如实性硬边界（与 `jobs/registry.ts` 的 `assertContractJob` 同口径）：
   * `result` **只在** `state ∈ {succeeded, uncertain}` 且回答行确实存在时给出；
   * 其余状态一律 `null` —— 即便回答行还在（删除竞态），也绝不把"有回答"报成"作业成功"。
   */
  function jobViewOf(turn: TurnRecord, answer: AnswerRecord | null): ContractJob {
    const withResult = answer !== null && (turn.job_state === 'succeeded' || turn.job_state === 'uncertain');
    return {
      id: turn.job_id,
      revision: turn.revision,
      kind: 'answer',
      target_ref: { type: 'answer', id: turn.id, revision: turn.revision },
      state: turn.job_state,
      deadline_at: turn.job_deadline_at.toISOString(),
      created_at: turn.job_created_at.toISOString(),
      error_code: turn.job_error_code as ContractJob['error_code'],
      result: withResult && answer !== null ? { kind: 'answer', value: answerViewOf(answer) } : null,
    };
  }

  // -------------------------------------------------------------------------
  // 受理后的确定性回答（**没有真实模型**）
  // -------------------------------------------------------------------------

  /**
   * 回答行（`AnswerInsert`）的**唯一**构造点：正文/状态一律来自守卫或筛查结论，
   * 本函数不做任何判定；三个版本串**全部**带 `unimplemented:no-real-` 前缀（红线②，机器可判据）。
   */
  function answerRowOf(
    target: { turnId: string; ownerId: string },
    verdict: {
      status: AnswerStatus;
      check_state: CheckState;
      checked_text: string;
      citations: readonly SourceRef[];
      dose_cards: readonly DoseCard[];
    },
  ): AnswerInsert {
    return {
      id: newId(),
      turn_id: target.turnId,
      owner_id: target.ownerId,
      status: verdict.status,
      checked_text: verdict.checked_text,
      check_state: verdict.check_state,
      citations: [...verdict.citations],
      dose_cards: [...verdict.dose_cards],
      // 红线②：三个版本串**全部**带 `unimplemented:no-real-` 前缀（机器可判据）。
      model_version: ANSWER_MODEL_VERSION,
      prompt_version: ANSWER_PROMPT_VERSION,
      rule_version: answerRuleVersion(doseRuleVersionOf(guard.dose)),
      created_at: now(),
    };
  }

  function scheduleAnswer(session: ConversationSession, turn: TurnRecord, conditions: Conditions | null): void {
    const actor = session.identity;
    const task = (async () => {
      const claimed = await store.claimTurnJob(turn.id, actor.userId);
      // 重复/并发受理：状态机已拒绝（不是 queued），**不**改写已发生的状态。
      if (claimed === null) return;
      if (now().getTime() > claimed.job_deadline_at.getTime()) {
        await store.settleTurnJob({
          turnId: claimed.id,
          ownerId: actor.userId,
          state: 'timed_out',
          errorCode: 'PROVIDER_TIMEOUT',
          answer: null,
          at: now(),
        });
        return;
      }
      try {
        // 成功结算的**唯一**出口（契约形状闸门 + 结算）：筛查阻断与守卫结论两条路径共用。
        const settleAnswer = async (answer: AnswerInsert): Promise<void> => {
          // 契约形状闸门：过不了就**不落库**，由 catch 如实落 failed。
          assertAnswerContract(
            answerViewOf({
              ...answer,
              revision: 1,
              citations: [...answer.citations],
              dose_cards: [...answer.dose_cards],
              updated_at: answer.created_at,
            }),
          );
          await store.settleTurnJob({
            turnId: claimed.id,
            ownerId: actor.userId,
            state: 'succeeded',
            errorCode: null,
            answer,
            at: now(),
          });
        };

        // ---- 风险/注入筛查（问题侧）：**在检索、生成与守卫之前** ----
        // 命中或无法判定 ⇒ 整轮拒答：不检索资料、不调用回答器、不进守卫，也不产出任何
        // 结论/用量；只落一行固定话术的阻断回答（不含命中原文）。
        const questionScreen = riskScreen.screenQuestion({ turnId: claimed.id, text: claimed.input_text });
        if (questionScreen.blocked) {
          await settleAnswer(
            answerRowOf(
              { turnId: claimed.id, ownerId: actor.userId },
              {
                status: 'blocked',
                // 与守卫的「资料不足」（`insufficient`/`passed`）在响应里可区分：
                // 这里是**筛查阻断**（`blocked`/`blocked` + 固定话术）。
                check_state: 'blocked',
                checked_text: RISK_BLOCK_TEXT,
                citations: [],
                dose_cards: [],
              },
            ),
          );
          return;
        }

        // 检索集合：与 `/knowledge` **同一读面、同一会话校验**（凭据在受理时捕获），
        // 并按本会话条件收窄。
        const set = await retrieval.read({
          identity: actor,
          question: claimed.input_text,
          token: session.token,
          conditions: conditions === null ? null : { ...conditions },
        });
        // ---- 风险/注入筛查（来源侧）：污染条目从**本次检索集合**剔除 ----
        // 剔除发生在生成与守卫之前：被剔除的条目既不可能成为引用，也不可能成为用量卡来源。
        // 剔除后若集合为空 ⇒ 生成侧给空正文、守卫按既有「资料不足」路径如实置
        // `insufficient`/`passed`（不编造依据、不把"没有可用来源"说成"没有问题"）。
        const screenedSources = riskScreen.screenSources({
          turnId: claimed.id,
          items: set === null ? [] : set.items,
        });
        const safeSet = set === null ? null : { ...set, items: screenedSources.items };
        // ---- 追问上下文（只取自本会话、本主体、有界、不含本轮）----
        // 读失败**不**降级成"没有上文"：那会把一次追问悄悄说成首轮提问（如实性红线），
        // 因此这里让异常照常上抛 ⇒ 轮次落 `failed` 且可重试（④）。
        const priorContext = await context.read({
          conversationId: claimed.conversation_id,
          ownerId: actor.userId,
          excludeTurnId: claimed.id,
        });
        // 上下文**只**进回答器做追问标注，不进检索、不扩引用集合。
        const candidate = composer.compose({
          question: claimed.input_text,
          conditions,
          set: safeSet,
          history: priorContext.turns,
        });
        const verdict = guard.check({
          candidate,
          set: safeSet,
          question: claimed.input_text,
          conditions: conditions === null ? null : { ...conditions },
        });
        await settleAnswer(answerRowOf({ turnId: claimed.id, ownerId: actor.userId }, verdict));
      } catch (error) {
        // 任何异常**绝不**落 succeeded：超时 ⇒ timed_out，其余 ⇒ failed（附契约错误码）。
        const code = settleCodeOf(error);
        const state: JobState = code === 'PROVIDER_TIMEOUT' ? 'timed_out' : 'failed';
        await store.settleTurnJob({
          turnId: claimed.id,
          ownerId: actor.userId,
          state,
          errorCode: code,
          answer: null,
          at: now(),
        });
      }
    })();
    inFlight.add(task);
    void task.finally(() => {
      inFlight.delete(task);
    });
  }

  /** 等待所有在途受理任务结算（测试用：让 202 之后的异步推进可被确定性地观测）。 */
  async function drain(): Promise<void> {
    while (inFlight.size > 0) {
      await Promise.all([...inFlight]);
    }
  }

  return {
    store,
    ledger,
    retrieval,
    guard,
    composer,
    riskScreen,
    transcription,
    cascade,
    context,
    createConversation,
    listConversations,
    getConversation,
    deleteConversation,
    createTurn,
    listTurns,
    deleteTurn,
    findByJobId,
    jobViewOf,
    drain,
  };
}

export type ConversationService = ReturnType<typeof createConversationService>;

/** 装配层构造守卫的便捷入口（口径集中一处，避免各调用点各写一套）。 */
export function createConversationGuard(input: { dose: DoseAuthority }): AnswerGuard {
  return createAnswerGuard({ dose: input.dose });
}
