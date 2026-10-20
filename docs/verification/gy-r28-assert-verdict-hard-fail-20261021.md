# R28-S33 · 90-assert 判红硬失败（psql 非零退出）与 provision-db.sh 判据同步

> 切片：R28-S33；分支 `fix/gy-r28-assert-verdict-hard-fail`；基线 `56042f7`（`upstream/main`，rebase 后，含 #342 / S28 识别域四表授权）。
> 交付物：`deploy/postgres-cvm/sql/90-assert-least-privilege.sql` 末尾裁决块（另仅头部输出约定注释）；`deploy/postgres-cvm/provision-db.sh` 第 5 步与头注释；本页。
> 问题一句话：90-assert 判红时只打印 `FAIL: …` 判决行，psql 仍以 **0** 退出；`provision-db.sh` 又用 `|| true` 吞掉退出码、只按末行文本兜底 ⇒ 任何「只看退出码」的调用方（CI step、`psql -f … && echo passed`、`set -e` 包裹）都会把越权放行。

**取证范围声明**：本页所有读数来自**本机一次性 PG 17.11 集群**（`127.0.0.1:55644`，datadir `E:\GengYunCommander\.pg17\data-r28s33`），没有在真实 CVM、没有在 GitHub Actions runner 上跑过；`provision-db.sh` **本体未执行**（Windows 无 root / `runuser` / `usr/lib/postgresql/17` / Unix socket），改用 `bash -n` + 从脚本原文抽取代码块配真实 psql 的 harness 验证（§6）。未取得项逐条列在 §8。

## 0. 结论摘要

| 项 | 改前（`56042f7`） | 改后 |
|---|---|---|
| 判红时 psql 退出码 | **0**（缺陷） | **3** |
| 判红时末行 | `FAIL: …` | `FAIL: …`（不变） |
| 判红时 stderr | 只有探针段 4 条预期 `42501` | 末尾多出 `ERROR: 90-assert-least-privilege FAIL: N 条断言未通过：<名字>` + `CONTEXT: … RAISE` |
| 全绿末行 / 退出码 | `ok` / 0 | `ok` / 0（不变） |
| 全绿 stderr | 4 条预期 `42501` | 4 条预期 `42501`（不变，未多出 NOTICE） |
| 断言数 | 78 | 78（`count = 78`，`ok = 78`） |
| `provision-db.sh` 判据 | `\|\| true` + 末行 `!= ok` | 退出码 `≠ 0` **或** 末行 `!= ok` |
| 同一会话重复执行 | 可重复 | 可重复（`ok`×2、exit 0；§5.5） |

## 1. 范围

### 1.1 做了什么

1. `90-assert-least-privilege.sql`：`checks` 的 78 条断言改为**只求值一次**、结果落进会话级临时表 `r28_assert_results`；判决行照旧打印 `ok` / `FAIL: …`；判决行之后新增 `DO` 块，有失败即 `RAISE EXCEPTION`（文本含 `FAIL` 与失败断言名）⇒ 文件自身把 psql 变成非零退出。头注释同步输出约定。
2. `provision-db.sh`：去掉 `qfile` 调用上的 `|| true`，把 psql 退出码收进 `assert_rc`，失败条件改为「退出码 ≠ 0 **或** 末行 ≠ ok」；失败信息与完整输出带上 `psql exit=`；头注释第 5 条同步。
3. 本页 + 四段读数 + harness + 门禁。

### 1.2 没做什么（边界）

- **没有改任何断言**：78 条断言的标签、顺序、SQL、detail 文案全未动；临时表只是承接同一份 `checks` 结果。
- 没有改 `20-login-roles.sql`、`services/api/db/roles/*.sql`、迁移、`services/**`、`apps/**`、`packages/**`、`tests/**`、`.github/**`。
- 没有重排文件：CTAS 只是接在 `checks` 的 `)` 之后，`WITH domain_manifest …` 仍在原处，符合「只改末尾裁决块 + 必要注释」。
- 没有改 `deploy/postgres-cvm/verify-cvm-postgres.sh`、历史证据页、`README.md`（理由见 §7）。
- 没有 push、没有建 PR（指挥统一收口）。

## 2. 环境与取证方式

