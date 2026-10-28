# GY-I26 界面路由与状态清单

Refs #28。基线 main `910aec3`，工作分支 `feature/gui-adaptive-pages`。

本清单是任务书 evidence 第一项「五 Tab 路由和状态清单」的交付物，同时记录视觉指标与替身边界。**页面中的识别、语音、社区能力均未接入真实服务**，可点击的界面不代表功能完成。

> 本文档与 `miniprogram/` 代码逐项对应。审查时若两者不一致，以代码为准并同步修订本文档；2026-10-04 审查曾发现本文档停留在首轮改动前，现已全面对齐。

---

## 1 五 Tab 路由

| 序号 | 名称 | 路径 | 页面文件 | 游客可见 | 主要内容 |
| --- | --- | --- | --- | --- | --- |
| 1 | 首页 | `pages/home/home` | home.js/json/wxml/wxss | 是 | 三个识别入口、未接入标注、本地诊断入口 |
| 2 | 识别 | `pages/identify/identify` | identify.js/json/wxml/wxss | 可浏览，操作禁用 | 拍草／标签／文字三入口，录音与播放分离 |
| 3 | 社区 | `pages/community/community` | community.js/json/wxml/wxss | 否 | 空态、人工审核空入口、内容安全说明 |
| 4 | 消息 | `pages/messages/messages` | messages.js/json/wxml/wxss | 否 | 空态、**首版**消息类型（评论与点赞／内容审核结果／系统通知） |
| 5 | 我的 | `pages/profile/profile` | profile.js/json/wxml/wxss | 否——**2026-10-28 更正**（原写「仅浏览」是过期口径）：游客进页即被门禁送登录页（`pageGate.start` → `auth.requireLogin` → `reLaunch` 登录页），不是可浏览页（证据 `miniprogram/pages/profile/profile.js:56-60`、`miniprogram/utils/page-gate.js:11`、`miniprogram/utils/auth.js:546-570`） | 档案、隐私说明、状态提示（登录后才渲染） |

tabBar 在 `app.json` 注册，selectedColor 与主题绿一致；首页为唯一对游客完全开放的功能页。

消息页仅列**首版即需**的三类消息。使用计划、7／14 天用药提醒与使用反馈填写属 2027-02 之后的阶段（B01／B05／B12），**不在本版界面中作为能力出现**，也不列入「将支持」。

---

## 2 状态清单

九种状态统一由 `components/state-view` 呈现。每种状态都带**图标、标题与说明文字**，颜色仅作辅助，不单独承担信息传达。

| 状态 | key | 触发条件 | 图标 | 主色 | 默认操作 | 当前页面使用 |
| --- | --- | --- | --- | --- | --- | --- |
| 未登录 | `guest` | 未接入真实会话 | 锁 | 主题绿 | 去登录 | 社区、消息、我的、收藏、历史、知识、识别、specimen、科普资料查询（`reference`，会话失效时）、授权清单（`pages/consent`） |
| 空结果 | `empty` | 查询无数据 | 空箱 | 中性 | 可由页面指定 | 社区、消息（列表空／筛选空）、知识、收藏、历史、社区详情、历史详情、specimen、科普资料浏览（`referenceseed`）、授权清单（服务端确实 0 条授权时） |
| 处理中 | `loading` | 请求进行中 | 沙漏 | 蓝 | 无 | 五 Tab（社区/识别/消息/我的/首页诊断）与知识、收藏、历史、详情页、科普资料查询与详情（`reference`／`referencedetail`） |
| 失败 | `error` | 网络或服务失败 | 警告 | 红 | 可由页面指定 | 五 Tab 与知识、收藏、历史、详情页、科普资料查询与详情（`reference`「重试查询」／`referencedetail`「重试读取」）、授权清单（失败不折叠成空列表）；**2026-10-21 起可传 `error-code` 补分类标签与可重试性** |
| 已取消 | `cancelled` | 用户主动取消 | 禁止 | 中性 | 无 | 识别（`JobState=cancelled`）、specimen |
| 已删除／失效 | `invalid` | 来源下架或过期 | 禁止 | 暗黄 | 无 | 社区详情、历史详情、specimen |
| 替身数据 | `stub` | 开发模式下的示例数据（另接受别名 `mock`） | 试管 | 紫 | 无，固定标注 | 首页、识别、我的、specimen；社区与消息用置顶 `notice--stub` 标注 |
| 无权限 | `denied` | 已登录但无权限（403 `SCOPE_DENIED`／`CONSENT_REQUIRED`／`ACCOUNT_INACTIVE`） | 锁＋章 | 石板蓝灰 | 默认不给重试；`allow-denied-action` 可保留「去授权」 | 社区、消息、我的、识别（`permission_denied` 分支）、specimen |
| 正常 | `ready` | 有可展示数据 | — | — | 不渲染状态视图 | 识别成功态等 |

