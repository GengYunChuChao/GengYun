# R28-S71 · 把运行期授权面探针接进 CI：`deploy-sql-17-11` 新增「真跑 + 标记 + 错误条数」一步

> 切片：R28-S71；分支 `test/gy-r28-probe-in-ci`；基线 `upstream/main = 6d7f2af`（S34 建 `deploy-sql-gate.yml`、S64 扩双 job、S42 加误授恢复演练之后）。
> 交付物：`.github/workflows/deploy-sql-gate.yml`（加第 ⑥ 步，`90-assert` 之后、恢复演练之前）、`tests/unit/deploy-sql-gate-probe.test.mjs`（新增静态守卫）、本页。
> 一句话问题：`deploy/postgres-cvm/evidence/probe-runtime-grants.sql` 是本仓「运行期角色到底能碰哪些表 / 列 / 函数」的主证据件（694 行、8 段），但 R28-S71 之前**没有任何 workflow 或测试执行它** —— `git grep -ln "probe-runtime-grants" -- .github/workflows tests` 零命中。它自带 `\set ON_ERROR_STOP 0`（设计如此），**psql 退出码恒为 0**，所以「跑过」不等于「验过」：必须对输出做结构化判据，否则加一步只等于加噪音。本片把「真跑 + 17 条标记逐条 grep + 42501 条数恰好 11」做成每次 PR 必跑的判红门，并用 7 条静态守卫钉死在 workflow 文本里。

**取证范围声明**：本页读数来自**本机一次性 PostgreSQL 17.11 集群**（`127.0.0.1:55664`，datadir `E:\GengYunCommander\.pg17\data-r28s71`），**没有**在 GitHub Actions runner 上执行过；`provision-db.sh` 本体没有运行（它要 root / `runuser -u postgres` / 真实 CVM），而是把它调用的同一串 SQL 在同机上按同一顺序执行（26 个迁移 → 5 组 `services/api/db/roles/*.sql` → `20-login-roles.sql`）。workflow 新增那一步的 `run:` 正文是**逐字抽出来用 Git Bash（`bash -e`）跑的**（抽取器只做「去 YAML 缩进」，不改任何字节），所以 shell 语义、`grep` / `mktemp` / `awk` 行为与 ubuntu runner 一致；差异只可能在 psql 客户端版本与数据库身份，逐条列在 §9。

## 0. 结论摘要

| 项 | 本机读数 |
|---|---|
| 建库：26 个迁移（`0001`…`0026`） | exit **`0`**，`schema_migrations` 计数 **26** |
| 组角色：5 个 `services/api/db/roles/*.sql`（默认 5 组形态） | exit **`0`**；`gengyun_*` 角色 8 个，**没有** `gengyun_source_operator` / `gengyun_staging_importer`（证明是 5 组形态，不是 `--with-cli-groups` 的 7 组） |
| `20-login-roles.sql`（运行时 LOGIN + 列级最小权限） | exit **`0`** |
| `90-assert-least-privilege.sql` | exit **`0`**，末行逐字 **`ok`** |
| **新增那一步**（从 workflow 抽出的 `run:` 正文，`bash -e`） | exit **`0`**；标记 **17/17 全中**；ERROR 行 **11** 条且全部是 `42501`；末行 `探针通过：退出码 0；标记 17 条全中；ERROR 行 11 条且全部是禁止面 42501（期望 11）。` |
| **NC1**：`REVOKE SELECT (id) ON public.favorites FROM gengyun_api_runtime` | 读数 `t → f`；该步 exit **`1`**；ERROR 行 **15**（其中 42501 **15**）⇒ 两条判据同时判红（缺标记 0、条数超出 4） |
| **NC1b**（反向）：`GRANT DELETE ON public.recognition_jobs` | 读数 `f → t`；该步 exit **`1`**；标记 **16/17**（缺 `permission denied for table recognition_jobs`）、ERROR 行 **10**（要求 11）⇒ ②③ 各自独立判红 |
| **NC2**（静态）：把 workflow 里一个标记改成探针源码中不存在的串 | 静态守卫 **⑤ 红**、整体 exit **`1`**；`git checkout` 复原后 `sha256` 与改前**逐位相等**、7/7 绿 |
| 门禁 8 项 | 全绿（命令与退出码见 §8） |

