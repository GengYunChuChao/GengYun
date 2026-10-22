import type { PgPool } from '../db/pool.ts';
import type { AuthenticatedIdentity } from '../auth/types.ts';
import { hashToken } from '../auth/tokens.ts';
import { ApiError } from '../errors.ts';
import { paginateKnowledge } from './pagination.ts';

type Identity = { identity: AuthenticatedIdentity; token: string };
export interface KnowledgeQuery {
  cursor?: string; limit?: number; q?: string; crop_id?: string; region_code?: string;
  species_id?: string; growth_stage?: string; planting_method?: string; use_scene?: string;
}
type Row = Record<string, any>;

/**
 * 读取层排序 —— 与冻结契约 `(created_at DESC, id DESC)` 逐字对应
 * （`docs/architecture/state-contract.md:32`），并与 `pagination.ts` 的游标自述
 * `sort='created_at_desc'` 同一口径。四点纪律：
 *   1. SQL 的 `ORDER BY` 与下面的 JS 比较器**必须同序**，否则数据库投影与并入种子的
 *      归并次序会与分页切片错位；
 *   2. 排序键来自行自身的 `created_at`（0012 迁移落到 `knowledge_versions` 并由
 *      `catalog_read.current_knowledge` 投影出来），**不再用 id、也不复用 `updated_at`**；
 *   3. `created_at` 必须按**时间点**比较：驱动（pg / PGlite）把 timestamptz 解成 `Date`，
 *      直接字符串化会退化成 `"Wed Oct 14 2026 …"` 这类**星期名**字典序
 *      （实测 `Thu > Sat > Fri`），与 SQL 的 `ORDER BY created_at DESC` 不同序 ——
 *      故先取毫秒时间戳，只在无法解析时退到 `-Infinity`（确定性排最后，不抛错）；
 *   4. `id` 是 UUID 文本，全序比较必须逐码元（不用 `localeCompare`，避免区域设置改变结果）。
 */
