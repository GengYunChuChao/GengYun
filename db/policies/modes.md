# 资料数据集模式与来源匹配（real / stub / preset_demo）

来源类型（`sources.source_kind`）与执行模式（`ExecutionMode`）分开建模，请求**不接受**
客户端切换模式（见 ADR-001）。模式由服务端配置写入 `knowledge_dataset_config.active_mode`。

## 模式定义

| 模式 | 接受来源 | 明显标记 | 用途 |
| --- | --- | --- | --- |
| `real` | `database` / `verified_seed` | 否 | 接入真实资料库后的权威查询；不接受模拟 |
| `stub` | `verified_seed`（有来源种子） | 是（须标“未核对”） | 无真实库时联调；不得当作用量依据 |
| `preset_demo` | `simulation` | 是（强制） | 比赛演示兜底；仅合成数据 |

数据库侧由 `knowledge_dataset_modes` 表的 CHECK 强制：
- `real` 模式 `accepts_simulation` 必须为 `false`；
- `preset_demo` 模式 `accepts_simulation=true` 且 `requires_clear_label=true`。

## 当前状态（本轮真实）

- `knowledge_dataset_config.active_mode = 'stub'`，`database_connected = 'false'`。
- 未接入真实库；`real` 模式可用记录为 **0**（无 `verified` 来源、无数据库）。这是**接入缺项**，
  不是“已接入”。
- 20 条除草剂为 `verified_seed`，可在 `stub` 下查询，但必须显示“来源未核对 / 不可作用量依据”。

## 切换与回滚

- 切换模式只改 `knowledge_dataset_config`，并核对当前数据集 `source_kind` 是否满足该模式；
  不满足即拒绝切换（例如 `real` 下存在模拟记录则拒绝）。
- 导入前写 `catalog_import_runs`，冲突写 `catalog_import_conflicts`，来源有效性变化/撤回/回滚写
  `catalog_source_update_events`。
- 种子回滚执行 `db/seeds/rollback_seed.sql`：按来源版本删除适用/登记/制剂，再把导入运行置 `reverted`。
- **回滚不恢复已注销身份/媒体**；共享字典表结构不动（与 0001 共源）。
