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
| 问答／社区／消息／后台 | 独立领域服务；34个后台HTTP操作与fail-closed端口（#121）；社区16条业务契约（帖子9／评论5／举报2）与消息3端点（列表／未读数／读标记）路由已装配（判据见 `docs/architecture/contract-implementation-status.md:19`）；文字问答HTTP已交付（GY-I12／[#12](https://github.com/GengYunChuChao/GengYun/issues/12)，[#214](https://github.com/GengYunChuChao/GengYun/pull/214) 并入 main，合并提交 `cf2f5ed`）：契约内7条会话／轮次操作已有HTTP面（`services/api/src/routes/conversations.ts:75`）、PG持久化（`services/api/src/conversations/store-pg.ts:210`、`services/api/src/app.ts` 的 `conversationStore` 装配（`createPostgresConversationStore`／`createMemoryConversationStore` 三元；测量基线 `6c22000` 实测 `:1264-1268`））与库级级联（`services/api/db/migrations/0013_conversations.sql:64`）、answer作业源已接跨kind读面（`services/api/src/conversations/job.ts:64`、`services/api/src/app.ts` 的 `createAnswerJobSource({` 注册（基线 `6c22000` 实测 `:1435`））、回答经输出守卫（`services/api/src/conversations/guard.ts:250`） | 安全来源消费、收藏历史；问答未接真实模型——每个 Answer 的 `model_version`／`prompt_version`／`rule_version` 一律带 `unimplemented:no-real-` 前缀、正文是确定性检索条目摘录而非模型结果（判据 `services/api/src/conversations/types.ts:52`、`services/api/src/conversations/service.ts` 的 `ANSWER_MODEL_VERSION`／`ANSWER_PROMPT_VERSION`／`answerRuleVersion`，基线 `6c22000` 实测 `:79-89`），用量卡在本基线恒不可产出（真实检索资料为浙江首批159条 review_status=unverified）；问答取消未接、如实 503 `PROVIDER_UNAVAILABLE`（与转写／合成 取消同一口径），轮次级联端口默认未接线（`services/api/src/app.ts` 的 `conversationCascade` 回退到 `createUnwiredTurnCascadePort()`，基线 `6c22000` 实测 `:1301`），持久租约（15秒／5秒心跳）与重启恢复、真实外发与 external_inference 同意闸、原生 PG17 迁移执行与120题评估仍待后续片；社区real模式整域503 `PROVIDER_UNAVAILABLE`、**真实持久存储未交付**；消息只服务进程内存储、real持久存储未接线；后台真实端口／存储与UI联调 |
| 部署／演示 | 容器、VPC和CVM PostgreSQL安装／角色／备份恢复准备物；独立界面Demo可编辑源（#132） | 云上实际部署／迁移／恢复及联网验收；界面Demo不等于原生微信业务验收 |
| 情景视频 | 已确认模板合成方案 | 接口、素材、时长／保存期限与播放器链待交付；演示不代表真实长期药效 |

## 2026-10-18 快照

核对日期 2026-10-18（UTC+8）。基线 `main` = `8205cfc`（`8205cfc8b8f32b8a7f44a28e53b1234bac5cc6c9`）：本节先从 `53922eb` rebase 到该提交，其后 #256、#272、#288、#289、#290 五个 PR 已并入 main，故计数与在飞清单按 rebase 后重测。本节只写本机实测读数与仓内可指位置；它取代下文「本轮合并与返修状态」里 2026-10-16 `bdd12bd` 那段契约读数，旧段按要求原样保留以便追溯。文首「核对日期 2026-10-14」那段与 `## 2026-10-11 跟进快照` 同属各自日期读数，一并保留，不再作为当前读数引用。

### 计数（`gh` 实测，命令均带 `-R GengYunChuChao/GengYun`）

| 口径 | 读数 | 命令 |
| --- | --- | --- |
| 开放 issue | 25 | `gh issue list --state open --limit 200 --json number` |
| 已关闭 issue | 2（#1、#2） | `gh issue list --state closed --limit 200 --json number,title` |
| 累计合入 PR | 202 | `gh pr list --state merged --limit 2000 --json number` |
| 在飞 PR | 5（均非草稿；#248、#282 可合并性为冲突） | `gh pr list --state open --limit 200 --json number,title,isDraft,mergeable` |

Windows PowerShell 5.1 下 `ConvertFrom-Json` 的数组要写成 `@($x).Count`；把整条管道塞进 `@()` 只会得到 1。

### 契约门禁（本机重跑 `node tools/verify-contract-status.mjs`，退出码 0）

原样输出：

- 「PASS: 覆盖 112 条契约操作；已装配 108 条；implemented 13 / partial 95 / planned 4；横切维度 8 条；形状错误 0 项；语义错误 0 项」
- 「PASS: 语义可核 59 条区间 + 0 条片段；不可核 134 条区间 + 131 条片段（不可核不计入通过）」
- 「PASS: 中文表格一致」
- 「PASS: 状态为人工判定；脚本不证明语义正确、真实能力或整项验收。」

