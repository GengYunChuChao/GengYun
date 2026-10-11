# 本地知识受限启动与原生重启验证

2026-10-11。Refs #2/#7，组件范围，不关闭整项。

## 固定来源与修改

已读取当前 README 推荐路线。接续交接提交 b2d79bc56672c697af11beebc9e09f96792544f6，保留原作者提交，正常合入 main 2d562d5b6fb79896ef8935716b90939538f274c2；合并提交 cdb1046。PR80已合并，未重复修改知识前端。

既有实现仅给本地受限启动流程增加已审 knowledge_runtime 组及投影检查，保留PR76成员权限闭包、授权前后/提交前校验与失败回滚；不修改业务路由、SQL、前端。默认启动仍不导入source/knowledge，知识投影只有SELECT，拒绝额外私表/列权限和schema写权限，不自动修复超权组。

真实执行中还修正了 PowerShell5.1 的进程退出码问题：带stdout/stderr重定向的 Start-Process 在 WaitForExit 后可能返回空ExitCode，即使PG已经启动也误报失败。先打开 Process.Handle 再等待，使实际退出码保留；start/stop各一处，同样Hidden启动，没有改权限或全局执行策略。提交4e839cb固定该修订，新回归执行两脚本的真实检查块：退出0通过、退出7拒绝，均验证。

## 全新窗口与实际链路

从4e839cb跟踪文件逐一复制649个文件到写手自己的忽略目录 .local/local-knowledge-writer-route-20261011-r3，字节不改；依赖junction指向同一锁文件已有安装，未声称重新npm ci。prepare新输出 .local/local-dev，PG17.11现有bin只读复用，API3228/PG55493预检空闲，独立随机192bit owner/runtime密码与SCRAM认证，private ACL限制执行用户。无他人窗口、数据库或凭据复用。

实际按正式prepare/start.ps1启动：第一次10个迁移应用、4作物/102地区明确synthetic夹具；默认知识来源/正文为零。API使用 gengyun_local_runtime LOGIN，非owner。owner仅迁移及测试夹具；身份提供者stub、不调用正式微信或供应商。

执行顺序：prepare → start → smoke → local-knowledge-smoke → stop → start → smoke → local-knowledge-smoke → stop。初次与重启HTTP均通过，重启10个迁移unchanged、目录原样保留。以下都是实际Fastify→原生PG连接，wx模块适配仍为Node模拟，不记为微信WXML或Android真机。

| 检查 | 结果 |
| --- | --- |
| 原本地smoke | 登录/会话、四参考页面、档案/目录GET、ETag保存/重放/冲突、客户端owner拒绝、hash会话、SQL越权拒绝、退出后旧token/重放拒绝 |
| 默认知识 | 游客401；登录后空列表，未自动提升种子或添加核准资料 |
| 专门知识helper | 独立合成资料同源列表/详情、null条件/DoseCard0、来源撤回404与空列表、退出后401 |
| 夹具清理 | helper删除本次随机ID资料/审核人，恢复原dataset模式配置；最终sources=0、knowledge_versions=0 |
| 重启与停机 | 第二轮上述两smoke成功；首次stop和最终stop后3228/55493均无监听，自己的数据保留 |

夹具的verified_seed/verified及dataset real状态仅用于本座空库覆盖合格投影前置，标题/发布方/URL标明synthetic/example.invalid。不是正式来源核准、导入或种子提升，API仍stub，不生成用量卡。

[原生审计](assets/local-knowledge-native-20261011/runtime-audit.json)确认current_user=session_user=runtime、五个高权标志false、SCRAM且两密码不同。准确成员五组：auth_privacy、consent_granter、knowledge_runtime、preview_reader、profile_runtime；不含owner。另核知识正文原表、来源URL原表、媒体对象、DDL、TEMP、SET ROLE owner六次拒绝均42501。审计只输出布尔/角色/SQL错误码，不保存凭据。

## 可复现命令与运行证据

在自己全新源码窗口执行，禁止旧业务库；prepare拒绝已存在输出。PG使用自己的现有bin路径、空闲端口：

~~~powershell
node tools/local-dev/prepare.mjs --pg-bin "<PG17.11/bin>" --api-port 3228 --pg-port 55493
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File .local/local-dev/start.ps1
node .local/local-dev/smoke.mjs
node tests/integration/local-knowledge-smoke.mjs .local/local-dev
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File .local/local-dev/stop.ps1
# 再执行start、两个smoke、stop，保留首次库以验幂等/重启
~~~

RemoteSigned只用于该powershell进程，不改全局策略。不要将start输出管到本轮旧Tee采集器：PG派生后台进程曾使采集管道等待；服务本身已健康。首次[采集日志](assets/local-knowledge-native-20261011/first-cycle.log)记录到重启READY，随后只停止经命令行验证的本人采集器；重启smoke另行独立执行并保存[真实输出](assets/local-knowledge-native-20261011/restart-smoke.log)，再正常stop成功。未将等待中的采集脚本宣称整体退出0，也未因日志问题修改业务或PG安全行为。[PG启动/关闭行](assets/local-knowledge-native-20261011/postgres-lifecycle.txt)保留实际PID与监听记录。

历史r1因Windows tar中文路径失败仅prepare、未初始化；r2实际PG成功启动但旧ExitCode读取误报，按精确本人datadir正常停止。只有修正后的完整r3作为上述通过证据。子写手Granular沙盒的旧失败保留在[原交接](local-knowledge-wiring-20261011.md)，不冒用其窗口或将失败计为通过。

## 受影响检查与剩余

Node24.16.0、Windows PowerShell5.1：local-profile-bootstrap、local-dev-package、profile-api、knowledge-api和全部contract测试共31项，30通过、0失败、1原生专项单测跳过，见[日志](assets/local-knowledge-native-20261011/affected-tests.log)。该跳过不计通过；本页原生HTTP/LOGIN证据单列。API/admin typecheck、卫生扫描、文档链接/映射、专门helper语法、diff通过。

[manifest](assets/local-knowledge-native-20261011/manifest.json)绑定来源、修改文件LF哈希及资产原字节哈希。本次发布独立工具/专门测试/证据PR，不揉入私有媒体组件。未操作桌面、部署或新增费用。正式微信身份→档案→知识链、Android实际操作/字号、真实资料/HTTPS、herbicides仍待后续验收；父issue保持开放。
