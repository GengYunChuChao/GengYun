# GY-I14／GY-I15 · 社区链路盘点与必要接线（E3）

> 切片：#14 社区链路盘点（发帖／图片／评论／点赞／收藏／举报／审核状态／可见性刷新），并把社区适配层的
> 401/403 归因收敛到会话层统一实现。
> 分支 `feat/gy-r28-e3-community-chain`；基点 `origin/main = ee46eb1`（未 rebase、未合流、未切分支）。
> 交付物：`miniprogram/utils/community-api.js`（两个**委托**判定 + 头部纪律）、
> `miniprogram/pages/community/`、`pages/communitydetail/`、`pages/communitycreate/`（收口与刷新）、
> `tests/unit/community-chain-client.test.mjs`（新用例 16 条）、本页。
> 问题一句话：社区域的**服务端**（先审后发、版本重审、幂等点赞、可见性每次读重算）早就通了，
> 缺的是**客户端收口**——403 在详情/投稿两页落不到 B7 的 `denied`（详情页连 `errorCode` 都没有，
> wxml 还把错误态硬编码成 `invalid`）、评论取数失败被说成「这条内容当前不可见」、失效游标只弹一句
> toast 不回收、写路径 403 只用一句 toast 掩过去；而 `public_posting` 用途闸在服务端**仍未挂**。

## 0. 结论摘要

| 段 | 改前 | 改后 | 依据 |
|---|---|---|---|
| 发帖（文字） | **通**：先审后发、规则层拒绝则不落内容行、审核域未放行不公开 | 通（本片**未改服务端**一行） | `services/api/src/community/service.ts:820-905`；`routes/community.ts:211-221` |
| 图片／媒体附件 | **未通**（客户端无上传入口；服务端对 `media_ids.length > 0` 一律 503 fail-closed；投影恒为 `[]`） | **未通**（本片只如实标注，不补） | `service.ts:854-858`、`:970-972`、`:619`；`routes/media.ts:318`、`:337` |
| 评论 | **通**（读/写/改/删 + 幂等键 + `If-Match`）；**半通**在失败谱：评论取数一失败，整页被说成「内容不可见」，已读到的帖子一起被抹掉 | **通** | 改前 `pages/communitydetail/communitydetail.js:80-88`；改后 `:70-120`（`load` + `loadComments`） |
| 点赞 | **通**（PUT/DELETE 幂等，不改内容 revision）；**半通**在 403：只弹一句 toast，整页仍是「正常内容」 | **通** | `service.ts:1536-1576`；改后 `communitydetail.js:166-170`（`_writeFail`） |
| 收藏 | **不适用**：契约 `FavoriteInput` 的目标只有 `species`/`herbicide`/`scheme`，**没有** post/comment | 不适用（如实登记，不新造） | `packages/contracts/openapi.json` 的 `/favorites`（`createFavorite`）与 `FavoriteInput` |
| 举报（提交） | **通**（`POST /reports` + 幂等键；`REVISION_CONFLICT` 后重读再试） | 通 | `routes/community.ts:341-349`；`communitydetail.js:306-324` |
| 举报（处理状态） | **半通**：适配层有 `getOwnReport`，**页面零入口**（全仓无消费者） | **未变**（待裁决 E3-4） | `miniprogram/utils/community-api.js:313-318`；`routes/community.ts:353-360` |
| 审核状态 | **通**：只以服务端返回的 `visibility`/`audit_state` 说话，三页同一套标注，无本地伪造 | 通（未改） | `community.js:153-177`、`communitydetail.js:200-201`、`communitycreate.js:104-109` |
| 可见性刷新 | **通**：每次 `onShow` 经门禁重取；服务端每次读按**当前规则版本**重算 `effectiveState` | 通（未改） | `community.js:68-80`；`service.ts:455-500`、`:706-724` |
| 403 → B7 `denied` | **列表页通／详情页与投稿页未通**：详情页无 `errorCode`，wxml 写死 `status="invalid"` 且不传 `error-code`；投稿页只有一条红字提示 | **通**（三页都落 denied） | 改前 `communitydetail.js:22-37`、`communitydetail.wxml:20-27`、`communitycreate.js:104-107`；改后见 §2.9 |
| 401 归因 | **适配层已委托**（#396）；**页面**只认 `=== 'SESSION_REQUIRED'`，`SESSION_CHANGED`（同属会话类）被当成普通失败停在错误页 | **通**（页面改判 `api.sessionFailure`） | `auth.js:61-133`；改后 `community-api.js:339-344` |
| 失效游标（`INVALID_CURSOR`） | **半通**：只弹 toast，`nextCursor` 原样留着 ⇒ 该游标永不成功，用户反复点「加载更多」只见同一句报错 | **通**（清游标 + 重取第一页） | 改后 `community.js:124-138`、`communitydetail.js:279-298` |
| `public_posting` 用途闸 | **未挂**：`routes/community.ts` 16 处 `preHandler` 全只有 `guards.requireUser`；`app.ts:1834` 未传 consent | **未挂**（按裁决，本片只写结论与前置条件） | `routes/community.ts:201-360`；`app.ts:1834`；`privacy/egress.ts:14` |

一句话：**本片不动服务端、不动契约**；社区域剩下的真实缺口全在客户端「失败之后怎么说话」，
以及一个**服务端**的用途闸还没挂（挂之前要先备授权夹具，否则 GY-I15 全部社区 HTTP 用例会先 403）。

## 1. 范围

### 1.1 做了什么

