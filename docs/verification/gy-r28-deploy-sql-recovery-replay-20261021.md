# R28-S42 · 误授恢复演练：撤销一列授权 → 重跑 `20-login-roles.sql` → 90-assert 仍 `ok`

> 切片：R28-S42；分支 `test/gy-r28-deploy-sql-recovery-replay`；基线 `upstream/main = 32ce461`（S38 之后：90-assert 已把退出码做成主判据、断言条数已从 S28 的 78 涨过一轮）。
> 交付物：`.github/workflows/deploy-sql-gate.yml`（加第 ⑤ 步并删掉过期数字）、`tests/unit/deploy-sql-gate-recovery.test.mjs`（新增静态守卫）、本页。
> 一句话问题：S38 实证过「**表级 `REVOKE` 会连带撤销同类型的列级授权**，误授之后唯一正解是**重跑 `20-login-roles.sql`**」；但本仓 CI 此前**只跑一次** roles，这条救命恢复路径从未被证明过——一旦 I 段被改成「角色不存在才 GRANT」之类，CI 仍然全绿，灾难恢复时才现场发现。本片把「撤一列 → 重跑 roles → 读数回到 `t` → 90-assert 仍 `ok`」做成 CI 里每次必跑的演练，并用一个静态守卫单测把它钉死在 workflow 文本里。

**取证范围声明**：本页读数来自**本机一次性 PostgreSQL 17.11 集群**（`127.0.0.1:55651`，datadir `E:\GengYunCommander\.pg17\data-r28s42`），**没有**在 GitHub Actions runner 上执行过；`provision-db.sh` 本体也没有运行（它要 root / `runuser -u postgres` / 真实 CVM），而是把它调用的同一串 SQL 在本机按同一顺序执行。本机**没有可用的 bash**（Git Bash 未安装、WSL 到 `psql.exe` 的 interop 不通），所以演练正文是**用 PowerShell 5.1 逐条重放同一批 SQL 与同一批比较**，bash 语法本身没有在本机执行——这一点连同其余未取得项逐条列在 §8，不与「CI 已跑过」混为一谈。

## 0. 结论摘要

| 项 | 本机读数 |
|---|---|
| 前置自检：`has_column_privilege('gengyun_api_runtime','public.favorites','id','SELECT')` | **`t`**（前提成立，没有触发「立刻停下回报」的停机条件） |
| 幂等：连跑两次 `20-login-roles.sql` | exit **`0`** / **`0`** |
| 制造误授：`REVOKE SELECT (id) ON TABLE public.favorites` | exit `0`，读数变 **`f`** |
| 恢复：重跑 `20-login-roles.sql` | exit `0`，读数回到 **`t`** |
| 复验：重跑 `90-assert-least-privilege.sql` | exit **`0`**，末行逐字 **`ok`**（非空行数 5；探针故意打出的 `permission denied` 4 行，只出现在 stderr） |
| **反向证明**：只 `REVOKE`、**不**重跑 roles | 90-assert **exit `3`**，判决行 `FAIL: runtime_favorites_dml_exec (…); runtime_grants_favorites (…)` |
| S38 结论复现：**表级** `REVOKE SELECT ON public.favorites` | `attacl` 由 `{…=ar/…}` 变 `{…=a/…}`，列级 SELECT 读数 `t → f`；重跑 roles 后回 `t`、90-assert 回 `ok` |
| 静态守卫单测 | 改前 8/8 绿；两条负控制各自判红（1 fail / 2 fail）；恢复后 `sha256` 与改前**逐位相等**、复跑 8/8 绿 |
| 门禁 7 项 | 全绿（exit code 见 §7） |

## 1. 范围

### 1.1 做了什么

