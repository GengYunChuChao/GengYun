# 本机备份／恢复演练证据页（Windows + 便携 PostgreSQL 17.11）

- 片号：T-R14-06；取证日期：2026-10-18（当地时间 17:39–17:52，UTC 09:39–09:52）。
- 基线：`git rev-parse upstream/main` = `de66803a596d55cbd9f9ab9b3a1b4aba36482ffa`（取证期间未前进）。worktree `.pg17/wt-restore-drill`，分支 `test/gy-i24-restore-drill`，本页与脚本都基于该提交。
- 取证方式：**真跑**。用 `E:\GengYunCommander\.pg17\pgsql\bin` 的便携 PG 17.11 起一个隔离集群，建库 → 应用 `services/api/db/migrations/*.sql`（0001–0017）→ 灌最小数据（2 `users` / 1 `media` / 1 `jobs`）→ `pg_dump -Fc` → 新建空库 `pg_restore --exit-on-error` → 五条判据逐条判定，另跑 1 条负控制。
- 结论：五条判据本轮**全绿**（`PASS=24 FAIL=0`，exit 0）；负控制按要求**变红**（exit 1，`判据2` FAIL）；退出码 2 的「证据不完整」路径也实跑验证（exit 2）。**这是本机演练，不是 CVM 验收**：`deploy/postgres-cvm/restore-drill.sh` 未改动、未执行，本页不能、也不用于声明「生产可恢复」或「数据库已验收」。
- 交付物关系：`deploy/postgres-cvm/restore-drill.ps1` 是 shell 版的 Windows 等价实现，**同五条判据、同退出码语义、同「只允许在 drill/restore 命名空间内重建目标库」的约束**；差别只在进程与权限模型（Windows 没有 `runuser`/systemd，走 TCP + 口令文件，不切换系统用户）。

## 0. 取证环境（可复核的事实）

| 事实 | 读数 | 依据 |
| --- | --- | --- |
| 便携 PG | `postgres (PostgreSQL) 17.11` | `<pgsql>\bin\postgres.exe --version` |
| 集群数据目录 | `.pg17\tmp\drill-pg\data`（`PG_VERSION` = `17`） | 目录内文件 |
| 端口 | `port = 55631`、`listen_addresses = '*'` | 该目录 `postgresql.conf` |
| 保留段核对 | `netsh interface ipv4 show excludedportrange protocol=tcp` 列出 `5357`、`50000-50059*`、`55394-55493`、`56018-56117`、`60338-60437`、`61782-61881`、`62076-62175`、`64448-64547`；**55631 不在其中** | 命令输出 |
| 认证 | `host all gengyun_cvm_owner 127.0.0.1/32 scram-sha-256`（排在最前）、其余回环 `trust`；脚本只从 `-OwnerPasswordFile` 读口令，不落命令行、不打印 | `pg_hba.conf` + 脚本第 0 节 |
| 服务端 | `server is running (PID: 42976)`，启动参数 `postgres.exe "-D" "E:/GengYunCommander/.pg17/tmp/drill-pg/data"` | `pg_ctl status` |
| 源库 | `gengyun`，属主角色 `gengyun_cvm_owner`，`SHOW server_version` = `17.11` | psql |
| 库内规模 | 基表 **51**、视图 **8**、schema `catalog_ops`/`catalog_read`/`knowledge_staging`/`public`/`staging_intake`；`schema_migrations` **17** 行（`0001`–`0017`） | psql 计数 |
| 种子数据 | `users` 2 行、`media` 1 行、`jobs` 1 行（固定 UUID；`media.sha256` = `a1`×32） | 种子 SQL 见 §1② |

