# GY-I25 接入验证工作区

本目录用于 `GY-I25 提前验证正式AppID、真机域名及AI和数据库服务接入` 的证据留存。

**任务定位**：在投入功能开发前，确认六类外部服务与平台能力**真的可用**。资源"声明具备"不等于"已验证"。

---

## 1 文件清单

| 文件 | 用途 |
| --- | --- |
| `platform-checklist.md` | 平台侧核查：正式 AppID、成员、隐私声明、合法域名、工具与基础库版本、真机联网与录音 |
| `provider-matrix.md` | 六类服务的接入矩阵：逐项验证要求、实测值、状态与证据 |
| `config.example.json` | 配置模板（**不含任何密钥**），复制为 `config.local.json` 后填写 |
| `quota-estimate.md` | 按需求样本量估算调用额度，供团队申请预算 |
| [接续证据](continuation-evidence.md) | 原PR #32来源、两条修复、实际微信鉴权及剩余资源清单 |
| [产品就绪清单](product-readiness.md) | 开通/调用/查询权限与已有额度分层、精确只读动作、首轮费用参考及用途契约对照；不是新增实测 |

## 2 使用步骤

1. 先执行 `git check-ignore -v docs/verification/config.local.json` 核实精确忽略；安全example不可忽略。个人文件已有时保留，不覆盖；首次再复制 `config.example.json` 为 `config.local.json`。
2. 填供应商和安全HTTPS端点；**密钥/AppSecret/数据库连接秘密只由服务端环境变量提供**，JSON只填appSecretEnv、apiKeyEnv、database.urlEnv的变量名。不打印变量值，不提交配置或原始响应。原database.url直填方式已弃用。
3. `node tools/verify-env.mjs [--json]` 默认零网络，只检查配置。显式 `--probe` 才对已校验HTTPS端点的origin做无鉴权HEAD，8秒超时、禁止跟随重定向；非法/HTTP/带URL凭据或query/fragment的端点跳过且零请求。探测失败不输出异常原文。HEAD响应只记HOST_RESPONDED，**不等于接口认证或真实能力成功**，不承诺探测一定免费。
4. 按 `platform-checklist.md` 逐项核查并填「实测」列
5. 按 `provider-matrix.md` 逐能力验证：每类能力至少一个**真实成功样例** + 一个**受控失败样例**
6. 缺账号、缺资格、缺设备的项，状态填 `阻塞`，并在 `provider-matrix.md` 第 5 节写明阻塞原因与替代方案
7. 完成后在 issue #27 提交 PR 关联本任务

## 3 禁止事项

- 提交任何密钥、AppSecret、真实用户资料、原始图片或音频
- 未取得用户用途授权前，向外部服务发送真实用户数据
- 擅自开通付费服务
- 把测试号、模拟结果或预设数据当作"已验证"
- 用"应该可用"代替实测证据

## 4 与其他任务的关系

| 关系 | 说明 |
| --- | --- |
| 前置 | 本任务是 GY-I04、I06、I09、I10、I11、I12 的前置条件 |
| 下游 | 验证结果供 GY-I01 冻结配置与版本使用 |
| 边界 | 本任务只验证接入条件，不替代需求第 6 节的准确率与性能验收 |

2026-10-04：用户正式AppID与AppSecret已安全交接，工具登录/项目模拟器及服务端token/code交换已有实际证据；DeepSeek密钥已安全交接并通过只读鉴权；腾讯云服务、数据库、正常体验HTTPS和双平台手机仍待资源，不标整项完成。接续PR采用Refs #27，原PR #32由监工决定处置，保留原作者贡献。

离线回归：`node --test tests/verify-env.test.mjs tests/wechat-account.test.cjs tests/deepseek-account.test.cjs tests/tencent-identity.test.cjs`，合成fetch桩不联网、不读取真实凭据。可选真实账号检查 `node tools/verify-wechat-account.cjs --credentials <已获准且已确认忽略的本机文件> --sdk <官方SDK模块目录>`；只在服务端运行，必需字段appid/appsecret，不改写凭据源。真实脚本仅验证稳定token（force_refresh=false）、一次合成错误secret拒绝与工具wx.login code交换；仅输出状态/字段名，不输出秘密、身份值或会话值。缺凭据与AppID不匹配应零请求。这个命令不部署、不在CI执行、不替GY-I04业务登录或供应商接入。


私密交接目录为用户授权的 `E:\GengYunPrivate`（Git仓库外、仅当前用户及SYSTEM权限）。`credentials.local.json` 保管服务端凭据，保持原始文件不变。验证器可用 `--credentials <私密文件>` 仅在进程内映射环境变量。DeepSeek只读检查：`node tools/verify-deepseek.cjs --credentials <私密文件>`，仅余额可用布尔值/字段名、模型名与受控无效密钥拒绝；不输出余额金额，不生成文本，不在CI运行。详情及剩余资源见[资源交接](resource-handoff.md)。

## 六类AI配置接续

配置版本gy25-20261004-02：七个端点的供应商、鉴权、动作/模型、超时、输出与媒体上限已分别列明；TokenHub凭据与TC3分开，审核两个BizType保持空值。当前SDK和只读鉴权证据见[配置记录](ai-configuration-evidence.md)。

服务端离线准备：`node tools/prepare-ai-verification.mjs --credentials <已授权私密JSON>`；不联网，仅输出参数/凭据是否存在，缺项exit1，不输出值。纯准备库没有执行器，当前预算false/0。SDK隔离检查：`node tools/check-ai-sdk.cjs --modules <忽略目录下的官方SDK模块目录>`，HTTP/HTTPS/fetch被禁止。

