import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {bootstrapLocalProfile} from './profile-bootstrap.mjs';
const settings=JSON.parse(readFileSync(new URL('./settings.json',import.meta.url),'utf8'));
const repoRequire=createRequire(pathToFileURL(settings.repoRoot+'/package.json'));
const pg=repoRequire('pg');
const {applyMigrations}=await import(pathToFileURL(settings.repoRoot+'/services/api/src/db/migrate.ts'));
const config=JSON.parse(readFileSync(new URL('./private/config.json',import.meta.url),'utf8'));
const base={host:'127.0.0.1',port:settings.pgPort,user:'gengyun_local_owner',password:config.ownerPassword};
const admin=new pg.Client({...base,database:'postgres'});
await admin.connect();
try {
 if(!(await admin.query("SELECT 1 FROM pg_database WHERE datname='gengyun_local_dev'")).rowCount)
  await admin.query('CREATE DATABASE gengyun_local_dev');
} finally {await admin.end();}
const owner=new pg.Client({...base,database:'gengyun_local_dev'});
await owner.connect();
try {
 const result=await applyMigrations(owner);
 for(const [role,file] of [['gengyun_auth_privacy','auth_privacy'],['gengyun_preview_reader','catalog_readers'],['gengyun_consent_granter','consent_granter']]){
  if(!(await owner.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).rowCount)
   await owner.query(readFileSync(pathToFileURL(settings.repoRoot+'/services/api/db/roles/'+file+'.sql'),'utf8'));
 }
 if(!(await owner.query("SELECT 1 FROM pg_roles WHERE rolname='gengyun_local_runtime'")).rowCount){
  if(!/^[a-f0-9]{48}$/.test(config.runtimePassword))throw new Error('Invalid generated runtime password');
  await owner.query("CREATE ROLE gengyun_local_runtime LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '"+config.runtimePassword+"'");
  await owner.query('GRANT gengyun_auth_privacy,gengyun_preview_reader,gengyun_consent_granter TO gengyun_local_runtime');
 }
 const profile=await bootstrapLocalProfile(owner,settings.repoRoot);
 console.log('Local profile catalog: synthetic fixture; '+profile.cropCount+' crops, '+profile.regionCount+' regions; '+(profile.initialized?'initialized empty local tables':'existing fixture preserved')+'.');
 console.log('Database ready: '+result.applied.length+' applied, '+result.skipped.length+' unchanged migrations.');
} finally {await owner.end();}
