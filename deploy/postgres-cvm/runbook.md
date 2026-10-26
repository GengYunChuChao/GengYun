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

> ### 目标形态：**用户已选定路径 A**
>
> - **路径 A（✅ 已选定）**：在**子账号 S** 内新建 **VPC + 子网**（**CIDR 已定 = `10.21.0.0/16`**，
>   与父账号 P 的 `10.20.0.0/16` 不重叠）+ **标准 CVM** + PostgreSQL；云托管环境绑该 VPC ⇒ **同账号直连**。
>   **⚠️ 服务器必须是标准 CVM**：官方 FAQ 明确 **Lighthouse 不支持自定义 VPC**（"网络由系统自动创建并分配"），
>   若把 PG 装在 Lighthouse 上，它**不在该 VPC 内**、云托管绑不到它 —— 详见 [README.md](README.md) §2.5。
>   **网段变更已由用户授权完成**（`10.20.0.0/16` → `10.21.0.0/16`，四处同改见
>   [README.md](README.md) §0.5）；若将来还要再改，照该节步骤并复跑其中的检查。
> - **路径 B（未采用，保留为历史）**：仍用**父账号 P** 的 `gengyun-vpc`，但需要**跨账号私有互通**
>   （对等连接／云联网 CCN —— **是否支持该形态：未找到依据**）**且** CloudRun 侧仍需在
>   **子账号 S** 内有可绑定的 VPC／子网。**在拿到官方依据前不要按此路径动手。**
>
> 两条路径的对照见 [README.md](README.md) §0.4。

> ### ⛔ 授权门禁（**与账号条件无关，仍然适用**）
>
> 1. **未取得用户对具体动作的明确授权之前：不要创建 CVM、不要建库、不要购买任何资源包、不要改动 VPC。**
>    （**"选定方案 A"是路线决策，不等于授权任何人去创建资源**；本单仍未创建、未购买任何云资源。）
> 2. **本单新增**：**不要在父账号 P 里"为子账号 S 的环境"新建 VPC。**
>    父账号里的新 VPC 仍然不在子账号 S 名下，**解决不了互通问题**，
>    只会多出一份要维护与计费的资源。路径 A 的 VPC **必须建在子账号 S 内**。
> 3. **本单新增**：**不要改动、重建或删除父账号 P 的 `gengyun-vpc`**——它在本路线下不使用，保留原样。
> 4. **换绑绝对禁止**：把云托管环境改到父账号 P，官方明确**必须销毁当前所有环境且不可恢复**。
>
> 账号结构本身**不是**"可以动手"的授权；本单授权范围始终只有"交付技术准备物"。

**凭据视角**：仓库现有两份只读凭据都属**父账号 P** ⇒ 对**子账号 S** 名下的资源**没有视角**。
**需用户提供**：**子账号 S 的（只读）凭据**，**或**由用户在**子账号 S** 控制台内完成建网／建 CVM／配**入站规则**
并把结果给出（含所选子网、CVM 私网 IP、入站规则内容）。

**仍待用户完成**（做完这几项，本 Runbook 第 3 节才有执行条件；顺序不可颠倒）：
① ~~选定路径~~**已定：方案 A**、网段 **已定并完成变更 `10.21.0.0/16`**；
② 在**子账号 S** 内准备 **VPC(`10.21.0.0/16`) + 子网 + 标准 CVM**（**不要用 Lighthouse**，见 §2.5 的官方依据）——
   **两个子网**：`10.21.0.0/24 @ ap-shanghai-1` 与 `10.21.1.0/24 @ ap-shanghai-2`（用户所定，ID 待回传）；
   **对本交付无影响**：脚本按 **VPC 网段 `10.21.0.0/16`** 匹配与授权，**天然覆盖两个子网**，
   **5432 来源仍写 `10.21.0.0/16`**，**不新建第二套配置**（详见 [README.md](README.md) §2.6）；
③ 创建并挂载云硬盘；④ 配置**入站规则**（标准 CVM = 安全组；Lighthouse = 实例防火墙）——`5432` 仅放行 `10.21.0.0/16`；
⑤ 私密交接两个 48 位十六进制口令；⑥ 提供**子账号 S 的只读凭据**（或代为操作的结果）。

当前门禁状态：账号边界 **已明确（S ≠ P ⇒ 风险适用）**；路径 **已选 A**、网段 **已变更**；
父账号 P 实测 CVM **0 台**、安全组 **0 个**；**子账号 S 无视角**；云硬盘 **未核实**；口令 **未交接**。
⇒ 本 Runbook 的"部署步骤"目前**在任何环境上都还不可执行**，第 3 节只是资源就绪后照着做的操作手册。

