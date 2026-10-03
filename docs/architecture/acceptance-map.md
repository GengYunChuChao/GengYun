# 初版契约覆盖与交接

GY-I01 / #1；契约 `1.0.0` 待审。[ADR](adr-001-initial-architecture.md)、[数据字典](data-dictionary.md)、[状态协议](state-contract.md)、[OpenAPI](../../packages/contracts/openapi.json)组成同一提案。

提案修订2对应PR #33旧HEAD的两项P2：F05/F13、AC08/09/16/19的已发布媒体读取与资料关联往返。新增社区上下文授权/二进制取图、Post媒体实际版本/Author头像版本、资料可用/不可用投影；消费者影响见ADR。所有新正反例仍为合成设计断言，不是HTTP服务或真实权限/AI验收。

## F / AC 到模块

下表是设计覆盖，不是运行 AC 通过。GY-I01台账acceptance_ids为空，保持不变；验收实现由对应任务提交真实证据。

| 首版 F | 契约模块 / 关键行为 | 首版 AC | 消费任务 |
| --- | --- | --- | --- |
| F01 | auth/user/admin-session，游客首页、会话与归属 | AC01、AC07、AC09 | GY-I04/18/22 |
| F02 | profile、region/crop字典，不存原坐标 | AC01、AC21 | GY-I03/05/26 |
| F03/F04/F14 | knowledge/herbicides/verify，来源制剂条件、DoseCard确定性渲染 | AC02、AC13、AC14、AC22 | GY-I03/07/08/12 |
| F05/F08 | posts/comments/likes/reports，先审后发、版本重审、独立后台 | AC08、AC16、AC19 | GY-I14/15/18 |
| F12 | transcription确认、checked target TTS、录音/播放生命周期 | AC06、AC07、AC14、AC18、AC28 | GY-I11/13/26 |
| F13 | consent、recipient、export、deletion、归属和恢复 | AC09、AC23首版基础 | GY-I06/19/25/27 |
| F15 | recognition候选与用户选择分开，不确定、真实模式 | AC11 | GY-I09/20/21 |
| F16 | OCR原始/校正、登记精确核对独立状态 | AC12 | GY-I10/20/21 |
| F17首版静态 | 首页/knowledge静态地区信息，不产生预警 | AC15首版部分 | GY-I03/07/26 |
| F18 | favorites/history，失效引用、去重、私有失败记录 | AC17 | GY-I16 |
| F19 | messages事件去重、已读、跳转权限，无外推 | AC18 | GY-I17 |
| F20 | conversations/turns，检索白名单、完整检查、无未审流 | AC29 | GY-I12/20/21 |

F06/07/09/10/11、F08人审、F05专家、F12导航震动、F17真实预警、F19外推仅二月规划；AC03/04/05/10/20/24/25/26/27没有首版接口。AC23训练部分只规定启用前门槛，不实现训练。供应商实测、模型第6节指标、真机和运维不是契约schema验证所能证明。

## 消费者变更与前置

| 任务 | 本提案可提供的输入 | 仍需独立完成的证据 |
| --- | --- | --- |
| GY-I02 | 目录、候选运行栈、OpenAPI、持久约束、统一错误/枚举 | 精确依赖锁/干净安装/API后台构建、微信工具、CI、迁移负例；OpenAPI2020-12与Fastify适配实测 |
| GY-I03 | 数据字典、source_kind/evidence_kind、登记与制剂、条件字段 | 四作物八组物种规范映射、20份真实来源目标及实际数量、规则覆盖和导入适配 |
| GY-I25 | 六类内部适配协议、格式/限额、Recipient配置字段 | AppID/域名/供应商SDK模型实际版本、留存不训练、删除确认、额度和双平台兼容；未验证不得enabled |
| GY-I27 | 用途epoch、recipient绑定、外发账本、回写与删除守卫 | 拒绝/撤回/注销/在途竞态实测；真实媒体外发前必须完成 |
| GY-I26 | HTTP替身形状、mode标记、五Tab、失败/未登录状态 | 原生页面、适老交互、录音播放页面生命周期，不因骨架可点标能力完成 |
| GY-I20/21 | 原始/校正分离、provider/model/prompt/rule版本、目标阈值保持需求 | 独立样本与hash、评分程序和各能力当期真实评估；禁止预设/手改计准确率 |
| GY-I19/24 | 注销即时失效、handler/第三方证据、独立清单与恢复隔离 | 在线7日/备份30日、内容脱敏、第三方失败/确认、真实恢复演练 |

契约经监工确认后下游才按已冻结版本验收；可用提案替身并行写代码，不允许依赖未验收就关闭任务。当前AppID/供应商/数据库/微信工具没有运行证据，依赖保持待验证，不假记资格具备。

## 验证入口

本 PR 在没有应用工程的 main 增加契约和标准库检查；不安装服务端框架、不创建应用完成项。

```powershell
python tools/validate_development_docs.py
python tools/validate_contracts.py
python tools/test_contracts.py
git diff --check
```

第一项检查既有F/AC/Q、27任务依赖无环、Markdown链接/表格。第二项检查OpenAPI内部引用/操作权限/写入幂等/版本/字段约束与示例、状态字典/任务图及嵌套文档链接；第三项使用有意义的负例验证拒绝缺失引用、游客私有访问、缺幂等/版本、语音未确认、模拟来源DoseCard和社区旧审核。完整OpenAPI标准schema验证另用官方JSON Schema / 受控库执行并记录版本，不能把本项目检查器称完整规范validator。

PR记录实际命令、环境、HEAD和CI链接；监工独立验证后决定是否冻结。本聊天只实现和提交，不合并、不批准自己。提案可整体回退；无数据库或上线消费者，当前无数据迁移执行。
