# GY-R33 契约台账订正与 #7 真库排序读数（2026-10-23）

> 基线：`upstream/main` = `7dd3d699d71ce5ce69b5254ea8a3e54aed4f7f79`（本片 `git fetch` 后 `git rev-parse` 实测）。
> 分支：`fix/gy-r33-contract-ledger`；工作树：`E:\GengYunCommander\wt-r33-ledger`。
> Refs #7、#16、#17。本页只提供证据与订正记录：**不改任何 `status`**、不产生关闭结论、不代替监工验收。

> **R34 补注（2026-10-23）**：本页对 `services/api/src/app.ts` 的行号读数测量于 `7dd3d699`（本页自述基线）；`#503`／`#505`／`#510`／`#511` 合入后该文件已多次变动，那些行号不再指向原处（例如社区 store 选择块原记 `:831-838`、社区 real 放行判据原记 `:1133`）。现按符号定位：`communityRealUnwired` 在 `buildApp` 内（`git grep -n 'communityRealUnwired' -- services/api/src/app.ts`），社区 store 选择块按 `const communityStore` 检索（`git grep -n 'const communityStore' -- services/api/src/app.ts`）。原读数保留为历史；本补注只订正定位方式，不重新验收各行结论（个别引用处的代码形态亦可能已变）。

## 0 摘要

1. 只改 `docs/architecture/contract-status.json` 的 **blocker 文本**，共 **22 条**：`listKnowledge`、`dimensions.pagination`、`getMedia`、社区 16 条（`listPosts` … `getOwnReport`）、`#17` 三条（`listMessages` / `getUnreadCount` / `markMessageRead`）。脚本比对 HEAD：`changed blockers=22 / other changes=0`（§5.1）。
2. **保留 5 条**（#16）：`listFavorites` / `createFavorite` / `deleteFavorite` / `listHistory` / `deleteHistory` —— 逐条实测与现行代码核对；其中 `deleteHistory` 一行的 R33 时点读数「级联删除仍未接线」**已被 `#503` 推翻**，2026-10-24 按符号重取后订正为现行装配（其余 4 条 0 改动）；另「real 历史仍 unwired」的说法对 `#484` 之前成立、对现行 main 已过时，但**台账现文已经写明 wired**，故不改（§2.5）。
3. `#7` 真库读数已取得：临时 PostgreSQL **17.11**（仅 `127.0.0.1:55437`）上，**毫秒对齐夹具**的 SQL 直查 = HTTP 分页 = 服务层归并三面**逐 id 一致**；同 `created_at` 不同 `id` 按 `id DESC`；跨页游标逐页切片；`created_at` 为 NULL/不可解析的行确定性排最后（§3，exit 0）。**另：亚毫秒（PG 微秒）tie-break 存在跨路径差异（新发现，未修）**——JS 侧用 `Date`（毫秒）比较、PG 按微秒排序，同毫秒内 SQL 与 HTTP/服务层顺序可不同（§3.6）。
4. 生成的 `docs/architecture/contract-implementation-status.md` 由 `node tools/verify-contract-status.mjs --write-doc` 重写；**生成区之外**的人工摘要另做 3 处一致性订正（§6）。

## 1 纪律与改动面自证

| 纪律 | 实测 |
| --- | --- |
| 不改 `status` | 22 条 blocker 的 `status` 行均未动；比对脚本 `other changes=0`（§5.1） |
| 不动 `baseline` | 顶层字段比对 `other changes=0`；`baseline` 仍为 `72c4923a8ec058399a51609e1cf1e3c70a890b4a` |
| 不手改生成区 | 生成区标记 `docs/architecture/contract-implementation-status.md:31`（start）与 `:178`（end）；区域**全部**由 `--write-doc` 重写，未手改 |
| 不塞 `tools/doc-anchors-baseline.json` | 该文件 `git status` 未变；`--strict` 读数「基线外新增 0 条、陈旧 0 条」（§5） |
| 不删断言 | `tests/unit/knowledge-ledger-sort-drift.test.mjs` 的 4 条断言逐字未改逻辑，仅更新头部说明；复跑 4/4 通过（§5） |
| 不读私密区 | 未访问 `E:\GengYunPrivate\` |

## 2 逐条自证（A）

### 2.1 `#7` · `listKnowledge`（`operations`）

**台账原文（HEAD 的 `docs/architecture/contract-status.json:781`；合流按内容重锚，取证时原记 `:716`，下列引文为订正前文本，现文见该行）**

```
需DATABASE_URL与catalog_read.current_knowledge；签名/绑定/15分钟非滑动分页及失效后重新查询已合（#115）；当前id_asc排序仍不同于冻结(created_at DESC,id DESC)，实际表/投影无created_at，排序及历史数据方案未完成，按partial保留
```

**实测事实（逐条反驳）**

| 旧说法 | 实测 | 证据 |
| --- | --- | --- |
| 「当前 id_asc 排序」 | 服务端读语句是 `ORDER BY created_at DESC, id DESC`；JS 归并比较器同序（先时间点，再 `id` 逐码元降序；**但 JS 时间点只有毫秒精度，亚毫秒 tie-break 见 §3.6**） | `services/api/src/knowledge/service.ts:33-38`、`:76` |
| 「实际表/投影无 created_at」 | `knowledge_versions.created_at` 已落库、`NOT NULL`、有默认；`catalog_read.current_knowledge` 已投影该列 | `services/api/db/migrations/0012_knowledge_created_at.sql:39`、`:64`、`:68`、`:87`、`:97` |
| 「排序及历史数据方案未完成」 | 迁移用**冻结批次日期常量** `2026-10-14T00:00:00Z` 确定性回填存量（不含 `now()`/运行期时钟），并建 `(created_at DESC, knowledge_id DESC)` 索引 | `services/api/db/migrations/0012_knowledge_created_at.sql:59-61`、`:73-74` |
| 冻结口径本身 | 「排序 `(created_at DESC,id DESC)`」 | `docs/architecture/state-contract.md:32` |

**处置：订正（部分过时）。** 旧三句（`id_asc` / 无 `created_at` / 历史方案未完成）已被 #209 与迁移 `0012` 推翻；`status` 仍 `partial`，理由改为：真实生产 `DATABASE_URL` 与已审来源数据未取得（本片 §3 为隔离合成夹具），#7 的 `/herbicides` 读面排序口径另待裁定。**未改 `status`**。真库读数只在**毫秒对齐夹具**上三面一致；亚毫秒 tie-break 的跨路径差异见 §3.6（未修）。

