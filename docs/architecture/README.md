# 架构与契约文档索引

本目录是 GY-I01（issue #1）冻结提案的落地说明，契约 `1.0.0`、提案修订 `2`。

**契约源在别处**：机器可读的路径、字段与枚举以 [OpenAPI](../../packages/contracts/openapi.json)、[操作清单](../../packages/contracts/operations.json)、[状态与错误字典](../../packages/contracts/states.json)为准。本目录只解释行为、覆盖与**当前实现到哪一步**。

| 文档 | 作用 | 说明 |
| --- | --- | --- |
| [ADR-001 初始架构](adr-001-initial-architecture.md) | 技术选型与边界 | 原生小程序、独立后台、Fastify 模块化单体 |
| [数据字典](data-dictionary.md) | 实体、字段、关系、索引与迁移约定 | 语义入口 |
| [状态协议](state-contract.md) | HTTP、任务与隐私行为 | **实施必须遵循的行为，不是已运行证据** |
| [契约实现状态对照](contract-implementation-status.md) | 哪些契约**现在就能调**、调不通该等哪一项 | GY-I01 收尾交付；机器可读副本 [contract-status.json](contract-status.json) |
| [路由 × 契约对照表](openapi-route-parity.md) | 已挂载路由与 OpenAPI 操作的双向对账（多出／少掉／台账漂移） | 由 `node tools/openapi-route-parity.mjs --write-doc` 生成，勿手改标记块 |
| [F / AC 覆盖与交接](acceptance-map.md) | 功能与验收场景到模块、消费任务 | 设计覆盖，**不是运行 AC 通过** |
| [GY-I01 验证记录](validation.md) | 契约本身的检查与限制 | 契约一致性、标准 schema、负例 |
| [Excel 暂存设计](workbook-staging-design.md) | 未审核增量暂存的表与权限 | GY-I03 前置 |
| [数据保留策略表与清理执行器](gy-r34-retention-policy.md) | 跨表「日历保留」：策略表、排除清单、执行方式（dry-run 优先）、审计要求 | GY-R34 并行切片；策略表＋幂等执行器＋单测＋真库臂＋**日级调度单元**已落地；`verify:purge-schedule` **已进 CI**（`.github/workflows/engineering-shell.yml:140` 的 `retention-gates` job，`:153` 执行），三对 `.service`／`.timer` 在 `deploy/purge-schedule/`；运行侧读数（`systemctl list-timers`／`journalctl`）仍未取得（2026-10-26 复核，详见文内「未做项」） |
| [逐用户备份副本域设计](gy-i19-user-backup-copies-design.md) | 「在线 7 日／备份 30 日」里的备份轴：表、写入、清除、契约映射 | GY-I19 后续片；**设计稿时点**未落地 DDL、未接线，**GY-R28 起已落地**（`0023_user_backup_copies.sql` ＋ `services/api/src/privacy/backup-copies-pg.ts`，有真库连接时装配）——**契约状态仍未改**；「到期执行」的代码与调度已取得（三条 `purge:*` ＋ 三对 systemd 单元 ＋ 真库臂 ＋ CI），**仍未取得的只剩第三方删除完成证据**（逐项见 [现状清单](gy-r59-retention-backup-thirdparty-map.md)） |
| [API 层限流策略与调参](rate-limit-policy.md) | 认证端点按 IP／写接口按用户的限流：默认值表、429 与 `Retry-After`/`X-RateLimit-*` 口径、调参表 | GY-R34；**单实例内存计数，多实例需外置存储**（换 `RateLimitStore` 实现即可） |
| [数据面需求-实现-证据矩阵（S4）](s4-data-traceability.md) | F13 拆成 16 个判定项，逐项给需求行号、实现落点、可复算证据与缺口 | S4 片；四档＝已实现 2／部分 9／未实现 4／已搁置 1，两条经门槛的真实缺口（★G3 已于 2026-10-26 复核消解，整条留档）见文内 §6 |
| [后台能力现状图（apps/admin）](admin-console-capability-map.md) | 后台现在能做什么、服务端已有什么、缺什么：现行读数取该页 §0「机器重算」标记块——`/admin` 46 条注册路由、46 个 operation **全部有** UI 入口、无 UI 入口 **0 个**、死按钮 0 个（`totalOps=46`／`withUiEntry=46`／`noUiEntry=0`／`deadButtons=0`）；本行旧稿的 36 条 path／45 个 operation／42 条路由分域／UI 入口 32 个／无入口 12 个，属 `68dec742` 时期手数，留作历史对照 | 只读代码取证，基线 `68dec742`；每条结论给「文件:行号」，不含运行证据 |
| [数据保留／备份／第三方完成证据现状清单](gy-r59-retention-backup-thirdparty-map.md) | 保留期真源、三个执行者与调度单元、备份三义、第三方证据的库层/应用层分界、恢复清单 | GY-R59 切片；逐项给 `文件:行号`＋三档清点＋最小三件事；并记下 2026-10-26 复核后修正的 S4 ★G3、`s4-data-traceability.md:354`、本页 `:17` 三处过期说法 |

## 怎么用

1. 想确认某个接口「现在能不能调」→ 读[契约实现状态对照](contract-implementation-status.md)，按 operation id 或路径查。
2. 想知道行为应该是什么 → 读[状态协议](state-contract.md)与 [OpenAPI](../../packages/contracts/openapi.json)。
3. 想知道契约本身是否自洽 → 读[验证记录](validation.md)，并跑 `npm run test:contract`。
4. 对照表是否会腐烂 → `node tools/verify-contract-status.mjs`（校验覆盖性、`app.ts` 装配一致性与证据可复核）。
5. 想知道「实现里挂的路由」和「契约里写的操作」有没有分叉 → 读[路由 × 契约对照表](openapi-route-parity.md)，并跑 `node tools/openapi-route-parity.mjs`（CLI 只汇总多出／少掉／台账漂移／例外数四类数值缺口；完整闸门在 `npm run test:contract`，那里还要校验契约内部完整性与文档新鲜度）。

对照表里的三档状态只描述**实现进度**，不构成验收结论；契约经监工确认后下游按冻结版本验收。