种子与集群都在仓外临时目录（`.pg17\tmp\`），**不入仓**；口令文件同样只在临时目录，演练结束后已删（见 §5）。

## 1. 命令逐条

> 口径说明：以下是本次执行的**等价复现形式**。临时日志、dump、数据目录都按 §7 清理删除（口令文件必须删），所以留存下来的是**读数、配置与提交**；命令本身按"照抄即可重跑"写，不假装保留了每一次交互的原始终端历史。

### ① 起隔离集群（端口避开保留段；`listen_addresses='*'`，不要只绑 127.0.0.1）

```powershell
& "<pgsql>\bin\initdb.exe" -D "E:\GengYunCommander\.pg17\tmp\drill-pg\data" ...
# 生效配置（节选，可复核）：port = 55631 / listen_addresses = '*'
cmd.exe /c '"<pgsql>\bin\pg_ctl.exe" -D "E:\GengYunCommander\.pg17\tmp\drill-pg\data" -l "…\pgctl.out" start -w > "…\pgctl.out" 2>&1'
```

> `initdb` 的具体选项参数已随数据目录一起删除、无法逐字复现，故此处只给可复核的生效值：`PG_VERSION=17`、`port=55631`、`listen_addresses='*'`、编码 `UTF8`、`datcollate=C`、属主角色 `gengyun_cvm_owner`（§0 表）。

> 起服务的坑（本机实测）：`pg_ctl … | Select-Object` 会让 postgres 继承管道句柄而永久挂起；`Start-Process -Wait` 会等子进程树。两条都别用，改用 `cmd.exe /c` 重定向到文件。

### ② 建库 → 应用迁移 → 灌最小数据

```powershell
$env:PGPASSWORD = (Get-Content 'E:\GengYunCommander\.pg17\tmp\drill-owner.pw' | Where-Object { $_.Trim() } | Select-Object -First 1)
& "<pgsql>\bin\createdb.exe" -h 127.0.0.1 -p 55631 -U gengyun_cvm_owner -O gengyun_cvm_owner -T template0 -E UTF8 gengyun
Get-ChildItem services\api\db\migrations\*.sql | Sort-Object Name | ForEach-Object {
  & "<pgsql>\bin\psql.exe" -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 55631 -U gengyun_cvm_owner -d gengyun -f $_.FullName
}
& "<pgsql>\bin\psql.exe" -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 55631 -U gengyun_cvm_owner -d gengyun -f E:\GengYunCommander\.pg17\tmp\drill-seed.sql
```

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
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "E:\GengYunCommander\.pg17\wt-restore-drill\deploy\postgres-cvm\restore-drill.ps1" -PgBin E:\GengYunCommander\.pg17\pgsql\bin -Database gengyun -Port 55631 -WorkDir E:\GengYunCommander\.pg17\tmp\drill-pg\work -OwnerPasswordFile E:\GengYunCommander\.pg17\tmp\drill-owner.pw
```

### ④ 同命令加 `-Keep`（保留目标库，用于核对恢复后的数据）

```powershell
… -Keep
```

### ⑤ 负控制：把恢复打进**非空**目标库（`-NoRecreate`，脚本唯一允许的不 DROP 路径）

```powershell
… -Keep -NoRecreate -DumpFile "E:\GengYunCommander\.pg17\tmp\drill-pg\work\gengyun-gengyun-20261018T095004Z.dump"
```

### ⑥ 退出码 2 路径：有 dump 无清单（`-NoManifest`）

```powershell
… -NoManifest -DumpFile "…\gengyun-gengyun-20261018T095004Z.dump"
```

### ⑦ 停集群 + 清理

```powershell
cmd.exe /c '"<pgsql>\bin\pg_ctl.exe" stop -D "E:\GengYunCommander\.pg17\tmp\drill-pg\data" -m fast -w > "…\stop.out" 2>&1'
```

## 2. 五条判据读数（③ 的运行，`drill-run1.log`）

| # | 判据 | 期望 | 实际 | 判定 |
| --- | --- | --- | --- | --- |
| 1/5 | dump sha256 | 清单记录值 | `579e0e0effcbe325…` | PASS |
| 1b/5 | `restore_toc_entries`（附） | 372 | 372 | PASS |
| 2/5 | `pg_restore --exit-on-error` | exit=0 且输出无 `ERROR:` | exit=0；非致命 `WARNING/NOTICE` 0 行 | PASS |
| 3/5 | `schema_migrations` 版本集合 | `0001,0002,…,0017` | `0001,0002,…,0017`（17 项逐字符一致） | PASS |
| 4/5 | 基表数 | 51 | 51 | PASS |
| 4/5 | 视图数 | 8 | 8 | PASS |
| 5/5 | 18 张关键表逐表行数 | 清单值 | 逐表一致（`public.users=2`，其余 17 张 0 行） | PASS |

汇总读数：`PASS=24 FAIL=0`，退出码 **0**，结论行「恢复演练【通过】」。

`users` 非 0 是这次特意灌的种子：**行数判据真的读了数据**，不是空库上的空判据。`media`/`jobs` 不在 shell 版 `KEY_TABLES` 里（本脚本与 shell 逐行保持一致），故在 ④ 保留的目标库里单独核对：

```text
users=2
media=1
jobs=1
media_sha=a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1
owner=gengyun_cvm_owner
```

即数据行、`bpchar(64)` 定长值、属主归属（`pg_get_userbyid(relowner)`）都在恢复后原样存在。

## 3. 负控制（判据必须会红）

做法：先 ④ 让目标库留下上一次恢复的完整内容，再 ⑤ 用 `-NoRecreate` 把同一份 dump 恢复进**非空**目标库（等价于「恢复前预置同名对象」）。读数：

