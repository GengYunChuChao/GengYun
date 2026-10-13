# 连接验证准备：云托管 API 容器 → 上海 CVM 上的 PostgreSQL（内网）

2026-10-12，**Refs #27**（此前误写 `#25`，已更正）。配套 [README.md](README.md) / [verify-vpc-linkage.md](verify-vpc-linkage.md)。

**本文件只做准备与判读规则，不执行任何连接。** 撰写时未登录云托管、未登录腾讯云、未连接数据库、未读取任何口令；文中 `<...>` 均为占位符，**任何人不得把真实口令、DSN 或账号标识填进本仓库**。

## 1 目标链路

```
微信小程序 ──callContainer──> 云托管服务(API 容器, envId=prod-d1g6qe87c4f2d7061)
                                   │  启用「服务设置 → 私有网络设置」后
                                   │  实例通过 VPC 弹性网卡获得所选子网内的 IP
                                   ▼
                          腾讯云 VPC gengyun-vpc (vpc-h33f1h5a, 10.20.0.0/16, 上海)
                                   │  同地域内网（不经过公网）
                                   ▼
                          上海 CVM 上的 PostgreSQL 17  :5432 （内网 IP）
```

官方机制依据（原文要点）："在服务配置上启用私有网络 VPC 后，选择需要对接的私有网络 VPC 及子网，并保存配置。保存后服务将会发布新版本。在新启动的版本实例中，可以通过私有网络内的 IP 地址或内网域名，访问到腾讯云私有网络中的服务，例如数据库、Redis 等。""配置 vpc 后，服务的实例将通过 vpc 弹性网卡获取私有网络 VPC 的 IP 地址……请确保 vpc 的子网中有足够的空闲 IP 可供分配或使用。"（[服务设置 §7](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloudrun/src/guide/service/pipeline.html)）

## 2 执行前必须全部具备（门禁清单）

以下任一项不满足，**不得执行第 3 节任何命令**；不满足项请回到 [user-console-actions.md](user-console-actions.md)。

