-- ============================================================================
-- GY-I04 / #4  微信登录、游客限制与服务端归属权限 — 迁移 0004
-- ----------------------------------------------------------------------------
-- 依赖：0001（GY-I02 初始迁移）已创建 users / sessions / admin_accounts /
--       admin_sessions / admin_scopes。本迁移**不重复创建、不修改**这些表。
--
-- 与 GY-I27（0003）的关系：**不引用、不依赖 0003 的任何对象**（0003 尚未合入
-- main）。本迁移 SQL 只引用 0001 的表。
--
-- 本迁移只新增一张运行台账：
--   idempotency_keys —— 契约参数 Idempotency-Key（/auth/wechat、/auth/logout、
--   /admin/auth/session、/admin/auth/logout 四个 POST 均 required）的服务端重放台账。
--   同主体/方法/路径的键域内只保存**不含凭据的结果引用**（outcome：登录类为 sessionId +
--   audience，退出类为成功标记），**不保存** access_token 等明文 bearer 响应。
--   命中台账时不回放旧响应，而是重新执行 produce（含当前状态校验）以重新签发；
--   同键异请求体判 IDEMPOTENCY_CONFLICT(409)。重放前仍会重新鉴权（见路由实现）。
--
-- 为什么只需要这一张表：
--   * 会话令牌摘要已有 0001 的 sessions.token_hash / admin_sessions.token_hash (bytea)；
--   * 账号 auth_epoch 已有 users.auth_epoch / admin_accounts.auth_epoch，注销/停用递增即
--     使旧会话失效，无需额外表；
--   * 微信 code 单次交换由微信侧保证（重复兑换返回 40029），服务端不自建 code 台账，
--     避免臆造与 0001 重复的职责。
--
-- 硬约束：不存明文密钥与明文 bearer 令牌；key_hash / request_hash 均为（带密钥的）摘要；
--         outcome 只放不含凭据的结果引用；不含任何真实私有数据。
--
-- 回滚：services/api/db/migrations/rollback/0004_auth_session.down.sql
-- ============================================================================
BEGIN;

-- scope        = 主体 + 方法 + 路径组成的键域（防止跨主体/跨路由误重放）
-- key_hash     = SHA-256(scope || '\n' || 原始 Idempotency-Key)
-- request_hash = HMAC-SHA256(服务端密钥, 请求体规范化序列化)（同键异体 → 冲突；密钥不入库）
-- outcome      = 不含凭据的结果引用（登录 sessionId+audience / 退出成功标记），非完整响应
CREATE TABLE idempotency_keys (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    scope           varchar(240) NOT NULL,
    key_hash        bytea        NOT NULL CHECK (octet_length(key_hash) = 32),
    request_hash    char(64)     NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    response_status integer      NOT NULL CHECK (response_status >= 200 AND response_status < 600),
    outcome         jsonb        NOT NULL,
    created_at      timestamptz  NOT NULL DEFAULT now(),
    expires_at      timestamptz  NOT NULL,
    CONSTRAINT idempotency_keys_expires_after_creation CHECK (expires_at > created_at)
);
CREATE UNIQUE INDEX idempotency_keys_scope_key ON idempotency_keys (scope, key_hash);
CREATE INDEX idempotency_keys_expires_idx ON idempotency_keys (expires_at);

COMMIT;
