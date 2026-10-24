# R34 片 3 · OCR 三表注销闭集改走表级 DELETE（I19 / #10）

- 日期：2026-10-24（Asia/Shanghai）
- 分支：`feat/gy-r34-ocr-closure`｜base：`upstream/main` 已并入=`d4a47206`（首轮实现时的 base 是 `997e8e5f`；两者均由 `git rev-parse upstream/main` 实测）
- 迁移：**零新迁移**（`0001..0034` 连续；`0035` 归片 2 占用中。本片只改授权脚本 + 断言脚本 + 探针 + 应用侧注销模块 + 测试）
- 四轮：首轮落地授权面/断言面/注销模块；第二轮按指挥裁决补**正向探针**与**闭集防缩回断言**（见 §8）；第三轮按对抗审查驳回把**既有**闭集枚举与夹具迁移集补上第 8 域（见 §9）；第四轮把 `upstream/main` 并入并按**合并树实测**重钉列覆盖常量（见 §10，含本页行号统一改按合并树口径）

## 1. 用户批准的例外（唯一一处）

> 用户于 2026-10-24 在指挥会话中明确批准：把 `ocr_jobs` / `ocr_records` 的表级 `DELETE` 作为本仓**唯一例外**（`public.media` 表级 `DELETE` 仍禁止）。批示记录见 `.pg17/ruling-r34-user-decisions-20261024.md` §U-2；**仓内无第三方书面凭证**。

- 该批示文件在**指挥侧工作区**（`E:\GengYunCommander\.pg17\…`，`Test-Path` 在工作树内为 `False`）⇒ 它是**仓外记录**，本页只引用、不入库。⛔ 边界：例外**仅** `public.ocr_jobs` / `public.ocr_records` 两张表；`public.media` 仍不授 `DELETE`（媒体域走 `0035` 的窄函数）；`public.jobs` 与其它任何表都不新增表级 `DELETE`。`20-login-roles.sql` 的两处注释（`:527` 段头、`:693` R34 段）按同一口径写，均注明「仓内无第三方书面凭证」。

## 2. 为什么三表统一走表级 DELETE

- PostgreSQL **没有列级 DELETE**：`GRANT DELETE (col)` 不存在，`DELETE` 只能整表授予。
- 本片之前 `ocr_jobs` / `ocr_records` 只有列级 `SELECT/INSERT/UPDATE`（运行时删不掉自己主体的行），而 `ocr_idempotency` 早已是表级 `DELETE` —— 同一域两条路线。
- 两条路：① `SECURITY DEFINER` 窄函数（识别/语音两域走的 `0034` 路线）；② 表级 `GRANT DELETE`。用户 2026-10-24 选②：三表压成一条路线，删了多少行由 `RETURNING` 直接给出，不必再维护函数与 `REVOKE`。
- 口径澄清：识别/语音域**继续**零表级 DELETE（`0034` 函数），`public.media` 继续不授 `DELETE`，禁止面 `expected_42501=18` 一字未动（见 §4）。

## 3. 授权面改动逐条

| 文件 | 位置 | 改动 |
| --- | --- | --- |
| `deploy/postgres-cvm/sql/20-login-roles.sql` | `:701` / `:702` | 新增 `GRANT DELETE ON public.ocr_jobs TO gengyun_api_runtime;` 与 `… ocr_records …`，紧跟 `ocr_idempotency`（`:689`）那条，同 region（`:536`）同注释块 |
| 同上 | 段头注释 `:517-530` | 「DELETE 只给三张表」→ **五张**，并写明例外出处（§1 原句口径）与「`public.media` 仍不授」 |
| 同上 | `:712` 的 `\echo` | 清单补两张表 + 「OCR 三表为 R34 片 3 起**由用户批准**的表级例外，替换此前的 SECURITY DEFINER 路线」 |
| `deploy/postgres-cvm/sql/90-assert-least-privilege.sql` | `('ocr_jobs', …)` `:1239-1245`、`('ocr_records', …)` `:1246-1253` | `del` 标志 `false` → `true`（`('ocr_idempotency', …)` 本来 `true`，未动） |
| 同上 | `allow_table_dml` `:1480` / `:1481` | 新增两个三元组 ⇒ 白名单 **18** 个三元组（历史递进注释 13/14/15/16 保留，末条写 18） |
| 同上 | 断言 7 前的论证注释 | 扩写成「OCR 三表统一走表级 DELETE（R34 片 3，用户批准的例外）」；判定本体（`pg_class` × 六种写权限 `NOT EXISTS allow_table_dml`）**一字未改**，90/91/92/93 的函数面 grantee 集合关系一字未改 |

