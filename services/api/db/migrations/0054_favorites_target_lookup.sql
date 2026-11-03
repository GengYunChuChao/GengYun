-- GY-R73（#17）· 收藏的**反查**索引：按 `(target_type, target_id)` 找收藏者。
--
-- 依赖：`0018_favorites_history.sql` 建的 `public.favorites`（本迁移**只加索引**，不改列、
-- 不改 CHECK、不写数据、不建表）。
--
-- 为什么加（逐条对齐查询形状）：
--   - 本片新增的唯一读法是「一个资料被撤回 ⇒ 谁收藏过它」：
--     `SELECT owner_id FROM favorites WHERE target_type = $1 AND target_id = $2 ORDER BY owner_id`
--     （`services/api/src/favorites/store-pg.ts` 的 `listOwnerIdsByTarget`，PG/内存两臂逐字同形）。
--   - 这条谓词**不带 owner 前缀**，`0018` 的两个索引都命不中：
--     `favorites_owner_target_key (owner_id, target_type, target_id)` 是 owner 打头的唯一键，
--     `favorites_owner_created_idx (owner_id, created_at DESC, id DESC)` 是 owner 打头的列表键。
--     没有本索引时它退化成整表 `Seq Scan`——撤回是后台动作、频率低，但表会随用户数线性长，
--     而这条扫描发生在**一次真实的管理写请求里**（撤回提交之后、响应返回之前），
--     ⛔ 不该让一个后台操作的成本随全站收藏量线性增长。
--   - 列序 `(target_type, target_id, owner_id)`：前两列等值、`owner_id` 做索引尾列 ⇒ 查询的
--     投影（只有 `owner_id`）**只扫索引不回表**；`ORDER BY owner_id` 也能顺着索引尾列直接出序。
--   - **不建第二个唯一约束**：去重的唯一权威仍是 `favorites_owner_target_key`
--     （「同主体同目标只有一行」）。本索引的形状表达不了这条约束（尾列 `owner_id` 在等值列之后），
--     硬造成 UNIQUE 只会让同一事实出现两个真相、并把回滚面扩大。
--
-- 权限：本迁移**零 GRANT**（与 0024/0026/0051 同一纪律：迁移只建结构，授权一律在部署侧）。
--   运行角色对 `public.favorites` 的 `SELECT` 早已在 `deploy/postgres-cvm/sql/20-login-roles.sql`
--   授予（`favorites/store-pg.ts` 的四个读法一直按运行角色跑），本索引**不新增任何可读面**
--   ⇒ ⛔ `deploy/**` 一个字都不改。
--
-- 并发：与会话内其他 DDL 同事务（`BEGIN … COMMIT`），因此**不用** `CREATE CONCURRENTLY`
--   （它不能进事务块）。`favorites` 的行数随用户数线性增长，本迁移跑在部署窗口，
--   与 0018/0042 对同一张表的写锁口径一致。
--
-- 号位：合流树正向最大号是 `0052`（R72-W54 的审核结论事实列）；`0053` 已被**在飞**的 `#838`
--   占用（`feat/gy-r73-…` 之外的分支）⇒ 本片取 **`0054`**，`0053` 作为有意缺号登记在
--   `services/api/db/migration-reservations.json`（`#838` 落 0053 即删该条）。
--
-- 回滚：`services/api/db/migrations/rollback/0054_favorites_target_lookup.down.sql`
--   （只 `DROP INDEX IF EXISTS`，不碰表与数据；删索引只损失这条反查的性能，不损失任何事实）。
BEGIN;

CREATE INDEX favorites_target_lookup_idx
  ON public.favorites (target_type, target_id, owner_id);

COMMIT;
