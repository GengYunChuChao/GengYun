-- GY-R29 S7 · 回滚 0028_moderation_persistence.sql
--
-- 0028 是**纯新增**（两张新表 + 索引，不改任何既有表/列/索引/枚举/数据），
-- 因此回滚就是整表拆除，不留半成品结构。
--
-- 注意：拆除后审核判定台账退化为内存实现（`services/api/src/moderation/decisions.ts`），
-- 进程重启即丢结论；真实运行环境需要在回滚前确认已接受这一退化
-- （代码侧 real 模式仍是 fail-closed，不会因为回滚就伪造成功封套）。

BEGIN;

DROP INDEX IF EXISTS public.moderation_withdrawals_recent_idx;
DROP TABLE IF EXISTS public.moderation_withdrawals;

DROP INDEX IF EXISTS public.moderation_decisions_created_idx;
DROP INDEX IF EXISTS public.moderation_decisions_target_idx;
DROP INDEX IF EXISTS public.moderation_decisions_current_key;
DROP TABLE IF EXISTS public.moderation_decisions;

COMMIT;
