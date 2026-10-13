# 等价命令：在"只有 Unix 套接字、无 root / 无 systemd"的隔离环境里复跑

> **这份文件是"外部复核用的等价命令"，不是部署路径。**
>
> - 目标 CVM 上的权威路径仍然是脚本本身（[install-postgres.sh](install-postgres.sh) /
>   [provision-db.sh](provision-db.sh) / [backup-postgres.sh](backup-postgres.sh) /
>   [restore-drill.sh](restore-drill.sh)），它们假定 **Linux + root + systemd**。
> - 当复核环境是"本机便携版 PostgreSQL、只有 AF_UNIX 套接字、没有 root/systemd、node-postgres 也连不上"
>   时，用下面的命令**手工复现脚本的动作**，以取得可比的证据。
> - 状态：技术准备物。**这些等价命令没有被本单写手执行过**（本机无 PostgreSQL）；
>   它们由外部复核者执行，原始输出由其回传。
> - **不要把这里的任何命令当作生产步骤**；也不要因为这里能跑就认为脚本已在 CVM 上验证。

约定：下文的 `PSQL` / `PG_DUMP` / `PG_RESTORE` / `CREATEDB` / `DROPDB` 指你的 17.11 二进制；
**省略 `-h`** 即走你自己的默认套接字（本文件假定的环境就是这样），若套接字在别处则加
`-h <套接字目录>`。角色一律用 `gengyun_cvm_owner`（迁移管理员）。

```bash
PSQL=psql; PG_DUMP=pg_dump; PG_RESTORE=pg_restore; CREATEDB=createdb; DROPDB=dropdb
DB=gengyun
```

## 1 复跑 15 项最小权限断言（不依赖 `migrate.ts`）

**为什么原先跑不通**：`services/api/db/migrations/*.sql` 只是 DDL，**台账 `schema_migrations`
是 `migrate.ts` 运行时创建的**。用 `psql -f` 逐个应用迁移时不会有该台账；
而旧版 `90-assert-least-privilege.sql` 把台账列进了硬前置 ⇒ 前置守卫早停（这是**正确行为**，
但仍挡住了 15 项断言的验证）。

**本版已按依赖关系收窄**（只改"前置"，**15 项断言的语义一字未改**）：
台账改为**软前置**——缺失时只告警、不失败。因为**15 项断言没有任何一项读取 `schema_migrations`**；
断言真正依赖的是 7 个业务关系 + 运行时角色 + 5 个既有 NOLOGIN 组，这些仍是硬前置。
台账的权威判定点仍在目标 CVM 侧：`provision-db.sh` 的迁移门禁 + `verify-cvm-postgres.sh` 的
`migrations_applied`。

```bash
# 1) 备好隔离库（角色只需建一次，建在集群层面）
CREATE_ROLES_ONCE=1   # 说明：roles/*.sql 是裸 CREATE ROLE，第二次在同集群会报“角色已存在”，
                      #       这是**脚本设计**（不 DROP 别人的角色），不是缺陷
$CREATEDB -O gengyun_cvm_owner assert_probe
for f in services/api/db/migrations/*.sql; do
  $PSQL -v ON_ERROR_STOP=1 -d assert_probe -f "$f" || { echo "MIGRATION FAILED: $f"; break; }
done
for f in services/api/db/roles/*.sql; do
  $PSQL -v ON_ERROR_STOP=1 -d assert_probe -f "$f" || { echo "ROLE FAILED: $f"; break; }
done

# 2) 运行时 LOGIN（口令从环境注入，不进 argv、不打印）
export GENGYUN_API_RUNTIME_PASSWORD=$(openssl rand -hex 24)
$PSQL -v ON_ERROR_STOP=1 -d assert_probe -f sql/20-login-roles.sql; echo "login_roles_exit=$?"

# 3) 15 项断言：期望最后一行是 ok
$PSQL -v ON_ERROR_STOP=1 -tA -d assert_probe -f sql/90-assert-least-privilege.sql | tail -n1
#    预期输出顺序：可能先出现一行“警告：未找到 public.schema_migrations 台账…”（属预期），
#    随后是判定结果 —— 最后一行应为 ok
```

