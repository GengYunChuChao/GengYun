-- ============================================================================
-- 0041 · `#18` S2 片1（库层）：后台管理员 scope 的**唯一写路径** + 闭集约束
--
-- 执行口径来源（不得由实现者改口径）：
--   `.pg17/ruling-r37-issue18-s2-scope-admin-20261025.md`（监工裁定，六点）
--   `.pg17/tmp/issue18-s2-design/02-write-plane.md`（写面设计）
--
-- ## 为什么必须是 SECURITY DEFINER 函数，而不是给运行时直接写权
-- `deploy/postgres-cvm/sql/90-assert-least-privilege.sql:1540-1542` 把 `public.admin_scopes`
-- 对 `gengyun_auth_privacy` 的表级 S/I/U/D 固定为 false/false/false/false、列级 ins/upd 为空
-- 数组；`:2256-2263`（第 9 条 `protected_columns`）再用
-- `NOT has_column_privilege('gengyun_api_runtime','public.admin_scopes','scope','UPDATE')`
-- 钉死「scope 列不可被运行时改」。直接授写权 ⇒ 这两处同时红；改快照或删
-- 断言 = 放宽既有断言。⇒ 沿用 `0017_account_suspend_authority.sql:4-24` 与
-- `0027_admin_audit_observability.sql:1-31` 已裁定的第三条路：
--   **窄口径 SECURITY DEFINER 函数 + `REVOKE ALL … FROM PUBLIC` + 只授 `EXECUTE` 给运行时**。
-- 本迁移**不**给运行时任何表级/列级 INSERT/UPDATE/DELETE；运行时对 `admin_scopes` 仍只有
-- `SELECT (admin_id, scope, revoked_at)` 三列（授权在 `services/api/db/roles/auth_privacy.sql`，
-- 本片未动）。
--
-- ## 裁定六点在库层的落点
--   ① 操作者与时限：函数内校验「操作者存在 + `state='active'` + 当前有效持 `scopes:write`」；
--      授予不设自动到期列（表本来就没有 `expires_at`，本片**不加**）；
--      「只能授予自己当前有效持有的 scope」⇒ `SCOPE_NOT_HELD`（G0011）。
--   ② 闭集与 CHECK：新增 `scopes:read` / `scopes:write` 两个 scope 名，`admin_scopes.scope` 的
--      库层 CHECK **只含后台权限**（不含 `user` / `public` / `receipt`）。
--      加约束**之前**先做历史值预检：出现闭集外取值 ⇒ `RAISE EXCEPTION` 打出样例并中止；
--      ⛔ 不删除、不自动映射任何历史行（裁定②：「发现历史未知值先报告」）。
--   ③ 本片**只做库层**：HTTP 形态（`POST /admin/administrators/{id}/scopes`、
--      `DELETE …/{scope}`）属 PR-2/PR-3，本文件不含路由、不含错误码映射。
--   ④ 自我操作：**禁止自授**（`SELF_SCOPE_GRANT_DENIED`，G0008）；**允许自查、自撤**；
--      自撤同样受最后授权者守卫约束（见 `revoke_admin_scope` 第 ⑥ 步）。
--   ⑤ 最后授权者：**硬拦**，用**事务级 advisory 锁**（`pg_advisory_xact_lock`，按 scope 名取
--      唯一一把）；锁内**重新**核验操作者权限（第 ③ 步）与有效授权者数量（第 ⑥ 步），
--      ⛔ 不采用「应用层先数后写」。计数只算 `state='active'` 且 `revoked_at IS NULL` 的管理员
--      ⇒ 已停用、元权限已撤销者**不计入**。
--      分片边界（裁定⑤后半句「凡会使最后管理者失效的管理员**停用/删除**路径也须共享同一守卫」）：
--      本片只覆盖**撤销**这一条路径。停用走 `0017_account_suspend_authority.sql` 的 `suspend_account`
--      （已合入、⛔ 一个字节都不能改），让它同取这把 advisory 键必须是**新迁移**替换/包装该函数，
--      属 PR-3「写面」的守卫接线（与两个 HTTP 端点、两个新错误码同批），本片既不假装已接、
--      也不在 0017 上动手。
--   ⑥ 错误与审计：G 码在函数内固定，映射层（PR-3）映射为 403 `SELF_SCOPE_GRANT_DENIED`、
--      409 `LAST_SCOPE_MANAGER`；成功变更与审计**同一事务原子提交**；
--      「拒绝也留痕」需要第二个事务（抛异常必然回滚本事务），属 PR-3，本片不实现也不假装实现。
--
-- ## 四态矩阵（`admin_scopes(admin_id=T, scope=S)` 只有 3 种行状态）
--   | 操作 | 行不存在 | 行有效 | 行已撤销 |
--   | grant  | INSERT ⇒ changed=true | changed=false（幂等，不写审计、不 bump revision） | 复活：revoked_at=NULL、granted_by/granted_at 更新 ⇒ changed=true |
--   | revoke | changed=false（幂等空操作） | UPDATE revoked_at=now() ⇒ changed=true | changed=false（幂等空操作） |
--   目标管理员不存在 ⇒ G0002 404；目标 `state<>'active'` ⇒ G0004 409（两个操作一致，照设计矩阵）。
--
-- ## 模块内 SQL 错误码（沿用仓内 G 码约定；G0005/G0006/G0007 已被既有迁移占用）
--   G0001 INVALID_REQUEST            参数非法（空 id/scope 越界/原因空或超长/revision<1）
--   G0002 NOT_FOUND                  操作者或目标管理员不存在
--   G0003 REVISION_CONFLICT          `p_expected_revision` 与 `admin_accounts.revision` 不符
--   G0004 OBJECT_UNAVAILABLE         目标管理员 `state<>'active'`
--   G0008 SELF_SCOPE_GRANT_DENIED    自授（grant 的 `p_actor_id = p_target_id`）⇒ 403
--   G0009 LAST_SCOPE_MANAGER         撤销后 `scopes:write` 有效持有者归零 ⇒ 409
--   G0010 SCOPE_DENIED               操作者不是有效管理员，或不持 `scopes:write`
--   G0011 SCOPE_NOT_HELD             授予操作者自己当前并不有效持有的 scope
--   G0012 ADMIN_SCOPE_CLOSED_SET_VIOLATION  **迁移期**历史值预检失败（不是运行期错误码）
--   `42501`（权限缺失）/`23505`（审计 id 撞主键）由调用方如实映射，⛔ 不降级、不改走别的路径。
--
-- ## 审计口径（复用 `admin_audit_events`，不新建台账）
--   action=`admin_scope.grant` / `admin_scope.revoke`；scope=被授/被撤的 scope 值本身；
--   target_ref=NULL（契约 `TargetRef` 闭集没有 account，同 0017）；target_hint=`admin_account:<id>`;
--   reason_code=`scope_granted` / `scope_revoked`；result=`accepted`；request_id=调用方给定。
--   `before_value`/`after_value` = `{"scopes":[…有效集合…],"reason":"<原因原文>"}`。
--   为什么把原因塞进 jsonb：`admin_audit_events` **没有自由文本列**（0017 建表 10 列 +
--   0027 的 before/after 两个 jsonb，形状约束只要求「对象」）；原因属内部字段（和
--   `target_hint` 一样不进契约投影），落 jsonb 既不新增列、也不改既有断言。
--   `changed=false` ⇒ 不写审计行（口径：审计行数 = 真实状态变化数）。
--
-- ## 并发与锁顺序
--   锁顺序固定：advisory（按 scope 名，单把）⇒ `admin_accounts` 行（按 target_id）。绝不反向；
--   一次事务只取一把 advisory ⇒ 无环。
--   为什么 advisory 锁不能省：`FOR UPDATE` 只锁目标行，锁不住「另一个管理员同时被撤销」的
--   另一行 —— A、B 互撤 `scopes:write` 时各自事务都还看得见对方的有效行 ⇒ 都提交 ⇒ 元权限
--   归零，系统永久失去授权维护能力（只能改库）。按 scope 串行化后第 ⑥ 步的 count 才有意义。
--   守卫**只对 `scopes:write`**（元权限）：业务 scope 归零可由元权限恢复，给每个业务 scope 设
--   floor 会把「撤销最后一个 `audit:read`」这种正常操作变成 409。
--
-- ## 事务边界
--   一个调用 = 一条 `SELECT public.grant_admin_scope(...)`，函数体内 upsert/UPDATE 版本/写审计
--   三步同事务；任一步失败整笔回滚（零写入）。审计 id 撞主键（23505）是可复现的失败注入点。
--
-- ## EXECUTE 授予为什么不在本迁移
--   运行时 LOGIN 角色在**迁移之后**才创建（正确顺序：`migrate.ts up` ⇒ `20-login-roles.sql`），
--   授权落在 `deploy/postgres-cvm/sql/20-login-roles.sql` 的 `gy-r37-s2-scope-grant` 区域；
--   本迁移只收回函数默认 ACL 里对 `PUBLIC` 的 `EXECUTE`。
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- ① 历史值预检（必须先于 ②）：闭集外的取值**只报告、不修复**
--
-- 为什么要这一步：`admin_scopes` 自 0001 起只有 `PRIMARY KEY (admin_id, scope)`，`scope` 是
-- 自由文本 varchar(40)。已有部署里可能存在手工写入 / 早期播种 / 测试残留的闭集外取值
-- （例如 `user`、`moderation`）。加 CHECK 时若静默删行或把取值映射到别的 scope，等于**改授权
-- 语义**且不可逆 ⇒ 这里只 `RAISE EXCEPTION` 并打印样例，让人决定回填还是保留。
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  -- 后台权限闭集（13 项）。取值依据（只读核对，未改契约）：
  --   `packages/contracts/openapi.json` 的
  --   `components.schemas.SessionInfo.properties.scopes.items.enum`（12 项）—— 仓内唯一机器可读的
  --   scope 闭集，`tests/unit/session-scopes-s1.test.mjs` 的 ③ 拿它与 `codeAdminScopes()` 对拍 ——
  --   去掉**终端用户会话**语义的 `user`，再补本片新增的 `scopes:read` / `scopes:write`（裁定②）：
  --   11 + 2 = 13。逐项与 `docs/architecture/state-contract.md:9` 的后台 scope 清单一致。
  --   ⛔ `user` / `public` / `receipt` 不进本表：`user` 是用户端会话的 scope，
  --   `public`/`receipt` 是路由访问标记（`tests/unit/session-scopes-s1.test.mjs:39` 的
  --   ACCESS_MARKERS）—— 三者都不是可授予的后台权限。
  --   ⚠ 这一份与下面 ② 的 CHECK 必须逐字同源；`90-assert-least-privilege.sql` 的新断言
  --   `admin_scopes_scope_check_closed_set` 会拿约束定义反查，两侧漂移即判红。
  x_allowed text[] := ARRAY[
    'accounts:read',
    'accounts:suspend',
    'audit:read',
    'flags:read',
    'flags:write',
    'jobs:cancel',
    'jobs:read',
    'scopes:read',
    'scopes:write',
    'session:logout',
    'session:read',
    'sources:read',
    'sources:write'
  ]::text[];
  x_bad_rows   bigint;
  x_bad_values text[];
  x_samples    text[];
