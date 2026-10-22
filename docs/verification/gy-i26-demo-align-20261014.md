# GY-I26 前端页面与 Demo 样式对齐（PR 证据）

Refs #28（**不关闭整项**）。分支 `feat/gy-i26-demo-align`；基线 `upstream/main` = `15c3003`（docs(demo): publish updated standalone UI demo and editable sources (#132)）；本页对应的样式与工具提交 = `6e4a84ff39232034ea89a2384c47a9c74c4fd758`。

> 用户 2026-10-14 最高优先级指令：**前端页面务必先做到 `docs/ui-demo/demo.html` 所演示的样式，优先做好；适老版后面再弄。** 本片据此把 `docs/ui-demo` 作为样式的唯一准绳，适老版（最大字号／简化布局）明确留作后续单。

## 0 结论与边界（先读）

**做了**：demo 的设计令牌与组件形态落到 WXSS 样式层；五个 Tab（首页／识别／资料库／社区／消息／我的）与 article（资料详情）／post（帖子详情）形态改用 demo 的类与层级；底部导航按 demo `.bottom-nav` 重做；统一状态视图采用 demo `.empty` 形态并接入资料库／详情；补齐监工点名的「官方字号路径／主要按钮／末屏与统一失败态」证据。

**没做**：不改任何后端、契约、数据流；不重写他人已交付页面的交互（识别页三入口、资料库查询流、登录页、后台均保持原样）；**不做**适老版；未接入任何真实服务；未发起付费调用。

**样式的可核对边界**：本片所有「一致」结论都来自**静态文本比对与声明值复算**（`tools/demo-align.mjs`、`tools/verify-layout.mjs`、`tests/ui-demo-align.test.mjs`）。**微信开发者工具编译、模拟器、Android／iOS 真机渲染与截图在本环境均未取得**（见第 7 节），因此本页不声称「页面已按 demo 渲染通过」。

### 0.1 demo 版本核对（先固定准绳，避免对着旧版对齐）

| 项目 | 值 |
| --- | --- |
| demo 单文件 | `docs/ui-demo/demo.html`，LF 归一化后 **96,762 B**，sha256 `2304720f9af64cb4d3df4c709fc666aad7c90281c6536e01c6d920519c634a18` |
| 本地副本 | `E:\GengYunCommander\.demo\demo.html`，同 96,762 B、同 sha256（逐字节一致） |
| 样式源 | `docs/ui-demo/dist/styles.css`（`:root` 令牌 + 451 条规则） |
| 逻辑／模板源 | `docs/ui-demo/dist/app.js`（`const paths` 的 SVG 图标 + 各页模板） |
| 工作树字节差异 | 本仓 `core.autocrlf=true`，demo.html 检出为 CRLF（96,905 B，含 143 个 CR）⇒ **文本内容一致，sha256 差异仅由行尾造成**；比对时按 LF 归一化 |

## 1 demo 令牌 → WXSS 变量（逐值机检）

`miniprogram/styles/tokens.wxss` 的 `page{}` 块（WXSS 无 `:root`，变量必须定义在 `page` 上才能被页面节点继承）。机检命令：`node tools/demo-align.mjs`（第 1 组输出）。

| demo `:root` 令牌 | demo 值（`docs/ui-demo/dist/styles.css:1`） | 本仓 WXSS | 结果 |
| --- | --- | --- | --- |
| `--green` | `#176b50` | `--green` | 逐值一致 |
| `--ink` | `#17352b` | `--ink` | 逐值一致 |
| `--muted` | `#7b8983` | `--muted` | 逐值一致 |
| `--paper` | `#f5f7f4` | `--paper` | 逐值一致 |
| `--line` | `#e5ebe5` | `--line` | 逐值一致 |
| `--lime` | `#c6f17b` | `--lime` | 逐值一致 |
| `--font` | `'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif` | `page{font-family:'PingFang SC','Microsoft YaHei',sans-serif}` | **取舍**：小程序取系统字体，去掉 Windows 浏览器专有的 Segoe UI，其余一致 |

除 6 个 demo 原令牌外，还把 demo 规则里反复出现的派生面色收敛成命名令牌（全部取自 demo 选择器，不手调色），例如：

| 令牌 | 值 | demo 出处 |
| --- | --- | --- |
| `--green-deep` | `#135b44` | `.btn.primary:hover` |
| `--green-hero` | `#123e31` | `.hero` |
| `--green-ink` | `#315534` | `.nav-item.active` / `.tabs button.active` |
| `--green-soft` | `#eef3e9` | `.pill` |
| `--green-soft-2` | `#e9efdf` | `.profile-header` |
| `--green-soft-3` | `#e6efdf` | demo `[data-route="identify"]` 胶囊 |
| `--green-art` | `#e4eddb` | `.article-art` |
| `--green-panel` | `#edf3e7` | `.process-panel` |
| `--green-tiny-art` | `#e9f0df` | `.tiny-art` |
| `--green-nav-bg` | `#fcfdf9` | `.bottom-nav` |
| `--green-paper-soft` | `#fbfcf8` | `.empty` |
| `--green-line-soft` | `#eff3ec` | `.info-row` 分隔线 |
| `--green-line-soft-2` | `#edf1e7` | `.message-row` 分隔线 |
| `--green-line-2` | `#e2e9da` | `.bottom-nav` 上边线 |
| `--green-field` | `#dfe8dc` | `.input` 边框 |
| `--green-chip-line` | `#dfe7da` | `.chip` 边框 |
| `--green-empty-line` | `#d4dfc7` | `.empty` 虚线框 |
| `--green-switch` / `--green-switch-on` | `#d9e2ce` / `#82a768` | `.switch` / `.switch.on` |
| `--ink-nav` / `--ink-post` / `--ink-pill` / `--ink-hint` / `--ink-meta` | `#718277` / `#85907c` / `#6e8565` / `#97a48e` / `#a3ad9c` | `.nav-item` / `.post-text` / `.pill` / `.hint` / `.card-meta` |
| `--tone-warn-*` / `--tone-danger-*` / `--tone-low／medium／high-*` | `#f7f1e3/#987d4b`、`#f8eeec/#a4473e`、`#e5f2e6/#3d7949`、`#fff0d6/#986b1c`、`#fbe5e2/#aa463d` | `.pill.amber`、`.btn.danger`、`.risk-low／medium／high` |

状态色（`--color-loading` `#2B6CB0`、`--color-error` `#C53030`、`--color-invalid` `#8A6D1F`、`--color-stub` `#5B4B8A`）**demo 未定义**，沿用任务书 `docs/implementation-requirements.md:402` 的值，本片不改。

既有页面的 `--color-primary` / `--color-bg` / `--color-text` / `--color-border` 等别名在 `tokens.wxss` 里指向上面的 demo 值，**其它页面（reference／login／后台）不必改一行即可跟随色板**。

## 2 逐页对齐说明

### 2.1 首页 `pages/home/home`

| demo 参照（`dist/app.js` 的 `home()` / `dist/styles.css`） | 小程序实现 | 说明 |
| --- | --- | --- |
| `.page-heading` + `h1` + `p` | `.page-heading` / `.page-heading__title` / `.page-heading__sub` | 24px 主标题 + 副标题层级一致 |
| `.hero`（`#123e31`、18px 圆角、27/24 内距）+ `.eyebrow` + `h2` + `p` + `.btn.lime` + `.hero-code` | `.hero` / `.hero__eyebrow` / `.hero__title` / `.hero__sub` / `.btn--lime` / `.hero__code` | 深绿舞台、浅绿 CTA、右下角英文小字均保留 |
| `.hero-art`（field.svg 插画 + 同心圆） | `.hero__art` + `::before/::after` 同心圆 | **取舍**：不新增二进制插画资产，用同心圆与渐变替代 |
| `.feature-grid` + `.feature-card`（图标块 + 标题 + 描述 + `.card-arrow`）+ `.new-tag` | `.feature-grid` / `.feature-card` / `.feature-card__icon` / `.feature-card__title` / `.feature-card__desc` / `.badge--stub` | **取舍**：入口保持已确认的 3 个（不为凑 demo 四宫格补虚构入口）；`.new-tag` 位置承载「未接入」而非「NEW」 |
| `.home-bottom` + `.panel` + `.panel-head` + `.info-list` + `.info-row` + `.tiny-art` + `.pill` | 同名的 `.home-bottom` / `.panel` / `.panel-head` / `.info-list` / `.info-row` / `.tiny-art` / `.pill` | 科普资料三项为**真实已有入口**（服务端查询／本地静态资料／种子资料库） |
| `.mini-timeline` / `.timeline-item` / `.timeline-dot` / `.timeline-copy` | 已落入样式层 | **取舍**：demo 的「今天的探索」是演示记录，小程序无对应数据，不编造时间线；类留给后续接入 |

改动文件：`home.wxml`、`home.wxss`、`home.js`（仅 `entries[].icon` → 图标类名）、`app.wxss`。

### 2.2 识别 `pages/identify/identify`

| demo 参照 | 小程序实现 | 说明 |
| --- | --- | --- |
| `.page-heading` | `.page-heading` | — |
| `.notice` | `.notice` / `.notice--warn` / `.notice--stub` / `.notice--danger` | demo 只有一种 `notice`；小程序需要「游客／模式／替身／失败」四种语气，故加语气修饰类 |
| `.feature-card`（图标 + 标题 + 描述） | 「识别入口」三个 `.feature-card`（`gy-icon--leaf/tag/chat`） | **取舍**：demo 识别页是「weed/label 两个 tab + 一个 scan-stage」，小程序识别页已有 GY-I09 交付的三入口交互（`data-mode`），本片**不改写该交互**，只把入口卡换成 demo 的 feature-card 形态 |
| `.scan-stage` / `.scan-frame`（四角框线）/ `.scan-caption` / `.sample` / `.process-panel` / `.progress-track` / `.process-steps` | 已逐条落入 `styles/components.wxss` | **形态已落地，未接进识别页**（避免改写他人交互）；在样式走查页 `pages/specimen` 逐项可核对 |
| `.result-candidate`（图标 + 名称 + 说明 + 分数） | `.candidate` / `.candidate__rank` / `.candidate__body` / `.candidate__state` | 层级对齐；`candidate--picked` 取 demo `.period.active` 的选中色 |
| `.stat-grid` / `.stat` | `.stat-grid` / `.stat` | 用于资料/来源统计块 |

