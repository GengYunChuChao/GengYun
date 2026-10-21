/**
 * GY-I19（#19）· 备份副本「在线 7 日／备份 30 日」里**缺的那个执行者**（缺口 G9 / P0-4）。
 *
 * ## 要解决的问题（`docs/verification/gy-i16-i17-deletion-cascade-20261021.md` §4.1 三段断点）
 * 1. 无调度：清除端口只有两个调用方——受理事务 + 处理器；GET 回执不执行处理器。
 * 2. 再受理被确定性拒绝：`request_account_deletion` 对 `state='deletion_pending'` 抛
 *    `G0003`（`0016_account_deletion_persistence.sql:112-114`）⇒ 想靠「再发一次注销」触发到期清除，
 *    在生产 PG 上**必然失败**。
 * 3. 即便调得动，也需要一个不经过受理的入口。
 *
 * 本模块就是第 3 段：**一个可被运维重复调用的到期扫描 + 逐组清除驱动**。
 * 它不建表、不改迁移、不改 `BACKUP_COPY_SCOPES` 闭集（消息域纳入是另一片 C1b），
 * 只复用既有端口 `createPostgresBackupPurgePort()`（`backup-copies-pg.ts:183-189`）。
 *
 * ## 为什么是「运维命令」而不是进程内定时器／内部维护端点
 * - 本仓**没有**进程级调度基础设施；`setInterval` 常驻定时器会与 CI/真库测试抢同一批行，
 *   且进程重启即失去语义（`services/api/src` 至今零 `setInterval`，见勘察 §9 第 8 条）。
 * - 内部 HTTP 端点要求服务在线 + `requireAdmin` + 一套新 scope 的审计，且 `real` 模式的注销面
 *   当前整域 503（G10）——把库级维护动作挂在用户面服务上只会多一层失败点。
 * - 运维命令可被**外部 cron**（系统 cron / systemd timer / 云定时任务）驱动，不改
 *   `.github/workflows/**`（本片红线），也不引入新的常驻进程。
 *
 * ## 三条硬不变量（逐条对应单测）
 * 1. **未到期不清**：SQL 侧先只在到期行上找候选三元组（走部分索引），再回到该三元组的**全部未清行**
 *    上聚合，`HAVING max(retention_until) <= cutoff` 才真的是「整组都到期」
 *    （朴素写法 `WHERE 到期 + HAVING max(...)` 会让未到期行不参与分组、守卫退化成空操作——
 *    真库臂实测踩到过；部分到期的组单独计数上报、只上报不处理，见
 *    `BACKUP_COPY_MIXED_GROUPS_SQL`）；runner 侧**再复核一次** `retentionUntil <= cutoff`
 *    （`not_due` 跳过），双保险，且边界取**闭区间**（相等即到期，与
 *    `packages/privacy/backup-retention.mjs:219` 的 `nowMs >= untilMs` 同口径）。
 * 2. **失败不阻塞**：单组失败只让该组落 `failed`（端口自己写 `last_error_code` +
 *    `purge_attempts+1`），循环继续处理后面的组；端口抛错也只记该组 `DRIVER_EXCEPTION`。
 * 3. **幂等**：成功组的行变成 `state='purged'`，下次枚举（`state <> 'purged'`）就取不到 ⇒
 *    第二次运行 0 组、0 行；重跑不改写 `purged_at`、不累加 `purge_attempts`（既有端口行为）。
 *
 * ## 单个「组」是什么
 * 一组 = `(request_id, user_id, module)`：端口 `purge()` 的入参就是这个三元组，它一次清掉该三元组
 * 下**所有**到期的 scope 行（`backup-copies-pg.ts:74-82` 的 `UPDATE` 不带 scope 条件）。
 * 因此驱动的批次上限、成功/跳过/失败计数，都以**组**为单位；另单列「清了多少行」。
 *
 * ## `failed` 行为什么默认跳过
 * 端口对含 `failed` 行的三元组明确返回 `blocked`/`STORE_REJECTED`（「需显式重排」，
 * `backup-copies-pg.ts:283-285`）——重试不会自愈。所以默认把这类组计入「跳过」并在摘要里报
 * `failed_needs_requeue`，由运维显式加 `--retry-failed` 重排（`requeueFailedBackupCopyGroup`，
 * 只把 `retention_until <= cutoff` 的 `failed` 行改回 `pending_purge`，保留 `last_error_code`
 * 与 `purge_attempts` 作为上一轮失败的留痕）。
 *
 * ## 权限口径（⛔ 本片不加任何授权）
 * 运行时角色 `gengyun_api_runtime` 对 `user_backup_copies` 有的是**列级**权限
 * （`services/api/src/db/roles/auth_privacy.sql:59-66`、`deploy/postgres-cvm/sql/20-login-roles.sql`
 * 的 `gy-i19-backup-copies-grant` 区域）。本模块用到的列全在授权清单内：
 * 读 `request_id/user_id/module/state/retention_until`，写 `state/updated_at`。
 * 因此 `20-login-roles.sql`、`allow_table_dml`、`expected(tbl,…,del)` 三处**一处都不用改**
 * （真库集成用例 `tests/integration/backup-copies-purge-pg.mjs` 用运行时角色实测）。
 *
 * ## 时钟
 * `cutoff` 由调用方**只取一次**（运维命令用 `SELECT now()`），并原样传给端口作为 `now()`
 * （见 `tools/purge-expired-backup-copies.mjs`）：枚举与清除用同一个时刻，避免「枚举按库时钟到期、
 * 端口按应用时钟未到期」的两个时钟打架。本模块自身不读系统时钟。
 */
