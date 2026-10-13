# 目标 CVM 上的 PostgreSQL 17：技术准备物

> **交付状态声明（先读这一段）**
>
> - 本目录是**技术准备物**（脚本 + 配置片段 + Runbook + 判定标准），**不是部署成果**。
> - **未部署**：没有在目标 CVM 上安装过 PostgreSQL，没有创建过任何云资源，没有连接过任何真实数据库。
> - **未验收**：没有真实备份、没有真实恢复演练、没有真实业务冒烟、没有安全组核对。
> - ⚠️ **结构性风险：适用**（详见下文 **§0**）——
>   微信云托管环境 `prod-d1g6qe87c4f2d7061` 属**子账号 S**，`gengyun-vpc` 属**父账号 P**，**S ≠ P**
>   ⇒ 把 PostgreSQL 建在**父账号 P** 的该 VPC 里**结构上很可能连不通**（不是调参问题）；
>   目标形态因此分**两条并列路径**（A 推荐：子账号 S 内建网；B：父账号 P 的 VPC + 跨账号互通，**未找到依据**）。
>   **在账号边界/路径确定之前，不得创建任何资源。**
> - **本机（写手环境）**：只做了 `bash -n`、**桩化回归**、Markdown/链接与行尾校验；本机**没有 PostgreSQL/Docker/云凭据**，
>   所以本机**不能**产出"已部署"级证据。原始输出见 [evidence/local-self-check.md](evidence/local-self-check.md) §1–§11。
> - **已由指挥在真实环境真跑**（在用户授权的目标 CVM 上；全程无变通；**监工尚未复核**），并**按脚本 `sha256` 与 SHA `939670c` 绑定**（[evidence §12](evidence/local-self-check.md)）：
>   * 目标 CVM（Ubuntu 22.04 ／ 内网 `10.21.1.8` ／ 数据盘 `/dev/vdb → /data`）：
>     `install-postgres.sh` **`INSTALL_EXIT=0`**；只监听 `127.0.0.1:5432` 与 `10.21.1.8:5432`；
>     **收尾硬校验通过**；私密目录 `/etc/gengyun` = `drwxr-x--- root:postgres` 且 `postgres` **两级 `test -x` 通过**；
>   * `migrate.ts up` **`exit=0`**（`0001…0010`）；`provision-db.sh` **`exit=0`**（**家目录保持 `0750`**：无 `Permission denied`、无 `roles/0`；
>     5 组 + `20-login-roles.sql` + 90- 断言 `ok`）；复核 `migrations=10`／`tables=41`／`groups=5`／`login=true super=false`；
>   * `backup-postgres.sh` **`exit=0`**；`restore-drill.sh --recreate` **`exit=0`、`PASS=24 FAIL=0`、结论「恢复演练【通过】」**；
>   * `verify-cvm-postgres.sh`（带运行时口令环境变量）**`PASS=39 FAIL=0 SKIP=1`（`exit=2`）**。
> - **唯一剩余缺项（不得写成通过）**：`verify` 的 **`SKIP remote_vpc_tcp_open`** ——
>   **云托管实例 → `10.21.1.8:5432` 的真实连通未测**（需用户 webshell 探活，或 API 部署后用业务冒烟证明）。
>   ⇒ **`verify exit=2` = 无失败但证据不完整**；**`backup exit=0` 也不等于"可恢复"**（可恢复性只认 `restore-drill exit=0`）。
> - **仍不成立的说法**：本交付**未部署、未验收（整项）**；云托管侧联调、公网 5432 的最终关闭核对、
>   重启持久性外的灾备项（PITR/异地）等见第 6 节。
> - **脚本完成 ≠ 已部署**；"已部署/已验收"必须按 [verify-checklist.md](verify-checklist.md) 真跑、留原始输出，
>   并与具体 SHA／脚本指纹绑定。
> - 密钥不存在于本目录任何文件中：口令只从环境变量或主机上的私密文件读取，
>   交接方式见 [runbook.md](runbook.md) 第 2 节。**不要把口令贴进聊天、仓库、PR 或文档。**
>
> 关联：用户清单第 3 项；GitHub `Refs #27`（GY-I25，正式 AppID／真机域名／AI 与数据库服务接入的提前验证）。
> **本 PR 为"数据库部署准备 + 真机证据"，`Refs #27` 但明确不关闭整项 #27**（`Closes/Fixes/Resolves` 均为 0）。
> 执行者归属与"外部读者无法自核的部分"见 [evidence §13](evidence/local-self-check.md)。
> 基线：`upstream/main` = `b1f6ab0e4dc304d2dd621d6a20852b31ccbfab3e`（2026-10-13 11:27:33 +0800）。

## 0 结构性前提：账号边界、目标形态与授权门禁

> **一句话现状**：微信云托管环境所属的**子账号 S** 与 `gengyun-vpc` 所属的**父账号 P**
> **不是同一个账号** ⇒ **"账号不同"这条结构性风险重新变为适用**：把 PostgreSQL 建在
> **父账号 P** 的 `gengyun-vpc` 里，**结构上很可能连不通**。因此**目标形态必须按两条并列路径重述**（§0.4），
> 且**授权门禁仍然有效**（§0.6）。这也**推翻了**此前基于"同一账号"作出的"风险不适用"结论。

**账号别名约定**：为避免把账号标识值写进仓库，本目录统一用角色别名；数字 ID 保留在私密留档。

| 别名 | 指代 | 我们与它的关系 |
| --- | --- | --- |
| **父账号 P** | `gengyun-vpc`（`vpc-h33f1h5a`，`10.20.0.0/16`，上海）所属账号 | **仓库现有两份只读凭据都是它的** ⇒ 我们**对它有只读视角** |
| **子账号 S** | 微信云托管环境 `prod-d1g6qe87c4f2d7061` 所属账号，是**父账号 P 的子账号** | **我们没有它的凭据视角** ⇒ 其名下 VPC／子网／CVM／安全组对我们**不可见** |

### 0.1 证据分层（谁观察到什么）

