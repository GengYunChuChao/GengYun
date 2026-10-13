# 目标 CVM 上的 PostgreSQL 17：技术准备物

> **交付状态声明（先读这一段）**
>
> - 本目录是**技术准备物**（脚本 + 配置片段 + Runbook + 判定标准），**不是部署成果**。
> - **未部署**：没有在目标 CVM 上安装过 PostgreSQL，没有创建过任何云资源，没有连接过任何真实数据库。
> - **未验收**：没有真实备份、没有真实恢复演练、没有真实业务冒烟、没有安全组核对。
> - 本目录内所有脚本只在本机做过 `bash -n` 语法检查；**本机没有可用的 PostgreSQL / Docker / 云凭据**，
>   因此**没有任何脚本被真正执行过**。原始输出见 [evidence/local-self-check.md](evidence/local-self-check.md)。
> - **脚本完成 ≠ 已部署**；任何"已部署/已验收/可用"的说法都必须等到资源就绪后按
>   [verify-checklist.md](verify-checklist.md) 真跑并留下原始输出。
> - 密钥不存在于本目录任何文件中：口令只从环境变量或主机上的私密文件读取，
>   交接方式见 [runbook.md](runbook.md) 第 2 节。**不要把口令贴进聊天、仓库、PR 或文档。**
>
> 关联：用户清单第 3 项；GitHub `Refs #27`（GY-I25，正式 AppID／真机域名／AI 与数据库服务接入的提前验证）。
> 基线：`upstream/main` = `b1f6ab0e4dc304d2dd621d6a20852b31ccbfab3e`（2026-10-13 11:27:33 +0800）。

## 0 结构性前提、账号条件与授权门禁

> **一句话现状**：账号条件**已收敛为"同一账号"**（用户控制台核对）⇒ 原先的条件式结构性风险**不适用**；
> 但**授权门禁与资源就绪门禁仍然有效**（见 §0.5、§0.6）。

### 0.1 证据分层（谁观察到什么，逐层写清）

| 层级 | 来源 | 内容 | 本单写手的动作 |
| --- | --- | --- | --- |
| **一手 · 用户控制台读数** | **用户本人**在腾讯云控制台读取，经指挥转述 | 控制台账号 ID 与凭据账号**一致（同一账号）**；`gengyun-vpc` 就在该账号 | **未复现**（本单无凭据）；只记录结论，**不记录账号 ID 与凭据指纹等标识值** |
| **二手 · 另一位写手只读调用** | 另一位写手用 `E:\GengYunPrivate` 私密凭据做**只读**调用（未创建任何资源），经指挥转述 | 见下方 §0.2 表格 | **未复现**（本单写手**没有使用任何凭据、没有发起任何云调用**） |
| **本单自有** | 本单写手在本机（Windows + WSL）执行 | 脚本语法/失败路径/静态交叉核对等，见 [evidence/local-self-check.md](evidence/local-self-check.md) | 全部为**本地**动作，未触云 |

**标识值处理口径**：控制台账号 ID、凭据指纹等**只标识账号的信息**，按与凭据同级的私密性处理，
**保留在私密留档**，不写入本仓库、本目录、PR 正文或提交信息。本节只记录"同一账号"这一**结论**
与得出它的**方法**（控制台读数与凭据账号比对）。

### 0.2 已实测的云侧事实（**只读**调用；**不是本单写手执行的**）

下列事实由**另一位写手**用 `E:\GengYunPrivate` 的私密凭据做**只读**调用得到（未创建任何资源）。
原始返回值与任何凭据值都不在本目录、不在 PR、不在提交信息里。

