/**
 * GY-I06（#6）· G3：社区取图的**内容源已真装配**（不再是「恒 closed」）。
 *
 * 本文件钉四件事，全部是**行为断言**（不做文本宽松匹配）：
 *   1. 真实来源 `createRealContentSource` 的组装口径：`published`/`approved` 只由社区只读端口
 *      `publishedContent` 决定；附件 revision 取媒体记录**当前** revision；头像槽位如实不可用；
 *      社区域整体未接线（`community === null`）时回落 `closed`，与「未接线」同形。
 *   2. 取图链真的 `await` 了内容源：句柄签发与取值都经过异步端口（同步实现会当场 404）。
 *   3. 社区只读端口复用**读时重算**的 `effectiveState`：已发布且 `approved` ⇒ 可取；
 *      未发布、`quarantined`、`rejected`、联动域退回（`domainWithholding`）、revision 不符
 *      ⇒ 一律折叠成 `null`（无可取上下文，调用方统一 404）。
 *   4. 端口**没有作者旁路**：`readablePost` 里 `record.author_id === user.userId` 那条捷径
 *      不参与取图判定（作者本人未过审的内容同样不可取）。
 *
 * 边界（如实记录）：本文件不接触真实对象存储、不碰真 PG。带媒体的帖子在当前装配下**进不了**
 * `published` + `approved`（图片审核属模型层，未接入时 `createPost` 直接拒绝），所以「端口 → 媒体域」
 * 两段各自用真实实现验证，端到端「真桶真取图」仍需目标环境。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRealContentSource } from '../../services/api/src/media/content-source.ts';
import { createAppMediaService } from '../../services/api/src/media/service.ts';
import { createMemoryMediaStore } from '../../services/api/src/media/store.ts';
import { createSubstituteObjectStore } from '../../services/api/src/media/object-store.ts';
import { sha256Hex } from '../../packages/media/validate.mjs';
import { pngPlain } from '../media/_fixtures.mjs';
import {
  OTHER_SAFE_BODY,
  SAFE_BODY,
  SAFE_TITLE,
  START,
  USER_A,
  USER_B,
  expectApiError,
  idem,
  makeWiredHarness,
  mutablePort,
  postInput,
} from './community-moderation-fixtures.mjs';

const ACTOR = Object.freeze({ ownerId: 'owner-content-source', authEpoch: 3, sessionRef: 'session-content-source' });
const POST_ID = '55555555-5555-4555-8555-555555555555';
const ABSENT_ID = '99999999-9999-4999-8999-999999999999';
const TOKEN_SECRET = 'content-source-test-secret-0123456789abcdef';
const POST_TEXT = `${SAFE_TITLE}\n${SAFE_BODY}`;
const FROZEN_NOW = () => new Date(START);

// ---------------------------------------------------------------------------
// 媒体域夹具（与 `tests/unit/media-grant-url-origin.test.mjs` 同形，但不跨文件共享）
// ---------------------------------------------------------------------------

function makeMediaHarness(contentSource, store) {
  const objectStore = createSubstituteObjectStore();
  const service = createAppMediaService({
    executionMode: 'stub',
    objectStore,
    tokenSecret: TOKEN_SECRET,
    contentSource,
    accessGrantOrigin: 'https://media.example.test',
    persistence: store,
    now: FROZEN_NOW,
  });
  return { service, objectStore };
}

/** 走完 initiate →（模拟客户端直传）→ complete，得到 ready 的社区图记录。 */
async function createReadyCommunityImage({ service, objectStore }, name) {
  const bytes = pngPlain();
  const created = await service.initiateUpload({
    actor: ACTOR,
    input: { purpose: 'community_image', mime: 'image/png', bytes: bytes.length, sha256: sha256Hex(bytes) },
    idempotencyKey: `content-src-${name}-create`,
  });
  const mediaId = created.media.id;
  const keys = await service.serverObjectKeys(mediaId);
  assert.ok(keys !== null && typeof keys.rawRef === 'string' && keys.rawRef.length > 0);
  await objectStore.putObject(keys.rawRef, bytes, 'image/png');
  const completed = await service.completeUpload({
    actor: ACTOR,
    mediaId,
    ifMatch: `"${created.media.revision}"`,
    input: { sha256: sha256Hex(bytes), bytes: bytes.length },
    idempotencyKey: `content-src-${name}-complete`,
  });
  assert.equal(completed.status, 202, JSON.stringify(completed.media));
  assert.equal(completed.media.state, 'ready');
  return { mediaId, revision: completed.media.revision };
}

function communityGrantBody(media, mediaRevision = media.revision) {
  return {
    content_ref: { type: 'post', id: POST_ID, revision: 1 },
    media_ref: { media_id: media.mediaId, media_revision: mediaRevision },
    slot: 'attachment',
    author_revision: null,
  };
}