## 1. 范围

### 1.1 做了什么

1. **在 `.github/workflows/deploy-sql-gate.yml` 的 job `deploy-sql-17-11` 里插入第 ⑥ 步**（workflow 第 212–334 行），名字逐字为：

   ```
   授权面探针 probe-runtime-grants.sql（退出码 0 + 标记 + 错误条数）
   ```

   位置是 `90-assert-least-privilege.sql（末行 ok 且退出码 0）` **之后**、`恢复演练：撤销一列授权 → 重跑 20-login-roles.sql → 90-assert 仍 ok` **之前**。为什么不是 job 末尾：`tests/unit/deploy-sql-gate-recovery.test.mjs` 的测试② 钉住「恢复演练必须是 job 的最后一步」，而该文件不在本片允许改动范围内 —— 把探针放末尾会让那边的守卫红（且演练之后跑读数会描述「刚被 REVOKE 又恢复过」的库，含义变味）。该步的 `env` 与其它步相同（`PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD` / `PGDATABASE`，全为合成值），**无** `if:`、**无** `continue-on-error`、**无** `|| true`、**无** `set +e`。
2. **新增 `tests/unit/deploy-sql-gate-probe.test.mjs`**（418 行；纯 Node、零新依赖、按缩进自解析 workflow 文本；不 import 兄弟测试，免得把别人的 `test(...)` 注册进本进程）。7 条：① 步骤存在且真的 `psql … -f "${probe}"`；② 排在 90-assert 之后、恢复演练之前（且演练仍是最后一步）；③ 该步无任何吞红构造、全 workflow 无 `continue-on-error: true`；④ 三条判据齐全（退出码捕获 / 标记逐条 + 汇总 / 42501 条数「恰好」）且判红时 `cat` 全文、`exit 1`；⑤ 标记清单非空、无重复、**每条都能在探针源码里找到出处**、禁止面对象集合恰好 9 个、结构行（`### 0)` / `### 探针结束` / `-- [5]…[8] 探针结束`）一条不少；⑥ `expected_42501` 必须等于**从探针源码重新数出来的**禁止面条数（现在两边都是 11）；⑦ 证据页存在且 workflow 指向它。
3. 本页 ＋ 真跑读数 ＋ 三条负控制（NC0 / NC1 / NC1b / NC2）＋ 八道门禁。

### 1.2 没做什么（边界）

- 没有改 `deploy/postgres-cvm/sql/**`（含 `20-login-roles.sql`、`90-assert-least-privilege.sql`）、`deploy/postgres-cvm/evidence/probe-runtime-grants.sql`、`provision-db.sh`（探针只**调用**）。
- 没有改 `.github/workflows/real-pg-integration.yml`、`tests/unit/ci-real-pg-wiring.test.mjs`（#375 在改），也没有改 `tests/unit/deploy-sql-gate-{forms,recovery}.test.mjs`。
- 没有改 job 里既有的 7 步与双保险判据（`90-assert` 的「退出码 0 且末行 ok」一字未动），只在中间**插入**了一步：`git diff` 对既有行是 0 删除。
- 没有第二个 job（`deploy-sql-17-11-cli-groups`，7 组形态）加同样的步：本片判据按**5 组默认形态**定（`deploy-sql-gate.yml` 的第一个 job 就是 5 组），7 组形态的读数差异（`gengyun_source_operator` / `gengyun_staging_importer` 存在）没有取。
- 没有 push、没有建 PR、没有打 tag（指挥统一收口）。

## 2. 判据口径（三条，任一不成立即 `::error::` + `exit 1`）

