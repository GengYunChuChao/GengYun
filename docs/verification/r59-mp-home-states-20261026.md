# R59 小程序首页多态（loading / 空 / 出错 / 游客 / 离线）现状证据页

2026-10-26（UTC+8）。分叉基线 `f6c5866d`（本片 `git fetch` 时的 `origin/main`，与派单预期基线一致），分支 `feat/gy-r59-mp-home-states`。取证期间 `origin/main` 前进到 `d16a2178`（PR #615，只动 `docs/architecture/`，未触及 `miniprogram/`、`tests/`、`services/`），本片结论不受影响，合入时按新基线 rebase 即可。

本页只做两件事：把首页多态的**现状**钉成可机读断言，并如实登记发现的缺口。**本轮不修任何缺口**，`现状缺口` 标记的条目是「今天代码确实如此」，不是期望行为，派工另行安排。

方法：静态读源码 + 计数式检索（把「有没有」变成可复跑的数字），不运行小程序运行时。断言落在 `tests/unit/miniprogram-home-states.test.mjs`。

## 一句话结论

**首页正文不取任何服务端数据**，所以 loading / 空 / 内容加载失败这三种多态在首页根本不存在；首页仅有的两处真实请求是「登录态核验」和「本地诊断自检」，前者失败与断网都归到同一个游客态，后者失败没有重试入口。

## 查了什么

- `miniprogram/pages/home/` 三个文件（`home.js` 112 行、`home.wxml` 126 行、`home.json` 5 行）。
- `miniprogram/utils/`：`auth.js`（619 行）、`debug.js`（31 行）、`states.js`（167 行）、`identify-api.js`（1069 行）。
- `miniprogram/components/state-view/`（`state-view.js` 175 行、`state-view.wxml` 23 行）——首页唯一的多态呈现组件。
- 全 `miniprogram/**` 的计数：`wx.request` / `timeout:` / `skeleton|spinner` / `onNetworkStatusChange|getNetworkType` / `previews` / `human_review_state` / `AUTH_REQUIRED`。

## 发现

### 1. 首屏没有 loading —— 因为首页没有首屏数据

`miniprogram/pages/home/home.js:29` 的 `data` 全是静态字段，`home.js` 全文 **0 处 `wx.request`**：hero、三张能力卡、底部资料入口都是写死内容。全页唯一的 `status="loading"` 在开发工具块内（`miniprogram/pages/home/home.wxml:97` 的 `wx:if="{{local}}"` → `miniprogram/pages/home/home.wxml:111-116`），只有 `runtime.mode === 'local'` 且小程序 `envVersion === 'develop'` 才可见（`miniprogram/utils/debug.js:3-6`）。

全仓 `miniprogram/**/*.wxml|wxss` 里 `skeleton|spinner` **0 处**：没有骨架屏、没有转圈，进度只用 `state-view` 的 `⏳` 文案。

`home.wxml` 里 `status="` 恰好 3 处，出现顺序固定为 `stub`（`miniprogram/pages/home/home.wxml:90-94` 常驻的「演示与走查状态」）、`loading`、`error`；**没有 `empty`、没有 `guest`、没有 `denied`**。

### 2. 失败有文案，但没有重试入口

首页唯一的错误态是本地诊断失败：`miniprogram/pages/home/home.wxml:117-122` 的 `wx:elif="{{diagPassed === false}}"` + `title="本地诊断没有通过"` + `desc="{{status}}"`。文案逐字来自 `miniprogram/utils/debug.js:23-28`（契约不符 / 连接成功 / 连接失败三句），页面不改写、不吞。

但这个 error 态**没有任何按钮**：`miniprogram/components/state-view/state-view.js:52-57` 的 error 预设自身 `actionText: ''`，`home.wxml` 也不传 `action-text`、不绑 `bind:action`（两个属性在首页 wxml 里各 0 处）；而 `miniprogram/components/state-view/state-view.wxml:14-19` 只在 `resolvedAction` 非空时才渲染按钮。⇒ **现状缺口**：用户看到「本地诊断没有通过」只能自己去再点一次原按钮，没有「重试」语义。

