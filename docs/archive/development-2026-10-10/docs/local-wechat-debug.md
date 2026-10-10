# 无自有域名的局部微信调试准备

记录日期：2026-10-04（UTC+8）。范围：GY-I02 / Refs #2 的局部准备，GY-I01 / PR #33 提案组件已审合入main f40f09167869f2a2d8aa563f8c8ffdf44ccf244f，整项及运行版本未冻结。本工程不依赖待审业务接口，不替代完整 GY-I02 或 GY-I26。F01/F08/F12/F13 与 AC07/AC09 仅作设计边界映射：不模拟身份、不公开未审内容、不采集媒体、不外发私有数据；未宣称应用 AC 通过。比赛 2026-11-15 的门槛及任务图保持。

## 已确认输入与原工程比较

用户确认正式注册小程序 AppID `wx4407a4b908a69a54`，原目录为 `E:\WeChatProjects\GengYun`。早先 `GenYun` 拼写对应目录不存在是当时核查结果；更正后本写手只读确认真实目录存在。正式账号类型已确认；后续工具登录及该AppID项目自动化已验证，更多成员/接口和手机权限未验。AppID 是公开标识；AppSecret、AI 凭据、数据库密码只能在服务端，不放小程序、Git或日志。

| 来源 | 实际观察 | 本轮处理 |
| --- | --- | --- |
| 用户原工程 | quickstart-wx-cloud，原生根 miniprogram/，公开基础库2.20.1、urlCheck=true；只有index/example两页，无tabBar，含cloudfunctions/ | 保留全部原文件；不执行uploadCloudFunction.sh，不部署或开通云资源，不复制个人配置或envList.js |
| 指挥只读补充的个人配置白名单 | 基础库3.17.3、urlCheck=false | 列为个人覆盖差异；本写手未读取其他个人字段，不能代表正常体验；原工程工具实际采用值未核实；本次新工程模拟器实测3.17.3 |
| chore/project-scaffold（9ce307fe6745b49b89774a380c37b748822df934） | 单页，touristappid，challenge_cup/农识宝旧名，公共urlCheck=false；README含旧病害范围，个人样例声称可覆盖AppID | 借鉴原生目录；按现需求重写入口、样例和说明，不合并整支或旧需求 |
| 本PR | 耕云，用户正式AppID，原生WXML/WXSS/JavaScript，五Tab空态；公开urlCheck=true，基础库3.5.5 | 3.5.5仅沿用开发计划兼容起点，未实测/冻结；本次新工程模拟器实际报告3.17.3，不能据此证明3.5.5兼容 |

原目录与当前worktree是两个工程。**本轮不回写 `E:\WeChatProjects\GengYun`。** 用户应导入下述版本管理工程或隔离副本，不误将原QuickStart当本次成果。

## 三种工程与实际版本

后续用户要求选择最新版本并确认当前可选版本3.17.3，公共配置目标已改为3.17.3；上表和下文的3.5.5/3.17.3差异保留为原PR历史观察，不表示当前配置仍为3.5.5。正式稳定标签尚未独立目视核验；新编译与实际SDKVersion另记于[兼容证据](../../../verification/wechat-compatibility-candidates.md)，不能用历史模拟器证据替代本次验证。双平台比赛设备、窄屏、最大字体和实际页面/录音播放门槛不变。

| 工程 | 导入根目录（含project.config.json） | 网络行为 |
| --- | --- | --- |
| 共享源码 | 仓库根；本机 `C:\Users\MR\.codex\worktrees\94b2\COC` | disabled；域名校验开启；五Tab空态，首页之外提示登录尚未接入 |
| local隔离副本 | 根下 `.local/wechat-local/` | 仅develop环境可点首页“检查本地替身连接”；trial/release及环境读取失败一律拒绝请求 |
| release安全准备副本 | 根下 `.local/wechat-release/` | disabled，urlCheck=true；不接收local配置，不包含个人设置；**不是可用比赛版本** |

`miniprogramRoot=miniprogram/`、`compileType=miniprogram`。页面本身没有npm构建要求。准备器只复制固定原生文件清单，不复制个人配置/未知文件；输出存在时拒绝覆盖，防止残留个人设置。修改公共runtime为local会拒绝打包，不能通过release参数混入HTTP或stub。本轮不提供真实业务后端，后续正式配置必须经冻结契约、HTTPS与GY-I25检查；本地HTTP例外不改正式规则。

