# R31 关单就绪度矩阵（全部 24 张开放 issue）

- 采样时间：2026-10-22（UTC+8）
- 分支：`docs/gy-r31-closure-matrix`｜基线：`origin/main = d4d48088`｜**2026-10-22 监工 P2 订正时的复核基线：`origin/main = e3c3af05`**（本页已 `git merge --no-ff` 该提交；#16 行锚点与第 0 节计数按该基线核对）
- 数据来源（全部实读，未凭记忆）：`gh issue list --state open --limit 100`（24 张）、`gh pr list --state all --limit 200`（26 张 OPEN / 174 张已合或已关）、`docs/architecture/contract-status.json`（113 条 operation / 8 条维度）、`packages/contracts/openapi.json`（86 paths / 113 operation）、`docs/verification/**`（212 个文件）、`E:\GengYunCommander\.pg17\STATE-current.md` 的 R31 段、`services/api/src/**` 实读。
- **本页只做侦察，不关单、不改台账、不动 issue 状态**。本页任何「可关」字样都是就绪度判断，不是关闭依据。
- **修订记录（2026-10-22）**：按监工批复 `supervisor-1022-0541-pr458-fbfda76b`（P2）统一档位 —— `#12`、`#18` 从 `差一片能关` 移入 `差外部条件`（逐条缺项见 §3.1），四档与代码缺口计数按逐行表重算（§0、§6.1），并删除旧汇总里「缺代码只有 4 项」的表述。本片未补跑付费/真机，未提任何关单或派单建议。
- **2026-10-22 监工 P2 订正（`supervisor-1022-0932-pr458`）**：#16 行原把「识别/OCR → 历史写入」写成已发生并记「代码无缺」，与装配不符 —— `services/api/src/app.ts` 的 `recognitionTerminalHistory`／`ocrTerminalHistory` 在 `executionMode === 'real'` 取 `createUnwiredRecognitionTerminalHistoryPort`／`createUnwiredOcrTerminalHistoryPort`（端口 `kind:'unwired'`、`recordTerminal()` 空实现），**生产终态不 `appendHistory`**；真库臂直调 `app.historyService.appendHistory` 不覆盖该链路（判据同 #480 关闭材料 §1.2/F10；该 PR 目前仍 **OPEN**、文件不在 main，本页按 `origin/docs/gy-r31-i16-closeout@9e482547` 实读）。⇒ `#16` 由「代码无缺」移入「缺代码」，代码缺口清单 **14/10 → 15/9**，四档 **0 + 3 + 17 + 4 = 24** 不变；同一事实在 §4 组 B 的一处括注里被写成「已被推翻」⇒ 仅把该括注收紧为「非 `real` 分支」并校准该句两个 `app.ts` 锚点。本片未重做 24 项矩阵、未补付费/真机证据、未改其它行。
- **2026-10-25 订正（作业台 UI 已落地，`187aced2`／#439）**：第 2 节 #18 行原记「**作业台页面缺**」，该结论已被证伪 —— `187aced2`（#439）实落 `apps/admin/src/lib/jobs-api.mjs:348`（`listJobs()`）、`apps/admin/src/views/JobsView.vue:67`（`requestPage()` 读 `/admin/jobs`）、同文件 `:155`（`cancelJob()` 带 If-Match）、`apps/admin/src/App.vue:20`（第 6 个 tab「作业台」）＋ `tests/unit/admin-jobs-api.test.mjs`（本片实跑 33 pass / 0 fail），判据 `git merge-base --is-ancestor 187aced2 fd73a632` ⇒ **exit 0**。⇒ #18 行「缺什么」列不再有代码片、合入列由「在飞 #439」改为已合；同一事实在 §4 组 I 的括注里也写作「作业台页面缺」⇒ 只把该括注按当前读数改写。⛔ 本节 §0 的「缺代码 15 张」／「代码无缺 9 张」与「开放 PR 26 张」仍是 2026-10-22 读数，**本片不重算计数**（按本行推导应为 14／10，属计数重算片）。本片未重做 24 项矩阵、未补真 PG／真机／付费读数、未改其它行。

## 0 结论速览

| 项 | 值 |
| --- | --- |
| 开放 issue | **24 张，全部 OPEN**（无一张已关） |
| 现在就够关 | **0 张** |
| 差一片能关 | **3 张**：#7、#22、#29 |
| 差外部条件 | **17 张**：#4、#5、#6、#8、#9、#10、#11、#12、#13、#16、#18、#20、#21、#23、#24、#27、#28 |
| 未就绪 | **4 张**：#14、#15、#17、#19 |
| **四档合计** | **0 + 3 + 17 + 4 = 24**（与第 2 节逐行表的 24 行逐张一致） |
| 缺代码的 issue | **15 张**：#6、#9、#10、#11、#12、#13、#14、#15、#16、#17、#18、#19、#22、#28、#29（含「一片在飞 PR 的代码」；其中 #16 为 2026-10-22 监工 P2 订正后移入，缺项＝real 模式识别/OCR 终态历史端口接线） |
| 代码无缺的 issue | **9 张**：#4、#5、#7、#8、#20、#21、#23、#24、#27（15 + 9 = 24） |
| 过期台账文案 | **33 条已实证过期**（分 8 组 A–H，16+5+4+4+1+1+1+1）＋ **34 条 GY-I18 模板待逐条复核** |
| 台账读数 | 113 条：implemented 13 / partial 96 / planned 4；已装配 109；形状错误 0；语义错误 0（`node tools/verify-contract-status.mjs` exit 0） |
| 开放 PR | 26 张（`#324 #407 #409 #419 #434(draft) #435–#448 #449–#455`）；其中 6 张是 r31 recon 页、7 张是 i22 retryable/parity 系列 |

**一句话盘面**：24 张卡没有一张是「文档没写」或「证据没留」；卡住它们的只有三类东西 —— ①真机/微信端读数（全仓无一张 Android/iOS 真机证据页）；②真实供应商（腾讯云 tms/ims/ASR/TTS/OCR 与 DeepSeek 的产品级接线，只有一次 ¥0.7146 的最小真调样例）；③用户/监工的一次裁定或预算/凭据。**代码缺口不是只有 4 张**：按逐行表实算，缺代码的有 15 张、代码无缺的 9 张（见上表两行）；而且**代码齐了也不等于能关单** —— #12 的「实时模型调用有证据」「固定 120 题按需求验收」、#18 的「全局开关真实生效」都要仓库外读数，所以这两张即使 #409／#439 合入也仍在 `差外部条件`。

