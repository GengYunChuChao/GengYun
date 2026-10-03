# 初版数据字典与持久约束

契约 `1.0.0`，GY-I01待审；[API](../../packages/contracts/openapi.json)描述对外投影，[状态协议](state-contract.md)描述行为。下表为 GY-I02 初始迁移 `0001` 的输入，不是已建库证据。表名 snake_case；id UUID；revision positive integer；created_at/updated_at timestamptz；hash为SHA-256 hex；秘密使用安全配置/KMS，不把明文token放表或接口。

## 通用及关系

未注明字段 NOT NULL；`?`可空，不以空字符串/0替代未知。timestamp存UTC，region_code varchar(6)按版本化行政区表检查，crop/species为字典ID。numeric用于计分（0..1），剂量/含量用原文字符串和显式单位，**不转换或合并成可计算处方**。JSONB仅存不可变供应商受限结构、条件集合和对象引用，入库前按契约schema验证，不能代替关系和唯一约束。

每个私有根对象有 owner_id FK users 和 deletion_generation；归属通过服务端会话设置，API不接收 owner_id。公开post/comment作者用 author_ref FK public_authors；账号到作者的映射单独私有表，注销后删除，public_authors无可逆user引用。source/version/formulation关系用FK；当前版本使用指针，版本行不覆盖。业务删除不级联破坏受控证据或来源版本，但必须删除身份映射。

## 身份和权限

| 表 / 归属 | 字段与类型 | 约束、索引与删除 |
| --- | --- | --- |
| users / 自身 | id; wechat_subject_cipher text; wechat_subject_lookup bytea; state enum(active/suspended/deletion_pending/deleted); auth_epoch bigint; revision; nickname? varchar(40); avatar_media_id? uuid | unique subject_lookup（安全密钥HMAC）；不公开openid。注销清理cipher/lookup/昵称头像，pending期间不重建同主体；数据库FK不强制保留被删身份 |
| sessions / 用户 | id; user_id uuid; token_hash bytea; audience enum(user); auth_epoch bigint; expires_at timestamptz; revoked_at? timestamptz | unique token_hash，index(user_id,revoked_at)，会话只存hash；注销即时全撤并删除 |
| admin_accounts / 独立后台 | id; login_name varchar(80); credential_hash text; state enum(active/suspended); auth_epoch bigint; revision | unique login_name，安全初始化；与普通用户无自动角色映射，审计责任绑定 |
| admin_sessions / 后台 | id; admin_id uuid; token_hash bytea; audience enum(admin); auth_epoch; expires_at; revoked_at? | unique token_hash，独立token/audience；停用即时撤销 |
| admin_scopes / 后台 | admin_id; scope varchar(40); granted_by; granted_at; revoked_at? | unique(admin_id,scope)，范围按协议固定，不配置首版reviewer/expert/organization角色 |
| single_profiles / 用户 | user_id PK; crop_id varchar(40); region_code varchar(6); region_catalog_version varchar(40); revision | 每用户一行，FK crop/region，不存坐标/面积；历史保留条件快照，不随档案修改 |

## 资料、制剂和适用

| 表 / 归属 | 字段与类型 | 约束、索引与删除 |
| --- | --- | --- |
| crops / 资料 | id varchar(40); name varchar(80); active boolean | GY-I03导入四作物，未收集不编造覆盖 |
| species / 资料 | id varchar(40); canonical_name varchar(120); scientific_name? varchar(160); aliases jsonb; coverage_state varchar(20) | unique canonical_id；八组俗名映射规范物种，别名不构成精确制剂匹配 |
| regions / 资料 | code varchar(6) PK; parent_code?; name; catalog_version; supported boolean | composite unique(code,catalog_version)，仅浙江覆盖；地区和场景分列 |
| sources / 资料 | id; title; canonical_url text; publisher; source_kind enum(database/verified_seed/simulation); evidence_kind enum(research/experience/mixed); current_version_id; revision | URL必须核对可访问来源；不能凭模型造URL；source_kind不是专业review状态 |
| source_versions / 不可变 | id; source_id; version varchar(40); content_hash char(64); locator; retrieved_at; valid_from; valid_to?; validity enum(valid/expired/conflicting/unknown/withdrawn); review_status enum(unverified/verified/rejected); reviewed_by?; reviewed_at? | unique(source_id,version)，检查日期范围，index(source_id,validity)；审核责任/原文存受限证据，发布时不接受客户端自填verified |
| formulations / 资料 | id; registration_number varchar(80); producer; dosage_form varchar(80); ingredients jsonb [{name,content_text,unit_text}]; identity_hash char(64) | unique(registration_number,identity_hash)，至少一成分；保留浓度单位原文，复配是登记原产品数据，不允许生成混配方案 |
| registrations / 资料 | id; formulation_id; source_version_id; registered_name; registration_valid_from; registration_valid_to?; status enum(valid/expired/unknown/conflicting) | unique(formulation_id,source_version_id)，index(registration_number由formulations联接)；无可靠有效期视unknown |
| knowledge_versions / 不可变 | id; knowledge_id; revision; title; body; type enum(species/herbicide/scheme/static_region); source_version_id; crop_ids jsonb; species_ids jsonb; region_codes jsonb; visibility enum(private/published/hidden/deleted) | unique(knowledge_id,revision)，发布与来源有效性分别检查；更新资料并同步索引/缓存失效，不保存模拟用量 |
| applicability / 条件 | id; registration_id; source_version_id; crop_id; species_id; region_code; growth_stage; planting_method; use_scene; method_text; precautions_text; dose_text; unit_text; locator; content_hash | 所有原文用量条件非空才成卡片；unique(registration_id,source_version_id,conditions_hash)；生育期与条件原文保留，无自动剂量换算 |
| restriction_rules / 确定性 | id; source_version_id; rule_version; formulation_id?; crop_id?; species_id?; region_code; growth_stage?; use_scene?; effect enum(prohibited/restricted/unknown); reason; valid_from; valid_to? | index(region_code,formulation_id,valid_from)，限制条件缺失/过期返回unknown；不凭AI更改；规则来源不可缺失 |

