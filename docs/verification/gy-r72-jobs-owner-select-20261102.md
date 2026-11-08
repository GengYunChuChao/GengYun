# GY-R72 · `public.jobs` 的 `owner_id` 列级 SELECT（授权面 / 断言面 / 读面三处对齐）

- 片号：R72-W64（分支 `fix/gy-r72-jobs-owner-select`，基座 `52d1e90d`）
- 日期：2026-11-02
- 范围：`deploy/postgres-cvm/sql/20-login-roles.sql`、`deploy/postgres-cvm/sql/90-assert-least-privilege.sql`、
  `services/api/src/privacy/online-purge-port.ts`、两处真库臂断言、一条新钉子 + 本页
- 不涉及：迁移（零迁移）、表级 SELECT、INSERT/UPDATE 列清单、`skippedModules` 机制

## 0 结论（先读这段）

1. **缺陷**：注销清理的删除语句是 `DELETE FROM public.jobs WHERE owner_id = $1::uuid`
   （`services/api/src/jobs/ledger.ts:387`）。PostgreSQL 对 `DELETE` 的 **WHERE 里出现的列**另要 SELECT 权；
   表级 `DELETE` 早已授予（`deploy/postgres-cvm/sql/20-login-roles.sql:997` 的 `gy-r71-jobs-ledger-purge-grant`），
   但列级 SELECT 的出厂清单只给了 upsert 需要的 6 列、**没有 `owner_id`**
   ⇒ 用运行时角色跑这条清理必然 `42501 permission denied for table jobs`。
2. **修法**：那份列清单 6 → 7 列只加 `owner_id`（仍是**列级**，不升表级 SELECT），
   `90-assert` 的 `expected('jobs')` 期望清单同步 6 → 7（同一事实的两次写法），
   并把「运行时角色下 `jobs` 该被跳过」的两条真库断言翻成「8/8 无跳过」。
3. **真库读数**：本机隔离集群（PostgreSQL 17.11，单表 `public.jobs`，施加仓库两个 `#region` 的**原文**）
   实测——旧 6 列形状下同一条 `DELETE` ⇒ `SQLSTATE 42501`（`aclcheck_error, aclchk.c:2845`），
   7 列形状下 ⇒ `DELETE 0` / `SQLSTATE 00000`；`REVOKE SELECT (owner_id)` 后立刻复现 42501（负控制）。
   **仍未证明**的是部署面（既有库的水位、真实角色链与凭据、CI 两臂的串联时序）——那由 CI 的
   `consent-grant-postgres-17.11` 臂判定，本页不代替它。另外两个真库臂已在本机隔离集群**真跑通过**：
   `egress-ledger-pg.mjs` PASS 13 组（其中 PASS 3 读到的正是「15+5+7 列权限、无表级 DML」）、
   `online-purge-pg.mjs` PASS 23 组（其中 PASS 20 读到的正是「运行时角色 8/8、skipped=[]」）。
4. **授权面扩大，谁追认**：R72 指挥在本片派单里追认。

## 1 缺陷：为什么这条 `DELETE` 会 42501

### 1.1 语句与授权的两层结构

| 面 | 语句 / 授权 | 文件 |
| --- | --- | --- |
| 删除面（表级） | `GRANT DELETE ON public.jobs TO gengyun_api_runtime;` | `deploy/postgres-cvm/sql/20-login-roles.sql:997` |
| 谓词列（列级 SELECT） | `GRANT SELECT (id,state,revision,error_code,result_ref,updated_at) ON public.jobs …`（修前 6 列） | `deploy/postgres-cvm/sql/20-login-roles.sql:980` |
| 用它的语句 | `JOB_LEDGER_PURGE_SQL = 'DELETE FROM public.jobs WHERE owner_id = $1::uuid'` | `services/api/src/jobs/ledger.ts:387` |

PG 的权限判定不是「有 DELETE 就能删」：`DELETE … WHERE <col>` 要先按 `<col>` 过滤行，
所以 `<col>` 上另要 SELECT 权。表级 DELETE 只覆盖「删行」这一件事，不覆盖「读谓词列」。

### 1.2 反证：同角色的 `DELETE … WHERE false` 成功