// ---------------------------------------------------------------------------
// 1. 真实来源的组装口径
// ---------------------------------------------------------------------------

test('真实来源：社区域整体未接线（community 为 null）⇒ 回落 closed，取图仍然 fail-closed', async () => {
  const source = createRealContentSource(null, { getMedia: async () => null });
  assert.equal(source.kind, 'closed');
  assert.equal(await source.getPublishedContent({ type: 'post', id: POST_ID, revision: 1 }), null);
});

test('装配层：已装配应用的默认媒体服务接的是真实来源（不再是「恒 closed」）', async () => {
  const h = makeWiredHarness({});
  // `app.ts` 的默认值：`mediaContentSource ?? createRealContentSource(communityService, mediaStore)`。
  assert.equal(h.app.mediaService.contentSource.kind, 'real');
  // 社区侧只读端口与媒体侧消费端口同形（`read`），不是第二份判定实现。
  assert.equal(typeof h.app.communityService.publishedContent.read, 'function');
});

test('真实来源：端口放行时按媒体当前 revision 组装快照，头像槽位如实不可用', async () => {
  const revisions = new Map([
    ['media-a', 4],
    ['media-b', 2],
  ]);
  const source = createRealContentSource(
    {
      publishedContent: {
        read: async (ref) =>
          ref.type === 'post' && ref.id === POST_ID && ref.revision === 1
            ? { mediaIds: ['media-a', 'media-missing', 'media-b'] }
            : null,
      },
    },
    { getMedia: async (id) => (revisions.has(id) ? { revision: revisions.get(id) } : null) },
  );
  assert.equal(source.kind, 'real');

  const snapshot = await source.getPublishedContent({ type: 'post', id: POST_ID, revision: 1 });
  assert.equal(snapshot.published, true);
  assert.equal(snapshot.approved, true);
  assert.deepEqual(snapshot.media, [
    { mediaId: 'media-a', mediaRevision: 4 },
    { mediaId: 'media-b', mediaRevision: 2 },
  ]);
  // 媒体行缺失 ⇒ 不进清单（不是「放行一个不知道版本的附件」）。
  assert.equal(
    snapshot.media.some((item) => item.mediaId === 'media-missing'),
    false,
  );
  // `users.avatar_media_id` 至今无写入方：如实 null，不构造假头像引用。
  assert.equal(snapshot.avatarMedia, null);
  assert.equal(snapshot.authorRevision, null);

  // 端口折叠掉的一切（不存在/未发布/未过审/版本不符）都不会变成快照。
  assert.equal(await source.getPublishedContent({ type: 'post', id: POST_ID, revision: 2 }), null);
  assert.equal(await source.getPublishedContent({ type: 'post', id: ABSENT_ID, revision: 1 }), null);
});

// ---------------------------------------------------------------------------
// 2. 取图链真的 await 了内容源（异步端口 → 句柄可签发、可取值）
// ---------------------------------------------------------------------------

test('真实来源接入取图：已发布且过审 ⇒ 签发句柄并可取值；端口一收回 ⇒ 新句柄 404、旧句柄立即失效', async () => {
  const state = { published: true, mediaIds: [] };
  const mediaStore = createMemoryMediaStore({ now: () => START });
  const source = createRealContentSource(
    {
      publishedContent: {
        read: async (ref) =>
          state.published && ref.type === 'post' && ref.id === POST_ID && ref.revision === 1
            ? { mediaIds: state.mediaIds }
            : null,
      },
    },
    mediaStore,
  );
  const harness = makeMediaHarness(source, mediaStore);
  const media = await createReadyCommunityImage(harness, 'granted');
  state.mediaIds = [media.mediaId];

  // 同步实现（没 await）在这里会拿到 Promise ⇒ `content.published` 为 undefined ⇒ 404。
  const granted = await harness.service.grantCommunityMediaAccess({
    actor: ACTOR,
    body: communityGrantBody(media),
    ifMatch: '"1"',
    idempotencyKey: 'content-src-grant-ok',
  });
  assert.equal(granted.status, 200);
  assert.equal(granted.grant.media_ref.media_revision, media.revision);
  assert.equal(granted.grant.content_ref.revision, 1);

  const read = await harness.service.readCommunityMediaContent({
    actor: ACTOR,
    grantId: granted.grant.grant_id,
    accessToken: granted.grant.access.access_token,
  });
  assert.equal(read.status, 200);
  assert.ok(read.bytes.length > 0);

  // 端口收回上下文（隔离 / 联动退回 / 版本不符都在端口里折叠成 null）。
  state.published = false;
  await expectApiError(
    () =>
      harness.service.grantCommunityMediaAccess({
        actor: ACTOR,
        body: communityGrantBody(media),
        ifMatch: '"1"',
        idempotencyKey: 'content-src-grant-revoked',
      }),
    'NOT_FOUND',
    404,
  );
  // 短效句柄 ≠ 公开权限：每次取图都复核当前上下文。
  await expectApiError(
    () =>
      harness.service.readCommunityMediaContent({
        actor: ACTOR,
        grantId: granted.grant.grant_id,
        accessToken: granted.grant.access.access_token,
      }),
    'NOT_FOUND',
    404,
  );
});

