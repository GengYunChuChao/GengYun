# R34 关单材料台账（24 张开放 issue 自评）

- 采样时间：2026-10-24（HKT，UTC+8）
- 工作树：`E:\GengYunCommander\wt-r34-closure-matrix`｜分支：`feat/gy-r34-closure-matrix`
- 基线：`upstream/main = 4b87e1d9`（`Reviewed PR #525`，2026-10-24 00:54:49 +0800）。开工三读数：`git rev-parse HEAD` 与 `git rev-parse upstream/main` 同为 `4b87e1d98f405b55c9fda46ac772f4ffcbc13a5e`，`git status --porcelain -uall` 为 0 行。
- issue 标题来源：`gh issue list --state open --json number,title` 实取 24 张，逐字抄录（未凭记忆、未改写）。
- 线索来源（只读、非事实）：`E:\GengYunCommander\.pg17\recon-issue-closure-20261024.md`（基线 `123ee4bd`，24 张全记「部分交付」）。本页对其中每一条都回仓重核，复核口径见 §1；与审计不一致之处以本页的仓内读数为准。
- **口径声明：本页是自评，不代替监工验收。** 判定只说明「main 上的关单材料齐到什么程度」，不是关单依据；任何「可关」字样都不构成本页的结论。
- **本页替代 `gy-r31-closure-matrix-20261022.md` 的读数，旧页保留为历史快照。** 旧页与本页冲突处以本页为准；逐条差异、现状锚点与依据 commit 记在 `gy-r34-ledger-corrections-20261024.md`。
- 判定分布：**已交付 0 张 / 部分交付 24 张 / 未见交付 0 张**。
- 卡点分布：真机 5 张、真实供应商 7 张、真实样本 3 张、用户裁定 5 张、部署环境 1 张、在飞 PR 1 张、纯代码 2 张（合计 24）。

## 0 结论速览

| 项 | 值 |
| --- | --- |
| 开放 issue | **24 张**（`gh issue list --state open`，与审计同口径） |
| 判「已交付」 | **0 张** —— 没有一张的验收判据能在仓库内全部复核 |
| 判「部分交付」 | **24 张** —— 每张都有可复核的 main 侧交付物，也每张都缺仓库外材料 |
| 判「未见交付」 | **0 张** —— 没有出现「整项零实现」的 issue（个别子项零实现，见逐条小节） |
| 卡点＝真机 | #4、#5、#6、#16、#23 |
| 卡点＝真实供应商 | #9、#10、#12、#13、#14、#15、#21 |
| 卡点＝真实样本 | #8、#11、#20 |
| 卡点＝用户裁定 | #7、#17、#22、#27、#28 |
| 卡点＝部署环境 | #24 |
| 卡点＝在飞 PR | #19（#528） |
| 卡点＝纯代码 | #18（资料域 PG 落点）、#29（前端授权界面） |

**一句话盘面**：与旧页相比，main 侧材料明显变厚 —— 媒体 PG store、OCR 媒体注入口、审核台账 `0028`、作业台页面、`GET /me/exports`、230 条失败矩阵与 `Retry-After`、撤回依赖臂、real 终态历史端口与 `deleteHistory` 级联腿都已在 main 落地（逐条见订正页）。但**没有一张因此变成「已交付」**：24 张的剩余缺口全部落在真机读数、真实供应商调用、真实样本、用户裁定、部署授权这五类仓库外条件上，其中 #18 与 #29 还各留一条纯代码缺口。

## 1 读表方法

**①三档判定（本页自定义，写在这里便于复核）**

- **已交付**：issue 验收节的全部判据都能在 main 上用「源码符号 或 测试可定位片段」复核，且不依赖真机、真实供应商、真实样本、真实时间流逝或第三方确认。
- **部分交付**：main 上存在可复核的交付物，但至少一条验收判据必须靠仓库外材料才能复核，或者仍有一条明确的代码缺口。
- **未见交付**：main 上找不到该 issue 主体功能的实现落点。

**②卡点七类**：`真机`（Android/iOS 量化读数、时延容量）、`真实供应商`（腾讯云 tms/ims/ASR/TTS/OCR、DeepSeek 的产品级调用与预算）、`真实样本`（真实图片/标签/普通话音频/评估集）、`用户裁定`（口径、范围、排序、定级）、`部署环境`（生产/比赛环境、备份介质、部署授权）、`在飞 PR`（判据依赖一张未合入的 PR）、`纯代码`（只差本仓可自行完成的实现）。

**③复核口径（三条硬约束）**

- 判「某改动是否已在 main」**一律不用** `git merge-base --is-ancestor`（本仓走上游 squash，原提交永远不是祖先）。做法是 `git log upstream/main --grep=<标题片段>` 定位提交，再 `git show upstream/main:<path>` 读内容核对语义。
- 每条「已有交付物」都过 `git cat-file -e upstream/main:<path>`；文件不存在就写「未核实」，不推断成已交付。
- 全页**不写行号**：引用一律 `文件路径:符号名`。行号会随代码移动而漂移，本仓的文档锚点闸门也是按这条纪律立的。