import type { BackupPurgeInput, BackupPurgeResult } from './user-data-deletion.ts';

/** 一次运行默认最多处理的组数（防一次运维命令把库扫穿）。 */
export const DEFAULT_BACKUP_PURGE_BATCH_LIMIT = 200;

/** 批次上限的硬顶（再大就不是「批」了，改分批跑）。 */
export const MAX_BACKUP_PURGE_BATCH_LIMIT = 5000;

/**
 * 跳过原因码（稳定、可断言、不含任何个人数据）。
 *
 * - `not_due`：runner 复核发现组内最晚的 `retention_until` 仍在 cutoff 之后 ⇒ 不清（兜底）；
 * - `failed_needs_requeue`：组内有 `failed` 行，端口不会自愈，需显式 `--retry-failed`；
 * - `dry_run`：`--dry-run`（只列不清）；
 * - `waiting_retention`：端口复核后仍返回 `waiting`（时钟/写入错位的安全面，绝不当成功）。
 */
export const BACKUP_PURGE_DRIVER_SKIP_REASONS = Object.freeze({
  NOT_DUE: 'not_due',
  FAILED_NEEDS_REQUEUE: 'failed_needs_requeue',
  DRY_RUN: 'dry_run',
  WAITING_RETENTION: 'waiting_retention',
});

/**
 * 驱动**自用**的失败码（只出现在运维命令输出里，⛔ 不进契约回执：
 * 回执错误码仍受 `packages/privacy/deletion.mjs` 的 `SAFE_ERROR_CODES` 约束）。
 */
export const BACKUP_PURGE_DRIVER_ERROR_CODES = Object.freeze({
  /** 显式重排失败（改不回 `pending_purge`）⇒ 该组本轮清不了。 */
  REQUEUE_FAILED: 'REQUEUE_FAILED',
  /** 传了 `--retry-failed` 但没接重排实现（装配缺口，不是数据问题）。 */
  REQUEUE_UNAVAILABLE: 'REQUEUE_UNAVAILABLE',
  /** 端口抛错（而不是返回 blocked）：单组异常不得中断整批。 */
  DRIVER_EXCEPTION: 'DRIVER_EXCEPTION',
});

/** 与 `packages/privacy/backup-retention.mjs:92` 逐字相同的严格 ISO-8601（必须带时区）。 */
const ISO_8601_STRICT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

