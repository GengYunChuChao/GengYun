# 迁移目录说明

本目录只放**正向迁移**（`NNNN_<name>.sql`）与 `rollback/NNNN_<name>.down.sql`。
机器可读的「保留号台账」在 `services/api/db/migration-reservations.json`；
`tools/verify-migrations-unique.mjs` 的 `[gap]` 判据要求缺号在**本目录的 `.md`** 里有一行依据。

## 当前状态（2026-10-28 · R68-A01 后台分类字典（`0049`）落盘后实测：`0001..0049`，缺 `0037`）

`0001..0035` 已连续落盘（35 个正向；`0035_r34_media_row_purge.sql` 已随上游真实落盘，本片旧段里那条
`WARN[gap] 0035` 的前提随之作废）；上游 #553（#19 片B）落 `0038_r34_deletion_receipt_persistence.sql`、
#22 片C 落 `0039_r34_deletion_state_cancelled.sql`、#538 落 `0036_r34_admin_content_persistence.sql`、
GY-R35（#568）落 `0040_export_object_key_contract_backfill.sql`、`#18` S2 片1 落
`0041_admin_scope_write_authority.sql`、GY-R37 片落
`0042_favorites_history_target_type_conversation_turn.sql`、`#18` R18 片落
`0043_admin_job_cancel_audit.sql`、GY-S4 P1 落 `0044_third_party_deletion_persistence.sql`、
S3 片 A 落 `0045_community_post_review_actor.sql`、`#18` S2 收尾片落
`0046_admin_scope_denial_trace.sql`、R64 落 `0047_admin_post_hide_audit.sql`、R68 落
`0048_admin_account_disable.sql`、R68-A01 落 `0049_admin_categories.sql`
⇒ 目录现为 **48 个正向 `.sql`** ＋ `rollback/` **47 个**（`0001` 无 down）；缺号只剩 `0037`，已登记在
`services/api/db/migration-reservations.json`（`count + 保留数 === max` ⇒ **48 + 1 === 49**），
`node tools/verify-migrations-unique.mjs --strict` 的 `[gap]` 判据对该缺号有依据（见下）。
（本段数字为实测：`Get-ChildItem services/api/db/migrations -Filter '*.sql'`
⇒ 正向 `.sql` 48 条、`rollback/` 47 条；缺号恰为 `0037` 且已登记保留。`0040`/`0041`/`0042` 均已真实落盘，
故保留台账里**不得**再出现 40/41/42 号条目 —— 否则 `reservedButPresent` 会把它判红。
`0043`/`0044`/`0045`/`0046`/`0047`/`0048`/`0049` 都是各自片自己落盘的文件，**台账同样不新增条目**。）
（2026-11-01 · R72 两片（`0050` R72-W2、`0051` R72-W41）落盘后复测：`0001..0051`，缺号仍只有 `0037`
⇒ 目录现为 **50 个正向 `.sql`** ＋ `rollback/` **49 个**（`0001` 无 down）；`count + 保留数 === max`
⇒ **50 + 1 === 51**。上一段那组 48/47 与 `48 + 1 === 49` 是 2026-10-28 的实测快照，**保留不动** ——
它记录的日期与当时事实都没错，写在这里只为说明「之后又落了两条」；`0050` 落盘时本文件没登记，
本次一并补上。）

（2026-11-02 · R72-W54(`0052`) 落盘后复测：`0001..0052`，缺号仍只有 `0037` ⇒ 目录现为 **51 个正向 `.sql`**
＋ `rollback/` **50 个**（`0001` 无 down）；`count + 保留数 === max` ⇒ **51 + 1 === 52**。上一段那组
50/49 与 `50 + 1 === 51` 是 2026-11-01 的实测快照，**保留不动**。）

（2026-11-02 · R72 #838(`0053`) 落盘后复测：`0001..0053`，缺号仍只有 `0037` ⇒ 目录现为 **52 个正向 `.sql`**
＋ `rollback/` **51 个**（`0001` 无 down）；`count + 保留数 === max` ⇒ **52 + 1 === 53**。上一段那组
51/50 与 `51 + 1 === 52` 是 2026-11-02 当天的实测快照，**保留不动**。）

（2026-11-03 · GY-R73(`0054`) 落盘后复测：`0001..0054`，缺号仍只有 `0037` ⇒ 目录现为 **53 个正向 `.sql`**
＋ `rollback/` **52 个**（`0001` 无 down）；`count + 保留数 === max` ⇒ **53 + 1 === 54**。上一段那组
52/51 与 `52 + 1 === 53` 是 2026-11-02 当天的实测快照，**保留不动**。本段实测口径：直接数目录得
正向 53 条、`rollback/` 52 条、最大号 `0054`、`0037` 不存在；`discoverMigrations()` 报 53 个文件、
末项 `0054_favorites_target_lookup.sql`。）

（2026-11-07 · GY-R83 合流后复测（`origin/main` @ `ca3b26f0` 的 `0055` 与本分支 `0056` **同时落盘**）：
`0001..0056`，缺号仍只有 `0037` ⇒ 目录现为 **55 个正向 `.sql`** ＋ `rollback/` **54 个**（`0001` 与 `0037` 无 down）；
`count + 保留数 === max` ⇒ **55 + 1 === 56**。上一段那组 54/53 与 `54 + 2 === 56` 是 2026-11-07
**合流前本分支单侧**的实测快照（当时 `0055` 由在飞的 `feat/gy-r83-provider-call-ledger` 让号、尚未落盘），
**保留不动**；更早的 53/52 与 52/51 同样保留。本段实测口径：直接数目录得正向 55 条、`rollback/` 54 条、
最大号 `0056`、缺号只有 `0037`；`discoverMigrations()` 同样报 55 个文件、末项 `0056_post_media_attachments.sql`。）

（2026-11-08 · GY-I19 `#19` 片1（注销去身份，`0057`）落盘后复测：
`0001..0057`，缺号仍只有 `0037` ⇒ 目录现为 **56 个正向 `.sql`** ＋ `rollback/` **55 个**（`0001` 与 `0037` 无 down）；
`count + 保留数 === max` ⇒ **56 + 1 === 57**。上一段那组 55/54 与 `55 + 1 === 56` 是 2026-11-07 GY-R83
合流后的实测快照，**保留不动**；更早的 54/53、53/52 同样保留。本段实测口径：直接数目录得正向 56 条、
`rollback/` 55 条、最大号 `0057`、缺号只有 `0037`；`discoverMigrations()` 同样报 56 个文件、末项
`0057_deidentify_account_on_deletion.sql`。）

- `0037` 预留：**#14** 人工复核（已裁定分配、尚无分支/文件；文件名待该片落定时核）。
- `0057_deidentify_account_on_deletion.sql`（GY-I19 `#19` 片1 · **注销去身份**：在**注销受理的同一事务**里把
  `public.users` 的四列 PII（`nickname` / `avatar_media_id` / `wechat_subject_cipher` / `wechat_subject_lookup`）
  与 `public.exports.provider_request_ref_cipher` 擦成 NULL）。
  新增 `public.deidentify_account(p_user_id uuid) RETURNS jsonb`，`LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog SET TimeZone = 'UTC'`，属主＝迁移管理员（运行时角色对 `users` 的
  `state` / `auth_epoch` / `revision` / 四列 PII **没有任何列权限**，只能经此函数擦）。
  函数对 `state` / `auth_epoch` / `revision` **一个字都不写**（202 里的 `accountRevision` 不许被去身份顶掉），
  只把 `deletion_generation` +1 作为「已擦除」的幂等读数；守卫：`p_user_id IS NULL` ⇒ `G0001`、
  查无此用户 ⇒ `G0002`、`state <> 'deletion_pending'` ⇒ `G0015`（active 用户一律拒，fail-closed）。
  只清 `exports.provider_request_ref_cipher` 一列：`recipient_id`（NOT NULL 证据链）与
  `object_key`／`object_id` 的 `0015` 双向 XOR 约束、以及无 PII 列的 `export_writebacks` **一律不动**。
  迁移内**零 GRANT**，只 `REVOKE ALL ON FUNCTION public.deidentify_account(uuid) FROM PUBLIC;`；
  EXECUTE 由 `deploy/postgres-cvm/sql/20-login-roles.sql` 的 `#region gy-i19-deidentify-grant` 单独授予
  `gengyun_api_runtime`，并由 `90-assert-least-privilege.sql` 的 `deidentify_function_*` 五条断言钉死。
  配对回滚 `rollback/0057_deidentify_account_on_deletion.down.sql`（只 `DROP FUNCTION`，已擦除的 PII 不恢复）。