**改前 → 改后（差异片段）**

```
- 当前id_asc排序仍不同于冻结(created_at DESC,id DESC)，实际表/投影无created_at，排序及历史数据方案未完成，按partial保留
+ **排序已对齐冻结口径（毫秒对齐夹具；亚毫秒 tie-break 见本条后半）**：…（比较器与 SQL 同序；0012 补列/回填/NOT NULL/默认/投影）
+ ⇒ 台账旧文「当前 id_asc 排序」「实际表/投影无 created_at」「排序及历史数据方案未完成」三句已被 #209 / 迁移 0012 推翻（`id_asc` 仅作历史对照，不是现状）。
+ 真库读数（临时 PG 17.11，毫秒对齐夹具）：SQL 直查 = HTTP 分页 = 服务层归并三面一致…（见本页 §3；亚毫秒 tie-break 差异见 §3.6，未修）
+ 仍按 `partial` 保留：真实生产 `DATABASE_URL` 与已审来源数据未取得…#7 的 `/herbicides` 读面排序口径另待裁定；`status` 改判属监工权限。
```

> 为什么订正后的 blocker 仍保留 `id_asc` 字样：`tests/unit/knowledge-ledger-sort-drift.test.mjs` 的 ② 断言要求登记条目的 blocker 仍含该字面量、④ 钉住登记数为 2；本片**不删断言**，故以「历史对照，不是现状」明写，并同步登记表（§6.3）。

### 2.2 `#7` · `dimensions.pagination`

**台账原文（`docs/architecture/contract-status.json:3314` 的 `blocker`；本片取证时原文如下，其后已被订正——同一登记条目的现行文本与下列引文不同）**

```
授权列表（#109）、科普（#115）及作物/地区目录（#119）已签名、绑定主体版本和水位、固定15分钟期限；目录按稳定键排序。知识id_asc仍偏离冻结(created_at DESC,id DESC)，缺历史创建时点字段；后台/社区/消息分页须按模块验收，不记整维度完成
```

**实测事实**：与 §2.1 同源、同一句化石。`created_at` 已由 `0012` 落到 `knowledge_versions` 并投影进读视图（`services/api/db/migrations/0012_knowledge_created_at.sql:39`、`:87`、`:97`）；真库读数见 §3（毫秒对齐夹具上三面一致；亚毫秒 tie-break 差异见 §3.6，未修）。后半句「后台/社区/消息分页须按模块验收」**仍属实**，原样保留。

**处置：订正（部分过时）**：SQL 侧为冻结口径；JS 归并在亚毫秒 tie-break 上与 SQL 存在跨路径差异（未修，§3.6）；`status` 仍 `partial`。

### 2.3 `getMedia`（媒体域）

**台账原文（HEAD 的 `docs/architecture/contract-status.json:575`）**

```
仅 owner 可读私有元数据，非本人与不存在**逐字节同形** 404；内存记录 store（本片无持久化实现）；冻结契约（85 条路径 / 112 条 operation）内没有满足「owner 私有媒体字节读取」语义的那一条 operation（复现：GET /api/v1/media/{id}/content ⇒ 404「未实现的路径」）；owner 短效句柄 URL 由部署期访问网关承担，未接线未验收
```

**实测事实**

| 旧说法 | 实测 | 证据 |
| --- | --- | --- |
| 「内存记录 store（本片无持久化实现）」 | PG 实现已存在且自述 `persistent: true`；装配点按 `real` + 连接池 + `MEDIA_OBJECT_REF_KEY` 三者齐备选 PG store，其余模式用内存 store | `services/api/src/media/store-pg.ts:153`、`:240`、`:304`；`services/api/src/app.ts:1413-1416`；内存实现 `persistent:false` 见 `services/api/src/media/store.ts:257` |
| 「85 条路径 / 112 条 operation」 | 实测 `paths=86 / operations=113`（`node -e` 读 `packages/contracts/openapi.json`） | `packages/contracts/openapi.json` |
| 「没有 owner 私有媒体字节读取那条 operation」 | 仍成立：媒体域路由只有 `/media/:id`（元数据）与社区取图 `/community/media/:grant_id/content` | `services/api/src/routes/media.ts:260-261`、`:337-338` |
| 「`GET /media/{id}/content` ⇒ 404」 | 仍成立：未注册路径统一 `NOT_FOUND`「未实现的路径」 | `services/api/src/app.ts:2168` |
| 「owner 短效句柄 URL 由部署期访问网关承担，未接线未验收」 | 仍成立（本片未取得网关/真实取图证据） | 保留原句 |

**处置：订正（部分过时）**：只改「内存记录 store」与两处计数；owner 同形 404、契约缺 operation、句柄网关未接线等**仍属实，原样保留**。

### 2.4 社区 16 条

条目（`operations`，blocker 行号以 HEAD/现文一致）：`listPosts` `:1368`、`createPost` `:1399`、`getPost` `:1426`、`editPost` `:1453`、`deletePost` `:1480`、`listComments` `:1507`、`createComment` `:1534`、`getComment` `:1561`、`editComment` `:1588`、`deleteComment` `:1615`、`likePosts` `:1642`、`unlikePosts` `:1669`、`likeComments` `:1696`、`unlikeComments` `:1723`、`createReport` `:1750`、`getOwnReport` `:1777`。

**台账原文（16 条共有的首段）**

```
HTTP 路由已装配（services/api/src/routes/community.ts；真实回环回归 tests/unit/community-http.test.mjs），含契约头部（Idempotency-Key/If-Match）、强 ETag、no-store 与先审后发隔离；**未取得**：真实持久存储未交付（real 模式整域 503 PROVIDER_UNAVAILABLE）；模型层（LLM）图文审核未接入本装配（带媒体目标因规则层媒体口径不可能 approved）；资料关联真实读取口未接线（默认 fail-closed）；正式微信身份/真机与发布环境未取得；相关测试不等于页面或真实审核验收（GY-I15）
```

**实测事实**

