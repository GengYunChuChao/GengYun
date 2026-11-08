# GY-R72 W54 · 审核结论新鲜度跨重启（只读事实端口 + `0052`）· 证据页

- 日期：2026-11-02
- 分支 / 基线：`feat/gy-r72-moderation-conclusion-freshness`，基线 `1b85e693`（`git rev-parse 1b85e693` = `1b85e69399123b3052427ad6a654d94c89c0c7bf`）。
- 本片**碰**：`services/api/db/migrations/0052_moderation_conclusion_facts.sql`（新）、`services/api/db/migrations/rollback/0052_moderation_conclusion_facts.down.sql`（新）、`services/api/src/moderation/conclusion-facts.ts`（新：契约 + 判定）、`services/api/src/moderation/conclusion-facts-pg.ts`（新：PG 只读实现）、`services/api/src/moderation/service.ts`（**13 行等量替换、净 0 行**）、`services/api/src/moderation/ledger-pg.ts`（**3 行等量替换、净 0 行**）、`services/api/src/app.ts`（**2 行等量替换、净 0 行**）、`deploy/postgres-cvm/sql/20-login-roles.sql`（段 M3 的 SELECT 清单 6 列 → 12 列）、`deploy/postgres-cvm/sql/90-assert-least-privilege.sql`（分类清单注释 + `expected()` 的 SELECT 清单 + 新增一条 SELECT 零行探针 + 门禁断言）、`tests/unit/moderation-conclusion-freshness.test.mjs`（新：T1–T6）、`tests/moderation/_http-fixtures.mjs`（`makeHarness` 一行透传）、`tests/unit/sql-column-coverage.test.mjs` / `tests/unit/migration-reservations.test.mjs`（只挪计数钉子）、`tests/integration/{admin-audit-logs-pg,admin-scopes-authority-pg,moderation-ledger-pg}.mjs`（末项版本钉子 0051 → 0052）、`services/api/db/migrations/README.md`、本页。
- 本片**没碰**：`packages/contracts/**`、`services/api/src/contract.ts` 的错误码表、`services/api/src/admin/scopes.ts`、四份 `tools/doc-anchors-*.json`、`tests/unit/doc-anchor-relocations.json`、`apps/**`、`.github/**`、任何线上库。

## 0 结论先说

1. **缺陷是真的，而且只在"重启"上显形**：读面的结论新鲜度原先只从**内存台账**派生（基线 `1b85e693` 的 `services/api/src/moderation/service.ts:1094-1104`，`ledger.forRevision(target).flatMap(...)`），而 PG 台账的决策**不回填**（`services/api/src/moderation/ledger-pg.ts:48-51` 的「下架集合回填，任务结论仍不回填（W43）」一节，`services/api/src/moderation/ledger-pg.ts:200` 的 `const inner = createModerationLedger()`、同文件 `369-372` 的 `forRevision` 直通）⇒ 进程一重启、内存空 ⇒ `staleReasons` 恒空 ⇒ `RESCREEN_REQUIRED` 永不触发。同一个夹具在改前/改后的读数（第二列是同一段脚本在基线代码上跑出来的）：

   | 读数 | 改前（基线 `service.ts`） | 改后 |
   | --- | --- | --- |
   | 端口被问了几次 | `portCalls: 0` | `portCalls: 1` |
   | 读面 `visible` | `true` | `false` |
   | 读面 `reason_codes` | `[]` | `["RESCREEN_REQUIRED","MODEL_VERSION_CHANGED"]` |

2. **改法是"加一个只读事实端口 + 迁移补一列"**，不是"把台账回填起来"：迁移 `0052` 给 `public.moderation_decisions` 加可空 `concluded_at`（+ 一条读面索引 + 只回填 `approved` 空值行），运行时侧新增只读端口（契约 `services/api/src/moderation/conclusion-facts.ts`、实现 `services/api/src/moderation/conclusion-facts-pg.ts`），读面在**内存为空时**才问它。
3. **可见性零变化**：端口不带任何可见性字段，`present` / `effectiveState` / 社区读面一个符号都没动（`services/api/src/community/service.ts` 全文不匹配 `concludedAssessmentsOf|conclusionFacts`）；`T6` 用「结构 + 行为逐字相等 + 只降不升」三组判据钉死。
4. **三个热文件净 0 行**（`docs/` 按行号引它们 383 处，见 §2.6）：`services/api/src/app.ts` `2/2`、`services/api/src/moderation/ledger-pg.ts` `3/3`、`services/api/src/moderation/service.ts` `13/13`。
5. **两条必须如实登记的边界**：① 端口拿不到事实（缺表/缺列/权限不足）时**返回空数组**，即"少判 stale"而不是"多判" —— 库不可用的窗口里，重启后的过期识别仍然是关的；② 存量行里 `rule_version`/`model_version`/`prompt_version` 为 NULL 的历史行**仍然 unknown**，本片不补造版本，它们按与内存**同一口径**被判 stale（内存口径下本来也是 `*_VERSION_UNKNOWN`，见 §2.2）。

