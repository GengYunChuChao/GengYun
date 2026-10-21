-- GY-R28 S13 · 识别域（杂草识别）从**进程内 store** 接到真实 PostgreSQL 持久化。
--
-- 此前 `services/api/src/recognitions/store.ts` 只有内存实现（`createMemoryRecognitionStore()`，
-- `persistent: false`），进程重启后识别任务、识别记录与用户选择全丢。本迁移只服务
-- `RecognitionStore` 的**已冻结 13 个方法**，不新增契约字段、不改任何对外 API、
-- 不改任何既有表/索引/枚举/数据。
--
-- 回滚：services/api/db/migrations/rollback/0025_recognitions_persistence.down.sql（纯新增 ⇒ 可整表拆除）
-- ============================================================================
--
-- ## 四张表（一张都不多，逐张对应 13 个方法的读写对象）
--   1. `recognition_jobs`       —— 任务行（`insertJob` / `getJob` / `updateJob` / `commitTerminal` 的写入面）；
--   2. `recognition_records`    —— 识别记录行（`insertRecognition` / `getRecognition` / `updateRecognition` /
--      `commitTerminal` 的记录面）；
--   3. `recognition_selections` —— 用户选择记录（**追加型**：`commitSelection` 写、`listSelections` 读）；
--   4. `recognition_idempotency` —— 域内幂等台账（`claimIdempotent` / `completeIdempotent` /
--      `releaseIdempotent` / `purgeIdempotent`）。
--
-- ## 为什么不复用 0001 的 `jobs` 表
-- `0001_initial_schema.sql:203` 的 `jobs` 是**共享任务台账**，其行形状与本域 store 的 `JobRow`
-- 不是同一套字段，硬写就必须**发明接口里不存在的值**（本仓一贯口径：不伪造、不造占位）：
--   * `jobs` 要求 `target_type` / `target_id` / `entity_revision` / `input_hash` / `auth_epoch`，
--     而 `JobRow` **没有**这些字段（它只带 `recognitionId` / `mediaId` / `mediaRevision` / `deadlineAt`）；
--   * `jobs` 的 `owner_id` 与 `actor_admin_id` 是"恰一"约束、`owner_id` 可空且**无**`ON DELETE CASCADE`，
--     而本域行恒有归属者，且注销删除必须级联（与 0016/0019/0022/0024 同口径）；
--   * `jobs` 另带 `attempt` / `lease_expires_at` / `dedupe_key` 等派发字段，本域不持有。
-- 因此本域自建任务表；0001 的 `jobs` 原样留给共享作业面，本迁移不读、不写、不删。
--
-- ## `state` 列**直接引用** 0001 的 `job_state` 枚举（同库**首次跨域复用**；与 0024 的 `text + CHECK` 相反）
-- 派单口径：`job_state` 已在 `0001_initial_schema.sql:24` 建过，含 `cancelled`，本片**直接引用**、
-- ⛔ 不重建类型。核对结果：该枚举的 7 个取值
--     `'queued', 'running', 'succeeded', 'uncertain', 'failed', 'timed_out', 'cancelled'`
-- 与 `services/api/src/recognitions/state.ts:17` 的 `JOB_STATES` **逐字相同**（顺序也相同）。
-- 先例如实登记：`0001..0024` 里**唯一**真正引用该枚举的列是 `0001_initial_schema.sql:211` 的 `jobs.state`；
-- `0013_conversations.sql:70-71`（`varchar(20) + CHECK`）、`0018_favorites_history.sql:87`（`varchar(16) + CHECK`）、
-- `0024_ocr_persistence.sql:93`（`text + CHECK`）都走 CHECK 而非枚举——那是「不为记录形状另绑枚举」的
-- 另一种取向，**不是**本迁移的引用先例。故本片是该枚举第一次被 `jobs` 以外的域复用（只是复用既有类型，
-- 不重建同义类型；同库也没有第二个 `job_state` 类型可建）。
-- 与 0024 的差异如实登记：0024 自建 `text + CHECK`，理由是「不用为记录形状绑另一套枚举」；
-- 本片按派单选枚举，代价是将来扩值要走 `ALTER TYPE`（**不会**让库侧闭集与 `state.ts` 分叉：
-- 枚举是本片唯一的库侧闭集，比一份手抄的 `CHECK (state IN …)` 更不容易抄漏）。
--
-- ## CAS（`updateJob` / `updateRecognition` 的「revision 不匹配 ⇒ 返回 null」）是**一条带 WHERE 的 UPDATE**
-- 两个方法在 SQL 层都是**单条**
--     UPDATE <table> SET … WHERE id = $1 AND revision = $2 RETURNING …
-- ⇒ **判定权在数据库**：并发写只会有一个赢，输的那条 UPDATE 返回 0 行 ⇒ 应用侧返回 `null`
-- （不覆盖他人并发写）。`revision integer NOT NULL CHECK (revision >= 1)` 是这条比较令牌的载体
-- （与 0018/0019/0022/0024 的 `revision` 列同口径）。
--
-- ## `commitTerminal` / `commitSelection` 的原子性靠**行锁 + 单事务**，不靠"先查后写"
-- `commitTerminal` 必须在**同一临界区**内完成「CAS 校验 + 合法迁移校验 + 写识别记录（可为 null）
-- + 落任务终态」，且 CAS 失败时**不写任何记录**。`recognition_records.id` 是主键 ⇒ 记录 id 冲突由
-- 数据库唯一性裁决（23505），不是先 SELECT 再 INSERT 的检查-写入窗口；任务行的 CAS 由
-- `SELECT … FOR UPDATE` + 带 `revision` 谓词的 UPDATE 在同一事务内保证。
-- `commitSelection` 同理：识别记录的 CAS、选择行（追加，主键裁决重复 id）与记录行的
-- `selected_species_id` 推进必须在同一事务里，CAS 失败时**不追加选择行**。
-- 本迁移不把状态机（`canTransitionJob`）编码进 SQL：迁移边界的唯一事实来源是
-- `services/api/src/recognitions/state.ts`，复制一份到 CHECK 里迟早分叉。
--
-- ## 幂等台账：**一张表两种行态**（`pending` 列区分「占位中」与「已完成回执」）
-- 本域接口把"占位"与"回执"表达成同一个 `IdempotencyRow`（+ `pending` 列），内存实现用两张 Map
-- （`claims` / `idempotency`），落到库里就是**同一条主键行**的两种状态：
--   * `pending = true`  —— 已原子占位、业务尚未完成（并发同键请求回 `in_progress`）；
--   * `pending = false` —— 已完成，`payload` 是回执（并发同键请求回 `completed` + 回执）。
-- `claimIdempotent` 的"检查 + 写入"是**单条**语句：
--     INSERT … ON CONFLICT (scope, key_hash) DO UPDATE SET … WHERE recognition_idempotency.expires_at <= $at
--     RETURNING scope
-- 不存在或已到期 ⇒ 写入/覆盖并返回行 ⇒ `claimed`（单飞成功）；已存在且未到期 ⇒ `ON CONFLICT` 的
-- WHERE 为假 ⇒ 不更新、不返回行 ⇒ 随后用**同一条主键**读回该行，按 `request_hash` 是否相等与
-- `pending` 的真假分成 `conflict` / `in_progress` / `completed` 三种。主键 `(scope, key_hash)`
-- 既是冲突目标，也是"同键只允许首个调用方占位"的唯一裁决者 —— ⛔ 不存在"先查再插"的窗口。
-- `releaseIdempotent` **只**删占位行（`AND pending`），已完成回执不会被释放动作抹掉（与内存实现
-- 只 `claims.delete` 同义）；`purgeIdempotent` 删两种行态里已过期的，返回删除行数。
--
-- ## 列类型口径（与既有迁移一致）
--   * `id` / `owner_user_id` / `recognition_id` / `media_id` 是 uuid（本域 id 由 `randomUUID()` 产生：
--     `recognitions/service.ts` 的 `idFactory` 默认值）；任务表的 `recognition_id` **不做外键**：
--     它指向的记录行在任务写入时还不存在（记录由 `commitTerminal` 一起落库），在此加外键会把
--     "先建任务、后产记录"的正常时序变成拒绝（与 0024 的 `ocr_id` 同口径）；
--   * 选择表的 `recognition_id` **做**外键（指向 `recognition_records`，`ON DELETE CASCADE`）：
--     选择恒发生在记录之后，且"选择不挂在不存在/已拆除的记录上"是可守的；
--   * 时间列是 `timestamptz NOT NULL`：写入时刻一律由服务注入（`now()` 的毫秒精度 Date，
--     RFC3339 同精度回读 ⇒ 不出现"返回值被截断、WHERE 里仍是更高精度"的漂移）；
--   * `candidates` / `uncertainty_reasons` 逐列 CHECK 成 **array**（契约是数组，不是对象）——
--     与 0013/0024 的 `jsonb_typeof(...) = 'object'` 并列的**同一口径**，不是例外；
--   * `selected_species_id` 可空（未选择），非空时 1..80 与契约 `species_id.maxLength` 一致；
--   * `deleted` 是**软删标记**（`updateRecognition` 置位，不物理删除）⇒ 保留行、保留 revision 推进。
--
-- ## 边界（如实登记）
--   * `recognition_jobs_owner_created_idx` / `recognition_records_owner_created_idx` 按派单要求建在
--     `(owner_user_id, created_at DESC, id DESC)` 上；当前 `RecognitionStore` 的读面**没有**
--     "按 owner 列列表"的查询（一律走主键）⇒ 这两个索引**当前不被任何语句命中**。
--     ⛔ 不声称它们已被查询使用：它们服务于归属域过滤的运维排查与将来的列表面。
--   * `recognition_selections_recognition_decided_idx` 是**被命中**的：`listSelections` 的
--     `WHERE recognition_id = $1 AND owner_user_id = $2 ORDER BY decided_at, id` 正好走它。
--   * `error_code` 只做长度约束（`varchar(80)`，与 0001 `jobs.error_code` 同型）：错误码闭集由
--     `services/api/src/contract.ts` 的 `ErrorCode` 在 TS 侧保证，本迁移**不**另抄一份闭集。
BEGIN;