1. **归因只留一个实现**：`community-api.js` 里 401/403 仍只有一处分支（`:167-170`），委托
   `auth.failureFor()`；本片**没有**新增任何码表，只补了两个**委托**判定
   `sessionFailure()` / `forbidden()`（`:339-344`，分别转发 `auth.isSessionLossCode` /
   `auth.isForbiddenCode`，闭集由 `utils/states.js` 的 `CODE_KIND` 反推），并保留本域 403 三码文案
   （`:365-367`）。
2. **三个页面改判会话类错误**：`error.code === 'SESSION_REQUIRED'` 这种字面量判断消失，
   改为 `api.sessionFailure(error)` ⇒ `SESSION_CHANGED` 也回门禁（改前停在错误页）。
3. **详情页把 403 落到 B7 `denied`**：新增 `errorCode` / `stateStatus` / `stateTitle` 三个数据字段，
   wxml 传 `error-code` 且 `allow-denied-action`（保住「返回社区」这条导航）；403 的标题从
   「这条内容当前不可见」改为「没有权限查看这条内容」，404 仍走 `invalid` 语气。
4. **写路径 403 不再被 toast 掩过去**：详情页 7 个写入口（点赞/取消/评论/反馈/编辑帖/删帖/编辑删评论）
   统一走 `_writeFail()`（`:151-155`）——会话类回门禁、403 整页 denied、其余仍是如实 toast。
5. **评论段独立状态机**：`commentsStatus` ∈ `idle/loading/ready/empty/error`；评论取数失败只影响评论区
   （可重试），**不**抹掉已读到的帖子、**不**折叠成「还没有评论」空态。
6. **失效游标回收**：列表页与评论「加载更多」遇 `INVALID_CURSOR` ⇒ 先清 `nextCursor` 再重取第一页，
   并如实提示「列表已过期，已重新载入」。
7. **投稿页 403 整页 denied**：新增 `denied` / `errorCode`，表单收起并可「重新填写」；
   400 规则驳回/422 未结论/409/503 **仍留在表单上**（改内容后重试是有意义的）。
8. 新增 `tests/unit/community-chain-client.test.mjs`（16 条）：码表同源断言、三页 401/403 四态、
   denied 组件级判定、评论失败不折叠、死游标回收；清不清会话的期望**直接读** `auth.attribution()`。
9. 给 `tests/unit/miniprogram-community-api.test.mjs` 的 `auth` 替身补 2 行（`isSessionLossCode` /
   `isForbiddenCode`，**委托真实实现**）——否则页面调用 `api.sessionFailure` 会取到 `undefined`。

### 1.2 没做什么（边界）

- **没有改任何服务端代码**：`services/api/**` 一行未动；本页所有服务端读数都是**只读**核对。
- **没有改冻结契约**：`packages/contracts/**`（含 `openapi.json`）、`.github/workflows/**`、
  `services/api/src/db/migrations/**`、`deploy/**` 均未触碰（`git status --short` 无命中，见 §4）。
- **没有挂 `public_posting` 用途闸**：按 #396 的裁决 5，本片只写结论与前置条件（§6 的 E3-2）。
- **没有补图片上传**：客户端没有上传入口这件事是**如实状态**（契约允许 `media_ids`，但规则层对带媒体的
  目标一律不判通过）；本片不写一个必然被服务端 503 的假上传，也不把「没有图片审核」说成通。
- **没有给举报补「处理状态」入口**：`getOwnReport` 只有适配层实现、没有页面消费者；补入口属产品决定
  （§6 的 E3-4），本片只登记。
- **没有 mock 真实调用**：新增用例全部驱动仓库里的真代码（真实适配层 + 真实三个页面 + 真实
  `state-view` + 真实 `states.js`），合成 `wx` 只记录请求，不外发。
- 没有 push、没有建 PR（指挥统一收口）。

### 1.3 口径决定

本片沿用 #396（监工 2026-10-21 裁决）的 401/403 口径，不自立第二套：

| # | 争议点 | 决定 | 依据／理由 |
|---|---|---|---|
| 1 | 归因实现放在哪 | `utils/auth.js` 的 `attribution()` / `failureFor()` 为**唯一**实现；社区域**委托**，不持有码表 | #396 §1.3 第 1 条；本片只补两个转发函数 |
| 2 | 403 无封套 / 闭集外码 | 归 `SCOPE_DENIED`，**不清会话** | #396 §1.3 第 2/2b 条 |
| 3 | 403 `ACCOUNT_INACTIVE` | 码**如实保留**（B7 = `denied`）+ **清会话** | #396 §1.3 第 3 条；令牌已永久不可用 |
| 4 | 401 `SESSION_EXPIRED` | 归一 `SESSION_REQUIRED` + 清会话 | #396 §1.3 第 2d 条 |
| 5 | 社区 `public_posting` 闸 | 本片**不挂**，登记前置条件 | #396 §1.3 第 5 条 |
| 6 | 「会话类」到底包含哪些码 | 页面**不再写字面量**，改判 `api.sessionFailure()`（= `auth.isSessionLossCode`，闭集由 `states.CODE_KIND` 反推）⇒ `SESSION_REQUIRED` / `SESSION_EXPIRED` / `SESSION_CHANGED` 一视同仁 | `SESSION_CHANGED` 在 `states.js:72` 就归 `session` 类；改前三个页面各写一次 `=== 'SESSION_REQUIRED'`，等于**第四份口径**，且把「会话已变化」说成「社区服务暂不可用」 |
| 7 | 403 在**写路径**怎么表现 | 与读路径一致：**整页** denied（不是一句 toast） | 403 是「登录了但不给你」，不是「这次点击没成功」；留一个看似正常、点一次骂一次的页面才是骗人。toast 也不会清掉 `error.code`，用户永远看不到原因 |
| 8 | denied 态要不要留按钮 | 默认不留（B7 原设计：403 重试不会变好），但**导航动作**用 `allow-denied-action` 保留（详情页「返回社区」、投稿页「重新填写」） | 详情页若不留，用户会被困在一个回不去也重试不了的页面；`state-view` 的 `actionSuppressed` 只该收「重试」类动作 |
| 9 | 评论取数失败怎么显示 | 评论区自己报错（可重试），**不**折叠成空态、**不**把整页说成「内容不可见」 | 空态是「服务端说没有」，失败是「服务端没回话」；把后者显示成前者是在替服务端编结论 |
| 10 | `INVALID_CURSOR` | 清游标 + 重取第一页 + 如实提示 | 服务端已声明该游标永不成功（TTL／水位／主体变化）；留着它等于给一个死按钮 |

