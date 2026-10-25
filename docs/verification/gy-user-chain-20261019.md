# 第一条用户链路端到端：登录 → 手选作物/地区 → 搜索 → 详情 → 收藏 → 退出（API 层）

Refs #4 #5 #7 #16（GY-I04 / GY-I05 / GY-I07 / GY-I16；功能 F01、F02、F03、F14、F18）。**只交「链路自动化测试 + 本证据页」，不关闭任何整项、不自评验收通过。**

- 被审提交（本页全部读数对应的树）：`463a5c5c347cba89dbe681a6e387c13997d17c38`（短 `463a5c5`，提交说明「test(GY-I04/I05/I07/I16): 第一条用户链路端到端（Refs #4 #5 #7 #16）」）
- 本次改动基于：`8cc9dd8b1ee251c8d7000390d54e0ba07a6ac37f`（`upstream/main`，`Mon Oct 19 11:43:33 2026 +0800`，提交说明「docs: 修正测试号能力引证与 40013 语义，恢复被吞的 README 章节标题，补 A3/B3 配置缺口」）
- 分支：`test/gy-user-chain-e2e`（自建 worktree `.pg17/wt-user-chain`，detach 自 `upstream/main`）
- 本轮**只加测试与文档**：不 push、不开 PR、不改 `packages/contracts/**`、不改 `contract-status.json`、不改迁移、不改 `miniprogram/**`、不加依赖、不放宽或删除任何既有测试
- 本页所有读数都来自本机实跑，未测到的按「未取得」如实登记（见 §7），不给虚构成绩

## 0 本页证明什么、不证明什么

**证明**：`services/api/src/app.ts` 的**原样装配**（`buildApp`，不 mock 任何路由）在**真实 PostgreSQL 17.11** 上把
`登录 → 手选作物/地区 → 搜索 → 详情 → 收藏 → 退出` 跑通，且每一步断言的是**业务语义**（会话落库、来源可追溯、列表/详情同源、收藏属主与幂等、退出后令牌失效），不是只看 200。
真正被验证的实现包括 PG 版 auth store、`favorites/store-pg.ts`、`history/store-pg.ts`、`knowledge/service.ts`、`profile/service.ts`（`app.ts:1172-1178`、`app.ts:1198-1200` 的 `real + pool` 分支）。

**不证明（未取得，见 §7）**：

> **本页证明的是 API 层链路；微信工具／真机证据「未取得」。**

- 微信侧身份换取用**仓内桩算法**（`services/api/src/auth/wechat.ts:52` 的 `computeSubjectLookup`）代替 `sns/jscode2session` 真实往返：本机无正式 AppID/AppSecret、无真机。真实微信 `code` → `openid` 那一段**没有跑到**。
- 小程序页面、微信开发者工具截图、真机点击流**未取得**；本页不替代 #4 的「正式 AppID 实测」证据。
- 定位授权（AC21 成功路径）、`miniprogram/` 侧任何行为，均不在本页范围。

## 1 可复跑命令

```bash
# 0) 一次性准备（本机已做，写在这里供复现）
git fetch upstream --prune
git worktree add --detach <repo>/.pg17/wt-user-chain upstream/main
cd <repo>/.pg17/wt-user-chain && git switch -c test/gy-user-chain-e2e
npm ci --offline --ignore-scripts      # npm workspaces；⛔ 不用 pnpm；不改 package-lock.json

# 1) 链路（自己 initdb 起一次性 PG 17 集群，跑完自己停库并逐文件删数据目录）
#    PG 二进制不在 worktree 内，必须指到本机的 17.11：
USER_CHAIN_PG_BIN=E:/<...>/.pg17/pgsql/bin \
USER_CHAIN_PG_DATADIR=E:/<...>/.pg17/tmp/user-chain-pg/run-1 \
node tests/integration/user-chain-e2e.mjs
```

- `USER_CHAIN_PG_BIN` 缺省探测 `<repo>/.pg17/pgsql/bin`，再回落到 `PATH` 里的 `initdb`。
- `USER_CHAIN_PG_DATADIR` 缺省 `<tmpdir>/gengyun-user-chain-pg-<runId>`；**本机沙箱禁写 `%TEMP%`**，故必须显式指向工作区外目录（见 §7）。
- `USER_CHAIN_PG_KEEP=1` 保留数据目录与 `postgres` 日志（排障用）；默认**逐个文件**删除，⛔ 不用递归删除。
- 脚本**不借外部库、不写死端口**：端口由 `freePort()` 现取，数据目录独立，收工 `pg_ctl -m fast -w stop`。

