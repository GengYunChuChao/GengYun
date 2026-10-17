/**
 * `AccessGrant.url` 的**访问网关原点**（host）来自配置，不是硬编码域名。
 *
 * 背景：`services/api/src/media/service.ts` 曾把句柄 host 写死成 `media.gengyun.local` 这类
 * 形似可用域名的字面量；冻结契约里既没有 owner 私有媒体字节的数据面，本仓库也不提供该数据面，
 * 所以那种字面量会被读者当成「已经接好的地址」。现在 host 只能由装配层注入（配置项
 * `MEDIA_ACCESS_GRANT_ORIGIN`），缺省值是 RFC 6761 `.invalid` 保留域——**永不解析**的显式占位。
 *
 * 本文件只钉三件事（都是行为断言，不做文本宽松匹配）：
 *   1. 缺省 ⇒ 占位/不可解析域，且契约句柄形态（https + 契约路径）不变；
 *   2. 两个不同配置值 ⇒ owner 与社区两类句柄的 host 各自正确跟随；
 *   3. 非法注入 ⇒ 构造期抛错（不静默退回占位域），配置层同口径报 `ConfigError`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_MEDIA_ACCESS_GRANT_ORIGIN,
  createAppMediaService,
  normalizeMediaAccessGrantOrigin,
} from '../../services/api/src/media/service.ts';
import { createSubstituteObjectStore } from '../../services/api/src/media/object-store.ts';
import { ConfigError, loadConfig } from '../../services/api/src/config.ts';
import { sha256Hex } from '../../packages/media/validate.mjs';
import { pngPlain } from '../media/_fixtures.mjs';

const ACTOR = Object.freeze({ ownerId: 'owner-grant-url', authEpoch: 7, sessionRef: 'session-grant-url' });
const POST_ID = '33333333-3333-4333-8333-333333333333';
const TOKEN_SECRET = 'grant-url-test-secret-0123456789abcdef';

/** 可变公开内容来源（只做精确版本匹配；本文件专用，不改媒体域端口语义）。 */
function mutableContentSource() {
  const state = { snapshot: null };
  return {
    kind: 'in_memory',
    note: '本文件专用可变公开内容来源：只做精确 (type,id,revision) 匹配，不构造审核假状态。',
    getPublishedContent(ref) {
      const snapshot = state.snapshot;
      if (snapshot === null) return null;
      const same =
        snapshot.ref.type === ref.type && snapshot.ref.id === ref.id && snapshot.ref.revision === ref.revision;
      return same ? snapshot : null;
    },
    publish(snapshot) {
      state.snapshot = snapshot;
    },
  };
}

function makeService({ accessGrantOrigin, contentSource } = {}) {
  const objectStore = createSubstituteObjectStore();
  const options = {
    executionMode: 'stub',
    objectStore,
    tokenSecret: TOKEN_SECRET,
    now: () => new Date('2026-10-17T00:00:00.000Z'),
  };
  if (accessGrantOrigin !== undefined) options.accessGrantOrigin = accessGrantOrigin;
  if (contentSource !== undefined) options.contentSource = contentSource;
  return { service: createAppMediaService(options), objectStore };
}

/** 走完 initiate → （模拟客户端直传对象存储）→ complete，得到 ready 记录。 */
async function createReadyMedia({ service, objectStore }, purpose, bytes, mime, name) {
  const created = await service.initiateUpload({
    actor: ACTOR,
    input: { purpose, mime, bytes: bytes.length, sha256: sha256Hex(bytes) },
    idempotencyKey: `grant-url-${name}-create`,
  });
  const mediaId = created.media.id;
  const keys = service.serverObjectKeys(mediaId);
  assert.ok(keys !== null, 'serverObjectKeys 必须返回记录持有的对象键');
  assert.ok(typeof keys.rawRef === 'string' && keys.rawRef.length > 0);
  // 模拟客户端直传：替身对象存储里放一份与声明逐字节一致的原始对象。
  await objectStore.putObject(keys.rawRef, bytes, mime);
  const completed = await service.completeUpload({
    actor: ACTOR,
    mediaId,
    ifMatch: `"${created.media.revision}"`,
    input: { sha256: sha256Hex(bytes), bytes: bytes.length },
    idempotencyKey: `grant-url-${name}-complete`,
  });
  assert.equal(completed.status, 202, JSON.stringify(completed.media));
  assert.equal(completed.media.state, 'ready');
  return { mediaId, revision: completed.media.revision };
}

