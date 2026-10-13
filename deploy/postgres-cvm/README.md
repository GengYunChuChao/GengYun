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
> - 本目录内所有脚本只在本机做过 `bash -n` 语法检查；**本机没有可用的 PostgreSQL / Docker / 云凭据**，
>   因此**没有任何脚本被真正执行过**。原始输出见 [evidence/local-self-check.md](evidence/local-self-check.md)。
> - **已由监工在真实 PostgreSQL 17.11（官方 Windows 便携版，与 CI 同版本）上真跑过本目录的 SQL**：
>   10/10 迁移与 7/7 既有角色成功；并**发现一个"全新库上必失败"的顺序缺陷**（见
>   [roles-and-migration.md](roles-and-migration.md) §6.2）。缺陷**已修**（本版），
>   但**返修后的「全新库首跑」与「重复执行幂等」两条回归仍待监工回传原始输出**；
>   在其回传前**不得当作已通过**（见 [evidence/local-self-check.md](evidence/local-self-check.md) §4）。
> - **脚本完成 ≠ 已部署**；任何"已部署/已验收/可用"的说法都必须等到资源就绪后按
>   [verify-checklist.md](verify-checklist.md) 真跑并留下原始输出。
> - 密钥不存在于本目录任何文件中：口令只从环境变量或主机上的私密文件读取，
>   交接方式见 [runbook.md](runbook.md) 第 2 节。**不要把口令贴进聊天、仓库、PR 或文档。**
>
> 关联：用户清单第 3 项；GitHub `Refs #27`（GY-I25，正式 AppID／真机域名／AI 与数据库服务接入的提前验证）。
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
**与环境同属的账号**，即**子账号 S**。据此重述为两条并列路径：

| | **路径 A（推荐）** | **路径 B** |
| --- | --- | --- |
| 网络建在哪 | 在**子账号 S** 内新建 **VPC + 子网**（**CIDR 不得与 `10.20.0.0/16` 重叠**，建议如 `10.21.0.0/16`） | 仍用**父账号 P** 的 `gengyun-vpc`（`10.20.0.0/16`） |
| CVM／PG 建在哪 | **子账号 S** 内 | **父账号 P** 内 |
| 云托管侧 | 环境本就属子账号 S ⇒ **同账号**，可直接绑定该 VPC ⇒ **结构上可信** | 环境属子账号 S，却要访问父账号 P 的 VPC ⇒ **必须跨账号私有互通**（对等连接／云联网 CCN，**是否支持该形态：未找到依据**），**且** CloudRun 侧仍需在**子账号 S** 内有可绑定的 VPC／子网（否则连"绑定"这一步都做不了） |
| 本交付脚本 | **可直接复用**，但需按 §0.5 把 CIDR **四处同改** | 可直接复用（`10.20.0.0/16` 不动） |
| 评价 | **推荐**：同账号、边界清晰、不引入跨账号私有互通的不确定性 | **在拿到官方依据前不要按此路径动手**；多一层账号间依赖与未证实行为 |
| 破坏性风险提示 | 在子账号 S 内建网属新建资源，需授权与预算 | **换绑**云托管环境（把环境改到父账号 P）是绝对禁止项：官方明确**必须销毁当前所有环境且不可恢复** |

**两条路径的选择权在用户**；本单**不执行任何一条**，也不替用户决定。
本交付的价值在于：**两条路径下脚本都能用**，差别只是"CIDR 是否要改"（§0.5）。

### 0.5 若选路径 A：**CIDR 是可变参数，四处必须同改**（明确操作步骤）

**这不是隐含假设，是必须执行的步骤。** 本交付的"VPC 网段"目前**写死在四处**
（脚本常量 + 配置模板 + 校验判据 + 文档示例），换 CIDR 时**四处都要改**。
漏掉任何一处都会自相矛盾，典型后果：

- 漏改 `conf/pg_hba.gengyun.conf` ⇒ 新网段的 CVM **连不上**（`pg_hba` 里没有新网段规则）；
- 漏改 `verify-cvm-postgres.sh` ⇒ `hba_vpc_rules`、`vpc_tcp_open` 等判据**永远 FAIL**（判据在看旧网段）；
- 漏改 `install-postgres.sh` ⇒ 脚本在接口上**找不到新网段内的私网 IP**，直接拒绝执行；
- 漏改文档 ⇒ 用户按旧网段配安全组，与 `pg_hba` 不一致。

