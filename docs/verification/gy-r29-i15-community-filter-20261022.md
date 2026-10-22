# GY-I15（#15）残留缺口 · 社区域「列表筛选」真库读数 + 「举报状态推进通道」缺口登记

- 片号：R29-S13 ｜ 分支：`feat/gy-r29-i15-report` ｜ 基线：`origin/main` `442057b`
- 新增脚本：`tests/integration/community-filter-pg.mjs`（`node tests/integration/community-filter-pg.mjs <ownerUrl>` 亦可，
  主用 env `COMMUNITY_FILTER_PG_TEST_URL`；库名硬钉 `gengyun_community_filter_test`，要求**空库**）
- 接线：`.github/workflows/real-pg-integration.yml`（第 3 个 step，紧跟 `community-pg`）
- 本片**不改**契约、**不新增**迁移、**不动** `deploy/postgres-cvm/sql/20-login-roles.sql` 与 `90-assert-least-privilege.sql`

## 0. 为什么有这一片（审计结论，逐条带锚点）

「筛选」与「举报」的**主干都已落地**，不存在从零实现的空间：

| 面 | 既有实现（事实） |
| --- | --- |
| 筛选参数 | `GET /posts` 契约参数 = `cursor`/`limit`/`crop_id`/`region_code`/`mine`（`packages/contracts/openapi.json` 的 `/posts.get`）；`operations.json` 有 `listPosts` |
| 筛选路由 | `services/api/src/routes/community.ts:123-133`（`additionalProperties:false`，多余参数 400） |
| 筛选服务 | `services/api/src/community/service.ts:768-831`；过滤在 `:797-800`，游标绑定筛选集/主体/排序在 `:801-806`、`:819-826` |
| 筛选小程序 | `miniprogram/pages/community/community.js:146-148`（`params.mine/crop_id/region_code`），chips 在 `community.wxml:37-38` |
| 举报 | 契约 `createReport`/`getOwnReport`；路由 `routes/community.ts:341-360`；服务 `service.ts:1378-1416` + `:1418-1425`；PG 存储 `store-pg.ts:664-699`；表在 `0022_community_persistence.sql`；小程序 `communitydetail.js:267-278` |

因此本片只做**读数**与**缺口登记**：把「筛选在真库上到底回什么」「举报状态到底能不能推进」变成可复跑的断言，
不新增任何功能、不改任何契约字段。

## 1. 真库读数（本机实测，PG 17.11 / 端口 55432，空库一次跑完）

