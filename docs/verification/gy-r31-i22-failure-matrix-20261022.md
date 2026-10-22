# GY-R31（#22 / GY-I22）失败矩阵复盘与缺口矩阵（只读）

- 基线：`origin/main` `d4d48088`（worktree `E:\GengYunCommander\wt-r31-i22`，分支 `feat/gy-r31-i22-recon`）
- 性质：**只读复盘**。本页不改业务代码、不改 `docs/architecture/contract-status.json`、不跑全量单测。
- 证据口径：**每一格都给可定位的 `文件:行`**（`tests/...` 或 `services/api/src/...`）。
  本页区分两类事实，不混写：
  - **【断言】**＝仓库里已存在的用例断言（读码定位，未在本次重跑）；
  - **【实现】**＝产品代码里的行为（读码定位，未实测）。
  - 本次**实测**仅 §7 记的一条定向单文件运行；其余一律**没有实测**。

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
  由 `tests/unit/gy-i22-failmatrix.test.mjs:28` 钉住 **`MIN_CASES = 168`**，族条数在
  `tests/unit/gy-i22-failmatrix.test.mjs:30`：`C1:37 C2:24 C3:27 C4:18 C5:10 C6:10 C7:16 D1:11 D2:4 D3:2 D4:3 E1:3 E2:3`；
  批次条数 `:32`：`B1:106 B2:36 B3:17 B4:9`。包装器用 `app.inject`（`execution_mode=stub`）真跑 `tests/failmatrix/run.mjs`（`:34-49`）。
- 本页的 8 列与 failmatrix 的族**不是一一对应**：C1≈401、C2≈归属 404、C3≈后台 403/503、C4≈会话、C6≈幂等 409、C7≈校验 400、D 族≈受信 seam、E1/E2≈注入与媒体凭据。

---

## 1 #22 验收原文 → 可判定条目

`gh issue view 22 -R GengYunChuChao/GengYun` 的验收文本可拆成 4 条，再拆成可判定的 9 项（判定项是本页的验收单位）：

| 判定项 | 可判定表述 | 本页对应章节 | 现状 |
| --- | --- | --- | --- |
| A1 | 游客访问每一个需要登录的 operation，一律 401 `SESSION_REQUIRED`（不得是 403/404/500） | §2 各表首列 | **基本齐**：failmatrix C1 有 37 条；异步 AI 域与 `/jobs` 无 failmatrix 覆盖，但域内单测/集成有 401 |
| A2 | A 用户不得读写 B 用户的对象，且「不是你的」与「不存在」**同形 404** | §3.1 | **齐**（9 个域有负控制断言，2 个域结构性不适用） |
| A3 | 所有 `/admin/*` 端点都必须过角色（admin）与 scope 校验 | §3.2 | **齐**（24+N 条路由逐一有守卫；见 3.2 的两处例外说明） |
| A4 | 注销后旧 token 立即失效（401 `SESSION_EXPIRED`），且重放原 code/key 不得再签发可用凭据 | §3.3 | **齐** |
| A5 | 写面幂等：缺键 400、同键同体重放同一结果、同键异体 409 | §2（409/400 列） | **基本齐**；`/ocr`、`/speech/*`、`/recognitions` 有域内断言但不在 failmatrix |
| A6 | 上游不可用必须 fail-closed 503，不得把「能力未接线」说成 404/200 | §2（503 列） | **齐**（各域都有 fail-closed 断言；见 3.1 的例外） |
| A7 | 超时必须是可区分的终态（`timed_out` + `PROVIDER_TIMEOUT`），不得与 `failed` 同形 | §2（超时列）、§4.1 #4 | **异步域齐，同步面零覆盖** |
| A8 | 限流 429 必须有断言（至少登录被限流） | §2（429 列） | **不齐**：API 面 0 条断言（详见 §4.1 #1） |
| A9 | 「任何处方混配换算、伪来源或未审内容公开均阻止发布」 | 非失败族，见 §4.1 #9 的相邻风险 | 越界，本页只列不判 |

---

## 2 失败矩阵

> 行＝`packages/contracts/operations.json` 的 operation；列＝8 个失败族。
> 单元格只放定位；完整判定理由见该域表下的「注」。

### 2.1 auth（6 个 operation）

| operation | 401 | 403 | 404 | 409 | 503 | 超时 | 400 | 429 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `loginWechat` POST /auth/wechat | —（匿名入口） | — | — | ● `auth-routes.test.mjs:295`（同键异体 `IDEMPOTENCY_CONFLICT`） | ○（real 无 store 时 503 只在别域断言） | ○ | ● `auth-routes.test.mjs:249-262`（缺键/短键 `IDEMPOTENCY_KEY_REQUIRED`） | ○ |
| `getUserSession` GET /auth/session | ● `auth-routes.test.mjs:102,115,119`；failmatrix `C1-27@78` | ● `auth-routes.test.mjs:202`（用户 token 打后台面 → `SCOPE_DENIED`） | — | — | ○ | ○ | — | ○ |
| `logoutUser` POST /auth/logout | ● `C1-28@79`；`auth-routes.test.mjs:224-226`（注销后同 token 401 `SESSION_EXPIRED`）、`:332` | ● `C4-06@167` | — | — | ○ | ○ | ● `C4-01@162`；`auth-routes.test.mjs:249-262` | ○ |
| `loginAdmin` POST /admin/auth/session | —（匿名入口） | ○（凭据错误沿用 401，见 `contract-status.json` loginAdmin blocker） | — | ○ | ○ | ○ | ○ | ○ |
| `getAdminSession` GET /admin/auth/session | ● `C1-36@87` | ● `C3-17@142`（有 scope → 200 对照片） | — | — | ○ | ○ | — | ○ |
| `logoutAdmin` POST /admin/auth/logout | ● `C3-23@148`（对照片） | ● `C3-12@137` | — | — | ○ | ○ | ○ | ○ |

