# 耕云 · 正式环境接入清单（GY-I25 前置）

> **本清单不等于已接入。** 它只回答「要拿哪些凭据与资源、拿到后怎么填、怎么自查填全了没有」。
> 在取得正式凭据、并在真实环境跑出可复核证据之前，**不得声称任何真实能力已验证**——
> 包括但不限于微信登录、识草、OCR、ASR、TTS、大模型问答、文字/图片筛查、私有对象存储、
> 日志告警与备份恢复。本页与配套模板**不含任何密钥值**，只有键名、环境变量名与占位符。
> 填好的本地清单已被 `.gitignore` 忽略（`/config/*.local.json`），**不得提交、不得贴进 PR、不得贴进聊天**。
>
> **本页不关闭 GY-I25，也不构成 #27 验收。** #27 的验收要真实凭据下的真实往返证据；
> 本页交付的只是「清单 ＋ 离线校验器 ＋ 填写口径」，把「缺什么、怎么算拿到」写清楚。
> 校验器退出码 0 只表示**这张表填全了、形状对了**，与「供应商通了」「备案过了」「证书有效」无关。

## 0 一句话

**清单的作用是把「没有凭据就不能声称能力」变成可机械复核的事实**：
键名固定、值只填环境变量名、跑一条离线命令就知道还缺哪几项；
缺项时对应能力在 `real` 模式下应如实不可用（503／409／回退到确定性摘要），而不是用替身数据冒充已接入。

## 1 用法（三步）

### 1.1 复制模板

```powershell
cp config/production-provisioning.local.json.example config/production-provisioning.local.json
```

- 模板：[`../../config/production-provisioning.local.json.example`](../../config/production-provisioning.local.json.example)
- 目标文件：`config/production-provisioning.local.json`，被 `.gitignore` 的 `/config/*.local.json` 覆盖，**只存在于本机**。
- 顶层 `_comment`、`_example` 是模板自检用的元数据：`_` 开头的键不参与 `UNKNOWN_KEY` 判定；
  真清单建议删掉 `_example`（否则会走模板自检模式，跳过值检查，等于自己给自己放水）。

### 1.2 逐项填写

填写口径只有三条：

1. **密钥位置只写环境变量名**，不写密钥本身（`appSecretEnv`、`apiKeyEnv`、`accessKeyEnv`、`secretKeyEnv`、
   `urlEnv`、`readonlyUrlEnv` 都是「变量名」字段，不是「值」字段）。
2. **所有值都是字符串**，数值项也写字符串（如 `"30"`）；写 `30` 会报 `EXPECTED_TYPE`。
3. **键名照抄模板**，不自造、不改名、不改层级（自造键只在模板自检模式下报 `UNKNOWN_KEY`，真清单不会报，
   但下游脚本与证据页会按模板键名取数，改名等于静默失配）。

### 1.3 跑校验器

```powershell
node tools/verify-production-provisioning.mjs --check config/production-provisioning.local.json
```

工具：[`../../tools/verify-production-provisioning.mjs`](../../tools/verify-production-provisioning.mjs)。
默认路径就是 `config/production-provisioning.local.json`，所以省略 `--check` 等价。
加 `--json` 输出机器可读结果（只有键名与问题代码，无值、无路径）。

输出形如：

```text
RESULT PASS
```

或逐行问题 ＋ 汇总：

```text
UNFILLED wechat.appid
NOT_PUBLIC database.urlEnv
RESULT FAIL 2
```

退出码：

| 退出码 | 含义 | 典型触发 |
| --- | --- | --- |
| `0` | 全部通过 | 所有必填键存在、类型对、值非占位符且形状合法；模板自检模式（`_example: true`）只校结构/键/类型，正常也是 `0` |
| `1` | 有登记问题 | 任一问题代码（含 `CONFIG_UNREADABLE` 读不到、`CONFIG_INVALID_JSON` 不是合法 JSON）；**不代表文件安全，只代表不能用** |
| `2` | 用法错误 | 未知参数、`--check` 后面缺路径（如 `--check` 紧跟 `--json`）、`--check=` 空值 |