**判读**：最后一行 `ok` ⇒ 15 项断言全部通过（与有没有台账无关）。
若出现 `FAIL: <标签> (<说明>)` ⇒ 按标签定位；若卡在硬前置 ⇒ 那是真的缺关系/缺角色。

> 若复核者还想要"台账存在时的完整判据"（`verify-cvm-postgres.sh` 的 `migrations_applied`、
> `restore-drill.sh` 的 `migration_versions`），那属于**目标 CVM 侧**的证据：
> 在 CVM 上用 `DATABASE_URL=… node services/api/src/db/migrate.ts up` 应用迁移即会生成台账。
> 本文件**不提供**"手工伪造台账"的做法——那会把不属于 `migrate.ts` 的写入带进库，
> 与"台账由权威运行器维护"的语义冲突。

## 2 等价备份（复现 `backup-postgres.sh` 的核心动作）

脚本在 CVM 上做的是：`pg_dump -Fc` → `pg_restore --list` 可读性校验 → 写清单（sha256／迁移版本／
关键表行数）→ 保留期清理。在套接字环境里手工复现**前四步**：

```bash
STAMP=$(date -u '+%Y%m%dT%H%M%SZ')
DUMP="/tmp/${DB}-${STAMP}.dump"
MAN="/tmp/${DB}-${STAMP}.manifest.txt"

# 1) 逻辑备份（-Fc 自定义格式；与脚本同参数）
$PG_DUMP -U gengyun_cvm_owner -d "$DB" -Fc -Z 6 --lock-wait-timeout=60s -f "$DUMP"
echo "pg_dump_exit=$?"

# 2) 可读性校验（脚本的“不可用即失败”判据）
$PG_RESTORE --list "$DUMP" > /tmp/toc.txt 2>/tmp/toc.err; echo "pg_restore_list_exit=$?"
grep -c ';' /tmp/toc.txt        # TOC 条目数，应 > 0

# 3) 清单（与 backup-postgres.sh 同字段；按需增删关键表）
{
  printf 'format=pg_dump-custom-v1\n'
  printf 'backup_utc=%s\n'      "$STAMP"
  printf 'database=%s\n'        "$DB"
  printf 'server_version=%s\n'  "$($PSQL -U gengyun_cvm_owner -d "$DB" -tAc 'SHOW server_version')"
  printf 'pg_dump_version=%s\n' "$($PG_DUMP --version | awk '{print $NF}')"
  printf 'dump_bytes=%s\n'      "$(stat -c '%s' "$DUMP" 2>/dev/null || wc -c < "$DUMP")"
  printf 'dump_sha256=%s\n'     "$(sha256sum "$DUMP" | awk '{print $1}')"
  printf 'migration_versions=%s\n' "$($PSQL -U gengyun_cvm_owner -d "$DB" -tAc \
        "SELECT CASE WHEN to_regclass('public.schema_migrations') IS NULL THEN 'schema_migrations-missing' ELSE COALESCE((SELECT string_agg(version, ',' ORDER BY version) FROM schema_migrations), '') END")"
  printf 'base_table_count=%s\n' "$($PSQL -U gengyun_cvm_owner -d "$DB" -tAc \
        "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type='BASE TABLE'")"
  printf 'view_count=%s\n' "$($PSQL -U gengyun_cvm_owner -d "$DB" -tAc \
        "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type='VIEW'")"
  for t in public.users public.sessions public.admin_accounts public.admin_sessions \
           public.idempotency_keys public.consent_records public.privacy_epochs \
           public.crops public.regions public.single_profiles public.sources \
           public.source_versions public.knowledge_versions catalog_ops.operations \
           staging_intake.batches staging_intake.operations \
           knowledge_staging.workbook_batches knowledge_staging.workbook_rows; do
    printf 'rows:%s=%s\n' "$t" "$($PSQL -U gengyun_cvm_owner -d "$DB" -tAc \
      "SELECT CASE WHEN to_regclass('$t') IS NULL THEN 'MISSING' ELSE (SELECT count(*)::text FROM $t) END")"
  done
} > "$MAN"
cat "$MAN"
```

