# 开发进度与监工台账

版本：v1.1\
更新时间：2026-10-04\
当前阶段：M1 基础与契约；只推进初版；软件已验证完成0／27。

## 1 已完成的治理工作

- 需求v1.0业务范围维持；开发计划v1.1依据原生微信形态、既有工程壳及5个GitHub项目核查重写，README补环境。
- 原24项远端issue原地更新，新建3项，共27项均归属[初版里程碑](https://github.com/Sek1ro-oka/GengYun/milestone/1)；无删除／关闭，二月只保留规划。
- 监工职责、SHA绑定审查与合并继续有效；每12小时自动巡检任务ID为pr，用户消息也可触发。
- 原文档基线[PR #25](https://github.com/Sek1ro-oka/GengYun/pull/25)及状态[PR #26](https://github.com/Sek1ro-oka/GengYun/pull/26)已合并；本次v1.1修订由[PR #30](https://github.com/Sek1ro-oka/GengYun/pull/30)发布，已验SHA、CI与最终合并状态见该PR的监工记录和main。

本治理更新没有实现应用或新增供应商请求。既有有限真实调用见第6节；文档、离线组件与合成样本不代表完整识别、语音、AI审核、真机或删除恢复已通过。

## 2 初版实现进度

GY-I01由“耕云写手”领取，其架构与契约提案组件[PR #33](https://github.com/Sek1ro-oka/GengYun/pull/33)已经监工绑定SHA复审并合并main=f40f09167869f2a2d8aa563f8c8ffdf44ccf244f；整项运行兼容仍有未验内容，issue #1保持open，0项通过完整软件验收。GY-I02局部原生工程与隔离开发调试准备PR #36已独立审查合并main=e3c709e82674eb351f337c7b769da89dfd0b1e79；正式工程／API／后台与真实能力未据此完成。旧chore/project-scaffold工程壳9ce307fe6745b49b89774a380c37b748822df934未整支合并，仅只读比较后按需求重写。后续状态以远端和实际证据为准。

| 任务 | issue | 完成阶段 | 状态 | 负责人／PR与证据 |
| --- | --- | --- | --- | --- |
| GY-I01 冻结原生微信小程序架构、数据字典与HTTP接口契约 | [#1](https://github.com/Sek1ro-oka/GengYun/issues/1) | M1 | 待验证 | 耕云写手／[PR #33](https://github.com/Sek1ro-oka/GengYun/pull/33)组件已合并；[已验SHA 0e97702](https://github.com/Sek1ro-oka/GengYun/pull/33#pullrequestreview-5401812928)；整项运行版本未冻结，安装兼容、构建／数据库／真实媒体ACL／服务／手机仍未验 |
| GY-I02 整合原生小程序工程壳并建立独立后台、API与分层CI | [#2](https://github.com/Sek1ro-oka/GengYun/issues/2) | M1 | 待验证 | 写手及工程壳原作者／[PR #36](https://github.com/Sek1ro-oka/GengYun/pull/36)局部准备已合并；[已验SHA 6d0dc95](https://github.com/Sek1ro-oka/GengYun/pull/36#pullrequestreview-5401932042)；模拟器local/release及本地诊断通过，[PR #43需修改](https://github.com/Sek1ro-oka/GengYun/pull/43#pullrequestreview-5405427586) HEAD 00fe0d8；完整工程／运行版本／真实身份／API／后台／手机／数据库仍未验，见第7节 |
| GY-I03 建立浙江首批资料清单与可替换数据库适配 | [#3](https://github.com/Sek1ro-oka/GengYun/issues/3) | M1 | 需修改 | [PR #44原作者](https://github.com/Sek1ro-oka/GengYun/pull/44)继续，HEAD 5d2f7f9；[审查](https://github.com/Sek1ro-oka/GengYun/pull/44#pullrequestreview-5405427807)发现迁移／种子／回滚和状态字典缺陷；卡片及用量均0，未连接真实数据库，不用于真实建议 |
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
| GY-I25 提前验证正式AppID、真机域名及AI和数据库服务接入 | [#27](https://github.com/Sek1ro-oka/GengYun/issues/27) | M1 | 局部已审合入／整项待验 | 写手PR #37／#40贡献与实测保留；[PR #42审查](https://github.com/Sek1ro-oka/GengYun/pull/42#pullrequestreview-5405463662)绑定3776421，合入main 59e5315；[有限实测](verification/tencent-live-evidence.md)累计12请求、保守预留1.7224元、实际账单未知；OCR唯一追加成功，真实请求停止；历史TTS SessionId未核验不能追认；真实草种／语音样本、手机与听感、数据库、用途／撤回／注销运行守卫仍缺，issue保持open |
| GY-I26 提前建立五Tab原生页面骨架、适老视觉及统一失败状态 | [#28](https://github.com/Sek1ro-oka/GengYun/issues/28) | M1 | 需修改 | 原协作者cxhhandsome的[领取请求](https://github.com/Sek1ro-oka/GengYun/issues/28#issuecomment-5975823731)保留；[Draft PR #39](https://github.com/Sek1ro-oka/GengYun/pull/39) HEAD 3c05e2ceba5e3fed1480bd6fc512189ed94387a2；监工18项UI／诊断、文档／diff通过，EOF空行已去；当前dirty冲突且新SHA无CI，编译／窄屏／最大字体截图、12次实测与识草供应商的资源事实仍待修；旧HEAD审查保留历史，未验收、不接管 |
| GY-I27 前置用途授权、外发账本与隐私撤回接口守卫 | [#29](https://github.com/Sek1ro-oka/GengYun/issues/29) | M1 | 已有PR待审／领取未核实 | [PR #45](https://github.com/Sek1ro-oka/GengYun/pull/45) HEAD 5bde81d2952d417d81e100261d48965a604f26c6，Refs #29，开放未合并／本次无CI或正式审查记录；issue无assignee和领取评论；GitHub作者Sek1ro-oka不能据此认定为既有写手，保留成果、不重复派发 |

## 3 当前实施约束

| 项目 | 已知事实与下一步 |
| --- | --- |
| 客户端与工程壳 | 原生微信小程序miniprogram/确定；GY-I02按最新main整合现有分支，修正旧名称／病害／语音范围，不能覆盖需求监督文件 |
| 后台／API技术基线 | 默认Vue3／Vite、Node24／TypeScript／Fastify5、PostgreSQL17；PR #43工程壳已获局部安装／构建／单元／契约证据但需修改；PGlite0.5.8／PG18.3不算目标PG17.11实库验收 |
| 平台及供应商 | 用户声明资源具备，GY-I25核查AppID、真机域名和六类服务；具体配置安全交接，数据库比赛前接入 |
| 隐私与评估 | GY-I27在真实媒体和外发前完成，GY-I20调参前冻样本，各模型PR提交实测，GY-I19验完整注销删除 |
| main平台保护 | 2026-10-03保护API返回403：当前私有仓库套餐要求升级Pro或公开仓库；仍无强制保护，CODEOWNERS只作流程，不自动改可见性或套餐 |
| 当前CI | development-docs检查文档和任务图；PR #36新增local-wechat局部工程／配置／诊断测试；PR #43远端六CI通过仍有实现缺陷；PR #39旧HEAD文档CI失败，新HEAD3c05e2ce无CI记录；PR #45本次无CI记录；完整应用、真机及真实能力评估仍待验 |
| 自动巡检 | 每12小时，读取最新v1.1及27项任务；无变化安静，审查、合并、失败、阻塞和期限风险才通知；依赖本机联网认证与额度 |

## 4 状态和证据更新

领取记录负责人／分支；PR记任务、base／HEAD、命令和CI链接、实测与模拟区别。合并后记已验SHA和main提交、核对完整任务是否关闭；部分合并与空页面不能完成整项，阶段不按日期自动结束。

状态：待领取、进行中、待审PR、需修改、待验证、依赖阻塞、已验证合并。监督缓存位于忽略的.supervisor，不存凭据；远端与实际验证为最终事实。

## 5 当前推荐推进

先准备GY-I01契约与GY-I25平台服务验证；架构通过后GY-I02／03可并行，随后GY-I27授权基础、GY-I26页面及GY-I20样本先行。普通话ASR和文本问答按同一文本契约并行开发，后续集成，不跳过来源与安全规则。


## 6 腾讯云有限实测已审组件与历史

2026-10-04（UTC+8），原11次／预留1.2224元、等待OCR后付费开启是历史中间状态。用户随后明确“已开启，允许再测一次”，唯一追加OCR成功，返回文字与合成输入一致。本轮最终12请求、保守预留1.7224元，实际账单未知；没有自动重试，DeepSeek独立账户未调用，所有真实请求停止。

[PR #42复审](https://github.com/Sek1ro-oka/GengYun/pull/42#pullrequestreview-5405463662)绑定37764210ac58e1fc524f38d300244722a6bfa711，base=9743a122edb7ac1c55a68cbdceb77a64928029d9，squash main=59e5315aa8030071bd6cd2c5ded3a00a9bdc3ac3。指挥fetch及GitHub API核对已合并；[issue记录](https://github.com/Sek1ro-oka/GengYun/issues/27#issuecomment-5978903134)保留局部范围。监工报告Node24.16.0下7文件31组离线PASS、五SDK构造网络0、实际CLI合成替身凭据／响应负例、文档／diff与两CI通过。指挥记录为独立监工证据，未自行重发服务请求。

历史TTS音频已本地完整解码单声道16kHz、2.196秒，但旧工具未核验SessionId，完整原响应未保留，不能事后追认该字段；整改只改未来证据校验，不补造历史。TMS／IMS两端点Pass及受控失败、ASR合成普通话短句、TokenHub合成图响应及OCR合成图文字，仅证明有限接入结果，不等于草种准确率、完整ASR样本、审核评估或真机通过。真实样本、手机／TTS听感、权威数据库、用途与外发／撤回／注销删除运行守卫等仍待验，GY-I25保持open、完整0／27。

## 7 原作者待修PR与兼容安排

PR #43 HEAD 00fe0d887ccde96deb65a6c2bcb7d5818e770af1：[审查](https://github.com/Sek1ro-oka/GengYun/pull/43#pullrequestreview-5405427586)要求修订。监工报告安装／lint／build、17单元＋6契约及远端六CI通过，但畸形JSON和超1MiB请求转500且缺冻结错误码、健康检查暴露数据库原始错误、linked_target_revision=NULL可绕过三元组CHECK。内存SQL实证为PGlite0.5.8／PG18.3，不是目标PG17.11实库；Refs #2未完成。

PR #44 HEAD 5d2f7f9b6d81b68d24c981bd6d22cbe54c7b91c8：[审查](https://github.com/Sek1ro-oka/GengYun/pull/44#pullrequestreview-5405427807)要求修订。监工报告102地区／4作物／8组／20partial、6负例、内存演示及两CI通过；实跑仍有0001→0002 uuid／varchar外键42804、单独0002后种子注释吞掉首INSERT导致23503、回滚删除无关无登记制剂、无登记有效期却强写valid违反unknown字典。卡片／用量均0，不能用于真实建议；未连接真实DB、Refs #3未完成。两PR须按已审字典协调，原作者及工作区保留，不因CI通过合并。

PR #39最新状态见GY-I26行；旧HEAD审查与旧冲突闭合仍作历史；新HEAD3c05e2ce重新出现dirty，须据最新提交处理。3.5.5是开发计划兼容起点、未实测未冻结，工具不可选时不设其必测阻塞；3.5.8单版本0.16%仅为用户观察，不能推算旧版本总体。首版联网比赛演示用户已明确选择最新版本，优先工具可选的最新正式稳定版本，记录实际SDKVersion、机器／配置／SHA，再用比赛Android／iOS设备、窄屏及最大字体确定支持范围。3.17.3只有既有模拟器证据，不自动冻结正式基线、不证明3.5.5／3.5.8兼容。指挥已独立派发写手兼容文档／配置一致性后续，先同步main并检查PR #43的README重叠，保持原PR #39职责；没有凭版本号码改配置或降低验收。

## 8 新PR与版本指令核查

2026-10-04（UTC+8），指挥在自己的目录／codex/commander-live-followup分支只读GitHub API核实PR #45开放、HEAD5bde81d2952d417d81e100261d48965a604f26c6、Refs #29，issue #29无负责人和领取评论。因此“有PR”与“负责人身份／领取未核实”分开记录。监工正在独立审查；其初步全合成复现报告多用途撤回、旧authEpoch、接收方失效漏验，以及删除pending／不支持仍记completed。正式固定SHA审查尚待，不冒称已发布或已通过，也不凭同一GitHub账户归给现写手。

PR #39新HEAD3c05e2ce本次API确认Draft、mergeable=false／dirty、无CI记录。监工报告18项UI／诊断、文档及diff通过，EOF空行消除；资源清单仍错写真实推理0次、把DeepSeek只读鉴权放在识草行，须保留已审#42的12次与TokenHub视觉事实。新绑定SHA审查链接尚待；#43／#44原HEAD未变，维持原需修改结论，不重复审查。

用户明确“告诉写手选择最新的版本”，指挥已发送并收到写手明确回执msg_0531b28c5a7a16e0016ac228cda88887d09cb5543add7a16e2：优先最新正式稳定版本。写手报告官方发布记录最高3.17.3（2026-08-20）、本机工具2.02.2608080，但工具列表正式稳定标签／可选状态和新编译证据仍缺；该报告不是指挥独立版本冻结。公开配置暂未改、手机／最大字体验收保持、真实AI请求停止；只需补当前工具列表中正式稳定最高版本的实际信息，不重复索取账号或密钥。