## 2. 逐段盘点（带行号）

### 2.1 发帖（文字）—— 通

| 面 | 位置 | 读数 | 判定 |
|---|---|---|---|
| 路由 | `routes/community.ts:211-221` | `POST /posts`，`preHandler: guards.requireUser` + `onRequest: noStoreHook`，201 带强 `ETag` | 通 |
| 入参闭集 | `community/service.ts:837`（`validatePostInput`） | `title` 1..120、`body` 1..8000、`crop_id` 1..80、`region_code` ^33[0-9]{4}$、`media_ids` ≤3 | 通 |
| 幂等 | `service.ts:823-831`（`withIdempotency`）、`:215-290` | 同键同体复用结果、同键异体 409 | 通 |
| 先审后发 | `service.ts:843-848` | 规则层 `gate.evaluate` **在任何内容行落库之前**；不通过 ⇒ 只补录结论 + 拒绝发布 | 通 |
| 审核域联动 | `service.ts:852-853`、`:886-898` | 送审审核域；未获明确放行不落行；发布闸门拒绝 ⇒ 行保留 `pending_review`（私有/待审） | 通 |
| 客户端 | `community-api.js:224-227`（`createPost`，带 `Idempotency-Key`）；`communitycreate.js:77-124` | 只发契约字段；失败**不**显示「已提交成功」 | 通 |
| 审核结论口径 | `communitycreate.js:104-109` | 201 只是「已受理」，提示语逐字取自详情页 `publicLabel` / `stateLabel` | 通 |

### 2.2 图片／媒体附件 —— 未通（fail-closed 且如实标注）

| 面 | 位置 | 读数 | 判定 |
|---|---|---|---|
| 客户端上传 | `communitycreate.js:82`（`media_ids: []`）、`communitycreate.wxml:61-72`（「本轮未取得的能力」） | **不存在**上传入口，`media_ids` 恒 `[]`，并写明原因（规则层对带媒体目标一律不判通过） | 未通（如实） |
| 服务端拒绝 | `service.ts:854-858`、`:970-972` | 即使 gate 被换成会放行媒体的实现，也必抛 `PROVIDER_UNAVAILABLE`（内部不变式） | **fail-closed** |
| 规则层行为 | `service.ts:843`（`mediaInputs(body.media_ids)` 交给 gate） | 带媒体 ⇒ 规则层必隔离 ⇒ `recordRefusalVerdict` 后拒绝 | 通（拒绝路径） |
| 投影 | `service.ts:619` | `media: []`（媒体投影要「已发布且独立筛查通过」的附件版本，阶段 2 才接） | 未通（如实空） |
| 读媒体 | `routes/media.ts:318-334`（`POST /community/media-access`）、`:337-362`（`GET /community/media/{grant_id}/content`） | 服务端有授权/取流面，且 `X-Media-Access-Token` 缺失即 400；客户端**零调用** | 服务端有、客户端未接 |
| 超限/越权 | `service.ts:857`（带媒体一律 503）、`media.ts:344-346`（无令牌 400） | 越权/超限都**不会**被当成成功；没有「假装上传成功」的路径 | **fail-closed** |

判断：图片段**未通**，且这是**如实**未通——本片不补，因为它要求的是「图片审核」这条跨片能力
（`packages/moderation/merge.mjs` 的模型层依赖），不是接线问题。

### 2.3 评论 —— 通（读/写/改/删），失败谱半通 → 已补

| 面 | 位置 | 读数 | 判定 |
|---|---|---|---|
| 路由 | `routes/community.ts:251-262`（列表）、`:264-274`（创建）、`:276-283`（单条）、`:285-292`（改）、`:294-301`（删） | 全部 `requireUser`；创建 201 + `ETag` | 通 |
| 服务端 | `service.ts:1137-1190`（创建：父帖必须可见/未删、幂等、先审后发）、`:1256-1280`（改：新 revision 重审）、`:1315-1330`（删） | 隐藏版本/不存在 ⇒ 404，不泄露存在性 | 通 |
| 客户端（读） | 改前 `communitydetail.js:66-88`：`getPost().then(→ listComments)` 一条链，`catch` 分不清谁失败 | 评论失败 ⇒ `status='error'` + 「这条内容当前不可见」；已读到的帖子一起被抹掉 | **半通** |
| 客户端（读，改后） | `communitydetail.js:85-115`（帖子先渲染）、`:117-135`（`loadComments`） | 帖子 `status='ready'` 后单独取评论；失败 ⇒ `commentsStatus='error'` + 可重试，帖子不动 | **通** |
| 客户端（写） | `communitydetail.js:262-278`（发评论）、`:410-439`（改/删评论） | 幂等键 + `If-Match=post.revision`；`REVISION_CONFLICT` 重读再试 | 通 |

### 2.4 点赞 —— 通（幂等），403 被 toast 掩盖 → 已补