## 1 读表方法

**①可关性四档的判据**（本页自定义，写在这里便于复核；2026-10-22 按监工批复 `supervisor-1022-0541-pr458-fbfda76b` 的 P2 收紧为「按 `issue` 验收节明文判据分档」）

- **现在就够关**：issue 验收节的全部 `- [ ]` 判据，都能在 main 上用「源码路径+行 或 测试文件+可定位片段」复核，且不依赖真机、真实供应商、真实时间流逝或第三方确认。
- **差一片能关**：只剩**一片已定位的工程动作**（一个在飞 PR、一次监工裁定、或一条明确的小代码/台账订正），**且该 issue 的「验收」节里没有任何一条判据要求仓库外证据**；做完即可关。
- **差外部条件**：「验收」节**至少一条判据必须靠仓库外证据才能复核** —— 真实模型调用／固定 120 题真实评估、真实供应商调用及其预算/凭据、后台四域联调、真机/浏览器读数、真实样本、真实时间流逝、第三方书面确认；这类证据本仓库内无法自行取得。**即使工程面只剩一片代码动作，也记本档**（例：#12 的 #409、#18 的 #439 合入后仍不能关单）。**本档只表示「关单瓶颈在仓库之外」，不表示该 issue 的代码已经够用。**
- **未就绪**：工程面仍有**多处**功能未实现（不是一片能补）。

**②「缺什么」列的六个基础标签**：`代码`／`真机读数`／`真 PG 读数`／`真实供应商`／`契约裁定`／`用户决定`。前四类里只有「代码」和「真 PG 读数」是本仓库能自行完成的（本机有 PG 17.11，真库臂 23/23 可跑），后两类一律记为外部条件。行内另有 `外部`／`真实样本`／`评估`／`数据采集`／`台账订正` 等补充标签，含义见该行原文。

**③档位只按「验收」节判，不按「缺什么」列的标签数量判**：#22、#29 的「缺什么」列都写了「真机读数」，但这两条 issue 的「验收」节各三条判据里没有一条明文点名真机（`gh issue view` 原文实读），所以它们仍记 `差一片能关`；这两处「真机读数」是**补强证据**，至今未取得，关单前必须如实说明。同理，#12、#18 之所以不能留在 `差一片能关`，是因为它们的「验收」节**明文**要求实时模型调用证据、固定 120 题验收与后台开关真实生效的读数，而不是因为「缺什么」列写得多。

**④三条口径提醒**（避免把矩阵读成关单许可）

- 台账 `implemented` 只表示「main 上已装配路由且行为有可复核证据」，**不代表该 issue 验收全绿**；真机层与真实供应商层不在台账覆盖面内。
- 证据页里的「已取得」只按该页自己声明的范围成立。例如 `docs/verification/gy-r29-real-pg-arms-audit-20261022.md` 的 23/23 是**本机 PG 17.11 读数，不是 Actions runner 读数**。
- 台账 `blocker` 字段有多处过期文案（见第 4 节）。判断「实现现状」时本页一律以 `services/api/src/**` 实读与迁移文件为准，不用 blocker 当事实。

## 2 关单就绪度矩阵（24 张）

> 列说明：**实现现状** 的锚点都是 main 上实读到的位置；**缺什么** 用六标签；**可关性** 用四档；**证据来源** 只列 PR 号（已合/在飞用「在飞」标注）。

