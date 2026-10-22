/**
 * GY-R28 · W6（#19）· **7 日在线到期执行者**（运维驱动，`B4` 勘察页 P0-5 之前的那根"时钟"）。
 *
 * ## 为什么需要它（G9 的同族缺口）
 * 在线数据的清空原本只在**用户再次请求**时才推进（处理器随 `executeHandlers()` 跑）。
 * 也就是说：受理后 7 日（`deletion_requests.online_due_at`）到了，如果该用户再也不来，
 * 在线数据就一直留着 —— 「7 日到期」变成了一句没有执行者的话。
 * 本文件提供**按时间驱动**的执行者，形态与 30 日副本驱动（`services/api/src/privacy/backup-purge-driver.ts`，
 * E2 片）逐条对齐：运维命令 + 驱动模块，⛔ **不用 `setInterval` 常驻定时器**。
 *
 * 为什么不用常驻定时器（与 E2 同理由，且这里更硬）：
 *   1. 仓内没有任何进程级调度设施，`setInterval` 只能挂在 API 进程里 —— 多副本就重复执行、
 *      重启就丢语义、还会与 CI/真库臂抢时钟；
 *   2. 「到期」是**日历事实**（`online_due_at`），不是"进程活着多久"；进程睡了三天醒来
 *      补跑一次是正确行为，定时器反而会漏；
 *   3. 退出码是外部 cron / systemd timer 的唯一判据（0 干净 / 1 有失败 / 2 配置错）。
 *
 * ## 命名映射（派单里的 `scheduled_purge_at`）
 * 库里的到期列是 **`public.deletion_requests.online_due_at`**（`0003_privacy_consent.sql:146-163`，
 * 注释「受理 + 7×24 小时」；`0016` 只给它加了 `user_id`/回执列）。全仓不存在 `scheduled_purge_at`
 * 这个列 —— 本驱动按 `online_due_at <= cutoff` 取候选，语义与派单一致：**只处理已到期的请求**。
 *
 * ## 不变量（逐条有单测/真库臂）
 * | 不变量 | 实现 |
 * | --- | --- |
 * | 只处理 **已到期** | 候选 SQL `online_due_at <= $1`（闭区间：相等即到期）；驱动内**再判一次** `dueMs > cutoffMs ⇒ skip not_due` |
 * | **幂等** | 不靠状态位：第二轮再跑时四域 `removed = 0 && idempotency = 0` ⇒ 该请求落 `skipped/already_purged`，`rowsPurged = 0` |
 * | **批量上限可配** | `--limit`（默认 200，硬顶 5000）；非法/超顶**抛** `RangeError`（不夹取，夹取会静默少做事） |
 * | **批次会推进** | keyset 游标（`(date_trunc('milliseconds', online_due_at), id) > 游标`）+ `--max-batches`：超出 `--limit` 的到期集合**连跑即可全部处理**，队尾不再被已清空的队首挡住（见下节） |
 * | **失败不阻塞** | 每个 (request, module) 单独 try/catch；一行失败只记该行 `failed`，同请求其余模块与后续请求照跑；失败行**越过游标**，下一整轮再试（不是每轮原地撞同一批） |
 * | **每个成功行写证据** | 每个 `removed/idempotency` 成功行产出一条 `sha256:` 证据（`onlinePurgeEvidenceRef()`）：**落库**（迁移 0031 的 `record_online_purge_evidence`，供回执推导）＋进报告与退出码口径；落库失败的行记 `EVIDENCE_WRITE_FAILED` 失败（删除已发生但无凭据） |
 * | **不谎称完成** | 本驱动**不写** `deletion_requests.state`，也不改回执；它只删在线行并报告事实（完成判定仍归协调器） |
 *
 * ## 批次推进：为什么必须带游标（keyset），而不是固定取队首 `LIMIT` 条
 *
 * 「按 `(online_due_at, id)` 永远取最早 `LIMIT` 条」**本身不会推进**：本驱动不写
 * `deletion_requests.state`（完成判定归协调器），所以被清空的 A/B 在库里仍是非 `completed`，
 * 每一轮都排在最前面 ⇒ 超出 `--limit` 的 C、D、E 永远进不了候选（饿死）。三条约束同时成立：
 *   1. 不能写请求状态（否则就是用"只清了在线四域"冒充整笔 `completed`）；
 *   2. 当时不能新增迁移/加列（`0003_privacy_consent.sql:146-163` 没有"在线已清"列；W6 的
 *     红线如此。迁移 0031 之后新增的是**证据**列，仍然不写请求状态 ⇒ 本条约束的结论不变）；
 *   3. 但后续批次必须能继续推进到剩余到期请求。
 *
 * 解法：进度放在**命令侧**，候选查询改成 keyset 分页 + 单轮可连推多页（`drainDueOnlineDeletions`）：
 *   - 游标 = 上一轮**处理到的最后一行**的 `(online_due_at, request_id)`（见 `services/api/src/privacy/online-purge-cursor.ts`）；
 *     下一轮从该行**之后**继续，队尾的请求不再被队首挡住；
 *   - 本页不足 `--limit` 条 ⇒ 已到队尾，清掉游标，下一轮从队首重扫（这就是"一整轮"）；
 *     被越过的失败行在下一整轮会被**再试**（不丢弃、不假装成功，退出码 1 已经把人叫来）；
 *   - 已清空的请求只会在**下一整轮**再被看一次（落 `already_purged`，0 行、0 副作用）；
 *     `online_due_at = 受理 + 7×24h` 且新请求的受理时刻更晚 ⇒ 新到期请求天然排在游标之后，不会被漏掉；
 *   - ⛔ 游标里只有 `(online_due_at, request_id)`：不含 `user_id`、不含正文，也不进库、不改回执、不改请求 state。
 *
 * 为什么键里带 `date_trunc('milliseconds', online_due_at)`：`pg` 把 `timestamptz` 交给 JS 的 `Date`
 * 只有毫秒精度，库里却有微秒。若直接拿截断后的值做 `(online_due_at, id) > ($3, $4)` 行比较，
 * 游标那一行自己会因为"微秒 > 毫秒"而**反复入选**（`--limit 1` 时等于原地踏步）。两边都截到毫秒
 * 且 `ORDER BY` 用同一个表达式，分页才是严格全序：不漏行、不重复行。
 * 为什么不用 `OFFSET`：`deletion_requests` 在 `online_due_at` 上没有索引（`0003_privacy_consent.sql:162-163`
 * 只有 `receipt_hash` 唯一索引），顺序靠排序而不是索引序；`OFFSET` 又表达不了"从哪一行之后"，
 * 中途插入新到期行会整体错位。keyset 用行值比较，插入新行不影响已推进的位置。
 *
 * ## 证据落库与回执（迁移 0031 / GY-R32 片B）
 * 本文件此前如实登记过一个未取得项：在线域的"每个成功行写证据"**没有落地列**，证据只以
 * `sha256:` 摘要进命令报告 stdout。迁移 0031（`0031_online_purge_evidence.sql`）补上了这一层：
 *   - `public.deletion_requests.online_purge_evidence`（append-only jsonb 数组）+ `online_purged_at`；
 *   - 唯一写路径 `public.record_online_purge_evidence(...)`（SECURITY DEFINER，触发器钉死只可追加）；
 *   - 唯一读路径 `public.read_online_purge_evidence(uuid, uuid)`（按主体过滤的窄口径只读函数）。
 * 运行时角色对 `deletion_requests` **仍然零表级零列级权限**（90-assert 的 protected_columns 与
 * 第 48 项逐字不动），只多这两个函数的 EXECUTE。读路径见
 * `services/api/src/privacy/online-state-derivation.ts`：用落库的 `removed/idempotency` 复算
 * `sha256:` 摘要，按「到期 + 四域证据齐备 ⇒ completed；未到期 ⇒ pending；到期未清 ⇒ blocked」推导。
 *
 * 本驱动只负责**写**：`evidence` 端口缺省不注入 ⇒ 逐字保持"只进报告"的旧行为（旧装配/单测零改动）；
 * 注入后每个成功行必须先落库、再进报告 —— 落库失败时该行记 `EVIDENCE_WRITE_FAILED` 失败
 * （删除已经发生，但这行没有凭据；⛔ 不把"写不进去"当成功）。
 *
 * ## 需要的数据库角色
 * 候选查询要读 `deletion_requests`，而运行时角色 `gengyun_api_runtime` 对该表**零表级零列级**权限
 * （`90-assert` 第 48 项），必然 `42501`。因此本命令用 `DATABASE_URL`（属主/运维角色，与 `db:migrate`
 * 同源口径）；证据写入则走 0031 的唯一写函数（属主默认可执行，运行时角色亦有 EXECUTE）——
 * 两条路径都**不需要**给运行时角色补任何表/列权限。
 */
