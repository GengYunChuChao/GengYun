-- GY-I16（#16）· 收藏与识别历史的**持久化**（补齐阶段 2：此前只有内存实现）。
--
-- 依赖：`0001_initial_schema.sql` 的 `users`（`owner_id` 外键）；无其他前置。
--
-- 三张表，一张都不多：
--   1. `favorites`              收藏行（含去重键与 CAS 删除所需的 `revision`）；
--   2. `history`                识别/OCR 历史行（含终态字段 `job_state` 与两道去重键）；
--   3. `favorites_idempotency`  `POST /favorites` 与 `DELETE /favorites|history/{id}` 的幂等台账；
--   4. `history_idempotency`    同上，历史域。
-- 台账**按域分表**而不是共用一张：两个域的结果引用联合类型不同
-- （`{kind:'favorite', id, revision}` vs `{kind:'history', id, revision, cascade}`），
-- 合表会让 `outcome` 的 jsonb 形状变成两域耦合，回滚时也无法独立拆除。
--
-- 为什么这样建（逐条对齐 `services/api/src/favorites/store.ts` / `history/store.ts` 的语义）：
--   - **去重靠唯一约束，不靠"先查后写"**：`findByTarget` 只是快路径，真正的去重
--     是 `INSERT ... ON CONFLICT DO NOTHING` 撞唯一索引 ⇒ 返回 `'duplicate'`。
--     因此 `(owner_id, target_type, target_id)`（收藏）与
--     `(owner_id, kind, target_id)`、`(owner_id, event_key)`（历史）都必须是
--     **数据库级**唯一约束，应用层删不掉。
--   - **收藏目标不带 revision**：同一用户对同一目标永远只有一行，目标自身版本推进
--     （`target_revision`）不产生第二行；契约层面"取消后再收藏得到新 id"由**物理删除**保证。
--   - **CAS 删除**：`DELETE ... WHERE id AND owner_id AND revision` 需要 `revision` 参与比较，
--     故 `revision` 是行内列而非外部版本记录。`revision` 创建即 1、之后不再增长
--     （本域没有编辑操作），仅作为并发取消的比较令牌。
--   - **幂等台账真落库**：`(scope, key_hash)` 是主键，`claim` / `complete` / `release`
--     三个转移都用单条带条件的 `INSERT ... ON CONFLICT ... WHERE` / `UPDATE ... WHERE` /
--     `DELETE ... WHERE` 完成，**没有**"读一次再写一次"的窗口（多进程下进程内 Map 不可用）。
--     `outcome IS NULL` 表示"已认领、未完成"，与内存实现的 `outcome: null` 同义。
--   - **列类型**：`target_id` / `job_id` / `event_key` 是**任意文本**（用例里有 `spc-1`、
--     `job-page-0`），只有 `id` / `owner_id` 是 uuid；闭集列（`target_type` / `kind` /
--     `job_state`）按 `packages/contracts/openapi.json` 与 `states.json` 逐字写 CHECK，
--     扩展闭集必须走新迁移（不在应用层放宽）。
--   - `reference_state`（目标当前是否可得）**不入库**：每次读取重新派生，存储不产生
--     "可用/已使用"事实。
--
-- 删除语义：两个域都是**物理删除**（无 `deleted_at` 软删）。
--   注销清空 = `DELETE FROM <table> WHERE owner_id = $1 RETURNING id`，以返回行数作证据。
--
-- 回滚：`services/api/db/migrations/rollback/0018_favorites_history.down.sql`
--   （纯新增，可安全整表 DROP；不触碰任何既有表与既有数据）。
BEGIN;