| # | issue | 验收判据摘要 | 实现现状 | 证据现状 | 缺什么 | 可关性 | 证据来源 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | **#4** 微信登录、游客限制与服务端归属权限 | ①微信登录可用、拒绝资料仍可用基础功能；②越权 id／直连 API／分享／会话撤销受控；③不用客户端角色或 UID 做权限；④一次性 code 服务端换身份、正式 AppID 实测 | 已实现（服务端）：`loginWechat` 为 13 条 implemented 之一；会话与 `auth_epoch` 在 `services/api/db/migrations/0016_account_deletion_persistence.sql:68` | 有（PR #303 全链、#396）；无正式 AppID 读数 | 真机读数（微信登录/拒绝资料）；用户决定（正式 AppID 开通）；代码无缺 | 差外部条件 | 已合 #303、#396 |
| 2 | **#5** 单作物地区档案与定位/手选 | ①定位授权与拒绝路径可用、手选不依赖定位；②改档案不改写已存快照；③游客不可改他人档案；④服务端不收原始坐标 | 已实现（服务端）：`listCrops`、`listRegions` 均 implemented；档案读写 `services/api/src/profile/service.ts`（`cropItems` 见 :91/:93） | 有（PR #303、#392）；无真机定位读数 | 真机读数（授权/拒绝/手选三条路径）；代码无缺 | 差外部条件 | 已合 #303、#392 |
| 3 | **#6** 私有媒体上传、访问权限与 EXIF 清除 | ①伪扩展名/超限/越权 URL/重复/取消按契约；②私人媒体不进公共列表与普通日志；③音频编码与服务商适配真实核实；④帖图≤3 张 5MB、录音 60s/10MB、识别按 2MB 真实性能集 | 部分：媒体域无 PG store（`services/api/src` 下无 `media/store-pg.ts`），`getMedia` 仍是「内存记录 store」；上传/完成/授权四路路由在 `services/api/src/routes/media.ts` | 过期：`docs/verification/gy-i06-media-real-provider-plan-20261021.md` 是计划页；实读支持见 `tests/media/*` | 代码（#419 媒体持久化）；真实供应商（对象存储/音频编码适配）；真机读数（≤3 张 5MB 与 2MB 性能集） | 差外部条件 | 已合 #259、#320、#382、#408；在飞 #419 |
| 4 | **#7** 科普/除草剂查询、详情与来源版本展示 | ①任一展示记录可追溯来源、缺项不靠模型补写；②下架/失效退出有效查询且列表与详情一致；③不授 AI/用户经验专家标签、模拟记录不显示真实用量 | 已实现（服务端）：`getKnowledge`、`listHerbicides`、`getHerbicide` 三条 implemented；列表排序在 `packages/reference/query.mjs:512-513`（登记号升序） | 部分：`docs/verification/gy-r29-i07-closure-20261022.md`（314 行）四点未收口 | 契约裁定（`/herbicides` 排序现为登记号升序；契约 `state-contract.md:32` 冻结 `(created_at DESC,id DESC)`；台账 `contract-status.json:781` 又自述「当前 `id_asc`」⇒ **三口径互不一致，openapi 未钉该端点排序，须一次裁定**；合流按内容重锚（2026-10-25 #538 解冲突合流树 `upstream/main`=`1d65b7ee`＋本片实测重取），原记 `:716`，该 blocker 文本其后已由 R33 订正）；真 PG 读数（真实 `DATABASE_URL` 下排序，本机可跑）；数据采集（20 条 `review_status=unverified`） | 差一片能关 | 已合 #380、#388、#403、#413 |
| 5 | **#8** 药剂适用过滤与标签原文用量安全边界 | ①≥100 组登记/匹配/限制场景通过；②未核对/不适用/禁用不进可执行建议或问答用量卡；③风险文字无绝对安全承诺且有开关；④需求第 6 节 100 组全过、所有消费端同一规则版本 | 已实现（规则面）：`tests/reference/_i08-scenarios.mjs` 已有 **159** 个场景 id（首 `LIM-001`、末 `MRG-040`），用例 `tests/reference/i08-scenarios-100.test.mjs`（337 行） | 有（PR #264、#391、#420） | 真实样本/数据（真实登记与标签原文，本仓只有合成夹具）；真机读数（用量卡展示） | 差外部条件 | 已合 #264、#391、#420 |
| 6 | **#9** 实时拍草识别、Top3 核对与不确定处理 | ①实际服务调用有证据、预设仅明显标注兜底；②无可信分数不伪造高置信、候选<3 不补造；③任务归属与重试安全、不能跳过 #8；④实现时即跑第 6 节评估 | 部分：路由与 PG store 齐（`services/api/src/routes/recognitions.ts`、`services/api/src/app.ts:962`、迁移 `0025_recognitions_persistence.sql`）；real 模式媒体端口未注入 | 有（`tests/integration/recognitions-pg.mjs`、`real-pg-integration.yml:163`）；过期：识别域台账仍写「内存任务」 | 真实供应商（拍草识别真调 + 真实图片样本）；真机读数（拍照链路）；代码（媒体端口注入） | 差外部条件 | 已合 #299、#304、#333、#404、#412 |
| 7 | **#10** 实时标签 OCR、用户校正与登记精确核对 | ①模糊字段有核对入口、同名不同制剂不静默匹配；②校正前保留原始结果、手改不计 OCR 准确率；③冲突阻断用量卡、失败/超时不伪造成功 | 部分：路由齐（`services/api/src/routes/ocr.ts`，store 三态选型在 `:196`），PG store `services/api/src/ocr/store-pg.ts` + 迁移 `0024_ocr_persistence.sql`；`BuildAppOptions`（`services/api/src/app.ts:321-342`）无任何 `ocr*` 字段 ⇒ 媒体端口无法注入 | 有（`tests/integration/ocr-jobs-pg.mjs`、`ocr-corrections-pg.mjs`、`real-pg-integration.yml:149`） | 代码（OCR 媒体端口注入一行）；真实供应商（标签 OCR 真调）；真实样本（真实农药标签图）；真机读数 | 差外部条件 | 已合 #269、#270、#323、#331、#404、#424 |
| 8 | **#11** 普通话录音、实时 ASR 与发送核对 | ①真实 ASR 与转写状态可追溯、不用预设文本冒充；②关键字段不清晰不自动发送；③音频私有保存+外发授权接 F13 | 部分：路由齐（`services/api/src/routes/speech.ts:128` real+池 ⇒ PG store），迁移 `0026_speech_persistence.sql`；缺 MP3→WAV 解码器（契约钉死 `wav`） | 有（`tests/integration/speech-pg.mjs`、`gy-r28-speech-persist-20261021.md`） | 真实供应商（ASR 真调与真实转写文本）；真机读数（录音/重录）；代码（音频来源解码） | 差外部条件 | 已合 #294、#351、#352、#395、#404、#412 |
| 9 | **#12** 有来源的语音/文字大模型问答与回答安全检查 | ①实时模型调用有证据、私有会话与单条删除可查；②无虚构 URL/登记号/专家身份、未审内容不流式曝光；③危险问题不引导继续；④固定 120 题按需求验收、引用来自检索证据 | 部分：会话域已落库（迁移 `0013_conversations.sql`、`services/api/src/conversations/store-pg.ts`）；正文仍是确定性检索摘录，`model_version` 带 `unimplemented:no-real-` 前缀 | 有（`tests/integration/conversations-pg.mjs`、`qa-citations-pg.mjs`）；在飞 `#409` 接真模型 | 代码（#409 真模型接线，一片）；真实供应商（DeepSeek 真调读数 —— 验收①「实时模型调用有证据」；本表「证据现状」列无此读数）；评估（固定 120 题真实问答评估 —— 验收⑤「固定 120 题按需求验收」，提交证据节写明「120题真实问答评估由GY-I21执行」，未取得）；用户决定（预算/凭据：无凭据则真调与 120 题评估都做不了） | 差外部条件 | 已合 #258、#260、#300、#313、#386、#432；在飞 #324、#409 |
| 10 | **#13** 普通话 TTS、播放球与安全文本自动播报 | ①≥30 段实际普通话风险/数字单位播报准确；②静音/蓝牙/拒权/自动播放受阻有主动按钮与文字、不假记已听；③控制不遮挡提交或风险信息 | 部分：合成域路由齐；产物存储 real 模式 **未接线** —— `services/api/src/tts/media.ts:141-142` real ⇒ `createUnwiredMediaPort()`，`:124-129` put 一律 `OBJECT_UNAVAILABLE`；替身端口也拒真实产物（`:82-84`） | 有（`gy-r28-w3-tts-content-20261021.md`、`tests/integration/speech-pg.mjs`） | 代码（真实产物存储接线）；真实供应商（TTS 真调 30 段）；真机读数（静音/蓝牙/拒权） | 差外部条件 | 已合 #301、#322、#394、#404、#410 |
| 11 | **#14** 文字/图片 AI 筛查、版本重审与失败隔离 | ①旧版本审核不套新版本、超时/结构错误不发布；②AI 不授权限/改来源/标专家已审；③筛查与发布分开、下架事件驱动缓存失效 | 部分：四层全 fail-closed（`services/api/src/moderation/provider.ts:109-113`、`community/service.ts:642-681`／`:751-824`／`:864-877`）；**图片审核无产品路径**（带 media 帖被 `community/service.ts:874-877` 拒）；**审核台账仍是内存 `Map`**（`services/api/src/moderation/decisions.ts:350-354`）；**人工复核入口未接线**（`services/api/src/admin/human-review.ts:39-88` `wired:false` ＋零路由） | 有（`docs/verification/gy-r31-i14-recon-20261022.md`，在飞 #443）；台账 0028 在飞 #434(draft) | 代码（图片审核产品路径、台账落库、人工复核入口）；真实供应商（tms/ims 真调，现零外呼）；真实样本 | 未就绪 | 已合 #305、#310、#401、#429；在飞 #434、#443 |
| 12 | **#15** 真实社区发帖、评论、点赞、筛选与举报 | ①普通用户可投稿评论且经真实审核（非空态假帖）；②编辑重审/下架后列表详情一致、广告导流不发布；③游客/越权/重复点赞与评论引用隐藏版本检查通过；④读取时重查对象权限 | 部分（**已不是内存仓储**）：`services/api/src/app.ts:878` 按 pool 选 PG store，`services/api/src/community/store-pg.ts:546` `persistent:true`（两处 R59 重记，原记 `:867`/`:473`），迁移 `0022_community_persistence.sql` | 有（`gy-r29-i15-community-filter-20261022.md` 197 行、`gy-r31-i15-recon` 在飞 #444、`tests/integration/community-pg.mjs`） | 代码 8 条：S1 举报状态机缺 / S2 真实审核未接 / S3 带媒体帖 fail-closed 不可发布 / S4 资料关联未接线 / S5 筛选未下推 SQL（`store-pg.ts:515-521` 无 WHERE ⇒ Seq Scan）/ S6 注销不清社区行 / S7 点赞无读取面 / S8 越权负控制缺 2 处 | 未就绪 | 已合 #296、#401、#406、#433；在飞 #435、#444 |
| 13 | **#16** 收藏与可浏览的识别历史 | ①他人不能读私有历史、旧收藏不恢复失效资格；②候选与人工选择分开、失败任务真实可见；③识别/收藏不转成已使用事实；④读取时重查权限 | 部分：收藏/读面已实现 —— 迁移 `0018_favorites_history.sql`，`services/api/src/app.ts:1661` `createPostgresFavoritesStore`、`:973` `createPostgresHistoryStore`；**但「识别/OCR → 历史写入」在 `executionMode === 'real'` 取 `createUnwiredRecognitionTerminalHistoryPort`／`createUnwiredOcrTerminalHistoryPort`**（`:947`／`:949`、`:955`／`:957`；端口 `kind:'unwired'`、`recordTerminal()` 空实现）⇒ 生产终态**不** `appendHistory`，只有非 real 分支才走 `recordHistoryTerminal`→`:945` `appendHistory`（`event_key` = `kind:job_id`） | 有（`tests/unit/history-http.test.mjs` 四条、`tests/integration/favorites-history-pg.mjs` 13 组、`real-pg-integration.yml:153`）；**该真库臂里 `appendHistory` 那条是直调 `app.historyService.appendHistory`（脚本 `:562`），不覆盖 `recordTerminal`→`appendHistory` 这条生产链路**；台账仍写「内存存储」（存储口径过期） | 真机读数（收藏/历史三页走查）；台账订正（5 条 blocker：存储口径已过期，但「识别/OCR→历史写入属跨线」半句在 real 下仍真）；**代码（real 模式识别/OCR 终态历史端口接线，一片）**；`deleteHistory` 级联端口属 #19，不在本行计 | 差外部条件 | 已合 #272、#298、#319、#390、#393、#405、#430、#431 |
| 14 | **#17** 应用内消息、未读状态与权限跳转 | ①重复调度不重复创建、未读计数可复核；②发送或创建不当事已读、游客与他人不可读；③不接微信外部推送、不虚构真人互动；④读取时重查权限 | 部分：服务端 4/4 齐（列表 `services/api/src/routes/messages.ts:43`、未读 `count(*)` 派生、标读 CAS `services/api/src/messages/store-pg.ts:300`、事件 4 源真投递）；**跳转客户端整体未落地**（`miniprogram/pages/messages/messages.wxml:83-99` 纯 `<view>`、`messages.js:28-31` 自陈无入口） | 有（`docs/verification/gy-r31-i17-recon-20261022.md` 241 行，16 文件/174 例/0 失败）；在飞 #448、#452 | 代码（跳转只做 post/comment 两型 → 其余 14 型降级实现）；代码（未读数失败**有**重试：`messages.js:229-233` 置 `unreadRetryable: true` 并在 note 末尾带「（点此重试）」，`:244-248` 专用入口 `onRetryUnread`，`wxml:29-33` pill 挂 `bindtap="onRetryUnread"`；原记「`messages.js:195` 无重试＋`wxml:27` pill 无 `bindtap`」已不成立） | 未就绪 | 已合 #278、#399、#405、#422、#425；在飞 #445、#448、#452 |
| 15 | **#18** 独立后台资料、账号、AI 任务与功能开关 | ①普通账号不能管理或绕过硬规则、变更来源会重校验并失效引用；②全局开关真实生效、下架缓存与详情同步；③不把基础账号管理说成人审已完成 | 部分：admin 路由 34 条已装配（`services/api/src/routes/admin.ts`），开关 PG `0020_feature_flags.sql`、账号读面 `0021_admin_accounts_read.sql`、审计 `0027_admin_audit_observability.sql`，UI 已有 `FlagsView.vue`／`AuditEventsView.vue`；**作业台页面缺**（2026-10-22 读数）→ **已由 `187aced2`（#439）落地**（2026-10-25 当前读数：`apps/admin/src/views/JobsView.vue:67` 读 `/admin/jobs`、同文件 `:155` 取消带 If-Match，`apps/admin/src/App.vue:20` 第 6 个 tab「作业台」） | 有（`tests/integration/admin-*.mjs` 四臂、`gy-r31-i18-recon` 在飞 #446） | 代码（#439 作业台页面，一片 UI —— **已于 `187aced2` 落地，2026-10-25 起不再计为缺口**，原记按历史保留）；真 PG 读数（后台四域联调 —— 验收①「变更来源会重新校验和失效相关引用」、②「全局开关真实生效，下架缓存和详情同步」）；真机读数（浏览器/真机后台走查 —— 提交证据节「独立后台权限、配置开关和审计记录」；本表「证据现状」列无此读数） | 差外部条件 | 已合 #279、#282、#311、#383、#384、#387、#428、#439（2026-10-25 当前读数；原记「在飞 #439」按原样保留为历史）；在飞 #446 |
| 16 | **#19** 注销去身份、在线 7 日备份 30 日删除与恢复验收 | ①任务覆盖账号/音频转写问答/识别/媒体/收藏消息/缓存导出等实际对象；②未获第三方确认不标完成；③不同注销作者不混同主键、无身份反查 | 部分：受理已落库（`services/api/src/app.ts:1462-1465` `createPostgresDeletionRequestStore`）；**real 模式整域不接线是刻意门**（`services/api/src/app.ts:1558-1565` 注释、`:1567-1571` `available: executionMode !== 'real'`） | 有（`gy-r29-i19-closure-20261022.md` 172 行）；过期/未取得 10 条 | 代码（在线 7 日执行器 #407、撤角色、`withdrawConsent` 409 依赖臂）；外部（真实备份介质、30 天真实时间流逝、第三方删除书面确认、恢复演练） | 未就绪 | 已合 #291、#295、#338、#397、#398、#400、#414、#416、#421；在飞 #407 |
| 17 | **#20** 冻结独立评估样本、标准答案及评估程序 | ①独立核实标准答案、模型不得当自己的答案；②样本不足如实记录未完成；③冻结清单/来源/划分/口径先经监工审查 | 部分：只有**拍草域**真实样本冻结（`packages/evaluation/samples/gy-i20-weeds-real-index.json` 172 条 `split=test`，来源私有 Word 129.9 MiB / sha256 `624ee4d5…`）；其余 6 域无真实样本（`docs/evaluation/sample-gap-register.md` 100 行自陈） | 有（`docs/verification/gy-i20-real-samples-20261014.md`、`gy-i03-i20-materials-gap-ledger-20261015.md`）；在飞 #441 | 外部（其余 6 域真实样本的采集授权与人工标注）；用户决定（监工审查冻结清单） | 差外部条件 | 已合 #263、#427；在飞 #441 |
| 18 | **#21** 持续评估真实 AI 能力并汇总验收门槛 | ①不达标项明确失败并整改、不能靠手改或预设提指标；②真实调用有证据并报样本数/版本/覆盖；③不宣传零风险、不写日志或提交私有媒体凭据 | 部分：门槛表在 `packages/evaluation/src/targets.mjs`（`METRIC_GATES`，14→18 条，**全部 basis 为 provisional**）；无任何真实模型成绩 | 有（`tests/evaluation/*` 10 个、`docs/evaluation/acceptance-thresholds-summary.md`）；在飞 #440 | 真实供应商（真实调用成绩）；外部（样本覆盖）；用户决定（门槛定稿） | 差外部条件 | 已合 #265、#281；在飞 #440 |
| 19 | **#22** 权限、安全规则与端到端失败回归 | ①关键安全权限用例全通过、未解决严重缺陷 0；②实际接口状态与数据结果可核对；③处方混配/伪来源/未审内容公开均阻止 | 部分：失败矩阵在 `tests/failmatrix/mutations.mjs`（23 条变异，`tests/unit/gy-i22-failmatrix.test.mjs`）；27 对同形守卫在飞 #454；429/504 形状断言在飞 #442 | 有（`docs/verification/gy-r29-arms-isolation-20261022.md`、`gy-r29-real-pg-arms-audit-20261022.md`）；在飞 #438、#442、#447、#449–#451、#454、#455 | 代码（230 条失败矩阵 #449、`Retry-After` 缺头 `services/api/src/auth/wechat.ts:121`、504 `retryable:false` 偏差 `services/api/src/knowledge/service.ts:119`）；真机读数 | 差一片能关 | 已合 #256、#261、#267、#271、#297、#302、#306–#309、#418、#423；在飞 #438、#442、#447、#449、#450、#451、#454、#455 |
| 20 | **#23** Android/iOS 真机、时延容量与完整演示验收 | ①记录设备系统/微信/资源/缓存/网络与完整样本、不挑最快；②静音/蓝牙/拒权/断网重播状态可见、审查前不播放；③不把内部替身压测称外部 AI 容量 | 未实现：**`docs/verification` 下不存在任何 Android/iOS 真机读数页**（device 相关的只有 demo/deploy 系列） | 无 | 真机读数（设备台账、系统版本、网络、时延容量）；外部（设备与微信账号） | 差外部条件 | 已合 #315、#317 |
| 21 | **#24** 部署联网比赛版、备份恢复与完整材料交付 | ①首版必交 AC 均有对应证据、安全权限缺陷 0；②联网真实识别/ASR/问答可用、预设仅标注兜底；③无真实支付/人审/专家/地区预警假上线 | 部分：发布材料索引 `docs/verification/gy-i24-release-materials-index-20261017.md` 与 r28 deploy 五页（`deploy-pg-conf-guard`/`deploy-sql-gate`/`deploy-sql-recovery-replay`/`deploy-swallow-audit`）只在 CI 与本地；无正式环境读数 | 过期：以上页面都是 CI/本地口径，不是联网比赛环境 | 外部（CVM、HTTPS 域名与备案、真实备份介质、恢复演练窗口）；真实供应商；用户决定 | 差外部条件 | 已合 #283、#288、#289、#290 |
| 22 | **#27** 正式 AppID、真机域名及 AI/数据库服务接入前置验证 | ①六类服务各一真实成功样例 + 一受控失败路径、正式 AppID 与真机联网及录音格式有证据；②密钥只在服务端；③输出接入矩阵、阻塞与替代方案 | 部分：已有一次最小真调（`docs/verification/gy-i27-live-ai-20261018.md` 200 行：8 次付费发送、7 个端点、累计 **¥0.7146**、重试 0、密钥零打印）；**正式 AppID 与真机域名仍未取得** | 有（同页 + `tencent-live-evidence.md`、`llm-live-evidence.md`、`provider-matrix.md`、`ai-configuration-evidence.md`）；页面自述「不构成 #27 关闭」 | 外部（正式 AppID、真机域名/备案、录音格式真机验证）；用户决定（是否继续付费调用） | 差外部条件 | 已合 #286 |
| 23 | **#28** 五 Tab 原生页面骨架、Demo 样式与统一失败状态 | ①微信工具可编译并导航五 Tab、未登录入口控制、静态地区不假预警、人审空入口与模拟标记正确；②Demo 走查可见可点无遮挡；③不把可点原型算实时能力完成 | 部分：小程序页面与统一失败态已落地（PR #268/#287/#293/#385/#417）；五 Tab 真机走查未做 | 有（`gy-i26-demo-align-20261014.md`、`gy-i28-demo-parity-20261018.md`）；在飞 #436 | 真机读数（微信开发者工具 + 真机 Demo 走查）；代码（recon 页 #436 列出的缺口） | 差外部条件 | 已合 #268、#287、#293、#385、#417；在飞 #436 |
| 24 | **#29** 前置用途授权、外发账本与隐私撤回接口守卫 | ①无授权与错用途不触发实际外发、撤回注销与任务竞争/旧结果回写被守卫；②日志不含私有正文/图片/音频/坐标/凭据；③一致授权错误码与模块删除注册协议；④首版用户训练开关关闭 | 已实现（服务端）：外发账本 purpose 与 `no_training_verified`（`services/api/src/privacy/ledger-pg.ts:293`/`:303`/`:431-432`/`:507`、`services/api/src/privacy/grant-pg.ts:63`/`:65`）；`withdrawConsent` 依赖 409 已实现但缺依赖臂 | 有（`gy-r29-i19-closure-20261022.md`、`tests/privacy/*`） | 代码（`withdrawConsent` 409 依赖臂）；真机读数（授权弹窗） | 差一片能关 | 已合 #257、#280、#421 |