**④「未取得」与「未核实」分两栏**：#4 小节里的「未取得」是**审计与本页都承认拿不到**的仓库外材料；「未核实」是本轮**没有复核完**的条目，集中列在 §4，不当成已交付，也不当成缺口已关闭。

## 2 总表（24 张）

| issue | 标题（`gh issue view` 实取） | 判定 | 已有交付物（路径:符号，不写行号） | 剩余缺口（一句话） | 卡点类型 |
| --- | --- | --- | --- | --- | --- |
| #4 | [初版 GY-I04] 实现微信登录、游客限制与服务端归属权限 | 部分交付 | `services/api/src/auth/wechat.ts:computeSubjectLookup`；`services/api/src/auth/service.ts:issuedSessionToSession`；`services/api/db/migrations/0016_account_deletion_persistence.sql` | 缺 Android/iOS 真机登录链路量化读数与正式 AppID 归属 | 真机 |
| #5 | [初版 GY-I05] 实现单作物地区档案及授权定位／手动选择 | 部分交付 | `services/api/src/profile/service.ts:createProfileService`；`services/api/src/profile/service.ts:cropItems`；`docs/verification/gy-i05-locate-timeout-20261021.md` | 缺真机三态定位取证（授权/拒绝/超时回退）与地区目录真实数据源版本 | 真机 |
| #6 | [初版 GY-I06] 实现私有媒体上传、访问权限及EXIF清除 | 部分交付 | `services/api/src/media/store-pg.ts:createPostgresMediaStore`；`services/api/src/media/service.ts:stripImageMetadata`；`services/api/db/migrations/0029_media_object_cleanup.sql` | 缺真机大图/视频性能集；真实对象存储要 `services/api/src/media/real-ports.ts:approveRealMediaWiring` 批准，未取得 | 真机 |
| #7 | [初版 GY-I07] 实现科普／除草剂查询、详情与来源版本展示 | 部分交付 | `packages/reference/query.mjs:evaluateEligibility`；`packages/reference/query.mjs:isSimulatedSource`；`packages/reference/service.mjs:traceable_authority` | 排序口径（登记号升序 vs 名称）待用户裁定；真 PG 读面读数未取得 | 用户裁定 |
| #8 | [初版 GY-I08] 实现药剂适用过滤与标签原文用量安全边界 | 部分交付 | `tests/reference/_i08-scenarios.mjs`（159 个唯一场景 id，`LIM-001`→`MRG-040`）；`packages/reference/deterministic.mjs:executable_enabled` | 场景全跑在替身目录上，真实标签样本与真实制剂登记核对未取得 | 真实样本 |
| #9 | [初版 GY-I09] 实现实时拍草识别、Top3核对及不确定处理 | 部分交付 | `services/api/src/recognitions/store-pg.ts:createPostgresRecognitionStore`；`services/api/db/migrations/0025_recognitions_persistence.sql` | 真实识别供应商凭证/预算与真实草样本未取得；real 媒体端口仍是 fail-closed | 真实供应商 |
| #10 | [初版 GY-I10] 实现实时标签OCR、用户校正及登记精确核对 | 部分交付 | `services/api/src/app.ts:ocrMedia`（注入口）；`services/api/src/ocr/store-pg.ts:createPostgresOcrStore`；`services/api/db/migrations/0024_ocr_persistence.sql` | 注入口有了但默认 real 仍 unwired（无对象存储批准）；真实标签样本未取得 | 真实供应商 |
| #11 | [初版 GY-I11] 实现普通话录音、实时ASR转写和发送核对 | 部分交付 | `services/api/src/routes/speech.ts:createPostgresSpeechStore`；`services/api/db/migrations/0026_speech_persistence.sql`；`tests/unit/i11-audio-mp3-wav-guard.test.mjs` | 50 段真实普通话样本未取得；MP3→WAV 仍无解码器（现有的是拒绝路径守卫） | 真实样本 |
| #12 | [初版 GY-I12] 实现有来源的语音／文字大模型问答与回答安全检查 | 部分交付 | `services/api/src/ai/chat-live-adapter.ts:bodyViolationsOf`；`services/api/src/conversations/store-pg.ts`；`services/api/db/migrations/0013_conversations.sql` | 真实模型调用读数与固定 120 题评估未取得（需预算授权） | 真实供应商 |
| #13 | [初版 GY-I13] 实现普通话TTS、播放球及安全文本自动播报 | 部分交付 | `services/api/src/tts/media.ts:createSynthesisMediaPort`；`services/api/src/tts/media.ts:REAL_SYNTHESIS_MEDIA_APPROVAL_REQUIRED_REASON` | 30 段真实文本 TTS 与真机播放球未取得；real 合成产物存储要批准能力，未取得 | 真实供应商 |
| #14 | [初版 GY-I14] 实现文字／图片AI筛查、版本重审和失败隔离 | 部分交付 | `services/api/src/moderation/ledger-pg.ts:createPostgresModerationLedger`；`services/api/db/migrations/0028_moderation_persistence.sql` | 200 条文字 + 200 张图片真实样本未取得；人审队列 `services/api/src/admin/human-review.ts` 仍 `wired: false` | 真实供应商 |
| #15 | [初版 GY-I15] 实现真实社区发帖、评论、点赞、筛选与举报 | 部分交付 | `services/api/src/community/store-pg.ts:createPostgresCommunityStore`；`services/api/db/migrations/0022_community_persistence.sql`；`services/api/db/migrations/0032_community_report_reporter_ref.sql` | 真实审核供应商未接；点赞计数无读面（服务层 `countLikes` 有、契约无端点）；`linked_knowledge_ref` 仍 409 | 真实供应商 |
| #16 | [初版 GY-I16] 实现收藏与可浏览的识别历史 | 部分交付 | `services/api/src/app.ts:historyDomainEnabled`；`services/api/src/history/cascade-wiring.ts:createHistoryCascadePort`；`services/api/src/favorites/store-pg.ts:createPostgresFavoritesStore` | 真机三页走查未做；级联只接识别/OCR 两腿，媒体与外发腿未接（成功只到 `partial`） | 真机 |
| #17 | [初版 GY-I17] 实现首版应用内消息、未读状态与权限跳转 | 部分交付 | `services/api/src/messages/store-pg.ts:createPostgresMessagesStore`；`miniprogram/pages/messages/messages.wxml:onRetryUnread`；`docs/verification/gy-r31-i17-g2-ruling-20261022.md` | 跳转范围（现仅 post/comment，其余 14 型降级）需用户裁定；真机走查未做 | 用户裁定 |
| #18 | [初版 GY-I18] 实现独立后台资料、账号、AI任务及功能开关 | 部分交付 | `apps/admin/src/views/JobsView.vue`；`services/api/src/admin/ops/flags-pg.ts`；`services/api/db/migrations/0033_admin_audit_log_read.sql` | 资料域 27 条路由仍走 `services/api/src/admin/store.ts` 的内存 store（`persistent: false`）⇒ real 全 503；缺内容域 PG 落点 | 纯代码 |
| #19 | [初版 GY-I19] 贯通注销去身份、在线7日备份30日删除与恢复验收 | 部分交付 | `services/api/src/routes/exports.ts:registerExportRoutes`；`services/api/src/privacy/user-data-deletion.ts:USER_DATA_DELETION_MODULES`；`services/api/db/migrations/0031_online_purge_evidence.sql` | #528 未合入（缺 `0034` 与识别/语音两条删除模块）；真实备份介质与第三方回执未取得 | 在飞 PR |
| #20 | [初版 GY-I20] 冻结独立评估样本、标准答案及评估程序 | 部分交付 | `packages/evaluation/samples/gy-i20-weeds-real-index.json`（172 条 `test` 分割）；`docs/evaluation/sample-gap-register.md` | 真实杂草图片采集/版权与标准答案评审未取得 | 真实样本 |
| #21 | [初版 GY-I21] 持续评估各项真实AI能力并汇总首版验收门槛 | 部分交付 | `packages/evaluation/src/targets.mjs:METRIC_GATES`；`docs/evaluation/acceptance-thresholds-summary.md` | 18 条门槛的 basis 全是 provisional，真实供应商持续读数未取得 | 真实供应商 |
| #22 | [初版 GY-I22] 完成权限、安全规则及首版端到端失败回归 | 部分交付 | `tests/unit/gy-i22-failmatrix.test.mjs:MIN_CASES`（230）；`tests/failmatrix/mutations.mjs`（23 条负控制）；`services/api/src/errors.ts:retryAfterSecondsFor` | stdout 私密前缀定级与四个域纳入矩阵的范围需用户裁定；真机回归未跑 | 用户裁定 |
| #23 | [初版 GY-I23] 执行Android／iOS真机、时延容量及完整演示验收 | 部分交付 | `docs/verification/gy-i23-latency-capacity-local-20261020.md`；`docs/verification/gy-i23-integration-script-coverage-20261020.md` | Java/Android 与 iOS 真机、时延容量全是本地或脚本读数，真机取证未取得 | 真机 |
| #24 | [初版 GY-I24] 部署联网比赛版、备份恢复并交付完整材料 | 部分交付 | `tools/release-gate.mjs:GATE_IDS`；`tools/verify-release-materials.mjs`；`docs/verification/gy-i24-release-materials-index-20261017.md` | 生产与比赛环境零部署（须单独授权）；`--pg` 全跑读数未取得 | 部署环境 |
| #27 | [初版 GY-I25] 提前验证正式AppID、真机域名及AI和数据库服务接入 | 部分交付 | `docs/verification/gy-i27-live-ai-20261018.md`；`docs/verification/provider-matrix.md`；`docs/verification/gy-r34-private-env-mapping-20261023.md` | 正式 AppID/域名归属、付费额度与真实数据库接入授权未取得 | 用户裁定 |
| #28 | [初版 GY-I26] 提前建立五Tab原生页面骨架、Demo样式及统一失败状态 | 部分交付 | `docs/verification/gy-r31-i26-recon-20261022.md`；`docs/verification/gy-i28-unified-states-20261021.md`；`miniprogram/pages/home/home.wxml` 的 `badge--stub` | 三条存活缺口（含首页仍挂 `badge--stub`）与「骨架是否算验收」的范围待用户裁定 | 用户裁定 |
| #29 | [初版 GY-I27] 前置用途授权、外发账本与隐私撤回接口守卫 | 部分交付 | `services/api/src/privacy/task-egress.ts`；`services/api/src/privacy/grant-pg.ts`；`tests/unit/consent-withdraw-dependency.test.mjs` | 前端授权/撤回界面整条零实现（`miniprogram/pages` 下无 consent/privacy 页）；真实回执未取得 | 纯代码 |

