/**
 * 后台分类目录（`listAdminCategories` / `editCategory`）：**真库端口**（Refs #18）。
 *
 * ## 解决什么问题
 *
 * 接线前这两个 operation 在 `accounts-only.ts:175-176` 是两条字面裸 `reject` ——
 * `execution_mode=real` 时恒 503，与库无关。拆掉裸 reject 只会得到**空页**，而契约明写
 * 「⛔ 不返回空页（空页会被读成「平台没有分类」，那是伪造读数）」⇒ 必须先有真读真写的面。
 * 本文件把读面与写面接到迁移 `0049_admin_categories.sql` 的 `public.admin_categories`
 * （从 `crops`/`species` 回填一次的后台字典正本）。
 *
 * ## 三条与内存实现**逐字对齐**的纪律
 *
 * 1. **每次真读库，不做跨请求缓存**：`listCategories()` 每次发查询，与 `community/store-pg.ts`
 *    同一承诺 —— 后台改了下一次读就能看到，不靠清缓存。
 * 2. **写面用 `revision` 做 CAS，且 CAS 语句就在本文件里**：
 *    `UPDATE … WHERE id = $1 AND revision = $2`（字面量，导出在 `ADMIN_CATEGORY_SQL`）。
 *    ⛔ 不把 CAS 藏进 plpgsql 函数：乐观锁的判定必须能被应用层测试逐字断言
 *    （`tests/unit/admin-categories-pg-wiring.test.mjs` 断言语句与参数顺序）。
 * 3. **写路径原子**：`BEGIN` ⇒ `UPDATE … RETURNING` ⇒ 审计窄函数 ⇒ `COMMIT`；任一步失败整体
 *    `ROLLBACK`（审计写不进去就**不改目录**，客户端拿 503 —— ⛔ 不存在「200 + 已改 + 审计 0 行」）。
 *
 * ## 审计为什么在这里、而不是服务层
 *
 * `public.admin_audit_events` 对运行时是**零表级、零列级写**（`90-assert-least-privilege.sql` 的
 * `external_manifest` 与 `protected_columns` 钉死，表上还有 append-only 触发器），唯一写路径是
 * 迁移 0049 的窄口径 `SECURITY DEFINER` 函数 `public.record_admin_category_update(...)`。
 * 它必须在**同一个事务**里调用（照 `jobs-pg.ts` 的 `cancel()` 与 `community/store-pg.ts` 的
 * `commitPost()` 体例）—— 这正是端口自述 `persistent: true` 的含义：**库内已写审计，
 * 服务层不再补写内存审计**（`⛔ 两处都记 = 一条动作两条审计`）。
 *
 * ## 两份真相：本表是**后台管理面**，用户面目录仍读 `crops`/`species`
 *
 * 目录今天存在两份，这不是本片的疏忽，而是本片刻意选择的**最小改动面**：
 *
 * - **用户面**：`services/api/src/profile/service.ts:65` 读 `public.crops`、
 *   `:78` 读 `public.species`（`GET /catalog/species` 一族）。这条路径本片**一行未改**。
 * - **后台管理面**：本文件读写的 `public.admin_categories`，由迁移 0049 从上面两表
 *   **一次性回填**（`ON CONFLICT (id) DO NOTHING`，重放不会覆盖后台改过的行）。
 * - **两者今天不双写**：`editCategory` 只改 `admin_categories`，**不回写** `crops`/`species`。
 *
 * ### 后果（属已知限制，不是静默缺陷 —— 三处都留了可观测手段）
 *
 * 1. **后台改了名称/停用，用户面看不到变化**：`GET /catalog/**` 仍返回 `crops`/`species`
 *    的原值，直到后续片把用户面切到 `admin_categories`（或在 0049 之后补一条同步迁移）。
 *    这是本片**明确接受**的已知限制：本片的交付目标是把两个恒 503 的 operation 接上真库，
 *    不是重划识别域的正本。
 * 2. **改动本身可数**：后台改过的行 ⇔ `revision > 1` 的行。巡检一条 SQL 就能看到漂移规模：
 *    `SELECT count(*) FROM public.admin_categories WHERE revision > 1;`
 * 3. **漂移可逐行定位**（后台值 vs 用户面正本）：
 *    ```sql
 *    SELECT a.id, a.type, a.name AS admin_name, a.active AS admin_active,
 *           coalesce(c.name, s.canonical_name) AS user_facing_name
 *      FROM public.admin_categories AS a
 *      LEFT JOIN public.crops   AS c ON a.type = 'crop'    AND c.id = a.id
 *      LEFT JOIN public.species AS s ON a.type = 'species' AND s.id = a.id
 *     WHERE (a.type = 'crop'
 *            AND (c.id IS NULL OR c.name IS DISTINCT FROM a.name OR c.active IS DISTINCT FROM a.active))
 *        OR (a.type = 'species'
 *            AND (s.id IS NULL OR s.canonical_name IS DISTINCT FROM a.name))
 *     ORDER BY a.id;
 *    ```
 *    这条查询在**两条真相合流之前**是「已知差异」的清单；合流之后它必须返回 0 行 ——
 *    后续片的切入点就是把它变成一条断言（`admin_categories` 与用户面正本一致）。
 *
 * ## 不在本文件里做的事（如实说明）
 *
 * - **不做**新建/删除分类：契约没有这两个 operation（`CategoryInput` 只有
 *   `name`/`description`/`active`，`type` 不可编辑）⇒ 库里不该出现后台新建的行，
 *   授权面也**没有** `INSERT`/`DELETE`。
 * - **不改** `crops`/`species`：它们是识别域的正本，本片只从它们**单向回填**一次。
 * - **不做**跨表联写：`type` 与 `id` 从建表起就不可变。
 */