| # | 判据 | 挡什么 | 为什么不能省 |
|---|---|---|---|
| ① | `psql` 退出码必须 `0`（`rc=0; if psql …; then rc=0; else rc=$?; fi`） | 连不上库、脚本被截断、psql 自身报错 | 探针文件 :34 把 `ON_ERROR_STOP` 设成 0，**被验的 42501 不会改退出码**；反过来，`psql` 非 0 一定意味着「没跑成」，与授权面无关 |
| ② | 17 条标记逐条 `grep -F -q`，缺一条即红（逐条 `::error::` + 汇总 `::error::`） | 某一段没跑到、脚本被截断、授权面被改动到「读数消失」 | `ON_ERROR_STOP=0` ⇒ 中止不体现在退出码上；只有段落行与具体报错文案能证明「真的走到了那一段」 |
| ③ | ERROR 行数**恰好** `expected_42501=11`；其中 `42501` 也必须恰好 11 | 少报（禁止面被授了权限 / 整段没跑到）与多报（正向语句被误拒权、冒出 `0A000` 之类别的错误类） | 只 grep 标记挡不住「多授权」：禁止面被授了 DELETE 时，段落行照打，少的只是那一条 `permission denied`；只数 42501 又挡不住「错误类变了」 |

三条判据都**没有** `continue-on-error` / `|| true` / `if: always()` 之类出口；判红时先把探针的完整 stdout/stderr `cat` 出来再 `exit 1`（探针输出先用 `mktemp` 落文件，不在管道里丢）。

## 3. 标记清单（17 条）与出处

`markers` 数组在 workflow 第 237–254 行。三条来源：**遍历标记**（段落 `\echo` 行，逐字来自探针）、**授权面读数**（只有授权面正确时才会打印的行）、**禁止面读数**（`VERBOSITY verbose` 下的 `permission denied …` 文案）。

| # | 标记 | 探针出处 | 为什么它只有在授权面正确时才会出现 |
|---|---|---|---|
| 1 | `### 0) 环境` | `:38`（段 0 `\echo`） | 探针一启动就打印；缺它说明**根本没开始跑** |
| 2 | `### 探针结束（exit 码无意义…）` 的前缀 `### 探针结束` | `:694`（最后一行 `\echo`） | 只有读到文件末行才会打印 ⇒ 证明 694 行全过完了 |
| 3 | `-- [5] 收藏／历史／对话域探针结束` | `:440` | 段末 `\echo`：段 5 整段跑完才打印 |
| 4 | `-- [6] 识别域探针结束` | `:534` | 同上（段 6） |
| 5 | `-- [7] 语音域探针结束` | `:609` | 同上（段 7） |
| 6 | `-- [8] 函数面探针结束` | `:691` | 同上（段 8） |
| 7 | `public.idempotency_keys` | `:302-315`（段 4 收尾查询的输出行） | 90-assert **唯一豁免**的表；`20-login-roles.sql` 若把它的表级 `INSERT`/`DELETE` 撤了，段 4 的表级 DML 清单里就没有这一行 |
| 8 | `admin_accounts_rows` | `:671`（段 8a-1 的列头） | `list_admin_accounts()` 的 `EXECUTE` 被拒权时，psql 只打 `ERROR` 不打列头 ⇒ 授段一改这条就没了 |
| 9 | `permission denied for table recognition_jobs` | `:527` | 禁止面：运行时不该有表级 `DELETE`；被授了就变成功、报错行消失 |
| 10 | `permission denied for table recognition_records` | `:528` | 同上 |
| 11 | `permission denied for table recognition_selections` | `:529` / `:530` | 同上（`DELETE` 与 `FOR UPDATE` 两条都指向这张表） |
| 12 | `permission denied for table speech_jobs` | `:604` | 同上 |
| 13 | `permission denied for table transcriptions` | `:605` | 同上 |
| 14 | `permission denied for schema catalog_ops` | `:678` | 运行时连 `catalog_ops` 的 `USAGE` 都没有：拒权发生在**取名阶段**，比函数级 `EXECUTE` 更早 |
| 15 | `permission denied for schema staging_intake` | `:679` / `:680` | 同上（两条 internal 函数都在这张 schema 下） |
| 16 | `permission denied for function consent_policy_immutable` | `:686` | trigger 函数必须不可直接调用；改前是 `0A000`（`trigger functions can only be called as triggers`），改后**必须先** `42501` |
| 17 | `permission denied for function admin_audit_events_reject_mutation` | `:687` | 同上（`0017:335` 已收回 `EXECUTE`） |