**当前实际使用九种**（`guest`／`empty`／`loading`／`error`／`cancelled`／`invalid`／`stub`／`denied`／`ready`）——
2026-10-21 B7 收尾时重新核对：早期「实际使用四种」的说法已落后于页面实现，此处更正。

**2026-10-24 增补（#29 P1 只读授权清单）**：`pages/consent` 读契约 `GET /me/consents`，只用 `guest`（登录门禁）／`loading`／`error`（含 `error-code` 透传）／`empty` 四态；**读取失败一律落 `error`，不得折叠成 `empty`**——「没读到」与「没授权」必须是两件可区分的事。该页本片只读，不提供 `denied` 的「去授权」动作，也不放授予／撤回开关（P2）。

**B7 增补（2026-10-21，Refs #28）**：

- `denied` 与 `guest` 分开：`guest` 是「还没登录」（401），`denied` 是「登录了但这件东西不给你」（403）。
  把 403 折叠成「请先登录」会让用户反复登录仍不明白原因。
- `error` 可传 `error-code`：组件按 `miniprogram/utils/states.js` 的分类补一行标签（如「服务暂时不可用 · 可以重试」／
  「没有权限 · 重试无效」）。**页面自己的领域文案仍然优先**，统一层只补分类与可重试性，不改写业务措辞。
- `mock` 是既有 `stub` 的**别名**：同一形态、同一文案、同一标签，不新造第二套。
- 错误码 → 分类 → 状态 → 可否重试的全表，以及逐页面接入前后对照，见
  [B7 统一状态验证](verification/gy-i28-unified-states-20261021.md)。

**2026-10-22 增补（#28 前端一片）**：`reference`／`referencedetail`／`referenceseed` 三页补齐状态层。缺口性质是**两件相反结论被渲染成同一句话**：

- `pages/reference`：请求在途（`busy && !items.length`）走 `loading`；失败走 `error` 并透传 `error-code`（会话失效 `SESSION_REQUIRED`／`SESSION_CHANGED` 走 `guest` 语气「核实登录后重试」，其余「重试查询」）。空态加 `!busy && !queryError` 守卫，不再把「查询中／没查成」写成「没有可展示的资料」。
- `pages/referencedetail`：`busy` 走 `loading`；只有 `NOT_FOUND`／`OBJECT_UNAVAILABLE` 才落「未找到该记录」（合法结论，按钮仍是「返回继续查询」），其余错误落 `error` 并「重试读取」；重读只走服务端路径，**不落回**随包副本。
- `pages/referenceseed`：检索 0 命中或该栏无条目时走 `empty`，文案说明「只在除草剂名录里按药名／别称匹配、不合并不同记录」并给「清空检索词看全部／回除草剂名录」。该页是纯本地同步数据，没有请求态，因此不接 `loading`／`error`。

替身数据额外显示「替身数据 · 仅开发模式可见」文字标签，避免与真实数据混淆。

**识别页标签校正的状态（2026-10-17，Refs #10）**：校正入口只在已加载记录 `canCorrect` 为 `true` 时出现；raw（机器原始读数）与 corrected（拟提交更正）**同时呈现**并逐项标出差异，固定标注「机器读数 · 非权威判读 · 不提供用量」。三种失败态是页面内联文案（`.corr__error`／`.corr__conflict`／`.corr__blocked`），不占用上面九种 `state-view` 状态：