改动文件：`identify.wxml`、`identify.wxss`、`identify.js`（仅 `modes[].icon` → 图标类名）。

### 2.3 资料库 `pages/knowledge/knowledge` 与资料详情 `pages/knowledgedetail/knowledgedetail`

| demo 参照 | 小程序实现 | 说明 |
| --- | --- | --- |
| `.search-box` + `.input` + `.chips` + `.chip` | 同名类（GY-I07 已按 demo 对齐） | 保留 GY-I07 的实测形态不动 |
| `.article-card` / `.article-art`（圆环）/ `.card-meta` / `.card-title` / `.pill` | 同名类 | 保留 |
| `.detail-layout` / `.prose` / `.stat-grid` / `.stat` / `.notice` / `.row-actions` | 资料详情按同样层级组织 | 保留 |
| `.empty`（统一空／失败态） | `<state-view>`（loading／empty／error／guest） | **本轮补齐**：原来失败只渲染一行灰字，现在统一走状态组件 |
| `.tabs`（资料类型切换） | **不实现** | **取舍**：demo 的 UI 分类（作物／农药／全部）与冻结 API 的筛选维度不同，GY-I07 已明确「没有虚构 type 筛选」，本片不违反 |

改动文件：`knowledge.wxml`（状态收口）、`knowledge.js`（新增 `stateKind` 状态语气字段，未改数据流）、`knowledge.json`（注册 state-view）、`knowledgedetail.wxml` / `.js` / `.json` 同理。`knowledge.wxss` / `knowledgedetail.wxss` **未改**（GY-I07 的 `.knowledge-page .btn` 等已被 `tests/reference/knowledge-layout.test.mjs` 的正／负例锁定，且已按 demo 对齐）。

### 2.4 社区 `pages/community/community`（含 post 详情形态）

| demo 参照 | 小程序实现 | 说明 |
| --- | --- | --- |
| `communitySwitch()` 的 `.tabs.community-switch`（社区 ⇄ 资料库） | `.tabs.community-switch`：社区（当前）+ 资料库 | 资料库复用既有知识页，走 `utils/navigation.openTarget`，不新建页面 |
| `.section-head`（标题 + `btn primary`） | `.section-head` + `.btn--primary`（分享发现） | 主操作按钮与 demo 同位 |
| `.feed` / `.post` / `.post-author` / `.post-text` / `.post-visual` / `.post-actions` / `.comments` / `.comment-row` / `.topic` | **已逐条落入 `styles/components.wxss`** | **取舍**：社区数据未接入，本页保持空态，**不渲染任何演示帖子**（不违反「不生成假帖子与假评论」）；post 详情形态在样式走查页逐项可核对 |
| `.empty` | `<state-view status="empty">` | 统一空态 |

改动文件：`community.wxml`、`community.wxss`（清空重复定义，改用样式层）、`community.js`（新增 `onOpenLibrary`，仅路由）。

### 2.5 消息 `pages/messages/messages`

| demo 参照 | 小程序实现 | 说明 |
| --- | --- | --- |
| `.section-head` + `.chips` + `btn ghost`（全部已读） | `.section-head` + `.pill--gray`（暂无消息） | **取舍**：demo 的筛选 chips 与「全部已读」在无数据时是假交互，改为静态标注 |
| `.message-list` / `.message-row` / `.message-icon` / `.message-copy` / `.unread-dot` | 已落入样式层；本页用 `.info-row` 列「首版消息类型」 | **取舍**：三类是**类型说明**不是消息，用 info-row 而非 message-row，避免看起来像真通知 |
| `.empty` | `<state-view status="empty">` | — |

### 2.6 我的 `pages/profile/profile`

| demo 参照 | 小程序实现 | 说明 |
| --- | --- | --- |
| `.profile-header`（大头像 + 身份 + `.profile-actions`）+ `.ip-location` | `.profile-header` / `__avatar` / `__main` / `__title` / `__desc` / `.profile-actions` / `.ip-location` | IP 属地按 demo 位置呈现，但文案为「未接入（本版不读取 IP）」，不编造属地值 |
| `.stat-grid` + `.stat`（收藏／记录／发布） | `.stat-grid` + `.stat` | demo 的 stat 是可点入口；小程序对应功能未接入，渲染为**不可点**统计块 |
| `.profile-grid` + `.panel` | `.profile-grid` + `.panel` | 单列堆叠（窄屏） |
| `.setting-row`（标签 + 值 + 箭头） | 三个 `<picker>` 内用 `.setting-row` + `.setting-row__value` + `gy-icon--arrow` | 作物／浙江市／县区选择沿用原生 picker，不重写 GY-I05 的档案逻辑 |
| `.row-actions` + `btn` | `.row-actions` + `.row-actions__item` | 表单动作按钮组 |

改动文件：`profile.wxml`、`profile.wxss`（只留走查用的一处排布）。`profile.js` 未改。

### 2.7 底部导航 `custom-tab-bar`

| demo 参照（`.bottom-nav` 规则组） | 小程序实现 | 说明 |
| --- | --- | --- |
| 五按钮、`justify-content:space-around`、`padding:10px 8px calc(10px + env(safe-area-inset-bottom))` | `.tab-bar` | 一致 |
| `button{gap:5px;color:#a2b197;min-width:55px;padding:4px}` / `.icon{21px}` | `.tab` + `.gy-icon--tab-*` | 图标几何取自 demo 的 SVG path |
| `button.active{color:#396d33}` + `.active:before`（顶部 2px 指示条） | `.tab--selected` + `::before` | 一致 |
| `[data-route="identify"]`：`#e6efdf` 胶囊、26px 图标、`border-radius:15px`、`margin-top:-15px`、`box-shadow:0 -3px 0 4px var(--paper)` | `.tab--identify` | 一致；选中态换成 `var(--green)` 底 + `#e9f6d7` 字 |
| `background:#fcfdf9f5` + `backdrop-filter:blur(15px)` | `background:var(--green-nav-bg)`（不透明） | **取舍**：WXSS 毛玻璃支持不稳定，改不透明底避免对比度不确定 |

**组件样式隔离**：`custom-tab-bar/index.js` 增加 `options.styleIsolation='apply-shared'`（与 `state-view` 同一做法），否则 `app.wxss` 的 class 规则对自定义组件无效；同时 `custom-tab-bar/index.wxss` 自己 `@import` 图标层，双重保证。

### 2.8 article / post 详情的形态验证入口：`pages/specimen/specimen`

新增**样式走查页**，把无法用真实数据渲染的形态（帖子详情、识别台、八种统一状态、末屏标记）落到小程序运行时上：

- 门禁：`debug.localEnabled(wx)`，即 `config/runtime.js` 为 `local` 且 `envVersion === 'develop'`。共享源码默认 `disabled`，**标准包打开本页只会看到统一失败态**（这本身也是失败态走查入口），因此不存在「把演示内容带给用户」的风险；
- 页内所有文案都是**样式样张占位**，按钮只 `wx.showToast('样式样张，无业务行为')`，不调用任何接口、不读取任何数据源；
- 走查页不定义新形态：所有块直接引用 `styles/components.wxss` 的 demo 对应类，所见即真实页面所用。

## 3 demo 类 → WXSS 类映射表（机检对象）

`tools/demo-align.mjs` 的 `CLASS_MAP` / `MODIFIER_MAP` 共 **104 条**映射；`node tools/demo-align.mjs` 会逐条断言「右侧类在样式层存在」，缺失即 FAIL。

| demo 选择器 | 本仓 WXSS 类 |
| --- | --- |
| `.page-heading` | `.page-heading` |
| `.title-with-back` | `.page-heading__back` |
| `.back-btn` | `.back-btn` |
| `.subtitle` | `.subtitle` |
| `.section` | `.section` |
| `.section-head` | `.section-head` |
| `.compact-meta` | `.section-head__meta` |
| `.text-btn` | `.text-btn` |
| `.context-chip` | `.context-chip` |
| `.panel` | `.panel` |
| `.panel-head` | `.panel-head` |
| `.info-list` | `.info-list` |
| `.info-row` | `.info-row` |
| `.tiny-art` | `.tiny-art` |
| `.card-meta` | `.card-meta` |
| `.article-card` | `.article-card` |
| `.article-art` | `.article-art` |
| `.library-grid` | `.library-grid` |
| `.detail-layout` | `.detail-layout` |
| `.prose` | `.prose` |
| `.stat-grid` | `.stat-grid` |
| `.stat` | `.stat` |
| `.notice` | `.notice` |
| `.demo-caption` | `.demo-caption` |
| `.hint` | `.hint` |
| `.label` | `.label` |
| `.row-actions` | `.row-actions` |
| `.empty` | `.empty` |
| `.pill` | `.pill` |
| `.tag-label` | `.tag-label` |
| `.info-tags` | `.info-tags` |
| `.hero` | `.hero` |
| `.hero-content` | `.hero__content` |
| `.hero-art` | `.hero__art` |
| `.eyebrow` | `.hero__eyebrow` |
| `.hero-code` | `.hero__code` |
| `.dot` | `.dot` |
| `.feature-grid` | `.feature-grid` |
| `.feature-card` | `.feature-card` |
| `.feature-icon` | `.feature-card__icon` |
| `.new-tag` | `.new-tag` |
| `.card-arrow` | `.card-arrow` |
| `.home-bottom` | `.home-bottom` |
| `.mini-timeline` | `.mini-timeline` |
| `.timeline-item` | `.timeline-item` |
| `.timeline-dot` | `.timeline-dot` |
| `.timeline-copy` | `.timeline-copy` |
| `.tabs` | `.tabs` |
| `.scan-grid` | `.scan-grid` |
| `.scan-stage` | `.scan-stage` |
| `.scan-view` | `.scan-view` |
| `.scan-frame` | `.scan-frame` |
| `.scan-caption` | `.scan-caption` |
| `.sample` | `.sample` |
| `.process-panel` | `.process-panel` |
| `.process-status` | `.process-status` |
| `.progress-track` | `.progress-track` |
| `.process-steps` | `.process-steps` |
| `.search-box` | `.search-box` |
| `.input` | `.input` |
| `.chips` | `.chips` |
| `.chip` | `.chip` |
| `.library-filters` | `.library-filters` |
| `.library-note` | `.library-note` |
| `.feed` | `.feed` |
| `.post` | `.post` |
| `.post-author` | `.post-author` |
| `.post-text` | `.post-text` |
| `.post-visual` | `.post-visual` |
| `.post-actions` | `.post-actions` |
| `.comments` | `.comments` |
| `.comment-row` | `.comment-row` |
| `.topic` | `.topic` |
| `.community-switch` | `.community-switch` |
| `.avatar` | `.avatar` |
| `.message-list` | `.message-list` |
| `.message-row` | `.message-row` |
| `.message-icon` | `.message-icon` |
| `.message-copy` | `.message-copy` |
| `.unread-dot` | `.unread-dot` |
| `.profile-header` | `.profile-header` |
| `.profile-actions` | `.profile-actions` |
| `.profile-grid` | `.profile-grid` |
| `.setting-row` | `.setting-row` |
| `.switch` | `.switch` |
| `.ip-location` | `.ip-location` |
| `.btn.primary` | `.btn--primary` |
| `.btn.ghost` | `.btn--ghost` |
| `.btn.lime` | `.btn--lime` |
| `.btn.dark` | `.btn--dark` |
| `.btn.full` | `.btn--block` |
| `.btn.danger` | `.btn--danger` |
| `.pill.gray` | `.pill--gray` |
| `.pill.amber` | `.pill--amber` |
| `.pill.blue` | `.pill--blue` |
| `.pill.purple` | `.pill--purple` |
| `.pill.risk-low` | `.pill--low` |
| `.pill.risk-medium` | `.pill--medium` |
| `.pill.risk-high` | `.pill--high` |
| `.chip.active` | `.chip--active` |
| `.tabs button.active` | `.tabs__item--active` |
| `.switch.on` | `.switch--on` |
| `.info-row .copy strong` | `.info-row__title` |
| `.info-row .copy small` | `.info-row__desc` |