import { createHash } from 'node:crypto';

import { SAFE_ERROR_CODES } from '../../../../packages/privacy/deletion.mjs';
import { USER_DATA_DELETION_MODULES } from './user-data-deletion.ts';

/** 每批最多处理多少个**请求**（不是模块行：一次请求的四域必须一起看，见 `runOnlinePurgeBatch`）。 */
export const DEFAULT_ONLINE_PURGE_BATCH_LIMIT = 200;
/** 硬上限：超顶**报错**而不是夹取（夹取会让"我设了 10000"静默变成 5000）。 */
export const MAX_ONLINE_PURGE_BATCH_LIMIT = 5000;

/**
 * 单轮最多推进几页（每页 `--limit` 个请求）⇒ 单轮上限 = `limit × maxBatches`。
 *
 * 它**只是运行时预算**，不是进度保证：进度由游标负责（超预算的那部分留给下一轮，从游标之后继续）。
 * 默认 5（limit=200 ⇒ 一轮最多 1000 个请求）够把一次"批量注销"在几分钟内追平，又不至于让一次
 * cron 跑成小时级长事务。
 */
export const DEFAULT_ONLINE_PURGE_MAX_BATCHES = 5;
/** 硬上限：同上，超顶**报错**而不是夹取。 */
export const MAX_ONLINE_PURGE_MAX_BATCHES = 200;

/** 本驱动产出证据的域分隔前缀（与副本侧的 `gengyun/backup-purge/v1` 各自独立、互不冒充）。 */
export const ONLINE_PURGE_EVIDENCE_VERSION = 'gengyun/online-purge/v1';

/** 跳过原因（`processed = succeeded + skipped + failed` 的第三项来源）。 */
export const ONLINE_PURGE_SKIP_REASONS = {
  /** 未到期（闭区间：`online_due_at === cutoff` 算到期）。 */
  NOT_DUE: 'not_due',
  /** 到期但该主体在线行已经没有了（重复跑的正常结论：0 行、0 副作用）。 */
  ALREADY_PURGED: 'already_purged',
  /** `--dry-run`：只列不删。 */
  DRY_RUN: 'dry_run',
} as const;

/** 驱动自身折叠出来的失败码（除此之外一律沿用模块抛出的 `SAFE_ERROR_CODES` 内码）。 */
export const ONLINE_PURGE_DRIVER_ERROR_CODES = {
  /** 端口抛错且错误码不在安全码集合内（原文不进报告，防止把连接串/主机名带出去）。 */
  DRIVER_EXCEPTION: 'DRIVER_EXCEPTION',
  /** 端口没给出这个模块的结果 —— 缺结果不是"清过了"。 */
  RESULT_MISSING: 'RESULT_MISSING',
  /** 返回值形状非法（负数/非整数/NaN）。 */
  RESULT_INVALID: 'RESULT_INVALID',
  /**
   * 删除成功但**证据没落库**（迁移 0031 的唯一写路径失败）。
   *
   * 为什么算失败而不是"下次再写"：证据是"这一行清过了"的唯一凭据；写不进去就等于本次没有凭据。
   * 这一行记 failed ⇒ 退出码 1 把人叫来；⛔ 不把它折成 succeeded（那会让回执永远推导不出 completed
   * 却看不出原因）。
   */
  EVIDENCE_WRITE_FAILED: 'EVIDENCE_WRITE_FAILED',
} as const;