**保留期清理**（脚本的最后一环）在等价环境里**建议跳过**：你的 dump 在 `/tmp`，
由你自行删除即可；不要在没有把握的目录上跑批量 `rm`。

## 3 等价恢复演练（复现 `restore-drill.sh` 的判定口径）

```bash
TARGET=gengyun_restore_drill
DUMP=<上一步的 dump 路径>
MAN="${DUMP}.manifest.txt"      # 或你实际写的清单路径

# 1) 目标库：只在演练命名空间内重建（脚本同样只允许名字含 drill/restore 的库）
$DROPDB -U gengyun_cvm_owner --if-exists "$TARGET"
$CREATEDB -U gengyun_cvm_owner -O gengyun_cvm_owner -E UTF8 "$TARGET"

# 2) 真正恢复（脚本用 --exit-on-error）
$PG_RESTORE -U gengyun_cvm_owner -d "$TARGET" --exit-on-error "$DUMP"; echo "restore_exit=$?"

# 3) 逐项比对（与 restore-drill.sh 的 5 类判据同口径）
echo "--- dump sha256"
grep '^dump_sha256=' "$MAN"; sha256sum "$DUMP" | awk '{print "actual="$1}'
echo "--- migration_versions"
grep '^migration_versions=' "$MAN"
$PSQL -U gengyun_cvm_owner -d "$TARGET" -tAc \
  "SELECT CASE WHEN to_regclass('public.schema_migrations') IS NULL THEN 'schema_migrations-missing' ELSE COALESCE((SELECT string_agg(version, ',' ORDER BY version) FROM schema_migrations), '') END"
echo "--- base_table_count / view_count"
grep -E '^(base_table_count|view_count)=' "$MAN"
$PSQL -U gengyun_cvm_owner -d "$TARGET" -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type='BASE TABLE'"
$PSQL -U gengyun_cvm_owner -d "$TARGET" -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type='VIEW'"
echo "--- 逐表行数"
grep '^rows:' "$MAN" | while IFS='=' read -r k exp; do
  t=${k#rows:}
  act=$($PSQL -U gengyun_cvm_owner -d "$TARGET" -tAc \
        "SELECT CASE WHEN to_regclass('$t') IS NULL THEN 'MISSING' ELSE (SELECT count(*)::text FROM $t) END")
  [ "$exp" = "$act" ] && s=PASS || s=FAIL
  printf '%s %-42s 期望=%s 实际=%s\n' "$s" "$t" "$exp" "$act"
done

# 4) 清理（脚本默认删除目标库）
$DROPDB -U gengyun_cvm_owner --if-exists "$TARGET"
```

### 判读（与 [verify-checklist.md](verify-checklist.md) 一致）

| 判据 | 通过条件 | 你的环境（无 `migrate.ts` 台账）下的预期 |
| --- | --- | --- |
| dump sha256 | 与清单一致 | 应 PASS |
| `pg_restore --exit-on-error` | 退出码 0 **且输出无 `ERROR:` 行** | 应 PASS（restore 不需要台账） |
| 迁移版本一致 | 清单与目标一致 | **两侧都会是 `schema_migrations-missing` ⇒ 判为一致/不适用**；这不是数据损坏，而是**环境缺少权威运行器写入的台账** |
| 基本表/视图数量 | 与清单一致 | 应 PASS |
| 逐表行数 | 与清单一致 | 应 PASS（`MISSING` 也要一致） |

