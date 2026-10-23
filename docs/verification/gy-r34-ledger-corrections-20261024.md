# R34 旧台账订正（`gy-r31-closure-matrix-20261022.md` → main 现状）

- 采样时间：2026-10-24（HKT，UTC+8）
- 订正基线：`upstream/main = 4b87e1d9`（`Reviewed PR #525`）。旧页基线是 `d4d48088`，其后经 `e3c3af05` 做过一次 P2 订正；本页比较的是**旧页现存文案**与**当前 main**。
- 方向约束：本页**只做「旧说法说未做、实际已在 main 落地」这一个方向**。旧页说过期而实际仍未做的，一条都不写进来；反过来，本页也**不**把任何「还没做」写成「做了」——反向边界集中在 §3 列出，供监工对着查。
- 复核口径：判「是否已在 main」不用 `git merge-base --is-ancestor`（上游 squash ⇒ 原提交永不是祖先）。做法是 `git log upstream/main --grep=<标题片段>` 定位提交 + `git show upstream/main:<path>` 读内容核对语义；每条现状锚点都过 `git cat-file -e upstream/main:<path>`。
- 全页不写行号：引用一律 `文件路径:符号名`。
- 旧说法出处一律引旧页的**小节标题**（`## 2 关单就绪度矩阵（24 张）`、`## 3 只差最后一步的 issue（按可关性排序）`、`### 3.1 按监工批复移出本档的两张（原记 差一片能关）`、`## 4 过期台账文案清单（只列不改）`），不写行号、也不复制旧页里的行号锚点。
- 本页共订正 **13 条**（14 个旧说法点，其中两条属同一 issue 的两处独立说法）。

## 1 订正索引

| 序 | issue | 旧说法出处（旧页小节） | 现状锚点（main） | 依据 commit |
| --- | --- | --- | --- | --- |
| 1 | #16 | `## 2 关单就绪度矩阵（24 张）` 的 #16 行 | `services/api/src/app.ts:historyDomainEnabled` | `c728648a` |
| 2 | #16 | `## 2` 的 #16 行 ＋ `## 4` 组 B | `services/api/src/history/cascade-wiring.ts:createHistoryCascadePort` | `869b0358` |
| 3 | #10 | `## 2` 的 #10 行 | `services/api/src/app.ts:ocrMedia` | `371c0ad9` |
| 4 | #6 | `## 2` 的 #6 行 ＋ `## 4` 组 F | `services/api/src/media/store-pg.ts:createPostgresMediaStore` | `e5c38a2f` |
| 5 | #14 | `## 2` 的 #14 行 | `services/api/src/moderation/ledger-pg.ts:createPostgresModerationLedger` | `6244c435`（补丁 `f75e1a1b`） |
| 6 | #18 | `## 2` 的 #18 行 ＋ `### 3.1` | `apps/admin/src/views/JobsView.vue` | `187aced2` |
| 7 | #19 | `## 4` 组 G | `services/api/src/routes/exports.ts:registerExportRoutes` | `d0501cd9` |
| 8 | #22 | `## 3` 的 #22 条 ＋ `## 2` 的 #22 行 | `tests/unit/gy-i22-failmatrix.test.mjs:MIN_CASES` | `ef1e6056` |
| 9 | #22 | `## 2` 的 #22 行（`Retry-After` 半句） | `services/api/src/errors.ts:retryAfterSecondsFor` | `db9117c7` |
| 10 | #29 | `## 3` 的 #29 条 | `tests/unit/consent-withdraw-dependency.test.mjs` | `b018d11c` |
| 11 | #12 | `## 2` 的 #12 行 | `services/api/src/ai/chat-live-adapter.ts:renderSources` | `8a295504` |
| 12 | #17 | `## 2` 的 #17 行 | `miniprogram/pages/messages/messages.wxml:onRetryUnread` | `ac848d9d` ＋ `56ed9f2c` |
| 13 | #15 | `## 2` 的 #15 行 | `services/api/src/community/store-pg.ts:createPostgresCommunityStore` | `1fbe7572`／`f3921dca`／`b1e8fb3e`／`791b34a8` |

## 2 逐条订正

### 2.1 #16 real 模式识别/OCR 终态历史端口

