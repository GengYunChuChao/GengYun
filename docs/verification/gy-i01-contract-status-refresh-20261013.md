# GY-I01 接口对照刷新验证

日期：2026-10-13。作者账户 cxhhandsome；Refs #1，不关闭整项。

## 范围与基线

正式 main：`b1f6ab0e4dc304d2dd621d6a20852b31ccbfab3e`。分支 `codex/gy-i01-contract-status-refresh-20261013`，仅修改接口状态文档、校验工具及其回归测试。本轮用户直接要求领取无前置子项并经自查继续；已评论领取：[领取记录](https://github.com/GengYunChuChao/GengYun/issues/1#issuecomment-6137604585)。

已读当前评审规范、issue #1 既有成果和 PR #106 文件范围；#106 当前仍 OPEN，跨域 Job 注册未计入基线，也未修改其文件。新增的源码扫描支持 app.ts 从 routes 目录以外导入注册模块，正例 fixture 用具名别名导入的 jobs/routes.ts 验证此能力，不预先宣称 #106 的业务已交付。

## 改动与反例

- 旧基线校验实际有 16 条 route_mounted 不一致；识别、OCR、转写、合成和 Job 接口在 main 已注册，而旧对照记作未装配。新表记录 32 条已装配、80 条未装配。
- 逐条核对社区 16、消息 3、后台业务 34 个对应服务方法，补源码/测试证据，标 partial 且保持 route_mounted=false。新增 16 个已注册接口也仅标 partial；操作计数为 implemented 12 / partial 73 / planned 27，横切维度为 implemented 2 / partial 6 / planned 0。
- 已读取冻结操作元数据并逐项比较：112 条操作的 id、method、path、route、scope、version_required 未改；OpenAPI、状态契约和产品实现文件未改。
- 新工具先核对覆盖、证据与装配，再检查中文表格；只有显式 --write-doc 且前置检查通过才写表格，不自动升档状态。
- 反例覆盖未调用注册函数、仅注释调用、未知模板、陈旧装配标记、陈旧中文表格、重复条目、越界/私有证据与外部 junction。失败退出，错误时不写文档。
- 运行时在清洁子进程检查实际 buildApp + ready + hasRoute；反例设置合成业务配置及会抛错的 NODE_OPTIONS preload，验证均未继承。子进程实际无路由时，静态声明不能使核对假通过。

## 实际检查

本机 Node `v24.19.0`、npm `11.17.0`。工具回归使用临时合成仓库并清理；业务复验通过仅保留系统路径变量的子进程运行，不继承业务凭据。以下均退出 0：

| 命令 / 检查 | 结果 | 验证边界 |
| --- | --- | --- |
| `node tools/verify-contract-status.mjs --runtime` | 112 操作、8 维度、32 条装配和中文表一致 | 无监听、无服务请求的 stub 产品注册清单 |
| `node --test tests/unit/contract-status-tool.test.mjs` | 7 通过，0 失败/跳过 | 工具正常及失败路径、实际产品装配、环境隔离 |
| `node --test tests/unit/admin-contract-conformance.test.mjs tests/unit/admin-ops-contract.test.mjs tests/unit/community-contract.test.mjs tests/unit/messages-contract.test.mjs` | 23 通过，0 失败/跳过 | 独立服务/契约投影，未装配 HTTP 的证据 |
| `node tests/integration/recognitions-http.mjs` | PASS | 本机回环：识别闭环、并发幂等、取消/重放、旧版本拒绝 |
| `node tests/integration/ocr-http.mjs` | 11 组通过 | 产品装配回环；一组登记缺口由路由依赖接缝构造 |
| `node tests/integration/speech-http.mjs` | 14 组通过 | 产品装配回环、确认分离、终态、当前跨域 Job 404 缺口 |
| `node tests/integration/tts-http.mjs` | 36 组通过，0 失败 | 产品装配回环、核对内容守卫、截止/失败无结果 |
| `npm run test:contract` | 6 通过，0 失败/跳过 | 冻结错误码/状态/契约一致性 |
| `npm run lint` | API/后台类型与卫生扫描通过 | 无业务文件改动；静态检查 |
| `npm run test:docs` | 通过 | 当前需求、开发文档和文件覆盖一致性 |
| `git diff --check` | 通过 | 无冲突/空白缺陷；另核对完整 diff 和文件清单 |

记录随该分支提交，最终实际 HEAD、已验 base、CI 状态与申请合并由 PR 作者 COMMENT 绑定，避免把文件中的自引用 SHA 当成已验提交。CI 在发布前未运行，不能记为本机通过。

## 未验证与剩余

本轮没有修改业务实现，不为该工具/文档子项机械重跑完整业务单测、全部构建、微信或真机。业务 HTTP 为合成身份、替身提供者、内存 store；real 负例使用合成占位配置，未取得真实微信/供应商凭据验证，也不连接本地/生产 PG、不发新增付费请求。

共享 Job 读取/取消仍只消费识别域；真实媒体、登记用量来源、持久队列/租约、跨域生命周期与最终 #1 验收仍未完成。相关领域库不等于产品服务，未装配的服务不等于可用 API。OCR 两模式用量端口恒空，真实 ASR/TTS/OCR/识别能力及一加 ACE3V 未由本轮验证。

作者自查按 [PR 规范](../pr-review-policy.md) 的局部工具/文档层执行；不作自身 APPROVED，不代替监工合并或独立验收。
