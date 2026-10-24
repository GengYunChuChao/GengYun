# #16／#17／#7／#8 关闭材料汇总（E6 · 2026-10-21）

> **本片不关闭任何 issue。** 关闭权在监工；本页只把四张 issue 的「已取得／未取得／还差什么」摊在一处，供监工照页签核。
> 本页不含「验收通过」「可关闭」「已验收」这类结论，也不评论、不关闭、不推 PR。
> 姊妹页：[B4 注销清理收口勘察](gy-i16-i17-deletion-cascade-20261021.md)（提出补 C5 的那一页）、[C5 收藏/历史端到端接线](gy-r28-c5-favorites-history-20261021.md)、[旧关闭材料索引（2026-10-18）](gy-issue-closure-index-20261018.md)。

## 0 口径、基线与禁用词

| 项 | 读数（本片实测） |
| --- | --- |
| 工作树 | `E:\GengYunCommander\wt-e6-closure` |
| 分支 | `docs/gy-r28-e6-closure-materials` |
| 基点 | `origin/main = ee46eb1`（`git log --oneline -1` 实读；`git merge-base --is-ancestor origin/main HEAD` 退出码 0） |
| 本页改动面 | 只新增本文件 + 在旧索引页**末尾追加**一节；`.ts`／`.js`／`.mjs`／SQL／JSON 零改动（含 `openapi.json`、`contract-status.json`） |
| 依赖 | 工作树无 `node_modules`（`Test-Path node_modules` ⇒ `False`）⇒ 本片**未跑任何 `node --test`**，只跑文档校验 |
| issue 状态 | #7 OPEN、#8 OPEN、#16 OPEN、#17 OPEN（`gh issue view … --json state` 只读读取，未评论、未关闭） |
| 前置状态 | #3 CLOSED；#4／#9／#10／#14／#15／#28／#29 均 OPEN（同一只读读取） |

用语（本页只用这四种）：

| 用语 | 含义 | 本页用法 |
| --- | --- | --- |
| 已取得 | 仓库内有可复核的 `文件:行`，或既有证据页已记录的读数 | 逐条给锚点；本片未重跑的，写明「读数出自哪一页」 |
| 未取得 | 缺证据 | 逐条写原因与前置 |
| C5 | 本片建议新增的「注销时点该域行被硬删且行数入证据」判据（见 §1.4） | 逐子项判「满足／部分／未满足」 |
| 不适用 | 该域没有对应对象 | 只用于 #7／#8（无用户私有行域） |

**行号漂移提醒（本片实读到的三处）**：B4 页写的 `services/api/src/privacy/user-data-deletion.ts:63-67`（两域闭集）、`app.ts:1490-1495`（注销 503）在 HEAD 已漂移为 `:93-98`／`:1554`；`gy-i17-messages-pg-20261018.md` 的 `messages/store-pg.ts:139`／`:186`／`:215` 在 HEAD 为 `:246`／`:293`／`:323`。本页一律用 HEAD 实读行号。

---

## 1 #16 「实现收藏与可浏览的识别历史」

- 状态：`OPEN`；验收复选框 4 条；issue 正文前置 5 项（#4／#9／#10／#28／#29，全部 OPEN）。

### 1.1 验收原文（逐字引用 issue 正文，未改写）

- [ ] 他人不能读取私有历史，旧收藏不恢复失效推荐资格
- [ ] 候选与人工选择分开，失败任务真实可见
- [ ] 识别／收藏不自动转成已使用事实
- [ ] 列表、详情、收藏历史和消息均在读取时重查对象权限及当前可见性；隐藏／失效／注销不因缓存或旧链接重新公开

对应编号：C1／C2／C3／C4（与引用顺序一致）；C5 是本页**建议新增**的第 5 条（issue 正文里没有）。

### 1.2 已取得（9 条）

