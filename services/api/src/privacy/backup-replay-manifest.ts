/**
 * GY-I19（#19）第 3 步 · **备份恢复重放清单** + 「恢复后不得复活」负例 —— 纯新增内部模块。
 *
 * ## 先讲清楚：既有协议已有能力，本片不另起一套
 * 只读核实（本片动过的既有文件：**零个**）：
 *   - `packages/privacy/deletion.mjs`（GY-I27 已合并）已有**逐阶段**备份能力的事实形状：
 *     handler 返回 `{ onlineState, backupState, evidenceRef, errorCode }`，`backupState` 与
 *     `onlineState` 各自独立、取值闭集 `HANDLER_STATES`；`completed` 必须带非空证据；
 *     第三方行有 `onlineStatus/backupStatus`（`requested/confirmed/failed/unsupported`，
 *     `requested` 绝不等于 `confirmed`）；`SAFE_ERROR_CODES` 是唯一可透出的失败码白名单。
 *   - `services/api/src/privacy/user-data-deletion.ts`（GY-I16 已合并）已声明
 *     **`BackupPurgePort` 端口**（`kind: 'wired'|'unwired'`、`available`、`purge()`），
 *     并给出 `createUnwiredBackupPurgePort()`：**未接线 ⇒ `backupState: 'pending'`，不谎称完成**。
 *   - `services/api/src/privacy/deletion-aging.ts`（本分支第 1 步）已有 7 日 / 30 日到期语义。
 *   - `docs/architecture/state-contract.md` §删除清单 已冻结运维协议：
 *     「删除清单先在独立受控追加存储落 durable tombstone（opaque object refs、delete generation、
 *     范围、期限、处理证据），worker ACK 前不丢任务……**备份不覆盖该清单**；每个备份有 lineage 和
 *     截至水位。恢复关闭入口与外发，加载**比快照新的清单**→删除身份/媒体/缓存并重播第三方待删→
 *     **验证无复活**→开流量，**失败保持隔离**」。
 *   因此本片**没有**新增状态机、**没有**改动 `packages/privacy/**` 与任何既有 `.ts` 一个字节，
 *   只做**清单投影 + 重放编排 + 无复活验证**（与第 2 步「投影不造状态机」同一手法）。
 *
 * ## 核实结论：真实空白是什么（不是重复造轮子）
 * 1. **`backupPurge` 只有端口、没有清单**：`BackupPurgePort` 只是一个 purge 函数口，
 *    「哪些删除必须重放、按什么顺序、幂等键是什么、每条要什么证据」**无处可查** ——
 *    这正是 state-contract 要求的「恢复重放清单」。本片把它补成可复用纯函数。
 * 2. **水位不足以判定「快照已覆盖」**：state-contract 说「加载比快照新的清单」，但**快照实际含有的
 *    对象**才是事实。若只按水位比较（`tombstone.recorded_at <= watermark` 就算覆盖），
 *    一份**含已删对象**的备份快照就会被判「无需重放」⇒ 恢复后**对象复活**。
 *    本片因此把「快照实际含该对象引用」也算作必须重放（见下面负例 ①）。
 * 3. **「不重放」没有任何可判别结论**：既有端口失败只表现为 `pending` 的备份态，无法区分
 *    「清单没做」「做了没证据」「第三方没确认」「快照还没到位」。本片为每条、每类给**必非空**
 *    `reason_code`（`restore_safe === true` 时才为 `null`）。
 * 4. **清单可能被裁剪**：漏重放最常见的成因不是"worker 懒"，而是**清单被裁剪/篡改**（少一条就少删一份）。
 *    本片给清单一个 `manifest_digest`（覆盖每条 `seq|replay_key|needed`），重放前**重新计算并比对**；
 *    不一致 ⇒ `REPLAY_MANIFEST_TAMPERED` fail-closed，**不进入重放**。
 *
 * ## 四条铁律（默认按「不得谎称恢复安全」设计）
 * 1. **恢复后不得复活**：重放完成后逐条回查对象是否仍可见/可用；任一仍可见 ⇒ `REPLAY_REVIVED`，
 *    `verified_no_revival: false`、`restore_safe: false`、`isolation_required: true`（保持隔离，不开流量）。
 * 2. **漏重放不得表现为成功**：任何未 `applied`/`duplicate` 的必重放条目 ⇒ `pending`/`failed` +
 *    可判别原因码；`restore_safe` 恒 false。**清单本身**的 `restore_safe` 也**恒为 false**
 *    （清单只是计划，没重放、没验证，就绝不能说安全）。
 * 3. **不得仅凭时钟判完成**：7 日 / 30 日是**期限上限**（`docs/product-requirements.md` B18
 *    「在线 7 日内删除、备份 30 日内滚动清理」），**不是必须保留满**，更不得把「未到期」反转成
 *    「必须等到期才认完成」。每条按 `requested_at` + 阶段判期限（闭区间；复用第 1 步
 *    `evaluateDeletionAging`，不另立时间口径），`window_due` **只作事实列示**；
 *    能否声称恢复安全看**完成证据**：必须重放的条目要拿到**本次重放的证据**，被快照覆盖的条目
 *    要有**清单里既成的完成证据**。都没有 ⇒ 仍在期限内报 `REPLAY_UNDUE_NO_EVIDENCE`、
 *    已逾期报 `REPLAY_OVERDUE_NOT_EXECUTED`；**期限内提前完成（有证据）必须如实判安全**，
 *    不得因为「未到期」把它隐去而延误开流量。
 * 4. **幂等**：`replay_key = sha256("gengyun/backup-replay/v1\\0" + object_ref + "\\0" + delete_generation)`
 *    —— 只由对象身份与删除代次决定（不含快照 id、不含时间），因此**跨快照、跨重放稳定**；
 *    重复重放同一键 ⇒ 目标端口须返回 `duplicate`（**不产生第二份事实**），本模块把它判为
 *    **明确成功**（`restore_safe` 可仍为 true，reason 为 `null`），**不给含糊结论**。
 *
 * ## fail-closed 清单（一律不返回条目、`restore_safe: false`、带可判别原因码）
 * 入参不可信（快照缺失 / 水位或时刻非法 / 时间线倒置）、tombstone 行形状不可信（非对象、空 object_ref、
 * 未定义的 scope、非法 `delete_generation`、状态不在 `HANDLER_STATES` 内）、越权（主体不匹配）、
 * 给了主体却无法核实归属 —— 全部拒绝；**不静默跳过坏行**（跳过坏行就是漏重放）。
 *
 * ## 边界（不实现 / 未取得项，如实披露）
 *   - `packages/contracts/**` **零改动**；契约里**没有**备份/恢复/重放的 operation
 *     （`openapi.json` 只有 `POST /me/account/deletion`、`GET /account/deletions/{id}`、
 *     `GET /me/privacy-policy`）⇒ **未自造任何路由/字段**，本文件是内部模块。
 *   - **不接任何真实备份系统、不接任何真实第三方**：`real` 未接真实依赖一律 fail-closed
 *     （端口 `available !== true` ⇒ `REPLAY_TARGET_UNAVAILABLE`；第三方端口未接线 ⇒
 *     `REPLAY_THIRD_PARTY_UNWIRED`）。测试里的「备份快照」与「目标存储」都是**替身**，
 *     在回传与证据页里明确标注为替身，不代表真实备份系统已演练。
 *   - 实际备份系统的 lineage / 水位落库、对象存储 purge 实现、真机与部署不在本片。
 *   - 清单条目只含 **opaque** 引用与哈希键，**不含**任何用户可识别信息
 *     （state-contract：「清单不可恢复出用户关联数据」）。
 */
