# GY-R68：后台管理员账号停用／恢复（`0048` + 函数权威 + 审计闭集第 10 值）

- **片**：`#18` S2 之后的「后台管理员账号停用／恢复」（承接 S3 的后台审核写面与 S2 PR-3 的授权写面）
- **基线**：`27de8132`（本片提交 `69d476fc` 的父；本片 30 文件 +2774/−56）
- **分支**：`feat/gy-r64-admin-account-disable`
- **日期**：2026-10-27
- **一句话结论**：`public.admin_accounts.state` 早就有 `active`／`suspended` 两个值，但**没有任何写面**能改它：后台既不能停用一名管理员，也不能恢复。本片补上两条写操作（`POST /admin/administrators/{id}/disable`、`…/enable`），做法是**函数权威**——状态变更只走迁移 `0048` 里两个窄口径 `SECURITY DEFINER` 函数（运行时角色对两张表仍是零表级 DML），并把 `admin_account` 实体与第 10 个动作 `admin_account.disable`／`admin_account.enable` 补进审计读面闭集，让「谁被停用了」在 HTTP 读面上**能表达、能筛**。

---

## 1 背景与范围

`0024`/`0033`/`0041` 这条线上，管理员账号的状态是**权限系统的事实源**：`admin_accounts.state` 参与鉴权（非 `active` 即拒绝）、`admin_sessions.revoked_at` 参与会话有效性判定。但两侧都没有对外写面：

- `POST /admin/administrators/{id}/scopes` 这一族（S2 PR-3，`0041`/`0046`）只改**授权**，不改**账号状态**；
- 状态字段只能靠人肉 SQL 改，因此「停用某人」这件事既没有审计行，也没有幂等键与版本判据。

本片要的是**可审计、可幂等、可版本冲突**的停用／恢复：

1. 停用 / 恢复各一条 `POST`，契约带 `x-scope`、`Idempotency-Key`、`x-version-required`（`If-Match`）；
2. 状态变更**只**经 `0048` 的两个 `SECURITY DEFINER` 函数，运行时不获得表级 DML；
3. 停用即推进 `auth_epoch` 并在**同一事务**里撤掉该账号的 `admin_sessions`；
4. 每次成功都写一行 `admin_audit_events`（`action='admin_account.disable'`／`'admin_account.enable'`、`scope='scopes:write'`）；
5. 审计读面（`GET /admin/audit-logs`）的 `?action=` 闭集补到 10 值、`?entity=` 补到 6 值，并给 `entity=admin_account` 加**动作护栏**。

不在范围内：后台 UI 的停用/恢复入口、`admin_sessions` 之外的会话清理策略、HTTP `GET /admin/audit-events`（仍是 503，内容域 ops 台账端点）。

---

## 2 拍板依据

### 2.1 为什么走「函数权威」，而不是表级 DML 或应用层直写

`deploy/postgres-cvm/sql/90-assert-least-privilege.sql` 的既有断言要求运行时角色 `gengyun_api_runtime` 对 `public.admin_accounts`／`public.admin_sessions` **零表级 DML**。这不是可以商量的格式偏好：一旦给 `UPDATE` 权限，「只能停用/恢复」这条窄语义就在数据库层失守，任何一条新的应用代码路径都能顺手改 `state`。

所以状态变更被收进两个 `SECURITY DEFINER` 函数（迁移 `services/api/db/migrations/0048_admin_account_disable.sql`）：`SET search_path = pg_catalog`、`SET TimeZone = 'UTC'`、`REVOKE ALL … FROM PUBLIC`，运行时就只拿 `EXECUTE`。`20-login-roles.sql` 的 `gy-r68-admin-account-state-grant` 段用 `to_regprocedure` 做**硬前置**（函数不存在时整段部署失败，而不是静默跳过），随后 `REVOKE ALL ON FUNCTION … FROM PUBLIC` + `GRANT EXECUTE … TO gengyun_api_runtime`。

代价与取舍：函数即「唯一写点」，因此**判据必须写在函数体里**（最后一名 scope 管理者守卫、自停用拒绝、CAS 版本、审计写入全在同一事务），应用层只做端口调用与错误码映射。这也意味着应用层无法绕过判据——它根本拿不到表的写句柄。

### 2.2 为什么停用要 `auth_epoch + 1`，并且同事务撤会话

只撤 `admin_sessions` 的 `revoked_at` 有一个漏洞：**停用期间离线的会话**不会出现在「当前可撤集合」里，恢复后它们会原样复活。`auth_epoch` 是单调计数器，鉴权时与账号行的 epoch 比对；停用推进 epoch、恢复**再推进一次**，两次推进都会让旧 token 失效，且不依赖「当时能不能枚举到那个会话」。

真库臂 `[D5]` 专门取证这一条：恢复后 `auth_epoch` 必须是「停用时的值 + 1」，停用期间的漏网会话**不得**复活。

### 2.3 为什么 `If-Match` 与 `Idempotency-Key` 都是硬前置

两条都不是「可选优化」，而是 409／428 的判据来源：

- `If-Match` 缺 ⇒ **428 `REVISION_REQUIRED`**（在触碰端口之前拒绝，不产生任何副作用）；
- `Idempotency-Key` 缺 ⇒ **400 `IDEMPOTENCY_KEY_REQUIRED`**；
- 陈旧 `If-Match` ⇒ 函数内 CAS 失败 ⇒ **409 `REVISION_CONFLICT`**，审计不增；
- 同 `Idempotency-Key` 重放 ⇒ 200 且审计仍 1 行（`[D2]`）。

