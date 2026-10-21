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
 * | **失败不阻塞** | 每个 (request, module) 单独 try/catch；一行失败只记该行 `failed`，同请求其余模块与后续请求照跑 |
 * | **每个成功行写证据** | 每个 `removed/idempotency` 成功行产出一条 `sha256:` 证据（`onlinePurgeEvidenceRef()`），进报告与退出码口径 |
 * | **不谎称完成** | 本驱动**不写** `deletion_requests.state`，也不改回执；它只删在线行并报告事实（完成判定仍归协调器） |
 *
 * ## 证据为什么只进报告、不落库（如实登记的未取得项）
 * 在线域的"每个成功行写证据"目前**没有落地列**：`deletion_handlers` 对运行时角色是 `forbidden`
 * （`90-assert-least-privilege.sql:1068-1070` + 第 48 项反向控制），`admin_audit_events` 运行时连
 * `SELECT` 都没有，`deletion_requests` 没有任何"在线已清"状态列。落库需要**新增迁移**（本片红线：
 * 不改迁移号、不新增迁移）⇒ 证据以 `sha256:` 摘要形式进**命令报告**（stdout，可被 cron 日志留存），
 * 并在证据页「未取得」里写明「审计落地未做」。⛔ 不用"UPDATE 没报错"替代证据。
 *
 * ## 需要的数据库角色
 * 候选查询要读 `deletion_requests`，而运行时角色 `gengyun_api_runtime` 对该表**零表级零列级**权限
 * （`90-assert` 第 48 项），必然 `42501`。因此本命令用 `DATABASE_URL`（属主/运维角色，与 `db:migrate`
 * 同源口径），并把它列为证据页的待裁决项（是否新增 `SECURITY DEFINER` 的到期列举函数）。
 */
import { createHash } from 'node:crypto';

import { SAFE_ERROR_CODES } from '../../../../packages/privacy/deletion.mjs';
import { USER_DATA_DELETION_MODULES } from './user-data-deletion.ts';

/** 每批最多处理多少个**请求**（不是模块行：一次请求的四域必须一起看，见 `runOnlinePurgeBatch`）。 */
export const DEFAULT_ONLINE_PURGE_BATCH_LIMIT = 200;
/** 硬上限：超顶**报错**而不是夹取（夹取会让"我设了 10000"静默变成 5000）。 */
export const MAX_ONLINE_PURGE_BATCH_LIMIT = 5000;

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
 */
export const ONLINE_PURGE_DUE_SQL = `SELECT id, user_id, online_due_at
  FROM public.deletion_requests
  WHERE online_due_at <= $1::timestamptz
    AND state <> 'completed'
  ORDER BY online_due_at, id
  LIMIT $2::integer`;

/** 到期总数（不受 `--limit` 影响；报告里的 `totalDue` 用它，运维才看得出"还剩多少"）。 */
export const ONLINE_PURGE_DUE_COUNT_SQL = `SELECT count(*)::integer AS total
  FROM public.deletion_requests
  WHERE online_due_at <= $1::timestamptz
    AND state <> 'completed'`;

const STRICT_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

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

/** 取到期候选（一次 SQL；`totalDue` 另用一条 count，避免"被 limit 截断后看不出还剩多少"）。 */
export async function listDueOnlineDeletions(
  client: OnlinePurgeSqlClient,
  input: { cutoff: Date | string | number; limit: number },
): Promise<{ requests: OnlinePurgeCandidate[]; totalDue: number }> {
  const cutoffMs = instantMs(input.cutoff);
  if (cutoffMs === null) {
    throw new TypeError('在线到期清除的 cutoff 必须是 Date／带时区的 ISO-8601 字符串；不接受裸本地时间');
  }
  const limit = normalizeOnlinePurgeLimit(input.limit);
  const cutoffIso = new Date(cutoffMs).toISOString();
  const [rows, total] = await Promise.all([
    client.query(ONLINE_PURGE_DUE_SQL, [cutoffIso, limit]),
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

    if (failureThisRequest > 0) {
      report.failed += 1;
      // 失败请求的"已成功模块"证据照样保留（这就是"每个成功行写证据"）；
      // 只把整请求记为 failed，让退出码把它顶出来给运维看。
      report.evidence.push(...evidenceThisRequest);
      report.rowsPurged += rowsThisRequest;
      report.idempotencyPurged += idempotencyThisRequest;
      continue;
    }
    if (rowsThisRequest === 0 && idempotencyThisRequest === 0) {
      // 四域都 0 行 ⇒ 这个主体的在线数据已经清过（或本来就没有）。**不谎称本次清过**：
      // 记 skipped、证据丢弃、`rowsPurged` 不动 —— 重复跑第二轮的读数就在这里。
      skip(ONLINE_PURGE_SKIP_REASONS.ALREADY_PURGED);
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

/** 退出码（cron 的唯一判据）：0 无失败 / 1 有失败行 / 2 由 CLI 的配置错误分支给出。 */
export function onlinePurgeExitCode(report: OnlinePurgeRunReport): 0 | 1 {
  return report.failed > 0 ? 1 : 0;
}

/**
 * 报告文本（**隐私口径**：只出现 `request_id` 与模块名，⛔ 不打 `user_id`、
 * 不打正文/标题/任何主体标识；失败只给固定分类码）。
 */
export function formatOnlinePurgeReport(report: OnlinePurgeRunReport): string[] {
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
