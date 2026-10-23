import {readFileSync,readdirSync,existsSync,realpathSync} from 'node:fs';
import {resolve,join,dirname,relative} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
// 锚点归属块的提取器只有一份，在 tools/lib/anchor-resolve.mjs（`--reanchor` 与符号形态共用同一口径）。
// 本文件只负责台账扫描与对照表渲染，不再自带一套声明行/花括号判定。
import {locatorSpec} from './lib/anchor-resolve.mjs';

export const operationKey=(method,path)=>`${method.toLowerCase()} ${path}`;

// Preserve strings and line offsets while removing comment-only registrations.
function withoutComments(text){
 return text.replace(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\/\/[^\r\n]*|\/\*[\s\S]*?\*\/)/g,
  (match,quoted)=>quoted||match.replace(/[^\r\n]/g,' '));
}

/** Static declarations are a cross-check; runtime mode verifies actual Fastify registration. */
export function scanMountedRoutes(root){
 const appFile=join(root,'services/api/src/app.ts');
 const source=withoutComments(readFileSync(appFile,'utf8'));
 const imports=new Map();
 for(const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)){
  if(!match[2].startsWith('.'))continue;
  const path=resolve(dirname(appFile),match[2]);
  const names=match[1].split(',').map(s=>s.trim()).filter(s=>s.startsWith('register'));
  if(names.length)imports.set(path,names.map(s=>s.split(/\s+as\s+/)));
 }
 const routes=join(root,'services/api/src/routes');
 const files=new Set([...imports.keys(),...readdirSync(routes).filter(s=>s.endsWith('.ts')).map(s=>join(routes,s))]);
 const mounted=new Set(),locations=new Map(),unassembled=[];
 for(const file of files){
  if(!existsSync(file))continue;
  const text=withoutComments(readFileSync(file,'utf8'));
  const names=imports.get(file)||[];
  const assembled=names.some(([exported,alias])=>{
   const local=alias||exported;
   return new RegExp(`^\\s*${local}\\s*\\(\\s*app\\b`,'m').test(source);
  });
  const declarations=[...text.matchAll(/app\.(get|post|put|patch|delete)\(\s*[`']([^`']+)[`']/g)];
  if(!assembled){if(declarations.length)unassembled.push(relative(root,file).replaceAll('\\','/'));continue;}
  for(const match of declarations){
   let paths=[match[2].replaceAll('${API_PREFIX}','/api/v1')];
   if(paths[0].includes('${kind}'))paths=['crops','regions'].map(k=>paths[0].replaceAll('${kind}',k));
   for(const path of paths){
    if(path.includes('${'))throw Error('Unresolved route template: '+relative(root,file));
    const normalized=path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g,'{$1}');
    if(normalized==='/health')continue;
    if(!normalized.startsWith('/api/v1/'))throw Error('Unexpected non-contract route: '+normalized);
    const key=operationKey(match[1],normalized.slice('/api/v1'.length));
    mounted.add(key);
    const line=text.slice(0,match.index).split('\n').length;
    locations.set(key,{path:relative(root,file).replaceAll('\\','/'),lines:`${line}-${line+4}`});
   }
  }
 }
 return {mounted,locations,unassembled};
}

export function mountedMismatches(entries,mounted){
 return entries.flatMap(entry=>entry.route_mounted===mounted.has(operationKey(entry.method,entry.path))?[]:
  [`${operationKey(entry.method,entry.path)}: route_mounted=${entry.route_mounted}, actual=${mounted.has(operationKey(entry.method,entry.path))}`]);
}

/** No listener, HTTP request, DB, provider or inherited secret is needed. */
export function runtimeMountedRoutes(root,operations){
 const allowed=new Set(['systemroot','windir','path','temp','tmp','home','userprofile','appdata','localappdata','lang']);
 const env=Object.fromEntries(Object.entries(process.env).filter(([name])=>allowed.has(name.toLowerCase())));
 const output=execFileSync(process.execPath,[fileURLToPath(new URL('./contract-status-runtime.mjs',import.meta.url)),root],{
  env,input:JSON.stringify(operations),encoding:'utf8',timeout:runtimeTimeoutMs(),windowsHide:true,stdio:['pipe','pipe','pipe']});
 const data=JSON.parse(output);
 if(!Array.isArray(data)||data.some(k=>typeof k!=='string'))throw Error('Invalid runtime route inventory');
 return new Set(data);
}