- `0056_post_media_attachments.sql`（GY-R83 #1030 · **帖子级媒体挂载表**：把「real 模式每帖 ≤3 张图」从
  owner 生命周期累计的计数近似改成**结构约束**）。
  依赖 `0022_community_persistence.sql` 的 `public.community_posts`；**只建一张新表**，不改既有列/CHECK、
  不写数据、不改 `community_posts.media_ids` 的既有语义（它继续存**引用串**）。
  表体 `public.post_media_attachments(post_id uuid NOT NULL, media_id uuid NOT NULL, ordinal smallint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now())`，三条约束：
  `post_media_attachments_pkey PRIMARY KEY (post_id, media_id)`（同一张图不许在同一帖占两个号位）、
  `post_media_attachments_post_ordinal_key UNIQUE (post_id, ordinal)`（号位不重复）、
  `post_media_attachments_ordinal_range CHECK (ordinal BETWEEN 1 AND 3)`（另一道结构上限）。
  ⇒ 「每帖 ≤3」的**真实首拒点**是 `0022` 的 `community_posts_media_ids_max`（数组长度 ≤3，写
  `community_posts` 那一步就拒）；本表的唯一键 + CHECK 是**第二道结构约束**（绕过数组列直插挂载行时只剩它挡 ——
  `tests/integration/post-media-attachments-pg.mjs` 的直插探针专门钉这两条约束的**行为**，而不只是迁移文本）。
  两道都不依赖任何计数，也不需要清理器才能解锁（这正是 #1030 的缺口：
  累计口径会让用户传满 3 张后永久锁死，且「先数后写」有 TOCTOU 超发）。
  **两侧都不加外键**：`media_id` 不加（`0022` 明写 media_ids 是引用串、媒体域才是 uuid 权威；既有集成夹具
  `tests/integration/community-pg.mjs` 的 `postRecord()` 一直用随机 uuid），`post_id` 也不加
  （与 media 侧保持同一种悬空引用语义；删帖由 `visibility = 'deleted'` 状态机表达，不靠级联）。
  `community_posts` 侧删帖**不级联**，因此「删帖即释放」的读法按 `community_posts.visibility` 过滤实现。
  一条反查索引 `post_media_attachments_media_idx (media_id)`（待用池口径与「删帖释放」都按 media 反查）；
  `(post_id)` **不另建索引**（主键前缀已覆盖）。
  本迁移**零 GRANT**（与 0024/0026/0051/0054 同一纪律）：运行角色 `gengyun_api_runtime` 的最小权限写在
  `deploy/postgres-cvm/sql/20-login-roles.sql` 的社区域段——列级 `SELECT`／`INSERT` + **表级** `DELETE`
  （PG 无列级 DELETE：改稿要先 `DELETE … WHERE post_id = $1` 再重认领），**不授** `UPDATE`。
  配对回滚 `rollback/0056_post_media_attachments.down.sql`：`DROP TABLE IF EXISTS public.post_media_attachments;`
  （丢的是「谁挂了哪张图」的索引性事实，`community_posts.media_ids` 里的引用串仍在 ⇒ 回滚不让帖子丢图）。
  **运行期并发**：`claimPostMedia` 先按 `media_id` 升序取 `pg_advisory_xact_lock` 再认领（PK/UNIQUE 都**不跨帖**，
  兜不住「同一张图同时挂在两个存活帖」），本表约束是最后一道闸（23505/23514 ⇒ 既有 400 `post_image_limit`）。
  **不回填**（迁移不写数据）：既有帖只有 `media_ids`、没有挂载行，读路径仍以 `media_ids` 为准 ⇒ 旧帖显示不变；
  副作用是待用池口径（`countPendingCommunityImages`）把「迁移前上传、又挂到旧帖的 media」当未挂载，
  24h 窗口内占位、最多 24h 自愈。待用池有界：同一 owner 同时最多 **3** 张未挂载 `community_image`
  （上传侧 `post_image_limit` 先挡一道），挂载即释放、删帖也释放 —— 是上界，不是锁死。
- `0055_provider_call_ledger.sql`（GY-R83 #1003 · **库层记账**：识别链路**外发那一行**的用量与
  剖面版本 —— issue #1003 剩下的两条验收口径「`usage` 记账」「`provider_config_version` 落库」）。
  接在 `0054` 之后取号（本清单最新在前，故这一条排在 `0054` 条目**之上**），号位依据「正向最大号 +1」
  （`0037` 仍为 #14 保留 ⇒ **台账不新增条目**）。
  建 `public.provider_call_ledger`（`id uuid PK` / `domain text NOT NULL` 闭集 `('recognition')` /
  `job_id uuid NULL` **无外键** / `export_id uuid NOT NULL REFERENCES public.exports (id) ON DELETE CASCADE` /
  `attempt integer NOT NULL`（≥ 1）/ `capability varchar(40)` / `provider_config_version varchar(80) NOT NULL`
  / `model_version varchar(80) NULL`（两者同形状 `^[A-Za-z0-9][A-Za-z0-9._:/#+@-]{0,79}$`）/
  `invocation_state text NOT NULL` 闭集 `('sent','send_failed')` / `usage jsonb NULL`（必须是对象）/
  `sent_at timestamptz NULL` / `duration_ms integer NULL`（≥ 0）/ `created_at timestamptz NOT NULL DEFAULT now()`，
  `UNIQUE (export_id, attempt)` ＋ `provider_call_ledger_job_idx (job_id)`）。
  ⚠ **与 `0050` 的唯一形状差异**：本表两列版本串的字符类**多一个 `@`**（`[A-Za-z0-9._:/#+@-]`）。
  理由是本片的版本串格式就是 `` `${profile}#${model}@${sha256(hostname).slice(0,8)}` ``，分隔符就是 `@`；
  照抄 `0050` 的字符类会让**每一个**带主机摘要的串都被 `23514` 拒掉（`record()` 抛错 ⇒ 记账静默丢行）。
  两处必须同步：`services/api/src/recognitions/call-metadata.ts` 的 `CALL_VERSION_SHAPE`
  与 `tests/unit/recognitions-call-metadata.test.mjs`（有断言逐字比对正则来源）。
  **为什么另开一张表而不复用 `0050` 的 `provider_invocations`**：后者对运行时的写入权被三处文档明写
  「有意冻结」（`0050_provider_invocations.sql:106`、`90-assert-least-privilege.sql:2423`、
  `docs/architecture/ai-ops-spec-status.md:135` 的 N05）⇒ 默认部署下恒 `42501`，记不进也不报错
  （正是本片要修的静默缺口）；解冻那张表属**安全姿态变更**，不在本片范围。列名刻意与之同构
  （`job_id`/`attempt`/`capability`/`model_version`/`invocation_state`/`sent_at`/`duration_ms`/`usage`/
  `export_id`/`created_at`），日后解冻时是**并入**而不是重写。
  **为什么不给 `recognition_records` 加列**：那是识别终态行，与 `commitTerminal` 同事务 ⇒ 记账失败会让
  整笔终态回滚、作业卡 `running`；且只记得住成功终态，超时/HTTP 错那次已烧掉的 token 记不到。
  本表刻意**不进终态事务**：写入是 best-effort（`privacy/media-call-accounting.ts` 的
  `withProviderCallAccounting`，失败只留 `readings.failed` + 一条事件，绝不改判识别结果）。
  与 `0050` 的两处刻意差异：① `invocation_state` 闭集**没有** `blocked`（本表零外发路径不写行，
  没有写入者就不建值）；② 唯一性锚在**非空**的 `export_id` 上（`0050` 的 `(job_id, attempt)` 在
  `job_id` 为 NULL 时 PG 不做唯一性判定）。
  本迁移**零 GRANT**（与 `0024`/`0026`/`0050`/`0051` 同一条纪律），授权在
  `deploy/postgres-cvm/sql/20-login-roles.sql` 的 `gy-r83-provider-call-ledger-grant` 区
  （**独立 region**：既有 `gy-r71-jobs-ledger-grant` 区被 `tests/integration/egress-ledger-pg.mjs`
  按 `#region` 抽取并逐条断言「只含 `public.jobs` 的列级授权」，往里加表会让那条臂判红），
  分类/列面复述/零行探针在 `deploy/postgres-cvm/sql/90-assert-least-privilege.sql`
  （`domain_manifest` 的 `granted` 行 + `expected` 的独立列清单 + 一条 `SET LOCAL ROLE` 探针）。
  授权面就两句话：**写 11 列，读 2 列**（`export_id` / `attempt` —— 子查询的 `WHERE export_id`、
  `MAX(attempt)` 与 `RETURNING attempt` 的回读）。不授整行读权：写点写完不回读任何业务列，
  多授一列就是多一条本角色本不需要的读路径（`90-assert` 的读面探针只列这两列）。
  配对回滚 `rollback/0055_provider_call_ledger.down.sql` **同一事务内先 `count(*)` 再 `DROP`**：
  表里已有行 ⇒
  `RAISE EXCEPTION USING ERRCODE='G0019', MESSAGE='PROVIDER_CALL_LEDGER_ROLLBACK_BLOCKED'`
  （记账行是**已经付出的外发代价**的唯一结构记录，删表会留下「有账无据」），正确动作是**回滚应用版本**。
  没有提交中间态（预检与删表同一事务）；⚠ 但**未 `LOCK TABLE`**，所以「预检读空」到「`DROP` 拿到锁」
  之间仍可能插进一行随表一起消失 —— 这是有意的取舍（回滚是运维动作，不为此给生产表加排他锁）。
  读数：`tests/unit/recognitions-call-metadata.test.mjs`（usage 读音与版本串形状/降级）、
  `tests/unit/recognitions-usage-accounting.test.mjs`（sent / send_failed / 记账抛错不改判 / 非 real 零写，
  假 ledger、零网络）、`tests/unit/recognitions-ledger-composition.test.mjs`（**组合臂**：真
  `createMediaJobEgress` × 真 `withProviderCallAccounting` × 假 exports 账本，钉住「`export_id` 必须在
  **调用之前**取、`markSent` 之后按 `state='reserved'` 回查恒查不到」这条时序 —— 把取 id 改回调用之后，
  该臂立刻红）、`tests/integration/recognitions-provider-call-ledger-pg.mjs`（真库：表形状、
  `usage` jsonb、`UNIQUE(export_id,attempt)`、`export_id` 级联删除、未授权角色 42501）；真库臂需
  `*_PG_TEST_URL`，**本机无 PG，未跑**（该臂标题已改成「未接线（本机无 PG，未执行）」）。
  在 CI 中真正执行 0055 DDL / 授权面的是 `.github/workflows/deploy-sql-gate.yml`（`migrate.ts up` +
  `20-login-roles.sql` + `90-assert`，PG 17.11）；未验的是回滚件、`UNIQUE (export_id, attempt)`
  实际拦重复、`export_id` 级联删除。
