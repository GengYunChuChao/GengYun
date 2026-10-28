# 初版 HTTP、任务与隐私状态契约

契约 `1.0.0`，提案修订2（`x-proposal-revision=2`），GY-I01 待审。字段和路径以 [OpenAPI](../../packages/contracts/openapi.json)为机器入口；表及索引见[数据字典](data-dictionary.md)。以下是实施必须遵循的行为，不是已运行证据。

## HTTP 与身份

前缀 `/api/v1`，JSON snake_case，UUID 对象标识，UTC RFC3339 时间戳；地区存浙江行政区代码字符串，时区 Asia/Hong_Kong。省市县代码按资料版本校验，正则只能检查形状。游客仅 `GET /public/home`；微信登录与管理员登录为凭据交换入口，除此之外用户 API 需 userSession，后台需 adminSession，token audience 分离，不能互用。微信 code 单次交换，不信客户端 openid/owner/role；不强制手机号。

后台 scope：`sources:read/write`、`accounts:read/suspend`、`jobs:read/cancel`、`flags:read/write`、`audit:read`（斜线表示两个独立scope，例如sources:read与sources:write）；`session:read`/`session:logout`对所有有效管理员会话开放。主体身份与 scope 服务端核对；没有普通用户任意授予后台角色接口。首次管理员走 GY-I02 安全初始化；管理员账号停用和角色变更即时撤销后台会话。

用户 token 为可服务端撤销的不透明 bearer，不在 URL/日志记录；默认7日绝对有效期，注销/退出/停用即时失效，每请求核对账号状态和 auth_epoch，无自动永续续期。后台默认8小时绝对有效期。TLS必需，后台不把 token 持久存 localStorage；多会话登出仅撤当前会话，注销撤全部。刷新/续期如后续需要须改契约。

私有对象非本人统一404，与不存在同形，403只用于已认证但角色/用途不允许；对象列表服务端加 owner 条件。媒体 URL 仅短效授权访问句柄：**不能只依赖不可撤销的对象存储签名URL**，访问网关每次核对账号、授权、媒体和帖子当前版本；缓存 no-store，最大300秒。不返回桶路径或供应商原始引用。

成功包 `data + meta`，meta 包含 request_id、contract_version、execution_mode；失败包 `error + meta`，error 含 code、message、retryable、字段级 details（field/code，无敏感原文）。不以200包装失败。异步AI任务202返回 Job，媒体完成202返回Media并轮询其state；GET jobs 返回任务状态而非假成功结果。GET 条目带强 ETag `"<revision>"`；版本整数自1递增，PATCH/DELETE/取消以及OpenAPI标注的创建要求 `If-Match`，缺失428，不匹配409，不做 last-write-wins。引用创建通过必填target_ref.revision/media_revision/transcription_revision核对目标版本；不能只信ID。空档案GET仅三个档案字段为null、revision=1，首次PUT必须带该ETag，写入revision=2。

| HTTP | code 示例 | 客户端行为 |
| --- | --- | --- |
| 400 | INVALID_REQUEST / INVALID_CURSOR / IDEMPOTENCY_KEY_REQUIRED | 修复格式，不自动重试 |
| 401 | SESSION_REQUIRED / SESSION_EXPIRED | 保留本地输入，再登录 |
| 403 | SCOPE_DENIED / CONSENT_REQUIRED / ACCOUNT_INACTIVE | 补用途授权或停止，不能自动放行 |
| 404 | NOT_FOUND | 私有非本人同形；不透露目标是否存在 |
| 409 | REVISION_CONFLICT / IDEMPOTENCY_CONFLICT / OBJECT_UNAVAILABLE | 刷新当前版本并显式确认，不复用旧审核 |
| 413 / 415 | MEDIA_TOO_LARGE / MEDIA_TYPE_UNSUPPORTED | 重选或压缩，不能信文件扩展名 |
| 422 | CONDITIONS_INCOMPLETE / SOURCE_CONFLICT / INPUT_UNCERTAIN | 列缺项/冲突；无原文用量卡片 |
| 428 | REVISION_REQUIRED | 先读当前ETag |
| 429 | RATE_LIMITED / PROVIDER_QUOTA_EXCEEDED | Retry-After，用户/API与供应商额度分开 |
| 503 / 504 | PROVIDER_UNAVAILABLE / PROVIDER_TIMEOUT | 输入保留；可重试性依账本，不重试结果未知的计费调用 |