/** 只用到 `query` 的最小 SQL 客户端形状（不把 pg 的完整类型灌进主域）。 */
export interface OnlinePurgeSqlClient {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** 一个到期候选请求（`userId` 只在本进程内流转，⛔ 不打进报告）。 */
export interface OnlinePurgeCandidate {
  requestId: string;
  userId: string;
  onlineDueAt: Date | string;
}

/**
 * 到期候选 SQL（**闭区间**：`online_due_at <= cutoff` 即到期，与
 * `services/api/src/privacy/deletion-aging.ts` 的 `nowMs >= dueMs` 同口径）。
 *
 * `state <> 'completed'`：已完结的请求不再处理（它的在线行已清、回执已 completed）。
 * 不排除 `blocked`：`blocked` 可能只因**备份侧**卡住，在线侧照样到期该清 ——
 * 排除它会造出"备份卡着 ⇒ 在线数据永远不清"的坏组合。
 *
 * `$3`/`$4` 是**跨轮游标**（上一轮处理到的最后一行的 `(online_due_at, id)`）：
 *   - `$3 IS NULL` ⇒ 从队首开始（第一轮，或上一轮已走到队尾）；
 *   - 非空 ⇒ 只取游标之后的到期行，**已经清空但 state 仍非 completed 的队首行不会再被反复选中**
 *     （饿死闭环的关键，见文件头「批次推进」）。
 * `date_trunc('milliseconds', …)` 与 `ORDER BY` 用同一个表达式，见文件头的毫秒口径说明。
 */
export const ONLINE_PURGE_DUE_SQL = `SELECT id, user_id, online_due_at
  FROM public.deletion_requests
  WHERE online_due_at <= $1::timestamptz
    AND state <> 'completed'
    AND (
      $3::timestamptz IS NULL
      OR (date_trunc('milliseconds', online_due_at), id) > ($3::timestamptz, $4::uuid)
    )
  ORDER BY date_trunc('milliseconds', online_due_at), id
  LIMIT $2::integer`;

/** 到期总数（不受 `--limit` 影响；报告里的 `totalDue` 用它，运维才看得出"还剩多少"）。 */
export const ONLINE_PURGE_DUE_COUNT_SQL = `SELECT count(*)::integer AS total
  FROM public.deletion_requests
  WHERE online_due_at <= $1::timestamptz
    AND state <> 'completed'`;

// 小数秒允许 1–6 位：库里 `timestamptz` 是微秒精度，手写的游标文件/外部调用可能带微秒。
// 超过 3 位的部分一律**截断**（`Date.parse` 本身就是截断），与 SQL 里的 `date_trunc('milliseconds', …)`
// 同值 —— 这样"归一后回写"的游标不会因为同一行微秒不同而反复入选。
const STRICT_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * 时刻解析：只接受 `Date`、有限数（毫秒）与**带时区**的 ISO-8601。
 *
 * 裸本地时间（`2026-10-21T00:00:00`）一律拒绝：cron 跑在东八区、库钟是 UTC 时，
 * 把裸时间当本地时间会整体偏 8 小时（7 日到期早清或少清一整天）。
 */
function instantMs(value: unknown): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && STRICT_INSTANT_RE.test(value)) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/** 批量上限归一：非法/超顶**抛** `RangeError`（不夹取、不默认）。 */
export function normalizeOnlinePurgeLimit(value: unknown): number {
  const raw = typeof value === 'string' ? value.trim() : value;
  if (typeof raw === 'string' && !/^\d+$/.test(raw)) {
    throw new RangeError('批量上限必须是正整数');
  }
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new RangeError('批量上限必须是正整数');
  }
  if (parsed > MAX_ONLINE_PURGE_BATCH_LIMIT) {
    throw new RangeError(`批量上限超过硬顶 ${MAX_ONLINE_PURGE_BATCH_LIMIT}`);
  }
  return parsed;
}

/** 单轮最多推进批数归一：非法/超顶**抛** `RangeError`（与 `--limit` 同一套"不夹取"口径）。 */
export function normalizeOnlinePurgeMaxBatches(value: unknown): number {
  const raw = typeof value === 'string' ? value.trim() : value;
  if (typeof raw === 'string' && !/^\d+$/.test(raw)) {
    throw new RangeError('单轮最多推进批数必须是正整数');
  }
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new RangeError('单轮最多推进批数必须是正整数');
  }
  if (parsed > MAX_ONLINE_PURGE_MAX_BATCHES) {
    throw new RangeError(`单轮最多推进批数超过硬顶 ${MAX_ONLINE_PURGE_MAX_BATCHES}`);
  }
  return parsed;
}

/**
 * **跨轮游标**：上一轮处理到的最后一行（`(online_due_at, id)` 的行值）。
 *
 * 只含两个字段，都是**非个人数据**：到期时刻（日历事实）与注销请求 id（回执里本来就有）。
 * ⛔ 不含 `user_id`、不含任何正文/标题/凭据 —— 它会被写进运维机的游标文件。
 */