- `0054_favorites_target_lookup.sql`（GY-R73 #17 · **反查索引**：「按被撤回/失效的收藏目标反查收藏者」的索引 ——
  后台撤回资料来源/条目后，要按对象找出「谁收藏过它」，才谈得上给这些人发失效通知）。
  接在 `0053` 之后取号（本清单最新在前，故这一条排在 `0053` 条目**之上**），号位依据「正向最大号 +1」
  （`0037` 仍为 #14 保留 ⇒ **台账不新增条目**；`services/api/db/migration-reservations.json` 的 `$comment` 里
  那条 0054 是**落盘前**的取号叙述 —— 0054 是真实落盘的号，不是保留号）。
  只建一条索引 `CREATE INDEX favorites_target_lookup_idx ON public.favorites (target_type, target_id, owner_id)`：
  本片唯一读法 `listOwnerIdsByTarget`（`services/api/src/favorites/store-pg.ts`，PG/内存两臂逐字同形）的谓词是
  `WHERE target_type = $1 AND target_id = $2 ORDER BY owner_id`，**不带 owner 前缀** ⇒ `0018` 的
  `favorites_owner_target_key (owner_id, target_type, target_id)` 与
  `favorites_owner_created_idx (owner_id, created_at DESC, id DESC)` 都命不中，没有本索引时它退化成整表
  `Seq Scan`——而这条扫描发生在一次真实的管理写请求里（撤回提交之后、响应返回之前），不该让后台操作的成本
  随全站收藏量线性增长。
  列序 `(target_type, target_id, owner_id)`：前两列等值 + `owner_id` 作索引尾列 ⇒ 查询的投影（只有
  `owner_id`）只扫索引不回表、`ORDER BY owner_id` 也顺尾列直接出序；**不造第二个唯一约束**——
  「同主体同目标只有一行」的权威仍是 `favorites_owner_target_key`，本索引形状表达不了该约束
  （尾列在等值列之后），硬造 UNIQUE 只会让同一事实出现两个真相、并把回滚面扩大。
  本迁移**零 GRANT**：不改表、不改列、不写数据、不建表，也不新增任何表级/列级权限；运行角色对
  `public.favorites` 的 `SELECT` 早已在 `deploy/postgres-cvm/sql/20-login-roles.sql` 授予
  （`favorites/store-pg.ts` 的读法一直按运行角色跑），本索引不新增任何可读面 ⇒ 本片 `deploy/**` 一个字未改，
  运行时的 `favorites` 授权面逐字未变。
  配对回滚 `rollback/0054_favorites_target_lookup.down.sql` 已同时落盘：`DROP INDEX IF EXISTS
  public.favorites_target_lookup_idx;`（只删本迁移加的那一个索引，不碰表与数据 —— 损失的是这条反查的性能，
  不损失任何事实）。
  读数：`tests/unit/admin-invalidation-notices.test.mjs` 的 R73-10（PGlite 臂，**本机**）按
  `0001 → 0018 → 0054` 顺序 apply 后查 `pg_indexes`，实测
  `indexdef = CREATE INDEX favorites_target_lookup_idx ON public.favorites USING btree (target_type, target_id, owner_id)`
  （`public.favorites` 当时共四条索引：`favorites_owner_created_idx` / `favorites_owner_target_key` /
  `favorites_pkey` / `favorites_target_lookup_idx`）；真库臂（`tests/integration/admin-audit-logs-pg.mjs` 的
  `schema_migrations` 末项 `0054` 断言）需 `*_PG_TEST_URL`，**本机无 PG，未跑**。
