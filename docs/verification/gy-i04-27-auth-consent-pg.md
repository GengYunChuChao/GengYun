# GY-I04 / GY-I27：真实 PG17 授权读取与受限撤回

2026-10-09，写手 Yu0ry。Refs #4、#29；不是整项验收，不关闭 issue。

## 依赖与本次边界

独立 Fork 分支 `feat/auth-consent-pg-integration` 保留原有成果，正常合入最新 main `74007d93ba7a11070bcd983212237f7b0f8f7d3e`。PR #59 固定 HEAD `c37244afd6e7a869ce9fb0bf045995840260a178` 已于香港时间 2026-10-09 17:01:53 合并；[批准与实核批复](https://github.com/GengYunChuChao/GengYun/pull/59#pullrequestreview-5467970500)记录该 SHA 实际 13 项 CI 成功。本分支对当前 main 的真实差异仅剩本次八文件授权增量，不再包含 #59 的导入范围。

历史证据：[首次批复](https://github.com/GengYunChuChao/GengYun/pull/59#pullrequestreview-5467263936)时组织策略禁止 Fork 工作流、check 为零。该阻塞后来解除；现为允许 Fork run、只读令牌、不发送 secrets/variables、要求维护者批准。本 PR 的 CI 必须绑定自己的最新 HEAD，不复用 #59 或旧 #49 的结果；需要批准时仅报告 run，由维护者处理。

复用已合并的 0003 隐私 schema／`packages/privacy/guard.mjs` 和 PR #59 的 0008 幂等台账，不新增迁移，不改冻结契约或隐私参考组件。本次增量文件为 API app 挂载、`routes/consents.ts`、`privacy/consent-pg.ts`／类型声明、运行角色 SQL、原生 PG 集成测试、专用 CI 和本文档。

| 入口 | 已实现范围 |
| --- | --- |
| GET `/api/v1/me/consents` | 真实会话鉴权；当前用途记录（含已撤回）；本人分页；DTO 无 user_id；no-store |
| DELETE `/api/v1/me/consents/{purpose}` | 同事务重查账号及会话，强 If-Match、幂等键、原子记录／epoch／回执；受限撤回 |
| `createPostgresConsentService().requireConsent` | 事务内消费权威 userId/authEpoch 和真实持久用途状态，再调用现有 guard；仅返回读取核对结果 |

服务在事务内依次锁账号、会话和用途 epoch；托管授权变更须遵守同一账号锁协议。账号锁也串行化关联对象的 FK 插入。会话令牌摘要、撤销、到期与账号 epoch 均重查，提交前再次检查绝对到期时间。授权 epoch 与对应历史记录不一致、记录缺失、DTO 损坏均拒绝；从未授权的零 epoch 不放行。所有 PG/SDK 异常映射固定安全错误，不下发 SQL 原文。

撤回将 granted 记录改为 withdrawn、增加 record revision 和当前 purpose epoch，并把不含凭据的记录 ID 回执写入 0008；三者同时提交／回滚。旧撤回回执只返回自己的历史记录，不对后续重新授予产生副作用。同键不同 If-Match 冲突；不同键持旧 revision 竞争只成功一次；重放仍先鉴权。

**受限撤回**：用户已有任何 jobs、media、exports、author_links 时，返回 409 `OBJECT_UNAVAILABLE`，不修改授权或创建成功回执。当前业务消费者取消、访问撤销、对象／第三方处理尚未接入，不能给此类用户伪造撤回成功。记录存在但撤回版本过旧仍返回 `REVISION_CONFLICT`。

## 最小权限与复验

`services/api/db/roles/auth_privacy.sql` 是管理员执行的、适用于新专用库的角色引导，不是迁移或可重复扩权脚本。组 `gengyun_auth_privacy` 为 NOLOGIN、非超级用户、不能建库／角色、不能绕过 RLS。凭据由环境单独提供的 LOGIN 继承，API 不能使用迁移 owner。

角色仅具认证所需列、幂等台账、授权读取／撤回所需权限，依赖表只允许读取 owner/user ID 做存在检查。`users.updated_at` 的 UPDATE 是 PG 行锁所需权限；不能改账号状态或 epoch。禁止媒体正文、对象地址、微信密文读取、对象写入、接收方启用及管理员初始化。此角色是可信服务器服务账号，**不是逐用户 RLS 或可交给客户端的 SQL 账号**；应用 WHERE 与鉴权负责逐用户边界。管理员初始化及账号停用属于单独的特权流程。

在空的、仅回环地址的 `gengyun_auth_privacy_test` 数据库中，由安全环境变量 `AUTH_PRIVACY_TEST_URL` 提供测试 owner 连接，然后运行：

```powershell
node tests/integration/auth-privacy-pg.mjs
```

测试拒绝非回环、其他库名、非原生 17.11、已有 public 表或已有同名角色。owner 只做 0001／0003／0008 SQL 装载、合成夹具、角色配置及故障注入；真实 HTTP API 使用另一受限 LOGIN。测试结束关闭 HTTP／连接池，并清除本次创建的角色。外层临时 PG 进程由运行者停止。CI 用 `postgres:17.11` 服务、合成密码、只读 contents、禁用 checkout 凭据持久化，不引用服务 secrets。

本地用现有只读 PG17 二进制，在本 Fork 忽略目录 `.local/auth-privacy-pg/` 创建独立新集群；随机测试密码只在进程／短暂私有 ACL 文件，初始化后删除密码文件，结束停止实例。不使用旧数据库凭据、旧数据目录或已过期专门测试时段。没有云资源、生产数据、真实 AppID 调用、付费服务或个人媒体。

测试配置显式注入合成微信身份提供者，真实的是 HTTP／数据库／锁／权限，不是微信 code 交换。`buildApp` 注入 real meta 配置，不代表正式 `server.ts` 全资源启动已通过。测试专用 `test-only/consent-read` 路由仅存在于测试脚本，不挂到产品。授予夹具由 owner 插入，不能算授予 API 通过。

## 当前验证

原生 PostgreSQL `17.11`，Node `24.16.0`：23 组实际集成检查覆盖真实低权限连接、正常持久登录、本人分页、伪造身份、缺用途、零 epoch、后台令牌隔离、强 revision、两种并发撤回、SQL 故障原子回滚、依赖拒绝、旧回执与新授权隔离、损坏持久数据，以及账号停用／删除态／身份 epoch、会话撤销／到期竞态。并发用实际 PG 行锁及 `pg_stat_activity` 观察到的等待，随后改变状态并提交，验证 HTTP 请求重查结果。

最后一组授权撤回后的延迟读取竞态仅证明不会复用旧读取许可；**不是媒体任务旧回写／外发原子门禁通过的证据**。现有 PGlite/PG18 测试另列为单元证据，不替代这次原生 PG17。

整理依赖后重新运行原生 PG17.11 集成、既有单元／隐私 275 项、契约 6 项、lint、API／后台构建、小程序静态及本地调试、开发文档和契约校验；结果在 PR 绑定最终提交列出。远端 workflow 状态在 PR 逐次记录，有 run 或获准运行均不等于验收通过。

## 剩余范围

- POST `/me/consents` 授予仍未实现：生产当前政策版本来源、已验证 Recipient，以及同用途替换授权时取消旧消费者须一起接通；不能以测试夹具或任意字符串政策代替。
- 此 PG 读取守卫不承诺现有内存 reference store 的全部接口，不具备 PG `commitGate`。返回结果不能授权后续异步写入或发请求，不能当 recipient/config 检查或对外推理许可；媒体／外发消费者必须在自己的写入事务重查账号、用途、对象版本并原子提交。
- 媒体／任务／导出／公共作者关联的撤回、在途结果回写、Recipient 变更、第三方删除请求／确认、完整 7／30 日注销尚未完成；整项 GY-I04／27 及 M1 不因本增量完成。
- PR #59 依赖已合并，历史组织策略阻塞已解除；本增量仍需自己的 CI 和监工独立复验，写手不调整权限、不批准 run、不借所有者凭据。

## 后续媒体接口消费约定

权威身份来自认证中间件 `currentIdentity(request)`，包含 userId、authEpoch、role、sessionId；业务请求不能声明这些值。`requireConsent` 仅在自身事务内核对并返回读取快照，事务结束即不能担保之后的状态。媒体写入、外发与 complete 回调必须在各自实际副作用事务内重查账号／会话／所有必需用途和对象 revision，并遵守账号锁协议；不得把这份快照或客户端 epoch 当跨事务写许可。本 PR 不提供业务写入门禁，不修改 `packages/media`／`tests/media`，也不接管 PR #60。媒体消费及注销处理仍须协调下一独立增量。
