# GY-I26 界面路由与状态清单

Refs #28。基线 main `910aec3`，工作分支 `feature/gui-adaptive-pages`。

本清单是任务书 evidence 第一项「五 Tab 路由和状态清单」的交付物，同时记录视觉指标与替身边界。**页面中的识别、语音、社区能力均未接入真实服务**，可点击的界面不代表功能完成。

> 本文档与 `miniprogram/` 代码逐项对应。审查时若两者不一致，以代码为准并同步修订本文档；2026-10-04 审查曾发现本文档停留在首轮改动前，现已全面对齐。

---

## 1 五 Tab 路由

| 序号 | 名称 | 路径 | 页面文件 | 游客可见 | 主要内容 |
| --- | --- | --- | --- | --- | --- |
| 1 | 首页 | `pages/home/home` | home.js/json/wxml/wxss | 是 | 三个识别入口、未接入标注、本地诊断入口 |
| 2 | 识别 | `pages/identify/identify` | identify.js/json/wxml/wxss | 可浏览，操作禁用 | 拍草／标签／文字三入口，录音与播放分离 |
| 3 | 社区 | `pages/community/community` | community.js/json/wxml/wxss | 否 | 空态、人工审核空入口、内容安全说明 |
| 4 | 消息 | `pages/messages/messages` | messages.js/json/wxml/wxss | 否 | 空态、**首版**消息类型（评论与点赞／内容审核结果／系统通知） |
| 5 | 我的 | `pages/profile/profile` | profile.js/json/wxml/wxss | 仅浏览 | 游客档案、隐私说明、状态提示 |

tabBar 在 `app.json` 注册，selectedColor 与主题绿一致；首页为唯一对游客完全开放的功能页。

消息页仅列**首版即需**的三类消息。使用计划、7／14 天用药提醒与使用反馈填写属 2027-02 之后的阶段（B01／B05／B12），**不在本版界面中作为能力出现**，也不列入「将支持」。

---

## 2 状态清单

八种状态统一由 `components/state-view` 呈现。每种状态都带**图标、标题与说明文字**，颜色仅作辅助，不单独承担信息传达。

| 状态 | key | 触发条件 | 图标 | 主色 | 默认操作 | 当前页面使用 |
| --- | --- | --- | --- | --- | --- | --- |
| 未登录 | `guest` | 未接入真实会话 | 锁 | 主题绿 | 去登录 | 社区、消息、我的 |
| 空结果 | `empty` | 查询无数据 | 空箱 | 中性 | 可由页面指定 | 社区、消息 |
| 处理中 | `loading` | 请求进行中 | 沙漏 | 蓝 | 无 | 暂无（待接入真实请求） |
| 失败 | `error` | 网络或服务失败 | 警告 | 红 | 可由页面指定 | 暂无（待接入真实请求） |
| 已取消 | `cancelled` | 用户主动取消 | 禁止 | 中性 | 无 | 暂无（待 GY-I09 拍草流程） |
| 已删除／失效 | `invalid` | 来源下架或过期 | 禁止 | 暗黄 | 无 | 暂无（待 GY-I07 内容来源） |
| 替身数据 | `stub` | 开发模式下的示例数据 | 试管 | 紫 | 无，固定标注 | 首页、识别、我的 |
| 正常 | `ready` | 有可展示数据 | — | — | 不渲染状态视图 | 暂无（待真实数据） |

**八种均已定义并可渲染，当前实际使用四种**（`guest`／`empty`／`stub`）。未使用的四种属真实请求与内容接入后的状态，随 GY-I04／I07／I09 等任务落地，不为凑数提前渲染。

替身数据额外显示「替身数据 · 仅开发模式可见」文字标签，避免与真实数据混淆。

---

## 3 视觉与可访问性指标

| 指标 | 任务书要求 | 实现位置 | 换算说明 |
| --- | --- | --- | --- |
| 主题绿 | `#1F7A45` | `app.wxss` 的 `--color-primary`；`app.json` 导航与 tabBar | — |
| 正文字号 | 优先 18px | `app.wxss` 的 `font-size: 18px` | **绝对 px，不随屏宽缩放** |
| 触控区 | ≥44px 等效 | `app.wxss` 的 `--tap-min: 44px`，由 `.btn`、`.entry` 的 `min-height` 引用 | **绝对 px** |
| 末屏预留 | 不被 tabBar 遮挡 | `.page` 的 `padding-bottom: calc(54px + env(safe-area-inset-bottom))` | tabBar 恒为 50px，故须用 px |
| 状态表达 | 颜色加文字 | `state-view` 每态含图标＋标题＋说明 | — |
| 录音与播放 | 按钮分离 | 识别页两个独立按钮，播放需先有录音 | — |
| 风险提示 | 不得写绝对安全 | 文案使用「未接入」「不能作为用药依据」 | — |

**为什么字号与触控区用 px 而非 rpx**：rpx 为屏宽 750 等分，88rpx 仅在 375px 视口等于 44px，320px 视口只有 37.55px；36rpx 正文在 320px 视口只有 15.36px，均不满足门槛。改用 px 后数值为绝对值，窄屏不再缩水。

