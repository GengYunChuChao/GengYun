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

function fixture(name,verified=true){let page;const calls={gate:0,lookup:[],backs:[],redirects:[],reads:0};
  const auth={isLoggedIn:()=>verified,requireLogin(cb){calls.gate++;cb(verified)}};
  const gate={exports:{}};vm.runInNewContext(read('utils/page-gate.js'),{module:gate,require:()=>auth});
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
