# GY-I16（#16）契约账本收口处方（待合流后执行）

- 任务：R29-S3 / Refs #16（不 Closes）
- 性质：**处方，不是执行记录**。本文写于 `feat/gy-r29-i16-fav-entry`（基点 `30a4ff7`），此时 `docs/architecture/contract-status.json` 与 `docs/architecture/contract-implementation-status.md` 正被 **#425 / #422 / #419 / #409 / #407** 五个在飞 PR 占用，改动必撞；故本片**只出清单不动账本**，执行时点由合流序位决定。
- 阅读顺序：§1 判据 → §2 五条 blocker 的「应改成」全文（可直接粘）→ §3 落位表 → §4 命令序列与负控制 → §5 工具机理注意 → §6 占用面与留档。

## 1. 判据：`implemented` 与 `partial` 的边界

账本 `status_definitions` 的原文口径：`implemented` = 「main 上已装配 http 路由，且行为有可复核证据（源码路径+行 或 测试文件+可定位文本片段）」；`partial` = 「有对应操作代码，但产品 HTTP 未装配、缺运行条件/分支，或存在已记录的契约偏差」。

**关键先例（本片据此判 #16 五条）**：账本里 13 条 `implemented` 的 `blocker` 写的是**运行前提**，不是未实现行为。例如 `getProfile` 的 blocker 为「需 DATABASE_URL 与 0001..0010 迁移；无库时如实 503 PROVIDER_UNAVAILABLE」——**「real 模式无 pool 时如实 503」本身不构成 partial 的理由**，只要它不是「用内存冒充持久化」。

`#16` 五条当前被误置 `partial` 的根因，就是 blocker 里那句已经过期的「只交付内存存储（进程重启即丢，无数据库迁移）⇒ real 模式整域 503」。

## 2. 五条 blocker：原文 → 过期点 → 应改成

> 每条只改 `status` 与 `blocker` 两个字段。`path` / `method` / `scope` / `version_required` / `evidence` **一律不动**（`evidence` 的 `name` 是「可定位文本片段」，改测试标题反而会破坏锚点）。

### 2.1 `listFavorites`（GET /favorites）

**原文（过期句）**：「GY-I16 本片只交付内存存储（进程重启即丢，无数据库迁移）⇒ real 模式整域 503 PROVIDER_UNAVAILABLE」

**为什么过期**：
- 迁移早已合入：`services/api/db/migrations/0018_favorites_history.sql` 有 `favorites`（含 `favorites_owner_target_key` 唯一索引与 `favorites_owner_created_idx`）、`history`（三个索引）、`favorites_idempotency`、`history_idempotency` 四表。
- real 且有 pool 一律走 PG：`services/api/src/app.ts` 里 `createPostgresFavoritesStore(pool, …)` / `createPostgresHistoryStore(pool, …)`；只有 `real && !persistent` 才置 `null`，路由侧 `null` 才抛 503 `PROVIDER_UNAVAILABLE`（`services/api/src/routes/favorites.ts`）。**没有内存冒充持久化的路径**。

**应改成**：
```
持久化已接（迁移 0018：favorites/history 四表 + 唯一索引 + 幂等表）；real 且有 DATABASE_URL 时走 PostgreSQL 存储，无库时如实 503 PROVIDER_UNAVAILABLE（绝不用内存存储冒充持久化）。引用可用性端口已于 #167 接线（createWiredVisibilityPort；装配点 services/api/src/app.ts 的 defaultVisibility；可用性按 /knowledge 公开读面每次读取重新派生）。归属/去重/取消/分页/读取时重查已由 HTTP + 域测试覆盖（见证据）。
```

### 2.2 `createFavorite`（POST /favorites）

**原文（过期句）**：「同 listFavorites：内存存储 + real 模式关闭 + 可见性端口已于 #167 接线…」

**为什么过期**：持久化口径同上；契约 `201` 已实现（`services/api/src/routes/favorites.ts` 的 `createFavorite` 处理器 `.status(201)` + `ETag: strongEtagOf(data.revision)`）。

**应改成**：
```
持久化口径同 listFavorites（迁移 0018 + real 走 PG，无库如实 503）；可见性端口已于 #167 接线（同 listFavorites）。收藏只接受契约 3 类目标（species/herbicide/scheme）；收藏不授予可见性，也不产生任何"已使用"事实（投影恰为契约 6 字段）。重复收藏由 Idempotency-Key 与服务端幂等表收敛，不产生第二行（唯一索引兜底）。
```

### 2.3 `deleteFavorite`（DELETE /favorites/{id}）

**原文（过期句）**：「同 listFavorites：内存存储 + real 模式关闭。」（后半句「契约 If-Match/Idempotency-Key 已强制…取消为物理删除，旧行不复活」**仍然为真**，保留）

**应改成**：
```
持久化口径同 listFavorites（迁移 0018 + real 走 PG，无库如实 503）。契约 If-Match/Idempotency-Key 已强制（缺失 428／形状非法 400／版本不符 409；非本人与不存在同形 404）；取消为物理删除，旧行不复活。
```

