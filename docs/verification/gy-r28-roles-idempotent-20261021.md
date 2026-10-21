# R28-S48 · 建组 SQL 幂等化（裸 `CREATE ROLE` → `pg_roles` 守卫 + 收敛 `ALTER ROLE`）

> 切片：R28-S48；分支 `test/gy-r28-roles-idempotent`；基线 `c0217a4`（`test(ci): 把 account-suspend-pg 接进真库 CI（受管清单第 9 条）(#353)`）。
> 交付物：`services/api/db/roles/*.sql` 8 个文件（**11 条**建角色语句）＋ `tests/unit/roles-bootstrap-idempotent.test.mjs`（4 条测试，含 2 条内存负控制）＋ 本页。
> 一句话问题：`provision-db.sh:265-291` 的建组段直接 apply `services/api/db/roles/*.sql`，而那 8 个文件里躺着 **11 条裸 `CREATE ROLE`**。只要角色已存在（重跑引导，或上一次在 `20-login-roles.sql` 之后中断），psql 就以 `42710 role "…" already exists` 退出码 3 停住——「`provision-db.sh` 可重跑」这件事从来没有成立过。

**取证范围声明**：本页所有读数来自本机**一次性 PG 17.11 集群**（`127.0.0.1:55655`，datadir `E:\GengYunCommander\.pg17\data-r28s48`）；**没有**在 GitHub Actions runner 或真实 CVM 上跑过。`provision-db.sh` 本体**没有执行**（它要 root / `runuser -u postgres` / 真实 CVM），本页是把它的**同一串命令**（26 迁移 → 8 组角色 → `20-login-roles.sql` → `90-assert-least-privilege.sql`）在 Git Bash（`D:\Git\bin\bash.exe`，GNU bash 5.2.37 msys）里逐条重放。未取得项与需裁定项逐条列在 §10。

## 0. 结论摘要

| 项 | 读数 |
|---|---|
| 改造面 | 8 个文件、**11 条** `CREATE ROLE` → 11 个 `pg_roles` 守卫块（`DO $role_guard$ … $role_guard$;`）＋ 11 条 `EXECUTE 'CREATE ROLE …'` ＋ 11 条紧随的 `ALTER ROLE … WITH <同属性>`。`git diff --stat` = **8 files changed, 104 insertions(+), 11 deletions(-)** |
| 真库双跑（新文件） | 第一遍 **8/8 rc=0**、第二遍 **8/8 rc=0**；`20-login-roles.sql` 建出 LOGIN 角色之后**再跑第三遍 8/8 rc=0**（顺序无关） |
| 改前负控制（旧文件第二遍） | **rc=3**，`ERROR:  role "gengyun_auth_privacy" already exists` |
| 引导链尾 | `20-login-roles.sql` **两遍 rc=0**；`90-assert-least-privilege.sql` **rc=0、末行 `ok`**，断言计数 **83 / 83 / 0**（派单写 104，差异见 §2.2） |
| 漂移收敛 | 手工把 `gengyun_egress_ledger` 改成 `LOGIN CREATEDB CREATEROLE` → 重跑该文件 → 回读 `rolcanlogin / rolcreatedb / rolcreaterole = f / f / f` |
| 静态守卫单测 | 4/4 通过（`pass 4 / fail 0`），含 2 条内存负控制（换回裸 `CREATE ROLE`；守卫 `rolname` 改错一个字符） |
| `GRANT` / `REVOKE` | **零改动**：`git diff` 的全部 104 行增量里没有一行 GRANT/REVOKE（§5.6 机检） |
| 门禁 7 道 | 全绿（§9） |

## 1. 范围

### 1.1 做了什么

1. `services/api/db/roles/*.sql` 的 **11 条**裸 `CREATE ROLE` 全部改成两段式：`DO` 块里 `IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '<角色>') THEN EXECUTE 'CREATE ROLE <角色> <属性串>'; END IF;`，紧随一条 `ALTER ROLE <角色> WITH <属性串>;` 做**已存在但属性漂移**的收敛。
2. 新增 `tests/unit/roles-bootstrap-idempotent.test.mjs`（206 行）：静态审计 8 个文件，断言「8 文件 / 11 条建角色 / 全部有守卫 / 守卫名与 `CREATE ROLE` 名逐条同名 / 每条 `CREATE ROLE` 后紧邻同属性 `ALTER ROLE`」，并带 2 条内存负控制证伪。
3. 真库（PG 17.11，一次性集群）取证：26 迁移 → 8 个角色文件跑三遍 → `20-login-roles.sql` 跑两遍 → `90-assert-least-privilege.sql` 判定为绿；外加改前旧文件负控制与漂移收敛。
4. 本页 ＋ `.pg17/handoff/r28-s48-report.md`。

