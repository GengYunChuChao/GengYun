import {readFileSync} from 'node:fs';
import {join} from 'node:path';

/** Only the isolated stub database. Never an API helper or production importer. */
export async function bootstrapLocalProfile(client,root) {
 const target=(await client.query('SELECT current_database() AS database,current_user AS actor')).rows[0];
 if(target.database!=='gengyun_local_dev'||target.actor!=='gengyun_local_owner')throw new Error('Profile fixture requires the dedicated local owner/database');
 await client.query('BEGIN');
 try {
  if(!(await client.query("SELECT 1 FROM pg_roles WHERE rolname='gengyun_profile_runtime'")).rows.length){
   // Role script has its own transaction, so install it before fixture transaction.
   await client.query('COMMIT');
   await client.query(readFileSync(join(root,'services/api/db/roles/profile_runtime.sql'),'utf8'));
   await client.query('BEGIN');
  }
  const group=(await client.query("SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname='gengyun_profile_runtime'")).rows[0];
  if(!group||Object.values(group).some(Boolean))throw new Error('Profile group must retain its reviewed NOLOGIN restrictions');
  const runtime=(await client.query("SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolinherit,rolcanlogin FROM pg_roles WHERE rolname='gengyun_local_runtime'")).rows[0];
  if(!runtime||runtime.rolsuper||runtime.rolcreatedb||runtime.rolcreaterole||runtime.rolreplication||runtime.rolbypassrls||!runtime.rolinherit||!runtime.rolcanlogin)throw new Error('Local API must use the existing restricted LOGIN');
  if((await client.query("SELECT pg_has_role('gengyun_local_runtime',current_user,'MEMBER') AS owner_member")).rows[0].owner_member)throw new Error('Local API cannot inherit or SET ROLE to the migration owner');
  // Always reconcile this membership, including an existing pre-profile LOGIN.
  await client.query('GRANT gengyun_profile_runtime TO gengyun_local_runtime');
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
  await client.query('COMMIT');
  return {synthetic:true,initialized,cropCount:crops.length,regionCount:regions.length};
 } catch(error) {await client.query('ROLLBACK').catch(()=>{});throw error;}
}
