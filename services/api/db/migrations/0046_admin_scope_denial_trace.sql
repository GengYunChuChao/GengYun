-- 迁移 0046：后台管理员 scope 的**拒绝也留痕**（`#18` S2 收尾片 · 库层一半，Refs #18）
-- =============================================================================
--
-- 执行口径来源（不得由实现者改口径）
-- ---------------------------------------------------------------
--   `.pg17/ruling-r64-pr4-design-20261026.md` 裁定 B（第二连接旁路写）
--   `.pg17/ruling-r37-issue18-s2-scope-admin-20261025.md`（`0041` 的六点裁定，本片沿用其体例）
--
-- 为什么必须新开一支迁移、⛔ 不改任何既有迁移
-- ---------------------------------------------------------------
-- · `0041_admin_scope_write_authority.sql:42-44` 已经把话说死：「拒绝也留痕」需要**第二个事务**
--   （抛异常必然回滚本事务，被拒那一笔的 `INSERT` 会跟着没），属 PR-3/写面，`0041` 自己
--   「本片不实现也不假装实现」。本迁移就是补上那条**第二个事务里的写入口**。
-- · `public.admin_audit_events`（`0017_account_suspend_authority.sql:72-95` 建 10 列、
--   `0027_admin_audit_observability.sql` 加 `before_value`/`after_value` 两列）**不需要改表**：
--   `result` 的 CHECK 已经包含 `'denied'`（`0017:83`：`result IN ('accepted','denied','failed')`），
--   `reason_code` 是 NOT NULL 且长度 1..64（`0017:81`），`action` 是 varchar(64) 且只查长度
--   （`0017:76`）⇒ 新增 `action='admin_scope.deny'` 不撞任何形状约束。
--   ⛔ 本迁移**不动** `0017` / `0027` / `0033` / `0041` / `0043` 一个字节（`services/api/src/db/migrate.ts`
--   对整份 SQL 取 SHA256，改一字节即拒绝既有库升级）。
-- · ⛔ 不给运行时 `admin_audit_events` 任何表级/列级 INSERT：
--   `deploy/postgres-cvm/sql/90-assert-least-privilege.sql` 的 `external_manifest` 把该表表级
--   S/I/U/D 钉成 false、列级 ins/upd 是空数组，槽 9 的 `protected_columns` 再钉死关键列；
--   表上还有 `admin_audit_events_append_only` 触发器（UPDATE/DELETE 一律 `G0006`）。
--   ⇒ 沿用 `0017:4-24` / `0027:1-31` / `0041:8-19` / `0043:13-18` 已裁定的**第三条路**：
--   **窄口径 `SECURITY DEFINER` 函数 + `REVOKE ALL … FROM PUBLIC` + 只授 `EXECUTE` 给运行时角色**。
--
-- ## ⚠ 这条函数记的是「应用层申报」，不是「库层证明」——必须如实登记
--
-- 这是本迁移最容易被误读的一处，写在这里而不是只写在 PR 里：
--
--   1. 被拒的那一刻，主事务已经 `ROLLBACK`，`0041` 的
--      `pg_advisory_xact_lock(hashtextextended('admin_scope:' || p_scope, 18040))`
--      是**事务级**锁 ⇒ 随主事务一起**已经释放**。等这条函数在**第二个事务**里被调用时，
--      库里看不到任何「刚才那次被拒」的痕迹。
--   2. 因此库层**无从复算**「当时到底有几个 `scopes:write` 有效持有者」「操作者当时是否
--      持着 `scopes:write`」「`p_scope` 是不是操作者当时有效持有的」——这些谓词只在被拒的
--      那一瞬成立，事后重算得到的是**另一个时点**的事实。
--   3. ⇒ `reason_code` 只能由**调用方申报**（闭集四值），本函数不重核、也不假装重核。
--      能写进来的只能是「某个调用方说：这次被拒的原因是这个」。要把它当证明用就是误读。
--   4. ⇒ 反过来，本函数**刻意不做**的两条重核验（裁定 B 明写）：
--      · ⛔ **不核 actor 是否 `state='active'`**；
--      · ⛔ **不核 actor 是否当前有效持 `scopes:write`**。
--      理由同一条：被拒的正是「你不持 / 会归零 / 越权」。若这里再核一遍，凡「因为不持
--      `scopes:write` 而被拒」的行都会被这条重核验**再拒一次** ⇒ 该记的行一条也留不下，
--      留痕函数反而成了「只有没被拒的人才记得下自己曾被拒」的荒谬形状。
--      **只核 `actor` 存在**（`admin_accounts` 里查得到这一行）：那是一条与拒绝理由正交的
--      事实，`actor_id` 还挂着 `admin_audit_events.actor_id` 的语义，写一个不存在的 actor
--      等于往审计台账里塞幽灵主体。
--
-- ## 与 `0041` / `0043` 的对称性（同一个「被拒/成功」的两面）
--
--   | | 成功面（`0041`，主事务内） | 拒绝面（本迁移，第二个事务） |
--   |---|---|---|
--   | action | `admin_scope.grant` / `admin_scope.revoke` | `admin_scope.deny` |
--   | result | `accepted` | `denied` |
--   | actor 重核验 | 存在 + `active` + 有效持 `scopes:write` | **只**核存在 |
--   | 谁来解释「为什么」 | 库层可复算（谓词都在事务里） | 调用方申报（闭集四值） |
--
-- ## 函数签名（顺序即调用顺序；只有 `p_audit_id` 有默认值）
--
--   public.record_admin_scope_denial(
--     p_actor_id    uuid,   -- 被拒的操作者 admin_accounts.id（= 会话身份，不接受调用方另传 actor 列）
--     p_target_id   uuid,   -- 被操作的管理员 admin_accounts.id（只用于拼 target_hint，不核存在性）
--     p_scope       text,   -- 涉及的 scope，必须是后台权限闭集 13 项之一
--     p_reason_code text,   -- 拒绝理由码，闭集四值（见下）
--     p_request_id  uuid,   -- 契约 Meta.request_id
--     p_audit_id    uuid DEFAULT NULL  -- NULL ⇒ 函数内 gen_random_uuid()
--   ) RETURNS uuid          -- 写入行的 public.admin_audit_events.id
--
-- ## 写死的列（调用方改不了，也不收任何 jsonb 旁路参数）
--
--   action      = 'admin_scope.deny'                        （字面量）
--   result      = 'denied'                                  （字面量）
--   scope       = p_scope                                   （已过闭集）
--   target_ref  = NULL                                      （契约 TargetRef 闭集没有 account，同 0017/0041/0043）
--   target_hint = 'admin_account:' || p_target_id::text      （≤ 120，见 0017:80 的 CHECK）
--   reason_code = p_reason_code                             （已过闭集）
--   actor_id    = p_actor_id                                （已过「存在」）
--   request_id  = p_request_id
--   before_value / after_value 不写（拒绝没有「变更前后」的事实，留 NULL 比编一个诚实）
--
-- ## 拒绝理由闭集（四值，与 `0041` 的四个运行期错误码一一对应）
--
--   self_scope_grant_denied  ← G0008 SELF_SCOPE_GRANT_DENIED  （自授）
--   last_scope_manager       ← G0009 LAST_SCOPE_MANAGER       （撤销后元权限持有者归零）
--   scope_denied             ← G0010 SCOPE_DENIED             （操作者非 active / 不持 scopes:write）
--   scope_not_held           ← G0011 SCOPE_NOT_HELD           （授予自己并不有效持有的 scope）
--
--   为什么是闭集而不是自由文本（同 `0043:58-60` 的理由）：`reason_code` 是审计读面的
--   分类维度。放开成自由文本，任何能调用本函数的进程都能让台账读起来像「因 X 被拒」——
--   那是伪造审计**语义**。**拓宽闭集必须新增迁移**（这是刻意的代价）。
--
-- ## 后台权限闭集（13 项）与 `0041` 的 CHECK 必须逐字同源
--
--   取值依据见 `0041:104-115` 的注释（`packages/contracts/openapi.json` 的
--   `SessionInfo.scopes.items.enum` 12 项 − `user` + 本片前一支新增的 `scopes:read`/`scopes:write`）。
--   本函数收到闭集外的 scope ⇒ `G0001`（**不写行**）。
--   ⚠ 这一份与 `0041` 的 `admin_scopes_scope_closed_set` 必须逐字同源：真库臂
--   `tests/integration/third-party-deletion-sql-pg.mjs` 的 `[K]` 臂用闭集外取值打这一条，
--   `tests/unit/admin-scope-denial-trace.test.mjs` 拿两侧清单对拍（漂移即红）。
--
-- ## 错误码（都是**运行期**错误码，不是迁移期预检）
--
--   G0001 INVALID_REQUEST  入参不合法：空 uuid（actor/target/request）/ 空或超长的 scope /
--                          scope 不在 13 项闭集 / 空或超长的 reason_code / reason_code 不在四值闭集
--   G0002 NOT_FOUND        `p_actor_id` 在 `admin_accounts` 里查不到
--   `23505`（审计 id 撞主键）如实上抛 —— 本函数不做 `ON CONFLICT`，也不吞错。
--   ⛔ 本迁移**不新增**任何契约错误码（G 码是库层内部码，HTTP 映射在新片的应用层）。
--
-- ## 幂等
--
--   不幂等，而且**刻意不幂等**：一次被拒就是一次事件。同一 `(actor, target, scope, reason)`
--   反复被拒应当留下多行——这正是「有人在反复撞门」的唯一读数。审计表没有可冲突的业务键
--   （`id` 由 `p_audit_id` 或 `gen_random_uuid()` 给，撞了就是调用方给错了 id ⇒ 23505 上抛）。
--
-- ## EXECUTE 授予为什么不在本迁移
--
--   运行时 LOGIN 角色 `gengyun_api_runtime` 在**迁移之后**才创建
--   （正确顺序：`migrate.ts up` ⇒ `20-login-roles.sql`），所以授权落在
--   `deploy/postgres-cvm/sql/20-login-roles.sql` 的
--   `#region gy-r64-pr4a-denial-trace-grant` 区域；本迁移只收回函数默认 ACL 里对 `PUBLIC` 的
--   `EXECUTE`。函数面在 `90-assert-least-privilege.sql` 的 `function_surface_manifest` 追加一行
--   `runtime`（断言 90 要求每个 SECURITY DEFINER 必须登记、91 要求 PUBLIC 不可执行、
--   92 要求 grantee 集合**精确**等于 `{gengyun_api_runtime}`）。
--
-- 回滚：`rollback/0046_admin_scope_denial_trace.down.sql`（`DROP FUNCTION IF EXISTS`，只删函数）
--
-- 号位：当前正向最大号 `0045`、`0037` 是保留台账里的在途缺号（owner `#14`）
--   ⇒ 取最大号 +1 = `0046`（本片即落盘，`services/api/db/migration-reservations.json`
--   **不新增条目**）。⛔ 不碰 `0037`。
BEGIN;

