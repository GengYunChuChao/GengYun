# PR #80 Demo 对照、按钮修复与 320px 验证

> 2026-10-11 后续更新：本页保留当时批次及其边界。PR79已合入main；当前main＋PR80的实际微信320px→业务Fastify→原生PG五组／11图、真实合并树622文件等价核对和新HEAD交接见[最新联调证据](gy-i07-wechat-native-main-20261011.md)。本页关于尚缺微信业务联调、保持Draft、PR79未合并的陈述仅描述旧批次，不再是当前组件状态。Android真机／正式身份／真实资料等整项缺口继续保留。

2026-10-11，香港时间。应用源码固定为 `0cbfd97dbb003da7204c64b2cc14640c923fb3fb`；后续只补验证脚本和证据。原历史 390px 批次对应旧源码，不充当本轮证据。

本轮另补 [固定PR79＋PR80业务HTTP／原生PG／前端模块组合联调](gy-i07-native-business-consumer-20261011.md)；本页保留原实际微信渲染证据和其合成服务边界。

## 修订及依据

复现独立审查 5482050793 指出的 `tests/ui-adaptive.test.mjs:357` 失败：详情页顶部返回按钮缺少 `btn`。修订复用公共按钮，同时保留 Demo 返回图标、继承字号及随字号缩放的至少 44px 高度。没有删除或放宽全页面检查。新增负例实际移除 btn、将继承字号改为 12px、将最小高度改为 32px，均被检查拒绝。

逐项读取原始 [Demo](../ui-demo/demo.html) 的 library/article、移动端 CSS 和图标路径后修订：

| 元素 | 本轮实现 |
| --- | --- |
| 搜索 | 带 Demo 搜索图标、白底边框、45px 左内距 |
| 筛选 | 可换行圆角 chips；使用冻结 API 支持的作物、杂草、地区和更多条件 |
| 卡片 | 白底 12px 圆角、绿色叶片插画、白色同心圆、分类元信息、标题及独立证据标签 |
| 按钮 | Demo 10px 圆角与 #176b50；公共字体与触控下限继续生效 |
| 详情 | 返回图标、插画／元信息／标题／正文层级、来源版本和审核状态统计块 |
| 长来源 | 版本、取得时间、URL 可换行，原文链接复制入口保留 |

图标以原 Demo 的 leaf/search/back SVG 路径本地栅格化为 96×96 透明 PNG，不依赖外部图片。科研来源、核对状态、模拟来源分别标识；无收藏、提问、视频假成功。列表保留单列以容纳 18px 正文和长来源；来源统计块空间不足时换行。Demo 的 UI 分类与冻结 API 不相同，因此没有虚构 type 筛选。模式提示、资料条件不足和失败清空文案继续可见。五 Tab、已合登录／档案、API、SQL、角色、tools/local-dev 均未改动。

## 原图和同宽对照

[列表对照](assets/i07-knowledge-0cbfd97-320/library-comparison.png) · [详情对照](assets/i07-knowledge-0cbfd97-320/detail-comparison.png) · [24 张原生截图联系表](assets/i07-knowledge-0cbfd97-320/contact-sheet.png) · [源码／证据哈希](assets/i07-knowledge-0cbfd97-320/manifest.json)。

左侧来自浏览器实际渲染原 Demo，仅注入明确记录的正文／控件 18px、h1 24px、控件至少 44px 的 CSS，不替换内容、结构或示例数据。复现入口 `node tests/integration/demo-reference.cjs`，访问本机 3131 的 `/demo#library`。浏览器视口宽 320、高 1000，截图裁剪固定 320px 宽，避免 full-page 扩展到横向溢出宽度后缩小字号；原 Demo 分类排版的局部拥挤仍保留，未修饰原型。

右侧是官方 SDK 采集的实际微信页面。systemInfo 为 windowWidth=320、windowHeight=504、基础库 3.17.3。开发者工具机型名 iPhone 5，platform=devtools，属于模拟器，不能记为 Android 或 iOS 真机。原生 PNG 保留全部导航栏；并列图按已知 320 CSS px 宽进行等比像素归一化，裁去上方 64 CSS px 状态／导航栏，并明确标出不同滚动截图，未拼成虚构的一张长页面。两列高度不同，宽度及正文 CSS 字号相同。

标准字号实测正文 18px，列表按钮最小高度约 45.20px；受控大字实测正文 23.4px，最小高度约 57.20px。大字通过临时覆写应用 refreshFontScale=1.3 驱动既有页面字体逻辑，finally 恢复；没有认证覆写，也不冒充用户在微信或 Android 系统里实际设置的大字。几何脚本另外检查搜索框、chips、卡片、详情标题、来源统计和 URL 的左右边界，以及返回按钮字号与至少 44×倍率的高度，标准和大字均通过。

## 验证及复现

本轮通过微信工程 JSON／路由／JS 检查、smoke 脚本语法、local-debug、ui-adaptive、knowledge-client、knowledge-layout、miniprogram-profile、profile-ui-http，及 verify-layout、8 组 knowledge-consumer-http、diff 检查。执行了 local-preparation workflow 的所有本地检查步骤，包括私有配置应忽略／example 不应忽略；依赖锁未变化，沿用已有 Node 24.16.0 依赖安装。新增 3 项布局回归含丢失字号／高度负例。未把交叠测试相加宣称独立覆盖数。

官方微信工具重新编译独立 GengYun-I07-Knowledge 工程。标准与大字各 10 张原生截图、各完整六场景闭环：游客门禁与实际 wx.login；空结果；503 清旧列表；来源版本变化拒绝旧正文；重新读取 v2 的 null 条件与空 DoseCard；来源撤回后清空详情并重读空列表。后端服务、身份与资料是 synthetic，wx.login 的返回不等于真实服务端微信交换验收。截图脚本最后恢复合成 v1 与首页，大字脚本恢复字体函数。

```text
node tests/integration/knowledge-http-fixture.cjs 3120
node tests/integration/local-dev-knowledge-ui.cjs <SDK目录> <标准截图目录> 9425
node tests/integration/local-dev-knowledge-ui.cjs <SDK目录> <大字截图目录> 9425 1.3
node tests/integration/local-dev-knowledge-geometry.cjs <SDK目录> <几何截图目录>
```

哈希清单将共享 runtime 与忽略副本运行地址分开；实际导入 81 个文件与固定应用源码逐项一致（文本 LF 归一化、PNG 原字节）。备用工程配置与未用旧 session 模块不在标准导入清单。

## 依赖与剩余验收

发布前只读核对 PR #79 最新 HEAD `9275762f3d91bbb1673fecd449c38d8b37b5cf80`，仍 open、未合并。该渲染批次没有运行该 HEAD 的业务 HTTP／PostgreSQL，因此这份替身渲染证据不证明真实前后端集成；后来固定组合的前端模块＋业务HTTP／原生PG七组证据见上方独立链接。本 PR 保持 Draft，请求独立复验按钮修复、Demo 对照和组件检查；正式业务集成与主线合并运行树、Android 真机、实际微信身份和生产资料／来源撤回仍待验证。整项 #7 不关闭，DoseCard 仍为零，iOS 本阶段暂缓。
