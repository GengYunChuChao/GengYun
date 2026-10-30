-- ============================================================================
-- GY-I12 / #12  文字问答：会话 / 轮次 / 回答的 PG 持久化 — 迁移 0013
-- ----------------------------------------------------------------------------
-- 依赖：0001（users / sessions / jobs 等初始表）与 0008（idempotency_keys 台账）。
--       本迁移**不重复创建、不修改**这些表；也不引用 0002~0011 的任何对象。
--
-- 本迁移新增三张表（会话 / 轮次 / 回答）：
--   conversations        —— 契约 `Conversation`（id / revision / conditions / created_at）
--                           + 服务端内部键 owner_id（契约里没有，**不进响应**）
--   conversation_turns   —— 契约 `Turn`（id / revision / input_text / transcription_ref /
--                           job_id / created_at）+ 作业快照列（job_state / job_error_code /
--                           job_deadline_at / job_created_at）+ 内部键 conversation_id / owner_id
--   conversation_answers —— 契约 `Answer`（十键全必填）+ 内部键 turn_id / owner_id
--
-- 为什么要作业快照列（而不是新开一张作业表）：
--   `createTurn` 契约返回 **202 `JobEnvelope`**（`kind: 'answer'`），随后该作业必须能被
--   已合并的跨 kind 读面 `GET /jobs/{id}` 读到。仓库**唯一的**作业读面是
--   `services/api/src/jobs/registry.ts` + 各域自己的 `JobSourcePort`；`jobs` 表（0001）
--   在代码里没有任何写入者（grep `INSERT INTO jobs` 为空），自建一套作业行会与读面口径分叉。
--   【历史快照，别照抄】上面这句是 0013 落地当时的事实；GY-R71（2026-10-30）起 `public.jobs` 有了
--   唯一写入者 `services/api/src/jobs/ledger.ts`（四源、与源表同一事务、`ON CONFLICT (id)` 幂等），
--   本迁移的结论因此只剩一半：轮次行仍是 answer 作业的**权威**（读面走轮次行与各域 store），
--   台账只是它的镜像。裁定与边界见 docs/verification/gy-r71-jobs-ledger-20261030.md。
--   因此本片把「受理时写下的作业快照」落在**轮次行**上：读写都经轮次行，
--   状态机仍是契约闭集（`job_state` 列 CHECK 直接抄 `JobState`），
--   且 `GET /jobs/{id}` 读到的永远是**已发生的状态**（不是重新估算出来的值）。
--
-- 删除级联（契约 `deleteConversation` / `deleteTurn` 的 description）：
--   `conversation_turns.conversation_id → conversations(id) ON DELETE CASCADE`
--   `conversation_answers.turn_id       → conversation_turns(id) ON DELETE CASCADE`
--   删会话 ⇒ 其下轮次与回答一并删除；删轮次 ⇒ 其回答一并删除。
--   外键级联与内存实现的**显式级联**逐项对应（两条实现语义一致，回归用例锁住）。
--   「不删他人媒体」：本迁移只碰自己三张表，**不**触碰 media / 媒体对象（无外键指向它们）。
--
-- 硬约束：不存明文密钥/令牌；`conditions` / `transcription_ref` / `citations` / `dose_cards`
--         / 版本串与正文均为用户数据，均为本表职责范围内；不新增任何真实私有数据源。
--         三张表都带 `CHECK (revision >= 1)`；回答的 `status` / `check_state` 闭集与契约逐字一致。
--
-- 回滚：services/api/db/migrations/rollback/0013_conversations.down.sql
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- 会话：契约 `Conversation`。`revision` 为强 ETag 的来源（`"<revision>"`）。
-- `conditions` 存契约 `Conditions` 的 JSON 对象（六项键闭集、`crop_id`/`region_code` 必填
-- 由服务层校验；此处再加一道"必须是 JSON 对象"的库级闸，避免写入数组/标量）。
-- ---------------------------------------------------------------------------
CREATE TABLE conversations (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id    uuid        NOT NULL REFERENCES users (id),
    revision    integer     NOT NULL DEFAULT 1 CHECK (revision >= 1),
    conditions  jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT conversations_conditions_object CHECK (conditions IS NULL OR jsonb_typeof(conditions) = 'object')
);
-- 列表口径：`created_at DESC, id DESC`（keyset 分页，见 store-pg.ts 的游标谓词）。
CREATE INDEX conversations_owner_created_idx ON conversations (owner_id, created_at DESC, id DESC);

