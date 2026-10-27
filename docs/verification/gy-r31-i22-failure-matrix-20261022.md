# GY-R31（#22 / GY-I22）失败矩阵复盘与缺口矩阵（只读）

- 基线（**本页初稿时点**）：`origin/main` `d4d48088`（worktree `E:\GengYunCommander\wt-r31-i22`，分支 `feat/gy-r31-i22-recon`）
- **本页时点：`upstream/main` `7dd3d699`**（**2026-10-23 重绑时点**）。历史时点：初稿 `d4d48088`（2026-10-22）→ 回写 `1fbe7572`（2026-10-22）。本次重绑只做三件事：① 核引用——`文件:行` **只核「同号同内容」**，`C 族@行` 另做语义核并整体订正 12 行（结论见文末「2026-10-23 重绑记录」与**附录 A**）；② 订正两处本来就指错的引用（`community-service.test.mjs`、`history-http.test.mjs`）；③ 补记「本页时点」的新读数。**§2 各表的逐格判定、§3、§4、§5 的条数与结论一律沿用回写时点，未重算。**
- 性质：**只读复盘**。本页不改业务代码、不改 `docs/architecture/contract-status.json`、不跑全量单测。
- 证据口径：**每一格都给可定位的 `文件:行`**（`tests/...` 或 `services/api/src/...`）。
  本页区分两类事实，不混写：
  - **【断言】**＝仓库里已存在的用例断言（读码定位，**未**在本页重跑）；
  - **【实现】**＝产品代码里的行为（读码定位，**未**实测）。
  - 本页的**实测**只有两处：§7 记的初稿那次定向单文件运行（失败，缺依赖），以及文末「2026-10-23 重绑记录」里为核引用与门禁而跑的几条命令；其余一律**没有实测**。

---

## 0 度量口径

### 0.1 失败族 → 契约错误码 → HTTP 状态

来自 `services/api/src/contract.ts:14-27`（`ERROR_STATUS_MAP`，契约 1.0.0）：

| 失败族（列） | HTTP | 允许错误码 |
| --- | --- | --- |
| 未登录 401 | 401 | `SESSION_REQUIRED` / `SESSION_EXPIRED` |
| 越权 403 | 403 | `SCOPE_DENIED` / `CONSENT_REQUIRED` / `ACCOUNT_INACTIVE` |
| 不存在 404 | 404 | `NOT_FOUND` |
| 冲突或幂等 409 | 409 | `REVISION_CONFLICT` / `IDEMPOTENCY_CONFLICT` / `OBJECT_UNAVAILABLE` / `REQUEST_IN_PROGRESS` |
| 校验 400 | 400 | `INVALID_REQUEST` / `INVALID_CURSOR` / `IDEMPOTENCY_KEY_REQUIRED` |
| 限流 429 | 429 | `RATE_LIMITED` / `PROVIDER_QUOTA_EXCEEDED` |
| 上游不可用 503 | 503 | `PROVIDER_UNAVAILABLE` / `PROVIDER_OUTCOME_UNKNOWN` |
| 超时 timed_out | 504 | `PROVIDER_TIMEOUT` |

**超时列的双口径**（重要，否则会误判）：契约里超时既是异步任务的**终态** `timed_out`（`GET /jobs/{id}` 返回 200 + `state=timed_out` + `error_code=PROVIDER_TIMEOUT`），也是同步面的 **504**（`PROVIDER_TIMEOUT`）。两者在矩阵里合并为「超时」一列，但证据必须分写。

### 0.2 记号

| 记号 | 含义 |
| --- | --- |
| ● | 有测试断言（后面给定位） |
| ○ | 无覆盖（已搜索，未找到任何断言） |
| — | 不适用（该 operation 结构上不可能产生这一族；括号里给理由） |

### 0.3 规模事实

- `packages/contracts/operations.json` 共 **113** 个 operation（`docs/architecture/contract-status.json` 的 `operations` 数组同数：partial 96 / implemented 13 / planned 4）。
- 既有可执行骨架：`tests/failmatrix/`（`cases.mjs` / `seams.mjs` / `world.mjs` / `run.mjs` / `mutations.mjs`），
  由 `tests/unit/gy-i22-failmatrix.test.mjs:35` 钉住 **`MIN_CASES = 230`**（初稿时点是 168；230 是 #449 把异步 AI 域
  C10/C11 拉进矩阵后的下限，只增不减，`168 + 23 + 39 = 230`），族条数在
  `tests/unit/gy-i22-failmatrix.test.mjs:37`：`C1:37 C2:24 C3:27 C4:18 C5:10 C6:10 C7:16 D1:11 D2:4 D3:2 D4:3 E1:3 E2:3 C10:23 C11:39`；
  批次条数 `:39`：`B1:106 B2:36 B3:17 B4:9 B5:62`。包装器用 `app.inject`（`execution_mode=stub`）真跑 `tests/failmatrix/run.mjs`（`:41-56`）。
- 本页的 8 列与 failmatrix 的族**不是一一对应**：C1≈401、C2≈归属 404、C3≈后台 403/503、C4≈会话、C6≈幂等 409、C7≈校验 400、D 族≈受信 seam、E1/E2≈注入与媒体凭据。

---

## 1 #22 验收原文 → 可判定条目

`gh issue view 22 -R GengYunChuChao/GengYun` 的验收文本可拆成 4 条，再拆成可判定的 9 项（判定项是本页的验收单位）：

| 判定项 | 可判定表述 | 本页对应章节 | 现状 |
| --- | --- | --- | --- |
| A1 | 游客访问每一个需要登录的 operation，一律 401 `SESSION_REQUIRED`（不得是 403/404/500） | §2 各表首列 | **基本齐**：failmatrix C1 有 37 条，C10 另有 23 条（异步 AI 域与 `/jobs` 的游客面，`cases.mjs:303-333`，#449）；域内单测/集成另有 401 |
| A2 | A 用户不得读写 B 用户的对象，且「不是你的」与「不存在」**同形 404** | §3.1 | **齐**（9 个域有负控制断言，2 个域结构性不适用） |
| A3 | 所有 `/admin/*` 端点都必须过角色（admin）与 scope 校验 | §3.2 | **齐**（24+N 条路由逐一有守卫；见 3.2 的两处例外说明） |
| A4 | 注销后旧 token 立即失效（401 `SESSION_EXPIRED`），且重放原 code/key 不得再签发可用凭据 | §3.3 | **齐** |
| A5 | 写面幂等：缺键 400、同键同体重放同一结果、同键异体 409 | §2（409/400 列） | **基本齐**；`/ocr`、`/speech/*`、`/recognitions` 有域内断言；#449 之后 failmatrix 的 C10/C11 另覆盖它们的 401 与归属 404 两列，其余列仍只在域内 |
| A6 | 上游不可用必须 fail-closed 503，不得把「能力未接线」说成 404/200 | §2（503 列） | **齐**（各域都有 fail-closed 断言；见 3.1 的例外） |
| A7 | 超时必须是可区分的终态（`timed_out` + `PROVIDER_TIMEOUT`），不得与 `failed` 同形 | §2（超时列）、§4.1 #2/#4 | **齐**：异步终态 `timed_out` 与同步面 504 均有断言（§4.1 #2，2026-10-22 回写） |
| A8 | 限流 429 必须有断言（至少登录被限流） | §2（429 列） | **齐**：429 的 HTTP 面断言已补（`tests/unit/gy-i22-rate-and-timeout.test.mjs:77`，#442／#450；详见 §4.1 #1） |
| A9 | 「任何处方混配换算、伪来源或未审内容公开均阻止发布」 | 非失败族，见 §4.1 #9 的相邻风险 | 越界，本页只列不判 |

---

## 2 失败矩阵

> 行＝`packages/contracts/operations.json` 的 operation；列＝8 个失败族。
> 单元格只放定位；完整判定理由见该域表下的「注」。

**§2.0 实测出来的计数**（对本页 §2.1–§2.11 的表格逐格分类得到，非估计）：

| 量 | 数 | 说明 |
| --- | --- | --- |
| 逐个成行的 operation | **56** | 覆盖 12 个高频域（auth 6、community 18、favorites/history 5、messages 3、knowledge 5、recognitions 4、ocr 5、speech 4、tts 1、moderation 2、consents 3） |
| 明细格（56 × 8） | **448** | 每格都已判定，无「其他」残留 |
| ├ 有测试断言 ● | **155**（34.6%） | |
| ├ 无覆盖 ○ | **239**（53.3%） | |
| └ 不适用 — | **54**（12.1%） | 多数是「匿名入口无 401」「无 `:id` 无 404」这类结构性不适用 |
| 可判定格内的断言率 | **155 / 394 = 39.3%** | 剔除 — 后 |
| 未逐个成行的 operation | **57 / 113** | 由 §2.12 的 8 个域行汇总（不给逐格判定，只给域级结论） |
| 若按 113 × 8 折算 | 904 格中 **155 格**有断言 | 折算值仅表示"整个契约面覆盖率 17%"，不代表其余 749 格都无覆盖（其中 456 格只是本页未逐格展开） |

### 2.1 auth（6 个 operation）

| operation | 401 | 403 | 404 | 409 | 503 | 超时 | 400 | 429 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `loginWechat` POST /auth/wechat | —（匿名入口） | — | — | ● `auth-routes.test.mjs:295`（同键异体 `IDEMPOTENCY_CONFLICT`） | ○（real 无 store 时 503 只在别域断言） | ○ | ● `auth-routes.test.mjs:249-262`（缺键/短键 `IDEMPOTENCY_KEY_REQUIRED`） | ○ |
| `getUserSession` GET /auth/session | ● `auth-routes.test.mjs:102,115,119`；failmatrix `C1-27@90` | ● `auth-routes.test.mjs:202`（用户 token 打后台面 → `SCOPE_DENIED`） | — | — | ○ | ○ | — | ○ |
| `logoutUser` POST /auth/logout | ● `C1-28@91`；`auth-routes.test.mjs:224-226`（注销后同 token 401 `SESSION_EXPIRED`）、`:332` | ● `C4-06@179` | — | — | ○ | ○ | ● `C4-01@174`；`auth-routes.test.mjs:249-262` | ○ |
| `loginAdmin` POST /admin/auth/session | —（匿名入口） | ○（凭据错误沿用 401，见 `contract-status.json` loginAdmin blocker） | — | ○ | ○ | ○ | ○ | ○ |
| `getAdminSession` GET /admin/auth/session | ● `C1-36@99` | ● `C3-17@154`（有 scope → 200 对照片） | — | — | ○ | ○ | — | ○ |
| `logoutAdmin` POST /admin/auth/logout | ● `C3-23@160`（对照片） | ● `C3-12@149` | — | — | ○ | ○ | ○ | ○ |

注：`auth-routes.test.mjs:771` 有一条 **503** 断言（auth 域唯一直达 503 的一行）；`miniprogram-auth-failure-attribution.test.mjs:253`、`miniprogram-auth-runtime.test.mjs:203,406` 断言的是**客户端对 503 的归属处理**（不得清会话），不是服务端 503 的产生。
`loginWechat` 是**唯一**在服务端产出 429 的路径：`services/api/src/auth/wechat.ts:121` 抛 `RATE_LIMITED`——**但没有任何断言**（见 §4.1 #1）。

### 2.2 community（18 个 operation）

| operation | 401 | 403 | 404 | 409 | 503 | 超时 | 400 | 429 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `listPosts` GET /posts | ● `C1-16@79` | ● `community-service.test.mjs:725`（`SCOPE_DENIED`） | — | — | ● `community-service.test.mjs:344` | ○ | ● `C7-09@265`、`C7-10@266` | ○ |
| `createPost` POST /posts | ● `C1-17@80` | ● `community-posting-consent.test.mjs:107`（无授权 403） | — | ● `C6-07@237`（同键异体） | ● 同 `:344` | ○ | ● `C6-04@230`、`C7-11@267`、`E1-01@275`（注入命中 400） | ○ |
| `getPost` GET /posts/:id | ● `C1-18@81` | ○ | ● `C2-17@119`；`community-atomic.test.mjs:88,160,306` | — | ● `community-moderation-takedown.test.mjs:305` | ○ | ● `C7-01@257` | ○ |
| `editPost` PATCH /posts/:id | ○（C1 未单列，按统一守卫推断） | ○ | ● `community-service.test.mjs:310`；`community-atomic.test.mjs:306` | ● `community-moderation-revision-guard.test.mjs:58,71,72`（`REVISION_CONFLICT`） | ○ | ○ | ○ | ○ |
| `deletePost` DELETE /posts/:id | ○ | ○ | ● `community-atomic.test.mjs:306-307` | ● `community-moderation-revision-guard.test.mjs:94`（`OBJECT_UNAVAILABLE`） | ○ | ○ | ○ | ○ |
| `listComments` GET /posts/:id/comments | ● `C1-19@82` | ○ | ● `community-moderation-takedown.test.mjs:171` | — | ○ | ○ | ○ | ○ |
| `createComment` POST /posts/:id/comments | ● `C1-20@83` | ○ | ● `community-atomic.test.mjs:204`、`community-moderation-gate-wiring.test.mjs:291` | ● `C6-07@237`（同族幂等） | ○ | ○ | ● `C7-10@266` | ○ |
| `getComment` GET /comments/:id | ● `C1-21@84` | ○ | ● `C2-18@120`；`community-atomic.test.mjs:307` | — | ○ | ○ | ○ | ○ |
| `editComment` PATCH /comments/:id | ○ | ○ | ● `community-service.test.mjs:310`（同族） | ● 同 `revision-guard:58` | ○ | ○ | ○ | ○ |
| `deleteComment` DELETE /comments/:id | ○ | ○ | ● `community-atomic.test.mjs:307` | ● 同 `revision-guard:94` | ○ | ○ | ○ | ○ |
| `likePosts` PUT /posts/:id/like | ● `C1-22@85` | ○ | ○（无权/不存在因同形由 `C2-17@119` 覆盖） | ○ | ○ | ○ | ○ | ○ |
| `unlikePosts` DELETE /posts/:id/like | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| `likeComments` PUT /comments/:id/like | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| `unlikeComments` DELETE /comments/:id/like | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| `createReport` POST /reports | ● `C1-23@86` | ○ | — | ● `C6-08@238`/`C6-09@239`（同键重放 201；异体 409 见 C6-03 同族） | ○ | ○ | ● `C7-12@268` | ○ |
| `getOwnReport` GET /reports/:id | ● `C1-24@87` | ○ | ● `C2-21@123` | — | ○ | ○ | ● `C7-04@260` | ○ |
| `grantCommunityMediaAccess` POST /community/media-access | ● `C1-14@77` | ○ | ● `C5-07@210` | ○ | ○ | ○ | ○ | ○ |
| `readCommunityMediaContent` GET /community/media/:grant_id/content | ● `C1-15@78` | ○ | ● `C5-05@208`、`E2-02@291`（篡改 token 同形 404） | — | ○ | ○ | ● `C5-04@207`、`C5-06@209` | ○ |