注：`auth-routes.test.mjs:771` 有一条 **503** 断言（auth 域唯一直达 503 的一行）；`miniprogram-auth-failure-attribution.test.mjs:253`、`miniprogram-auth-runtime.test.mjs:203,406` 断言的是**客户端对 503 的归属处理**（不得清会话），不是服务端 503 的产生。
`loginWechat` 是**唯一**在服务端产出 429 的路径：`services/api/src/auth/wechat.ts:121` 抛 `RATE_LIMITED`——**但没有任何断言**（见 §4.1 #1）。

### 2.2 community（18 个 operation）

| operation | 401 | 403 | 404 | 409 | 503 | 超时 | 400 | 429 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `listPosts` GET /posts | ● `C1-16@67` | ● `community-service.test.mjs:674`（`SCOPE_DENIED`） | — | — | ● `community-service.test.mjs:344` | ○ | ● `C7-09@253`、`C7-10@254` | ○ |
| `createPost` POST /posts | ● `C1-17@68` | ● `community-posting-consent.test.mjs:107`（无授权 403） | — | ● `C6-07@225`（同键异体） | ● 同 `:344` | ○ | ● `C6-04@218`、`C7-11@255`、`E1-01@263`（注入命中 400） | ○ |
| `getPost` GET /posts/:id | ● `C1-18@69` | ○ | ● `C2-17@107`；`community-atomic.test.mjs:88,160,306` | — | ● `community-moderation-takedown.test.mjs:305` | ○ | ● `C7-01@245` | ○ |
| `editPost` PATCH /posts/:id | ○（C1 未单列，按统一守卫推断） | ○ | ● `community-service.test.mjs:310`；`community-atomic.test.mjs:306` | ● `community-moderation-revision-guard.test.mjs:58,71,72`（`REVISION_CONFLICT`） | ○ | ○ | ○ | ○ |
| `deletePost` DELETE /posts/:id | ○ | ○ | ● `community-atomic.test.mjs:306-307` | ● `community-moderation-revision-guard.test.mjs:94`（`OBJECT_UNAVAILABLE`） | ○ | ○ | ○ | ○ |
| `listComments` GET /posts/:id/comments | ● `C1-19@70` | ○ | ● `community-moderation-takedown.test.mjs:171` | — | ○ | ○ | ○ | ○ |
| `createComment` POST /posts/:id/comments | ● `C1-20@71` | ○ | ● `community-atomic.test.mjs:204`、`community-moderation-gate-wiring.test.mjs:291` | ● `C6-07@225`（同族幂等） | ○ | ○ | ● `C7-10@254` | ○ |
| `getComment` GET /comments/:id | ● `C1-21@72` | ○ | ● `C2-18@108`；`community-atomic.test.mjs:307` | — | ○ | ○ | ○ | ○ |
| `editComment` PATCH /comments/:id | ○ | ○ | ● `community-service.test.mjs:310`（同族） | ● 同 `revision-guard:58` | ○ | ○ | ○ | ○ |
| `deleteComment` DELETE /comments/:id | ○ | ○ | ● `community-atomic.test.mjs:307` | ● 同 `revision-guard:94` | ○ | ○ | ○ | ○ |
| `likePosts` PUT /posts/:id/like | ● `C1-22@73` | ○ | ○（无权/不存在因同形由 `C2-17@107` 覆盖） | ○ | ○ | ○ | ○ | ○ |
| `unlikePosts` DELETE /posts/:id/like | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| `likeComments` PUT /comments/:id/like | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| `unlikeComments` DELETE /comments/:id/like | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| `createReport` POST /reports | ● `C1-23@74` | ○ | — | ● `C6-08@226`/`C6-09@227`（同键重放 201；异体 409 见 C6-03 同族） | ○ | ○ | ● `C7-12@256` | ○ |
| `getOwnReport` GET /reports/:id | ● `C1-24@75` | ○ | ● `C2-21@111` | — | ○ | ○ | ● `C7-04@248` | ○ |
| `grantCommunityMediaAccess` POST /community/media-access | ● `C1-14@65` | ○ | ● `C5-07@198` | ○ | ○ | ○ | ○ | ○ |
| `readCommunityMediaContent` GET /community/media/:grant_id/content | ● `C1-15@66` | ○ | ● `C5-05@196`、`E2-02@279`（篡改 token 同形 404） | — | ○ | ○ | ● `C5-04@195`、`C5-06@197` | ○ |

