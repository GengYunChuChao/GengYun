/**
 * R74（#13 TTS 客户端音频出口）· **服务端音频读面** `GET /api/v1/speech/synthesis/{id}/audio`
 * （契约 operation `readSynthesisAudio`）的真实回环 HTTP 回归。
 *
 * 覆盖（逐条可单独指出）：
 * - **（a）本人 + 终态成功 + 端口提供 `audio/wav`** ⇒ 200、`content-type` 按产物**真实**类型原样返回、
 *   字节**逐字节相等**、`cache-control: private, no-store`、**无 ETag**（不引入条件请求语义）；
 * - **（b）他人** ⇒ 404 且与「不存在」**逐字段同形**（不泄露存在性）；未登录 ⇒ 401；
 * - **（c）端口给的是非音频产物** ⇒ 契约闭集内错误码 `OBJECT_UNAVAILABLE`（409）+ 明确原因，
 *   **不得** 200、**不得**把非音频字节标成 `audio/*`；
 * - 其余如实拒绝：替身产物（stub 装配）⇒ 409；读端口未接线（real 默认 `unwired`）⇒ 409；
 *   产物缺失/已清理 ⇒ 409；对象存储读失败 ⇒ 409；0 字节产物 ⇒ 409；
 * - **边界不清**：媒体域 `/media/{id}/content` 仍然不存在（合成字节只能经本域私有读面，
 *   不得借机实现部署期访问网关的职责）。
 *
 * 声明：本文件**不含任何产品音频样本**——`SYNTHETIC_TEST_AUDIO` 是测试替身注入的几字节，
 * 不是录音、不是供应商产物、不落任何 fixture 音频文件；`real` 模式只用于走到「提供者给出
 * 真实音频产物」的分支，`synthesisProvider` 与 `synthesisMedia` 都是注入的替身实现，
 * **不触达任何真实 TTS 供应商或对象存储**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';
import { createMemoryCheckedContentPort } from '../../services/api/src/tts/content.ts';
import { createMemorySynthesisStore } from '../../services/api/src/tts/store.ts';

const API = '/api/v1';
const AUDIO = (id) => `${API}/speech/synthesis/${id}/audio`;
const SYNTHESIS_URL = `${API}/speech/synthesis`;
const START = Date.UTC(2026, 9, 14, 6, 0, 0);
const MISSING_ID = '00000000-0000-4000-8500-00000000dead';

const CHECKED_TEXT = '合成播报稿夹具：每亩用登记制剂 30 毫升，兑水 30 升常规喷雾。';
const REF = { type: 'answer', id: 'answer-r74-audio-approved', revision: 2 };

/**
 * **仅测试替身，不是产品样本**：几字节的合成占位，带 RIFF/WAVE 头只为让「产物像音频」这件事
 * 在测试里可判别（真实字节一律来自对象存储，本仓不存任何音频样本）。
 */
const SYNTHETIC_TEST_AUDIO = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
  0x66, 0x6d, 0x74, 0x20, 0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
]);

/** **仅测试替身，不是产品样本**：明确不是音频的字节（用于「不得把非音频伪装成音频」用例）。 */
const SYNTHETIC_NON_AUDIO = new TextEncoder().encode('这不是音频字节（测试替身，非产品样本）');

/** 替身核对源：一条 `approved` 条目（**合成夹具**，非真实资料库、非真实审核结论）。 */
function contentPort() {
  return createMemoryCheckedContentPort([
    { type: REF.type, id: REF.id, revision: REF.revision, auditState: 'approved', text: CHECKED_TEXT, ownerUserId: null },
  ]);
}

/**
 * 注入式产物端口：内存里保存**测试注入的**合成字节，并同时提供读端口
 * （`readArtifact` / `objectKeyFor`）——`asSynthesisMediaReadPort` 的鸭子探测据此接上读面。
 * 全部失败分支可**逐条注入**，用于验证读面对「没有」「读不到」「不是音频」的区分。
 */
