# 开发进度与监工台账

版本：v1.1\
更新时间：2026-10-03\
当前阶段：M1 基础与契约；只推进初版；软件已验证完成0／27。

## 1 已完成的治理工作

- 需求v1.0业务范围维持；开发计划v1.1依据原生微信形态、既有工程壳及5个GitHub项目核查重写，README补环境。
- 原24项远端issue原地更新，新建3项，共27项均归属[初版里程碑](https://github.com/Sek1ro-oka/GengYun/milestone/1)；无删除／关闭，二月只保留规划。
- 监工职责、SHA绑定审查与合并继续有效；每12小时自动巡检任务ID为pr，用户消息也可触发。
- 原文档基线[PR #25](https://github.com/Sek1ro-oka/GengYun/pull/25)及状态[PR #26](https://github.com/Sek1ro-oka/GengYun/pull/26)已合并；本次修订发布状态以对应新PR和main为准。

本轮没有实现应用或调用付费供应商。文档／任务覆盖与依赖检查不代表真实识别、语音、AI审核、真机或删除恢复已通过。

## 2 初版实现进度

目前无人通过issue领取，0项通过软件验收。远端已有chore/project-scaffold工程壳提交9ce307fe6745b49b89774a380c37b748822df934，但无开放PR；属于待整合准备，不记GY-I02完成。后续领取和PR以巡检时远端为准。

| 任务 | issue | 完成阶段 | 状态 | 负责人／PR与证据 |
| --- | --- | --- | --- | --- |
| GY-I01 冻结原生微信小程序架构、数据字典与HTTP接口契约 | [#1](https://github.com/Sek1ro-oka/GengYun/issues/1) | M1 | 待领取 | 未领取／无已验PR |
| GY-I02 整合原生小程序工程壳并建立独立后台、API与分层CI | [#2](https://github.com/Sek1ro-oka/GengYun/issues/2) | M1 | 待领取 | 未领取／无已验PR |
| GY-I03 建立浙江首批资料清单与可替换数据库适配 | [#3](https://github.com/Sek1ro-oka/GengYun/issues/3) | M1 | 待领取 | 未领取／无已验PR |
| GY-I04 实现微信登录、游客限制与服务端归属权限 | [#4](https://github.com/Sek1ro-oka/GengYun/issues/4) | M1 | 待领取 | 未领取／无已验PR |
| GY-I05 实现单作物地区档案及授权定位／手动选择 | [#5](https://github.com/Sek1ro-oka/GengYun/issues/5) | M2 | 待领取 | 未领取／无已验PR |
| GY-I06 实现私有媒体上传、访问权限及EXIF清除 | [#6](https://github.com/Sek1ro-oka/GengYun/issues/6) | M1 | 待领取 | 未领取／无已验PR |
| GY-I07 实现科普／除草剂查询、详情与来源版本展示 | [#7](https://github.com/Sek1ro-oka/GengYun/issues/7) | M2 | 待领取 | 未领取／无已验PR |
| GY-I08 实现药剂适用过滤与标签原文用量安全边界 | [#8](https://github.com/Sek1ro-oka/GengYun/issues/8) | M2 | 待领取 | 未领取／无已验PR |
| GY-I09 实现实时拍草识别、Top3核对及不确定处理 | [#9](https://github.com/Sek1ro-oka/GengYun/issues/9) | M2 | 待领取 | 未领取／无已验PR |
| GY-I10 实现实时标签OCR、用户校正及登记精确核对 | [#10](https://github.com/Sek1ro-oka/GengYun/issues/10) | M2 | 待领取 | 未领取／无已验PR |
| GY-I11 实现普通话录音、实时ASR转写和发送核对 | [#11](https://github.com/Sek1ro-oka/GengYun/issues/11) | M2 | 待领取 | 未领取／无已验PR |
| GY-I12 实现有来源的语音／文字大模型问答与回答安全检查 | [#12](https://github.com/Sek1ro-oka/GengYun/issues/12) | M2 | 待领取 | 未领取／无已验PR |
| GY-I13 实现普通话TTS、播放球及安全文本自动播报 | [#13](https://github.com/Sek1ro-oka/GengYun/issues/13) | M2 | 待领取 | 未领取／无已验PR |
| GY-I14 实现文字／图片AI筛查、版本重审和失败隔离 | [#14](https://github.com/Sek1ro-oka/GengYun/issues/14) | M2 | 待领取 | 未领取／无已验PR |
| GY-I15 实现真实社区发帖、评论、点赞、筛选与举报 | [#15](https://github.com/Sek1ro-oka/GengYun/issues/15) | M3 | 待领取 | 未领取／无已验PR |
| GY-I16 实现收藏与可浏览的识别历史 | [#16](https://github.com/Sek1ro-oka/GengYun/issues/16) | M3 | 待领取 | 未领取／无已验PR |
| GY-I17 实现首版应用内消息、未读状态与权限跳转 | [#17](https://github.com/Sek1ro-oka/GengYun/issues/17) | M3 | 待领取 | 未领取／无已验PR |
| GY-I18 实现独立后台资料、账号、AI任务及功能开关 | [#18](https://github.com/Sek1ro-oka/GengYun/issues/18) | M3 | 待领取 | 未领取／无已验PR |
| GY-I19 贯通注销去身份、在线7日备份30日删除与恢复验收 | [#19](https://github.com/Sek1ro-oka/GengYun/issues/19) | M3 | 待领取 | 未领取／无已验PR |
| GY-I20 冻结独立评估样本、标准答案及评估程序 | [#20](https://github.com/Sek1ro-oka/GengYun/issues/20) | M1 | 待领取 | 未领取／无已验PR |
| GY-I21 持续评估各项真实AI能力并汇总首版验收门槛 | [#21](https://github.com/Sek1ro-oka/GengYun/issues/21) | M4 | 待领取 | 未领取／无已验PR |
| GY-I22 完成权限、安全规则及首版端到端失败回归 | [#22](https://github.com/Sek1ro-oka/GengYun/issues/22) | M4 | 待领取 | 未领取／无已验PR |
| GY-I23 执行Android／iOS真机、时延容量及完整演示验收 | [#23](https://github.com/Sek1ro-oka/GengYun/issues/23) | M4 | 待领取 | 未领取／无已验PR |
| GY-I24 部署联网比赛版、备份恢复并交付完整材料 | [#24](https://github.com/Sek1ro-oka/GengYun/issues/24) | M4 | 待领取 | 未领取／无已验PR |
| GY-I25 提前验证正式AppID、真机域名及AI和数据库服务接入 | [#27](https://github.com/Sek1ro-oka/GengYun/issues/27) | M1 | 待领取 | 未领取／无已验PR |
| GY-I26 提前建立五Tab原生页面骨架、适老视觉及统一失败状态 | [#28](https://github.com/Sek1ro-oka/GengYun/issues/28) | M1 | 待领取 | 未领取／无已验PR |
| GY-I27 前置用途授权、外发账本与隐私撤回接口守卫 | [#29](https://github.com/Sek1ro-oka/GengYun/issues/29) | M1 | 待领取 | 未领取／无已验PR |

## 3 当前实施约束

| 项目 | 已知事实与下一步 |
| --- | --- |
| 客户端与工程壳 | 原生微信小程序miniprogram/确定；GY-I02按最新main整合现有分支，修正旧名称／病害／语音范围，不能覆盖需求监督文件 |
| 后台／API技术基线 | 默认Vue3／Vite、Node24／TypeScript／Fastify5、PostgreSQL17；未运行，GY-I01／02实测精确版本和锁文件 |
| 平台及供应商 | 用户声明资源具备，GY-I25核查AppID、真机域名和六类服务；具体配置安全交接，数据库比赛前接入 |
| 隐私与评估 | GY-I27在真实媒体和外发前完成，GY-I20调参前冻样本，各模型PR提交实测，GY-I19验完整注销删除 |
| main平台保护 | 2026-10-03保护API返回403：当前私有仓库套餐要求升级Pro或公开仓库；仍无强制保护，CODEOWNERS只作流程，不自动改可见性或套餐 |
| 当前CI | development-docs只验文档和任务图；工程CI和微信工具自动化由GY-I02建立，真机与供应商分开 |
| 自动巡检 | 每12小时，读取最新v1.1及27项任务；无变化安静，审查、合并、失败、阻塞和期限风险才通知；依赖本机联网认证与额度 |

## 4 状态和证据更新

领取记录负责人／分支；PR记任务、base／HEAD、命令和CI链接、实测与模拟区别。合并后记已验SHA和main提交、核对完整任务是否关闭；部分合并与空页面不能完成整项，阶段不按日期自动结束。

状态：待领取、进行中、待审PR、需修改、待验证、依赖阻塞、已验证合并。监督缓存位于忽略的.supervisor，不存凭据；远端与实际验证为最终事实。

## 5 当前推荐推进

先准备GY-I01契约与GY-I25平台服务验证；架构通过后GY-I02／03可并行，随后GY-I27授权基础、GY-I26页面及GY-I20样本先行。普通话ASR和文本问答按同一文本契约并行开发，后续集成，不跳过来源与安全规则。