> 退出码 `2` 不会回显参数值，`1` 不会回显文件内容或解析器原文——这是工具的结构性保证（泄密红线），
> 不是「报错信息不全」的缺陷。排查时自己看本地文件，别把值贴出来。

## 2 问题代码 → 含义 → 怎么修

### 2.1 五个值检查代码

| 代码 | 含义 | 怎么修 |
| --- | --- | --- |
| `MISSING_KEY` | 必填键不存在；父对象整个缺失时**只报父键**，不再逐个报子键 | 按模板补齐该键；若报的是 `wechat` / `providers` 这类父键，说明整段被删了，先整段补回 |
| `UNFILLED` | 空串、纯空白，或**仍是占位符**：整个值形如 `<...>`，或包含 `TODO`、`changeme`、`change_me`、`xxxx`、`replace me`、`请填写`、`待填写`、`待补充`（大小写不敏感） | 换成真实值；密钥位置换成**环境变量名**（如 `WECHAT_APP_SECRET`），不是密钥本身 |
| `NOT_PUBLIC` | 不是公网安全地址（按通信类型分判协议，不接受互相顶替）：`request`/`uploadFile`/`downloadFile` 与供应商端点要 `https`，`socketDomain` 要 `wss`；非对应协议、URL 里带账号密码、带查询串或 `#` 片段、端口不是 443（显式写了 443 之外的一切端口都算）、**域名类字段带路径**、主机是本机/私网/保留域（`localhost`、`*.local`、`*.test`、`*.internal`、`*.invalid`、`10.x`、`192.168.x`、`172.16–31.x`、`127.x`、`169.254.x`、`100.64–127.x`、`0.x`）、IPv6 字面量、单标签主机名 | 填公网域名 ＋ `https://`（`socketDomain` 用 `wss://`），**域名类字段不要带路径**（`https://api.example.com`，不是 `https://api.example.com/v1`）；供应商端点允许固定路径，但同样不许查询串、片段、URL 内凭据与非 443 端口 |
| `BAD_APPID` | 小程序 AppID 不匹配 `^wx[0-9a-f]{16}$` | 填微信公众平台里的**正式**小程序 AppID：`wx` ＋ 16 位小写十六进制；测试号/公众号 AppID 不算 |
| `OUT_OF_RANGE` | 数值项不是十进制整数（`^[0-9]+$`），或超出登记区间 | 写成字符串形式的十进制整数；对照 §2.3 的区间，别把「秒」填成「毫秒」 |

### 2.2 其余四个代码（结构类）

| 代码 | 含义 | 怎么修 |
| --- | --- | --- |
| `EXPECTED_TYPE` | 该是对象的地方不是对象（含数组、`null`）、叶子不是字符串、根不是对象 | 照模板层级填；数值写字符串；不要把整段写成数组 |
| `UNKNOWN_KEY` | **只在模板自检模式**（顶层 `_example: true`）报：出现登记表以外的键 | 删掉自造键；确需新增字段属于改工具与改模板的另一片，不在本页范围 |
| `CONFIG_UNREADABLE` | 文件读不到（原因不回显） | 确认路径拼写、当前工作目录、文件权限；`--check` 的相对路径按**进程工作目录**解析，不是按仓库根 |
| `CONFIG_INVALID_JSON` | 不是合法 JSON（解析器文本不回显，避免带出内容） | 用编辑器/`node -e "JSON.parse(...)"` 自查尾逗号、中文引号、注释（JSON 不允许 `//`） |

### 2.3 数值项区间（照抄登记表）

| 键 | 区间 | 单位/口径 |
| --- | --- | --- |
| `database.poolMax` | 1–100 | 连接数 |
| `database.statementTimeoutSeconds` | 1–120 | 秒 |
| `providers.*.timeoutSeconds` | 1–120 | 秒（六类供应商同一区间） |
| `storage.signedUrlTtlSeconds` | 60–3600 | 秒 |
| `observability.retentionDays` | 1–3650 | 天 |
| `backup.retentionDays` | 1–3650 | 天 |

> 区间是**登记表的自洽边界**，不是性能建议；超出区间说明抄错了单位或抄错了字段。

## 3 逐项清单

