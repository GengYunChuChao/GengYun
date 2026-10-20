-- GY-R27 S10（#10）· 标签 OCR 域从**进程内 store** 接到真实 PostgreSQL 持久化。
--
-- 此前 `services/api/src/ocr/store.ts` 只有内存实现（`createMemoryOcrStore()`，`persistent: false`），
-- 进程重启后 OCR 任务与记录全丢。本迁移只服务 `OcrStore` 的**已冻结 12 个方法**，
-- 不新增契约字段、不改任何对外 API、不改任何既有表/索引/枚举/数据。
--
-- 回滚：services/api/db/migrations/rollback/0024_ocr_persistence.down.sql（纯新增 ⇒ 可整表拆除）
-- ============================================================================
--
-- ## 三张表（一张都不多，逐张对应 12 个方法的读写对象）
--   1. `ocr_jobs`        —— 任务行（`insertJob` / `getJob` / `updateJob` / `commitTerminal` 的写入面）；
--   2. `ocr_records`     —— OCR 记录行（`insertOcr` / `getOcr` / `updateOcr` / `commitTerminal` 的记录面）；
--   3. `ocr_idempotency` —— 域内幂等台账（`findIdempotent` / `claimIdempotent` / `finalizeIdempotent` /
--      `releaseIdempotent` / `purgeIdempotent`）。
--
-- ## 为什么不复用 0001 的 `jobs` 表
-- `0001_initial_schema.sql:203` 的 `jobs` 是**共享任务台账**，其行形状与本域 store 的 `OcrJobRow`
-- 不是同一套字段，硬写就必须**发明接口里不存在的值**（本仓一贯口径：不伪造、不造占位）：
--   * `jobs` 要求 `target_type` / `target_id` / `entity_revision` / `input_hash` / `auth_epoch`，
--     而 `OcrJobRow` **没有**这些字段（它只带 `mediaId` / `mediaRevision` / `deadlineAt`）；
--   * `jobs` 的 `owner_id` 与 `actor_admin_id` 是"恰一"约束、`owner_id` 可空且**无**`ON DELETE CASCADE`，
--     而本域行恒有归属者，且注销删除必须级联（与 0016/0019/0022 同口径）；
--   * `jobs.state` 是 0001 的 `job_state` **枚举**，而 `OcrJobRow.state` 是 `text` 形状的同一 7 值闭集
--     （`services/api/src/ocr/state.ts:149` 的 `JOB_STATES`）。本迁移按派单口径建
--     `state text` + `CHECK (state IN (…7 值…))`：库侧仍拦成闭集，但**不**把记录形状绑到另一套枚举上
--     （枚举扩值要走 `ALTER TYPE`，而本域闭集的唯一事实来源是 `state.ts`，两者一旦分叉就是双真相）。
-- 因此本域自建三张表；0001 的 `jobs` 原样留给共享作业面，本迁移不读、不写、不删。
--
-- ## CAS（`updateJob` / `updateOcr` 的「revision 不匹配 ⇒ 返回 null」）是**一条带 WHERE 的 UPDATE**
-- 两个方法在 SQL 层都是**单条**
--     UPDATE <table> SET … WHERE id = $1 AND revision = $2 RETURNING …
-- ⇒ **判定权在数据库**：并发写只会有一个赢，输的那条 UPDATE 返回 0 行 ⇒ 应用侧返回 `null`
-- （不覆盖他人并发写）。`revision integer NOT NULL CHECK (revision >= 1)` 是这条比较令牌的载体
-- （与 0018/0019/0022 的 `revision` 列同口径；强 `ETag "<revision>"` 由它派生）。
--
-- ## `commitTerminal` 的原子性靠**行锁 + 单事务**，不靠"先查后写"
-- `commitTerminal` 必须在**同一临界区**内完成「CAS 校验 + 合法迁移校验 + 写 OCR 记录（可为 null）
-- + 落任务终态」，且 CAS 失败时**不写任何记录**。`ocr_records.id` 是主键 ⇒ 记录 id 冲突由数据库
-- 唯一性裁决（23505），不是先 SELECT 再 INSERT 的检查-写入窗口；任务行的 CAS 由
-- `SELECT … FOR UPDATE` + 带 `revision` 谓词的 UPDATE 在同一事务内保证。
-- 本迁移不把状态机（`canTransitionJob`）编码进 SQL：迁移边界的唯一事实来源是
-- `services/api/src/ocr/state.ts:175`，复制一份到 CHECK 里迟早分叉。
--
-- ## 幂等台账：`payload` 在**占位时**就有值，`pending` 是显式列（与 0019/0022 的 `outcome IS NULL` 不同）
-- `ocr/service.ts:331` 的占位把 `{job_id}` **当场**写进台账（占位记录本身就是"这个键对应这个任务"的
-- 原子凭据），并发重复请求据此定位同一个任务；`IdempotencyRow` 也把 `pending` 作为独立布尔字段。
-- 因此本表用 `payload jsonb NOT NULL` + `pending boolean NOT NULL` 两列如实表达，
-- **不**能像 0019/0022 那样用 `outcome IS NULL` 兼任"未完成"（那会丢掉占位期的 payload）。
-- `claimIdempotent` 的"检查 + 写入"是**单条**语句：
--     INSERT … ON CONFLICT (scope, key_hash) DO UPDATE SET … WHERE ocr_idempotency.expires_at <= $at
--     RETURNING scope
-- 已存在且未到期 ⇒ ON CONFLICT 的 WHERE 为假 ⇒ 不更新、不返回行 ⇒ `'exists'`；
-- 不存在或已到期 ⇒ 写入/覆盖并返回行 ⇒ `'claimed'`。主键 `(scope, key_hash)` 同时是该语句的
-- 冲突目标与"同键只允许首个调用方占位"的裁决者。
--
-- ## 列类型口径（与既有迁移一致）
--   * `id` / `owner_user_id` / `ocr_id` / `media_id` 是 uuid（本域 id 由 `randomUUID()` 产生：
--     `ocr/service.ts` 的 `idFactory` 默认值）；`media_id` 之外的三项不做外键：
--     `ocr_id` 指向的**记录行在任务写入时还不存在**（记录由 `commitTerminal` 一起落库），
--     在此加外键会把"先建任务、后产记录"的正常时序变成拒绝；
--   * 时间列是 `timestamptz NOT NULL`：写入时刻一律由服务注入（`now()` 的毫秒精度 Date，
--     RFC3339 同精度回读 ⇒ 不出现"返回值被截断、WHERE 里仍是更高精度"的漂移）；
--   * 三列 jsonb（`raw_fields` / `corrected_fields` / `verification`）逐列 CHECK 成 object：
--     `raw_fields` 与 `corrected_fields` 是**两个独立列**（契约 `correctOCR` 明文要求保留原始输出，
--     校正不得改写 raw；本迁移不合并两列，是因为合并后"模型准确率"就不再有可信基线）；
--   * `deleted` 是**软删标记**（`deleteOCR` 只置位，不物理删除）⇒ 保留行、保留 revision 推进。
--
-- ## 边界（如实登记）
--   * `ocr_jobs_owner_created_idx` / `ocr_records_owner_created_idx` 按派单要求建在
--     `(owner_user_id, created_at DESC, id DESC)` 上；当前 `OcrStore` 的 12 个方法里**没有**
--     "按 owner 列列表"的查询（读面一律走主键）⇒ 这两个索引**当前不被任何语句命中**。
--     ⛔ 不声称它们已被查询使用：它们服务于归属域过滤的运维排查与将来的列表面。
--   * `error_code` 只做长度约束（`varchar(80)`，与 0001 `jobs.error_code` 同型）：错误码闭集由
--     `services/api/src/contract.ts` 的 `ErrorCode` 在 TS 侧保证，本迁移**不**另抄一份闭集。
BEGIN;

