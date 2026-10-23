import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parsePrintRoutes} from './openapi-route-parity.mjs';
// 只做「已挂载路由表」盘点：不监听端口、不连库、不读密钥，口径见 openapi-route-parity.mjs。
// 清单来自 Fastify 公共 API，逐条用 app.hasRoute 复核；解析不动的行直接抛错，避免静默少算。
const root=resolve(process.argv[2]);
const {buildApp}=await import(pathToFileURL(join(root,'services/api/src/app.ts')));
const {loadConfig}=await import(pathToFileURL(join(root,'services/api/src/config.ts')));
const app=buildApp({config:loadConfig({APP_EXECUTION_MODE:'stub',LOG_LEVEL:'silent'})});
try{
 await app.ready();
 const parsed=parsePrintRoutes(app.printRoutes({commonPrefix:false}));
 const unverified=parsed.filter(route=>!app.hasRoute({method:route.method,url:route.url}));
 if(unverified.length)throw Error(`printRoutes 解析出的路由未被 app.hasRoute 确认：${JSON.stringify(unverified)}`);
 process.stdout.write(JSON.stringify(parsed.filter(route=>route.method!=='HEAD').map(route=>({method:route.method,url:route.url}))));
}finally{await app.close();}