| 项 | 值 |
|---|---|
| PostgreSQL | 17.11，`E:\GengYunCommander\.pg17\pgsql\bin` |
| 集群 | 一次性；`initdb -D E:\GengYunCommander\.pg17\data-r28s33 -U postgres -E UTF8 --locale=C --auth=trust`（exit 0） |
| 端口 / 启动 | `55644`；`Invoke-CimMethod Win32_Process Create` 直接跑 `postgres.exe -D … -p 55644`（未用 `pg_ctl start`） |
| 迁移 | 25 个（`DATABASE_URL=postgres://… node services/api/src/db/migrate.ts up`，exit 0） |
| 角色 | 按 `provision-db.sh` 的五个组：`auth_privacy` → `catalog_readers` → `consent_granter` → `profile_runtime` → `knowledge_runtime`（逐个 exit 0） |
| 登录角色 | `GENGYUN_API_RUNTIME_PASSWORD=<48 位小写 hex> psql -f sql/20-login-roles.sql`（exit 0） |
| 断言调用 | `psql -X -q -tA -v ON_ERROR_STOP=1 -f sql/90-assert-least-privilege.sql`（另做了一次**不带** `-v ON_ERROR_STOP=1` 的对照，§5.5） |
| 已知差异 | 本机 `gengyun_cvm_owner` 是建库时手工建的 `SUPERUSER`（initdb 的超级用户是 `postgres`）；生产该角色是 `CREATEROLE`、非超级用户。与 S28 证据页 §12.7 同口径。 |

## 3. 缺陷机制（改前，`56042f7` 原文）

原文件末尾只有这一条语句（旧 L1806-1811）：

```sql
SELECT CASE
         WHEN count(*) FILTER (WHERE ok IS NOT TRUE) = 0 THEN 'ok'
         ELSE 'FAIL: ' || string_agg(label || ' (' || detail || ')', '; ' ORDER BY label)
                             FILTER (WHERE ok IS NOT TRUE)
       END AS verdict
  FROM checks;
```

- 它**是一条成功的 SELECT**：`FAIL: …` 只是查询结果里的一个字符串值。psql 只在「脚本里的 SQL 报错」时以 3 退出，所以判红时退出码仍是 0。
- 兜底在 `provision-db.sh`（旧 L362-374）：`assert_out="$(qfile … || true)"` 把 psql 退出码扔掉，随后 `verdict="$(… | tail -n1)"`、`if [[ "$verdict" != 'ok' ]]` 才 `fail`。
- 后果：任何**只判退出码**的调用方都会放行——CI 里 `psql -f … && echo passed`、`set -e` 脚本、外部编排系统的 step 退出码。S28 证据页 §9 已如实记录「90-assert 失败时 psql 退出码仍是 0（本片未改）」；本片把该条闭环，**历史页不改**，此处标注 superseded。

## 4. 改法

### 4.1 `90-assert-least-privilege.sql`

`checks` 的定义（原 L905 的 `checks(label, ok, detail) AS (`）未动。改动只有三处：

1. `checks` 的 `)` 之后把整棵 CTE 的**唯一一次**求值写进临时表（新 L700-710；`WITH domain_manifest …` 原样接在 `CREATE TEMP TABLE … AS` 后面）：

```sql
-- 同一会话里重复执行（人工 `\i` 两次）时先清掉上一次的临时表，否则 CREATE 会因重名报错、
-- 被误读成断言判红；只在它确实存在时 DROP（pg_temp 限定），因此全绿读数不多出任何 NOTICE。
DO $$
BEGIN
  IF to_regclass('pg_temp.r28_assert_results') IS NOT NULL THEN
    DROP TABLE pg_temp.r28_assert_results;
  END IF;
END
$$;
CREATE TEMP TABLE r28_assert_results AS
WITH domain_manifest(tbl, classification, required) AS (VALUES
    …
```

`checks` 的收尾补上 CTAS 的查询体（新 L1821-1824）：

```sql
)
SELECT label, ok, detail
  FROM checks;
```

2. 判决行改为读临时表（新 L1826-1831），文本格式不变：

```sql
SELECT CASE
         WHEN count(*) FILTER (WHERE ok IS NOT TRUE) = 0 THEN 'ok'
         ELSE 'FAIL: ' || string_agg(label || ' (' || detail || ')', '; ' ORDER BY label)
                             FILTER (WHERE ok IS NOT TRUE)
       END AS verdict
  FROM r28_assert_results;
```

3. 判决行之后追加 `DO` 块（新 L1838-1853）：

