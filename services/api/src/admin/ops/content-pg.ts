/**
 * 后台资料域（内容/资料）：**真库落点**（`Refs #18`）。
 *
 * ## 解决什么问题
 * 接线前，四类资料（`sources` / `knowledge` / `registrations` / `restrictions`）的
 * 实体、修订与幂等台账全在进程内 `Map`（`admin/store.ts`，自述 `persistent: false`），
 * 所以 `real` 模式下这些路由只能整体 fail-closed 返回 503。本文件把它们落到迁移
 * `0036_r34_admin_content_persistence.sql` 的三张表：
 *
 * | 表 | 存什么 |
 * |---|---|
 * | `admin_content_entities` | 实体 + 生命周期（draft/published/withdrawn）与发布/撤回留痕 |
 * | `admin_content_revisions` | 只可追加的修订（PK `(entity_id, revision)`） |
 * | `admin_content_idempotency` | 幂等台账（PK `(scope, key_hash)`，形态同 `favorites_idempotency`） |
 *
 * ## 三条与内存实现**逐字对齐**的纪律
 * 1. **每次真读库，不做跨请求缓存**：`getEntity` / `listEntities` 每次都发查询。
 *    与 `community/store-pg.ts` 同一承诺 —— 后台改了立刻能被下一次读取看到，不靠清缓存。
 * 2. **修订只可追加**：`appendRevision` 只 `INSERT`，从不 `UPDATE` 既有修订；
 *    配合同一实体上的行锁（`SELECT … FOR UPDATE`）与 PK，重复编号直接被库拒绝。
 * 3. **写路径原子**：`transaction()` 开真事务（`BEGIN`/`COMMIT`/`ROLLBACK`），
 *    并在 `AsyncLocalStorage` 里绑定**同一个连接** —— 否则并发请求会串到别人的事务上。
 *
 * ## 不在这里做的事（如实说明）
 * - **审计台账仍是进程内**：`admin_audit_events` 对运行时角色**零权限**（0017/0020/0027），
 *   写入只能走独立的窄函数，属另一片。这里注入 `runtime.audit`（内存追加、只增不改），
 *   因此 `listAuditEvents` 的记录**重启即丢**，与接线前完全一致 —— 不假装已落库。
 * - 不做 `SECURITY DEFINER` 函数：本域是常规 CRUD，**列级** `SELECT/INSERT/UPDATE` 足够，
 *   且**不授** `DELETE`/`TRUNCATE`/`REFERENCES`/`TRIGGER`（见 20-login-roles.sql 的 `gy-r34-content-grant` 段）。
 * - 不做跨家族级联删除：撤回 = 状态迁移，不是删行（契约闭集里也没有删除操作）。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ApiError } from '../../errors.ts';
import { isTransientDatabaseError } from '../../db/pool.ts';
import type { PgPool } from '../../db/pool.ts';
import { createAdminRuntime } from '../runtime.ts';
import type { AdminRuntime, IdempotencyClaimInput, IdempotencyLedgerRow, IdempotencySettledRecord } from '../runtime.ts';
import type { AuditLog } from '../audit.ts';
import type { AdminContentStoreLike } from '../store.ts';
import type { AdminFamily, ContentIdempotencyOutcome, StoredEntity, StoredRevision } from '../types.ts';

/** 事务作用域内的连接：`transaction()` 里所有查询必须走它，否则不在同一事务。 */
/**
 * 事务绑定连接的**最小面**（`pg.PoolClient` 结构上满足）。
 *
 * 为什么不写 `Awaited<ReturnType<PgPool['connect']>>`：`connect` 有重载，`ReturnType`
 * 取到的是回调形式的 `void` 重载 ⇒ 推出 `void`，`client.query` 直接报"不存在于 never"。
 * 这里只声明真正用到的两个成员（`query` / `release`），边界处一次显式断言。
 */
interface PgClient {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: unknown[] }>;
  release(): void;
}


interface EntityRow {
  id: string;
  family: string;
  steward_id: string;
  lifecycle: string;
  published_revision: number | null;
  published_at: Date | null;
  published_by_id: string | null;
  published_evidence_ref: string | null;
  published_reason: string | null;
  withdrawn_at: Date | null;
  withdrawn_by_id: string | null;
  withdrawn_reason: string | null;
  created_at: Date;
}

interface RevisionRow {
  entity_id: string;
  revision: number;
  content: unknown;
  author_id: string;
  derived_from_revision: number | null;
  created_at: Date;
}

