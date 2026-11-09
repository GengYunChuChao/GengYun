// Actual page + page-gate + read-only repository catalog; auth decision is controlled offline.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const require=createRequire(import.meta.url),reference=require('../../miniprogram/utils/reference.js');
const read=p=>readFileSync(new URL('../../miniprogram/'+p,import.meta.url),'utf8');

/** 可控 Promise 的 profile-api 替身（PR #82 阻塞 C：referencedetail 现经它读取已确认档案）。 */
function profileApiStub(calls){
  return {
    binding: () => ({ token: 't', epoch: 1 }),
    current: () => true,
    read(){ calls.reads=(calls.reads||0)+1; return Promise.resolve({ crop_id:'crop_rice', region_code:'330100', region_catalog_version:'v1', revision:1 }); },
    crops: () => Promise.resolve([]),
    regions: () => Promise.resolve([]),
    save: () => Promise.reject(new Error('not used')),
  };
}

/** 等待页面内 Promise 链结算（档案异步读取 + 详情装载）。 */
async function settle(){ for(let i=0;i<20;i+=1) await Promise.resolve(); }

function fixture(name,verified=true,gateSource=read('utils/page-gate.js')){let page;const calls={gate:0,lookup:[],backs:[],redirects:[],reads:0};
  const auth={isLoggedIn:()=>verified,requireLogin(cb){calls.gate++;cb(verified)}};
  // 门禁模块的**完整说明符登记表**（登记项逐字取自被加载源码里的 require）：
  // `miniprogram/utils/page-gate.js:3` 只有 `require('./auth')` 一条。改前是 `require:()=>auth`
  // 的 blanket —— page-gate.js 将来 require 别的模块，也会被**静默喂成 auth 替身**，用例仍绿。
  // 未登记 ⇒ 显式失败并带依赖名（沿用仓库既有口径）。已登记项取值与改前逐字相同。
  const gateDependencies=new Map([['./auth',auth]]);
  const loadGate=src=>vm.runInNewContext(src,{module:{exports:{}},require:id=>{if(!gateDependencies.has(id))throw Error('Unexpected page dependency '+id);return gateDependencies.get(id)}});
  const gate={exports:loadGate(gateSource)};
  const font={exports:{}};vm.runInNewContext(read('utils/font-scale.js'),{module:font});
  // GY-R92：referencedetail 用 `require('../../utils/time-format')` 渲染来源取得时间。登记**真实模块**，
  // 让时间文案仍由真源码决定；空壳或只替 formatDate 会让页面在真依赖缺失时仍绿。
  const time={exports:{}};vm.runInNewContext(read('utils/time-format.js'),{module:time});
  const adapter={...reference,detail:id=>{calls.lookup.push(id);return reference.detail(id)},seedHerbicideDetail:id=>{calls.lookup.push(id);return reference.seedHerbicideDetail(id)}};
  // 页面依赖按**完整说明符**登记（逐字取自 referencedetail / referenceseeddetail 两个页面的 require），
  // 不做后缀匹配：`id.endsWith('/reference')` 一类会把 `require('../../data/reference')` 静默喂成
  // 已登记替身 —— 看着在测真页面，其实测了替身。未登记（将来新增依赖）⇒ 显式失败并带依赖名。
  // 登记表随每次 fixture() 新建 ⇒ 与改前「每次 require 求值」一一对应，已登记项行为逐字不变。
  // GY-I07 D1：referencedetail 新增 require('../../utils/knowledge-api')（服务端 `/herbicides/{id}` 消费者）。
  // 登记**真实模块**并把 runtime 固定为关闭联网，使「UUID ⇒ 服务端 / 非 UUID ⇒ 随包」的路由判据仍由
  // 真源码的 `validId` 决定；本文件两个页面的 id 均非 UUID（gy-i03-hb-001 / gy-i07-seed-hb-001）
  // ⇒ 一律走随包路径，不产生任何网络请求，已登记项行为逐字不变。
  const knowledgeModule = { exports: {} };
  vm.runInNewContext(read('utils/knowledge-api.js'), { module: knowledgeModule, require: (id) => {
    if (id === './auth') return auth;
    if (id === '../config/runtime') return { mode: 'disabled', apiBaseUrl: '' };
    throw Error('Unexpected dependency ' + id);
  } });
  const pageDependencies=new Map([
    ['../../utils/page-gate',gate.exports],
    ['../../utils/font-scale',font.exports],
    ['../../utils/time-format',time.exports],
    ['../../utils/auth',auth],
    ['../../utils/profile-api',profileApiStub(calls)],
    ['../../utils/reference',adapter],
    ['../../utils/knowledge-api',knowledgeModule.exports],
  ]);
  vm.runInNewContext(read('pages/'+name+'/'+name+'.js'),{Page:d=>{page={...d,data:structuredClone(d.data),setData(p){Object.assign(this.data,p)}}},wx:{navigateBack:o=>calls.backs.push(o),redirectTo:o=>calls.redirects.push(o.url)},require:id=>{if(!pageDependencies.has(id))throw Error('Unexpected page dependency '+id);return pageDependencies.get(id)}});
  return {page,calls};
}
for(const name of ['referencedetail','referenceseeddetail']){
  for(const [label,id] of [['malformed','%'],['truncated UTF8','%E0%A4%A'],['bad UTF8','%FF'],['encoded slash','%2F'],['nested percent','%252F'],['oversized','x'.repeat(513)],['non-string',7],['object',{id:'r1'}]])test(name+': '+label+' is empty, gated, and never queried',async()=>{const f=fixture(name);assert.doesNotThrow(()=>f.page.onLoad({id}));await settle();assert.equal(f.calls.gate,1);assert.equal(f.page.data.gatePassed,true);assert.equal(f.page.data.found,false);assert.equal(f.calls.lookup.length,0);});
  test(name+': malformed guest route still reaches login gate',()=>{const f=fixture(name,false);assert.doesNotThrow(()=>f.page.onLoad({id:'%'}));assert.equal(f.calls.gate,1);assert.equal(f.page.data.gatePassed,false);assert.equal(f.calls.lookup.length,0)});
  test(name+': valid encoded ID keeps exact catalog identity and source label',async()=>{const f=fixture(name);const id=name==='referencedetail'?'gy-i03-hb-001':'gy-i07-seed-hb-001';f.page.onLoad({id:id.replace(/-/g,'%2D')});await settle();assert.equal(f.page.data.found,true);assert.equal(f.calls.lookup[0],id);if(name==='referencedetail')assert.equal(f.page.data.detail.source_version,reference.detail(id).source_version);else assert.equal(f.page.data.label,reference.seed.label);});
  test(name+': failed cold-page back opens its known list; hidden callback cannot redirect',async()=>{const f=fixture(name);f.page.onLoad({id:'missing'});await settle();const back=name==='referencedetail'?'backToList':'back';f.page[back]();assert.equal(f.calls.redirects.length,0);f.calls.backs[0].fail();assert.equal(f.calls.redirects[0],name==='referencedetail'?'/pages/reference/reference':'/pages/referenceseed/referenceseed');f.page[back]();f.page.onHide();f.calls.backs[1].fail();assert.equal(f.calls.redirects.length,1)});
}
// GY-R73：随包记录的 `id` 现在也等于服务端 uuid（`deterministicUuid(record_id)`），光看 id 形状
// 已经分不出来源。列表卡片把 `id`（而不是记录号）+ `data-source` 一起带进路由 ⇒ 详情页必须按
// **显式来源**读随包副本，不能因为 id 长得像 uuid 就把富详情（剂量卡/适用性）退化成服务端精简详情。
test('referencedetail：uuid + source=bundled-offline 仍走随包副本，记录号原样带出', async()=>{
  const f=fixture('referencedetail');
  const record=reference.records[0];
  assert.match(record.id,/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,'随包记录必须带 uuid 形式的接口 id');
  assert.match(record.record_id,/^gy-i03-hb-\d{3}$/,'可读记录号必须保留');
  f.page.onLoad({id:record.id,source:'bundled-offline'});
  await settle();
  assert.equal(f.calls.lookup[0],record.id,'随包副本按接口 id 查得同一条');
  assert.equal(f.page.data.found,true);
  assert.equal(f.page.data.dataSource,'bundled-offline');
  assert.equal(f.page.data.sourceMarker,'随包离线副本');
  assert.equal(f.page.data.detail.record_id,record.record_id,'详情仍带可读记录号（溯源不丢）');
  assert.equal(f.page.data.sourceDateLabel,'采集日期');
});
// 反向钉住：同一 uuid 但**没有** source 提示时按形状走服务端（本夹具 runtime=disabled ⇒ 不发请求、
// 走失败态）——证明决定读数口径的是「显式来源」，不是更宽松的匹配或偷偷回退随包。
test('referencedetail：同一条 uuid 无 source 时按形状走服务端，不偷偷读随包', async()=>{
  const f=fixture('referencedetail');
  const uuid=reference.records[0].id;
  f.page.onLoad({id:uuid});
  await settle();
  assert.equal(f.page.data.dataSource,'server');
  assert.equal(f.page.data.sourceMarker,'服务端接口 /herbicides/{id}');
  assert.equal(f.calls.lookup.length,0,'服务端路径不得退化成随包查找');
});
// 负控制：未知的 source 值不得被当成随包（来源必须可判定，不能"猜一个"）。
test('referencedetail：未知 source 值被忽略，uuid 仍按形状走服务端', async()=>{
  const f=fixture('referencedetail');
  const uuid=reference.records[0].id;
  f.page.onLoad({id:uuid,source:'server-ish'});
  await settle();
  assert.equal(f.page.data.dataSource,'server');
  assert.equal(f.calls.lookup.length,0);
});
// 负控制：登记的说明符是**完整且唯一**的。把真实 page-gate 源码的 `require('./auth')` 换成相近写法
// （`./auth.js`／`./Auth`／`./utils/auth`）后重跑**本站点自己的**装载器 ⇒ 必须显式失败并带原名，
// 不得近似命中（改前是 blanket `require:()=>auth`：三种写法都会被**静默喂成 auth 替身**，用例照样绿）。
test('page-gate 未登记说明符：显式失败并带名，零近似命中',()=>{
  const gateSource=read('utils/page-gate.js');
  assert.ok(gateSource.includes("require('./auth')"),'真实源码的 require 说明符变了，登记表须同步');
  assert.doesNotThrow(()=>fixture('referencedetail',true,gateSource),'已登记项必须照常装载');
  for(const spec of ['./auth.js','./Auth','./utils/auth'])
    assert.throws(()=>fixture('referencedetail',true,gateSource.replace("require('./auth')","require('"+spec+"')")),
      new RegExp('Unexpected page dependency '+spec.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$'),
      '近似说明符 '+spec+' 未被显式拒绝');
});