| 面 | 位置 | 读数 | 判定 |
|---|---|---|---|
| 路由 | `routes/community.ts:305-320`（post like/unlike）、`:323-338`（comment like/unlike） | PUT/DELETE，`requireUser`；不写 `ETag`（`Ack` 无资源表示） | 通 |
| 服务端 | `service.ts:1536-1576` | 持久唯一 `(user, target)`，重复 PUT 不产生第二条、不改内容 revision | 通 |
| 客户端 | 改前 `communitydetail.js:154-159`：`catch → wx.showToast(api.message(error))` | 403 只弹一句「当前会话无权访问社区」，页面其余部分仍是正常内容 | **半通** |
| 客户端（改后） | `communitydetail.js:166-170`（`_writeFail`）、`:248-258`（`_like`） | 会话类回门禁 / 403 整页 denied / 其余 toast | **通** |
| 契约限制 | `openapi.json` 的 `Post`/`Comment` 无点赞计数字段 | 页面不显示点赞数（`communitydetail.wxml:52-55` 如实说明） | 通（不作为缺口） |

### 2.5 收藏 —— 不适用

`packages/contracts/openapi.json` 的 `/favorites`（`listFavorites`/`createFavorite`/`deleteFavorite`）
目标类型是 `species`/`herbicide`/`scheme`（`FavoriteInput`），**没有** `post`/`comment`。
社区帖子的「收藏」不是漏做，而是契约里不存在；本片不新造一个收藏入口（那会变成第二份事实源）。

### 2.6 举报 —— 提交通；处理状态半通（页面零入口）

| 面 | 位置 | 读数 | 判定 |
|---|---|---|---|
| 提交 | `routes/community.ts:341-349`、`service.ts`（`createReport`） | `POST /reports`，201 + `ETag`，幂等键必填；`REPORT_REASONS` 五码闭集 | 通 |
| 客户端提交 | `communitydetail.js:306-324`（`_report`） | `wx.showActionSheet` 选原因 → `POST /reports`；`REVISION_CONFLICT` 后 `load()` 重读 | 通 |
| 状态回执 | `routes/community.ts:353-360`（`GET /reports/{id}`）、`community-api.js:313-318`（`getOwnReport`） | 契约与适配层都在；**页面无任何消费者**（`grep getOwnReport miniprogram/pages` 零命中） | **半通** |
| 提交后的可见反馈 | `communitydetail.js:312` | 只在一句 toast 里带 `result.report.state`（`received`/`isolated`/`closed`），关掉就没了 | 半通（如实） |

### 2.7 审核状态 —— 通

- 服务端只返回 `visibility` + `audit_state`（`service.ts:602-625` 的 `projectPost`），客户端**不**自己推断：
  `community.js:153-177`、`communitydetail.js:200-201`、`communitycreate.js:104-109` 三处标注逐字一致
  （`tests/unit/miniprogram-community-api.test.mjs` 的 `AUDIT_CASES` 6 例把这件事钉住）。
- 编辑生成新 revision 后**必须重审**（`service.ts:914-1000`）；旧版本结论不会被套到新版本
  （`communitydetail.wxml:70` 向用户明说）。
- 未通过/被隐藏的内容：作者看到显式标签，他人拿到 404（`service.ts:706-724`）。

### 2.8 可见性刷新 —— 通

- 客户端：`community.js:51-63`、`communitydetail.js:57-71`、`communitycreate.js:48-52` 每次 `onShow`
  都经 `pageGate` 重走门禁 + 重取；`onLoadMore` 的游标绑定主体，切筛选即 `reload()` 从第一页重来。
- 服务端：`service.ts:455-500`（`effectiveState`：删除态直接返回；每次读按**当前规则版本**重判，
  已发布但当前不可发布的降到 `hidden`）、`:498-500`（`isPubliclyVisible` 的唯一判据
  `published ∧ approved`）、`:726-770`（`publiclyVisibleTarget` 逐条重查）。
- 下架事件：`app.ts:1071-1072` 的 `withTakedownObserver(communityStore, { events })`。
- 结论：**没有**「读了缓存就当公开」的路径；本片未改这一层。

### 2.9 403 是否落到 B7 的 `denied`（`state-view` 的 `error-code`）—— 列表页通；详情/投稿两页未通 → 已补

| 页 | 改前 | 改后 |
|---|---|---|
| 列表 | `error-code="{{errorCode}}"` 已在（`community.wxml:57`），`errorCode` 由 `reload` 透传 | 未改（仅把收口抽成 `_fail`，`:101-110`；字面量 `errorCode: (error && error.code) \|\| ''` 保留，`tests/ui-unified-states.test.mjs:198` 守着） |
| 详情 | `data` 里**没有** `errorCode`；`communitydetail.wxml:20-27` 写死 `status="invalid"` 且**不传** `error-code` ⇒ `denied` 在本页**不可达**，403 显示成「这条内容当前不可见」 | `data.errorCode`/`stateStatus`/`stateTitle`（`communitydetail.js:21-50`）、`_fail`（`:145-159`）、wxml `status="{{stateStatus}}"` + `error-code` + `allow-denied-action`（`:19-34`） |
| 投稿 | 只有 `errorText` 红字提示（未见 `error-code`） | `data.errorCode`/`denied`（`:38-41`）、`onSubmit` 的 catch 分三路（`:110-124`）、wxml 顶部 denied 分支（`:22-33`） |
| 组件级判定 | — | 真实 `state-view`（真实 `states.js`）在 `errorCode=SCOPE_DENIED/CONSENT_REQUIRED/ACCOUNT_INACTIVE` 时 `effectiveStatus==='denied'`，`kindTag==='没有权限'`；denied 默认收起动作，故详情页/投稿页显式 `allow-denied-action`（导航动作不是重试） |

