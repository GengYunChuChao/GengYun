import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const root=resolve(import.meta.dirname,'../..');
const crop=[{id:'crop_rice',name:'水稻'}];
const regions=[{code:'330000',name:'浙江省',parent_code:null,catalog_version:'v1'},{code:'330100',name:'杭州市',parent_code:'330000',catalog_version:'v1'},{code:'330102',name:'上城区',parent_code:'330100',catalog_version:'v1'}];
const profile=(revision=1)=>({crop_id:null,region_code:null,region_catalog_version:null,revision});
const saved=(revision=2)=>({crop_id:'crop_rice',region_code:'330102',region_catalog_version:'v1',revision});
const flush=()=>new Promise(r=>setImmediate(r));
function fixture() {
 const storage=new Map(),requests=[],routes=[],cache=new Map();let page;
 const wx={getStorageSync:k=>storage.get(k),setStorageSync:(k,v)=>storage.set(k,v),removeStorageSync:k=>storage.delete(k),request:o=>requests.push(o),showModal:o=>o.success({confirm:true}),reLaunch:o=>routes.push(o.url),navigateTo:o=>routes.push(o.url),showToast:()=>{}};
 function load(path) { path=resolve(path);if(path.endsWith('runtime.js'))return {mode:'local',apiBaseUrl:'http://127.0.0.1:1234/api/v1'};if(cache.has(path))return cache.get(path).exports;
 const m={exports:{}};cache.set(path,m);vm.runInNewContext('(function(require,module){'+readFileSync(path,'utf8')+'\n})',{wx,Page:d=>{page={...d,data:structuredClone(d.data),route:'pages/profile/profile',options:{},setData(p){Object.assign(this.data,p)}}},getCurrentPages:()=>[page]})((id)=>load(resolve(dirname(path),id+'.js')),m);return m.exports; }
 const auth=load(root+'/miniprogram/utils/auth.js');load(root+'/miniprogram/pages/profile/profile.js');
 function seed(token='synthetic-a'){auth.setSession({accessToken:token,audience:'user',expiresAt:new Date(Date.now()+3600000).toISOString(),executionMode:'stub'});}
 function answer(req,data,statusCode=200){req.success({statusCode,data:statusCode===200?{data}:{error:{code:data}}});}
 function last(path){return requests.filter(r=>new URL(r.url).pathname.endsWith(path)).at(-1);}
 async function ready(p=profile()) {seed();page.onShow();answer(last('/auth/session'),{audience:'user',expires_at:new Date(Date.now()+3600000).toISOString()});answer(last('/me/profile'),p);answer(last('/catalog/crops'),{items:crop,next_cursor:null});answer(last('/catalog/regions'),{items:regions,next_cursor:null});await flush();}
 function choose(){page.onEdit();page.onCrop({detail:{value:'0'}});page.onCity({detail:{value:'0'}});page.onCounty({detail:{value:'0'}});}
 return {page,auth,wx,requests,routes,answer,last,seed,ready,choose};
}
test('actual profile page reads complete cursor catalog, selects and freezes one save, then rereads',async()=>{
 const f=fixture();f.seed();f.page.onShow();f.answer(f.last('/auth/session'),{audience:'user',expires_at:new Date(Date.now()+3600000).toISOString()});f.answer(f.last('/me/profile'),profile());f.answer(f.last('/catalog/crops'),{items:crop,next_cursor:null});f.answer(f.last('/catalog/regions'),{items:regions.slice(0,2),next_cursor:'opaque.cursor'});await flush();assert.match(f.last('/catalog/regions').url,/cursor=opaque.cursor/);assert.equal(f.page.data.loaded,false);f.answer(f.last('/catalog/regions'),{items:regions.slice(2),next_cursor:null});await flush();f.choose();f.page.onSave();f.page.onSave();const put=f.last('/me/profile');assert.equal(put.method,'PUT');assert.deepEqual(JSON.parse(JSON.stringify(put.data)),{crop_id:'crop_rice',region_code:'330102',region_catalog_version:'v1'});assert.equal(put.header['If-Match'],'"1"');assert.ok(put.header['Idempotency-Key'].length>=8);assert.equal(f.requests.filter(r=>r.method==='PUT').length,1);f.answer(put,saved());await flush();assert.equal(f.last('/me/profile').method,'GET');f.answer(f.last('/me/profile'),saved(3));await flush();assert.equal(f.page.data.profile.revision,3);assert.equal(f.page.data.cropName,'水稻');assert.equal(f.page.data.regionName,'上城区');f.page.openReference();assert.equal(f.routes.at(-1),'/pages/reference/reference?crop_id=crop_rice&region_code=330102');
});
test('expired catalog cursor discards partial directory and explicit reload starts a fresh chain without clearing login',async()=>{
 const f=fixture();f.seed();f.page.onShow();
 f.answer(f.last('/auth/session'),{audience:'user',expires_at:new Date(Date.now()+3600000).toISOString()});
 f.answer(f.last('/me/profile'),profile());f.answer(f.last('/catalog/crops'),{items:crop,next_cursor:null});
 f.answer(f.last('/catalog/regions'),{items:regions.slice(0,2),next_cursor:'expired.opaque'});await flush();
 assert.match(f.last('/catalog/regions').url,/cursor=expired.opaque/);
 f.answer(f.last('/catalog/regions'),'INVALID_CURSOR',400);await flush();
 assert.equal(f.auth.isLoggedIn(),true);assert.equal(f.page.data.guest,false);
 assert.equal(f.page.data.loaded,false);assert.equal(f.page.data.busy,false);assert.equal(f.page.data.needsReload,true);
 assert.equal(f.page.data.crops.length,0);assert.equal(f.page.data.regions.length,0);assert.equal(f.page.data.profile,null);
 assert.match(f.page.data.message,/重新读取/);
 const count=f.requests.length;await flush();assert.equal(f.requests.length,count,'no automatic retry loop');
 f.page.onEdit();f.page.onSave();assert.equal(f.requests.filter(r=>r.method==='PUT').length,0);
 f.page.loadProfile();assert.equal(new URL(f.last('/catalog/regions').url).searchParams.has('cursor'),false);
 f.answer(f.last('/me/profile'),profile());f.answer(f.last('/catalog/crops'),{items:crop,next_cursor:null});
 f.answer(f.last('/catalog/regions'),{items:regions,next_cursor:null});await flush();
 assert.equal(f.page.data.loaded,true);assert.equal(f.page.data.needsReload,false);assert.equal(f.auth.isLoggedIn(),true);
});
test('uncertain save retries identical key/body/version, locks edits, and never repeats automatically',async()=>{const f=fixture();await f.ready();f.choose();f.page.onSave();const first=f.last('/me/profile');first.fail({});await flush();assert.equal(f.page.data.retryPending,true);f.page.onCity({detail:{value:-1}});assert.equal(f.page.data.cityIndex,0);assert.equal(f.requests.filter(r=>r.method==='PUT').length,1);f.page.onSave();const retry=f.last('/me/profile');assert.deepEqual(retry.header,first.header);assert.deepEqual(retry.data,first.data);});
test('revision conflict blocks overwrite until explicit reread and fresh confirmation',async()=>{const f=fixture();await f.ready();f.choose();f.page.onSave();f.answer(f.last('/me/profile'),'REVISION_CONFLICT',409);await flush();assert.equal(f.page.data.needsReload,true);f.page.onSave();assert.equal(f.requests.filter(r=>r.method==='PUT').length,1);f.page.loadProfile();f.answer(f.last('/me/profile'),saved(4));f.answer(f.last('/catalog/crops'),{items:crop,next_cursor:null});f.answer(f.last('/catalog/regions'),{items:regions,next_cursor:null});await flush();f.page.onEdit();f.page.onSave();assert.equal(f.last('/me/profile').header['If-Match'],'"4"');});
for(const event of ['hide','switch','logout'])test('old read/write cannot revive or transfer profile after '+event,async()=>{const f=fixture();await f.ready();f.choose();f.page.onSave();const old=f.last('/me/profile');if(event==='hide')f.page.onHide();else if(event==='logout')f.page.logout();else f.seed('synthetic-b');f.answer(old,saved());await flush();assert.equal(f.page.data.profile,null);assert.equal(f.page.data.guest,true);assert.equal(f.requests.filter(r=>r.method==='PUT').length,1);});
test('account switch before save cannot send former subject draft',async()=>{const f=fixture();await f.ready();f.choose();f.seed('synthetic-b');f.page.onSave();assert.equal(f.requests.filter(r=>r.method==='PUT').length,0);assert.equal(f.page.data.profile,null);});
test('same token after clear still invalidates previous request generation',async()=>{const f=fixture();await f.ready();f.choose();f.page.onSave();const old=f.last('/me/profile');f.auth.clearSession();f.seed('synthetic-a');f.answer(old,saved());await flush();assert.equal(f.page.data.profile,null);});
test('401 closes identity and starts real login gate, provider failure does not invent data',async()=>{const f=fixture();await f.ready();f.choose();f.page.onSave();f.answer(f.last('/me/profile'),'SESSION_EXPIRED',401);await flush();assert.equal(f.page.data.guest,true);assert.equal(f.page.data.profile,null);assert.equal(f.routes.at(-1),'/pages/login/login');});
test('empty catalog remains empty; repeated cursor is a visible error, not partial success',async()=>{const f=fixture();f.seed();f.page.onShow();f.answer(f.last('/auth/session'),{audience:'user',expires_at:new Date(Date.now()+3600000).toISOString()});f.answer(f.last('/me/profile'),profile());f.answer(f.last('/catalog/crops'),{items:[],next_cursor:null});f.answer(f.last('/catalog/regions'),{items:regions.slice(0,1),next_cursor:'repeat'});await flush();f.answer(f.last('/catalog/regions'),{items:regions.slice(1,2),next_cursor:'repeat'});await flush();assert.equal(f.page.data.loaded,false);assert.equal(f.page.data.regions.length,0);assert.ok(f.page.data.message);});
test('manual city selection is valid without any location authorization API',async()=>{const f=fixture();await f.ready();f.page.onEdit();f.page.onCrop({detail:{value:0}});f.page.onCity({detail:{value:0}});f.page.onSave();assert.equal(f.last('/me/profile').data.region_code,'330100');assert.equal('getLocation' in f.wx,false);});

