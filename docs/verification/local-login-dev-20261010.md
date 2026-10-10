# 本地完整登录联调（Windows）

Refs #4；无需部署服务器或购买域名。此工具使用真实 PostgreSQL 和 API、合成微信身份，不读取供应商密钥，不调用真实微信身份交换或 AI，不关闭 issue。

## 使用

先安装冻结依赖 `npm ci`，准备本机 PostgreSQL17 的 bin 目录（含 initdb.exe、pg_ctl.exe）。在仓库根 PowerShell 执行：

```powershell
node tools/local-dev/prepare.mjs --pg-bin <PostgreSQL的bin绝对路径>
./.local/local-dev/start.ps1
node .local/local-dev/smoke.mjs
./.local/local-dev/stop.ps1
```

端口默认 API3100、PG55436，均仅监听127.0.0.1。准备命令支持 `--api-port 3101 --pg-port 55437`；端口必须1024..65535且不同。只在输出不存在时准备，已有输出保留并使用现有启动/停止入口，不自动删除。

开发者工具导入 `.local/local-dev/wechat`，打开首页的本地诊断按钮，再使用登录和资料查询入口。个人副本允许本地HTTP；共享 project.config.json 保留 urlCheck=true，runtime 保持 disabled。所有实际页面及导航依赖均打包；本地文案标明合成微信身份，避免把stub当正式登录。

首次启动生成私有随机密码，创建专用持久库 gengyun_local_dev，顺序应用0001至0009迁移，并准备限权API运行账号。API不使用迁移管理员。停止只停止生成目录拥有的API和PG，保留数据；重复启动迁移台账不变。若端口被其他服务占用则拒绝，不接管该服务。private目录仅当前Windows用户及SYSTEM可读；禁止把整个.local上传或发给他人。无需交接服务器密码。

## 后续修订入口

三项审查阻塞修复、实际四页冷启动/重返、当前原生PG与两详情页模拟器验证见[2026-10-11修订证据](gy-i04-pr68-revision-20261011.md)。下节保留2026-10-10历史结果，不当作新HEAD实测。

## 本轮证据（2026-10-10）

- 最初用户副本：实际API3100、原生PG17.11端口55436；9迁移完成，停止/重启后0新增、9跳过。
- 本PR通用工具：另建API3101、PG55437独立实例；9迁移完成；实际客户端源码通过HTTP建立合成会话、服务端核实、只消费一次原目标、SQL核实SHA256 bytea摘要、退出Ack及旧token401通过。
- 用户副本实际微信开发者工具：当前HTTP控制端口41195、自动化9420、官方SDK0.12.1；首页渲染、按钮实际HTTP诊断、未mock的模拟器wx.login（仅后端身份仍synthetic）、登录返回首页核实、受限资料页渲染通过。该证据来自先前已验证客户端副本，本PR重新生成副本的GUI检查结果在PR验证栏另记。
- 通用打包测试覆盖非法端口/同端口/缺PG/发布配置已改的拒绝、拒绝重用输出、保留共享域名校验、遗漏导航依赖防回归、私密文件排除。最终全套检查命令与数量在PR记录。

本轮实际HTTP发现退出携带JSON Content-Type却不带请求体会被Fastify拒绝，因此auth.logout显式发送data:{}。原探针对bytea错误使用文本比较，修正为decode后核实；GUI探针原先提前读取点击前状态，等待实际请求状态后通过。这些修正没有放宽服务端鉴权或冻结契约。

## 限制与后续

真实微信身份、Android/iOS真机、云部署、HTTPS正式域名及AI仍未验；服务器部署按用户要求暂缓。资料页仍使用既有本地资料适配层，stub模式公共资料HTTP保持503明确拒绝；尚未实现的识别、社区、消息及私有业务不伪造成功。

PG安装、版本下载、镜像构建及Windows系统服务安装不属于本工具。现有0002/0004事务嵌套的失败原子性并非本轮证明。全部角色引导只针对工具自己创建的专用集群；不要指向他人或生产数据目录。没有新增依赖、没有内嵌私钥或个人样本、没有新付费服务。
## 提交前门禁

`node --test --test-concurrency=1 tests/unit/*.test.mjs tests/privacy/*.test.mjs tests/media/*.test.mjs tests/reference/*.test.mjs` 实际536/536，无跳过；本轮新增2个打包边界测试。`node tests/integration/miniprogram-login-loop.mjs` 7组通过，HTTP适配不再替客户端补空请求体，能够检出退出回归。test:mini（4/4）、lint、build、test:docs、test:contract（6/6）均通过；PowerShell模板语法和diff检查在最终提交前验证。

可选模拟器重放（需要已有官方自动化SDK，本项目不增加SDK依赖）：先通过开发工具CLI对生成的wechat工程运行auto，显式指定auto-port 9420并使用当前IDE控制端口，再执行：

```powershell
node tests/integration/local-dev-wechat.cjs <官方SDK模块目录>
```

此脚本45秒超时退出，不关闭IDE；SDK目录只是工具依赖，不含凭据。不要并发连接同一模拟器自动化端口。GUI失败时保留已通过API/PG证据并据实际工具状态处理，不绕过真实验收门槛。
最终通用模板 PowerShell 语法、可选 GUI 脚本语法、docs、lint 与 diff 检查通过。新生成 E 盘副本的模拟器检查45秒超时，未记为通过；既有 C 盘用户副本的 GUI 成功证据与本PR通用工具的实际API/PG成功证据分开保留。曾误并发连接同一端口，已只停止本轮检查进程、保留IDE后串行重试，仍超时。后续需独立检查开发工具新工程状态，不将它视为真机/正式微信已验。