| 旧说法 | 实测 | 证据 |
| --- | --- | --- |
| 「真实持久存储未交付」 | 迁移 `0022` 建 `community_posts` / `community_comments` / `community_likes` / `community_reports` / `community_moderation_decisions` / `community_idempotency` 等表；`store-pg.ts` 自述 `persistent: true` | `services/api/db/migrations/0022_community_persistence.sql:62-188`；`services/api/src/community/store-pg.ts:537` |
| 「real 模式整域 503」 | 放行判据是 **store 是否持久**，不是「有没有接线」：`config.executionMode === 'real' && !communityStore.persistent`；有连接池 ⇒ PG store ⇒ real 放行；仅 real 且无持久化落点（无池/注入内存 store）才整域 503 | `services/api/src/app.ts:900-903`、`:1283` |
| 「筛选是否下推」 | `listPosts` 的 `visibility/author/crop_id/region_code/keyset/LIMIT` 全部写进 SQL，排序 `ORDER BY created_at DESC, id DESC` | `services/api/src/community/store-pg.ts:583-627` |
| 保留项：模型层图文审核未接入 | 仍成立：应用装配不注入真实 tms/ims 端口，`real` 下无端口即 503 | `services/api/src/moderation/provider.ts`（`resolveModerationPorts`） |
| 保留项：资料关联默认 fail-closed | 仍成立：默认 `createUnwiredKnowledgeAvailabilityPort` | `services/api/src/community/knowledge.ts:72`；装配见 `services/api/src/app.ts:1258` |
| 保留项：`createPost/editPost` 图片审核细节 | 仍成立：`IMAGE_MODERATION_UNAVAILABLE`、`MEDIA_NOT_EVALUATED_BY_RULE_LAYER`、媒体元数据只传 `media_id`（→ `MODEL_PAYLOAD_INVALID`） | `services/api/src/community/service.ts:426`、`:429`、`:573`、`:200-201`；`packages/moderation/merge.mjs:539` |
| 保留项：正式微信身份/真机/发布环境；测试≠验收 | 仍成立 | 保留原句 |

> **后续变更（R33-I15-S4 片，2026-10-23）**：上表「保留项：资料关联默认 fail-closed」一行**已不再成立** —— 装配层现在**有连接池**时用同一条 `pool` 查公开读视图 `catalog_read.current_knowledge` 构造真实 `createKnowledgeAvailabilityPort`（`services/api/src/app.ts:1280`），**仅无池**时才保持未接线 fail-closed；错误码（409 `OBJECT_UNAVAILABLE`）与「不泄露存在性」语义一字未改，装配级回归见 `tests/unit/community-knowledge-wiring.test.mjs`。`docs/architecture/contract-status.json` 里 16 条社区 blocker 的同款子句已同步订正（`status` / `baseline` 未动）。上表其余行保持 R33 台账片的当时读数。

**处置：16 条全部订正（部分过时）**：只替换「真实持久存储未交付（real 模式整域 503）」这一子句为「持久化已交付 + 放行判据」；其余未取得项原样保留。`status` 未动。

**改前 → 改后（共有片段）**

```
- ；**未取得**：真实持久存储未交付（real 模式整域 503 PROVIDER_UNAVAILABLE）；
+ ；**存储持久化已交付（订正原「真实持久存储未交付／real 整域 503」）**：迁移 0022 + store-pg.ts（persistent: true；筛选/keyset 下推 SQL）…仅 real 且无持久化落点时才整域 503；**未取得**：
```

### 2.5 `#16` 五条 —— 实测核对（`deleteHistory` 一行按现行装配订正，其余 4 条原样保留、0 改动）

| 条目 | 台账现文要点 | 实测 | 结论 |
| --- | --- | --- | --- |
| `listFavorites` / `createFavorite` / `deleteFavorite` | 迁移 0018 + PG store；仅 `real && !persistent` 才 503 | `services/api/src/app.ts:1482-1486`（favorites store）、`:1571-1579`（服务门禁）；`services/api/src/favorites/store-pg.ts:187` | 保留 |
| `listHistory` | 识别/OCR 终态写入「已随 R31-I16 接线（real 也写）」 | `services/api/src/app.ts:1010-1028`：判据 `historyDomainEnabled = config.executionMode !== 'real' \|\| historyStore.persistent`；`real` + 持久 store ⇒ `wired`；`#484`（`c728648a`）即此修正 | 保留 |
| `deleteHistory` | 级联删除**已部分接线**：识别与 OCR 两类关联对象已接上（披露 `partial`），媒体对象删除与共享引用核对仍属 `#6`／`#19`、外发撤销仍未接 ⇒ 台账 `status` 仍 `partial` | `services/api/src/app.ts:1689` 现为 `historyInjection?.cascade ?? createHistoryCascadePort({ recognitionService: () => app.recognitionService, ocrService: () => app.ocrService })`；`createHistoryCascadePort` 在 `services/api/src/history/cascade-wiring.ts:176` 内包装 `createWiredHistoryCascadePort`（`services/api/src/history/cascade.ts:98`）。**原来的 `createUnwiredHistoryCascadePort()` 在 `services/api/src/app.ts` 已 0 命中**（该符号只剩 `services/api/src/history/cascade.ts:69` 的定义与测试夹具使用） | 保留（`status` 仍 `partial`，缺口缩到媒体/外发两条腿） |

> **R34 订正（2026-10-23；2026-10-24 追认行号与结论）**：上表 `deleteHistory` 行**在 R33 时点**的原文是「级联删除仍未接线，`historyCascadePort` 仍是 `createUnwiredHistoryCascadePort()`」，右栏「逐字仍是 `historyInjection?.cascade ?? createUnwiredHistoryCascadePort()`」是 `7dd3d699` 时点读数；`#503`（squash `869b0358`）合入后该句**已被代码推翻**，属「读数已假」而非行号漂移。现行装配为 `historyCascadePort = historyInjection?.cascade ?? createHistoryCascadePort({ recognitionService: () => app.recognitionService, ocrService: () => app.ocrService })`（`createHistoryCascadePort` 在 `services/api/src/history/cascade-wiring.ts` 内包装 `createWiredHistoryCascadePort`），`createUnwiredHistoryCascadePort` 在 `services/api/src/app.ts` 已 **0 命中**。按符号定位：`git grep -n 'createHistoryCascadePort\|createUnwiredHistoryCascadePort' -- services/api/src/app.ts`。`#503` 已把 `partial` 语义写清——识别与 OCR **两类**关联删除已接上，**媒体对象删除与共享引用核对仍属 `#6`／`#19`、外发撤销仍未接**，故 `status` 仍是 `partial`；出处见 `docs/architecture/contract-status.json` 的 `deleteHistory` 条目 blocker 与 `docs/architecture/contract-implementation-status.md` 同文，回归见 `tests/unit/history-cascade-wiring.test.mjs`、`tests/integration/favorites-history-pg.mjs`（第 15 组）。本注只订正事实，**不重新验收 `#16` 的任何 AC、不改任何 `status`**；R33 时点的原句与原读数保留在本注引用与 `7dd3d699` 提交里，上表行已按现行装配与按符号重取的行号（`services/api/src/app.ts:1689`）订正。

