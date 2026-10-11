// Isolated synthetic catalogs/identity. Native mode provisions an empty dedicated test DB;
// API pool is a separate limited LOGIN, never the fixture owner.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
const read=p=>readFileSync(new URL('../../'+p,import.meta.url),'utf8');
export async function createProfileFixture() {
 let db,pool,nativeOwner,runtime,queue=Promise.resolve();const native=process.env.GY_PROFILE_UI_TEST_OWNER_URL;let runtimeName='gy_i05_ui_runtime';
 if(native){const url=new URL(native);assert.equal(url.hostname,'127.0.0.1');assert.match(url.pathname,/^\/gy_i05_ui_test_[a-z0-9_]{1,24}$/);runtimeName+='_'+url.pathname.slice('/gy_i05_ui_test_'.length);nativeOwner=new pg.Pool({connectionString:native});db={exec:s=>nativeOwner.query(s),query:(...a)=>nativeOwner.query(...a)};assert.equal((await db.query("SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='public'")).rows[0].n,0);assert.equal((await db.query("SELECT count(*)::int n FROM pg_roles WHERE rolname IN ('gengyun_auth_privacy','gengyun_profile_runtime')")).rows[0].n,0,'Native fixture requires a fresh dedicated cluster for global group roles');}
 else db=new PGlite();
 for(const name of ['0001_initial_schema','0002_knowledge_catalog','0003_privacy_consent','0008_auth_session','0009_consent_policy'])await db.exec(read('services/api/db/migrations/'+name+'.sql'));
 for(const c of JSON.parse(read('packages/knowledge/catalog/crops.json')).crops)await db.query('INSERT INTO crops(id,name,active) VALUES($1,$2,true)',[c.id,c.name]);
 for(const r of JSON.parse(read('packages/knowledge/catalog/regions-zhejiang.json')).regions)await db.query('INSERT INTO regions(code,name,parent_code,catalog_version,supported) VALUES($1,$2,$3,$4,true)',[r.code,r.name,r.parent_code,r.catalog_version]);
 for(const name of ['auth_privacy','profile_runtime'])await db.exec(read('services/api/db/roles/'+name+'.sql'));
 await db.exec('CREATE ROLE '+runtimeName+' '+(native?'LOGIN':'NOLOGIN')+' INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; GRANT gengyun_auth_privacy,gengyun_profile_runtime TO '+runtimeName);
 if(native){const url=new URL(native);url.username=runtimeName;url.password='';runtime=new pg.Pool({connectionString:url.href,max:4,statement_timeout:5000});pool=runtime;}
 else pool={async connect(){const before=queue;let unlock;queue=new Promise(r=>{unlock=r});await before;await db.query('SET ROLE gy_i05_ui_runtime');return {query:(...a)=>db.query(...a),release(){db.query('RESET ROLE').finally(unlock)}}},async query(...args){const c=await this.connect();try{return await c.query(...args)}finally{c.release()}}};
 const role=(await pool.query('SELECT current_user role')).rows[0].role;assert.equal(role,runtimeName);
 const flags=(await pool.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname=current_user')).rows[0];for(const k of ['rolsuper','rolcreatedb','rolcreaterole','rolreplication','rolbypassrls'])assert.equal(flags[k],false);assert.equal(flags.rolcanlogin,!!native);
 const app=buildApp({config:loadConfig({APP_EXECUTION_MODE:'stub',LOG_LEVEL:'silent'}),pool});
 return {app,kind:native?'native PostgreSQL, limited LOGIN':'PGlite, serialized limited SET ROLE',async close(){await app.close();if(native){await runtime.end();await nativeOwner.end()}else{await queue;await db.close()}}};
}