export function evidenceWithinRepository(root,path){
 const absolute=resolve(root,path),inside=relative(root,absolute).replaceAll('\\','/');
 const safe=p=>p!==''&&!p.startsWith('../')&&!p.startsWith('/')&&!/^[A-Za-z]:/.test(p)&&
  !p.split('/').some(part=>['.git','.local','.supervisor','node_modules'].includes(part.toLowerCase())||/^\.env(?:\.|$)/i.test(part));
 if(!safe(inside))return false;
 return !existsSync(absolute)||safe(relative(realpathSync(root),realpathSync(absolute)).replaceAll('\\','/'));
}

/** Route declarations used by evidence semantic checks; unresolved templates are skipped, never thrown. */
export function routeDeclarations(text){
 const source=withoutComments(text),declarations=[];
 for(const match of source.matchAll(/app\.(get|post|put|patch|delete)\(\s*[`']([^`']+)[`']/g)){
  let paths=[match[2].replaceAll('${API_PREFIX}','/api/v1')];
  if(paths[0].includes('${kind}'))paths=['crops','regions'].map(kind=>paths[0].replaceAll('${kind}',kind));
  const line=source.slice(0,match.index).split('\n').length;
  for(const path of paths){
   if(path.includes('${'))continue;
   const normalized=path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g,'{$1}');
   if(normalized==='/health'||!normalized.startsWith('/api/v1/'))continue;
   declarations.push({method:match[1],path:normalized.slice('/api/v1'.length),line});
  }
 }
 const seen=new Set();
 return declarations.filter(entry=>{
  const key=`${entry.method} ${entry.path} ${entry.line}`;
  if(seen.has(key))return false;
  seen.add(key);
  return true;
 });
}

/** A registration block runs from its declaration line to the line before the next declaration, without trailing blanks. */
export function declarationSegments(text,declarations){
 const lines=text.split('\n'),byLine=new Map();
 for(const entry of declarations){
  const block=byLine.get(entry.line)??{line:entry.line,routes:[]};
  const key=operationKey(entry.method,entry.path);
  if(!block.routes.includes(key))block.routes.push(key);
  byLine.set(entry.line,block);
 }
 const blocks=[...byLine.values()].sort((left,right)=>left.line-right.line);
 return blocks.map((block,index)=>{
  let to=(blocks[index+1]?.line??lines.length+1)-1;
  while(to>block.line&&(lines[to-1]??'').trim()==='')to-=1;
  return {from:block.line,to,routes:block.routes};
 });
}

/** Character ranges of assertion-call arguments, used to prove a snippet was lifted from another operation's assertion. */
export function assertionArgumentRanges(text){
 const ranges=[];
 for(const match of text.matchAll(/\b(?:assert|expect)\b\s*(?:\.\s*[A-Za-z_$][\w$]*\s*)*/g)){
  let cursor=match.index+match[0].length,end=-1;
  while(true){
   const open=text.indexOf('(',cursor);
   if(open<0)break;
   let depth=0,closed=-1;
   for(let index=open;index<text.length;index+=1){
    const char=text[index];
    if(char==='"'||char==="'"||char==='`'){
     for(index+=1;index<text.length;index+=1){
      if(text[index]==='\\'){index+=1;continue;}
      if(text[index]===char)break;
     }
     continue;
    }
    if(char==='(')depth+=1;
    else if(char===')'){depth-=1;if(depth===0){closed=index;break;}}
   }
   if(closed<0)break;
   end=closed;
   const chained=/^\s*\.\s*[A-Za-z_$][\w$]*\s*/.exec(text.slice(closed+1));
   if(!chained)break;
   cursor=closed+1+chained[0].length;
  }
  if(end>=0)ranges.push([match.index,end]);
 }
 return ranges;
}

