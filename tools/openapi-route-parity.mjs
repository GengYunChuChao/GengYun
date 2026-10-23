import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {operationKey} from './contract-status-core.mjs';

// 「已挂载路由 × OpenAPI 契约 × 契约台账」三方对账的唯一口径。
// 现状：`tools/contract-status-runtime.mjs` 只做「契约 → 实现」单向确认（hasRoute），
// 反方向「实现里挂载的路由是否都进了契约」此前无人门禁 ⇒ 本文件补上，并作为契约测试的唯一数据源。
// 不改业务代码、不启监听端口、不连库：路由清单来自 Fastify 公共 API `app.printRoutes({commonPrefix:false})`，
// 逐条再用 `app.hasRoute` 复核，避免解析口径悄悄漂移。

export const DOC_PATH='docs/architecture/openapi-route-parity.md';
export const DOC_START='<!-- openapi-route-parity:start -->';
export const DOC_END='<!-- openapi-route-parity:end -->';

const METHODS=['get','post','put','patch','delete'];
// 契约 paths 只写后缀（`/public/home`），实现侧挂载在 `${API_PREFIX}` 之下；对账时统一补前缀。
export const API_PREFIX='/api/v1';

// 已挂载但不进业务契约的例外，必须写明依据；新增例外要在这张表里留痕，不许在测试里就地写死。
// 依据：services/api/src/routes/health.ts:1-4 —— `/health` 明确不属于 packages/contracts/openapi.json（只描述 /api/v1）。
export const MOUNTED_EXEMPTIONS=new Map([
 ['get /health','健康检查，`services/api/src/routes/health.ts:1-4` 明确排除在业务契约之外'],
]);

/**
 * 解析 `app.printRoutes({commonPrefix:false})` 的缩进树。
 * 片段形如 `│       └── /:id (GET, HEAD, PATCH, DELETE)`：层级由前导树线长度决定，末段括号里是方法。
 * 解析不动的行直接抛错（宁可红，也不静默少算路由）。
 */
export function parsePrintRoutes(text){
 const routes=[],stack=[];
 for(const line of text.split('\n')){
  if(!line.trim())continue;
  const marker=line.indexOf('── ');
  if(marker<0)throw Error(`无法解析 printRoutes 行：${JSON.stringify(line)}`);
  const glyph=line.lastIndexOf('├',marker)>=0?'├':'└';
  const depth=Math.floor(line.lastIndexOf(glyph,marker)/4);
  const body=line.slice(marker+3);
  const match=/^(.*?)(?:\s+\(([A-Z, ]+)\))?$/.exec(body);
  stack[depth]=(match[1]||'').trim();
  stack.length=depth+1;
  const methods=match[2]?match[2].split(',').map(segment=>segment.trim()).filter(Boolean):[];
  if(!methods.length)continue;
  const url=`/${stack.join('/')}`.replace(/\/+/g,'/');
  for(const method of methods)routes.push({method,url});
 }
 return routes;
}

/** 实现侧用 `:id`，契约侧用 `{id}`；对账前把实现侧统一成契约写法。 */
export function normalizeMountedUrl(url){
 return url.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g,'{$1}');
}

export function contractOperations(openapi){
 const operations=[];
 for(const [route,item] of Object.entries(openapi.paths||{})){
  for(const method of Object.keys(item)){
   if(!METHODS.includes(method))continue;
   operations.push({method,path:route,operationId:item[method].operationId});
  }
 }
 return operations;
}

export function ledgerIndex(ledger){
 const operations=Array.isArray(ledger)?ledger:(ledger.operations||[]);
 // 台账里的 `route` 是带 `/api/v1` 的实挂路径（`:id` 写法），`path` 是契约相对路径（`{id}` 写法）；
 // 统一归一到契约写法后对齐实现侧。
 return new Map(operations.map(entry=>[operationKey(entry.method,normalizeMountedUrl(entry.route||API_PREFIX+entry.path)),entry]));
}

/**
 * 无监听、无 HTTP、无 DB、无 provider、不继承密钥的运行时路由盘点。
 * 子进程用的环境变量白名单与 contract-status-runtime.mjs 同口径。
 */
export function mountInventory(root){
 const allowed=new Set(['systemroot','windir','path','temp','tmp','home','userprofile','appdata','localappdata','lang']);
 const env=Object.fromEntries(Object.entries(process.env).filter(([name])=>allowed.has(name.toLowerCase())));
 const output=execFileSync(process.execPath,[fileURLToPath(new URL('./openapi-route-inventory.mjs',import.meta.url)),root],{
  env,encoding:'utf8',timeout:60000,windowsHide:true,stdio:['ignore','pipe','pipe']});
 const data=JSON.parse(output);
 if(!Array.isArray(data))throw Error('运行时路由盘点返回值不是数组');
 for(const entry of data){
  if(typeof entry?.method!=='string'||typeof entry?.url!=='string')throw Error(`运行时路由盘点条目非法：${JSON.stringify(entry)}`);
 }
 return data.filter(entry=>entry.method!=='HEAD');
}