注：`community-chain-client.test.mjs:210-432` 的 403 断言是**小程序端对 403 的处置**（不清会话、不落 toast），不是服务端 403 的产生；不要记到 API 列。
点赞族（`like/unlike`）在 failmatrix 只有 `C1-22` 一条游客 401，**锁与并发语义零覆盖**。

### 2.3 favorites / history（5 个 operation）

| operation | 401 | 403 | 404 | 409 | 503 | 超时 | 400 | 429 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `listFavorites` GET /favorites | ● `C1-01@64`；`favorites-http.test.mjs:270,398` | ● `C4-06@179` | — | — | ● `favorites-http.test.mjs:318`；`C4-18@201`（200 对照） | ○ | ● `C7-05@261`~`C7-08@264` | ○ |
| `createFavorite` POST /favorites | ● `C1-02@65` | ○ | ○ | ● `C6-03@229`（同键异体）；`favorites-http.test.mjs:155` | ● 同 `:318` | ○ | ● `C6-04@230`、`C7-13@269` | ○ |
| `deleteFavorite` DELETE /favorites/:id | ● `C1-03@66` | ○ | ● `C2-14@116`；`favorites-http.test.mjs:188`（他人）、`:189`（不存在）、`:196`（他人+旧 ETag）、`:225`（二次删） | ● `favorites-http.test.mjs:211,390`（`REVISION_CONFLICT`）；`C6-*`；428 见下 | ● 同 `:318` | ○ | ● `favorites-http.test.mjs:382`（**428** `REVISION_REQUIRED`）、`C7-02@258` | ○ |
| `listHistory` GET /history | ● `C1-04@67`（该文件**没有** `listHistory` 的 401 断言；原挂在这里的 `history-http.test.mjs:477` 实为 DELETE 面，已移到下一行） | ○ | — | — | ● `history-http.test.mjs:548,751` | ○ | ● `C2-23@128`（200 对照） | ○ |
| `deleteHistory` DELETE /history/:id | ● `C1-05@68`；`history-http.test.mjs:477`（匿名 DELETE ⇒ 401，全文件唯一一条 401） | ○ | ● `C2-15@117`；`history-http.test.mjs:381,382,388,743` | ● `history-http.test.mjs:411,469` | ● 同 `:548` | ○ | ● `history-http.test.mjs:461`（428） | ○ |

注：这两域是 failmatrix 覆盖**最厚**的域（C1/C2/C4/C6/C7 全有），也是唯二把 **428** 写进断言的域。另：全页的 `C1-xx@NN` 定位符已于 2026-10-23 整体订正（自 `#449` 起 `cases.mjs` 整体下移 12 行，原 `@行` 全部偏小 12），65 个 id 的「改前 → 改后」对照见文末**附录 A**；`listHistory` 那一格原挂的 `history-http.test.mjs:477` 实为 DELETE 面，已移到 `deleteHistory` 行。

### 2.4 messages（3 个 operation）

| operation | 401 | 403 | 404 | 409 | 503 | 超时 | 400 | 429 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `listMessages` GET /messages | ● `C1-06@69` | ○ | — | — | ● `messages-http.test.mjs:189-198`（real 无 pool 整域 503） | ○ | ● `C2-24@132`（200 对照） | ○ |
| `getUnreadCount` GET /messages/unread-count | ● `C1-07@70` | ○ | — | — | ● 同 `:192` | ○ | — | ○ |
| `markMessageRead` PUT /messages/:id/read | ● `C1-08@71` | ○ | ● `C2-16@118`；`messages-pg.mjs:284`（他人）、`:290`（不存在）；`rejections-http.mjs:445` | ● `messages-read-version.test.mjs:104,173,174,216,217`；`messages-concurrency.test.mjs:59,60,111`（`REVISION_CONFLICT`）、`:204`（`REQUEST_IN_PROGRESS`）、`:224`（`IDEMPOTENCY_CONFLICT`） | ● 同 `:193` | ○ | ● `C7-03@259`；`messages-security.test.mjs:256` | ○ |

注：`messages-pg.mjs:284` 是**真库**脚本（`tests/integration/*-pg.mjs`，需 PG），不在 `test:integration:http` 名单内（`package.json` 的 `test:integration:http` 未列它）——即「他人消息 404」的**真库**证据只在 PG 流水线跑，HTTP 面的同形断言由 `C2-16@118` 与 `rejections-http.mjs:445`（回环、无 PG）承担。

### 2.5 knowledge（5 个 operation，含 `verifyRegistration`）

| operation | 401 | 403 | 404 | 409 | 503 | 超时 | 400 | 429 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `listKnowledge` GET /knowledge | ● `C1-34@97`；`knowledge-herbicides-http.test.mjs:152,156` | ○ | — | — | ○ | ○ | ● `knowledge-api.test.mjs:48-49`、`:73,76`（`INVALID_CURSOR`）、`:82` | ○ |
| `getKnowledge` GET /knowledge/:id | ○（C1 未单列） | ○ | ● `knowledge-public-invalidation-wiring.test.mjs:136,137,221,418`；`knowledge-herbicides-http.test.mjs:224,364,367` | ● `knowledge-applicability-screen.test.mjs:88,113,266`（`OBJECT_UNAVAILABLE`/`SOURCE_CONFLICT`） | ○ | ○ | ● `knowledge-applicability-screen.test.mjs:285`（422 `INPUT_UNCERTAIN`） | ○ |
| `listHerbicides` GET /herbicides | ● `C1-33@96` | ○ | — | — | ○ | ○ | ○ | ○ |
| `getHerbicide` GET /herbicides/:id | ○ | ○ | ● `knowledge-herbicides-http.test.mjs:224,364` | ○ | ○ | ○ | ● 同 `:367`（非法筛选 404/400 双口径） | ○ |
| `verifyRegistration` POST /registrations/verify | — | — | — | — | — | — | — | — |

注：`verifyRegistration` **路由未装配**（`docs/architecture/contract-status.json` 中该 operation `status: planned`，blocker 原文「领域库层已有实现或数据（packages/reference、packages/knowledge），HTTP 路由未装配」）⇒ 该行 8 列**全部不适用**，且它是「矩阵里唯一整行为空」的 operation。failmatrix 也未引用 `/registrations/verify`。

### 2.6 recognitions（4 个 operation）

| operation | 401 | 403 | 404 | 409 | 503 | 超时 | 400 | 429 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `createRecognition` POST /recognitions | ● `recognitions-api.test.mjs:114` | ● `miniprogram-identify.test.mjs:1400,1401`（`CONSENT_REQUIRED` 403，客户端侧断言） | ○ | ● `recognitions-api.test.mjs:156`、`:394`（`[202,409]` 并发）、`recognitions-http.mjs:188` | ● `recognitions-api.test.mjs:686`；`recognitions-candidates-selection.test.mjs:693` | ● `recognitions-api.test.mjs:298-305`（`state=timed_out` + `PROVIDER_TIMEOUT`） | ● `recognitions-api.test.mjs:124,130,133,146` | ○ |
| `getRecognition` GET /recognitions/:id | ● `recognitions-api.test.mjs:115` | ○ | ● `recognitions-api.test.mjs:293`；`recognitions-http.mjs:120`（他人）、`:143`（已删）；`recognition-chain-e2e.mjs:452` | — | ○ | ○ 未取得（原引 `recognitions-api.test.mjs:116` 实为 `GET /jobs/{id}` 的 401，非本 operation、非超时；见下注） | ○ | ○ 未取得（原引 `:592,597,650` 实为 PATCH selection 的 400 ×2 与非 UUID 的 400\|404 二择，均不证明 GET 识别 429；见下注） |
| `deleteRecognition` DELETE /recognitions/:id | ○ | ○ | ● `recognition-chain-e2e.mjs:459`（他人历史不可删） | ● `recognitions-http.mjs:224`（取消终态 409） | ○ | ○ | ○ | ○ |
| `selectSpecies` PATCH /recognitions/:id/selection | ● `C10-03@313`（游客 PATCH ⇒ 401 `SESSION_REQUIRED`；C10 由 #449 引入，**晚于初稿时点**） | ○ | ● `recognitions-api.test.mjs:542`（他人选择 ⇒ 404 `NOT_FOUND`，在 `:540-549` 循环内） | ● `recognitions-api.test.mjs:587-588`（`If-Match: "9"` ⇒ 409 + `REVISION_CONFLICT`） | ○ | ○ | ● `recognitions-api.test.mjs:592,597`（非法 `If-Match`／多带 `rank` ⇒ `INVALID_REQUEST`） | ○ |

注：**该域 4 行原记「全部不在 failmatrix 表内」**——**2026-10-22 回写**：#449 之后 `cases.mjs` 的 C10-01..04（游客 401）与 C11-05..10（归属 404）已覆盖本域 4 个 operation 的这两列（`cases.mjs:311-314`、`:347-352`）；本表的逐格判定仍以域内文件为主，证据在 `tests/unit/recognitions-api.test.mjs` 与 `tests/integration/recognitions-http.mjs`（后者在 `test:integration:http` 名单内）。
`selectSpecies` 原记「**整行 8 列零断言**」的两个 operation 之一——**2026-10-22 回写（B2）：该结论不成立**。**404／409／400（＋428）在初稿时点就有断言**（`:542`；`:587-588`；`:592,597`；428 见 `:582`），是初稿漏收；**401 列晚于初稿时点**——由 #449 的 `C10-03@313` 补上（`d4d48088` 时点该文件的 401 只有 POST /recognitions、GET /recognitions/:id、GET /jobs/:id 三条，不含 `PATCH …/selection`）。仍未取得的是 403／503／超时／429 四列。另一个「整行为空」的 `verifyRegistration` 仍不适用（未装配）。

**P2 订正（2026-10-22，监工批复 `supervisor-1022-0541-pr438`）：第 166 行 429 / 超时两格原引文实读**

1. `recognitions-api.test.mjs:592`：`PATCH /api/v1/recognitions/{id}/selection` 带 `if-match: 1`（缺引号）⇒ **400** `INVALID_REQUEST`（`:589-593`）——属 `selectSpecies` 行的 400 列，不是 `getRecognition` 的 429。
2. `:597`：同 `PATCH` 路由，body 多带 `rank` ⇒ **400** `INVALID_REQUEST`（`:594-598`）——同上。
3. `:650`：`GET /api/v1/recognitions/not-a-uuid` ⇒ `assert.ok([400,404].includes(...))`，即 **400 或 404 二择**（`:648-650`）——既非确定 400，更不是 429。
4. `:116`：未带 token 的 `GET /api/v1/jobs/{id}` ⇒ **401**（`:113-117`；`:114`＝POST /recognitions 401、`:115`＝GET /recognitions 401）——属 `/jobs` 域的 401，与本行「超时」无关。
5. 本域两文件（`tests/unit/recognitions-api.test.mjs`、`tests/integration/recognitions-http.mjs`）grep `429` 与 `RATE_LIMIT` **均零命中** ⇒ 429 在本格无断言。

⇒ 两格均改记 **○ 未取得**；未补测试、未改其他行。`:592` / `:597` **未**搬入 `selectSpecies` 行（该行 400 列仍为 ○），事实如实登记在此。

### 2.7 ocr（5 个 operation）

| operation | 401 | 403 | 404 | 409 | 503 | 超时 | 400 | 429 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `createOCR` POST /ocr | ● `ocr-http.mjs:1500` | ○ | ○ | ● `ocr-http.mjs:1431` | ● `ocr-http.mjs:1545,1560`（real 缺凭据受理前 503） | ● `ocr-http.mjs:2058`（`timed_out` + `PROVIDER_TIMEOUT`） | ● `ocr-http.mjs:1468,1475,1482` | ○ |
| `getOCR` GET /ocr/:id | ○ | ○ | ● `ocr-http.mjs:1337`（他人）、`:1338`（不存在）、`:1033`（等待期 404 语义） | — | ● `ocr-store-pg-tables-missing.test.mjs:159`（表未迁移走 503 通道） | ● `ocr-http.mjs:1057`（`GET /jobs/{id}` 200 读面） | ○ | ○ |
| `deleteOCR` DELETE /ocr/:id | ○ | ○ | ● `ocr-http.mjs:1355`（他人删） | ● `ocr-http.mjs:1399`（If-Match 不符）、`:1996`（终态再取消） | ○ | ○ | ● `ocr-http.mjs:1395` | ○ |
| `correctOCR` PATCH /ocr/:id/correction | ○ | ○ | ● `ocr-http.mjs:1351`（他人改） | ● `ocr-http.mjs:1385` | ○ | ○ | ● `ocr-http.mjs:1378` | ○ |
| `verifyOCR` POST /ocr/:id/verify | ○ | ○ | ●（同族归属由 `:1337-1358` 覆盖 GET/PATCH/DELETE，未单列 verify） | ● 同 `:1431` | ○ | ○ | ● `ocr-http.mjs:1371`（**428** 缺 If-Match） | ○ |

注：`ocr-http.mjs` 在 `test:integration:http` 名单内（无 PG、回环）⇒ 该域断言**在 CI 跑**。
但 `ocr` 的 401 只有 1 条（`:1500` 五个端点统一循环之一），403 全族为 ○（OCR 域无 scope 断言）。

### 2.8 speech（4 个 operation）

| operation | 401 | 403 | 404 | 409 | 503 | 超时 | 400 | 429 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `createTranscription` POST /speech/transcriptions | ● `speech-http.mjs:263`（多方法循环） | ○ | ○ | ● `speech-http.mjs:325` | ● `speech-http.mjs:472` | ● `speech-http.mjs:626`（`hangState.error_code = PROVIDER_TIMEOUT`）、`:648`（终态含 `timed_out`） | ● `speech-http.mjs:411,422,739` | ○ |
| `getTranscription` GET /speech/transcriptions/:id | ○ | ○ | ● `speech-http.mjs:210,214,217,225,226` | — | ○ | ○ | ● `speech-http.mjs:415` | ○ |
| `deleteTranscription` DELETE /speech/transcriptions/:id | ○ | ○ | ● `speech-http.mjs:237,238` | ● `speech-http.mjs:289,300` | ○ | ○ | ● `speech-http.mjs:285,298` | ○ |
| `confirmTranscription` PATCH /speech/transcriptions/:id/confirmation | ● `speech-http.mjs:260`（在 `:256-265` 无会话循环内 ⇒ 401 `SESSION_REQUIRED`） | ○ | ● `speech-http.mjs:241-249`（他人／不存在 ⇒ 404 且 `error` 逐字段同形） | ● `speech-http.mjs:288-290`（`If-Match: "99"` ⇒ `REVISION_CONFLICT`） | ○ | ○ | ● `speech-http.mjs:283-287`（非法 `If-Match`）、`:425-431`（body 校验） | ○ |

