# GY-R72 在线清除闭集：时钟驱动域 = 读面闭集（8 域）· 证据页

- 日期：2026-11-02
- 分支 / 基线：`feat/gy-r72-online-purge-closed-set`，基线 `1b85e693`（`git rev-parse 1b85e693` = `1b85e69399123b3052427ad6a654d94c89c0c7bf`）
- 本片只碰：`services/api/src/privacy/online-purge-port.ts`（新）、`services/api/src/privacy/user-data-deletion.ts`（**1 行**，净 0）、`tools/purge-expired-online-data.mjs`、`tests/unit/online-purge-closed-set.test.mjs`（新）、`tests/integration/online-purge-pg.mjs`（追加组 [10]）、本页（新；历史页 `gy-r28-w6-deletion-clock-20261021.md` 的陈旧行数**未改写**，见 §7 复核订正）。
- **没有**碰：任何迁移、任何 `deploy/**`（`20-login-roles.sql` / `90-assert-least-privilege.sql` 一行未动）、`packages/contracts/**`、`tools/doc-anchors-*.json`、`tests/unit/doc-anchor-relocations.json`、`services/api/src/contract.ts`（无新错误码）、`services/api/src/privacy/online-state-derivation.ts`（读面判据一行未动）。

## 0 结论先说

1. **时钟驱动的域从 4 变 8**：`tools/purge-expired-online-data.mjs` 不再传 `USER_DATA_DELETION_MODULES`，而是传 `ONLINE_PURGE_MODULES`（= `ONLINE_EVIDENCE_MODULES`，即读面推导的同一闭集：四域 + `recognitions` / `speech` / `ocr` / `jobs`；`community` 保持排除）。端口实现从 CLI 里搬进 `services/api/src/privacy/online-purge-port.ts`，CLI 与真库臂共用同一份。
2. **conditional 四域真的会自愈**：受理时记 `blocked`、`online_due_at` 到期后跑一轮，识别/语音/OCR/作业会被清掉并写出 0031 在线证据 ⇒ 读面从 `blocked` / `STORE_REJECTED` 变 `completed`（真库臂 `PASS 22`，读数见 §3.2）。
3. **端口按可用性诚实**：缺表 / 缺授权 / 端口构造失败的域逐域跳过，**逐条**打印「域 + 原因」，不影响退出码，也⛔不静默少清；一域都装不上才 exit 2（⛔不把「装不上」报成「没有到期请求」）。
4. **C3 修好**：`blocked` 行保留受理时更具体的原因码（`HANDLER_FAILED` / `POLICY_BLOCKED` / `STORE_UNREACHABLE`），不再被覆写成 `STORE_REJECTED`；`user-data-deletion.ts` **净 0 行**（等长单行替换）。
5. **本片零新增 GRANT / 零迁移 / 零新错误码 / 零新 scope**：四个新端口全部落在既有、已授权的入口上（§2.2 逐条给出授权出处）。顺带查出一个**既有**缺口：`public.jobs` 的出厂授权缺 `owner_id` 的列级 `SELECT` ⇒ 运行时角色执行 `JOB_LEDGER_PURGE_SQL` 必然 `42501`（§6.1，本片只做到「诚实跳过 + 报告」，不自己加授权）。

## 1 缺陷链（带 `path:line`）