### 3. 空态与错误态：组件层可分，首页层不可分

组件层是三套不同文案，能区分：`empty` = `📭` / `没有找到相关资料`（`miniprogram/components/state-view/state-view.js:40-45`）、`error` = `⚠️` / `操作没有成功`（`miniprogram/components/state-view/state-view.js:52-57`）、`loading` = `⏳` / `正在处理`（`miniprogram/components/state-view/state-view.js:46-51`）。

首页层一条都没有：首页没有任何 `status="empty"`。

服务端其实是**分得开的**：`tests/unit/public-home.test.mjs:25-33` 钉住「真库查询成功但没数据」= 200 + `{previews: [], human_review_state: 'under_construction'}`；`tests/unit/public-home.test.mjs:9-23` 钉住 DB 缺失 / 非 `real` 模式 = 503 `PROVIDER_UNAVAILABLE`；`tests/unit/public-home.test.mjs:35-43` 钉住语句超时 = 504。

端上把 `data` 整个丢掉了：`miniprogram/utils/identify-api.js:788-789` 只用 `keys()` 校验封套键集，然后 `resolve(validateMeta(r.data.meta))` —— 只回传 `meta`（执行模式），`data.previews` 与 `data.human_review_state` 在**整个 `miniprogram/**` 里 0 次引用**。唯一的调用方是识别页与播报页（`miniprogram/pages/identify/identify.js:344`、`miniprogram/pages/identify/identify.js:420`、`miniprogram/pages/voice/voice.js:948`），**首页不是调用方**。⇒ **现状缺口**：服务端做好的空/错区分，在首页完全用不上。

### 4. 游客态：默认态、文案固定、跳登录统一

`guest: true` 是初始值（`miniprogram/pages/home/home.js:29`）。`onShow` 先无条件按游客渲染一行（`miniprogram/pages/home/home.js:34`，避免首帧闪已登录），再核验：`miniprogram/pages/home/home.js:35-39` 收到结果后仍要复查 `_active` 与 `_action`（`miniprogram/pages/home/home.js:36`）才 `setData`。

游客可见：徽标 `游客仅可预览首页`（`miniprogram/pages/home/home.wxml:15`）、登录按钮 `微信登录`（`miniprogram/pages/home/home.wxml:21`）。受控入口恰好 5 处 `openGated`（`miniprogram/pages/home/home.js:63`、`:64`、`:66`、`:67`、`:68`），未登录统一弹同一句：`需要登录` / `该功能需要微信登录后使用，现在去登录吗？` / `去登录` / `暂不`（`miniprogram/pages/home/home.js:92-100`），取消与失败都清 `returnTo`（`miniprogram/pages/home/home.js:97`、`miniprogram/pages/home/home.js:99`）。

错误码映射表**存在且取值精确**：`miniprogram/utils/states.js:25-63` 的 `CODE_KIND`（如 `SESSION_REQUIRED: 'session'` 在 `miniprogram/utils/states.js:31`、`PROVIDER_UNAVAILABLE: 'unavailable'` 在 `miniprogram/utils/states.js:55`），可重试性在 `miniprogram/utils/states.js:82-91`（`session: false`，注释写明「需要重新登录，不是重试」）。但**首页不消费这张表**：`home.js` 的 require 只有 4 个模块，不含 `utils/states`（`miniprogram/pages/home/home.js:1-4`），`home.wxml` 也没有 `error-code=` ⇒ **现状缺口**：首页对 `SESSION_REQUIRED` / `PROVIDER_UNAVAILABLE` 没有任何专门处理，全靠 `verified` 布尔值。

派单里举例的 `AUTH_REQUIRED` 在本仓**不存在**（`miniprogram/**` 与 `packages/contracts/openapi.json` 里均 0 次），真实会话码是 `SESSION_REQUIRED`。

