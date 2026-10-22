import {readFileSync,readdirSync,existsSync,realpathSync} from 'node:fs';
import {resolve,join,dirname,relative} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

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
  env,input:JSON.stringify(operations),encoding:'utf8',timeout:15000,windowsHide:true,stdio:['pipe','pipe','pipe']});
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

// ── 锚点自动重定位（--reanchor）的纯文本层 ───────────────────────────────────────
// 给定「锚点文本在文件里的命中行」，求出可复现的归属块 `start-end`，用来改写台账里的 lines。
// 口径（可复现；改口径必须同步 docs/verification/gy-r31-reanchor-*.md）：
//  1) 从命中行向上（含命中行自身）找最近的「声明行」：function / class / interface / type /
//     `const|let|var X =` / `xxx.<verb>(` 路由注册 / 对象与类方法 `async name(`。
//  2) 声明行必须带块体：声明行之后、遇到「括号深度 0 的 `;`」之前出现 `{`；否则不算块声明
//     （`const x = 1;`、`foo(a);` 这类没有块体，继续向上找）。
//  3) 从该 `{` 起按花括号深度配到结束行；字符串、模板（含 ${...} 插值）与注释都跳过。
//  4) 块必须覆盖命中行；覆盖不了就继续向上找。
//  5) 一路找不到就退化为「命中行 ±0 的单行」并标 fallback，报告里必须可见（不许假装定位到了）。
// 不认正则字面量里的花括号：`/^\d{2}$/` 这类配平量词无影响；真出现不配平的花括号 → 配对失败 → FALLBACK，宁可不猜。
const DECLARATION_KEYWORDS=new Set(['if','for','while','switch','catch','return','typeof','await','new','delete','void','throw','yield','else','do','try','with']);
const DECLARATION_PATTERNS=[
 /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\b/,
 /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+[A-Za-z_$]/,
 /^(?:export\s+)?(?:declare\s+)?(?:interface|type)\s+[A-Za-z_$]/,
 /^(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*(?::|=)/,
 /^[A-Za-z_$][\w$]*\s*\.\s*(?:get|post|put|patch|delete|head|options)\s*\(/,
];
const METHOD_DECLARATION=/^(?:(?:public|private|protected|static|readonly|async|get|set|declare)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/;

export function isDeclarationLine(line){
 const trimmed=String(line).trim();
 if(DECLARATION_PATTERNS.some(pattern=>pattern.test(trimmed)))return true;
 const match=METHOD_DECLARATION.exec(trimmed);
 return match!==null&&!DECLARATION_KEYWORDS.has(match[1]);
}

const skipLineComment=(text,start)=>{const end=text.indexOf('\n',start);return end<0?text.length:end;};
const skipBlockComment=(text,start)=>{const end=text.indexOf('*/',start+2);return end<0?text.length:end+2;};
function skipQuoted(text,start,quote){
 let index=start+1;
 while(index<text.length){
  const char=text[index];
  if(char==='\\'){index+=2;continue;}
  if(char===quote)return index+1;
  if(char==='\n')return index; // 未闭合的单行字符串：就地止损，不吞掉后面的代码
  index+=1;
 }
 return index;
}
function skipInterpolation(text,start){
 let index=start,depth=1;
 while(index<text.length){
  const char=text[index];
  if(char==='"'||char==="'"){index=skipQuoted(text,index,char);continue;}
  if(char==='`'){index=skipTemplate(text,index);continue;}
  if(char==='/'&&text[index+1]==='/'){index=skipLineComment(text,index);continue;}
  if(char==='/'&&text[index+1]==='*'){index=skipBlockComment(text,index);continue;}
  if(char==='{')depth+=1;
  else if(char==='}'){depth-=1;if(depth===0)return index+1;}
  index+=1;
 }
 return index;
}
function skipTemplate(text,start){
 let index=start+1;
 while(index<text.length){
  const char=text[index];
  if(char==='\\'){index+=2;continue;}
  if(char==='`')return index+1;
  if(char==='$'&&text[index+1]==='{'){index=skipInterpolation(text,index+2);continue;}
  index+=1;
 }
 return index;
}

/** End index of the brace block opening at openIndex, or -1 when it never closes. */
export function braceBlockEnd(text,openIndex){
 let index=openIndex,depth=0;
 while(index<text.length){
  const char=text[index];
  if(char==='"'||char==="'"){index=skipQuoted(text,index,char);continue;}
  if(char==='`'){index=skipTemplate(text,index);continue;}
  if(char==='/'&&text[index+1]==='/'){index=skipLineComment(text,index);continue;}
  if(char==='/'&&text[index+1]==='*'){index=skipBlockComment(text,index);continue;}
  if(char==='{'){depth+=1;index+=1;continue;}
  if(char==='}'){depth-=1;index+=1;if(depth===0)return index-1;continue;}
  index+=1;
 }
 return -1;
}

/** Index of the block body `{` that belongs to a declaration line, or -1 for a body-less line. */
function blockBodyIndex(text,lineStart){
 let index=lineStart,paren=0,lineBreaks=0;
 while(index<text.length&&lineBreaks<=20){
  const char=text[index];
  if(char==='\n'){lineBreaks+=1;index+=1;continue;}
  if(char==='"'||char==="'"){index=skipQuoted(text,index,char);continue;}
  if(char==='`'){index=skipTemplate(text,index);continue;}
  if(char==='/'&&text[index+1]==='/'){index=skipLineComment(text,index);continue;}
  if(char==='/'&&text[index+1]==='*'){index=skipBlockComment(text,index);continue;}
  if(char==='('||char==='['){paren+=1;index+=1;continue;}
  if(char===')'||char===']'){if(paren>0)paren-=1;index+=1;continue;}
  if(char===';'&&paren<=0)return -1; // 先遇到语句结束：这条声明没有块体
  if(char==='{')return index;
  index+=1;
 }
 return -1;
}

/** Enclosing declaration block `{start,end,fallback}` of a 1-based hit line. */
export function enclosingBlock(text,hitLine){
 const lines=text.split('\n'),starts=[];
 let offset=0;
 for(const line of lines){starts.push(offset);offset+=line.length+1;}
 const lineAt=number=>String(lines[number-1]??'').replace(/\r$/,'');
 for(let current=Math.min(hitLine,lines.length);current>=1;current-=1){
  if(!isDeclarationLine(lineAt(current)))continue;
  const open=blockBodyIndex(text,starts[current-1]);
  if(open<0)continue;
  const close=braceBlockEnd(text,open);
  if(close<0)continue;
  const endLine=text.slice(0,close).split('\n').length;
  if(endLine<hitLine)continue; // 块在命中行之前就结束了，不是归属块
  return {start:current,end:endLine,fallback:false};
 }
 return {start:hitLine,end:hitLine,fallback:true};
}

export function renderStatusTables(status){
 const cell=value=>String(value).replaceAll('|','\\|').replace(/\r?\n/g,' ');
 const evidence=list=>list.map(item=>item.test?`${item.test}${item.name?'::'+item.name:''}`:`${item.path}${item.lines?':'+item.lines:''}`).join('；');
 const rows=list=>list.map(e=>`| \`${e.id}\` | ${e.method.toUpperCase()} ${e.path} | \`${e.status}\` | ${cell(evidence(e.evidence))||'—'} | ${cell(e.blocker)} |`).join('\n');
 const header='| 操作 id | 方法与路径 | 状态 | 证据 | 缺口 / 条件 |\n| --- | --- | --- | --- | --- |';
 const mounted=status.operations.filter(e=>e.route_mounted),unmounted=status.operations.filter(e=>!e.route_mounted);
 const counts=list=>['implemented','partial','planned'].map(s=>list.filter(e=>e.status===s).length);
 const dimensions=status.dimensions.map(d=>`| ${cell(d.title)} | ${cell(d.source_anchor)} | \`${d.status}\` | ${cell(evidence(d.evidence))||'—'} | ${cell(d.blocker)} |`).join('\n');
 return `${TABLE_START}\n## 2 横切约定\n\n| 维度 | 来源锚点 | 状态 | 证据 | 缺口 / 条件 |\n| --- | --- | --- | --- | --- |\n${dimensions}\n\n## 3 已装配操作（${mounted.length} 条）\n\n装配只表示存在产品路由；请同时读状态和限制。\n\n${header}\n${rows(mounted)}\n\n## 4 未装配操作（${unmounted.length} 条）\n\n以下 HTTP 路径当前返回 NOT_FOUND；partial 项只有独立服务 / 参考组件，不能直接调用这些 HTTP 接口。\n\n${header}\n${rows(unmounted)}\n\n## 5 计数\n\n| 范围 | implemented | partial | planned | 合计 |\n| --- | --- | --- | --- | --- |\n| 契约操作 | ${counts(status.operations).join(' | ')} | ${status.operations.length} |\n| 横切维度 | ${counts(status.dimensions).join(' | ')} | ${status.dimensions.length} |\n${TABLE_END}`;
}
