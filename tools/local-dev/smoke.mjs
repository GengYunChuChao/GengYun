import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const settings=JSON.parse(readFileSync(new URL('./settings.json',import.meta.url),'utf8'));
const repoRequire=createRequire(pathToFileURL(settings.repoRoot+'/package.json'));
const pg=repoRequire('pg');
const require=createRequire(import.meta.url);
const storage=new Map(),routes=[],pending=new Set();
let pages=[{route:'pages/reference/reference',options:{}}];
global.getCurrentPages=()=>pages;
global.wx={getStorageSync:k=>storage.get(k),setStorageSync:(k,v)=>storage.set(k,v),removeStorageSync:k=>storage.delete(k),
 login:o=>o.success({code:'synthetic-local-smoke-'+randomUUID()}),
 reLaunch:o=>{routes.push(o.url);o.success?.();},switchTab:o=>{routes.push(o.url);o.success?.();},navigateTo:o=>{routes.push(o.url);o.success?.();},
 request:o=>{const task=(async()=>{try{const res=await fetch(o.url,{method:o.method,headers:o.header,body:o.data?JSON.stringify(o.data):undefined});o.success({statusCode:res.status,data:await res.json()});}catch{ o.fail?.();}})();pending.add(task);task.finally(()=>pending.delete(task));}
};
const auth=require('./wechat/miniprogram/utils/auth.js');
assert.equal((await fetch(`http://127.0.0.1:${settings.apiPort}/health`)).status,200);
assert.equal((await fetch(`http://127.0.0.1:${settings.apiPort}/api/v1/auth/session`)).status,401);
auth.requireLogin(()=>{});assert.equal(routes.at(-1),'/pages/login/login');
const id=await new Promise((resolve,reject)=>auth.login((error,id)=>error?reject(new Error(error)):resolve(id)));
assert.ok(auth.isLoggedIn());assert.ok(auth.resumeAfterLogin(id));assert.equal(routes.at(-1),'/pages/reference/reference');assert.equal(auth.resumeAfterLogin(id),false);
assert.equal(await new Promise(resolve=>auth.verifySession(resolve)),true);
for(const [name,id,key] of [['referencedetail','gy-i03-hb-001','detail'],['referenceseeddetail','gy-i07-seed-hb-001','item'],['reference',null,'items'],['referenceseed',null,'list']]){
 delete require.cache[require.resolve('./wechat/miniprogram/utils/auth.js')];
 delete require.cache[require.resolve('./wechat/miniprogram/utils/page-gate.js')];
 const cold=require('./wechat/miniprogram/utils/auth.js');assert.equal(cold.isLoggedIn(),false);
 let definition;global.Page=value=>{definition=value;};
 const pagePath='./wechat/miniprogram/pages/'+name+'/'+name+'.js';delete require.cache[require.resolve(pagePath)];require(pagePath);
 const page={...definition,route:'pages/'+name+'/'+name,options:id?{id}:{},data:{...definition.data},setData(value){Object.assign(this.data,value);}};
 pages=[page];page.onLoad(page.options);page.onShow();assert.equal(page.data.gatePassed,false);
 while(pending.size)await Promise.all([...pending]);
 assert.equal(page.data.gatePassed,true);if(id){assert.equal(page.data.found,true);assert.ok(page.data[key]);}else assert.ok(page.data[key].length>0);
 page.onHide();assert.equal(page.data.gatePassed,false);page.onShow();while(pending.size)await Promise.all([...pending]);assert.equal(page.data.gatePassed,true);
}
const token=storage.get('gengyun.session').accessToken;
const base=`http://127.0.0.1:${settings.apiPort}/api/v1`;
const profileHeaders={Authorization:'Bearer '+token};
const profileBefore=await fetch(base+'/me/profile',{headers:profileHeaders});assert.equal(profileBefore.status,200);
const before=await profileBefore.json();
const crops=await fetch(base+'/catalog/crops',{headers:profileHeaders});assert.equal(crops.status,200);
const cropItems=(await crops.json()).data.items;assert.equal(cropItems.length,4);
const regions=await fetch(base+'/catalog/regions?parent_code=330100',{headers:profileHeaders});assert.equal(regions.status,200);
const regionItems=(await regions.json()).data.items;assert.ok(regionItems.length>0);
const body={crop_id:cropItems[0].id,region_code:regionItems[0].code,region_catalog_version:regionItems[0].catalog_version};
const key='local-profile-'+randomUUID();
const putHeaders={...profileHeaders,'Content-Type':'application/json','If-Match':profileBefore.headers.get('etag'),'Idempotency-Key':key};
const save=await fetch(base+'/me/profile',{method:'PUT',headers:putHeaders,body:JSON.stringify(body)});assert.equal(save.status,200);
const saved=await save.json();assert.equal(saved.data.revision,before.data.revision+1);
assert.equal(save.headers.get('etag'),'"'+saved.data.revision+'"');
const replay=await fetch(base+'/me/profile',{method:'PUT',headers:putHeaders,body:JSON.stringify(body)});assert.equal(replay.status,200);assert.deepEqual((await replay.json()).data,saved.data);
const conflict=await fetch(base+'/me/profile',{method:'PUT',headers:{...putHeaders,'Idempotency-Key':'different-'+randomUUID()},body:JSON.stringify(body)});assert.equal(conflict.status,409);assert.equal((await conflict.json()).error.code,'REVISION_CONFLICT');
const denied=await fetch(base+'/me/profile',{method:'PUT',headers:{...putHeaders,'Idempotency-Key':'invalid-'+randomUUID(),'If-Match':save.headers.get('etag')},body:JSON.stringify({...body,owner_id:'client-owner'})});assert.equal(denied.status,400);
const config=JSON.parse(readFileSync(new URL('./private/config.json',import.meta.url),'utf8'));
const runtime=new pg.Client({host:'127.0.0.1',port:settings.pgPort,user:'gengyun_local_runtime',password:config.runtimePassword,database:'gengyun_local_dev'});
await runtime.connect();
try{
 assert.equal((await runtime.query('SELECT current_user AS actor')).rows[0].actor,'gengyun_local_runtime');
 assert.equal((await runtime.query("SELECT count(*)::integer AS n FROM sessions WHERE token_hash=decode($1,'hex')",[createHash('sha256').update(token).digest('hex')])).rows[0].n,1);
 const flags=(await runtime.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];assert.ok(Object.values(flags).every(value=>value===false));
 for(const sql of ['CREATE TABLE public.local_forbidden(id int)','CREATE ROLE local_forbidden_role','DELETE FROM crops','DELETE FROM single_profiles',"UPDATE users SET state='suspended'",'SELECT object_ref_cipher FROM media','SELECT object_id FROM exports'])await assert.rejects(runtime.query(sql),error=>error.code==='42501');
}finally{await runtime.end();}
const result=await new Promise(resolve=>auth.logout(resolve));assert.equal(result.serverRevoked,true);
assert.equal((await fetch(`http://127.0.0.1:${settings.apiPort}/api/v1/auth/session`,{headers:{Authorization:'Bearer '+token}})).status,401);
assert.equal((await fetch(base+'/me/profile',{headers:profileHeaders})).status,401);
assert.equal((await fetch(base+'/me/profile',{method:'PUT',headers:putHeaders,body:JSON.stringify(body)})).status,401);
await Promise.all([...pending]);
console.log('PASS local client → actual restricted-LOGIN API → persistent PostgreSQL: login/four-page loading, profile/catalog GET, ETag save/replay/conflict, forbidden owner, SQL privilege denials, hashed session, logout and old-token profile/replay denial. Profile catalog is a synthetic local fixture.');
console.log('Synthetic WeChat identity only; not GUI compilation, device or real WeChat evidence.');