查询用登记号/别名词典/结构化过滤，不用模糊药名直接匹配登记。DoseCard是 applicability + formulation + source_version 的只读投影，不保存LLM生成数值。具体药剂输出开关关闭时不产卡片，科普仍可用；检索引用只返回本轮有权限、有效的 source_version。

## 媒体与任务

| 表 / 归属 | 字段与类型 | 约束、索引与删除 |
| --- | --- | --- |
| media / 用户 | id; owner_id; purpose enum; mime; bytes bigint; duration_ms? int; sha256 char(64); state enum; failure_code?; object_ref_cipher text; revision; consent_epoch; expires_at? | 按用途大小/时长CHECK；index(owner_id,created_at,id)，私有对象路径不外露；删除含原始/EXIF去除衍生/缩略/合成音频 |
| media_derivatives / 用户 | id; media_id; derivative_kind; object_ref_cipher; hash; state | FK media，unique(media_id,kind,hash)，原始删除联动全部衍生；公开附件访问仍通过动态守卫 |
| jobs / 用户或后台 | id; owner_id?; actor_admin_id?; kind enum; target_type; target_id; entity_revision; state enum; revision; input_hash; auth_epoch; consent_epoch; deadline_at; lease_token?; lease_expires_at?; attempt int; retry_of?; provider_config_version?; error_code?; result_ref? | owner/admin恰一；index(state,deadline_at,lease_expires_at)，index(owner_id,created_at,id)；CHECK attempts≤3；CAS lease/revision，终态不可复活 |
| idempotency_records / 主体 | environment; principal_hash; audience; method; path; key; request_hash; if_match?; response_status; response_ref; expires_at | composite unique整个键域，不存response私有正文/token；重放重新授权；业务唯一键更长寿命另建约束 |
| outbox_events / 系统 | id; event_key; aggregate_type/id/revision; payload_minimal jsonb; created_at; published_at?; attempts | unique event_key；业务事务同写，消费方持久去重；注销清理payload身份，不能日志反查 |
| provider_invocations / 受限 | id; job_id; attempt; capability; provider_version; model_version; sdk_version; prompt_version?; rule_version; external_request_ref_cipher?; invocation_state; sent_at?; duration_ms?; usage?; export_id | unique(job_id,attempt)，index(export_id)，结果未知不自动重复计费；raw记录仅受控索引，删除在provider handler范围 |

## 识别与会话

| 表 / 归属 | 字段与类型 | 约束、索引与删除 |
| --- | --- | --- |
| recognitions / 用户 | id; owner_id; media_id; job_id; revision; model_version; candidates jsonb; uncertainty_reasons jsonb; selected_species_id?; selected_at? | 最大3候选；model原始不可覆写，选择另存；index(owner_id,created_at,id)，删除清理候选和媒体 |
| ocr_results / 用户 | id; owner_id; media_id; job_id; raw_fields jsonb; corrected_fields jsonb; revision; match_state enum; registration_ref?; compared_source_version? | raw与校正分开；匹配状态不等于识别成功；修改invalidate旧核对，不允许客户端写matched |
| transcriptions / 用户 | id; owner_id; media_id; job_id; raw_text; uncertain_spans jsonb; confirmed_text?; confirmed_at?; revision | confirmed必须用户明确操作；不自动发问，删除含音频和转写 |
| conversations / 用户 | id; owner_id; context jsonb(crop/region/species/stage/method/scene可选); revision | 只继承已确认条件，index(owner_id,created_at,id)；单条删除联动turns/jobs/export |
| turns / 用户 | id; conversation_id; owner_id; revision; input_text; transcription_id?; transcription_revision?; job_id; answer_id? | transcription引用需confirmed且同owner；只接一种输入，index(conversation_id,created_at,id) |
| answers / 用户 | id; turn_id; status enum(answered/insufficient/blocked); checked_text; check_state enum(passed/blocked); citation_refs jsonb; dose_card_refs jsonb; provider/prompt/rule_version; revision | 只有检查完成投影可见；citation白名单与有效性重查；失败未审正文不存入可读answer，删除清理所有 |
| synthesis / 用户 | id; owner_id; checked_target_type/id/revision; source_versions jsonb; job_id; media_id; revision | 无自由文本合成，朗读条件与单位完整；播放时重查引用和用途；非永久裸URL |