import { createHash } from 'node:crypto';
import { HANDLER_STATES, THIRD_PARTY_STATES } from '../../../../packages/privacy/constants.mjs';
import { SAFE_ERROR_CODES } from '../../../../packages/privacy/deletion.mjs';
import { AGING_REASON_CODES, evaluateDeletionAging } from './deletion-aging.ts';

/** 清单格式版本（进 `manifest_digest`，格式变更即旧清单不可复用）。 */
export const REPLAY_MANIFEST_VERSION = 1;

/**
 * 重放范围**闭集**。来源：`docs/architecture/state-contract.md` §删除清单
 * （「对象handler区分用户身份/session/profile/媒体/问答/识别/收藏/消息/缓存/日志最小化、
 * 公开帖评去身份、对象存储衍生件、备份、供应商副本」）。
 * 闭集外的 scope **不得静默通过**（未知枚举按 fail-closed 处理）。
 */
export const REPLAY_SCOPES: readonly string[] = Object.freeze([
  'identity',
  'session',
  'profile',
  'public_post',
  'media',
  'object_derivative',
  'qa',
  'recognition',
  'favorite',
  'message',
  'cache',
  'log',
  'backup',
  'third_party',
]);

/**
 * 重放顺序权重（越小越先）。依据 state-contract：
 * 「删除身份/媒体/缓存并**重播第三方待删**」⇒ 本地删除先行，第三方重播最后。
 */
const SCOPE_ORDER: Readonly<Record<string, number>> = Object.freeze({
  identity: 0,
  session: 1,
  profile: 2,
  public_post: 3,
  media: 4,
  object_derivative: 5,
  qa: 6,
  recognition: 7,
  favorite: 8,
  message: 9,
  cache: 10,
  log: 11,
  backup: 12,
  third_party: 13,
});

/** 每条重放必须留下的证据种类（证据是「不得谎称完成」的锚点）。 */
const EVIDENCE_REQUIREMENTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  // 身份映射销毁：state-contract「账户可识别映射在在线期限内删除」。
  identity: Object.freeze(['replay_receipt', 'identity_mapping_destroyed']),
  // 公开帖评去身份：state-contract「公开作者改随机注销引用」。
  public_post: Object.freeze(['replay_receipt', 'author_deidentified']),
  // 第三方：state-contract「requested 绝不等于 confirmed」⇒ 必须有确认与证据索引。
  third_party: Object.freeze(['third_party_confirmation', 'evidence_ref']),
});
const DEFAULT_EVIDENCE_REQUIREMENTS: readonly string[] = Object.freeze(['replay_receipt']);

/** 删除阶段闭集（与 `onlineState` / `backupState` 一一对应；不重新定义）。 */
const PHASES: readonly string[] = Object.freeze(['online', 'backup']);
/** 默认阶段：备份恢复天然落在 30 日**备份**窗口上（更严的那一个）。 */
const DEFAULT_PHASE = 'backup';

/**
 * 本模块**内部**原因码（辨别「为什么不能声称恢复安全」）。
 * 说明：这些不是契约错误码，**不会**进入任何用户回执/HTTP 响应；既有协议白名单
 * （`SAFE_ERROR_CODES`）内的失败码会**原样**透出到 `recorded_error_code`。
 */
const REASON_CODE_VALUES = {
  /** 没有任何 tombstone ⇒ 无删除清单可证，**不得**用空集合声称安全（非真空真）。 */
  NONE: 'REPLAY_NONE',
  /** 入参或 tombstone 行形状不可信 ⇒ fail-closed。 */
  INPUT_INVALID: 'REPLAY_INPUT_INVALID',
  /** 给了主体但无法核实归属 ⇒ fail-closed（不替别人出清单）。 */
  OWNERSHIP_UNVERIFIED: 'REPLAY_OWNERSHIP_UNVERIFIED',
  /** 越权：调用方主体与请求绑定主体不一致 ⇒ 不返回任何条目。 */
  SUBJECT_MISMATCH: 'REPLAY_SUBJECT_MISMATCH',
  /** 清单被裁剪/篡改（digest 不符）⇒ 拒绝重放（这正是「漏重放」的根因）。 */
  MANIFEST_TAMPERED: 'REPLAY_MANIFEST_TAMPERED',
  /** 重放目标不可用/未接线（`real` 未接真实依赖）⇒ fail-closed。 */
  TARGET_UNAVAILABLE: 'REPLAY_TARGET_UNAVAILABLE',
  /** 第三方待删重播端口未接线 ⇒ fail-closed（零真实第三方调用）。 */
  THIRD_PARTY_UNWIRED: 'REPLAY_THIRD_PARTY_UNWIRED',
  /** 第三方未确认（`requested` 不等于 `confirmed`）⇒ 不得判成功。 */
  THIRD_PARTY_NOT_CONFIRMED: 'REPLAY_THIRD_PARTY_NOT_CONFIRMED',
  /** 仍在期限内、且**没有完成证据** ⇒ 不得仅凭时钟判完成（期限是上限，不是保留期）。 */
  UNDUE_NO_EVIDENCE: 'REPLAY_UNDUE_NO_EVIDENCE',
  /** 已逾期、且**仍没有完成证据** ⇒ 逾期未执行，不得声称恢复安全。 */
  OVERDUE_NOT_EXECUTED: 'REPLAY_OVERDUE_NOT_EXECUTED',
  /** 清单已产出但**尚未重放**（清单本身不足以声称恢复安全）。 */
  NOT_EXECUTED: 'REPLAY_NOT_EXECUTED',
  /** 已要求重放但未完成（可重试）。 */
  PENDING: 'REPLAY_PENDING',
  /** 重放失败。 */
  FAILED: 'REPLAY_FAILED',
  /** 报称完成但缺证据（空白不算证据）⇒ 不得判成功。 */
  NO_EVIDENCE: 'REPLAY_NO_EVIDENCE',
  /** 恢复后该对象**仍可见/可用** ⇒ 复活，必须保持隔离。 */
  REVIVED: 'REPLAY_REVIVED',
  /** 无法回查该对象是否仍可见（目标不可读）⇒ 「验证无复活」未完成，不得声称安全。 */
  VERIFY_UNAVAILABLE: 'REPLAY_VERIFY_UNAVAILABLE',
  /** 该条被快照覆盖（不是错误，仅说明为何无需重放）。 */
  COVERED: 'REPLAY_COVERED_BY_SNAPSHOT',
  /** 没有一条需要重放（全部被快照覆盖且快照不含这些对象）。 */
  NOTHING_REQUIRED: 'REPLAY_NOTHING_REQUIRED',
} as const;