| # | 现场 | 读数 |
| --- | --- | --- |
| 1 | 两个常量差 4 个域 | `services/api/src/privacy/user-data-deletion.ts:187-192` `USER_DATA_DELETION_MODULES`（favorites / history / messages / conversations）；`:208-214` `ONLINE_EVIDENCE_MODULES = [...USER_DATA_DELETION_MODULES, RECOGNITIONS, SPEECH, OCR, JOBS]`（8 项）；`:202-203` 注释写明社区域（`community`）**刻意排除**（F13 是「保留+脱敏」，没有「清空行数」这个事实） |
| 2 | 读面把「闭集里有、证据里没有」记成 `blocked` | `services/api/src/privacy/online-state-derivation.ts:29`（闭集里有、证据里没有的域按 `blocked` 计）、`:18`（无证据 + 已到期 ⇒ `blocked` / `STORE_REJECTED`）、`:263-271`（到期无证据 ⇒ `{state:'blocked', errorCode:'STORE_REJECTED'}` + `DUE_NOT_EXECUTED`） |
| 3 | **唯一按时钟执行的驱动力只跑四域** | 改前 `tools/purge-expired-online-data.mjs:274-275` 传 `modules: USER_DATA_DELETION_MODULES` + `purge: createFourDomainPurgePort(pool)`（该函数是本文件 `:132-157` 的本地实现，只注册四域）；`services/api/src/privacy/online-purge-driver.ts:460` `const modules = [...(input.modules ?? USER_DATA_DELETION_MODULES)];`，同文件 `services/api/src/privacy/online-purge-driver.ts:389` 注释自认缺省四域 |
| 4 | 受理时 conditional 域失败**仍被受理**并记 `blocked` | `services/api/src/privacy/user-data-deletion.ts:860` `makeHandler` 的 store 抛错不被吞 ⇒ 处理器抛 ⇒ 协议折叠 `blocked`；`:899-901` `const onlineState = blocked > 0 ? 'blocked' : 'completed'` / `let onlineErrorCode = blocked > 0 ? 'POLICY_BLOCKED' : null`；`:955-967` 只有 `blocked === 0` 才写 0031 证据。既有反向用例：`tests/unit/user-data-deletion-recognitions-speech.test.mjs:321-335`（store 缺原语 ⇒ 回执 `online_state='blocked'`、`error_code='HANDLER_FAILED'`，HTTP 仍是 202） |
| 5 | ⇒ 合起来的后果 | conditional 四域若在受理时被记 `blocked`，**再没有任何时钟会重试**；到期后读面把它记成 `blocked: STORE_REJECTED`（文案是「到期却没清」），把「没有执行者」说成「存储拒绝」，且永久不自愈 |
| 6 | 同域第二处自相矛盾（C3） | `services/api/src/privacy/user-data-deletion.ts:1387-1393` 的 `blocked` 分支 `const code = one.errorCode ?? 'STORE_REJECTED';` **无条件**覆写受理时更具体的码；`withOnlineSegments`（`:1164-1170`）先删 `${module}:online-*` 段再 push ⇒ 原错误码段一起没了。同文件 `:1394` 的 `pending` 分支**有**守卫（`beforeState !== 'completed' && beforeState !== 'blocked'`），`:1339-1340` 注释还写着「pending 不覆盖 completed/blocked」 |

**8 vs 4 的推导（为什么这是真缺口，而不是「读面把没接入的域报成 blocked」）**：
推导集合不是常量直出，而是被 `requiredModules` 过滤——`services/api/src/privacy/user-data-deletion.ts:1359` `const modules = [...ONLINE_EVIDENCE_MODULES].filter((module) => requiredModules.includes(module));`（`requiredModules` 在 `:749` 初始化四域、`:758` 只 push **装配时真的注入**的 conditional 域）。
而生产装配**有池即无条件注入**四个 conditional 域：`services/api/src/app.ts:2272-2286`（`recognitionsStore` / `speechStore` / `ocrStore` / `jobsStore`）⇒ 生产 `requiredModules()` = 4 + 4 = **8** ⇒ 读面推导覆盖这 8 域。
于是「时钟只跑 4 域」不是保守，而是**少 4 个执行者**：那 4 域一旦在受理时被记 `blocked`，读面按「闭集里有、证据里没有」永远记 `blocked`，而唯一能补证据的时钟从来不去碰它们。

## 2 改法

### 2.1 端口收进一处（唯一实现）

新增 `services/api/src/privacy/online-purge-port.ts`（276 行）：

- `export const ONLINE_PURGE_MODULES: readonly string[] = ONLINE_EVIDENCE_MODULES;`——⛔不另抄一份字面量：抄一份就会漂移，而漂移正是本片缺陷的成因。
- `export async function createOnlinePurgePort(pool: PgPool): Promise<OnlinePurgePortSet>`，回 `{ purge, modules, skippedModules }`；`skippedModules` 元素是 `{ module, reason }`。
- `DOMAIN_TABLES`：逐域列出「这一域会碰哪些表」，供 `missingRelations()` 探测（`SELECT name FROM unnest($1::text[]) AS t(name) WHERE to_regclass('public.' || name) IS NULL`——只读，不需要任何表权限 ⇒ 不会把「没授权」误判成「没这张表」）。
- `DOMAIN_PRIVILEGE_PROBES`：目前只有 `jobs` 一条（`jobsPurgeDenial`），查 `has_table_privilege(current_user,'public.jobs','DELETE')` 与 `has_column_privilege(current_user,'public.jobs','owner_id','SELECT')`；缺哪个就跳过并点名缺哪个（§6.1）。
- `purgeModule` 的计数口径与四域**完全同形**：优先 `purgeOwnerData(ownerId)` ⇒ `{ removed: counts.records, idempotency: counts.idempotency }`；否则 `deleteAllByOwner(ownerId)` ⇒ `{ removed, idempotency: 0 }`；两者都没有 ⇒ 抛（⛔不返回 0）；闭集外的模块名 ⇒ 抛 `未知的必需模块` 且 `code='STORE_REJECTED'`。

