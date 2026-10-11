# GY-I07 详情链接与冷启动返回验证

日期：2026-10-11（香港时间）。Refs #7，仅交付详情页的输入校验和失败导航恢复。

## 来源与范围

基线 main `830e417dc90b5c16a5b56914e0d8a855943f85de` 已含合并的 PR #77（独立审查 5481518014）。本次应用源码提交 `275c3219b458a42198a9df7df743b1ac331b2233`；后续提交仅追加测试脚本和证据。

两个详情页原先在登录门禁之前直接调用 `decodeURIComponent(options.id)`；`%`、截断或非法 UTF-8 会抛出 URIError。现对类型、原始长度、解码和 ID 字符集逐项校验，畸形输入仍经过现有登录门禁，再显示空状态，不查资料也不保留旧记录标签。有效 ID 的来源版本与资料标识保持原样。

冷启动详情页只有一层页面栈，原返回按钮的 `navigateBack` 失败后会留在详情页。现仅在失败时跳转到对应的固定资料列表；检查门禁活动状态及操作代次，隐藏页面或旧回调不能触发跳转。成功的普通返回行为保持原样。

修改范围为 `miniprogram/pages/referencedetail/referencedetail.js` 和 `miniprogram/pages/referenceseeddetail/referenceseeddetail.js`。未修改 WXML、样式、来源数据、认证协议、API、SQL 或本地部署工具。PR #76 的权限修订与 PR #67 的文档审查属于其他作者范围。

## 自动检查

- 负控制：新增 22 个路由测试在修复前基线上为 2 通过、20 失败，覆盖 URIError 与缺少失败导航恢复。
- `node --test "tests/reference/*.test.mjs" tests/local-debug.test.mjs`：137/137 通过。其中新增 22 个测试使用实际页面、门禁和只读资料代码，身份决策为受控离线输入。
- `node tools/check-wechat-project.mjs`：路由、JSON 与 JavaScript 检查通过。
- 现有本地登录 HTTP 集成：11 组通过；身份与内存存储为 synthetic，不能代表真实微信身份或数据库验收。
- 新 SDK 脚本语法、文档检查和 `git diff --check` 结果随 PR 当前 HEAD 记录。

新增测试包含两页各八种畸形 ID、游客门禁、有效编码 ID、冷栈失败返回与隐藏页面的迟到回调。

## 微信开发者工具证据

独立工程 `GengYun-I07-Detail-Routes` 来自标准微信打包产物；实际窗口 390 × 753，基础库 3.17.3。未修改认证或字体行为；实际按钮、页面栈及 `wx.login` 连接本地 HTTP API，服务端身份为 synthetic。复用自有本地 API 的 3102 端口，此次不声明新增数据库验证或线上微信身份通过。

[源码与证据哈希](assets/i07-detail-275c321-390/sources.json) 记录 72 个应用源码文件，标准工程导入 70 个。备用工程配置 `miniprogram/project.config.json` 和未被标准入口使用的旧 `miniprogram/utils/session.js` 不在该工程中。唯一运行源码差异是忽略目录中的 `miniprogram/config/runtime.js`，连接 `http://127.0.0.1:3102/api/v1`；共享配置仍关闭网络。开发工具私有配置允许本地地址，共享域名校验设置保持原样。

[观测记录](assets/i07-detail-275c321-390/observations.json) 对应以下七张截图：

- [畸形游客链接进入登录](assets/i07-detail-275c321-390/guest-malformed-login.png)：按钮登录后安全回到首页。
- [资料详情空状态](assets/i07-detail-275c321-390/referencedetail-invalid.png)、[冷启动返回查询列表](assets/i07-detail-275c321-390/referencedetail-cold-back-list.png)、[有效资料详情](assets/i07-detail-275c321-390/referencedetail-valid.png)。
- [种子详情空状态](assets/i07-detail-275c321-390/referenceseeddetail-invalid.png)、[冷启动返回种子列表](assets/i07-detail-275c321-390/referenceseeddetail-cold-back-list.png)、[有效种子详情](assets/i07-detail-275c321-390/referenceseeddetail-valid.png)。

两页冷启动栈深实测均为 1；返回后对应列表标题与实际截图一致。资料版本为 `src_moa_pd_2026@农药登记信息（2026年第9期）#bfe97d34e219`，种子仍显示“待核实·非权威”。最终七图逐张目视检查通过。

最初批次有一张列表截图捕获到旧帧；增加标题及绘制等待。第二批因等待标题拼写错误而中断，未当作通过证据。这里只提交第三批完整通过结果。当前未取得此工程的 320px 或 Android 真机证据，不借用旧 PR 的截图证明新增修改；iOS 按阶段安排暂缓。

复现脚本 [local-dev-detail-route.cjs](../../tests/integration/local-dev-detail-route.cjs)：

```text
node tests/integration/local-dev-detail-route.cjs <miniprogram-automator目录> <忽略目录中的输出目录> 9424
```

需要先将标准产物导入独立微信工程、开启自动化端口、启动已配置的本地登录测试 API。脚本只清除该独立工程的会话并操作页面，不写入登录令牌或替换 wx 认证方法。请勿把实际生产凭据接入未经审查的测试代码。

## 整项仍待完成

本次不关闭 #7。客户端目前读取随包资料；实际 `services/api/src/app.ts` 仅装配 health、auth、admin auth、consents、profile，尚未装配知识／除草剂查询路由。本地 `GET /api/v1/knowledge` 实测 404，因此生产来源下架及在线治理更新尚未接线，离线失效测试不能称为实时同步验收。

可选定位仍需获准的坐标到市县转换资源与拒绝／失败处理；生产资料需批准导入与来源证据；真实微信身份和 Android 真机验收仍需设备协作。现有 AppID 与密钥无需再次提供。未新增付费供应商请求，也未部署云端服务。