| 编号 | 内容 | 证据（HEAD 实读） |
| --- | --- | --- |
| A1 | 收藏域三个 operation 的 HTTP 面与私有响应头 | `services/api/src/routes/favorites.ts:89`（GET）、`:94`（POST）、`:109`（DELETE）、`:26`（`Cache-Control: no-store`） |
| A2 | 收藏/历史落 PG，real 无池即整域 fail-closed | 迁移 `services/api/db/migrations/0018_favorites_history.sql`；`services/api/src/favorites/store-pg.ts`、`services/api/src/history/store-pg.ts`；503 抛点 `routes/favorites.ts:84`、`routes/history.ts:75` |
| A3 | 历史域两个 operation | `services/api/src/routes/history.ts:80`（GET）、`:85`（DELETE） |
| A4 | 归属校验：他人与不存在同形 404；单条删除带 `owner_id`＋`revision` 的 CAS | `favorites/service.ts:117`（`notFound`）、`history/service.ts:125`；`favorites/store-pg.ts:253`、`history/store-pg.ts:255` |
| A5 | 读取时逐次重查可见性（不入库、不缓存） | `favorites/service.ts:233`（`project`）→ `:234`（`deriveVisibility`）；`history/service.ts:227`／`:233`；派生端口 `services/api/src/targetref/visibility.ts:170` |
| A6 | 收藏／识别不转成「已使用事实」 | `favorites/service.ts:67`（`FAVORITE_PROJECTION_FIELDS`，投影六字段无 used/usage）、`:91`（`favoriteEligibleForRecommendation` 只看本次 `reference_state === 'available'`） |
| A7 | 候选与人工选择分开、失败任务可数 | `miniprogram/utils/history-api.js:343`（`modelCandidates`）、`:347`（`manualSelection`）、`:354`（`candidateSelectionSeparated: true`）；`miniprogram/pages/history/history.js:74`（`failedCount` 逐条统计 `entry.failed`） |
| A8 | 401 与 403 分档（403 不再折叠成掉登录） | 单一事实源 `miniprogram/utils/auth.js:95-109`；收藏/历史两侧委托 `miniprogram/utils/favorites-api.js:100`、`miniprogram/utils/history-api.js:171`；契约 403 闭集 `packages/contracts/openapi.json:16831-16835` |
| A9 | 注销时点硬删收藏/历史（正文与幂等台账），行数入证据 | `favorites/store-pg.ts:172`（`DELETE FROM favorites … RETURNING id`）、`:176`（台账）；`history/store-pg.ts:160`、`:164`；闭集 `services/api/src/privacy/user-data-deletion.ts:93-98`、注册 `:444-445`；真库 PG17 读数 `tests/integration/favorites-history-pg.mjs:482-505`（A 四表残留 0、B 行逐表相等、证据串含两个计数） |

补充可引的既有证据页（本片未重跑）：[阶段 2 PG 持久化](gy-i16-favorites-pg-20261017.md)、[读时权限/失效/去重语义收口](gy-i16-semantics-20261019.md)、[C5 端到端接线盘点](gy-r28-c5-favorites-history-20261021.md)。

### 1.3 未取得（6 条）

| 编号 | 缺什么 | 原因与前置 |
| --- | --- | --- |
| B1 | 真机页面证据 | `docs/verification/platform-checklist.md:40`「真机设备」行状态列逐字「未验证」；`:48`（Android 真机联网）、`:49`（iOS 真机联网）同为「未验证」。前置：可用真机＋已登录小程序 |
| B2 | `real` 装配下「注销」这条链路可达 | `services/api/src/app.ts:1731` `available: config.executionMode !== 'real'` ⇒ 真实环境连发起注销都 503。前置：P0 各域补齐后再放开（B4 页 §7 P0-5 的顺序要求） |
| B3 | 30 日备份副本的真实时间读数 | 现有幂等/到期读数全部来自注入时钟（`tests/integration/backup-purge-pg.mjs` 的 `advanceDays`）；真实 31 天等待未做。前置：#19 侧驱动者的运维形态裁定（`tools/purge-expired-backup-copies.mjs` 已存在，本片未跑） |
| B4 | 识别结果页的「收藏」入口 | C5 页 §1 表判「未通（缺口，本次不实施）」、§7.1 列待裁决；`identify.wxml`／`identify.js` 对「收藏」零命中（C5 页 §4 实测）。前置：口径裁定（收藏对象是候选 `species_id` 还是识别结论） |
| B5 | 微信开发者工具编译／真实登录链路 | [知识小程序接线盘点](gy-i07-knowledge-miniprogram-wiring-20261021.md) §7 记录 `cli.bat` 返回 `EPERM`／未安装；本片同环境未复核。前置：可写的开发者工具用户目录＋IDE 服务端口 |
| B6 | issue 前置 5 项 | #16 正文逐字列 #4／#9／#10／#28／#29；gh 读数全 `OPEN`（§0 表）。前置：各项自身收口，或监工明示前置不阻塞的裁定 |

### 1.4 C5 判据（本页建议新增，issue 正文没有）

**判据形如：「注销时点该域行被硬删，且被删行数进入回执/诊断证据」**，拆成 5 个子项（`<module>` 取闭集内的模块名）：