import { ApiError } from '../../errors.ts';
import { isTransientDatabaseError } from '../../db/pool.ts';
import type { PgPool } from '../../db/pool.ts';
import type { AdminCategoriesPort, CategoryCommitOutcome, CategoryUpdateAuditInput } from './types.ts';
import type { CategoryInputValue, CategoryView } from './types.ts';

/**
 * 事务绑定连接的**最小面**（`pg.PoolClient` 结构上满足）。
 *
 * 为什么不写 `Awaited<ReturnType<PgPool['connect']>>`：`connect` 有重载，`ReturnType`
 * 取到的是回调形式的 `void` 重载 ⇒ 推成 `void`，`client.query` 直接报「不存在于 never」。
 * 这里只声明真正用到的成员（`query` / `release`），边界处一次显式断言。
 */
interface PgClient {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: unknown[] }>;
  release(): void;
}

/**
 * 本端口对连接池的最小依赖：只需要 `connect()`（读面也走连接，便于用假 client 断言语句序列）。
 * `pg.Pool` 结构上满足。
 */
export interface AdminCategoriesPool {
  connect(): Promise<PgClient>;
}

interface CategoryRow {
  id: string;
  revision: number;
  type: string;
  name: string;
  description: string;
  active: boolean;
}

/**
 * **全部 SQL 都在这里**（字面量、无拼接）。导出给测试逐字断言语句形状与参数顺序；
 * ⛔ 不在调用点拼 `WHERE` 片段、⛔ 不用 `SELECT *`（列清单即授权清单的镜像）。
 */
export const ADMIN_CATEGORY_SQL = Object.freeze({
  /**
   * 读面：按 `id` 有序（游标位置就是 `id`）。契约只有 Cursor + Limit，无过滤参数。
   *
   * ⚠ 分页**不在 SQL 里**（如实记，见本片报告的 N2）：契约的游标是带水位签名的 `content` 形游标
   * （`service.ts` 的 `listWithCursor`：`watermarkOf([...watermarkParts, ...ids])`），水位对
   * **整份 id 序**签名 ⇒ 服务层本来就需要完整 id 列表，SQL 单方面下推 `LIMIT` 会把「集合已变化」
   * 判成假绿（分页游标失去语义）。所以这里一次读全表、由服务层切页；两个契约参数
   * （`cursor`/`limit`）仍逐个生效：`limit` 由 `parseLimit` 收口、非法游标仍抛 `INVALID_CURSOR`。
   * 前提是分类目录是**人工维护的小表**（契约没有过滤参数、授权面也没有 INSERT/DELETE）：
   * 种子实测 12 行。若将来真长到上万行，下推 keyset 分页必须连同水位签名一起改，
   * ⛔ 不能只加一句 `LIMIT`。
   */
  list: 'SELECT id, revision, type, name, description, active FROM public.admin_categories ORDER BY id',
  /**
   * 写面 CAS：`WHERE id = $1 AND revision = $2` —— 参数顺序是 `[id, expectedRevision, name, description, active]`。
   * `revision = revision + 1` 与 `updated_at = now()` 在**同一条**语句里完成（不留两次写的中间态）。
   */
  commit:
    'UPDATE public.admin_categories SET name = $3, description = $4, active = $5, revision = revision + 1, updated_at = now() WHERE id = $1 AND revision = $2 RETURNING id, revision, type, name, description, active',
  /** CAS 落空时区分 404 与 409：只为**判定**读一列，不返回给调用方。 */
  currentRevision: 'SELECT revision FROM public.admin_categories WHERE id = $1',
  /**
   * 审计（迁移 0049 的窄函数）。参数顺序 `[actorId, categoryId, 变更后 revision, requestId]`；
   * 字面量、**无 `FROM`** ⇒ 不触任何表列，只作为函数调用进入 sql 覆盖审计。
   */
  audit: 'SELECT public.record_admin_category_update($1, $2, $3, $4) AS audit_id',
} as const);

