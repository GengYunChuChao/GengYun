import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { paginateConsentRecords } from '../../services/api/src/privacy/consent-pagination.ts';

const NOW = Date.parse('2026-10-13T04:00:00Z');
const KEY = 'synthetic-consent-cursor-signing-key';
const USER = '11111111-1111-4111-8111-111111111111';
const records = [3, 2, 1].map(n => ({ id: `00000000-0000-4000-8000-00000000000${n}`, revision: 1, state: 'granted' }));
const page = (extra = {}, items = records) => paginateConsentRecords(items, {
  userId: USER, authEpoch: 1, hmacKey: KEY, limit: 1, now: NOW, ...extra,
});
const invalid = action => assert.throws(action, error => error.code === 'INVALID_CURSOR' && error.status === 400);
const sign = value => createHmac('sha256', KEY).update(`consent-list/v1\n${value}`).digest('base64url');
function rewrite(cursor, change) {
  const value = JSON.parse(Buffer.from(cursor.split('.')[0], 'base64url').toString());
  change(value);
  const encoded = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encoded}.${sign(encoded)}`;
}

test('正常翻页遵循当前快照次序，允许改变 limit，空列表/尾页以 null 结束', () => {
  const first = page();
  assert.equal(first.items[0].id, records[0].id);
  assert.ok(first.next_cursor.length <= 2048);
  const rest = page({ cursor: first.next_cursor, limit: 2 });
  assert.deepEqual(rest.items.map(item => item.id), records.slice(1).map(item => item.id));
  assert.equal(rest.next_cursor, null);
  assert.deepEqual(page({}, []), { items: [], next_cursor: null });
});

test('游标绑定服务端主体/身份版本/签名密钥，其他用户或登录版本不能借用', () => {
  const cursor = page().next_cursor;
  for (const extra of [{ userId: '22222222-2222-4222-8222-222222222222' }, { authEpoch: 2 }, { hmacKey: KEY + '-other' }]) {
    invalid(() => page({ cursor, ...extra }));
  }
});

test('篡改正文/签名、旧 UUID 游标、异常编码和超长游标均拒绝', () => {
  const cursor = page().next_cursor;
  const [encoded, signature] = cursor.split('.');
  const changed = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(encoded, 'base64url')), user: 'forged' })).toString('base64url');
  for (const value of [
    `${changed}.${signature}`, `${encoded}.${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`,
    Buffer.from(records[0].id).toString('base64url'), cursor + '.extra', 'invalid', 'x'.repeat(2049),
    `${encoded}=.${signature}`, `${encoded}.${signature}=`,
  ]) invalid(() => page({ cursor: value }));
});

test('15分钟截止严格生效，连续翻页不延长原游标有效期', () => {
  const cursor = page().next_cursor;
  const second = page({ cursor, now: NOW + 60_000 });
  assert.equal(JSON.parse(Buffer.from(second.next_cursor.split('.')[0], 'base64url')).expires, NOW + 15 * 60_000);
  invalid(() => page({ cursor, now: NOW + 15 * 60_000 }));
  invalid(() => page({ cursor: second.next_cursor, now: NOW + 15 * 60_000 }));
});

test('新增/撤回/版本/接收方或排列变化使旧水位失效，不继续漏项或复用旧授权', () => {
  const cursor = page().next_cursor;
  for (const items of [
    records.slice(1), [...records, { id: '00000000-0000-4000-8000-000000000004', revision: 1 }],
    records.map((r, i) => i === 1 ? { ...r, revision: 2, state: 'withdrawn' } : r),
    records.map((r, i) => i === 1 ? { ...r, recipient_ids: ['changed'] } : r), [...records].reverse(),
  ]) invalid(() => page({ cursor }, items));
});

test('即使合法签名，错误用途/过滤/排序/版本/锚点/额外字段仍拒绝', () => {
  const cursor = page().next_cursor;
  for (const change of [
    v => { v.kind = 'knowledge'; }, v => { v.filter = 'forged'; }, v => { v.sort = 'id_asc'; },
    v => { v.v = 2; }, v => { v.after = '00000000-0000-4000-8000-000000000009'; },
    v => { v.owner = 'forged'; }, v => { delete v.auth_epoch; }, v => { v.expires = 'not-a-number'; },
  ]) invalid(() => page({ cursor: rewrite(cursor, change) }));
});

test('非法分页大小和缺失签名配置明确拒绝', () => {
  for (const limit of [0, 51, 1.5]) assert.throws(() => page({ limit }), error => error.code === 'INVALID_REQUEST');
  assert.throws(() => page({ hmacKey: '' }), error => error.code === 'PROVIDER_UNAVAILABLE');
});