/** 事务/连接的最小形状（只用到 `query`，不把 pg 的完整类型灌进主域）。 */
export interface BackupPurgeSqlClient {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** 一个待清组（= 端口 `purge()` 的三元组 + 组内读数）。 */
export interface BackupPurgeCandidateGroup {
  requestId: string;
  userId: string;
  module: string;
  /** 组内未清行数（`state <> 'purged'`）。 */
  rowCount: number;
  /** 组内 `pending_purge` 行数。 */
  pendingRows: number;
  /** 组内 `failed` 行数（> 0 时端口只会返回 blocked，需显式重排）。 */
  failedRows: number;
  /** 组内**最晚**的 `retention_until`（UTC ISO-8601）：整组到到期才允许清。 */
  retentionUntil: string;
}

/**
 * 到期扫描（只读；候选三元组走 `user_backup_copies_due_idx` 部分索引 `0023:88-90`）。
 *
 * ## 为什么不是一条「WHERE 到期 + HAVING max(到期)」的朴素写法
 * `WHERE` 在**分组之前**过滤行：若某个三元组里既有到期行又有未到期行，
 * 朴素写法会让未到期行根本不参与 `max()`，`HAVING max(...) <= cutoff` 于是恒真 ——
 * 守卫变成空操作（本片真库臂实测踩到过：一条部分到期的组被放进来，
 * 端口按 `backup-copies-pg.ts:309-315` 的自陈行为回滚并把未到期行标成 `failed`）。
 * 因此这里分两步：① `cand` 先只在**到期行**上找候选三元组（走部分索引）；
 * ② 再回到**该三元组的全部未清行**上做聚合，`HAVING max(retention_until) <= cutoff`
 * 才真的是「整组都到期」。部分到期的组既不进本集合（不清），也不被静默当成清完
 * （由 {@link BACKUP_COPY_MIXED_GROUPS_SQL} 单独计数上报）。
 *
 * `total_due` 用窗口函数在 `LIMIT` **之前**算（窗口在 ORDER BY/LIMIT 之前求值），
 * 因此一次查询就同时给出「本批取到几组」与「库内一共几组待清」。
 */
export const BACKUP_COPY_DUE_GROUPS_SQL = `WITH cand AS (
  SELECT DISTINCT request_id, user_id, module
    FROM public.user_backup_copies
   WHERE state <> 'purged'
     AND retention_until <= $1::timestamptz
), due AS (
  SELECT c.request_id,
         c.user_id,
         c.module,
         count(*)::int AS row_count,
         count(*) FILTER (WHERE c.state = 'pending_purge')::int AS pending_rows,
         count(*) FILTER (WHERE c.state = 'failed')::int AS failed_rows,
         min(c.retention_until) AS due_at,
         max(c.retention_until) AS last_retention_until
    FROM public.user_backup_copies c
    JOIN cand
      ON cand.request_id = c.request_id
     AND cand.user_id = c.user_id
     AND cand.module = c.module
   WHERE c.state <> 'purged'
   GROUP BY c.request_id, c.user_id, c.module
  HAVING max(c.retention_until) <= $1::timestamptz
)
SELECT due.*, count(*) OVER ()::int AS total_due
  FROM due
 ORDER BY due_at, request_id, module
 LIMIT $2::integer`;

/**
 * 「部分到期」的组数：组内有到期行、但也有行还没到期。
 *
 * 这种形状在产线上**不应出现**（同一受理的所有副本行 `retention_until` 恒等于
 * `deletion_requests.backup_due_at`，设计 §4.4），但一旦出现（手工改库/时钟漂移），
 * 它的正确动作是**人工处置**，不是自动清：自动清会被端口的删除后复核判失败，
 * 并把未到期行误标 `failed`。所以本驱动只计数上报，让运维看得见。
 */
export const BACKUP_COPY_MIXED_GROUPS_SQL = `WITH cand AS (
  SELECT DISTINCT request_id, user_id, module
    FROM public.user_backup_copies
   WHERE state <> 'purged'
     AND retention_until <= $1::timestamptz
)
SELECT count(*)::int AS mixed_groups
  FROM (
    SELECT c.request_id, c.user_id, c.module
      FROM public.user_backup_copies c
      JOIN cand
        ON cand.request_id = c.request_id
       AND cand.user_id = c.user_id
       AND cand.module = c.module
     WHERE c.state <> 'purged'
     GROUP BY c.request_id, c.user_id, c.module
    HAVING max(c.retention_until) > $1::timestamptz
  ) AS mixed`;

/**
 * 显式重排：把本组**已到期**的 `failed` 行改回 `pending_purge`。
 *
 * ⛔ 不动 `payload`（`failed` 行的 payload 一直在，正是「没清掉」的证据）；
 * ⛔ 不重置 `purge_attempts`/`last_error_code`（留痕：这一组历史上失败过几次、为什么）。
 */
export const BACKUP_COPY_REQUEUE_FAILED_SQL = `UPDATE public.user_backup_copies
   SET state = 'pending_purge',
       updated_at = $4::timestamptz
 WHERE request_id = $1::uuid AND user_id = $2::uuid AND module = $3
   AND state = 'failed'
   AND retention_until <= $4::timestamptz
 RETURNING scope`;

/** 重排后复核用：本组还剩多少 `failed` 行（并发下别人已重排 ⇒ 0）。 */
const BACKUP_COPY_COUNT_FAILED_SQL = `SELECT count(*)::int AS failed_rows
  FROM public.user_backup_copies
 WHERE request_id = $1::uuid AND user_id = $2::uuid AND module = $3
   AND state = 'failed'`;

/** 解析一个时刻为 epoch 毫秒；不可信一律 `null`（调用方 fail closed）。 */
function instantMs(value: unknown): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    if (!ISO_8601_STRICT.test(value)) return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/**
 * 批次上限归一化：缺省取 `DEFAULT_BACKUP_PURGE_BATCH_LIMIT`，非法/超硬顶即**抛错**。
 *
 * 不静默夹到合法范围：`--limit 0` 或 `--limit -5` 是运维写错了参数，
 * 悄悄改成 1 会让人以为「跑过了」。
 */
export function normalizeBackupPurgeLimit(value: unknown = DEFAULT_BACKUP_PURGE_BATCH_LIMIT): number {
  if (value === undefined || value === null) return DEFAULT_BACKUP_PURGE_BATCH_LIMIT;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`批次上限必须是 ≥ 1 的安全整数（收到 ${String(value)}）`);
  }
  if (value > MAX_BACKUP_PURGE_BATCH_LIMIT) {
    throw new RangeError(`批次上限不得超过 ${MAX_BACKUP_PURGE_BATCH_LIMIT}（收到 ${value}）：请分批跑`);
  }
  return value;
}