## 3 逐 issue 小节

### #4 · 微信登录、游客限制与服务端归属权限
- 已交付证据：`services/api/src/auth/wechat.ts:computeSubjectLookup`（`openid` 单向派生、不落原值）、同文件的 `errcode 40029/40163 ⇒ 400` 分支、`services/api/src/auth/service.ts:issuedSessionToSession`；迁移 `services/api/db/migrations/0016_account_deletion_persistence.sql`。证据页 `docs/verification/gy-r34-wechat-login-20261023.md`、`docs/verification/gy-i04-login-chain-20261021.md`，均可用 `git show upstream/main:<path>` 复核。
- 缺什么：Android/iOS 真机登录链路的量化读数（现有唯一真机页是 N=1、`http://` 局域网、`urlCheck=false`）；`errcode` 各分支的真机复现；正式 AppID 与主体归属材料。
- 谁能推动：监工安排真机取证；用户/指挥提供正式 AppID 归属。
- 判定：部分交付（卡点＝真机）。

### #5 · 单作物地区档案及授权定位／手动选择
- 已交付证据：`services/api/src/profile/service.ts:createProfileService` 与同文件 `cropItems` 的 `crop_id`/`region_code` 校验；证据页 `docs/verification/gy-i05-region-profile-20261014.md`、`docs/verification/gy-i05-locate-timeout-20261021.md`、`docs/verification/gy-i05-catalog-cursor-20261013.md`。
- 缺什么：真机三态定位取证（授权成功／拒绝／超时后手动回退）；地区目录的真实数据源版本与更新读数。
- 谁能推动：监工安排真机取证；指挥决定地区目录数据源。
- 判定：部分交付（卡点＝真机）。