无结果是200的空列表或业务 `insufficient`；系统/供应商失败是错误或终态 failed/timed_out。语音无声/低质为 uncertain，不补造转写；回答资料不足为已完成的 insufficient 安全答复，危险拒答为 blocked，不混同供应商失败。

游标列表统一 `items + next_cursor`（null结束），limit默认20、最大50，排序 `(created_at DESC,id DESC)`；来源目录排序也用稳定键。游标服务端签名并绑定主体、过滤器、排序、版本水位及有效期15分钟，不能解析后信客户端 owner，错误400。每页重新验可见性，空页可有 next_cursor，客户端应继续；消息未读数量服务端聚合，不从当前页估计。

所有非 GET 写接口均要求 `Idempotency-Key`（8–128字符）；键域 `(environment,principal,audience,method,canonical_path,key)`，匿名登录以 code 摘要/管理员登录请求域限流。请求体 hash 与版本头一起记录；同键同内容/版本重放相同状态和对象ID，不重复计费；不同内容409；处理中409 `REQUEST_IN_PROGRESS` 带 Retry-After。普通记录24小时；账号删除/上传完成/供应商请求/消息事件的持久业务唯一键不随24小时过期失效。重放前重新验身份和权限，不重放旧可见正文；删除响应凭独立受限回执重放，不能借此复活账户。

## 媒体及 AI 任务

媒体 `initiated → uploaded → processing → ready`；任一非删除状态可 `rejected` 或 `deleting → deleted`。完成上传验证实际字节、哈希、魔数、解码与用途（不信mime），图片去EXIF后生成受控衍生件；初始化24小时未完成可过期回收。ready表示可处理，不等于公开。私有媒体可单条删除，引用内容即时隐藏并重审。

| 用途 | 接口限制 | 外发授权 |
| --- | --- | --- |
| weed_recognition / label_ocr | jpeg/png/webp，≤2MiB，输入以实际编码验 | media_processing + external_inference，并绑定接收方 |
| voice_question | mp3/wav/aac，≤10MiB，≤60秒，单声道录音候选格式 | recording + media_processing + external_inference；格式/采样率仍待GY-I25验证 |
| community_image | jpeg/png/webp，每张≤5MiB，每帖≤3张，无音频投稿 | media_processing + public_posting + external_inference；审核通过后当前帖版本可访问 |

用途必须同时满足相关 consent，不允许 voice_question 音频挂帖子，识别图用于发帖需显式新用途授权和新引用审核。上传 grant 为服务端受限访问网关授权，最长300秒、只写指定对象和限额，不能扩大为桶权限；公开附件复制不跳过用途和筛查。

任务枚举见 OpenAPI `JobState`：queued → running → succeeded / uncertain / failed / timed_out / cancelled。终态不可复活，重试产生新 job 并记录 retry_of；未知供应商结果进入 failed + PROVIDER_OUTCOME_UNKNOWN，不能自行二次付费。取消原子递增 revision，撤租约/外发且不回写；外部已受理只能记录取消请求并执行删除，不承诺供应商物理取消。

任务持久字段包含 entity_revision、input_hash、auth_epoch、consent_epoch、provider/model/prompt/rule版本、deadline_at、lease_token、lease_expires_at、attempt。worker 用行锁 `FOR UPDATE SKIP LOCKED` 领取，租约15秒、5秒心跳；自有可重试步骤最多3次（1/4/10秒退避加抖动）且受 deadline 限制。供应商最多一次未知结果调用；仅其明确幂等且有安全账本时有限重试。单识别/ASR/问答阶段硬截止30秒，语音录制60秒与处理30秒不同。

执行前、外发前、完成事务中重查账号 active、用途版本/接收方、删除标记、对象归属、entity_revision、lease_token、规则/来源状态。内容变更、撤回、注销、取消或下架后丢弃旧结果并安排供应商副本删除。outbox 与业务更新同事务，dispatcher消费去重键；不靠“先检查一次”防竞态。外发账本先记录 reserved，提交前仍需锁定/核对 epoch；注销/撤回提交后不可开始新外发，已经提交的外部请求视为在途并禁止回写。

