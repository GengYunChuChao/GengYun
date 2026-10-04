-- 生成文件：回滚本次种子（只删本目录 seed 写入的行；共享表结构不动）
BEGIN;
-- 先标记导入运行回退（若有）
UPDATE catalog_import_runs SET status='reverted' WHERE dataset IN ('zhejiang-verified-seed','simulation-demo') AND status='succeeded';
-- 解除 sources.current_version_id 对 source_versions 的引用（种子未设置，防御性）
UPDATE sources SET current_version_id = NULL WHERE id IN ('e0b4b47a-84d5-5f57-91dd-0b074759a646'::uuid, 'f5bac794-e6d9-5da2-a4fa-c983cefaba43'::uuid, 'e3b756bf-b047-51b8-9607-e6f898f96743'::uuid);
-- 按依赖顺序删除：适用 → 登记 → 制剂（仅本次种子写入的 id）
DELETE FROM applicability WHERE source_version_id IN ('35851631-49a1-5d06-8826-0f1cb53850c1'::uuid, '45d8af8b-fbc0-5d76-ae0c-efbe7df43c84'::uuid, '4296f7ea-f3d6-5a81-9fb2-21fd1884deee'::uuid, '42fe384c-5197-5bfe-91bc-f3b8efaa60ee'::uuid, 'c05a3bb3-2be8-5b44-bbff-2f3843ca8304'::uuid);
DELETE FROM registrations WHERE source_version_id IN ('35851631-49a1-5d06-8826-0f1cb53850c1'::uuid, '45d8af8b-fbc0-5d76-ae0c-efbe7df43c84'::uuid, '4296f7ea-f3d6-5a81-9fb2-21fd1884deee'::uuid, '42fe384c-5197-5bfe-91bc-f3b8efaa60ee'::uuid, 'c05a3bb3-2be8-5b44-bbff-2f3843ca8304'::uuid);
DELETE FROM formulations WHERE id IN ('6b1a709a-6886-55c0-b2a3-6e05559e3d67'::uuid, '75886d58-8456-54a5-b68c-0f1f1df6cadc'::uuid, '17da36cf-0e31-544d-a8b8-02b42905aaa7'::uuid, 'a2327a26-db09-5000-9798-0aa748d80221'::uuid, '697f53c4-a3b8-56a5-a2f0-d526bc25e92c'::uuid, '4d13821a-72ba-54eb-bee6-1c836e3eb31c'::uuid, 'eff18cd8-203d-5e97-a049-25b76fb0b3fa'::uuid, 'c756e15b-78e5-593c-9bbd-e5b006eabd31'::uuid, '4cf5d42b-8a49-5725-9bfd-5cacef607f66'::uuid, '4c589427-0b0a-5d53-8dec-dec340dee260'::uuid, 'ff69f350-8989-594c-a91e-e48a88da70ad'::uuid, '05683674-c5dd-547f-9055-dccb87cb9593'::uuid, '6c490635-49b4-5a4b-aa23-2c3752402eae'::uuid, 'f902c60f-e2fc-59e2-86fb-d29ec02d9376'::uuid, '90463695-72a2-5518-83a9-3a4a06954d17'::uuid, '3945656e-65c6-5408-8dcd-c741d16bd3d1'::uuid, '4ea2fa88-cae2-5253-8805-1089ecaac054'::uuid, '9199798b-8c26-5994-9d58-fa1276db6032'::uuid, '667557e7-e782-52f9-a035-dae80a813464'::uuid, 'abe1c678-cb62-55d2-8623-cce9c33c0529'::uuid, 'c2f51f9b-f9de-52e2-bbb5-0d61f5a9a2e6'::uuid, 'f05e6fc4-af61-5814-bbff-338d6d16862a'::uuid);
-- 删除来源更新事件与来源版本/来源
DELETE FROM catalog_source_update_events WHERE source_id IN ('e0b4b47a-84d5-5f57-91dd-0b074759a646'::uuid, 'f5bac794-e6d9-5da2-a4fa-c983cefaba43'::uuid, 'e3b756bf-b047-51b8-9607-e6f898f96743'::uuid) OR source_version_id IN ('35851631-49a1-5d06-8826-0f1cb53850c1'::uuid, '45d8af8b-fbc0-5d76-ae0c-efbe7df43c84'::uuid, '4296f7ea-f3d6-5a81-9fb2-21fd1884deee'::uuid, '42fe384c-5197-5bfe-91bc-f3b8efaa60ee'::uuid, 'c05a3bb3-2be8-5b44-bbff-2f3843ca8304'::uuid);
DELETE FROM source_versions WHERE id IN ('35851631-49a1-5d06-8826-0f1cb53850c1'::uuid, '45d8af8b-fbc0-5d76-ae0c-efbe7df43c84'::uuid, '4296f7ea-f3d6-5a81-9fb2-21fd1884deee'::uuid, '42fe384c-5197-5bfe-91bc-f3b8efaa60ee'::uuid, 'c05a3bb3-2be8-5b44-bbff-2f3843ca8304'::uuid);
DELETE FROM sources WHERE id IN ('e0b4b47a-84d5-5f57-91dd-0b074759a646'::uuid, 'f5bac794-e6d9-5da2-a4fa-c983cefaba43'::uuid, 'e3b756bf-b047-51b8-9607-e6f898f96743'::uuid);

COMMIT;