与旧读数的差异：旧段记的「已装配 106 条；implemented 13 / partial 93 / planned 6」是 `bdd12bd` 时读数。本轮 planned 只剩 4 条：`listSpecies`、`getPrivacyPolicy`、`listExports`、`verifyRegistration`；旧段列的 `requestAccountDeletion`／`getDeletionReceipt` 现为已装配的 partial（条目行 `docs/architecture/contract-status.json:385`、`:422`，其阻塞说明在同文件 `:419`、`:464`）。`listKnowledge` 仍 partial，条目行 `docs/architecture/contract-status.json:642`，阻塞原因逐字见同文件 `:668`（排序仍不同于冻结的 `created_at DESC`，实际表／投影无该列，排序与历史数据方案未完成）。装配数只说明路由是否挂上，不代表真实能力或整项验收。

### 在飞 PR（5 条）

| PR | 内容 | 迁移 | 可合并性 |
| --- | --- | --- | --- |
| #278 | GY-I17 消息域 PG 持久化 | `0019_messages_persistence.sql` | MERGEABLE |
| #282 | GY-I18 feature_flags 落库 | `0020_feature_flags.sql` | CONFLICTING |
| #279 | GY-I18 后台账号读面接真实 users 投影（Refs #18、#22） | `0021_admin_accounts_read.sql` | MERGEABLE |
| #248 | GY-I11 语音转写可编辑、确认后发送（客户端切片） | 无 | CONFLICTING |
| #284 | GY-I02 开放 issue 关闭材料索引（文档；HEAD 未更新，不作为关闭依据） | 无 | MERGEABLE |

本轮已合入、不在上表：#256（#22 `retryable` 口径收口）、#272（#16 收藏与历史 PG 存储，迁移 `0018_favorites_history.sql`）、#288／#289／#290（#24 备份恢复演练脚本、索引派生计数、覆盖判定收紧）。

`main` 现有 18 个迁移、最大号 `0018_favorites_history.sql`，因此带迁移的三个在飞 PR 须按 `#278 → #282 → #279` 合入，避免迁移号冲突。**`#282` 单解冲突不足以合入**：它另有一处已登记、仍未修的阻塞——`#282` 分支内 `services/api/src/admin/ops/flags-pg.ts:303-312` 把启动探测异常折叠为 `false`，`services/api/src/admin/ops/flag-gate.ts:433-445` 据此置 `probed=true`／`armed=false`，`:462-465` 返回 `open`，于是一次瞬时探测异常就让数据库里真实关闭的全局开关永久 fail-open 直到重启；须先修该 fail-open，且各 PR 适用 CI 转绿，未取得的新成功证据不得记通过。未合入 PR 的结论不当作既成事实。

### 逐 issue 判定（两层口径，与 README「当前进度（2026-10-18）」表一致）

