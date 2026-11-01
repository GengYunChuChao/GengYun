/**
 * GY-R72 W41 · 审核域的**持久幂等台账**（迁移 `0051_moderation_idempotency.sql`）。
 *
 * ⛔ 本文件**不接线**：`services/api/src/moderation/service.ts` / `app.ts` 一个字节都没改，
 * 内存实现与 PG 实现都只是「可注入的形制」，真正把取消端点接上台账是 W42 的事。
 * 因此本片**不改变任何运行行为**，只把「回放要落到哪张表、五条语句长什么样、缺表时怎么失败」钉死。
 *
 * ## 为什么需要它（成文登记的开放问题，不是顺手加的台账）
 *
 * 审核域取消端点**要求** `Idempotency-Key`，却从不回放：`service.ts:1187` 只走
 * `requireCancelIdempotencyKey`（`:357-360`，长度 8..128，非法即 400 `IDEMPOTENCY_KEY_REQUIRED`）。
 * `service.ts:270-271` 自陈「本域没有幂等台账」。缺口与两条出路写在
 * `docs/verification/gy-r71-job-cancel-modes-20261030.md:67`：
 *
 *   > 本域没有幂等台账；要回放要么内存表（重启即丢）、要么加迁移和列。
 *
 * 内存表被这条理由否掉了（重启即丢 ⇒ 同键重放在重启后变成一次新的副作用，而取消的副作用
 * ——判定台账、审计、下架——不可重放），所以走「迁移 + 列」：本文件就是那条路的存储层。
 *
 * ## 口径（与 OCR 域同一套 fail-closed，逐条对齐，不是"大致等价"）
 *
 * 形制照 `ocr/store.ts` + `ocr/store-pg.ts`：五个方法各是**一条**语句，
 * `claimIdempotent` 的「检查 + 写入」是单条 `INSERT … ON CONFLICT (scope, key_hash) DO UPDATE
 * … WHERE public.moderation_idempotency.expires_at <= $7 RETURNING scope`：
 *   - 行存在且**未到期** ⇒ 不更新、不返回行 ⇒ `'exists'`（覆盖不到 ⇒ 不抢占）；
 *   - 行不存在、或已到期（`expires_at <= at`）⇒ 写入/就地重占并返回行 ⇒ `'claimed'`。
 * 因此**并发下只有一个调用方拿到 `claimed`**（与内存实现「检查与写入之间没有 await」同义），
 * 也不存在「先 SELECT 再 INSERT」的检查-写入窗口。
 * 先删过期行再插是**错**的：那会让两个同键请求都判定「不存在」而同时执行副作用。
 *
 * `findIdempotent` **不按过期过滤**（与 `ocr`/`speech` 两处台账同口径）：过期判定只发生在 claim，
 * 读面把「过期行还在」如实交出，是否视作不存在由上层（W42 的接线处）决定 —— 存储层不替调用方
 * 决定业务语义，这也是本文件不判 409 的原因（见下）。
 *
 * **存储层不判 409**：`claimIdempotent` 返回 `'exists'` 时，**调用方**再去 `findIdempotent` 比对
 * `requestHash`：同键同体 ⇒ 回放既有结果；同键不同体 ⇒ 409（这是 HTTP 语义，不该藏在 SQL 层）。
 *
 * ## fail-closed（缺表 ≠ 数据库故障，也 ≠ 可以放行）
 *
 * - **读类**（`findIdempotent` / `purgeIdempotent` 的返回行读取）：表不存在 ⇒ 视作「没有已持久化的
 *   幂等记录」⇒ `findIdempotent` 返回 `null`、`purgeIdempotent` 返回 `0`；
 * - **写类**（`claimIdempotent` / `finalizeIdempotent` / `releaseIdempotent`）：表不存在 ⇒ 抛
 *   {@link ModerationIdempotencyTablesMissingError}（点名迁移号），⛔ 绝不静默丢写、⛔ 绝不退化成内存 store；
 * - 探测**结果未知**（连不上/超时/应答形状读不懂）⇒ 抛（fail-closed），⛔ 不缓存、⛔ 不当成 `missing`。
 *
 * 探不动的结论与 OCR 域同一句话：**未知 ≠ 未迁移**。把「探不了」判成「没装」正是 #282 的缺陷形状。
 *
 * ## 错误折叠（与 `ocr/store-pg.ts` / `messages/store-pg.ts` 逐条同口径）
 *
 * `57014`（语句超时）/`55P03`（锁不可得）⇒ `PROVIDER_TIMEOUT`；其余数据库异常 ⇒
 * `PROVIDER_UNAVAILABLE`，`retryable` 走 `isTransientDatabaseError`（连接层 08xxx、串行化 40001、
 * 死锁 40P01 ⇒ true；42501 / 3D000 / 28P01 / 42P01 / 42883 与无法归类者 ⇒ false）。
 */