> 第 14/15 条的文案是 **schema 级**而不是函数级，这是本机与 CI 的真实读数（运行时没有那两个 schema 的 `USAGE`），不是笔误。探针步的注释里已写明：哪天有人补了 schema `USAGE` 而仍拒 `EXECUTE`，报错文本会变成 `permission denied for function …`，该步会因此判红 —— 那正是一次「授权面被改动，请复核」的信号。

## 4. 为什么 ERROR 行恰好是 11 条

探针**故意**让禁止面报错：每条语句各产生一行 `ERROR:  42501: …`。算式（探针源码逐条相加）：

| 段 | 探针行 | 语句 | 期望条数 |
|---|---|---|---|
| 6 | `:527` | `DELETE FROM public.recognition_jobs WHERE false RETURNING id;` | 1 |
| 6 | `:528` | `DELETE FROM public.recognition_records …;` | 1 |
| 6 | `:529` | `DELETE FROM public.recognition_selections …;` | 1 |
| 6 | `:530` | `SELECT id FROM public.recognition_selections WHERE false FOR UPDATE;` | 1 |
| 7 | `:604` | `DELETE FROM public.speech_jobs …;` | 1 |
| 7 | `:605` | `DELETE FROM public.transcriptions …;` | 1 |
| 8b | `:678` | `SELECT catalog_ops.apply_source_operation(NULL×8);` | 1 |
| 8b | `:679` | `SELECT staging_intake.apply_import(NULL×3);` | 1 |
| 8b | `:680` | `SELECT staging_intake.rollback_import(NULL×4);` | 1 |
| 8c | `:686` | `SELECT public.consent_policy_immutable();` | 1 |
| 8c | `:687` | `SELECT public.admin_audit_events_reject_mutation();` | 1 |
| | | **合计** | **11** |

正向面（段 2 的 `SET ROLE` 零行探针、段 3 对照臂、段 5 收藏/历史/对话、段 6/7 正向、段 8a 两条 runtime 函数）**必须一条 ERROR 都没有** —— 它们中的任何一条被误拒权，条数就会 > 11，判据 ③ 判红。这就是「不多不少」的含义。

## 5. 本机真跑

### 5.1 环境

| 项 | 值 |
|---|---|
| 服务端 / 客户端 | PostgreSQL **17.11**（`E:\GengYunCommander\.pg17\pgsql\bin`）：`postgres (PostgreSQL) 17.11`、`psql (PostgreSQL) 17.11` |
| 集群 | 一次性 `127.0.0.1:55664`，datadir `E:\GengYunCommander\.pg17\data-r28s71`；`initdb -U gengyun_cvm_owner --auth-local=scram-sha-256 --auth-host=scram-sha-256`；`port` / `listen_addresses` / `unix_socket_directories` 写进 `postgresql.conf`，进程用 `Invoke-CimMethod Win32_Process Create` 拉起（**不用** `pg_ctl -o`：PowerShell 会把 `-o` 的参数拆散挂死） |
| 库 / 引导身份 | `gengyun` / `gengyun_cvm_owner`（该集群的超级用户，对应 CI 里 `postgres:17.11` service 的 `POSTGRES_USER`） |
| 迁移 | 26 个文件（`0001`…`0026`），`node services/api/src/db/migrate.ts up`，`schema_migrations` 计数 **26** |
| 组角色 | `services/api/db/roles/` 的 5 个：`auth_privacy` → `catalog_readers` → `consent_granter` → `profile_runtime` → `knowledge_runtime`（顺序照 `provision-db.sh` 的默认 5 组） |
| 运行时口令 | 合成值 `4f3c…2e1d`（48 位小写 hex，仓内 workflow 里本来就是这个合成值；**⛔ 非真实口令**） |
| shell | `D:\Git\bin\bash.exe`（`GNU bash, version 5.2.37(1)-release (x86_64-pc-msys)`），`bash -e <抽出的 .sh>` |
| 抽取器 | 按 workflow 缩进切出该步 `run:` 块正文（去掉 YAML 缩进、不动内容），落仓外 `E:\GengYunCommander\.pg17\tmp\r28-s71\step-07-probe.sh`：**94 行**，`sha256=366525c4c0b183754a0e866b71a75f3111241a96dc10ed1c801e58bf3d0fc592` |

