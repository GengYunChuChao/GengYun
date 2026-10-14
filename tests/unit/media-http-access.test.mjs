// GY-I06（#6）私有媒体 · HTTP 访问权限回归（越权同形 404 / 短效句柄 / 审核上下文 / 过期）。
//
// 全部使用合成身份与替身对象存储；社区公开内容来源用**测试内存替身**显式注入，
// 不接真实社区与审核存储（那属 GY-I14/GY-I15 线）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createSubstituteObjectStore } from '../../services/api/src/media/object-store.ts';
import { sha256Hex } from '../../packages/media/validate.mjs';
import { jpegWithExif, pngPlain, pngWithExif } from '../media/_fixtures.mjs';

const KEY = (name) => `media-access-${name}-0000`;
const POST_ID = '33333333-3333-4333-8333-333333333333';
const ABSENT_ID = '44444444-4444-4444-8444-444444444444';

/**
 * 可变的公开内容来源替身：先建媒体、再设置快照，用于逐条构造「未发布 / 未过审 / 版本不符」反例。
 * 它**只做精确版本匹配**，不构造任何虚假审核状态。
 */
function dynamicContentSource() {
  const state = { snapshot: null };
  return {
    state,
    source: {
      kind: 'in_memory',
      note: '可变的公开内容来源测试替身。',
      getPublishedContent(ref) {
        const snapshot = state.snapshot;
        if (snapshot === null) return null;
        if (snapshot.ref.type !== ref.type || snapshot.ref.id !== ref.id || snapshot.ref.revision !== ref.revision) return null;
        if (!snapshot.published || !snapshot.approved) return null;
        return snapshot;
      },
    },
  };
}

function makeApp(contentSource) {
  let nowMs = 1_700_000_000_000;
  const store = createSubstituteObjectStore();
  const app = buildApp({
    config: { ...loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }), executionMode: 'stub' },
    mediaObjectStore: store,
    ...(contentSource === undefined ? {} : { mediaContentSource: contentSource }),
    now: () => new Date(nowMs),
  });
  return { app, store, advance: (ms) => { nowMs += ms; } };
}

async function login(app, code) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/wechat',
    headers: { 'content-type': 'application/json', 'idempotency-key': `login-key-${code}` },
    payload: { code },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json().data.access_token;
}

async function call(app, method, url, token, { payload, headers } = {}) {
  const response = await app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload }),
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(headers ?? {}),
    },
  });
  let body = null;
  try { body = response.json(); } catch { body = null; }
  return {
    status: response.statusCode,
    body,
    raw: response.rawPayload,
    etag: response.headers.etag,
    cache: response.headers['cache-control'],
    contentType: response.headers['content-type'],
    requestIdHeader: response.headers['x-request-id'],
    executionModeHeader: response.headers['x-execution-mode'],
  };
}

async function clientUpload(app, mediaId, bytes) {
  const keys = app.mediaService.serverObjectKeys(mediaId);
  assert.ok(keys !== null && typeof keys.rawRef === 'string');
  await app.mediaObjectStore.putObject(keys.rawRef, bytes, 'application/octet-stream');
}