/** 事务边界语句也字面量化：假 client 用例要能断言"确实开过事务、且以 COMMIT/ROLLBACK 收尾"。 */
export const ADMIN_CATEGORY_TX = Object.freeze({
  begin: 'BEGIN',
  commit: 'COMMIT',
  rollback: 'ROLLBACK',
});

function textParam(value: unknown): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

/**
 * 把一行库记录投影成契约 `Category`。
 *
 * `type` 走闭集快速失败：库里若有闭集外的值（不该发生，迁移里有 CHECK），
 * 宁可 503 也不把一条**契约违法**的记录当成功返回（照 `content-pg.ts` 的 `assertFamily` 口径）。
 */
function toCategoryView(row: CategoryRow): CategoryView {
  const type = textParam(row.type);
  if (type !== 'crop' && type !== 'species') {
    throw new ApiError('PROVIDER_UNAVAILABLE', '后台分类库返回了契约闭集之外的 type', { retryable: false });
  }
  return {
    id: textParam(row.id),
    revision: Number(row.revision),
    type,
    name: textParam(row.name),
    description: textParam(row.description),
    active: row.active === true,
  };
}

/**
 * 库错误的**唯一出口**（口径与 `accounts-pg.ts` / `flags-pg.ts` / `jobs-pg.ts` 逐字同源）：
 * - `57014`（statement_timeout）/ `55P03`（lock_not_available）⇒ `PROVIDER_TIMEOUT` + **可重试**；
 * - 0049 窄函数的业务码 `G0001`/`G0002`/`G0010` ⇒ `PROVIDER_UNAVAILABLE` + **不可重试**
 *   （运维/权限问题，重试不可能成功）；
 * - 其余 ⇒ `PROVIDER_UNAVAILABLE`，`retryable` 取瞬时性判定。
 *
 * ### 为什么三个 G 码都落 503（N3：如实记口径，不改行为）
 *
 * | 码 | 库里怎么来的 | 语义上更贴的档 | 为什么仍然是 503 |
 * | --- | --- | --- | --- |
 * | `G0001` | 窄函数入参自检（actor/category/revision/requestId 为空）| 500 `INTERNAL_ERROR`（服务端缺陷）| 服务层已按契约校验过入参 ⇒ 这条**理论上不可达**；真触发时「写入没发生」这件事必须让调用方看见，而不是伪装成一次 HTTP 语义错误 |
 * | `G0002` | 操作者行不存在 / 分类行不存在 / 库内 revision 与实参不一致 | 500（数据漂移）或 409（版本）| CAS 已按 `WHERE id=$1 AND revision=$2` 判过 404/409，能走到这里只剩「事务中途行被删/改」这种漂移 ⇒ 与「库不可信」同档，且 ⛔ 不能返回 200 |
 * | `G0010` | 操作者行非 `active` 或缺当前有效 `sources:write` | 403 `FORBIDDEN` | 服务层 `resolveContext` 已经验过一次 scope；运行中被撤权/停用属于**授权面在事务内改变**，此时「这次写入不算数」比「你这个身份不行」更准确 —— 后者会让客户端以为换个 token 重试就能成功 |
 *
 * 为什么不趁本片改成 500/403：那是一次**对外行为变更**（契约两处 description 的失败面措辞、
 * 本片用例 4 的期望码、以及客户端对 503 的既有处理都要同步改），而 N3 是审查列的非阻塞项；
 * 本片按「披露不收敛」处理 —— 口径写在这里，改档留给一个专做错误面收敛的片。
 *
 * ⚠ 两只测试各钉一半，别记混（R68-A01 复查时订正过一句错话）：
 * - `tests/unit/admin-real-mode-fail-closed.test.mjs` 钉的是「**未接线 / 没拿到库池** ⇒ 503 且
 *   `retryable === false`」——那是**外壳层在构造端口之前就拒掉**的臂（`app.ts` 的 `categoriesWired`
 *   判据），请求根本走不到本函数；
 * - 真走到本函数时，`retryable` 按全仓共享判据 `isTransientDatabaseError` 分档：驱动层的
 *   `ECONNREFUSED` / `ECONNRESET` / `ENOTFOUND` / `EAI_AGAIN` / `ETIMEDOUT` / `EPIPE`
 *   （`services/api/src/db/pool.ts:77` 的 `TRANSIENT_DRIVER_CODES`）属**瞬时** ⇒ `retryable: true`
 *   （`tests/unit/db-error-retryable-classification.test.mjs:127` 就钉着 `ECONNREFUSED ⇒ true`）；
 *   只有 42501/3D000/28P01/42P01/42883 与无法归类才落 false。
 */