| 检查 | 命令 | 期望 |
| --- | --- | --- |
| **路径与网段** | `grep -n "VPC_CIDR=\|VPC_PREFIX=" deploy/postgres-cvm/*.sh`；`grep -n '10\.21' deploy/postgres-cvm/conf/pg_hba.gengyun.conf` | **`10.21.0.0/16` / `10.21`**；`pg_hba` 三处均为 `10.21.0.0/16`（§0.5 已完成变更） |
| **服务器在目标网段内** | `ip -4 -o addr show scope global` | 有一个 `10.21.x.y`（**方案 A 目标网段的任一子网都可以**：`10.21.0.x` 或 `10.21.1.x`；脚本按 `^10\.21\.` 匹配，见 [README.md](README.md) §2.6） |
| 行尾是 LF（**必查**） | `grep -lU $'\r' deploy/postgres-cvm/*.sh` | 无输出（有输出就先 `dos2unix`／`sed -i 's/\r$//'`） |
| 脚本语法 | `for f in deploy/postgres-cvm/*.sh; do bash -n "$f" \|\| echo "FAIL $f"; done` | 无 `FAIL` |
| 拿到基线 | `git rev-parse HEAD` | 记录实际 SHA（部署与 PR 必须同一 SHA） |
| OS 与发行版 | `. /etc/os-release; echo "$ID $VERSION_ID"` | `ubuntu 22.04` / `ubuntu 24.04` / `debian 12`（否则停下来决策，见 [README.md](README.md) 前置 P2） |
| 数据盘已挂载 | `df -P -- /data` | 设备是云硬盘（不是 `/`） |
| 私密文件权限 | `stat -c '%a %U:%G' /etc/gengyun/private/db-credentials.env` | `600 root:root`（脚本以 root 读取；**不要**在装包前 `chown root:postgres`——那时 postgres 组还不存在） |
| 时间同步 | `timedatectl status` | 已同步（影响备份文件名/审计） |

**先干跑一遍**：`sudo deploy/postgres-cvm/install-postgres.sh --plan`。它会解析版本、检测私网 IP、
判定持久盘、校验口令形状，并打印将要执行的动作，**零改动**。计划不对就不要往下走。

### `--plan` 的期望输出，以及**什么不算通过**

**① 服务器确实在 `10.21.0.0/16` 内（正常）** —— 应看到类似输出（**没有** `[ERROR]`）：

```text
[install-postgres.sh] 数据目录：/data/gengyun/pgdata
[install-postgres.sh] 所在文件系统：/dev/vdb 挂载点 /data
[install-postgres.sh] 将安装：postgresql-17=17.11-1.pgdg…
[install-postgres.sh] [PLAN] 安装 /data/gengyun/pgdata/conf.d/10-gengyun.conf（listen_addresses=127.0.0.1,10.21.x.y port=5432）
[install-postgres.sh] [PLAN] 安装 /data/gengyun/pgdata/pg_hba.conf（仅回环 + 10.21.0.0/16，无 0.0.0.0/0）
[install-postgres.sh] [PLAN] runuser -u postgres -- …/initdb -D /data/gengyun/pgdata -U gengyun_cvm_owner …
[install-postgres.sh] [PLAN] systemctl restart gengyun-postgresql.service 并等待 pg_isready
[${SCRIPT_NAME}] 完成（PLAN_ONLY=1）。
```

判读要点：`listen_addresses=127.0.0.1,10.21.x.y` 里的私网 IP **必须是 `10.21.` 开头**。

**② 服务器不在 `10.21.0.0/16` 内（例如本机 WSL、或用了错误的子网）** —— 脚本会**明确失败并退出非零**：

```text
[install-postgres.sh][ERROR] 在 VPC 网段 10.21.0.0/16 内找到 0 个私网 IPv4（期望正好 1 个）：
         候选：（无）
         请确认该 CVM 已加入 方案 A 目标 VPC（子账号 S 内新建，名称待用户确定） （尚未创建：本单不创建云资源） 的对应子网，或显式设置 GENGYUN_VPC_PRIVATE_IP。
```

> ⚠️ **这条 `[ERROR]` 不是通过、也不是"脚本坏了"**：它**正是**脚本在说
> "**这台机器没有被纳入目标网段，装下去会让 `listen_addresses`/`pg_hba`/入站规则三者不一致**"。
> 正确处理是二选一：把 CVM 放进 `10.21.0.0/16` 的子网；或确认网段后按
> [README.md](README.md) §0.5 重做四处同改再跑。**不得**用 `GENGYUN_VPC_PRIVATE_IP` 硬塞一个网段外的 IP
> （脚本会对网段外的覆盖值同样拒绝）。**判据：只有 ① 那种无 `[ERROR]` 的输出才算"计划可用"。**（本文件**不**覆盖的四类步骤 —— 代码分发、API 常驻载体、CI 部署流水线、迁移自动化 —— 见**文末附录 A**。）

## 1 角色分工（谁能做哪一步）