## 4 明确不落地的 demo 类（逐条理由，不允许静默缺失）

| demo 类 | 不落地的理由 |
| --- | --- |
| `.shell / .sidebar / .workspace / .topbar / .crumb / .brand* / .nav-list / .nav-item / .nav-label / .sidebar-tools / .sidebar-note / .mobile-brand / .top-actions / .mode-badge / .preview-toggle` | 桌面端外壳与「手机预览」开关，小程序无对应层级 |
| `.footer-note` | 桌面页脚声明，小程序用页面末屏预留（.page padding-bottom）表达 |
| `.modal / .modal-backdrop / .modal-header / .modal-close / .login-mark / .login-copy / .agreement / .modal-note` | demo 的模拟登录弹窗；小程序为 pages/login 独立页（GY-I04），本片不接管 |
| `#toast` | demo 的浏览器 toast；小程序用 wx.showToast 原生能力，不用样式层复刻 |
| `.video-* / .periods / .period / .time-node / .timeline-bar / .play-circle / .generation-orb` | demo 的情景视频页；小程序无此页，见「适老版与后续单」声明 |
| `.chat-* / .bubble* / .suggestions / .sound-active` | demo 的农事问答页；小程序无独立问答页，界面留后续单 |
| `.crop-select-grid / .crop-choice` | demo 的作物选择弹窗；小程序用原生 picker（「我的」已交付） |
| `.result-hero / .result-candidate / .stat strong 的大数字` | demo 的识别结果页；小程序识别页为既有候选卡实现（GY-I09），本片只对齐样式令牌 |
| `.sr-only / .fade-in / @keyframes fadein／scanline／rotate／pulse` | 屏读专用类与动效：WXSS 不支持 :focus-visible 等伪类，动效按 prefers-reduced-motion 约定不引入 |
| `.float-create` | demo 桌面悬浮发布按钮；小程序社区页用 .row-actions 内的主按钮 |
| `.backdrop-filter / mask-image / isolation` | demo 顶栏毛玻璃与网格遮罩；WXSS 支持不稳定，改为不透明底色 |
| `display:grid 多列排版` | WXSS 的 grid 在旧基础库支持不一致，样式层用 flex + 百分比宽度等价实现 |

## 5 与 demo 不 1:1 的地方（取舍）

| # | demo 写法 | 本片写法 | 理由 |
| --- | --- | --- | --- |
| 1 | 密集小字 8／9／10／11／12／13／14px | 一律抬到 **16px（辅助）／18px（正文）** 下限 | 任务书「正文优先 18px」与「触控区 ≥44px」是不可让渡门槛；视觉对齐不能以可读性为代价。字号核对见 `tools/demo-align.mjs` 第 4 组 |
| 2 | 固定 px 字号 | `calc(Npx * var(--font-scale, 1))` | 需求 4.1 适配微信字体设置；裸 px 字号会被 `tests/ui-adaptive.test.mjs` 与 `tools/demo-align.mjs` 双重拒绝 |
| 3 | CSS Grid 多列 | `display:flex` + `flex-wrap` + 百分比宽度 | WXSS 在旧基础库上 grid 支持不一致；窄屏本就是单列，视觉结果一致 |
| 4 | 内联 `<svg stroke="currentColor">` | `data URI` 背景图（`styles/icons.wxss`） | WXSS 不能内联 SVG；`currentColor` 无法穿透 data URI，故按 demo 的实际描边色逐图标建类，几何与 demo 逐字一致（机检对象） |
| 5 | `:hover` / `:focus-visible` / `backdrop-filter` / `mask-image` / `isolation` | 不落地；交互反馈用 `hover-class` | WXSS 支持不稳定或语义不同；hero 的网格遮罩以一层渐变近似 |
| 6 | 可变字重 550／650 | 600／700 | 部分系统字体不生效，避免层级塌陷 |
| 7 | `.hero-art`（field.svg）／`.login-mark`／`.chat-orb` 等插画 | 同心圆 + 渐变的 CSS 近似；不新增二进制资产 | 小程序 `<image>` 对 SVG 支持不一致；避免引入未审素材 |
| 8 | 演示内容（示例帖子、示例消息、示例话题、IP 属地样例值、示例时间线） | **不渲染** | 与「不生成假帖子／假通知」「不伪造专家意见与用药结论」冲突；只保留类与形态 |
| 9 | `.scan-stage` 等识别台形态 | 落入样式层 + 走查页核对，**不改写识别页交互** | 识别页三入口由 GY-I09 交付，本片不接管他人页面逻辑 |
| 10 | post 详情页（demo `post/` 路由） | 只提供样式层 + 走查页形态 | 小程序无帖子详情页；社区数据未接入，新建可点页面会变成假功能 |
| 11 | 资料库 `.tabs`（作物／农药／全部） | 不实现 | 与冻结 API 的筛选维度不一致，GY-I07 明确不虚构 type 筛选 |
| 12 | 底部导航毛玻璃 | 不透明底色 | 见 2.7 |
| 13 | 资料卡 `.article-art` 高度（demo 桌面 108px／窄屏 91px） | 样式层取窄屏 `min-height:91px` 并随字号放大；资料页保留 GY-I07 实测的 `min-height:108px` 覆盖 | 资料页形态已由 GY-I07 用真机截图验证，本片不回归；样式层给后续页面用窄屏值 |

## 6 监工点名缺口的补齐

| 缺口 | 本轮处理 | 证据 |
| --- | --- | --- |
| **官方字号路径**（`wx.getAppBaseInfo` / 字体缩放适配） | 实现已在 `utils/system-font.js`（比例字段优先：`getFontSizeManager` > `getAppBaseInfo` > `getSystemInfoSync`，缺失才用 px÷16，封顶 1.3）；本轮把**样式层全部字号**改成 `calc(Npx * var(--font-scale,1))` 并纳入机检，杜绝「新增样式绕过字号适配」 | `tests/ui-adaptive.test.mjs` 的 `官方比例路径：getAppBaseInfo 必须接入`＋4 组反例；`tools/demo-align.mjs` 第 4 组；`node tools/verify-layout.mjs` 读取 `system-font.js` 的 `MAX_FONT_SCALE` |
| **主要按钮** | 五 Tab 各有明确的 `.btn--primary` 主操作（首页 hero 识别 CTA + 微信登录、识别入口卡、资料库查询／重试、社区分享发现、我的前往登录／手选档案）；按钮配色修饰类与 demo `.btn.primary/.btn/.btn.ghost/.btn.lime/.btn.danger` 一一对应 | `styles/components.wxss` 第「按钮修饰」节；`tests/ui-demo-align.test.mjs` 的 44px 触控下限逐类断言 |
| **末屏** | Tab 高度不再硬编码，改为**按 `custom-tab-bar/index.wxss` 的实际声明复算**，并在**微信最大字号档（1.3 倍）**核对：标准档 73.6px／最大档 **87.3px**，`.page` 底部预留 `calc(105px + env(safe-area-inset-bottom))` ⇒ 五档视口全部通过 | `node tools/verify-layout.mjs`（第 6 节原始输出） |
| **统一失败态** | `components/state-view` 改为 demo `.empty` 形态（虚线框 + 图标 + 标题 + 说明 + 语气色）；五个 Tab、资料库、资料详情、走查页全部注册并使用它，**不再自写一行灰字当失败提示** | `tests/ui-demo-align.test.mjs` 的「统一失败态」断言；`state-view.js` 八态 PRESETS 由 `tests/ui-adaptive.test.mjs` 锁定 |

## 7 我跑的检查与原始输出

运行环境：Windows + Node `v24.16.0` / npm `11.13.0`；`npm ci` 已安装依赖（103 包，来自本地缓存）。**以下全部为静态检查或 Node 测试，不是微信工具编译，也不是真机。**