export interface OnlinePurgeCursor {
  /** `online_due_at`（**毫秒**口径的带时区 ISO-8601；见文件头"为什么键里带 date_trunc"）。 */
  afterDueAt: string;
  /** 该行的 `deletion_requests.id`（UUID）。 */
  afterRequestId: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 游标归一：`null`/缺省 ⇒ `null`（从队首）；形状不对 ⇒ **抛** `TypeError`（不猜、不顺从地"从队首重来"）。
 *
 * 为什么非法游标必须抛而不是静默忽略：静默忽略等于偷偷把进度清零 —— 又会回到"每轮撞队首"的
 * 饿死老路，而且外面看不出来。CLI 把 `TypeError` 折成「游标文件不可用，本轮从队首重扫」并打到
 * stderr（见 `tools/purge-expired-online-data.mjs`），异常不会静默。
 */
export function normalizeOnlinePurgeCursor(value: unknown): OnlinePurgeCursor | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') {
    throw new TypeError('在线清除游标必须是 { afterDueAt, afterRequestId } 或 null');
  }
  const record = value as Record<string, unknown>;
  const dueMs = instantMs(record['afterDueAt']);
  if (dueMs === null) {
    throw new TypeError('在线清除游标的 afterDueAt 必须是 Date／带时区的 ISO-8601（不接受裸本地时间）');
  }
  const id = typeof record['afterRequestId'] === 'string' ? record['afterRequestId'].trim() : '';
  if (!UUID_RE.test(id)) {
    throw new TypeError('在线清除游标的 afterRequestId 必须是 UUID');
  }
  // 归一成毫秒口径 ISO：与 SQL 里的 `date_trunc('milliseconds', …)` 严格同值，分页才是全序。
  return { afterDueAt: new Date(dueMs).toISOString(), afterRequestId: id.toLowerCase() };
}

/** 一个候选在**游标**里的形状（`runOnlinePurgeBatch` 处理完这一行后，游标就停在这里）。 */
export function cursorAfterCandidate(candidate: OnlinePurgeCandidate): OnlinePurgeCursor {
  return normalizeOnlinePurgeCursor({
    afterDueAt: candidate.onlineDueAt,
    afterRequestId: candidate.requestId,
  }) as OnlinePurgeCursor;
}

/** 安全错误码折叠：不在 `SAFE_ERROR_CODES` 内的一律换成 `DRIVER_EXCEPTION`（原文不进报告）。 */
export function sanitizeOnlinePurgeErrorCode(code: unknown): string {
  const text = typeof code === 'string' ? code.trim() : '';
  return (SAFE_ERROR_CODES as readonly string[]).includes(text)
    ? text
    : (ONLINE_PURGE_DRIVER_ERROR_CODES.DRIVER_EXCEPTION as string);
}

/**
 * 一个 (request, module) 成功行的证据摘要。
 *
 * 口径与副本侧 `purgeEvidenceRef()` 同构（sha256、固定域前缀、`\0` 分隔、字段有序）：
 * 证据只由"清了谁、清了哪个域、清了多少行"决定，**不含任何正文/标题/身份信息**。
 */
export function onlinePurgeEvidenceRef(input: {
  requestId: string;
  module: string;
  removed: number;
  idempotency: number;
}): string {
  const material = [
    ONLINE_PURGE_EVIDENCE_VERSION,
    input.requestId,
    input.module,
    String(input.removed),
    String(input.idempotency),
  ].join('\0');
  return `sha256:${createHash('sha256').update(material).digest('hex')}`;
}

/** 单模块清除端口：抛错即该 (request, module) 失败，其余模块照跑（失败不阻塞）。 */
export interface OnlinePurgePort {
  purgeModule(input: {
    requestId: string;
    userId: string;
    module: string;
  }): Promise<{ removed: number; idempotency: number }>;
}

/**
 * 证据落库端口（迁移 0031 的唯一写路径的结构化形状）。
 *
 * 驱动只依赖这个形状、不 import `online-purge-evidence.ts`：
 *   - 生产实现 `createPostgresOnlinePurgeEvidenceRecorder()` 调
 *     `public.record_online_purge_evidence(...)`（SECURITY DEFINER）；
 *   - 单测注入内存替身，断言"每个成功行恰好写一次、失败行不写"。
 *
 * 抛错语义：这一行的证据没落库 ⇒ 驱动把它记 `EVIDENCE_WRITE_FAILED` 失败行（不吞、不谎称成功）。
 */
export interface OnlinePurgeEvidenceSink {
  record(input: {
    requestId: string;
    module: string;
    removed: number;
    idempotency: number;
    /** 本轮**唯一** cutoff（驱动不各自读时钟：证据时刻必须与到期判定同源）。 */
    purgedAt: Date | string;
  }): Promise<void>;
  /**
   * **只补不覆盖**的可选能力：该域已经有证据 ⇒ `already-present`（一条都不写）；
   * 没有证据 ⇒ 补写一条「本轮实测为空」的证据（`removed`/`idempotency` 用本轮读数、时刻用本轮 cutoff）。
   *
   * 为什么需要它（监工 1023 [P2]）：首轮「删除成功 + 证据写失败」之后，真实存储已经空了，
   * 第二轮四域读数全 0 会被 `already_purged` 分支**在写证据之前**跳过 ⇒ 证据永远补不回来、
   * 回执在线态永远 blocked。补写的这一条是**当前事实**（本轮实测 0 行），
   * ⛔ 不回填首轮的删除行数或原始时刻（那没有凭据），⛔ 也不把"补上凭据"说成"当初删了 N 行"。
   *
   * 缺省（不实现）⇒ 驱动保持旧行为：`already_purged` 且不写证据。
   */
  recordVerifiedEmpty?(input: {
    requestId: string;
    module: string;
    /** 读函数按 (request_id, user_id) 过滤 ⇒ 补写前必须知道主体，否则读不到该行。 */
    userId: string;
    removed: number;
    idempotency: number;
    purgedAt: Date | string;
  }): Promise<'recorded' | 'already-present'>;
}

export interface OnlinePurgeEvidenceRow {
  requestId: string;
  module: string;
  removed: number;
  idempotency: number;
  evidenceRef: string;
}

export interface OnlinePurgeFailureRow {
  requestId: string;
  module: string;
  errorCode: string;
  reason: string;
}