| 步骤 | 执行者 | 需要的权限 |
| --- | --- | --- |
| **账号边界确认与路径选择**（边界已明确 S ≠ P；**路径已定 = 方案 A**） | **用户本人** | 腾讯云账号控制台 / 账户信息 |
| **确认服务器形态必须是标准 CVM**（§2.5：Lighthouse 不支持自定义 VPC） | **用户本人** | 控制台/工单 |
| **提供子账号 S 的（只读）凭据，或在子账号 S 控制台内代为操作** | **仅用户本人** | 子账号 S 的控制台与凭据 |
| 创建/购买 **VPC(`10.21.0.0/16`)、两个子网（`10.21.0.0/24 @ap-shanghai-1`、`10.21.1.0/24 @ap-shanghai-2`）、标准 CVM、云硬盘、入站规则**（均在**子账号 S** 内） | **仅用户本人** | 对应账号的腾讯云控制台 |
| 在云托管「服务设置 → 私有网络」**选一个子网**（选哪个都通；建议选 DB 服务器所在的那个） | **仅用户本人** | 云托管控制台 |
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
   # 【返修 8】在装 PG 包**之前**不要引用 postgres 组/用户 —— 它们由 postgresql-17 的 postinst 创建，
   # 此刻还不存在（旧写法 `-g postgres` 会以 invalid group 中止）。私密文件由本脚本以 root 读取，
   # 因此用 root:root 0600 就够；需要 postgres 访问的是 initdb 的**临时**口令文件，
   # 而私密**目录**的属组会由 install-postgres.sh 在装包之后自动 chgrp 为 postgres。
   sudo install -d -o root -g root -m 0750 /etc/gengyun/private
   sudo install -o root -g root -m 0600 /dev/null /etc/gengyun/private/db-credentials.env
   sudo tee /etc/gengyun/private/db-credentials.env >/dev/null <<'EOF'
   GENGYUN_DB_OWNER_PASSWORD=<粘贴在这里>
   GENGYUN_API_RUNTIME_PASSWORD=<粘贴在这里>
   EOF
   sudo chown root:root /etc/gengyun/private/db-credentials.env
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

#### ⚠️ 怎么**正确**取退出码（否则会得到"假成功"）

`exit 0` 是本脚本的**承诺**：它只会在收尾硬校验（`PG_VERSION`、单元 active、`pg_isready`、业务库可查询）**全部通过**后返回 0；
任一环节失败都会**非零退出**。但**你的调用方式会决定 `$?` 是谁的**：

```bash
# ✅ 正确：直接取脚本退出码
sudo deploy/postgres-cvm/install-postgres.sh; echo "INSTALL_EXIT=$?"

# ✅ 正确：要留日志又要真退出码（两种都行）
sudo deploy/postgres-cvm/install-postgres.sh > /tmp/install.log 2>&1; echo "INSTALL_EXIT=$?"
( set -o pipefail; sudo deploy/postgres-cvm/install-postgres.sh 2>&1 | tee /tmp/install.log ); echo "INSTALL_EXIT=$?"

# ❌ 错误：管道里的 $? 是**末位命令**的（tee/tail/head 通常返回 0）⇒ 看起来"成功"
sudo deploy/postgres-cvm/install-postgres.sh 2>&1 | tee /tmp/install.log; echo "INSTALL_EXIT=$?"   # ← 这会骗你
```

> **这就是"失败却 exit=0"最常见的来源**：把输出接进 `tee`/`tail` 再看 `$?`。
> 若你在自动化里用了管道，请务必 `set -o pipefail` 或改用 `${PIPESTATUS[0]}`。

#### 关于 `postgres` 用户/组（**返修 8**）

- 私密**目录**在装包前由脚本以 **`root:root` 0750** 创建；**装包后**脚本会断言
  `postgres` 用户/组确实由 `postgresql-17` 包创建，并把它 `chgrp` 为 `postgres`
  （目录是 0750，`postgres` 必须能"穿过"它才能读 initdb 的临时口令文件）。
- **不要**自己 `groupadd`/`useradd` 造 PG 运行身份（那是绕过、会与发行版包的行为不一致）；
  脚本也**不会**这么做——它只断言存在，不存在就明确失败并给出排查命令。

#### 逐级目录必须能被 `postgres` **穿越**（**返修 9 · 缺陷 3**）

initdb 的临时口令文件放在 `${GENGYUN_PRIVATE_DIR}`（默认 `/etc/gengyun/private`）里，
所以 `postgres` 必须能穿过**每一级**父目录（每级都要有 `x` 位）。真机曾出现：

```text
initdb: error: could not open file "/etc/gengyun/private/.initdb-pw.J1ECyF" for reading: Permission denied
$ namei -l /etc/gengyun/private
drwxr-xr-x root root /            ← 0755 可穿越
drwx------ root root gengyun      ← **0700 root:root ⇒ postgres 连目录都进不去**
```

**本版怎么保证**：

- 装包前：脚本**显式建两级**（`/etc/gengyun` 与 `/etc/gengyun/private`）为 `0750 root:root`
  并**断言权限是 750**；`install -d -m 0750` 对**已存在**目录也会把模式修正过来（已实测），
  所以历史上被留成 0700 的父目录也会被收敛。
- 装包后：**逐级** `chgrp postgres` + **逐级** `runuser -u postgres -- test -x` 断言，
  并给出 `namei -l` 提示——把 `Permission denied` 从 initdb 阶段**前移**。
- initdb 前还会再断言一次"**临时口令文件对 postgres 可读**"（`test -r`），失败时打印逐级权限。
- ⚠️ 脚本**不再**在 `umask 077` 下用 `install -d` 隐式创建私密目录（那会把父目录建成 0700 —— 缺陷根因）。

