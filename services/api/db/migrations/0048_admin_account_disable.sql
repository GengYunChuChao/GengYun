-- 迁移 0048：后台管理员「停用 / 恢复」的唯一写路径（裁定 A-a）
-- =============================================================================
--
-- 本片解决的是**能力缺口**，不是缺陷修复
-- ---------------------------------------------------------------
-- · 今天后台**没有任何**停用管理员账号的写路径：`admin_accounts.state` 的闭集是
--   `('active','suspended')`，但只有读面（`0021`/`list_admin_accounts()`）与授权面
--   （`0041` 的 `grant_admin_scope`/`revoke_admin_scope`，只动 `admin_scopes`）。
--   想让一名管理员立刻失去全部后台能力，唯一能做的是**把他的 scope 逐个撤光** ——
--   而那恰好是错的：撤光 scope 之后账号仍然 `active`、`admin_sessions` 仍然有效、
--   审计读面上这个人仍是「在职」，并且撤最后一个 `scopes:write` 还会被
--   `0041:439-457` 的守卫拦成 409。前作 `docs/verification/gy-r64-pr4b-suspend-guard-20261026.md`
--   因此留了一句判词：「将来真要有管理员停用路径，**新建带同一把 advisory 锁的迁移**」。
--   本迁移就是那条迁移。
-- · 为什么落到库层而不是应用层：`admin_accounts` 对运行时角色 `gengyun_api_runtime` 是
--   **零表级、零列级写权限**（`deploy/postgres-cvm/sql/90-assert-least-privilege.sql` 的
--   external_manifest 与 protected_columns 钉死的红线）。沿用 `0017`/`0041`/`0043`/`0046`/`0047`
--   已裁定的**第三条路**：窄口径 `SECURITY DEFINER` 函数 + `REVOKE ALL … FROM PUBLIC` +
--   只授 `EXECUTE` 给运行时角色。本迁移**不新增任何**表级/列级授权。
-- · ⛔ 不改 `0017` 的 `suspend_account`/`restore_account`（那是**终端用户** `users` 的面，
--   与本节 `admin_accounts` 同名不同源，两者 id 不得混用 —— 裁定③）；
--   ⛔ 不做 `DELETE FROM admin_accounts`（停用是可逆状态迁移，不是删除）；
--   ⛔ 不改 `list_admin_accounts()`（读面本片一点不动）；
--   ⛔ 不新增 scope 值（权限门沿用既有 `scopes:write`，裁定①）。
--
-- 函数签名（顺序即调用顺序，全部必填：没有「可选 actor」这种缝）
-- ---------------------------------------------------------------
--   public.disable_admin_account(
--     p_actor_id          uuid,    -- 操作者的 admin_accounts.id（= 会话身份，不接受调用方另传 actor 列）
--     p_audit_id          uuid,    -- 本条审计事件的 id（调用方生成；重复即审计那一步失败 ⇒ 整笔回滚）
--     p_target_id         uuid,    -- 被停用的 admin_accounts.id（⛔ 不是 users.id）
--     p_expected_revision integer, -- CAS：admin_accounts.revision（NULL ⇒ 无前置条件）
--     p_request_id        uuid,    -- 契约 Meta.request_id
--     p_reason            text     -- 操作理由（自由文本 ≤ 500；**只做形态校验、不落库**，见下）
--   ) RETURNS jsonb                -- 变更后的实测读数（不是算术推断）
--   public.enable_admin_account(…同一签名与同一返回形状…)
--
-- 为什么 `p_reason` 收了却**不落库**（刻意的，不是漏了）
-- ---------------------------------------------------------------
--   审计行可写的五个文本槽位全部被占死或不允许自由文本：
--   · `action` / `scope` / `result` / `reason_code` 在函数体内是**闭集字面量**（见下）；
--   · `target_hint` 固定 `'admin_account:' || id`（≤120，`0017` 的 CHECK）；
--   · `before_value` / `after_value` **必须写 NULL**（见「为什么 before/after 必须是 NULL」）。
--   ⇒ 没有任何一列能容纳自由文本而不伪造语义。这与仓内既有口径逐条同构：
--   `suspendUser`（`admin/ops/service.ts:731`）对 `ReasonInput` 只做 `assertInput` 后**丢弃**；
--   `0017` 的 `suspend_account` 干脆不收 reason；`0047` 收的是**闭集理由码**而非自由文本。
--   收下 `p_reason` 的意义是「把合同字面量钉在签名里 + 判空」，⛔ 不是「先存着以后再说」。
--
-- 锁序（照 `0041:75`，绝不反向）
-- ---------------------------------------------------------------
--   ① `pg_advisory_xact_lock(hashtextextended('admin_scope:scopes:write', 18040))`
--      —— 与 `0041:235`/`0041:389` **同一把键**（盐 18040，`admin_scope:` 前缀 + scope 名）。
--      为什么必须是同一把：本函数的「最后一名 scope 管理者」守卫数的就是
--      `scopes:write` 的有效持有者（`0041:440-446` 同一口径）。若换个键，则
--      「A 停用唯一持有者」与「B 撤销唯一持有者的 scopes:write」两笔并发会**各自**读到
--      「还有一个持有者」，双双放行 ⇒ 系统失去授权维护能力。同一把键把这两笔串行化。
--      这也正是前作裁定那句话的落点：`FOR UPDATE` 只锁目标行，锁不住「另一个管理员同时被撤销」。
--   ② `admin_accounts` 目标行 `FOR UPDATE`（`0041:257` 同序：先取目标行再判版本/状态）。
--   ⛔ 绝不先锁行再取 advisory 锁 —— 那是与 `0041` 相反的锁序，会与授权面死锁。
--
-- 函数内的校验点（顺序固定，任一不成立即 `RAISE EXCEPTION`，什么都不写）
-- ---------------------------------------------------------------
--   ① 入参自检 —— `G0001 INVALID_REQUEST`：任一 uuid 为 NULL、`p_reason` 空/全空白/超 500、
--      `p_expected_revision` 给且 < 1。
--   ② advisory 锁（见上），锁内**重核验操作者**（不采信应用层 HTTP 侧的判定结果）：
--      ③ 操作者存在 —— `G0002 NOT_FOUND`；
--      ④ 操作者 `state = 'active'` —— `G0010 SCOPE_DENIED`；
--      ⑤ 操作者**当前有效**持 `scopes:write`（`revoked_at IS NULL`）—— `G0010 SCOPE_DENIED`。
--   ⑥ 目标行 `FOR UPDATE`：不存在 —— `G0002 NOT_FOUND`；
--   ⑦ CAS —— `p_expected_revision <> revision` ⇒ `G0003 REVISION_CONFLICT`；
--   ⑧ 自停用 —— `p_actor_id = p_target_id` ⇒ **`G0020 SELF_DISABLE_DENIED`**（409，本片新增契约码）。
--      为什么不是 `SCOPE_DENIED`：后者说的是「你没有这项权限」，处置是去申请权限；
--      自停用是「你有权限，但这个动作会把你自己锁在门外」，处置是**换一个人来操作**。
--      （`enable` 不需要这道门：能调它的操作者自己必然是 `active`，自恢复天然是幂等空操作。）
--   ⑨ 幂等 —— 目标已经是 `suspended`（`disable`）/ `active`（`enable`）⇒ 直接返回当前实测行，
--      `changed=false`、`revoked_sessions=0`、`audit_id=NULL`：不迁移、不递增 `auth_epoch`、
--      不撤会话、**不写第二条审计**。与 `0017:177-191`（停用幂等）逐条同构。
--   ⑩ 状态迁移（`disable`：`state='suspended'`；`enable`：`state='active'`）+
--      `auth_epoch = auth_epoch + 1` + `revision = revision + 1` + `updated_at = now()`。
--      `auth_epoch` 是**旧令牌立即失效的唯一依据**（`auth/middleware.ts:131` 比对
--      `session.authEpoch !== admin.authEpoch` ⇒ `ACCOUNT_INACTIVE`）；只撤会话行、不推 epoch，
--      会给「故障窗口内签发/被漏撤的会话」留复活口。`enable` 也推 epoch —— 停用期间的会话
--      **不得**因恢复而复活（`0017:299-300` 同一句判词）。
--   ⑪ 撤会话：`UPDATE public.admin_sessions SET revoked_at = now()
--      WHERE admin_id = p_target_id AND revoked_at IS NULL`，`GET DIAGNOSTICS … ROW_COUNT`
--      如实回填 `revoked_sessions`。`enable` 也撤一遍（第二道保险，与 `0017:301-304` 同）。
--   ⑫ **最后一名 `scopes:write` 持有者守卫**（锁内，计数口径与 `0041:440-446` 完全相同：
--      只算 `revoked_at IS NULL` **且** `state = 'active'` 的持有者）：
--      目标停用后归零 ⇒ 抛与 `0041:448-456` **同一个** `G0009 LAST_SCOPE_MANAGER`（409）。
--      ⛔ 不另造新码：值班看到的是同一件事「系统即将永久失去授权维护能力」，处置也同一件事。
--      触发条件是「目标确实有效持 `scopes:write`」（先算 `x_target_holds_meta`）；
--      停用一个不持元权限的管理员永远不会把计数打到 0，那时不该拦。
--      计数放在 `UPDATE` **之后**（目标已被排除在 `state='active'` 之外）—— 与 `0041` 的
--      「先撤行、再数」同序，避免「数出来还有 1 个（自己）」的经典错。
--   ⑬ 审计：与状态迁移**同一事务**（`0017:208-216` 同体例）。
--   ⛔ 顺序不可换：守卫必须在 `UPDATE` 之前**读**、之后**数**，审计必须在所有守卫之后 ——
--      被拒的那一笔不允许留下审计行（`RAISE` 会把整个事务连同 `UPDATE` 一起回滚，所以
--      「先写审计再守卫」也不会漏行，但那样审计与拒绝理由的对应关系会散在两个地方）。
--
-- 为什么 `before_value` / `after_value` **必须是 NULL**
-- ---------------------------------------------------------------
--   契约里 `AdminAuditLogView.before_value` / `after_value` 的类型是
--   `FlagReading | null`（`{enabled: boolean, revision: number}` 或 NULL），而
--   `services/api/src/admin/audit/pg.ts:129-145`（`toAuditLogReading`）对**任何**非 NULL 且不是
--   该形状的 jsonb **抛 503**（`PROVIDER_UNAVAILABLE`）。`admin_audit_events` 是 append-only 的
--   （`0017:113-115` 的触发器把 UPDATE/DELETE 一律 `RAISE G0006`）⇒ 一旦写进一个畸形值，
--   **那条审计行永久读不出来，且删不掉**。`0041` 写的 `{scopes, reason}` 形状因此是**既有缺陷**
--   （本片不修它：`0041` 的正文改一个字节 checksum 就拒，属于另一条迁移），本片只保证
--   **新写入的两个 action 不扩大这个缺陷**。这两个动作的「前后值」就是账号行的
--   `state/auth_epoch/revision`，读面另有 `list_admin_accounts()` 与强 ETag，不在这里重复一份
--   （与 `0047:74-75` 对 `post.hide` 的取舍同源）。
--
-- 为什么调用方伪造不了审计内容
-- ---------------------------------------------------------------
--   · `actor_id` 只能是入参 `p_actor_id`，且必须先过 ③④⑤ 三道锁内核验；
--   · `action` / `scope` / `result` / `reason_code` 在函数体内是**字面量**
--     （`'admin_account.disable'` / `'admin_account.enable'` / `'scopes:write'` / `'accepted'` /
--      `'admin_account_disabled'` / `'admin_account_enabled'`），调用方改不了；
--   · `target_ref` 固定 `NULL`（不接收 jsonb 入参 ⇒ 绕不过 `0017:96-110` 的形状 CHECK，
--     也不会撞上 `admin/audit/pg.ts` 的 `TARGET_REF_TYPES` 闭集）；
--   · `target_hint` 由形参重建（`'admin_account:' || p_target_id::text`）；
--   · `request_id` 只用于把审计行与请求对齐，不参与任何授权判定。
--
-- 错误码（运行期：函数被调用时才可能抛出）
-- ---------------------------------------------------------------
--   G0001 INVALID_REQUEST       入参不成立
--   G0002 NOT_FOUND             操作者或目标 admin_accounts.id 不存在
--   G0003 REVISION_CONFLICT     If-Match 与 admin_accounts.revision 不符
--   G0009 LAST_SCOPE_MANAGER    停用后 scopes:write 有效持有者归零（与 0041 同一个码）
--   G0010 SCOPE_DENIED          操作者非 active / 当前未有效持 scopes:write
--   G0020 SELF_DISABLE_DENIED   停用自己（本片新增；`G0018`/`G0019` 已被 0047 取用）
--
-- 回滚：`rollback/0048_admin_account_disable.down.sql`（只 `DROP FUNCTION IF EXISTS`，
--   ⛔ 不删审计行 —— append-only 台账不吃回滚）。
--
-- 号位：当前正向最大号是 `0047`（`0047_admin_post_hide_audit.sql`）⇒ 取最大号 + 1 = `0048`。
--   `services/api/db/migration-reservations.json` 不新增条目（本片即落盘，不经预留）。
BEGIN;