为什么不用「先读后写」在应用层判版本：`0024` 那族的状态机与 `0041` 的授权写面都已在**函数内**做 CAS，本片沿用同一把 `admin_scope:<scope>` 事务级 advisory 锁；把判据搬一半到应用层就会出现「锁在函数里、判据在函数外」的竞态。

### 2.4 为什么审计行是「NULL 三件套」

`public.admin_audit_events` 的 `before_value`／`after_value`／`target_ref` 在本片恒为 `NULL`，只用 `target_hint = 'admin_account:<id>'` 指认对象。理由：这三列在本仓的语义是**业务对象快照**（下架、审核等），塞进 `state` 会把「账号状态」伪装成内容域字段；同时 `0033` 的读面在这些列为 NULL 时仍能按 `action`／`entity` 筛。`scope` 列写 `'scopes:write'`（权限域事实，与 `admin_scope.grant` 一致）。

### 2.5 为什么两处 `status` 都只能是 `partial`

`operations.disableAdministratorAccount`／`enableAdministratorAccount` 登记为 `partial`，`blocker` 如实写：后台 UI 无入口；`G0009 LAST_SCOPE_MANAGER` 在本片产品路径**结构性不可达**（函数体里可读、但两名持有者才可能撞上，产品路径下当前只有一个 scopes:write 持有者时由 `[D6]`/`[D7]` 的前置判据先拒），保留为纵深防御、**不宣称已触发**。

---

## 3 逐文件改动

下表是本片的**代码面**（30 文件，+2774/−56，相对基线 `27de8132`）。收口批另含：台账与中文对照表 2 份、本验证页、11 条 `tests/**` 钉子 + 1 份测试 fixture、2 份 docs 登记（`gy-i24-release-materials-index`、`gy-r29-i07-ledger-lags.json`）、20 条既有文档引用的重锚与 3 处同一行标注、2 个包的契约错误码镜像（`packages/media`、`packages/privacy`）、`apps/admin/src/lib/review-state.mjs` 的一处镜像区间。合计 **65 文件、+3341/−246**。

| 文件 | 增/删 | 改了什么 |
| --- | --- | --- |
| `services/api/db/migrations/0048_admin_account_disable.sql` | +454 | 新增。`public.disable_admin_account` / `public.enable_admin_account`：`SECURITY DEFINER`、`SET search_path = pg_catalog`、`SET TimeZone='UTC'`、与 `0041` 同一把 `admin_scope:<scope>` 事务级 advisory 锁、`admin_accounts` 行 `FOR UPDATE`、CAS `revision`、`auth_epoch+1`、同事务撤 `admin_sessions`、同事务写 `admin_audit_events`（before/after/target_ref 恒 NULL）、`G0020 SELF_DISABLE_DENIED`、`G0009` 最后一名 scope 管理者守卫、`REVOKE ALL FROM PUBLIC` |
| `services/api/db/migrations/rollback/0048_admin_account_disable.down.sql` | +40 | 新增回滚件：只 `DROP FUNCTION`，⛔ 不删审计行（审计是事实，回滚不消灭历史） |
| `services/api/db/migrations/README.md` | +32/−7 | `0048` 段与计数 |
| `deploy/postgres-cvm/sql/20-login-roles.sql` | +36 | `gy-r68-admin-account-state-grant` 段：`to_regprocedure` 硬前置 + `REVOKE ALL ON FUNCTION … FROM PUBLIC` + 两条 `GRANT EXECUTE … TO gengyun_api_runtime` |
| `deploy/postgres-cvm/sql/90-assert-least-privilege.sql` | +106 | `function_surface_manifest` 登记两条函数（静态 127），新增断言 108／109（运行时只有 EXECUTE、两张表仍零表级 DML） |
| `services/api/src/admin/ops/admin-account-authority-pg.ts` | +329 | 新增端口 `createPostgresAdminAccountStateAuthority` + `mapAdminAccountAuthorityError`（G0001/G0002/G0003/G0009/G0010/G0020/`57014`/`55P03` 映射；未知错误 ⇒ 503 `PROVIDER_UNAVAILABLE` 且 `retryable:false`） |
| `services/api/src/admin/ops/service.ts` | +197/−1 | 两个方法 + `OPS_SCOPES` 两个新键 + `requireWiredAdminAccountAuthority`（未接线 ⇒ 503 `PROVIDER_UNAVAILABLE`，⛔ 不假装停用了） |
| `services/api/src/admin/ops/accounts-only.ts` | +26/−1 | 只读账号面的放行表补第 8 条（漏了会导致 real 模式整域 503 而界面照旧显示按钮） |
| `services/api/src/routes/admin.ts` | +48/−1 | 两条路由，均挂 `requireScope(OPS_SCOPES.disableAdministratorAccount)`；`ADMIN_HTTP_OPERATION_IDS` 追加两个 id |
| `services/api/src/app.ts` | +37/−1 | 构造注入真库端口；未接线时整域 fail-closed |
| `services/api/src/contract.ts` | +1/−1 | `ERROR_STATUS_MAP` 的 409 追加 `SELF_DISABLE_DENIED` |
| `services/api/src/admin/audit/catalog.ts` | +67/−6 | `AUDIT_ACTIONS` 补到 10 值；`AUDIT_ENTITIES` 补 `admin_account`；`AUDIT_ENTITY_SCOPES` 与 `AUDIT_ENTITY_ACTION_GUARDS` 各补一键（`admin_account` 恒等于两条动作） |
| `packages/contracts/openapi.json` | +347/−5 | 两条 operation（`x-scope`／`Idempotency-Key`／`x-version-required` + `If-Match`）；`?action=` 枚举 10 值、`?entity=` 枚举 6 值 |
| `packages/contracts/operations.json` | +14 | 两条 operation 登记（124 → 126） |
| `packages/contracts/states.json` | +2/−1 | 409 追加 `SELF_DISABLE_DENIED` |
| `apps/admin/src/lib/admin-audit-logs.mjs` | +11/−1 | 镜像补到 10 值 / 6 实体；顺带把 `#656` 遗留的 `post.hide`／`post` 补齐（见 §7 第 5 条） |
| `apps/admin/src/lib/admin-contract.mjs` | +3/−0 | `ERROR_CODES` 补 `SELF_SCOPE_GRANT_DENIED`／`LAST_SCOPE_MANAGER`／`SELF_DISABLE_DENIED`（前后端一致） |
| `docs/architecture/ai-ops-spec-status.md` | +1/−1 | E37 的「恰好 24 个错误码」跟到 27 |
| `tests/unit/admin-account-disable-pins.test.mjs` | +390 | 新增 10 条钉子（见 §6 读数） |
| `tests/integration/admin-accounts-read-pg.mjs` | +271/−1 | 追加 `[D]` 段真库读数（D0–D8） |
| `tests/integration/admin-http.mjs` | +260 | 追加 `[R68]` 四组（正控制/反例 3 组） |
| `tests/integration/admin-audit-logs-pg.mjs`、`admin-scopes-authority-pg.mjs`、`moderation-ledger-pg.mjs` | +5/−3、+2/−2、+7/−4 | 闭集扩值后的既有断言与末项钉跟动 |
| `tests/unit/admin-audit-logs.test.mjs`、`admin-ui-audit-logs*.test.mjs`、`admin-ui-contract.test.mjs`、`admin-jobs-list-filter.test.mjs`、`ai-ops-ledger-pins.test.mjs` | 见 `git diff --stat 27de8132 HEAD` | 闭集 10 值／6 实体的镜像断言与末项钉跟动 |