补充实测：迁移 `0018` 建 `favorites` / `history` / `favorites_idempotency` / `history_idempotency` 四表（`services/api/db/migrations/0018_favorites_history.sql:46`、`:71`、`:103`、`:118`）；CI job `real-pg-17.11` 的步骤真跑 `tests/integration/favorites-history-pg.mjs`（`.github/workflows/real-pg-integration.yml:48`、`:156`）。

> 关于「real 历史仍 unwired」：该说法在 `#484` 之前正确，对现行 main 已过时；但 `listHistory` 的 blocker **已经**写成 wired（并给出 `real+持久` 与 `real+内存` 两臂证据），所以本片**不改**它 —— 这正是「仍然正确的话不要为了看起来新而改写」的适用情形。`deleteHistory` 的级联缺口仍属另一条 operation，保留。

### 2.6 `#17` 三条（本轮追加范围）

条目：`listMessages` `:1942`、`getUnreadCount` `:1964`、`markMessageRead` `:1986`（三条 blocker 同文）。

**台账原文（三条共有）**

```
消息列表/未读数/读标记HTTP已装配；stub/preset_demo使用空内存，`real` 且无连接池 ⇒ 整域 503，`real` + 池 ⇒ 迁移 `services/api/db/migrations/0019_messages_persistence.sql` 与 `services/api/src/messages/store-pg.ts`（装配 `services/api/src/app.ts:802-806`）。列表游标绑定主体/账号版本/消息水位，整链固定15min；新增消息使旧链400，读状态不改水位，每页重查引用。真实事件/目标端口、PG/注销及页面/Android仍待验收，不虚构真人消息
```

**逐项实测（六项）**

| 台账词 | 实测 | 证据 |
| --- | --- | --- |
| 真实事件 | **已落地**：`#422`（merge `50e3bf40`，`git cat-file -t` ⇒ commit）把他人评论/点赞真落库到消息域；事件类型按来源取 `comment`/`like`/`moderation` | `services/api/src/community/service.ts:1379`、`:1852`；装配 `services/api/src/app.ts:1126-1130`；账号停用/恢复事件 `:1270-1273` |
| 目标端口 | **已落地（限 `post`/`comment`）**：`#425`（merge `88942df4`）接线 `createCommunityReferencePort`；`TargetRef.type` 共 16 型，`post`/`comment` 之外的 14 型按 `unavailable` 降级 | `services/api/src/messages/reference-community.ts:49-59`；装配 `services/api/src/app.ts:810-811`；契约枚举 `packages/contracts/openapi.json#/components/schemas/TargetRef` |
| PG | **已落地**：迁移 `0019` + `store-pg.ts`（`persistent: true`）+ `real` 无池整域 503 | `services/api/db/migrations/0019_messages_persistence.sql`；`services/api/src/messages/store-pg.ts:244`；`services/api/src/app.ts:802-806` |
| 注销 | **已落地并取得真库读数**：`#452`（`174b547c`）扩写 `tests/integration/messages-pg.mjs` 的注销臂；真库证据串 `messages:online-purged:9;messages:idempotency-purged:3`，在 CI `real-pg` job 真跑 | 注销装配 `services/api/src/app.ts:1668-1704`；`tests/integration/messages-pg.mjs:500-543`（断言串 `:525`）；CI `.github/workflows/real-pg-integration.yml:144-147` |
| 页面 | **已落地**（实现与页面门禁）：五态/未读/标读/全部已读/角标；`#448`（`ac848d9d`）补跳转入口与未读数重试 | `miniprogram/pages/messages/messages.js`；`tests/unit/miniprogram-ui-auth-integration.test.mjs`；`tests/unit/messages-chain-client.test.mjs` |
| Android/真机 | **仍属实**：真机行状态逐字「未验证」 | `docs/verification/platform-checklist.md:40`（真机设备）、`:48`（Android 真机联网）、`:49`（iOS 真机联网） |

> 旁证：`docs/verification/gy-r31-i17-recon-20261022.md:186-191` 已把「真实事件/目标端口」判为过时、「Android/真机」判为未过时；本片不照抄其行号，逐条按现行文件与 PR/commit 复核。
>
> N2（合流后行号）：`b1e8fb3e`（`#492`）在 `services/api/src/community/service.ts` 的 `:1546` 前插入 3 行；`like_created` 由片前基线 `7dd3d699` 的 `:1805` 漂到 **`:1808`**（`comment_created` `:1364` 未漂）。本页其余行号仍按片前基线 `7dd3d699` 实测；台账消息 blocker 已按合流后的 `:1808` 写。

**处置：三条订正（部分过时）**：删去「真实事件/目标端口、PG/注销」与「页面」中已落地的子句，保留「Android/iOS 真机 + 真机页面证据」与「不虚构真人消息」；`status` 未动。

### 2.7 关键装配原文（逐字，供复核）

`services/api/src/app.ts:1413-1416`（`getMedia` 的 store 选择）：

```ts
const mediaStore: MediaStore = mediaStoreOption
  ?? (config.executionMode === 'real' && pool !== null && mediaObjectRefKeyMaterial !== null
    ? createPostgresMediaStore({ pool, cipher: createObjectRefCipher(mediaObjectRefKeyMaterial) })
    : createMemoryMediaStore({ now: () => clock().getTime() }));
```

`services/api/src/app.ts:831-838`（社区 store）：

