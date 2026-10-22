-- GY-R29 S7 · 审核判定台账落库（迁移 0028）
--
-- 此前 `services/api/src/moderation/decisions.ts` 只有内存实现（`createModerationLedger()`，
-- 纯 `Map`/`Set`）：进程重启后审核结论全丢。本迁移给它两张表，语义与内存台账**逐条对齐**
-- （接口 `ModerationLedger`：`create / update / byJobId / current / forRevision / history /
-- markWithdrawn / isWithdrawn / snapshotCounts`）：
--
--   1. `moderation_decisions`  —— 任务行（`create` / `update` 的写入面；读面由服务端内存承接）
--   2. `moderation_withdrawals` —— 下架标记（`markWithdrawn` / `isWithdrawn`）
--
-- 回滚：services/api/db/migrations/rollback/0028_moderation_persistence.down.sql（纯新增 ⇒ 整表拆掉）
--
-- ## 为什么不复用 0001 的 `jobs` 表
-- `0001_initial_schema.sql` 的 `jobs` 是**共享作业面**（`target_type/target_id/entity_revision/
-- input_hash/auth_epoch/owner_id/actor_admin_id`），而 `ModerationTaskRecord`
-- （`services/api/src/moderation/types.ts:177-212`）的形状是另一套：`job_id`、`prompt_id`、
-- `job_revision`、`port_kind`、`lease_token`、`authorization_epoch`、`gate_holder`、`evidence`、
-- `superseded`。硬塞就必须"发明接口里不存在的值"（本仓一贯口径：不伪造、不造占位），
-- 因此本域自建表，`jobs` 原样留给共享作业面——不写、不改、不删。
--
-- ## `state` 直接复用 0001 的 `job_state` 枚举
-- `0001_initial_schema.sql` 已有 `CREATE TYPE job_state AS ENUM ('queued','running','succeeded',
-- 'uncertain','failed','timed_out','cancelled')`，与 `services/api/src/moderation/types.ts` 的
-- `JOB_STATES` **逐值同形**（顺序、拼写一致）。库侧既有同值枚举 ⇒ 不新建第二套枚举，
-- 写入值永远来自 `JobState` 类型，库只做最后一层拦截。
--
-- ## 为什么"当前任务"用部分唯一索引，而不是一列 current 指针
-- 内存台账的 `current` 是 `Map<taskKey, record>`，语义是"每个
-- `(target_type,target_id,target_revision,content_kind)` 至多一条未被 superseded 的行"。
-- 这条不变式交给数据库最省事：
--     CREATE UNIQUE INDEX ... ON (target_type,target_id,target_revision,content_kind)
--       WHERE superseded = FALSE
-- ⇒ 并发两次 `create` 同键任务，第二次要么先把旧行置 superseded（同一事务内 UPDATE 拿到行锁），
-- 要么撞唯一索引失败；**不会**出现两条"当前结论"。判定权在数据库，不靠先查后写。
--
-- ## 幂等
-- `job_id` 是主键：同一条任务重复落库走 `ON CONFLICT (job_id) DO NOTHING`，不产生第二行。
-- 下架是终态：`moderation_withdrawals` 主键 `(target_type,target_id,target_revision)` +
-- `ON CONFLICT DO NOTHING` ⇒ 重放同一个下架不报错、不新增行。
--
-- ## 为什么下架键含 revision（与派单措辞的偏差，已报备）
-- 派单写的是 `moderation_withdrawals(comment_id PK, withdrawn_at, withdrawn_by)`。但台账的
-- `markWithdrawn(target)` 键是 `targetKey = type|id|revision`（`decisions.ts:63-65`），
-- 而且**帖子也会被下架**（`moderation/service.ts:848` 的 `withdraw` 服务的是任意
-- `TargetRef`），评论又存在 `community_comments` 而不是本表。按 `comment_id` 落会把
-- 帖子下架、以及"同一评论不同 revision 各自下架"这两件事表达错，因此主键落成
-- `(target_type,target_id,target_revision)`：语义与内存 `withdrawn` 集合逐键一致。
--
-- ## 不做 hydrate、不动契约
-- 存量行"当初有没有结论"在库层面同样不可区分（决策：只读面用 `present=false ⇒ unknown`
-- 表达，不改社区契约、不动 `openapi.json`）。本表只写不读，进程启动不回填内存台账。
-- ----------------------------------------------------------------------------

BEGIN;

CREATE TABLE public.moderation_decisions (
  -- 任务身份
  job_id              uuid        PRIMARY KEY,
  target_type         text        NOT NULL,
  target_id           text        NOT NULL,
  target_revision     integer     NOT NULL CHECK (target_revision >= 1),
  content_kind        text        NOT NULL CHECK (content_kind IN ('text', 'image')),
  -- 端口与提示词
  port_kind           text        NOT NULL CHECK (port_kind IN ('tms', 'ims')),
  prompt_id           text        NOT NULL,
  prompt_version      text        NULL,
  -- 任务推进面
  job_revision        integer     NOT NULL CHECK (job_revision >= 1),
  state               job_state   NOT NULL,
  lease_token         uuid        NULL,
  authorization_epoch integer     NOT NULL CHECK (authorization_epoch >= 1),
  submitted_by        uuid        NOT NULL,
  deadline_at         timestamptz NULL,
  error_code          text        NULL,
  -- 结论面（判定 + 版本 + 证据快照）
  decision            text        NULL CHECK (decision IS NULL OR decision IN ('pending', 'approved', 'rejected', 'quarantined')),
  reason_codes        jsonb       NOT NULL CHECK (jsonb_typeof(reason_codes) = 'array'),
  hard_rule_passed    boolean     NOT NULL,
  rule_version        text        NULL,
  model_version       text        NULL,
  contract_value      jsonb       NULL,
  gate_holder         jsonb       NULL,
  evidence            jsonb       NOT NULL,
  -- 台账自身
  superseded          boolean     NOT NULL DEFAULT FALSE,
  created_at          timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL
);

-- "每个目标版本每个内容类别至多一条当前任务"（内存台账 `current` 的不变式）。
CREATE UNIQUE INDEX moderation_decisions_current_key
  ON public.moderation_decisions (target_type, target_id, target_revision, content_kind)
  WHERE superseded = FALSE;

-- 目标维检索：`forRevision` / `history` / 读面重查（按目标取结论）。
CREATE INDEX moderation_decisions_target_idx
  ON public.moderation_decisions (target_type, target_id, target_revision, created_at DESC, job_id DESC);

-- 审计面：按时间回溯"当时用了哪版规则/哪个模型"。
CREATE INDEX moderation_decisions_created_idx
  ON public.moderation_decisions (created_at DESC, job_id DESC);

CREATE TABLE public.moderation_withdrawals (
  target_type     text        NOT NULL,
  target_id       text        NOT NULL,
  target_revision integer     NOT NULL CHECK (target_revision >= 1),
  withdrawn_at    timestamptz NOT NULL,
  -- 下架动作的执行者（管理员）。台账接口没有该形参，落库实现写 NULL；
  -- 保留列是为了让运维面能逐步补齐，而不是让每次补人都要再改一次表。
  withdrawn_by    uuid        NULL,
  PRIMARY KEY (target_type, target_id, target_revision)
);

CREATE INDEX moderation_withdrawals_recent_idx
  ON public.moderation_withdrawals (withdrawn_at DESC, target_type, target_id);

COMMIT;