| # | 前置条件 | 谁来做 | 如何确认已具备 |
| --- | --- | --- | --- |
| G0 | **产品归属已按 [README.md](README.md) 第 0 步确证**（D1–D7 抄录表已填、"归属结论"三选一已勾选；`envId` 形态**不作证据**） | 用户 | [user-console-actions.md](user-console-actions.md) A0 表填满；若结论不是微信云托管，先按第 0 步替换清单改写判定项 ① 与入口路径 |
| G1 | 已确认环境的绑定腾讯云账号与自己要用的资源账号之间的关系（含"不同账号"这一结论已明确、且已决定不重建既有网络） | 用户 | **【已满足（2026-10-13）】** 关系 = **不同账号（父 / 子账号）**：环境绑定**子账号**，`gengyun-vpc` 在**父账号**；**用户已选定方案 A**（在子账号内建设）且明确"不重建既有网络"（见 [README.md](README.md) 4.11） |
| G1b | **方案 A 路径已定、实施形态已知**（子账号内建 VPC+子网 → CVM → PG → 云托管「服务设置 → 私有网络」绑该 VPC；CIDR 建议 `10.21.0.0/16`） | 用户 | **【已满足】** 决策与步骤见 [user-console-actions.md](user-console-actions.md) A5 与 [README.md](README.md) 4.11；**本单不执行任何建设步骤** |
| G2 | 服务已在**服务设置 → 私有网络设置**中选定 VPC 与子网并保存成功（**方案 A：选子账号内新建的 VPC/子网**；保存会**发布新版本**，属生产变更） | 用户 | 服务设置页显示已配置的 VPC/子网；版本列表出现新版本 |
| G3 | 新版本实例已实际带上 VPC 弹性网卡 | 用户 | 控制台 VPC 配置处可见"额外新增的弹性网卡及其对应 IP 地址"（官方原文） |
| G4 | 所选子网空闲 IP 充足，弹性网卡配额未触顶 | 用户 | **【已确证·实测 2026-10-13】** 目标 VPC 下 1 个子网（`/24`，`ap-shanghai-1`），`AvailableIpAddressCount=253` ⇒ **IP 充足**；弹性网卡配额仍建议在配额中心复核 |
| G5 | **方案 A**：CVM 已在**子账号**的**上海**地域创建完成（父账号侧 2026-10-13 实测为 0 台，**不适用于子账号**） | 用户 | **【本次不具备】** 在**子账号** CVM 控制台可见实例、地域=上海、落在子账号新 VPC / 子网、状态"运行中"；**子账号侧当前无视角**（需 G12） |
| G6 | PostgreSQL 已安装并监听内网可达地址（**不是**仅 `127.0.0.1`） | 用户 | CVM 上 `ss -lntp` 显示监听 `0.0.0.0:5432` 或私网 IP:5432 |
| G7 | CVM/PostgreSQL 安全组入站放通 `TCP 5432`，来源为**云托管实例所在的子网网段**（或该 VPC 网段） | 用户 | **【已确证·实测 2026-10-13：明确不具备】** `vpc DescribeSecurityGroups @ap-shanghai` 地域内 `TotalCount=0` ⇒ **安全组尚不存在**，更无 5432 规则 |
| G8 | 子网网络 ACL 未阻断（默认放通） | 用户 | 子网 ACL 入站/出站规则无拒绝项 |
| G9 | 数据库账号与口令已**私密**交接给需要执行验证的人 | 用户 | 凭据只存在于仓库外私密目录；本仓库无任何口令 |
| G10 | 使用**只读**数据库角色做探活（避免用超级用户） | 用户 | 角色只有 `CONNECT` 与最小读权限 |
| G11 | 已确认环境未冻结、未欠费 | 用户 | 环境设置/服务状态正常（30 天无请求会冻结） |
| G12 | **已取得子账号的控制台访问或子账号只读凭据**（**方案 A 的前提**；否则看不到子账号名下的 VPC / 子网 / 服务器 / 安全组） | 用户 | 能读到**子账号名下**的资源清单（`DescribeVpcs`/`DescribeSubnets`/`DescribeInstances`/`DescribeSecurityGroups`）；**父账号凭据无法代替**。**当前状态：未提供**。见 [user-console-actions.md](user-console-actions.md) A6 |

**2026-10-13 只读实测更新（含一次更正；详见 [README.md](README.md) 1.1 更正记录与 [verify-vpc-linkage.md](verify-vpc-linkage.md) 第 3 节）**：

- **G1、G1b 已满足（2026-10-13）**：账号关系 = **不同账号（父 / 子账号）** —— 环境在**子账号**、`gengyun-vpc` 在**父账号**；**用户已选定方案 A**（子账号内建 VPC+子网 → CVM → PG → 云托管绑该 VPC；CIDR 建议 `10.21.0.0/16`），父账号 `gengyun-vpc` 保留不动。
- **G4 已满足（父账号视角）**：父账号目标 VPC 下 1 个子网，`AvailableIpAddressCount=253`。
- **G5、G7 明确不具备（父账号视角）**：父账号上海地域 `cvm DescribeInstances` = **0 台**、`vpc DescribeSecurityGroups` = **0 个** ⇒ 该账号内 **CVM 未创建、安全组不存在**（**子账号侧无视角**；方案 A 的资源要建在**子账号**内）。
- **G12 不具备（关键新增，方案 A 的前提）**：**没有子账号的访问 / 凭据** ⇒ 子账号名下的 VPC / 子网 / 服务器 / 安全组**无法核验**，A 的进展也无法逐项核对。
- **仍未满足**：**G0**（产品归属未过第 0 步闸门）、G2、G3、G6、G8、G9、G10、G11、**G12**；另**微信云托管 CLI 密钥未交接** ⇒ 服务 / 版本 / 环境侧信息取不到。
- ⇒ **第 3 节任何探活命令现在都不得执行**（门禁未过，做到"不真的连接"）。