| 子项 | 含义 | #16 现状 | 证据 |
| --- | --- | --- | --- |
| (a) | 该域在 `USER_DATA_DELETION_MODULES` 闭集内并被 `registerModule` 驱动 | 满足 | `services/api/src/privacy/user-data-deletion.ts:93-98`、`:444-445` |
| (b) | store 有按主体的 `DELETE … RETURNING` 原语（不是软删、不靠外键级联） | 满足 | `favorites/store-pg.ts:172`、`history/store-pg.ts:160` |
| (c) | 证据串含 `<module>:online-purged:<n>`，n 取自 `RETURNING` 实际行数 | 满足 | `favorites/store-pg.ts:21-23` 自陈计数口径；断言 `tests/integration/favorites-history-pg.mjs:493-498` |
| (d) | 至少一条执行读数证明「本主体 n 行消失、他人行不动」 | 满足 | `tests/integration/favorites-history-pg.mjs:482-487`（真 PG 17 arm：残留 0、他人逐表相等） |
| (e) | `real` 装配下该链路可达（注销 HTTP 面不 503） | 未满足 | `services/api/src/app.ts:1731` |

**结论（只写事实，不写结论词）**：#16 的 C5 在「实现＋真库行为」层面 5 项中满足 4 项；缺的只有 (e) 端到端可达。B4 页 §3 矩阵的收藏/历史两行与本表 (a)(b)(c) 一致，可直接复核。

### 1.5 若要关闭，还差哪几项

1. B1 真机页面证据（或监工对「页面级证据可由组件/集成测试代偿」的裁定）。
2. B2（或监工对「C5 只作实现级判据、端到端可达另计」的口径裁定）。
3. B6：前置 #4／#9／#10／#28／#29 的处置。
4. B4：识别结果页收藏入口的裁定与实施（若监工认定在 #16 范围内）。
5. B3：备份 30 日的真实时间读数，或明示以注入时钟为准。

---

## 2 #17 「实现首版应用内消息、未读状态与权限跳转」

- 状态：`OPEN`；验收复选框 4 条；issue 正文前置 5 项（#4／#14／#15／#28／#29，全部 OPEN）。

### 2.1 验收原文（逐字引用 issue 正文，未改写）

- [ ] 重复调度不重复创建，未读计数可复核
- [ ] 发送或创建不当作已读；游客和其他用户不可读
- [ ] 首版不接微信外部推送，不虚构真人互动消息
- [ ] 列表、详情、收藏历史和消息均在读取时重查对象权限及当前可见性；隐藏／失效／注销不因缓存或旧链接重新公开

编号 C1／C2／C3／C4；C5 同 §1.4 的建议新增条。

### 2.2 已取得（10 条）

| 编号 | 内容 | 证据（HEAD 实读） |
| --- | --- | --- |
| A1 | 三个 operation 与实现一一对应 | 路由 `services/api/src/routes/messages.ts:43`（`GET /messages`）、`:53`（`GET /messages/unread-count`）、`:59`（`PUT /messages/{id}/read`）；契约 `packages/contracts/operations.json` 的 `listMessages`／`getUnreadCount`／`markMessageRead` |
| A2 | 重复不重复创建（唯一约束判定，无 SELECT 前置） | `messages/store-pg.ts:246-264`（`INSERT … ON CONFLICT DO NOTHING RETURNING`，看返回行判 `inserted`／`duplicate`） |
| A3 | 未读是派生量（没有计数器列 ⇒ 无计数漂移） | `messages/store-pg.ts:323-330`（`SELECT count(*) … owner_id = $1 AND read_at IS NULL`） |
| A4 | 标记已读＝CAS＋单调＋恰好一次版本推进 | `messages/store-pg.ts:293-321`（`UPDATE … WHERE id AND owner_id AND read_at IS NULL RETURNING`） |
| A5 | 归属：非本人与不存在同形 404 | `messages/service.ts:382`／`:402`（`record.owner_id !== user.userId` ⇒ `notFound()`）；存储层 `messages/store-pg.ts:312`（`OWNER_CHANGED`） |
| A6 | 401 与 403 分档 | `miniprogram/utils/auth.js:95-109`；消息侧 `miniprogram/utils/messages-api.js:123-124`；契约 403 闭集 `packages/contracts/openapi.json:16831-16835` |
| A7 | 注销时点硬删消息域（正文＋共享幂等台账，同一事务） | `messages/store-pg.ts:220-241`（`DELETE FROM public.messages … RETURNING id` ＋ `DELETE FROM public.idempotency_keys … RETURNING scope`）；闭集 `privacy/user-data-deletion.ts:71`、`:93-98`、注册 `:449` |
| A8 | 行数进证据（`records` 与 `idempotency` 分表计） | `privacy/user-data-deletion.ts:100-103`（`OwnerPurgeCounts`）；真表断言 `tests/unit/favorites-history-deletion-registration.test.mjs:288`（消息行必须真删）、`:290`（他人消息行不动）、`:426`（`messages:online-purged:1;messages:idempotency-purged:1`）、`:498`（`messages:online-purged:0;…` 同形） |
| A9 | 不接外部推送、不虚构真人消息 | `services/api/src/messages/**` 与 `routes/messages.ts` 对 `subscribeMessage`／`webhook`／模板消息／`openid` **0 命中**（本片 grep 实跑）；`push` 命中均为数组 `push`（`messages/service.ts:345`、`:390`）；台账 blocker 逐字「…不虚构真人消息」（`docs/architecture/contract-status.json:2019`） |
| A10 | 备份副本 scope 已登记 `message`，注销后 30 日链有对象可清 | `packages/privacy/backup-copies.mjs:38-43`（`messages: 'message'`）；清单源 `privacy/user-data-deletion.ts:321-325` |