```text
$ node tools/demo-align.mjs
1) 令牌值集合比对（demo dist/styles.css :root → miniprogram/styles/tokens.wxss）
   --green  #176b50 OK   --ink   #17352b OK   --muted #7b8983 OK
   --paper  #f5f7f4 OK   --line  #e5ebe5 OK   --lime  #c6f17b OK
2) 关键类名存在性：映射 104 条；缺失 0 条；明确不落地 12 组（逐条理由见工具内 OMITTED_CLASSES）
3) 图标几何一致性：28 个图标类由 demo app.js 的 SVG path 生成；与 styles/icons.wxss 一致
4) 可访问性门槛：样式层无裸 px 字号；交互类引用 --tap-min
PASS: 令牌逐值一致、关键类齐全、图标几何与 demo 一致、门槛未被破坏。
未覆盖：微信开发者工具／模拟器／真机渲染与截图（本片未取得）。
```

```text
$ node tools/verify-layout.mjs
视口     设备                内容宽  触控区  正文   底部预留  主标题 副标题 入口描述
----------------------------------------------------------------------------------------
320px    旧安卓 / SE 一代         278    44px   18px   105px    2      1      2
360px    主流安卓入门机             318    44px   18px   105px    2      1      1
375px    iPhone 8 / X        333    44px   18px   105px    1      1      1
414px    主流安卓 / iPhone 11    372    44px   18px   105px    1      1      1
768px    平板                  726    44px   18px   105px    1      1      1
底部预留来源：.page 的 padding-bottom 声明为 calc(105px + env(safe-area-inset-bottom))。
横向内距：21px（对齐 demo .main 的 21px）。
底部 Tab 高度（按声明复算）：标准档 73.6px；最大字号档 1.3 倍 → 87.3px。
末屏判定：预留需 ≥ **最大字号档** tabBar 87.3px（字号放大后 Tab 变高，只在标准档通过不算通过）。
PASS: 五档视口下触控区、正文与末屏预留（含最大字号档）均满足门槛。
```

```text
$ node --test tests/ui-demo-align.test.mjs        → tests 7 / pass 7 / fail 0
$ node --test tests/ui-adaptive.test.mjs          → tests 26 / pass 26 / fail 0
$ node --test tests/local-debug.test.mjs          → tests 4 / pass 4 / fail 0
$ node --test tests/unit/miniprogram-login-return-to.test.mjs → tests 41 / pass 41 / fail 0
$ node --test tests/unit/miniprogram-profile.test.mjs tests/integration/profile-ui-http.test.mjs → pass（13.4s）
$ node tools/check-wechat-project.mjs             → PASS: native JSON/routes, five empty tabs, shared domain check and JS syntax.
$ node --check tools/smoke-wechat.cjs             → exit 0
$ npm run lint                                    → PASS tsc --noEmit services/api/tsconfig.json
                                                    PASS tsc --noEmit apps/admin/tsconfig.json
                                                    PASS 仓库卫生扫描；lint 通过
$ npm run test:docs                               → PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping
$ npm run test:unit                               → tests 1737 / pass 1736 / fail 0 / skipped 1（duration 22.2s）
$ git check-ignore project.private.config.json config/debug.local.json .local/wechat-local/project.config.json .env → 全部被忽略
$ git check-ignore project.private.config.json.example config/debug.local.config.json.example .env.example → 均未被忽略（符合预期）
```

`.github/workflows/local-wechat.yml` 的本地检查步骤已逐条在上述范围内执行；本轮同时把新检查接进工作流（`tools/demo-align.mjs`、`tests/ui-demo-align.test.mjs`），并把 `docs/ui-demo/**` 加入触发路径——demo 变更必须重新跑对齐核对。

改动规模（样式与工具提交 `6e4a84f`）：

```text
$ git diff --stat 15c3003..6e4a84f
 40 files changed, 3565 insertions(+), 799 deletions(-)
```

## 8 未取得 / 未验证（一律不写成通过）

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 微信开发者工具编译 | **未取得** | 本机未安装微信开发者工具（`C:\Users\MR\AppData\Local\微信开发者工具` 下只有残留的 `User Data`，无 IDE、无 `cli.bat`）。因此没有真实编译结果、没有代码质量扫描结果 |
| 微信开发者工具截图 | **未取得** | 同上；`tests/integration/local-dev-ui.cjs` 需要官方 SDK（`miniprogram-automator`）与自动化端口，本机不具备 |
| 模拟器（iPhone 5 / 320px 等机型） | **未取得** | 同上 |
| Android 真机 | **未取得** | 无设备与身份 |
| iOS 真机 | **未取得** | 无设备与身份 |
| 真机 systemInfo 视口／字体倍率 | **未取得** | 沿用 GY-I26／GY-I07 的历史真机证据，本轮未新测 |
| 五 Tab 视觉走查截图（与原 demo 并列） | **未取得** | 需要开发者工具；本轮只提供**类与令牌的机检等价**，不提供像素对照图 |
| 适老版（最大字号／简化布局） | **不做** | 用户 2026-10-14 指令「适老版后面再弄」；本片只保证字号仍随微信设置放大且不破版（静态核算），适老版单独立项 |
| 付费调用 | **未发起** | 无任何外部付费请求 |
| 小程序／后台功能已交付 | **不声称** | demo 自述「不连接项目后端；仅供界面与交互参考」；本轮只交付界面样式 |
| WXSS 运行时行为（`@import` 内联、CSS 变量在 `page` 上的继承、`data:image/svg+xml` 背景图图标、`styleIsolation: apply-shared` 让 `app.wxss` 作用到组件） | **未取得** | 这些结论只在微信编译期／运行时成立，**静态比对证明不了**。实现按官方文档与仓内既有用法（`state-view` 已用 `apply-shared`，既有页面已用 `page{}` 变量与 `calc()`）写成，仍需在开发者工具内实测；若图标不显示或样式层未生效，优先检查 `app.wxss` 的 `@import` 是否被编译、组件样式隔离与 `--font-scale` 是否注入 |

**给持有微信开发者工具的复核者的复现命令**：

```powershell
# 1) 生成隔离的本地替身工程（含 styles/ 与走查页）
node tools/prepare-wechat.mjs local --config config/debug.local.json
# 2) 用开发者工具打开 .local/wechat-local，逐页核对：
#    首页／识别／资料库／社区／消息／我的（五 Tab + 资料库）、
#    「我的 → 开发工具 → 样式走查」中的帖子详情、识别台、八种状态、末屏标记
# 3) 标准档与微信「设置 → 通用 → 字体大小 → 特大」各截一次，核对末屏不被 tabBar 遮挡
# 4) 逐项确认运行时行为：底部五 Tab 的线性图标是否显示（data URI 生效）、
#    五 Tab 页面的色板/圆角/间距是否为 demo 观感（app.wxss 的 @import 生效）、
#    放大字号后按钮与入口卡是否同步放大（--font-scale 注入生效）
```

## 9 色板冲突披露（交监工裁定）

| 出处 | 值 | 本片处理 |
| --- | --- | --- |
| `docs/ui-demo/dist/styles.css:1`（PR #132） | `--green:#176b50`、`--ink:#17352b`、`--muted:#7b8983`、`--paper:#f5f7f4`、`--line:#e5ebe5`、`--lime:#c6f17b` | **采用**（用户 2026-10-14：先做到 demo 演示的样式） |
| `docs/implementation-requirements.md:402` | 主题绿 `#1F7A45`、知识类绿 `#2E9E5B`、提示蓝 `#2B6CB0`、警告红 `#C53030`、提醒黄 `#B7791F` | 状态色（蓝／红／黄紫）**沿用**；两个主题绿被 demo 值取代 |
| `docs/initial-issues.json:1145`、`docs/initial-issues.md:731`、`docs/ui-state-inventory.md:52` | 主题绿 `#1F7A45` | 随之需要在裁定后同步修订（本轮已改 `ui-state-inventory.md` 的视觉指标行） |

**这是本轮唯一一处「与任务书字面冲突」的改动**，影响面被刻意收窄到可一处回退：`miniprogram/styles/tokens.wxss` 的 `--green` / `--color-primary` + `miniprogram/app.json` 的两处颜色 + 两条断言（`tests/ui-adaptive.test.mjs` 的主题色断言、`tests/ui-demo-align.test.mjs` 的色板断言）。判回 `#1F7A45` 只需改这 4 个位置，其余样式层不动（各页面只引用 `var(--green)` / `var(--color-primary)`）。

## 10 PR 正文可粘贴段落

> **注意**：本节是**样式层交付当时**的正文（当时微信工具证据尚未取得）。工具证据取得后，请改用第 11.10 节的「变更 2」段落，本节保留作历史记录。

下文为可直接粘贴的 PR 正文（推送方复制代码块内容即可）。

```markdown
## 目的

把用户端五个 Tab（首页／识别／资料库／社区／消息／我的）与 article／post 详情的样式，按用户 2026-10-14 的最高优先级指令对齐到 `docs/ui-demo/demo.html`（PR #132）。Refs #28，**不关闭整项**。

实现者：写手（独立 worktree，分支 `feat/gy-i26-demo-align`，基线 `upstream/main` `15c3003`）；推送者：指挥。

## 交付内容

- **设计令牌**：`miniprogram/styles/tokens.wxss` 逐值复现 demo `:root` 的 6 个色板令牌（`--green #176b50` 等），并把 demo 规则里反复出现的派生色收敛为命名令牌；保留 `--color-*` 别名，其它页面不改一行即跟随色板。
- **图标层**：`miniprogram/styles/icons.wxss` 的 28 个图标类**由 demo `app.js` 的 SVG path 自动生成**（data URI，WXSS 不能内联 SVG），几何逐字一致；`node tools/demo-align.mjs --write-icons` 重生成、`node tools/demo-align.mjs` 校验。
- **组件层**：`miniprogram/styles/components.wxss` 覆盖 demo 的按钮／卡片／panel／pill／tabs／chips／底部导航／info-row／feature-card／profile-header／setting-row／article-card／post／comment-row／empty 等形态。
- **五 Tab 与详情**：改用 demo 的页头与容器形态；底部导航按 demo `.bottom-nav` 重做（五图标 + 识别凸起胶囊 + 选中指示条）。资料库／资料详情沿用 GY-I07 已用真机证据验证的 demo 对齐样式，仅把失败／空结果**收口到统一状态组件**。
- **样式走查页** `pages/specimen`（仅本地替身工程可见）：核对无法用真实数据渲染的帖子详情、识别台与八种统一状态；标准包打开只显示统一失败态。
- **工具与门禁**：新增 `tools/demo-align.mjs`（令牌值集合／关键类名／图标几何／可访问性门槛机检）与 `tests/ui-demo-align.test.mjs`；`tools/verify-layout.mjs` 改为按 `custom-tab-bar` 的实际声明复算 Tab 高度，并在**微信最大字号档 1.3 倍**核对末屏预留（105px ≥ 87.3px）；两者已接进 `local-wechat` 工作流。
- **打包**：`tools/prepare-wechat.mjs` 允许清单补 `styles/*.wxss` 与走查页——`app.wxss` 通过 `@import` 引用样式层，漏打包会让隔离工程整站丢样式。

