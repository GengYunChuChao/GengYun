# #6 / #15 逐条 AC 证据页（2026-11-08 快照 · R87 · GY-I06 / GY-I15）

> **本页是取证页，不是关单凭据。** 它只逐条记录「`origin/main` 上此刻有什么代码、有什么用例钉住该行为、还差什么」，**不背书任何 issue 可以关单**，也不替代用户验收。

## 0. 头信息

| 项 | 值 |
| --- | --- |
| 快照时间（HKT） | 2026-11-08 03:30（UTC+8） |
| 基线提交 | `origin/main` = `1f62322859f7b8aa6a4a2e2e2bf06a0cc94f3aac`（2026-11-08 03:04:53 +0800，`fix(miniprogram): 如实说明注销受理后不可撤回`） |
| 本页工作树 | `E:\GengYunCommander\.pg17\wt-r87-i06i15ac`，分支 `docs/gy-r87-i06-i15-ac-evidence`，HEAD 与上面同一提交 |
| 行号口径 | 表中每个 `path:line` 都由本页作者用 `git show origin/main:<path>` 逐行核对后写下；行号对不上说明 main 已前进，请按当时的 `origin/main` 重核，不要沿用本页数字 |
| 本页立场 | **不背书关单**：本页不主张 #6 / #15 的任何一条 AC 已由用户验收，也不主张这两个 issue 现在可以关 |

两张 issue 的验收原文取自体内容（`gh issue view` 实测）：#6 的复选框在正文第 27–30 行，#15 的在第 26–29 行。**AC6-1…AC6-4 / AC15-1…AC15-4 这八个编号是本页加的**，issue 原文只有复选框、没有编号。

## 1. 判定口径

本页只用三档，且三档都只描述「main 上有代码 / 有用例」这一件事：

| 判定 | 含义 | 不能推出什么 |
| --- | --- | --- |
| 已实现且有测试钉住 | 实现代码在 `origin/main`，且仓内自动化用例对**该条 AC 描述的行为**有断言 | 推不出用户验收；推不出真机 / 真实供应商 / 真实对象存储已验证 |
| 部分实现 | 该条 AC 里有一部分行为有实现与用例，另一部分（常见：真实供应商、真机、真实存储、行为级负控制）在仓库内没有证据 | 推不出「差一点点」：缺的那部分往往正好是唯一硬阻断 |
| 未实现 | main 上找不到实现，也没有对应用例 | — |

计数：8 条 = **已实现且有测试钉住 3 条**（AC6-2、AC15-2、AC15-3）+ **部分实现 5 条**（AC6-1、AC6-3、AC6-4、AC15-1、AC15-4）+ **未实现 0 条**。

## 2. GY-I06（issue #6）逐条

issue #6「[初版 GY-I06] 实现私有媒体上传、访问权限及EXIF清除」仍 OPEN；验收前置列的是 #2（现 CLOSED）、#4、#29。

### AC6-1 ·「伪扩展名、超限、越权URL、重复上传／任务和取消按契约处理」— 部分实现

| 项 | 内容 |
| --- | --- |
| 现状判定 | **部分实现**。伪扩展名、超限、越权、重复/并发四类都有行为级用例；「取消」没有独立契约动作，只有 DELETE 与 24h 到期回收两条替代路径 |
| 代码锚点 | `packages/media/validate.mjs:38`（上传输入校验入口）、`packages/media/validate.mjs:54`（生效上限 = 用途上限与全局上限取小）、`packages/media/constants.mjs:61-66`（四类用途的字节上限）、`services/api/src/routes/media.ts:219`（POST /media/uploads）、`services/api/src/routes/media.ts:279`（DELETE /media/{id}） |
| 测试锚点 | `tests/unit/media-http-upload.test.mjs:296`（声明 image/png、真实 JPEG ⇒ 415 且回收对象）、`tests/unit/media-http-upload.test.mjs:189`（识别 3MiB → 413、帖图 6MiB → 413、语音 10MiB+1 → 400）、`tests/unit/media-http-upload.test.mjs:445`（同键并发不产生第二条媒体记录）、`tests/media/access.test.mjs:197`（他人不能经 owner 接口读别人的媒体，统一 404） |
| 还缺什么 | 「取消」侧只有 `tests/unit/media-http-upload.test.mjs:399` 的「24h 后到期回收」，**没有显式取消端点**（媒体路由全文件无 cancel 动作）；是否把「上传取消」写进契约属待裁定（§6 裁定 ①）。另：断点重试只在替身对象存储上跑过 |

