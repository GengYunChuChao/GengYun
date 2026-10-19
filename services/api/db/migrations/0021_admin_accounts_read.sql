-- GY-I18（#18）· 后台账号读面 `GET /admin/accounts` 接到真实 `public.users`
--
-- ## 为什么是第二个 SECURITY DEFINER 读函数（与 0016/0017 同一条裁定）
-- `services/api/db/roles/auth_privacy.sql` 授予运行时角色 `gengyun_api_runtime` 的
-- `public.users` 列权限只有 `SELECT (id,state,auth_epoch,revision,wechat_subject_lookup)`
-- 与 `UPDATE (updated_at)`。派单 §2.1 的逐字 SQL
--   `SELECT id, revision, state, nickname FROM public.users ORDER BY created_at ASC, id ASC`
-- 在运行时角色下必然 `permission denied for table users`（`42501`；本机 PG 17.11 实测原文见证据页
-- `docs/verification/gy-i18-admin-accounts-read-20261018.md`）。三条替代路径均被否决：
--   ① 给运行时补 `SELECT (nickname)` / `SELECT (created_at)` —— 放宽最小权限，直接违反派单
--      「⛔ 不读任何 wechat/auth_epoch/deletion_generation 列」的边界与 90 号断言的口径；
--   ② API 进程再开一条特权连接 —— 等价于把运营方凭据放进运行时进程；
--   ③ 读面退回内存种子/`admin_accounts` —— 会把「无权回答」伪装成「平台没有账号」（伪造结论）。
-- 因此沿用 0016/0017 的第三条路：把这条读收敛进**唯一一个窄口径函数**，属主是迁移执行者，
-- 运行时角色**只**拿到 EXECUTE。运行时对 `users` 的直接列权限**逐字不变**，反向控制见 90 号断言 37。
--
-- ## 输出列被钉死的理由（契约 `AdminAccountView`）
-- 恰好 `id / revision / state / display_name` 四列（`additionalProperties: false`）：
--   - `display_name` 复用 0017 的 `public.admin_account_display_name(nickname, id)`：`users.nickname`
--     可空而契约 `display_name` 是 `required / minLength:1 / maxLength:80`，空串会**违反契约**。
--     派单 §2.1 原文的 `nickname ?? ''` 映射已由指挥裁定（2026-10-18 裁定 A）换成本函数；
--     差异与理由记在交接 `与派单的差异` 一节。
--   - `state` 用 0001 的 `public.user_state` 全集（active/suspended/deletion_pending/deleted）校验，
--     越界即 `RAISE EXCEPTION`（⛔ 不静默折叠成 `active`）。注意契约 `AdminAccountView.state` 闭集
--     只有 3 个值：`deleted` 行会让**适配层** fail-closed 503（残余限制，见证据页「未取得项」）。
--   - 排序固定为 `created_at ASC, id ASC`（与派单逐字一致，放在函数内）；调用方不再二次排序，
--     因为 `created_at` **不在**输出白名单里。
--
-- ## 四条硬条件（与 0017 同口径，逐条落实位置）
-- 1. `SET search_path = pg_catalog`（**固定**，不写 `public`、不用 `$user`），函数体内所有对象写全限定名
--    —— 与 0016/0017 及 `90-assert-least-privilege.sql` 的既有断言逐字一致；
-- 2. `REVOKE ALL ... FROM PUBLIC`（本文件末尾）+ 只 `GRANT EXECUTE ... TO gengyun_api_runtime`
--    （放 `deploy/postgres-cvm/sql/20-login-roles.sql` 的 `gy-i18-accounts-read-grant` 区域：
--    该角色在迁移之后才创建）；
-- 3. `90-assert-least-privilege.sql` 只**新增**函数级/列级断言（存在且唯一、SECURITY DEFINER、
--    search_path、属主、EXECUTE 仅授予运行时角色、以及「运行时对 `nickname`/`created_at` 仍无 SELECT」），
--    ⛔ 不补任何列权限；
-- 4. 反向控制：以 `gengyun_api_runtime` 直接 `SELECT nickname FROM public.users`、
--    `SELECT created_at FROM public.users` 仍必须 `42501`（见集成脚本 `[P]` 手臂）。
--
-- ## 已知残余限制（如实声明，不得读成「已分页」）
-- 一次全表读：函数没有 keyset 分页形参，分页/游标由服务层 `pageOf()` 对内存数组切片。
-- 万级以上账号规模需要后续片补 `p_after_*` 形参并把 `pageOf` 改成 SQL 侧分页。
--
-- ## 合并顺序（⛔ 本片分支上 0018–0020 缺号属预期）
-- 只有 `0018`（PR #272）→ `0019`（消息片）→ `0020`（开关片）→ 本片 `0021` 的顺序合并后，
-- `tests/integration/migrations-negative-pg.mjs` 的「无缺号」断言才会重新变绿。

-- ① 账号读面的唯一读路径：输出列被函数签名钉死，调用方无法多取一列。
CREATE FUNCTION public.list_admin_accounts()
RETURNS TABLE (
  id uuid,
  revision integer,
  state public.user_state,
  display_name text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  x_state_out_of_range text;
  x_empty_display_name text;
BEGIN
  -- ② state 必须是 0001 的 `user_state` 全集成员（含 `deleted`）：越界即抛，⛔ 不折叠成 active。
  --    枚举型本不会越界，这条是**契约断言**：任何人把列改成 text 或加枚举分支时先在这里炸。
  SELECT u.state::text
    INTO x_state_out_of_range
    FROM public.users AS u
   WHERE NOT EXISTS (
           SELECT 1
             FROM pg_catalog.pg_enum AS e
            WHERE e.enumtypid = 'public.user_state'::pg_catalog.regtype
              AND e.enumlabel = u.state::text
         )
   LIMIT 1;
  IF x_state_out_of_range IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'data_exception',
      MESSAGE = 'LIST_ADMIN_ACCOUNTS_STATE_OUT_OF_RANGE';
  END IF;

  -- ③ display_name 必须非空（契约 `minLength:1`）：投影规则若被改坏，宁可直接失败也不返回空串。
  SELECT public.admin_account_display_name(u.nickname, u.id)
    INTO x_empty_display_name
    FROM public.users AS u
   WHERE btrim(public.admin_account_display_name(u.nickname, u.id)) = ''
   LIMIT 1;
  IF x_empty_display_name IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'data_exception',
      MESSAGE = 'LIST_ADMIN_ACCOUNTS_DISPLAY_NAME_EMPTY';
  END IF;

  -- ④ 唯一读形状：四列白名单 + 派单逐字定序（`created_at` 定序但不透出）。
  RETURN QUERY
  SELECT u.id,
         u.revision,
         u.state,
         public.admin_account_display_name(u.nickname, u.id)
    FROM public.users AS u
   ORDER BY u.created_at ASC, u.id ASC;
END;
$$;

-- ⑤ PUBLIC 一律不得执行（GRANT 只在 20-login-roles.sql 里、只给运行时登录角色）。
REVOKE ALL ON FUNCTION public.list_admin_accounts() FROM PUBLIC;
