-- GY-R34（Refs #18）· 管理端审计日志只读查询面：`GET /admin/audit-logs` 的库内单一只读函数。
--
-- 为什么需要本迁移（改前真读数）：
--   1. `public.admin_audit_events`（0017 建表、0027 加 before/after 两列）对运行时角色
--      `gengyun_api_runtime` **连 SELECT 都没有**（0017 的最小权限裁定；`20-login-roles.sql`
--      只把「开关注入」那一类行的读函数 `list_admin_flag_audit` 的 EXECUTE 授给了运行时）；
--   2. 既有唯一库内读面 `public.list_admin_flag_audit(...)` 在函数体里把 `action = 'set_flag'`
--      写死 ⇒ 同样落在本表的 `account.suspend` / `account.restore` 审计行在库内**没有任何读路径**；
--      而进程内 `GET /admin/audit-events` 只看得见内存 store（real 模式下该路由实测 503）。
--      于是「谁在什么时候停用了哪个账号」这一类事实在真实持久化后就再也查不到。
--   3. 0017 的索引 `admin_audit_events_created_idx (created_at DESC, id DESC)` 只覆盖
--      「全表键集分页」；按动作过滤时，稀有动作（例如 `account.suspend`）必须在索引上
--      扫过大量 `set_flag` 行才能凑满一页。
-- 本迁移只做一件事：新增只读函数 `public.list_admin_audit_logs(...)`。
--   * `SECURITY DEFINER` + `STABLE` + `SET search_path = pg_catalog`（与 0027 的读函数同口径）；
--   * 键集分页 `(created_at DESC, id DESC)`，与既有索引同序（不额外建索引，理由见文末）；
--   * 支持「时间闭区间」与「动作/域」两组可选筛选，全部以**参数**传入（无字符串拼接）；
--   * `target_ref` 在函数内**按允许列表重建**（只留 `type`/`id`/`revision` 三个键）。
--   * EXECUTE 授予不写在这里（运行时角色在这一步还不存在），见
--     `deploy/postgres-cvm/sql/20-login-roles.sql` 的 `gy-r34-audit-logs-grant` 段。
--
-- 为什么仍然走函数、而不是给运行时开 SELECT：
--   审计表里同时有停用/恢复/开关三类动作的**主体与目标**。把整表 SELECT 开给运行时，等于把
--   「将来任何一次新增写入点」也一并开出去（最小权限会随写入点漂移）。函数把可读范围钉在
--   「本签名暴露的列 + 允许列表投影」上：新增列默认不可见，额外键默认不外流。
--
-- 回滚：services/api/db/migrations/rollback/0033_admin_audit_log_read.down.sql
--   （只删函数；审计行本身不删 —— 与 0017 的「只可追加」口径一致）
--
-- ## 不变量（本迁移刻意保持）
--   - 不改 `admin_audit_events` 的任何列/约束/索引/触发器（`admin_audit_events_append_only` 照旧）；
--   - 不改 `public.list_admin_flag_audit`（既有开关留痕读面逐字不变）；
--   - 运行时对 `admin_audit_events` 的**表级**权限仍是零（只看得到函数返回的行）；
--   - 函数内不拼接任何调用方字符串：筛选值一律以标量/数组参数传入（`= ANY(p_actions)`）。
--
-- ## 为什么本迁移不新增索引（实测取舍）
--   既有 `admin_audit_events_created_idx (created_at DESC, id DESC)` 与 ORDER BY 完全同序，
--   无筛选/纯时间区间的第一页与后续页都走它。按 `action` 过滤时**加一条**
--   `(action, created_at DESC, id DESC)` 看起来合理，但读路径是「集合返回的 SECURITY DEFINER
--   函数」（不被内联、`p_actions` 在计划期只是 Param），实测计划器**不会**把它当索引限定，
--   于是新索引只会白白增加审计写入的维护成本。实测读数与「何时该加」写在
--   `docs/architecture/admin-audit-logs.md`（本片真库臂 `tests/integration/admin-audit-logs-pg.mjs`）。

BEGIN;

CREATE OR REPLACE FUNCTION public.list_admin_audit_logs(
  p_limit              integer     DEFAULT 50,
  p_from               timestamptz DEFAULT NULL,
  p_to                 timestamptz DEFAULT NULL,
  p_actions            text[]      DEFAULT NULL,
  p_scopes             text[]      DEFAULT NULL,
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
         -- 允许列表投影：只重建契约声明的三个子字段。审计行里若带额外键（历史行、将来新增的
         -- 写入点、被外部导入的行），**不会**随本函数流到 HTTP 响应里（脱敏发生在库内）。
         CASE
           WHEN e.target_ref IS NULL THEN NULL
           ELSE jsonb_build_object(
             'type', e.target_ref -> 'type',
             'id', e.target_ref -> 'id',
             'revision', e.target_ref -> 'revision'
           )
         END,
         e.target_hint,
         e.reason_code,
         e.request_id,
         e.result::text,
         e.before_value,
         e.after_value,
         e.created_at
    FROM public.admin_audit_events AS e
   WHERE (p_from IS NULL OR e.created_at >= p_from)
     AND (p_to IS NULL OR e.created_at <= p_to)
     AND (p_actions IS NULL OR e.action = ANY (p_actions))
     AND (p_scopes IS NULL OR e.scope = ANY (p_scopes))
     AND (
       p_before_created_at IS NULL
       OR p_before_id IS NULL
       -- 键集分页：严格小于游标（同刻按 id 递减），与 admin_audit_events_created_idx 同序。
       OR (e.created_at, e.id) < (p_before_created_at, p_before_id)
     )
   ORDER BY e.created_at DESC, e.id DESC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
$$;

-- 硬条件：PUBLIC 一律不得执行；EXECUTE 只授予运行时角色（在 20-login-roles.sql 的
-- `gy-r34-audit-logs-grant` 段，运行时角色那一步才创建）。
REVOKE ALL ON FUNCTION public.list_admin_audit_logs(
  integer, timestamptz, timestamptz, text[], text[], timestamptz, uuid
) FROM PUBLIC;

COMMIT;