- **本地拒绝**：字段超 80 字、成分空行或超 20 条时只显示原因并**不发出任何 PATCH**，也不替用户裁剪（提示「本页不会替你截断后提交」）。
- **版本冲突**：服务端 `REVISION_CONFLICT`／`REVISION_REQUIRED` 时只**重读一次**记录、`confirmed` 归零、提示重新逐项核对，绝不静默重发更正。
- **用量阻断**：同名不同制剂、`ambiguous`、`conflict` 时 `doseBlocked` 为真，用量一律不展示，须显式勾选「我已对照包装核对」后才允许提交。

---

## 3 视觉与可访问性指标

| 指标 | 任务书要求 | 实现位置 | 换算说明 |
| --- | --- | --- | --- |
| 主题绿 | demo `--green` = `#176b50` | `miniprogram/styles/tokens.wxss` 的 `--green`／`--color-primary`；`app.json` 导航与 tabBar | **2026-10-14 起改用 docs/ui-demo 的值**（见下方「Demo 样式对齐」） |
| 正文字号 | 优先 18px | `app.wxss` 的 `font-size: 18px` | **绝对 px，不随屏宽缩放** |
| 触控区 | ≥44px 等效 | `app.wxss` 的 `--tap-min: 44px`，由 `.btn`、`.entry` 的 `min-height` 引用 | **绝对 px** |
| 末屏预留 | 不被 tabBar 遮挡 | `.page` 的 `padding-bottom: calc(105px + env(safe-area-inset-bottom))` | Tab 高度按 `custom-tab-bar/index.wxss` 实际声明复算：标准档 73.6px、微信最大字号档 87.3px，预留 105px 覆盖两者 |
| 状态表达 | 颜色加文字 | `state-view` 每态含图标＋标题＋说明 | — |
| 录音与播放 | 按钮分离 | 识别页两个独立按钮，播放需先有录音 | — |
| 风险提示 | 不得写绝对安全 | 文案使用「未接入」「不能作为用药依据」 | — |

**为什么字号与触控区用 px 而非 rpx**：rpx 为屏宽 750 等分，88rpx 仅在 375px 视口等于 44px，320px 视口只有 37.55px；36rpx 正文在 320px 视口只有 15.36px，均不满足门槛。改用 px 后数值为绝对值，窄屏不再缩水。

**保留 rpx 的两处**：`.section-title::before`（8×32rpx）与 `page-heading` 装饰线为纯装饰；文字类图标已改用 `calc(Npx * var(--font-scale,1))`（如 `.state__icon` 36px、`.gy-icon` 21px）。18px 正文门槛只约束文字，图标随屏幕与字体缩放是合理行为；且 320px 视口下不会小到不可辨识。**已实测**：显示大小最大档真机`windowWidth` 为 320px（见 [gui-adaptive-evidence.md](verification/gui-adaptive-evidence.md) 7.3.2），该档位属实际覆盖而非仅静态核算。

---

## 3.1 Demo 样式对齐（2026-10-14，Refs #28）

用户 2026-10-14 指令「前端页面务必先做到 `docs/ui-demo/demo.html` 所演示的样式，优先做好；适老版后面再弄」，本任务据此把视觉准绳改为 `docs/ui-demo`（PR #132）：

| 项目 | 位置 | 机检 |
| --- | --- | --- |
| 设计令牌（demo `:root` 色板，逐值一致） | `miniprogram/styles/tokens.wxss` | `node tools/demo-align.mjs` 第 1 组；`tests/ui-adaptive.test.mjs` |
| 图标层（由 demo `app.js` 的 SVG path 生成，28 类） | `miniprogram/styles/icons.wxss` | `node tools/demo-align.mjs` 第 3 组 |
| 组件层（按钮／卡片／panel／pill／tabs／chips／底部导航／info-row／feature-card／profile-header／setting-row／article-card／post／empty 等） | `miniprogram/styles/components.wxss` | `node tools/demo-align.mjs` 第 2 组（104 条类映射） |
| 五 Tab 与 article／post 详情形态 | `pages/{home,identify,knowledge,community,messages,profile}`、走查页 `pages/specimen` | `tests/ui-demo-align.test.mjs` |
| 末屏（按实际声明复算，含最大字号档） | `.page` 底部预留 + `custom-tab-bar/index.wxss` | `node tools/verify-layout.mjs` |