```text
PASS 判据1/5 dump_sha256                        期望=83cf92f10d744669… 实际=83cf92f10d744669…
PASS 判据1b/5 restore_toc_entries               期望=372 实际=372
FAIL 判据2/5 pg_restore --exit-on-error         期望=exit=0 且无 ERROR: 实际=exit=1；致命 error 行=1
         pg_restore: error: could not execute query: ERROR:  schema "catalog_ops" already exists
[restore-drill.ps1] 判读：目标库不是空的（对象已存在）。正常路径下脚本会先 DROP 再建；只有在 -NoRecreate 负控制里才会看到它。这不是 dump 的问题。
[restore-drill.ps1] 恢复未成功：判据 3/4/5 跳过（与 shell 版同条件），结论已是【未通过】。
PASS=2 FAIL=1
[restore-drill.ps1] 结论：恢复演练【未通过】。该备份不足以声称可恢复，禁止据此宣称已有可用备份。
```

退出码 **1**。该次 `pg_restore` 日志（134 B）全文：

```text
pg_restore: error: could not execute query: ERROR:  schema "catalog_ops" already exists
Command was: CREATE SCHEMA catalog_ops;
```

复原：`DROP DATABASE gengyun_restore_drill` 后 `SELECT … datname like '%drill%'` 返回 `(none)`；后续 ⑥ 又真实走了一遍「建库→恢复→删库」，均干净。

## 4. 退出码 2（证据不完整）也实跑

`-NoManifest` 时恢复本身成功、但清单缺失，判据 1/3/4/5 不执行：

```text
[restore-drill.ps1][WARN] -NoManifest：本次判定不使用清单 ⇒ 判据 1/3/4/5 与 1b 不执行，证据不完整（退出码 2）。
PASS 判据2/5 pg_restore --exit-on-error         期望=exit=0 且无 ERROR: 实际=exit=0；非致命 WARNING/NOTICE 0 行
PASS=1 FAIL=0
[restore-drill.ps1] 结论：恢复本身成功，但缺清单，行数/迁移版本判据未执行 ⇒ 证据不完整，不算演练通过。
```

退出码 **2**。三个退出码（0/1/2）都是实跑读数，不是读代码推的。

## 5. 三条实测发现（会影响判据怎么用）

1. **`pg_dump` 不是字节确定的**：同一份不变的数据连做两次 `pg_dump -Fc -Z 6`，字节数都是 203648，sha256 却是 `8b60ec15da0ab170…` 与 `116460e5336bb200…`。⇒ 判据 1 只能校验「这次恢复用的文件就是清单里记下的那个文件」，**不能**拿 sha256 跨次比对「备份是否没变」；要跨次比对得比数据面（行数/版本集合），不能用哈希。
2. **成功时 `pg_restore` 一行输出都没有**：本机所有成功恢复的日志都是 **0 字节**，失败那次才 134 字节。⇒ 判据 2 的「输出无 `ERROR:`」必须读日志文件，不能看终端是否有字；空日志是正常态，不是「没跑」。
3. **Windows 保留端口段会让客户端一律「拒绝连接」**：第一个候选端口落在 `netsh` 列出的保留段里时，服务端能起、`psql` 却连不上，报错像权限问题而实际是端口被占。脚本因此把保留段核对做成硬门禁（命中即停，不提供静默跳过）。

## 6. 未取得项（不得据此下结论）

- **CVM 侧未取得**：`systemd` 单元、`runuser`/系统用户切换、Unix socket 路径、`/var/lib/postgresql` 目录布局。本页全部读数来自 Windows + TCP。
- **异地/全新集群灾备未取得**：dump 不含角色定义，恢复到全新集群必须先重建 `gengyun_cvm_owner` 等角色；本机是同集群内另建库，不覆盖该路径。
- **PITR 未取得**：无 WAL 归档配置，无法演练时间点恢复。
- **逐用户删除清单重放未取得**：`GB_T_35273` 类删除清单的重放在本片范围外。
- **RPO/RTO 指标未取得**：只有一次 203648 B 库的单次耗时读数，不足以给指标。
- **生产可恢复性未取得**：本页证明的是「这一份 dump 能在这台机器的同主版本 PG 17.11 上完整重建 schema+数据+属主/授权且判据逐项一致」，**不是**生产验收。

## 7. 清理（删除前重解析点枚举 = 0）

```text
STOP_EXIT=0
waiting for server to shut down.... done
server stopped
pg_ctl: no server running   (pg_ctl status 退出码 3)
MATCHED=1602 REPARSE=0
```

删前对 `.pg17\tmp\` 下所有 1602 个名字含 `drill` 的条目做重解析点枚举，**0 个**；随后删除 `.pg17\tmp\drill-pg\`（数据目录 + 工作目录）、`drill-seed.sql`、`drill-run*.log`、`drill-owner.pw`（口令文件必须删，不留存）。

删后复核：`Get-ChildItem .pg17\tmp -Filter '*drill*'` 返回空；`pg_ctl status -D …\drill-pg\data` 报 `directory … does not exist`（退出码 4），即集群确已停止、目录确已删除。
