# 开发进度与监工台账

版本：v1.0\
更新时间：2026年10月3日\
当前阶段：M1 基础与契约；范围仅初版。

## 1 已完成的治理工作

- 需求v1.0及全周期开发文档建立，初版暂定2026-11-15，最终暂定2027-02-28。
- [初版里程碑](https://github.com/Sek1ro-oka/GengYun/milestone/1)和24项issues已实际发布，未发布二月issues。
- 监工职责写入AGENTS.md、PR规范、CODEOWNERS及提交模板。
- 已启用当前聊天每12小时自动巡检（本地自动任务ID：pr），也接受用户消息触发。
- 本次仅开发治理初始化，不表示应用代码、服务接入、模型评估或功能已完成。

文档基线发布／CI／合并状态以对应GitHub PR和main为准；任务进度依据下表与远端实际记录。

M0治理基线已完成：[PR #25](https://github.com/Sek1ro-oka/GengYun/pull/25)的当前提交通过本地文档检查与远端development-docs，已合并main，提交为[4d4426d](https://github.com/Sek1ro-oka/GengYun/commit/4d4426d355d8afe91e32cc9a5a10707cb07dd3a2)。[监工验证记录](https://github.com/Sek1ro-oka/GengYun/pull/25#issuecomment-5967835600)保留已审SHA和证据。M1应用实现尚未开始。

## 2 初版实现进度

当前24项均待领取，软件完成数0／24。GY-I01可首先领取；其余遵循前置依赖。

| 任务 | issue | 阶段 | 状态 | 负责人 | PR／已验提交与证据 |
| --- | --- | --- | --- | --- | --- |
| GY-I01 冻结技术架构、数据模型与接口契约 | [#1](https://github.com/Sek1ro-oka/GengYun/issues/1) | M1 | 待领取 | 未领取 | 无，尚未实施／验收 |
| GY-I02 建立小程序、独立后台与服务端工程骨架及CI | [#2](https://github.com/Sek1ro-oka/GengYun/issues/2) | M1 | 待领取 | 未领取 | 无，尚未实施／验收 |
| GY-I03 建立浙江首批资料清单与可替换数据库适配 | [#3](https://github.com/Sek1ro-oka/GengYun/issues/3) | M1 | 待领取 | 未领取 | 无，尚未实施／验收 |
| GY-I04 实现微信登录、游客限制与服务端归属权限 | [#4](https://github.com/Sek1ro-oka/GengYun/issues/4) | M1 | 待领取 | 未领取 | 无，尚未实施／验收 |
| GY-I05 实现单作物地区档案及授权定位／手动选择 | [#5](https://github.com/Sek1ro-oka/GengYun/issues/5) | M2 | 待领取 | 未领取 | 无，尚未实施／验收 |
| GY-I06 实现私有媒体上传、访问权限及EXIF清除 | [#6](https://github.com/Sek1ro-oka/GengYun/issues/6) | M1 | 待领取 | 未领取 | 无，尚未实施／验收 |
| GY-I07 实现科普／除草剂查询、详情与来源版本展示 | [#7](https://github.com/Sek1ro-oka/GengYun/issues/7) | M2 | 待领取 | 未领取 | 无，尚未实施／验收 |
| GY-I08 实现药剂适用过滤与标签原文用量安全边界 | [#8](https://github.com/Sek1ro-oka/GengYun/issues/8) | M2 | 待领取 | 未领取 | 无，尚未实施／验收 |
| GY-I09 实现实时拍草识别、Top3核对及不确定处理 | [#9](https://github.com/Sek1ro-oka/GengYun/issues/9) | M2 | 待领取 | 未领取 | 无，尚未实施／验收 |
| GY-I10 实现实时标签OCR、用户校正及登记精确核对 | [#10](https://github.com/Sek1ro-oka/GengYun/issues/10) | M2 | 待领取 | 未领取 | 无，尚未实施／验收 |
| GY-I11 实现普通话录音、实时ASR转写和发送核对 | [#11](https://github.com/Sek1ro-oka/GengYun/issues/11) | M2 | 待领取 | 未领取 | 无，尚未实施／验收 |
| GY-I12 实现有来源的语音／文字大模型问答与回答安全检查 | [#12](https://github.com/Sek1ro-oka/GengYun/issues/12) | M2 | 待领取 | 未领取 | 无，尚未实施／验收 |
| GY-I13 实现5Tab适老界面、语音球及普通话自动播报 | [#13](https://github.com/Sek1ro-oka/GengYun/issues/13) | M2 | 待领取 | 未领取 | 无，尚未实施／验收 |
| GY-I14 实现文字／图片AI筛查、版本重审和失败隔离 | [#14](https://github.com/Sek1ro-oka/GengYun/issues/14) | M2 | 待领取 | 未领取 | 无，尚未实施／验收 |
| GY-I15 实现真实社区发帖、评论、点赞、筛选与举报 | [#15](https://github.com/Sek1ro-oka/GengYun/issues/15) | M3 | 待领取 | 未领取 | 无，尚未实施／验收 |
| GY-I16 实现收藏与可浏览的识别历史 | [#16](https://github.com/Sek1ro-oka/GengYun/issues/16) | M3 | 待领取 | 未领取 | 无，尚未实施／验收 |
| GY-I17 实现首版应用内消息、未读状态与权限跳转 | [#17](https://github.com/Sek1ro-oka/GengYun/issues/17) | M3 | 待领取 | 未领取 | 无，尚未实施／验收 |
| GY-I18 实现独立后台资料、账号、AI任务及功能开关 | [#18](https://github.com/Sek1ro-oka/GengYun/issues/18) | M3 | 待领取 | 未领取 | 无，尚未实施／验收 |
| GY-I19 实现用途授权、注销匿名保留及7／30日删除任务 | [#19](https://github.com/Sek1ro-oka/GengYun/issues/19) | M3 | 待领取 | 未领取 | 无，尚未实施／验收 |
| GY-I20 冻结独立评估样本、标准答案及评估程序 | [#20](https://github.com/Sek1ro-oka/GengYun/issues/20) | M1 | 待领取 | 未领取 | 无，尚未实施／验收 |
| GY-I21 执行识别、语音、问答和AI筛查的真实能力评估 | [#21](https://github.com/Sek1ro-oka/GengYun/issues/21) | M4 | 待领取 | 未领取 | 无，尚未实施／验收 |
| GY-I22 完成权限、安全规则及首版端到端失败回归 | [#22](https://github.com/Sek1ro-oka/GengYun/issues/22) | M4 | 待领取 | 未领取 | 无，尚未实施／验收 |
| GY-I23 执行Android／iOS真机、时延容量及完整演示验收 | [#23](https://github.com/Sek1ro-oka/GengYun/issues/23) | M4 | 待领取 | 未领取 | 无，尚未实施／验收 |
| GY-I24 部署联网比赛版、备份恢复并交付完整材料 | [#24](https://github.com/Sek1ro-oka/GengYun/issues/24) | M4 | 待领取 | 未领取 | 无，尚未实施／验收 |

## 3 实施资料与当前约束

| 项目 | 事实与下一步 |
| --- | --- |
| 技术选型 | GY-I01先交ADR、数据字典、接口，审查后冻结；未选择框架与供应商不记完成 |
| 实际资料／接口配置 | 用户声明资源具备，数据库比赛前接入；具体字段、AppID、识草OCR／ASR／TTS／大模型和AI配置实施时安全交接 |
| 评估 | GY-I20早期冻结样本；无独立样本或未真实运行不得报模型通过 |
| 当前待审协作者PR | 初始化查询为0；后续巡检读取远端，不以此静态行当永久事实 |
| main平台保护 | 2026-10-03已重试保护API，GitHub返回403，要求升级Pro或公开仓库。当前仍未强制保护，CODEOWNERS／模板只是流程；不自动改变可见性或套餐 |
| CI | 本次增加development-docs文档与任务图检查；应用构建测试由GY-I02提供，文档绿灯不代表应用通过 |
| 自动任务条件 | 本地运行、联网、认证与服务额度可影响巡检；无变化保持安静，失败或有效结果才通知 |

## 4 状态更新规则

领取记录负责人／分支；PR记录任务、base／HEAD、命令CI和结果。合并后记录PR与main提交及证据，再判断是否关闭整个issue。部分合并、缺依赖、未测或未接不能标已验证合并。当前阶段不因到日期自动升级。

状态：待领取、进行中、待审PR、需修改、待验证、依赖阻塞、已验证合并。阶段完成须该阶段全部门槛实际满足，不能只统计已关闭issues。

巡检缓存放已忽略的.supervisor目录，只记编号／SHA／状态与时间，不存令牌或原始媒体。最终事实是远端提交、检查及正确的任务验收，不是缓存。

## 5 当前推荐下一步

协作者领取[GY-I01](https://github.com/Sek1ro-oka/GengYun/issues/1)提交架构、数据字典和接口契约PR；监工核对后，GY-I02和GY-I03可开始，GY-I20随资料准备并行。