### #6 · 私有媒体上传、访问权限及 EXIF 清除
- 已交付证据：`services/api/src/media/store-pg.ts:createPostgresMediaStore`（PG 仓储）、`services/api/src/media/service.ts:stripImageMetadata`（结构性段清除）、迁移 `services/api/db/migrations/0029_media_object_cleanup.sql`；装配在 `services/api/src/app.ts` 的 `createPostgresMediaStore` 一处。证据页 `docs/verification/gy-r28-w12-media-persistence-20261022.md`、`docs/verification/gy-i06-private-media-20261014.md`。
- 缺什么：真机大图/视频性能集；真实对象存储要 `services/api/src/media/real-ports.ts:approveRealMediaWiring` 铸造的批准能力，未取得；冲突后新衍生对象的残留回收（`#419` 遗留读数 `pendingObjects=0 / remainingObjects=1`）**未核实**（§4）。
- 谁能推动：监工安排真机与清理器复跑；用户/指挥批对象存储与清理预算。
- 判定：部分交付（卡点＝真机）。

### #7 · 科普／除草剂查询、详情与来源版本展示
- 已交付证据：`packages/reference/query.mjs:normalizeQuery`／`evaluateEligibility`／`isSimulatedSource`、`packages/reference/service.mjs` 的 `traceable_authority=false` 口径；证据页 `docs/verification/gy-r29-i07-closure-20261022.md`、`docs/verification/gy-r31-i07-sort-20261022.md`、`docs/verification/gy-i07-knowledge-query-20261014.md`。
- 缺什么：列表排序口径（登记号升序 vs 名称）需一次用户裁定；详情页真 PG 读面的读数未取得。
- 谁能推动：用户/监工裁定排序口径；指挥补真 PG 读数。
- 判定：部分交付（卡点＝用户裁定）。

### #8 · 药剂适用过滤与标签原文用量安全边界
- 已交付证据：`tests/reference/_i08-scenarios.mjs` 的 159 个唯一场景 id（`LIM-001`→`MRG-040`）、`packages/reference/deterministic.mjs:executable_enabled` 与 `dose_card_enabled` 开关链；证据页 `docs/verification/gy-i08-applicability-rules-20261014.md`、`docs/verification/gy-i08-dose-gap-ledger-20261017.md`、`docs/verification/gy-i08-ace3v-checklist.md`。
- 缺什么：真实标签样本（159 个场景跑在替身目录上）；真实制剂登记与原始用量条件的核对材料。
- 谁能推动：指挥安排真实标签采集；用户确认用量展示边界。
- 判定：部分交付（卡点＝真实样本）。