`WHERE false` 不引用任何列 ⇒ 不需要列权 ⇒ 同一条表级 DELETE 授权下它**成功**。
这正是**缺陷能漏过 90-assert 的原因**：那里的零行正探针就是
`DELETE FROM public.jobs WHERE false;`（`deploy/postgres-cvm/sql/90-assert-least-privilege.sql:159`）——
它证明「表级 DELETE 授了」，但永远证明不了「谓词列可读」。列清单本身是
`expected('jobs')` 的**期望值**（`deploy/postgres-cvm/sql/90-assert-least-privilege.sql:1356`），
它只能核对「授了哪几列」，核对不了「够不够用」——够不够用得靠真跑那条语句（真库臂）。

### 1.3 本机实测（隔离集群，单表）

```
PostgreSQL 17.11 on x86_64-windows, compiled by msvc-19.44.35228, 64-bit
（initdb 到 .pg17/tmp/r72-w64-pg/data，127.0.0.1:54519，实验后已 stop 并删除数据目录）
```

| 步骤 | 命令要点 | 读数 |
| --- | --- | --- |
| ① 旧形状授权（6 列 + INSERT/UPDATE + 表级 DELETE） | `psql -f grants-old.sql` | 4×`GRANT`，exit 0 |
| ② 旧形状下按 owner 删 | `SET ROLE gengyun_api_runtime; DELETE … WHERE owner_id = '0193a0f0-…-0000000000aa'::uuid` | `ERROR: 42501: permission denied for table jobs`（`LOCATION: aclcheck_error, aclchk.c:2845`） |
| ③ 旧形状下 `WHERE false` | 同角色 `DELETE … WHERE false` | `DELETE 0`、`SQLSTATE 00000` |
| ④ 旧形状列权读数 | `has_table_privilege(...,'DELETE')` / `has_column_privilege(...,'owner_id','SELECT')` | `t` / `f` |
| ⑤ 施加仓库现值（7 列 + 表级 DELETE，两区原文） | `psql -f grants-new.sql` | 4×`GRANT`，exit 0 |
| ⑥ 修后按 owner 删 | 同 ② | `DELETE 0`、`SQLSTATE 00000` |
| ⑦ 修后列权读数 | 同 ④ | `t` / `t` |
| ⑧ 负控制：`REVOKE SELECT (owner_id)` | `psql -f revoke-owner.sql` | `REVOKE`，随后同 ② 又 `SQLSTATE 42501` |

`grants-old.sql` / `grants-new.sql` 的内容不是手抄：前者是把仓库现值那一行的 `,owner_id` 去掉，
后者是从 `deploy/postgres-cvm/sql/20-login-roles.sql` 的两个 `#region` 里**逐字**抽出的可执行 SQL
（`gy-r71-jobs-ledger-grant` + `gy-r71-jobs-ledger-purge-grant`，注释行剔除）。
表格只建了 `public.jobs` 一表、**去掉了外键与 CHECK**（权限判定只认列名，不认约束）⇒
本实验证明的是「这条语句需要那一列」，不是「整套部署跑得通」。

## 2 授权前后对照

| 项 | 修前 | 修后 |
| --- | --- | --- |
| `public.jobs` 的列级 SELECT | `id,state,revision,error_code,result_ref,updated_at`（6 列） | 同 6 列 **+ `owner_id`**（7 列） |
| 表级 SELECT / INSERT / UPDATE / TRUNCATE | 无 | **无**（不变） |
| INSERT 列清单（15 列） | 15 列 | 不动 |
| UPDATE 列清单（5 列） | 5 列 | 不动 |
| 表级 DELETE | 已授（`gy-r71-jobs-ledger-purge-grant`） | 不变 |
| `90-assert` 的 `expected('jobs')` sel | 6 列 | 7 列（与部署侧逐列同值） |
| 迁移 | — | **零迁移** |

「6 列」与「+1 列」是**两笔不同来源**，写注释时不要合并成「7 列全是 upsert 的」：

- 6 列 = 冲突目标 `id` + `WHERE` 读的 `state` + `ON CONFLICT (id) DO UPDATE` 的 5 个 SET 列
  （`ON CONFLICT … DO UPDATE` 会让 PG 读旧行 ⇒ 每个 SET 列都要可 SELECT）；
