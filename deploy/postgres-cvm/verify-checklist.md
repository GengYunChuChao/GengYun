# 验证清单：资源就绪后逐条执行、留原始输出

> 状态：技术准备物。**下列任何一条都没有被执行过**（本机无 PostgreSQL/云凭据）。
> 本页是"资源就绪后照着跑、按期望判读"的清单，不是验证结果。
>
> 关联：`Refs #27`（GY-I25）。目标形态见 [README.md](README.md)，角色/迁移见
> [roles-and-migration.md](roles-and-migration.md)，运维步骤见 [runbook.md](runbook.md)。

## 0 资源就绪后的第一条命令

> ⛔ **结构性前提（风险适用）**：微信云托管环境 `prod-d1g6qe87c4f2d7061` 属**子账号 S**，
> `gengyun-vpc`(`vpc-h33f1h5a`, `10.20.0.0/16`) 属**父账号 P**，**S ≠ P**
> ⇒ 把 PG 建在**父账号 P** 的该 VPC 里，**结构上很可能连不通**（非调参问题）。
> **用户已选定路径 A**：在子账号 S 内新建 **VPC（**CIDR 已定 `10.21.0.0/16`**，与父账号 `10.20.0.0/16` 不重叠）
> + 子网 + **标准 CVM** + PG**；路径 B（父账号 P 的 VPC + 跨账号互通）**未采用、保留为历史**。
> 详见 [README.md](README.md) §0.3／§0.4；**网段变更已按 §0.5 完成**（`10.20.0.0/16` → `10.21.0.0/16`）。
> ⚠️ **服务器必须是标准 CVM**：官方明确 **Lighthouse 不支持自定义 VPC** ⇒ 它不在目标 VPC 内、
> 云托管"私有网络"绑不到它（[README.md](README.md) §2.5）。
>
> ⛔ **两道门禁仍然有效**：
> ① **授权门禁**：未取得用户对具体动作的明确授权前，**不创建 CVM／不建库／不购买资源包／不改 VPC**；
>    并注意**不要**在父账号 P 里"为子账号 S 的环境"新建 VPC，也**不要**改动父账号 P 的 `gengyun-vpc`。
> ② **资源就绪门禁**：父账号 P 只读实测 `cvm DescribeInstances @ap-shanghai` = **0 台**、
>    `DescribeSecurityGroups` = **0 个**，云硬盘未核实，**子账号 S 我们无视角**。
>    仍待用户：在**子账号 S** 内建 VPC(`10.21.0.0/16`)/**两个子网**（`10.21.0.0/24 @ap-shanghai-1`、
>    `10.21.1.0/24 @ap-shanghai-2`）/**标准 CVM** → 挂载云硬盘 →
>    配置**入站规则**（标准 CVM=安全组；Lighthouse=实例防火墙；`5432` 仅 `10.21.0.0/16`）→
>    私密交接两个 48 位十六进制口令 → 提供子账号 S 的只读凭据（或代为操作并给出结果）。
> **两个子网对本页判据无影响**：来源规则与 `pg_hba` 都按 **VPC 网段 `10.21.0.0/16`**，
> 天然覆盖两个子网（[README.md](README.md) §2.6）。
> 这些做完后本页与 `backup`／`restore-drill` 才具备执行条件。

```bash
sudo deploy/postgres-cvm/install-postgres.sh --plan
```

理由：它**零改动**，却能在动手前一次性暴露最可能的前置缺口——发行版不是 apt 系、
CVM 没进目标网段、没有独立云硬盘、口令没交接、仓库里没有 17.11 包。
计划里的每一项都应为"已解析/已找到"；出现任何 `[ERROR]` 就先解决，不要直接执行真安装。
**特别地**：若报"在 VPC 网段 `10.21.0.0/16` 内找到 0 个私网 IPv4"，说明**该机器不在方案 A 的目标网段内**
（或用了错误子网）——这是**正确的失败**、**不是通过**；预期输出与判读见 [runbook.md](runbook.md) §0。

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

> 📌 **本项目的实测状态（2026-10-13）**：那次运行里的 `SKIP remote_vpc_tcp_open` **已由平台侧实测满足**
> （**云托管实例 → `10.21.1.8:5432`** 连通 + `scram-sha-256` 认证通过；原始输出见
> [evidence §15](evidence/local-self-check.md)）⇒ **上表退出码语义不变**；若要 `verify` 自己打出 `PASS`／退出码 `0`，
> 用 `--remote-host <同 VPC 探针机>` 复跑即可。
> **两层口径**：**事实层面**已部署且平台侧连通已实测；**验收层面仍未验收**（监工尚未复核）。

同时输出分两段：`===== 验证判据 =====`（机器可核对）与
`===== 仅用户可核对/提供 =====`（脚本无凭据，只能由人做）。

## 2 连通性

| 判据标签 | 实际命令 | 期望输出 | 判读（怎么算失败） |
| --- | --- | --- | --- |
| `socket_reachable` | `sudo -u postgres /usr/lib/postgresql/17/bin/pg_isready -h /var/run/postgresql` | `期望=yes 实际=yes` | `no` ⇒ 服务没起或 socket 目录不对；先 `systemctl status gengyun-postgresql.service` |
| `loopback_tcp_open` | `timeout 5 bash -c 'exec 3<>/dev/tcp/127.0.0.1/5432'` | `期望=yes 实际=yes` | `no` ⇒ `listen_addresses` 没含回环，或服务未起 |
| `vpc_tcp_open(<CVM私网IP>)` | 同上但用 CVM 的私网 IP（脚本按**脚本内配置的网段**自动找） | `期望=yes 实际=yes` | `no` ⇒ `listen_addresses` 漏了私网 IP；**注意**：本机 `nc` 通**不代表**目标网段内另一台机能通（安全组在中间）；**路径 A 若仍显示旧网段 → 四处同改没做完** |
| `remote_vpc_tcp_open(<ip>)` | 需 `--remote-host` | `期望=yes 实际=yes` | `SKIP` ⇒ 未提供探针机；这是**证据缺口**，不是通过。**本项目该项已于 2026-10-13 由平台侧实测满足**（云托管实例 → `10.21.1.8:5432`；原始输出见 [evidence §15](evidence/local-self-check.md)）——**但脚本的 `SKIP` 语义不变**，有探针机时仍应复跑取 `PASS` |

补充人工探针（从**目标网段内**的另一台机执行，原始输出留档；`<CVM私网IP>` 按所选路径替换）：

```bash
# 有 nc：期望 "succeeded"
nc -vz -w 5 <CVM私网IP> 5432
# 无 nc：期望 current_user 为 gengyun_api_runtime
PGPASSWORD=<私密口令> /usr/lib/postgresql/17/bin/psql \
  -h <CVM私网IP> -p 5432 -U gengyun_api_runtime -d gengyun -c 'SELECT current_user'
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
| `server_version` | `SELECT substring(current_setting('server_version') from '^[0-9]+\.[0-9]+')`（**只取主.次**；`SHOW server_version` 会带发行版后缀，如 `17.11 (Ubuntu 17.11-1.pgdg22.04+2)`，**不能整串等值比较** —— 返修 11） | `17.11` | 主版本不是 17 ⇒ 与 CI 不一致，停下；minor 不是 11 ⇒ 与固定标签不一致，记录并按需确认 |
| `listen_addresses` | `SHOW listen_addresses` | `127.0.0.1,10.21.x.y`（方案 A 目标网段；**必须是 `10.21.` 开头**） | 出现 `*` / `0.0.0.0` ⇒ **FAIL，等于对外监听**；若是别的网段 ⇒ 该机器不在目标 VPC 的子网里，**不要继续** |
| `port` | `SHOW port` | `5432`（或显式配置的端口） | 与**入站规则**、`DATABASE_URL` 三者必须一致 |
| `no_wildcard_listener` | `ss -ltn "sport = :5432"` | `期望=0 实际=0` | 非 0 说明内核层面在通配地址监听：配置没生效或被覆盖 |

## 4 pg_hba 与身份映射

| 判据标签 | 命令 | 期望 | 判读 |
| --- | --- | --- | --- |
| `hba_file` | `SHOW hba_file` | `/data/gengyun/pgdata/pg_hba.conf` | 指向发行版默认路径 ⇒ 用的是别人的集群 |
| `hba_parse_errors` | `SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL` | `0` | 非 0 ⇒ 该行被忽略（可能整段拒绝或放开），必须修并 `pg_reload_conf()` |
| `hba_no_default_route` | `… WHERE netmask='0.0.0.0' OR address IN ('0.0.0.0','::')` | `0` | 非 0 ⇒ 存在"任何来源"规则，等于公网可尝试认证 |
| `hba_vpc_rules` | `… WHERE address='10.21.0.0' AND netmask='255.255.0.0'`（脚本内常量；**网段再变时此处必须同改**，见 [README.md](README.md) §0.5 第 3 行） | `>=2` | 0 ⇒ 目标网段内也连不上（或**判据还在看旧网段**）；1 ⇒ 少了运行时或迁移管理员的授权行 |
| `ident_file` | `SHOW ident_file` | `/data/gengyun/pgdata/pg_ident.conf` | 指向别处 ⇒ 本机免口令运维会失败 |
| `ident_map_rows` | `SELECT count(*) FROM pg_ident_file_mappings` | `1` | 应为唯一一条 `postgres → gengyun_cvm_owner`；多于 1 条要人工过一遍是否放开了别的系统用户 |
| `postgres_can_traverse(<路径>)` | `sudo -u postgres test -x <路径>`（脚本对**父级**与**叶子**各判一次） | `期望=yes 实际=yes` | `no` ⇒ `postgres` 无法穿越该级目录 ⇒ **下次 initdb 会以 `Permission denied` 失败**；用 `namei -l <路径>` 看逐级权限，要求 **0750 且属组 postgres**（返修 9 · 缺陷 3）；`missing` ⇒ 该路径不存在（装包步骤没跑或被人删了） |

## 5 角色与最小权限（含正例与反例）

| 判据标签 | 命令 | 期望 | 判读 |
| --- | --- | --- | --- |
| `runtime_role_attrs` | `SELECT rolcanlogin\|\|'\|\|'… FROM pg_roles WHERE rolname='gengyun_api_runtime'` | `t\|t\|f\|f\|f\|f\|f` | 任一 `t` 落在 super/createdb/createrole/replication/bypassrls ⇒ **P1 越权**，立即排查 |
| `runtime_password_scram` | `SELECT rolpassword LIKE 'SCRAM-SHA-256$%' FROM pg_authid …` | `t` | `f` ⇒ 用了 md5 或没口令，重设 |
| `runtime_group_count` | `SELECT count(*) FROM pg_roles WHERE pg_has_role('gengyun_api_runtime', oid,'MEMBER') AND rolname<>…` | `5` | `<5` ⇒ 某些功能会 42501；`>5` ⇒ **多授权**，对照第 3.3 节 |
| `runtime_not_owner_member` | `SELECT pg_has_role('gengyun_api_runtime','gengyun_cvm_owner','MEMBER')` | `f` | `t` ⇒ **P0：运行时拿到超级用户**，立即 `REVOKE` 并排查 |
| `nologin_groups_present` | 统计 5 个组的 `NOT rolcanlogin` 个数 | `5` | 少于 5 ⇒ 组没建或被人改成可登录 |
| `least_privilege_assert` | 跑 [sql/90-assert-least-privilege.sql](sql/90-assert-least-privilege.sql) | `ok` | `FAIL: <标签> (<说明>)` ⇒ 按标签定位；脚本**只报不改**。该文件前置分**硬/软**两级：7 个业务关系 + 运行时角色 + 5 组缺失 ⇒ 立即失败并给三步指引；`schema_migrations` 台账缺失 ⇒ **只告警**（15 项断言不依赖它，故可在"用 `psql -f` 应用迁移"的等价环境里复核，见 [verify-socket-only-equivalents.md](verify-socket-only-equivalents.md)） |
| `runtime_can_read_home_species` | `SET ROLE gengyun_api_runtime; SELECT count(*) FROM catalog_read.home_species` | 非负整数 | 报 42501 ⇒ `gengyun_preview_reader` 没授上 |
| `runtime_can_read_current_knowledge` | 同上，`catalog_read.current_knowledge` | 非负整数 | 报 42501 ⇒ `gengyun_knowledge_runtime` 没授上，或 0010 未应用 |
| `runtime_denied_select_star_users` | `SET ROLE …; SELECT * FROM public.users` | `42501` | **成功返回即 P1**：按列授权被放宽成整表读 |
| `runtime_denied_insert_users` | `SET ROLE …; INSERT INTO public.users (id) VALUES (gen_random_uuid())` | `42501` | 成功 ⇒ 运行时能造用户，P1 |
| `runtime_denied_update_users_state` | `SET ROLE …; UPDATE public.users SET state='active'` | `42501` | 成功 ⇒ 能改账号状态/绕过注销，P0 级语义 |
| `runtime_denied_create_table` | `SET ROLE …; CREATE TABLE public.verify_should_fail (x int)` | `42501` | 成功 ⇒ 运行时可建对象，P1 |
| `runtime_tcp_login` | 需 `--runtime-password-env` | `<用户名为 gengyun_api_runtime>` | `SKIP`/失败 ⇒ 要么没给口令，要么 scram/`pg_hba`/安全组有问题 |

> **布尔值的表示口径（返修 11 的教训）**：`psql -tA` 对**布尔列**输出 **`t`/`f`**，
> 但 `bool::text`（以及 `\|\|` 拼接布尔列）输出 **`true`/`false`**。
> ⇒ 判据的**期望字面量必须与查询的实际表示一致**：本目录统一用 **`t`/`f`**，
> 因此查询里一律用 `CASE WHEN … THEN 't' ELSE 'f' END`（脚本内 `_tf()` 辅助函数），**不要**用 `::text`。
> 真机曾因此 3 条判据误报 FAIL（`t|t|f…` vs `true|true|false…`），配置本身并无问题。

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
| `migrations_applied` | 比对 `SELECT string_agg(version,',' ORDER BY version) FROM schema_migrations` 与 `services/api/db/migrations/*.sql` | 两者完全一致（逐版本比对；清单以磁盘实测为准，**不以号段判齐**） | 不一致 ⇒ 迁移没跑完或跑了不同 HEAD；**角色引导的前提不成立** |
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
| 恢复演练（不在 verify 内） | `restore-drill.sh --dump <最新dump>` | 退出码 `0` 且 `FAIL=0`（**判定看"恢复过程是否报错"，不能只看事后计数**） | 退出码 `1` ⇒ 恢复过程报错，**必须先把 error 文本取出来分类**：`already exists` ⇒ 目标库不是空的（先 dropdb/createdb，**不是 dump 的问题**）；`does not exist` ⇒ 未做角色引导；其它 ⇒ 真失败。非致命项只有 `WARNING:`/`NOTICE:`。退出码 `2` ⇒ 证据不完整。**没有演练、或原因未定位，都不得声称可恢复**；判读表见 `restore-drill.sh` 文件头与 [verify-socket-only-equivalents.md](verify-socket-only-equivalents.md) |
| `pgdata_present` | `test -f /data/gengyun/pgdata/PG_VERSION` | `yes` | `no` ⇒ 数据目录不对 |
| `pgdata_version` | `cat /data/gengyun/pgdata/PG_VERSION` | `17` | 非 17 ⇒ 换过主版本 |
| `pgdata_separate_filesystem` | `df -P -- /data/gengyun/pgdata` | 挂载点非 `/`（是云硬盘设备） | `/` ⇒ **不满足持久存储要求**，该部署不能按"持久"验收 |

持久性（重启）判定必须单独留证据，照 [README.md](README.md) 第 3 节执行，
比较重启前后的 `df` 设备名、`PG_VERSION`、`base/` 是否存在与 `pg_postmaster_start_time()`。

## 9 仅用户可核对/提供（脚本无凭据，必须人工）

| 项 | 在哪核对 | 期望状态 | 不满足的后果 |
| --- | --- | --- | --- |
| **账号边界** | 用户账户信息（**已由用户提供**） | 云托管环境属**子账号 S**、`gengyun-vpc` 属**父账号 P**，**S ≠ P**（标识值留私密留档，不写入仓库） | 边界 ⇒ "把 PG 建在父账号 P 的 VPC 里很可能连不通"（[README.md](README.md) §0.3） |
| **路径选择（A/B）** | 用户决策 | 已明确；路径 A 已定新 CIDR；跨账号互通（路径 B）已确认是否有官方依据 | 未定路径 ⇒ 资源不知道建在哪个账号，**不得开工** |
| **子账号 S 视角** | 用户提供只读凭据，或由用户在子账号 S 控制台操作 | 我们能核对子账号 S 名下的 VPC/子网/CVM/入站规则 | 无视角 ⇒ 子账号内的配置**无法核对、无法验证** |
| **服务器形态** | 用户控制台/工单 | 承载 PG 的是**标准 CVM**并加入 `10.21.0.0/16` 的 VPC/子网 | 若是 **Lighthouse**：官方明确**不支持自定义 VPC** ⇒ 它不在目标 VPC 内、云托管绑不到它（[README.md](README.md) §2.5）⇒ 方案 A 不成立 |
| **入站规则** `5432` | 对应账号的控制台（标准 CVM → **安全组**；Lighthouse → **实例防火墙**） | 来源仅 `10.21.0.0/16`；**无 `0.0.0.0/0`**（父账号 P 当前实测：安全组 **0 个**）。⚠️ Lighthouse 防火墙**来源默认 `0.0.0.0/0`** | 公网可尝试连库 ⇒ P0 风险 |
| CVM 所属 VPC/地域 | 对应账号的控制台 → 实例详情 | 路径 A：子账号 S 内新建 VPC；路径 B：父账号 P 的 `gengyun-vpc`(`vpc-h33f1h5a`)；地域均 `ap-shanghai`（父账号 P 当前实测：CVM **0 台**） | 与"与环境同账号"不符 ⇒ 验收前提不成立 |
| 云硬盘挂载与快照策略 | 控制台 → 云硬盘 | 数据目录所在盘为独立云硬盘，有快照/续费策略 | 实例重建即丢库 |
| 运行时口令交接 | 私密通道 | API 只拿到最小权限连接串 | 若给了 owner 口令，等于把超级用户给了应用 |
| 恢复演练原始输出 | 由运维提供 | `restore-drill.sh` 完整输出 | 无法证明备份可用 |
| API 侧业务冒烟 | 由运维提供 | 健康检查 `checks.database.status=ok` + 至少一条真实业务读 | 只证明"库通了"，不证明"业务通了" |

## 10 本清单明确**不**覆盖（不要据此推断为通过）

1. **公网暴露的最终判定**：脚本只能证明进程未监听通配地址；**入站规则**（安全组／Lighthouse 防火墙）必须人工核对 + 公网反面探针。
2. **TLS**：本阶段 `ssl = off`，VPC 内明文传输（见 [README.md](README.md) 第 6 节第 1 条）。
3. **PITR / RPO / RTO 指标**：无 WAL 归档，不测。
4. **全库灾备恢复到全新集群**：未演练（角色与口令不在 dump 里）。
5. **"注销后在线 7 日／备份 30 日内清理个人数据"**：逐用户删除语义，未实现、未验收。
6. **并发/压力/长事务**：未做；`max_connections=100`、`statement_timeout` 来自应用侧 `pool.ts` 的既有设定。
7. **与 CloudBase/云托管侧的真实联调**：需要真实环境与部署，属另一单范围。
8. **CI 门禁**：CI 的 `postgres:17.11` 是隔离容器，只证明迁移/组件在 PG17.11 上可运行，
   **不等于**目标 CVM 已就绪（两者不可互相替换）。