1. **在 `.github/workflows/deploy-sql-gate.yml` 末尾加第 ⑤ 步**（现在是第 8 步、也是最后一步），名字逐字为：

   ```
   恢复演练：撤销一列授权 → 重跑 20-login-roles.sql → 90-assert 仍 ok
   ```

   它排在既有的 `90-assert-least-privilege.sql（末行 ok 且退出码 0）` 之后，五段顺序固定：

   | 段 | 动作 | 判红条件 |
   |---|---|---|
   | ① | `col_priv()` 读 `public.favorites.id` 的列级 SELECT | 不是 `t` ⇒ `::error::` + `exit 1`（**⛔ 不换列硬凑**：前提变了就当场停） |
   | ② | `for attempt in 1 2`：连跑两次 `20-login-roles.sql` | 任一 exit ≠ 0 ⇒ 判红（幂等被破坏） |
   | ③ | `REVOKE SELECT (id) ON TABLE public.favorites FROM gengyun_api_runtime`，再读 | 读数不是 `f` ⇒ 判红（撤都没撤掉，谈何恢复） |
   | ④ | 再跑一次 `20-login-roles.sql`，再读 | exit ≠ 0 或读数不是 `t` ⇒ 判红（**恢复路径失效**） |
   | ⑤ | 重跑 90-assert，**双保险**：退出码 0 **且** 末行正好 `ok`（`awk 'NF { last = $0 } END { print last }'` 取最后一条非空行） | 任一不满足 ⇒ 判红 |

   判据口径与第 ④ 步逐字一致：**只认退出码与末行**，不按日志里有没有 `ERROR` 判红（探针段故意打 42501，那是被验的读数）。该步**无** `if:`、**无** `continue-on-error`、**无** `|| true`、**无** `set +e`，退出码用 `psql … || rc=$?` 捕获、`set -euo pipefail` 全程开启。`env` 与其它步相同（`PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE`），另加 `GENGYUN_API_RUNTIME_PASSWORD`（48 位小写 hex 合成值，与第 ③ 步同一个值，`\getenv` 会校验形状）。
2. **删掉末步 `echo` 里过期的硬编码条数**：`双保险齐了（78 条断言判绿）。` → `双保险齐了。`。同时把文件头注释与断言步注释里同一处「78」改成「条数不写死，以脚本自身判决为准」的说明。**没有换成另一个数字**——断言条数随切片增长（S28 的 78 → S38 已涨过一轮，按派单与 S38 交付记录为 83），任何写死的数字都会重新过期，而且会把「条数对不对」误当成判据。本机**没有逐条重数**断言条数（见 §8 第 6 条），CI 与本页也都不写死它。
3. **新增 `tests/unit/deploy-sql-gate-recovery.test.mjs`**（纯 Node、零新依赖、按缩进自解析 workflow 文本，不 import 兄弟测试以免把别的 test 注册进本进程）。8 个 test 钉住：步骤名逐字存在；它是**最后一步**且在第 ④ 步之后；run 正文的顺序（唯一一处读到列级 SELECT 的 SQL → 2 次 roles → REVOKE → 读数 → roles → 读数 → 90-assert）与四段比较文本；该步无任何软失败构造；**全 workflow** 无 `continue-on-error` 真值、含 `psql` 的行不接 `|| true`；全 workflow 不再出现「78 条断言」；`::error::` 与 `exit 1` 数量相等（各 8 处）且带 `GENGYUN_API_RUNTIME_PASSWORD`；两个 SQL 文件存在非空。
4. 本页 ＋ 门禁 ＋ 两条负控制。

### 1.2 没做什么（边界）

- 没有改 `deploy/postgres-cvm/sql/20-login-roles.sql`、`deploy/postgres-cvm/sql/90-assert-least-privilege.sql`、`deploy/postgres-cvm/provision-db.sh`（演练只**调用**它们）。
- 没有改任何其它 `.github/workflows/*`、`services/**`、`tests/integration/**`、`services/api/db/roles/*.sql`。
- 没有 push、没有建 PR、没有打 tag（指挥统一收口）。
- 没有把演练做成「角色不存在才执行」的松判据，也没有加 `continue-on-error` / `|| true` / 按日志 `ERROR` 判红的写法。
- 没有在真实 CVM 或 GitHub Actions runner 上执行（§8）。

## 2. 环境与取证方式