### 5. 离线 / 断网：首页不可见，且与游客态同一副面孔

首页不发请求（见 §1），断网时首页与联网时长得一样。真正会失败的核验在 `miniprogram/utils/auth.js:375-384`：`fail` 分支只做 `serverVerified = false` + `done(false)`（`miniprogram/utils/auth.js:381-383`，注释「网络失败：不能核实，也不谎称已登录（门禁保持关闭）」）。而 401/403（`miniprogram/utils/auth.js:357-362`）同样 `done(false)`。两者都汇成 `guest: true`。⇒ **现状缺口**：同一块 UI 既表示「你是游客」也表示「网络挂了」，用户无法区分。

全仓 `miniprogram/**/*.js` 里 `onNetworkStatusChange|getNetworkType` **0 处**：没有任何页面在监听网络状态，断网不可能被识别成独立状态。

其它页的离线码确实存在（`miniprogram/utils/identify-api.js:796` 的 `fail` → `NETWORK_UNCERTAIN`），但 `CODE_KIND` 里没有这个码：`statusForCode` 对未知码一律回「通用失败」（`miniprogram/utils/states.js:123-129`），`retryableForCode` 回 `false`（`miniprogram/utils/states.js:132-135`）—— 也就是说离线被归成「不可重试」，与 `unavailable: true` 的口径相反（同缺失的还有 `INVALID_RESPONSE`，在 `states.js` 里 0 次、在 `miniprogram/**` 里 244 次命中）。⇒ **现状缺口**（记录，不在本轮修）。

### 6. 超时 / 重复点击 / 竞态

- **超时**：本地诊断 `5000`（`miniprogram/utils/debug.js:20`）；`/public/home` `15000`（`miniprogram/utils/identify-api.js:781`）。**`/auth/session` 没有 timeout**：`miniprogram/utils/auth.js:326-330` 的请求只有 `url` / `method` / `header` 三行；全仓 `timeout:` 共 18 处，`auth.js` 不在其中 ⇒ **现状缺口**：核验请求挂住时首页会一直停在游客态。
- **重复点击**：诊断入口首行 `if (this.data.busy) return`（`miniprogram/pages/home/home.js:104`），紧接着 `:105` 先清上一次结论再置 `busy: true`；按钮侧 `loading="{{busy}}"` + `disabled="{{busy}}"` 双闸（`miniprogram/pages/home/home.wxml:102-107`）。
- **竞态**：`_action` 自增 + `_active` 标志 + `current()` 闭包丢弃迟到回调（`miniprogram/pages/home/home.js:32`、`:43-44`、`:76`、`:78`）；会话核验自身还绑四重世代 `generation/token/intentEpoch/navigation`（`miniprogram/utils/auth.js:322-325`），迟到的成功响应不得复活旧会话（`miniprogram/utils/auth.js:331-335`）。
- **下拉刷新**：没有。`miniprogram/pages/home/home.json` 只有 `usingComponents`（无 `enablePullDownRefresh`），`home.js` 无 `onPullDownRefresh` ⇒ **现状缺口**：游客想重新核验登录态只能切页触发 `onShow`。

## 断言了什么

`tests/unit/miniprogram-home-states.test.mjs`，19 条（原 17 条 + `#617` 审查后补的 L3 / X1，见文末「补记」），`node --test` 全绿。阈值全部写精确值（整行/整句相等或精确正则），没有 `includes('失败')` 这类松断言。

