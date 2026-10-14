import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { paginateCatalog } from '../../services/api/src/profile/pagination.ts';

const key = 'synthetic-catalog-pagination-test-key', ttl = 15*60*1000;
const rows = ['a','b','c','d','e'].map(id => ({id, name:id}));
const opts = {kind:'crops', userId:'synthetic-user', authEpoch:1, hmacKey:key, limit:1, now:1000000};
const invalid = error => error.code === 'INVALID_CURSOR' && error.status === 400;
function sign(encoded, namespace = 'profile-catalog/v1\n') {
  return createHmac('sha256',key).update(namespace + encoded).digest('base64url');
}
function resign(cursor, mutate, namespace) {
  const value = JSON.parse(Buffer.from(cursor.split('.')[0],'base64url'));
  mutate(value);
  const encoded = Buffer.from(JSON.stringify(value)).toString('base64url');
  return encoded + '.' + sign(encoded,namespace);
}

test('catalog keeps first deadline across limit changes and finishes stable keys without duplicates', () => {
  const first = paginateCatalog(rows,opts);
  const late = {...opts, now:opts.now + 14*60*1000, limit:2, cursor:first.next_cursor};
  const second = paginateCatalog(rows,late);
  assert.deepEqual(second.items,rows.slice(1,3));
  const last = paginateCatalog(rows,{...late,cursor:second.next_cursor,limit:50,now:opts.now+ttl-1});
  assert.deepEqual(last.items,rows.slice(3)); assert.equal(last.next_cursor,null);
  assert.deepEqual([...first.items,...second.items,...last.items],rows);
  assert.throws(()=>paginateCatalog(rows,{...late,cursor:second.next_cursor,now:opts.now+ttl}),invalid);
  const fresh = paginateCatalog(rows,{...opts,now:opts.now+ttl});
  assert.deepEqual(fresh.items,first.items); assert.notEqual(fresh.next_cursor,first.next_cursor);
});

test('regions filter by parent and bind the entire fresh catalog including other parents', () => {
  const regions = [
    {code:'330101',name:'one',parent_code:'330100'},
    {code:'330102',name:'two',parent_code:'330100'},
    {code:'330201',name:'other',parent_code:'330200'},
  ];
  const options = {...opts,kind:'regions',parentCode:'330100'};
  const first = paginateCatalog(regions,options);
  assert.deepEqual(first.items,[regions[0]]);
  const second = paginateCatalog(regions,{...options,cursor:first.next_cursor});
  assert.deepEqual(second.items,[regions[1]]); assert.equal(second.next_cursor,null);
  assert.throws(()=>paginateCatalog(regions,{...options,parentCode:'330200',cursor:first.next_cursor}),invalid);
  const changed = [...regions.slice(0,2),{...regions[2],name:'changed outside filter'}];
  assert.throws(()=>paginateCatalog(changed,{...options,cursor:first.next_cursor}),invalid);
});

test('catalog binding rejects different user, epoch, kind, filter, signing key and current snapshot', () => {
  const cursor = paginateCatalog(rows,opts).next_cursor;
  for (const change of [{userId:'other'},{authEpoch:2},{kind:'regions'},{parentCode:'330100'},{hmacKey:'other-key'}]) {
    assert.throws(()=>paginateCatalog(rows,{...opts,...change,cursor}),invalid);
  }
  assert.throws(()=>paginateCatalog([...rows,{id:'f',name:'f'}],{...opts,cursor}),invalid);
});

test('strict signed payload rejects unknown/missing fields, versions, sort, absent key and invalid deadlines', () => {
  const cursor = paginateCatalog(rows,opts).next_cursor;
  for (const mutate of [v=>{v.extra=true},v=>{delete v.v},v=>{v.v=2},v=>{v.sort='reverse'},
    v=>{v.after='not-present'},v=>{v.after=null},v=>{v.expires=opts.now},v=>{v.expires=opts.now+ttl+1},v=>{v.expires+=0.5},
    v=>{v.filter={}},v=>{v.auth_epoch='1'}]) {
    assert.throws(()=>paginateCatalog(rows,{...opts,cursor:resign(cursor,mutate)}),invalid);
  }
});

test('catalog namespace excludes legacy and other signed list cursors', () => {
  const cursor = paginateCatalog(rows,opts).next_cursor;
  for (const namespace of ['', 'knowledge-list/v1\n','consent-list/v1\n']) {
    assert.throws(()=>paginateCatalog(rows,{...opts,cursor:resign(cursor,()=>{},namespace)}),invalid);
  }
});

test('signature and payload use canonical base64url; malformed tokens fail closed', () => {
  const cursor = paginateCatalog(rows,opts).next_cursor;
  const [encoded, signature] = cursor.split('.');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const alias = signature.slice(0,-1) + alphabet[alphabet.indexOf(signature.at(-1)) ^ 1];
  assert.deepEqual(Buffer.from(signature,'base64url'),Buffer.from(alias,'base64url'),'same decoded bytes negative control');
  for (const changed of [null,{},'',cursor+'.extra',cursor+'=',encoded+'.'+alias,encoded+'=.'+sign(encoded+'='),
    'a'.repeat(2049),encoded+'.'+signature.slice(1),encoded.slice(1)+'.'+signature]) {
    assert.throws(()=>paginateCatalog(rows,{...opts,cursor:changed}),invalid);
  }
  for (const value of [null,[],{v:1}]) {
    const part = Buffer.from(JSON.stringify(value)).toString('base64url');
    assert.throws(()=>paginateCatalog(rows,{...opts,cursor:part+'.'+sign(part)}),invalid);
  }
});

test('empty/end pages return null; invalid limits and missing signing configuration are rejected', () => {
  assert.deepEqual(paginateCatalog([],opts),{items:[],next_cursor:null});
  assert.deepEqual(paginateCatalog(rows,{...opts,limit:50}),{items:rows,next_cursor:null});
  for (const limit of [0,51,1.5,NaN,Infinity,'1']) assert.throws(()=>paginateCatalog(rows,{...opts,limit}),e=>e.code==='INVALID_REQUEST');
  assert.throws(()=>paginateCatalog(rows,{...opts,hmacKey:''}),e=>e.code==='PROVIDER_UNAVAILABLE');
});