function instantOf(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}
function compareKnowledgeRows(a: Row, b: Row): number {
  const left = instantOf(a.created_at), right = instantOf(b.created_at);
  if (left !== right) return left > right ? -1 : 1;
  const aid = String(a.id), bid = String(b.id);
  return aid === bid ? 0 : aid < bid ? 1 : -1;
}
export interface KnowledgeServiceOptions {
  /**
   * 额外并入查询面的行（与 `catalog_read.current_knowledge` 同形）。
   *
   * 用途（GY-I07 / #7）：把**已合入仓库的浙江首批真实资料**
   * （`packages/knowledge/zhejiang/materials-zhejiang-v1.json`）并入同一份读取快照，
   * 使既有过滤/分页/游标水位/封套**不必改动**即可如实带出这批条目。
   *
   * 契约没有 visibility 字段，因此「未发布（private）」语义由**装配层**控制：
   * 只有非 `real` 执行模式**且**装配层显式放行未核对种子时才注入
   * （见 `routes/knowledge.ts` 的 `APP_KNOWLEDGE_UNVERIFIED_SEED` 显式开关）；
   * 行内 `review_status` 会**逐行**投影到 `SourceRef.review_status`（未核对即 `unverified`），
   * 绝不被统一改写成 `verified`。
   */
  extraRows?: () => Row[] | Promise<Row[]>;
}
/** Only the operator-owned, fail-closed public projection is readable by this group. */
export function createKnowledgeService(pool: PgPool, key: string, options: KnowledgeServiceOptions = {}) {
  async function read(input: Identity, query: KnowledgeQuery, id?: string) {
    let client;
    try {
      if (input.identity.role !== 'user') throw new ApiError('SCOPE_DENIED', '需要用户会话');
      client = await pool.connect();
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout='4s'");
      const account = await client.query('SELECT state,auth_epoch FROM public.users WHERE id=$1::uuid FOR SHARE', [input.identity.userId]);
      if (account.rows.length !== 1 || account.rows[0].state !== 'active' || Number(account.rows[0].auth_epoch) !== input.identity.authEpoch) throw new ApiError('ACCOUNT_INACTIVE', '账号已失效');
      const session = await client.query(`SELECT id FROM public.sessions WHERE id=$1::uuid AND user_id=$2::uuid
        AND audience='user' AND auth_epoch=$3 AND token_hash=decode($4,'hex')
        AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE`,
      [input.identity.sessionId,input.identity.userId,input.identity.authEpoch,hashToken(input.token)]);
      if (!session.rows.length) throw new ApiError('SESSION_EXPIRED', '会话已失效');
      // One fresh statement snapshot includes body, source version, validity and
      // latest revision. No process cache or static seed fallback is consulted.
      // 排序由**查询自身**给出（不依赖视图定义顺序）：冻结契约的
      // `(created_at DESC, id DESC)` —— created_at 由 0012 迁移落到表并投影出来。
      const dbResult = await client.query(
        'SELECT * FROM catalog_read.current_knowledge ORDER BY created_at DESC, id DESC');
      // GY-I07：把已合入的真实种子资料（浙江首批，未发布/未核对）并入**同一份**快照。
      // 同 id 以数据库投影为准（视图只含已核对+已发布，种子只含未核对+未发布，正常不重叠）。
      // 归并后按契约排序 `(created_at DESC, id DESC)` 重排 —— 与游标自述的
      // sort=created_at_desc 一致且确定性可复现（同一份快照恒得同一次序）。
      const extra = options.extraRows === undefined ? [] : await options.extraRows();
      const known = new Set(dbResult.rows.map((row: Row) => row.id));
      const rows = [...dbResult.rows, ...extra.filter((row) => !known.has(row.id))]
        .sort(compareKnowledgeRows);
      const filter = {q: query.q ?? null, crop_id: query.crop_id ?? null, region_code: query.region_code ?? null,
        species_id: query.species_id ?? null, growth_stage: query.growth_stage ?? null,
        planting_method: query.planting_method ?? null, use_scene: query.use_scene ?? null};
      const visible = rows.filter((row: Row) => (!id || row.id === id)
        && (!filter.q || `${row.title}\n${row.body}`.toLocaleLowerCase('zh-CN').includes(filter.q.toLocaleLowerCase('zh-CN')))
        && (!filter.crop_id || row.crop_ids.includes(filter.crop_id))
        && (!filter.region_code || row.region_codes.includes(filter.region_code))
        && (!filter.species_id || row.species_ids.includes(filter.species_id))
        // Current schema has no stage/method/scene evidence. It cannot prove
        // a requested applicability condition; do not silently drop filters.
        && !filter.growth_stage && !filter.planting_method && !filter.use_scene);
      // `review_status` / `validity` 逐行投影：数据库投影行不带这两列时按读视图的准入
      // 事实（已验证 + 有效）取 `verified` / `valid`；**并入的未核对种子行必须如实标 unverified**。
      const project = (row: Row) => {
        const validity = typeof row.validity === 'string' ? row.validity : 'valid';
        return {id: row.id,revision: row.revision,type: row.type,title: row.title,body: row.body,
        source: {id: row.source_id,version: row.source_version,title: row.source_title,url: row.url,
          publisher: row.publisher,source_kind: row.source_kind,evidence_kind: row.evidence_kind,
          validity,review_status: typeof row.review_status === 'string' ? row.review_status : 'verified',
          updated_at: new Date(row.updated_at).toISOString()},
        conditions: null,reference_state: validity === 'valid' ? 'available' : 'unavailable',dose_cards: []};
      };
      if (id && !visible.length) throw new ApiError('NOT_FOUND', '资料不可用');
      const page = id ? null : paginateKnowledge(visible, { userId: input.identity.userId,
        authEpoch: input.identity.authEpoch, hmacKey: key, filter, snapshot: rows,
        cursor: query.cursor, limit: query.limit ?? 20 });
      const result = page === null ? project(visible[0]) : {items: page.items.map(project),next_cursor:page.next_cursor};
      const alive = await client.query('SELECT id FROM public.sessions WHERE id=$1::uuid AND expires_at>clock_timestamp()', [input.identity.sessionId]);
      if (!alive.rows.length) throw new ApiError('SESSION_EXPIRED','会话已失效');
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(()=>{});
      if (error instanceof ApiError) throw error;
      // `retryable` 按 `errors.ts` 的唯一口径逐支判定，**不整条 catch 一律置 true**：
      //   57014 statement_timeout / 55P03 lock_not_available 是**瞬时**的数据库竞争态
      //   （本函数 `:63` 设的 `lock_timeout='4s'` 正是 55P03 的来源）⇒ 同一请求稍后重试
      //   可能成功 ⇒ 504 `PROVIDER_TIMEOUT` + `retryable: true`；
      //   其余（连接串坏、库不可达、凭据/权限不足等）是**装配或运维**问题，时间不会让它自愈
      //   ⇒ 503 `PROVIDER_UNAVAILABLE` + `retryable: false`（沿用默认值）。
      const pgCode = (error as {code?: string}).code ?? '';
      if (['57014','55P03'].includes(pgCode)) {
        throw new ApiError('PROVIDER_TIMEOUT','资料数据库暂不可用',{ retryable: true });
      }
      throw new ApiError('PROVIDER_UNAVAILABLE','资料数据库暂不可用');
    } finally {client?.release();}
  }
  return {list: (input: Identity, query: KnowledgeQuery) => read(input,query), get: (input: Identity,id: string,query: KnowledgeQuery) => read(input,query,id)};
}