## 3 只差最后一步的 issue（按可关性排序）

> 本节只列 `差一片能关` 的 3 张。该档按第 1 节定义限定为：只剩一片已定位的工程动作，**且该 issue「验收」节没有任何一条判据要求仓库外证据**。

1. **#7 科普/除草剂** —— 最后一步：**裁定**。只差监工对 `/herbicides` 排序口径的一句话（现为登记号升序 `packages/reference/query.mjs:512-513`，冻结口径是 `(created_at DESC,id DESC)`）；随后补一次真实 `DATABASE_URL` 排序读数（本机可跑，无需外部）。
2. **#22 失败回归** —— 最后一步：**代码**。只差 `#449`（230 条失败矩阵）与 `#442`/`#447`/`#450`/`#451`（429 `Retry-After`、504 `retryable` 偏差）合入；主守卫与 23 条变异已在 main。
3. **#29 授权与外发账本** —— 最后一步：**代码**。只差 `withdrawConsent` 的 409 依赖臂（`jobs`/`media`/`exports`/`author_links` 四类依赖各一条负控制）；账本与 grant 主体已在 main。

> 这 3 张里 **#7 是唯一「一句话就能解锁工程面」的卡**，另两张在等一个已开的 PR 合入。三张的「验收」节都不要求真机/供应商读数；它们「缺什么」列里的「真机读数」是补强项（见第 1 节 ③），未取得，关单前要说明。

