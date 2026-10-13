# 验证清单：资源就绪后逐条执行、留原始输出

> 状态：技术准备物。**下列任何一条都没有被执行过**（本机无 PostgreSQL/云凭据）。
> 本页是"资源就绪后照着跑、按期望判读"的清单，不是验证结果。
>
> 关联：`Refs #27`（GY-I25）。目标形态见 [README.md](README.md)，角色/迁移见
> [roles-and-migration.md](roles-and-migration.md)，运维步骤见 [runbook.md](runbook.md)。

## 0 资源就绪后的第一条命令

> ⛔ **先过门禁**：只读实测当前 `cvm DescribeInstances @ap-shanghai` = **0 台**、
> `DescribeSecurityGroups` = **0 个**，且"微信云托管环境绑定的腾讯云账号是否就是本凭据账号"
> **尚未定论**。**在账号归属比对完成前，不要创建 CVM、不要建库、不要购买资源包、不要改 VPC**
> （理由与两条备选路径见 [README.md](README.md) 第 0 节）。
> 因此本页在门禁解除前**不可执行**。

```bash
sudo deploy/postgres-cvm/install-postgres.sh --plan
```

理由：它**零改动**，却能在动手前一次性暴露最可能的前置缺口——发行版不是 apt 系、
CVM 没进 VPC、没有独立云硬盘、口令没交接、仓库里没有 17.11 包。
计划里的每一项都应为"已解析/已找到"；出现任何 `[ERROR]` 就先解决，不要直接执行真安装。

## 1 一键跑完全部可执行判据

```bash
sudo deploy/postgres-cvm/verify-cvm-postgres.sh \
  --remote-host <同VPC另一台机> \
  --runtime-password-env GENGYUN_API_RUNTIME_PASSWORD \
  | tee /tmp/verify-cvm-$(date -u +%Y%m%dT%H%M%SZ).log
echo "exit=$?"
```

退出码语义（**必须按这个判读，不能只看有没有红字**）：

| 退出码 | 含义 | 能否作为验收证据 |
| --- | --- | --- |
| `0` | 全部可执行判据 PASS，且无 SKIP | 可进入独立复核；仍需完成第 9 节的用户项 |
| `1` | 至少一条 FAIL | **不是**已就绪；修好重跑 |
| `2` | 无 FAIL，但有 SKIP（缺口令/备份/远端探针） | **证据不完整**；补齐后重跑，不得当通过 |

同时输出分两段：`===== 验证判据 =====`（机器可核对）与
`===== 仅用户可核对/提供 =====`（脚本无凭据，只能由人做）。

## 2 连通性

| 判据标签 | 实际命令 | 期望输出 | 判读（怎么算失败） |
| --- | --- | --- | --- |
| `socket_reachable` | `sudo -u postgres /usr/lib/postgresql/17/bin/pg_isready -h /var/run/postgresql` | `期望=yes 实际=yes` | `no` ⇒ 服务没起或 socket 目录不对；先 `systemctl status gengyun-postgresql.service` |
| `loopback_tcp_open` | `timeout 5 bash -c 'exec 3<>/dev/tcp/127.0.0.1/5432'` | `期望=yes 实际=yes` | `no` ⇒ `listen_addresses` 没含回环，或服务未起 |
| `vpc_tcp_open(10.20.x.y)` | 同上但用私网 IP | `期望=yes 实际=yes` | `no` ⇒ `listen_addresses` 漏了私网 IP；**注意**：本机 `nc` 通不代表同 VPC 另一台机能通（安全组在中间） |
| `remote_vpc_tcp_open(<ip>)` | 需 `--remote-host` | `期望=yes 实际=yes` | `SKIP` ⇒ 未提供探针机；这是**证据缺口**，不是通过 |

补充人工探针（从同 VPC 的另一台机执行，原始输出留档）：

```bash
# 有 nc：期望 "succeeded"
nc -vz -w 5 10.20.x.y 5432
# 无 nc：期望 current_user 为 gengyun_api_runtime
PGPASSWORD=<私密口令> /usr/lib/postgresql/17/bin/psql \
  -h 10.20.x.y -p 5432 -U gengyun_api_runtime -d gengyun -c 'SELECT current_user'
```

