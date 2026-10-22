-- GY-I18 第一批 · 功能开关变更留痕的「可查」面：审计行补 before/after 读数 + 读函数。
--
-- 为什么需要本迁移（改前真读数）：
--   1. `0017_account_suspend_authority.sql:72-95` 建的 `public.admin_audit_events` 只有
--      `id/actor_id/action/scope/target_ref/target_hint/reason_code/request_id/result/created_at`，
--      **没有任何 before/after 列** ⇒ 「谁把开关从 A 改成 B」里的 A 值在审计行里根本不存在。
--   2. 该表对运行时角色 `gengyun_api_runtime` 连 SELECT 都没有（`deploy/postgres-cvm/sql/20-login-roles.sql`
--      的 `gy-i18-flags-grant` 段只授了 `feature_flags` 的 SELECT 与 `set_feature_flag` 的 EXECUTE）
--      ⇒ 即使补了列，也没有任何读路径能把它们取出来。
--   3. `services/api/src/admin/ops/flags-pg.ts` 是唯一写开关的路径（CAS + 同事务审计），
--      但它只读 `set_feature_flag()` 的返回值（`key/enabled/revision/changed/audit_id/changed_at`）。
-- 本迁移只做三件事，不新增契约错误码、不改任何既有列、不改既有权限：
--   ① `admin_audit_events` 追加两列 `before_value` / `after_value`（可空 jsonb，仅对象形状）；
--   ② `public.set_feature_flag(...)` **同签名**替换：在既有审计插入里同时写入这两列；
--   ③ 新增只读函数 `public.list_admin_flag_audit(...)`：`SECURITY DEFINER`、`STABLE`、
--      `SET search_path = pg_catalog`，按 `(created_at DESC, id DESC)` 键集分页返回 `action='set_flag'` 的审计行。
--      EXECUTE 授予不写在这里（运行时角色在该步还不存在），见
--      `deploy/postgres-cvm/sql/20-login-roles.sql` 的 `gy-i18-flag-audit-grant` 段。
--
-- 为什么读面用函数而不是直接 SELECT 表：`admin_audit_events` 的最小权限是「运行时不可读」
-- （0017 的裁定，本迁移不动它）。函数以属主身份执行，只暴露 `set_flag` 一类行，
-- 不把整张审计表（含停用/封禁等其它 admin 动作的主体）开给运行时。
--
-- 回滚：services/api/db/migrations/rollback/0027_admin_audit_observability.down.sql
--   （删两列、删读函数、把 `set_feature_flag` 还原成 0020 的逐字形体）
--
-- ## 不变量（本迁移刻意保持）
--   - `set_feature_flag` 的**签名与 G 码语义逐字不变**（G0001/G0002/G0003），只多写两列 ⇒
--     `services/api/src/admin/ops/flags-pg.ts` 的错误映射与 `tests/unit/admin-flags-pg.test.mjs` 不受影响；
--   - `before_value`/`after_value` 的值由函数内字面量构造（`enabled` + `revision`），调用方**无法伪造**；
--   - 既有审计行（迁移前写入的）两列保持 NULL —— 这是事实，不做回填、不猜历史值。

BEGIN;

-- ① 审计行补 before/after（可空：迁移前的历史行没有这两个读数，如实留 NULL）。
ALTER TABLE public.admin_audit_events
  ADD COLUMN before_value jsonb NULL,
  ADD COLUMN after_value  jsonb NULL;

COMMENT ON COLUMN public.admin_audit_events.before_value IS
  '变更前的读数（jsonb 对象）；仅 set_feature_flag 目前写入 {enabled, revision}，历史行为 NULL';
COMMENT ON COLUMN public.admin_audit_events.after_value IS
  '变更后的读数（jsonb 对象）；仅 set_feature_flag 目前写入 {enabled, revision}，历史行为 NULL';

-- 形状约束：要么 NULL，要么是对象。挡的是「塞一个标量/数组进来说这是读数」。
ALTER TABLE public.admin_audit_events
  ADD CONSTRAINT admin_audit_events_before_value_shape CHECK (
    before_value IS NULL OR jsonb_typeof(before_value) = 'object'
  ),
  ADD CONSTRAINT admin_audit_events_after_value_shape CHECK (
    after_value IS NULL OR jsonb_typeof(after_value) = 'object'
  );

