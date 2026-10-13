# Runbook：目标 CVM 上部署与运维 PostgreSQL 17

> 状态：技术准备物。**未部署、未验收**。本页命令**都没有被执行过**；
> 本机无 PostgreSQL/Docker/云凭据，见 [evidence/local-self-check.md](evidence/local-self-check.md)。
> 本 Runbook 是"资源就绪后照着做"的操作手册，不是"已经做完"的记录。

关联：`Refs #27`（GY-I25）。目标形态见 [README.md](README.md) 第 2 节；角色与迁移见
[roles-and-migration.md](roles-and-migration.md)；判据见 [verify-checklist.md](verify-checklist.md)。

## 0 开始之前

> ### ⛔ 结构性前提：环境属**子账号 S**，VPC 属**父账号 P**，**S ≠ P** ⇒ 风险**适用**
>
> **一手 · 用户提供**（用户本人，经指挥转述）：微信云托管环境 `prod-d1g6qe87c4f2d7061` 绑定的是
> **子账号 S**，且 S 是**父账号 P 的子账号**；`gengyun-vpc`（`vpc-h33f1h5a`，`10.20.0.0/16`）在
> **父账号 P** 名下。账号 ID、凭据指纹等**标识值保留在私密留档**，按凭据同级处理，
> **不写入本仓库／PR／文档／提交信息**。
>
> **⇒ 结构性风险适用**：云托管为服务选择私有网络时，候选网络**只来自该环境所属账号**
> （该机制来自用户／指挥的陈述；**本单未能取得官方依据**）⇒ 把 PostgreSQL 建在**父账号 P** 的
> `gengyun-vpc` 里**结构上很可能连不通**。**这不是参数问题**：安全组、`pg_hba`、`listen_addresses`
> 三者全对也**不会**变通。
>
> **二手 · 另一位写手只读实测**（**本单写手零云调用**，未接触 `E:\GengYunPrivate`）：
> `cvm DescribeInstances @ap-shanghai` = **0 台**、`cvm DescribeSecurityGroups` = **0 个**、
> `tcb DescribeEnvs`（上海/广州）= **0 个环境**。VPC `gengyun-vpc` 在**父账号 P** 的上海地域可见且唯一，
> 子网 1 个 `/24`（`ap-shanghai-1`，可用 IP 253）。**这两份凭据都是父账号 P 的**
> ⇒ 对**子账号 S** 名下的 VPC／CVM／安全组**我们没有视角**。
>
> **官方文档核对结果（本会话可达的两页；检索通道不可用，非穷尽）**：
> [云托管 · 服务设置](https://docs.cloudbase.net/run/deploy/service-setting) 的"网络相关设置"只描述
> **公网／内网域名开关（内网限同环境内服务互访）**，**未记载** VPC／私有网络绑定；
> [云托管 · 使用限制](https://docs.cloudbase.net/run/limitation) 写明"**不同环境的资源之间只能使用公网调用**"，
> 并标注**支持地域：上海**。⇒ 路径 B 需要的**跨账号私有互通／子网共享"未找到依据"**，
> 必须由用户在控制台或工单确认。完整分析见 [README.md](README.md) §0.3。

> ### 目标形态：两条并列路径（选择权在用户，本单不选、不执行）
>
> - **路径 A（推荐）**：在**子账号 S** 内新建 **VPC + 子网**（**CIDR 勿与 `10.20.0.0/16` 重叠**，
>   建议 `10.21.0.0/16`）+ **CVM** + PostgreSQL；云托管环境绑该 VPC ⇒ **同账号直连**，边界清晰。
>   **若换 CIDR ⇒ 必须按 [README.md](README.md) §0.5 把网段四处同改**
>   （`install-postgres.sh` 常量／`conf/pg_hba.gengyun.conf`／`verify-cvm-postgres.sh` 两个常量与判据／各处文档），
>   改完必须复跑 §0.5 第 3 步的检查（旧网段清零 + `bash -n` + `--plan` 能识别新网段）。
>   ⚠️ 那属于**改脚本**，需**单独授权并重新评审**；本单只交付步骤。
> - **路径 B**：仍用**父账号 P** 的 `gengyun-vpc`，但需要**跨账号私有互通**
>   （对等连接／云联网 CCN —— **是否支持该形态：未找到依据**）**且** CloudRun 侧仍需在
>   **子账号 S** 内有可绑定的 VPC／子网。**在拿到官方依据前不要按此路径动手。**
>
> 两条路径的对照见 [README.md](README.md) §0.4。

> ### ⛔ 授权门禁（**与账号条件无关，仍然适用**）
>
> 1. **未取得用户对具体动作的明确授权之前：不要创建 CVM、不要建库、不要购买任何资源包、不要改动 VPC。**
> 2. **本单新增**：**不要在父账号 P 里"为子账号 S 的环境"新建 VPC。**
>    父账号里的新 VPC 仍然不在子账号 S 名下，**解决不了互通问题**，
>    只会多出一份要维护与计费的资源。若走路径 A，VPC **必须建在子账号 S 内**。
> 3. **换绑绝对禁止**：把云托管环境改到父账号 P，官方明确**必须销毁当前所有环境且不可恢复**。
>
> 账号结构本身**不是**"可以动手"的授权；本单授权范围始终只有"交付技术准备物"。

**凭据视角**：仓库现有两份只读凭据都属**父账号 P** ⇒ 对**子账号 S** 名下的资源**没有视角**。
**需用户提供**：**子账号 S 的（只读）凭据**，**或**由用户在**子账号 S** 控制台内完成建网／建 CVM／配安全组
并把结果给出（含所选网段、CVM 私网 IP、安全组规则）。

**仍待用户完成**（做完这几项，本 Runbook 第 3 节才有执行条件；顺序不可颠倒）：
① 选定**路径 A 或 B**；② 在选定账号内（路径 A = **子账号 S**）准备 VPC＋子网＋**CVM**；
③ 创建并挂载云硬盘；④ 配置安全组（5432 仅所选路径的目标网段）；⑤ 私密交接两个 48 位十六进制口令；
⑥ 提供**子账号 S 的只读凭据**（或代为操作的结果）。

当前门禁状态：账号边界 **已明确（S ≠ P ⇒ 风险适用）**；父账号 P 实测 CVM **0 台**、安全组 **0 个**；
**子账号 S 无视角**；云硬盘 **未核实**；口令 **未交接**。
⇒ 本 Runbook 的"部署步骤"目前**在任何环境上都还不可执行**，第 3 节只是资源就绪后照着做的操作手册。

| 检查 | 命令 | 期望 |
| --- | --- | --- |
| **路径已选定** | —（用户决策） | 已明确走 A 还是 B；路径 A 已定新 CIDR |
| **网段四处一致**（仅路径 A 需要） | `grep -rn '10\.20' deploy/postgres-cvm/ \|\| echo 旧网段已清零`；`grep -n "VPC_CIDR=\|VPC_PREFIX=" deploy/postgres-cvm/*.sh` | 旧网段 0 命中；两个脚本的常量都已指向**新**网段（详见 [README.md](README.md) §0.5） |
| 行尾是 LF（**必查**） | `grep -lU $'\r' deploy/postgres-cvm/*.sh` | 无输出（有输出就先 `dos2unix`／`sed -i 's/\r$//'`） |
| 脚本语法 | `for f in deploy/postgres-cvm/*.sh; do bash -n "$f" \|\| echo "FAIL $f"; done` | 无 `FAIL` |
| 拿到基线 | `git rev-parse HEAD` | 记录实际 SHA（部署与 PR 必须同一 SHA） |
| OS 与发行版 | `. /etc/os-release; echo "$ID $VERSION_ID"` | `ubuntu 22.04` / `ubuntu 24.04` / `debian 12`（否则停下来决策，见 [README.md](README.md) 前置 P2） |
| 私网 IP 在目标网段内 | `ip -4 -o addr show scope global` | 路径 B：有一个 `10.20.x.y`；路径 A：有一个**新网段**内的 IP |
| 数据盘已挂载 | `df -P -- /data` | 设备是云硬盘（不是 `/`） |
| 私密文件权限 | `stat -c '%a %U:%G' /etc/gengyun/private/db-credentials.env` | `600 root:postgres` |
| 时间同步 | `timedatectl status` | 已同步（影响备份文件名/审计） |

**先干跑一遍**：`sudo deploy/postgres-cvm/install-postgres.sh --plan`。它会解析版本、检测私网 IP、
判定持久盘、校验口令形状，并打印将要执行的动作，**零改动**。计划不对就不要往下走。
若走路径 A 却仍报"在 VPC 网段 `10.20.0.0/16` 内找到 0 个私网 IPv4"，说明**第 2 步的四处同改没做完**。

## 1 角色分工（谁能做哪一步）

| 步骤 | 执行者 | 需要的权限 |
| --- | --- | --- |
| **账号边界确认与路径选择**（边界已明确 S ≠ P；**路径待选**） | **用户本人** | 腾讯云账号控制台 / 账户信息 |
| **提供子账号 S 的（只读）凭据，或在子账号 S 控制台内代为操作** | **仅用户本人** | 子账号 S 的控制台与凭据 |
| 创建/购买 **VPC、子网、CVM、云硬盘、安全组**（路径 A 在**子账号 S** 内；路径 B 另需跨账号互通确认） | **仅用户本人** | 对应账号的腾讯云控制台 |
| 私密交接两个口令 | **仅用户本人** | 私密文件/私密通道 |
| （仅路径 A）把 CIDR **四处同改** | 写手/运维，**需单独授权** | 改本仓库 `deploy/**` 并重新评审 |
| `install-postgres.sh` | 运维（获准后） | CVM 上 `sudo`（root） |
| 迁移 `migrate.ts` | 运维（获准后） | `gengyun_cvm_owner` 口令 |
| `provision-db.sh` | 运维（获准后） | CVM 上 `sudo` + 运行时口令 |
| `backup-postgres.sh` / `restore-drill.sh` | 运维（获准后） | CVM 上 `sudo` |
| `verify-cvm-postgres.sh` | 运维 + 验收方复核 | CVM 上 `sudo`；安全组项由用户控制台核对 |
| 宣布验收 | **不由执行者本人** | 独立复核方 |

## 2 口令私密交接（不进聊天/仓库/PR/文档）

1. 生成两个口令（各自独立，都是 48 位小写十六进制）：

   ```bash
   openssl rand -hex 24   # 给 gengyun_cvm_owner
   openssl rand -hex 24   # 给 gengyun_api_runtime
   ```

   （形状与 `tools/local-dev/start.ps1` 的生成口径一致，也是脚本强制的形状。）

2. 在目标 CVM 上落成私密文件，**不要**贴在聊天里、**不要**提交：

   ```bash
   sudo install -d -o root -g postgres -m 0750 /etc/gengyun/private
   sudo install -o root -g postgres -m 0600 /dev/null /etc/gengyun/private/db-credentials.env
   sudo tee /etc/gengyun/private/db-credentials.env >/dev/null <<'EOF'
   GENGYUN_DB_OWNER_PASSWORD=<粘贴在这里>
   GENGYUN_API_RUNTIME_PASSWORD=<粘贴在这里>
   EOF
   sudo chown root:postgres /etc/gengyun/private/db-credentials.env
   sudo chmod 0600 /etc/gengyun/private/db-credentials.env
   ```

   `GENGYUN_*_PASSWORD` 也可以改成由服务管理器（systemd `EnvironmentFile=`）注入到进程环境；
   两条通道都是"服务端私密环境"，脚本只从这两处读，**从不接受 argv 里的口令**。

3. 运行时口令交付给 API 部署方时，只给"私密文件位置/密钥管理引用"，不要给明文内容。

**残留风险（必须知道）**：`CREATE/ALTER ROLE ... PASSWORD` 会把明文口令发给服务器（协议限制）。
缓解是 `log_statement = 'none'` 与不打日志；更严格的做法是用 `psql \password` 让客户端先算
SCRAM 校验值再发送，本交付**未接线**（见 [README.md](README.md) 第 6 节第 2 条）。

## 3 部署步骤

### 步骤 1 安装与初始化

```bash
sudo deploy/postgres-cvm/install-postgres.sh --plan    # 零改动，先看计划
sudo deploy/postgres-cvm/install-postgres.sh           # 幂等，可重复执行
```

期望结尾包含：

```text
[install-postgres.sh] 网络姿态自检通过：仅回环与 VPC 私网 IPv4 在监听 5432。
  server_version=17.11 listen_addresses=127.0.0.1,<目标网段>.x.y port=5432
```

（路径 B 下 `<目标网段>` = `10.20`；路径 A 下 = 你在子账号 S 里选的新网段前两段，如 `10.21`。
若这里是旧网段，说明 §0.5 的四处同改没做完。）

若出现下列任一失败，按提示处置，**不要跳过**：

| 报错关键词 | 含义 | 处置 |
| --- | --- | --- |
| `目标 CVM 发行版为 …` | 不是 apt 系 | 停下来决策 OS（README 前置 P2） |
| `在 VPC 网段 … 内找到 0 个私网 IPv4` | ① CVM 未加入该网段；或 ② **路径 A 换了 CIDR 但脚本常量没改** | 路径 B：让用户把 CVM 加入该 VPC；路径 A：按 [README.md](README.md) §0.5 改 `VPC_CIDR` 后重跑 |
| `数据目录落在根分区` | 没有独立云硬盘 | 用户挂载云硬盘，或显式接受风险 |
| `已占用端口 5432` | 发行版集群在跑 | 确属空集群则 `GENGYUN_DROP_DEFAULT_CLUSTER=1`，或改端口 |
| `未找到 postgresql-17=17.11` | 仓库里没有该 minor | 不要换 minor；先与需求方确认版本口径 |
| `检测到端口 5432 监听在通配地址上` | 配置没生效 | 检查 `conf.d/10-gengyun.conf` 的 `listen_addresses` |

**此步之后立刻做的事**：请用户在**对应账号**的控制台确认安全组入站 `5432` 只放行**目标网段**
（路径 A 在**子账号 S**；路径 B 在**父账号 P**）。
在这条确认之前**不要**让 API 连过来，也不要对外暴露任何端口。

### 步骤 2 迁移

```bash
node services/api/src/db/migrate.ts list        # 不连库，先看发现列表
export DATABASE_URL='postgres://gengyun_cvm_owner:<私密口令>@127.0.0.1:5432/gengyun'
node services/api/src/db/migrate.ts status
node services/api/src/db/migrate.ts up
node services/api/src/db/migrate.ts up          # 再跑一次，验证幂等：应为“已应用：（无）”
unset DATABASE_URL
```

期望 `up` 第一次列出全部 10 个版本为"已应用"，第二次为"（无）"。两个输出都要留档。

### 步骤 3 角色引导与最小权限断言

```bash
sudo deploy/postgres-cvm/provision-db.sh --plan   # 先看计划
sudo deploy/postgres-cvm/provision-db.sh
```

期望包含：

```text
[provision-db.sh] 迁移校验通过：10 个版本已全部应用（0001 … 0010）。
[provision-db.sh] 最小权限断言通过：ok
```

若报 `尚无 schema_migrations 表` 或 `以下迁移在磁盘上存在但未应用` ⇒ **回到步骤 2**，
这正是"迁移必须在角色之前"的硬门禁。

### 步骤 4 备份与恢复演练

```bash
sudo deploy/postgres-cvm/backup-postgres.sh
sudo deploy/postgres-cvm/restore-drill.sh --dump /data/gengyun/backup/gengyun-gengyun-<UTC>.dump
```

期望 `restore-drill.sh` 结尾 `PASS=n FAIL=0` 并打印 `恢复演练【通过】`。
若退出码为 `2`（缺清单/判据不完整），**不算演练通过**，必须补齐后重跑。

定时建议（不自动安装；是否启用由用户决定）：

```cron
17 3 * * * /opt/gengyun/deploy/postgres-cvm/backup-postgres.sh >> /var/log/gengyun-backup.log 2>&1
```

### 步骤 5 启动 API 与验证

用最小权限连接串（只经私密环境注入）：

```bash
export DATABASE_URL='postgres://gengyun_api_runtime:<私密口令>@127.0.0.1:5432/gengyun'
npm run start --workspace @gengyun/api
```

然后跑验证清单并**整段保存原始输出**：

```bash
sudo deploy/postgres-cvm/verify-cvm-postgres.sh \
  --remote-host <同VPC另一台机> \
  --runtime-password-env GENGYUN_API_RUNTIME_PASSWORD | tee /tmp/verify-cvm-$(date -u +%Y%m%dT%H%M%SZ).log
```

退出码：`0` 全通过；`1` 有失败判据；`2` 无失败但有缺项（证据不完整）。

## 4 日常运维

| 项 | 命令 | 期望/阈值 |
| --- | --- | --- |
| 存活 | `systemctl status gengyun-postgresql.service` | `active (running)` |
| 就绪 | `sudo -u postgres /usr/lib/postgresql/17/bin/pg_isready -h /var/run/postgresql` | `accepting connections` |
| 版本漂移 | `sudo -u postgres .../psql -h /var/run/postgresql -U gengyun_cvm_owner -d gengyun -tAc 'SHOW server_version'` | 仍为 `17.x`；不要无意升级 minor |
| 监听面 | `ss -ltn "sport = :5432"` | 只有 `127.0.0.1` 与 VPC 私网 IP |
| 认证配置 | `SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL;` | `0` |
| 数据盘余量 | `df -h /data` | 留出 ≥ 备份体积 × 保留份数的余量 |
| 备份新鲜度 | `sudo deploy/postgres-cvm/backup-postgres.sh --list` | 最新一份 ≤ 1 天 |
| 备份清单一致 | `verify-cvm-postgres.sh` 的 `backup_sha256_matches_manifest` | `PASS` |
| 连接数 | `SELECT count(*) FROM pg_stat_activity;` | 远低于 `max_connections=100` |
| 错误日志 | `journalctl -u gengyun-postgresql.service -n 100` / `${PGDATA}/log/` | 无反复的认证失败/权限错误 |
| 保留期清理预览 | `sudo deploy/postgres-cvm/backup-postgres.sh --dry-retention` | 先看要删什么，再让它随备份自动清理 |

**不要**在目标库上跑 `tests/integration/*.mjs`：那些脚本有"专用空库 + 故障注入 + 限定回滚"的前置，
会破坏业务库（`docs/verification/database-run-handoff.md` 已明示）。

## 5 回滚

### 5.0 回滚前先固定现场

```bash
sudo tar czf /root/gengyun-pg-config-$(date -u +%Y%m%dT%H%M%SZ).tgz \
  /data/gengyun/pgdata/pg_hba.conf \
  /data/gengyun/pgdata/pg_ident.conf \
  /data/gengyun/pgdata/conf.d \
  /data/gengyun/pgdata/postgresql.conf \
  /etc/systemd/system/gengyun-postgresql.service
sudo -u postgres /usr/lib/postgresql/17/bin/pg_dump -h /var/run/postgresql -U gengyun_cvm_owner \
  -d gengyun -Fc -f /root/prechange-$(date -u +%Y%m%dT%H%M%SZ).dump   # 先备份再改
```

### 5.1 配置回滚（可逆）

适用：改了 `pg_hba.conf` / `pg_ident.conf` / `conf.d/*.conf` / systemd 单元之后要退回。

```bash
sudo cp <备份的 pg_hba.conf>   /data/gengyun/pgdata/pg_hba.conf
sudo cp <备份的 pg_ident.conf> /data/gengyun/pgdata/pg_ident.conf
sudo cp -r <备份的 conf.d>     /data/gengyun/pgdata/conf.d
sudo chown postgres:postgres /data/gengyun/pgdata/{pg_hba.conf,pg_ident.conf}
sudo chmod 0640 /data/gengyun/pgdata/{pg_hba.conf,pg_ident.conf}
sudo -u postgres /usr/lib/postgresql/17/bin/psql -h /var/run/postgresql -U gengyun_cvm_owner \
  -d gengyun -c 'SELECT pg_reload_conf()'          # pg_hba/conf.d 改动可热载
sudo -u postgres /usr/lib/postgresql/17/bin/psql -h /var/run/postgresql -U gengyun_cvm_owner \
  -d gengyun -tAc "SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL"   # 期望 0
```

若改的是 `postgresql.conf` 里的**非热载参数**（如 `listen_addresses`、`port`、`shared_buffers`），
`pg_reload_conf()` 不够，需要 `sudo systemctl restart gengyun-postgresql.service`（**会断连**）。

### 5.2 服务回滚（可逆）

```bash
sudo systemctl stop gengyun-postgresql.service     # 停库（API 会立刻失败，属预期）
sudo systemctl start gengyun-postgresql.service    # 起来
sudo systemctl restart gengyun-postgresql.service  # 重启（改非热载参数后用）
```

### 5.3 数据回滚（**边界与不可逆点在这里**）

| 场景 | 做法 | 可逆性 |
| --- | --- | --- |
| 只想核对某份备份 | `restore-drill.sh --dump <文件>`（恢复到隔离库，用完即删） | **完全可逆**（不碰业务库） |
| 想保留隔离库人工核对 | 加 `--keep`，核对完 `dropdb` | 可逆 |
| 业务库真的坏了要回退数据 | ① 停 API ⇒ ② `pg_dump` 现状（留证）⇒ ③ 重建库或新建库恢复 ⇒ ④ 起 API ⇒ ⑤ 重跑验证 | **部分不可逆**：从上次备份到故障点的写入**丢失** |
| 覆盖式恢复业务库 | 必须 `DROP DATABASE gengyun` 再建再恢复 | **不可逆点**：`DROP DATABASE` 之后旧数据只能靠备份 |
| 删 `PGDATA` 重建集群 | 只在彻底重装时 | **不可逆点**：集群身份、会话、所有增量都消失 |

操作纪律：

1. 任何覆盖业务库的动作前，**先对现状做一份 dump 并记录 SHA256**，否则连"回退到刚才那一版"都做不到。
2. 覆盖式恢复期间**必须停掉所有写入方**（API、定时任务），否则恢复完也是不一致的。
3. 恢复完必须做：[verify-cvm-postgres.sh](verify-cvm-postgres.sh) + 一次业务冒烟，才算恢复完成。
4. **不得**用恢复演练的通过来推断"灾难恢复可用"——演练只覆盖"同集群隔离库"。

### 5.4 迁移回滚（本交付**没有**受支持入口）

- `migrate.ts` 只实现 `up | status | list`，**没有 `down`**：传其它命令会明确报
  `未知命令：…（支持 up | status | list）`。
- `services/api/db/migrations/rollback/*.down.sql` 存在（0002–0010，**没有 0001**），
  但它们不是常规回滚工具：既有证据写明结构 down 在有审计/归属数据时会拒绝并保留对象
  （如 `AUDIT_ARCHIVE_REQUIRED`），且回滚后重新应用需要重新授权与转移函数所有权。
- 因此：**迁移视为单向**。要"回滚"一次迁移，正确做法是**从备份恢复**（5.3），
  或者在获准后按 `docs/verification/database-run-handoff.md` 的 down 前置人工评估 ——
  **不要**把 down 脚本当快捷键，也**不要**改已合并的迁移文件（会触发 checksum drift）。

### 5.5 不可逆点清单（写在前面，出事时不用猜）

1. `install-postgres.sh` 里 `initdb` 之后，数据目录的 `data-checksums` 与集群身份固定；重建才会变。
2. `pg_dropcluster --stop 17 main`（仅在显式 `GENGYUN_DROP_DEFAULT_CLUSTER=1` 且脚本确认集群为空时执行）。
3. `DROP DATABASE`。
4. 任何已应用的迁移（`schema_migrations` 里多一行；没有受支持的 down 入口）。
5. 备份保留期清理（`backup-postgres.sh` 删掉超过保留天数的 `gengyun-*.dump`）——**先 `--dry-retention` 看清楚**。
6. 用户数据被业务撤回/删除后的原始内容（数据库内部动作，备份里下一次滚动就没了）。

## 6 仅用户本人可做（写手/运维都不能代做）

| # | 事项 | 为什么只能用户做 |
| --- | --- | --- |
| U0 | **确认账号边界**：云托管环境 `prod-d1g6qe87c4f2d7061` 属**子账号 S**，`gengyun-vpc` 属**父账号 P**（S ≠ P） | 属账号级事实，只能用户从账户信息/控制台读；**已明确**（[README.md](README.md) §0.1）。标识值留私密留档 |
| U0b | **选定路径 A（推荐：子账号 S 内建网）还是路径 B（父账号 P 的 VPC + 跨账号互通）** | 决定资源建在哪个账号，属于用户的架构与费用决策；**本单不选**（[README.md](README.md) §0.4） |
| U0c | **确认跨账号私有互通／子网共享是否有官方依据**（路径 B 的必要条件） | **本单未找到依据**（本会话检索通道不可用；可达的两页官方文档未记载 VPC 绑定）；需控制台或工单确认 |
| U0d | **提供子账号 S 的（只读）凭据，或在子账号 S 控制台内代为操作** | 我们只有父账号 P 的只读视角，**对子账号 S 名下的 VPC/CVM/安全组没有视角**，无法核对与验证 |
| U1 | （在**选定账号**内）创建 **VPC + 子网**（路径 A 需新建，CIDR 勿与 `10.20.0.0/16` 重叠；路径 B 复用父账号 P 的 `gengyun-vpc`）与 **CVM**，地域 `ap-shanghai` | 涉及账号与付费；本单明确不购买、不创建资源（父账号 P 实测 0 台 CVM）。**这是当前最靠前的待办**。⚠️ **不要**在父账号 P 里为子账号 S 的环境新建 VPC（解决不了互通） |
| U2 | 创建并挂载云硬盘（承载 `/data/gengyun/pgdata`） | 同上 |
| U3 | 配置安全组：入站 `5432` 来源仅**所选路径的目标网段**（路径 A = 子账号 S 的新网段；路径 B = `10.20.0.0/16`），关闭公网 | 安全组在账号侧；脚本无云凭据，无法读取或修改；**子账号 S 无视角** |
| U4 | （路径 B）打通跨账号互通并把云托管环境与目标 VPC 关联；路径 A 则把环境绑定到子账号 S 内新建的 VPC | 涉及账号资源与费用，且路径 B 依赖 U0c 的结论 |
| U5 | 用私密通道交接两个口令（48 位小写十六进制） | 口令不得进聊天/仓库/PR/文档 |
| U6 | 决定 CVM 的操作系统（Ubuntu 22.04/24.04、Debian 12，或接受需要另行实现的 yum 变体） | 直接决定安装路径是否可用 |
| U7 | 确认是否要求 PG 侧 TLS、是否要 PITR、备份落点与保留期 | 需求与成本决策 |
| U8 | 授权任何付费资源/额度 | 本单不涉及付款 |
| U9 | 确认"注销后备份 30 日内清理个人数据"如何验收（逐用户删除，本交付未实现） | 需求实现决策 |
| U10 | 指定独立验收方并做最终验收 | 执行者不得自证验收通过 |

## 7 故障处置速查

| 现象 | 最可能原因 | 先看 | 处置 |
| --- | --- | --- | --- |
| API 健康检查 `database.status=error`，`category=auth_failed`（`28P01`/`28000`） | 口令错 / `pg_hba` 不匹配 | `pg_hba_file_rules`、`journalctl -u gengyun-postgresql`（会记录 `password authentication failed`） | 核对私密文件里的运行时口令；确认 `scram-sha-256` 行存在 |
| API `category=connection_failed`（`ECONNREFUSED`） | 没监听该地址 / 安全组挡了 | `ss -ltn "sport = :5432"`、`SHOW listen_addresses` | 修 `listen_addresses`；用户核对安全组 |
| API `category=database_missing`（`3D000`） | 库名写错或库没建 | `\l` 等价查询 | 用 `gengyun`（或 `GENGYUN_DB_NAME` 指定的一致名字） |
| API 报 `42501 permission denied` | 角色引导没跑或跑在错误的库上 | `verify-cvm-postgres.sh` 的 `least_privilege_assert`、`runtime_can_read_*` | 跑 `provision-db.sh` |
| `pg_hba_file_rules` 有 `error` | 手改坏了配置 | `SELECT * FROM pg_hba_file_rules WHERE error IS NOT NULL` | 从 5.0 的备份恢复（5.1） |
| `migrate.ts` 报 drift | 磁盘上的迁移文件被改过 | `migrate.ts status` | 不要继续；恢复被改的文件到与 HEAD 一致 |
| 备份文件为 0 字节或 `pg_restore --list` 失败 | 备份过程被打断/磁盘满 | `backup-postgres.sh --list`、`df -h` | 当次备份**不算数**，修好后重跑 |
| 恢复演练 `PASS=n FAIL>0` | 备份与清单不一致或恢复报错 | 演练输出里的逐行期望/实际 | 按失败判据处理；**不得**宣称备份可用 |
| 验证脚本退出码 `2` | 缺项（口令/备份/远端探针） | 输出里的 `SKIP` 行 | 补齐后重跑，别把 `2` 当通过 |