### 3.1 按监工批复移出本档的两张（原记 `差一片能关`）

- **#12 问答 → `差外部条件`**：`#409`（真模型接线）合入只是**一片代码**；其「验收」①「实时模型调用有证据」、⑤「固定 120 题按需求验收」仍需**真实 DeepSeek 调用读数 + 120 题真实评估**（「提交证据」节写明「120题真实问答评估由GY-I21执行」），且是否付费取决于用户预算/凭据 ⇒ 该片合入后仍不能关单。会话落库、引用、删除、120 题口径确实已在 main。
- **#18 后台 → `差外部条件`**：`#439`（作业台页面）合入只是**一片 UI 代码**；其「验收」②「全局开关真实生效，下架缓存和详情同步」与「提交证据」节「独立后台权限、配置开关和审计记录」需**后台四域真 PG 联调读数 + 浏览器/真机读数**，而本表「证据现状」列只有 `tests/integration/admin-*.mjs` 四臂与 recon 页，没有任何后台四域联调或浏览器读数 ⇒ 该片合入后仍不能关单。其余 34 条 admin operation、开关/账号/审计三张表、两个后台视图确实已在 main。

> 两张都没有被要求在本片补跑付费调用或真机；本节只如实保留尚缺的验收与依赖，不主张关单、不派新任务。