import { ApiError } from '../errors.ts';
import { isTransientDatabaseError } from '../db/pool.ts';

/**
 * 台账一行（camelCase）。
 *
 * `scope` / `keyHash` 两个键列也放进记录里：调用方拿到行之后要按 `requestHash` 判 409，
 * 而排查时最常问的正是「这行属于哪个 scope」—— 让它们跟着行走，比回头再传一遍参数安全。
 */
export interface ModerationIdempotencyRow {
  /** `scope = `<主体>\n<METHOD>\n<路径>``（沿用 `auth/idempotency.ts` 口径）。 */
  scope: string;
  /** 幂等键的 HMAC 摘要（hex；明文键不落库）。 */
  keyHash: string;
  /** 请求体摘要：同键不同体是客户端的错（409），不是覆盖。 */
  requestHash: string;
  /** 首次请求的回放载荷（`pending = false` 后即为可回放的结果）。 */
  payload: Record<string, unknown>;
  /** `true` = 已原子占位、业务尚未完成（并发同键请求必须让路）。 */
  pending: boolean;
  /** 过期时刻：`purgeIdempotent` 按它物理删，`claimIdempotent` 按它就地重占。 */
  expiresAt: Date;
}

/** 审核域幂等台账的存储接口（五个方法，与 OCR 域的签名逐字同形）。 */
export interface ModerationIdempotencyStore {
  /** 按 `(scope, key_hash)` 读一行；**不按过期过滤**（过期判定只在 claim）。不存在 ⇒ `null`。 */
  findIdempotent(scope: string, keyHashHex: string): Promise<ModerationIdempotencyRow | null>;
  /**
   * 原子占位：行不存在或已过期 ⇒ 写入/就地重占并返回 `'claimed'`；
   * 行存在且**未过期** ⇒ 什么都不写、返回 `'exists'`（由调用方比对 `requestHash` 决定回放还是 409）。
   */
  claimIdempotent(
    scope: string,
    keyHashHex: string,
    row: ModerationIdempotencyRow,
    at: Date,
  ): Promise<'claimed' | 'exists'>;
  /** 占位落定：写回放载荷并把 `pending` 置 `false`。行不存在 ⇒ 空操作。 */
  finalizeIdempotent(
    scope: string,
    keyHashHex: string,
    payload: Record<string, unknown>,
  ): Promise<void>;
  /**
   * 释放占位（**必须**调用）：首请求在 `claim` 之后失败时若不释放，那个键会被永久占成 `pending`，
   * 后续同键请求永远 409。行不存在 ⇒ 空操作。
   */
  releaseIdempotent(scope: string, keyHashHex: string): Promise<void>;
  /** 过期清理：物理删除 `expires_at <= now` 的行，返回删除行数。 */
  purgeIdempotent(now: Date): Promise<number>;
}

// ---------------------------------------------------------------------------
// 内存实现
// ---------------------------------------------------------------------------

/**
 * 内存实现（与 PG 实现的**对外语义逐条相同**，唯一的差别是「重启即丢」）。
 *
 * 用途有两个，都在 W42 之前：① 没配池时的默认实现（与 `ocr`/`speech` 两域的工厂同形）；
 * ② 本片单测的语义基准 —— PG 实现的每条行为都要在这里能找到对照。
 */
