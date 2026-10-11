# 耕云

识草查药与除草科普社区：原生微信小程序、独立网页后台、Fastify API。
正式仓库：[GengYunChuChao/GengYun](https://github.com/GengYunChuChao/GengYun)。

## 开发环境与开始方式

新成员先读[开发指南](docs/development-guide.md)：架构、目录、模块依赖、启动、测试与部署。
Node 24.16.0、npm 11.13.0；Python 3.11+ 用于文档检查，微信开发者工具用于小程序编译。

```powershell
npm ci
$env:APP_EXECUTION_MODE = 'stub'
npm run dev:api
```

后台另开终端执行 `npm run dev:admin`。stub 仅用于隔离开发；微信配置、数据库和正式环境见指南。

## 用户端前端：先按 Demo 落地

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
| 1：先收尾 | [#1](https://github.com/GengYunChuChao/GengYun/issues/1) 契约冻结；[#2](https://github.com/GengYunChuChao/GengYun/issues/2) 可复现启动；[#28](https://github.com/GengYunChuChao/GengYun/issues/28) 五 Tab 页面骨架 | #33 契约、#43 工程、#69 五 Tab、#71 工具与设备基线 | 可并行：区分已实现／规划接口；复现 API、后台和小程序启动；补齐当前五 Tab 大字号与关键按钮操作证据。页面骨架不等待所有业务能力 |
| 2：首段用户链路 | [#4](https://github.com/GengYunChuChao/GengYun/issues/4) 正式会话；[#5](https://github.com/GengYunChuChao/GengYun/issues/5) 作物／地区；[#7](https://github.com/GengYunChuChao/GengYun/issues/7) 知识查询 | #59／#68／#78 会话与返回；#74／#77 资料与手选地区；#79／#80 查询 API 与原生消费者 | 复用冻结接口，补知识运行组的受限启动接续；验证正式微信身份→作物／地区→列表／详情→失效／退出。手选地区不等待定位；科普查询不等待识草、OCR 或 DoseCard |
| 3：并行补基础 | [#3](https://github.com/GengYunChuChao/GengYun/issues/3) 核准资料；[#20](https://github.com/GengYunChuChao/GengYun/issues/20) 冻结样本；[#6](https://github.com/GengYunChuChao/GengYun/issues/6) 私有媒体；[#8](https://github.com/GengYunChuChao/GengYun/issues/8) 条件匹配与原文用量 | #73／#81 来源候选；#47 评估工具；#60 媒体参考组件；#64 查询参考组件 | 四线可并行：来源候选补有效标签与适用条件，样本调参前独立冻结，媒体补 HTTP／存储／清理，规则补未知条件拒绝与用量卡守卫。#8 接续 [PR #82 批复](https://github.com/GengYunChuChao/GengYun/pull/82#pullrequestreview-5482804369)，保留已有工作 |
| 4：分能力交付 | [#12](https://github.com/GengYunChuChao/GengYun/issues/12) 文字问答优先；[#9](https://github.com/GengYunChuChao/GengYun/issues/9) 识草、[#10](https://github.com/GengYunChuChao/GengYun/issues/10) OCR、[#11](https://github.com/GengYunChuChao/GengYun/issues/11) ASR、[#13](https://github.com/GengYunChuChao/GengYun/issues/13) TTS、[#14](https://github.com/GengYunChuChao/GengYun/issues/14) 审核 | #40／#42 供应商接入证据；#72 LLM 探针；现有入口与用途守卫 | 文字问答不等完整 ASR；各能力按输入依赖接媒体、用途授权和审核。复用供应商证据，每项能力随交付完成必要独立评估，接入成功不等于质量门槛通过 |
| 5：社区与配套 | [#15](https://github.com/GengYunChuChao/GengYun/issues/15) 社区、[#18](https://github.com/GengYunChuChao/GengYun/issues/18) 后台；再接 [#16](https://github.com/GengYunChuChao/GengYun/issues/16) 收藏／历史、[#17](https://github.com/GengYunChuChao/GengYun/issues/17) 消息 | 既有鉴权、资料 API、前端骨架与独立后台工程 | 社区发布依赖适用审核；后台资料管理可先独立验收。知识收藏可先于识别历史，消息接实际事件，不重复搭建已有组件 |
| 6：贯穿开发 | [#27](https://github.com/GengYunChuChao/GengYun/issues/27) 平台／服务；[#29](https://github.com/GengYunChuChao/GengYun/issues/29) 用途守卫；[#19](https://github.com/GengYunChuChao/GengYun/issues/19) 删除恢复；[#21](https://github.com/GengYunChuChao/GengYun/issues/21) 能力评估 | 接入、授权、撤回、数据库恢复和离线评估组件 | 按服务、用途、数据域分别接续验收；真实外发前满足授权与撤回守卫，新增持久数据同步接删除。全模块删除、第三方完成证据与评估汇总留在集成验收，不重复阻塞无关局部交付 |
| 7：最终集成与发布 | [#22](https://github.com/GengYunChuChao/GengYun/issues/22) 安全回归、[#23](https://github.com/GengYunChuChao/GengYun/issues/23) Android 真机、[#24](https://github.com/GengYunChuChao/GengYun/issues/24) 发布 | 复用各组件测试、工具与设备证据 | 在所需组件就绪后验完整业务链、权限与删除恢复、Android 操作和发布配置；仅全部必要子结果通过后关闭总体 issue。iOS 本阶段暂缓 |

- **资源缺口按功能记录：** 正式微信身份、合法网络出口／域名配置阻塞对应正式联调；核准标签与条件阻塞真实农药资料和用量展示；独立样本阻塞质量验收。它们不阻塞隔离环境下的页面、接口或模板组件开发。
- **新增需求单独接续：** [情景视频](docs/features/pesticide-demo-video.md)先做模板／播放器，扫描入口接 #10，保存按需接 #6；输出应为可播放视频，并标识“演示视频，非真实效果预测”。资料库切换、地区／毒性筛选、风险标签和 IP 属地纳入后续前端接续，正式字段、来源与分类规则 TODO；危险评估与毒性分类不混用。增补不计入原 27 项完成数。
- **领取与审查：** 先读当前 issue 批复和 PR，沿用已有负责人、分支与成果；没有 assignee 不代表无人开发。负责人缺项由指挥确认，监工不派发。软件组件、资料、跨模块联调、发布分别验收，局部 PR 使用 `Refs`，整项满足条件才关闭。

详细依赖见[开发顺序](docs/development-order.md)和[任务台账](docs/initial-issues.json)。本表未创建新的 GitHub 子 issue，不代表已完成拆分或追加验收通过。

## 当前范围与入口

2026-10-11 用户确认：当前阶段仅做 Android 端微信小程序适配与真机验收；iOS 暂缓，不作为本阶段 PR 合并阻塞。暂缓不等于验收通过，后续恢复时补验，恢复时间 TODO。网页后台架构及其他功能、安全、隐私和真实能力验收不变。

- 初版暂定 2026-11-15；最终阶段暂定 2027-02-28，二月功能仅规划。
- 已有工程、鉴权、科普预览、参考页面和数据库等组件；完整业务链路尚未整项验收。
- 新增[农药情景演示视频](docs/features/pesticide-demo-video.md)：模板合成、近期／十年／二十年，不要求真实效果预测；尚未实现。
- [需求入口](docs/requirements.md) · [开发顺序](docs/development-order.md) · [当前进度](docs/development-progress.md)
- [审查规范](docs/pr-review-policy.md)：每 4 小时覆盖全部开放 PR，按改动分层检查。
- [详细参考与历史](docs/reference/README.md)：API、配置、数据、评估及原文档存档。

真实密钥、个人原始媒体、Word 原稿、依赖与构建输出不提交。