## 4 过期台账文案清单（只列不改）

**范围**：`docs/architecture/contract-status.json` 的 `blocker` 字段。判据是「实读 `services/api/src/**` 与迁移文件后与事实不符」。本机实测 113 条 operation 中 **33 条已实证过期**（其中 **32 条属 `partial`、1 条属 `planned`**——`listExports`；不是「partial 96 条里的 33 条」），另有 **34 条 GY-I18 模板**待逐条复核（其中至少 `listFlags`/`setFlag`/`listAuditEvents`/`listFlagAuditEvents`/`listAdminUsers` 五条的「真实存储未交付」已被 0020/0021/0027 与三个后台视图证伪）。

**组 A：社区 16 条（最严重）** —— `listPosts` `createPost` `getPost` `editPost` `deletePost` `listComments` `createComment` `getComment` `editComment` `deleteComment` `likePosts` `unlikePosts` `likeComments` `unlikeComments` `createReport` `getOwnReport`
- 原文摘要：「**未取得**：真实持久存储未交付（real 模式整域 503 `PROVIDER_UNAVAILABLE`）…」
- 现况：迁移 `0022_community_persistence.sql` 已在 main；`services/api/src/app.ts:878` 按 pool 选 `createPostgresCommunityStore`；`services/api/src/community/store-pg.ts:546` 标 `persistent:true`（两处 R59 重记，原记 `:867`/`:473`）；真库臂 `tests/integration/community-pg.mjs` 23 组已接 CI（`real-pg-integration.yml:79`）。**没有 real 整域 503 的路径**。

