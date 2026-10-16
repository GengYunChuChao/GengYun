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
  const adapter={...reference,detail:id=>{calls.lookup.push(id);return reference.detail(id)},seedHerbicideDetail:id=>{calls.lookup.push(id);return reference.seedHerbicideDetail(id)}};
  vm.runInNewContext(read('pages/'+name+'/'+name+'.js'),{Page:d=>{page={...d,data:structuredClone(d.data),setData(p){Object.assign(this.data,p)}}},wx:{navigateBack:o=>calls.backs.push(o),redirectTo:o=>calls.redirects.push(o.url)},require:id=>id.endsWith('/page-gate')?gate.exports:id.endsWith('/font-scale')?font.exports:id.endsWith('/auth')?auth:id.endsWith('/profile-api')?profileApiStub(calls):adapter});
  return {page,calls};
}
for(const name of ['referencedetail','referenceseeddetail']){
  for(const [label,id] of [['malformed','%'],['truncated UTF8','%E0%A4%A'],['bad UTF8','%FF'],['encoded slash','%2F'],['nested percent','%252F'],['oversized','x'.repeat(513)],['non-string',7],['object',{id:'r1'}]])test(name+': '+label+' is empty, gated, and never queried',async()=>{const f=fixture(name);assert.doesNotThrow(()=>f.page.onLoad({id}));await settle();assert.equal(f.calls.gate,1);assert.equal(f.page.data.gatePassed,true);assert.equal(f.page.data.found,false);assert.equal(f.calls.lookup.length,0);});
  test(name+': malformed guest route still reaches login gate',()=>{const f=fixture(name,false);assert.doesNotThrow(()=>f.page.onLoad({id:'%'}));assert.equal(f.calls.gate,1);assert.equal(f.page.data.gatePassed,false);assert.equal(f.calls.lookup.length,0)});
  test(name+': valid encoded ID keeps exact catalog identity and source label',async()=>{const f=fixture(name);const id=name==='referencedetail'?'gy-i03-hb-001':'gy-i07-seed-hb-001';f.page.onLoad({id:id.replace(/-/g,'%2D')});await settle();assert.equal(f.page.data.found,true);assert.equal(f.calls.lookup[0],id);if(name==='referencedetail')assert.equal(f.page.data.detail.source_version,reference.detail(id).source_version);else assert.equal(f.page.data.label,reference.seed.label);});
  test(name+': failed cold-page back opens its known list; hidden callback cannot redirect',async()=>{const f=fixture(name);f.page.onLoad({id:'missing'});await settle();const back=name==='referencedetail'?'backToList':'back';f.page[back]();assert.equal(f.calls.redirects.length,0);f.calls.backs[0].fail();assert.equal(f.calls.redirects[0],name==='referencedetail'?'/pages/reference/reference':'/pages/referenceseed/referenceseed');f.page[back]();f.page.onHide();f.calls.backs[1].fail();assert.equal(f.calls.redirects.length,1)});
}
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