-- ---------------------------------------------------------------------------
-- 任务行
-- ---------------------------------------------------------------------------
CREATE TABLE recognition_jobs (
  id             uuid        PRIMARY KEY,
  -- 行版本：初始 1，每次成功变更 +1（CAS 比较令牌）。
  revision       integer     NOT NULL CHECK (revision >= 1),
  -- 记录种类（契约 Job.kind 的闭集里本域只产 'recognition'）；单一取值也写成 CHECK，防脏值进来。
  kind           text        NOT NULL CHECK (kind = 'recognition'),
  -- 归属者：注销删除时任务随之级联（与 0016/0019/0022/0024 同口径，不把注销卡在外键上）。
  owner_user_id  uuid        NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  -- 本任务将来产出的识别记录 id（记录由 commitTerminal 一起落库 ⇒ 此处不做外键，见文件头）。
  recognition_id uuid        NOT NULL,
  media_id       uuid        NOT NULL,
  media_revision integer     NOT NULL CHECK (media_revision >= 1),
  -- 契约 JobState 的 7 值闭集：**直接引用** 0001 的 `job_state` 枚举（逐值与 state.ts 的
  -- JOB_STATES 相同；不重建类型、也不手抄一份 CHECK，见文件头）。
  state          job_state   NOT NULL,
  deadline_at    timestamptz NOT NULL,
  created_at     timestamptz NOT NULL,
  updated_at     timestamptz NOT NULL,
  -- 终态失败原因（成功/取消为 NULL）：闭集在 contract.ts 的 ErrorCode，本列只做长度约束。
  error_code     varchar(80) CHECK (error_code IS NULL OR char_length(error_code) >= 1)
);