## 1 缺陷链（带文件与行号）

| # | 现场 | 读数 |
| --- | --- | --- |
| 1 | 读面的结论新鲜度只从内存台账派生 | 基线 `1b85e693` 的 `services/api/src/moderation/service.ts` 第 `1094-1104` 行（`ledger.forRevision(target).flatMap((task) => …)`） |
| 2 | PG 台账把「任务结论」明确列为**不回填** | `services/api/src/moderation/ledger-pg.ts:48-51`（W43 决策段，本片在该段**末行**加了一句"W54 不改这条决策"，行数不变） |
| 3 | 台账实例内部是一个**内存**台账 | `services/api/src/moderation/ledger-pg.ts:200`（`const inner = createModerationLedger()`） |
| 4 | `forRevision` 直通内存 | `services/api/src/moderation/ledger-pg.ts:369-372` |
| 5 | ⇒ 重启后第 1 条恒空 | 改前读数 `portCalls: 0 / visible: true / reason_codes: []`（§0 表第一列） |
| 6 | ⇒ `RESCREEN_REQUIRED` 分支不可达 | `services/api/src/moderation/service.ts:1105`（`if (staleReasons.length > 0)`，本片一字未动） |

**为什么这条链只在"重启"上显形**：同一进程内只要送审/发布过，内存台账就有该目标的结论，`versionFreshnessOf`（`services/api/src/moderation/service.ts:759-788`）照旧能算；内存空了才踩空。这也解释了为什么既有用例 `tests/moderation/http-freshness.test.mjs`（**同进程**换端口，共享同一台账）一直绿——它测的是"内存里有一条结论、当前版本前进了"，从来没测过"重启"。

## 2 改法

### 2.1 迁移 `0052`：一列、一索引、一条定向回填

- `services/api/db/migrations/0052_moderation_conclusion_facts.sql:64` `ALTER TABLE public.moderation_decisions ADD COLUMN IF NOT EXISTS concluded_at timestamptz;` —— 可空；NULL 的语义是"没有结论 / 结论时刻未知"，不是"0"。
- `services/api/db/migrations/0052_moderation_conclusion_facts.sql:78-79` 建 `moderation_decisions_target_concluded_idx (target_type, target_id, target_revision, concluded_at DESC)`：前三列等值、第四列定序，正好对上读面 SQL 的 `WHERE` + `ORDER BY`。**不复用** 0028 的 `moderation_decisions_target_idx`（不带 revision、不带时间序）。
- `services/api/db/migrations/0052_moderation_conclusion_facts.sql:91-94` 回填：`UPDATE … SET concluded_at = updated_at WHERE decision = 'approved' AND concluded_at IS NULL;`。两个条件都是必须的：`decision = 'approved'` 保证不把 rejected/quarantined/pending/NULL 行填成"有结论"（不臆造事实）；`concluded_at IS NULL` 保证可重跑。**不写 `updated_at` 自身**——否则任何按 `updated_at` 的清理/审计扫描都会把存量通过行当成本次迁移刚写过的行。
- `updated_at` 是**近似**口径（终态行最后一次写就是那次判定），已在迁移头注释与 `services/api/db/migrations/0052_moderation_conclusion_facts.sql:67` 的 `COMMENT ON COLUMN` 里写明。
- 回滚 `services/api/db/migrations/rollback/0052_moderation_conclusion_facts.down.sql:28`（`DROP INDEX IF EXISTS`）→ `:34`（`DROP COLUMN IF EXISTS`）。**不用** G 码预检：`concluded_at` 是可重算的派生值、不是证据，回滚后端口会因缺列返回空数组（只记一次 warn，见 §2.2）。

