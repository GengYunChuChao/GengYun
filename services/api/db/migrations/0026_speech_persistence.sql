-- GY-R28 S20 · 普通话录音与转写域从**进程内 store** 接到真实 PostgreSQL 持久化。
--
-- 此前 `services/api/src/speech/store.ts` 只有内存实现（`createMemorySpeechStore()`，`persistent: false`），
-- 进程重启后转写任务与转写记录全丢。本迁移只服务 `SpeechStore` 的**已冻结 12 个方法**，
-- 不新增契约字段、不改任何对外 API、不改任何既有表/索引/枚举/数据。
--
-- 回滚：services/api/db/migrations/rollback/0026_speech_persistence.down.sql（纯新增 ⇒ 可整表拆除）
-- ============================================================================
--
-- ## 三张表（一张都不多，逐张对应 12 个方法的读写对象）
--   1. `speech_jobs`       —— 任务行（`insertJob` / `getJob` / `updateJob` / `commitTerminal` 的写入面）；
--   2. `transcriptions`    —— 转写记录行（`insertTranscription` / `getTranscription` / `updateTranscription` /
--      `commitTerminal` 的记录面）；
--   3. `speech_idempotency` —— 域内幂等台账（`findIdempotent` / `claimIdempotent` / `finalizeIdempotent` /
--      `releaseIdempotent` / `purgeIdempotent`）。
--
-- ## 为什么不复用 0001 的 `jobs` 表
-- `0001_initial_schema.sql:203` 的 `jobs` 是**共享任务台账**，其行形状与 `SpeechJobRow`
-- 不是同一套字段，硬写就必须**发明接口里不存在的值**（本仓一贯口径：不伪造、不造占位）：
--   * `jobs` 要求 `target_type` / `target_id` / `entity_revision` / `input_hash` / `auth_epoch`，
--     而 `SpeechJobRow` **没有**这些字段（它只带 `mediaId` / `mediaRevision` / `deadlineAt`）；
--   * `jobs` 的 `owner_id` 与 `actor_admin_id` 是"恰一"约束、`owner_id` 可空且**无** `ON DELETE CASCADE`，
--     而本域行恒有归属者，且注销删除必须级联（与 0016/0019/0022/0024/0025 同口径）；
--   * `jobs` 还带 `kind` 与状态机之外的重试/心跳列，本域 store 一个都不读。
-- 因此本域自建三张表；0001 的 `jobs` 原样留给共享作业面，本迁移不读、不写、不删。
--
-- ## `state` 直接复用 0001 的 `job_state` 枚举（派单 §2.1 指定）
-- `0001_initial_schema.sql:24` 的 `CREATE TYPE job_state AS ENUM ('queued','running','succeeded',
-- 'uncertain','failed','timed_out','cancelled')` 与 `services/api/src/speech/state.ts:81` 的
-- `JOB_STATES` **逐值同形**（后者是从冻结契约抄来的实现侧闭集）。既然库侧已有同值枚举，
-- 本迁移按派单写成 `state job_state NOT NULL`：库侧闭集与实现侧闭集不会分叉，
-- 也不新建第二套枚举。写入值恒来自 `JobState` 类型（`state.ts`），库只做最后一层拦截。
--
-- ## CAS（`updateJob` / `updateTranscription` 的「revision 不匹配 ⇒ 返回 null」）是**一条带 WHERE 的 UPDATE**
-- 两个方法在 SQL 层都是**单条**
--     UPDATE <table> SET … WHERE id = $1 AND revision = $2 RETURNING …
-- ⇒ **判定权在数据库**：并发写只会有一个赢，输的那条 UPDATE 返回 0 行 ⇒ 应用侧返回 `null`
-- （不覆盖他人并发写）。`revision integer NOT NULL CHECK (revision >= 1)` 是这条比较令牌的载体
-- （与 0018/0019/0022/0024/0025 的 `revision` 列同口径；强 `ETag "<revision>"` 由它派生）。
--
-- ## `commitTerminal` 的原子性靠**行锁 + 单事务**，不靠"先查后写"
-- `commitTerminal` 必须在**同一临界区**内完成「CAS 校验 + 合法迁移校验 + 写转写记录（可为 null）
-- + 落任务终态」，且 CAS 失败时**不写任何记录**。`transcriptions.id` 是主键 ⇒ 记录 id 冲突由数据库
-- 唯一性裁决（23505），不是先 SELECT 再 INSERT 的检查-写入窗口；任务行的 CAS 由
-- `SELECT … FOR UPDATE` + 带 `revision` 谓词的 UPDATE 在同一事务内保证。
-- 本迁移不把状态机（`canTransitionJob`）编码进 SQL：迁移边界的唯一事实来源是
-- `services/api/src/speech/state.ts:107`，复制一份到 CHECK 里迟早分叉。
--
-- ## 幂等台账：`payload` 在**占位时**就有值，`pending` 是显式列（与 0019/0022/0024 不同）
-- `speech/service.ts:451` 的占位把 `{job_id}` **当场**写进台账（占位记录本身就是"这个键对应这个任务"的
-- 原子凭据），并发重复请求据此定位同一个任务；`IdempotencyRow` 也把 `pending` 作为独立布尔字段。
-- 因此本表用 `payload jsonb NOT NULL` + `pending boolean NOT NULL` 两列如实表达，
-- **不**能像 0019/0022 那样用 `outcome IS NULL` 兼任"未完成"（那会丢掉占位期的 payload）。
-- `claimIdempotent` 的"检查 + 写入"是**单条**语句：
--     INSERT … ON CONFLICT (scope, key_hash) DO NOTHING RETURNING scope
-- 唯一约束 `(scope, key_hash)` 同时是该语句的冲突目标与"同键只允许首个调用方占位"的裁决者：
-- 写入成功并返回行 ⇒ `'claimed'`；已存在 ⇒ 不写入、不返回行 ⇒ `'exists'`（派单 §2.2）。
-- 过期条目的重新占位由服务层先 `purgeIdempotent(at)` 物理删除到期行再 claim
-- （`speech/service.ts:307`），因此 `DO NOTHING` 不会把"已过期"误判成"仍在占位"。
--
-- ## 列类型口径（与既有迁移一致）
--   * `id` / `owner_user_id` / `transcription_id` / `media_id` 是 uuid（本域 id 由 `randomUUID()` 产生：
--     `speech/service.ts` 的 `idFactory` 默认值）；`transcription_id` 指向的记录行**在任务写入时还不存在**
--     （记录由 `commitTerminal` 一起落库），在此加外键会把"先建任务、后产记录"的正常时序变成拒绝
--     ⇒ 与 0024 的 `ocr_id` 同口径：**不做外键**；
--   * `media_id` 同理不引用 `media` 表：录音对象的媒资行由媒体域持有，本域只存引用
--     （与 0024 的 `media_id` 一致），避免把跨域删除时序耦进来；
--   * `uncertain_spans` 是 `jsonb` 数组（契约 `UncertainSpan[]`，最多 100 项）：形状与条数由
--     `speech/state.ts` 的 gate 在写入前校验，库侧只做 `jsonb_typeof = 'array'` 的粗判；
--   * `raw_text` / `confirmed_text` 是 `text`：契约给的边界是**码点长度**（8000），
--     库侧 `char_length` 是字符长度，二者对 BMP 之外字符的口径差异在服务层已按码点拦过
--     （`requireTranscriptText` / `normalizeConfirmedText`），库侧约束是第二层兜底而非判据。
--
-- ## 授权（本片**不做**，如实登记）
-- 本迁移不新增任何角色/GRANT，也不改 `deploy/postgres-cvm/**`。三张表的运行时权限属**后续授权片**
-- （照 S24/S26/S28 范式），在授权片落地前，运行时角色访问本域表会得到 `42501`（权限不足）。
-- ⛔ 不得为了"先跑通"在这里 GRANT，也不得把这层缺失折成 provider 故障。
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 转写任务行
-- ---------------------------------------------------------------------------
CREATE TABLE speech_jobs (
  id               uuid        PRIMARY KEY,
  -- 行版本：初始 1，每次成功变更 +1（CAS 比较令牌；强 ETag `"<revision>"` 由它派生）。
  revision         integer     NOT NULL CHECK (revision >= 1),
  -- 记录种类（契约 Job.kind 的闭集里本域只产 'transcription'）；单一取值也写成 CHECK，防脏值进来。
  kind             text        NOT NULL CHECK (kind = 'transcription'),
  -- 归属者：注销删除时任务随之级联（与 0016/0019/0022/0024/0025 同口径，不把注销卡在外键上）。
  owner_user_id    uuid        NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  -- 本任务将来产出的转写记录 id（记录由 commitTerminal 一起落库 ⇒ 此处不做外键，见文件头）。
  transcription_id uuid        NOT NULL,
  media_id         uuid        NOT NULL,
  media_revision   integer     NOT NULL CHECK (media_revision >= 1),
  -- 0001 的 `job_state` 枚举（7 值闭集，与 speech/state.ts 的 JOB_STATES 逐值同形）。
  state            job_state   NOT NULL,
  deadline_at      timestamptz NOT NULL,
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL,
  -- 终态失败原因（成功/取消为 NULL）：闭集在 contract.ts 的 ErrorCode，本列只做长度约束。
  error_code       varchar(80) CHECK (error_code IS NULL OR char_length(error_code) >= 1)
);

