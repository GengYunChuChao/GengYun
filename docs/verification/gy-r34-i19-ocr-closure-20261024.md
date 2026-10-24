# R34 片 3 · OCR 三表注销闭集改走表级 DELETE（I19 / #10）

- 日期：2026-10-24（Asia/Shanghai）
- 分支：`feat/gy-r34-ocr-closure`｜base：`upstream/main` = `997e8e5f`（实测 `git rev-parse upstream/main`，与本片开工时 `HEAD` 同 SHA）
- 迁移：**零新迁移**（`0001..0034` 连续；`0035` 归片 2 占用中。本片只改授权脚本 + 断言脚本 + 应用侧注销模块 + 测试）

## 1. 用户批准的例外（唯一一处）

> 用户已在 2026-10-24 明确**批准本片走表级 `GRANT DELETE` 例外**（这是对「五表零 DELETE / 不许表级 DELETE」那条安全不变量的**唯一例外**）

- 出处：本片任务书转述的直接指令，2026-10-24。
- 边界（写死在脚本注释与断言里）：例外**仅** `public.ocr_jobs` / `public.ocr_records` 两张表；`public.media` 仍然不授 `DELETE`（媒体域走 `0035` 的窄函数）；`public.jobs` 与其它任何表都不新增表级 `DELETE`。

## 2. 为什么三表统一走表级 DELETE

- PostgreSQL **没有列级 DELETE**：`GRANT DELETE (col)` 不存在，`DELETE` 只能整表授予。
- 本片之前 `ocr_jobs` / `ocr_records` 只有列级 `SELECT/INSERT/UPDATE`（运行时删不掉自己主体的行），而 `ocr_idempotency` 早已是表级 `DELETE` —— 同一域两条路线。
- 于是 OCR 域注销闭环只有两条路：① SECURITY DEFINER 窄函数（识别/语音两域走的 `0034` 路线）；② 表级 `GRANT DELETE`。用户 2026-10-24 选②：三表压成一条路线，删了多少行由 `RETURNING` 直接给出，不用额外维护函数与 `REVOKE`。
- 口径澄清（避免被读成"整体放松"）：识别/语音域**继续**零表级 DELETE（`0034` 函数），`public.media` 继续不授 `DELETE`，`expected_42501=18` 与探针一字未动（见 §4）。

## 3. 授权面改动逐条

| 文件 | 位置 | 改动 |
| --- | --- | --- |
| `deploy/postgres-cvm/sql/20-login-roles.sql` | `:694` / `:695` | 新增 `GRANT DELETE ON public.ocr_jobs TO gengyun_api_runtime;` 与 `GRANT DELETE ON public.ocr_records TO gengyun_api_runtime;`，紧跟 `ocr_idempotency` 那条（`#region gy-r28-runtime-domain-grants` 内，按域成段） |
| 同上 | 段头注释（region 起于 `:533`） | 「DELETE 只给三张表」改为**五张**，并写明这两张是**用户批准的例外**、`public.media` 仍不授 |
| 同上 | `:705` 的 `\echo` | 清单补 `public.ocr_jobs` / `public.ocr_records`，并补「OCR 三表为 R34 片 3 起**由用户批准**的表级例外，替换此前的 SECURITY DEFINER 路线」 |
| `deploy/postgres-cvm/sql/90-assert-least-privilege.sql` | `expected` 的 `('ocr_jobs', …)` 记录末行 / `('ocr_records', …)` 记录末行 | `del` 标志 `false` → `true`（`('ocr_idempotency', …)` 本来就是 `true`，未动） |
| 同上 | `allow_table_dml` 白名单 `:1468` / `:1469` | 新增 `('public','ocr_jobs','DELETE')` 与 `('public','ocr_records','DELETE')` ⇒ 白名单 **18** 个三元组 |
| 同上 | 断言 7 `table_dml_allowlist` 前的论证注释 | 扩写成「OCR 三表统一走表级 DELETE（R34 片 3，用户批准的例外）」，删掉与新事实矛盾的单表论证；判定本体（白名单以外的任何表级写权限即 `RAISE`）**一字未改** |