**组 B：收藏/历史 5 条**
- `listFavorites`、`createFavorite`、`deleteFavorite`、`listHistory`、`deleteHistory` —— 原文摘要：「GY-I16 本片只交付**内存存储**（进程重启即丢，无数据库迁移）⇒ real 模式整域 503」
- 现况：`0018_favorites_history.sql` 建四表，`services/api/src/app.ts:1661`/`:973` 接 PG store；`listHistory` 那句「识别/OCR → 历史的写入接线属跨线…待指挥另行派单」只在**非 `real`** 分支被推翻（`recordHistoryTerminal`→`appendHistory`，`tests/unit/history-http.test.mjs` 四条）；**`real` 下该半句仍真**（端口取 `createUnwired*TerminalHistoryPort`，见第 0 节订正记录与第 2 节 #16 行），过期的只是「内存存储 / real 整域 503」这半句。**这 5 条在 `docs/verification/gy-r29-i16-ledger-closeout.md` 里已有现成处方，只是从未执行**。

**组 C：识别 4 条** —— `createRecognition` `getRecognition` `deleteRecognition` `selectSpecies`
- 原文摘要：「HTTP 与**内存任务**/结果/选种/删除闭环已装配…」
- 现况：`0025_recognitions_persistence.sql` + `services/api/src/recognitions/store-pg.ts` + `services/api/src/app.ts:962`（real 且池非空 ⇒ PG）；真库臂 `recognitions-pg.mjs` 已接 CI（`:163`）。「内存任务」措辞过期。

**组 D：转写 4 条** —— `createTranscription` `getTranscription` `deleteTranscription` `confirmTranscription`
- 原文摘要：「…**默认内存 store**，stub/preset_demo 为明确替身…」
- 现况：`0026_speech_persistence.sql` + `services/api/src/routes/speech.ts:128`（real 且池非空 ⇒ `createPostgresSpeechStore`）；真库臂 `speech-pg.mjs` 已接 CI。「默认内存 store」过期。

**组 E：注销回执 1 条** —— `getDeletionReceipt`
- 原文摘要：「回执只投影**进程内**台账，无持久化 ⇒ real 整域 503」
- 现况：把两件事混了。受理行已落 PG（`services/api/src/app.ts:1462-1465` `createPostgresDeletionRequestStore`，迁移 `0016`），回执投影也来自 `wired.deletion.receipt(id)`；real 模式的 503 来自**刻意的 `available: executionMode !== 'real'` 门**（`:1567-1571`），注释写明「真实执行链路尚未实现」。真正仍在进程内的只有 bearer 台账（`:1566` `createDeletionReceiptRegistry`）。

**组 F：契约计数 1 条** —— `getMedia`
- 原文摘要：「冻结契约（**85 条路径 / 112 条 operation**）内没有…」
- 现况：`packages/contracts/openapi.json` 实测 **86 paths / 113 operation**。数字过期（`getMedia` 本身「无持久化实现」仍真，`#419` 未合）。

**组 G：导出 1 条** —— `listExports`
- 原文摘要：「导出与注销未实现（GY-I19）」
- 现况：**注销已实现**（`requestAccountDeletion`/`getDeletionReceipt` 两条 operation 存在且路由已装配，`services/api/src/routes/account-deletion.ts:116-125`）；只有「导出」这一半仍真（`me/exports` 路由零命中）。

**组 H：审计 UI 1 条（blocker 不成立）** —— `listFlagAuditEvents`
- 原文摘要：「…后台 UI 已有「操作者/变更前后」列；人审隔离位仍属契约/范围外（AdminJob 9 字段无隔离位）」
- 现况：这两句本身在 UI 侧成立（`apps/admin/src/views/AuditEventsView.vue:250` `<th>操作者（actor）</th>`、`:251` `<th>变更（before → after）</th>`），但「人审隔离位」是 **AdminJob 的字段问题，不属本 operation 的验收面**；本 op 的路由（`services/api/src/routes/admin.ts:353`）、服务（`services/api/src/admin/ops/service.ts:1059`）、审计表（`0027`）、UI 四件都在。⇒ 该 blocker 不构成本 op 未完成的理由。

**组 I：GY-I18 模板 34 条（待逐条复核，未计入 33 条）** —— `listAdminSources`…`listAuditEvents`
- 原文摘要：「…真实存储、任务/公开内容等端口、审计与后台 UI 联调待完成（GY-I18）」
- 现况：至少 5 条已被代码证伪（`listFlags`/`setFlag`/`listAuditEvents`/`listFlagAuditEvents` 有 0020/0027 与两个视图；`listAdminUsers` 有 0021 与 `admin-accounts-read-pg` 15 组），但「任务端口未完成」这一半对 `listAdminJobs`/`cancelAdminJob` 仍真（原记「作业台页面缺」已不成立：作业台已由 `187aced2`（#439）落地，见 #18）。**这 34 条需要逐条核，不要整组订正**。

> 处置建议：本节只做清单。真正订正应由一片「台账订正片」一次性处理，且必须跑 `node tools/verify-contract-status.mjs`（锚点容差 ±2 行的硬约束在 `gy-r29-i16-ledger-closeout.md` 里记过）。组 A–D 共 29 条的订正方向是 **partial → implemented**（服务端契约面已满足），组 F/G/H 是文案订正（状态不变），组 E 是拆分表述，组 I 需逐条核。

## 5 外部条件清单（谁都不能在本仓库内解决）

