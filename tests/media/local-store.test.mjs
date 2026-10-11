import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync,
  renameSync, symlinkSync, linkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { createPrivateLocalObjectStore } from '../../packages/media/local-store.mjs';
import { createMediaService } from '../../packages/media/service.mjs';
import { sha256Hex } from '../../packages/media/validate.mjs';
import { pngWithExif, pngWithTrailingExif, wavBytes } from './_fixtures.mjs';

function fixture(t, maxBytes) {
  const top = mkdtempSync(join(tmpdir(), 'gengyun-synthetic-media-'));
  t.after(() => rmSync(top, { recursive: true, force: true }));
  const root = join(top, 'private');
  return { top, root, store: createPrivateLocalObjectStore({ rootDir: root, maxBytes }) };
}
const code = (fn, expected) => assert.throws(fn, error => error.code === expected);

test('actual synthetic bytes survive a new adapter; independent snapshots and disk deletion', t => {
  const { root, store } = fixture(t);
  const bytes = Buffer.from('SYNTHETIC NON-PERSONAL BYTES');
  const ref = store.put(bytes, 'application/octet-stream');
  assert.match(ref, /^obj_[A-Za-z0-9_-]{24}$/);
  assert.deepEqual(readFileSync(join(root, ref)), bytes);
  bytes.fill(0);
  const second = createPrivateLocalObjectStore({ rootDir: root });
  assert.equal(second.size, 1);
  const copy = second.get(ref); copy.fill(0);
  assert.equal(Buffer.from(store.get(ref)).toString(), 'SYNTHETIC NON-PERSONAL BYTES');
  assert.equal(second.delete(ref), true);
  assert.equal(store.has(ref), false);
  assert.equal(store.get(ref), null);
  assert.equal(store.delete(ref), false);
  assert.equal(store.size, 0);
  if (process.platform !== 'win32') {
    assert.equal(statSync(root).mode & 0o777, 0o700);
  }
});

test('strict references reject traversal, alternate streams, absolute paths and malformed names', t => {
  const { root, store } = fixture(t);
  for (const ref of ['../outside', '..\\outside', join(root, 'x'), 'obj_x:stream', 'obj_x%2f..', 'obj_' + 'a'.repeat(23), null]) {
    for (const operation of ['get', 'has', 'delete']) code(() => store[operation](ref), 'INVALID_REQUEST');
  }
  assert.equal(store.size, 0);
});

test('bounded storage rejects empty, non-byte, over-limit and invalid content metadata without files', t => {
  const { root, store } = fixture(t, 16);
  code(() => store.put(Buffer.alloc(17), 'image/png'), 'MEDIA_TOO_LARGE');
  code(() => store.put(Buffer.alloc(0), 'image/png'), 'INVALID_REQUEST');
  code(() => store.put([1, 2], 'image/png'), 'INVALID_REQUEST');
  code(() => store.put(Buffer.from([1]), ''), 'INVALID_REQUEST');
  assert.deepEqual(readdirSync(root), []);
  code(() => createPrivateLocalObjectStore({ rootDir: '.' }), 'INVALID_REQUEST');
  code(() => createPrivateLocalObjectStore({ rootDir: '//server/share/private' }), 'INVALID_REQUEST');
  code(() => createPrivateLocalObjectStore({ rootDir: parse(root).root }), 'INVALID_REQUEST');
  code(() => createPrivateLocalObjectStore({ rootDir: root, maxBytes: 10485761 }), 'INVALID_REQUEST');
});

test('root replacement or junction to an outside directory fails closed, without reading or deleting outside', t => {
  const { top, root, store } = fixture(t);
  const ref = store.put(Buffer.from('SYNTHETIC INSIDE'), 'image/png');
  const outside = join(top, 'outside'); mkdirSync(outside);
  writeFileSync(join(outside, ref), 'SYNTHETIC OUTSIDE');
  renameSync(root, join(top, 'original-private'));
  symlinkSync(outside, root, process.platform === 'win32' ? 'junction' : 'dir');
  for (const operation of ['get', 'has', 'delete']) code(() => store[operation](ref), 'OBJECT_UNAVAILABLE');
  code(() => store.put(Buffer.from('new'), 'image/png'), 'OBJECT_UNAVAILABLE');
  code(() => createPrivateLocalObjectStore({ rootDir: root }), 'OBJECT_UNAVAILABLE');
  code(() => createPrivateLocalObjectStore({ rootDir: join(root, 'child') }), 'OBJECT_UNAVAILABLE');
  assert.equal(readFileSync(join(outside, ref), 'utf8'), 'SYNTHETIC OUTSIDE');
});