自查命令（任何一步报权限问题都用它）：

```bash
namei -l /etc/gengyun/private
sudo -u postgres test -x /etc/gengyun && sudo -u postgres test -x /etc/gengyun/private && echo "可穿越"
```

#### 半初始化数据目录必须显式处理（**返修 9 · 缺陷 4**）

initdb 失败会留下"**非空但没有 `PG_VERSION`**"的数据目录；直接重跑会再次报
`directory is not empty`（不自愈）。本版把判断**前移到装包之前**：

```bash
# 默认：明确失败，打印内容预览与两种处置，**不替用户删数据**
sudo deploy/postgres-cvm/install-postgres.sh
# 显式清空后继续（会先打印预览；拒绝在挂载点自身或系统目录上执行）
GENGYUN_RESET_PGDATA=1 sudo deploy/postgres-cvm/install-postgres.sh
```

#### 仓库路径与权限（**返修 10 · 缺陷 6**）

- **不需要**为 `postgres` 放宽仓库权限：`provision-db.sh` / `verify-cvm-postgres.sh` 会把要执行的
  SQL **复制到 postgres 可读的临时目录**（`0700 postgres`，执行后立即删除），因此仓库可以位于
  `/home/<user>` 这类默认 `0750` 的目录下。
- ⛔ **不要** `chmod 777`，也**不要**把家目录改成 `0755` 来"让它能跑"——那是绕过，会造成不必要的信息暴露。
- 若你**手工**执行 `runuser -u postgres -- psql -f <仓库文件>`，那条手工命令仍会因目录权限失败；
  请先自行 `cp` 一份到 postgres 可读处。

#### 变量命名约束（**返修 10 · 缺陷 5**，改动脚本时必看）

- **不要**把清单/数组命名为 bash 的保留或特殊变量（`GROUPS`、`SECONDS`、`RANDOM`、`UID`、`EUID`、
  `PPID`、`FUNCNAME`、`OPTARG`、`OPTIND`、`PIPESTATUS`、`REPLY`、`IFS`、`PATH`、`BASH_*` 等）。
  真机曾因把角色清单命名为 `GROUPS` 而报 `…/roles/0`：`GROUPS` 由 shell 维护、**赋值无效**，
  用 `sudo` 跑时它是 `(0)`（root 的 gid）⇒ 循环把 `0` 当成文件名。
- 已改名为 `ROLE_GROUP_FILES`；自查命令见 [evidence/local-self-check.md](evidence/local-self-check.md) §9.1。

#### 境内加速：可选 PGDG 镜像（**返修 9 · 可选**）

真机实测：官方 `apt.postgresql.org` 约 **6.7 KB/s**（装一个包要 ~40 分钟）；
`mirrors.cloud.tencent.com/postgresql/repos/apt` 与 `mirrors.aliyun.com/postgresql/repos/apt`
均可用且约 **930 KB/s**；清华/中科大对应路径 **404**（勿用）。

```bash
# 默认仍是官方源；要加速就显式指定（镜像只改**下载源**，不改版本口径：仍是 CI 的 17.11）
export GENGYUN_PGDG_MIRROR=https://mirrors.cloud.tencent.com/postgresql/repos/apt
sudo -E deploy/postgres-cvm/install-postgres.sh
# 若 sudo 不允许传环境，改用： sudo GENGYUN_PGDG_MIRROR=... deploy/postgres-cvm/install-postgres.sh
# 别名等价：PGDG_MIRROR=... ；公钥地址也可覆盖：GENGYUN_PGDG_KEY_URL=...
```

脚本会在切换镜像时**明确打印**实际使用的源（`PGDG 源已按 … 切换为镜像：…`）；
**若输出里没有这一行，说明镜像变量没传进脚本**（`sudo` 默认会重置环境）——请改用上面任一写法。
`sources.list` 的内容与会话要求不一致时会重写（幂等）。

期望结尾包含：

```text
[install-postgres.sh] 网络姿态自检通过：仅回环与 VPC 私网 IPv4 在监听 5432。
  server_version=17.11 listen_addresses=127.0.0.1,10.21.x.y port=5432
```

（方案 A 的目标网段 = `10.21.0.0/16`，所以这里**必须是 `10.21.x.y`**。
若显示的是 `10.20.x.y` 或别的网段，说明服务器不在目标 VPC 的子网里，或 §0.5 的四处同改没做完 —— **不要继续**。）

若出现下列任一失败，按提示处置，**不要跳过**：