### 2.2 只读事实端口：为什么"另起两个文件"

- 契约 `services/api/src/moderation/conclusion-facts.ts`：`ConcludedAssessmentFact`（`services/api/src/moderation/conclusion-facts.ts:51`）、`ModerationConclusionFactsPort`（`:79`）、`ConclusionFreshnessSources`（`:119`）、`concludedFactFreshnessOf`（`:127`）、`conclusionStaleReasonsOf`（`:157`）。
- 实现 `services/api/src/moderation/conclusion-facts-pg.ts`：`CONCLUSION_FACTS_SQL`（`services/api/src/moderation/conclusion-facts-pg.ts:46`，只 `SELECT` 七列：`content_kind, decision, rule_version, model_version, prompt_version, COALESCE(concluded_at, updated_at) AS concluded_at`；谓词 `superseded = FALSE AND decision = 'approved'`；`ORDER BY COALESCE(concluded_at, updated_at) DESC LIMIT 30`，与改前的 `.slice(0, 30)` 上限对齐）、`createPostgresConclusionFacts({ pool, warn })`（`services/api/src/moderation/conclusion-facts-pg.ts:100`）。
- **为什么实现不写在 `ledger-pg.ts` 里**：该文件被 `docs/` 按行号引 7 处（最大 504），`service.ts` 被引 55 处、`app.ts` 被引 321 处。把 ~200 行实现塞进 `ledger-pg.ts` 会推移它自己的锚点，而"只对这一个文件重算基线"要改禁改的 `tools/doc-anchors-*.json`。⇒ 实现独立成 `conclusion-facts-pg.ts`，三个热文件只留"一行 import / 一行调用 / 一行装配"，全部做到左右两边相等（§2.6）。
- **为什么不用 `evaluateModelReReview` 复用**：把一条事实合成一个 falsy task 再喂合流层（`packages/moderation/model-review.mjs`）实测会在版本**对齐**时也多出 `MODEL_LAYER_INVARIANT_VIOLATION`、`MODEL_LAYER_INPUT_BINDING_MISSING`、`NOT_PUBLISHABLE`（`versionFreshnessOf` 只滤后两条）⇒ 会把全部已发布内容误判过期。⇒ `concludedFactFreshnessOf` **显式镜像** `versionFreshnessOf` 的三段比对：规则版本为 `null` ⇒ 只报 `RULE_VERSION_UNKNOWN`；模型/prompt「当前版本或事实版本任一为 `null` ⇒ `*_UNKNOWN`，两者都有且不等 ⇒ `*_CHANGED`」——与 `packages/moderation/model-review.mjs` 的 `!isVersionString(current) || !isVersionString(existing)` 判据同口径，**不把缺失降级成"当作相同"**。
- **fail-closed 的方向**：`services/api/src/moderation/conclusion-facts-pg.ts` 的查询抛错 ⇒ 记一条 JSON warn（`event: moderation.conclusion_facts.unavailable`、`consequence: stale_reasons_degraded_to_memory_only`，同一失败只记一次）并 `return []`；行不合格（`content_kind` 越出闭集、`decision` 不在白名单 `['approved']`、时间解析不了）⇒ 记 `row_skipped` 并跳过。**绝不抛**：读面不该因为"新鲜度算不出来"而 500，更不该凭"不知道"改任何可见性。⇒ 代价是库不可用的窗口里过期识别仍然关着，这一条在 §7 再写一遍。

### 2.3 `service.ts` 的接线：11 行换 11 行

`services/api/src/moderation/service.ts:1098-1104` 现在是一次调用：

```
const staleReasons = await conclusionStaleReasonsOf({
  target,
  ledger,
  port: deps.conclusionFacts,
  visible_published: verdict.visible && verdict.visibility === 'published',
  freshness: { task: versionFreshnessOf, rule: currentRuleVersion, model: currentModelVersion, prompt: (kind) => currentPromptVersion(kind === 'image' ? 1 : 0) },
});
```