-- ---------------------------------------------------------------------------
-- 收藏行
-- ---------------------------------------------------------------------------
CREATE TABLE favorites (
  id              uuid PRIMARY KEY,
  owner_id        uuid NOT NULL REFERENCES users (id),
  -- 收藏目标的闭集（契约 `FavoriteTarget` 是 17 项 `TargetRef.type` 的子集，此处不额外收窄，
  -- 由应用层校验 `species|herbicide|scheme`；数据库只守住"不得出现契约外类型"）。
  target_type     varchar(32) NOT NULL CHECK (target_type IN (
    'species', 'herbicide', 'scheme', 'static_region', 'recognition', 'ocr',
    'transcription', 'answer', 'post', 'comment', 'conversation', 'dose_card',
    'media', 'synthesis', 'job', 'source'
  )),
  target_id       varchar(80) NOT NULL CHECK (char_length(target_id) BETWEEN 1 AND 80),
  target_revision integer NOT NULL CHECK (target_revision >= 1),
  -- 行版本：创建即 1，作为 CAS 取消的比较令牌（强 ETag `"<revision>"`）。
  revision        integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- 去重键（**数据库级**，应用层无法绕过）：同主体同目标只有一行。
CREATE UNIQUE INDEX favorites_owner_target_key ON favorites (owner_id, target_type, target_id);
-- 列表口径 `(created_at DESC, id DESC)` 的稳定分页索引（契约排序，见 `state-contract.md`）。
CREATE INDEX favorites_owner_created_idx ON favorites (owner_id, created_at DESC, id DESC);

-- ---------------------------------------------------------------------------
-- 识别 / OCR 历史行
-- ---------------------------------------------------------------------------
CREATE TABLE history (
  id              uuid PRIMARY KEY,
  owner_id        uuid NOT NULL REFERENCES users (id),
  -- 契约 `History.kind`：2 项闭集。
  kind            varchar(16) NOT NULL CHECK (kind IN ('recognition', 'ocr')),
  target_type     varchar(32) NOT NULL CHECK (target_type IN (
    'species', 'herbicide', 'scheme', 'static_region', 'recognition', 'ocr',
    'transcription', 'answer', 'post', 'comment', 'conversation', 'dose_card',
    'media', 'synthesis', 'job', 'source'
  )),
  target_id       varchar(80) NOT NULL CHECK (char_length(target_id) BETWEEN 1 AND 80),
  target_revision integer NOT NULL CHECK (target_revision >= 1),
  revision        integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  -- 内部作业标识（**不出契约**）：读取时用它向 `getJob` 核对实时状态。
  job_id          varchar(120) NOT NULL CHECK (char_length(job_id) BETWEEN 1 AND 120),
  -- 入库时的**最后已知状态**（契约 `JobState`：7 项闭集，失败/超时/取消原样保留，不折叠成成功）。
  job_state       varchar(16) NOT NULL CHECK (job_state IN (
    'queued', 'running', 'succeeded', 'uncertain', 'failed', 'timed_out', 'cancelled'
  )),
  -- 去重键（内部字段，不出契约）：同主体同一次任务事件只存在一条历史行。
  event_key       varchar(120) NOT NULL CHECK (char_length(event_key) BETWEEN 1 AND 120),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- 两道去重键都在数据库级：任一条命中都必须是 `duplicate`，不得写成第二行。
CREATE UNIQUE INDEX history_owner_event_key ON history (owner_id, event_key);
CREATE UNIQUE INDEX history_owner_target_key ON history (owner_id, kind, target_id);
CREATE INDEX history_owner_created_idx ON history (owner_id, created_at DESC, id DESC);

-- ---------------------------------------------------------------------------
-- 幂等台账（两个域各一张；结构逐列相同，只有表名与 `outcome` 的联合类型不同）
-- ---------------------------------------------------------------------------
CREATE TABLE favorites_idempotency (
  -- scope = `<主体>\n<METHOD>\n<路径>`（沿用 `auth/idempotency.ts` 口径，不另造格式）。
  scope           varchar(200) NOT NULL CHECK (char_length(scope) BETWEEN 1 AND 200),
  -- 幂等键的 HMAC 摘要（不落明文键）。
  key_hash        varchar(128) NOT NULL CHECK (char_length(key_hash) BETWEEN 1 AND 128),
  request_hash    varchar(128) NOT NULL CHECK (char_length(request_hash) BETWEEN 1 AND 128),
  response_status smallint NOT NULL CHECK (response_status BETWEEN 100 AND 599),
  -- `NULL` = 已认领未完成；对象 = 已完成的结果引用（重放时按引用重新鉴权后重读）。
  outcome         jsonb CHECK (outcome IS NULL OR jsonb_typeof(outcome) = 'object'),
  expires_at      timestamptz NOT NULL,
  PRIMARY KEY (scope, key_hash)
);
-- 过期行清理/扫描（本片不建定时任务，仅留索引；`claim` 用 `expires_at <= now` 直接判过期）。
CREATE INDEX favorites_idempotency_expires_idx ON favorites_idempotency (expires_at);

CREATE TABLE history_idempotency (
  scope           varchar(200) NOT NULL CHECK (char_length(scope) BETWEEN 1 AND 200),
  key_hash        varchar(128) NOT NULL CHECK (char_length(key_hash) BETWEEN 1 AND 128),
  request_hash    varchar(128) NOT NULL CHECK (char_length(request_hash) BETWEEN 1 AND 128),
  response_status smallint NOT NULL CHECK (response_status BETWEEN 100 AND 599),
  -- 历史域结果引用多一个 `cascade` 披露（`initiated|unwired|failed`），同列同形状。
  outcome         jsonb CHECK (outcome IS NULL OR jsonb_typeof(outcome) = 'object'),
  expires_at      timestamptz NOT NULL,
  PRIMARY KEY (scope, key_hash)
);
CREATE INDEX history_idempotency_expires_idx ON history_idempotency (expires_at);

COMMIT;