| # | 位置（精确到行） | 现状与用途 | 改法（以 `10.20.0.0/16` → `10.21.0.0/16` 为例） |
| --- | --- | --- | --- |
| 1 | `install-postgres.sh` **第 50 行** `readonly VPC_CIDR='10.20.0.0/16'` | 安装脚本用它：解析网段前缀→在网卡上找私网 IPv4；拒绝网段外的 IP；渲染 `pg_hba` 模板；打印安全组核对提示。**只实现 /16 形式**（非 /16 会明确失败） | 改为 `readonly VPC_CIDR='10.21.0.0/16'`（**仍须 /16**） |
| 2 | `conf/pg_hba.gengyun.conf` **第 30／32／36 行**的 `10.20.0.0/16` | 迁移管理员与运行时两条 `host` 授权 + 一条 VPC 内 `reject` | **三处**都改为 `10.21.0.0/16` |
| 3 | `verify-cvm-postgres.sh` **第 39 行** `readonly VPC_CIDR='10.20.0.0/16'`、**第 40 行** `readonly VPC_PREFIX='10.20'`、**第 147 行** `address = '10.20.0.0' AND netmask = '255.255.0.0'` | 用来找私网 IP、并断言 `pg_hba` 里存在 VPC 规则 | 三处分别改为 `10.21.0.0/16`、`10.21`、`10.21.0.0` + `255.255.0.0` |
| 4 | 文档：`README.md`（§2.1 目标形态表、§2.2 网络姿态表、§4 前置 P4、本 §0）、`runbook.md`（§0 检查表、§3 步骤 1 的输出示例、§6 U3）、`verify-checklist.md`（§0、§2 探针示例、§3、§4、§9）、`install-postgres.sh` 头部注释**第 10 行**、`conf/10-gengyun-postgres.conf` **第 12 行** | 上文描述、示例 IP `10.20.x.y` 与判读表 | 逐处替换为新网段（含示例 IP） |

**操作步骤（照做即可）**：

```bash
# 0) 先定新 CIDR：不得与 10.20.0.0/16 重叠；必须是 /16（脚本限制）
NEW_CIDR='10.21.0.0/16'
NEW_PREFIX='10.21'        # 新 CIDR 的前两段（/16 专用）

# 1) 改前先看全（避免漏改）
grep -n '10\.20' deploy/postgres-cvm/install-postgres.sh \
                deploy/postgres-cvm/verify-cvm-postgres.sh \
                deploy/postgres-cvm/conf/pg_hba.gengyun.conf
grep -n '10\.20' deploy/postgres-cvm/*.md deploy/postgres-cvm/evidence/*.md

# 2) 四处同改（脚本常量 + 配置模板 + 校验判据 + 文档）
sed -i "s|10\.20\.0\.0/16|${NEW_CIDR}|g" \
    deploy/postgres-cvm/install-postgres.sh \
    deploy/postgres-cvm/verify-cvm-postgres.sh \
    deploy/postgres-cvm/conf/pg_hba.gengyun.conf
sed -i "s|VPC_PREFIX='10\.20'|VPC_PREFIX='${NEW_PREFIX}'|" deploy/postgres-cvm/verify-cvm-postgres.sh
sed -i "s|10\.20\.x\.y|${NEW_PREFIX}.x.y|g; s|10\.20|${NEW_PREFIX}|g" \
    deploy/postgres-cvm/*.md deploy/postgres-cvm/evidence/*.md

# 3) 改后必须复跑（这是本次改动的必要检查）
grep -rn '10\.20' deploy/postgres-cvm/ || echo "旧网段已清零"
bash -n deploy/postgres-cvm/install-postgres.sh
bash -n deploy/postgres-cvm/verify-cvm-postgres.sh
grep -n "VPC_CIDR=" deploy/postgres-cvm/install-postgres.sh deploy/postgres-cvm/verify-cvm-postgres.sh
sudo deploy/postgres-cvm/install-postgres.sh --plan   # 期望：在新网段内找到私网 IP，不再报"0 个私网 IPv4"
```

> **两点必须注意**：
> ① 上面第 2 步是**用文本替换改脚本**，属于**改脚本**，需要**单独授权并重新评审**——
> 本单只交付"这四处是什么、怎么改、改完验什么"的步骤，**本单没有改任何脚本**。
> ② 更彻底的做法是把 `VPC_CIDR` 变成安装脚本的一个环境变量（只留一处），但它同样是脚本改动，
> 而且要同时处理 `pg_hba` 模板替换与 `verify` 的两个常量；**本单不做，留作后续单独任务**。