## 已跑的检查（原始输出见证据页第 7 节）

`node tools/demo-align.mjs` PASS；`node tools/verify-layout.mjs` PASS；`node --test tests/ui-demo-align.test.mjs` 7/7；`node --test tests/ui-adaptive.test.mjs` 26/26；`node --test tests/local-debug.test.mjs` 4/4；`node tools/check-wechat-project.mjs` PASS；`npm run lint` PASS；`npm run test:docs` PASS；`npm run test:unit` 1736 pass / 0 fail / 1 skip；`git check-ignore` 隔离规则符合预期。

## 未取得（不写成通过）

微信开发者工具编译与截图、模拟器、Android／iOS 真机**均未取得**（本机未安装开发者工具，仅有残留 User Data）。因此本 PR 只主张「令牌与类的机检等价」，**不主张像素级一致**；复核命令与逐页核对清单见证据页第 8 节。

## 色板冲突披露（请裁定）

demo `:root` 的 `--green:#176b50` 与 `docs/implementation-requirements.md:402` 的「主题绿 `#1F7A45`」冲突。按用户 2026-10-14「前端页面务必先做到 demo.html 所演示的样式」，本 PR **采用 demo 值**；状态色（提示蓝／警告红／提醒黄／替身紫）demo 未定义，沿用任务书值。影响面已收窄到 4 处（`tokens.wxss` 的 `--green`/`--color-primary`、`app.json` 两处颜色、两条断言），判回只需改这 4 处。

## 适老版声明

**适老版本轮不做**（最大字号／简化布局），按用户指令留作后续单。本 PR 只保证字号仍随微信字体设置放大，且在最大字号档的静态核算下不破版、末屏不被 Tab 遮挡。

## 证据

`docs/verification/gy-i26-demo-align-20261014.md`：令牌映射表、104 条类映射表、12 组不落地理由与逐条取舍、原始输出、未取得项。

Refs #28（不关闭整项）
```

---

# 11 微信开发者工具编译与页面实测（追加，2026-10-14 同日后半段）

**本节取代第 8 节中「微信开发者工具编译」「微信开发者工具截图」「五 Tab 视觉走查截图」「模拟器」「WXSS 运行时行为」五行**；第 8 节其余行（Android／iOS 真机逐页、真机 systemInfo 视口／倍率、适老版、付费、功能已交付）仍然有效，本节的真机条目见 11.6。

## 11.1 本轮口径升级到哪一层（先写结论）

| 层级 | 之前 | 现在 |
| --- | --- | --- |
| 设计令牌与类名的**静态机检等价** | 已取得 | 已取得（未变） |
| 微信开发者工具**真实编译** | 未取得 | **已取得**：隔离工程在官方工具内编译并加载，13 个路由全部可进入（`cli open` + 自动化实际渲染） |
| **模拟器逐页渲染 + 截图** | 未取得 | **已取得**：390×753 逻辑视口、SDK 3.17.3、官方 `miniprogram-automator` 0.12.1；五 Tab＋资料库＋两个参考详情＋走查页，原创截图见 11.3 |
| **组件内计算样式（`apply-shared`）** | 未取得 | **已取得**（工具内实测，非推断）：组件内部按钮量到只在 `app.wxss` 定义的 `.btn--secondary` 底色 `rgb(237,242,233)` 与 `page{}` 的 `--tap-min` 44px |
| **受控最大字号档几何实测** | 只有静态核算 | **已取得**：1.3 档下正文 23.4px、Tab 高 121.93px、末屏块 bottom 614.65 ≤ Tab top 631.41（不遮挡） |
| **真机逐页渲染 / 真机字号走查 / 真机截图** | 未取得 | **仍未取得**（但已确认自动化**能**切到真机，见 11.6，含原始报错与 GUI 最小步骤） |

即：从「仅令牌与类的机检等价」升级为「**工具内编译通过 ＋ 模拟器逐页渲染与截图通过 ＋ 组件内运行时行为实测通过 ＋ 受控最大字号档几何实测通过**」。真机只拿到「可达性＋机型指纹」，不写成通过。

## 11.2 产物、命令与原始输出

工作区 `E:\GengYunCommander\GengYun_W25`，分支 `feat/gy-i26-demo-align`。段前 HEAD `8641351`（= 本地样式交付 `f5f5645` + 已推送的 `origin/feat/gy-i26-demo-align` 合并）。

```text
$ git fetch origin --prune
 * [new branch]      codex/gy-i17-read-http-20261014 -> origin/codex/gy-i17-read-http-20261014
   2431cfd..72c4923  main       -> origin/main
$ git merge origin/feat/gy-i26-demo-align --no-edit     → Merge made by the 'ort' strategy.（20 文件，无冲突）
```

**（1）隔离工程：先拒后建**

```text
$ node tools/prepare-wechat.mjs local --config config/debug.local.json
Output already exists: E:\GengYunCommander\GengYun_W25\.local\wechat-local. Keep it for inspection or remove that exact generated directory before preparing again.
[exit 1]                                    ← 仓库设计如此：拒绝复用旧输出

# 先备份、关闭该工程、核对绝对路径后再删（只删经核对的这一个生成目录）
$ & "D:\微信web开发者工具\cli.bat" close --project <...>\.local\wechat-local --port 41195   → √ close
$ Remove-Item -LiteralPath E:\GengYunCommander\GengYun_W25\.local\wechat-local -Recurse -Force
  （第一次报“正由另一进程使用”，IDE 释放句柄后重试成功；未删原工程、未删他人目录）

$ node tools/prepare-wechat.mjs local --config config/debug.local.json
LOCAL import root: E:\GengYunCommander\GengYun_W25\.local\wechat-local
Diagnostic stub only: enable personal domain exception only in this isolated project if needed.
[exit 0]
```

重新生成与上一轮生成树**逐文件 SHA256 比对**（证明可复现，同时暴露上一轮的本地增补）：

```text
DIFF       project.private.config.json     ← 本轮由我按同一内容重建（urlCheck=false 的个人设置，被忽略）
DIFF       miniprogram/config/runtime.js   ← 上一轮把 apiBaseUrl 手改成 .../api/v1（见下）
ONLY_PREV  miniprogram/project.config.json ← 上一轮副本多出的 IDE 生成物（源里也有，未在打包白名单）
ONLY_PREV  miniprogram/utils/session.js    ← 源里存在但**全仓无引用**的遗留文件，也不在打包白名单
```

**（2）本地真实后端（拿会话用）**：`tools/local-dev` 是仓库既有的全栈本地联调入口，它自己把 `runtime.js` 写成 `…/api/v1`，因此不需要手改生成物。

```text
$ node tools/local-dev/prepare.mjs --pg-bin E:\GengYunCommander\.pg17\pgsql\bin --api-port 3120 --pg-port 55436
Prepared isolated local environment: E:\GengYunCommander\GengYun_W25\.local\local-dev

$ powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .local\local-dev\start.ps1
Local profile catalog: synthetic fixture; 4 crops, 102 regions; initialized empty local tables.
Knowledge read projection ready for restricted LOGIN; no source or knowledge records seeded.
Database ready: 10 applied, 0 unchanged migrations.
READY: API http://127.0.0.1:3120; PG 127.0.0.1:55436; synthetic WeChat identity.

$ GET http://127.0.0.1:3120/health
{"status":"ok","checks":{"api":{"status":"ok"},"database":{"configured":true,"status":"ok","latency_ms":64}},
 "meta":{"contract_version":"1.0.0","execution_mode":"stub"}}
$ GET /api/v1/auth/session  → 401 {"error":{"code":"SESSION_REQUIRED",...}}        ← 游客被服务端拒绝
```

**必须披露的两处本地覆盖（都在被 `.gitignore:44 /.local/` 忽略的目录内，未入库）**：

1. `.local/wechat-local/miniprogram/config/runtime.js`：由 prepare 写入的 `apiBaseUrl` 只有 origin（`http://127.0.0.1:3120`），而 `tools/local-debug-config.mjs` 的契约**禁止**在配置里带路径，客户端却按 `apiBaseUrl + '/auth/...'` 取值，真实 API 挂在 `/api/v1`。上一轮把这一行改成 `http://127.0.0.1:3120/api/v1` 才登得上；本轮**沿用同一处一行覆盖**，并在脚本里断言探针存在，避免静默拿到旧构建。被测源码与生成副本的其它文件均未被改动。
2. `.local/wechat-local/project.private.config.json`：`{"setting":{"urlCheck":false}}`，只存在于这个隔离工程；共享 `project.config.json` 仍是 `urlCheck: true`。

**（3）编译 / 打开 / 自动化端口**

```text
$ & "D:\微信web开发者工具\cli.bat" islogin --port 41195
√ IDE server has started, listening on http://127.0.0.1:41195
√ islogin
{"login":true}

$ & "D:\微信web开发者工具\cli.bat" open --project E:\...\.local\wechat-local --port 41195
√ open

$ & "D:\微信web开发者工具\cli.bat" auto --project E:\...\.local\wechat-local --auto-port 9430 --port 41195
√ Using AppID: wx4407a4b908a69a54
√ auto
```

`cli open` 只报 `√ open`，**不打印编译日志**；编译是否成功由自动化在真实渲染上反证（页面能进、样式能取到计算值、截图非空）。

**（4）两条工具限制（实测得到，影响脚本写法）**