### 2.2 四个新端口：读哪张表、删哪些行、幂等口径

| 域 | 入口（**既有**授权） | 读哪张表 / 删哪些行 | 幂等口径 |
| --- | --- | --- | --- |
| `recognitions` | `SELECT public.purge_owner_recognitions($1::uuid)`（`services/api/db/migrations/0034_r34_owner_content_purge.sql:67-107`，`SECURITY DEFINER`；EXECUTE 授权在 `deploy/postgres-cvm/sql/20-login-roles.sql:305-317`） | 所有权锚在 `recognition_records`：按该主体删 `recognition_selections` → `recognition_jobs` → `recognition_records` → `recognition_idempotency` | 函数自己返回 `{records, idempotency, …}` ⇒ `removed = records`、`idempotency` 同名透传；第二遍 `records = 0` ⇒ 驱动按请求级 `already_purged` 收敛 |
| `speech` | `SELECT public.purge_owner_speech($1::uuid)`（同迁移 `services/api/db/migrations/0034_r34_owner_content_purge.sql:114-153`；EXECUTE 同上 `deploy/postgres-cvm/sql/20-login-roles.sql:305-317`） | `speech_jobs` → `transcriptions` → `speech_idempotency`（该主体） | 同上 |
| `ocr` | 表级 `DELETE`（`deploy/postgres-cvm/sql/20-login-roles.sql:941`、`:953-954` 三张表），由 `services/api/src/ocr/store-pg.ts:531` `purgeOwnerRows` 执行 | `ocr_records` / `ocr_jobs` / `ocr_idempotency`（该主体） | 回 `{records, idempotency}`（另带逐表 `tableCounts`）；第二遍 0 行 |
| `jobs` | `JOB_LEDGER_PURGE_SQL`（`services/api/src/jobs/ledger.ts:387` `DELETE FROM public.jobs WHERE owner_id = $1::uuid`）经 `purgeJobLedgerByOwner`（同文件 `:396-411`，拿不到 `rowCount`/`rows.length` 就抛，⛔不把「不知道」报成 0） | `public.jobs` 里该主体的**全部**作业行（不按 `kind` 分刀：收敛目标就是「该主体零行」） | `idempotency: 0`（台账无幂等表）；幂等靠第二遍 `rowCount = 0` 收敛，与四域 `deleteAllByOwner` 同一范式 |

四个入口的授权都是**出厂就有**的：识别/语音是迁移 0034 的 `SECURITY DEFINER` 函数 + `20-login-roles.sql:305-317` 的 `GRANT EXECUTE`；OCR 三表在 `:941`/`:953-954` 有表级 `DELETE`；`public.jobs` 在 `:997`（区 `gy-r71-jobs-ledger-purge-grant`）有表级 `DELETE`。**本片没有动 `deploy/**` 一个字符**（`git diff --numstat` 只含 `.mjs` / `.ts` / `.md`）。

### 2.3 CLI：选择集 + 报告，不再自带实现

`tools/purge-expired-online-data.mjs`（306 行）删掉本地 `createFourDomainPurgePort`（原 `tools/purge-expired-online-data.mjs:125-157`）与四个 store 的直接 import，改为 `import { ONLINE_PURGE_MODULES, createOnlinePurgePort }`；启动时打印：

- `清理闭集（8 域）：favorites、history、messages、conversations、recognitions、speech、ocr、jobs`
- `本轮可清（N/8 域）：…`
- 有跳过项时 `跳过 N 域（缺表/缺授权/端口构造失败不影响退出码；这些域仍会被读面推导记 blocked，需要人看）：` + 逐条 `   跳过 <module>：<原因>`

然后把 `portSet.modules` 交给 `drainDueOnlineDeletions`。`portSet.modules.length === 0` ⇒ 抛带 `code='42P01'` 的错误（统一分类 ⇒ exit 2），⛔不把「一域都装不上」当成「没有到期请求」报 0。

