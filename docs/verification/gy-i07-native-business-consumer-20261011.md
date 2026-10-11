# GY-I07 业务 HTTP＋原生 PostgreSQL＋前端模块组合联调

> 2026-10-11 后续更新：本页保留当时批次及其边界。PR79已合入main；当前main＋PR80的实际微信320px→业务Fastify→原生PG五组／11图、真实合并树622文件等价核对和新HEAD交接见[最新联调证据](gy-i07-wechat-native-main-20261011.md)。本页关于尚缺微信业务联调、保持Draft、PR79未合并的陈述仅描述旧批次，不再是当前组件状态。Android真机／正式身份／真实资料等整项缺口继续保留。

2026-10-11，香港时间。Refs #7，部分验证；不关闭整项、不证明当前 main 已装配知识服务。

## 固定运行树

开工重新读取 main 和两条 PR：main `487918856a0099d6c7ee5f083069bd415b095bee`；服务端 PR #79 `9275762f3d91bbb1673fecd449c38d8b37b5cf80`；前端 Draft PR #80 `0bd0a6dea6c471f03419ae198bbb1739aed832ef`。两条新提交尚无新批复，不能沿用旧审查作为批准。

仅在自己的独立工作树 `C:/Users/MR/Documents/Codex/2026-10-03/new-chat/i07-native-combined` 组合两条固定分支。组合提交 `ac9eeeaefaa4cc7cde8bde862b1fbbfdb561518f`，tree `8d200207f6fa692726085404ac597a2b274bcf07`，两个 parent 分别是上述 PR80／PR79 SHA；组合未推到 main，待审 PR80 应用代码未变化。依赖使用锁文件 `npm ci`，103 packages，Node24.16.0；原生程序版本 PostgreSQL17.11。

## 本轮真实链路与数据边界

实际链路：未修改的原生页面 JS／auth／page-gate／knowledge-api → 回环真实 HTTP → PR79 实际 Fastify 路由与 service → 原生 PG17 的受限 LOGIN → 当前合格知识投影视图。客户端只以 VM 模拟 wx 存储、传输、导航和 login code，Page 生命周期与模块逻辑真实执行；不是微信 WXML 渲染或 Android 真机。不是之前 knowledge-http-fixture.cjs 的合成 HTTP 服务器，也不是 PGlite SET ROLE。

微信身份提供者仍明确 executionMode=stub，不调用腾讯供应商或正式微信身份交换。owner 仅初始化、迁移和改变隔离测试夹具；buildApp 的 pool 使用独立随机密码 runtime，SQL current_user=session_user 均为该 LOGIN，绝非 owner。测试 role 仅成员 `gengyun_auth_privacy` 和 `gengyun_knowledge_runtime`，未增加 preview/profile/consent 组、全表权限或 local-dev 白名单。

夹具全部新生成：来源／审核人／正文／身份；来源标题和发布方明写“隔离合成、非真实核准资料”，URL example.invalid，正文不代表用药建议。为覆盖 current_verified_sources / current_knowledge 的既有准入条件，只在这座空测试库将 dataset real 开关和 source verified / verified_seed 字段置为满足投影的状态，完全不是对真实资料的审核、生产导入或种子提升。API meta=stub，前端模式提示保留；Conditions=null、dose_cards=[]，没有用量卡。

## 初始化与限权

复用现有 PG17 程序目录，不读取该程序旁的旧 datadir 或共享凭据。新空 datadir 是自己的 `C:/Users/MR/Documents/Codex/2026-10-03/new-chat/i07-native-runtime-20261011-r4/data`；监听回环55488，API3128；private 目录 ACL 仅当前用户，owner/runtime 为本轮独立随机密码，从不回显、上传或提交。

通过测试辅助 `knowledge-native-pg.ps1` 手动 initdb（SCRAM）、迁移 runner 全部迁移、现有两个 operator-only role SQL、独立 LOGIN 和准确两组 GRANT 初始化。该测试脚本不是 tools/local-dev 的正式接线；它拒绝已存在目录／库／非新集群和占用端口。正式 local-dev 的 knowledge 成员链接入仍需后续独立实施。

## 实际通过的七组

