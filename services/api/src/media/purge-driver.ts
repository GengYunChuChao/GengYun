/**
 * 媒体域对象清扫的驱动层（W15 切片 / issue #6 缺口 G1：给清理器一个真实执行者）。
 *
 * ## 这个文件解决什么
 *
 * `services/api/src/media/service.ts` 里的 `expireInitiated()`（`:225` 声明 / `:1412` 实现）与
 * `cleanupOrphans()`（`:237` 声明 / `:1424` 实现）**有实现、有单测、零生产调用者**——四处注释
 * 自认这一点（`service.ts:836`、`store.ts:133`、`store-pg.ts:472`、
 * `privacy/user-data-deletion.ts:289/891/1018`）。本文件是那个缺失的调用者：一轮「先收到期、
 * 再扫孤儿」的顺序编排，外加退出码与读数。
 *
 * ## 边界（⛔ 别把这里的能力读大）
 *
 * - 本文件**只调用** `service.ts` 已有的两个方法，**不复制**它们的语义，也**不改**它们。
 *   失败语义照抄：对象端口抛错或返回 `false` ⇒ **保留对象引用与台账行**（`service.ts:708`、
 *   `:742`），留给下一轮重试。驱动层不重试、不兜底、不把「没确认删掉」说成删掉了。
 * - 本文件是**纯逻辑**：不读 `process.env`（`services/api/src/media/**` 的既有 AST 审计禁止）、
 *   不读系统时钟（`now` 由调用方注入）、不建连接、不起定时器（⛔ 没有 `setInterval`——
 *   排班交给 systemd timer，见 `deploy/purge-schedule/gengyun-purge-media-objects.timer`）。
 * - 本文件**不证明**真实 S3 `DeleteObject` / 版本化语义，也不证明真 PG 上的并发行为：
 *   本机没有真桶真库，端到端跑不了；被单测覆盖的只有这一层的编排、读数与退出码。
 */
/** 退出码口径（与 `tools/purge-expired-online-data.mjs` 的同名口径一致）。 */
export const MEDIA_PURGE_EXIT = Object.freeze({
  /** 一轮跑完、零失败行。**不**等于「库里已经没有孤儿」。 */
  OK: 0,
  /** 跑完了，但至少有 1 条失败读数（对象端口抛错 / 未确认删除 / 后续重试）。 */
  FAILED: 1,
  /** 没跑：参数或装配错（含 `--limit` 非法）。⛔ 不许退化成 0。 */
  CONFIG: 2,
});

/** 单轮默认预算（见 `normalizeMediaPurgeLimit` 与报告里的 `LIMIT_REACHED` 说明）。 */
export const DEFAULT_MEDIA_PURGE_LIMIT = 200;

/** 预算上限：再高的数字就不是「一轮」了，宁可拆轮（也不许拿它当分页）。 */
export const MAX_MEDIA_PURGE_LIMIT = 5000;

/** 失败读数的阶段标签（报告与日志里的定位符）。 */
export const MEDIA_PURGE_PHASES = Object.freeze({
  /** 参数/装配校验（还没碰端口）。 */
  CONFIG: 'config',
  /** 只读计数（dry-run 唯一会走的那一段）。 */
  STATS: 'stats',
  /** `expireInitiated()`：把过了 24h 仍 `initiated` 的记录收到 `rejected`。 */
  EXPIRE_INITIATED: 'expire-initiated',
  /** `cleanupOrphans()`：删对象引用、撤授权、重试台账行。 */
  CLEANUP_ORPHANS: 'cleanup-orphans',
});

/** 跳过原因（`skipReason` 的取值；正常一轮为 `null`）。 */
export const MEDIA_PURGE_SKIP_REASONS = Object.freeze({
  /** `--dry-run`：只读计数，⛔ 不调任何写入型方法。 */
  DRY_RUN: 'dry_run',
  /** 本轮预算已被到期回收用尽，孤儿清扫留给下一轮。 */
  LIMIT_REACHED: 'limit_reached',
});

/** 参数错的类型化错误（CLI 侧把它映射成退出码 2，⛔ 不是 1）。 */
export class MediaPurgeArgumentError extends TypeError {
  readonly code: string;

  constructor(message: string, code = 'INVALID_ARGUMENT') {
    super(message);
    this.name = 'MediaPurgeArgumentError';
    this.code = code;
  }
}