### 2.4 C3：等长单行替换（净 0 行）

`services/api/src/privacy/user-data-deletion.ts:1388` 改前：

```ts
        const code = one.errorCode ?? 'STORE_REJECTED';
```

改后（`services/api/src/privacy/user-data-deletion.ts:1388`，同行行号不变，仍是 1 处 `1+/1-`）：

```ts
        const code = beforeState === 'blocked' && typeof before.errorCode === 'string' && before.errorCode !== '' ? before.errorCode : (one.errorCode ?? 'STORE_REJECTED');
```

该行行尾还带着一条原文注释 `// C3：有更具体原因就不覆写（同 `services/api/src/privacy/user-data-deletion.ts:1394` 守卫）`——本页照抄语义、不转述原文缩写；`:1394` 指的是同文件 `pending` 分支的守卫行。

语义：`blocked` 行且受理时带原因码 ⇒ 保留原码（`HANDLER_FAILED` / `POLICY_BLOCKED` / `STORE_UNREACHABLE` 都保住，`withOnlineSegments` 因此写回 `module:online-blocked:<原码>`）；**非** `blocked` 行（典型是受理时 `completed`、到期却查不到证据）⇒ 照旧用推导码 `STORE_REJECTED` 覆盖（行为不变）；`completed` / `pending` 分支一行未动。

## 3 测试读数

### 3.1 `tests/unit/online-purge-closed-set.test.mjs`（新，352 行，10 条全绿）

`node --test tests/unit/online-purge-closed-set.test.mjs` ⇒ `tests 10 / pass 10 / fail 0`（约 0.6–6 ms/条）：

| 用例 | 钉住什么 |
| --- | --- |
| `T1 闭集` | 时钟闭集 = 读面闭集（8 项），不含 `community` |
| `T1 CLI` | CLI 把 `portSet.modules` 交给驱动、且不再自带四域实现；打印闭集与跳过项 |
| `T1 端口` | 8 域都在映射表里；闭集外的模块名在调原语前就被拒（`code='STORE_REJECTED'`） |
| `T1 跳过` | 某域缺表 ⇒ 只跳过它、原因指名缺哪张表、不抛错 |
| `T1 跳过（授权）` | `jobs` 缺 `owner_id` 列级 `SELECT` ⇒ 只跳过 `jobs` 并点名缺的授权与文件；授权补齐后同代码 8 域全进（⛔不是硬编码跳过） |
| `T1 反控` | **某域没注入** ⇒ 推导集合仍只有四域、回执里也没有该域（`requiredModules` 过滤未被放宽） |
| `T6a` | `blocked` + 原因码 ⇒ 刷新后保留 `HANDLER_FAILED`，证据串 `recognitions:online-blocked:HANDLER_FAILED`，不含 `STORE_REJECTED` |
| `T6b` | 非 `blocked`（`completed`）+ 推导 `blocked` ⇒ 照旧覆盖成 `STORE_REJECTED`（行为不变） |
| `T6c` / `T6d` | `completed`/`blocked` + 推导 `pending` ⇒ 一行不动（既有守卫仍在） |

`tests/unit/online-purge-driver.test.mjs`（957 行）**一行未改**，全绿（`T4`）。

### 3.2 真库臂 `tests/integration/online-purge-pg.mjs`（PG 17.11 临时集群；23 组 PASS，exit 0）

本片追加组 `[10]`（4 组 PASS），读数逐字：

- `PASS 20: 端口可用性按角色如实：属主角色 8/8 可清（skipped=[]）；运行时角色 7/8（跳过 jobs:缺少列级 SELECT(owner_id)：DELETE … WHERE owner_id = $1 需要读该列，而出厂列清单（20-login-roles.sql:980）未含它 ⇒ 该域在真库上必然 42501）`
- `PASS 21: CLI 闭集：--dry-run 打印 8 域（favorites、history、messages、conversations、recognitions、speech、ocr、jobs）、不含 community、可清 8/8`
- `PASS 22: 扩集后自愈：recognitions 到期前 blocked/STORE_REJECTED（entries=0）⇒ 一轮清掉 1 行 + 落证据 ⇒ completed，8 域 overall=completed`
- `PASS 23: 幂等不变：第二轮 rowsPurged=0、already_purged=4、exit=0、证据 8 条不变`

