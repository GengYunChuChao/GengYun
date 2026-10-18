/**
 * GY-I06（#6）**装配层**：`AccessGrant.url` 的 host 跟随装配处的配置注入。
 *
 * 与 `tests/unit/media-grant-url-origin.test.mjs` 的分工（两者不可互相替代）：
 *   · 那个文件测的是**服务层**：`createAppMediaService({ accessGrantOrigin })` 自己怎么规范化、
 *     怎么拼句柄、非法值怎么抛错 —— 它把装配环节整个绕开；
 *   · 本文件测的是**装配层**：`buildApp({ config })` 是否真的把 `config.mediaAccessGrantOrigin`
 *     交给它自己创建的那个媒体服务。断言目标一律是 `buildApp` 组装出的 `app.mediaService`
 *     （不是本文件另建的实例），因此**删掉 `app.ts` 那条注入行，本文件即红**（反向控制见交付说明）。
 *
 * 两个方向都钉（缺一不可）：
 *   1. 不设 `MEDIA_ACCESS_GRANT_ORIGIN` ⇒ 走服务层缺省，host 是不可解析占位域
 *      `media.placeholder.invalid`（**不改变既有行为**）；
 *   2. 设了 ⇒ 句柄 host 逐字等于配置值，且两个不同配置值产出两个不同 host
 *      （证明 host 由装配注入驱动，而不是常量兜底）。
 *
 * 环境读取只经 `loadConfig`（仓库既有的 env 读取方式），本文件**不读** `process.env`；
 * 因此不受运行机器上是否碰巧设了该变量影响（显式 env 表进 `loadConfig`，缺省即缺省）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { DEFAULT_MEDIA_ACCESS_GRANT_ORIGIN } from '../../services/api/src/media/service.ts';
import { sha256Hex } from '../../packages/media/validate.mjs';
import { pngPlain } from '../media/_fixtures.mjs';

const ACTOR = Object.freeze({ ownerId: 'owner-assembly-origin', authEpoch: 3, sessionRef: 'session-assembly-origin' });
const PNG = pngPlain();

/** 装配一个 app 并只经它装配出的媒体服务走完整链路，返回 owner 句柄 URL。 */
async function ownerGrantUrl(env, tag) {
  const config = loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent', ...env });
  const app = buildApp({ config, store: createMemoryAuthStore() });
  try {
    const service = app.mediaService;
    assert.equal(service.failClosedReason, null, 'stub + 默认替身端口不得整域关闭（本用例只测句柄 host）');

    const created = await service.initiateUpload({
      actor: ACTOR,
      input: { purpose: 'label_ocr', mime: 'image/png', bytes: PNG.length, sha256: sha256Hex(PNG) },
      idempotencyKey: `assembly-origin-${tag}-create`,
    });
    const mediaId = created.media.id;
    const keys = service.serverObjectKeys(mediaId);
    assert.ok(keys !== null && typeof keys.rawRef === 'string' && keys.rawRef.length > 0);
    // 模拟客户端直传：替身对象存储里放一份与声明逐字节一致的原始对象。
    await app.mediaObjectStore.putObject(keys.rawRef, PNG, 'image/png');

    const completed = await service.completeUpload({
      actor: ACTOR,
      mediaId,
      ifMatch: `"${created.media.revision}"`,
      input: { sha256: sha256Hex(PNG), bytes: PNG.length },
      idempotencyKey: `assembly-origin-${tag}-complete`,
    });
    assert.equal(completed.media.state, 'ready');

    const granted = await service.grantMediaAccess({
      actor: ACTOR,
      mediaId,
      ifMatch: `"${completed.media.revision}"`,
      idempotencyKey: `assembly-origin-${tag}-grant`,
    });
    assert.ok(!granted.grant.url.includes(granted.grant.access_token), '访问令牌不得进 URL');
    return { url: new URL(granted.grant.url), mediaId, config };
  } finally {
    await app.close();
  }
}

test('装配层：不设 MEDIA_ACCESS_GRANT_ORIGIN ⇒ 句柄走服务层缺省占位域（不改变既有行为）', async () => {
  const { url, mediaId, config } = await ownerGrantUrl({}, 'default');

  assert.equal(config.mediaAccessGrantOrigin, null, '未设该键时配置层必须是 null（不是空串/占位值）');
  assert.equal(url.origin, DEFAULT_MEDIA_ACCESS_GRANT_ORIGIN);
  assert.equal(url.hostname, 'media.placeholder.invalid');
  assert.ok(url.hostname.endsWith('.invalid'), '缺省句柄必须是 RFC 6761 永不解析的占位域');
  // 契约句柄形态不因本次注入而变。
  assert.equal(url.protocol, 'https:');
  assert.equal(url.pathname, `/api/v1/media/${mediaId}/content`);
  assert.equal(url.search, '');
});

test('装配层：设了 MEDIA_ACCESS_GRANT_ORIGIN ⇒ 句柄 host 逐字跟随配置值（且由配置驱动，非常量）', async () => {
  const hosts = [];
  for (const [index, origin] of ['https://media-gateway-a.example.test', 'https://media-gateway-b.example.test:8443'].entries()) {
    const { url, config } = await ownerGrantUrl({ MEDIA_ACCESS_GRANT_ORIGIN: origin }, `configured-${index}`);

    assert.equal(config.mediaAccessGrantOrigin, origin, '配置层必须原样保留（已规范化）的网关原点');
    assert.equal(url.origin, origin, `句柄 origin 必须逐字等于装配处注入的配置值：${origin}`);
    assert.equal(new URL(origin).hostname, url.hostname);
    assert.equal(new URL(origin).port, url.port);
    assert.notEqual(url.hostname, 'media.placeholder.invalid', '设了配置就不得再落回占位域');
    hosts.push(url.host);
  }
  // 两个配置值 ⇒ 两个不同 host：证明 host 真的来自装配注入，而不是某个常量。
  assert.equal(new Set(hosts).size, hosts.length);
});

test('装配层：配置值的大小写/端口规范化结果原样出现在句柄里（装配只透传，不做二次改写）', async () => {
  const { url } = await ownerGrantUrl(
    { MEDIA_ACCESS_GRANT_ORIGIN: 'https://Media-Gateway-C.Example.TEST:443' },
    'normalized',
  );
  assert.equal(url.origin, 'https://media-gateway-c.example.test');
});