注：`community-chain-client.test.mjs:210-432` 的 403 断言是**小程序端对 403 的处置**（不清会话、不落 toast），不是服务端 403 的产生；不要记到 API 列。
点赞族（`like/unlike`）在 failmatrix 只有 `C1-22` 一条游客 401，**锁与并发语义零覆盖**。

### 2.3 favorites / history（5 个 operation）

| operation | 401 | 403 | 404 | 409 | 503 | 超时 | 400 | 429 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `listFavorites` GET /favorites | ● `C1-01@52`；`favorites-http.test.mjs:270,398` | ● `C4-06@167` | — | — | ● `favorites-http.test.mjs:318`；`C4-18@189`（200 对照） | ○ | ● `C7-05@249`~`C7-08@252` | ○ |
| `createFavorite` POST /favorites | ● `C1-02@53` | ○ | ○ | ● `C6-03@217`（同键异体）；`favorites-http.test.mjs:155` | ● 同 `:318` | ○ | ● `C6-04@218`、`C7-13@257` | ○ |
| `deleteFavorite` DELETE /favorites/:id | ● `C1-03@54` | ○ | ● `C2-14@104`；`favorites-http.test.mjs:188`（他人）、`:189`（不存在）、`:196`（他人+旧 ETag）、`:225`（二次删） | ● `favorites-http.test.mjs:211,390`（`REVISION_CONFLICT`）；`C6-*`；428 见下 | ● 同 `:318` | ○ | ● `favorites-http.test.mjs:382`（**428** `REVISION_REQUIRED`）、`C7-02@246` | ○ |
| `listHistory` GET /history | ● `C1-04@55`；`history-http.test.mjs:477` | ○ | — | — | ● `history-http.test.mjs:548,751` | ○ | ● `C2-23@116`（200 对照） | ○ |
| `deleteHistory` DELETE /history/:id | ● `C1-05@56` | ○ | ● `C2-15@105`；`history-http.test.mjs:381,382,388,743` | ● `history-http.test.mjs:411,469` | ● 同 `:548` | ○ | ● `history-http.test.mjs:461`（428） | ○ |

注：这两域是 failmatrix 覆盖**最厚**的域（C1/C2/C4/C6/C7 全有），也是唯二把 **428** 写进断言的域。

### 2.4 messages（3 个 operation）

| operation | 401 | 403 | 404 | 409 | 503 | 超时 | 400 | 429 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `listMessages` GET /messages | ● `C1-06@57` | ○ | — | — | ● `messages-http.test.mjs:189-198`（real 无 pool 整域 503） | ○ | ● `C2-24@120`（200 对照） | ○ |
| `getUnreadCount` GET /messages/unread-count | ● `C1-07@58` | ○ | — | — | ● 同 `:192` | ○ | — | ○ |
| `markMessageRead` PUT /messages/:id/read | ● `C1-08@59` | ○ | ● `C2-16@106`；`messages-pg.mjs:284`（他人）、`:290`（不存在）；`rejections-http.mjs:445` | ● `messages-read-version.test.mjs:104,173,174,216,217`；`messages-concurrency.test.mjs:59,60,111`（`REVISION_CONFLICT`）、`:204`（`REQUEST_IN_PROGRESS`）、`:224`（`IDEMPOTENCY_CONFLICT`） | ● 同 `:193` | ○ | ● `C7-03@247`；`messages-security.test.mjs:256` | ○ |

注：`messages-pg.mjs:284` 是**真库**脚本（`tests/integration/*-pg.mjs`，需 PG），不在 `test:integration:http` 名单内（`package.json` 的 `test:integration:http` 未列它）——即「他人消息 404」的**真库**证据只在 PG 流水线跑，HTTP 面的同形断言由 `C2-16@106` 与 `rejections-http.mjs:445`（回环、无 PG）承担。

### 2.5 knowledge（5 个 operation，含 `verifyRegistration`）

| operation | 401 | 403 | 404 | 409 | 503 | 超时 | 400 | 429 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `listKnowledge` GET /knowledge | ● `C1-34@85`；`knowledge-herbicides-http.test.mjs:152,156` | ○ | — | — | ○ | ○ | ● `knowledge-api.test.mjs:48-49`、`:73,76`（`INVALID_CURSOR`）、`:82` | ○ |
| `getKnowledge` GET /knowledge/:id | ○（C1 未单列） | ○ | ● `knowledge-public-invalidation-wiring.test.mjs:136,137,221,418`；`knowledge-herbicides-http.test.mjs:224,364,367` | ● `knowledge-applicability-screen.test.mjs:88,113,266`（`OBJECT_UNAVAILABLE`/`SOURCE_CONFLICT`） | ○ | ○ | ● `knowledge-applicability-screen.test.mjs:285`（422 `INPUT_UNCERTAIN`） | ○ |
| `listHerbicides` GET /herbicides | ● `C1-33@84` | ○ | — | — | ○ | ○ | ○ | ○ |
| `getHerbicide` GET /herbicides/:id | ○ | ○ | ● `knowledge-herbicides-http.test.mjs:224,364` | ○ | ○ | ○ | ● 同 `:367`（非法筛选 404/400 双口径） | ○ |
| `verifyRegistration` POST /registrations/verify | — | — | — | — | — | — | — | — |

