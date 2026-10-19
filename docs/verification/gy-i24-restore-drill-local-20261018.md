# 本机备份／恢复演练证据页（Windows + 便携 PostgreSQL 17.11）

- 片号：T-R14-06；取证日期：2026-10-18（UTC 10:12–10:20，北京时间 18:12–18:20）。
- 基线：`git rev-parse upstream/main` = `de66803a596d55cbd9f9ab9b3a1b4aba36482ffa`（取证期间未前进）。worktree `.pg17/wt-restore-drill`，分支 `test/gy-i24-restore-drill`，本页与脚本都基于该提交。
- 取证方式：**真跑**。用 `E:\GengYunCommander\.pg17\pgsql\bin` 的便携 PG 17.11 起隔离集群 → 建库 → **用真实迁移器** `services/api/src/db/migrate.ts up` 应用 0001–0017 → 建角色／授权（`services/api/db/roles/*.sql`、`deploy/postgres-cvm/sql/20-login-roles.sql`、`90-assert-least-privilege.sql`）→ 灌最小数据（2 `users` / 1 `media` / 1 `jobs`）→ `pg_dump -Fc` → 新建空库 `pg_restore --exit-on-error` → 五条判据逐条判定 → 2 条负控制。
- 结论：五条判据本轮**全绿**（`PASS=24 FAIL=0`，exit 0）；2 条负控制都按要求**变红**（各 exit 1）；退出码 2 的「证据不完整」路径也实跑（exit 2）。**这是本机演练，不是 CVM 验收**：`deploy/postgres-cvm/restore-drill.sh` 未改动、未执行，本页不能、也不用于声明「生产可恢复」或「数据库已验收」。
- 交付物关系：`deploy/postgres-cvm/restore-drill.ps1` 是 shell 版的 Windows 等价实现，**同五条判据、同退出码语义、同「只允许在 drill/restore 命名空间内重建目标库」的约束**；差别只在进程与权限模型（Windows 没有 `runuser`/systemd，走 TCP + 口令文件，不切换系统用户）。
- 版本说明：本页为**修正版**。上一版（`7f0e25f`）的集群是手工搭的：`schema_migrations` 账本未记录来源、角色／授权状态未记录，导致页内读数在按文档重跑时不可复现（复核实测：只应用 17 个 `.sql` 得 **50 张基表、无账本**，脚本 fail-closed 直接 exit 1）。本版把**建库全过程按 `install-postgres.sh` / `provision-db.sh` 的口径写全**并整轮重跑，页内所有读数均来自本轮。

## 0. 取证环境（可复核的事实）

| 事实 | 读数 | 依据 |
| --- | --- | --- |
| 便携 PG | `postgres (PostgreSQL) 17.11` | `<pgsql>\bin\postgres.exe --version` |
| 集群初始化 | `initdb -D <data> -U gengyun_cvm_owner --auth-host=scram-sha-256 --pwfile=<临时口令文件> --encoding=UTF8 --locale=C --data-checksums` | 与 `deploy/postgres-cvm/install-postgres.sh:487-495` 同口径；口令只经文件传，不落 argv／不打印 |
| 集群配置 | 追加 `port = 55631`、`listen_addresses = '*'` 到数据目录 `postgresql.conf` | 该文件 `PG_VERSION` = `17` |
| 认证 | `local all all trust`（Windows 无 Unix socket，实际全走 TCP）；`host all all 127.0.0.1/32 scram-sha-256`；`host all all ::1/128 scram-sha-256` | `pg_hba.conf`；**所有** TCP 连接（含属主）都要口令，脚本从 `-OwnerPasswordFile` 读 |
| 保留段核对 | `netsh interface ipv4 show excludedportrange protocol=tcp` 列出 `5357`、`50000-50059*`、`55394-55493`、`56018-56117`、`60338-60437`、`61782-61881`、`62076-62175`、`64448-64547`；**55631 不在其中** | 命令输出 |
| 服务端 | `server is running (PID: 20776)` | `pg_ctl status` |
| 源库 | `gengyun`，属主角色 `gengyun_cvm_owner`（超级用户），`SHOW server_version` = `17.11`，`server_encoding` = `UTF8`，`datcollate` = `C` | psql |
| 迁移来源 | `node services/api/src/db/migrate.ts up` ⇒ 17 个全部应用；`schema_migrations` 由迁移器的 `ensureLedger`（`services/api/src/db/migrate.ts:107`）建，**17 个迁移 `.sql` 里没有任何一个建它** | 命令输出 + 源码行 |
| 角色／授权 | 8 个 `services/api/db/roles/*.sql` ⇒ 11 个 NOLOGIN 组；`sql/20-login-roles.sql` ⇒ `gengyun_api_runtime`（LOGIN）+ 5 个组成员关系 + 函数 `EXECUTE`；`sql/90-assert-least-privilege.sql` ⇒ 输出 `ok`、exit 0。共 13 个 `gengyun*` 角色，13 条非属主表级授权 | psql 计数 + 断言脚本 |
| 库内规模 | 基表 **51**、视图 **8**、schema `catalog_ops`/`catalog_read`/`knowledge_staging`/`public`/`staging_intake`；`schema_migrations` **17** 行（`0001`–`0017`） | psql 计数 |
| 种子数据 | `users` 2 行、`media` 1 行、`jobs` 1 行（固定 UUID；`media.sha256` = `a1`×32） | 种子 SQL 见 §1② |
| dump 读数 | **240342 B**、`pg_restore --list` 含 `;` 的条目 **503** 条 | §1④ / §2 |