既有 19 组（`PASS 1`–`PASS 19`：权限形状 / 到期闭区间 / 幂等 / 批量上限 / 批次推进（进程内 + 跨进程）/ 失败不阻塞 / dry-run / 证据可复算 / 回执三态 / 证据权限面 / 证据落库 / 不重复 / 换新进程读回 / 未到期 / 到期未清 / append-only）读数与改动前**逐字一致**。

`[10]` 的造数（T2）：`recognition_records` 插 1 行（`services/api/db/migrations/0025_recognitions_persistence.sql:131-151` 的列形状，`media_id` 无外键 ⇒ 可随机），`deletion_requests.online_due_at = CUTOFF − 1 日`；清前推导 `blocked` / `STORE_REJECTED` / `entries=0`，跑一轮后 `read_online_purge_evidence` 多出 `recognitions` 条目（`removed = 1`、`evidence_ref` 可由 `(request_id, module, removed, idempotency)` 独立复算）、表行数归 0、推导 `completed`。

### 3.3 验收项对照

| 项 | 读数 |
| --- | --- |
| T1 dry-run 输出 = 8 项且不含 community | `PASS 21`（真库真跑 CLI）+ `T1 闭集`/`T1 CLI`（单测） |
| T2 blocked + 到期 ⇒ 一轮后多出 recognitions 条目且 `removed > 0` | `PASS 22`（`removed = 1`） |
| T3 已完成的四域仍 `already_purged` | `PASS 23`（`rowsPurged=0`、`already_purged=4`、`exit=0`、证据 8 条不变） |
| T4 `online-purge-driver.test.mjs` 一行不改仍绿 | 见 §4 门禁 `test:unit` |
| T5 `90-assert-least-privilege.sql` 零新增 GRANT | `git diff --numstat` 无 `deploy/**`；`least-privilege-*` 门禁 exit 0（§4） |
| T6 C3 行为 | `T6a`–`T6d` 四条（§3.1） |

## 4 门禁读数

工作树 `E:\GengYunCommander\wt-r72-onlinepurge`，HEAD 基线 `1b85e69399123b3052427ad6a654d94c89c0c7bf`（`git rev-parse 1b85e693`）；下表全部在本机同一工作树上跑出。

| 门禁 | 命令 | exit | 读数 |
| --- | --- | --- | --- |
| `lint` | `npm run lint` | 0 | `PASS tsc --noEmit services/api/tsconfig.json`、`PASS tsc --noEmit apps/admin/tsconfig.json`、`PASS 仓库卫生扫描` |
| 新测试 | `node --test tests/unit/online-purge-closed-set.test.mjs` | 0 | `tests 10 / pass 10 / fail 0` |
| `online-purge-driver` | `node --test tests/unit/online-purge-driver.test.mjs` | 0 | `tests 33 / pass 33 / fail 0`（该文件 `git diff --numstat` 无条目 ⇒ 一行未改） |
| `online-purge-driver-evidence` | `node --test tests/unit/online-purge-driver-evidence.test.mjs` | 0 | `tests 7 / pass 7 / fail 0` |
| `test:contract` | `npm run test:contract` | 0 | 全绿 |
| `test:docs` | `npm run test:docs` | 0 | `validate_development_docs.py` + `verify-research-records.mjs` 全绿 |
| anchors（默认模式） | `node tools/verify-doc-anchors.mjs` | 0 | 全绿 |
| anchors（严格模式） | `node tools/verify-doc-anchors.mjs --strict` | 0 | `BARE-ORPHAN 基线外新增 0 条`（命中 3476 条 / 册 3540 条） |
| `verify-contract-status` | `node tools/verify-contract-status.mjs` | 0 | `行号区间 317 条（台账直写 306 条 + 符号解析 11 条）`、`中文表格一致` |
| `deploy-sql-gate-forms` | `node --test tests/unit/deploy-sql-gate-forms.test.mjs` | 0 | `tests 10 / pass 10 / fail 0` |
| `deploy-sql-gate-probe` | `node --test tests/unit/deploy-sql-gate-probe.test.mjs` | 0 | `tests 7 / pass 7 / fail 0` |
| `deploy-sql-gate-recovery` | `node --test tests/unit/deploy-sql-gate-recovery.test.mjs` | 0 | `tests 8 / pass 8 / fail 0` |
| `least-privilege-expected-parity` | `node --test tests/unit/least-privilege-expected-parity.test.mjs` | 0 | `tests 8 / pass 8 / fail 0` |
| `least-privilege-external-manifest` | `node --test tests/unit/least-privilege-external-manifest.test.mjs` | 0 | `tests 3 / pass 3 / fail 0` |
| 真库臂（在线清除） | `node tests/integration/online-purge-pg.mjs` | 0 | 23 组 PASS（逐字见 §3.2） |
| 真库臂（保留时钟演练） | `node tests/integration/retention-clock-drill-pg.mjs` | 0 | 全绿 |
| `doc-anchor-relocation-identity`（提交前） | `node --test tests/unit/doc-anchor-relocation-identity.test.mjs` | 1 | **预期红**：`base 与 HEAD 同一提交（git merge-base HEAD origin/main），本用例没有判定面却也不是 CI 浅克隆`；提交后复跑见 §7 |
| `test:unit` 全量 | `npm run test:unit` | 见 §4.1 | — |

