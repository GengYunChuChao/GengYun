# GY-I07 原生知识消费者：冻结契约与 Demo 布局

> 2026-10-11 后续更新：本页保留当时批次及其边界。PR79已合入main；当前main＋PR80的实际微信320px→业务Fastify→原生PG五组／11图、真实合并树622文件等价核对和新HEAD交接见[最新联调证据](gy-i07-wechat-native-main-20261011.md)。本页关于尚缺微信业务联调、保持Draft、PR79未合并的陈述仅描述旧批次，不再是当前组件状态。Android真机／正式身份／真实资料等整项缺口继续保留。

日期：2026-10-11（香港时间）。Refs #7，仅知识列表／详情前端组件，不关闭整项。

最新修订与 320px 实测见 [Demo 对照与窄屏验证](gy-i07-knowledge-demo-320-20261011.md)。以下 390px 批次保留为历史证据，不能替代新源码验证。

本轮另补 [固定PR79＋PR80业务HTTP／原生PG／前端模块组合联调](gy-i07-native-business-consumer-20261011.md)；它不等于微信工具或当前main集成。

## 基线与依赖

开发基线 main `487918856a0099d6c7ee5f083069bd415b095bee`。PR #78 已合并，独立审查 5481700848 与 14 项检查通过；PR #76 已合并，审查 5481696724 与 13 项检查通过。没有重修这些已合组件。

