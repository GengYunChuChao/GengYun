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

核对基线：2026-10-11，main `441acc1`（已合并 [PR #80](https://github.com/GengYunChuChao/GengYun/pull/80)）。下表是接续建议，不重新分配任务或改变正式依赖；最新领取、提交和批复以对应 issue／PR 为准。原 27 项总体目标保留，组件验收与整项完成分开记录。

| 优先级 | 原 issue → 建议独立验收结果 | 可复用成果 | 前置依赖与剩余验收 |
| --- | --- | --- | --- |
| **阶段一（M1）首：基础并行收口**（边界标记，非新增任务） | [#1](https://github.com/GengYunChuChao/GengYun/issues/1) 契约冻结、[#2](https://github.com/GengYunChuChao/GengYun/issues/2) 可复现启动、[#27](https://github.com/GengYunChuChao/GengYun/issues/27) 平台／服务、[#29](https://github.com/GengYunChuChao/GengYun/issues/29) 用途守卫、[#4](https://github.com/GengYunChuChao/GengYun/issues/4) 正式会话、[#28](https://github.com/GengYunChuChao/GengYun/issues/28) 五 Tab 页面骨架 | 沿用下方优先级 1、2、6 行的既有可复用成果，不重复分配 | 来源：[开发顺序](docs/development-order.md) 第 13 行“基础并行收口”批次；M1 窗口 10-03 至 10-10 见[阶段计划](docs/development-plan.md) 第 14 行。不新增依赖、不改验收口径，正式依赖以[任务台账](docs/initial-issues.json)为准 |
| **阶段一（M1）尾：媒体及资料／样本准备**（边界标记，非新增任务） | [#3](https://github.com/GengYunChuChao/GengYun/issues/3) 核准资料、[#20](https://github.com/GengYunChuChao/GengYun/issues/20) 冻结样本、[#6](https://github.com/GengYunChuChao/GengYun/issues/6) 私有媒体 | 沿用下方优先级 3 行的既有可复用成果，不重复分配 | 来源：[开发顺序](docs/development-order.md) 第 14 行“资料与样本持续准备”（#3、#20）与第 16 行“安全资料与媒体”（#6，同批 #8 不在本边界列举内）；“媒体及资料／样本准备”见[阶段计划](docs/development-plan.md) 第 14 行。不新增依赖、不改验收口径 |
| 1：先收尾 | [#1](https://github.com/GengYunChuChao/GengYun/issues/1) 契约冻结；[#2](https://github.com/GengYunChuChao/GengYun/issues/2) 可复现启动；[#28](https://github.com/GengYunChuChao/GengYun/issues/28) 五 Tab 页面骨架 | #33 契约、#43 工程、#69 五 Tab、#71 工具与设备基线 | 可并行：区分已实现／规划接口；复现 API、后台和小程序启动；补齐当前五 Tab Demo 样式与关键按钮操作证据；适老字号专项后续。页面骨架不等待所有业务能力 |
| 2：首段用户链路 | [#4](https://github.com/GengYunChuChao/GengYun/issues/4) 正式会话；[#5](https://github.com/GengYunChuChao/GengYun/issues/5) 作物／地区；[#7](https://github.com/GengYunChuChao/GengYun/issues/7) 知识查询 | #59／#68／#78 会话与返回；#74／#77 资料与手选地区；#79／#80 查询 API 与原生消费者 | 复用冻结接口，补知识运行组的受限启动接续；验证正式微信身份→作物／地区→列表／详情→失效／退出。手选地区不等待定位；科普查询不等待识草、OCR 或 DoseCard |
| 3：并行补基础 | [#3](https://github.com/GengYunChuChao/GengYun/issues/3) 核准资料；[#20](https://github.com/GengYunChuChao/GengYun/issues/20) 冻结样本；[#6](https://github.com/GengYunChuChao/GengYun/issues/6) 私有媒体；[#8](https://github.com/GengYunChuChao/GengYun/issues/8) 条件匹配与原文用量 | #73／#81 来源候选；#47 评估工具；#60 媒体参考组件；#64 查询参考组件 | 四线可并行：来源候选补有效标签与适用条件，样本调参前独立冻结，媒体补 HTTP／存储／清理，规则补未知条件拒绝与用量卡守卫。#8 接续 [PR #82 批复](https://github.com/GengYunChuChao/GengYun/pull/82#pullrequestreview-5482804369)，保留已有工作 |
| 4：分能力交付 | [#12](https://github.com/GengYunChuChao/GengYun/issues/12) 文字问答优先；[#9](https://github.com/GengYunChuChao/GengYun/issues/9) 识草、[#10](https://github.com/GengYunChuChao/GengYun/issues/10) OCR、[#11](https://github.com/GengYunChuChao/GengYun/issues/11) ASR、[#13](https://github.com/GengYunChuChao/GengYun/issues/13) TTS、[#14](https://github.com/GengYunChuChao/GengYun/issues/14) 审核 | #40／#42 供应商接入证据；#72 LLM 探针；现有入口与用途守卫 | 文字问答不等完整 ASR；各能力按输入依赖接媒体、用途授权和审核。复用供应商证据，每项能力随交付完成必要独立评估，接入成功不等于质量门槛通过 |
| 5：社区与配套 | [#15](https://github.com/GengYunChuChao/GengYun/issues/15) 社区、[#18](https://github.com/GengYunChuChao/GengYun/issues/18) 后台；再接 [#16](https://github.com/GengYunChuChao/GengYun/issues/16) 收藏／历史、[#17](https://github.com/GengYunChuChao/GengYun/issues/17) 消息 | 既有鉴权、资料 API、前端骨架与独立后台工程 | 社区发布依赖适用审核；后台资料管理可先独立验收。知识收藏可先于识别历史，消息接实际事件，不重复搭建已有组件 |
| 6：贯穿开发 | [#27](https://github.com/GengYunChuChao/GengYun/issues/27) 平台／服务；[#29](https://github.com/GengYunChuChao/GengYun/issues/29) 用途守卫；[#19](https://github.com/GengYunChuChao/GengYun/issues/19) 删除恢复；[#21](https://github.com/GengYunChuChao/GengYun/issues/21) 能力评估 | 接入、授权、撤回、数据库恢复和离线评估组件 | 按服务、用途、数据域分别接续验收；真实外发前满足授权与撤回守卫，新增持久数据同步接删除。全模块删除、第三方完成证据与评估汇总留在集成验收，不重复阻塞无关局部交付 |
| 7：最终集成与发布 | [#22](https://github.com/GengYunChuChao/GengYun/issues/22) 安全回归、[#23](https://github.com/GengYunChuChao/GengYun/issues/23) Android 真机、[#24](https://github.com/GengYunChuChao/GengYun/issues/24) 发布 | 复用各组件测试、工具与设备证据 | 在所需组件就绪后验完整业务链、权限与删除恢复、Android 操作和发布配置；仅全部必要子结果通过后关闭总体 issue。iOS 本阶段暂缓 |

- **资源缺口按功能记录：** 正式微信身份、合法网络出口／域名配置阻塞对应正式联调；核准标签与条件阻塞真实农药资料和用量展示；独立样本阻塞质量验收。它们不阻塞隔离环境下的页面、接口或模板组件开发。
- **新增需求单独接续：** [情景视频](docs/features/pesticide-demo-video.md)先做模板／播放器，扫描入口接 #10，保存按需接 #6；输出应为可播放视频，并标识“演示视频，非真实效果预测”。资料库切换、地区／毒性筛选、风险标签和 IP 属地纳入后续前端接续，正式字段、来源与分类规则 TODO；危险评估与毒性分类不混用。增补不计入原 27 项完成数。
- **领取与审查：** 先读当前 issue 批复和 PR，沿用已有负责人、分支与成果；没有 assignee 不代表无人开发。负责人缺项由指挥确认，监工不派发。软件组件、资料、跨模块联调、发布分别验收，局部 PR 使用 `Refs`，整项满足条件才关闭。
- **阶段一边界标记：** 表格首部两行为阶段一（M1）的边界标记（首：基础并行收口；尾：媒体及资料／样本准备），把此前散见下方各行（尤以优先级 1 行、3 行）的 M1 内容集中对照，便于一眼看到阶段一的起止；二者是标记而非新增任务，不改变任何任务分配、优先级、依赖或验收口径，不改变[任务台账](docs/initial-issues.json)的正式依赖，也不代表任何项已完成。编号提醒：[开发顺序](docs/development-order.md) 明确 GY-I25／26／27 的实际编号分别为 #27／#28／#29，不能按任务尾号猜编号。

详细依赖见[开发顺序](docs/development-order.md)和[任务台账](docs/initial-issues.json)。本表未创建新的 GitHub 子 issue，不代表已完成拆分或追加验收通过。

## 当前范围与入口

2026-10-11 用户确认：当前阶段仅做 Android 端微信小程序适配与真机验收；iOS 暂缓，不作为本阶段 PR 合并阻塞。暂缓不等于验收通过，后续恢复时补验，恢复时间 TODO。网页后台架构及其他功能、安全、隐私和真实能力验收不变。

- 初版暂定 2026-11-15；最终阶段暂定 2027-02-28，二月功能仅规划。
- 已有工程、鉴权、科普预览、参考页面和数据库等组件；完整业务链路尚未整项验收。
- 新增[农药情景演示视频](docs/features/pesticide-demo-video.md)：模板合成、近期／十年／二十年，不要求真实效果预测；尚未实现。
- [需求入口](docs/requirements.md) · [开发顺序](docs/development-order.md) · [当前进度](docs/development-progress.md)
- [PR 审查与作者自查规范](docs/pr-review-policy.md)：提交清单、分层验证、推荐重点、问题分级、证据复用、合并与 issue 关闭；其他审查者可按同一规范自查，每 4 小时覆盖全部开放 PR。
- [详细参考与历史](docs/reference/README.md)：API、配置、数据、评估及原文档存档。

真实密钥、个人原始媒体、Word 原稿、依赖与构建输出不提交。