- 成对性由单测钉死：`tests/unit/least-privilege-expected-parity.test.mjs` 的「三方一致」用例 + 3 条反向变异（删 GRANT / `del` 改回 `false` / 抹掉三元组，各自点名一面对红）。
- 白名单反向读数：`allow_table_dml` 的 `DELETE` 只比 `GRANT DELETE` 多 `idempotency_keys` 一张（它由 `services/api/db/roles/auth_privacy.sql` 授予），`missingGrant / missingAllow / flagNotTrue` 三差集皆空。

## 4. 探针面：禁止面 18 条 / 9 个对象逐字未变，另补 2 条正向探针

```powershell
Select-String -Path deploy\postgres-cvm\evidence\probe-runtime-grants.sql -Pattern 'DELETE FROM public\.' -Encoding UTF8
Select-String -Path .github\workflows\deploy-sql-gate.yml -Pattern 'expected_42501' -Encoding UTF8   # :280 expected_42501=18
git diff --name-only HEAD~1 HEAD                                                                  # 无 .github/workflows/
```

- **禁止面一条未增**：`:538-540`（`recognition_jobs/records/selections`）、`:615-616`（`speech_jobs`、`transcriptions`）共 5 张表的 `DELETE … WHERE false RETURNING id;` 原样；`expected_42501=18`（`deploy-sql-gate.yml:280`）未改。
- **新增的是正向面**（第二轮裁决 ②）：`:296` `DELETE FROM public.ocr_records WHERE false;`、`:299` `DELETE FROM public.ocr_jobs WHERE false;` —— 语义「允许执行、零行删除」，紧跟 `ocr_idempotency` 的 `:293`，沿用该文件的 `\echo '-- [<表>] …'` 分节话术。两条**不带 `RETURNING`**、表名不在 `DENY_DELETE_TABLES` 里 ⇒ `tests/unit/deploy-sql-gate-probe.test.mjs` ⑥ 的 `countDenyStatements` 读数不变（仍 5 + 13 = 18）。
- 同步 `90-assert`：`:147` / `:152` 两个 SAVEPOINT 块内联同形探针 + `\set r28_probe_del_ocr_records :ERROR`（`:148`）/ `_ocr_jobs`（`:153`），断言 45 复述于 `:2901` / `:2902`，注释与报文由「四张白名单表」改为「六张」。
- `deploy-sql-gate.yml` 的 markers 清单（`:237-255`，**17** 条成员）与 `tests/unit/deploy-sql-gate-probe.test.mjs` 都不含 OCR 的 `\echo` 原文 ⇒ **已核，零关联**（核验命令：上面第一、二条 `Select-String` 的命中行 + `node --test tests/unit/runtime-delete-probe-parity.test.mjs`）。`expected_42501=18`（`:280`）不变，所以新增两条正向探针**不会**改变该 workflow 的任何读数；`:310` 只打印 `${#markers[@]}`。
- 防漂移闸门 `tests/unit/runtime-delete-probe-parity.test.mjs`（新增，**6 pass / 0 fail**）：正向 13 张、禁止面 5 张、并集 18、互斥、每条都带 `WHERE false`、正向 ⊆ 实授 16 张、实授 − 正向 = `media_derivatives / media_object_cleanup / messages`（本片之前的既有缺口，显式登记 `GRANTED_WITHOUT_PROBE`）+ 3 条反向变异自证。

## 5. 应用侧模块：删序、行数口径、fail-closed

