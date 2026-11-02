-- 迁移 0053：后台**举报处置**（`triage` / `resolve` / `reject`）的审计落库
-- =============================================================================
--
-- 为什么必须新增迁移、⛔ 不能改既有迁移
-- ---------------------------------------------------------------
-- · R72 把举报处置接上了 HTTP（`POST /admin/reports/{id}/disposition` ⇒ `advanceReport`），
--   但社区 CAS（`community_reports` 的 `state`/`revision`）**只改举报行**：谁在什么时候做了
--   哪一种处置（受理 / 成立结案 / 驳回结案）、理由是什么，库里一个字都没留。
--   `closed` 一值两义（`community/report-state.ts:27-31` 已登记为已知弱化）⇒ 事后连
--   「这条举报是 resolve 还是 reject 关的」都反查不出来。监工在 #838 的 CHANGES_REQUESTED
--   里点名了这一条：**放行 real 写面之前必须先有与处置相匹配的持久留痕**。
-- · ⛔ 不能给运行时表级/列级 `INSERT`：`deploy/postgres-cvm/sql/90-assert-least-privilege.sql`
--   的 external_manifest 把 `admin_audit_events` 的表级 S/I/U/D 全钉成 false，槽 9 的
--   protected_columns 再钉死关键列；表上还有 `admin_audit_events_append_only` 触发器
--   （UPDATE/DELETE 一律 `G0006`）。审计台账**只可追加**，且只能经窄口径函数写。
-- · 于是沿用 `0041_admin_scope_write_authority.sql` / `0043_admin_job_cancel_audit.sql` /
--   `0047_admin_post_hide_audit.sql` 已裁定的**第三条路**：窄口径 `SECURITY DEFINER` 函数 +
--   `REVOKE ALL … FROM PUBLIC` + 只授 `EXECUTE` 给运行时角色。本迁移**不新增任何**表级/列级授权。
-- · 既有迁移已被现网库应用，改一个字节即 checksum 拒绝（`services/api/src/db/migrate.ts`）
--   ⇒ 只能**新增**一条正向迁移。
--
-- 本迁移只做两件事（同一事务，要么全成要么全不成）
-- ---------------------------------------------------------------
-- ① 建 `public.record_admin_report_disposition_audit(...)`：一次调用 = 校验操作者 + 同事务写
--    **恰好一行**审计。
-- ② 收回该函数的默认 ACL（PG 新建函数的 `EXECUTE` 默认授 `PUBLIC`）：`REVOKE ALL … FROM PUBLIC`；
--    运行时的 `EXECUTE` 在 `deploy/postgres-cvm/sql/20-login-roles.sql` 的
--    `#region gy-r72-report-disposition-audit-grant` 区域授予（迁移只收回，授予以部署脚本为唯一出处）。
--
-- 函数签名（顺序即调用顺序，全部必填：没有"可选 actor"这种缝）
-- ---------------------------------------------------------------
--   public.record_admin_report_disposition_audit(
--     p_actor_id        uuid,    -- 操作者的 admin_accounts.id（= 会话身份，不接受调用方另传 actor 列）
--     p_report_id       uuid,    -- 被处置的举报 id（community_reports.id）
--     p_report_revision integer, -- **处置前**的举报 revision（写进 target_ref.revision）
--     p_action          text,    -- 处置动作闭集 {'triage','resolve','reject'}（= report-state.ts 的动作名）
--     p_reason_code     text,    -- 理由码；本函数只接受与该动作一一对应的闭集（见下）
--     p_request_id      uuid     -- 契约 Meta.request_id
--   ) RETURNS uuid             -- 写入行的 admin_audit_events.id
--
-- 动作 → 审计行的映射（在函数体内固定，调用方改不了）
-- ---------------------------------------------------------------
--   triage  ⇒ action='report.triage'  / reason_code='report_triaged'
--   resolve ⇒ action='report.resolve' / reason_code='report_resolved'
--   reject  ⇒ action='report.reject'  / reason_code='report_rejected'
--   scope 恒为 'sources:write'（与 `OPS_SCOPES.advanceReport` 同一道门，⛔ 不新造 `reports:*`），
--   result 恒为 'accepted'（处置失败根本走不到这里：CAS 不成立时事务里什么都不写）。
--   ⇒ 「受理 / 成立结案 / 驳回结案」三种处置在台账上**三种不同 action**，不再都折叠成 `closed`。
--
-- 函数内的校验点（顺序固定，任一不成立即 `RAISE EXCEPTION`，什么都不写）
-- ---------------------------------------------------------------
--   ① 入参自检 —— `G0001 INVALID_REQUEST`：任一参数为 NULL、`p_report_revision < 1`、
--      `p_action` 长度 > 32、`p_reason_code` 长度 > 64，或 `p_action` 不在闭集内。
--   ② 理由码必须是该动作对应的那一个 —— `G0018 INVALID_REASON_CODE`：
--      `p_reason_code <> <由 p_action 派生的那个值>` 即拒（理由码是可伪造的审计**语义**，
--      与 `0047` 同理单独一个错误码）。
--   ③ 操作者存在 —— `G0002 NOT_FOUND`：`admin_accounts` 里没有这一行。
--   ④ 操作者可用 —— `G0010 SCOPE_DENIED`：`state <> 'active'`（停用/已注销的账号不能再留痕）。
--   ⑤ **当前有效**持 `sources:write` —— `G0010 SCOPE_DENIED`：`admin_scopes` 里
--      `revoked_at IS NULL` 的那一行不存在（撤销过的授权不算；⛔ 不采信应用层 HTTP 侧的判定结果）。
--
-- 为什么调用方伪造不了审计内容
-- ---------------------------------------------------------------
--   · `actor_id` 只能是入参 `p_actor_id`，且必须先过 ③④⑤ 三道核验；函数**不接收**任何
--     「以谁的名义写」的旁路参数 ⇒ 没有"代写"入口。
--   · `action` / `scope` / `result` 由 `p_action` 在函数体内派生为**字面量**，调用方改不了；
--     `target_hint` 固定 `NULL`（举报的自由文本 `detail` 已经在行上，不在审计里再抄一份）。
--   · `target_ref` 由**形参重建**
--     （`jsonb_build_object('type','report','id',p_report_id::text,'revision',p_report_revision)`），
--     不接受调用方直接塞 jsonb ⇒ 绕不过 `admin_audit_events_target_ref_shape`（`0017`）那条 CHECK
--     （该 CHECK 只要求 `type` 是字符串、`id` 是字符串、`revision` 是数字，**不枚举** `type`，
--     所以 `{type:'report', …}` 无需 ALTER）。
--   · `request_id` 由调用方给（契约追踪 id），它不参与任何授权判定，只用于把审计行与请求对齐。
--
-- 调用点与事务边界（这里也是唯一正确姿势）
-- ---------------------------------------------------------------
--   本函数**只在举报处置的那个事务里**被调用：`services/api/src/community/store-pg.ts` 的
--   `commitReport` 整段在 `withTransaction` 内 —— `SELECT … FOR UPDATE` → CAS 判定 →
--   `UPDATE community_reports` → `SELECT public.record_admin_report_disposition_audit(…)` → `COMMIT`，
--   全部共用同一个 `sql`（同一个 client）。
--   ⇒ 任何一步失败都走 `catch` 里的 `ROLLBACK`：举报保持原 `state`/`revision`，审计表**零新增**，
--     客户端收到 503（`PROVIDER_UNAVAILABLE`，`retryable: false`，message 含「审计写入失败」）。
--   ⇒ 因此不存在「处置已提交、审计没写成」的缺口 —— 那是"先成后败"的假成功，
--     而 `admin_audit_events` 是 append-only 的，事后也无从补记。
--
-- 已知边界（如实登记）
-- ---------------------------------------------------------------
--   · 读面闭集**随本片扩三值**：`services/api/src/admin/audit/catalog.ts` 的 `AUDIT_ACTIONS` 与
--     `packages/contracts/openapi.json` 的 `AuditAction` 枚举各加 `report.triage` / `report.resolve` /
--     `report.reject`（与库内写入点逐值同序），否则 `tests/unit/audit-action-literal-coverage.test.mjs`
--     的「库内字面量 ∈ 读面闭集」双向对拍会红 —— 三个动作必须能被 `GET /admin/audit-logs?action=`
--     单独筛出来，正是「resolve / reject 不可分」要解决的那一半。
--     `?entity=` 仍**没有** `report` 取值（举报不是六个实体之一）：`entity=post` 的动作护栏把它收窄到
--     `post.hide`，举报行不会串进帖子视图；举报行只能靠 `?action=report.*` 或不过滤的全量翻页拿到。
--   · 本函数**不复查举报行**（不查 `community_reports.state`）：它与那一次 `UPDATE` 同事务，
--     行锁在手，`UPDATE` 的 `RETURNING` 已经证明迁移发生了；跨域的连接点由调用方保证（同一个事务）。
--   · 本函数**不判定幂等**：重复处置在状态机/CAS 层就被拦下（终态拒绝、revision 不匹配 ⇒ 409），
--     不会再进这个事务 ⇒ 同一举报的同一动作应当恰好一行审计。
--
-- 回滚：`rollback/0053_admin_report_disposition_audit.down.sql`
--   先数 `action LIKE 'report.%'` 的审计行，> 0 即 `RAISE EXCEPTION 'G0019'` 中止，再删函数
--   （`G0019` 是迁移期「回滚被证据挡住」的既有号，与 `rollback/0047`、`0049`、`0050` 同体例）。
--
-- 号位：当前正向最大号是 `0052`、`0037` 是保留台账里的在途缺号 ⇒ 取最大号 +1 = `0053`
-- （本片即落盘，`services/api/db/migration-reservations.json` 不新增条目）。
BEGIN;

