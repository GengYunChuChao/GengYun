/**
 * GY-R83 · `#1003`：**把「这一次外发烧了多少、用的是哪套剖面」记到账上**的记账层。
 *
 * ## 位置（为什么是「包在提供者外面」而不是改服务层）
 * 识别域的真实外发已经在 `privacy/task-egress.ts::MediaJobEgress.provider()` 的闭包里（那里拿到
 * `exportId` 与 `jobId`，并已完成 `markSent`）。本层**再包一层**，在**同一次调用**的入口/出口计时，
 * 从返回值里读 `usage` 与剖面版本串，写一行 `public.provider_call_ledger`。
 *
 * 顺序上本层**先于** `MediaJobEgress` 的包装执行 —— 因此此刻外发预留行还是 `state='reserved'`，
 * `findReservedByObject` 能命中（`ledger-pg.ts` 那个谓词带 `state='reserved'` 与
 * `cancelled_at IS NULL` 两个条件：**`markSent` 之后就再也查不到这一行**，所以本层必须在外层）。
 * 这是**读**一次既有谓词（与 `task-egress.ts` 用的是同一个方法），不是新建一套归属判定。
 *
 * ## 两条硬规矩（各有一条用例钉住）
 * 1. ⛔ **不改判**：记账失败**绝不**影响识别结果。外发已经发生、候选已经拿到；记账是记账的问题，
 *    不是识别的问题。所以本层自己 catch，异常**不穿过**调用方。
 * 2. ⛔ **不咽**：记账失败必须留下可观测痕迹 —— `readings.failed` / `readings.lastError` 累加，
 *    并发一条安全事件（只有 `code` / `export_id` / 状态，⛔ 不含正文、候选、图片字节、凭据）。
 *    这与 `privacy/task-egress.ts` 的 `ChatEgress.recordInvocationRow()` 是同一套写法。
 *
 * ## 零写路径（三条，都不写行）
 * - **非 `real`**（`stub` / `preset_demo`）：装配根本不产生外发 ⇒ 本层**原样返回**内层提供者
 *   （连一次读都不做）。与「替身不记账」的既有口径一致。
 * - **没有可用连接池**（`ledger === null`）：同上，原样返回。
 * - **拿不到外发预留行**：没有 `export_id` 就没有外键归属，也不可能有合法的 `attempt` 序号 ⇒
 *   记一次 `readings.failed` + 事件 `provider_call_ledger_unresolved`，**不写行**、不抛错。
 *
 * ## 与 0050 那张调用记录表的分工
 * 0050 的台账写入权在默认部署下**有意冻结**（运行时恒 42501；该表字面表名见
 * `services/api/db/migrations/README.md` 的 0055 条目，本文件按钉子②的口径不重复它）。
 * 0055 的 `provider_call_ledger` 是同一件事的**窄口径、追加式**落点：只记识别链路、只记
 * `sent` / `send_failed`、不进识别终态事务。两者的列名刻意同构，日后解冻 0050 时是并入而非重写。
 */
import { readCallMetadata, CALL_VERSION_SHAPE } from '../recognitions/call-metadata.ts';
import { isErrorCode } from '../contract.ts';
import type { PostgresExportLedger } from './ledger-pg.ts';
import type { ProviderCallDomain, ProviderCallInvocationState, ProviderCallLedger } from './provider-call-ledger-pg.ts';

/** 记账读数（进程内累计、只增不减）。⛔ 只读计数，不含任何正文/候选/凭据。 */
export interface ProviderCallAccountingReadings {
  /** 成功落库的记账行数。 */
  written: number;
  /** 记账失败次数（含「拿不到预留行」⇒ 该记的那一行没记上）。 */
  failed: number;
  /** 最近一次失败的**安全码**（契约错误码，不是驱动原文）；无失败时 `null`。 */
  lastError: string | null;
}