### 4.1 全量单测（`npm run test:unit`）

| 轮次 | `tests` | `pass` | `fail` | 失败项 |
| --- | --- | --- | --- | --- |
| 第 1 轮 | 6300 | 6296 | 2 | ①`doc-anchor-relocation-identity`（见下表：提交前必红）；②`tests/unit/moderation-approval-flag.test.mjs:358`（`进程级：开关给了但前置不成立 ⇒ 退出码非 0 ＋ 一行 stderr`） |
| 第 2 轮 | 6300 | 6297 | 1 | 仅 `doc-anchor-relocation-identity`（提交前必红） |

第 1 轮的 ② 是**并发抖动**，不是本片引入：该用例单跑 `node --test tests/unit/moderation-approval-flag.test.mjs` ⇒ `tests 11 / pass 11 / fail 0`；本片 diff 与 `moderation` 无任何交集（`git diff --numstat` 见 §7）；第 2 轮全量不再复现。同一份「先红后绿」的抖动在改动前也出现过一次。

### 4.2 T5：`90-assert-least-privilege.sql` 零新增 GRANT

- `git diff --numstat` 里没有 `deploy/**` 任何条目（改动面 = 2 个 `.ts` / 1 个 `.mjs` / 2 个测试文件 / 2 个文档，见 §7），所以 `deploy/postgres-cvm/sql/90-assert-least-privilege.sql`、`deploy/postgres-cvm/sql/20-login-roles.sql` 都是**字节未动**。
- 两条 `least-privilege-*` 门禁 exit 0（上表），即期望值册与外部清单的对照仍然成立。

## 5 负控制（改 → 跑 → 还原 → 核 sha256）

三条都是「改一处 → 跑 → 还原 → 核 sha256 与改前一致」；`identical=True` 表示还原后字节级相同（`Get-FileHash -Algorithm SHA256`）。

### 5.1 CLI 改回只传四域 ⇒ T2 必红

- 改动：`tools/purge-expired-online-data.mjs` 的 `    modules: portSet.modules,` 换成 `    modules: ['favorites', 'history', 'messages', 'conversations'],`。
- 读数：真库臂 `tests/integration/online-purge-pg.mjs` ⇒ 退出码 1，红在 `[10]` 的 T2：`FAIL: AssertionError [ERR_ASSERTION]: 时钟一轮必须真的删了行（报告读数 0）`；`PASS 20`（端口按角色如实）与 `PASS 21`（闭集仍打印 8 域，因为闭集常量没动）仍绿——**红的正是「时钟只跑四域 ⇒ 识别域没人清」**，不是别的东西。
- sha256（改前 / 还原后）：`532ADFD8106D6D04791C63F32AF96EC0776B912038DB5C01F8B57904C64F5AF4` / 同值（`identical=True`）。

### 5.2 新端口恒返 0 ⇒ T2 必红

- 改动：`services/api/src/privacy/online-purge-port.ts` 的 `async purgeModule({ userId, module }) {` 之后插一行 `if (module === 'recognitions') return { removed: 0, idempotency: 0 };`（只让识别端口假报 0，其余七域照常清）。
- 读数：真库臂 ⇒ 退出码 1，红在同一条 T2 断言 `时钟一轮必须真的删了行（报告读数 0）`；`PASS 20`/`PASS 21` 仍绿，`PASS 22` 未出现 ⇒ 红的就是「识别域没删到行、也没落证据」。
- 附加变体（记录一下强度）：把**所有**模块都改成恒返 0，红会提前到既有组 [6] 的跨进程推进（`tests/integration/online-purge-pg.mjs:729` 的 `deepEqual` 实际 `[]` / 期望两个 requestId）——因为 CLI 一轮什么都不清。所以「恒返 0」不只被 T2 抓，既有组也抓。
- sha256（改前 / 还原后）：`4630DC73617A276C12ECB5AC381E1C2F1DBBCFF34F6263888FC95BDB45B25001` / 同值（`identical=True`）。

