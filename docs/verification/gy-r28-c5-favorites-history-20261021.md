# GY-I16（#16）收藏与可浏览的识别历史 · C5 端到端接线盘点与修复

- 任务：C5 / Refs #16（不 Closes；#16 的四条验收复选框仍由整套交付共同判定）
- 分支：`feat/gy-r28-c5-favorites-history`，基点 `43fa6d5`
- 说明：本文是**本机静态与合成读数**。真实 WeChat 开发者工具 / 真机 / 真实登录 / 真实识别与 OCR 供应商 / 真实 PG17 服务器**均未取得**，一律记为「未取得」，不据此放宽任何验收。

## 1. 结论摘要（三段判定）

| 面 | 判定 | 一句话 |
| --- | --- | --- |
| 服务端 `services/api/src`（收藏） | **已通** | 三条路由走 PG store（迁移 0018），归属/去重/物理删除/逐次可见性重查齐备；real 模式无 pool 时整域 503，不用内存 Map 冒充持久化 |
| 服务端（历史） | **已通** | 识别/OCR 终态由 `recordHistoryTerminal` 写入（确定性 `event_key` 幂等），列表游标分页、删除走 CAS |
| 契约 `packages/contracts/**`（只读） | **半通** | 五个 operation 与实现一一对应；**没有** `GET /favorites/{id}`、也没有 `GET /history/{id}`，详情只能靠列表 + `GET /recognitions/{id}` / `GET /ocr/{id}` 组合（契约面如实登记，本次不动） |
| 小程序（收藏页 / 历史页 / 历史详情） | **已通（本次修 403）** | 页面齐全、状态组件齐全；但 401 与 403 在消费层被折叠成同一件事，denied 状态永远渲染不出来 —— 本次修好 |
| 小程序（识别结果页「收藏」） | **未通（缺口，本次不实施）** | `identify.wxml` / `identify.js` 里「收藏」与 `favorit` 两处关键词**零命中**：识别结果页没有收藏入口，只能经「识别 → 资料详情 → 收藏」两跳 |
| 小程序（识别结果页「写历史」） | **已通** | 写入点在服务端终态端口（不在页面）；页面侧提供 `onOpenServerHistory` 跳 `/pages/history/history` |

