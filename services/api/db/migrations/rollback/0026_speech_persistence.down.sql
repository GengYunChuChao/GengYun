-- 回滚：`0026_speech_persistence.sql`（转写任务行 / 转写记录行 / 域内幂等台账）。
--
-- 纯新增迁移 ⇒ 可直接整表拆除：本迁移**没有**改动任何既有表、既有索引、既有枚举或既有数据，
-- 也没有跨迁移外键（唯一的外键指向 0001 的 `users`，回滚只删引用方、不触碰被引用方），
-- 因此回滚后库结构与 `0025` 之后完全一致（`users` 与既有 `jobs` / `ocr_*` / `recognition_*` /
-- 幂等台账逐字仍在）。
-- 唯一的数据代价是：转写任务、转写记录与域内幂等台账内容一并丢弃 —— 这是回滚的定义，不是副作用。
--
-- 顺序按建表逆序（三张表之间没有互相引用的外键，任序皆可，逆序只是便于对照）。
-- 回滚标记沿用仓内既有写法（见 `0017_account_suspend_authority.down.sql`）：
-- BEGIN; DROP TABLE IF EXISTS …; COMMIT;
BEGIN;

DROP TABLE IF EXISTS public.speech_idempotency;
DROP TABLE IF EXISTS public.transcriptions;
DROP TABLE IF EXISTS public.speech_jobs;

COMMIT;
