// Actual admin services/runtime; synthetic identities and stores, no HTTP/PG claim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdminContentService } from '../../services/api/src/admin/service.ts';
import { createAdminContentStore } from '../../services/api/src/admin/store.ts';
import { idempotencyScope, idempotencyKeyHashHex, idempotencyRequestHash } from '../../services/api/src/auth/idempotency.ts';
import { FAMILY_CASES, context, SIGNING_KEY } from './admin-fixtures.mjs';
import { createOpsHarness, opsContext, OPS_SIGNING_KEY } from './admin-ops-fixtures.mjs';

const START = Date.parse('2026-10-13T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
function clock() { let ms = START; return { now: () => new Date(ms), set: value => { ms = value; } }; }
function receipt(runtime, ctx, method, path) {
  const scope = idempotencyScope(ctx.identity.userId, method, path);
  return runtime.findIdempotent(scope, idempotencyKeyHashHex(scope, ctx.idempotencyKey));
}
async function hold(runtime) {
  let unlock, entered;
  const active = new Promise(resolve => { entered = resolve; });
  const blocked = runtime.transaction(async () => { entered(); await new Promise(resolve => { unlock = resolve; }); });
  await active;
  return { blocked, release: () => unlock() };
}

for (const family of FAMILY_CASES) {
  test(`${family.name}: default 24h receipt, replay does not slide, exact expiry creates new draft`, async () => {
    const time = clock(), store = createAdminContentStore();
    const service = createAdminContentService({ store, now: time.now, signingKey: SIGNING_KEY });
    const ctx = context({ idempotencyKey: `ttl-${family.name}-0001` }), body = family.contentInput();
    const invoke = () => family.ops(service).create(ctx, body);
    const first = await invoke();
    assert.equal(first.status, 201);
    const initial = receipt(store, ctx, 'POST', family.descriptor.path);
    assert.equal(initial.expiresAt.getTime(), START + DAY);
    for (const at of [START + 6 * 60 * 1000, START + DAY - 1]) {
      time.set(at);
      assert.deepEqual(await invoke(), first);
      await assert.rejects(family.ops(service).create(ctx, family.editedInput()), e => e.code === 'IDEMPOTENCY_CONFLICT');
      assert.equal(store.listEntities(family.descriptor.family, ctx.identity.userId).length, 1);
      assert.equal(receipt(store, ctx, 'POST', family.descriptor.path).expiresAt.getTime(), START + DAY);
    }
    time.set(START + DAY);
    const next = await invoke();
    assert.equal(next.status, 201); assert.notEqual(next.body.data.id, first.body.data.id);
    assert.equal(store.listEntities(family.descriptor.family, ctx.identity.userId).length, 2);
    assert.equal(store.idempotentCount(), 1, 'expired original physically removed, only new receipt retained');
    assert.equal(receipt(store, ctx, 'POST', family.descriptor.path).expiresAt.getTime(), START + 2 * DAY);
  });
}

test('ops default 24h: retain one effect/audit, expire before checking current revision, failed claim releases', async () => {
  const time = clock(), h = createOpsHarness({ now: time.now });
  const ctx = opsContext({ idempotencyKey: 'ops-default-ttl-0001', ifMatch: '"1"' });
  const body = { enabled: true, reason: 'Synthetic TTL regression' };
  const first = await h.service.setFlag(ctx, 'ai_enabled', body);
  assert.equal(receipt(h.store.runtime, ctx, 'PUT', '/admin/feature-flags/ai_enabled').expiresAt.getTime(), START + DAY);
  time.set(START + 6 * 60 * 1000);
  assert.deepEqual(await h.service.setFlag(ctx, 'ai_enabled', body), first);
  assert.equal(h.store.getFlag('ai_enabled').revision, 2); assert.equal(h.store.audit.count(), 1);
  time.set(START + DAY);
  await assert.rejects(h.service.setFlag(ctx, 'ai_enabled', body), e => e.code === 'REVISION_CONFLICT');
  assert.equal(h.store.audit.count(), 1, 'expiry/failure does not record a success');
  assert.equal(h.store.runtime.idempotentCount(), 0, 'expired row removed and failed new pending claim released');
  const next = await h.service.setFlag({ ...ctx, ifMatch: '"2"' }, 'ai_enabled', { enabled: false, reason: 'Synthetic fresh version' });
  assert.equal(next.status, 200); assert.equal(h.store.getFlag('ai_enabled').revision, 3);
  assert.equal(h.store.audit.count(), 2); assert.equal(h.store.runtime.idempotentCount(), 1);
});

test('explicit short TTL: completed receipt must expire even when no caller manually purges', async () => {
  const time = clock(), h = createOpsHarness({ now: time.now, idempotencyTtlSeconds: 2 });
  const ctx = opsContext({ idempotencyKey: 'ops-short-ttl-0001', ifMatch: '"1"' });
  const body = { enabled: true, reason: 'Synthetic explicit TTL' };
  const first = await h.service.setFlag(ctx, 'ai_enabled', body);
  time.set(START + 1999); assert.deepEqual(await h.service.setFlag(ctx, 'ai_enabled', body), first);
  time.set(START + 2000);
  await assert.rejects(h.service.setFlag(ctx, 'ai_enabled', body), e => e.code === 'REVISION_CONFLICT');
  assert.equal(h.store.runtime.idempotentCount(), 0); assert.equal(h.store.audit.count(), 1);
});

test('queue wait: expiry uses time after lock acquisition, not stale enqueue time', async () => {
  const time = clock(), h = createOpsHarness({ now: time.now });
  const ctx = opsContext({ idempotencyKey: 'ops-queued-old-0001', ifMatch: '"1"' });
  const body = { enabled: true, reason: 'Synthetic queue regression' };
  await h.service.setFlag(ctx, 'ai_enabled', body);
  const barrier = await hold(h.store.runtime);
  try {
    const queued = h.service.setFlag(ctx, 'ai_enabled', body).then(value => ({ value }), error => ({ error }));
    time.set(START + DAY); barrier.release(); await barrier.blocked;
    const result = await queued;
    assert.equal(result.error?.code, 'REVISION_CONFLICT', 'receipt that expired while queued cannot replay old success');
    assert.equal(h.store.runtime.idempotentCount(), 0); assert.equal(h.store.audit.count(), 1);
  } finally { barrier.release(); await barrier.blocked; }
});

test('queue wait: newly accepted write gets its full TTL after acquiring lock', async () => {
  const time = clock(), store = createAdminContentStore();
  const service = createAdminContentService({ store, now: time.now, signingKey: SIGNING_KEY });
  const ctx = context({ idempotencyKey: 'content-queued-new-0001' });
  const barrier = await hold(store);
  try {
    const queued = service.createSourceDraft(ctx, FAMILY_CASES[0].contentInput());
    time.set(START + 12 * 60 * 60 * 1000); barrier.release(); await barrier.blocked;
    assert.equal((await queued).status, 201);
    assert.equal(receipt(store, ctx, 'POST', '/admin/sources').expiresAt.getTime(), START + 12 * 60 * 60 * 1000 + DAY);
  } finally { barrier.release(); await barrier.blocked; }
});

test('unexpired pending retains conflict/in-progress checks, expired pending is cleaned before retry', async () => {
  const time = clock(), h = createOpsHarness({ now: time.now });
  const ctx = opsContext({ idempotencyKey: 'ops-pending-ttl-0001', ifMatch: '"1"' });
  const body = { enabled: true, reason: 'Synthetic pending fixture' };
  const scope = idempotencyScope(ctx.identity.userId, 'PUT', '/admin/feature-flags/ai_enabled');
  const keyHash = idempotencyKeyHashHex(scope, ctx.idempotencyKey);
  h.store.runtime.claimIdempotent(scope, keyHash, { requestHash: idempotencyRequestHash(body, ctx.ifMatch, OPS_SIGNING_KEY),
    responseStatus: 200, expiresAt: new Date(START + 2000), now: time.now() });
  await assert.rejects(h.service.setFlag(ctx, 'ai_enabled', body), e => e.code === 'REQUEST_IN_PROGRESS');
  await assert.rejects(h.service.setFlag(ctx, 'ai_enabled', { ...body, reason: 'Different' }), e => e.code === 'IDEMPOTENCY_CONFLICT');
  assert.equal(h.store.audit.count(), 0);
  time.set(START + 2000);
  assert.equal((await h.service.setFlag(ctx, 'ai_enabled', body)).status, 200);
  assert.equal(h.store.audit.count(), 1); assert.equal(h.store.runtime.idempotentCount(), 1);
});

test('TTL does not bypass current scope check or erase existing immutable audit', async () => {
  const time = clock(), h = createOpsHarness({ now: time.now });
  const ctx = opsContext({ idempotencyKey: 'ops-permission-ttl-0001', ifMatch: '"1"' });
  const body = { enabled: true, reason: 'Synthetic scope regression' };
  await h.service.setFlag(ctx, 'ai_enabled', body);
  const audit = h.store.audit.list();
  time.set(START + 6 * 60 * 1000);
  await assert.rejects(h.service.setFlag({ ...ctx, identity: { ...ctx.identity, scopes: [] } }, 'ai_enabled', body), e => e.code === 'SCOPE_DENIED');
  assert.equal(h.store.audit.count(), 1); assert.deepEqual(h.store.audit.list(), audit);
  assert.equal(h.store.getFlag('ai_enabled').revision, 2);
});

test('late/repeated release cannot erase a completed receipt or create a second draft on replay', async () => {
  const time = clock(), store = createAdminContentStore();
  const service = createAdminContentService({ store, now: time.now, signingKey: SIGNING_KEY });
  const ctx = context({ idempotencyKey: 'content-late-release-0001' });
  const body = FAMILY_CASES[0].contentInput();
  const first = await service.createSourceDraft(ctx, body);
  const scope = idempotencyScope(ctx.identity.userId, 'POST', '/admin/sources');
  const hash = idempotencyKeyHashHex(scope, ctx.idempotencyKey);
  time.set(START + 6 * 60 * 1000);
  store.releaseIdempotent(scope, hash); store.releaseIdempotent(scope, hash);
  assert.deepEqual(await service.createSourceDraft(ctx, body), first);
  assert.equal(store.listEntities(FAMILY_CASES[0].descriptor.family, ctx.identity.userId).length, 1);
  assert.equal(store.idempotentCount(), 1);
});