-- ---------------------------------------------------------------------------
-- ① 停用：唯一写路径
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.disable_admin_account(
  p_actor_id          uuid,
  p_audit_id          uuid,
  p_target_id         uuid,
  p_expected_revision integer,
  p_request_id        uuid,
  p_reason            text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET TimeZone = 'UTC'
AS $$
DECLARE
  x_actor             public.admin_accounts%ROWTYPE;
  x_target            public.admin_accounts%ROWTYPE;
  x_audit             public.admin_audit_events%ROWTYPE;
  x_rows              integer := 0;
  x_revoked           integer := 0;
  x_holders           bigint := 0;
  x_target_holds_meta boolean := false;
  x_changed           boolean := false;
BEGIN
  -- ① 入参自检：非法即 G0001（不把 CHECK 违反当「服务器错误」外泄）。
  IF p_actor_id IS NULL
     OR p_audit_id IS NULL
     OR p_target_id IS NULL
     OR p_request_id IS NULL
     OR p_reason IS NULL OR btrim(p_reason) = '' OR length(p_reason) > 500
     OR (p_expected_revision IS NOT NULL AND p_expected_revision < 1)
  THEN
    RAISE EXCEPTION USING ERRCODE = 'G0001', MESSAGE = 'INVALID_REQUEST';
  END IF;

  -- ② 事务级 advisory 锁：与 0041 **同一把键**（`admin_scope:` + scope 名 + 盐 18040）。
  --    串行化的区间是「守卫计数 + 状态迁移」，不是「这一行」。
  PERFORM pg_advisory_xact_lock(hashtextextended('admin_scope:scopes:write', 18040));

  -- ③ 锁内重核验操作者（裁定⑤「不能应用层先判后写」的同一原则）。
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

  -- ④ 目标行锁 + 存在/版本门（顺序同 0017：先 CAS，再状态）。
  SELECT * INTO x_target FROM public.admin_accounts WHERE id = p_target_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'G0002', MESSAGE = 'NOT_FOUND';
  END IF;
  IF p_expected_revision IS NOT NULL AND p_expected_revision <> x_target.revision THEN
    RAISE EXCEPTION USING ERRCODE = 'G0003', MESSAGE = 'REVISION_CONFLICT';
  END IF;

  -- ⑤ 禁止自我停用（裁定：自停用 ⇒ 409，不是 403 —— 见文件头）。
  IF p_actor_id = p_target_id THEN
    RAISE EXCEPTION USING
      ERRCODE = 'G0020',
      MESSAGE = 'SELF_DISABLE_DENIED',
      DETAIL = format('操作者 %s 试图停用自己；请由另一名持 scopes:write 的管理员执行', p_actor_id);
  END IF;

  -- ⑥ 幂等：已停用 ⇒ 当前行原样返回，零副作用、零第二条审计（0017:177-191 同）。
  IF x_target.state = 'suspended' THEN
    RETURN jsonb_build_object(
      'admin_id', x_target.id,
      'state', x_target.state::text,
      'revision', x_target.revision,
      'auth_epoch', x_target.auth_epoch,
      'revoked_sessions', 0,
      'changed', false,
      'audit_id', NULL::uuid,
      'audit_created_at', NULL::text
    );
  END IF;

  -- ⑦ 守卫的前置事实：目标是否**有效**持 scopes:write（`revoked_at IS NULL`，与 state 无关）。
  --    停用本就不持元权限的人，计数不可能归零 ⇒ 不该拦。
  x_target_holds_meta := EXISTS (
    SELECT 1
      FROM public.admin_scopes AS s
     WHERE s.admin_id = p_target_id
       AND s.scope = 'scopes:write'
       AND s.revoked_at IS NULL
  );

  -- ⑧ 状态迁移：state + auth_epoch（旧令牌失效的唯一依据）+ revision 前进。
  UPDATE public.admin_accounts
     SET state = 'suspended',
         auth_epoch = auth_epoch + 1,
         revision = revision + 1,
         updated_at = now()
   WHERE id = p_target_id
     AND state = 'active'
  RETURNING * INTO x_target;
  GET DIAGNOSTICS x_rows = ROW_COUNT;
  x_changed := x_rows > 0;

  -- ⑨ 撤该管理员**全部**活跃会话（不是当前一个）。
  UPDATE public.admin_sessions
     SET revoked_at = now()
   WHERE admin_id = p_target_id
     AND revoked_at IS NULL;
  GET DIAGNOSTICS x_revoked = ROW_COUNT;

  -- ⑩ 最后一名 scopes:write 持有者守卫（锁内；计数口径与 0041:440-446 逐字相同）。
  IF x_changed AND x_target_holds_meta THEN
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
          '停用 %s 后有效授权者归零（当前 0 个）；系统将永久失去授权维护能力',
          p_target_id
        );
    END IF;
  END IF;

  -- ⑪ 审计（action/scope/reason_code 在函数内固定 ⇒ 调用方无法伪造文本），同事务。
  --    before/after **显式写 NULL**：见文件头「为什么必须是 NULL」。
  INSERT INTO public.admin_audit_events (
    id, actor_id, action, scope, target_ref, target_hint, reason_code,
    request_id, result, before_value, after_value
  ) VALUES (
    p_audit_id, p_actor_id, 'admin_account.disable', 'scopes:write', NULL,
    'admin_account:' || p_target_id::text, 'admin_account_disabled',
    p_request_id, 'accepted', NULL, NULL
  )
  RETURNING * INTO x_audit;

  RETURN jsonb_build_object(
    'admin_id', x_target.id,
    'state', x_target.state::text,
    'revision', x_target.revision,
    'auth_epoch', x_target.auth_epoch,
    'revoked_sessions', x_revoked,
    'changed', x_changed,
    'audit_id', x_audit.id,
    'audit_created_at', to_char(x_audit.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
END;
$$;

COMMENT ON FUNCTION public.disable_admin_account(uuid, uuid, uuid, integer, uuid, text) IS
  '后台管理员停用的唯一写路径（迁移 0048）：同一事务内 advisory 锁（与 0041 同键）→ 重核验操作者 '
  '→ 目标行 FOR UPDATE → CAS → 禁止自停用 → 最后一名 scopes:write 持有者守卫 → '
  'state=suspended / auth_epoch+1 / revision+1 → 撤销全部 admin_sessions → 写一行 '
  'action=admin_account.disable 审计（before/after 为 NULL）。EXECUTE 只授 gengyun_api_runtime'
  '（20-login-roles.sql 的 gy-r64-admin-account-authority-grant 区）。';

-- ---------------------------------------------------------------------------
-- ② 恢复（启用）：停用的反向，同一把锁、同一套门、同一套读数
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enable_admin_account(
  p_actor_id          uuid,
  p_audit_id          uuid,
  p_target_id         uuid,
  p_expected_revision integer,
  p_request_id        uuid,
  p_reason            text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET TimeZone = 'UTC'
AS $$
DECLARE
  x_actor   public.admin_accounts%ROWTYPE;
  x_target  public.admin_accounts%ROWTYPE;
  x_audit   public.admin_audit_events%ROWTYPE;
  x_rows    integer := 0;
  x_revoked integer := 0;
  x_changed boolean := false;
BEGIN
  -- ① 入参自检（同 disable）。
  IF p_actor_id IS NULL
     OR p_audit_id IS NULL
     OR p_target_id IS NULL
     OR p_request_id IS NULL
     OR p_reason IS NULL OR btrim(p_reason) = '' OR length(p_reason) > 500
     OR (p_expected_revision IS NOT NULL AND p_expected_revision < 1)
  THEN
    RAISE EXCEPTION USING ERRCODE = 'G0001', MESSAGE = 'INVALID_REQUEST';
  END IF;

  -- ② 同一把 advisory 锁：恢复与停用/授权撤销互斥（「谁会被数进守卫」在同一把锁下判定）。
  PERFORM pg_advisory_xact_lock(hashtextextended('admin_scope:scopes:write', 18040));

  -- ③ 锁内重核验操作者。
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

  -- ④ 目标行锁 + 存在/版本门。
  SELECT * INTO x_target FROM public.admin_accounts WHERE id = p_target_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'G0002', MESSAGE = 'NOT_FOUND';
  END IF;
  IF p_expected_revision IS NOT NULL AND p_expected_revision <> x_target.revision THEN
    RAISE EXCEPTION USING ERRCODE = 'G0003', MESSAGE = 'REVISION_CONFLICT';
  END IF;

  -- ⑤ 幂等：已是 active ⇒ 当前行原样返回，零副作用、零第二条审计
  --    （自恢复天然落到这条分支：能调本函数的操作者自己必然 active）。
  IF x_target.state = 'active' THEN
    RETURN jsonb_build_object(
      'admin_id', x_target.id,
      'state', x_target.state::text,
      'revision', x_target.revision,
      'auth_epoch', x_target.auth_epoch,
      'revoked_sessions', 0,
      'changed', false,
      'audit_id', NULL::uuid,
      'audit_created_at', NULL::text
    );
  END IF;

  -- ⑥ 状态迁移：恢复也推 auth_epoch —— 停用期间若有漏网会话，恢复**不得**让它复活
  --    （epoch 已再前进一次，撤行是第二道保险；0017:299-300 同一句判词）。
  UPDATE public.admin_accounts
     SET state = 'active',
         auth_epoch = auth_epoch + 1,
         revision = revision + 1,
         updated_at = now()
   WHERE id = p_target_id
     AND state = 'suspended'
  RETURNING * INTO x_target;
  GET DIAGNOSTICS x_rows = ROW_COUNT;
  x_changed := x_rows > 0;

  -- ⑦ 恢复也撤一遍活跃会话（第二道保险）。
  UPDATE public.admin_sessions
     SET revoked_at = now()
   WHERE admin_id = p_target_id
     AND revoked_at IS NULL;
  GET DIAGNOSTICS x_revoked = ROW_COUNT;

  -- ⑧ 审计，同事务；before/after 必须 NULL（同 disable）。
  INSERT INTO public.admin_audit_events (
    id, actor_id, action, scope, target_ref, target_hint, reason_code,
    request_id, result, before_value, after_value
  ) VALUES (
    p_audit_id, p_actor_id, 'admin_account.enable', 'scopes:write', NULL,
    'admin_account:' || p_target_id::text, 'admin_account_enabled',
    p_request_id, 'accepted', NULL, NULL
  )
  RETURNING * INTO x_audit;

  RETURN jsonb_build_object(
    'admin_id', x_target.id,
    'state', x_target.state::text,
    'revision', x_target.revision,
    'auth_epoch', x_target.auth_epoch,
    'revoked_sessions', x_revoked,
    'changed', x_changed,
    'audit_id', x_audit.id,
    'audit_created_at', to_char(x_audit.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
END;
$$;

COMMENT ON FUNCTION public.enable_admin_account(uuid, uuid, uuid, integer, uuid, text) IS
  '后台管理员恢复的唯一写路径（迁移 0048）：与 disable 同一把 advisory 锁、同一套操作者核验与 CAS；'
  'state=active / auth_epoch+1 / revision+1 → 再撤一遍 admin_sessions（旧令牌不得复活）→ 写一行 '
  'action=admin_account.enable 审计（before/after 为 NULL）。EXECUTE 只授 gengyun_api_runtime'
  '（20-login-roles.sql 的 gy-r64-admin-account-authority-grant 区）。';

-- ---------------------------------------------------------------------------
-- ③ 收回默认 ACL：函数的 `EXECUTE` 默认授予 PUBLIC，这里必须显式收回。
--    运行时的 `EXECUTE` 在 `deploy/postgres-cvm/sql/20-login-roles.sql` 的
--    `gy-r64-admin-account-authority-grant` 区域授予（与 0017/0041/0043/0046/0047 同一体例：
--    迁移只收回，授予以部署脚本为唯一出处）。
--    ⛔ 本迁移不给运行时 `admin_accounts`/`admin_sessions`/`admin_audit_events` 任何表级/列级权限。
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.disable_admin_account(uuid, uuid, uuid, integer, uuid, text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enable_admin_account(uuid, uuid, uuid, integer, uuid, text)
  FROM PUBLIC;

COMMIT;
