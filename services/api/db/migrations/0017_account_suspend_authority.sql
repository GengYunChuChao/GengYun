-- GY-I22（#22）· 账号停用/恢复接到**真实认证权威**：单事务内写 users.state + 递增 auth_epoch
--   + 撤销全部会话 + 写审计事件（追加型台账）
--
-- ## 为什么是 SECURITY DEFINER（与 0016 同一条裁定，逐字复用）
-- `services/api/db/roles/auth_privacy.sql` 授予运行时角色 `gengyun_api_runtime` 的
-- `public.users` **列权限只有** `SELECT (id,state,auth_epoch,revision,wechat_subject_lookup)`
-- 与 `UPDATE (updated_at)`；`public.sessions` 只有 `UPDATE (token_hash,revoked_at)`。
-- 因此「把账号改 suspended/active + `auth_epoch+1` + `revision+1`」这三列在运行时角色下
-- 必然 `permission denied`（`42501`）。两条替代路径（放宽最小权限 / API 进程再开特权连接）
-- 已在 0016 被否决；这里沿用第三条：把停用与恢复各自收进**唯一一个窄口径函数**，
-- 函数属主是迁移管理员（即本迁移执行者），运行时角色**只**拿到 EXECUTE。
-- 效果：运行时对 `users` 的四列与 `public.admin_audit_events` **仍然没有任何直接写权限**，
-- 唯一写路径收敛到可断言的函数（`deploy/postgres-cvm/sql/90-assert-least-privilege.sql`
-- 的 `suspend_*` / `restore_*` / `admin_audit_events_*` 断言把这条钉死）。
--
-- ## 四条硬条件（逐条落实位置，与 0016 同口径）
-- 1. `SET search_path = pg_catalog`（**固定**，不写 `public`、不用 `$user`）⇒ 见两个函数定义；
--    函数体内所有对象都写全限定名。
-- 2. `REVOKE ALL ... FROM PUBLIC`（本文件末尾）+ 只 `GRANT EXECUTE ... TO gengyun_api_runtime`
--    （放 `deploy/postgres-cvm/sql/20-login-roles.sql`：该角色在迁移之后才创建）。
-- 3. `90-assert-least-privilege.sql` 只**新增函数级/表级契约断言**（存在、`search_path` 已固定、
--    属主、EXECUTE 仅授予运行时角色、审计台账对运行时零写权限），**不**补任何列权限。
-- 4. 反向控制：以 `gengyun_api_runtime` 直接
--    `UPDATE public.users SET auth_epoch = auth_epoch + 1` 仍必须 `permission denied`。
--
-- ## 事务边界（本片的核心要求）
-- 每个函数**整体是一个语句/一个事务**，恰好包住四步：
--   ① `UPDATE public.users`：`state` 迁移 + `auth_epoch+1` + `revision+1`；
--   ② `UPDATE public.sessions`：该用户**全部**活跃会话 `revoked_at` 落值（`GET DIAGNOSTICS` 取实测条数）；
--   ③ `INSERT INTO public.admin_audit_events`：审计事件落库（复用仓内既有审计结构，见下）；
--   ④ `RETURN`：返回**实测**读数（`UPDATE ... RETURNING` 与 `ROW_COUNT`，不靠算术推断）。
-- 四步任意一步失败 ⇒ 整个语句回滚 ⇒ **零写入**（不会出现「epoch 已递增但会话没撤」或
-- 「状态改了但审计没落」的半成品）。注入点见证据页：重复 `p_audit_id`（主键 23505）会让
-- 第 ③ 步失败，前两步随之回滚——这是**真实可复现**的失败注入，不是模拟。
--
-- ## 审计结构为什么是这张表而不是第二套
-- `services/api/src/admin/audit.ts` 的内部记录 `AuditRecord` = 契约 `AuditEvent` 的 8 个字段
-- （`id`/`action`/`scope`/`target_ref`/`reason_code`/`request_id`/`result`/`created_at`）
-- **+ `actor_id`（主体）+ `target_hint`（契约 `TargetRef.type` 闭集里没有 account，故标识落内部字段）**。
-- `public.admin_audit_events` 的列与该内部记录**一一对应**（9 列 + `created_at`），
-- 不新增、不删减字段；`target_hint` 永不出现在契约投影里（`projectAuditEvent()` 只输出 8 个字段）。
-- 只可追加：`REVOKE UPDATE/DELETE` 之外再加触发器（属主误操作也拒绝），错误码 `G0006`。
--
-- ## 与注销的边界（不得混用）
-- `state='deletion_pending'` 的账号**不接受**停用/恢复（状态回退会干扰注销流程）⇒ `G0004`，
-- 由适配层映射为契约既有 `OBJECT_UNAVAILABLE`（与 `admin/ops/service.ts` 现有语义逐字一致）。
-- 停用**不**写 `deletion_requests`、不递减任何注销期限。
--
-- ## auth_epoch 的语义（旧 token 不得复活）
-- 停用、恢复**各自**递增一次 `auth_epoch`：会话校验拿会话签发时的 epoch 与服务端当前 epoch 比对
-- （`services/api/src/auth/middleware.ts`），停用后旧 token 立即失效（401 `SESSION_EXPIRED`），
-- 恢复时再递增一次 ⇒ 停用期间签发过的任何令牌（含故障期间漏撤的）也不会因为"恢复"而重新有效。
-- 「`revoked_at` 落值」与「epoch 前进」是两个可分离的机制（判定 §5），这里**两者都做**。
--
-- ## 模块内 SQL 错误码（沿用仓内 G 码约定；映射在
-- `services/api/src/admin/ops/account-authority-pg.ts`，**不新增契约错误码**）
--   G0001 INVALID_REQUEST       参数非法（空 actor/audit/request id、非正 revision）
--   G0002 NOT_FOUND             主体不存在
--   G0003 REVISION_CONFLICT     `If-Match` 与当前 `users.revision` 不符
--   G0004 OBJECT_UNAVAILABLE    账号状态不接受该动作（deletion_pending / deleted）
--   G0006 AUDIT_IMMUTABLE       审计台账只可追加（UPDATE/DELETE 一律拒绝）
--   `23505`（审计 id 撞主键）与 `42501`（权限缺失）由适配层如实映射，⛔ 不降级、不改走别的路径。
--
-- ## 幂等与并发
-- `SELECT ... FOR UPDATE`（行锁）+ 状态门 ⇒ 同一账号的并发停用被串行化：第二个事务重读到的
-- 必然是 `suspended`，于是走「幂等返回」分支（`changed:false`），**不会**出现第二次
-- `auth_epoch+1`、第二条审计事件或第二次会话撤销。