Job 结果是按 kind 区分的 Recognition / OCR / Transcription / Answer / Synthesis / Moderation；queued/running/failed/cancelled 等无结果。succeeded/uncertain结果必须属于同一个 target_ref 和 revision。job可见结果再次投影检查，来源失效不返回历史可执行用量，审核原文仅作者可见。

## 识别、来源、问答与播报

Recognition 原始最多3候选和 model_score（不是安全概率），用户 selected_species_id 另存；缺候选/低质/覆盖外为 uncertain。OCR raw_fields 与 corrected_fields 分开且修订；登记核对 `matched / no_match / ambiguous / conflict / insufficient / unavailable`，必须登记号+全部可见成分/含量/剂型精确一致，缺字段为 insufficient而非matched，用户编辑不计模型准确率。登记匹配不证明实物真伪或适用性。

来源版本不可变，`source_kind=database/verified_seed/simulation` 描述数据取得方式，`evidence_kind=research/experience/mixed` 描述证据性质，`review_status` 另描述核对。药剂登记号与制剂（成分数组、原文含量单位、剂型、生产主体）独立；用量原文与适用条件、限制、单位、标签locator/hash一起保存。来源有效、当前可见、核对通过、制剂及作物/杂草/地区/生育期/种植方式/场景一致、无禁限用冲突才可输出 DoseCard；模拟、用户经验或仅AI通过不能产生卡片。限制规则缺失/过期按 unknown 拦截，不以缺少规则等于允许。

LLM只生成不含用量数字的说明，引用必须为本轮检索白名单；完整结构、来源、提示注入及风险检查后才能显示，不开放SSE。DoseCard仅确定性组件组装原文，必须同时提供conditions、method、precautions、unit_text、formulation_id、source_ref。ASR原转写保存，用户经PATCH confirmed_text明确确认；turn请求含 confirmed transcription ref 或直接文字，二选一，确认前不得问模型。会话条件只继承用户明确选择，不自动补足缺项。

TTS请求只接受服务器 checked_content_ref（答案/资料/用量卡片）与 revision，不接受自由文本；生成和播放时都重查来源/授权/可见性。同一页同一版本自动播报一次，离页/隐藏停止，取消录音丢弃临时文件并解绑监听；录音状态与播放状态由 GY-I11/13/26 客户端实现。播放成功不记为理解或已读；消息已读须单独操作。

## 社区与引用

### 已发布附件和作者头像读取

私有 `GET /media/{id}` 与 `POST /media/{id}/access` **仍仅owner可用**；后者If-Match仍指媒体revision，社区读者不能靠该接口读别人的媒体。新增公开内容上下文授权，避免把“媒体已上传”当作“媒体可公开”。

所有Post响应（创建、详情、列表、编辑）新增 `media: [{media_id,media_revision}]`，保留 `media_ids` 供作者编辑，已发布时两者同序同ID。公开media只包含当前帖子版本已审核、公开用途有效、ready且属于该作者的图片；私有/隐藏帖子投影为空，作者预览仍走私有接口。没有通过全部媒体检查的版本不得published，因此不得在公开响应偷偷省略未审图片然后继续公开正文。媒体变化须撤当前版本并重审，不能保留旧投影。

Author新增独立 `revision` 与 `avatar_media: {media_id,media_revision} | null`，原 `avatar_media_id` 与投影同步，无头像两者均null。头像只在可见的已发布帖子/评论上下文、头像独立筛查通过且公开用途有效时投影；来源为public_authors的当前头像revision，不是帖子revision。注销、撤回、头像替换或未审时返回默认头像/空投影，不能回传旧头像。此处只补现有可选头像的读取，不增加头像配置业务或强制采集。

作者与其他登录读者均可按以下链读取已发布附件；评论只有同类作者头像，不新增评论图片上传：