### 1.2 没做什么（边界）

- **没有动任何 `GRANT` / `REVOKE`**，也没有动 `deploy/postgres-cvm/sql/20-login-roles.sql`、`90-assert-least-privilege.sql`、`provision-db.sh`、`migrate.ts`。本片只改「建角色」这 11 句的形态。
- **没有 push、没有建 PR、没有打 tag**；只提交一个 commit。
- **没有**在真实 CVM / GitHub Actions runner 上执行（§10 第 1 条）。
- **没有**改 `tests/integration/account-suspend-pg.mjs`（它有一条「角色文件里 `CREATE ROLE` 必须裸写」的正则，会被本片改变形态打到——见 §10 第 2 条，需指挥拍板，故**不动**）。
- **没有**扩大断言面：`90-assert-least-privilege.sql` 一行未改，因此它的断言数仍是基线的 83（§2.2）。

## 2. 口径更正与两处读数差异（如实登记）

### 2.1 建角色条数：派单初稿写「9 条」，实测 **11 条**，按 11 条执行

派单初稿与单测断言数都写 9 条。逐文件复核：

```
$ git grep -c '^CREATE ROLE ' c0217a4 -- services/api/db/roles/
c0217a4:services/api/db/roles/auth_privacy.sql:1
c0217a4:services/api/db/roles/catalog_readers.sql:2
c0217a4:services/api/db/roles/consent_granter.sql:1
c0217a4:services/api/db/roles/egress_ledger.sql:1
c0217a4:services/api/db/roles/knowledge_runtime.sql:1
c0217a4:services/api/db/roles/profile_runtime.sql:1
c0217a4:services/api/db/roles/source_operator.sql:2
c0217a4:services/api/db/roles/staging_importer.sql:2        # 1+2+1+1+1+1+2+2 = 11
```

派单表格逐行求和同样是 11——「9」是笔误。**本片按 11 条全改，单测断言数 = 11**。若只改 9 条，剩下 2 个角色第二遍仍以 `42710` 失败，「`provision-db.sh` 可重跑」这个目标就不成立。

### 2.2 `90-assert` 断言计数：派单写 `104|104|0`，本树实测 **`83|83|0`**

| 口径 | 派单 | 实测（基线 `c0217a4` + 本片改动） |
|---|---|---|
| `SELECT count(*), count(*) FILTER (WHERE ok IS TRUE), count(*) FILTER (WHERE ok IS NOT TRUE) FROM r28_assert_results` | `104 / 104 / 0` | **`83 / 83 / 0`** |
| `90-assert-least-privilege.sql` 整文件（`ON_ERROR_STOP=1`） | exit 0、末行 `ok` | **exit 0、末行 `ok`** ✔ |

差异原因（可复核，不是本片造成的）：

- 断言行由 `90-assert-least-privilege.sql` 内部的静态 CTE/VALUES 展开决定，与库内容无关；本分支基线上该文件 `wc -l` = **2160** 行，实测稳定产出 83 条。
- `104` 与 `.pg17/handoff/r28-s45-report.md` 记录的 S45 树读数一致；那棵树的同名文件 `wc -l` = **2584** 行（`E:\GengYunCommander\wt-r28-s45` 仍在盘上，可直接复核），本分支基线没有那批断言（S43/S45 等后续切片的增量未合入本分支）。
- 本片**未改** `90-assert-least-privilege.sql`（`git diff` 不含它），所以计数只能等于基线值。

**结论**：本片按「exit 0 ＋ 末行 `ok` ＋ 全绿 `83/83/0`」验收；`104` 属于另一棵树的读数，若要凑到 104 需另开切片把后续断言合入，**不在本片范围**（已在 §10 第 3 条报请拍板）。

### 2.3 `90-assert` 打印的两条 42501 ERROR 是设计内的，不是判红

整文件跑完会看到两行：

```
psql:deploy/postgres-cvm/sql/90-assert-least-privilege.sql:910: ERROR:  permission denied for table speech_jobs
psql:deploy/postgres-cvm/sql/90-assert-least-privilege.sql:916: ERROR:  permission denied for table transcriptions
ok
```