**反面也是证据**：从**公网**（例如你自己的开发机/手机热点）尝试连 `CVM公网IP:5432`

```bash
nc -vz -w 5 <CVM公网IP> 5432      # 期望：超时/拒绝，绝不 succeeded
```

若这里 `succeeded` ⇒ **P0：公网 5432 已开放**，立即由用户收紧安全组，
并暂时停库（`systemctl stop gengyun-postgresql.service`）直到安全组修好。

## 3 版本与监听面

| 判据标签 | 命令 | 期望 | 判读 |
| --- | --- | --- | --- |
| `server_version` | `SHOW server_version` | `17.11` | 主版本不是 17 ⇒ 与 CI 不一致，停下；minor 不是 11 ⇒ 与固定标签不一致，记录并按需确认 |
| `listen_addresses` | `SHOW listen_addresses` | `127.0.0.1,10.20.x.y` | 出现 `*` / `0.0.0.0` ⇒ **FAIL，等于对外监听** |
| `port` | `SHOW port` | `5432`（或显式配置的端口） | 与安全组规则、`DATABASE_URL` 三者必须一致 |
| `no_wildcard_listener` | `ss -ltn "sport = :5432"` | `期望=0 实际=0` | 非 0 说明内核层面在通配地址监听：配置没生效或被覆盖 |

## 4 pg_hba 与身份映射

| 判据标签 | 命令 | 期望 | 判读 |
| --- | --- | --- | --- |
| `hba_file` | `SHOW hba_file` | `/data/gengyun/pgdata/pg_hba.conf` | 指向发行版默认路径 ⇒ 用的是别人的集群 |
| `hba_parse_errors` | `SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL` | `0` | 非 0 ⇒ 该行被忽略（可能整段拒绝或放开），必须修并 `pg_reload_conf()` |
| `hba_no_default_route` | `… WHERE netmask='0.0.0.0' OR address IN ('0.0.0.0','::')` | `0` | 非 0 ⇒ 存在"任何来源"规则，等于公网可尝试认证 |
| `hba_vpc_rules` | `… WHERE address='10.20.0.0' AND netmask='255.255.0.0'` | `>=2` | 0 ⇒ 同 VPC 也连不上；1 ⇒ 少了运行时或迁移管理员的授权行 |
| `ident_file` | `SHOW ident_file` | `/data/gengyun/pgdata/pg_ident.conf` | 指向别处 ⇒ 本机免口令运维会失败 |
| `ident_map_rows` | `SELECT count(*) FROM pg_ident_file_mappings` | `1` | 应为唯一一条 `postgres → gengyun_cvm_owner`；多于 1 条要人工过一遍是否放开了别的系统用户 |

## 5 角色与最小权限（含正例与反例）

