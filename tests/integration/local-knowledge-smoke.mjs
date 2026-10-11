// Owner is used ONLY to create/withdraw/remove explicitly synthetic fixtures in
// a fresh local-dev window. The actual API remains the restricted LOGIN.
import assert from 'node:assert/strict';
import {readFileSync,realpathSync} from 'node:fs';
import {resolve,relative,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
const root=realpathSync(resolve(import.meta.dirname,'../..'));
const dir=realpathSync(resolve(process.argv[2]??''));
const rel=relative(resolve(root,'.local'),dir);
assert.ok(rel&&!rel.startsWith('..'+sep)&&rel!=='..'&&!resolve(rel).startsWith('//'),'only a caller-created ignored local window');
assert.ok(dir.startsWith(resolve(root,'.local')+sep));
const settings=JSON.parse(readFileSync(resolve(dir,'settings.json'),'utf8'));
const credentials=JSON.parse(readFileSync(resolve(dir,'private/config.json'),'utf8'));
const base='http://127.0.0.1:'+settings.apiPort+'/api/v1';
const owner=new pg.Client({host:'127.0.0.1',port:settings.pgPort,user:'gengyun_local_owner',password:credentials.ownerPassword,database:'gengyun_local_dev'});
await owner.connect();
let token,fixture=false,oldMode,oldConfig;
const source=randomUUID(),version=randomUUID(),knowledge=randomUUID(),reviewer=randomUUID();
async function http(path,options={}){const r=await fetch(base+path,{...options,headers:{...(token?{authorization:'Bearer '+token}:{}),...options.headers}});return {status:r.status,body:await r.json()};}
try{
 assert.deepEqual((await owner.query('SELECT current_user actor,current_database() database')).rows[0],{actor:'gengyun_local_owner',database:'gengyun_local_dev'});
 assert.equal((await owner.query('SELECT count(*)::int n FROM sources')).rows[0].n,0,'never modify a window containing existing sources');
 assert.equal((await owner.query('SELECT count(*)::int n FROM knowledge_versions')).rows[0].n,0,'never modify existing knowledge');
 assert.equal((await http('/knowledge')).status,401);
 const login=await http('/auth/wechat',{method:'POST',headers:{'content-type':'application/json','idempotency-key':'knowledge-smoke-'+randomUUID()},body:JSON.stringify({code:'synthetic-knowledge-smoke-'+randomUUID()})});
 assert.equal(login.status,200);token=login.body.data.access_token;
 assert.deepEqual((await http('/knowledge')).body.data,{items:[],next_cursor:null});
 oldMode=(await owner.query("SELECT * FROM knowledge_dataset_modes WHERE mode='real'")).rows[0];
 oldConfig=(await owner.query("SELECT * FROM knowledge_dataset_config WHERE key IN ('active_mode','database_connected')")).rows;
 await owner.query('BEGIN');
 try{
  await owner.query("INSERT INTO knowledge_dataset_modes(mode,description,accepts_database,accepts_verified_seed) VALUES('real','Synthetic isolated smoke only',false,true) ON CONFLICT(mode) DO UPDATE SET accepts_verified_seed=true");
  await owner.query("INSERT INTO knowledge_dataset_config(key,value,mode) VALUES('active_mode','real','real'),('database_connected','true','real') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,mode=EXCLUDED.mode");
  await owner.query("INSERT INTO admin_accounts(id,login_name,credential_hash) VALUES($1,$2,'synthetic-not-a-password')",[reviewer,'synthetic-reviewer-'+reviewer]);
  await owner.query("INSERT INTO sources(id,title,canonical_url,publisher,source_kind,evidence_kind) VALUES($1,'Synthetic source, not production approval','https://example.invalid/synthetic','Synthetic fixture publisher','verified_seed','research')",[source]);
  await owner.query("INSERT INTO source_versions(id,source_id,version,content_hash,locator,retrieved_at,valid_from,validity,review_status,reviewed_by,reviewed_at) VALUES($1,$2,'synthetic-local-v1',repeat('a',64),'synthetic-only',now(),now()-interval '1 hour','valid','verified',$3,now())",[version,source,reviewer]);
  await owner.query('UPDATE sources SET current_version_id=$1 WHERE id=$2',[version,source]);
  await owner.query("INSERT INTO knowledge_versions(id,knowledge_id,revision,title,body,type,source_version_id,visibility) VALUES($1,$2,1,'Synthetic educational fixture','Synthetic only; not a verified real label or dose recommendation.','species',$3,'published')",[randomUUID(),knowledge,version]);
  await owner.query('COMMIT');fixture=true;
 }catch(e){await owner.query('ROLLBACK');throw e;}
 const list=await http('/knowledge');assert.equal(list.status,200);assert.equal(list.body.meta.execution_mode,'stub');assert.equal(list.body.data.items.length,1);
 const item=list.body.data.items[0];assert.equal(item.id,knowledge);assert.equal(item.source.id,source);assert.equal(item.source.version,'synthetic-local-v1');assert.deepEqual(item.dose_cards,[]);assert.equal(item.conditions,null);
 const detail=await http('/knowledge/'+knowledge);assert.equal(detail.status,200);assert.deepEqual(detail.body.data,item);
 await owner.query("UPDATE source_versions SET validity='withdrawn' WHERE id=$1",[version]);
 assert.equal((await http('/knowledge/'+knowledge)).status,404);assert.deepEqual((await http('/knowledge')).body.data,{items:[],next_cursor:null});
 assert.equal((await http('/auth/logout',{method:'POST',headers:{'idempotency-key':'logout-smoke-'+randomUUID()}})).status,200);assert.equal((await http('/knowledge')).status,401);
 console.log('PASS prepared local-dev actual restricted-LOGIN API: guest401, logged empty, synthetic list/detail same source, withdrawal404/empty, DoseCard0, logout401. No production approval.');
}finally{
 if(fixture){
  await owner.query('BEGIN');try{
   await owner.query('DELETE FROM knowledge_versions WHERE knowledge_id=$1',[knowledge]);
   await owner.query('UPDATE sources SET current_version_id=NULL WHERE id=$1',[source]);
   await owner.query('DELETE FROM source_versions WHERE id=$1 AND source_id=$2',[version,source]);
   await owner.query('DELETE FROM sources WHERE id=$1',[source]);await owner.query('DELETE FROM admin_accounts WHERE id=$1',[reviewer]);
   await owner.query("DELETE FROM knowledge_dataset_config WHERE key IN ('active_mode','database_connected')");
   for(const row of oldConfig)await owner.query('INSERT INTO knowledge_dataset_config(key,value,mode,updated_at) VALUES($1,$2,$3,$4)',[row.key,row.value,row.mode,row.updated_at]);
   if(oldMode)await owner.query("UPDATE knowledge_dataset_modes SET description=$1,accepts_database=$2,accepts_verified_seed=$3,accepts_simulation=$4,requires_clear_label=$5 WHERE mode='real'",[oldMode.description,oldMode.accepts_database,oldMode.accepts_verified_seed,oldMode.accepts_simulation,oldMode.requires_clear_label]);
   else await owner.query("DELETE FROM knowledge_dataset_modes WHERE mode='real'");
   await owner.query('COMMIT');
  }catch(e){await owner.query('ROLLBACK');throw e;}
 }
 await owner.end();
}