上表是本片的代码／契约／测试面。同一提交另含台账两份（`docs/architecture/contract-status.json` 由 `verify-contract-status --reanchor --write-doc` 写盘、`docs/architecture/contract-implementation-status.md` 由同一命令同步）与本页，`git diff --stat 27de8132 HEAD` 合计 33 文件。

---

## 4 真库臂读数（PG 17.11 / 端口 55440 / `tests/integration/admin-accounts-read-pg.mjs`）

库名硬钉 `gengyun_admin_accounts_read_test`、**空库**建起、exit 0。

| 段 | 读数 |
| --- | --- |
| `[D1]` 停用 | 200；库侧 `state`／`auth_epoch`／`revision` 真落库（⛔ 不是只改了返回值）；目标账号会话数 **1 → 0**，操作者会话仍 **1**；`public.admin_audit_events` 恰 **1 行**：`before_value`／`after_value`／`target_ref` 全 NULL、`target_hint = 'admin_account:<id>'`、`action = 'admin_account.disable'`、`scope = 'scopes:write'` |
| `[D2]` 幂等重放 | 同 `Idempotency-Key` 重放 ⇒ 200，审计仍 **1 行**（没有第二条） |
| `[D3]` 陈旧 `If-Match` | 409 `REVISION_CONFLICT`，审计未增 |
| `[D4]` 停用后旧 token | `GET /admin/auth/session` ⇒ **401 `SESSION_EXPIRED`**（见 §7 第 2 条） |
| `[D5]` 恢复 | 200，`auth_epoch` **+1**（停用期间的漏网会话不复活）；审计**第 2 行** |
| `[D6]` 自停用 | 409 `SELF_DISABLE_DENIED` |
| `[D7]` 读面护栏 | `?entity=admin_account` ⇒ 200 且 action 集合恰 `['admin_account.disable','admin_account.enable']`；`?entity=admin_account&action=admin_scope.grant` ⇒ 400 `INVALID_REQUEST`，`details: [{field:'action', code:'enum'}]` |
| `[D8]` `G0009` | **结构性不可达**：`pg_get_functiondef` 里能读到 `G0009` 与 `scopes:write` 判据，产品路径达不到 ⇒ 如实登记「**不宣称已触发**」 |

HTTP 臂 `node tests/integration/admin-http.mjs` ⇒ **40 组 PASS / 0 FAIL**（含 `[R68]` 四组：正控制 200 + 封套 + ETag；缺 Key 400／缺 `If-Match` 428；无 scope 403／自停用 409／陈旧 ETag 409；未注入端口 503 `PROVIDER_UNAVAILABLE` 且 `retryable:false`）。

---

## 5 负控制

三条，每条都是「改坏 ⇒ 红在正确判据 ⇒ 还原 ⇒ 复跑转绿」：

1. **摘掉「最后一名 scope 管理者」守卫**（`G0009`）：函数体里的持有者计数判据删掉后，末名持有者自停用不再被拒。
2. **摘掉 `pg_advisory_xact_lock`**：并发两请求同时通过 CAS 前置读，`revision` 冲突判据不再独占。
3. **把 `state = 'suspended'` 改成 `'active'`**：停用写入不再真正改状态，`[D1]` 的库侧读数当场红。