- `0053_admin_report_disposition_audit.sql`（R72 #838 · **审计落库**：后台举报处置
  `advanceReport` 的操作留痕。接在 `0052` 之后，号位依据「正向最大号 +1」（`0037` 仍为 #14 保留
  ⇒ **台账不新增条目**）。
  只建一个窄口径 `SECURITY DEFINER` 函数
  `public.record_admin_report_disposition_audit(p_actor_id uuid, p_report_id uuid, p_report_revision integer,
  p_action text, p_reason_code text, p_request_id uuid) RETURNS uuid`：函数内按 `p_action`
  （`triage`/`resolve`/`reject`）派生 `action = report.{triage|resolve|reject}` 与
  `reason_code = report_{triaged|resolved|rejected}`，两者不匹配即 `G0018 INVALID_REASON_CODE`；
  再核验操作者存在（否则 `G0002`）、`state = 'active'`（否则 `G0010`）、当前仍有效持
  `sources:write`（`admin_scope_grants` 里 `revoked_at IS NULL`，否则 `G0010`）；通过后往
  `public.admin_audit_events` 落一行：`scope = 'sources:write'`、`result = 'accepted'`、
  `target_ref = jsonb_build_object('type','report','id',p_report_id::text,'revision',p_report_revision)`
  （`0017` 的形状 CHECK 要求 type/id 为字符串且 revision 为数字），`request_id` 取
  `AdminCallContext.requestId`（缺失时由 `resolveContext` 生成 uuid）。
  为什么需要：举报处置只改 `community_reports.state/revision`，`closed` 一值两义（成立/驳回不可分），
  审计面 0 行；本迁移让「谁、以什么动作、在第几版上处置」与举报行**同一次事务**落库。
  调用点在 `services/api/src/community/store-pg.ts` 的 `commitReport`（`withTransaction` 内、
  `UPDATE community_reports` 之后），失败即抛 `PROVIDER_UNAVAILABLE` 让整个处置回滚。
  本迁移**零表级 GRANT**：函数 `REVOKE ALL … FROM PUBLIC`，运行时 `EXECUTE` 只在
  `deploy/postgres-cvm/sql/20-login-roles.sql` 的 `gy-r72-report-disposition-audit-grant` 区授予
  `gengyun_api_runtime`；`public.admin_audit_events` 对运行时仍是零表级/零列级权限。
  配对回滚 `rollback/0053_admin_report_disposition_audit.down.sql`：先数 `admin_audit_events` 里
  `action LIKE 'report.%'` 的行，有任何一行即 `G0019 REPORT_DISPOSITION_AUDIT_ROLLBACK_BLOCKED`
  并列出样本（审计是证据、不是可重算派生值），空表才 `DROP FUNCTION`。
  读数：`tests/unit/community-report-disposition-http.test.mjs`（HTTP 面，**本机**）＋
  `tests/integration/admin-audit-logs-pg.mjs` 等真库臂（需 `*_PG_TEST_URL`，**本机无 PG，未跑**）。
- `0052_moderation_conclusion_facts.sql`（R72-W54 · **只读事实源**：审核**结论新鲜度**跨重启的事实面 ——
  本片让 `readView` 在内存台账为空（重启后）时还能判出 `RESCREEN_REQUIRED`，**⛔ 不改任何可见性判定**）。
  接在 `0051` 之后，号位依据「正向最大号 +1」（`0037` 仍为 #14 保留 ⇒ **台账不新增条目**）。
  加一列 `public.moderation_decisions.concluded_at timestamptz NULL` ＋ 索引
  `moderation_decisions_target_concluded_idx (target_type, target_id, target_revision, concluded_at DESC)`
  ＋ 一次性回填 `SET concluded_at = updated_at WHERE decision = 'approved' AND concluded_at IS NULL`。
  为什么需要：`services/api/src/moderation/service.ts` 的 `staleReasons` 原先只由 `ledger.forRevision()`
  （**内存**）派生，而 `moderation/ledger-pg.ts` 的 W43 决策是「任务结论不回填」⇒ 重启后该列表恒空、
  `RESCREEN_REQUIRED` 永不触发。本迁移提供**可跨进程读回**的「已结案时刻 + 当时三条版本」，
  `updated_at` 作 `concluded_at` 的近似口径（存量行无法区分「结论时刻」与「最后一次写」）。
  读面只有一条：`services/api/src/moderation/conclusion-facts-pg.ts` 的
  `CONCLUSION_FACTS_SQL`（`SELECT content_kind, decision, rule_version, model_version, prompt_version,
  COALESCE(concluded_at, updated_at)` + 谓词列，`superseded = FALSE AND decision = 'approved'`，`LIMIT 30`）。
  本迁移**零 GRANT**（与 `0024`/`0026`/`0051` 同一条纪律），列级 `SELECT` 12 列授权在
  `deploy/postgres-cvm/sql/20-login-roles.sql` 的段 M3（`gy-r29-moderation-ledger-grant`）；
  90-assert 三处复述同步（分类清单不动、`expected` 的 `sel` 12 列、`r28_probe_mod_dec_sel` 零行探针）。
  配对回滚 `rollback/0052_moderation_conclusion_facts.down.sql`：先 `DROP INDEX IF EXISTS`、再
  `DROP COLUMN IF EXISTS concluded_at`（可重算派生值、不是证据 ⇒ 不用 G 码预检）；回滚后端口因缺列
  返回空数组并记一次 `warn`，行为退回「只按内存判」。
- `0051_moderation_idempotency.sql`（R72-W41 · **库层基础设施**：审核域取消的**持久幂等台账**
  —— 本片只落「表 + 列级授权 + store + 测试」，**不改任何运行行为**，接线在 W42）。接在 `0050`
  之后，号位依据「正向最大号 +1」（`0037` 仍为 #14 保留 ⇒ **台账不新增条目**）。
  建 `public.moderation_idempotency`（`scope varchar(200)` / `key_hash varchar(128)` /
  `request_hash varchar(128)` / `payload jsonb` / `pending boolean` / `expires_at timestamptz`，
  `PRIMARY KEY (scope, key_hash)`），列/约束/主键与 `0026` 的 `speech_idempotency`（`:137-152`）、
  `0024` 的 `ocr_idempotency` **逐字同形**（只换表名与索引名 `moderation_idempotency_expires_idx`）。
  为什么需要：审核域取消**要求** `Idempotency-Key` 却从不回放（`services/api/src/moderation/service.ts:1187`
  只做形状校验），缺口成文登记在 `docs/verification/gy-r71-job-cancel-modes-20261030.md:67`
  （原文「本域没有幂等台账；要回放要么内存表（重启即丢）、要么加迁移和列」）。
  过期语义两处都在服务层：`purgeIdempotent` 物理 `DELETE … WHERE expires_at <= $1`；claim 的
  `ON CONFLICT … DO UPDATE … WHERE expires_at <= $7` 就地重占过期行（不先删再插 —— 那在并发下会让
  两个同键请求都判定「不存在」而同时执行副作用）。
  本迁移**零 GRANT**（与 `0024`/`0026` 同一条纪律），授权在
  `deploy/postgres-cvm/sql/20-login-roles.sql` 的 `gy-r72-moderation-idempotency-grant` 区
  （`SELECT`/`INSERT` 六列、`UPDATE` 四列），`DELETE` 单独在 `gy-r72-moderation-idempotency-delete` 区
  （PG 没有列级 DELETE，而列级区必须只含列级授权）。
  配对回滚 `rollback/0051_moderation_idempotency.down.sql`：纯新增 ⇒ `DROP TABLE IF EXISTS` 整表拆除
  （索引随表消失）；⚠ 回滚会让同键重放重新执行副作用，正确顺序是先回滚到不使用该 store 的应用版本。
  读数：`tests/unit/moderation-idempotency-store.test.mjs`（内存 M1–M6 + PG 缺表 fail-closed）
  ＋ `tests/integration/moderation-ledger-pg.mjs` 的新增真库臂一节（CI 跑；本机 `pg_ctl` 绑不上
  `127.0.0.1`，如实登记「本机不可跑」）。