| 观测项 | 结果 | 含义 |
| --- | --- | --- |
| 两个凭据文件 | 属**同一腾讯云账号**（已由用户控制台读数独立确认，见 §0.1） | — |
| VPC `gengyun-vpc`（`vpc-h33f1h5a`，`10.20.0.0/16`） | 在该账号**上海地域可见**，且是该账号上海的**唯一** VPC | 目标 VPC 确实存在 |
| 子网 | 1 个 `/24`（`ap-shanghai-1`），**可用 IP 253** | IP 充足，不构成阻塞 |
| 只读调用所需权限 | 足够，无需扩权 | — |
| `cvm DescribeInstances @ap-shanghai` | **0 台** | **CVM 尚未创建** |
| `cvm DescribeSecurityGroups` | **0 个** | **安全组不存在**，自然也没有 5432 规则 |
| `tcb DescribeEnvs`（上海／广州） | **0 个环境** | 曾用于推断"微信云托管环境 `prod-d1g6qe87c4f2d7061` 是否在本凭据账号内"；该推断**已被 §0.1 的用户控制台读数取代** |

最后一行原本有**两种解释**（官方文档未明确 `DescribeEnvs` 是否覆盖微信侧环境），
曾据此推断"账号错配"。**该推断现已由用户控制台核对推翻**：账号同一 ⇒ 此前的推断不成立。
之所以保留这一段，是因为它记录了我们**一度据以暂停动手**的原因，属于历史记录。

### 0.3 原条件式结构性风险（**按用户核对：已不适用**，保留作历史记录）

> **状态：不适用。** 用户已在腾讯云控制台核对，控制台账号 ID 与凭据账号**一致（同一账号）**
> ⇒ 该条件不成立 ⇒ 下列风险**不适用于本项目当前形态**。
> 保留本节的理由：① 它是我们此前设门的依据；② 若将来账号关系发生变化（换号、交接、代持），
> 这条分析仍是唯一正确的判断依据。

**原文分析（条件式）**：**若**该微信云托管环境绑定的腾讯云账号与本凭据账号**不是同一个**，则
云托管选私有网络时，候选网络**只来自绑定账号** ⇒ **把 PostgreSQL 建在本凭据账号的上海 VPC 里，
结构上可能根本连不通**。这不是参数问题，是账号边界问题，调参解决不了。

### 0.4 原两条备选路径（**账号条件已收敛 ⇒ 均不需要**，保留作历史与将来变更参考）

> **状态：不适用**（前置条件"账号不同"已不成立）。保留本节的理由：若将来发生换号/交接，
> 这仍是两条仅有的路径，尤其路径 ② 的代价必须先知道。

| 路径 | 做法 | 代价与冲突 |
| --- | --- | --- |
| ① 在**绑定账号**侧准备网络 | 在云托管环境所绑定的那个账号里新建/复用 VPC，并在其中准备 CVM + PostgreSQL | 需确认该账号的权限与预算；网段可能与本凭据账号的 `10.20.0.0/16` 冲突而需重新规划。**注意**：本交付的网段目前**写死在四处**——`install-postgres.sh` 的 `VPC_CIDR` 常量、`conf/pg_hba.gengyun.conf`、`verify-cvm-postgres.sh` 的 `VPC_PREFIX`/`hba_vpc_rules` 判据、以及各文档。改网段必须四处同改，属需重新评审的改动 |
| ② **换绑**云托管环境到本凭据账号 | 把微信云托管环境改绑 | 官方明确**必须销毁当前所有环境且不可恢复**；破坏性，且与"不重建既有网络"的约束冲突 ⇒ **极不推荐**（此警告与账号条件无关，将来若有人提议换绑，仍然成立） |

本交付的脚本与文档**不依赖具体账号**，两条路径都可复用；目标 VPC 取值按 §0.6 的既有网络为准。

### 0.5 授权门禁（**与账号假设无关，仍然适用**）

**⇒ 未取得用户对具体动作的明确授权之前：不要创建 CVM、不要建库、不要购买任何资源包、不要改动 VPC。**
（云托管环境的**换绑**更是绝对禁止：其代价是销毁当前所有环境且不可恢复。）

这条门禁**不因账号同一而解除**：账号只是"连得通"的必要条件，不是"可以动手"的授权。
本单的授权范围始终只有"交付技术准备物"，**不含**创建/购买/部署。

### 0.6 资源就绪门禁状态

