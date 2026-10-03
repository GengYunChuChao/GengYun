# 初版任务与远端 issues

版本：v1.1\
日期：2026-10-03\
范围：暂定2026-11-15联网比赛演示，仅初版；main应用功能尚未实现。

27项任务归属[初版里程碑](https://github.com/Sek1ro-oka/GengYun/milestone/1)，原GY-I01至24及远端编号保留，新增25至27；[调整依据](issue-revision-log.md)。[全周期开发文档](development-plan.md)覆盖至2027-02-28，二月暂不发布issues。

最先并行准备GY-I01契约和GY-I25接入验证；已冻结契约允许替身联调，完成验收按依赖。P0是关键路径、安全或验收门槛，P1同样必交。GY-I21从M1准备，各能力实现时实测，M4汇总签核。需求第6节的全部数值及样本标准不变。

| 任务 | GitHub issue | 完成阶段 | 优先级 | 验收前置 |
| --- | --- | --- | --- | --- |
| GY-I01 | [#1 冻结原生微信小程序架构、数据字典与HTTP接口契约](https://github.com/Sek1ro-oka/GengYun/issues/1) | M1 | P0 | 无 |
| GY-I02 | [#2 整合原生小程序工程壳并建立独立后台、API与分层CI](https://github.com/Sek1ro-oka/GengYun/issues/2) | M1 | P0 | [GY-I01](https://github.com/Sek1ro-oka/GengYun/issues/1) |
| GY-I03 | [#3 建立浙江首批资料清单与可替换数据库适配](https://github.com/Sek1ro-oka/GengYun/issues/3) | M1 | P0 | [GY-I01](https://github.com/Sek1ro-oka/GengYun/issues/1) |
| GY-I04 | [#4 实现微信登录、游客限制与服务端归属权限](https://github.com/Sek1ro-oka/GengYun/issues/4) | M1 | P0 | [GY-I02](https://github.com/Sek1ro-oka/GengYun/issues/2)、[GY-I25](https://github.com/Sek1ro-oka/GengYun/issues/27)、[GY-I27](https://github.com/Sek1ro-oka/GengYun/issues/29) |
| GY-I05 | [#5 实现单作物地区档案及授权定位／手动选择](https://github.com/Sek1ro-oka/GengYun/issues/5) | M2 | P1 | [GY-I03](https://github.com/Sek1ro-oka/GengYun/issues/3)、[GY-I04](https://github.com/Sek1ro-oka/GengYun/issues/4)、[GY-I26](https://github.com/Sek1ro-oka/GengYun/issues/28)、[GY-I27](https://github.com/Sek1ro-oka/GengYun/issues/29) |
| GY-I06 | [#6 实现私有媒体上传、访问权限及EXIF清除](https://github.com/Sek1ro-oka/GengYun/issues/6) | M1 | P0 | [GY-I02](https://github.com/Sek1ro-oka/GengYun/issues/2)、[GY-I04](https://github.com/Sek1ro-oka/GengYun/issues/4)、[GY-I27](https://github.com/Sek1ro-oka/GengYun/issues/29) |
| GY-I07 | [#7 实现科普／除草剂查询、详情与来源版本展示](https://github.com/Sek1ro-oka/GengYun/issues/7) | M2 | P0 | [GY-I03](https://github.com/Sek1ro-oka/GengYun/issues/3)、[GY-I04](https://github.com/Sek1ro-oka/GengYun/issues/4) |
| GY-I08 | [#8 实现药剂适用过滤与标签原文用量安全边界](https://github.com/Sek1ro-oka/GengYun/issues/8) | M2 | P0 | [GY-I07](https://github.com/Sek1ro-oka/GengYun/issues/7) |
| GY-I09 | [#9 实现实时拍草识别、Top3核对及不确定处理](https://github.com/Sek1ro-oka/GengYun/issues/9) | M2 | P0 | [GY-I05](https://github.com/Sek1ro-oka/GengYun/issues/5)、[GY-I06](https://github.com/Sek1ro-oka/GengYun/issues/6)、[GY-I07](https://github.com/Sek1ro-oka/GengYun/issues/7)、[GY-I08](https://github.com/Sek1ro-oka/GengYun/issues/8)、[GY-I25](https://github.com/Sek1ro-oka/GengYun/issues/27)、[GY-I20](https://github.com/Sek1ro-oka/GengYun/issues/20) |
| GY-I10 | [#10 实现实时标签OCR、用户校正及登记精确核对](https://github.com/Sek1ro-oka/GengYun/issues/10) | M2 | P0 | [GY-I06](https://github.com/Sek1ro-oka/GengYun/issues/6)、[GY-I07](https://github.com/Sek1ro-oka/GengYun/issues/7)、[GY-I08](https://github.com/Sek1ro-oka/GengYun/issues/8)、[GY-I25](https://github.com/Sek1ro-oka/GengYun/issues/27)、[GY-I20](https://github.com/Sek1ro-oka/GengYun/issues/20) |
| GY-I11 | [#11 实现普通话录音、实时ASR转写和发送核对](https://github.com/Sek1ro-oka/GengYun/issues/11) | M2 | P0 | [GY-I04](https://github.com/Sek1ro-oka/GengYun/issues/4)、[GY-I06](https://github.com/Sek1ro-oka/GengYun/issues/6)、[GY-I25](https://github.com/Sek1ro-oka/GengYun/issues/27)、[GY-I20](https://github.com/Sek1ro-oka/GengYun/issues/20) |
| GY-I12 | [#12 实现有来源的语音／文字大模型问答与回答安全检查](https://github.com/Sek1ro-oka/GengYun/issues/12) | M2 | P0 | [GY-I07](https://github.com/Sek1ro-oka/GengYun/issues/7)、[GY-I08](https://github.com/Sek1ro-oka/GengYun/issues/8)、[GY-I06](https://github.com/Sek1ro-oka/GengYun/issues/6)、[GY-I25](https://github.com/Sek1ro-oka/GengYun/issues/27)、[GY-I27](https://github.com/Sek1ro-oka/GengYun/issues/29)、[GY-I20](https://github.com/Sek1ro-oka/GengYun/issues/20) |
| GY-I13 | [#13 实现普通话TTS、播放球及安全文本自动播报](https://github.com/Sek1ro-oka/GengYun/issues/13) | M2 | P1 | [GY-I26](https://github.com/Sek1ro-oka/GengYun/issues/28)、[GY-I08](https://github.com/Sek1ro-oka/GengYun/issues/8)、[GY-I25](https://github.com/Sek1ro-oka/GengYun/issues/27)、[GY-I27](https://github.com/Sek1ro-oka/GengYun/issues/29)、[GY-I20](https://github.com/Sek1ro-oka/GengYun/issues/20) |
| GY-I14 | [#14 实现文字／图片AI筛查、版本重审和失败隔离](https://github.com/Sek1ro-oka/GengYun/issues/14) | M2 | P0 | [GY-I03](https://github.com/Sek1ro-oka/GengYun/issues/3)、[GY-I06](https://github.com/Sek1ro-oka/GengYun/issues/6)、[GY-I25](https://github.com/Sek1ro-oka/GengYun/issues/27)、[GY-I20](https://github.com/Sek1ro-oka/GengYun/issues/20) |
| GY-I15 | [#15 实现真实社区发帖、评论、点赞、筛选与举报](https://github.com/Sek1ro-oka/GengYun/issues/15) | M3 | P1 | [GY-I04](https://github.com/Sek1ro-oka/GengYun/issues/4)、[GY-I05](https://github.com/Sek1ro-oka/GengYun/issues/5)、[GY-I07](https://github.com/Sek1ro-oka/GengYun/issues/7)、[GY-I14](https://github.com/Sek1ro-oka/GengYun/issues/14)、[GY-I26](https://github.com/Sek1ro-oka/GengYun/issues/28)、[GY-I27](https://github.com/Sek1ro-oka/GengYun/issues/29) |
| GY-I16 | [#16 实现收藏与可浏览的识别历史](https://github.com/Sek1ro-oka/GengYun/issues/16) | M3 | P1 | [GY-I04](https://github.com/Sek1ro-oka/GengYun/issues/4)、[GY-I09](https://github.com/Sek1ro-oka/GengYun/issues/9)、[GY-I10](https://github.com/Sek1ro-oka/GengYun/issues/10)、[GY-I26](https://github.com/Sek1ro-oka/GengYun/issues/28)、[GY-I27](https://github.com/Sek1ro-oka/GengYun/issues/29) |
| GY-I17 | [#17 实现首版应用内消息、未读状态与权限跳转](https://github.com/Sek1ro-oka/GengYun/issues/17) | M3 | P1 | [GY-I04](https://github.com/Sek1ro-oka/GengYun/issues/4)、[GY-I14](https://github.com/Sek1ro-oka/GengYun/issues/14)、[GY-I15](https://github.com/Sek1ro-oka/GengYun/issues/15)、[GY-I26](https://github.com/Sek1ro-oka/GengYun/issues/28)、[GY-I27](https://github.com/Sek1ro-oka/GengYun/issues/29) |
| GY-I18 | [#18 实现独立后台资料、账号、AI任务及功能开关](https://github.com/Sek1ro-oka/GengYun/issues/18) | M3 | P0 | [GY-I04](https://github.com/Sek1ro-oka/GengYun/issues/4)、[GY-I07](https://github.com/Sek1ro-oka/GengYun/issues/7)、[GY-I08](https://github.com/Sek1ro-oka/GengYun/issues/8)、[GY-I14](https://github.com/Sek1ro-oka/GengYun/issues/14)、[GY-I26](https://github.com/Sek1ro-oka/GengYun/issues/28)、[GY-I27](https://github.com/Sek1ro-oka/GengYun/issues/29) |
| GY-I19 | [#19 贯通注销去身份、在线7日备份30日删除与恢复验收](https://github.com/Sek1ro-oka/GengYun/issues/19) | M3 | P0 | [GY-I04](https://github.com/Sek1ro-oka/GengYun/issues/4)、[GY-I06](https://github.com/Sek1ro-oka/GengYun/issues/6)、[GY-I11](https://github.com/Sek1ro-oka/GengYun/issues/11)、[GY-I12](https://github.com/Sek1ro-oka/GengYun/issues/12)、[GY-I15](https://github.com/Sek1ro-oka/GengYun/issues/15)、[GY-I16](https://github.com/Sek1ro-oka/GengYun/issues/16)、[GY-I17](https://github.com/Sek1ro-oka/GengYun/issues/17)、[GY-I18](https://github.com/Sek1ro-oka/GengYun/issues/18)、[GY-I27](https://github.com/Sek1ro-oka/GengYun/issues/29) |
| GY-I20 | [#20 冻结独立评估样本、标准答案及评估程序](https://github.com/Sek1ro-oka/GengYun/issues/20) | M1 | P0 | [GY-I03](https://github.com/Sek1ro-oka/GengYun/issues/3) |
| GY-I21 | [#21 持续评估各项真实AI能力并汇总首版验收门槛](https://github.com/Sek1ro-oka/GengYun/issues/21) | M4 | P0 | [GY-I09](https://github.com/Sek1ro-oka/GengYun/issues/9)、[GY-I10](https://github.com/Sek1ro-oka/GengYun/issues/10)、[GY-I11](https://github.com/Sek1ro-oka/GengYun/issues/11)、[GY-I12](https://github.com/Sek1ro-oka/GengYun/issues/12)、[GY-I13](https://github.com/Sek1ro-oka/GengYun/issues/13)、[GY-I14](https://github.com/Sek1ro-oka/GengYun/issues/14)、[GY-I20](https://github.com/Sek1ro-oka/GengYun/issues/20) |
| GY-I22 | [#22 完成权限、安全规则及首版端到端失败回归](https://github.com/Sek1ro-oka/GengYun/issues/22) | M4 | P0 | [GY-I05](https://github.com/Sek1ro-oka/GengYun/issues/5)、[GY-I08](https://github.com/Sek1ro-oka/GengYun/issues/8)、[GY-I09](https://github.com/Sek1ro-oka/GengYun/issues/9)、[GY-I10](https://github.com/Sek1ro-oka/GengYun/issues/10)、[GY-I12](https://github.com/Sek1ro-oka/GengYun/issues/12)、[GY-I14](https://github.com/Sek1ro-oka/GengYun/issues/14)、[GY-I15](https://github.com/Sek1ro-oka/GengYun/issues/15)、[GY-I16](https://github.com/Sek1ro-oka/GengYun/issues/16)、[GY-I17](https://github.com/Sek1ro-oka/GengYun/issues/17)、[GY-I18](https://github.com/Sek1ro-oka/GengYun/issues/18)、[GY-I19](https://github.com/Sek1ro-oka/GengYun/issues/19) |
| GY-I23 | [#23 执行Android／iOS真机、时延容量及完整演示验收](https://github.com/Sek1ro-oka/GengYun/issues/23) | M4 | P0 | [GY-I16](https://github.com/Sek1ro-oka/GengYun/issues/16)、[GY-I17](https://github.com/Sek1ro-oka/GengYun/issues/17)、[GY-I18](https://github.com/Sek1ro-oka/GengYun/issues/18)、[GY-I19](https://github.com/Sek1ro-oka/GengYun/issues/19)、[GY-I21](https://github.com/Sek1ro-oka/GengYun/issues/21)、[GY-I22](https://github.com/Sek1ro-oka/GengYun/issues/22) |
| GY-I24 | [#24 部署联网比赛版、备份恢复并交付完整材料](https://github.com/Sek1ro-oka/GengYun/issues/24) | M4 | P0 | [GY-I21](https://github.com/Sek1ro-oka/GengYun/issues/21)、[GY-I22](https://github.com/Sek1ro-oka/GengYun/issues/22)、[GY-I23](https://github.com/Sek1ro-oka/GengYun/issues/23) |
| GY-I25 | [#27 提前验证正式AppID、真机域名及AI和数据库服务接入](https://github.com/Sek1ro-oka/GengYun/issues/27) | M1 | P0 | 无 |
| GY-I26 | [#28 提前建立五Tab原生页面骨架、适老视觉及统一失败状态](https://github.com/Sek1ro-oka/GengYun/issues/28) | M1 | P1 | [GY-I02](https://github.com/Sek1ro-oka/GengYun/issues/2) |
| GY-I27 | [#29 前置用途授权、外发账本与隐私撤回接口守卫](https://github.com/Sek1ro-oka/GengYun/issues/29) | M1 | P0 | [GY-I01](https://github.com/Sek1ro-oka/GengYun/issues/1)、[GY-I02](https://github.com/Sek1ro-oka/GengYun/issues/2) |

## GY-I01 冻结原生微信小程序架构、数据字典与HTTP接口契约

[#1 冻结原生微信小程序架构、数据字典与HTTP接口契约](https://github.com/Sek1ro-oka/GengYun/issues/1)；开始阶段M1／完成阶段M1；P0；当前待领取。

在写功能前统一两端与服务端的契约，避免各组接口和来源规则各做一套。

前置：无。功能：F01、F03、F08、F12、F13、F20；验收：契约审查，不冒称应用AC已通过。

### 范围

- 用户端 WXML／WXSS／JavaScript，目录 miniprogram/，复用待审 chore/project-scaffold 的工程壳；核对并替换旧名称、病害识别及过时策划描述
- 默认服务端 Node.js 24 LTS／TypeScript／Fastify 5、独立网页 Vue 3／Vite、PostgreSQL 17 与私有对象存储；GY-I25 反馈后审查冻结精确版本，必要替换写 ADR
- 提交 ADR、数据字典、OpenAPI 与状态字典，包含账号、来源制剂版本、私有媒体、异步任务、语音会话、社区、收藏消息、授权外发和删除清单
- 定义会话／角色／归属、错误码、分页、版本、幂等、source_kind、真实／替身环境、供应商适配、取消与超时；前端只使用 HTTP 契约，不引用服务端私有 SDK

### 验收

- [ ] 首版及二月模块有清晰边界；首版无真实支付、人审、专家、真实预警及使用反馈
- [ ] ADR、数据字典及接口样例相互一致，媒体与服务端密钥不进入客户端
- [ ] 监工审查确认契约后，下游才按冻结版本开发；改变契约必须同步文档与依赖

### 提交证据

- ADR、数据字典、接口定义与失败状态示例
- 首版F／AC到模块的对应及变更影响清单

## GY-I02 整合原生小程序工程壳并建立独立后台、API与分层CI

[#2 整合原生小程序工程壳并建立独立后台、API与分层CI](https://github.com/Sek1ro-oka/GengYun/issues/2)；开始阶段M1／完成阶段M1；P0；当前待领取。

形成可重复启动和构建的基础工程，后续提交通过统一检查。

前置：[GY-I01](https://github.com/Sek1ro-oka/GengYun/issues/1)。功能：F01、F08、F12、F13；验收：AC07、AC09。

### 范围

- 以已审契约整合现有原生 miniprogram/ 工程壳，保持 project.config.json 的 compileType=miniprogram，不引入 Uniapp／Taro 或 App／H5 用户端
- 建立 apps/admin、services/api、packages/contracts、tests 与私有配置样例，根 npm 工具链只服务后台／API／检查，不为原生页面增加必需构建步骤
- 冻结运行版本、锁文件、依赖安装及 dev:api／dev:admin／lint／test:unit／test:contract／build／test:mini 命令；缺配置明确失败；提供数据库迁移和健康检查
- CI 做文档、静态、确定性单元／契约、后台／API构建；微信工具自动化为本机任务，真机和真实供应商证据分开；使用只读权限，不给未审代码生产密钥
- 修正旧工程壳 README 的产品范围、未定语音、测试号能力和个人配置假设；正式体验版开启域名校验，忽略个人配置且保留脱敏样例

### 验收

- [ ] 干净环境按说明可安装、构建、启动；命令与运行版本记录
- [ ] 缺失配置明确失败，测试替身与真实服务配置分开，不假记外部连接成功
- [ ] CI实际触发并通过，后续PR有明确检查名；不使用未审PR代码读取生产密钥
- [ ] 干净机器按 README 重现；原生页面用微信工具编译，Node 检查不冒称微信真机通过；记录基础库及工具版本和可用 CLI 路径

### 提交证据

- 构建与CI运行链接、测试日志和启动说明
- 配置字段清单，无密钥或个人媒体
- 现有工程壳整合差异、依赖锁、配置校验失败案例、分层 CI 检查名和本机工具自动化记录

## GY-I03 建立浙江首批资料清单与可替换数据库适配

[#3 建立浙江首批资料清单与可替换数据库适配](https://github.com/Sek1ro-oka/GengYun/issues/3)；开始阶段M1／完成阶段M1；P0；当前待领取。

比赛前接数据库，先把来源、覆盖和模拟边界做成可核查契约。

前置：[GY-I01](https://github.com/Sek1ro-oka/GengYun/issues/1)。功能：F02、F03、F14、F20；验收：AC02、AC12、AC22。

### 范围

- 浙江市县、4类作物和8组杂草映射到规范对象编号
- 目标20条普通除草剂记录，记录证号、成分含量剂型、场景、适用条件、来源、有效版本和核对状态
- 数据库适配与有来源种子／明显模拟资料模式可切换，导入校验和来源更新失效可追溯
- 覆盖水稻／玉米／大豆／油菜，稗草／狗尾草／荨麻类／马唐／牛筋草／看麦娘／藜／空心莲子草；20份独立除草剂登记标签为资料目标，缺可靠来源则列不足，不造登记号
- 外部数据库适配与本地比赛资料版本分开；提供导入校验、冲突报告、更新回滚和种子／模拟标记；模拟记录不进入真实用量依据或实际评估答案

### 验收

- [ ] 缺失、过期、冲突和未核对不标为有效；不虚构20条已完成
- [ ] 模拟資料全链路标记并不得作为真实用量依据，未接真实库报告接入缺项
- [ ] 实际来源和条目清单可复核；许可调查本轮暂缓但不得写成已许可

### 提交证据

- 字段映射、脱敏数据库样例和资料清单
- 有效／失效／冲突／模拟的导入及查询证据

## GY-I04 实现微信登录、游客限制与服务端归属权限

[#4 实现微信登录、游客限制与服务端归属权限](https://github.com/Sek1ro-oka/GengYun/issues/4)；开始阶段M1／完成阶段M1；P0；当前待领取。

登录方式已经确认；游客不能通过接口、分享链接或页面绕过访问限制。

前置：[GY-I02](https://github.com/Sek1ro-oka/GengYun/issues/2)、[GY-I25](https://github.com/Sek1ro-oka/GengYun/issues/27)、[GY-I27](https://github.com/Sek1ro-oka/GengYun/issues/29)。功能：F01、F13；验收：AC01、AC09。

### 范围

- 微信登录和会话建立／退出／过期，不强制手机号
- 游客仅首页预览，其他页和接口需登录；普通用户只访问自己的私有记录
- 独立后台鉴权、管理员初始化和普通用户高权限拒绝

### 验收

- [ ] 正常微信登录可用，拒绝额外资料仍可用基础用户功能
- [ ] 越权记录编号、直接API、分享和会话撤销检查通过
- [ ] 不使用客户端声称的角色／用户ID作为最终权限依据，不泄露登录凭据
- [ ] 微信一次性 code 经服务端换取身份，客户端不可指定 openid／角色；注销会话可立即撤销；正式 AppID 实测，不以测试号界面替代登录证据

### 提交证据

- 登录真机记录、权限矩阵与越权回归结果
- 脱敏会话／接口状态证据

## GY-I05 实现单作物地区档案及授权定位／手动选择

[#5 实现单作物地区档案及授权定位／手动选择](https://github.com/Sek1ro-oka/GengYun/issues/5)；开始阶段M2／完成阶段M2；P1；当前待领取。

首版浙江单作物／地区档案，定位只为选地区。

前置：[GY-I03](https://github.com/Sek1ro-oka/GengYun/issues/3)、[GY-I04](https://github.com/Sek1ro-oka/GengYun/issues/4)、[GY-I26](https://github.com/Sek1ro-oka/GengYun/issues/28)、[GY-I27](https://github.com/Sek1ro-oka/GengYun/issues/29)。功能：F02；验收：AC01、AC21、AC15。

### 范围

- 浙江市县和4类作物选择与修改
- 主动定位授权、地区转换、用户确认，拒绝／超时／省外可手选
- 不持续跟踪，不默认保存原始坐标或采集面积，多田块不进入首版

### 验收

- [ ] Android／iOS授权和拒绝路径可用，手选不依赖定位
- [ ] 修改档案不改写已保存识别、来源或后续实际记录快照
- [ ] 游客不可修改他人或登录用户档案
- [ ] 首版地区只筛选静态科普，不产生真实地区预警
- [ ] 定位仅即时选择地区，服务端不接收原始坐标；拒绝、取消、超时、省外与手选能继续，不引入轨迹／导航或真实预警

### 提交证据

- 真机权限流程与档案接口测试
- 地区覆盖及失败状态截图

## GY-I06 实现私有媒体上传、访问权限及EXIF清除

[#6 实现私有媒体上传、访问权限及EXIF清除](https://github.com/Sek1ro-oka/GengYun/issues/6)；开始阶段M1／完成阶段M1；P0；当前待领取。

识别、语音和社区共享媒体能力，但上传不等于公开。

前置：[GY-I02](https://github.com/Sek1ro-oka/GengYun/issues/2)、[GY-I04](https://github.com/Sek1ro-oka/GengYun/issues/4)、[GY-I27](https://github.com/Sek1ro-oka/GengYun/issues/29)。功能：F05、F12、F13、F15、F16；验收：AC07、AC09、AC23。

### 范围

- 图片／音频类型大小校验、上传取消重试与对象归属；图片去EXIF
- 社区每帖最多3图、单图≤5MB；语音≤60秒、≤10MB；识别图片按评估条件压缩≤2MB
- 私有媒体受鉴权，社区审核前不公开；用途授权和删除任务记录可接入
- 服务端核验文件真实类型、尺寸、字节数、用户和用途；上传完成仅生成 private 对象，短效签名访问不代表公开权限；清除 EXIF 并清理失败／取消的孤立文件

### 验收

- [ ] 伪扩展名、超限、越权URL、重复上传／任务和取消按契约处理
- [ ] 原始位置／私人媒体不出现在公共列表或普通日志
- [ ] 音频编码与服务商适配真实核实，不把产品限额冒充官方接口限制
- [ ] 未授权、伪后缀、超大、跨账号、重复提交和过期访问均受控；帖图最多3张每张5MB，录音60秒10MB，识别按2MB真实性能集验证

### 提交证据

- 权限／类型／大小／EXIF与失败测试
- 媒体对象生命周期和授权访问说明

## GY-I07 实现科普／除草剂查询、详情与来源版本展示

[#7 实现科普／除草剂查询、详情与来源版本展示](https://github.com/Sek1ro-oka/GengYun/issues/7)；开始阶段M2／完成阶段M2；P0；当前待领取。

用户可以查资料且辨别来源、核对状态及适用条件。

前置：[GY-I03](https://github.com/Sek1ro-oka/GengYun/issues/3)、[GY-I04](https://github.com/Sek1ro-oka/GengYun/issues/4)。功能：F03、F14；验收：AC02、AC22。

### 范围

- 作物—杂草—除草方式导航及关键词／地区筛选
- 详情同时展示制剂、条件、风险、原文来源、版本与更新时间
- 无结果、失效、未核对和模拟状态，支持继续查询
- 中文药名／登记号词典与结构化条件优先查询；列表详情使用同一 source_version，不以模糊药名合并不同含量剂型，不默认要求向量数据库

### 验收

- [ ] 任一展示记录能追溯实际来源；缺项不通过空白或模型补写填充
- [ ] 下架／失效退出有效查询，详情和列表一致
- [ ] 不授AI／用户经验专家认证标签，不对模拟记录显示真实用量

### 提交证据

- 真实／种子／模拟／无结果的接口及页面证据
- 来源版本和下架缓存回归

## GY-I08 实现药剂适用过滤与标签原文用量安全边界

[#8 实现药剂适用过滤与标签原文用量安全边界](https://github.com/Sek1ro-oka/GengYun/issues/8)；开始阶段M2／完成阶段M2；P0；当前待领取。

来源和确定性规则先检查，模型或用户选中候选都不能绕过。

前置：[GY-I07](https://github.com/Sek1ro-oka/GengYun/issues/7)。功能：F04、F14、F20；验收：AC13、AC14、AC22。

### 范围

- 检查禁限用、作物、生育期、地区、制剂、含量剂型、使用场景及有效来源
- 缺条件或冲突说明原因，不静默放宽；有来源才能比较风险路线，不能凑两选项
- 用量仅由原文卡片渲染并绑定数字单位和条件，关闭个人处方／混配／自动换算

### 验收

- [ ] 至少100组登记／匹配／限制场景全部通过，含冲突、失效、未知和模拟
- [ ] 未核对／不适用／禁用不能进入可执行建议或问答用量卡片
- [ ] 所有风险文字无绝对安全／零药害承诺，有功能关闭开关
- [ ] 需求第6节100组登记／制剂／来源冲突用例全过；无来源、模拟、失效、多匹配和关键字段冲突均阻断，所有消费端使用同一规则版本

### 提交证据

- 确定性规则来源及版本、100组结果
- 原文数字／单位／条件比对与关闭功能证据

## GY-I09 实现实时拍草识别、Top3核对及不确定处理

[#9 实现实时拍草识别、Top3核对及不确定处理](https://github.com/Sek1ro-oka/GengYun/issues/9)；开始阶段M2／完成阶段M2；P0；当前待领取。

识草提供候选和查询输入，不能直接开出处方。

前置：[GY-I05](https://github.com/Sek1ro-oka/GengYun/issues/5)、[GY-I06](https://github.com/Sek1ro-oka/GengYun/issues/6)、[GY-I07](https://github.com/Sek1ro-oka/GengYun/issues/7)、[GY-I08](https://github.com/Sek1ro-oka/GengYun/issues/8)、[GY-I25](https://github.com/Sek1ro-oka/GengYun/issues/27)、[GY-I20](https://github.com/Sek1ro-oka/GengYun/issues/20)。功能：F15；验收：AC11、AC22。

### 范围

- 真实识别任务、进度、模型版本、候选至多Top3及原始结果
- 不确定、覆盖外／低质量、权限拒绝、无结果、超时和重拍
- 用户选择独立记录，关联科普及条件完整后查询，保存私有历史

### 验收

- [ ] 实际服务调用有证据，预设仅明显标注兜底，不算准确率
- [ ] 无可信分数不伪造高置信，候选少于3不补造
- [ ] 任务归属与重试安全，不能跳过GY-I08
- [ ] 实现时就运行本能力需求第6节评估；新供应商／阈值／提示词／资料版本变化重评，不等M4首次测，预设和用户手改不能计模型准确率

### 提交证据

- 实时调用／任务版本、真机流程与错误样例
- 样本测量交GY-I21，不以手工选对计识别正确
- 已审适配器／服务版本、真实请求编号与耗时、授权外发记录、对应独立样本指标；脱敏报告，不上传原始个人媒体或凭据

## GY-I10 实现实时标签OCR、用户校正及登记精确核对

[#10 实现实时标签OCR、用户校正及登记精确核对](https://github.com/Sek1ro-oka/GengYun/issues/10)；开始阶段M2／完成阶段M2；P0；当前待领取。

OCR提字与登记核对分开，文字识别成功不代表药剂已核实。

前置：[GY-I06](https://github.com/Sek1ro-oka/GengYun/issues/6)、[GY-I07](https://github.com/Sek1ro-oka/GengYun/issues/7)、[GY-I08](https://github.com/Sek1ro-oka/GengYun/issues/8)、[GY-I25](https://github.com/Sek1ro-oka/GengYun/issues/27)、[GY-I20](https://github.com/Sek1ro-oka/GengYun/issues/20)。功能：F16；验收：AC12、AC22。

### 范围

- 实时提取证号／名称／成分／含量／剂型，用户核对修改
- 证号精确检索及字段比对，冲突／无匹配／多结果／失效状态
- 来源原文卡片和版本，关联私有历史与后续语音问答

### 验收

- [ ] 模糊字段有核对入口，同名不同制剂不静默匹配
- [ ] 校正前原始结果保留，手工改写不计OCR准确率
- [ ] 冲突阻断用量卡片，服务失败／超时不伪造成功
- [ ] 实现时就运行本能力需求第6节评估；新供应商／阈值／提示词／资料版本变化重评，不等M4首次测，预设和用户手改不能计模型准确率

### 提交证据

- 原始OCR与人工校正／登记结果分别记录
- 真实服务、冲突及权限测试
- 已审适配器／服务版本、真实请求编号与耗时、授权外发记录、对应独立样本指标；脱敏报告，不上传原始个人媒体或凭据

## GY-I11 实现普通话录音、实时ASR转写和发送核对

[#11 实现普通话录音、实时ASR转写和发送核对](https://github.com/Sek1ro-oka/GengYun/issues/11)；开始阶段M2／完成阶段M2；P0；当前待领取。

这是最新追加的首版必交项，用于向大模型发语音提问。

前置：[GY-I04](https://github.com/Sek1ro-oka/GengYun/issues/4)、[GY-I06](https://github.com/Sek1ro-oka/GengYun/issues/6)、[GY-I25](https://github.com/Sek1ro-oka/GengYun/issues/27)、[GY-I20](https://github.com/Sek1ro-oka/GengYun/issues/20)。功能：F12；验收：AC28、AC09。

### 范围

- 主动录音授权、停止取消重录，≤60秒／≤10MB
- 真实普通话ASR、可编辑转写及确认发送，药名数字单位否定词需核对
- 拒权／无声噪声／断网／超时改为重试或文字输入，语音不自动投稿
- 先实测微信录音编码与供应商支持，60秒10MB限额主动录音，页面隐藏／取消停止并释放监听；转写可编辑且用户确认发送，取消不外发后续问答

### 验收

- [ ] 真实ASR与转写状态可追溯，不用预设文本冒充服务
- [ ] 关键字段不清晰不自动发送或产生个人用药指令
- [ ] 音频转写私有保存及外发授权接F13，首版不要求方言／离线／导航
- [ ] 实现时就运行本能力需求第6节评估；新供应商／阈值／提示词／资料版本变化重评，不等M4首次测，预设和用户手改不能计模型准确率

### 提交证据

- 实际录音权限和失败流程、原始转写与修改记录
- 50段评估由GY-I21执行
- 已审适配器／服务版本、真实请求编号与耗时、授权外发记录、对应独立样本指标；脱敏报告，不上传原始个人媒体或凭据

## GY-I12 实现有来源的语音／文字大模型问答与回答安全检查

[#12 实现有来源的语音／文字大模型问答与回答安全检查](https://github.com/Sek1ro-oka/GengYun/issues/12)；开始阶段M2／完成阶段M2；P0；当前待领取。

普通话转写或文字输入交大模型，回答有依据、可追问且不会伪造用药结论。

前置：[GY-I07](https://github.com/Sek1ro-oka/GengYun/issues/7)、[GY-I08](https://github.com/Sek1ro-oka/GengYun/issues/8)、[GY-I06](https://github.com/Sek1ro-oka/GengYun/issues/6)、[GY-I25](https://github.com/Sek1ro-oka/GengYun/issues/27)、[GY-I27](https://github.com/Sek1ro-oka/GengYun/issues/29)、[GY-I20](https://github.com/Sek1ro-oka/GengYun/issues/20)。功能：F20、F12、F13；验收：AC29、AC22、AC09。

### 范围

- 检索有效可访问资料，保存引用编号／标题／版本及会话上下文
- 回复文字与可朗读内容，来源仅取检索集合，缺资料／冲突／超范围说明不足
- 回答完成来源／风险／结构检查后再显示朗读；用户与检索内容的提示注入不改变规则
- 具体用量仅GY-I08原文卡片，关闭个性处方混配换算，模型失败明确重试
- 文本确认提问可先实现，与 GY-I11 的语音转写按相同文本契约集成；资料过滤→检索→生成→来源及安全检查→完整回答，回答检查前不向用户流式输出

### 验收

- [ ] 实时模型调用有证据，私有会话及单条删除可核查
- [ ] 不存在虚构URL／登记号／专家身份，未审生成内容不流式曝光
- [ ] 危险操作／伤害问题不引导继续接触；不冒充专家或医疗诊断
- [ ] 实现时就运行本能力需求第6节评估；新供应商／阈值／提示词／资料版本变化重评，不等M4首次测，预设和用户手改不能计模型准确率
- [ ] 固定120题按需求验收，引用来自检索证据且有效，不由模型造链接；来源不足、冲突、注入及危险用法按预期拒答，不能把模拟回答算实时效果

### 提交证据

- 检索证据和回答版本、缺资料／注入／风险回归
- 120题真实问答评估由GY-I21执行
- 已审适配器／服务版本、真实请求编号与耗时、授权外发记录、对应独立样本指标；脱敏报告，不上传原始个人媒体或凭据

## GY-I13 实现普通话TTS、播放球及安全文本自动播报

[#13 实现普通话TTS、播放球及安全文本自动播报](https://github.com/Sek1ro-oka/GengYun/issues/13)；开始阶段M2／完成阶段M2；P1；当前待领取。

统一页面导航与播放／录音入口，视觉和播报均符合首版。

前置：[GY-I26](https://github.com/Sek1ro-oka/GengYun/issues/28)、[GY-I08](https://github.com/Sek1ro-oka/GengYun/issues/8)、[GY-I25](https://github.com/Sek1ro-oka/GengYun/issues/27)、[GY-I27](https://github.com/Sek1ro-oka/GengYun/issues/29)、[GY-I20](https://github.com/Sek1ro-oka/GengYun/issues/20)。功能：F12、F14；验收：AC06、AC14、AC18。

### 范围

- 五Tab和基础视觉已拆到 GY-I26，本项接入经审核科普／风险卡片和问答的普通话 TTS；问答接口可按契约替身开发，最终联调不得以替身验收
- 统一语音球与等效播放／暂停／停止／重播按钮，录音与播放控件分离；页面退出取消任务、释放音频和监听，避免重复播报和后台残留
- 完整安全检查通过后才合成及播报；数字、单位、制剂条件与否定词正确，自动播放失败有文字和主动播放；首版无方言／离线／震动／语音导航

### 验收

- [ ] 至少30段实际普通话风险／数字单位播报样例全部准确
- [ ] 静音／蓝牙／拒权／平台阻止自动播放有主动按钮和文字，不假记已听取
- [ ] 控制不遮挡提交或风险信息；首版不做语音导航／方言／震动
- [ ] 实现时就运行本能力需求第6节评估；新供应商／阈值／提示词／资料版本变化重评，不等M4首次测，预设和用户手改不能计模型准确率

### 提交证据

- Android／iOS真机音频及交互记录
- 30段核对、无障碍与播放失败证据
- 已审适配器／服务版本、真实请求编号与耗时、授权外发记录、对应独立样本指标；脱敏报告，不上传原始个人媒体或凭据

## GY-I14 实现文字／图片AI筛查、版本重审和失败隔离

[#14 实现文字／图片AI筛查、版本重审和失败隔离](https://github.com/Sek1ro-oka/GengYun/issues/14)；开始阶段M2／完成阶段M2；P0；当前待领取。

社区先审后发，AI失败不能依赖未上线人工放行。

前置：[GY-I03](https://github.com/Sek1ro-oka/GengYun/issues/3)、[GY-I06](https://github.com/Sek1ro-oka/GengYun/issues/6)、[GY-I25](https://github.com/Sek1ro-oka/GengYun/issues/27)、[GY-I20](https://github.com/Sek1ro-oka/GengYun/issues/20)。功能：F08、F05；验收：AC19、AC08、AC16。

### 范围

- 规则＋真实AI筛查文字图片、结构结果／理由／证据／模型模板规则版本
- 待筛查／通过／待复核／驳回／发布／下架状态，编辑生成新版本重审
- 危险混配、无依据个人用量、隐私、广告购买链接私交易和提示注入拦截；失败隔离
- 文字及图片均有版本级审核任务，规则先挡广告交易和硬危险边界；AI失败／超时／无结论保持隔离，审核回调校验签名和版本，不能发布旧版本结果

### 验收

- [ ] 旧版本审核结果不能套新版本，超时／结构错误不发布
- [ ] AI不授权限、改来源或标专家已审，公众票决不进入首版
- [ ] 筛查通过与发布分开，下架事件可驱动缓存失效
- [ ] 实现时就运行本能力需求第6节评估；新供应商／阈值／提示词／资料版本变化重评，不等M4首次测，预设和用户手改不能计模型准确率

### 提交证据

- 结构契约、版本并发和失败回归
- 200风险＋200正常评估由GY-I21执行
- 已审适配器／服务版本、真实请求编号与耗时、授权外发记录、对应独立样本指标；脱敏报告，不上传原始个人媒体或凭据

## GY-I15 实现真实社区发帖、评论、点赞、筛选与举报

[#15 实现真实社区发帖、评论、点赞、筛选与举报](https://github.com/Sek1ro-oka/GengYun/issues/15)；开始阶段M3／完成阶段M3；P1；当前待领取。

首版社区实际互动，只有人工审核板块留空。

前置：[GY-I04](https://github.com/Sek1ro-oka/GengYun/issues/4)、[GY-I05](https://github.com/Sek1ro-oka/GengYun/issues/5)、[GY-I07](https://github.com/Sek1ro-oka/GengYun/issues/7)、[GY-I14](https://github.com/Sek1ro-oka/GengYun/issues/14)、[GY-I26](https://github.com/Sek1ro-oka/GengYun/issues/28)、[GY-I27](https://github.com/Sek1ro-oka/GengYun/issues/29)。功能：F05、F08；验收：AC08、AC16、AC19。

### 范围

- 文字／图片帖子评论、作物地区筛选、杂草／药剂关联
- 点赞幂等、编辑删除自己的内容、举报与处理状态
- 接AI先审后发，普通互助身份，未通过内容不公开，事件给消息中心

### 验收

- [ ] 普通用户可投稿评论并经过真实审核，非空态或假帖子
- [ ] 编辑重审／下架后列表详情引用一致，广告导流不发布
- [ ] 游客／越权／重复点赞与评论引用隐藏版本检查通过
- [ ] 列表、详情、收藏历史和消息均在读取时重查对象权限及当前可见性；隐藏／失效／注销不因缓存或旧链接重新公开

### 提交证据

- 从投稿到发布／隔离的端到端证据
- 权限、重审、商业禁止及重复操作回归

## GY-I16 实现收藏与可浏览的识别历史

[#16 实现收藏与可浏览的识别历史](https://github.com/Sek1ro-oka/GengYun/issues/16)；开始阶段M3／完成阶段M3；P1；当前待领取。

收藏和历史已确认首版必交，不能只存数据没有页面。

前置：[GY-I04](https://github.com/Sek1ro-oka/GengYun/issues/4)、[GY-I09](https://github.com/Sek1ro-oka/GengYun/issues/9)、[GY-I10](https://github.com/Sek1ro-oka/GengYun/issues/10)、[GY-I26](https://github.com/Sek1ro-oka/GengYun/issues/28)、[GY-I27](https://github.com/Sek1ro-oka/GengYun/issues/29)。功能：F18；验收：AC17、AC09。

### 范围

- 杂草／药剂／方案收藏及取消去重
- 历史列表与详情，时间／任务类型／模型候选／选择／OCR核对／来源版本／失败状态
- 下架失效和权限变化有状态，注销删除接F13

### 验收

- [ ] 他人不能读取私有历史，旧收藏不恢复失效推荐资格
- [ ] 候选与人工选择分开，失败任务真实可见
- [ ] 识别／收藏不自动转成已使用事实
- [ ] 列表、详情、收藏历史和消息均在读取时重查对象权限及当前可见性；隐藏／失效／注销不因缓存或旧链接重新公开

### 提交证据

- 页面及归属测试、下架与失败历史回归
- 收藏重复取消与记录版本证据

## GY-I17 实现首版应用内消息、未读状态与权限跳转

[#17 实现首版应用内消息、未读状态与权限跳转](https://github.com/Sek1ro-oka/GengYun/issues/17)；开始阶段M3／完成阶段M3；P1；当前待领取。

首版仅应用内，消息事件、对象可见性及阅读状态一致。

前置：[GY-I04](https://github.com/Sek1ro-oka/GengYun/issues/4)、[GY-I14](https://github.com/Sek1ro-oka/GengYun/issues/14)、[GY-I15](https://github.com/Sek1ro-oka/GengYun/issues/15)、[GY-I26](https://github.com/Sek1ro-oka/GengYun/issues/28)、[GY-I27](https://github.com/Sek1ro-oka/GengYun/issues/29)。功能：F19；验收：AC18、AC09。

### 范围

- 评论／点赞／AI审核／系统事件消息，来源事件与版本去重
- 未读数量、已读及对象跳转
- 对象下架、删除或无权限后不泄露受限正文，注销去身份同步

### 验收

- [ ] 重复调度不重复创建，未读计数可复核
- [ ] 发送或创建不当作已读；游客和其他用户不可读
- [ ] 首版不接微信外部推送，不虚构真人互动消息
- [ ] 列表、详情、收藏历史和消息均在读取时重查对象权限及当前可见性；隐藏／失效／注销不因缓存或旧链接重新公开

### 提交证据

- 事件幂等与对象权限回归
- 列表／未读／跳转端到端证据

## GY-I18 实现独立后台资料、账号、AI任务及功能开关

[#18 实现独立后台资料、账号、AI任务及功能开关](https://github.com/Sek1ro-oka/GengYun/issues/18)；开始阶段M3／完成阶段M3；P0；当前待领取。

后台独立鉴权，首版管理实际可用，人工板块显示建设中。

前置：[GY-I04](https://github.com/Sek1ro-oka/GengYun/issues/4)、[GY-I07](https://github.com/Sek1ro-oka/GengYun/issues/7)、[GY-I08](https://github.com/Sek1ro-oka/GengYun/issues/8)、[GY-I14](https://github.com/Sek1ro-oka/GengYun/issues/14)、[GY-I26](https://github.com/Sek1ro-oka/GengYun/issues/28)、[GY-I27](https://github.com/Sek1ro-oka/GengYun/issues/29)。功能：F08、F13、F14；验收：AC08、AC09、AC19。

### 范围

- 资料来源／版本／分类及限制规则维护，关键修改留责任人和范围
- 账号授权、AI任务／错误／隔离查看、停止投稿或药剂输出开关
- 人审入口为空态，无假任务／审核人／投票和专家认证

### 验收

- [ ] 普通账号不能管理或绕过硬规则，变更来源会重新校验和失效相关引用
- [ ] 全局开关真实生效，下架缓存和详情同步
- [ ] 不将基础账号管理说成人工评审已完成
- [ ] 列表、详情、收藏历史和消息均在读取时重查对象权限及当前可见性；隐藏／失效／注销不因缓存或旧链接重新公开

### 提交证据

- 独立后台权限、配置开关和审计记录
- 来源修改／下架缓存回归

## GY-I19 贯通注销去身份、在线7日备份30日删除与恢复验收

[#19 贯通注销去身份、在线7日备份30日删除与恢复验收](https://github.com/Sek1ro-oka/GengYun/issues/19)；开始阶段M3／完成阶段M3；P0；当前待领取。

删除包括私有媒体、会话、第三方副本与模型影响，不只是改昵称。

前置：[GY-I04](https://github.com/Sek1ro-oka/GengYun/issues/4)、[GY-I06](https://github.com/Sek1ro-oka/GengYun/issues/6)、[GY-I11](https://github.com/Sek1ro-oka/GengYun/issues/11)、[GY-I12](https://github.com/Sek1ro-oka/GengYun/issues/12)、[GY-I15](https://github.com/Sek1ro-oka/GengYun/issues/15)、[GY-I16](https://github.com/Sek1ro-oka/GengYun/issues/16)、[GY-I17](https://github.com/Sek1ro-oka/GengYun/issues/17)、[GY-I18](https://github.com/Sek1ro-oka/GengYun/issues/18)、[GY-I27](https://github.com/Sek1ro-oka/GengYun/issues/29)。功能：F13、F01、F20；验收：AC23、AC09。

### 范围

- 外发推理、公开投稿、录音及训练目的分开记录，默认不向第三方基础模型供训练
- 注销立即撤会话角色并停外发训练，在线7日／备份30日任务及失败证据
- 帖子评论默认头像／显示已注销用户，删除身份映射，正文附件个人信息脱敏或隐藏
- 接收方删除请求／完成／失败状态，备份恢复重放清单；受影响可控模型停部署、权重7／30日删除及重训验收流程
- 授权和外发账本消费 GY-I27，不重复实现；模块登记删除处理器，注销立即撤销会话并阻断在途任务外发及旧结果回写；帖子评论保留但移除账户映射、头像和可识别正文附件
- 第三方记录请求／完成／失败证据及重试；无可核验完成不得标删净；恢复后先重放独立受控删除清单再开放查询，清单不可恢复出用户关联数据
- 首版不启动用户数据训练；训练功能以后启用前要求独立同意和样本／衍生物谱系、受影响模型停用与重评；未知删除能力的第三方训练不可启用

### 验收

- [ ] 任务覆盖账号、音频／转写／问答、识别、媒体、收藏消息、缓存／导出等实际对象
- [ ] 未获第三方确认不标完成，无法验证删除的服务不接个人训练
- [ ] 不同注销作者不混同数据库主键；无身份反查，保留帖子不保留私人头像坐标

### 提交证据

- 加速时钟或可控时间的删除／恢复演练，期限按真实任务时间复核
- 第三方留存删除能力、授权清单与模型来源关系说明
- 可控时钟7／30日边界、注销与在途回调并发、第三方失败状态、备份恢复后仍不可访问和帖子去身份的集成报告

## GY-I20 冻结独立评估样本、标准答案及评估程序

[#20 冻结独立评估样本、标准答案及评估程序](https://github.com/Sek1ro-oka/GengYun/issues/20)；开始阶段M1／完成阶段M1；P0；当前待领取。

先冻结样本，防止测试集调参泄漏或用预设答案冒充评估。

前置：[GY-I03](https://github.com/Sek1ro-oka/GengYun/issues/3)。功能：F15、F16、F08、F12、F20；验收：AC11、AC12、AC19、AC28、AC29。

### 范围

- 拍草≥300独立清晰照片且每类≥30、覆盖外100、低质量100
- 标签清晰200含≥20记录及低质量100；规则登记100场景
- AI200风险＋200正常；普通话50段≥10人；TTS30段；问答120题（60可答＋20不足＋20危险＋20注入）
- 来源、标注、近重复排除、训练验证测试隔离、版本和95%置信区间程序
- 按代码需求第6节冻结样本索引、标准答案、来源、独立分组和内容hash；近重复／裁剪／连拍不能跨训练调参与测试；记录每类和拒识样本，原始私有样本不提交Git
- 指标程序和评分规约先交PR，实际样本不足列阻塞；风险400例、ASR50段10人、问答120题、TTS30段及两类图片全量均不可用演示样本替代

### 验收

- [ ] 独立核实标准答案，模型不得作为自己的答案；同源裁剪／连拍不跨训练测试
- [ ] 样本实际不足如实记录未完成，不用生成或重复媒体充数
- [ ] 冻结清单、来源、划分与评估口径先经监工审查

### 提交证据

- 脱敏样本索引／哈希与标注说明，原始私有样本不提交仓库
- 可重复评估命令和预期输出结构

## GY-I21 持续评估各项真实AI能力并汇总首版验收门槛

[#21 持续评估各项真实AI能力并汇总首版验收门槛](https://github.com/Sek1ro-oka/GengYun/issues/21)；开始阶段M1／完成阶段M4；P0；当前待领取。

以冻结独立集验证实际模型；运行界面或少量演示不是达标证明。

前置：[GY-I09](https://github.com/Sek1ro-oka/GengYun/issues/9)、[GY-I10](https://github.com/Sek1ro-oka/GengYun/issues/10)、[GY-I11](https://github.com/Sek1ro-oka/GengYun/issues/11)、[GY-I12](https://github.com/Sek1ro-oka/GengYun/issues/12)、[GY-I13](https://github.com/Sek1ro-oka/GengYun/issues/13)、[GY-I14](https://github.com/Sek1ro-oka/GengYun/issues/14)、[GY-I20](https://github.com/Sek1ro-oka/GengYun/issues/20)。功能：F15、F16、F12、F20、F08；验收：AC11、AC12、AC06、AC19、AC28、AC29。

### 范围

- 按需求第6.1运行固定模型／规则版本并报告逐类和总体及置信区间
- 拍草Top1≥85%／Top3≥95%，覆盖外高置信误放≤5%，低质拒识≥95%
- OCR证号及可见关键字段各≥95%；AI召回≥95%／正常误隔离≤10%，硬规则全部通过
- ASR字符错误率≤15%／药名数字单位≥95%；问答可答正确有依据≥95%，其他固定危险不足注入预期全部通过；TTS30固定样例全部准确
- M1准备评估程序并随每个能力PR运行，M2先行复测；M4只是全量复评与汇总签核，保留逐类结果、置信区间、失败样例及改动前后对比

### 验收

- [ ] 任何不达标项明确失败及整改，不能用手改／预设提高指标
- [ ] 真实调用有证据，报告样本数、版本、覆盖和实际失败
- [ ] 固定用例通过不宣传现实零风险；原始私有媒体、凭据不写日志或提交

### 提交证据

- 可复现命令、数据版本、实际评估报告及失败清单
- 监工可独立重跑或抽核的脱敏结果

## GY-I22 完成权限、安全规则及首版端到端失败回归

[#22 完成权限、安全规则及首版端到端失败回归](https://github.com/Sek1ro-oka/GengYun/issues/22)；开始阶段M4／完成阶段M4；P0；当前待领取。

验证模块联动和真实失败，阻止单模块通过却整体越权或放行。

前置：[GY-I05](https://github.com/Sek1ro-oka/GengYun/issues/5)、[GY-I08](https://github.com/Sek1ro-oka/GengYun/issues/8)、[GY-I09](https://github.com/Sek1ro-oka/GengYun/issues/9)、[GY-I10](https://github.com/Sek1ro-oka/GengYun/issues/10)、[GY-I12](https://github.com/Sek1ro-oka/GengYun/issues/12)、[GY-I14](https://github.com/Sek1ro-oka/GengYun/issues/14)、[GY-I15](https://github.com/Sek1ro-oka/GengYun/issues/15)、[GY-I16](https://github.com/Sek1ro-oka/GengYun/issues/16)、[GY-I17](https://github.com/Sek1ro-oka/GengYun/issues/17)、[GY-I18](https://github.com/Sek1ro-oka/GengYun/issues/18)、[GY-I19](https://github.com/Sek1ro-oka/GengYun/issues/19)。功能：F01、F04、F05、F08、F13、F20；验收：AC01、AC02、AC07、AC08、AC09、AC13、AC16、AC19、AC21、AC22、AC23、AC29。

### 范围

- 游客／越权／会话注销／媒体访问及普通用户后台拒绝
- 来源失效／模拟／错误制剂／缺条件／AI失败／注入／内容版本变更
- 网络失败、重复请求、下架缓存与消息／收藏引用、注销匿名保留和外部删除状态
- 覆盖在途取消／注销／撤回、重复回调、内容修改旧审核回写、无效来源缓存、上传签名与媒体归属、伪造角色以及模拟与真实环境交叉访问

### 验收

- [ ] 有限关键安全及权限用例全部通过，未解决严重安全／权限缺陷0
- [ ] 实际接口状态及数据结果可核对，不能只交截图或实现同形测试
- [ ] 任何处方混配换算、伪来源或未审内容公开均阻止发布

### 提交证据

- 集成回归用例与日志、整改后结果
- 安全／权限检查清单及未解决限制

## GY-I23 执行Android／iOS真机、时延容量及完整演示验收

[#23 执行Android／iOS真机、时延容量及完整演示验收](https://github.com/Sek1ro-oka/GengYun/issues/23)；开始阶段M4／完成阶段M4；P0；当前待领取。

按确定条件量化首版体验，包含最新语音问答链路。

前置：[GY-I16](https://github.com/Sek1ro-oka/GengYun/issues/16)、[GY-I17](https://github.com/Sek1ro-oka/GengYun/issues/17)、[GY-I18](https://github.com/Sek1ro-oka/GengYun/issues/18)、[GY-I19](https://github.com/Sek1ro-oka/GengYun/issues/19)、[GY-I21](https://github.com/Sek1ro-oka/GengYun/issues/21)、[GY-I22](https://github.com/Sek1ro-oka/GengYun/issues/22)。功能：F02、F05、F12、F15、F16、F18、F19、F20；验收：AC06、AC07、AC11、AC12、AC14、AC17、AC18、AC21、AC28、AC29。

### 范围

- Android／iOS各≥1实际设备，全链登录档案识别资料语音问答社区收藏历史消息后台
- 稳定≥20Mbps、往返≤100ms，每项≥30次；首屏p95≤2秒、查询≤3秒
- 真实识别≤2MB p95≤10秒／失败≤5%，30秒超时；≤30秒语音上传完转写p95≤5秒、确认发送到检查后的回答≤10秒
- 内部50并发虚拟用户10分钟、错误≤1%；外部AI用隔离替身压测，真实额度耗时分开报告
- M1先验证正式AppID真机入口和录音，M2验证核心路径，M4在Android／iOS各至少一台做最终回归；工具模拟器不计双平台真机
- 按需求网络条件各至少30次，记录完整路径与上传／供应商时间；50VU10分钟压测只用隔离AI替身，真实AI额度和时延另报

### 验收

- [ ] 记录设备系统微信／资源／缓存／网络和完整样本，不挑最快次数
- [ ] 静音蓝牙拒权断网重播可见状态，生成回答审查前不播放
- [ ] 不把内部替身压测称外部AI容量，未测部分明确未测

### 提交证据

- 真机记录、性能分位数／容量报告和演示脚本
- 全部首版AC对应的验证证据

## GY-I24 部署联网比赛版、备份恢复并交付完整材料

[#24 部署联网比赛版、备份恢复并交付完整材料](https://github.com/Sek1ro-oka/GengYun/issues/24)；开始阶段M4／完成阶段M4；P0；当前待领取。

将通过验证的固定版本交付给比赛操作者，未测或依赖缺项如实报告。

前置：[GY-I21](https://github.com/Sek1ro-oka/GengYun/issues/21)、[GY-I22](https://github.com/Sek1ro-oka/GengYun/issues/22)、[GY-I23](https://github.com/Sek1ro-oka/GengYun/issues/23)。功能：F01、F08、F13、F15、F16、F20；验收：AC07、AC09、AC23。

### 范围

- 比赛前接真实数据库、手机体验版和独立后台；运行环境／配置／额度与网络赛前检查
- 备份恢复一次并重放删除清单，资料停用／AI失败和回滚步骤
- 源码版本、部署配置模板、接口数据字典、操作手册、覆盖及评估报告、已知限制与演示脚本
- 部署以已审版本和单独明确授权执行，文档/PR合并不是生产部署许可；先交可复现部署、迁移、回滚、HTTPS、对象存储和删除恢复演练说明
- 实际比赛体验版成员／二维码、网络和设备验证，基础库与服务配置冻结；不把网页静态演示、测试号、关闭域名校验或标注预设当真实比赛交付

### 验收

- [ ] 首版必交AC均有对应证据，安全及权限缺陷0，未达标不标完成
- [ ] 联网真实识别／ASR／问答可用，预设仅标注兜底，不交离线功能
- [ ] 无真实支付、人审／专家／地区预警或反馈假上线，无原始隐私媒体和密钥提交

### 提交证据

- 最终提交SHA／构建版本与验收清单
- 备份恢复／赛前检查及交付材料链接

## GY-I25 提前验证正式AppID、真机域名及AI和数据库服务接入

[#27 提前验证正式AppID、真机域名及AI和数据库服务接入](https://github.com/Sek1ro-oka/GengYun/issues/27)；开始阶段M1／完成阶段M1；P0；当前待领取。

在架构和功能投入前验证实际接入条件；资源声明具备不等于账号、权限、返回格式和删除能力已经验证。

前置：无。功能：F01、F12、F13、F15、F16、F20、F08；验收：AC07、AC09、AC11、AC12、AC19、AC21、AC28、AC29。

### 范围

- 核查团队正式AppID、开发者及体验成员、主体所选能力、隐私声明、合法request／upload／download域名与HTTPS；测试号仅做界面辅助，记录实际工具与基础库版本
- 用获准非个人测试资料最小调用识草、OCR、普通话ASR、TTS、大模型和文字／图片AI筛查六类服务；记录认证方式、请求响应字段、编码尺寸、超时、并发额度、版本和预计评估调用量
- 核查推理用途的外发和留存／删除设置，无用户用途授权前不传真实用户资料；测试响应不得记录密钥；额度／费用由团队配置，不擅自付费开通
- 取得数据库脱敏字段样例并验证登记制剂映射，接入失败或资料缺失明确列阻塞；以受控HTTPS服务在Android／iOS提前验证请求上传和录音，未接服务可先列未验但不能关闭整项

### 验收

- [ ] 六类服务至少各一个真实成功样例和一个受控失败路径，正式AppID／真机联网及录音格式有证据；测试号、模拟和缺失资格如实列出，不冒称可用
- [ ] 密钥只在服务端，模型／资料不公开隐私，接口权限与删除处理能力形成可核查记录；未知训练留存禁止用户数据训练
- [ ] 输出接入矩阵、阻塞及替代适配方案，GY-I01据此冻结配置；本任务验证接入，不替代需求中的全量准确率与性能验收

### 提交证据

- 脱敏接入矩阵、服务／工具／基础库版本和请求编号，域名及真机测试记录
- 返回schema、授权留存删除说明、数据库字段样例和按需求样本数量的额度估算

## GY-I26 提前建立五Tab原生页面骨架、适老视觉及统一失败状态

[#28 提前建立五Tab原生页面骨架、适老视觉及统一失败状态](https://github.com/Sek1ro-oka/GengYun/issues/28)；开始阶段M1／完成阶段M1；P1；当前待领取。

解除界面开发对完整语音流水线的等待，先用冻结HTTP契约联调替身，再逐项替换真实服务。

前置：[GY-I02](https://github.com/Sek1ro-oka/GengYun/issues/2)。功能：F01、F02、F05、F12、F14、F18、F19、F20；验收：AC01、AC06、AC07、AC08、AC14、AC15、AC17、AC18、AC21。

### 范围

- 原生首页／识别／社区／消息／我的五Tab，识别含拍草、OCR和语音提问入口；独立后台与用户端分开；只保留人工审核的空入口
- 主题绿#1F7A45，正文优先18px、44px等效触控区，放大字体、颜色加文字、录音与播放按钮分离，风险提示不能写绝对安全
- 定义未登录、空结果、处理中、失败、重试、取消、已删除／失效和明显模拟状态；游客仅首页，真实权限仍由GY-I04服务端负责
- 替身数据仅开发模式明确标注，与真实服务地址和评估数据隔离；基础库／工具编译和界面走查可先完成，后续业务验收按各功能任务完成

### 验收

- [ ] 微信工具可编译并导航五Tab；未登录入口控制、静态地区不假发预警、人审空入口和模拟标记均正确
- [ ] 常见与放大字体走查没有遮挡主要按钮，关键状态可用文字表达；不将可点原型算实时识别／ASR／AI社区完成
- [ ] GY-I13继续完成TTS和播放生命周期，本任务不重复验收语音服务准确率

### 提交证据

- 五Tab路由和状态清单、微信工具编译版本与截图
- 视觉和字体走查、替身开关隔离及接口契约绑定记录

## GY-I27 前置用途授权、外发账本与隐私撤回接口守卫

[#29 前置用途授权、外发账本与隐私撤回接口守卫](https://github.com/Sek1ro-oka/GengYun/issues/29)；开始阶段M1／完成阶段M1；P0；当前待领取。

在真实采集和外发前建立用途许可与任务阻断；GY-I19在模块集成后验收注销删除，不等M3才处理隐私。

前置：[GY-I01](https://github.com/Sek1ro-oka/GengYun/issues/1)、[GY-I02](https://github.com/Sek1ro-oka/GengYun/issues/2)。功能：F01、F13、F12、F15、F16、F20、F08；验收：AC09、AC23、AC28、AC29。

### 范围

- 定义用途、资料类型、接收第三方、授权版本／时间和撤回记录；主动麦克风／定位权限与服务端推理用途授权分开，拒绝允许手选地区／文字替代
- 按已冻结身份上下文实现授权中间件和外发账本；微信身份由GY-I04消费接口接入，单元测试可注入身份上下文，不要求先实现GY-I04形成依赖循环
- 真实图片、录音、转写、会话、任务及外发登记userid／purpose／recipient／source_version，不默认第三方训练；注销或撤回立即禁止新外发并阻断在途结果回写
- 服务端任务执行前和保存前重查授权／账号状态，取消版本不可被回调复活；提供各模块注册删除处理器和第三方删除请求接口，完整7／30日集成由GY-I19完成

### 验收

- [ ] 无授权与错用途不能触发实际外发；撤回／注销与任务竞争、旧结果回写均被守卫阻断，测试身份不进入比赛真实环境
- [ ] 日志不含私有正文、图片、音频、精确坐标或凭据；可追溯第三方删除请求／完成／失败但不将请求当完成
- [ ] 输出前后端一致的授权错误码与交互，以及模块删除注册协议；首版用户训练开关关闭，启用前仍需独立同意与模型谱系验收

### 提交证据

- 用途和外发账本schema、拒绝／撤回接口契约与单元／契约测试
- 在途回调竞态、日志脱敏、模块删除注册及第三方失败证据用例

完整实现且验收通过才Closes，部分提交使用Refs。任务状态以远端PR、main及证据为准，文档条目不是完成记录。
