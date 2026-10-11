import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,cpSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {prepareLocalDev} from '../../tools/local-dev/prepare.mjs';
import {spawnSync} from 'node:child_process';
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

test('Windows local password generator works with Framework RNG and retains independent 192-bit outputs',{skip:process.platform!=='win32'},()=>{
 const script=readFileSync(resolve(import.meta.dirname,'../../tools/local-dev/start.ps1'),'utf8');
 const generator=script.match(/ function New-LocalRandomPassword \{[\s\S]*?\n \}/)?.[0];assert.ok(generator);
 const command=generator+"\n$taskA=New-LocalRandomPassword;$taskB=New-LocalRandomPassword;if($taskA -notmatch '^[a-f0-9]{48}$' -or $taskB -notmatch '^[a-f0-9]{48}$' -or $taskA -eq $taskB){throw 'Local RNG failed'};Write-Output 'PASS local RNG compatibility'";
 const result=spawnSync('powershell',['-NoProfile','-NonInteractive','-Command',command],{encoding:'utf8',timeout:15000});
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/PASS local RNG compatibility/);
});

// Run the actual checked-wait blocks with redirected child processes: PS5 otherwise loses ExitCode.
test('Windows redirected child exit codes survive waiting in both start and stop',{skip:process.platform!=='win32'},()=>{
 const window=mkdtempSync(join(tmpdir(),'gengyun-local-package-'));
 try{
  for(const file of ['start.ps1','stop.ps1']){
   const script=readFileSync(resolve(import.meta.dirname,'../../tools/local-dev',file),'utf8');
   const checked=script.match(/ \$null=\$taskProcess.Handle\r?\n \$taskProcess.WaitForExit\(\)\r?\n  ?if\(\$taskProcess.ExitCode -ne 0\)\{throw '[^']+'\}/)?.[0];assert.ok(checked,file);
   for(const code of [0,7]){
    const prefix="$ErrorActionPreference='Stop';$taskProcess=Start-Process -FilePath cmd.exe -ArgumentList '/c exit "+code+"' -WindowStyle Hidden -PassThru -RedirectStandardOutput '"+join(window,'out').replaceAll("'","''")+"' -RedirectStandardError '"+join(window,'err').replaceAll("'","''")+"';\n";
    const r=spawnSync('powershell',['-NoProfile','-NonInteractive','-Command',prefix+checked+"\nWrite-Output ('EXIT='+$taskProcess.ExitCode)"],{encoding:'utf8',timeout:15000});
    if(code===0){assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/EXIT=0/);}else{assert.notEqual(r.status,0);assert.match(r.stderr,/Local PG (startup|stop) failed/);}
   }
  }
 }finally{cleanup(window);}
});
