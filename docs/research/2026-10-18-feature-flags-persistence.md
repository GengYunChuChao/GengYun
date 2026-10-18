# 2026-10-18 feature_flags 持久化：行级锁 CAS 与幂等种子

- 检索日期：2026-10-18
- 检索方式：直接抓取 PostgreSQL 17 官方文档页（未使用检索词），逐页读数见各节「检索来源」
- 来源版本或提交：17.11（便携 PostgreSQL 17.11 实测）；仓库基线 commit 60aa9ad8f582c3145955226e572576e0dee045ca
- 一句话结论：开关写面用「`SELECT … FOR UPDATE` 锁行 + `WHERE key=$1 AND revision=$2` 的 CAS 更新」实现乐观并发，种子行用 `INSERT … ON CONFLICT (key) DO NOTHING` 保证迁移可重放；两项都只用 PG 内置能力，不引入依赖。

## 1 行级锁 + revision CAS（`SELECT … FOR UPDATE`）

| 项 | 内容 |
| --- | --- |
| 现用版本（证据命令） | `git grep -n "image: postgres:" -- .github/workflows` ⇒ 5 个工作流用 `postgres:17.11`（`workbook-staging.yml` 用 `postgres:17`）；本片用便携 PG 实测 `postgres.exe --version` ⇒ `postgres (PostgreSQL) 17.11`；迁移 `services/api/db/migrations/0020_feature_flags.sql` 的 `public.set_feature_flag(...)` 内先 `SELECT * INTO x_before … WHERE key = p_key FOR UPDATE`，再 `UPDATE … WHERE key = p_key AND revision = p_expected_revision` |
| 上游维护状态 | 17.11 为当前小版本，PG 17 支持到 2029-11-08（首版 2024-09-26）；官方锁文档说明行级锁在事务结束时释放，`FOR UPDATE` 会阻塞并发写者并要求其重读最新行 ⇒ 本片用它把「读 revision → 校验 If-Match → 写」收进一个事务 |
| 可复用部分 | 写面：`services/api/src/admin/ops/flags-pg.ts` 的 `createPostgresFeatureFlags`（`pool.connect()` → `BEGIN` → `SET LOCAL lock_timeout = '4s'` → `SELECT public.set_feature_flag(...)` → `COMMIT`）；库内函数：`services/api/db/migrations/0020_feature_flags.sql`；读面：同文件 `list()/get()` 只 `SELECT key, enabled, revision`。计数命令：`git grep -c "FOR UPDATE" -- services/api/db/migrations/0020_feature_flags.sql` ⇒ 1 |
| 许可证与署名 | PostgreSQL License（BSD/MIT 风格）：允许使用、复制、修改、分发，需保留版权与许可段落，无担保 |
| 兼容性 | 只在 PG 17 / `pg` 驱动上验证；`FOR UPDATE` 与 CAS `UPDATE … WHERE revision=$2` 在 Read Committed 下即可安全（并发提交后 PG 会对新版本重新求值 `WHERE`），不依赖串行化隔离级别；运行时角色对该表只有 `SELECT`，写只能经 `SECURITY DEFINER` 函数 |
| 引入成本 | 无新增依赖；每次写多一条函数调用与两行审计写入，写延迟未实测（本地库单笔毫秒级，未做压测） |
| 决定 | 沿用 PG17 + 行级锁 CAS。理由：revision 冲突需要数据库层判定（应用内存判断会被并发穿透），而 `FOR UPDATE` + 条件 `UPDATE` 是官方文档给出的标准做法；不引入分布式锁或额外队列 |

### 检索来源

| # | URL | 本轮读数 |
| --- | --- | --- |
| 1 | https://www.postgresql.org/docs/17/explicit-locking.html | 行级锁在事务结束时释放；`SELECT … FOR UPDATE` 阻塞其他会话的写/锁请求，使其在锁释放后重读最新行 |
| 2 | https://www.postgresql.org/docs/17/transaction-iso.html | Read Committed 下 `UPDATE`/`DELETE` 遇到并发已提交版本时会重新求值 `WHERE` 条件（re-evaluate the search condition）⇒ CAS 更新安全 |

## 2 幂等种子：`INSERT … ON CONFLICT (key) DO NOTHING`

| 项 | 内容 |
| --- | --- |
| 现用版本（证据命令） | `services/api/db/migrations/0020_feature_flags.sql` 内 `INSERT INTO public.feature_flags (key, enabled, revision) VALUES (…), (…), (…) ON CONFLICT (key) DO NOTHING`；表定义 `key text PRIMARY KEY` 提供唯一约束；真库脚本 `tests/integration/admin-flags-pg.mjs` 的 `[M]` 段对同一迁移做 UP → ROLLBACK → REPLAY，回放后仍恰好三行 |
| 上游维护状态 | `ON CONFLICT` 自 9.5 起可用，PG 17 文档仍为标准语法；唯一索引/主键默认把多个 `NULL` 视为互不相等（本表 `key` 为 `NOT NULL`，不受此影响）；PG 17 支持到 2029-11-08 |
| 可复用部分 | 迁移脚本一处（`services/api/db/migrations/0020_feature_flags.sql`），回滚脚本 `services/api/db/migrations/rollback/0020_feature_flags.down.sql` 只 `DROP FUNCTION` + `DROP TABLE`；真库可重放证据在 `tests/integration/admin-flags-pg.mjs`。计数命令：`git grep -n "ON CONFLICT (key) DO NOTHING" -- services/api/db/migrations/0020_feature_flags.sql` ⇒ 1 行 |
| 许可证与署名 | 同 §1：PostgreSQL License，保留版权与许可段落 |
| 兼容性 | 种子三键与 `CHECK (key IN (…))` 闭集一致；`ON CONFLICT (key)` 依赖主键推断冲突目标，无需额外唯一索引；重复执行不改变已有 `enabled/revision`（不会把线上已开的开关刷回 false） |
| 引入成本 | 无新增依赖；种子仅三行、单条语句 |
| 决定 | 沿用 `ON CONFLICT DO NOTHING`。理由：迁移会被重放（本片真库脚本的 REPLAY 段就是验证这一点），`DO NOTHING` 让「缺行补齐、已有行不动」成为一条原子语句；不改成 `DO UPDATE`，避免重放时覆盖已经提交的开关状态 |

### 检索来源

| # | URL | 本轮读数 |
| --- | --- | --- |
| 1 | https://www.postgresql.org/docs/17/sql-insert.html | `ON CONFLICT DO NOTHING` 跳过冲突行、`ON CONFLICT DO UPDATE` 更新冲突行；冲突目标可由唯一索引/主键推断 |
| 2 | https://www.postgresql.org/docs/17/indexes-unique.html | 唯一索引默认允许多个 `NULL` 值（NULL 不相等）；本表 `key` 为 `PRIMARY KEY` 且非空 |