### 2.10 `public_posting` 用途授权闸 —— 未挂（本片只写结论）

- 挂载表要求挂：`services/api/src/privacy/egress.ts:14` 明确列出「社区投稿入口」应挂
  `createConsentPreHandler(guard, { purpose, dataType })`，且放在路由自身 `preHandler` **之后**。
- 实际没挂：`routes/community.ts` 的 **16** 处 `preHandler` 全部只有 `guards.requireUser`
  （`:203, 213, 225, 234, 243, 253, 266, 278, 287, 296, 307, 316, 325, 334, 343, 355`），
  `registerCommunityRoutes(app, config, gatedGuards, communityService)`（`app.ts:1834`）**也不收** consent 参数。
- 用途码在闭集里：`recording` / `media_processing` / `external_inference` / `public_posting`
  （`services/api/src/privacy/consent-pg.ts` 的 `CONSENT_PURPOSES`）；拒绝语义见 `privacy/egress.ts:88-105`
  （缺授权 ⇒ 403 `CONSENT_REQUIRED`，错用途 ⇒ 403 `SCOPE_DENIED`）。
- **为什么本片不挂**：`createConsentPreHandler` 放在 `requireUser` 之后时，社区 16 条路由里凡是
  「写/发布」的 3 条（`POST /posts`、`PATCH /posts/{id}`、`POST /posts/{id}/comments`）会立刻要求
  `public_posting` 授权；`tests/unit/community-http.test.mjs`、`tests/unit/community-gate.test.mjs`
  等**全部**社区 HTTP 用例目前不带授权夹具 ⇒ 会整片先 403。前置条件：
  ① 一个可注入的 `consent` 端口（`registerCommunityRoutes` 加参数）；
  ② 测试夹具里预置 `public_posting` 授权（内存 guard 或 PG 夹具）；
  ③ 反例用例证明「无授权 ⇒ 403 `CONSENT_REQUIRED` 且内容未落库」；
  ④ 只有「对外公开发布」这一条需要闸——`GET`、点赞、举报、删除**不该**要求外发授权。
- 现状风险（如实）：无授权用户当前也能发帖（服务端只要求会话）。这是一条**真实存在的口径缺口**，
  不是本片引入的，也不是本片能安全补的（属契约/装配面）。

### 2.11 媒体附件失败/超限/越权是否 fail-closed —— 是（服务端）

| 情形 | 位置 | 行为 | 判定 |
|---|---|---|---|
| 带媒体投稿 | `service.ts:843`（规则层）→ `:844-848`（拒绝+补录结论） | 规则层对带媒体目标**一律不判通过** ⇒ 不落内容行 | fail-closed |
| 规则层被替换成「放行媒体」 | `service.ts:854-858`、`:970-972` | 仍抛 `PROVIDER_UNAVAILABLE`（内部不变式违反） | fail-closed（双保险） |
| 读媒体附件 | `routes/media.ts:337-351` | 缺/非法 `X-Media-Access-Token`（1..512）⇒ 400；`Cache-Control: no-store`；不重定向到原桶 URL | fail-closed |
| 客户端 | `communitycreate.wxml:46-54` | 明确写「本页不提供图片上传」，并说明原因 | 如实未取得 |

## 3. 验证命令与真实读数

环境：Windows；`node v24.16.0`；`E:\GengYunCommander\wt-e3-community`（worktree）；`node_modules` 原来
**不存在**，本切片一次性 `npm install --no-audit --no-fund` → `added 103 packages in 5s`。

### 3.1 `npm run lint`

```
> gengyun@0.0.0 lint
> node tools/lint-workspaces.mjs

PASS tsc --noEmit services/api/tsconfig.json
PASS tsc --noEmit apps/admin/tsconfig.json
PASS 仓库卫生扫描（无禁用 TLS 写法 / 疑似硬编码密钥 / 真实 .env）
lint 通过（静态检查；不代表运行期或真实服务已通过）。
```
`exit=0`。（本片没改 `services/**`／`apps/**`；两条 tsc 与改动无关，列出以证明未回归。）

### 3.2 新用例 `node --test tests/unit/community-chain-client.test.mjs`

```
✔ 适配层：sessionFailure/forbidden 与会话层闭集同源（不另立码表），403 三码归 forbidden、会话码归 sessionFailure
✔ 社区列表页：403 SCOPE_DENIED ⇒ 不清会话、错误码原文落到 denied（改前是「请先登录」）
✔ 社区列表页：403 ACCOUNT_INACTIVE ⇒ 码如实保留（denied）且按统一层口径清会话
✔ 社区列表页：401 SESSION_EXPIRED ⇒ 归一 SESSION_REQUIRED + 清会话 + 回门禁（不停在错误页）
✔ 社区列表页：客户端自造码 SESSION_CHANGED 同样回门禁（改前停在「社区服务暂不可用」错误页）
✔ 社区列表页「加载更多」：INVALID_CURSOR ⇒ 清死游标并从第一页重载（改前只弹一句 toast）
✔ 社区列表页「加载更多」：403 ⇒ 整页 denied（不是一句 toast 掩过去）
✔ 社区详情页：403 ⇒ denied 语气 + 「返回社区」不被收起（不把用户困在一个回不去的页面）
✔ 社区详情页：404 仍走 invalid 语气（不把「可能已下架」说成没权限）
✔ 社区详情页：评论取数失败 ⇒ 帖子仍可见、评论区如实报错（不折叠成「还没有评论」空态）
✔ 社区详情页：评论为空才是空态（成功响应 items=[] ⇒ commentsStatus=empty）
✔ 社区详情页写入：403 CONSENT_REQUIRED ⇒ 整页 denied（改前只弹一句 toast），且不清会话
✔ 社区详情页写入：401 SESSION_EXPIRED ⇒ 清会话并回门禁（不谎称操作失败）
✔ 社区详情页评论「加载更多」：INVALID_CURSOR ⇒ 清死游标并重取第一页
✔ 投稿页：403 CONSENT_REQUIRED ⇒ 整页 denied、表单收起、无任何成功提示；不清会话
✔ 投稿页：400 规则驳回仍留在表单上（改内容重试有意义，不算 denied）
ℹ tests 16   ℹ pass 16   ℹ fail 0   ℹ duration_ms 142.0092
```