export function createMemoryModerationIdempotencyStore(): ModerationIdempotencyStore {
  const rows = new Map<string, ModerationIdempotencyRow>();

  /** 复合键：`\u0000` 不可能出现在 scope（scope 是 `<主体>\n<METHOD>\n<路径>`）或 hex 摘要里。 */
  const composite = (scope: string, keyHashHex: string): string => `${scope}\u0000${keyHashHex}`;

  /** 出参一律深拷一层 payload：调用方改返回值不得改到"库"里的行（与 OCR 同口径）。 */
  const copy = (row: ModerationIdempotencyRow): ModerationIdempotencyRow => ({
    ...row,
    payload: { ...row.payload },
  });

  return {
    async findIdempotent(scope, keyHashHex) {
      const row = rows.get(composite(scope, keyHashHex));
      return row === undefined ? null : copy(row);
    },

    async claimIdempotent(scope, keyHashHex, row, at) {
      const existing = rows.get(composite(scope, keyHashHex));
      // 未过期 ⇒ 不覆盖、不抢占（`>`：恰好到期的那一刻算"已过期"，与 PG 的 `expires_at <= $7` 同侧）。
      // JS 单线程：检查+写入之间没有 await，等价于 PG 那条单语句的原子性。
      if (existing !== undefined && existing.expiresAt.getTime() > at.getTime()) return 'exists';
      rows.set(composite(scope, keyHashHex), copy({ ...row, scope, keyHash: keyHashHex }));
      return 'claimed';
    },

    async finalizeIdempotent(scope, keyHashHex, payload) {
      const key = composite(scope, keyHashHex);
      const row = rows.get(key);
      if (row === undefined) return; // 空操作：过期清理/释放之后才到的 finalize 不得凭空造行
      rows.set(key, { ...row, payload: { ...payload }, pending: false });
    },

    async releaseIdempotent(scope, keyHashHex) {
      rows.delete(composite(scope, keyHashHex));
    },

    async purgeIdempotent(now) {
      let removed = 0;
      for (const [key, row] of rows) {
        if (row.expiresAt.getTime() <= now.getTime()) {
          rows.delete(key);
          removed += 1;
        }
      }
      return removed;
    },
  };
}

// ---------------------------------------------------------------------------
// PG 实现
// ---------------------------------------------------------------------------

/** `pg` 连接池的最小形状（与 `db/pool.ts` 的 `PgPool` 结构兼容；测试可传记录型假池）。 */
export interface SqlRunner {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface PostgresModerationIdempotencyStoreOptions {
  pool: SqlRunner;
}

/**
 * **「审核幂等台账表未迁移（0051）」** —— 与「数据库故障」严格区分的一类明确错误。
 *
 * 写类遇到它必须**抛**：静默丢写会让「同键重放」在重启后变成一次新的副作用，而审核域的副作用
 * （判定台账 / 审计 / 下架）不可重放。`retryable: false`：这是部署/迁移未执行，重试不会好。
 *
 * 与 OCR 域同一套口径（`ocr/store-pg.ts` 的 `OcrTablesMissingError`）：读类 ⇒ `null`，
 * 写类 ⇒ 明确 fail-closed，⛔ 不退化成内存 store。
 */
export class ModerationIdempotencyTablesMissingError extends ApiError {
  constructor() {
    super(
      'PROVIDER_UNAVAILABLE',
      '审核幂等台账表未迁移（0051_moderation_idempotency.sql）：拒绝写入，避免静默丢数据',
      { retryable: false },
    );
    this.name = 'ModerationIdempotencyTablesMissingError';
  }
}

/** 数据库异常的契约化折叠（与 `ocr/store-pg.ts` / `messages/store-pg.ts` 同口径）。 */
export function classifyModerationIdempotencyDatabaseError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && ['57014', '55P03'].includes(code)) {
    throw new ApiError('PROVIDER_TIMEOUT', '审核幂等台账数据库响应超时', { retryable: true });
  }
  throw new ApiError('PROVIDER_UNAVAILABLE', '审核幂等台账数据库暂不可用', {
    retryable: isTransientDatabaseError(error),
  });
}

/**
 * `42P01`（`undefined_table`）＝「这条 SQL 指向的表不在」。本文件所有语句都写成
 * `public.moderation_idempotency` **全限定**形式，因此它只可能表示「0051 未应用（或刚被回滚）」，
 * 不会被 `search_path` 差异误判 ⇒ 可安全地翻成 {@link ModerationIdempotencyTablesMissingError}。
 */
const UNDEFINED_TABLE = '42P01';
const isUndefinedTable = (error: unknown): boolean =>
  (error as { code?: unknown } | null)?.code === UNDEFINED_TABLE;

/**
 * 迁移 `0051` 的**只读就绪探测**。
 *
 * 用 `to_regclass(...)` 而不是 `SELECT 1 FROM public.moderation_idempotency`：表不存在时它返回
 * `NULL`（**不报错**），且**不依赖表级 SELECT 权限**；schema 全限定 ⇒ 运行时角色受限的
 * `search_path` 也解析得到（与 `ocr/store-pg.ts` / `admin/ops/flags-pg.ts` 同口径）。
 */
const TABLES_READY_SQL =
  "SELECT (to_regclass('public.moderation_idempotency') IS NOT NULL) AS ready";