## 社区、收藏与消息

| 表 / 归属 | 字段与类型 | 约束、索引与删除 |
| --- | --- | --- |
| public_authors / 展示 | id; display_name; avatar_media_id?; avatar_media_revision?; avatar_audit_state enum; public_posting_epoch; state enum(active/anonymized); revision | 无openid/user FK；头像两字段同空/同有，替换递增作者revision并重审；未审/撤回/注销不投影头像。注销显示已注销用户+默认头像；随机逐作者注销引用，不共用一个主键 |
| author_links / 私有 | user_id; public_author_id | unique(user_id)，unique(public_author_id)，注销销毁映射；日志/审计不留逆向映射 |
| posts / 作者 | id; author_ref; current_revision; visibility; revision | index(visibility,created_at,id)，归属通过author_links；编辑即时hidden，注销脱敏处理后保留 |
| post_versions / 不可变 | post_id; revision; title; body; crop_id?; region_code?; linked_knowledge_ref? KnowledgeTarget(type/id/revision); audit_state; created_at | PK(post_id,revision)，index(linked_target_type/id/revision)用于失效；关联类型限定species/herbicide/scheme，新增/替换验当前权限/版本，原失效引用可原样保留。reference_state与summary逐次派生不存旧正文。展示AI筛查标签，不能专业标签；身份正文脱敏生成新版本，旧私有版本按删除策略清理 |
| content_media_refs / 作者 | target_type; target_id; content_revision; media_id; media_revision; purpose_epoch | unique(target_type,target_id,content_revision,media_id)，3张限制；revision是实际审核媒体版本，变化立即撤公开并重审。Post.media逐次派生版本投影，不能用content_revision代media_revision；当前revision筛查+用途+父对象可见性联动 |
| community_media_grants / 短期受控 | id; requester_id; session_ref; requester_auth_epoch; content_type/id/revision; slot enum(attachment/author_avatar); media_id/revision; author_ref/revision?; parent_post_id/revision; public_posting_epoch; content_owner_epoch; token_hash; expires_at; revoked_at? | token与同一登录主体/session绑定，hash存储；index(content_id,media_id,expires_at)，最多300秒，取图逐次查当前状态/删除清单，不能用公开投影放宽owner私有接口。只允许当前公开已审community_image；旧版本/下架/头像替换/注销即撤销，到期清理，注销处理纳入在线handler |
| comments / 作者 | id; post_id; author_ref; current_revision; visibility; revision | 父帖不可见时不可读，索引(post_id,created_at,id)，注销去身份 |
| comment_versions / 不可变 | comment_id; revision; body; audit_state | PK(comment_id,revision)，修改重审，不复用旧审核 |
| moderation_decisions / 系统 | id; target_type/id/revision; job_id; decision enum; reason_codes jsonb; checked_media_hashes jsonb; rule/prompt/model_version; hard_rule_passed boolean | unique(target_type,target_id,revision,job_id)，旧版本不能发布；失败quarantined；受限证据删除最小化 |
| likes / 用户 | user_id; target_type/id | unique(user_id,target_type,target_id)，取消物理删；隐藏目标不返回旧正文 |
| reports / 用户 | id; reporter_id; target_type/id/revision; reason_code; detail?; state enum(received/isolated/closed); revision | unique(reporter_id,target_type,target_id,target_revision)，状态只由规则/系统更新；无人工票决 |
| favorites / 用户 | id; user_id; target_type enum(species/herbicide/scheme); target_id; target_revision | unique(user_id,target_type,target_id)，无available缓存真值；读取重查来源/可见性，index(user_id,created_at,id) |
| recognition_history / 用户 | id; user_id; kind; recognition_id?; ocr_id?; task_state; context_snapshot jsonb; created_at | 恰一目标，index(user_id,created_at,id)；失败也显示，不推断实际用药；单条删除联动私有结果/外发 |
| messages / 用户 | id; recipient_id; type enum(comment/like/moderation/system); event_key; target_ref?; read_at?; revision; created_at | unique(recipient_id,event_key)，index(recipient_id,read_at,created_at,id)；不存隐藏正文预览；read和播放独立 |