```ts
const communityStore: CommunityStore =
  communityInjection?.store ??
  (pool !== null
    ? createPostgresCommunityStore({ pool })
    : createMemoryCommunityStore({ now: () => clock().getTime() }));
```

`services/api/src/app.ts:1283`（社区 real 放行判据）：

```ts
const communityRealUnwired = config.executionMode === 'real' && !communityStore.persistent;
```

`services/api/src/app.ts:802-807`（消息 store；blocker 记 `:802-806` 为同一表达式）：

```ts
const messagesStore: MessagesStore =
  config.executionMode === 'real'
    ? (pool === null
        ? createMemoryMessagesStore({ now: () => clock().getTime() })
        : createPostgresMessagesStore({ pool }))
    : (messagesInjection?.store ?? createMemoryMessagesStore({ now: () => clock().getTime() }));
```

`services/api/src/app.ts:1126-1130`（社区事件 → 消息域）：

```ts
const communityEvents: CommunityEventsPort =
  communityInjection?.events ??
  (messagesService === null
    ? createUnwiredCommunityEventsPort('消息服务未接线（real 模式）：审核结果/下架事件无法投递')
    : createMessagesCommunityEventsPort({ messages: messagesService }));
```

`services/api/src/app.ts:1010-1019`（#16 real 终态历史判据）：

```ts
const historyDomainEnabled = config.executionMode !== 'real' || historyStore.persistent;
const recognitionTerminalHistory: RecognitionTerminalHistoryPort = historyDomainEnabled
  ? {
      kind: 'wired',
      note: '识别终态已接线到历史域内部创建口（appendHistory；确定性 event_key、同任务重复投递为 no-op）',
      recordTerminal: (input: RecognitionTerminalHistoryInput) => recordHistoryTerminal(input),
    }
  : createUnwiredRecognitionTerminalHistoryPort(
      'real 模式且历史域无持久化落点（无 DATABASE_URL / 注入的内存 store）：终态不写历史，不放宽守卫',
    );
```

`services/api/src/app.ts:1689`（`deleteHistory` 级联端口；R33 时点的 `:1565` 那行是 `?? createUnwiredHistoryCascadePort()`，该符号在 `app.ts` 已 0 命中）：

```ts
const historyCascadePort: HistoryCascadePort = historyInjection?.cascade ?? createHistoryCascadePort({ recognitionService: () => app.recognitionService, ocrService: () => app.ocrService });
```

`services/api/src/app.ts:1668-1670`（消息注销清理绑定）：

```ts
const messagesPurgeDelete = messagesStore.deleteAllByOwner?.bind(messagesStore);
const messagesPurgeCounts = messagesStore.purgeOwnerData?.bind(messagesStore);
const messagesPurgeSnapshot = messagesStore.snapshotOwner?.bind(messagesStore);
```

`services/api/src/routes/media.ts:260-262`（`getMedia` 路由；无 `/media/{id}/content`）：

```ts
app.get(
  `${API_PREFIX}/media/:id`,
  { preHandler: guards.requireUser, schema: { params: ID_PARAMS, querystring: NO_QUERY } },
```

## 3 `#7` 真库排序读数（B）

### 3.1 环境与迁移装配

| 项 | 读数 |
| --- | --- |
| PostgreSQL | `17.11`（`E:\GengYunCommander\.pg17\pgsql\bin`；`initdb` → `pg_ctl -w start`，仅 `127.0.0.1:55437`；**未触碰 5432**） |
| 空库 | `CREATE DATABASE gy_r33_ledger`；迁移前 `public` 表数 **0**（脚本断言） |
| 迁移 | 按仓库惯例用 `services/api/src/db/migrate.ts` 的 `applyMigrations(ownerClient)` 跑到最新：`0001`…`0031`（`latest = 0031 online_purge_evidence`） |
| 角色 | 跑 `services/api/db/roles/auth_privacy.sql` 与 `knowledge_runtime.sql`，另建受限 LOGIN `gy_r33_runtime` 并只授予这两个组；实测 `rolsuper/rolcreatedb/rolcreaterole/rolreplication/rolbypassrls` 全 `false` |
| 应用装配 | `buildApp({config: loadConfig({APP_EXECUTION_MODE:'stub', LOG_LEVEL:'silent'}), pool: apiPool})`，`app.listen({host:'127.0.0.1', port:0})`；HTTP 登录走 `POST /api/v1/auth/wechat`（stub 合成身份），再带 Bearer 调 `/knowledge` |

复现命令（本片实跑；脚本为一次性取证脚本，未入仓）：

```powershell
E:\GengYunCommander\.pg17\pgsql\bin\initdb.exe -D <tmp>\pg\data -U gy_owner -A trust --encoding=UTF8 --locale=C
# postgresql.conf: listen_addresses='127.0.0.1'; port=55437
E:\GengYunCommander\.pg17\pgsql\bin\pg_ctl.exe -D <tmp>\pg\data -l <tmp>\pg\postgres.log -w start
E:\GengYunCommander\.pg17\pgsql\bin\psql.exe -h 127.0.0.1 -p 55437 -U gy_owner -d postgres -c "CREATE DATABASE gy_r33_ledger"
node knowledge-sort-readout.mjs <worktree> gy_r33_ledger 55437
# ⇒ PASS real PG readout: SQL = HTTP = service order; boundary merge + cross-page cursor exact
# ⇒ exit 0
```

### 3.2 数据（真实读到视图里的行）

5 行全部经 `sources` / `source_versions` / `knowledge_versions` 的真实外键与 `catalog_read.current_knowledge` 准入条件进入读视图（合成夹具，非生产核准资料）：

| 标记 | id | `created_at` |
| --- | --- | --- |
| C（最新） | `c0000000-0000-4000-8000-00000000000c` | `2026-10-22T00:00:00Z` |
| B（同刻，id 最高） | `bbbbbbbb-0000-4000-8000-00000000000b` | `2026-10-20T12:00:00Z` |
| A（同刻，id 中） | `aaaaaaaa-0000-4000-8000-00000000000a` | `2026-10-20T12:00:00Z` |
| E（同刻，id 最低） | `5e5e5e5e-0000-4000-8000-000000000005` | `2026-10-20T12:00:00Z` |
| D（最旧） | `dddddddd-0000-4000-8000-00000000000d` | `2026-10-19T00:00:00Z` |