/**
 * 读库：列出本批到期组 + 库内到期组总数 + 「部分到期」组数（后者只上报、不处理）。
 *
 * @returns `{ groups, totalDue, mixedGroups }`；`totalDue === 0` 时 `groups` 必为空。
 */
export async function listDueBackupCopyGroups(
  client: BackupPurgeSqlClient,
  { cutoff, limit = DEFAULT_BACKUP_PURGE_BATCH_LIMIT }: { cutoff: string | Date; limit?: number },
): Promise<{ groups: BackupPurgeCandidateGroup[]; totalDue: number; mixedGroups: number }> {
  const cutoffMs = instantMs(cutoff);
  if (cutoffMs === null) {
    throw new TypeError('到期扫描的 cutoff 必须是 Date／带时区的 ISO-8601 字符串；不接受裸本地时间');
  }
  const batch = normalizeBackupPurgeLimit(limit);
  const at = new Date(cutoffMs).toISOString();
  const result = await client.query(BACKUP_COPY_DUE_GROUPS_SQL, [at, batch]);
  const groups: BackupPurgeCandidateGroup[] = [];
  let totalDue = 0;
  for (const row of result.rows) {
    const lastUntil = row['last_retention_until'];
    const untilMs = lastUntil instanceof Date ? lastUntil.getTime() : instantMs(lastUntil);
    if (untilMs === null) {
      // 期限读不出来 ⇒ 不猜、不放进待清集合（漏清好过误清）。
      throw new TypeError('user_backup_copies.retention_until 不可解析：拒绝据此清除');
    }
    const total = Number(row['total_due']);
    if (Number.isSafeInteger(total) && total > totalDue) totalDue = total;
    groups.push({
      requestId: String(row['request_id']),
      userId: String(row['user_id']),
      module: String(row['module']),
      rowCount: Number(row['row_count']),
      pendingRows: Number(row['pending_rows']),
      failedRows: Number(row['failed_rows']),
      retentionUntil: new Date(untilMs).toISOString(),
    });
  }
  if (groups.length === 0) totalDue = 0;
  const mixed = await client.query(BACKUP_COPY_MIXED_GROUPS_SQL, [at]);
  const mixedCount = Number(mixed.rows[0]?.['mixed_groups'] ?? 0);
  return { groups, totalDue, mixedGroups: Number.isSafeInteger(mixedCount) && mixedCount > 0 ? mixedCount : 0 };
}

/**
 * 显式重排一个组的 `failed` 行（`--retry-failed` 的实现）。
 *
 * @returns `true` = 该组现在已无 `failed` 行（本次改回或并发者已改回），可以接着 purge；
 *          `false` = 仍有 `failed` 行，本轮清不了（如实报 `REQUEUE_FAILED`）。
 */