- 成对性由单测钉死：`tests/unit/least-privilege-expected-parity.test.mjs` 新增「OCR 三表：`GRANT DELETE` ↔ `expected.del` ↔ `allow_table_dml` 三方一致」，并带 3 条反向变异（删 GRANT 行 / 把 `del` 改回 `false` / 抹掉白名单三元组，各自点名对应一面对红）。
- 白名单的反向读数：`allow_table_dml` 的 `DELETE` 只比 `GRANT DELETE` 多 `idempotency_keys` 一张（它由 `services/api/db/roles/auth_privacy.sql` 授给运行时，不在 `20-login-roles.sql` 里），`missingGrant / missingAllow / flagNotTrue` 三个差集皆空。

## 4. 探针面：18 条 / 9 个对象逐字未变

```powershell
Select-String -Path deploy\postgres-cvm\evidence\probe-runtime-grants.sql -Pattern 'ocr_jobs|ocr_records' -Encoding UTF8
git diff --name-only | Select-String -Pattern 'probe|workflows'      # ⇒ 空输出
Select-String -Path .github\workflows\deploy-sql-gate.yml -Pattern 'expected_42501' -Encoding UTF8
```

- 探针里 `ocr_jobs` / `ocr_records` 共 15 处命中：`:68-69` 是对象名数组，`:223-263` 全是**正例**（SELECT 12 列 / INSERT 12 列 / UPDATE 认领 / `SELECT … FOR UPDATE` / 记录 INSERT·SELECT·UPDATE），**没有这两张表的 `DELETE` 探针**，因此新增授权不会撞上任何「必须 42501」的禁止面。
- `expected_42501=18`（`deploy-sql-gate.yml:280`）未改；`node --test tests/unit/deploy-sql-gate-probe.test.mjs` = **7 pass / 0 fail**，其中 ⑥「`expected_42501` 必须等于从探针源码数出来的禁止面条数」通过 ⇒ 18 条 / 9 个对象逐字未变。
- `git diff --name-only` 不含 `deploy/postgres-cvm/evidence/` 与 `.github/workflows/` ⇒ 探针与 workflow 两个文件**逐字未变**（本片未新增、未修改任何禁止面）。

## 5. 应用侧模块：删序、行数口径、fail-closed

- 模块：`services/api/src/privacy/user-data-deletion.ts:155` 新增 `OCR_DELETION_MODULE = 'ocr'`；注入才追加（`ocrStore`），闭集 4 + 4 = **8 项**（`favorites/history/messages/conversations` + `community/recognitions/speech/ocr`）。
- 删序（同一事务，先子后父）：`ocr_records` → `ocr_jobs` → `ocr_idempotency`（两表之间没有互相外键，records 是 jobs 的产物，顺序按语义；台账按 `left(scope, char_length($1::text) + 1) = $1::text || chr(10)` 精确前缀清，与 `0034` 同一条判据）。
- 行数口径：`services/api/src/ocr/store-pg.ts:530` 的 `purgeOwnerRows` 用 `DELETE … RETURNING id` / `RETURNING scope` 的**真实行数**，⛔ 不用 `count(*)`、⛔ 不用"影响 0 行"冒充清完。证据串分列：`ocr:online-purged:<两表合计>`、`ocr:idempotency-purged:<n>`、`ocr:tables:ocr_records=<n>,ocr_jobs=<n>`（键序 = 删序，供审计按顺序读回）。
- fail-closed：存储缺原语 ⇒ 装配处的惰性端口调用即抛；42501 / 连接失败 ⇒ `withTransaction` 原样抛 ⇒ 协议层 `sanitizeErrorCode` 折叠成 `blocked` + `HANDLER_FAILED`（⛔ 不折成 `completed`、⛔ 不记 0 行）。单测 `tests/unit/user-data-deletion-ocr.test.mjs` 用「缺原语的 store」反向控制覆盖这条路径（**4 pass / 0 fail**）。
- 结构护栏未破：`app.ts` 的 `registerOcrRoutes(app, config, …)` 装配行仍是 5 键、仍是位置参数传池；`app.ts` 对 `ocr/provider`、`ocr/store`、`ocr/media`、`ocr/reference` 四个子串的原文扫描仍全为 `False`（`tests/integration/ocr-http.mjs` 的判据）。

