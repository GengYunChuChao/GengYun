-- 生成文件：回滚本次种子（只删本目录 seed 写入的行；共享表结构不动）
BEGIN;
-- 先标记导入运行回退（若有）
UPDATE catalog_import_runs SET status='reverted' WHERE dataset IN ('zhejiang-verified-seed','simulation-demo') AND status='succeeded';
-- 按来源版本删除适用/登记/制剂（依赖顺序）
DELETE FROM applicability WHERE source_version_id IN ('35851631-49a1-5d06-8826-0f1cb53850c1'::uuid, '45d8af8b-fbc0-5d76-ae0c-efbe7df43c84'::uuid, '4296f7ea-f3d6-5a81-9fb2-21fd1884deee'::uuid, '42fe384c-5197-5bfe-91bc-f3b8efaa60ee'::uuid, 'c05a3bb3-2be8-5b44-bbff-2f3843ca8304'::uuid);
DELETE FROM registrations WHERE source_version_id IN ('35851631-49a1-5d06-8826-0f1cb53850c1'::uuid, '45d8af8b-fbc0-5d76-ae0c-efbe7df43c84'::uuid, '4296f7ea-f3d6-5a81-9fb2-21fd1884deee'::uuid, '42fe384c-5197-5bfe-91bc-f3b8efaa60ee'::uuid, 'c05a3bb3-2be8-5b44-bbff-2f3843ca8304'::uuid);
DELETE FROM formulations f WHERE NOT EXISTS (SELECT 1 FROM registrations r WHERE r.formulation_id = f.id);
DELETE FROM source_versions WHERE id IN ('35851631-49a1-5d06-8826-0f1cb53850c1'::uuid, '45d8af8b-fbc0-5d76-ae0c-efbe7df43c84'::uuid, '4296f7ea-f3d6-5a81-9fb2-21fd1884deee'::uuid, '42fe384c-5197-5bfe-91bc-f3b8efaa60ee'::uuid, 'c05a3bb3-2be8-5b44-bbff-2f3843ca8304'::uuid);
DELETE FROM sources WHERE id IN ('src_sim_demo_gyi03');
DELETE FROM catalog_source_update_events WHERE source_id IN ('src_moa_pd_2026','src_mca_xzqh_2023','src_sim_demo_gyi03');

COMMIT;
