import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {resolve,dirname} from 'node:path';import vm from 'node:vm';import {createRequire} from 'node:module';import {createProfileFixture} from './profile-ui-fixture.mjs';
// 浙江首批真实资料（未发布/未核对）默认关闭；本片要核对"档案驱动查询"确实取到资料，显式接线。
// 只影响 stub 执行模式下的 `/knowledge` 查询面，不改服务端代码与契约。
// 但**不得**写成模块级赋值：`node --test --test-isolation=none` 下同进程共享 `process.env`，
// 模块级写会把开关泄漏给后面跑的文件。改为用例内打开、`finally` 里复原（开关在夹具
// `buildApp` 时读取）。见 `docs/verification/gy-test-env-isolation-20261019.md`。
const UNVERIFIED_SEED='APP_KNOWLEDGE_UNVERIFIED_SEED',UNVERIFIED_SEED_AT_LOAD=process.env[UNVERIFIED_SEED];
const root=resolve(import.meta.dirname,'../..'),nativeRequire=createRequire(import.meta.url),tick=()=>new Promise(r=>setTimeout(r,10));
test('actual native page and client over loopback HTTP: profile catalog save reread query and conflict',async()=>{
 const previousSeed=process.env[UNVERIFIED_SEED];process.env[UNVERIFIED_SEED]='1';
 const f=await createProfileFixture();const base=await f.app.listen({host:'127.0.0.1',port:0});const storage=new Map(),requests=[],routes=[],cache=new Map();let page,definition,identity='profile-ui-synthetic-a',modal=true;const pending=new Set();
 const wx={getStorageSync:k=>storage.get(k),setStorageSync:(k,v)=>storage.set(k,v),removeStorageSync:k=>storage.delete(k),login:o=>o.success({code:identity}),showModal:o=>o.success({confirm:modal}),showToast:()=>{},navigateTo:o=>routes.push(o.url),reLaunch:o=>routes.push(o.url),request(o){requests.push(o);const p=fetch(o.url,{method:o.method,headers:o.header,...(o.data===undefined?{}:{body:JSON.stringify(o.data)})}).then(async r=>o.success({statusCode:r.status,data:await r.json()})).catch(()=>o.fail({})).finally(()=>pending.delete(p));pending.add(p)}};
 function load(path){path=resolve(path);if(path.endsWith('runtime.js'))return {mode:'local',apiBaseUrl:base+'/api/v1'};if(path.includes('/data/')||path.includes('\\data\\'))return nativeRequire(path);if(cache.has(path))return cache.get(path).exports;const m={exports:{}};cache.set(path,m);vm.runInNewContext('(function(require,module){'+readFileSync(path,'utf8')+'\n})',{wx,Page:d=>{definition=d},getCurrentPages:()=>[page]})((id)=>load(resolve(dirname(path),id.endsWith('.js')?id:id+'.js')),m);return m.exports}
 function create(name){load(root+'/miniprogram/pages/'+name+'/'+name+'.js');page={...definition,data:structuredClone(definition.data),route:'pages/'+name+'/'+name,options:{},setData(p){Object.assign(this.data,p)}};return page}
 async function until(fn){for(let i=0;i<500&&!fn();i++)await tick();assert.ok(fn(),'timed out waiting for actual page state')}
 const auth=load(root+'/miniprogram/utils/auth.js');
 try {
  const p=create('profile');p.onShow();assert.equal(p.data.guest,true);assert.equal(routes.at(-1),'/pages/login/login');await new Promise((r,j)=>auth.login(e=>e?j(Error(e)):r()));p.onShow();await until(()=>p.data.loaded&&!p.data.busy);assert.equal(p.data.profile.revision,1);assert.equal(p.data.crops.length,4);assert.equal(p.data.regions.length,102);assert.ok(requests.filter(r=>r.url.includes('/catalog/regions?')).length>=6);
  p.onEdit();p.onCrop({detail:{value:p.data.crops.findIndex(c=>c.id==='crop_rice')}});p.onCity({detail:{value:p.data.cities.findIndex(r=>r.code==='330100')}});p.onCounty({detail:{value:p.data.counties.findIndex(r=>r.code==='330102')}});modal=false;p.onSave();assert.equal(requests.filter(r=>r.method==='PUT').length,0);modal=true;p.onSave();await until(()=>!p.data.busy&&!p.data.editing);assert.equal(p.data.profile.revision,2);assert.equal(p.data.cropName,'水稻');assert.equal(p.data.regionName,'上城区');p.openReference();const target=routes.at(-1);p.onHide();const ref=create('reference');ref.options={crop_id:'crop_rice',region_code:'330102'};ref.onLoad(ref.options);ref.onShow();await until(()=>ref.data.gatePassed);assert.equal(ref.data.cropId,'crop_rice');assert.equal(ref.data.regionCode,'330102');assert.ok(ref.data.matchState);assert.match(target,/crop_id=crop_rice&region_code=330102$/);ref.onHide();page=p;p.onShow();await until(()=>p.data.loaded&&!p.data.busy);assert.equal(p.data.profile.revision,2);
  // GY-I05/07 缺口 2-A/2-B：档案里的手选条件必须驱动科普页的**首次**查询，且地区只按省级发。
  const k=create('knowledge');k.onShow();await until(()=>k.data.gatePassed&&['ready','empty','error'].includes(k.data.stateKind));
  const kw=requests.filter(r=>r.url.includes('/knowledge'));
  assert.equal(kw.length,1,'门禁通过后应只自动查询一次，不轮询');
  assert.match(kw[0].url,/crop_id=crop_rice/,'首次查询必须带上档案作物');
  assert.match(kw[0].url,/region_code=330000/,'资料只登记到省级，地区按 330000 发');
  assert.doesNotMatch(kw[0].url,/region_code=330102/,'不得把市/县码原样当成资料地区');
  assert.ok(k.data.items.length>0,'按档案预置的首次查询必须真的取到资料');
  assert.match(k.data.profileNote,/来自我的档案/);assert.match(k.data.profileNote,/上城区/);
  assert.match(k.data.profileNote,/当前资料只登记到省级，已按浙江省查询/);assert.equal(k.data.profileState,'applied');
  const token=auth.getSession().accessToken;const other=await fetch(base+'/api/v1/me/profile',{method:'PUT',headers:{authorization:'Bearer '+token,'content-type':'application/json','Idempotency-Key':'synthetic-other-tab','If-Match':'"2"'},body:JSON.stringify({crop_id:'crop_rice',region_code:'330100',region_catalog_version:p.data.profile.region_catalog_version})});assert.equal(other.status,200);p.onEdit();p.onSave();await until(()=>!p.data.busy);assert.equal(p.data.needsReload,true);assert.equal(p.data.profile.revision,2);p.loadProfile();await until(()=>p.data.loaded&&!p.data.busy);assert.equal(p.data.profile.revision,3);assert.equal(p.data.regionName,'杭州市');
  // GY-I05 D2：定位→地区的等价回环（本机没有微信开发者工具 automator，tests/integration/local-dev-profile-location.cjs
  // 无法真跑；本段在链内用**真页面 + 真回环 HTTP** 钉同一行为。哨兵坐标是合成值，不是任何真实质心/边界数据）。
  const locate=load(root+'/miniprogram/utils/location-region.js'),profileSrc=readFileSync(root+'/miniprogram/pages/profile/profile.js','utf8');
  const SENTINEL={latitude:27.1234,longitude:119.5678},putsBefore=requests.filter(r=>r.method==='PUT').length;
  assert.equal(p.regionConverter,null,'资源缺席时必须 fail-closed 装配为 null（页面不得内置坐标/边界资源）');
  assert.doesNotMatch(profileSrc,/regionConverter\s*:\s*null/,'不得退回硬编码 regionConverter: null（须经 regionConverterResource.build() 装配）');
  assert.doesNotMatch(profileSrc,/startLocationUpdate|onLocationChange/,'定位只用于即时选择地区，不做持续跟踪');
  assert.equal('startLocationUpdate' in wx,false);assert.equal('onLocationChange' in wx,false);
  const leak=()=>{const n=[String(SENTINEL.latitude),String(SENTINEL.longitude)],hits=[];const scan=(w,t)=>{if(typeof t==='string'&&n.some(v=>t.includes(v)))hits.push(w)};
    for(const [k,v] of storage){scan('storage:'+k,k);scan('storage:'+k,typeof v==='string'?v:JSON.stringify(v))}
    requests.forEach((r,i)=>{scan('request#'+i+' url',r.url);scan('request#'+i+' header',JSON.stringify(r.header));scan('request#'+i+' data',JSON.stringify(r.data))});
    routes.forEach((u,i)=>scan('route#'+i,u));return hits};
  p.onEdit();assert.equal(p.data.editing,true,'定位入口只在编辑态可用');
  const before={cityIndex:p.data.cityIndex,countyIndex:p.data.countyIndex};
  const located=[];wx.getLocation=o=>{located.push(o);o.success({latitude:SENTINEL.latitude,longitude:SENTINEL.longitude})};
  modal=true;p.onLocate();await until(()=>!p.data.locating);
  assert.equal(p.data.message,locate.MESSAGES.unavailable,'资源未接入必须逐字回落 unavailable，不得假装转换成功');
  assert.equal(located.length,1);assert.equal(located[0].type,'wgs84');
  assert.equal(p.data.cityIndex,before.cityIndex);assert.equal(p.data.countyIndex,before.countyIndex,'资源缺席时不得预选任何地区');
  assert.deepEqual(leak(),[],'原始坐标不得进入存储、请求体或路由');
  assert.equal(requests.filter(r=>r.method==='PUT').length,putsBefore,'资源缺席时不得触发保存');
  // 正控制：注入合成转换资源（返回真目录内的县码），走同一条真页面路径证明「资源就位即可用」。
  const countyCode='330102',county=p.data.regions.find(r=>r.code===countyCode);
  assert.ok(county&&county.parent_code,'正控制用的编码必须来自真目录');
  const seen=[];p.regionConverter=(latitude,longitude)=>{seen.push([latitude,longitude]);return countyCode};
  p.onLocate();await until(()=>!p.data.locating);
  assert.deepEqual(seen,[[SENTINEL.latitude,SENTINEL.longitude]],'坐标只在内存里按 convert(latitude, longitude) 入参交给资源');
  assert.equal(p.data.cities[p.data.cityIndex].code,county.parent_code);
  assert.equal(p.data.counties[p.data.countyIndex].code,countyCode);
  assert.equal(p.data.message,'已按定位预选 '+county.name+'，请确认后保存档案。');
  modal=false;p.onSave();assert.equal(requests.filter(r=>r.method==='PUT').length,putsBefore,'未确认不得保存');
  modal=true;p.onSave();await until(()=>!p.data.busy&&!p.data.editing);
  const put=requests.filter(r=>r.method==='PUT').at(-1),mp=load(root+'/miniprogram/data/regions.js'),kb=JSON.parse(readFileSync(root+'/packages/knowledge/catalog/regions-zhejiang.json','utf8'));
  assert.equal(requests.filter(r=>r.method==='PUT').length,putsBefore+1);
  assert.deepEqual(Object.keys(put.data).sort(),['crop_id','region_catalog_version','region_code'],'请求体只含档案字段，坐标永不进入');
  const inMp=mp.regions.find(r=>r.code===put.data.region_code),inKb=kb.regions.find(r=>r.code===put.data.region_code);
  assert.ok(inMp&&inKb,'保存的地区码必须同时存在于小程序目录与知识目录（不得硬编码绕过校验）');
  assert.equal(inKb.name,inMp.name);assert.equal(put.data.region_code,p.data.counties[p.data.countyIndex].code);
  assert.equal(put.data.region_catalog_version,mp.catalog_version);
  assert.deepEqual(leak(),[],'保存后复核：原始坐标仍不得出现在存储或任何请求体');
  p.regionConverter=null;
  console.log('PASS GY-I05 D2 loopback: fail-closed unavailable without resource; injected converter preselects a real catalog county; raw coordinates stay in memory');
  p.logout();await until(()=>auth.getSession()===null);assert.equal(p.data.profile,null);const refused=await fetch(base+'/api/v1/me/profile',{headers:{authorization:'Bearer '+token}});assert.equal(refused.status,401);
  console.log('PASS '+f.kind+'; synthetic identity/catalog fixture; real loopback HTTP and actual frontend modules; no suppliers');
 }finally{await Promise.allSettled([...pending]);await f.close();if(previousSeed===undefined)delete process.env[UNVERIFIED_SEED];else process.env[UNVERIFIED_SEED]=previousSeed}
});

// 文件级自证（默认隔离下恒真；`--test-isolation=none` 下才是真检查）：跑完后开关必须与模块
// 加载时逐字相同——本文件不向同进程的后续文件泄漏环境变量。
test('环境变量复原：本文件跑完后 '+UNVERIFIED_SEED+' 与模块加载时逐字相同（不跨文件泄漏）',()=>{
 assert.equal(process.env[UNVERIFIED_SEED],UNVERIFIED_SEED_AT_LOAD,UNVERIFIED_SEED+' 在本文件跑完后仍未复原（跨文件环境变量泄漏）');
});
