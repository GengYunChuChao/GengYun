import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { paginateKnowledge } from '../../services/api/src/knowledge/pagination.ts';

const rows = [1, 2, 3, 4].map(n => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  body: `Synthetic body ${n}`, source_revision: 1, content_hash: 'a'.repeat(64) }));
const start = Date.parse('2026-10-13T00:00:00Z');
const options = { userId: 'synthetic-user-a', authEpoch: 1, hmacKey: 'synthetic-knowledge-cursor-key',
  filter: { q: null, crop_id: null }, snapshot: rows, limit: 1, now: start };
const page = (overrides = {}, items = rows) => paginateKnowledge(items, { ...options, ...overrides });
const decode = token => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
function sign(value, namespace = 'knowledge-list/v1\n') {
  const encoded = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encoded}.${createHmac('sha256', options.hmacKey).update(namespace + encoded).digest('base64url')}`;
}
const rejects = overrides => assert.throws(() => page(overrides), error => error.code === 'INVALID_CURSOR');

test('knowledge chain keeps first 15min deadline across slow pages and variable limit', () => {
  const first = page();
  assert.equal(decode(first.next_cursor).expires, start + 15 * 60 * 1000);
  const second = page({ cursor: first.next_cursor, now: start + 14 * 60 * 1000 });
  assert.equal(second.items[0].id, rows[1].id);
  assert.equal(decode(second.next_cursor).expires, decode(first.next_cursor).expires);
  const last = page({ cursor: second.next_cursor, limit: 2, now: start + 15 * 60 * 1000 - 1 });
  assert.deepEqual(last.items, rows.slice(2));
  assert.equal(last.next_cursor, null);
  rejects({ cursor: second.next_cursor, now: start + 15 * 60 * 1000 });
  assert.deepEqual(page({ limit: 50 }).items, rows);
  assert.deepEqual(page({}, []), { items: [], next_cursor: null });
});

test('knowledge cursor binds current principal, auth epoch, filter and signing key', () => {
  const cursor = page().next_cursor;
  for (const override of [{ userId: 'synthetic-user-b' }, { authEpoch: 2 },
    { filter: { q: 'changed', crop_id: null } }, { hmacKey: 'another-synthetic-key' }]) rejects({ cursor, ...override });
});

test('knowledge cursor binds full fresh source and body snapshot, including rows outside current filter', () => {
  const cursor = page({}, rows.slice(0, 2)).next_cursor;
  for (const field of ['body', 'source_revision', 'content_hash']) {
    const changed = structuredClone(rows);
    changed[3][field] = field === 'source_revision' ? 2 : 'changed';
    assert.throws(() => page({ cursor, snapshot: changed }, rows.slice(0, 2)), e => e.code === 'INVALID_CURSOR');
  }
});

test('knowledge signed malformed fields and unknown versions cannot bypass bindings', () => {
  const value = decode(page().next_cursor);
  for (const change of [{ v: 2 }, { kind: 'consents' }, { sort: 'id_desc' }, { after: 'not-uuid' },
    { after: rows[3].id.replace(/4$/, '9') }, { expires: start }, { expires: start + 15 * 60 * 1000 + 1 },
    { expires: start + 0.5 }, { filter: null }, { extra: 'unexpected' }]) rejects({ cursor: sign({ ...value, ...change }) });
  const missing = { ...value }; delete missing.auth_epoch;
  rejects({ cursor: sign(missing) });
  for (const malformed of [null, [], 'text', 123]) rejects({ cursor: sign(malformed) });
});

test('knowledge rejects legacy/domain-reused signatures, malformed encoding and oversized cursors', () => {
  const token = page().next_cursor;
  const value = decode(token);
  for (const namespace of ['', 'consent-list/v1\n']) rejects({ cursor: sign(value, namespace) });
  const [encoded, signature] = token.split('.');
  for (const cursor of ['', 'broken', token + '.extra', token + 'x', `${encoded}=.${signature}`, `${encoded}.${signature}=`,
    'a'.repeat(2049)]) rejects({ cursor });
  // Different last base64url bits decode to the same MAC bytes, but are not canonical.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const index = alphabet.indexOf(signature.at(-1));
  const alias = signature.slice(0, -1) + alphabet[index + 1];
  assert.deepEqual(Buffer.from(alias, 'base64url'), Buffer.from(signature, 'base64url'));
  rejects({ cursor: `${encoded}.${alias}` });
});

test('knowledge validates page limits and missing signing configuration', () => {
  for (const limit of [0, 51, 1.5, '1']) assert.throws(() => page({ limit }), e => e.code === 'INVALID_REQUEST');
  assert.throws(() => page({ hmacKey: '' }), e => e.code === 'PROVIDER_UNAVAILABLE');
});