/** Contract operation ids mentioned by text, with identifier boundaries and camel/acronym variants (verifyOCR/verifyOcr). */
export function operationMentions(text,ids){
 return ids.filter(id=>{
  const acronym=id.replace(/([A-Z]+)(?=[A-Z][a-z]|$)/g,run=>run[0]+run.slice(1).toLowerCase());
  return [id,acronym].some(variant=>{
   const escaped=variant.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
   return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`,'i').test(text);
  });
 });
}

export const TABLE_START='<!-- contract-status-tables:start -->';
export const TABLE_END='<!-- contract-status-tables:end -->';

export function replaceStatusTables(document,status){
 const from=document.indexOf(TABLE_START),to=document.indexOf(TABLE_END);
 if(from<0||to<from||document.indexOf(TABLE_START,from+TABLE_START.length)>=0||document.indexOf(TABLE_END,to+TABLE_END.length)>=0){
  throw Error('对照文档必须包含唯一且成对的 contract-status-tables 标记');
 }
 return document.slice(0,from)+renderStatusTables(status)+document.slice(to+TABLE_END.length);
}

// 符号形态的定位器（形状校验在 verify-contract-status 里做；这里只取名字渲染，非法就当作没有）。
const locatorSymbol=item=>{const spec=locatorSpec(item);return spec.kind==='value'?spec.symbol:null;};

export function renderStatusTables(status){
 const cell=value=>String(value).replaceAll('|','\\|').replace(/\r?\n/g,' ');
 // 证据单元：用例名 `test::name`；文件引用带行号时 `path:起-止`；符号形态渲染成 `path#符号`。
 // 符号形态**不渲染解析出的行号**：那张表是逐字比对的门禁，写进去等于把行号漂移从台账搬进文档
 // （app.ts 每上移 10 行，中文对照表就假红一次，与本片要治的病相反）。当前行号在每次运行的
 // SYMBOL 输出行里给，证据页另记快照；渲染口径见 docs/verification/gy-r31-anchor-symbol-20261022.md。
 const evidence=list=>list.map(item=>item.test?`${item.test}${item.name?'::'+item.name:''}`:`${item.path}${item.lines?':'+item.lines:locatorSymbol(item)?'#'+locatorSymbol(item):''}`).join('；');
 const rows=list=>list.map(e=>`| \`${e.id}\` | ${e.method.toUpperCase()} ${e.path} | \`${e.status}\` | ${cell(evidence(e.evidence))||'—'} | ${cell(e.blocker)} |`).join('\n');
 const header='| 操作 id | 方法与路径 | 状态 | 证据 | 缺口 / 条件 |\n| --- | --- | --- | --- | --- |';
 const mounted=status.operations.filter(e=>e.route_mounted),unmounted=status.operations.filter(e=>!e.route_mounted);
 const counts=list=>['implemented','partial','planned'].map(s=>list.filter(e=>e.status===s).length);
 const dimensions=status.dimensions.map(d=>`| ${cell(d.title)} | ${cell(d.source_anchor)} | \`${d.status}\` | ${cell(evidence(d.evidence))||'—'} | ${cell(d.blocker)} |`).join('\n');
 return `${TABLE_START}\n## 2 横切约定\n\n| 维度 | 来源锚点 | 状态 | 证据 | 缺口 / 条件 |\n| --- | --- | --- | --- | --- |\n${dimensions}\n\n## 3 已装配操作（${mounted.length} 条）\n\n装配只表示存在产品路由；请同时读状态和限制。\n\n${header}\n${rows(mounted)}\n\n## 4 未装配操作（${unmounted.length} 条）\n\n以下 HTTP 路径当前返回 NOT_FOUND；partial 项只有独立服务 / 参考组件，不能直接调用这些 HTTP 接口。\n\n${header}\n${rows(unmounted)}\n\n## 5 计数\n\n| 范围 | implemented | partial | planned | 合计 |\n| --- | --- | --- | --- | --- |\n| 契约操作 | ${counts(status.operations).join(' | ')} | ${status.operations.length} |\n| 横切维度 | ${counts(status.dimensions).join(' | ')} | ${status.dimensions.length} |\n${TABLE_END}`;
}

// 子进程预算：本机实测冷启动 `contract-status-runtime.mjs`（加载 app.ts + buildApp + hasRoute）
// 单次 13.566s，旧值 15000 只剩 10% 余量；机器被并发占用时 execFileSync 直接 ETIMEDOUT，
// 把整片契约门禁（含 `tests/unit/contract-status-tool.test.mjs` 的运行时用例）一起打红。
export const DEFAULT_RUNTIME_TIMEOUT_MS=60000;

const TIMEOUT_ENV_NAME='GY_CONTRACT_STATUS_TIMEOUT_MS';

/** 预算可被 `GY_CONTRACT_STATUS_TIMEOUT_MS` 覆盖；非法值回退默认并在 stderr 说明，不抛栈。 */
export function runtimeTimeoutMs(env=process.env){
 const raw=env?.[TIMEOUT_ENV_NAME];
 if(raw===undefined||raw===null)return DEFAULT_RUNTIME_TIMEOUT_MS;
 const text=String(raw).trim();
 if(text==='')return DEFAULT_RUNTIME_TIMEOUT_MS;
 const value=Number(text);
 if(!/^\d+$/.test(text)||!Number.isSafeInteger(value)||value<=0){
  process.stderr.write(`contract-status: ${TIMEOUT_ENV_NAME}=${JSON.stringify(String(raw))} 非法（需正整数），回退默认 ${DEFAULT_RUNTIME_TIMEOUT_MS}ms\n`);
  return DEFAULT_RUNTIME_TIMEOUT_MS;
 }
 return value;
}
