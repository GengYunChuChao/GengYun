-- GY-I17（#17）· 消息域从进程内 store 接到**真实 PostgreSQL 持久化**（阶段 2）
--
-- ## 本迁移只把 `messages/store.ts` 已冻结的三个写入原语落到数据库约束上
-- 1. `insertMessage`：同 `id`（主键）或同 `(owner_id, event_key)`（唯一约束）已存在 ⇒
--    不写入、返回 `duplicate`。**由数据库唯一性保证**：应用侧只有
--    `INSERT ... ON CONFLICT DO NOTHING RETURNING id`，按"有没有返回行"判定，
--    不存在"先 SELECT 再 INSERT"的检查-写入窗口（并发下两写只会有一条落库）。
-- 2. `markReadIfUnread`：读状态的**唯一**写入口，单条
--    `UPDATE ... SET read_at = ..., revision = revision + 1
--      WHERE id = $1 AND owner_id = $2 AND read_at IS NULL RETURNING ...`。
--    `read_at IS NULL` 同时承担两件事：
--      * **单调**——一旦有值不再改写（`read_at` 不会从时刻退回 `null`，也不会被第二次标记改成新时刻）；
--      * **并发收敛**——PostgreSQL 行级锁让 N 个并发 UPDATE 里只有一个能匹配到 `read_at IS NULL`，
--        其余在锁释放后重新求值即不再匹配、返回 0 行 ⇒ `revision` **恰好推进 1 次**
--        （证据页 §并发读数给出 20 并发的实测读数）。
--    无行返回时由存储层再读一次，区分"已是已读（空操作）"与"不存在 / 非本人"（后两者对上层同形）。
-- 3. `countUnread`：**派生**量，`SELECT count(*) ... WHERE owner_id = $1 AND read_at IS NULL`。
--    本迁移**没有**任何未读计数器列：加计数器就会产生"可漂移的第二真相"
--    （漏减、重复减、并发双减都无法从数据库自证）。
--
-- ## 归属域（安全红线）
-- 所有读写语句都带 `owner_id = $userId` 谓词；他人的消息在存储层与"不存在"同形（0 行），
-- 由服务层统一折成契约的 404（`messages/service.ts` 的 `notFound()`）。
-- `owner_id` 外键 **`ON DELETE CASCADE`**：注销删除主体时消息随之级联删除，
-- 与 0016 的 `user_id ... ON DELETE CASCADE` 同口径（不会把注销卡在外键上）。
--
-- ## 幂等台账不另建表
-- 复用 0008 已有的 `public.idempotency_keys`（派单要求"沿用既有语义与同一张表"）：
--   * `scope` = `<主体>\n<METHOD>\n<路径>`（`auth/idempotency.ts` 的 `idempotencyScope`），
--     主体已编码在 scope 里，故不同主体 / 不同路由的键互不碰撞；
--   * `key_hash` = SHA-256(scope || '\n' || 原始 Idempotency-Key)（32 字节 bytea，只存摘要）；
--   * `outcome` 是 jsonb 且**没有**形状 CHECK，因此可以追加消息类结果引用
--     `{"kind":"message","id":<uuid>,"revision":<int>}`，**不需要**改 0008 的表结构，
--     也不会碰到 `tests/unit/auth-store-pg.test.mjs` 里锁住登录/退出联合类型的既有断言。
--   * `outcome IS NULL` 即"占位中"（state 是派生量，不另设一列，避免与 outcome 双写漂移）。
--
-- ## 排序与游标
-- 列表口径固定为 `created_at DESC, id DESC`（`docs/architecture/state-contract.md`）。
-- 写入时刻一律由服务注入（毫秒精度 RFC3339，`record.created_at` / `readAt`），
-- 因此返回值字符串与 SQL 的比较基准**同一精度**：不会出现"返回值被截到毫秒、
-- 而 WHERE 里仍是微秒"的游标空洞。
--
-- 回滚：services/api/db/migrations/rollback/0019_messages_persistence.down.sql
-- ============================================================================
BEGIN;

-- id/owner_id 都不带默认值：id 由服务侧 newId() 生成，owner 必须由调用方明确给出
-- （不存在"没写 owner 也能落库"的路径）。
CREATE TABLE messages (
    id          uuid        PRIMARY KEY,
    owner_id    uuid        NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
    -- 契约 MessageType 闭集；数据库层同样拦成闭集，避免脏值进来后只能靠读到才发现。
    type        text        NOT NULL,
    -- 契约 TargetRef（对象引用）；可为 NULL（不是每条消息都有可核验目标）。
    target_ref  jsonb,
    -- 未读 = NULL；首次标记写入时刻，之后不再改写（单调由 UPDATE 的 WHERE 守卫）。
    read_at     timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),
    -- 资源版本：初始 1，首次读转换 +1（强 ETag `"<revision>"` 由它派生）。
    revision    integer     NOT NULL DEFAULT 1,
    -- 来源事件 + 版本的去重键（内部字段，不出契约）。
    event_key   text        NOT NULL,
    CONSTRAINT messages_type_allowed CHECK (type IN ('comment', 'like', 'moderation', 'system')),
    CONSTRAINT messages_revision_positive CHECK (revision >= 1),
    CONSTRAINT messages_event_key_present CHECK (length(event_key) > 0),
    CONSTRAINT messages_target_ref_object CHECK (target_ref IS NULL OR jsonb_typeof(target_ref) = 'object'),
    -- 去重键：同一主体的同一事件只允许一行（重复投递 ⇒ 冲突 ⇒ 应用侧看到 0 行返回）。
    CONSTRAINT messages_owner_event_key UNIQUE (owner_id, event_key)
);

-- 列表 / 游标唯一排序键；与 0013 的会话列表同口径（`owner_id` 前缀让归属域过滤走索引）。
CREATE INDEX messages_owner_created_idx ON messages (owner_id, created_at DESC, id DESC);

COMMIT;