每项四问：**为什么需要 / 拿不到时的降级 / 验收命令 / 证据落点**。
「验收命令」里凡带 `--check` 的，都只证「这一项填了且形状对」；真实凭据的有效性必须另有证据。

### 3.1 微信正式 AppID 与 AppSecret

| 维度 | 内容 |
| --- | --- |
| 键 | `wechat.appid`、`wechat.appSecretEnv` |
| 为什么需要 | 小程序登录（`code2session`）、订阅消息、内容安全接口都按小程序身份鉴权；测试号/体验号不能作为发布依据，AppID 也是域名白名单与隐私声明的归属主体 |
| 拿不到时的降级 | 用本地 stub／注入式假适配器跑用例；`real` 模式下登录与依赖微信身份的能力如实不可用（`PROVIDER_UNAVAILABLE`），**不得**拿测试号冒充正式号，也不得把 AppSecret 写进仓库或清单 |
| 验收命令 | `node tools/verify-production-provisioning.mjs --check config/production-provisioning.local.json`（只校 AppID 形状与变量名非占位）；`node tools/verify-env.mjs`（读另一份 `docs/verification/config.local.json`，只校 AppID 格式与 `appSecretEnv` 指向的变量在**当前进程**存在，不验证账号资质） |
| 证据落点 | 微信公众平台后台的 AppID 页面截图（打码到只剩 `wx` 前缀与末 4 位）＋ 环境变量注入记录（只写变量名与注入方式，不写值）；PR 描述里链接本页与证据页 |

### 3.2 request · uploadFile · downloadFile · socket 合法域名与备案

| 维度 | 内容 |
| --- | --- |
| 键 | `wechat.requestDomain`、`wechat.uploadFileDomain`、`wechat.downloadFileDomain`、`wechat.socketDomain`、`wechat.icpFilingNumber` |
| 为什么需要 | 小程序只允许请求已在小程序后台登记的合法域名；四类域名分工不同（`request` 走 API、`uploadFile`/`downloadFile` 走媒体、`socket` 走长连接），**协议也不同**：`request`/`uploadFile`/`downloadFile` 是 `https`，`socket` 是 `wss`（对应 `wx.connectSocket`），四类互相顶替在真机都会被拒；漏登任一类同样会在真机被拒；境内接入还须完成 ICP 备案，备案号是合规证据的一部分 |
| 拿不到时的降级 | 真机联调前只能用开发者工具的「不校验合法域名」开关做本地验证，**该开关不得作为验收证据**；未备案时不得对外提供服务，`real` 模式的对应能力保持不可用，演示只能用明确标注的模拟链路 |
| 验收命令 | `node tools/verify-production-provisioning.mjs --check config/production-provisioning.local.json`（前三项必须是无路径的公网 `https` origin，`socketDomain` 必须是同样形状的 `wss` origin）；`node tools/verify-env.mjs --probe --json`（对配置里的端点做**无鉴权 HEAD**，`HOST_RESPONDED` 只证主机可达，报告恒 `capabilityVerified=false`） |
| 证据落点 | 小程序后台「开发设置 → 服务器域名」截图（含四类域名）＋ 备案号查询结果截图；截图里的查询串与路径先裁掉；PR 描述注明查询日期 |

### 3.3 TLS 与证书

| 维度 | 内容 |
| --- | --- |
| 键 | `wechat.tlsMinVersion`、`wechat.certificateExpiresOn` |
| 为什么需要 | 小程序与微信侧都要求 TLS 1.2 及以上；证书过期会让全部域名同时不可用，属于「上线当天才炸」的典型故障，必须在清单里显式登记到期日以便提前续期 |
| 拿不到时的降级 | 不得用自签证书或降级到 TLS 1.0/1.1 换「能连上」；证书未就绪时保持能力不可用，本地开发用 loopback 与替身，不对外暴露 |
| 验收命令 | `node tools/verify-production-provisioning.mjs --check config/production-provisioning.local.json`（只校两项非空非占位）；证书链与协议版本须用运维侧命令在真实域名上核对（如 `openssl s_client` 或云厂商证书页），**本仓工具不做 TLS 握手** |
| 证据落点 | 证书详情页截图（序列号可打码，保留颁发者、生效/到期时间、SAN）＋ 协议版本核对输出；证据里写清核对时间与时区 |