### #9 · 实时拍草识别、Top3 核对及不确定处理
- 已交付证据：`services/api/src/recognitions/store-pg.ts:createPostgresRecognitionStore`、迁移 `services/api/db/migrations/0025_recognitions_persistence.sql`、`services/api/src/recognitions/media.ts:createRecognitionMediaPort`（real 如实走 `createUnwiredMediaPort`）；证据页 `docs/verification/gy-i09i10-recog-20261019.md`、`docs/verification/gy-i09-identify-candidates-20261014.md`、`docs/verification/gy-r28-recognitions-persist-20261020.md`。
- 缺什么：真实识别供应商的凭证与预算（现为替身派发）；真实草样本与真机拍摄条件。
- 谁能推动：用户授权付费与凭据；指挥组织样本采集。
- 判定：部分交付（卡点＝真实供应商）。

### #10 · 实时标签 OCR、用户校正及登记精确核对
- 已交付证据：`services/api/src/app.ts:ocrMedia`（媒体端口的注入口已存在并透传到 `registerOcrRoutes`）、`services/api/src/ocr/store-pg.ts:createPostgresOcrStore`、迁移 `services/api/db/migrations/0024_ocr_persistence.sql`；证据页 `docs/verification/gy-i10-ocr-http-20261012.md`、`docs/verification/gy-r27-ocr-persist-20261020.md`、`docs/verification/gy-r31-media-port-20261022.md`。
- 缺什么：注入口有、**默认装配仍不注入** ⇒ real 下 OCR 读字节仍是 fail-closed（要对象存储批准）；真实标签样本与登记精确核对的读数未取得。
- 谁能推动：用户/指挥批对象存储；监工安排真实标签样本。
- 判定：部分交付（卡点＝真实供应商）。

### #11 · 普通话录音、实时 ASR 转写和发送核对
- 已交付证据：`services/api/src/routes/speech.ts:createPostgresSpeechStore`（real + 池 ⇒ PG，否则内存）、迁移 `services/api/db/migrations/0026_speech_persistence.sql`；MP3→WAV 的**拒绝路径**由 `tests/unit/i11-audio-mp3-wav-guard.test.mjs` 钉住；证据页 `docs/verification/gy-r31-i11-audio-20261022.md`、`docs/verification/gy-r34-i11-voice-format-20261023.md`、`docs/verification/gy-r34-tts-asr-roundtrip-20261023.md`。
- 缺什么：50 段真实普通话音频样本；MP3→WAV 解码器仍未实现（守卫只保证「拒绝且不假装成功」）。
- 谁能推动：指挥组织录音采集；写手补解码或维持如实拒绝（需监工定取舍）。
- 判定：部分交付（卡点＝真实样本）。

### #12 · 有来源的语音／文字大模型问答与回答安全检查
- 已交付证据：`services/api/src/ai/chat-live-adapter.ts:bodyViolationsOf`（集合外编号/URL 判据）、`services/api/src/conversations/store-pg.ts`、迁移 `services/api/db/migrations/0013_conversations.sql`；`#409` 已把文字问答接真实模型（四与门 + 外发记账）。证据页 `docs/verification/gy-i12-chat-20261019.md`、`docs/verification/gy-i12-conversations-pg-20261020.md`、`docs/verification/gy-r28-w7-qa-live-20261021.md`。
- 缺什么：真实模型调用读数与固定 120 题评估（需预算与凭据授权）；P1「伪引用」在 main 上已有拒收判据（`tests/unit/conversation-answer-guard.test.mjs` 断言 `unattributed_url` 进 `rejected_text`），但**整条链的真调读数未取得**。
- 谁能推动：用户授权付费；监工按验收节复核 120 题口径。
- 判定：部分交付（卡点＝真实供应商）。

### #13 · 普通话 TTS、播放球及安全文本自动播报
- 已交付证据：`services/api/src/tts/media.ts:createSynthesisMediaPort`（real 无批准 ⇒ `createUnwiredMediaPort`，有批准无 objectStore ⇒ 另一种 fail-closed）、同文件 `REAL_SYNTHESIS_MEDIA_APPROVAL_REQUIRED_REASON`；证据页 `docs/verification/gy-i13-tts-http-20261012.md`、`docs/verification/gy-r28-w3-tts-content-20261021.md`、`docs/verification/gy-r34-i13-tts-media-store-20261023.md`。
- 缺什么：30 段真实文本的 TTS 产物与真机播放球读数；real 合成产物存储需要批准能力与对象存储，未取得。
- 谁能推动：用户授权 TTS 付费与对象存储；监工安排真机播放取证。
- 判定：部分交付（卡点＝真实供应商）。