```sql
DO $$
DECLARE
  v_failed integer;
  v_names  text;
BEGIN
  SELECT count(*) FILTER (WHERE ok IS NOT TRUE),
         string_agg(label, ', ' ORDER BY label) FILTER (WHERE ok IS NOT TRUE)
    INTO v_failed, v_names
    FROM r28_assert_results;

  IF v_failed > 0 THEN
    RAISE EXCEPTION '90-assert-least-privilege FAIL: % 条断言未通过：%',
                    v_failed, left(v_names, 4000);
  END IF;
END
$$;
```

设计说明：

- **为什么用临时表而不是重跑 CTE**：78 条断言里有多次 catalog 扫描、真实探针（含 `BEGIN/ROLLBACK`）与 `has_*_privilege` 调用，重跑会重复副作用与耗时；复制 `checks` 的定义则会让两处漂移。
- **为什么不改判据文本**：末行仍是 `ok` / `FAIL: label (detail); …`，人工 `psql -f` 与旧调用方的可读性不变；判决行保留**完整**明细，异常文本只带名字（上限 4000，78 条全红时标签合计实测 `sum(length(label)+2)=2370`，正常不截断）。
- **退出码从哪来**：文件头已有 `\set ON_ERROR_STOP on`（探针段临时关、结束后恢复），所以即使调用方**不传** `-v ON_ERROR_STOP=1`，`RAISE` 也会让 psql 以 3 退出（§5.5 实测）。
- 临时表随会话销毁，不建持久对象、不改任何权限，仍是「只报不改」。

### 4.2 `provision-db.sh`

头注释第 5 条（新 L15-16）改为「以 psql 退出码为主判据……末行文本 `ok` 仅作可读兜底；任一不过即失败」。第 5 步代码（新 L363-383）：

```bash
  log "执行最小权限断言 sql/90-assert-least-privilege.sql"
  # R28-S33：90-assert 自己会失败 —— 判决不是 ok 时它在文件末尾 RAISE EXCEPTION，
  # psql 因 PSQL_BASE 里的 -v ON_ERROR_STOP=1 以 3 退出；脚本头的 set -o pipefail
  # 让 qfile 把 psql 的退出码透出来（旧版这里的 `|| true` 会把它吞掉）。
  # 所以**退出码是主判据**；末行文本只留作可读兜底（人工 psql -f、或将来有人改回
  # 纯文本判决时仍能被拦住）——两者任一不过就算失败。
  # 保留**完整**输出：90-assert 在缺前置时会打印三步补救指引，不能只留最后一行。
  assert_rc=0
  assert_out="$(qfile "${SQL_DIR}/90-assert-least-privilege.sql")" || assert_rc=$?
  verdict="$(printf '%s\n' "$assert_out" | sed '/^[[:space:]]*$/d' | tail -n1)"
  if [[ "$assert_rc" -ne 0 || "$verdict" != 'ok' ]]; then
    printf '[%s] 最小权限断言的完整输出（psql exit=%s）：\n' "$SCRIPT_NAME" "$assert_rc" >&2
    printf '%s\n' "$assert_out" | sed 's/^/         /' >&2
    fail "最小权限断言未通过（psql exit=${assert_rc}，最后一行：${verdict}）
         90-assert 在判决非 ok 时会 RAISE EXCEPTION，psql 因此非零退出；本脚本以退出码为主判据，
         末行文本仅作兜底（旧版脚本或人工 psql -f 时仍可读）。
         若输出里是「前置未满足」，请按其中的三步指引先补迁移/角色引导后重跑；
         若输出里是 FAIL 明细，本脚本只报告不自动回收权限，请对照
         services/api/db/roles/*.sql 人工排查。"
  fi
  log "最小权限断言通过：${verdict}"
```

`qfile()` 内部是 `runuser … psql … | tr -d '\r'`，脚本头 `set -euo pipefail` 让 psql 的 3 穿过管道；`|| assert_rc=$?` 在 `set -e` 下安全地捕获它。

### 4.3 语法

`bash -n deploy/postgres-cvm/provision-db.sh`（`D:\Git\bin\bash.exe`）→ **exit 0**。

## 5. 四段读数（逐字）

### 5.1 ① 全绿（改后）

```text
$ psql -X -q -tA -v ON_ERROR_STOP=1 -f deploy/postgres-cvm/sql/90-assert-least-privilege.sql
ok
exit=0
```

stderr 只有探针段 4 条**预期**的 `42501`（ON_ERROR_STOP=0 是设计的一部分）：