补充可引的既有证据页（本片未重跑）：[阶段 2 消息域 PG 持久化](gy-i17-messages-pg-20261018.md)（真 PG 17.11 读数：`[D]`／`[R]`／`[N]`／`[C]`／`[U]`／`[P]` 六组全 PASS，见该页 §3）、[首版消息域服务层证据](gy-i17-messages-20261012.md)。

### 2.3 未取得（6 条）

| 编号 | 缺什么 | 原因与前置 |
| --- | --- | --- |
| B1 | 真机页面／Android 读数 | `docs/verification/platform-checklist.md:40`／`:48` 均「未验证」；`gy-i17-messages-pg-20261018.md` §5 自陈「未取得 真机（微信端）读数」 |
| B2 | `real` 装配下注销链路可达 | 同 §1.3 B2：`app.ts:1731` ⇒ 真实环境注销 HTTP 面整域 503 |
| B3 | 消息域在**真 PG 服务器**上的注销行数读数 | `tests/unit/messages-deletion-purge.test.mjs` 文件头自陈为记录型假池（非真 PG／非 PGlite）；真库 arm `tests/integration/favorites-history-pg.mjs:456-460` 逐字「本 arm 只应用 0001+0018…没有 `public.messages` 表」，消息域在该 arm 走内存 store 且证据恒 0 行；真表级证据只在 PGlite（`tests/unit/favorites-history-fixtures.mjs` 的 `PG_MIGRATIONS_WITH_MESSAGES`）。⇒「PGlite 真表有、真 PG 服务器无」。前置：把 0019＋0023 纳入同一条真库注销 arm |
| B4 | 共享幂等台账前缀删的跨域副作用裁定 | `messages/store-pg.ts:206-215` 自陈：`public.idempotency_keys` 是共享表，前缀删会连带删本主体在 auth 等其它域写入的幂等行，「属副作用而非本域自清」。前置：监工/合规对该副作用的裁定 |
| B5 | 台账与代码不同步 | `docs/architecture/contract-status.json:2019`（`:2041`／`:2063` 同文重复）仍把「PG/注销」记为待验收，而 HEAD 已有原语＋闭集＋注册＋备份 scope。本片红线不改该 JSON，只登记 |
| B6 | issue 前置 5 项 | #17 正文列 #4／#14／#15／#28／#29，gh 读数全 `OPEN` |

### 2.4 C5 判据（同 §1.4 的 5 子项）

| 子项 | #17 现状 | 证据 |
| --- | --- | --- |
| (a) 闭集内并被驱动 | 满足 | `privacy/user-data-deletion.ts:71`、`:93-98`、`:449` |
| (b) 按主体 `DELETE … RETURNING` 原语 | 满足 | `messages/store-pg.ts:228-238` |
| (c) 证据串含 `<module>:online-purged:<n>`，n 取 `RETURNING` 行数 | 满足 | `privacy/user-data-deletion.ts:100-103`；断言 `tests/unit/favorites-history-deletion-registration.test.mjs:373` |
| (d) 执行读数证明「n 行消失、他人行不动」 | **部分** | PGlite 真表满足（`…deletion-registration.test.mjs:186-188`）；真 PG 服务器 arm 缺（§2.3 B3） |
| (e) `real` 装配下链路可达 | 未满足 | `services/api/src/app.ts:1731` |

**结论（只写事实）**：#17 的 C5 三项满足、一项部分、一项未满足；与 B4 页 §3 矩阵「消息域 ❌ 一行不删（G1+G2）」相比，HEAD 已把 G1／G2／G3 落地（PR `7f115e8` 补原语、`c62bb38` 扩闭集到四域），但 B4 页**尚未更新**——两页并存时以本页 HEAD 读数为准。