- **按 AC 逐条判定**（关闭材料索引 [PR #284](https://github.com/GengYunChuChao/GengYun/pull/284) 分支内 `docs/verification/gy-issue-closure-index-20261018.md`，索引生成于基线 `5250520`；本快照基线为 `8205cfc`；**#284 HEAD 未更新，其旧结论不作为关闭依据**，只作条款级线索）：可关 **0** 项；待前置／待证据 **7** 项（#4、#7、#8、#16、#17、#22、#27）；待裁定 **1** 项（#3）；不可关 **5** 项（#19、#20、#21、#23、#24）；其余 12 项未纳入该索引（#5、#6、#9、#10、#11、#12、#13、#14、#15、#18、#28、#29），本轮没有 AC 级判定。**口径差异需明说**：索引原文的分布是「2 可关／4 待前置／2 待裁」，其中 **#22 在索引里记为待裁**（`| #22 | 3 | 2 | 1 | 0 | 0 | 待裁 |`）；本快照把 #22 改记待前置，依据是仓外严重性裁定（见下一条）。索引另把 **#7、#8 记为可关**，那只是验收条款层的判真：**#7 的验收前置 #3／#4 仍 OPEN**、真实来源与实际消费者证据未取得；**#8 的前置 #7 仍 OPEN**、登记标签原文剂量未取得。故两项整项状态一并改记「待前置／待证据」，条款级证据（AC 判真、100 组场景用例）原样保留。以上均为对索引口径的覆写，不是索引也这么记。关闭权仍只在监工与用户。
- **#3 的待裁项**是「20 条 `review_status: unverified`／`achieved: 20` 是否算关闭」：指挥已给出建议「可关，附披露：条目 20／来源 validity=valid 20／逐字段复核 0／licensed=false」，最终由监工／用户裁定，本轮不写「已核实／已达标」。
- **#22 的两项发现**经裁定不属「严重安全／权限缺陷」：§5.1 后台账号能力脱钩方向更保守（真实账号无法被该接口停用），§5.2 `retryable` 语义不一致不违约且已随 #256 合入收口；故其 AC 判定由待裁转为待前置，读面真实读数仍待 #279 合并后复测（`docs/verification/gy-i22-closure-gap-20261018.md:59-80`、`:92`、`:112`、`:128`）。
- **关闭动作仍待监工／用户点头**，本轮不关闭任何 issue，整项完成数仍为 0。监工关联核对：#2 已 completed 关闭，本 PR 纯进度文档返修不重开 #2；#7／#8 保持 OPEN；#22 全链验收未完成。
- **工程侧（与 AC 判定两层，不互替）**：交付中 4 项（#11、#17、#18、#22，各有在飞 PR 未合入）；卡在仓内要补的实现 10 项（#6、#7、#9、#10、#12、#13、#14、#15、#19、#29：真实对象存储适配器、知识列表排序方案、real 提供者接线、真实模型、社区持久化、备份副本清除、第三方删除登记面等）；卡在外部前提 11 项（#3、#4、#5、#8、#16、#20、#21、#23、#24、#27、#28：真机、正式凭据与合法域名、外部资料与独立签核）。同一项可同时出现在 AC 判定与工程侧，例如 #7 的验收条款已可判真而整项仍记待前置／待证据、契约面按 partial 保留；#16 的 PG 存储已随 #272 合入、真机页面证据仍未取得。

### 仍未取得的主干（不分整项口径）

- 真机：#23 的双平台真机与时延容量、#4 的真机微信身份、#5 的授权弹窗与坐标→地区转换、#16 的真机页面证据、#28 的开发者工具／真机渲染与截图（`docs/verification/platform-checklist.md:40`、`:48-49`、`docs/verification/gy-i05-region-profile-20261014.md:23-25`、`docs/verification/gy-i28-demo-parity-20261018.md:177-179`）。
- 真实 AI 调用：#9／#10／#12／#13／#14 的服务侧 real 提供者仍未接线（`docs/architecture/contract-status.json:777`、`:861`、`:1061`、`:1041`，问答判据 `services/api/src/conversations/types.ts:52`）。
- 样本签核：#20 的独立复核与许可（`packages/evaluation/samples/gy-i20-weeds-labels.json:18` 的 `reviewedBy` 为 `null`）、#21 的真实能力评估（`docs/evaluation/README.md:20-21`：`isRealEvaluation=false`、门禁 `not_evaluated`、无任何模型成绩）。
- 部署：#24 的实际部署与 CVM 侧恢复演练（`docs/verification/gy-i24-release-materials-index-20261017.md:13` 只做离线核验且不关闭整项；`docs/verification/gy-i24-restore-drill-local-20261018.md:6` 逐字「这是本机演练，不是 CVM 验收」）、#27 的合法域名与生产环境变量（`docs/verification/platform-checklist.md:24`、`docs/verification/gy-i27-live-ai-20261018.md:110`）。

### 本节边界

本节不含任何真机、真实供应商、渲染或部署实测，只复用仓内文档与代码行号并重跑了一条门禁命令；未重跑业务测试、PG 集成与微信工具。数值按 2026-10-18 当日读数（基线 `8205cfc`，rebase 后重测），后续合入会变，更新时另起快照、不改本节。

## 2026-10-20 快照

核对日期 2026-10-20（UTC+8）。基线 `main` = `4122976`（`412297636141562653ecbaa6b3fbbfecb05ecdd4`，提交时间 2026-10-20 12:11:28 +0000，即 #327 的 squash 提交）：自 `8205cfc` 起共 42 个提交（`git rev-list --count 8205cfc..4122976`=42）。本节取代「2026-10-18 快照」里按 `8205cfc` 计数的读数；10-18 节原文（含其计数表、在飞 PR 表与逐 issue 判定）按要求原样保留以便追溯，文首「核对日期 2026-10-14」段与 `## 2026-10-11 跟进快照` 同属各自日期读数，一并保留，不再作为当前读数引用。

### 计数（`gh` 实测，命令均带 `-R GengYunChuChao/GengYun`）

| 口径 | 读数 | 命令 |
| --- | --- | --- |
| 开放 issue | 24 | `gh issue list --state open --limit 200 --json number` |
| 已关闭 issue | 3（#1、#2、#3） | `gh issue list --state closed --limit 200 --json number,title` |
| 累计合入 PR | 242 | `gh api "search/issues?q=repo:GengYunChuChao/GengYun+type:pr+is:merged" --jq .total_count` |
| 在飞 PR | 2（#324 草稿、#328 非草稿，`mergeable` 均为 `MERGEABLE`；2026-10-20T12:14Z 实测） | `gh pr list --state open --limit 200 --json number,title,isDraft,mergeable` |

#3 于 2026-10-19 以 `COMPLETED` 关闭（`gh issue view 3 --json closedAt,stateReason` 读数 `2026-10-19T02:42:16Z`／`COMPLETED`），即指挥建议的「可关，附披露」口径落地；#1、#2 更早关闭。整项完成数 3／27，其余 24 项 OPEN。#323／#325／#326 的合入未改变整项完成数：OCR 仍缺 real 提供者与真实标签评估（#10），#325 是文档订正、#326 是测试判据、#327 只改 CI 接线与测试、#328 是台账订正（未合入），均不构成整项 AC 达成；不为让数字好看改判。

### 契约门禁（本机重跑 `node tools/verify-contract-status.mjs`，退出码 0）

原样输出：

- 「PASS: 覆盖 112 条契约操作；已装配 108 条；implemented 13 / partial 95 / planned 4；横切维度 8 条；形状错误 0 项；语义错误 0 项」
- 「PASS: 语义可核 59 条区间 + 0 条片段；不可核 134 条区间 + 131 条片段（不可核不计入通过）」
- 「PASS: 中文表格一致」
- 「PASS: 状态为人工判定；脚本不证明语义正确、真实能力或整项验收。」

与 10-18 节读数（112／108／implemented 13／partial 95／planned 4）逐项相同：本区间合入的 #295～#296、#320～#322、#323 提供的是 PG 持久化与取消能力，未把任何条目从 partial 升级为 implemented；#325 只订正文案、#326 只改测试。另按 JSON 原文统计复核：`node -e "…JSON.parse(contract-status.json)…"` 得 `operations 112 {"partial":95,"implemented":13,"planned":4}`，与门禁读数一致。装配数与状态只说明路由是否挂上、人工判定为何，不代表真实能力或整项验收。

### 台账滞后（已知滞后）：#325 订正 16 处，其余未随 main 更新

`#325` 于 2026-10-20T12:03:58Z 合入（`f18763e`），已订正取消覆盖面与消息持久化，`git show f18763e --unified=0 -- docs/architecture/contract-status.json` 实测 **16 个 hunk**：`:614`／`:639`（取消按 kind 分派、转写与合成已接 cancel）、`:871`／`:891`／`:911`／`:931`／`:951`（OCR 五端点，取消证据行号 `services/api/src/jobs/sources.ts:169-186` → `:208`）、`:971`／`:991`／`:1011`／`:1031`（转写四端点）、`:1051`（`createSynthesis` 取消已接线）、`:1771`／`:1792`／`:1813`（`listMessages`／`getUnreadCount`／`markMessageRead` 改为「real + 池 ⇒ 迁移 0019 与 `messages/store-pg.ts`，real 无池才 503」）、`:3086`（共享作业面 blocker 的取消覆盖面：由「识别与 OCR 两域」改为「识别、转写、合成与 OCR 四域」并列 `sources.ts:65`／`:107`／`:153`／`:208`），状态全部仍 partial、零升级（共 16 处；同一提交对 `docs/architecture/contract-implementation-status.md` 的改动为 `git show --numstat` 的 18/18，落 6 个 hunk：`:17`／`:19`／`:40`／`:70`／`:80`／`:118`）。以下记录仅作追溯；仍存滞后的 4 条逐行列出，本快照不采用其结论，也不在本次改台账。

- 【仍滞后】`:419`（`requestAccountDeletion`）只写「本片只交付受理 HTTP 面」与「真实删除执行仍在进程内注册表」，未列 `0023_user_backup_copies.sql` 与 `services/api/src/privacy/backup-copies-pg.ts`（随 #295 合入）的备份副本域与 30 天清除链 ⇒ 台账未反映该域；仍缺 7／30 日到期的真实执行与第三方删除证据。
- 【已订正】`:971`（`createTranscription`）「取消未接线」已由 #325 订正（转写取消随 #321 接线，`services/api/src/jobs/sources.ts:107`）；`:1051`（`createSynthesis`）同理（随 #322，`services/api/src/jobs/sources.ts:153`）。
- 【仍滞后】`:1261`（`listPosts`／`createPost`）仍称「真实持久存储未交付」——社区已接 PG（迁移 `0022_community_persistence.sql` 随 #296 合入，`services/api/src/community/store-pg.ts:346`，装配 `services/api/src/app.ts:780`）；#325 未覆盖社区，此行仍滞后。
- 【已订正】`:1771`（`listMessages`）「real 未接持久存储」已由 #325 订正为「real + 池 ⇒ 迁移 0019 与 `messages/store-pg.ts`，real 无池才整域 503」；本节保留该更正记录。
- 【仍滞后】`:1842`（`listAdminSources`）与 `listAdminUsers`（`:2578-2604`）仍写「真实存储……待完成」——后台路由确已装配（`services/api/src/routes/admin.ts:172-174`）；`#282`（0020 feature_flags）与 `#279`（0021 后台账号读面接真实 `users` 投影）已合入，真实读数仍未复测，故本条只记滞后、不改判。
- 【仍滞后】`:861`（`createOCR`）仍只写「真实标签评估与持久/删除链待验收」——`#323` 已把 OCR 任务与记录接入 PG（迁移 `0024_ocr_persistence.sql`、`services/api/src/ocr/store-pg.ts:359`、装配 `services/api/src/routes/ocr.ts:196`），台账未反映该持久化；`tests/integration/ocr-jobs-pg.mjs` 已在主干但仍无 workflow 运行（`git grep -n ocr-jobs-pg -- .github/workflows` 零命中；#327 只接入了 account-deletion／admin-accounts-read／admin-flags 三条，`real-pg-integration.yml` 现有 7 条真库脚本、`MANAGED_SCRIPTS` 7 条）。

### 在飞 PR（2 条）

本轮核对期间在飞数先由 4 增至 5（#327 于 2026-10-20T11:59:43Z 新建、#324 转草稿），再因 #323／#325／#326 合入降到 2 条；随后 #327 于 12:11:28Z 合入、#328 于 12:13:20Z 新建（仍 2 条）；下表以 2026-10-20T12:14Z 的最后一次实测为准。

| PR | 内容 | 迁移 | 可合并性 |
| --- | --- | --- | --- |
| #324 | 原生文字提问页与识别入口（#12／#28 页面，仍为草稿，未合入） | 无 | MERGEABLE（草稿） |
| #328 | 台账跟随订正：#325 遗留的 13 处过期行号与「未接作业源」失实表述（只动台账，未合入前不记作事实） | 无 | MERGEABLE |

本轮已合入、不在上表：#278（0019 消息 PG）、#282（0020 feature_flags）、#279（0021 后台账号读面）、#296（0022 社区 PG）、#295（0023 备份副本域）、#320（#6 S3 兼容适配器真实代码路径测试）、#321～#322（转写／合成取消接线）、#323（0024 OCR 持久化，2026-10-20T12:05:48Z）、#325（台账订正，12:03:58Z）、#326（手机号判据，12:05:32Z）、#327（真库门禁第三批，12:11:28Z；`real-pg-integration.yml` 扩到 7 条真库脚本、`MANAGED_SCRIPTS` 7 条）。#248（#11 客户端切片）已于 2026-10-19 关闭、**未合入**，其内容不进 main。`main` 现有 24 个迁移、最大号 `0024_ocr_persistence.sql`。

仍未接 CI 的 `-pg` 脚本（`git grep -n <name> -- .github/workflows` 均零命中）：`account-suspend-pg.mjs`（脚本自身缺陷，SCRAM 口令 28P01／角色已存在 42710，待 s16 修）、`backup-purge-pg.mjs`（需服务端 `initdb` 自起第二集群，CI 的 runner 与容器不共享该二进制）、`ocr-jobs-pg.mjs`（#323 新增，尚未接线）。

旧段登记的 `#282` 启动探测 fail-open 已随其合并修掉：现行装配走三态探测 `probeFeatureFlagsTable`（`services/api/src/admin/ops/flags-pg.ts:299-303`），`services/api/src/admin/ops/flag-gate.ts:425-430` 与 `:464-466` 只在 `missing`（确认未安装）时降级未武装，`unknown`（探测异常）保持武装并在下次判前重探；据此不再把该缺陷列为在飞阻塞。未合入 PR 的结论仍不当作既成事实。

### 逐 issue 判定（两层口径，与 README「当前进度（2026-10-20）」表一致）

- **AC 判定层面**：`docs/verification/gy-issue-closure-index-20261018.md` 已随 [PR #284](https://github.com/GengYunChuChao/GengYun/pull/284) 于 2026-10-19 合入 main（索引生成于基线 `5250520`，本快照基线 `4122976`；合并版已按 r2 更正作废 #7／#8 的旧「可关」）。合并版分布：可关 **0**、待前置 **7**（#4、#7、#8、#16、#17、#22、#27）、待裁 **1**（#3，附指挥裁定建议「可关」）、不可关 **5**（#19、#20、#21、#23、#24）；其余 12 项（#5、#6、#9、#10、#11、#12、#13、#14、#15、#18、#28、#29）未纳入索引。索引条目不随 main 前进自动更新，只作条款级线索。
- **#3 已关闭**：2026-10-19 按「可关，附披露」以 `COMPLETED` 关闭；关闭的是资料清单与适配层可交付，不等于 20 条资料逐字段复核（0 份）、许可（全 `false`）或云库／受控 HTTPS／正式 real／双手机真机已取得，工程缺口如实保留。
- **#22** 的两个已登记发现经裁定不属「严重安全／权限缺陷」；读面已随 #279 接真实 `users` 投影，真实读数仍未复测（本机无库），故 AC 判定仍记待前置。
- **关闭动作**：本轮只做文档同步，不关闭任何 issue；工程侧缺口（#6 真实对象存储适配器、#9／#12／#13／#14 服务侧 real 提供者）仍按 partial 保留；#10 的 PG 持久化已随 #323 合入，但真实提供者与真实标签评估仍缺，故 #10 仍 partial。

### 仍未取得的主干（不分整项口径）

- 真机：#23 的双平台真机与时延容量、#4 的真机微信身份、#5 的授权弹窗与坐标→地区转换、#16 的真机页面证据、#28 的开发者工具／真机渲染与截图（`docs/verification/platform-checklist.md:40`、`:48-49`；`docs/verification/gy-i05-region-profile-20261014.md:23-25`；`docs/verification/gy-i28-demo-parity-20261018.md:177-179`）。
- 真实 AI 调用：#9／#10／#12／#13／#14 的服务侧 real 提供者仍未接线（`services/api/src/app.ts:968` 注释「应用装配路径永不注入真实适配器端口」；台账 `docs/architecture/contract-status.json:777`、`:861`、`:1041`、`:1061`）。#10 的 PG 持久化已随 #323 合入，但不改变本类缺口的性质。
- 样本签核：#20 的独立复核与许可（`packages/evaluation/samples/gy-i20-weeds-labels.json:18` 的 `reviewedBy` 为 `null`）、#21 的真实能力评估（`docs/evaluation/README.md:20-21`）。
- 部署：#24 的实际部署与 CVM 侧恢复演练、#27 的合法域名与生产环境变量（`docs/verification/platform-checklist.md:24`；`docs/verification/gy-i27-live-ai-20261018.md:110` 记 `verify-env.mjs` 两项 FAIL：生产 API HTTPS URL、数据库连接变量）。

### 本节边界

本节只重跑了 `node tools/verify-contract-status.mjs` 一条门禁并核对了仓内文件与行号，未重跑业务测试、PG 集成、微信工具或真实供应商调用；`gh` 计数为 2026-10-20T12:14Z 读数（当日在飞数 4→5→2→2：新增 #327／#328，合入 #323／#325／#326／#327），后续合入会变，更新时另起快照、不改本节。

> **后续订正指引（2026-10-21 加，仅指路，不改本节读数）**：本节第 114 行（`:861` 只写「持久/删除链待验收」）、
> 第 125 行（`main` 现有 24 个迁移、最大号 `0024`）、第 127 行（`ocr-jobs-pg.mjs`／`account-suspend-pg.mjs`／`backup-purge-pg.mjs` 三句「未接 CI」）
> 均已被后续合入推翻，现行读数见下节「2026-10-21 快照」。

## 2026-10-21 快照

核对日期 2026-10-21（UTC+8）。基线 `main` = `ee46eb1`（`ee46eb1dc2b8a5a57acd9b8905b72863d45cfa4e`，即 #398 的 squash 提交）：自 `4122976` 起共 70 个提交（`git rev-list --count 4122976..HEAD`=70）。本节取代「2026-10-20 快照」里按 `4122976` 计数的读数；10-20、10-18 两节原文（含计数表、在飞 PR 表与逐 issue 判定）按要求原样保留以便追溯。

### 计数（`gh`／`git` 实测，同一次运行于 2026-10-21T14:56:42Z）

| 口径 | 读数 | 命令 |
| --- | --- | --- |
| 开放 issue | 24 | `gh issue list --state open --limit 300 --json number` |
| 已关闭 issue | 3（#1、#2、#3） | `gh issue list --state closed --limit 300 --json number` |
| 累计合入 PR | 312 | `gh api 'search/issues?q=repo:GengYunChuChao/GengYun+type:pr+is:merged' --jq .total_count` |
| 在飞 PR | 3（#400、#399 非草稿，#324 草稿；`mergeable` 均 `MERGEABLE`） | `gh pr list --state open --limit 300 --json number,isDraft,mergeable` |
| 提交总数／自 10-20 基线新增 | 366／70 | `git rev-list --count HEAD`；`git rev-list --count 4122976..HEAD` |
| 迁移文件数／最大号 | 26／`0026_speech_persistence.sql`（含 `0025_recognitions_persistence.sql`） | `(Get-ChildItem services/api/db/migrations/*.sql).Count` |

整项完成数仍 3／27（#1、#2、#3），其余 24 项 OPEN。10-20 之后合入的 #389～#399 未改变任何整项 AC：`#391`／`#392`／`#393`／`#394`／`#395`／`#396`／`#397`／`#398` 都是局部实现或证据页，`#399` 尚未合入。

### 契约门禁（本机重跑 `node tools/verify-contract-status.mjs`，退出码 0）

原样输出：

- 「PASS: 覆盖 112 条契约操作；已装配 108 条；implemented 13 / partial 95 / planned 4；横切维度 8 条；形状错误 0 项；语义错误 0 项」
- 「PASS: 语义可核 104 条区间 + 0 条片段；不可核 98 条区间 + 157 条片段（不可核不计入通过）」
- 「PASS: 证据锚点 409 条引用自带锚点（区间内 238 条 + 仅整文件 171 条）；无锚点不可核 0 条（纯行号 0 + 无行号源文件 0 + 无用例名 0），只计数不判红」
- 「PASS: 纯行号区间 238 条（有实质内容 238 条；整段仅空白/收尾行 0 条、区间首行为空行 2 条，只计可疑不判红）」
- 「PASS: 中文表格一致」
- 「PASS: 状态为人工判定；脚本不证明语义正确、真实能力或整项验收。」

与 10-20 节读数相比：`112／108／implemented 13／partial 95／planned 4` 逐项相同，**状态零升级**；差异只在证据锚点面——`#362`／`#369`／`#344`／`#356`／`#371` 等把纯行号证据补成符号锚点，故「语义可核」由 59 条区间升到 104 条区间；「证据锚点」这一行 10-20 节的输出里**还没有**（脚本后来才加三档校核），今日读出 409 条。那是台账可核性，不是能力升级。

### 本节订正的三类过期表述（只订正事实，不动验收结论）

1. **真库 CI 接线（10-20 节第 127 行那句已过期）**：`real-pg-integration.yml` 现有 **13 条受管脚本**（12 条 `-pg` ＋ `recognition-chain-e2e.mjs`；`git grep -c 'node tests/integration/' -- .github/workflows/real-pg-integration.yml`=13）。逐条来源：`ocr-jobs-pg.mjs` ← #331（第 8 条）、`recognitions-pg.mjs` ← #349、`account-suspend-pg.mjs` ← #353（脚本自身的 SCRAM 28P01／42710 缺陷已修）、`speech-pg.mjs` ← #354、`backup-purge-pg.mjs` ← #360（用 PGDG apt 装 PG 17 服务端二进制取 `initdb`/`pg_ctl`，故「runner 与容器不共享该二进制 ⇒ 不可接」的判断已过期）、`recognition-chain-e2e.mjs` ← #375（第 13 条）。另有在飞 PR（分支 `test/gy-r28-e5-backup-driver-ci`，PR #400）把 `backup-copies-purge-pg.mjs` 接进去（将成第 14 条，**未合入前不记作事实**）。仍未接的脚本见本节末。
2. **注销清理链（10-20 节第 109 行「仍缺 7／30 日到期的真实执行」）**：备份 30 日的**执行者已补**——#398 新增运维命令 `tools/purge-expired-backup-copies.mjs` ＋ 驱动 `services/api/src/privacy/backup-purge-driver.ts`（绕过受理函数、只读写 `user_backup_copies`，真库 14 臂 ALL PASS）；#397 把注销清理闭集扩到**四域**（favorites／history／messages／conversations，`services/api/src/privacy/user-data-deletion.ts:93-98`）并给会话域补 `snapshotOwner`，真库臂判「四域清单行齐 ⇒ 整体 `completed`」。**仍未取得**：真实 cron／CVM 调度读数（刻意不做常驻定时器）、7 日在线的真实时钟执行、第三方删除证据、恢复清单重放。
3. **「受理同一事务撤会话」不再算缺口**：`services/api/db/migrations/0016_account_deletion_persistence.sql:132-134` 本就在同一事务内撤销该用户全部活跃会话；10-20 节若沿用旧口径，以本行为准。

### 台账滞后（截至本节时点仍存在，生成区不改）

- 【仍滞后】`docs/architecture/contract-status.json` 的 `requestAccountDeletion`（`:410`，blocker `:447`）：仍写「到期清除的唯一触发者是『请求重放』，无到期枚举器、无维护端点」——已被 #397／#398 在代码层推翻；也仍未列备份副本域四域清单。
- 【仍滞后】同文件 `listMessages`（`:1915`）／`getUnreadCount`／`markMessageRead`：仍写「PG/注销及页面/Android仍待验收」，其中「注销」一截已被 #397 补上（真 PG17 行数读数仍缺）。
- 【仍滞后】同文件 `createOCR`（`:913`）仍只写「真实标签评估与持久/删除链待验收」，未反映 `0024` 的 PG 持久化与 #331 的 CI 接线。
- 【仍滞后】同文件 `listPosts`（`:1344`）仍称「真实持久存储未交付」（社区已接 PG）；`listAdminUsers`（`:2795`）仍写「真实存储……待完成」。
- 【已订正】`createTranscription`／`createSynthesis` 的取消接线表述随 #325 订正；`listMessages` 的「real 无池才 503」口径随 #325 订正（内容正确，行号已漂移）。
- 这些行号按本节时点实测（`grep -n '"id": "<operationId>"' docs/architecture/contract-status.json`）；README 表内其余旧锚点同样漂移，见 `docs/verification/gy-r28-e4-stale-claims-20261021.md` §2 R5。

### 仍未接 CI 的 `-pg` 脚本

截至本节时点：`tests/integration/backup-copies-purge-pg.mjs`（#398 新增，接线由在飞 PR #400 承担，未合入）。其余 `-pg` 脚本都已在 `real-pg-integration.yml` 里。

### 仍未取得的主干（不分整项口径）

- 真机：#23 的双平台真机与时延容量、#4 的真机微信身份、#5 的授权弹窗与坐标→地区转换、#16 的真机页面证据、#28 的开发者工具／真机渲染与截图（`docs/verification/platform-checklist.md:40`、`:48-49`；`docs/verification/gy-i05-region-profile-20261014.md:23-25`；`docs/verification/gy-i28-demo-parity-20261018.md:177-179`）。
- 真实 AI 调用：#9／#10／#12／#13／#14 的服务侧 real 提供者仍未接线（`services/api/src/app.ts:968` 注释「应用装配路径永不注入真实适配器端口」；台账 `createRecognition` / `createOCR` / `createSynthesis` / `createConversation` 条目）。#10 的 PG 持久化与 CI 接线已具备，但不改变本条缺口的性质。
- 样本签核：#20 的独立复核与许可（`packages/evaluation/samples/gy-i20-weeds-labels.json:18` 的 `reviewedBy` 为 `null`）、#21 的真实能力评估（`docs/evaluation/README.md:20-21`）。
- 部署：#24 的实际部署与 CVM 侧恢复演练、#27 的合法域名与生产环境变量（`docs/verification/platform-checklist.md:24`；`docs/verification/gy-i27-live-ai-20261018.md:110` 记 `verify-env.mjs` 两项 FAIL：生产 API HTTPS URL、数据库连接变量）。

### 逐 issue 判定（两层口径，与 README「当前进度（2026-10-21）」表一致）

- **AC 判定层面**：合并版索引（`docs/verification/gy-issue-closure-index-20261018.md`，生成于基线 `5250520`）的分布不变——可关 **0**、待前置 **7**（#4、#7、#8、#16、#17、#22、#27）、待裁 **1**（#3，已按「可关，附披露」关闭）、不可关 **5**（#19、#20、#21、#23、#24）；其余 12 项未纳入索引。本轮**未改任何 AC 判定**，也**不关闭**任何 issue。
- **工程侧**：`#16`／`#17` 的注销清理缺口已被 #390／#397 推进（`#16` 的「真删」与四域闭集、`#17` 的消息域原语与闭集），`#19` 的 30 日执行者已被 #398 补上；但三者的整项结论不变——真机证据、真实时钟执行、真实调度读数与第三方删除证据都还没有。

### 本节边界

本节只重跑了 `node tools/verify-contract-status.mjs` 一条门禁并核对了仓内文件与行号，未重跑业务测试、PG 集成、微信工具或真实供应商调用；`gh`／`git` 计数与在飞清单为 2026-10-21T14:47:52Z 同一次读数，后续合入会变，更新时另起快照、不改本节。


## 2026-10-22 迁移读数订正（局部快照）

核对日期 2026-10-22（UTC+8）。基线 `origin/main` = `d4d48088532377adb54c278b24ba90be42cb5aaf`（`#404` 的 squash 提交）。本节只订正**迁移读数**一项，未重跑 `gh` 计数、业务测试、PG 集成或真实供应商调用，故不是完整快照，也不改任何整项 AC 判定。

| 口径 | 读数 | 命令 |
| --- | --- | --- |
| 迁移文件数／最大号 | **27**／`0027_admin_audit_observability.sql`（含 `0026_speech_persistence.sql`、`0025_recognitions_persistence.sql`） | `git ls-tree -r --name-only origin/main -- services/api/db/migrations`：顶层 `0001..0027` 共 27 个、最大号 `0027`；`rollback/` 下 `0002..0027` 共 26 个 down |

**订正对象与「不改 10-21 那行」的理由**：上面「2026-10-21 快照」第 166 行记的 **26**／`0026_speech_persistence.sql` 是 `2026-10-21T14:56:42Z` 的实测，当时 `0027` 尚未合入；`0027_admin_audit_observability.sql` 随 `#428`（`fab7a617`，提交时间 2026-10-22 10:20:58 +08:00）才进 `main`，晚于该快照。按该节边界「更新时另起快照、不改本节」，该行**原样保留**（改它等于伪造一次没发生的测量），现行读数以本节为准。

`0027` 之后 `main` 未再出新号，最大号仍是 `0027`；未合入 PR 的迁移号一律不记作既成事实。down 脚本目录是 `services/api/db/migrations/rollback`（`services/api/db/rollback` 不存在，实测 0 个文件），「down 数 = 迁移数 − 1、且无 `0001`」这条不变量在 27／26 下仍成立（`0001` 的永久豁免登记见 `tests/unit/migrations-rollback-pairing.test.mjs` 的 `EXEMPT`）。

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
