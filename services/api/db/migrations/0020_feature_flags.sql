-- GY-I18（#18）· 全局开关 `feature_flags` 落库：读面走表、写面走唯一一个窄口径函数
--
-- ## 这张表是什么（口径来源：`.pg17/ruling-feature-flags-persistence-20261018.md` §1/§3）
-- 三个契约开关（`submissions_enabled` / `specific_herbicide_output_enabled` / `ai_enabled`）
-- 的**唯一权威状态**：`enabled` + 单调递增的 `revision`（CAS 用）+ 变更主体/理由/时间。
-- 默认值必须是**关**：迁移插入三行且 `enabled = false`，一行都不许开（裁定 §1）。
-- `key` 用 CHECK 钉死在契约闭集上：库层面就不存在第四个键，避免「库里有、契约没有」的漂移。
--
-- ## 为什么写面是 SECURITY DEFINER 函数（与 0017 同一条裁定，逐字复用）
-- 运行时角色 `gengyun_api_runtime` 对 `public.feature_flags` 只拿 `SELECT`；
-- `public.admin_audit_events` 对运行时**连 SELECT 都没有**（0017 已固化，反向控制见
-- `tests/integration/account-suspend-pg.mjs` 的 `[P]` 组）。因此「改开关 + 写审计」在运行时
-- 角色下必然 `42501`。两条替代路径（放宽列权限 / API 进程再开特权连接）在 0016/0017 已被否决，
-- 这里沿用第三条：把写面收进**唯一一个**函数，函数属主是迁移执行者，运行时角色只拿 EXECUTE。
-- 授予语句放在 `deploy/postgres-cvm/sql/20-login-roles.sql` 的 `gy-i18-flags-grant` 段
-- （该角色在迁移之后才创建，迁移里 GRANT 会失败）。
--
-- ## 事务边界（裁定 §3 的顺序，逐条对应）
-- 一个函数 = 一条语句 = 一个事务，恰好包住：
--   ① `SELECT ... FOR UPDATE`：拿行锁并读**当前** revision；
--   ② 校验 `If-Match`（`p_expected_revision` 与库内 revision 比对）⇒ 不符 `G0003`；
--   ③ 值未变 ⇒ 直接返回 `changed:false`（不递增 revision、不写第二条审计）；
--   ④ `UPDATE ... WHERE key = $1 AND revision = $2`：CAS 递增 `revision`、落 `changed_by/reason/changed_at`；
--   ⑤ `INSERT INTO public.admin_audit_events`：**同事务**写一行审计（裁定 §3 的固定口径：
--      `action='set_flag'`、`scope='flags:write'`、`target_hint=<flag key>`、`target_ref=NULL`、
--      `result='accepted'`、`reason_code=<调用方归一后的短码>`）。
-- 任意一步失败 ⇒ 整个语句回滚 ⇒ 零写入（不会出现「revision 递增了但审计没落」）。
-- 并发两笔同 revision：行锁把第二个事务排在后面，它重读到的 revision 已 +1 ⇒ `G0003`，
-- 恰好一笔成功、一笔冲突、审计恰好一行（真库验收 ②③④）。
--
-- ## 审计文本为什么在函数里写死
-- 调用方只能给 `p_audit_id / p_actor_id / p_request_id / p_reason_code`；`action`/`scope`/
-- `target_hint`/`result` 是函数内字面量 ⇒ 应用进程**无法**伪造审计文本（与 0017 的
-- `suspend_account` 同一手法）。
--
-- ## `changed_by` 为什么引用 `public.admin_accounts` 而不是 `public.users`
-- 派单 §2.1 原文写 `references public.users(id)`；按裁定「落库读数优先」核对：
-- `services/api/src/auth/middleware.ts` 的管理员身份是 `audience='admin'`，其 `userId`
-- 取自 `public.admin_accounts.id`（`users` 是**终端用户**表）。若按原文建 FK，后台每次改开关
-- 都会以 `23503` 失败——即「实现看起来接上了、真实写面必然 500」。故 FK 指向
-- `public.admin_accounts(id)`（`ON DELETE SET NULL`：管理员被删后保留开关状态与时间，只丢失主体）。
-- 这条偏差在交接文件里单列，供复核。
--
-- ## 模块内 SQL 错误码（沿用仓内 G 码约定；映射在
-- `services/api/src/admin/ops/flags-pg.ts`，⛔ 不新增契约错误码）
--   G0001 INVALID_REQUEST    入参自检（key 不在闭集、revision < 1、关键 id 为 NULL、短码不合形）
--   G0002 NOT_FOUND          开关行不存在（fail-closed：读面也会把它当 `unrecognized`）
--   G0003 REVISION_CONFLICT  `If-Match` 与库内 `revision` 不符
--   `23505`（审计 id 撞主键）与 `42501`（权限缺失）由适配层如实映射，⛔ 不降级、不改走别的路径。

BEGIN;

CREATE TABLE public.feature_flags (
  -- 契约闭集（`services/api/src/admin/ops/flags.ts` 的 `CONTRACT_FLAG_KEYS`）。
  key         text        PRIMARY KEY,
  enabled     boolean     NOT NULL DEFAULT false,
  revision    integer     NOT NULL DEFAULT 1,
  -- 变更主体 = 后台管理员（`public.admin_accounts.id`），见文件头「changed_by 为什么…」。
  changed_by  uuid        NULL REFERENCES public.admin_accounts(id) ON DELETE SET NULL,
  reason      text        NULL,
  changed_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT feature_flags_key_closed CHECK (
    key IN ('submissions_enabled', 'specific_herbicide_output_enabled', 'ai_enabled')
  ),
  CONSTRAINT feature_flags_revision_positive CHECK (revision >= 1),
  -- 与契约 `FlagInput.reason` 的 `1..500` 对齐；空串落库前已由函数归一为 NULL。
  CONSTRAINT feature_flags_reason_length CHECK (reason IS NULL OR length(reason) <= 500)
);

COMMENT ON TABLE public.feature_flags IS
  'GY-I18 全局开关权威状态：三键闭集、默认全关、revision 为 CAS 版本、写面只经 public.set_feature_flag()';
COMMENT ON COLUMN public.feature_flags.revision IS
  'CAS 版本：每次真实状态变更 +1；HTTP ETag 即 "revision"';
COMMENT ON COLUMN public.feature_flags.changed_by IS
  '最近一次变更的后台管理员 id（public.admin_accounts.id）；不是终端用户 id';

-- 默认全关：三行一次性插入，`enabled=false`、`revision=1`（裁定 §1：不许 true、不许部分行）。
INSERT INTO public.feature_flags (key, enabled, revision) VALUES
  ('submissions_enabled', false, 1),
  ('specific_herbicide_output_enabled', false, 1),
  ('ai_enabled', false, 1)
ON CONFLICT (key) DO NOTHING;

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

  -- ⑤ 同事务审计：文本在函数内写死，调用方无法伪造。
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

-- 硬条件：PUBLIC 一律不得执行/读；唯一的 EXECUTE 与表级 SELECT 授予放
-- `deploy/postgres-cvm/sql/20-login-roles.sql`（运行时角色在该步才创建）。
REVOKE ALL ON FUNCTION public.set_feature_flag(text, integer, boolean, uuid, uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON TABLE public.feature_flags FROM PUBLIC;

COMMIT;