### 2.5 若要关闭，还差哪几项

1. B3：真 PG 服务器上的消息域注销行数是唯一缺的「行数入证据」档次。
2. B2（或监工对 C5 端到端可达另计的口径裁定）。
3. B4：共享台账前缀删的跨域副作用裁定。
4. B6：前置 #4／#14／#15／#28／#29 的处置。
5. B1 真机读数；B5 台账更新（属 #19／#17 台账负责人，本片不改）。

---

## 3 #7 「实现科普／除草剂查询、详情与来源版本展示」

- 状态：`OPEN`；验收复选框 3 条；issue 正文前置 #3（CLOSED）与 #4（OPEN）。

### 3.1 验收原文（逐字引用 issue 正文，未改写）

- [ ] 任一展示记录能追溯实际来源；缺项不通过空白或模型补写填充
- [ ] 下架／失效退出有效查询，详情和列表一致
- [ ] 不授AI／用户经验专家认证标签，不对模拟记录显示真实用量

编号 C1／C2／C3。

### 3.2 已取得（7 条）

| 编号 | 内容 | 证据（HEAD 实读） |
| --- | --- | --- |
| A1 | 来源名称／标识／版本四处展示（今日 C4 补齐除草剂列表与详情三行；科普两处为既有） | 列表 `miniprogram/pages/reference/reference.wxml:79`（来源）、`:80`（来源标识）、`:81`（来源版本）；详情 `miniprogram/pages/referencedetail/referencedetail.wxml:102`、`:103`、`:115`；科普 `miniprogram/pages/knowledge/knowledge.wxml:78`、`:79`；科普详情 `miniprogram/pages/knowledgedetail/knowledgedetail.wxml:36`、`:37` |
| A2 | 服务端行 → 视图字段的映射（同一口径） | `miniprogram/utils/knowledge-api.js:194`（`source_id`）、`:198`（`source_name`＝发布机构 · 标题）、`:199`（`source_version`）、`:201`（`source_marker`）；随包离线行同口径 `miniprogram/utils/reference.js:417`、`:420`、`:415` |
| A3 | 缺项不由页面补写（可解释占位） | `reference.wxml:79-81` 与 `referencedetail.wxml:102-104` 一律 `… 接口未提供`；登记表缺字段返回空串、由页面占位：`miniprogram/utils/reference.js:44-47`（「登记表里没有的字段一律返回空串」）、`:417`／`:420` |
| A4 | 来源可追溯＋下架/失效退出查询 | `services/api/src/knowledge/reference-query.ts:109`（`createReferenceQueryService`）、`:75`（`toSeedRows`）；`services/api/src/knowledge/public-invalidation.ts:81`（`decidePublicVisibility`） |
| A5 | 不授专家标签、不显示模拟用量 | `packages/reference/constants.mjs:157`（`FORBIDDEN_LABELS`）、`:97`（`DISPLAY_LABELS`）；客户端拒绝非空剂量卡 `miniprogram/utils/knowledge-api.js:56`（`UNSUPPORTED_DOSE_RESPONSE`） |
| A6 | C4 的回归测试在库 | `tests/unit/miniprogram-source-provenance-display.test.mjs`（`git show --stat 23b5f0e` 实测 231 行新增） |
| A7 | 排序在**代码侧**已按冻结契约实现 | `services/api/src/knowledge/service.ts:76`（`ORDER BY created_at DESC, id DESC`）、`:33-38`（同序 JS 比较器）、`services/api/src/knowledge/pagination.ts:11`（`SORT = 'created_at_desc'`）；承接 PR `b56ba9d`（2026-10-16，标题「知识列表排序对齐冻结契约」）；视图补 `created_at` 的迁移 `services/api/db/migrations/0012_knowledge_created_at.sql:87` |

### 3.3 未取得（5 条）