1. **页面内嵌自定义组件取不到**：`<state-view>` 的宿主节点与内部节点对 automator 不可见——实测 `page.$$('.gy-state')`＝0、`page.$$('state-view')`＝0、`page.selectComponent('state-view' | '.gy-state' | '#gy-state-guest')` 全部为空；`page.selectAllComponents('state-view')`＝0。**但在页面自身 JS 上下文里** `this.selectAllComponents('.gy-state')`＝7、`this.selectAllComponents('state-view')`＝0（标签名选择器对自定义组件不生效，class 选择器生效）。因此走查页新增只读探针 `probeStates`，用 `createSelectorQuery().in(组件)` 在组件内量计算样式；`callMethod` 不等待返回的 Promise，探针把结果同时写进 `data.__probeStates` 再读回。
2. **同端口 `cli auto` 会复用一个装旧代码的实例**：改完 `specimen.js` 后在同端口重连仍拿到旧页面方法（`this.probeStates is not a function`），`close`+`open` 同端口也一样；**换一个新 `--auto-port` 才装载新构建**（实测 9422→9423→9425→9430）。

## 11.3 逐页渲染实测（工具内，非静态）

原始输出：`.local/wechat-evidence` 之外的工作目录 `E:\GengYunCommander\.w25-i26-evidence\demo-align\observations.json`（仓外；脚本为 `tests/integration/local-dev-demo-align.cjs`）。

```text
$ node tests/integration/local-dev-demo-align.cjs <官方SDK> E:\GengYunCommander\.w25-i26-evidence\demo-align 9430
PASS devtools simulator 390x753 (SDK 3.17.3): @import inlined, page{} tokens resolve, data URI icons render,
     apply-shared reaches components, five tabs + specimen forms render, last screen clears the real tab bar
     at both standard and max font scale.
BOUNDARY: synthetic loopback identity/data, controlled font substitution, devtools simulator only -
     not a production-data or release test.
```

| 页面 | 工具内实测（计算样式 / 结构） | 结论 |
| --- | --- | --- |
| **home（游客）** | `guest=true`；`.page` 18px；hero CTA 底色 `rgb(198,241,123)`；登录按钮存在 | 游客门禁与主操作渲染通过 |
| **home（登录后）** | `.page` 18px／`rgb(23,53,43)`；`.hero` `rgb(18,62,49)`；`.feature-card` 圆角 13px／描边 `rgb(229,235,229)`／内距 18px；`.btn` min-height 44px、字号 18px；`.btn--lime` `rgb(198,241,123)`；`.badge--stub` `rgb(239,234,247)`；图标 `background-image: url("data:image/svg+xml,…")`；面板 2、入口卡 3 | 令牌、卡片、按钮、图标均按 demo 值渲染 |
| **identify** | `.page` 18px；页头 24px／`rgb(123,137,131)`；面板 1、pill 3、主操作 1；`.btn` min-height 44px | 通过 |
| **资料库 knowledge** | （仓库既有脚本，夹具后端）10 张截图：检索／结果／空结果／服务失败／来源变更／当前版本／撤回详情／撤回后列表；正文 ≥18px、最小按钮高 ≥44px | 通过 |
| **community** | `.page` 18px；页头 24px；面板 2、pill 2、主操作 1 | 通过 |
| **messages** | `.page` 18px；页头 24px；面板 1、pill 1；**无按钮** | 通过（本页无已接入动作，缺口不适用，见第 6 节取舍表） |
| **profile** | `.page` 18px；页头 24px；面板 3、pill 2、主操作 1 | 通过；另有既有 `local-dev-profile-ui.cjs` 的读写／选地区／重进全链路 |
| **post / article 详情** | 走查页实测：`.post` 2、`.post-text` 2、`.post-visual` 1、`.post-actions__item` 3、`.comment-row` 1；`.article-card` 1、`.article-art` 1、`.prose__text` 1、`.stat` 2；`.post` 圆角 15px | 通过（社区当前**没有**帖详情路由，帖子详情只在走查页成形态，与第 5 节一致） |
| **pages/specimen** | 走查页 7 个 `.section` 全渲染；八态组件实例 7 个，状态序 `guest,empty,loading,error,cancelled,invalid,stub`；识别台 `.scan-stage`1／`.scan-frame`1／`.process-panel`1／`.progress-track`1；末屏标记 1，底色 `rgb(198,241,123)` | 通过 |
| **参考详情** | `.btn--primary` `rgb(23,107,80)`；`.pill--amber` `rgb(247,241,227)`；`.pill--gray` `rgb(242,243,238)` | 通过 |

**截图（仓外，`E:\GengYunCommander\.w25-i26-evidence\`，全部 PNG，字节数与 SHA256 如下）**

| 文件 | 字节 | SHA256 | 画面 |
| --- | --- | --- | --- |
| `demo-align\guest-home-390.png` | 84056 | `bbdf38170215485b14f4b618e7b71f2b74707efa06246d4368643924458f8fbd` | 游客首页 |
| `demo-align\guest-login-redirect.png` | 36943 | `2addcc3ed8275399dd17efefde8748b7bd60475fac2bf21aa6f2bb315f4a64fc` | 游客被拦到登录页 |
| `demo-align\runtime-home-top.png` | 88256 | `a54359a37a22c4288c67ca768cc6965ece6255e97d25208de6edc9e3f93b8010` | 登录后首页首屏 |
| `demo-align\runtime-home-bottom.png` | 70337 | `2bb26f5efd6f45b78067df41cefaf47afd0d9b6355ce90e3bb7b2ddeeb62f6d3` | 首页末屏 |
| `demo-align\maxfont-home-top.png` | 87761 | `d6abdbf96052fc48230618789387b1f15140e845ceb1d26b103ce6449379201b` | 受控 1.3 档首页首屏 |
| `demo-align\maxfont-home-bottom.png` | 76987 | `932cf9761dc718084ab0ba1fb21b132d4cd000bec76fa164f5ccd5f89acf9b84` | 受控 1.3 档首页末屏 |
| `demo-align\specimen-top.png` | 85710 | `ca85770a7394928e3c8e9b1021790eb7d23e0af36a5efdefdaff732fa99b0578` | 走查页首屏 |
| `demo-align\specimen-article-post.png` | 88409 | `87bc77b9ea1154805e0721cb839a4eb78102d410349b71bd0930e04b124162b8` | 文章卡＋帖子详情形态 |
| `demo-align\specimen-scan.png` | 65681 | `fb7f550a21afb4a1e2d774a4e3b51c6123418632179ace35f5332594e3e217f5` | 识别台形态 |
| `demo-align\specimen-states.png` | 74285 | `ce75523d2a08263b837e357cd113ad42ff6f803a06491acef5f3a770b3daf0b5` | 统一状态七态 |
| `demo-align\specimen-bottom.png` | 83044 | `c11e5383870adc807f9c92678a2d33e1ebdb4560febf90f2b2cf1b2ea1a8e679` | 走查页末屏标记 |
| `ui-390\home-top.png`／`home-bottom.png` | 88140／70172 | `850da1cb…48efc`／`1a0f6cdb…61fe1` | 既有脚本 `local-dev-ui.cjs`（390px）五 Tab 与两详情，共 15 张 |
| `ui-390\identify-top.png`／`identify-bottom.png` | 73890／78370 | `cfe98e97…3a20`／`ae39a7ce…4d0b` | 识别页首屏／末屏 |
| `ui-390\community-top.png`／`community-bottom.png` | 70451／93420 | `fdefb57e…bb94`／`eadf7359…41f5` | 社区首屏／末屏 |
| `ui-390\messages-top.png`／`messages-bottom.png` | 72450／81601 | `f263ffd3…72e0`／`caa58acc…c4f1` | 消息首屏／末屏 |
| `ui-390\profile-top.png`／`profile-bottom.png` | 48784／70521 | `5184d096…2f36`／`a6896ea7…38bd` | 我的首屏／末屏 |
| `ui-390\referencedetail.png`／`referenceseeddetail.png` | 77085／94328 | `4583a8c0…9eeb`／`b3bfe108…046b` | 两个参考详情 |
| `knowledge-ui\*.png`（10 张） | 36905–88801 | 见 `knowledge-ui\` 目录（`knowledge-search/result/empty/failure/version-changed/detail/source/withdrawn/withdrawn-list/guest-login`） | 资料库全链路 |
| `knowledge-ui-maxfont\*.png`（10 张） | 45949–95553 | 同上文件名（1.3 档） | 资料库全链路（受控最大字号） |
| `profile-ui\*.png`（15 张） | 36941–92915 | 见 `profile-ui\` 目录 | 既有 `local-dev-profile-ui.cjs`：读取／选地区／保存／重进／筛选 |
| `detail-route\*.png`（6 张） | 21102–110684 | 见 `detail-route\` 目录 | 既有 `local-dev-detail-route.cjs`：畸形登录、失效态、冷返回 |

字节数与哈希的更完整清单（含每个文件）在 11.7 的复核命令里可直接重算。

## 11.4 字号走查：静态核算 vs 工具内实测（分列）

静态侧：`node tools/verify-layout.mjs`（按 `custom-tab-bar/index.wxss` 声明复算）

```text
底部 Tab 高度（按声明复算）：标准档 73.6px；最大字号档 1.3 倍 → 87.3px。
  组成：Tab 容器上下内距 10+10px；图标 21px（识别 26px，上移 15px）；标签 14px × 行高 1.4；间距 5px；触控下限 44px。