/**
 * 五条语句（每条一个方法）。列清单是这一层的**唯一真源**：
 * `20-login-roles.sql` 的 `gy-r72-moderation-idempotency-grant` 区、`90-assert` 的三处登记、
 * `sql-column-coverage` 的列覆盖，全部由它们逐列反推 —— 改语句必须同步那三处，否则门禁红。
 */
export const MODERATION_IDEMPOTENCY_SQL = {
  /** findIdempotent：**不按过期过滤**（过期判定只在 claim）。 */
  find: `SELECT request_hash, payload, pending, expires_at
  FROM public.moderation_idempotency
 WHERE scope = $1 AND key_hash = $2`,
  /**
   * claimIdempotent：单条语句完成「检查 + 占位」。`WHERE … expires_at <= $7` 是**唯一的**抢占条件
   * —— 少了它，任何一次 claim 都会把既有行（含未过期的回放结果）覆盖掉，同键同体的重放会变成
   * 「覆盖 + 再执行一次副作用」。`RETURNING scope` 零行 ⇔ 未抢占 ⇒ `'exists'`。
   */
  claim: `INSERT INTO public.moderation_idempotency
         (scope, key_hash, request_hash, payload, pending, expires_at)
  VALUES ($1, $2, $3, $4::jsonb, $5, $6::timestamptz)
ON CONFLICT (scope, key_hash) DO UPDATE
   SET request_hash = EXCLUDED.request_hash,
       payload = EXCLUDED.payload,
       pending = EXCLUDED.pending,
       expires_at = EXCLUDED.expires_at
 WHERE public.moderation_idempotency.expires_at <= $7::timestamptz
RETURNING scope`,
  /** finalizeIdempotent：只写 `payload` / `pending`（其余列是键与过期时刻，结案不改）。 */
  finalize: `UPDATE public.moderation_idempotency
   SET payload = $3::jsonb, pending = false
 WHERE scope = $1 AND key_hash = $2`,
  /** releaseIdempotent：整行删（失败首请求的占位必须能撤，否则该键永久 409）。 */
  release: `DELETE FROM public.moderation_idempotency
 WHERE scope = $1 AND key_hash = $2`,
  /** purgeIdempotent：过期物理删（`RETURNING scope` 只为数行数，不读业务列）。 */
  purge: `DELETE FROM public.moderation_idempotency
 WHERE expires_at <= $1::timestamptz
RETURNING scope`,
} as const;

function asDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

/** `jsonb` 列 → 对象（只接受对象：迁移上有 `jsonb_typeof(payload) = 'object'` 的 CHECK）。 */
function readPayload(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    const parsed: unknown = JSON.parse(value);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  }
  return {};
}

function rowFromDb(
  row: Record<string, unknown>,
  scope: string,
  keyHashHex: string,
): ModerationIdempotencyRow {
  return {
    scope,
    keyHash: keyHashHex,
    requestHash: String(row['request_hash']),
    payload: readPayload(row['payload']),
    pending: row['pending'] === true,
    expiresAt: asDate(row['expires_at']),
  };
}

/** 就绪探测的三态：`unknown`（探不了）**不是** `missing`（确认没有）。 */
export type ModerationIdempotencyTablesProbe = 'ready' | 'missing' | 'unknown';

