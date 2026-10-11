import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,cpSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {prepareLocalDev} from '../../tools/local-dev/prepare.mjs';
function cleanup(root){assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('gengyun-local-package-'));rmSync(root,{recursive:true,force:true});}
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'gengyun-local-package-'));
 const repo=resolve(import.meta.dirname,'../..');
 cpSync(join(repo,'miniprogram'),join(root,'miniprogram'),{recursive:true});
 cpSync(join(repo,'tools/local-dev'),join(root,'tools/local-dev'),{recursive:true});
 cpSync(join(repo,'project.config.json'),join(root,'project.config.json'));
 const bin=join(root,'pg-bin');mkdirSync(bin);for(const exe of ['initdb.exe','pg_ctl.exe'])writeFileSync(join(bin,exe),'fixture');
 return {root,postgresBin:bin};
}
test('local package includes actual navigation dependencies, stays synthetic and excludes local secrets',()=>{
 const f=fixture();try{
  const runtime=readFileSync(join(f.root,'miniprogram/config/runtime.js'),'utf8');
  writeFileSync(join(f.root,'miniprogram/config/secret.local.json'),'do not copy');
  writeFileSync(join(f.root,'miniprogram/.env'),'do not copy');
  const out=prepareLocalDev({...f,apiPort:3101,pgPort:55437});
  assert.ok(existsSync(join(out,'wechat/miniprogram/utils/navigation.js')));
  assert.ok(existsSync(join(out,'profile-bootstrap.mjs')));
  assert.match(readFileSync(join(out,'database.mjs'),'utf8'),/bootstrapLocalProfile/);
  assert.equal(existsSync(join(out,'wechat/miniprogram/config/secret.local.json')),false);
  assert.equal(existsSync(join(out,'wechat/miniprogram/.env')),false);
  assert.equal(readFileSync(join(f.root,'miniprogram/config/runtime.js'),'utf8'),runtime);
  assert.equal(JSON.parse(readFileSync(join(f.root,'project.config.json'))).setting.urlCheck,true);
  assert.equal(JSON.parse(readFileSync(join(out,'wechat/project.private.config.json'))).setting.urlCheck,false);
  assert.match(readFileSync(join(out,'wechat/miniprogram/config/runtime.js'),'utf8'),/3101\/api\/v1/);
  assert.match(readFileSync(join(out,'api.mjs'),'utf8'),/APP_EXECUTION_MODE:'stub'/);
  assert.equal(existsSync(join(out,'private/config.json')),false);
  assert.throws(()=>prepareLocalDev(f),/Output exists/);
 }finally{cleanup(f.root);}
});
test('invalid ports, missing PostgreSQL or modified release config reject before output',()=>{
 const f=fixture();try{
  for(const ports of [{apiPort:80},{pgPort:70000},{apiPort:3100,pgPort:3100}])assert.throws(()=>prepareLocalDev({...f,...ports}));
  assert.throws(()=>prepareLocalDev({...f,postgresBin:join(f.root,'missing')}),/Windows PostgreSQL/);
  const config=JSON.parse(readFileSync(join(f.root,'project.config.json')));config.setting.urlCheck=false;writeFileSync(join(f.root,'project.config.json'),JSON.stringify(config));
  assert.throws(()=>prepareLocalDev(f),/domain validation/);
  assert.equal(existsSync(join(f.root,'.local/local-dev')),false);
 }finally{cleanup(f.root);}
});