注：`verifyRegistration` **路由未装配**（`docs/architecture/contract-status.json` 中该 operation `status: planned`，blocker 原文「领域库层已有实现或数据（packages/reference、packages/knowledge），HTTP 路由未装配」）⇒ 该行 8 列**全部不适用**，且它是「矩阵里唯一整行为空」的 operation。failmatrix 也未引用 `/registrations/verify`。

### 2.6 recognitions（4 个 operation）

| operation | 401 | 403 | 404 | 409 | 503 | 超时 | 400 | 429 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `createRecognition` POST /recognitions | ● `recognitions-api.test.mjs:114` | ● `miniprogram-identify.test.mjs:1400,1401`（`CONSENT_REQUIRED` 403，客户端侧断言） | ○ | ● `recognitions-api.test.mjs:156`、`:394`（`[202,409]` 并发）、`recognitions-http.mjs:188` | ● `recognitions-api.test.mjs:686`；`recognitions-candidates-selection.test.mjs:693` | ● `recognitions-api.test.mjs:298-305`（`state=timed_out` + `PROVIDER_TIMEOUT`） | ● `recognitions-api.test.mjs:124,130,133,146` | ○ |
| `getRecognition` GET /recognitions/:id | ● `recognitions-api.test.mjs:115` | ○ | ● `recognitions-api.test.mjs:293`；`recognitions-http.mjs:120`（他人）、`:143`（已删）；`recognition-chain-e2e.mjs:452` | — | ○ | ●（同域 `GET /jobs/{id}`：`recognitions-api.test.mjs:116` 401 有断言） | ○ | ● `recognitions-api.test.mjs:592,597,650` | ○ |
| `deleteRecognition` DELETE /recognitions/:id | ○ | ○ | ● `recognition-chain-e2e.mjs:459`（他人历史不可删） | ● `recognitions-http.mjs:224`（取消终态 409） | ○ | ○ | ○ | ○ |
| `selectSpecies` PATCH /recognitions/:id/selection | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |

注：**该域 4 行全部不在 failmatrix 表内**（`cases.mjs` / `seams.mjs` 无 `recognitions` 字样）；证据全在 `tests/unit/recognitions-api.test.mjs` 与 `tests/integration/recognitions-http.mjs`（后者在 `test:integration:http` 名单内）。
`selectSpecies` 是**整行 8 列零断言**的两个 operation 之一（另一个是 `verifyRegistration`，其因由是未装配）。

### 2.7 ocr（5 个 operation）

| operation | 401 | 403 | 404 | 409 | 503 | 超时 | 400 | 429 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `createOCR` POST /ocr | ● `ocr-http.mjs:1500` | ○ | ○ | ● `ocr-http.mjs:1431` | ● `ocr-http.mjs:1545,1560`（real 缺凭据受理前 503） | ● `ocr-http.mjs:2058`（`timed_out` + `PROVIDER_TIMEOUT`） | ● `ocr-http.mjs:1468,1475,1482` | ○ |
| `getOCR` GET /ocr/:id | ○ | ○ | ● `ocr-http.mjs:1337`（他人）、`:1338`（不存在）、`:1033`（等待期 404 语义） | — | ● `ocr-store-pg-tables-missing.test.mjs:159`（表未迁移走 503 通道） | ● `ocr-http.mjs:1057`（`GET /jobs/{id}` 200 读面） | ○ | ○ | ○ |
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
| `confirmTranscription` PATCH /speech/transcriptions/:id/confirmation | ○ | ○ | ○ | ● `speech-http.mjs:784,791` | ○ | ○ | ○ | ○ |

注：`speech-service.test.mjs:1118` 断言「失败或已删除都不得让同键重放变成 404」——这是**幂等与 404 的负交叉**，很关键但不属任一单格。
`confirmTranscription` 无 401/404 断言（该端点未在 `:263` 循环里）。

### 2.9 tts（1 个 operation）

| operation | 401 | 403 | 404 | 409 | 503 | 超时 | 400 | 429 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `createSynthesis` POST /speech/synthesis | ● `tts-http.mjs:311,313`（`SESSION_REQUIRED` / `SESSION_EXPIRED`） | ● `tts-jobs-http.test.mjs:510,570`（real 未接真实依赖 fail-closed） | ● `tts-http.mjs:304,305`；`tts-content-wiring.mjs:242,251` | ● `tts-http.mjs:370,409`；`tts-content-wiring.mjs:234,258,273`；`tts-cancel.test.mjs:257,519`；`tts-jobs-http.test.mjs:309` | ● `tts-content-wiring.mjs:199`；`tts-jobs-http.test.mjs:510,570`（`:328` 是「取消已接线不得回 503」的负断言） | ● `tts-service.test.mjs:640-644`、`:1130-1182`（读面超时裁定 `timed_out`） | ● `tts-http.mjs:398`（422）、`tts-jobs-http.test.mjs:230,235,432,442`、`tts-cancel.test.mjs:404`（428） | ○ |

注：`tts` 是单 operation 域，但断言密度最高（8 列里 7 列有 ●）。429 仍为 ○。