function injectedMediaPort() {
  const objects = new Map();
  const overrides = new Map();
  return {
    kind: 's3_compatible',
    note: '注入式测试产物端口（内存）：只保存测试注入的合成字节；不接对象存储、不产任何产品样本',
    async put({ ownerUserId, synthesisId, artifact }) {
      const mediaId = randomUUID();
      objects.set(mediaId, {
        bytes: Uint8Array.from(artifact.body),
        contentType: artifact.contentType,
        byteLength: artifact.body.byteLength,
        ownerUserId,
        synthesisId,
      });
      return { ok: true, mediaId };
    },
    async exists(mediaId) {
      return objects.has(mediaId);
    },
    async describeObject(mediaId) {
      const item = objects.get(mediaId);
      if (item === undefined) return null;
      return { contentType: item.contentType, byteLength: item.byteLength, substitute: false, note: '注入式测试产物' };
    },
    async readArtifact(mediaId) {
      const override = overrides.get(mediaId);
      if (override === 'throw') throw new Error('模拟对象存储读取失败（注入）');
      if (override === 'missing') return null;
      if (override !== undefined) return override;
      const item = objects.get(mediaId);
      if (item === undefined) return null;
      return { bytes: item.bytes, contentType: item.contentType, byteLength: item.byteLength };
    },
    objectKeyFor(mediaId) {
      return objects.has(mediaId) ? `synthetic/test/${mediaId}` : null;
    },
    /** 注入下一次读取的结果：`'missing'` / `'throw'` / 具体产物对象。 */
    overrideRead(mediaId, value) {
      overrides.set(mediaId, value);
    },
    clearOverrides() {
      overrides.clear();
    },
    raw(mediaId) {
      return objects.get(mediaId) ?? null;
    },
  };
}

/**
 * 注入式提供者：`executionMode: 'real'` + 回**注入的**产物。
 * 不触达任何真实供应商；`real` 只为走「服务端判定为真实音频产物」那一支。
 */
function injectedProvider(contentType, body) {
  return {
    executionMode: 'real',
    providerVersion: 'synthetic-test-audio-v1',
    note: '注入式测试提供者（回注入的合成字节；不触达任何真实 TTS 供应商）',
    available: true,
    unavailableReason: null,
    async synthesize() {
      return { kind: 'completed', artifact: { contentType, body: Uint8Array.from(body), substitute: false } };
    },
  };
}