- 模块：`services/api/src/privacy/user-data-deletion.ts` 的 `OCR_DELETION_MODULE = 'ocr'`；注入才追加，闭集 4 + 4 = **8 项**。
- 删序（同一事务，先子后父）：`ocr_records` → `ocr_jobs` → `ocr_idempotency`（两表之间无互相外键，records 是 jobs 的产物；台账按 `left(scope, char_length($1::text) + 1) = $1::text || chr(10)` 精确前缀清，与 `0034` 同一判据）。
- 行数口径：`services/api/src/ocr/store-pg.ts` 的 `purgeOwnerRows` 用 `DELETE … RETURNING id` / `RETURNING scope` 的**真实行数**，⛔ 不用 `count(*)`、⛔ 不用「影响 0 行」冒充清完。证据串：`ocr:online-purged:<两表合计>`、`ocr:idempotency-purged:<n>`、`ocr:tables:ocr_records=<n>,ocr_jobs=<n>`（键序 = 删序）。
- fail-closed：缺原语 ⇒ 装配处惰性端口调用即抛；42501 / 连接失败 ⇒ `withTransaction` 原样抛 ⇒ 协议层 `sanitizeErrorCode` 折叠成 `blocked` + `HANDLER_FAILED`（⛔ 不折成 `completed`、⛔ 不记 0 行）。反向控制见 `tests/unit/user-data-deletion-ocr.test.mjs`。
- 结构护栏未破：`app.ts` 的 `registerOcrRoutes(app, config, …)` 装配行仍 5 键、仍位置参数传池；`app.ts` 对 `ocr/provider`、`ocr/store`、`ocr/media`、`ocr/reference` 的原文扫描仍全 `False`。

## 6. 门禁读数

| 门禁 | 读数 |
| --- | --- |
| `node tools/verify-migrations-unique.mjs --strict` | EXIT 0 |
| `node --test tests/unit/deploy-sql-gate-probe.test.mjs` | 7 pass / 0 fail |
| `node --test tests/unit/deploy-sql-gate-forms.test.mjs` | 10 pass / 0 fail |
| `node --test tests/unit/least-privilege-expected-parity.test.mjs` | 7 pass / 0 fail |
| `node --test tests/unit/deletion-registration-coverage.test.mjs` | 7 pass / 0 fail（含新增「防缩回闸门」） |
| `node --test tests/unit/runtime-delete-probe-parity.test.mjs` | 6 pass / 0 fail（第二轮新增） |
| `node --test tests/unit/sql-column-coverage.test.mjs` | 17 pass / 0 fail（读数按实测重钉） |
| `node --test tests/unit/roles-file-disposition.test.mjs` | 11 pass / 0 fail |
| `node --test tests/unit/ci-integration-chain-structure.test.mjs` | 7 pass / 0 fail |
| `node --test tests/unit/doc-anchors-guard.test.mjs` | 10 pass / 0 fail |
| `node tools/verify-doc-anchors.mjs --strict` | EXIT 0（基线外新增 0 条） |
| `node tools/verify-contract-status.mjs` | EXIT 0 |
| `node --test tests/unit/user-data-deletion-ocr.test.mjs` | 4 pass / 0 fail |
| **`npm run test:unit`（CI 入口，`engineering-shell.yml:58`，5 个 glob）** | **`# tests 4429` / `# pass 4424` / `# fail 2` / `# skipped 1` / `# todo 2`**（合并树；两条 `todo` 是 I11 音频格式缺口。2 条 fail 全部来自上游新增的 `tests/unit/miniprogram-qa-text-question.test.mjs` —— **既有 flaky，不是本片回归**：在**纯净** `d4a47206` 工作树上同一文件三次独立跑得 `29/1`、`25/5`、`26/4`（30 个用例），且该文件读的两个 blob（`miniprogram/pages/qa/qa.js` = `de0b1822…`、`miniprogram/utils/qa-api.js` = `3460147c…`）在两侧**逐字节相同**；本片只让计数从 4381 长到 4429，未触碰该文件） |
| `node --test tests/unit/favorites-history-deletion-registration.test.mjs` | 2 pass / 0 fail（本轮返修：既有闭集补第 8 域） |
| `node --test tests/unit/gy-i22-secmatrix.test.mjs` | 6 pass / 0 fail（本轮返修：C4 注销闭集八项） |
| `node tests/integration/account-deletion-http.mjs` | PASS，EXIT 0（闭集含 `ocr`） |
| `node tests/integration/recognitions-speech-purge-pg.mjs` | **PASS 10 条 / EXIT 0**（真 PG 17.11 临时集群，端口自选 55700–55999；见 §7 与 §10） |
| `node --check` 改过的 `.ts`/`.mjs` | 全部 EXIT 0 |
| `git diff --check` | 无输出 |
| `git merge-tree --write-tree upstream/main HEAD` | EXIT 0 |