这是文件自己 `\set ON_ERROR_STOP off`（L710–L921 窗口）里执行的「整表 DELETE 必须恰好 42501」探针——psql 原样打印 ERROR、再用 `:SQLSTATE` 判定，文件头 L34 写明「探针段内的 42501 也会被 psql 原样打印（ON_ERROR_STOP=0 是设计的一部分）」。判定只看判决行与退出码：末行 `ok`、退出码 0。

## 3. 改造形态

### 3.1 前后对照（以 `catalog_readers.sql` 为例）

改前（`c0217a4`，L5–L6）：

```sql
CREATE ROLE gengyun_preview_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE gengyun_evidence_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
```

改后（L5–L22）：

```sql
-- R28-S48：裸 CREATE ROLE 不可重跑（第二次 42710 会把整文件事务打回），改为「pg_roles 存在性守卫
-- + EXECUTE」；紧随的 ALTER ROLE … WITH <同属性> 再把「已存在但属性漂移」的角色收敛回出厂属性。
DO $role_guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gengyun_preview_reader') THEN
    EXECUTE 'CREATE ROLE gengyun_preview_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS';
  END IF;
END;
$role_guard$;
ALTER ROLE gengyun_preview_reader WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
```

属性串 `NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS` 在 `CREATE` 与 `ALTER` 两侧**逐字相同**（单测按 `GROUP_ATTRS` 常量比对，防两边写歪）。

### 3.2 为什么是「守卫 + `EXECUTE`」

- PostgreSQL 没有 `CREATE ROLE IF NOT EXISTS`：要么先查 `pg_roles`，要么吞异常。吞异常（`EXCEPTION WHEN duplicate_object`）会把「真有并发建角色」与「正常重跑」混在一起，且子事务开销与语义都更脏；查 `pg_roles` 是 `20-login-roles.sql:191` 已经在用的房内写法，本片与它对齐。
- 条件分支只能在 `DO`/PL-pgSQL 里做，而 `CREATE ROLE` 不能带参数，固化成 `EXECUTE '<同原文>'`：文本与原句逐字一致，`git diff` 一眼能看出「原句只是被搬进了守卫」，`EXECUTE` 里的名字是常量、不涉及 `%I` 拼接风险。
- 事务性：8 个文件都以 `BEGIN; … COMMIT;` 包着，守卫通过时该文件是**纯读**（零 DDL），所以第二遍、第三遍都不会产生 `42710`，也不会重置已收敛的属性。

### 3.3 为什么守卫之后还要一条 `ALTER ROLE … WITH <同属性>`

守卫只解决「已存在就别再建」，**不解决「已存在但属性被人改坏」**：例如有人为了排障临时 `ALTER ROLE gengyun_egress_ledger LOGIN CREATEDB`，守卫会让文件「跑成功但保持坏属性」，幂等就成了假绿。所以每个角色后面紧跟一条 `ALTER ROLE … WITH <同属性>`，把属性无条件收敛回出厂值——§7 用手工改坏再重跑的方式证明了这条收敛真的生效（`t/t/t → f/f/f`）。

`ALTER ROLE` 是幂等的（重复执行同属性无副作用），且不需要 `CREATEROLE` 以外的额外权限，不会引入新的权限需求。

### 3.4 逐文件行号映射

| 文件 | 旧 `CREATE ROLE` 行（`c0217a4`） | 新守卫行 | 新 `EXECUTE` 行 | 收敛 `ALTER ROLE` 行 | 建角色数 |
|---|---|---|---|---|---|
| `services/api/db/roles/auth_privacy.sql` | 5 | 9 | 10 | 14 | 1 |
| `services/api/db/roles/catalog_readers.sql` | 5, 6 | 9, 17 | 10, 18 | 14, 22 | 2 |
| `services/api/db/roles/consent_granter.sql` | 4 | 8 | 9 | 13 | 1 |
| `services/api/db/roles/egress_ledger.sql` | 14 | 18 | 19 | 23 | 1 |
| `services/api/db/roles/knowledge_runtime.sql` | 5 | 9 | 10 | 14 | 1 |
| `services/api/db/roles/profile_runtime.sql` | 6 | 10 | 11 | 15 | 1 |
| `services/api/db/roles/source_operator.sql` | 4, 5 | 8, 16 | 9, 17 | 13, 21 | 2 |
| `services/api/db/roles/staging_importer.sql` | 3, 4 | 7, 15 | 8, 16 | 12, 20 | 2 |
| **合计** | **11** | **11** | **11** | **11** | **11** |