BEGIN
  SELECT count(*) INTO x_bad_rows
    FROM public.admin_scopes AS s
   WHERE NOT (s.scope = ANY (x_allowed));

  IF x_bad_rows > 0 THEN
    SELECT COALESCE(array_agg(DISTINCT s.scope ORDER BY s.scope), ARRAY[]::text[])
      INTO x_bad_values
      FROM public.admin_scopes AS s
     WHERE NOT (s.scope = ANY (x_allowed));

    SELECT COALESCE(
             array_agg(format('%s → %s', s.admin_id, s.scope) ORDER BY s.scope, s.admin_id),
             ARRAY[]::text[]
           )
      INTO x_samples
      FROM (
        SELECT s.admin_id, s.scope
          FROM public.admin_scopes AS s
         WHERE NOT (s.scope = ANY (x_allowed))
         ORDER BY s.scope, s.admin_id
         LIMIT 5
      ) AS s;

    RAISE EXCEPTION USING
      ERRCODE = 'G0012',
      MESSAGE = 'ADMIN_SCOPE_CLOSED_SET_VIOLATION',
      DETAIL = format(
        'public.admin_scopes 有 %s 行、%s 个取值不在后台权限闭集内；取值=%s；样例=%s',
        x_bad_rows,
        array_length(x_bad_values, 1),
        array_to_string(x_bad_values, ', '),
        array_to_string(x_samples, ' | ')
      ),
      HINT = '本迁移不删除、不映射任何历史行。先人工确认这些取值的来源（手工 SQL / 早期播种 / '
             '测试残留），决定回填或保留后再重跑迁移（migrate.ts up 会因本迁移未记账而重试）。';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- ② 闭集 CHECK（库层约束：不在闭集内的 scope 写不进来，含属主直写）