- +1 列 = 注销清理 `DELETE … WHERE owner_id` 的谓词列。

## 3 为什么是最小面

1. **只加一列，且是谓词列**：`owner_id` 是这条 DELETE 的过滤条件，PG 非要它不可；
   不给就 42501，给了没有任何「多读一行」的可能——它进不了任何 SELECT 投影。
2. **不升表级 SELECT**：表级 SELECT 会一次性打开全部 22 列（含 `actor_admin_id`、`consent_epoch`、
   `lease_token`、`target_id`、`result_ref` 等私有字段），把 R34 裁定 3「台账零读者」的结论直接推翻；
   本片只放开一条 DELETE 的谓词列，读面仍是零
   （`tests/unit/jobs-owner-id-grant-scope.test.mjs:161` 的 T3 逐文件扫 `services/api/src` 的 `FROM public.jobs`）。
3. **不动 INSERT/UPDATE 列清单**：upsert 的 15 + 5 列是按语句逐列反推出来的既有结论，
   本片没有新写入面，动它只会制造无关的授权漂移。
4. **零迁移**：`public.jobs` 的列早已存在（`services/api/db/migrations/0001_initial_schema.sql`），
   缺的是「授权」，不是「列」。
5. **断言面同源**：`20-login-roles.sql` 与 `90-assert` 是同一事实的两次写法（有意的重复），
   本片两处同时改；T2 把「两处逐列同值」变成可执行断言，往后再漂就会红。

## 4 同步改到的断言面

| 位置 | 修前 | 修后 | 理由 |
| --- | --- | --- | --- |
| `tests/integration/egress-ledger-pg.mjs:402` | `SELECT: [ … 6 列 ]` | `SELECT: [ … + 'owner_id' ]` | 该臂按 `#region` 抽文本自建角色后**真查** `has_column_privilege`，列数要跟授权同源 |
| `tests/integration/egress-ledger-pg.mjs:414` | `length === 26`（15+5+6） | `length === 27`（15+5+7） | 同上，读数条数 |
| `tests/integration/online-purge-pg.mjs:1281` | 断言「运行时角色下只有 `jobs` 被跳过、reason 含 `owner_id`」 | 断言「`skippedModules` 为 `[]`、`modules` 等于 `ONLINE_PURGE_MODULES`（8/8）」 | 授权补齐后该域装得上；若又缺回 `owner_id`，这条断言会红（探测仍在 port 里） |
| `tests/unit/online-purge-closed-set.test.mjs:182` | 注释说「这正是出厂授权的实测形状」 | 注释改成「GY-R72 **修好之前**的出厂形状」 | 断言本身不动：假池 `{table_delete:true, owner_select:false}` 仍必须只跳 `jobs` |
| `services/api/src/privacy/online-purge-port.ts:147` | 失败文案只说「出厂列清单未含它」 | 文案改成「自 GY-R72 起应为 7 列含 `owner_id`；当前库缺这一列即必然 42501」并指向本页 | 探测保留、`skippedModules` 机制一字未动 |

## 5 新钉子（形状判据，四条）

`tests/unit/jobs-owner-id-grant-scope.test.mjs`：不钉行数、不钉条目总数，只钉形状与集合。