注：`speech-service.test.mjs:1118` 断言「失败或已删除都不得让同键重放变成 404」——这是**幂等与 404 的负交叉**，很关键但不属任一单格。
**2026-10-22 回写（B2）**：`confirmTranscription` **有** 401/404 断言——该端点已在无会话循环里（`speech-http.mjs:256-265`，PATCH 在 `:260`），他人／不存在的确认请求在 `:241-249` 成对断言 404 同形；缺 `If-Match` 的 428 见 `:280-282`（不在 8 列内）。原记「该端点未在 `:263` 循环里」与实读不符；理由同上，是初稿漏收，不是本轮新增用例。原 409 格引的 `:784,791` 实为 `/jobs/{id}/cancel` 的两条取消断言，本行已改引 `:288-290`。

### 2.9 tts（1 个 operation）

| operation | 401 | 403 | 404 | 409 | 503 | 超时 | 400 | 429 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `createSynthesis` POST /speech/synthesis | ● `tts-http.mjs:311,313`（`SESSION_REQUIRED` / `SESSION_EXPIRED`） | ● `tts-jobs-http.test.mjs:510,570`（real 未接真实依赖 fail-closed） | ● `tts-http.mjs:304,305`；`tts-content-wiring.mjs:242,251` | ● `tts-http.mjs:370,409`；`tts-content-wiring.mjs:234,258,273`；`tts-cancel.test.mjs:257,519`；`tts-jobs-http.test.mjs:309` | ● `tts-content-wiring.mjs:199`；`tts-jobs-http.test.mjs:510,570`（`:328` 是「取消已接线不得回 503」的负断言） | ● `tts-service.test.mjs:640-644`、`:1130-1182`（读面超时裁定 `timed_out`） | ● `tts-http.mjs:398`（422）、`tts-jobs-http.test.mjs:230,235,432,442`、`tts-cancel.test.mjs:404`（428） | ○ |

注：`tts` 是单 operation 域，但断言密度最高（8 列里 7 列有 ●）。429 仍为 ○。

### 2.10 moderation（2 个 operation）

| operation | 401 | 403 | 404 | 409 | 503 | 超时 | 400 | 429 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `hidePost` POST /admin/posts/:id/hide | ○ | ● `C3-*` 系列（后台 403 统一族 `cases.mjs:126-137`） | ● `admin-http.mjs:494-497`（隐藏后他人读 404） | ● `community-moderation-revision-guard.test.mjs:58,71,72,94` | ● `admin-http.mjs:366,375` | ○ | ○ | ○ （⚠ 本行陈述与本版实测不符，见 docs/verification/gy-r68-aa-admin-disable-20261027.md §已知陈旧陈述）|
| `listAuditEvents` GET /admin/audit-events | ● `C1` 族（后台未登录） | ● `C3-04@141`、`C3-15@152`（200 对照）、`C3-26@163` | — | — | ○ | ○ | ● `C7` 族游标口径 | ○ |

注：审核**前置门禁**（先审后发）不是契约 operation，其断言在 `community-moderation-read-recheck.test.mjs:54,85,112`、`community-moderation-gate-wiring.test.mjs:125,190,291`（均为 404 形态）——计入 community 域的 404 列，不单独成行。

### 2.11 consents（3 个 operation）

| operation | 401 | 403 | 404 | 409 | 503 | 超时 | 400 | 429 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `listConsents` GET /me/consents | ● `C1-31@94`；`privacy-consent-wiring.test.mjs:139` | ● `privacy-egress-http.test.mjs:117,133,153,157`（含 `ACCOUNT_INACTIVE`） | —（端点无 `:id`） | — | ● `privacy-consent-wiring.test.mjs:307`；`privacy-egress-http.test.mjs:185` | ○ | ○ | ○ |
| `grantConsent` POST /me/consents | ○ | ● `privacy-consent-wiring.test.mjs:131,159,199,212,260` | — | ● `media-consent-wiring.test.mjs:214` | ● 同 `:307` | ○ | ● `C7` 族同构 | ○ |
| `withdrawConsent` DELETE /me/consents/:purpose | ○ | ● `media-consent-wiring.test.mjs:231,269,303,316` | — | ● `media-consent-wiring.test.mjs:214`；blocker 记录「依赖未清时 409 `OBJECT_UNAVAILABLE`」 | ● `privacy-synthesis-egress-retryable.test.mjs:66,89`（正反两向） | ○ | ○ | ○ |

注：consents 域**没有跨用户断言**，但这是**结构性不适用**：三个端点都不接收 subject 参数，主体一律取自 token（`C1-31@94` 已钉住未登录面）。

### 2.12 其余域（每域一行汇总）

| 域 | 断言密度（来自 `tests/**` 状态码出现次数，粗筛） | 代表证据 | 结论 |
| --- | --- | --- | --- |
| media（5 ops） | 401:5 403:12 404:37 409:21 503:54 | `media-http-upload.test.mjs:116`（401）；`media-http-access.test.mjs:168`（他人 404）、`:404,427,433,439,445`（无内容/未发布/未过审/版本不符同形 404）；failmatrix `C1-09..13`、`C2-11..13`、`C5-01..03`、`C5-10` | **齐**（唯一把「未过审」写成 404 的域） |
| jobs（2 ops） | 401:3 404:30 409:18 503:43 | `jobs-http.mjs:217-237`（他人/不存在/未接线 kind **三类同形 404**）、`:266`（他人取消 404）、`:278`（无会话 401） | **齐**；failmatrix 侧由 C10-15/16（游客面）与 C11-01..04（归属面）覆盖 401/404 两列（#449 之前是零覆盖） |
| conversations（7 ops） | 400:20 404:37 409:11 503:10 | `conversation-http.test.mjs:281,282,288,292`（他人读/删/轮次 404）、`:294`（往他人会话写 404）、`:239`（方法不符 404） | **齐**（归属最完整的一域） |
| deletion / exports（3 ops） | 401:58 403:14 404:17 409:8 503:17 | `account-deletion-http.mjs:202,316,321,326`（四类 401）、`:359`（换发后旧 bearer 立即失效）、failmatrix `C4-10..15` | **齐** |
| catalog / public / profile（7 ops） | 400:13 401:6 404:5 503:4 | `C1-25..26,32`（游客 401）；`C2-22` | **基本齐**，无写面冲突 |
| admin 内容面（24 ops：sources/knowledge/registrations/restrictions） | 401:82 403:78 404:79 409:87 503:135 504:16 | 守卫 `routes/admin.ts:166-167`（`readGuards`/`writeGuards`）；`C3-01..03,09..11`（403）、`C3-14..17`（200 对照）、`C3-22`（404） | **齐**；本域 504 只在 PG 锁通道；用户面同步读路径的 504 由 §4.1 #2 回写补上（#442／#447） |
| admin 运维面（10 ops：accounts/jobs/flags/audit/categories/hide） | 同上 | `admin.ts:287,269,275,290,296,313,319,334,340,354,367` 每条均 `guards.requireAdmin` | **齐** |
| admin auth（3 ops） | — | `routes/admin-auth.ts:47,89,104` | **齐** |
| community media（2 ops） | — | 见 §2.2 末两行 | **齐** |

---

## 3 权限口径三查

### 3.1 一查：归属越权（A 读 B 的对象）是否有负控制断言

**结论：11 个高频域中 9 个有负控制断言，2 个结构性不适用；但「同形」是否逐字断言分三档。**

| 域 | 负控制断言（他人 → 404） | 是否断言「与不存在**同形**」 |
| --- | --- | --- |
| favorites / history | `favorites-http.test.mjs:188,189,196`；`history-http.test.mjs:381,382,388,743` | **是**（同一处成对断言 foreign/absent） |
| messages | `messages-pg.mjs:284,290`（真库）；`rejections-http.mjs:445`（回环） | **是**（`messages-pg.mjs:299` 另断言 `error.code` 逐字一致） |
| community | `community-atomic.test.mjs:88,160,204,306,307`；`community-moderation-takedown.test.mjs:170,171,229`；`read-recheck:54,85,112`；`gate-wiring:125,190,291`；`community-filter-pg.mjs:474-475`（他人读他人举报 404） | **否**（多数只断言 404，未逐个比对封套） |
| media | `media-http-access.test.mjs:168` | 部分 |
| ocr | `ocr-http.mjs:1337,1338,1351,1355,2025` | **是**（`:1358` 明确记录「错误体与不存在同形」） |
| speech | `speech-http.mjs:225,226,237,238` | **是**（`:222` 组名即「与『不存在』同形」） |
| recognitions | `recognitions-http.mjs:120,143`；`recognition-chain-e2e.mjs:452,459` | 部分 |
| tts | `tts-jobs-http.test.mjs:218,219,242` | **是**（成对 foreign/missing） |
| conversations | `conversation-http.test.mjs:281,282,288,292,294` | **是**（成对 otherRead/absentRead） |
| jobs | `jobs-http.mjs:217-237` | **是**（三类同形，最完整） |
| knowledge | —（公开读面，无按用户归属的行） | 不适用 |
| consents | —（端点不接收 subject） | 不适用 |

**缺口**：community 的「同形」力度弱于 favorites/history/jobs；`editPost/editComment/deleteComment` 的他人拒绝只由原子性测试间接覆盖，**没有逐个 operation 的负控制**。

### 3.2 二查：`/admin/*` 是否全部走角色校验

**结论：全部走 `guards.requireAdmin`，无裸路由。**

守卫来源：`services/api/src/routes/admin.ts:171` 收 `guards: AuthGuards`，`:179-180` 定义
`readGuards = { preHandler: [guards.requireAdmin, guards.requireScope(descriptor.readScope)] }`、
`writeGuards = { preHandler: [guards.requireAdmin, guards.requireScope(descriptor.writeScope)] }`。

| 路由文件:行 | 路径 | 守卫 |
| --- | --- | --- |
| `admin.ts:172` | GET `/admin/sources` | `sources.readGuards` |
| `admin.ts:175` | POST `/admin/sources` | `sources.writeGuards` |
| `admin.ts:178/181` | GET/PATCH `/admin/sources/:id` | `readGuards` / `writeGuards` + `uuidIdParams` |
| `admin.ts:184/187` | POST `/admin/sources/:id/publish\|withdraw` | `writeGuards` |
| `admin.ts:192-207` | `/admin/knowledge` 6 条 | 同构（`knowledge.readGuards/writeGuards`） |
| `admin.ts:212-227` | `/admin/registrations` 6 条 | 同构 |
| `admin.ts:232-247` | `/admin/restrictions` 6 条 | 同构 |
| `admin.ts:301` | GET `/admin/audit-events` | `requireAdmin + requireScope('audit:read')` |
| `admin.ts:287/273` | GET `/admin/categories`、PATCH `/admin/categories/:id` | `requireAdmin + OPS_SCOPES.listAdminCategories/editCategory` |
| `admin.ts:289/294` | GET `/admin/accounts`、POST `/admin/accounts/:id/suspend` | `listAdminUsers/suspendUser` |
| `admin.ts:312/317` | GET `/admin/jobs`、POST `/admin/jobs/:id/cancel` | `listAdminJobs/cancelAdminJob` |
| `admin.ts:500/505` | GET `/admin/feature-flags`、PUT `/admin/feature-flags/:key` | `listFlags/setFlag` |
| `admin.ts:353` | GET `/admin/flag-audit-events` | `listFlagAuditEvents` |
| `admin.ts:365` | POST `/admin/posts/:id/hide` | `hidePost` |
| `admin-auth.ts:47/89/104` | POST/GET `/admin/auth/session`、POST `/admin/auth/logout` | 登录/会话/登出专用（不套 admin scope，语义正确） |

断言侧：failmatrix C3 族 27 条（`cases.mjs:126-151`）覆盖 6 个后台面「用户会话 → 403 `SCOPE_DENIED`」与「后台缺 scope → 403」与「有 scope → 200」；`auth-routes.test.mjs:202` 断言「客户端自称 `x-role: admin` 无效 → 403」。

**发现（非阻塞）**：`admin.ts:151` 的注释说明路径为**逐条字面书写**，静态路由清单工具依赖这一形态；新增后台路由必须同样逐条写，否则清单工具会漏收（这是一条**易复发**的约定，无测试钉住字面书写形态）。

### 3.3 三查：注销后 token 失效是否有断言

**结论：有，且覆盖三种失效源（登出 / token 换发 / epoch 变更）。**

| 场景 | 断言 | 语义 |
| --- | --- | --- |
| 登出后同 token 再用 | `auth-routes.test.mjs:211-228`（`:225` 401、`:226` `SESSION_EXPIRED`） | 登出即撤销会话 |
| 登出后重放原 code/key | `auth-routes.test.mjs:300-338`（`:332` 401 `SESSION_EXPIRED`、`:337` `activeCount() === 0`） | 不得再签发可用凭据 |
| 同键重放换发令牌 | `auth-routes.test.mjs:266-297`（`:291` 旧 token 401、`:292` 新 token 200、`:289` 会话数仍 1） | 一会话一活 token（`:364` 另断言 `[200,401]`） |
| epoch 变更（撤销） | `auth-routes.test.mjs:230-243`（`:240` 403 `ACCOUNT_INACTIVE`） | 撤销走 403 不是 401 |
| 注销回执 bearer | `account-deletion-http.mjs:359`（`换发后旧 bearer 必须立刻失效`） | 回执专用 bearer 同样失效 |
| 后台登出 | failmatrix `C3-12@149`（403 对照）、`C3-23@160` | 后台 401 面 |

**判定**：A4 可判「齐」。唯一未覆盖的是**跨进程/跨实例**的撤销传播（会话存内存时，另一个实例的 token 仍有效）——属 `#313`／持久会话范围，本页不外推。

---

## 4 结论

### 4.1 不可回归的风险清单（完全无断言的失败族，按严重度前 10）

排序依据：`能造成越权或数据泄露 > 能造成假绿 > 能造成线上 500/静默成功`，再看是否有实现（有实现无断言 > 无实现）。