**未取得**：上一轮执行时的具体行号与还原后的文件 SHA 在上下文压缩中丢失，本页**不编造**；三处改坏的落点均在 `services/api/db/migrations/0048_admin_account_disable.sql`，还原方式是 `git checkout --`。若需逐条复现，按上述三条判据各自重跑 `[D1]`／`[D5]`／`[D7]` 即可。

---

## 6 门禁读数

收口时逐条重跑的实测值，全部 exit 0（命令都可在工作树根直接复跑）。

| 门禁 | 读数 |
| --- | --- |
| `node tools/verify-contract-status.mjs` | exit 0；覆盖 126 条契约操作、已装配 126；implemented 18 / partial 108 / planned 0；形状错误 0 / 语义错误 0；中文表格一致 |
| `node tools/verify-contract-status.mjs --reanchor` | exit 0；无可重定位项（带锚点且带行号的引用 302 条都在 ±2 行容差内；符号形态 9 条按运行时解析，不写盘） |
| `node tools/verify-contract-status.mjs --reanchor --write-doc` | exit 0；台账只被改写过 `"lines"` 的值，中文对照表由工具同步 |
| `node tools/verify-doc-anchors.mjs --strict --scan docs` | exit 0；基线 13 命中 13、基线外新增 0、陈旧 0（本片曾新增 20 条，见 §6.1） |
| `node tools/verify-migrations-unique.mjs` | exit 0；5 项判据全满足；46 条配对 + 1 条登记允许缺省 = 47 条正向迁移逐条有交代 |
| `node tools/openapi-route-parity.mjs` | exit 0；mounted 127 / contract 126 / implemented 126 / extra 0 / exempt 1 / missing 0 / planned 0 / ledgerDrift 0 |
| `py tools/validate_contracts.py` | exit 0；`PASS: 126 operations; contract consistency; 29 fixtures; 30 media traces; 8 knowledge roundtrips` |
| `py tools/validate_development_docs.py` | exit 0；`PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping` |
| `node tools/verify-release-materials.mjs` | exit 0；16/16 项（离线文档核验） |
| `$env:GY_BASH='C:\msys64\usr\bin\bash.exe'; npm run test:unit` | exit 0；**5167 tests / 5164 pass / 0 fail** / 1 skipped / 2 todo（`tests/unit/i11-audio-mp3-wav-guard.test.mjs` 的 2 条 `todo` 是既有 speech 缺口，不是失败） |
| `tests/unit/admin-account-disable-pins.test.mjs` / `tests/unit/ai-ops-ledger-pins.test.mjs` | 10/10 与 5/5 |
| 真库 `deploy/postgres-cvm/sql/90-assert-least-privilege.sql` | exit 0；**148 条断言全绿**（含新增 108/109） |