/** 建一条 **ready** 的媒体记录（图片类型，衍生件为去元数据件）。 */
async function createReadyMedia(app, token, purpose, bytes, mime, name) {
  const created = await call(app, 'POST', '/api/v1/media/uploads', token, {
    payload: { purpose, mime, bytes: bytes.length, sha256: sha256Hex(bytes) },
    headers: { 'idempotency-key': KEY(`${name}-create`) },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const mediaId = created.body.data.media.id;
  await clientUpload(app, mediaId, bytes);
  const completed = await call(app, 'POST', `/api/v1/media/uploads/${mediaId}/complete`, token, {
    payload: { sha256: sha256Hex(bytes), bytes: bytes.length },
    headers: { 'idempotency-key': KEY(`${name}-complete`), 'if-match': '"1"' },
  });
  assert.equal(completed.status, 202, JSON.stringify(completed.body));
  // 契约 `MediaEnvelope` = `{ data: Media, meta }`：data 就是媒体本身（不是 data.media）。
  return { mediaId, revision: completed.body.data.revision };
}

test('GY-I06 HTTP 访问面：归属同形 404、短效句柄失效、审核上下文与版本复核', async (t) => {
  const { app } = makeApp();
  t.after(() => app.close());
  const ownerToken = await login(app, 'media-access-owner');
  const otherToken = await login(app, 'media-access-other');
  const jpeg = jpegWithExif();
  const png = pngPlain();

  await t.test('反例：非本人与不存在**逐字节同形** 404（getMedia / complete / delete / access）', async () => {
    const created = await call(app, 'POST', '/api/v1/media/uploads', ownerToken, {
      payload: { purpose: 'label_ocr', mime: 'image/jpeg', bytes: jpeg.length, sha256: sha256Hex(jpeg) },
      headers: { 'idempotency-key': KEY('owner-create') },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const mediaId = created.body.data.media.id;
    await clientUpload(app, mediaId, jpeg);

    const cases = [
      ['GET', `/api/v1/media/${mediaId}`, {}],
      ['POST', `/api/v1/media/uploads/${mediaId}/complete`, { payload: { sha256: sha256Hex(jpeg), bytes: jpeg.length }, headers: { 'idempotency-key': KEY('cross-complete'), 'if-match': '"1"' } }],
      ['DELETE', `/api/v1/media/${mediaId}`, { headers: { 'idempotency-key': KEY('cross-delete'), 'if-match': '"1"' } }],
      ['POST', `/api/v1/media/${mediaId}/access`, { headers: { 'idempotency-key': KEY('cross-access'), 'if-match': '"1"' } }],
    ];
    for (const [method, url, options] of cases) {
      const foreign = await call(app, method, url, otherToken, options);
      const missing = await call(app, method, url.replace(mediaId, ABSENT_ID), otherToken, options);
      assert.equal(foreign.status, 404, `${method} ${url} → ${JSON.stringify(foreign.body)}`);
      assert.equal(foreign.body.error.code, 'NOT_FOUND');
      assert.deepEqual(foreign.body.error, missing.body.error, `${method} ${url}：越权与不存在必须同形`);
      assert.deepEqual(foreign.body.error.details, []);
    }
    // 归属者本人可读。
    assert.equal((await call(app, 'GET', `/api/v1/media/${mediaId}`, ownerToken)).status, 200);
  });

  await t.test('deleteMedia：202 Ack + 强 ETag；同键同体原样重放；删除后墓碑为 deleted 且对象即时回收', async () => {
    const { mediaId, revision } = await createReadyMedia(app, ownerToken, 'label_ocr', jpeg, 'image/jpeg', 'delete');
    const missingIfMatch = await call(app, 'DELETE', `/api/v1/media/${mediaId}`, ownerToken, {
      headers: { 'idempotency-key': KEY('delete-no-match') },
    });
    assert.equal(missingIfMatch.status, 428, JSON.stringify(missingIfMatch.body));
    assert.equal(missingIfMatch.body.error.code, 'REVISION_REQUIRED');

    const stale = await call(app, 'DELETE', `/api/v1/media/${mediaId}`, ownerToken, {
      headers: { 'idempotency-key': KEY('delete-stale'), 'if-match': '"99"' },
    });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    assert.equal(stale.body.error.code, 'REVISION_CONFLICT');

    const objectsBeforeDelete = await app.mediaObjectStore.objectCount();
    const deleted = await call(app, 'DELETE', `/api/v1/media/${mediaId}`, ownerToken, {
      headers: { 'idempotency-key': KEY('delete-ok'), 'if-match': `"${revision}"` },
    });
    assert.equal(deleted.status, 202, JSON.stringify(deleted.body));
    assert.deepEqual(deleted.body.data, { accepted: true });
    assert.equal(deleted.etag, `"${revision + 1}"`);
    assert.equal(deleted.cache, 'no-store');

    const replay = await call(app, 'DELETE', `/api/v1/media/${mediaId}`, ownerToken, {
      headers: { 'idempotency-key': KEY('delete-ok'), 'if-match': `"${revision}"` },
    });
    assert.equal(replay.status, 202, JSON.stringify(replay.body));
    assert.equal(replay.etag, deleted.etag, '同键同体重放必须回放同一结果');

    // 删除是**异步受理**（202）；记录以 `deleted` 墓碑保留给归属者读取（契约 MediaState 含 deleted），
    // 且对象已即时回收、社区句柄已撤销（不假装「记录消失」）。
    const afterDelete = await call(app, 'GET', `/api/v1/media/${mediaId}`, ownerToken);
    assert.equal(afterDelete.status, 200, JSON.stringify(afterDelete.body));
    assert.equal(afterDelete.body.data.state, 'deleted');
    assert.equal(
      await app.mediaObjectStore.objectCount(),
      objectsBeforeDelete - 2,
      '删除必须即时回收该媒体的原始件与去元数据衍生件',
    );
  });

  await t.test('grantMediaAccess：仅 owner 且仅 ready；If-Match 对应媒体 revision', async () => {
    const { mediaId, revision } = await createReadyMedia(app, ownerToken, 'label_ocr', jpeg, 'image/jpeg', 'owner-access');
    const noMatch = await call(app, 'POST', `/api/v1/media/${mediaId}/access`, ownerToken, {
      headers: { 'idempotency-key': KEY('access-no-match') },
    });
    assert.equal(noMatch.status, 428, JSON.stringify(noMatch.body));
    const stale = await call(app, 'POST', `/api/v1/media/${mediaId}/access`, ownerToken, {
      headers: { 'idempotency-key': KEY('access-stale'), 'if-match': '"99"' },
    });
    assert.equal(stale.status, 409);
    const granted = await call(app, 'POST', `/api/v1/media/${mediaId}/access`, ownerToken, {
      headers: { 'idempotency-key': KEY('access-ok'), 'if-match': `"${revision}"` },
    });
    assert.equal(granted.status, 200, JSON.stringify(granted.body));
    assert.equal(granted.etag, `"${revision}"`);
    assert.match(granted.body.data.url, /^https:\/\//);
    assert.equal(granted.body.data.method, 'GET');
    assert.ok(granted.body.data.access_token.length > 0);
    assert.ok(!granted.body.data.url.includes(granted.body.data.access_token));

    // 未 ready（initiated）→ 409 OBJECT_UNAVAILABLE（不假发句柄）。
    const pending = await call(app, 'POST', '/api/v1/media/uploads', ownerToken, {
      payload: { purpose: 'label_ocr', mime: 'image/jpeg', bytes: jpeg.length, sha256: sha256Hex(jpeg) },
      headers: { 'idempotency-key': KEY('access-pending') },
    });
    const pendingAccess = await call(app, 'POST', `/api/v1/media/${pending.body.data.media.id}/access`, ownerToken, {
      headers: { 'idempotency-key': KEY('access-pending-op'), 'if-match': '"1"' },
    });
    assert.equal(pendingAccess.status, 409, JSON.stringify(pendingAccess.body));
    assert.equal(pendingAccess.body.error.code, 'OBJECT_UNAVAILABLE');
  });

  await t.test('社区取图：公开内容来源默认**关闭** ⇒ 统一 404（不误放行）', async () => {
    const closed = makeApp();
    try {
      const token = await login(closed.app, 'media-closed-owner');
      const { mediaId, revision } = await createReadyMedia(closed.app, token, 'community_image', png, 'image/png', 'closed');
      const response = await call(closed.app, 'POST', '/api/v1/community/media-access', token, {
        payload: {
          content_ref: { type: 'post', id: POST_ID, revision: 1 },
          media_ref: { media_id: mediaId, media_revision: revision },
          slot: 'attachment',
          author_revision: null,
        },
        headers: { 'idempotency-key': KEY('closed-grant'), 'if-match': '"1"' },
      });
      assert.equal(response.status, 404, JSON.stringify(response.body));
      assert.equal(response.body.error.code, 'NOT_FOUND');
    } finally {
      await closed.app.close();
    }
  });

  await t.test('社区取图：未发布 / 未过审 / 版本不符 / 非社区用途 ⇒ 一律 404', async () => {
    const dynamic = dynamicContentSource();
    const scoped = makeApp(dynamic.source);
    try {
      const token = await login(scoped.app, 'media-community-owner');
      const { mediaId, revision } = await createReadyMedia(scoped.app, token, 'community_image', png, 'image/png', 'community');
      const body = (mediaRevision) => ({
        content_ref: { type: 'post', id: POST_ID, revision: 1 },
        media_ref: { media_id: mediaId, media_revision: mediaRevision },
        slot: 'attachment',
        author_revision: null,
      });
      const grant = (payload, name) => call(scoped.app, 'POST', '/api/v1/community/media-access', token, {
        payload, headers: { 'idempotency-key': KEY(name), 'if-match': '"1"' },
      });

      assert.equal((await grant(body(revision), 'no-content')).status, 404, '无公开内容');

      dynamic.state.snapshot = {
        ref: { type: 'post', id: POST_ID, revision: 1 },
        published: false, approved: true, authorRevision: null, media: [{ mediaId, mediaRevision: revision }], avatarMedia: null,
      };
      assert.equal((await grant(body(revision), 'unpublished')).status, 404, '未发布');

      dynamic.state.snapshot = {
        ref: { type: 'post', id: POST_ID, revision: 1 },
        published: true, approved: false, authorRevision: null, media: [{ mediaId, mediaRevision: revision }], avatarMedia: null,
      };
      assert.equal((await grant(body(revision), 'unapproved')).status, 404, '未过审（先审后发）');

      dynamic.state.snapshot = {
        ref: { type: 'post', id: POST_ID, revision: 1 },
        published: true, approved: true, authorRevision: null, media: [{ mediaId, mediaRevision: revision }], avatarMedia: null,
      };
      assert.equal((await grant(body(revision + 7), 'wrong-media-revision')).status, 404, '媒体版本不符');
      // 内容版本不符：请求的 content_ref.revision 与当前内容版本不同（If-Match 同步指向请求的版本）。
      const wrongContentRevision = await call(scoped.app, 'POST', '/api/v1/community/media-access', token, {
        payload: {
          content_ref: { type: 'post', id: POST_ID, revision: 2 },
          media_ref: { media_id: mediaId, media_revision: revision },
          slot: 'attachment',
          author_revision: null,
        },
        headers: { 'idempotency-key': KEY('wrong-content-revision'), 'if-match': '"2"' },
      });
      assert.equal(wrongContentRevision.status, 404, JSON.stringify(wrongContentRevision.body));
    } finally {
      await scoped.app.close();
    }
  });

  await t.test('社区取图：授权 → 读图 → 逐次复核（令牌/主体/过期/媒体删除/内容下架）', async () => {
    const dynamic = dynamicContentSource();
    const scoped = makeApp(dynamic.source);
    try {
      const token = await login(scoped.app, 'media-content-owner');
      const other = await login(scoped.app, 'media-content-other');
      const png = pngWithExif();
      const { mediaId, revision } = await createReadyMedia(scoped.app, token, 'community_image', png, 'image/png', 'content');
      dynamic.state.snapshot = {
        ref: { type: 'post', id: POST_ID, revision: 1 },
        published: true, approved: true, authorRevision: null, media: [{ mediaId, mediaRevision: revision }], avatarMedia: null,
      };
      const payload = {
        content_ref: { type: 'post', id: POST_ID, revision: 1 },
        media_ref: { media_id: mediaId, media_revision: revision },
        slot: 'attachment',
        author_revision: null,
      };

      // If-Match 对应 **content_ref.revision**（不是媒体 revision）。
      const missingIfMatch = await call(scoped.app, 'POST', '/api/v1/community/media-access', token, {
        payload, headers: { 'idempotency-key': KEY('content-no-match') },
      });
      assert.equal(missingIfMatch.status, 428, JSON.stringify(missingIfMatch.body));
      assert.equal(missingIfMatch.body.error.code, 'REVISION_REQUIRED');
      const staleIfMatch = await call(scoped.app, 'POST', '/api/v1/community/media-access', token, {
        payload, headers: { 'idempotency-key': KEY('content-stale'), 'if-match': `"${revision}"` },
      });
      assert.equal(staleIfMatch.status, 409, JSON.stringify(staleIfMatch.body));
      assert.equal(staleIfMatch.body.error.code, 'REVISION_CONFLICT');

      const granted = await call(scoped.app, 'POST', '/api/v1/community/media-access', token, {
        payload, headers: { 'idempotency-key': KEY('content-grant'), 'if-match': '"1"' },
      });
      assert.equal(granted.status, 200, JSON.stringify(granted.body));
      assert.equal(granted.etag, '"1"', 'ETag 对应 content_ref.revision');
      assert.equal(granted.cache, 'no-store');
      const grant = granted.body.data;
      assert.deepEqual(grant.content_ref, { type: 'post', id: POST_ID, revision: 1 });
      assert.deepEqual(grant.media_ref, { media_id: mediaId, media_revision: revision });
      assert.equal(grant.slot, 'attachment');
      assert.equal(grant.author_revision, null);
      assert.match(grant.access.url, /^https:\/\//);
      assert.ok(!grant.access.url.includes(grant.access.access_token), '访问令牌不得放进 URL');
      const token2 = grant.access.access_token;

      const readUrl = `/api/v1/community/media/${grant.grant_id}/content`;
      const read = await call(scoped.app, 'GET', readUrl, token, { headers: { 'x-media-access-token': token2 } });
      assert.equal(read.status, 200, JSON.stringify(read.body));
      assert.equal(read.contentType, 'image/png');
      assert.equal(read.cache, 'no-store');
      assert.equal(read.etag, `"${revision}"`);
      assert.equal(typeof read.requestIdHeader, 'string', '契约要求 200 响应带 X-Request-Id');
      assert.ok(read.requestIdHeader.length > 0);
      assert.equal(typeof read.executionModeHeader, 'string');
      assert.ok(read.raw.length > 0);
      // 返回的必须是**去元数据衍生件**：与原始上传字节不同（PNG 夹具含 eXIf/tEXt 段）。
      const served = Uint8Array.from(read.raw);
      assert.notEqual(sha256Hex(served), sha256Hex(png), '对外必须提供衍生件而非原始对象');
      assert.ok(!Buffer.from(served).includes(Buffer.from('gps:1.2345,103.9876')), '对外字节不得含 GPS 文本段');

      // 缺 / 非法令牌头 → 400；令牌不符 → 404；主体不符 → 404（失效统一 404）。
      const missingToken = await call(scoped.app, 'GET', readUrl, token);
      assert.equal(missingToken.status, 400, JSON.stringify(missingToken.body));
      assert.equal(missingToken.body.error.code, 'INVALID_REQUEST');
      const wrongToken = await call(scoped.app, 'GET', readUrl, token, { headers: { 'x-media-access-token': 'forged-token' } });
      assert.equal(wrongToken.status, 404);
      assert.equal(wrongToken.body.error.code, 'NOT_FOUND');
      const foreign = await call(scoped.app, 'GET', readUrl, other, { headers: { 'x-media-access-token': token2 } });
      assert.equal(foreign.status, 404, JSON.stringify(foreign.body));
      assert.equal(foreign.body.error.code, 'NOT_FOUND');

      // 内容下架 → 即使未到期也立即 404。
      dynamic.state.snapshot = {
        ref: { type: 'post', id: POST_ID, revision: 1 },
        published: false, approved: true, authorRevision: null, media: [{ mediaId, mediaRevision: revision }], avatarMedia: null,
      };
      const unpublished = await call(scoped.app, 'GET', readUrl, token, { headers: { 'x-media-access-token': token2 } });
      assert.equal(unpublished.status, 404, JSON.stringify(unpublished.body));
      dynamic.state.snapshot = {
        ref: { type: 'post', id: POST_ID, revision: 1 },
        published: true, approved: true, authorRevision: null, media: [{ mediaId, mediaRevision: revision }], avatarMedia: null,
      };

      // 媒体被删除 → 已授权句柄立即失效。
      const deleted = await call(scoped.app, 'DELETE', `/api/v1/media/${mediaId}`, token, {
        headers: { 'idempotency-key': KEY('content-delete'), 'if-match': `"${revision}"` },
      });
      assert.equal(deleted.status, 202, JSON.stringify(deleted.body));
      const afterDelete = await call(scoped.app, 'GET', readUrl, token, { headers: { 'x-media-access-token': token2 } });
      assert.equal(afterDelete.status, 404, JSON.stringify(afterDelete.body));

      // 过期：超过 300 秒有效期后一律 404。
      const second = await createReadyMedia(scoped.app, token, 'community_image', png, 'image/png', 'content-expire');
      dynamic.state.snapshot = {
        ref: { type: 'post', id: POST_ID, revision: 1 },
        published: true, approved: true, authorRevision: null, media: [{ mediaId: second.mediaId, mediaRevision: second.revision }], avatarMedia: null,
      };
      const grantedAgain = await call(scoped.app, 'POST', '/api/v1/community/media-access', token, {
        payload: { content_ref: { type: 'post', id: POST_ID, revision: 1 }, media_ref: { media_id: second.mediaId, media_revision: second.revision }, slot: 'attachment', author_revision: null },
        headers: { 'idempotency-key': KEY('content-expire-grant'), 'if-match': '"1"' },
      });
      assert.equal(grantedAgain.status, 200, JSON.stringify(grantedAgain.body));
      const expireUrl = `/api/v1/community/media/${grantedAgain.body.data.grant_id}/content`;
      const expireToken = grantedAgain.body.data.access.access_token;
      assert.equal((await call(scoped.app, 'GET', expireUrl, token, { headers: { 'x-media-access-token': expireToken } })).status, 200);
      scoped.advance(301_000);
      const expired = await call(scoped.app, 'GET', expireUrl, token, { headers: { 'x-media-access-token': expireToken } });
      assert.equal(expired.status, 404, JSON.stringify(expired.body));
      assert.equal(expired.body.error.code, 'NOT_FOUND');
    } finally {
      await scoped.app.close();
    }
  });

  await t.test('社区取图：头像槽位另核 author_revision，且不接受非社区用途媒体', async () => {
    const dynamic = dynamicContentSource();
    const scoped = makeApp(dynamic.source);
    try {
      const token = await login(scoped.app, 'media-avatar-owner');
      const avatar = await createReadyMedia(scoped.app, token, 'community_image', png, 'image/png', 'avatar');
      const label = await createReadyMedia(scoped.app, token, 'label_ocr', png, 'image/png', 'label');
      const snapshot = (authorRevision) => ({
        ref: { type: 'post', id: POST_ID, revision: 1 },
        published: true, approved: true, authorRevision,
        media: [{ mediaId: avatar.mediaId, mediaRevision: avatar.revision }],
        avatarMedia: { mediaId: avatar.mediaId, mediaRevision: avatar.revision },
      });
      dynamic.state.snapshot = snapshot(7);

      const missingAuthorRevision = await call(scoped.app, 'POST', '/api/v1/community/media-access', token, {
        payload: {
          content_ref: { type: 'post', id: POST_ID, revision: 1 },
          media_ref: { media_id: avatar.mediaId, media_revision: avatar.revision },
          slot: 'author_avatar',
          author_revision: null,
        },
        headers: { 'idempotency-key': KEY('avatar-null-revision'), 'if-match': '"1"' },
      });
      assert.equal(missingAuthorRevision.status, 404, JSON.stringify(missingAuthorRevision.body));

      const staleAuthorRevision = await call(scoped.app, 'POST', '/api/v1/community/media-access', token, {
        payload: {
          content_ref: { type: 'post', id: POST_ID, revision: 1 },
          media_ref: { media_id: avatar.mediaId, media_revision: avatar.revision },
          slot: 'author_avatar',
          author_revision: 6,
        },
        headers: { 'idempotency-key': KEY('avatar-stale-revision'), 'if-match': '"1"' },
      });
      assert.equal(staleAuthorRevision.status, 404, JSON.stringify(staleAuthorRevision.body));

      // 非 community_image 用途的媒体不得借社区接口出网。
      const wrongPurpose = await call(scoped.app, 'POST', '/api/v1/community/media-access', token, {
        payload: {
          content_ref: { type: 'post', id: POST_ID, revision: 1 },
          media_ref: { media_id: label.mediaId, media_revision: label.revision },
          slot: 'attachment',
          author_revision: null,
        },
        headers: { 'idempotency-key': KEY('avatar-wrong-purpose'), 'if-match': '"1"' },
      });
      assert.equal(wrongPurpose.status, 404, JSON.stringify(wrongPurpose.body));

      const granted = await call(scoped.app, 'POST', '/api/v1/community/media-access', token, {
        payload: {
          content_ref: { type: 'post', id: POST_ID, revision: 1 },
          media_ref: { media_id: avatar.mediaId, media_revision: avatar.revision },
          slot: 'author_avatar',
          author_revision: 7,
        },
        headers: { 'idempotency-key': KEY('avatar-ok'), 'if-match': '"1"' },
      });
      assert.equal(granted.status, 200, JSON.stringify(granted.body));
      assert.equal(granted.body.data.slot, 'author_avatar');
      assert.equal(granted.body.data.author_revision, 7);

      // 头像 revision 变化 → 取图 404（逐次复核）。
      dynamic.state.snapshot = snapshot(8);
      const readUrl = `/api/v1/community/media/${granted.body.data.grant_id}/content`;
      const read = await call(scoped.app, 'GET', readUrl, token, {
        headers: { 'x-media-access-token': granted.body.data.access.access_token },
      });
      assert.equal(read.status, 404, JSON.stringify(read.body));
    } finally {
      await scoped.app.close();
    }
  });

  await t.test('反例：社区取图请求体非法 / 多余字段 → 400 INVALID_REQUEST', async () => {
    const base = {
      content_ref: { type: 'post', id: POST_ID, revision: 1 },
      media_ref: { media_id: ABSENT_ID, media_revision: 1 },
      slot: 'attachment',
      author_revision: null,
    };
    const bad = [
      { ...base, extra: true },
      { ...base, slot: 'other' },
      { ...base, author_revision: 0 },
      { ...base, content_ref: { type: 'post', id: POST_ID } },
    ];
    for (const [index, payload] of bad.entries()) {
      const response = await call(app, 'POST', '/api/v1/community/media-access', ownerToken, {
        payload, headers: { 'idempotency-key': KEY(`bad-body-${index}`), 'if-match': '"1"' },
      });
      assert.equal(response.status, 400, `${index} → ${JSON.stringify(response.body)}`);
      assert.equal(response.body.error.code, 'INVALID_REQUEST');
    }
  });
});