## 6. 门禁读数

| 门禁 | 读数 |
| --- | --- |
| `node tools/verify-migrations-unique.mjs --strict` | EXIT 0（零新迁移） |
| `node --test tests/unit/deploy-sql-gate-probe.test.mjs` | 7 pass / 0 fail |
| `node --test tests/unit/deploy-sql-gate-forms.test.mjs` | 10 pass / 0 fail |
| `node --test tests/unit/least-privilege-expected-parity.test.mjs` | 7 pass / 0 fail（含新增三方一致 + 3 条反向变异） |
| `node --test tests/unit/deletion-registration-coverage.test.mjs` | 6 pass / 0 fail（闭集 8 项、覆盖映射加 `ocr`） |
| `node --test tests/unit/sql-column-coverage.test.mjs` | 17 pass / 0 fail（读数按实测重钉，旧值→新值见下） |
| `node --test tests/unit/roles-file-disposition.test.mjs` | 11 pass / 0 fail |
| `node --test tests/unit/ci-integration-chain-structure.test.mjs` | 7 pass / 0 fail |
| `node --test tests/unit/doc-anchors-guard.test.mjs` | 10 pass / 0 fail |
| `node tools/verify-doc-anchors.mjs --strict` | EXIT 0（基线外新增 0 条） |
| `node tools/verify-contract-status.mjs` | EXIT 0 |
| `node --test tests/unit/user-data-deletion-ocr.test.mjs` | 4 pass / 0 fail（本片新增） |
| `node --check` 改过的 `.ts`/`.mjs` | 全部 EXIT 0（app / ocr·store / ocr·store-pg / ocr·service / user-data-deletion / 三个测试） |
| `git diff --check` | 无输出 |

- `sql-column-coverage` 读数（旧值 → 新值，本片新增 3 条整表 `DELETE` 与两个接收口）：`sqlLiterals` 159 → 162、`statements.DELETE` 29 → 32、`returningClauses` 62 → 65、`columnRequirements` 1241 → 1247、`perFile.ocr` 16 → 19；`referencedTables` 25 / `onConflictClauses` 17 / `selectStar` 0 / `opaqueExpressions` 2 不变。扩展面：`sqlLiterals` 268 → 271、`DELETE` 36 → 39、`returningClauses` 82 → 85、`columnRequirements` 1720 → 1726、`coveredRequirements` 1666 → 1672、`perFile['ocr']` 16 → 19。
- 文档行号漂移：本片改了 `20-login-roles.sql` / `90-assert` / `ocr/*.ts` / `user-data-deletion.ts` / `least-privilege-expected-parity.test.mjs` 的行数，6 份历史证据页里指向这些文件的 7 条 `path:line` 引用按**内容**（不是凑容差）重指到新行号，`tools/doc-anchors-baseline.json` **未**修改、未新增任何锚点。

## 7. 未取得项

- **真库臂未跑**：本树无 `node_modules`（`Test-Path node_modules` = `False`）也未起 PostgreSQL，`deploy-sql-gate` / `90-assert` / 探针的 42501 实测靠 CI；本页只给静态面与单测面读数。
- **桶 / 对象存储无涉**：OCR 域没有对象副本（`ocr_jobs` / `ocr_records` 只存引用，媒体实体在 `public.media`，其清理走既有 `0035` 窄函数），本片未触碰、也未验证对象存储侧。
- **历史数据未清**：本片只保证"运行时删得掉 + 删得准"，存量数据的行数盘点、一次性清理与回填**未做**，也未跑过任何真实账号的注销。
- **备份副本仍未接线**：`ocr` 的 `backup_state` 如实为 `pending`（备份副本只覆盖四域，与本片之前的识别/语音一致）。