## 2 六列表（一次实跑的逐字读数）

运行环境：PostgreSQL `17.11`（脚本自起的一次性隔离集群）、API 回环端口 `http://127.0.0.1:57319`（每次不同）。

| 步骤 | 请求 | 期望 | 实测 | 断言位置（path:line） | 对应 AC |
| --- | --- | --- | --- | --- | --- |
| 1 登录 | `POST /api/v1/auth/wechat`（body `{code}` + `Idempotency-Key`）→ `GET /api/v1/auth/session` → `GET /api/v1/me/profile` | 200 + `access_token`；`meta.execution_mode=real`；`no-store`；ETag=`"<revision>"`；令牌可访问受保护接口；`sessions` 按 `sha256(令牌)` 恰好 1 行 | 200；`access_token` 43 字符；`/auth/session`=200 受众 `user`；`/me/profile`=200 `revision=1`；`sessions` 命中 1 行（`audience=user`、`revoked_at` 为空） | `tests/integration/user-chain-e2e.mjs:329-355` | AC01（微信登录／会话建立）、AC09（私有数据不越权） |
| 2 手选作物/地区 | `GET /api/v1/catalog/crops`、`GET /api/v1/catalog/regions?parent_code=330000`、`PUT /api/v1/me/profile`（`Idempotency-Key` + `If-Match: "1"`） | 目录只列**库内已登记且与目录文件一致**的项；写入后读回一致；`revision` 自增 | 作物 `crop_rice/水稻`；地区 `330100/杭州市@mca-xzqh-2023`；`PUT`→200 `revision=2`、ETag `"2"`；`single_profiles` 1 行；**反向控制**：`crops.active=false` 后该作物从目录消失 | `tests/integration/user-chain-e2e.mjs:365-404` | AC01（可选浙江单作物档案、拒定位可手选）、AC21（手选不依赖定位） |
| 3 搜索 | `GET /api/v1/knowledge?crop_id=crop_rice&region_code=330100&q=稗草`；再换检索词／换地区 | 结果只来自**已登记来源**（`source.id`/`source.version` 与 `sources`/`source_versions` 直查一致）；列表 `no-store` 且**不带 ETag**；换词／未覆盖地区必须读空 | `items=1`（`id=6f1a2b3c-…-9b2c3d4e5f60`）；`source=8b3c4d5e-…-bd4e5f607182@e2e-2026.10.19`，库内 `review_status=verified`、`validity=valid`；不存在检索词→0 条；`region_code=330200`→0 条 | `tests/integration/user-chain-e2e.mjs:413-442` | AC02（来源版本与适用条件可查、无结果有原因、能重筛）、AC22（来源不足不得充数） |
| 4 详情 | `GET /api/v1/knowledge/{id}`；再取一个不存在的 uuid | 200；`id`/`revision`/`source` 与**列表逐字段同源**；ETag=`"<revision>"`；`no-store`；库内 `visibility=published`；不存在→404 `NOT_FOUND` | 200、ETag `"1"`；6 个字段 + `source` 深比与列表一致；库内 `visibility=published`、`revision=1`；随机 uuid→404 `NOT_FOUND` | `tests/integration/user-chain-e2e.mjs:454-470` | AC02（列表详情一致）、AC22 |
| 5 收藏 | `POST /api/v1/favorites`（`target_ref={type:'species',id,revision}`）→ `GET /api/v1/favorites` → 重复收藏（换新幂等键）→ 第二个用户的列表／越权 `DELETE` → 缺 `If-Match` → 正确 `DELETE` → 再收藏 | 写入即可读；重复收藏**同 id 不产生第二行**；PG 直查属主正确；他人读不到、删不掉（404 与不存在同形）；缺 `If-Match`→428；取消后读空 | 201（`id=a51c473f-…`）；列表 1 条；PG 1 行属主=登录用户、`target_id`/`target_revision` 一致；重复收藏同 id→PG 仍 1 行；他人列表 0 条、越权删→404 `NOT_FOUND` 且行仍在；缺 `If-Match`→428 `REVISION_REQUIRED`；取消→200 后 0 行；再收藏→`891322d6-…` | `tests/integration/user-chain-e2e.mjs:487-568` | AC17（去重／取消／归属正确）、AC09（越权一律拒绝） |
| 6 退出 | `POST /api/v1/auth/logout` → 同一令牌复验 5 个受保护面；再补一次**不带令牌**的对照 | 200 `accepted`；`sessions.revoked_at` 落库；同一令牌立刻 401 且各面**同形**；不带令牌对照 401 且封套与上面同形；收藏行仍按属主保留 | 200 `accepted=true`；`revoked_at` 已写；`/auth/session`、`/me/profile`、`/favorites`、`/knowledge/{id}`、`/catalog/crops` 全 401 `SESSION_EXPIRED` 且封套同形；不带令牌对照全 401 `SESSION_REQUIRED` 且封套同形；收藏行仍在、属主不变、`target_id` 不变 | `tests/integration/user-chain-e2e.mjs:580-627` | AC01（注销会话立即失效）、AC17（登出不清收藏、属主不变） |