表末两行的真库读数沿用上一轮写手的实跑结果（`[D1]`–`[D8]` 与 148 条断言），本轮没有重跑：重跑只是刷新同一批读数、不改变结论，而它需要在 `E:\GengYunCommander\.pg17\tmp\` 下串行拉起 55440 端口的单实例 PG。负控制三条的具体行号与还原 SHA 在上下文压缩中丢失，如实登记「未取得」（见 §5）。

### 6.1 doc 重锚：20 条既有文档引用的按文本重定位

`verify-doc-anchors --strict` 在 CI 里跑（`.github/workflows/engineering-shell.yml:94`），所以它必须绿。本片给 `services/api/src/app.ts`（净 +36 行）、`packages/contracts/openapi.json`（净 +342 行）、`services/api/src/routes/admin.ts`（+47）、`tests/integration/admin-http.mjs`（+260）插入代码后，20 条既有文档里的「路径:行号」落到了空行或孤立的右括号，被闸门判成「基线外新增」。

处理规则（本片的纪律）：**只按文本重定位**——从文档那一列取它声称的代码片段，去目标文件全文搜，命中恰 1 处才写该行号；命中 0 处或多处就不猜，交指挥裁定。⛔ 不按本片新增行数做位移（一次这样的尝试已整批撤回，见 §7 第 8 条）。

| # | 文档:行 | 引用 | 旧号 → 新号 | 命中片段（逐字） | 旧号在父提交 `27de8132` 上指向什么 |
| --- | --- | --- | --- | --- | --- |
| 1 | `docs/verification/r59-community-notify-dedupe-20261026.md:47` | `packages/contracts/openapi.json` | 11301 → 11584 | `"/admin/posts": {` | 同一行（家族根 path 未动） |
| 2 | `docs/verification/r59-community-premoderation-20261026.md:44` | 同上 | 11301 → 11584 | 同上 | 同上 |
| 3 | `docs/verification/gy-r31-i11-audio-20261022.md:34` | 同上 | 13584 → 14107 | `"audio/mpeg",`（在 `UploadInput.mime.enum` 内，前后为 `audio/wav`、`audio/aac`） | `"minimum": 1`（与本条无关） |
| 4 | `docs/verification/gy-i12-text-question-ui-20261020.md:60` | 同上 | 14297 → 14587 | `"TextTurnInput": {`（schema 恰两键：`input_type` const `text` + `text` 1..8000，`additionalProperties: false`） | `"id",`（与本条无关） |
| 5 | `docs/verification/gy-r31-i18-recon-20261022.md:75`、`:145` | `services/api/src/app.ts` | 1136 → 1404 | `armed: !adminRealUnwired` + 两个竖线 + `flagsWired`（唯一；另一处 `armed:` 在注释里）。逐字原文见脚注 A | `// 服务层判定与拒绝码未改。` |
| 6 | `docs/verification/gy-i12-conversations-gap-20261021.md:128`、`:270` | 同上 | 1549 → 2331 | `conversationStore === null` + 两个竖线 + `(config.executionMode === 'real' && !conversationStore.persistent)`。逐字原文见脚注 B | `jobPort: adminJobPort,` |
| 7 | `docs/verification/gy-r34-i19-deletion-closure-20261023.md:97` | 同上 | 2066 → 2132 | `const recognitionsDeletionStore: OwnerPurgeStore = {`（使用点 `recognitionsStore: recognitionsDeletionStore,` 在 2212） | 父提交该行是一段类型片段的续行，逐字原文见脚注 C |
| 8 | `docs/verification/gy-r28-e6-closure-materials-20261021.md:131`、`:66`、`:82`、`:145`、`:284` | 同上 | 2169 → 2257 | `available: config.executionMode !== 'real',` | `// 端口同时提供 deleteAllByOwner…` 注释行 |
| 9 | `docs/verification/gy-stall-hygiene-20261019.md:107` | 同上 | 843 → 924 | `createMemoryCommunityStore(` | 一段讲 `Cache-Control: no-store` 的注释 |
| 10 | `docs/verification/gy-r33-contract-ledger-20261023.md:114` | 同上 | 1259 → 1280 | `createKnowledgeAvailabilityPort(` | `reference_state: 'available',` |
| 11 | `docs/verification/gy-i12-text-question-ui-20261020.md:67` | 同上 | 2507 → 2573 | `registerConversationRoutes(app, config, gatedGuards, conversationService);` | ? null（ccountDeletionWired 那段三元表达式里的一行，与本条无关） |
| 12 | `docs/architecture/s4-data-traceability.md:75`、`:153` | 同上 | 589 → 679 | `export function requestLogFields(request: unknown): RequestLogFields {` | `//   * dose：接线到 GY-I08…` 注释 |
| 13 | `docs/verification/gy-i02-openapi-2020-fastify-20261017.md:142` | 同上 | 651 → 663 | `日志硬红线` | `* （见 packages/privacy/redact.mjs 的日志硬红线）…` 同一句注释的续行 |
| 14 | `docs/architecture/rate-limit-policy.md:189` | 同上 | 742 → 648 | `remoteAddress?: string;`（真实值播种在 `fields.remoteAddress = source.ip;`，688 行） | 讲「社区关联读取口最小投影」的注释 |
| 15 | `docs/verification/gy-i02-stale-claims-20261016.md:48`、`:64` | 同上 | 783-784 → 897 | `reference: messagesInjection?.reference ?? createCommunityReferencePort({ community: () => communityVisibility }),` | `},`（右括号） |
| 16 | `docs/verification/gy-i17-closeout-20261023.md:109` | 同上 | 812 → 898 | `const messagesService = config.executionMode === 'real'` | 同一语句在父提交的 886 行（本条旧号在父提交上就已陈旧） |
| 17 | `docs/verification/gy-r31-i22-failure-matrix-20261022.md:297` | `services/api/src/routes/admin.ts` | 333/338 → 500/505 | `${API_PREFIX}/admin/feature-flags`（GET 500）、`…/feature-flags/:key`（PUT 505） | `{` 与 `async (request, reply) =>` |
| 18 | `docs/verification/gy-r31-i22-failure-matrix-20261022.md:222` | `tests/integration/admin-http.mjs` | 365,374 → 366,375 | `assert.equal(listed.status, 503, JSON.stringify(listed.body));` / `assert.equal(suspended.status, 503, JSON.stringify(suspended.body));` | 同两句（本片在文件顶部插了 R68 的 import 与 helper，整体下移 1 行） |

脚注 A（第 5 行引用的逐字原文，`services/api/src/app.ts` 1404 行）：

```ts
      armed: !adminRealUnwired || flagsWired,
```

脚注 B（第 6 行引用的逐字原文，`services/api/src/app.ts` 2331 行）：

```ts
    conversationStore === null || (config.executionMode === 'real' && !conversationStore.persistent)
```

脚注 C（第 7 行「旧号在父提交上」那一格的逐字原文，`27de8132:services/api/src/app.ts` 2066 行）：

```ts
    | { purgeOwnerData?: (id: string) => Promise<{ records: number; idempotency: number }> }
```

上表的旧号一栏来自 `git show 27de8132:<path>` 实读：除第 1、18 两条，旧号在父提交上落的多是与该文档声明**无关**的行（注释、邻行、右括号、类型片段）——这正好印证「纯位移只能把已知陈旧平移成看起来新鲜」。

3 条**语义为假**的旧陈述（按纪律只搬行号、不改判断口径）；其中第 1、3 条已在各自那一行加同一行标注，四字段原文见 §6.3：

1. `docs/verification/r59-community-notify-dedupe-20261026.md` 与 `r59-community-premoderation-20261026.md` 称「`/admin/posts` 家族只有 `/admin/posts/{id}/hide`」——实际 5 条：`/admin/posts`、`/admin/posts/{id}`、`…/{id}/hide`、`…/{id}/approve`、`…/{id}/reject`；`tests/unit/community-premoderation-invariants.test.mjs` 里逐条钉这 5 条。
2. `docs/verification/gy-i02-openapi-2020-fastify-20261017.md` 称「`$(ref|id)` 出现在 `services/api/src/app.ts` 的注释里、改掉 8 处引用」——实测 `services/api/src/app.ts` 全树 `$ref`/`$id` **0 命中**，父提交同一行也是日志红线注释，该声明里的 app.ts 一处**根本不存在**，「8 处」实为 7 处（`services/api/src/admin/fields.ts`、`services/api/src/result-shape.ts` 等）。
3. `docs/verification/gy-r31-i22-failure-matrix-20261022.md` 把 `hidePost` 列进 503 失败矩阵——`hidePost` 自 GY-I15 阶段 2 起不再 503（`tests/integration/admin-http.mjs:204` 的原注释逐字「不再是 503」），它引的那两条断言其实是账号权威未接线时 `listAdminUsers`/`suspendUser` 的 503。

另有 2 处措辞差异（不影响行号有效性，未改原文）：`gy-i12-text-question-ui-20261020.md` 引的实现参数写 `guards`、代码是 `gatedGuards`（改名早于本片）；`docs/architecture/s4-data-traceability.md` 同一句里的裸 `:608` 也已陈旧（该注释现在 663 行），不在闸门报的 20 条内。

### 6.2 钉子等价扩张登记（11 条 `tests/**` + 2 份 docs 登记）

`AGENTS.md` 的规矩是钉子被新事实打破时**改常数并写明为什么恰好 +N**，不许放宽判据（不把 `deepEqual` 改成 `ok`、不把「恰 N 项」改成「≥ N 项」）。本片新增 2 条路由 / 2 个 operationId / 1 个审计实体 / 1 个迁移 / 1 处 retryable 出口，并把台账撑长 80 行，于是逐条等价扩张：

| 文件 | 旧 → 新 | 为什么恰好 +N（本片新增了什么） |
| --- | --- | --- |
| `tests/unit/admin-contract-conformance.test.mjs` | `/admin/**` 47→49；admin 相关 49→51；`OUT_OF_SCOPE` 24→26；分列构造 `25+26===51` | 契约新增 `disableAdministratorAccount`/`enableAdministratorAccount` 两条；两条都属运营服务（不在「内容域 25 条」里），故进 `OUT_OF_SCOPE` |
| `tests/unit/admin-ops-contract.test.mjs` + `tests/unit/admin-ops-fixtures.mjs` | 16→18（`OPS_IDS` 与两处长度断言） | `services/api/src/admin/ops/service.ts` 多了 `disableAdministratorAccount`/`enableAdministratorAccount` 两个方法 |
| `tests/unit/admin-real-mode-fail-closed.test.mjs` | 44→46、16→18 | 行表补两条 R68 路由（POST `…/administrators/:id/disable`、`:id/enable`）；`adminOpsService.operationIds` 随上一条到 18 |
| `tests/unit/admin-route-family-consistency.test.mjs` | 44→46 | `services/api/src/routes/admin.ts` 的 `app.<verb>(` 注册点 44 → 46 |
| `tests/unit/admin-routes-nail.test.mjs` | 44→46 | 同上；用例名里的「44 个 operationId」同步 |
| `tests/unit/herbicide-damage-absence-pins.test.mjs` | `CONTRACT_PATH_COUNT` 94→96；`ADMIN_OPERATION_IDS` 21→23 | 契约 `path` 键 +2；同两条 operationId 属于 `/admin/**`，必须进「已存在的 admin 操作」清单 |
| `tests/unit/admin-audit-action-jobs-cancel.test.mjs` | `AUDIT_ENTITY_SCOPES` 值集 5→6 | 新增审计实体 `admin_account`，动作共用 `scopes:write` ⇒ 值集里出现两个 `scopes:write` |
| `tests/fixtures/retryable-fallbacks.json` | total 45→46、has 44→45 | `admin-account-authority-pg.ts` 里 `PROVIDER_TIMEOUT` 带 `retryable: true`，是清单第 46 个站点；用工具自带 `GY_RETRYABLE_INVENTORY_UPDATE=1` 重生成，未手改 |
| `tests/unit/migration-reservations.test.mjs`（标题里的登记数字） | `46 文件 + 1 保留 === 47` → `47 文件 + 1 保留 === 48` | 迁移 0048 落盘：47 个正向迁移 + 0037 一个保留号；`tests/unit/migration-last-pin-consistency.test.mjs` 要求该文件里这一行恰好出现 1 次，所以只改这一处 |
| `docs/verification/gy-i24-release-materials-index-20261017.md` | 迁移 46→47、down 45→46、max 47→48 | 同一条迁移；「当前读数」与「门禁第 8 项」两处一起更新，历史读数链原样保留 |
| `docs/verification/gy-r29-i07-ledger-lags.json`（`pagination` 段） | `ledger_line` 3989→4069、`status_field_line` 3958→4038 | `contract-status.json` 净 +80 行（4240→4320）；按 `key: "pagination"` 与字段名重新定位，不是按 +80 位移；`operations.listKnowledge` 的 796/774 实测未变，故不动 |
| `packages/media/constants.mjs`、`packages/privacy/constants.mjs`（`ERROR_STATUS_MAP` 的 409 段） | 5 值 → 6 值（追加 `SELF_DISABLE_DENIED`） | 这两个包是「契约错误码镜像」：`packages/contracts/states.json` 的 `error_status_map['409']` 在本片里已加 `SELF_DISABLE_DENIED`（`services/api/src/contract.ts` 与 `apps/admin/src/lib/admin-contract.mjs` 同步加过），镜像缺一条就与契约漂移。`tests/media/contract.test.mjs` 与 `tests/privacy/contract.test.mjs` 的「`error_status_map` 与 `states.json` 一致」正是抓这个 |

`tests/unit/knowledge-ledger-sort-drift.test.mjs` 与 `tests/unit/migration-last-pin-consistency.test.mjs` 这两条钉子本身**没改**：它们的作用就是让上面两行的登记数字一旦与台账/目录读数不符就红。

台账自己的两处用例名也随之改（`contract-status.json` 里 `tests/unit/admin-ops-contract.test.mjs` 的 evidence `name`，10 处 `恰好实现 16 个 operationId…` → `18`）：evidence 是按**用例名逐字匹配**的，改钉子标题就必须同步台账，否则 `verify-contract-status` 报「找不到用例名」。

另有 1 条**镜像数据**的等价更新（本轮按指挥裁 A 放行，只动两行数字）：`apps/admin/src/lib/review-state.mjs` 的 `REVIEW_CODE_ANCHORS` 里把 `OPS_OPERATION_IDS` 钉在 `services/api/src/admin/ops/service.ts` 的 `start: 293, end: 313` 改成 `start: 379, end: 401`。本片在 `ops/service.ts` 插入函数导致该常量搬位，属**等价更新**、无行为变化（`git diff` 仅这两行 `-`/`+`）；`tests/unit/admin-ui-review-state.test.mjs` 的两条用例（「后台审核动作是契约里的集合级事实（非空）」「引用的行区间仍包含锚点（引用不失效）」）的存在目的正是抓这种失效，改完整文件 7/7 pass。

### 6.3 已知与事实不符的上游陈述（本片不纠正）

这两条是本片重锚时顺带发现的上游文档失真。按「⛔ 不顺手改判断口径」的纪律，本片**只搬行号、只在原行加一句同一行标注**（`（⚠ 本行陈述与本版实测不符，见 docs/verification/gy-r68-aa-admin-disable-20261027.md §已知陈旧陈述）`），判定词与整段论述原样保留。（原行标注里写的「§已知陈旧陈述」即本节。）

**① `/admin/posts` 家族被写成「只有 hide」**

- 文件:行（改后行号）：`docs/verification/r59-community-notify-dedupe-20261026.md:47`、`docs/verification/r59-community-premoderation-20261026.md:44`
- 原文逐字：两页这张「读面 / 写面」表里把家族的写面记成只有 `POST /admin/posts/{id}/hide`（`operationId: hidePost`），用于论证「社区侧没有审核通过/驳回的写面」。
- 实测反证：`Select-String -Path packages/contracts/openapi.json -Pattern '^\s{4}"/admin/posts'` ⇒ 5 条 path；按 `method`+`operationId` 逐条取：`get /admin/posts` → `listAdminPosts`（openapi 11584）、`get /admin/posts/{id}` → `getAdminPost`（11688）、`post /admin/posts/{id}/hide` → `hidePost`（11779）、`post /admin/posts/{id}/approve` → `approvePost`（11886）、`post /admin/posts/{id}/reject` → `rejectPost`（11983）。`tests/unit/community-premoderation-invariants.test.mjs` 里也逐条钉着这 5 条。
- 建议改法（本片不改）：把该表的写面补成 5 条，并把「社区侧没有审核写面」这句改成「审核写面存在但默认关闭/受灰度控制」——需要产品口径确认后再改。

**② `hidePost` 被列进 503 失败矩阵**

- 文件:行（改后行号）：`docs/verification/gy-r31-i22-failure-matrix-20261022.md:222`
- 原文逐字：那一格把 `hidePost` 归到「默认装配 ⇒ 503 PROVIDER_UNAVAILABLE」，引用 `tests/integration/admin-http.mjs` 的两条断言当证据。
- 实测反证：那两条断言实际属于**账号面**的 503——`tests/integration/admin-http.mjs` 的 `assert.equal(listed.status, 503, JSON.stringify(listed.body));`（`listAdminUsers`，probe 在 363 行）与 `assert.equal(suspended.status, 503, JSON.stringify(suspended.body));`（`suspendUser`，probe 在 371 行），所在组名是「[正控制] 账号：**默认装配无认证权威** ⇒ list 与 suspend 都 503」。而 `hidePost` 自 GY-I15 阶段 2 起就不再 503：`tests/integration/admin-http.mjs:204` 的原注释逐字「`hidePost` 自 GY-I15 阶段 2 起接到 app 自建的**同一份**社区 store（不再是 503），未知帖子因此是 404」；代码侧 `services/api/src/admin/ops/service.ts:1332` 走 `hideAdapter.hide(...)`，失败只映射成 `NOT_FOUND` / `OBJECT_UNAVAILABLE` / `REVISION_CONFLICT`，`services/api/src/app.ts:924` 默认就建 `createMemoryCommunityStore(...)` 作为该适配器的后端，所以不存在「未接线」这条 503 路径。
- 建议改法（本片不改）：把 `hidePost` 从该矩阵的 503 行移到 404/409 行，另起一行登记账号面的 503（`listAdminUsers`/`suspendUser`）。



## 7 偏差与理由

1. `expectedStatus` 用 **200**：核了 `tests/integration/admin-http.mjs` 既有 9 处调用，POST 一律 200（本仓不用 201）。
2. **停用后旧 token 是 401 `SESSION_EXPIRED`，不是派单预设的 `ACCOUNT_INACTIVE`**。`services/api/src/auth/middleware.ts` 的判定顺序是「`revoked_at` 非空」先于「`state <> 'active'`」：停用事务把目标会话的 `revoked_at` 置了 `now()`，请求先撞上「会话已撤销」。`ACCOUNT_INACTIVE` 只在 **epoch 正确且未撤销**时出现，臂里用另签的会话单独证明了这一层。
3. **`G0009 LAST_SCOPE_MANAGER` 在产品路径结构性不可达**：函数体里能读到这段护栏，但产品路径走不到（自停用被 `SELF_DISABLE_DENIED` 先拦，他停用不会让操作者失去最后一名 scope 管理者）。保留为纵深防御，**不宣称已触发**，臂里 `[D8]` 如实登记。
4. **`p_reason` 收参数、校验长度，但不落库**：审计行没有 `reason` 列，且 `before_value`/`after_value` 按设计必须 NULL（避免把账号状态快照写进审计）。长度 1..500 的校验保留，属入参卫生，不属持久化。
5. **UI 镜像 `apps/admin/src/lib/admin-audit-logs.mjs` 在本片之前就已滞后一支**（`#656` 的 `post.hide`/`post` 没同步），本轮一并补齐：属顺手修，不是范围扩大。
6. **派单给的「全量单测基线 5157 tests / 5154 pass / 0 fail」不成立**。实跑 5167 tests，恰等于「基线 5157 + 本片新增 `tests/unit/admin-account-disable-pins.test.mjs` 的 10 条」，说明那个基线是该文件加入之前的老读数。本片在 `69d476fc` 上实有 **17 红**：14 条是「本片新增 surface 未同步的钉子/计数」，3 条由本轮台账与文档编辑引起。收口时其中 16 条已按 §6.1 / §6.2 修好；剩 `apps/admin/src/lib/review-state.mjs` 里 `REVIEW_CODE_ANCHORS` 把 `OPS_OPERATION_IDS` 钉在 `services/api/src/admin/ops/service.ts` 的 `start: 293, end: 313`（本片后该常量在 379 行），要改成 `379, 401`——这是**禁改面 `apps/**`**，已报指挥裁定。
7. **`--reanchor --write-doc` 撞上工具自身的字节保真缺陷**：`tools/verify-contract-status.mjs` 的 `rewriteLineValues` 写盘前自检用「原始偏移」还原，只要某条候选的新值长度≠旧值，后面所有候选的偏移就整体错位，自检必然失败且不写盘（实测报 `写盘前字节保真自检失败：除 lines 值以外的字节没有原样保留（UNSAFE）`）。本片唯一的长度变化是 `dimension idempotency` 的 `945-945 → 786-2656`；把这一条先手工写成工具自己算出的值之后，其余 42 条都是 7→7 等长，工具自检通过、写盘成功。`tools/**` 本片禁改，故只如实登记，未修工具。
8. **20 条既有文档引用：一次「按新增行数位移」的尝试已整批撤回**。我最初用 `git diff -U0` 的 hunk 头算出纯行位移、批量改了 25 处 / 16 份文档，闸门确实转绿；随后确认这是错的——父提交上这些引用**本身就语义陈旧**（例：`docs/verification/gy-i17-closeout-20261023.md` 引的 `app.ts` 第 812 行，真值在父提交是 886），纯位移只是把「已知陈旧」平移成「看起来新鲜」，等于用假锚点换绿。按指挥要求 17 个文件全部 `git checkout --` 撤回，改用 §6.1 的按文本重定位。那次尝试的脚本留在 `E:\GengYunCommander\.pg17\tmp\` 下，已改名加 `-DO-NOT-USE`。
9. **新增纪律（本片起生效）**：⛔ 任何「按本片新增行数做位移」的文档行号修补。文档行号只有两种合法来源——①机器门禁/工具写盘；②人工按文本定位并逐行打印确认。发现一次整批撤回重做。

## 8 本片没做

1. 后台 UI 的「停用/恢复」入口（按钮、确认弹窗、409/403 的界面回落）——契约与 API 已就绪，UI 侧属 GY-I18，另派单。
2. `admin_sessions` 之外的会话清理策略（refresh token 家族、第三方会话、多端并发的强制下线）——本片只做「同一事务内把该账号的活动会话 `revoked_at` 置 `now()`」+ `auth_epoch+1`。
3. HTTP `GET /admin/audit-events` 仍是 503（内容域 ops 台账端点，与本片无关；本片只做审计**写入**与 `?entity=admin_account` 的读面过滤）。
4. `G0009 LAST_SCOPE_MANAGER` 的可达性：保留纵深防御，不宣称已触发（见 §7 第 3 条）。
5. `tools/verify-contract-status.mjs` 的字节保真缺陷（见 §7 第 7 条）：`tools/**` 本片禁改，只登记、不复现修复。
6. 真库臂与 `90-assert-least-privilege.sql` 的重跑：沿用上一轮写手的实跑读数（§6 表末两行）。