### 0.6 授权门禁（**与账号条件无关，仍然适用**；本单新增一条）

1. **未取得用户对具体动作的明确授权之前：不要创建 CVM、不要建库、不要购买任何资源包、不要改动 VPC。**
2. **本单新增**：**不要在父账号 P 里"为子账号 S 的环境"新建 VPC。**
   父账号里的新 VPC 仍然不在子账号 S 名下，**解决不了互通问题**，只会多出一份要维护与计费的资源。
   若走**路径 A**，VPC **必须建在子账号 S 内**。
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
| [install-postgres.sh](install-postgres.sh) | 目标 CVM 上安装 PostgreSQL 17.11、在持久云硬盘上 initdb、安装网络配置、启动 | 否（仅 `bash -n`） |
| [provision-db.sh](provision-db.sh) | 迁移之后：建角色组、建最小权限运行时 LOGIN、跑最小权限断言 | 否（仅 `bash -n`） |
| [sql/20-login-roles.sql](sql/20-login-roles.sql) | 运行时 LOGIN 的创建/收敛与组成员授予 | 否（从未被 psql 解析过） |
| [sql/90-assert-least-privilege.sql](sql/90-assert-least-privilege.sql) | 只读最小权限断言，输出 `ok` 或 `FAIL: …` | 否（从未被 psql 解析过） |
| [backup-postgres.sh](backup-postgres.sh) | 逻辑备份 `pg_dump -Fc` + 产出清单 + 保留期清理 | 否 |
| [restore-drill.sh](restore-drill.sh) | 隔离库恢复演练 + 逐项判定 | 否 |
| [verify-cvm-postgres.sh](verify-cvm-postgres.sh) | 资源就绪后的验证清单（可执行） | 否 |
| [verify-checklist.md](verify-checklist.md) | 每条判据的期望输出与判读方式 | 文档 |
| [roles-and-migration.md](roles-and-migration.md) | 角色用途/授予范围/验证命令；迁移执行与顺序 | 文档 |
| [runbook.md](runbook.md) | 部署与运维步骤、回滚、仅用户本人可做清单 | 文档 |
| [conf/10-gengyun-postgres.conf](conf/10-gengyun-postgres.conf) | `postgresql.conf` 片段（监听、端口、socket、口令加密、日志） | 否（模板，含占位符） |
| [conf/pg_hba.gengyun.conf](conf/pg_hba.gengyun.conf) | 客户端认证：仅回环 + VPC 网段，无 `0.0.0.0/0` | 否（模板） |
| [conf/pg_ident.gengyun.conf](conf/pg_ident.gengyun.conf) | 系统用户 `postgres` → 数据库用户 `gengyun_cvm_owner` 映射 | 否（模板） |
| [conf/gengyun-postgresql.service](conf/gengyun-postgresql.service) | 专用 systemd 单元（数据目录在持久盘） | 否（模板） |
| [evidence/local-self-check.md](evidence/local-self-check.md) | 本地可做/不可做的自检原始输出 | 已有原始输出 |

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

## 2 目标形态（按 §0.4 的两条并列路径重述）

> ⚠️ 本节已按 §0 的更正重述：**"同账号"现在指与环境同属的「子账号 S」**，
> 而不是 `gengyun-vpc` 所在的「父账号 P」。**选路径 A 还是 B 由用户决定**（§0.4）。

### 2.1 资源与地域

| 项 | 路径 A（推荐） | 路径 B | 来源 |
| --- | --- | --- | --- |
| 云账号 | **子账号 S**（与环境同账号） | 父账号 P（VPC 侧）+ 子账号 S（云托管侧） | 用户清单第 3 项的"同账号"按 §0.4 重述 |
| 地域 | `ap-shanghai`（上海） | `ap-shanghai`（上海） | 用户清单第 3 项 |
| VPC | **在子账号 S 内新建**，CIDR **不得与 `10.20.0.0/16` 重叠**（建议 `10.21.0.0/16`） | 父账号 P 的 `gengyun-vpc`（`vpc-h33f1h5a`，`10.20.0.0/16`） | 本交付建议 / 既有资源 |
| 子网 | 子账号 S 内新建 | 父账号 P 的 `ap-shanghai-1`（`/24`） | 同上 |
| 形态 | **CVM**（不是 TencentDB 托管实例） | 同 | 用户清单第 3 项 |
| 数据库 | PostgreSQL **17.11** | 同 | CI 固定标签，见 2.3 |
| 数据目录 | 独立持久云硬盘上的 `/data/gengyun/pgdata` | 同 | 本交付设计（可用 `GENGYUN_PGDATA` 覆盖） |
| 业务库名 | `gengyun` | 同 | 本交付设计（**新引入的命名**，见 2.4） |
| 本交付脚本 | 可直接复用，**但要按 §0.5 把 CIDR 四处同改** | 可直接复用（`10.20.0.0/16` 不动） | — |

