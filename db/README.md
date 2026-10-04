# 数据库适配层（GY-I03）

可替换资料数据库适配：迁移、种子、明显模拟数据、导入校验、冲突报告、更新回滚，
以及 `real` / `stub` / `preset_demo` 三模式与来源类型（`database` / `verified_seed` /
`simulation`）分离。

**边界**：本节只负责资料子域与适配审计。迁移编号从 `0002` 起；`0001` 归 GY-I02。
不写 `services/api` 的启动/路由/CI。

## 目录

| 路径 | 内容 |
| --- | --- |
| `migrations/0002_knowledge_catalog.sql` | 资料/字典/制剂/适用/限制表 + 适配审计表 + 只读视图 |
| `migrations/0002_knowledge_catalog.down.sql` | 回滚（只回滚 GY-I03 专属对象） |
| `seeds/seed_reference.sql` | 模式、配置、来源、来源版本、作物、物种、浙江区划 |
| `seeds/seed_herbicides_verified.sql` | 20 条已核对来源的除草剂资料（`card_ready=false`） |
| `seeds/seed_simulation.sql` | 明显模拟数据（`SIM-` 前缀，`source_kind=simulation`） |
| `seeds/rollback_seed.sql` | 回滚本次种子（按来源版本删除，结构不动） |
| `samples/` | 脱敏样例与字段映射 |
| `policies/modes.md` | 三模式切换与来源匹配规则 |

## 执行顺序（0002 依赖 0001）

```bash
# 1) GY-I02 的 0001 先执行（身份/隐私等基础表）
# 2) 再执行本迁移
psql "$DATABASE_URL" -f db/migrations/0002_knowledge_catalog.sql
# 3) 参考数据 → 已核对种子 → 演示模拟（按模式选用）
psql "$DATABASE_URL" -f db/seeds/seed_reference.sql
psql "$DATABASE_URL" -f db/seeds/seed_herbicides_verified.sql
psql "$DATABASE_URL" -f db/seeds/seed_simulation.sql      # 仅 preset_demo
```

**未接入真实数据库，本轮未执行以上命令**（无库、无 0001）。种子 SQL 由
`tools/knowledge/build_seeds.py` 从 `packages/knowledge/` 的 JSON 确定性生成，
改 JSON 后重新生成即可，勿手工编辑。

## 关键约束

- `applicability.card_ready` 只有 `crop_id/species_id/region_code/growth_stage/
  planting_method/use_scene/unit_text/dose_text/method_text/precautions_text` 全部非空才可为
  `true`——**缺项不得标为可用**。本轮 20 条缺用量/施用方法，一律 `card_ready=false`。
- `v_active_source_version` 只返回 `validity='valid' AND review_status='verified' 且非模拟`。
  本轮来源 `review_status` 均为 `unverified`，**该视图为空**，即未核对不进有效集合。
- `v_queryable_seed_version` 供 `stub`/联调，**显式暴露 `review_status=unverified`**，消费方必须标注“未核对”。
- `v_simulation_only` 单独暴露模拟数据，禁止混入真实查询。
- `sources.license_status` 默认 `deferred`、`licensed=false`；许可调查本轮暂缓，不得写为已许可。
