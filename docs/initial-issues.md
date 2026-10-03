# 初版任务与远端issues

版本：v1.0\
日期：2026年10月3日\
范围：暂定2026年11月15日比赛联网演示，仅初版；应用功能尚未实现。

已发布24项任务，均归属[初版里程碑](https://github.com/Sek1ro-oka/GengYun/milestone/1)。全周期二月规划见[开发文档](development-plan.md)，本轮不创建二月issues。

先领取GY-I01完成架构契约；前置任务未通过时先讨论契约，不标实现已验收。P0表示核心依赖或安全／验收门槛，P1同样为初版必交。

| 任务 | GitHub issue | 阶段 | 优先级 | 前置 |
| --- | --- | --- | --- | --- |
| GY-I01 | [#1 冻结技术架构、数据模型与接口契约](https://github.com/Sek1ro-oka/GengYun/issues/1) | M1 | P0 | 无 |
| GY-I02 | [#2 建立小程序、独立后台与服务端工程骨架及CI](https://github.com/Sek1ro-oka/GengYun/issues/2) | M1 | P0 | [GY-I01](https://github.com/Sek1ro-oka/GengYun/issues/1) |
| GY-I03 | [#3 建立浙江首批资料清单与可替换数据库适配](https://github.com/Sek1ro-oka/GengYun/issues/3) | M1 | P0 | [GY-I01](https://github.com/Sek1ro-oka/GengYun/issues/1) |
| GY-I04 | [#4 实现微信登录、游客限制与服务端归属权限](https://github.com/Sek1ro-oka/GengYun/issues/4) | M1 | P0 | [GY-I02](https://github.com/Sek1ro-oka/GengYun/issues/2) |
| GY-I05 | [#5 实现单作物地区档案及授权定位／手动选择](https://github.com/Sek1ro-oka/GengYun/issues/5) | M2 | P1 | [GY-I03](https://github.com/Sek1ro-oka/GengYun/issues/3)、[GY-I04](https://github.com/Sek1ro-oka/GengYun/issues/4) |
| GY-I06 | [#6 实现私有媒体上传、访问权限及EXIF清除](https://github.com/Sek1ro-oka/GengYun/issues/6) | M1 | P0 | [GY-I02](https://github.com/Sek1ro-oka/GengYun/issues/2)、[GY-I04](https://github.com/Sek1ro-oka/GengYun/issues/4) |
| GY-I07 | [#7 实现科普／除草剂查询、详情与来源版本展示](https://github.com/Sek1ro-oka/GengYun/issues/7) | M2 | P0 | [GY-I03](https://github.com/Sek1ro-oka/GengYun/issues/3)、[GY-I04](https://github.com/Sek1ro-oka/GengYun/issues/4) |
| GY-I08 | [#8 实现药剂适用过滤与标签原文用量安全边界](https://github.com/Sek1ro-oka/GengYun/issues/8) | M2 | P0 | [GY-I07](https://github.com/Sek1ro-oka/GengYun/issues/7) |
| GY-I09 | [#9 实现实时拍草识别、Top3核对及不确定处理](https://github.com/Sek1ro-oka/GengYun/issues/9) | M2 | P0 | [GY-I05](https://github.com/Sek1ro-oka/GengYun/issues/5)、[GY-I06](https://github.com/Sek1ro-oka/GengYun/issues/6)、[GY-I07](https://github.com/Sek1ro-oka/GengYun/issues/7)、[GY-I08](https://github.com/Sek1ro-oka/GengYun/issues/8) |
| GY-I10 | [#10 实现实时标签OCR、用户校正及登记精确核对](https://github.com/Sek1ro-oka/GengYun/issues/10) | M2 | P0 | [GY-I06](https://github.com/Sek1ro-oka/GengYun/issues/6)、[GY-I07](https://github.com/Sek1ro-oka/GengYun/issues/7)、[GY-I08](https://github.com/Sek1ro-oka/GengYun/issues/8) |
| GY-I11 | [#11 实现普通话录音、实时ASR转写和发送核对](https://github.com/Sek1ro-oka/GengYun/issues/11) | M2 | P0 | [GY-I04](https://github.com/Sek1ro-oka/GengYun/issues/4)、[GY-I06](https://github.com/Sek1ro-oka/GengYun/issues/6) |
| GY-I12 | [#12 实现有来源的语音／文字大模型问答与回答安全检查](https://github.com/Sek1ro-oka/GengYun/issues/12) | M2 | P0 | [GY-I07](https://github.com/Sek1ro-oka/GengYun/issues/7)、[GY-I08](https://github.com/Sek1ro-oka/GengYun/issues/8)、[GY-I11](https://github.com/Sek1ro-oka/GengYun/issues/11) |
| GY-I13 | [#13 实现5Tab适老界面、语音球及普通话自动播报](https://github.com/Sek1ro-oka/GengYun/issues/13) | M2 | P1 | [GY-I02](https://github.com/Sek1ro-oka/GengYun/issues/2)、[GY-I11](https://github.com/Sek1ro-oka/GengYun/issues/11)、[GY-I12](https://github.com/Sek1ro-oka/GengYun/issues/12) |
| GY-I14 | [#14 实现文字／图片AI筛查、版本重审和失败隔离](https://github.com/Sek1ro-oka/GengYun/issues/14) | M2 | P0 | [GY-I03](https://github.com/Sek1ro-oka/GengYun/issues/3)、[GY-I06](https://github.com/Sek1ro-oka/GengYun/issues/6) |
| GY-I15 | [#15 实现真实社区发帖、评论、点赞、筛选与举报](https://github.com/Sek1ro-oka/GengYun/issues/15) | M3 | P1 | [GY-I04](https://github.com/Sek1ro-oka/GengYun/issues/4)、[GY-I05](https://github.com/Sek1ro-oka/GengYun/issues/5)、[GY-I07](https://github.com/Sek1ro-oka/GengYun/issues/7)、[GY-I14](https://github.com/Sek1ro-oka/GengYun/issues/14) |
| GY-I16 | [#16 实现收藏与可浏览的识别历史](https://github.com/Sek1ro-oka/GengYun/issues/16) | M3 | P1 | [GY-I04](https://github.com/Sek1ro-oka/GengYun/issues/4)、[GY-I09](https://github.com/Sek1ro-oka/GengYun/issues/9)、[GY-I10](https://github.com/Sek1ro-oka/GengYun/issues/10) |
| GY-I17 | [#17 实现首版应用内消息、未读状态与权限跳转](https://github.com/Sek1ro-oka/GengYun/issues/17) | M3 | P1 | [GY-I04](https://github.com/Sek1ro-oka/GengYun/issues/4)、[GY-I14](https://github.com/Sek1ro-oka/GengYun/issues/14)、[GY-I15](https://github.com/Sek1ro-oka/GengYun/issues/15) |
| GY-I18 | [#18 实现独立后台资料、账号、AI任务及功能开关](https://github.com/Sek1ro-oka/GengYun/issues/18) | M3 | P0 | [GY-I04](https://github.com/Sek1ro-oka/GengYun/issues/4)、[GY-I07](https://github.com/Sek1ro-oka/GengYun/issues/7)、[GY-I08](https://github.com/Sek1ro-oka/GengYun/issues/8)、[GY-I14](https://github.com/Sek1ro-oka/GengYun/issues/14) |
| GY-I19 | [#19 实现用途授权、注销匿名保留及7／30日删除任务](https://github.com/Sek1ro-oka/GengYun/issues/19) | M3 | P0 | [GY-I04](https://github.com/Sek1ro-oka/GengYun/issues/4)、[GY-I06](https://github.com/Sek1ro-oka/GengYun/issues/6)、[GY-I11](https://github.com/Sek1ro-oka/GengYun/issues/11)、[GY-I12](https://github.com/Sek1ro-oka/GengYun/issues/12)、[GY-I15](https://github.com/Sek1ro-oka/GengYun/issues/15)、[GY-I16](https://github.com/Sek1ro-oka/GengYun/issues/16)、[GY-I17](https://github.com/Sek1ro-oka/GengYun/issues/17)、[GY-I18](https://github.com/Sek1ro-oka/GengYun/issues/18) |
| GY-I20 | [#20 冻结独立评估样本、标准答案及评估程序](https://github.com/Sek1ro-oka/GengYun/issues/20) | M1 | P0 | [GY-I03](https://github.com/Sek1ro-oka/GengYun/issues/3) |
| GY-I21 | [#21 执行识别、语音、问答和AI筛查的真实能力评估](https://github.com/Sek1ro-oka/GengYun/issues/21) | M4 | P0 | [GY-I09](https://github.com/Sek1ro-oka/GengYun/issues/9)、[GY-I10](https://github.com/Sek1ro-oka/GengYun/issues/10)、[GY-I11](https://github.com/Sek1ro-oka/GengYun/issues/11)、[GY-I12](https://github.com/Sek1ro-oka/GengYun/issues/12)、[GY-I13](https://github.com/Sek1ro-oka/GengYun/issues/13)、[GY-I14](https://github.com/Sek1ro-oka/GengYun/issues/14)、[GY-I20](https://github.com/Sek1ro-oka/GengYun/issues/20) |
| GY-I22 | [#22 完成权限、安全规则及首版端到端失败回归](https://github.com/Sek1ro-oka/GengYun/issues/22) | M4 | P0 | [GY-I05](https://github.com/Sek1ro-oka/GengYun/issues/5)、[GY-I08](https://github.com/Sek1ro-oka/GengYun/issues/8)、[GY-I09](https://github.com/Sek1ro-oka/GengYun/issues/9)、[GY-I10](https://github.com/Sek1ro-oka/GengYun/issues/10)、[GY-I12](https://github.com/Sek1ro-oka/GengYun/issues/12)、[GY-I14](https://github.com/Sek1ro-oka/GengYun/issues/14)、[GY-I15](https://github.com/Sek1ro-oka/GengYun/issues/15)、[GY-I16](https://github.com/Sek1ro-oka/GengYun/issues/16)、[GY-I17](https://github.com/Sek1ro-oka/GengYun/issues/17)、[GY-I18](https://github.com/Sek1ro-oka/GengYun/issues/18)、[GY-I19](https://github.com/Sek1ro-oka/GengYun/issues/19) |
| GY-I23 | [#23 执行Android／iOS真机、时延容量及完整演示验收](https://github.com/Sek1ro-oka/GengYun/issues/23) | M4 | P0 | [GY-I16](https://github.com/Sek1ro-oka/GengYun/issues/16)、[GY-I17](https://github.com/Sek1ro-oka/GengYun/issues/17)、[GY-I18](https://github.com/Sek1ro-oka/GengYun/issues/18)、[GY-I19](https://github.com/Sek1ro-oka/GengYun/issues/19)、[GY-I21](https://github.com/Sek1ro-oka/GengYun/issues/21)、[GY-I22](https://github.com/Sek1ro-oka/GengYun/issues/22) |
| GY-I24 | [#24 部署联网比赛版、备份恢复并交付完整材料](https://github.com/Sek1ro-oka/GengYun/issues/24) | M4 | P0 | [GY-I21](https://github.com/Sek1ro-oka/GengYun/issues/21)、[GY-I22](https://github.com/Sek1ro-oka/GengYun/issues/22)、[GY-I23](https://github.com/Sek1ro-oka/GengYun/issues/23) |

## GY-I01 冻结技术架构、数据模型与接口契约

在写功能前统一两端与服务端的契约，避免各组接口和来源规则各做一套。

[远端issue #1](https://github.com/Sek1ro-oka/GengYun/issues/1)；前置：无。

功能：F01、F03、F08、F12、F13、F20；验收：架构／契约审查。

实现范围：

- 形成ADR，明确小程序、独立网页后台、模块化服务端、关系数据和私有媒体存储；选择框架与精确版本并说明依据
- 明确账号／来源与制剂版本／媒体／识别／AI审核／语音会话／收藏消息／注销任务对象及状态
- 提供接口契约、错误码、归属鉴权、幂等键、数据来源真实／种子／模拟、外发授权及服务适配边界

验收条件：

- [ ] 首版及二月模块有清晰边界；首版无真实支付、人审、专家、真实预警及使用反馈
- [ ] ADR、数据字典及接口样例相互一致，媒体与服务端密钥不进入客户端
- [ ] 监工审查确认契约后，下游才按冻结版本开发；改变契约必须同步文档与依赖

PR证据：

- ADR、数据字典、接口定义与失败状态示例
- 首版F／AC到模块的对应及变更影响清单

## GY-I02 建立小程序、独立后台与服务端工程骨架及CI

形成可重复启动和构建的基础工程，后续提交通过统一检查。

[远端issue #2](https://github.com/Sek1ro-oka/GengYun/issues/2)；前置：[GY-I01](https://github.com/Sek1ro-oka/GengYun/issues/1)。

功能：F01、F08、F12、F13；验收：AC07、AC09。

实现范围：

- 按已审ADR建立apps/miniapp、apps/admin、services/api及契约／测试目录，允许ADR批准的等效结构
- 提供锁文件、脱敏配置样例、初始化／构建／测试说明及基础健康检查
- CI运行静态检查、必要单元／契约测试和两端构建；PR流程不暴露生产密钥

验收条件：

- [ ] 干净环境按说明可安装、构建、启动；命令与运行版本记录
- [ ] 缺失配置明确失败，测试替身与真实服务配置分开，不假记外部连接成功
- [ ] CI实际触发并通过，后续PR有明确检查名；不使用未审PR代码读取生产密钥

PR证据：

- 构建与CI运行链接、测试日志和启动说明
- 配置字段清单，无密钥或个人媒体

## GY-I03 建立浙江首批资料清单与可替换数据库适配

比赛前接数据库，先把来源、覆盖和模拟边界做成可核查契约。

[远端issue #3](https://github.com/Sek1ro-oka/GengYun/issues/3)；前置：[GY-I01](https://github.com/Sek1ro-oka/GengYun/issues/1)。

功能：F02、F03、F14、F20；验收：AC02、AC12、AC22。

实现范围：

- 浙江市县、4类作物和8组杂草映射到规范对象编号
- 目标20条普通除草剂记录，记录证号、成分含量剂型、场景、适用条件、来源、有效版本和核对状态
- 数据库适配与有来源种子／明显模拟资料模式可切换，导入校验和来源更新失效可追溯

验收条件：

- [ ] 缺失、过期、冲突和未核对不标为有效；不虚构20条已完成
- [ ] 模拟資料全链路标记并不得作为真实用量依据，未接真实库报告接入缺项
- [ ] 实际来源和条目清单可复核；许可调查本轮暂缓但不得写成已许可

PR证据：

- 字段映射、脱敏数据库样例和资料清单
- 有效／失效／冲突／模拟的导入及查询证据

## GY-I04 实现微信登录、游客限制与服务端归属权限

登录方式已经确认；游客不能通过接口、分享链接或页面绕过访问限制。

[远端issue #4](https://github.com/Sek1ro-oka/GengYun/issues/4)；前置：[GY-I02](https://github.com/Sek1ro-oka/GengYun/issues/2)。

功能：F01、F13；验收：AC01、AC09。

实现范围：

- 微信登录和会话建立／退出／过期，不强制手机号
- 游客仅首页预览，其他页和接口需登录；普通用户只访问自己的私有记录
- 独立后台鉴权、管理员初始化和普通用户高权限拒绝

验收条件：

- [ ] 正常微信登录可用，拒绝额外资料仍可用基础用户功能
- [ ] 越权记录编号、直接API、分享和会话撤销检查通过
- [ ] 不使用客户端声称的角色／用户ID作为最终权限依据，不泄露登录凭据

PR证据：

- 登录真机记录、权限矩阵与越权回归结果
- 脱敏会话／接口状态证据

## GY-I05 实现单作物地区档案及授权定位／手动选择

首版浙江单作物／地区档案，定位只为选地区。

[远端issue #5](https://github.com/Sek1ro-oka/GengYun/issues/5)；前置：[GY-I03](https://github.com/Sek1ro-oka/GengYun/issues/3)、[GY-I04](https://github.com/Sek1ro-oka/GengYun/issues/4)。

功能：F02；验收：AC01、AC21、AC15。

实现范围：

- 浙江市县和4类作物选择与修改
- 主动定位授权、地区转换、用户确认，拒绝／超时／省外可手选
- 不持续跟踪，不默认保存原始坐标或采集面积，多田块不进入首版

验收条件：

- [ ] Android／iOS授权和拒绝路径可用，手选不依赖定位
- [ ] 修改档案不改写已保存识别、来源或后续实际记录快照
- [ ] 游客不可修改他人或登录用户档案
- [ ] 首版地区只筛选静态科普，不产生真实地区预警

PR证据：

- 真机权限流程与档案接口测试
- 地区覆盖及失败状态截图

## GY-I06 实现私有媒体上传、访问权限及EXIF清除

识别、语音和社区共享媒体能力，但上传不等于公开。

[远端issue #6](https://github.com/Sek1ro-oka/GengYun/issues/6)；前置：[GY-I02](https://github.com/Sek1ro-oka/GengYun/issues/2)、[GY-I04](https://github.com/Sek1ro-oka/GengYun/issues/4)。

功能：F05、F12、F13、F15、F16；验收：AC07、AC09、AC23。

实现范围：

- 图片／音频类型大小校验、上传取消重试与对象归属；图片去EXIF
- 社区每帖最多3图、单图≤5MB；语音≤60秒、≤10MB；识别图片按评估条件压缩≤2MB
- 私有媒体受鉴权，社区审核前不公开；用途授权和删除任务记录可接入

验收条件：

- [ ] 伪扩展名、超限、越权URL、重复上传／任务和取消按契约处理
- [ ] 原始位置／私人媒体不出现在公共列表或普通日志
- [ ] 音频编码与服务商适配真实核实，不把产品限额冒充官方接口限制

PR证据：

- 权限／类型／大小／EXIF与失败测试
- 媒体对象生命周期和授权访问说明

## GY-I07 实现科普／除草剂查询、详情与来源版本展示

用户可以查资料且辨别来源、核对状态及适用条件。

[远端issue #7](https://github.com/Sek1ro-oka/GengYun/issues/7)；前置：[GY-I03](https://github.com/Sek1ro-oka/GengYun/issues/3)、[GY-I04](https://github.com/Sek1ro-oka/GengYun/issues/4)。

功能：F03、F14；验收：AC02、AC22。

实现范围：

- 作物—杂草—除草方式导航及关键词／地区筛选
- 详情同时展示制剂、条件、风险、原文来源、版本与更新时间
- 无结果、失效、未核对和模拟状态，支持继续查询

验收条件：

- [ ] 任一展示记录能追溯实际来源；缺项不通过空白或模型补写填充
- [ ] 下架／失效退出有效查询，详情和列表一致
- [ ] 不授AI／用户经验专家认证标签，不对模拟记录显示真实用量

PR证据：

- 真实／种子／模拟／无结果的接口及页面证据
- 来源版本和下架缓存回归

## GY-I08 实现药剂适用过滤与标签原文用量安全边界

来源和确定性规则先检查，模型或用户选中候选都不能绕过。

[远端issue #8](https://github.com/Sek1ro-oka/GengYun/issues/8)；前置：[GY-I07](https://github.com/Sek1ro-oka/GengYun/issues/7)。

功能：F04、F14、F20；验收：AC13、AC14、AC22。

实现范围：

- 检查禁限用、作物、生育期、地区、制剂、含量剂型、使用场景及有效来源
- 缺条件或冲突说明原因，不静默放宽；有来源才能比较风险路线，不能凑两选项
- 用量仅由原文卡片渲染并绑定数字单位和条件，关闭个人处方／混配／自动换算

验收条件：

- [ ] 至少100组登记／匹配／限制场景全部通过，含冲突、失效、未知和模拟
- [ ] 未核对／不适用／禁用不能进入可执行建议或问答用量卡片
- [ ] 所有风险文字无绝对安全／零药害承诺，有功能关闭开关

PR证据：

- 确定性规则来源及版本、100组结果
- 原文数字／单位／条件比对与关闭功能证据

## GY-I09 实现实时拍草识别、Top3核对及不确定处理

识草提供候选和查询输入，不能直接开出处方。

[远端issue #9](https://github.com/Sek1ro-oka/GengYun/issues/9)；前置：[GY-I05](https://github.com/Sek1ro-oka/GengYun/issues/5)、[GY-I06](https://github.com/Sek1ro-oka/GengYun/issues/6)、[GY-I07](https://github.com/Sek1ro-oka/GengYun/issues/7)、[GY-I08](https://github.com/Sek1ro-oka/GengYun/issues/8)。

功能：F15；验收：AC11、AC22。

实现范围：

- 真实识别任务、进度、模型版本、候选至多Top3及原始结果
- 不确定、覆盖外／低质量、权限拒绝、无结果、超时和重拍
- 用户选择独立记录，关联科普及条件完整后查询，保存私有历史

验收条件：

- [ ] 实际服务调用有证据，预设仅明显标注兜底，不算准确率
- [ ] 无可信分数不伪造高置信，候选少于3不补造
- [ ] 任务归属与重试安全，不能跳过GY-I08

PR证据：

- 实时调用／任务版本、真机流程与错误样例
- 样本测量交GY-I21，不以手工选对计识别正确

## GY-I10 实现实时标签OCR、用户校正及登记精确核对

OCR提字与登记核对分开，文字识别成功不代表药剂已核实。

[远端issue #10](https://github.com/Sek1ro-oka/GengYun/issues/10)；前置：[GY-I06](https://github.com/Sek1ro-oka/GengYun/issues/6)、[GY-I07](https://github.com/Sek1ro-oka/GengYun/issues/7)、[GY-I08](https://github.com/Sek1ro-oka/GengYun/issues/8)。

功能：F16；验收：AC12、AC22。

实现范围：

- 实时提取证号／名称／成分／含量／剂型，用户核对修改
- 证号精确检索及字段比对，冲突／无匹配／多结果／失效状态
- 来源原文卡片和版本，关联私有历史与后续语音问答

验收条件：

- [ ] 模糊字段有核对入口，同名不同制剂不静默匹配
- [ ] 校正前原始结果保留，手工改写不计OCR准确率
- [ ] 冲突阻断用量卡片，服务失败／超时不伪造成功

PR证据：

- 原始OCR与人工校正／登记结果分别记录
- 真实服务、冲突及权限测试

## GY-I11 实现普通话录音、实时ASR转写和发送核对

这是最新追加的首版必交项，用于向大模型发语音提问。

[远端issue #11](https://github.com/Sek1ro-oka/GengYun/issues/11)；前置：[GY-I04](https://github.com/Sek1ro-oka/GengYun/issues/4)、[GY-I06](https://github.com/Sek1ro-oka/GengYun/issues/6)。

功能：F12；验收：AC28、AC09。

实现范围：

- 主动录音授权、停止取消重录，≤60秒／≤10MB
- 真实普通话ASR、可编辑转写及确认发送，药名数字单位否定词需核对
- 拒权／无声噪声／断网／超时改为重试或文字输入，语音不自动投稿

验收条件：

- [ ] 真实ASR与转写状态可追溯，不用预设文本冒充服务
- [ ] 关键字段不清晰不自动发送或产生个人用药指令
- [ ] 音频转写私有保存及外发授权接F13，首版不要求方言／离线／导航

PR证据：

- 实际录音权限和失败流程、原始转写与修改记录
- 50段评估由GY-I21执行

## GY-I12 实现有来源的语音／文字大模型问答与回答安全检查

普通话转写或文字输入交大模型，回答有依据、可追问且不会伪造用药结论。

[远端issue #12](https://github.com/Sek1ro-oka/GengYun/issues/12)；前置：[GY-I07](https://github.com/Sek1ro-oka/GengYun/issues/7)、[GY-I08](https://github.com/Sek1ro-oka/GengYun/issues/8)、[GY-I11](https://github.com/Sek1ro-oka/GengYun/issues/11)。

功能：F20、F12、F13；验收：AC29、AC22、AC09。

实现范围：

- 检索有效可访问资料，保存引用编号／标题／版本及会话上下文
- 回复文字与可朗读内容，来源仅取检索集合，缺资料／冲突／超范围说明不足
- 回答完成来源／风险／结构检查后再显示朗读；用户与检索内容的提示注入不改变规则
- 具体用量仅GY-I08原文卡片，关闭个性处方混配换算，模型失败明确重试

验收条件：

- [ ] 实时模型调用有证据，私有会话及单条删除可核查
- [ ] 不存在虚构URL／登记号／专家身份，未审生成内容不流式曝光
- [ ] 危险操作／伤害问题不引导继续接触；不冒充专家或医疗诊断

PR证据：

- 检索证据和回答版本、缺资料／注入／风险回归
- 120题真实问答评估由GY-I21执行

## GY-I13 实现5Tab适老界面、语音球及普通话自动播报

统一页面导航与播放／录音入口，视觉和播报均符合首版。

[远端issue #13](https://github.com/Sek1ro-oka/GengYun/issues/13)；前置：[GY-I02](https://github.com/Sek1ro-oka/GengYun/issues/2)、[GY-I11](https://github.com/Sek1ro-oka/GengYun/issues/11)、[GY-I12](https://github.com/Sek1ro-oka/GengYun/issues/12)。

功能：F12、F14；验收：AC06、AC14、AC18。

实现范围：

- 首页／识别／社区／消息／我的5Tab、绿色主题、可读大字与足够触控区域
- 语音球明确录音提问和播放暂停停止重播，提供等效普通按钮
- 科普／识别／问答播放绑定版本，数字单位否定词条件完整，离页停止

验收条件：

- [ ] 至少30段实际普通话风险／数字单位播报样例全部准确
- [ ] 静音／蓝牙／拒权／平台阻止自动播放有主动按钮和文字，不假记已听取
- [ ] 控制不遮挡提交或风险信息；首版不做语音导航／方言／震动

PR证据：

- Android／iOS真机音频及交互记录
- 30段核对、无障碍与播放失败证据

## GY-I14 实现文字／图片AI筛查、版本重审和失败隔离

社区先审后发，AI失败不能依赖未上线人工放行。

[远端issue #14](https://github.com/Sek1ro-oka/GengYun/issues/14)；前置：[GY-I03](https://github.com/Sek1ro-oka/GengYun/issues/3)、[GY-I06](https://github.com/Sek1ro-oka/GengYun/issues/6)。

功能：F08、F05；验收：AC19、AC08、AC16。

实现范围：

- 规则＋真实AI筛查文字图片、结构结果／理由／证据／模型模板规则版本
- 待筛查／通过／待复核／驳回／发布／下架状态，编辑生成新版本重审
- 危险混配、无依据个人用量、隐私、广告购买链接私交易和提示注入拦截；失败隔离

验收条件：

- [ ] 旧版本审核结果不能套新版本，超时／结构错误不发布
- [ ] AI不授权限、改来源或标专家已审，公众票决不进入首版
- [ ] 筛查通过与发布分开，下架事件可驱动缓存失效

PR证据：

- 结构契约、版本并发和失败回归
- 200风险＋200正常评估由GY-I21执行

## GY-I15 实现真实社区发帖、评论、点赞、筛选与举报

首版社区实际互动，只有人工审核板块留空。

[远端issue #15](https://github.com/Sek1ro-oka/GengYun/issues/15)；前置：[GY-I04](https://github.com/Sek1ro-oka/GengYun/issues/4)、[GY-I05](https://github.com/Sek1ro-oka/GengYun/issues/5)、[GY-I07](https://github.com/Sek1ro-oka/GengYun/issues/7)、[GY-I14](https://github.com/Sek1ro-oka/GengYun/issues/14)。

功能：F05、F08；验收：AC08、AC16、AC19。

实现范围：

- 文字／图片帖子评论、作物地区筛选、杂草／药剂关联
- 点赞幂等、编辑删除自己的内容、举报与处理状态
- 接AI先审后发，普通互助身份，未通过内容不公开，事件给消息中心

验收条件：

- [ ] 普通用户可投稿评论并经过真实审核，非空态或假帖子
- [ ] 编辑重审／下架后列表详情引用一致，广告导流不发布
- [ ] 游客／越权／重复点赞与评论引用隐藏版本检查通过

PR证据：

- 从投稿到发布／隔离的端到端证据
- 权限、重审、商业禁止及重复操作回归

## GY-I16 实现收藏与可浏览的识别历史

收藏和历史已确认首版必交，不能只存数据没有页面。

[远端issue #16](https://github.com/Sek1ro-oka/GengYun/issues/16)；前置：[GY-I04](https://github.com/Sek1ro-oka/GengYun/issues/4)、[GY-I09](https://github.com/Sek1ro-oka/GengYun/issues/9)、[GY-I10](https://github.com/Sek1ro-oka/GengYun/issues/10)。

功能：F18；验收：AC17、AC09。

实现范围：

- 杂草／药剂／方案收藏及取消去重
- 历史列表与详情，时间／任务类型／模型候选／选择／OCR核对／来源版本／失败状态
- 下架失效和权限变化有状态，注销删除接F13

验收条件：

- [ ] 他人不能读取私有历史，旧收藏不恢复失效推荐资格
- [ ] 候选与人工选择分开，失败任务真实可见
- [ ] 识别／收藏不自动转成已使用事实

PR证据：

- 页面及归属测试、下架与失败历史回归
- 收藏重复取消与记录版本证据

## GY-I17 实现首版应用内消息、未读状态与权限跳转

首版仅应用内，消息事件、对象可见性及阅读状态一致。

[远端issue #17](https://github.com/Sek1ro-oka/GengYun/issues/17)；前置：[GY-I04](https://github.com/Sek1ro-oka/GengYun/issues/4)、[GY-I14](https://github.com/Sek1ro-oka/GengYun/issues/14)、[GY-I15](https://github.com/Sek1ro-oka/GengYun/issues/15)。

功能：F19；验收：AC18、AC09。

实现范围：

- 评论／点赞／AI审核／系统事件消息，来源事件与版本去重
- 未读数量、已读及对象跳转
- 对象下架、删除或无权限后不泄露受限正文，注销去身份同步

验收条件：

- [ ] 重复调度不重复创建，未读计数可复核
- [ ] 发送或创建不当作已读；游客和其他用户不可读
- [ ] 首版不接微信外部推送，不虚构真人互动消息

PR证据：

- 事件幂等与对象权限回归
- 列表／未读／跳转端到端证据

## GY-I18 实现独立后台资料、账号、AI任务及功能开关

后台独立鉴权，首版管理实际可用，人工板块显示建设中。

[远端issue #18](https://github.com/Sek1ro-oka/GengYun/issues/18)；前置：[GY-I04](https://github.com/Sek1ro-oka/GengYun/issues/4)、[GY-I07](https://github.com/Sek1ro-oka/GengYun/issues/7)、[GY-I08](https://github.com/Sek1ro-oka/GengYun/issues/8)、[GY-I14](https://github.com/Sek1ro-oka/GengYun/issues/14)。

功能：F08、F13、F14；验收：AC08、AC09、AC19。

实现范围：

- 资料来源／版本／分类及限制规则维护，关键修改留责任人和范围
- 账号授权、AI任务／错误／隔离查看、停止投稿或药剂输出开关
- 人审入口为空态，无假任务／审核人／投票和专家认证

验收条件：

- [ ] 普通账号不能管理或绕过硬规则，变更来源会重新校验和失效相关引用
- [ ] 全局开关真实生效，下架缓存和详情同步
- [ ] 不将基础账号管理说成人工评审已完成

PR证据：

- 独立后台权限、配置开关和审计记录
- 来源修改／下架缓存回归

## GY-I19 实现用途授权、注销匿名保留及7／30日删除任务

删除包括私有媒体、会话、第三方副本与模型影响，不只是改昵称。

[远端issue #19](https://github.com/Sek1ro-oka/GengYun/issues/19)；前置：[GY-I04](https://github.com/Sek1ro-oka/GengYun/issues/4)、[GY-I06](https://github.com/Sek1ro-oka/GengYun/issues/6)、[GY-I11](https://github.com/Sek1ro-oka/GengYun/issues/11)、[GY-I12](https://github.com/Sek1ro-oka/GengYun/issues/12)、[GY-I15](https://github.com/Sek1ro-oka/GengYun/issues/15)、[GY-I16](https://github.com/Sek1ro-oka/GengYun/issues/16)、[GY-I17](https://github.com/Sek1ro-oka/GengYun/issues/17)、[GY-I18](https://github.com/Sek1ro-oka/GengYun/issues/18)。

功能：F13、F01、F20；验收：AC23、AC09。

实现范围：

- 外发推理、公开投稿、录音及训练目的分开记录，默认不向第三方基础模型供训练
- 注销立即撤会话角色并停外发训练，在线7日／备份30日任务及失败证据
- 帖子评论默认头像／显示已注销用户，删除身份映射，正文附件个人信息脱敏或隐藏
- 接收方删除请求／完成／失败状态，备份恢复重放清单；受影响可控模型停部署、权重7／30日删除及重训验收流程

验收条件：

- [ ] 任务覆盖账号、音频／转写／问答、识别、媒体、收藏消息、缓存／导出等实际对象
- [ ] 未获第三方确认不标完成，无法验证删除的服务不接个人训练
- [ ] 不同注销作者不混同数据库主键；无身份反查，保留帖子不保留私人头像坐标

PR证据：

- 加速时钟或可控时间的删除／恢复演练，期限按真实任务时间复核
- 第三方留存删除能力、授权清单与模型来源关系说明

## GY-I20 冻结独立评估样本、标准答案及评估程序

先冻结样本，防止测试集调参泄漏或用预设答案冒充评估。

[远端issue #20](https://github.com/Sek1ro-oka/GengYun/issues/20)；前置：[GY-I03](https://github.com/Sek1ro-oka/GengYun/issues/3)。

功能：F15、F16、F08、F12、F20；验收：AC11、AC12、AC19、AC28、AC29。

实现范围：

- 拍草≥300独立清晰照片且每类≥30、覆盖外100、低质量100
- 标签清晰200含≥20记录及低质量100；规则登记100场景
- AI200风险＋200正常；普通话50段≥10人；TTS30段；问答120题（60可答＋20不足＋20危险＋20注入）
- 来源、标注、近重复排除、训练验证测试隔离、版本和95%置信区间程序

验收条件：

- [ ] 独立核实标准答案，模型不得作为自己的答案；同源裁剪／连拍不跨训练测试
- [ ] 样本实际不足如实记录未完成，不用生成或重复媒体充数
- [ ] 冻结清单、来源、划分与评估口径先经监工审查

PR证据：

- 脱敏样本索引／哈希与标注说明，原始私有样本不提交仓库
- 可重复评估命令和预期输出结构

## GY-I21 执行识别、语音、问答和AI筛查的真实能力评估

以冻结独立集验证实际模型；运行界面或少量演示不是达标证明。

[远端issue #21](https://github.com/Sek1ro-oka/GengYun/issues/21)；前置：[GY-I09](https://github.com/Sek1ro-oka/GengYun/issues/9)、[GY-I10](https://github.com/Sek1ro-oka/GengYun/issues/10)、[GY-I11](https://github.com/Sek1ro-oka/GengYun/issues/11)、[GY-I12](https://github.com/Sek1ro-oka/GengYun/issues/12)、[GY-I13](https://github.com/Sek1ro-oka/GengYun/issues/13)、[GY-I14](https://github.com/Sek1ro-oka/GengYun/issues/14)、[GY-I20](https://github.com/Sek1ro-oka/GengYun/issues/20)。

功能：F15、F16、F12、F20、F08；验收：AC11、AC12、AC06、AC19、AC28、AC29。

实现范围：

- 按需求第6.1运行固定模型／规则版本并报告逐类和总体及置信区间
- 拍草Top1≥85%／Top3≥95%，覆盖外高置信误放≤5%，低质拒识≥95%
- OCR证号及可见关键字段各≥95%；AI召回≥95%／正常误隔离≤10%，硬规则全部通过
- ASR字符错误率≤15%／药名数字单位≥95%；问答可答正确有依据≥95%，其他固定危险不足注入预期全部通过；TTS30固定样例全部准确

验收条件：

- [ ] 任何不达标项明确失败及整改，不能用手改／预设提高指标
- [ ] 真实调用有证据，报告样本数、版本、覆盖和实际失败
- [ ] 固定用例通过不宣传现实零风险；原始私有媒体、凭据不写日志或提交

PR证据：

- 可复现命令、数据版本、实际评估报告及失败清单
- 监工可独立重跑或抽核的脱敏结果

## GY-I22 完成权限、安全规则及首版端到端失败回归

验证模块联动和真实失败，阻止单模块通过却整体越权或放行。

[远端issue #22](https://github.com/Sek1ro-oka/GengYun/issues/22)；前置：[GY-I05](https://github.com/Sek1ro-oka/GengYun/issues/5)、[GY-I08](https://github.com/Sek1ro-oka/GengYun/issues/8)、[GY-I09](https://github.com/Sek1ro-oka/GengYun/issues/9)、[GY-I10](https://github.com/Sek1ro-oka/GengYun/issues/10)、[GY-I12](https://github.com/Sek1ro-oka/GengYun/issues/12)、[GY-I14](https://github.com/Sek1ro-oka/GengYun/issues/14)、[GY-I15](https://github.com/Sek1ro-oka/GengYun/issues/15)、[GY-I16](https://github.com/Sek1ro-oka/GengYun/issues/16)、[GY-I17](https://github.com/Sek1ro-oka/GengYun/issues/17)、[GY-I18](https://github.com/Sek1ro-oka/GengYun/issues/18)、[GY-I19](https://github.com/Sek1ro-oka/GengYun/issues/19)。

功能：F01、F04、F05、F08、F13、F20；验收：AC01、AC02、AC07、AC08、AC09、AC13、AC16、AC19、AC21、AC22、AC23、AC29。

实现范围：

- 游客／越权／会话注销／媒体访问及普通用户后台拒绝
- 来源失效／模拟／错误制剂／缺条件／AI失败／注入／内容版本变更
- 网络失败、重复请求、下架缓存与消息／收藏引用、注销匿名保留和外部删除状态

验收条件：

- [ ] 有限关键安全及权限用例全部通过，未解决严重安全／权限缺陷0
- [ ] 实际接口状态及数据结果可核对，不能只交截图或实现同形测试
- [ ] 任何处方混配换算、伪来源或未审内容公开均阻止发布

PR证据：

- 集成回归用例与日志、整改后结果
- 安全／权限检查清单及未解决限制

## GY-I23 执行Android／iOS真机、时延容量及完整演示验收

按确定条件量化首版体验，包含最新语音问答链路。

[远端issue #23](https://github.com/Sek1ro-oka/GengYun/issues/23)；前置：[GY-I16](https://github.com/Sek1ro-oka/GengYun/issues/16)、[GY-I17](https://github.com/Sek1ro-oka/GengYun/issues/17)、[GY-I18](https://github.com/Sek1ro-oka/GengYun/issues/18)、[GY-I19](https://github.com/Sek1ro-oka/GengYun/issues/19)、[GY-I21](https://github.com/Sek1ro-oka/GengYun/issues/21)、[GY-I22](https://github.com/Sek1ro-oka/GengYun/issues/22)。

功能：F02、F05、F12、F15、F16、F18、F19、F20；验收：AC06、AC07、AC11、AC12、AC14、AC17、AC18、AC21、AC28、AC29。

实现范围：

- Android／iOS各≥1实际设备，全链登录档案识别资料语音问答社区收藏历史消息后台
- 稳定≥20Mbps、往返≤100ms，每项≥30次；首屏p95≤2秒、查询≤3秒
- 真实识别≤2MB p95≤10秒／失败≤5%，30秒超时；≤30秒语音上传完转写p95≤5秒、确认发送到检查后的回答≤10秒
- 内部50并发虚拟用户10分钟、错误≤1%；外部AI用隔离替身压测，真实额度耗时分开报告

验收条件：

- [ ] 记录设备系统微信／资源／缓存／网络和完整样本，不挑最快次数
- [ ] 静音蓝牙拒权断网重播可见状态，生成回答审查前不播放
- [ ] 不把内部替身压测称外部AI容量，未测部分明确未测

PR证据：

- 真机记录、性能分位数／容量报告和演示脚本
- 全部首版AC对应的验证证据

## GY-I24 部署联网比赛版、备份恢复并交付完整材料

将通过验证的固定版本交付给比赛操作者，未测或依赖缺项如实报告。

[远端issue #24](https://github.com/Sek1ro-oka/GengYun/issues/24)；前置：[GY-I21](https://github.com/Sek1ro-oka/GengYun/issues/21)、[GY-I22](https://github.com/Sek1ro-oka/GengYun/issues/22)、[GY-I23](https://github.com/Sek1ro-oka/GengYun/issues/23)。

功能：F01、F08、F13、F15、F16、F20；验收：AC07、AC09、AC23。

实现范围：

- 比赛前接真实数据库、手机体验版和独立后台；运行环境／配置／额度与网络赛前检查
- 备份恢复一次并重放删除清单，资料停用／AI失败和回滚步骤
- 源码版本、部署配置模板、接口数据字典、操作手册、覆盖及评估报告、已知限制与演示脚本

验收条件：

- [ ] 首版必交AC均有对应证据，安全及权限缺陷0，未达标不标完成
- [ ] 联网真实识别／ASR／问答可用，预设仅标注兜底，不交离线功能
- [ ] 无真实支付、人审／专家／地区预警或反馈假上线，无原始隐私媒体和密钥提交

PR证据：

- 最终提交SHA／构建版本与验收清单
- 备份恢复／赛前检查及交付材料链接

PR完整完成任务才使用Closes，部分实现使用Refs。监工按当前提交独立验证后合并；复选框、截图或AI声明不等于通过。密钥、Word和个人原始媒体不提交。
