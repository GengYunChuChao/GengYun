# 开发参考索引

新人先读[开发指南](../development-guide.md)。本目录与下列链接用于按需查阅，不作为每个 PR 必须全文重读的清单。

| 内容 | 主记录 |
| --- | --- |
| 产品／完整软件功能与验收 | [产品需求](../product-requirements.md)、[代码需求](../implementation-requirements.md) |
| API 字段／枚举与样例 | [OpenAPI](../../packages/contracts/openapi.json)、[状态](../../packages/contracts/states.json)、[样例](../../packages/contracts/examples.json) |
| 数据关系／权限／状态 | [数据字典](../architecture/data-dictionary.md)、[状态协议](../architecture/state-contract.md) |
| 当前关键决策／历史 ADR | [指南](../development-guide.md#5-接口契约与关键决策)、[ADR-001](../architecture/adr-001-initial-architecture.md) |
| 配置与本地排查 | [完整配置](configuration.md)、[本地开发](local-development.md) |
| 本地受控环境（一条命令起 PG + stub API） | [本地环境运行手册](local-env-runbook.md) |
| 真实能力配置自检 | [能力自检](real-capability-selfcheck.md) |
| 数据库运行／回滚细节 | [组件交接](../verification/database-run-handoff.md)及其固定 SHA 验证页 |
| 部署准备（微信云托管 API ＋ 上海 CVM PG） | [云托管部署准备](../../deploy/cloudrun/README.md)、[平台字段与机密清单](../../deploy/cloudrun/service-settings.md) |
| 独立样本／评分细节 | [评估入口](../evaluation/README.md)、[评分](../evaluation/scoring-spec.md)、[缺口](../evaluation/sample-gap-register.md) |
| 供应商／平台证据 | [验证入口](../verification/README.md)、[平台清单](../verification/platform-checklist.md)；注意各记录日期与 SHA |
| 正式任务／调整史 | [任务台账](../initial-issues.json)、[任务列表](../initial-issues.md)、[调整记录](../issue-revision-log.md) |
| 后续阶段 | [二月规划](future-scope.md) |
| 旧开发文档 | [2026-10-10 精简前存档](../archive/development-2026-10-10/INDEX.md) |

API／字段详情沿用现有独立契约，不再复制到主指南。验证页保留提交时事实，不将历史“未连接”或“待审”当当前状态。

本次精简范围与实际检查见[文档验证记录](../verification/docs-simplification-20261010.md)。
