/**
 * GY-R83 · `#1003`：**把「这一次外发烧了多少、用的是哪套剖面」记到账上**的记账层。
 *
 * ## 位置（为什么是「包在提供者外面」而不是改服务层）
 * 识别域的真实外发已经在 `privacy/task-egress.ts::MediaJobEgress.provider()` 的闭包里（那里拿到
 * `exportId` 与 `jobId`，并已完成 `markSent`）。本层**再包一层**，在**同一次调用**的入口/出口计时，
 * 从返回值里读 `usage` 与剖面版本串，写一行 `public.provider_call_ledger`。
 *
 * ## `export_id` 必须在**调用之前**取（P0：取晚了就一行都写不进去）
 * 内层时序是「按对象找预留行 → `linkJob` → `assertExecutable` → **`markSent`** → 调提供者」
 * （`task-egress.ts:121-131`），而 `ledger-pg.ts:690` 的谓词带 `state='reserved'` 与
 * `cancelled_at IS NULL` ⇒ **`markSent` 之后按对象回查恒查不到这一行**。所以本层在
 * `await 内层调用`**之前**读一次 `findReservedByObject`，把 `export_id` 拿在手上，等调用返回后
 * 再按这个 id 写行。反过来（先调、后查）与包在第几层无关：决定成败的是**回查时点**——
 * 实测后果是每一行都折成 `provider_call_ledger_unresolved`、表里恒 0 行。
 * `tests/unit/recognitions-ledger-composition.test.mjs`（真 `createMediaJobEgress` × 真本层）
 * 就是钉这一点的用例：把取 id 挪回调用之后，它必红。
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
   * 读/写**各自**的短预算（毫秒，默认 `ACCOUNTING_BUDGET_MS`）。可注入只为一件事：让「读永不
   * settle ⇒ 作业照发」这类用例不必真等 1.5s。默认值不变，生产装配**不传**。
   */
  budgetMs?: number;
  /**
   * 读数出口：传入的对象会被**就地累加**（`written` / `failed` / `lastError`）。
   * 生产装配**不传**这个对象（本片不开 HTTP 读面）：读数改随**事件**走既有日志出口
   * （每条事件带 `readings_written` / `readings_failed` 两个计数字段，见 `readingFields()`）；
   * 单测与排障注入一个对象即可直接断言计数。
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
 * 记账的**短预算**（毫秒）：读一次预留行、写一行，**各自**最多等这么久（可由 `options.budgetMs` 注入）。
 *
 * **最坏增量 ≈3s，且不改变识别判定**：读预留行发生在调用之前，最多把这次外发**推迟** 1.5s；
 * 写行发生在结果已经拿到之后，最多把返回**再推迟** 1.5s（客户端也套同一个上限）；两者之外还要
 * 加上 `pool.connect()` 取连接的时间 —— 服务端 `statement_timeout` 只在 `BEGIN` 之后生效，
 * 管不到取连接。预算耗尽**只**让 `readings.failed` +1、`lastError = PROVIDER_TIMEOUT`
 * （借既有契约码，⛔ 不新增 ErrorCode），识别结果/异常逐字节不变。
 * 数据库侧另有一份同额度的 `SET LOCAL statement_timeout`（`provider-call-ledger-pg.ts` 的
 * `record({ timeoutMs })`），所以本层不等了以后，服务端也会把那条语句掐掉，不会长期占着连接。
 */
export const ACCOUNTING_BUDGET_MS = 1500;

/** 预算耗尽信号：只借既有契约码（`errorCodeOf` 认得的闭集成员）。 */
function accountingTimeout(): Error {
  return Object.assign(new Error('provider call accounting budget exceeded'), { code: 'PROVIDER_TIMEOUT' });
}

/**
 * 给一次账本读/写套上**上限**：超时后本层不再等它（取消由数据库侧 `statement_timeout` 负责），
 * 底层 Promise 的结局一律被吞掉（连 rejection 一起，⛔ 不留未处理的拒绝）。
 */