-- ---------------------------------------------------------------------------
-- 任务行
-- ---------------------------------------------------------------------------
CREATE TABLE ocr_jobs (
  id             uuid        PRIMARY KEY,
  -- 行版本：初始 1，每次成功变更 +1（CAS 比较令牌；强 ETag `"<revision>"` 由它派生）。
  revision       integer     NOT NULL CHECK (revision >= 1),
  -- 记录种类（契约 Job.kind 的闭集里本域只产 'ocr'）；单一取值也写成 CHECK，防脏值进来。
  kind           text        NOT NULL CHECK (kind = 'ocr'),
  -- 归属者：注销删除时任务随之级联（与 0016/0019/0022 同口径，不把注销卡在外键上）。
  owner_user_id  uuid        NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  -- 本任务将来产出的 OCR 记录 id（记录由 commitTerminal 一起落库 ⇒ 此处不做外键，见文件头）。
  ocr_id         uuid        NOT NULL,
  media_id       uuid        NOT NULL,
  media_revision integer     NOT NULL CHECK (media_revision >= 1),
  -- 契约 JobState 的 7 值闭集（`state.ts:149` 的 JOB_STATES，逐值抄自冻结契约）。
  state          text        NOT NULL CHECK (state IN (
    'queued', 'running', 'succeeded', 'uncertain', 'failed', 'timed_out', 'cancelled'
  )),
  deadline_at    timestamptz NOT NULL,
  created_at     timestamptz NOT NULL,
  updated_at     timestamptz NOT NULL,
  -- 终态失败原因（成功/取消为 NULL）：闭集在 contract.ts 的 ErrorCode，本列只做长度约束。
  error_code     varchar(80) CHECK (error_code IS NULL OR char_length(error_code) >= 1)
);