export function createPgModerationIdempotencyStore({
  pool,
}: PostgresModerationIdempotencyStoreOptions): ModerationIdempotencyStore {
  /**
   * 就绪状态的**缓存**：只缓存**确定结论**（`ready` / `missing`）。`null` = 未探过（或探测结果未知、
   * 或 42P01 后失效）⇒ 下一次调用重探。⛔ `unknown` 绝不写入本缓存。
   */
  let tables: 'ready' | 'missing' | null = null;
  /** 最近一次探测失败的原因（只用于「未知」时保持既有错误分类；不参与缓存判断）。 */
  let probeFailure: unknown = null;

  /** 只读就绪探测（**不抛**：任何失败都以 `unknown` 返回，由调用方决定 fail-closed 策略）。 */
  async function probeTables(): Promise<ModerationIdempotencyTablesProbe> {
    probeFailure = null;
    let rows: unknown;
    try {
      rows = (await pool.query(TABLES_READY_SQL)).rows;
    } catch (error) {
      // 权限/连接/超时：**状态未知**。⛔ 不得返回 `missing`（那会把故障判成"未迁移"而放行读）。
      probeFailure = error;
      return 'unknown';
    }
    if (!Array.isArray(rows) || rows.length === 0) return 'unknown';
    const ready = (rows[0] as Record<string, unknown> | null | undefined)?.['ready'];
    if (ready === true) return 'ready';
    if (ready === false) return 'missing';
    return 'unknown'; // 形状读不懂 ⇒ 不知道表在不在 ⇒ 未知（既不是"未就绪"，更不是"可以放行"）
  }

  /** 取就绪状态（带缓存）。`unknown` ⇒ 抛（fail-closed），⛔ 不缓存、⛔ 不当成 `missing`。 */
  async function tablesReady(): Promise<'ready' | 'missing'> {
    if (tables !== null) return tables;
    const state = await probeTables();
    if (state === 'unknown') {
      if (probeFailure !== null) classifyModerationIdempotencyDatabaseError(probeFailure);
      // 只剩「应答形状读不懂」：确定性缺陷，同一请求重试永远不会变好 ⇒ retryable:false。
      throw new ApiError(
        'PROVIDER_UNAVAILABLE',
        '审核幂等台账表就绪探测结果未知（应答形状无法识别）：按数据库故障 fail-closed（未知 ≠ 未迁移）',
        {
          retryable: false,
          details: [{ field: 'moderation_idempotency', code: 'PROBE_SHAPE_UNKNOWN' }],
        },
      );
    }
    tables = state;
    return state;
  }

  /** 写类的前置门：表不存在 ⇒ 明确 fail-closed（绝不静默丢写、绝不退化成内存 store）。 */
  async function requireTables(): Promise<void> {
    if ((await tablesReady()) === 'missing') throw new ModerationIdempotencyTablesMissingError();
  }

  async function run(text: string, values?: unknown[]): Promise<Array<Record<string, unknown>>> {
    try {
      const result = await pool.query(text, values);
      return result.rows;
    } catch (error) {
      if (isUndefinedTable(error)) {
        // 探测之后表被回滚/恢复不完整：失效缓存，下一次调用重探；本语句按「未迁移」处理。
        tables = null;
        throw new ModerationIdempotencyTablesMissingError();
      }
      return classifyModerationIdempotencyDatabaseError(error);
    }
  }

  /**
   * 读类：表未迁移 ⇒ `null`（等价于「没有已持久化的幂等记录」）；
   * **真数据库故障照旧抛**（不被这一层吞掉）。
   */
  async function readOrMissing<T>(work: () => Promise<T | null>): Promise<T | null> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ModerationIdempotencyTablesMissingError) return null;
      throw error;
    }
  }

  return {
    // 读类：表未迁移 ⇒ null（与"没有已持久化的幂等记录"同形）。
    async findIdempotent(scope, keyHashHex) {
      if ((await tablesReady()) === 'missing') return null;
      return readOrMissing(async () => {
        const rows = await run(MODERATION_IDEMPOTENCY_SQL.find, [scope, keyHashHex]);
        const row = rows[0];
        return row === undefined ? null : rowFromDb(row, scope, keyHashHex);
      });
    },

    // 写类：表未迁移 ⇒ 明确 fail-closed（⛔ 不静默丢写）。
    async claimIdempotent(scope, keyHashHex, row, at) {
      await requireTables();
      const rows = await run(MODERATION_IDEMPOTENCY_SQL.claim, [
        scope,
        keyHashHex,
        row.requestHash,
        JSON.stringify(row.payload),
        row.pending,
        row.expiresAt,
        at,
      ]);
      // 零行 ⇔ `WHERE … expires_at <= $7` 没命中（行存在且未过期）⇒ 没抢占。
      return rows.length > 0 ? 'claimed' : 'exists';
    },

    async finalizeIdempotent(scope, keyHashHex, payload) {
      await requireTables();
      await run(MODERATION_IDEMPOTENCY_SQL.finalize, [
        scope,
        keyHashHex,
        JSON.stringify(payload),
      ]);
    },

    async releaseIdempotent(scope, keyHashHex) {
      await requireTables();
      await run(MODERATION_IDEMPOTENCY_SQL.release, [scope, keyHashHex]);
    },

    // 读类（返回行数）：表未迁移 ⇒ 0 行被清理（与"没有过期记录"同形）。
    async purgeIdempotent(now) {
      if ((await tablesReady()) === 'missing') return 0;
      const purged = await readOrMissing(async () => {
        const rows = await run(MODERATION_IDEMPOTENCY_SQL.purge, [now]);
        return rows.length;
      });
      return purged ?? 0;
    },
  };
}
