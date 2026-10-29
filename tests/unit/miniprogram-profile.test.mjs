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
// overrides：可选的「模块 id(绝对路径) -> 模块导出对象」替身表（GY-I05 D2 用）。默认 undefined ⇒
// 行为与改前逐字相同：全部走真实文件。仅用于在**不落地任何真实几何资源文件**的前提下，
// 证明「资源存在且校验通过 ⇒ 页面注入点自动接线」这条路径真的可达。
// globals：可选的「模块 id(绝对路径) -> 额外沙箱全局」表。沙箱原本只给 wx/Page/getCurrentPages，
// 没有 setTimeout；需要验证计时器兜底的用例在这里给对应模块注入可控计时器，其余模块不受影响。
function fixture(overrides, globals) {
 const extras=globals?Object.fromEntries(Object.entries(globals).map(([id,value])=>[resolve(id),value])):null;
 const storage=new Map(),requests=[],routes=[],cache=new Map();let page;
 const wx={getStorageSync:k=>storage.get(k),setStorageSync:(k,v)=>storage.set(k,v),removeStorageSync:k=>storage.delete(k),request:o=>requests.push(o),showModal:o=>o.success({confirm:true}),reLaunch:o=>routes.push(o.url),navigateTo:o=>routes.push(o.url),showToast:()=>{}};
 function load(path) { path=resolve(path);if(overrides&&Object.prototype.hasOwnProperty.call(overrides,path))return overrides[path];if(path.endsWith('runtime.js'))return {mode:'local',apiBaseUrl:'http://127.0.0.1:1234/api/v1'};if(cache.has(path))return cache.get(path).exports;
 const m={exports:{}};cache.set(path,m);vm.runInNewContext('(function(require,module){'+readFileSync(path,'utf8')+'\n})',Object.assign({wx,Page:d=>{page={...d,data:structuredClone(d.data),route:'pages/profile/profile',options:{},setData(p){Object.assign(this.data,p)}}},getCurrentPages:()=>[page]},(extras&&extras[path])||{}))((id)=>load(resolve(dirname(path),/\.js$/.test(id)?id:id+'.js')),m);return m.exports; }
 const auth=load(root+'/miniprogram/utils/auth.js');load(root+'/miniprogram/pages/profile/profile.js');
 function seed(token='synthetic-a'){auth.setSession({accessToken:token,audience:'user',expiresAt:new Date(Date.now()+3600000).toISOString(),executionMode:'stub'});}
 function answer(req,data,statusCode=200){req.success({statusCode,data:statusCode===200?{data}:{error:{code:data}}});}
 function last(path){return requests.filter(r=>new URL(r.url).pathname.endsWith(path)).at(-1);}
 async function ready(p=profile()) {seed();page.onShow();answer(last('/auth/session'),{audience:'user',expires_at:new Date(Date.now()+3600000).toISOString()});answer(last('/me/profile'),p);answer(last('/catalog/crops'),{items:crop,next_cursor:null});answer(last('/catalog/regions'),{items:regions,next_cursor:null});await flush();}
 function choose(){page.onEdit();page.onCrop({detail:{value:'0'}});page.onCity({detail:{value:'0'}});page.onCounty({detail:{value:'0'}});}
 return {page,auth,wx,requests,routes,answer,last,seed,ready,choose};
}
test('actual profile page reads complete cursor catalog, selects and freezes one save, then rereads',async()=>{
 const f=fixture();f.seed();f.page.onShow();f.answer(f.last('/auth/session'),{audience:'user',expires_at:new Date(Date.now()+3600000).toISOString()});f.answer(f.last('/me/profile'),profile());f.answer(f.last('/catalog/crops'),{items:crop,next_cursor:null});f.answer(f.last('/catalog/regions'),{items:regions.slice(0,2),next_cursor:'opaque.cursor'});await flush();assert.match(f.last('/catalog/regions').url,/cursor=opaque.cursor/);assert.equal(f.page.data.loaded,false);f.answer(f.last('/catalog/regions'),{items:regions.slice(2),next_cursor:null});await flush();f.choose();f.page.onSave();f.page.onSave();const put=f.last('/me/profile');assert.equal(put.method,'PUT');assert.deepEqual(JSON.parse(JSON.stringify(put.data)),{crop_id:'crop_rice',region_code:'330102',region_catalog_version:'v1'});assert.equal(put.header['If-Match'],'"1"');assert.ok(put.header['Idempotency-Key'].length>=8);assert.equal(f.requests.filter(r=>r.method==='PUT').length,1);f.answer(put,saved());await flush();assert.equal(f.last('/me/profile').method,'GET');f.answer(f.last('/me/profile'),saved(3));await flush();assert.equal(f.page.data.profile.revision,3);assert.equal(f.page.data.cropName,'水稻');assert.equal(f.page.data.regionName,'上城区');f.page.openReference();assert.equal(f.routes.at(-1),'/pages/knowledge/knowledge','保存成功后按档案查资料必须落服务端查询面，不是随包离线名录');
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

// —— GY-I05 补漏（Refs #5）：定位入口的「超时」不再只能靠平台回调 ——
// 缺口：改前 timeout 只能由 wx.getLocation 的 fail 回调带 errMsg 进入。平台永不回调时，页面停在
// 「正在获取位置…」、locating 恒为 true，而 onLocate 开头的 `if (... || this.data.locating) return`
// 会把定位入口长期挡住——那是一个没有任何可见状态、也没有出口的挂死态。
// 这里注入可控计时器（真实时钟会让用例等 15s），证明页面会在到点后回到「可手选」的显式状态。
const fakeClock=()=>{let next=1;const pending=new Map();return {setTimeout(fn,ms){const id=next;next+=1;pending.set(id,{fn,ms});return id},clearTimeout(id){pending.delete(id)},tick(ms){const due=[...pending].filter(([,item])=>item.ms<=ms);for(const [id] of due)pending.delete(id);for(const [,item] of due)item.fn();return due.length},get size(){return pending.size}}};
test('location hung platform recovers to an explicit timeout state and manual selection still saves',async()=>{
 const clock=fakeClock();
 const f=fixture(undefined,{[root+'/miniprogram/utils/location-region.js']:{setTimeout:clock.setTimeout,clearTimeout:clock.clearTimeout}});
 await f.ready();
 let located=0;f.wx.getLocation=()=>{located++};  // 永不回调：既不 success 也不 fail
 f.page.onEdit();f.page.onLocate();await flush();
 assert.equal(located,1);assert.equal(f.page.data.locating,true);assert.ok(f.page.data.message.includes('正在获取位置'),f.page.data.message);
 assert.equal(clock.size,1,'页面侧必须装且只装一个兜底计时器');
 clock.tick(14999);await flush();
 assert.equal(f.page.data.locating,true,'未到点不得提前报超时');assert.ok(f.page.data.message.includes('正在获取位置'),f.page.data.message);
 assert.equal(f.page.data.editing,true);
 clock.tick(15000);await flush();
 assert.ok(f.page.data.message.includes('定位超时'),f.page.data.message);
 assert.equal(f.page.data.locating,false);assert.equal(f.page.data.editing,true);
 assert.equal(clock.size,0,'结算后不得留下悬挂计时器');
 assert.equal(located,1,'超时不是重试：仍只请求过一次定位');
 // 超时后手选照旧可存，且请求体只有三个既有字段，不含坐标。
 f.page.onCrop({detail:{value:'0'}});f.page.onCity({detail:{value:'0'}});f.page.onCounty({detail:{value:'0'}});f.page.onSave();
 const put=f.last('/me/profile');assert.equal(put.method,'PUT');
 assert.deepEqual(JSON.parse(JSON.stringify(put.data)),{crop_id:'crop_rice',region_code:'330102',region_catalog_version:'v1'});
 assert.equal(JSON.stringify(f.requests).includes('latitude'),false);
 assert.equal(JSON.stringify(f.page.data).includes('latitude'),false);
});
test('location hung platform then late permission grant never rewrites the settled timeout state',async()=>{
 const clock=fakeClock();
 const f=fixture(undefined,{[root+'/miniprogram/utils/location-region.js']:{setTimeout:clock.setTimeout,clearTimeout:clock.clearTimeout}});
 await f.ready();
 let options;f.wx.getLocation=o=>{options=o};  // 只记住回调，模拟系统弹窗挂起
 f.page.onEdit();f.page.onLocate();await flush();
 clock.tick(15000);await flush();
 assert.ok(f.page.data.message.includes('定位超时'),f.page.data.message);
 // 用户很晚才在系统弹窗点「允许」：迟到的成功不得把文案改成「已按定位预选」或擅自预选地区。
 options.success(sentinel);await flush();
 assert.ok(f.page.data.message.includes('定位超时'),f.page.data.message);
 assert.equal(f.page.data.locating,false);
 assert.equal(f.page.data.cityIndex,-1);assert.equal(f.page.data.countyIndex,-1);
 assert.equal(f.requests.filter(r=>r.method==='PUT').length,0);
 assert.equal(JSON.stringify(f.page.data).includes('123.4567'),false);
 assert.equal(JSON.stringify(f.requests).includes('123.4567'),false);
});

// —— G1 缺口回归：「我的 → 按当前档案查科普资料」必须落**服务端查询面** `pages/knowledge` ——
// 复核证据（改前基线 da61b64d，逐字读）：
//   · `miniprogram/pages/profile/profile.js:266-275` 跳 `pages/reference`，并拼 crop_id + region_code；
//   · `miniprogram/pages/reference/reference.js:207-210` 只要带作物／杂草／地区条件就**强制**
//     `BUNDLED_OFFLINE`（服务端 `/herbicides` 的 querystring 表达不了这些条件），不发请求；
//   ⇒ 这条入口结构上永远走不到 `GET /knowledge`，也就走不到「详情 → 收藏」与来源版本／失效口径。
// 改后跳 `pages/knowledge/knowledge`，且**不拼查询参数**：该页 `onLoad` 只做字号（`knowledge.js:57`）、
// 全页不读 `options`，档案条件由它自己的 `prepare()` 读一次 `GET /me/profile` 预置（`knowledge.js:76-132`，
// 地区一律按省级 `330000` 发）。所以下面两条断言必须同时成立：跳对页 + 档案条件真的进了首次服务端查询。
// 这个夹具只装 `pages/knowledge` 与其真实依赖（真页面 + 真客户端），HTTP 只入队、由用例显式回放。
function knowledgePage() {
 const requests=[],routes=[],storage=new Map(),cache=new Map();let page;
 const wx={request:o=>requests.push(o),login:o=>o.success({code:'synthetic-code'}),getStorageSync:k=>storage.get(k),setStorageSync:(k,v)=>storage.set(k,v),removeStorageSync:k=>storage.delete(k),reLaunch:o=>{routes.push(o.url);o.success&&o.success()},navigateTo:o=>{routes.push(o.url);o.success&&o.success()},showToast:()=>{}};
 function load(file){file=resolve(file);if(!file.endsWith('.js'))file+='.js';if(cache.has(file))return cache.get(file).exports;
  if(file.endsWith('runtime.js')){const runtime={exports:{mode:'local',apiBaseUrl:'http://127.0.0.1:1234/api/v1'}};cache.set(file,runtime);return runtime.exports}
  const m={exports:{}};cache.set(file,m);
  vm.runInNewContext(readFileSync(file,'utf8'),{module:m,wx,require:id=>load(resolve(dirname(file),id)),getApp:()=>({globalData:{fontScale:1}}),getCurrentPages:()=>page?[page]:[],Page:d=>{page={...d,route:'pages/knowledge/knowledge',options:{},data:structuredClone(d.data),setData(p){Object.assign(this.data,p)}}}},{filename:file});
  return m.exports}
 const auth=load(root+'/miniprogram/utils/auth.js');load(root+'/miniprogram/pages/knowledge/knowledge.js');
 return {page,auth,requests,routes,last:path=>requests.filter(r=>new URL(r.url).pathname.endsWith(path)).at(-1),
  answer:(r,data,statusCode=200)=>{assert.ok(r,'expected request');r.success({statusCode,data:statusCode===200?{data,meta:{request_id:'11111111-1111-4111-8111-111111111111',contract_version:'1.0.0',execution_mode:'stub'}}:{error:{code:data}}})}}
}
test('按当前档案查科普资料 落服务端查询面 pages/knowledge，档案作物/地区仍进首次查询',async()=>{
 const f=fixture();await f.ready(saved(2));
 f.page.openReference();
 assert.equal(f.routes.at(-1),'/pages/knowledge/knowledge','入口必须落服务端查询面');
 assert.equal(f.routes.some(r=>r.startsWith('/pages/reference/reference')),false,'不得再落随包离线名录（reference 保持只做名录浏览）');
 assert.equal(f.routes.at(-1).includes('?'),false,'knowledge 页不读 options：参数只能由它自己读档案预置，不得另造一套');
 const k=knowledgePage();
 k.auth.setSession({accessToken:'synthetic-a',audience:'user',expiresAt:new Date(Date.now()+3600000).toISOString(),executionMode:'stub'});
 k.page.onLoad();k.page.onShow();
 k.answer(k.last('/auth/session'),{audience:'user',expires_at:new Date(Date.now()+3600000).toISOString()});await flush();
 k.answer(k.last('/me/profile'),saved(2));await flush();
 const q=new URL(k.last('/knowledge').url);
 assert.equal(q.searchParams.get('crop_id'),'crop_rice','档案作物必须进服务端查询');
 assert.equal(q.searchParams.get('region_code'),'330000','资料只登记到省级，地区按 330000 发');
 assert.equal(k.page.data.profileState,'applied','档案预置必须被页面认定已应用，而不是"没带筛选"');
});
// 空档案（未选手选作物／地区）的选定行为：**入口处提示、不跳转**，而不是"进知识页但不带筛选"。
// 理由写在 profile.js 的注释里（按钮承诺「按当前档案」；知识页的空档案说明只在用户已进查询面之后才出现，
// 第一屏仍是一张会被误读成"档案条件下查到的资料"的列表）。这里把「提示」与「不跳转」两条都钉死。
test('空档案时不跳转，在入口给出"先完善档案"的可见提示',async()=>{
 const f=fixture();await f.ready(profile(3));
 const before=f.routes.length;
 f.page.openReference();
 assert.equal(f.routes.length,before,'档案为空时不得跳转');
 assert.equal(f.routes.some(r=>r.startsWith('/pages/knowledge/knowledge')),false);
 assert.equal(f.page.data.message,'请先设置档案（作物与地区）再按档案查科普资料。');
});
// 负控制（可执行的结构守卫）：把入口改回 `pages/reference` 时，上面的用例①必红。
// 这里直接从源码切出 `openReference` 的函数体做判定——改回旧目标会在这里先失败。
test('负控制：openReference 的函数体里不得再出现 pages/reference（改回旧目标必红）',()=>{
 const src=readFileSync(root+'/miniprogram/pages/profile/profile.js','utf8');
 const at=src.indexOf('openReference: function');
 assert.ok(at>0,'openReference 入口未找到——正则/切片失配必须失败，不得静默通过');
 const body=src.slice(at,src.indexOf('\n  },',at)+4);
 assert.match(body,/\/pages\/knowledge\/knowledge/,'入口目标必须是服务端查询面');
 assert.equal(/pages\/reference\/reference/.test(body),false,'入口不得再跳随包离线名录');
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
 const failure=wxml.match(/<state-view\b[^>]*wx:(?:if|elif)="\{\{loadError\}\}"[^>]*>/);
 assert.ok(failure,'失败态 state-view 未接线到 loadError——正则失配必须失败，不得静默通过');
 assert.match(failure[0],/status="error"/);
 assert.match(failure[0],/desc="\{\{loadError\}\}"/);
 assert.match(failure[0],/action-text="重试读取档案"/);
 assert.match(failure[0],/bind:action="loadProfile"/,'失败态必须带可用的重试入口');
 // 读取中同样不得静默（loading → 失败/成功 的可见反馈）
 const loading=wxml.match(/<state-view\b[^>]*status="loading"[^>]*>/);
 assert.ok(loading,'读取中必须有可见加载态');
 assert.match(loading[0],/wx:if="\{\{busy && !loaded\}\}"/,'加载态只在首次/重试读取在途时出现，不能盖住保存流程');
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
 // 4) 重试入口真的重发读取；重试在途必须是可见加载态（loading → 成功）
 f.page.loadProfile();
 assert.equal(f.page.data.busy,true);assert.equal(f.page.data.loaded,false);assert.equal(f.page.data.loadError,'');
 assert.match(f.page.data.message,/正在读取/);
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

// —— GY-I05 D2：地区转换资源装配（去掉 profile.js 的 `regionConverter: null` 硬编码） ——
// 契约不变：坐标只在内存里经入参交给 convert，不入存储、不进请求体、不上服务端；定位只预选，
// 用户确认前不落库。region_code 的合法性判据是**两份目录**（miniprogram/data/regions.js 与
// packages/knowledge/catalog/regions-zhejiang.json）；下文期望值一律从目录派生，⛔ 不硬编码绕过校验。
const regionConverterModule=createRequire(import.meta.url)(root+'/miniprogram/utils/region-converter.js');
const mpCatalog=createRequire(import.meta.url)(root+'/miniprogram/data/regions.js');
const mpCodes=new Set(mpCatalog.regions.map(r=>r.code));
const knowledgeCodes=new Set(JSON.parse(readFileSync(root+'/packages/knowledge/catalog/regions-zhejiang.json','utf8')).regions.map(r=>r.code));
const RESOURCE_ID=resolve(root+'/miniprogram/data/region-centroids.js');
// 夹具目录里的叶子节点=县区（派生，不手写）；坐标是合成假坐标，不是任何真实质心。
const FIXTURE_COUNTY=regions.find(r=>r.parent_code&&!regions.some(x=>x.parent_code===r.code));
const SYNTHETIC={latitude:27.9013,longitude:119.9027};
const SYNTHETIC_TEXT=['27.9013','119.9027'];
function syntheticResource(code){return {schema:regionConverterModule.SCHEMA,state:'available',crs:'WGS84',source:'测试合成（不是真实几何数据）',license:'测试合成',retrieved_at:'2026-10-17',catalog_version:mpCatalog.catalog_version,max_distance_km:5,points:[{code:code,latitude:SYNTHETIC.latitude,longitude:SYNTHETIC.longitude}]};}

test('D2 profile.js 不再写死转换资源：注入点即装配模块 build()，资源缺席时如实回退手选且不落库',async()=>{
 const source=readFileSync(root+'/miniprogram/pages/profile/profile.js','utf8');
 assert.equal(/regionConverter\s*:\s*null/.test(source),false,'profile.js 不得再写死 regionConverter: null');
 assert.match(source,/regionConverter\s*:\s*regionConverterResource\.build\(\)/,'注入点必须是装配模块的 build()');
 assert.match(source,/require\('\.\.\/\.\.\/utils\/region-converter'\)/);
 const f=fixture();await f.ready();
 assert.equal(f.page.regionConverter,regionConverterModule.build(),'页面注入点必须等于装配模块的结果');
 assert.equal(f.page.regionConverter,null,'仓库内没有几何资源 ⇒ fail-closed 为 null（U3 未取得）');
 assert.equal(regionConverterModule.describe().wired,false);
 assert.equal(regionConverterModule.describe().reason,'resource-missing');
 const writes=[];const raw=f.wx.setStorageSync;f.wx.setStorageSync=(k,v)=>{writes.push([k,v]);return raw(k,v)};
 f.wx.getLocation=o=>o.success(sentinel);
 f.page.onEdit();f.page.onLocate();await flush();
 assert.ok(f.page.data.message.includes('地区转换资源尚未接入'),f.page.data.message);
 assert.equal(f.page.data.editing,true);assert.equal(f.page.data.locating,false);
 assert.equal(f.requests.filter(r=>r.method==='PUT').length,0,'定位只预选：用户确认前不得落库');
 assert.equal(JSON.stringify(f.page.data).includes('123.4567'),false);
 assert.equal(JSON.stringify(writes).includes('123.4567'),false);
 assert.equal(JSON.stringify(f.requests).includes('123.4567'),false);
});

test('D2 页面装配·资源就位即自动接线：region_code 经两份目录校验、未确认不落库、坐标零外泄',async()=>{
 assert.equal(mpCodes.has(FIXTURE_COUNTY.code),true,'夹具县区码必须真实存在于目录：'+FIXTURE_COUNTY.code);
 assert.equal(knowledgeCodes.has(FIXTURE_COUNTY.code),true);
 const f=fixture({[RESOURCE_ID]:syntheticResource(FIXTURE_COUNTY.code)});await f.ready();
 assert.equal(typeof f.page.regionConverter,'function','资源合规 ⇒ 页面注入点自动接线，无需改页面');
 assert.equal(f.page.regionConverter.provenance.source,'测试合成（不是真实几何数据）');
 assert.equal(f.page.regionConverter.provenance.catalog_version,mpCatalog.catalog_version);
 const inner=f.page.regionConverter,seen=[];
 f.page.regionConverter=(lat,lng)=>{seen.push([lat,lng]);return inner(lat,lng)};
 const writes=[];const raw=f.wx.setStorageSync;f.wx.setStorageSync=(k,v)=>{writes.push([k,v]);return raw(k,v)};
 f.wx.getLocation=o=>o.success(SYNTHETIC);
 f.page.onEdit();f.page.onLocate();await flush();
 assert.deepEqual(seen,[[SYNTHETIC.latitude,SYNTHETIC.longitude]],'坐标只按 (latitude, longitude) 交给转换资源一次');
 assert.equal(f.page.data.cities[0].code,FIXTURE_COUNTY.parent_code);
 assert.equal(f.page.data.cityIndex,0);assert.equal(f.page.data.countyIndex,0);
 assert.equal(f.page.data.counties[0].code,FIXTURE_COUNTY.code);
 assert.match(f.page.data.message,/请确认后保存档案/);
 assert.equal(f.page.data.editing,true);assert.equal(f.page.data.locating,false);
 assert.equal(f.requests.filter(r=>r.method==='PUT').length,0,'定位只预选：用户确认前不得落库');
 for(const text of SYNTHETIC_TEXT){
  assert.equal(JSON.stringify(f.page.data).includes(text),false,'页面状态不得含坐标 '+text);
  assert.equal(JSON.stringify(writes).includes(text),false,'存储不得含坐标 '+text);
  assert.equal(JSON.stringify(f.requests).includes(text),false,'请求不得含坐标 '+text);
 }
 f.page.onCrop({detail:{value:'0'}});f.page.onSave();f.page.onSave();
 const put=f.last('/me/profile');assert.equal(put.method,'PUT');
 assert.equal(f.requests.filter(r=>r.method==='PUT').length,1);
 assert.equal(put.data.region_code,FIXTURE_COUNTY.code);
 assert.equal(mpCodes.has(put.data.region_code),true,'落库的 region_code 必须在 miniprogram/data/regions.js 目录里');
 assert.equal(knowledgeCodes.has(put.data.region_code),true,'落库的 region_code 必须在 regions-zhejiang.json 目录里');
 assert.deepEqual(Object.keys(put.data).sort(),['crop_id','region_catalog_version','region_code'],'请求体仍只含三个目录字段');
 assert.equal(JSON.stringify(put.data).includes('27.9013'),false);
 assert.equal(JSON.stringify(put.header).includes('27.9013'),false);
});

// —— P1（Refs #26）：「我的」页三项计数各自可读的加载/失败状态与显式重试 ——
// 计数口径不变：只读第一页已加载条数，`N+` 表示还有下一页，服务端封套没有总数。
const COUNT_META={request_id:'99999999-9999-4999-8999-999999999999',contract_version:'1.0.0',execution_mode:'stub'};
const FAV_ITEM={id:'00000000-0000-4000-8a00-000000000001',revision:1,target_ref:{type:'species',id:'crop_rice',revision:1},reference_state:'available',unavailable_reason:null,created_at:'2026-10-14T06:00:00.000Z'};
const HIST_ITEM={id:'00000000-0000-4000-8b00-000000000002',revision:1,kind:'recognition',target_ref:{type:'recognition',id:'11111111-1111-4111-8111-111111111111',revision:2},job_state:'succeeded',reference_state:'available',created_at:'2026-10-14T06:00:00.000Z'};
const POST_ITEM={id:'11111111-1111-4111-8111-111111111111',revision:1,author:{display_name:'耕云用户abcd',display_id:'gy-abcdef012345',state:'active',avatar_media_id:null,revision:1,avatar_media:null},title:'合成标题',body:'合成正文。',crop_id:null,region_code:null,media_ids:[],visibility:'published',audit_state:'approved',created_at:'2026-10-20T04:00:00.000Z',updated_at:'2026-10-20T04:00:00.000Z',media:[],linked_knowledge_ref:null,linked_knowledge:null};
function answerList(req,items,nextCursor,statusCode=200){
 if(statusCode===200){req.success({statusCode,data:{data:{items,next_cursor:nextCursor},meta:COUNT_META}});return;}
 req.success({statusCode,data:{error:{code:items,message:'synthetic',retryable:false,details:[]},meta:COUNT_META}});
}
const countPath=req=>new URL(req.url).pathname;
test('三项计数各自结算：一项失败只把该项置为失败，其他项已加载条数保留且不假报总数',async()=>{
 const f=fixture();await f.ready();
 const fav=f.last('/favorites'),hist=f.last('/history'),posts=f.last('/posts');
 assert.ok(fav&&hist&&posts,'三项计数应在进入页面后各自发起一次第一页读取');
 assert.equal(new URL(fav.url).searchParams.get('limit'),'20');
 assert.equal(new URL(hist.url).searchParams.get('limit'),'20');
 assert.equal(new URL(posts.url).searchParams.get('mine'),'true');
 assert.equal(new URL(posts.url).searchParams.get('limit'),'20');
 answerList(fav,[FAV_ITEM],'opaque.next');
 answerList(hist,[HIST_ITEM],null);
 answerList(posts,'PROVIDER_UNAVAILABLE',null,503);
 await flush();
 assert.equal(f.page.data.favoriteState,'ready');assert.equal(f.page.data.favoriteCount,'1+');
 assert.equal(f.page.data.historyState,'ready');assert.equal(f.page.data.historyCount,'1');
 assert.equal(f.page.data.myPostState,'error');assert.equal(f.page.data.myPostCount,'—');
 assert.equal(/总/.test(String(f.page.data.myPostCount)),false,'失败不得用任何本地数据或总数顶替');
});
test('失败项重试只重读该项，成功条数与档案编辑表单原样保留',async()=>{
 const f=fixture();await f.ready();
 f.page.onEdit();assert.equal(f.page.data.editing,true);
 const form=JSON.stringify({crops:f.page.data.crops,regions:f.page.data.regions,cropIndex:f.page.data.cropIndex,cityIndex:f.page.data.cityIndex,counties:f.page.data.counties,countyIndex:f.page.data.countyIndex});
 answerList(f.last('/favorites'),'PROVIDER_UNAVAILABLE',null,503);
 answerList(f.last('/history'),[HIST_ITEM,HIST_ITEM],'opaque.history');
 answerList(f.last('/posts'),[POST_ITEM],null);
 await flush();
 assert.equal(f.page.data.favoriteState,'error');
 assert.equal(f.page.data.historyCount,'2+');assert.equal(f.page.data.myPostCount,'1');
 const failedFav=f.last('/favorites');
 const before={hist:f.requests.filter(r=>countPath(r)==='/api/v1/history').length,posts:f.requests.filter(r=>countPath(r)==='/api/v1/posts').length};
 f.page.retryCount({currentTarget:{dataset:{kind:'favorite'}}});
 assert.equal(f.page.data.favoriteState,'loading');assert.equal(f.page.data.favoriteCount,'—');
 assert.equal(f.page.data.historyCount,'2+','重试一项不得清掉其他项已成功的条数');
 assert.equal(f.page.data.myPostCount,'1');
 const retry=f.last('/favorites');assert.notEqual(retry,failedFav);
 assert.equal(f.requests.filter(r=>countPath(r)==='/api/v1/history').length,before.hist,'重试收藏不得重读识别历史');
 assert.equal(f.requests.filter(r=>countPath(r)==='/api/v1/posts').length,before.posts,'重试收藏不得重读我的发布');
 answerList(retry,[FAV_ITEM],null);await flush();
 assert.equal(f.page.data.favoriteState,'ready');assert.equal(f.page.data.favoriteCount,'1');
 assert.equal(f.page.data.historyCount,'2+');assert.equal(f.page.data.myPostCount,'1');
 assert.equal(f.page.data.editing,true,'重试计数不得重置或修改档案表单');
 assert.equal(JSON.stringify({crops:f.page.data.crops,regions:f.page.data.regions,cropIndex:f.page.data.cropIndex,cityIndex:f.page.data.cityIndex,counties:f.page.data.counties,countyIndex:f.page.data.countyIndex}),form);
 assert.equal(f.requests.filter(r=>r.method==='PUT').length,0,'重试计数不得触发保存');
});
test('离页或换会话后的迟到计数响应不得写回页面',async()=>{
 const f=fixture();await f.ready();
 const fav=f.last('/favorites'),hist=f.last('/history');
 f.page.onHide();
 const snapshot=JSON.stringify(f.page.data);
 answerList(fav,[FAV_ITEM],null);answerList(hist,[HIST_ITEM],null);await flush();
 assert.equal(JSON.stringify(f.page.data),snapshot,'离页后迟到响应不得写回任何计数或状态');
 const other=fixture();await other.ready();
 const late=other.last('/favorites');
 const before=JSON.stringify(other.page.data);
 other.seed('synthetic-b');
 answerList(late,[FAV_ITEM],null);await flush();
 assert.equal(JSON.stringify(other.page.data),before,'旧会话的迟到响应不得写回');
 assert.equal(other.page.data.favoriteCount,'—');
});
test('计数状态与重试入口已接线：失败可点重试且不冒泡触发整卡跳转',()=>{
 const wxml=readFileSync(root+'/miniprogram/pages/profile/profile.wxml','utf8');
 for(const kind of ['favorite','history','myPost']){
  assert.match(wxml,new RegExp(kind+"State === 'loading'"),kind+' 缺少加载中状态');
  assert.match(wxml,new RegExp(kind+"State === 'error'[\\s\\S]{0,220}catchtap=\"retryCount\" data-kind=\""+kind+"\""),kind+' 失败态缺少显式重试入口');
 }
 assert.equal(/bindtap="retryCount"/.test(wxml),false,'重试必须 catchtap，不能冒泡触发整卡跳转');
});