export interface OnlinePurgeRunInput {
  /** 唯一时钟读数（`SELECT now()`）；候选筛选、到期复核、证据都不各自读时钟。 */
  cutoff: Date | string | number;
  limit: number;
  requests: readonly OnlinePurgeCandidate[];
  totalDue: number;
  dryRun: boolean;
  purge: OnlinePurgePort;
  /**
   * 证据落库端口（迁移 0031）。缺省 ⇒ 证据只进报告（既有装配/单测逐字兼容）；
   * 接线后**每个成功 (request, module) 行都写一条**，写失败的行记 `EVIDENCE_WRITE_FAILED` 失败。
   */
  evidence?: OnlinePurgeEvidenceSink;
  /** 必需模块闭集；缺省用 `USER_DATA_DELETION_MODULES`（四域）。 */
  modules?: readonly string[];
}

export interface OnlinePurgeRunReport {
  cutoff: string;
  limit: number;
  dryRun: boolean;
  candidates: number;
  totalDue: number;
  processed: number;
  succeeded: number;
  skipped: number;
  failed: number;
  rowsPurged: number;
  idempotencyPurged: number;
  remaining: number;
  /** 每个成功行的证据（`sha256:…`）。 */
  evidence: OnlinePurgeEvidenceRow[];
  failures: OnlinePurgeFailureRow[];
  skipReasons: Record<string, number>;
}

/**
 * 取到期候选（一次 SQL；`totalDue` 另用一条 count，避免"被 limit 截断后看不出还剩多少"）。
 *
 * `after` 是**跨轮游标**：`null`/缺省 ⇒ 队首；否则只取该行之后的到期行（见 `ONLINE_PURGE_DUE_SQL`）。
 * 游标形状不对**抛** `TypeError`，不会静默退化成"从队首重来"。
 */
export async function listDueOnlineDeletions(
  client: OnlinePurgeSqlClient,
  input: { cutoff: Date | string | number; limit: number; after?: OnlinePurgeCursor | null },
): Promise<{ requests: OnlinePurgeCandidate[]; totalDue: number }> {
  const cutoffMs = instantMs(input.cutoff);
  if (cutoffMs === null) {
    throw new TypeError('在线到期清除的 cutoff 必须是 Date／带时区的 ISO-8601 字符串；不接受裸本地时间');
  }
  const limit = normalizeOnlinePurgeLimit(input.limit);
  const after = normalizeOnlinePurgeCursor(input.after ?? null);
  const cutoffIso = new Date(cutoffMs).toISOString();
  const [rows, total] = await Promise.all([
    client.query(ONLINE_PURGE_DUE_SQL, [cutoffIso, limit, after?.afterDueAt ?? null, after?.afterRequestId ?? null]),
    client.query(ONLINE_PURGE_DUE_COUNT_SQL, [cutoffIso]),
  ]);
  const requests = rows.rows.map((row) => {
    // ⚠️ 不要 `String(row.online_due_at)`：`pg` 对 `timestamptz` 返回的是 **Date**，
    // `String(Date)` 会得到 `Wed Apr 01 2026 …` 这种非 ISO 文本，随后被判成「到期时刻不可解析」。
    const raw = row['online_due_at'];
    return {
      requestId: String(row['id']),
      userId: String(row['user_id']),
      onlineDueAt: raw instanceof Date ? raw : String(raw),
    };
  });
  const totalDue = Number(total.rows[0]?.['total'] ?? requests.length);
  return { requests, totalDue: Number.isSafeInteger(totalDue) ? totalDue : requests.length };
}

/**
 * 跑一批（**同步遍历、逐行隔离**）。
 *
 * `processed` 计的是**请求数**：一个请求的四域要么一起看（首轮），要么一起判"已经清过"；
 * 把模块当批量单位会让"同一请求只清了一半就撞上 limit"，下一轮又要重新定位主体。
 */