test('缺省 host 是占位/不可解析域（RFC 6761 .invalid），句柄形态仍是契约 https 句柄', async () => {
  // 默认值必须**不可解析**：`.invalid` 是 RFC 6761 保留给「永不解析」的 TLD。
  assert.equal(DEFAULT_MEDIA_ACCESS_GRANT_ORIGIN, 'https://media.placeholder.invalid');

  const harness = makeService();
  const png = pngPlain();
  const media = await createReadyMedia(harness, 'label_ocr', png, 'image/png', 'default');
  const granted = await harness.service.grantMediaAccess({
    actor: ACTOR,
    mediaId: media.mediaId,
    ifMatch: `"${media.revision}"`,
    idempotencyKey: 'grant-url-default-grant',
  });

  const url = new URL(granted.grant.url);
  assert.equal(granted.grant.method, 'GET');
  assert.equal(url.protocol, 'https:');
  assert.equal(url.origin, DEFAULT_MEDIA_ACCESS_GRANT_ORIGIN);
  assert.equal(url.hostname, 'media.placeholder.invalid');
  assert.ok(url.hostname.endsWith('.invalid'), '`.invalid` 永不解析：默认句柄不是可用地址');
  assert.equal(url.pathname, `/api/v1/media/${media.mediaId}/content`);
  assert.equal(url.search, '');
  // 沿用既有红线：访问令牌绝不进 URL（这条不是新增放宽，而是既有断言的同口径复核）。
  assert.ok(!granted.grant.url.includes(granted.grant.access_token), '访问令牌不得放进 URL');
});

test('host 随配置变化：两个不同配置值分别出现在 owner 与社区句柄里', async () => {
  const configured = [
    { origin: 'https://media-gateway-a.example.test', hostname: 'media-gateway-a.example.test', port: '' },
    { origin: 'https://media-gateway-b.example.test:8443', hostname: 'media-gateway-b.example.test', port: '8443' },
  ];
  const origins = new Set();
  for (const [index, item] of configured.entries()) {
    const contentSource = mutableContentSource();
    const harness = makeService({ accessGrantOrigin: item.origin, contentSource });
    const { service, objectStore } = harness;
    const png = pngPlain();

    const owner = await createReadyMedia(harness, 'label_ocr', png, 'image/png', `owner-${index}`);
    const ownerGrant = await service.grantMediaAccess({
      actor: ACTOR,
      mediaId: owner.mediaId,
      ifMatch: `"${owner.revision}"`,
      idempotencyKey: `grant-url-owner-${index}`,
    });
    const ownerUrl = new URL(ownerGrant.grant.url);
    assert.equal(ownerUrl.hostname, item.hostname, `owner 句柄 host 必须跟随配置值 ${item.origin}`);
    assert.equal(ownerUrl.port, item.port);
    assert.equal(ownerUrl.pathname, `/api/v1/media/${owner.mediaId}/content`);

    const community = await createReadyMedia(harness, 'community_image', png, 'image/png', `community-${index}`);
    contentSource.publish({
      ref: { type: 'post', id: POST_ID, revision: 1 },
      published: true,
      approved: true,
      authorRevision: null,
      media: [{ mediaId: community.mediaId, mediaRevision: community.revision }],
      avatarMedia: null,
    });
    const communityGrant = await service.grantCommunityMediaAccess({
      actor: ACTOR,
      body: {
        content_ref: { type: 'post', id: POST_ID, revision: 1 },
        media_ref: { media_id: community.mediaId, media_revision: community.revision },
        slot: 'attachment',
        author_revision: null,
      },
      ifMatch: '"1"',
      idempotencyKey: `grant-url-community-${index}`,
    });
    const communityUrl = new URL(communityGrant.grant.access.url);
    assert.equal(communityUrl.hostname, item.hostname, `社区句柄 host 必须跟随配置值 ${item.origin}`);
    assert.equal(communityUrl.port, item.port);
    assert.equal(communityUrl.pathname, `/api/v1/community/media/${communityGrant.grant.grant_id}/content`);
    assert.ok(!communityGrant.grant.access.url.includes(communityGrant.grant.access.access_token));

    assert.equal(objectStore.kind, 'substitute');
    origins.add(ownerUrl.host + '|' + communityUrl.host);
  }
  // 两个配置值 ⇒ 两组互不相同的 host（证明 host 真的由配置驱动，而不是常量兜底）。
  assert.equal(origins.size, configured.length);
});