| 钉子 | 量法 | 位置 |
| --- | --- | --- |
| T1 授权面 | 从 `20-login-roles.sql` 抽 `gy-r71-jobs-ledger-grant` 区、剔注释，断言：恰好一条 `GRANT SELECT (…) ON public.jobs TO <role>`、角色是 `gengyun_api_runtime`、列集合 == 7 列（含 `owner_id`）、区内**无**表级 `GRANT … ON public.jobs`、**无** `DELETE`/`TRUNCATE`、语句恰好三条且前缀是 SELECT/INSERT/UPDATE | `tests/unit/jobs-owner-id-grant-scope.test.mjs:82` |
| T2 断言面 | 从 `90-assert` 的 `expected(tbl, sel, ins, upd, del)` 里取 `('jobs', …)` 元组，断言 `sel` 与 T1 的授权列**逐列同值**、`del` 仍是 `true`、INSERT 面仍含 `owner_id`、UPDATE 面仍是那 5 列 | `tests/unit/jobs-owner-id-grant-scope.test.mjs:128` |
| T3 读面 | 递归扫 `services/api/src/**/*.ts` 的每个 `FROM public.jobs`，回看当前语句片段（切到分号/引号），断言**全部**是 `DELETE` 且无 `SELECT`；再断言 `online-purge-port.ts` 仍保留 `has_column_privilege(…,'public.jobs','owner_id','SELECT')` 探测、且该文件没有 `SELECT … FROM public.jobs` | `tests/unit/jobs-owner-id-grant-scope.test.mjs:161` |
| T4 语句面 | 直接 import `JOB_LEDGER_PURGE_SQL`，断言逐字等于 `DELETE FROM public.jobs WHERE owner_id = $1::uuid`、带 `owner_id` 谓词、无 `RETURNING` | `tests/unit/jobs-owner-id-grant-scope.test.mjs:202` |

### 5.1 三条负控制（真做 + 副本还原 + sha256）

| 控制 | 改动 | 读数 | sha256（改前 / 还原后） |
| --- | --- | --- | --- |
| NC1 | 把 `deploy/postgres-cvm/sql/20-login-roles.sql:980` 的 `,owner_id` 删掉 | `tests 4 / pass 3 / fail 1`，红的只有 **T1** | `52AE32F77A9415E4B526176967A0EC307D5FCDDAE6D484977C78343547B7B698` / 同值 |
| NC2 | 只把 `90-assert:1356` 的 `'owner_id'` 删掉（`20-login-roles.sql` 保持修好态） | `tests 4 / pass 3 / fail 1`，红的只有 **T2** | `4801C875AA92F89C4387C078D2492C0D01A943AC36C74F83B79175B4A6F5FE95` / 同值 |
| NC3 | 把 `JOB_LEDGER_PURGE_SQL` 改成 `DELETE FROM public.jobs` | `tests 4 / pass 3 / fail 1`，红的只有 **T4** | `B6B8C287C9392F2ABC5CDD98653AB4E061C2BF77FAEDD88B04A1143210820F44` / 同值 |

三次都还原后复跑 `node --test tests/unit/jobs-owner-id-grant-scope.test.mjs` ⇒ `tests 4 / pass 4 / fail 0`。

### 5.2 门禁读数（本机实测）

- `node --test tests/unit/jobs-owner-id-grant-scope.test.mjs` ⇒ `tests 4 / pass 4 / fail 0`。
- `node --test tests/unit/online-purge-closed-set.test.mjs tests/unit/sql-column-coverage.test.mjs tests/unit/jobs-ledger-deletion.test.mjs`
  ⇒ `tests 33 / pass 33 / fail 0`（其中 `sql-column-coverage` 单跑 `tests 17 / pass 17 / fail 0`）；
  四个文件一起跑 ⇒ `tests 37 / pass 37 / fail 0`。
- `node tools/verify-doc-anchors.mjs --strict --scan docs` ⇒ exit 0（`BARE-ORPHAN 基线外新增 0`、
  `ANCHOR-COUNT 计数下降 0 份`、`DRIFT-BASELINE 基线外新增 0`）；
  `node tools/verify-doc-anchors.mjs --strict --symbol=strict --scan docs` 亦 exit 0（`SYMBOL-STRICT-BASELINE 基线外新增 0`）。
- `node tools/verify-contract-status.mjs`（**不带** `--check`）⇒ exit 0：127 条契约操作全覆盖、形状/语义错误 0、中文表格一致。
- `npm run test:docs` ⇒ exit 0；`npm run test:contract` ⇒ `tests 22 / pass 22 / fail 0`；
  `npm run lint` ⇒ 两个 `tsc --noEmit` 工程 PASS + 仓库卫生扫描 PASS。
- `npm run test:unit` 全量 ⇒ `tests 6347 / pass 6345 / fail 0 / skipped 2`（设 `GY_PG_BIN` 指到本机 PG 17.11 的 bin；
  不设时 `pass 6344 / skipped 3`，多出的那条正是「找不到 PG 二进制就 SKIP」）。两条 skip 的实因：
  `doc-anchor-relocation-identity` 的位移用例（本次文档提交只有新增行、没有位移面）与一条 privacy 用例
  （`native separate-connection withdrawal and account state changes at guarded read boundary`）。
