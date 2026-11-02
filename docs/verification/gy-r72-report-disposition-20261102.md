# GY-R72 举报处置接 HTTP：`POST /admin/reports/{id}/disposition` ⇒ `advanceReport` · 证据页

- 日期：2026-11-02
- 分支 / 基线：`feat/gy-r72-report-disposition`；本片父提交 `52d1e90d`（rebase 后，= `origin/main`），提交 `f96cb2fa`。号段 `git rev-parse` 实取：`52d1e90d` = `52d1e90d1ab25baa467229b4acff24eb08d929c4`、`f96cb2fa` = `f96cb2fada56a7c3e7d3cb241ff9e6d571bda1df`；rebase 前的两个中间态为 `987da21a` = `987da21ae15f8446b5741f4972cc7b8767517d13` 与 `68cc44cf` = `68cc44cf359100f91e77cf7eac21a406aa3ffdf9`（原始基线）。
- 本片只碰：`packages/contracts/openapi.json`（+126 行）、`packages/contracts/operations.json`（+7 行）、`services/api/src/admin/ops/reports.ts`（新，126 行）、`services/api/src/routes/admin-reports.ts`（新，85 行）、`services/api/src/routes/admin.ts`（2 行，净 0）、`services/api/src/admin/ops/service.ts`（9 行，净 0）、`services/api/src/admin/ops/accounts-only.ts`（+2 行）、`services/api/src/app.ts`（4 行，净 0）、`tests/unit/community-report-disposition-http.test.mjs`（新，366 行）、6 个既有钉线文件与 `tests/integration/community-filter-pg.mjs`、3 份生成物（工具重算）、3 页取证页的行号平移、`tools/doc-anchors-orphan-baseline.json`（手术式删 3 条 + 1 条 accept 留痕）、`tools/doc-anchors-baseline.json`（2 条 reference 平移）、本页（新）。
- **没有**碰：任何迁移（`services/api/db/migrations/**` 零 diff）、`deploy/**`、`packages/contracts/states.json`、`services/api/src/contract.ts`（无新错误码）、`services/api/src/community/**`（`report-state.ts` / `store.ts` / `store-pg.ts` / `service.ts` 逐字未改，`git diff --numstat` 空）、`tools/doc-anchors-anchor-count-baseline.json`、`tools/doc-anchors-symbol-baseline.json`、`tests/unit/doc-anchor-relocations.json`、`apps/admin/src/lib/review-state.mjs`。

## 0 结论先说（只列读数）

1. 契约多一条 operation：`advanceReport`，`POST /api/v1/admin/reports/:id/disposition`，scope 沿用既有 `sources:write`，**零新 scope / 零新错误码 / 零迁移**。
2. 版本前置条件走 **body 的 `expected_revision`**，不走 `If-Match`；契约如实声明 `x-version-required: false`，因此不声明 `428`（理由链见 §2.2）。
3. 状态机语义一行未改：转移表仍以 `services/api/src/community/report-state.ts:84` 的 `planReportTransition` 为唯一权威；两条非法/冲突路径都折叠成 `409 REVISION_CONFLICT`（409 闭集里没有 `STATE_CONFLICT`）。
4. 新钉线 7/7 通过（T1–T7，§4 原文照抄）；四条负控制里只有「整道门清空」和「去版本校验」能让它们红，「只去路由层 scope」**仍 7/7 绿**——服务层二次判权，属纵深防御（§5）。
5. 热文件净 0 行：`app.ts` 4/4、`routes/admin.ts` 2/2、`admin/ops/service.ts` 9/9、`admin/ops/community-posts.ts` 零 diff ⇒ `docs/**` 里对它们的 `path:line` 引用一格未动。
6. 本页不声称「全链完成」「已验收」：不落审计行、不区分 `closed` 一值两义、不建管理台界面、真库臂未在本机执行（§8、§9）。

## 1 缺陷：实现已在，缺的只是 HTTP 面