### 2.10 moderation（2 个 operation）

| operation | 401 | 403 | 404 | 409 | 503 | 超时 | 400 | 429 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `hidePost` POST /admin/posts/:id/hide | ○ | ● `C3-*` 系列（后台 403 统一族 `cases.mjs:126-137`） | ● `admin-http.mjs:494-497`（隐藏后他人读 404） | ● `community-moderation-revision-guard.test.mjs:58,71,72,94` | ● `admin-http.mjs:365,374` | ○ | ○ | ○ |
| `listAuditEvents` GET /admin/audit-events | ● `C1` 族（后台未登录） | ● `C3-04@129`、`C3-15@140`（200 对照）、`C3-26@151` | — | — | ○ | ○ | ● `C7` 族游标口径 | ○ |

注：审核**前置门禁**（先审后发）不是契约 operation，其断言在 `community-moderation-read-recheck.test.mjs:54,85,112`、`gate-wiring.test.mjs:125,190,291`（均为 404 形态）——计入 community 域的 404 列，不单独成行。

### 2.11 consents（3 个 operation）

| operation | 401 | 403 | 404 | 409 | 503 | 超时 | 400 | 429 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `listConsents` GET /me/consents | ● `C1-31@82`；`privacy-consent-wiring.test.mjs:139` | ● `privacy-egress-http.test.mjs:117,133,153,157`（含 `ACCOUNT_INACTIVE`） | —（端点无 `:id`） | — | ● `privacy-consent-wiring.test.mjs:307`；`privacy-egress-http.test.mjs:185` | ○ | ○ | ○ |
| `grantConsent` POST /me/consents | ○ | ● `privacy-consent-wiring.test.mjs:131,159,199,212,260` | — | ● `media-consent-wiring.test.mjs:214` | ● 同 `:307` | ○ | ● `C7` 族同构 | ○ |
| `withdrawConsent` DELETE /me/consents/:purpose | ○ | ● `media-consent-wiring.test.mjs:231,269,303,316` | — | ● `media-consent-wiring.test.mjs:214`；blocker 记录「依赖未清时 409 `OBJECT_UNAVAILABLE`」 | ● `privacy-synthesis-egress-retryable.test.mjs:66,89`（正反两向） | ○ | ○ | ○ |

注：consents 域**没有跨用户断言**，但这是**结构性不适用**：三个端点都不接收 subject 参数，主体一律取自 token（`C1-31@82` 已钉住未登录面）。

### 2.12 其余域（每域一行汇总）

| 域 | 断言密度（来自 `tests/**` 状态码出现次数，粗筛） | 代表证据 | 结论 |
| --- | --- | --- | --- |
| media（5 ops） | 401:5 403:12 404:37 409:21 503:54 | `media-http-upload.test.mjs:116`（401）；`media-http-access.test.mjs:168`（他人 404）、`:404,427,433,439,445`（无内容/未发布/未过审/版本不符同形 404）；failmatrix `C1-09..13`、`C2-11..13`、`C5-01..03`、`C5-10` | **齐**（唯一把「未过审」写成 404 的域） |
| jobs（2 ops） | 401:3 404:30 409:18 503:43 | `jobs-http.mjs:217-237`（他人/不存在/未接线 kind **三类同形 404**）、`:266`（他人取消 404）、`:278`（无会话 401） | **齐**；但 failmatrix 无 `/jobs/*` |
| conversations（7 ops） | 400:20 404:37 409:11 503:10 | `conversation-http.test.mjs:281,282,288,292`（他人读/删/轮次 404）、`:294`（往他人会话写 404）、`:239`（方法不符 404） | **齐**（归属最完整的一域） |
| deletion / exports（3 ops） | 401:58 403:14 404:17 409:8 503:17 | `account-deletion-http.mjs:202,316,321,326`（四类 401）、`:354`（换发后旧 bearer 立即失效）、failmatrix `C4-10..15` | **齐** |
| catalog / public / profile（7 ops） | 400:13 401:6 404:5 503:4 | `C1-25..26,32`（游客 401）；`C2-22` | **基本齐**，无写面冲突 |
| admin 内容面（24 ops：sources/knowledge/registrations/restrictions） | 401:82 403:78 404:79 409:87 503:135 504:16 | 守卫 `routes/admin.ts:166-167`（`readGuards`/`writeGuards`）；`C3-01..03,09..11`（403）、`C3-14..17`（200 对照）、`C3-22`（404） | **齐**；唯 504 只在 PG 锁通道 |
| admin 运维面（10 ops：accounts/jobs/flags/audit/categories/hide） | 同上 | `admin.ts:257,269,275,290,296,313,319,334,340,354,367` 每条均 `guards.requireAdmin` | **齐** |
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
| community | `community-atomic.test.mjs:88,160,204,306,307`；`community-moderation-takedown.test.mjs:170,171,229`；`read-recheck:54,85,112`；`gate-wiring:125,190,291`；`community-filter-pg.mjs:422`（他人读他人举报 404） | **否**（多数只断言 404，未逐个比对封套） |
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