汇总读数（同一次运行，脚本末尾自打印）：

```
PASS 用户链路端到端：119 条断言，6 步，耗时 7375 ms（PostgreSQL 17.11 / http://127.0.0.1:57319）
```

（另有夹具/环境前置断言 **5 条**，位置 `tests/integration/user-chain-e2e.mjs:303/305/308/310/311`（原记 `:287/289/292/294/295`）：`server_version` 必须是 17.x、一次性库必须空、迁移数 ≥18、首跑全落地、二次 no-op。这 5 条**已含在上面 119 条之内**，不是额外加数。）

## 3 真库夹具：为什么这不是「用测试开关凑数据」

- 迁移：`discoverMigrations()` + `applyMigrations(owner, migrations)`，18 个迁移**全量**落地，并断言**重复应用 0 条**（no-op）。
- 种子：`db/seeds/seed_reference.sql`（作物／物种／浙江区划／来源登记骨架），随后把
  `knowledge_dataset_config` 的 `active_mode`/`database_connected` 置为 `real`——这是
  `catalog_read.current_verified_sources` 视图放行的**必要条件**（`services/api/db/migrations/0005_catalog_read_views.sql:6-21`），
  不是测试专用旁路。
- 资料行：脚本按**生产口径**直接写库——`sources`（`source_kind='verified_seed'`、`current_version_id` 指向已核对版本）
  + `source_versions`（`validity='valid'`、`review_status='verified'`、`reviewed_by`/`reviewed_at` 非空）
  + `knowledge_versions`（`visibility='published'`、`crop_ids=["crop_rice"]`、`species_ids=["species_barnyardgrass"]`、`region_codes=["330100"]`）。
  形态与 admin 侧发布后的库内形态一致；读面走的仍是 `catalog_read.current_knowledge` 视图（`services/api/db/migrations/0012_knowledge_created_at.sql:87-117`）。
- ⛔ **没有**依赖 `APP_KNOWLEDGE_UNVERIFIED_SEED`：该开关只在 `config.executionMode !== 'real'` 时生效（`services/api/src/routes/knowledge.ts`），
  本脚本用 `executionMode='real'` + 真 pool，命中不了它。
- 反向控制（证明断言不是恒真）：`crops.active=false` 后目录确实不再出现该作物；不存在的检索词、未覆盖地区确实读空；
  缺 `If-Match` 确实 428；越权删除确实 404 且行未被删。
- **已知脆弱点（本轮未修，在此登记）**：「停用作物后消失」这条的成立前提是 `db/seeds/seed_reference.sql` 的初始作物目录里有
  `crop_corn`（脚本拿「停用前清单」与「停用后清单 + `crop_corn`」做差集比对，位置 `tests/integration/user-chain-e2e.mjs:376-383`）。
  若将来 seed 去掉 `crop_corn`，该条会退化成恒真而**不会报警**。审查建议补一条「初始目录必含 `crop_corn`」的自守卫断言；
  为让被审提交 `463a5c5` 的代码保持字节不变（审查已对该 SHA 复现并杀了 5 个 mutant），本轮**未采纳**，风险以本行登记。

## 4 与任务书措辞的一处差异（如实登记，不改产品代码）