| 项 | 值 |
|---|---|
| 客户端/服务端 | PostgreSQL **17.11**（`E:\GengYunCommander\.pg17\pgsql\bin`，`x86_64-windows`），`postgres --version` / `psql --version` 均为 17.11 |
| 集群 | 一次性 `127.0.0.1:55651`，datadir `E:\GengYunCommander\.pg17\data-r28s42`；`initdb -D <datadir> -U gengyun_cvm_owner --auth-local=scram-sha-256 --auth-host=scram-sha-256 --pwfile=… -E UTF8 --locale=C`（exit 0），`show password_encryption` = `scram-sha-256`；进程用 `Invoke-CimMethod Win32_Process Create` 拉起（`returnValue=0, processId=61668`），**不用** `pg_ctl start`、**不用** `Start-Process -RedirectStandardOutput` |
| 引导身份 | `gengyun_cvm_owner`（`LOGIN` ＋ 该集群的超级用户；service 容器的 `POSTGRES_USER` 也是 superuser，与生产「`CREATEROLE` 非 `SUPERUSER`」不同——见 §8 第 5 条） |
| 库 | `gengyun`，`OWNER gengyun_cvm_owner`（`20-login-roles.sql` 硬钉 `current_database() = 'gengyun'`） |
| 迁移 | **26 个**（`0001`…`0026`，含 `0026_speech_persistence.sql`），`node services/api/src/db/migrate.ts up` 全部应用、exit 0；`schema_migrations` 计数 26 |
| 组角色 | `services/api/db/roles/` 的 5 个文件，顺序逐条抄 `deploy/postgres-cvm/provision-db.sh:265-271`（`auth_privacy` → `catalog_readers` → `consent_granter` → `profile_runtime` → `knowledge_runtime`），全部 exit 0 |
| 运行时口令 | 合成值（48 位小写 hex，`openssl rand -hex 24` 的形状），存在仓外 `E:\GengYunCommander\.pg17\secrets-r28s42\db-credentials.env`，**⛔ 非真实口令**，pwfile 用完即删 |
| 重放方式 | PowerShell 5.1 逐条执行 workflow 第 ⑤ 步的**同一批 SQL**（`has_column_privilege` / `REVOKE` / 两次 `-f 20-login-roles.sql` / `90-assert`）与**同一批比较**（`t` / `0` / `f` / `t` / `ok`）；`$env:PGPASSWORD` 显式设置、`psql` 一律 `-w`（scram 不会挂住） |

读数原文落盘（不进仓库）：

- `E:\GengYunCommander\.pg17\handoff\r28s42-logs\assert-after-recovery.txt`（恢复后 90-assert 全文）
- `E:\GengYunCommander\.pg17\handoff\r28s42-logs\assert-after-revoke-no-rerun.txt`（反向证明的 90-assert 全文）
- `E:\GengYunCommander\.pg17\handoff\r28s42-logs\postgres.log`（集群日志）

## 3. 五段演练的逐字读数

本机把第 ⑤ 步的 `run:` 正文整段重放（SQL 与比较逐字对应），读数逐字如下：

```
前置：has_column_privilege(gengyun_api_runtime, public.favorites, id, SELECT)=t
20-login-roles.sql 第 1 次重跑：exit=0
20-login-roles.sql 第 2 次重跑：exit=0
撤销 public.favorites.id 的列级 SELECT：exit=0
撤销后：has_column_privilege=f
重跑 20-login-roles.sql 恢复授权：exit=0
恢复后：has_column_privilege=t
恢复后的 90-assert：exit=0
末行（逐字）：ok
非空行数：5
permission denied 行数（探针故意制造）：4
恢复演练通过：撤销后 has_column_privilege=f → 重跑 20-login-roles.sql → t；90-assert 末行 ok 且退出码 0
收尾自检：t|t|t（id SELECT / owner_id SELECT / 表级 DELETE）
```

逐段解读：