-- 归属域 + 稳定排序键（见文件头「边界」：当前无列表查询命中，按派单要求建立）。
CREATE INDEX ocr_jobs_owner_created_idx ON ocr_jobs (owner_user_id, created_at DESC, id DESC);

-- ---------------------------------------------------------------------------
-- OCR 记录行
-- ---------------------------------------------------------------------------
CREATE TABLE ocr_records (
  id               uuid        PRIMARY KEY,
  revision         integer     NOT NULL CHECK (revision >= 1),
  owner_user_id    uuid        NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  media_id         uuid        NOT NULL,
  media_revision   integer     NOT NULL CHECK (media_revision >= 1),
  -- 模型原始输出：**任何用户校正都不得改写**（契约 correctOCR 明文要求保留 raw_fields）。
  raw_fields       jsonb       NOT NULL CHECK (jsonb_typeof(raw_fields) = 'object'),
  -- 用户校正后的字段：与 raw_fields 严格分离（不计入模型准确率）。
  corrected_fields jsonb       NOT NULL CHECK (jsonb_typeof(corrected_fields) = 'object'),
  -- 契约 Verification 投影（五字段全必填）；形状由 ocr/state.ts 的 gate 在写入前校验。
  verification     jsonb       NOT NULL CHECK (jsonb_typeof(verification) = 'object'),
  model_version    text        NOT NULL CHECK (char_length(model_version) BETWEEN 1 AND 120),
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL,
  -- 软删标记（deleteOCR 只置位，不物理删除行；行与 revision 都保留）。
  deleted          boolean     NOT NULL
);

CREATE INDEX ocr_records_owner_created_idx ON ocr_records (owner_user_id, created_at DESC, id DESC);

-- ---------------------------------------------------------------------------
-- 域内幂等台账（独立存放，不共用 0008 的认证台账：结果引用联合类型不同，回滚也要能独立拆除）
-- ---------------------------------------------------------------------------
CREATE TABLE ocr_idempotency (
  -- scope = `<主体>\n<METHOD>\n<路径>`（沿用 auth/idempotency.ts 口径，不另造格式）。
  scope           varchar(200) NOT NULL CHECK (char_length(scope) BETWEEN 1 AND 200),
  -- 幂等键的 HMAC 摘要（不落明文键；hex 文本，与 0018/0022 的 key_hash 同型）。
  key_hash        varchar(128) NOT NULL CHECK (char_length(key_hash) BETWEEN 1 AND 128),
  request_hash    varchar(128) NOT NULL CHECK (char_length(request_hash) BETWEEN 1 AND 128),
  -- 结果引用：占位期即写 `{job_id}`（并发重复请求据此定位同一任务），完成后写最终引用。
  payload         jsonb        NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  -- true = 已**原子占位**但业务尚未完成（并发同键请求必须回 REQUEST_IN_PROGRESS，不得重复执行副作用）。
  pending         boolean      NOT NULL,
  expires_at      timestamptz  NOT NULL,
  PRIMARY KEY (scope, key_hash)
);

-- 过期清理扫描（`purgeIdempotent` 的 `DELETE … WHERE expires_at <= $1`）。
CREATE INDEX ocr_idempotency_expires_idx ON ocr_idempotency (expires_at);

COMMIT;
