# GY-I07 实际微信 320px → 业务 API → 原生 PostgreSQL 联调

2026-10-11，香港时间。Refs #7；PR #80 的知识消费者组件证据，整项仍开放。

## 实际源码与合并树

运行输入是前端 PR80 `b5a64688406616dcc99963f0c21643e1699039a1` 的 archive，加当前 main `8932ba5153709ed67e2944984c3b891f38e1a951` 的 11 个文件。覆盖文件均核对 Git blob SHA1；运行时该目录没有 Git 元数据，不能称为已合并提交。

本轮通过已验证本地 bundle 将同一 main 正常合入写手分支，生成真实合并提交 `52b060d6a6ed270b59e5359306b2d13a0a9b910b`，父提交为上述前端和 main。随后逐一核对 622 个原有跟踪文件：文本 CRLF→LF、二进制原字节，全部与已执行快照一致。因此复用此次真实联调证据；没有重拍或声称本轮重跑服务。后续提交仅添加证据、更新历史交接说明。

[源码逐文件 SHA256](assets/i07-wechat-main8932ba5-pr80b5a6468/merged-source-equivalence.json)、[main 文件 blob](assets/i07-wechat-main8932ba5-pr80b5a6468/input-main-blobs.json)、[导入副本核对](assets/i07-wechat-main8932ba5-pr80b5a6468/import-equivalence.json)均保留。实际 GengYun-I07-Knowledge 导入副本中 81 个应用文件一致，另一个 runtime.js 是忽略的本地运行地址配置：测试时 127.0.0.1:3129/api/v1，结束后原字节恢复 3120。共享 runtime 仍关闭、共享域名校验仍开启；隔离副本原有 urlCheck=false 未写回共享工程。

## 实测五组与 11 张原图

官方 miniprogram-automator 0.12.1 连接微信开发者工具，实际 WXML／JS 渲染；window 320×504，platform=devtools，SDK 3.17.3。正文 18px，最小按钮实测 45.19791793823242px。未覆写字体或认证。

| 场景 | 实际结果 |
| --- | --- |
| 游客门禁→登录→列表 | 实际 wx.login，POST auth/wechat、GET auth/session，持久 SQL 会话和业务列表成功 |
| 列表→详情 | 实际导航与新 GET，SourceRef.id/version/updated_at 精确一致，conditions=null、DoseCard=0 |
| 搜索无匹配 | 实际 q 筛选返回空，清掉旧渲染列表，没有静态兜底 |
| 来源撤回 | 单独夹具 SQL 提交撤回，业务详情404清正文，重入列表为空 |
| SQL 会话过期 | expires_at 保持大于 created_at 且已过期；业务401 SESSION_EXPIRED清列表和缓存，重入显示登录门禁 |

[11 张原图索引](assets/i07-wechat-main8932ba5-pr80b5a6468/contact-sheet.png)、[页面观测](assets/i07-wechat-main8932ba5-pr80b5a6468/wechat/observations.json)、[真实业务 HTTP 观测](assets/i07-wechat-main8932ba5-pr80b5a6468/api-http.jsonl)分别保留；拼图只作索引，原图在 wechat/。原图已逐组目视核对，来源图另行检查。本轮实际连接当前 main 的 Fastify service 和原生 PG，非3120合成HTTP服务器、非VM wx、非PGlite；模拟器不是Android真机。

## 权限与合成数据边界

独立新空集群 PostgreSQL17.11，回环55489、API3129；owner/runtime分别新生成随机密码，私密目录仅执行用户可读，不提交。owner仅初始化迁移与夹具变化。API pool 使用 SCRAM 受限 LOGIN，current_user=session_user=gy_i07_runtime_wx；super/createDB/createRole/replication/bypassRLS均false，仅 auth_privacy、knowledge_runtime 两组。全部0001–0010迁移成功，读取知识正文原表／来源URL原表／媒体对象、DDL、TEMP、SET ROLE owner 六次拒绝均42501，见[原生权限观测](assets/i07-wechat-main8932ba5-pr80b5a6468/runtime.json)。未修改正式 local-dev 的角色白名单或引导。

身份提供者、资料、审核人均为新生成合成夹具，API execution_mode=stub；未调用正式微信交换、供应商或生产数据库。标题／发布方明示“隔离合成／非真实核准”，来源 example.invalid。仅为覆盖现有合格投影，在本座空测试库设置 dataset real 开关及 verified_seed/verified 状态；不代表真实资料审核、种子提升或生产导入。conditions=null、dose_cards=[]，没有用药建议或剂量卡。

## 复现及文件用途

资产中的 executed-bootstrap.cjs、executed-service.mjs、executed-ui.cjs 是实际执行文件原字节，全部语法检查通过；不是新的正式启动器。service 的相对导入要求先将它复制到上述固定合并源码的 .local/knowledge-native-wechat-service.mjs；仅在自己新空隔离集群初始化、使用两个现有角色 SQL。bootstrap 先创建仅执行用户可读的 private/，自身产生新凭据，禁止使用他人目录或已有业务库。

本机受限 Windows token 导致 pg_ctl start 报错，实际以同一官方 postgres.exe 前台启动本座 datadir，未放宽权限；服务按 executed-service 运行，UI 按 executed-ui 的参数读取自己 runtime 和 SDK。不要直接在资产目录运行 service，或把此证据当作正式 local-dev 一键启动交付。

快照安装曾 npm ci 失败，实际使用同锁文件的已有103包复制，不能宣称该快照 npm ci 成功。无 Git 元数据的快照适配检查曾有一项 Git 冻结门禁环境失败；本轮在实际合并仓库重新执行受影响检查后已消除，不删除或放宽门禁。

实际合并树测试命令：

`node --test tests/ui-adaptive.test.mjs tests/local-debug.test.mjs tests/reference/knowledge-client.test.mjs tests/reference/knowledge-layout.test.mjs tests/unit/miniprogram-login-return-to.test.mjs tests/unit/miniprogram-login-lifecycle.test.mjs tests/unit/miniprogram-profile.test.mjs tests/unit/knowledge-api.test.mjs`

133项，132通过、0失败、1跳过；跳过项是知识API单测的 native separate-connection 用例，不把它计为通过。本次微信原生连接证据和此前[七组VM＋业务HTTP＋原生PG](gy-i07-native-business-consumer-20261011.md)单独记录，不相加充当独立覆盖数。[测试日志](assets/i07-wechat-main8932ba5-pr80b5a6468/merged-tests.log)保留。原生JSON／路由／JS检查、verify-layout及三个执行辅助语法检查通过。

## 停止、组件交付及剩余项

本座 API 和 PG 已停止；55489、3129 无监听。忽略的运行配置恢复3120；用户Esc停止桌面操作后未再次编译，开发者工具内存配置需下次正常编译才刷新。本轮仅文件／命令操作，不重启服务或操作桌面。

PR79现已合入 main。独立review 5482194490对旧HEAD b5a6468确认原按钮阻塞消除、14CI成功；不能将旧批复当作本次新HEAD批准。本次组件转非草稿，请独立监工按发布后的固定HEAD复验主线合并结果、证据哈希和适用CI；作者不自批、不合并、不关闭#7。

正式 local-dev knowledge 角色接线、Android真机及实际字号、正式微信身份／HTTPS、真实核准资料审批和真实撤回、herbicides／完整条件／DoseCard仍为整项剩余验收；iOS本阶段暂缓。这些剩余项不把已有可审查消费者组件永久保持草稿。未部署、未读取生产凭据或新增费用。