```
PASS 1: 迁移 apply 可重入：迁移目录 26 个，本脚本只取 0001 + 0022（PG 17.11）
PASS 2: 种子：5 条帖（作物×地区×作者×可见性各不相同：published×3 / hidden×1 / deleted×1）真落库
      无筛选公开列表 = [p3(他人,最新), p2, p1]；p4(hidden) 与 p5(deleted) 不在其中
PASS 3: `GET /posts` 无筛选：只回 published+approved（hidden/deleted 不出现），与真库 SELECT 逐位一致
      作物筛选 3 条读数（crop-wheat=2 / crop-rice=1 / 不存在=0）× 地区 3 条 × 组合 3 条，全部与 SQL 对照相等
PASS 4: `?crop_id=` / `?region_code=` / 组合：各自只回该回的，集合与顺序都与真库同条件 SELECT 相等
      mine(a) = [p4(hidden), p2, p1]（3 条）；mine(b) = [p3]（1 条）；p5(deleted) 两边都不出现
PASS 5: `?mine=true`：本人拿到自己的 hidden 版本（3 条）、他人拿到 1 条 ⇒ mine 真的按主体生效，deleted 恒排除
PASS 6: 游标同条件续页：p3 → p1，两页合起来无重复无遗漏，末页 next_cursor=null
PASS 7: 游标绑定筛选集 + 主体 + 签名：跨筛选集/跨主体/篡改签名复用一律 400 INVALID_CURSOR（不串页）
PASS 8: 参数闭集：多余参数 / mine=maybe / region_code 越界·形态 / limit 0·51 / 空 crop_id 全部 400（additionalProperties:false 真生效）
      实际下发语句（节选）：SELECT id, revision, author_id, title, body, crop_id, region_code, media_ids, linked_knowledge_type, linked_knowledge_id, linked_knowledge_revision, visibility,…
PASS 9: 语句读数：23 条列表查询全部**没有 WHERE** ⇒ crop_id/region_code/mine 的过滤在内存里做（未下推 SQL）
      真库 state 闭集：CHECK (((state)::text = ANY ((ARRAY['received'::character varying, 'isolated'::character varying, 'closed'::character varying])::text[])))
      GAP（缺口登记，不是功能验证）：举报 state 写入端只有 `received`（service.ts:1402 硬编码）；store 只有 insertReport/getReport；
      契约只有 createReport/getOwnReport；/admin/reports* 不存在。真库闭集 3 值，可达 1 值。
PASS 10: 举报缺口登记：真库 state=received 落库可读、他人读 404；推进通道在 HTTP/store/契约三处都不存在（B 片待补）
      实际语句计划：Sort (cost=100.71..103.73 rows=1205 width=179) Sort Key: created_at DESC, id DESC
        -> Seq Scan on community_posts (cost=0.00..39.05 rows=1205 width=179)
      下推等价式计划：Limit (cost=0.28..8.30 rows=1 width=179) -> Index Scan using community_posts_feed_idx on community_posts
        Index Cond: (((crop_id)::text = 'crop-wheat'::text) AND ((region_code)::text = '330100'::text))
        Filter: (visibility = 'published'::visibility)
      索引读数：community_posts_feed_idx 存在且可用（下推等价式真的 Index Scan），但当前实现在内存过滤 ⇒ 该索引在日常列表路径上**空转**。
PASS 11: EXPLAIN 读数：实际语句 = Seq Scan + Sort（不用 feed_idx）；下推等价式 = Index Scan using community_posts_feed_idx

全部 11 组真库断言通过。
```

读数口径（不是"状态码 200 就算过"）：每组列表断言都把 `data.items[].id` 与**同条件真库 SELECT** 的 id 序列
（`ORDER BY created_at DESC, id DESC`）逐位比较：公开面 `visibility='published'`，`mine` 面
`author_id=$1 AND visibility<>'deleted'`。顺序不同、多一条、少一条都判红。

`PASS 9` 的「23 条」= 本脚本执行到该点为止所有列表请求真正下发的 `community_posts` 语句条数
（脚本启动时 `GET /posts` 共 23 次），它随脚本内请求数变化，不随数据量变化。

## 2. 负控制（3 条，全部"改前真红 / 恢复后真绿 + sha256 一致"）

基线 sha256：

| 文件 | sha256（基线 = 恢复后） |
| --- | --- |
| `services/api/src/community/service.ts` | `215DF2C1CCF5B996D76FAE667B81152FB37AB7494275CC85F5CDB20E49838BA6` |
| `services/api/src/routes/community.ts` | `301F4DC91BA94EDB5A91EFA9DD6ABC39678D28DBA62A436870346DAE9416D7AC` |

### NC1 · 删掉 `service.ts:797-800` 的筛选（父命题指定的那条）

变异（只此一处）：

```diff
-      const filtered = visible.filter(
-        (record) =>
-          (cropId === null || record.crop_id === cropId) && (regionCode === null || record.region_code === regionCode),
-      );
+      const filtered = visible;
```

实测（`EXIT=1`）：

```
PASS 1 … PASS 3
FAIL（已通过 3 组，第 4 组真库读数不满足）：
AssertionError [ERR_ASSERTION]: /api/v1/posts?crop_id=crop-wheat 的 id 序列必须与真库同条件 SELECT 逐位相等
  [
    '8b57b71e-…',
+   '36a9b9a7-…',     ← 不该出现的 rice 帖（crop-rice）也回了
    '3fd1cc2a-…'
  ]
EXITCODE=1 —— 真库读数不满足，不是"跳过"，也不是"通过"。
```