### #14 · 文字／图片 AI 筛查、版本重审和失败隔离
- 已交付证据：`services/api/src/moderation/ledger-pg.ts:createPostgresModerationLedger`、迁移 `services/api/db/migrations/0028_moderation_persistence.sql`、`#475` 的审核端口图片能力位（就绪则私有待审，缺失则 fail-closed 且理由码可区分）；证据页 `docs/verification/gy-i14-publish-gate-20261019.md`、`docs/verification/gy-r31-i14-image-path-20261022.md`、`docs/verification/gy-i14-community-chain-20261021.md`。
- 缺什么：200 条文字 + 200 张图片真实样本；人审队列仍 `wired: false`（`services/api/src/admin/human-review.ts`），人工复核入口没有落地。
- 谁能推动：指挥组织样本；写手补人审入口（需派单）；用户确认审核策略。
- 判定：部分交付（卡点＝真实供应商）。

### #15 · 真实社区发帖、评论、点赞、筛选与举报
- 已交付证据：`services/api/src/community/store-pg.ts:createPostgresCommunityStore`、迁移 `0022`/`0030`/`0032`、`services/api/src/community/service.ts:countLikes`；筛选下推 SQL 与注销清社区行已在 main。证据页 `docs/verification/gy-i15-community-pg-20261018.md`、`docs/verification/gy-r29-i15-community-filter-20261022.md`、`docs/verification/gy-r32-i15-f13-retention-20261022.md`。
- 缺什么：真实审核供应商（现在只有规则/替身路径）；点赞计数无读面（契约只有 `likePosts`/`unlikePosts`/`likeComments`/`unlikeComments`）；`linked_knowledge_ref` 落 `createUnwiredKnowledgeAvailabilityPort()` ⇒ 带知识引用的发帖必 409。
- 谁能推动：用户授权审核供应商；监工裁定「点赞计数是否属首版」。
- 判定：部分交付（卡点＝真实供应商）。

### #16 · 收藏与可浏览的识别历史
- 已交付证据：`services/api/src/app.ts:historyDomainEnabled`（判据＝`executionMode !== 'real' || historyStore.persistent`；real + PG ⇒ wired，real 无落点 ⇒ unwired 且不放宽守卫）、`services/api/src/history/cascade-wiring.ts:createHistoryCascadePort`（识别/OCR 两腿）、`services/api/src/favorites/store-pg.ts:createPostgresFavoritesStore`、`services/api/src/history/store-pg.ts:createPostgresHistoryStore`；迁移 `0018`。证据页 `docs/verification/gy-r29-i16-ledger-closeout.md`、`docs/verification/gy-r31-i16-closeout-20261022.md`、`docs/verification/gy-r31-i16-pg-arm-20261022.md`。
- 缺什么：真机三页（收藏列表/历史列表/详情）走查；级联只接识别与 OCR，媒体对象与外发撤销两腿未接，删除成功只披露 `partial`。
- 谁能推动：监工安排真机走查；写手补媒体/外发腿（需派单）。
- 判定：部分交付（卡点＝真机）。

### #17 · 首版应用内消息、未读状态与权限跳转
- 已交付证据：`services/api/src/messages/store-pg.ts:createPostgresMessagesStore`（标读走 stores 内 CAS）、`miniprogram/pages/messages/messages.wxml:onRetryUnread`（未读失败不再静默清空角标）、`#448` 的跳转入口；证据页 `docs/verification/gy-i17-closeout-20261023.md`、`docs/verification/gy-r31-i17-g2-ruling-20261022.md`、`docs/verification/gy-r34-i17-message-events-pg-20261023.md`。
- 缺什么：跳转范围只有 post/comment，其余 14 型是如实降级 —— 需要一次用户裁定「降级是否可接受」；真机走查未做。
- 谁能推动：用户/监工裁定跳转范围；监工安排真机走查。
- 判定：部分交付（卡点＝用户裁定）。

### #18 · 独立后台资料、账号、AI 任务及功能开关
- 已交付证据：`apps/admin/src/views/JobsView.vue`（经 `apps/admin/src/App.vue` 条件渲染的作业台页面）、`services/api/src/admin/ops/flags-pg.ts`／`accounts-pg.ts`／`jobs-pg.ts`、迁移 `0020`/`0021`/`0027`/`0033`；证据页 `docs/verification/gy-r31-i18-recon-20261022.md`、`docs/verification/gy-r34-i18-admin-community-posts-pg-20261023.md`、`docs/verification/gy-r34-admin-audit-logs-20261023.md`。
- 缺什么：资料域 27 条路由仍走 `services/api/src/admin/store.ts` 的内存 store（`persistent: false`）⇒ real 下全 503；缺内容域 PG 落点与随附迁移（本页不代拟迁移号）。
- 谁能推动：写手补内容域 PG 落点（需派单并预留迁移号）；监工安排后台真机/浏览器走查。
- 判定：部分交付（卡点＝纯代码）。

### #19 · 注销去身份、在线 7 日备份 30 日删除与恢复验收
- 已交付证据：`services/api/src/routes/exports.ts:registerExportRoutes`（`GET /me/exports`，`x-scope: user`，无池即 503 不降级内存）、`services/api/src/privacy/exports-list.ts:createExportsListService`、`services/api/src/privacy/user-data-deletion.ts:USER_DATA_DELETION_MODULES`（收藏/历史/消息/会话四项 + 社区条件项）、迁移 `0031`；证据页 `docs/verification/gy-r34-i19-me-exports-20261023.md`、`docs/verification/gy-r29-i19-closure-20261022.md`、`docs/verification/gy-r34-retention-20261023.md`。
- 缺什么：`#528` 未合入（缺 `0034` 与识别/语音两条删除模块，主线仍只有四面清理）；真实备份介质、第三方完成回执与恢复验收材料未取得。
- 谁能推动：监工推进 `#528`；用户提供备份介质与第三方回执。
- 判定：部分交付（卡点＝在飞 PR）。