### 2.4 `listHistory`（GET /history）

**原文（过期句，两处）**：「GY-I16 本片只交付内存存储（无数据库迁移）⇒ real 模式整域 503。」＋「**识别/OCR → 历史的写入接线属跨线**：本片只交付内部口 historyService.appendHistory()…，那一句调用待指挥另行派单。」

**为什么过期**：第二句已经不成立——写入接线落在 `services/api/src/app.ts` 的 `recordHistoryTerminal`：它调用 `history.appendHistory({ ...input, event_key: `${input.kind}:${input.job_id}` })`，并由 `recordTerminal` 注入识别与 OCR 两条终态路径；同文件的装配注记已写明「识别/OCR 终态已接线到历史域内部创建口（appendHistory；确定性 event_key、同任务重复投递为 no-op）」。行为证据：`tests/unit/history-http.test.mjs` 的「stub 完成一次识别 ⇒ GET /history 恰 1 条」「失败/超时各追加 1 条」「OCR 终态同样追加 1 条」「同一任务重复投递终态 no-op」四个用例。

**应改成**：
```
持久化口径同 listFavorites（迁移 0018 + real 走 PG，无库如实 503）。识别/OCR → 历史的写入已接线：终态端口 recordHistoryTerminal 调用内部创建口 appendHistory（确定性 event_key、同任务重复投递为 no-op，不产生"已使用"事实），见 app.ts 的 recordHistoryTerminal 与 tests/unit/history-http.test.mjs 的四条终态用例。引用可用性端口已于 #167 接线（createWiredVisibilityPort；装配点 app.ts 的 defaultVisibility；可用性按 /knowledge 公开读面每次读取重新派生）；任务状态经 createWiredHistoryJobPort 在读取时重查。
```

### 2.5 `deleteHistory`（DELETE /history/{id}）

**状态：保持 `partial`。** 过期的是「同 listHistory：内存存储 + real 模式关闭」；**仍然为真的**是级联未接线（属 GY-I19）。

**级联证据**：`services/api/src/app.ts` 的 `historyCascadePort` 仍是 `createUnwiredHistoryCascadePort()`；`services/api/src/history/cascade.ts` 里 `createWiredHistoryCascadePort` **存在但无人调用**。

**另一条已记录偏差（202/200）**：契约 `packages/contracts/openapi.json` 的 `/history/{id}` → `delete` 的 `responses` **只声明 202**（`description: "受理异步任务，尚未完成"`，body `AckEnvelope`），**没有 200**。实现原先返回 200，属契约里不存在的响应；裁决是**改实现、不改契约**（202 + `X-GY-Cascade: unwired` 才是诚实的「已受理、异步部分未接」）。

**应改成（A 版：202 修复已合流，推荐）**：
```
持久化口径同 listFavorites（迁移 0018 + real 走 PG，无库如实 503）。删除按契约返回 202 + AckEnvelope（Idempotency-Key 与 If-Match 强校验；他人与不存在同形 404、revision 不符 409；同键重放回放首次结果），并以非契约披露头 X-GY-Cascade 如实区分 initiated / unwired / failed。契约描述的"同时启动关联识别/OCR 私有结果/媒体和外发删除"仍未接线（属 GY-I19／跨线）：只删历史行本身，不谎称级联已完成，也不回滚已完成的删除。
```

**应改成（B 版：202 修复尚未合流时用）**：在 A 版基础上，把第一句换成「删除已按 CAS 物理删除历史行（Idempotency-Key 与 If-Match 强校验；他人与不存在同形 404、revision 不符 409），**但响应状态仍是 200，与契约声明的 202 不一致（已记录偏差，修复在途）**」。

> **落地记录**：202 修复已在 **PR #431**（分支 `feat/gy-r29-i16-delete-202`，commit `a7278a8e`）交付——`services/api/src/routes/history.ts` 加 `.code(202)`，小程序消费层同步改为逐操作白名单 `200|202`，四处集成断言与两条客户端用例同步。合流后本节只用 A 版，B 版可删。

> 执行前核对：`git log --oneline -3 -- services/api/src/routes/history.ts` 能看到「按契约返回 202」那条 commit 就用 A 版，否则用 B 版。

## 3. 落位表

| operation | 现状 | 收口后 | 依据 |
| --- | --- | --- | --- |
| `listFavorites` | partial | **implemented** | 路由已装配（`route_mounted: true`）；域/HTTP/真库三层证据齐（`tests/unit/favorites-http.test.mjs` 七组、`tests/integration/favorites-history-isolation-http.mjs` 跨主体隔离、`tests/integration/favorites-history-pg.mjs` 真库臂在 CI `real-pg-17.11` 真跑） |
| `createFavorite` | partial | **implemented** | 同上；201 + ETag + 幂等 + 闭集校验有专测 |
| `deleteFavorite` | partial | **implemented** | 同上；428/400/409/404 与物理删除有专测 |
| `listHistory` | partial | **implemented** | 同上；列表/游标/可见性降级/任务状态端口/终态写入均有专测 |
| `deleteHistory` | partial | **partial（保持）** | 缺的是**实现层**：级联端口未接；另有已记录契约偏差（202/200）。不是缺 CI，也不是缺真库 |