守卫来源：`services/api/src/routes/admin.ts:145` 收 `guards: AuthGuards`，`:166-167` 定义
`readGuards = { preHandler: [guards.requireAdmin, guards.requireScope(descriptor.readScope)] }`、
`writeGuards = { preHandler: [guards.requireAdmin, guards.requireScope(descriptor.writeScope)] }`。

| 路由文件:行 | 路径 | 守卫 |
| --- | --- | --- |
| `admin.ts:172` | GET `/admin/sources` | `sources.readGuards` |
| `admin.ts:175` | POST `/admin/sources` | `sources.writeGuards` |
| `admin.ts:178/181` | GET/PATCH `/admin/sources/:id` | `readGuards` / `writeGuards` + `uuidIdParams` |
| `admin.ts:184/187` | POST `/admin/sources/:id/publish|withdraw` | `writeGuards` |
| `admin.ts:192-207` | `/admin/knowledge` 6 条 | 同构（`knowledge.readGuards/writeGuards`） |
| `admin.ts:212-227` | `/admin/registrations` 6 条 | 同构 |
| `admin.ts:232-247` | `/admin/restrictions` 6 条 | 同构 |
| `admin.ts:256` | GET `/admin/audit-events` | `requireAdmin + requireScope('audit:read')` |
| `admin.ts:268/273` | GET `/admin/categories`、PATCH `/admin/categories/:id` | `requireAdmin + OPS_SCOPES.listAdminCategories/editCategory` |
| `admin.ts:289/294` | GET `/admin/accounts`、POST `/admin/accounts/:id/suspend` | `listAdminUsers/suspendUser` |
| `admin.ts:312/317` | GET `/admin/jobs`、POST `/admin/jobs/:id/cancel` | `listAdminJobs/cancelAdminJob` |
| `admin.ts:333/338` | GET `/admin/feature-flags`、PUT `/admin/feature-flags/:key` | `listFlags/setFlag` |
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
| 注销回执 bearer | `account-deletion-http.mjs:354`（`换发后旧 bearer 必须立刻失效`） | 回执专用 bearer 同样失效 |
| 后台登出 | failmatrix `C3-12@137`（403 对照）、`C3-23@148` | 后台 401 面 |

**判定**：A4 可判「齐」。唯一未覆盖的是**跨进程/跨实例**的撤销传播（会话存内存时，另一个实例的 token 仍有效）——属 `#313`／持久会话范围，本页不外推。

---

## 4 结论

### 4.1 不可回归的风险清单（完全无断言的失败族，按严重度前 10）

排序依据：`能造成越权或数据泄露 > 能造成假绿 > 能造成线上 500/静默成功`，再看是否有实现（有实现无断言 > 无实现）。

| # | 风险 | 证据（现状） | 严重度 |
| --- | --- | --- | --- |
| 1 | **限流 429 全族零 API 断言**：`loginWechat` 是唯一产出 429 的路径（`services/api/src/auth/wechat.ts:121` 抛 `RATE_LIMITED`），但没有任何用例断言它；`RATE_LIMITED` 仅出现在后台 UI 状态映射测试（`admin-ui-api.test.mjs:134-137,259`、`admin-ui-contract.test.mjs:46`、`ui-unified-states.test.mjs:109`） | 见左 | **高**（登录可被无限爆破，回归无感） |
| 2 | **同步面 504 `PROVIDER_TIMEOUT` 零断言**：504 断言只在后台 PG 锁通道（`admin-flags-pg.mjs:513-515`、`admin-flags-pg.test.mjs:373-382`、`account-authority-pg.test.mjs:120-121`、`admin-accounts-directory.test.mjs:263`、`db-error-retryable-classification.test.mjs:130`）；用户面所有同步端点无 504 用例 | 见左 | **高**（超时易被折叠成 500/503 而无人知） |
| 3 | **`selectSpecies` 整行 8 列零断言**（`PATCH /recognitions/:id/selection`） | §2.6 第 4 行 | **高**（选种是识别链路终点，写面全裸） |
| 4 | **failmatrix 完全不覆盖异步 AI 域与 `/jobs`**：`cases.mjs` + `seams.mjs` 对 `recognitions`/`/ocr`/`speech/`/`/jobs/`/`conversations`/`me/exports`/`privacy-policy`/`public/home`/`registrations/verify` **零引用** | grep 空结果 | **高**（168 条矩阵看起来"全绿"，但 40+ 个 operation 不在其中——**假绿风险最高的结构缺口**） |
| 5 | **OCR 403 全族 ○**（5 个 operation 无任何 scope/授权断言） | §2.7 | 中高 |
| 6 | **点赞族 `like/unlike` 只有 1 条游客 401**，锁/并发/重复点赞语义零覆盖 | `C1-22@73` 是唯一一条 | 中高 |
| 7 | **community「同形」弱于其他域**：多数只断言 404，未成对比对封套（对比 `messages-pg.mjs:299`、`speech-http.mjs:222`） | §3.1 | 中 |
| 8 | **`confirmTranscription` 无 401/404 断言**（未进 `speech-http.mjs:263` 的循环） | §2.8 第 4 行 | 中 |
| 9 | **`verifyRegistration` 整行不适用**（`planned`，HTTP 未装配）且 failmatrix 无「未装配即 404/不泄露」的形态断言 | `contract-status.json` blocker | 中（是"没做"，不是"做错"，但会被误读成已覆盖） |
| 10 | **`loginAdmin` 的 403/404/409/503/超时/429 全 ○**：凭据错误沿用 401 `SESSION_REQUIRED`，但**没有一条断言钉住这个"故意不合契约直觉"的选择** | `contract-status.json` loginAdmin blocker；§2.1 | 中（后台入口，回归后可能变成 500） |

