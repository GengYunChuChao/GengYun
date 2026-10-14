-- ============================================================================
-- GY-I27 / #29 外发账本持久化（第二片：持久账本 + 在途守卫接入）— 迁移 0011
-- ----------------------------------------------------------------------------
-- 依赖：0001（users）、0003（exports / recipients / privacy_epochs / consent_records）。
-- 本迁移只**扩展外发账本**，不触碰授权语义、不修改 0003 的既有列与约束。
--
-- 为什么需要这些列/表（对应 packages/privacy 与 services/api/src/privacy 的口径）：
--   * `revision`：账本行的单调版本 —— 提交前置条件（CAS）与「旧回调不复活」的比对依据；
--   * `error_code`：终态失败原因（固定安全分类，不含私有原文）；
--   * `job_id`：把外发预留与任务绑定，供**取消**（`cancelVersion`/墓碑）按作业定位；
--   * `cancelled_at` / `cancellation_reason`：**只增不减**的取消墓碑。
--     同一 (user_id, object_type, object_id, object_revision) 一旦取消，
--     **不得再次预留**（晚到回调与重新授权都不可复活该版本）；
--   * `export_writebacks`：**受控结果介质**。账本的「实际结果写入」与授权校验在
--     **同一事务**内完成（校验不通过 ⇒ 零写入）。该表**只增不改**：
--     结果只落**结构分类**（kind/code），**不落私有正文/媒体/坐标/凭据**
--     （结果本体仍在各业务域 store；账本不制造第二份私有数据副本）。
--
-- 约束来源：docs/architecture/state-contract.md「授权、撤回及注销」「注销」；
--          0003 的 exports 表注释「回写前重查，取消/撤回/注销后的版本不可被回调复活」。
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. 外发账本补充列（既有行按默认值回填，不改既有语义）
-- ---------------------------------------------------------------------------
ALTER TABLE exports
  ADD COLUMN revision            integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  ADD COLUMN error_code          varchar(80),
  ADD COLUMN job_id              uuid,
  ADD COLUMN cancelled_at        timestamptz,
  ADD COLUMN cancellation_reason varchar(40);

-- 取消墓碑的成对约束：要么都没有，要么都有（不允许只置一半）。
ALTER TABLE exports
  ADD CONSTRAINT exports_cancelled_pair CHECK (
    (cancelled_at IS NULL AND cancellation_reason IS NULL)
    OR (cancelled_at IS NOT NULL AND cancellation_reason IS NOT NULL)
  );

-- 按作业定位（取消面）与「同一对象版本已取消」的墓碑查询。
CREATE INDEX exports_job_idx ON exports (job_id) WHERE job_id IS NOT NULL;
CREATE INDEX exports_cancelled_object_idx
  ON exports (user_id, object_type, object_id, object_revision)
  WHERE cancelled_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. 受控结果介质：写回与校验同事务；只增不改；不存私有正文
-- ---------------------------------------------------------------------------
CREATE TABLE export_writebacks (
  export_id    uuid PRIMARY KEY REFERENCES exports (id),
  user_id      uuid NOT NULL REFERENCES users (id),
  revision     integer NOT NULL CHECK (revision >= 1),
  result       jsonb NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT now(),
  -- 结果必须是 jsonb 对象（结构分类），不允许裸标量/数组造成歧义。
  CONSTRAINT export_writebacks_result_object CHECK (jsonb_typeof(result) = 'object')
);
CREATE INDEX export_writebacks_user_idx ON export_writebacks (user_id, committed_at);

COMMIT;
