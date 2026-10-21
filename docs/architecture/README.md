# 架构与契约文档索引

本目录是 GY-I01（issue #1）冻结提案的落地说明，契约 `1.0.0`、提案修订 `2`。

**契约源在别处**：机器可读的路径、字段与枚举以 [OpenAPI](../../packages/contracts/openapi.json)、[操作清单](../../packages/contracts/operations.json)、[状态与错误字典](../../packages/contracts/states.json)为准。本目录只解释行为、覆盖与**当前实现到哪一步**。

| 文档 | 作用 | 说明 |
| --- | --- | --- |
| [ADR-001 初始架构](adr-001-initial-architecture.md) | 技术选型与边界 | 原生小程序、独立后台、Fastify 模块化单体 |
| [数据字典](data-dictionary.md) | 实体、字段、关系、索引与迁移约定 | 语义入口 |
| [状态协议](state-contract.md) | HTTP、任务与隐私行为 | **实施必须遵循的行为，不是已运行证据** |
| [契约实现状态对照](contract-implementation-status.md) | 哪些契约**现在就能调**、调不通该等哪一项 | GY-I01 收尾交付；机器可读副本 [contract-status.json](contract-status.json) |
| [F / AC 覆盖与交接](acceptance-map.md) | 功能与验收场景到模块、消费任务 | 设计覆盖，**不是运行 AC 通过** |
| [GY-I01 验证记录](validation.md) | 契约本身的检查与限制 | 契约一致性、标准 schema、负例 |
| [Excel 暂存设计](workbook-staging-design.md) | 未审核增量暂存的表与权限 | GY-I03 前置 |
| [逐用户备份副本域设计](gy-i19-user-backup-copies-design.md) | 「在线 7 日／备份 30 日」里的备份轴：表、写入、清除、契约映射 | GY-I19 后续片；**设计稿时点**未落地 DDL、未接线，**GY-R28 起已落地**（`0023_user_backup_copies.sql` ＋ `services/api/src/privacy/backup-copies-pg.ts`，有真库连接时装配）——**契约状态仍未改**，#19 的到期执行与第三方证据仍未取得 |

## 怎么用

1. 想确认某个接口「现在能不能调」→ 读[契约实现状态对照](contract-implementation-status.md)，按 operation id 或路径查。
2. 想知道行为应该是什么 → 读[状态协议](state-contract.md)与 [OpenAPI](../../packages/contracts/openapi.json)。
3. 想知道契约本身是否自洽 → 读[验证记录](validation.md)，并跑 `npm run test:contract`。
4. 对照表是否会腐烂 → `node tools/verify-contract-status.mjs`（校验覆盖性、`app.ts` 装配一致性与证据可复核）。

对照表里的三档状态只描述**实现进度**，不构成验收结论；契约经监工确认后下游按冻结版本验收。