-- ---------------------------------------------------------------------------
ALTER TABLE public.admin_scopes
  ADD CONSTRAINT admin_scopes_scope_closed_set CHECK (
    scope IN (
      'accounts:read',
      'accounts:suspend',
      'audit:read',
      'flags:read',
      'flags:write',
      'jobs:cancel',
      'jobs:read',
      'scopes:read',
      'scopes:write',
      'session:logout',
      'session:read',
      'sources:read',
      'sources:write'
    )
  );

-- ---------------------------------------------------------------------------
-- ③ 授予：唯一写路径
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.grant_admin_scope(
  p_actor_id          uuid,                   -- 调用者（= admin_sessions.admin_id）
  p_target_id         uuid,                   -- 被授权者 admin_accounts.id
  p_scope             text,                   -- 后台权限闭集成员（库层 CHECK 兜底）
  p_reason            text,                   -- 原因（自由文本，落审计 jsonb；≤500）
  p_request_id        uuid,                   -- 契约 Meta.request_id
  p_audit_id          uuid    DEFAULT NULL,   -- 审计行 id；NULL ⇒ 函数内 gen_random_uuid()
  p_expected_revision integer DEFAULT NULL    -- NULL ⇒ 不做 CAS 校验（同 0017 口径）
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET TimeZone = 'UTC'
AS $$
DECLARE
  x_actor         public.admin_accounts%ROWTYPE;
  x_target        public.admin_accounts%ROWTYPE;
  x_scopes_before text[];
  x_scopes_after  text[];
  x_changed       boolean := false;
  x_audit         public.admin_audit_events%ROWTYPE;
  x_audit_id      uuid;
BEGIN
  -- ① 入参自检：非法即 G0001（不把 CHECK 违反当「服务器错误」外泄）。
  IF p_actor_id IS NULL
     OR p_target_id IS NULL
     OR p_request_id IS NULL
     OR p_scope IS NULL OR btrim(p_scope) = '' OR length(p_scope) > 40
     OR p_reason IS NULL OR btrim(p_reason) = '' OR length(p_reason) > 500
     OR (p_expected_revision IS NOT NULL AND p_expected_revision < 1)
  THEN
    RAISE EXCEPTION USING ERRCODE = 'G0001', MESSAGE = 'INVALID_REQUEST';
  END IF;

  -- ② 事务级 advisory 锁：按 scope 串行化「守卫计数 + 变更」这一个原子区间。
  --    盐 18040 是本片专用（0006 用 6006），避免与其它域的 advisory 键相撞。
  PERFORM pg_advisory_xact_lock(hashtextextended('admin_scope:' || p_scope, 18040));

  -- ③ 锁内重核验操作者（裁定⑤「不能应用层先数后写」的同一原则）：
  --    必须存在、`state='active'`、且**当前有效**持 `scopes:write`。
  SELECT * INTO x_actor FROM public.admin_accounts WHERE id = p_actor_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'G0002', MESSAGE = 'NOT_FOUND';
  END IF;
  IF x_actor.state <> 'active' THEN
    RAISE EXCEPTION USING ERRCODE = 'G0010', MESSAGE = 'SCOPE_DENIED';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.admin_scopes AS s
     WHERE s.admin_id = p_actor_id
       AND s.scope = 'scopes:write'
       AND s.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'G0010', MESSAGE = 'SCOPE_DENIED';
  END IF;

  -- ④ 目标行锁 + 存在/版本/状态门（顺序同 0017：先 CAS，再状态）。
  SELECT * INTO x_target FROM public.admin_accounts WHERE id = p_target_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'G0002', MESSAGE = 'NOT_FOUND';
  END IF;
  IF p_expected_revision IS NOT NULL AND p_expected_revision <> x_target.revision THEN
    RAISE EXCEPTION USING ERRCODE = 'G0003', MESSAGE = 'REVISION_CONFLICT';
  END IF;
  IF x_target.state <> 'active' THEN
    RAISE EXCEPTION USING ERRCODE = 'G0004', MESSAGE = 'OBJECT_UNAVAILABLE';
  END IF;

  -- ⑤ 禁止自授（裁定④ / D4③）：授予面只许作用于**他人**。
  IF p_actor_id = p_target_id THEN
    RAISE EXCEPTION USING ERRCODE = 'G0008', MESSAGE = 'SELF_SCOPE_GRANT_DENIED';
  END IF;

  -- ⑥ 只能授予自己当前有效持有的 scope（裁定①；含向另一管理员委派元权限）。
  IF NOT EXISTS (
    SELECT 1
      FROM public.admin_scopes AS s
     WHERE s.admin_id = p_actor_id
       AND s.scope = p_scope
       AND s.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'G0011', MESSAGE = 'SCOPE_NOT_HELD';
  END IF;

  SELECT COALESCE(array_agg(scope ORDER BY scope), ARRAY[]::text[])
    INTO x_scopes_before
    FROM public.admin_scopes
   WHERE admin_id = p_target_id AND revoked_at IS NULL;

  -- ⑦ 单语句 upsert：不存在 ⇒ 插；已撤销 ⇒ 复活（granted_by/granted_at 一起更新）；
  --    已有效 ⇒ DO UPDATE 的 WHERE 不成立 ⇒ 0 行 ⇒ changed=false（幂等，不写审计、不 bump）。
  WITH upsert AS (
    INSERT INTO public.admin_scopes AS s (admin_id, scope, granted_by, granted_at, revoked_at)
    VALUES (p_target_id, p_scope, p_actor_id, now(), NULL)
    ON CONFLICT (admin_id, scope) DO UPDATE
       SET granted_by = EXCLUDED.granted_by,
           granted_at = EXCLUDED.granted_at,
           revoked_at = NULL
     WHERE s.revoked_at IS NOT NULL
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM upsert) INTO x_changed;

  IF x_changed THEN
    SELECT COALESCE(array_agg(scope ORDER BY scope), ARRAY[]::text[])
      INTO x_scopes_after
      FROM public.admin_scopes
     WHERE admin_id = p_target_id AND revoked_at IS NULL;

    -- ⑧ 版本前进（运行时不直接写 admin_accounts；属主在 definer 内写）。
    --    副作用：别人手上针对该管理员的 If-Match 会因此 409 —— 这是正确语义（授权状态变了）。
    UPDATE public.admin_accounts
       SET revision = revision + 1,
           updated_at = now()
     WHERE id = p_target_id
    RETURNING * INTO x_target;

    -- ⑨ 审计（action/scope/reason_code 在函数内固定 ⇒ 调用方无法伪造文本），同事务。
    x_audit_id := COALESCE(p_audit_id, gen_random_uuid());
    INSERT INTO public.admin_audit_events (
      id, actor_id, action, scope, target_ref, target_hint, reason_code,
      request_id, result, before_value, after_value
    ) VALUES (
      x_audit_id, p_actor_id, 'admin_scope.grant', p_scope, NULL,
      'admin_account:' || p_target_id::text, 'scope_granted',
      p_request_id, 'accepted',
      jsonb_build_object('scopes', to_jsonb(x_scopes_before), 'reason', p_reason),
      jsonb_build_object('scopes', to_jsonb(x_scopes_after), 'reason', p_reason)
    )
    RETURNING * INTO x_audit;
  ELSE
    x_scopes_after := x_scopes_before;
  END IF;

  RETURN jsonb_build_object(
    'admin_id', p_target_id,
    'revision', x_target.revision,
    'scopes', to_jsonb(x_scopes_after),
    'changed', x_changed,
    'audit_id', CASE WHEN x_changed THEN to_jsonb(x_audit.id) ELSE 'null'::jsonb END,
    'audit_created_at', CASE
      WHEN x_changed THEN to_jsonb(to_char(x_audit.created_at AT TIME ZONE 'UTC',
                                          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      ELSE 'null'::jsonb
    END
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- ④ 撤销：唯一写路径 + 最后授权者守卫（事务级 advisory 锁内）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.revoke_admin_scope(
  p_actor_id          uuid,
  p_target_id         uuid,
  p_scope             text,
  p_reason            text,
  p_request_id        uuid,
  p_audit_id          uuid    DEFAULT NULL,
  p_expected_revision integer DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET TimeZone = 'UTC'
AS $$
DECLARE
  x_actor         public.admin_accounts%ROWTYPE;
  x_target        public.admin_accounts%ROWTYPE;
  x_scopes_before text[];
  x_scopes_after  text[];
  x_rows          integer := 0;
  x_holders       bigint := 0;
  x_changed       boolean := false;
  x_audit         public.admin_audit_events%ROWTYPE;
  x_audit_id      uuid;
BEGIN
  -- ① 入参自检（同 grant）。
  IF p_actor_id IS NULL
     OR p_target_id IS NULL
     OR p_request_id IS NULL
     OR p_scope IS NULL OR btrim(p_scope) = '' OR length(p_scope) > 40
     OR p_reason IS NULL OR btrim(p_reason) = '' OR length(p_reason) > 500
     OR (p_expected_revision IS NOT NULL AND p_expected_revision < 1)
  THEN
    RAISE EXCEPTION USING ERRCODE = 'G0001', MESSAGE = 'INVALID_REQUEST';
  END IF;

  -- ② 事务级 advisory 锁（与 grant 同一把键 ⇒ 同 scope 的授/撤互斥）。
  PERFORM pg_advisory_xact_lock(hashtextextended('admin_scope:' || p_scope, 18040));

  -- ③ 锁内重核验操作者（裁定⑤）。
  SELECT * INTO x_actor FROM public.admin_accounts WHERE id = p_actor_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'G0002', MESSAGE = 'NOT_FOUND';
  END IF;
  IF x_actor.state <> 'active' THEN
    RAISE EXCEPTION USING ERRCODE = 'G0010', MESSAGE = 'SCOPE_DENIED';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.admin_scopes AS s
     WHERE s.admin_id = p_actor_id
       AND s.scope = 'scopes:write'
       AND s.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'G0010', MESSAGE = 'SCOPE_DENIED';
  END IF;

  -- ④ 目标行锁 + 存在/版本/状态门。
  SELECT * INTO x_target FROM public.admin_accounts WHERE id = p_target_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'G0002', MESSAGE = 'NOT_FOUND';
  END IF;
  IF p_expected_revision IS NOT NULL AND p_expected_revision <> x_target.revision THEN
    RAISE EXCEPTION USING ERRCODE = 'G0003', MESSAGE = 'REVISION_CONFLICT';
  END IF;
  IF x_target.state <> 'active' THEN
    RAISE EXCEPTION USING ERRCODE = 'G0004', MESSAGE = 'OBJECT_UNAVAILABLE';
  END IF;

  -- ⑤ 自我撤销**允许**（那是降权，裁定④「允许自查、自撤」）；只禁自授。
  SELECT COALESCE(array_agg(scope ORDER BY scope), ARRAY[]::text[])
    INTO x_scopes_before
    FROM public.admin_scopes
   WHERE admin_id = p_target_id AND revoked_at IS NULL;

  -- ⑥ 撤销：只动有效行（已撤销/不存在 ⇒ 0 行 ⇒ 幂等空操作）。
  UPDATE public.admin_scopes
     SET revoked_at = now()
   WHERE admin_id = p_target_id
     AND scope = p_scope
     AND revoked_at IS NULL;
  GET DIAGNOSTICS x_rows = ROW_COUNT;
  x_changed := x_rows > 0;

  -- ⑦ 最后授权者守卫（裁定⑤，只对元权限 `scopes:write` 生效，且必须**锁内**核验）：
  --    计数只算「有效（revoked_at IS NULL）且 state='active'」的管理员 ⇒ 已停用、元权限已撤销
  --    者不计入。归零即拒绝（明确错误，不是静默成功）。
  IF x_changed AND p_scope = 'scopes:write' THEN
    SELECT count(*)
      INTO x_holders
      FROM public.admin_scopes AS s
      JOIN public.admin_accounts AS a ON a.id = s.admin_id
     WHERE s.scope = 'scopes:write'
       AND s.revoked_at IS NULL
       AND a.state = 'active';

    IF x_holders = 0 THEN
      RAISE EXCEPTION USING
        ERRCODE = 'G0009',
        MESSAGE = 'LAST_SCOPE_MANAGER',
        DETAIL = format(
          '撤销 %s 的 scopes:write 后有效授权者归零（当前 0 个）；系统将永久失去授权维护能力',
          p_target_id
        );
    END IF;
  END IF;

  IF x_changed THEN
    SELECT COALESCE(array_agg(scope ORDER BY scope), ARRAY[]::text[])
      INTO x_scopes_after
      FROM public.admin_scopes
     WHERE admin_id = p_target_id AND revoked_at IS NULL;

    UPDATE public.admin_accounts
       SET revision = revision + 1,
           updated_at = now()
     WHERE id = p_target_id
    RETURNING * INTO x_target;

    x_audit_id := COALESCE(p_audit_id, gen_random_uuid());
    INSERT INTO public.admin_audit_events (
      id, actor_id, action, scope, target_ref, target_hint, reason_code,
      request_id, result, before_value, after_value
    ) VALUES (
      x_audit_id, p_actor_id, 'admin_scope.revoke', p_scope, NULL,
      'admin_account:' || p_target_id::text, 'scope_revoked',
      p_request_id, 'accepted',
      jsonb_build_object('scopes', to_jsonb(x_scopes_before), 'reason', p_reason),
      jsonb_build_object('scopes', to_jsonb(x_scopes_after), 'reason', p_reason)
    )
    RETURNING * INTO x_audit;
  ELSE
    x_scopes_after := x_scopes_before;
  END IF;

  RETURN jsonb_build_object(
    'admin_id', p_target_id,
    'revision', x_target.revision,
    'scopes', to_jsonb(x_scopes_after),
    'changed', x_changed,
    'meta_scope_holders', x_holders,
    'audit_id', CASE WHEN x_changed THEN to_jsonb(x_audit.id) ELSE 'null'::jsonb END,
    'audit_created_at', CASE
      WHEN x_changed THEN to_jsonb(to_char(x_audit.created_at AT TIME ZONE 'UTC',
                                          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      ELSE 'null'::jsonb
    END
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- ⑤ 收回默认 ACL：函数的 `EXECUTE` 默认授予 PUBLIC，这里必须显式收回。
--    运行时的 `EXECUTE` 在 `20-login-roles.sql` 的 `gy-r37-s2-scope-grant` 区域授予；
--    ⛔ 本迁移不给运行时 `admin_scopes` 任何 INSERT/UPDATE（那是 90-assert 的
--    `external_manifest:1540-1542` 与第 9 条 `protected_columns:2256-2263` 钉死的红线）。
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.grant_admin_scope(uuid, uuid, text, text, uuid, uuid, integer)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.revoke_admin_scope(uuid, uuid, text, text, uuid, uuid, integer)
  FROM PUBLIC;

COMMIT;