| 编号 | 缺什么 | 原因与前置 |
| --- | --- | --- |
| B1 | 排序口径在**台账**仍未收口（与 A7 方向相反） | `docs/architecture/contract-status.json:716`（`GET /knowledge` 条目 blocker 逐字「当前id_asc排序仍不同于冻结(created_at DESC,id DESC)，实际表/投影无created_at，排序及历史数据方案未完成，按partial保留」）、`:3164`（跨切面条目同义）；`docs/architecture/contract-implementation-status.md:72`（`listKnowledge` 记 `partial`）。本片红线不改 JSON／台账 ⇒ 只登记口径差 |
| B2 | 真实来源与真实消费者读数 | [知识小程序接线盘点](gy-i07-knowledge-miniprogram-wiring-20261021.md) §8；其中 `source.updated_at` 由 `retrieved_at`（日期）转 `date-time` 的服务端投影**未实测**（同页 §5） |
| B3 | 真机／开发者工具渲染读数 | 同页 §7（`cli.bat` 返回 `EPERM`／未安装）；`platform-checklist.md:40`「未验证」 |
| B4 | 「实际来源」的审核与许可事实 | `packages/knowledge/zhejiang/materials-zhejiang-v1.json:42`／`:71`（`review_status: "unverified"`）、`:46`／`:75`（`licensed: false`）⇒ 展示面只能按未核对呈现；取得核准来源属 #3／#10 线 |
| B5 | issue 前置 | #3 已 CLOSED，但 #4 仍 OPEN（gh 只读）；issue 正文逐字「缺前置／真实调用证据不关闭整项」 |

### 3.4 C5 判据

**C5 不适用**：科普（knowledge）与除草剂（reference）是只读资料域，注销闭集里没有对应域表（闭集四域＝favorites／history／messages／conversations，见 `privacy/user-data-deletion.ts:93-98`）。B4 页 §8 也只建议给 #16／#17 补 C5。

若监工仍要一条隐私面判据，本片建议替代口径 **C5′：「展示面对来源与审核/许可状态如实标注，缺项可解释，不由页面补写」**：

| 子项 | #7 现状 | 证据 |
| --- | --- | --- |
| (a) 缺项不用空白／不补写 | 满足 | `reference.wxml:79-81`、`referencedetail.wxml:102-104`（「接口未提供」） |
| (b) 审核/许可状态如实 | 满足 | `materials-zhejiang-v1.json:42`／`:71`（`unverified`）、`:46`／`:75`（`licensed: false`）；标签映射 `packages/reference/constants.mjs:97` |
| (c) 不把模拟记录当真实用量 | 满足 | `knowledge-api.js:56`（非空 `dose_cards` 即拒）；`constants.mjs:157`（禁用措辞） |

### 3.5 若要关闭，还差哪几项

1. B1：排序口径的台账收口（代码已对齐、台账仍 `partial`）——需要监工口径 + 台账更新，本片不改。
2. B2：`source.updated_at` 日期→`date-time` 的投影实测。
3. B3：真机或开发者工具页面读数。
4. B5：前置 #4 的处置（或监工明示不阻塞）。

---

## 4 #8 「实现药剂适用过滤与标签原文用量安全边界」

- 状态：`OPEN`；验收复选框 4 条；issue 正文前置 #7（OPEN）。

### 4.1 验收原文（逐字引用 issue 正文，未改写）

- [ ] 至少100组登记／匹配／限制场景全部通过，含冲突、失效、未知和模拟
- [ ] 未核对／不适用／禁用不能进入可执行建议或问答用量卡片
- [ ] 所有风险文字无绝对安全／零药害承诺，有功能关闭开关
- [ ] 需求第6节100组登记／制剂／来源冲突用例全过；无来源、模拟、失效、多匹配和关键字段冲突均阻断，所有消费端使用同一规则版本

编号 C1／C2／C3／C4。

### 4.2 已取得（7 条）

| 编号 | 内容 | 证据（HEAD 实读） |
| --- | --- | --- |
| A1 | 剂型＋有效成分含量过滤（今日 C2 落地）：解析、判定、命中侧解释 | `packages/reference/query.mjs:46-59`（收窄条件解析）、`:104-123`（规范化）、`:220-230`（剂型/含量判定，与适用判定第 6/7 维同一判据）、`:347-360`（第 6/7 维）、`:381-395`（`ingredientContentMatch` 精确语义） |
| A2 | 小程序侧同口径（域库与页面不各造一套） | `miniprogram/utils/reference.js:220-223`（读条件）、`:252-256`（剂型：未采集如实标注）、`:257-259`（含量精确语义）、`:641`（八个适用维度含 `dosage_form`／`ingredient_content`） |
| A3 | 页面呈现面 | `miniprogram/pages/reference/reference.wxml:32-38`（剂型选择器，注明「不提供含量换算、不提供用量」）、`:67`（逐条剂型/毒性）、`:68`（有效成分原文） |
| A4 | 回归测试在库 | `tests/reference/i08-filter-formulation.test.mjs`（`git show --stat 077d703` 实测 236 行新增） |
| A5 | 100 组场景用例集 | `tests/reference/i08-scenarios-100.test.mjs`（数据驱动场景表＋逐例断言＋计数断言：总数 ≥100、失败 0、每类阻断至少覆盖一次，见文件头 `:5-12`） |
| A6 | 规则版本单一（所有消费端同一版本） | `packages/reference/constants.mjs:195`（`APPLICABILITY_RULE_VERSION = 'gy-i08/1.2.0'`）；版本漂移即失败见 `tests/reference/i08-rule-version.test.mjs` |
| A7 | 可执行建议与用量卡的关闭面＋功能开关 | `packages/reference/deterministic.mjs:511`（`evaluateDoseBoundary`）、`:257`（`evaluateExecutableAdvice`）、`:121`（`readFeatureSwitches`）；禁用措辞 `constants.mjs:157`；客户端拒收非空剂量卡 `miniprogram/utils/knowledge-api.js:56`／`:140` |