// —— GY-I05 收尾（Refs #5）：定位只即时选地区，五类失败分支都保留手选，坐标不出内存 ——
// 合成哨兵值，不是任何真实位置；仅用于证明坐标不进入页面状态/存储/请求。
const sentinel={latitude:123.4567,longitude:89.0123};
for(const [label,errMsg,expected] of [['授权被拒绝','getLocation:fail auth deny','未获得定位授权'],['用户取消','getLocation:fail cancel','已取消定位'],['定位超时','getLocation:fail timeout','定位超时'],['平台未声明隐私接口','getLocation:fail the api need to be declared in the requiredPrivateInfos field in app.json','定位不可用或平台不支持']])
test('location '+label+' keeps manual selection and never sends coordinates',async()=>{
 const f=fixture();await f.ready();f.wx.getLocation=o=>o.fail({errMsg});
 f.page.onEdit();f.page.onLocate();await flush();
 assert.ok(f.page.data.message.includes(expected),f.page.data.message);
 assert.equal(f.page.data.editing,true);assert.equal(f.page.data.locating,false);
 f.page.onCrop({detail:{value:'0'}});f.page.onCity({detail:{value:'0'}});f.page.onCounty({detail:{value:'0'}});f.page.onSave();
 const put=f.last('/me/profile');assert.equal(put.method,'PUT');
 assert.deepEqual(JSON.parse(JSON.stringify(put.data)),{crop_id:'crop_rice',region_code:'330102',region_catalog_version:'v1'});
 assert.deepEqual(Object.keys(put.data).sort(),['crop_id','region_catalog_version','region_code']);
 assert.equal(JSON.stringify(f.requests).includes('123.4567'),false);
 assert.equal('startLocationUpdate' in f.wx,false);assert.equal('onLocationChange' in f.wx,false);
});
test('location without a conversion resource falls back to manual selection and stores/returns no coordinates',async()=>{
 const f=fixture();await f.ready();const writes=[];const raw=f.wx.setStorageSync;f.wx.setStorageSync=(k,v)=>{writes.push([k,v]);return raw(k,v)};
 f.wx.getLocation=o=>o.success(sentinel);f.page.onEdit();f.page.onLocate();await flush();
 assert.ok(f.page.data.message.includes('地区转换资源尚未接入'),f.page.data.message);
 assert.equal(f.page.data.editing,true);assert.equal(f.page.data.locating,false);
 assert.equal(JSON.stringify(f.page.data).includes('123.4567'),false);
 assert.equal(JSON.stringify(writes).includes('123.4567'),false);
 assert.equal(JSON.stringify(f.requests).includes('123.4567'),false);
 f.page.onCrop({detail:{value:'0'}});f.page.onCity({detail:{value:'0'}});f.page.onCounty({detail:{value:'0'}});f.page.onSave();
 assert.equal(f.last('/me/profile').data.region_code,'330102');
});
test('out-of-coverage and converter failure both keep the Zhejiang manual catalog usable',async()=>{
 const out=fixture();await out.ready();out.page.regionConverter=()=>null;out.wx.getLocation=o=>o.success(sentinel);
 out.page.onEdit();out.page.onLocate();await flush();
 assert.ok(out.page.data.message.includes('不在首版覆盖的浙江省'),out.page.data.message);assert.equal(out.page.data.editing,true);
 out.page.onCrop({detail:{value:'0'}});out.page.onCity({detail:{value:'0'}});out.page.onSave();
 assert.equal(out.last('/me/profile').data.region_code,'330100');
 const bad=fixture();await bad.ready();bad.page.regionConverter=()=>{throw new Error('synthetic converter failure')};bad.wx.getLocation=o=>o.success(sentinel);
 bad.page.onEdit();bad.page.onLocate();await flush();
 assert.ok(bad.page.data.message.includes('定位不可用或平台不支持'),bad.page.data.message);
 bad.page.onCrop({detail:{value:'0'}});bad.page.onCity({detail:{value:'0'}});bad.page.onSave();
 assert.equal(bad.last('/me/profile').data.region_code,'330100');
});
test('location preselects a Zhejiang county from the loaded catalog, then the user confirms exactly one save',async()=>{
 const f=fixture();await f.ready();const seen=[];
 f.page.regionConverter=(lat,lng)=>{seen.push([lat,lng]);return '330102'};f.wx.getLocation=o=>o.success(sentinel);
 f.page.onEdit();f.page.onLocate();await flush();
 assert.deepEqual(seen,[[sentinel.latitude,sentinel.longitude]]);
 assert.equal(f.page.data.cityIndex,0);assert.equal(f.page.data.countyIndex,0);assert.equal(f.page.data.counties[0].code,'330102');
 assert.equal(f.requests.filter(r=>r.method==='PUT').length,0);
 assert.equal(JSON.stringify(f.page.data).includes('123.4567'),false);
 f.page.onCrop({detail:{value:'0'}});f.page.onSave();f.page.onSave();
 const put=f.last('/me/profile');assert.equal(put.method,'PUT');
 assert.deepEqual(JSON.parse(JSON.stringify(put.data)),{crop_id:'crop_rice',region_code:'330102',region_catalog_version:'v1'});
 assert.equal(f.requests.filter(r=>r.method==='PUT').length,1);
 assert.equal(JSON.stringify(put.header).includes('123.4567'),false);
 assert.equal(new URL(put.url).pathname,'/api/v1/me/profile');
});
test('guest cannot edit, save or locate: zero writes, no location call, no identity or coordinate fields',async()=>{
 const f=fixture();let located=0;f.wx.getLocation=()=>{located++};
 f.page.onShow();await flush();
 assert.equal(f.page.data.guest,true);assert.equal(f.routes.at(-1),'/pages/login/login');
 f.page.onEdit();f.page.onSave();f.page.onLocate();await flush();
 assert.equal(located,0);assert.equal(f.page.data.editing,false);
 assert.equal(f.requests.filter(r=>r.method==='PUT').length,0);
 assert.equal(JSON.stringify(f.requests).includes('user_id'),false);
 assert.equal(/latitude|longitude|owner_id|role=/.test(JSON.stringify(f.requests.map(r=>r.url))),false);
});
test('location helper exposes no tracking API and returns only status/region code',async()=>{
 const locationRegion=createRequire(import.meta.url)(root+'/miniprogram/utils/location-region.js');
 const success=o=>o.success(sentinel);
 assert.deepEqual(JSON.parse(JSON.stringify(await locationRegion.locate({getLocation:success},()=>'330102'))),{status:'ok',region_code:'330102'});
 assert.deepEqual(JSON.parse(JSON.stringify(await locationRegion.locate({getLocation:success},()=>null))),{status:'out_of_coverage'});
 assert.deepEqual(JSON.parse(JSON.stringify(await locationRegion.locate({getLocation:success},()=>{throw new Error('x')}))),{status:'failed'});
 assert.deepEqual(JSON.parse(JSON.stringify(await locationRegion.locate({},()=>'330102'))),{status:'failed'});
 for(const name of ['startLocationUpdate','onLocationChange','startLocationUpdateBackground','chooseLocation'])assert.equal(typeof locationRegion[name],'undefined',name);
 assert.equal(JSON.stringify(locationRegion.MESSAGES).includes('预警'),false);
});