export const REPLAY_REASON_CODES = Object.freeze(REASON_CODE_VALUES);

export type ReplayReasonCode = (typeof REASON_CODE_VALUES)[keyof typeof REASON_CODE_VALUES];

/** 单条重放结果的状态闭集。`applied`/`duplicate` 均表示「已重放且带证据」（幂等成功）。 */
export const REPLAY_ENTRY_STATUSES: readonly string[] = Object.freeze([
  'applied',
  'duplicate',
  'pending',
  'failed',
  'covered',
]);

/** 备份快照（state-contract：「每个备份有 lineage 和截至水位」）。 */
export interface BackupSnapshotInput {
  /** 快照标识（lineage 内唯一）。 */
  snapshot_id: string;
  /** 备份 lineage（同一条备份链）。缺省 `null`。 */
  lineage?: string | null;
  /** **截至水位**：快照覆盖到该时刻为止的 durable 记录。 */
  watermark: string | number | Date;
  /** 快照生成时刻（诊断用，可选）。 */
  created_at?: string | number | Date | null;
  /**
   * 快照**实际含有**的对象引用（opaque）。给出时用于判定「该对象是否真被快照覆盖」；
   * **缺省（未知）⇒ 所有 tombstone 一律必须重放**（fail-closed：不能证明覆盖就必须重放）。
   */
  contains_object_refs?: readonly string[] | null;
}

/** 一条 durable tombstone（追加存储里的删除事实；本模块只读消费）。 */
export interface ReplayTombstoneInput {
  /** **opaque** 对象引用（不得含用户可识别信息）。 */
  object_ref: string;
  /** 删除代次（只增；同一对象可有多代删除）。 */
  delete_generation: number;
  /** 范围（`REPLAY_SCOPES` 闭集内）。 */
  scope: string;
  /** tombstone durable 落库时刻（与快照水位比较）。 */
  recorded_at: string | number | Date;
  /** 删除请求受理时刻（7 日 / 30 日窗口起点）。 */
  requested_at: string | number | Date;
  /** 阶段；缺省 `backup`（备份恢复天然落在 30 日窗口上）。 */
  phase?: string;
  /** 已记录的阶段状态（`HANDLER_STATES` 闭集）；缺省 `pending`。 */
  state?: string | null;
  /** 已记录的完成证据引用（空白不算证据）。 */
  evidence_ref?: string | null;
  /** 已记录的错误码（仅 `SAFE_ERROR_CODES` 内会被原样透出）。 */
  error_code?: string | null;
  /** 供应商副本行（scope = `third_party` 时应给出；`requested` 绝不等于 `confirmed`）。 */
  third_party?: {
    recipient_id?: string | null;
    export_ref?: string | null;
    online_status?: string | null;
    backup_status?: string | null;
    evidence_ref?: string | null;
    error_code?: string | null;
  } | null;
}

/** 清单入参。 */
export interface BackupReplayManifestInput {
  snapshot: BackupSnapshotInput;
  /** durable tombstone 清单（受控追加存储的内容；可为空，但空清单不得声称安全）。 */
  tombstones: readonly unknown[];
  /** 可注入的当前时间；不传则取一次系统时间。 */
  now?: string | number | Date;
  /** 可选：调用方主体。给出时**必须**能核实归属，否则 fail-closed。 */
  subject?: string;
  /** 可选：清单针对的删除请求 id（核实归属用）。 */
  requestId?: string;
  /** 可选：`requestId → 主体` 绑定读取器（核实归属用）。 */
  ownerOf?: (requestId: string) => string | null | undefined;
}

/** 清单中的一条（**计划**，不是结论）。 */
export interface BackupReplayManifestEntry {
  /** 重放顺序（0 起，与 `entries` 顺序一致）。 */
  readonly seq: number;
  /** 稳定幂等键（sha256 十六进制）；跨快照、跨重放稳定。 */
  readonly replay_key: string;
  readonly object_ref: string;
  readonly scope: string;
  /** 范围权重（排序依据）。 */
  readonly scope_order: number;
  readonly delete_generation: number;
  readonly recorded_at: string | null;
  readonly requested_at: string | null;
  readonly phase: string;
  /** 该阶段到期时刻（在线 +7 日 / 备份 +30 日）。 */
  readonly due_at: string | null;
  /** 该阶段期限是否已到（闭区间：`now >= due_at`）。
   * **只是事实列示，不是完成门槛** —— 期限是上限，期限内提前完成同样算完成。 */
  readonly window_due: boolean;
  /** 清单里**既成的完成证据**是否成立（`HANDLER_STATES.completed` + 证据非空白；
   * 第三方条目要求接收方 `confirmed` 且带证据）。与是否到期**解耦**。 */
  readonly deletion_settled: boolean;
  /** **必须重放**：快照含有该对象，或 tombstone 比快照水位新。 */
  readonly needed: boolean;
  /** 被快照覆盖（`needed === false`）。 */
  readonly covered_by_snapshot: boolean;
  /** 既有协议 `HANDLER_STATES` 闭集内的原值（如实保留，不隐藏）。 */
  readonly protocol_state: string;
  /** 该阶段接收方状态（`THIRD_PARTY_STATES` 闭集内或 `null`）。 */
  readonly third_party_state: string | null;
  /** 第三方是否已确认（`requested` 绝不等于 `confirmed`）。 */
  readonly third_party_confirmed: boolean;
  /** 白名单内的既有失败码原样透出；其余一律 `null`（不透出原文）。 */
  readonly recorded_error_code: string | null;
  /** 本条重放必须留下的证据种类。 */
  readonly evidence_required: readonly string[];
}

/** 恢复重放清单。 */
export interface BackupReplayManifest {
  readonly manifest_version: number;
  readonly snapshot_id: string;
  readonly lineage: string | null;
  readonly watermark: string | null;
  readonly created_at: string | null;
  readonly now: string | null;
  /** 是否核实过归属（未给主体时为 `false`，表示「未主张任何归属」）。 */
  readonly subject_verified: boolean;
  /** 全部条目（按重放顺序，含被覆盖的）。 */
  readonly entries: readonly BackupReplayManifestEntry[];
  /** 必须重放的 `replay_key` 顺序（`replay_order` 即重放顺序）。 */
  readonly replay_order: readonly string[];
  readonly entries_total: number;
  readonly entries_required: number;
  readonly entries_covered: number;
  /** 清单完整性摘要（sha256，覆盖版本/快照/水位/每条 `seq|replay_key|needed`）。 */
  readonly manifest_digest: string;
  /** `ready` = 有可重放条目且清单完整；`blocked` = 清单不可用于重放。 */
  readonly state: string;
  /**
   * **恒为 `false`**：清单只是计划 —— 没重放、没验证无复活、没看到期窗口，
   * 因此永远不足以声称「恢复安全」。必须走 `executeBackupReplay()` 拿结论。
   */
  readonly restore_safe: boolean;
  readonly reason_code: string | null;
  readonly reasons: readonly string[];
  readonly detail: string | null;
}