### 5.3 C3 守卫去掉 ⇒ T6 必红

- 改动：`services/api/src/privacy/user-data-deletion.ts:1388` 换回 `        const code = one.errorCode ?? 'STORE_REJECTED';`（行数不变，仍 1499 行）。
- 读数：`node --test tests/unit/online-purge-closed-set.test.mjs` ⇒ `tests 10 / pass 9 / fail 1`，红的逐字是 `✖ T6a blocked 行带原因码 ⇒ 刷新保留原码（不得改写成 STORE_REJECTED）`；`T6b`/`T6c`/`T6d` 仍绿（非 blocked 行照旧覆盖、completed/pending 不受影响）。
- sha256（改前 / 还原后）：`6C10D65B7F7D7C4B1852C2BE1FD9966CE192DE45B7069416EE9B677E3B7A3E2F` / 同值（`identical=True`）。

## 6 边界与未做

### 6.1 顺带查出的**既有**缺口：`public.jobs` 缺 `owner_id` 的列级 SELECT

- 实测读数（真库臂临时集群，运行时角色 `gengyun_api_runtime`）：`has_table_privilege(current_user,'public.jobs','DELETE') = true`、ACL 为 `{postgres=arwdDxtm/postgres,gengyun_api_runtime=d/postgres}`，但 `DELETE FROM public.jobs WHERE owner_id = $1::uuid` ⇒ **`42501 permission denied for table jobs`**（`aclcheck_error`）；而 `DELETE FROM public.jobs WHERE false` / `SELECT 1 FROM public.jobs LIMIT 1` 都成功。
- 根因（已实证）：`has_column_privilege(...,'public.jobs','owner_id','SELECT') = false`；临时 `GRANT SELECT (owner_id) ON public.jobs TO gengyun_api_runtime` 后同一条 `DELETE` 立刻成功，`REVOKE` 后复现 ⇒ `DELETE … WHERE owner_id` 需要读该列，而出厂列清单里没有它。
- 出厂授权原文：`deploy/postgres-cvm/sql/20-login-roles.sql:980` `GRANT SELECT (id,state,revision,error_code,result_ref,updated_at) ON public.jobs …`（六列，**无 `owner_id`**）；`:997` 表级 `DELETE` 有（区 `gy-r71-jobs-ledger-purge-grant`）；`deploy/postgres-cvm/sql/90-assert-least-privilege.sql:1337-1342` 把这份六列清单钉成**期望值**。
- 影响面：①**受理路径**（运行时角色）的 `jobs` 处理器必然失败 ⇒ 该域受理时就记 `blocked`（本片之前永远不自愈，本片之后由时钟补）；②**用运行时角色跑 CLI** 的部署里 `jobs` 一域装不上（端口会诚实跳过并点名）；③生产 cron 用**属主/运维角色**（`docs/verification/gy-r28-w6-deletion-clock-20261021.md:117`：`deletion_requests` 对运行时角色零表级零列级权限 ⇒ 到期枚举必须走属主）⇒ 属主下 8/8 可清，不受影响（`PASS 20` 两种角色都测了）。
- 为什么本片不修：把 `owner_id` 加进列级 `SELECT` 是**授权面扩大**（同时要改 `90-assert` 的期望值与 `20-login-roles.sql:980`），本片红线是零新 GRANT。修法就两处：`:980` 的列清单加 `owner_id`、`90-assert:1338` 的期望数组加 `owner_id`；加完把真库臂 `PASS 20` 的运行时断言从 `['jobs']` 翻成 `[]` 即可（注释里已写明这一点）。

### 6.2 其它边界

