-- 迁移 0045 回滚：删掉 `community_moderation_decisions.decided_by`
-- =============================================================================
-- （即 0045 之前的样子：该表没有 actor 列。）
--
-- **先预检，再删列**：库里只要已经有一行 `decided_by IS NOT NULL`，删列就等于删掉
-- 人工审核的溯源证据 ⇒ 直接 `RAISE EXCEPTION 'G0017'` 并中止。
--   · 不静默删列（⛔ 不删这些证据）；
--   · 想把这些人审结论"降级成机器结论"属**数据订正**：必须人工裁定后单独一条迁移，
--     不夹在回滚里做（与 `rollback/0042` 的口径一致）；
--   · 真要"回到旧库层口径"时，正确的动作是回滚**应用版本**（让 approve/reject 不再落库）。
--
-- 这里用 `IF EXISTS`（与 `rollback/0040`/`rollback/0041`/`rollback/0042` 同风格）：
-- 回滚是「撤离」路径，列已不在时不该把整个回滚卡死。
--
-- 不碰什么：⛔ 不动其它列/索引/数据（12 列主体、主键、`community_moderation_current_key`
-- 唯一索引、任何行一律不动）；⛔ 不改 `0028` 的正文字节（checksum）。
--
-- 错误码（迁移期预检，不进 HTTP 错误面）：
--   G0017 POST_REVIEW_ACTOR_ROLLBACK_BLOCKED_BY_HUMAN_DECISIONS
BEGIN;

-- ---------------------------------------------------------------------------
-- ① 预检：库里有任何人审结论 ⇒ 回滚会把证据删掉，中止
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  x_human_total integer;
  x_samples     text;
BEGIN
  SELECT count(*) INTO x_human_total
    FROM public.community_moderation_decisions d
   WHERE d.decided_by IS NOT NULL;

  IF x_human_total > 0 THEN
    SELECT string_agg(
             format('%s(id=%s,decision=%s,actor=%s)', s.target_type, s.target_id, s.decision, s.decided_by),
             ', ' ORDER BY s.target_type, s.target_id)
      INTO x_samples
      FROM (
        SELECT d.target_type::text AS target_type,
               d.target_id::text   AS target_id,
               d.decision::text    AS decision,
               d.decided_by::text  AS decided_by
          FROM public.community_moderation_decisions d
         WHERE d.decided_by IS NOT NULL
         LIMIT 5
      ) s;

    RAISE EXCEPTION USING
      ERRCODE = 'G0017',
      MESSAGE = 'POST_REVIEW_ACTOR_ROLLBACK_BLOCKED_BY_HUMAN_DECISIONS',
      DETAIL = format(
        '回滚 0045 中止：库里已有 %s 行人工审核结论（decided_by 非空；样例：%s）。',
        x_human_total, x_samples),
      HINT = '删列等于删掉"谁批的"这一溯源证据。请先回滚**应用版本**（停掉 approve/reject 的落库），'
             '再由人工裁定这些历史结论如何保留；⛔ 不要为了能回滚而把 decided_by 清空，'
             '也⛔ 不要把这些行改写成"机器结论"。';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- ② 预检通过才删列
-- ---------------------------------------------------------------------------
ALTER TABLE public.community_moderation_decisions
  DROP COLUMN IF EXISTS decided_by;

COMMIT;
