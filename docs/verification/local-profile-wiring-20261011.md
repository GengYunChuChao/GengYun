# 本地档案联调接线

Refs #5、#2；基线 main `7ac2c8facc5f876f166ba2548b6c2023c4d434a0`，复用已合 PR #74 的SQL角色和档案API，不重复修改。
仅修改 `tools/local-dev/`、局部测试及本证据；不改小程序、冻结契约、迁移或生产资料。

## 问题和结果

旧 `database.mjs` 未引导 profile_runtime；已存在的LOGIN也只保留旧组，导致新增档案路由缺权限。
现在独立本地引导安装已审 NOLOGIN profile_runtime，确认它和运行LOGIN均没有超级用户／建库／建角色／复制／绕RLS权限，再给运行LOGIN补组；每次启动均核对，包含已有LOGIN。
LOGIN不能是迁移owner成员。API连接仍为 `gengyun_local_runtime`，owner仅准备结构／角色／合成资料，不作为API运行身份。

档案目录只在明确 `gengyun_local_dev`／`gengyun_local_owner` 目标初始化，读取现有4作物／102浙江节点。
它是本地 synthetic 夹具，不能据此认证生产资料或现实行政区划最新性。
两目录表均为空才插入；完整相同夹具复用、不重复写；任意缺失或差异拒绝且保留已有数据，不修补／覆盖。
诊断状态增加 `profile_catalog: synthetic-local-fixture`，控制台标明合成来源；生产导入不使用此工具。

prepare复制新增helper；小程序仍递归复制允许扩展名，所以新增普通页面依赖无需另写文件白名单。
未改写其他写手页面、共享disabled runtime或域名检查。已有准备目录不被覆盖，旧准备副本须由操作者保留；新工具不会静默替换它。

## 初轮实测和限制（旧HEAD 0e04cd8）

| 检查 | 实际结果 |
| --- | --- |
| 本地准备／bootstrap／已审profile／契约19项 | 19／19，通过 |
| 最终owner成员关系负控制专项 | 2／2，通过 |
| lint及工具语法检查 | 通过 |
| API／后台build、docs、diff | 通过 |

bootstrap SQL使用PGlite：运行角色真实列权限、7条SQL拒绝、重启补成员关系、种入／重启不重复、已有差异保留、危险角色及owner成员关系拒绝均执行。
PGlite无法连接该命名数据库，只有 `current_database/current_user` 目标探测这一条响应使用显式夹具适配；其余角色及数据操作是真SQL。
严格目标拒绝单独测试，失败时仅一条只读探测，没有角色或目录写入。不把目标探测夹具当原生连接隔离验收。

19项中profile专项为已审实现的真实loopback HTTP＋PGlite非owner SET ROLE；不是本工具启动的原生PG17 LOGIN。
主线完整unit未机械重跑；原有登录／UI不改，适用局部回归复用同版本已审背景。

## 初轮待执行的原生闭环（已在下方修订1补证）

新增smoke代码覆盖真实受限LOGIN的GET档案／目录、以当前ETag和真实body保存、同键重放、异键旧版本409、额外owner400、退出后旧profile及PUT重放401。
原哈希会话检查改用受限LOGIN，附加DDL／建角色／删除作物与档案／修改账号state／读取media对象引用及export内容的7个42501负例；不再用owner读取会话作成功证据。
这些新增smoke步骤尚未在本轮原生PG执行，不能记成通过。

未定位原生PG17 bin；已向指挥请求可执行目录，只要bin，不要任何旧凭据／数据库目录。
拿到后在自己的忽略输出中使用新端口、随机凭据和独立initdb：运行现有prepare→start→smoke→再次start/database→再次smoke→stop。
不要连接其他写手的既有库或读取其配置；无需部署或调用付费供应商。
完整操作仍参照 [本地登录交接](local-login-dev-20261010.md)，本次helper由prepare一起复制，API保持stub／微信身份合成。

作者只提交Fork请求监工固定HEAD复审；未自行批准／合并／部署或关闭 #5。

## 修订1：成员链和本工具原生闭环

