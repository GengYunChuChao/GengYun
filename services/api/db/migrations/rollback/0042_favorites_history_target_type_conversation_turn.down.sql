-- 迁移 0042 回滚：把 `favorites` / `history` 的 `target_type` CHECK 放回 `0018` 的 **16 值**闭集
-- =============================================================================
-- （即 0042 之前的样子：约束名沿用 PostgreSQL 的列级默认名，不新建别的名字。）
--
-- **先预检，再改约束**：库里只要已经有一行 `target_type = 'conversation_turn'`，重建 16 值约束就会把
-- 该行写回契约 17 值闭集**之外** ⇒ 直接 `RAISE EXCEPTION 'G0015'` 并中止。
--   · 不静默丢行（⛔ 不删这些行）、不把轮次行改写成「最像的」16 值里某项（那会把「轮次」冒充成别的实体）；
--   · 想「回到旧库层口径」时正确的动作是**回滚应用版本**（让写入口不再落轮次类型），而不是回滚约束；
--   · 真要把这些行降级成 16 值里某项，属**数据订正**：必须人工裁定后单独一条迁移，不夹在回滚里做。
--
-- 顺序与 0042 正向相反：先删 17 值约束、再按 `0018` 的 16 值重建（同一事务 ⇒ 无「约束短暂缺席」的窗口）。
-- 这里用 `IF EXISTS`（与 `rollback/0040`/`rollback/0041` 同风格）：回滚是「撤离」路径，约束已不在时
-- 不该把整个回滚卡死；即便旧约束因名字不同没被删掉，重建 16 值约束后的有效闭集仍是 16 值（交集），
-- 语义不会变得更宽。
--
-- 不碰什么：⛔ 不动其它列/索引/数据（两表的行、`favorites_owner_target_key`、
-- `favorites_owner_created_idx`、`history` 的 `kind`/`job_state`/`event_key` 约束全都不动）；
-- ⛔ 不改 `0018` 的正文（checksum）。
--
-- 错误码（迁移期预检，不进 HTTP 错误面）：
--   G0015 TARGET_TYPE_ROLLBACK_BLOCKED_BY_CONVERSATION_TURN_ROWS
BEGIN;

-- ---------------------------------------------------------------------------
-- ① 预检：库里已有轮次类型行 ⇒ 回滚会把数据写到契约闭集之外，中止
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  x_turn_favorites integer;
  x_turn_history   integer;
  x_turn_total     integer;
  x_samples        text;
BEGIN
  SELECT count(*) INTO x_turn_favorites
    FROM public.favorites f
   WHERE f.target_type = 'conversation_turn';

  SELECT count(*) INTO x_turn_history
    FROM public.history h
   WHERE h.target_type = 'conversation_turn';

  x_turn_total := x_turn_favorites + x_turn_history;

  IF x_turn_total > 0 THEN
    SELECT string_agg(format('%s(target_id=%s)', s.tbl, s.target_id), ', ' ORDER BY s.tbl, s.target_id)
      INTO x_samples
      FROM (
        SELECT 'favorites'::text AS tbl, f.target_id::text AS target_id
          FROM public.favorites f
         WHERE f.target_type = 'conversation_turn'
        UNION ALL
        SELECT 'history'::text, h.target_id::text
          FROM public.history h
         WHERE h.target_type = 'conversation_turn'
        LIMIT 5
      ) s;

    RAISE EXCEPTION USING
      ERRCODE = 'G0015',
      MESSAGE = 'TARGET_TYPE_ROLLBACK_BLOCKED_BY_CONVERSATION_TURN_ROWS',
      DETAIL = format(
        '迁移 0042 回滚中止：库里已有 %s 行 target_type = ''conversation_turn''（favorites %s 行 / history %s 行；样例：%s）。',
        x_turn_total, x_turn_favorites, x_turn_history, x_samples),
      HINT = '16 值闭集里没有 conversation_turn，把这些行放回去等于把数据写到契约闭集之外。'
             '请先回滚**应用版本**（停止写入轮次类型），再由人工裁定这些行的归属并单独一条迁移订正；'
             '⛔ 不要为了能回滚而删行，也⛔ 不要把轮次行改写成别的目标类型。';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- ② 预检通过才动约束：17 值 ⇒ 16 值（顺序 = `0018` 原文顺序）
-- ---------------------------------------------------------------------------
ALTER TABLE public.favorites
  DROP CONSTRAINT IF EXISTS favorites_target_type_check;

ALTER TABLE public.favorites
  ADD CONSTRAINT favorites_target_type_check CHECK (target_type IN (
    'species', 'herbicide', 'scheme', 'static_region', 'recognition', 'ocr',
    'transcription', 'answer', 'post', 'comment', 'conversation', 'dose_card',
    'media', 'synthesis', 'job', 'source'
  ));

ALTER TABLE public.history
  DROP CONSTRAINT IF EXISTS history_target_type_check;

ALTER TABLE public.history
  ADD CONSTRAINT history_target_type_check CHECK (target_type IN (
    'species', 'herbicide', 'scheme', 'static_region', 'recognition', 'ocr',
    'transcription', 'answer', 'post', 'comment', 'conversation', 'dose_card',
    'media', 'synthesis', 'job', 'source'
  ));

COMMIT;