| # | 现场 | 读数 |
| --- | --- | --- |
| 1 | 处置写路径早已实现 | `services/api/src/community/service.ts:1677` 起是 `async advanceReport(reportId: unknown, input: unknown): Promise<Report>`：`requireUuidParam` → `validateReportDispositionInput` → `store.getReport` → `planReportTransition` → `store.commitReportIfCurrent` → `projectReport` |
| 2 | 状态机是纯函数、且是唯一权威 | `services/api/src/community/report-state.ts:84` `planReportTransition(current, action)`；`REPORT_STATES = ['received','isolated','closed']`、`REPORT_ACTIONS = ['triage','resolve','reject']` |
| 3 | 真库 CAS 已在 | `commitReportIfCurrent(id, expected, patch)` 以 `{revision, state}` 双条件做 CAS；内存实现与 PG 实现同形，失败原因 `REVISION_CHANGED` / `STATE_CHANGED` 由 `services/api/src/community/service.ts` 的 `commitRefusal` 折成 409 |
| 4 | 但没有任何 HTTP 路由指向它 | 改前 `packages/contracts/openapi.json` 的 `/reports` 只有 `post`、`/reports/{id}` 只有 `get`；`services/api/src/routes/admin.ts` 的 46 个 operationId 里没有举报处置 ⇒ 外部无法调用，`tests/integration/community-filter-pg.mjs` 里「四条候选推进路径全 404」就是这条缺口的登记 |
| 5 | ⇒ 缺口性质 | **不是能力缺失，是接线缺失**：契约、路由、operations 台账、`ADMIN_HTTP_OPERATION_IDS`、服务装配五处都没有这条 op；本片补齐这五处 |

## 2 op 形状与理由

### 2.1 形状（逐项）

- 方法 / 路径：`POST /api/v1/admin/reports/:id/disposition`；`operationId: advanceReport`；`x-task: GY-R72`。
- 两侧登记：服务侧 `OPS_OPERATION_IDS` 尾部追加 `'advanceReport'`（既有 18 项下标一格不动）、`OPS_SCOPES` 增加 `advanceReport: 'sources:write'`（`services/api/src/admin/ops/service.ts:416` 的对象首行，净 0 行）；HTTP 侧 `ADMIN_HTTP_OPERATION_IDS` 追加同一 id，文件头说明同步为 47 个（`services/api/src/routes/admin.ts:4`）。
- 守卫与同类写 op 完全同形：`preHandler: [guards.requireAdmin, guards.requireScope(OPS_SCOPES.advanceReport)]`，schema 校验 path 参数为 uuid（`services/api/src/routes/admin-reports.ts:73` 是注册函数，路径字面量在该文件第 76 行）。
- 请求体：`{ action, expected_revision }`，`action` 闭集 `triage|resolve|reject`，`expected_revision` 为 ≥1 的整数，未知字段一律 400（口径在 `services/api/src/community/validate.ts` 的 `validateReportDispositionInput`，本片未改）。
- 成功响应：200 + `ReportEnvelope`（`data` 为处置后的 `Report`）+ 强 `ETag`（= 新 revision）+ `Cache-Control: no-store`。
- 错误面：`400 / 401 / 403 / 404 / 409 / 413 / 415 / 422 / 429 / 500 / 503 / 504`；**无 412、无 428**。
- 幂等：`Idempotency-Key` 必填（`runIdempotentWrite`）：缺键 400 `IDEMPOTENCY_KEY_REQUIRED`、同键异体 409 `IDEMPOTENCY_CONFLICT`、进行中 409 `REQUEST_IN_PROGRESS`。
- 装配：`services/api/src/app.ts:2398` 一行 `registerAdminReportRoutes(app, { guards, ops: adminOpsService })`；real 分支与 stub 分支各注入 `reportDisposition: communityService ?? undefined`。

### 2.2 为什么版本前置走 body，而不是 `If-Match`

同类写 op（`hidePost` / `approvePost` / `rejectPost`）都用 `If-Match` + 428。本 op 刻意不照做，理由是三条互相咬合的事实：