### AC6-2 ·「原始位置／私人媒体不出现在公共列表或普通日志」— 已实现且有测试钉住

| 项 | 内容 |
| --- | --- |
| 现状判定 | **已实现且有测试钉住**。公开投影里没有对象引用与 owner；对外的图片是去 EXIF 的衍生件；日志侧对象引用与坐标都被脱敏 |
| 代码锚点 | `packages/media/exif.mjs:432`（结构性地清除图片元数据段）、`packages/media/tokens.mjs:22`（对外只发短效签名令牌，服务端只存 hash） |
| 测试锚点 | `tests/media/contract.test.mjs:98`（公开投影键集与契约 required 一致）、`tests/media/contract.test.mjs:108`（逐个禁止 object_ref / objectRef / owner_id / ownerId / rawRef / derivativeRef）、`tests/unit/media-http-upload.test.mjs:262`（完成上传后输出不含 EXIF/GPS）、`tests/privacy/redact.test.mjs:33`（data URI / 长 base64 / 对象引用密文被脱敏）、`tests/privacy/redact.test.mjs:45`（精确坐标与坐标对字符串被脱敏）、`tests/media/access.test.mjs:50`（owner 取图拿到去 EXIF 衍生件，非本人与过期均 404） |
| 还缺什么 | 本页只声称「代码 + 用例」这一层；真实对象存储桶上的完整图片链路仍无证据（所有用例跑在替身对象存储上） |

### AC6-3 ·「音频编码与服务商适配真实核实，不把产品限额冒充官方接口限制」— 部分实现

| 项 | 内容 |
| --- | --- |
| 现状判定 | **部分实现**。「60 秒 / 10MB 是产品限额」这点被如实写进常量与文档，并且是拿**真实音频字节**核的时长、不是信客户端声明；但「服务商适配真实核实」没有证据链——真实 ASR 未接线、真实录音样本为 0 |
| 代码锚点 | `packages/media/constants.mjs:69`（全局字节上限）、`packages/media/constants.mjs:72`（时长上限 60000ms）、`services/api/src/ai/asr-live-adapter.ts:86`（真实 WAV 容器与时长核验）、`services/api/src/speech/provider.ts:39`（失败码闭集：换容器只报 MEDIA_TYPE_UNSUPPORTED，不伪装成供应商不可用） |
| 测试锚点 | `tests/unit/media-http-upload.test.mjs:335`（声明 60s、真实 61s 的 WAV ⇒ 400 且上传对象被回收）、`tests/unit/media-http-upload.test.mjs:183`（用途与真实类型不符 ⇒ 415） |
| 还缺什么 | 真实 ASR 供应商未接线（凭据缺，见 §5）；真实录音样本 `asr_utterances` 0/50、`asr_speakers` 0/10（`docs/evaluation/sample-gap-register.md:30-31`，同页 `docs/evaluation/sample-gap-register.md:52` 记「六域零真实样本」）⇒「音频编码与服务商适配真实核实」今天拿不出读数 |

### AC6-4 ·「未授权、伪后缀、超大、跨账号、重复提交和过期访问均受控；帖图最多3张每张5MB，录音60秒10MB，识别按2MB真实性能集验证」— 部分实现