-- 归属域 + 稳定排序键；同时服务 `users` 注销级联时的 owner 查找（FK 无索引会退化成全表扫描）。
CREATE INDEX speech_jobs_owner_created_idx ON speech_jobs (owner_user_id, created_at DESC, id DESC);

-- ---------------------------------------------------------------------------
-- 转写记录行
-- ---------------------------------------------------------------------------
CREATE TABLE transcriptions (
  id              uuid        PRIMARY KEY,
  revision        integer     NOT NULL CHECK (revision >= 1),
  owner_user_id   uuid        NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  media_id        uuid        NOT NULL,
  media_revision  integer     NOT NULL CHECK (media_revision >= 1),
  -- 模型原始输出：**任何用户核对都不得改写本列**（存储层不变量见 speech/store.ts 文件头）。
  raw_text        text        NOT NULL CHECK (char_length(raw_text) <= 8000),
  -- 提供者如实上报的不确定区间（契约 UncertainSpan[]，最多 100 项）：**不得删改或补造**。
  uncertain_spans jsonb       NOT NULL CHECK (jsonb_typeof(uncertain_spans) = 'array'),
  -- 用户核对后的文本：与 raw_text 严格分离（不计入模型准确率）；未核对为 NULL。
  confirmed_text  text        CHECK (confirmed_text IS NULL OR char_length(confirmed_text) BETWEEN 1 AND 8000),
  confirmed_at    timestamptz,
  model_version   text        NOT NULL CHECK (char_length(model_version) BETWEEN 1 AND 80),
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL,
  -- 软删标记（DELETE /speech/transcriptions/{id} 只置位，不物理删除行；行与 revision 都保留）。
  deleted         boolean     NOT NULL
);