补充（不计入前 10，但需登记）：
- **413 `MEDIA_TOO_LARGE` / 415 `MEDIA_TYPE_UNSUPPORTED` / 422 三码在 failmatrix 被完全跳过**：C 族只覆盖 400/401/403/404/409/503，`contract.ts:20-22` 的 413/415/422 在矩阵中**没有列**（本页按派单只做 8 列，故未成列；这是矩阵口径本身的缺口）。
- `seams.mjs:364-365`（D 族）断言模型超时 ⇒ `quarantined` + `PROVIDER_TIMEOUT`，属受信 seam 而不是 HTTP 面。

### 4.2 最短可关闭 #22 的 3 件事

> 三件都**不需要真实设备**；只有第 2 件需要真库。

1. **把 429 与「同步面 504」补成可执行断言（1 个文件，无 PG、无真机）**
   - 位置：`tests/failmatrix/cases.mjs` 新增 F 族两批（`C8` 限流、`C9` 超时），或最小改动——在 `tests/unit/gy-i22-failmatrix.test.mjs` 旁新增 `tests/unit/gy-i22-rate-and-timeout.test.mjs`。
   - 断言对象：`services/api/src/auth/wechat.ts:121`（429 `RATE_LIMITED`，`retryable` 与 `Retry-After`/`retryable` 字段）；同步面任一走 DB 的 GET 在锁超时下 504 `PROVIDER_TIMEOUT`（可复用 `tests/unit/admin-flags-pg.test.mjs:373` 的映射入口，但**不要**改成用户面锁，改为对一个注入 `57014` 的桩池断言封套）。
   - 成本：单文件；**不需真库**（57014/55P03 可在映射层注入，参考 `db-error-retryable-classification.test.mjs:130` 已建立的注入范式）。
   - 是否需要真实设备/真库：**都不需要**。

2. **把异步 AI 域与 `/jobs` 拉进 failmatrix（解决「假绿」结构缺口）**
   - 位置：`tests/failmatrix/cases.mjs`（新增 `C10` 游客面 + `C11` 归属面）与 `tests/failmatrix/world.mjs`（需要 stub 世界的 OCR/转写/识别/合成资源种子）；参照 `tests/integration/ocr-http.mjs:1500,1337,1501-1560`、`speech-http.mjs:263,225`、`recognitions-api.test.mjs:114,293`、`tts-jobs-http.test.mjs:218,225` 的既有断言，**照抄读数而不是重写期望**。
   - 收益：一次补齐 12 个 operation（recognitions 4 + ocr 5 + speech 4 + tts 1 + jobs 2）的 401/404 两列，且 `MIN_CASES` 会从 168 单调上升（`gy-i22-failmatrix.test.mjs:28` 只准加）。
   - 是否需要真实设备/真库：**都不需要**（failmatrix 走 `app.inject` + stub，仓库已如此）。

3. **给 `selectSpecies` 与 `confirmTranscription` 补归属/未登录断言（覆盖「整行裸奔」）**
   - 位置：`tests/unit/recognitions-api.test.mjs`（追加 `PATCH /recognitions/:id/selection` 的他人 404 与游客 401，范式照 `:114-116`、`:293`）；`tests/integration/speech-http.mjs:263` 的循环里加上 `PATCH .../confirmation`（范式照 `:285,784`）。
   - 收益：消掉 §4.1 #3 与 #8；两处都在既有文件内追加，不新增 harness。
   - 是否需要真实设备/真库：**都不需要**。

**不建议**在本轮做的事（会被上述 3 件反噬）：把 `verifyRegistration` 装配进 HTTP（`planned`，属功能开发，不是失败回归）；补齐 community 全部同形断言（收益低于 1–3，且 `C2` 族已覆盖主体）。

### 4.3 与 `docs/architecture/contract-status.json` 的交叉核对（只列不改）

113 个 operation：`partial` 96 / `implemented` 13 / `planned` 4。以下 blocker 原文与本页矩阵**互相印证或互相冲突**，逐条列出：