本机实际：Node `v24.16.0`、npm `11.13.0`、Python `3.14.3`；已安装微信开发者工具 `2.02.2608080`，CLI `D:\微信web开发者工具\cli.bat`。基础库3.5.5只是配置值，**实际模拟器SDKVersion=3.17.3，五Tab编译渲染已实测**；配置与实测差异尚未作为运行版本冻结。本次官方miniprogram-automator0.12.1仅隔离安装于忽略的.supervisor/wechat-automation，--ignore-scripts/--no-audit/--no-fund/TLS校验开启，77包；有旧传递依赖弃用警告，不加入业务依赖或业务锁文件。此前框架npm安装CERT_HAS_EXPIRED及网络重置/超时记录仍保留，未降低TLS或修改共享认证，本次SDK安装成功不等于框架兼容安装通过。

## 启动、导入、停止

在仓库根运行（当前Node24标准库即可，无npm install）：

```powershell
if (!(Test-Path config/debug.local.json)) { Copy-Item config/debug.local.json.example config/debug.local.json }
node tools/prepare-wechat.mjs local --config config/debug.local.json
node tools/local-debug-server.mjs --config config/debug.local.json
```

若个人配置已存在，先检查自己的配置，勿重复覆盖。服务仅有 `GET /__local__/status`，返回 `execution_mode=local_stub`、`synthetic=true`、空能力清单及no-store；未知路径、POST、业务/api/v1均404。它只诊断网络，不模拟微信code交换、数据库、资料、识别、ASR、LLM、审核或TTS。不发送图片、音频、令牌或真实个人信息。没有公网绑定或任意外部地址配置；缺配置、非local模式、0.0.0.0、公开IPv4、地址/端口不一致、URL凭据/路径/query都失败。

微信工具选择“小程序”，导入 `.local/wechat-local` 根目录；使用公共AppID，不依赖project.private.config.json覆盖AppID。先在工具详情核实账号、编译类型、根目录和实际基础库，再编译。若个人调试需要HTTP例外，仅对这个隔离工程在“详情/本地设置”按实际UI勾选“不校验合法域名…”；工具版本的UI名称可能不同，查看实际生效设置。共享project和个人样例均默认校验开启，**不会自动为用户关闭**。个人设置如需保存，文件仍应被忽略。本机只验证隔离local的个人setting.urlCheck=false能让真实HTTP诊断成功，随后恢复true；没有验证个人AppID覆盖，不承诺该行为。CLI实际help说明传入--project时--appid会被忽略。

首页点“检查本地替身连接”，应显示“本地替身连接成功；登录、数据库、AI及业务均未接入”。停止服务后再点，应显示失败并可重试；这两项已用官方SDK在实际模拟器完成，没有mock wx.request；首次保持域名校验时失败，隔离local个人urlCheck=false后成功，停服后失败。完成后个人urlCheck已恢复true。Node验证不替代手机实测。服务终端 `Ctrl+C` 停止，无后台常驻。本次独立进程烟测已经启动4318并请求200，随后结束该进程。

再次准备时程序拒绝旧输出。先关闭那个隔离工程，保留所需个人记录，再仅删除经过核对的生成目录 `.local/wechat-local`；不要清理原E盘工程。重新运行prepare；release同理。不得复制local副本作为正常体验发布工程。

## 手机与恢复正常校验

测试号、正式账号的工具模拟器、预览、真机调试和普通体验版资格不同。用户已确认正式注册账号，仍须用具有开发者权限的微信登录工具；手机预览/真机调试要核实账号成员、设备模式及对应权限。AppID字符串不证明权限，不保证任意模式都支持HTTP例外。

电脑模拟器可用127.0.0.1；手机的localhost指手机自身。需手机联调时，在同一可信局域网，把忽略的config/debug.local.json中bindHost与apiBaseUrl都改为电脑实际私网IPv4，端口一致，重新生成local副本并重启服务。检查电脑防火墙只对该端口/专用网络授权、手机系统本地网络权限、路由AP隔离/VPN及工具实际调试模式。不要全局关闭防火墙、证书或域名校验，不把服务绑定0.0.0.0。没有设备和权限证据时记录“手机未验”，不要把浏览器200当微信成功。

恢复正常流程：停止本地服务，关闭local工程；在它的工具UI恢复域名校验；从共享根或新生成release副本重新导入，核实当前AppID、实际基础库、urlCheck=true且没有个人false覆盖，首页没有本地诊断按钮。运行下述检查。本轮release副本仍无网络和业务；正式体验/比赛需真实HTTPS配置、域名与登录/供应商/隐私验收，不可直接上传本地替身。不要执行CLI upload/云函数部署来替代验收。