- 旧说法（`## 2 关单就绪度矩阵（24 张）` 的 #16 行，以及 `## 0` 里 2026-10-22 监工 P2 订正的记录）：real 下取 `createUnwiredRecognitionTerminalHistoryPort`／`createUnwiredOcrTerminalHistoryPort`，端口 `kind` 是 `unwired`、`recordTerminal` 是空实现，**生产终态不 `appendHistory`**。
- 现状：判据已改成「历史域是否开启」。`services/api/src/app.ts:historyDomainEnabled` 的表达式是 `config.executionMode !== 'real' || historyStore.persistent`：real 且接上持久 store（`DATABASE_URL` 的 PG store，或注入的持久 store）⇒ `wired`，`recordTerminal` 走 `recordHistoryTerminal` 真落一行；只有 real 且无落点（内存 store）才回到 unwired 并且不放宽 5 条历史路由的 503。
- 依据 commit：`c728648a`（fix(i16): real 模式终态历史端口接真库，判据＝历史域是否开启，Refs #16，PR #484）。
- 复核：`git show upstream/main:services/api/src/app.ts` 搜 `historyDomainEnabled`；`git log upstream/main --grep='终态历史端口'`。
- 仍然缺：真机三页走查；媒体对象与外发撤销两条级联腿未接（见 2.2 的 `HISTORY_CASCADE_WIRED_NOTE` 自述）。

### 2.2 #16 `deleteHistory` 级联腿

- 旧说法：`## 2` 的 #16 行把级联端口写成「属 `#19`，不在本行计」；`## 4 过期台账文案清单（只列不改）` 组 B 把「写入接线」写成「待指挥另行派单」。
- 现状：级联腿已在 main。`services/api/src/history/cascade-wiring.ts:createHistoryCascadePort` 是装配层一行接线用的成品端口（按历史行 `kind` 调 `recognitionService.deleteRecognition`／`ocrService.deleteOcr`，先读当前 revision 再按 `If-Match` 软删，幂等键 `cascade:<historyId>`）；`services/api/src/history/service.ts` 的删除链路已调 `cascade.initiate`，并把 `CascadeDisclosure` 回给客户端。装配点在 `services/api/src/app.ts`（`historyInjection?.cascade ?? createHistoryCascadePort(...)`，闭包解析服务实例，不受装配顺序影响）。
- 依据 commit：`869b0358`（Reviewed PR #503）；`git log upstream/main -- services/api/src/history/cascade-wiring.ts` 只命中该提交。
- 仍然缺：`HISTORY_CASCADE_WIRED_NOTE` 自述只接识别/OCR 两类，媒体对象与外发撤销仍跨线（`#6`／`#19`），所以成功披露只到 `partial`。这一条旧页的说法（「只到 partial」）**仍然成立**，本页没有放宽。

### 2.3 #10 OCR 媒体注入口

- 旧说法：`## 2 关单就绪度矩阵（24 张）` 的 #10 行 —— `BuildAppOptions` 里没有任何 `ocr*` 字段，媒体端口无法注入。
- 现状：`services/api/src/app.ts:ocrMedia` 已是 `BuildAppOptions` 的显式字段（类型 `OcrRouteDeps['media']`），并被透传到 `registerOcrRoutes` 的 `media`。注入口存在即意味着 OCR 域不再「结构上无法注入媒体端口」。
- 依据 commit：`371c0ad9`（feat(api): OCR 域补媒体端口注入口（GY-R31，补齐 #9/#10/#11 共同代码缺口），PR #469）。
- 仍然缺：注入口有、**默认装配仍不注入**，real 下读私有媒体字节仍 fail-closed（要对象存储批准能力）；真实标签样本未取得。

### 2.4 #6 媒体 PG store

- 旧说法：`## 2` 的 #6 行 —— 媒体域无 PG store，只有内存记录 store；`## 4` 组 F 同口径。
- 现状：`services/api/src/media/store-pg.ts:createPostgresMediaStore` 是 PG 仓储（含 `MEDIA_DERIVATIVE_KIND_METADATA_STRIPPED` 这类派生类型与 `classifyMediaDatabaseError` 的错误分类），迁移 `services/api/db/migrations/0029_media_object_cleanup.sql` 一并落地；装配在 `services/api/src/app.ts`，配合 `services/api/src/media/real-ports.ts:approveRealMediaWiring` 的批准能力与 `createObjectRefCipher` 的键接线。
- 依据 commit：`e5c38a2f`（feat(media): 媒体持久化 PG 仓储 + object_ref_cipher 键接线 + 幂等落库，Refs #6 #16，PR #419）。
- 仍然缺：真实对象存储要批准能力（未取得）；`#419` 遗留的丢弃快照残留回收**未核实**（不写成已修）。

### 2.5 #14 审核判定台账 `0028`

- 旧说法：`## 2` 的 #14 行 —— 审核台账仍是内存 `Map`（指 `services/api/src/moderation/decisions.ts`）。
- 现状：`services/api/src/moderation/ledger-pg.ts:createPostgresModerationLedger`（另有 `moderationLedgerStoreOf` 供装配取用）、迁移 `services/api/db/migrations/0028_moderation_persistence.sql`，写面 fail-closed；装配在 `services/api/src/app.ts`（无池才回内存台账）。
- 依据 commit：`6244c435`（feat(moderation): 审核判定台账落库（迁移 0028）＋写面 fail-closed，PR #434）；`f75e1a1b`（fix: update 命中 0 行不得标记为已持久化，PR #482）是紧接的正确性补丁。
- 仍然缺：人审队列 `services/api/src/admin/human-review.ts` 仍 `wired: false`；200+200 真实样本未取得。