function withDeadline<T>(work: Promise<T>, budgetMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(accountingTimeout()), budgetMs);
    timer.unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
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
  const budgetMs = options.budgetMs ?? ACCOUNTING_BUDGET_MS;
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
   * 取这次外发的 `export_id` —— **必须在调用内层之前**跑（理由见文件头「取晚了就一行都写不进去」）。
   *
   * ⛔ 不抛：读失败 / 查不到都折成 `null` + `readings.failed` + 一条安全事件，调用方照常外发。
   */
  async function resolveExportId(input: {
    jobId: string;
    mediaId: string;
    mediaRevision: number;
  }): Promise<string | null> {
    try {
      // 读侧也套客户端上限；底层驱动的 `statement_timeout` 另有 5s 的池级上限。
      const record = await withDeadline(
        source.findReservedByObject({
          objectType: 'media',
          objectId: input.mediaId,
          objectRevision: input.mediaRevision,
        }),
        budgetMs,
      );
      const exportId = typeof record?.id === 'string' && record.id !== '' ? record.id : null;
      if (exportId !== null) return exportId;
      // 查到 null：预留行不存在，或已被 `markSent`（谓词带 `state='reserved'`）⇒ 没有归属行。
      readings.failed += 1;
      readings.lastError = 'OBJECT_UNAVAILABLE';
    } catch (error) {
      // 读预留行失败：这**就是**记账失败（没有 export_id 就没有归属行），但⛔ 不改判识别结果。
      readings.failed += 1;
      readings.lastError = errorCodeOf(error) ?? 'OBJECT_UNAVAILABLE';
    }
    try {
      emit({
        event: 'provider_call_ledger_unresolved',
        code: readings.lastError,
        capability,
        media_id: input.mediaId,
        media_revision: input.mediaRevision,
        ...readingFields(),
      });
    } catch {
      // ⛔ 日志出口是**注入点**（`log: () => { throw }`）：它自己坏了不算业务错误 —— 这里若漏出去，
      // 识别会在**外发之前**被打红（提供者一次都没调到）。只当这一次没记上事件。
    }
    return null;
  }

  /** 事件里带上**累计读数**：生产装配把事件接到既有日志出口，读数因此随事件可见（无需另开读面）。 */
  function readingFields(): Record<string, number> {
    return { readings_written: readings.written, readings_failed: readings.failed };
  }

  /**
   * 写一行记账（本文件**唯一**的写点）。`exportId` 是**调用前**取好的（见 `resolveExportId`）。
   *
   * ⛔ 不抛：任何失败都折成 `readings.failed` + 一条安全事件。调用方（本层的 `recognize`）
   * 因此可以照常返回/抛出**识别**的结果。
   */
  async function recordRow(ctx: {
    input: { jobId: string; mediaId: string; mediaRevision: number };
    exportId: string;
    outcome: unknown;
    threw: boolean;
    durationMs: number;
    sentAt: Date;
  }): Promise<void> {
    const exportId = ctx.exportId;

    // 状态只由「这次调用有没有拿到可用的业务回包」决定：
    // 抛错（含超时）/ 内层自报 `kind: 'failed'` ⇒ send_failed。⛔ 没有第三种状态（0055 没有 blocked）。
    // ⚠ 口径边界：`send_failed` 目前**分不出**「已触达供应商后失败」与「内层在触达之前就拒绝」
    // （`task-egress.ts` 的 `assertExecutable` / `markSent` 抛错时，本层看到的同样是抛错）——
    // 两种都写 `send_failed`，措辞以 0055 该列 COMMENT 为准。
    const invocationState: ProviderCallInvocationState =
      ctx.threw || outcomeFailed(ctx.outcome) ? 'send_failed' : 'sent';
    // 用量只在 `sent` 时带：失败/超时那次没有可采信的回包，⛔ 不猜、不补零。
    const usage = invocationState === 'sent' ? readCallMetadata(ctx.outcome) : null;
    const providerConfigVersion = versionOrUnknown(
      (ctx.outcome as { providerConfigVersion?: unknown } | null)?.providerConfigVersion ?? inner.modelVersion,
    );

    try {
      // 写侧同样套客户端上限：服务端 `statement_timeout` 只在 `BEGIN` 之后生效，管不到取连接。
      await withDeadline(
        sink.record({
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
          timeoutMs: budgetMs,
        }),
        budgetMs,
      );
      readings.written += 1;
    } catch (error) {
      readings.failed += 1;
      readings.lastError = errorCodeOf(error) ?? 'PROVIDER_UNAVAILABLE';
      try {
        emit({
          event: 'provider_call_ledger_write_failed',
          code: readings.lastError,
          export_id: exportId,
          invocation_state: invocationState,
          capability,
          ...readingFields(),
        });
      } catch {
        // ⛔ 同一处注入点：事件出口再抛错，也不许把**已经成功**的识别改判（结果会被整条丢掉）。
      }
    }
  }

  const wrapped = { ...inner } as Record<string, unknown>;
  wrapped['recognize'] = async (input: {
    jobId: string;
    mediaId: string;
    mediaRevision: number;
  }): Promise<unknown> => {
    // ⛔ 这两行的顺序不可换：内层会先 `markSent`，之后按对象回查再也不可能命中（见文件头）。
    const exportId = await resolveExportId(input);
    // `startedAt` = 外发**进入**时刻：它既是 `sent_at`（0055 :362-363 的口径），也是耗时起点。
    // ⛔ 必须在读账本**之后**取：读预留行是本层自己的前置开销，算进 `duration_ms` 会把 provider 段撑大。
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
    if (exportId !== null) {
      await recordRow({ input, exportId, outcome, threw, durationMs, sentAt: new Date(startedAt) });
    }
    if (threw) throw failure;
    return outcome;
  };
  return wrapped as unknown as T;
}