判定顺序在 `services/api/src/moderation/conclusion-facts.ts:165-186`：非"可见且已发布" ⇒ `[]`（改前第一道门，顺序不变）→ **内存里有结论** ⇒ 原样复用 `versionFreshnessOf` 去重 `.slice(0, 30)`（连它对 `MODEL_LAYER_INPUT_BINDING_UNVERIFIED`/`NOT_PUBLISHABLE` 的过滤一起，不复制实现）→ 内存空且端口缺席 ⇒ `[]` → 内存空则问端口（再兜一层 `try/catch`）。`deps.conclusionFacts` 是**可选**字段（`services/api/src/moderation/service.ts:149` 同行追加），不传 ⇒ 与接线前逐字节相同。

### 2.4 授权与断言的三处复述（+ 一处注释）

- `deploy/postgres-cvm/sql/20-login-roles.sql:1537-1541`：段 M3 的 `GRANT SELECT` 从 6 列（`job_id,target_type,target_id,target_revision,content_kind,superseded`）扩到 **12 列**（+ `rule_version,model_version,prompt_version,concluded_at,decision,updated_at`）；`INSERT` 26 列与 `UPDATE` 14 列**一字未动**；`REVOKE ALL … FROM PUBLIC`（`:1535`）未动。
- `deploy/postgres-cvm/sql/90-assert-least-privilege.sql`：① `deploy/postgres-cvm/sql/90-assert-least-privilege.sql:454-461` 的写面注释块**一个字节都没动**（原文"仍只写不读"限定的是**写面三条探针**，仍然为真；读面另起一条探针，不在这段里）；② `expected('moderation_decisions', …)` 的 SELECT 清单从 6 列扩到 12 列（注释在 `deploy/postgres-cvm/sql/90-assert-least-privilege.sql:1590` 起，W54 的两行在 `deploy/postgres-cvm/sql/90-assert-least-privilege.sql:1590-1591`）；③ 新增一条 **SELECT 零行探针**（`r28_probe_mod_dec_sel`，同一 `SAVEPOINT`/`\set … :ERROR`/`ROLLBACK TO SAVEPOINT` 范式，`SELECT` 的 12 列与上面两处逐列一致）；④ 门禁断言串（`deploy/postgres-cvm/sql/90-assert-least-privilege.sql:3677`、`deploy/postgres-cvm/sql/90-assert-least-privilege.sql:3679`）加上 `AND :'r28_probe_mod_dec_sel' = 'false'` 与文案里的"SELECT 12 列"。
- 钉子只挪数字、断言一条没删：`tests/unit/sql-column-coverage.test.mjs`（`ADDITIONAL_SQL_HOST_FILES` 增 `moderation/conclusion-facts-pg.ts` 后：`auditedFiles 24`、`sqlLiterals 321`、`SELECT 171`、`columnRequirements 2079`、`coveredRequirements 1978`；per-file 增 `1`；宿主集 37 = 24 审计 + 13 登记）、`tests/unit/migration-reservations.test.mjs`（正向 51 / rollback 50 / `51 + 1 === 52`，并新增一条 `0052` 存在性断言）、三个 `tests/integration/*-pg.mjs` 的"末项版本"（0051 → 0052）。

### 2.5 为什么运行时**只**新增 SELECT（不给 UPDATE）

端口只读：它只回答"这个目标有哪些已通过的结论、用的哪一版"，不回填台账、不写 `concluded_at`。`concluded_at` 的唯一写入点是迁移里的那条定向回填 ⇒ `gengyun_api_runtime` 不需要、本片也**不授予** `concluded_at` 的 UPDATE 权限。少一列写权就少一条"运行时能把旧结论伪装成新结论"的路。

### 2.6 三个热文件的行数账（净 0 行）

`git --no-pager diff --numstat 1b85e693`：

| 文件 | 增/删 | `git diff -U0` 的 hunk 头 |
| --- | --- | --- |
| `services/api/src/app.ts` | `2 2` | `@@ -234 +234 @@`、`@@ -954 +954 @@` |
| `services/api/src/moderation/ledger-pg.ts` | `3 3` | `@@ -48,4 +48,4 @@` |
| `services/api/src/moderation/service.ts` | `13 13` | `@@ -41 +41 @@`、`@@ -149 +149 @@`、`@@ -1094,11 +1094,11 @@` |

⇒ 三个文件的总行数改前改后相同；`docs/` 里按行号引它们的 383 处（55 + 321 + 7）无需重算。