### 5.2 退出码（同一台机、同一集群、同一批 SQL）

```
迁移 26 个            exit 0     schema_migrations = 26
5 个 roles 文件        exit 0     gengyun_* 角色 8 个（无 source_operator / staging_importer）
20-login-roles.sql    exit 0
90-assert             exit 0     末行 = ok
新增那一步（bash -e）   exit 0     17/17 标记；ERROR 行 11（42501 11）
```

新增那一步的本机输出（截取判据相关行）：

```
退出码=0
标记命中：### 0) 环境
标记命中：### 探针结束
标记命中：-- [5] 收藏／历史／对话域探针结束
标记命中：-- [6] 识别域探针结束
标记命中：-- [7] 语音域探针结束
标记命中：-- [8] 函数面探针结束
标记命中：public.idempotency_keys
标记命中：admin_accounts_rows
标记命中：permission denied for table recognition_jobs
标记命中：permission denied for table recognition_records
标记命中：permission denied for table recognition_selections
标记命中：permission denied for table speech_jobs
标记命中：permission denied for table transcriptions
标记命中：permission denied for schema catalog_ops
标记命中：permission denied for schema staging_intake
标记命中：permission denied for function consent_policy_immutable
标记命中：permission denied for function admin_audit_events_reject_mutation
ERROR 行=11（其中 42501=11），期望=11
探针通过：退出码 0；标记 17 条全中；ERROR 行 11 条且全部是禁止面 42501（期望 11）。
```

## 6. 负控制

### 6.1 NC0（附带观测）：根本没跑起来 ⇒ 红

第一次抽出的 `.sh` 在没有把 `.pg17\pgsql\bin` 加进 `PATH` 的 bash 里跑：`psql` 不存在 ⇒ `退出码=127`、标记**全缺**、`ERROR 行=0` ⇒ 该步 `exit 1`。它顺带证明判据 ①②③ 在「没跑成」这一侧是真的，不是摆设（不是本片要求的负控制，仅记录观测）。

### 6.2 NC1：撤一条**真实**授权 ⇒ 必须判红

| 步 | 动作 | 读数 |
|---|---|---|
| 1 | `SELECT has_column_privilege('gengyun_api_runtime','public.favorites','id','SELECT')` | `t` |
| 2 | `REVOKE SELECT (id) ON TABLE public.favorites FROM gengyun_api_runtime` | 同一条探针读数 → `f` |
| 3 | 重跑新增那一步 | **exit `1`**；`ERROR 行=15（其中 42501=15），期望=11`；三条 `::error::`（条数超 4、其中 42501 超 4、汇总判红） |
| 4 | `GRANT SELECT (id) ON TABLE public.favorites TO gengyun_api_runtime`（复原） | 读数回 `t` |
| 5 | 再跑同一份 `.sh` | **exit `0`**，`ERROR 行=11（其中 42501=11）`，17/17 标记 |

多出来的 4 条 42501 全部指向同一张表（探针段 5 的 4 条 favorites 语句都要读 `id`）：

