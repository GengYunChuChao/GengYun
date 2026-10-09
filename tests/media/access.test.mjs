import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMediaService } from '../../packages/media/service.mjs';
import { sha256Hex } from '../../packages/media/validate.mjs';
import { jpegWithExif } from './_fixtures.mjs';

function expectCode(fn, code) {
  try {
    fn();
  } catch (error) {
    assert.equal(error.code, code, `期望 ${code}，实得 ${error.code}: ${error.message}`);
    return error;
  }
  assert.fail(`应当抛出 ${code}，但未抛出`);
}

const jpeg = jpegWithExif();
const jpegSha = sha256Hex(jpeg);

function readyImage(svc, ownerId, purpose, key) {
  const { media } = svc.initiateUpload({
    ownerId,
    input: { purpose, mime: 'image/jpeg', bytes: jpeg.length, sha256: jpegSha },
    idempotencyKey: `${key}-i`,
  });
  return svc.completeUpload({
    ownerId,
    mediaId: media.id,
    ifMatch: '"1"',
    input: { sha256: jpegSha, bytes: jpeg.length },
    body: jpeg,
    idempotencyKey: `${key}-c`,
  });
}

/* --------------------------------------------------- 私有 owner 访问 */

test('owner 访问：未 ready 时 grantOwnerAccess -> OBJECT_UNAVAILABLE', () => {
  let now = 1_000_000;
  const svc = createMediaService({ tokenSecret: 'unit-test-secret-0123456789', clock: () => now });
  const { media } = svc.initiateUpload({
    ownerId: 'u1',
    input: { purpose: 'weed_recognition', mime: 'image/jpeg', bytes: jpeg.length, sha256: jpegSha },
    idempotencyKey: 'k',
  });
  expectCode(() => svc.grantOwnerAccess({ ownerId: 'u1', mediaId: media.id, ifMatch: '"1"' }), 'OBJECT_UNAVAILABLE');
  void now;
});

test('owner 访问：返回去 EXIF 衍生件，非本人 404，过期 404', () => {
  let now = 1_000_000;
  const svc = createMediaService({ tokenSecret: 'unit-test-secret-0123456789', clock: () => now });
  const done = readyImage(svc, 'u1', 'weed_recognition', 'r');
  const grant = svc.grantOwnerAccess({ ownerId: 'u1', mediaId: done.id, ifMatch: '"2"' });
  const read = svc.readOwnerContent({ ownerId: 'u1', mediaId: done.id, token: grant.access_token });
  assert.equal(read.contentType, 'image/jpeg');
  const text = Buffer.from(read.bytes).toString('latin1');
  assert.equal(text.includes('Exif'), false, '对外取图应为去 EXIF 衍生件');

  expectCode(() => svc.readOwnerContent({ ownerId: 'u2', mediaId: done.id, token: grant.access_token }), 'NOT_FOUND');

  now += 300000 + 1; // 超过 300 秒
  expectCode(() => svc.readOwnerContent({ ownerId: 'u1', mediaId: done.id, token: grant.access_token }), 'NOT_FOUND');
});

test('owner 访问：媒体删除后旧句柄 404（版本失效）', () => {
  const svc = createMediaService({ tokenSecret: 'unit-test-secret-0123456789' });
  const done = readyImage(svc, 'u1', 'weed_recognition', 'r');
  const grant = svc.grantOwnerAccess({ ownerId: 'u1', mediaId: done.id, ifMatch: '"2"' });
  svc.deleteMedia({ ownerId: 'u1', mediaId: done.id, ifMatch: '"2"' });
  expectCode(() => svc.readOwnerContent({ ownerId: 'u1', mediaId: done.id, token: grant.access_token }), 'NOT_FOUND');
});

/* --------------------------------------------------- 社区公开取图 */

function makeCommunityContext() {
  let now = 1_000_000;
  const state = { published: true, approved: true };
  let mediaRevision = null;
  const provider = {
    getPublishedContent({ type, id, revision }) {
      if (type !== 'post' || id !== 'p1') return null;
      if (!state.published || !state.approved) {
        return { published: state.published, approved: state.approved, revision, media: [], authorRevision: 1, avatarMedia: null };
      }
      return {
        published: true,
        approved: true,
        revision,
        media: [{ mediaId: mediaRevision.mediaId, mediaRevision: mediaRevision.revision }],
        authorRef: 'author-1',
        authorRevision: 5,
        avatarMedia: { mediaId: mediaRevision.mediaId, mediaRevision: mediaRevision.revision },
        publicPostingEpoch: 1,
      };
    },
  };
  const svc = createMediaService({ tokenSecret: 'unit-test-secret-0123456789', clock: () => now, contentProvider: provider });
  const done = readyImage(svc, 'author-1', 'community_image', 'c');
  mediaRevision = { mediaId: done.id, revision: done.revision };
  return { svc, done, state, setNow: (t) => { now = t; }, advance: (ms) => { now += ms; } };
}

