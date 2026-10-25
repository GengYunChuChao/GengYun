# 迁移目录说明

本目录只放**正向迁移**（`NNNN_<name>.sql`）与 `rollback/NNNN_<name>.down.sql`。
机器可读的「保留号台账」在 `services/api/db/migration-reservations.json`；
`tools/verify-migrations-unique.mjs` 的 `[gap]` 判据要求缺号在**本目录的 `.md`** 里有一行依据。

## 当前状态（2026-10-25 · `#538` 已合入 main（`6dbe83a3`）＋ GY-R35（`#568`）＋ `#18` S2 片1＋ GY-R37 片（`0042`）＋ `#18` R18 片（`0043`）：`0001..0043`，缺 `0037`）

`0001..0035` 已连续落盘（35 个正向；`0035_r34_media_row_purge.sql` 已随上游真实落盘，本片旧段里那条
`WARN[gap] 0035` 的前提随之作废）；上游 #553（#19 片B）落 `0038_r34_deletion_receipt_persistence.sql`、
#22 片C 落 `0039_r34_deletion_state_cancelled.sql`、#538 落 `0036_r34_admin_content_persistence.sql`、
GY-R35（#568）落 `0040_export_object_key_contract_backfill.sql`、`#18` S2 片1 落
`0041_admin_scope_write_authority.sql`、GY-R37 片落
`0042_favorites_history_target_type_conversation_turn.sql`、`#18` R18 片落
`0043_admin_job_cancel_audit.sql`
⇒ 目录现为 **42 个正向 `.sql`** ＋ `rollback/` **41 个**（`0001` 无 down）；缺号只剩 `0037`，已登记在
`services/api/db/migration-reservations.json`（`count + 保留数 === max` ⇒ **42 + 1 === 43**），
`node tools/verify-migrations-unique.mjs --strict` 的 `[gap]` 判据对该缺号有依据（见下）。
（本段数字为实测：`git ls-tree -r --name-only HEAD -- services/api/db/migrations`
⇒ 正向 `.sql` 42 条、`rollback/` 41 条；缺号恰为 `0037` 且已登记保留。`0040`/`0041`/`0042` 均已真实落盘，
故保留台账里**不得**再出现 40/41/42 号条目 —— 否则 `reservedButPresent` 会把它判红。
`0043` 是本片自己落盘的文件，**台账同样不新增条目**。）

- `0037` 预留：**#14** 人工复核（已裁定分配、尚无分支/文件；文件名待该片落定时核）。
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
  （append-only 触发器把 DELETE 拦成 `G0006`）。应用侧接线：`services/api/src/admin/ops/jobs-cancel-audit-pg.ts`
  （`SELECT public.record_admin_job_cancel_audit(…)`，**无 `FROM`** ⇒ 不触表列、不成为 SQL 宿主），
  由 `app.ts` 在「`real` + 有池 + 作业端口已接线」时注入 `createAdminOpsService({ jobCancelAudit })`；
  stub 与未接库形态保持既有的内存审计路径（判据不变）。真库直调证据：
  `tests/integration/admin-jobs-pg.mjs` 的 `[C]` 臂（断言 **库内恰 1 行** + actor/scope/target_ref/reason/result 逐项正确）。
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