/**
 * 规范化单轮预算。
 *
 * 接受正整数或纯数字字符串（CLI 的 `--limit` 只能给出字符串）；其余一律**抛错**，
 * 不悄悄换成默认值——顺手把 `--limit abc` 当 200 跑，就是「静默跑了一轮别人没要的活」。
 */
export function normalizeMediaPurgeLimit(value: unknown = DEFAULT_MEDIA_PURGE_LIMIT): number {
  if (value === undefined || value === null) return DEFAULT_MEDIA_PURGE_LIMIT;
  const text = typeof value === 'string' ? value.trim() : value;
  if (typeof text === 'string' && !/^[0-9]+$/.test(text)) {
    throw new MediaPurgeArgumentError(
      `limit 必须是正整数（收到非数字：${JSON.stringify(text.slice(0, 32))}）`,
      'INVALID_LIMIT',
    );
  }
  const limit = typeof text === 'string' ? Number(text) : text;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
    throw new MediaPurgeArgumentError('limit 必须是 ≥ 1 的整数', 'INVALID_LIMIT');
  }
  if (limit > MAX_MEDIA_PURGE_LIMIT) {
    throw new MediaPurgeArgumentError(
      `limit 不能超过 ${MAX_MEDIA_PURGE_LIMIT}（一轮最多处理这么多，剩下的留给下一轮）`,
      'INVALID_LIMIT',
    );
  }
  return limit;
}

/** 一轮运行的读数（`formatMediaPurgeReport()` 的唯一输入，也是 CLI `--json` 的载荷）。 */
export interface MediaPurgeReport {
  /** 是否只读模式（`true` ⇒ 整个过程只调过 `stats()`）。 */
  dryRun: boolean;
  /** 本轮生效的预算（规范化之后的值，见 `normalizeMediaPurgeLimit`）。 */
  limit: number;
  /** 本轮开始时刻（`now()` 第一次读数；时钟不合法时为 `null`）。 */
  startedAt: string | null;
  /** 本轮结束时刻（`now()` 第二次读数）。 */
  finishedAt: string | null;
  /** `expireInitiated()` 收到的到期记录条数：**真实值**，⛔ 不受 `limit` 截断。 */
  expired: number;
  /** 本轮动过的对象引用条数 = 确认删除 + 未确认（⛔ 不是库里的孤儿总数）。 */
  orphansScanned: number;
  /** 端口确认删除的对象引用条数（`cleanupOrphans().removedObjects`）。 */
  deleted: number;
  /** 未确认的对象引用条数（`cleanupOrphans().pendingObjects`）：引用与台账行都还在，下一轮重试。 */
  retained: number;
  /** 本轮撤销的访问授权条数。 */
  revokedGrants: number;
  /** 清扫后端口自报的对象计数；端口说不清时为 `null`（不猜）。 */
  remainingObjects: number | null;
  /** dry-run 的只读计数；非 dry-run 时是 `null`。 */
  scan: MediaPurgeScan | null;
  /** 预算闸是否触发（`true` ⇒ 本轮跳过了孤儿清扫，见 `MediaPurgeRunInput.limit`）。 */
  truncated: boolean;
  /** 跳过原因（`MEDIA_PURGE_SKIP_REASONS` 的取值）；没有跳过时为 `null`。 */
  skipReason: string | null;
  /** 失败读数；空数组只说明这一层没收到失败，⛔ 不等于桶侧已空。 */
  failures: MediaPurgeFailure[];
  /** 退出码（`MEDIA_PURGE_EXIT` 的取值）。 */
  exitCode: number;
}

/** 单条失败读数：只含定位符与错误串，⛔ 不含对象键、授权 token、DSN 或任何凭据。 */
export interface MediaPurgeFailure {
  /** 出在哪个阶段（`MEDIA_PURGE_PHASES`）。 */
  phase: string;
  /** 机器可读的错误码（`ApiError.code`；非 `ApiError` 归 `UNEXPECTED_ERROR`）。 */
  code: string;
  /** 人读的说明（截断到 300 字符，且**不**含端口配置值）。 */
  message: string;
  /** 端口自报的可重试性；说不清时为 `null`（不猜）。 */
  retryable: boolean | null;
}