**色板冲突披露（交监工裁定）**：demo `--green` 为 `#176b50`，而 `docs/implementation-requirements.md:402` 写主题绿 `#1F7A45`。按用户 2026-10-14 指令采用 demo 值；状态色（提示蓝／警告红／提醒黄／替身紫）demo 未定义，沿用任务书值。判回 `#1F7A45` 只需改 `styles/tokens.wxss` 的 `--green`/`--color-primary` 与 `app.json` 两处颜色及两条断言。

**统一状态视图**改为 demo `.empty` 形态（虚线框 + 图标 + 标题 + 说明 + 语气色），并接入资料库、资料详情与样式走查页；各页面不得再自写一行灰字当失败提示。

**适老版（最大字号／简化布局）本轮不做**，按用户指令留作后续单；本任务只保证字号随微信设置放大、且最大档静态核算下不破版。

证据页：[gy-i26-demo-align-20261014.md](verification/gy-i26-demo-align-20261014.md)。

**字号来源**：只跟随微信「设置 → 通用 → 字体大小」。真机实测该设置可读（`fontSizeSetting` 标准 16px／特大 26px），换算为系数后注入 `--font-scale`；需求未要求应用内开关，故本任务不设档位、不写本地存储（同上 7.7）。

**核算方式**：`tools/verify-layout.mjs` 对 320／360／375／414／768 五档视口做静态核算并接入 CI；`.page` 底部预留原为 `100rpx`，在 320／360px 视口仅 42.7／48px，小于 tabBar 的 50px，由该核算发现并改为 54px。

**已知副作用**：`.hero__title` 为固定 28px，320px 视口下主标题由一行变为两行。绝对字号不缩，窄容器内换行增多属预期，标题换行不构成破版。

---

## 4 替身边界

| 项目 | 当前状态 | 隔离方式 |
| --- | --- | --- |
| 登录会话 | **已接真实服务端会话**——**2026-10-28 更正**（原写「恒为游客」是 2026-10 的过期口径，与实际代码相反） | 页面一律 `require('../../utils/auth')` 走 `requireLogin` 门禁与 `Authorization: Bearer` 会话：21 个页面脚本里 20 个如此，唯一例外是不读任何业务数据的走查页 `pages/specimen`（`miniprogram/pages/knowledge/knowledge.js:2`）。`utils/session.js` 是**死代码**（`SESSION_ENABLED = false`、`isGuest()` 恒 `true`，但页面／组件层对它 `require` 零命中），**不要**按它读登录口径；登记与处置见第 7.5 节（本片不删它） |
| 拍草识别 | 未接入 | 入口仅提示，不调用相机 |
| 标签 OCR | 未接入 | 入口仅提示，不调用相机 |
| 语音转写与播放 | 录音已接真实端口；转写核对在 stub/preset_demo 接通 | 录音经 `utils/recorder-port.js`（`wx.getRecorderManager` 在原生侧的唯一出现处）真实采集，按用途 voice_question 上传（real 模式）；`utils/speech-transcript.js` 在 stub/preset_demo 下走通「受理→轮询→可编辑→用户明确确认→发送」，未经确认不外发、取消/失败/迟到回调不外发；**真实 ASR 未接线**，替身文本明确标注 |
| 文字提问 | 未接入 | 入口仅提示 |
| 社区内容 | 无数据 | 空态，不生成假帖子与假评论 |
| 消息 | 无数据 | 空态，不生成假通知 |
| 人工审核 | 空入口 | 明确写明建设中，不展示任何已审核内容 |
| 本地诊断服务 | 仅开发模式可见 | `config/runtime.js` 默认为 `mode: disabled` |

会话占位不调用任何登录或手机号授权接口，也不在本地判定权限；真实权限一律由 GY-I04 服务端负责。`tests/ui-adaptive.test.mjs` 以合成 `wx.getStorageSync` 覆盖十种缓存取值，断言关闭状态下 `isGuest()` 恒为 `true` 且不发生存储读取。

---

## 5 本任务明确不做

- 不修改 `config/runtime.js` 的 `disabled` 默认值
- 不修改 `packages/contracts/` 下任何冻结契约
- 不接入任何真实 AI、数据库或云服务
- 不申请或上报任何权限（相机、麦克风、位置均未声明）
- 不声称真机、真声音或真实识别已通过
- 不改动 `project.config.json` 的 AppID（本 PR 仅改 `libVersion`）

