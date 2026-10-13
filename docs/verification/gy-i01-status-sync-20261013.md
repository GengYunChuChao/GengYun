# GY-I01 新 main 进度与接口对照同步

日期 2026-10-13；实际作者 cxhhandsome，已验正式 main `3e8f89bb7dcd79d4ffe509ec79260acd71b26ded`。
[领取记录](https://github.com/GengYunChuChao/GengYun/issues/1#issuecomment-6145616789)。仅 Refs #1，整项开放；文档证据绑定包含本记录的作者提交，reviewed_sha／CI 在 PR COMMENT 中记录。

## 先核对远端状态

官方 GitHub API／CLI 已读取真实当前用户、全部开放 PR 和原 27 项 issue，以及 #109／#113／#115／#116 的当前 HEAD、合并状态、检查与监工评论。
#109、#113、#115 分别合入 `f1db8ce`、`3e8f89b`、`5bd3e5f`，当前适用检查分别 13／13／14 项 SUCCESS。
监工批复及 reviewed_sha 可追溯：[授权列表](https://github.com/GengYunChuChao/GengYun/pull/109#issuecomment-6144495628)、[普通回执](https://github.com/GengYunChuChao/GengYun/pull/113#issuecomment-6144534448)、[科普分页](https://github.com/GengYunChuChao/GengYun/pull/115#issuecomment-6144472077)。
#107／#108 已合入 `1117770`／`55b95ce`；本机用户 main 已从 `55b95ce` 快进 `3e8f89b`，未合入待审分支。

#116 的 HEAD `e2208ae` 尚未合，监工说明作者证据可复用，但其 CI 不在前轮获批批次内、未运行：[批复](https://github.com/GengYunChuChao/GengYun/pull/116#issuecomment-6144546119)。
#106／#110 装配和 #111／#112／#114 部署技术准备仍开放，不算 main 已交付；保留原作者范围。原 27 项 issue 全部 OPEN，不虚增完成率。

## 文档缺陷与修订

新 main 上运行现有 `verify-contract-status --runtime`，原机器对照实际报 4 项越界：撤回授权、知识列表、知识详情、超时维度引用的源码行号已经失效。
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
| 原 main 机器对照 + `--runtime` | 4 项源码行号越界、exit 1；失败保留，未绕过校验 |
| 候选 `node tools/verify-contract-status.mjs --write-doc` | 覆盖／证据／静态装配通过后同步中文表；112 操作、32 装配、8 维度一致 |
| 候选 `node tools/verify-contract-status.mjs --runtime` | exit 0；无凭据 stub 子进程构建实际 Fastify 装配，不监听／不请求业务服务 |
| 既有工具回归 `node --test tests/unit/contract-status-tool.test.mjs` | 7 项通过；检查陈旧状态／中文表、装配和证据边界等既有反例 |
| `node tools/run-python.mjs tools/validate_development_docs.py`、`git diff --check` | 27 项编号／依赖／F／AC／Q、链接／表格与 diff 通过 |

另逐条比对候选和基线：112 项 id／method／path／route／scope／version_required／route_mounted 完全不变，只 listKnowledge 降档，其余操作状态不变；历史快照从原标记至文件末尾逐字保留。
复用已合 PR 的有效业务证据，不冒称本轮重跑全量单测、PG、微信、Android、供应商或发布验收。

用户已授权 DSH/HY3 并行文字辅助，本轮两个隔离目录／临时覆盖已尝试进度摘要与一致性核对；均约 34.9 秒以 `UNKNOWN_MODEL` 退出、无草稿／工具事件。
未向模型提供源码、真实资料或业务凭据，没有调整共享认证账户／宿主默认模型；本轮不计模型辅助成果，事实、改写和复查由作者完成。

文档组件完成不关闭 #1 或任何整项，#116 的 CI 尚未获批不等于测试失败或已通过。未批准 CI／合并／改权限／部署或新增真实付费业务验证。
