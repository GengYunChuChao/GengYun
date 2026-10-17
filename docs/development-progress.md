# 当前进度

核对日期：2026-10-14（当时 main `15c3003efc221407734ea26366a7538ae23ddcbb`）；该时点读数：现行 main `3000e2e0f42c2d3f4196baad5269ebcec9264f82`（2026-10-16，[#204](https://github.com/GengYunChuChao/GengYun/pull/204)）领先71个提交（基数＝核对基线 `15c3003efc221407734ea26366a7538ae23ddcbb` 不含自身，`git rev-list --count 15c3003efc221407734ea26366a7538ae23ddcbb..3000e2e0f42c2d3f4196baad5269ebcec9264f82`=71）；同日另测：`cc07de8fd2fabfcd51b11c37962994631ecfbed5`（[#215](https://github.com/GengYunChuChao/GengYun/pull/215)）领先82个提交（基数＝`15c3003efc221407734ea26366a7538ae23ddcbb^` 含核对基线自身，`git rev-list --count 15c3003efc221407734ea26366a7538ae23ddcbb^..cc07de8fd2fabfcd51b11c37962994631ecfbed5`=82；同一提交按不含自身的 `git rev-list --count 15c3003efc221407734ea26366a7538ae23ddcbb..cc07de8fd2fabfcd51b11c37962994631ecfbed5` 计为81，两个基数不可混算）；**现测**（2026-10-16 18:54 +08:00，`git fetch upstream --prune` 后）：`bdd12bd2d1578bcfcf285f1234725c800b339c61`（[#220](https://github.com/GengYunChuChao/GengYun/pull/220)）领先86个提交（基数＝核对基线 `15c3003efc221407734ea26366a7538ae23ddcbb` 不含自身，`git rev-list --count 15c3003efc221407734ea26366a7538ae23ddcbb..bdd12bd2d1578bcfcf285f1234725c800b339c61`=86；同一基线按 `git rev-list --count 3000e2e0f42c2d3f4196baad5269ebcec9264f82..bdd12bd2d1578bcfcf285f1234725c800b339c61` 计为15；两条命令的对象均为当时实际读取的固定 SHA，读数不随远端分支移动而变）。当前口径现测（2026-10-16 23:01 +08:00，对象＝固定 SHA `06d63453c7890f96aa6fb4dc3ca3cd03c5cf70a3`（[#226](https://github.com/GengYunChuChao/GengYun/pull/226)））：领先94个提交（基数＝核对基线 `15c3003efc221407734ea26366a7538ae23ddcbb` 不含自身，`git rev-list --count 15c3003efc221407734ea26366a7538ae23ddcbb..06d63453c7890f96aa6fb4dc3ca3cd03c5cf70a3`=94；同一基线按 `git rev-list --count 3000e2e0f42c2d3f4196baad5269ebcec9264f82..06d63453c7890f96aa6fb4dc3ca3cd03c5cf70a3` 计为23）。实时状态以 [GitHub](https://github.com/GengYunChuChao/GengYun/issues) 和固定 SHA 批复为准；下方10月11日原文保留为历史快照。

## 已合组件与剩余验收

本轮实时核对原27项初版 issue，仍全部 OPEN；整项完成数0／27。组件、资料准备、真实能力、集成与部署分别记录，不按PR数或端点数换算完成率。Android为当前真机适配范围；iOS暂缓，不计通过。

| 模块 | main 已有组件 | 尚未完整验收 |
| --- | --- | --- |
| 工程／契约 | 原生小程序、独立后台、Node API、112操作对照及装配校验 | 冻结与一致性收口；不以所有业务接口实现作为纯契约关闭条件 |
| 资料／数据库 | 科普受限PG查询、来源生命周期、暂存导入、本地启动；浙江首批资料清单与适配验证（#131）；标签原文资格守卫 | 完整核准标签／条件／原文用量、正式用户链和云库／全库恢复；资料清单不等于可用DoseCard |
| 身份／档案／隐私 | 两端鉴权、手选档案、授权签名列表、科普／目录固定15分钟分页；后台及档案／授权新回执24h；外发账本／在途守卫／删除注册协议（#128） | 正式微信身份／Android、定位成功、真实政策／接收方、撤回消费者及注销全链；#133用途消费者接线未合，不计本基线 |
| 媒体／评估 | 7个私有媒体HTTP操作及归属／EXIF组件（#129）；真实杂草样本登记／答案键／冻结清单与离线评估接入（#130） | 存储网关、持久化及跨模块消费者；样本登记不等于独立评估达标或真实识别能力通过 |
| 识别／OCR／语音 | 领域HTTP、状态／版本／幂等／阶段超时；共享Job识别与转写读取、识别取消；OCR 取消已接线（`services/api/src/ocr/service.ts:687`、`services/api/src/jobs/sources.ts:169-186`） | 真实媒体／供应商接线及独立评估；转写／合成／问答／审核公共作业源取消仍 503，持久租约与恢复未接线 |
| 问答／社区／消息／后台 | 独立领域服务；34个后台HTTP操作与fail-closed端口（#121）；社区16条业务契约（帖子9／评论5／举报2）与消息3端点（列表／未读数／读标记）路由已装配（判据见 `docs/architecture/contract-implementation-status.md:19`）；文字问答HTTP已交付（GY-I12／[#12](https://github.com/GengYunChuChao/GengYun/issues/12)，[#214](https://github.com/GengYunChuChao/GengYun/pull/214) 并入 main，合并提交 `cf2f5ed`）：契约内7条会话／轮次操作已有HTTP面（`services/api/src/routes/conversations.ts:75`）、PG持久化（`services/api/src/conversations/store-pg.ts:210`、`services/api/src/app.ts:1101`）与库级级联（`services/api/db/migrations/0013_conversations.sql:64`）、answer作业源已接跨kind读面（`services/api/src/conversations/job.ts:64`、`services/api/src/app.ts:1259`）、回答经输出守卫（`services/api/src/conversations/guard.ts:250`） | 安全来源消费、收藏历史；问答未接真实模型——每个 Answer 的 `model_version`／`prompt_version`／`rule_version` 一律带 `unimplemented:no-real-` 前缀、正文是确定性检索条目摘录而非模型结果（判据 `services/api/src/conversations/types.ts:52`、`services/api/src/conversations/service.ts:75-84`），用量卡在本基线恒不可产出（真实检索资料为浙江首批159条 review_status=unverified）；问答取消未接、如实 503 `PROVIDER_UNAVAILABLE`（与转写／合成 取消同一口径），轮次级联端口默认未接线（`services/api/src/app.ts:1132`），持久租约（15秒／5秒心跳）与重启恢复、真实外发与 external_inference 同意闸、原生 PG17 迁移执行与120题评估仍待后续片；社区real模式整域503 `PROVIDER_UNAVAILABLE`、**真实持久存储未交付**；消息只服务进程内存储、real持久存储未接线；后台真实端口／存储与UI联调 |
| 部署／演示 | 容器、VPC和CVM PostgreSQL安装／角色／备份恢复准备物；独立界面Demo可编辑源（#132） | 云上实际部署／迁移／恢复及联网验收；界面Demo不等于原生微信业务验收 |
| 情景视频 | 已确认模板合成方案 | 接口、素材、时长／保存期限与播放器链待交付；演示不代表真实长期药效 |

## 本轮合并与返修状态

| PR | 已确认合并提交 | 当前含义 |
| --- | --- | --- |
| [#116](https://github.com/GengYunChuChao/GengYun/pull/116) | `78a4486` | 后台普通回执24h、到期清理和锁内时钟已合 |
| [#119](https://github.com/GengYunChuChao/GengYun/pull/119) | `c550770` | 目录游标绑定主体版本及固定首个15分钟期限 |
| [#120](https://github.com/GengYunChuChao/GengYun/pull/120) | `5c66f43` | 档案／授权授予／撤回新PG回执24h；旧五分钟回执不追溯延长 |
| [#125](https://github.com/GengYunChuChao/GengYun/pull/125) | `cb30974` | 作业共享面事实和失败投影跟进；不冒称所有kind可用 |
| [#121](https://github.com/GengYunChuChao/GengYun/pull/121)／[#128](https://github.com/GengYunChuChao/GengYun/pull/128)／[#129](https://github.com/GengYunChuChao/GengYun/pull/129) | `8f19eac`／`1fc0308`／`44e5564` | 后台、隐私协议及媒体组件已合，真实链路剩余按上表保留 |
| [#130](https://github.com/GengYunChuChao/GengYun/pull/130)／[#131](https://github.com/GengYunChuChao/GengYun/pull/131) | `de1004c`／`a15a7f1` | 样本与资料准备已合，不计模型指标或标签用量最终验收 |
| [#117](https://github.com/GengYunChuChao/GengYun/pull/117) | 未合 | 两份状态文档冲突已在候选协调，待新SHA复查；历史CI付款拒绝不改记成功 |

当前112条业务契约中106条已装配、6条未装配（按 `docs/architecture/contract-status.json` 及 `node tools/verify-contract-status.mjs` 现行输出；读数 2026-10-16，main `bdd12bd2d1578bcfcf285f1234725c800b339c61`，该命令原样输出「已装配 106 条；implemented 13 / partial 93 / planned 6」）。候选对照保留主线新增的34个后台与7个媒体操作；知识列表因既有排序偏差仍partial，分布13 implemented／93 partial／6 planned，横切维度8条中2 implemented／6 partial。6条未装配均为planned且当前HTTP路径返回NOT_FOUND：`listSpecies`、`getPrivacyPolicy`、`listExports`、`requestAccountDeletion`、`getDeletionReceipt`、`verifyRegistration`（本读数不含在途 #217 账户注销HTTP与 #193 媒体运行期闸门）。注册数量只说明路由装配，不代表真实能力与整项验收。

复用各已合组件的绑定SHA证据；本轮只做文档事实、机器／中文同步及无凭据stub装配核对，不冒称重跑业务、PG、微信／Android或供应商。本机 `D:\challenge_cup` main已快进到上述基线。没有部署或切换共享认证。历史证据与本轮返修见[记录](verification/gy-i01-status-sync-20261013.md)。

---

## 2026-10-11 跟进快照

新增合入：[PR #79](https://github.com/GengYunChuChao/GengYun/pull/79) 科普 PG 限权查询、[PR #80](https://github.com/GengYunChuChao/GengYun/pull/80) 原生知识消费者、[PR #81](https://github.com/GengYunChuChao/GengYun/pull/81) 官方资料证据增补。
知识查询已从静态入口扩展为冻结 HTTP 契约消费者；本地合成身份／资料的组件证据不等于正式微信、Android 或核准药剂验收。资料研究仍未补齐完整现行标签，DoseCard 保持 0。

本机监工在上述 main 的独立 checkout 实际执行知识 API／客户端／布局专项：50 通过、0 失败、1 原生独立连接专项跳过；该跳过不计通过。
API 专项包含 PGlite 限权与实际本机回环 HTTP，身份／资料为合成数据；没有本轮原生 PostgreSQL、微信 GUI、Android 或真实供应商实测。
原生工程 JSON／路由／JS 静态检查及 27 项文档／依赖／链接检查通过。未复跑、未重计历史全量测试。

本机用户目录 `D:\challenge_cup` 当前 main 与本次远端 SHA 一致；保留 7 张原有未提交截图，未提交个人原始媒体。

本次开始核查时分页覆盖全部 11 个开放 PR；其中 7 个有新提交或新组件，当前 SHA 的工作流均为 `action_required`，尚无成功检查，不能写作 CI 通过。整理期间另有新 PR #88 提交，已读取其范围与 HEAD，尚未独立验证；本报告的治理 PR 单独计数。

| PR／固定 HEAD | 本次状态 | 合并前仍需处理 |
| --- | --- | --- |
| [#67](https://github.com/GengYunChuChao/GengYun/pull/67) `ceab47ecbb5e` | 证据索引追加了修订 | 新 SHA 文档审查与适用 CI；旧批复不自动变为通过 |
| [#82](https://github.com/GengYunChuChao/GengYun/pull/82) `5c0f728bb3e2` | 当前 SHA 已被要求修改 | 条件缺失／不符仍放行、用量卡片资格漏验及跨端成分含量不同判；本轮复核原批复，未新增药剂实测 |
| [#83](https://github.com/GengYunChuChao/GengYun/pull/83) `4d214f306109` | 本地知识权限接线与启动／重启组件待审 | 独立权限／恢复检查及适用 CI |
| [#84](https://github.com/GengYunChuChao/GengYun/pull/84) `018db5874ece` | 私有媒体字节契约与本地文件适配器待审 | 契约及消费者一致性、文件／隐私检查和适用 CI；本 PR 明确未实现 HTTP 传输 |
| [#85](https://github.com/GengYunChuChao/GengYun/pull/85) `d307eb843fa7` | 契约实现状态对照待审 | 与真实路由一致性、校验脚本及适用 CI；对照表不是新接口交付 |
| [#86](https://github.com/GengYunChuChao/GengYun/pull/86) `09ca9a6d1e43` | 档案快照／越权及定位失败回退组件待审 | 独立客户端／权限检查及适用 CI；定位成功与 Android 仍未验 |
| [#87](https://github.com/GengYunChuChao/GengYun/pull/87) `73935ecef1b8` | 识别任务与七类状态组件待审 | 接口／权限／取消回调检查及适用 CI；作者说明仍为内存存储，真实供应商／质量／真机未验 |
| [#88](https://github.com/GengYunChuChao/GengYun/pull/88) `0e06ee8be397` | 新提交的文本确定性审核规则组件待审 | 独立安全／版本／失败隔离与适用 CI；作者明确未接 HTTP、模型、图片或发布消费者，不计 AI 审核完成 |

另外 #39／#49／#50／#65 为未变化的旧 PR，当前均有冲突；既有阻塞与已合接续组件分别保留，不重复合并或关闭。
本机 GitHub 账号上游实际权限为 READ，不能批准 Fork 工作流或合并；个人 Fork 的提交能力不改变上游权限。没有改权限、派发、部署或真实付费调用。

后续仍按既有依赖收口首段用户链路，再接安全资料／媒体和真实能力；本快照不重新分配任务，也不把组件状态转成整项完成率。

## 更新规则

只记录代码合入、实际验证、剩余验收与阻塞；组件、整项及部署状态分别统计。
本次精简与视频需求确认不增加软件完成数，不关闭或重派 issue。

[开发顺序](development-order.md) · [数据库组件交接](verification/database-run-handoff.md) · [旧进度存档](archive/development-2026-10-10/docs/development-progress.md)。

2026-10-10 历史核查见[固定提交报告](verification/supervisor-audit-20261010.md)：报告中的 `c0069bb` 测试与旧 PR 阻塞只适用于当时 SHA。随后 #68／#69／#75 已修订合入，登录生命周期、界面接线和 Windows 换行误报已在 2026-10-11 前轮限定复验中解除，不能继续把历史阻塞写成当前主线状态。原报告保留追溯；任何一轮组件回归都不增加整项完成数。