依赖 [服务端 PR #79](https://github.com/GengYunChuChao/GengYun/pull/79)，本次只读核对其 `0a72820be794f3da25d3f9178028a0ec14ba737d`：注册冻结 `GET /knowledge`、`GET /knowledge/{id}`，SourceRef.id 为 sources.id，version 为关联当前 source_versions.version，updated_at 为 retrieved_at（来源取得时间）；conditions=null、dose_cards=[]。缺生育期、种植方式或场景证据的筛选空／404，不能猜条件。PR #79 不是本次微信工具使用的 HTTP 服务，未把作者原生 PG 证据记为自己的前后端集成。

本 PR 可独立审查前端组件；业务服务端依赖合并／有可审查运行树之后，仍须补实际前后端联调和主线合并树复验。现有 local-dev 启动角色白名单尚未组合 knowledge_runtime，本次未扩权或修改它。

## 实现与资料边界

新增 `utils/knowledge-api.js` 与 `pages/knowledge/`、`pages/knowledgedetail/`，通过现有首页、登录门禁和返回白名单进入。标准打包工具只同步页面及依赖清单，不修改 tools/local-dev、API、SQL 或角色。

- 仅消费冻结 Knowledge，严格校验封套 Meta、UUID、SourceRef、Conditions、分页和执行模式；没有额外 source_version 字段，不把 Herbicide、制剂或 seed item 当同一种响应。
- 来源 version 原样显示、取得时间来自 updated_at，科研／经验／混合证据与核对状态分别标识。模拟资料和 stub/preset_demo 明示；无合法未知枚举时拒绝展示，来源 validity=unknown/expired/conflicting/withdrawn 清空正文。
- 此组件不消费非空 DoseCard：遇到该响应停止展示并说明尚未接入。条件整体 null 明示“条件资料不足”，不补条件、剂量、处方或专家认证。
- q／cursor／limit／六个条件字段按冻结格式输入；分页保留不透明游标，拒绝重复／循环游标，每一页替换旧页，避免混合不同时间读取的资料；失败时清空并可重试。
- 每次进入或重返页面重新核实会话并发 HTTP 请求，返回详情不复用本地记录。令牌＋sessionEpoch、页面门禁和读取代次共同阻止旧查询、隐藏页、退出、换号及同令牌重新建立会话后的迟到回写。
- 列表到详情仅保留会话绑定的来源引用／修订比较值和条件，不持久化记录或用其授权；详情重新请求。来源 ID／版本／时间、资料 revision 或相关来源状态变化时清空正文，要求返回列表重新查询。直接链接无旧引用时展示本次实际读取结果。
- 首页并行保留静态参考与待核实种子入口，明确“本地静态资料／本地·待核实·非权威”。HTTP 失败不会静默转成本地资料成功。

## Demo 布局依据

按用户补充采用 [docs/ui-demo/demo.html](../ui-demo/demo.html) 的 `library()`／`article()` 布局：标题与副标题、搜索区、可换行筛选 chips、资料卡片、证据与核对标签、正文／适用条件／来源区和返回入口。当前 Demo LF SHA256 为 `06efa451e0c327107857ed7380e74fdb339b6aa8678c92baed7162cb8d057b72`。

用原生 WXML/WXSS/JS 实现并沿用现有公共按钮／卡片；不拷贝 Demo 示例药剂、剂量、收藏或提问假成功，不扩展视频。小屏单列资料卡，正文 18px 与至少 44px 操作区不使用 Demo 预览里的小字号。五 Tab 顺序、居中识别、已合登录／档案和安全区布局保持现有实现。

## 实际验证

1. `node --test "tests/reference/*.test.mjs" tests/local-debug.test.mjs tests/unit/miniprogram-login-return-to.test.mjs tests/unit/miniprogram-login-lifecycle.test.mjs tests/unit/miniprogram-profile.test.mjs`：229/229 通过。其中新增实际页面／auth／navigation／page-gate／client 回归 39 项；HTTP 响应与身份受控合成，不等于真实微信或业务后端。
2. `node tests/integration/knowledge-consumer-http.mjs`：8 组实际回环 HTTP 传输通过，实际客户端＋合成服务／身份／资料，覆盖编码、条件缺证据、分页、来源变更、撤回、503 与会话拒绝。
3. `node tools/check-wechat-project.mjs`：原生路由／JSON／JS 通过。标准 release/local 产物回归验证十二页及新依赖完整。
4. SDK 脚本语法、文档 27 项／链接／依赖检查和 diff 检查随固定 HEAD 核对。
5. 独立标准工程 `GengYun-I07-Knowledge`：实际 390 × 753，基础库 3.17.3；正文 18px，已测按钮最小高度约 45.20px。实际 wx.login、按钮、页面栈及回环 HTTP，不覆写认证或字体；服务身份与资料为 synthetic/stub。

应用源码 `3ce1a5569f05821f9fc4f715a5a6ed71fde6c488`，后续只新增 SDK 脚本与证据文档。[哈希与标准导入清单](assets/i07-knowledge-3ce1a55-390/sources.json)、[窗口及场景观测](assets/i07-knowledge-3ce1a55-390/observations.json) 对应以下十张最终截图：

- [游客进入登录](assets/i07-knowledge-3ce1a55-390/guest-login.png)、[搜索与筛选](assets/i07-knowledge-3ce1a55-390/knowledge-search.png)、[当前资料卡](assets/i07-knowledge-3ce1a55-390/knowledge-result.png)。
- [无结果](assets/i07-knowledge-3ce1a55-390/knowledge-empty.png)、[服务失败](assets/i07-knowledge-3ce1a55-390/knowledge-failure.png)、[版本变化拒绝旧正文](assets/i07-knowledge-3ce1a55-390/knowledge-version-changed.png)。
- [重新读取详情](assets/i07-knowledge-3ce1a55-390/knowledge-detail.png)、[原文来源及版本](assets/i07-knowledge-3ce1a55-390/knowledge-source.png)、[撤回后详情清空](assets/i07-knowledge-3ce1a55-390/knowledge-withdrawn.png)、[返回列表重新读取空结果](assets/i07-knowledge-3ce1a55-390/knowledge-withdrawn-list.png)。

初次 SDK 脚本把空数据严格比较 null，官方 SDK 实际将该值读作 undefined，导致断言中断；诊断显示页面正文确已清空。已改为空值与实际场景检查，只有完整最终批次作为通过证据，未借中断批次声称闭环完成。旧源码批次与联系表不提交。最终十图已逐张目视检查，撤回列表截图显示实际空结果提示。

标准工程导入全部新增文件；共享源码／共享域名校验仍关闭联网／开启校验。只有忽略目录中的运行配置指向回环合成服务 `http://127.0.0.1:3120/api/v1`，以及工具私有域名例外。备用 miniprogram/project.config.json、旧且未使用的 utils/session.js 不在标准产物中，清单明确记录。

复现（独立工程先用标准工具准备，并仅在忽略副本配置本地地址及自动化端口）：

```text
node tests/integration/knowledge-http-fixture.cjs 3120
node tests/integration/local-dev-knowledge-ui.cjs <miniprogram-automator目录> <忽略目录的输出目录> 9425
```

合成服务仅监听 127.0.0.1；`/__fixture__/state` 只在测试中改变合成版本／撤回状态，不是生产管理路由，不提交微信 code、访问令牌或身份输出。原生 PG 和真实业务服务测试需要另行隔离配置，未使用生产凭据。

## 尚未验证

依赖 PR #79 的微信工具业务 HTTP／原生 PostgreSQL 消费、main合并后的运行树、Android 真机（当前新增页面 320px 标准字号及受控大字模拟器证据见最新修订）、正式微信身份／可用 HTTPS 网络、生产资料导入与真正来源撤回闭环均未通过本轮替身证据替代。旧且未变化页面的有效字体证据只作背景；iOS 本阶段暂缓。定位转换、herbicides、可用 DoseCard、后台来源审核及整项 #7 继续保留。

没有服务器部署、新付费调用、生产凭据读取、作者自批或合并。