> **后续变更（2026-10-28 订正；本页其余读数一律保留 2026-10-21 基线，不改写）**：本页写于
> `feat/gy-r28-c5-favorites-history`（基点 `43fa6d5`）。上表「小程序（识别结果页「收藏」）」那一行
> 的判定**已被后续片推翻**，请按下面的事实读，原文不删：
>
> - **现在的事实：识别结果页有收藏入口**，形态是**自包含组件**。宿主侧只有一行挂载
>   `<fav-entry wx:if="{{job.id && job.state === 'succeeded' && !guest}}" job-id job-state enabled />`
>   （`miniprogram/pages/identify/identify.wxml:221`），组件注册在 `miniprogram/pages/identify/identify.json:4`，
>   装配逻辑全在 `miniprogram/components/fav-entry/fav-entry.js`。它调的正是本页已登记的那两个接口：
>   `POST /favorites`（`createFavorite`，`fav-entry.js:223`；`target_ref.type` 只取契约闭集里的 `species`）
>   与 `DELETE /favorites/{id}`（`deleteFavorite`，`fav-entry.js:240`）；`target_ref.revision` 现场从
>   `GET /knowledge/{id}` 取（`fav-entry.js:181`），取不到就整块不渲染（fail-closed），且只在作业
>   `succeeded` 时装配。
> - **由谁引入**：`#430`（squash `81bf0a2b`，2026-10-22 合入 main，同一提交里另有「收藏入口按宿主作业状态收敛」
>   的返修）。**不是本片**：C5 当时确实没做，`identify.wxml`／`identify.js` 对 `收藏|favorit` 零命中这个
>   **测量本身没错**——错的是把它读成「识别结果页没有（也不会有）收藏入口」的结论。
> - **同页另有四处同一断言，一并按上面读**：§1 表「识别结果页『收藏』」行、§4 末条
>   （「**识别结果页没有收藏入口**」）、§6 第 3 条（「identify 页当前完全不依赖 `knowledge-api`」——
>   现在经 `fav-entry.js` 依赖 `miniprogram/utils/knowledge-api.js`）、§7 第 1 条（「识别结果页『收藏』入口（未通）」）。
>   这四处的原文保留为当时读数。
> - **§7 第 2 条「全站同类折叠」也已被后续片做完**：五个适配层现在**都**把 401/403 归因委托给
>   `miniprogram/utils/auth.js:605` 的 `failureFor`（`attribution` 决定要不要清会话），不再各自
>   `clearSession`＋折成 `SESSION_REQUIRED`——`miniprogram/utils/community-api.js:190`、
>   `miniprogram/utils/knowledge-api.js:76`、`miniprogram/utils/messages-api.js:137`、
>   `miniprogram/utils/profile-api.js:23`、`miniprogram/utils/voice-api.js:213`。原文「仍是 401/403 折叠」
>   保留为 2026-10-21 读数（口径裁决见本页 §5.1 的 superseded 边界）。
> - **没有变的口径**：P0 链路第 5 步「收藏／取消」的入口仍是**两处**（详情页按钮＋收藏页「可收藏的资料」）；
>   识别页的 `fav-entry` **不计入**第 5 步（属识别能力、只收 `species`），裁定见
>   `docs/ui-state-inventory.md:282` 与 `docs/ui-state-inventory.md:308`。
> - 本页其余 `path:line` 仍是 2026-10-21 基线的读数，未随合流重取（合流后部分行号已漂移）；要引用请按符号回查。

## 2. 服务端面（证据）

### 2.1 收藏

- 路由：`services/api/src/routes/favorites.ts`
  - `:89` `app.get('/favorites', { preHandler: guards.requireUser, ... })`
  - `:94-104` `app.post('/favorites', ...)` → 201，`:104` `.header('ETag', strongEtagOf(data.revision))`
  - `:109-111` `app.delete('/favorites/{id}', ...)`
  - `:26` `const noStore = { 'Cache-Control': 'no-store' }`（私有响应一律 no-store）
  - `:84` `throw new ApiError('PROVIDER_UNAVAILABLE', '收藏持久存储尚未接线', { retryable: false })` —— `service === null` 时三条路由整域 503，**fail-closed**
- 服务层：`services/api/src/favorites/service.ts`
  - `:117` `function notFound()`：他人与不存在**逐字节同形**
  - `:67` `FAVORITE_PROJECTION_FIELDS`（恰 6 字段，无 used/usage ⇒ 收藏≠已使用）
  - `:91` `favoriteEligibleForRecommendation(view)` 仅 `reference_state === 'available'`
  - `:233` `project(record, userId)` 每次读取重新 `deriveVisibility`（不入库、不缓存）
  - `:306`/`:359`/`:426` `listFavorites` / `createFavorite` / `deleteFavorite`
  - `:57`/`:59` `CURSOR_TTL_MS` / `IDEMPOTENCY_TTL_MS`
- 落库（不是内存 Map）：`services/api/src/app.ts:1798` `favoritesService = config.executionMode === 'real' && !favoritesStore.persistent ? null : createFavoritesService(...)`；store 选择见同文件 store 装配处（`pool !== null ? createPostgresFavoritesStore(pool, { now }) : createMemoryFavoritesStore({ now })`），迁移 `services/api/db/migrations/0018_favorites_history.sql`。
- 已知运维缺口（上一片修好、本片未复验）：运行时角色对 `favorites`/`history` 等七张表曾整张零授权（`42501`），由 `deploy/postgres-cvm/sql/20-login-roles.sql` I 段修复，见 `docs/verification/gy-r28-favorites-history-grants-20261020.md`。

### 2.2 历史

