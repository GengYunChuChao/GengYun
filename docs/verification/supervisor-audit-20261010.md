# 监工独立核查：本机基线与开放 PR

日期：2026-10-10，Asia/Shanghai。核查基线 main `c0069bbdba4bbed2970750bf46c772d6e24cddc0`。
本报告仅补充本机复验、当前平台事实和未完成项，不实现业务、不派发任务、不关闭 issue。
遵循[审查规范](../pr-review-policy.md)，原需求与[视频增补](../features/pesticide-demo-video.md)各自验收。

## 1 平台与范围

- API 独立确认正式仓库为 `GengYunChuChao/GengYun`、默认 main；27 项初版 issue 全部 OPEN，整项完成数仍 0/27。
- 当前操作账户 `cxhhandsome` 的主仓库权限为 READ；其个人 Fork 为 ADMIN。可以读取源码和审查资料，不能推送或合并主库。
- `branches/main` API 返回 `protected=false`。这只报告查询时的分支保护状态，不把 CODEOWNERS 当作强制保护，也不修改平台设置。
- 原工作目录仍在 `fix-screenshot-text`，7 张未跟踪图片保持原样；复验使用监工创建的隔离 clone/worktree，未切换原工作区或协作者分支。
- 文档中已有新开发指南和 VID-DEMO 增补；本次只核对文档与当前代码状态，不据文档转述执行收费、部署、重派或自动巡检迁移。
- 本机没有执行原生 PG17、微信工具或双平台真机验证；未调用真实 AI，未恢复旧机器测试窗口或私密配置。

## 2 主线独立验证

环境：Windows、Node 24.19.0、npm 11.17.0、Python 3.13.9。
本机版本符合 package.json 范围；不将其写成原候选 Node 24.16.0/PG17.11 的精确冻结证据。

| 检查 | 本轮实际结果 | 能证明的范围 |
| --- | --- | --- |
| 锁文件安装 | PASS，103 包；npm ci 使用系统既有代理及 ignore-scripts | 当前锁定依赖可安装；未运行依赖安装脚本 |
| test:docs | PASS：27 任务、无环依赖、F/AC/Q 与 Markdown 检查 | 文档一致性 |
| validate_contracts.py | PASS：112 操作、29 样例、30 媒体轨迹、8 资料往返 | 设计契约一致性 |
| test_contracts.py | 8 项 PASS | 检查器与负例 |
| lint | PASS：API/admin 类型检查及卫生扫描 | 静态检查 |
| test:unit | 511/511 PASS，0 跳过 | 单元、隐私、媒体、参考组件 |
| test:contract | 6/6 PASS | 运行代码与冻结契约 |
| test:evaluation | 73/73 PASS | 合成夹具上的评估程序，不是真实模型指标 |
| test:mini | 4/4 PASS | Node 静态与本地诊断；非微信编译/真机 |
| build | PASS：API TypeScript 与 admin Vite | 两端构建 |
| 小程序资料生成 --check | FAIL：10 个文件报漂移 | 见下节，换行符比较缺陷尚未修订 |

上述四组应用/程序回归合计 594 项，不包含设计检查器或真实服务验收。
安装、调试回环连接与 Vite realpath 曾受沙箱阻止；获准在隔离副本复跑后通过。
原失败日志与成功结果分别保留，未将权限失败直接归因为业务代码故障。

### Windows 资料生成检查误报

位置：[build_miniprogram_data.mjs](../../tools/knowledge/build_miniprogram_data.mjs)。
当前 `--check` 把工作树 UTF-8 字符串与生成的 LF 字符串直接比较。
Git 检查显示 10 件数据文件均为 `i/lf w/crlf`；Windows checkout 因换行符转换全部报 drift。
只读诊断按同一映射、JSON 序列化及地区投影构造期望值，归一化 CRLF 后 **10/10 字节内容相等**。

这是检查器的跨平台误报，不是已证实的数据内容不一致；原命令仍为 FAIL，不能写成已修复。
后续修订需要区分换行符与实际资料变更，保持真实漂移检测；不据此阻塞无关组件或降低来源要求。

## 3 全部开放 PR 快照