test('reference handoff preserves only existing crop/region conditions and refuses identity params',()=>{const f=fixture(); const navPath=root+'/miniprogram/utils/navigation.js';const m={exports:{}};vm.runInNewContext(readFileSync(navPath,'utf8'),{module:m});assert.equal(m.exports.normalizeTarget('/pages/reference/reference?crop_id=crop_rice&region_code=330102'),'/pages/reference/reference?crop_id=crop_rice&region_code=330102');for(const q of ['crop_id=crop_rice&region_code=330102&user_id=x','crop_id=crop_rice&region_code=440000','owner=x','redirect=http://evil'])assert.equal(m.exports.normalizeTarget('/pages/reference/reference?'+q),null)});

// —— GY-I05（#5）：错误码与前端交互一致（前端侧）。断言对象来自 **packages/contracts/states.json 的
// error_status_map**（契约闭集），不是手写清单；遍历整个闭集，确保每个契约错误码在页面上都有
// 明确的失败分支（可见文案或登录门），**绝不**被当成保存成功。
const contractStates=JSON.parse(readFileSync(root+'/packages/contracts/states.json','utf8'));
const contractOpenapi=JSON.parse(readFileSync(root+'/packages/contracts/openapi.json','utf8'));
test('every contract error code has a defined frontend failure branch (message or login gate), never success',async()=>{
 const pairs=Object.entries(contractStates.error_status_map).flatMap(([status,codes])=>codes.map(code=>[Number(status),code]));
 assert.deepEqual([...new Set(pairs.map(p=>p[1]))].sort(),[...contractOpenapi.components.schemas.ErrorCode.enum].sort(),
  '遍历对象必须就是契约闭集本身（states.error_status_map == openapi ErrorCode 枚举）');
 assert.ok(pairs.length>=20,`契约闭集解析到的错误码太少：${pairs.length}`);
 for(const [statusCode,code] of pairs){
  const f=fixture();await f.ready();f.choose();f.page.onSave();
  assert.equal(f.last('/me/profile').method,'PUT','保存请求未发出：'+code);
  f.answer(f.last('/me/profile'),code,statusCode);await flush();
  const redirected=f.routes.at(-1)==='/pages/login/login';
  const message=f.page.data.message;
  assert.ok(redirected||(typeof message==='string'&&message.length>0),`${statusCode} ${code} 没有给出任何用户可见的失败分支`);
  assert.ok(!(f.page.data.profile&&f.page.data.profile.revision>1),`${statusCode} ${code} 被当成保存成功并显示了新版本`);
  assert.equal(f.requests.filter(r=>r.method==='PUT').length,1,`${statusCode} ${code} 失败后重复提交`);
  assert.equal(f.requests.filter(r=>r.method==='GET'&&new URL(r.url).pathname.endsWith('/me/profile')).length,1,
   `${statusCode} ${code} 失败后仍走了成功路径的重新读取`);
 }
});
test('frontend profile message table only names contract error codes or codes the client itself raises',()=>{
 const source=readFileSync(root+'/miniprogram/pages/profile/profile.js','utf8');
 const table=/const messages = \{([\s\S]*?)\}/.exec(source);
 assert.ok(table,'profile.js 的文案表未解析到——正则失配必须失败，不得静默通过');
 const keys=[...table[1].matchAll(/([A-Z][A-Z0-9_]{3,})\s*:/g)].map(m=>m[1]);
 assert.ok(keys.length>=8,`文案表解析到的键太少：${JSON.stringify(keys)}`);
 assert.ok(keys.includes('PROVIDER_UNAVAILABLE'),'文案表解析结果自检失败');
 const contract=new Set(Object.values(contractStates.error_status_map).flat());
 const api=readFileSync(root+'/miniprogram/utils/profile-api.js','utf8');
 // 「客户端本地码」从客户端模块源码里取（形如 `failure('SESSION_CHANGED')` 或
 // `failure(current(b) ? 'NETWORK_UNCERTAIN' : 'SESSION_CHANGED')`），不手写第二份清单。
 const clientLocal=new Set([...api.matchAll(/'([A-Z][A-Z0-9_]{4,})'/g)].map(m=>m[1]));
 assert.ok(clientLocal.size>=3,`客户端本地码解析失败：${JSON.stringify([...clientLocal])}`);
 assert.ok(clientLocal.has('NETWORK_UNCERTAIN')&&clientLocal.has('SESSION_CHANGED'),'客户端本地码解析结果自检失败');
 for(const key of keys){
  assert.ok(contract.has(key)||clientLocal.has(key),`文案表的 ${key} 既不在契约闭集也不在客户端本地码（${JSON.stringify([...clientLocal])}）里`);
 }
 // 反向：契约闭集里本片会触达的错误码，前端要么有专文，要么走通用兜底——两者都必须是"非成功"文案。
 assert.ok(keys.includes('REVISION_CONFLICT')&&keys.includes('INVALID_CURSOR'),'契约错误码在前端文案表里缺失');
});

