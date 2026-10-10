import {copyFileSync,mkdirSync,readFileSync,writeFileSync,existsSync,readdirSync,lstatSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
export function prepareLocalDev({root,postgresBin,apiPort=3100,pgPort=55436}) {
 root=resolve(root);postgresBin=resolve(postgresBin);
 for(const port of [apiPort,pgPort])if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Ports must be integers 1024..65535');
 if(apiPort===pgPort)throw new Error('API and PostgreSQL ports must differ');
 for(const exe of ['initdb.exe','pg_ctl.exe'])if(!existsSync(join(postgresBin,exe)))throw new Error('Provide an existing Windows PostgreSQL bin directory');
 const project=JSON.parse(readFileSync(join(root,'project.config.json'),'utf8'));
 if(project.compileType!=='miniprogram'||project.miniprogramRoot!=='miniprogram/'||project.setting.urlCheck!==true)throw new Error('Shared native project must retain domain validation');
 const runtime=readFileSync(join(root,'miniprogram/config/runtime.js'),'utf8').replace(/\r\n/g,'\n');
 if(runtime!=="// Shared source always has networking disabled. Local preparation writes only an ignored copy.\nmodule.exports = { mode: 'disabled', apiBaseUrl: '' }\n")throw new Error('Shared runtime must remain disabled');
 const out=join(root,'.local/local-dev');if(existsSync(out))throw new Error('Output exists; preserve it or use its existing start/stop scripts');
 mkdirSync(out,{recursive:true});
 for(const file of ['start.ps1','stop.ps1','database.mjs','api.mjs','smoke.mjs'])copyFileSync(join(root,'tools/local-dev',file),join(out,file));
 writeFileSync(join(out,'settings.json'),JSON.stringify({repoRoot:root,postgresBin,nodePath:process.execPath,apiPort,pgPort},null,2));
 const wechat=join(out,'wechat');mkdirSync(wechat);
 function copy(source,target,relative=''){
  for(const entry of readdirSync(source,{withFileTypes:true})){
   const rel=relative?relative+'/'+entry.name:entry.name;
   if(entry.name.startsWith('.')||entry.name==='node_modules'||/private|credential|secret|\.local\./i.test(entry.name))continue;
   const from=join(source,entry.name),to=join(target,entry.name);
   if(lstatSync(from).isSymbolicLink())throw new Error('Local package refuses symbolic links');
   if(entry.isDirectory()){mkdirSync(to,{recursive:true});copy(from,to,rel);}
   else if(/\.(js|json|wxml|wxss|png|svg|jpg|jpeg|webp)$/.test(entry.name)){mkdirSync(dirname(to),{recursive:true});copyFileSync(from,to);}
  }
 }
 copy(join(root,'miniprogram'),join(wechat,'miniprogram'));
 project.projectname='GengYun-Local-Synthetic';project.description='本地联调：真实 PostgreSQL，合成微信身份；非发布版本。';
 writeFileSync(join(wechat,'project.config.json'),JSON.stringify(project,null,2));
 writeFileSync(join(wechat,'project.private.config.json'),JSON.stringify({projectname:project.projectname,setting:{urlCheck:false}},null,2));
 writeFileSync(join(wechat,'miniprogram/config/runtime.js'),"module.exports="+JSON.stringify({mode:'local',apiBaseUrl:`http://127.0.0.1:${apiPort}/api/v1`})+'\n');
 function edit(file,changes){const path=join(wechat,'miniprogram',file);let text=readFileSync(path,'utf8');for(const [a,b] of changes)text=text.replace(a,b);writeFileSync(path,text);}
 edit('utils/debug.js',[["runtime.apiBaseUrl + '/__local__/status'",`'http://127.0.0.1:${apiPort}/__local__/status'`],['本地替身连接成功；登录、数据库、AI及业务均未接入。','本地 API 与 PostgreSQL 已连接；微信身份为合成测试，AI 未接入。']]);
 edit('pages/home/home.js',[['开发准备工程：','本地联调（合成微信身份，真实 PostgreSQL）：']]);
 edit('pages/login/login.js',[['登录成功。','本地合成身份登录成功。']]);
 return out;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const args=process.argv.slice(2),options={root:resolve(dirname(fileURLToPath(import.meta.url)),'../..')};
  const fields={'--pg-bin':'postgresBin','--api-port':'apiPort','--pg-port':'pgPort'};
  for(let i=0;i<args.length;i+=2){if(!fields[args[i]]||args[i+1]===undefined)throw new Error('Usage: --pg-bin <Windows PG bin> [--api-port <port>] [--pg-port <port>]');options[fields[args[i]]]=args[i]==='--pg-bin'?args[i+1]:Number(args[i+1]);}
  if(!options.postgresBin)throw new Error('Missing --pg-bin');
  console.log('Prepared isolated local environment: '+prepareLocalDev(options));
 }catch(error){console.error(error.message);process.exitCode=1;}
}