test('社区取图：默认内容提供者关闭 -> 404', () => {
  const svc = createMediaService({ tokenSecret: 'unit-test-secret-0123456789' });
  const done = readyImage(svc, 'author-1', 'community_image', 'c');
  expectCode(
    () =>
      svc.grantCommunityAccess({
        requesterId: 'reader',
        sessionRef: 's1',
        input: { content_ref: { type: 'post', id: 'p1', revision: 3 }, media_ref: { media_id: done.id, media_revision: done.revision }, slot: 'attachment', author_revision: null },
      }),
    'NOT_FOUND',
  );
});

test('社区取图：公开已审内容可授权读取（附件）', () => {
  const { svc, done } = makeCommunityContext();
  const grant = svc.grantCommunityAccess({
    requesterId: 'reader',
    requesterAuthEpoch: 1,
    sessionRef: 's1',
    input: { content_ref: { type: 'post', id: 'p1', revision: 3 }, media_ref: { media_id: done.id, media_revision: done.revision }, slot: 'attachment', author_revision: null },
  });
  assert.match(grant.access.url, /^https:\/\//);
  const read = svc.readCommunityContent({ grantId: grant.grant_id, token: grant.access.access_token, requesterId: 'reader', sessionRef: 's1', authEpoch: 1 });
  assert.equal(Buffer.from(read.bytes).toString('latin1').includes('Exif'), false);
});

test('社区取图：内容下架后旧句柄 404（即使未过期）', () => {
  const { svc, done, state } = makeCommunityContext();
  const grant = svc.grantCommunityAccess({
    requesterId: 'reader',
    requesterAuthEpoch: 1,
    sessionRef: 's1',
    input: { content_ref: { type: 'post', id: 'p1', revision: 3 }, media_ref: { media_id: done.id, media_revision: done.revision }, slot: 'attachment', author_revision: null },
  });
  state.published = false;
  expectCode(() => svc.readCommunityContent({ grantId: grant.grant_id, token: grant.access.access_token, requesterId: 'reader', sessionRef: 's1', authEpoch: 1 }), 'NOT_FOUND');
});

test('社区取图：会话不符 -> SESSION_EXPIRED；句柄到期 -> 404', () => {
  const { svc, done, advance } = makeCommunityContext();
  const grant = svc.grantCommunityAccess({
    requesterId: 'reader',
    requesterAuthEpoch: 1,
    sessionRef: 's1',
    input: { content_ref: { type: 'post', id: 'p1', revision: 3 }, media_ref: { media_id: done.id, media_revision: done.revision }, slot: 'attachment', author_revision: null },
  });
  expectCode(
    () => svc.readCommunityContent({ grantId: grant.grant_id, token: grant.access.access_token, requesterId: 'reader', sessionRef: 's2', authEpoch: 1 }),
    'SESSION_EXPIRED',
  );
  advance(300000 + 1);
  expectCode(
    () => svc.readCommunityContent({ grantId: grant.grant_id, token: grant.access.access_token, requesterId: 'reader', sessionRef: 's1', authEpoch: 1 }),
    'NOT_FOUND',
  );
});

test('社区取图：非 community_image 用途的媒体 -> 404', () => {
  const { svc, state } = makeCommunityContext();
  const other = readyImage(svc, 'author-1', 'weed_recognition', 'o');
  void state;
  expectCode(
    () =>
      svc.grantCommunityAccess({
        requesterId: 'reader',
        sessionRef: 's1',
        input: { content_ref: { type: 'post', id: 'p1', revision: 3 }, media_ref: { media_id: other.id, media_revision: other.revision }, slot: 'attachment', author_revision: null },
      }),
    'NOT_FOUND',
  );
});

test('社区取图：头像槽需要 author_revision 一致', () => {
  const { svc, done } = makeCommunityContext();
  const grant = svc.grantCommunityAccess({
    requesterId: 'reader',
    requesterAuthEpoch: 1,
    sessionRef: 's1',
    input: { content_ref: { type: 'post', id: 'p1', revision: 3 }, media_ref: { media_id: done.id, media_revision: done.revision }, slot: 'author_avatar', author_revision: 5 },
  });
  assert.equal(grant.author_revision, 5);
  expectCode(
    () =>
      svc.grantCommunityAccess({
        requesterId: 'reader',
        sessionRef: 's1',
        input: { content_ref: { type: 'post', id: 'p1', revision: 3 }, media_ref: { media_id: done.id, media_revision: done.revision }, slot: 'author_avatar', author_revision: 9 },
      }),
    'NOT_FOUND',
  );
});

test('越权：他人不能经 owner 接口读别人的媒体（统一 404）', () => {
  const svc = createMediaService({ tokenSecret: 'unit-test-secret-0123456789' });
  const done = readyImage(svc, 'author-1', 'community_image', 'c');
  expectCode(() => svc.getMedia({ ownerId: 'reader', mediaId: done.id }), 'NOT_FOUND');
  expectCode(() => svc.grantOwnerAccess({ ownerId: 'reader', mediaId: done.id, ifMatch: '"2"' }), 'NOT_FOUND');
});
