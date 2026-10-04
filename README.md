# 耕云

**识草查药与除草科普社区。用户端已确定为原生微信小程序（WXML／WXSS／JavaScript），管理后台为独立网页。** 初版暂定 2026-11-15 联网比赛演示，整个周期至暂定 2027-02-28。

## 开发环境与开始方式

本分支在 GY-I02 局部准备之上新增**工程壳**：`services/api/`（Fastify 5 骨架：启动、`/health`、配置校验、契约错误码、`0001` 迁移与运行器）、`apps/admin/`（Vue 3 + Vite 后台骨架，仅独立鉴权入口占位）、根 npm workspaces 与统一命令、`.env.example` 与配置校验、分层 CI 及锁文件。原生五 Tab 空态工程与本地诊断替身保持不变。**登录、识别、语音、社区与业务 API 仍未实现**，用户端页面归 GY-I26。实际运行版本、逐条命令结果、未运行项与阻塞见[工程壳说明](docs/engineering-shell.md)。GY-I01 / [PR #33](https://github.com/Sek1ro-oka/GengYun/pull/33) 的提案组件已独立审查并合入main，整项及运行版本仍未冻结，不代表前置整项验收完成。已只读比较旧 `chore/project-scaffold` 与用户的 `E:\WeChatProjects\GengYun` 云模板，未修改原目录。详细差异、工具阻塞及操作见[本地微信调试说明](docs/local-wechat-debug.md)。

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

已在本地仓库的成员先核对并保存自己的改动，再从最新 main 开任务分支。工程壳已提供 `package.json`（npm workspaces）与锁文件：先 `npm install`，再按需运行 `npm run dev:api` / `npm run dev:admin` / `npm run lint` / `npm run test:unit` / `npm run test:contract` / `npm run build` / `npm run test:mini`。本机若 npm 直连超时，可按[工程壳说明](docs/engineering-shell.md)在**单条命令**加 `--proxy=http://127.0.0.1:7897`；不要改全局 npm/git 配置，不要关闭 TLS 校验。诊断运行使用 Node24 标准库；工具实测另在忽略目录隔离安装官方自动化SDK0.12.1（忽略安装脚本，TLS校验开启），不是业务依赖。实测 Node24.16.0/npm11.13.0。数据库迁移（`db:migrate`）需要真实 `DATABASE_URL`，本机无 PostgreSQL 未执行真实迁移；业务 API、真实登录、供应商与用户端页面仍未交付。

在微信开发者工具导入**含 `project.config.json` 的仓库根目录**，选择“小程序”；`miniprogramRoot` 指向 `miniprogram/`。共享工程默认无网络且开启域名校验。工具2.02.2608080初次因服务端口关闭阻塞；用户开启62154后已登录并加载本工程，五Tab及本地成功/停服失败在模拟器实测通过，实际基础库3.17.3。公共配置目标现为3.17.3，历史3.5.5仅为候选、未证明兼容；手机、真实业务未验。

初期可先准备隔离本地调试，无须先购买自有域名：

```powershell
if (!(Test-Path config/debug.local.json)) { Copy-Item config/debug.local.json.example config/debug.local.json }
node tools/prepare-wechat.mjs local --config config/debug.local.json
node tools/local-debug-server.mjs --config config/debug.local.json
```

导入生成的 `.local/wechat-local/` 根目录。诊断服务只返回合成状态，不提供业务接口；服务终端Ctrl+C停止。HTTP“不校验合法域名”如有需要，仅在这个隔离工程的个人工具UI启用；手机不能使用电脑localhost，实际同网地址、账号权限和工具模式按[说明](docs/local-wechat-debug.md)核查。正常体验/比赛必须恢复校验并验证真实HTTPS，不把本地成功算真机通过。`node tools/prepare-wechat.mjs release`生成关闭网络、拒绝local配置的安全准备副本，并非可用比赛版。原工程/云函数不自动部署。

本轮检查：`node tools/check-wechat-project.mjs`、`node --test tests/local-debug.test.mjs`；仅工程静态和局部诊断测试，不能替代微信编译或应用AC。工程壳另有 `npm run lint` / `npm run test:unit` / `npm run test:contract` / `npm run build` / `npm run test:mini` / `npm run test:docs`，本机结果与未运行项见[工程壳说明](docs/engineering-shell.md)；Node 检查不冒称微信真机通过。

## 需求、进度与协作

- [需求总览](docs/requirements.md)、[产品需求](docs/product-requirements.md)、[代码需求](docs/implementation-requirements.md)：最高优先级的业务和验收基线。
- [全周期开发文档 v1.1](docs/development-plan.md)：架构、接口、阶段、接入门槛和交付顺序。
- [GitHub 类似项目参考](docs/github-project-references.md)：核查源码后的经验、适用边界和采用决定。
- [初版任务及远端 issues](docs/initial-issues.md)、[调整记录](docs/issue-revision-log.md)、[实际进度](docs/development-progress.md)：27 项任务仅到初版目标。
- [PR 审查与合并规范](docs/pr-review-policy.md)：协作者实现，Codex 负责监工、验证与合并；每 12 小时巡检或用户消息触发。
- [GY-I01 架构与契约提案](docs/architecture/adr-001-initial-architecture.md)：数据字典、HTTP OpenAPI、状态及F／AC映射，待监工确认冻结；接口尚未实现。可运行 `python tools/validate_contracts.py` 与 `python tools/test_contracts.py` 检查设计一致性，不代表应用验收。
- [工程壳说明](docs/engineering-shell.md)：GY-I02 的 API／后台骨架、toolchain、配置校验、迁移运行器、分层 CI、实际运行版本、逐命令结果与未运行项。

首版包含拍草识别、药剂标签 OCR、普通话语音转写向大模型提问、科普查询、真实 AI 审核社区、收藏历史、应用内消息和独立后台。定位只用于选地区；人工审核板块首版为空。识别与问答实时调用，预设资料必须标明；来源不足不生成用量处方或承诺绝对安全。

原稿 Word、`doc/`、真实 `.env`、个人配置、原始媒体、令牌、依赖和构建输出不提交。文档检查通过只表示文档一致；应用与模型是否完成以对应任务证据为准。