1. **签名冻结**：`advanceReport(reportId: unknown, input: unknown)` 的入参形状与返回类型在本片不许改（派单硬约束），而版本号已经在 body 的 `expected_revision` 里；从 header 再取一次会得到两个来源。
2. **校验器只认两个字段**：`validateReportDispositionInput` 对未知键一律 400，因此「多了 `If-Match`」不会被静默忽略，只会变成「同一语义两个入口、互不一致」。
3. **工具链强制连带声明**：`tools/validate_contracts.py` 规定 `x-version-required: true` ⇒ 必须声明 `If-Match` 必填 ⇒ 必须声明 `428`；反过来，声明了前置头就必须声明 428。既然版本前置实际在 body，契约就如实写 `x-version-required: false`，并且**不声明 `If-Match`、不声明 `428`**——宁可少一档语义，也不让契约写一件实现没做的事。既有先例：`createReport` 同样是 `version_required: false`。

因此本 op 的「版本前置头缺失」这一档不存在；`expected_revision` 缺失或非法是 `400 INVALID_REQUEST`（`details` 逐字段），版本不符是 `409 REVISION_CONFLICT`。

## 3 转移表与 409 折叠

| 当前 state | `triage` | `resolve` | `reject` |
| --- | --- | --- | --- |
| `received` | → `isolated` | → `closed` | → `closed` |
| `isolated` | 409（不接受该动作） | → `closed` | 409（不接受该动作） |
| `closed` | 409（已处置完毕） | 409（已处置完毕） | 409（已处置完毕） |

- 表本身在 `services/api/src/community/report-state.ts` 的 `TRANSITIONS`，本片**零改动**。
- 三种拒绝原因在 `planReportTransition` 里是 `UNKNOWN_ACTION` / `TERMINAL_STATE` / `ILLEGAL_TRANSITION`，社区服务把它们折叠为两句话术：终态 ⇒「举报已处置完毕，不可再次处置」，其余 ⇒「举报当前状态不接受该处置动作」；错误码统一 `409 REVISION_CONFLICT`（**409 闭集里没有 `STATE_CONFLICT`**，折叠是既有契约口径，不是本片新造的）。
- CAS 失配（`expected_revision` 与库内 revision 不一致，或 state 已变）由 `store.commitReportIfCurrent` 拒绝，同样是 `409 REVISION_CONFLICT`，话术「目标版本已变化，请刷新后重试」；**库内 `state` / `revision` 一字不变**（T3 断言）。

**产品语义登记（本片不改）**：`resolve.from = ['received','isolated']` 意味着「刚受理、还没隔离」的举报可以被直接判为 `closed`。这在实现上是**合法转移**，不是 bug，但语义上等价于「跳过隔离直接结案」。本片按仓库事实写测试（T2 用 `isolated + reject` 作为非法转移样本），该语义留给产品另批裁定。

## 4 T1–T7 读数（`node --test tests/unit/community-report-disposition-http.test.mjs`）

`tests 7 / pass 7 / fail 0`，exit 0。用例名与关键读数：

| 用例 | 断言要点 |
| --- | --- |
| T1 正控制：received → isolated（triage）⇒ 200、revision 恰好 +1、封套 data/meta 齐全且 data 是契约 Report | 200；`data` 字段集恰为 `id` / `reason_code` / `revision` / `state` / `target_ref`；`meta` 含 `request_id` / `contract_version` / `execution_mode`；`ETag: "2"`；`Cache-Control: no-store` |
| T2 非法转移：isolated + reject ⇒ 409 REVISION_CONFLICT（state 不接受该动作话术），库内一字未变 | 409 + 「举报当前状态不接受该处置动作」；举报行与目标帖快照 `deepEqual` 不变 |
| T3 版本失配：expected_revision 落后 ⇒ 409 REVISION_CONFLICT（目标版本已变化），库内 state/revision 一字未变 | 库内 revision 3、传 `expected_revision: 1` ⇒ 409；库内仍 3 |
| T4 终态单向门：closed 上再处置 ⇒ 409（已处置完毕话术），库内一字未变 | triage / resolve / reject 三动作全 409，库内不变 |
| T5 守卫：无会话 ⇒ 401；有 admin 但缺 sources:write ⇒ 403 SCOPE_DENIED；两种都零写入 | 401 `SESSION_REQUIRED`；403 `SCOPE_DENIED`；补上 `sources:write` 后同一请求 200（正向对照） |
| T6 零副作用钉：处置不写审计行、不动目标帖的可见性（行内读数逐字不变） | `app.adminOpsService.store.audit.list().length === 0`；目标帖 `deepEqual` 不变；举报行除 `state` / `revision` 外逐字不变 |
| T7 契约钉子：新 op 在 openapi/operations.json 里、500: Error500、action 闭集三值、expected_revision 必填 | path + `operationId` + `x-scope` + `x-version-required: false` + `responses["500"].$ref` + 无 428 + 无 `IfMatch` 参数 + body schema 的 `enum` / `minimum` / `required` / `additionalProperties: false`；operations.json 五字段齐全 |

