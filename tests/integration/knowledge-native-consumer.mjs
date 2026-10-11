// Isolated native PG + actual business API + unmodified native page modules.
// Explicit test credentials only; no production URLs, suppliers or real identities.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import vm from 'node:vm';
const [rootArg,runtimeArg,outArg]=process.argv.slice(2);
assert.ok(rootArg&&runtimeArg&&outArg,'root, fresh private runtime directory and output directory required');
const root=resolve(rootArg),runtime=resolve(runtimeArg),out=resolve(outArg),read=p=>readFileSync(join(root,p),'utf8');
const c=JSON.parse(readFileSync(join(runtime,'private/config.json'),'utf8'));
assert.match(c.owner,/^gy_i07_owner_[a-z0-9_]+$/);assert.match(c.runtime,/^gy_i07_runtime_[a-z0-9_]+$/);assert.match(c.database,/^gy_i07_test_[a-z0-9_]+$/);
for(const k of ['ownerPassword','runtimePassword'])assert.match(c[k],/^[a-f0-9]{48}$/);
for(const k of ['apiPort','pgPort'])assert.ok(Number.isInteger(c[k])&&c[k]>=1024&&c[k]<=65535);
assert.notEqual(c.apiPort,c.pgPort);
const req=createRequire(join(root,'package.json')),pg=req('pg');
const {applyMigrations}=await import(pathToFileURL(join(root,'services/api/src/db/migrate.ts')));
const {buildApp}=await import(pathToFileURL(join(root,'services/api/src/app.ts')));
const {loadConfig}=await import(pathToFileURL(join(root,'services/api/src/config.ts')));
const ownerConfig={host:'127.0.0.1',port:c.pgPort,user:c.owner,password:c.ownerPassword};
let owner,apiPool,app;const pending=new Set(),httpEvidence=[];
const report={kind:'actual native PostgreSQL17 SCRAM restricted LOGIN + business Fastify HTTP + unmodified native page/auth/client modules in VM; all identity/catalog/source/review data synthetic; no WeChat rendering or production identity claim',combinationCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),combinationTree:execFileSync('git',['rev-parse','HEAD^{tree}'],{cwd:root,encoding:'utf8'}).trim(),cases:[],http:httpEvidence};
function pass(name){report.cases.push(name);console.log('PASS '+name)}
try {
 const admin=new pg.Client({...ownerConfig,database:'postgres'});await admin.connect();
 try{assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[c.database])).rowCount,0,'refuse existing test database');assert.equal((await admin.query("SELECT 1 FROM pg_roles WHERE rolname LIKE 'gengyun_%'")).rowCount,0,'refuse non-fresh cluster');await admin.query('CREATE DATABASE "'+c.database+'"');}finally{await admin.end()}
 owner=new pg.Client({...ownerConfig,database:c.database});await owner.connect();
 assert.equal((await owner.query("SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='public'")).rows[0].n,0);
 const migrations=await applyMigrations(owner);report.migrations=migrations.applied;report.postgresVersion=(await owner.query('SHOW server_version')).rows[0].server_version;
 for(const name of ['auth_privacy','knowledge_runtime'])await owner.query(read('services/api/db/roles/'+name+'.sql'));
 await owner.query(`CREATE ROLE ${c.runtime} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${c.runtimePassword}'`);
 await owner.query(`GRANT gengyun_auth_privacy,gengyun_knowledge_runtime TO ${c.runtime}`);
 apiPool=new pg.Pool({host:'127.0.0.1',port:c.pgPort,user:c.runtime,password:c.runtimePassword,database:c.database,max:4,statement_timeout:5000});
 const flags=(await apiPool.query('SELECT current_user,session_user,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname=current_user')).rows[0];
 assert.equal(flags.current_user,c.runtime);assert.equal(flags.session_user,c.runtime);assert.equal(flags.rolcanlogin,true);for(const k of ['rolsuper','rolcreatedb','rolcreaterole','rolreplication','rolbypassrls'])assert.equal(flags[k],false);report.runtimeFlags=flags;
 const members=(await apiPool.query('SELECT r.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid JOIN pg_roles u ON u.oid=m.member WHERE u.rolname=current_user ORDER BY r.rolname')).rows.map(x=>x.rolname);assert.deepEqual(members,['gengyun_auth_privacy','gengyun_knowledge_runtime']);report.runtimeGroups=members;
 const scram=(await owner.query('SELECT rolpassword LIKE $1 AS scram FROM pg_authid WHERE rolname=$2',['SCRAM-SHA-256$%',c.runtime])).rows[0].scram;assert.equal(scram,true);report.runtimeScram=scram;
 report.denials=[];
 for(const sql of ['SELECT body FROM knowledge_versions','SELECT canonical_url FROM sources','SELECT content_hash FROM source_versions','SELECT object_ref_cipher FROM media',"UPDATE users SET state='deleted'",'DELETE FROM knowledge_versions','CREATE TABLE rejected_ddl(x int)','CREATE TEMP TABLE rejected_temp(x int)','CREATE ROLE rejected_role','SET ROLE '+c.owner]){await assert.rejects(apiPool.query(sql),e=>e.code==='42501');report.denials.push({sql,code:'42501'})}
 pass('fresh native migrations, SCRAM LOGIN, exact two group membership, private data/write/DDL/TEMP/owner escalation denied');
 app=buildApp({config:loadConfig({APP_EXECUTION_MODE:'stub',LOG_LEVEL:'silent'}),pool:apiPool});
 const origin=await app.listen({host:'127.0.0.1',port:c.apiPort}),base=origin+'/api/v1';report.loopback={apiPort:c.apiPort,pgPort:c.pgPort};
 // VM uses actual page and CommonJS modules; wx transport/storage/navigation only are emulated.
 const storage=new Map(),routes=[],cache=new Map(),definitions=new Map();let currentPage,definition;
 const wx={getStorageSync:k=>storage.get(k),setStorageSync:(k,v)=>storage.set(k,v),removeStorageSync:k=>storage.delete(k),login:o=>o.success({code:'synthetic-native-consumer-'+randomUUID()}),showModal:o=>o.success({confirm:true}),showToast:()=>{},navigateTo:o=>routes.push(o.url),reLaunch:o=>routes.push(o.url),redirectTo:o=>routes.push(o.url),navigateBack:()=>{},setClipboardData:()=>{},request(o){const u=new URL(o.url);assert.equal(u.origin,origin);const p=fetch(o.url,{method:o.method,headers:o.header,...(o.data===undefined?{}:{body:JSON.stringify(o.data)})}).then(async r=>{const data=await r.json();httpEvidence.push({method:o.method,path:u.pathname,query:u.search,status:r.status,error:data.error?.code??null});o.success({statusCode:r.status,data})}).catch(()=>o.fail({})).finally(()=>pending.delete(p));pending.add(p)}};
 function load(file){file=resolve(file);if(file===join(root,'miniprogram/config/runtime.js'))return{mode:'local',apiBaseUrl:base};if(cache.has(file)){if(definitions.has(file))definition=definitions.get(file);return cache.get(file).exports;}const module={exports:{}};cache.set(file,module);vm.runInNewContext('(function(require,module,exports){'+readFileSync(file,'utf8')+'\n})',{wx,Page:d=>{definition=d;definitions.set(file,d)},getApp:()=>({globalData:{fontScale:1}}),getCurrentPages:()=>currentPage?[currentPage]:[]})((id)=>load(resolve(dirname(file),id.endsWith('.js')?id:id+'.js')),module,module.exports);return module.exports}
 function page(name,options={}){load(join(root,'miniprogram/pages',name,name+'.js'));currentPage={...definition,data:structuredClone(definition.data),route:'pages/'+name+'/'+name,options,setData(d){Object.assign(this.data,d)}};currentPage.onLoad?.(options);return currentPage}
 async function until(fn){for(let i=0;i<700&&!fn();i++)await new Promise(r=>setTimeout(r,10));assert.ok(fn(),'actual native page state timed out')}
 const auth=load(join(root,'miniprogram/utils/auth.js')),client=load(join(root,'miniprogram/utils/knowledge-api.js'));
 let list=page('knowledge');list.onShow();assert.equal(list.data.gatePassed,false);assert.equal(httpEvidence.length,0);assert.match(routes.at(-1),/pages\/login\/login/);
 const guest=await fetch(base+'/knowledge');assert.equal(guest.status,401);assert.equal((await guest.json()).error.code,'SESSION_REQUIRED');pass('guest native gate sends no knowledge request; direct business endpoint 401');
 await new Promise((yes,no)=>auth.login(e=>e?no(Error(e)):yes()));assert.equal(auth.isLoggedIn(),true);assert.equal(auth.getSession().executionMode,'stub');list.onShow();await until(()=>list.data.gatePassed&&!list.data.busy&&list.data.status.includes('没有'));assert.equal(list.data.items.length,0);assert.ok(httpEvidence.some(x=>x.path.endsWith('/auth/session')&&x.status===200));pass('actual auth/session SQL + native auth/gate: valid synthetic login and empty database yields empty page');
 const fixture={admin:randomUUID(),source:randomUUID(),version:randomUUID(),knowledge:randomUUID(),retrieved:'2026-10-11T00:00:00.000Z'};
 await owner.query("INSERT INTO admin_accounts(id,login_name,credential_hash) VALUES($1,'synthetic-native-reviewer','synthetic-not-login')",[fixture.admin]);
 await owner.query("INSERT INTO knowledge_dataset_modes(mode,description,accepts_database,accepts_verified_seed) VALUES('real','ISOLATED SYNTHETIC fixture; not production approval',true,true)");
 await owner.query("INSERT INTO knowledge_dataset_config(key,value,mode) VALUES('active_mode','real','real'),('database_connected','true','real')");
 await owner.query("INSERT INTO sources(id,title,canonical_url,publisher,source_kind,evidence_kind) VALUES($1,'隔离合成测试来源（非核准资料）','https://example.invalid/i07-synthetic-only','隔离合成夹具发布方（非真实机构）','verified_seed','research')",[fixture.source]);
 await owner.query("INSERT INTO source_versions(id,source_id,version,content_hash,locator,retrieved_at,valid_from,validity,review_status,reviewed_by,reviewed_at) VALUES($1,$2,'synthetic-native-v1',repeat('a',64),'synthetic:only',$3,now()-interval '1 day','valid','verified',$4,now())",[fixture.version,fixture.source,fixture.retrieved,fixture.admin]);
 await owner.query('UPDATE sources SET current_version_id=$1 WHERE id=$2',[fixture.version,fixture.source]);
 await owner.query("INSERT INTO knowledge_versions(id,knowledge_id,revision,title,body,type,source_version_id,crop_ids,species_ids,region_codes,visibility) VALUES($1,$2,1,'隔离合成科普（非真实核准资料）','这是独立测试数据库中的合成正文，不代表核准资料或用药建议。','species',$3,'[\"crop_rice\"]','[\"synthetic_weed\"]','[\"330102\"]','published')",[randomUUID(),fixture.knowledge,fixture.version]);
 list.search();await until(()=>!list.data.busy&&list.data.items.length===1);const item=list.data.items[0].item;assert.equal(item.id,fixture.knowledge);assert.equal(item.source.id,fixture.source);assert.equal(item.source.version,'synthetic-native-v1');assert.equal(item.source.updated_at,fixture.retrieved);assert.equal(item.conditions,null);assert.equal(item.dose_cards.length,0);assert.match(list.data.modeNote,/替身/);assert.match(item.title,/合成/);
 list.open({currentTarget:{dataset:{id:item.id}}});assert.match(routes.at(-1),new RegExp(item.id));list.onHide();let detail=page('knowledgedetail',{id:item.id});detail.onShow();await until(()=>!detail.data.busy&&!!detail.data.item);assert.equal(client.fingerprint(detail.data.item),client.fingerprint(item));assert.equal(detail.data.item.dose_cards.length,0);pass('actual page list→detail across auth gate and business SQL projection; exact SourceRef tuple; null conditions and zero DoseCard');
 detail.onHide();list=page('knowledge');list.onShow();await until(()=>list.data.gatePassed&&!list.data.busy&&list.data.items.length===1);list.input({currentTarget:{dataset:{field:'q'}},detail:{value:'不存在的合成关键词'}});list.search();await until(()=>!list.data.busy&&list.data.status.includes('没有'));assert.equal(list.data.items.length,0);pass('real business query no match clears previously displayed native list; no bundled fallback');
 list.reset();await until(()=>!list.data.busy&&list.data.items.length===1);list.open({currentTarget:{dataset:{id:item.id}}});list.onHide();detail=page('knowledgedetail',{id:item.id});detail.onShow();await until(()=>!detail.data.busy&&!!detail.data.item);
 await owner.query("UPDATE source_versions SET validity='withdrawn' WHERE id=$1",[fixture.version]);detail.retry();await until(()=>!detail.data.busy&&!detail.data.item&&detail.data.status.includes('已失效'));assert.ok(httpEvidence.some(x=>x.path.endsWith('/knowledge/'+item.id)&&x.status===404));detail.onHide();list=page('knowledge');list.onShow();await until(()=>list.data.gatePassed&&!list.data.busy&&list.data.status.includes('没有'));assert.equal(list.data.items.length,0);pass('separate owner fixture connection withdraws source; fresh business detail 404 clears body, returning list empty');
 await owner.query("UPDATE source_versions SET validity='valid' WHERE id=$1",[fixture.version]);list.search();await until(()=>!list.data.busy&&list.data.items.length===1);
 const token=auth.getSession().accessToken,hash=createHash('sha256').update(token).digest('hex');await owner.query("UPDATE sessions SET expires_at=created_at+interval '1 millisecond' WHERE token_hash=decode($1,'hex')",[hash]);await new Promise(r=>setTimeout(r,10));list.search();await until(()=>!list.data.busy&&list.data.items.length===0&&!auth.isLoggedIn());assert.equal(auth.getSession(),null);assert.ok(httpEvidence.some(x=>x.path.endsWith('/knowledge')&&x.status===401));pass('server-side persisted session expiry: native query 401 clears cached session and prior list');
 list.onHide();list=page('knowledge');list.onShow();assert.equal(list.data.gatePassed,false);assert.match(routes.at(-1),/pages\/login\/login/);
 report.sourceHashes={};for(const file of ['services/api/src/app.ts','services/api/src/knowledge/service.ts','services/api/src/routes/knowledge.ts','services/api/db/migrations/0010_knowledge_read_views.sql','services/api/db/roles/knowledge_runtime.sql','miniprogram/utils/auth.js','miniprogram/utils/page-gate.js','miniprogram/utils/knowledge-api.js','miniprogram/pages/knowledge/knowledge.js','miniprogram/pages/knowledgedetail/knowledgedetail.js'])report.sourceHashes[file]=createHash('sha256').update(execFileSync('git',['show',report.combinationCommit+':'+file],{cwd:root})).digest('hex');
 mkdirSync(out,{recursive:true});writeFileSync(join(out,'observations.json'),JSON.stringify(report,null,2)+'\n');console.log('PASS 7 native business/frontend groups; no suppliers, production identities, Android rendering or main integration claim');
} catch(e){console.error('FAIL '+e.name+': '+(e.code??'assertion'));process.exitCode=1}
finally{await Promise.allSettled([...pending]);if(app)await app.close();if(apiPool)await apiPool.end();if(owner)await owner.end()}