- `--dry-run` 只证明**选择集**（闭集是哪些、哪些域装得上），**不证明真删**；真删读数只有 §3.2 的真库臂提供。
- 真库臂要本机 PG 17 二进制（`GY_PG_BIN`），未设置时按既有约定打印 SKIP 并以 77 退出（⛔不接门禁）。CI 走既有接线，本页的真库读数来自本机 `E:\GengYunCommander\.pg17\pgsql\bin`。
- 读面 `services/api/src/privacy/online-state-derivation.ts` **一行未动**：它的判据没变，本片改的是「有没有执行者」。所以「到期没证据 ⇒ `STORE_REJECTED`」在真的没人清时仍然是这个结论——这是对的。
- `community` 仍不在闭集（F13 保留+脱敏，没有「清空行数」这个事实）；`ONLINE_PURGE_MODULES` 直接引 `ONLINE_EVIDENCE_MODULES`，两者不会再分叉。
- 识别的证据颗粒度仍是「域级」：`removed` 是函数回 `records` 的**总行数**（含 selections/jobs 的下挂），不是逐表计数；OCR 的逐表 `tableCounts` 没有进 0031 证据串（`evidence_ref` 的复算口径保持 `(request_id, module, removed, idempotency)` 不变）。

## 7 提交后读数

- 提交 SHA：`6b2bc5b5d56f8115a57e53e1f2a86bed6628e1cb`（`git rev-parse HEAD`），父提交 = base `1b85e69399123b3052427ad6a654d94c89c0c7bf`；分支 `feat/gy-r72-online-purge-closed-set`，**只提交未推送**。
- `git show --stat HEAD`：`7 files changed, 1076 insertions(+), 49 deletions(-)`（复核回退历史行数页之后的最终 diff）；逐文件 `--numstat 1b85e693..HEAD`：

```
231	0	docs/verification/gy-r72-online-purge-closed-set-20261102.md
276	0	services/api/src/privacy/online-purge-port.ts
1	1	services/api/src/privacy/user-data-deletion.ts
184	4	tests/integration/online-purge-pg.mjs
352	0	tests/unit/online-purge-closed-set.test.mjs
18	2	tests/unit/sql-column-coverage.test.mjs
36	42	tools/purge-expired-online-data.mjs
```

- **`services/api/src/privacy/user-data-deletion.ts` 净 0 行**：`1	1`（`wc -l` 前后都是 1499；`services/api/src/privacy/user-data-deletion.ts:1388` 一行等长替换）。既有 docs 里对这份文件的 `path:line` 引用因此**全部仍然成立**，本片没有改任何基线册（`tools/doc-anchors-*.json`、`tests/unit/doc-anchor-relocations.json` 均零改动——见上表无这些文件）。
- 提交后 `doc-anchor-relocation-identity`：`node --test tests/unit/doc-anchor-relocation-identity.test.mjs` ⇒ **exit 0**，`tests 33 / pass 33 / fail 0`（提交前那条「base 与 HEAD 同一提交 ⇒ 没有判定面」的红随之消失）。
- 提交后全量单测：`npm run test:unit` ⇒ **exit 0**，`tests 6300 / pass 6297 / fail 0`（3 条为 skip/todo）。
- 提交后 `sql-column-coverage`：`tests 17 / pass 17 / fail 0`（R72 新宿主以「数组外 `push` 追加」登记：`tests/unit/sql-column-coverage.test.mjs` 自己被 docs 按 `tests/unit/sql-column-coverage.test.mjs:152`、`tests/unit/sql-column-coverage.test.mjs:525`、`tests/unit/sql-column-coverage.test.mjs:1512` 引用，在数组里插条目会把这些历史锚点整片推位；追加式登记对既有行号零影响）。
- 提交后 `verify-doc-anchors.mjs --strict` ⇒ exit 0（`基线外新增 0 条`）。

- **复核订正 ①（回退历史页）**：本片原本把 `docs/verification/gy-r28-w6-deletion-clock-20261021.md:62` 的行数格子改成 306；复核时**回退**——仓规是「不改写历史取证页数字，只在新册留痕」。该数字在本片之前就已陈旧（base 上该 CLI 实测 **312** 行），本片不动它，只在此处留痕。
- **复核订正 ②（散文引用漂移，登记未修）**：`docs/architecture/gy-r59-retention-backup-thirdparty-map.md:32` 写「`:28` keyset 分页」，本片把 CLI 从 312 行改到 306 行后 keyset 那句落在**第 29 行**；**未改**，因为该行正是 `tools/verify-doc-anchors.mjs` 的 DRIFT 基线键（`…gy-r59-retention-backup-thirdparty-map.md:32#online_due_at <= cutoff AND state <> 'completed'`），改它会让基线条失配。下一片若动基线再一并修。

> 说明：本页的 §7 是在第二个提交里回填的（需要先有 SHA 才能写 SHA），所以本页自身所在的那个提交的 SHA 不会出现在正文里——否则会自我指涉失配。