/** 交给目标端口的一条重放请求。 */
export interface BackupReplayEntryRequest {
  readonly replay_key: string;
  readonly object_ref: string;
  readonly delete_generation: number;
  readonly scope: string;
  readonly phase: string;
  readonly evidence_required: readonly string[];
}

/**
 * 目标端口的一次重放结果。
 * `applied`/`duplicate` 都表示「已重放且带证据」；`duplicate` 表示同键**已重放**（幂等命中，
 * **不产生第二份事实**）；`pending`/`failed` 表示未完成（必须带可判别原因）。
 */
export type BackupReplayApplyResult =
  | { readonly outcome: 'applied'; readonly evidenceRef: string; readonly confirmed?: boolean }
  | { readonly outcome: 'duplicate'; readonly evidenceRef: string; readonly confirmed?: boolean }
  | { readonly outcome: 'pending'; readonly errorCode?: string | null }
  | { readonly outcome: 'failed'; readonly errorCode?: string | null };

/**
 * 恢复目标端口（备份系统替身/真实适配器的形状）。
 * `available !== true`（`real` 未接真实依赖）⇒ 一律 fail-closed，**绝不**发任何调用。
 */
export interface BackupReplayTargetPort {
  readonly kind: 'wired' | 'unwired';
  readonly available: boolean;
  /** 原子幂等重放：同一 `replay_key` 重复调用**不得产生第二份事实**。 */
  apply(entry: BackupReplayEntryRequest): Promise<BackupReplayApplyResult> | BackupReplayApplyResult;
  /** 恢复后该对象是否仍可见/可用（「验证无复活」用；应为 `false`）。 */
  isVisible(objectRef: string): Promise<boolean> | boolean;
  /** 第三方待删重播端口；**未接线 ⇒ fail-closed**（零真实第三方调用）。 */
  thirdParty?: {
    readonly available: boolean;
    replay(entry: BackupReplayEntryRequest): Promise<BackupReplayApplyResult> | BackupReplayApplyResult;
  } | null;
}

/** 单条重放结论。 */
export interface BackupReplayEntryOutcome {
  readonly seq: number;
  readonly replay_key: string;
  readonly object_ref: string;
  readonly scope: string;
  readonly delete_generation: number;
  readonly needed: boolean;
  /** `REPLAY_ENTRY_STATUSES` 闭集内。 */
  readonly status: string;
  readonly evidence_ref: string | null;
  /** 重放后是否仍可见（`true` = 复活）；无法验证时为 `null`。 */
  readonly visible_after: boolean | null;
  /** 期限是否已到（**事实**，不是完成门槛）。 */
  readonly window_due: boolean;
  /** 该条删除事实是否已由**证据**确定完成（清单既有证据 或 本次重放证据）。 */
  readonly settled: boolean;
  /** 本条是否已达到「恢复安全」（可判别，不靠整单平均）。 */
  readonly restore_safe: boolean;
  readonly reason_code: string | null;
  readonly recorded_error_code: string | null;
  readonly detail: string | null;
}