种子与集群都在仓外临时目录（`.pg17\tmp\`），**不入仓**；口令文件同样只在临时目录，演练结束后已删（见 §7）。

> 口径说明：以下是本轮**实际执行**的命令形式。临时日志、dump、数据目录、口令文件都按 §7 删除（口令文件必须删），留存的是读数、配置与提交；命令按「照抄即可重跑」写，不假装保留了每一次交互的原始终端历史。

## 1. 命令逐条

### ① 起隔离集群（端口避开保留段；`listen_addresses='*'`，不要只绑 127.0.0.1）

```powershell
# 口令文件单行；initdb 用它设 gengyun_cvm_owner 的口令（不打印、不进 argv）
& "<pgsql>\bin\initdb.exe" -D "E:\GengYunCommander\.pg17\tmp\drill-pg\data" `
    -U gengyun_cvm_owner --auth-host=scram-sha-256 `
    --pwfile="E:\GengYunCommander\.pg17\tmp\drill-owner.pw" `
    --encoding=UTF8 --locale=C --data-checksums
Add-Content "…\drill-pg\data\postgresql.conf" "`nport = 55631`nlisten_addresses = '*'`n"
cmd.exe /c '"<pgsql>\bin\pg_ctl.exe" -D "…\drill-pg\data" -l "…\drill-pg\logs\postgres.log" start -w > "…\pgctl.out" 2>&1'
```

> 起服务的坑（本机实测）：`pg_ctl … | Select-Object` 会让 postgres 继承管道句柄而永久挂起；`Start-Process -Wait` 会等子进程树。两条都别用，改用 `cmd.exe /c` 重定向到文件。

### ② 建库 → **真实迁移器应用迁移** → 角色／授权 → 灌最小数据

```powershell
$env:PGPASSWORD = (Get-Content '…\drill-owner.pw' -Raw).Trim()
& "<pgsql>\bin\createdb.exe" -h 127.0.0.1 -p 55631 -U gengyun_cvm_owner -O gengyun_cvm_owner -T template0 -E UTF8 gengyun

# 迁移：跑迁移器本身（不要用 psql -f 逐个应用 —— 那样不会有 schema_migrations）
$env:DATABASE_URL = "postgres://gengyun_cvm_owner:$env:PGPASSWORD@127.0.0.1:55631/gengyun"
node services/api/src/db/migrate.ts up
# ⇒ 发现 17 个迁移；已应用 0001…0017；已存在跳过（无）

# 角色：先建 8 个 NOLOGIN 组（provision-db.sh 第 4 步），再建运行时 LOGIN 并授予 5 个组
Get-ChildItem services\api\db\roles\*.sql | Sort-Object Name | ForEach-Object {
  & "<pgsql>\bin\psql.exe" -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 55631 -U gengyun_cvm_owner -d gengyun -f $_.FullName
}
$env:GENGYUN_API_RUNTIME_PASSWORD = '<48 位小写十六进制，临时>'
& "<pgsql>\bin\psql.exe" -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 55631 -U gengyun_cvm_owner -d gengyun -f deploy\postgres-cvm\sql\20-login-roles.sql
& "<pgsql>\bin\psql.exe" -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 55631 -U gengyun_cvm_owner -d gengyun -f deploy\postgres-cvm\sql\90-assert-least-privilege.sql
# ⇒ 20-login-roles：`gengyun_api_runtime 已就位并授予 5 个既有 NOLOGIN 组`；90-assert：`ok`（exit 0）