### 3.3 三面对照（毫秒对齐夹具）

**SQL 直查**（`psql` 等价语句 + 服务实际语句）：

```sql
SELECT id, created_at FROM catalog_read.current_knowledge ORDER BY created_at DESC, id DESC;
```

| # | id | created_at |
| --- | --- | --- |
| 1 | `c0000000-0000-4000-8000-00000000000c` | `2026-10-22T00:00:00.000Z` |
| 2 | `bbbbbbbb-0000-4000-8000-00000000000b` | `2026-10-20T12:00:00.000Z` |
| 3 | `aaaaaaaa-0000-4000-8000-00000000000a` | `2026-10-20T12:00:00.000Z` |
| 4 | `5e5e5e5e-0000-4000-8000-000000000005` | `2026-10-20T12:00:00.000Z` |
| 5 | `dddddddd-0000-4000-8000-00000000000d` | `2026-10-19T00:00:00.000Z` |

**HTTP 分页**（`GET /api/v1/knowledge?limit=2` + `next_cursor` 续读；每页 `200`、`Cache-Control: no-store`）：

| 页 | ids | `next_cursor` |
| --- | --- | --- |
| 1 | `c0000000…000c`, `bbbbbbbb…000b` | 非 null |
| 2 | `aaaaaaaa…000a`, `5e5e5e5e…0005` | 非 null |
| 3 | `dddddddd…000d` | `null` |

**服务层**（同一 `createKnowledgeService` 构造方式；`limit=2` 续读）：

| 页 | ids | `next_cursor` |
| --- | --- | --- |
| 1 | `c0000000…000c`, `bbbbbbbb…000b` | 非 null |
| 2 | `aaaaaaaa…000a`, `5e5e5e5e…0005` | 非 null |
| 3 | `dddddddd…000d` | `null` |

**断言读数**：HTTP order == SQL order（逐 id）；service order == SQL order（逐 id）；三面均为 `[C, B, A, E, D]`。游标 payload 自述 `"sort":"created_at_desc"`，并绑定 `user` / `auth_epoch` / `filter` / `watermark` / `after` / `expires`（固定 15 分钟非滑动；`services/api/src/knowledge/pagination.ts:11`、`:56-58`）。

> 本组夹具的 `created_at` 全是整毫秒（`.000Z`），因此**不能暴露亚毫秒 tie-break**；该差异由 §3.6 的独立探针检出。

### 3.4 边界数据（同刻 / NULL / 不可解析 / 跨页）

DB 列 `created_at` 已是 `NOT NULL`（`services/api/db/migrations/0012_knowledge_created_at.sql:64`），所以 NULL/不可解析只能从**归并口**（`extraRows`，即浙江种子并入路径）进入。注入 5 行边界数据后，`limit=3` 的合并读数：

| 注入标记 | id | `created_at` 注入值 |
| --- | --- | --- |
| valid-same-instant-id-highest | `f0000000-0000-4000-8000-00000000000f` | `2026-10-20T12:00:00.000Z` |
| valid-Date-same-instant-as-C | `00000000-0000-4000-8000-000000000000` | `Date(2026-10-22T00:00:00Z)` |
| unparseable | `ffffffff-0000-4000-8000-00000000000f` | `not-a-date` |
| null | `eeeeeeee-0000-4000-8000-00000000000e` | `null` |
| undefined | `99999999-0000-4000-8000-000000000009` | （字段缺失） |

合并后的实际页（每页 3 条）：

| 页 | ids |
| --- | --- |
| 1 | `c0000000…000c`, `00000000…0000`, `f0000000…000f` |
| 2 | `bbbbbbbb…000b`, `aaaaaaaa…000a`, `5e5e5e5e…0005` |
| 3 | `dddddddd…000d`, `ffffffff…000f`, `eeeeeeee…000e` |
| 4 | `99999999…0009`（`next_cursor=null`） |

读数：`sameInstantTie=true`（同刻下 `f000…` 排在 `bbbb…` 前，id 逐码元降序）；`unparseableLast=true`（`not-a-date` / `null` / 缺失字段一律 `-Infinity`，确定性排最后，内部再按 id DESC）；`Date` 对象与 ISO 字符串按**时间点**相等比较（`0000…` 与 C 同刻，按 id DESC 紧随 C）。脚本断言 `expected == actual`，exit 0。

### 3.5 结论

- **毫秒对齐夹具上**未发现排序不一致、游标错位或种子归并次序错误；**但亚毫秒（PG 微秒）tie-break 存在 SQL 与 HTTP/服务层的跨路径差异（新发现，未修，§3.6）**。
- 台账旧文的三句排序化石仍被**静态代码 + 毫秒对齐真库读数**双重推翻（`id_asc` / 无 `created_at` / 历史方案未完成）；但「排序完全一致」的表述必须限定在**毫秒精度**——本片据此修正台账措辞（§2.1/§2.2）。
- 未取得的仍是「生产 `DATABASE_URL` + 真实已审资料」与 `/herbicides` 口径（§4）。

### 3.6 亚毫秒 tie-break 差异（新发现，未修）

**现象（本片在独立 55437 集群上自行复现，非照抄复审结论）**

两条行仅 `created_at` 的微秒部分不同，且 id 顺序与时间顺序相反：

| 行 | id | `created_at`（SQL 全精度） |
| --- | --- | --- |
| X | `11111111-1111-4111-8111-111111111111` | `2026-10-20T12:00:00.000500Z` |
| Y | `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa` | `2026-10-20T12:00:00.000100Z` |

| 路径 | 实际顺序 | 读数 |
| --- | --- | --- |
| SQL 直查（PG 微秒） | **X, Y** | `to_char(created_at,'…US…')` ⇒ `.000500Z` / `.000100Z` |
| HTTP `GET /api/v1/knowledge?limit=2` | **Y, X** | `200`；items 顺序 Y 前 X 后 |
| 服务层 `createKnowledgeService.list()` | **Y, X** | items 顺序 Y 前 X 后 |
| `pg` 驱动交回的 `created_at` | 两行同值 | `Date`；`toISOString=2026-10-20T12:00:00.000Z`、`getTime=1792497600000`（微秒被截断） |

**复现命令（本片实跑，`reproduced=true`，exit 0）**