| 报错关键词 | 含义 | 处置 |
| --- | --- | --- |
| `目标 CVM 发行版为 …` | 不是 apt 系 | 停下来决策 OS（README 前置 P2） |
| `在 VPC 网段 … 内找到 0 个私网 IPv4` | ① CVM 未加入该网段；或 ② **路径 A 换了 CIDR 但脚本常量没改** | 路径 B：让用户把 CVM 加入该 VPC；路径 A：按 [README.md](README.md) §0.5 改 `VPC_CIDR` 后重跑 |
| `数据目录落在根分区` | 没有独立云硬盘 | 用户挂载云硬盘，或显式接受风险 |
| `已占用端口 5432` | 发行版集群在跑 | 确属空集群则 `GENGYUN_DROP_DEFAULT_CLUSTER=1`，或改端口 |
| `未找到 postgresql-17=17.11` | 仓库里没有该 minor | 不要换 minor；先与需求方确认版本口径 |
| `检测到端口 5432 监听在通配地址上` | 配置没生效 | 检查 `conf.d/10-gengyun.conf` 的 `listen_addresses` |

**此步之后立刻做的事**：请用户在**子账号 S** 的控制台确认**入站规则**（标准 CVM = **安全组**；
若确用 Lighthouse 则是**实例防火墙**）只放行**目标网段 `10.21.0.0/16`**。
⚠️ **Lighthouse 防火墙的来源默认是 `0.0.0.0/0`，必须手动收紧**；且其**只控入流量**（详见 [README.md](README.md) §2.5）。
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

期望 `up` 第一次列出**磁盘上全部未应用的迁移**为"已应用"（数量与清单以 `ls services/api/db/migrations/*.sql` 的实测为准，本文件不写死版本数），第二次为"（无）"。两个输出都要留档。

### 步骤 3 角色引导与最小权限断言

```bash
sudo deploy/postgres-cvm/provision-db.sh --plan   # 先看计划
sudo deploy/postgres-cvm/provision-db.sh
```

期望包含：

```text
[provision-db.sh] 迁移校验通过：<磁盘版本数> 个版本已全部应用（<磁盘清单>）。
[provision-db.sh] 最小权限断言通过：ok
```

若报 `尚无 schema_migrations 表` 或 `以下迁移在磁盘上存在但未应用` ⇒ **回到步骤 2**；判据不是"到了某个号"——`status` 里磁盘清单的每一个版本都已应用才算通过，
这正是"迁移必须在角色之前"的硬门禁。

**口令与幂等（返修后语义）**：本步**默认不改口令**——首次创建才写入口令，重复执行保持
`pg_authid.rolpassword` 不变（因此"幂等"可严格判定）。需要轮换时显式加
`--rotate-runtime-password`；注意轮换后 `rolpassword` **必然变化**
（PostgreSQL 每次都用新的随机 salt 重算 SCRAM 校验值），这是固有行为、不是缺陷。
完整语义见 [roles-and-migration.md](roles-and-migration.md) §6.3。

> **真跑状态（执行者 = 指挥，在用户授权的目标 CVM 上；监工尚未复核）**：
> - 本步的全链已在目标 CVM 上跑通：`provision-db.sh` **`exit=0`**（创建 5 组 → `20-login-roles` 授予 5 组
>   → 90- 断言 `ok`），且**家目录保持 `0750`**、无 `Permission denied`、无 `roles/0`；
> - 早前由真跑发现并已修复的缺陷：`20-login-roles.sql` 旧版「**全新库上必失败**」的顺序缺陷、
>   以及「把台账列为硬前置」的过度约束；对应回归（**全新库首跑**、**重复执行幂等**）均已通过。
> - 这些结论绑定脚本指纹与 SHA `939670c`，原始输出见 [evidence §12](evidence/local-self-check.md)；
> - **平台侧连通已实测（2026-10-13）**：云托管实例内 `net.connect(5432,'10.21.1.8')` = **CONNECTED**、
>   平台内 `/health` = **HTTP 200**（`database.status=ok`）；CVM 侧 PG 日志显示该连接**通过 `scram-sha-256` 认证**
>   （原始输出见 [evidence §15](evidence/local-self-check.md)）。
> - **两层口径**：**事实层面**已部署且平台侧连通已实测；**验收层面仍未验收**（**监工尚未复核**）⇒
>   **不得声称"已验收"**；公网 5432 的独立复核、PITR/异地等仍未取得（[evidence §13.2／§15.4](evidence/local-self-check.md)）。

### 步骤 3.5 首次元权限引导（裁定 C，一次性）

`provision-db.sh`（步骤 3）之后、启动 API **之前**，必须用**迁移属主**身份跑一次引导，
把"第一个管理员 + `scopes:write` 元权限"落库。

为什么不是让 API 自己建：运行时角色 `gengyun_api_runtime` 对 `public.admin_accounts` 只有**列级
SELECT**（表级 INSERT 被 `90-assert-least-privilege.sql` 钉成 false），所以应用内
`ensureBootstrapAdmin()` 的第一步 `INSERT INTO admin_accounts` 必然 `42501`。裁定 C 的落点就是
"这份一次性 seed 只能在部署档、用属主身份完成"。

**① 生成摘要**（本步只收 scrypt 摘要，⛔ **不接受明文口令**。形状 `scrypt$N$r$p$saltB64$hashB64`，
由 `services/api/src/auth/password.ts` 的 `hashPassword` 定义：N=16384、r=8、p=1、salt 16 B、派生 64 B）：