| 判据标签 | 命令 | 期望 | 判读 |
| --- | --- | --- | --- |
| `runtime_role_attrs` | `SELECT rolcanlogin\|\|'\|\|'… FROM pg_roles WHERE rolname='gengyun_api_runtime'` | `t\|t\|f\|f\|f\|f\|f` | 任一 `t` 落在 super/createdb/createrole/replication/bypassrls ⇒ **P1 越权**，立即排查 |
| `runtime_password_scram` | `SELECT rolpassword LIKE 'SCRAM-SHA-256$%' FROM pg_authid …` | `t` | `f` ⇒ 用了 md5 或没口令，重设 |
| `runtime_group_count` | `SELECT count(*) FROM pg_roles WHERE pg_has_role('gengyun_api_runtime', oid,'MEMBER') AND rolname<>…` | `5` | `<5` ⇒ 某些功能会 42501；`>5` ⇒ **多授权**，对照第 3.3 节 |
| `runtime_not_owner_member` | `SELECT pg_has_role('gengyun_api_runtime','gengyun_cvm_owner','MEMBER')` | `f` | `t` ⇒ **P0：运行时拿到超级用户**，立即 `REVOKE` 并排查 |
| `nologin_groups_present` | 统计 5 个组的 `NOT rolcanlogin` 个数 | `5` | 少于 5 ⇒ 组没建或被人改成可登录 |
| `least_privilege_assert` | 跑 [sql/90-assert-least-privilege.sql](sql/90-assert-least-privilege.sql) | `ok` | `FAIL: <标签> (<说明>)` ⇒ 按标签定位；脚本**只报不改** |
| `runtime_can_read_home_species` | `SET ROLE gengyun_api_runtime; SELECT count(*) FROM catalog_read.home_species` | 非负整数 | 报 42501 ⇒ `gengyun_preview_reader` 没授上 |
| `runtime_can_read_current_knowledge` | 同上，`catalog_read.current_knowledge` | 非负整数 | 报 42501 ⇒ `gengyun_knowledge_runtime` 没授上，或 0010 未应用 |
| `runtime_denied_select_star_users` | `SET ROLE …; SELECT * FROM public.users` | `42501` | **成功返回即 P1**：按列授权被放宽成整表读 |
| `runtime_denied_insert_users` | `SET ROLE …; INSERT INTO public.users (id) VALUES (gen_random_uuid())` | `42501` | 成功 ⇒ 运行时能造用户，P1 |
| `runtime_denied_update_users_state` | `SET ROLE …; UPDATE public.users SET state='active'` | `42501` | 成功 ⇒ 能改账号状态/绕过注销，P0 级语义 |
| `runtime_denied_create_table` | `SET ROLE …; CREATE TABLE public.verify_should_fail (x int)` | `42501` | 成功 ⇒ 运行时可建对象，P1 |
| `runtime_tcp_login` | 需 `--runtime-password-env` | `<用户名为 gengyun_api_runtime>` | `SKIP`/失败 ⇒ 要么没给口令，要么 scram/`pg_hba`/安全组有问题 |

人工补充（原始输出留档）：

```sql
-- \du 等价的完整视角
\du
SELECT rolname, rolcanlogin, rolsuper, rolbypassrls FROM pg_roles ORDER BY rolname;
-- 以运行时身份确认真实身份（走 TCP 时）
SELECT current_user, session_user;
SHOW password_encryption;   -- 期望 scram-sha-256
```

## 6 迁移版本

| 判据标签 | 命令 | 期望 | 判读 |
| --- | --- | --- | --- |
| `migrations_applied` | 比对 `SELECT string_agg(version,',' ORDER BY version) FROM schema_migrations` 与 `services/api/db/migrations/*.sql` | 两者完全一致（0001…0010） | 不一致 ⇒ 迁移没跑完或跑了不同 HEAD；**角色引导的前提不成立** |
| `migrations_checksum_not_null` | `SELECT count(*) FROM schema_migrations WHERE checksum IS NULL` | `0` | 非 0 ⇒ 台账被外部手工写入，drift 检测会失效 |

补充：`node services/api/src/db/migrate.ts status` 应输出 `待应用：（无）` 且**不出现** `drift：`。
出现 drift 说明磁盘上的迁移文件与已应用版本不一致 ⇒ 停下报告，不要继续。

## 7 只读业务读（证明读路径真的通）

| 判据标签 | 命令 | 期望 | 判读 |
| --- | --- | --- | --- |
| `readonly_read(public.crops)` | `SELECT count(*) FROM public.crops` | 非负整数 | 报错 ⇒ 迁移或授权缺失。**注意**：0 行是合法的"空"，不等于失败 |
| `readonly_read(public.regions)` | `SELECT count(*) FROM public.regions` | 非负整数 | 同上 |
| `readonly_read(catalog_read.home_species)` | `SELECT count(*) FROM catalog_read.home_species` | 非负整数 | 报错 ⇒ 0005/0010 或读者组缺失 |

**不要把行数当业务验收**：目录/科普数据是否为 0 取决于是否已导入合法资料，
`SELECT` 成功只证明"库通了、权限对了"。

## 8 备份产出与持久存储