- `sql-column-coverage` 读数（旧值 → 新值）：`sqlLiterals` 159 → 162、`statements.DELETE` 29 → 32、`returningClauses` 62 → 65、`columnRequirements` 1241 → 1247、`perFile.ocr` 16 → 19；`referencedTables` 25 / `onConflictClauses` 17 / `selectStar` 0 / `opaqueExpressions` 2 不变。扩展面：268 → 271、36 → 39、82 → 85、1720 → 1726、`coveredRequirements` 1666 → 1672、`perFile['ocr']` 16 → 19。
- 文档行号漂移：本片改了 6 个被引用文件的行数，6 份历史证据页里 7 条 `path:line` 按**内容**（不是凑 ±2 容差）重指；`tools/doc-anchors-baseline.json` 未改、未新增锚点。

## 7. 未取得项

- **真 PG 臂已跑，但只覆盖「授权面在位时的清空闭环」**：本树已 `npm ci --no-audit --no-fund`（`node_modules` 就位），`tests/integration/recognitions-speech-purge-pg.mjs` 用 `GY_PG_BIN` 起临时集群实测 **PASS 10 条 / EXIT 0**（含运行时角色 `ocr_jobs` / `ocr_records` `DELETE=true`、五张禁止面逐条 42501、`ocr` 证据串逐字、回执三域 `completed`）。仍未跑的是 `deploy-sql-gate.yml` 那套**整脚本 psql** 闸门（`90-assert` + `probe-runtime-grants.sql` 一次性在 psql 里跑、断言 18 条 42501）⇒ 该面仍靠 CI。⛔ 不用 `node --check` 或单测冒充真库证据。
- **桶 / 对象存储无涉**：OCR 域没有对象副本（两表只存引用，媒体实体在 `public.media`，清理走既有 `0035` 窄函数），未触碰、未验证。
- **历史数据未清**：本片只保证「运行时删得掉 + 删得准」，存量盘点、一次性清理与回填未做，也未跑过真实账号注销。
- **备份副本仍未接线**：`ocr` 的 `backup_state` 如实为 `pending`（与识别/语音一致）。

## 8. 本轮的三个裁决点与实现

1. **例外凭证不模糊、不伪造**（裁决 ①）：本页 §1 与 `20-login-roles.sql` 的 `:527` / `:693` 统一改成「用户于 2026-10-24 在指挥会话中明确批准…批示记录见 `.pg17/ruling-r34-user-decisions-20261024.md` §U-2；**仓内无第三方书面凭证**」，并注明该文件在指挥侧工作区、不入库。守住它的闸门：`tests/unit/doc-anchors-guard.test.mjs`（AGENTS 锚点）+ 本页与脚本注释逐句同源。核验命令与读数：`Select-String -Path deploy\postgres-cvm\sql\20-login-roles.sql -Pattern '安全评审'` ⇒ 仅两处，`:298` 是既有的反例说明（「若把 DELETE 授出去…那要走安全评审，不是发权限的顺手活」）、`:694` 是本片的 ⛔ 禁止表述（「不得描述成…已过安全评审」）——**没有任何一处声称已通过评审**。
2. **给新授的两条 DELETE 补正向探针**（裁决 ②）：探针 `:296` / `:299` 两条 `DELETE … WHERE false;`、`90-assert` `:147` / `:152` 两个 SAVEPOINT 块 + `\set` + 断言 45 复述；`expected_42501` **仍 18**、禁止面一条未增、workflow 与 `deploy-sql-gate-probe.test.mjs` **未改**（已核零关联，见 §4）。守住它的闸门：新增 `tests/unit/runtime-delete-probe-parity.test.mjs`（6 条，含 3 条反向变异：删正探针 / 改成非零行 DELETE / 删 GRANT 行）。
3. **闭集不许静默缩回**（裁决 ③）：`tests/unit/deletion-registration-coverage.test.mjs` 新增「生产生效闭集恰 8 项且含 `ocr`」——运行时腿真调 `createUserDataDeletion`（全注入 ⇒ 逐字 8 项；缺 `ocrStore` ⇒ 逐字 7 项且不含 `ocr`）+ 静态腿（`app.ts` 恰注入一次 `ocrStore: ocrDeletionStore,`、端口缺原语必须抛）。测试注释写明漏注入的后果：证据串少 `ocr:online-purged` / `ocr:idempotency-purged` / `ocr:tables:` 三段，`deletion_module_evidence` 少一行 `module='ocr'`（清没清变成不可核）。抓不住的部分也写明：`deletion-modules.mjs` 将来加白名单后的形状校验不归它。
4. **与裁决记录 §U-7 的差异（如实登记）**：§U-7 假设探针里已有这两张表的**禁止面** DELETE、要求 `expected_42501` 由 18 改 16；实测这两张表从未有 DELETE 语句 ⇒ 按 m00536 的口头裁决改为「补**正向**探针、`expected_42501` 保持 18」。同理，裁决措辞里的「十张表」在实测下不成立：DELETE 探针覆盖 **18 个对象**（13 正向 + 5 禁止），授权面 **16 张**，另 3 张已授权但无 DELETE 探针 —— 三者都写死在单测里，不再用模糊计数。