| 断言 | 钉住的事实 | 负控制 |
| --- | --- | --- |
| L1 | 首页 0 处 `wx.request`；`status="` 顺序恰为 `stub,loading,error`；loading 在 `wx:if="{{local}}"` 之后；无 `skeleton\|spinner` | — |
| L2 | 诊断按钮 `bindtap="diagnose"` + `loading`/`disabled` 双闸；loading 标题/描述逐字 | — |
| L3 | loading 分支的**门控** `wx:if="{{busy}}"` 与所在块逐字（`<state-view>` / 门控 / `status` / `title` / `desc` / 收尾）；门控全页恰 1 处；五个位置锚点各恰 1 次且顺序严格递增；三分支在 local 块内收尾 | NC9 / NC10 |
| E1 | error 态存在且文案逐字；**缺失钉**：首页不传 `action-text` / `bind:action` | NC7 |
| E2 | `debug.js` 四句回调文案逐字 + `diagPassed: passed === true` | — |
| S1 | `empty` / `error` / `loading` 三套图标+标题互不相同；error 预设 `actionText` 恰为空串 | NC3 |
| S2 | 首页无 `status="empty"`；三个文件都不含 `previews` / `human_review_state`；`/public/home` 请求含 `timeout: 15000` | — |
| G1 | `guest: true` 初值整行；徽标与登录按钮两行 wxml；`onShow` 两处 `setData` 整行 | NC2 |
| G2 | 登录弹窗三行文案逐字；取消/失败清 `returnTo`；`openGated(` 恰 5 处 | — |
| O1 | 首页无 `wx.request`；全仓网络状态监听为空集；`auth.js` 网络失败分支注释与两行 | — |
| O2 | 非 200 分支只置 `serverVerified = false`；`verifySession` 体内 `clearSession()` 恰 2 处；401/403 与 200 两处判定 | — |
| T1 | 本地诊断 `timeout: 5000`；`/auth/session` 请求块**不含** `timeout` | NC1 / NC4 |
| R1 | `_action` 自增 + `_active` + `current()` + `if (!current() \|\| stale) return` + `onHide` 两行 | — |
| R2 | `diagnose` 首行 busy 提前返回且随后清结论；`home.json` 无 `enablePullDownRefresh`；无 `onPullDownRefresh` | NC5 |
| R3 | `auth.js` `stale()` 四重世代正则；迟到成功响应注释 | — |
| C1 | 码表六条精确映射 + `session: false` / `unavailable: true`；`AUTH_REQUIRED` 在 `states.js` 与契约里都 0 次 | NC6 |
| C2 | 首页不 require `utils/states`、不含 `errorCode`；wxml 无 `error-code=`；require 清单恰为 4 个精确路径 | — |
| M1 | `home.json` 声明 `state-view`；常驻 `stub` 标注标题/描述逐字 | — |
| X1 | 三态互斥显式化：三个 `<state-view>` 的状态值序列恰为 `stub → loading → error`；loading 起的三个兄弟恰为 `state-view[wx:if="{{busy}}"] → state-view[wx:elif="{{diagPassed === false}}"] → view[wx:else]`（元素名 / 指令名 / 条件值三元组逐个相等）；两处相邻兄弟正则；全页 `wx:elif=` / `wx:else` 各恰 1 处；数据侧 `busy` 与 `diagPassed` 只被两处 `setData` 整行同时写 | NC11 / NC12 |

## 负控制（7 条，全部在仓库外临时树手工验证）

做法：把 `miniprogram/`、`packages/contracts/openapi.json`、本测试文件复制到仓库**外**的临时目录（`$env:TEMP`），先跑一遍确认 17/17 绿，再每次只改坏一处 → 跑 `node --test` → 记录红在哪条 → 从 pristine 副本复原。全程没有触碰 `E:\GengYunCommander\GengYun_Agent2` 主 checkout。