```bash
read -r -s -p '设置初始管理员口令（≥12 字符）: ' GY_PW; echo
GY_HASH="$(GY_PW="$GY_PW" node --input-type=module -e 'import { hashPassword } from "./services/api/src/auth/password.ts"; process.stdout.write(hashPassword(process.env.GY_PW));')"
unset GY_PW
printf '%s\n' "$GY_HASH" | cut -c1-19      # 自查：必须以 scrypt$16384$8$1 开头
```

仓库要求 Node ≥ 24.16（`package.json` 的 `engines`），原生可执行 `.ts`，不需要构建、不需要额外依赖。

**② 以迁移属主身份执行一次**（两个变量都必填；不传即停，文件里**没有任何默认值**）：

```bash
install -o postgres -g postgres -m 0400 \
  deploy/postgres-cvm/sql/30-bootstrap-admin.sql /tmp/30-bootstrap-admin.sql   # postgres 可能读不到仓库目录

sudo -u postgres env \
  GENGYUN_BOOTSTRAP_ADMIN_LOGIN='<登录名>' \
  GENGYUN_BOOTSTRAP_ADMIN_CREDENTIAL_HASH="$GY_HASH" \
  /usr/lib/postgresql/17/bin/psql -h /var/run/postgresql -U gengyun_cvm_owner -d gengyun \
    -v ON_ERROR_STOP=1 -f /tmp/30-bootstrap-admin.sql ; rc=$?

rm -f -- /tmp/30-bootstrap-admin.sql
echo "exit=$rc"     # 期望 0
```

期望结尾打印：

```text
30-bootstrap-admin.sql 完成：已创建 1 名管理员 + 3 个 scope（scopes:write / session:read / session:logout）+ 1 行 bootstrap 审计。
  实测读数：admin_accounts=1  active_admin_scopes=3  reason_code=bootstrap 审计行=1
```

关于参数：
- 两个变量给的是**环境变量**（`\getenv` 读取），不是 SQL 里的字面量；摘要不会写进任何文件。
- 摘要会短暂出现在 `ps`／`/proc/<pid>/environ` 里，且**它不是口令本身**（拿不到口令就验不过）；
  仍按私密材料对待：不要贴进聊天、issue、提交信息。
- 登录名要求 3–80 位 `A-Z a-z 0-9 . _ @ -`；不符合时脚本 `RAISE EXCEPTION`，不会建半个账号。

**③ 自查**：跑一次验证脚本，看第 9.5 段。

```bash
sudo deploy/postgres-cvm/verify-cvm-postgres.sh
```

期望两行 `PASS`：`bootstrap_audit_exactly_one`（=1）、`scopes_write_active_holders`（>=1）。
这两条**没有 `skip` 兜底**：引导没跑就应当红（退出码 1），不要把它读成"只是缺项"。

**④ 重跑会失败，这是裁定要求的行为**：`30-bootstrap-admin.sql` 在 `public.admin_accounts` 非空时
直接 `RAISE EXCEPTION`（"已有管理员必须报错，不许静默跳过"）。看到
`已存在管理员，拒绝重复引导` 说明引导**已经成功跑过**，不要再跑；要新增管理员/调整授权，
走后台的 `grant_admin_scope` 与后台账号流程。

### 步骤 4 备份与恢复演练

```bash
sudo deploy/postgres-cvm/backup-postgres.sh
sudo deploy/postgres-cvm/restore-drill.sh --dump /data/gengyun/backup/gengyun-gengyun-<UTC>.dump
```

期望 `restore-drill.sh` 结尾 `PASS=n FAIL=0` 并打印 `恢复演练【通过】`。
若退出码为 `2`（缺清单/判据不完整），**不算演练通过**，必须补齐后重跑。

#### 三个脚本的退出码语义（**自动化按下表判读**；返修 11/12 已修正历史误判）

| 脚本 | 退出码 | 含义 | 能否作为"备份可恢复"证据 |
| --- | --- | --- | --- |
| `backup-postgres.sh` | `0` | 本次**已产出 dump 且通过可读性校验**（`pg_restore --list` 能列出目录）+ 清单已写 | **不能单独作为证据**：只能说明"备份动作成功" |
| `backup-postgres.sh` | `1` | 备份**过程失败**（pg_dump 报错/空产出、`pg_restore --list` 读不了、集群未就绪…） | 当次备份**不算数** |
| `restore-drill.sh` | `0` | 演练**通过**（`FAIL=0`：完整重建 schema+数据+授权，版本/表数/行数逐项一致） | **可以**，这就是"备份可恢复"的证据 |
| `restore-drill.sh` | `1` | 恢复过程报错（先在日志里按"致命/非致命"分类，见其文件头） | 不可用 / 待复核 |
| `restore-drill.sh` | `2` | 无失败但**证据不完整**（缺清单等） | 不算通过，补齐后重跑 |
| `verify-cvm-postgres.sh` | `0` | 本次全部可执行判据 PASS **且无 SKIP** | 可进入独立复核 |
| `verify-cvm-postgres.sh` | `1` | 有判据 FAIL | 不得记作已部署/已验收 |
| `verify-cvm-postgres.sh` | `2` | 无 FAIL 但有 **SKIP**（如未给 `--remote-host`／未给口令环境变量）⇒**证据不完整** | 不得当通过，补齐后重跑 |

