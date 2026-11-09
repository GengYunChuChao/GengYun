# GY-R92 小程序单机型排版收口（351×761）证据页

2026-11-09（UTC+8）。分叉基线 `9e36959e`（`origin/main`，PR #1162 之后的头），分支 `feat/gy-r92-miniprogram-layout`。

**范围口径（用户原话的口径，本片按它执行）**：只需要**一个机型**的排版没问题，不给所有机型做适配。目标机型 = 微信开发者工具模拟器当前默认机型（`mp.systemInfo` 实测 `model: "iPhone 12/13 (Pro)"`、`windowWidth: 390`、`windowHeight: 753`、`pixelRatio: 3`）；`mp.screenshot` 落盘 PNG 实测 **351×761**（模拟器把 390×844 画布按 0.9 缩放，与用户给的证据图同尺寸，可直接逐像素对照）。所以本片的排版基准是 **390 CSS 宽视口**，验收基准是 **351×761 截图**；其它宽度只保证不崩，不做专门取舍。

方法：`miniprogram-automator` 连 `ws://127.0.0.1:9426`（`cli.bat auto --project … --auto-port 9426`）逐页 `reLaunch` + `mp.screenshot({path})`，每页再补一段滚动截图；几何用 `selectAll(选择器).boundingClientRect()` 取 `l/t/w/h/r/b`（小程序**不支持** `*` 选择器，`selectAll('*')` 恒返回 0 节点，所以只量显式选择器）。截图不进仓，留在 `E:\GengYunCommander\.pg17\demo-shots-layout\{before,after}\`。

## 一句话结论

两条用户点名的问题都**不是**「字体/断行参数没调好」：时间戳是把契约里的 ISO-8601 UTC 原样印在了界面上；看起来像乱码/竖排的那串字，是**识别入口的 16px 凸起胶囊**连着它的 4px 纸色外环，把正文行拦腰遮断后剩下的左右两截残字。真正的横向挤压则集中在一个根因：微信给 `button` 注入的基础样式带 `width: 184px`，而 `miniprogram` 的自定义按钮类没写 `width`，于是每个按钮都占死 184px，把相邻的文字列挤成竖排。

## 两条已知接缝：根因与修法

### 1. 社区卡片时间戳直接渲染 ISO

根因：展示投影层把契约字段原样透传。`miniprogram/pages/community/community.js:212` 的 `time: require('../../utils/time-format').formatRelative(post.created_at)` 之前是 `time: post.created_at`，而契约 `Post.created_at` 是 ISO-8601 UTC（`2026-11-09T09:00:35.053Z`）。同一处写法在 7 个投影响应点上都有：社区列表、社区详情（帖子 + 评论）、消息列表、收藏列表、历史列表、历史详情、知识卡片来源时间。

修法：新增 `miniprogram/utils/time-format.js`（`formatRelative` 在 `miniprogram/utils/time-format.js:62`、`formatDateTime` 在同文件 `:77`、`formatDate` 在 `:89`），口径：1 分钟内「刚刚」、1 小时内「N 分钟前」、同日「今天 HH:mm」、前一天「昨天 HH:mm」、同年「MM-DD」、跨年「YYYY-MM-DD」；解析失败**原样返回**、空值返回空串（不编造时间）。7 处投影改为调用它，页面结构与请求逻辑零改动。

不引入 WXS：全仓 `miniprogram/**` 里 0 个 `.wxs` 文件，多一套格式化实现只会让口径漂移。

### 2. 社区卡片摘要「看着像乱码／竖排」

**据实结论：既不是真乱码，也不是 `line-clamp` 折断。** 两条证据：

- `miniprogram/styles/components.wxss:1120` 的 `.post-text` 没有 `line-clamp`、没有 `max-height`、没有 `overflow: hidden`，只有 `white-space: pre-wrap` + `overflow-wrap: anywhere`；滚到卡片中段时正文完整、换行正常（`06-community-s1.png` / `06-community-s2.png` 可见）。
- 把用户证据图底部与我自己复现的首屏截图同区域放大 3 倍对照：两截残字的分界线恰好是识别胶囊的上沿弧线，胶囊左右两侧各露出一截字，胶囊上方还露出一行 —— 这是**遮挡**，不是折行。

根因：`miniprogram/custom-tab-bar/index.wxss:107` 的 `.tab--identify` 用 `margin-top: -15px` 把识别入口顶出底栏，再用 `box-shadow: 0 -3px 0 4px var(--paper)` 拉一圈纸色外环「擦掉」底栏上沿。因为正文是连续滚动的，**任意滚动位置都会有一行正文被这条 16px 高的凸起带拦腰切断**，看起来就像竖排乱码。

修法：凸起收平（`margin-top: 0px`，保留可被 `tools/verify-layout.mjs` 解析的写法）、删掉纸色外环、把选中指示条从 `top: -11px` 挪进底栏内。底栏上沿变成一条直线后，正文只被直线裁切 —— 这是正常滚动行为。代价：识别入口失去凸起造型（保留浅绿胶囊高亮作为识别标记）；`tools/verify-layout.mjs` 复算底栏标准档 78.6px、最大字号档 92.3px，均小于 `.page` 预留的 105px。

## 另一个横向挤压的总根因：微信 `button` 的 184px

微信把 `button` 的基础样式注入在**页面同源**样式表里，选择器带伪类，特异性高于单个类。实测：`.btn { width: auto }` 与 `.btn { width: 100% !important }` 都压不动它（按钮仍 184px）；换成 `button.btn { width: auto }` 立刻变成 348px（= `.page` 内宽）。这个 184px 同时制造了三处「竖排」：

- 登录页「以游客身份浏览首页」（10 字 × 18px ≈ 180px，正好在 184px 里折成两行，按钮高 72px）：`miniprogram/app.wxss:147` 的 `button.btn` 加 `width: auto; max-width: 100%`，`button.btn--block` 仍 `width: 100%`（`miniprogram/app.wxss:160`）。
- 档案页头部「我的档案」被压成一字一行：`.profile-header` 是 `flex-wrap: wrap`，`.profile-header__main` 是 `flex: 1`（基准 0），而 `.profile-actions` 的基准是 auto ⇒ 取 max-content（含「IP 属地：未接入（本版不读取 IP）」整行 ≈210px），312px 的内宽里主列只剩约 22px。修法：`miniprogram/styles/components.wxss:1356` 的 `.profile-actions` 改 `flex: 0 0 100%; margin-left: 0`（按钮落到独立一行、整行宽）。
- 收藏页每行「空心莲子草」竖排：`.info-row` 内宽 307px − 58px 图标 − 2×12px 间距 − 184px 按钮 = 41px，标题只能一字一行。修法同上的 `button.gyui-button`（`miniprogram/components/gy-ui-button/gy-ui-button.wxss:4`）；顺带把 chip 的同类隐患一并收掉（`miniprogram/components/gy-ui-chip/gy-ui-chip.wxss:4`），否则社区页两个 chip 会竖着摞、消息页 4 个 chip 折成「3+1」。

`miniprogram/styles/components.wxss:211` 的 `.row-actions__item` 是配套的第二处：原本 `flex: 1`（基准 0）+ `min-width: 140px`，换行判断因此失效，两个按钮硬挤一行、文字再折两行（按钮高 72px）；改成 `flex: 1 1 auto; min-width: max-content` 后，`重新读取档案` 与 `手选作物与市县` 各占整行 307×47，`按当前档案查科普资料`（224×47）与 `退出登录`（116×47）同行。

## 逐页 before / after

| 页 | before 现象 | 根因 | after |
| --- | --- | --- | --- |
| 登录 | `.title` 未定义 ⇒「登录耕云」只有 18px；游客按钮折两行（72 高）；两按钮都不是整宽且宽度不齐 | `.title` 全仓无定义；`button` 184px | 标题 24px、两按钮 348×47 单行；新增 `miniprogram/pages/login/login.wxss:3` 补两按钮间距 |
| 首页 | 首屏正常，卡片正文 3 行；折线处正文压在底栏下 | 凸起胶囊 | 胶囊不再压字；底栏上沿平直 |
| 识草查药 | 页面标题比其它页小一档 | `.title` 未定义 | 与其它页同级 24px；查询/重置并排单行 47 高 |
| 知识 | 搜索框/chips/提示块正常；最后一块提示被底栏遮 | 凸起胶囊 | 正常；三个 chip 差 6px 放不下，「地区：浙江省」单独折行（接受） |
| 识别 | 三张能力卡的「拍照识别／去提问」胶囊压住正文末行 | `.feature-card__action` 绝对定位、正文没有底部留白 | `miniprogram/styles/components.wxss:490` 的 `.feature-card` padding 改 `18px 18px 44px` |
| 社区 | ISO 时间戳；正文被凸起胶囊拦腰切断 | 见上两条 | 「今天 17:00」；正文只被直线裁切 |
| 消息 | ISO 时间戳；4 个筛选 chip 折成 3+1 | `created_at` 透传；chip 184px | 「今天 19:00 · 未读」；4 chip 一行 |
| 问答 | 说明段被凸起胶囊切断；提交按钮 44 高（下限） | 凸起胶囊 | 底栏平直；`.qa-submit` 保持 44px（已达触控下限） |
| 档案 | 「我的档案」一字一行；`已加载 0 条` 折两行；4 个按钮全部 72 高 | profile-actions 基准 + 184px + `.stat` 太窄 | 标题横排；`已加载 N 条` 单行（`miniprogram/styles/components.wxss:1057` 的 `.stat__value` 20px→15px + 不换行）；按钮全部 47 高单行 |
| 我的收藏 | 标题/副标题竖排；「可收藏的资料」被右侧 meta 挤两行；行内按钮 184px | 184px + `.section-head` 不换行 | 标题横排、按钮收成内容宽；`miniprogram/styles/components.wxss:99` 的 `.section-head__title` 加 `flex-shrink: 0`、`.section-head` 允许换行；另有真缺陷：`资料可收藏**不等于**它…` 把 Markdown 星号原样渲染，改为 `miniprogram/pages/favorites/favorites.wxml:67` 的 `<text class="strong">不等于</text>` |
| 历史 | 时间带 ` UTC` 尾巴；「记录版本 1」的 `1` 被甩到下一行 | 自己拼的时间串；三段文案整体折行 | 「识草 · 今天 19:08」；`miniprogram/pages/history/history.wxml:61` 三段各自 `nowrap`，只允许在 `·` 处折行 |

## 闸门读数

- `node tools/verify-layout.mjs` → `PASS: 五档视口下触控区、正文与末屏预留（含最大字号档）均满足门槛。`
- `node tools/verify-doc-anchors.mjs --strict --symbol=strict --symbol-coverage=strict --symbol-coverage-verification=strict --scan docs` → `PASS: --strict 下没有基线之外的新增`
- `node --test tests/unit/miniprogram-time-format.test.mjs` 等页面测试 → 59 pass。

**为不动证据页锚点，展示层 js 的改动刻意做成行号中性**：7 个 `.js` 的 `git diff --numstat` 全是 `N N`（add == del）。做法是把格式化调用写成行内 `require`，而不是在文件头新增一行 `const timeFormat = require(...)` —— 新增行会把 464 份证据页里指向这些文件的行号锚点整体推下移，把「实质行」推成空行/右括号而判 SUSPECT。行内 `require` 在本仓已有先例（`miniprogram/pages/historydetail/historydetail.js:133` 就在 `map` 里 `require('../../data/species')`）。这是为「改动小而可回滚」付的样式代价，代码语义与模块级引入等价。

## 不声称项

- **未做多机型适配**：只有默认机型在 390 CSS 宽下的排版经过逐页目视与几何复核；`@media` 一处没加，其它宽度只保证不崩。
- **未做真机验证**：只跑微信开发者工具模拟器；`urlCheck` 相关配置与仓库根 `project.config.json` 零改动（模拟器副本用独立 `project.config.json`，不进仓）。
- 未改 `app.json` 路由、未改任何请求逻辑、未改服务端。
- 仍按原样保留的原始 ISO 渲染点（本轮未处理，另单跟进）：`miniprogram/pages/qa/qa.wxml:147`、`miniprogram/pages/knowledgedetail/knowledgedetail.wxml:37`、`miniprogram/pages/referencedetail/referencedetail.wxml:130`。
- 收藏卡片标题「杂草 · d0000000」是 `titleFor()` 在目标不在已加载 targets 里时的兜底显示，属数据面表现，不是排版缺陷。
- 问答页「回答为空」（`stage=settled`、正文长度 0）属演示/服务端态，不是排版问题。