export function parityReport({mounted,openapi,ledger}){
 const operations=contractOperations(openapi);
 const entries=ledgerIndex(ledger);
 const contractKeys=new Set(operations.map(op=>operationKey(op.method,API_PREFIX+op.path)));
 const mountedKeys=new Map();
 for(const entry of mounted){
  const key=operationKey(entry.method,normalizeMountedUrl(entry.url));
  if(mountedKeys.has(key))throw Error(`实现侧出现重复挂载：${key}`);
  mountedKeys.set(key,entry);
 }
 const extra=[],exempt=[],missing=[],planned=[],ledgerDrift=[];
 for(const [key,entry] of mountedKeys){
  if(contractKeys.has(key))continue;
  if(MOUNTED_EXEMPTIONS.has(key))exempt.push({key,route:entry.url,reason:MOUNTED_EXEMPTIONS.get(key)});
  else extra.push({key,route:entry.url});
 }
 for(const op of operations){
  const key=operationKey(op.method,API_PREFIX+op.path);
  if(mountedKeys.has(key))continue;
  const entry=entries.get(key);
  if(entry?.route_mounted===false&&entry.status==='planned')planned.push({key,operationId:op.operationId,blocker:entry.blocker||''});
  else missing.push({key,operationId:op.operationId,ledger:entry?`route_mounted=${entry.route_mounted},status=${entry.status}`:'台账缺行'});
 }
 for(const [key,entry] of entries){
  const actual=mountedKeys.has(key);
  if(entry.route_mounted!==actual)ledgerDrift.push({key,ledger:entry.route_mounted,actual});
 }
 const rows=operations.map(op=>{
  const key=operationKey(op.method,API_PREFIX+op.path);
  const entry=entries.get(key);
  return {
   method:op.method.toUpperCase(),path:op.path,operationId:op.operationId||'',
   scope:entry?.scope||'',versionRequired:entry?.version_required===true,
   mounted:mountedKeys.has(key),status:entry?.status||'台账缺行',
  };
 }).sort((a,b)=>a.path===b.path?a.method.localeCompare(b.method):a.path.localeCompare(b.path));
 const mountedOnly=mounted
  .map(entry=>({method:entry.method.toUpperCase(),route:entry.url,key:operationKey(entry.method,normalizeMountedUrl(entry.url))}))
  .filter(entry=>!contractKeys.has(entry.key)&&!MOUNTED_EXEMPTIONS.has(entry.key))
  .sort((a,b)=>a.route.localeCompare(b.route)||a.method.localeCompare(b.method));
 return {
  counts:{
   mounted:mountedKeys.size,contract:operations.length,
   implemented:operations.filter(op=>mountedKeys.has(operationKey(op.method,API_PREFIX+op.path))).length,
   extra:extra.length,exempt:exempt.length,missing:missing.length,planned:planned.length,ledgerDrift:ledgerDrift.length,
  },
  extra,exempt,missing,planned,ledgerDrift,mountedOnly,rows,
 };
}

export function renderParityDoc(report,{contractVersion=''}={}){
 const {counts}=report;
 const lines=[];
 lines.push(DOC_START);
 lines.push('');
 lines.push(`契约版本：\`${contractVersion}\`；生成命令：\`node tools/openapi-route-parity.mjs --write-doc\`（勿手改本块）。`);
 lines.push('');
 lines.push('| 指标 | 读数 |');
 lines.push('| --- | --- |');
 lines.push(`| 已挂载路由（不含 HEAD） | ${counts.mounted} |`);
 lines.push(`| 契约操作（paths × method） | ${counts.contract} |`);
 lines.push(`| 实现 ∩ 契约 | ${counts.implemented} |`);
 lines.push(`| 多出（实现有、契约无） | ${counts.extra} |`);
 lines.push(`| 例外（实现有、契约按设计不含） | ${counts.exempt} |`);
 lines.push(`| 少掉（契约有、实现无，且台账未标 planned） | ${counts.missing} |`);
 lines.push(`| 未实现但台账已标 \`planned\` | ${counts.planned} |`);
 lines.push(`| 台账 \`route_mounted\` 与运行时不一致 | ${counts.ledgerDrift} |`);
 lines.push('');
 const section=(title,header,rows)=>{
  lines.push(`### ${title}`);
  lines.push('');
  if(!rows.length){lines.push('无。');lines.push('');return;}
  lines.push(`| ${header.join(' | ')} |`);
  lines.push(`| ${header.map(()=>'---').join(' | ')} |`);
  for(const row of rows)lines.push(`| ${row.join(' | ')} |`);
  lines.push('');
 };
 section('多出（实现有、契约无）',['方法','实现路由'],[
  ...report.mountedOnly.map(entry=>[entry.method,`\`${entry.route}\``]),
 ]);
 section('例外（实现有、契约按设计不含）',['方法','实现路由','依据'],[
  ...report.exempt.map(entry=>[entry.key.split(' ')[0].toUpperCase(),`\`${entry.route}\``,entry.reason]),
 ]);
 section('少掉（契约有、实现无）',['操作','operationId','台账'],[
  ...report.missing.map(entry=>[`\`${entry.key}\``,entry.operationId,entry.ledger]),
 ]);
 section('未实现但台账已标 planned',['操作','operationId','阻塞说明'],[
  ...report.planned.map(entry=>[`\`${entry.key}\``,entry.operationId,entry.blocker.replace(/\|/g,'\\|')]),
 ]);
 section('台账 route_mounted 与运行时不一致',['操作','台账','运行时'],[
  ...report.ledgerDrift.map(entry=>[`\`${entry.key}\``,String(entry.ledger),String(entry.actual)]),
 ]);
 lines.push('### 路由 × 契约对照表');
 lines.push('');
 lines.push('| 方法 | 契约路径 | operationId | scope | 版本头 | 已挂载 | 台账状态 | 对账 |');
 lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
 for(const row of report.rows){
  // 已挂载、但台账状态仍写 planned：`route_mounted` 与实况一致（所以 ledgerDrift 为 0），
  // 可状态本身和挂载矛盾。这行不能笼统写「一致」，否则台账里唯一自相矛盾的记录会被这张表洗白。
  const verdict=row.mounted
   ?(row.status==='planned'?'planned（台账 planned 但已挂载）':'一致')
   :(row.status==='planned'?'计划中':'缺失');
  lines.push(`| ${row.method} | \`${row.path}\` | ${row.operationId} | ${row.scope} | ${row.versionRequired?'需要':'不要求'} | ${row.mounted?'是':'否'} | ${row.status} | ${verdict} |`);
 }
 lines.push('');
 lines.push(DOC_END);
 return lines.join('\n');
}