要求是"**目标为同账号、上海、上述 VPC 下的 CVM**"。按 §0 更正后，"同账号"= **子账号 S**
⇒ 该句在路径 A 下成立（VPC 建在子账号 S），在路径 B 下**不成立**（VPC 在父账号 P）。
两条路径都按 **CVM 自建 PostgreSQL** 设计（不是腾讯云托管 PostgreSQL）。
是否已购买/创建该 CVM **尚未核实**（父账号 P 实测 0 台）；脚本不会尝试创建它。

### 2.2 网络姿态：PostgreSQL 只供内网访问，不开放公网 5432

三处配置必须互相一致，任何一处偏差都等于"公网可达"或"内网不可用"。
**下表里的网段 `<目标网段>` 按路径而定**：路径 A = 子账号 S 内新建的网段（§0.5 四处同改），
路径 B = `10.20.0.0/16`。

| 层 | 目标状态 | 由谁保证 | 本交付能否核对 |
| --- | --- | --- | --- |
| `listen_addresses` | 只含 `127.0.0.1` 与 CVM 的 VPC 私网 IPv4；绝不 `*`/`0.0.0.0` | [install-postgres.sh](install-postgres.sh) 自动探测私网 IP 并写入 [conf/10-gengyun-postgres.conf](conf/10-gengyun-postgres.conf)；脚本结束时用 `ss` 自检非通配监听 | 能（脚本内自检 + [verify-cvm-postgres.sh](verify-cvm-postgres.sh) 的 `no_wildcard_listener`） |
| `pg_hba.conf` | 只有回环 + `<目标网段>` 规则；**没有** `0.0.0.0/0`；该网段内其它库/身份显式 `reject` | [conf/pg_hba.gengyun.conf](conf/pg_hba.gengyun.conf)（现为 `10.20.0.0/16`，路径 A 需按 §0.5 改） | 能（`pg_hba_file_rules` 的 `hba_no_default_route` / `hba_vpc_rules`） |
| CVM 安全组 | 入站 `5432` 来源仅为 `<目标网段>`，**无 `0.0.0.0/0`** | **仅用户本人在控制台配置**（路径 A 需在**子账号 S** 控制台） | **不能**（脚本无云凭据，读不到账号里的安全组；且**对子账号 S 连只读视角都没有**） |

三者的判据、期望值和"怎么算失败"逐条写在 [verify-checklist.md](verify-checklist.md)。

