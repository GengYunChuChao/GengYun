import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const localRoleSet=new Set(['gengyun_local_runtime','gengyun_auth_privacy','gengyun_preview_reader','gengyun_consent_granter','gengyun_profile_runtime','gengyun_knowledge_runtime']);
async function assertMembershipChain(client,role) {
 const rows=(await client.query(`SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolcanlogin
  FROM pg_roles WHERE pg_has_role($1,oid,'MEMBER')`,[role])).rows;
 if(!rows.length||rows.some(row=>!localRoleSet.has(row.rolname)||row.rolsuper||row.rolcreatedb||row.rolcreaterole||row.rolreplication||row.rolbypassrls||(row.rolname!=='gengyun_local_runtime'&&row.rolcanlogin)))throw new Error('Unexpected or privileged role in local API membership chain');
}

async function assertKnowledgeProjection(client) {
 const view=(await client.query(`SELECT c.relkind,c.reloptions,pg_get_userbyid(c.relowner)=current_user AS migration_owned
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='catalog_read' AND c.relname='current_knowledge'`)).rows[0];
 if(!view||view.relkind!=='v'||!view.migration_owned||!view.reloptions?.includes('security_barrier=true'))throw new Error('Apply reviewed 0010 knowledge security-barrier view as local migration owner first');
}
async function assertKnowledgePrivileges(client) {
 const safe=(await client.query(`SELECT has_table_privilege('gengyun_knowledge_runtime','catalog_read.current_knowledge','SELECT') AS readable,
  EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
   AND ((c.oid<>'catalog_read.current_knowledge'::regclass AND has_any_column_privilege('gengyun_knowledge_runtime',c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))
    OR has_table_privilege('gengyun_knowledge_runtime',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))) AS extra_table_rights,
  EXISTS(SELECT 1 FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname<>'information_schema'
   AND has_schema_privilege('gengyun_knowledge_runtime',oid,'CREATE')) AS schema_write`)).rows[0];
 if(!safe?.readable||safe.extra_table_rights||safe.schema_write)throw new Error('Knowledge group must have only reviewed read projection privileges');
}

/** Only the isolated stub database. Never an API helper or production importer. */
export async function bootstrapLocalProfile(client,root) {
 const target=(await client.query('SELECT current_database() AS database,current_user AS actor')).rows[0];
 if(target.database!=='gengyun_local_dev'||target.actor!=='gengyun_local_owner')throw new Error('Profile fixture requires the dedicated local owner/database');
 await client.query('BEGIN');
 try {
  await assertKnowledgeProjection(client);
  for(const [role,file] of [['gengyun_profile_runtime','profile_runtime'],['gengyun_knowledge_runtime','knowledge_runtime']]){
  if(!(await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).rows.length){
   // Keep the reviewed grants inside THIS transaction so any later failure also
   // removes a newly created group. Only its standalone transaction markers go.
   const script=readFileSync(join(root,'services/api/db/roles/'+file+'.sql'),'utf8').replace(/\r\n/g,'\n');
   if((script.match(/^BEGIN;$/gm)||[]).length!==1||(script.match(/^COMMIT;$/gm)||[]).length!==1)throw new Error('Unexpected local role transaction wrapper');
   await client.query(script.replace(/^BEGIN;$/m,'').replace(/^COMMIT;$/m,''));
  }
  const group=(await client.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname=$1',[role])).rows[0];
  if(!group||Object.values(group).some(Boolean))throw new Error('Local group must retain its reviewed NOLOGIN restrictions');
  }
  const runtime=(await client.query("SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolinherit,rolcanlogin FROM pg_roles WHERE rolname='gengyun_local_runtime'")).rows[0];
  if(!runtime||runtime.rolsuper||runtime.rolcreatedb||runtime.rolcreaterole||runtime.rolreplication||runtime.rolbypassrls||!runtime.rolinherit||!runtime.rolcanlogin)throw new Error('Local API must use the existing restricted LOGIN');
  if((await client.query("SELECT pg_has_role('gengyun_local_runtime',current_user,'MEMBER') AS owner_member")).rows[0].owner_member)throw new Error('Local API cannot inherit or SET ROLE to the migration owner');
  await assertMembershipChain(client,'gengyun_profile_runtime');
  await assertMembershipChain(client,'gengyun_knowledge_runtime');
  await assertKnowledgePrivileges(client);
  await assertMembershipChain(client,'gengyun_local_runtime');
  // Always reconcile this membership, including an existing pre-profile LOGIN.
  await client.query('GRANT gengyun_profile_runtime TO gengyun_local_runtime');
  await client.query('GRANT gengyun_knowledge_runtime TO gengyun_local_runtime');
  await assertMembershipChain(client,'gengyun_local_runtime');
  const crops=JSON.parse(readFileSync(join(root,'packages/knowledge/catalog/crops.json'),'utf8')).crops;
  const regions=JSON.parse(readFileSync(join(root,'packages/knowledge/catalog/regions-zhejiang.json'),'utf8')).regions;
  // No replacement/repair of existing data: incomplete or different catalog needs
  // operator attention. Insertion is a synthetic local fixture, not approval.
  await client.query('LOCK TABLE public.crops,public.regions IN SHARE ROW EXCLUSIVE MODE');
  const beforeCrops=(await client.query('SELECT id,name,active FROM crops ORDER BY id')).rows;
  const beforeRegions=(await client.query('SELECT code,name,parent_code,catalog_version,supported FROM regions ORDER BY code')).rows;
  let initialized=false;
  if(beforeCrops.length===0&&beforeRegions.length===0){
   for(const row of crops)await client.query('INSERT INTO crops(id,name,active) VALUES($1,$2,true)',[row.id,row.name]);
   for(const row of regions)await client.query('INSERT INTO regions(code,name,parent_code,catalog_version,supported) VALUES($1,$2,$3,$4,true)',[row.code,row.name,row.parent_code,row.catalog_version]);
   initialized=true;
  } else {
   const expectedCrops=crops.map(({id,name})=>({id,name,active:true})).sort((a,b)=>a.id.localeCompare(b.id));
   const expectedRegions=regions.map(({code,name,parent_code,catalog_version})=>({code,name,parent_code,catalog_version,supported:true})).sort((a,b)=>a.code.localeCompare(b.code));
   if(JSON.stringify(beforeCrops)!==JSON.stringify(expectedCrops)||JSON.stringify(beforeRegions)!==JSON.stringify(expectedRegions))throw new Error('Existing local catalog differs; preserve it and use a fresh isolated fixture');
  }
  await assertMembershipChain(client,'gengyun_local_runtime');
  await assertKnowledgePrivileges(client);
  await client.query('COMMIT');
  return {synthetic:true,initialized,cropCount:crops.length,regionCount:regions.length,knowledgeReady:true};
 } catch(error) {await client.query('ROLLBACK').catch(()=>{});throw error;}
}