-- 归属域 + 稳定排序键（见文件头「边界」：当前无列表查询命中，按派单要求建立）。
CREATE INDEX recognition_jobs_owner_created_idx ON recognition_jobs (owner_user_id, created_at DESC, id DESC);

-- ---------------------------------------------------------------------------
-- 识别记录行
-- ---------------------------------------------------------------------------
CREATE TABLE recognition_records (
  id                 uuid        PRIMARY KEY,
  revision           integer     NOT NULL CHECK (revision >= 1),
  owner_user_id      uuid        NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  media_id           uuid        NOT NULL,
  media_revision     integer     NOT NULL CHECK (media_revision >= 1),
  -- 契约候选数组（maxItems 3，`{species_id, rank, model_score}` 三键全必填，由 state.ts 在写入前校验）；
  -- 形状是**数组**，故 CHECK 成 array。
  candidates         jsonb       NOT NULL CHECK (jsonb_typeof(candidates) = 'array'),
  -- 不确定性原因数组（maxItems 10，每条 maxLength 80）。
  uncertainty_reasons jsonb      NOT NULL CHECK (jsonb_typeof(uncertainty_reasons) = 'array'),
  -- 用户已确认的物种（未选择为 NULL）：非空时长度与契约 species_id 的 1..80 一致。
  selected_species_id text       CHECK (
    selected_species_id IS NULL OR char_length(selected_species_id) BETWEEN 1 AND 80
  ),
  model_version      text        NOT NULL CHECK (char_length(model_version) BETWEEN 1 AND 120),
  created_at         timestamptz NOT NULL,
  updated_at         timestamptz NOT NULL,
  -- 软删标记（updateRecognition 只置位，不物理删除行；行与 revision 都保留）。
  deleted            boolean     NOT NULL
);