- 路由：`services/api/src/routes/history.ts` `:80`（`GET /history`）、`:85-87`（`DELETE /history/{id}`）；`:36` no-store；`:75` `'历史持久存储尚未接线'` 503 fail-closed。
- 写入时机（识别完成时）：`services/api/src/app.ts:1025` `recordHistoryTerminal`，`:928-934` `recognitionTerminalHistory`、`:936-942` `ocrTerminalHistory`，`:961` `history: recognitionTerminalHistory` 注入识别服务 —— 终态提交成功后才写，real 模式历史域关闭时退回未接线端口（不写、不伪造）。
- 服务层：`services/api/src/history/service.ts:319` `listHistory`（游标分页）、`:369`/`:389` `deleteHistory`（`revision` + `owner_id` CAS）、`:426` `appendHistory`；`:125` `notFound()`；`:16` 归属不变式注释（他人历史与不存在同形）。
- 来源版本：历史行本身**不带**来源版本字段（`history-api.js` 的 `HISTORY_KEYS` 7 字段），来源版本由详情重新读取 `model_version` 提供 —— 见下 §4。

## 3. 契约面（只读，本次未改动一个字节）

`packages/contracts/openapi.json` 与 `packages/contracts/operations.json` 里 favorites/history 相关的**全部**五个 operation：

| path | method | operationId | 成功码 |
| --- | --- | --- | --- |
| `/favorites` | get | `listFavorites` | 200 |
| `/favorites` | post | `createFavorite` | 201 |
| `/favorites/{id}` | delete | `deleteFavorite` | 200 |
| `/history` | get | `listHistory` | 200 |
| `/history/{id}` | delete | `deleteHistory` | 202 |

- **没有 `GET /favorites/{id}`、没有 `GET /history/{id}`** ⇒ 任何「详情页」都必须由列表 + 目标详情组合而成，不得新增契约外路径。
- `x-error-status-map`：`401: [SESSION_REQUIRED, SESSION_EXPIRED]`、`403: [SCOPE_DENIED, CONSENT_REQUIRED, ACCOUNT_INACTIVE]`、`404: [NOT_FOUND]`、`409: [REVISION_CONFLICT, IDEMPOTENCY_CONFLICT, OBJECT_UNAVAILABLE, REQUEST_IN_PROGRESS]`、`428: [REVISION_REQUIRED]`、`503: [PROVIDER_UNAVAILABLE, PROVIDER_OUTCOME_UNKNOWN]`。
- 本片据此判断「401 与 403 是两档，不是一档」。

## 4. 小程序面

- 收藏页 `miniprogram/pages/favorites/favorites.js`：`GET /favorites` / `DELETE /favorites/{id}`；失败时清空列表并给 `errorText`（不保留旧列表、不折叠成空列表成功）。
- 历史页 `miniprogram/pages/history/history.js`：`GET /history` 分页，`failedCount` 真实统计失败任务，`historyApi.remember()` 只写定位快照。
- 历史详情 `miniprogram/pages/historydetail/historydetail.js`：先 `locateHistory`（实时列表优先，未命中即 `invalid:true`「不存在/已删除/不属于当前账号」），再用 `GET /recognitions/{id}` 或 `GET /ocr/{id}` 取详情；`recognitionDetailView` 的 `sourceVersion: recognition.model_version`（`miniprogram/utils/history-api.js:369`）、`ocrDetailView` 的 `sourceVersion: ocr.model_version`（`:426`），候选（`:356` `modelCandidates`）与人工选择（`:360` `manualSelection`）分列。
- 收藏入口现状：`pages/knowledgedetail/knowledgedetail.js` 就地收藏/取消（`createFavorite` / `deleteFavorite`，取消带 If-Match），`pages/favorites/favorites.js` 有「收藏 / 取消收藏」；**识别结果页没有收藏入口**（`identify.wxml` + `identify.js` 对 `收藏|favorit` 命中数 = 0）。

## 5. 本次实施内容（C5）