既有域内套件同步通过：`community-report-disposition` 8/8、`community-report-state` 6/6（状态机语义未改，故一条断言都不需要改）。

## 5 负控制（每轮：改码 → 跑目标测试 → 还原 → 核 sha256）

| # | 改法 | 读数 | 还原核对 |
| --- | --- | --- | --- |
| NC1a | 只删路由层 `guards.requireScope(...)`，保留 `requireAdmin` | **7/7 仍绿** | 服务层 `advanceReportImpl` 里 `resolveContext(ctx, ADVANCE_REPORT_SCOPE)` 会二次判 scope ⇒ 纵深防御的正面证据，不是缺口 |
| NC1b | 整道门清空（`preHandler: []`） | `tests 7 / pass 1 / fail 6`，exit 1（T5 在红名单） | `services/api/src/routes/admin-reports.ts` 还原后 sha256 `467E77D4…A331` 逐字相同 |
| NC2 | 去版本校验：把 `{ revision: body.expected_revision, … }` 换成 `{ revision: current.revision, … }` | `tests 7 / pass 6 / fail 1`，**只有 T3 红** | `services/api/src/community/service.ts` 还原后 sha256 `7DD482C3…8792` 逐字相同 |
| NC3 | `commitReportIfCurrent` 换成无条件写：`community/store.ts` 里同一行版本比对共 **3 处**（内存实现与 PG 实现各一处、另一处为同形判据），只改第一处 ⇒ T3 仍绿（改错实现）；三处全改 ⇒ `tests 7 / pass 6 / fail 1`，**只有 T3 红** | 同上读法 | `services/api/src/community/store.ts` 还原后 sha256 `C161BA49…CF00` 逐字相同；`git diff --stat` 对 `services/api/src/community/` 为空 |

NC1a 这条特别记下来：**路由层 scope 缺一不致命，整道门缺才是缺口**。这也解释了为什么 T5 同时钉 401 与 403 两种拒绝。

## 6 平移账（`packages/contracts/openapi.json`）

`packages/contracts/openapi.json` 在本片是**只增不重排**：新 path 块插在原 `12005` 行之后（+104 行），新 schema 块插在原 `15711` 行之后（再 +22 行，累计 +126 行）。因此对 docs 里既有的行号引用，映射规则是：

| 旧行号 `old` | 新行号 |
| --- | --- |
| `old ≤ 12005` | 不变 |
| `12005 < old ≤ 15711` | `old + 104` |
| `old > 15711` | `old + 126` |

按该规则平移的每一处（旧值 → 新值）：

| 文件 | 位置 | 旧值 → 新值 |
| --- | --- | --- |
| `docs/architecture/state-contract.md` | 第 138 行 | 16033 → 16159 |
| `docs/architecture/state-contract.md` | 第 138 行（同段另一处） | 15989 → 16115 |
| `docs/verification/gy-r31-i11-audio-20261022.md` | 第 11 行 | 13081 → 13185 |
| `docs/verification/gy-r31-i11-audio-20261022.md` | 第 34 行（表格） | 13946 → 14050 |
| `docs/verification/gy-r31-i11-audio-20261022.md` | 第 34 行（表格另一处） | 12952 → 13056 |
| `docs/verification/gy-r31-i11-audio-20261022.md` | 第 150 行 | 13081 → 13185 |
| `docs/verification/gy-r67-docs-truth-20261027.md` | 第 156 行与第 428 行（同一断言） | 15993-15995 → 16119-16121 |
| `docs/verification/gy-r68-s4-recheck-20261028.md` | 第 119 行 | 14374 → 14478 |
| `tools/doc-anchors-baseline.json` | 第 1 条 reference | 13081 → 13185 |
| `tools/doc-anchors-baseline.json` | 第 2 条 reference | 14374 → 14478 |