-- ---------------------------------------------------------------------------
-- ① 唯一写路径：窄口径 SECURITY DEFINER 函数（一次调用 = 一行审计）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_admin_report_disposition_audit(
  p_actor_id        uuid,
  p_report_id       uuid,
  p_report_revision integer,
  p_action          text,
  p_reason_code     text,
  p_request_id      uuid
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET TimeZone = 'UTC'
AS $$
DECLARE
  x_actor        public.admin_accounts%ROWTYPE;
  x_audit_id     uuid;
  x_reason_code  text;
BEGIN
  -- ① 入参自检：非法即 G0001（不把 CHECK 违反当「服务器错误」外泄）。
  IF p_actor_id IS NULL
     OR p_report_id IS NULL
     OR p_request_id IS NULL
     OR p_report_revision IS NULL OR p_report_revision < 1
     OR p_action IS NULL OR length(p_action) > 32
     OR p_reason_code IS NULL OR length(p_reason_code) > 64
  THEN
    RAISE EXCEPTION USING ERRCODE = 'G0001', MESSAGE = 'INVALID_REQUEST';
  END IF;

  -- ①' 动作闭集：调用方只能选三个动作之一，理由码按动作派生（用于 ② 的核对）。
  IF p_action = 'triage' THEN
    x_reason_code := 'report_triaged';
  ELSIF p_action = 'resolve' THEN
    x_reason_code := 'report_resolved';
  ELSIF p_action = 'reject' THEN
    x_reason_code := 'report_rejected';
  ELSE
    RAISE EXCEPTION USING ERRCODE = 'G0001', MESSAGE = 'INVALID_REQUEST';
  END IF;

  -- ② 理由码闭集：每个动作只有一个合法理由码（拓宽闭集必须新增迁移）。
  IF p_reason_code <> x_reason_code THEN
    RAISE EXCEPTION USING ERRCODE = 'G0018', MESSAGE = 'INVALID_REASON_CODE';
  END IF;

  -- ③ 操作者存在（definer 内读 admin_accounts；运行时不持有该表的任何直读/直写权）。
  SELECT * INTO x_actor FROM public.admin_accounts WHERE id = p_actor_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'G0002', MESSAGE = 'NOT_FOUND';
  END IF;

  -- ④ 操作者可用：停用/已注销的账号不能再造审计行（同 0017/0041/0047 的 active 口径）。
  IF x_actor.state <> 'active' THEN
    RAISE EXCEPTION USING ERRCODE = 'G0010', MESSAGE = 'SCOPE_DENIED';
  END IF;

  -- ⑤ 当前**有效**持有 sources:write（`revoked_at IS NULL`）；不采信应用层 HTTP 侧的判定结果。
  IF NOT EXISTS (
    SELECT 1
      FROM public.admin_scopes AS s
     WHERE s.admin_id = p_actor_id
       AND s.scope = 'sources:write'
       AND s.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'G0010', MESSAGE = 'SCOPE_DENIED';
  END IF;

  -- ⑥ 审计：action/scope/reason_code/result 在函数内固定，target_ref 由形参重建 ⇒ 调用方伪造不了。
  --    三个分支各写一个**字面量** action：读面的 `?action=` 闭集（`AUDIT_ACTIONS` / 契约
  --    `AuditAction`）逐值静态可核，`tests/unit/audit-action-literal-coverage.test.mjs` 才能把
  --    「库内写入点」与「读面闭集」双向对拍（变量形态会被该闸门当场判红）。
  x_audit_id := gen_random_uuid();
  IF p_action = 'triage' THEN
    INSERT INTO public.admin_audit_events (
      id, actor_id, action, scope, target_ref, target_hint, reason_code,
      request_id, result
    ) VALUES (
      x_audit_id,
      p_actor_id,
      'report.triage',
      'sources:write',
      jsonb_build_object('type', 'report', 'id', p_report_id::text, 'revision', p_report_revision),
      NULL,
      'report_triaged',
      p_request_id,
      'accepted'
    );
  ELSIF p_action = 'resolve' THEN
    INSERT INTO public.admin_audit_events (
      id, actor_id, action, scope, target_ref, target_hint, reason_code,
      request_id, result
    ) VALUES (
      x_audit_id,
      p_actor_id,
      'report.resolve',
      'sources:write',
      jsonb_build_object('type', 'report', 'id', p_report_id::text, 'revision', p_report_revision),
      NULL,
      'report_resolved',
      p_request_id,
      'accepted'
    );
  ELSE
    INSERT INTO public.admin_audit_events (
      id, actor_id, action, scope, target_ref, target_hint, reason_code,
      request_id, result
    ) VALUES (
      x_audit_id,
      p_actor_id,
      'report.reject',
      'sources:write',
      jsonb_build_object('type', 'report', 'id', p_report_id::text, 'revision', p_report_revision),
      NULL,
      'report_rejected',
      p_request_id,
      'accepted'
    );
  END IF;

  RETURN x_audit_id;
END;
$$;

COMMENT ON FUNCTION public.record_admin_report_disposition_audit(uuid, uuid, integer, text, text, uuid) IS
  '后台「举报处置」审计的唯一写路径（迁移 0053）：校验操作者存在/active/当前有效持 sources:write，'
  '同事务向 public.admin_audit_events 写一行 action=report.{triage|resolve|reject}、'
  'scope=sources:write、result=accepted，返回该行 id。'
  'EXECUTE 只授 gengyun_api_runtime（20-login-roles.sql 的 gy-r72-report-disposition-audit-grant）。';

-- ---------------------------------------------------------------------------
-- ② 收回默认 ACL：函数的 `EXECUTE` 默认授予 PUBLIC，这里必须显式收回。
--    运行时的 `EXECUTE` 在 `20-login-roles.sql` 的 `gy-r72-report-disposition-audit-grant`
--    区域授予；⛔ 本迁移不给运行时 `admin_audit_events` 任何 INSERT（那是 90-assert 的
--    external_manifest 与 protected_columns 钉死的红线）。
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.record_admin_report_disposition_audit(uuid, uuid, integer, text, text, uuid)
  FROM PUBLIC;

COMMIT;