/** 驱动只认这几个方法——结构上兼容 `createAppMediaService()` 的返回值。 */
export interface MediaPurgePort {
  /** `MediaService.expireInitiated()`：整批收到期记录。 */
  expireInitiated(): Promise<{ expired: number }>;
  /** `MediaService.cleanupOrphans()`：删对象引用 / 撤授权 / 重试台账行。 */
  cleanupOrphans(): Promise<{
    removedObjects: number;
    revokedGrants: number;
    pendingObjects: number;
    remainingObjects: number;
  }>;
  /** `MediaService.stats()`：只读计数（dry-run 的唯一入口）。 */
  stats(): Promise<{ mediaCount: number; objectCount: number; grantCount: number }>;
}

/** 驱动入参（全部显式传入，⛔ 不从环境变量兜）。 */
export interface MediaPurgeRunInput {
  /** 媒体服务端口（生产传 `createAppMediaService(...)` 的返回值）。 */
  mediaService: MediaPurgePort;
  /** 时钟（本文件不读系统时钟；两处读数同源）。 */
  now: () => Date;
  /** 只读模式：只调 `stats()`，⛔ 不调 `expireInitiated()` / `cleanupOrphans()`。 */
  dryRun?: boolean;
  /**
   * 单轮预算（默认 {@link DEFAULT_MEDIA_PURGE_LIMIT}）。
   *
   * ⚠️ 语义诚实说明：本域的到期回收只能**整批**——`expireInitiated()` 没有分批参数，一次
   * 调用就会把当时所有到期记录都收到 `rejected`。所以 `limit` **不是**到期条数的上限，
   * 而是**两段之间的预算闸**：`expired >= limit` 时本轮不再进孤儿清扫，报告写
   * `truncated=true` / `skipReason='limit_reached'`，剩下的留给下一轮。
   * 报告里 `expired` 永远是**真实条数**，绝不假称「只处理了 N 条」。
   */
  limit?: number;
}

/** 只读读数（dry-run 的 `scan`）。 */
export interface MediaPurgeScan {
  mediaCount: number;
  objectCount: number;
  grantCount: number;
}