`tools/doc-anchors-baseline.json` 的这两条是**同一条目内只改 reference 数字**（条目数仍 61、标签与 reason 未动，numstat 2/2）。改法只动数字，不改所指内容：改前这 4 处指的行都是纯括号行，改后仍指同一份内容在新位置上的行（`UploadInput.mime` 的 `audio/mpeg`、注销回执的 `third_party_state`、`AuditEvent` 字段表）。

### 6.1 「末尾追加 ⇒ 零位移」这条假设已被实测否证

曾尝试把这 126 行改成「新 path 追加到 `paths` 末尾 + 新 schema 追加到 `components.schemas` 末尾」，指望既有行号零位移。实测否证：

- base 顶层成员顺序与行号：`openapi`(2) / `info`(3) / `jsonSchemaDialect`(8) / `servers`(9) / `security`(15) / **`paths`(20–12308)** / **`components`(12309–19761)** / `x-error-status-map`(19762) / `x-contract-status`(19818) / `x-proposal-revision`(19819)。
- ⇒ `paths` **不是**最后一个顶层成员；任何进入 `paths` 的新成员都会把 `components` 整块往下推。`components.schemas` 的收口在原 19646 行，其后紧接 `components.responses`（19647–19761），所以「追加 schema」也照样推动 EOF 侧。
- 真搬到末尾跑过一次：文件仍是 19946 行、`JSON.parse` 通过、键集与内容逐字未变，但逐行与 base 比对**第一个不同的既有行是 12307 行**（多一个逗号），其后全部错位 104 行。例：第 13081 行 base 是 `          }`，搬完后变成 `        "properties": {`。
- ⇒ 该形状换来的只是「换一批数字要平移」，并不产生零位移；已回退，保留只增不重排的版本。

## 7 指针一致性自检（`packages/contracts/openapi.json` 的 `path:line` 引用）

`git grep -n -o -E 'openapi\.json:[0-9]+(-[0-9]+)?' -- docs` 共 **64 条**引用，分布：

| 类 | 条数 | 说明 |
| --- | --- | --- |
| 指向真实内容行的活指针 | 56 | 平移后仍指同一 operation / 同一字段，逐条按 §6 规则核对 |
| 指向括号行、且已在册登记为 SUSPECT | 4 | `gy-r31-i11-audio` 的两处 → 13185、`gy-r31-i15-s1-s6` 的第 30 行 → 6541（base 既有）、`gy-r68-s4-recheck` 的第 119 行 → 14478 |
| 区间型引用（首行为括号，按区间口径判，不计入 SUSPECT） | 4 | `gy-i18-admin-ui-accounts-readonly` 第 36 行 11058-11065、`gy-r31-i15-s1-s6` 第 31 行 13907-13943、`gy-r67-audit-read-shape` 第 47 行 15723-15732、`gy-r68-s4-recheck` 第 81 行 1474 |
| 非活指针（代码块日志原文 / 历史改动表里的行号） | **0** | 无 |

顶层 `x-*` 三个成员（`x-error-status-map` / `x-contract-status` / `x-proposal-revision`）base 与 HEAD **逐字相同**，未做任何 reformat。

## 8 已知缺口三条（本片不做，均已在此登记）