| # | 风险 | 证据（现状） | 严重度 |
| --- | --- | --- | --- |
| 1 | **限流 429 全族零 API 断言** → **已关闭（#442＋#450，2026-10-22）**：`loginWechat` 是唯一产出 429 的路径（`services/api/src/auth/wechat.ts:121` 抛 `RATE_LIMITED`），现在「收到上游 45011 之后的对外行为」有 HTTP 面断言（429 `RATE_LIMITED`＋`Retry-After` 正整数秒＋`retryable`＋封套完整＋失败不落幂等台账） | `tests/unit/gy-i22-rate-and-timeout.test.mjs:77`（`:113` 状态码、`:139-141` `Retry-After` 必须正整数秒、`:147` 同键重试仍 429；#442 建文件、#450 把该头断言从「无该头」改为「必须整数秒」）；实现侧 `services/api/src/errors.ts:82-86`＋`app.ts:2057-2058`（#450 统一出口单一取值；初稿时点为 `1917-1918`，`7dd3d699` 上该段已下移） | **已关闭**（原：高；「连打真实触发限流」的窗口仍未取得，见 §5.4） |
| 2 | **同步面 504 `PROVIDER_TIMEOUT` 零断言** → **已关闭（#442＋#447，2026-10-22）**：用户面同步读路径在超时族 SQLSTATE 下折叠成 504 + `PROVIDER_TIMEOUT` 已有用例（初稿时点 504 只在后台 PG 锁通道：`admin-flags-pg.mjs:571-573`、`admin-flags-pg.test.mjs:373-382`、`account-authority-pg.test.mjs:120-121`、`admin-accounts-directory.test.mjs:263`、`db-error-retryable-classification.test.mjs:130`） | `tests/unit/gy-i22-rate-and-timeout.test.mjs:218-273`（`:247` 504、`:251` 错误码，注入 `57014`／`55P03`，`:235` 先证明合成登录 200）；`tests/unit/knowledge-herbicides-http.test.mjs:436-439`（#447 把 57014/55P03 ⇒ 504 且 `retryable:true` 落进 `services/api/src/knowledge/service.ts:125-129`） | **已关闭**（原：高；真实锁竞争的触发条件仍未取得，见 §5.5） |
| 3 | **`selectSpecies` 整行 8 列零断言**（`PATCH /recognitions/:id/selection`） → **已关闭（404/409/400/428 页面过期；401 由 #449 补上）**：404／409／400（＋428）在**初稿时点就有断言**，是漏收；**401 列晚于初稿时点**——由 #449 的 C10-03 引入（`d4d48088` 时点 `recognitions-api.test.mjs` 的 401 只有 POST /recognitions、GET /recognitions/:id、GET /jobs/:id 三条，不含 `PATCH …/selection`） | §2.6 第 4 行（`recognitions-api.test.mjs:542` 他人 404／`:587-588` 409／`:592,597` 400；428 另见 `:582`）；401 见 `C10-03@313`（#449 引入） | **已关闭**（原：高；403/503/超时/429 四列仍 ○） |
| 4 | **failmatrix 完全不覆盖异步 AI 域与 `/jobs`** → **已关闭（#449，2026-10-22）**：`cases.mjs` 新增 C10 游客面 23 条 + C11 归属面 39 条，矩阵 168 → **230** 条，`MIN_CASES` 同步到 230（只增不减） | `tests/failmatrix/cases.mjs:303-333`（C10）、`:335-384`（C11，含 5 条属主正控制）、`tests/unit/gy-i22-failmatrix.test.mjs:35`；CI 读数 `Failmatrix regression` run `39778342989`（headSha `1fbe7572`）success。**仍未进矩阵的域**：`me/exports`、`public/home`、`privacy-policy`、`registrations/verify`（grep 空结果） | **已关闭**（原：高；剩余 4 类域仍无 failmatrix 覆盖，见 §4.2 备注） |
| 5 | **OCR 403 全族 ○**（5 个 operation 无任何 scope/授权断言） | §2.7 | 中高 |
| 6 | **点赞族 `like/unlike` 只有 1 条游客 401**，锁/并发/重复点赞语义零覆盖 | `C1-22@85` 是唯一一条 | 中高 |
| 7 | **community「同形」弱于其他域**：多数只断言 404，未成对比对封套（对比 `messages-pg.mjs:299`、`speech-http.mjs:222`） | §3.1 | 中 |
| 8 | **`confirmTranscription` 无 401/404 断言**（未进 `speech-http.mjs:263` 的循环） → **已关闭（页面过期，不是本轮新增用例）**：该端点早就在无会话循环里，404 也成对断言 | §2.8 第 4 行（`speech-http.mjs:260` 在 `:256-265` 循环内；`:241-249` 他人／不存在同形 404；`:288-290` 409；428 见 `:280-282`） | **已关闭**（原：中） |
| 9 | **`verifyRegistration` 整行不适用**（`planned`，HTTP 未装配）且 failmatrix 无「未装配即 404/不泄露」的形态断言 | `contract-status.json` blocker | 中（是"没做"，不是"做错"，但会被误读成已覆盖） |
| 10 | **`loginAdmin` 的 403/404/409/503/超时/429 全 ○**：凭据错误沿用 401 `SESSION_REQUIRED`，但**没有一条断言钉住这个"故意不合契约直觉"的选择** | `contract-status.json` loginAdmin blocker；§2.1 | 中（后台入口，回归后可能变成 500） |

补充（不计入前 10，但需登记）：
- **413 `MEDIA_TOO_LARGE` / 415 `MEDIA_TYPE_UNSUPPORTED` / 422 三码在 failmatrix 被完全跳过**：C 族只覆盖 400/401/403/404/409/503，`contract.ts:20-22` 的 413/415/422 在矩阵中**没有列**（本页按派单只做 8 列，故未成列；这是矩阵口径本身的缺口）。
- `seams.mjs:364-365`（D 族）断言模型超时 ⇒ `quarantined` + `PROVIDER_TIMEOUT`，属受信 seam 而不是 HTTP 面。

### 4.2 最短可关闭 #22 的 3 件事

> 三件都**不需要真实设备**；只有第 2 件需要真库。
>
> **2026-10-22 回写（B2）**：下列三件**均已落地**（第 1 件 #442／#450／#447；第 2 件 #449；第 3 件更准确地说——404／409／400（＋428）与 `confirmTranscription` 的 401/404 本来就有断言，`selectSpecies` 的 401 由 #449 的 C10-03 补上，见下）。
> 但**「三件做完」不等于 #22 可关闭**：11 张验收前置（#5 #8 #9 #10 #12 #14 #15 #16 #17 #18 #19）仍全部 OPEN，且 §5 的真实微信侧限流／真实供应商超时／真机读数仍未取得。

1. **把 429 与「同步面 504」补成可执行断言（1 个文件，无 PG、无真机）** —— **已完成（#442 建 `tests/unit/gy-i22-rate-and-timeout.test.mjs`；#450 补 `Retry-After` 整数秒；#447 把 57014/55P03 的 504 分档落进 `knowledge/service.ts`）**
   - 位置：`tests/failmatrix/cases.mjs` 新增 F 族两批（`C8` 限流、`C9` 超时），或最小改动——在 `tests/unit/gy-i22-failmatrix.test.mjs` 旁新增 `tests/unit/gy-i22-rate-and-timeout.test.mjs`。
   - 断言对象：`services/api/src/auth/wechat.ts:121`（429 `RATE_LIMITED`，`retryable` 与 `Retry-After`/`retryable` 字段）；同步面任一走 DB 的 GET 在锁超时下 504 `PROVIDER_TIMEOUT`（可复用 `tests/unit/admin-flags-pg.test.mjs:373` 的映射入口，但**不要**改成用户面锁，改为对一个注入 `57014` 的桩池断言封套）。
   - 成本：单文件；**不需真库**（57014/55P03 可在映射层注入，参考 `db-error-retryable-classification.test.mjs:130` 已建立的注入范式）。
   - 是否需要真实设备/真库：**都不需要**。
   - **落地读数**：`gy-i22-rate-and-timeout.test.mjs:77`（429）、`:218-273`（504）；`knowledge-herbicides-http.test.mjs:436-439`（504 + `retryable:true`）。

2. **把异步 AI 域与 `/jobs` 拉进 failmatrix（解决「假绿」结构缺口）** —— **已完成（#449：C10 23 条 + C11 39 条，`MIN_CASES` 168 → 230）**
   - 位置：`tests/failmatrix/cases.mjs`（新增 `C10` 游客面 + `C11` 归属面）与 `tests/failmatrix/world.mjs`（需要 stub 世界的 OCR/转写/识别/合成资源种子）；参照 `tests/integration/ocr-http.mjs:1500,1337,1501-1560`、`speech-http.mjs:263,225`、`recognitions-api.test.mjs:114,293`、`tts-jobs-http.test.mjs:218,225` 的既有断言，**照抄读数而不是重写期望**。
   - 收益：一次补齐 12 个 operation（recognitions 4 + ocr 5 + speech 4 + tts 1 + jobs 2）的 401/404 两列，且 `MIN_CASES` 已从 168 单调升到 **230**（`gy-i22-failmatrix.test.mjs:35` 只准加）。
   - 是否需要真实设备/真库：**都不需要**（failmatrix 走 `app.inject` + stub，仓库已如此）。
   - **仍未进矩阵的域（如实登记）**：`me/exports`、`public/home`、`privacy-policy`、`registrations/verify`（grep 空结果）——本轮不扩写。

3. **给 `selectSpecies` 与 `confirmTranscription` 补归属/未登录断言（覆盖「整行裸奔」）** —— **已完成／更准确地说：404·409·400（＋428）与 `confirmTranscription` 的 401/404 本来就有断言（§4.1 #3、#8 是页面过期）；`selectSpecies` 的 401 由 #449 的 C10-03 补上，晚于初稿时点**
   - 位置：`tests/unit/recognitions-api.test.mjs`（追加 `PATCH /recognitions/:id/selection` 的他人 404 与游客 401，范式照 `:114-116`、`:293`）；`tests/integration/speech-http.mjs:263` 的循环里加上 `PATCH .../confirmation`（范式照 `:285,784`）。
   - 收益：消掉 §4.1 #3 与 #8；两处都在既有文件内追加，不新增 harness。
   - 是否需要真实设备/真库：**都不需要**。
   - **实读**：他人 `PATCH .../selection` 的 404 在 `recognitions-api.test.mjs:540-549`（含 `:542`），409／400 在 `:584-598`；`PATCH .../confirmation` 早就在无会话循环 `speech-http.mjs:256-265`（`:260`）里，404 同形在 `:241-249`。

**不建议**在本轮做的事（会被上述 3 件反噬）：把 `verifyRegistration` 装配进 HTTP（`planned`，属功能开发，不是失败回归）；补齐 community 全部同形断言（收益低于 1–3，且 `C2` 族已覆盖主体）。

### 4.3 与 `docs/architecture/contract-status.json` 的交叉核对（只列不改）

113 个 operation：`partial` 96 / `implemented` 13 / `planned` 4。以下 blocker 原文与本页矩阵**互相印证或互相冲突**，逐条列出：

| operation | status | blocker 摘录 | 与本页矩阵的关系 |
| --- | --- | --- | --- |
| `verifyRegistration` | planned | 「HTTP 路由未装配」 | **印证** §2.5 整行不适用；矩阵里唯一整行为空的 op |
| `listFavorites` / `createFavorite` / `deleteFavorite` | partial | 「real 模式整域 503 `PROVIDER_UNAVAILABLE`」 | **印证** §2.3 的 503 列（`favorites-http.test.mjs:318`） |
| `listHistory` / `deleteHistory` | partial | 「内存存储 + real 模式关闭」 | **印证** §2.3 的 503 列（`history-http.test.mjs:548,751`） |
| `listMessages` / `getUnreadCount` / `markMessageRead` | partial | 「`real` 且无连接池 ⇒ 整域 503」 | **印证** §2.4 的 503 列（`messages-http.test.mjs:189-198`） |
| `createRecognition` / `getRecognition` / `deleteRecognition` / `selectSpecies` | partial | 「HTTP 与内存任务/结果/选种/删除闭环已装配；…真实供应商…尚待验收」 | ~~与 #3 冲突~~ **已消解（2026-10-22）**：`selectSpecies` 的 401/404/409/400 均有断言（§2.6 第 4 行），blocker 的"已装配"与断言一致 |
| `createOCR`…`verifyOCR`（5 条） | partial | 「OCR 五端点…已装配；real 提供者、媒体、登记源未接线时拒绝」 | **与 #5 呼应**：装配完整但 403 全族无断言 |
| `createTranscription`…`confirmTranscription`（4 条） | partial | 「取消已于 GY-R27（#321）接线」 | ~~与 #8 冲突~~ **已消解（2026-10-22）**：`confirmTranscription` 的 401/404/409/400 均有断言（§2.8 第 4 行），初稿漏收 |
| `createSynthesis` | partial | 「取消已于 …接线」；「真实提供者、核对内容与产物端口未在产品装配接线」 | **印证** §2.9 的 503 列（`tts-jobs-http.test.mjs:510,570`） |
| `loginWechat` | implemented | 「stub/preset_demo 用合成身份，不代表真实微信身份」 | ~~与本页 #1 冲突~~ **已消解（2026-10-22，#442／#450）**：429 的 HTTP 面断言在 `gy-i22-rate-and-timeout.test.mjs:77` |
| `loginAdmin` | implemented | 「凭据错误沿用 401 `SESSION_REQUIRED`（契约无专用码）」 | **与本页 #10 冲突**：该"故意选择"无断言钉住 |
| `grantCommunityMediaAccess` / `readCommunityMediaContent` | partial | 「公开内容来源默认**关闭**（统一 404，不误放行）」 | **印证** §2.2 末两行（`C5-05@208`、`E2-02@291`） |
| `listPosts`…`getOwnReport`（16 条社区） | partial | 统一 blocker：「HTTP 路由已装配（`services/api/src/routes/community.ts`；真实回环回归 `tests/unit/community-http.test.mjs`）」 | **部分冲突**：`community-http.test.mjs` 里状态码断言只有 `:790`（422）一条，blocker 暗示的"回环回归"并不覆盖失败族（失败族断言实际散在 `community-service/atomic/moderation-*` 等服务层文件） |
| `hidePost` / `listAuditEvents` | partial | 「路由已装配（`services/api/src/routes/admin.ts`，HTTP 集成回归 `tests/integration/admin-http.mjs`）」 | **印证** §2.10（`admin-http.mjs:494-497`） |
| `listKnowledge` | partial | 「当前 id_asc 排序仍不同于冻结(created_at DESC,id DESC)」 | 与本页矩阵无关（排序口径），登记备查 |
| `withdrawConsent` | partial | 「PG 撤回在 jobs/media/exports/author_links 存在依赖时仍 409 `OBJECT_UNAVAILABLE`，保留 fail-closed」 | **印证** §2.11 的 409 列（`media-consent-wiring.test.mjs:214`） |
| `grantConsent` | partial | 「该 purpose 的已核验可用政策行须先落入 consent_policies，否则 403 `CONSENT_REQUIRED`」 | **印证** §2.11 的 403 列 |

---

## 5 未取得 / 未验证（一律不许当成绿）

