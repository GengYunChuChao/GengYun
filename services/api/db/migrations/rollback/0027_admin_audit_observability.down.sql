-- 回滚：`0027_admin_audit_observability.sql`（审计 before/after 列 + 只读审计函数）。
--
-- 顺序（先改依赖、再拆对象）：
--   ① `set_feature_flag` 还原成 `0020_feature_flags.sql:84-177` 的**逐字形体**（不再写 before/after）；
--   ② 删只读函数 `list_admin_flag_audit`；
--   ③ 删两列（各自的 CHECK 约束随列一起消失）。
-- 数据代价：迁移后写入的审计行会丢掉 before/after 读数 —— 这是回滚的定义，不是副作用；
-- 审计行本身（id/actor/action/…/created_at）**不删**，与 `0017` 的「只可追加」口径一致。
-- 不改任何既有表结构、不动 `feature_flags` 行。
BEGIN;

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

  INSERT INTO public.admin_audit_events (
    id, actor_id, action, scope, target_ref, target_hint, reason_code, request_id, result
  ) VALUES (
    p_audit_id, p_actor_id, 'set_flag', 'flags:write', NULL,
    p_key, p_reason_code, p_request_id, 'accepted'
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

REVOKE ALL ON FUNCTION public.set_feature_flag(text, integer, boolean, uuid, uuid, uuid, text, text) FROM PUBLIC;

DROP FUNCTION IF EXISTS public.list_admin_flag_audit(integer, timestamptz, uuid);

ALTER TABLE public.admin_audit_events
  DROP COLUMN IF EXISTS before_value,
  DROP COLUMN IF EXISTS after_value;

COMMIT;