## 9. 返修：第 8 个域把既有闭集顶红（对抗审查阻塞项）

- 三处红点都不是新代码错，而是**既有测试写死的 7 项 / 6 项闭集**没跟上第 8 域：① `tests/unit/favorites-history-deletion-registration.test.mjs` 的闭集 `deepEqual` 补 `OCR_DELETION_MODULE` / `'ocr'`，并同步 `removed` 与 `audit.map(userId)` 到 8 项；② 同文件「再次清空」用例 `online_state` 由 `completed` 变 `blocked` —— 根因是 `tests/unit/favorites-history-fixtures.mjs` 的 `PG_MIGRATIONS_WITH_DELETION_DOMAINS` 不含 `0024_ocr_persistence`，OCR 表不存在 ⇒ `requireTables()` 判 missing ⇒ fail-closed 折叠 `blocked`（**修的是夹具迁移集，不是把断言放宽**）；③ `tests/unit/gy-i22-secmatrix.test.mjs` C4 闭集补 `'ocr'`。
- 同族点位（真库臂一开跑就会红）：`tests/integration/account-deletion-http.mjs` 闭集补 `'ocr'`；`tests/integration/recognitions-speech-purge-pg.mjs` 注入 `ocrDeletionStore` + 闭集 7 项 + 证据串逐字 `ocr:online-purged:0;ocr:idempotency-purged:0;ocr:tables:ocr_records=0,ocr_jobs=0` + `public.ocr_jobs` / `public.ocr_records` 按主体行数为 0 + `[7]` 重放 + `[8]` 回执三域 `completed`。
- 反向自证（改后**逐字节还原**，两次 SHA256 前后一致）：删掉夹具里的 `'0024_ocr_persistence'` ⇒ 该文件 **2 fail**，失败点是 `removed` 缺 `ocr` 键（`actual {…, speech: 0}` vs `expected {…, speech: 0, ocr: 0}`）⇒ 证明「表缺 ⇒ 折叠 `blocked`、审计不记 `onlineRemoved`」这条 fail-closed 由该夹具管着；从闭集数组删掉 `'ocr'` ⇒ **1 fail**，diff 逐字 `+ 'ocr'`（`actual` 8 项 vs `expected` 7 项）。
- 文档行锚点按**内容**重指（`verify-doc-anchors --strict` 改前改后均 EXIT 0、基线外新增 0；⛔ 未动 `tools/doc-anchors-baseline.json`）：`docs/verification/gy-r28-e6-closure-materials-20261021.md:120` 四条 → `:288` / `:290` / `:426` / `:498`；`docs/verification/gy-i16-favorites-pg-20261017.md:267` 的 `:282` → `:293`。审查给的 277 / 282 是**修复前**同一断言的位置（基线与本轮之前实测均为 284 / 289，`277` 现落在 `const requestId = String(request.id)` 上）⇒ 按当前内容取真值，核验命令：`Select-String -Path tests\unit\favorites-history-deletion-registration.test.mjs -Pattern '消息行必须真删|收藏台账残留 0 行'`。

## 10. 并入 `upstream/main` 并按合并树实测重钉