| 门禁 | 状态 | 证据 |
| --- | --- | --- |
| 账号归属比对 | **已完成（同一账号）** | **一手**：用户控制台读数（§0.1）；标识值保留在私密留档 |
| 目标 VPC 存在且在上海 | **已确认** | **二手**只读：`gengyun-vpc`(`vpc-h33f1h5a`) 在该账号上海可见且唯一 |
| CVM 已创建并加入目标 VPC | **未满足（仍待用户）** | 只读实测 `DescribeInstances @ap-shanghai` = **0 台** |
| 安全组入站 5432 仅 VPC 网段 | **未满足（仍待用户）** | 只读实测 `DescribeSecurityGroups` = **0 个**（不存在规则可核对） |
| 独立云硬盘已创建并挂载 | **未核实（仍待用户）** | 无对应只读观测；`install-postgres.sh` 会在数据目录落根分区时拒绝执行 |
| 两个 48 位十六进制口令已私密交接 | **未交接（仍待用户）** | 口令是脚本必需输入；无口令即拒绝运行 |
| 云托管侧 VPC 互联已通 | **未核实** | 需真实环境 |

**⇒ 仍不能进入"部署"阶段**，只能交付技术准备物；待上述"仍待用户"各项完成、
且用户对具体动作给出授权后，本目录的 `install-postgres.sh` / `verify-cvm-postgres.sh` / `backup-postgres.sh` /
`restore-drill.sh` 才具备执行条件。这与文首的交付状态声明一致。

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

## 2 目标形态（不可自行变更）

### 2.1 资源与地域

| 项 | 取值 | 来源 |
| --- | --- | --- |
| 云账号 | 与上游项目**同账号** | 用户清单第 3 项 |
| 地域 | `ap-shanghai`（上海） | 用户清单第 3 项 |
| VPC | `gengyun-vpc`（`vpc-h33f1h5a`，`10.20.0.0/16`） | 用户清单第 3 项 |
| 形态 | **CVM**（不是 TencentDB 托管实例） | 用户清单第 3 项 |
| 数据库 | PostgreSQL **17.11** | CI 固定标签，见 2.3 |
| 数据目录 | 独立持久云硬盘上的 `/data/gengyun/pgdata` | 本交付设计（可用 `GENGYUN_PGDATA` 覆盖） |
| 业务库名 | `gengyun` | 本交付设计（**新引入的命名**，见 2.4） |

要求是"**目标为同账号、上海、上述 VPC 下的 CVM**"，所以本目录按 **CVM 自建 PostgreSQL** 设计
（不是腾讯云托管 PostgreSQL）。是否已购买/创建该 CVM **尚未核实**；脚本不会尝试创建它。

### 2.2 网络姿态：PostgreSQL 只供内网访问，不开放公网 5432

三处配置必须互相一致，任何一处偏差都等于"公网可达"或"内网不可用"：

| 层 | 目标状态 | 由谁保证 | 本交付能否核对 |
| --- | --- | --- | --- |
| `listen_addresses` | 只含 `127.0.0.1` 与 CVM 的 VPC 私网 IPv4；绝不 `*`/`0.0.0.0` | [install-postgres.sh](install-postgres.sh) 自动探测私网 IP 并写入 [conf/10-gengyun-postgres.conf](conf/10-gengyun-postgres.conf)；脚本结束时用 `ss` 自检非通配监听 | 能（脚本内自检 + [verify-cvm-postgres.sh](verify-cvm-postgres.sh) 的 `no_wildcard_listener`） |
| `pg_hba.conf` | 只有回环 + `10.20.0.0/16` 规则；**没有** `0.0.0.0/0`；VPC 内其它库/身份显式 `reject` | [conf/pg_hba.gengyun.conf](conf/pg_hba.gengyun.conf) | 能（`pg_hba_file_rules` 的 `hba_no_default_route` / `hba_vpc_rules`） |
| CVM 安全组 | 入站 `5432` 来源仅为 `10.20.0.0/16`，**无 `0.0.0.0/0`** | **仅用户本人在控制台配置** | **不能**（脚本无云凭据，不可能读到账号里的安全组） |

