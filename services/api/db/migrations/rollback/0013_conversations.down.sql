-- ============================================================================
-- 0013_conversations 回滚（运维脚本；不在迁移运行器的正向发现集内）
-- 仅撤销本迁移新增的三张表、一个外键与两个索引；不触碰任何既有对象。
--
-- 为什么可以直接 DROP TABLE：本迁移是**纯新增**（新增表/索引/约束，不改 0001~0011 的任何
-- 既有列、约束或数据），因此回滚不存在"改写别人数据"的风险。删表顺序按依赖倒序：
--   conversation_answers  →  conversation_turns  →  conversations
-- `conversation_turns.answer_id` 的 `ON DELETE SET NULL` 外键让两张表互相引用，
-- 故先解掉该环再删表（`DROP TABLE` 的 CASCADE 会连带删约束，但显式解环更可审）。
-- ============================================================================
BEGIN;

ALTER TABLE public.conversation_turns
  DROP CONSTRAINT IF EXISTS conversation_turns_answer_fk;

DROP INDEX IF EXISTS public.conversation_answers_turn_idx;
DROP TABLE IF EXISTS public.conversation_answers;

DROP INDEX IF EXISTS public.conversation_turns_job_id_key;
DROP INDEX IF EXISTS public.conversation_turns_conversation_created_idx;
DROP TABLE IF EXISTS public.conversation_turns;

DROP INDEX IF EXISTS public.conversations_owner_created_idx;
DROP TABLE IF EXISTS public.conversations;

COMMIT;