任务书写「退出后同一 cookie 立刻 401 `SESSION_REQUIRED` 同形」。**实测是 `SESSION_EXPIRED`**，原因不是缺陷：

- `services/api/src/auth/middleware.ts:53-60`：**不带凭据** ⇒ `SESSION_REQUIRED`；`:74-80`：**带凭据但会话已撤销/过期** ⇒ `SESSION_EXPIRED`。
- 该口径已被既有测试固化：`tests/unit/auth-routes.test.mjs:211`（「退出登录：撤销当前会话后同一令牌立即失效（401 SESSION_EXPIRED）」）、
  `tests/unit/gy-i22-session-inflight-cross-module.test.mjs:286`（「后同一枚旧令牌在全部 16 个面一致 401 SESSION_EXPIRED」）。
- 契约允许两码：`services/api/src/contract.ts:16` 的 401 → `SESSION_REQUIRED` / `SESSION_EXPIRED`。

⇒ 本页把「会话确实失效」断成 **401 + `SESSION_EXPIRED` 五面同形**，并**额外**加一条「不带上令牌 ⇒ 401 `SESSION_REQUIRED` 且封套同形」的对照，
证明两码可辨、封套同族。**没有为了迁就任务书措辞去改 `services/api/**`，也没有把断言放宽成「401 即可」。**

## 5 改动清单

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `tests/integration/user-chain-e2e.mjs` | 新增（673 行） | 端到端链路脚本：自起一次性 PG 17 集群 + 真 `buildApp` 装配 + 六步业务语义断言 + 收工停库清理 |
| `tests/unit/ci-integration-chain-structure.test.mjs` | 修改（+6 行） | 在既有 `UNWIRED_DECLARATIONS` 白名单里补 `user-chain-e2e.mjs` 一条并写明原因（该文件断言 4 要求「未接链的 integration 脚本必须声明」；**未放宽任何既有断言**） |
| `docs/verification/gy-user-chain-20261019.md` | 新增 | 本页 |

## 6 六项门禁（逐字读数）

| # | 命令 | 读数 |
| --- | --- | --- |
| 1 | `git status --porcelain` | 见 §6.1（提交前 3 行） |
| 2 | `node --test "tests/unit/*.test.mjs"` | 见 §6.2（基线树＝`8cc9dd8` 原样；本分支树＝`463a5c5`，两者读数逐项一致） |
| 3 | `node tests/integration/user-chain-e2e.mjs` | `PASS 用户链路端到端：119 条断言，6 步，耗时 7375 ms（PostgreSQL 17.11 / http://127.0.0.1:57319）`，exit 0 |
| 4 | `node tools/verify-contract-status.mjs` | `PASS: 覆盖 112 条契约操作；已装配 108 条；implemented 13 / partial 95 / planned 4；横切维度 8 条；形状错误 0 项；语义错误 0 项`、`PASS: 语义可核 59 条区间 + 0 条片段；不可核 134 条区间 + 131 条片段（不可核不计入通过）`、`PASS: 中文表格一致`、`PASS: 状态为人工判定；脚本不证明语义正确、真实能力或整项验收。`，exit 0 |
| 4b | `node tools/verify-contract-status.mjs --runtime` | 同上 4 行，另加 `PASS: 无凭据 stub 子进程中的实际 Fastify 产品装配与静态扫描、对照表一致（不监听 / 不请求服务）。`，exit 0 |
| 5 | `python -B tools/validate_development_docs.py` | `PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables`，exit 0 |
| 6 | `git diff upstream/main --check` | 无输出，exit 0 |

### 6.1 `git status --porcelain`（提交前）

```
 M tests/unit/ci-integration-chain-structure.test.mjs
?? docs/verification/gy-user-chain-20261019.md
?? tests/integration/user-chain-e2e.mjs
```

（提交后同一命令为 0 行。）

### 6.2 单测对照：干净基线树（`8cc9dd8` 原样） vs 本分支树（`463a5c5`，含 +6 行白名单）

两棵树**不是同一份内容**：基线树是 `8cc9dd8` 原样（既无 `tests/integration/user-chain-e2e.mjs`，也没有白名单条目）；
本分支树在此基础上多了新脚本与 `tests/unit/ci-integration-chain-structure.test.mjs` 的 `+6` 行白名单，且正是**这一棵（改过白名单的）树**跑出了下面第二行读数。

