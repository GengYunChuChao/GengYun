# GY-I01 处理中幂等请求的 HTTP 等待提示

日期：2026-10-13。作者 cxhhandsome；Refs #1，只修订现有 HTTP 错误出口，不关闭整项。

## 范围与来源

基线正式 main `b1f6ab0e4dc304d2dd621d6a20852b31ccbfab3e`，分支 `codex/gy-i01-idempotency-retry-after-20261013`。领取记录：[issue #1 评论](https://github.com/GengYunChuChao/GengYun/issues/1#issuecomment-6138084231)。

[状态协议](../architecture/state-contract.md)第 34 行已约定：同键请求处理中返回 `409 REQUEST_IN_PROGRESS`，附带 `Retry-After`。现有 `runIdempotent` 会有界等待并返回该错误，统一 `ApiError` HTTP 映射却未发送等待头。

本次 `services/api/src/app.ts` 仅追加注释和一行条件：该错误附带 `Retry-After: 1`，单位为秒，是客户端稍后重试的建议，不承诺业务一秒内完成。其余错误、状态码、错误封套/重试标记、鉴权、占位、重放和业务行为不变。原键重试仍由已有服务重查当前身份/权限，不自动重试客户端操作。

没有调整冻结契约、路由注册、数据库/迁移、供应商、依赖或工作流；PR #106 的注册/分派改动不在本次范围。PR #107 是旧 main 的状态对照刷新，本次不依赖它合并，其基线中的 Retry-After 缺口由本 PR 单独修复；后续更新对照时须据实际已合 main 核对，不能据此把整个幂等维度升为 implemented。台账过期、键域、内存持久化等未由本次完成。

## 复现与验证

Node `v24.19.0`、npm `11.17.0`。新回归在修复前的统一出口上失败两项：真实本机登录响应缺少 retry-after（null），错误出口探针也缺少该头（undefined）；均应为字符串 `1`。

实际产品登录验证使用 `buildApp`、127.0.0.1 随机端口及 `fetch`。身份交换为受控合成端口，内存会话/幂等存储；门闩在首个请求完成占位后暂停身份交换，确保第二个同键请求实际进入已有等待/拒绝路径，而非直接抛一个预设错误。

- 处理中：真实 HTTP 409、`REQUEST_IN_PROGRESS`、`Retry-After: 1`、原有 retryable=true、契约/模式/请求 id 正常；身份交换仅一次，等待者未建会话。
- 完成后原键重试：200，无等待头；仍仅一次交换/一次建会话，保持首次绝对时效，在同一会话换发令牌。
- 同键不同内容：409 `IDEMPOTENCY_CONFLICT`，无等待头；短键 400 和无会话 401 同样不带该头。
- 补充错误出口探针：只有 `REQUEST_IN_PROGRESS` 附加等待头；其他 409、503、504 的状态/码/封套和域内重试标记均保持原行为。探针只在测试实例注册，不是新增产品接口，也不代替前述实际业务路径。

相称检查均退出 0：

| 命令 | 结果 |
| --- | --- |
| `node --test tests/unit/idempotency-retry-after-http.test.mjs tests/unit/auth-routes.test.mjs tests/unit/api-errors.test.mjs tests/contract/contract-codes.test.mjs` | 39 通过、0 失败/跳过 |
| `npm run lint` | API/后台类型及仓库卫生通过 |
| `npm run test:docs` | 文档、27 项依赖及链接/表格通过 |
| `git diff --check` | 通过；完整 diff 仅现有出口、新回归与本记录 |

最终验证通过仅保留系统路径变量的子进程执行，不继承业务配置/凭据或 NODE_OPTIONS；测试结束释放门闩并关闭自己的监听。未运行全业务、全部构建、数据库、微信工具或真机，未调用真实身份/供应商、未付费/部署。这些不由两行错误出口改动推定通过。

## 自查与交付

按 [PR 规范](../pr-review-policy.md)执行局部组件/HTTP 层自查。最终 HEAD、已验 base 与实际 CI 状态在 PR 作者 COMMENT 绑定；不作自身 APPROVED，也不绕过 Fork CI 的维护者批准。

本组件提交、自查和申请合并后按用户要求暂停。未合并成果不当作 main 已有功能，issue #1 保持开放。
