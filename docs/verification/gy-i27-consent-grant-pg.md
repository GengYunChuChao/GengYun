# GY-I27 授予授权：冻结 POST 与原生 PG17

2026-10-09，写手 Yu0ry，Refs #29、#4。基于 main `18053a30eaa4e49fa24432c463199abed7c2ee3c`，新分支 `feat/consent-grant-transaction`。PR #61 的读取／受限撤回已合并，[独立批复](https://github.com/GengYunChuChao/GengYun/pull/61#pullrequestreview-5468556307)限定其组件范围，本增量不把旧读取快照作为异步写入许可，不接管 PR #60 或修改媒体文件。

## 契约与职责

指挥首次派发曾额外要求授予强 If-Match；核对冻结 OpenAPI 后，指挥已明确纠正。POST `/api/v1/me/consents` **不新增必填 If-Match**，输入只有 purpose、policy_version、recipient_ids，拒绝其他字段；必填 Idempotency-Key，成功 201 + ConsentEnvelope + 强 ETag/no-store。同键同体收敛，同键不同摘要 409；若客户端额外传入 If-Match，按通用幂等契约仅纳入摘要，不作为授予版本条件。不同键是新的同意意图，按事务锁顺序串行产生新 epoch，不虚构不存在的客户端 revision 冲突。DELETE 保留已审强 If-Match。未修改 `packages/contracts`。

新增 0009 为服务端权威用途政策表 `consent_policies`，不提供管理 API 或生产种子。字段保存用途版本、来源类型／引用、条款内容 SHA256、核验依据、有效期、审查账号／时间及接收方配置绑定。每用途至多一个 enabled 版本。已审内容不能修改或删除；只能启停并保留历史。管理员通过新版本表达条款或接收方配置变更。迁移 SQL 自带事务，本轮直接装载的实测不宣称迁移运行器整体原子性。

授予必须存在当前、有效期内且已审启用的政策；请求 policy_version 必须一致。来源／审查引用必须符合受信配置格式。每个所选 recipient 必须在该版本的绑定集合中，当前 enabled、no_training_verified、deletion_verified，且 capability、policy_version、config_version 和在线／备份留存天数均与政策绑定相符（不超过现有 7／30 日 schema 门槛）；缺禁止训练或删除依据即拒绝。外部推理不能选空接收方。其他用途可在已审本地政策下无接收方。

这些是**消费管理员核验证据的服务端规则**，不是通过 URL 或 boolean 自动证明供应商可删除。正式政策条款、适用版本、来源与 SHA256、审查记录，以及逐接收方当前配置的禁止训练／留存／删除证据仍须实际提供和独立核验；本轮没有这些生产材料，也没有伪造已核验供应商。客户端提交版本只表达该版本的同意，不能创造政策／身份／接收方；正式条款展示、真人同意交互仍未验收。

`source_kind=synthetic` 只供测试。普通 `buildApp`／`server.ts` 默认拒绝；仅测试显式传入 `consentGrantTestOptions.allowSyntheticGrantPolicy=true` 后，才允许 fixture:// 来源／核验引用。无环境变量开关、默认生产政策或自动 enabled 种子。测试使用合成审查账号、条款引用和 Recipient，不称作真实第三方证据。

## 原子代次与权限

沿用已审账号／会话事务：锁并重查权威 userId/authEpoch、会话摘要／撤销／到期，再锁幂等键、政策／接收方、当前用途与记录。托管授权及关联对象变更遵守账号锁协议，账号锁同时阻挡新关联对象 FK 插入。

无业务依赖时，替换把旧 granted 行置 withdrawn，创建新记录，增加用途 epoch 和单调递增 revision，并在 0008 存只含新记录 ID 的 201 回执；一起提交／回滚。新记录 revision 不重置为 1，旧 DELETE ETag 不能在重授后重新成为当前版本。政策有效期和会话绝对到期在提交前重查，幂等重放也重新检查当前政策及记录；撤回／被替换／政策退役／账号停用后的旧授予回执不恢复许可。POST 与 DELETE、不同主体的键域隔离。

已有任何 jobs、media、exports、author_links 时，初次／替换授予均明确返回 409 OBJECT_UNAVAILABLE，不修改授权或留下新回执。业务取消与对象／第三方消费者尚未接通，不能把这个保守拒绝称为冻结说明中的完整“原子撤旧任务”。已有读取 guard 的返回值仍不是外发或异步写许可；本轮只维护授予与代次状态。

新 NOLOGIN 组 `gengyun_consent_granter` 由管理员单独引导，运行 LOGIN 继承它和已审 `gengyun_auth_privacy`：新增政策／接收方 SELECT、PG SHARE 锁所需的 updated_at UPDATE，以及授予记录／用途 epoch 的指定列 INSERT。不能启用政策、改证据／接收方、停用账号、读取私有媒体、DDL 或获取 owner。可信 API 服务角色不是逐用户 RLS，不能给客户端 SQL 账号。旧读取／撤回角色不被自动扩权；凭据由环境单独提供，本轮随机测试凭据不进入仓库。

## 可复验材料

新建空回环库 `gengyun_consent_grant_test`，用安全环境变量 CONSENT_GRANT_TEST_URL 提供测试 owner，然后运行：

```powershell
node tests/integration/consent-grant-pg.mjs
```

测试拒绝其他库名、非回环、URL override、非原生 PG17.11、已有 public 表／同名角色。owner 仅装载 0001/0003/0008/0009、合成夹具、角色配置和故障注入；产品 POST 实际监听本地 HTTP，独立受限 LOGIN 访问 PG。同一合成 registry 在默认应用中被拒绝，在显式测试应用中才通过。结束关闭 HTTP／连接池并清理自建角色；外层停止自建集群。新 CI 固定 postgres:17.11、Node24.16.0、只读 contents、无服务 secrets、checkout 不保留凭据。

授予专项 27 组包括：正常持久授予、冻结 DTO／无版本头、同键并发与异体冲突、不同键真实锁串行、授予／撤回竞争、旧授予和旧撤回回执、跨主体／操作隔离、全部四类依赖拒绝、政策／接收方证据和版本拒绝、SQL 记录后／回执前故障、替换失败恢复旧记录，以及账号／会话／政策／recipient 在实际锁等待后的变化和 SQL 延迟中的到期回滚。政策内容不可改／删、普通应用不接收 synthetic、低权限拒绝也以原生 SQL 实测。

既有读取／撤回专项另跑 23 组，单元／隐私 275、契约 6、lint、API／后台构建、小程序静态／4 项本地调试、开发文档／契约校验和 diff 检查的结果在 PR 绑定最终 SHA 分别列出。PGlite 的单元证据不冒称原生 PG17；远端 CI 是否批准、运行、成功另看本 SHA 的实际 run。

## 未完成项

正式政策与供应商证明缺失，因此真实运行尚无可用授予配置；代码保持拒绝。正式 AppID／微信工具／双平台真机、条款展示和真实同意、已有依赖的取消、媒体／业务外发及旧回写、第三方删除确认、7／30 日注销仍未完成。无生产部署、AI 请求、付费操作、个人媒体外发或旧测试窗口复用。#29/#4 和 M1 保持整项未验收。