1. **前置 `t`**：`gengyun_api_runtime` 对 `public.favorites.id` 的列级 SELECT 只看 `pg_attribute.attacl`（列级授权下 `has_table_privilege` 恒为 `false`），而 `services/api/db/roles/*.sql` 里 grep `favorites` **零命中**，这条授权只来自 `20-login-roles.sql` 的 I 段：

   ```sql
   REVOKE ALL ON TABLE public.favorites, … FROM PUBLIC;
   GRANT SELECT (id, owner_id, target_type, target_id, target_revision, revision, created_at)
     ON public.favorites TO gengyun_api_runtime;
   ```

   ⇒ 该列**没有**表级 SELECT 兜底、也没有组角色继承的 SELECT，`REVOKE SELECT (id)` 之后读数必然是 `f`（不会被「其实是走表级/继承权限」掩盖）。
2. **两次重跑 `0/0`**：`20-login-roles.sql` 默认**不改口令**（只在 `GENGYUN_ROTATE_RUNTIME_PASSWORD` 为真值时才 `ALTER ROLE … PASSWORD`），所以重复执行是幂等的；这一步把「幂等」本身也变成 CI 读数。
3. **撤销后 `f`**：证明「制造误授」这一步真的生效——否则后面的「恢复」是假动作。
4. **重跑后 `t`**：这就是本片要证明的那条路径。恢复不靠补 `GRANT`，靠重跑授权文件（与 S38 的结论一致，见 §5）。
5. **90-assert 末行 `ok`、exit `0`**：`runtime_grants_favorites`（逐列清单）与 `runtime_favorites_dml_exec`（`SET LOCAL ROLE` 后跑零行语句）都回到通过态。探针段故意打出的 4 行 `permission denied` 只在 stderr，**不参与判红**。

## 4. 反向证明：只 `REVOKE`、**不**重跑 roles ⇒ 90-assert 必须判红

如果「重跑 roles 恢复」这一步是装饰品，那么「不重跑也照样绿」。所以单独做一次：撤掉 `favorites.id` 后**不**重跑 `20-login-roles.sql`，直接跑 90-assert。

```
不重跑 roles 的 90-assert：exit=3
--- 尾部 6 行 ---
  psql:…90-assert-least-privilege.sql:674: ERROR:  permission denied for table recognition_jobs
  psql:…:680: ERROR:  permission denied for table recognition_records
  psql:…:686: ERROR:  permission denied for table recognition_selections
  FAIL: runtime_favorites_dml_exec (SET LOCAL ROLE gengyun_api_runtime 后，favorites / favorites_idempotency 的 SELECT、INSERT … ON CONFLICT、FOR UPDATE、DELETE 零行语句必须全部成功；任一 42501 即失败); runtime_grants_favorites (列级 SELECT/INSERT/UPDATE 必须与清单逐列一致（清单外一列都不行）；表级只允许 del=true 的表有 DELETE，其它表级写权限一律不得有)
  psql:…:1853: ERROR:  90-assert-least-privilege FAIL: 2 条断言未通过：runtime_favorites_dml_exec, runtime_grants_favorites
  CONTEXT:  PL/pgSQL function inline_code_block line 12 at RAISE
permission denied 行数：8
```

要点：

- **exit `3`（非 0）**：R28-S33 起 90-assert 把失败做成 hard-fail（末尾 `DO $$ … RAISE EXCEPTION … $$`），所以**退出码本身就是判据**；本机读数与 workflow 的两道判据（退出码 ＋ 末行）都能抓住。
- 失败时 `psql` 的**末行是 `CONTEXT:`**、不是 `FAIL` 行——判决行（`FAIL: …`）在它前一行。这说明 workflow 的「退出码」分支负责抓「没跑到判决/脚本报错」，「末行」分支负责抓「跑完了但结论不是 ok」，两道确实覆盖不同失败模式，**都不能删**。
- 两条断言同时点名：`runtime_grants_favorites`（列级清单不一致）与 `runtime_favorites_dml_exec`（探针语句 42501）。它们指向同一根因的两个面（清单式检查 ＋ 真跑一条零行语句），属防御纵深，不是重复计数。
- 8 行 `permission denied` 里前 3 行是 RECOGNITION 域探针（`runtime_grants_recognition_*` 等在同一轮里的其它失败面/探针 stderr），同样只写 stderr；判红**只**看退出码与末行。

