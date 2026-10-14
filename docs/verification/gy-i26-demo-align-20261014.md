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

| demo `:root` 令牌 | demo 值（`dist/styles.css:1`） | 本仓 WXSS | 结果 |
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
