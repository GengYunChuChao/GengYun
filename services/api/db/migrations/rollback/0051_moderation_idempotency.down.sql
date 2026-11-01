-- 回滚 0051_moderation_idempotency.sql（审核域的持久幂等台账）。
--
-- 纯新增迁移 ⇒ 可整表拆除：本迁移只新建 `public.moderation_idempotency` 与一条索引，
-- 没有改动任何既有表/列/约束/数据，也没有外键或跨表引用（`scope`/`key_hash` 是纯文本键，
-- 不指向 users 或任何主体行）。
--
-- 索引 `moderation_idempotency_expires_idx` 随 `DROP TABLE` 一起消失（PG 的 DROP TABLE 连带
-- 删除该表上的索引与主键约束），不需要单独的 `DROP INDEX`。
--
-- 数据代价（说清楚，别当成副作用）：未过期的回放结果会一并丢弃 —— 这正是回滚的定义；
-- 但**回滚会改变行为**：表消失后幂等回放不再可能，同键重放会重新执行副作用。
-- ⇒ 正确顺序是「先回滚到不使用该 store 的应用版本，再回滚本迁移」（接线在 W42 之后才成立）。
--
-- 回滚标记沿用仓内既有写法（见 `0026_speech_persistence.down.sql`、`0017_account_suspend_authority.down.sql`）：
-- `BEGIN; DROP TABLE IF EXISTS …; COMMIT;`。这里用 `IF EXISTS`：纯新增表的回滚重跑一次应当无害，
-- 而 0042/0043/0047/0049 那种「必须先验数据再拆」的场景才要预检 + 不带 IF EXISTS。
BEGIN;

DROP TABLE IF EXISTS public.moderation_idempotency;

COMMIT;