-- ② 同签名替换写入函数：审计插入多两列，其余逐字保持 0020 的语义。
--    为什么要在 DDL 期间关掉函数体校验：本迁移的函数体引用 `public.feature_flags`（0020 建的表），
--    而 `tests/integration/admin-flags-pg.mjs` 的夹具会**故意把 0020 放到最后重放**（「迁移可重放」判据），
--    那一路上 0027 先于 0020 执行 ⇒ 默认的 check_function_bodies=on 会在建函数时就报 42P01。
--    真实部署顺序是数字序（0020 先、0027 后），两条路径下函数都可用；关校验只影响**建函数这一瞬**，
--    不改任何运行时语义；函数体本身的正确性由真库臂 `tests/integration/admin-jobs-pg.mjs` 实跑证明。
SET check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.set_feature_flag(
  p_key               text,
  p_expected_revision integer,
  p_enabled           boolean,
  p_actor_id          uuid,
  p_audit_id          uuid,
  p_request_id        uuid,
  p_reason            text,
  p_reason_code       text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET TimeZone = 'UTC'
AS $$
DECLARE
  x_before public.feature_flags%ROWTYPE;
  x_after  public.feature_flags%ROWTYPE;
  x_audit  public.admin_audit_events%ROWTYPE;
BEGIN
  -- ① 入参自检：任何一项不合格都拒绝，不做「尽力而为」。
  IF p_key IS NULL
     OR p_key NOT IN ('submissions_enabled', 'specific_herbicide_output_enabled', 'ai_enabled') THEN
    RAISE EXCEPTION 'FLAG_KEY_INVALID' USING ERRCODE = 'G0001';
  END IF;
  IF p_enabled IS NULL THEN
    RAISE EXCEPTION 'FLAG_ENABLED_REQUIRED' USING ERRCODE = 'G0001';
  END IF;
  IF p_expected_revision IS NULL OR p_expected_revision < 1 THEN
    RAISE EXCEPTION 'FLAG_REVISION_INVALID' USING ERRCODE = 'G0001';
  END IF;
  IF p_actor_id IS NULL OR p_audit_id IS NULL OR p_request_id IS NULL THEN
    RAISE EXCEPTION 'FLAG_AUDIT_FIELDS_REQUIRED' USING ERRCODE = 'G0001';
  END IF;
  IF p_reason_code IS NULL OR p_reason_code !~ '^[A-Z][A-Z0-9_]{0,63}$' THEN
    RAISE EXCEPTION 'FLAG_REASON_CODE_INVALID' USING ERRCODE = 'G0001';
  END IF;

  -- ② 行锁 + 读当前 revision（并发同 revision 在此串行化）。
  SELECT * INTO x_before
    FROM public.feature_flags
   WHERE key = p_key
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FLAG_NOT_FOUND' USING ERRCODE = 'G0002';
  END IF;
  IF p_expected_revision <> x_before.revision THEN
    RAISE EXCEPTION 'FLAG_REVISION_CONFLICT' USING ERRCODE = 'G0003';
  END IF;

  -- ③ 幂等短路：值与库内一致 ⇒ 不递增 revision、不写审计、不动 changed_by/changed_at。
  IF x_before.enabled = p_enabled THEN
    RETURN jsonb_build_object(
      'key', x_before.key,
      'enabled', x_before.enabled,
      'revision', x_before.revision,
      'changed', false,
      'audit_id', NULL::uuid,
      'changed_at', to_char(x_before.changed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    );
  END IF;

  -- ④ CAS 更新：WHERE 带 revision 是第二道保险（行锁已保证不会有人插队）。
  UPDATE public.feature_flags
     SET enabled = p_enabled,
         revision = revision + 1,
         changed_by = p_actor_id,
         reason = NULLIF(btrim(p_reason), ''),
         changed_at = now()
   WHERE key = p_key AND revision = p_expected_revision
  RETURNING * INTO x_after;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FLAG_REVISION_CONFLICT' USING ERRCODE = 'G0003';
  END IF;

  -- ⑤ 同事务审计：文本与 before/after 读数都在函数内写死，调用方无法伪造。
  INSERT INTO public.admin_audit_events (
    id, actor_id, action, scope, target_ref, target_hint, reason_code, request_id, result,
    before_value, after_value
  ) VALUES (
    p_audit_id, p_actor_id, 'set_flag', 'flags:write', NULL,
    p_key, p_reason_code, p_request_id, 'accepted',
    jsonb_build_object('enabled', x_before.enabled, 'revision', x_before.revision),
    jsonb_build_object('enabled', x_after.enabled, 'revision', x_after.revision)
  )
  RETURNING * INTO x_audit;

  RETURN jsonb_build_object(
    'key', x_after.key,
    'enabled', x_after.enabled,
    'revision', x_after.revision,
    'changed', true,
    'audit_id', x_audit.id,
    'changed_at', to_char(x_after.changed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
END;
$$;

RESET check_function_bodies;

-- ③ 只读审计面：只暴露 `set_flag` 一类行，键集分页（(created_at,id) 严格递减）。
--    排序与既有索引 `admin_audit_events_created_idx (created_at DESC, id DESC)` 完全一致
--    ⇒ 真库上走索引，不额外建索引、不改既有索引。
CREATE OR REPLACE FUNCTION public.list_admin_flag_audit(
  p_limit              integer     DEFAULT 50,
  p_before_created_at  timestamptz DEFAULT NULL,
  p_before_id          uuid        DEFAULT NULL
) RETURNS TABLE (
  id           uuid,
  actor_id     uuid,
  action       varchar(64),
  scope        varchar(40),
  target_ref   jsonb,
  target_hint  text,
  reason_code  varchar(64),
  request_id   uuid,
  result       text,
  before_value jsonb,
  after_value  jsonb,
  created_at   timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
SET TimeZone = 'UTC'
AS $$
  SELECT e.id,
         e.actor_id,
         e.action,
         e.scope,
         e.target_ref,
         e.target_hint,
         e.reason_code,
         e.request_id,
         e.result::text,
         e.before_value,
         e.after_value,
         e.created_at
    FROM public.admin_audit_events AS e
   WHERE e.action = 'set_flag'
     AND (
       p_before_created_at IS NULL
       OR p_before_id IS NULL
       -- 键集分页：严格小于游标（同刻按 id 递减），与索引同序。
       OR (e.created_at, e.id) < (p_before_created_at, p_before_id)
     )
   ORDER BY e.created_at DESC, e.id DESC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
$$;

-- 硬条件：PUBLIC 一律不得执行；EXECUTE 只授予运行时角色（在 20-login-roles.sql 的
-- `gy-i18-flag-audit-grant` 段，运行时角色那一步才创建）。
REVOKE ALL ON FUNCTION public.set_feature_flag(text, integer, boolean, uuid, uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_admin_flag_audit(integer, timestamptz, uuid) FROM PUBLIC;

COMMIT;