export async function requeueFailedBackupCopyGroup(
  client: BackupPurgeSqlClient,
  {
    requestId,
    userId,
    module,
    cutoff,
  }: { requestId: string; userId: string; module: string; cutoff: string | Date },
): Promise<boolean> {
  const cutoffMs = instantMs(cutoff);
  if (cutoffMs === null) {
    throw new TypeError('重排的 cutoff 必须是 Date／带时区的 ISO-8601 字符串；不接受裸本地时间');
  }
  const at = new Date(cutoffMs).toISOString();
  const updated = await client.query(BACKUP_COPY_REQUEUE_FAILED_SQL, [requestId, userId, module, at]);
  if (updated.rows.length > 0) return true;
  // 0 行：可能是并发者刚重排过（或本来就不是 failed）⇒ 复核一次，不把「没改到」直接判失败。
  const remaining = await client.query(BACKUP_COPY_COUNT_FAILED_SQL, [requestId, userId, module]);
  return Number(remaining.rows[0]?.['failed_rows'] ?? 0) === 0;
}

/** 失败读数（只含定位符：request_id + module，⛔ 不含主体 id、不含任何正文）。 */
export interface BackupPurgeRunFailure {
  requestId: string;
  module: string;
  errorCode: string;
  reason: string;
}

/** 一轮运行的读数（`formatBackupPurgeReport()` 的唯一输入）。 */
export interface BackupPurgeRunReport {
  cutoff: string;
  limit: number;
  dryRun: boolean;
  retryFailed: boolean;
  /** 本批交给 runner 的组数（≤ limit，正常等于 SQL 取到的组数）。 */
  candidates: number;
  /** 库内到期组总数（SQL 的 `total_due`；调用方没给就等于 candidates）。 */
  totalDue: number;
  /** 处理组数 = 成功 + 跳过 + 失败（三者恒等于它，单测逐轮断言）。 */
  processed: number;
  succeeded: number;
  skipped: number;
  failed: number;
  /** 本次显式重排成功的组数。 */
  requeued: number;
  /** 成功组覆盖的未清行数（= 真正置为 purged 的行数上限，端口复核保证不会更少）。 */
  rowsPurged: number;
  /** 本批之后仍待清的组数（`totalDue - processed`，不为负）。 */
  remaining: number;
  /** 「部分到期」的组数（有到期行、也有未到期行）：不清、只上报（产线不应出现）。 */
  mixedGroups: number;
  skipReasons: Record<string, number>;
  failures: BackupPurgeRunFailure[];
}

/** 驱动入参。 */
export interface BackupPurgeRunInput {
  /** **只取一次**的时刻：枚举、复核、端口 `now()` 三处同源。 */
  cutoff: string | Date;
  groups: readonly BackupPurgeCandidateGroup[];
  limit?: number;
  /** SQL 给出的库内到期组总数（不给则等于 `groups.length`）。 */
  totalDue?: number;
  /** SQL 给出的「部分到期」组数（不清、只上报；不给视为 0）。 */
  mixedGroups?: number;
  retryFailed?: boolean;
  dryRun?: boolean;
  /** 清除端口（生产传 `createPostgresBackupPurgePort({ pool, now }).purge`，或直接传端口方法）。 */
  purge: (input: BackupPurgeInput & { requestId: string }) => Promise<BackupPurgeResult>;
  /** 显式重排实现；不传则 `--retry-failed` 会以 `REQUEUE_UNAVAILABLE` 失败（不静默跳过）。 */
  requeue?: (input: { requestId: string; userId: string; module: string }) => Promise<boolean>;
}

function bump(counts: Record<string, number>, key: string): void {
  const current = counts[key];
  counts[key] = (current === undefined ? 0 : current) + 1;
}

/**
 * 执行一批到期清除（**纯逻辑**：不读库、不建连接、不读系统时钟；`purge`/`requeue` 注入）。
 *
 * 逐组顺序（先 fail closed，再动手）：
 *   1. cutoff 不可解析 ⇒ **抛错**（不猜时间，不静默跑空批）；
 *   2. 超过 `limit` 的组**不处理**（留在 `remaining` 里，下一轮再取）；
 *   3. 组内最晚 `retention_until` 晚于 cutoff ⇒ 跳过 `not_due`（⛔ 不调 purge）；
 *   4. 组内有 `failed` 行且未 `retryFailed` ⇒ 跳过 `failed_needs_requeue`；
 *   5. `dryRun` ⇒ 跳过 `dry_run`（⛔ 不调 purge、不调 requeue）；
 *   6. `retryFailed` 且组内有 `failed` 行 ⇒ 先重排，再 purge；
 *   7. 调 purge：`purged` ⇒ 成功；`waiting` ⇒ 跳过 `waiting_retention`；
 *      其余（含无 `outcome` 的旧式 `{purged:false}`）⇒ 失败 `STORE_REJECTED`；
 *   8. purge/requeue 抛错 ⇒ 记该组失败，**继续**下一组（失败不阻塞）。
 */
