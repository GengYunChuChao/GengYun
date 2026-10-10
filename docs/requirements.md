# 需求入口

原需求基线 v1.0：F01–F20、AC01–AC29 与 27 项初版任务保持编号。2026-10-10 确认新增 [VID-DEMO 情景演示视频](features/pesticide-demo-video.md)，作为单独增补，不宣称已实现。

| 主记录 | 用途 |
| --- | --- |
| [产品需求](product-requirements.md) | 定位、用户、现实协作与业务规则 |
| [代码需求](implementation-requirements.md) | 完整功能、质量目标和验收场景 |
| [视频增补](features/pesticide-demo-video.md) | 模板演示视频范围与验收 |
| [开发指南](development-guide.md) | 当前架构、运行、模块与技术边界 |

## 范围

2026-10-11 用户确认：当前阶段仅做 Android 端微信小程序适配与真机验收；iOS 暂缓，不作为本阶段 PR 合并阻塞。暂缓不等于验收通过，后续恢复时补验，恢复时间 TODO。网页后台架构及其他功能、安全、隐私和真实能力验收不变。 原需求文档及台账保留双平台目标供后续补验，本阶段以此调整为准。

首版暂定 2026-11-15 联网比赛，最终阶段暂定 2027-02-28（香港时间）。原生微信小程序＋独立后台，游客仅主页，单作物／地区档案。初版识草、OCR、科普、普通话 ASR／文字问答／TTS、AI 社区、收藏历史、应用内消息必交；人工审核只空入口。二月模块见完整需求，不因精简提前派发。

视频允许虚构且全程标识“演示视频，非真实效果预测”；此例外不放宽原有实时能力指标、登记资料、用量、权限或隐私删除。首版不启用用户训练，不生成处方混配换算。来源／种子／模拟清楚区分，数据注销在线7日／备份30日，第三方删除请求与完成分别留证据。

## 2 确认项导航

每个Q只有一份主记录，业务17项、代码12项；本轮F01至F20、AC01至AC29。T01至T06为实施准备，选型和资料交接不重开已确认需求。

| 编号 | 主题 | 主记录 |
| --- | --- | --- |
| Q01 | 产品名称与副标题：识草查药与除草科普社区 | [产品与现实业务需求](product-requirements.md) |
| Q02 | 微信小程序＋独立网页后台 | [代码实现需求](implementation-requirements.md) |
| Q03 | 比赛版2026年11月15日、最终版2027年2月28日，日期暂定 | [产品与现实业务需求](product-requirements.md) |
| Q04 | 首版真实AI社区、收藏与识别历史均必交 | [产品与现实业务需求](product-requirements.md) |
| Q05 | 浙江、4类作物、8组杂草、目标20条除草剂资料 | [产品与现实业务需求](product-requirements.md) |
| Q06 | 表单关键词、识别及普通话语音大模型提问 | [代码实现需求](implementation-requirements.md) |
| Q07 | 微信登录，不强制手机号，游客仅主页 | [代码实现需求](implementation-requirements.md) |
| Q08 | 首版AI；二月7人4票48小时评审、专审与申诉 | [产品与现实业务需求](product-requirements.md) |
| Q09 | 二月按实际使用日＋7／14日09:00观察提醒 | [代码实现需求](implementation-requirements.md) |
| Q10 | 首版应用内；二月微信推送需实际能力验证 | [代码实现需求](implementation-requirements.md) |
| Q11 | 首版不做反馈；二月轻量自报观察 | [产品与现实业务需求](product-requirements.md) |
| Q12 | 首版普通话ASR提问及播报，导航震动二月 | [代码实现需求](implementation-requirements.md) |
| Q13 | 二月专家及组织认证，职责与身份分别核实 | [产品与现实业务需求](product-requirements.md) |
| Q14 | 二月展示对接＋支付退款售后结算沙箱，收费0 | [产品与现实业务需求](product-requirements.md) |
| Q15 | 二月授权报告、20次10人门槛、周更新与CSV／PDF | [产品与现实业务需求](product-requirements.md) |
| Q16 | 实时ASR／识草／OCR／大模型与资料服务交接 | [代码实现需求](implementation-requirements.md) |
| Q17 | 注销在线7日备份30日、公开帖子去身份、第三方与模型删除 | [产品与现实业务需求](product-requirements.md) |
| Q18 | 单作物／地区档案，多次使用二月、多田块二月以后 | [产品与现实业务需求](product-requirements.md) |
| Q19 | 数据库比赛前接入，种子／模拟允许且标明，许可本轮暂缓 | [产品与现实业务需求](product-requirements.md) |
| Q20 | 软件识别和问答验收由开发侧把控，真实成果不伪造 | [产品与现实业务需求](product-requirements.md) |
| Q21 | 两阶段运行版本、源码、后台、配置和验收材料 | [代码实现需求](implementation-requirements.md) |
| Q22 | 开发侧决定5Tab绿色主题，定位仅选地区 | [代码实现需求](implementation-requirements.md) |
| Q23 | 拍草与标签OCR首版两者都做，实时调用 | [代码实现需求](implementation-requirements.md) |
| Q24 | 二月真实预警，有来源主体审核和有效撤回 | [产品与现实业务需求](product-requirements.md) |
| Q25 | 首版除草剂，降低风险表述，扩品类二月以后 | [产品与现实业务需求](product-requirements.md) |
| Q26 | 文字、普通话播报和失败重播，震动二月 | [代码实现需求](implementation-requirements.md) |
| Q27 | 用量只查原文，不生成处方、混配或自动换算 | [产品与现实业务需求](product-requirements.md) |
| Q28 | 资源具备，最终日期与清单已补齐 | [产品与现实业务需求](product-requirements.md) |
| Q29 | 独立样本、真实语音与模型评估，尚未执行 | [代码实现需求](implementation-requirements.md) |

## 参考

[开发顺序](development-order.md) · [任务台账](initial-issues.json) · [当前进度](development-progress.md) · [旧对照与确认史](archive/development-2026-10-10/docs/requirements.md)。