## 3 验证办法（以下命令**本次均不执行**，仅备将来使用）

### 方法 A：云托管实例内做 TCP 连通性探测（最短路径，先做这个）

- **入口**：官方指引"进入微信云托管目标服务的**部署发布页面**，点击**实例个数**，进入目标服务的 pod 中"（[自查指南](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloudrun/src/scene/noun/vpc.html)）。
- **命令（择一，全部为只读探测）**：

```
# A1 不需要安装任何工具（bash 内建，最推荐）
bash -c 'exec 3<>/dev/tcp/<PG内网IP>/5432 && echo TCP_OPEN || echo TCP_CLOSED'

# A2 若容器内已有 nc / telnet
nc -vz <PG内网IP> 5432
telnet <PG内网IP> 5432

# A3 若容器内有 python3
python3 -c "import socket;s=socket.socket();s.settimeout(5);print(s.connect_ex(('<PG内网IP>',5432)))"
```

- **预期输出**：A1 输出 `TCP_OPEN`；A2 输出 `succeeded`/`Connected to ...`；A3 输出 `0`（`0` 即成功，非 0 为 `errno`）。
- **判读规则**：
  - 出现上述成功标志 ⇒ **网络层与端口层通过**，进入方法 B 验证数据库层。
  - `TCP_CLOSED`/超时 ⇒ 网络或放通问题，按方法 B 的错误分类逐项排除；**先查 G2/G3/G7/G8**。
  - **不要用 `ping` 判死**：官方明确"ping 没有返回可能是 vpc 网关层的屏蔽，可以尝试其他命令"。
  - 工具 `not found` ⇒ 官方说需 `apt-get`/`yum` 安装；但**优先用 A1/A3 避免安装**——往生产 pod 里装包会改动运行实例的文件系统，属不必要的副作用。
- **失败时的下一步**：按方法 B 的错误分类表处理；不做任何写操作、不重启服务、不改安全组。

### 方法 B：`psql` 只读探活（数据库层）

- **命令**（口令走进程环境变量，**不写进命令行**，避免进入 shell 历史；`connect_timeout` 限制在 5 秒）：

```
psql "host=<PG内网IP> port=5432 dbname=<库名> user=<只读用户> connect_timeout=5 sslmode=prefer" -c "SELECT 1;"
```

- **预期输出**：返回单行 `1`（`?column?` 列），退出码 0。
- **判读规则**（关键：**认证失败不等于网络失败**）：

| 观察到的结果 | 说明 | 下一步 |
| --- | --- | --- |
| 返回 `1` | 内网链路 + 端口 + 认证全部通过 | 进入第 4 节"算不算打通" |
| `connection refused` | TCP 到达但 5432 无监听，或安全组/ACL 拒绝 | 查 G6（监听地址）与 G7 |
| `timeout expired` / 长时间无响应 | 路由/放通问题（丢包而非拒绝） | 查 G2/G3/G7/G8 |
| `password authentication failed` | **网络已通**，仅凭据不对 | 不要改网络；核对私密凭据与角色 |
| `no pg_hba.conf entry for host ...` | **网络已通**，服务端认证配置未允许该来源网段 | 由用户决定是否加 `pg_hba.conf` 项 |
| `could not translate host name` / DNS 失败 | 用了内网域名但解析不可用 | 改用内网 IP 复测 |
| SSL/TLS 相关错误 | 链路可达，`sslmode` 与实例配置不匹配 | 由用户确认是否启用 TLS 后再定 `sslmode` |
- **失败时的下一步**：把**完整原始输出**（不含口令）保留到私密证据目录，只把错误码/结论写进仓库。

### 方法 C：最小连接自检脚本（示例，**不落盘、不执行**）

用于将来在云托管实例内一次性判断"TCP 是否通"，不引入依赖、不打印任何敏感值。**本仓库不提供可执行文件**（避免被 CI 或他人误跑）；如需使用，由执行人复制到**云托管实例内**粘贴执行一次。