```text
psql:E:/GengYunCommander/wt-r28-s33/deploy/postgres-cvm/sql/90-assert-least-privilege.sql:668: ERROR:  permission denied for table recognition_selections
psql:E:/GengYunCommander/wt-r28-s33/deploy/postgres-cvm/sql/90-assert-least-privilege.sql:674: ERROR:  permission denied for table recognition_jobs
psql:E:/GengYunCommander/wt-r28-s33/deploy/postgres-cvm/sql/90-assert-least-privilege.sql:680: ERROR:  permission denied for table recognition_records
psql:E:/GengYunCommander/wt-r28-s33/deploy/postgres-cvm/sql/90-assert-least-privilege.sql:686: ERROR:  permission denied for table recognition_selections
```

### 5.2 ② 判红（改后，关键读数）

人为制造一条失败（单条语句、可 `REVOKE` 复原）：

```sql
GRANT SELECT ON public.messages TO PUBLIC;
```

- `messages` 平时只对运行时角色做**列级** `SELECT`；PUBLIC 一旦拿到**表级** SELECT，所有角色实际可读整表。
- 第一次 `20-login-roles.sql` 已在各授权段执行 `REVOKE ALL … FROM PUBLIC`，所以这是真实回归。

stdout（末行，判决文本照旧）：

```text
FAIL: knowledge_runtime_scope (gengyun_knowledge_runtime 只应能读 catalog_read.current_knowledge); public_no_privilege_domain_granted (manifest 里 granted / granted_external 的表对 PUBLIC 必须零权限；表级 relacl 与列级 attacl 两处都查（各授权段都 REVOKE ALL … FROM PUBLIC）)
```

stderr（末尾两行）：

```text
psql:E:/GengYunCommander/wt-r28-s33/deploy/postgres-cvm/sql/90-assert-least-privilege.sql:1852: ERROR:  90-assert-least-privilege FAIL: 2 条断言未通过：knowledge_runtime_scope, public_no_privilege_domain_granted
CONTEXT:  PL/pgSQL function inline_code_block line 12 at RAISE
```

**exit=3**。

为什么一次注入红两条：#66 `public_no_privilege_domain_granted` 直接查 manifest 里 granted 表的 `relacl/attacl` 是否出现 grantee=0；`knowledge_runtime_scope` 要求 `gengyun_knowledge_runtime` **只能**读 `catalog_read.current_knowledge`，PUBLIC 的表级授权让它额外可读 `public.messages` ⇒ 也是真实越权。两条都指向同一根因，属于防御纵深，不是重复计数。

### 5.3 ③ 改前对照（同一失败，旧文件）

```text
$ git stash push -- deploy/postgres-cvm/sql/90-assert-least-privilege.sql deploy/postgres-cvm/provision-db.sh
$ psql … -f deploy/postgres-cvm/sql/90-assert-least-privilege.sql   # HEAD 的旧文件
FAIL: knowledge_runtime_scope (…); public_no_privilege_domain_granted (…)
exit=0
```

- stdout 判决文本与 5.2 **逐字相同**；
- 差异只在退出码：**旧文件 0**，新文件 3；
- 旧文件 stderr 只有探针的 4 条 `42501`（没有 `DO` 块，因此没有 `ERROR: 90-assert…`）；
- 随后 `git stash pop` 恢复改动（exit 0）。

这一步直接证明缺陷：旧行为是「打印 FAIL 但 exit 0」。

### 5.4 ④ 复原

```text
$ REVOKE SELECT ON public.messages FROM PUBLIC;
$ psql … -f deploy/postgres-cvm/sql/90-assert-least-privilege.sql
ok
exit=0
```

`git status --porcelain` 只剩本片两个目标文件的修改（提交前状态；提交后为空）。

### 5.5 两个附加读数

1. **不传 `-v ON_ERROR_STOP=1` 的调用方**（同一失败，`psql -X -q -tA -f …`）：stdout 仍是同一行 `FAIL: …`，stderr 同一行 `ERROR: 90-assert-least-privilege FAIL: 2 条断言未通过：…`，**exit=3**。证明失败由**文件内**的 `\set ON_ERROR_STOP on` 保证，不依赖调用方旗帜。
2. **同一会话重复执行**（`psql -f 文件 -f 文件`，全绿）：stdout 两行 `ok`、exit 0，stderr 8 条（每轮 4 条预期 `42501`），没有 `relation "r28_assert_results" already exists`。幂等 `DROP` 生效。

### 5.6 断言计数

同一会话内 `-f` 之后查询临时表：

```text
ok
78|78
```

即 78 条断言、78 条通过；`sum(length(label)) = 2214`、`sum(length(label)+2) = 2370`、`max(length(label)) = 50`。断言集合与 `56042f7` 完全一致（本片未改断言）。