### #20 · 独立评估样本、标准答案及评估程序
- 已交付证据：`packages/evaluation/samples/gy-i20-weeds-real-index.json`（172 条 `test` 分割）、`docs/evaluation/sample-gap-register.md`、`packages/evaluation/src/targets.mjs:METRIC_GATES` 的评估框架；证据页 `docs/verification/gy-i20-real-samples-20261014.md`、`docs/verification/gy-i03-i20-materials-gap-ledger-20261015.md`。
- 缺什么：真实杂草图片的采集与版权、标准答案的独立评审记录；172 条只是索引，不是真实图片本体。
- 谁能推动：指挥组织采集与授权；监工安排标准答案评审。
- 判定：部分交付（卡点＝真实样本）。

### #21 · 持续评估真实 AI 能力并汇总首版验收门槛
- 已交付证据：`packages/evaluation/src/targets.mjs:METRIC_GATES`（18 条门槛）、`docs/evaluation/acceptance-thresholds-summary.md` 的汇总口径；证据页 `docs/verification/gy-r34-tencent-ai-samples-20261023.md`、`docs/verification/gy-i27-live-ai-20261018.md`。
- 缺什么：18 条门槛的 basis 全部是 provisional，需真实供应商持续读数才能转正；跨供应商矩阵读数未取得。
- 谁能推动：用户授权持续付费；监工复核门槛转正条件。
- 判定：部分交付（卡点＝真实供应商）。

### #22 · 权限、安全规则及首版端到端失败回归
- 已交付证据：`tests/unit/gy-i22-failmatrix.test.mjs:MIN_CASES`（230 条下限）、`tests/failmatrix/mutations.mjs` 的 23 条负控制、`services/api/src/errors.ts:retryAfterSecondsFor`（`Retry-After` 整数秒唯一口径，429 与 409 `REQUEST_IN_PROGRESS` 必带）；证据页 `docs/verification/gy-i22-failmatrix-20261022.md`、`docs/verification/gy-r31-i22-failure-matrix-20261022.md`、`docs/verification/gy-r31-retry-after-20261022.md`。
- 缺什么：stdout 私密前缀暴露的定级、以及 `me/exports`／`public/home`／`privacy-policy`／`registrations/verify` 四个域是否纳入矩阵，都要一次用户裁定；真机端到端回归未跑。
- 谁能推动：用户/监工裁定；监工安排真机回归。
- 判定：部分交付（卡点＝用户裁定）。

### #23 · Android／iOS 真机、时延容量及完整演示验收
- 已交付证据：`docs/verification/gy-i23-latency-capacity-local-20261020.md`（本地时延容量读数）、`docs/verification/gy-i23-integration-script-coverage-20261020.md`（集成脚本覆盖面）。
- 缺什么：Android 与 iOS 真机读数、真机时延容量、完整演示录像 —— 全仓仍无一张量化真机验收页。
- 谁能推动：监工组织真机取证；用户提供设备与账号。
- 判定：部分交付（卡点＝真机）。

### #24 · 部署联网比赛版、备份恢复并交付完整材料
- 已交付证据：`tools/release-gate.mjs:GATE_IDS`（typecheck/unit/contract/secrets/artifacts/pg）、`tools/verify-release-materials.mjs`、`docs/verification/gy-i24-release-materials-index-20261017.md`、`docs/verification/gy-i24-restore-drill-local-20261018.md`、`docs/verification/gy-r31-i24-release-20261022.md`。
- 缺什么：生产环境与比赛环境零部署（需用户单独授权）、手机体验版零、`release-gate` 的 `pg` 门全跑读数未取得。
- 谁能推动：用户授权部署；指挥执行并留读数。
- 判定：部分交付（卡点＝部署环境）。

### #27 · 正式 AppID、真机域名及 AI 与数据库服务接入的提前验证
- 已交付证据：`docs/verification/gy-i27-live-ai-20261018.md`、`docs/verification/tencent-live-evidence.md`、`docs/verification/llm-live-evidence.md`、`docs/verification/provider-matrix.md`、`docs/verification/gy-r34-private-env-mapping-20261023.md`。
- 缺什么：正式 AppID 与真机域名的归属材料、付费额度授权、真实数据库接入授权 —— 全部未取得。
- 谁能推动：用户（主体归属与预算）；指挥（域名与服务开通）。
- 判定：部分交付（卡点＝用户裁定）。

