import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
// GY-I07（#7）：本地联调（stub）显式放行「浙江首批真实资料（未发布/未核对）」并入
// /knowledge 读取面。**必须显式**：这批条目 visibility='private'、review_status='unverified'，
// 逐条仍如实标注「未核对」，且只在非 real 执行模式生效（real 模式装配层硬拒）。
process.env.APP_KNOWLEDGE_UNVERIFIED_SEED='1';
const settings=JSON.parse(readFileSync(new URL('./settings.json',import.meta.url),'utf8'));
const {buildApp}=await import(pathToFileURL(settings.repoRoot+'/services/api/src/app.ts'));
const {loadConfig}=await import(pathToFileURL(settings.repoRoot+'/services/api/src/config.ts'));
const {createPool}=await import(pathToFileURL(settings.repoRoot+'/services/api/src/db/pool.ts'));
const privateConfig=JSON.parse(readFileSync(new URL('./private/config.json',import.meta.url),'utf8'));
const config=loadConfig({APP_EXECUTION_MODE:'stub',DATABASE_URL:'postgres://gengyun_local_runtime:'+privateConfig.runtimePassword+'@127.0.0.1:'+settings.pgPort+'/gengyun_local_dev',API_HOST:'127.0.0.1',API_PORT:String(settings.apiPort),LOG_LEVEL:'silent'});
const pool=createPool(config.databaseUrl);
const app=buildApp({config,pool});
app.get('/__local__/status',async()=>({execution_mode:'local_stub',synthetic:true,service:'gengyun-local-diagnostic',database:'postgresql',wechat_identity:'synthetic',profile_catalog:'synthetic-local-fixture'}));
await app.listen({host:config.host,port:config.port});
console.log('Local API ready: http://127.0.0.1:'+settings.apiPort+'; real PostgreSQL; synthetic WeChat identity.');
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await app.close();await pool.end();process.exit(0);});
