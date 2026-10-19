-- GY-I19（#19）· 逐用户备份副本域：副本清单行 + 清除证据位（设计见
-- `docs/architecture/gy-i19-user-backup-copies-design.md` §4；本文是该节 DDL 的落地）。
--
-- ## 这张表到底记什么
-- 一行 = 一次注销受理里、**某个模块某段范围**在备份/快照侧留下的待清对象清单。
-- 受理时在**同一个受理事务**里写（见 `services/api/src/privacy/deletion-requests-pg.ts`），
-- 30 天后到期由 `BackupPurgePort` 的真实 PG 实现清除 payload 并写证据（见
-- `services/api/src/privacy/backup-copies-pg.ts`）。`purged` 行**保留**：删掉行就分不清
-- 「清过」与「从没写过」（设计 §5.3），保留窗口由回执 TTL 35 天兜住。
--
-- ## 为什么 `user_id` 不建外键（设计 §10 第 10 条）
-- 副本的归属事实必须**独立于** `users` 行是否还在：注销流程本身会改 `users.state`，
-- 若挂 `ON DELETE CASCADE`，任何对账号行的清理都会静默删掉「还没清完」的证据行。
-- 因此 `user_id` 只是定位用的 uuid，不建外键、也不参与级联。
--
-- ## 为什么 `request_id` 是 `ON DELETE RESTRICT`
-- 副本清单必挂在一次真实受理上；RESTRICT 让上游**不能**静默删掉 `deletion_requests` 行
-- 而把证据一起带走。真删请求前必须先处理副本行（清完或显式迁移），这是刻意的摩擦力。
--
-- ## 编号说明（如实登记，不造占位）
-- 本仓迁移号目前到 `0018`，`0019`–`0022` 属其它并行片、尚未合入，本片按任务书用 `0023`。
-- **断号是有意的**：`tests/integration/migrations-negative-pg.mjs` 的「版本号连续」真库臂
-- 因此会红，属已知缺口，已在交接文件登记；本片不补占位迁移（占位迁移会伪造别人的版本号）。
--
-- ## 回滚
-- `services/api/db/migrations/rollback/0023_user_backup_copies.down.sql`
-- （纯新增 ⇒ 整表 DROP；不碰任何既有表、不碰既有数据）。
BEGIN;

CREATE TABLE public.user_backup_copies (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL,
  request_id        uuid NOT NULL REFERENCES public.deletion_requests (id) ON DELETE RESTRICT,
  module            varchar(80) NOT NULL,
  scope             varchar(32) NOT NULL,
  delete_generation integer NOT NULL CHECK (delete_generation >= 1),
  lineage           text NOT NULL,
  covered_through   timestamptz NOT NULL,
  payload           jsonb NOT NULL,
  payload_digest    char(64) NOT NULL,
  state             text NOT NULL DEFAULT 'pending_purge',
  retention_until   timestamptz NOT NULL,
  purge_attempts    integer NOT NULL DEFAULT 0,
  purged_at         timestamptz,
  evidence_ref      text,
  last_error_code   varchar(80),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_backup_copies_state_check
    CHECK (state IN ('pending_purge', 'purged', 'failed')),
  CONSTRAINT user_backup_copies_module_shape
    CHECK (module ~ '^[a-z][a-z0-9_]{0,31}$'),
  CONSTRAINT user_backup_copies_scope_shape
    CHECK (scope ~ '^[a-z][a-z0-9_]{0,31}$'),
  CONSTRAINT user_backup_copies_lineage_present
    CHECK (length(btrim(lineage)) > 0),
  CONSTRAINT user_backup_copies_watermark_order
    CHECK (covered_through <= created_at),
  CONSTRAINT user_backup_copies_digest_shape
    CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT user_backup_copies_retention_after_created
    CHECK (retention_until >= created_at),
  CONSTRAINT user_backup_copies_purge_attempts_nonneg
    CHECK (purge_attempts >= 0),
  -- purged 必须有清除时间、非空白证据，且 payload 已硬删（不允许「报完成但内容还在」）
  CONSTRAINT user_backup_copies_purged_evidence
    CHECK (state <> 'purged' OR (
      purged_at IS NOT NULL
      AND evidence_ref IS NOT NULL
      AND btrim(evidence_ref) <> ''
      AND payload = 'null'::jsonb
    )),
  CONSTRAINT user_backup_copies_failed_error
    CHECK (state <> 'failed' OR last_error_code IS NOT NULL),
  CONSTRAINT user_backup_copies_pending_no_purged_at
    CHECK (state <> 'pending_purge' OR purged_at IS NULL)
);

CREATE UNIQUE INDEX user_backup_copies_key
  ON public.user_backup_copies (request_id, module, scope);
CREATE INDEX user_backup_copies_subject_idx
  ON public.user_backup_copies (user_id);
-- 到期扫描只关心未清完的行；purged 行不进索引
CREATE INDEX user_backup_copies_due_idx
  ON public.user_backup_copies (retention_until)
  WHERE state <> 'purged';

COMMIT;