& "<pgsql>\bin\psql.exe" -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 55631 -U gengyun_cvm_owner -d gengyun -f …\drill-seed.sql
```

中间读数（每步之后用 psql 复核，全部与脚本清单一致）：迁移后 `tables=51 / views=8 / ledger=17`；角色后 `gengyun*` 角色 13 个（`gengyun_cvm_owner` + 11 个 NOLOGIN 组 + `gengyun_api_runtime`）；`90-assert` 输出 `ok`。

种子 SQL（仓外文件 `.pg17\tmp\drill-seed.sql`，内容全文）：

```sql
INSERT INTO public.users (id, wechat_subject_cipher, wechat_subject_lookup, nickname, auth_epoch) VALUES
  ('11111111-1111-4111-8111-111111111111', 'v1:drill-user-a', '\x0a0b0c0d', '演练用户甲', 1),
  ('22222222-2222-4222-8222-222222222222', 'v1:drill-user-b', '\x0a0b0c0e', '演练用户乙', 1);
INSERT INTO public.media (id, owner_id, purpose, mime, bytes, sha256, object_ref_cipher) VALUES
  ('33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111',
   'weed_recognition', 'image/jpeg', 1024, repeat('a1', 32), 'v1:drill-object-ref');
INSERT INTO public.jobs (id, owner_id, kind, target_type, target_id, entity_revision, input_hash, auth_epoch, deadline_at) VALUES
  ('44444444-4444-4444-8444-444444444444', '11111111-1111-4111-8111-111111111111',
   'media.derive', 'media', '33333333-3333-4333-8333-333333333333', 1, repeat('b2', 32), 1, now() + interval '1 hour');
```

`SEED_EXIT=0`；复核 `users=2 / media=1 / jobs=1`。

### ③ 主演练（备份 → 恢复 → 五条判据）

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "…\wt-restore-drill\deploy\postgres-cvm\restore-drill.ps1" -PgBin E:\GengYunCommander\.pg17\pgsql\bin -Database gengyun -Port 55631 -WorkDir "…\drill-pg\work" -OwnerPasswordFile "…\drill-owner.pw"
```

### ④ 同命令加 `-Keep`（保留目标库，用于核对恢复后的数据与授权）

```powershell
… -Keep
```

### ⑤ 负控制 1：把恢复打进**非空**目标库（`-NoRecreate`，脚本唯一允许的不 DROP 路径）

```powershell
… -Keep -NoRecreate -DumpFile "…\work\gengyun-gengyun-20261018T101715Z.dump"
```

### ⑥ 负控制 2：目标集群**缺角色**（异地灾备的首败点）

```powershell
& "<pgsql>\bin\pg_dump.exe" -Fc -Z 6 -h 127.0.0.1 -p 55631 -U gengyun_cvm_owner -d gengyun -f …\manual\d3.dump
& "<pgsql>\bin\psql.exe" … -c "ALTER ROLE gengyun_consent_granter RENAME TO gengyun_consent_granter_absent"
… -Keep -DumpFile …\manual\d3.dump
& "<pgsql>\bin\psql.exe" … -c "ALTER ROLE gengyun_consent_granter_absent RENAME TO gengyun_consent_granter"   # 复原
```

### ⑦ 退出码 2 路径：有 dump 无清单（`-NoManifest`）

```powershell
… -NoManifest -DumpFile "…\gengyun-gengyun-20261018T101715Z.dump"
```

### ⑧ 停集群 + 清理

```powershell
cmd.exe /c '"<pgsql>\bin\pg_ctl.exe" -D "…\drill-pg\data" -m fast -w stop > "…\stop.out" 2>&1'
```

## 2. 五条判据读数（③ 的运行）

