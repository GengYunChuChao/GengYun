// Destructive checks only in a dedicated local/CI database, never a normal DATABASE_URL.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { appendFileSync } from 'node:fs';
const require = createRequire(new URL('../../services/api/package.json', import.meta.url));
const { Client } = require('pg');
const target = new URL(process.env.STAGING_PG_TEST_URL || 'https://invalid.invalid');
assert.ok(['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/gengyun_staging_test', 'Dedicated local staging test database required');
const client = new Client({ connectionString: target.href });
await client.connect();
const read = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
async function rejected(sql, code) {
  await assert.rejects(client.query(sql), e => e.code === code);
}
try {
  const version = (await client.query('SHOW server_version')).rows[0].server_version;
  assert.equal(version.split('.')[0], '17', 'Real PostgreSQL 17 required');
  console.log('Real PostgreSQL patch:', version);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, 'Real PostgreSQL server_version: ' + version + '\n');
  assert.equal((await client.query("SELECT to_regclass('public.source_versions') AS relation")).rows[0].relation, null, 'Fresh empty database required');
  for (const file of ['0001_initial_schema.sql', '0002_knowledge_catalog.sql', '0004_workbook_staging.sql']) {
    await client.query(read('services/api/db/migrations/' + file));
  }
  const generated = spawnSync(process.env.PYTHON || 'python3', ['tests/knowledge/test_workbook_staging.py', '--sql'], { encoding: 'utf8' });
  assert.equal(generated.status, 0, 'Synthetic importer fixture failed');
  await client.query(generated.stdout); await client.query(generated.stdout);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM knowledge_staging.workbook_batches')).rows[0].n, 1);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM knowledge_staging.workbook_rows')).rows[0].n, 3);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM v_active_source_version')).rows[0].n, 0);
  // A failing new batch transaction must neither survive nor alter existing intake.
  const beforeFailure = (await client.query('SELECT * FROM knowledge_staging.workbook_rows ORDER BY sheet_name,excel_row')).rows;
  await client.query('BEGIN');
  await client.query("INSERT INTO knowledge_staging.workbook_batches(id,file_sha256,filename,mapping_version,quality) VALUES ('00000000-0000-0000-0000-000000000003',repeat('c',64),'failed.xlsx','v1','{}')");
  await rejected("INSERT INTO knowledge_staging.workbook_rows(batch_id,sheet_name,excel_row,row_hash,raw,mapped,state,issues) VALUES ('00000000-0000-0000-0000-000000000003','synthetic',1,repeat('c',64),NULL,'{}','context','[]')", '23502');
  await client.query('ROLLBACK');
  assert.equal((await client.query("SELECT count(*)::int AS n FROM knowledge_staging.workbook_batches WHERE file_sha256=repeat('c',64)")).rows[0].n, 0);
  assert.deepEqual((await client.query('SELECT * FROM knowledge_staging.workbook_rows ORDER BY sheet_name,excel_row')).rows, beforeFailure);
  await rejected("UPDATE knowledge_staging.workbook_rows SET mapped='{}' WHERE state='unreviewed'", '23514');
  await rejected("UPDATE knowledge_staging.workbook_rows SET excel_row=0", '23514');
  await rejected("UPDATE knowledge_staging.workbook_batches SET source_version_id='00000000-0000-0000-0000-000000000001'", '23503');
  await rejected('UPDATE knowledge_staging.workbook_rows SET raw=NULL', '23502');
  await client.query("CREATE ROLE staging_app_negative NOLOGIN; SET ROLE staging_app_negative");
  await rejected('SELECT * FROM knowledge_staging.workbook_rows', '42501');
  await client.query('RESET ROLE; CREATE ROLE staging_reader_negative NOLOGIN; GRANT USAGE ON SCHEMA knowledge_staging TO staging_reader_negative; GRANT SELECT ON ALL TABLES IN SCHEMA knowledge_staging TO staging_reader_negative; SET ROLE staging_reader_negative');
  await client.query('SELECT * FROM knowledge_staging.workbook_rows');
  await rejected('DELETE FROM knowledge_staging.workbook_batches', '42501');
  await client.query('RESET ROLE');
  await client.query("INSERT INTO knowledge_staging.workbook_batches(id,file_sha256,filename,mapping_version,quality) VALUES ('00000000-0000-0000-0000-000000000002',repeat('b',64),'other.xlsx','v1','{}')");
  await client.query("DELETE FROM knowledge_staging.workbook_batches WHERE file_sha256=repeat('a',64)");
  assert.equal((await client.query('SELECT count(*)::int AS n FROM knowledge_staging.workbook_rows')).rows[0].n, 0);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM knowledge_staging.workbook_batches')).rows[0].n, 1);
  await client.query(read('services/api/db/migrations/rollback/0004_workbook_staging.down.sql'));
  assert.equal((await client.query("SELECT to_regclass('public.source_versions') AS relation")).rows[0].relation, 'source_versions');
  console.log('PASS real PG17: migrations, repeat import, failed transaction rollback preserves existing rows, guarded fields, FK/NULL/row constraints, access negatives, scoped batch rollback, structural down');
} finally { await client.end(); }