> **本 PR 实际未改`project.config.json`**：曾误将`libVersion` 改为本机工具显示的 3.17.3（灰度中），导致 CI 冻结断言失败，已回退至与 `origin/main` 逐字一致。冻结契约值 `3.5.5` 不存在于工具可选列表，已由监工在 PR #46 中对齐为 `3.17.3`。

---

## 6 交付物索引

| 任务书证据要求 | 交付物 |
| --- | --- |
| 五 Tab 路由和状态清单 | 本文件（第 1、2 节） |
| 视觉和字体走查 | [gui-adaptive-evidence.md](verification/gui-adaptive-evidence.md) |
| 替身开关隔离 | 本文件第 4 节 + `ui-contract-binding.md` 第 4 节 |
| **接口契约绑定记录** | **[ui-contract-binding.md](ui-contract-binding.md)**（含界面↔端点映射与 9 条 AC 归属切分） |
| 微信工具编译版本与截图 | [gui-adaptive-evidence.md](verification/gui-adaptive-evidence.md) 7.1、7.2、7.10 |

**验收标准（AC）归属**：任务书引用 AC01／06／07／08／14／15／17／18／21 共 9 条，其中 AC06 属 GY-I13、AC17 属 GY-I16、AC21 属 GY-I05，AC18 跨 GY-I13 与GY-I17。逐条切分见 [ui-contract-binding.md](ui-contract-binding.md) 第 3 节，本任务不标整项完成。
- 不接入第三方插件；`app.json` 仅新增 `lazyCodeLoading: requiredComponents` 以通过工具代码质量扫描

---

## 6 编译与走查

| 项目 | 结果 |
| --- | --- |
| 文档与任务图检查 | `python tools/validate_development_docs.py` → PASS（27 任务） |
| 契约一致性检查 | `python tools/validate_contracts.py` → PASS（112 操作） |
| 契约测试 | `python tools/test_contracts.py` → OK（8 项） |
| 微信工程结构检查 | `node tools/check-wechat-project.mjs` → PASS |
| 界面自动化 | `node --test tests/ui-adaptive.test.mjs` → 26 项 PASS（2026-10-14 起含 demo 色板断言与按钮类触控下限断言） |
| Demo 样式对齐机检 | `node tools/demo-align.mjs` → PASS（令牌逐值一致／104 条类映射／28 个图标几何一致／无裸 px 字号） |
| Demo 样式对齐回归 | `node --test tests/ui-demo-align.test.mjs` → 7 项 PASS |
| 本地诊断测试 | `node --test tests/local-debug.test.mjs` → 4 项 PASS（含打包允许清单随 app.json 的 13 页同步） |
| 布局静态核算 | `node tools/verify-layout.mjs` → 五档视口 PASS，末屏预留按实际声明在**微信最大字号档**核对（105px ≥ 87.3px） |
| 五 Tab 导航 | **真机预览逐一导航，五个页面均可打开**，截图已入库 |
| 截图 | **15 张已入库**（`assets/gui-adaptive-250c4d4/`，绑定提交 250c4d4）：五 Tab 真机、显示大小最大档五页、工具基本信息与本地设置、代码质量扫描、编译成功 |

**未完成的走查项**：

