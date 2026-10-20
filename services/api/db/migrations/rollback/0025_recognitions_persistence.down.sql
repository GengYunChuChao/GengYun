-- 回滚：`0025_recognitions_persistence.sql`（识别任务行 / 识别记录行 / 用户选择行 / 域内幂等台账）。
--
-- 纯新增迁移 ⇒ 可直接整表拆除：本迁移**没有**改动任何既有表、既有索引、既有枚举或既有数据，
-- 也没有跨迁移外键（外键只指向 0001 的 `users` 与本片自己的 `recognition_records`，
-- 回滚只删引用方、不触碰被引用方），因此回滚后库结构与 `0024` 之后完全一致
-- （`users` 与既有 `jobs` / `ocr_*` / 幂等台账逐字仍在）。
-- 唯一的数据代价是：识别任务、识别记录、用户选择与域内幂等台账内容一并丢弃 ——
-- 这是回滚的定义，不是副作用。
--
-- 顺序按建表逆序（`recognition_selections` 引用 `recognition_records`，必须后者先建、前者先拆；
-- 其余两表无互相引用，逆序只是便于对照）。
-- 回滚标记沿用仓内既有写法（见 `0017_account_suspend_authority.down.sql`）：
-- BEGIN; DROP TABLE IF EXISTS …; COMMIT;
BEGIN;

DROP TABLE IF EXISTS public.recognition_idempotency;
DROP TABLE IF EXISTS public.recognition_selections;
DROP TABLE IF EXISTS public.recognition_records;
DROP TABLE IF EXISTS public.recognition_jobs;

COMMIT;
