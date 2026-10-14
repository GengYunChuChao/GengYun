/** Destructive only in a fresh, explicit, loopback gengyun_catalog_test database.
 * Fixtures/credentials are synthetic; committed public seeds are separately tested
 * as unreviewed and excluded. No user XLSX, private records or AI.
 */
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { createPool } from '../../services/api/src/db/pool.ts';
import { applyMigrations, discoverMigrations, checksum } from '../../services/api/src/db/migrate.ts';
import { readRegistrationEvidence } from '../../services/api/src/db/catalog.ts';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';

const url = new URL(process.env.DATABASE_TEST_URL ?? '');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'loopback only');
assert.equal(url.pathname, '/gengyun_catalog_test', 'dedicated test DB only');
const owner = new pg.Client({ connectionString: url.href });
await owner.connect();
let app, previewPool, evidencePool, rolesCreated = false;
const groups = ['gengyun_preview_reader', 'gengyun_evidence_reader'];
const logins = ['gengyun_preview_test', 'gengyun_evidence_test', 'gengyun_public_test'];
const passwords = logins.map(() => randomBytes(24).toString('hex'));
const say = (message) => console.log(`PASS ${message}`);
const sqlFile = (p) => readFileSync(new URL(`../../services/api/db/${p}`, import.meta.url), 'utf8');
async function denies(client, text, codes = ['42501']) {
  await assert.rejects(client.query(text), (e) => codes.includes(e.code));
}
async function request() {
  const response = await fetch(`${app.listeningOrigin}/api/v1/public/home`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(body.meta.execution_mode, 'real');
  assert.equal(body.meta.contract_version, '1.0.0');
  assert.equal(body.data.human_review_state, 'under_construction');
  assert.ok(body.data.previews.length <= 10);
  return body.data.previews;
}
try {
  const version = (await owner.query('SHOW server_version')).rows[0].server_version;
  assert.match(version, /^17\.11(?:\D|$)/);
  console.log(`Real PostgreSQL patch: ${version}`);
  assert.equal((await owner.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname = 'public'")).rows[0].n, 0, 'fresh DB required');
  assert.equal((await owner.query('SELECT count(*)::int n FROM pg_roles WHERE rolname = ANY($1)', [[...groups, ...logins]])).rows[0].n, 0, 'do not alter existing roles');
  const migrations = discoverMigrations().filter((m) => ['0001', '0002', '0004', '0005'].includes(m.version));
  assert.equal(migrations.length, 4);
  assert.deepEqual((await applyMigrations(owner, migrations)).applied, ['0001', '0002', '0004', '0005']);
  assert.equal((await applyMigrations(owner, migrations)).applied.length, 0);
  await assert.rejects(applyMigrations(owner, [{ ...migrations[3], checksum: '0'.repeat(64) }]), /drift/);
  // Failure in runner-managed migration rolls back DDL and ledger together.
  const failSql = 'CREATE TABLE rollback_probe(id int); INSERT INTO rollback_probe VALUES (1); SELECT no_such_column;';
  await assert.rejects(applyMigrations(owner, [{ version: '9998', name: 'failure_probe', filename: '9998_failure_probe.sql', sql: failSql, checksum: checksum(failSql) }]), /执行失败/);
  assert.equal((await owner.query("SELECT to_regclass('public.rollback_probe') AS relation")).rows[0].relation, null);
  assert.equal((await owner.query("SELECT count(*)::int n FROM schema_migrations WHERE version = '9998'")).rows[0].n, 0);
  say('real migration apply/repeat/drift/failed-DDL rollback');

  await owner.query(sqlFile('roles/catalog_readers.sql'));
  rolesCreated = true;
  for (let i = 0; i < logins.length; i++) {
    await owner.query(`CREATE ROLE ${logins[i]} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${passwords[i]}'`);
  }
  await owner.query(`GRANT ${groups[0]} TO ${logins[0]}; GRANT ${groups[1]} TO ${logins[1]}`);
  function connection(index) { const u = new URL(url); u.username = logins[index]; u.password = passwords[index]; return u.href; }
  previewPool = createPool(connection(0));
  evidencePool = createPool(connection(1));
  const flags = (await owner.query('SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=ANY($1)', [[...groups,...logins]])).rows;
  assert.equal(flags.length, 5);
  for (const role of flags) for (const flag of ['rolsuper','rolcreatedb','rolcreaterole','rolreplication','rolbypassrls']) assert.equal(role[flag], false);
  assert.equal((await previewPool.query('SHOW statement_timeout')).rows[0].statement_timeout, '5s');
  const publicPool = createPool(connection(2));
  try {
    for (const table of ['users', 'sessions', 'media', 'sources', 'source_versions', 'knowledge_versions', 'formulations']) {
      await denies(previewPool, `SELECT * FROM public.${table}`);
      await denies(publicPool, `SELECT * FROM public.${table}`);
    }
    await denies(publicPool, 'SELECT * FROM catalog_read.home_species');
    for (const client of [previewPool, evidencePool, publicPool]) {
      await denies(client, 'SELECT * FROM knowledge_staging.workbook_batches');
      await denies(client, 'SELECT * FROM knowledge_staging.workbook_rows');
    }
    await denies(previewPool, 'SELECT * FROM catalog_read.registration_evidence');
    await denies(evidencePool, 'SELECT * FROM catalog_read.home_species');
    for (const statement of ['CREATE TABLE public.no_write(id int)', 'CREATE TEMP TABLE no_temp(id int)', 'CREATE SCHEMA no_schema', 'CREATE ROLE no_role', 'SET ROLE gengyun_local_owner']) {
      // Owner name differs in CI; SET ROLE denial separately uses actual owner.
      if (!statement.startsWith('SET ROLE')) await denies(previewPool, statement);
    }
    const ownerName = (await owner.query('SELECT current_user AS name')).rows[0].name.replaceAll('"', '""');
    await denies(previewPool, `SET ROLE "${ownerName}"`);
    await denies(previewPool, "UPDATE catalog_read.home_species SET title = 'no'", ['42501', '55000']);
    await denies(previewPool, 'DELETE FROM public.sources');
    say('actual login roles deny private/base reads, PUBLIC access, cross-view access, writes, DDL, TEMP and escalation');
  } finally { await publicPool.end(); }

  const config = { ...loadConfig({ APP_EXECUTION_MODE: 'stub' }), logLevel: 'silent', executionMode: 'real', requiresRealCredentials: true };
  app = buildApp({ config, pool: previewPool });
  await app.listen({ host: '127.0.0.1', port: 0 });
  assert.deepEqual(await request(), []);
  // Existing public reference seeds are imported unchanged, twice, into real PG.
  // They are NOT promoted to reviewed or given fabricated dates/current pointers.
  for (let repeat = 0; repeat < 2; repeat++) {
    for (const file of ['seed_reference.sql', 'seed_herbicides_verified.sql', 'seed_simulation.sql']) {
      await owner.query(readFileSync(new URL(`../../db/seeds/${file}`, import.meta.url), 'utf8'));
    }
  }
  assert.equal((await owner.query("SELECT count(*)::int n FROM registrations WHERE status='unknown'")).rows[0].n, 22);
  assert.equal((await owner.query('SELECT count(*)::int n FROM applicability WHERE card_ready')).rows[0].n, 0);
  assert.equal((await evidencePool.query('SELECT count(*)::int n FROM catalog_read.registration_evidence')).rows[0].n, 0);
  assert.deepEqual(await request(), []);
  await owner.query(readFileSync(new URL('../../db/seeds/rollback_seed.sql', import.meta.url), 'utf8'));
  assert.equal((await owner.query('SELECT count(*)::int n FROM formulations')).rows[0].n, 0);
  say('committed 20 incomplete public records + 2 synthetic records: real PG import/repeat, eligible evidence=0, DoseCard=0, scoped seed rollback');
  // Explicit synthetic test activation; not a production switch or source review.
  await owner.query("UPDATE knowledge_dataset_modes SET accepts_database=true WHERE mode='real'");
  await owner.query("UPDATE knowledge_dataset_config SET value='real',mode='real' WHERE key='active_mode'");
  await owner.query("UPDATE knowledge_dataset_config SET value='true',mode='real' WHERE key='database_connected'");
  // Knowledge and herbicides are now registered and user-only, even for unavailable detail.
  // This preview LOGIN intentionally lacks user-auth/knowledge privileges;
  // guest rejection happens before any attempt to query private user data.
  for (const path of ['/api/v1/knowledge', '/api/v1/knowledge/00000000-0000-4000-8000-000000000001',
    '/api/v1/herbicides', '/api/v1/herbicides/00000000-0000-4000-8000-000000000001']) {
    const denied = await fetch(`${app.listeningOrigin}${path}`);
    assert.equal(denied.status, 401);
    assert.equal((await denied.json()).error.code, 'SESSION_REQUIRED');
  }
  // staging / registrations remain unimplemented paths ⇒ contract-shaped 404.
  for (const path of ['/api/v1/staging', '/api/v1/registrations']) {
    assert.equal((await fetch(`${app.listeningOrigin}${path}`)).status, 404);
  }
  const reviewer = randomUUID();
  await owner.query("INSERT INTO admin_accounts(id,login_name,credential_hash) VALUES ($1,'synthetic-reviewer','synthetic-not-a-credential')", [reviewer]);
  async function source(label, overrides = {}) {
    const sid = randomUUID(), vid = randomUUID();
    await owner.query("INSERT INTO sources(id,title,canonical_url,publisher,source_kind,evidence_kind) VALUES ($1,$2,'https://example.invalid/synthetic','synthetic', $3,'research')", [sid, label, overrides.kind ?? 'database']);
    await owner.query(`INSERT INTO source_versions(id,source_id,version,content_hash,locator,retrieved_at,valid_from,valid_to,validity,review_status,reviewed_by,reviewed_at)
      VALUES ($1,$2,'synthetic-v1',$3,'synthetic-row',now(),now() + ($4::text)::interval,now() + ($5::text)::interval,$6,$7,$8,$9)`,
    [vid, sid, 'a'.repeat(64), overrides.start ?? '-1 day', overrides.end ?? '1 day', overrides.validity ?? 'valid', overrides.review ?? 'verified', overrides.review === 'unverified' || overrides.noReviewer ? null : reviewer, overrides.review === 'unverified' || overrides.noReviewer ? null : new Date()]);
    if (!overrides.noCurrent) await owner.query('UPDATE sources SET current_version_id=$1 WHERE id=$2', [vid, sid]);
    return { sid, vid };
  }
  async function knowledge(label, s, overrides = {}) {
    const id = randomUUID();
    await owner.query(`INSERT INTO knowledge_versions(id,knowledge_id,revision,title,body,type,source_version_id,visibility) VALUES ($1,$2,1,$3,$4,$5,$6,$7)`,
      [randomUUID(), id, label, overrides.body ?? 'synthetic '.repeat(100), overrides.type ?? 'species', s.vid, overrides.visibility ?? 'published']);
    return id;
  }
  const good = await source('synthetic-good');
  const allowed = new Set();
  for (let i = 0; i < 12; i++) allowed.add(await knowledge(`synthetic-good-${i}`, good));
  for (const [label, overrides] of Object.entries({ unknown: { validity: 'unknown' }, expired: { validity: 'expired' }, conflicting: { validity: 'conflicting' }, withdrawn: { validity: 'withdrawn' }, unverified: { review: 'unverified' }, rejected: { review: 'rejected' }, simulation: { kind: 'simulation' }, calendarExpired: { start: '-2 days', end: '-1 day' }, future: { start: '1 day', end: '2 days' }, missingCurrent: { noCurrent: true }, missingReviewPair: { noReviewer: true } })) {
    await knowledge(`blocked-${label}`, await source(label, overrides));
  }
  for (const overrides of [{ type: 'herbicide' }, { type: 'scheme' }, { visibility: 'private' }, { visibility: 'hidden' }, { body: ' ' }]) await knowledge('blocked-content', good, overrides);
  const hiddenId = await knowledge('blocked-old-published', good);
  await owner.query("INSERT INTO knowledge_versions(id,knowledge_id,revision,title,body,type,source_version_id,visibility) VALUES ($1,$2,2,'new-hidden','synthetic','species',$3,'hidden')", [randomUUID(), hiddenId, good.vid]);
  const previews = await request();
  assert.equal(previews.length, 10);
  for (const p of previews) {
    assert.ok(allowed.has(p.id)); assert.equal(p.summary.length, 500);
    assert.deepEqual(Object.keys(p).sort(), ['id','title','summary','content_type','source_kind'].sort());
  }
  // Direct role query sees exactly eligible 12 rows, so LIMIT cannot hide leaked negatives.
  assert.equal((await previewPool.query('SELECT count(*)::int n FROM catalog_read.home_species')).rows[0].n, 12);
  await owner.query('BEGIN');
  await owner.query("UPDATE source_versions SET validity='withdrawn' WHERE id=$1", [good.vid]);
  await owner.query('ROLLBACK');
  assert.equal((await request()).length, 10);
  await owner.query("UPDATE source_versions SET validity='withdrawn' WHERE id=$1", [good.vid]);
  assert.deepEqual(await request(), []);
  await owner.query("UPDATE source_versions SET validity='valid' WHERE id=$1", [good.vid]);
  // Current pointer update hides every old reference; rollback restores visibility.
  await owner.query('UPDATE sources SET current_version_id=NULL WHERE id=$1', [good.sid]);
  assert.deepEqual(await request(), []);
  await owner.query('UPDATE sources SET current_version_id=$1 WHERE id=$2', [good.vid, good.sid]);
  assert.equal((await request()).length, 10);
  for (const statement of [
    "UPDATE knowledge_dataset_config SET value='stub',mode='stub' WHERE key='active_mode'",
    "UPDATE knowledge_dataset_config SET value='false' WHERE key='database_connected'",
    "UPDATE knowledge_dataset_modes SET accepts_database=false WHERE mode='real'",
  ]) {
    await owner.query('BEGIN'); await owner.query(statement);
    // Commit exposes changed policy to the application's independent connection.
    await owner.query('COMMIT');
    assert.deepEqual(await request(), []);
    await owner.query("UPDATE knowledge_dataset_config SET value='real',mode='real' WHERE key='active_mode'");
    await owner.query("UPDATE knowledge_dataset_config SET value='true',mode='real' WHERE key='database_connected'");
    await owner.query("UPDATE knowledge_dataset_modes SET accepts_database=true WHERE mode='real'");
  }
  say('real HTTP→API→restricted PG: empty/12→10, field shape, source/status/date/review/mode/content negatives, newer-hidden and immediate invalidation/rollback');

  const fid = randomUUID(), rid = randomUUID();
  await owner.query("INSERT INTO formulations(id,registration_number,producer,dosage_form,ingredients,identity_hash) VALUES ($1,'SYNTHETIC-001','synthetic-producer','synthetic-form',$2,$3)", [fid, JSON.stringify([{ name: 'synthetic-ingredient', content_text: 'synthetic-content', unit_text: 'synthetic-unit' }]), 'b'.repeat(64)]);
  await owner.query("INSERT INTO registrations(id,formulation_id,source_version_id,registered_name,registration_valid_from,registration_valid_to,status) VALUES ($1,$2,$3,'synthetic-registration',current_date-1,current_date+1,'valid')", [rid, fid, good.vid]);
  const mapped = await readRegistrationEvidence(evidencePool, 'real', 'SYNTHETIC-001');
  assert.equal(mapped.length, 1);
  assert.equal(mapped[0].formulation_id, fid); assert.equal(mapped[0].source_id, good.sid); assert.equal(mapped[0].source_version_id, good.vid);
  assert.equal(mapped[0].identity_hash, 'b'.repeat(64)); assert.equal(mapped[0].content_hash, 'a'.repeat(64));
  assert.deepEqual(mapped[0].ingredients, [{ name: 'synthetic-ingredient', content_text: 'synthetic-content', unit_text: 'synthetic-unit' }]);
  assert.equal(mapped[0].dose_text, undefined); assert.equal(mapped[0].card_ready, undefined);
  for (const status of ['unknown', 'expired', 'conflicting']) {
    await owner.query('UPDATE registrations SET status=$1 WHERE id=$2', [status, rid]);
    assert.deepEqual(await readRegistrationEvidence(evidencePool, 'real', 'SYNTHETIC-001'), []);
  }
  await owner.query("UPDATE registrations SET status='valid',registration_valid_to=NULL WHERE id=$1", [rid]);
  assert.deepEqual(await readRegistrationEvidence(evidencePool, 'real', 'SYNTHETIC-001'), []);
  await owner.query('UPDATE registrations SET registration_valid_to=current_date+1 WHERE id=$1', [rid]);
  const runId = randomUUID(), conflictId = randomUUID();
  await owner.query("INSERT INTO catalog_import_runs(id,mode,dataset,status) VALUES ($1,'real','synthetic-test','failed')", [runId]);
  await owner.query("INSERT INTO catalog_import_conflicts(id,run_id,entity,business_key,resolution) VALUES ($1,$2,'formulations','SYNTHETIC-001','deferred')", [conflictId, runId]);
  assert.deepEqual(await readRegistrationEvidence(evidencePool, 'real', 'SYNTHETIC-001'), []);
  await owner.query('DELETE FROM catalog_import_runs WHERE id=$1', [runId]);
  const duplicate = randomUUID();
  await owner.query("INSERT INTO formulations(id,registration_number,producer,dosage_form,ingredients,identity_hash) VALUES ($1,'SYNTHETIC-001','different-synthetic','synthetic',$2,$3)", [duplicate, JSON.stringify([{ name: 'other-synthetic' }]), 'c'.repeat(64)]);
  assert.deepEqual(await readRegistrationEvidence(evidencePool, 'real', 'SYNTHETIC-001'), []);
  await owner.query('DELETE FROM formulations WHERE id=$1', [duplicate]);
  await owner.query('BEGIN');
  await owner.query("UPDATE registrations SET registered_name='changed' WHERE id=$1", [rid]);
  await assert.rejects(owner.query("INSERT INTO registrations(id,formulation_id,source_version_id,registered_name,status) VALUES ($1,$2,$3,'bad','valid')", [randomUUID(), randomUUID(), good.vid]), { code: '23503' });
  await owner.query('ROLLBACK');
  assert.deepEqual(await readRegistrationEvidence(evidencePool, 'real', 'SYNTHETIC-001'), mapped);
  assert.deepEqual(await readRegistrationEvidence(evidencePool, 'real', "' OR true --"), []);
  await assert.rejects(readRegistrationEvidence(evidencePool, 'preset_demo', 'SYNTHETIC-001'), { code: 'PROVIDER_UNAVAILABLE' });
  say('registration identity/source/hash/ingredients mapping; status/missing-date/identity-conflict/injection/demo rejection; failed import transaction preserves prior evidence');

  await owner.query(sqlFile('migrations/rollback/0005_catalog_read_views.down.sql'));
  assert.equal((await owner.query("SELECT to_regclass('catalog_read.home_species') AS relation")).rows[0].relation, null);
  assert.equal((await owner.query('SELECT count(*)::int n FROM formulations')).rows[0].n, 1);
  const failed = await fetch(`${app.listeningOrigin}/api/v1/public/home`);
  assert.equal(failed.status, 503);
  assert.equal((await failed.json()).error.code, 'PROVIDER_UNAVAILABLE');
  say('0005 scoped rollback preserves base records and fails closed in API');
} finally {
  if (app) await app.close();
  await previewPool?.end(); await evidencePool?.end();
  if (rolesCreated) {
    const present = new Set((await owner.query('SELECT rolname FROM pg_roles WHERE rolname=ANY($1)', [[...logins,...groups]])).rows.map((r) => r.rolname));
    for (const role of [...logins, ...groups].filter((r) => present.has(r))) await owner.query(`DROP OWNED BY ${role}`);
    for (const role of [...logins, ...groups].filter((r) => present.has(r))) await owner.query(`DROP ROLE ${role}`);
  }
  await owner.end();
}
