# 本地 knowledge 受限接线：待原生及发布验证

> 后续写手接续：保留本页子写手历史及失败边界；已正常同步main2d562d5，在自己的全新r3窗口完成实际启动/HTTP/停机/重启，并修正PS5退出码误报，见[原生启动验证](local-knowledge-native-20261011.md)。下文“尚未执行/无法发布”为交接当时状态。

Refs #2/#7，软件组件口径，不关闭父 issue。已通过 GitHub 只读连接器核对上游 main `8932ba5153709ed67e2944984c3b891f38e1a951`、PR76 review5481696724、PR79 review5482194171；两组件已合并，旧阻塞不重复修订。PR80 是另一写手的草稿前端，#8/#12 保留协作者领取。

真实 main 对象已通过指挥提供并验证的完整历史 bundle 只读导入；feature/local-knowledge-wiring 已正常 rebase 到 `8932ba5153709ed67e2944984c3b891f38e1a951`，恢复后的实现提交是 `7094c3812c7629462bd45e8c066aaa4c6cf65610`。旧 `8b44b02996f112a13e2a412ba0ac8bd92871c783` 保存在 local-knowledge-before-main-8b44b02 分支与自己的恢复 bundle，原79分支没有改写。尚未推送或创建PR；当前沙盒的 Yu0ry credential helper 仍报 wincredman 无法持久化、无交互密码，不使用owner连接器代写Fork。

## 组件变化和验收边界

- 原 bootstrapLocalProfile 统一事务中引导 profile_runtime 与已审 knowledge_runtime；明确白名单仅加后者。原授权前、授权后、提交前传递闭包检查和失败回滚保留，不把组的NOLOGIN或低权限标志当作不存在owner成员链。
- 启动前要求 current_knowledge 为当前迁移owner拥有的 security_barrier 视图。缺迁移、非安全视图或错误owner直接拒绝。知识组只能读该投影；新增逐列/表权限及schema CREATE检查，拒绝私有原表、其他业务表、写权限或危险继承链。既有超权组不自动降权修复。
- 不改app、业务路由、投影、前端、来源审批或现有数据。目录仍是明确合成夹具；自动引导不添加source/knowledge。默认烟测验证游客401、登录后无合格知识空态、原profile GET/保存/重放/冲突、SQL拒绝和退出旧会话知识401。
- 新 local-knowledge-smoke 仅接受本repo忽略.local目录中的显式本地窗口，并拒绝已有source/knowledge。owner仅临时建立标明synthetic的来源/正文/审核人，真实API使用独立限权LOGIN；测试同源列表详情、撤回后详情404与空列表、DoseCard=[]，随后移除自己生成ID的夹具并恢复原数据集配置。不作为生产审批或导入器。
- Windows PowerShell5.1的Framework没有原启动器调用的静态RNG.GetBytes/Convert.ToHexString。改用RNG.Create/GetBytes(byte[24])/BitConverter，仍为独立192bit随机密码，保留私密ACL、SCRAM、Hidden后台启动；不改全局ExecutionPolicy或下载运行时。

## 已实际验证

Node24.16.0、Windows PowerShell5.1。`node --test tests/unit/local-profile-bootstrap.test.mjs tests/unit/local-dev-package.test.mjs tests/unit/profile-api.test.mjs tests/unit/knowledge-api.test.mjs tests/contract/*.test.mjs`：30项，29通过、失败0、1明确原生专项跳过。bootstrap采用显式PGlite命名探测适配，其他创建角色/GRANT/SET SESSION AUTHORIZATION/pg_has_role/数据写入均真实SQL，不冒称原生网络LOGIN。

覆盖知识组跨owner/pg_read_all_data成员链、私有body列SELECT超权、授权后注入危险链、最终失败后两组创建和授权/目录全部不残留、缺/非security_barrier/错误owner投影拒绝。原profile危险角色、授后、最终回滚与拒owner案例保留。Windows新增密码兼容测试实际执行启动脚本中的生成函数，只检查两个48位hex不同，不输出密码。打包仍拒覆盖既有输出和拷贝凭据，正式runtime/domain检查保留。