interface IdempotencyRow {
  scope: string;
  key_hash: string;
  request_hash: string;
  response_status: number;
  outcome: ContentIdempotencyOutcome | null;
  expires_at: Date;
}

const ENTITY_COLUMNS =
  'id, family, steward_id, lifecycle, published_revision, published_at, published_by_id, ' +
  'published_evidence_ref, published_reason, withdrawn_at, withdrawn_by_id, withdrawn_reason, created_at';

const REVISION_COLUMNS = 'entity_id, revision, content, author_id, derived_from_revision, created_at';
const IDEMPOTENCY_COLUMNS = 'scope, key_hash, request_hash, response_status, outcome, expires_at';

/** 数据库异常统一折叠成契约闭集内的 503/504，与社区/消息/收藏同口径。 */
function foldDatabaseError(error: unknown): never {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && (code === '57014' || code === '55P03')) {
    throw new ApiError('PROVIDER_TIMEOUT', '后台资料库响应超时', { retryable: true });
  }
  if (error instanceof ApiError) throw error;
  throw new ApiError('PROVIDER_UNAVAILABLE', '后台资料库暂不可用', {
    retryable: isTransientDatabaseError(error),
  });
}

/** 契约闭集内的 family / lifecycle 才允许落库（库里的 CHECK 是最后一道，这里是快速失败）。 */
function assertFamily(family: string): AdminFamily {
  if (family === 'sources' || family === 'knowledge' || family === 'registrations' || family === 'restrictions') {
    return family;
  }
  throw new ApiError('PROVIDER_UNAVAILABLE', `资料家族不在契约闭集内：${family}`, { retryable: false });
}

function assertLifecycle(lifecycle: string): StoredEntity<unknown>['lifecycle'] {
  if (lifecycle === 'draft' || lifecycle === 'published' || lifecycle === 'withdrawn') return lifecycle;
  throw new ApiError('PROVIDER_UNAVAILABLE', `资料生命周期不在契约闭集内：${lifecycle}`, { retryable: false });
}

/** 行 → 修订（每次从库里读出来都是新对象，不与任何请求共享引用）。 */
function toRevision(row: RevisionRow): StoredRevision<unknown> {
  return {
    revision: row.revision,
    content: row.content,
    createdAt: row.created_at,
    authorId: row.author_id,
    derivedFromRevision: row.derived_from_revision,
  };
}

function toEntity(row: EntityRow, revisions: StoredRevision<unknown>[]): StoredEntity<unknown> {
  return {
    id: row.id,
    family: assertFamily(row.family),
    stewardId: row.steward_id,
    createdAt: row.created_at,
    revisions,
    publishedRevision: row.published_revision,
    lifecycle: assertLifecycle(row.lifecycle),
    publishedAt: row.published_at,
    publishedById: row.published_by_id,
    publishedEvidenceRef: row.published_evidence_ref,
    publishedReason: row.published_reason,
    withdrawnAt: row.withdrawn_at,
    withdrawnById: row.withdrawn_by_id,
    withdrawnReason: row.withdrawn_reason,
  };
}

export interface PostgresAdminContentStoreOptions {
  pool: PgPool;
  /**
   * 审计台账。缺省用内存实现（`createAdminRuntime().audit`）：`admin_audit_events`
   * 对运行时零权限，落库要另开窄函数，属另一片 —— 这里**不**假装已落库。
   */
  audit?: AuditLog;
  runtime?: AdminRuntime;
}