1. **（初稿时点）本次没有成功跑过任何用例**：唯一尝试的定向文件 `tests/unit/gy-i22-failmatrix.test.mjs` 因本 worktree 未装依赖直接失败（`ERR_MODULE_NOT_FOUND: Cannot find package 'fastify'`，原始报错与复现方式见 §7）。因此上表所有 ● 与 ○ 都是**读码定位**，不是本轮实测读数。
2. **未跑全量单测**（按派单禁止）、**未起真库**、**未起真机/微信开发者工具**、**未发真实外网**。
3. `tests/integration/*-pg.mjs` 类证据（`messages-pg.mjs:284`、`favorites-history-pg.mjs:11-12`、`recognitions-pg.mjs:889`、`ocr-jobs-pg.mjs:744`、`admin-flags-pg.mjs:571`）需隔离 PG，本轮**未执行**；它们在 `real-pg-integration.yml` 等流水线跑，不在 `test:integration:http` 名单内。
4. **限流 429 的「真实触发」仍未取得**（窗口、键、连打多少次触发）：真实微信侧的 45011 由注入 `fetchImpl` 模拟（`gy-i22-rate-and-timeout.test.mjs:86-105` 自述），能证的只是「收到 45011 之后的对外行为」（`:113`／`:139-141`／`:147`）。
5. **同步面 504 的真实触发条件仍未取得**：注入 `57014`／`55P03` 已能断言 504（`:218-273`），但用户面没有可稳定复现的锁竞争路径。
6. 真实 AI 供应商的超时/配额/结果不确定，**一律未取得**（stub 世界的 `timed_out` 不代表真实供应商行为）。
7. `docs/architecture/contract-status.json` 只读交叉核对，**未改动**（在飞 PR 占用）。
8. 本页的"断言密度"数字是 `tests/**` 内状态码字面量出现次数的**粗筛**（按域正则聚合），不是断言条数；只用于排序，不作为判定依据。

> **2026-10-23 重绑补记**：本次要求单独登记的三条未取得项（① 取消注销无对应 operation；② 真机 / 真供应商 / 真 PG 全链缺失；③ 本机 `spawn EPERM` 属沙箱事实而非产品缺陷）写在 `docs/verification/gy-i22-secmatrix-20261019.md` 的 §10.1–§10.3，每条含「为什么未取得 / 需要什么才能取得 / 是否阻塞 #22 关闭（标注为判断）」。本节上面 8 条的含义与口径**不变**，不因那次登记被弱化或抵消。

---

## 6 附：本页的定位口径速查

| 缩写 | 全文 |
| --- | --- |
| `C1-*@行` | `tests/failmatrix/cases.mjs` 第 N 行的用例（例：`C1-01@64`） |
| C 族 | HTTP 族（`app.inject`，stub）；D 族在 `tests/failmatrix/seams.mjs`（受信 seam）；E 族注入与媒体凭据 |
| 428 | `REVISION_REQUIRED`（缺/非法 `If-Match`），只在 favorites/history/ocr/speech/tts 被断言 |
| 422 | `CONDITIONS_INCOMPLETE` / `SOURCE_CONFLICT` / `INPUT_UNCERTAIN`，不在本页 8 列内（见 §4.1 补充） |

## 7 本轮唯一的定向运行与其原始报错（失败即停，未绕过）

尝试运行的**唯一**文件（定向、非全量；无 PG、无真机、无外网）：

```text
node --test tests/unit/gy-i22-failmatrix.test.mjs
```

结果 **exit 1**，原始报错如下（不是产品断言失败，是**本 worktree 没装依赖**）：

```text
node:internal/modules/package_json_reader:301
  throw new ERR_MODULE_NOT_FOUND(packageName, fileURLToPath(base), null);
        ^

Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'fastify' imported from E:\GengYunCommander\wt-r31-i22\services\api\src\app.ts
    at Object.getPackageJSONURL (node:internal/modules/package_json_reader:301:9)
    at packageResolve (node:internal/modules/esm/resolve:768:10)
    at moduleResolve (node:internal/modules/esm/resolve:859:22)
    ...
  code: 'ERR_MODULE_NOT_FOUND'
}

Node.js v24.16.0
✖ tests\unit\gy-i22-failmatrix.test.mjs (160.7234ms)
ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ fail 1
```

环境事实（已核）：工作树 `E:\GengYunCommander\wt-r31-i22` 下 `node_modules` 与 `services/api/node_modules` **均不存在**（本 worktree 是从 `origin/main` 新拉、未装依赖）。

**因此本轮没有拿到任何"当前通过"的读数。** 按纪律：

- 本页 §2 的 ● **只作「断言存在」的证据，不作「当前通过」的证据**；
- 本页 §2 的 ○ **只作「搜索无断言」的证据**（grep 口径），不代表"一定没有覆盖"（可能有断言藏在未扫描的路径外）；
- 上面的 `ERR_MODULE_NOT_FOUND` 是**缺依赖**，不是 #22 的回归，也不进 §4.1 的风险清单。

复现方式（需要装依赖的环境，由主检出或 CI 执行，本任务不装）：
`pnpm install` 后 `node --test tests/unit/gy-i22-failmatrix.test.mjs`（该文件本身会 `spawnSync` 真跑 `tests/failmatrix/run.mjs`，见 `tests/unit/gy-i22-failmatrix.test.mjs:34-49`）。

---

**2026-10-22 订正记录**：按监工 P2 批复（`supervisor-1022-0541-pr438`），本次只订正了第 166 行（`getRecognition`）的 **429** 与**超时**两格（两格 ● → ○ 未取得，原引文实读见 §2.6 订正注）；未补齐全矩阵测试、未新增未证事实、未改动其他行。

**2026-10-22 回写记录（B2 · 本页时点 `1fbe7572`；只改事实，不改 AC、不改结论口径）**：

1. 首部：基线补注「本页初稿时点」，并新增「本页时点 `origin/main 1fbe7572`」一行（原页只写 `d4d48088`，与 main 漂移）。
2. §0.3：`MIN_CASES` **168 → 230**（`gy-i22-failmatrix.test.mjs:35`），族条数补 `C10:23` / `C11:39`，批次条数补 `B5:62`，包装器行号 `:34-49` → `:41-56`。
3. §1 A1／A7／A8 的「现状」格：A1 补 C10 的 23 条游客面断言；A7 由「异步域齐、同步面零覆盖」改为「齐」（同步 504 已断言）；A8 由「不齐、API 面 0 条」改为「齐」（429 HTTP 面已断言）。
4. §2.6 第 4 行 `selectSpecies`：由 8 列全 ○ 改为 401／404／409／400 四列 ●（`:542`、`:587-588`、`:592,597`，401 见 `C10-03@313`），并改写了该行下方的「整行零断言」注。**其中 404／409／400（＋428）是初稿漏收（`d4d48088` 时点已有），401 由 #449 的 C10-03 补上、晚于初稿时点**——`d4d48088` 时点该文件的 401 只有 POST /recognitions、GET /recognitions/:id、GET /jobs/:id 三条。
   - **与 `supervisor-1022-0541-pr438` 的关系**：该批复已认定 `:592` / `:597` **属 selectSpecies 的 400 列**，只是当轮「未搬入」；本次按同一归属把它落进 400 格，判定口径未变。
5. §2.8 第 4 行 `confirmTranscription`：由「401/404 全 ○、409 引 `:784,791`」改为 401／404／400 三列 ●，409 改引 `:288-290`（原引 `:784,791` 实为 `/jobs/{id}/cancel` 的两条取消断言），并改写了该行下方的「未进循环」注。
6. §4.1：#1（429）、#2（同步 504）、#3（`selectSpecies`）、#4（failmatrix 异步 AI 域）、#8（`confirmTranscription`）五行由「零断言风险」改为「已关闭」并给出关闭证据行；#3 标注「404/409/400/428 页面过期、401 由 #449 补上」，#8 标注「页面过期，不是本轮新增用例」；#1／#2／#4 标注对应 PR（#442／#450／#447／#449）与仍未取得的部分。
7. §4.2：三件事全部标注落地状态，并新增一条前置说明——**三件做完不等于 #22 可关闭**（11 张前置 OPEN、§5 的真实限流／真实供应商超时／真机读数仍未取得）。
8. §4.3：`selectSpecies`、`confirmTranscription`、`loginWechat` 三行的「与 #N 冲突」改为「已消解」，其余行未动。
9. §5.4／§5.5：把「限流 429 的真实行为完全未验证」「同步面 504 未验证」改写为「真实触发仍未取得」，并分别指出已断言的那一半。

**审查返修（2026-10-22，PR #486 审查）**：审查指出第 4 项的表述把 401 也算成「初稿时点已有」——**审查正确**。`d4d48088` 时点 `recognitions-api.test.mjs` 的 401 只有 POST /recognitions、GET /recognitions/:id、GET /jobs/:id 三条，**不含 `PATCH …/selection`**；该 401 来自 #449 的 `C10-03@313`（`git grep` 在 `d4d48088` 无 C10 命中）。故把第 4 项、§2.6 该行及其注、§4.1 #3 三处改为「**404／409／400（＋428）初稿时点已有；401 由 #449 补上、晚于初稿时点**」；同时把 409 引用由 `:587` 改为 `:587-588`（`REVISION_CONFLICT` 在 `:588`），并把首部的「§5/§7」改成「§5.1–§5.3/§7」（§5.4／§5.5 已改写）。**只改文字，未动测试与 workflow，判定口径不变。**

未做的事（避免过度声称）：未跑全量单测、未起真库/真机、未重算 §2 其余表格的逐格判定、未扩写 §2.12 之外的域行、未改 `docs/architecture/contract-status.json`。

**本轮（2026-10-22 回写）的定向读数**（worktree `E:\GengYunCommander\wt-i22-evidence`，`1fbe7572` + 本页/注释/一条测试的改动）：

- `node tests/failmatrix/run.mjs --list` ⇒ 末行原文 `合计 230 条用例（HTTP 210 + seam 20）。`
- `node --test tests/unit/gy-i22-failmatrix.test.mjs` ⇒ 3/3 pass，其中「全量真跑 230 条全绿，且每条都有真实读数」通过。
- `node --test tests/unit/gy-i22-*.test.mjs`（9 个文件）⇒ 47/47 pass。
- 这些读数只覆盖矩阵与 i22 单测；**真实微信侧限流、真实 AI 供应商超时、真机/微信开发者工具仍未取得**（§5）。

---

## 2026-10-23 重绑记录（`upstream/main` = `7dd3d699`）

本次只做三件事：**核引用**（`文件:行` 只核「同号同内容」；`C 族@行` 另做语义核并订正 12 行）、**订正两处本来就指错的引用**、**补读数**。不重算 §2 的逐格判定，不改任何 `status`，不改 `docs/architecture/contract-status.json`。

### 一、引用逐条核对（两类分开计数，不再合并成一个总数）

核对方法（可复现）：把本页引用拆成**两类**分别核——

- **`文件:行`（`路径.ext:NNN`）**：按**出现次数**计，两个口径分写、不要混用——**改前页体（§0–§12，`upstream/main` 版）235 条**；**本版同一区段 237 条**（`+2` 是 §2.3 新增的两处 `history-http.test.mjs:477`）。⚠️ **本「重绑记录」与附录 A 里的说明性引用不计入任何一档**（否则会自我指涉、每改一次就变一次数）。核法：`git show 1fbe7572:<path>` 与 `git show 7dd3d699:<path>` 取**同一行号**处的原文逐字比对，不同再在该文件里做唯一内容匹配找新行号。
- **`C 族@行`（`Cx-yy@NN`）**：同为按出现次数计——**§0–§12 区段 82 处**（改前与本次**相同**，本轮没有增删这项），去重后 **65 个 id**；本记录里的说明性提及同样不计入。⚠️ **「同号同内容」这个判据对本类完全无效**——`tests/failmatrix/cases.mjs` 在 `1fbe7572` 与 `7dd3d699` 上是**同一个 blob**（`67bc5cd8a7c6edffed8a2e70c458ed991265c217`），同号必然同内容。语义必须另核，见 1.3。

#### 1.1 `文件:行`：只核了「同号同内容」

| 类别 | 条数（改前页体口径） | 说明 |
| --- | --- | --- |
| 同号同内容 | 233 | 只证明「行号没动」，**不证明「指对了地方」** |
| 内容位移（可复现） | 2 | `app.ts` 原 1917 行 → `2057`；`community-filter-pg.mjs:422` → `474-475`（**不是 `424`**——`:424` 是 SQL 占位符位序段，与所称断言无关，见下一条原文片段与 §1.2） |
| 原行不在界内 / 文件不存在 | 0 | — |
| 合计 | 235 | 解析失败 0 条；**本版页体口径 237**（见 §一 的两口径说明） |

两处位移的原文片段（自算，勿照抄）：

- `app.ts:2106` ⇒ `const retryAfterSeconds = retryAfterSecondsFor(error);`（`:2058` ⇒ `if (retryAfterSeconds !== null) reply.header('Retry-After', String(retryAfterSeconds));`）。初稿时点在 `1917-1918`；`7dd3d699` 上该文件共 2,116 行，整段下移。
- `community-filter-pg.mjs:474-475` ⇒ `assert.equal((await call('GET', '/api/v1/reports/${reportId}')).status, 404,` + `'他人读他人举报必须 404（只回本人）');`。**原引的 `:422` 在 `1fbe7572` 上就已不是这条断言**（那一带是「crop/region/limit 占位符位序」的 SQL 断言，`:424` 是其中的 `const orderedStatements = statements`）⇒ 它**不是单纯行号漂移，是指错了地方**。

#### 1.2 「同号同内容」证不出的「指错」：另查出 2 处

这条判据只能证「行号没动」，**证不出「指错了地方」**。初版把两类混报成「仍成立 312」属 overclaim，已按本节改写。另查出（第三类 `community-filter-pg.mjs` 那条已列在 §1.1 的「内容位移」里，此处不重复）：

| # | 原引 | 实际是什么 | 订正 |
| --- | --- | --- | --- |
| 1 | `community-service.test.mjs:674`（声称 `listPosts` 403 `SCOPE_DENIED`） | 该行是 `['media_ids 重复', …, 'DUPLICATE_ITEM']` | → `community-service.test.mjs:725`（`await assert.rejects(h.service.listPosts(ADMIN, {}), assertApiError('SCOPE_DENIED', 403));`） |
| 2 | `history-http.test.mjs:477`（挂在 `listHistory` 的 401 列） | 该行是 **`DELETE /history/{id}`** 的匿名 401（全文件仅此一条 401，且属 DELETE 面） | 从 `listHistory` 行**移除**，改挂 `deleteHistory` 行（见 §2.3） |

#### 1.3 `C 族@行`：语义复核（本次新做）

`cases.mjs` 的行数演进（自算，`git show <rev>:tests/failmatrix/cases.mjs`）：

| 时点 | 行数 | `C1-01` 行号 | `C1-27` 行号 |
| --- | --- | --- | --- |
| `d4d48088`（本页初稿） | 290 | 52 | 78 |
| `1fbe7572`（回写） | 385 | 64 | 90 |
| `7dd3d699`（本次） | 385 | 64 | 90 |