- `0050_provider_invocations.sql`（R72-W2 · **库层写通路**：每一次**真实外发**一行的调用记录）。
  接在 `0049` 之后，号位依据「正向最大号 +1」（`0037` 仍为 #14 保留 ⇒ **台账不新增条目**）。
  字段口径逐字照 `docs/architecture/data-dictionary.md:48` 那一行（`id uuid PK` / `job_id uuid NULL`
  **无外键** / `attempt` / `capability` / `provider_version`·`model_version`·`sdk_version`·`prompt_version`·
  `rule_version`（本片无单一真源者留 `NULL`，⛔ 不填占位串）/ `external_request_ref_cipher`（⛔ 不收明文）/
  `invocation_state` 闭集 / `sent_at`（外发**进入**时刻）/ `duration_ms` / `usage jsonb` /
  `export_id uuid NOT NULL REFERENCES public.exports (id) ON DELETE CASCADE`），另加字典没列的
  `created_at`（**落库**时刻；`sent_at` 是外发时刻，两者不是同一个量，⛔ 不拿前者兼职）。
  唯一写入原语是 `services/api/src/privacy/ledger-pg.ts:301` 的 `recordInvocation`（序号由
  `SELECT COALESCE(MAX(attempt), 0) + 1 … WHERE export_id=$1` 派生，`:946`），写点在
  `services/api/src/privacy/task-egress.ts`（`ChatEgress.send`，`:345` 是文件内唯一写点；
  没发生外发的路径**不写**该表）；读面只有 `PostgresExportLedger.listInvocations`，
  ⛔ 本片不开 HTTP 读面（没有 operation、没有契约）。
  授权**不在** `20-login-roles.sql`：走组角色 `services/api/db/roles/egress_ledger.sql:59-68`
  （`to_regclass('public.provider_invocations') IS NULL` 时 `RAISE NOTICE 'skip provider_invocations
  grants'` 并跳过 ⇒ `0049`/`0050` 跨版本部署不互卡），列级 `SELECT` 16 列 + `INSERT` 14 列
  给 `gengyun_egress_ledger`。
  配对回滚 `rollback/0050_provider_invocations.down.sql` **先预检再删表**：表里已有行 ⇒
  `RAISE EXCEPTION USING ERRCODE='G0019', MESSAGE='PROVIDER_INVOCATIONS_ROLLBACK_BLOCKED'`
  （调用记录是计费/重试判据，删表会留下「有账无据」），正确动作是**回滚应用版本**。
- `0049_admin_categories.sql`（R68-A01 · **库层读写通路**：后台「分类字典」读列表 / 改显示与停用
  —— `listAdminCategories` / `editCategory`）。接在 `0048` 之后，号位依据「正向最大号 +1」
  （`0048` 已被 R68 的后台账号停用/恢复占用；`0037` 仍为 #14 保留 ⇒ **台账不新增条目**）。
  建 `public.admin_categories`（`id varchar(80) PK` / `type varchar(16)` / `name varchar(120)` /
  `description text` / `active boolean` / `revision integer` / `created_at` / `updated_at`），
  列一律 `ADD COLUMN IF NOT EXISTS` + 默认值 ⇒ **幂等可重放**；四条 CHECK（type 闭集 `crop|species`、
  name 1..120、description 1..2000、revision ≥ 1）先查 `pg_constraint` 再 `ADD CONSTRAINT`。
  从 `public.crops`（type=`crop`）与 `public.species`（type=`species`，名取 `canonical_name`）
  `ON CONFLICT (id) DO NOTHING` 回填；`description` 回填**明标「未编撰」的占位句**（契约 `Category.description`
  是 minLength 1，空串是违法值，所以不能留空、也不许假装编好了）。
  ⚠ **为什么不给 `crops`/`species` 加列**（本片最容易被问的一处，理由三条）：① CAS 必须在应用层做
  （派单要求断言 `UPDATE … WHERE id = $1 AND revision = $2`）⇒ 运行时要有这两张表的列级 UPDATE 直授，
  而 `90-assert-least-privilege.sql` 的 `external_violations` (c) 明令「非 `direct` 行不得有直授 runtime 的
  表级/列级 ACL」，这两张表在 `external_manifest` 里是 `profile_runtime` 组继承行；② 唯一合规替代路
  `services/api/db/roles/profile_runtime.sql:21-23` 逐字写着「Only name is granted for locking…
  **The HTTP component has no directory mutation endpoint.**」；
  ③ `crops.name` 是 `varchar(80)`（契约 `name` 上限 120）、`species.canonical_name` 带唯一索引且是**识别键**
  （改它等于改识别身份，与契约「不由编辑名称扩大识别承诺」冲突）。故另立后台目录表，`crops`/`species`
  一个字节都不动。
  审计走窄口径 `SECURITY DEFINER` 函数 `public.record_admin_category_update(uuid,text,integer,uuid)`
  （`SET search_path = pg_catalog` + `SET TimeZone = 'UTC'` + `REVOKE ALL … FROM PUBLIC`）：
  `action='category.update'` / `scope='sources:write'` / `result='accepted'` / `reason_code='category_updated'`
  由函数体**字面量**固定，`target_ref=NULL`（契约 `TargetRef.type` 闭集里没有 `category`）、
  `target_hint='category:<id>'`；入参自检「actor 在 `admin_accounts` 且持 `sources:write` 未撤销」，
  并核对「审计里的 revision 必须等于库内现值」（防拿旧 revision 写审计）。运行时对
  `public.admin_audit_events` 仍是**零表级权限**，只有这条函数的 EXECUTE。
  授权在 `deploy/postgres-cvm/sql/20-login-roles.sql` 的 `gy-r68-catalog-grant` 段：`SELECT` 6 列 +
  `UPDATE` 5 列（**无 INSERT、无 DELETE/TRUNCATE/REFERENCES/TRIGGER、无表级 DML**）。
  配对回滚 `rollback/0049_admin_categories.down.sql` **先预检再删表**：`admin_audit_events` 里已有
  `action='category.update'` 行、或 `admin_categories.revision > 1` 的行 ⇒ `RAISE EXCEPTION 'G0019'`
  （理由与 `0043`/`0047` 同源：删表会留下「有行无出处」，且回填数据带不走），正确动作是**回滚应用版本**。
  读数：`tests/unit/admin-categories-pg-wiring.test.mjs`（8 条：CAS 语句字面量、参数顺序、语句序列
  `BEGIN→CAS→审计→COMMIT` / 落空 `BEGIN→CAS→currentRevision→ROLLBACK`、三臂 200/409/503、
  无池 503 `retryable:false`、stub 走内存、外壳默认 reject）＋ `tests/unit/sql-column-coverage.test.mjs`
  （新 SQL 宿主纳管后逐列核对，缺口 0）。
- `0048_admin_account_disable.sql`（R68 · **库层写通路**：后台「停用 / 恢复管理员账号」）。
  接在 `0047` 之后，号位依据「正向最大号 +1」（`0047` 已被 R64 的后台下架审计占用，裁定书里那张
  「编号与排序（2026-10-27 10:1x 复核后更正）」小节即为此；`0037` 仍为 #14 保留 ⇒ **台账不新增条目**）。
  建两条窄口径 `SECURITY DEFINER` 函数：`public.disable_admin_account(uuid,uuid,uuid,integer,uuid,text)`
  与 `public.enable_admin_account(同形)`（`SET search_path = pg_catalog` + `SET TimeZone = 'UTC'` +
  `REVOKE ALL … FROM PUBLIC`）。**锁序**先拿 `0041` 同一把事务级
  `pg_advisory_xact_lock(hashtextextended('admin_scope:' || p_scope, 18040))`（`scopes:write`），
  再对 `public.admin_accounts` 的目标行 `FOR UPDATE` —— 与 `0041` 的 grant/revoke 是**同一把**锁，
  所以「停用最后一个 scope 管理者」与「撤掉最后一个 scope 管理者」不会以不同顺序交错。
  停用写 `state='suspended'` + `auth_epoch = auth_epoch + 1` + `revision = revision + 1`（CAS：
  `p_expected_revision` 与现行 `revision` 不等即 `G0003 REVISION_CONFLICT`），并**同事务**把
  `public.admin_sessions` 里 `admin_id = 目标 AND revoked_at IS NULL` 的行置 `revoked_at = now()`
  ⇒ 旧 token 下一次请求就撞 `admin_sessions.revoked_at`，401（不是 403）。审计**同事务**写
  `public.admin_audit_events`，`action` 固定 `admin_account.disable` / `admin_account.enable`、
  `before_value`/`after_value` **必须 NULL**、`target_ref` 由形参重建，`reason_code` 走两值闭集。
  守卫：停用自己 ⇒ `G0020 SELF_DISABLE_DENIED`（409）；停用**唯一**持有效 `scopes:write` 的管理员 ⇒
  与 `0041` **同一个** `G0009`（业务码 `LAST_SCOPE_MANAGER` / 409）。
  ⚠ 本片**不动** `0017` 的 `suspend_account`/`restore_account`（终端用户面），也不给运行时任何
  `admin_accounts` / `admin_sessions` 的 UPDATE 列权 —— 两条函数是唯一写路径。
  配对回滚 `rollback/0048_admin_account_disable.down.sql` **只 `DROP FUNCTION IF EXISTS`**，
  ⛔ 不删审计行（append-only 台账带不走，删函数会留下「有行无出处」）。
  读数：`tests/integration/admin-accounts-read-pg.mjs` 的 `[S]` 段（真库臂追加，不新建文件）＋
  `tests/integration/admin-http.mjs` 的停用/恢复 HTTP 臂（停用后旧 token `GET /admin/auth/session`
  ⇒ 401 `ACCOUNT_INACTIVE`）。