BEGIN;

-- ① 审计事件台账（追加型）。列与 `admin/audit.ts` 的内部记录 `AuditRecord` 一一对应。
CREATE TABLE public.admin_audit_events (
  id          uuid        PRIMARY KEY,
  -- 主体：契约 `AuditEvent` 缺此字段（已知契约缺口），内部记录比契约多这一个。
  actor_id    uuid        NOT NULL,
  action      varchar(64) NOT NULL CHECK (length(action) BETWEEN 1 AND 64),
  scope       varchar(40) NOT NULL CHECK (length(scope) BETWEEN 1 AND 40),
  -- 契约 `TargetRef`：闭集里没有 account ⇒ 本片一律 NULL，标识落 target_hint。
  target_ref  jsonb,
  target_hint text        CHECK (target_hint IS NULL OR length(target_hint) BETWEEN 1 AND 120),
  reason_code varchar(64) NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 64),
  request_id  uuid        NOT NULL,
  result      text        NOT NULL CHECK (result IN ('accepted', 'denied', 'failed')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admin_audit_events_target_ref_shape CHECK (
    target_ref IS NULL
    OR (
      jsonb_typeof(target_ref) = 'object'
      AND target_ref ? 'type' AND target_ref ? 'id' AND target_ref ? 'revision'
      AND jsonb_typeof(target_ref -> 'type') = 'string'
      AND jsonb_typeof(target_ref -> 'id') = 'string'
      AND jsonb_typeof(target_ref -> 'revision') = 'number'
    )
  )
);

-- 按时间倒序取（后台审计页的唯一读取形状）；同刻按 id 稳定排序。
CREATE INDEX admin_audit_events_created_idx
  ON public.admin_audit_events (created_at DESC, id DESC);
CREATE INDEX admin_audit_events_target_idx
  ON public.admin_audit_events (target_hint, created_at DESC);

-- ② 只可追加：属主误操作也拒绝（不只是"没授权"）。
CREATE FUNCTION public.admin_audit_events_reject_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'G0006', MESSAGE = 'AUDIT_IMMUTABLE';
END;
$$;

CREATE TRIGGER admin_audit_events_append_only
  BEFORE UPDATE OR DELETE ON public.admin_audit_events
  FOR EACH ROW EXECUTE FUNCTION public.admin_audit_events_reject_mutation();