| 判据标签 | 命令 | 期望 | 判读 |
| --- | --- | --- | --- |
| `backup_artifact` | `backup-postgres.sh --list` / `find /data/gengyun/backup -name 'gengyun-*.dump'` | 至少 1 份 | `SKIP` ⇒ 还没备份；**此时不得声称"已备份"** |
| `backup_sha256_matches_manifest` | 比较清单 `dump_sha256` 与 `sha256sum <dump>` | 完全一致 | 不一致 ⇒ 备份被截断/改写，**该备份不可用** |
| `backup_freshness_days_ok` | 最新 dump 的 mtime 距今 | `<=1` 天 | 过期 ⇒ 定时任务没生效 |
| 恢复演练（不在 verify 内） | `restore-drill.sh --dump <最新dump>` | 退出码 `0`，`FAIL=0` | 退出码 `1` ⇒ 备份不可恢复；`2` ⇒ 证据不完整。**没有演练就不得声称可恢复** |
| `pgdata_present` | `test -f /data/gengyun/pgdata/PG_VERSION` | `yes` | `no` ⇒ 数据目录不对 |
| `pgdata_version` | `cat /data/gengyun/pgdata/PG_VERSION` | `17` | 非 17 ⇒ 换过主版本 |
| `pgdata_separate_filesystem` | `df -P -- /data/gengyun/pgdata` | 挂载点非 `/`（是云硬盘设备） | `/` ⇒ **不满足持久存储要求**，该部署不能按"持久"验收 |

持久性（重启）判定必须单独留证据，照 [README.md](README.md) 第 3 节执行，
比较重启前后的 `df` 设备名、`PG_VERSION`、`base/` 是否存在与 `pg_postmaster_start_time()`。

## 9 仅用户可核对/提供（脚本无凭据，必须人工）

| 项 | 在哪核对 | 期望状态 | 不满足的后果 |
| --- | --- | --- | --- |
| **账号归属比对** | 控制台读微信云托管环境 `prod-d1g6qe87c4f2d7061` 绑定的腾讯云账号 | 与本凭据账号**一致** | 不一致 ⇒ 本账号上海 VPC 里的 PG 结构上可能连不通；**此门禁之前不得创建任何资源** |
| 安全组入站 `5432` | 腾讯云控制台 → 该 CVM 安全组 | 来源仅 `10.20.0.0/16`；**无 `0.0.0.0/0`**（当前实测：安全组 **0 个**，尚不存在） | 公网可尝试连库 ⇒ P0 风险 |
| CVM 所属 VPC/地域 | 控制台 → 实例详情 | `gengyun-vpc`(`vpc-h33f1h5a`)、`ap-shanghai`（当前实测：CVM **0 台**，尚未创建） | 与"同账号上海该 VPC"不符，验收前提不成立 |
| 云硬盘挂载与快照策略 | 控制台 → 云硬盘 | 数据目录所在盘为独立云硬盘，有快照/续费策略 | 实例重建即丢库 |
| 运行时口令交接 | 私密通道 | API 只拿到最小权限连接串 | 若给了 owner 口令，等于把超级用户给了应用 |
| 恢复演练原始输出 | 由运维提供 | `restore-drill.sh` 完整输出 | 无法证明备份可用 |
| API 侧业务冒烟 | 由运维提供 | 健康检查 `checks.database.status=ok` + 至少一条真实业务读 | 只证明"库通了"，不证明"业务通了" |

## 10 本清单明确**不**覆盖（不要据此推断为通过）

1. **公网暴露的最终判定**：脚本只能证明进程未监听通配地址；安全组必须人工核对 + 公网反面探针。
2. **TLS**：本阶段 `ssl = off`，VPC 内明文传输（见 [README.md](README.md) 第 6 节第 1 条）。
3. **PITR / RPO / RTO 指标**：无 WAL 归档，不测。
4. **全库灾备恢复到全新集群**：未演练（角色与口令不在 dump 里）。
5. **"注销后在线 7 日／备份 30 日内清理个人数据"**：逐用户删除语义，未实现、未验收。
6. **并发/压力/长事务**：未做；`max_connections=100`、`statement_timeout` 来自应用侧 `pool.ts` 的既有设定。
7. **与 CloudBase/云托管侧的真实联调**：需要真实环境与部署，属另一单范围。
8. **CI 门禁**：CI 的 `postgres:17.11` 是隔离容器，只证明迁移/组件在 PG17.11 上可运行，
   **不等于**目标 CVM 已就绪（两者不可互相替换）。
