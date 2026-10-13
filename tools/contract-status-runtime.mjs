import {readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {operationKey} from './contract-status-core.mjs';
const root=resolve(process.argv[2]);
const operations=JSON.parse(readFileSync(0,'utf8'));
const {buildApp}=await import(pathToFileURL(join(root,'services/api/src/app.ts')));
const {loadConfig}=await import(pathToFileURL(join(root,'services/api/src/config.ts')));
const app=buildApp({config:loadConfig({APP_EXECUTION_MODE:'stub',LOG_LEVEL:'silent'})});
try{
 await app.ready();
 const mounted=operations.filter(op=>app.hasRoute({method:op.method.toUpperCase(),url:'/api/v1'+op.path.replace(/\{([^}]+)\}/g,':$1')}));
 process.stdout.write(JSON.stringify(mounted.map(op=>operationKey(op.method,op.path))));
}finally{await app.close();}