## 4. 环境与取证方式

| 项 | 值 |
|---|---|
| 客户端/服务端 | PostgreSQL **17.11**（`E:\GengYunCommander\.pg17\pgsql\bin`，x86_64-windows） |
| 集群 | 一次性 `127.0.0.1:55655`，datadir `E:\GengYunCommander\.pg17\data-r28s48`，`initdb -D … -U gengyun_cvm_owner --auth=trust -E UTF8 --locale=C`；进程用 `Invoke-CimMethod -ClassName Win32_Process -MethodName Create` 拉起（`ReturnValue=0`、`ProcessId=53868`），⛔ 未用 `pg_ctl start` |
| 引导身份 | `gengyun_cvm_owner`（`initdb -U` 建成超级用户，与 `provision-db.sh` 的迁移管理员同形） |
| 库 | `gengyun`，`OWNER gengyun_cvm_owner`（`20-login-roles.sql:93` 硬钉 `current_database() = 'gengyun'`） |
| 迁移 | 26 个（0001–0026），逐个 `psql -f`，`ON_ERROR_STOP=1` |
| 运行时口令 | 合成值 **48 位小写 hex**（`^[0-9a-f]{48}$` 机检通过），只存在一次性集群里，⛔ 非真实凭据 |
| 客户端编码 | 每条命令都带 `PGCLIENTENCODING=UTF8`（否则 Windows 默认 GBK 会把中文注释读成乱码） |
| shell | 步骤正文抽成 `run-sql.sh`，交 `D:\Git\bin\bash.exe` 执行；每步输出落盘 `.out.txt`，rc 逐条进 `sql-run.log` |
| 收尾 | `pg_ctl -D … -m fast -w stop` → `waiting for server to shut down..... done` / `server stopped`，之后 `pg_isready` rc=2（已停） |