依据 [review5481515723](https://github.com/GengYunChuChao/GengYun/pull/76#pullrequestreview-5481515723) 及行内4239889401；正常同步 main `830e417dc90b5c16a5b56914e0d8a855943f85de`，保留已合 #77 前端，不另改页面。
旧保护只在GRANT前检查LOGIN。NOLOGIN组自身高权属性都false，仍可能通过成员链让LOGIN SET ROLE到迁移owner。

现在通过真实 `pg_has_role` 成员闭包，只允许明确的本地runtime／auth_privacy／preview_reader／consent_granter／profile_runtime集合，闭包内每项都核对高权属性和组NOLOGIN。
profile组、LOGIN在授予前检查，授权后和COMMIT前再次检查LOGIN。owner及非预期角色、CREATEROLE／CREATEDB／BYPASSRLS成员、pg_read_all_data均拒绝。
新组CREATE和既有已审列权限脚本去除仅独立BEGIN／COMMIT包装后纳入外层同一事务；失败回滚CREATE、成员授权和目录插入，而非留下半成功。
这是一时点引导验证，不保证运维后来改变角色；API账号不会获得管理角色能力。

### 成员链负控制

自己忽略目录加载旧 `0e04cd8` bootstrap＋新增回归：1通过／1失败，`Missing expected rejection`，绑定第一项间接owner链。
修复后的真实SQL角色测试通过：直接owner、间接owner、高权和内置广泛读角色、GRANT后注入成员关系、最后检查才失败、正常初始化及重入。
失败后runtime不残留profile／owner成员关系，已有目录不变；全新组及空目录在最后检查失败时均回滚为0。
完成管理夹具后切到真实受限SESSION AUTHORIZATION，SET ROLE postgres返回42501。PGlite当前数据库探测仍是明示夹具，角色/GRANT/闭包/回滚/SET ROLE本身是真SQL。
曾在PGlite负例中提前修改SESSION AUTHORIZATION，恢复后续管理上下文未成功，导致REVOKE权限失败；已将不可恢复的受限会话反证移到最后，最终回归通过，不把该中断计为成功。

### 本工具原生执行

只读执行经指挥确认的 PostgreSQL17.11 bin，未读取其旧data／配置／日志。
实际工具输出位于本写手clone忽略的 `.local/local-dev`；自己的datadir为 `C:/Users/MR/Documents/Codex/2026-10-11/parallel/gy-i05-api/.local/local-dev/private/pg-data`。
空闲端口API3217／PG55471，新随机本地凭据；不提交或打印值。后台沿用Hidden窗口启动；owner只迁移／引导，API和烟测数据库验证都使用真实 `gengyun_local_runtime` LOGIN。

| 步骤 | 实际结果 |
| --- | --- |
| prepare→start | 新集群，17.11；9迁移新增／0跳过；synthetic4作物／102地区初始化成功 |
| 第一次 smoke | 限权LOGIN完整profile/目录保存、重放、409、owner400、7项SQL42501、退出旧profile/PUT401均通过；四资料页冷／重返和哈希会话检查通过 |
| stop→start | 只停本轮PID；数据保留；0新增／9跳过，目录完整同夹具保留 |
| 持久化比较 | crops4／regions102／profiles1／sessions1的完整选择列SHA256重启前后相同 |
| 第二次 smoke→stop | 同一原生链路再次通过；API3217／PG55471监听关闭 |
| 独立受限LOGIN owner负例 | owner_member=false，SET ROLE gengyun_local_owner拒绝42501，current_user仍runtime，随后停止自己的实例 |

本轮PID记录：第一次API15248／PG62060，第二次API62192／PG42332，额外owner反证API38112／PG44172；只停止对应脚本确认属于本datadir／API路径的进程。未停止任何别人的服务。
持久化摘要：crops `552cd9716b126d8211474a82595aa98a4a6d2d7973edc0d91b82269ec74332f3`，regions `c55017d1ba6a5cd338698da96ede7c11bf7fff1620d7c4353285c42e58bacec2`，profile `7718cc2bc83973dba9e5d7f0f8a5589b384ce28ed4b1affd978b5902c237c0ac`，session `acfc11f84544a594a8df5862b90201d85c15bb7a095b2ee097814a03f6cd16d0`。

实测LF源码及准备副本摘要一致：profile-bootstrap `c05a19d681e97ad19f338ca4d56b8ccc629def411aad21e8a283d8ad500aa565`，smoke `8219c77fb9d9fabb3d1c5aff6733f5e2503b97f060dde44b3394cd9399a3ee94`。
重放命令是本工具prepare使用独立端口3217／55471，随后本输出start.ps1→smoke.mjs→stop.ps1→start.ps1→smoke.mjs→stop.ps1；既有输出拒绝覆盖，当前私有集群保留且已停。
这补齐本工具自己的原生LOGIN及重启证据，不挪用 #77 独立profile测试。微信身份、目录为synthetic；不证明真实微信、定位、真机或生产部署，不关闭 #5/#2。

最终当前树本地准备／成员链／profile／契约19／19通过，lint、API／后台build、docs、diff检查通过；这些结果绑定新增成员链源码，不延用旧HEAD CI。