| 编号 | 改了哪一行（改前 → 改后） | 红在哪条 | 失败信息 |
| --- | --- | --- | --- |
| NC1 | `miniprogram/utils/debug.js:20` `timeout: 5000` → `6000` | T1 | `AssertionError [ERR_ASSERTION]: The input did not match the regular expression …` |
| NC2 | `miniprogram/pages/home/home.wxml:15` `游客仅可预览首页` → `游客可预览` | G1 | 同上（正则不匹配） |
| NC3 | `miniprogram/components/state-view/state-view.js:43` `title: '没有找到相关资料'` → `'操作没有成功'` | S1 | 同上（empty 与 error 撞成一句） |
| NC4 | `miniprogram/utils/auth.js:327-329` 给 `/auth/session` 请求**新增** `timeout: 15000,` | T1 | 同上（证明「没有 timeout」这条缺失钉真的会咬） |
| NC5 | `miniprogram/pages/home/home.js:104` 删掉 `if (this.data.busy) return` | R2 | `AssertionError [ERR_ASSERTION]: The input did not match the regular expression /diagnose: function \(\) \{\n\s+if \(this\.data\.busy\) return\n\s+this\.setData\(\{ busy: true, diagPassed: null, status: '正在连接本地诊断服务…' \}\)/` |
| NC6 | `miniprogram/utils/states.js:55` `PROVIDER_UNAVAILABLE: 'unavailable'` → `'throttled'` | C1 | `AssertionError [ERR_ASSERTION]: The input did not match the regular expression /PROVIDER_UNAVAILABLE: 'unavailable'/` |
| NC7 | `miniprogram/pages/home/home.wxml:119-120` 给 error 态新增 `action-text="重试"` | E1 | `AssertionError [ERR_ASSERTION]: 首页当前不传 action-text` |

7 条全部按预期变红，复原后复跑 17/17 绿。NC4 / NC7 是「反向负控制」：故意补上一个**缺口本来就不具备**的能力，断言同样变红 —— 这样缺口记录不会随着将来补功能而静默失效，补了就必须回来改断言和本页。

**NC8（针对行号闸门本身，不是断言）**：临时在本页末尾追加一行假锚点（把首页脚本的行号写成 `99999`），`node tools/verify-doc-anchors.mjs --strict` 随即 `exit 1`，报 `OUT_OF_RANGE`（指向本页新增那一行，拒绝理由「行号超出文件行数（该文件 112 行）」），基线外新增 1 条；删掉该行后复跑 `exit 0`、基线外新增 0 条。这证明本页确实被行号闸门扫到（而不是因为不在扫描面而被静默放过），也证明本页所有 `文件:行号` 都是真锚点。上表 NC1–NC7 的每一行改动同样被扫过、每一条都指得回原文件。

## 门禁读数

环境：Windows，Node `v24.16.0`，npm `11.13.0`，worktree `wt-r59-mpstates` 基于 `f6c5866d`。下表是**那一版**（17 条断言）的读数：`#617` 合并后的新读数记在文末「补记」，两套数并存是有意的 —— 旧数不改成新数，新数也不回填旧表，各自绑定自己的 base。

| 命令 | 读数 | 结论 |
| --- | --- | --- |
| `node --test tests/unit/miniprogram-home-states.test.mjs` | `tests 17` / `pass 17` / `fail 0` / 166ms | exit 0 |
| `npm run test:unit` | `tests 4793` / `pass 4790` / `fail 0` / `skipped 1` / `todo 2` / 111s | exit 0 |
| `node tools/verify-doc-anchors.mjs --strict` | 文档 291 份、引用 5263 条；`BROKEN 4 / OUT_OF_RANGE 2 / SUSPECT 7` 全部落在基线内，基线外新增 0 | exit 0 |
| `node tools/verify-contract-status.mjs` | 118 条契约操作全装配、形状错误 0、语义错误 0、证据锚点 528 条 | exit 0 |

`test:unit` 的 1 条 skip 是既有用例 `native separate-connection withdrawal and account state changes at guarded read boundary`（原生独立连接，与本片无关），不是本片引入。

**环境事实（如实记录，未改测试迁就）**：新 worktree 一开始没有 `node_modules`，首跑 `npm run test:unit` 是 `tests 3484 / pass 3328 / fail 154`，154 个失败文件的首因全是 `ERR_MODULE_NOT_FOUND`（`fastify` 86 次、`pg` 31 次、`@electric-sql/pglite` 8 次、`typescript` 2 次），与首页多态无关。随后 `npm ci --prefer-offline` 装齐依赖（103 个包，5s，`node_modules/` 已在 `.gitignore`），复跑得 0 fail。两次读数都记在这里，不隐藏第一次。