### 5.1 修：401 与 403 在收藏/历史消费层被折叠（唯一的端到端断点）

修复前：

- `miniprogram/utils/favorites-api.js:93`（旧）：`if (r.statusCode === 401 || r.statusCode === 403) { auth.clearSession(); reject(failure('SESSION_REQUIRED')); return }`
- `miniprogram/utils/history-api.js:164`（旧）：同一句。

后果（都可观测）：

1. 服务端真实 403（`services/api/src/favorites/validate.ts:65` / `services/api/src/history/validate.ts:68` 的后台会话拒绝、`services/api/src/auth/middleware.ts:89`/`:93` 的账号停用/epoch 不符）在页面上被说成「登录已失效」，并**静默清会话**。
2. `messageFor` 里早已写好的 `SCOPE_DENIED` 文案不可达（`favorites-api.js:182`、`history-api.js:395` 旧行号）。
3. B7 统一状态层 `miniprogram/utils/states.js` 把 `SCOPE_DENIED`/`CONSENT_REQUIRED`/`ACCOUNT_INACTIVE` 映射成 `denied`，而 `denied` 永远不会被这五个 operation 触发 —— 状态层白做了。

修复后：

- `miniprogram/utils/favorites-api.js:88` `const FORBIDDEN_CODES = ['SCOPE_DENIED', 'CONSENT_REQUIRED', 'ACCOUNT_INACTIVE']`；`:92` `function forbiddenOrSessionLoss(statusCode, payload)`；`:115` 调用点改为 `reject(forbiddenOrSessionLoss(r.statusCode, r.data))`。口径**对齐全站既有先例** `miniprogram/utils/identify-api.js:266-274`：
  - 401 ⇒ 清会话 + `SESSION_REQUIRED`（既有语义不变）；
  - 403 且码 ∈ 契约 403 集合 ⇒ 原样带出该码、`status = 403`、`retryable = false`、**不清会话**；
  - 403 但无错误体、或码不在契约 403 集合内 ⇒ 仍按会话失效处理（保守，不臆测语义）。
- `miniprogram/utils/history-api.js`：401/403 分流已收敛为委托 `auth.failureFor`（`:171`），`:151-156` 留有收敛说明；原记 `:157` / `:161` / `:184` 的码表与 `forbiddenOrSessionLoss` 在本文件已不存在（未能定位最后出现位置），口径见下条 superseded 边界。
- 补文案：`favorites-api.js` `CONSENT_REQUIRED` / `ACCOUNT_INACTIVE`、`history-api.js` 同两个码 —— 都是契约 `x-error-status-map` 里**既有**的错误码，**没有新增 ErrorCode**。

> **superseded 边界（2026-10-21 裁决）**：本页 5.1 的**实现形态**（在本文件里自持 `FORBIDDEN_CODES` +
> `forbiddenOrSessionLoss`）已被收敛——该归因现在是 `miniprogram/utils/auth.js` 的**唯一**实现
> （`attribution` / `failureFor`，`SESSION_LOSS_CODES`/`FORBIDDEN_CODES` 由 `utils/states.js` 的 `CODE_KIND` 反推），
> `favorites-api.js` / `history-api.js` 改为委托它。两处**口径**按下述裁决统一（见
> [GY-I04 登录链路](gy-i04-login-chain-20261021.md) 的「口径决定」）：
> - 403 但无错误体、或码不在契约 403 闭集内 ⇒ 归 **`SCOPE_DENIED`** 且**不清会话**（原「保守折叠成会话失效」作废：
>   为一个网关/代理 403 销毁仍然有效的令牌，正是那轮盘点要修的害处）；
> - `ACCOUNT_INACTIVE` ⇒ 码如实保留（B7 仍为 `denied`），但**清会话**（令牌永久不可用，不留死令牌）。
> 本页其余测量与结论（页面把 `errorCode` 交给 `state-view`、401 与 403 分档）不变。

### 5.2 修：页面把错误码交给统一状态组件（新增状态不新写状态块）