| 层级 | 来源 | 内容 | 本单写手的动作 |
| --- | --- | --- | --- |
| **一手 · 用户提供** | **用户本人**（控制台／账户信息），经指挥转述 | 云托管环境 `prod-d1g6qe87c4f2d7061` 绑定的是**子账号 S**，且 S 是**父账号 P 的子账号**；`gengyun-vpc` 在**父账号 P** 名下 | **未复现**（本单无凭据）；只记录结论与结构关系，**不记录账号 ID** |
| **二手 · 另一位写手只读调用** | 另一位写手用 `E:\GengYunPrivate` 私密凭据做**只读**调用（未创建任何资源），经指挥转述 | §0.2 的表格 | **未复现**；**本单写手全程零云调用** |
| **官方文档（本会话唯一可达的两页）** | [CloudBase 云托管 · 服务设置](https://docs.cloudbase.net/run/deploy/service-setting)、[CloudBase 云托管 · 使用限制](https://docs.cloudbase.net/run/limitation) | 见 §0.3「证据状态」 | 本会话**检索通道不可用**，只能逐页核对 ⇒ 这**不是**穷尽检索，**不得**当作"官方已确认" |

> **标识值口径**：账号 ID、凭据指纹等标识值按与凭据同级的私密性处理，**保留在私密留档**，
> **不写入本仓库、本目录、PR 正文或提交信息**（依据本单指令"不写账号 ID 进仓库／PR"）。

### 0.2 已实测的云侧事实（二手 · 只读；凭据视角 = **父账号 P**）

| 观测项 | 结果 | 含义 |
| --- | --- | --- |
| 两个凭据文件 | 属**同一账号**（= **父账号 P**） | **我们只有父账号 P 的视角**；对**子账号 S 无视角** |
| VPC `gengyun-vpc`（`vpc-h33f1h5a`，`10.20.0.0/16`） | 在**父账号 P** 上海地域可见，且是其上海**唯一** VPC | 该 VPC **属于父账号 P**，**不属于子账号 S** |
| 子网 | 1 个 `/24`（`ap-shanghai-1`），可用 IP **253** | IP 充足 |
| `cvm DescribeInstances @ap-shanghai` | **0 台** | 父账号 P 上海无 CVM；**子账号 S 未观测（无视角）** |
| `cvm DescribeSecurityGroups` | **0 个** | 父账号 P 无安全组；**子账号 S 未观测（无视角）** |
| `tcb DescribeEnvs`（上海／广州） | **0 个环境** | 与"环境在**子账号 S**、父账号 P 视角看不到它"**一致**（此处不再作为"账号错配"的推断依据，账号结构已由 §0.1 一手确认） |

### 0.3 结构性风险：**适用**（账号边界问题，调参解决不了）

**事实（一手 · 用户提供）**：云托管环境属**子账号 S**；`gengyun-vpc` 属**父账号 P**；**S ≠ P**。

**推断（按用户／指挥陈述的机制）**：云托管为服务选择私有网络时，候选网络**只来自该环境所属账号**
⇒ 把 PostgreSQL 建在**父账号 P** 的 `gengyun-vpc` 里，**结构上很可能连不通**。
这不是安全组、不是 `pg_hba`、不是 `listen_addresses` 的问题——**换参数不会变通**。

**证据状态（如实标注，不夸大成"官方已确认"）**：

- 上述"候选只来自环境所属账号"这一机制，目前**来自用户／指挥的陈述**；**本单未能取得官方文档依据**。
  本会话的**检索通道不可用**，只能逐页核对仓库既引用的官方页，而这两页**均未记载** VPC／私有网络绑定：
  - [CloudBase 云托管 · 服务设置](https://docs.cloudbase.net/run/deploy/service-setting)：
    "网络相关设置"只写了**公网开关及域名**与**内网开关及域名（同环境内服务互访）**，
    **未记载** VPC 绑定、私有网络选择或跨账号网络；页首标注**支持地域：上海**。
  - [CloudBase 云托管 · 使用限制](https://docs.cloudbase.net/run/limitation)：
    明确写有"**云开发多个环境之间所有资源都互相隔离**""**不同环境的资源之间只能使用公网调用**"；
    页首同样标注**支持地域：上海**。（该条讲的是**环境**隔离而非**账号**边界，方向上是**支持**保守判断的旁证，
    但**不能**直接推出账号边界的结论。）
- ⇒ **跨账号私有互通（路径 B）"未找到依据"**：本交付**没有找到**任何官方依据支持
  "云托管环境可绑定／访问**其它账号**的 VPC 或子网"，也**没有找到**"子网共享"的官方依据。
  这一条**必须由用户在控制台或工单确认**，本目录**不替它下结论**。
- **处理口径**：风险**按"适用"处理并据此暂停动手**（保守优先），同时把"机制的依据不足"写清楚，
  避免把未经核实的行为当成已知事实。**若用户在控制台确认了互通能力，再据实修正本页。**

### 0.4 目标形态重述：两条并列路径

原目标是"**同账号、上海、`gengyun-vpc` 下的 CVM**"。现在"同账号"必须理解为
**与环境同属的账号**，即**子账号 S**。据此重述为两条并列路径，**用户已选定路径 A**：

| | **路径 A（✅ 用户已选定）** | **路径 B（未采用，保留为历史）** |
| --- | --- | --- |
| 网络建在哪 | 在**子账号 S** 内新建 **VPC + 子网**；**CIDR 已定为 `10.21.0.0/16`**（与父账号 P 的 `10.20.0.0/16` **不重叠**） | 仍用**父账号 P** 的 `gengyun-vpc`（`10.20.0.0/16`） |
| CVM／PG 建在哪 | **子账号 S** 内（**⚠️ 必须是标准 CVM，见 §2.5**） | **父账号 P** 内 |
| 云托管侧 | 环境本就属子账号 S ⇒ **同账号**，可直接绑定该 VPC ⇒ **结构上可信** | 环境属子账号 S，却要访问父账号 P 的 VPC ⇒ **必须跨账号私有互通**（对等连接／云联网 CCN，**是否支持该形态：未找到依据**），**且** CloudRun 侧仍需在**子账号 S** 内有可绑定的 VPC／子网 |
| 本交付脚本 | **已按 §0.5 完成网段变更**（`10.20.0.0/16` → `10.21.0.0/16`） | 若回退到本路径需再改回（§0.5 保留步骤） |
| 评价 | **已选定**：同账号、边界清晰、不引入跨账号私有互通的不确定性 | **在拿到官方依据前不要按此路径动手** |
| 破坏性风险提示 | 在子账号 S 内建网属新建资源，需授权与预算 | **换绑**云托管环境（把环境改到父账号 P）是绝对禁止项：官方明确**必须销毁当前所有环境且不可恢复** |

**父账号 P 的 `gengyun-vpc`（`vpc-h33f1h5a`，`10.20.0.0/16`）在本路线下不用于承载 PG**：
**保留不动、不重建、不删除**，也不要在它里面为子账号 S 的环境新建 VPC（§0.6 第 2 条）。

### 0.5 网段变更：**已按用户选定方案 A 完成** `10.20.0.0/16` → `10.21.0.0/16`

**变更原因**：用户选定**方案 A**（在子账号 S 内建网）⇒ 目标网段不再使用父账号 P 的 `10.20.0.0/16`，
改为**不与它重叠**的 `10.21.0.0/16`。本次变更是**用户授权**的脚本/配置改动（不是重构）。

**为什么必须"四处同改"**：目标网段**写死在四处**（脚本常量 + 配置模板 + 校验判据 + 文档示例），
漏掉任何一处都会自相矛盾：

- 漏改 `conf/pg_hba.gengyun.conf` ⇒ 新网段的 CVM **连不上**（`pg_hba` 里没有新网段规则）；
- 漏改 `verify-cvm-postgres.sh` ⇒ `hba_vpc_rules`、`vpc_tcp_open` 等判据**永远 FAIL**（判据还在看旧网段）；
- 漏改 `install-postgres.sh` ⇒ 脚本在接口上**找不到新网段内的私网 IP**，直接拒绝执行；
- 漏改文档 ⇒ 用户按旧网段配**入站规则**（安全组／Lighthouse 防火墙），与 `pg_hba` 不一致。

| # | 位置 | 变更前 | 变更后（已完成） |
| --- | --- | --- | --- |
| 1 | `install-postgres.sh` **第 51 行** `VPC_CIDR` | `'10.20.0.0/16'` | **`'10.21.0.0/16'`**（仍须 /16；脚本对非 /16 明确失败，见 **第 140 行**）。同处 **第 52／53 行** `VPC_NAME`/`VPC_ID` 改为方案 A 表述；**第 10／11 行**头部注释改方案 A 并保留父账号 VPC 为历史；**第 152–155 行**失败提示改为"加入方案 A 目标 VPC 的对应子网" |
| 2 | `conf/pg_hba.gengyun.conf` **第 32／34／38 行** | 三处 `10.20.0.0/16` | **三处 `10.21.0.0/16`**（两条 `host` 授权 + 一条网段内 `reject`）；**第 8–10 行**注释补 Lighthouse 防火墙；**第 14–16 行**三者一致表改为目标网段 + 入站规则 |
| 3 | `verify-cvm-postgres.sh` **第 40／41 行** 与 **第 148 行** | `VPC_CIDR='10.20.0.0/16'`、`VPC_PREFIX='10.20'`、`address = '10.20.0.0'` | **`10.21.0.0/16`、`10.21`、`'10.21.0.0'`**（netmask 仍 `255.255.0.0`）；**第 8–10 行**前置注释、**第 14 行**示例 `--remote-host 10.21.1.9`、**第 276／277 行**两项 `manual` 同步 |
| 4 | 文档与注释：`README.md`（§0.4、§0.5、§2.1、§2.2、**§2.5**、**§2.6**、§4 P0b/P1/P4、§6、§7）、`runbook.md`（§0、§1、§3、§6、§7）、`verify-checklist.md`（§0、§3、§4、§9、§10）、`install-postgres.sh` 头部注释、`conf/10-gengyun-postgres.conf` **第 12／16／18 行**、`verify-cvm-postgres.sh` 头部注释 | 示例 IP `10.20.x.y` 与判读表 | 逐处改为 `10.21.x.y` 与「目标网段」表述；**父账号 `10.20.0.0/16` 作为历史记录保留**在 §0.1／§0.2／§0.4 与脚本注释里（**不要**把这些历史值一起替换） |

> **本次变更与"子网数量"无关**（见 §2.6）：四处用的是 **VPC 网段 `10.21.0.0/16`**，
> 它**天然覆盖 `10.21.0.0/24` 与 `10.21.1.0/24` 两个子网**；因此 **5432 的来源规则仍写 `10.21.0.0/16`**，
> **不需要**因为"多了一个子网"而扩大或改写这四处。

**若将来还要再改网段**（本次已验证的步骤，保留备查）：

```bash
# 0) 先定新 CIDR：不得与目标网段或父账号 10.20.0.0/16 重叠；必须是 /16（脚本限制）
NEW_CIDR='10.22.0.0/16'
NEW_PREFIX='10.22'

# 1) 改前先看全（避免漏改；注意"历史记录"里的 10.20 属有意保留，不要一起替换）
grep -rn '10\.2[01]' deploy/postgres-cvm/ --include='*.sh' --include='*.conf'
grep -rn '10\.2[01]' deploy/postgres-cvm/*.md deploy/postgres-cvm/evidence/*.md

# 2) 四处同改（脚本常量 + 配置模板 + 校验判据 + 文档）
sed -i "s|10\.21\.0\.0/16|${NEW_CIDR}|g" \
    deploy/postgres-cvm/install-postgres.sh \
    deploy/postgres-cvm/verify-cvm-postgres.sh \
    deploy/postgres-cvm/conf/pg_hba.gengyun.conf
sed -i "s|VPC_PREFIX='10\.21'|VPC_PREFIX='${NEW_PREFIX}'|" deploy/postgres-cvm/verify-cvm-postgres.sh
sed -i "s|10\.21\.x\.y|${NEW_PREFIX}.x.y|g" deploy/postgres-cvm/*.md deploy/postgres-cvm/evidence/*.md

# 3) 改后必须复跑（本次实际执行的检查）
grep -rn '10\.21' deploy/postgres-cvm/ --include='*.sh' --include='*.conf' || echo "旧网段已清零"
bash -n deploy/postgres-cvm/*.sh
grep -n "VPC_CIDR=\|VPC_PREFIX=" deploy/postgres-cvm/*.sh
sudo deploy/postgres-cvm/install-postgres.sh --plan    # 预期输出见 runbook §0/§3
```

> **两点必须注意**：
> ① 这是一次**改脚本**的变更，已按用户/指挥**单独授权**执行；改完的检查结果记在
> [evidence/local-self-check.md](evidence/local-self-check.md) §6 与 PR 正文。
> ② 更彻底的做法是把 `VPC_CIDR` 变成安装脚本的一个环境变量（只留一处），但那同样是脚本改动，
> 而且要同时处理 `pg_hba` 模板替换与 `verify` 的两个常量；**本次不做，留作后续单独任务**（不做顺手重构）。

### 0.6 授权门禁（**与账号条件无关，仍然适用**；本单新增一条）

1. **未取得用户对具体动作的明确授权之前：不要创建 CVM、不要建库、不要购买任何资源包、不要改动 VPC。**
   （**注意**：用户"选定方案 A"是**路线决策**，不等于授权任何人去创建资源；本单**仍未创建、未购买**任何云资源。）
2. **本单新增**：**不要在父账号 P 里"为子账号 S 的环境"新建 VPC。**
   父账号里的新 VPC 仍然不在子账号 S 名下，**解决不了互通问题**，只会多出一份要维护与计费的资源。
   若走**路径 A**，VPC **必须建在子账号 S 内**。
3. **本单新增**：**不要改动、重建或删除父账号 P 的 `gengyun-vpc`**——它在本路线下不使用，
   保留原样（§0.4 末段）。
3. **换绑绝对禁止**：把云托管环境改到父账号 P，官方明确**必须销毁当前所有环境且不可恢复**
   （见 §0.4 最后一行）。

账号结构本身**不是**"可以动手"的授权；本单授权范围始终只有"交付技术准备物"，**不含**创建／购买／部署。

### 0.7 资源与凭据视角（含需用户提供项）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| **子账号 S 的（只读）凭据**，或**由用户在子账号 S 控制台内操作** | **需用户提供** | 我们**只有父账号 P 的只读视角**；对子账号 S 名下的 VPC／子网／CVM／安全组**没有视角**，无从核对与验证 |
| 账号边界（S ≠ P）与"环境绑定在 S" | **✅ 已由用户提供（一手）** | §0.1 |
| 路径 A／路径 B 的选择 | **待用户决策** | §0.4；本单不选 |
| 跨账号私有互通／子网共享是否有官方依据 | **未找到依据** | §0.3；需用户控制台或工单确认 |
| CVM 已创建并加入目标 VPC | **未满足** | 父账号 P 实测 **0 台**；子账号 S **无视角** |
| 独立云硬盘已创建并挂载 | **未核实** | — |
| 安全组入站 5432 仅目标网段 | **未满足** | 父账号 P 实测 **0 个**；子账号 S **无视角** |
| 两个 48 位十六进制口令已私密交接 | **未交接** | 脚本必需输入 |

**⇒ 仍不能进入"部署"阶段**：账号边界未解决（或路径未选定）、目标侧资源未创建、
子账号无凭据视角、口令未交接。待上述条件满足**且用户给出授权**后，
`install-postgres.sh` / `provision-db.sh` / `backup-postgres.sh` / `restore-drill.sh` / `verify-cvm-postgres.sh`
才具备执行条件。

## 1 本目录内容

| 文件 | 作用 | 是否已运行 |
| --- | --- | --- |
| [install-postgres.sh](install-postgres.sh) | 目标 CVM 上安装 PostgreSQL 17.11、在持久云硬盘上 initdb、安装网络配置、启动 | **已在目标 CVM 真跑通过**：`INSTALL_EXIT=0`、收尾硬校验通过、私密目录逐级可穿越（[evidence §12](evidence/local-self-check.md)） |
| [provision-db.sh](provision-db.sh) | 迁移之后：建角色组、建最小权限运行时 LOGIN、跑最小权限断言 | **已在目标 CVM 真跑通过**：`exit=0`，家目录保持 `0750` 下无 `Permission denied`、无 `roles/0`；90- 断言 `ok`（[evidence §12](evidence/local-self-check.md)） |
| [sql/20-login-roles.sql](sql/20-login-roles.sql) | 运行时 LOGIN 的创建（仅缺失时）/属性收敛/口令（默认不改）/组成员授予 | **已由外部真实 PG 17.11 执行通过**（首跑 `exit=0`、重复执行幂等） |
| [sql/90-assert-least-privilege.sql](sql/90-assert-least-privilege.sql) | 只读最小权限断言，输出 `ok` 或 `FAIL: …`；前置分硬/软两级 | **已由外部真实 PG 17.11 执行通过**（末行 `ok`，15/15） |
| [backup-postgres.sh](backup-postgres.sh) | 逻辑备份 `pg_dump -Fc` + 产出清单 + 保留期清理；**退出码语义见文件头** | **已在目标 CVM 真跑**：`exit=0`、dump 与 manifest 均产出（[evidence §12.2](evidence/local-self-check.md)）；本机另有改前/改后回归（[evidence §11.2](evidence/local-self-check.md)） |
| [restore-drill.sh](restore-drill.sh) | 隔离库恢复演练 + 逐项判定（**保留完整输出并按致命/非致命分类**） | **已在目标 CVM 真跑通过**：`exit=0`、`PASS=24 FAIL=0`、结论「恢复演练【通过】」——**这是"备份可恢复"的唯一证据**（[evidence §12.2](evidence/local-self-check.md)） |
| [verify-cvm-postgres.sh](verify-cvm-postgres.sh) | 资源就绪后的验证清单（可执行） | **已在目标 CVM 真跑**：`PASS=39 FAIL=0 SKIP=1`（`exit=2`，缺项 = 远端 VPC 探针）；本机另有桩化回归（6 条判据转 PASS，[evidence §10.3](evidence/local-self-check.md)） |
| [verify-checklist.md](verify-checklist.md) | 每条判据的期望输出与判读方式 | 文档 |
| [roles-and-migration.md](roles-and-migration.md) | 角色用途/授予范围/验证命令；迁移执行与顺序 | 文档 |
| [runbook.md](runbook.md) | 部署与运维步骤、回滚、仅用户本人可做清单 | 文档 |
| [conf/10-gengyun-postgres.conf](conf/10-gengyun-postgres.conf) | `postgresql.conf` 片段（监听、端口、socket、口令加密、日志） | 否（模板，含占位符） |
| [conf/pg_hba.gengyun.conf](conf/pg_hba.gengyun.conf) | 客户端认证：仅回环 + VPC 网段，无 `0.0.0.0/0` | 否（模板） |
| [conf/pg_ident.gengyun.conf](conf/pg_ident.gengyun.conf) | 系统用户 `postgres` → 数据库用户 `gengyun_cvm_owner` 映射 | 否（模板） |
| [conf/gengyun-postgresql.service](conf/gengyun-postgresql.service) | 专用 systemd 单元（数据目录在持久盘） | 否（模板） |
| [evidence/local-self-check.md](evidence/local-self-check.md) | 本地可做/不可做的自检原始输出；§4／§12 为**真机证据**（由指挥执行） | 已有原始输出（真机部分**由指挥执行并回传**；监工尚未复核） |
| [verify-socket-only-equivalents.md](verify-socket-only-equivalents.md) | **外部复核用**：在"只有套接字、无 root/systemd"的环境里复现关键动作的等价命令（**不是部署路径**） | 文档（本单未执行） |

> **传送到 CVM 时的行尾注意**：本目录的脚本/配置在 Git 索引里都是 **LF**（`git ls-files --eol` 显示
> `i/lf w/lf`），`bash` 在 Linux 上可正常执行。但本仓库的 Windows 检出配置为
> `core.autocrlf=true`，**在 Windows 上重新 checkout 会把工作区文件变成 CRLF**。
> 因此把脚本拷到 CVM 后，先验证一次再执行：
>
> ```bash
> grep -lU $'\r' deploy/postgres-cvm/*.sh && echo "发现 CRLF：先 dos2unix 或 sed -i 's/\r$//'" || echo "行尾 OK(LF)"
> bash -n deploy/postgres-cvm/install-postgres.sh && echo "语法 OK"
> ```
>
> 本交付**没有**添加 `.gitattributes`（那属于 `deploy/postgres-cvm/**` 之外的改动），
> 所以这条只能靠操作时自查。

## 2 目标形态（**用户已选定方案 A**，见 §0.4）

> ⚠️ 本节已按 §0 的更正与用户决策重述：**"同账号"现在指与环境同属的「子账号 S」**，
> 而不是 `gengyun-vpc` 所在的「父账号 P」；**路径 A 已被用户选定**，路径 B 保留为历史（未采用）。

### 2.1 资源与地域

| 项 | **路径 A（✅ 已选定）** | 路径 B（未采用，历史） | 来源 |
| --- | --- | --- | --- |
| 云账号 | **子账号 S**（与环境同账号） | 父账号 P（VPC 侧）+ 子账号 S（云托管侧） | 用户清单第 3 项的"同账号"按 §0.4 重述 |
| 地域 | `ap-shanghai`（上海） | `ap-shanghai`（上海） | 用户清单第 3 项 |
| VPC | **在子账号 S 内新建**，**CIDR 已定 = `10.21.0.0/16`**（与父账号 `10.20.0.0/16` 不重叠） | 父账号 P 的 `gengyun-vpc`（`vpc-h33f1h5a`，`10.20.0.0/16`） | 用户决策 / 既有资源 |
| 子网 | **两个子网**（用户所定，ID 待回传）：`10.21.0.0/24` @ `ap-shanghai-1`、`10.21.1.0/24` @ `ap-shanghai-2` | 父账号 P 的 `ap-shanghai-1`（`/24`） | 用户告知（见 §2.6） |
| 服务器形态 | **标准 CVM**（⚠️ **不能是 Lighthouse**，见 §2.5） | 同 | 用户清单第 3 项 + §2.5 的官方依据 |
| 数据库 | PostgreSQL **17.11** | 同 | CI 固定标签，见 2.3 |
| 数据目录 | 独立持久云硬盘上的 `/data/gengyun/pgdata` | 同 | 本交付设计（可用 `GENGYUN_PGDATA` 覆盖） |
| 业务库名 | `gengyun` | 同 | 本交付设计（**新引入的命名**，见 2.4） |
| 本交付脚本 | **已按 §0.5 完成网段变更**（`10.20.0.0/16` → `10.21.0.0/16`） | 若回退需再改回 | — |

要求是"**目标为同账号、上海、上述 VPC 下的 CVM**"。按 §0 更正后，"同账号"= **子账号 S**
⇒ 该句在**路径 A** 下成立（VPC 建在子账号 S），在路径 B 下**不成立**（VPC 在父账号 P）。
本交付按 **CVM 自建 PostgreSQL** 设计（不是腾讯云托管 PostgreSQL）。
是否已购买/创建该 CVM **尚未核实**（父账号 P 实测 0 台；**子账号 S 无视角**）；脚本不会尝试创建它。

### 2.2 网络姿态：PostgreSQL 只供内网访问，不开放公网 5432

三处配置必须互相一致，任何一处偏差都等于"公网可达"或"内网不可用"。
**目标网段 = `10.21.0.0/16`**（方案 A，§0.5 已完成变更）。

| 层 | 目标状态 | 由谁保证 | 本交付能否核对 |
| --- | --- | --- | --- |
| `listen_addresses` | 只含 `127.0.0.1` 与 CVM 在 `10.21.0.0/16` 内的私网 IPv4；绝不 `*`/`0.0.0.0` | [install-postgres.sh](install-postgres.sh) 自动探测私网 IP 并写入 [conf/10-gengyun-postgres.conf](conf/10-gengyun-postgres.conf)；脚本结束时用 `ss` 自检非通配监听 | 能（脚本内自检 + [verify-cvm-postgres.sh](verify-cvm-postgres.sh) 的 `no_wildcard_listener`） |
| `pg_hba.conf` | 只有回环 + `10.21.0.0/16` 规则；**没有** `0.0.0.0/0`；该网段内其它库/身份显式 `reject` | [conf/pg_hba.gengyun.conf](conf/pg_hba.gengyun.conf)（**已改为 `10.21.0.0/16`**） | 能（`pg_hba_file_rules` 的 `hba_no_default_route` / `hba_vpc_rules`） |
| **入站规则**（标准 CVM = **安全组**；Lighthouse = **实例防火墙**） | 入站 `5432` 来源仅为 `10.21.0.0/16`，**无 `0.0.0.0/0`** | **仅用户本人在控制台配置**（在**子账号 S** 内） | **不能**（脚本无云凭据；且**对子账号 S 连只读视角都没有**）。差异见 §2.5 |

三者的判据、期望值和"怎么算失败"逐条写在 [verify-checklist.md](verify-checklist.md)。

> 注意：`listen_addresses` 与 `pg_hba` 只能保证**进程不监听公网地址**、**公网来源匹配不到认证行**。
> 真正"公网 5432 关不关"取决于**入站规则**，而它在账号侧，**本交付无法也不得代为配置或核对**。
>
> 更要注意（§0.3）：**即使三处配置全对，路径 B 也可能因为账号边界而根本连不通**——
> 那不是配置问题，改参数没用。

### 2.5 服务器形态：**Lighthouse 与标准 CVM 的关键差异**（含"防火墙 vs 安全组"）

> 本节是对此前"只写安全组"的**补漏**，并据官方文档指出一条**会影响方案 A 可行性**的限制。

| 维度 | 标准 CVM | 轻量应用服务器 Lighthouse |
| --- | --- | --- |
| 入站规则叫法 | **安全组** | **实例防火墙**（官方原话：其"安全防护作用**等同于云服务器中的安全组**"） |
| 控制范围 | 安全组规则（入站/出站可分别配） | **防火墙只对实例的入流量进行控制**；**出流量默认允许除 25 端口外的所有请求** |
| 来源默认值 | — | 规则来源**默认 `0.0.0.0/0`**（即对所有 IPv4 开放）⇒ **必须手动改成 `10.21.0.0/16`** |
| 默认放通端口 | 通常仅 22（视镜像/安全组而定） | Linux 镜像默认放通 **22、80、ICMP**；不匹配任何规则则**默认阻止** |
| 规则配额 | 视安全组配额 | 每实例最多 **100** 条防火墙规则 |
| **自定义私有网络 VPC** | **支持**（CVM 可加入指定 VPC/子网） | **不支持**——官方 FAQ 原文："**不支持用户自定义配置私有网络 VPC，网络由系统自动创建并分配**"；且**不支持更换内网 IP**、不支持绑定弹性公网 IP |
| 与其它产品的内网连通 | — | 官方「地域与网络连通性」表：轻量↔**CVM/云数据库/COS/CFS/HAI** 默认**不互通**，需**云联网（CCN）**；**轻量↔轻量（同账号同地域）默认互通**；**不同账号的轻量互访：否** |

**对方案 A 的影响（**必须由用户确认，属决策级**）**：

- 方案 A 的前提是"**在子账号 S 内新建 VPC + 子网 + 服务器，PG 装在该服务器，云托管把服务绑定这张 VPC**"。
- 但 **Lighthouse 不能加入自定义 VPC** ⇒ 若把 PG 装在 **Lighthouse** 上，它**不在 `10.21.0.0/16` 这张 VPC 里**，
  **云托管"私有网络"绑定不到它**（该绑定针对的是账号内的 VPC/子网）。
- 官方连通性表里**没有"轻量 ↔ 微信云托管/CloudBase 环境"这一行**；能查到的是"轻量 ↔ CVM/COS/云数据库/CFS/HAI"
  （且默认不互通、需云联网），**不同账号的轻量互访明确写"否"**。
  ⇒ **"Lighthouse 上的 PG 能被云托管私有网络直连"：本单未找到依据**（不是"已支持"，也不是"已否决"）。
- **本交付的建议**（供用户决策，**本单不替用户决定、不创建资源**）：
  1. **首选**：方案 A 的"服务器"用**标准 CVM**（可加入 `10.21.0.0/16` 的 VPC/子网）——
     这样"云托管绑定该 VPC ⇒ 同账号内网直连"这条链在结构上成立；
  2. 若坚持用现有 Lighthouse 承载 PG：需先在**控制台/工单**确认"该 Lighthouse 与云托管环境之间是否存在受支持的内网路径"，
     并注意它与目标 VPC **不属同一网络平面**；**在拿到依据前不要按这条走**（同 §0.3 的保守口径）。

**与本交付的关系**：本目录的脚本**不关心服务器是 CVM 还是 Lighthouse**（它只处理 PG 的安装与内网姿态），
但**"云托管能否内网到 PG"这条链取决于上面的网络平面差异**；因此 §0.3 的结构性风险**不因选定方案 A 而自动消失**，
它变成了一条**具体的落地前提**：**PG 所在服务器必须在云托管可绑定的那张 VPC 内**。

### 2.6 VPC 下的**两个子网**：对本交付**无影响**（判据写清）

**目标形态（用户告知，2026-10-13）**：子账号 S 内 **VPC `10.21.0.0/16`** 下建**两个子网**：

| 子网 | 网段 | 可用区 |
| --- | --- | --- |
| 子网 A | `10.21.0.0/24` | `ap-shanghai-1` |
| 子网 B | `10.21.1.0/24` | `ap-shanghai-2` |

（名称为用户所定，子网 ID 待用户回传。）

#### ① 对 PG 与四处 CIDR **无影响**（这条判据是本节的重点）

- `install-postgres.sh` / `conf/pg_hba.gengyun.conf` / `verify-cvm-postgres.sh` 用的是 **VPC 网段 `10.21.0.0/16`**；
  该网段**天然覆盖 `10.21.0.0/24` 与 `10.21.1.0/24`** ⇒ **5432 的来源规则仍写 `10.21.0.0/16`**，
  **不需要**因为"多了一个子网"而扩大或改写这四处（§0.5 的变更清单**不因本节而变化**）。
- 结论：**多子网不会引入第二套配置**；本目录**没有**、也**不需要**第二份 `pg_hba` / 第二套脚本参数
  （用户/指挥明确要求不要新建第二套配置）。

#### ② 三条落地约束（逐条一句话）

1. **一台服务器只在一个可用区的一个子网内**——PG 服务器落在哪个子网，取决于创建时选的可用区/子网。
2. **云托管「服务设置 → 私有网络」只能选一个子网**；**选哪个都通**（同一 VPC 内跨子网可路由），
   **建议选 DB 服务器所在的那个子网**（少一跳、少一层不确定性）。
3. **`install-postgres.sh --plan` 只按 VPC 网段匹配本机私网 IP，与选哪个子网无关**。
   **已核对本脚本确实如此**（不是 /24 匹配）：`VPC_PREFIX` 由 `VPC_CIDR` 取**前两段**得到 `10.21`
   （`install-postgres.sh` 第 134–140 行），网卡筛选与地址校验都用
   `^${VPC_PREFIX}\.` 即 **`^10\.21\.`**（第 149、158 行）⇒ **`10.21.0.x` 与 `10.21.1.x` 都能通过**。
   > ⚠️ 该实现**只支持 /16**：若把 `VPC_CIDR` 改成 `/24`，脚本会在第 140 行**明确失败**
   > （"本脚本的网段判定只实现 … 这种 /16 形式"）——这是刻意的保护，不要绕过。

### 2.3 为什么是 17.11（不自行升级/降级）

仓库 CI 里的版本就是权威口径（`.github/workflows/*postgres*.yml`）：

| 工作流 | 镜像 |
| --- | --- |
| `auth-privacy-postgres.yml` | `postgres:17.11` |
| `catalog-postgres.yml` | `postgres:17.11` |
| `consent-grant-postgres.yml` | `postgres:17.11` |
| `source-lifecycle-postgres.yml` | `postgres:17.11` |
| `staging-intake-postgres.yml` | `postgres:17.11` |
| `workbook-staging.yml` | `postgres:17` |

结论：主版本 = **17**；多数门禁固定在 **17.11**。因此本交付：

- 只安装 `17.11`（PGDG apt 仓库中按 `17.11-` 前缀精确匹配包版本）；
- 找不到 `17.11` 时**明确失败并列出可用候选**，绝不擅自换成别的 minor；
- 安装后用 `psql --version` 校验实际版本，主版本或 minor 不符即失败。

### 2.4 业务库名 `gengyun` 是新增命名（需评审确认）

仓库既有数据库名只在测试与本地开发语境出现：`gengyun_local_dev`、`gengyun_catalog_test`、
`gengyun_auth_privacy_test`、`gengyun_source_ops_test`、`gengyun_staging_intake_test`、`gengyun_local`。
**没有任何既有生产库名。** 本交付选用 `gengyun` 并把它作为可覆盖变量（`GENGYUN_DB_NAME`），
此处显式标注为**新决策**而非沿袭惯例，便于评审否决或改名。

## 3 持久存储与"重启后仍在"的判定

设计：`initdb` 直接建在独立云硬盘的挂载点下（`/data/gengyun/pgdata`），用专用 systemd 单元
（[conf/gengyun-postgresql.service](conf/gengyun-postgresql.service)）承载，**不用**发行版默认集群
（`/var/lib/postgresql/17/main` 在系统盘上，不满足持久性要求）。

[install-postgres.sh](install-postgres.sh) 会自动判定数据目录所在文件系统：

- 挂载点是 `/` ⇒ **默认拒绝执行**，除非显式 `GENGYUN_ALLOW_ROOTFS=1`（此时会大声警告，且该部署不满足验收）；
- 发行版自动创建了 `17/main` 集群并占用 5432 ⇒ **默认拒绝删除**，必须显式
  `GENGYUN_DROP_DEFAULT_CLUSTER=1`（且脚本会先确认该集群 `base/` 下只有 3 个系统库目录，即确属空集群）；
  或者改端口重跑。

"重启后仍在"的可核对判定（原始输出要留档）：

```bash
sudo systemctl restart gengyun-postgresql.service
df -P -- /data/gengyun/pgdata | tail -1
sudo -u postgres /usr/lib/postgresql/17/bin/psql -h /var/run/postgresql \
  -U gengyun_cvm_owner -d gengyun -tAc "SELECT pg_postmaster_start_time()"
cat /data/gengyun/pgdata/PG_VERSION      # 仍应为 17
ls -d /data/gengyun/pgdata/base          # 数据目录结构仍在
```

判定：重启前后 `df` 的设备名不变（是那块云硬盘）、`PG_VERSION` 仍为 `17`、
`base/` 仍在、业务库能连上并 `SELECT 1` 成功。**只做一次不重启的检查不算持久性证据。**

## 4 前置清单（资源就绪前无法继续）

这些项**只能由用户在控制台/私密通道完成**，本交付既没有凭据也不会代做：

| # | 前置 | 状态 | 为什么阻塞 |
| --- | --- | --- | --- |
| P0 | **账号边界与路径决策**：云托管环境 `prod-d1g6qe87c4f2d7061` 属**子账号 S**，`gengyun-vpc` 属**父账号 P**，**S ≠ P** | **✅ 路径已选定 = 方案 A**（子账号 S 内建网），网段已定 `10.21.0.0/16`（§0.4） | 账号边界 ⇒ "把 PG 建在父账号 P 的 `gengyun-vpc` 里结构上很可能连不通"（§0.3）⇒ 故改在子账号 S 内建网 |
| P0b | **服务器形态必须是标准 CVM**（不是 Lighthouse），且**在云托管可绑定的那张 VPC（`10.21.0.0/16`）内** | **需用户确认**（§2.5 的官方依据：Lighthouse **不支持自定义 VPC**） | 若 PG 装在 Lighthouse 上，它不在目标 VPC 内 ⇒ **云托管"私有网络"绑定不到它**，方案 A 的前提不成立 |
| P1 | 目标侧 **CVM** 已创建并加入**子账号 S 的 VPC（`10.21.0.0/16`）**、地域 `ap-shanghai`，公网入口按需最小化 | **未满足（仍待用户）**：父账号 P 只读 `cvm DescribeInstances @ap-shanghai` = **0 台**；**子账号 S 无视角** | 没有机器就无从安装；`install-postgres.sh` 会在找不到 `10.21.0.0/16` 网段私网 IP 时拒绝执行。**这是当前最靠前的一项待办** |
| P2 | CVM 的 OS 选择并告知：**Ubuntu 22.04/24.04 或 Debian 12** | **未定** | 本交付只实现 apt 系安装路径（与 CI 的 `ubuntu-latest` 同族）。若选 TencentOS/OpenCloudOS/Anolis/CentOS，需要 yum/dnf 变体，**本交付未提供**，脚本会明确拒绝而不是硬跑 |
| P3 | 独立云硬盘已创建并挂载（如 `/data`） | **未核实** | 数据目录必须落在持久盘；否则脚本默认拒绝执行 |
| P4 | **入站规则**（标准 CVM = **安全组**；若最终用 Lighthouse 则是**实例防火墙**）放行 `5432`，来源仅 `10.21.0.0/16` | **未满足（仍待用户）**：父账号 P 只读 `cvm DescribeSecurityGroups` = **0 个**；**子账号 S 无视角**；Lighthouse 防火墙**来源默认 `0.0.0.0/0`，必须手动收紧**（§2.5） | 只放行目标网段；公网是否关闭只能由用户在控制台核对，脚本无凭据 |
| P5 | 云托管侧（CloudBase/云托管）与目标 VPC 的**内网直连** | **未核实**；路径 B 下**官方依据"未找到"**（§0.3）；**路径 A 下也要求 PG 所在服务器在目标 VPC 内**（§2.5） | 后端连不到内网库时只能走公网，与"仅内网可达"的目标冲突 |
| P6 | 子账号 S 的**（只读）凭据**，或由用户在子账号 S 控制台内操作 | **需用户提供** | 我们只有父账号 P 的只读视角；**对子账号 S 名下 VPC/CVM/入站规则没有视角**，无法核对与验证 |
| P7 | `gengyun_cvm_owner` / `gengyun_api_runtime` 两个口令**已按私密方式交接**到目标主机 | **未交接** | 口令是脚本的必需输入（无口令即拒绝运行）；口令不得进聊天/仓库/PR/文档 |
| P8 | 私密文件位（`/etc/gengyun/private/db-credentials.env`，`0600 root:root`）已就位 | 未创建 | `install-postgres.sh` / `provision-db.sh` 以 **root** 读取它；**不要**在装包前 `chown root:postgres`（那时 postgres 组还不存在 —— 见 [runbook.md](runbook.md) §2 的返修 8 说明） |

另有几个**技术待决项**（见第 6 节）：是否要求 PG 侧 TLS、是否需要 PITR、备份落点、
注销"备份 30 日"逐用户删除的实现，都不在本交付范围内。

**仍待用户完成的最小集合**（做完这几项，本目录的脚本才有执行条件；顺序不可颠倒）：
① ~~选定路径~~**已定：方案 A**，网段 **已定为 `10.21.0.0/16`**（§0.4／§0.5 已完成变更）；
② **在子账号 S 内**创建 **VPC（`10.21.0.0/16`）+ 子网 + 标准 CVM**（**不要用 Lighthouse**，见 §2.5），
   并创建/挂载云硬盘；
③ 配置**入站规则**（标准 CVM = 安全组；Lighthouse = 实例防火墙）——`5432` 仅放行 `10.21.0.0/16`；
④ 私密交接两个 48 位十六进制口令；
⑤ 提供**子账号 S 的只读凭据**（或由用户在子账号 S 控制台内完成 ②③ 并给出结果）。
**在此之前不创建任何资源**（授权门禁见 §0.6；并注意**不要**在父账号 P 里为子账号 S 的环境新建 VPC，
也**不要**改动/删除父账号 P 的 `gengyun-vpc`）。

## 5 与既有组件的一致性（复用而非另造）

| 既有物 | 本交付如何使用 | 是否改动 |
| --- | --- | --- |
| `services/api/db/roles/*.sql`（7 个文件，10 个 NOLOGIN 角色） | **原样执行**（存在即跳过），授权口径完全沿用；不复制、不重写、不删除 | **未改动** |
| `services/api/src/db/migrate.ts` | **原样调用**（`up` / `status` / `list`），幂等语义与 advisory lock 行为不变 | **未改动** |
| `services/api/db/migrations/*.sql`（0001–0010） | 只读比对版本集合，判断"角色引导前迁移是否已完成" | **未改动** |
| `.github/workflows/*postgres*.yml` | 只读，作为 PG 主版本的权威口径 | **未改动** |
| `tools/local-dev/{start.ps1,database.mjs,profile-bootstrap.mjs}` | 作为"最小权限 LOGIN 如何与 NOLOGIN 组组合"的既有先例：`LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS` + 组成员授予 | **未改动** |
| `docs/verification/database-run-handoff.md` | 作为"角色引导是迁移后一次性操作""两个 CLI 只允许本机回环"的依据 | **未改动** |

本交付**只新增** `deploy/postgres-cvm/**`；没有改 `packages/contracts/**`、`services/api/**`、
`db/**`、`miniprogram/**`、`apps/admin/**`、根 `package.json`/lock、`.github/workflows/**`。

## 6 已知残留风险与未决项（明列，不掩盖）

1. **PG 侧未启用 TLS**（`ssl = off`，`pg_hba` 用 `host` 而非 `hostssl`）。
   缓解：只在 VPC 内可达 + `scram-sha-256`。残留：VPC 内明文传输，能读到链路的同 VPC 主机可嗅探。
   若要求 TLS，需要签发/分发证书并让 API 侧 `sslmode` 与 CA 校验一致——注意**不得用关闭证书校验来"通过"**，
   仓库 `npm run lint` 明确禁止这类写法。
2. **口令必然以明文出现在 `CREATE/ALTER ROLE ... PASSWORD` 语句里**（PostgreSQL 协议限制）。
   缓解：`log_statement = 'none'`、脚本不对 argv 传口令、不打印口令。更严格的做法是客户端预先算好
   SCRAM 校验值（`psql \password` 交互式即可，PG 10+），本交付**未接线**，仅在此记录为可选加固。
3. **备份不实现"注销后备份 30 日内清理个人数据"**。`backup-postgres.sh` 的 30 天只是**备份文件保留期**，
   与需求里 F13/AC23 的逐用户删除语义是两件事，后者属未交付项。
4. **无 PITR**（`archive_mode = off`，无 WAL 归档）。RPO = 备份周期。
5. **全库灾备恢复到全新集群未演练**：dump 不含角色，恢复到空集群需要"先建角色再恢复"，
   存在先有鸡还是先有蛋的顺序问题（角色 SQL 的部分 `GRANT` 依赖迁移建出的表）。
   本交付只把**同集群隔离库**的恢复演练做成可执行并给出判定口径，灾难恢复流程明确列为未验证。
6. **两个 CLI 无法连到 CVM 上的库**：`services/api/src/db/source-lifecycle.ts` 的
   `validateSourceDatabaseUrl` 只接受 `127.0.0.1/localhost/[::1]` 且库名限 `gengyun_source_ops_test` / `gengyun_local`，
   `staging-intake.ts` 复用同一校验。因此 `gengyun_source_operator` / `gengyun_staging_importer`
   在 CVM 上**没有消费者**，本交付默认**不创建**（可用 `--with-cli-groups` 显式开启）。
   若将来要在 CVM 上用这两个 CLI，必须先改那道校验——属于 `services/api/**`，**本单不许改，需先报告**。
7. **`migrate.ts` 没有网络守卫**（`docs/verification/database-run-handoff.md` 明确说明那两道校验只属于两个 CLI），
   所以它能通过 TCP 连到 CVM 上的库执行迁移；这也意味着**迁移用的 `DATABASE_URL` 与迁移时机必须由人控制**。
8. **`install-postgres.sh` 只实现 apt 系**。OS 选择（前置 P2）未定，这是必须先确认的阻塞项。
9. **服务器形态决定方案 A 是否成立**（§2.5）：官方 FAQ 明确 **Lighthouse 不支持自定义 VPC**
   （"网络由系统自动创建并分配"），且官方连通性表里**没有"轻量 ↔ 微信云托管"这一行**，
   跨账号轻量互访写"否"。"Lighthouse 上的 PG 能否被云托管私有网络直连"**本单未找到依据**。
   ⇒ **PG 应装在与云托管可绑定 VPC 同网络的「标准 CVM」上**；若坚持用 Lighthouse，须先在控制台/工单确认。

## 7 下一步（资源就绪后按序执行）

**⚠️ 第 0 步在用户侧，且当前未完成**：
**路径已定 = 方案 A**、**网段已定并已完成变更 `10.21.0.0/16`**（§0.4／§0.5），
但**资源尚未创建**：需在**子账号 S** 内建 **VPC(`10.21.0.0/16`) + 子网 + 标准 CVM**
（**不要用 Lighthouse**，见 §2.5）+ 云硬盘 + 入站规则，并按 §0.7 备齐口令与子账号凭据。
在此之前下面这些命令**没有执行条件**。

```bash
# 0) 【用户侧】在子账号 S 内建 VPC(10.21.0.0/16) + 子网 + 标准 CVM + 云硬盘 + 入站规则
#    服务器必须是「标准 CVM」并加入该 VPC（Lighthouse 不支持自定义 VPC，见 §2.5）
#    入站规则：标准 CVM 用安全组；若确用 Lighthouse 则用其实例防火墙（来源需手动收紧）
#    脚本侧网段变更本次已由用户授权完成（§0.5），无需再改
#
# 0.2) 【可选·境内加速】官方 PGDG 源真机实测约 6.7 KB/s（装一个包 ~40 分钟）；
#      mirrors.cloud.tencent.com / mirrors.aliyun.com 的 postgresql/repos/apt ≈ 930 KB/s
#      （清华/中科大对应路径 404，勿用）。默认仍是官方源，要加速就显式设：
#        export GENGYUN_PGDG_MIRROR=https://mirrors.cloud.tencent.com/postgresql/repos/apt
#        sudo -E deploy/postgres-cvm/install-postgres.sh      # 详见 runbook §3 步骤 1
#      脚本会打印"PGDG 源已按 … 切换为镜像"；**没有这行就是变量没传进去**（sudo 会重置环境）。
#
# 0.3) 若之前 initdb 失败过：数据目录可能"非空但没有 PG_VERSION"；脚本会**明确失败**并给指引，
#      确认后可 GENGYUN_RESET_PGDATA=1 重跑（会**先打印内容预览**再清空）。

# 0.5) 把两个口令放进私密文件（0600 **root:root**），不要进聊天/仓库
#      【返修 8】不要在装 PG 包前引用 postgres 组——它由 postgresql-17 包创建，此刻还不存在；
#      私密文件由脚本以 root 读取，root:root 0600 即可（目录属组由脚本装包后自动 chgrp）
sudo install -d -o root -g root -m 0750 /etc/gengyun/private
sudo install -o root -g root -m 0600 /dev/null /etc/gengyun/private/db-credentials.env
# 写入两行（值用 openssl rand -hex 24 生成，演示占位符见 runbook）
#   GENGYUN_DB_OWNER_PASSWORD=<48位小写十六进制>
#   GENGYUN_API_RUNTIME_PASSWORD=<48位小写十六进制>

# 1) 安装 + 初始化（先 --plan 看一遍，零改动；预期输出与「不得误判为通过」见 runbook §0）
sudo deploy/postgres-cvm/install-postgres.sh --plan
sudo deploy/postgres-cvm/install-postgres.sh

# 2) 迁移（以迁移管理员，DATABASE_URL 只从私密环境注入）
DATABASE_URL='postgres://gengyun_cvm_owner:<私密口令>@127.0.0.1:5432/gengyun' \
  node services/api/src/db/migrate.ts status
DATABASE_URL='postgres://gengyun_cvm_owner:<私密口令>@127.0.0.1:5432/gengyun' \
  node services/api/src/db/migrate.ts up

# 3) 角色引导 + 最小权限断言
sudo deploy/postgres-cvm/provision-db.sh

# 4) 备份与恢复演练（恢复演练必须在隔离库上真跑）
sudo deploy/postgres-cvm/backup-postgres.sh
sudo deploy/postgres-cvm/restore-drill.sh --dump /data/gengyun/backup/gengyun-gengyun-<UTC>.dump

# 5) 验证清单（把原始输出整段留档）
sudo deploy/postgres-cvm/verify-cvm-postgres.sh --remote-host <目标网段内另一台机> \
  --runtime-password-env GENGYUN_API_RUNTIME_PASSWORD
```

详细步骤、回滚与"仅用户本人可做"清单见 [runbook.md](runbook.md)。

第 1 步之后**必须**先确认安全组（前置 P4）再让 API 连接——顺序错了就是一次公网暴露。