PASS: 五档视口下触控区、正文与末屏预留（含最大字号档）均满足门槛。
```

| 项 | 静态核算 | 工具内实测（390×753，iPhone 12/13 (Pro)，SDK 3.17.3） | 对账 |
| --- | --- | --- | --- |
| 正文 | 18px | `.page` font-size **18px** | 一致 |
| 触控下限 | 44px | `.btn` min-height **44px**；首页按钮实际高 47.2px | 一致 |
| 底部 Tab 高（标准档） | 73.6px | **108.26px**（top 645.07） | 差 34.66px ＝ `env(safe-area-inset-bottom)`（iPhone 12/13 Pro） |
| 底部 Tab 高（1.3 档） | 87.3px | **121.93px**（top 631.41） | 差 34.63px ＝ 同一安全区；静态模型**加安全区后逐值吻合** |
| Tab 图标（标准／1.3 档） | 21px | **21px／27.29px** | 一致（本节点 `calc(…*var(--font-scale))` 生效） |
| 末屏预留 | `105px + env(safe-area-inset-bottom)` | 标准档末屏块 bottom **614.36 ≤ 645.07**；1.3 档 bottom **614.65 ≤ 631.41** | 两档均**不被 Tab 遮挡** |
| 1.3 档正文 | 23.4px | `.page` **23.4px**，按钮字号 23.4px | 一致 |
| 1.3 档最小按钮高 | ≥44px | **54.75px**（9 个按钮的最小值） | 通过 |
| `--tap-min` 是否随字号放大 | 文档表述为「触控区随字号放大」 | **恒 44px**（1.3 档仍是 44px） | **不一致 → 见下（如实记录，不写成通过）** |

**发现（非阻塞，如实记录，本片不改样式层）**：`miniprogram/app.wxss:33-34` 在 **`page` 节点**声明

```css
page { --font-scale: 1; --tap-min: max(44px, 44px * var(--font-scale, 1)); }
```

而真实字体系数是页面根节点以 `style="--font-scale: {{fontScale}}"` **注入到 `.page` 视图**上的，`page` 上仍是默认 1；自定义属性在声明节点求值，因此 `--tap-min` **恒为 44px**，依赖它的 `.btn`／`.setting-row` 等触控下限不会随字号放大。写在本节点的 `max(44px, 44px * var(--font-scale, 1))`（如 `styles/components.wxss:64`、`pages/identify/identify.wxss:82`）则正常放大到 57.2px。影响：不破版（44px 仍满足触控下限，按钮高度由内容撑高，1.3 档实测最小 54.75px），但与「触控区随字号放大」的表述不符。**是否修由监工裁定**；修法是一处：把 `--tap-min` 改成在各使用点本节点计算，或把 `--font-scale` 同时注入 `page`。

## 11.5 demo 运行时行为四条（逐条结论＋证据）

| # | 行为 | 结论 | 证据（工具内实测值） |
| --- | --- | --- | --- |
| 1 | `page{}` 上的 CSS 变量被页面节点继承 | **成立** | `.btn` min-height 取到 **44px**（`page{}` 的 `--tap-min`）；`.page` color 取到 `rgb(23,53,43)`（demo `--ink #17352b`）；`.btn--lime` 底色 `rgb(198,241,123)`（demo `--lime #c6f17b`） |
| 2 | `app.wxss` 的 `@import` 被内联到页面 | **成立** | `.btn`／`.btn--lime`／`.feature-card`／`.pill--amber` 这些**只在被 `@import` 的 `styles/*.wxss` 里定义**的类都取到计算值（如 `.btn` 字号 18px）；`styles/components.wxss:330` 的 `.btn--secondary` 底色 `rgb(237,242,233)` 也在**组件内部**量到 |
| 3 | `data:image/svg+xml` 图标作为背景图生效 | **成立** | 页面级 `.gy-icon--leaf` 的 `background-image` ＝ `url("data:image/svg+xml,%3Csvg%20xmlns='http://w…")`；组件内 `.gy-icon--tab-home` 量到 **21×21px**（1.3 档 27.29px），说明 data URI 真被解码并参与布局 |
| 4 | `styleIsolation:'apply-shared'` 让 `app.wxss` 作用到组件内部 | **成立** | `state-view.wxss` 内不含 `.btn`；组件内部按钮量到 `font-size 18px`、`min-height 44px`、底色 `rgb(237,242,233)`（`.btn--secondary`，只在 `styles/components.wxss` 定义）、实际高 47.2px。七态逐语气底色亦各自生效：guest `rgb(238,243,233)`／empty `rgb(251,252,248)`／loading `rgb(242,247,243)`／error `rgb(248,238,236)`／cancelled `rgb(251,252,248)`／invalid `rgb(247,241,227)`／stub `rgb(239,234,247)`；empty 的虚线框 `border-top-style: dashed`、`rgb(212,223,199)`（demo `.empty`）、圆角 14px、内距 40px |

## 11.6 真机：已连接且自动化可达，但逐页与字号实测**未取得**

用户确认开发者工具已登录并连接真机。实测结果（原始输出）：

```text
$ node .w25-i26-evidence\probe-remote.cjs <官方SDK> 9426
before : {"platform":"devtools","model":"iPhone 12/13 (Pro)","windowWidth":390,"windowHeight":753,"SDKVersion":"3.17.3"}
remote(true)  → OK    （调用时控制台出现一张真机调试二维码）
after  : {"platform":"android","model":"RMX3706","system":"Android 15","windowWidth":355,"windowHeight":792,"SDKVersion":"3.17.4"}
remote(false) → Error: timeout after 20000ms
```

**结论：官方 SDK 的 `MiniProgram.remote(true)` 确实把自动化切到了那台真机（机型指纹与模拟器显著不同：android／RMX3706／Android 15／355×792／SDK 3.17.4）。** 但随后：

```text
$ node tests/integration/local-dev-demo-align.cjs <官方SDK> E:\GengYunCommander\.w25-i26-evidence\device 9420 device
guest-gate: Error - timeout waiting for automator response
# 部分读数落盘（dump()）：{"target":"real device via MiniProgram.remote(true)", "remoteOn":"Error: timeout waiting for automator response",
#                          "platform":"devtools","width":390, ...}
#   → .w25-i26-evidence\device\attempt-remote-timeout.json
```

即：切到真机后，AppService 侧调用（`callWxMethod`／`evaluate`）与 `remote(false)` 都返回 `timeout waiting for automator response`，该自动化端口随之卡死（随后新建 `--auto-port 9427/9428` 也连接超时，需 `cli close`＋`open` 换端口才恢复；模拟器档 9420→9430 恢复正常并复跑 PASS）。

因此真机上的**逐页渲染、字号走查、截图一律未取得**，不写成通过。真机最少 GUI 步骤（持机者执行）：

1. 开发者工具打开 `.local/wechat-local`，手机微信扫「真机调试」二维码，**保持手机解锁、小程序在前台、亮屏不熄**；
2. 手机「设置 → 显示 → 字体大小」调到最大档，进入小程序，逐页核对：底部五 Tab（含识别凸起胶囊）是否与 demo 同款、卡片/按钮形态、末屏内容与标记是否被 Tab 遮挡、主要按钮是否被遮挡；
3. 每页截屏（真机截图即可），与我方静态核算对照：静态预测 1.3 档 Tab 高 87.3px＋手机安全区；
4. 真机上的业务请求**无法访问电脑 127.0.0.1**，所以第 2 步只能核对样式与几何；数据类核对仍以模拟器＋回环合成后端为准。

## 11.7 本轮未取得 / 未验证（更新第 8 节）

| 项目 | 状态 | 原因与复核命令 |
| --- | --- | --- |
| 真机逐页渲染 / 真机字号走查 / 真机截图 | **未取得** | 见 11.6：真机通道对 AppService 调用超时。复核：`node tests/integration/local-dev-demo-align.cjs <官方SDK> <仓外输出目录> <新auto-port> device`（前提前置：`cli auto --auto-port <新端口>` 新建会话、手机保持真机调试前台） |
| `tests/integration/local-dev-ui-controls.cjs` | **未取得** | 脚本第 7 行硬断言 `systemInfo().windowWidth === 320`，本机模拟器机型为 iPhone 12/13 (Pro)（390px），CLI 不能切换机型。复核：GUI 把模拟器机型切到 320px 宽（如 iPhone 5／SE 一代）后 `node tests/integration/local-dev-ui-controls.cjs <官方SDK> <输出目录> 9423` |
| `tests/integration/local-dev-knowledge-geometry.cjs` | **未取得** | 同样硬断言 320px（第 6 行），断言失败后未 disconnect 导致进程挂住（已结束该进程）。复核命令同上，需 320px 机型 |
| `tests/integration/local-dev-login-detail.cjs` | **未取得** | 对 `tools/local-dev` 的真实 API 跑到 `referencedetail-login` 断言失败（该脚本期望的参考域数据/端点与本机合成库未就绪），原始输出：`GUI failed at referencedetail-login; error type=AssertionError; no sensitive values printed.` 复核：`node tests/integration/local-dev-login-detail.cjs <官方SDK> 3120`（需按该脚本前置准备参考域数据） |
| iOS 真机 | **未取得** | 无 iOS 设备 |
| 真机 systemInfo 视口／字体倍率（长期档） | **部分取得** | 只拿到一次真机指纹（355×792、Android 15、SDK 3.17.4）；手机自身字体设置档位未取到 |
| 正式域名 / HTTPS / 网关 / 云部署 / 供应商调用 | **未取得** | 本片不做（用户指令） |
| 适老版（最大字号简化布局） | **不做** | 第 8 节不变 |
| 社区帖子详情真实数据渲染 | **不声称** | `app.json` 无帖详情路由；帖子详情只在走查页成形态 |
| 三处打包白名单外的源文件 | **观察（非本片交付）** | `miniprogram/utils/session.js`（全仓无引用、键名 `gengyun_session` 与 `auth.js` 的 `gengyun.session` 不同，疑似遗留）与 `miniprogram/project.config.json`（IDE 生成的嵌套配置）都不在 `tools/prepare-wechat.mjs` 白名单，`node --test tests/local-debug.test.mjs` 的产物加载（App＋custom-tab-bar＋全部 13 页）4/4 通过，说明**当前不影响编译与运行**；是否清理请监工裁定，本片不动他人范围 |

## 11.8 本轮门禁（没跑的不写通过）

```text
$ node tools/check-wechat-project.mjs
PASS: native JSON/routes, five empty tabs, shared domain check and JS syntax. Not a WeChat compiler or device test.
$ node --test tests/local-debug.test.mjs      → tests 4 / pass 4 / fail 0
$ node --test tests/ui-demo-align.test.mjs    → tests 7 / pass 7 / fail 0
$ node --test tests/ui-adaptive.test.mjs      → tests 26 / pass 26 / fail 0
$ node tools/demo-align.mjs
PASS: 令牌逐值一致、关键类齐全、图标几何与 demo 一致、门槛未被破坏。
未覆盖：微信开发者工具／模拟器／真机渲染与截图（本片未取得）。   ← 静态工具的自我声明，与本片 11.3 的实测互补
$ node tools/verify-layout.mjs                → PASS（五档视口 + 最大字号档末屏预留）
$ npm run test:docs
PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables
$ node --check miniprogram/pages/specimen/specimen.js ; node --check tests/integration/local-dev-demo-align.cjs  → 0
```

