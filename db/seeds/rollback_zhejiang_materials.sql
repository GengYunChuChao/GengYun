-- 生成文件：精确回滚浙江首批资料批次（只删本批次写入的行；表结构不动）
-- 其他种子（seed_reference/seed_herbicides_verified/seed_simulation）、脱敏样例与
-- knowledge_staging 批次不在本文件范围内，不删、不改。
BEGIN;
UPDATE catalog_import_runs SET status='reverted' WHERE dataset = 'zhejiang-first-batch-v1' AND status <> 'reverted';
-- 先解除 sources.current_version_id 对 source_versions 的引用（FK 前置）
UPDATE sources SET current_version_id = NULL WHERE id IN ('c3fe90f1-d4ac-5394-8f57-8dbdad3e6bd2'::uuid, '0b3a0b74-013f-5334-978a-da95abf7a92c'::uuid);
-- 知识条目 → 来源事件 → 来源版本 → 来源（按依赖顺序，仅本批次 id）
DELETE FROM knowledge_versions WHERE source_version_id IN ('e85622e0-d53b-573b-a326-ce32cd387dc8'::uuid, '0a9deb7e-45e0-5752-b07e-5a5da62f3599'::uuid);
DELETE FROM catalog_source_update_events WHERE source_version_id IN ('e85622e0-d53b-573b-a326-ce32cd387dc8'::uuid, '0a9deb7e-45e0-5752-b07e-5a5da62f3599'::uuid) OR source_id IN ('c3fe90f1-d4ac-5394-8f57-8dbdad3e6bd2'::uuid, '0b3a0b74-013f-5334-978a-da95abf7a92c'::uuid);
DELETE FROM source_versions WHERE id IN ('e85622e0-d53b-573b-a326-ce32cd387dc8'::uuid, '0a9deb7e-45e0-5752-b07e-5a5da62f3599'::uuid);
DELETE FROM sources WHERE id IN ('c3fe90f1-d4ac-5394-8f57-8dbdad3e6bd2'::uuid, '0b3a0b74-013f-5334-978a-da95abf7a92c'::uuid);

COMMIT;