**保留 rpx 的两处**：`.state__icon`（72rpx）与 `.mode__icon`（44rpx）为图标，图标随屏幕缩放是合理行为，且 320px 视口下仍有 30.7／18.8px，不违反门槛。

**核算方式**：`tools/verify-layout.mjs` 对 320／360／375／414／768 五档视口做静态核算并接入 CI；`.page` 底部预留原为 `100rpx`，在 320／360px 视口仅 42.7／48px，小于 tabBar 的 50px，由该核算发现并改为 54px。

**已知副作用**：`.hero__title` 为固定 28px，320px 视口下主标题由一行变为两行。绝对字号不缩，窄容器内换行增多属预期，标题换行不构成破版。

---

## 4 替身边界

| 项目 | 当前状态 | 隔离方式 |
| --- | --- | --- |
| 登录会话 | **恒为游客** | `utils/session.js` 的 `SESSION_ENABLED` 为 `false`，`isGuest()` 无条件返回 `true` 且不读存储；置为 `true` 后 `read()` 仍要求对象形态、非 `__devPreview`、含字符串 `token` |
| 拍草识别 | 未接入 | 入口仅提示，不调用相机 |
| 标签 OCR | 未接入 | 入口仅提示，不调用相机 |
| 语音转写与播放 | 未接入 | 按钮只切换本地标记，不录音不播放 |
| 文字提问 | 未接入 | 入口仅提示 |
| 社区内容 | 无数据 | 空态，不生成假帖子与假评论 |
| 消息 | 无数据 | 空态，不生成假通知 |
| 人工审核 | 空入口 | 明确写明建设中，不展示任何已审核内容 |
| 本地诊断服务 | 仅开发模式可见 | `config/runtime.js` 默认为 `mode: disabled` |

会话占位不调用任何登录或手机号授权接口，也不在本地判定权限；真实权限一律由 GY-I04 服务端负责。`tests/ui-adaptive.test.mjs` 以合成 `wx.getStorageSync` 覆盖十种缓存取值，断言关闭状态下 `isGuest()` 恒为 `true` 且不发生存储读取。

---

## 5 本任务明确不做

- 不修改 `config/runtime.js` 的 `disabled` 默认值
- 不修改 `packages/contracts/` 下任何冻结契约
- 不接入任何真实 AI、数据库或云服务
- 不申请或上报任何权限（相机、麦克风、位置均未声明）
- 不声称真机、真声音或真实识别已通过
- 不改动 `project.config.json` 的 AppID（本 PR 仅改 `libVersion`）
- 不接入第三方插件；`app.json` 仅新增 `lazyCodeLoading: requiredComponents` 以通过工具代码质量扫描

---

## 6 编译与走查

| 项目 | 结果 |
| --- | --- |
| 文档与任务图检查 | `python tools/validate_development_docs.py` → PASS（27 任务） |
| 契约一致性检查 | `python tools/validate_contracts.py` → PASS（112 操作） |
| 契约测试 | `python tools/test_contracts.py` → OK（8 项） |
| 微信工程结构检查 | `node tools/check-wechat-project.mjs` → PASS |
| 界面自动化 | `node --test tests/ui-adaptive.test.mjs` → 14 项 PASS |
| 本地诊断测试 | `node --test tests/local-debug.test.mjs` → 4 项 PASS |
| 布局静态核算 | `node tools/verify-layout.mjs` → 五档视口 PASS |
| 五 Tab 导航 | **真机预览逐一导航，五个页面均可打开**，截图已入库 |
| 截图 | **15 张已入库**（`assets/gui-adaptive-250c4d4/`，绑定提交 250c4d4）：五 Tab 真机、显示大小最大档五页、工具基本信息与本地设置、代码质量扫描、编译成功 |

**未完成的走查项**：

| 项目 | 原因 | 归属 |
| --- | --- | --- |
| 窄视口布局实测 | 真机（一加 Ace 3V）显示大小最大档，视口约 318dp，五页无破版 | **已实测**（见证据文档 7.3.1／7.3.2） |
| 放大字号走查 | 微信字体设置无效；**系统显示大小最大档实测整体放大且不破版** | **已实测**（见证据文档 7.3） |
| 登录态界面 | 登录能力依赖 GY-I04，尚未开始 | [GY-I04](https://github.com/Sek1ro-oka/GengYun/issues/4) |

数值门槛（44px 触控区、18px 正文、54px 末屏预留）已由 `verify-layout.mjs` 静态核算覆盖；仍需真机验证的是系统级字体缩放是否生效、极窄容器下的实际换行与溢出。

> 本任务不重复验收语音服务准确率，也不代替 GY-I13 的播放生命周期验证。基础库以 `project.config.json` 的 `libVersion` 为准，本轮曾将不可选的 `3.5.5` 修正为候选 `3.5.8`（未实测、未冻结，详见 `docs/verification/gui-adaptive-evidence.md`）。