test('真实来源接入取图：media_revision 与当前记录不等 ⇒ 404；媒体行缺失 ⇒ 404', async () => {
  const state = { mediaIds: [] };
  const mediaStore = createMemoryMediaStore({ now: () => START });
  const source = createRealContentSource(
    {
      publishedContent: {
        read: async (ref) =>
          ref.type === 'post' && ref.id === POST_ID && ref.revision === 1 ? { mediaIds: state.mediaIds } : null,
      },
    },
    mediaStore,
  );
  const harness = makeMediaHarness(source, mediaStore);
  const media = await createReadyCommunityImage(harness, 'revision');
  state.mediaIds = [media.mediaId];

  await expectApiError(
    () =>
      harness.service.grantCommunityMediaAccess({
        actor: ACTOR,
        body: communityGrantBody(media, media.revision + 1),
        ifMatch: '"1"',
        idempotencyKey: 'content-src-grant-revision-mismatch',
      }),
    'NOT_FOUND',
    404,
  );

  state.mediaIds = ['media-row-absent'];
  await expectApiError(
    () =>
      harness.service.grantCommunityMediaAccess({
        actor: ACTOR,
        body: communityGrantBody({ mediaId: 'media-row-absent', revision: 1 }),
        ifMatch: '"1"',
        idempotencyKey: 'content-src-grant-media-absent',
      }),
    'NOT_FOUND',
    404,
  );
});

// ---------------------------------------------------------------------------
// 3. 社区只读端口：复用读时重算的 effectiveState
// ---------------------------------------------------------------------------

function postRow(id, { visibility, mediaIds }) {
  const timestamp = new Date(START).toISOString();
  return {
    id,
    revision: 1,
    author_id: USER_A,
    anonymized_author_ref: null,
    title: SAFE_TITLE,
    body: SAFE_BODY,
    crop_id: null,
    region_code: null,
    media_ids: mediaIds,
    linked_knowledge_ref: null,
    visibility,
    audit_state: 'approved',
    created_at: timestamp,
    updated_at: timestamp,
  };
}

test('社区只读端口：已发布且 approved ⇒ 可取；未发布（同一条已过审结论）⇒ 不可取', async () => {
  const mutable = mutablePort({ initial: 'pass' });
  const h = makeWiredHarness({ ports: { tms: mutable.port } });
  const post = await h.service.createPost(USER_A, postInput(), { idempotencyKey: idem(1) });
  assert.equal((await h.service.getPost(USER_B, post.id)).visibility, 'published');
  assert.deepEqual(await h.service.publishedContent.read({ type: 'post', id: post.id, revision: 1 }), { mediaIds: [] });

  // 复用同一条**已过审**结论（同正文 ⇒ 同摘要，只换目标与 id），单独造一条未公开的行：
  // 审核过了但没发布 ⇒ 仍不得取图。
  const verdict = await h.store.getModeration('post', post.id, 1);
  assert.equal(verdict.decision, 'approved');
  const privateId = 'post-unpublished-1';
  assert.equal(
    await h.store.insertPost(postRow(privateId, { visibility: 'private', mediaIds: ['media-x'] }), {
      ...verdict,
      id: 'mod-unpublished-1',
      target_ref: { type: 'post', id: privateId, revision: 1 },
    }),
    true,
  );
  assert.equal(await h.service.publishedContent.read({ type: 'post', id: privateId, revision: 1 }), null);

  // 同一条结论 + `published` ⇒ 可取，且 `media_ids` 如实回放（媒体域据此算当前 revision）。
  const publishedId = 'post-published-1';
  assert.equal(
    await h.store.insertPost(postRow(publishedId, { visibility: 'published', mediaIds: ['media-x', 'media-y'] }), {
      ...verdict,
      id: 'mod-published-1',
      target_ref: { type: 'post', id: publishedId, revision: 1 },
    }),
    true,
  );
  assert.deepEqual(await h.service.publishedContent.read({ type: 'post', id: publishedId, revision: 1 }), {
    mediaIds: ['media-x', 'media-y'],
  });

  // 版本不符：旧版本的结论不得为别的 revision 背书。
  assert.equal(await h.service.publishedContent.read({ type: 'post', id: publishedId, revision: 2 }), null);
  // 不存在：与「不可取」同形。
  assert.equal(await h.service.publishedContent.read({ type: 'post', id: ABSENT_ID, revision: 1 }), null);
});