⇒ 行号整体下移 **12 行**，而页内 `@行` 从未跟着改。

**机制（自核，`git diff d4d48088 1fbe7572 -- tests/failmatrix/cases.mjs` 的 4 个 hunk）**：`+12` 全部来自 `CASES` **之前**的三处插入——① `COMMUNITY_MEDIA_BODY` 一带的 4 个 body 常量 **+9**（`@@ -30,0 +31,9 @@`）；② `BATCHES` 新增 B5 批次 **+1**（`@@ -35,0 +45 @@`）；③ `FAMILIES` 补 C10/C11 两条说明 **+2**（`@@ -47,0 +58,2 @@`）。而 C10（23 条）/C11（39 条）的**用例块本身是追加在文件尾**（`@@ -289,0 +302,83 @@`，**+83**），**推不动任何既有行**。（`9+1+2+83 = 95`，与 `git diff --numstat` 的 `95 0` 相符。）⇒ 错的是「`CASES` 头部多出来的 12 行」，不是「尾部多了 62 条用例」。

逐条语义核（把每个 `Cx-yy@NN` 的 `@NN` 行原文取出来，看它是不是**该 id 的用例行**）：

| 类别 | 条数 | 说明 |
| --- | --- | --- |
| 语义正确（`@NN` 就是该 id 的用例行） | 5 | 全部是 `C10-03@313`——它由 `#449` 同期写入，本来就对 |
| 语义错误（整体小 12 行） | 77 | 已统一订正为真实行号（等价于 +12），逐条对照见**附录 A** |
| 合计 | 82 | 去重 65 个 id；订正后 **65/65 命中该 id 的用例行** |

### 二、`7dd3d699` 上的复读（本节为新增读数，不覆盖上面各节）

| 项 | 命令 | 读数 |
| --- | --- | --- |
| 矩阵条数 | `node tests/failmatrix/run.mjs --list` | 末行原文 `合计 230 条用例（HTTP 210 + seam 20）。`；exit 0 |
| 矩阵包装器 | `node --test tests/unit/gy-i22-failmatrix.test.mjs` | `tests 3 / pass 3 / fail 0`，其中「全量真跑 230 条全绿，且每条都有真实读数」通过；exit 0 |
| `MIN_CASES` / 族条数 / 批次条数 | `git show 7dd3d699:tests/unit/gy-i22-failmatrix.test.mjs` | `MIN_CASES = 230`、`FAMILY_COUNTS`（C1:37 C2:24 C3:27 C4:18 C5:10 C6:10 C7:16 D1:11 D2:4 D3:2 D4:3 E1:3 E2:3 C10:23 C11:39）、`BATCH_COUNTS`（B1:106 B2:36 B3:17 B4:9 B5:62）**全部与 §0.3 所记一致** |
| 契约操作数 | `node tools/verify-contract-status.mjs` | `覆盖 113 条契约操作；已装配 109 条；implemented 17 / partial 92 / planned 4`；exit 0 |
| 矩阵单测（i22 矩阵本体） | `node --test tests/unit/gy-i22-secmatrix.test.mjs` | `tests 6 / pass 6 / fail 0`，146 条 `[I22]` 行；exit 0 |
| 文档门禁 | `npm run test:docs` / `node tools/verify-doc-anchors.mjs --strict` | 均 exit 0（详见同批重绑的安全矩阵页 §8.1） |

**与 §0.3 的差异登记（只登记、不改写）**：§0.3 记的分布是 `partial 96 / implemented 13 / planned 4`，`7dd3d699` 上实测为 `partial 92 / implemented 17 / planned 4`；**operation 总数 113 未变**。这是契约台账随主线推进自己变了，**不是本页的结论改动**，本页不评论这些状态判定是否恰当。

### 三、三条「未取得」的登记位置

本次要求如实登记、不得当成已解决的三条（① 取消注销无对应 operation；② 真机 / 真供应商 / 真 PG 全链缺失；③ 本机 `spawn EPERM` 是沙箱事实而非产品缺陷）**不在本页展开**，统一登记在同一批重绑的安全矩阵页 `docs/verification/gy-i22-secmatrix-20261019.md` 的 §10.1、§10.2、§10.3（每条含「为什么未取得 / 需要什么才能取得 / 是否阻塞 #22 关闭（标注为判断）」）。本页 §5 的既有未取得条目照旧、不因那次登记而被弱化。

本页仍**没有**做的事：未跑全量单测、未起真库/真机、未重算 §2 逐格判定、未改 `docs/architecture/contract-status.json`、未改任何 `status`。

---

## 附录 A：`C 族@行` 订正对照（65 个 id，2026-10-23）

本表由**仓外一次性脚本**生成（脚本未入库，本片只交表；可复现的方法与判据见 §一 1.3）：「改后」= `git show 7dd3d699:tests/failmatrix/cases.mjs` 中 `id: 'Cx-yy'` 所在行号，「改前」= 本页 `97db10c3` 版里该 id 的 `@NN`，「位移」= 改后 − 改前。65 个去重 id 里 **64 个整体 +12**、1 个（`C10-03`）本来就对。

| 改前 | 改后 | 位移 | 该行用例标题（`cases.mjs` 原文） |
| --- | --- | --- | --- |
| `C1-01`@52 | 64 | +12 | 游客读收藏列表 |
| `C1-02`@53 | 65 | +12 | 游客写收藏 |
| `C1-03`@54 | 66 | +12 | 游客取消收藏 |
| `C1-04`@55 | 67 | +12 | 游客读历史 |
| `C1-05`@56 | 68 | +12 | 游客删历史 |
| `C1-06`@57 | 69 | +12 | 游客读消息 |
| `C1-07`@58 | 70 | +12 | 游客读未读数 |
| `C1-08`@59 | 71 | +12 | 游客标记已读 |
| `C1-14`@65 | 77 | +12 | 游客申请社区媒体访问 |
| `C1-15`@66 | 78 | +12 | 游客取社区媒体内容 |
| `C1-16`@67 | 79 | +12 | 游客读帖子列表 |
| `C1-17`@68 | 80 | +12 | 游客发帖 |
| `C1-18`@69 | 81 | +12 | 游客读单帖 |
| `C1-19`@70 | 82 | +12 | 游客发评论 |
| `C1-20`@71 | 83 | +12 | 游客读评论列表 |
| `C1-21`@72 | 84 | +12 | 游客改评论 |
| `C1-22`@73 | 85 | +12 | 游客点赞 |
| `C1-23`@74 | 86 | +12 | 游客举报 |
| `C1-24`@75 | 87 | +12 | 游客查举报 |
| `C1-27`@78 | 90 | +12 | 游客读会话 |
| `C1-28`@79 | 91 | +12 | 游客注销 |
| `C1-31`@82 | 94 | +12 | 游客读同意书 |
| `C1-33`@84 | 96 | +12 | 游客读除草剂目录 |
| `C1-34`@85 | 97 | +12 | 游客读知识库 |
| `C1-36`@87 | 99 | +12 | 游客读后台会话 |
| `C2-14`@104 | 116 | +12 | 对照：A 取消不存在的收藏 |
| `C2-15`@105 | 117 | +12 | 对照：A 删不存在的历史 |
| `C2-16`@106 | 118 | +12 | 对照：A 标记不存在的消息 |
| `C2-17`@107 | 119 | +12 | 对照：A 删不存在的帖子 |
| `C2-18`@108 | 120 | +12 | 对照：A 改不存在的评论 |
| `C2-21`@111 | 123 | +12 | 对照：A 查不存在的举报 |
| `C2-23`@116 | 128 | +12 | A 的历史列表不含 B 的行 |
| `C2-24`@120 | 132 | +12 | A 的消息列表不含 B 的行 |
| `C3-04`@129 | 141 | +12 | 用户会话读审计事件 |
| `C3-12`@137 | 149 | +12 | 零 scope 后台会话登出 |
| `C3-15`@140 | 152 | +12 | 正控制：全 scope 后台会话读审计事件 |
| `C3-17`@142 | 154 | +12 | 正控制：全 scope 后台会话读后台会话 |
| `C3-23`@148 | 160 | +12 | 后台会话读用户会话（不得代替） |
| `C3-26`@151 | 163 | +12 | 正控制：隐藏留痕（审计事件指向被隐藏帖子） |
| `C4-01`@162 | 174 | +12 | 注销缺幂等键 |
| `C4-06`@167 | 179 | +12 | 账号 epoch 变更后的旧会话 |
| `C4-18`@189 | 201 | +12 | 冷静期内原会话仍可用（注销在线 7 日到期前） |
| `C5-04`@195 | 207 | +12 | 社区媒体内容缺 X-Media-Access-Token |
| `C5-05`@196 | 208 | +12 | 社区媒体内容 token 在但授权不存在 |
| `C5-06`@197 | 209 | +12 | 社区媒体授权 id 非 uuid |
| `C5-07`@198 | 210 | +12 | 内容-媒体不匹配的社区媒体授权 |
| `C6-03`@217 | 229 | +12 | 同键异体：409 |
| `C6-04`@218 | 230 | +12 | 缺幂等键：400 |
| `C6-07`@225 | 237 | +12 | 同键异体重放帖子：409 |
| `C6-08`@226 | 238 | +12 | 举报（首次） |
| `C6-09`@227 | 239 | +12 | 同键同体重放举报：同一行 |
| `C7-01`@245 | 257 | +12 | 帖子路径 id 非 uuid |
| `C7-02`@246 | 258 | +12 | 取消收藏路径 id 非 uuid |
| `C7-03`@247 | 259 | +12 | 标记已读路径 id 非 uuid |
| `C7-04`@248 | 260 | +12 | 举报路径 id 非 uuid |
| `C7-05`@249 | 261 | +12 | 游标非法 |
| `C7-08`@252 | 264 | +12 | 列表多余查询参数 |
| `C7-09`@253 | 265 | +12 | 帖子列表分页非数字 |
| `C7-10`@254 | 266 | +12 | 发帖缺 media_ids |
| `C7-11`@255 | 267 | +12 | 发帖 4 个媒体（上限 3） |
| `C7-12`@256 | 268 | +12 | 举报原因码不在枚举内 |
| `C7-13`@257 | 269 | +12 | 收藏目标类型不在枚举内 |
| `C10-03`@313 | 313 | （未变） | 游客改识别选择 |
| `E1-01`@263 | 275 | +12 | 标题里塞「忽略以上指令」⇒ 硬规则命中 PROMPT_INJECTION 并拒绝（不是照做） |
| `E2-02`@279 | 291 | +12 | 同一凭据去读一个不存在的媒体 id ⇒ 404，与上一条完全同形 |

订正后逐条复核：65 个 id 全部命中**该 id 的用例行**（`hit=65 / miss=0`），不再有「行号对、指错用例」的情形。

## R34 追加：4 域负控制覆盖（2026-10-24）

**本节基线 commit = `4b87e1d9`**（`git rev-parse upstream/main` = `4b87e1d98f405b55c9fda46ac772f4ffcbc13a5e`，`Reviewed PR #525`；工作树分支 `feat/gy-r34-i22-failmatrix-4domains`）。开工三读数：`git rev-parse HEAD` = `4b87e1d98f405b55c9fda46ac772f4ffcbc13a5e`、`git rev-parse upstream/main` = 同值、`git status --porcelain -uall` = 0 行。

### 口径：两类靶子（为什么这 3 个域要用单元测试当靶子）

`mutations.mjs` 原来每条负控制只有一类靶子 `watch`（矩阵用例 id，执行器跑 `run.mjs --only=<id>`，要求全红）。本轮 4 个域里有 3 个**不进 HTTP 失败矩阵**（矩阵是 `execution_mode=stub` 下的失败注入表，不覆盖这几个读面），守着它们的是 `tests/unit/*.test.mjs` 里**既有**的测试。于是执行器新增第二类靶子：

| 靶子 | 字段 | 「真红」判据 | 「转绿」判据 |
| --- | --- | --- | --- |
| 矩阵用例 | `watch: ['C2-05']` | `run.mjs --only=C2-05` 的每条都必须 `FAIL` | 恢复原字节后复跑全 `PASS` |
| 既有单元测试 | `unitWatch: [{ file, pattern }]` | `node --test --test-name-pattern=<pattern> <file>` 必须 `# fail ≥ 1` **且** `# pass = 0`（恰好那一条红，不许有 PASS 混在里面） | 恢复原字节后必须 `# fail = 0` **且** `# pass = 1`（恰好一条转绿；pattern 变宽顺手盖住别的测试不算） |

`pattern` 是测试名的**字面子串**，执行器转义成正则后传给 `--test-name-pattern`。`tests/unit/gy-i22-failmatrix.test.mjs` 同时加了反向闸门：`unitWatch.file` 必须在 `tests/unit/` 下、`pattern` 必须在该文件里**逐字出现**——测试改名或删除 ⇒ 负控制必须同步，不能让一条指向空气的负控制继续绿。

⛔ **没有为任何域新写测试来喂负控制**：`unitWatch` 指向的 3 个测试文件在本轮之前就存在，`git diff` 里它们一个字节都没动。

### 逐域结果

| # | 域 | 变异点（文件:函数名） | 目标测试（既有） | 红（改后实测） | 绿（恢复后实测） | 是否成立 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `me/exports` | `services/api/src/privacy/exports-list.ts:createExportsListService` 内 `ledger()` 的懒建 catch | `tests/unit/exports-route-http.test.mjs`「连接池形状不合：装配期不抛（buildApp 能起），请求期 fail-closed 503」 | `# tests 1 / # pass 0 / # fail 1`；`The validation function is expected to return "true". Received false`（`assert.rejects` 的校验函数判否：原始错误不再是 `PROVIDER_UNAVAILABLE` 503） | `# fail 0 / # pass 1` | ✅ 成立（NC-22） |
| 2 | `public/home` | `services/api/src/db/catalog.ts:readHomePreviews` 的「语句超时单独分级」那一行 | `tests/unit/public-home.test.mjs`「database failures use safe contract errors, including statement timeout」 | `# fail 1 / # pass 0`；`expected: 504` / `actual: 503` | `# fail 0 / # pass 1` | ✅ 成立（NC-23） |
| 3 | `privacy-policy` | ——（无守卫代码可改） | ——（无守护测试） | —— | —— | ❌ **不成立：该域没有实现**，见 3.1 |
| 4 | `registrations/verify` | `services/api/src/knowledge/applicability-screen.ts:screenRegistrationMatch` 的阻断码 fail-closed 映射 | `tests/unit/knowledge-applicability-screen.test.mjs`「GY-I08 装配：登记匹配非 matched 一律带 4xx，matched 保留记录但资格另判」 | `# fail 1 / # pass 0`；`error: '契约错误码没有对应 HTTP 状态：INTERNAL'` | `# fail 0 / # pass 1` | ✅ 成立（NC-24），但域口径需订正，见 4.1 |