## 5. 复现 S38：**表级** `REVOKE` 会连带撤销同类型列级授权

S38 的结论写在 `docs/verification/gy-r28-favorites-history-grants-20261020.md` §7.4（「表级 `GRANT` / `REVOKE` 的连带效应（恢复路径必须知道）」）：表级 `GRANT UPDATE` 会把同类型列级条目合并/覆盖，之后表级 `REVOKE UPDATE` 只能撤表级条目，`attacl` 里列级的 `w` 位已经消失，**列级授权无法靠 `REVOKE` 还原** ⇒ 正解是重跑 `20-login-roles.sql`。S38 验的是 `UPDATE (revision)`；本片用**同族的 `SELECT`** 复核一遍（与演练针对的授权同一类型）：

```
基线 90-assert：exit=0 末行='ok' 非空行数=5
favorites.id 的 attacl（恢复后）：{gengyun_api_runtime=ar/gengyun_cvm_owner}
REVOKE SELECT ON TABLE public.favorites（表级）: exit=0
表级 REVOKE 之后 has_column_privilege(favorites.id, SELECT)=f
表级 REVOKE 之后 attacl：{gengyun_api_runtime=a/gengyun_cvm_owner}
has_table_privilege(favorites, SELECT)=f   DELETE=t
重跑 20-login-roles.sql：exit=0 → has_column_privilege=t → 90-assert exit=0 末行='ok'
```

- `ar` → `a`：列级条目里的 `r`（SELECT）**被表级 REVOKE 连带撤掉**，`a`（INSERT）还在 ⇒ 只撤同类型的列级位，不是整条 ACL 清零。
- 表级 `DELETE`（`d`）不受影响（`DELETE=t`），因为本次撤的是 SELECT。
- 恢复后 90-assert 回到 `ok` ⇒ 「误授之后重跑授权文件」这条路径在 `SELECT` 上同样成立，演练选它做靶子是有依据的，不是随便挑一列。

（另有一次独立复跑只取判据，读数逐项一致：`start_col_priv=t` / `table_level_revoke_rc=0` / `after_table_revoke_col_priv=f` / `roles_rerun_rc=0` / `after_roles_col_priv=t` / `assert_rc=0` / `assert_last_line=ok` / `assert_nonempty_lines=5`。）

## 6. 静态守卫单测与两条负控制

单测：`node --test --test-concurrency=1 tests/unit/deploy-sql-gate-recovery.test.mjs` ⇒ `# tests 8 / # pass 8 / # fail 0`，exit 0。

负控制的目的：证明这个守卫**不是**「存在即绿」的空转断言——把 workflow 改坏，它必须判红。两条都跑在真实的 workflow 文件上，用 `sha256` 记录改前/改后，跑完**还原**：

```
sha256_before_all_mutations=1ab3f4f2571736439f999ed680b849dbbd5362588576437867cef6dc88510993

NC1  删掉演练步里的 REVOKE 行（换成 SELECT 1）：
     mutation1_sha=ec66b88d117dd5bf7bbebc27000271ed428e25af5710de7b4ffecbbc05d7e8c4
     guard_exit=1
       not ok 3 - ③ run 内顺序固定：前置 t → 2 次 roles → REVOKE → f → roles → t → 90-assert 且末行 ok
       # tests 8 / # pass 7 / # fail 1
     还原后 sha=1ab3f4f2…（equal_to_before=True）

NC2  给演练步加 `continue-on-error: true`（演练步名在第 190 行）：
     mutation2_sha=6809ca8741d4db78d7e4db838123b2f20782f92a40554255cd6bbd75e77120bf
     guard_exit=1
       not ok 4 - ④ 那一步不带任何软失败构造（`if:` / `continue-on-error` / `|| true` / `set +e`）
       not ok 5 - ⑤ 全 workflow 无 `continue-on-error: true`，且任何 step 的 psql 命令都不接 `|| true`
       # tests 8 / # pass 6 / # fail 2
     还原后 sha=1ab3f4f2…（equal_to_before_2=True）

final_guard_exit=0（8 pass / 0 fail）；sha256_final=1ab3f4f2…（final_equal_before=True）
```