### 4.3 未取得（5 条）

| 编号 | 缺什么 | 原因与前置 |
| --- | --- | --- |
| B1 | 标签原文用量仍**不可渲染** | 本片实测 `packages/knowledge/herbicides/records-2026.json`：`"usable_as_dose": false` **20** 处、`true` **0** 处；`dose_text` **0** 命中、`dose_status` **0** 命中、`dose_cards` **0** 命中（文件 2177 行）。缺口台账逐字：「真实用量正例 N=0」——A 20 条正例 0、B 96 条正例 0、合计 0（[剂量缺口台账](gy-i08-dose-gap-ledger-20261017.md) §1 表与 `:13-15`）。前置：取得真实标签原文剂量＋核准标签（同页 §3 第 1–3 项，逐条「不可由本仓推断补足」） |
| B2 | 剂型字段的覆盖**不对称** | 本片实测：`records-2026.json` 20 条全有 `dosage_form`（20 处）与 `ingredients_text`（20 处）；随包浙江资料 `packages/knowledge/zhejiang/materials-zhejiang-v1.json` 的 `dosage_form` **0 命中** ⇒ 离线路径上剂型筛选只会得到「记录未采集制剂（剂型）」的真实不匹配（`reference.js:253-255`）。不是缺陷，但「过滤在真实资料上的可用面」只有 20 条目录 |
| B3 | 100 组场景的「真实资料」成分 | `tests/reference/i08-scenarios-100.test.mjs:15-16` 自陈「本文**不含**任何依赖真实用量正例的断言：首批真实资料没有用量列；凡是需要真实用量正例的场景一律标为**缺项/未取得**」⇒ 场景通过≠真实资料上有用量正例 |
| B4 | 实际消费者／真机用量卡证据 | 剂量台账 §3 第 5 项（真机展示与朗读未实测）、第 6 项（PG 侧复算 `usable dose cards=0` 未做） |
| B5 | issue 前置 | #7 仍 OPEN（gh 只读）；#8 正文逐字「缺前置／真实调用证据不关闭整项」 |

### 4.4 C5 判据

**C5 不适用**：本域无用户私有行（注销闭集四域不含 reference／knowledge 的资料表）。

若监工要一条隐私/安全面判据，建议替代口径 **C5′：「原文用量在不可用时如实报缺项，绝不补造；用量卡非空即拒收」**：

| 子项 | #8 现状 | 证据 |
| --- | --- | --- |
| (a) 数据侧无剂量即无正例 | 满足（缺项如实） | `records-2026.json`：`usable_as_dose:false` 20／`true` 0、`dose_text` 0 命中 |
| (b) 守卫在空集上不假装通过 | 满足 | [剂量缺口台账](gy-i08-dose-gap-ledger-20261017.md) §5 逐字「N=0 是「缺项」，不是「通过」…属**空真**」；`tests/reference/i08-dose-empty-vacuous-guard.test.mjs` |
| (c) 消费端拒收非空剂量卡 | 满足 | `miniprogram/utils/knowledge-api.js:56`、`:140`（`UNSUPPORTED_DOSE_RESPONSE`） |

### 4.5 若要关闭，还差哪几项

1. B5：前置 #7 收口（或监工明示不阻塞）。
2. B1：真实标签原文剂量与核准标签（本仓不能推断补足）。
3. B4：真机用量卡展示/朗读与 PG 侧复算读数。
4. B2：随包浙江资料补剂型字段，或明示「离线路径不做剂型筛选」的口径。

---

## 5 汇总（本片计数，逐条对应上面各节）