## 授权、外发及删除

| 表 / 归属 | 字段与类型 | 约束、索引与删除 |
| --- | --- | --- |
| recipients / 管理 | id varchar(80); display_name; capability; policy_version; retention_online_days; retention_backup_days; no_training_verified; deletion_verified; enabled; config_version | 客户端只能选择当前已验证接收方；GY-I25验证后enabled；版本变化需重新同意和契约/评估影响审查 |
| consent_records / 用户 | id; user_id; purpose; policy_version; recipient_ids jsonb; state enum(granted/withdrawn); epoch; granted_at; withdrawn_at?; revision | unique(user_id,purpose,epoch)，当前epoch唯一，外发匹配准确recipient；训练不在首版enum |
| privacy_epochs / 用户 | user_id; purpose; current_epoch bigint; state; revision | PK(user_id,purpose)，撤回事务递增；worker发送与回写均核对 |
| exports / 受限用户 | id; user_id; object_type/id/revision; purpose; consent_id/epoch; recipient_id/config_version; state enum(reserved/sent/failed/outcome_unknown); requested_at; sent_at?; provider_request_ref_cipher?; deletion_state | 外发前记录，recipient/对象/用途/epoch可追踪；注销移除user逆向映射，仅受控删除对象opaque引用存清单 |
| deletion_requests / 独立回执 | id; receipt_hash; generation; state enum; requested_at; online_due_at; backup_due_at; revision; completed_at? | unique receipt_hash；查询无私有内容；截止不等完成；35日回执到期，不延长用户会话 |
| deletion_handlers / 受限 | request_id; module; object_ref_cipher; status enum(pending/running/completed/blocked); online_state; backup_state; evidence_ref?; error_code?; updated_at | unique(request_id,module,object_ref)，所有handler证据完成才完结；对象类型包括cache/derivative/session/backup等 |
| third_party_deletions / 受限 | request_id; recipient_id; export_ref; online_status enum; backup_status enum; requested_at?; confirmed_at?; evidence_ref?; error_code? | unique(request_id,recipient_id,export_ref)，confirmed要求证据；请求失败/不支持不写完成，截止风险可查 |
| deletion_tombstones / 独立受控清单 | opaque_object_ref; generation; scope; requested_at; deadline; lineage; signed_digest; acknowledged_at? | 追加、受限加密，不能被业务库恢复覆盖；不保留公开作者到账号的可逆映射；保留期至少覆盖所有30日备份和恢复演练，之后仅匿名执行证据 |
| backup_inventory / 运维 | backup_id; lineage; created_at; expires_at; deletion_watermark; verified_purged_at? | 当前最长30日，恢复须应用较新清单；备份延长需需求审查，不能默默延长 |
| audit_events / 后台 | id; actor_admin_id?; actor_pseudonym?; action; scope; target_type/id; target_revision; reason_code; request_id; result; created_at | 无token/密码/完整媒体/联系方式/用户话语；权限受audit:read，限时最小证据，清理可逆账号关系 |
| feature_flags / 后台 | key enum(submissions_enabled/specific_herbicide_output_enabled/ai_enabled); enabled; revision; changed_by; reason; changed_at | 开关只控制初版已授权功能，不能启用训练/人工/支付；收紧立即使缓存/任务失效 |

首版无训练样本/模型权重表，未来启用需独立谱系和删除handler；不能“预留通用功能开关”绕过业务授权。公开内容保留与私有对象删除分别执行，附件个人信息无法可靠清理时隐藏/移除，不为保留帖子保留原始媒体。

## 迁移、并发与读取投影

初始迁移需实现上述unique/FK/CHECK及enum；对多态target_ref用受控引用表或事务内验证与删除联动，不能依任意字符串绕过权限。来源版本、内容版本、decision和外发输入快照不可变；revision和epoch的CAS与outbox同事务。任务领取索引、各owner游标索引和全文/药名字典计划由GY-I02/03用EXPLAIN验证，当前无性能声称。

来源撤回/规则变化/帖子编辑事务递增version watermark、撤当前可见投影并写失效outbox；缓存key带版本但命中仍验当前水位，不靠过期时间泄露旧媒体。审计保留理由不允许存未脱敏私有原文。接口Response仅映射允许的字段，不能 `SELECT *` 串出密钥、openid、owner或原始供应商结果。

GY-I02需运行空库迁移、重复执行版本拒绝、约束负例与回滚演练；以后schema变更遵循ADR的expand/backfill/contract。删除与去身份不可用回滚恢复；迁移回滚失败则保持维护隔离并列阻塞。
