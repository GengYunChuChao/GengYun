# 数据库适配层（GY-I03）

可替换资料数据库适配：迁移、种子、明显模拟数据、导入校验、冲突报告、更新回滚，
以及 `real` / `stub` / `preset_demo` 三模式与来源类型（`database` / `verified_seed` /
`simulation`）分离。

**边界**：本节只负责资料子域与适配审计。迁移编号从 `0002` 起；`0001` 归 GY-I02。
不写 `services/api` 的启动/路由/CI。

## 目录

| 路径 | 内容 |
| --- | --- |
| `services/api/db/migrations/0002_knowledge_catalog.sql` | **运行器发现的上迁移**：业务表 + 适配审计表 + 只读视图 |
| `services/api/db/migrations/rollback/0002_knowledge_catalog.down.sql` | 手工回滚（`rollback/` 子目录，运行器 `isFile()` 过滤子目录，不扫描） |
| `db/seeds/seed_reference.sql` | 模式、配置、来源、来源版本、作物、物种、浙江区划 |
| `db/seeds/seed_herbicides_verified.sql` | 20 条已核对来源的除草剂资料（`card_ready=false`） |
| `db/seeds/seed_simulation.sql` | 明显模拟数据（`SIM-` 前缀，`source_kind=simulation`） |
| `db/seeds/rollback_seed.sql` | 回滚本次种子（只删本次导入的 id，结构不动） |
| `db/samples/desensitized-sample.sql` | 脱敏样例（合成模拟链路，可重复执行） |
| `db/samples/field-mapping.md` | JSON→表列映射 |
| `db/policies/modes.md` | 三模式切换与来源匹配规则 |

### 为什么 down 不在运行器目录

迁移运行器 `services/api/src/db/migrate.ts` 的 `DEFAULT_MIGRATIONS_DIR` 指向
`services/api/db/migrations/`，用 `readdirSync(..., { withFileTypes: true })` 并只在
`entry.isFile()` 时纳入，且对**每个** `.sql` 强制要求文件名匹配
`^(\d{4,})_([a-z0-9_]+)\.sql$`。`0002_knowledge_catalog.down.sql` 含 `.down` 段
**不匹配该 pattern**，若放在运行器目录顶层会使 `discoverMigrations` 直接抛
「迁移文件名不合规」。故 down 文件放在 **`rollback/` 子目录**（`isFile()` 会过滤子目录），
按与 I27（`rollback/0003_privacy_consent.down.sql`）一致的约定，由人工执行，不经运行器。

## 执行顺序（0002 依赖 0001）

```bash
# 1) 迁移：由运行器按 0001 → 0002 升序应用（需 DATABASE_URL；无库时明确失败）
DATABASE_URL="$DATABASE_URL" node services/api/src/db/migrate.ts list    # 仅列出，无需数据库
DATABASE_URL="$DATABASE_URL" node services/api/src/db/migrate.ts up      # 应用 0001、0002
#   或不经运行器，直接用 psql 按顺序执行 0001、0002
#   psql "$DATABASE_URL" -f services/api/db/migrations/0001_initial_schema.sql
#   psql "$DATABASE_URL" -f services/api/db/migrations/0002_knowledge_catalog.sql

# 2) 种子：迁移之后执行（psql，非运行器）
psql "$DATABASE_URL" -f db/seeds/seed_reference.sql
psql "$DATABASE_URL" -f db/seeds/seed_herbicides_verified.sql
psql "$DATABASE_URL" -f db/seeds/seed_simulation.sql      # 仅 preset_demo

# 3) 脱敏样例（可选，演示/联调；迁移之后执行，可重复）
psql "$DATABASE_URL" -f db/samples/desensitized-sample.sql

# 4) 回滚（人工）
psql "$DATABASE_URL" -f db/seeds/rollback_seed.sql        # 回滚种子数据
psql "$DATABASE_URL" -f services/api/db/migrations/rollback/0002_knowledge_catalog.down.sql   # 回滚 0002 结构
```

**GY-I03 原交付证据**：当时以上命令未对真实库执行。已在内存引擎 PGlite 0.5.8
（基于 PostgreSQL 18.x 内核）实测 0001→0002→种子→脱敏样例→回滚，**不构成目标
PostgreSQL 17.11 的实库验收**（见 `docs/verification/gy-i03-evidence.md`）。
2026-10-08 的后续增量已在隔离的本机 PostgreSQL 17.11 执行迁移、种子重复导入、
限定回滚和受限查询；范围及重放步骤见 [GY-I25 数据库实测](../docs/verification/gy-i25-catalog-pg.md)。
这不代表用户云库、20份完整标签或整个 #3/#27 已验收。
种子 SQL 由 `tools/knowledge/build_seeds.py` 从 `packages/knowledge/` 的 JSON 确定性生成，
改 JSON 后重新生成即可，勿手工编辑。

## 关键约束

- `applicability.card_ready` 只有 `crop_id/species_id/region_code/growth_stage/
  planting_method/use_scene/unit_text/dose_text/method_text/precautions_text` 全部非空才可为
  `true`——**缺项不得标为可用**。本轮 20 条缺用量/施用方法，一律 `card_ready=false`。
- `v_active_source_version` 只返回 `validity='valid' AND review_status='verified' 且非模拟`。
  本轮来源 `review_status` 均为 `unverified`，**该视图为空**，即未核对不进有效集合。
- `v_queryable_seed_version` 供 `stub`/联调，**显式暴露 `review_status=unverified`**，消费方必须标注“未核对”。
- `v_simulation_only` 单独暴露模拟数据，禁止混入真实查询。
- 许可调查本轮暂缓：共享 `sources` 表**无** `license_status`/`licensed` 列，许可结论
  **只存在于资料/报告层**（`packages/knowledge/catalog/sources.json` 的 `license` 字段与验证报告），
  不得写为已许可。
- 共享字典表 `crops/species/regions/sources/source_versions` 由 0001 拥有；`sources.id`、
  `source_versions.id/source_id` 均为 `uuid`。`regions` **无 `level` 列**。
