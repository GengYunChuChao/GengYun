# GY-I28 demo 对齐（门禁补盲 + 消息 / 我的耕云 / 首页三处补口）（2026-10-18）

- 上游 issue：[GengYunChuChao/GengYun#28](https://github.com/GengYunChuChao/GengYun/issues/28)（**保持 open**）
- worktree：`E:\GengYunCommander\.pg17\wt-demo-parity`；分支：`feat/gy-i28-demo-parity`
- 基线：`upstream/main = de66803a596d55cbd9f9ab9b3a1b4aba36482ffa`（`git fetch upstream --prune` 后复核，未前进）
- 分析依据：`E:\GengYunCommander\.pg17\audit-demo-parity-20261018.md`（下文引用其 §4 卡点表与 M1/M2/M3、P1–P5、H3）
- 提交：

| 块 | 提交 | 一句话 |
| --- | --- | --- |
| A | `c664435` | video/chat 从「静默排除」改为显式「允许缺失视图白名单」，白名单外缺失即 MISSING |
| B | `37233a9` | 消息页「全部已读」（串行、失败即停）+ demo 筛选 chips |
| C | `2184ccd` | 我的耕云「我的发布」可点 + 「关于这次体验」面板 |
| D | `7d82606` | 首页 `panel-head` 补「查看资料库」 |

- **口径**：本页是**实现与门禁证据**，**不构成 #28 关闭**，也不声称真机／微信开发者工具／视觉走查通过（§7 逐条列出未取得项与实测错误原文）。

---

## 1. 红线遵守（实测）

| 项 | 实际 | 核对方式 |
| --- | --- | --- |
| `services/**`、`packages/**`、契约、迁移 | **0 改动** | `git diff --name-only upstream/main...HEAD` 只含 `miniprogram/**`、`tools/demo-align.mjs`、`tests/ui-demo-align.test.mjs`、本页 |
| 后端调用／新增接口 | **0** | 未改 `services/api/src/messages/**`；「全部已读」逐条复用既有 `PUT /messages/{id}/read` |
| 新增假数据源 | **0** | 我的发布走既有 `GET /posts?mine=true`（`utils/community-api.js:208-219`）；统计口径为「已加载条数」且读不到显示 `—` |
| 删除测试／放宽断言 | **0 删 0 改** | `tests/ui-demo-align.test.mjs` 仅追加 3 例（113 → 197 行） |
| `node_modules` 联接 | **0** | worktree 内独立 `npm ci`（added 103 packages） |
| 基线漂移 | **0** | 开工 `git rev-parse upstream/main` = `de66803…` |

---

## 2. 块 A：门禁补盲（`tools/demo-align.mjs`）

### 2.1 改前行为（问题）

`upstream/main` 的 `OMITTED_CLASSES` 里，video / chat 两组以「小程序无此页」为由**静默排除**：demo 有 `video`、`chat` 两个顶层视图，小程序没有对应页面，但门禁照样 `PASS`，缺口只存在于一行中文描述里，**没有任何机器可判定的信号**。即「demo 有、小程序没有」与「demo 有、小程序有」在门禁看来等价。

### 2.2 改后行为（第 5 组检查）

- `tools/demo-align.mjs:237` `export const VIEW_PAGES = { … }`：demo 每个视图 → 承接页路径数组（空数组＝已核实确无页）。
- `tools/demo-align.mjs:259` `export const ALLOWED_MISSING_VIEWS = ['video', 'chat'];`：**唯一的**允许缺失声明。
- `tools/demo-align.mjs:294` `export function readDemoViews()`：从 `docs/ui-demo/demo.html` 解析 `render()` 的视图分发表（`const content=({home,identify,result,library,video,chat,community,messages,profile}[page]…)`）与 `page==='article'`／`page==='post'` 两个动态路由；解析失败直接 `throw`（改名即红，不会静默通过）。
- `tools/demo-align.mjs:318` `export function auditViews(options = {})`：判定「有承接页」＝ 页面在 `miniprogram/app.json` 的 `pages` 注册 **且** `miniprogram/<page>.wxml` 存在。
- 判定规则：

| 情形 | 结果 |
| --- | --- |
| demo 视图在 `VIEW_PAGES` 有页且页已注册 + `.wxml` 存在 | `OK` |
| demo 视图不在 `VIEW_PAGES` | `MISSING <view>：demo 有此视图，但 VIEW_PAGES 未登记承接页…` |
| demo 视图无页且不在白名单 | `MISSING <view>：demo 有此视图，小程序无承接页，且未列入 ALLOWED_MISSING_VIEWS 白名单` |
| 登记了页但未注册 / `.wxml` 缺失 | `MISSING <view>：承接页未在 app.json.pages 注册或 .wxml 缺失：…` |
| 白名单含**非 demo 视图** | `ALLOWED_MISSING_VIEWS 含 <view>，但它不是 demo 的视图…` |
| 白名单含**已有页的视图** | `ALLOWED_MISSING_VIEWS 含 <view>，但 VIEW_PAGES 已登记承接页 …（有页的视图必须移出白名单）` |

任一非 OK 行进入 `problems` ⇒ CLI `exit 1`。白名单项单独打印（不带缩进，便于 grep）：

```
MISSING(allowed): video
MISSING(allowed): chat
```

### 2.3 当前读数（`node tools/demo-align.mjs`）

```
5) demo 视图承接（demo.html render() 分发 → app.json pages 注册页）
   11 个视图；有承接页 9 个；白名单允许缺失 2 个
   …（逐视图 OK 行）…
MISSING(allowed): video
MISSING(allowed): chat
PASS: 令牌逐值一致、关键类齐全、图标几何与 demo 一致、门槛未被破坏、demo 视图承接已逐个核对。
未覆盖：微信开发者工具／模拟器／真机渲染与截图（本片未取得）。
```

11 个视图 = demo 9 个顶层视图 + `article`、`post` 两个动态路由；9 个有承接页；2 个白名单项。

### 2.4 三例新测试（`tests/ui-demo-align.test.mjs`）

| 测试 | 断言 | 结果 |
| --- | --- | --- |
| `:130` 白名单删项即红 | `check({ allowedMissingViews: [] })` 的 `problems` 含 `MISSING video：…`、`MISSING chat：…` | pass |
| `:140` 白名单不能豁免过期项或非 demo 视图 | `+['library']` ⇒ 报「已登记承接页」；`+['favorites']` ⇒ 报「不是 demo 的视图」；`views + ['records']` ⇒ 报 `MISSING records：` | pass |
| `:161` 现状固定 | `problems` 为空；`readDemoViews()` 深等 11 项；`VIEW_PAGES.video/chat` 深等 `[]`；view 组 `present=9`、`allowedMissing=['video','chat']`；每个 OK 行页都在 `app.json.pages` | pass |

> 这三例的作用：把「白名单」钉成**可失败**的声明——删项红、加项红、视图表漂移红。旧实现里这三种情形全绿。

---

## 3. 块 B：消息页（`pages/messages`）

### 3.1 对照表（demo 选择器 → 小程序节点/类名）

| demo（`docs/ui-demo/demo.html`） | 小程序 | 说明 |
| --- | --- | --- |
| `:73` `.section-head > .chips` | `messages.wxml:29` `<view class="chips">` | 同一层级 |
| `:73` `button.chip` / `.chip.active` | `messages.wxml:33` `class="chip {{filter === item.value ? 'chip--active' : ''}}"` | demo `.active` ⇒ 本仓 `.chip--active`（`styles/components.wxss:877/892`） |
| `:73` chips `全部/互动/系统` | `messages.js:41` `FILTERS` = `all/unread/interaction/system` | 见 §3.2 口径差异 |
| `:73` `${btn('全部已读','read-all','ghost')}` | `messages.wxml:38-42` `<button class="btn btn--ghost" disabled="{{markingAll \|\| !hasUnread}}" bindtap="onMarkAllRead">` | 无未读时禁用；标记中显示「正在标记…」 |
| `:113` `case 'read-all': S.read = notifications.map(n => n.id)` | `messages.js:287` `onMarkAllRead()`：`targets = items.filter(unread)`，串行 `_markReadOne` | 不新增批量接口；成功只采信服务端返回的本体（`revision`／`read_at`） |
| `:112` `case 'message-filter': messageFilter = el.dataset.filter; render()` | `messages.js:217` `onFilter(event)`：只切本地视图，**不重新请求** | 同「本地筛选、不重排数据」 |
| `:73` `.message-list` / `.message-row` / `.message-icon` / `.message-copy` / `.unread-dot` | `messages.wxml:72` `.message-list`、`:73` `.message-row`、`:74` `.message-icon`、`:75` `.message-copy`、`:76` `.unread-dot` | 行内未读点保留 |

### 3.2 与 demo 的口径差异（**需裁定**）

- demo 只有 `全部/互动/系统` 三档（`:73`）；派单要求「全部／未读」。
- 本片落**四档**：`全部／未读／互动／系统`。理由：两条要求都指向真实可用的筛选，且都能用契约字段落地——
  `Message.type` 是闭集 `comment|like|moderation|system`（`messages.js:21-26` `TYPE_LABELS`），
  「互动」= `comment`+`like`、「系统」= `moderation`+`system`，映射由契约类型决定，不是本地编造的分类。
- 只过滤**已加载**的消息（服务端游标分页，本地不重排、不补数据）；未命中时沿用 `state-view` 的 `empty`
  （`messages.wxml:66-70`），标题/说明带当前档位名（`filterLabel`），并说明这不是「服务端没有消息」。
- 「加载更多」只在「全部」档出现；其余档给一行说明（`messages.wxml:100`）。
- 已知**未取得**：`互动`／`系统` 两档在当前服务端没有生产路径（`services/api/src/community/events.ts:121`
  只发 `type: 'moderation'`），因此这两档今天只会命中审核结果或为空——**筛选本身是真实的**，但没有可演示的互动类消息。

---

## 4. 块 C：我的耕云（`pages/profile`）

| demo（`demo.html:74`） | 小程序 | 结论 |
| --- | --- | --- |
| `.stat` 三项，第三项 `data-action="my-posts"`（`S.posts.length`） | `profile.wxml:33` `<view class="stat" bindtap="openMyPosts" role="button" aria-label="…">`，值 `{{myPostCount}}` | **补上可点**；原为无 `bindtap` 的硬编码 `<text class="stat__value">0</text>`（0 是假数据，已弃用） |
| `:125` `case 'my-posts': modal('我的发布', …)` | 无独立页 ⇒ 跳既有社区 Tab 并预选「我的投稿」 | 契约既有 `GET /posts?mine=true`（`utils/community-api.js:208-219`）；`profile.js:78` `openMyPosts()` → `navigation.requestCommunityMine()` → `community.js:51` `consumeCommunityMine()` 后 `setData({ filterMine: true })` |
| `关于这次体验` 面板（`:74`） | `profile.wxml:142-159` 新增 section：`耕云 Demo`／`Demo 阶段`、`耕云 · 看见田间的可能`、覆盖说明、`demo-caption` | **补上**，措辞按小程序实测（登录走微信登录、档案/收藏/历史走服务端），不照抄 demo 的「均为本地模拟」 |
| `data-action="reset"`（`demo.html:74`，`:126` 弹窗） | **未加** | 小程序无演示模式、本地无演示数据可清（`git grep -n "demoMode\|DEMO_MODE\|isDemo\|demo 模式" -- miniprogram` = 0 命中）；见 §7 未取得项 |
| `data-action="toggle-voice"`（`demo.html:74`，`:119` 切换） | **未加** | 有 TTS 合成能力（`utils/voice-api.js` `createSynthesis`），但**没有**「回答就绪即自动朗读」的既有触发点；加开关＝无消费方的假开关 |
| `v1.0`（demo 静态串） | 写「Demo 阶段」 | `miniprogram/project.config.json` 无 `version` 字段，写具体版本即伪造 |

Tab 页 `switchTab` 不接受查询参数，故用 `utils/navigation.js:98-103` 的**一次性进程内意图**（`requestCommunityMine` / `consumeCommunityMine`，不落存储，读完即清），与既有 `returnTo` 同口径。

---

## 5. 块 D：首页（`pages/home`）

| demo（`demo.html:59` `home()`） | 小程序 |
| --- | --- |
| `.home-bottom` 第一个 `.panel` 的 `.panel-head`：`<h2>田间知识，一点点积累</h2>` + `link('查看资料库 →','library')`，即 `<button class="text-btn" data-route="library">` | `home.wxml:47-56` `panel-head` 内新增 `<button class="text-btn" bindtap="goKnowledge">查看资料库 <view class="gy-icon gy-icon--arrow"></view></button>`；落到既有 `pages/knowledge/knowledge`（与下方「科普知识」info-row 同一 handler） |
| `.home-bottom` 第二个 `.panel`：`今天的探索` + `示例记录` + `.mini-timeline`（三条写死） | **不做**：无数据源（audit §4 判卡点），不做假时间线 |

样式复用既有 `.text-btn`（`styles/components.wxss:155`，`min-height: var(--tap-min, 44px)`）与 `.gy-icon--arrow`，未新增类、未新增样式。

---

## 6. 门禁读数（worktree，逐块与终态）

| 门禁 | 基线 `de66803` | A `c664435` | B `37233a9` | C `2184ccd` | D `7d82606`（终态） |
| --- | --- | --- | --- | --- | --- |
| `node --test tests/ui-demo-align.test.mjs` | 7/7 pass | 10/10 pass | 10/10 pass | 10/10 pass | **10/10 pass，fail 0** |
| `node tools/demo-align.mjs` | PASS | PASS（新增 11 视图／9 有页／2 白名单） | PASS | PASS | **PASS，exit 0** |
| `npm run test:mini` | PASS 5/5 | 未跑 | 5/5 | 5/5 | **tests 5 / pass 5 / fail 0** |
| `npm run test:docs` | PASS 4 通过/0 失败 | PASS | PASS | PASS | **4 通过 / 0 失败 / 4 legacy 已钉住，exit 0** |
| `npm run lint` | PASS 三条 | PASS | PASS | PASS | **PASS 三条，exit 0** |
| `git diff --check`（工作树＋`HEAD`） | 0 | 0 | 0 | 0 | **均为 exit 0** |
| `node --check` 改动 JS | — | — | pass | pass | pass |

四块功能提交（`git log --oneline -4 7d82606`；本页的文档修订提交在其之上）：

```
7d82606 feat(GY-I28): 首页补 demo 的「查看资料库」按钮 (Refs #28)
2184ccd feat(GY-I28): 我的耕云补「我的发布」入口与「关于这次体验」(Refs #28)
37233a9 feat(GY-I28): 消息页补「全部已读」与 demo 筛选 chips（全部／未读／互动／系统）(Refs #28)
c664435 fix(GY-I28): demo 对齐门禁补盲 —— video/chat 改为显式的「允许缺失视图白名单」(Refs #28)
```

---

## 7. 未取得项（逐条，含实测原文）

1. **微信开发者工具编译**：本机未安装。实测：
   ```
   PS> & "C:\Program Files\Tencent\WeChat DevTools\cli.bat" --version
   & : 无法将"C:\Program Files\Tencent\WeChat DevTools\cli.bat"项识别为 cmdlet、函数、脚本文件或可运行程序的名称。
   请检查名称的拼写，如果包括路径，请确保路径正确，然后再试一次。
       + CategoryInfo          : ObjectNotFound: (C:\Program File…evTools\cli.bat:String) [], CommandNotFoundException
       + FullyQualifiedErrorId : CommandNotFoundException
   ```
   `C:\Program Files\Tencent` 下只有 `QQNT`（QQ），无 WeChat DevTools。故 **WXML/WXSS 未经过编译器校验**。
2. **真机渲染与截图**：无设备、无开发者工具 ⇒ 未取得。`npm run test:mini` 自身也只声明
   `PASS: native JSON/routes, five empty tabs, shared domain check and JS syntax. Not a WeChat compiler or device test.`
   `node tools/demo-align.mjs` 末行同样写 `未覆盖：微信开发者工具／模拟器／真机渲染与截图（本片未取得）。`
3. **`互动`／`系统` 两档的演示数据**：服务端只发 `type: 'moderation'`（`services/api/src/community/events.ts:121`），
   这两档今天只会筛到审核结果或为空；未伪造消息填充。
4. **「重置演示数据」**：小程序无演示模式、无本地演示数据可清（`demoMode|DEMO_MODE|isDemo|demo 模式` 在 `miniprogram` 零命中），按「不存在则不加」未实现。
5. **「问答自动朗读」开关**：无「回答就绪即自动朗读」的既有触发点，按「只有既有能力才接」未实现。
6. **视觉走查**（间距/字号/断点观感）：只在 CSS 令牌与类名层面被门禁核对，未做截图比对。
7. **文档漂移**：`docs/ui-state-inventory.md:78-81/90/155-156/169` 记「104 条类映射」「7 项 PASS」，
   本片测试数改为 10、视图组新增 1 组；该文件不在本次允许改动范围内，**只登记不改**。
8. **「今天的探索」时间线**（`demo.html:59` 的 `.home-bottom` 第二个 `.panel`：`<h2>今天的探索</h2>` +
   `<span class="pill gray">示例记录</span>` + `.mini-timeline` 三条写死文案「完成一次田间观察」「读懂标签上的信息」
   「看见二十年后的想象」）：**未实现**，按派单「无数据源则不做、不做假时间线」。边界与依据：
   - **小程序没有这个数据源**：`git grep -l 探索记录 upstream/main -- miniprogram` = **0 个文件**；
     历史接口是 `miniprogram/utils/history-api.js:193` 的 `listHistory(cursor, limit)`（`GET /history`，
     `PAGE_LIMIT_MAX = 50` 见 `:35`），只有游标与条数两个参数，**没有「今天」或任何日期区间的查询语义**，
     返回字段见 `history-api.js:29` `['id','revision','kind','target_ref','job_state','reference_state','created_at']`。
     照 demo 渲染这条时间线，只能由前端从历史流里自造「今天」口径、再补三条叙事文案 —— 属伪造数据源，红线禁止。
   - **audit 同样记为卡点**：`audit-demo-parity-20261018.md:63`（H1「无该块；`mini-timeline` 类仅在
     `components.wxss`」，判「结构性」）与 `:160`（`git grep -l 探索记录 upstream/main -- miniprogram` = 0
     →「需先定数据源，再补 Demo 示例口径」）。
   - **样式已在、无消费方**：`.mini-timeline` 定义于 `miniprogram/styles/components.wxss:608`（注释见 `:607`
     `/* demo .mini-timeline / .timeline-item */`），`.library-grid` 见 `:909`；两者在 `miniprogram/pages/*/*.wxml`
     命中 **0** 处（audit `:140` 把「类在样式层、页面不用」列为盲区 2）。故补时间线**不差样式**，差的是数据与口径；
     门禁只核对类名存在，并不核对页面是否真的用它。
   - **关闭它需要的输入**：①一个带日期语义、含空态的「今日动作」聚合来源（服务端接口或本地既有能力，不能前端拼）；
     ②三条文案的正式口径（demo 的「示例记录」徽标说明它们是原型占位，不能直接抄进小程序当真实数据）。
     本次不加空壳占位块、不写死示例条目；渲染侧另无开发者工具与真机可验证（见第 1、2 条）。

---

## 8. 结论边界

- **本页不构成 #28 关闭。** #28 的关闭需要：真机／开发者工具编译与渲染证据、消息页与我的耕云的人工走查、
  「互动／系统」两档有真实数据可演示（或明确裁掉这两档）。
- 本页可被复核的部分仅限：四块改动内容、上表门禁读数（均可在本 worktree 重跑复现）、
  §7 列出的未取得项与实测错误原文。