| 项目 | 原因 | 归属 |
| --- | --- | --- |
| 窄视口布局实测 | 真机（一加 Ace 3V）显示大小最大档，视口约 318dp，五页无破版 | **已实测**（见证据文档 7.3.1／7.3.2） |
| 放大字号走查 | 微信字体设置无效；**系统显示大小最大档实测整体放大且不破版** | **已实测**（见证据文档 7.3） |
| 登录态界面 | 登录能力依赖 GY-I04，尚未开始 | [GY-I04](https://github.com/GengYunChuChao/GengYun/issues/4) |
| Demo 对齐的**工具／模拟器／真机截图** | 2026-10-14 批次的写手机器未安装微信开发者工具（仅有残留 User Data），开发者工具编译、模拟器与真机渲染均未取得 | 见 [gy-i26-demo-align-20261014.md](verification/gy-i26-demo-align-20261014.md) 第 8 节（含复核命令） |
| 适老版（最大字号／简化布局） | 用户 2026-10-14 指令「适老版后面再弄」 | 后续单，本任务不做 |

数值门槛（44px 触控区、18px 正文、54px 末屏预留）已由 `verify-layout.mjs` 静态核算覆盖；仍需真机验证的是系统级字体缩放是否生效、极窄容器下的实际换行与溢出。

> 本任务不重复验收语音服务准确率，也不代替 GY-I13 的播放生命周期验证。基础库以 `project.config.json` 的 `libVersion` 为准，本轮曾将不可选的 `3.5.5` 修正为候选 `3.5.8`（未实测、未冻结，详见 `docs/verification/gui-adaptive-evidence.md`）。

---

## 7 P0 链路（第一条用户链路）

2026-10-28 增补（Refs #4 #5 #7 #16 #28）。本节把 README「推荐推进顺序」里的 P0 第一条用户链路收尾（登录 → 手选作物／地区 → 查询 → 详情 → 收藏／取消 → 退出，且「退出、**来源失效**、网络失败能清旧内容并恢复」）**钉在一条页面路径**上：查询／列表在 `miniprogram/pages/knowledge`，详情／收藏在 `miniprogram/pages/knowledgedetail`。

钉这条路径的原因是「手选条件查询」在仓里有两个实现，数据源根本不同：`pages/knowledge` 走服务端 `GET /knowledge`（真库读视图），`pages/reference` 带条件时**强制**读随包离线副本（第 7.4 节）。若不钉，同一句验收会在两个页面上各算一半，而其中一半结构上不可能通过。

真库端到端已按这条路写成 7 步：`tests/integration/user-chain-e2e.mjs`（本片加入第 7.3 节的「来源失效」往返后实测 142 条断言 / 7 步 / exit 0）。

### 7.1 查询面＝`pages/knowledge`

| 项 | 口径 | 证据（path:line） |
| --- | --- | --- |
| 用户可见入口 | 作物／杂草／地区三个 picker（`data-field` = `cropIndex`／`speciesIndex`／`regionIndex`，选项来自随包目录） | `miniprogram/pages/knowledge/knowledge.wxml:29-31` |
|  | 「查询／重试」按钮（`bindtap="search"`，`loading`／`disabled` 绑 `busy`） | `miniprogram/pages/knowledge/knowledge.wxml:42` |
|  | 每条结果一个「查看详情并核对来源」按钮（`data-id` 带资料 id） | `miniprogram/pages/knowledge/knowledge.wxml:80` |
|  | 未登录时整页只渲染 `guest` 状态视图，查询区**不出现**（不是渲染后报错） | `miniprogram/pages/knowledge/knowledge.wxml:10-18`；`miniprogram/pages/knowledge/knowledge.js:68-70` |
| 依赖 API | `GET /api/v1/knowledge`，operationId **`listKnowledge`**；查询串闭集 = `q` ＋ `crop_id`／`region_code`／`species_id`／`growth_stage`／`planting_method`／`use_scene` ＋ `cursor`／`limit` | 客户端闭集 `miniprogram/utils/knowledge-api.js:9`；请求装配 `miniprogram/utils/knowledge-api.js:95-103` |
|  | 服务端只读 `catalog_read.current_knowledge`（＝来源已核对 + `validity='valid'` + 已发布 + 最新修订的闭集），**不是**客户端筛 | `services/api/src/knowledge/service.ts:76`；视图定义 `services/api/db/migrations/0012_knowledge_created_at.sql:87-116` |
| 失败态 | `stateKind` 落 `error` + `state-view`「查询没有成功」；文案取自客户端闭集（如 `NOT_FOUND`＝「资料不存在、已失效或不符合查询条件，请返回列表重新查询。」） | `miniprogram/pages/knowledge/knowledge.wxml:67-69`；`miniprogram/utils/knowledge-api.js:221` |
|  | 空结果**分两种**：填了未采集维度（生育期／种植方式／使用场景）落 `uncollected` 并点名原因，否则才落 `empty` | `miniprogram/pages/knowledge/knowledge.wxml:61-66` |
| 清空口径 | 每次查询**先** `clear()`：清 `items`／`nextCursor`／`status`，并作废在途查询与档案预置（迟到的回包不得覆盖当前条件） | `miniprogram/pages/knowledge/knowledge.js:185-213` |
|  | 失败分支显式 `items: []`／`nextCursor: null` —— 旧结果**不留在屏幕上** | `miniprogram/pages/knowledge/knowledge.js:209-211` |

### 7.2 详情面＝`pages/knowledgedetail`

| 项 | 口径 | 证据（path:line） |
| --- | --- | --- |
| 用户可见入口 | 从列表「查看详情并核对来源」`navigateTo` 进入，只带 `id`（详情页自行重读，不复用列表对象当正文） | `miniprogram/pages/knowledge/knowledge.js:214-220` |
|  | 「收藏／取消收藏」按钮：`favSupported` 为真才渲染，`loading`／`disabled` 绑 `favBusy`，卡片固定注明「收藏只表示保存了这条资料」 | `miniprogram/pages/knowledgedetail/knowledgedetail.wxml:41-46` |
|  | 「重新核对／重试」「返回继续查询」 | `miniprogram/pages/knowledgedetail/knowledgedetail.wxml:48-49` |
| 依赖 API | `GET /api/v1/knowledge/{id}`，operationId **`getKnowledge`**（客户端会带上从列表带来的条件，用于核对「版本或来源状态是否变化」） | `miniprogram/utils/knowledge-api.js:104-111`；核对点 `miniprogram/pages/knowledgedetail/knowledgedetail.js:32-53` |
|  | `POST /api/v1/favorites`，operationId **`createFavorite`**（`Idempotency-Key` 必带；服务端按 `(user,target)` 去重，重复收藏返回同一行） | `miniprogram/utils/favorites-api.js:139-147` |
|  | `DELETE /api/v1/favorites/{id}`，operationId **`deleteFavorite`**（`If-Match: "<revision>"` + `Idempotency-Key` 必带；缺 `If-Match` 服务端回 **428 `REVISION_REQUIRED`**，不会静默成功） | `miniprogram/utils/favorites-api.js:150-158` |
|  | 收藏状态**逐次重查**（不缓存、不在本地推断）：命中同 `(type,id)` 才显示「取消收藏」，扫不到也不做本地去重决定 | `miniprogram/pages/knowledgedetail/knowledgedetail.js:76-123`；按钮行为 `miniprogram/pages/knowledgedetail/knowledgedetail.js:126-155` |
| 失败态 | `!item && stateKind === 'error'` 走 `state-view`「没有读到这份资料」＋「重新核对／重试」；成功正文整块不渲染 | `miniprogram/pages/knowledgedetail/knowledgedetail.wxml:22-30` |
|  | 收藏失败不保留乐观状态：`favState` 落 `unknown`，`favBusy` 复位，文案走既有错误映射 | `miniprogram/pages/knowledgedetail/knowledgedetail.js:147-154` |
| 清空口径 | 每次 `read()` 先 `clear()`：`item`／`labels`／`conditionsText` 全清，并复位收藏入口（`resetFavorite`） | `miniprogram/pages/knowledgedetail/knowledgedetail.js:29`；`miniprogram/pages/knowledgedetail/knowledgedetail.js:32-53` |
|  | 失败分支 `item: null`／`labels: null` —— 旧正文不留在屏幕上 | `miniprogram/pages/knowledgedetail/knowledgedetail.js:49-52` |

### 7.3 来源失效（撤下／恢复）：一条判据、三处同源

链路要求「来源失效能清旧内容并恢复」。服务端把「一条资料该不该可见」收敛成一个判定，三条读面读的是**同一个**集合，因此不可能出现「列表里没有、详情还能看」这类不一致：

1. **列表**：`catalog_read.current_knowledge` 只收「来源已核对 + `validity='valid'` + 已发布 + 最新修订」的行；来源一撤下，该行就不在集合里（`services/api/db/migrations/0012_knowledge_created_at.sql:87-116`）。
2. **详情**：读不到时抛 `NOT_FOUND`「资料不可用」，与「这个 id 根本不存在」**逐字段同形**（不泄露存在性）：`services/api/src/knowledge/service.ts:107`；详情面的公开读判定 `unavailable ⇒ 同形 404` 见 `services/api/src/routes/knowledge.ts:110-122`。
3. **收藏**：`reference_state`／`unavailable_reason` **每次读取重新派生、不入库**；不可用时理由折叠成冻结闭集里那条**对象侧统一说明**（不细分「已隐藏／不存在」）：`services/api/src/targetref/visibility.ts:34-41`。

**已进真库 e2e**：`tests/integration/user-chain-e2e.mjs` 的「4.5 来源失效」一步把这条往返跑成四组断言 —— ① 同一查询串读空；② 详情 404 `NOT_FOUND` 且与「不存在」逐字段同形；③ 既有收藏转 `unavailable` + 闭集理由（且收藏行**不被失效清掉**）；④ `validity` 改回 `valid` 后列表／详情重新可读、收藏状态回正。该步**开头**先断言「失效前确实是 `available`」，否则第 ③ 组在"一直不可用"的实现下也会绿（空转）。

### 7.4 `pages/reference` 不是本链路的查询面（只做随包名录浏览）

| 结论 | 依据 | 证据（path:line） |
| --- | --- | --- |
| 带作物／杂草／地区条件时**强制**读随包离线副本，不发请求 | 服务端 `/herbicides` 的 querystring 只接受 `q`／`registration_number`／`cursor`／`limit`，结构化条件**不可表达**；页面据此直接返回 `bundled-offline` | `miniprogram/pages/reference/reference.js:207-210`；客户端闭集 `miniprogram/utils/knowledge-api.js:122-124` |
| 剂型条件走同一分支（不静默丢弃条件） | 同上分支，`others` 为真时文案并列「作物／杂草／地区／剂型」 | `miniprogram/pages/reference/reference.js:200-206` |
| 分支落点：先判来源再决定走服务端还是随包副本 | `runQuery` 里 `decision.source === SERVER` 才走 `runServerQuery`，否则 `runBundledQuery` | `miniprogram/pages/reference/reference.js:223-225` |
| 这一路上「详情 → 收藏」**走不通** | `pages/referencedetail` 的 `.js`／`.wxml` 全文对 `收藏`／`favorite`／`fav` 零命中，没有收藏入口 | 无入口可锚（负向事实，逐字读完 368+156 行确认）；P0 链路的收藏只在 `pages/knowledgedetail`（第 7.2 节） |
| 不能用来满足「下架／失效退出有效查询」 | 随包副本恒为有效记录，没有下架概念 ⇒ 该条验收在这一路上**结构上**判不了 | 同上；对照 `services/api/db/migrations/0012_knowledge_created_at.sql:87-116`（服务端才有失效闭集） |

**结论**：`pages/reference` 保留为**随包除草剂名录浏览**（离线可用、明示数据来源），但不计入 P0 链路；P0 的查询面是 `pages/knowledge`。

### 7.5 `utils/session.js` 是死代码（如实登记，本片不删）

- `miniprogram/utils/session.js:22`：`SESSION_ENABLED = false`；`miniprogram/utils/session.js:38-41`：`isGuest()` 在该开关关闭时**无条件**返回 `true` 且不读存储。
- 页面／组件／工具层对它的 `require` **零命中**：`miniprogram/` 里 20 个页面脚本一律 `require('../../utils/auth')`（唯一例外是走查页 `pages/specimen`），没有任何页面读 `utils/session` ⇒ 这个文件今天**不参与**任何登录判定。
- 处置：**本节只登记，不删除**（本片不动 `miniprogram/**`）。唯一还依赖它的是单测 `tests/ui-adaptive.test.mjs:268-286`（按路径直接读源码并 `createRequire` 加载，断言「关闭状态下 `isGuest()` 恒为 `true`、且不发生存储读取」）——后续任一片要删它，必须同时改掉这条单测，否则那一组断言会 BROKEN 而不是「自动消失」。
- ⚠ 第 4 节末段那句「会话占位不调用任何登录或手机号授权接口……」**只描述这个死文件**，不描述页面会话；页面会话口径以第 4 节表格的「登录会话」行为准（已按第 4 节的更正改为「已接真实服务端会话」）。