官方参考：[工程配置](https://developers.weixin.qq.com/miniprogram/dev/devtools/projectconfig.html)、[网络能力](https://developers.weixin.qq.com/miniprogram/dev/framework/ability/network.html)、[CLI](https://developers.weixin.qq.com/miniprogram/dev/devtools/cli.html)。本次在线读取这些官方页失败，工具CLI help/错误提示是本机实证，详细权限与覆盖规则仍需工具/账号实测。后续可评估[云托管callContainer](https://docs.cloudbase.net/run/develop/access/mini)，需已关联环境、已部署服务及wx.cloud；本次该页读取超时，未配置env/service、未调用，原模板cloudfunctions存在不证明可用，也不替独立网页后台或私有媒体免除验证。

## 可复现验证与缺项

```powershell
python tools/validate_development_docs.py
node tools/check-wechat-project.mjs
node --test tests/local-debug.test.mjs
git check-ignore -v project.private.config.json config/debug.local.json .local/wechat-local/project.config.json .env
git check-ignore project.private.config.json.example config/debug.local.json.example .env.example
node tools/local-debug-server.mjs
node tools/prepare-wechat.mjs release
```

第一个check-ignore应匹配全部私有项；第二个应无输出、exit1（例子可提交）。无配置的服务命令预期exit1。release初次生成成功；已有输出或带--config应失败。验证脚本仅检查JSON/路径/五Tab/域名默认值/JS语法，不是WXML/WXSS微信编译器。4组Node测试实际覆盖配置负例、HTTP服务路由/no-store、客户端develop门控与失败状态、打包隔离与拒绝危险/残留配置；合成数据不证明真实登录、内容审核或媒体ACL。

实际结果：文档检查PASS（27任务）；工程静态检查PASS；4组Node测试PASS；私有项实际忽略、样例不忽略；local/release准备成功；缺配置服务exit1；独立CLI服务启动→HTTP200 synthetic→停止PASS。`git diff --check`结果随提交证据记录。CI链接与完整HEAD/base见本PR说明。

微信工具历史：首次CLI因沙箱写本地通信文件EPERM失败，安全权限重试后明确“IDE service port disabled”（错误退出码0，不能算成功）。用户随后明确开启62154；`cli islogin --port 62154`返回login=true，`cli auto --project <local根> --auto-port 9420 --port 62154`显示Using AppID和auto成功。官方SDK连接9420后实际读取platform=devtools、SDKVersion=3.17.3；五Tab DOM标题逐一匹配，local按钮显式状态成功及停服失败均PASS。首次脚本过早判断busy=false导致读到初始状态，已修正为等待最终状态；保留该失败记录。工具加载、登录状态和该AppID项目自动化可用已验证；真实wx.login/code交换及更多账号/接口权限、手机、正式域名、供应商均未验。本轮没有预览上传、云部署、购买域名或付费开通。

完整GY-I02的dev:api/dev:admin/lint/test:unit/test:contract/build/test:mini命令、Fastify/TypeScript/Vue/Vite/pg锁定安装、独立后台、业务API、数据库连接/迁移/健康检查均未实现/未运行；本地诊断命令不能冒充它们。已保存局部提交后正常merge最新main的GY-I01已审组件，进度台账冲突保留两轮真实证据；复跑文档/112操作契约/8组既有测试PASS，不改契约、不宣布整项前置完成。严重安全、隐私、媒体授权、未审隔离与2026-11-15门槛不变。

可选工具复现实验（不在CI、不冒充完整test:mini）：按[官方SDK发布页](https://www.npmjs.com/package/miniprogram-automator)及本机包的类型声明使用connect、switchTab、systemInfo、DOM与截图API。先确保没有占用诊断4318的其他进程；工具CLI服务端口62154与自动化WebSocket9420用途不同。

```powershell
npm install --prefix .supervisor/wechat-automation miniprogram-automator@0.12.1 --ignore-scripts --no-audit --no-fund --fetch-retries=0 --fetch-timeout=20000
& 'D:/微信web开发者工具/cli.bat' auto --project "$PWD/.local/wechat-local" --auto-port 9420 --port 62154
node tools/smoke-wechat.cjs .supervisor/wechat-automation/node_modules/miniprogram-automator local
```

local烟测需要用户仅对该隔离工程确认个人urlCheck=false；脚本不关闭校验，不调用wx.login，不mock wx.request，不读取账号令牌，临时诊断进程在finally停止，SDK只disconnect，不关闭用户其他窗口。实验后把local个人urlCheck恢复true并关闭该local窗口，再auto打开独立release根，运行同脚本末参数release，验证五Tab及无本地诊断按钮。**本轮上述恢复和release烟测已执行通过**：五Tab渲染及无诊断按钮PASS；公共和生成release文件urlCheck=true，local个人文件恢复true，无个人false配置被打包。release首次SDK切换在新页面未就绪时报rawPath元数据缺失，增加等待真实页面渲染后复测PASS；重载时短暂WebSocket未连接也已用有界重试处理。截图保留.local/且不提交；模拟器截图不是手机证据。服务/项目来源未知时勿运行本烟测。
