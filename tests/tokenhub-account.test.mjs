import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyTokenHub } from '../tools/verify-tokenhub.mjs';
test('TokenHub checks only fixed read-only endpoint; secrets and raw metadata stay hidden', async () => {
  let count = 0;
  const fakeKey = 'synthetic-tokenhub-key-value';
  const report = await verifyTokenHub({ key: fakeKey, fetchImpl: async (url, opts) => {
    count++; assert.equal(url, 'https://tokenhub.tencentmaas.com/v1/models'); assert.equal(opts.method, 'GET'); assert.equal(opts.redirect, 'manual'); assert.equal(opts.body, undefined);
    return count === 1 ? { ok: true, status: 200, json: async () => ({ data: [{ id: 'hy-vision-2.0-instruct', sensitive: 'private-account' }] }) } : { ok: false, status: 401 };
  } });
  assert.equal(count, 2); assert.equal(report.authentication.state, 'MODEL_LIST_AUTHENTICATED'); assert.equal(report.authentication.selectedVisionModelListed, true); assert.equal(report.controlledBadKey.state, 'ACCESS_REJECTED'); assert.equal(report.inferenceRequests, 0); assert.equal(report.quotaVerified, false);
  for (const value of [fakeKey, 'private-account']) assert.equal(JSON.stringify(report).includes(value), false);
});
test('missing key is zero requests; redirects, wrong schema and sensitive exceptions never become authentication success', async () => {
  let count = 0; const report = await verifyTokenHub({ fetchImpl: async () => { count++; } }); assert.equal(count, 0); assert.equal(report.authentication.state, 'MISSING_OR_INVALID_KEY');
  for (const fetchImpl of [async () => ({ ok: false, status: 302 }), async () => ({ ok: true, status: 200, json: async () => ({ data: 'sensitive-response' }) }), async () => { throw new Error('sensitive-key'); }]) {
    const failed = await verifyTokenHub({ key: 'synthetic-tokenhub-key-value', fetchImpl }); assert.notEqual(failed.authentication.state, 'MODEL_LIST_AUTHENTICATED'); assert.equal(JSON.stringify(failed).includes('sensitive'), false);
  }
});