| 项 | 内容 |
| --- | --- |
| 现状判定 | **部分实现**。六类拒绝面 + 三个产品限额都有代码与用例；缺的是「识别按 2MB 真实性能集验证」这一句——没有真实性能集 |
| 代码锚点 | `packages/media/constants.mjs:75`（每帖 3 张）、`packages/media/constants.mjs:61-66`（帖图 5MiB / 语音 10MiB / 识别 2MiB）、`services/api/src/media/service.ts:1202`（短效访问句柄的过期时刻 = 签发时刻 + TTL） |
| 测试锚点 | `tests/media/access.test.mjs:143`（会话不符 ⇒ SESSION_EXPIRED；句柄到期 ⇒ 404）、`tests/unit/post-media-attachments.test.mjs:228`（第 4 张触发 CHECK 23514 ⇒ 400 带 post_image_limit 机器码且整笔回滚）、`tests/unit/community-post-media-limit-code.test.mjs:82`（POST 带 4 个 media_ids ⇒ 400，details[0] 逐字 { field: /media_ids, code: post_image_limit }）、`tests/unit/media-http-upload.test.mjs:296`（伪后缀）、`tests/unit/media-http-upload.test.mjs:189`（超大） |
| 还缺什么 | 「识别按 2MB 真实性能集验证」无真实样本集（`docs/evaluation/sample-gap-register.md:52`）；real + PG 的 HTTP 端到端未合入（§5） |

## 3. GY-I15（issue #15）逐条

issue #15「[初版 GY-I15] 实现真实社区发帖、评论、点赞、筛选与举报」仍 OPEN；验收前置 #4、#5、#7、#14、#28、#29。

### AC15-1 ·「普通用户可投稿评论并经过真实审核，非空态或假帖子」— 部分实现

| 项 | 内容 |
| --- | --- |
| 现状判定 | **部分实现**。投稿 / 评论 / 筛选 / 举报的写入与读取路径都在 main 且有 HTTP 级用例；但「经过**真实**审核」今天做不到：审核域在 real 与默认装配下都是 fail-closed，替身只回 `unsure`，所以 `POST /posts` 恒 422，社区里今天没有一条经真实审核的帖子 |
| 代码锚点 | `services/api/src/moderation/provider.ts:42-51`（出厂替身恒 `unsure`，合流层判隔离）、`services/api/src/routes/community.ts:213`（POST /posts）、`services/api/src/routes/community.ts:266`（POST /posts/{id}/comments） |
| 测试锚点 | `tests/unit/community-http.test.mjs:173`（投稿 / 筛选 / 详情 / 评论 / 点赞幂等 / 举报与处理状态的 HTTP 正控制）、`tests/unit/community-moderation-negative-control.test.mjs:230`（纯默认装配下 POST /posts ⇒ 422 INPUT_UNCERTAIN、内容行 0、GET /posts 仍 200） |
| 还缺什么 | 真实审核供应商凭据（唯一硬阻断，**仓库内做不到，需用户提供**，见 §5）；因而「非空态或假帖子」这一句今天只有替身 + 演示端口两条合成路径 |

### AC15-2 ·「编辑重审／下架后列表详情引用一致，广告导流不发布」— 已实现且有测试钉住

| 项 | 内容 |
| --- | --- |
| 现状判定 | **已实现且有测试钉住**。编辑必然重新送审、驳回不覆盖旧版本结论；下架后公开面消失、作者视角显式 hidden、旧 ETag 不得写回；导流话术在规则层被拦、且驳回不落库 |
| 代码锚点 | `services/api/src/routes/community.ts:234`（PATCH /posts/{id}）、`packages/moderation/rules.mjs:223`（COMMERCE_SOLICITATION 规则项） |
| 测试锚点 | `tests/unit/community-moderation-revision.test.mjs:32`（编辑生成新版本必须重新送审，新 job 绑定新 revision）、`tests/unit/community-moderation-revision.test.mjs:81`（新版本被驳回 ⇒ 编辑被拒、旧版本原样保留）、`tests/unit/community-moderation-takedown.test.mjs:153`（下架后列表/详情/引用一致，旧 ETag 不得写回公开）、`tests/unit/community-rules-coverage-http.test.mjs:53`（12 条改前可发布的违规原句全部被产品路径驳回且不进公开 feed）、`tests/unit/community-rules-coverage-http.test.mjs:85`（对照句仍可发布，证明不是一刀切）、`tests/unit/community-rules-coverage-http.test.mjs:105`（驳回不落库） |
| 还缺什么 | 无代码侧缺口；真实审核下这条仍只有替身读数（§5 硬阻断） |