| 外部条件 | 覆盖 issue | 说明 |
| --- | --- | --- |
| Android/iOS 真机读数 | #4 #5 #6 #9 #10 #11 #13 #16 #22 #23 #28 #29 | `docs/verification` 下**零个**真机页；卡在设备与微信账号 |
| 正式 AppID / 真机域名 / 备案 | #4 #27 #24 #28 | #27 的页面自述「本页不构成 #27 关闭」 |
| 真实供应商产品级接线 | #6 #9 #10 #11 #12 #13 #14 #21 #24 | 现只有一次 ¥0.7146 的最小真调样例；tms/ims 仍是零外呼；#12 的 DeepSeek 真调读数与 120 题真实评估均未取得 |
| 后台四域联调与浏览器读数 | #18 | 本表「证据现状」列没有任何后台四域联调或浏览器读数（只有 CI 的四条 admin 臂与 recon 页）；`#439` 作业台页面合入也不产生该读数 |
| 真实样本（6 域） | #8 #9 #10 #20 #21 | 只有拍草域 172 条真实样本冻结 |
| 真实时间流逝（30 日）与第三方书面确认 | #19 | 备份 30 日清除已落地，但没有 30 天真实流逝与第三方删除确认 |
| 用户/监工裁定 | #7（排序口径）、#12（预算/凭据）、#20（冻结清单）、#21（门槛定稿）、#27（是否继续付费） | 纯决定，无工程量 |
| 比赛部署环境（CVM/HTTPS/网络） | #24 | 现有 deploy 证据全是 CI 与本地 |

## 6 读数（本页产出前后各跑一次，证明没把台账弄红）

```
# 在 E:\GengYunCommander\wt-r31-i458-class（分支 fix/gy-r31-closure-matrix-class，基线 fbfda76b），PATH 前置 D:\Git\bin
node tools/verify-contract-status.mjs
  PASS: 覆盖 113 条契约操作；已装配 109 条；implemented 13 / partial 96 / planned 4；横切维度 8 条；形状错误 0 项；语义错误 0 项
  PASS: 语义可核 105 条区间 + 0 条片段；不可核 99 条区间 + 158 条片段（不可核不计入通过）
  PASS: 证据锚点 412 条引用自带锚点（区间内 240 条 + 仅整文件 172 条）；无锚点不可核 0 条（纯行号 0 + 无行号源文件 0 + 无用例名 0），只计数不判红
  PASS: 纯行号区间 240 条（有实质内容 240 条；整段仅空白/收尾行 0 条、区间首行为空行 3 条，只计可疑不判红）
  PASS: 中文表格一致
  PASS: 状态为人工判定；脚本不证明语义正确、真实能力或整项验收。
  EXIT=0
```

```
npm run test:docs        # ＝ node tools/run-python.mjs tools/validate_development_docs.py && node tools/verify-research-records.mjs
  PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables
  研究记录校验：5 通过 / 0 失败 / 4 legacy 已钉住
  PASS docs/research 结构校验：命名＋记录级四项＋按项来源＋技术七项＋legacy 钉住
  EXIT=0
```

```
python tools/validate_development_docs.py      # 单独跑一次（＝ CI development-docs job 第一条命令）
  PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables
  EXIT=0
```

### 6.1 第 2 节逐行表复算（四档相加 = 24，缺代码 / 代码无缺 = 15 / 9）

第 0 节的四档与两张代码缺口清单都从第 2 节 24 行实算得出，复核命令如下（bash/awk；`$7`=缺什么、`$8`=可关性）：

```bash
F=docs/verification/gy-r31-closure-matrix-20261022.md
grep -c '^| [0-9]\+ |' "$F"                                    # 第 2 节表行数
awk -F'|' '/^\| [0-9]+ \|/ {t=$8; gsub(/^[ \t]+|[ \t]+$/,"",t); c[t]++; sum++; m=$7; if (m ~ /代码无缺/) n++; else if (m ~ /代码/) y++; else n++} END {for (k in c) printf "%s=%d\n", k, c[k]; printf "四档相加=%d 缺代码=%d 代码无缺=%d 缺+无缺=%d\n", sum, y, n, y+n}' "$F"
grep -cE '真正还缺代码的只[有]|真正缺代码只[有]' "$F"          # 旧措辞残留（`[有]` 防止本命令行自匹配）
```

```
24
未就绪=4
差外部条件=17
差一片能关=3
四档相加=24 缺代码=15 代码无缺=9 缺+无缺=24
0
```

> 计数口径：行内「缺什么」写作 `代码无缺` ⇒ 记「代码无缺」；出现 `代码`（含一片在飞 PR 的代码）⇒ 记「缺代码」；两者都不写（只列外部/样本/裁定）也记「代码无缺」。`现在就够关` 为 0 行，故 awk 不输出该档。四档相加、表行数、`缺+无缺` 三个读数必须都是 24。最后一行 `0` 是旧措辞命中数（`grep -c` 命中 0 行时按惯例 exit 1，读数仍是 0，不是脚本失败）。

## 7 本轮新事实（与既有材料不完全一致的地方）

1. **#8 的「≥100 组」其实已经超额**：`tests/reference/_i08-scenarios.mjs` 有 **159** 个场景 id（首 `LIM-001`、末 `MRG-040`），而台账/issue 文案一直按「100 组」表述。判据 ① 已满足，卡的是真实数据而不是数量。
2. **`getMedia` 的 blocker 里「85 条路径 / 112 条 operation」是过期计数**：实测 `packages/contracts/openapi.json` 是 86 paths / 113 operation。
3. **`listExports` 的 blocker 把「导出与注销」捆在一起**，而注销这条腿已经实现（受理行落 PG、路由已装配）；只有导出腿仍空。
4. **#19 的 real 模式 503 不是「没实现」，是刻意门**：`services/api/src/app.ts:1558-1565` 的注释直接写明「real 模式整域不接线——真实执行链路尚未实现」，`available: executionMode !== 'real'`。台账把「刻意门」写成了「无持久化」。
5. **`listFlagAuditEvents` 的 blocker 不成立**（组 H）：四件都在，剩下的「人审隔离位」是 AdminJob 的字段问题。
6. **#13 的「一行注入替身即到 200」不等于验收可过**：`services/api/src/tts/media.ts:141-143` 连替身端口都拒 `substitute===false` 的真实产物，所以 real 链的产物存储是真缺口，不是配置问题。
7. **`docs/verification` 里没有任何真机页**：#23 的证据现状不是「过期」而是「从未存在」。
8. **STATE 盘的开放 PR 自报 19 张，`gh` 实测 26 张**（#449–#455 未被计入）——盘面落后于 gh，排期时以 `gh pr list` 为准。

---

**红线自查**：本页只新增 1 个 Markdown 文件；未改业务代码、未改 `contract-status.json`、未改 issue 状态、未加/删 PR、未合并、未 approve、未评论 issue。真机与真实供应商相关项一律记为外部条件，未做任何尝试。