```powershell
# 空库 + 迁移 + 角色（同 §3.1）
E:\GengYunCommander\.pg17\pgsql\bin\initdb.exe -D <tmp>\pg\data -U gy_owner -A trust --encoding=UTF8 --locale=C
# postgresql.conf: listen_addresses='127.0.0.1'; port=55437
E:\GengYunCommander\.pg17\pgsql\bin\pg_ctl.exe -D <tmp>\pg\data -l <tmp>\pg\postgres.log -w start
E:\GengYunCommander\.pg17\pgsql\bin\psql.exe -h 127.0.0.1 -p 55437 -U gy_owner -d postgres -c "CREATE DATABASE gy_r33_ms"
node subms-readout.mjs <worktree> gy_r33_ms 55437
# ⇒ SQL [X,Y] / HTTP [Y,X] / service [Y,X]；reproduced=true；exit 0
```

`subms-readout.mjs` 为一次性探针（未入仓）：两行 `created_at` 分别 `.000500Z` / `.000100Z` → 直查 `SELECT id, to_char(created_at,'…US…') … ORDER BY created_at DESC, id DESC` → `buildApp` + `POST /api/v1/auth/wechat` 登录 → `GET /api/v1/knowledge?limit=2` → 同一 service `.list()`。驱动实测 `pg 8.23.1`。

**根因**

- PG `timestamptz` 是**微秒**精度，SQL `ORDER BY created_at DESC` 按完整精度比较。
- 应用侧 `pg`（8.23.1）把 `timestamptz` 解成 JS `Date`；`Date` 只有**毫秒**精度（两行的 `toISOString` 都已成为 `.000Z`）。
- `services/api/src/knowledge/service.ts:28-38` 的 `instantOf` 用 `Date.getTime()` / `Date.parse()`（毫秒）；同毫秒时 `compareKnowledgeRows` 退到 `id DESC`（`:36-37`）。
- 关键：服务在 `:83-84` 对**整份快照**（`dbResult.rows` + extra）重排，不是只排种子；因此 DB 行也会被 JS 重排，SQL 与 HTTP/服务层可不同序。

**影响面**

- 仅当 `created_at` 存在**亚毫秒差**时触发；§3.3/§3.4 的夹具都是整毫秒，故当时三面一致。
- 同一毫秒内的两条记录，直查 SQL 与 API 的顺序可不同；分页切片按 JS 顺序计算（`services/api/src/knowledge/pagination.ts:60-66`），以 SQL 直查复核会看到「顺序不一致」。
- 单一路径内不重复/漏行（同一比较器贯穿各页）；**跨路径一致性**被破坏。
- 新写入可能触发：`created_at` 默认是 `clock_timestamp()`（`services/api/db/migrations/0012_knowledge_created_at.sql:68`，微秒级）；历史回填是整秒常量（`:59-61`），不会触发。

**修不修**

要不要修属产品/契约裁定，可选方向包括（a）SQL 与 JS 用同一精度（如 SQL `date_trunc('milliseconds', created_at)`），或（b）把 `created_at` 的全精度文本随快照取出、在 JS 侧按字符串/微秒比较。**本片不改代码**，仅登记缺陷与复现；`status` 未动。

## 4 未取得项（不得读成通过）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 亚毫秒 tie-break 差异 | **已复现 / 未修** | §3.6：SQL（微秒）与 HTTP/服务层（JS 毫秒）在同毫秒内可不同序；修不修属产品/契约裁定 |
| 生产 `DATABASE_URL` / 真实已审资料 | 未取得 | §3 为隔离合成夹具（真实 PG 17.11，但不是生产库/生产数据） |
| `/herbicides` 排序口径 | 未取得裁定 | 现状为登记号升序；是否受 `state-contract.md:32` 第一子句约束待监工裁定 |
| Android/iOS 真机 | 未取得 | `docs/verification/platform-checklist.md:40`、`:48`、`:49` 状态「未验证」 |
| 真实微信身份 / 发布环境 | 未取得 | 保留在社区/消息 blocker 的未取得项里 |
| `status` 改判 | 未执行 | 属监工权限；本片 0 改动 |

## 5 门禁读数

### 5.1 只改 blocker 的机器自证

用 `git show 7dd3d699:docs/architecture/contract-status.json`（片前基线）与工作树 JSON 逐字段比对（除 `blocker` 外所有字段、所有顶层字段）：

```
changed blockers=22
other changes=0
```

### 5.2 门禁命令

| 命令 | exit | 摘要 |
| --- | --- | --- |
| `node tools/verify-contract-status.mjs --write-doc` | `0` | `PASS: 覆盖 113 条契约操作；已装配 109 条；implemented 17 / partial 92 / planned 4；横切维度 8 条；形状错误 0 项；语义错误 0 项`；`SYNC: 中文表格此前不是「中文表格一致」状态，已按 JSON 重写` |
| `node tools/verify-contract-status.mjs`（不带 `--write-doc`） | `0` | `PASS: 中文表格一致`；`PASS: 状态为人工判定…` |
| `node tools/verify-doc-anchors.mjs --strict` | `0` | `COUNT: BROKEN 33 / OUT_OF_RANGE 6 / SUSPECT 66`；`BASELINE: 登记 105 条；本次命中 105 条、基线外新增 0 条、陈旧 0 条`；`PASS: --strict 下没有基线之外的新增` |
| `npm run test:docs` | `0` | `PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables`；研究记录 `5 通过 / 0 失败 / 4 legacy 已钉住` |
| `node tools/verify-migrations-unique.mjs --strict` | `0` | `PASS：5 项判据全部满足（surface / runner / dup / coexist / rollback）；30 条配对 + 1 条登记允许缺省 = 31 条正向迁移逐条有交代` |
| `node --test <8 个定向文件>` | `0` | `tests 87 / pass 86 / fail 0 / skipped 1` |
| `node --test tests/unit/knowledge-ledger-sort-drift.test.mjs` | `0` | `tests 4 / pass 4 / fail 0` |

定向文件：`knowledge-ledger-sort-drift`、`knowledge-api`、`messages-http`、`community-http`、`media-http-access`、`contract-status-tool`、`contract-status-anchors`、`doc-anchors-guard`。

