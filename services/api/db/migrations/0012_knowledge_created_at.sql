-- ============================================================================
-- GY-I07 / #7 知识列表排序契约落地（迁移 0012）
-- ----------------------------------------------------------------------------
-- 依赖：0001（无）、0002（knowledge_versions）、0005（catalog_read.current_verified_sources）、
-- 0010（catalog_read.current_knowledge）。落库顺序（与 0010 既有口径一致，不改部署链路）：
-- 0010 → `db/roles/knowledge_runtime.sql` → 本迁移。第 4 节用 `CREATE OR REPLACE VIEW`
-- **替换**同一视图对象（不 DROP），视图 ACL 随之保留 ⇒ 角色脚本已建立的运行期
-- `GRANT SELECT … TO gengyun_knowledge_runtime` **不被本迁移悄悄撤销**，重放本迁移
-- **不需要**重跑角色脚本，权限域不变（本迁移不新增/不撤销任何 GRANT）。
-- 本迁移只**补齐创建时点证据并追加只读投影的一列**，不新增表、不改可见性/审核语义、
-- 不触碰 0002 与 0010 已冻结的准入条件（逐条照抄，见第 4 节）。
--
-- 为什么需要（对应 docs/architecture/state-contract.md:32 与 GY-I01 验收记录
-- docs/verification/gy-i01-knowledge-cursor-20261013.md:46 的剩余偏差）：
--   * 冻结契约要求游标列表排序 `(created_at DESC, id DESC)`，而 0002 的
--     `knowledge_versions`、0010 的 `catalog_read.current_knowledge` **都没有
--     created_at** ⇒ 服务端只能退化为 `ORDER BY id`（id_asc），与冻结排序不一致。
--   * 排序键必须**服务端可复现**：契约把排序写进游标签名绑定，同一游标只对
--     同一排序有效，所以排序键不能是运行期时钟、也不能由客户端提供。
--
-- 回填确定性（**不得用「当前时间」这类不可复现值**）：
--   历史行没有独立创建时点证据 —— 0002 建表时未落该列；按此前验收记录，
--   「迁移执行时间」与「来源检索时间」都**不是**历史资料创建时点，不能冒充。
--   本迁移的取值规则见第 2 节：在缺少独立证据时，取**已入库的批次日期常量**
--   （与 `db/seeds/seed_zhejiang_materials.sql` 使用同一批次日期），
--   它是**版本库中已冻结的批次事实**，不是「跑迁移的当下时间」：同一批数据在任何
--   时间、任何环境重跑迁移都得到同一值，故排序与游标水位**逐字节可复现**。
--   新行一律落到表默认或由写入方显式给出（两者都不影响历史行的确定性回填）。
--
-- 事务归属：本文件**不自带** BEGIN/COMMIT —— 运行器 `applyMigrations`
-- （services/api/src/db/migrate.ts）已为每个迁移单独开事务并把 schema_migrations
-- 台账写入同一事务；文件自带会形成嵌套提交，反而让台账落到事务之外。同目录最近的
-- 一条 DDL 迁移 0010 采用同一口径（其文件头逐字：Runner owns the transaction）。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 创建时点列（先可空，回填后再收紧为 NOT NULL）
-- ---------------------------------------------------------------------------
ALTER TABLE public.knowledge_versions ADD COLUMN IF NOT EXISTS created_at timestamptz;

COMMENT ON COLUMN public.knowledge_versions.created_at IS
  '条目创建时点：知识列表游标排序键 (created_at DESC, id DESC) 的第一分量。'
  '只增不改（随 revision 递增的新行另取其自身创建时点）；不得由客户端提供，'
  '也不得用运行期时钟或迁移时间回填历史行。';

-- ---------------------------------------------------------------------------
-- 2. 确定性回填（历史行）—— 单条 UPDATE，取值与运行时刻无关，不含 now()/clock_timestamp()
--    规则：历史行没有独立创建时点证据，一律取**已冻结的批次日期常量**
--    `2026-10-14T00:00:00Z`。该值来自版本库中已合入的批次清单
--    `packages/knowledge/zhejiang/materials-zhejiang-v1.json` 的 `release` 字段，
--    与 `tools/knowledge/build_seeds.py` 写种子时给 `source_versions.retrieved_at`
--    / `catalog_import_runs` 用的是同一个批次日期；**不是"当前时间"**：
--    任何时间、任何环境重跑本迁移都得到同一值 ⇒ 排序与游标水位逐字节可复现。
--    为什么不用「来源检索时间」冒充创建时点：见文件头「回填确定性」与
--    `docs/verification/gy-i01-knowledge-cursor-20261013.md:46` 的既有判定。
--    效果：现存历史（全部为同批次种子）回填后 created_at 恒等 ⇒ 全序退化为 id DESC，
--    与冻结排序 `(created_at DESC, id DESC)` 一致且确定性。
-- ---------------------------------------------------------------------------
UPDATE public.knowledge_versions
SET created_at = timestamptz '2026-10-14T00:00:00Z'
WHERE created_at IS NULL;