恢复：把上面 4 行原样写回 ⇒ `sha256 = 215DF2C1…8BA6`（与基线逐字节相同），重跑 `全部 11 组真库断言通过`（`EXIT=0`）。

### NC2 · 删掉游标里的「筛选集绑定」比对（`service.ts:707`）

变异：`if (JSON.stringify(value['filter']) !== JSON.stringify(expected.filter)) throw new Error('filter');` 整行移除。
后果：跨筛选集复用同一游标会被**接受**（本该 400），即"串页"。

实测（`EXIT=1`）：

```
PASS 1 … PASS 6
FAIL（已通过 6 组，第 7 组真库读数不满足）：
200 !== 400
EXITCODE=1 —— 真库读数不满足，不是"跳过"，也不是"通过"。
```

恢复后 `sha256 = 215DF2C1…8BA6`，重跑全绿。

### NC3 · 删掉 `routes/community.ts:125` 的 `additionalProperties: false`

变异：`listPostsQuery` 去掉 `additionalProperties: false`（其余不动）。
后果：`GET /posts?foo=1` 从 400 变成 200（多余参数被静默忽略）。

实测（`EXIT=1`）：

```
PASS 1 … PASS 7
FAIL（已通过 7 组，第 8 组真库读数不满足）：
200 !== 400
EXITCODE=1 —— 真库读数不满足，不是"跳过"，也不是"通过"。
```

恢复：`git checkout -- services/api/src/routes/community.ts` ⇒ `sha256 = 301F4DC9…D7AC`（与基线逐字节相同），
`git status` 只剩新增脚本一个未跟踪文件。

> 恢复方式的一条实测教训（写下来以免下次踩）：本片用的编辑工具会在文件末尾补一个换行，
> 用它「写回原文」后 `routes/community.ts` 会多出 1 字节（`git diff` 只显示最后一行 `-}`/`+}`）。
> 判 sha256 前必须用 `git checkout --` 或逐字节比对复原，否则"恢复后一致"这句话是假的。
> `service.ts` 三次变异/恢复后 sha256 全程一致（该文件末尾本来就是换行结尾）。

## 3. 缺口登记（**不是**功能验证，B 片待补）

| 缺口 | 本片读到的证据 | 需要的动作 |
| --- | --- | --- |
| 举报 `state` 无推进通道 | 真库 `state='received'`（`service.ts:1402` 硬编码）；`GET /reports/{id}` 只回本人；`PATCH /reports/{id}`、`POST /reports/{id}/state`、`PATCH/POST /admin/reports*` 全 404；PG store 无 `updateReport`/`setReportState`；契约里 report 相关 operation 只有 `createReport`/`getOwnReport`；`community_reports.state` 的 CHECK 闭集是 3 值、可达 1 值 | 新增契约 operation（举报队列 + 状态推进）+ 迁移（`0028` 起）+ 最小权限登记；属 B 片 |
| 筛选未下推 SQL | 捕获到列表请求真正下发的语句**没有 WHERE**；`community_posts_feed_idx (crop_id, region_code, created_at DESC, id DESC)` 在日常列表路径空转（`EXPLAIN` = `Seq Scan` + `Sort`） | 把 `store.listPosts()` 改成接收筛选条件并生成谓词（`store-pg.ts:515-521`）+ 服务层不再二次过滤；B 片 |

## 4. 不证明 / 未取得（必须如实引用）

- **不**证明举报闭环已完成：本片断言的是「推不动」，是缺口登记；B 片补上后本节与脚本第 12 节必须一起改。
- **不**证明筛选性能/容量：EXPLAIN 只读**计划形状**（选没选索引），不报执行时间、不做基准、不构成延迟结论。
- **不**证明真实审核供应商：全程注入 `provider.synthetic === true` 的合成审核端口（不联网、无凭据），
  仅用于让内容「可发布」；`real` 模式下写路径仍被未接线的审核域 fail-closed（见 `docs/verification/gy-i15-community-pg-20261018.md:171`）。