### 3.4 隐私协议与隐私接口声明

| 维度 | 内容 |
| --- | --- |
| 键 | `privacy.agreementVersion`、`privacy.declaredInterfaces`、`privacy.evidencePath` |
| 为什么需要 | 小程序调用相机、相册、麦克风、位置等接口前必须在后台完成「用户隐私保护指引」声明，否则接口直接被拒；协议版本号是与用户同意记录对账的依据，缺版本号就无法证明「用户同意的是哪一版」 |
| 拿不到时的降级 | 声明未过审时**不得**上线调用相关接口；功能侧按「未授权 → 明确提示并停在可返回的页面」处理，不静默降级成伪造结果；协议未定稿时不得收集真实用户数据，演示只用合成数据 |
| 验收命令 | `node tools/verify-production-provisioning.mjs --check config/production-provisioning.local.json`（三项非空非占位）；`declaredInterfaces` 写成与后台声明一致的接口清单（逗号分隔），人工逐项对照后台页面 |
| 证据落点 | 后台「用户隐私保护指引」页面截图（含审核状态与版本）＋ 协议正文的版本记录；`privacy.evidencePath` 填证据页的相对路径（放 `docs/verification/`），不要填外部网盘链接 |

### 3.5 数据库连接与只读角色

| 维度 | 内容 |
| --- | --- |
| 键 | `database.urlEnv`、`database.readonlyUrlEnv`、`database.poolMax`、`database.statementTimeoutSeconds`、`database.tlsMode` |
| 为什么需要 | 连接串只能以环境变量名出现，避免密钥进仓库；读写与只读分角色是最小权限要求（查询类接口不该拿写权限）；连接池上限与语句超时是防雪崩的硬边界，必须有登记值而不是「默认随便」 |
| 拿不到时的降级 | 只读角色未建好时，查询能力不得用读写角色顶替（那是权限放大）；无真库时相关集成用例带原因 skip，`real` 模式返回 `PROVIDER_UNAVAILABLE`，不得用内存库冒充已接入 |
| 验收命令 | `node tools/verify-production-provisioning.mjs --check config/production-provisioning.local.json`（两个 `*Env` 是变量名、数值在区间内）；真库侧用只读角色跑一条只读语句并确认写语句被拒（`permission denied`），命令与输出原样进证据 |
| 证据落点 | 角色授权清单（`\du` 或等价输出的打码版）＋ 只读连接成功与写入被拒的两段输出；证据里只写角色名与库名，不写连接串 |

### 3.6 六类 AI 供应商密钥（识草 / OCR / ASR / TTS / 大模型 / 文字图片筛查）

| 维度 | 内容 |
| --- | --- |
| 键 | `providers.weedRecognition`、`providers.ocr`、`providers.asr`、`providers.tts`、`providers.llm`、`providers.moderation`，各自 `vendor`／`endpoint`／`apiKeyEnv`／`timeoutSeconds`；`moderation` 另有 `imageEndpoint` |
| 为什么需要 | 六类能力各自独立计费、独立限流、独立合规边界：识草与 OCR 决定「拍到什么」，ASR/TTS 决定「说不说得出」，大模型决定「答得对不对」，筛查决定「发不发得出去」。密钥只以变量名登记，才能在换供应商时不改代码；`moderation.imageEndpoint` 单列是因为**文字接口不能代替图片审核** |
| 拿不到时的降级 | 逐项独立降级，不搞「全有全无」：识别不可用 → 引导手动选择/输入；OCR 不可用 → 提示重拍或手填；ASR 不可用 → 文字问答照常（文字问答不等 ASR）；TTS 不可用 → 只给文字（页面不等 TTS）；大模型不可用 → 回退确定性摘要并明确标注「非模型生成」；筛查不可用 → 内容**不得发布**（fail-closed），不是「先发后审」 |
| 验收命令 | `node tools/verify-production-provisioning.mjs --check config/production-provisioning.local.json`（`endpoint` 可为公网 https 固定路径；`apiKeyEnv` 非占位）；`npm run verify:real-capability`（**离线**按能力组看进程环境变量齐不齐，只证配置、不证能力）；真实往返必须由各能力自己的受控用例或人工调用产出，`verify-env.mjs --probe` 的 HEAD 不算 |
| 证据落点 | 每类一份「厂商控制台截图（密钥打码）＋ 调用日志（脱敏：只留请求 id、耗时、状态码）」；调用日志不得含用户原图、原音频与完整问答正文；六类分别落，禁止合并成一张「AI 已接入」的总结截图 |

