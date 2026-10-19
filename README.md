# 耕云

识草查药与除草科普社区：原生微信小程序、独立网页后台、Fastify API。
正式仓库：[GengYunChuChao/GengYun](https://github.com/GengYunChuChao/GengYun)。

## 协作与交付

现行分工（2026-10-14）：**指挥派发 → 写手实现与自检 → 监工审查与合并**。用户决定需求、重大范围、权限、费用和部署。

| 角色 | 身份与工作方式 | 职责边界 |
| --- | --- | --- |
| 指挥 | 已授权、限定仓库的凭据；独立 checkout | 同步上游，核对依赖与领取，派发任务，推送自有写手成果并创建 PR；不批准或合并 |
| 自有写手 | 不持有 GitHub 凭据；独立 worktree 与任务分支 | 实现、自检、交付提交；由指挥推送仓内分支，不直接推 main |
| 监工 | 组织 GitHub App `gengyun-supervisor[bot]`；独立审查环境 | 核验证据、必要补验、批复、合并 main，并检查关联 issue 全部关闭条件；不代实现或派发 |
| 其他协作者 | 真实身份，保留已有分支与 Fork | 延续已领取任务，可实际审查他人成果；不因流程变化重做已有交付 |

- **身份与凭据：** 监工核验指定 App、组织安装及唯一目标仓库；安装令牌仅在内存使用、到期刷新，认证失败停止写操作，不自动回退个人 PAT。私钥不入库；App 不冒称第二名真人。作者不能批准自己的 PR，同账户可如实 COMMENT。
- **提交与审查：** 先核对最新 main、issue 和已有 PR，保留提交、分支、负责人、测试与审查历史；PR 注明实现者和推送者、范围、SHA/base、证据与缺项。有效规范审查可复用，只补新变化或未覆盖范围；纯文档做必要文档检查，代码做相关测试。
- **合并与完成：** 仅合并授权 main，绑定已验 SHA，核对非草稿、无冲突、适用 CI 和未解决阻塞，默认 squash；合并后确认远端。局部交付用 `Refs`，整项全部必要验收满足后留记录再关闭，不以 PR 数量虚增完成度。
- **巡检与边界：** 每四小时完整检查全部开放 PR；仅取消同 PR 的过时运行，保留当前提交及历史证据。无变化保持安静；不自动部署、付费或改权限。Android、真实能力、资料真实性、用药安全及隐私删除验收保持当前需求。

详细规则见 [AGENTS.md](AGENTS.md) 与 [PR 审查规范](docs/pr-review-policy.md)。Yu0ry 停用后的已保存成果继续接续；历史记录中的旧账号和 Fork 流程不作为新的强制要求。

## 开发环境与开始方式

新成员先读[开发指南](docs/development-guide.md)：架构、目录、模块依赖、启动、测试与部署。
Node 24.16.0、npm 11.13.0；Python 3.11+ 用于文档检查，微信开发者工具用于小程序编译。

```powershell
npm ci
$env:APP_EXECUTION_MODE = 'stub'
npm run dev:api
```

后台另开终端执行 `npm run dev:admin`。stub 仅用于隔离开发；微信配置、数据库和正式环境见指南。
缺配置时 `npm run dev:api` 会把缺失字段名打印出来且不启动服务，但它基于 `node --watch`，**不会退出、也不返回非零退出码**；需要靠退出码判定配置是否齐全时用 `npm run start --workspace @gengyun/api`（缺 `APP_EXECUTION_MODE` 实测 exit 1）。

### 本地调试地址与微信工具 CLI（供协作者连接）

```text
诊断服务地址    http://127.0.0.1:4318     （config/debug.local.json：bindHost=127.0.0.1 / port=4318 / apiBaseUrl 同值；该值即客户端拼接基址）
微信开发者工具   CLI：D:\微信web开发者工具\cli.bat    （随机器安装位置不同，下面是本机实测路径）
```

```powershell
if (!(Test-Path config/debug.local.json)) { Copy-Item config/debug.local.json.example config/debug.local.json }
node tools/prepare-wechat.mjs local --config config/debug.local.json   # 生成隔离工程 .local/wechat-local/
node tools/local-debug-server.mjs --config config/debug.local.json     # 诊断服务，监听 http://127.0.0.1:4318

& "D:\微信web开发者工具\cli.bat" islogin                                  # 需要时扫码登录；报无法连接 IDE 时先在“设置 → 安全设置”打开服务端口
& "D:\微信web开发者工具\cli.bat" open --project "$PWD\.local\wechat-local"   # 导入隔离工程并编译
& "D:\微信web开发者工具\cli.bat" auto --project "$PWD\.local\wechat-local" --auto-port 9420   # 供自动化 SDK 连接
& "D:\微信web开发者工具\cli.bat" close                                    # 关闭工程／IDE 服务（会关掉工具服务，请确认没有其它工程在用）
```

`--project` **必须传绝对路径**：CLI 在自己的工作目录解析该参数，写成 `.\.local\wechat-local` 会报 `code 10 项目路径不存在`；该错误下 `cli open` 仍返回退出码 0，不能用退出码判断成败，要看输出里是否出现 `√ open`。

- `apiBaseUrl` 是**客户端拼接基址**：客户端一律以它自行拼接（`runtime.apiBaseUrl + '/auth/…'`、`+ '/me/profile'`、`+ '/__local__/status'`），所以两种形态都合法，工具按客户端口径校验并原样保留路径（尾斜杠规范化）：
  - **诊断替身**（以下命令启动，只服务 `GET /__local__/status`）：`http://127.0.0.1:4318`，写成带前缀的 `…/api/v1` 时该端点同样可达；
  - **真实本地 API 联调**（`npm run dev:api`，业务路由在 `/api/v1`）：写成 `http://127.0.0.1:<api端口>/api/v1`；本机实测 3100 端口的本地替身 API，生成的隔离工程可直接微信登录（`POST /api/v1/auth/wechat`）——写成 origin-only 会打到 `/auth/wechat` 并 404。
- 协作者**只需**在隔离工程里勾选一次“不校验合法域名…”，并把 `apiBaseUrl` 按上面的场景填好；**共享源码与 release 副本保持校验开启**，个人设置文件不入库。
- 手机／真机**不能**使用 `127.0.0.1`：改为同网私网 IPv4 并仅对该端口放行；正式体验／比赛必须真实 HTTPS 且恢复域名校验，本地成功不算真机通过。
- 该服务只提供 `GET /__local__/status`（`execution_mode=local_stub`、`synthetic=true`、`no-store`），**不模拟**微信登录、数据库、资料、识别、ASR、LLM、审核或 TTS；未知路径、POST 与业务 `/api/v1` 一律 404。完整边界与手机联调见 [局部微信调试说明](docs/local-wechat-debug.md)。

#### 协作者如何自己完成一次真实登录

「真实登录」指：工具里的 `wx.login` 把 code 发到本地 API 的 `POST /api/v1/auth/wechat`，由服务端调微信 `sns/jscode2session` 换身份，再回一张会话令牌；不是 Demo 的模拟登录。按手里的资格选一条：

| 路径 | 需要的资格 | 服务端凭据 | 能否作为正式验收 |
| --- | --- | --- | --- |
| A 测试号 | 无，微信扫码即得 | 测试号的 AppID/AppSecret | **不能**，见 A 的限制 |
| B 官方 AppID | 必须是该小程序的项目成员 | 官方 AppID/AppSecret | 本机联调可以；正式验收另按发布流程 |
| C `stub` | 无 | 不需要 | **不能**，服务端合成身份 |

三条路径都先把客户端基址指到真实本地 API。**换一份配置，别覆盖诊断用的 `config/debug.local.json`**；`apiBaseUrl` 的端口必须与 `port` 相同（工具会校验），`/api/v1` 不能漏：

```powershell
Set-Content -Encoding ascii config/api.local.json '{"mode":"local","bindHost":"127.0.0.1","port":3100,"apiBaseUrl":"http://127.0.0.1:3100/api/v1"}'
```

（`-Encoding ascii` 是必须的：PowerShell 5.1 的 `Set-Content` 默认是 `Default`（系统 ANSI 代码页），本身不写 UTF-8 BOM；5.1 下默认写 UTF-16LE BOM 的是 `Out-File` 与重定向 `>`，写 UTF-8 BOM 的是显式 `-Encoding UTF8`。而 `prepare-wechat.mjs` 对配置做严格 `JSON.parse`，带 BOM 会直接报 `Unexpected token '﻿'`；这份配置内容全是 ASCII，用 ascii 编码两边都不会有 BOM。）

**A．测试号（没有「小程序项目成员」资格时的零门槛路径）**

```powershell
# A1. 申请测试号：浏览器打开 https://mp.weixin.qq.com/wxamp/sandbox?doc=1 ，微信扫码
#     该页由微信公众平台前端渲染，登录后即可看到测试号 AppID / AppSecret
# A2. 生成隔离工程，只把生成副本的 appid 换成你的测试号（共享工程仍是 wx4407a4b908a69a54，不会被改写）
node tools/prepare-wechat.mjs local --config config/api.local.json --appid wx<你的测试号AppID>
# A3. 起 API：real 模式共 9 项必填（DATABASE_URL / SESSION_SIGNING_KEY / DELETION_LEDGER_KEY /
#     WECHAT_APP_ID / WECHAT_APP_SECRET / 对象存储 4 项），缺项会打印字段名并拒绝启动
#     下面只给 3 个变量；其余 7 项（DATABASE_URL、SESSION_SIGNING_KEY、DELETION_LEDGER_KEY 与
#     对象存储 4 项）见 .env.example 与 docs/reference/configuration.md，至少先给 DATABASE_URL
$env:APP_EXECUTION_MODE = 'real'
$env:WECHAT_APP_ID = 'wx<同一个测试号AppID>'
$env:WECHAT_APP_SECRET = '<同一个测试号后台的 AppSecret>'
npm run dev:api
# A4. 导入隔离工程；--project 必须绝对路径，且只在这个工程里勾「不校验合法域名…」
& "<微信开发者工具安装目录>\cli.bat" open --project "$PWD\.local\wechat-local"
```

- 成功判据：工具输出出现 `√ open` 且不再提示「不是该小程序的开发者」；点登录后开发者工具 Network 里有 `POST http://127.0.0.1:3100/api/v1/auth/wechat` 且状态 200，响应 `meta.execution_mode` 为 `real`；页面回到首页，「我的」显示已登录。
- **A 的限制（必须知道）：** 测试号是**独立的小程序身份**。服务端身份摘要是 `HMAC(SESSION_SIGNING_KEY, appId + "\n" + openid)`（`services/api/src/auth/wechat.ts:52-54`），appId 参与摘要，所以同一个微信号在测试号与正式号下是**两条不同账号**，openid 也不同，**数据不互通**——换回正式号看不到测试号期间的资料与收藏。官方[测试号说明页](https://developers.weixin.qq.com/miniprogram/dev/devtools/sandbox.html)原文是「使用此账号在开发者工具创建项目进行开发测试，以及真机预览体验」，所以**开发测试与真机预览可以做**；但测试号**不能发布**，部分接口权限受限，具体以后台页面为准。团队 2026-10 的内部结论——「测试号无法开通接口权限、无法真机调试、也无法发布」（[资源需求清单](docs/资源需求清单.md)「七、常见问题」第 256 行）——只是内部记录，**不是官方原文**。因此 A 只能证明 `wx.login → code2session → 会话` 这段接通，**不能**当作正式登录验收，也不能当真实设备证据。

**B．官方 AppID + 管理员把你加成项目成员**

```powershell
# B1. 由该小程序管理员（不是你）在 微信公众平台 → 管理 → 成员管理 → 项目成员 里加入你的微信号
# B2. 用共享工程的官方 AppID 生成副本（不加 --appid）
node tools/prepare-wechat.mjs local --config config/api.local.json
# B3. 起 API：AppID 是官方 wx4407a4b908a69a54，AppSecret 用该小程序后台的密钥
#     同样只给 3 个变量；其余 7 项必填（DATABASE_URL、SESSION_SIGNING_KEY、DELETION_LEDGER_KEY 与
#     对象存储 4 项）见 .env.example 与 docs/reference/configuration.md，至少先给 DATABASE_URL
$env:APP_EXECUTION_MODE = 'real'
$env:WECHAT_APP_ID = 'wx4407a4b908a69a54'
$env:WECHAT_APP_SECRET = '<官方小程序后台的 AppSecret>'
npm run dev:api
```

- 成功判据：工具不再提示「不是该小程序的开发者」，能编译并扫码登录；Network 里同一个 `POST /api/v1/auth/wechat` 返回 200、`meta.execution_mode` 为 `real`；服务端拿到的 openid 属于官方小程序（与 A 得到的账号不同）。
- 「项目成员」可添加的人数上限随账号类型和后台策略调整，**以后台「成员管理」页显示为准**（本轮未取得官方正文，不写死数字）。

**C．`APP_EXECUTION_MODE=stub` 合成登录（只验接线）**

```powershell
$env:APP_EXECUTION_MODE = 'stub'
$env:API_PORT = '3100'
npm run dev:api
# 另开终端：客户端仍按 config/api.local.json 生成（端口 3100、基址含 /api/v1）
node tools/prepare-wechat.mjs local --config config/api.local.json
```

- 成功判据：登录返回 200 且 `meta.execution_mode` 为 `stub`；客户端会话缓存里 `executionMode` 是 `stub`（客户端只接受 `real`／`stub`／`preset_demo`）。
- C 不发真实网络请求：服务端把 code 直接派生成稳定 subject（同一 code 同一用户，`services/api/src/auth/wechat.ts:69-75`）。它证明的是「客户端 → 本地 API → 会话」接线，**不证明**微信凭据。

**报错对照表**

| 看到的现象 | 判定 | 动作 |
| --- | --- | --- |
| 响应 `INVALID_REQUEST`「微信登录凭证无效或已使用」（微信 errcode `40029`） | code 已被用过，或不属于当前 AppID（拿测试号的 code 配官方 AppID 必现） | 重新点一次登录（每次 `wx.login` 都是新 code，别并发点两次）；核对副本 `appid` 与服务端 `WECHAT_APP_ID` 是同一个号 |
| 同上（微信 errcode `40163`） | 仓内与 `40029` 同分支处理（`services/api/src/auth/wechat.ts:123`）：code 已使用或失效 | 同上 |
| 微信 errcode `40013`（`invalid appid`），最终返回 `PROVIDER_OUTCOME_UNKNOWN`「微信登录未返回身份」 | **AppID 不合法**：抄错 AppID，或生成副本的 appid 与服务端 `WECHAT_APP_ID` 不是同一个号。`40013` 不是密钥问题——密钥不匹配是 `40125` `invalid appsecret`。仓内只把 `45011` 与 `40029`／`40163` 单独处理（`services/api/src/auth/wechat.ts:120`、`:123`），其余 errcode（含 `40013`、`40125` 以及只写在注释里的 `-1`）一律落到 `PROVIDER_OUTCOME_UNKNOWN`（`services/api/src/auth/wechat.ts:126`） | 核对生成副本的 `appid` 与服务端 `WECHAT_APP_ID` 是同一个号；确认同号仍报错，再核对 `WECHAT_APP_SECRET` 是否该号后台生成的密钥；改完重启 API |
| 工具提示「不是该小程序的开发者」／导入后无法编译 | 当前扫码的微信号不是该 AppID 的项目成员 | 走 A 换成自己的测试号重新生成；或让管理员在成员管理里加你（B） |
| 请求报域名不合法（网络面板出现 `url not in domain list` 一类错误） | 隔离工程里没勾「不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书」，或你改到了共享源码 | 只在 `.local/wechat-local` 的 详情 → 本地设置 勾选；共享源码与 release 副本保持 `urlCheck=true`。从基础库 2.4.0 起网络接口允许与局域网 IP 通信，但**不允许与本机 IP 通信**，真机不能用 `127.0.0.1`（见[网络能力文档](https://developers.weixin.qq.com/miniprogram/dev/framework/ability/network.html)） |
| 客户端提示「登录失败，HTTP 404」，服务端日志里路径是 `POST /auth/wechat` | `apiBaseUrl` 漏了 `/api/v1`：客户端按 `apiBaseUrl + '/auth/wechat'` 拼接，业务前缀由 `services/api/src/contract.ts` 的 `API_PREFIX` 与 `services/api/src/routes/auth.ts:43` 决定 | 把 `apiBaseUrl` 改成 `http://127.0.0.1:<端口>/api/v1` 后重新生成 |

客户端只显示服务端返回的 `error.code`（或 `HTTP <状态码>`），定位时以 API 响应体为准。

## 用户端前端：先按 Demo 落地

2026-10-14 用户直接确认：当前先开发 docs/ui-demo/demo.html 的 Demo 版本样式，适老版本后续开发，恢复时间待用户决定。当前按 Demo 手机预览的色板、字号、间距、卡片、导航和交互形态审查；独立适老模式、正文统一18px、触控统一44px、最大系统字号、老年用户专用布局与多机型字体矩阵属于后续适老阶段，不作为当前 Demo 样式或可复用组件 PR 的阻塞条件。已实现的字号支持和触控保护保留，不要求为迎合 Demo 删除。当前仍需关键文字与操作可见、可点、无遮挡，状态明确且模拟标记清楚；权限、隐私、用药安全及真实业务验收不因此放宽。暂缓不等于适老验收通过，既有编号与历史证据保留。

用户于 2026-10-10 确认：后续前端暂以[网页版交互 Demo](docs/ui-demo/demo.html)为视觉与交互参考，再落地原生微信小程序。GitHub 显示 HTML 源码，下载文件后用浏览器打开；顶部可切换“手机预览”，无需后端或安装依赖。

- 底部入口从左到右为 **首页、社区、识别、消息、我的**；“识别”居中，文字放大加粗，图标和底色突出，保留完整可点击区域。
- 延续耕云绿色与科技感，视频页突出生成进度、近期／十年／二十年时间线；其余页面沿用一致的字体、卡片、按钮和状态呈现。
- Demo 覆盖五个主页面、模拟登录、识草／标签确认、资料查询与收藏、问答、社区、消息、个人中心及视频预览；是暂定界面参考，后续可根据用户体验调整。

| 顺序 | 推荐开发步骤 | 交付边界 |
| --- | --- | --- |
| 1 | 先体验 Demo，确认页面层级、导航、字号与关键操作；统一正常、空内容、加载、失败和重试状态 | 先确定可复用样式与交互，避免逐页重复设计 |
| 2 | 在 `miniprogram/` 用 WXML／WXSS／JavaScript 落地五 Tab 和公共组件；保留已有成果，按实际合并树处理冲突 | HTML 是参考，不替换小程序技术栈；字体适配、TabBar 安全区和末屏内容用实际渲染核对 |
| 3 | 复用已合并的会话、登录返回和知识列表／详情组件，优先补齐正式微信登录与查询联调，再连接识别流程 | 组件已合并不等于正式端到端通过；不能用 Demo 模拟登录替代验证 |
| 4 | 按[开发顺序与依赖](docs/development-order.md)逐项接现有 API 契约，再扩展文字问答、语音、社区、消息及情景视频 | 文字问答不等待完整 ASR；外发授权与审核守卫随相应能力接入；视频接口与合成细节见[增补需求](docs/features/pesticide-demo-video.md) |
| 5 | 每次提交一个可验证范围，运行相关检查与微信编译；结合可用真机确认实际操作和字号效果 | 复用有效证据，按范围审查；模拟器、Android 真机与真实供应商证据分列，适用缺项记录待验证；iOS 暂缓 |

Demo 的识别、问答、语音输入和发布审核均为前端模拟；视频为本地 Canvas 动画，不输出真实 MP4、不预测药效。演示账号和本机存储不替代正式鉴权、隐私、来源或验收，也不计入 issue 完成数。独立网页后台继续使用现有架构，不套用小程序五 Tab。

## 推荐任务推进列表

建议接下来围绕 **“在 Android 手机上走通一段完整 Demo”** 推进。实测 `main` 基线为 `8205cfc`（2026-10-18）；已有组件可以直接接续，当前重点是页面接线、真实操作和缺项收尾。

下面是建议顺序，沿用已有 issue 和负责人；组件开发可以并行，不必等前置整项关闭才开始。[现行依赖规则](https://github.com/GengYunChuChao/GengYun/blob/main/docs/development-order.md)

| 顺序 | 推进内容 | 本批完成标志 |
|---|---|---|
| **1．完成五 Tab Demo 的正常使用** | **#28**：复用已合入的 #142 组件，统一首页、社区、识别、消息、我的样式；补齐跳转、返回、空态、加载、失败和重试。游客按现有规则进入登录页 | 在微信工具及现有 Android 手机上确认关键页面能看、按钮能点、导航能返回；模拟内容标识明确 |
| **2．贯通第一条用户链路** | **#4 → #5 → #7，接 #16 的知识收藏**：登录→手选作物／地区→搜索→详情→收藏／取消收藏→退出 | 用户能连续完成这段操作；退出或来源失效后，页面和接口处理一致。手选地区先完成，自动定位随后补 |
| **3．把识别入口做成完整流程** | **#6、#9、#10、#8，接 #16 的识别历史**：上传／拍照→处理状态→结果核对→资料详情→历史。前端先复用明确标注的模拟数据；真实服务按依赖接入 | 先交付可操作的 Demo 流程，再分别证明真实识草、OCR 接入。无法确认来源或条件时不展示实际用量 |
| **4．接文字问答，再增加语音** | **#12 → #11 → #13**：先完成输入文字、返回有来源回答和失败提示，再接语音转文字及播报 | 文字问答独立可用；语音逐步完成“录音→核对文字→发送→播放”。复用已有 OCR／ASR／TTS 调用证据，仅补产品链路缺项 |
| **5．贯通社区、消息和必要后台** | **#14 → #15，配合 #17、#18**：先完成发帖与审核状态，再接评论、点赞、消息跳转及下架联动；后台优先支持这段流程必需的操作 | Demo 状态与真实审核清楚区分；真实发布满足审核要求，消息只能跳转到当前用户可访问的对象 |
| **6．完成整体验收和交付** | **#19、#21、#22、#23、#24**：汇总真实能力、持久化、删除恢复、权限、Android 完整演示和部署准备 | 各项承诺都有对应证据，剩余限制明确；满足全部验收的 issue 才关闭 |

**有三条工作应从现在并行推进，避免后面等待：**

- **基础收尾：#1、#2。** #1 重点补正式契约和运行版本冻结记录；#2 复用已有安装、构建、启动证据，核清剩余条件。这两项值得优先争取关闭，无需等待全部业务功能。
- **资料与样本：#3、#20。** 持续准备核准资料、标签和独立样本；按能力分批准备，避免最后集中补齐。
- **真实接入与隐私：#27、#29，以及 #6 的存储接入。** 按正在接入的功能补服务配置、用途授权和持久化。新增数据同步登记删除处理，完整删除恢复在集成阶段验收。

可以同时推进**眼前最优先的三件事是：**

1. **完成一次五 Tab 的正常操作走查。** 当前真机已经连通，旧冒烟脚本仍依赖过期页面结构。可先用简短人工走查取得有效证据；继续使用脚本时，只修正页面定位、Tab 顺序和登录态判断。[现场记录](https://github.com/GengYunChuChao/GengYun/issues/23#issuecomment-6182823911)
2. **完成登录→手选档案→查询详情→收藏这条连续流程。** 每次提交交付一个用户能实际完成的操作。
3. **并行收尾 #1／#2。** 随后核对 #28 是否满足当前 Demo 阶段的完整条件，满足即可关闭；不要追加全业务、适老或完整 AI 质量验收。

适老专项和 iOS 继续后置。情景视频的模板／播放器可在主链稳定后并行推进，先用合成输入，扫描入口再接 OCR。

审查随每批交付进行：已有有效证据直接复用，只补本次变化对应的缺口。下一阶段最有价值的进度标志是：**手机上新增了哪一段可以连续完成的操作。**

## 当前进度（2026-10-18）

本轮实测 `main` 基线 `8205cfc`：开放 issue 25 项、已关闭 2 项（#1、#2）、累计合入 PR 202 条、在飞 PR 5 条。已合并的功能面不少，但没有一项 issue 走完验收；缺口集中在真机、真实 AI 调用、样本签核与部署这四类外部前提上。

表分两层：`AC 判定` 是按 issue 正文验收条款逐条判定的结论，`工程缺口` 是代码与文档侧的 real 模式、partial、未接线事实；两层不互相替代。

| issue | 功能 | AC 判定 | 工程缺口 | 依据 |
| --- | --- | --- | --- | --- |
| #3 | 浙江首批资料清单与可替换数据库适配 | 待裁定 | 外部材料未取得：用量／DoseCard、八组科普评估、云库／受控 HTTPS／正式 real／双手机真机；20 份独立登记标签取得 0 份、许可全为 `false` | `docs/verification/gy-i03-zhejiang-materials.md:13-14`；`docs/verification/gy-i03-i20-materials-gap-ledger-20261015.md:11` |
| #4 | 微信登录、游客限制与服务端归属权限 | 待前置 | `loginWechat` 为 implemented，但 `stub`／`preset_demo` 用合成身份，不代表真实微信身份；真机微信身份与正式凭据未取得，换码适配器见 `services/api/src/auth/wechat.ts:9` | `docs/architecture/contract-status.json:46`；`docs/verification/gy-i05-region-profile-20261014.md:24` |
| #5 | 单作物地区档案及授权定位／手动选择 | 未纳入索引 | 真机原生授权弹窗未取得；坐标→地区转换资源未取得（首版本就不内置，页面回退手选） | `docs/verification/gy-i05-region-profile-20261014.md:23`、`:25` |
| #6 | 私有媒体上传、访问权限及 EXIF 清除 | 未纳入索引 | 句柄消费网关与真实对象存储适配器未接线，real 模式上传如实 503 `PROVIDER_UNAVAILABLE` | `docs/verification/gy-i06-private-media-20261014.md:25`、`:51` |
| #7 | 科普／除草剂查询、详情与来源版本展示 | 待前置／待证据 | 验收前置 #3／#4 仍 OPEN，真实来源与实际消费者证据未取得；契约面仍 partial：排序仍不同于冻结的 `created_at DESC`，实际表／投影无该列，排序与历史数据方案未完成（按 partial 保留，不与 AC 判定互替） | `docs/architecture/contract-status.json:649`、`:668` |
| #8 | 药剂适用过滤与标签原文用量安全边界 | 待前置／待证据 | 验收前置 #7 仍 OPEN；规则版本锚与 100 组场景用例已就位（局部条款证据，保留：用例集自述覆盖验收第 1、4 条，含计数断言）；用量侧外部资料与登记标签原文剂量仍缺（属 #3 线），登记标签 0 份、许可全为 `false` | `tests/reference/i08-scenarios-100.test.mjs:12`；`docs/verification/gy-i03-zhejiang-materials.md:13`；`docs/verification/gy-i03-i20-materials-gap-ledger-20261015.md:11` |
| #9 | 实时拍草识别、Top3 核对及不确定处理 | 未纳入索引 | real 提供者／媒体未接线时明确拒绝，替身为 stub／preset_demo；真实准确率未取得，本片不产生准确率证据 | `docs/architecture/contract-status.json:777`；`docs/verification/gy-i09-identify-candidates-20261014.md:127` |
| #10 | 实时标签 OCR、用户校正及登记精确核对 | 未纳入索引 | real 提供者／媒体／登记源未接线时拒绝；任务只有内存 store，进程重启即丢 | `docs/architecture/contract-status.json:861`；`docs/verification/gy-i10-ocr-http-20261012.md:238` |
| #11 | 普通话录音、实时 ASR 转写和发送核对 | 未纳入索引 | 在飞 [PR #248](https://github.com/GengYunChuChao/GengYun/pull/248) 未合入（实测可合并性为冲突）；转写取消未接线，真实 ASR 评估与 PG 持久化未取得 | `docs/verification/gy-i11-speech-http-20261012.md:163` |
| #12 | 有来源的语音／文字问答与回答安全检查 | 未纳入索引 | `unimplemented:no-real-` 前缀即「未接真实模型」；`createConversation` 仍 partial | `services/api/src/conversations/types.ts:52`；`docs/architecture/contract-status.json:1061` |
| #13 | 普通话 TTS、播放球及安全文本自动播报 | 未纳入索引 | 真实提供者与产物端口未接线、合成域无取消入口；真机音频与交互未取得 | `docs/architecture/contract-status.json:1041`；`docs/verification/gy-i13-synthesis-jobs-20261014.md:322` |
| #14 | 文字／图片 AI 筛查、版本重审和失败隔离 | 未纳入索引 | 本片不代表真实筛查上线或准确率；200 风险＋200 正常的独立评估由 GY-I21 执行 | `docs/verification/gy-i14-moderation-http-20261014.md:18`、`:288` |
| #15 | 真实社区发帖、评论、点赞、筛选与举报 | 未纳入索引 | real 模式下社区服务置空、整域拒绝；社区只有内存 store，无 PG 实现 | `services/api/src/app.ts:958`、`:703` |
| #16 | 收藏与可浏览的识别历史 | 待前置 | 收藏／历史已落 PG（迁移 `0018_favorites_history.sql` 随 #272 合入），契约仍 partial；真机页面证据未取得（索引 §1.5 已把它列为前置） | `docs/architecture/contract-status.json:1635`；`docs/verification/gy-i16-favorites-pg-20261017.md:210` |
| #17 | 首版应用内消息、未读状态与权限跳转 | 待前置 | 在飞 [PR #278](https://github.com/GengYunChuChao/GengYun/pull/278)（迁移 `0019_messages_persistence.sql`）；阶段 1 无路由装配、无持久化，real 模式恒 503 | `docs/verification/gy-i17-messages-20261012.md:7` |
| #18 | 独立后台资料、账号、AI 任务及功能开关 | 未纳入索引 | 在飞 [PR #279](https://github.com/GengYunChuChao/GengYun/pull/279)（迁移 `0021_admin_accounts_read.sql`）、[PR #282](https://github.com/GengYunChuChao/GengYun/pull/282)（迁移 `0020_feature_flags.sql`，实测可合并性为冲突）；`listAdminUsers` 仍 partial，真实存储与后台 UI 联调待完成 | `docs/architecture/contract-status.json:2585` |
| #19 | 注销去身份、在线 7 日／备份 30 日删除与恢复 | 不可关 | 备份副本清除未接线，各模块 `backup_state` 停留 pending，完成判定为 blocked；回执只投影进程内台账 | `docs/architecture/contract-status.json:419`、`:464` |
| #20 | 冻结独立评估样本、标准答案及评估程序 | 不可关 | 覆盖内 7 张、覆盖外 165 张，`isRealEvaluation=false`、门禁 `not_evaluated`、无任何模型成绩；样本标签 `reviewedBy` 为 `null`，独立复核未做 | `docs/evaluation/README.md:20-21`；`packages/evaluation/samples/gy-i20-weeds-labels.json:18` |
| #21 | 持续评估真实 AI 能力并汇总首版验收门槛 | 不可关 | 无任何模型成绩；门槛汇总只覆盖「可离线部分」 | `docs/evaluation/README.md:20-21`；`docs/evaluation/acceptance-thresholds-summary.md:1` |
| #22 | 权限、安全规则及首版端到端失败回归 | 待前置 | 在飞 [PR #279](https://github.com/GengYunChuChao/GengYun/pull/279)（读面）；写面已接权威、`retryable` 口径随 #256 合入收口，读面真实读数待 #279 合并后复测 | `docs/verification/gy-i22-closure-gap-20261018.md:59-80`、`:92`、`:112`、`:128` |
| #23 | Android／iOS 真机、时延容量及完整演示验收 | 不可关 | 真机设备未验证，Android 真机联网与 iOS 均未验证 | `docs/verification/platform-checklist.md:40`、`:48-49` |
| #24 | 部署联网比赛版、备份恢复并交付完整材料 | 不可关 | 演练脚本与本机恢复读数已合入（属本机演练，不等于 CVM 验收）；材料索引只做离线核验，部署目录只有准备物 | `docs/verification/gy-i24-release-materials-index-20261017.md:13`；`docs/verification/gy-i24-restore-drill-local-20261018.md:6`；`deploy/README.md:3` |
| #27 | 提前验证正式 AppID、真机域名及 AI 和数据库服务接入 | 待前置 | `request` 合法域名仍为阻塞，缺已登记服务地址；`verify-env.mjs` 两项 FAIL（生产 API HTTPS 地址、数据库连接变量） | `docs/verification/platform-checklist.md:24`；`docs/verification/gy-i27-live-ai-20261018.md:110` |
| #28 | 五 Tab 原生页面骨架、Demo 样式及统一失败状态 | 未纳入索引 | 开发者工具／模拟器／真机渲染与截图未取得；关闭还需消息页与「我的耕云」人工走查、两档演示数据 | `docs/verification/gy-i28-demo-parity-20261018.md:177-179`、`:208-213` |
| #29 | 用途授权、外发账本与隐私撤回接口守卫 | 未纳入索引 | 判据一、判据三已满足，判据二因缺生产侧第三方删除登记面而只部分满足 | `docs/verification/gy-i29-closure-20261018.md:6`、`:229` |

`AC 判定` 列取自按验收条款逐条判定的关闭材料索引（[PR #284](https://github.com/GengYunChuChao/GengYun/pull/284) 分支内的 `docs/verification/gy-issue-closure-index-20261018.md`，尚未合入；该索引生成于基线 `5250520`；**#284 HEAD 未更新，不作为关闭依据**，只作条款级线索）。索引只覆盖 13 项（#3、#4、#7、#8、#16、#17、#22、#27，以及明确不可关的 #19、#20、#21、#23、#24），其余 12 项尚无 AC 级判定，记「未纳入索引」，只列工程缺口。

**此处对索引有两处覆写，需明说**：索引原文的分布是「2 可关／4 待前置／2 待裁」。（1）其中 #22 记为待裁，本表把 #22 记为待前置，依据是仓外严重性裁定——它登记的两个发现不属「严重安全／权限缺陷」（后台账号能力脱钩方向更保守、`retryable` 语义不一致已随 #256 收口），且读面真实读数待 [PR #279](https://github.com/GengYunChuChao/GengYun/pull/279) 合并后复测。（2）索引把 #7、#8 记为可关，那只是验收条款层的判真：#7 的验收前置 #3／#4 仍 OPEN、真实来源与实际消费者证据未取得，#8 的前置 #7 仍 OPEN、登记标签原文剂量未取得，故两项整项状态改记「待前置／待证据」；条款级证据（AC 判真、100 组场景用例）原样保留，不因改记而删除。两处都是对索引口径的覆写，不表示索引也这么记；关闭权仍只在监工与用户。

在飞 PR 与迁移号：#278（`0019_messages_persistence.sql`）、#282（`0020_feature_flags.sql`）、#279（`0021_admin_accounts_read.sql`）、#248（#11 客户端切片，实测可合并性为冲突）、#284（关闭材料索引文档）。`main` 现有 18 个迁移、最大号 `0018_favorites_history.sql`（随 #272 合入），三个带迁移的 PR 须按 `#278 → #282 → #279` 合入，避免迁移号冲突。**`#282` 单解冲突不足以合入**：它另有一处已登记、仍未修的阻塞——`#282` 分支内 `services/api/src/admin/ops/flags-pg.ts:303-312` 把启动探测异常折叠为 `false`，`services/api/src/admin/ops/flag-gate.ts:433-445` 据此置 `probed=true`／`armed=false`，`:462-465` 返回 `open`，于是一次瞬时探测异常就让数据库里真实关闭的全局开关永久 fail-open 直到重启；须先修该 fail-open，且各 PR 适用 CI 转绿，未取得的新成功证据不得记通过。同期已合入 #256（#22 `retryable` 收口）、#272（#16 PG 存储）、#288／#289／#290（#24 演练脚本与索引）。未合入 PR 的结论一律不当作既成事实。

表内 `#27`／`#28`／`#29` 分别对应 `GY-I25`／`GY-I26`／`GY-I27`。`#1`、`#2` 已关闭，上文推进列表里「并行收尾 #1／#2」的表述待下一轮随列表一并更新。关联核对：#2 已 completed 关闭，本 PR 只返修进度文档、不重开 #2；#7／#8 保持 OPEN；#22 全链验收未完成。

**按 AC 判定：可关 0 项；待前置／待证据 7 项（#4、#7、#8、#16、#17、#22、#27）；1 项待裁定（#3）。关闭动作待监工／用户点头，本轮不关闭任何 issue，整项完成数仍为 0。** #3 的待裁项是「20 条 `review_status: unverified`／`achieved: 20` 是否算关闭」，指挥已给出建议「可关，附披露：条目 20／来源 validity=valid 20／逐字段复核 0／licensed=false」，最终仍由监工／用户裁定。#22 的两个已登记发现经裁定不属「严重安全／权限缺陷」（一项是后台账号能力脱钩、方向更保守；一项是 `retryable` 语义不一致、已随 #256 收口），其 AC 判定由待裁转为待前置。#7、#8 由索引的「可关」改记「待前置／待证据」，只是因为整项前置未满足：#7 待 #3／#4 且缺真实来源与实际消费者证据，#8 待 #7 且缺登记标签原文剂量证据；两者条款级证据（AC 判真、100 组场景用例）保留不删。#4、#16、#17、#27 的卡点见上表与下文「四类外部前提」。

仍卡在主干的四类外部前提：

- **真机**：#23 的双平台真机与完整演示、#5 的授权弹窗与真机微信身份、#28 的开发者工具／真机渲染证据、#16 的真机页面证据。
- **真实 AI 调用**：#9／#10／#12／#13／#14 的服务侧 real 提供者仍未接线（`docs/architecture/contract-status.json:777`、`:861`、`:1061`、`:1041`）。
- **样本签核**：#20 的独立复核与许可核实、#21 的真实能力评估。
- **部署**：#24 的实际部署与 CVM 侧恢复演练（本机演练已合入，`docs/verification/gy-i24-restore-drill-local-20261018.md:6` 明确不等于 CVM 验收）、#27 的合法域名与生产环境变量。

下一批最该推进三件事：

1. 按迁移号顺序合入 `#278 → #282 → #279`（#272 的 `0018` 已合入），让 #17／#18 落地，并据此复测 #22 的读面；`#282` 须先解冲突**并**修掉上文那处启动探测 fail-open，仅解冲突不足以合入。
2. 补 #6 的真实对象存储适配器与 #15 的社区持久化——这两处 real 模式现在整域不可用（`services/api/src/app.ts:958`）。
3. 推进 #3／#20 的外部资料与独立签核，它们同时卡住 #8、#21、#24。

逐项证据来源、取数命令与旧快照对照见 [开发进度](docs/development-progress.md) 的「2026-10-18 快照」。

## 当前范围与入口

2026-10-11 用户确认：当前阶段仅做 Android 端微信小程序适配与真机验收；iOS 暂缓，不作为本阶段 PR 合并阻塞。暂缓不等于验收通过，后续恢复时补验，恢复时间 TODO。网页后台架构及其他功能、安全、隐私和真实能力验收不变。

- 初版暂定 2026-11-15；最终阶段暂定 2027-02-28，二月功能仅规划。
- 已有工程、鉴权、科普预览、参考页面和数据库等组件；完整业务链路尚未整项验收。
- 新增[农药情景演示视频](docs/features/pesticide-demo-video.md)：模板合成、近期／十年／二十年，不要求真实效果预测；尚未实现。
- [需求入口](docs/requirements.md) · [开发顺序](docs/development-order.md) · [当前进度](docs/development-progress.md)
- [PR 审查与作者自查规范](docs/pr-review-policy.md)：提交清单、分层验证、推荐重点、问题分级、证据复用、合并与 issue 关闭；其他审查者可按同一规范自查，每 4 小时覆盖全部开放 PR。
- [详细参考与历史](docs/reference/README.md)：API、配置、数据、评估及原文档存档。

真实密钥、个人原始媒体、Word 原稿、依赖与构建输出不提交。