- **两个真库臂在本机隔离集群真跑通过**（不是 skip、不是替身）：
  - `tests/integration/egress-ledger-pg.mjs`（先建空库 `gengyun_egress_test`，库名/回环/空库三条硬前置都满足；
    脚本自己跑 0001/0003/0008/0009/0011 + 0011 的 up→down→up）⇒ `RESULT=PASS 13 组`；其中 **PASS 3** 就是本片读数：
    「`public.jobs` 台账授权与部署侧同源：只有 15+5+7 列权限，无表级 DML、无 DELETE、无多余列」。
  - `tests/integration/online-purge-pg.mjs`（`GY_PG_BIN` + `GY_I19_PG_ROOT`；脚本自建集群与角色）⇒ `EXITCODE=0（共 23 组 PASS）`；
    其中 **PASS 20** 是本片翻转的那条：「端口可用性按角色如实：属主角色 8/8 可清（skipped=[]）；运行时角色 8/8」。

### 5.3 与派单不符的仓库事实：`sql-column-coverage` 的读数**没有** +1

派单预期「该文件的读数按 main 现值 +1」。实测**不改**：只把 `deploy/postgres-cvm/sql/20-login-roles.sql:980` 的 SELECT 列清单加上 `owner_id` 后，
`tests/unit/sql-column-coverage.test.mjs` 的读数与改前**逐字相同**——
基线面 25 表 / 列权限要求 1272 / 已覆盖 1272 / 缺 0；扩展面 52 表 / 2079 要求 / 1978 已覆盖 / 缺 0 / 豁免 63；
覆盖来源 列级 1224 + 表级 48（扩展：1851 + 127）。

原因在解析器：`collectRequirements` 对 `DELETE` **只**产出一条 `TABLE_WIDE_COLUMN`（`'*'`）的 DELETE 需求
（`tests/unit/sql-column-coverage.test.mjs:1959`：`if (statement.verb === 'DELETE') add(statement, TABLE_WIDE_COLUMN, 'DELETE', …)`），
**DELETE 的 WHERE 列不产生 SELECT 需求** ⇒ 给 DELETE 补谓词列的 SELECT 权，不会改变任何被钉死的读数。
该测试里也没有「每表授权列数」这类钉子。本片因此**没有**改任何读数；如果哪天有人「按 +1 去改」，
那才是把真实读数改坏。

## 6 边界与后续

- **这不是「42501 已在生产修好」的结论**：本页的真库读数来自**本机隔离集群**（PG 17.11、仅回环、空库、
  脚本自建角色），两个真库臂已在这套隔离环境里真跑通过；但**部署面**（真实迁移集、真实角色链与凭据、
  CI 上两个臂的串联时序）仍由 CI 的 `consent-grant-postgres-17.11` 判定。
- 若将来收紧这条授权（例如把 `owner_id` 从列清单里拿掉），**三处必须同改**：
  `20-login-roles.sql:980` 的列清单、`90-assert:1356` 的期望清单、`tests/integration/egress-ledger-pg.mjs:402` 的读数数组；
  漏一处就会被 T1/T2 或真库臂抓住。
- `owner_id` 进列级 SELECT 后，`public.jobs` 的**读面依旧为零**（T3 逐文件守）；
  `/admin/jobs` 仍只读三张域内表，R34 裁定 3 不变。
- 本片不动 `skippedModules` 机制：探测仍在 `services/api/src/privacy/online-purge-port.ts:147`，
  缺授权时该域照旧「只跳过自己并点名缺的那条」，⛔ 不退化成整轮失败。
- 本机未覆盖的只有两件：①本页用的库是**新建**的（既有库的水位/残留角色不在读数里）；②CI 上两个臂的**串联时序**
  （`EGRESS_LEDGER_KEEP=1` 那段与后继 `egress-object-key-pg.mjs` 共享夹具）。本页给出的是「同一批 SQL 文本、
  同一版本 PG、脚本自带的全量迁移」上的端到端读数。