## 3 单测六条（`tests/unit/moderation-conclusion-freshness.test.mjs`，新）

全部用**合成夹具**（记录型假池 + 既有 `makeHarness`）：不是真库证据。

| 用例 | 钉什么 | 改前 | 改后 |
| --- | --- | --- | --- |
| **T1** | 迁移形状：`ALTER TABLE … ADD COLUMN IF NOT EXISTS concluded_at timestamptz;`、索引 `(target_type,target_id,target_revision,concluded_at DESC)`、回填**同时**带 `decision = 'approved'` 与 `concluded_at IS NULL`；正向文件剥注释后 `GRANT`/`DROP` 均不出现；回滚文件 `DROP INDEX IF EXISTS` + `DROP COLUMN IF EXISTS` | 迁移文件不存在 ⇒ 红 | 绿 |
| **T2** | 重启（全新空内存台账 + 同权威）后：`tasks()` 为空、端口**真的被问过一次**且 `values` 深等 `['post','post-1001',1]`、`visible === false`、`reason_codes[0] === 'RESCREEN_REQUIRED'` 且含 `MODEL_VERSION_CHANGED` | **红**：`AssertionError: 内存为空时必须真的去问一次库（不是"什么都不做就放行"）`，`0 !== 1`；把这条断言让开后的**用户可见**读数见 §0 表第一列（`visible: true`、`reason_codes: []`） | 绿 |
| **T3** | 版本对齐时不误伤：端口被问过一次，`visible === true` 且不出现 `RESCREEN_REQUIRED` | 绿（改前也不报） | 绿 |
| **T4** | `decision` 为 `pending` / `NULL` 的行不算结论：端口交 `[]`，读面 `visible === true`、无 `RESCREEN_REQUIRED`，并至少记一条 `row_skipped` warn | 绿 | 绿 |
| **T5** | 端口遇缺表/缺列/权限不足（`42703`）：两次调用都返回 `[]`、每次都真问一次库、同样失败**只记一次** warn、JSON 载荷 `event`/`reason`/`consequence` 三键齐全；读面照常返回（不 500）、`visible === true` | 绿（端口不存在时同样"没事实"） | 绿 |
| **T6** | 可见性零变化：① 结构——两个端口文件剥注释后不含 `effectiveState`/`checkReadVisibility`/`present(`/`Visibility`，且 `services/api/src/community/service.ts` 全文不引用端口；② 行为——端口给"版本对齐的 approved 事实"与给空的 `readView` **`deepEqual` 逐字相同**；③ 方向——端口给不符版本 ⇒ `visible === false` + `RESCREEN_REQUIRED`，同实例空端口对照仍 `visible === true` | 绿 | 绿 |

## 4 门禁读数（`exit code` 全是实测）

| 门禁 | exit | 备注 |
| --- | --- | --- |
| `git diff --check` | 0 | 无空白错误 |
| `npm run lint` | 0 | `tsc --noEmit`（services/api + apps/admin）+ 卫生扫描 |
| `node --test tests/unit/moderation-conclusion-freshness.test.mjs` | 0 | T1–T6 6/6 |
| `npm run test:unit` | 0 | 见下 |
| `npm run test:contract` | 0 | 见下 |
| `npm run test:docs` | 0 | 见下 |
| `node tools/verify-migrations-unique.mjs --strict` | 0 | 51 正向 / 50 rollback / 缺号只有 `0037`（README 依据） |
| `node tools/verify-contract-status.mjs` | 0 | 见下 |
| `node tools/verify-contract-status.mjs --reanchor`（dry-run） | 0 | 见下：无漂移 |
| `node tools/verify-doc-anchors.mjs --strict --scan docs` | 0 | 无新增裸锚点孤儿、无漂移 |
| `node tools/verify-doc-anchors.mjs --strict --symbol=strict --scan docs` | 0 | 提交后复跑 |
| `node --test tests/unit/doc-anchor-relocation-identity.test.mjs` | 0 | 提交后复跑（该测试读 `HEAD`） |
| `node --test tests/unit/sql-column-coverage.test.mjs` | 0 | 17/17；`runtime_sql_columns_are_granted` 用**新 SELECT 的 12 列**对授权面双向核对 |
| `node --test tests/unit/least-privilege-expected-parity.test.mjs` | 0 | `expected()` 与 `20-login-roles.sql` 逐列一致 |
| `node --test tests/unit/least-privilege-external-manifest.test.mjs` | 0 | |
| `node --test tests/unit/deploy-sql-gate-{forms,probe,recovery}.test.mjs` | 0 / 0 / 0 | 这三条是 workflow 结构审计（不是 `npm run` 脚本），不解析 90-assert |