-- ---------------------------------------------------------------------------
-- 轮次：契约 `Turn` + 作业快照列。
-- `job_id` 是**本片自己生成**的 uuid，指向轮次行上的作业快照（见文件头说明），
-- 因此**不**加指向 `jobs(id)` 的外键（0001 的 jobs 表在代码里没有写入者）。
-- `transcription_ref` 存契约 `TargetRef` 三键对象（可空：文字输入无转写引用）。
-- ---------------------------------------------------------------------------
CREATE TABLE conversation_turns (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id     uuid        NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    owner_id            uuid        NOT NULL REFERENCES users (id),
    revision            integer     NOT NULL DEFAULT 1 CHECK (revision >= 1),
    input_text          varchar(8000) NOT NULL CHECK (length(input_text) >= 1),
    transcription_ref   jsonb,
    job_id              uuid        NOT NULL,
    job_state           varchar(20) NOT NULL DEFAULT 'queued'
                        CHECK (job_state IN ('queued', 'running', 'succeeded', 'uncertain', 'failed', 'timed_out', 'cancelled')),
    job_deadline_at     timestamptz NOT NULL,
    job_created_at      timestamptz NOT NULL DEFAULT now(),
    job_error_code      varchar(80),
    answer_id           uuid,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    -- 如实性不变式（与 jobs/registry.ts 的 assertContractJob 逐条对应）：
    --   * failed / timed_out ⇒ 必须有 error_code（不得无因失败）；
    --   * succeeded ⇒ 必须没有 error_code（不得同时"成功"又带错）。
    CONSTRAINT conversation_turns_job_error_pair CHECK (
        (job_state IN ('failed', 'timed_out') AND job_error_code IS NOT NULL)
        OR (job_state NOT IN ('failed', 'timed_out') AND job_state <> 'succeeded')
        OR (job_state = 'succeeded' AND job_error_code IS NULL)
    ),
    CONSTRAINT conversation_turns_transcription_object CHECK (
        transcription_ref IS NULL OR jsonb_typeof(transcription_ref) = 'object'
    )
);
-- 一个轮次一个作业 id（作业读面按 job_id 反查轮次）。
CREATE UNIQUE INDEX conversation_turns_job_id_key ON conversation_turns (job_id);
CREATE INDEX conversation_turns_conversation_created_idx
    ON conversation_turns (conversation_id, created_at DESC, id DESC);

-- ---------------------------------------------------------------------------
-- 回答：契约 `Answer` 十键全必填（`id` / `revision` / `status` / `checked_text` /
-- `check_state` / `citations` / `dose_cards` / `model_version` / `prompt_version` /
-- `rule_version`）。
-- `status` / `check_state` 的 CHECK 与契约闭集**逐字一致**（写不进去契约外的状态）。
-- 版本串长度 1..80 与契约 `minLength`/`maxLength` 一致；本片恒以
-- `unimplemented:no-real-` 前缀写入（「未接真实模型」的机器可判据标记）。
-- ---------------------------------------------------------------------------
CREATE TABLE conversation_answers (
    id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    turn_id         uuid         NOT NULL REFERENCES conversation_turns (id) ON DELETE CASCADE,
    owner_id        uuid         NOT NULL REFERENCES users (id),
    revision        integer      NOT NULL DEFAULT 1 CHECK (revision >= 1),
    status          varchar(20)  NOT NULL CHECK (status IN ('answered', 'insufficient', 'blocked')),
    checked_text    varchar(16000) NOT NULL CHECK (length(checked_text) >= 1),
    check_state     varchar(20)  NOT NULL CHECK (check_state IN ('passed', 'blocked')),
    citations       jsonb        NOT NULL DEFAULT '[]'::jsonb,
    dose_cards      jsonb        NOT NULL DEFAULT '[]'::jsonb,
    model_version   varchar(80)  NOT NULL CHECK (length(model_version) >= 1),
    prompt_version  varchar(80)  NOT NULL CHECK (length(prompt_version) >= 1),
    rule_version    varchar(80)  NOT NULL CHECK (length(rule_version) >= 1),
    created_at      timestamptz  NOT NULL DEFAULT now(),
    updated_at      timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT conversation_answers_citations_array CHECK (jsonb_typeof(citations) = 'array'),
    CONSTRAINT conversation_answers_dose_cards_array CHECK (jsonb_typeof(dose_cards) = 'array'),
    -- `citations` / `dose_cards` 的契约上界（maxItems 20 / 10）也落库，避免越界写入。
    CONSTRAINT conversation_answers_citations_max CHECK (jsonb_array_length(citations) <= 20),
    CONSTRAINT conversation_answers_dose_cards_max CHECK (jsonb_array_length(dose_cards) <= 10)
);

-- 轮次 → 回答的外键在两张表都建好之后补上（避免建表顺序造成的循环依赖）。
ALTER TABLE conversation_turns
    ADD CONSTRAINT conversation_turns_answer_fk
    FOREIGN KEY (answer_id) REFERENCES conversation_answers (id) ON DELETE SET NULL;

-- 级联删除路径的索引：删一个轮次行（`deleteTurn` / 删会话时的 `ON DELETE CASCADE`）时，
-- Postgres 必须按 `turn_id` 找出该轮次的全部回答行，而**外键不会**自动在引用列上建索引
-- （不建则每次级联都退化为顺序扫描）。`conversation_turns(conversation_id, ...)` 的既有索引
-- 已覆盖另一条级联边（会话 → 轮次）。
CREATE INDEX conversation_answers_turn_idx ON conversation_answers (turn_id);

COMMIT;