- NC1 证明：**「撤销」这一步被删掉/改成空操作时，守卫会红**——否则演练会退化成「读三次同一个值」。
- NC2 证明：**软失败构造（`continue-on-error`）一进来就被拦**——它能让 step 失败却整体判绿，是这类演练最常见的死法。
- 三次 `sha256` 一致 ⇒ 负控制是「临时改、跑完还原」，最终提交的 workflow 与读数时逐字节同一份。

## 7. 门禁（命令 → exit code）

均在 `E:\GengYunCommander\wt-r28-s42` 下执行，输出取尾部关键行：

| # | 命令 | exit | 关键读数 |
|---|---|---|---|
| 1 | `npm run lint` | 0 | `PASS tsc --noEmit services/api/tsconfig.json` / `PASS tsc --noEmit apps/admin/tsconfig.json` / 仓库卫生扫描通过 / `lint 通过（静态检查…）` |
| 2 | `node tools/verify-release-materials.mjs` | 0 | `15/15 项通过` |
| 3 | `npm run test:docs` | 0 | `研究记录校验：5 通过 / 0 失败 / 4 legacy 已钉住` / `PASS docs/research 结构校验…` |
| 4 | `node tools/verify-contract-status.mjs` | 0 | `PASS: 纯行号区间 229 条…` / `PASS: 中文表格一致` / `PASS: 状态为人工判定…`；另有一行 `WARN: 无锚点可疑引用前 5/268 条`（既有告警，非本片引入、不判红） |
| 5 | `node --test --test-concurrency=1 "tests/contract/*.test.mjs"` | 0 | `# tests 6 / # pass 6 / # fail 0` |
| 6 | `node --test --test-concurrency=1 tests/unit/deploy-sql-gate-recovery.test.mjs` | 0 | `# tests 8 / # pass 8 / # fail 0` |
| 7 | `git diff --check` | 0 | **无输出**（无空白错误） |
| 附 | `node --test --test-concurrency=1 tests/unit/ci-real-pg-wiring.test.mjs` | 0 | `# tests 16 / # pass 16 / # fail 0` ——本片改的 workflow 没有破坏既有的「真库接线 / 禁 `continue-on-error` / `uses:` 钉 SHA」守卫 |

## 8. 未取得项与偏差声明

1. **没在 GitHub Actions runner 上跑过**：本页读数全部来自本机 PG 17.11。runner 与 service 容器的差异（`ubuntu-24.04` 的 psql 版本、`mktemp` 路径、step 总时长）没有实测。
2. **`provision-db.sh` 本体没有执行**：它需要 root、`runuser -u postgres`、`pg_ctlcluster`/真实 CVM 路径；本片只按它的顺序执行同一串 SQL。它自己的调用方式（`:352-374` 段）没有被验证，只被引用。
3. **bash 语法没有在本机执行**：本机 Git Bash 未安装，`WindowsApps\bash.exe` 是 WSL 存根，WSL 到 `/mnt/e/…/psql.exe` 的 interop 报 `could not find a "psql.exe" to execute`。因此第 ⑤ 步的 `run:` 正文是**逐条重放**（SQL 与比较逐字对应），`set -euo pipefail`、`[ … ]`、`for`、`awk`、`$(mktemp)` 等 shell 语义**未在本机执行**——它们的**静态形状**由单测钉住（顺序、无软失败构造、`::error::`/`exit 1` 配对），**运行期语义由 CI 首跑验证**。这是本页最大的取证缺口，如实标注。
4. **`::error::` 注解与 GHA 的 step 失败语义未执行**：本机只验证「比较不成立时脚本会打印该行并 `exit 1`」的文本形态，未在 runner 上观察注解渲染与后续 step 的跳过。
5. **本机 `gengyun_cvm_owner` 是 superuser**（`initdb -U` 的引导身份必然是超管；service 容器的 `POSTGRES_USER` 也是如此），与生产「`CREATEROLE` 非 `SUPERUSER`」不同 ⇒ `20-login-roles.sql` 的前置自检与 90-assert 的 `pg_authid` 断言在本机走超管路径（与既有 `real-pg-integration.yml` 同口径，非本片引入的新偏差）。
6. **断言条数没有逐条重数**：本机只验证「合规态末行 `ok` + exit 0」与「误授态 2 条断言判红」。S38 之后条数按派单/交付记录为 83，但本片**不写死**它，也没有独立复算；文件头注释与终步 `echo` 都改成「以脚本自身判决为准」。
7. **`90-assert-least-privilege.sql` 第 699 行**仍有一条写着「不重跑 78 条断言」的过期注释。该文件不属本片可改范围（派单硬约束），**未修**；记录在此供后续切片处理。
8. **演练步的靶子只有一列**：`public.favorites.id` 的列级 SELECT。选择依据是「该授权只来自 `20-login-roles.sql` I 段、没有表级/继承兜底」（§3.1），不是任意挑一列；但它不能替代对其余列/其余权限类型的同类演练。
9. **未 push / 未建 PR**：按派单要求，分支与提交留在本地 worktree，由指挥统一收口。