每条都过了完整闭包：改前 / 改后 / 恢复后三次 sha256 逐字节比对一致（`NC-22` `services/api/src/privacy/exports-list.ts` = `65dfc495c3c3014b6a869571e674f368173088da27ff54e6184c22683432c587`、`NC-23` `services/api/src/db/catalog.ts` = `3fd779cc9be18f7bb85470633f03dfe3bdc8b961c1be4ca02ea78a04936554c2`、`NC-24` `services/api/src/knowledge/applicability-screen.ts` = `45cad9090813c2f231e64fc8b9c849e05069474b9c67f138fc97f9145136ea43`），恢复用**原始字节**回写，不经过字符串重编码。

#### 3.1 `privacy-policy` 为什么不成立（缺口性质＝缺实现，比缺测试更上游）

查证事实（三处互相独立）：

1. `services/api/src/routes/` 下**没有**任何实现 `GET /me/privacy-policy`（或 `/privacy-policy`）的路由文件：`Select-String -Path services/api/src/routes/*.ts -Pattern 'privacy'` 的命中全部是 `import … from '../privacy/*.ts'` 与内容举报枚举 `'privacy'`，**没有一条是路由声明**。
2. 契约侧该行仍标「待接入」：`docs/ui-contract-binding.md` 绑定表的「隐私说明 | `GET /me/privacy-policy` | 静态文案」一行写着「界面读取待接入」。
3. 仓内既有测试把它登记为**计划证据**而不是已实现能力：`tests/unit/contract-planned-exemptions.test.mjs` 的 `getPrivacyPolicy` 条目 `why: '无任何 policy 内容模块、无路由、无用例；仅有界面绑定的需求侧要求，因此只能记计划证据并标明是需求侧依据。'`；`services/api/src/privacy/backup-replay-manifest.ts` 的注释同样写明「**未自造任何路由/字段**」。

结论：**该域无守护测试，负控制无法成立，缺口性质＝缺实现（连路由都没有；退一步讲也是缺测试）**。按本轮规则**没有**为它新写一条弱断言去喂负控制——那种做法只会产出一条「无论如何都红不了」的假负控制。

#### 4.1 `registrations/verify` 的域口径订正

任务书给的域名叫 `registrations/verify`。实测：`services/api/src/routes/` 下**没有** `/registrations/verify` 路由，只有 `/admin/registrations` 系列读面（`routes/admin.ts`）。真正承担「登记校验」语义的是 `services/api/src/knowledge/applicability-screen.ts` 的 `screenRegistrationMatch`：登记匹配状态 `state` 经 `MATCH_ERROR_MAP` 折成阻断错误码，未登记的 `state` 一律折成 `UNMAPPED_BLOCK_ERROR`（`OBJECT_UNAVAILABLE` 409）——即「非 matched 一律 fail-closed 成 4xx，绝不放行成 200/500」。NC-24 改的就是这一行（把折档结果钉成 `INTERNAL`），由既有单元测试「GY-I08 装配：登记匹配非 matched 一律带 4xx」检出。**域成立，但成立在模块函数上、不在路由上**，故在此如实记账。

### 本轮跑过的命令与读数（定向 + 一次全量）

| 命令 | 读数 |
| --- | --- |
| `node --test tests/unit/gy-i22-failmatrix.test.mjs` | `# tests 3 / # pass 3 / # fail 0`（含新增的 `unitWatch` 闸门与 `MUTATIONS.length >= 26`） |
| `node --test tests/unit/exports-route-http.test.mjs` | `pass 3 / fail 0`（干净树） |
| `node --test tests/unit/public-home.test.mjs` | `pass 4 / fail 0`（干净树） |
| `node --test tests/unit/knowledge-applicability-screen.test.mjs` | `pass 9 / fail 0`（干净树） |
| `node tools/i22-failmatrix-negative-control.mjs --only=NC-22,NC-23,NC-24` | `PASS 3 / FAIL 0`（首轮 NC-22 曾 `FAIL`，见下「被否掉的候选」） |
| `node tools/i22-failmatrix-negative-control.mjs --only=NC-01,NC-21` | `PASS 2 / FAIL 0`（回归自检：执行器改了红/绿分支后，老条目的 `watch` 通道必须照旧） |
| `node --test "tests/unit/*.test.mjs"`（**一次**，串行） | `ℹ tests 3264 / pass 3261 / fail 0 / cancelled 0 / skipped 1 / todo 2 / duration_ms 79427.9506`，exit 0；末尾 `✖ failing tests:` 段只列出 `tests/unit/i11-audio-mp3-wav-guard.test.mjs` 的 2 条**既有 `todo`**（I11 缺口本体未修，本版不动），不计入 fail |

#### 被否掉的候选（留档，免得下一片重走）

`me/exports` 的第一个候选变异点是 `services/api/src/privacy/ledger-pg.ts` 里「无法归类的库错误 ⇒ `PROVIDER_UNAVAILABLE`(503, retryable=false)」那行兜底。实测**不红**：`--only=NC-22` 跑出 `fail=0 pass=1`。原因：`GET /me/exports` 的**列表读面**根本不走那条兜底（它是账本写入/回放路径的分档），列表面自己的 fail-closed 在 `exports-list.ts` 的 `ledger()` catch 里。换成后者后一次命中。教训：负控制挑的必须是**该测试真的走到**的那一行，不是「名字听起来对」的那一行。

### 没有削弱已有负控制（可复核）

- `git diff --numstat tests/failmatrix/mutations.mjs` = `41 0`：**新增 41 行、删除 0 行**——`NC-01…NC-21`（**R29 时点 23 条**；本轮共 **26** 条，`NC-22/23/24` 为本轮新增）的 `find` / `replace` / `watch` 一个字节都没动，只在其后追加 `NC-22/23/24` 并补了文件头关于 `unitWatch` 的说明。上游 `gy-r34-closure-matrix-20261024.md` 里「`mutations.mjs` 的 23 条负控制」是 **R29 时点读数**，与本轮 26 条不冲突。
- 计数只上调：`tests/unit/gy-i22-failmatrix.test.mjs` 里负控制条数下限 `MUTATIONS.length >= 20` → `>= 26`（= 现有全部负控制条数）；`MIN_CASES` 仍为 `230`（本轮没有新增矩阵用例，故不上调）。
- 收尾 `git status --porcelain -uall` 只剩 5 个有意改动的文件（`tests/failmatrix/mutations.mjs`、`tests/failmatrix/README.md`、`tests/unit/gy-i22-failmatrix.test.mjs`、`tools/i22-failmatrix-negative-control.mjs`、本页），任何变异残留都没有（这是 `3825d60f` 收尾时的读数；其后的 `ef35b3fa` 与「拒绝改写归档快照」那个提交又各动了 `tools/i22-failmatrix-evidence-table.mjs` 等文件，见本节末尾「订正」）。

### 本轮没动的（避免与其它分片相撞；`tools/i22-failmatrix-evidence-table.mjs` 不在此列，见下「订正」）

`.github/**`、`services/api/db/migrations/**`、`migration-reservations.json` 一律没碰；未起 PG 集群、未占端口（`exports-route-http.test.mjs` 自己 `app.listen({ port: 0 })` 的临时环回口是它原有形态）。

### 订正：计数口径**已由本分支校正**（此前那句「本轮不碰 EXPECTED」说过头了）

本节此前写的是「`tools/i22-failmatrix-evidence-table.mjs` 的 `EXPECTED`（`total: 168`、`negativeControls: 23`）与本轮实测（矩阵 230 条 / 负控制 26 条）已对不上，属既有陈旧账，本轮不碰、如实记录」。这句话在 `ef35b3fa`（`chore(test): 校正 i22 负控制证据表计数口径`）落盘后就不成立了——那个提交改的正是 `EXPECTED`：`total` 168 → 230、`negativeControls` 23 → 26，并补 `C10: 23`、`C11: 39`、`B5: 62` 三个分组（`families` 与 `batches` 都是全 230 的分组计数）。校正依据：R29 建页时 13 族之和 = 168（**同一口径**的旧读数，不是另一个维度），加上 R31 补的同步 AI 域 23 + 39 后 = 168 + 23 + 39 = 230；负控制 23 + 3 = 26。

同一提交暴露出连带风险，本次一并拦下（判据＝真实路径比较 + 仓库内包含性校验，不是靠字符串比路径）：`PAGE` 常量仍指向本页之外的归档页 `docs/verification/gy-i22-failmatrix-20261022.md`（R29 快照，表格 168 行 / 负控制 23 条），`EXPECTED` 上调之后**裸跑 `--write` 会无报错把那份归档快照重写成 230 行**，而且原来的写盘位于 `problems` 对账**之前**。现在的口径（不是注释提醒，是可被负控制测试证伪的拦截）：

- `--write` 不再有隐式默认页：裸 `--write` 一律 exit 1 并打印原因；目标页必须显式 `--page=`，且 `--page=` 按仓库根解析并校验包含性（越界拒绝）。
- 目标页就是归档页（按**文件身份** `dev` + `ino` 判定；`./`、`..`、Windows 大小写、符号链接、硬链接都指向同一个文件）时，没给 `--i-know-this-rewrites-archive` 会先被拦一道提示；**即使给了旗标也仍受条数一致性约束**——页内矩阵表行数 / 负控制表行数必须与 `EXPECTED`（230 / 26）逐项相等才写。旗标不提供「刷新历史快照」的路径，归档快照只允许「同一基线刷新读数」，不允许被换成另一份快照。今天它就被拒（`条数 168 与 EXPECTED 230 不一致`）。
- 写盘挪到 `problems` 判定之后：对账不通过一律不写盘、exit 1。
- 只读路径不变：不带 `--write` 时照旧把两张表打到 stdout、末行「自洽：矩阵 230 条全 PASS、负控制 26 条全 PASS，与文档声明一致」、exit 0（对账不通过则 exit 1）；`--matrix=` / `--nc=` 按仓库根解析并校验包含性（越界拒绝；读不到时只打一行，不打 node 栈）。
- 守卫由 `tests/unit/i22-failmatrix-evidence-table-guard.test.mjs` 兜底：工件自洽时 `--write` 真的写盘（正控制，证明守卫不是「永远红」）、工件与 `EXPECTED` 不一致时不写盘且 exit 1、真实归档页在「裸 `--write`」「显式 `--page=`」「再加双钥匙」三种调用下字节不变，归档页的 `./` / `..` / 大小写别名与仓库外目标（`../outside.md`）同样 exit 1 且字节不变。

## R34 订正（第二轮）：归档页保护改用路径归一 + 仓库内包含性校验

### 一、审查者实测到的漏洞

上一轮的归档页保护判的是**归一化字符串**（`rel === ARCHIVE_PAGE`），那条归一化只做 `\`→`/`、剥开头 `./`、剥结尾 `/`。于是下面三种 `--page=` 全部 **exit 0 且真把 R29 归档页从 168 / 23 改写成 230 / 26**——上一轮那句「归档页写不进去」的口径是错的，实测否证。页字节数**不是固定读数**：它随 `--matrix=` / `--nc=` 夹具（头部时间戳与逐行读数）浮动——本分支用自己的夹具实测 43462 → **47056**（连跑两次同值、幂等），审查者用自己的夹具实测 43462 → **48699**；可变的不变量只有「168 / 23 → 230 / 26」。（本小节初版写「43462 → 49678」是一次抄错的读数，已删。）

| `--page=` 写法 | 修复前（审查者实测） | 修复后（本轮实测） |
| --- | --- | --- |
| `docs/verification/./gy-i22-failmatrix-20261022.md` | exit 0，写盘 230 行 | exit 1，`拒绝写入归档快照`，字节不变 |
| `docs/verification/../verification/gy-i22-failmatrix-20261022.md` | exit 0，写盘 230 行 | exit 1，`拒绝写入归档快照`，字节不变 |
| `DOCS/verification/gy-i22-failmatrix-20261022.md`（Windows 大小写不敏感） | exit 0，写盘 230 行 | exit 1，`拒绝写入归档快照`，字节不变 |
| `../outside.md`（仓库外） | exit 0，改写**仓库外**文件 | exit 1，`拒绝写入：目标不在仓库内`，仓库外文件字节不变 |

（旧行为的反例：`--page=./docs/…` 反而被拦——归一化正好剥掉了开头的 `./`。也就是说上一轮的拦截只挡住了一种写法，不是一条规则。）

### 二、现在的判据（三件事，缺一条就退化成字符串比较）

1. **路径归一 + 文件身份比较**：`--page=` 先按仓库根解析成绝对路径，再取真实路径（`realpathSync.native`；目标不存在时先解父目录、再拼 basename）。`./`、`..`、大小写、符号链接、junction、`\\?\` 前缀都在这一步归一。**第三轮把最后那步「是不是同一个文件」改判文件身份**（`statSync` 的 `dev` + `ino`）：realpath 归一路径、归不了硬链接（同一 inode 的另一个目录项），见下节「R34 订正（第三轮）」。
2. **仓库内包含性校验**：目标的真实路径必须以 `<仓库根><分隔符>` 开头，否则在**打开文件之前**就拒绝——stderr 明确打印 `拒绝写入：目标不在仓库内` 并 exit 1。所以 `../outside.md`、`docs/../../outside.md` 都写不出去，仓库外不存在的目标也不会被创建。
3. **负控制测试扩到别名与越界**：在原 4 条之上加 2 条——三种归档页别名必须 exit 1 且归档页前后 `readFileSync` 逐字节相等（大小写别名只在大小写不敏感的文件系统上断言「被识别成归档页」，POSIX 上它是另一个不存在的路径、由「读不到目标页」拦住，仍断言 exit 1 与字节不变）；`../<名字>.md`、`docs/../../<名字>.md` 必须 exit 1 且仓库外受害者文件逐字节不变。**保留**原有的「工件自洽时 `--write --page=<合法新页>` 真的写盘」正控制——守卫不能是「永远红」。

### 三、死参数的处理：选 (a)，保留旗标但把提示语改成与实际一致

`--i-know-this-rewrites-archive` 现在**永远成功不了**：它只关掉「没给旗标」那道提示，条数校验仍然在，而本页是 168 / 23 的冻结快照、`EXPECTED` 是 230 / 26，两者必然不等。上一轮的提示语却承诺「加旗标就能刷新归档页」，等于给了一条不存在的路径。现在两处提示语（没给旗标 / 给了旗标）都写明：**即使给了旗标也仍受条数一致性约束；本页当前条目已过期 ⇒ 需要先迁移台账口径**，并在生成器里用注释记下这个选择（选 (a) 而不是删旗标：删参数会让已经按旧口径调用的人只看到「不认识该参数」，噪声更大）。旗标并不解锁改写，这一点有测试断言着。

### 四、门禁读数（第二轮实测；第三轮读数见下节，本表保留为历史）

本分支的 merge-base = `4b87e1d98f405b55c9fda46ac772f4ffcbc13a5e`（= 本轮开工时的 `upstream/main`，`Reviewed PR #525`）；**审阅时 `upstream/main` 已前进到 `997e8e5f43473d82a79314a2336103110bc5087e`**（`Reviewed PR #529`，含 #527 / #528 / #529 三个提交），`git rev-list --left-right --count upstream/main...HEAD` = `3	4`。下表的「本轮实测」以 merge-base 为基线。

