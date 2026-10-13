# GY-I01 新 main 进度与接口对照同步

日期 2026-10-13；实际作者 cxhhandsome，当前已验正式 main `769420ae2f46166d651823a86af687456f3c75e3`；初轮已验基线 `3e8f89bb7dcd79d4ffe509ec79260acd71b26ded`。
[领取记录](https://github.com/GengYunChuChao/GengYun/issues/1#issuecomment-6145616789)。仅 Refs #1，整项开放；文档证据绑定包含本记录的作者提交，reviewed_sha／CI 在 PR COMMENT 中记录。

## 先核对远端状态

官方 GitHub API／CLI 已读取真实当前用户、全部开放 PR 和原 27 项 issue，以及 #109／#113／#115／#116 的当前 HEAD、合并状态、检查与监工评论。
#109、#113、#115 分别合入 `f1db8ce`、`3e8f89b`、`5bd3e5f`，当前适用检查分别 13／13／14 项 SUCCESS。
监工批复及 reviewed_sha 可追溯：[授权列表](https://github.com/GengYunChuChao/GengYun/pull/109#issuecomment-6144495628)、[普通回执](https://github.com/GengYunChuChao/GengYun/pull/113#issuecomment-6144534448)、[科普分页](https://github.com/GengYunChuChao/GengYun/pull/115#issuecomment-6144472077)。
#107／#108 已合入 `1117770`／`55b95ce`；本机用户 main 初轮从 `55b95ce` 快进 `3e8f89b`，本轮再快进 `769420a`，未合入待审分支。

#116 的 HEAD `e2208ae` 尚未合，监工说明作者证据可复用，但其 CI 不在前轮获批批次内、未运行：[批复](https://github.com/GengYunChuChao/GengYun/pull/116#issuecomment-6144546119)。
#106 已合入 `769420a`，13 项 CI 成功：[监工合并批复](https://github.com/GengYunChuChao/GengYun/pull/106#issuecomment-6146829321)。#110 装配和 #111／#112／#114 部署技术准备仍开放，不算 main 已交付；保留原作者范围。原 27 项 issue 全部 OPEN，不虚增完成率。

## 文档缺陷与修订

初轮 main `3e8f89b` 上运行现有 `verify-contract-status --runtime`，原机器对照实际报 4 项越界：撤回授权、知识列表、知识详情、超时维度引用的源码行号已经失效。
授权裸游标和 Retry-After 缺失也仍被写作阻塞，进度首页仍是 10 月 11 日旧组件快照。
本轮只修正文档、证据及当前摘要，机器／中文副本保持一致，不修改工具、业务、冻结契约或工作流。

- 授权与科普签名／固定 15 分钟期限、失效恢复、Retry-After 和认证／四类任务普通回执 24 小时均按真实已合 SHA 记录。
- 授权政策／接收方配置、知识排序、后台默认／到期及持久化等剩余保留；列表读取本身不声称直接依赖授权政策表，grant 的运维配置和真实用途链路分别说明。
- listKnowledge 仍有 `id_asc` 与冻结排序不一致，按既有状态定义从 implemented 修正为 partial，没有删除接口或降低实际功能。计数为 11 implemented／74 partial／27 planned，装配仍 32／112；八个横切维度仍 2 implemented／6 partial。
- 历史进度快照保持原文，首页改为当前组件及剩余验收，真实能力／资料／Android／云部署分列。候选文档本身尚未进入 main。

## 相称验证

Windows，Node `v24.19.0`、npm `11.17.0`。干净子进程只保留系统环境，不传业务凭据。

| 检查 | 实际结果 |
| --- | --- |
| 初轮 main `3e8f89b` 机器对照 + `--runtime` | 4 项源码行号越界、exit 1；失败保留，未绕过校验 |
| 候选 `node tools/verify-contract-status.mjs --write-doc` | 覆盖／证据／静态装配通过后同步中文表；112 操作、32 装配、8 维度一致 |
| 候选 `node tools/verify-contract-status.mjs --runtime` | exit 0；无凭据 stub 子进程构建实际 Fastify 装配，不监听／不请求业务服务 |
| 既有工具回归 `node --test tests/unit/contract-status-tool.test.mjs` | 7 项通过；检查陈旧状态／中文表、装配和证据边界等既有反例 |
| `node tools/run-python.mjs tools/validate_development_docs.py`、`git diff --check` | 27 项编号／依赖／F／AC／Q、链接／表格与 diff 通过 |

另逐条比对候选和基线：112 项 id／method／path／route／scope／version_required／route_mounted 完全不变，只 listKnowledge 降档，其余操作状态不变；历史快照从原标记至文件末尾逐字保留。
复用已合 PR 的有效业务证据，不冒称本轮重跑全量单测、PG、微信、Android、供应商或发布验收。

用户已授权 DSH/HY3 并行文字辅助，本轮两个隔离目录／临时覆盖已尝试进度摘要与一致性核对；均约 34.9 秒以 `UNKNOWN_MODEL` 退出、无草稿／工具事件。
未向模型提供源码、真实资料或业务凭据，没有调整共享认证账户／宿主默认模型；本轮不计模型辅助成果，事实、改写和复查由作者完成。

文档组件完成不关闭 #1 或任何整项，#116 的 CI 尚未获批不等于测试失败或已通过。未批准 CI／合并／改权限／部署或新增真实付费业务验证。

## #106 合入后的受影响范围补验

依据[监工新 base 反馈](https://github.com/GengYunChuChao/GengYun/pull/117#issuecomment-6146861994)，作者分支正常合成正式 main `769420a`，未重写历史或修改上游业务代码。当前 JSON 基线同步为该 SHA、proposal_revision 为 5，中文摘要和当前进度一并更新。

- getJob／cancelJob 证据改指公共 `jobs/routes.ts` 单一注册与真实 app 装配、作业源及现有 HTTP 反例。识别与转写读取、识别取消已经接通；两条原有路径迁移不增加装配数量。
- 转写作业虽能读取，取消能力仍未接线，实际注册表返回 503 PROVIDER_UNAVAILABLE（retryable）。OCR／合成仍未注册公共读／取消，持久队列／租约／恢复、真实能力／样本和 Android 剩余保留。
- 同步四条转写操作和取消维度中的关联缺口描述；修正上游新增 import／装配导致的识别路由与 Retry-After 证据行偏移。没有因共享读面合入而升级任何状态。

新 base 上重新运行 `node tools/verify-contract-status.mjs --write-doc --runtime`、既有 7 项工具回归、开发文档校验及 `git diff --check`，均通过；112 操作、32 装配、11 implemented／74 partial／27 planned 与上一候选一致。逐项核对冻结字段、路由标记、维度状态和历史快照仍未改变，完整 PR diff 相对新 main 仍仅 4 个文档。

复用监工与原作者已验 #106 的作业结果反例／五域 HTTP／CI 证据，本轮不重复或冒称业务、PG、供应商、微信或真机测试。原 DSH/HY3 失败记录保留，本次文档补验没有新增模型辅助成果。当前 HEAD 和 CI 门禁以最新 PR COMMENT 为准；不代监工批复或合并，#1 及相关整项仍开放。