### 3.7 私有对象存储桶与签名

| 维度 | 内容 |
| --- | --- |
| 键 | `storage.endpoint`、`storage.bucket`、`storage.accessKeyEnv`、`storage.secretKeyEnv`、`storage.signedUrlTtlSeconds` |
| 为什么需要 | 用户上传的作物照片、语音属于个人信息，必须放私有桶并只通过**短时签名 URL** 访问；`signedUrlTtlSeconds` 是泄露窗口的上界（60–3600 秒），桶名与端点登记后才能复核「没有公开读」 |
| 拿不到时的降级 | 私有桶未就绪时不得退化成公开桶或本地静默落盘；媒体能力整域不可用时如实返回 503，前端明确提示「暂不能上传」，不假装上传成功 |
| 验收命令 | `node tools/verify-production-provisioning.mjs --check config/production-provisioning.local.json`（`endpoint` 为**无路径**公网 https、TTL 在 60–3600）；桶策略用云侧命令核对（匿名 GET 必须被拒、签名 URL 过期后必须 403），命令与输出进证据 |
| 证据落点 | 桶策略 JSON（打码 AccessKey、保留 `Principal`/`Action`/`Resource` 结构）＋ 匿名访问被拒与过期签名被拒的两段输出；桶名可保留，账号 ID 打码 |

### 3.8 日志与告警

| 维度 | 内容 |
| --- | --- |
| 键 | `observability.logEndpoint`、`observability.alertEndpoint`、`observability.retentionDays` |
| 为什么需要 | 出事时要能回答「谁在何时做了什么」，日志保留期是事后追溯与合规要求的下界；告警端点决定故障是被发现还是被用户先发现；两个端点必须与业务域名隔离，避免日志通道拖垮业务 |
| 拿不到时的降级 | 未接入集中日志时只能本机留痕，**不得**因此关闭审计写入；告警未通时不得宣称「可运维」，发布评审按未就绪处理；`retentionDays` 未定时不许把日志当临时文件随手清 |
| 验收命令 | `node tools/verify-production-provisioning.mjs --check config/production-provisioning.local.json`（两个端点为无路径公网 https，保留期 1–3650）；用一条测试日志与一条测试告警验证端到端可达（内容为合成串，不含真实用户信息） |
| 证据落点 | 测试日志在日志平台的检索截图（含时间范围与条数）＋ 测试告警的到达截图；截图里的请求头、token、内网地址打码 |

### 3.9 备份恢复

| 维度 | 内容 |
| --- | --- |
| 键 | `backup.endpoint`、`backup.schedule`、`backup.retentionDays`、`backup.restoreDrillDate` |
| 为什么需要 | 备份只有「能恢复」才有意义；`schedule` 与 `retentionDays` 是恢复点目标（RPO）与保留义务的登记值，`restoreDrillDate` 是最近一次**真实恢复演练**的日期——没有演练日期的备份等于没有备份 |
| 拿不到时的降级 | 未做恢复演练前不得声称「有备份」；演练失败按事故处理，不得只改日期充数；备份未就绪时涉及不可逆删除的操作（注销、清除）不得宣称已完成 |
| 验收命令 | `node tools/verify-production-provisioning.mjs --check config/production-provisioning.local.json`（端点为无路径公网 https、保留期 1–3650、日期非占位）；恢复演练按运维 runbook 在隔离环境执行，产出「恢复到某时间点 ＋ 校验行数/校验和」的记录 |
| 证据落点 | 恢复演练记录（时间、备份文件标识、恢复目标、校验结果、执行者）＋ 调度配置截图；记录里不得出现连接串与账号口令，备份文件标识可保留哈希前缀 |

## 4 与既有工具的关系

三个工具**互不替代**，各答一个问题：