| 门禁 | 读数 |
| --- | --- |
| 裸 `--write`（无隐式默认页） | exit 1，`拒绝写入：--write 必须显式指定 --page=` |
| `./` 别名 / `..` 别名 / `DOCS/` 别名 | 各 exit 1，`拒绝写入归档快照` |
| `./` 开头（旧行为本来就拦） | exit 1，`拒绝写入归档快照` |
| 明文正确路径（无旗标 / 带双钥匙） | exit 1 / exit 1（后者 `条数 168 与 EXPECTED 230 不一致`） |
| `../i22-outside-probe.md`、`docs/../../i22-outside-probe.md` | 各 exit 1，`拒绝写入：目标不在仓库内`；仓库外无新文件 |
| 正控制：工件自洽 + 合法新页 `--write` | 真的写盘（guard 测试内断言） |
| `node tools/i22-failmatrix-evidence-table.mjs`（只读自洽） | exit 0，266 行输出，`自洽：矩阵 230 条全 PASS、负控制 26 条全 PASS`，不写盘 |
| `node --test tests/unit/i22-failmatrix-evidence-table-guard.test.mjs` | 6 / 6 pass（原 4 条 + 新 2 条） |
| `node --test tests/unit/gy-i22-failmatrix.test.mjs` | 3 / 3 pass |
| `node --test tests/unit/doc-anchors-guard.test.mjs` | 10 / 10 pass |
| `node tools/verify-doc-anchors.mjs --strict` | 基线 103 条命中 103，基线外新增 0，exit 0 |
| 全量 `node --test "tests/unit/*.test.mjs"` | 3270 tests / pass 3267 / fail 0 / skipped 1，exit 0 |
| `git merge-tree --write-tree upstream/main HEAD`（先 `git fetch upstream --prune`） | EXIT 0 |

### 五、变异自证（证明测试真的盯住了这两条判据）

- 把路径比较临时改回字符串比较（`samePath(...)` → `rel === ARCHIVE_PAGE`）⇒ 别名测试立刻转红，断言文本就是审查者给的那个形态（实测逐字）：`AssertionError: 中间插 './'（--page=docs/verification/./gy-i22-failmatrix-20261022.md）应 exit 1，实际 0：`，并打印出被写进去的 230 行表格。
- 把包含性校验临时关掉（`isInside(...)` → `false` 分支永不进入）⇒ 越界测试转红：`../<名字>.md` 应 exit 1、实际 0，仓库外受害者文件被真改写。
- 两次都改回后逐字节还原：生成器文件当时的 `sha256 = 76DC949DCE10EE0B96AFDB5E17B224C5C669B446250A5E2EB2764D73C6281C49`，与备份一致；guard 测试复跑 6 / 6 绿。**此 sha 是第二轮时点的读数**——第三轮改了判据（`samePath` 比 `dev` + `ino`），生成器字节已变，第三轮的 sha 与变异自证见下节。归档页在变异期间被写入的那次由测试自带的 `t.after` 兜底还原，事后核对仍是矩阵 168 行 / 负控制 23 条。
- 说明「为什么第二轮那次变红是『真实原因』」：第二轮改判据时，别名用例跑在**真仓库**里、仓库里缺 `--matrix=` 工件，所以「守卫坏了」也照样 exit 1（同码异因）。第三轮把别名用例搬进**夹具树**（树里同时有自洽工件 230 / 26 和归档页副本 168 / 23），exit 1 只可能来自「被识别成归档页」，并在 stderr 上断言 `拒绝写入归档快照`。

### 六、本轮同时改掉的措辞（不改就还是下一轮）

- 凡写「机械拒绝改写归档快照」的地方，一律改成：**归档页保护基于真实路径比较 + 文件身份（`dev` + `ino`）+ 仓库内包含性校验；`--write` 无隐式默认页**。本节第一节那句旧口径（「本次一并机械拦住」）已同步改掉，本页不再出现「机械拒绝」这种说法。
- 「`--page` 按仓库根解析」一律改成「按仓库根解析并校验包含性（越界拒绝）」——生成器里的参数说明、报错文案、`README` 与本页都是这个口径。
- 归档页 `docs/verification/gy-i22-failmatrix-20261022.md` 只改了讲这套保护的那一句散文（净 1 行、43462 → 43642 字节），**没有动任何读数行**：矩阵仍 168 行、负控制仍 23 条。

### 七、仍未取得（不许当成绿）

- 归档页仍是 168 / 23 的 R29 时点快照，`EXPECTED` 是 230 / 26：**要么迁移台账口径另建新页，要么人工建页**，本轮只保证「生成器不再能改写它」，不负责把这份快照刷新成新读数。
- 大小写别名只在 Windows 上实测（本机 Windows）；POSIX 上同一写法是另一个不存在的路径，测试只断言 exit 1 与字节不变，没有在大小写敏感文件系统上验证「别名等价」。
- 未起 PG 集群、未占端口；本轮没有跑 HTTP / DB 层用例（不在这次改动的爆炸半径内）。

## R34 订正（第三轮）：归档页判定改比文件身份（`dev` + `ino`），工件参数补包含性校验

第二轮把归档页判定从字符串比较改成真实路径比较，挡住了 `./` / `..` / 大小写三类别名；但那条线只归一**路径**、归一不了**文件身份**——硬链接是同一 inode 的另一个目录项，`realpath` 仍返回它自己那条路径。对抗性审查正是从这个缺口进去的。

### 一、审查者实测到的绕过：硬链接

```
cmd /c mklink /H h-archive.md docs\verification\gy-i22-failmatrix-20261022.md
node tools/i22-failmatrix-evidence-table.mjs --write --page=h-archive.md --matrix=… --nc=…
```

审查者实测：**exit 0**，归档页 43642 B（168 / 23）→ 48879 B（230 / 26），两次复跑一致。根因：硬链接没命中「归档页」分支，而「非归档页」分支没有条数校验——所以第二轮的「真实路径比较」只是必要条件，不是充分条件。

修复后本轮实测（同一手法：`cmd /c mklink /H` 在 `.pg17/tmp/hl2/` 下建硬链接到归档页，跑完即删，`Test-Path` 为 False）：**exit 1**，stderr 命中 `拒绝写入归档快照：页 .pg17/tmp/hl2/h-archive.md（真实路径 …\hl2\h-archive.md）是基线 a515503976 的归档快照（页内表格 168 行 / 负控制 23 条）`；归档页 sha256 `5F71550F205219F25B1F70FE5E805376CA54329EB04F55A6B4D580B0FD485FC2` 前后相同、字节数仍 43642。

### 二、判据变更：`samePath` 比 inode

```js
function samePath(left, right) {
  try {
    const a = statSync(left);
    const b = statSync(right);
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}
```

- 任一侧 `stat` 失败（不存在 / EACCES / 已删）一律返回 `false`：让调用方走原有的 `readFileSync` / ENOENT 错误路径，不在这里抛未捕获异常（否则「目标不存在」会从「拒绝写入：读不到目标页」退化成栈回溯）。
- `realPathOf`（`realpathSync.native`）**保留**，仍用于 `isInside` 的包含性校验与报错回显——「把路径归一」和「认出是同一个文件」是两件事，各归各位。
- `CASE_INSENSITIVE_FS` 收成只 win32 生效，注释如实写：它是 belt-and-braces，不是拦别名的主因（NTFS 上 `realpathSync.native` 已把 `DOCS/…` 归一成盘上真实大小写，删掉折大小写别名照样被 inode 比较拦住）；darwin 那一支没有条件在大小写敏感 APFS 上验，故不折（折了反而会把两个真实不同的文件误判成同一个）。

### 三、`--matrix=` / `--nc=` 与 `--page=` 对齐

`readJson` 先 `path.resolve(ROOT, relative)`、再 `isInside(ROOT, …)`：不在仓库内 exit 1、文案 `拒绝运行：运行结果不在仓库内`；读不到时单行 `拒绝运行：读不到运行结果 …（ENOENT: …）`，由 `main` 捕获后打 `✗ …`——不再把 node 栈甩给只用工具的人。实测 `--matrix=../outside-matrix.json` 与 `--nc=<仓库外绝对路径>` 各 exit 1，stderr 只有一行。

### 四、guard 测试 4 → 9 条

| # | 用例 | 关键断言 |
| --- | --- | --- |
| 1 | 正控制：工件自洽 + 合法新页 `--write` | 真写盘、exit 0、末行自洽读数、两表行数 = 230 / 26（守卫不是「永远红」） |
| 2 | 工件与 `EXPECTED` 不一致 | exit 1、不写盘、stderr `对账不通过` |
| 3 | 真实归档页：裸 `--write` / 显式 `--page=` / 再加双钥匙 | 三种各 exit 1、`拒绝写入`、归档页字节不变；双钥匙那条必须点明「条数 168 与 EXPECTED 230 不一致」 |
| 4 | 缺生成器标记 | exit 1、不写盘 |
| 5 | 真仓库里的归档页别名（`./`、`..`、`DOCS/`） | 各 exit 1、归档页字节不变（真仓库那份的只读断言） |
| 6 | 仓库外目标（`../x.md`、`docs/../../x.md`、越界且不存在） | 各 exit 1、`拒绝写入：目标不在仓库内`、仓库外受害者字节不变、越界目标不被创建 |
| 7 | **夹具树**里的归档页别名 | 树里同时有自洽工件（230 / 26）与归档页副本（168 / 23）⇒ exit 1 **只可能**来自「被识别成归档页」；断言 stderr `拒绝写入归档快照` + 副本字节不变（拆掉「同码异因」） |
| 8 | **硬链接**别名（`fs.linkSync` 建在夹具树里，`t.after` 清理） | exit 1、`拒绝写入归档快照`、归档页 sha256 不变；无权建硬链接的环境 `t.skip`（不假绿） |
| 9 | `--matrix=` / `--nc=` 越界与工件缺失 | 各 exit 1、单行报错、stderr 不含 node 栈行 |

### 五、门禁读数（第三轮实测，`git rev-parse upstream/main` = `997e8e5f43473d82a79314a2336103110bc5087e`）

| 门禁 | 读数 |
| --- | --- |
| 裸 `--write`（无隐式默认页） | exit 1，`拒绝写入：--write 必须显式指定 --page=` |
| `./` 别名 / `..` 别名 / `DOCS/` 别名 | 各 exit 1，`拒绝写入归档快照`（真实路径回显指向同一个归档页） |
| 硬链接 `--page=.pg17/tmp/hl2/h-archive.md` | exit 1，`拒绝写入归档快照`；归档页 sha256 不变 |
| `--page=../i22-outside-probe.md` | exit 1，`拒绝写入：目标不在仓库内`；仓库外无新文件 |
| `--matrix=../outside-matrix.json`、`--nc=<仓库外绝对路径>` | 各 exit 1，`拒绝运行：运行结果不在仓库内`，单行 |
| 正控制：工件自洽 + 合法新页 `--write` | 真的写盘（guard 用例 1 内断言） |
| `node tools/i22-failmatrix-evidence-table.mjs`（只读自洽） | exit 0，266 行输出，末行 `自洽：矩阵 230 条全 PASS、负控制 26 条全 PASS，与文档声明一致` |
| `node --test tests/unit/i22-failmatrix-evidence-table-guard.test.mjs` | 9 / 9 pass，exit 0 |
| `node --test tests/unit/gy-i22-failmatrix.test.mjs` | 3 / 3 pass，exit 0 |
| `node --test tests/unit/doc-anchors-guard.test.mjs` | 10 / 10 pass，exit 0 |
| `node tools/verify-doc-anchors.mjs --strict` | 基线 103 条命中 103，基线外新增 0、陈旧 0，exit 0 |
| `node tools/verify-contract-status.mjs` | exit 0（行号区间 244 条、中文表格一致） |
| 全量 `node --test "tests/unit/*.test.mjs"` | 3273 tests / pass 3270 / fail 0 / skipped 1 / todo 2，exit 0 |
| `git diff --check` | 无输出、exit 0（四个改动文件 `git ls-files --eol` 均为 `i/lf w/lf`） |
| `git merge-tree --write-tree upstream/main HEAD`（先 `git fetch upstream --prune`） | EXIT=0，冲突行 0 |

### 六、变异自证（第三轮，两条都做，逐字节还原）

| 变异 | 结果 | 断言原文 |
| --- | --- | --- |
| `samePath` 改回 `realPathOf` 比较（去掉 inode） | 9 条里 8 pass / **1 fail**，只有硬链接用例转红 | `AssertionError [ERR_ASSERTION]: 硬链接目标应 exit 1，实际 0：` |
| 归档判定改回 `rel === ARCHIVE_PAGE`（字符串） | 9 条里 6 pass / **3 fail**：两条别名用例 + 硬链接用例转红 | `AssertionError: 中间插 './'（--page=docs/verification/./gy-i22-failmatrix-20261022.md）应 exit 1，实际 0：` |

两次改回后逐字节还原：生成器 `sha256 = 8AC4AA796D96A2FAEE751E5B4C758C918F666728BC70D7C215C21AA7A1DD0C6A`、guard 测试 `sha256 = 42E2A55EA4810B92C034E985BE7B01D2AA11C749ED4E4CDFB2175685A238C0DA`，与备份一致；还原后 guard 复跑 9 / 9 绿。归档页 sha256 全程 `5F7155…`、字节数全程 43642（变异只动生成器源码，没让归档页承受任何一次写盘）。

### 七、仍未取得

- 归档页仍是 168 / 23 的 R29 时点快照。inode 比较能保证「生成器写不进这个文件」（含硬链接、symlink、junction 等一切指向它的名字），但**不保护「把整个文件删了再用同名重建」**这类跨进程操作——那需要在 CI 里加只读校验（例如对归档页做 `git diff --exit-code` 断言），不在本轮爆炸半径内。
- 硬链接用例在 NTFS 上实测通过；在禁止建硬链接的环境（部分容器 / 网络盘）会走 `t.skip`，那时这条负控制是「未验证」而不是「通过」。
- `--matrix=` / `--nc=` 的包含性校验只挡「路径越界」，工件内容仍由 `EXPECTED` 对账兜底；本轮没有给工件加 schema 校验。