test('注入非法网关原点：构造期抛错，不静默退回占位域', () => {
  const bad = [
    'http://media-gateway.example.test',
    'https://media-gateway.example.test/gateway',
    'https://media-gateway.example.test?x=1',
    'https://media-gateway.example.test#frag',
    'https://user:pass@media-gateway.example.test',
    ' https://media-gateway.example.test',
    'media-gateway.example.test',
    '',
  ];
  for (const value of bad) {
    assert.throws(
      () => makeService({ accessGrantOrigin: value }),
      (error) => {
        assert.ok(error instanceof TypeError, `应抛 TypeError：${value}`);
        assert.match(error.message, /网关原点/);
        return true;
      },
      `应拒绝非法网关原点：${JSON.stringify(value)}`,
    );
  }
});

test('normalizeMediaAccessGrantOrigin：规范化 scheme/host/端口，只回 origin', () => {
  assert.equal(normalizeMediaAccessGrantOrigin('https://Media-Gateway.Example.TEST'), 'https://media-gateway.example.test');
  assert.equal(normalizeMediaAccessGrantOrigin('https://media-gateway.example.test:443'), 'https://media-gateway.example.test');
  assert.equal(normalizeMediaAccessGrantOrigin('https://media-gateway.example.test:8443'), 'https://media-gateway.example.test:8443');
});

test('配置项 MEDIA_ACCESS_GRANT_ORIGIN：缺省 null、合法值规范化、非法值进 ConfigError', () => {
  assert.equal(loadConfig({ APP_EXECUTION_MODE: 'stub' }).mediaAccessGrantOrigin, null);
  assert.equal(loadConfig({ APP_EXECUTION_MODE: 'stub', MEDIA_ACCESS_GRANT_ORIGIN: '   ' }).mediaAccessGrantOrigin, null);
  assert.equal(
    loadConfig({ APP_EXECUTION_MODE: 'stub', MEDIA_ACCESS_GRANT_ORIGIN: 'https://Media-Gateway.Example.TEST:443' })
      .mediaAccessGrantOrigin,
    'https://media-gateway.example.test',
  );

  assert.throws(
    () => loadConfig({ APP_EXECUTION_MODE: 'stub', MEDIA_ACCESS_GRANT_ORIGIN: 'http://media-gateway.example.test' }),
    (error) => {
      assert.ok(error instanceof ConfigError);
      assert.deepEqual(
        error.issues.map((issue) => [issue.field, issue.code]),
        [['MEDIA_ACCESS_GRANT_ORIGIN', 'INVALID_VALUE']],
      );
      return true;
    },
  );
});

test('源码不再保留硬编码的可疑 host（防回归：缺省值只能是不可解析占位域）', () => {
  const source = readFileSync(new URL('../../services/api/src/media/service.ts', import.meta.url), 'utf8');
  assert.ok(!source.includes('media.gengyun.local'), '硬编码占位域必须已改为配置项');
  assert.match(source, /DEFAULT_MEDIA_ACCESS_GRANT_ORIGIN = 'https:\/\/media\.placeholder\.invalid'/);
});
