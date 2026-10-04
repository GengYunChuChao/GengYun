import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sql = readFileSync(
  new URL('../../db/migrations/0003_privacy_consent.sql', import.meta.url),
  'utf8',
);

// 注：本文件为静态结构回归（依赖无关，不要求本机安装 Postgres）。
// 实际 SQL 负例已用 @electric-sql/pglite（Postgres WASM）逐条执行验证，
// 输出见 PR 正文「迁移 0003 实际 SQL 负例」节。

test('third_party_deletions 的 confirmed 证据约束覆盖 online 与 backup 两侧', () => {
  assert.ok(sql.includes('third_party_confirmed_evidence'), '缺少 confirmed 证据约束');
  assert.ok(
    /online_status <> 'confirmed' OR \(confirmed_at IS NOT NULL AND evidence_ref IS NOT NULL\)/.test(sql),
    'online 侧 confirmed 需证据',
  );
  assert.ok(
    /backup_status <> 'confirmed' OR \(confirmed_at IS NOT NULL AND evidence_ref IS NOT NULL\)/.test(sql),
    'backup 侧 confirmed 需证据',
  );
});

test('third_party_deletions 的 requested_at 约束覆盖 online 与 backup 两侧', () => {
  assert.ok(sql.includes('third_party_requested_time'), '缺少 requested_at 约束');
  assert.ok(
    /online_status NOT IN \('requested', 'confirmed', 'failed'\) OR requested_at IS NOT NULL/.test(sql),
    'online 侧需 requested_at',
  );
  assert.ok(
    /backup_status NOT IN \('requested', 'confirmed', 'failed'\) OR requested_at IS NOT NULL/.test(sql),
    'backup 侧需 requested_at',
  );
});

test('third_party_deletions 的 NULL 唯一语义用部分唯一索引实现', () => {
  assert.ok(
    sql.includes('third_party_deletions_null_key'),
    '缺少 NULL export_ref 的部分唯一索引',
  );
  assert.ok(
    /third_party_deletions_key[\s\S]*?WHERE export_ref IS NOT NULL/.test(sql),
    '缺少非空 export_ref 部分唯一索引',
  );
  assert.ok(
    /third_party_deletions_null_key[\s\S]*?WHERE export_ref IS NULL/.test(sql),
    '缺少空 export_ref 部分唯一索引',
  );
});

test('exports 表保存全部必需用途 epoch 快照（required_consents jsonb）', () => {
  assert.ok(
    /required_consents\s+jsonb NOT NULL DEFAULT '\{\}'::jsonb/.test(sql),
    'exports 缺少 required_consents 快照列',
  );
});

test('用户训练开关默认关闭且启用需独立同意 + 谱系验收', () => {
  assert.ok(
    /training_enabled\s+boolean NOT NULL DEFAULT false/.test(sql),
    '训练开关默认值非 false',
  );
  assert.ok(
    sql.includes('user_training_enable_requires_consent_lineage'),
    '缺少训练开关启用门槛 CHECK',
  );
});