**口径提醒（必须写进交付说明）**：账本 `implemented` 只表示「服务端契约面有可复核证据」，**不代表 #16 验收全绿**；真机/开发者工具层账本不覆盖（那层在 `docs/verification/*`），所以 #16 仍保持 OPEN。

## 4. 执行序列（合流后 30 分钟内）

```bash
# 0) 先确认合流后的基线本身是绿的 —— 让后续 diff 只含本片两处
git fetch upstream && git merge upstream/main       # 本仓 origin 与 upstream 同一 URL，以 upstream/main 为准
node tools/verify-contract-status.mjs               # 期望 PASS；红了说明是别人带来的，先别动账本

# 1) 只改 docs/architecture/contract-status.json 的两类字段
#    a. status：listFavorites / createFavorite / deleteFavorite / listHistory 由 partial 改 implemented
#    b. blocker：§2 的「应改成」全文替换（deleteHistory 保持 partial，用 A 版或 B 版）
#    —— path / method / scope / version_required / evidence 一律不动；不要改测试标题

# 2) 重生成中文对照表（唯一允许的改法，手改必被 CI 判漂移）
node tools/verify-contract-status.mjs --write-doc    # 期望打印 SYNC:（重写 contract-implementation-status.md 的生成区）

# 3) 核读数
node tools/verify-contract-status.mjs                # 期望：覆盖 112 条、已装配 108 条、
                                                     #       implemented 17 / partial 91 / planned 4、横切维度 8 条、
                                                     #       形状错误 0、语义错误 0、证据锚点 409 条、
                                                     #       PASS: 中文表格一致
node tools/verify-contract-status.mjs --runtime      # Fastify 装配面不回归
git diff --stat                                      # 期望恰 2 个文件
```

生成区里的汇总表首行应从 `| 契约操作 | 13 | 95 | 4 | 112 |` 变成 `| 契约操作 | 17 | 91 | 4 | 112 |`（横切维度行保持 `2 | 6 | 0 | 8`）。

**负控制（必做，用来证明这条命令真的会拦）**：把 `listFavorites` 的 `implemented` 改回 `partial`（其余不动）、**不跑** `--write-doc`，直接执行 `node tools/verify-contract-status.mjs`，期望 `[形状错误 0 / 语义错误 0 / 表格漂移 1]` 与 `ERROR: 表格漂移 · 中文对照表与 JSON 不一致；核对状态后使用 --write-doc 同步表格`，退出码 1；恢复原文后 `--write-doc` + 复跑绿，`sha256` 与改前一致。

## 5. 工具机理注意（读自 `tools/verify-contract-status.mjs`）

- **`--write-doc` 有前置条件**：只有形状错误与语义错误**都为 0** 才写盘，否则报表格漂移并拒绝——所以 blocker 里若要引用新行号，必须落在该 operation 自己的注册块内，且不要写越界区间。
- **锚点容差 ±2 行**：`evidence.lines` 必须「起-止」且区间内的锚点命中；`app.ts` 合流后行号会漂，但容差只覆盖 2 行，若某条 evidence 指向 `app.ts` 需现场复核（#16 五条的 evidence 指向 `routes/*.ts` 与 `favorites|history/service.ts`，相对稳定）。
- **`checkEntry` 硬要求**：`blocker` 非空字符串；`evidence` 非空数组；每项只能给 `path` 或 `test` 之一；给了 `test` 时 `name` 必须在文件里出现。
- **`name` 的口径是「可定位文本片段」**，不要求等于用例标题（全表 141 条带 name 的证据里只有 32 条等于标题原文）——所以**不要为了让文案好看去改测试标题**。
- **CI 门禁**：`.github/workflows/engineering-shell.yml` 里的 `node tools/verify-contract-status.mjs`（无 `--write-doc`）⇒ 改了 JSON 不同步文档，CI 必红。门禁自身的测试在 `tests/unit/ci-contract-status-gate.test.mjs`。

## 6. 占用面与留档

**占用**：`contract-status.json` 与 `contract-implementation-status.md` 被 **#425 / #422 / #419 / #409 / #407** 同时占用（同一批 PR）。**#404 只碰 `app.ts` / `config.ts`，不碰这两个账本文件**（早期派单把它列进账本占用，实测不成立）。

**留档（`app.ts` 过期注释，本片不动）**：`services/api/src/app.ts` 里两处装配注记仍写「…待…一行接线调用」（约 `:263`、`:899`，以 `30a4ff7` 为基准）。`app.ts` 是 #419 / #404 的冲突面，等合流后的过期文案清理片一起改，本片只留行号与原文，避免制造冲突。

**未取得**：真机/微信开发者工具层证据（#16 AC17）未取得；本处方未在任何合流后的 main 上实跑过 `--write-doc`（那会改账本，属禁改面）。