## 没覆盖 / 不确定

- **没有跑小程序运行时**：本页所有结论都是静态文本/结构事实。`state-view` 在真机上的实际渲染、`wx.request` 的真实超时与重试行为、微信开发者工具的编译结果，均未验证。
- `wx.request` **默认超时**（微信文档为 60s）在 `auth.js` 缺 `timeout` 时的实际影响未实测，本页只钉「没有显式 timeout」这个代码事实，不外推为「一定会挂 60 秒」。
- 只覆盖首页与 `state-view`、`utils/*` 的静态形态；其余页面（识别 / 播报 / 知识 / 资料 / 资料种子）的多态没有逐页取证，只把 `openGated` 的 5 个调用点计数。
- `NETWORK_UNCERTAIN` / `INVALID_RESPONSE` 未进 `CODE_KIND` 是**检索计数**结论（`states.js` 里 0 次、`miniprogram/**` 里 29 / 244 次），没有逐页核对这些码最终渲染成什么文案。
- 本轮不评估无障碍与适老（属后续阶段），也不评估真机验收。
- 「首页应该有首屏数据」本身是产品判断，不在本轮：本页只记录「首页当前不取数据，因此三态不存在」这一事实。

## 补记：`#617` 独立审查指出的两处覆盖缺口

`#617` 的独立审查用两条负控制（N3 / N4）证明：上表之前的 17 条断言**没有**把「loading 的门控」和「三态互斥」钉住 —— 把 `miniprogram/pages/home/home.wxml:112` 的 `wx:if="{{busy}}"` 改成 `{{true}}`、或把整行删掉、把 `miniprogram/pages/home/home.wxml:118` 的 `wx:elif` 改成 `wx:if`、把 `miniprogram/pages/home/home.wxml:119` 的 `status="error"` 改成 `status="failed"`，原 17 条仍全绿（原 L1 只钉 `status="loading"` 的**存在与顺序**，E1 只用一条 `wx:elif` 字面正则间接沾到互斥，都不涉及门控条件本身）。补 L3 / X1 两条后文件是 19 条；上文 17/17 与 NC1–NC8 的读数属于 `f6c5866d` 那一版，按要求未改写。

L3 / X1 的判据已在上面两张表里各占一行，这里只记取舍与负控制：

- 取舍：钉的是**结构**（元素名 / 属性名 / 属性值 / 兄弟顺序 / 出现次数），不看缩进宽度、不看重排属性顺序、不看多余空行 —— 「实现没变但格式微调」基本不误红。而 `{{busy}}` 换成任何等价写法（`{{!!busy}}`、`{{busy === true}}`、`{{1}}`、`{{true}}`）都会红，这是**有意**的：门控表达式本身就是被审查的那件事，等价改写必须回来改断言和本页。这些取舍也写进了测试文件的头注释。
- 做法：把 `miniprogram/`、`packages/contracts/openapi.json`、本测试文件复制到仓库外的 `%TEMP%\r59mp-neg`，配一个只按参数改一行的注入器；副本先跑一遍 19/19 绿，每次只注入一处 → 跑 `node --test` → 记红在哪条 → 从 pristine 副本复原（复原后复跑 19/19 绿）。全程没有触碰任何 checkout。