另实测 `--write-doc` **幂等**：同一命令再跑一次，`git hash-object docs/architecture/contract-implementation-status.md` 前/后均为 `b764c6189ef7fe7ca2c04f21dff5e0112b038d0a`（`BYTE_IDENTICAL=True`），exit `0` ⇒ 生成区字节一致。

第二次提交相对第一次只再改 **2 条** blocker（`operations.listKnowledge`、`dimensions.pagination`，加亚毫秒限定）；其余 20 条订正与 5 条保留未动；`git diff HEAD^` 实测 `blockers=2 / other=0`。第三次提交（N2）只把 3 条消息 blocker 里的 `community/service.ts:1805` 改为合流后基线 `b1e8fb3e` 的 `:1808`（`#492` 插入 3 行），并同步本页同一引用；其余未动。

## 6 生成区、人工摘要与防漂移登记

### 6.1 生成区

- `docs/architecture/contract-implementation-status.md` 的生成区为 `:31`（start）到 `:178`（end）；本片仅通过 `node tools/verify-contract-status.mjs --write-doc` 重写，未手改。
- 生成区变化来自 22 条 blocker 文本；「112 → 113」的契约条数在生成区之外的人工摘要（§6.2 第 3 条），不是工具重写。

### 6.2 生成区之外的人工摘要（3 处）

`docs/architecture/contract-implementation-status.md:19` 是人工摘要（在 start 标记之前），本片做 3 处一致性订正：

1. 社区段：`real模式整域503 PROVIDER_UNAVAILABLE、真实持久存储未交付` → `持久化已交付（迁移 0022 + store-pg.ts），仅 real 且无持久化落点时整域 503`。
2. 消息装配行号：`services/api/src/app.ts:765-770` → `services/api/src/app.ts:802-806`（实测 `messagesStore` 装配行）。
3. 契约条数：`112条业务契约` → `113条业务契约`（工具实测 113 条 operation）。

> 这三处都不在生成区；若指挥/监工要求「状态文档零手改」，可只回退这三处，不影响 JSON 与生成区。

### 6.3 防漂移登记（未删断言）

`tests/unit/knowledge-ledger-sort-drift.test.mjs` 原先把两处滞后文本**逐字钉住**（登记表 `docs/verification/gy-r29-i07-ledger-lags.json`）。本片订正台账后：

- **未删任何断言**；只把登记表的 `ledger_blocker_verbatim` 同步为订正后文本，并把 `kind` 改为「台账已订正（原滞后关闭；保留逐字登记以钉住订正后文本）」、补 `resolved_at` / `resolved_by`。
- 登记表仍保留 **2 条**（测试 ④ 钉住数量）；测试 ② 要求 blocker 仍含 `id_asc`，故订正文本以「历史对照」保留该字样（§2.1 的说明）。
- 测试头部注释同步为「曾写 / 已订正」，断言与逻辑零改动；复跑 4/4 绿（§5）。

## 7 清理自证（PG 与临时目录）

| 项 | 读数 |
| --- | --- |
| PG 停止 | `pg_ctl -D <tmp>\pg\data -m fast -w stop` ⇒ `server stopped`，exit `0` |
| 端口 | `pg_isready -h 127.0.0.1 -p 55437` ⇒ `no response`，exit `2`；`Get-NetTCPConnection -LocalPort 55437 -State Listen` ⇒ **0** |
| 5432 | 全程未连接、未启动、未探测 |
| 重解析点 | 删除前整树枚举：目录 reparse point **0**、文件 reparse point **0** |
| 临时目录 | `Remove-Item -LiteralPath E:\GengYunCommander\.pg17\tmp\r33-ledger -Recurse -Force` ⇒ `Test-Path=False`；端口复测 **0** |
| 二次复现集群（§3.6） | `E:\GengYunCommander\.pg17\tmp\r33-ledger-repro`：`pg_ctl stop` exit `0`（`server stopped`）、`pg_isready` exit `2`（`no response`）、55437 监听 **0**、删除前 reparse 目录/文件均 **0**、`Test-Path=False` |
| 仓库删除 | 未删除任何被跟踪文件；提交前 `git status --short` 仅本片 5 个文件，提交后 **0 行**（§8） |

## 8 改动清单

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `docs/architecture/contract-status.json` | 改 | 22 条 blocker 文本；`status` / `baseline` / `evidence` / `lines` 零改动 |
| `docs/architecture/contract-implementation-status.md` | 改（生成区） | 由 `--write-doc` 重写；生成区外 3 处人工一致性订正（§6.2） |
| `docs/verification/gy-r29-i07-ledger-lags.json` | 改 | 两条登记同步为订正后逐字文本；`kind`/`resolved_at`/`resolved_by` 更新 |
| `tests/unit/knowledge-ledger-sort-drift.test.mjs` | 改（仅注释） | 头部说明改为「曾写/已订正」；断言零改动 |
| `docs/verification/gy-r33-contract-ledger-20261023.md` | 新增 | 本页 |

提交：分两次提交（**未 amend**）：第一次为 22 条 blocker 订正 + 本页；第二次为复审后的亚毫秒 tie-break 登记（§3.6）与 `listKnowledge`/`pagination` 措辞限定。两次提交信息均含 `Refs #7, #16, #17`；提交后 `git status --short` 为 **0 行**。本页不自指提交 SHA（自指会与 amend 循环），实测 HEAD 由回报消息给出。

## 9 待指挥/监工裁定

1. `listKnowledge`、`getMedia`、社区 16 条、消息 3 条的 `status` 是否离开 `partial`（本片**未动**；`listKnowledge` 的生产读数与 `/herbicides` 口径仍未取得）。
2. 生成区外的人工摘要 3 处订正是否接受（§6.2；可单独回退，不影响 JSON/生成区）。
3. `docs/verification/gy-r29-i07-ledger-lags.json` 的「已订正后仍保留 2 条逐字登记」是否接受；若要求清空登记，需同时改 `knowledge-ledger-sort-drift.test.mjs` 的 ②/④ 断言（本片按「不删断言」未做）。
4. **亚毫秒 tie-break 差异是否修**（§3.6）：属产品/契约裁定；若修，需决定统一精度（SQL `date_trunc('milliseconds', …)`）还是保留微秒（把全精度文本带进快照/比较器）。本片**未改代码**。