- `miniprogram/pages/favorites/favorites.js:36` data 增 `errorCode`，`:119` 失败时原样带出 `(error && error.code) || ''`；`favorites.wxml` 的「收藏读取失败」`<state-view>` 增 `errorCode="{{errorCode}}"`。
- `miniprogram/pages/history/history.js:33` / `:81`、`history.wxml` 同构。
- `miniprogram/pages/historydetail/historydetail.js:29` / `:160`；`historydetail.wxml` 里原来自写的 `<view class="notice notice--warn">` 换成 `<state-view status="error" errorCode="{{errorCode}}" …>` —— 按派单要求复用组件，不自写状态块。
- 效果：`components/state-view` 的 `refresh()` 见到 `resolved.status === 'denied'` 就渲染 denied 语气并自动压掉「重试 / 去登录」动作，页面无需自己判断 403。

### 5.3 修：取消收藏失败时不假装成功

- `favorites.js` `onCancel` 的 catch：`NOT_FOUND` / `REVISION_CONFLICT` 时如实报错**并回服务端重读列表**（不在本地删行，也不留一条已失效的幽灵行）。
- `historydetail.js` `onDelete` 的 catch：`NOT_FOUND`（已删除 / 他人记录，服务端同形）时按「记录不可用」收口并清空内容 + `canDelete:false`。

### 5.4 新增测试（`tests/unit/miniprogram-favorites-history.test.mjs`，+198 行 / 8 个 test）

正例与反例成对：

1. 403 `SCOPE_DENIED` ⇒ 码原样带出、`status=403`、`retryable=false`、**会话仍在**、文案是「无权」不是「请重新登录」；
2. 403 `ACCOUNT_INACTIVE` / `CONSENT_REQUIRED`（收藏层与历史层各一）⇒ 同上，文案命中「账号当前不可用」「授权同意」；
3. **反例**：401 `SESSION_EXPIRED` ⇒ 仍清会话 + `SESSION_REQUIRED`（既有语义不回归）；
4. **反例**：403 无错误体、403 带契约外的码 ⇒ 仍按会话失效收口（不臆测）；
5. 收藏页收到 403 ⇒ `errorCode='SCOPE_DENIED'`、列表清空、`message` 不是「尚无收藏。」、会话未清、`states.statusForCode` 的 denied 与 guest 分档、WXML 真的把 `errorCode` 交给 `<state-view>`；
6. 历史页收到 403 `ACCOUNT_INACTIVE` ⇒ 同上（`message` 不是「还没有识别记录。」）；
7. 历史详情：实时列表未命中 ⇒ `invalid`（不是「读取失败」）、`canDelete=false`；
8. 历史详情：读取被 403 ⇒ `errorCode` 带出、`invalid=false`（403 不等于记录不存在）、会话未清、WXML 不再自写 notice；
9. 历史详情：删除时服务端 404 ⇒ 页面按「记录不可用」收口、`canDelete=false`。

服务端侧的「越权访问他人收藏必须 403/404、重复收藏幂等、删后再读 404」已有既有断言，本片**不重复造**：

- `tests/unit/favorites-http.test.mjs:109`（增→列→取消 契约形状与「去重不产生第二行」）、`:174`（归属/越权同形、If-Match 与幂等头部纪律）、`:228`（闭集校验与后台会话隔离）、`:275`（分页稳定、跨主体游标拒绝）；
- `tests/unit/favorites-replay-and-paging-visibility.test.mjs`（取消同键重放 3 次 200、换新键再删同 id ⇒ 404 同形、重收藏得新 id）；
- `tests/integration/favorites-history-isolation-http.mjs`（越权 404 同形 / 删后再取 404 / 下架不因缓存复活）。

## 6. 拒绝做 / 未做（附理由）