export function createPostgresAdminContentStore(options: PostgresAdminContentStoreOptions): AdminContentStoreLike {
  const { pool } = options;
  const runtime = options.runtime ?? createAdminRuntime();
  const audit = options.audit ?? runtime.audit;
  const scope = new AsyncLocalStorage<PgClient>();

  /** 事务内的查询走绑定连接；事务外走池。两者都是"真读库"。 */
  async function query<Row>(text: string, values: readonly unknown[] = []): Promise<Row[]> {
    const bound = scope.getStore();
    try {
      const result = bound === undefined
        ? await pool.query(text, values as unknown[])
        : await bound.query(text, values as unknown[]);
      return result.rows as Row[];
    } catch (error) {
      foldDatabaseError(error);
    }
  }

  async function revisionsOf(entityIds: readonly string[]): Promise<Map<string, StoredRevision<unknown>[]>> {
    const grouped = new Map<string, StoredRevision<unknown>[]>();
    if (entityIds.length === 0) return grouped;
    const rows = await query<RevisionRow>(
      `SELECT ${REVISION_COLUMNS} FROM public.admin_content_revisions
        WHERE entity_id = ANY($1::uuid[])
        ORDER BY entity_id ASC, revision ASC`,
      [entityIds],
    );
    for (const row of rows) {
      const list = grouped.get(row.entity_id);
      if (list === undefined) grouped.set(row.entity_id, [toRevision(row)]);
      else list.push(toRevision(row));
    }
    return grouped;
  }

  /**
   * 列清单 + 过滤条件都写成**整条静态语句**（不拼 `WHERE` 片段）：
   * 这样每条语句的列面/表面对 `tests/unit/sql-column-coverage.test.mjs` 的解析器完全可判，
   * 不会多出一条"不可判插值"要登记进 allowlist。
   */
  async function selectEntities(sql: string, values: readonly unknown[]): Promise<readonly StoredEntity<unknown>[]> {
    // 稳定游标：按 id 升序（与内存实现逐字相同，游标才可跨实现互换）。
    const rows = await query<EntityRow>(sql, values);
    const revisions = await revisionsOf(rows.map((row) => row.id));
    return Object.freeze(rows.map((row) => toEntity(row, revisions.get(row.id) ?? [])));
  }

  /**
   * 生命周期落库：发布/撤回的全部字段一次写回（服务层先改内存对象，再调这里）。
   * 目标行不存在 ⇒ 503（宁可报错也不静默丢写）。
   */
  async function commitLifecycle(entity: StoredEntity<unknown>): Promise<void> {
    const rows = await query<{ id: string }>(
      `UPDATE public.admin_content_entities
          SET lifecycle = $2,
              published_revision = $3,
              published_at = $4,
              published_by_id = $5,
              published_evidence_ref = $6,
              published_reason = $7,
              withdrawn_at = $8,
              withdrawn_by_id = $9,
              withdrawn_reason = $10
        WHERE id = $1::uuid
        RETURNING id`,
      [
        entity.id,
        entity.lifecycle,
        entity.publishedRevision,
        entity.publishedAt,
        entity.publishedById,
        entity.publishedEvidenceRef,
        entity.publishedReason,
        entity.withdrawnAt,
        entity.withdrawnById,
        entity.withdrawnReason,
      ],
    );
    if (rows.length !== 1) {
      throw new ApiError('PROVIDER_UNAVAILABLE', '资料生命周期未落库（目标行不存在）', { retryable: false });
    }
  }

  return {
    persistent: true,
    audit,

    async transaction<T>(work: () => T | Promise<T>): Promise<T> {
      // 嵌套调用（服务层已在外层事务里）直接并入，绝不开第二个连接。
      if (scope.getStore() !== undefined) return work();
      let client: PgClient;
      try {
        client = (await pool.connect()) as unknown as PgClient;
      } catch (error) {
        // 连接失败如实折成固定错误类别（PROVIDER_TIMEOUT / PROVIDER_UNAVAILABLE），绝不静默降级。
        foldDatabaseError(error);
      }
      return scope.run(client, async () => {
        try {
          await client.query('BEGIN');
          const result = await work();
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      });
    },

    async createEntity(input) {
      const id = input.id ?? randomUUID();
      const rows = await query<EntityRow>(
        `INSERT INTO public.admin_content_entities (id, family, steward_id, lifecycle, created_at)
         VALUES ($1::uuid, $2, $3, 'draft', $4)
         ON CONFLICT (id) DO NOTHING
         RETURNING ${ENTITY_COLUMNS}`,
        [id, input.family, input.stewardId, input.createdAt],
      );
      const row = rows[0];
      // 与内存实现的 `资料 id 重复` 同义：这里如实报冲突，不静默覆盖既有实体。
      if (row === undefined) throw new Error(`资料 id 重复：${id}`);
      return toEntity(row, []);
    },

    async getEntity(id) {
      // 事务内加行锁：同一实体的并发追加修订串行化，修订编号不会撞车。
      // 锁与不锁是**两条静态语句**（不是一个字符串拼接），列面/表面对静态审计可判。
      const sql =
        scope.getStore() === undefined
          ? `SELECT ${ENTITY_COLUMNS} FROM public.admin_content_entities WHERE id = $1::uuid`
          : `SELECT ${ENTITY_COLUMNS} FROM public.admin_content_entities WHERE id = $1::uuid FOR UPDATE`;
      const rows = await query<EntityRow>(sql, [id]);
      const row = rows[0];
      if (row === undefined) return undefined;
      const revisions = await revisionsOf([row.id]);
      return toEntity(row, revisions.get(row.id) ?? []);
    },

    async listEntities(family, stewardId) {
      return selectEntities(
        `SELECT ${ENTITY_COLUMNS} FROM public.admin_content_entities
          WHERE family = $1 AND steward_id = $2
          ORDER BY id ASC`,
        [family, stewardId],
      );
    },

    async listFamilyEntities(family) {
      return selectEntities(
        `SELECT ${ENTITY_COLUMNS} FROM public.admin_content_entities
          WHERE family = $1
          ORDER BY id ASC`,
        [family],
      );
    },

    async appendRevision(input) {
      const { entity } = input;
      const previous = entity.revisions.at(-1);
      const revision = previous === undefined ? 1 : previous.revision + 1;
      const rows = await query<RevisionRow>(
        `INSERT INTO public.admin_content_revisions
           (entity_id, revision, content, author_id, derived_from_revision, created_at)
         VALUES ($1::uuid, $2, $3::jsonb, $4, $5, $6)
         RETURNING ${REVISION_COLUMNS}`,
        [
          entity.id,
          revision,
          JSON.stringify(input.content ?? null),
          input.authorId,
          input.derivedFromRevision,
          input.createdAt,
        ],
      );
      const row = rows[0];
      if (row === undefined) {
        throw new ApiError('PROVIDER_UNAVAILABLE', '资料修订未写入（内部不变式违反）', { retryable: false });
      }
      return toRevision(row);
    },

    async setLifecycle(entity, lifecycle) {
      entity.lifecycle = lifecycle;
      await commitLifecycle(entity);
    },

    commitLifecycle,

    // ---- 幂等台账：语义与 `auth/idempotency.ts` / `admin/runtime.ts` 的 claim/complete/release 一致 ----
    async findIdempotent(scopeName, keyHash) {
      const rows = await query<IdempotencyRow>(
        `SELECT ${IDEMPOTENCY_COLUMNS} FROM public.admin_content_idempotency
          WHERE scope = $1 AND key_hash = $2 AND outcome IS NOT NULL`,
        [scopeName, keyHash],
      );
      const row = rows[0];
      if (row === undefined || row.outcome === null) return null;
      const settled: IdempotencySettledRecord = {
        requestHash: row.request_hash,
        responseStatus: row.response_status,
        outcome: row.outcome,
        expiresAt: row.expires_at,
      };
      return settled;
    },

    async peekIdempotent(scopeName, keyHash) {
      const rows = await query<IdempotencyRow>(
        `SELECT ${IDEMPOTENCY_COLUMNS} FROM public.admin_content_idempotency WHERE scope = $1 AND key_hash = $2`,
        [scopeName, keyHash],
      );
      const row = rows[0];
      if (row === undefined) return null;
      const ledgerRow: IdempotencyLedgerRow = {
        requestHash: row.request_hash,
        responseStatus: row.response_status,
        outcome: row.outcome,
        expiresAt: row.expires_at,
      };
      return ledgerRow;
    },

    async claimIdempotent(scopeName, keyHash, claim: IdempotencyClaimInput) {
      // 只有**已到期**的旧行才让位（与内存实现一致：未到期的占位/已定型结果都不许抢）。
      const rows = await query<{ scope: string }>(
        `INSERT INTO public.admin_content_idempotency AS ledger
           (scope, key_hash, request_hash, response_status, outcome, expires_at)
         VALUES ($1, $2, $3, $4, NULL, $5)
         ON CONFLICT (scope, key_hash) DO UPDATE
            SET request_hash = EXCLUDED.request_hash,
                response_status = EXCLUDED.response_status,
                outcome = NULL,
                expires_at = EXCLUDED.expires_at
          WHERE ledger.expires_at <= $6::timestamptz
         RETURNING scope`,
        [scopeName, keyHash, claim.requestHash, claim.responseStatus, claim.expiresAt, claim.now],
      );
      return rows.length === 1;
    },

    async completeIdempotent(scopeName, keyHash, outcome, expiresAt) {
      const rows = await query<{ scope: string }>(
        `UPDATE public.admin_content_idempotency
            SET outcome = $3::jsonb, expires_at = $4
          WHERE scope = $1 AND key_hash = $2 AND outcome IS NULL
          RETURNING scope`,
        [scopeName, keyHash, JSON.stringify(outcome), expiresAt],
      );
      return rows.length === 1;
    },

    async releaseIdempotent(scopeName, keyHash) {
      /*
       * 只释放未定型的占位；已定型结果不因后续失败被抹掉。
       *
       * ⛔ 这里**不能**用 DELETE：运行时角色对本表只有列级 SELECT/INSERT/UPDATE（最小权限口径，
       * 见 `20-login-roles.sql` 的 gy-r34-content-grant 段）。等价做法是把占位行的到期时刻推到
       * `-infinity`，于是下一次 `claimIdempotent` 的 `expires_at <= now` 判据立刻让它让位 ——
       * 与内存实现「删掉占位行」对重放方完全等价，且不依赖注入时钟与库时钟的一致。
       */
      await query<never>(
        `UPDATE public.admin_content_idempotency
            SET outcome = NULL, expires_at = '-infinity'::timestamptz
          WHERE scope = $1 AND key_hash = $2 AND outcome IS NULL`,
        [scopeName, keyHash],
      );
    },

    async purgeExpiredIdempotent(now) {
      /*
       * 物理删除同样不可用（无 DELETE 权限）⇒ 把**已到期的已定型结果**清成占位，
       * 让它们对重放方彻底不可见（这正是内存实现"删掉过期行"要达到的效果）。
       * 过期占位本来就不可见，不重复计数。表行数只增不减：物理保留属独立的保留期清理切片，
       * 证据页「未取得」一节如实登记。
       */
      const rows = await query<{ scope: string }>(
        `UPDATE public.admin_content_idempotency
            SET outcome = NULL
          WHERE expires_at <= $1::timestamptz AND outcome IS NOT NULL
          RETURNING scope`,
        [now],
      );
      return rows.length;
    },

    async idempotentCount() {
      const rows = await query<{ count: string }>('SELECT count(*)::text AS count FROM public.admin_content_idempotency');
      return Number(rows[0]?.count ?? '0');
    },
  };
}

/** `randomUUID` 与内存实现同源（`node:crypto`），实体 id 才可互换。 */

/**
 * 就绪探测 SQL（`Refs #18`）：**一次查询、三列布尔**。`to_regclass` 对**不存在的表**返回 `NULL`
 * 而**不报错**，也**不要求表级 SELECT 权限**，且 schema 全限定 ⇒ 不受 `search_path` 影响 ——
 * 与 `flags-pg.ts#probeFeatureFlagsTable` 同一口径（那里是 `public.feature_flags`，这里是 0036 三表）。
 *
 * 为什么是**三列**而不是一条 `AND`（监工 2026-10-25T04:15:22Z 复核，判「需修改」）：三张表在
 * **读面**的地位并不相同。`entities`／`revisions` 是读失效真值的唯一来源；`idempotency` 是
 * **写侧**幂等台账，公开读**根本不碰它**。把三者 `AND` 起来、再"任一 false ⇒ 整域未配置"，
 * 就会出现监工指出的那个错误结论：库里明明存着**已 withdrawn** 的来源（读面数据齐全），只因
 * `admin_content_idempotency` 还没建，就被判成"这域从未配置"，于是 `unverifiable` ⇒ 公开读
 * **可见** ⇒ **下架内容复活**。三列分开读才能把"全域未配置"与"部分 schema 不完整"分开。
 *
 * 写成**静态整句**（不拼插值）：`tests/unit/sql-column-coverage.test.mjs` 才能静态判读列面/表面，
 * 不会多出一条"不可判插值"。
 */
const CONTENT_TABLES_READY_SQL = `SELECT to_regclass('public.admin_content_entities') IS NOT NULL AS entities,
       to_regclass('public.admin_content_revisions') IS NOT NULL AS revisions,
       to_regclass('public.admin_content_idempotency') IS NOT NULL AS idempotency`;

/** 0036 三张表的在场读数（只回答"在不在"，不回答"能不能读"）。 */
export interface AdminContentTables {
  readonly entities: boolean;
  readonly revisions: boolean;
  readonly idempotency: boolean;
}

/**
 * 内容存储就绪**四态**（`Refs #18`；监工复核后从三态改为四态）。
 *
 * - `ready`：**读面所需的两张表**（`entities` + `revisions`）都在 ⇒ 内容域按**已接线**运行
 *   （引用不可用 ⇒ 隐藏；下架/失效**一律不可见**）。⚠ `idempotency` **不参与**这个判定：
 *   它是写侧幂等用的，读面不消费它；把它算进来就是上面那段"下架内容复活"的根因。
 * - `unwired`：三张表**全都不在** ⇒ **全域确认未配置**（子集库、未跑 0036 的部署）⇒
 *   这是**唯一**允许退回接线前行为的形状（`unverifiable` ⇒ 可见、200）。
 * - `incomplete`：**部分存在**（只缺 `revisions`、只缺 `entities`、只有 `idempotency`…）⇒
 *   半套 schema。既**不可以**回落（那会绕过已存来源的失效状态），也**不可以**当真读
 *   （会撞 `42P01`）⇒ 调用方必须**明确 503 fail-closed**。
 * - `unknown`：探测本身出错（连接／超时／权限）或结果形状读不懂 ⇒ **未知 ≠ 未安装**，
 *   调用方**必须**保持 fail-closed，⛔ 不得据此放行，也⛔ 不得混同 `unwired`。
 */
export type AdminContentTablesProbe =
  | { readonly state: 'ready'; readonly tables: AdminContentTables }
  | { readonly state: 'unwired'; readonly tables: AdminContentTables }
  | { readonly state: 'incomplete'; readonly tables: AdminContentTables }
  | { readonly state: 'unknown'; readonly reason: 'no_pool' | 'probe_error' | 'unexpected_shape' };

/**
 * 探测 0036 的三张表是否就绪。**不抛**：任何异常都折成 `unknown`。
 *
 * 与 `foldDatabaseError` 的分工：那个把库错误折成对外 503（用来**拒绝**一次请求），
 * 这个只回答"表在不在"（用来**决定这一域要不要接线／要不要明确拒绝**）。`42P01` 不该在这里
 * 出现（`to_regclass` 不报错），一旦从探测里冒出来说明探测语句本身坏了 ⇒ 同样是 `unknown`。
 */
export async function probeAdminContentTables(
  pool: Pick<PgPool, 'query'> | null | undefined,
): Promise<AdminContentTablesProbe> {
  if (!pool || typeof pool.query !== 'function') return { state: 'unknown', reason: 'no_pool' };
  let rows: unknown;
  try {
    const result = await pool.query(CONTENT_TABLES_READY_SQL);
    rows = result?.rows;
  } catch {
    // 连接/权限/超时：**状态未知**。⛔ 不得返回 `unwired` —— 那会把故障当成"未配置"放行。
    return { state: 'unknown', reason: 'probe_error' };
  }
  // 聚合探测**恰好**一行三列。零行或多行都说明这条语句被换掉了／接口形状变了 ⇒ 读不懂 ⇒ 未知。
  // （多行尤其不能只看第一行：那等于在"结果不合预期"时才按首行裁决定型，会把噪音读成结论。）
  if (!Array.isArray(rows) || rows.length !== 1) return { state: 'unknown', reason: 'unexpected_shape' };
  const row = rows[0] as Record<string, unknown> | null | undefined;
  const entities = row?.['entities'];
  const revisions = row?.['revisions'];
  const idempotency = row?.['idempotency'];
  // 三列**都必须是真布尔**：`'false'` 字符串、`null`、缺键都算"读不懂" ⇒ 未知（⛔ 不得猜成缺表）。
  if (typeof entities !== 'boolean' || typeof revisions !== 'boolean' || typeof idempotency !== 'boolean') {
    return { state: 'unknown', reason: 'unexpected_shape' };
  }
  // 多出来的列说明这条语句被换掉了（不是我们那条三列 SELECT）⇒ 读不懂 ⇒ 未知，⛔ 不得挑着用。
  if (Object.keys(row as object).length !== 3) return { state: 'unknown', reason: 'unexpected_shape' };
  const tables: AdminContentTables = { entities, revisions, idempotency };
  // 读面只消费 entities + revisions；`idempotency` 是写侧台账，缺它不影响"读失效真值"。
  if (entities && revisions) return { state: 'ready', tables };
  // 唯一的"确实没有真值可读"的形状：三张表全都不在。
  if (!entities && !revisions && !idempotency) return { state: 'unwired', tables };
  // 其余任何组合都是半套 schema：不能回落（会绕过已存失效状态），也不能真读（撞 42P01）。
  return { state: 'incomplete', tables };
}