export async function runBackupPurgeBatch(input: BackupPurgeRunInput): Promise<BackupPurgeRunReport> {
  const cutoffMs = instantMs(input.cutoff);
  if (cutoffMs === null) {
    throw new TypeError('到期清除的 cutoff 必须是 Date／带时区的 ISO-8601 字符串；不接受裸本地时间');
  }
  const cutoff = new Date(cutoffMs).toISOString();
  const limit = normalizeBackupPurgeLimit(input.limit);
  const retryFailed = input.retryFailed === true;
  const dryRun = input.dryRun === true;
  const groups = Array.isArray(input.groups) ? input.groups : [];

  const skipReasons: Record<string, number> = {};
  const failures: BackupPurgeRunFailure[] = [];
  let processed = 0;
  let succeeded = 0;
  let skipped = 0;
  let failed = 0;
  let requeued = 0;
  let rowsPurged = 0;

  for (const group of groups) {
    if (processed >= limit) break;
    processed += 1;

    const untilMs = instantMs(group.retentionUntil);
    if (untilMs === null || untilMs > cutoffMs) {
      // 期限不可解析同样不放进清除路径（漏清好过误清）。
      skipped += 1;
      bump(skipReasons, BACKUP_PURGE_DRIVER_SKIP_REASONS.NOT_DUE);
      continue;
    }
    if (group.failedRows > 0 && !retryFailed) {
      skipped += 1;
      bump(skipReasons, BACKUP_PURGE_DRIVER_SKIP_REASONS.FAILED_NEEDS_REQUEUE);
      continue;
    }
    if (dryRun) {
      skipped += 1;
      bump(skipReasons, BACKUP_PURGE_DRIVER_SKIP_REASONS.DRY_RUN);
      continue;
    }
    if (group.failedRows > 0) {
      if (input.requeue === undefined) {
        failed += 1;
        failures.push({
          requestId: group.requestId,
          module: group.module,
          errorCode: BACKUP_PURGE_DRIVER_ERROR_CODES.REQUEUE_UNAVAILABLE,
          reason: '要求重排 failed 行，但没有接重排实现',
        });
        continue;
      }
      let requeuedOk = false;
      try {
        requeuedOk = await input.requeue({
          requestId: group.requestId,
          userId: group.userId,
          module: group.module,
        });
      } catch {
        requeuedOk = false;
      }
      if (!requeuedOk) {
        failed += 1;
        failures.push({
          requestId: group.requestId,
          module: group.module,
          errorCode: BACKUP_PURGE_DRIVER_ERROR_CODES.REQUEUE_FAILED,
          reason: 'failed 行重排失败（仍停在 failed，本轮不清）',
        });
        continue;
      }
      requeued += 1;
    }

    let result: BackupPurgeResult;
    try {
      result = await input.purge({
        userId: group.userId,
        module: group.module,
        requestId: group.requestId,
        // 本驱动只做备份副本侧；在线清理不在此路径上，计数器如实填 0（端口不读这个字段）。
        onlineRemoved: 0,
      });
    } catch {
      failed += 1;
      failures.push({
        requestId: group.requestId,
        module: group.module,
        errorCode: BACKUP_PURGE_DRIVER_ERROR_CODES.DRIVER_EXCEPTION,
        reason: '清除端口抛错（已隔离到本组）',
      });
      continue;
    }

    const outcome = result.outcome ?? (result.purged ? 'purged' : 'blocked');
    if (outcome === 'purged' && result.purged) {
      succeeded += 1;
      rowsPurged += group.rowCount;
      continue;
    }
    if (outcome === 'waiting') {
      skipped += 1;
      bump(skipReasons, BACKUP_PURGE_DRIVER_SKIP_REASONS.WAITING_RETENTION);
      continue;
    }
    failed += 1;
    failures.push({
      requestId: group.requestId,
      module: group.module,
      errorCode: result.errorCode ?? 'STORE_REJECTED',
      reason: result.reason ?? '清除端口返回 blocked',
    });
  }

  const declaredTotal = input.totalDue;
  const totalDue =
    typeof declaredTotal === 'number' && Number.isSafeInteger(declaredTotal) && declaredTotal > groups.length
      ? declaredTotal
      : groups.length;
  const declaredMixed = input.mixedGroups;
  const mixedGroups =
    typeof declaredMixed === 'number' && Number.isSafeInteger(declaredMixed) && declaredMixed > 0 ? declaredMixed : 0;

  return {
    cutoff,
    limit,
    dryRun,
    retryFailed,
    candidates: groups.length,
    totalDue,
    processed,
    succeeded,
    skipped,
    failed,
    requeued,
    rowsPurged,
    remaining: Math.max(0, totalDue - processed),
    mixedGroups,
    skipReasons,
    failures,
  };
}