1. `GET /posts/{id}` 或列表取得Post.revision、media列表、Author.revision/avatar_media；评论头像从 `GET /comments/{id}` 或评论列表取得相同Author投影。例：帖子revision=7、图片media_revision=11、作者revision=5、头像media_revision=13，四者独立。
2. `POST /community/media-access`，userSession + Idempotency-Key + **If-Match: "7"（对应content_ref.revision）**。正文引用当前内容和实际媒体版本：`content_ref={type:post,id,revision:7}`、`media_ref={media_id,media_revision:11}`、`slot=attachment`、`author_revision=null`；头像slot=author_avatar，media_revision=13、author_revision=5。评论头像content_ref.type=comment，If-Match为该评论revision；父帖当前版本由服务端获取并绑定，不让客户端猜。
3. 返回CommunityMediaGrant：grant_id、与请求一致的内容/媒体/slot/author版本，以及 `access={url,expires_at,method:GET,access_token}`。最大300秒，URL路径为 `/api/v1/community/media/{grant_id}/content`，token不放URL；不返回桶地址或301/302裸存储跳转。
4. GET该url时同时携带当前userSession（Authorization）和 `X-Media-Access-Token`（返回的access_token）。服务器验真实签名/受控grant记录、绑定登录主体与session/auth epoch，逐次重新检查下列条件，返回已去EXIF二进制图片及Cache-Control:no-store。该图片成功响应是二进制而非JSON data/meta例外，X-Request-Id与X-Execution-Mode响应头保留请求/模式标记；错误仍返回JSON error/meta。授权不等于后续可无条件读取。

授权与每次取图均须核对：当前内容id/revision、published+approved、文字图片全部审核、slot属于该当前版本或当前作者头像、实际media_id/revision/ready/community_image用途、媒体作者关联、public_posting用途epoch、账号及删除清单。头像另验当前Author.revision、active、独立审核与公开授权；评论另验父帖当前revision/published。句柄绑定签发时这些版本与epoch以及请求者，不允许换人/换slot/换媒体复用。签发时版本不符409；不存在、非公开、用途失效、私有识别/问答媒体或slot无关联统一404。取图时版本/epoch/授权变化统一404（会话失效401），即使尚未到expires_at也拒绝；重放同幂等键也先重查，不能返回旧可用grant。

作者查看草稿可用原私有链，**草稿不能使用新社区链**。已下架、编辑重审、旧版附件、头像更换、注销去身份、撤回用途和被删媒体立即撤销旧grant；处理后的保留帖子只能重新投影已审核脱敏内容，不能从旧媒体ID或句柄恢复身份。私有识别图若显式新用途授权后供发帖，须形成新的community_image引用/衍生对象及本内容版本审核，原私有ID本身仍不可读。签名与服务器短期记录都必须支持上述即时撤销，不能只依赖过期。

### 关联资料的创建、读取和编辑

PostInput的 `linked_knowledge_ref` 收窄为KnowledgeTarget（species/herbicide/scheme），可为null。Post的四种响应统一**必含** `linked_knowledge_ref` 和 `linked_knowledge`：无关联两者null；有可用关联时前者是原目标type/id/revision，后者为 `{target_ref,reference_state:available,unavailable_reason:null,summary:{title}}`；不可用时仍保留同一target_ref，后者 `reference_state:unavailable,unavailable_reason:TARGET_UNAVAILABLE,summary:null`。

每次创建/读取/列表/编辑投影都核对目标类型、已保存版本与当前可见版本、来源有效性/审核、权限和下架状态。无来源、过期、版本已替换或不再可见统一不可用，不泄露目标曾有的标题、正文、图片、URL或用量；状态不透露“隐藏还是不存在”。有效summary只是公开标题，不含适用/用量结论，进入详情仍执行原资料/制剂/条件规则；关联不能作为推荐、安全或处方依据。

创建省略/null表示无关联；新增或替换关联必须为当前有权限、可用的目标，否则409 OBJECT_UNAVAILABLE（无权限/不存在统一404）。编辑省略字段保留旧关联，显式null解除；已有失效关联可原样保留供追溯，响应仍是不可用投影，不允许借此新增其他失效目标或恢复资格。改变引用仍生成新帖子版本、隐藏重审；创建先private/pending，编辑先hidden/pending，之后才可能经真实筛查发布。下游编辑页从Post.linked_knowledge_ref还原输入，不能从摘要猜目标或从旧缓存回填失效资料正文。

audit_state `pending → approved / rejected / quarantined`；content visibility独立为 private/published/hidden/deleted。只有当前 revision approved、文字图片全部完成、硬规则通过及用途有效才能同事务发布。AI超时/异常/不明为 quarantined，没有人审放行兜底。approved只说明AI筛查，不等于专业审核。编辑任何正文/标签/附件生成新 revision 并立即将公开视图hidden，再审后发布；旧快照不能继续作为当前帖子公开。