export function readContractInputs(root){
 const openapi=JSON.parse(readFileSync(join(root,'packages/contracts/openapi.json'),'utf8'));
 const ledger=JSON.parse(readFileSync(join(root,'docs/architecture/contract-status.json'),'utf8'));
 return {openapi,ledger};
}

export function buildParityReport(root){
 const {openapi,ledger}=readContractInputs(root);
 return parityReport({mounted:mountInventory(root),openapi,ledger});
}

export function readDocBlock(root){
 const absolute=join(root,DOC_PATH);
 if(!existsSync(absolute))return null;
 const text=readFileSync(absolute,'utf8');
 const start=text.indexOf(DOC_START),end=text.indexOf(DOC_END);
 if(start<0||end<0)throw Error(`${DOC_PATH} 缺少 ${DOC_START}/${DOC_END} 标记`);
 return text.slice(start,end+DOC_END.length);
}

export function writeDoc(root,report){
 const {openapi}=readContractInputs(root);
 const block=renderParityDoc(report,{contractVersion:openapi.info?.version||''});
 const absolute=join(root,DOC_PATH);
 const header=[
  '# 路由 × OpenAPI 契约对照表',
  '',
  '本文件由 `node tools/openapi-route-parity.mjs --write-doc` 生成，**不要手改标记块内容**；',
  '`tests/contract/openapi-route-parity.test.mjs` 会比对标记块与重新生成的结果，漂移即红。',
  '',
  '数据来源三处：实现侧 `buildApp()` 后 `app.printRoutes({commonPrefix:false})`（逐条 `app.hasRoute` 复核）、',
  '契约侧 `packages/contracts/openapi.json`、台账侧 `docs/architecture/contract-status.json`。',
  '操作级证据与阻塞说明见 `docs/architecture/contract-implementation-status.md`。',
  '',
  '**口径局限**：本表只对账到**操作级**——method、path、operationId、2xx 响应存在性、台账 `planned` 状态；',
  '**字段级 schema 未纳入**：请求/响应体的字段、类型、必填与枚举差异不在本表判定范围内，以 `packages/contracts/openapi.json` 为准。',
  '',
 ].join('\n');
 writeFileSync(absolute,`${header}${block}\n`,'utf8');
 return absolute;
}

const invokedDirectly=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(invokedDirectly){
 const root=resolve(process.argv[2]&&!process.argv[2].startsWith('--')?process.argv[2]:join(fileURLToPath(new URL('..',import.meta.url))));
 const report=buildParityReport(root);
 if(process.argv.includes('--write-doc')){
  console.log(`已写入 ${writeDoc(root,report)}`);
 }else{
  console.log(JSON.stringify({counts:report.counts,extra:report.mountedOnly.map(entry=>entry.key),missing:report.missing.map(entry=>entry.key),ledgerDrift:report.ledgerDrift},null,2));
 }
 const failing=report.counts.extra+report.counts.missing+report.counts.ledgerDrift;
 // 例外数校验也要计入：例外表与实况不匹配（表里删了/漏了条目）时计数不会变红，
 // 只有 tests/contract 里那条 deepEqual 会红 ⇒ CLI 单独跑会给出假的 0。
 const exemptMismatch=report.counts.exempt!==MOUNTED_EXEMPTIONS.size;
 if(exemptMismatch)console.error(`例外数与 MOUNTED_EXEMPTIONS 不一致：实际例外 ${report.counts.exempt} / 例外表 ${MOUNTED_EXEMPTIONS.size}`);
 process.exit(failing===0&&!exemptMismatch?0:1);
}