三者的判据、期望值和"怎么算失败"逐条写在 [verify-checklist.md](verify-checklist.md)。

> 注意：`listen_addresses` 与 `pg_hba` 只能保证**进程不监听公网地址**、**公网来源匹配不到认证行**。
> 真正"公网 5432 关不关"取决于安全组，而安全组在账号侧，**本交付无法也不得代为配置或核对**。

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
| P0 | **账号归属比对**：云托管环境 `prod-d1g6qe87c4f2d7061` 绑定账号 == 凭据账号 | **✅ 已完成（同一账号）**：用户控制台读数与凭据账号比对一致（见 §0.1；标识值留私密档） | 结论为"同一账号" ⇒ 原先的条件式结构性风险不适用（§0.3 保留为历史记录）。**注意**：账号同一不等于可以动手，授权门禁见 §0.5 |
| P1 | CVM 已创建并加入 `gengyun-vpc`(`vpc-h33f1h5a`)、地域 `ap-shanghai`，公网入口按需最小化 | **未满足（仍待用户）**：只读调用 `cvm DescribeInstances @ap-shanghai` = **0 台** | 没有机器就无从安装；`install-postgres.sh` 会在找不到 VPC 网段私网 IP 时拒绝执行。**这是当前最靠前的一项待办** |
| P2 | CVM 的 OS 选择并告知：**Ubuntu 22.04/24.04 或 Debian 12** | **未定** | 本交付只实现 apt 系安装路径（与 CI 的 `ubuntu-latest` 同族）。若选 TencentOS/OpenCloudOS/Anolis/CentOS，需要 yum/dnf 变体，**本交付未提供**，脚本会明确拒绝而不是硬跑 |
| P3 | 独立云硬盘已创建并挂载（如 `/data`） | **未核实** | 数据目录必须落在持久盘；否则脚本默认拒绝执行 |
| P4 | 安全组入站 `5432` 仅放行 `10.20.0.0/16` | **未满足（仍待用户）**：只读调用 `cvm DescribeSecurityGroups` = **0 个**（安全组尚不存在） | 创建安全组时必须只放行该网段；公网是否关闭只能由用户在控制台核对，脚本无凭据 |
| P5 | 云托管侧（CloudBase/云托管）与该 VPC 的**互联已通** | **未核实**（账号同一这一必要条件已满足，见 P0） | 后端不在本 VPC 内时连不上内网库；这是"仅内网可达"的必要前提 |
| P6 | `gengyun_cvm_owner` / `gengyun_api_runtime` 两个口令**已按私密方式交接**到目标主机 | **未交接** | 口令是脚本的必需输入（无口令即拒绝运行）；口令不得进聊天/仓库/PR/文档 |
| P7 | 私密文件位（`/etc/gengyun/private/db-credentials.env`，`0600`）已就位 | 未创建 | `install-postgres.sh` / `provision-db.sh` 从这里读取口令 |

另有几个**技术待决项**（见第 6 节）：是否要求 PG 侧 TLS、是否需要 PITR、备份落点、
注销"备份 30 日"逐用户删除的实现，都不在本交付范围内。

**仍待用户完成的最小集合**（做完这几项，本目录的脚本才有执行条件）：
① 创建 CVM 并加入 `gengyun-vpc`；② 创建并挂载云硬盘；③ 配置安全组（5432 仅 `10.20.0.0/16`）；
④ 私密交接两个 48 位十六进制口令。**在此之前不创建任何资源**（授权门禁见 §0.5）。

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

见 [runbook.md](runbook.md)。最短路径：

```bash
# 0) 把两个口令放进私密文件（0600），不要进聊天/仓库
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
sudo deploy/postgres-cvm/verify-cvm-postgres.sh --remote-host <同VPC另一台机> \
  --runtime-password-env GENGYUN_API_RUNTIME_PASSWORD
```

第 1 步之后**必须**先确认安全组（前置 P4）再让 API 连接——顺序错了就是一次公网暴露。
