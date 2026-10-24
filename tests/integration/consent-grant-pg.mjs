/** Synthetic policy/recipients only. Real product HTTP and native PG17.11, no provider calls. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createPool } from '../../services/api/src/db/pool.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';

const url = new URL(process.env.CONSENT_GRANT_TEST_URL ?? '');
assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
assert.equal(url.search, '');
assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));
assert.equal(url.pathname, '/gengyun_consent_grant_test');
const owner = new pg.Client({ connectionString: url.href }); await owner.connect();
const groups = ['gengyun_auth_privacy','gengyun_consent_granter'];
const loginName = 'gengyun_consent_grant_test';
const password = randomBytes(24).toString('hex');
const key = randomBytes(32).toString('hex');
const subject = code => createHmac('sha256',key).update(`synthetic\n${code}`).digest('hex');
let app, defaultApp, pool, passed = 0;
const createdRoles = [];
const say = label => { passed++; console.log(`PASS ${passed}: ${label}`); };
const sqlFile = path => readFileSync(new URL(`../../services/api/db/${path}`,import.meta.url),'utf8');
const body = (purpose='external_inference', version='fixture-v1', ids=['fixture-llm']) => ({purpose,policy_version:version,recipient_ids:ids});
async function request(path, user, options={}, target=app) {
  const r = await fetch(`${target.listeningOrigin}/api/v1${path}`, {...options,headers:{...(user ? {authorization:`Bearer ${user.token}`} : {}),...options.headers}});
  const data = await r.json(); assert.equal(data.meta.execution_mode,'real');
  return {status:r.status, body:data, headers:r.headers};
}
const post = (input,keyValue=randomBytes(12).toString('hex')) => ({method:'POST',headers:{'content-type':'application/json','idempotency-key':keyValue},body:JSON.stringify(input)});
const grant = (user,input=body(),keyValue) => request('/me/consents',user,post(input,keyValue));
const withdraw = (user,revision,keyValue=randomBytes(12).toString('hex')) => request('/me/consents/external_inference',user,{method:'DELETE',headers:{'if-match':`"${revision}"`,'idempotency-key':keyValue}});
async function error(r,status,code) { r=await r; assert.equal(r.status,status,JSON.stringify(r.body)); assert.equal(r.body.error.code,code); return r; }
async function login(code) {
  const r = await request('/auth/wechat',null,post({code})); assert.equal(r.status,200,JSON.stringify(r.body));
  const u=(await owner.query("SELECT id FROM users WHERE wechat_subject_lookup=decode($1,'hex')",[subject(code)])).rows[0];
  const s=(await owner.query("SELECT id FROM sessions WHERE token_hash=decode($1,'hex')",[hashToken(r.body.data.access_token)])).rows[0];
  return {id:u.id,sessionId:s.id,token:r.body.data.access_token};
}
async function counts(user) {
  const r=await owner.query(`SELECT (SELECT count(*) FROM consent_records WHERE user_id=$1)::int records,
    (SELECT count(*) FROM privacy_epochs WHERE user_id=$1)::int epochs,
    (SELECT count(*) FROM idempotency_keys WHERE scope LIKE $2)::int receipts`,[user.id,`${user.id}%`]);
  return r.rows[0];
}
const epoch = async user => (await owner.query("SELECT current_epoch,state FROM privacy_epochs WHERE user_id=$1 AND purpose='external_inference'",[user.id])).rows[0];
async function waitLock(n=1) {
  for(let i=0;i<120;i++) {
    const r=await owner.query("SELECT count(*)::int n FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock'",[loginName]);
    if(r.rows[0].n>=n) return;
    await new Promise(resolve=>setTimeout(resolve,20));
  } assert.fail('actual API lock wait missing');
}
async function locked(user,action,mutate,n=1) {
  const c=new pg.Client({connectionString:url.href}); await c.connect(); let pending;
  try {
    await c.query('BEGIN'); await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[user.id]);
    pending=action(); await waitLock(n); await mutate(c); await c.query('COMMIT'); return await pending;
  } finally {await c.query('ROLLBACK').catch(()=>{}); await c.end(); await pending?.catch(()=>{});}
}
let reviewer;
const bindings = { 'fixture-llm': {config_version:'fixture-config-v1',policy_version:'fixture-recipient-v1',capability:'llm',retention_online_days:0,retention_backup_days:0,no_training_evidence_ref:'fixture://proof/no-training',deletion_evidence_ref:'fixture://proof/deletion'} };
async function policy(purpose='external_inference',version='fixture-v1',overrides={}) {
  await owner.query('UPDATE consent_policies SET enabled=false WHERE purpose=$1',[purpose]);
  return (await owner.query(`INSERT INTO consent_policies(purpose,policy_version,source_kind,source_ref,content_sha256,review_evidence_ref,recipient_bindings,valid_from,valid_until,reviewed_by,reviewed_at,enabled)
    VALUES($1,$2,'synthetic',$3,$4,$5,$6::jsonb,clock_timestamp()-interval '1 hour',to_timestamp($7/1000.0),$8,clock_timestamp(),true) RETURNING id`,
  [purpose,version,overrides.source??'fixture://policy/terms','a'.repeat(64),overrides.evidence??'fixture://policy/review',JSON.stringify(overrides.bindings??(purpose==='external_inference'?bindings:{})),overrides.until??Date.now()+3600000,reviewer])).rows[0].id;
}
try {
  const version=(await owner.query('SHOW server_version')).rows[0].server_version; assert.match(version,/^17\.11(?:\D|$)/); console.log(`Native PostgreSQL: ${version}`);
  assert.equal((await owner.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'")).rows[0].n,0);
  assert.equal((await owner.query('SELECT count(*)::int n FROM pg_roles WHERE rolname=ANY($1)',[[...groups,loginName]])).rows[0].n,0);
  for(const name of ['0001_initial_schema.sql','0003_privacy_consent.sql','0008_auth_session.sql','0009_consent_policy.sql']) await owner.query(sqlFile(`migrations/${name}`));
  await owner.query(sqlFile('migrations/rollback/0009_consent_policy.down.sql'));
  assert.equal((await owner.query("SELECT to_regclass('consent_policies') x")).rows[0].x,null);
  await owner.query(sqlFile('migrations/0009_consent_policy.sql'));
  say('fresh native PG17.11, actual 0009 up/down/up without changing 0003/0008');
  await owner.query(sqlFile('roles/auth_privacy.sql')); createdRoles.push(groups[0]);
  await owner.query(sqlFile('roles/consent_granter.sql')); createdRoles.push(groups[1]);
  await owner.query(`CREATE ROLE ${loginName} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`); createdRoles.push(loginName);
  await owner.query(`GRANT ${groups.join(',')} TO ${loginName}`);
  const runtime=new URL(url); runtime.username=loginName; runtime.password=password; pool=createPool(runtime.href);
  const flags=(await pool.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]; assert.ok(Object.values(flags).every(v=>v===false));
  for(const sql of ["UPDATE consent_policies SET enabled=true","UPDATE consent_policies SET source_kind='verified'","INSERT INTO consent_policies(purpose) VALUES('recording')","DELETE FROM consent_policies","UPDATE recipients SET deletion_verified=true","UPDATE users SET state='deleted'",'SELECT object_ref_cipher FROM media','CREATE TEMP TABLE forbidden(x int)','CREATE ROLE forbidden']) await assert.rejects(pool.query(sql),e=>e.code==='42501');
  say('separate grant LOGIN cannot publish authority, alter proofs/recipients/accounts, read media secrets or DDL');
  // This harness drives 21+ logins from loopback inside one minute; the default per-IP auth
  // limit (20/60s) would shadow the consent assertions with 429 RATE_LIMITED. Whitelist the
  // harness peer only: the limiter path stays enabled and is covered by tests/unit/rate-limit.test.mjs.
  const config={...loadConfig({APP_EXECUTION_MODE:'stub',LOG_LEVEL:'silent',RATE_LIMIT_ALLOWLIST_IPS:'127.0.0.1'}),executionMode:'real',sessionSigningKey:key};
  const provider={exchange:async code=>({subjectLookupHex:subject(code)})};
  app=buildApp({config,pool,wechat:provider,consentGrantTestOptions:{allowSyntheticGrantPolicy:true}});
  defaultApp=buildApp({config,pool,wechat:provider});
  await app.listen({host:'127.0.0.1',port:0}); await defaultApp.listen({host:'127.0.0.1',port:0});
  const first=await login('first');
  await error(grant(first),403,'CONSENT_REQUIRED'); assert.deepEqual(await counts(first),{records:0,epochs:0,receipts:0});
  await error(grant(null),401,'SESSION_REQUIRED');
  await error(request('/me/consents',first,post({...body(),userId:first.id,authEpoch:1,granted:true})),400,'INVALID_REQUEST');
  await error(request('/me/consents',first,{...post(body()),headers:{'content-type':'application/json'}}),400,'IDEMPOTENCY_KEY_REQUIRED');
  say('absent authority, unauthenticated or client-forged identity never creates grant/epoch/receipt');
  reviewer=(await owner.query("INSERT INTO admin_accounts(login_name,credential_hash) VALUES('fixture-reviewer','synthetic-unused') RETURNING id")).rows[0].id;
  await owner.query(`INSERT INTO recipients(id,display_name,capability,policy_version,no_training_verified,deletion_verified,enabled,config_version)
    VALUES('fixture-llm','Synthetic test only','llm','fixture-recipient-v1',true,true,true,'fixture-config-v1')`);
  let currentPolicy=await policy();
  await error(request('/me/consents',first,post(body()),defaultApp),403,'CONSENT_REQUIRED'); assert.equal((await counts(first)).records,0);
  say('normal production app rejects synthetic registry; only explicit test injection permits fixture policy');
  await error(grant(first,body('external_inference','stale-policy')),409,'REVISION_CONFLICT');
  await error(grant(first,body('external_inference','fixture-v1',['invented-party'])),403,'CONSENT_REQUIRED');
  await error(grant(first,body('external_inference','fixture-v1',[])),403,'CONSENT_REQUIRED');
  say('client cannot select old policy, invented recipient or empty external inference recipient set');
  for(const assignment of ['enabled=false','no_training_verified=false','deletion_verified=false',"config_version='changed'", "policy_version='changed'",'retention_online_days=1','retention_backup_days=1']) {
    await owner.query('UPDATE recipients SET '+assignment+" WHERE id='fixture-llm'"); await error(grant(first),403,'CONSENT_REQUIRED');
    await owner.query("UPDATE recipients SET enabled=true,no_training_verified=true,deletion_verified=true,config_version='fixture-config-v1',policy_version='fixture-recipient-v1',retention_online_days=0,retention_backup_days=0 WHERE id='fixture-llm'");
  }
  assert.equal((await counts(first)).records,0);
  say('recipient disabled, training/deletion unverified or config/policy changed is denied without mutation');
  const grantKey='same-grant-key'; const initial=await grant(first,body(),grantKey);
  assert.equal(initial.status,201,JSON.stringify(initial.body)); assert.equal(initial.body.data.epoch,1); assert.equal(initial.body.data.revision,2);
  assert.equal(initial.headers.get('etag'),'"2"'); assert.equal(initial.headers.get('cache-control'),'no-store');
  assert.deepEqual(Object.keys(initial.body.data).sort(),['epoch','granted_at','id','policy_version','purpose','recipient_ids','revision','state','withdrawn_at'].sort());
  assert.deepEqual((await grant(first,body(),grantKey)).body.data,initial.body.data);
  await error(grant(first,body('recording','fixture-v1',[]),grantKey),409,'IDEMPOTENCY_CONFLICT');
  assert.deepEqual(await counts(first),{records:1,epochs:1,receipts:1});
  const optionalHeaderUser=await login('optional-if-match-digest');
  const optionalRequest=post(body(),'optional-header-key');
  assert.equal((await request('/me/consents',optionalHeaderUser,{...optionalRequest,headers:{...optionalRequest.headers,'if-match':'"999"'}})).status,201);
  await error(request('/me/consents',optionalHeaderUser,{...optionalRequest,headers:{...optionalRequest.headers,'if-match':'"1000"'}}),409,'IDEMPOTENCY_CONFLICT');
  say('frozen POST needs no If-Match; actual 201 DTO/ETag/no-store and same-key receipt convergence');
  const same=await login('same-concurrent'); const copies=await Promise.all([grant(same,body(),'concurrent-same-key'),grant(same,body(),'concurrent-same-key')]);
  assert.deepEqual(copies.map(x=>x.status),[201,201]); assert.deepEqual(copies[0].body.data,copies[1].body.data); assert.equal((await counts(same)).records,1);
  say('same-key actual concurrent HTTP grants produce one record and epoch');
  const different=await login('different-concurrent');
  const distinct=await locked(different,()=>Promise.all([grant(different,body(),'different-key-one'),grant(different,body(),'different-key-two')]),async()=>{},2);
  assert.deepEqual(distinct.map(x=>x.status),[201,201]); assert.deepEqual(distinct.map(x=>x.body.data.epoch).sort(),[1,2]);
  assert.deepEqual(distinct.map(x=>x.body.data.revision).sort(),[2,3]); assert.equal((await epoch(different)).current_epoch,'2');
  assert.equal((await owner.query("SELECT count(*)::int n FROM consent_records WHERE user_id=$1 AND state='granted'",[different.id])).rows[0].n,1);
  say('different keys wait on real account lock and serially create distinct new epochs, not false revision conflicts');
  const second=await grant(first,body(),'replacement-key'); assert.equal(second.status,201); assert.equal(second.body.data.epoch,2);
  await error(grant(first,body(),grantKey),403,'CONSENT_REQUIRED');
  assert.equal((await owner.query('SELECT state FROM consent_records WHERE id=$1',[initial.body.data.id])).rows[0].state,'withdrawn');
  const withdrawKey='same-operation-key'; const withdrawn=await withdraw(first,second.body.data.revision,withdrawKey); assert.equal(withdrawn.status,200);
  const again=await grant(first,body(),withdrawKey); assert.equal(again.status,201); assert.equal(again.body.data.epoch,4); assert.ok(again.body.data.revision>withdrawn.body.data.revision);
  const oldReceipt=await withdraw(first,second.body.data.revision,withdrawKey); assert.deepEqual(oldReceipt.body.data,withdrawn.body.data);
  assert.equal((await epoch(first)).current_epoch,'4'); await error(grant(first,body(),'replacement-key'),403,'CONSENT_REQUIRED');
  say('replacement/withdraw/regrant advance epochs; old grant cannot resurrect and old DELETE receipt cannot withdraw new grant; POST/DELETE key scopes differ');
  const other=await login('other-user'); const independent=await grant(other,body(),grantKey); assert.equal(independent.status,201); assert.notEqual(independent.body.data.id,initial.body.data.id);
  const listing=await request('/me/consents',other); assert.equal(listing.body.data.items.length,1); assert.equal(listing.body.data.items[0].id,independent.body.data.id);
  say('same raw key is isolated between authenticated users and list remains owner-scoped');
  const conflict=await login('grant-withdraw-competition'); const baseline=await grant(conflict);
  const competing=await locked(conflict,()=>Promise.all([grant(conflict,body(),'competing-grant'),withdraw(conflict,baseline.body.data.revision,'competing-withdraw')]),async()=>{},2);
  assert.equal(competing[0].status,201); assert.ok([200,409].includes(competing[1].status));
  assert.equal((await epoch(conflict)).state,'granted'); assert.equal((await epoch(conflict)).current_epoch,competing[1].status===200?'3':'2');
  say('grant and strong-revision DELETE competition obey actual lock order; stale withdrawal cannot revoke replacement');
  const fail=await login('sql-failure');
  const replaceFail=await login('replacement-failure'); const replaceOriginal=await grant(replaceFail);
  await owner.query(`CREATE FUNCTION test_grant_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id IN ('${fail.id}'::uuid,'${replaceFail.id}'::uuid) THEN RAISE EXCEPTION 'fixture failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER test_grant_failure BEFORE INSERT OR UPDATE ON privacy_epochs FOR EACH ROW EXECUTE FUNCTION test_grant_failure()`);
  await error(grant(fail,body(),'rollback-key'),503,'PROVIDER_UNAVAILABLE'); assert.deepEqual(await counts(fail),{records:0,epochs:0,receipts:0});
  await error(grant(replaceFail,body(),'replacement-rollback-key'),503,'PROVIDER_UNAVAILABLE');
  assert.deepEqual(await counts(replaceFail),{records:1,epochs:1,receipts:1});
  const originalAfterFailure=(await owner.query('SELECT state,revision FROM consent_records WHERE id=$1',[replaceOriginal.body.data.id])).rows[0];
  assert.deepEqual(originalAfterFailure,{state:'granted',revision:2}); assert.equal((await epoch(replaceFail)).current_epoch,'1');
  await owner.query('DROP TRIGGER test_grant_failure ON privacy_epochs; DROP FUNCTION test_grant_failure()'); assert.equal((await grant(fail,body(),'rollback-key')).status,201);
  say('native failure after record insertion rolls back record/epoch/receipt; same-key retry succeeds');
  say('failed replacement restores old granted state/revision, with no new record or receipt');
  const receiptFailure=await login('receipt-failure');
  await owner.query(`CREATE FUNCTION test_grant_receipt_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.scope LIKE '${receiptFailure.id}%' THEN RAISE EXCEPTION 'fixture receipt failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER test_grant_receipt_failure BEFORE INSERT ON idempotency_keys FOR EACH ROW EXECUTE FUNCTION test_grant_receipt_failure()`);
  await error(grant(receiptFailure),503,'PROVIDER_UNAVAILABLE'); assert.deepEqual(await counts(receiptFailure),{records:0,epochs:0,receipts:0});
  await owner.query('DROP TRIGGER test_grant_receipt_failure ON idempotency_keys; DROP FUNCTION test_grant_receipt_failure()');
  say('native receipt insertion failure rolls back already-written record and epoch');
  for(const kind of ['media','exports','author_links']) {
    for (const alreadyGranted of [false,true]) {
    const u=await login('dependency-'+kind+'-'+alreadyGranted);
    if (alreadyGranted) assert.equal((await grant(u)).status,201);
    if(kind==='media') await owner.query("INSERT INTO media(owner_id,purpose,mime,bytes,sha256,object_ref_cipher) VALUES($1,'weed_recognition','image/png',1,$2,'fixture')",[u.id,'0'.repeat(64)]);
    if(kind==='exports') await owner.query("INSERT INTO exports(user_id,object_type,object_id,object_revision,purpose,consent_epoch,recipient_id,recipient_config_version,auth_epoch) VALUES($1,'fixture',$2,1,'external_inference',1,'fixture-llm','fixture-config-v1',1)",[u.id,randomUUID()]);
    if(kind==='author_links') {const author=(await owner.query("INSERT INTO public_authors(display_name) VALUES('fixture') RETURNING id")).rows[0].id; await owner.query('INSERT INTO author_links(user_id,public_author_id) VALUES($1,$2)',[u.id,author]);}
    await error(grant(u),409,'OBJECT_UNAVAILABLE');
    assert.deepEqual(await counts(u),{records:alreadyGranted?1:0,epochs:alreadyGranted?1:0,receipts:alreadyGranted?1:0});
    if (alreadyGranted) assert.equal((await epoch(u)).current_epoch,'1');
    }
  }
  say('all three unimplemented business dependency classes refuse initial/replacement authorization without fake cancellation');
  await assert.rejects(owner.query("UPDATE consent_policies SET source_ref='fixture://changed' WHERE id=$1",[currentPolicy]),e=>e.code==='23514');
  await assert.rejects(owner.query('DELETE FROM consent_policies WHERE id=$1',[currentPolicy]),e=>e.code==='23514');
  await owner.query('UPDATE consent_policies SET enabled=false WHERE id=$1',[currentPolicy]);
  await error(grant(first,body(),withdrawKey),403,'CONSENT_REQUIRED');
  currentPolicy=await policy('external_inference','fixture-v2'); await error(grant(first,body(),withdrawKey),409,'REVISION_CONFLICT');
  say('reviewed policy content is immutable; retired or replaced current policy rejects even historical grant replay');
  await policy('recording','fixture-recording', {source:'not-a-reviewed-source'});
  await error(grant(await login('bad-source'),body('recording','fixture-recording',[])),403,'CONSENT_REQUIRED');
  await policy('recording','fixture-expired',{until:Date.now()-1000});
  await error(grant(await login('expired-policy'),body('recording','fixture-expired',[])),403,'CONSENT_REQUIRED');
  await policy('recording','fixture-local'); const local=await grant(await login('local-only'),body('recording','fixture-local',[])); assert.equal(local.status,201);
  say('unusable source/expired policy denies; separately reviewed local purpose can grant without third-party recipients');
  await policy('media_processing','fixture-no-proof',{bindings:{'fixture-llm':{...bindings['fixture-llm'],deletion_evidence_ref:''}}});
  await error(grant(await login('missing-proof'),body('media_processing','fixture-no-proof')),403,'CONSENT_REQUIRED');
  const adminToken=randomBytes(24).toString('hex');
  await owner.query("INSERT INTO admin_sessions(admin_id,token_hash,auth_epoch,expires_at) VALUES($1,decode($2,'hex'),1,now()+interval '1 hour')",[reviewer,hashToken(adminToken)]);
  await error(grant({token:adminToken}),401,'SESSION_EXPIRED');
  say('missing deletion evidence and administrator bearer never authorize user POST');
  const off=await login('inactive');
  for(const state of ['suspended','deletion_pending','deleted']) {await owner.query('UPDATE users SET state=$2 WHERE id=$1',[off.id,state]);await error(grant(off,body('external_inference','fixture-v2')),403,'ACCOUNT_INACTIVE');}
  await owner.query("UPDATE users SET state='active',auth_epoch=auth_epoch+1 WHERE id=$1",[off.id]); await error(grant(off,body('external_inference','fixture-v2')),403,'ACCOUNT_INACTIVE'); assert.equal((await counts(off)).records,0);
  say('inactive/deletion states and obsolete authenticated epoch never issue consent');
  const disabled=await login('disable-during-wait');
  await error(locked(disabled,()=>grant(disabled,body('external_inference','fixture-v2')),c=>c.query("UPDATE users SET state='suspended',auth_epoch=auth_epoch+1 WHERE id=$1",[disabled.id])),403,'ACCOUNT_INACTIVE'); assert.equal((await counts(disabled)).records,0);
  say('observed lock wait: disable after HTTP preHandler rejects grant before persistent mutation');
  const revoked=await login('revoke-during-wait');
  await error(locked(revoked,()=>grant(revoked,body('external_inference','fixture-v2')),c=>c.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=$1',[revoked.sessionId])),401,'SESSION_EXPIRED');
  const expired=await login('expire-during-wait');
  await error(locked(expired,()=>grant(expired,body('external_inference','fixture-v2')),c=>c.query("UPDATE sessions SET created_at=now()-interval '1 day',expires_at=clock_timestamp()-interval '1 millisecond' WHERE id=$1",[expired.sessionId])),401,'SESSION_EXPIRED');
  say('observed lock wait: revoked/expired session after HTTP preHandler cannot grant');
  const retired=await login('retire-during-wait');
  await error(locked(retired,()=>grant(retired,body('external_inference','fixture-v2')),c=>c.query('UPDATE consent_policies SET enabled=false WHERE id=$1',[currentPolicy])),403,'CONSENT_REQUIRED');
  say('observed lock wait: policy retired before transaction acquisition blocks grant');
  await policy('external_inference','fixture-v3');
  const changed=await login('recipient-during-wait'); const lock=new pg.Client({connectionString:url.href});await lock.connect();let pending;
  try {await lock.query('BEGIN'); await lock.query("SELECT id FROM recipients WHERE id='fixture-llm' FOR UPDATE");pending=grant(changed,body('external_inference','fixture-v3'));await waitLock();await lock.query("UPDATE recipients SET config_version='changed' WHERE id='fixture-llm'");await lock.query('COMMIT');await error(pending,403,'CONSENT_REQUIRED');}
  finally {await lock.query('ROLLBACK').catch(()=>{});await lock.end();await pending?.catch(()=>{});}
  assert.equal((await counts(changed)).records,0); await owner.query("UPDATE recipients SET config_version='fixture-config-v1' WHERE id='fixture-llm'");
  say('observed recipient lock wait rechecks changed configuration instead of stale authorization');
  const timeout=await login('expires-inside-transaction');
  await policy('recording','fixture-short-lived',{until:Date.now()+1200});
  await owner.query(`CREATE FUNCTION test_grant_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id='${timeout.id}'::uuid THEN PERFORM pg_sleep(1.5); END IF; RETURN NEW; END $$;
    CREATE TRIGGER test_grant_delay BEFORE INSERT ON consent_records FOR EACH ROW EXECUTE FUNCTION test_grant_delay()`);
  await error(grant(timeout,body('recording','fixture-short-lived',[]),'expired-mid-transaction'),403,'CONSENT_REQUIRED'); assert.deepEqual(await counts(timeout),{records:0,epochs:0,receipts:0});
  await policy('recording','fixture-long-lived');
  await owner.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1",[timeout.sessionId]);
  await error(grant(timeout,body('recording','fixture-long-lived',[]),'session-expired-mid-transaction'),401,'SESSION_EXPIRED'); assert.deepEqual(await counts(timeout),{records:0,epochs:0,receipts:0});
  await owner.query('DROP TRIGGER test_grant_delay ON consent_records; DROP FUNCTION test_grant_delay()');
  say('policy/session expiring during actual native SQL delay rolls back record/epoch/receipt');
  await policy('recording','fixture-replay-expiry',{until:Date.now()+1500});
  const replayExpiry=await login('replay-policy-expiry'); const replayBody=body('recording','fixture-replay-expiry',[]); const replayKey='replay-expiry-key';
  assert.equal((await grant(replayExpiry,replayBody,replayKey)).status,201);
  const replayLock=new pg.Client({connectionString:url.href});await replayLock.connect();let replayPending;
  try {
    await replayLock.query('BEGIN');await replayLock.query("SELECT user_id FROM privacy_epochs WHERE user_id=$1 AND purpose='recording' FOR UPDATE",[replayExpiry.id]);
    replayPending=grant(replayExpiry,replayBody,replayKey);await waitLock();await replayLock.query('SELECT pg_sleep(1.6)');await replayLock.query('COMMIT');
    await error(replayPending,403,'CONSENT_REQUIRED');
  } finally {await replayLock.query('ROLLBACK').catch(()=>{});await replayLock.end();await replayPending?.catch(()=>{});}
  assert.deepEqual(await counts(replayExpiry),{records:1,epochs:1,receipts:1});
  say('policy expiring during actual epoch-lock wait rejects idempotent grant replay without mutation');
  const ledger=(await owner.query('SELECT outcome FROM idempotency_keys')).rows; assert.ok(!JSON.stringify(ledger).includes(key)); assert.ok(!JSON.stringify(ledger).includes(first.token));
  assert.ok(ledger.filter(x=>x.outcome?.privacyGrantId).every(x=>Object.keys(x.outcome).length===1));
  say('grant idempotency outcomes contain only record references, not bearer/policy text/server key');
  console.log(`ALL ${passed} grant integration groups passed; synthetic policies are NOT production evidence.`);
} finally {
  await app?.close(); await defaultApp?.close(); await pool?.end();
  if(createdRoles.length){await owner.query(`DROP OWNED BY ${createdRoles.join(',')}; DROP ROLE ${createdRoles.reverse().join(',')}`);}
  await owner.end();
}