export async function runOnlinePurgeBatch(input: OnlinePurgeRunInput): Promise<OnlinePurgeRunReport> {
  const cutoffMs = instantMs(input.cutoff);
  if (cutoffMs === null) {
    throw new TypeError('在线到期清除的 cutoff 必须是 Date／带时区的 ISO-8601 字符串；不接受裸本地时间');
  }
  const cutoffIso = new Date(cutoffMs).toISOString();
  const limit = normalizeOnlinePurgeLimit(input.limit);
  const modules = [...(input.modules ?? USER_DATA_DELETION_MODULES)];
  if (modules.length === 0) {
    // 空闭集会让"每个成功行写证据"变成"什么都没清也算干净"，直接拒绝跑。
    throw new RangeError('必需模块闭集不能为空');
  }

  const report: OnlinePurgeRunReport = {
    cutoff: cutoffIso,
    limit,
    dryRun: input.dryRun === true,
    candidates: input.requests.length,
    totalDue: Number.isSafeInteger(input.totalDue) ? input.totalDue : input.requests.length,
    processed: 0,
    succeeded: 0,
    skipped: 0,
    failed: 0,
    rowsPurged: 0,
    idempotencyPurged: 0,
    remaining: 0,
    evidence: [],
    failures: [],
    skipReasons: {},
  };

  const skip = (reason: string): void => {
    report.skipped += 1;
    report.skipReasons[reason] = (report.skipReasons[reason] ?? 0) + 1;
  };

  for (const candidate of input.requests) {
    if (report.processed >= limit) break;
    report.processed += 1;

    // 到期复核（SQL 已筛过一遍；这里再判一次，让"未到期绝不清"在**驱动**这一层也成立，
    // 而不是只依赖候选查询写对）。闭区间：`due === cutoff` 算到期。
    const dueMs = instantMs(candidate.onlineDueAt);
    if (dueMs === null) {
      // 到期时刻不可解析 ⇒ 不猜（既不清，也不当成已完成）。
      report.failed += 1;
      for (const module of modules) {
        report.failures.push({
          requestId: candidate.requestId,
          module,
          errorCode: ONLINE_PURGE_DRIVER_ERROR_CODES.RESULT_INVALID as string,
          reason: '到期时刻不可解析',
        });
      }
      continue;
    }
    if (dueMs > cutoffMs) {
      skip(ONLINE_PURGE_SKIP_REASONS.NOT_DUE);
      continue;
    }
    if (report.dryRun) {
      skip(ONLINE_PURGE_SKIP_REASONS.DRY_RUN);
      continue;
    }

    let rowsThisRequest = 0;
    let idempotencyThisRequest = 0;
    let failureThisRequest = 0;
    // 先攒着：请求级结论出来后才决定这批证据要不要进报告。
    // 「四域都 0 行」= 这个主体已经清过（不是本次清过）⇒ 证据一行都不留，⛔ 不谎称本次干了活。
    const evidenceThisRequest: OnlinePurgeEvidenceRow[] = [];
    for (const module of modules) {
      try {
        const outcome = await input.purge.purgeModule({
          requestId: candidate.requestId,
          userId: candidate.userId,
          module,
        });
        const removed = outcome?.removed;
        const idempotency = outcome?.idempotency ?? 0;
        if (
          !Number.isSafeInteger(removed) ||
          (removed as number) < 0 ||
          !Number.isSafeInteger(idempotency) ||
          (idempotency as number) < 0
        ) {
          failureThisRequest += 1;
          report.failures.push({
            requestId: candidate.requestId,
            module,
            errorCode: ONLINE_PURGE_DRIVER_ERROR_CODES.RESULT_INVALID as string,
            reason: '清除结果形状非法（须为非负整数）',
          });
          continue;
        }
        rowsThisRequest += removed as number;
        idempotencyThisRequest += idempotency as number;
        evidenceThisRequest.push({
          requestId: candidate.requestId,
          module,
          removed: removed as number,
          idempotency: idempotency as number,
          evidenceRef: onlinePurgeEvidenceRef({
            requestId: candidate.requestId,
            module,
            removed: removed as number,
            idempotency: idempotency as number,
          }),
        });
      } catch (error) {
        // 一行失败只影响这一行：同请求其余模块与后续请求继续（⛔ 不 break、不整批中止）。
        failureThisRequest += 1;
        const code = (error as { code?: unknown } | null)?.code;
        report.failures.push({
          requestId: candidate.requestId,
          module,
          errorCode: sanitizeOnlinePurgeErrorCode(code),
          reason: '该模块清除失败（其余模块与后续请求不受影响）',
        });
      }
    }

    // 请求级结论先定：四域全 0 行且无失败 = 这个主体本轮**没有行可清**（多半已经清过）。
    // 旧口径：记 skipped、**一条证据都不写**（⛔ 不谎称本次干了活；重跑第二轮的读数就在这里）。
    //
    // 监工 1023 [P2] 补口：首轮「删除成功 + 证据写失败」之后，真实存储已经空了 —— 若这里无脑跳过，
    // 证据永远补不回来（第二轮开始在写证据之前就被跳掉），在线态永久 blocked。
    // 因此当端口声明了 `recordVerifiedEmpty` 时，**只对缺证据的域**补写一条「本轮实测为空」的证据：
    //   · `removed`/`idempotency` = **本轮**真实读数（全 0），时刻 = 本轮 cutoff；
    //   · ⛔ 不伪造首轮的删除行数，也不回填首轮时刻（那没有凭据）；
    //   · 已有证据 ⇒ `already-present`，一条不写 ⇒ 既有「全 0 不写证据」口径逐字不变；
    //   · ⛔ 不因此判 completed（completed 只由落库证据在推导层给出）。
    if (failureThisRequest === 0 && rowsThisRequest === 0 && idempotencyThisRequest === 0) {
      const sink = input.evidence;
      if (sink?.recordVerifiedEmpty !== undefined && evidenceThisRequest.length > 0) {
        let recovered = 0;
        for (const row of evidenceThisRequest) {
          try {
            const outcome = await sink.recordVerifiedEmpty({
              requestId: row.requestId,
              module: row.module,
              userId: candidate.userId,
              removed: row.removed,
              idempotency: row.idempotency,
              purgedAt: cutoffIso,
            });
            if (outcome === 'recorded') {
              report.evidence.push(row);
              recovered += 1;
            }
          } catch {
            // 补不进凭据 ⇒ 如实记失败行（回执不得据此判 completed），同请求其余行不阻塞。
            failureThisRequest += 1;
            report.failures.push({
              requestId: row.requestId,
              module: row.module,
              errorCode: ONLINE_PURGE_DRIVER_ERROR_CODES.EVIDENCE_WRITE_FAILED as string,
              reason: '证据补写失败：本轮实测为空但凭据补不进台账（回执不会据此判 completed）',
            });
          }
        }
        if (recovered > 0 && failureThisRequest === 0) {
          // 补上了凭据 ⇒ 这个请求本轮**收口**（0 行可清、在线证据齐），不计 already_purged。
          report.succeeded += 1;
          continue;
        }
        if (failureThisRequest > 0) {
          report.failed += 1;
          continue;
        }
      }
      skip(ONLINE_PURGE_SKIP_REASONS.ALREADY_PURGED);
      continue;
    }

    // 证据落库（每个成功行一条）。放在这里而不是循环体内：先要知道"这一请求到底有没有干活"，
    // 否则 already_purged 也会写 0 行证据（把"没干"记成"干了 0 行"）。
    // 落库失败 ⇒ 该 (request,module) 从证据里剔除并记 failed（删除已发生但没有凭据 ⇒ 回执不得据此
    // 判 completed），同请求其余行与后续请求**不阻塞**（与模块抛错同一套逐行隔离）。
    if (input.evidence !== undefined) {
      const recorded: OnlinePurgeEvidenceRow[] = [];
      for (const row of evidenceThisRequest) {
        try {
          await input.evidence.record({
            requestId: row.requestId,
            module: row.module,
            removed: row.removed,
            idempotency: row.idempotency,
            purgedAt: cutoffIso,
          });
          recorded.push(row);
        } catch {
          failureThisRequest += 1;
          report.failures.push({
            requestId: row.requestId,
            module: row.module,
            errorCode: ONLINE_PURGE_DRIVER_ERROR_CODES.EVIDENCE_WRITE_FAILED as string,
            reason: '证据落库失败：删除已发生但无凭据（回执不会据此判 completed）',
          });
        }
      }
      evidenceThisRequest.length = 0;
      evidenceThisRequest.push(...recorded);
    }

    if (failureThisRequest > 0) {
      report.failed += 1;
      // 失败请求的"已成功模块"证据照样保留（这就是"每个成功行写证据"）；
      // 只把整请求记为 failed，让退出码把它顶出来给运维看。
      report.evidence.push(...evidenceThisRequest);
      report.rowsPurged += rowsThisRequest;
      report.idempotencyPurged += idempotencyThisRequest;
      continue;
    }
    report.evidence.push(...evidenceThisRequest);
    report.succeeded += 1;
    report.rowsPurged += rowsThisRequest;
    report.idempotencyPurged += idempotencyThisRequest;
  }

  report.remaining = Math.max(0, report.totalDue - report.processed);
  return report;
}