举报按持久 `(reporter,target_type,target_id,revision)` 去重，初版状态 received/isolated/closed，可按规则隔离但无人工票决。管理员可下架/停用，不能写 approved或直接发布。点赞唯一 `(user,target)`，取消同样幂等；只有当前已发布帖子/评论可点赞。评论自身审核外，还核对父帖可见；父帖隐藏、删除则评论和消息不公开。

收藏引用有 `available/unavailable`，不可见时返回最小目标ID、版本和失效原因，不携带旧正文或旧附件；历史为私有，可显示候选/失败状态，资料用量需最新守卫重新投影。消息只存事件类型与对象引用，不保存受限正文缩略；跳转时重验目标权限，注销作者展示已注销用户，未读按接收者归属。公共主页只能服务经审核的最小预览，不提供详情/私有媒体访问入口。

## 授权、撤回及注销

ConsentPurpose：recording/media_processing/external_inference/public_posting，首版无training。每条同意绑定 policy_version、接收方ID集合、purpose和 epoch；服务端使用隐私政策当前版本及已验证 Recipient，客户端不能创造接收方配置。系统权限允许录音不等于对外推理同意。撤回递增 purpose epoch、终止新外发与在途回写、取消关联任务、撤访问句柄并启动对象/第三方处理；公共用途撤回即时隐藏相关附件/内容，保留经处理文字与删除规则协调。主动单条删除不依赖注销。

注销请求202的返回在**同一事务**将账号改deletion_pending、撤所有用户会话/角色、auth_epoch递增、冻结外发与写入、插入删除请求和 outbox。受理成功后旧会话不再可调用 API，不能通过普通登录自动创建同openid的新账号绕过删除；完整删除完成后再注册须新的同意且不关联旧数据。

Deletion状态 `requested → processing → completed`，失败 `blocked` 可重试至 processing；`completed` 必须所有 module_handler 和第三方在线/备份证据均完成。回执查询使用专用 `deletionReceipt` bearer，绑定单请求、仅显示进度/期限/最小失败码、无账号和媒体信息，有效期35日；只存回执hash，不允许用户session代替。不能完成时显示blocked和逾期，不把时钟到期当完成。

在线截止受理时刻+7×24小时；备份截止+30×24小时（区别于二月观察日历规则）。对象handler区分用户身份/session/profile/媒体/问答/识别/收藏/消息/缓存/日志最小化、公开帖评去身份、对象存储衍生件、备份、供应商副本。每个第三方处理 `not_requested/requested/confirmed/failed/unsupported`，证据含受限确认索引和时间，requested绝不等于confirmed。

删除清单先在独立受控追加存储落 durable tombstone（opaque object refs、delete generation、范围、期限、处理证据），worker ACK前不丢任务。账户可识别映射在在线期限内删除；公开作者改随机注销引用，不能从日志/审计/外发账本反查。清单必要对象引用受限加密，权限与业务库分离，备份不覆盖该清单；每个备份有 lineage 和截至水位。恢复关闭入口与外发，加载比快照新的清单→删除身份/媒体/缓存并重播第三方待删→验证无复活→开流量，失败保持隔离。

> **边界（GY-I19 只记录事实、不改上面的语义；GY-R28 只订正时态，不改任何状态）**：
>
> **GY-I19 期间本仓不存在逐用户「备份副本」域**——`services/api/db/migrations/` 0001–0018（18 个迁移文件、54 处 `CREATE TABLE`，按 `schema.table` 限定名去重 54 张：`public` 49／`knowledge_staging` 2／`staging_intake` 2／`catalog_ops` 1）没有任何备份/快照副本表，也没有软删列（`deleted_at/is_deleted/purged` 唯一命中是 `0018_favorites_history.sql:36` 自述「物理删除、无软删」的注释，真实软删列 0）；当时唯一备份产物是 `deploy/postgres-cvm/backup-postgres.sh` 的**整库** `pg_dump -Fc`，其 30 天是备份文件保留期、**没有逐用户删除语义**（该脚本与 `deploy/postgres-cvm/README.md:459`、`runbook.md:540`、`verify-checklist.md:211`、`roles-and-migration.md:256-257` 都自认未实现）。普查证据见 [docs/verification/gy-i19-backup-domain-20261018.md](../verification/gy-i19-backup-domain-20261018.md)。
>
> **GY-R28 起该域已落地**：`services/api/db/migrations/0023_user_backup_copies.sql:34` 建 `public.user_backup_copies`（受理时按主体留最小清单行；`state = 'purged'` 必须在同一行同时满足 `purged_at`／`evidence_ref` 非空且 `payload = 'null'::jsonb`，见该文件 `:70-76` 的 `user_backup_copies_purged_evidence` 约束），`services/api/src/privacy/backup-copies-pg.ts:183` 的 `createPostgresBackupPurgePort({ pool, now })` 是真实端口（`:248` `kind: 'wired'`、`:249` `available: true`），`services/api/src/app.ts:1821`（装配点，原记 :1458-1465） 在「注销受理端口已接线 ＋ 有真库连接池」时装配它（显式注入优先；受理已接线但无真库且 `real` ⇒ 显式不可用端口；受理未接线或 stub/demo ⇒ 缺省 unwired，四态见 `services/api/src/app.ts:1813-1816`（原记 :1448-1457） 注释）。因此上面「备份证据／每个备份的 lineage 与截至水位」现在**有落点**；但**执行链仍未取得**：7 日在线／30 日备份的到期执行与调度、恢复清单重放、第三方删除证据均未验收，`real` 模式整域仍 503 `PROVIDER_UNAVAILABLE`，未接真库时各模块 `backup_state` 仍如实停留 `pending`、完成判定为 `blocked`，不以时钟到期或空集冒充完成。⛔ 本段**不是**「#19 已完成」。