## 5 三条负控制（每条都"改 → 跑 → 还原 → 核 sha256"）

| # | 改什么 | 跑什么 | 红在哪条断言 | 还原后 sha256 |
| --- | --- | --- | --- | --- |
| **NC1** | `services/api/src/moderation/conclusion-facts-pg.ts` 里把 `rows = result.rows;` 改成 `result.rows.slice(0, 0)`（**端口恒返空**，但仍然真的问库） | T1–T6 | T2 `AssertionError: 重启后模型版本已前进 ⇒ 旧结论不得再当"已审"返回`（`true !== false`）；连带 T4（少了 `row_skipped` warn）、T6③（`visible` 仍 `true`） | `F582AD2E…FACFE2D89` = 改前 |
| **NC2** | 同文件把 `CONCLUSION_FACT_DECISIONS` 从 `['approved']` 改成 `['approved', 'pending']`（**把 `pending` 当 `approved`**） | T1–T6 | T4 `AssertionError: 非 approved 的行一律不进事实面` | `F582AD2E…FACFE2D89` = 改前 |
| **NC3** | `services/api/db/migrations/0052_moderation_conclusion_facts.sql` 的回填**去掉** `decision = 'approved'` 条件（只留 `WHERE concluded_at IS NULL`） | T1–T6 | T1 `AssertionError: 回填必须同时带 decision = approved 与 concluded_at IS NULL 两个条件（不臆造、可重跑）` | `3ABD67B9…909CA16C` = 改前 |

另有一条"改前必红"的**基线对照**（不是负控制，但同一手法）：把 `services/api/src/moderation/service.ts` 临时回到基线 `1b85e693` 的版本 ⇒ T2 红（`portCalls` 为 `0`）、探针读数 `portCalls=0`、`visible=true`、`reason_codes=[]`；还原后 sha256 `BC7CCEA7…1D2DD6E1` 与临时回退前一致，探针恢复 `portCalls=1`、`visible=false`、`reason_codes=["RESCREEN_REQUIRED","MODEL_VERSION_CHANGED"]`。

## 6 与派单不一致之处（逐条：派单怎么说 / 仓库实际是什么）