> ⚠️ **`backup` 退出 0 ≠ 备份可恢复**：可恢复性**只能**由 `restore-drill.sh` 证明。
> 历史上 `backup-postgres.sh` 在**成功路径**上也会 `exit 1`（EXIT trap 里 `[[ … ]] && cmd` 短路所致），
> **返修 12 已修**；若你在旧副本上看到"dump 已产出但 exit=1"，请更新到含该修复的版本。
>
> 📌 **本项目的实测状态（2026-10-13）**：`verify` 那次运行的 `SKIP remote_vpc_tcp_open`
> **已由平台侧实测满足**（云托管实例 → `10.21.1.8:5432` 连通 + `scram-sha-256` 认证通过，
> 原始输出见 [evidence §15](evidence/local-self-check.md)）⇒ **这两行的退出码语义不变**，
> 但若你想让 `verify` 自己打出 `PASS`／退出码 `0`，用 `--remote-host <同 VPC 探针机>` 复跑即可。

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
- `services/api/db/migrations/rollback/NNNN_*.down.sql` 存在（**没有 `0001` 的 down**；覆盖哪些版本以 `ls services/api/db/migrations/rollback/*.sql` 的实测为准，本文件不写死号段），
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
| U0d | **提供子账号 S 的（只读）凭据，或在子账号 S 控制台内代为操作** | 我们只有父账号 P 的只读视角，**对子账号 S 名下的 VPC/CVM/入站规则没有视角**，无法核对与验证 |
| U0e | **确认承载 PG 的服务器是标准 CVM（不是 Lighthouse）**，并加入 `10.21.0.0/16` 的 VPC/子网 | 官方明确 **Lighthouse 不支持自定义 VPC**（"网络由系统自动创建并分配"）⇒ 它**不在目标 VPC 内**，云托管"私有网络"绑不到它；未找到"轻量↔云托管"的内网依据（[README.md](README.md) §2.5）。**这直接决定方案 A 是否成立** |
| U1 | （在**子账号 S** 内）创建 **VPC（`10.21.0.0/16`）+ 子网** 与 **标准 CVM**，地域 `ap-shanghai` | 涉及账号与付费；本单明确不购买、不创建资源（父账号 P 实测 0 台 CVM）。**这是当前最靠前的待办**。⚠️ **不要**在父账号 P 里为子账号 S 的环境新建 VPC；也**不要**改动父账号 P 的 `gengyun-vpc` |
| U2 | 创建并挂载云硬盘（承载 `/data/gengyun/pgdata`） | 同上 |
| U3 | 配置**入站规则**：标准 CVM 用**安全组**、Lighthouse 用**实例防火墙** —— 放行 `5432`，来源仅 `10.21.0.0/16`，关闭公网 | 入站规则在账号侧；脚本无云凭据，无法读取或修改；**子账号 S 无视角**。⚠️ Lighthouse 防火墙**来源默认 `0.0.0.0/0`**，且**只控入流量**（[README.md](README.md) §2.5） |
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
| API `category=connection_failed`（`ECONNREFUSED`） | 没监听该地址 / 入站规则挡了 | `ss -ltn "sport = :5432"`、`SHOW listen_addresses` | 修 `listen_addresses`；用户核对**入站规则**（标准 CVM=安全组；Lighthouse=实例防火墙，其来源默认 `0.0.0.0/0` 需收紧） |
| 云托管侧**始终连不上**内网库，但本机 `psql` 正常 | ① PG 所在服务器**不在云托管可绑定的那张 VPC 内**（例如装在 Lighthouse 上）；② 或路径选择/绑定的 VPC 不对 | 服务器形态与所属 VPC（控制台）；`ip -4 -o addr` 是否为 `10.21.x.y` | 按 [README.md](README.md) §2.5：把 PG 放到**标准 CVM + `10.21.0.0/16` VPC**，并让云托管绑定该 VPC。**这不是 `pg_hba`/安全组能修的** |
| 报错里出现 `…/roles/0` 或其它**奇怪的文件名** | 清单变量被 bash 保留名覆盖（历史缺陷：`GROUPS`） | `grep -n 'ROLE_GROUP_FILES' deploy/postgres-cvm/provision-db.sh` | 返修 10 已改名修好；若你用的是旧副本，请更新到含 `ROLE_GROUP_FILES` 的版本 |
| `psql: error: /home/…/xxx.sql: Permission denied`（**仓库文件**读不了） | 仓库在 `postgres` 不可穿越的目录（如 `/home/<user>` 默认 `0750`） | `namei -l <仓库路径>` | 返修 10 起脚本会把 SQL **暂存**到 postgres 可读的临时目录；若仍报错，说明用的是旧副本。**不要** `chmod 777` |
| API `category=database_missing`（`3D000`） | 库名写错或库没建 | `\l` 等价查询 | 用 `gengyun`（或 `GENGYUN_DB_NAME` 指定的一致名字） |
| API 报 `42501 permission denied` | 角色引导没跑或跑在错误的库上 | `verify-cvm-postgres.sh` 的 `least_privilege_assert`、`runtime_can_read_*` | 跑 `provision-db.sh` |
| API 报 `42501`，且库里明确是 `permission denied for table admin_accounts`（INSERT） | **首次元权限引导（seed）没跑**——第一个管理员不是 API 建的，是部署档建的 | `SELECT count(*) FROM public.admin_accounts`（=0 即从未引导）；`verify-cvm-postgres.sh` 的 `bootstrap_audit_exactly_one` | 跑**步骤 3.5**（`sql/30-bootstrap-admin.sql`，属主身份、一次性）。⛔ 再跑 `provision-db.sh` 不会补这一行 |
| `90-assert` 输出"警告：未找到 public.schema_migrations 台账" | 该库的迁移**不是用 `migrate.ts` 应用的**（例如用 `psql -f` 手工应用） | `SELECT to_regclass('public.schema_migrations')` | 在**目标 CVM** 上这属异常：用 `DATABASE_URL=… node services/api/src/db/migrate.ts up` 应用迁移。**等价复核环境**（只有套接字、node-postgres 不可用）里此告警属预期，15 项断言照常执行，见 [verify-socket-only-equivalents.md](verify-socket-only-equivalents.md) |
| `90-assert` 输出"错误：…的硬前置未满足" | 7 个业务关系 / 运行时角色 / 5 组有缺失 | 输出里的三步指引 | 按序补：`install-postgres.sh` ⇒ `migrate.ts up` ⇒ `provision-db.sh` |
| `pg_hba_file_rules` 有 `error` | 手改坏了配置 | `SELECT * FROM pg_hba_file_rules WHERE error IS NOT NULL` | 从 5.0 的备份恢复（5.1） |
| `migrate.ts` 报 drift | 磁盘上的迁移文件被改过 | `migrate.ts status` | 不要继续；恢复被改的文件到与 HEAD 一致 |
| 备份文件为 0 字节或 `pg_restore --list` 失败 | 备份过程被打断/磁盘满 | `backup-postgres.sh --list`、`df -h` | 当次备份**不算数**，修好后重跑 |
| 恢复演练 `PASS=n FAIL>0` | 备份与清单不一致或恢复报错 | 演练输出里的逐行期望/实际 | 按失败判据处理；**不得**宣称备份可用 |
| 验证脚本退出码 `2` | 缺项（口令/备份/远端探针） | 输出里的 `SKIP` 行 | 补齐后重跑，别把 `2` 当通过。**本项目 2026-10-13 的那次 `SKIP`（远端 VPC 探针）已由平台侧实测满足**（[evidence §15](evidence/local-self-check.md)）；语义不变，有探针机时用 `--remote-host` 复跑取 `PASS` |