首版训练关闭；未来实际启用前独立 ADR/同意/谱系和可控模型停部署、切换、7/30日权重删除、重训重验门槛，不能用本契约称已实现训练删除。已脱敏匿名统计可保留；合法最小证据留存须明确用途与期限，不能一概保留账号可逆映射。

## 审计事件的主体（actor）口径与已知缺口

本节只补「主体」这一面的事实与缺口，不改上面任何状态语义；引用一律写 `文件:行`，行号按基线逐字核对。

### 今天：主体信息落在哪几列

内部台账 `public.admin_audit_events` 没有独立的 role 列，主体信息由三组列表达：

| 列 | 语义 |
| --- | --- |
| `actor_id` | **谁做的**：发起该动作的后台会话所属管理员账号 uuid，`NOT NULL`（`services/api/db/migrations/0017_account_suspend_authority.sql:75`）。 |
| `scope` | **以什么权限做的**：该动作要求的后台 scope 字面量（`services/api/db/migrations/0017_account_suspend_authority.sql:77`）。 |
| `result` | **做成了没有**：`accepted`／`denied`／`failed` 闭集（`services/api/db/migrations/0017_account_suspend_authority.sql:83`）。 |
| `reason_code` | **为什么**：拒绝与失败必须落原因码（`services/api/db/migrations/0017_account_suspend_authority.sql:81`）。 |

### 契约层的已知缺口

契约 `components.schemas.AuditEvent` 的 8 个**必填**字段是 `id`／`action`／`scope`／`target_ref`／`reason_code`／`request_id`／`result`／`created_at`（`packages/contracts/openapi.json:16033`）——内核字段里**没有主体 actor**。R29-S5 之后 `actor` 只是**可选可空**属性（`packages/contracts/openapi.json:15989`）。因此：

- 不能把 `actor` 当必填字段依赖：缺它的审计事件仍然是合法契约事件；
- 内部台账的 `actor_id` 比契约多这一列，`projectAuditEvent()`（`services/api/src/admin/audit.ts:67`）是唯一契约出口、会把它剥掉，投影结果只含那 8 个字段；
- 这是**契约事实**，消除它要动 `packages/contracts/**` 与迁移，不在本文档范围内——本文档只把缺口写在明面上。

### 为什么不需要 role 列

审计要回答四件事：谁、以什么权限、做了什么、结果如何。前两问已分别由 `actor_id` 与 `scope` 回答——`scope` 本身就是权限字面量，`accounts:suspend` 与 `audit:read` 的差别就是权限差别；`result` 与 `reason_code` 补齐「做没做成、为什么」。再加一列 `actor_role`，只会把 `scope` 已有的信息换个更粗的粒度重存（角色包含多个 scope，而逐条审计要的正是细粒度那一层），且全仓没有消费者：`actor_role`／`actorRole` 在基线上 0 命中。所以本契约**不新增 role 列**，「谁以什么权限做的」继续由 `actor_id` ＋ `scope` ＋ `result`／`reason_code` 完整表达。