| issue | 验收条数 | 已取得 | 未取得 | C5 是否满足 | 唯一「代码侧已落地但证据侧仍缺」的那一项 |
| --- | --- | --- | --- | --- | --- |
| #16 | 4 | 9 | 6 | 实现＋真库 4/5（缺 real 可达） | 真机页面证据（B1） |
| #17 | 4 | 10 | 6 | 3 满足＋1 部分＋1 未满足 | 真 PG 服务器上的注销行数（B3） |
| #7 | 3 | 7 | 5 | 不适用（替代口径 3/3 满足） | 排序台账收口（B1） |
| #8 | 4 | 7 | 5 | 不适用（替代口径 3/3 满足） | 真实标签原文剂量（B1） |

四张 issue 的**共同**未取得（一处写清，避免各节重复）：

| 共同项 | 读数 | 影响 |
| --- | --- | --- |
| 真机／开发者工具 | `platform-checklist.md:40`／`:48`／`:49` 全「未验证」；B6 页 §7 的 `cli.bat` `EPERM` | 四张都缺「页面级」证据 |
| `real` 模式注销 503 | `app.ts:1731` | #16／#17 的 C5 到不了端到端 |
| issue 前置 | #4 OPEN；#9／#10／#14／#15／#28／#29 OPEN；#3 CLOSED | 四张的 issue 正文都写了「缺前置不关闭整项」 |

**本片对「哪一张的材料最齐」的判断（这是判断，不是结论，关闭权仍在监工）**：**#7 最齐**。理由是它的三条验收在代码与测试两层都有锚点（§3.2 A1–A7），唯一像「缺陷」的排序问题在代码侧已于 PR `b56ba9d` 对齐冻结契约（`service.ts:76`），剩下的只是台账仍记 `partial`（`contract-status.json:716`）——属口径/文档收口，不是行为缺口。还差的两项是：

1. **B1 排序台账收口**：监工确认 `partial` 可撤 + 台账更新（本片红线不改 `contract-status.json`）。
2. **B2 真实来源与消费者读数**：`source.updated_at` 日期→`date-time` 投影实测，加真机/开发者工具页面读数。

次接近的是 **#16**：它的 C5 是四张里唯一「实现＋真库行为」都拿到的（§1.4 (d) 有真 PG 17 读数），差的几乎是同一对东西（真机 + real 可达）。

---

## 6 自检真实输出（本机实跑，原样摘录）

```text
$ python tools/validate_development_docs.py
PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables
→ exit 0

$ node tools/run-python.mjs tools/validate_development_docs.py
PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables
→ exit 0

$ node tools/verify-research-records.mjs
研究记录校验：5 通过 / 0 失败 / 4 legacy 已钉住
PASS docs/research 结构校验：命名＋记录级四项＋按项来源＋技术七项＋legacy 钉住
→ exit 0

$ npm run test:docs
PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables
PASS 2026-10-18-contract-evidence-gate.md
PASS 2026-10-18-evaluation-readout-structured.md
PASS 2026-10-18-feature-flags-persistence.md
PASS 2026-10-18-research-records-gate.md
PASS 2026-10-18-stack-reuse-decision.md
（另 4 条 legacy 记录 PASS，行略）
研究记录校验：5 通过 / 0 失败 / 4 legacy 已钉住
PASS docs/research 结构校验：命名＋记录级四项＋按项来源＋技术七项＋legacy 钉住
→ exit 0

$ git diff --check
→ exit 0（工作区与本页内容均无空白错误）
```

- `npm run test:docs` 的组成逐字取自 `package.json` 的 scripts：`node tools/run-python.mjs tools/validate_development_docs.py && node tools/verify-research-records.mjs`；两条均 exit 0，且**不依赖 `node_modules`**（本片未装，红线：本片不需要）。
- `npm run test:mini`／`npm run test:unit`／`npm run lint` 本片**未跑**：前者需要 `node_modules` 与微信工具链，后两者与纯文档改动无关（且无 `node_modules`）。
- 本页自身提交的 HEAD SHA 记在交接件里，不在文件内写死（写死会自我指涉、必然过期）。

## 7 本片没做（不得据本页推断）

1. **没关任何 issue、没评论 GitHub、没 push、没开 PR**。
2. **没重跑任何 `node --test`**（无 `node_modules`）：§1.2／§2.2／§3.2／§4.2 里的测试锚点是「文件存在＋页内读数」，本片只实读文件与行号，未复现绿读数。
3. **没跑真 PG、没跑真机、没跑微信开发者工具**：真库读数一律注明「出自哪一页」。
4. **没改 `packages/contracts/**`、`docs/architecture/contract-status.json`、`.github/**`**；§3.3 B1、§2.3 B5 的台账不同步只登记，不修。
5. **没把任何「未取得」升级成「缺项即通过」**：B4 页与剂量台账都用「缺项≠通过」口径，本页沿用。