-- ③ 账号展示名投影（**纯投影规则，不是身份数据**）：
--    `users.nickname` 可空而契约 `AdminAccountView.display_name` 是
--    `required / minLength:1 / maxLength:80`。这里复用仓内既有命名规则
--    （`services/api/src/authors.ts:54` 的「耕云用户 + 4 位摘要」），只在没有昵称时启用；
--    ⛔ 不新增列、不写库、不伪造可识别身份。
CREATE FUNCTION public.admin_account_display_name(p_nickname text, p_id uuid) RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT COALESCE(
    NULLIF(btrim(p_nickname), ''),
    '耕云用户' || upper(substr(md5(p_id::text), 1, 4))
  );
$$;

-- ④ 停用：唯一写路径。
CREATE FUNCTION public.suspend_account(
  p_actor_id uuid,
  p_audit_id uuid,
  p_user_id uuid,
  p_expected_revision integer,
  p_request_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET TimeZone = 'UTC'
AS $$
DECLARE
  x_before public.users;
  x_after public.users;
  x_audit public.admin_audit_events;
  x_revoked integer;
  x_display text;
  x_changed boolean := false;
BEGIN
  -- 入参自检：非法即 G0001（不把 CHECK 违反当「服务器错误」外泄）。
  IF p_actor_id IS NULL OR p_audit_id IS NULL OR p_user_id IS NULL OR p_request_id IS NULL
     OR (p_expected_revision IS NOT NULL AND p_expected_revision < 1)
  THEN
    RAISE EXCEPTION USING ERRCODE = 'G0001', MESSAGE = 'INVALID_REQUEST';
  END IF;

  -- 行锁：并发双停用在此串行化（后到的事务重读最新行 ⇒ 必然看到 suspended）。
  SELECT * INTO x_before FROM public.users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'G0002', MESSAGE = 'NOT_FOUND';
  END IF;

  -- 前置条件（强 ETag）：语义与 `assertIfMatchMatches()` 逐字一致，先于幂等判定。
  IF p_expected_revision IS NOT NULL AND p_expected_revision <> x_before.revision THEN
    RAISE EXCEPTION USING ERRCODE = 'G0003', MESSAGE = 'REVISION_CONFLICT';
  END IF;

  -- 注销在途/已删：状态回退会干扰注销流程 ⇒ 确定性拒绝（契约既有 OBJECT_UNAVAILABLE）。
  IF x_before.state IN ('deletion_pending', 'deleted') THEN
    RAISE EXCEPTION USING ERRCODE = 'G0004', MESSAGE = 'OBJECT_UNAVAILABLE';
  END IF;

  IF x_before.state = 'suspended' THEN
    -- 幂等：已停用 ⇒ 不再迁移、不再递增 epoch、不再撤会话、不再写第二条审计。
    -- 返回**当前实测行**（与首次停用后的读数同形，但 changed=false 标明本次无副作用）。
    x_display := public.admin_account_display_name(x_before.nickname, x_before.id);
    RETURN jsonb_build_object(
      'id', x_before.id,
      'state', x_before.state,
      'revision', x_before.revision,
      'auth_epoch', x_before.auth_epoch,
      'display_name', x_display,
      'revoked_sessions', 0,
      'changed', false,
      'audit_id', NULL::uuid
    );
  END IF;

  -- 第 ①步：状态迁移 + auth_epoch 递增（旧 token 立即失效的唯一依据）+ revision 前进。
  UPDATE public.users
     SET state = 'suspended',
         auth_epoch = auth_epoch + 1,
         revision = revision + 1,
         updated_at = now()
   WHERE id = p_user_id
  RETURNING * INTO x_after;

  -- 第 ②步：撤销该用户**全部**活跃会话（不是当前一个）。
  UPDATE public.sessions
     SET revoked_at = now()
   WHERE user_id = p_user_id AND revoked_at IS NULL;
  GET DIAGNOSTICS x_revoked = ROW_COUNT;

  -- 第 ③步：审计事件落库（同一事务）。action/scope/reason_code 在函数内**固定**，
  -- 不接受调用方传入 ⇒ 不可能伪造审计文本；主体/请求号/审计 id 由调用方给定。
  INSERT INTO public.admin_audit_events (
    id, actor_id, action, scope, target_ref, target_hint, reason_code, request_id, result
  ) VALUES (
    p_audit_id, p_actor_id, 'account.suspend', 'accounts:suspend', NULL,
    'account:' || p_user_id::text, 'account_suspended', p_request_id, 'accepted'
  )
  RETURNING * INTO x_audit;

  x_changed := true;
  x_display := public.admin_account_display_name(x_after.nickname, x_after.id);

  RETURN jsonb_build_object(
    'id', x_after.id,
    'state', x_after.state,
    'revision', x_after.revision,
    'auth_epoch', x_after.auth_epoch,
    'display_name', x_display,
    'revoked_sessions', x_revoked,
    'changed', x_changed,
    'audit_id', x_audit.id,
    'audit_created_at', to_char(x_audit.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
END;
$$;

-- ⑤ 恢复（启用）：停用的反向，同样一个事务包住四步。
--    契约 `operations.json` **没有** restore/enable 操作 ⇒ 本片**不新增 HTTP 路由**、不改契约；
--    能力以「端口方法 + 本函数」交付，真库读数见交接证据（恢复后旧 token 仍不得复活）。
CREATE FUNCTION public.restore_account(
  p_actor_id uuid,
  p_audit_id uuid,
  p_user_id uuid,
  p_expected_revision integer,
  p_request_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET TimeZone = 'UTC'
AS $$
DECLARE
  x_before public.users;
  x_after public.users;
  x_audit public.admin_audit_events;
  x_revoked integer;
  x_display text;
BEGIN
  IF p_actor_id IS NULL OR p_audit_id IS NULL OR p_user_id IS NULL OR p_request_id IS NULL
     OR (p_expected_revision IS NOT NULL AND p_expected_revision < 1)
  THEN
    RAISE EXCEPTION USING ERRCODE = 'G0001', MESSAGE = 'INVALID_REQUEST';
  END IF;

  SELECT * INTO x_before FROM public.users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'G0002', MESSAGE = 'NOT_FOUND';
  END IF;

  IF p_expected_revision IS NOT NULL AND p_expected_revision <> x_before.revision THEN
    RAISE EXCEPTION USING ERRCODE = 'G0003', MESSAGE = 'REVISION_CONFLICT';
  END IF;

  IF x_before.state IN ('deletion_pending', 'deleted') THEN
    RAISE EXCEPTION USING ERRCODE = 'G0004', MESSAGE = 'OBJECT_UNAVAILABLE';
  END IF;

  IF x_before.state = 'active' THEN
    -- 幂等：已是 active ⇒ 不动 epoch、不写第二条审计。
    x_display := public.admin_account_display_name(x_before.nickname, x_before.id);
    RETURN jsonb_build_object(
      'id', x_before.id,
      'state', x_before.state,
      'revision', x_before.revision,
      'auth_epoch', x_before.auth_epoch,
      'display_name', x_display,
      'revoked_sessions', 0,
      'changed', false,
      'audit_id', NULL::uuid
    );
  END IF;

  UPDATE public.users
     SET state = 'active',
         auth_epoch = auth_epoch + 1,
         revision = revision + 1,
         updated_at = now()
   WHERE id = p_user_id
  RETURNING * INTO x_after;

  -- 恢复也撤一遍活跃会话：停用期间若有漏网会话（例如故障窗口内签发），
  -- 恢复**不得**让它复活 —— epoch 已再前进一次，撤行是第二道保险。
  UPDATE public.sessions
     SET revoked_at = now()
   WHERE user_id = p_user_id AND revoked_at IS NULL;
  GET DIAGNOSTICS x_revoked = ROW_COUNT;

  INSERT INTO public.admin_audit_events (
    id, actor_id, action, scope, target_ref, target_hint, reason_code, request_id, result
  ) VALUES (
    p_audit_id, p_actor_id, 'account.restore', 'accounts:suspend', NULL,
    'account:' || p_user_id::text, 'account_restored', p_request_id, 'accepted'
  )
  RETURNING * INTO x_audit;

  x_display := public.admin_account_display_name(x_after.nickname, x_after.id);

  RETURN jsonb_build_object(
    'id', x_after.id,
    'state', x_after.state,
    'revision', x_after.revision,
    'auth_epoch', x_after.auth_epoch,
    'display_name', x_display,
    'revoked_sessions', x_revoked,
    'changed', true,
    'audit_id', x_audit.id,
    'audit_created_at', to_char(x_audit.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
END;
$$;

-- 硬条件 2（前半）：PUBLIC 一律不得执行；唯一的 EXECUTE 授予放在
-- `deploy/postgres-cvm/sql/20-login-roles.sql`（`gengyun_api_runtime` 在该步才创建）。
REVOKE ALL ON FUNCTION public.suspend_account(uuid,uuid,uuid,integer,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.restore_account(uuid,uuid,uuid,integer,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_account_display_name(text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_audit_events_reject_mutation() FROM PUBLIC;
-- 审计台账：运行时连 SELECT 都不需要（读面未接线），更不得 UPDATE/DELETE。
REVOKE ALL ON TABLE public.admin_audit_events FROM PUBLIC;

COMMIT;
