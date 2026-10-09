import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMediaService } from '../../packages/media/service.mjs';
import { sha256Hex } from '../../packages/media/validate.mjs';
import { jpegWithExif, wavBytes } from './_fixtures.mjs';

function expectCode(fn, code) {
  try {
    fn();
  } catch (error) {
    assert.equal(error.code, code, `期望 ${code}，实得 ${error.code}: ${error.message}`);
    return error;
  }
  assert.fail(`应当抛出 ${code}，但未抛出`);
}

function makeService(startAt = 1_000_000) {
  let now = startAt;
  const svc = createMediaService({ tokenSecret: 'unit-test-secret-0123456789', clock: () => now });
  return { svc, advance: (ms) => { now += ms; }, setNow: (t) => { now = t; } };
}

const jpeg = jpegWithExif();
const jpegSha = sha256Hex(jpeg);
const wav = wavBytes();
const wavSha = sha256Hex(wav);

function declareImage() {
  return { purpose: 'weed_recognition', mime: 'image/jpeg', bytes: jpeg.length, sha256: jpegSha };
}

test('initiateUpload：初始 initiated / revision=1 / 返回上传授权', () => {
  const { svc } = makeService();
  const grant = svc.initiateUpload({ ownerId: 'u1', input: declareImage(), idempotencyKey: 'k1' });
  assert.equal(grant.media.state, 'initiated');
  assert.equal(grant.media.revision, 1);
  assert.equal(grant.upload.method, 'PUT');
  assert.match(grant.upload.url, /^https:\/\//);
  assert.ok(grant.upload.access_token.length > 0);
});

test('缺会话 -> SESSION_REQUIRED；缺幂等键 -> IDEMPOTENCY_KEY_REQUIRED', () => {
  const { svc } = makeService();
  expectCode(() => svc.initiateUpload({ ownerId: '', input: declareImage(), idempotencyKey: 'k' }), 'SESSION_REQUIRED');
  expectCode(() => svc.initiateUpload({ ownerId: 'u1', input: declareImage(), idempotencyKey: '' }), 'IDEMPOTENCY_KEY_REQUIRED');
});

test('completeUpload：initiated → ready，revision 自增，图片生成去元数据衍生件', () => {
  const { svc } = makeService();
  const { media } = svc.initiateUpload({ ownerId: 'u1', input: declareImage(), idempotencyKey: 'k1' });
  const done = svc.completeUpload({
    ownerId: 'u1',
    mediaId: media.id,
    ifMatch: '"1"',
    input: { sha256: jpegSha, bytes: jpeg.length },
    body: jpeg,
    idempotencyKey: 'k1c',
  });
  assert.equal(done.state, 'ready');
  assert.equal(done.revision, 2);
  const st = svc.stats();
  assert.equal(st.objectCount, 2, '原始 + 去EXIF衍生件');
});

test('completeUpload：If-Match 缺失 428 / 不匹配 409', () => {
  const { svc } = makeService();
  const { media } = svc.initiateUpload({ ownerId: 'u1', input: declareImage(), idempotencyKey: 'k1' });
  const base = { ownerId: 'u1', mediaId: media.id, input: { sha256: jpegSha, bytes: jpeg.length }, body: jpeg, idempotencyKey: 'x' };
  expectCode(() => svc.completeUpload({ ...base }), 'REVISION_REQUIRED');
  expectCode(() => svc.completeUpload({ ...base, ifMatch: '"9"' }), 'REVISION_CONFLICT');
});

test('completeUpload：非本人 / 不存在统一 404', () => {
  const { svc } = makeService();
  const { media } = svc.initiateUpload({ ownerId: 'u1', input: declareImage(), idempotencyKey: 'k1' });
  expectCode(
    () => svc.completeUpload({ ownerId: 'u2', mediaId: media.id, ifMatch: '"1"', input: { sha256: jpegSha, bytes: jpeg.length }, body: jpeg, idempotencyKey: 'z' }),
    'NOT_FOUND',
  );
  expectCode(
    () => svc.completeUpload({ ownerId: 'u1', mediaId: '00000000-0000-0000-0000-000000000000', ifMatch: '"1"', input: { sha256: jpegSha, bytes: jpeg.length }, body: jpeg, idempotencyKey: 'z' }),
    'NOT_FOUND',
  );
});

test('completeUpload：声明与初始化不一致 -> INVALID_REQUEST', () => {
  const { svc } = makeService();
  const { media } = svc.initiateUpload({ ownerId: 'u1', input: declareImage(), idempotencyKey: 'k1' });
  expectCode(
    () => svc.completeUpload({ ownerId: 'u1', mediaId: media.id, ifMatch: '"1"', input: { sha256: 'a'.repeat(64), bytes: jpeg.length }, body: jpeg, idempotencyKey: 'q' }),
    'INVALID_REQUEST',
  );
});

test('幂等：同键同内容返回同一媒体；同键异内容 -> IDEMPOTENCY_CONFLICT', () => {
  const { svc } = makeService();
  const a = svc.initiateUpload({ ownerId: 'u1', input: declareImage(), idempotencyKey: 'dup' });
  const b = svc.initiateUpload({ ownerId: 'u1', input: declareImage(), idempotencyKey: 'dup' });
  assert.equal(a.media.id, b.media.id);
  expectCode(
    () => svc.initiateUpload({ ownerId: 'u1', input: { ...declareImage(), bytes: 12 }, idempotencyKey: 'dup' }),
    'IDEMPOTENCY_CONFLICT',
  );
});

test('音频完成：initiated → ready，不产生衍生件', () => {
  const { svc } = makeService();
  const { media } = svc.initiateUpload({
    ownerId: 'u1',
    input: { purpose: 'voice_question', mime: 'audio/wav', bytes: wav.length, duration_ms: 5000, sha256: wavSha },
    idempotencyKey: 'v1',
  });
  const done = svc.completeUpload({
    ownerId: 'u1',
    mediaId: media.id,
    ifMatch: '"1"',
    input: { sha256: wavSha, bytes: wav.length },
    body: wav,
    idempotencyKey: 'v1c',
  });
  assert.equal(done.state, 'ready');
  assert.equal(svc.stats().objectCount, 1, '音频仅原始对象');
});

test('deleteMedia：ready → deleted，对象回收 + revision 自增', () => {
  const { svc } = makeService();
  const { media } = svc.initiateUpload({ ownerId: 'u1', input: declareImage(), idempotencyKey: 'k1' });
  svc.completeUpload({ ownerId: 'u1', mediaId: media.id, ifMatch: '"1"', input: { sha256: jpegSha, bytes: jpeg.length }, body: jpeg, idempotencyKey: 'k1c' });
  const ack = svc.deleteMedia({ ownerId: 'u1', mediaId: media.id, ifMatch: '"2"' });
  assert.equal(ack.deleted, true);
  assert.equal(ack.revision, 3);
  assert.equal(svc.stats().objectCount, 0, '删除后无对象');
  assert.equal(svc.getMedia({ ownerId: 'u1', mediaId: media.id }).state, 'deleted');
});

test('过期回收：initiated 超 24h -> rejected(expired)，对象清理', () => {
  const { svc, advance } = makeService();
  const { media } = svc.initiateUpload({ ownerId: 'u1', input: declareImage(), idempotencyKey: 'k1' });
  advance(24 * 60 * 60 * 1000 + 1);
  const res = svc.expireInitiated();
  assert.equal(res.expired, 1);
  const rec = svc.getMedia({ ownerId: 'u1', mediaId: media.id });
  assert.equal(rec.state, 'rejected');
  assert.equal(rec.failure_code, 'expired');
  const cleaned = svc.cleanupOrphans();
  assert.equal(svc.stats().objectCount, 0);
  assert.equal(svc.stats().grantCount, 0);
  void cleaned;
});

test('日志安全：日志事件经脱敏，不含媒体引用/token', () => {
  const events = [];
  const svc = createMediaService({ tokenSecret: 'unit-test-secret-0123456789', logger: (e) => events.push(e) });
  const { media } = svc.initiateUpload({ ownerId: 'u1', input: declareImage(), idempotencyKey: 'k1' });
  svc.completeUpload({ ownerId: 'u1', mediaId: media.id, ifMatch: '"1"', input: { sha256: jpegSha, bytes: jpeg.length }, body: jpeg, idempotencyKey: 'k1c' });
  const text = JSON.stringify(events);
  assert.equal(text.includes('obj_'), false, '日志不得含对象引用');
  assert.ok(text.includes('media.complete'));
});