### AC15-3 ·「游客／越权／重复点赞与评论引用隐藏版本检查通过」— 已实现且有测试钉住

| 项 | 内容 |
| --- | --- |
| 现状判定 | **已实现且有测试钉住**。游客/后台令牌/失效会话/越权统一错误封套且不泄露存在性；点赞幂等、重复不重复计数、取消后回落；评论点赞读取与帖子读取共用同一道可见性闸门；引用隐藏版本时不降级 |
| 代码锚点 | `services/api/src/routes/community.ts:313`（GET /posts/{id}/like）、`services/api/src/routes/community.ts:322`（PUT /posts/{id}/like） |
| 测试锚点 | `tests/unit/community-http.test.mjs:342`（HTTP 反例：游客/后台令牌/失效会话/越权，不泄露存在性、错误封套同形）、`tests/unit/community-like-read.test.mjs:53`（0 赞 / N 赞 / 同人重复点赞不重复计数 / 取消后回落）、`tests/unit/community-like-read.test.mjs:92`（getPostLike 的可见性闸门与 getPost 同一道）、`tests/unit/community-moderation-read-recheck.test.mjs:119`（台账里完全没有该版本任务 ⇒ 不降级） |
| 还缺什么 | 无代码侧缺口；真机（小程序侧）未验 |

### AC15-4 ·「列表、详情、收藏历史和消息均在读取时重查对象权限及当前可见性；隐藏／失效／注销不因缓存或旧链接重新公开」— 部分实现

| 项 | 内容 |
| --- | --- |
| 现状判定 | **部分实现**。列表、详情、消息都有「读取时重查」的用例（含负例：隐藏/删除/失效不因缓存或旧链接复活）；**「收藏历史」这一面今天没有帖子收藏**——收藏目标的枚举只有 species / herbicide / scheme，没有 post，所以「帖子收藏/历史」是否属 #15 属待裁定 |
| 代码锚点 | `services/api/src/community/moderation-link.ts:458`（读取面复算审核域结论的接线点）、`services/api/src/routes/favorites.ts:46`（收藏目标枚举只有 species / herbicide / scheme） |
| 测试锚点 | `tests/unit/community-http.test.mjs:507`（HTTP 读取时重查负例：隐藏/删除/失效不因缓存或旧链接复活）、`tests/unit/community-moderation-read-recheck.test.mjs:68`（已公开内容此后退回隔离 ⇒ 同样退出公开面，且不伪装成驳回）、`tests/unit/community-http.test.mjs:559`（投稿/评论/下架投递到消息域公开端口，同键不产生第二条） |
| 还缺什么 | 帖子收藏面不存在（是否属本 issue 待裁定 ②）；消息侧只钉到「事件已投递给公开端口」，未见消息中心读取侧与本 issue 的联调用例 |

## 4. 每帖 ≤3：今天在 main 上的实际形态（三道结构闸）

`#1030` 的修复已经合入 main，且**不是一处判断，而是三道闸串起来**：