## 附录 A 本文件**不**覆盖的步骤（如实登记缺口）

> **位置说明**：本节刻意放在**文末**而不是正文中间——插在中间会让其后所有行号位移，而 `docs/verification/` 下有多处按行号引用本文件的**冻结证据**（例如 `gy-i19-backup-domain-20261018.md` 引用本节之前的 U9 行）。放在末尾，正文行号逐行不变。

本文件从"机器已经在手、可以开始装库"写起。下面四件事**仓库里没有产物，本文件也不教怎么做**。
照着本文件一路做到底，得到的是一台能连的 PostgreSQL 加一套迁过的 schema，**不是"已在生产提供服务的 API"**：

| 缺口 | 仓库现状（可自行复核） | 后果 |
| --- | --- | --- |
| **把代码放到执行机** | `git clone` / `scp` / `rsync` 在 `deploy/`、`docs/release/` 下**零命中**：没有分发产物，也没有目标路径约定 | 执行机上不会有 `services/api/`，正文所有 `node …` 命令都无从执行 |
| **给 API 一个常驻载体** | 全树没有 API 的 `systemd` unit、`pm2` ecosystem 或 compose 文件（现存的 unit 只服务 PostgreSQL 与清理任务）；正文步骤 5 只有**前台** `npm run start` | shell 一退出 API 就随之结束：没有重启策略、没有开机自启、没有日志轮转 |
| **CI 无部署流水线** | `.github/workflows/` 下所有 workflow 的触发只有 `pull_request` / `push`；全仓 `secrets.*` **零处**，`ssh` / `scp` / `rsync` / `kubectl` / `gcloud` / `ansible` / `terraform` 等部署工具**零处** | 没有"合并即上线"这回事；上线只能人工做，且仓库里没有凭据交接路径 |
| **迁移是纯手工步骤** | API 启动**不会**自动执行迁移（[../cloudrun/README.md](../cloudrun/README.md) §5.1：`server.ts` 不调用 `applyMigrations`） | 任何"部署完自然就迁了"的假设都不成立；漏掉步骤 2 就是缺表/缺视图的 500 |

⇒ 这四项要么需要先拍板形态（进程载体、分发方式、凭据通道），要么属于尚未建立的能力。
本文件**不**替业主选形态，也不含任何可直接执行的部署脚本；真要做部署，须在这四项各自定下来之后另行登记步骤。
