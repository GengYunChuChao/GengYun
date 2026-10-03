# 耕云

**识草查药与除草科普社区。用户端已确定为原生微信小程序（WXML／WXSS／JavaScript），管理后台为独立网页。** 初版暂定 2026-11-15 联网比赛演示，整个周期至暂定 2027-02-28。

## 开发环境与开始方式

当前 `main` 是需求和开发文档基线，尚无可运行应用。协作者的 `chore/project-scaffold` 分支已有 `miniprogram/` 最小工程壳，尚未通过 PR 合并；它的旧策划描述不能替代本仓库需求。工程壳并不表示识别、登录或语音已实现。

| 工具／资源 | 用途与约定 |
| --- | --- |
| Git、GitHub 仓库访问权限 | 从最新 main 开分支，经 PR 提交；不要直接推 main |
| 微信开发者工具 Windows／macOS 稳定版 | 原生小程序编译、模拟器和真机调试；在任务中记录实际工具版本 |
| 团队正式小程序 AppID、开发者／体验成员权限 | 测试号只能用于有限界面调试；微信登录、接口权限及比赛体验必须提前实测 |
| 小程序基础库 | 沿用待审工程壳的 3.5.5 作为兼容性起点，GY-I02／25 实测后冻结；不是“最新版本”声明 |
| Node.js 24 LTS 与 npm | 工程检查、自动化测试、计划中的服务端和后台工具链；原生页面编译本身不需要 npm 构建。精确版本及锁文件由 GY-I01／02 固定。[版本依据](https://nodejs.org/en/about/previous-releases) |
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

已在本地仓库的成员先核对并保存自己的改动，再从最新 main 开任务分支。当前没有 `package.json`，不要执行不存在的 `npm install`／`npm run dev`。GY-I02 合并后提供锁定版本的安装、启动、构建和测试命令，并同步这里。

小程序工程合并后，在微信开发者工具导入**含 `project.config.json` 的仓库根目录**，选择“小程序”；`miniprogramRoot` 指向 `miniprogram/`。按团队 AppID 和已审服务配置编译，首次应看到五个入口及明确的开发状态。基础界面可在无后端情况下调试；真实业务接入后端 HTTPS API。比赛版开启合法域名校验，不能以本地“忽略域名校验”作为真机验收结果。自动化测试如需 CLI，按任务说明开启工具相应权限。

## 需求、进度与协作

- [需求总览](docs/requirements.md)、[产品需求](docs/product-requirements.md)、[代码需求](docs/implementation-requirements.md)：最高优先级的业务和验收基线。
- [全周期开发文档 v1.1](docs/development-plan.md)：架构、接口、阶段、接入门槛和交付顺序。
- [GitHub 类似项目参考](docs/github-project-references.md)：核查源码后的经验、适用边界和采用决定。
- [初版任务及远端 issues](docs/initial-issues.md)、[调整记录](docs/issue-revision-log.md)、[实际进度](docs/development-progress.md)：27 项任务仅到初版目标。
- [PR 审查与合并规范](docs/pr-review-policy.md)：协作者实现，Codex 负责监工、验证与合并；每 12 小时巡检或用户消息触发。
- [GY-I01 架构与契约提案](docs/architecture/adr-001-initial-architecture.md)：数据字典、HTTP OpenAPI、状态及F／AC映射，待监工确认冻结；接口尚未实现。可运行 `python tools/validate_contracts.py` 与 `python tools/test_contracts.py` 检查设计一致性，不代表应用验收。

首版包含拍草识别、药剂标签 OCR、普通话语音转写向大模型提问、科普查询、真实 AI 审核社区、收藏历史、应用内消息和独立后台。定位只用于选地区；人工审核板块首版为空。识别与问答实时调用，预设资料必须标明；来源不足不生成用量处方或承诺绝对安全。

原稿 Word、`doc/`、真实 `.env`、个人配置、原始媒体、令牌、依赖和构建输出不提交。文档检查通过只表示文档一致；应用与模型是否完成以对应任务证据为准。