| 闸 | 位置 | 形态 |
| --- | --- | --- |
| ① 旧字段数组 CHECK | `services/api/db/migrations/0022_community_persistence.sql:86-88` | `media_ids IS NULL OR coalesce(array_length(media_ids, 1), 0) <= 3`（旧帖仍以数组为准） |
| ② 帖子级挂载表 | `services/api/db/migrations/0056_post_media_attachments.sql:63-71` | 主键 (post_id, media_id) + `UNIQUE (post_id, ordinal)` + `CHECK (ordinal BETWEEN 1 AND 3)`；不回填，旧帖仍以 media_ids 为准（表头注释 `services/api/db/migrations/0056_post_media_attachments.sql:53-56`） |
| ③ HTTP 面机器码 | `services/api/src/routes/community.ts:81-86`（schema maxItems 3）、`services/api/src/routes/community.ts:214`（把闸挂到 preValidation）、`services/api/src/routes/community.ts:479-486`（rejectMediaIdsOverflow 抛 400 + `post_image_limit`） | 第 4 张在进业务前就被拒，错误 details 带机器码，前端可判 |

对应用例：`tests/unit/post-media-attachments.test.mjs:253`（迁移 0056 的约束逐行断言）、`tests/unit/post-media-attachments.test.mjs:228`（第 4 张 23514 ⇒ 400 + 整笔回滚）、`tests/unit/community-post-media-limit-code.test.mjs:82`（4 个 media_ids ⇒ 400，details[0] 逐字等于 { field: /media_ids, code: post_image_limit }）。

待用池口径（「已挂载/已删帖」即释放名额）在 `services/api/src/media/store-pg.ts:365-385`：在途态四值 + 24h 窗口 + `NOT EXISTS` 挂载 + 帖 `visibility <> 'deleted'`；表不存在时按 `services/api/src/media/store-pg.ts:382` 返回 `null`（继续 503），**不降级成 0**。

## 5. 阻断清单（今天还关不掉的原因，逐条给「谁提供」）

| # | 阻断项 | 谁提供 | 现状证据 | 仓库内能否自行补 |
| --- | --- | --- | --- | --- |
| B1 | **真实审核供应商凭据**（唯一硬阻断） | **用户**（`TENCENTCLOUD_*` 成对凭据 + BizType 核验 + 预算授权） | 出厂替身恒 `unsure` ⇒ 隔离 ⇒ `POST /posts` 恒 422 `INPUT_UNCERTAIN`：`services/api/src/moderation/provider.ts:42-51`；负控制用例 `tests/unit/community-moderation-negative-control.test.mjs:230`；接线要显式运维动作 `services/api/src/moderation/startup-approval.ts:46`，铸造点唯一在 `services/api/src/moderation/startup-approval.ts:270-274` | **不能。仓库内做不到，需用户提供**：没有真实凭据就没有一条经真实审核的帖子，AC15-1 与 #6 的「服务商适配真实核实」都卡在这里 |
| B2 | real + PG 的 **HTTP** 端到端 | 本项目（写手） | main 上的真库集成只有存储级：`tests/integration/post-media-attachments-pg.mjs:46-47` 直接 import 两个 PG store、`tests/integration/post-media-attachments-pg.mjs:176-177` 直接构造 store，全程不建 app ⇒ 不是 HTTP 面；未设库地址时按 `tests/integration/post-media-attachments-pg.mjs:38` 以 77 跳过 | 能。补 HTTP 版的真库用例即可，但**该文件目前不在 main**：`tests/integration/post-media-attach-http-pg.mjs` 只存在于本地分支 `feat/gy-r87-i30-http-e2e`（提交 `b0513fb4`，`git cat-file -e origin/main:tests/integration/post-media-attach-http-pg.mjs` 报 `fatal: path ... does not exist in 'origin/main'`，`origin/feat/gy-r87-i30-http-e2e` 不存在）⇒ 它的行号本页**一律不引**，只按「未合入」记 |
| B3 | 待用池 24h / state 的**行为级负控制** | 本项目（写手） | 今天只有 SQL **文本**正则：`tests/unit/post-media-attachments.test.mjs:563-566`（state 四值、`interval '24 hours'`、`NOT EXISTS`、`visibility <> 'deleted'` 各一条 assert.match）；`tests/unit/post-media-attachments.test.mjs:578-582` 只钉「表不存在 ⇒ null 不是 0」 | 能。缺的是「同一 owner 传满 3 张后第 4 张被拒、挂载后释放、24h 后释放」的真库行为断言（文本正则读不出这些） |
| B4 | 真实对象存储桶上的图片链路（用户侧） | 用户（桶与凭据） | 用例全部跑在替身对象存储上，例如 `tests/unit/media-http-upload.test.mjs:529` 如实标注替身；真实桶链路无读数 | 不能（需要用户侧桶与凭据） |
| B5 | 依赖未清 | 其他 issue | #6 → `#4`、`#29`；#15 → `#4 #5 #7 #14 #28 #29`。今天实测：`#4 #5 #7 #14 #28 #29` **全 OPEN**（`#2` 已 CLOSED，不再是 #6 的门） | 不能（要等这些 issue 自己推进） |