读数原文落盘（不进仓库）：`E:\GengYunCommander\.pg17\handoff\r28-s48-logs\`（`sql-run.log`、`gates.log`、`cluster-lifecycle.txt`、`initdb.log`、各 `*.out.txt`）。

## 5. 读数一：真库三遍（新文件）

### 5.1 迁移

```
== phase migrate: services/api/db/migrations/*.sql (26 files) ==
mig-0001_initial_schema                  rc=0
…（26 行全部 rc=0）…
mig-0026_speech_persistence              rc=0
== migrations applied: 26, all rc=0 ==
```

### 5.2 角色文件三遍

```
== phase round1 … ==            == phase round2 … ==            == phase round3 … ==
round1-auth_privacy      rc=0   round2-auth_privacy      rc=0   round3-auth_privacy      rc=0
round1-catalog_readers   rc=0   round2-catalog_readers   rc=0   round3-catalog_readers   rc=0
round1-consent_granter   rc=0   round2-consent_granter   rc=0   round3-consent_granter   rc=0
round1-egress_ledger     rc=0   round2-egress_ledger     rc=0   round3-egress_ledger     rc=0
round1-knowledge_runtime rc=0   round2-knowledge_runtime rc=0   round3-knowledge_runtime rc=0
round1-profile_runtime   rc=0   round2-profile_runtime   rc=0   round3-profile_runtime   rc=0
round1-source_operator   rc=0   round2-source_operator   rc=0   round3-source_operator   rc=0
round1-staging_importer  rc=0   round2-staging_importer  rc=0   round3-staging_importer  rc=0
== 8/8 rc=0 ==                  == 8/8 rc=0 ==                  == 8/8 rc=0 ==
```

第三遍在 `20-login-roles.sql` 之后跑：此时库里有 `gengyun_api_runtime` 等 LOGIN 角色，证明角色文件的守卫不会被登录角色影响，也不会互相踩。

### 5.3 `20-login-roles.sql` 两遍

```
== phase login: deploy/postgres-cvm/sql/20-login-roles.sql x2 ==
login-pass1                              rc=0
login-pass2                              rc=0
== login done: 2/2 rc=0 ==
```

（该文件自己用 `\getenv api_password GENGYUN_API_RUNTIME_PASSWORD` 取口令，48 位 hex 校验不过会直接 `SELECT 1/0`。）

### 5.4 `90-assert-least-privilege.sql`

```
== phase assert: 90-assert-least-privilege.sql (ON_ERROR_STOP=1) ==
assert-90                                rc=0
--- assert rc=0 (expect 0) ---
psql:…:910: ERROR:  permission denied for table speech_jobs
psql:…:916: ERROR:  permission denied for table transcriptions
ok                     ← 末行
```

同一会话内（`r28_assert_results` 是 TEMP 表，必须同 session 才能计数）：

```
== phase count: 90-assert + count in ONE session ==
assert-90-with-count                     rc=0
ok
83|83|0
```

### 5.5 角色快照（收尾前）

```
roles_total=13
nologin_roles=11
login_roles=gengyun_api_runtime,gengyun_cvm_owner
memberships=5

          rolname          | login | super | createdb | createrole
---------------------------+-------+-------+----------+------------
 gengyun_api_runtime       | t     | f     | f        | f
 gengyun_auth_privacy      | f     | f     | f        | f
 gengyun_consent_granter   | f     | f     | f        | f
 gengyun_cvm_owner         | t     | t     | t        | t
 gengyun_egress_ledger     | f     | f     | f        | f
 gengyun_evidence_reader   | f     | f     | f        | f
 gengyun_knowledge_runtime | f     | f     | f        | f
 gengyun_preview_reader    | f     | f     | f        | f
 gengyun_profile_runtime   | f     | f     | f        | f
 gengyun_source_executor   | f     | f     | f        | f
 gengyun_source_operator   | f     | f     | f        | f
 gengyun_staging_executor  | f     | f     | f        | f
 gengyun_staging_importer  | f     | f     | f        | f
```

11 个 NOLOGIN 组 + 2 个 LOGIN 身份（`gengyun_api_runtime` 由 `20-login-roles.sql` 建、`gengyun_cvm_owner` 是引导身份），与基线形态一致：本片没有新增/删除任何角色归属。

### 5.6 `GRANT`/`REVOKE` 零改动的机检

```
$ git diff -U0 -- services/api/db/roles | grep -E '^[+-].*\b(GRANT|REVOKE)\b' | wc -l
0
```

## 6. 读数二：负控制

### 6.1 改前负控制：旧文件在同一个库上跑第二遍

用 `git show HEAD:services/api/db/roles/auth_privacy.sql` 取出**改前**的文件（第一条语句就是裸 `CREATE ROLE "gengyun_auth_privacy"`），在「新文件已经把该角色建好」的同一个库上跑：

```
== phase neg: old auth_privacy.sql from HEAD, second run ==
neg-old-auth_privacy                     rc=3
--- neg rc=3 (expect 3) ---
psql:E:/GengYunCommander/.pg17/handoff/r28-s48-logs/negcontrol-auth_privacy-HEAD.sql:5: ERROR:  role "gengyun_auth_privacy" already exists
```

`rc=3` 是 `ON_ERROR_STOP=1` 下 `42710` 的 psql 退出码。**这就是改前的日常**：`provision-db.sh` 重跑到建组段就会这样断在第一个文件上，后面 7 个文件、`20-login-roles.sql`、`90-assert` 全都不会执行。

### 6.2 改后正控制：新文件在同一个库上跑第二遍

同一位置换成新文件：`rc=0`（§5.2 round2），**没有任何 ERROR 输出**（`round2-*.out.txt` 八个文件均只有一行空行，1 字节）。同一 DB、同一角色、同一语句序列，唯一差别就是「裸写 → 守卫」——这是改前/改后的直接对照。

### 6.3 顺序无关

`20-login-roles.sql` 两遍之后再跑角色文件第三遍（§5.2 round3），仍 8/8 rc=0：守卫既不依赖「角色是我这个文件建的」，也不依赖「库里只有我这个文件建的角色」。

## 7. 读数三：漂移收敛（`ALTER ROLE` 那条不是摆设）

```
== phase drift: make gengyun_egress_ledger LOGIN+CREATEDB+CREATEROLE ==
drift-set                                rc=0
drift-before                             rc=0
 gengyun_egress_ledger|login=true|createdb=true|createrole=true
```

在「属性已被改坏」的库上重跑 `services/api/db/roles/egress_ledger.sql`（round2 的一部分，rc=0），回读：

```
gengyun_egress_ledger|login=f|createdb=f|createrole=f|super=f
```

即：守卫认出角色已存在（不再 `CREATE`），紧跟的 `ALTER ROLE … WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE …` 把三处漂移全部收敛回出厂属性。**若没有这条 `ALTER`，本轮会「rc=0 但属性仍是坏的」——典型的假绿。**

## 8. 静态守卫单测

`tests/unit/roles-bootstrap-idempotent.test.mjs`（206 行，纯静态读源码，不连库——真库读数在 §5）：

| # | 测试名 | 断言什么 |
|---|---|---|
| 1 | `roles/bootstrap: 8 个角色文件、11 条建角色，全部走守卫 + 收敛` | 文件数 8、`CREATE ROLE` 语句数 **11**、每句都在含 `pg_roles` 的 `DO` 块内、每句后紧跟同属性 `ALTER ROLE` |
| 2 | `roles/bootstrap: 守卫里的 rolname 与 CREATE ROLE 同名（11/11）` | 11 条 `CREATE ROLE <x>` 都能在某条守卫找到 `rolname = '<x>'` 的同名匹配（防复制粘贴时改名只改一半） |
| 3 | `roles/bootstrap 负控制 1：换回裸 CREATE ROLE ⇒ 判红并点名文件` | 内存里把某文件守卫换回裸 `CREATE ROLE`，审计函数必须 `ok=false` 且 `problems` 点名该文件 |
| 4 | `roles/bootstrap 负控制 2：守卫里 rolname 改错一个字符 ⇒ 判红并点名文件与角色` | 内存里把某条守卫的 `rolname` 改一个字，必须判红并同时点名文件与角色 |

负控制是「不是恒真」的证明：审计函数在内存输入上真的会红（第 3、4 条），所以第 1、2 条的绿才有意义。

```
== gate 6 ==  ℹ pass 4  ℹ fail 0
```

## 9. 门禁（逐条 exit code）

| # | 命令 | exit code | 关键读数 |
|---|---|---|---|
| 1 | `npm run lint` | **0** | `PASS tsc --noEmit services/api/tsconfig.json`、`PASS tsc --noEmit apps/admin/tsconfig.json`、仓库卫生扫描通过 |
| 2 | `node tools/verify-release-materials.mjs` | **0** | `15/15 项通过` |
| 3 | `npm run test:docs` | **0** | 研究记录校验 `5 通过 / 0 失败 / 4 legacy 已钉住`；`docs/research` 结构校验通过 |
| 4 | `node tools/verify-contract-status.mjs` | **0** | 覆盖 112 条契约操作；已装配 108；`implemented 13 / partial 95 / planned 4`；形状错误 0、语义错误 0 |
| 5 | `node --test --test-concurrency=1 "tests/contract/*.test.mjs"` | **0** | `pass 6 / fail 0` |
| 6 | `node --test tests/unit/roles-bootstrap-idempotent.test.mjs` | **0** | `pass 4 / fail 0` |
| 7 | `git diff --check` | **0** | 无空白/冲突标记问题（无输出） |

门禁原文：`.pg17/handoff/r28-s48-logs/gates.log` 与 `gate-*.out.txt`。

## 10. 未取证 / 需裁定

1. **真实 CVM 与 GitHub Actions runner 上未跑**：本页是 Windows 本机一次性集群的等价重放；`provision-db.sh` 本体未执行（要 root / `runuser -u postgres`）。
2. **`tests/integration/account-suspend-pg.mjs:207` 的正则与本片形态冲突**：该文件用 `/^CREATE ROLE (\w+) [^\n]*$/gm` 从 `services/api/db/roles/auth_privacy.sql` 抽角色名，并断言 `creates.length > 0`；本片把裸 `CREATE ROLE` 换成 `EXECUTE 'CREATE ROLE …'`（行首是 `EXECUTE`），该正则**抽不到任何一条**，该集成测试会在下次真库跑时失败。本片按派单「只改 roles/*.sql + 新增单测」的边界**没有动它**，需指挥决定是「改正则以适配新形态」还是「连同该测试一起改」，以及是否另开切片。
3. **`90-assert` 断言数 `104` vs 实测 `83`**（§2.2）：若 104 是验收硬指标，需要另开切片把后续断言合入本分支；本片只保证「exit 0 + 末行 `ok` + 自身全绿」。
4. **`20-login-roles.sql` 自身的幂等性未单独取证**：本片只证明它连跑两遍 rc=0；它内部对 LOGIN 角色的收敛逻辑（口令轮换等）不在本片范围。