```
psql:deploy/postgres-cvm/evidence/probe-runtime-grants.sql:330: ERROR:  42501: permission denied for table favorites
psql:…:333: ERROR:  42501: permission denied for table favorites
psql:…:335: ERROR:  42501: permission denied for table favorites
psql:…:336: ERROR:  42501: permission denied for table favorites
```

> 这条负控制与 S42 的恢复演练互补：S42 证明「撤了之后重跑 `20-login-roles.sql` 能恢复」，本片证明「撤了之后**探针步会当场判红**」（不重跑 roles 就不会绿）。

### 6.3 NC1b（反向）：多授一条禁止面权限 ⇒ 也必须判红

| 步 | 动作 | 读数 |
|---|---|---|
| 1 | `GRANT DELETE ON TABLE public.recognition_jobs TO gengyun_api_runtime` | `has_table_privilege(...,'DELETE')` → `t` |
| 2 | 重跑新增那一步 | **exit `1`**；标记 **16/17**（缺 `permission denied for table recognition_jobs`）；`ERROR 行=10（其中 42501=10），期望=11` |
| 3 | `REVOKE DELETE ON TABLE public.recognition_jobs FROM gengyun_api_runtime` | 读数回 `f` |
| 4 | 再跑 | **exit `0`**，17/17、11/11 |

它验证的是「**少报**」方向：只写 `> 0 就绿`、或只数标记条数的判据在这里会漏；「恰好等于 11」与逐条标记两个判据各自独立判红。

### 6.4 NC2：改坏一个标记 ⇒ 静态守卫必须红

| 步 | 动作 | 读数 |
|---|---|---|
| 1 | 记录改前 `sha256` | `4daa565691fc39140b0a5af81b55893033f8f364c299d2e068a3c14d253d47d7` |
| 2 | 把 workflow 里 `'### 探针结束'` 改成 `'### 探针结束-typo'`（探针源码里不存在该串） | 文件 `sha256` → `b8b9b139f1bc82a14598ed1fe5b9ee743df8e7c8930bf1bc9f6ea506303daea6` |
| 3 | `node --test --test-concurrency=1 tests/unit/deploy-sql-gate-probe.test.mjs` | **⑤ 红**（「在探针源码里搜不到这一行」）、整体 exit `1` |
| 4 | `git checkout -- .github/workflows/deploy-sql-gate.yml` 复原 | `sha256` 回到 `4daa5656…d47d7`，与改前**逐位相等** |
| 5 | 再跑 | 7/7 绿 |

## 7. 静态守卫与 workflow 的边界（诚实声明）

- 本文件（`tests/unit/deploy-sql-gate-probe.test.mjs`）**只做文本/结构判定**：它不证明这条路在真实 PG 上跑得通，也不证明 GitHub runner 上的 `postgres:17.11` service 与 `20-login-roles.sql` 的交互与 §5 完全一致。真实读数由本页 §5/§6 承担，runner 上的首次执行要等 PR 的 CI。
- **仓内没有 YAML 解析库**（实测 `node_modules` 里 `yaml` / `js-yaml` 均 `MISSING`，`tools/run-python.mjs` 里也没有 PyYAML：`ModuleNotFoundError: No module named 'yaml'`）。因此 workflow 的 YAML 合法性只能靠三重旁证，**没有**做「真正 YAML 解析器」级别的校验：
  1. 三个静态守卫测试都按**缩进**自解析同一份文件（既有 `deploy-sql-gate-recovery.test.mjs` 8 条、`deploy-sql-gate-forms.test.mjs` 10 条、本片 7 条），全部绿 ⇒ job 块、step 边界、`run:` 块体缩进都能被独立解析出来；
  2. 本片用的抽取器把同 job 的 7 个 step 全部切出来（`0/1` 缩进对得上、无「未命名 step」告警），并逐字节写出 `.sh`；
  3. 新增那步与既有 `90-assert` 步**逐行同构**：`      - name:`（6 空格）、`        run: |`（8 空格）、正文 10 空格、`env:` 五键同形。