// —— GY-I05 真机走查缺陷（Refs #5）：「点『档案』没有任何反应」 ——
// 真机走查时 /me/profile 与 /catalog/* 全部 503（服务端未启用该接口）。改前：读取失败只落一行
// 灰色 hint，而**真正的入口**被 disabled 掉 ⇒ 点击既不进 handler、也没有任何可见变化。
// 本用例锁死修后口径：失败态可见（state-view error + 重试入口）+ 点击入口必有可见反馈。
const sessionBody=()=>({audience:'user',expires_at:new Date(Date.now()+3600000).toISOString()});
async function unavailableLoad(){
 const f=fixture();f.seed();f.page.onShow();
 f.answer(f.last('/auth/session'),sessionBody());
 f.answer(f.last('/me/profile'),'PROVIDER_UNAVAILABLE',503);
 f.answer(f.last('/catalog/crops'),'PROVIDER_UNAVAILABLE',503);
 f.answer(f.last('/catalog/regions'),'PROVIDER_UNAVAILABLE',503);
 await flush();return f;
}
test('GET /me/profile 503 时档案入口给出可见失败态与重试，不再点了没反应',async()=>{
 const f=await unavailableLoad();
 // 1) 不是游客态、也不是「待读取」静默占位：读取失败必须留下**可见失败态**
 assert.equal(f.page.data.guest,false,'会话已核实：本条复现的前提是登录态');
 assert.equal(f.page.data.loaded,false);assert.equal(f.page.data.busy,false);
 assert.equal(f.page.data.needsReload,true);
 assert.match(f.page.data.loadError,/档案暂时读取失败（服务端未启用该接口）/,'失败态文案必须如实说明服务端未启用该接口');
 assert.ok(f.page.data.message.length>0,'hint 行也不得为空');
 // 失败态由 state-view(status="error") 呈现，且自带重试入口（不是自写一行灰字）
 const wxml=readFileSync(root+'/miniprogram/pages/profile/profile.wxml','utf8');
 const failure=wxml.match(/<state-view\b[^>]*wx:if="\{\{loadError\}\}"[^>]*>/);
 assert.ok(failure,'失败态 state-view 未接线到 loadError——正则失配必须失败，不得静默通过');
 assert.match(failure[0],/status="error"/);
 assert.match(failure[0],/desc="\{\{loadError\}\}"/);
 assert.match(failure[0],/action-text="重试读取档案"/);
 assert.match(failure[0],/bind:action="loadProfile"/,'失败态必须带可用的重试入口');
 // 2) 点「档案编辑入口」必须有可见反馈（改前 onEdit 静默 return，data 一个字段都不变 ⇒ 真红）
 const before=JSON.stringify(f.page.data);
 f.page.onEdit();
 assert.notEqual(JSON.stringify(f.page.data),before,'点击档案入口后页面状态零变化 = 用户看到的「点了没反应」');
 assert.match(f.page.data.message,/还没有读取成功/);
 assert.equal(f.page.data.editing,false,'守卫不得放宽：读不到档案仍不得进入编辑');
 assert.equal(f.requests.filter(r=>r.method==='PUT').length,0);
 // 3) 依赖同一接口（GET /me/profile）的入口同样不得静默
 const routes=f.routes.length;
 f.page.openReference();
 assert.match(f.page.data.message,/还没有读取成功/);
 assert.equal(f.routes.length,routes,'档案未读取成功时不得跳转');
 // 4) 重试入口真的重发读取；改判 200 后失败态消失，档案可渲染、可编辑（与既有行为一致）
 f.page.loadProfile();
 f.answer(f.last('/me/profile'),{crop_id:'crop_rice',region_code:'330102',region_catalog_version:'v1',revision:1});
 f.answer(f.last('/catalog/crops'),{items:crop,next_cursor:null});
 f.answer(f.last('/catalog/regions'),{items:regions,next_cursor:null});
 await flush();
 assert.equal(f.page.data.loadError,'');assert.equal(f.page.data.loaded,true);assert.equal(f.page.data.needsReload,false);
 assert.equal(f.page.data.cropName,'水稻');assert.equal(f.page.data.regionName,'上城区');
 f.page.onEdit();assert.equal(f.page.data.editing,true);
});
test('档案入口的 disabled 只剩 busy：读取失败不得把入口禁成「点了没反应」（回归防线）',()=>{
 const wxml=readFileSync(root+'/miniprogram/pages/profile/profile.wxml','utf8');
 for(const handler of ['onEdit','openReference']){
  const button=new RegExp('<button[^>]*bindtap="'+handler+'"[^>]*>').exec(wxml);
  assert.ok(button,handler+' 入口按钮未找到——正则失配必须失败，不得静默通过');
  const disabled=/disabled="\{\{([^}]*)\}\}"/.exec(button[0]);
  assert.ok(disabled,handler+' 入口未声明 disabled');
  assert.equal(disabled[1].trim(),'busy',handler+' 入口只能因 busy 禁用；把 !loaded/needsReload 写进 disabled 会让失败态下的点击没有任何反馈');
 }
});