function truncate(text: string, max = 300): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** 把端口抛出的任何东西折成一条失败读数（⛔ 不回显端口配置值）。 */
function describeFailure(phase: string, error: unknown): MediaPurgeFailure {
  const carrier = (typeof error === 'object' && error !== null ? error : {}) as {
    code?: unknown;
    retryable?: unknown;
    message?: unknown;
  };
  const code = typeof carrier.code === 'string' && carrier.code !== '' ? carrier.code : 'UNEXPECTED_ERROR';
  const retryable = typeof carrier.retryable === 'boolean' ? carrier.retryable : null;
  const rawMessage =
    typeof carrier.message === 'string' && carrier.message !== ''
      ? carrier.message
      : typeof error === 'string'
        ? error
        : '';
  const message = rawMessage === '' ? `阶段 ${phase} 抛出未命名错误（${code}）` : truncate(rawMessage);
  return { phase, code, message, retryable };
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 端口形状校验：缺方法就是装配错（退 2），不许当成「跑了 0 条」。 */
function assertPortShape(mediaService: unknown): void {
  if (typeof mediaService !== 'object' || mediaService === null) {
    throw new MediaPurgeArgumentError('mediaService 必须是对象（建议传 createAppMediaService() 的返回值）', 'MISSING_MEDIA_SERVICE');
  }
  for (const method of ['expireInitiated', 'cleanupOrphans', 'stats'] as const) {
    const candidate = (mediaService as Record<string, unknown>)[method];
    if (typeof candidate !== 'function') {
      throw new MediaPurgeArgumentError(
        `mediaService.${method} 缺失或不是函数：媒体域端口未装配，拒绝把「没跑」当成「跑了 0 条」`,
        'MISSING_MEDIA_PORT',
      );
    }
  }
}

/**
 * 跑一轮媒体对象清扫（**纯编排**，不重试、不吞错）。
 *
 * 顺序（先 fail closed，再动手）：
 *   1. 校验 `now` / 端口形状 / `limit`：任一不成立 ⇒ `exitCode=2`，**一个端口方法都不调**；
 *   2. `dryRun` ⇒ 只调 `stats()`（只读计数），`skipReason='dry_run'`，⛔ 不调写入型方法；
 *   3. 调 `expireInitiated()`：把过了 24h 仍 `initiated` 的记录收到 `rejected`；
 *      抛错 ⇒ 记一条失败，**继续**第 4 步（两段互不阻塞）；
 *   4. 预算闸：`expired >= limit` ⇒ 跳过第 5 步，`truncated=true`、`skipReason='limit_reached'`；
 *   5. 调 `cleanupOrphans()`：删对象引用 / 撤授权 / 重试台账行。抛错 ⇒ 记一条失败；
 *   6. `exitCode = failures.length > 0 ? 1 : 0`。
 *
 * `deleted` / `retained` 直接映射端口的 `removedObjects` / `pendingObjects`：
 * **未确认的删除一律记在 `retained`**，并且（由 `service.ts` 保证）对象引用与台账行都还在。
 */
export async function runMediaPurge(input: MediaPurgeRunInput): Promise<MediaPurgeReport> {
  const failures: MediaPurgeFailure[] = [];
  const startedAtSource = typeof input?.now === 'function' ? input.now() : new Date(Number.NaN);
  const startedAtMs = startedAtSource instanceof Date ? startedAtSource.getTime() : Number.NaN;
  const startedAt = Number.isFinite(startedAtMs) ? new Date(startedAtMs).toISOString() : null;

  const report = (patch: Partial<MediaPurgeReport>): MediaPurgeReport => ({
    dryRun: input?.dryRun === true,
    limit: DEFAULT_MEDIA_PURGE_LIMIT,
    startedAt,
    finishedAt: startedAt,
    expired: 0,
    orphansScanned: 0,
    deleted: 0,
    retained: 0,
    revokedGrants: 0,
    remainingObjects: null,
    scan: null,
    truncated: false,
    skipReason: null,
    failures,
    exitCode: MEDIA_PURGE_EXIT.OK,
    ...patch,
  });

  // 1. fail closed：先校验，再动手。
  let limit: number;
  try {
    if (typeof input?.now !== 'function') {
      throw new MediaPurgeArgumentError('now 必须是 () => Date（驱动层不读系统时钟）', 'MISSING_CLOCK');
    }
    if (!Number.isFinite(startedAtMs)) {
      throw new MediaPurgeArgumentError('now() 必须返回合法 Date', 'INVALID_CLOCK');
    }
    assertPortShape(input?.mediaService);
    limit = normalizeMediaPurgeLimit(input.limit);
  } catch (error) {
    failures.push(describeFailure(MEDIA_PURGE_PHASES.CONFIG, error));
    return report({ exitCode: MEDIA_PURGE_EXIT.CONFIG });
  }

  const mediaService = input.mediaService;
  const dryRun = input.dryRun === true;
  let expired = 0;
  let orphansScanned = 0;
  let deleted = 0;
  let retained = 0;
  let revokedGrants = 0;
  let remainingObjects: number | null = null;
  let scan: MediaPurgeScan | null = null;
  let truncated = false;
  let skipReason: string | null = null;

  // 2. dry-run：只读计数。⛔ 不调 expireInitiated()（它会改库）也不调 cleanupOrphans()。
  if (dryRun) {
    skipReason = MEDIA_PURGE_SKIP_REASONS.DRY_RUN;
    try {
      const stats = await mediaService.stats();
      scan = {
        mediaCount: count(stats?.mediaCount) ?? 0,
        objectCount: count(stats?.objectCount) ?? 0,
        grantCount: count(stats?.grantCount) ?? 0,
      };
    } catch (error) {
      failures.push(describeFailure(MEDIA_PURGE_PHASES.STATS, error));
    }
  } else {
    // 3. 收到期记录（整批，见 `limit` 的语义说明）。
    try {
      const result = await mediaService.expireInitiated();
      const value = count(result?.expired);
      if (value === null) {
        failures.push({
          phase: MEDIA_PURGE_PHASES.EXPIRE_INITIATED,
          code: 'MALFORMED_RESULT',
          message: 'expireInitiated() 没有返回数值型 expired（端口契约被破坏，按失败记账）',
          retryable: null,
        });
      } else {
        expired = value;
      }
    } catch (error) {
      failures.push(describeFailure(MEDIA_PURGE_PHASES.EXPIRE_INITIATED, error));
    }

    // 4. 预算闸：口径见 `MediaPurgeRunInput.limit` 的说明。
    if (expired >= limit) {
      truncated = true;
      skipReason = MEDIA_PURGE_SKIP_REASONS.LIMIT_REACHED;
    } else {
      // 5. 扫孤儿：删对象引用 / 撤授权 / 重试台账行。
      try {
        const result = await mediaService.cleanupOrphans();
        const removed = count(result?.removedObjects);
        const pending = count(result?.pendingObjects);
        if (removed === null || pending === null) {
          failures.push({
            phase: MEDIA_PURGE_PHASES.CLEANUP_ORPHANS,
            code: 'MALFORMED_RESULT',
            message: 'cleanupOrphans() 没有返回数值型 removedObjects/pendingObjects（端口契约被破坏，按失败记账）',
            retryable: null,
          });
        } else {
          deleted = removed;
          retained = pending;
          // 「扫描过」= 删除确认 + 未确认，两者都动过对象引用；⛔ 不是库里的孤儿总数。
          orphansScanned = removed + pending;
        }
        revokedGrants = count(result?.revokedGrants) ?? 0;
        remainingObjects = count(result?.remainingObjects);
      } catch (error) {
        failures.push(describeFailure(MEDIA_PURGE_PHASES.CLEANUP_ORPHANS, error));
      }
    }
  }

  const finishedAtSource = input.now();
  const finishedAt =
    finishedAtSource instanceof Date && Number.isFinite(finishedAtSource.getTime())
      ? finishedAtSource.toISOString()
      : startedAt;

  return report({
    limit,
    finishedAt,
    expired,
    orphansScanned,
    deleted,
    retained,
    revokedGrants,
    remainingObjects,
    scan,
    truncated,
    skipReason,
    exitCode: failures.length > 0 ? MEDIA_PURGE_EXIT.FAILED : MEDIA_PURGE_EXIT.OK,
  });
}

/**
 * 把一轮读数铺成人读行（CLI 原样逐行打印；`--json` 时改印 `JSON.stringify(report)`）。
 *
 * 行文案刻意写「确认删除 / 未确认（保留引用与台账行）」而不是「已清理」：
 * 本层能证明的只有端口回了什么，⛔ 没有证明对象真的从桶里消失。
 */
export function formatMediaPurgeReport(report: MediaPurgeReport): string[] {
  const lines: string[] = [];
  const mode = report.dryRun ? 'dry-run（只读计数，未改任何数据）' : '实际执行';
  lines.push(`${mode} · limit=${report.limit} · exitCode=${report.exitCode}`);
  if (report.startedAt !== null) {
    lines.push(`时刻：${report.startedAt} → ${report.finishedAt ?? report.startedAt}`);
  }
  lines.push(
    `到期回收：expired=${report.expired}` +
      (report.truncated ? '（本轮预算已用尽，孤儿清扫留给下一轮）' : ''),
  );
  lines.push(
    `孤儿清扫：扫描对象引用 ${report.orphansScanned} 条 · 确认删除 ${report.deleted} · ` +
      `未确认 ${report.retained}（保留引用与台账行，下一轮重试）· 撤销授权 ${report.revokedGrants}`,
  );
  if (report.remainingObjects !== null) {
    lines.push(`清扫后对象计数：${report.remainingObjects}（端口自报，未与桶侧对账）`);
  }
  if (report.scan !== null) {
    lines.push(
      `只读计数：media=${report.scan.mediaCount} · object=${report.scan.objectCount} · grant=${report.scan.grantCount}`,
    );
    lines.push('说明：dry-run 无法预知会有多少条到期（到期枚举与回收是同一个整批调用，只读路径给不出条数）');
  }
  if (report.skipReason !== null && report.dryRun) {
    lines.push(`跳过原因：${report.skipReason}`);
  }
  for (const failure of report.failures) {
    const retryable = failure.retryable === null ? '可重试性未知' : failure.retryable ? '可重试' : '不可重试';
    lines.push(`失败 · ${failure.phase} · ${failure.code} · ${retryable} · ${failure.message}`);
  }
  if (report.failures.length === 0) {
    lines.push('本轮无失败读数（这不等于「桶里已经没有孤儿」，只等于这一层没有收到失败）');
  } else {
    lines.push(
      `本轮 ${report.failures.length} 条失败读数：退出码 1，交由下一轮重试；` +
        '若码是 PROVIDER_UNAVAILABLE 且不可重试，说明媒体域整域 fail-closed（装配没获批准/存储未接），改装配而不是反复重试',
    );
  }
  return lines;
}