- `0047_admin_post_hide_audit.sql`（R64 · **库层写通路**：后台「隐藏帖子」（`post.hide`）的审计从**进程内存**
  落到 `public.admin_audit_events`）接在 `0046` 之后，号位依据「正向最大号 +1」（当时最大 `0046`；
  `0037` 仍为 #14 保留 ⇒ **台账不新增条目**）。只建一条窄口径 `SECURITY DEFINER` 函数
  `public.record_admin_post_hide_audit(uuid,uuid,integer,text,uuid)`（固定 `search_path = pg_catalog`）：
  `action='post.hide'` / `scope='sources:write'` / `result='accepted'` 与 `reason_code` 由函数体**字面量**固定
  （调用方伪造不了），`target_ref` 由形参重建为 `{type:'post', id, revision:<**下架前** revision>}`、
  `target_hint=NULL`；入参自检「actor 在 `admin_accounts` 且持 `sources:write` 未撤销」，否则 `G0010 SCOPE_DENIED`。
  调用点**只有一处**：`services/api/src/community/store-pg.ts` 的 `commitPost`，SQL 是字面量
  `SELECT public.record_admin_post_hide_audit($1..$5)`（`COMMUNITY_POST_SQL.hideAudit`，无 `FROM`、
  不走调用方拼串），且**与下架同一事务**（`withTransaction` 内）⇒ 审计写不进去连帖子一起 `ROLLBACK`、
  客户端拿 503（**fail-closed**；⛔ 不存在「200 + 已隐藏 + 审计 0 行」那种静默丢参结局）。
  ⚠ 本片**不动读面闭集**：`services/api/src/admin/audit/catalog.ts` 的 `AUDIT_ACTIONS` 与
  `packages/contracts/openapi.json` 的 `?action=` enum 仍只有原四值（那两个文件正被在飞 `#652` 修改），
  所以 `GET /admin/audit-logs` 按 `action=post.hide` 过滤仍按旧闭集拒绝 —— **读面放开留给下一片**；
  但「能查」的既有库内函数 `list_admin_audit_logs(...)`（0033）现在**确实**查得到这一行（不带 `action`
  过滤时），这正是本片的 `[A2]` 读数。
  配对回滚 `rollback/0047_admin_post_hide_audit.down.sql` **先预检再删函数**：`admin_audit_events` 里已有
  `action='post.hide'` 行即 `RAISE EXCEPTION 'G0019'` 中止（理由与 `0043` 同源：删函数会留下「有行无出处」，
  而应用侧仍在调用它 ⇒ 每次隐藏都会 503；且审计台账 append-only 也带不走那些行），
  正确动作是**回滚应用版本**。
  读数：`tests/integration/admin-post-hide-audit-pg.mjs`（专用真库臂：成功恰 1 条真行 / 触发器挡审计 ⇒ 503
  且帖子零变化 / 拆触发器恢复 200 / 已隐藏再隐藏幂等不增条）＋ `tests/integration/admin-community-posts-pg.mjs`
  的 `[H]` 段（社区帖域里同一条路径）。
- `0046_admin_scope_denial_trace.sql`（`#18` S2 收尾片 · **库层一半**：后台 scope 操作**被拒**时的留痕写入口，
  Refs #18）接在 `0045` 之后，号位依据 `.pg17/ruling-r64-pr4-design-20261026.md` 裁定 B / D（max `0045` + 1；
  `0037` 不动、**台账不新增条目**）。只建一条窄口径 `SECURITY DEFINER` 函数
  `public.record_admin_scope_denial(uuid,uuid,text,text,uuid,uuid)`，写死 `action='admin_scope.deny'` /
  `result='denied'` / `target_ref=NULL` / `target_hint='admin_account:<target>'`，`scope` 走后台权限 13 项闭集、
  `reason_code` 走四值闭集（`self_scope_grant_denied`/`last_scope_manager`/`scope_denied`/`scope_not_held`，
  对应 G0008/G0009/G0010/G0011），并有 `REVOKE ALL … FROM PUBLIC` + 只授运行时 `EXECUTE`（部署侧
  `20-login-roles.sql` 的 `gy-r64-pr4a-denial-trace-grant` 区域 + `90-assert` 的 `function_surface_manifest` 一行）。
  ⚠ 这是「应用层拒了一次」的**申报**，不是库层证明：主事务已 ROLLBACK、`0041` 的事务级 advisory 锁已释放，
  库无从复算 —— 故**只**核 actor 存在，⛔ 不核 `active`、⛔ 不核是否持 `scopes:write`（理由写在迁移文件头）。
  配对回滚 `rollback/0046_admin_scope_denial_trace.down.sql` **只删函数**（照 `0044` 体例 `DROP FUNCTION IF EXISTS`）；
  审计行删不掉也回不去（append-only 触发器 `G0006`），正确动作是回滚应用版本。
- `0036_r34_admin_content_persistence.sql`（R34 · #18 后台内容/资料域落库 + **列级**授权，已随 #538 落盘）：
  接在 `0035` 之后。落盘 ⇒ 保留台账里那条 `version: 36`（`owner: #538`、`remove_when: #538 合入即删`）
  按它自己的 `remove_when` **删除**（保留项不许躺平：0036 一落盘 `reservedButPresent` 就会把它判红）。
  `tests/unit/migration-reservations.test.mjs` 的「当前仓库」快照同 commit 跟进：缺号由 `[36,37]` 收为 `[37]`、
  「不得出现 `0036_` 前缀文件」翻成「必须出现」（方向与落盘事实一致，⛔ 不是放宽判据）。
- `0038_r34_deletion_receipt_persistence.sql`（#19 片B，已随 #553 落盘）：回执 bearer 摘要落
  `deletion_requests.receipt_bearer_hash` ＋ 三条窄口径 SECURITY DEFINER 函数（set/resolve/count）；
  按它自己的 `remove_when`，保留台账里的 38 号条目已删除（保留项不许躺平）。
- `0039_r34_deletion_state_cancelled.sql`（#22 片C · 在途取消：`ALTER TYPE deletion_state ADD VALUE 'cancelled'`）接在
  `0038` 之后；裁定 `.pg17/ruling-r34-migration-0039-cancelled-20261024.md` 分配本号，
  其余保留号 `0037` 串行合入（迁移号互斥）。

- `0040_export_object_key_contract_backfill.sql`（GY-R35 · `/me/exports` 越枚举写入侧改写）接在 `0039` 之后：
  取号前核对 `0036`/`0037` 已在保留台账、正向最大号为 `0039` ⇒ 用最大号 +1，**台账不新增条目**（本片即落盘）。
  迁移只做三件事：① **只回填可证明身份的历史行** —— 轮次行 `conversation_turn` + `turn:<uuid>` **类型保持不变**、
  仅去 `turn:` 前缀成裸 uuid（类型/标识/版本指向同一真实实体）；`checked_content` + `<内容类型>:<id>` 仅在
  「前缀属六值闭集 + 冒号后是 uuid 形状 + 去前缀后 ≤80」四条同真时才拆成真实内容类型 + 裸 id。
  同一 `UPDATE` 内连 `object_key` 一起去前缀写裸 id（分两条语句写会撞 `exports_object_key_xor` 哨兵）；
  ② 仍有不可如实回填的行（残留 `checked_content`、键非裸 uuid 的 `conversation_turn`）则 `RAISE EXCEPTION`
  中止并打印样例（**刻意 fail-closed**，不猜、不丢行、不靠删旧标签换通过），随后再做一遍长度预检；③ 最后才把
  `exports_object_key_shape` 从 `{1,128}` 收紧到 `{1,80}`（与契约 `TargetRef.id` 的 `maxLength: 80` 同口径）。
  配对回滚 `rollback/0040_export_object_key_contract_backfill.down.sql` **只回滚约束、不回滚数据**
  （回退会把行写回契约闭集之外；去前缀后信息不唯一可逆），依据写在两个文件各自的头注释里。
