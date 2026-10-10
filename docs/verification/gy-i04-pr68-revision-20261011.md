# GY-I04：PR #68 三项阻塞修订与本地贯通

Refs #4。承接历史 [PR #49](https://github.com/GengYunChuChao/GengYun/pull/49)，其后台竞态余项已由 [PR #59](https://github.com/GengYunChuChao/GengYun/pull/59) 合入，不重复实现、不修改或关闭旧 PR。当前修订继续使用 PR #68 的个人 Fork 原分支。

被审基线 `552981676a9d406ee0edc423c3058b102ed33677`；正常合并 main `718382b5f7dc814e2657594965748dee1713209b`。修复与回归源码提交 `c7e310292a30a6360d593768e8736c3d26c76589`；后续仅增加可选 GUI 验证脚本、截图与文档，不改变应用实现。最终 PR HEAD 以 PR 评论中的完整 SHA 为准。

## 批复对应与实际修复

| 监工意见 | 修复 | 新回归 |
| --- | --- | --- |
| [详情页重复核实丢掉加载回调](https://github.com/GengYunChuChao/GengYun/pull/68#discussion_r4237670989) | 四个资料页共用 `utils/page-gate.js`：onLoad/onShow 共享唯一在途验证及必需的加载回调；离页关闭门禁、清空数据并使页面回调失效；重返重新核实 | 实际两个详情页×两种响应顺序；正常生命周期只有一次请求，再与独立同会话请求交错；加载恰好一次；隐藏/卸载/重返、旧失败、清会话/换账号/退出/新意图、401/503/网络失败，另覆盖两个列表实际数据 |
| [登录取消后 busy 锁死](https://github.com/GengYunChuChao/GengYun/pull/68#discussion_r4237670999) | onHide 取消登录时复位 busy 与本地登录展示；保留 operation/intent 世代及成功返回的 handoff，不允许旧结果覆盖重试 | wx.login 与服务端交换两个阶段×旧结果先到/后到；再次点击确实发第二次 wx.login，新会话/返回目标不受旧结果影响 |
| [标准产物缺 navigation](https://github.com/GengYunChuChao/GengYun/pull/68#discussion_r4237671001) | 标准 `prepare-wechat.mjs` 同步 navigation 与 page-gate 依赖 | 实际生成 local/release 两类标准包，以 Node 加载包内 auth、App、全部十页；另去掉 navigation 的负控制必须报 MODULE_NOT_FOUND，未吞 require 错误 |

门禁修复发生在实际页面生命周期，未放宽 auth 的会话/意图/导航世代校验，也未把缓存当认证。page-gate 取消只使页面回调失效，保留跳登录页所需的一次性目标；返回后仍需服务端核实再加载资料。

## 验证分层

全部下列检查实际执行，退出码为 0，未跳过用例：

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| `node --test --test-concurrency=1` 单元/隐私/媒体/资料 | 554/554 | 比被审基线增加18项实际页面/登录生命周期回归 |
| 登录返回 + 资料门禁 + local-debug 专项 | 52/52 | 两种标准产物真实生成与加载包含在 local-debug 中 |
| `node tests/integration/miniprogram-login-loop.mjs` | 11组 | 实际 loopback HTTP、客户端源码、内存 store、合成微信身份；含四页冷启动与离页重返的实际资料加载 |
| `npm run test:contract` | 6/6 | 冻结契约未修改 |
| `npm run test:mini` | 配置/语法 + 4/4 | 标准原生产物依赖完整性 |
| `npm run lint` / `npm run build` / `npm run test:docs` / `git diff --check` | 通过 | TS、仓库卫生、API/admin 构建与27项文档检查 |
| 独立原生 PG 联调 | 通过 | PostgreSQL17.11、API3102/PG55438、专用库与限权API账号、合成微信身份；实际四页冷缓存/重返、哈希会话、一用返回、退出Ack/旧token401 |
| 专用 PG 停止/重启 | 通过 | 首次9迁移；重启0新增/9跳过，再跑相同客户端贯通成功；停止验证服务、保留私有数据 |
| 官方 SDK 实际模拟器 | 通过 | 用户现有本地API3100/PG55436；两条直接详情路径→登录→原ID目标→gatePassed/found→实际资料；退出Ack与旧token实际HTTP401 |

旧版本对照在忽略副本中保留 `5529816` 的实际页面/登录/打包实现，配入新测试（page-gate 仅供测试夹具导入，旧页面不调用）。筛选15项，**0通过/15失败是预期**：旧正常生命周期发两次核实、缺离页处理、busy不复位与标准包 MODULE_NOT_FOUND。随后修复版本相应用例通过，不把预期旧版失败记成当前失败。

## 模拟器绑定及边界

[观测与 LF 归一化源码哈希](assets/pr68-revision-c7e3102/observations.json)核对当前客户端与 `c7e3102`；例外仅为沿用的本地runtime/debug地址与明确合成身份的首页/登录文案。共享 urlCheck=true，沿用现有用户个人本地配置，没有新增外网域名降级或部署。API/鉴权服务代码相对用户既有 `28393fb` 快照无差异，用户库重启0新增/9跳过。实际工具基础库3.17.3，逻辑视口390px。

| 返回页 | 实际画面 |
| --- | --- |
| 科普详情（`gy-i03-hb-001`） | [已核实后资料加载](assets/pr68-revision-c7e3102/referencedetail.png) |
| 种子详情（`gy-i07-seed-hb-001`） | [已核实后资料加载，保留待核实标签](assets/pr68-revision-c7e3102/referenceseeddetail.png) |

可选复核命令：先运行既有本地 API/PG 并开启官方工具自动化端口9420，再执行 `node tests/integration/local-dev-login-detail.cjs <官方SDK目录> [API端口]`。端口默认3100、仅发送到loopback；不打印 code、令牌或身份。第一次 SDK 瞬时导航断言失败，实际页面随后进入登录页；改为等待最终路由并验证返回原ID与资料后通过。该过程保留失败记录，不把导航调用返回当页面验收。

本组是实际微信工具渲染/客户端 wx.login 与真实本机 HTTP/PG；服务端身份交换是 synthetic，没有调用真实 jscode2session，不能称正式微信身份或 Android/iOS 真机验收。资料来自已有本地契约，未联网查询权威供应商，不新增用药能力或保证资料完整。

## PR #69 保留及合并交接

PR #69 分支保持 `f761a38d087815834df7ad3a4de8dae931ecafe2`，未改分支或重写其历史。离线 merge-tree 当前显示9处冲突：进度文档、home/login、四个资料页、资料门禁测试与标准打包脚本；没有把未解决混合树标为已验。

后续合并须同时保留 #69 的 fontScale/guest/entries/WXML 与本轮 page-gate/生命周期、一次性导航和服务端核实。home 的 guest 必须随服务端核实结果更新；四页 onLoad/onShow 保留字体应用，再接 checkGate；标准包同时保留 navigation/page-gate、字号工具及状态组件；测试夹具加载真实 font-scale 与 page-gate，旧“首页缓存直接放行”的断言不能替代 #68 的核实/弹窗语义。进度文档保留最新 main 的分层记录。#69 的31项旧兼容证据只适用于其所列旧SHA，不复用到新混合树；解决后重跑相应检查与GUI。

## 仍未验收

#4 仍开放，历史批复保留。真实微信 code 服务端换取、Android/iOS 两端真实设备完整流程及正式合法联网环境仍未验；用户已明确先本地、不部署服务器，本轮不等待或新增部署/采购/付费调用。原HEAD的14项成功CI只属于旧提交，新HEAD需监工固定SHA独立复核及CI，不自行 approve、合并或批准 workflow。
