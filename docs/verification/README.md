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

离线回归：`node --test tests/verify-env.test.mjs tests/wechat-account.test.cjs tests/deepseek-account.test.cjs`，合成fetch桩不联网、不读取真实凭据。可选真实账号检查 `node tools/verify-wechat-account.cjs --credentials <已获准且已确认忽略的本机文件> --sdk <官方SDK模块目录>`；只在服务端运行，必需字段appid/appsecret，不改写凭据源。真实脚本仅验证稳定token（force_refresh=false）、一次合成错误secret拒绝与工具wx.login code交换；仅输出状态/字段名，不输出秘密、身份值或会话值。缺凭据与AppID不匹配应零请求。这个命令不部署、不在CI执行、不替GY-I04业务登录或供应商接入。


私密交接目录为用户授权的 `E:\GengYunPrivate`（Git仓库外、仅当前用户及SYSTEM权限）。`credentials.local.json` 保管服务端凭据，保持原始文件不变。验证器可用 `--credentials <私密文件>` 仅在进程内映射环境变量。DeepSeek只读检查：`node tools/verify-deepseek.cjs --credentials <私密文件>`，仅余额可用布尔值/字段名、模型名与受控无效密钥拒绝；不输出余额金额，不生成文本，不在CI运行。详情及剩余资源见[资源交接](resource-handoff.md)。
