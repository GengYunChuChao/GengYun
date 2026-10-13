# VPC 互联可执行核验步骤

2026-10-12，**Refs #27**（此前误写 `#25`，已更正）。配套 [README.md](README.md)（判定项与原因列表）。

**本文件只给出步骤，不代为执行。** 撰写时**没有任何凭据、未登录控制台、未调用任何云 API**；所有"预期输出"均为文档推断值，实际以控制台/CLI 返回为准，**不得**把本文当作已核验结果。

## 0 通用规则（先读）

- **凭据只私密交接**：只放在仓库外私密目录（本仓库既有约定为 `E:\GengYunPrivate`，关闭继承、仅当前用户与 SYSTEM）。**不得**把 SecretId/SecretKey/SessionToken、数据库口令、真实账号 UIN 之外的隐私信息写入聊天、本仓库、PR 或任何文档。
- **只读优先**：本阶段只做 `Describe*`/`Get*` 类读操作与 `env:list`/`service:list` 类查询；**不创建、不修改、不删除、不购买、不发布版本**。
- **不扩权**：不为核验新建管理员策略；若需只读凭据，由用户在自己的腾讯云账号下建**受限子账号**并只授读动作（候选：`DescribeVpcs`、`DescribeSubnets`、`DescribeSecurityGroups`、`DescribeSecurityGroupPolicies`、`DescribeVpcPeeringConnections`、`GetCallerIdentity`），凭据按上面规则私密交接。
- **真实动作名与参数以官方 API 文档为准**：本文给出的动作名按官方文档常见命名书写，**除第 2 节"命令可核性"表注明"已核对"者外均未逐条核对**；执行前请对照[私有网络 API 文档](https://cloud.tencent.com/document/api/215) 与 [腾讯云 API 中心](https://cloud.tencent.com/document/api)（在其中确认安全凭证服务 / STS 的动作页）核对动作名、`Version`、`Region` 与参数名，**不要凭本文猜测参数**。
- **不推断控制台链接里的地域数字**：官方自查指南给出的对等连接链接含 `rid=4`，本文**不**把 `rid=4` 断言为上海；请登录控制台后**手动把地域切到上海**再查看。地域取值一律以 `ap-shanghai` 这类官方代码为准（[地域列表](https://cloud.tencent.com/document/api/215/15758)）。
- **账号 ID 只留在私密目录**：把 UIN、实例 ID、内网 IP 等记录到私密文件，文档/PR 里只写"是否一致"的结论与判定依据。
- 本目录不含可执行文件，CI 不运行其中任何命令。

## 1 路径 A：用户本人执行（控制台，无需凭据交接）

### A1 确认产品归属与登录主体

- **目的**：确定是微信云托管还是腾讯云开发 CloudBase 云托管，并确认登录的是目标小程序/公众号。
- **入口**：`https://cloud.weixin.qq.com/cloudrun/`（微信客户端扫码）或 `https://tcb.cloud.tencent.com/dev`。
- **预期输出**：登录后进入"账号选择 → 环境"界面，能看到环境别名 `prod` 与环境 ID `prod-d1g6qe87c4f2d7061`。
- **判读规则**：**归属必须按 [README.md](README.md) 第 0 步的 D1–D7 逐项抄录后判定**（登录域名、页面产品名、是否有「设置 → 权限设置」「设置 → CLI 密钥」、是否存在"绑定腾讯云账号"概念、哪套 CLI 能列出该 envId、帮助链接域名、环境是否出现在你自己的腾讯云账号控制台内），并把抄录表填入 [user-console-actions.md](user-console-actions.md) A0。**`envId` 形态（环境名 `prod` + 追加串）只作提示、不作证据**。若确证不是微信云托管，按 README 第 0 步的分支清单**整段替换**判定项 ① 与入口路径，本文件 §1/§2 的 `wxcloud` 命令段不再适用。
- **失败下一步**：归属无法确证 ⇒ 记【待确证】并停止推进账号归属结论；看不到该环境 ⇒ 先按 A3 确认自己的角色与环境授权范围，而不是改任何配置。

### A2 确认环境地域

- **目的**：确认环境部署地域。
- **入口**：微信云托管 →「设置 → 环境设置 → 基础信息」的"环境部署地域"字段。
- **预期输出**：上海。
- **判读规则**：文档明确微信云托管底层资源部署在上海且不支持跨地域互联 ⇒ 若显示上海，继续；这也是"腾讯云侧资源必须建在上海"的依据。
- **失败下一步**：若显示非上海（与文档不符）⇒ 记录实际值并停止，不要据本文结论推进。

### A3 确认当前操作者的微信侧角色

- **目的**：确认自己在该环境有网络配置权限，以及是否只能由管理员操作。
- **入口**：微信云托管 →「设置 → 权限设置」`https://cloud.weixin.qq.com/cloudrun/settings/privilege`。
- **预期输出**：列表显示自己的微信号及其角色（云托管管理员 / 环境管理员 / 开发者）与环境范围。
- **判读规则**：角色为管理员 ⇒ 具备改配置的入口；仅为开发者 ⇒ 逐个核对被勾选的权限项（权限清单里与网络相关的能力归属**尚未在文档中明确列出**，属【待确证】）。
- **失败下一步**：权限不足 ⇒ 由管理员按需勾选（属平台侧变更，用户执行），**不要**申请超出核验需要的权限。

### A4 定位 VPC 配置入口（新/旧两条）

- **目的**：判断"下拉框"出现在新版服务维度还是旧版环境维度。
- **入口**：
  1. **新版（推荐先看）**：服务管理 → 服务列表 → 目标服务 →「**服务设置 → 私有网络设置**」。
  2. **旧版**：设置 →「环境设置 → 资源互联」。
- **预期输出**：新版应出现"启用私有网络 VPC → 选择 VPC 及子网"；旧版出现资源互联授权卡片与授权状态。
- **判读规则**：官方原文称服务维度 VPC"**当前已不再依赖资源互联能力**"、且"**无需购买服务资源包或互联资源包**"即可使用 ⇒ 新版入口有选择项时，与购买无关；旧入口的授权项可能与资源包有关且属**不推荐**路径。
- **失败下一步**：两处都无选择项 ⇒ 记下各自实际提示文案（截图/原文），进入 A5–A7 查账号与地域，**不要**因此去购买资源包。

### A5 记录"云托管背后绑定的腾讯云账号"

- **目的**：取得判定项 ① 的第一侧事实。
- **入口**：微信云托管 →「设置 → 环境设置 → 基础信息」区，点击「**充值与账单**」；官方说明该入口进入"当前云托管账号**背后绑定的腾讯云账号**的费用中心"。
- **预期输出**：跳转到腾讯云费用中心，可看到当前登录的腾讯云账号标识（账号 ID/UIN、账号别名）。
- **判读规则**：把 UIN **记入私密目录**；不要写入仓库/PR。若跳转后要求再选账号，注意选择的是被引导的那个账号，不要凭记忆选。
- **失败下一步**：无权进入费用中心 ⇒ 该权限项在权限清单中为"费用中心查看"，请管理员按需授权（或由管理员代为记录 UIN 后私密交接）。

### A6 在腾讯云侧确认 `gengyun-vpc` 的账号与地域

- **目的**：取得判定项 ① 的第二侧事实与判定项 ② 的事实。
- **入口**：用**创建该 VPC 时使用的账号**登录 [腾讯云控制台 → VPC](https://console.cloud.tencent.com/vpc)，左上角地域切到**上海**；同时看[账号信息](https://console.cloud.tencent.com/developer) 记下 UIN。
- **预期输出**：上海地域下能看到 `gengyun-vpc`（`vpc-h33f1h5a`，`10.20.0.0/16`）及其子网；账号信息页可见 UIN 与「微信公众平台」绑定状态。
- **判读规则**：能在这里看到该 VPC ⇒ 该 VPC 属于**当前账号**；再看"微信公众平台"登录方式是否已绑定（若已绑定，绑定对象是哪个小程序/公众号，需要与 A1 一致）。
- **失败下一步**：上海地域下看不到 ⇒ 换地域枚举或用路径 B 的 `DescribeVpcs --region ap-shanghai` 确认（不要新建 VPC 代替）。

### A7 账号比对与结论分派（本单核心）

- **目的**：判定 `envId` 所属环境的绑定账号与 `vpc-h33f1h5a` 所属账号是否同一。
- **操作**：把 A5 与 A6 的 UIN 在**私密目录内**比对。
- **判读规则与分派**：
  - **同一账号** ⇒ 排除 README 原因 4.1；按 A2/A6 核对地域（是否同为上海），再按 A3 核对权限，最后按 README 4.7 核对子网可用 IP 与弹性网卡配额。
  - **不同账号** ⇒ 与 README 4.1 一致，是高概率根因。此时**不要**执行任何解绑/换绑：官方明确"更换绑定的腾讯云账号，**必须销毁当前所有环境且无法恢复**"。该分支**只能上报用户决策**，并附上"用户已明确不得重建既有网络"的冲突点。
  - **无法取得任一侧 UIN** ⇒ 记【待确证】并停止推进结论。
- **失败下一步**：所有分支都不产生"已解决"结论；本单不含开通动作。

### A8 复核官方自查清单（打通后使用）

- **目的**：真正打通后按官方顺序自查。
- **入口**：[资源互联调用腾讯云资源自查指南](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloudrun/src/scene/noun/vpc.html)。
- **要点（原文步骤）**：①核对目标资源内网 IP/端口/账号密码；②「设置 - 环境设置 - 资源互联」授权状态是否正常；③核对自己的 VPC 与腾讯云资源所属 VPC 是否一致；④登录服务 webshell 用 `ping`/`telnet ip port`/`nc ip port` 自查连通性；⑤登录对应腾讯云账号查看[对等连接](https://console.cloud.tencent.com/vpc/conn?rid=4)状态是否"已连接"（**该官方链接含 `rid=4`，本目录不断言其等于上海；请在控制台内手动切到上海地域**）；⑥核对资源安全组是否屏蔽了服务内网 IP 所在网段。
- **判读规则**：上述 6 步全部正常才可能连通；任一步异常按该步处理。**对等连接（步骤⑤）属旧"资源互联"机制的产物**，走新版服务维度 VPC 时是否需要：**未找到明确依据**，以控制台实际显示为准。

## 2 路径 B：后续有凭据时执行（命令级）

前置：⓪ 已按 [README.md](README.md) 第 0 步确证产品归属为**微信云托管**（抄录表已填；若确证为其他产品，本节的 `wxcloud` 命令段**不适用**，需按 CloudBase 文档替换）；① 已确认要在**哪个腾讯云账号**下核验（路径 A7 的结论）；② 已由用户私下交接**受限只读**凭据或已在本机配置好 CLI 凭据；③ 凭据只存在于进程环境或私密配置，**不写入命令行参数**（避免进入 shell 历史）、**不写入仓库**。

安装与登录以官方文档为准：腾讯云 CLI 见[命令行工具文档](https://cloud.tencent.com/document/product/440/6176)；微信云托管 CLI 为 `npm install -g @wxcloud/cli`（[CLI 工具](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloudrun/src/guide/cli/)）。**本目录未验证这些安装命令**。

**命令可核性（逐条状态）**：下表逐条给出每条 `tccli` 命令的官方文档入口与核对状态。除注明"已核对"者外，**动作名与参数一律未逐条核对，以官方文档为准**。

| 命令 | 官方文档入口 | 核对状态 |
| --- | --- | --- |
| `tccli sts GetCallerIdentity` | [腾讯云 API 中心](https://cloud.tencent.com/document/api)（安全凭证服务 / STS） | **未逐条核对**：动作名与返回字段以官方文档为准。**本轮实测**：该动作**需要 `Region`**，不带时返回 `MissingParameter`（见第 3.3 节） |
| `tccli vpc DescribeVpcs --region ap-shanghai` | [私有网络 API 文档](https://cloud.tencent.com/document/api/215) | **未逐条核对**：动作名与返回结构以官方为准；`Region` 合法值见[地域列表](https://cloud.tencent.com/document/api/215/15758)（上海 = `ap-shanghai`） |
| `tccli vpc DescribeSubnets --region ap-shanghai --Filters Name=vpc-id,Values=vpc-h33f1h5a` | [私有网络 API 文档](https://cloud.tencent.com/document/api/215) | **未逐条核对**：`Filters` 字段名与取值格式以官方为准 |
| `tccli vpc DescribeVpcPeeringConnections --region ap-shanghai` | [私有网络 API 文档](https://cloud.tencent.com/document/api/215) | **未逐条核对**：动作是否存在、状态字段取值以官方为准 |
| `tccli vpc DescribeSecurityGroups --region ap-shanghai` | [私有网络 API 文档](https://cloud.tencent.com/document/api/215) | **未逐条核对**：动作名与返回结构以官方为准。**本轮实测**：**不接受** `Filters Name=vpc-id`（返回 `UnknownParameter`），须去掉 Filters 后本地按 `VpcId` 过滤（见第 3.3 节） |
| `tccli vpc DescribeSecurityGroupPolicies --region ap-shanghai --SecurityGroupId <安全组ID>` | [私有网络 API 文档](https://cloud.tencent.com/document/api/215) | **未逐条核对**：参数名与规则结构以官方为准 |
| 配额读取 | [配额中心控制台](https://console.cloud.tencent.com/limitation) | 控制台人工读取；**未找到**可直接读取这些配额的只读 API 依据 |

**已核对的部分**：微信云托管 CLI 的 `npm install -g @wxcloud/cli`、`wxcloud login`（`-a/--appId`、`-k/--privateKey`）及 `env:list` / `service:list`（`-e/--envId`、`-s/--serviceName`、`--json`）/ `version:list` 的命令与参数，逐条来自官方 [CLI 工具](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloudrun/src/guide/cli/) 页面原文。

**本轮实测（2026-10-13）实际执行情况**：本机**未安装 `tccli` 与 `wxcloud`**，上表的 `tccli` 命令行**未按原样执行**，而是用**等价的只读 TC3 调用**完成（签名逐行沿用本仓库已审实现）；动作、结果、判读与两条踩坑见第 3 节，并已回填为本表的注意项。`wxcloud` 路径未执行：私密文件中**没有**微信云托管 CLI 密钥。

### B1 微信云托管侧：环境与服务清单

- **目的**：用可机读输出确认 envId、环境别名、服务名与地域。
- **凭据来源**：微信云托管控制台「设置 → CLI 密钥」`https://cloud.weixin.qq.com/cloudrun/settings/other` 生成，**需账号管理员扫码**；密钥只由用户保管。
- **命令**：

```
wxcloud login -a <AppID> -k <CLI密钥>
wxcloud env:list --json
wxcloud service:list --envId prod-d1g6qe87c4f2d7061 --json
wxcloud version:list --envId prod-d1g6qe87c4f2d7061 --serviceName <服务名> --json
```

- **预期输出**：`env:list` 返回含 `EnvId: "prod-d1g6qe87c4f2d7061"` 与 `Alias: "prod"` 的条目；`service:list` 返回服务条目，含 `Status`、`IsPublicAccess`、`DefaultPublicDomain`、`CustomDomain`；`version:list` 返回版本名与状态（官方 JSON 字段样例见 CLI 文档）。
- **判读规则**：
  - `DefaultPublicDomain` 形如 `https://<服务>.ap-shanghai.run.tcloudbase.com` ⇒ 地域为**上海**（官方 CLI 文档给出的样例域名即含 `ap-shanghai`）。域名中出现其他地域 ⇒ 与文档"底层资源在上海"不符，记录实际值。
  - `Status` 非 `succ`、或服务列表为空 ⇒ 先解决服务状态，再谈 VPC。
- **失败下一步**：`login` 失败 ⇒ 核对 AppID 与密钥是否配套、密钥是否被吊销；**不要**重复尝试刷次数。文档所列 CLI 命令中**没有 VPC/私有网络相关命令** ⇒ 【未找到依据】表明可用 CLI 读取或设置 VPC 绑定状态；VPC 部分必须走控制台或腾讯云 API。

### B2 腾讯云侧：身份与账号归属

- **目的**：确认当前凭据属于哪个账号，用于 A7 的比对（这是唯一能把"账号归属"变成事实的一步）。
- **命令**：

```
tccli sts GetCallerIdentity
```

- **文档入口**：[腾讯云 API 中心](https://cloud.tencent.com/document/api) 内"安全凭证服务 / STS"的 `GetCallerIdentity` 动作页（**动作名与字段未逐条核对，以官方为准**）。
- **预期输出**：返回 `AccountId`/`Arn`/`UserId` 等身份字段（真实字段以官方 STS 文档为准）。
- **判读规则**：把返回的账号与 A5 记录的"云托管背后绑定账号"在**私密目录内**比对；一致 ⇒ 本凭据可用来核验目标资源；不一致 ⇒ 换用正确账号的凭据，**不要**在此账号下建资源。
- **失败下一步**：返回鉴权类错误 ⇒ 凭据无效或被禁用，请用户重新私密交接；**不要**改用管理员密钥。

### B3 腾讯云侧：VPC 与子网事实（判定项 ②③）

- **目的**：在上海地域确认 `vpc-h33f1h5a` 是否存在、网段是否 `10.20.0.0/16`、子网数量与可用 IP。
- **命令**：

```
tccli vpc DescribeVpcs --region ap-shanghai
tccli vpc DescribeSubnets --region ap-shanghai --Filters Name=vpc-id,Values=vpc-h33f1h5a
```

- **文档入口**：[私有网络 API 文档](https://cloud.tencent.com/document/api/215) 的 `DescribeVpcs`、`DescribeSubnets` 动作页（**动作名、`Filters` 字段与返回结构未逐条核对，以官方为准**）。
- **预期输出**：`DescribeVpcs` 的 `VpcSet` 中出现 `VpcId: "vpc-h33f1h5a"`、`CidrBlock: "10.20.0.0/16"`；`DescribeSubnets` 返回该 VPC 下 1 个子网及 `AvailableIpAddressCount`。
- **判读规则**：
  - 出现该 VPC ⇒ 本凭据账号即是其所属账号，且地域为上海。与 A5 的绑定账号比对即可定 A7 结论。
  - `TotalCount==0` 或集合中无该 VPC ⇒ 两种可能：**(a) 本凭据不是该 VPC 所属账号；(b) 地域不对**。用 `--region ap-guangzhou`（或枚举地域）区分：若换地域后出现，则是地域问题；仍不出现，则是账号问题。
  - 返回 `AuthFailure.UnauthorizedOperation` ⇒ 凭据有效但**未授权该读动作**（同类判读见本仓库既有实测记录 [资源交接](../../docs/verification/resource-handoff.md)）⇒ 请用户为该只读子账号补 `DescribeVpcs`/`DescribeSubnets` 读权限，**不要**扩到写权限。
  - `AvailableIpAddressCount` 偏小（如小于服务实例数上限）⇒ 记录为风险：启用私有网络后实例可能因 IP 不足启动失败（官方原文见 README 判定项 ③）。
- **失败下一步**：`vpc cidr conflict` 类提示出现在控制台保存阶段（不是本命令）⇒ 属 VPC 网段与云托管环境网段冲突，需用户决策调整范围，**不要**自行改既有 VPC。

### B4 腾讯云侧：旧"资源互联"对等连接状态（可选）

- **目的**：仅当确认走旧版资源互联路径时，核对对等连接状态。
- **命令**：

```
tccli vpc DescribeVpcPeeringConnections --region ap-shanghai
```

- **文档入口**：[私有网络 API 文档](https://cloud.tencent.com/document/api/215) 的对等连接查询动作页（**动作是否存在与状态取值未逐条核对，以官方为准**；`rid=4` 不作地域断言）。
- **预期输出**：返回对等连接列表及状态。
- **判读规则**：官方自查指南要求状态"显示已连接才可正常使用"；列表为空 ⇒ 旧路径未建立。**新版服务维度 VPC 是否需要对等连接：未找到依据**。
- **失败下一步**：不要自行创建对等连接；属资源创建，用户决策。

### B5 腾讯云侧：目标 PostgreSQL/CVM 的安全组与来源（判定项用于连接准备）

- **目的**：确认 5432 入站是否放通**云托管实例所在的 VPC 子网网段**。
- **命令**：

```
tccli vpc DescribeSecurityGroups --region ap-shanghai
tccli vpc DescribeSecurityGroupPolicies --region ap-shanghai --SecurityGroupId <安全组ID>
```

- **文档入口**：[私有网络 API 文档](https://cloud.tencent.com/document/api/215) 的安全组查询动作页（**动作名、参数名与规则结构未逐条核对，以官方为准**）。
- **预期输出**：目标安全组入站规则中存在允许 `5432`、来源为该子网 CIDR（或该 VPC 网段）的规则。
- **判读规则**：官方自查指南第 6 步即"查看腾讯云 redis 或 mysql 的安全组是否有入站规则屏蔽了服务内网 IP 所在的网段"。来源写 (`0.0.0.0/0`) 属过度放开 ⇒ 记为风险项，建议收窄到子网网段（**修改属用户决策**）。
- **失败下一步**：无规则 ⇒ 列入 [user-console-actions.md](user-console-actions.md) 待办，由用户放通；**不要**由核验者改生产安全组。

### B6 配额类核查（弹性网卡 / IP）

- **目的**：确认启用私有网络后能分配足够的弹性网卡与私网 IP。
- **入口**：腾讯云 →[配额中心](https://console.cloud.tencent.com/limitation)；具体配额项名称以控制台实际显示为准。
- **预期输出**：可看到当前账号在上海地域的弹性网卡/私网 IP 相关配额与已用值。
- **判读规则**：官方明确服务实例会通过 VPC 弹性网卡取 IP，且"IP 不足……会导致实例无法正常启动"。⇒ 已用值接近上限即记为阻塞风险。
- **失败下一步**：【待确证】是否存在可直接读取这些配额的只读 API；**未找到依据**前不要为它申请新权限，用控制台人工读取即可。

## 3 路径 C：只读实测记录（2026-10-13，已完成一轮）

用户私密交接 `E:\GengYunPrivate` 后执行。**只读**：全部为 `Describe*`/`Get*`，无任何 `Create*`/`Modify*`/`Delete*`/`Allocate*`，无购买、无开通、无扩权。

### 3.1 执行方式与环境（含一处与预设命令的偏差）

- 本机**未安装 `tccli`，也未安装 `wxcloud`**（`Get-Command` 均 NOT FOUND）⇒ 未采用 `tccli` 命令，改用**等价的只读 TC3 HTTP 调用**；签名算法**逐行沿用本仓库已审实现** `tools/verify-tencent-live.mjs` 的 `signRequest`（未改动仓库任何代码）。
- 因此 **`wxcloud env:list` / `service:list` 未能执行**：私密文件中**没有**微信云托管 CLI 密钥（掩码检查未见"CLI 密钥/私钥"类标签）⇒ 按用户要求如实记录：**缺微信云托管 CLI 密钥，`wxcloud` 路径无法执行**，且**不得**用 AppSecret 去猜。
- 执行脚本置于仓库外 `E:\GengYunCommander\.w18-vpc-evidence\readonly-vpc-check.cjs`、`readonly-tcb-probe.cjs`、`make-private-summary.cjs`（**未进入仓库**）。

### 3.2 实际调用与结果

| # | 动作（服务 / 版本 / 地域） | 目的 | 结果 | 判读 |
| --- | --- | --- | --- | --- |
| 1 | `sts GetCallerIdentity`（`2018-08-13`）@`ap-shanghai` | 取得凭据所属账号 | OK；返回 `Type/AccountId/UserId/PrincipalId/Arn/RequestId` | 【已确证·实测】凭据有效，签名被接受 |
| 2 | 同上，用第二份凭据 | 比对两份凭据是否同账号 | OK；账号指纹**相同** | 【已确证·实测】**两份凭据属同一账号** |
| 3 | `vpc DescribeVpcs`（`2017-03-12`）@`ap-shanghai` | 目标 VPC 是否可见 | `TotalCount=1`；`has_target_vpc=true`；`CidrBlock=10.20.0.0/16`；`VpcName=gengyun-vpc`；`IsDefault=false`；该账号 VPC 列表 = 仅有 `vpc-h33f1h5a` | 【已确证·实测】目标 VPC 属该账号且在上海；**该账号上海地域只有这一个 VPC** |
| 4 | `vpc DescribeVpcs` @`ap-guangzhou` | 排除地域因素 | `TotalCount=0` | 【已确证·实测】目标 VPC 确实只在上海 |
| 5 | `vpc DescribeSubnets` @`ap-shanghai`（`Filters: [{Name:'vpc-id', Values:['vpc-h33f1h5a']}]`） | 子网数量与可用 IP | `subnet_count=1`；`subnet_mask_bits=24`；`AvailableIpAddressCount=253`；`Zone=ap-shanghai-1` | 【已确证·实测】**IP 充足（253），不构成"实例起不来"的阻塞** |
| 6 | `vpc DescribeSecurityGroups` @`ap-shanghai`（不带 Filters） | 安全组是否存在 | 地域内 `TotalCount=0` ⇒ 目标 VPC 内安全组数 = **0** | 【已确证·实测】**安全组尚不存在**，5432 入站放通尚未配置 |
| 7 | `cvm DescribeInstances`（`2017-03-12`）@`ap-shanghai` | CVM 是否已购买/创建 | `TotalCount=0`（该账号上海地域无可列实例） | 【已确证·实测】**CVM 尚未创建** —— 直接回答用户"尚未核实购买或创建完成"：**核实结果是没有** |
| 8 | `tcb DescribeEnvs`（`2018-06-08`）@`ap-shanghai` 与 @`ap-guangzhou` | 目标环境是否在该账号 | 两地域均 `TotalCount=0`、`EnvList` 为空 ⇒ `prod-d1g6qe87c4f2d7061` **不在**该账号 | 【已确证·实测】该事实；**其含义需谨慎**：见 3.4 残余不确定性 |

**权限判读（判定项 ④）**：8 类调用**全部成功，未出现 `AuthFailure.UnauthorizedOperation`** ⇒ 该凭据对 `sts GetCallerIdentity`、`vpc DescribeVpcs/DescribeSubnets/DescribeSecurityGroups`、`cvm DescribeInstances`、`tcb DescribeEnvs` 的**读权限齐备**；**无需**为用户申请更大的 CAM 权限。

### 3.3 两条实测踩坑（供后续复跑，已写进本文件的命令可核性表）

1. **`sts GetCallerIdentity` 要求 `Region`**：不带 `X-TC-Region` 时返回 `MissingParameter :: The request is missing the required parameter Region.` ⇒ 本目录的示例命令应显式带上 `--region`。⚠️ 这正是"未逐条核对动作名与参数"的风险实例，**再次说明必须以官方文档为准**。
2. **`vpc DescribeSecurityGroups` 不接受 `Filters: [{Name:'vpc-id', ...}]`**：返回 `UnknownParameter` ⇒ 改为**不带 Filters 拉取地域内全部安全组**，再在本地按 `VpcId` 过滤（本轮即用此法）。

### 3.4 结论、残余不确定性与待确证

- **已从"待确证"升级为【已确证·实测】**：两份凭据同账号；该账号上海地域唯一 VPC 即 `gengyun-vpc`；VPC 地域=上海；子网 1 个 `/24`、可用 IP 253；该账号无 CVM、无安全组、无云托管/TCB 环境；只读权限齐备。
- **仍然【待确证】**：
  1. **目标环境的绑定账号**（只能控制台读）：微信云托管「设置 → 环境设置 → 充值与账单」⇒ 绑定账号 UIN，与本凭据账号在**私密目录内**比对。
  2. **`tcb DescribeEnvs` 是否覆盖微信云托管创建的环境**：官方文档**未明确**。⇒ 上面第 8 条"0 个环境"存在两种解释：(a) 环境绑定在另一个账号（⇒ 支持 README 4.1，且最可能）；(b) 环境就在本账号但该接口不列微信侧环境（⇒ 账号错配被排除）。**不得**把 (a) 当已确证结论。
  3. 环境部署地域（环境侧）、互联入口新/旧、是否需服务角色授权、环境是否冻结/欠费 —— 均需控制台。
  4. **微信云托管 CLI 密钥**未交接 ⇒ `wxcloud env:list`/`service:list` 路径未执行。
- **仍未连通、仍未开通**：本轮未做任何写操作，网络打通与 VPC 绑定**均未发生**；`connection-verification-prep.md` 的 G0–G11 门禁**仍未满足**（G2/G3/G5/G7/G8 明确不具备）。

### 3.5 安全处理（本轮如何做到"密钥与账号标识不出仓库"）

- 密钥值**从未打印**：脚本把凭据读入进程内存，stdout 只输出掩码长度与**不可逆指纹**（`sha256(UIN)` 前 12 位），指纹本身不泄露 UIN。
- 含账号标识的**原始响应**只写入仓库外 `E:\GengYunPrivate\w18-vpc-verify-raw\`；结论汇总只写入 `E:\GengYunPrivate\w18-vpc-verify-results.md`（含 UIN，**未进仓库、未进 PR、未进聊天**）。
- 仓库内只保留：命令、状态、计数、`vpc-h33f1h5a`/`10.20.0.0/16`（用户已在任务中给出的标识）与判读结论；**不含** UIN、密钥、口令、子网 CIDR、CVM/安全组 ID。

## 4 核验记录应写到哪

- **结论层**（可入仓库）：判定项 ①–⑤ 的"是/否/待确证"结论、实际观察到的**提示文案**、错误码、命令退出码、执行日期与基线 SHA。
- **事实层**（不入仓库）：UIN、SecretId/SecretKey/SessionToken、数据库口令、实例 ID、内网 IP、截图原图 → 全部落在私密目录，仓库只引用其**存在性**与文件名占位。

## 5 本文件明确不做的事

- 不创建/删除/修改 VPC、子网、安全组、对等连接、CVM、数据库；不发布云托管新版本；不购买任何资源包或套餐；不解绑/换绑腾讯云账号。
- 不调用任何供应商付费接口；不向外部发送真实用户数据。
- 不在 CI 中执行本目录任何命令（本目录无脚本、无工作流改动）。