CREATE INDEX recognition_records_owner_created_idx ON recognition_records (owner_user_id, created_at DESC, id DESC);

-- ---------------------------------------------------------------------------
-- 用户选择记录（**追加型**：每次确认追加一行，不原地改写；同 id 由主键裁决）
-- ---------------------------------------------------------------------------
CREATE TABLE recognition_selections (
  id             uuid        PRIMARY KEY,
  revision       integer     NOT NULL CHECK (revision >= 1),
  -- 选择恒指向一张**已经存在**的识别记录（`commitSelection` 先在同一事务里 CAS 该记录）⇒ 可做外键；
  -- 记录被物理拆除时选择随级联消失（软删不触发级联：deleted 只是置位）。
  recognition_id uuid        NOT NULL REFERENCES public.recognition_records (id) ON DELETE CASCADE,
  owner_user_id  uuid        NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  species_id     text        NOT NULL CHECK (char_length(species_id) BETWEEN 1 AND 80),
  -- 契约 SelectionProvenance 的 3 值闭集（`selection.ts` 的 SELECTION_PROVENANCE，逐值抄自冻结契约）。
  provenance     text        NOT NULL CHECK (provenance IN ('human', 'manual_override', 'preset_demo')),
  decided_at     timestamptz NOT NULL,
  -- 选择时依据的规则联动投影（纯 JSON，**不含 Date**；形状由 `linkage.ts` 在写入前校验）。
  linkage        jsonb       NOT NULL CHECK (jsonb_typeof(linkage) = 'object')
);

-- `listSelections`（`WHERE recognition_id = $1 AND owner_user_id = $2 ORDER BY decided_at, id`）的支撑索引。
CREATE INDEX recognition_selections_recognition_decided_idx
  ON recognition_selections (recognition_id, owner_user_id, decided_at, id);

-- ---------------------------------------------------------------------------
-- 域内幂等台账（独立存放，不共用 0008 的认证台账 / 0024 的 OCR 台账：回滚要能独立拆除）
-- ---------------------------------------------------------------------------
CREATE TABLE recognition_idempotency (
  -- scope = `<主体>\n<METHOD>\n<路径>`（沿用 auth/idempotency.ts 口径，不另造格式）。
  scope           varchar(200) NOT NULL CHECK (char_length(scope) BETWEEN 1 AND 200),
  -- 幂等键的 HMAC 摘要（不落明文键；hex 文本，与 0018/0022/0024 的 key_hash 同型）。
  key_hash        varchar(128) NOT NULL CHECK (char_length(key_hash) BETWEEN 1 AND 128),
  request_hash    varchar(128) NOT NULL CHECK (char_length(request_hash) BETWEEN 1 AND 128),
  -- 回执（结果引用）：占位期是空对象 `{}`，`completeIdempotent` 后是最终回执；只存**不含凭据**的引用。
  payload         jsonb        NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  -- true = 已**原子占位**但业务尚未完成（并发同键请求必须回 `in_progress`，不得重复执行副作用）；
  -- false = 已完成，`payload` 即回执（并发同键请求回 `completed`）。
  pending         boolean      NOT NULL,
  expires_at      timestamptz  NOT NULL,
  PRIMARY KEY (scope, key_hash)
);

-- 过期清理扫描（`purgeIdempotent` 的 `DELETE … WHERE expires_at <= $1`）。
CREATE INDEX recognition_idempotency_expires_idx ON recognition_idempotency (expires_at);

COMMIT;