/** 一轮里的**一页**读数（逐页留痕：运维看得出"这一轮到底推进到哪"）。 */
export interface OnlinePurgeDrainPage {
  /** 本页从哪个游标开始（`null` = 队首）。 */
  after: OnlinePurgeCursor | null;
  candidates: number;
  processed: number;
  succeeded: number;
  skipped: number;
  failed: number;
  /** 本页结束后的游标（页内最后一条**处理过**的行；`null` = 已到队尾）。 */
  nextAfter: OnlinePurgeCursor | null;
}

export interface OnlinePurgeDrainInput {
  /** 唯一时钟读数：一轮里所有页共用同一个 cutoff（⛔ 不逐页重新读钟，否则"到期"会在轮内漂移）。 */
  cutoff: Date | string | number;
  limit: number;
  /** 单轮最多推进几页；缺省 `DEFAULT_ONLINE_PURGE_MAX_BATCHES`。 */
  maxBatches?: number;
  dryRun: boolean;
  purge: OnlinePurgePort;
  /** 证据落库端口（与 `runOnlinePurgeBatch` 同一个；缺省 ⇒ 只进报告）。 */
  evidence?: OnlinePurgeEvidenceSink;
  modules?: readonly string[];
  /** 上一轮的游标（`null`/缺省 ⇒ 从队首）。 */
  after?: OnlinePurgeCursor | null;
  /** 取一页候选（生产传 `(input) => listDueOnlineDeletions(client, input)`，单测可注入假页）。 */
  fetchPage(pageInput: {
    cutoff: string;
    limit: number;
    after: OnlinePurgeCursor | null;
  }): Promise<{ requests: readonly OnlinePurgeCandidate[]; totalDue: number }>;
}

export interface OnlinePurgeDrainReport extends OnlinePurgeRunReport {
  /** 本轮实际跑了几页。 */
  batches: number;
  /** 是否走到了队尾（`true` ⇒ 下一轮从队首重扫，即"一整轮"跑完）。 */
  drained: boolean;
  /** 下一轮该从哪一行之后继续（`null` = 队首，与 `drained: true` 同义）。 */
  nextCursor: OnlinePurgeCursor | null;
  pages: OnlinePurgeDrainPage[];
}

/**
 * 推一轮：**从游标之后连续翻页**，把超出 `--limit` 的到期请求也处理掉（[P1] 饿死闭环）。
 *
 * 关键语义（每一条都在 `tests/unit/online-purge-driver.test.mjs` 的 [9] 组里被断言）：
 *   1. 进度只由**游标**表达：每页结束时游标停在"本页最后一条处理过的行"，下一页/下一轮从它之后继续；
 *      ⛔ 不写 `deletion_requests.state` —— 只是"把这一行看过一遍"，不是"整笔完成"。
 *   2. 本页不足 `limit` 条 ⇒ 已到队尾 ⇒ `drained: true`、`nextCursor: null`（下一轮从队首重扫）。
 *      走到队尾时**不额外多查一页空页**（少一次往返，读数也更干净）。
 *   3. 页数用满 `maxBatches` 仍未到队尾 ⇒ `drained: false`，`nextCursor` 停在本轮最后一行 ⇒
 *      下一轮从那里继续（不回到队首，也就不再撞同一批）。
 *   4. 无法推进就**停**（到期时刻不可解析 / 处理 0 条）：宁可不推进也不原地打转。
 *   5. 失败行照样**越过游标**（它已经"被处理过"），下一整轮会被再试 —— 这就是"失败不阻塞批次推进"。
 */