## 11.9 本轮失败并保留的记录（不隐藏）

1. `prepare-wechat.mjs` 首次拒绝覆盖（设计行为）→ 先备份、关闭工程、核对绝对路径后**只删该生成目录**再重建。
2. 第一次运行自动化脚本在 `specimen: 统一状态视图未渲染七态 (0 !== 7)` 失败——诊断出是**脚本用了取不到组件内部的页面级选择器**（无依据断言），修法是走查页加只读探针（见 11.2-(4)）。
3. 第二处失败 `demo .empty 虚线色 #d4dfc7 未生效（实际 rgb(223,231,218)）`——`.state--guest` 会覆盖 `border-color`，断言对象取错了状态；改为按空的 empty 一条核对。
4. 第三处失败 `最大字号档 --tap-min 未随之放大到 57.2px`——**断言本身没有依据**；改为如实记录 44px 与成因（见 11.4 发现）。
5. 真机 `remote(true)`／`remote(false)`／AppService 调用超时，端口卡死；恢复方式是 `cli close`＋`open`＋换新 `--auto-port`。
6. 环境层：本机 PowerShell 5.1 的 `Start-Process -RedirectStandardOutput` 在环境含**大小写重复**键（`NO_PROXY`/`no_proxy`、`HTTPS_PROXY`/`https_proxy`）时报 `Item has already been added`，导致 `tools/local-dev/start.ps1` 首次失败；本轮在**当次进程内**清掉小写那几个变量后运行（未改系统策略、未改仓库脚本）。`ExecutionPolicy` 用 `-ExecutionPolicy Bypass` 仅作用于当次进程。

## 11.10 PR #136 正文可粘贴段落（变更 2）

下文为可直接粘贴进 PR #136 正文的「变更 2：微信工具证据」段落。

```markdown
## 变更 2：微信工具证据（Refs #28，不关闭整项）

实现者：写手（独立 worktree，分支 `feat/gy-i26-demo-align`，段前 HEAD `8641351`）；推送者：指挥。

### 升级到哪一层

从「仅令牌与类的机检等价」升级为：**微信开发者工具真实编译通过 ＋ 模拟器逐页渲染与截图通过 ＋ 组件内运行时行为实测通过 ＋ 受控最大字号档几何实测通过**。真机只取得「自动化可达性＋机型指纹」，逐页与字号**未取得**，不写成通过。

### 环境与产物（全部为仓外/忽略目录，未入库）

- 隔离工程 `tools/prepare-wechat.mjs local --config config/debug.local.json` → `.local/wechat-local`（先按设计被拒一次，核对绝对路径后只删该生成目录再重建；重建结果与上一轮生成树逐文件 SHA256 比对一致，差异仅为披露的两处本地覆盖与两个白名单外文件）。
- 会话后端用仓库既有 `tools/local-dev`：真实 PostgreSQL 17 + 真实 Fastify API（`127.0.0.1:3120`，10 次迁移 0 变更），`/api/v1/auth/session` 游客 401；不是 mock。
- 官方工具链：微信开发者工具 `2.02.2608080`、CLI 已登录（`{"login":true}`）、`cli open`／`cli auto` 均 `√`；官方 `miniprogram-automator@0.12.1` 仍只隔离安装在 `.supervisor/wechat-automation`（未进业务依赖）。
- **披露的两处本地覆盖**（都在 `.gitignore:44` 忽略的 `.local/` 内）：① 生成副本 `miniprogram/config/runtime.js` 的 `apiBaseUrl` 补 `/api/v1` —— `tools/local-debug-config.mjs` 禁止配置带路径，而客户端按 `apiBaseUrl + '/auth/…'` 取值，不补就登不上；② `.local/wechat-local/project.private.config.json` 的 `urlCheck:false`（共享 `project.config.json` 仍是 `true`）。

### 实测结果

- `tests/integration/local-dev-demo-align.cjs`（新增，390×753、SDK 3.17.3）**PASS**：`@import` 内联、`page{}` 令牌、data URI 图标、`apply-shared` 作用到组件内部、五 Tab＋走查页形态、标准档与 1.3 档末屏均不被 Tab 遮挡。
- 逐页：home／identify／资料库／community／messages／profile 均按 demo 值渲染（正文 18px、页头 24px／`rgb(123,137,131)`、`.btn` 44px、主操作存在）；post／article 详情形态在走查页实测（社区无帖详情路由，不声称真实数据）；走查页七态与识别台齐备。
- 组件内部（`apply-shared` 的决定性证据）：`state-view.wxss` 不含 `.btn`，组件内部按钮却量到 18px／`min-height 44px`／底色 `rgb(237,242,233)`（`.btn--secondary`，只在被 `@import` 的 `styles/components.wxss:330` 定义）；七态逐语气底色各自生效。
- 既有脚本：`local-dev-ui.cjs`（390px 五 Tab＋两详情）**PASS**、`local-dev-profile-ui.cjs` **PASS**、`local-dev-detail-route.cjs` **PASS**、`local-dev-knowledge-ui.cjs`（夹具后端）**PASS**（scale 1 与受控 1.3 各 10 张截图）。截图仓外存放并给出字节数＋SHA256（证据页 11.3）。
- 字号走查（静态 vs 实测分列，证据页 11.4）：静态 Tab 高 73.6px／87.3px 与实测 108.26px／121.93px 之差恰为 iPhone 12/13 Pro 的 `env(safe-area-inset-bottom)`；1.3 档正文 23.4px、Tab 图标 27.29px、末屏块 614.65 ≤ Tab top 631.41，两档均不遮挡。
- 门禁：`check-wechat-project.mjs` PASS、`tests/local-debug.test.mjs` 4/4、`tests/ui-demo-align.test.mjs` 7/7、`tests/ui-adaptive.test.mjs` 26/26、`tools/demo-align.mjs` PASS、`tools/verify-layout.mjs` PASS、`npm run test:docs` PASS。

### 需要监工裁定的两点发现

1. **`--tap-min` 不随字号放大**：`app.wxss:33-34` 在 `page` 节点求值 `max(44px,44px*var(--font-scale,1))`，而 `--font-scale` 是注入在 `.page` 视图上的，故恒 44px（1.3 档实测仍 44px；不破版，最小按钮实测 54.75px）。修法一处，是否修请裁定。
2. **三处白名单外文件**：`miniprogram/utils/session.js`（全仓无引用、键名与 `auth.js` 不一致，疑似遗留）与 `miniprogram/project.config.json` 不在打包白名单；产物加载 4/4 通过，说明当前不影响编译运行。本片不动。

### 未取得（不写成通过）

真机逐页渲染／真机字号走查／真机截图：`MiniProgram.remote(true)` 实测**能**切到真机（`android`／`RMX3706`／`Android 15`／355×792／SDK 3.17.4），但随后 AppService 调用与 `remote(false)` 均 `timeout waiting for automator response`，端口卡死需换新 `--auto-port`；已给出真机 GUI 最小步骤清单。另：`local-dev-ui-controls.cjs`、`local-dev-knowledge-geometry.cjs` 硬断言 320px 机型（本机模拟器为 390px）、`local-dev-login-detail.cjs` 在 `referencedetail-login` 断言失败，三项均记「未取得＋复核命令」。iOS 真机、正式域名/HTTPS、云部署、供应商调用仍不做。

### 证据

`docs/verification/gy-i26-demo-align-20261014.md` 第 11 节：原始命令输出、逐页实测表、截图字节数＋SHA256、静态/实测字号对账、运行时行为四条、未取得项与失败记录。

Refs #28（不关闭整项）
```

## 12. 真机项台账（2026-10-17 追加，如实登记）

本节只登记**未取得**项与取得条件，不改写 §8／§11 的任何既有读数，也不把模拟器或工具内结果算作真机结论。工具内 `MiniProgram.remote(true)` 实测能切到真机（`RMX3706`／Android 15／355×792／SDK 3.17.4），但随后的 AppService 调用与 `remote(false)` 均 `timeout waiting for automator response`，端口卡死需换新 `--auto-port` —— 因此下列五项仍为「未取得」。

| 项目 | 状态 | 缺什么条件 | 复核入口 |
| --- | --- | --- | --- |
| 真机逐页走查（Android／iOS） | 未取得 | 需一台可扫码的 Android 真机与一台 iOS 真机，且 automator 端口稳定；当前只有模拟器与工具内截图，真机 automator 在 remote 切换后超时 | 真机调试 → 五 Tab 逐页打开并记录异常与首屏耗时 |
| 真机 systemInfo 视口与字体倍率 | 未取得 | 需在真机 `wx.getSystemInfoSync` 读取 `windowWidth`／`windowHeight`／`pixelRatio`，并在系统「显示大小」「字体大小」各档位各取一次；当前只拿到一台 Android 的静态指纹（355×792，Android 15，SDK 3.17.4），字体档位未取到 | 页面内临时打印 systemInfo，逐档记录并与 `tools/verify-layout.mjs` 的静态核算对账 |
| 五 Tab 视觉截图（真机，与原 demo 并列） | 未取得 | 需真机截图与原 demo 同视口并排对照；当前只有模拟器（390×753）与工具内计算样式证据 | 五 Tab 各截一张，按 §11 的并列方式补入 |
| Android 真机安装与启动 | 未取得 | 需 Android 真机 + 体验版二维码 + 已登录的测试微信号；当前无可用设备与稳定端口 | 扫码安装 → 冷启动 → 记录首屏与崩溃日志 |
| iOS 真机安装与启动 | 未取得 | 需 iOS 真机 + 体验版二维码 + 开发者证书与设备 UDID 登记；当前无 iOS 设备 | 扫码安装 → 冷启动 → 记录首屏与崩溃日志 |

以上均为未取得项，不构成条款 2 通过。模拟器与工具内的编译、截图、计算样式只证明可构建与样式静态一致，不替代真机验收；适老版仍属后续阶段，不在本节范围。台账与 `tests/reference/i26-tabbar-skeleton.test.mjs` 的「五条只许未取得、不得同时出现在通过型表述」断言一一对应。