离线回归新增 `tests/ai-config.test.mjs` 与 `tests/tokenhub-account.test.mjs`，加原四文件共21组。TokenHub真实只读检查仅在明确需要时运行 `node tools/verify-tokenhub.mjs --credentials <已授权私密JSON>`，固定两次模型列表GET（含合成无效key）；不生成、不查或输出账户金额、不在CI使用真实凭据。已有鉴权不需重复请求。审核资源入口修正为[统一CMS](https://console.cloud.tencent.com/cms)，按[交接说明](resource-handoff.md)查看已有策略。

最新本机交接：用户提供两个审核BizType并已分别私密配置，七端点参数及凭据离线检查全齐（exit0）；公开模板仍留空。这个结果只证明本机参数齐备，不证明服务/策略启用、额度、能力或预算获准。

## 2元范围真实接入接续

用户新增一次性腾讯云2元最小调用授权后，独立人工CLI进行了12次合成请求；文本/图片审核各正常Pass+受控失败，TTS/ASR新状态复核成功，TokenHub单图响应成功，OCR第二次资源包耗尽后用户开后付费且单独授权第3次，识别合成文字成功。累计保守预留1.7224元，实际账单未知；详情及RequestId见[真实调用证据](tencent-live-evidence.md)。应用配置仍false/0，CLI不进入生产流、不代表GY-I27已运行。

## 云托管 VPC 互联判定接续

2026-10-12，**Refs #27**（GY-I25 = issue #27；此前曾误写 `#25`，已更正）：针对"环境 `prod-d1g6qe87c4f2d7061` 对接 VPC `gengyun-vpc`/`vpc-h33f1h5a` 时下拉框暂无选项"，新增**核验与连接验证准备物**（未执行任何云侧操作、无凭据、未购买）：事实与判定框架、命令级核验、连接验证准备、仅用户本人可做的清单，见[云托管 VPC 互联核验](../../deploy/cloudrun-vpc/README.md)。当前状态：**产品归属须先按该目录 README「第 0 步」确证**；账号归属、地域、互联入口与授权条件**均待用户本人核查**；已确证的只有官方文档事实（下拉候选来自云托管环境背后绑定的腾讯云账号、仅上海地域、新版服务维度私有网络无需购买资源包而同一页旧段要求购买互联资源包、换绑需销毁全部环境）。**未找到**支持"购买 36 元资源包即可解决"的依据，也没有任何连通证据。

2026-10-13 只读实测（用户授权私密渠道 `E:\GengYunPrivate` 后执行；**仅 `Describe*`/`Get*`，无任何写操作**，未购买未开通；**读数均为父账号视角**）：两份私密凭据**同属父账号**；父账号在**上海**只有 1 个 VPC，即 `gengyun-vpc`（`vpc-h33f1h5a`，`10.20.0.0/16`，非默认），广州地域 0 个；该 VPC 下 1 个子网（`/24`，`ap-shanghai-1`），**可用 IP 253**；父账号上海地域 **CVM = 0 台、安全组 = 0 个** ⇒ 该账号内 CVM 尚未创建、5432 放通不存在；父账号下 `tcb DescribeEnvs` 为 **0 个环境**（环境在**子账号**名下，按父账号查为 0 属正常）。**账号层级已由用户控制台读数确证**：云托管环境绑定**子账号**，`gengyun-vpc` 在**父账号** ⇒ **不是同一个账号**（父 / 子账号）⇒ **这是"私有网络下拉无选项"的已确证最可能根因**（云托管只列**环境所属账号**名下的 VPC）。原因方向：**① 账号层级（首因）→ ①a 跨账号能否打通（未找到依据）→ ② 新旧入口差异 → ③ 角色/服务角色授权 → ④ 产品归属 → ⑤ 环境状态/套餐 → ⑥ 旧 1 环境/1 VPC 配额**（见该目录 README 第 4 节与 4.11 三条路径）。**仍待确证**：子账号访问/凭据（**现有父账号凭据看不到子账号资源**，新增前置 G12）、跨账号能否打通（**未找到依据**）、环境侧入口/角色/状态；**微信云托管 CLI 密钥未交接（AppSecret 不够）** ⇒ `wxcloud` 两条命令仍未执行。只读权限齐备（无 `AuthFailure.UnauthorizedOperation`）。**仍未连通、未开通、未购买**，连接验证门禁 G0–G12 未满足（G1/G4 已满足，G5/G7/G12 明确不具备）。**路径已由用户选定方案 A**（在**子账号**内建 VPC + 子网 → 建 CVM → 装 PostgreSQL → 云托管「服务设置 → 私有网络」绑该 VPC；**CIDR 建议 `10.21.0.0/16`**，不与父账号 `10.20.0.0/16` 重叠；父账号 `gengyun-vpc` 保留不动）；方案 B（跨账号共享 / 对等连接 / 云联网）**未找到官方依据**、方案 C（换绑）**须销毁全部环境且不可恢复故不采用**；本目录不执行任何建设步骤，执行前需**子账号访问 / 只读凭据**（G12）与 **CLI 密钥**。（其中 VPC ID / 子网 ID / CIDR / 环境 ID 按该目录 README §0「标识口径」属**可入库**标识；账号 ID、凭据与资源私网 IP 不在其中。）含账号标识的原始响应只保留在仓库外私密目录，仓库内只有结论。