export interface ProviderCallAccountingOptions {
  /** 记账台账（迁移 0055 的写原语）；`null` ⇒ 本层不接管（零写、原样返回内层）。 */
  ledger: ProviderCallLedger | null;
  /**
   * 外发账本（`privacy/ledger-pg.ts`）。本层只用它的 `findReservedByObject` **读**一行预留行
   * —— 归属判定的唯一真源在那边，本层不复制 SQL。
   */
  exportLedger: Pick<PostgresExportLedger, 'findReservedByObject'> | null;
  /** 接收方能力（`recipients.capability`：识别是 `weed`）—— 落进 `capability` 列。 */
  capability: string;
  /** 执行模式：只有 `real` 才记账（替身/演示不外发 ⇒ 零写）。 */
  executionMode: 'real' | 'stub' | 'preset_demo';
  /** 业务域（迁移 0055 的闭集，目前只有 `recognition`）。缺省 `recognition`。 */
  domain?: ProviderCallDomain;
  /**
   * 记账失败的可观测出口（默认进 stderr）。入参只有安全 token，
   * ⛔ 不含正文/候选/图片字节/凭据。实现方**不得**抛错（语义是「记一笔就走」）。
   */
  log?: (event: Record<string, unknown>) => void;
  /** 可注入时钟（计时与 `sent_at` 都用它；单测里给固定值即可确定性断言 `duration_ms`）。 */
  now?: () => number;
  /**
   * 读数出口：传入的对象会被**就地累加**（`written` / `failed` / `lastError`）。
   * 生产装配不传（本片不开 HTTP 读面）；单测与排障注入一个对象即可看到计数。
   */
  readings?: ProviderCallAccountingReadings;
}

/** 本层只关心提供者形状上的这两样（不 import `ProviderOutcome`，避免与 provider.ts 的公共类型耦合）。 */
interface RecognizableProvider {
  /** 写入 `model_version` 列（本基线是剖面串 `openai-vision-v1`，不是模型名）。 */
  readonly modelVersion?: string;
  recognize?: (input: { jobId: string; mediaId: string; mediaRevision: number }) => Promise<unknown>;
}

/** 把任意异常压成契约错误码（⛔ 驱动原文一律不采信）。 */
function errorCodeOf(value: unknown): string | null {
  const code = (value as { code?: unknown } | null)?.code;
  return typeof code === 'string' && isErrorCode(code) ? code : null;
}

/** 提供者返回的是不是「失败」结果（`ProviderOutcome` 的 `kind: 'failed'`）。 */
function outcomeFailed(value: unknown): boolean {
  return (value as { kind?: unknown } | null)?.kind === 'failed';
}

/** 版本串收口（必填列）：形状不合法 ⇒ 降级成 `unknown`（⛔ 不让整行被 CHECK 拒掉，用量比版本串更难得）。 */
function versionOrUnknown(value: unknown): string {
  return typeof value === 'string' && CALL_VERSION_SHAPE.test(value) ? value : 'unknown';
}

/** 版本串收口（可空列）：没给或形状不合法 ⇒ `null`（⛔ 不写占位串冒充实测模型名）。 */
function versionOrNull(value: unknown): string | null {
  return typeof value === 'string' && CALL_VERSION_SHAPE.test(value) ? value : null;
}

/**
 * 给提供者套一层「外发记账」。
 *
 * 返回值的类型仍是 `T`（装配处的 `provider:` 字段类型不变）：本层**不改**提供者的可见形状，
 * 只把 `recognize` 换成「先量、再调、后记」。读数经 `options.readings` 暴露（生产路径不暴露）。
 *
 * ⛔ 内层抛的错**原样重抛**（时序、错误对象、栈都不变）—— 记账只是旁路。
 */