### 2.6 #18 作业台页面

- 旧说法：`## 2` 的 #18 行记「作业台页面缺」；`### 3.1 按监工批复移出本档的两张（原记 差一片能关）` 记「#439 合入只是一片 UI 代码」。
- 现状：`apps/admin/src/views/JobsView.vue` 已在 main（经 `apps/admin/src/App.vue` 的 `JobsView v-else-if="active === 'jobs'"` 条件渲染，不走 vue-router），页面本体 600 余行。
- 依据 commit：`187aced2`（feat(admin): 后台作业台页面（#18 最大单点缺口，契约零改动），PR #439）。
- 仍然缺：资料域 27 条路由仍走 `services/api/src/admin/store.ts` 的内存 store（`persistent: false`）⇒ real 全 503。**这一条旧页说得对，本页不放宽**（见 §3）。

### 2.7 #19 `GET /me/exports`

- 旧说法：`## 4 过期台账文案清单（只列不改）` 组 G —— `me/exports` 路由零命中。
- 现状：`services/api/src/routes/exports.ts:registerExportRoutes` 注册 `GET ${API_PREFIX}/me/exports`（`preHandler: guards.requireUser`、`x-scope: user`、`Cache-Control: no-store`、无池或账本不可用即 `PROVIDER_UNAVAILABLE` 且不降级内存账本）；数据面 `services/api/src/privacy/exports-list.ts:createExportsListService`，经 `packages/privacy/egress.mjs:listExportsForUser` 投影成契约 `ExportPage`。
- 依据 commit：`d0501cd9`（Reviewed PR #510）；`git log upstream/main -- services/api/src/routes/exports.ts` 只命中该提交。
- 仍然缺：导出产物本体仍只有读面（没有「生成导出文件」这条链）；真实回执与第三方完成材料未取得；主线删除模块仍是四面（等 `#528`）。

### 2.8 #22 230 条失败矩阵

- 旧说法：`## 3 只差最后一步的 issue（按可关性排序）` 的 #22 条 —— 只差 `#449` 等合入；`## 2` 的 #22 行同口径。
- 现状：`tests/unit/gy-i22-failmatrix.test.mjs:MIN_CASES` 把下限定在 **230**（断言 `payload.totals.total >= MIN_CASES`，并逐条要求真实读数），矩阵用例集在 `tests/failmatrix/cases.mjs`，异步 AI 域的 C10（游客面）/C11（归属面）已并入；负控制在 `tests/failmatrix/mutations.mjs`，本轮实点 **23** 条（`id: 'NC-...`）。
- 依据 commit：`ef1e6056`（test(i22): 异步 AI 域纳入失败矩阵（C10 游客面 / C11 归属面），PR #449）。
- 仍然缺：stdout 私密前缀定级与四个域是否纳入需用户裁定；真机回归未跑。

### 2.9 #22 `Retry-After`

- 旧说法：`## 2` 的 #22 行 —— `Retry-After` 缺头（旧页把锚点打在 `services/api/src/auth/wechat.ts` 一带）。
- 现状：`Retry-After` 已有**唯一口径**：`services/api/src/errors.ts:retryAfterSecondsFor` 决定整数秒（429 `RATE_LIMITED`／`PROVIDER_QUOTA_EXCEEDED` 与 409 `REQUEST_IN_PROGRESS` 必带），全仓只有 `services/api/src/app.ts` 的统一错误出口写这个头（`reply.header('Retry-After', String(retryAfterSeconds))`）。
- 依据 commit：`db9117c7`（fix(api): 429 补 Retry-After 整数秒（统一出口单一取值口径，依 state-contract.md 的 27 行判据），PR #450）。
- 仍然缺：与 2.8 同（裁定与真机回归）。

### 2.10 #29 撤回依赖臂

- 旧说法：`## 3 只差最后一步的 issue（按可关性排序）` 的 #29 条 —— 只差 `withdrawConsent` 的 409 依赖臂。
- 现状：依赖臂已钉住并有测试：`tests/unit/consent-withdraw-dependency.test.mjs`（依赖存在不阻断撤回；只有缺消费者时才 409）。接口面在 `services/api/src/privacy/grant-pg.ts`，外发记账在 `services/api/src/privacy/task-egress.ts`。
- 依据 commit：`b018d11c`（test(privacy): 撤授权与依赖的关系钉住（依赖不阻断撤回、缺消费者才 409），PR #466）。
- 仍然缺：前端授权/撤回界面整条零实现（`miniprogram/pages` 下无 consent/privacy 页）；真实撤回回执未取得。**旧页把 #29 记成「差一片能关」仍然偏乐观，本页按纯代码缺口记。**

