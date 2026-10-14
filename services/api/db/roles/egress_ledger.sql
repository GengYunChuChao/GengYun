-- Operator-only, fresh dedicated database bootstrap; not a schema migration.
-- Provision a private LOGIN separately. Never run the API as migration owner.
-- This is a trusted API service group, NOT per-user RLS or a client SQL login.
--
-- GY-I27 第二片：**外发账本运行时**的最小权限组。与 gengyun_auth_privacy 并列授予同一个
-- 私有 LOGIN（运行时角色继承二者）：授权读取沿用 auth_privacy，账本登记/迁移/回写用本组。
-- 刻意**不给**：任意行的 DELETE、冻结快照列（consent_epoch/required_consents/recipient_*）
-- 的 UPDATE、recipients/consent_policies 的写入、users.state/auth_epoch 的写入、DDL。
--
-- 回滚（运维）：REVOKE ALL ON exports, export_writebacks, recipients, users, privacy_epochs,
--   consent_records FROM gengyun_egress_ledger; DROP OWNED BY gengyun_egress_ledger;
--   DROP ROLE gengyun_egress_ledger;
BEGIN;
CREATE ROLE gengyun_egress_ledger NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO gengyun_egress_ledger;

-- 接收方资格核验：只读、只给核验所需列（无 display_name 等展示字段，无写入）。
GRANT SELECT (id,capability,policy_version,retention_online_days,retention_backup_days,
              no_training_verified,deletion_verified,enabled,config_version)
  ON recipients TO gengyun_egress_ledger;

-- 外发账本：可读、可登记预留、可迁移状态与写墓碑；**不可删除行**、不可改冻结快照列。
GRANT SELECT (id,user_id,object_type,object_id,object_revision,purpose,consent_id,consent_epoch,
              required_consents,recipient_id,recipient_config_version,source_version,state,
              requested_at,sent_at,provider_request_ref_cipher,deletion_state,auth_epoch,
              created_at,updated_at,revision,error_code,job_id,cancelled_at,cancellation_reason)
  ON exports TO gengyun_egress_ledger;
GRANT INSERT (user_id,object_type,object_id,object_revision,purpose,consent_id,consent_epoch,
              required_consents,recipient_id,recipient_config_version,source_version,state,
              provider_request_ref_cipher,deletion_state,auth_epoch,revision)
  ON exports TO gengyun_egress_ledger;
GRANT UPDATE (state,sent_at,updated_at,revision,error_code,job_id,cancelled_at,cancellation_reason,
              provider_request_ref_cipher,deletion_state)
  ON exports TO gengyun_egress_ledger;

-- 受控结果介质：只增不改（写回与校验同事务；见 0011 的说明）。
GRANT SELECT,INSERT ON export_writebacks TO gengyun_egress_ledger;

-- 提交边界的**只读**核验（账号身份与授权快照）；列级最小化，且**无写权限**。
GRANT SELECT (id,state,auth_epoch) ON users TO gengyun_egress_ledger;
GRANT SELECT (user_id,purpose,current_epoch,state,revision) ON privacy_epochs TO gengyun_egress_ledger;
GRANT SELECT (id,user_id,purpose,state,epoch,recipient_ids,policy_version) ON consent_records TO gengyun_egress_ledger;
COMMIT;