## 6. `provision-db.sh` 的验证（harness + 静态论证）

真实脚本要求 Linux root、`/usr/lib/postgresql/17/bin`、`runuser -u postgres`、Unix socket 与 postgres 可读的暂存目录，Windows 开发机无法原样执行。验证分两层：

1. **语法**：`bash -n` exit 0（§4.3）。
2. **真实代码块 + 真实 psql**：harness 用 awk 从 `provision-db.sh` 原文抽取 `assert_rc=0` 起、`log "最小权限断言通过` 止的代码块（与仓库里逐字一致），只把 `qfile` 替换成「真实 psql + `tr -d '\r'`」（省略 root/runuser/暂存）：
   - 全绿：**exit 0**，末行 `[provision-db(harness)] 最小权限断言通过：ok`；
   - 判红（同一 `GRANT`）：**exit 1**（`fail` 触发），并打印

     ```text
     [provision-db(harness)] 最小权限断言的完整输出（psql exit=3）：
              FAIL: knowledge_runtime_scope (…); public_no_privilege_domain_granted (…)
     [provision-db(harness)][ERROR] 最小权限断言未通过（psql exit=3，最后一行：FAIL: …）
     ```

静态链路（未在 Windows 实跑的部分）：`qfile` 的 `runuser … psql … | tr` 在 `pipefail` 下把 psql 的 3 透出 → `|| assert_rc=$?` 捕获 → `if [[ … -ne 0 || … ]]` → `fail()` 打印 `[ERROR]` 后 `exit 1`。**真实 provision 运行时唯一未覆盖的是 root/runuser/暂存三步**，它们不改变退出码语义。

## 7. 影响面核查（谁依赖「末行」或「exit 0」）

| 调用方 | 现状 | 本片处置 |
|---|---|---|
| `deploy/postgres-cvm/provision-db.sh` | 旧版 `\|\| true` + 末行文本 | **已同步**：退出码主判据 + 文本兜底 |
| `deploy/postgres-cvm/verify-cvm-postgres.sh:257-267` | `… 2>&1 \| tr -d '\r' \|\| true`，取末行后 `report_eq 'least_privilege_assert' 'ok'` | **未改**（红线外）。判红仍成立（末行 ≠ ok），但 `2>&1` 会把 `CONTEXT: …` 混进末行，报告文本可能从 `FAIL:` 明细变成 `CONTEXT:` 行——是该脚本「取末行」实现的既有副作用，建议后续单独切片改 |
| `tests/integration/admin-accounts-read-pg.mjs:263-275` | 发现 `^\s*\\` 元命令后只 note、不执行 | 不受影响，未改 |
| `tests/integration/account-suspend-pg.mjs:523-538` | 同上【S】 | 不受影响，未改 |
| 历史证据页 3 篇（S26/S27/S28） | 记录当时「FAIL 时 exit=0」 | 不篡改历史；本页标注 superseded |
| `deploy/postgres-cvm/README.md:220` | 「输出 ok 或 FAIL: …（末行 ok，15/15）」 | 未改：无退出码断言，「15/15」是更早已存在的陈旧数字（S26 已列为另行更新），不属本片 |
| `.github/workflows/**`、`tools/**` | grep `90-assert` / `least_privilege_assert` 无命中 | 无 CI/工具依赖 |

## 8. 未取得 / 边界

1. `provision-db.sh` **本体未执行**：需 Linux root、`runuser`、`/usr/lib/postgresql/17/bin`、Unix socket 与 CVM 路径；以 `bash -n` + 原文代码块 harness 替代（§6）。
2. 未在真实 CVM、未在 GitHub Actions runner 上运行。
3. 本机 `gengyun_cvm_owner` 为 `SUPERUSER`（生产为 `CREATEROLE`、非超级用户），与 S28 页 §12.7 同口径；90-assert 需要读 `pg_authid` 的断言依赖这一点。
4. 截断路径（`left(v_names, 4000)`）未实跑：两条失败时远未到上限；上限值按「78 条全红 = 2370 字符」留了余量，仅静态论证。
5. `verify-cvm-postgres.sh` 的「取末行」副作用未修（红线外，§7）。
6. 未验证「SQL 在显式事务块里执行」的形态（`BEGIN; \i 文件; COMMIT;`）；临时表在该形态下仍合法，但本片未取读数。

## 9. 复现步骤（本机，不含口令）

