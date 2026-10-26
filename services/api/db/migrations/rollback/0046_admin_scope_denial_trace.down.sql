-- 迁移 0046 回滚：删掉 `public.record_admin_scope_denial(...)`（即 0046 之前的样子：没有这条函数）
-- =============================================================================
--
-- ⚠️ **不可逆的留痕面（如实登记，不谎称已清理）**：
-- 本迁移只加函数、**没有**加列/加表/加索引，所以没有列数据要抢救；但 `public.admin_audit_events`
-- 里已经由它写下的 `action = 'admin_scope.deny'` 行会**失去唯一的出处处方**（运行时对这张表
-- 仍然是零表级、零列级权限，见 `90-assert-least-privilege.sql` 的 `external_manifest` 与槽 9
-- `protected_columns`）。而且那些行**删不掉**：表上 `admin_audit_events_append_only` 触发器对
-- UPDATE/DELETE 一律 `RAISE … 'G0006'`（`0017_account_suspend_authority.sql`）—— 审计台账只可追加。
-- ⇒ 真要清理这些行属**数据订正**，必须人工裁定后单独一条迁移，⛔ 不夹在回滚里做。
-- ⇒ 也不在这里写「先数行、有行即中止」的预检（与 `0043` 的差异，理由如下）：
--    0043 的写入口**应用侧已在调用**，删函数会让每次取消都失败；而 0046 的调用方（`#646` 的
--    `admin/ops/scope-authority-pg.ts`）在库层这一半落盘时**尚未接线**，回滚本迁移的正确顺序是
--    「先回滚应用版本、再回滚库」——没有「应用还在调、函数已不在」的窗口。本文件照裁定 B 的
--    交付口径只做一件事：`DROP FUNCTION IF EXISTS`。
--
-- 顺序：先撤部署 SQL 的 `gy-r64-pr4a-denial-trace-grant` 区域，再回滚本迁移。
--   本文件**不动** `20-login-roles.sql` 的授权区域 —— 它带「函数必须已存在」的
--   `to_regprocedure` 硬前置，函数一旦不在，下次部署会**显式报错**并给出「迁移 0046 未执行」的
--   明确信息（这正是要的效果：不会静默留下一条对空函数的 `GRANT`）。
--
-- 签名带完整参数类型：同名函数可能因加参产生重载，不带签名会 DROP 歧义（或漏删）。
-- 不用 CASCADE：没有别的对象依赖这条函数（没有视图、没有触发器、policy 不引用函数）。
-- `0001..0045` 的对象一个不碰，⛔ 不动 `0041` 的两条 scope 函数、⛔ 不动 `0017` 的审计表与触发器。
BEGIN;

DROP FUNCTION IF EXISTS public.record_admin_scope_denial(uuid, uuid, text, text, uuid, uuid);

COMMIT;