### 2.11 #12 真模型接线

- 旧说法：`## 2` 的 #12 行 —— 在飞 `#409` 接真模型。
- 现状：`#409` 已合入 main。`services/api/src/ai/chat-live-adapter.ts` 提供 `chatModelVersion`／`renderSources`／`bodyViolationsOf` 与 `CHAT_MAX_SOURCES`／`CHAT_SOURCE_BODY_CHARS`／`CHAT_QUESTION_CHARS` 三个上限；会话落库在 `services/api/src/conversations/store-pg.ts`（迁移 `0013`）。
- 依据 commit：`8a295504`（feat(api): #12 文字问答接真实模型（四与门 + 外发记账，Refs #12 #13），PR #409）。
- 仍然缺：真实模型调用读数与固定 120 题评估（预算授权未取得）。审计记的 P1「伪引用」在 main 上已有拒收判据（`tests/unit/conversation-answer-guard.test.mjs` 断言集合外 URL 进 `rejected_text`、`tests/unit/conversation-chat-live.test.mjs` 有同向断言），但**整条真调链的读数**未取得。

### 2.12 #17 跳转入口与未读数重试

- 旧说法：`## 2` 的 #17 行 —— 「跳转客户端整体未落地」「未读数失败无重试」。
- 现状：`miniprogram/pages/messages/messages.wxml` 已有 `onRetryUnread`（未读失败不再静默清空角标）、`onFilter`、`onMarkAllRead`；跳转入口已补（`#448`）。服务端标读走 `services/api/src/messages/store-pg.ts:createPostgresMessagesStore` 的 CAS。
- 依据 commit：`ac848d9d`（feat(miniprogram): 消息页补跳转入口与未读数重试，订正两处过期文案（#17 G1/G3/G7），PR #448）＋ `56ed9f2c`（fix(messages): 未读数失败不再静默清空角标，并补 G7／G8 防回退断言，PR #468）。
- 仍然缺：跳转范围只有 post/comment，其余 14 型是如实降级（`#477` 裁定），需用户确认是否可接受；真机走查未做。

### 2.13 #15 代码八条（S1–S8）

- 旧说法：`## 2` 的 #15 行 —— 「代码 8 条：S1…S8」。
- 现状：四类已落地 —— ①社区 PG 仓储 `services/api/src/community/store-pg.ts:createPostgresCommunityStore`（迁移 `0022`）；②注销清社区行 + 举报状态机推进（`#474`）；③列表筛选下推 SQL + 分页确定性 + 越权负控制（`#461`）；④注销时断开举报 `reporter_id`（迁移 `0032`）与行级作者引用（迁移 `0030`，`author_id` 可空 + `anonymized_author_ref`）。
- 依据 commit：`1fbe7572`（#474）、`f3921dca`（#461）、`b1e8fb3e`（#492）、`791b34a8`（#483）。
- 仍然缺：真实审核供应商未接；点赞计数无读面（服务层有 `services/api/src/community/service.ts:countLikes`，契约只有 like/unlike 四个 operation、没有计数读取端点）；`linked_knowledge_ref` 落 `createUnwiredKnowledgeAvailabilityPort()` ⇒ 带知识引用的发帖必 409。**S4／S7 这两条旧说法仍然成立。**

## 3 反向边界：旧页说过期但本轮核到**仍然成立**的

订正页最容易被读成「全都做完了」。下面这些是本轮实核后**没有推翻**的旧说法，监工可以照着对：

- #18：资料域 27 条路由 real 全 503 —— `services/api/src/admin/store.ts` 仍 `persistent: false`，`services/api/src/admin/fail-closed-services.ts` 与 `services/api/src/admin/service.ts` 都还在用 `createAdminContentStore()` 的内存实现。
- #14：人审队列 `services/api/src/admin/human-review.ts` 仍 `wired: false`（多处），没有真人复核入口。
- #15：点赞计数无读面（契约只有 like/unlike）；`linked_knowledge_ref` 仍 409。
- #11：MP3→WAV 仍无解码器 —— main 上只有 `tests/unit/i11-audio-mp3-wav-guard.test.mjs` 这条**拒绝路径**守卫。
- #10：注入口有了，但默认装配不注入，real 下 OCR 读私有字节仍 fail-closed。
- #16：级联只到 `partial`（媒体对象与外发撤销两条腿未接）。
- #29：前端授权/撤回界面整条零实现（`miniprogram/pages` 下无 consent/privacy 页）。
- #6：真实对象存储要 `services/api/src/media/real-ports.ts:approveRealMediaWiring` 铸造的批准能力，未取得。
- #19：主线删除模块仍是四面（`USER_DATA_DELETION_MODULES` 四项 + 社区条件项），识别/语音两条腿还在 `#528` 上。