-- 收紧约束：排序键不允许缺失（缺失值无法参与 (created_at DESC, id DESC) 全序）。
ALTER TABLE public.knowledge_versions ALTER COLUMN created_at SET NOT NULL;

-- 新行默认值：写入方未显式给值时取**该行自己的**插入时刻。这只作用于新行，
-- 与第 2 节的历史回填无关（历史行已在上一步落定，不会被 DEFAULT 改写）。
ALTER TABLE public.knowledge_versions ALTER COLUMN created_at SET DEFAULT clock_timestamp();

-- ---------------------------------------------------------------------------
-- 3. 排序索引（键顺序与契约排序一致：created_at DESC, id DESC）
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS knowledge_versions_created_idx
  ON public.knowledge_versions (created_at DESC, knowledge_id DESC);

-- ---------------------------------------------------------------------------
-- 4. 只读投影：只**追加** created_at 一列，其余列与准入条件逐条照抄 0010
--    （security_barrier 保持；末尾同样 REVOKE ALL FROM PUBLIC）。
--    用 `CREATE OR REPLACE VIEW` 而**不是** DROP + CREATE：视图对象与它的 ACL 一并保留，
--    0010 之后由 `db/roles/knowledge_runtime.sql` 建立的
--    `GRANT SELECT ON catalog_read.current_knowledge TO gengyun_knowledge_runtime`
--    不会被本迁移撤销；重放后运行期角色仍只能读这一个视图，权限域与 0010 完全一致。
--    PostgreSQL 的视图替换只允许在列清单**末尾**追加列，故 created_at 追加在 valid_to
--    之后；列序不影响读面（服务端 `SELECT *` 与 JS 侧都按列名取用，见
--    services/api/src/knowledge/service.ts 与 reference-query.ts）。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW catalog_read.current_knowledge WITH (security_barrier = true) AS
SELECT k.knowledge_id AS id,k.revision,k.type,k.title,k.body,
       k.crop_ids,k.species_ids,k.region_codes,
       s.id AS source_id,sv.version AS source_version,s.title AS source_title,
       s.canonical_url AS url,s.publisher,s.source_kind,s.evidence_kind,
       sv.retrieved_at AS updated_at,
       -- Internal pagination watermark evidence, never sent to clients.
       s.revision AS source_revision,sv.content_hash,sv.locator,
       sv.reviewed_at,sv.valid_from,sv.valid_to,
       -- 契约排序第一分量：由知识行自身的创建时点提供（不再用来源检索时间冒充）。
       k.created_at
FROM public.knowledge_versions k
JOIN catalog_read.current_verified_sources allowed ON allowed.id=k.source_version_id
JOIN public.source_versions sv ON sv.id=allowed.id
JOIN public.sources s ON s.id=sv.source_id AND s.current_version_id=sv.id
WHERE k.visibility='published'
  AND NOT EXISTS (SELECT 1 FROM public.knowledge_versions newer
    WHERE newer.knowledge_id=k.knowledge_id AND newer.revision>k.revision)
  AND length(btrim(k.title)) BETWEEN 1 AND 200
  AND length(btrim(k.body))>0 AND length(k.body)<=20000
  AND length(btrim(s.title)) BETWEEN 1 AND 200
  AND length(btrim(s.publisher)) BETWEEN 1 AND 200
  AND s.canonical_url ~ '^https://[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]{1,5})?([/?#][^[:space:]]*)?$'
  AND length(btrim(sv.version)) BETWEEN 1 AND 80
  AND isfinite(sv.retrieved_at)
  AND sv.valid_from<=clock_timestamp()
  AND (sv.valid_to IS NULL OR sv.valid_to>clock_timestamp())
  AND jsonb_typeof(k.crop_ids)='array'
  AND jsonb_typeof(k.species_ids)='array'
  AND jsonb_typeof(k.region_codes)='array';
REVOKE ALL ON catalog_read.current_knowledge FROM PUBLIC;