### 3.3 负控制（证明 16 条不是空转）

把本片改过的 6 个源文件临时换回 `origin/main` 版（`git checkout origin/main -- …`），**只留本片用例**：

```
ℹ tests 16   ℹ pass 2   ℹ fail 14
✖ 适配层：sessionFailure/forbidden 与会话层闭集同源…
✖ 社区列表页：401 SESSION_EXPIRED ⇒ 归一 SESSION_REQUIRED + 清会话 + 回门禁
✖ 社区列表页：客户端自造码 SESSION_CHANGED 同样回门禁
✖ 社区列表页「加载更多」：INVALID_CURSOR ⇒ 清死游标并从第一页重载
✖ 社区列表页「加载更多」：403 ⇒ 整页 denied
✖ 社区详情页：403 ⇒ denied 语气 + 「返回社区」不被收起
✖ 社区详情页：404 仍走 invalid 语气
✖ 社区详情页：评论取数失败 ⇒ 帖子仍可见、评论区如实报错
✖ 社区详情页：评论为空才是空态
✖ 社区详情页写入：403 CONSENT_REQUIRED ⇒ 整页 denied
✖ 社区详情页写入：401 SESSION_EXPIRED ⇒ 清会话并回门禁
✖ 社区详情页评论「加载更多」：INVALID_CURSOR
✖ 投稿页：403 CONSENT_REQUIRED ⇒ 整页 denied…
✖ 投稿页：400 规则驳回仍留在表单上
```

负控制后已把 6 个文件恢复（恢复后重跑 `16/16` 绿，`git diff --numstat` 与 §4 一致）。

**必须说清的一件事**：绿着的 2 条是「列表页 403 ⇒ 不清会话」与「列表页 403 ACCOUNT_INACTIVE」——
它们在 `origin/main` 版上**本来就绿**，因为 #396 已把 `auth.failureFor` 接进 `community-api`。
所以这两条现在是**回归护栏**（防止将来有人把 403 折回 `SESSION_REQUIRED` 并顺手清会话），
不算本片的新行为；本片真正新增的行为是其余 14 条。

### 3.4 相邻回归（逐个单跑）

| 命令 | 读数 |
|---|---|
| `node --test tests/unit/miniprogram-community-api.test.mjs` | `tests 24 / pass 24 / fail 0`（#396 口径已在：403 ⇒ `SCOPE_DENIED` + `cleared.count===0`） |
| `node --test tests/unit/community-atomic … -contract … -gate … -moderation-clock … -moderation-events-fail-closed … -moderation-freshness … -moderation-gate-wiring` | `tests 51 / pass 51 / fail 0` |
| `node --test tests/unit/community-moderation-publish … -read-recheck … -revision-guard … -revision … -takedown … -service … -store-pg-contract … -http` | `tests 92 / pass 92 / fail 0` |
| `node --test tests/ui-unified-states.test.mjs tests/ui-adaptive.test.mjs` | `tests 35 / pass 35 / fail 0` |
| `node tests/integration/community-pg.mjs` | `SKIP real PG17: COMMUNITY_PG_TEST_URL 未设置 …` / `exit=77`（**未取得**，不是通过） |

### 3.5 `npm run test:mini`（小程序侧改动必跑）

```
PASS: native JSON/routes, five empty tabs, shared domain check and JS syntax. Not a WeChat compiler or device test.
✔ missing, public, wildcard, credential, unsafe path and mismatched configs fail
✔ apiBaseUrl accepts origin or origin plus a client-append base path without widening rejections
✔ actual HTTP service is synthetic, no-store and has no business routes
✔ client blocks trial/release/unknown environments and labels stub or failure
✔ isolated packaging excludes private files and rejects release overrides/stale output
✔ local --appid overrides only the generated copy and rejects illegal ids without leftovers
ℹ tests 6   ℹ pass 6   ℹ fail 0   ℹ duration_ms 5588.5223
```
`exit=0`。注：本片改了 3 个 `.wxml`（评论三态、错误态 `error-code`、投稿页 denied 分支），
`test:mini` 只做 JSON/路由/语法与打包隔离检查，脚本自己就写着「Not a WeChat compiler or device test」。

### 3.6 `npm run test:unit`（全量，**独占一次跑完**）

```
ℹ tests 3355   ℹ suites 0   ℹ pass 3354   ℹ fail 0   ℹ cancelled 0   ℹ skipped 1
ℹ todo 0       ℹ duration_ms 59570.3006
exit=0
```
（`skipped 1` 为既有跳过项，非本期新增。本轮**没有**出现抖动，也没有复跑。）

## 4. 改法（逐文件，`git diff --numstat`；下表行号为 2026-10-21 切片的历史位置，不是现行源码锚点）