lint（API/admin typecheck、卫生扫描）、新集成脚本node --check、docs/diff通过。此前PR79原生9/9证明的是未变知识服务，不替代本次新的启动接线或重启验收。

## 原生尝试及真实阻塞

只复用PG17.11 bin，不读取旧data/log/凭据。在自己clone忽略目录复制明确源码形成两个全新测试根，未覆盖历史.local/local-dev：

1. `.local/local-knowledge-check` prepare成功，新3218/55473端口空闲；默认Windows脚本策略先拒绝文件执行。本进程仅用RemoteSigned后，启动器旧Framework静态RNG调用失败，没有服务启动。
2. 修订兼容后 `.local/local-knowledge-check-ps5` 再次真实prepare成功，随机私密配置成功生成，initdb报 `could not create restricted token: error code 87`。这是当前Windows沙盒进程限制；请求到network/Git配置/PG程序只读权限仍不能使原生初始化成功。未使用require_escalated反复重试、修改PG安全代码或复用旧cluster冒充新证据。

本轮没有PG_VERSION，没有postmaster/API PID，3218及55473无监听。密码文件由原finally移除，随机配置留在自己的已忽略private目录，未输出或提交。prepare只验证准备，不能写成start/HTTP/stop/restart通过。local-knowledge-smoke的实际原生路径尚未执行；因此本组件尚不可按原生验收通过。

### 最新恢复后复测

只读导入真实main后，再次获得本会话network/Git配置/PG程序只读权限，未获得改变PG安全行为的授权。在第三个全新根 `.local/local-knowledge-check-recovered` 实际prepare成功，3218/55473预检空闲，随机私密配置与initdb成功，`PG_VERSION=True`。随后原Hidden pg_ctl启动仍失败：`could not create restricted token: error code 87`、`could not start server: error code 3`。仅检查了自己新窗口的脱敏错误；没有API PID、监听或运行中的服务。没有把初始化成功等同HTTP或重启通过，也没有复用旧cluster。

同轮精确 require_escalated 请求在执行前被工具拒绝，实际策略为 Granular `sandbox_approval:false`；不重复该请求。默认上下文重新核验Yu0ry仍报 `Unable to persist credentials with the 'wincredman' credential store`，终端密码交互禁用，未获得token、未调用GitHub写接口。上述旧两窗口记录保留为历史，不把旧失败沿用为最新结果。

真实main恢复后再次执行受影响API/角色/打包/契约集合，仍30项、29通过、0失败、1明确原生专项跳过；本轮程序没有更改，因此未重复无关全量验收。

## 最小交接与继续命令

需要恢复正常Windows进程执行环境与独立Yu0ry认证；不要发送密码或令牌。真实main同步已完成。不要在共享目录修改remote/全局认证，也不要使用owner连接器发布。

以下在自己的新独立clone、已同步待审分支、未存在.local/local-dev、PG程序实际17.11且两个端口空闲时执行。新正常用户应从新输出重新生成随机凭据，不复用上述失败窗口或别人的数据库。凭据只留private文件，日志/聊天不传令牌。

```powershell
node tools/local-dev/prepare.mjs --pg-bin "<PG17.11 bin绝对路径>" --api-port 3218 --pg-port 55473
Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned
& ./.local/local-dev/start.ps1
node .local/local-dev/smoke.mjs
node tests/integration/local-knowledge-smoke.mjs .local/local-dev
& ./.local/local-dev/stop.ps1
& ./.local/local-dev/start.ps1
node .local/local-dev/smoke.mjs
node tests/integration/local-knowledge-smoke.mjs .local/local-dev
& ./.local/local-dev/stop.ps1
```

首次与重启应核对API为gengyun_local_runtime，owner只初始化，并保留端口/PID、源码LF哈希和脱敏结果。每步失败立即保留失败证据；只停止自己创建的服务。微信消费交给原写手：其独立prepare产生的wechat路径和回环API端口可以交接，不能复制本窗口密码；此前320px截图不能当当前业务API渲染。当前没有供前端实际使用的已启动窗口。

仍未完成：个人Fork PR、原生prepare→start→HTTP→stop→restart、当前业务API微信消费/320px/Android、真实资料/身份/HTTPS和herbicides。无供应商请求、费用或部署。