| # | 判据 | 期望 | 实际 | 判定 |
| --- | --- | --- | --- | --- |
| 1/5 | dump sha256 | 清单记录值 | `15d666a195967bb1a84a727e77c709bff8615011f0150a7a2ebe87eafd0fbeea` | PASS |
| 1b/5 | `restore_toc_entries`（附） | 503 | 503 | PASS |
| 2/5 | `pg_restore --exit-on-error` | exit=0 且输出无 `ERROR:` | exit=0；非致命 `WARNING/NOTICE` 0 行 | PASS |
| 3/5 | `schema_migrations` 版本集合 | `0001,0002,…,0017` | `0001,0002,…,0017`（17 项逐字符一致） | PASS |
| 4/5 | 基表数 | 51 | 51 | PASS |
| 4/5 | 视图数 | 8 | 8 | PASS |
| 5/5 | 18 张关键表逐表行数 | 清单值 | 逐表一致（`public.users=2`，其余 17 张 0 行） | PASS |

汇总读数：`PASS=24 FAIL=0`，退出码 **0**，结论行「恢复演练【通过】」；dump `240342 B`、清单 32 行。

`users` 非 0 是这次特意灌的种子：**行数判据真的读了数据**，不是空库上的空判据。`media`/`jobs` 不在 shell 版 `KEY_TABLES` 里（本脚本与 shell 逐行保持一致），故在 ④ 保留的目标库里单独核对（读数来自 `gengyun_restore_drill`）：

```text
users=2  media=1  jobs=1
media_sha=a1a1a1a1…（`a1`×32，bpchar(64) 定长值原样）
owner_users=gengyun_cvm_owner        -- pg_get_userbyid(relowner)
ledger=17  tables=51
nonowner_table_grants=13             -- 源库 13 条，恢复后 13 条
has_table_privilege('gengyun_consent_granter','public.consent_policies','SELECT') = t
has_function_privilege('gengyun_api_runtime','public.suspend_account(uuid,uuid,uuid,integer,uuid)','EXECUTE') = t
```

即：数据行、`bpchar(64)` 定长值、对象属主、**13 条非属主表级授权与运行时角色的函数执行权**都在恢复后原样存在。注意最后四项是**人工回读**，不在脚本的五条判据里（见 §6）。

## 3. 负控制（判据必须会红）

### 3.1 负控制 1：恢复进非空目标库

做法：先 ④ 让目标库留下上一次恢复的完整内容，再 ⑤ 用 `-NoRecreate` 把同一份 dump 恢复进**非空**目标库（等价于「恢复前预置同名对象」）。读数：

```text
PASS 判据1/5 dump_sha256                        期望=17687754a6cfe90f… 实际=17687754a6cfe90f…
PASS 判据1b/5 restore_toc_entries               期望=503 实际=503
FAIL 判据2/5 pg_restore --exit-on-error         期望=exit=0 且无 ERROR: 实际=exit=1；致命 error 行=1
         pg_restore: error: could not execute query: ERROR:  schema "catalog_ops" already exists
[restore-drill.ps1] 恢复未成功：判据 3/4/5 跳过（与 shell 版同条件），结论已是【未通过】。
PASS=2 FAIL=1
[restore-drill.ps1] 结论：恢复演练【未通过】。该备份不足以声称可恢复，禁止据此宣称已有可用备份。
```

退出码 **1**，失败精确落在判据 2。

### 3.2 负控制 2：目标集群缺一个角色

做法：用当前库做一份 dump（`d3.dump`，240342 B），**在目标集群里把一个组角色改名**（`gengyun_consent_granter` → `gengyun_consent_granter_absent`，模拟「全新集群没有这个角色」），再恢复同一份 dump：

```text
FAIL 判据2/5 pg_restore --exit-on-error         期望=exit=0 且无 ERROR: 实际=exit=1；致命 error 行=1
         pg_restore: error: could not execute query: ERROR:  role "gengyun_consent_granter" does not exist
PASS=0 FAIL=1
[restore-drill.ps1] 结论：恢复演练【未通过】。该备份不足以声称可恢复，禁止据此宣称已有可用备份。
```

退出码 **1**。随后把角色改回、`DROP DATABASE gengyun_restore_drill`、重跑 `90-assert-least-privilege.sql` 得 `ok`（exit 0），确认环境复原。

这条把 §6「异地/全新集群必须先重建角色」从推断变成**有原文报错**的实测：dump 里没有角色定义，缺角色时恢复会以 `role … does not exist` 失败，且脚本判据 2 会红。

## 4. 退出码 2（证据不完整）也实跑

`-NoManifest` 时恢复本身成功、但清单缺失，判据 1/3/4/5 不执行：

