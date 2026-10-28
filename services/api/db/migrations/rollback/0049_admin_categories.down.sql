-- 迁移 0049 回滚：删掉 `public.record_admin_category_update(...)` 与本片新建的目录正本表
-- `public.admin_categories`（即 0049 之前的样子：两个分类 operation 恒 503、库里没有这张表）
-- =============================================================================
--
-- **先预检，再删**：出现下面任一情况即 `RAISE EXCEPTION 'G0019'` 并中止 ——
--   1. `public.admin_audit_events` 里已有 `action = 'category.update'` 的行：
--      那些行是 `record_admin_category_update(...)` 写下的，删函数会留下"有行、无出处"的审计；
--      而且审计台账是**只可追加**的（`admin_audit_events_append_only` 触发器对 UPDATE/DELETE 一律
--      `RAISE … 'G0006'`），删不掉也带不走 ⇒ 正确动作是**回滚应用版本**，不是回滚库。
--   2. `public.admin_categories` 里已有 `revision > 1` 的行：说明后台**真的编辑过**，这张表里
--      已经不是"可随时从 crops/species 重建的投影"，`DROP TABLE` 会静默丢掉人工维护的内容。
--      ⛔ 不在这里做导出/搬迁：那是数据订正，必须人工裁定后单独一条迁移。
--
-- ⚠ 上面第 1 条的边界（如实记，别把它当成安全边界）：`admin_audit_events` 的只可追加是
--    **触发器** `admin_audit_events_append_only` 实现的，而超级用户对该表
--    `ALTER TABLE … DISABLE TRIGGER admin_audit_events_append_only` 之后就能 `DELETE`、再 `ENABLE`
--    回来；表所有者同样能 `DROP TRIGGER` ⇒ **超级用户/所有者可以绕过 append-only**。
--    本脚本的预检只保证「用正常部署角色、照下面的顺序跑」时不会静默丢审计；防越权要靠
--    脚本之外的边界（谁能连生产库、谁握有 superuser），不是靠这两条判据。
--
-- 顺序：预检（数两处）⇒ 删函数 ⇒ 删表（同一事务 ⇒ 不会留下"函数删了、预检结果已过期"的中间态）。
--
-- 这里**不用 `IF EXISTS`**（沿用 0042/0043/0047 回滚件的理由）：回滚脚本的判据是"0049 确实落过盘"。
-- 对象不在时静默成功，等于把「这条库根本没应用过 0049 / 已经被别人删过」两种完全不同的事都说成
-- "回滚成功" —— 真出现时应该由 `DROP …` 自己报错，让人先看清库的真实状态。
--
-- 不碰什么：⛔ 不动 `admin_audit_events` 的任何行/索引/触发器（append-only 仍在）；
-- ⛔ 不改 `crops`/`species`（本片从未写它们，回填是单向读）；
-- ⛔ 不改 `0001`/`0017`/`0033`/`0041`/`0043`/`0047`/`0048` 的正文（checksum）；
-- ⛔ 不动 `20-login-roles.sql` 的授权区域（它带"表与函数必须已存在"的前置，下次部署会显式失败，
--    这正是要的效果：不会静默留下一条对已删对象的 `GRANT`）。
--
-- 错误码（迁移期预检，不进 HTTP 错误面）：
--   G0019 CATALOG_ROLLBACK_BLOCKED
BEGIN;

-- ---------------------------------------------------------------------------
-- ① 预检：已有真实编辑或已有审计行 ⇒ 中止
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  x_audit_rows  bigint;
  x_edited_rows bigint;
  x_samples     text;
BEGIN
  SELECT count(*) INTO x_audit_rows
    FROM public.admin_audit_events AS e
   WHERE e.action = 'category.update';

  SELECT count(*) INTO x_edited_rows
    FROM public.admin_categories AS c
   WHERE c.revision > 1;

  IF x_audit_rows > 0 OR x_edited_rows > 0 THEN
    SELECT string_agg(format('id=%s(revision=%s)', s.id, s.revision), ', ' ORDER BY s.id)
      INTO x_samples
      FROM (
        SELECT c.id, c.revision
          FROM public.admin_categories AS c
         WHERE c.revision > 1
         ORDER BY c.id
         LIMIT 5
      ) AS s;

    RAISE EXCEPTION USING
      ERRCODE = 'G0019',
      MESSAGE = 'CATALOG_ROLLBACK_BLOCKED',
      DETAIL = format(
        '迁移 0049 回滚中止：action = ''category.update'' 的审计行 %s 条、revision > 1 的目录行 %s 条（样例：%s）。',
        x_audit_rows, x_edited_rows, coalesce(x_samples, '（无）')),
      HINT = '后台已经真的编辑过分类。删函数会留下"有行、无出处"的审计，删表会静默丢掉人工维护的内容 ⇒ '
             '请先回滚**应用版本**（让写入口停下），再评估是否需要一条单独的数据订正迁移；'
             '⛔ 不要为了能回滚而删审计行（append-only 触发器本来也会把 DELETE 拦成 G0006）。';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- ② 预检通过才删（删不掉就让 DROP 自己报错：不做 IF EXISTS 静默兜底）
-- ---------------------------------------------------------------------------
DROP FUNCTION public.record_admin_category_update(uuid, text, integer, uuid);
DROP TABLE public.admin_categories;

COMMIT;