- 合并面：`upstream/main` 由 `997e8e5f` 前进到 **`d4a47206`**（含 PR #324、#533、#531、#530）。`git merge --no-ff upstream/main` 只有 **1 处冲突**：`tests/unit/sql-column-coverage.test.mjs`（双方各自重钉同一批读数常量，`UU`）；`20-login-roles.sql` / `90-assert` / 探针 / 角色文件 / 契约台账均自动合并。⛔ 未用 `-X ours/theirs`、未 amend、未 rebase。
- 冲突解法：**两侧增量都留**，常量按**合并树重新实测**再落盘（⛔ 不取任一侧旧值、⛔ 不相加）——
  - base 面：`sqlLiterals` **163**、`{INSERT 27, UPDATE 29, SELECT 75, DELETE 32}`、`returningClauses` **65**、`columnRequirements` **1247**（`storeFiles 8 / onConflict 17 / selectStar 0 / referencedTables 25 / opaque 2` 不变）；
  - 扩展 19 文件面：`sqlLiterals` **272**、`{INSERT 42, UPDATE 47, SELECT 144, DELETE 39}`、`returningClauses` **85**、`columnRequirements` **1726**、`coveredRequirements` **1672**；
  - `EXPECTED_PER_FILE`：`community` **43**（上游 +1）、`ocr` **19**（本片 +3），其余不变。
  - 「实测而非相加」的自证：把 base 的 `sqlLiterals` 写成 `999` ⇒ 报 `actual: 163, expected: 999`（EXIT 1）；把扩展块写成 `999` ⇒ `actual: 272, expected: 999`（EXIT 1）；还原后 **17 pass / 0 fail**。
- 上游带来的两处红，逐条判过：
  1. `tests/unit/least-privilege-external-manifest.test.mjs:110`（上游 #533 新增）断言「`allow_table_dml` 恰是 **16** 个三元组」，被本片两条 OCR 三元组顶红（实为 18）⇒ 改 16→18，并把 `public.ocr_jobs.DELETE` / `public.ocr_records.DELETE` 补进 `ALLOW_TABLE_DML_TRIPLES`（同族清单，**不是把断言放宽**；同文件「`external_manifest` 恰 16 张具名表」那条**未动**——它数的是另一张清单）。修后该文件 **3 pass / 0 fail**。
  2. `tests/unit/miniprogram-qa-text-question.test.mjs` 是**既有 flaky**（与本片无关）：纯净 `d4a47206` 树上三次独立跑 `29/1`、`25/5`、`26/4`（30 用例），本树同条件 `25/5`、`25/5`、`24/6`；该文件读的两个 blob 两侧逐字节相同 ⇒ 不修、不豁免、如实记账（§6 全量读数已注明）。
- 上游改动把一处历史文档锚点顶歪（`miniprogram/pages/identify/identify.js` 行号后移）：`docs/verification/gy-i09i10-recog-20261019.md` 的 `:1226` → **`:1282`**（`function ocrResultView` 现址）、`:1271` → **`:1328`**（`conflictLabels` 透传现址），按内容重指。⛔ 未改 `miniprogram/**` 任何源文件。
- **真库臂的授权面修正（本轮唯一的实现级发现）**：本臂原只抽识别/语音两段 + `0034` 的 EXECUTE 区，OCR 的表级 `DELETE` 与列级 `SELECT` 都不在切片里 ⇒ 首跑 `[4]` 红（`ocr` 证据串为 `""`，因为 `purgeOwnerRows` 先 42501、再折叠 `blocked`）。改为 `ocrGrantBlock()`：在 `gy-r28-runtime-domain-grants` 区内按**语句**抽 `public.ocr_*` 的 GRANT，断言「三张表各一条 SELECT / INSERT / UPDATE / DELETE，且每条只授 `gengyun_api_runtime`」，另加 `[1]` 正读 `ocr_jobs` / `ocr_records` `DELETE=true`。修后 **PASS 10 / EXIT 0**。
  - 这条修法本身是个证据：`DELETE … WHERE owner_user_id RETURNING id` 需要 `WHERE`/`RETURNING` 列的 **SELECT** 权 —— 只授表级 `DELETE` 仍会 `42501`，而单测（PGlite 走属主）抓不到，只有真库臂 + 生产身份能抓。