- `0041_admin_scope_write_authority.sql`（`#18` S2 片1 · **库层**：后台管理员 scope 的**唯一写路径** +
  闭集约束，Refs #18）接在 `0040` 之后：取号依据是裁定
  `.pg17/ruling-r37-issue18-s2-scope-admin-20261025.md`「`0040` 已被 `#568` 占用；S2 新迁移用 `0041`」，
  当时 ⛔ 不占 `0042`（该号后由 GY-R37 片占用，见下一条 0042 段）。迁移只做三件事：① **先预检后加约束** —— 扫 `public.admin_scopes.scope`，
  出现后台权限闭集（13 项）之外的取值即 `RAISE EXCEPTION 'G0012'` 打出样例并中止（**只报告、不删行、
  不自动映射**，裁定②）；② 建库层 CHECK `admin_scopes_scope_closed_set`（闭集只含后台权限，
  **不含** `user`/`public`/`receipt`）；③ 建两条窄口径 `SECURITY DEFINER` 函数
  `public.grant_admin_scope(uuid,uuid,text,text,uuid,uuid,integer)` /
  `public.revoke_admin_scope(uuid,uuid,text,text,uuid,uuid,integer)`（固定 `search_path = pg_catalog`、
  `REVOKE ALL … FROM PUBLIC`）：函数内校验「操作者 `state='active'` 且**当前有效**持 `scopes:write`」、
  「只能授予自己当前有效持有的 scope」、「禁自授 / 允许自撤」、**最后授权者守卫**
  （`pg_advisory_xact_lock` 事务级锁内重新核验操作者与有效授权者数量，⛔ 不做应用层先数后写），
  成功变更与审计行同一事务提交（`admin_audit_events`，action=`admin_scope.grant`/`admin_scope.revoke`）。
  运行时的 `EXECUTE` 在 `deploy/postgres-cvm/sql/20-login-roles.sql` 的 `gy-r37-s2-scope-grant` 区域授予
  （该区域**硬前置**：两条函数缺失即显式失败，不留「看似收敛、点开 42501」的运行态）；
  `90-assert` 的 `function_surface_manifest` 追加两行并新增断言 103/104 钉住函数授权面与闭集。
  **运行时对 `admin_scopes` 仍是零表级/零列级写**（`external_manifest:1540-1542` 与第 9 条
  `protected_columns:2256-2263` 一句未动）。「拒绝也留痕」需要第二个事务（抛异常必然回滚本事务），
  属 **PR-3 写面**，本片不实现也不假装实现；HTTP 端点（`POST /admin/administrators/{id}/scopes` /
  `DELETE …/{scope}`）与 403 `SELF_SCOPE_GRANT_DENIED` / 409 `LAST_SCOPE_MANAGER` 同样属 PR-2/PR-3。
  真库直调证据：`tests/integration/admin-scopes-authority-pg.mjs`（本机 PG 17.11，`GY_PG_BIN` 指向
  `initdb`/`psql`/`pg_ctl` 所在目录；未设时按仓内口径 **exit 77 未取得**，不是通过）。
  配对回滚 `rollback/0041_admin_scope_write_authority.down.sql` 逆序删两条函数与闭集约束，
  **不回填数据、不删 `admin_scopes` 行、不碰审计台账**；它也不动 `20-login-roles.sql` 的 `EXECUTE`
  ——函数一旦不在，该区域的硬前置会显式报错（生产回滚顺序：先撤部署 SQL 的该区域、再回滚迁移）。
- `0042_favorites_history_target_type_conversation_turn.sql`（GY-R37 片 · **库层**：`favorites`/`history` 的
  `target_type` CHECK 补齐契约第 17 值 `conversation_turn`）接在 `0041` 之后：取号依据是「最大号 +1」，
  **台账不新增条目**（本片即落盘，不是有意缺号）。契约 `packages/contracts/openapi.json` 的 `TargetRef.type`
  已是 **17 项**（第 17 项 `conversation_turn` 由 `#576` 的客户端镜像 17 引入），而 `0018` 的两条 CHECK 仍是旧
  16 值 ⇒ 一旦落轮次类型就会撞库层 CHECK 报 500。⛔ **不改 `0018`（连注释都不行）**，原因见下面那条 checksum
  警告 ⇒ 只能新开一支迁移改约束。迁移只做两件事：① **先预检后改约束** —— 扫 `public.favorites`、`public.history`
  的 `target_type`，出现 17 值闭集之外的取值即 `RAISE EXCEPTION 'G0013'` 打出样例并中止（**只报告、不删行、
  不映射**，与 `0040`/`0041` 同一条纪律）；② 用 `DROP CONSTRAINT <名字>; ADD CONSTRAINT <同名> CHECK
  (target_type IN (…17 值…))` 把两表约束换成 17 值闭集，值序与契约枚举一致（`species, herbicide, scheme,
  static_region, recognition, ocr, transcription, answer, post, comment, conversation, conversation_turn,
  dose_card, media, synthesis, job, source`）。约束名 `favorites_target_type_check` / `history_target_type_check`
  取自 PG 对列内联无名 CHECK 的默认命名 `<table>_<column>_check`：已在 **PGlite 0.5.8（WASM，内核 PostgreSQL
  18.3）** 上真跑 `0018` 后由 `pg_constraint` 实测确认（favorites 的 4 条、history 的 8 条 CHECK 全部按此规则命名），
  迁移内再用 `pg_constraint`+`pg_attribute` 双保险校验「名字对 + 列级 `conkey` + `contype='c'`」，不符即
  `RAISE EXCEPTION 'G0014'` 并打印两表现有 CHECK 定义 —— ⛔ **刻意不写 `DROP CONSTRAINT IF EXISTS`**（那会把
  「约束被改名」静默放过，改成一条什么都没换的假迁移）。配对回滚
  `rollback/0042_favorites_history_target_type_conversation_turn.down.sql` 恢复 16 值 CHECK（顺序同 `0018`），
  **先预检**：库里若已有 `target_type = 'conversation_turn'` 的行即 `RAISE EXCEPTION 'G0015'` 中止 ——
  回滚不能把数据写回契约闭集之外（只报告、不删行、不映射）。