> 注意：`listen_addresses` 与 `pg_hba` 只能保证**进程不监听公网地址**、**公网来源匹配不到认证行**。
> 真正"公网 5432 关不关"取决于安全组，而安全组在账号侧，**本交付无法也不得代为配置或核对**。
>
> 更要注意（§0.3）：**即使三处配置全对，路径 B 也可能因为账号边界而根本连不通**——
> 那不是配置问题，改参数没用。

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
| P0 | **账号边界与路径决策**：云托管环境 `prod-d1g6qe87c4f2d7061` 属**子账号 S**，`gengyun-vpc` 属**父账号 P**，**S ≠ P** ⇒ 需在**路径 A**（推荐，子账号 S 内建网）与**路径 B**（父账号 P 的 VPC + 跨账号互通）之间选定 | **边界已明确（S ≠ P）；路径未选** | 账号边界 ⇒ "把 PG 建在父账号 P 的 `gengyun-vpc` 里结构上很可能连不通"（§0.3）⇒ **未定路径前不得创建任何资源** |
| P1 | 目标侧 **CVM** 已创建并加入**所选路径的 VPC**、地域 `ap-shanghai`，公网入口按需最小化 | **未满足（仍待用户）**：父账号 P 只读 `cvm DescribeInstances @ap-shanghai` = **0 台**；**子账号 S 无视角** | 没有机器就无从安装；`install-postgres.sh` 会在找不到 VPC 网段私网 IP 时拒绝执行。**这是当前最靠前的一项待办**（且须在**子账号 S** 内，若走路径 A） |
| P2 | CVM 的 OS 选择并告知：**Ubuntu 22.04/24.04 或 Debian 12** | **未定** | 本交付只实现 apt 系安装路径（与 CI 的 `ubuntu-latest` 同族）。若选 TencentOS/OpenCloudOS/Anolis/CentOS，需要 yum/dnf 变体，**本交付未提供**，脚本会明确拒绝而不是硬跑 |
| P3 | 独立云硬盘已创建并挂载（如 `/data`） | **未核实** | 数据目录必须落在持久盘；否则脚本默认拒绝执行 |
| P4 | 安全组入站 `5432` 仅放行**所选路径的目标网段**（路径 A = 子账号 S 新建网段，路径 B = `10.20.0.0/16`） | **未满足（仍待用户）**：父账号 P 只读 `cvm DescribeSecurityGroups` = **0 个**；**子账号 S 无视角** | 创建安全组时必须只放行该网段；公网是否关闭只能由用户在控制台核对，脚本无凭据 |
| P5 | 云托管侧（CloudBase/云托管）与目标 VPC 的**内网直连** | **未核实**；路径 B 下**官方依据"未找到"**（§0.3） | 后端连不到内网库时只能走公网，与"仅内网可达"的目标冲突。路径 B 必须先在控制台/工单确认互通能力 |
| P6 | 子账号 S 的**（只读）凭据**，或由用户在子账号 S 控制台内操作 | **需用户提供** | 我们只有父账号 P 的只读视角；**对子账号 S 名下 VPC/CVM/安全组没有视角**，无法核对与验证 |
| P7 | `gengyun_cvm_owner` / `gengyun_api_runtime` 两个口令**已按私密方式交接**到目标主机 | **未交接** | 口令是脚本的必需输入（无口令即拒绝运行）；口令不得进聊天/仓库/PR/文档 |
| P8 | 私密文件位（`/etc/gengyun/private/db-credentials.env`，`0600`）已就位 | 未创建 | `install-postgres.sh` / `provision-db.sh` 从这里读取口令 |

另有几个**技术待决项**（见第 6 节）：是否要求 PG 侧 TLS、是否需要 PITR、备份落点、
注销"备份 30 日"逐用户删除的实现，都不在本交付范围内。

**仍待用户完成的最小集合**（做完这几项，本目录的脚本才有执行条件；顺序不可颠倒）：
① **选定路径 A 或 B**（§0.4）——路径 A 还要先定与 `10.20.0.0/16` 不重叠的新 CIDR；
② 在**选定账号**内（路径 A = **子账号 S**）创建 VPC（若需新建）+ 子网 + **CVM**，并创建/挂载云硬盘；
③ 配置安全组（5432 仅所选路径的目标网段）；
④ 私密交接两个 48 位十六进制口令；
⑤ 提供**子账号 S 的只读凭据**（或由用户在子账号 S 控制台内完成 ②③ 并给出结果）。
**在此之前不创建任何资源**（授权门禁见 §0.6；并注意**不要**在父账号 P 里为子账号 S 的环境新建 VPC）。

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

## 7 下一步（资源就绪后按序执行）

**⚠️ 第 0 步在用户侧，且当前未完成**：先**选定路径 A 或 B**（§0.4）并按 §0.7 备齐
"账号 + 网络 + CVM + 云硬盘 + 安全组 + 口令 + 子账号凭据"。
**路径 A 还要先在子账号 S 内建网并把 CIDR 四处同改（§0.5，属改脚本、需单独授权）。**
在此之前下面这些命令**没有执行条件**。

```bash
# 0) 【用户侧】选定路径 A/B；路径 A 先在子账号 S 内建 VPC+子网（CIDR 勿与 10.20.0.0/16 重叠）
#    若换 CIDR ⇒ 按 §0.5 四处同改，并复跑 §0.5 第 3 步的检查

# 0.5) 把两个口令放进私密文件（0600），不要进聊天/仓库
sudo install -d -o root -g postgres -m 0750 /etc/gengyun/private
sudo install -o root -g postgres -m 0600 /dev/null /etc/gengyun/private/db-credentials.env
# 写入两行（值用 openssl rand -hex 24 生成，演示占位符见 runbook）
#   GENGYUN_DB_OWNER_PASSWORD=<48位小写十六进制>
#   GENGYUN_API_RUNTIME_PASSWORD=<48位小写十六进制>

# 1) 安装 + 初始化（先 --plan 看一遍，零改动）
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