export function withProviderCallAccounting<T extends RecognizableProvider>(
  inner: T,
  options: ProviderCallAccountingOptions,
): T {
  const ledger = options?.ledger ?? null;
  const exportLedger = options?.exportLedger ?? null;
  const capability = options?.capability ?? 'unknown';
  const domain: ProviderCallDomain = options?.domain ?? 'recognition';
  // 零写判据：非 real、或没有台账/账本 ⇒ 本层根本不接管（原样返回，连读都不读）。
  if (options?.executionMode !== 'real' || ledger === null || exportLedger === null) return inner;
  const original = inner?.recognize;
  if (typeof original !== 'function') return inner;

  const now = options.now ?? ((): number => Date.now());
  // 收窄后的局部别名：`recordRow` 是闭包，上面的「非 null」收窄不会被带进闭包体。
  const sink: ProviderCallLedger = ledger;
  const source: Pick<PostgresExportLedger, 'findReservedByObject'> = exportLedger;
  const readings: ProviderCallAccountingReadings = options.readings ?? { written: 0, failed: 0, lastError: null };
  const emit =
    options.log ??
    ((event: Record<string, unknown>) => {
      // 兜底出口：没注入日志口时**也不许静默**（进 stderr，服务日志的默认去处）。
      console.warn(JSON.stringify(event));
    });

  /**
   * 写一行记账（本文件**唯一**的写点）。
   *
   * ⛔ 不抛：任何失败都折成 `readings.failed` + 一条安全事件。调用方（本层的 `recognize`）
   * 因此可以照常返回/抛出**识别**的结果。
   */
  async function recordRow(ctx: {
    input: { jobId: string; mediaId: string; mediaRevision: number };
    outcome: unknown;
    threw: boolean;
    durationMs: number;
    sentAt: Date;
  }): Promise<void> {
    let exportId: string | null = null;
    try {
      const record = await source.findReservedByObject({
        objectType: 'media',
        objectId: ctx.input.mediaId,
        objectRevision: ctx.input.mediaRevision,
      });
      exportId = typeof record?.id === 'string' && record.id !== '' ? record.id : null;
    } catch (error) {
      // 读预留行失败：这**就是**记账失败（没有 export_id 就没有归属行），但⛔ 不改判识别结果。
      readings.failed += 1;
      readings.lastError = errorCodeOf(error) ?? 'OBJECT_UNAVAILABLE';
      emit({
        event: 'provider_call_ledger_unresolved',
        code: readings.lastError,
        capability,
        media_id: ctx.input.mediaId,
        media_revision: ctx.input.mediaRevision,
      });
      return;
    }
    if (exportId === null) {
      readings.failed += 1;
      readings.lastError = 'OBJECT_UNAVAILABLE';
      emit({
        event: 'provider_call_ledger_unresolved',
        code: readings.lastError,
        capability,
        media_id: ctx.input.mediaId,
        media_revision: ctx.input.mediaRevision,
      });
      return;
    }

    // 状态只由「这次调用有没有拿到可用的业务回包」决定：
    // 抛错（含超时）/ 内层自报 `kind: 'failed'` ⇒ send_failed。⛔ 没有第三种状态（0055 没有 blocked）。
    const invocationState: ProviderCallInvocationState =
      ctx.threw || outcomeFailed(ctx.outcome) ? 'send_failed' : 'sent';
    // 用量只在 `sent` 时带：失败/超时那次没有可采信的回包，⛔ 不猜、不补零。
    const usage = invocationState === 'sent' ? readCallMetadata(ctx.outcome) : null;
    const providerConfigVersion = versionOrUnknown(
      (ctx.outcome as { providerConfigVersion?: unknown } | null)?.providerConfigVersion ?? inner.modelVersion,
    );

    try {
      await sink.record({
        domain,
        jobId: typeof ctx.input.jobId === 'string' && ctx.input.jobId !== '' ? ctx.input.jobId : null,
        exportId,
        capability,
        providerConfigVersion,
        modelVersion: versionOrNull(inner.modelVersion),
        invocationState,
        usage,
        sentAt: ctx.sentAt,
        durationMs: ctx.durationMs,
      });
      readings.written += 1;
    } catch (error) {
      readings.failed += 1;
      readings.lastError = errorCodeOf(error) ?? 'PROVIDER_UNAVAILABLE';
      emit({
        event: 'provider_call_ledger_write_failed',
        code: readings.lastError,
        export_id: exportId,
        invocation_state: invocationState,
        capability,
      });
    }
  }

  const wrapped = { ...inner } as Record<string, unknown>;
  wrapped['recognize'] = async (input: {
    jobId: string;
    mediaId: string;
    mediaRevision: number;
  }): Promise<unknown> => {
    const startedAt = now();
    let outcome: unknown = null;
    let failure: unknown = null;
    let threw = false;
    try {
      outcome = await original.call(inner, input);
    } catch (error) {
      threw = true;
      failure = error;
    }
    const finishedAt = now();
    const durationMs = Math.max(0, Math.round(finishedAt - startedAt));
    // 记账是旁路：`recordRow` 自己吞掉全部异常，这里不会因为它提前返回或抛错。
    await recordRow({ input, outcome, threw, durationMs, sentAt: new Date(finishedAt) });
    if (threw) throw failure;
    return outcome;
  };
  return wrapped as unknown as T;
}