/** 整单重放结论。 */
export interface BackupReplayResult {
  readonly manifest_version: number;
  readonly snapshot_id: string;
  readonly watermark: string | null;
  readonly now: string | null;
  readonly manifest_digest: string;
  readonly entries: readonly BackupReplayEntryOutcome[];
  readonly replayed: number;
  readonly duplicated: number;
  readonly pending: number;
  readonly failed: number;
  readonly covered: number;
  /** 重放后仍可见的对象（**复活**）；非空即必须保持隔离。 */
  readonly revived_object_refs: readonly string[];
  /** 是否完成「验证无复活」（每条都回查过且都不可见）。 */
  readonly verified_no_revival: boolean;
  /** 是否可声称「恢复安全」（= 可开流量）。 */
  readonly restore_safe: boolean;
  /** `restore_safe === false` 时是否必须保持隔离（关闭入口与外发）。 */
  readonly isolation_required: boolean;
  readonly reason_code: string | null;
  readonly reasons: readonly string[];
  readonly detail: string | null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function trimmedOrNull(value: unknown): string | null {
  return isNonEmptyString(value) ? value.trim() : null;
}

/** 只透出既有协议白名单内的失败码；其余一律折叠为 `null`（不透出原文）。 */
function whitelistedErrorCode(value: unknown): string | null {
  const code = trimmedOrNull(value);
  return code !== null && SAFE_ERROR_CODES.includes(code) ? code : null;
}

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * 幂等键：只由**对象身份**与**删除代次**决定（不含快照 id、不含时间）
 * ⇒ 跨快照、跨重放稳定，重复重放可被目标端识别为同一键（PK 冲突 ⇒ `duplicate`）。
 */
export function replayKeyOf(objectRef: string, deleteGeneration: number): string {
  return sha256(`gengyun/backup-replay/v1\0${objectRef}\0${deleteGeneration}`);
}

/** 清单完整性摘要：覆盖版本/快照/水位与每条 `seq|replay_key|needed`。 */
function manifestDigestOf(
  snapshotId: string,
  watermarkIso: string | null,
  entries: readonly { seq: number; replay_key: string; needed: boolean }[],
): string {
  const lines = entries.map((entry) => `${entry.seq}|${entry.replay_key}|${entry.needed ? '1' : '0'}`);
  return sha256(
    [`v${REPLAY_MANIFEST_VERSION}`, snapshotId, watermarkIso ?? '', ...lines].join('\n'),
  );
}

/** 用第 1 步的到期模块做**严格时刻解析**（不合形态/时间线倒置 ⇒ `null`，不另立解析口径）。 */
function strictInstantMs(value: unknown, nowMs: number): number | null {
  if (value === undefined || value === null) return null;
  const probe = evaluateDeletionAging({
    requestedAt: value as string | number | Date,
    phase: 'online',
    now: nowMs,
    recordedState: 'pending',
  });
  if (probe.reason_code === AGING_REASON_CODES.INPUT_INVALID || probe.requested_at === null) return null;
  const ms = Date.parse(probe.requested_at);
  return Number.isFinite(ms) ? ms : null;
}

/** 解析注入的 `now`（不注入则取一次系统时间，保证一次调用内只有一个"当前时间"）。 */
function resolveNow(value: unknown): { ms: number; iso: string } | null {
  if (value === undefined) {
    const ms = Date.now();
    return { ms, iso: new Date(ms).toISOString() };
  }
  const probe = evaluateDeletionAging({ requestedAt: value as string | number | Date, phase: 'online', now: value as string | number | Date, recordedState: 'pending' });
  if (probe.reason_code === AGING_REASON_CODES.INPUT_INVALID || probe.requested_at === null) return null;
  const ms = Date.parse(probe.requested_at);
  return Number.isFinite(ms) ? { ms, iso: probe.requested_at } : null;
}

/** fail-closed 空清单：**不返回任何条目**，`restore_safe` 恒 false。 */
function blockedManifest(input: {
  snapshotId: string;
  lineage: string | null;
  watermarkIso: string | null;
  createdAtIso: string | null;
  nowIso: string | null;
  reasonCode: string;
  detail: string;
  subjectVerified: boolean;
}): BackupReplayManifest {
  const digest = manifestDigestOf(input.snapshotId, input.watermarkIso, []);
  return Object.freeze({
    manifest_version: REPLAY_MANIFEST_VERSION,
    snapshot_id: input.snapshotId,
    lineage: input.lineage,
    watermark: input.watermarkIso,
    created_at: input.createdAtIso,
    now: input.nowIso,
    subject_verified: input.subjectVerified,
    entries: Object.freeze([]) as readonly BackupReplayManifestEntry[],
    replay_order: Object.freeze([]) as readonly string[],
    entries_total: 0,
    entries_required: 0,
    entries_covered: 0,
    manifest_digest: digest,
    state: 'blocked' as const,
    restore_safe: false,
    reason_code: input.reasonCode,
    reasons: Object.freeze([input.reasonCode]) as readonly string[],
    detail: input.detail,
  });
}

/**
 * 产出**恢复重放清单**：需要重放哪些删除、顺序、幂等键、每条的证据要求。
 *
 * 纯函数：相同入参（含显式 `now`）⇒ 逐字段相同；不修改任何入参；不写任何状态、不发任何调用。
 *
 * 关键判定（**不是**只比水位）：
 *   `needed = 快照实际含有该对象引用 || tombstone.recorded_at > 快照水位`
 *   —— 只比水位会把「含已删对象」的快照误判为已覆盖 ⇒ 恢复后复活。
 *   `contains_object_refs` 缺省（未知）⇒ **全部** tombstone 一律 `needed`（不能证明就必须重放）。
 */
export function buildBackupReplayManifest(input: BackupReplayManifestInput): BackupReplayManifest {
  const now = resolveNow(input?.now);
  const nowIso = now?.iso ?? null;
  if (now === null) {
    return blockedManifest({
      snapshotId: '', lineage: null, watermarkIso: null, createdAtIso: null, nowIso: null,
      reasonCode: REASON_CODE_VALUES.INPUT_INVALID,
      detail: 'now 不是可用的严格 ISO-8601 时刻',
      subjectVerified: false,
    });
  }

  const snapshot = input?.snapshot as BackupSnapshotInput | undefined;
  const snapshotId = isNonEmptyString(snapshot?.snapshot_id) ? snapshot.snapshot_id.trim() : '';
  const lineage = trimmedOrNull(snapshot?.lineage);
  // 水位与快照时间走同一套严格解析（复用第 1 步；非法/未来时刻一律 fail-closed）。
  const watermarkMs = strictInstantMs(snapshot?.watermark, now.ms);
  const watermarkIso = watermarkMs === null ? null : new Date(watermarkMs).toISOString();
  const createdAtMs = snapshot?.created_at === undefined || snapshot?.created_at === null
    ? null
    : strictInstantMs(snapshot.created_at, now.ms);
  const createdAtIso = createdAtMs === null ? null : new Date(createdAtMs).toISOString();

  const blocked = (reasonCode: string, detail: string, subjectVerified = false): BackupReplayManifest =>
    blockedManifest({ snapshotId, lineage, watermarkIso, createdAtIso, nowIso, reasonCode, detail, subjectVerified });

  if (snapshotId === '') {
    return blocked(REASON_CODE_VALUES.INPUT_INVALID, '快照缺少非空 snapshot_id');
  }
  if (watermarkMs === null || watermarkIso === null) {
    return blocked(REASON_CODE_VALUES.INPUT_INVALID, '快照缺少可用的严格 ISO-8601 截至水位');
  }
  if (snapshot?.created_at !== undefined && snapshot?.created_at !== null && createdAtIso === null) {
    return blocked(REASON_CODE_VALUES.INPUT_INVALID, '快照 created_at 不是可用的严格 ISO-8601 时刻');
  }

  // 越权 / 无法核实归属 ⇒ 不出任何条目（不替别人出清单）。
  let subjectVerified = false;
  if (input.subject !== undefined) {
    if (typeof input.ownerOf !== 'function' || !isNonEmptyString(input.requestId)) {
      return blocked(
        REASON_CODE_VALUES.OWNERSHIP_UNVERIFIED,
        '未提供 requestId + ownerOf 绑定，无法核实该清单归属 ⇒ 拒绝出清单',
      );
    }
    const owner = input.ownerOf(input.requestId);
    if (!isNonEmptyString(owner)) {
      return blocked(REASON_CODE_VALUES.OWNERSHIP_UNVERIFIED, '请求未绑定主体（或请求不存在）⇒ 拒绝出清单');
    }
    if (owner !== input.subject) {
      return blocked(REASON_CODE_VALUES.SUBJECT_MISMATCH, '调用方主体与该删除请求绑定的主体不一致 ⇒ 拒绝出清单');
    }
    subjectVerified = true;
  }

  const tombstones = input?.tombstones;
  if (!Array.isArray(tombstones)) {
    return blocked(REASON_CODE_VALUES.INPUT_INVALID, 'tombstones 不是数组');
  }

  // 快照含有的对象引用：给出数组即按事实判定；缺省/非法 ⇒ 全部必须重放（fail-closed）。
  const containsRaw = snapshot?.contains_object_refs;
  const contains = Array.isArray(containsRaw)
    ? new Set(containsRaw.filter((item): item is string => isNonEmptyString(item)).map((item) => item.trim()))
    : null;

  /** @type {BackupReplayManifestEntry[]} */
  const entries: BackupReplayManifestEntry[] = [];
  for (const raw of tombstones) {
    if (typeof raw !== 'object' || raw === null) {
      return blocked(REASON_CODE_VALUES.INPUT_INVALID, 'tombstone 行不是对象（不得静默跳过坏行）');
    }
    const row = raw as ReplayTombstoneInput;
    const objectRef = trimmedOrNull(row.object_ref);
    if (objectRef === null) {
      return blocked(REASON_CODE_VALUES.INPUT_INVALID, 'tombstone 缺少非空 object_ref');
    }
    const generation = row.delete_generation;
    if (!Number.isSafeInteger(generation) || generation < 1) {
      return blocked(REASON_CODE_VALUES.INPUT_INVALID, `tombstone delete_generation 非法：${String(generation)}`);
    }
    const scope = trimmedOrNull(row.scope);
    if (scope === null || !REPLAY_SCOPES.includes(scope)) {
      return blocked(
        REASON_CODE_VALUES.INPUT_INVALID,
        `tombstone scope 不在重放范围闭集内：${String(row.scope)}`,
      );
    }
    let phase: 'online' | 'backup' = DEFAULT_PHASE;
    if (row.phase !== undefined && row.phase !== null) {
      const rawPhase = trimmedOrNull(row.phase);
      if (rawPhase === null || !PHASES.includes(rawPhase)) {
        return blocked(REASON_CODE_VALUES.INPUT_INVALID, `tombstone phase 非法：${String(row.phase)}`);
      }
      phase = rawPhase as 'online' | 'backup';
    }
    const protocolState = row.state === undefined || row.state === null ? 'pending' : trimmedOrNull(row.state);
    if (protocolState === null || !HANDLER_STATES.includes(protocolState)) {
      return blocked(
        REASON_CODE_VALUES.INPUT_INVALID,
        `tombstone state 不在既有协议闭集内：${String(row.state)}`,
      );
    }
    const recordedMs = strictInstantMs(row.recorded_at, now.ms);
    if (recordedMs === null || recordedMs > now.ms) {
      return blocked(REASON_CODE_VALUES.INPUT_INVALID, 'tombstone recorded_at 不可用或晚于 now（时间线不可信）');
    }
    // 7 日 / 30 日窗口：复用第 1 步同一口径（闭区间）。**期限只是事实**（未到期 ≠ 不得完成）。
    const aging = evaluateDeletionAging({
      requestedAt: row.requested_at,
      phase,
      now: now.ms,
      recordedState: protocolState,
      evidenceRef: row.evidence_ref ?? null,
      errorCode: row.error_code ?? null,
    });
    if (aging.reason_code === AGING_REASON_CODES.INPUT_INVALID || aging.requested_at === null || aging.due_at === null) {
      return blocked(REASON_CODE_VALUES.INPUT_INVALID, `tombstone 窗口入参不可信：${aging.detail ?? ''}`);
    }

    const thirdPartyRow = row.third_party ?? null;
    const thirdPartyStateRaw = thirdPartyRow === null
      ? null
      : trimmedOrNull(phase === 'online' ? thirdPartyRow.online_status : thirdPartyRow.backup_status);
    const thirdPartyState = thirdPartyStateRaw !== null && THIRD_PARTY_STATES.includes(thirdPartyStateRaw)
      ? thirdPartyStateRaw
      : null;
    if (scope === 'third_party' && (thirdPartyRow === null || thirdPartyState === null)) {
      // 第三方条目必须带合法接收方行：形状不可信 ⇒ fail-closed（不猜确认状态）。
      return blocked(
        REASON_CODE_VALUES.INPUT_INVALID,
        'third_party 条目缺少合法接收方状态（不得凭空假定已确认）',
      );
    }
    const thirdPartyConfirmed = thirdPartyState === 'confirmed'
      && (isNonEmptyString(thirdPartyRow?.evidence_ref) || isNonEmptyString(row.evidence_ref));

    // **关键**：水位 + 快照实际含有，二者取「或」——只比水位会把含已删对象的快照误判为已覆盖。
    const needed = contains === null || contains.has(objectRef) || recordedMs > watermarkMs;

    entries.push(Object.freeze({
      seq: 0, // 排序后回填
      replay_key: replayKeyOf(objectRef, generation),
      object_ref: objectRef,
      scope,
      scope_order: SCOPE_ORDER[scope] ?? Number.MAX_SAFE_INTEGER,
      delete_generation: generation,
      recorded_at: new Date(recordedMs).toISOString(),
      requested_at: aging.requested_at,
      phase,
      due_at: aging.due_at,
      window_due: aging.is_due,
      // 完成看证据、不看时钟（期限是上限；P1 口径）：
      // 普通范围 = 既有协议 completed + 有效证据；第三方 = 接收方 confirmed 且带证据。
      deletion_settled: scope === 'third_party' ? thirdPartyConfirmed : aging.completed,
      needed,
      covered_by_snapshot: !needed,
      protocol_state: protocolState,
      third_party_state: thirdPartyState,
      third_party_confirmed: thirdPartyConfirmed,
      recorded_error_code: whitelistedErrorCode(
        row.error_code ?? thirdPartyRow?.error_code ?? null,
      ),
      evidence_required: EVIDENCE_REQUIREMENTS[scope] ?? DEFAULT_EVIDENCE_REQUIREMENTS,
    }));
  }

  // 重放顺序：删除代次升序 → 范围权重 → 落库时刻 → 对象引用（全序，跨机器一致）。
  entries.sort((a, b) =>
    a.delete_generation - b.delete_generation ||
    a.scope_order - b.scope_order ||
    String(a.recorded_at).localeCompare(String(b.recorded_at)) ||
    a.object_ref.localeCompare(b.object_ref),
  );
  const ordered = entries.map((entry, index) => Object.freeze({ ...entry, seq: index }));

  const required = ordered.filter((entry) => entry.needed);
  const digest = manifestDigestOf(snapshotId, watermarkIso, ordered);

  const reasons: string[] = [];
  if (ordered.length === 0) reasons.push(REASON_CODE_VALUES.NONE);
  else if (required.length === 0) reasons.push(REASON_CODE_VALUES.NOTHING_REQUIRED);
  else reasons.push(REASON_CODE_VALUES.NOT_EXECUTED);

  return Object.freeze({
    manifest_version: REPLAY_MANIFEST_VERSION,
    snapshot_id: snapshotId,
    lineage,
    watermark: watermarkIso,
    created_at: createdAtIso,
    now: nowIso,
    subject_verified: subjectVerified,
    entries: Object.freeze(ordered) as readonly BackupReplayManifestEntry[],
    replay_order: Object.freeze(required.map((entry) => entry.replay_key)) as readonly string[],
    entries_total: ordered.length,
    entries_required: required.length,
    entries_covered: ordered.length - required.length,
    manifest_digest: digest,
    state: ordered.length === 0 ? ('blocked' as const) : ('ready' as const),
    // 清单只是计划：没重放、没验证无复活、没看到期窗口 ⇒ 永远不足以声称恢复安全。
    restore_safe: false,
    reason_code: ordered.length === 0
      ? REASON_CODE_VALUES.NONE
      : required.length === 0
        ? REASON_CODE_VALUES.NOTHING_REQUIRED
        : REASON_CODE_VALUES.NOT_EXECUTED,
    reasons: Object.freeze(reasons) as readonly string[],
    detail: null,
  });
}

/** 重放编排入参。 */
export interface BackupReplayExecutionInput {
  manifest: BackupReplayManifest;
  /** 恢复目标端口；缺省/未接线 ⇒ 全部必重放条目 fail-closed。 */
  target?: BackupReplayTargetPort | null;
  /** 可注入的当前时间；缺省取清单里的 `now`。 */
  now?: string | number | Date;
}

/** fail-closed 的空重放结论。 */
function blockedReplayResult(input: {
  manifest: BackupReplayManifest;
  nowIso: string | null;
  reasonCode: string;
  detail: string;
}): BackupReplayResult {
  return Object.freeze({
    manifest_version: input.manifest?.manifest_version ?? REPLAY_MANIFEST_VERSION,
    snapshot_id: typeof input.manifest?.snapshot_id === 'string' ? input.manifest.snapshot_id : '',
    watermark: input.manifest?.watermark ?? null,
    now: input.nowIso,
    manifest_digest: typeof input.manifest?.manifest_digest === 'string' ? input.manifest.manifest_digest : '',
    entries: Object.freeze([]) as readonly BackupReplayEntryOutcome[],
    replayed: 0, duplicated: 0, pending: 0, failed: 0, covered: 0,
    revived_object_refs: Object.freeze([]) as readonly string[],
    verified_no_revival: false,
    restore_safe: false,
    isolation_required: true,
    reason_code: input.reasonCode,
    reasons: Object.freeze([input.reasonCode]) as readonly string[],
    detail: input.detail,
  });
}

/** 端口返回结果 → 条目结论。`applied`/`duplicate` 必须带非空证据，否则不算成功。 */
function classifyApply(
  result: BackupReplayApplyResult | undefined | null,
  scope: string,
  fallbackErrorCode: string | null,
): { status: string; evidenceRef: string | null; reasonCode: string | null; detail: string | null } {
  const outcome = result?.outcome;
  if (outcome === 'applied' || outcome === 'duplicate') {
    const evidenceRef = trimmedOrNull((result as { evidenceRef?: unknown }).evidenceRef);
    if (evidenceRef === null) {
      return {
        status: 'failed',
        evidenceRef: null,
        reasonCode: REASON_CODE_VALUES.NO_EVIDENCE,
        detail: '重放报称完成但缺证据，不得判成功',
      };
    }
    // 第三方：`requested` 绝不等于 `confirmed` —— 没有确认就不算重放成功。
    if (scope === 'third_party' && (result as { confirmed?: unknown }).confirmed !== true) {
      return {
        status: 'pending',
        evidenceRef,
        reasonCode: REASON_CODE_VALUES.THIRD_PARTY_NOT_CONFIRMED,
        detail: '第三方待删尚未确认（requested 不等于 confirmed）',
      };
    }
    return { status: outcome, evidenceRef, reasonCode: null, detail: null };
  }
  if (outcome === 'pending') {
    return {
      status: 'pending',
      evidenceRef: null,
      reasonCode: whitelistedErrorCode((result as { errorCode?: unknown }).errorCode) ?? fallbackErrorCode ?? REASON_CODE_VALUES.PENDING,
      detail: '已要求重放但未完成',
    };
  }
  if (outcome === 'failed') {
    return {
      status: 'failed',
      evidenceRef: null,
      reasonCode: whitelistedErrorCode((result as { errorCode?: unknown }).errorCode) ?? fallbackErrorCode ?? REASON_CODE_VALUES.FAILED,
      detail: '重放失败',
    };
  }
  return {
    status: 'failed',
    evidenceRef: null,
    reasonCode: fallbackErrorCode ?? REASON_CODE_VALUES.FAILED,
    detail: '重放结果形状不可信',
  };
}

/**
 * 执行恢复重放并**验证无复活**：`state-contract` 的「加载清单 → 删除/重播 → 验证无复活 → 开流量，
 * 失败保持隔离」。
 *
 * 铁律：
 *   - 入口先核对 `manifest_digest`（被裁剪/篡改 ⇒ `REPLAY_MANIFEST_TAMPERED`，**不进入重放**）；
 *   - 未接线/不可用端口 ⇒ `REPLAY_TARGET_UNAVAILABLE` / `REPLAY_THIRD_PARTY_UNWIRED`，**零调用**；
 *   - 重放后逐条回查可见性；任一仍可见 ⇒ `REPLAY_REVIVED`，`restore_safe: false`、`isolation_required: true`；
 *   - **不得仅凭时钟判完成**：没有完成证据时，仍在期限内 ⇒ `REPLAY_UNDUE_NO_EVIDENCE`、
 *     已逾期 ⇒ `REPLAY_OVERDUE_NOT_EXECUTED`，`restore_safe: false`；
 *     反过来，**期限内提前完成且带证据**（本次重放证据或清单既有证据）必须如实判安全；
 *   - `restore_safe === true` 需：无复活 + 每条必重放条目都已重放且带证据 + 每条窗口都已到期
 *     + 清单非空（空清单不得真空真）。
 */
export async function executeBackupReplay(input: BackupReplayExecutionInput): Promise<BackupReplayResult> {
  const manifest = input?.manifest as BackupReplayManifest | undefined;
  const now = resolveNow(input?.now ?? manifest?.now);
  const nowIso = now?.iso ?? null;

  if (now === null) {
    return blockedReplayResult({
      manifest: manifest as BackupReplayManifest,
      nowIso: null,
      reasonCode: REASON_CODE_VALUES.INPUT_INVALID,
      detail: 'now 不是可用的严格 ISO-8601 时刻',
    });
  }
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.entries)) {
    return blockedReplayResult({
      manifest: manifest as BackupReplayManifest,
      nowIso,
      reasonCode: REASON_CODE_VALUES.INPUT_INVALID,
      detail: '清单形状不可信（缺少 entries）',
    });
  }
  if (manifest.state !== 'ready') {
    return blockedReplayResult({
      manifest,
      nowIso,
      reasonCode: manifest.reason_code ?? REASON_CODE_VALUES.INPUT_INVALID,
      detail: '清单 state 不是 ready，不可用于重放',
    });
  }

  // 清单完整性：重新计算 digest 并比对（漏重放最常见的根因是清单被裁剪）。
  const expectedDigest = manifestDigestOf(manifest.snapshot_id, manifest.watermark, manifest.entries);
  if (expectedDigest !== manifest.manifest_digest) {
    return blockedReplayResult({
      manifest,
      nowIso,
      reasonCode: REASON_CODE_VALUES.MANIFEST_TAMPERED,
      detail: '清单摘要不符（被裁剪或篡改）⇒ 拒绝重放',
    });
  }

  const target = input?.target ?? null;
  const targetAvailable = target !== null && target.available === true;
  const thirdPartyAvailable = targetAvailable && target?.thirdParty?.available === true;

  const outcomes: BackupReplayEntryOutcome[] = [];
  for (const entry of manifest.entries) {
    const applyEntry: BackupReplayEntryRequest = Object.freeze({
      replay_key: entry.replay_key,
      object_ref: entry.object_ref,
      delete_generation: entry.delete_generation,
      scope: entry.scope,
      phase: entry.phase,
      evidence_required: entry.evidence_required,
    });

    let status: string;
    let evidenceRef: string | null = null;
    let reasonCode: string | null = null;
    let detail: string | null = null;
    let fallback: string | null = null;

    if (!entry.needed) {
      status = 'covered';
      detail = '被快照覆盖，无需重放（仍会回查是否复活）';
    } else if (entry.scope === 'third_party' && !thirdPartyAvailable) {
      status = 'failed';
      reasonCode = REASON_CODE_VALUES.THIRD_PARTY_UNWIRED;
      detail = '第三方待删重播端口未接线 ⇒ fail-closed（零真实第三方调用）';
    } else if (!targetAvailable) {
      status = 'failed';
      reasonCode = REASON_CODE_VALUES.TARGET_UNAVAILABLE;
      detail = '重放目标端口不可用/未接线 ⇒ fail-closed';
    } else {
      let raw: BackupReplayApplyResult | undefined;
      try {
        raw = entry.scope === 'third_party'
          ? await (target as BackupReplayTargetPort).thirdParty!.replay(applyEntry)
          : await (target as BackupReplayTargetPort).apply(applyEntry);
      } catch (err) {
        // 原始异常文本一律折叠：只透出白名单内的错误码。
        fallback = whitelistedErrorCode((err as { code?: unknown } | null)?.code) ?? REASON_CODE_VALUES.FAILED;
        raw = { outcome: 'failed', errorCode: fallback };
      }
      const classified = classifyApply(raw, entry.scope, fallback);
      status = classified.status;
      evidenceRef = classified.evidenceRef;
      reasonCode = classified.reasonCode;
      detail = classified.detail;
    }

    // 「验证无复活」：逐条回查（含 covered 条目 —— 水位可能说谎，事实以可见性为准）。
    let visibleAfter: boolean | null = null;
    if (targetAvailable) {
      try {
        visibleAfter = (await (target as BackupReplayTargetPort).isVisible(entry.object_ref)) === true;
      } catch {
        visibleAfter = null;
      }
    }

    if (visibleAfter === true) {
      // 复活是**事实**（`visible_after` / `revived_object_refs` 都如实记录）；
      // 若本轮重放报称成功却仍可见，则连结论也只能是失败。
      if (status === 'applied' || status === 'duplicate' || status === 'covered') {
        status = 'failed';
        reasonCode = REASON_CODE_VALUES.REVIVED;
      }
      reasonCode = reasonCode ?? REASON_CODE_VALUES.REVIVED;
      detail = '恢复后该对象仍可见/可用 ⇒ 复活，不得开流量';
    } else if (entry.needed ? visibleAfter === null : false) {
      // 需要重放但回查不到 ⇒ 「验证无复活」不成立，不能因为重放函数返回成功就放行。
      reasonCode = reasonCode ?? REASON_CODE_VALUES.VERIFY_UNAVAILABLE;
      detail = detail ?? '无法回查该对象是否仍可见 ⇒ 不得声称恢复安全';
    }

    // 完成看**证据**、不看时钟（监工 P1 / B18：7 日 / 30 日是上限，不是必须保留满）：
    //   必须重放的条目 ⇒ 本次重放的证据（applied/duplicate + 非空 evidence_ref）即可定案；
    //   被快照覆盖的条目 ⇒ 只能靠清单里**既成**的完成证据（它没被重放）。
    const settledByReplay = (status === 'applied' || status === 'duplicate') && evidenceRef !== null;
    const settledEntry = entry.needed ? (settledByReplay || entry.deletion_settled) : entry.deletion_settled;
    if (!settledEntry && reasonCode === null) {
      // **不得仅凭时钟判完成**：没有证据时，「期限未到」与「已逾期」都不得声称安全。
      reasonCode = entry.window_due
        ? REASON_CODE_VALUES.OVERDUE_NOT_EXECUTED
        : REASON_CODE_VALUES.UNDUE_NO_EVIDENCE;
      detail = entry.window_due
        ? '已逾期且仍无完成证据 ⇒ 逾期未执行，不得声称恢复安全'
        : '仍在期限内且无完成证据 ⇒ 不得仅凭时钟判完成（期限是上限，不是保留期）';
    }

    // 单条安全 = **证据确定的完成事实** + 已回查确认不可见（期限只作事实列示）。
    const restoreSafe = settledEntry && visibleAfter === false;

    outcomes.push(Object.freeze({
      seq: entry.seq,
      replay_key: entry.replay_key,
      object_ref: entry.object_ref,
      scope: entry.scope,
      delete_generation: entry.delete_generation,
      needed: entry.needed,
      status,
      evidence_ref: evidenceRef,
      visible_after: visibleAfter,
      window_due: entry.window_due,
      settled: settledEntry,
      restore_safe: restoreSafe,
      // `restore_safe === false` 时原因码必非空。
      reason_code: restoreSafe ? null : reasonCode ?? REASON_CODE_VALUES.NOT_EXECUTED,
      recorded_error_code: entry.recorded_error_code,
      detail,
    }));
  }

  const replayed = outcomes.filter((entry) => entry.status === 'applied').length;
  const duplicated = outcomes.filter((entry) => entry.status === 'duplicate').length;
  const pending = outcomes.filter((entry) => entry.status === 'pending').length;
  const failed = outcomes.filter((entry) => entry.status === 'failed').length;
  const covered = outcomes.filter((entry) => entry.status === 'covered').length;
  const revived = outcomes.filter((entry) => entry.visible_after === true).map((entry) => entry.object_ref);

  const verifiedNoRevival = targetAvailable && outcomes.every((entry) => entry.visible_after === false);
  const allSafe = outcomes.length > 0 && outcomes.every((entry) => entry.restore_safe);

  const reasons: string[] = [];
  const push = (code: string | null): void => {
    if (code !== null && code.length > 0 && !reasons.includes(code)) reasons.push(code);
  };
  // 复活与失败优先（最需要被看见），随后按条目顺序补齐其余原因。
  for (const entry of outcomes) if (entry.visible_after === true) push(REASON_CODE_VALUES.REVIVED);
  for (const entry of outcomes) if (entry.status === 'failed') push(entry.reason_code);
  for (const entry of outcomes) if (entry.status === 'pending') push(entry.reason_code);
  if (!targetAvailable) push(REASON_CODE_VALUES.TARGET_UNAVAILABLE);
  if (!verifiedNoRevival) {
    for (const entry of outcomes) if (entry.visible_after === null) push(REASON_CODE_VALUES.VERIFY_UNAVAILABLE);
  }
  for (const entry of outcomes) push(entry.reason_code);
  if (outcomes.length === 0) push(REASON_CODE_VALUES.NONE);

  const restoreSafe = verifiedNoRevival && allSafe;
  return Object.freeze({
    manifest_version: manifest.manifest_version,
    snapshot_id: manifest.snapshot_id,
    watermark: manifest.watermark,
    now: nowIso,
    manifest_digest: manifest.manifest_digest,
    entries: Object.freeze(outcomes) as readonly BackupReplayEntryOutcome[],
    replayed, duplicated, pending, failed, covered,
    revived_object_refs: Object.freeze(revived) as readonly string[],
    verified_no_revival: verifiedNoRevival,
    restore_safe: restoreSafe,
    isolation_required: !restoreSafe,
    reason_code: restoreSafe ? null : (reasons[0] ?? REASON_CODE_VALUES.NOT_EXECUTED),
    reasons: Object.freeze(reasons) as readonly string[],
    detail: restoreSafe
      ? null
      : revived.length > 0
        ? '恢复后仍有对象可见 ⇒ 保持隔离，不得开流量'
        : '未满足「无复活 + 全部重放带证据 + 全部窗口到期」⇒ 不得声称恢复安全',
  });
}

/** 只取结论的那一个布尔（接线方最常用的入口）：`restore_safe`。 */
export async function backupReplayIsRestoreSafe(input: BackupReplayExecutionInput): Promise<boolean> {
  return (await executeBackupReplay(input)).restore_safe;
}
