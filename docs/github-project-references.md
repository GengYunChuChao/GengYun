# GitHub 类似项目核查与采用决定

核查日期：2026-10-03。依据原仓库 README、代码和 GitHub 提交元数据；下列链接绑定已读提交，后续更新须重新核查。没有运行这些项目，也没有验证其宣传准确率、服务可用性或部署结果。外部项目仅提供实施经验，耕云的[产品需求](product-requirements.md)和[代码需求](implementation-requirements.md)仍决定范围与验收。

## 1 与耕云相关的原始项目

| 项目与已读提交 | 核查事实 | 对耕云的采用决定 |
| --- | --- | --- |
| [微信官方 miniprogram-demo](https://github.com/wechat-miniprogram/miniprogram-demo/tree/0fe5c7df8e90582dd0b89e283df7fe32e04413f9)，最后提交 2026-09-03，MIT | 原生小程序示例、云函数、录音播放及自动化样例；录音页区分 recording／playing 并在页面隐藏时停止活动 | 沿用原生目录与 API 生命周期思路，GY-I02／13／26 验证隐藏、退出、取消、监听器与播放器释放；不复制整个示例或其中点单 Agent 功能 |
| [zijiecai 植物识别小程序](https://github.com/zijiecai/wechat-app-plant-recognition/tree/df074cb6b0f2832325cb58b7efe4b05725738ca6)，最后提交 2020-06-02，未发现明确 LICENSE | 页面传图片给云函数，云函数调用百度植物识别，页面展示候选与识别失败 | 借鉴“媒体→服务端识别适配→候选→百科”的分层；耕云增加归属、拒识、来源和安全校验，不把首候选当正确结论；不沿用源码中写入凭据的配置方式 |
| [oldinaction/ChatGPT-MP](https://github.com/oldinaction/ChatGPT-MP/tree/84f8cd432ef19afcd7f55e3f864107b8adbac725)，最后提交 2025-02-17 | 有小程序及服务端聊天、超时配置、额度管理；LICENSE 被 GitHub 标识 GPL-3.0，README 另有商用限制声明 | 采用服务端网关、独立超时和额度限制的思路；耕云不显示未安全检查的流式回答，不引入会员广告充值，不迁移其 JDK8／Vue2／Uniapp 技术栈；许可证描述有差异，本轮不复制代码 |
| [AlexOlsen/DeepWeeds](https://github.com/AlexOlsen/DeepWeeds/tree/da084f62bcd1a2b0afeb8b81f1a27be3186391a1)，最后提交 2020-10-05 | 澳洲昆士兰杂草实景数据，包含 Negative 类和独立训练／验证／测试子集；仓库 Apache-2.0，README 另列资料 CC BY 4.0 | 借鉴负样本、固定独立测试集和类别混淆分析。地区及物种与浙江清单不同，不直接当首版八类验收集，不沿用论文准确率或旧训练依赖 |
| [miniprogram-auto-test](https://github.com/Zi-Yi-Ming/miniprogram-auto-test/tree/915cb24f03d5006021594cb772ac34ae3a3a33a0)，最后提交 2026-10-02，MIT | CI 对普通 Node 代码做语法／冒烟检查；另有本机微信开发者工具验证。属于第三方兼容层 | 借鉴测试分层；GY-I02 固定工具版本并验证原生自动化，本项目普通 CI 不冒称微信真机通过。兼容层只有复现必要问题后才考虑引入，本轮不安装 |

源码入口：[官方录音生命周期](https://github.com/wechat-miniprogram/miniprogram-demo/blob/0fe5c7df8e90582dd0b89e283df7fe32e04413f9/miniprogram/packageAPI/pages/media/voice/voice.js)、[官方自动化样例](https://github.com/wechat-miniprogram/miniprogram-demo/blob/0fe5c7df8e90582dd0b89e283df7fe32e04413f9/test/index.spec.js)、[植物识别云函数](https://github.com/zijiecai/wechat-app-plant-recognition/blob/df074cb6b0f2832325cb58b7efe4b05725738ca6/cloudfunctions/flowers/index.js)、[植物候选及失败页面](https://github.com/zijiecai/wechat-app-plant-recognition/blob/df074cb6b0f2832325cb58b7efe4b05725738ca6/miniprogram/pages/index/index.js)、[服务端聊天入口](https://github.com/oldinaction/ChatGPT-MP/blob/84f8cd432ef19afcd7f55e3f864107b8adbac725/aezo-chat-gpt-api/src/main/java/cn/aezo/chat_gpt/modules/chat/ChatService.java)、[DeepWeeds 数据说明](https://github.com/AlexOlsen/DeepWeeds/blob/da084f62bcd1a2b0afeb8b81f1a27be3186391a1/README.md)、[分层 CI](https://github.com/Zi-Yi-Ming/miniprogram-auto-test/blob/915cb24f03d5006021594cb772ac34ae3a3a33a0/.github/workflows/ci.yml)。

## 2 转化为项目决策

以下是结合代码与需求形成的**耕云设计判断**，不是外部作者对耕云效果的保证。

| 判断 | 需求依据 | 任务落实 |
| --- | --- | --- |
| 用户端采用原生微信小程序，复用团队现有工程壳的目录；网页仅用作独立后台 | Q02／Q21 | GY-I01／02／26 |
| 先验证正式 AppID、真机域名、录音格式、六类 AI 服务及数据库样例，再锁定供应商 | Q16／Q19／Q23、F12／F15／F16／F20 | 新增 GY-I25，不等最终部署才接入 |
| 页面骨架与文本问答可先于完整语音流水线开发 | Q22、AC28／29 | 新增 GY-I26；GY-I12 不再硬依赖 GY-I11；GY-I13 聚焦播报 |
| 用途授权、外发记录和撤回阻断先于真实媒体／模型调用 | Q17、AC09／23／28／29 | 新增 GY-I27；GY-I19 保留全链注销与恢复验收 |
| 每种能力随实现运行独立集；模型分数不能替代登记过滤和审核规则 | Q25／Q27／Q29 | GY-I20 早期冻结；各能力 PR 提交实测；GY-I21 连续汇总、M4 签核 |
| 普通 CI、微信工具、本机真机、真实供应商四种证据分开 | AC06／07／11／12／19／23／28／29 | GY-I02 定命令，GY-I21／22／23／24 验收 |

## 3 技术与平台核查范围

默认实施选择 Node.js 24 LTS、TypeScript 模块化 API、Fastify 5、Vue 3 独立后台和 PostgreSQL 17，以减少语言与部署组合；这是开发侧可调整的技术决策，不是已经完成的工程。精确补丁版本、插件兼容性、锁文件和干净安装由 GY-I01／02 验证冻结。参考[Node 生命周期](https://nodejs.org/en/about/previous-releases)、[Fastify 支持策略](https://fastify.dev/docs/latest/Reference/LTS/)、[Vue 官方说明](https://vuejs.org/guide/introduction.html)、[PostgreSQL 版本支持](https://www.postgresql.org/support/versioning/)。不要把文档中的主版本选择当作已运行的兼容性测试。

微信[工具下载](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)、[工程配置](https://developers.weixin.qq.com/miniprogram/dev/devtools/projectconfig.html)、[网络能力](https://developers.weixin.qq.com/miniprogram/dev/framework/ability/network.html)页面本次浏览工具未能读取正文。因此不宣称核实了最新工具版本、个人配置覆盖或主体类目规则；GY-I25 须由团队正式账号后台和实机验证权限、域名、隐私声明及体验范围。测试号成功、本地关闭校验和网页登录成功都不能替代该验证。

## 4 参考边界

本轮只学习结构和失败处理，没有复制第三方源码、图片、模型或数据集，也不下载模型。外部仓库的付费、广告、开放角色扮演、多端和种植提醒，不进入首版。数据许可交接沿用既有需求安排；代码／数据实际引入前记录其具体来源与限制，不能把“可浏览 GitHub”当作任意复制许可。

检索结果包含静态植物演示、仅策划文档和商业展示项目；这些不能提供耕云实时识别、真实 ASR、安全审核或服务端删除完成的证据。后续参考项目必须重新记录已读提交和实际采用内容。