```
 391    0  docs/verification/gy-i14-community-chain-20261021.md   ← 本页（新增）
  27    8  miniprogram/pages/community/community.js
  22    4  miniprogram/pages/communitycreate/communitycreate.js
  17    0  miniprogram/pages/communitycreate/communitycreate.wxml
 108   25  miniprogram/pages/communitydetail/communitydetail.js
  23    3  miniprogram/pages/communitydetail/communitydetail.wxml
  28    0  miniprogram/utils/community-api.js
 523    0  tests/unit/community-chain-client.test.mjs            ← 新增
   4    0  tests/unit/miniprogram-community-api.test.mjs
 ---  ---  合计：9 文件 +1143 / −40（`git diff --numstat origin/main..HEAD`）
```

| 文件 | 改了什么 |
|---|---|
| `miniprogram/utils/community-api.js` | 头部纪律加第 5 条（归因委托会话层）；新增 `sessionFailure()`（`:339-341`）与 `forbidden()`（`:342-344`）两个**委托**判定并导出（`:404-405`）；`send()` 的 401/403 分支未改（`:167-170`，仍是唯一一处、委托 `auth.failureFor`）；本域 403 三码文案保留（`:365-367`） |
| `miniprogram/pages/community/community.js` | 失败收口抽成 `_fail()`（`:96-110`，会话类回门禁、其余透传 `errorCode`）；`reload` 的 catch 改调 `_fail`（`:89-93`）；`onLoadMore` 的 catch 三分：会话/403 ⇒ `_fail`、`INVALID_CURSOR` ⇒ 清游标 + 重载、其余 toast（`:124-138`） |
| `miniprogram/pages/communitydetail/communitydetail.js` | 新增 `errorCode`/`stateStatus`/`stateTitle`/`commentsStatus`/`commentsError`（`:21-50`）；`load()` 帖子先渲染、评论另取（`:70-100`）；新增 `loadComments()`（`:102-120`）；`_fail()`（`:130-144`）；`_writeFail()`（`:151-155`）并接上 7 个写入点；`onLoadMoreComments` 加游标回收（`:245-270`）；`onRetryComments`（`:391`） |
| `miniprogram/pages/communitydetail/communitydetail.wxml` | 错误态改 `status="{{stateStatus}}"` + `error-code` + `title="{{stateTitle}}"` + `allow-denied-action`（`:19-34`）；评论区加 loading/error/empty 三态与「重新读取评论」（`:88-101`） |
| `miniprogram/pages/communitycreate/communitycreate.js` | 新增 `errorCode`/`denied`（`:38-41`）；`onSubmit` 的 catch 三分（`:110-124`）；`onDismissDenied()`（`:126`） |
| `miniprogram/pages/communitycreate/communitycreate.wxml` | 顶部 denied 分支（`:22-33`），表单与「未取得能力」说明包进内层 `<block wx:else>`（`:33-73`） |
| `tests/unit/miniprogram-community-api.test.mjs` | `auth` 替身补 `isSessionLossCode`/`isForbiddenCode`（`:89-90`，委托 `realAuth`）——页面收口用的判定不再取到 `undefined` |
| `tests/unit/community-chain-client.test.mjs` | 新增 16 条（见 §3.2） |

**没有改**：`packages/contracts/**`、`openapi.json`、`.github/workflows/**`、`services/api/src/db/migrations/**`、
`deploy/**`、`services/api/**`、`miniprogram/utils/auth.js`、`miniprogram/utils/states.js`、
`miniprogram/components/state-view/**`。用 `git status --short` 可直证（只有上表 7 个已跟踪文件 + 2 个新增文件）。

## 5. 未取得（不得据以推断已通过）

| 项 | 状态 | 影响 |
|---|---|---|
| 微信开发者工具编译 / 真机渲染 | **未取得**（`test:mini` 自述「Not a WeChat compiler or device test」） | 本片改了 3 个 `.wxml`，**没有**工具侧渲染证据；评论三态与 denied 分支的视觉未走查 |
| 真实服务端联调（真实 `GET /posts` 等响应） | **未取得** | 本片所有客户端读数都是 Node + 合成 `wx` 封套驱动真代码 |
| 真 PostgreSQL（`community-pg.mjs`） | **未取得**：`COMMUNITY_PG_TEST_URL` 未设置 ⇒ `exit=77` | 本片**未**验证真库下的可见性/游标行为；服务端一行未改，既有证据页仍是唯一真库读数 |
| 真实 AI 图文审核 / 真实媒体审核 | **未取得**（属 #14 的供应商面） | 图片段「未通」的根因就在这里；本片不补偿、不假装 |
| `public_posting` 授权的真实触发 | **未取得**（闸未挂 ⇒ 无触发路径） | 本页只写「若挂上会怎样」，没有任何端到端证据 |
| 403 的真实端到端触发 | **仅客户端归因证据** | 本片证明「若服务端返 403，页面按统一层口径落 denied」；**未**在真实环境构造 `CONSENT_REQUIRED`/`ACCOUNT_INACTIVE` |
| 全量 `test:unit` 的稳定性 | 本轮**一次**独占运行即 `3355/3354 pass / 0 fail / 1 skipped / 59.6 s / exit 0` | 本页不声称「任何时候必绿」；同族证据页记过并行负载下的 OOM 抖动，本片未复现 |

## 6. 待裁决（编号列表，本片不做）