function foldCategoryDatabaseError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : '';
  if (code === '57014' || code === '55P03') {
    throw new ApiError('PROVIDER_TIMEOUT', '后台分类库响应超时', { retryable: true });
  }
  if (code === 'G0001' || code === 'G0002' || code === 'G0010') {
    throw new ApiError('PROVIDER_UNAVAILABLE', `后台分类审计写入被库层拒绝（${code}）`, { retryable: false });
  }
  throw new ApiError('PROVIDER_UNAVAILABLE', '后台分类库暂不可用', {
    retryable: isTransientDatabaseError(error),
  });
}

/**
 * 构造**真库**分类端口。`app.ts` 只在确实拿到连接池时构造它
 * （判据是能力对象存在，⛔ 不读任何自述持久化布尔标志）。
 */
export function createPostgresAdminCategories(options: { pool: PgPool | AdminCategoriesPool }): AdminCategoriesPort {
  const pool: AdminCategoriesPool = options.pool;

  async function withClient<T>(run: (client: PgClient) => Promise<T>): Promise<T> {
    let client: PgClient;
    try {
      client = await pool.connect();
    } catch (error) {
      return foldCategoryDatabaseError(error);
    }
    try {
      return await run(client);
    } finally {
      client.release();
    }
  }

  return {
    wired: true,
    persistent: true,

    async listCategories(): Promise<readonly CategoryView[]> {
      return withClient(async (client) => {
        try {
          const result = await client.query(ADMIN_CATEGORY_SQL.list);
          return (result.rows as CategoryRow[]).map(toCategoryView);
        } catch (error) {
          return foldCategoryDatabaseError(error);
        }
      });
    },

    async commitCategoryIfCurrent(
      id: string,
      expectedRevision: number,
      patch: CategoryInputValue,
      audit: CategoryUpdateAuditInput,
    ): Promise<CategoryCommitOutcome> {
      return withClient(async (client) => {
        try {
          await client.query(ADMIN_CATEGORY_TX.begin);

          const updated = await client.query(ADMIN_CATEGORY_SQL.commit, [
            id,
            expectedRevision,
            patch.name,
            patch.description,
            patch.active,
          ]);
          const rows = updated.rows as CategoryRow[];

          if (rows.length === 0) {
            // CAS 落空：**先分辨**是"没有这条"还是"修订变了"，再回滚（判定用读，不写）。
            const existing = await client.query(ADMIN_CATEGORY_SQL.currentRevision, [id]);
            await client.query(ADMIN_CATEGORY_TX.rollback);
            return (existing.rows as { revision: number }[]).length === 0
              ? { ok: false, reason: 'NOT_FOUND' }
              : { ok: false, reason: 'REVISION_CONFLICT' };
          }

          const [row] = rows;
          if (row === undefined) {
            // 理论不可达（上一段已判 `length === 0`）；保留显式失败而不是非空断言。
            await client.query(ADMIN_CATEGORY_TX.rollback);
            return { ok: false, reason: 'NOT_FOUND' };
          }

          const record = toCategoryView(row);
          // 审计与目录变更**同一事务**：这一句失败 ⇒ 整个事务回滚（目录保持原样）。
          await client.query(ADMIN_CATEGORY_SQL.audit, [audit.actorId, record.id, record.revision, audit.requestId]);
          await client.query(ADMIN_CATEGORY_TX.commit);
          return { ok: true, record };
        } catch (error) {
          try {
            await client.query(ADMIN_CATEGORY_TX.rollback);
          } catch {
            // 回滚失败不改变主错误：原始错误更有诊断价值（连接可能已经断了）。
          }
          return foldCategoryDatabaseError(error);
        }
      });
    },
  };
}