```js
// 仅在云托管实例内临时执行；不要提交为文件、不要在 CI 运行。
// 用法: PG_HOST=<PG内网IP> node -e '<把下面的代码粘进来>'
const net = require('node:net');
const host = process.env.PG_HOST, port = 5432, timeoutMs = 5000;
if (!host) { console.error('MISSING_PG_HOST'); process.exit(2); }
const socket = net.connect({ host, port });
const done = (code, label) => { socket.destroy(); console.log(label); process.exit(code); };
socket.setTimeout(timeoutMs);
socket.on('connect', () => done(0, `TCP_OPEN ${host}:${port}`));
socket.on('timeout', () => done(1, `TCP_TIMEOUT ${host}:${port}`));
socket.on('error', (err) => done(1, `TCP_ERROR ${err.code || 'UNKNOWN'}`));
```

- **预期输出**：`TCP_OPEN <IP>:5432` / `TCP_TIMEOUT` / `TCP_ERROR <errno 名>`。
- **判读规则**：只输出主机端口与错误码，**不输出口令、不输出 DSN**；`TCP_OPEN` 仅证明端口可达，**不证明**认证、库存在或业务可用。
- **失败时的下一步**：同方法 B。该脚本**不替代**方法 B 的数据库层验证。

## 4 什么才算"打通"，以及什么不算

- **可记为"内网链路初步打通"**：方法 A 成功 **且** 方法 B 返回 `1`，并且在仓库外留下原始输出与执行时间、基线 SHA。
- **不得记为打通**：仅 `ping` 成功；仅 `telnet` 成功；仅 `TCP_OPEN`；仅云托管控制台显示已选 VPC；仅腾讯云侧能看到 VPC。
- **即使初步打通也不等于产品可用**：本次不验证也不宣称——迁移脚本执行、业务表结构、TLS、连接池/并发、性能与稳定性、备份恢复、只读账号的最小权限是否足够，均属后续独立验收。
- **不许**在验证过程中做写入操作：不建库/建表、不跑迁移、不 `INSERT/UPDATE/DELETE`、不导出业务数据、不改 `pg_hba.conf` 以外的服务端配置。

## 5 失败分类与归属（便于上报）

| 层 | 典型现象 | 归属 |
| --- | --- | --- |
| 产品归属 | 判定项 ① 的入口/账号模型对不上（例如实为 CloudBase 云托管） | 用户（先过 README 第 0 步闸门） |
| 账号/地域 | 下拉框无选项、VPC 不可见 | 用户控制台（README 判定项 ①②） |
| 云托管服务配置 | 未启用私有网络、未发布含 VPC 的新版本 | 用户（生产变更） |
| 子网/IP | 实例起不来、报 IP 不足 | 用户（配额/子网规划） |
| 安全组/ACL | `timeout expired`、`connection refused` | 用户（放通规则） |
| 数据库配置 | `pg_hba.conf`、监听地址、`ssl` | 用户（CVM/PostgreSQL 侧） |
| 凭据 | `password authentication failed` | 私密交接流程（不写仓库） |
| 环境状态 | 环境冻结、欠费 | 用户 |

## 6 需要先具备什么才能执行（一句话版）

**必须先有**：⓪ 产品归属已按 [README.md](README.md) 第 0 步确证（D1–D7 抄录表已填；本目录其余内容以"微信云托管"为待验假设）；① 账号归属结论已落纸（并已决定不重建既有网络）；② 服务已在服务设置里选定 VPC+子网并发布了新版本、实例已获得 VPC 弹性网卡；③ 上海 CVM 与 PostgreSQL 已就绪且监听内网地址；④ 安全组放通来源为所选子网网段的 5432；⑤ 只读数据库凭据已**私密**交接；⑥ 子网空闲 IP 与弹性网卡配额充足。以上缺一即不得执行第 3 节命令。
