-- 回滚 `0056_post_media_attachments.sql`：只丢挂载行，不碰 `community_posts` 与 `media`。
--
-- `community_posts.media_ids` 里的引用串仍在（那是发帖内容的既有列，本迁移从未改它）
-- ⇒ 回滚后帖子照旧能读到图引用，只是「每帖 ≤3」退回上传端计数近似（`unwired` ⇒ 503）。
BEGIN;

DROP TABLE IF EXISTS public.post_media_attachments;

COMMIT;