```text
[restore-drill.ps1][WARN] -NoManifest：本次判定不使用清单 ⇒ 判据 1/3/4/5 与 1b 不执行，证据不完整（退出码 2）。
PASS 判据2/5 pg_restore --exit-on-error         期望=exit=0 且无 ERROR: 实际=exit=0；非致命 WARNING/NOTICE 0 行
PASS=1 FAIL=0
[restore-drill.ps1] 结论：恢复本身成功，但缺清单，行数/迁移版本判据未执行 ⇒ 证据不完整，不算演练通过。
```

退出码 **2**。三个退出码（0/1/2）都是实跑读数，不是读代码推的。

## 5. 四条实测发现（会影响判据怎么用）

1. **`pg_dump` 不是字节确定的**：同一份不变的数据连做两次 `pg_dump -Fc -Z 6`，字节数都是 `240342`，sha256 却是 `85080e69871dfab3…` 与 `b0a2e01ccc44b914…`。⇒ 判据 1 只能校验「这次恢复用的文件就是清单里记下的那个文件」，**不能**拿 sha256 跨次比对「备份是否没变」；要跨次比对得比数据面（行数/版本集合）。
2. **成功时 `pg_restore` 一行输出都没有**：本机成功恢复的日志都是 **0 字节**，失败那两次才有内容（判据 2 的致命 error 行就是从这里数的）。⇒ 「输出无 `ERROR:`」必须读日志文件，空日志是正常态，不是「没跑」。
3. **dump 的体积与 TOC 对「角色/授权」高度敏感**：上一版集群没记录角色／授权，读数 `203648 B / 372 条`；独立复核在只应用迁移的库上测得 `194095 B / 336 条`，补 8 个组 + `20-login-roles.sql` 后变成 `230947 B / 468 条`；本版（含账本 + 13 个角色 + 13 条非属主授权 + 函数授权）是 `240342 B / 503 条`。⇒ 这类读数**离开环境事实就没有意义**，§0 因此把迁移来源、角色、授权逐项列出。
4. **Windows 保留端口段会让客户端一律「拒绝连接」**：候选端口落在 `netsh` 列出的保留段里时，服务端能起、`psql` 却连不上，报错像权限问题而实际是端口被占。脚本因此把保留段核对做成硬门禁（命中即停，不提供静默跳过）。

## 6. 未取得项（不得据此下结论）

- **CVM 侧未取得**：`systemd` 单元、`runuser`/系统用户切换、Unix socket 路径、`/var/lib/postgresql` 目录布局。本页全部读数来自 Windows + TCP。
- **异地/全新集群灾备未取得**：本机是**同集群内另建库**；§3.2 只证明了「缺角色会红」，没有在全新集群上从零重建角色并把演练跑绿。
- **授权面不在五条判据内**：脚本判据只覆盖 sha、恢复退出码、迁移版本、表/视图数、关键表行数；§2 的 `pg_get_userbyid` / `has_table_privilege` / `has_function_privilege` 是**人工回读**，不是判据。属主归属与 13 条授权「原样存在」是本机一次读数，不等于脚本会在别的库上自动判定。
- **PITR 未取得**：无 WAL 归档配置，无法演练时间点恢复。
- **逐用户删除清单重放未取得**：`GB_T_35273` 类删除清单的重放在本片范围外。
- **RPO/RTO 指标未取得**：只有一次 `240342 B` 库的单次耗时读数，不足以给指标。
- **生产可恢复性未取得**：本页证明的是「这一份 dump 能在这台机器的同主版本 PG 17.11 上完整重建 schema + 数据 + 对象属主，且五条判据逐项一致」，**不是**生产验收。

## 7. 清理（删除前重解析点枚举 = 0）

```text
STOP_EXIT=0
waiting for server to shut down.... done
server stopped
pg_ctl: no server running        (pg_ctl status 退出码 3)
MATCHED=46 REPARSE=0
```

删前对 `.pg17\tmp\` 下名字含 `drill` 的 46 个条目做重解析点枚举，**0 个**；只删本次产物：`.pg17\tmp\drill-pg\`（数据目录 + 日志 + 工作目录 + 手工 dump）、`drill-seed.sql`、`drill-owner.pw`（口令文件必须删，不留存）。同名前缀的其他会话目录（如 `…-driftr4`）未动。

删后复核：`Get-ChildItem .pg17\tmp -Filter 'drill*'` 计数 **0**；`pg_ctl status -D …\drill-pg\data` 报 `directory … does not exist`（退出码 4），即集群确已停止、目录确已删除。