| 检查 | 实际结果 |
| --- | --- |
| 原生初始化与权限 | 全迁移成功；LOGIN/SCRAM成立，五个高权标志false，准确两组成员链 |
| 游客 | 页面门禁不发知识请求；直接业务 GET 返回401 SESSION_REQUIRED |
| 有效身份／无资料 | 实际 POST auth/wechat、GET auth/session＋SQL会话；空数据库前端显示空列表 |
| 列表→详情 | 真实页面生命周期与两次业务GET，SourceRef.id/version/updated_at逐项相等；null条件、0卡 |
| 没有匹配资料 | 真正 q 筛选无匹配，前端清掉旧列表；静态科普／种子不兜底 |
| 来源撤回 | 单独owner夹具连接提交withdrawn；详情新请求404清正文，返回列表重查为空 |
| 服务端会话过期 | 只将隔离session的expires_at改到合法且已过期时间；GET401，原列表与本地会话被清理，重入仍需登录 |

受限运行 SQL 读知识正文／来源原表／来源hash／媒体对象、修改账号state、删除知识、DDL、TEMP、CREATE ROLE 和 SET ROLE owner 共十项拒绝均42501。owner 与 runtime 的凭据不同；PG自身存储的runtime密码确认SCRAM。没有以PGlite代替原生 LOGIN 断言。

实际命令（参数请换成自己新空目录和现有PG程序目录，禁止生产库或他人datadir）：

```powershell
git worktree add --detach <自己的组合目录> 0bd0a6dea6c471f03419ae198bbb1739aed832ef
# 在自己的组合目录执行；merge commit时间不同可有不同SHA，但tree必须相同。
git merge --no-ff --no-edit 9275762f3d91bbb1673fecd449c38d8b37b5cf80
git rev-parse 'HEAD^{tree}'
npm ci
# 以下脚本为本次证据提交添加，从该证据提交读取；不修改组合业务源码。
& <证据目录>/tests/integration/knowledge-native-pg.ps1 -RuntimeRoot <自己的新空runtime目录> -PostgresBin <PG17/bin> -PgPort 55488 -ApiPort 3128
node <证据目录>/tests/integration/knowledge-native-consumer.mjs <组合目录> <新runtime目录> <脱敏输出目录>
& <PG17/bin>/pg_ctl.exe -D <新runtime目录>/data -m fast -w stop
```

[七组及HTTP状态观测](assets/i07-native-combined-ac9eeea/observations.json)记录实际请求路径、状态、受限标志、迁移及关键源码hash，无token/code/私密配置。实际stdout逐组PASS，退出0。[输入版本／脚本／观测hash及停止记录](assets/i07-native-combined-ac9eeea/manifest.json)绑定本次提交文本blob。

初期测试脚本的页面定义缓存、过期夹具违反 expires_at>created_at 约束，以及初始化参数传递曾中断；均修正为测试辅助逻辑，未改任何业务文件。只有新空r4集群完整七组作为通过证据，失败批次未计通过。先前自己r1/r2已停止，r3未启动；最终PG PID24284按明确datadir停止，55486/55487/55488与3126/3127/3128全部无监听，数据库夹具保留隔离。

## 和微信渲染证据分列

此前 [320px标准／受控大字及Demo对照](gy-i07-knowledge-demo-320-20261011.md)仍对应同一未改前端应用源码，实际微信模拟器渲染接的是旧合成服务3120。它证明布局与工具页面闭环，不证明本轮业务API＋PG已在微信工具中连通。本轮证明原生页面模块／真实业务HTTP／原生PG端到端，但wx是VM适配，未把两者拼成一次微信渲染联调。

## 未验证与交接

正式 local-dev knowledge 角色引导、业务API在微信工具中的实际网络页面闭环、Android真机及真实字号、正式微信身份／HTTPS网络、真实核准资料与审批／真实来源撤回、main合并后的运行树仍未验收。iOS本阶段暂缓；herbicides、完整条件、DoseCard以及整项#7仍开放。保持PR80 Draft，PR79待独立复验；请监工按明确组合SHA／tree核对本轮七组与限权证据。不自批CI、不合并，不新增供应商调用、费用或部署。