export async function drainDueOnlineDeletions(input: OnlinePurgeDrainInput): Promise<OnlinePurgeDrainReport> {
  const cutoffMs = instantMs(input.cutoff);
  if (cutoffMs === null) {
    throw new TypeError('在线到期清除的 cutoff 必须是 Date／带时区的 ISO-8601 字符串；不接受裸本地时间');
  }
  const cutoffIso = new Date(cutoffMs).toISOString();
  const limit = normalizeOnlinePurgeLimit(input.limit);
  const maxBatches = normalizeOnlinePurgeMaxBatches(input.maxBatches ?? DEFAULT_ONLINE_PURGE_MAX_BATCHES);
  let cursor = normalizeOnlinePurgeCursor(input.after ?? null);

  const merged: OnlinePurgeRunReport = {
    cutoff: cutoffIso,
    limit,
    dryRun: input.dryRun === true,
    candidates: 0,
    totalDue: 0,
    processed: 0,
    succeeded: 0,
    skipped: 0,
    failed: 0,
    rowsPurged: 0,
    idempotencyPurged: 0,
    remaining: 0,
    evidence: [],
    failures: [],
    skipReasons: {},
  };
  const pages: OnlinePurgeDrainPage[] = [];
  let batches = 0;
  let drained = false;
  let nextCursor: OnlinePurgeCursor | null = cursor;

  while (batches < maxBatches) {
    const pageStart = cursor;
    const page = await input.fetchPage({ cutoff: cutoffIso, limit, after: cursor });
    const requests = page.requests ?? [];
    if (requests.length === 0) {
      // 队尾（游标之后没有更多到期行）：清游标 ⇒ 下一轮从队首重扫，也就是"一整轮"结束。
      drained = true;
      nextCursor = null;
      break;
    }

    const report = await runOnlinePurgeBatch({
      cutoff: cutoffIso,
      limit,
      requests,
      totalDue: page.totalDue,
      dryRun: merged.dryRun,
      purge: input.purge,
      ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
      ...(input.modules === undefined ? {} : { modules: input.modules }),
    });
    batches += 1;

    merged.candidates += report.candidates;
    // 取最近一页的读数：并发协调器可能刚把某些请求标成 completed，后读到的更新。
    merged.totalDue = report.totalDue;
    merged.processed += report.processed;
    merged.succeeded += report.succeeded;
    merged.skipped += report.skipped;
    merged.failed += report.failed;
    merged.rowsPurged += report.rowsPurged;
    merged.idempotencyPurged += report.idempotencyPurged;
    for (const [reason, count] of Object.entries(report.skipReasons)) {
      merged.skipReasons[reason] = (merged.skipReasons[reason] ?? 0) + count;
    }
    merged.evidence.push(...report.evidence);
    merged.failures.push(...report.failures);

    // 游标停在本页最后一条**被处理过**的行（`processed === 0` 时不动，走下面的"不推进就停"）。
    const advancedTo = report.processed > 0 ? requests[report.processed - 1] : undefined;
    let pageNext: OnlinePurgeCursor | null = cursor;
    let canAdvance = false;
    // 到期时刻不可解析 ⇒ 这一行做不出可信的游标 ⇒ 本轮不推进（`runOnlinePurgeBatch` 已把它记 failed）。
    if (advancedTo !== undefined && instantMs(advancedTo.onlineDueAt) !== null) {
      pageNext = cursorAfterCandidate(advancedTo);
      canAdvance = true;
    }
    pages.push({
      after: pageStart,
      candidates: report.candidates,
      processed: report.processed,
      succeeded: report.succeeded,
      skipped: report.skipped,
      failed: report.failed,
      nextAfter: requests.length < limit ? null : pageNext,
    });

    if (requests.length < limit) {
      // 本页不足 limit ⇒ 这就是队尾那一页：本轮已走完一轮。
      drained = true;
      nextCursor = null;
      break;
    }
    if (!canAdvance || pageNext === null) break;
    cursor = pageNext;
    nextCursor = pageNext;
  }

  merged.remaining = Math.max(0, merged.totalDue - merged.processed);
  return { ...merged, batches, drained, nextCursor, pages };
}

/** 退出码（cron 的唯一判据）：0 无失败 / 1 有失败行 / 2 由 CLI 的配置错误分支给出。 */
export function onlinePurgeExitCode(report: OnlinePurgeRunReport): 0 | 1 {
  return report.failed > 0 ? 1 : 0;
}

/**
 * 报告文本（**隐私口径**：只出现 `request_id` 与模块名，⛔ 不打 `user_id`、
 * 不打正文/标题/任何主体标识；失败只给固定分类码）。
 *
 * 传入 `drainDueOnlineDeletions` 的报告时多打两行：逐页推进读数 + 下一轮起点（游标）。
 */
export function formatOnlinePurgeReport(report: OnlinePurgeRunReport | OnlinePurgeDrainReport): string[] {
  const lines: string[] = [];
  lines.push(
    `在线到期清除：cutoff=${report.cutoff} limit=${report.limit}${report.dryRun ? '（dry-run：不删）' : ''}`,
  );
  lines.push(
    `候选 ${report.candidates}／到期共 ${report.totalDue}｜处理 ${report.processed} = 成功 ${report.succeeded} + 跳过 ${report.skipped} + 失败 ${report.failed}`,
  );
  lines.push(
    `清除行数 ${report.rowsPurged}（其中幂等台账 ${report.idempotencyPurged}）｜本轮之后仍到期 ${report.remaining}`,
  );
  const drained = report as Partial<OnlinePurgeDrainReport>;
  if (typeof drained.batches === 'number') {
    const perPage = (drained.pages ?? []).map((page) => page.processed).join('→');
    lines.push(
      `批次 ${drained.batches}${perPage === '' ? '' : `（逐页处理 ${perPage}）`}｜${drained.drained === true ? '已到队尾：下一轮从队首重扫' : `未完：下一轮从 request=${drained.nextCursor?.afterRequestId ?? '?'} 之后继续`}`,
    );
  }
  const skipEntries = Object.entries(report.skipReasons);
  if (skipEntries.length === 0) {
    lines.push('跳过原因：无');
  } else {
    lines.push(
      `跳过原因：${skipEntries
        .map(([reason, count]) => `${reason}=${count}`)
        .join(' ')
        .trim()}`,
    );
  }
  for (const row of report.evidence) {
    lines.push(
      `  证据 request=${row.requestId} module=${row.module} removed=${row.removed} idempotency=${row.idempotency} ${row.evidenceRef}`,
    );
  }
  for (const row of report.failures) {
    lines.push(`  失败 request=${row.requestId} module=${row.module} code=${row.errorCode}｜${row.reason}`);
  }
  return lines;
}