### 若 `pg_restore` 非 0：**先把 error 文本取出来再判**（不要只看退出码）

```bash
# 关键：不要吞掉 stderr。用日志文件，两个流都进去。
pg_restore -U gengyun_cvm_owner -d "$TARGET" --exit-on-error "$DUMP" >/tmp/restore.log 2>&1
echo "restore_exit=$?"
echo "--- 致命（ERROR）行数"; grep -cE '^(pg_restore: error:|ERROR:)' /tmp/restore.log
echo "--- 非致命（WARNING/NOTICE）行数"; grep -cE '^(pg_restore: )?(WARNING|NOTICE):' /tmp/restore.log
echo "--- 前几条致命错误"; grep -nE '^(pg_restore: error:|ERROR:)' /tmp/restore.log | head -5
```

| 输出特征 | 是否致命 | 归因与处置 |
| --- | --- | --- |
| `WARNING:` / `NOTICE:` / `pg_restore: warning\|notice:` | **非致命** | 不会让 `--exit-on-error` 变非 0；只计数、保留日志，不影响判据 |
| `already exists`（`relation "…" already exists` / `schema "…" already exists` 等） | **致命，但归因于目标库** | **目标库不是空的**：恢复前必须 `dropdb`/`createdb`（脚本用 `--recreate` 自己做）。**这不是 dump 的问题** |
| `role "…" does not exist` 或其它 `does not exist` | **致命，但归因于前置** | 目标集群**未完成角色引导**：先跑 `provision-db.sh`。**本 dump 是库级 `pg_dump -d`，不含角色定义** |
| 其它 `pg_restore: error:` / `ERROR:` | **致命** | 真实失败，必须人工定位（含 dump 损坏、磁盘满、版本不兼容等） |

> ⚠️ **一条容易误判的事实**：库级 `pg_dump -d` 的 dump **不创建角色**，所以
> **不可能**出现"角色已存在"这类错误；与角色相关的错误只可能是"角色不存在"。
> 因此"exit≠0 但 schema/行数看起来完全一致"最常见的原因是 **恢复进了非空库**
> （第一次演练留下的对象还在），而不是 dump 有问题、也不是"非致命噪声"。
> **判定必须看 error 文本**：`already exists` ⇒ 清库重来；`does not exist` ⇒ 补前置；
> 其它 ⇒ 真失败。

> **结论口径**：在"只有套接字、无 `migrate.ts`"的环境里，恢复演练能证明的是
> "**该 dump 可在同主版本 PG 上完整重建 schema+数据+授权，且表/视图数量与逐表行数一致**"；
> **不能**证明"迁移台账版本一致"——那一条需要在目标 CVM 上（用 `migrate.ts up` 生成台账）才有意义。
> 报告时请按此口径分别标注，**不要**把 `schema_migrations-missing` 当成本目录脚本的缺陷。
>
> 另外：**"看起来一致"不能替代"恢复过程无错误"**。若 `pg_restore` 非 0 且原因未定位，
> 该次演练必须记为**未通过 / 待复核**（哪怕事后查询的计数与清单相同），
> 因为对象可能是上一次演练残留的，而非本次恢复出来的。

## 4 这套等价命令**不能**证明什么（避免跨层推断）

- 不能证明 `install-postgres.sh` 的安装/initdb/持久盘/`listen_addresses`/`ss` 自检在 CVM 上可用。
- 不能证明 `pg_hba` / `pg_ident` / 安全组三者一致（本环境没有这些配置面）。
- 不能证明"公网 5432 已关闭"。
- 不能证明 `provision-db.sh` 的 `runuser` 环境变量透传探测与 sudo/systemd 路径。
- 台账相关的判据（`migrations_applied`、`migration_versions`）在无 `migrate.ts` 的环境里
  **不适用**，而不是"通过"。
