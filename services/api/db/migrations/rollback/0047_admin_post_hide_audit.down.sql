-- 迁移 0047 回滚：删掉 `public.record_admin_post_hide_audit(...)`（即 0047 之前的样子：没有这条函数）
-- =============================================================================
--
-- **先预检，再删函数**：只要 `public.admin_audit_events` 里已经有一行 `action = 'post.hide'`，
-- 就直接 `RAISE EXCEPTION 'G0019'` 并中止。理由与 `rollback/0043_*.down.sql` 同源，三条都不是"保守起见"：
--   1. 那些行是**本函数**写下的：删掉函数，它们就失去了唯一的写入口，库里留下一批"有行、无出处"的审计；
--   2. 应用侧仍在调用它（`services/api/src/community/store-pg.ts` 的 `commitPost` 在帖子端口已接线时
--      走库内审计）⇒ 回滚库而不回滚应用，会让**每一次**隐藏都失败（帖子事务整体 ROLLBACK，
--      客户端拿到 503），属于把"少一条审计"换成"功能不可用"；
--   3. 即便想连行一起带走也做不到：`admin_audit_events_append_only` 触发器对 UPDATE/DELETE 一律
--      `RAISE … 'G0006'`（`0017_account_suspend_authority.sql`），审计台账是**只可追加**的。
--      ⇒ 正确的动作是**回滚应用版本**（让写入口先停），而不是回滚这条函数；
--        真要清理这些行属**数据订正**，必须人工裁定后单独一条迁移，⛔ 不夹在回滚里做。
--
-- 顺序：预检（数行）⇒ 删函数（同一事务 ⇒ 不会留下"函数删了、预检结果已过期"的中间态）。
--
-- 这里**不用 `IF EXISTS`**（沿用 0042/0043 正向的理由）：回滚脚本的判据是"0047 确实落过盘"。
-- 函数不在时静默成功，等于把「这条库根本没应用过 0047 / 已经被别人删过」这两种完全不同的事
-- 都说成"回滚成功"——真出现时应该由 `DROP FUNCTION` 自己报错，让人先看清库的真实状态。
--
-- 不碰什么：⛔ 不动 `admin_audit_events` 的任何行、索引、触发器（append-only 仍在）；
-- ⛔ 不改 `0017` / `0027` / `0033` / `0041` / `0043` 的正文（checksum）；
-- ⛔ 不动 `20-login-roles.sql` 的授权区域（它带"函数必须已存在"的前置，下次部署会显式失败，
--    这正是要的效果：不会静默留下一条对空函数的 `GRANT`）。
--
-- 错误码（迁移期预检，不进 HTTP 错误面）：
--   G0019 POST_HIDE_AUDIT_ROLLBACK_BLOCKED
BEGIN;

-- ---------------------------------------------------------------------------
-- ① 预检：库里已有 post.hide 审计行 ⇒ 删函数会留下"有行无出处"的台账，中止
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  x_rows    bigint;
  x_samples text;
BEGIN
  SELECT count(*) INTO x_rows
    FROM public.admin_audit_events AS e
   WHERE e.action = 'post.hide';

  IF x_rows > 0 THEN
    SELECT string_agg(format('id=%s(actor=%s,request=%s,created_at=%s)',
                             s.id, s.actor_id, s.request_id, s.created_at),
                      ', ' ORDER BY s.created_at, s.id)
      INTO x_samples
      FROM (
        SELECT e.id, e.actor_id, e.request_id, e.created_at
          FROM public.admin_audit_events AS e
         WHERE e.action = 'post.hide'
         ORDER BY e.created_at, e.id
         LIMIT 5
      ) AS s;

    RAISE EXCEPTION USING
      ERRCODE = 'G0019',
      MESSAGE = 'POST_HIDE_AUDIT_ROLLBACK_BLOCKED',
      DETAIL = format(
        '迁移 0047 回滚中止：public.admin_audit_events 里已有 %s 行 action = ''post.hide''（样例：%s）。',
        x_rows, x_samples),
      HINT = '这些行是 public.record_admin_post_hide_audit(...) 写下的；删掉函数会留下"有行、无出处"的审计，'
             '并且应用侧仍会调用它 ⇒ 每次隐藏都失败。请先回滚**应用版本**（让写入口停下），'
             '再评估是否需要一条单独的数据订正迁移；⛔ 不要为了能回滚而删审计行'
             '（append-only 触发器本来也会把 DELETE 拦成 G0006）。';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- ② 预检通过才删函数（删不掉就让 DROP 自己报错：不做 IF EXISTS 静默兜底）
-- ---------------------------------------------------------------------------
DROP FUNCTION public.record_admin_post_hide_audit(uuid, uuid, integer, text, uuid);

COMMIT;