- **没有**改 `packages/contracts/**`（含 `openapi.json`、`operations.json`、`states.json`）、`.github/**`。契约仍是 5 个 operation、`x-proposal-revision: 2`。
- **没有**新增 ErrorCode。新增文案只覆盖契约 `x-error-status-map` 里已有的 `CONSENT_REQUIRED` / `ACCOUNT_INACTIVE`。
- **没有**在识别结果页加「收藏」按钮（见 §7 待裁决）：识别结果只有 `species_id` 候选，收藏需要的 `target_ref.revision` 只能从 `/knowledge/{id}` 取；identify 页当前完全不依赖 `knowledge-api`（用本地 `utils/reference.js`）。硬加就得先补一次资料详情读取与类型映射，属于新增接线而非「修断点」，且现成的收藏入口已在资料详情页，故本片不擅自扩范围。
- **没有**把失败折叠成空列表，也没有任何本地伪造行：三个页面失败一律清空 + 如实报错。
- **没有**改服务端任何一行（本次纯小程序消费层 + 页面 + 测试 + 本文件）。
- **没有** push / 开 PR / 关 issue / 动 GitHub 凭据。

## 7. 待裁决与风险

1. **识别结果页「收藏」入口（未通）**：需要先定口径 —— 收藏对象是「候选里的 `species_id`」还是「本次识别的结论」？前者要补 `/knowledge/{id}` 查 revision，后者契约不支持（没有以识别结果为主题的 `target_ref` 类型）。建议单独一片，或明确「收藏只从资料详情页发起」。
2. **全站同类折叠（本片只修收藏/历史两处）**：`community-api.js:163`、`knowledge-api.js:73`、`messages-api.js:123`、`profile-api.js:22`、`voice-api.js:199` 仍是 401/403 折叠。是否统一改由派单方决定（本片不越界）。
3. **`PROVIDER_UNAVAILABLE` 的呈现**：`retryable:false`（服务端声明持久存储未接线），前端仍按「重试」语气提示；是否改成「不可重试，请联系管理员」待定。
4. **未取得（不得当通过）**：真实 PG17 服务器、真实 WeChat 开发者工具/真机/预览、真实登录与真实识别/OCR 供应商、GitHub CI（本机未跑远端流水线）。
5. `docs/verification/gy-i16-semantics-20261019.md` 记录的 8 条既有失败（`knowledge-api.test.mjs` / `knowledge-herbicides-http.test.mjs`，干净基线上同样失败）本片未触碰、未修。

## 8. 自检真实输出（本机实跑）

```
$ npm run lint
PASS tsc --noEmit services/api/tsconfig.json
PASS tsc --noEmit apps/admin/tsconfig.json
PASS 仓库卫生扫描（无禁用 TLS 写法 / 疑似硬编码密钥 / 真实 .env）
lint 通过（静态检查；不代表运行期或真实服务已通过）。

$ node --test tests/unit/miniprogram-favorites-history.test.mjs
tests 24 / pass 24 / fail 0

$ node --test tests/unit/favorites-http.test.mjs tests/unit/history-http.test.mjs \
    tests/unit/favorites-history-visibility.test.mjs tests/unit/favorites-visibility-wiring.test.mjs \
    tests/unit/favorites-replay-and-paging-visibility.test.mjs tests/unit/favorites-history-store-pg.test.mjs \
    tests/unit/favorites-history-deletion-registration.test.mjs tests/unit/ui-unified-states.test.mjs \
    tests/unit/miniprogram-login-return-to.test.mjs
tests 117 / pass 117 / fail 0

$ npm run test:mini
tests 6 / pass 6 / fail 0

$ node tests/integration/favorites-history-isolation-http.mjs
PASS favorites-history-isolation-http; synthetic identities + controllable visibility substitute;
real loopback HTTP; no PG, no supplier, no WeChat devtools
（case1 越权 404 同形 / case2 删除后 404 / case3 下架不因缓存或旧链接复活 / case4 失效行不可推荐）
```

以上全部为本机读数；`npm run test:mini` 不接触真实微信工具，集成脚本为 loopback + stub + 内存 store。