- **未取得**：任何真实用户/真实内容的数据。种子帖、账号、举报说明全部是脚本内合成值。
- **未取得**：CI 上的真跑读数由 PR 的 `real-pg-17.11` job 产出；本文件记录的是**本机** PG 17.11 读数。

## 5. 接线与门禁（本片改动清单）

| 文件 | 改动 |
| --- | --- |
| `tests/integration/community-filter-pg.mjs` | 新增（11 组断言） |
| `.github/workflows/real-pg-integration.yml` | 新增 1 个 step（`CREATE DATABASE gengyun_community_filter_test` → `node tests/integration/community-filter-pg.mjs`，env 传 `COMMUNITY_FILTER_PG_TEST_URL`） |
| `tests/unit/ci-real-pg-wiring.test.mjs` | `MANAGED_SCRIPTS` / `FROZEN_MANAGED_SCRIPTS` / `REQUIRED_STEP_ORDER` 各加 1 条（第 2 位之后），并补该条来源注释 |
| `tests/unit/ci-integration-chain-structure.test.mjs` | `UNWIRED_DECLARATIONS` 加 1 条（真库臂不进无 PG 的回环链，如实登记） |

门禁读数（本机）：

```
node --test tests/unit/ci-real-pg-wiring.test.mjs              → tests 18 / pass 18 / fail 0
node --test tests/unit/ci-integration-chain-structure.test.mjs → tests 7  / pass 7  / fail 0
node --test tests/unit/sql-column-coverage.test.mjs            → tests 16 / pass 16 / fail 0（宿主仍是 23 个：本脚本在 tests/ 下，不进 STORE_ROOT 扫描面）
node --test tests/unit/integration-script-coverage.test.mjs    → tests 6  / pass 6  / fail 0
node --test tests/unit/community-*.test.mjs                    → tests 173 / pass 173 / fail 0
node tools/verify-contract-status.mjs                          → exit 0（112 op / 108 装配 / implemented 13 / partial 95 / planned 4）
```

## 5½. CI 读数（PR #433 的 `real-pg-17.11` job，GitHub Actions）

- run：`actions/runs/39696822787`（job `real-pg-17.11`），step 名 `psql … CREATE DATABASE gengyun_community_filter_test && node tests/integration/community-filter-pg.mjs`；
- 服务端：`PostgreSQL 17.11 (Debian 17.11-1.pgdg13+2)`（CI 的 `postgres:17.11` 容器）；
- 结果：`全部 11 组真库断言通过。`，**与本文第 1 节的 11 组逐条一致**；
- 规划器读数在 CI 上**与本地逐字相同**（同一个 PG 17.11、同样的 1205 行与 `ANALYZE`）：

```
实际语句计划：Sort (cost=100.71..103.73 rows=1205 width=179) Sort Key: created_at DESC, id DESC
  -> Seq Scan on community_posts (cost=0.00..39.05 rows=1205 width=179)
下推等价式计划：Limit (cost=0.28..8.30 rows=1 width=179) -> Index Scan using community_posts_feed_idx on community_posts
  Index Cond: (((crop_id)::text = 'crop-wheat'::text) AND ((region_code)::text = '330100'::text))
  Filter: (visibility = 'published'::visibility)
```

- 该 PR 的 18 项检查全绿（含 `real-pg-17.11` / `unit-tests` / `integration-http` / `static-check` / `contract-tests` / `development-docs`）。

## 6. 合流面（在飞 PR 冲突预判）

- `#419`（`feat/gy-r28-w12-media-persistence`）同时改 `real-pg-integration.yml` + `ci-real-pg-wiring.test.mjs`
  + `ci-integration-chain-structure.test.mjs` ⇒ 与本片**三处全撞**（都是往同一批清单里加条目）。
- `#428`、`#424`、`#407` 改 `ci-integration-chain-structure.test.mjs`（`UNWIRED_DECLARATIONS`）⇒ 与本片**同区域**。
- 本片**未**触碰 `packages/contracts/*`、`docs/architecture/contract-status.json`、`deploy/postgres-cvm/sql/*`，
  因此与 #428 / #419 的迁移号、最小权限与台账面**零冲突**。
