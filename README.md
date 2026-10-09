# 耕云

**识草查药与除草科普社区。用户端已确定为原生微信小程序（WXML／WXSS／JavaScript），管理后台为独立网页。** 初版暂定 2026-11-15 联网比赛演示，整个周期至暂定 2027-02-28。

## 开发环境与开始方式

本分支在 GY-I02 局部准备之上新增**工程壳**：`services/api/`（Fastify 5 骨架：启动、`/health`、配置校验、契约错误码、`0001` 迁移与运行器）、`apps/admin/`（Vue 3 + Vite 后台骨架，仅独立鉴权入口占位）、根 npm workspaces 与统一命令、`.env.example` 与配置校验、分层 CI 及锁文件。原生五 Tab 空态工程与本地诊断替身保持不变。**主仓库已有公共科普预览 API 与数据库组件；完整登录、识别、语音、社区业务链路仍未验收**，用户端页面归 GY-I26。实际运行版本、逐条命令结果、未运行项与阻塞见[工程壳说明](docs/engineering-shell.md)。GY-I01 / [PR #33](https://github.com/Sek1ro-oka/GengYun/pull/33) 的提案组件已独立审查并合入main，整项及运行版本仍未冻结，不代表前置整项验收完成。已只读比较旧 `chore/project-scaffold` 与用户的 `E:\WeChatProjects\GengYun` 云模板，未修改原目录。详细差异、工具阻塞及操作见[本地微信调试说明](docs/local-wechat-debug.md)。

| 工具／资源 | 用途与约定 |
| --- | --- |
| Git、GitHub 仓库访问权限 | 从最新 main 开分支，经 PR 提交；不要直接推 main |
| 微信开发者工具 Windows／macOS 稳定版 | 原生小程序编译、模拟器和真机调试；在任务中记录实际工具版本 |
| 团队正式小程序 AppID、开发者／体验成员权限 | 用户确认正式注册账号 wx4407a4b908a69a54；工具已登录且该AppID项目自动化可用，更多接口/成员与手机权限未验。测试号与正式账号是**不同资格**：测试号、模拟器、预览、真机调试、普通体验版的能力需各自核实，测试号通过不能替代正式账号验证 |
| 小程序基础库 | 目标 `3.17.3`（用户确认当前可选最新版本）；`3.5.5` 保留为历史未验证候选，GY-I02／25 实测后冻结；正式稳定标签与双平台兼容仍待独立核验 |
| Node.js 24 LTS 与 npm | 工程检查、自动化测试、服务端和后台工具链；原生页面编译本身不需要 npm 构建。**锁文件已提交**（`package.json` 精确版本 + `package-lock.json`），实测 fastify 5.12.5 / typescript 5.9.3 / vue 3.5.43 / @vue/compiler-sfc 3.5.43 / vite 7.3.6 / @vitejs/plugin-vue 6.0.9 / pg 8.23.1。本机 Node `24.16.0` / npm `11.13.0`。[版本依据](https://nodejs.org/en/about/previous-releases) |
| Python 3.11 或以上 | 当前文档检查，只用标准库；不代表后端采用 Python |
| HTTPS 测试服务、私有对象存储、关系数据库和供应商测试配置 | 按 GY-I25 验证域名、证书、额度、权限和删除能力，配置由服务端保管 |

微信工具从[官方下载页](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)获取。AppID 是应用标识；AppSecret、供应商密钥、数据库密码只进入服务端安全配置。不要默认依靠 `project.private.config.json` 覆盖 AppID，覆盖效果须实测；公共工程使用统一的团队标识，个人工具设置放忽略文件。

新成员克隆并开始协作：

```powershell
git clone https://github.com/Sek1ro-oka/GengYun.git
cd GengYun
git switch -c feature/你的任务
git --version
python --version
python tools/validate_development_docs.py
```

已在本地仓库的成员先核对并保存自己的改动，再从最新 main 开任务分支。工程壳已提供 `package.json`（npm workspaces）与锁文件：先 `npm install`，再按需运行 `npm run dev:api` / `npm run dev:admin` / `npm run lint` / `npm run test:unit` / `npm run test:contract` / `npm run build` / `npm run test:mini`。本机若 npm 直连超时，可按[工程壳说明](docs/engineering-shell.md)在**单条命令**加 `--proxy=http://127.0.0.1:7897`；不要改全局 npm/git 配置，不要关闭 TLS 校验。诊断运行使用 Node24 标准库；工具实测另在忽略目录隔离安装官方自动化SDK0.12.1（忽略安装脚本，TLS校验开启），不是业务依赖。实测 Node24.16.0/npm11.13.0。数据库迁移（`db:migrate`）需要服务端私密 `DATABASE_URL`；截至2026-10-08，隔离本机和 CI 的 PostgreSQL 17.11 已有组件实测，公共科普 API、来源撤回恢复、未审暂存导入与精确回滚已合入。运行顺序、受限角色和证据边界见[数据库运行交接](docs/verification/database-run-handoff.md)；这不代表云数据库、正式小程序业务或整项服务已验收。

在微信开发者工具导入**含 `project.config.json` 的仓库根目录**，选择“小程序”；`miniprogramRoot` 指向 `miniprogram/`。共享工程默认无网络且开启域名校验。工具2.02.2608080初次因服务端口关闭阻塞；用户开启62154后已登录并加载本工程，五Tab及本地成功/停服失败在模拟器实测通过，实际基础库3.17.3。公共配置目标现为3.17.3，历史3.5.5仅为候选、未证明兼容；手机、真实业务未验。

初期可先准备隔离本地调试，无须先购买自有域名：

```powershell
if (!(Test-Path config/debug.local.json)) { Copy-Item config/debug.local.json.example config/debug.local.json }
node tools/prepare-wechat.mjs local --config config/debug.local.json
node tools/local-debug-server.mjs --config config/debug.local.json
```

导入生成的 `.local/wechat-local/` 根目录。诊断服务只返回合成状态，不提供业务接口；服务终端Ctrl+C停止。HTTP“不校验合法域名”如有需要，仅在这个隔离工程的个人工具UI启用；手机不能使用电脑localhost，实际同网地址、账号权限和工具模式按[说明](docs/local-wechat-debug.md)核查。正常体验/比赛必须恢复校验并验证真实HTTPS，不把本地成功算真机通过。`node tools/prepare-wechat.mjs release`生成关闭网络、拒绝local配置的安全准备副本，并非可用比赛版。原工程/云函数不自动部署。

本轮检查：`node tools/check-wechat-project.mjs`、`node --test tests/local-debug.test.mjs`；仅工程静态和局部诊断测试，不能替代微信编译或应用AC。工程壳另有 `npm run lint` / `npm run test:unit` / `npm run test:contract` / `npm run build` / `npm run test:mini` / `npm run test:docs`，本机结果与未运行项见[工程壳说明](docs/engineering-shell.md)；Node 检查不冒称微信真机通过。

## 当前推荐开发顺序（2026-10-08）

本次核对基线为 main `b37075df3bf7ad654186f4afa49de79c1758548c`。以下是协作者的**开发队列与并行安排**，不改变[正式任务依赖](docs/initial-issues.json)和需求验收。前置组件已审入时，可以基于契约开发及隔离替身联调；真实用户数据、第三方外发和整项验收必须满足对应前置。不要把表格读成“等前一个 issue 关闭才开始下一个”。

**最近目标：先贯通微信登录 → 手选作物／地区 → 有来源科普查询 → 退出及失效处理；再接确定性药剂过滤与有引用的文字问答，随后补普通话语音、识草／OCR和社区。** 每段同时交客户端、API、权限／失败路径和实际证据。文字问答不等待 ASR，页面不等待 TTS；首版所有必交功能仍须完成。

### 先处理已有成果与阻塞

截至本次核对，27 个初版 issue 均仍开放。契约、工程壳、评估框架和[数据库 PR #51—#55 的已审组件及交接](docs/verification/database-run-handoff.md)已经可复用，禁止重复搭建连接池、迁移器或另一套暂存库。完整标签与独立样本仍缺，实际可用 DoseCard 为 0。

| 优先项 | 当前事实与下一步 | 协作方式 |
| --- | --- | --- |
| GY-I27／[#29](https://github.com/Sek1ro-oka/GengYun/issues/29)，[PR #45](https://github.com/Sek1ro-oka/GengYun/pull/45) | [当前批复](https://github.com/Sek1ro-oka/GengYun/pull/45#pullrequestreview-5417513253)仍要求修复数据入口访问器触发撤回后保存的问题；参考组件合入后仍需 API／实际存储接线 | 原作者优先修当前阻断，不新建第二套授权；先于真实采集和外发 |
| GY-I04／[#4](https://github.com/Sek1ro-oka/GengYun/issues/4)，[PR #49](https://github.com/Sek1ro-oka/GengYun/pull/49) | [当前批复](https://github.com/Sek1ro-oka/GengYun/pull/49#pullrequestreview-5417513718)仍要求修复幂等重试登录在退出后继续签会话、旧回调恢复客户端登录态的问题 | 与隐私组件按冻结接口并行修订，整项仍需前置及真实身份／实库／真机证据 |
| GY-I26／[#28](https://github.com/Sek1ro-oka/GengYun/issues/28)，[PR #39](https://github.com/Sek1ro-oka/GengYun/pull/39) | [当前批复](https://github.com/Sek1ro-oka/GengYun/pull/39#pullrequestreview-5454527027)仍要求接入官方字体比例来源、同步证据及补当前渲染；远端另报与 main 冲突 | 原作者解决冲突，按新 SHA 补编译及当前字体／窄屏画面；页面线可并行 |
| GY-I25／[#27](https://github.com/Sek1ro-oka/GengYun/issues/27)，[PR #50](https://github.com/Sek1ro-oka/GengYun/pull/50) | [当前批复](https://github.com/Sek1ro-oka/GengYun/pull/50#pullrequestreview-5419872010)仍要求修复请求前预算／尝试持久化、错误判定与费用口径 | 先用离线回归修复；不需要靠追加付费请求解决这些缺陷 |
| GY-I03／[#3](https://github.com/Sek1ro-oka/GengYun/issues/3) 与 GY-I20／[#20](https://github.com/Sek1ro-oka/GengYun/issues/20) | 数据库运行机制已经交付，下一步是 20 份完整核准标签、八组科普和真实独立样本／答案；96 条汇总暂存不能替代标签 | 资料与评估人员现在就开始，不等全部业务代码；[样本缺口](docs/evaluation/sample-gap-register.md)按真实来源统计 |

这些是**当前提交的事实快照**。领取前重新核对 issue 评论、已有 PR、最新 HEAD 和批复；没有 assignee 不等于无人实现。保留作者成果，先接续已有 PR，不重复领取或覆盖他人分支。过期开发时段不自动续推，聊天派发和审查通知仍以用户当次授权为准。

### 分批推进与交付结果

每一行的任务均须核对机器台账的全部依赖。资料准备、样本收集、页面和权限组件可分线并行；表中“完成”指整项收口所需结果，不能仅凭一个 PR 或 CI 绿灯签核。

| 批次 | 任务与真实 GitHub issue | 本批应交付的结果／进入条件 |
| --- | --- | --- |
| 1．基础收口，立即并行 | GY-I01 [#1](https://github.com/Sek1ro-oka/GengYun/issues/1)、GY-I02 [#2](https://github.com/Sek1ro-oka/GengYun/issues/2)、GY-I25 [#27](https://github.com/Sek1ro-oka/GengYun/issues/27)、GY-I27 [#29](https://github.com/Sek1ro-oka/GengYun/issues/29)、GY-I04 [#4](https://github.com/Sek1ro-oka/GengYun/issues/4)、GY-I26 [#28](https://github.com/Sek1ro-oka/GengYun/issues/28) | 复用现有工程／契约，优先清已有 PR 阻断，补运行冻结、正式微信身份、授权守卫接线与五 Tab。接入按每种能力登记，不能把 GY-I25 全项等待变成所有开发停工 |
| 2．资料与评估，从现在持续进行 | GY-I03 [#3](https://github.com/Sek1ro-oka/GengYun/issues/3)、GY-I20 [#20](https://github.com/Sek1ro-oka/GengYun/issues/20) | 可复核科普、标签、有效条件／禁限用与资料版本；真实样本独立标注、去重、冻结及标准答案。评估程序已存在，资料不足明确拒绝，不造剂量或凑样本；调参前冻结独立集 |
| 3．第一段用户链路 | GY-I05 [#5](https://github.com/Sek1ro-oka/GengYun/issues/5)、GY-I07 [#7](https://github.com/Sek1ro-oka/GengYun/issues/7) | 前置组件具备后接真实会话、手选档案、科普搜索／详情与来源失效；定位后接且仅用于选地区。展示来源不足／空结果，验证退出与对象归属。此段不代替药剂和问答验收 |
| 4．安全资料与私有媒体 | GY-I06 [#6](https://github.com/Sek1ro-oka/GengYun/issues/6)、GY-I08 [#8](https://github.com/Sek1ro-oka/GengYun/issues/8) | 各自前置满足后并行：私有上传、类型／EXIF／取消清理；基于核准资料做确定性适用过滤、登记制剂精确匹配与标签原文。资料不全时拒绝产卡，不生成处方／混配／换算 |
| 5．实时能力，按各自依赖分线 | GY-I12 [#12](https://github.com/Sek1ro-oka/GengYun/issues/12)、GY-I11 [#11](https://github.com/Sek1ro-oka/GengYun/issues/11)、GY-I09 [#9](https://github.com/Sek1ro-oka/GengYun/issues/9)、GY-I10 [#10](https://github.com/Sek1ro-oka/GengYun/issues/10)、GY-I13 [#13](https://github.com/Sek1ro-oka/GengYun/issues/13)、GY-I14 [#14](https://github.com/Sek1ro-oka/GengYun/issues/14) | 先文字问答与来源／安全检查；ASR 经核对再发送，TTS 只播已检查文本；识草 Top3／拒识、OCR 校正／精确核对、文字图片筛查分别交真实接入和当期独立评估。各项按正式依赖进入，不要求先完成整条语音链 |
| 6．社区与配套业务 | GY-I15 [#15](https://github.com/Sek1ro-oka/GengYun/issues/15)、GY-I18 [#18](https://github.com/Sek1ro-oka/GengYun/issues/18)、GY-I16 [#16](https://github.com/Sek1ro-oka/GengYun/issues/16)、GY-I17 [#17](https://github.com/Sek1ro-oka/GengYun/issues/17) | 真实 AI 先审后发、评论／举报／版本重审；独立后台与开关实际生效。识别记录产生后接收藏历史，社区真实事件产生后接应用内消息；人审首版只空入口 |
| 7．全模块删除与回归 | GY-I19 [#19](https://github.com/Sek1ro-oka/GengYun/issues/19)、GY-I21 [#21](https://github.com/Sek1ro-oka/GengYun/issues/21)、GY-I22 [#22](https://github.com/Sek1ro-oka/GengYun/issues/22) | 每个模块开发时就注册删除处理器、评估和失败用例；此处汇总在线 7 日／备份 30 日、第三方确认与恢复重放、模型门槛及跨模块安全回归。缺确认不标删净，未知训练能力首版关闭 |
| 8．真机与交付 | GY-I23 [#23](https://github.com/Sek1ro-oka/GengYun/issues/23)、GY-I24 [#24](https://github.com/Sek1ro-oka/GengYun/issues/24) | M1 即准备 Android／iOS 设备与 HTTPS，每段链路当期做真机检查；最终按需求网络条件、样本量和容量指标全量复验，再以已审版本和单独部署授权交比赛版、备份恢复和操作材料 |

人员不足时按“已有阻断修复 → 第一段用户链路 → 文字问答 → 语音／识别 → 社区与配套 → 全量验收”安排主要实现者；资料／样本和平台准备从现在同步进行。数据库通用导入、审核发布和审计归档按明确消费者需求补齐，不能持续扩基础设施而让登录与权限修订停滞。

### 为什么仍是 0／27，以及怎样改善

“0／27”是**完整 issue 验收数**：本次官方 API 核对 27 项均未关闭，已有组件不等于整项无工作。契约、工程、资料目录、评估框架及数据库已合入，但还没有通过整项验收的用户业务功能。

| 原因 | 可核查事实 | 推进调整 |
| --- | --- | --- |
| issue 的验收范围大，组件结果被总数隐藏 | GY-I25 同时覆盖六类服务、微信／真机、数据库与删除能力；一个接入成功不能关闭整项 | 在 issue/PR 分列“已审组件、剩余必交、阻塞输入”，仍满足原要求才 Closes，不靠放宽验收制造完成数 |
| 实施重心长期停留在基础组件 | 数据库 PR #51—#55 已连续交付，登录／授权／页面的已有 PR 仍未合入，首段业务未贯通 | 基础复用，先修当前关键 PR，再做客户端→API→真实数据的最小完整链路；不把所有基础任务整项关闭当开工条件 |
| 返修没有清掉行为缺陷 | #45、#49、#39、#50 的最新批复仍有实际保存／会话／字体／预算或判定反例，而各自 CI 可为绿 | 开工即读当前批复；针对触发条件补回归，再绑定新 SHA 复审，不只增加与实现同形的单元测试 |
| 内容、样本和平台输入未与代码同步交付 | 20 条公告记录不等于完整核准标签；独立真实样本索引到位统计仍为 0；云 HTTPS、双平台和隐私消费者仍缺 | 为每项缺口明确输入提供者、交接内容和时间；可行组件并行开发，阻塞如实登记，不能用模拟替代最终证据 |
| 旧台账容易误导领取与安排 | 部分历史行仍写待领取／旧 HEAD，与现有开放 PR 不一致 | 以最新 main、issue 讨论、当前 PR HEAD／批复为准；同时记录组件成果和业务闭环，不用历史快照当实时状态 |

推进慢既有外部输入依赖，也有开发安排与缺陷修订的因素。后续每份 PR 先写明本次可验证结果、依赖和证据；已有阻断优先处理，每个数据模块同时接授权／归属／删除，核心链路尽早做微信工具与真机验证。详细正式依赖和历史推荐序列见[完整开发顺序](docs/development-order.md)，其中 2026-10-05 状态仅为历史快照；当前队列采用本节并在开工时再次核对远端。

## 需求、进度与协作

写手新协作规则：用户于2026-10-09要求免费组织私有上游＋个人私有 Fork、独立身份和 clone，上游仅 Read／必要时 Triage；[迁移状态与执行规范](docs/fork-collaboration.md)保留既有成果和审查。组织名为 GenYunChuCao，平台迁移尚待核验，不能将本文视为已完成权限隔离。

- [需求总览](docs/requirements.md)、[产品需求](docs/product-requirements.md)、[代码需求](docs/implementation-requirements.md)：最高优先级的业务和验收基线。
- [全周期开发文档 v1.1](docs/development-plan.md)：架构、接口、阶段、接入门槛和交付顺序。
- [初版 27 项开发顺序与并行建议](docs/development-order.md)：推荐队列、可以并行的条件、当前优先事项及 PR 证据；协作者开始前先核对已有领取和成果。
- [GitHub 类似项目参考](docs/github-project-references.md)：核查源码后的经验、适用边界和采用决定。
- [初版任务及远端 issues](docs/initial-issues.md)、[调整记录](docs/issue-revision-log.md)、[实际进度](docs/development-progress.md)：27 项任务仅到初版目标。
- [PR 审查与合并规范](docs/pr-review-policy.md)：协作者实现，Codex 负责监工、验证与合并；每 12 小时巡检或用户消息触发。
- [GY-I01 架构与契约](docs/architecture/adr-001-initial-architecture.md)：提案组件经 PR #33 审入，可供下游开发；整项运行冻结与业务接口未因此完成。可运行 `python tools/validate_contracts.py` 与 `python tools/test_contracts.py` 检查设计一致性，不代表应用验收。
- [工程壳说明](docs/engineering-shell.md)：GY-I02 的 API／后台骨架、toolchain、配置校验、迁移运行器、分层 CI、实际运行版本、逐命令结果与未运行项。

首版包含拍草识别、药剂标签 OCR、普通话语音转写向大模型提问、科普查询、真实 AI 审核社区、收藏历史、应用内消息和独立后台。定位只用于选地区；人工审核板块首版为空。识别与问答实时调用，预设资料必须标明；来源不足不生成用量处方或承诺绝对安全。

原稿 Word、`doc/`、真实 `.env`、个人配置、原始媒体、令牌、依赖和构建输出不提交。文档检查通过只表示文档一致；应用与模型是否完成以对应任务证据为准。