test('社区只读端口：quarantined / rejected 后立即不可取（读时重算，不是写时信任）', async () => {
  const mutable = mutablePort({ initial: 'pass' });
  const h = makeWiredHarness({ ports: { tms: mutable.port } });
  const post = await h.service.createPost(USER_A, postInput(), { idempotencyKey: idem(1) });
  assert.deepEqual(await h.service.publishedContent.read({ type: 'post', id: post.id, revision: 1 }), { mediaIds: [] });

  mutable.setMode('block');
  const rejected = await h.moderation.submitScreening({
    actor: USER_A,
    content: { target_ref: { type: 'post', id: post.id, revision: 1 }, text: POST_TEXT, media: [] },
  });
  assert.equal(rejected.overall.decision, 'rejected');
  assert.equal(await h.service.publishedContent.read({ type: 'post', id: post.id, revision: 1 }), null);
  // 行本身没被改写：降级是读面判定。
  assert.equal((await h.store.getPost(post.id)).visibility, 'published');

  mutable.setMode('unsure');
  const quarantined = await h.moderation.submitScreening({
    actor: USER_A,
    content: { target_ref: { type: 'post', id: post.id, revision: 1 }, text: POST_TEXT, media: [] },
  });
  assert.equal(quarantined.overall.decision, 'quarantined');
  assert.equal(await h.service.publishedContent.read({ type: 'post', id: post.id, revision: 1 }), null);
});

test('社区只读端口：联动域退回（domainWithholding）⇒ 不可取', async () => {
  const h = makeWiredHarness({
    ports: { tms: mutablePort({ initial: 'pass' }).port },
    // 审核域台账说「这一版不再放行」：只能由读时重查发现，本地结论仍是 approved。
    communityLinkWrapper: (link) => {
      const withholdingLink = Object.create(link);
      withholdingLink.conclusionFor = () => ({
        readable: true,
        present: true,
        publishable: false,
        vetoed: false,
        decision: 'quarantined',
      });
      return withholdingLink;
    },
  });
  const post = await h.service.createPost(USER_A, postInput(), { idempotencyKey: idem(1) });

  assert.equal((await h.store.getModeration('post', post.id, 1)).decision, 'approved');
  assert.equal((await h.store.getPost(post.id)).visibility, 'published');
  assert.equal(await h.service.publishedContent.read({ type: 'post', id: post.id, revision: 1 }), null);
});

test('社区只读端口：没有作者旁路 —— 作者本人也拿不到未过审内容的取图上下文', async () => {
  const mutable = mutablePort({ initial: 'pass' });
  const h = makeWiredHarness({ ports: { tms: mutable.port } });
  const post = await h.service.createPost(USER_A, postInput(), { idempotencyKey: idem(1) });

  mutable.setMode('block');
  await h.moderation.submitScreening({
    actor: USER_A,
    content: { target_ref: { type: 'post', id: post.id, revision: 1 }, text: POST_TEXT, media: [] },
  });

  // 公开读 API 对作者有旁路（作者仍能读到自己那条），但取图端口**不认**这条旁路。
  const authorView = await h.service.getPost(USER_A, post.id);
  assert.equal(authorView.visibility, 'hidden');
  assert.equal(authorView.audit_state, 'rejected');
  assert.equal(await h.service.publishedContent.read({ type: 'post', id: post.id, revision: 1 }), null);
});

test('社区只读端口：评论走同一条闸门（父帖可见 + 评论自身过审 ⇒ 可取，且无附件槽位）', async () => {
  const mutable = mutablePort({ initial: 'pass' });
  const h = makeWiredHarness({ ports: { tms: mutable.port } });
  const post = await h.service.createPost(USER_A, postInput(), { idempotencyKey: idem(1) });
  const comment = await h.service.createComment(
    USER_B,
    post.id,
    { body: OTHER_SAFE_BODY },
    { idempotencyKey: idem(2), ifMatch: '"1"' },
  );
  assert.deepEqual(await h.service.publishedContent.read({ type: 'comment', id: comment.id, revision: 1 }), {
    mediaIds: [],
  });

  // 父帖被驳回 ⇒ 评论也不能取图（评论的可见性绑定父帖）。
  mutable.setMode('block');
  await h.moderation.submitScreening({
    actor: USER_A,
    content: { target_ref: { type: 'post', id: post.id, revision: 1 }, text: POST_TEXT, media: [] },
  });
  assert.equal(await h.service.publishedContent.read({ type: 'comment', id: comment.id, revision: 1 }), null);
});