- `0043_admin_job_cancel_audit.sql`（`#18` R18 片 · **库层**：后台「作业取消」的审计**从进程内存落到库**，
  Refs #18）接在 `0042` 之后：号位由任务方**预先分配**为 `0043`（不换号），台账不新增条目（本片即落盘）。
  为什么必须新开一支迁移：`job.cancel` 的审计原先只写进程内 `store.audit.append`（重启即丢），而库层
  `public.admin_audit_events` 对运行时是**零表级、零列级写**（`90-assert-least-privilege.sql` 的
  `external_manifest` 与槽 9 `protected_columns` 钉死，表上还有 `admin_audit_events_append_only`
  触发器 ⇒ 只可追加），所以只能沿用 `0041` 已裁定的第三条路：**窄口径 `SECURITY DEFINER` 函数 +
  `REVOKE ALL … FROM PUBLIC` + 只授 `EXECUTE` 给运行时**，迁移里**不给**运行时任何表级/列级 INSERT。
  迁移只做一件事：建 `public.record_admin_job_cancel_audit(p_actor_id uuid, p_job_id uuid,
  p_job_revision integer, p_reason_code text, p_request_id uuid) RETURNS uuid`（`LANGUAGE plpgsql`,
  `SECURITY DEFINER`, `SET search_path = pg_catalog`, `SET TimeZone = 'UTC'`），函数内依次校验
  ①入参与理由码闭集（`p_reason_code <> 'job_cancelled'` ⇒ `G0001`）、②操作者存在（`admin_accounts`
  查不到 ⇒ `G0002`）、③`state = 'active'`（⇒ `G0010`）、④**当前有效**持 `jobs:cancel`
  （`admin_scopes` 中 `revoked_at IS NULL` 的那一行，⇒ `G0010`），然后同事务
  `INSERT INTO public.admin_audit_events` 一行并 `RETURNING` 行 id：`action='job.cancel'`、
  `scope='jobs:cancel'`、`result='accepted'`、`target_ref = jsonb_build_object('type','job','id',<job>::text,
  'revision',<取消前 revision>)`、`target_hint = NULL`、`reason_code = 入参`、`request_id = 入参`
  —— **动作文本 / scope / result / target_ref / target_hint 全在函数内固定或由形参重建**，
  `actor_id` 只来自 `p_actor_id` 且要过上面四条校验 ⇒ 调用方没有伪造 actor 或伪造动作的缝隙。
  `{type:'job', id, revision}` 形状已被 `0017` 的 `admin_audit_events_target_ref_shape` CHECK 接受
  （该 CHECK 只要求 `type`/`id` 是字符串、`revision` 是数字），**不需要**扩白名单。
  运行时的 `EXECUTE` 在 `deploy/postgres-cvm/sql/20-login-roles.sql` 的
  `gy-r18-job-cancel-audit-grant` 区域授予（**硬前置**：函数缺失即显式失败），
  `90-assert` 的 `function_surface_manifest` 追加一行 `runtime` 登记
  （断言 90/91/92 双向钉住：`prosecdef` 必须登记、PUBLIC 不得可执行、grantee 集合须精确相等）。
  配对回滚 `rollback/0043_admin_job_cancel_audit.down.sql` **只删函数**（照 `0042` 理由不写 `IF EXISTS`），
  但**先数** `action='job.cancel'` 的审计行：`>0` 即 `RAISE EXCEPTION 'G0016'
  （JOB_CANCEL_AUDIT_ROLLBACK_BLOCKED）` 中止 —— 删函数会留下「有行、无出处」的审计，且应用仍会调用它；
  回滚件的 HINT 明确「正确动作是回滚应用版本，不是回滚这条函数」，且审计台账本来也删不掉
  （append-only 触发器把 DELETE 拦成 `G0006`）。**应用侧接线（监工 #589 返修后）**：审计**不再**是
  一个独立的审计端口，而是接在作业端口的取消事务里 —— `services/api/src/admin/ops/jobs-pg.ts` 的
  `cancel()` 在 `updateSql` 之后、`COMMIT` **之前**用同一个 `client` 调
  `SELECT public.record_admin_job_cancel_audit(…)`（字面量、**无 `FROM`** ⇒ 不触表列、不成为 SQL 宿主，
  导出在 `ADMIN_JOB_SQL.cancelAudit` 供真库臂断言）；任一步失败即 `ROLLBACK` ⇒ 作业保持取消前状态、
  审计 0 行、响应 503（`retryable: false`）。`AdminJobPort` 因此多了一个 `persistent` 判据
  （与 `CommunityPostPort.persistent` 同口径）：`true` 的端口自己写库内审计，`false` 的（stub 内存实现）
  仍由 `cancelAdminJob` 写内存 `store.audit.append` —— 两条落点互斥，不会重复记一行。
  真库直调证据：`tests/integration/admin-jobs-pg.mjs` 的 `[C]` 臂（断言 **库内恰 1 行** +
  actor/scope/target_ref/reason/result 逐项正确）与**同事务返修臂**（用审计表触发器人为制造写入失败，
  断言作业仍是取消前状态、审计表零新增 —— 即「审计写失败 ⇒ 取消不生效」）。
- **本片不修的库层遗留（已由 `0042` 修复，2026-10-25）**：`0018_favorites_history.sql` 的 `target_type` CHECK 仍是旧 16 值
  （不含 `conversation_turn`）。今日 favorites/history 写入口不可达该成员，但 `services/api/src/history/validate.ts`
  已按 17 类校验 ⇒ 一旦落轮次类型会撞库层 CHECK 报 500。修它需要新迁移改表（本片 `0042` 即此），不改 `0018`；**也不要直接改 `0018` 的文本（连注释都不行）**——`services/api/src/db/migrate.ts:47` 对整份 SQL 取 SHA256（不剥注释）、`:193` 与已应用记录的 checksum 比对、`:241-243` 发现差异即拒绝，既有库升级会被拦住（当前 main 原文 SHA256 `a90385167b8ad1f84f76d0dcc3348aecfc94869c794de4edeb2c0734a7727ded`）。

- `0033_admin_audit_log_read.sql`（R34 · 后台审计日志查询面，Refs #18）接在 `0032` 之后：
  编号前核对过全部 refs 与在途 PR（`003[3-9]_` 零命中）⇒ 直接用最大号 +1，**台账仍为空数组**。
- `0034_r34_owner_content_purge.sql`（#19 注销闭集扩展 · 注销内容清理窄函数）接在 `0033` 之后：
  本片原取 0033，与 #525 的 `0033_admin_audit_log_read.sql` **撞号** ⇒ 裁定保留 #525 的 0033（更早成形、
  且不动本片这套跨文件 canary），本片整体让到 `0034`。**#525 已于 2026-10-24 合入 `origin/main`（`4b87e1d9`）**，
  该号已由真实文件占位 ⇒ 台账里那条 `version: 33` 条目（`owner: #525`，`remove_when: #525 合入即删`）按它自己的
  `remove_when` **删除**；本文件此前那行「该号待落盘、先挂保留台账」的当前状态表述**随之作废并删除**（保留项不许躺平：落盘即删），
  现本目录 `0001..0034` 连续、无缺号，`reservations` 为空数组。

- `0036_r34_admin_content_persistence.sql`（R34 · #18 后台内容/资料域落库 + **列级**授权）原定接在 `0034` 之后：
  `0035` 归在途的「媒体行侧物理删除」片、`0037` 由 `#14` 使用 ⇒ 本片取 `0036`，**前提是 `0035` 先落 `main`**。
  该前提已成立：`0035_r34_media_row_purge.sql` 随上游落盘、本片 0036 随 #538 合流落盘 ⇒ `0001..0036` 连成一段，
  缺号只剩保留中的 `0037`（见上面「当前状态」段）。
- `0031_online_purge_evidence.sql`（#19 片B · 在线清理证据落库）与
  `0032_community_report_reporter_ref.sql`（#15 去身份残留 · 举报者行级注销引用）按裁定
  `.pg17/ruling-r32-migration-0031-allocation.md` 的归属落位：**0031 属 #19、0032 属 #15**。
- 合流顺序上先落 0031、再落 0032（#494 → #492）⇒ `0031..0032` 自然连成一段、**全程无缺号**。
  反过来若先合 #492，则必须先登记 31 号保留条目，并在 0031 落盘那一刻删除它 ——
  本段原先写的正是这个「待落盘」条件；**#494 已合入、0031 已真实落盘 ⇒ 该条件成立，故上面那条
  31 号登记与本段的「缺 1 个号」表述一并作废**（保留项不许躺平）。

历史上本文件记过一行「0029 预留」：`0029_media_object_cleanup.sql` 当时只在 PR #419
（`feat/gy-r28-media-object-cleanup`）分支上，而 F13 行级作者注销引用片（迁移 `0030`）先要落地 ⇒
树上缺 29，保留台账登记 `owner: #419`。**#419 已合入 `origin/main`（`056cf424`）**，0029 真实落盘 ⇒
台账条目与那一行依据都已按 `remove_when` / 本文件的「届时一并删除」**删除**（否则
`reservedButPresent` 会立刻判红：保留项不许躺平）。同族的「0031 预留」一行依据，#494 合入后
已按同一条纪律删除（见上）。

## 编号约定

- `0030_community_author_ref.sql` 当时取的是 0028 之后的第一个空号（29 被 #419 占着），**不是随便跳号**。
- `0032_community_report_reporter_ref.sql` 接在 `0031_online_purge_evidence.sql` 之后（0031 属 #19，已落盘）。
- 后续迁移从最大号之后连续编号；确需跨 PR 缺号时，**同时**在保留台账登记并在本文件写一行依据。