本轮分页读取全部开放 PR，覆盖所有作者与草稿，共 9 个。下表 SHA 为本轮绑定提交的前 12 位。
全部已有检查在采集时为 SUCCESS；检查数不同，不推定所有 PR 具有同一验收范围。
表中冲突为 GitHub API 的 mergeable 结果，可能随 main 变化，合并前必须重查。

| PR | 已核 HEAD | 状态与核查结论 |
| --- | --- | --- |
| [#69](https://github.com/GengYunChuChao/GengYun/pull/69) | f761a38d0878 | Draft、CONFLICTING；14 检查成功，UI 部分证据通过，仍待相应渲染和合并结果复验 |
| [#68](https://github.com/GengYunChuChao/GengYun/pull/68) | 552981676a9d | 14 检查成功，但独立复现 3 个既有功能/打包阻断，需修改 |
| [#67](https://github.com/GengYunChuChao/GengYun/pull/67) | c50bb7d869cf | 13 检查成功；现有要求修改结论有效，证据不能排除业务网络问题 |
| [#65](https://github.com/GengYunChuChao/GengYun/pull/65) | f6b8da4b3d8e | CONFLICTING；14 检查成功；本账号为作者，只作自查，不批准自身 PR |
| [#57](https://github.com/GengYunChuChao/GengYun/pull/57) | 36af4ae6cb8a | CONFLICTING；10 检查成功；组织名称/迁移现状仍与最新平台事实不一致 |
| [#50](https://github.com/GengYunChuChao/GengYun/pull/50) | e13fbb9b1eb6 | 11 检查成功；既有完整响应/否定对象判定反例未收到新 HEAD，保留原批复 |
| [#49](https://github.com/GengYunChuChao/GengYun/pull/49) | 3f2699690209 | CONFLICTING；11 检查成功；后续已合组件与原 PR 分开，未关闭或代改作者状态 |
| [#41](https://github.com/GengYunChuChao/GengYun/pull/41) | be406fe40869 | CONFLICTING；1 检查成功；历史治理记录仍需按当前事实收窄 |
| [#39](https://github.com/GengYunChuChao/GengYun/pull/39) | 512df2b6a2d0 | CONFLICTING；13 检查成功；原界面 PR 保留，本账号为作者，不自批准 |

本次读取全部旧批复，只有下列优先范围另做代码/证据复验；未将全部旧 PR 写成本轮重新执行完整测试。
没有重复发布同一缺陷，没有关闭旧 PR、修改领取或将新 PR 成果自动归给旧 HEAD。

## 4 PR #68：独立复现既有阻断

HEAD `552981676a9d406ee0edc423c3058b102ed33677`，本轮最终复查未变。
现有[固定 SHA 审查](https://github.com/GengYunChuChao/GengYun/pull/68#pullrequestreview-5479004719)不能由 CI 成功解除。
本机使用实际 auth、navigation 和页面源码，合成 wx 响应与缓存；没有真实微信/服务端请求。

| 场景 | 独立结果 | 影响 |
| --- | --- | --- |
| 已有形状有效缓存的冷启动，referencedetail onLoad→onShow，两种返回顺序 | 两种均 loggedIn=true、gatePassed=false、load=0 | 会话验证成功后详情仍不加载 |
| 同上，referenceseeddetail | 两种均相同结果 | 种子详情同样停在关闭状态 |
| login→onHide→onShow→旧登录结果→再次 login | busy=true，wx.login 仍仅 1 次 | 取消后未恢复按钮与重试状态 |
| tools/prepare-wechat.mjs 标准 local 包 | 生成成功；加载产物 auth 报 MODULE_NOT_FOUND ./navigation | 标准产物缺必需依赖 |
| 同一标准 release 包 | 同样缺 navigation | 不是仅本地调试模式的问题 |

四个详情顺序、一个 busy 场景、两种真实生成产物共 7 次复现，均确认原问题仍存在。
源码定位：auth.js 的导航 epoch/requireLogin；login.js 的 onHide/onShow；标准 prepare-wechat 文件白名单。
本轮不实现修复、不代指挥派发；新 HEAD 或合并结果需要覆盖实际生命周期和标准产物。

## 5 PR #69：可复用证据与剩余范围

HEAD `f761a38d087815834df7ad3a4de8dae931ecafe2`。
实际 UI 与会话接线 36/36 PASS，五档静态布局核算通过。
初次因浅克隆无 merge base 导致一个测试前置失败；补全隔离历史后原命令完整通过，未改测试断言。

- sources.json 所列 30 件文件的 LF 归一化 SHA256 与当前 HEAD 全部匹配；19 件原始 PNG 在 Git 文件树中。
- 本轮实际查看“我的”和“识别”两张末屏图，文本、状态与按钮未被 TabBar 遮挡；其余截图未在本轮逐件重新视觉验收。
- capture 与说明一致：390px 微信模拟器、注入 fontScale=1.3、隔离游客门禁替身；不证明真实微信字体设置响应、正常登录导航或真机。
- 320px 当前渲染、真实字体字段到页面效果、相应 Android/iOS 证据仍缺；Draft 与冲突未解除。
- #68 兼容补丁是待合方案，不把补丁文件当作已修复 #68 当前 HEAD。实际合并后仍须复验上述 7 个反例。

## 6 PR #67：证据表述需修改

HEAD `c50bb7d869cfe7bf7f0cea33bf7e652233e95c5a`。
本轮读完整索引、代码和现有行内意见，确认两个原问题仍在：

1. J1-h 仍把调试“已连接”和 disabled 客户端拒绝登录写成排除网络故障的证明。该分支未发业务请求，无法检验 API DNS/TLS、合法域名或服务端；调试连接与业务网络应分列。
2. 表中 5 条已包含 1 条 ReferenceError，不能再写“5+1”；其余表项为 4 条，不是 3 条。计数校正本身不新增业务测试或真实证据。

原始用户图片本轮未取得，不将转录当独立真机实测；这些意见已在原 PR，不重复评论。

## 7 交付与限制

本报告只更新事实入口，不改变任务/验收门槛或业务实现。594 项测试与构建不代表 27 项完成。
真实核准标签、独立样本、供应商/正式微信/私有存储、完整注销恢复和部署验收仍按各任务补齐。
本机主库 READ，不能合并；个人 Fork 的文档 PR 等待维护者评审，不能伪造作者自身 APPROVED。
自动巡检与其他聊天未在本轮重建或联系，用户现有角色授权不等于这些运行连接已恢复。

## 8 用户补充：两人团队与现有设备

用户于 2026-10-10 明确：项目只有两位实际参与者，当前可用测试环境为微信开发者工具模拟器和用户的一加 ACE 3V。
后续验证按这两种环境安排，不假定另有机型、iOS 手机或专职测试人员，不重复索取这些设备。
现有任务归属与指挥/写手/监工职责保留，不因设备说明重派或扩展业务。

| 环境 | 当前验证安排 | 证据范围 |
| --- | --- | --- |
| 微信开发者工具模拟器 | 覆盖 320px 窄视口与常规视口、标准/放大字号、主要按钮和末屏布局 | 编译与受控布局；注入 fontScale 必须标明，不能作为真实微信设置响应 |
| 一加 ACE 3V | 按实际逻辑视口，走查微信标准/最大字体、登录返回原目标、详情加载、退出与切后台恢复 | 这一台 Android 设备的真实操作与微信设置响应 |
| 一加 ACE 3V，功能接入后 | 核对拍照/选图、麦克风授权、录音/播放及拒权/网络失败恢复 | 已接入能力的该设备结果；占位功能记未接入，不提前反复要求取证 |
| iOS 真机 | 当前无可用设备，记未验证 | 模拟器选择 iPhone 外观不能替代 iOS 真机 |

320px 的布局覆盖在模拟器完成；一加真机记录自身实际 windowWidth，不要求更换手机或人为凑指定宽度。
已独立确认的 #68 代码缺陷先等待修订，再用这一台手机做对应流程，避免反复收集同一已知故障。

单次调试的最小记录：提交 SHA、开发工具/基础库版本；一加的系统和微信版本、实际 windowWidth 与字号字段；复现步骤、预期和实际结果。
正常流程可合并录为一段操作视频，截图优先保留最大字号关键按钮/末屏或异常画面；记录日期并脱敏。
本轮设备说明不自动取消原需求的双平台真机门槛：实际已验 Android 范围与 iOS 未验范围分列，最终验收仍需据此说明缺项。