## 9. 复核指引

```bash
# 0) 起一个 17.11 集群（或直接用 postgres:17.11 容器），建库 gengyun 与 owner
# 1) 按 workflow 的顺序：迁移 → 5 组角色 → 20-login-roles → 90-assert
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=gengyun_cvm_owner \
       PGPASSWORD=synthetic-ci-owner-only PGDATABASE=gengyun
DATABASE_URL=postgres://gengyun_cvm_owner:synthetic-ci-owner-only@127.0.0.1:5432/gengyun \
  node services/api/src/db/migrate.ts up
for f in auth_privacy catalog_readers consent_granter profile_runtime knowledge_runtime; do
  psql -X -q -v ON_ERROR_STOP=1 -f "services/api/db/roles/${f}.sql"
done
GENGYUN_API_RUNTIME_PASSWORD=4f3c2b1a0e9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e1d \
  psql -X -q -v ON_ERROR_STOP=1 -f deploy/postgres-cvm/sql/20-login-roles.sql
psql -X -q -v ON_ERROR_STOP=1 -f deploy/postgres-cvm/sql/90-assert-least-privilege.sql | tail -n 1   # 期望：ok

# 2) 演练（= workflow 第 ⑤ 步）
psql -X -q -tA -c "SELECT has_column_privilege('gengyun_api_runtime','public.favorites','id','SELECT')"  # t
for i in 1 2; do psql -X -q -v ON_ERROR_STOP=1 -f deploy/postgres-cvm/sql/20-login-roles.sql; echo "roles#$i=$?"; done
psql -X -q -v ON_ERROR_STOP=1 -c "REVOKE SELECT (id) ON TABLE public.favorites FROM gengyun_api_runtime"
psql -X -q -tA -c "SELECT has_column_privilege('gengyun_api_runtime','public.favorites','id','SELECT')"  # f
psql -X -q -v ON_ERROR_STOP=1 -f deploy/postgres-cvm/sql/20-login-roles.sql
psql -X -q -tA -c "SELECT has_column_privilege('gengyun_api_runtime','public.favorites','id','SELECT')"  # t
psql -X -q -v ON_ERROR_STOP=1 -f deploy/postgres-cvm/sql/90-assert-least-privilege.sql | tail -n 1          # ok

# 3) 反向证明：撤掉后不重跑 roles，直接跑 90-assert ⇒ 必须非 0 退出、判决行 FAIL
# 4) 静态守卫：改动 workflow 的 REVOKE 行或加 continue-on-error ⇒ 单测必须红；还原后 sha256 应与改前逐位相等
node --test --test-concurrency=1 tests/unit/deploy-sql-gate-recovery.test.mjs
```

PowerShell 等价（本机实际用的口径）：`$env:PGPASSWORD` 显式设置、`psql -w -X -q -v ON_ERROR_STOP=1 -f …`，每步看 `$LASTEXITCODE`；`90-assert` 的探针会往 stderr 写 `permission denied`，属预期读数，**不要**因此判红，只看退出码与末行。
