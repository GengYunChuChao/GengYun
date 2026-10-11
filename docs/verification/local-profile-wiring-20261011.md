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

## 实测和限制

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

## 待执行的原生闭环

新增smoke代码覆盖真实受限LOGIN的GET档案／目录、以当前ETag和真实body保存、同键重放、异键旧版本409、额外owner400、退出后旧profile及PUT重放401。
原哈希会话检查改用受限LOGIN，附加DDL／建角色／删除作物与档案／修改账号state／读取media对象引用及export内容的7个42501负例；不再用owner读取会话作成功证据。
这些新增smoke步骤尚未在本轮原生PG执行，不能记成通过。

未定位原生PG17 bin；已向指挥请求可执行目录，只要bin，不要任何旧凭据／数据库目录。
拿到后在自己的忽略输出中使用新端口、随机凭据和独立initdb：运行现有prepare→start→smoke→再次start/database→再次smoke→stop。
不要连接其他写手的既有库或读取其配置；无需部署或调用付费供应商。
完整操作仍参照 [本地登录交接](local-login-dev-20261010.md)，本次helper由prepare一起复制，API保持stub／微信身份合成。

作者只提交Fork请求监工固定HEAD复审；未自行批准／合并／部署或关闭 #5。