| 工具 | 答什么问题 | 联网 | 能证明什么 | 不能证明什么 |
| --- | --- | --- | --- | --- |
| [`../../tools/verify-production-provisioning.mjs`](../../tools/verify-production-provisioning.mjs) | 这张清单**填全了没有、形状对不对** | **否**（不读环境变量、不连库、不调供应商、不写盘） | 键齐、类型对、非占位、域名/端点/AppID/数值形状合法 | 域名备没备案、证书有没有效、密钥能不能用、能力通不通 |
| [`../../tools/verify-env.mjs`](../../tools/verify-env.mjs) | GY-I25 **配置**是否齐，可选探主机**可达性** | 仅 `--probe` 时对端点做无鉴权 `HEAD`（不跟随重定向） | 配置形状、环境变量**存在**、主机有响应 | 鉴权、业务正确性、能力可用性——报告恒为 `capabilityVerified=false` |
| [`../../tools/release-gate.mjs`](../../tools/release-gate.mjs) | 发版前**几条门禁命令**是否都过 | 按门禁项而定（`contract`／`unit` 等在本机跑） | 汇总 `typecheck`／`unit`／`contract`／`secrets`／`artifacts` 的通过状态（`pg` 默认 skip 并注明原因） | 真实环境接入、真实业务验收；它只是「这些命令过了」 |

关系要点：

- **本校验器不联网、不代表接入成功**。它读的是本地清单文件，输出只有键名与问题代码；把它跑绿只说明「表填完了」。
- **联网探测仍走 `verify-env.mjs`**，且它读的是 `docs/verification/config.local.json`（与接入清单不是同一份文件），
  两者别混填；`HOST_RESPONDED` 只说明主机回了 HEAD。
- **发布门禁走 `release-gate.mjs`**，stdout 只有 JSON、人读摘要走 stderr；本校验器目前**不在**门禁项内，
  不要因为「门禁绿了」就推断清单已填全，反之亦然。
- 三个文件（校验器、模板、本页）之外的既有工具**不要顺手改**：门禁口径的调整属于另一片，需单独评审。

## 5 证据怎么写

每条证据按五要素写，缺一项就算未取得：

| 要素 | 写法 | 反例 |
| --- | --- | --- |
| 命令 | 原样可复制的完整命令（含参数与工作目录） | 「跑了一下校验」 |
| 时间 | ISO 8601 带时区，如 `2026-11-02T10:30:00+08:00` | 「昨天」「刚刚」 |
| 执行者 | GitHub 账号或明确角色（写手／监工／运维），不写真名、手机号、邮箱 | 「我」 |
| 环境 | 主机与系统、Node 版本、分支与提交 SHA、是否联网、是否真库 | 「本地」 |
| 结果 | 退出码 ＋ 关键输出行；**失败也照贴**，不删不改 | 只贴截图里好看的那一段 |

硬规则：

1. **不含密钥值**：环境变量只写名字；URL 去掉查询串；截图打码到「能核对结论、不能复用凭据」为止。
2. **不含个人信息**：不贴真实用户手机号、头像、原图、原音频、问答正文；演示数据须标明是合成数据。
3. **实现者与审查者分离**：写手自测证据由审查者独立复跑或独立复核后签字；
   GitHub 不允许作者批准自己的 PR，作者只能 COMMENT，不得伪造 APPROVED。
4. **证据落点固定**：`docs/verification/` 下的证据页 ＋ PR 描述；
   本清单的 `privacy.evidencePath` 指向该证据页的相对路径。截图与原始输出若不便入库，须在证据页写明存放位置与保管人。
5. **时点限定**：证据只对它记录的那个提交、那套凭据、那个时间窗有效；换供应商、换域名、换证书后须重取。

## 6 本页不声称什么

- 不声称任何真实能力已接入或已验证；
- 不声称域名已备案、证书已生效、隐私声明已过审；
- 不声称数据库角色已按最小权限落地、对象存储已确认私有；
- 不声称日志告警已端到端可用、备份已可恢复；
- 不声称 GY-I25 完成、#27 通过验收。

**这些结论只能在真实凭据与真实环境证据齐备后，由审查者按 PR 规范独立判定。**