| 口径 | 命令 | tests | pass | fail | skipped | duration |
| --- | --- | --- | --- | --- | --- | --- |
| 干净基线树（`upstream/main` = `8cc9dd8` **原样**，独立 worktree `.pg17/wt-baseline-unit`，`npm ci --offline --ignore-scripts` 后） | `node --test "tests/unit/*.test.mjs"` | 1617 | 1616 | 0 | 1 | 57753 ms |
| 本分支树（`463a5c5`：新脚本 + `+6` 行白名单） | 同上 | 1617 | 1616 | 0 | 1 | 57276 ms |

读数逐项一致（`tests` 数不变、`fail 0` 不变、`skipped 1` 不变）。原因：白名单条目本身不新增测试，新集成脚本也不进无 PG 的回环链，故两侧用例集合相同。被修改的 `tests/unit/ci-integration-chain-structure.test.mjs` 在本分支树实跑通过：

```
▶ 结构门禁：test:integration:http 链（删条／漏接／重复／坏引用／白名单腐烂都必须红）
✔ 结构门禁：test:integration:http 链（删条／漏接／重复／坏引用／白名单腐烂都必须红） (8.4817ms)
```

两处覆盖差异的说明：基线里 `tests/integration/user-chain-e2e.mjs` 不存在，故基线跑的是**未加白名单条目**的结构门禁（同样绿）；
本分支加入新脚本后，若**不**补白名单，「断言 4」会红——白名单是门禁自己规定的注册机制，不是放宽。**已取得反向控制读数**（把新脚本临时拷进基线 worktree 再单独跑该门禁，跑完即删）：

```
  ✔ 1 引用存在性：链里每个 node <path> 必须真实存在 (1.8249ms)
  ✔ 2 无重复：同一路径不得在链里出现两次 (0.1297ms)
  ✔ 3 已接线集合 ⊇ 冻结清单：删任何一条即红（允许新增） (0.109ms)
  ✖ 4 未接线必须显式声明：新脚本既不接线也不声明 ⇒ 红 (0.8548ms)
  ✔ 5 白名单不得腐烂：已不存在或其实已接线的条目 ⇒ 红 (0.1953ms)
  ✔ 6 解析口径：真值解析、条目格式、冻结清单自洽 (0.208ms)
ℹ pass 5　ℹ fail 2
AssertionError [ERR_ASSERTION]: tests/integration 下有既未接线、也未在本文件 UNWIRED_DECLARATIONS 声明的脚本：tests/integration/user-chain-e2e.mjs。请二选一：接进 test:integration:http 链，或在白名单里写明原因。
```

## 7 未取得项与原因

| 项 | 状态 | 原因（已取得的最近一步证据） |
| --- | --- | --- |
| 微信开发者工具／真机截图 | **未取得** | 本机无真机、无微信开发者工具授权登录；本页只到 API 层（§0 已就地声明） |
| 正式 AppID/AppSecret 的 `sns/jscode2session` 真实往返 | **未取得** | 缺真凭据（`config.ts` 的 `REQUIRED_WHEN_REAL` 含 `WECHAT_APP_ID`/`WECHAT_APP_SECRET`，本机一律为空）。已取得的最近一步：用 `services/api/src/auth/wechat.ts:52` 的**同一套** `computeSubjectLookup` 算法算 `subjectLookupHex`，证明服务端把「身份换取结果 → 会话行」这段跑通（`sessions` 按 `sha256(令牌)` 命中 1 行） |
| `--test-isolation=none` 口径的单测 | **未取得（禁止）** | 按 `.pg17/ruling-test-method-20261019.md`：该模式必带 8 条 `knowledge-*` 假红，不作证据 |
| `bash -n` 等 shell 语法校验 | **未取得** | 本机 `bash` 是 WSL 存根，`bash -n` 不可用 |
| 自动化 CI workflow（在 CI 里跑本链路） | **未取得** | 本轮不新增 `.github/workflows/**`；脚本已进 `UNWIRED_DECLARATIONS` 白名单并写明原因，不进无 PG 的回环链 |
| 无 `%TEMP%` 写权限的默认路径 | 已绕过 | 沙箱拒写 `%TEMP%`（`initdb: could not create directory … Permission denied`）⇒ 用 `USER_CHAIN_PG_DATADIR` 指向工作区外目录；脚本默认值对普通开发机仍可用 |