/**
 * 退出码（运维/cron 的唯一判据）：
 * - `0`：本轮没有失败组，也没有「待显式重排的 failed 行」，也没有「部分到期」的组（含 0 组可做）；
 * - `1`：有失败组，或存在 `failed_needs_requeue`，或存在 `mixedGroups > 0`
 *   —— 三种都表示链路上还有清不掉的副本行，需要人介入。
 *
 * 参数/连接类错误由 CLI 自己用 `2`（见 `tools/purge-expired-backup-copies.mjs`）。
 */
export function backupPurgeExitCode(report: BackupPurgeRunReport): 0 | 1 {
  if (report.failed > 0) return 1;
  if (report.mixedGroups > 0) return 1;
  const needsRequeue = report.skipReasons[BACKUP_PURGE_DRIVER_SKIP_REASONS.FAILED_NEEDS_REQUEUE];
  return needsRequeue !== undefined && needsRequeue > 0 ? 1 : 0;
}

/**
 * 文本读数（`--json` 之外的人类可读输出；纯函数，单测可直接断言）。
 *
 * 隐私口径：只打印 `request_id`（不透明 uuid）与模块名，**不打印 `user_id`** 与任何正文；
 * 成功行打印证据摘要（`sha256:…`，本来就落在库里做清除证据）。
 */
export function formatBackupPurgeReport(report: BackupPurgeRunReport): string[] {
  const lines: string[] = [];
  const tag = '[purge-expired-backup-copies]';
  lines.push(
    `${tag} cutoff=${report.cutoff} limit=${report.limit} retry-failed=${report.retryFailed} dry-run=${report.dryRun}`,
  );
  lines.push(
    `${tag} 到期组：本批取到 ${report.candidates} 组（库内合计 ${report.totalDue} 组）`,
  );
  lines.push(
    `${tag} 处理 ${report.processed} 组 / 成功 ${report.succeeded}（置 purged ${report.rowsPurged} 行）`
      + ` / 跳过 ${report.skipped} / 失败 ${report.failed}`
      + `${report.requeued > 0 ? ` / 显式重排 ${report.requeued} 组` : ''}`,
  );
  const reasons = Object.keys(report.skipReasons).sort();
  if (reasons.length > 0) {
    lines.push(
      `${tag} 跳过明细：${reasons.map((key) => `${key}=${report.skipReasons[key] ?? 0}`).join(' ')}`,
    );
  }
  for (const failure of report.failures) {
    lines.push(
      `${tag} FAIL request=${failure.requestId} module=${failure.module}`
        + ` error=${failure.errorCode} reason=${failure.reason}`,
    );
  }
  if (report.mixedGroups > 0) {
    lines.push(
      `${tag} 另发现 ${report.mixedGroups} 组「部分到期」（同组既有到期行又有未到期行）：⛔ 不清、需人工处置`
        + '（产线不应出现；自动清会被端口复核判失败并把未到期行误标 failed）',
    );
  }
  lines.push(`${tag} 剩余未处理 ${report.remaining} 组（下一轮再取）`);
  lines.push(
    `${tag} SUMMARY cutoff=${report.cutoff} limit=${report.limit} candidates=${report.candidates}`
      + ` total_due=${report.totalDue} processed=${report.processed} succeeded=${report.succeeded}`
      + ` skipped=${report.skipped} failed=${report.failed} requeued=${report.requeued}`
      + ` rows_purged=${report.rowsPurged} remaining=${report.remaining}`
      + ` mixed_groups=${report.mixedGroups} exit=${backupPurgeExitCode(report)}`,
  );
  return lines;
}