-- ---------------------------------------------------------------------------
-- ① 拒绝留痕：第二个事务里的唯一写路径（一次调用 = 一行 `result='denied'`）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_admin_scope_denial(
  p_actor_id    uuid,
  p_target_id   uuid,
  p_scope       text,
  p_reason_code text,
  p_request_id  uuid,
  p_audit_id    uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET TimeZone = 'UTC'
AS $$
DECLARE
  -- 后台权限闭集（13 项）。⚠ 与 `0041_admin_scope_write_authority.sql` 的
  -- `admin_scopes_scope_closed_set` CHECK **必须逐字同源**（两侧漂移即判红：
  -- `tests/unit/admin-scope-denial-trace.test.mjs` 拿清单对拍）。
  x_scope_allowed text[] := ARRAY[
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
  -- 拒绝理由闭集（四值）。与 0041 的 G0008/G0009/G0010/G0011 一一对应；
  -- 拓宽它必须新增迁移（见文件头「拒绝理由闭集」一段）。
  x_reason_allowed text[] := ARRAY[
    'self_scope_grant_denied',
    'last_scope_manager',
    'scope_denied',
    'scope_not_held'
  ]::text[];
  x_actor_found integer;
  x_audit_id    uuid;
BEGIN
  -- ① 入参自检：非法即 G0001（不把 CHECK 违反当「服务器错误」外泄）。
  --    注意 ⛔ 这里**不**校验「操作者是否 active / 是否持 scopes:write」——见文件头那段：
  --    被拒的正是这件事，重核验会把要记的行全拒掉。
  IF p_actor_id IS NULL
     OR p_target_id IS NULL
     OR p_request_id IS NULL
     OR p_scope IS NULL OR btrim(p_scope) = '' OR length(p_scope) > 40
     OR NOT (p_scope = ANY (x_scope_allowed))
     OR p_reason_code IS NULL OR btrim(p_reason_code) = '' OR length(p_reason_code) > 64
     OR NOT (p_reason_code = ANY (x_reason_allowed))
  THEN
    RAISE EXCEPTION USING ERRCODE = 'G0001', MESSAGE = 'INVALID_REQUEST';
  END IF;

  -- ② 只核 actor **存在**（唯一的一条核验，且与拒绝理由正交）。
  --    `admin_accounts` 对运行时是零直读权，所以只能在 definer 内读
  --    （与 0017/0041/0043 同一形状）。
  SELECT 1 INTO x_actor_found FROM public.admin_accounts WHERE id = p_actor_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'G0002', MESSAGE = 'NOT_FOUND';
  END IF;

  -- ③ 留痕：action / result / target_ref 在函数内固定，scope 与 reason_code 已过闭集，
  --    target_hint 由形参重建 ⇒ 调用方没有伪造动作文本或 target 的缝隙。
  x_audit_id := COALESCE(p_audit_id, gen_random_uuid());

  INSERT INTO public.admin_audit_events (
    id, actor_id, action, scope, target_ref, target_hint, reason_code,
    request_id, result
  ) VALUES (
    x_audit_id,
    p_actor_id,
    'admin_scope.deny',
    p_scope,
    NULL,
    'admin_account:' || p_target_id::text,
    p_reason_code,
    p_request_id,
    'denied'
  );

  RETURN x_audit_id;
END;
$$;

COMMENT ON FUNCTION public.record_admin_scope_denial(uuid, uuid, text, text, uuid, uuid) IS
  '后台管理员 scope 操作被拒时的留痕写入口（迁移 0046）：只核 actor 存在，'
  '同事务向 public.admin_audit_events 写一行 action=admin_scope.deny、result=denied、'
  'target_ref=NULL、target_hint=admin_account:<target>，返回该行 id。'
  '⚠ 这是**应用层申报**，不是**库层证明**：调用发生在主事务 ROLLBACK 之后、0041 的事务级 '
  'advisory 锁已释放，库无从复算「当时为什么被拒」；reason_code 由调用方从闭集四值中申报。'
  'EXECUTE 只授 gengyun_api_runtime（20-login-roles.sql 的 gy-r64-pr4a-denial-trace-grant）。';

-- ---------------------------------------------------------------------------
-- ② 收回默认 ACL：PG 新建函数的 `EXECUTE` 默认授予 `PUBLIC`，这里必须显式收回。
--    运行时的 `EXECUTE` 在 `20-login-roles.sql` 的 `gy-r64-pr4a-denial-trace-grant` 区域授予；
--    ⛔ 本迁移不给运行时 `admin_audit_events` 任何 INSERT（那是 90-assert 的 external_manifest
--    与槽 9 protected_columns 钉死的红线）。
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.record_admin_scope_denial(uuid, uuid, text, text, uuid, uuid)
  FROM PUBLIC;

COMMIT;