1. **不落审计行**：处置动作不写 `admin_audit`。要落需扩 `services/api/src/admin/audit/catalog.ts` 的 `AUDIT_ACTIONS` 闭集 + 新增迁移 + `deploy/postgres-cvm/sql/90-assert-least-privilege.sql` 与 `20-login-roles.sql` 三处同步 ⇒ 属迁移片，另批。T6 反过来把「审计写入 0」钉成现状，避免有人以为已经在写。
2. **`closed` 一值两义**：`received` 之后无论「成立」还是「驳回」都收敛到 `closed`，无法从 `state` 单列反查结论。该弱化在 `services/api/src/community/report-state.ts:28-31` 已逐字登记（要区分需新增一列 ⇒ 迁移 + 两处 SQL 授权同步），本片沿用，不改。
3. **能力图看不见这条 op**：`tools/verify-admin-capability-map.mjs` 只解析 `routes/admin.ts` 这一个源文件（`SOURCE_PATHS.adminRoutes`），本片路由落在新文件 `services/api/src/routes/admin-reports.ts`，因此能力图仍是 46 条、既不会列出 `advanceReport`，也不会把它记进 `KNOWN_NO_UI_ENTRY`（强行登记会与该用例「登记 id 必须出现在能力图里」的双向对拍冲突）。要修得改工具的扫描面（扫 `routes/*.ts` 或按 operationId 聚合），另批。

## 9 真库臂：本机未执行

`node tests/integration/community-filter-pg.mjs` 在本机读数为 **exit 77（SKIP）**：`COMMUNITY_FILTER_PG_TEST_URL` 未设置，且本机 `psql` / `pg_ctl` / `initdb` 均不在 `PATH`、无 docker。该脚本这一节的内容已按新 op 改写为「形状核对」（契约面多一条、其余候选推进路径仍 404），但**真库处置臂没有在本地跑过**，真库行为由 CI 判定——本页不把它写成「真库通过」。

## 10 体积 / 行数守恒（可复核）

| 对象 | 读数 |
| --- | --- |
| `git diff --numstat 52d1e90d f96cb2fa` | **29 文件，+871 / −109** |
| `packages/contracts/openapi.json` | 19946 行（工具口径：`split('\n').length` 减去末尾换行计入的那一行） / 640163 字节 |
| `docs/architecture/contract-status.json` | 4407 行（同口径） / 269681 字节；`operations` 128 条 |
| `docs/architecture/contract-implementation-status.md` | 218 行 / 192765 字节（`--write-doc` 渲染，未手改） |
| 热文件净 0 行 | `services/api/src/app.ts` 4/4、`services/api/src/routes/admin.ts` 2/2、`services/api/src/admin/ops/service.ts` 9/9、`admin/ops/community-posts.ts` 零 diff |
| 热文件之外 | `apps/admin/src/lib/review-state.mjs`、`tests/unit/doc-anchor-relocations.json`、`tools/doc-anchors-anchor-count-baseline.json`、`tools/doc-anchors-symbol-baseline.json` 全部零 diff |
| 契约台账形状 | `advanceReport` 记录压在 `rejectPost` 同一行之后（单行 JSON），`contract-status.json` 行数与 base 持平在 4407 行 ⇒ `docs/verification/gy-r29-i07-ledger-lags.json` 的两条行号指针无需改动 |

## 11 门禁读数（本片自跑，2026-11-02）

| 门 | 命令 | 读数 |
| --- | --- | --- |
| 1 | `git diff --check` | 0 |
| 2 | `npm run lint` | 0（两条 `tsc --noEmit` + 卫生扫描） |
| 3 | 新钉线 T1–T7 | 0（7/7） |
| 4 | `community-report-disposition` | 0（8/8） |
| 5 | `community-report-state` | 0（6/6） |
| 6 | `community-filter-pg` | **77（SKIP，见 §9）** |
| 7 | `npm run test:contract` | 0（22/22） |
| 8 | `openapi-route-parity` | 0（`missing: []`、`ledgerDrift: []`） |
| 9 | `verify-contract-status` | 0（`PASS: 中文表格一致`） |
| 10 | `verify-contract-status --reanchor` | 0 |
| 11 | `verify-doc-anchors --strict --scan docs` | 0 |
| 12 | `verify-doc-anchors --strict --symbol=strict --scan docs` | 0 |
| 13 | `npm run test:docs` | 0 |
| 14 | `doc-anchor-relocation-identity`（提交后） | 0（33/33） |
| 15 | `npm run test:unit`（`GY_BASH=D:\Git\bin\bash.exe`） | 0（`6296 tests / 6292 pass / 0 fail / 2 skipped / 2 todo`；两条 `todo` 是 I11 既有缺口，非本片） |