test('object hardlinks, directory junctions and externally enlarged files are rejected', t => {
  const { top, root, store } = fixture(t, 32);
  const ref = store.put(Buffer.from('SYNTHETIC'), 'image/png');
  linkSync(join(root, ref), join(top, 'outside-hardlink'));
  for (const operation of ['get', 'has', 'delete']) code(() => store[operation](ref), 'OBJECT_UNAVAILABLE');
  rmSync(join(top, 'outside-hardlink'));
  rmSync(join(root, ref));
  const outside = join(top, 'outside'); mkdirSync(outside);
  symlinkSync(outside, join(root, ref), process.platform === 'win32' ? 'junction' : 'dir');
  code(() => store.get(ref), 'OBJECT_UNAVAILABLE');
  code(() => store.delete(ref), 'OBJECT_UNAVAILABLE');
  rmSync(join(root, ref));
  writeFileSync(join(root, ref), Buffer.alloc(33));
  code(() => store.get(ref), 'OBJECT_UNAVAILABLE');
  code(() => createPrivateLocalObjectStore({ rootDir: root, maxBytes: 32 }), 'OBJECT_UNAVAILABLE');
});

test('the dedicated root cannot contain foreign entries or directories', t => {
  const { root } = fixture(t);
  writeFileSync(join(root, 'not-an-object'), 'SYNTHETIC');
  code(() => createPrivateLocalObjectStore({ rootDir: root }), 'OBJECT_UNAVAILABLE');
});

test('reviewed media service uses real local raw/EXIF-clean derivative files and reclaims deletion', t => {
  const { root, store } = fixture(t);
  // Metadata/lifecycle remains the existing memory reference service, not a PG/HTTP claim.
  const svc = createMediaService({ store, tokenSecret: 'synthetic-test-only-no-production-key' });
  const body = pngWithExif();
  const input = { purpose: 'weed_recognition', mime: 'image/png', bytes: body.length, sha256: sha256Hex(body) };
  const g = svc.initiateUpload({ ownerId: 'synthetic-owner', input, idempotencyKey: 'synthetic-init' });
  const done = svc.completeUpload({ ownerId: 'synthetic-owner', mediaId: g.media.id, ifMatch: 1,
    input: { bytes: body.length, sha256: input.sha256 }, body, idempotencyKey: 'synthetic-complete' });
  assert.equal(done.state, 'ready'); assert.equal(store.size, 2);
  const grant = svc.grantOwnerAccess({ ownerId: 'synthetic-owner', mediaId: done.id, ifMatch: done.revision });
  const clean = svc.readOwnerContent({ ownerId: 'synthetic-owner', mediaId: done.id, token: grant.access_token });
  assert.equal(Buffer.from(clean.bytes).includes(Buffer.from('eXIf')), false);
  assert.ok(readdirSync(root).some(ref => Buffer.from(store.get(ref)).includes(Buffer.from('eXIf'))));
  svc.deleteMedia({ ownerId: 'synthetic-owner', mediaId: done.id, ifMatch: done.revision });
  assert.equal(store.size, 0); assert.deepEqual(readdirSync(root), []);
  code(() => svc.readOwnerContent({ ownerId: 'synthetic-owner', mediaId: done.id, token: grant.access_token }), 'NOT_FOUND');
});

test('malformed real bytes leave no local files, while valid synthetic WAV persists and reclaims', t => {
  const { store } = fixture(t);
  const svc = createMediaService({ store, tokenSecret: 'synthetic-test-only-no-production-key' });
  const bad = pngWithTrailingExif();
  const input = { purpose: 'weed_recognition', mime: 'image/png', bytes: bad.length, sha256: sha256Hex(bad) };
  const g = svc.initiateUpload({ ownerId: 'synthetic-owner', input, idempotencyKey: 'synthetic-bad' });
  assert.throws(() => svc.completeUpload({ ownerId: 'synthetic-owner', mediaId: g.media.id, ifMatch: 1,
    input: { bytes: bad.length, sha256: input.sha256 }, body: bad, idempotencyKey: 'synthetic-bad-complete' }));
  assert.equal(store.size, 0);
  const body = wavBytes();
  const voice = { purpose: 'voice_question', mime: 'audio/wav', bytes: body.length, sha256: sha256Hex(body), duration_ms: 1000 };
  const start = svc.initiateUpload({ ownerId: 'synthetic-owner', input: voice, idempotencyKey: 'synthetic-wav' });
  const done = svc.completeUpload({ ownerId: 'synthetic-owner', mediaId: start.media.id, ifMatch: 1,
    input: { bytes: body.length, sha256: voice.sha256 }, body, idempotencyKey: 'synthetic-wav-complete' });
  assert.equal(done.state, 'ready'); assert.equal(store.size, 1);
  svc.deleteMedia({ ownerId: 'synthetic-owner', mediaId: done.id, ifMatch: done.revision });
  assert.equal(store.size, 0);
});