async function buildFixture(t, options = {}) {
  const auth = options.auth ?? createMemoryAuthStore();
  const baseConfig = loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' });
  const config = options.real === true ? { ...baseConfig, executionMode: 'real', requiresRealCredentials: true } : baseConfig;
  const synthesisStore = options.synthesisStore ?? createMemorySynthesisStore();
  const mediaPort = options.mediaPort;
  const app = buildApp({
    config,
    store: auth,
    now: () => new Date(START),
    synthesisStore,
    synthesisContent: contentPort(),
    ...(options.provider === undefined ? {} : { synthesisProvider: options.provider }),
    ...(mediaPort === undefined ? {} : { synthesisMedia: mediaPort }),
  });
  const account = async (seed) => {
    const user = await auth.createUser(seed.repeat(64));
    const token = `synthetic-r74-audio-token-${seed}`;
    await auth.createSession({
      userId: user.id,
      tokenHashHex: hashToken(token),
      authEpoch: user.authEpoch,
      expiresAt: new Date(START + 48 * 3600_000),
      audience: 'user',
    });
    return { user, token };
  };
  const a = options.actorA ?? (await account('a'));
  const b = options.actorB ?? (await account('b'));
  t.after(() => app.close());

  const call = async (method, path, actor = a, { headers = {}, payload } = {}) => {
    const response = await app.inject({
      method,
      url: path,
      headers: {
        ...(actor ? { authorization: `Bearer ${actor.token}` } : {}),
        ...headers,
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
    const text = response.body;
    const isJson = String(response.headers['content-type'] || '').includes('application/json');
    return {
      status: response.statusCode,
      headers: response.headers,
      bytes: response.rawPayload,
      json: !isJson || text === '' ? null : JSON.parse(text),
    };
  };
  return { app, auth, synthesisStore, mediaPort, a, b, call };
}

let keySeq = 0;
const nextKey = () => `synthetic-r74-idem-key-${String((keySeq += 1)).padStart(4, '0')}`;

/** 受理一条合成任务并等执行落定；返回契约 `Job`（其 `result.value` 才有 synthesis id / media_id）。 */
async function acceptOne(h) {
  const accepted = await h.call('POST', SYNTHESIS_URL, h.a, {
    headers: { 'idempotency-key': nextKey() },
    payload: { checked_content_ref: { ...REF }, locale: 'zh-CN' },
  });
  assert.equal(accepted.status, 202, `受理应 202，实际 ${accepted.status}：${JSON.stringify(accepted.json)}`);
  await h.app.synthesisService.settle();
  const jobId = accepted.json.data.id;
  const read = await h.call('GET', `${API}/jobs/${jobId}`, h.a);
  assert.equal(read.status, 200);
  assert.equal(read.json.data.state, 'succeeded', `任务应成功，实际 ${read.json.data.state}：${JSON.stringify(read.json.data)}`);
  return read.json.data;
}

/** 直接落一条合成记录（用于精确构造「读端口未接线」而不需要跑完整执行）。 */
async function seedSynthesis(store, { ownerUserId, mediaId = randomUUID(), substitute = false }) {
  const id = randomUUID();
  const at = new Date(START);
  await store.insertSynthesis({
    id,
    revision: 1,
    ownerUserId,
    checkedContentRef: { ...REF },
    mediaId,
    substitute,
    providerVersion: 'seeded-test-v1',
    createdAt: at,
    updatedAt: at,
  });
  return { id, mediaId };
}

// ---------------------------------------------------------------- （a）本人终态 + audio/wav

test('（a）本人终态合成 + 端口提供 audio/wav ⇒ 200、content-type 原样、字节逐字相等、private no-store、无 ETag', async (t) => {
  const mediaPort = injectedMediaPort();
  const h = await buildFixture(t, { real: true, mediaPort, provider: injectedProvider('audio/wav', SYNTHETIC_TEST_AUDIO) });
  const job = await acceptOne(h);
  const synthesisId = job.result.value.id;

  const response = await h.call('GET', AUDIO(synthesisId), h.a);
  assert.equal(response.status, 200, `本人读自己的产物应 200，实际 ${response.status}：${response.json && JSON.stringify(response.json)}`);
  assert.equal(response.headers['content-type'], 'audio/wav', 'content-type 必须按产物真实类型原样返回');
  assert.equal(response.headers['cache-control'], 'private, no-store', 'Cache-Control 必须是 private, no-store');
  assert.equal(response.headers['etag'], undefined, '不得引入 ETag 语义（不新增条件请求复杂度）');
  assert.equal(response.headers['content-disposition'], undefined, '不得擅自加下载语义');
  assert.equal(response.headers['x-execution-mode'], 'real');
  assert.ok(Buffer.isBuffer(response.bytes));
  assert.equal(
    Buffer.compare(response.bytes, Buffer.from(SYNTHETIC_TEST_AUDIO)),
    0,
    '返回字节必须与产物字节逐字节相等（不转码、不裁剪、不拼接）',
  );

  // 产物字节只经本域读面：媒体域仍然没有字节出口（部署期访问网关的职责不在冻结契约内）。
  const mediaId = job.result.value.media_id;
  const mediaDomain = await h.call('GET', `${API}/media/${mediaId}`, h.a);
  assert.ok(mediaDomain.status >= 400, `媒体域的元数据面不得给出产物字节（实际 ${mediaDomain.status}）`);
  const forbidden = await h.call('GET', `${API}/media/${mediaId}/content`, h.a);
  assert.ok(forbidden.status >= 400, `⛔ /media/{id}/content 必须仍然不存在（实际 ${forbidden.status}）`);
  assert.equal(String(forbidden.headers['content-type']).startsWith('audio/'), false);
  assert.equal(forbidden.bytes.includes(Buffer.from(SYNTHETIC_TEST_AUDIO)), false, '媒体域不得回吐合成字节');
});

// ---------------------------------------------------------------- （b）他人 ⇒ 同形 404

test('（b）他人读同一条合成 id ⇒ 404 且与「不存在」逐字段同形（不泄露存在性）', async (t) => {
  const mediaPort = injectedMediaPort();
  const h = await buildFixture(t, { real: true, mediaPort, provider: injectedProvider('audio/wav', SYNTHETIC_TEST_AUDIO) });
  const job = await acceptOne(h);
  const synthesisId = job.result.value.id;

  const foreign = await h.call('GET', AUDIO(synthesisId), h.b);
  const missing = await h.call('GET', AUDIO(MISSING_ID), h.b);
  assert.equal(foreign.status, 404, `他人读应 404，实际 ${foreign.status}`);
  assert.equal(foreign.json.error.code, 'NOT_FOUND');
  assert.equal(missing.status, 404);
  assert.deepEqual(foreign.json.error, missing.json.error, '他人产物与「不存在」必须逐字段同形（不泄露存在性）');
  assert.equal(foreign.json.error.retryable, false);
  assert.deepEqual(foreign.json.error.details, [], '不得回传对象键/内部标识等细节');
  assert.equal(Buffer.isBuffer(foreign.bytes) && foreign.bytes.includes(Buffer.from(SYNTHETIC_TEST_AUDIO)), false, '不得回吐任何字节');

  // 未登录 ⇒ 401（私有读面，没有匿名入口）
  const guest = await h.call('GET', AUDIO(synthesisId), null);
  assert.equal(guest.status, 401);
  assert.equal(guest.json.error.code, 'SESSION_REQUIRED');

  // 形状非法与「不存在」走同一句 404（刻意不声明 format: uuid，避免泄露「形状对/错」的额外信息）
  const malformed = await h.call('GET', AUDIO('not-a-uuid'), h.a);
  assert.equal(malformed.status, 404);
  assert.deepEqual(malformed.json.error, missing.json.error);
});

// ---------------------------------------------------------------- （c）非音频产物必须拒绝

test('（c）端口给的是非音频产物 ⇒ 409 OBJECT_UNAVAILABLE + 明确原因，绝不 200 audio、绝不伪装成音频', async (t) => {
  const mediaPort = injectedMediaPort();
  const h = await buildFixture(t, { real: true, mediaPort, provider: injectedProvider('text/plain', SYNTHETIC_NON_AUDIO) });
  const job = await acceptOne(h);
  const synthesisId = job.result.value.id;

  const response = await h.call('GET', AUDIO(synthesisId), h.a);
  assert.equal(response.status, 409, `非音频产物必须拒绝（409），实际 ${response.status}`);
  assert.equal(response.json.error.code, 'OBJECT_UNAVAILABLE', '拒绝码必须落在契约错误码闭集内');
  assert.equal(response.json.error.retryable, false);
  assert.match(response.json.error.message, /非音频|替身/, '文案必须点明「这是替身/非音频产物」');
  assert.equal(
    String(response.headers['content-type']).startsWith('audio/'),
    false,
    '⛔ 绝不把非音频字节标成 audio/* 返回',
  );
  assert.equal(
    response.bytes.includes(Buffer.from(SYNTHETIC_NON_AUDIO)),
    false,
    '拒绝时不得回吐产物字节（错误响应只带契约错误封套）',
  );
});

// ---------------------------------------------------------------- 其余如实拒绝分支

test('替身产物（stub 装配）⇒ 409 OBJECT_UNAVAILABLE：明确说清「替身产物不是音频」', async (t) => {
  const h = await buildFixture(t);
  const job = await acceptOne(h);
  const response = await h.call('GET', AUDIO(job.result.value.id), h.a);
  assert.equal(response.status, 409, `替身产物必须拒绝，实际 ${response.status}`);
  assert.equal(response.json.error.code, 'OBJECT_UNAVAILABLE');
  assert.match(response.json.error.message, /替身/);
  assert.equal(String(response.headers['content-type']).startsWith('audio/'), false);
});

test('读端口未接线（real 默认 unwired）⇒ 409 OBJECT_UNAVAILABLE：文案说清「未接线」', async (t) => {
  const h = await buildFixture(t, { real: true });
  const seeded = await seedSynthesis(h.synthesisStore, { ownerUserId: h.a.user.id });
  const response = await h.call('GET', AUDIO(seeded.id), h.a);
  assert.equal(response.status, 409, `未接线必须拒绝，实际 ${response.status}：${JSON.stringify(response.json)}`);
  assert.equal(response.json.error.code, 'OBJECT_UNAVAILABLE');
  assert.match(response.json.error.message, /未接线/);
});

test('产物缺失/已清理 ⇒ 409 OBJECT_UNAVAILABLE；对象存储读失败 ⇒ 409（区分「没有」与「读不到」）', async (t) => {
  const mediaPort = injectedMediaPort();
  const h = await buildFixture(t, { real: true, mediaPort, provider: injectedProvider('audio/wav', SYNTHETIC_TEST_AUDIO) });
  const job = await acceptOne(h);
  const synthesisId = job.result.value.id;
  const mediaId = job.result.value.media_id;

  mediaPort.overrideRead(mediaId, 'missing');
  const missing = await h.call('GET', AUDIO(synthesisId), h.a);
  assert.equal(missing.status, 409);
  assert.equal(missing.json.error.code, 'OBJECT_UNAVAILABLE');
  assert.match(missing.json.error.message, /不可用|已清理/);

  mediaPort.overrideRead(mediaId, 'throw');
  const broken = await h.call('GET', AUDIO(synthesisId), h.a);
  assert.equal(broken.status, 409);
  assert.equal(broken.json.error.code, 'OBJECT_UNAVAILABLE');
  assert.match(broken.json.error.message, /读取失败/);
  assert.notEqual(broken.json.error.message, missing.json.error.message, '「读不到」与「没有」必须是两条不同口径');

  mediaPort.overrideRead(mediaId, { bytes: new Uint8Array(0), contentType: 'audio/wav', byteLength: 0 });
  const empty = await h.call('GET', AUDIO(synthesisId), h.a);
  assert.equal(empty.status, 409, '0 字节产物不得当 200 空音频返回');
  assert.equal(empty.json.error.code, 'OBJECT_UNAVAILABLE');
  assert.match(empty.json.error.message, /空|0 字节/);

  mediaPort.clearOverrides();
  const restored = await h.call('GET', AUDIO(synthesisId), h.a);
  assert.equal(restored.status, 200, '清掉注入后应恢复可读（证明上面三条是注入导致的，不是永久性破坏）');
  assert.equal(Buffer.compare(restored.bytes, Buffer.from(SYNTHETIC_TEST_AUDIO)), 0);
});