| 编号 | 注入（改前 → 改后） | 红在哪条 | 失败信息首行 |
| --- | --- | --- | --- |
| NC9 | `miniprogram/pages/home/home.wxml:112` `wx:if="{{busy}}"` → `wx:if="{{true}}"` | L3、X1 | `AssertionError [ERR_ASSERTION]: loading 的 state-view 必须整块逐字带着 wx:if="{{busy}}" 门控`（X1：`必须找到 busy 的 loading 分支`） |
| NC10 | `miniprogram/pages/home/home.wxml:112` 整行删除 | L3、X1 | 同 NC9 的两条首行 |
| NC11 | `miniprogram/pages/home/home.wxml:118` `wx:elif` → `wx:if` | L3、E1、X1 | `五个位置锚点各恰好出现一次`（L3）；E1：`The input did not match the regular expression /wx:elif="\{\{diagPassed === false\}\}"/` |
| NC12 | `miniprogram/pages/home/home.wxml:119` `status="error"` → `status="failed"` | L1、E1、X1 | `首页的 state-view 位置与顺序是写死的三处`（L1）；E1：`The input did not match the regular expression /status="error"/` |

四次注入全部 `exit 1`：NC9 / NC10 是 tests 19 / pass 17 / fail 2，NC11 / NC12 是 tests 19 / pass 16 / fail 3。NC9 正是审查者指出此前会**误绿**的那一个，现在 L3 与 X1 同时咬住；NC11 / NC12 顺带把既有的 E1 与 L1 一起拉红，说明新断言与旧断言在同一个结构上互相印证而不是互相替代。

**本片读数（worktree `wt-r59-mpbusy`，基线 `da0b3003`，Windows / Node `v24.16.0` / npm `11.13.0`）**

| 命令 | 读数 | 结论 |
| --- | --- | --- |
| `node --test tests/unit/miniprogram-home-states.test.mjs` | `tests 19` / `pass 19` / `fail 0` / 174ms | exit 0 |
| `npm run test:unit`（`GY_BASH=D:\Git\bin\bash.exe`） | `tests 4801` / `pass 4798` / `fail 0` / `skipped 1` / `todo 2` / 200s | exit 0 |
| `node tools/verify-doc-anchors.mjs --strict` | 文档 294 份、引用 5439 条；`BROKEN 4 / OUT_OF_RANGE 2 / SUSPECT 7` 全部落在基线内，基线外新增 0 | exit 0 |

相对上一段「门禁读数」的 `f6c5866d` 一版，套件条数 4793 → 4801（本片 +2，其余 6 条来自这两次基线之间的上游提交），skip 仍是同一条原生用例。

**引用条数为什么不变**（`da0b3003` 基线 + L3 / X1 那次复跑是 5439 条，与改动前完全一致）：原因不是本页原文说的「被 `home.wxml:111-116` 等范围引用覆盖」—— 那一条是错的，此处更正：本页所有 `*.wxml:行` 引用**根本不在锚点闸门的扩展名白名单里** —— `tools/verify-doc-anchors.mjs:45-48` 的 `ANCHOR_EXTENSIONS` 只认 `.mjs/.cjs/.js/.jsx/.ts/.tsx/.json/.jsonc/.sql/.md/.yml/.yaml/.css/.html/.py/.sh/.ps1/.toml`，**没有 `.wxml` / `.wxss`**（`html` 在，`wxml` 不在），所以 `home.wxml:112` 这类引用既不进抽取、也不进闸门。探针实证（改完即复原，未提交）：把本页 4 处 `home.wxml:112` 全改成越界的 `home.wxml:999`，读数一字不变（仍 5439 条引用、13 条基线内命中、exit 0）；同一个探针换成一条 `.ts` 假锚点（`services/api/src/definitely-missing-file.ts` 第 42 行），立刻 `BROKEN 4 → 5`、基线外新增 1、exit 1。⇒ 本页的 wxml 行号靠**人工逐条核对**，不是闸门保证的；好在 L3 / X1 的判据是全文正则（`wx:if="{{busy}}"` 这一行在文件里长什么样），不按行号定位，所以行号漂移不会让断言假绿。将来若要给 `miniprogram/**` 的行号上闸门，得先把 `wxml` / `wxss` 加进那份白名单（本节这次更正自己在上文新增了 1 条 `.mjs` 引用，所以更正后复跑是 5440 条；上面表格里的 5439 是那次交付的读数）。