| operation | status | blocker 摘录 | 与本页矩阵的关系 |
| --- | --- | --- | --- |
| `verifyRegistration` | planned | 「HTTP 路由未装配」 | **印证** §2.5 整行不适用；矩阵里唯一整行为空的 op |
| `listFavorites` / `createFavorite` / `deleteFavorite` | partial | 「real 模式整域 503 `PROVIDER_UNAVAILABLE`」 | **印证** §2.3 的 503 列（`favorites-http.test.mjs:318`） |
| `listHistory` / `deleteHistory` | partial | 「内存存储 + real 模式关闭」 | **印证** §2.3 的 503 列（`history-http.test.mjs:548,751`） |
| `listMessages` / `getUnreadCount` / `markMessageRead` | partial | 「`real` 且无连接池 ⇒ 整域 503」 | **印证** §2.4 的 503 列（`messages-http.test.mjs:189-198`） |
| `createRecognition` / `getRecognition` / `deleteRecognition` / `selectSpecies` | partial | 「HTTP 与内存任务/结果/选种/删除闭环已装配；…真实供应商…尚待验收」 | **与 #3 冲突**：blocker 说"选种闭环已装配"，但矩阵里 `selectSpecies` **8 列全 ○**（装配≠有断言） |
| `createOCR`…`verifyOCR`（5 条） | partial | 「OCR 五端点…已装配；real 提供者、媒体、登记源未接线时拒绝」 | **与 #5 呼应**：装配完整但 403 全族无断言 |
| `createTranscription`…`confirmTranscription`（4 条） | partial | 「取消已于 GY-R27（#321）接线」 | **与 #8 冲突**：`confirmTranscription` 无 401/404 断言 |
| `createSynthesis` | partial | 「取消已于 …接线」；「真实提供者、核对内容与产物端口未在产品装配接线」 | **印证** §2.9 的 503 列（`tts-jobs-http.test.mjs:510,570`） |
| `loginWechat` | implemented | 「stub/preset_demo 用合成身份，不代表真实微信身份」 | **与本页 #1 冲突**：`implemented` 但 429 零断言 |
| `loginAdmin` | implemented | 「凭据错误沿用 401 `SESSION_REQUIRED`（契约无专用码）」 | **与本页 #10 冲突**：该"故意选择"无断言钉住 |
| `grantCommunityMediaAccess` / `readCommunityMediaContent` | partial | 「公开内容来源默认**关闭**（统一 404，不误放行）」 | **印证** §2.2 末两行（`C5-05@196`、`E2-02@279`） |
| `listPosts`…`getOwnReport`（16 条社区） | partial | 统一 blocker：「HTTP 路由已装配（`services/api/src/routes/community.ts`；真实回环回归 `tests/unit/community-http.test.mjs`）」 | **部分冲突**：`community-http.test.mjs` 里状态码断言只有 `:790`（422）一条，blocker 暗示的"回环回归"并不覆盖失败族（失败族断言实际散在 `community-service/atomic/moderation-*` 等服务层文件） |
| `hidePost` / `listAuditEvents` | partial | 「路由已装配（`services/api/src/routes/admin.ts`，HTTP 集成回归 `tests/integration/admin-http.mjs`）」 | **印证** §2.10（`admin-http.mjs:494-497`） |
| `listKnowledge` | partial | 「当前 id_asc 排序仍不同于冻结(created_at DESC,id DESC)」 | 与本页矩阵无关（排序口径），登记备查 |
| `withdrawConsent` | partial | 「PG 撤回在 jobs/media/exports/author_links 存在依赖时仍 409 `OBJECT_UNAVAILABLE`，保留 fail-closed」 | **印证** §2.11 的 409 列（`media-consent-wiring.test.mjs:214`） |
| `grantConsent` | partial | 「该 purpose 的已核验可用政策行须先落入 consent_policies，否则 403 `CONSENT_REQUIRED`」 | **印证** §2.11 的 403 列 |

---

## 5 未取得 / 未验证（一律不许当成绿）

1. **本次没有成功跑过任何用例**：唯一尝试的定向文件 `tests/unit/gy-i22-failmatrix.test.mjs` 因本 worktree 未装依赖直接失败（`ERR_MODULE_NOT_FOUND: Cannot find package 'fastify'`，原始报错与复现方式见 §7）。因此上表所有 ● 与 ○ 都是**读码定位**，不是本轮实测读数。
2. **未跑全量单测**（按派单禁止）、**未起真库**、**未起真机/微信开发者工具**、**未发真实外网**。
3. `tests/integration/*-pg.mjs` 类证据（`messages-pg.mjs:284`、`favorites-history-pg.mjs:11-12`、`recognitions-pg.mjs:889`、`ocr-jobs-pg.mjs:744`、`admin-flags-pg.mjs:513`）需隔离 PG，本轮**未执行**；它们在 `real-pg-integration.yml` 等流水线跑，不在 `test:integration:http` 名单内。
4. **限流 429 的真实行为**（窗口、键、`Retry-After`）完全未验证——只有 `services/api/src/auth/wechat.ts:121` 一行实现。
5. **同步面 504 的真实触发条件**未验证（映射存在，但用户面没有可触发的锁路径）。
6. 真实 AI 供应商的超时/配额/结果不确定，**一律未取得**（stub 世界的 `timed_out` 不代表真实供应商行为）。
7. `docs/architecture/contract-status.json` 只读交叉核对，**未改动**（在飞 PR 占用）。
8. 本页的"断言密度"数字是 `tests/**` 内状态码字面量出现次数的**粗筛**（按域正则聚合），不是断言条数；只用于排序，不作为判定依据。

---

## 6 附：本页的定位口径速查

| 缩写 | 全文 |
| --- | --- |
| `C1-*@行` | `tests/failmatrix/cases.mjs` 第 N 行的用例（例：`C1-01@52`） |
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