CREATE INDEX transcriptions_owner_created_idx ON transcriptions (owner_user_id, created_at DESC, id DESC);

-- ---------------------------------------------------------------------------
-- 域内幂等台账（独立存放，不共用 0008 的认证台账：结果引用联合类型不同，回滚也要能独立拆除）
-- ---------------------------------------------------------------------------
CREATE TABLE speech_idempotency (
  -- scope = `<主体>\n<METHOD>\n<路径>`（沿用 auth/idempotency.ts 口径，不另造格式）。
  scope        varchar(200) NOT NULL CHECK (char_length(scope) BETWEEN 1 AND 200),
  -- 幂等键的 HMAC 摘要（不落明文键；hex 文本，与 0018/0022/0024 的 key_hash 同型）。
  key_hash     varchar(128) NOT NULL CHECK (char_length(key_hash) BETWEEN 1 AND 128),
  request_hash varchar(128) NOT NULL CHECK (char_length(request_hash) BETWEEN 1 AND 128),
  -- 结果引用：占位期即写 `{job_id}`（并发重复请求据此定位同一任务），完成后写最终引用。
  payload      jsonb        NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  -- true = 已**原子占位**但业务尚未完成（并发同键请求必须回 REQUEST_IN_PROGRESS，不得重复执行副作用）。
  pending      boolean      NOT NULL,
  expires_at   timestamptz  NOT NULL,
  PRIMARY KEY (scope, key_hash)
);

-- 过期清理扫描（`purgeIdempotent` 的 `DELETE … WHERE expires_at <= $1`）。
CREATE INDEX speech_idempotency_expires_idx ON speech_idempotency (expires_at);

COMMIT;