- 本页与守卫都**不写死**「断言条数」「标记条数以外的数字」：唯一写死的数字是 `expected_42501=11`，而它由 ⑥ 每次从探针源码重新数出来比对。

## 8. 门禁（命令 + 退出码）

本机（Windows + PowerShell 5.1，node 24.16.0 / npm 11.13.0）实跑，退出码取自命令本身（不经 `Start-Process` 之类包装）：

| # | 命令 | 退出码 | 读数 |
|---|---|---|---|
| G1 | `npm run lint` | **0** | `tsc --noEmit` 两个工程均 PASS；仓库卫生扫描 PASS |
| G2 | `node tools/verify-release-materials.mjs` | **0** | `15/15 项通过`（本机无 WSL 发行版，脚本内部的 `bash -n` 回退路径会打 4 行 `wsl: …` 到 stderr，属环境噪音，不影响判决） |
| G3 | `npm run test:docs` | **0** | 发展文档校验 PASS；研究记录 `5 通过 / 0 失败 / 4 legacy 已钉住` |
| G4 | `node tools/verify-contract-status.mjs` | **0** | 覆盖 112 条契约操作；形状错误 0 项、语义错误 0 项；中文表格一致 |
| G5 | `node --test --test-concurrency=1 "tests/contract/*.test.mjs"` | **0** | `tests 6 / pass 6 / fail 0` |
| G6 | `node --test --test-concurrency=1 tests/unit/deploy-sql-gate-probe.test.mjs` | **0** | `tests 7 / pass 7 / fail 0`（本片新增） |
| G7 | `node --test --test-concurrency=1 tests/unit/deploy-sql-gate-forms.test.mjs tests/unit/deploy-sql-gate-recovery.test.mjs` | **0** | `tests 18 / pass 18 / fail 0`（既有两条守卫仍绿：形态 10 条 + 恢复演练 8 条） |
| G8 | `git diff --check` | **0** | 无空白错误（暂存后再跑 `git diff --cached --check`，同样 0） |

## 9. 未取得项与已知边界

1. **没有在 GitHub Actions runner 上真跑**。本页所有读数来自本机一次性 PG 17.11；runner 上是 `postgres:17.11` service 容器 + `POSTGRES_USER=gengyun_cvm_owner`（superuser），首次真实执行要等 PR 的 CI。
2. **`provision-db.sh` 本体没有运行**（要 root / `runuser -u postgres` / 真实 CVM）。本机执行的是它调用的同一串 SQL（26 迁移 + 5 组 roles + `20-login-roles.sql`）与同一顺序；它与脚本的差异（例如 `verify-cvm-postgres.sh` 才有的一致性检查）不在本片范围。
3. **本机 `pg_ctl -o` 用不了**：PowerShell 5.1 会把 `-o` 后面的参数拆开导致挂死，所以集群是「改 `postgresql.conf` + `Invoke-CimMethod Win32_Process Create`」拉起的；这一差异不影响 SQL 读数，但意味着本页的启动方式不能照抄进 Linux 脚本。
4. **7 组形态（`deploy-sql-17-11-cli-groups`）没有接这一步**：本片判据按 5 组默认形态定；7 组形态下 `gengyun_source_operator` / `gengyun_staging_importer` 存在，探针段 8 的 `non_owner_grantees` 会多出行，但 11 条禁止面与 17 条标记的口径是否完全一致**没有实测**。
5. **没有做「探针源码里新增一段」的正向实验**：⑥ 的交叉校验是用「从源码数条数」实现的，本片只验证了它与 workflow 常量一致（11 = 11），没有真的给探针加一段禁止面来看守卫是否按预期先红（那要改 `deploy/postgres-cvm/evidence/probe-runtime-grants.sql`，本片不允许）。
6. **YAML 合法性没有解析器级证明**（见 §7）：若将来引入 `yaml` 依赖，应把「解析后断言 step 顺序」加进守卫。