## 6. 待裁定（本页不替谁拍）

| # | 待裁定的问题 | 现状事实（可核对） |
| --- | --- | --- |
| ① | 「**上传取消**」入不入契约 | 媒体路由只有五条路径：`services/api/src/routes/media.ts:219`（POST /media/uploads）、`services/api/src/routes/media.ts:237`（POST /media/uploads/{id}/complete）、`services/api/src/routes/media.ts:261`（GET /media/{id}）、`services/api/src/routes/media.ts:279`（DELETE /media/{id}）、`services/api/src/routes/media.ts:299`（POST /media/{id}/access）。**没有 cancel 端点**；今天「取消」= DELETE 或 24h TTL 到期（`packages/media/constants.mjs:78`），用例把取消写成到期回收（`tests/unit/media-http-upload.test.mjs:399`）。要不要为「显式取消」新增契约动作与机器码，需要裁定 |
| ② | 帖子**收藏 / 历史**是否属于 #15 | 收藏目标枚举只有 species / herbicide / scheme（`services/api/src/routes/favorites.ts:46`），没有 post；因此 AC15-4 的「收藏历史」今天无法用帖子收藏来满足。（对照：`tests/unit/community-http.test.mjs:559` 只覆盖消息事件投递） |

## 7. 本页不声称什么

1. **不声称任何 AC 已由用户验收**：三档判定只描述「main 上有代码 / 有用例」，用户验收是另一道工序，本页没有它的读数。
2. **不声称真实审核链路可用**：真实审核供应商凭据未提供，B1 仍在；今天能跑通的是替身与显式合成端口。
3. **不声称真机或真实对象存储已验证**：所有媒体用例都在替身对象存储上；小程序侧未验。
4. **不声称可以关单**：本页不构成 #6 / #15 的关单依据，也不构成任何子项的关单依据。
5. **不把「代码在 main」等同于验收**：`#1030` 的修复（`6e7f7465`）、`#1057`（`da96c9b6`）合入只说明代码在树上；`#1030` 本身今天仍 OPEN。
6. **不声称在飞分支已验证**：`tests/integration/post-media-attach-http-pg.mjs` 只在本地分支，本页不引它的行号、也不把它的存在当作端到端证据。
7. **不声称读数能替代 CI**：本页的行号是快照，main 前进后必须重核。

## 8. 旧结论更正（对 20261107 索引页的过时段落）

对象是 `docs/verification/gy-r87-open-issue-acceptance-index-20261107.md`。**那张旧页本页不改**（另开工作处理），只在这里列出已被今天事实推翻的句子：