### #28 · 五 Tab 原生页面骨架、Demo 样式及统一失败状态
- 已交付证据：`docs/verification/gy-r31-i26-recon-20261022.md`（逐 Tab 缺口清单）、`docs/verification/gy-i28-unified-states-20261021.md`、`docs/verification/gy-i28-demo-parity-20261018.md`；`miniprogram/pages/home/home.wxml` 仍挂 `badge--stub`（缺口 H2 存活）。
- 缺什么：三条存活缺口（含首页「演示」角标未撤）；「骨架算不算验收」的范围需用户裁定。
- 谁能推动：用户/监工裁定范围；写手按裁定补页面。
- 判定：部分交付（卡点＝用户裁定）。

### #29 · 前置用途授权、外发账本与隐私撤回接口守卫
- 已交付证据：`services/api/src/privacy/task-egress.ts`（外发记账）、`services/api/src/privacy/grant-pg.ts`、`packages/privacy/egress.mjs:listExportsForUser`、`tests/unit/consent-withdraw-dependency.test.mjs`（依赖不阻断撤回、缺消费者才 409）；证据页 `docs/verification/gy-r31-i29-withdraw-deps-20261014.md`、`docs/verification/gy-i29-closure-20261018.md`、`docs/verification/gy-i27-egress-ledger-pg-20261014.md`。
- 缺什么：前端授权/撤回界面整条零实现（`miniprogram/pages` 下没有 consent/privacy/author 页面）；真实撤回回执未取得。
- 谁能推动：写手补前端授权界面（需派单）；用户提供真实回执。
- 判定：部分交付（卡点＝纯代码）。

## 4 未核实与未取得清单

**未核实（本轮没复核完，既不当已交付，也不当缺口关闭）**

- `#419` 遗留的「冲突后新衍生对象删除未确认时引用只留在丢弃快照」是否已随媒体 PG 落库修掉（合成桶 `pendingObjects=0 / remainingObjects=1`）。本页只确认 `services/api/src/media/store-pg.ts:createPostgresMediaStore` 与迁移 `0029` 已在 main，清理器对该场景的回收**未复核**。
- `#432` 的去向（审计把它列为未取得项）。本页没有找到可复核的落点。
- 9 个 `42501` 对象枚举（权限矩阵的逐对象读数）。
- `#520` 批的逐条 diff。
- `#528`、`#525`、`#527` 的 CI 读数：`#525` 已在 main（本页基线），`#528` 仍在分支上，CI 结论本页未取。
- `docs/architecture/contract-status.json` 的逐条 `blocker` 文案是否还有过期项（本页只在 `node tools/verify-contract-status.mjs` 层面核到 0 形状错误，未逐条读 blocker）。

**未取得（仓库外材料，承认拿不到）**

- Android/iOS 真机证据（全仓无量化真机页）、真机域名与正式 AppID 归属。
- 真实供应商（腾讯云 tms/ims/ASR/TTS/OCR、DeepSeek）的产品级调用读数与付费授权。
- 真实样本：真实杂草图片、真实标签、50 段普通话音频、200+200 审核样本。
- 生产/比赛环境部署与备份恢复演练的真实介质与第三方回执。

## 5 读数

本节读数均为本轮实跑（命令与结论并列，便于监工复跑）。

- `node tools/verify-doc-anchors.mjs --strict`：`SCAN` 文档 274 份，抽出「路径:行号」引用 4870 条（解析成功 4616、同名多文件无法唯一解析 210、同文档重复 22）；`COUNT` BROKEN 33 / OUT_OF_RANGE 6 / SUSPECT 64（合计 103）；`BASELINE` 登记 103 条、本次命中 103 条、**基线外新增 0 条、陈旧 0 条**；`PASS`，**exit 0**。本页与订正页不写行号，因此不向该闸门贡献任何新锚点。
- `node tools/verify-contract-status.mjs`：覆盖 114 条契约操作、已装配 111 条；implemented 17 / partial 93 / planned 4；横切维度 8 条；**形状错误 0 项、语义错误 0 项**；中文表格一致；**exit 0**。
- `npm run test:docs`：`validate_development_docs.py` PASS（27 项初版任务、依赖无环、F/AC/Q 映射完整、Markdown 链接与表格）；`verify-research-records.mjs` PASS（研究记录 5 通过 / 0 失败 / 4 legacy 已钉住）；**exit 0**。
- `git diff --check`：0 行输出（无尾随空白、无 CR 混入），**exit 0**。仓库 `.gitattributes` 对 `*.md` 声明 `text eol=lf`，两页均按 LF 落盘。

## 6 与旧页的关系

- 本页替代 `gy-r31-closure-matrix-20261022.md` 的读数（旧页四档 0 + 3 + 17 + 4、缺代码 15 张 / 代码无缺 9 张的口径不再沿用）。旧页保留为历史快照，不删不改。
- 旧页里「还没做／未接线」但实际已在 main 落地的行，逐条记在 `gy-r34-ledger-corrections-20261024.md`；本页不重复展开。
- 与审计页（`.pg17/recon-issue-closure-20261024.md`）的差异只有一处结构性更新：`#525` 已由「在飞」变为已合入 main（本页基线），审计里以 `#525` 为前提的缺口描述需按此重读。