| 编号 | 事项 | 为什么本片不做 | 建议归属 |
|---|---|---|---|
| E3-1 | 归因收敛本身：`community-api.js` 的 401/403 判定 | **已由 #396 完成**（改前 `:163-167` 的折叠已消失），本片只剩「页面别写字面量」这一层并补齐两个委托判定 | 已关闭（#396 + 本片） |
| E3-2 | 社区投稿挂 `public_posting` 用途闸（`routes/community.ts` 16 处 preHandler；`app.ts:1834` 未传 consent） | 会先让 GY-I15 全部社区 HTTP 用例 403；需先备授权夹具 + 给 `registerCommunityRoutes` 加 consent 参数（§2.10 四条前置条件） | 独立片（#29 × #15 交汇） |
| E3-3 | 图片帖：客户端上传 + 图片审核 + 媒体投影（`service.ts:619` 的 `media: []`） | 依赖模型层审核与真实供应商；写假上传只会造一条必然 503 的路径 | #14 供应商面（GY-I21 评估） |
| E3-4 | 举报「处理状态」页面入口（`GET /reports/{id}` 已有、`getOwnReport` 已有消费者为零） | 属产品决定（入口放哪、多久回查、`isolated` 怎么向用户解释）；本片只登记缺口 | #15 后续片 |
| E3-5 | 编辑帖子会**丢弃** `media_ids`：`communitydetail.js:346` 固定传 `media_ids: []` | 目前 `media_ids` 恒为空（无上传入口）⇒ 无实际影响；一旦 E3-3 落地就会静默丢附件，需随 E3-3 一起改成「沿用当前 `post.media_ids`」 | 随 E3-3 |
| E3-6 | 举报 `detail` 字段始终传空串（`communitydetail.js:311`），页面没有输入框 | 契约允许可选 `detail`；补输入框属交互决定，不是缺陷 | #15 后续片 |
| E3-7 | 点赞没有「我是否点过赞」的读取口（契约无此字段） | 契约变更属禁改面；页面已如实说明「不显示点赞数」 | 契约片 |

## 7. 文档/行号漂移登记（只登记，本片不改）

| 派发/文档说法 | 实际（基点 `ee46eb1`） | 说明 |
|---|---|---|
| 派发：「`community-api.js` 里仍有一份自建的 401/403 判定（约 `:163-167`），把 403 折叠成 `SESSION_REQUIRED` + `clearSession()`」 | 基点上是 `:167-170`，且**已经是** `reject(auth.failureFor(failure, response.statusCode, response.data))`——没有折叠、没有 `clearSession()`、没有码表 | 该缺陷由 **#396** 修掉；派发读数基于 #396 之前的树。本片据此把「必做项」落成「页面不再写字面量 + 补两个委托判定」 |
| 派发：「`tests/unit/miniprogram-community-api.test.mjs` 刚被 **#399** 加强过」 | **#399 尚未合入**（`gh pr view 399` → `state: OPEN`，`headRefName: feat/gy-r28-d4-messages-chain`，`headRefOid: 99a6ce9`）。基点上的该文件已是 **#396** 口径（403 ⇒ `SCOPE_DENIED` + `cleared.count===0`），本片按该口径对齐，只补了 2 行替身 | 「加强后的口径」= 403 不折叠/不清会话 + `ACCOUNT_INACTIVE` 码保留但清会话；本片的同源断言与 `ACCOUNT_INACTIVE` 覆盖放在新文件里，避免与 #399 抢同一段 |
| 派发：同族体例页 `docs/verification/gy-i15-messages-chain-20261021.md`「刚合入」 | 在基点 `ee46eb1` 上**不存在**（`Get-ChildItem docs/verification -Filter '*messages-chain*'` 零命中）；它只存在于 `wt-d4-messages` 工作区／PR #399 分支 | 不是文件写错，而是派发时基点较旧。本页按 `gy-i04-login-chain-20261021.md` 的体例撰写，并参考了 #399 分支上那份的对齐方式（只读，未改其文件） |
| 派发：`AGENTS.md`（仓库根；注意不是 `AGENT.md`） | 核对为**准确**（39 行） | 非漂移，记录以证明已核 |
| `docs/verification/gy-i04-login-chain-20261021.md:24` 记「`app.ts:1735` 未注入 `consentGate`」 | 实际 `registerCommunityRoutes(app, config, gatedGuards, communityService)` 在 `app.ts:1834` | 行号漂移（中间合入 #397/#398 推移），**结论不变**：社区仍未注入 consent |
| `docs/verification/gy-i04-login-chain-20261021.md:23` 记 `community-api.js:163-167` | 现为 `:167-170`（本片未改该分支，只把上方注释加了一行说明） | 行号漂移 4 行；引用请用 `:167-170` |
| `docs/verification/gy-i15-community-http-20261020.md`／`gy-i15-community-pg-20261018.md` 的服务端读数 | 本片逐条复核：路由条数 16、`preHandler` 全 `requireUser`、`effectiveState` 每次读重算，**仍准确** | 非漂移 |
| `services/api/src/privacy/egress.ts:14` 挂载表含「社区投稿入口」 | 核对为**准确**（挂载表确实要求），但从未接线 | 非漂移；缺口记在 §2.10 |

## 8. 不证明什么

- 不证明真机／微信开发者工具下的社区页面可用；不证明三个 `.wxml` 的渲染与无障碍走查。
- 不证明任何 403 的真实触发链路端到端可达（`public_posting` 闸未挂、真实供应商未接）。
- 不证明图片帖已通：客户端无上传、服务端对带媒体一律 fail-closed、投影恒空。
- 不把 `stub` / `preset_demo` 的执行模式当成真实能力；本期没有新增任何替身成功路径，也没有把 403 说成成功。
- 不声称「社区全部段落已通」：图片（E3-3）、举报处理状态入口（E3-4）、用途闸（E3-2）都仍是缺口。
- 本页所有「通」都限定为：**在同一份真代码 + 合成 `wx` 响应下，判定、收口与文案符合契约语义**。