| 旧页位置 | 旧页原话（摘） | 今天的事实 |
| --- | --- | --- |
| L14 | 「`#1030` 的修复在两条在飞 PR 上，不在一处」…「两处都 `state=OPEN`」 | 两条都已合入 main：`#1037` squash `6e7f7465`（`2026-11-08 feat(media): real 模式社区图片改用帖子级挂载（每帖 ≤3 成为结构约束）`）、`#1057` squash `da96c9b6`（`2026-11-07 feat(community): return post_image_limit for over-limit posts`）；`gh pr view` 两条均 `MERGED`，`git merge-base --is-ancestor` 对两者均返回 0。**`#1030` 的 issue 本身仍 OPEN**（代码合入 ≠ 该 issue 已处置） |
| L29 | 「`#6` … 「每帖 ≤3」的 post-scoped 形态**不在 main**」，阻断类型记为「代码在飞」 | 已在 main，且是三道结构闸：`services/api/db/migrations/0056_post_media_attachments.sql:63-71`、`services/api/src/routes/community.ts:81-86`、`services/api/src/routes/community.ts:479-486` ⇒ 「代码在飞」这个阻断类型对 #6 已不成立；#6 剩下的阻断是 B1（真实凭据）与 B5（`#4` `#29`） |
| L37 | 「`#15` … 每帖上限**依赖 `#1030`**」 | 不再依赖在飞项：上限已在 main（同上三道闸），用例 `tests/unit/community-post-media-limit-code.test.mjs:82` 与 `tests/unit/post-media-attachments.test.mjs:228` 都在 main；#15 剩下的阻断是 B1 与 B5（`#4 #5 #7 #14 #28 #29`） |
| L47 | 「`#1030` … 两处修复在飞」「缺三件：同帖并发真库用例、`owner_id`/`state` 行为级负控制、real+PG HTTP 端到端」 | 前两件已有落点（`tests/integration/post-media-attachments-pg.mjs:46-47` 的真库臂、`tests/unit/post-media-attachments.test.mjs:563-566`）；**第三件仍未合入**（B2）。因此这三件今天的状态是「两件有落点、一件未合入」，不是「全在飞」 |
| L76 | 「不声称在飞 PR 已接线：`#1037`/`#1057`/… 均为 `state=OPEN`」 | 该条的前提已消失：`#1037` / `#1057` 均 `MERGED` 且已在 main 历史里。新的同类义务是「不声称未合入的 `feat/gy-r87-i30-http-e2e`（`b0513fb4`）已接线」，本页 §7 第 6 条承接 |

## 9. 复核方法与闸门读数

本页写完后的自检（工作树 `E:\GengYunCommander\.pg17\wt-r87-i06i15ac`，基线 `1f623228`）：

| 闸门 | 命令 | 读数 | 退出码 |
| --- | --- | --- | --- |
| 文档锚点 | `node tools/verify-doc-anchors.mjs --strict --symbol=strict --symbol-coverage=strict --symbol-coverage-verification=strict --scan docs` | 扫 427 份文档、抽出「路径:行号」引用 7695 条（解析成功 7460、同名多文件 225 不计红）；BROKEN 4 / OUT_OF_RANGE 1 / SUSPECT 43 / NOT_SYMBOL_LINE 8 = 56 条，与基线登记 56 条逐条命中、**基线外新增 0**；符号覆盖回归闸门：不在区间 44（=基线 44）、UNDECLARED 250（基线 265，未上升）、配成对 1121；末行 PASS | 0 |
| 契约台账 | `node tools/verify-contract-status.mjs` | 覆盖 130 条契约操作、已装配 130 条；implemented 19 / partial 111 / planned 0；形状错误 0、语义错误 0；证据锚点 593 条；中文表格一致 | 0 |
| 文档测试 | `npm run test:docs` | 「27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables」；研究记录 5 通过 / 0 失败 / 4 legacy 已钉住；docs/research 结构校验 PASS | 0 |

闸门对本页的处置（如实记）：本页初稿在 §4 有一处「只写行号区间、同块没有显式路径」的裸锚点，被 `BARE-ORPHAN` 判为「基线外新增 1 条」；改成带完整路径的 `services/api/db/migrations/0056_post_media_attachments.sql:53-56` 后复跑归零。**没有改基线文件、没有改 `tools/**`**。

行号复核方式（可复现）：`git -C <repo> show origin/main:<path>` 后用 `Select-Object -Skip N-1 -First M` 打印目标区间，逐行比对表里的断言——本页每条锚点都是这样核的。