| # | 派单怎么说 | 仓库实际是什么 | 我怎么做 |
| --- | --- | --- | --- |
| 1 | 索引写 `(target_type, target_id, conclusion_revision DESC)` | `public.moderation_decisions` **没有** `conclusion_revision` 列（0028 的列清单里没有；版本维度是 `target_revision`） | 按派单自带的"若列名不同按实际列名"改用 `(target_type, target_id, target_revision, concluded_at DESC)`，并在迁移头注释登记这条替代 |
| 2 | 实现放 `ledger-pg.ts` | 该文件被 `docs/` 引 7 处；`service.ts` 55 处、`app.ts` 321 处 | 实现独立成 `services/api/src/moderation/conclusion-facts-pg.ts`，三个热文件净 0 行（§2.6） |
| 3 | `ConcludedAssessmentFact` 六个字段（无 `content_kind`） | 当前模型/prompt 版本是按**内容类别**派生的（`services/api/src/moderation/service.ts:599-615`） | 事实多带一个 `content_kind: ContentKind`，否则重启后根本算不出该问哪一路的版本 |
| 4 | `decision: 'approved'｜'rejected'｜'pending'` | 0028 的 CHECK 还有第四个取值 `'quarantined'` | 契约类型按派单的三值（端口只放 `approved`）；PG 实现的 SQL 谓词是 `decision = 'approved'`，行映射再加一层白名单兜底 |
| 5 | 端口"缺表/缺列 ⇒ 空数组 + 记一次 warn" | 既有失败映射（`services/api/src/moderation/ledger-pg.ts:193-204`）把错误码折成 `PROVIDER_*` | 端口**不**复用那条映射：它对读面是"没有事实"，不是"请求失败"，所以自己记 JSON warn，不抛 `ApiError` |
| 6 | 90-assert"三处复述" | 实际是四处：分类清单注释、`expected()` 列清单、探针、门禁断言串；`deploy/postgres-cvm/sql/90-assert-least-privilege.sql:454-461` 那段**写面**注释块不是复述，它讲的是三条写探针，本片**未改** | 四处全同步；写面注释块保持原字节（否则会把该文件 686 之前的行号顶偏，牵连历史证据页的裸锚点） |
| 7 | `deploy-sql-gate-{forms,probe,recovery}` 像 `npm run` 脚本 | 它们是 `.github/workflows/deploy-sql-gate.yml` 的 job 名，对应 `tests/unit/deploy-sql-gate-*.test.mjs` 三个单测 | 直接 `node --test` 跑三条 |
| 8 | 迁移计数"50 文件 + 1 保留 === 51" | `0052` 落盘后是 51 正向 / 50 rollback / `51 + 1 === 52` | 同步 `tests/unit/migration-reservations.test.mjs` 与 `README.md` 的当前状态段（旧快照保留不动） |
| 9 | 90-assert 里"就近插一条 SELECT 探针" | `deploy/postgres-cvm/sql/90-assert-least-privilege.sql:686` 之前**任何**行插入都会把 `docs/verification/gy-r28-deploy-sql-recovery-replay-20261021.md:119` 的裸锚点 `90-assert-least-privilege.sql:680` 顶红（那页是历史 psql 输出逐字引用，不能改数字） | 探针放在 `deploy/postgres-cvm/sql/90-assert-least-privilege.sql:686` 之后的 W54 段里，注释块 8 行换 8 行 ⇒ `verify-doc-anchors --strict` 保持绿 |
| 10 | 派单说"新增 SELECT 列后 `expected` 里 SELECT 列数要改" | 该文件不只有数字，还有逐列清单与一条"清单内必须有、清单外必须没有"的断言 | 改的是 `ARRAY[...]` 的具体列名（6 → 12），没有留下任何"只改数字"的写法 |

## 7 诚实边界

1. **不改可见性**：本片**没有**让任何内容从 hidden 变可见。端口的唯一用途是把已发布内容判成"待重评"（`RESCREEN_REQUIRED` + `visible: false`，该分支改前就在、本片一字未动）；`present` / `effectiveState` / `community` 侧的可见性判定一个字都没有改（`services/api/src/community/service.ts` 全文不引用端口，`T6` 结构化钉住）。
2. **历史 unknown 行仍 unknown**：迁移只回填 `decision = 'approved'` 的行、只填 `concluded_at`；`rule_version`/`model_version`/`prompt_version` 为 NULL 的存量行本片**不补造**。它们重启后会按与内存同一口径判成 `*_VERSION_UNKNOWN`（即判 stale）——这不是本片新造的判断，内存口径下同一条结论本来就是这个结果；但它确实意味着"重启后有些以前看起来正常的内容会变成待重评"，这是有意的方向（宁可判待重评，不可把旧版本结论当已审放行）。
3. **内存有评估时不问库**：同一进程里只要内存台账有该目标的结论，就完全按内存算，端口一次都不会被调用（`T2` 里"端口被问一次"的前提是 `tasks()` 为空）。⇒ **重启前的进程行为逐字节不变**，`tests/moderation/http-freshness.test.mjs` 等既有用例不受影响。
4. **拿不到事实就少判**：端口在缺表/缺列/权限不足/连接失败时返回空数组并记一次 warn。⇒ 库不可用的窗口里，重启后的过期识别仍然是关的。这是刻意的取舍（读面不 500、不凭"不知道"改可见性），不是遗漏。
5. **真库臂走 CI**：`tests/integration/*-pg.mjs`（含本片改过"末项版本"的三处）需要真 PG 与 `migrate.ts up`，**本机没跑**，一律以 CI 为准。本页所有读数的输入都是合成夹具。
6. **窗口期**：迁移 `0052` 与代码是同一次提交，但生产上"提交 → 迁移执行 → 进程重启"之间存在窗口。窗口内 `concluded_at` 还不存在时，端口的 SQL 会 42703 ⇒ 空数组 + 一次 warn ⇒ 行为等同改前（不会 500，也不会误判）。
