-- GY-R72 W41 · 审核域的**持久幂等台账**（`public.moderation_idempotency`）。
--
-- ## 谁写它
-- `services/api/src/moderation/idempotency-store.ts` 的 `createPgModerationIdempotencyStore()`，
-- 五个方法逐一对应本表的五条语句：
--   findIdempotent   ⇒ `SELECT request_hash, payload, pending, expires_at … WHERE scope = $1 AND key_hash = $2`
--   claimIdempotent  ⇒ `INSERT … ON CONFLICT (scope, key_hash) DO UPDATE … WHERE expires_at <= $7 RETURNING scope`
--   finalizeIdempotent ⇒ `UPDATE … SET payload = $3, pending = false WHERE scope = $1 AND key_hash = $2`
--   releaseIdempotent  ⇒ `DELETE … WHERE scope = $1 AND key_hash = $2`
--   purgeIdempotent    ⇒ `DELETE … WHERE expires_at <= $1 RETURNING scope`
-- （`claimIdempotent` 的 `ON CONFLICT` 冲突目标就是本表主键 `(scope, key_hash)`，所以
--   SELECT 权必须覆盖 `scope` 与 `key_hash` 两列 —— 不是只有读出来的四列。）
--
-- ## 为什么需要（这不是「顺手加的台账」）
-- 审核域的取消端点**要求** `Idempotency-Key`，但此前只做形状校验、不参与回放：
-- `services/api/src/moderation/service.ts:1187` 只走 `requireCancelIdempotencyKey`
-- （`:357-360`，长度 8..128，非法即 400 `IDEMPOTENCY_KEY_REQUIRED`），`service.ts:270-271`
-- 自陈「本域没有幂等台账」。这个缺口是成文登记过的开放问题，
-- `docs/verification/gy-r71-job-cancel-modes-20261030.md:67` 的理由原文：
--
--   > 本域没有幂等台账；要回放要么内存表（重启即丢）、要么加迁移和列。
--
-- 本迁移就是那条「加迁移和列」的路：回放结果必须**跨进程重启仍在**，否则「同键重放」在
-- 重启后就变成一次新的副作用 —— 而取消动作的副作用（判定台账、审计、下架）是不可重放的。
--
-- ## 形制（与既有两处幂等台账逐字同形，只换表名与索引名）
-- `0026_speech_persistence.sql:137-152` 的 `speech_idempotency` 与
-- `0024_ocr_persistence.sql:133-148` 的 `ocr_idempotency` 已经在生产跑了两套同形台账；
-- 三处字段/约束/主键必须一致，否则「同一套语义」会各自漂移成三种。改动请三处一起改。
--
-- ## 过期语义（两处，都在服务层，本表不自带 TTL）
-- 1. `purgeIdempotent(now)` ⇒ `DELETE FROM public.moderation_idempotency WHERE expires_at <= $1`
--    —— **物理删除**（本表没有软删列，回放结果过期即无价值，留着只是让表无限长）。
-- 2. `claimIdempotent(…)` 的 `ON CONFLICT … DO UPDATE … WHERE expires_at <= $7`
--    —— 过期行被**就地重占**：不先 `DELETE` 再 `INSERT`（那在并发下会让两个同键请求都判定
--    「不存在」而同时执行副作用）；`WHERE` 命中不到过期行时 `RETURNING` 零行 ⇒ 服务层返回
--    `'exists'`，由调用方比对 `request_hash` 后决定 409。
-- 3. `findIdempotent` **不按过期过滤**（与 0024/0026 同口径）：过期判定只发生在 claim，
--    读面把「过期行还在」如实交给调用方，是否视作不存在由上层决定。
--
-- ## 权限（本迁移零 GRANT）
-- 与 0024/0026 同一条纪律：迁移**只建表**，授权一律在部署侧。
-- 运行时的列级授权在 `deploy/postgres-cvm/sql/20-login-roles.sql` 的
-- `gy-r72-moderation-idempotency-grant` 区；`DELETE`（`purgeIdempotent` 与 `releaseIdempotent` 需要）
-- 单独在 `gy-r72-moderation-idempotency-delete` 区 —— PG 没有列级 DELETE，而列级区必须只含列级授权。
-- 最小权限断言见 `deploy/postgres-cvm/sql/90-assert-least-privilege.sql` 的三处登记。
--
-- ## 回滚
-- `services/api/db/migrations/rollback/0051_moderation_idempotency.down.sql`
-- （纯新增 ⇒ 可整表拆除；没有外键、不引用任何既有行）。
--
-- ## 号位
-- 正向最大号为 `0050_provider_invocations.sql` ⇒ 本片取 `0051`（连续编号，无缺号）。
BEGIN;

-- ---------------------------------------------------------------------------
-- 审核域幂等台账
--
-- 独立建表，不共用 0008 的认证台账 / 0024 的 OCR 台账 / 0026 的语音台账：
-- scope 前缀与主体不同，混表会让 purge 扫描与授权面互相牵连。
-- ---------------------------------------------------------------------------
CREATE TABLE public.moderation_idempotency (
  -- scope = `<主体>\n<METHOD>\n<路径>`（沿用 0008 auth/idempotency.ts 的口径，不另造格式）
  scope        varchar(200) NOT NULL CHECK (char_length(scope) BETWEEN 1 AND 200),
  -- 幂等键的 HMAC 摘要（不落明文键；hex 文本）
  key_hash     varchar(128) NOT NULL CHECK (char_length(key_hash) BETWEEN 1 AND 128),
  -- 请求体的摘要：同键不同体是**客户端的错**（409），不是覆盖
  request_hash varchar(128) NOT NULL CHECK (char_length(request_hash) BETWEEN 1 AND 128),
  -- 首次请求的回放载荷（jsonb 对象；`pending = false` 后即为可回放的结果）
  payload      jsonb        NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  -- true = 已原子占位、业务尚未完成：并发同键请求必须让路，不得重复执行副作用
  pending      boolean      NOT NULL,
  expires_at   timestamptz  NOT NULL,
  PRIMARY KEY (scope, key_hash)
);

-- 过期清理扫描（`purgeIdempotent` 的 `DELETE … WHERE expires_at <= $1`）
CREATE INDEX moderation_idempotency_expires_idx ON moderation_idempotency (expires_at);

COMMIT;