```powershell
# 1) 集群
& "$PG\initdb.exe" -D $DATA -U postgres -E UTF8 --locale=C --auth=trust
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine="$PG\postgres.exe -D $DATA -p 55644"}
# 2) 迁移管理员与库（本机口径：owner 为 SUPERUSER；生产为 CREATEROLE）
psql -h 127.0.0.1 -p 55644 -U postgres -d postgres -c "CREATE ROLE gengyun_cvm_owner LOGIN SUPERUSER;"
psql -h 127.0.0.1 -p 55644 -U postgres -d postgres -c "CREATE DATABASE gengyun OWNER gengyun_cvm_owner;"
$env:DATABASE_URL='postgres://gengyun_cvm_owner@127.0.0.1:55644/gengyun'
node services/api/src/db/migrate.ts up
# 3) 五个 NOLOGIN 组 + 登录角色（顺序同 provision-db.sh）
foreach ($r in 'auth_privacy','catalog_readers','consent_granter','profile_runtime','knowledge_runtime') {
  psql -h 127.0.0.1 -p 55644 -U gengyun_cvm_owner -d gengyun -v ON_ERROR_STOP=1 -f "services/api/db/roles/$r.sql"
}
$env:GENGYUN_API_RUNTIME_PASSWORD='0123456789abcdef0123456789abcdef0123456789abcdef'
psql -h 127.0.0.1 -p 55644 -U gengyun_cvm_owner -d gengyun -v ON_ERROR_STOP=1 -f deploy/postgres-cvm/sql/20-login-roles.sql
# 4) 读数
psql -h 127.0.0.1 -p 55644 -U gengyun_cvm_owner -d gengyun -X -q -tA -v ON_ERROR_STOP=1 -f deploy/postgres-cvm/sql/90-assert-least-privilege.sql   # ok, exit 0
psql … -c "GRANT SELECT ON public.messages TO PUBLIC;"
psql … -f deploy/postgres-cvm/sql/90-assert-least-privilege.sql   # FAIL…, exit 3
git stash push -- deploy/postgres-cvm/sql/90-assert-least-privilege.sql deploy/postgres-cvm/provision-db.sh
psql … -f deploy/postgres-cvm/sql/90-assert-least-privilege.sql   # FAIL…, exit 0（改前对照）
git stash pop
psql … -c "REVOKE SELECT ON public.messages FROM PUBLIC;"
psql … -f deploy/postgres-cvm/sql/90-assert-least-privilege.sql   # ok, exit 0（复原）
```

## 10. 门禁

| 命令 | exit code | 摘要 |
|---|---|---|
| `npm run lint` | 0 | tsc ×2、仓库卫生扫描通过 |
| `node tools/verify-release-materials.mjs` | 0 | 15/15 项通过 |
| `npm run test:docs` | 0 | 开发文档 + 研究记录校验通过 |
| `node tools/verify-contract-status.mjs` | 0 | 112 条契约操作，形状/语义错误 0 |
| `node --test --test-concurrency=1 "tests/contract/*.test.mjs"` | 0 | 6 pass / 0 fail |
| `bash -n deploy/postgres-cvm/provision-db.sh` | 0 | 语法通过 |

本片未改 tests，故未单跑集成测试。

## 11. 派单对应表

| 派单要求 | 证据 |
|---|---|
| 判红从「只打印末行」变成真失败 | §3（机制）、§5.2（exit 3）、§5.3（改前 exit 0 对照） |
| 保留人类可读 verdict | §5.1/§5.2（末行文本不变）、§4.1（判决行读临时表，格式不变） |
| 异常文本含 `FAIL` 与失败断言名 | §5.2 stderr、§4.1 DO 块 |
| 全绿行为完全不变（末行 ok、exit 0） | §5.1（exit 0、`ok`、stderr 仍 4 条预期 `42501`）、§5.5（无 `-v` 仍 exit 3 属新增保护，不是全绿变化） |
| 同步 provision-db.sh，注释写因果 | §4.2、§6 |
| 查 tests/文档依赖末行或 exit 0 | §7（2 个测试只 note；3 篇历史页不改；README 不动；CI 无命中） |
| 只改 SQL 末尾裁决块与必要注释 | §1.2、§4.1（CTAS 接在 `checks` 后，未重排） |
| 四段读数必须真跑 | §5.1–§5.4（本机 PG 17.11，逐字输出） |
| `bash -n` 通过 | §4.3、§10 |
| provision-db.sh 在判红时确实失败 | §6（harness：exit 1；并说明仅 root/runuser/暂存未实跑） |
| 门禁逐条 exit code | §10 |
