/**
 * GY-R34 · I13 —— 合成产物（TTS）**真实对象存储端口**的离线回归（Refs #13）。
 *
 * 覆盖四组（派单 §测试）＋ 一组装配层读数：
 *   ① 未注入批准能力 ⇒ `unwired`，`put` 受控失败（`OBJECT_UNAVAILABLE`），`exists`/`describeObject` 不放行；
 *   ② 注入批准能力 ＋ 假对象存储 ⇒ `put` → 读回往返、键名规则（与媒体域同一 `newObjectRef()` 规则）、
 *      内容长度与 sha256 逐字节一致；
 *   ③ 存储故障（抛错／挂住超时／键冲突／存在性检查失败／替身产物／错误字节）⇒ 受控失败，绝不落「成功」；
 *   ④ 负控制：`real` 且**只有 env**（无批准能力）⇒ 仍 `unwired`（撤销注入即红）；
 *   ⑤ 装配层（`buildApp`）只转发不铸造；服务层（`createSynthesisService`）在真实端口下的作业态。
 *
 * 全部**离线**：假对象存储是 `MediaObjectStore` 的测试替身（⛔ 不是第二套 S3/OSS 客户端，
 * 一次网络请求都不发）；字节是 `ID3` + 合成载荷，**不是**任何真实 TTS 音频，
 * 也不构成任何音质／音色／自然度／听感结论。真实桶往返、真实 TTS、真机播放、30 段真实 TTS 评估
 * 全部**未取得**（见 `docs/verification/gy-r34-i13-tts-media-store-20261023.md`）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { STUB_IDEMPOTENCY_HMAC_KEY } from '../../services/api/src/auth/service.ts';
import { approveRealMediaWiring } from '../../services/api/src/media/service.ts';
import { createMemoryCheckedContentPort } from '../../services/api/src/tts/content.ts';
import {
  REAL_SYNTHESIS_ARTIFACT_CONTENT_TYPE,
  REAL_SYNTHESIS_MEDIA_APPROVAL_REQUIRED_REASON,
  REAL_SYNTHESIS_MEDIA_OBJECT_STORE_REQUIRED_REASON,
  SYNTHESIS_MEDIA_WIRING_REFUSALS,
  SynthesisMediaWiringError,
  approveRealSynthesisMediaWiring,
  createObjectStoreSynthesisMediaPort,
  createSynthesisMediaPort,
  hasMpegAudioHeader,
  isRealSynthesisMediaWiringApproved,
} from '../../services/api/src/tts/media.ts';
import { createSynthesisService } from '../../services/api/src/tts/service.ts';
import { createMemorySynthesisStore } from '../../services/api/src/tts/store.ts';
import { newObjectRef } from '../../packages/media/store.mjs';

const USER = 'user-owner-r34-i13';
const SYNTHESIS_ID = '00000000-0000-4000-8000-0000000000aa';
const FIXED_MEDIA_ID = '00000000-0000-4000-8000-0000000000b1';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 媒体域生成对象键的**同一条规则**：不透明 `obj_` + 18 字节 base64url（24 字符）。 */
const MEDIA_DOMAIN_KEY_PATTERN = /^obj_[A-Za-z0-9_-]{24}$/;

const HMAC_KEY = STUB_IDEMPOTENCY_HMAC_KEY ?? 'gengyun-stub-idempotency-hmac-key';
const REF = { type: 'answer', id: 'answer-approved-r34-i13', revision: 3 };
const TEXT = '合成用例文本（替身核对源条目，非真实资料）：稻田稗草三到五叶期。';

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 真实产物形状：`audio/mpeg` + `ID3` 头 + 确定性载荷（**不是**音频，不可播放）。 */
function realArtifact(payload = 'gy-r34-i13-synthetic-mpeg-payload') {
  const text = [...payload].map((char) => char.codePointAt(0));
  const body = new Uint8Array(3 + text.length);
  body.set([0x49, 0x44, 0x33]); // 'ID3'
  text.forEach((code, index) => {
    body[3 + index] = code & 0xff;
  });
  return { contentType: REAL_SYNTHESIS_ARTIFACT_CONTENT_TYPE, body, substitute: false };
}

function mintApproval(reason = 'unit-test：合成产物真实存储接线（离线，无真实桶）') {
  return approveRealSynthesisMediaWiring({ reason, approvedAt: '2026-10-23T00:00:00.000Z' });
}

/**
 * 假对象存储：`MediaObjectStore` 的**测试替身**（进程内 Map，零网络请求）。
 *
 * - `fail` 可读可写：`{ op: 'has'|'put'|'get', mode: 'throw'|'hang' }`，用来在任意时刻把某一步打成故障；
 * - `hasAlways` 为 true ⇒ 每次存在性检查都报「键已存在」（构造键冲突）；
 * - 未被本片使用的端口方法一律**抛错**：多调一次就红，避免「悄悄多调了别的东西」也当通过。
 */
function fakeObjectStore(options = {}) {
  const objects = new Map(); // key -> { bytes, contentType }
  const calls = { has: 0, put: 0, get: 0 };
  const store = {
    kind: options.kind ?? 's3_compatible',
    note: '假对象存储（测试替身：进程内 Map，不发起任何网络请求）',
    externalRequestCount: 0,
    fail: options.fail ?? null,
    hasAlways: options.hasAlways ?? false,
    objects,
    calls,
    async hasObject(key) {
      calls.has += 1;
      await maybeFail(store, 'has');
      if (store.hasAlways) return true;
      return objects.has(key);
    },
    async putObject(key, bytes, contentType) {
      calls.put += 1;
      await maybeFail(store, 'put');
      objects.set(key, { bytes: Uint8Array.from(bytes), contentType });
    },
    async getObject(key) {
      calls.get += 1;
      await maybeFail(store, 'get');
      const entry = objects.get(key);
      return entry === undefined ? null : { bytes: Uint8Array.from(entry.bytes), contentType: entry.contentType };
    },
    async deleteObject() {
      throw new Error('合成产物存储不得调用 deleteObject（本片没有删除/回收路径）');
    },
    async objectCount() {
      return objects.size;
    },
    async presignUpload() {
      throw new Error('合成产物存储不得签发上传句柄');
    },
    async presignDownload() {
      throw new Error('合成产物存储不得签发下载句柄');
    },
  };
  return store;
}

async function maybeFail(store, op) {
  const fail = store.fail;
  if (fail === null || fail.op !== op) return;
  if (fail.mode === 'throw') throw new Error(`假对象存储：${op} 失败（测试注入）`);
  if (fail.mode === 'hang') return new Promise(() => {});
  throw new Error(`假对象存储：未知故障模式 ${String(fail.mode)}`);
}

function wiredPort(options = {}) {
  const store = options.store ?? fakeObjectStore();
  const port = createSynthesisMediaPort('real', {
    objectStore: store,
    realSynthesisMediaApproval: options.approval ?? mintApproval(),
    ...(options.idFactory === undefined ? {} : { idFactory: options.idFactory }),
    ...(options.storageTimeoutMs === undefined ? {} : { storageTimeoutMs: options.storageTimeoutMs }),
  });
  return { store, port };
}

// ---------------------------------------------------------------- ① 未注入 ⇒ unwired

test('① real 未注入批准能力 ⇒ unwired，put/exists/describeObject 一律受控失败', async () => {
  const port = createSynthesisMediaPort('real');
  assert.equal(port.kind, 'unwired', '未注入批准能力时 real 必须仍是未接线端口');
  assert.equal(port.note, `${REAL_SYNTHESIS_MEDIA_APPROVAL_REQUIRED_REASON}（fail-closed）`);
  assert.equal(typeof port.readArtifact, 'undefined', '未接线端口不得提供读回入口');

  const put = await port.put({ ownerUserId: USER, synthesisId: SYNTHESIS_ID, artifact: realArtifact() });
  assert.deepEqual(put, { ok: false, code: 'OBJECT_UNAVAILABLE' }, 'put 必须受控失败');
  assert.equal(await port.exists(FIXED_MEDIA_ID), false, '未接线端口不得声称产物存在');
  assert.equal(await port.describeObject(FIXED_MEDIA_ID), null, '未接线端口不得给出任何产物标注');
});

test('①b 只有批准能力、没有真实端口 ⇒ 仍 unwired（文案点名缺端口）', async () => {
  const port = createSynthesisMediaPort('real', { realSynthesisMediaApproval: mintApproval() });
  assert.equal(port.kind, 'unwired');
  assert.equal(port.note, `${REAL_SYNTHESIS_MEDIA_OBJECT_STORE_REQUIRED_REASON}（fail-closed）`);
  const put = await port.put({ ownerUserId: USER, synthesisId: SYNTHESIS_ID, artifact: realArtifact() });
  assert.deepEqual(put, { ok: false, code: 'OBJECT_UNAVAILABLE' });
});

test('①c 批准能力 ＋ 替身 kind 的端口 ⇒ 仍 unwired（判据是端口 kind，不是自述）', async () => {
  const store = fakeObjectStore({ kind: 'substitute' });
  const port = createSynthesisMediaPort('real', {
    objectStore: store,
    realSynthesisMediaApproval: mintApproval(),
  });
  assert.equal(port.kind, 'unwired', '替身端口不得冒充真实存储');
  assert.match(port.note, /object_store_not_s3_compatible/, `拒绝原因必须可读：${port.note}`);
  assert.deepEqual(
    await port.put({ ownerUserId: USER, synthesisId: SYNTHESIS_ID, artifact: realArtifact() }),
    { ok: false, code: 'OBJECT_UNAVAILABLE' },
  );
  assert.equal(store.calls.put, 0, '未被批准的端口一次写入都不该发生');
});

// ------------------------------------------------------ ② 批准能力 + 假存储 ⇒ 往返

test('② 批准能力 ＋ 假对象存储 ⇒ put/读回往返、键名同媒体域规则、长度与哈希一致', async () => {
  const { store, port } = wiredPort();
  assert.equal(port.kind, 's3_compatible');
  assert.equal(typeof port.readArtifact, 'function', '真实端口必须提供读回入口');
  assert.equal(typeof port.objectKeyFor, 'function');

  const artifact = realArtifact();
  assert.equal(hasMpegAudioHeader(artifact.body), true, '夹具本身必须是带 ID3 头的字节');
  const put = await port.put({ ownerUserId: USER, synthesisId: SYNTHESIS_ID, artifact });
  assert.equal(put.ok, true, `真实端口必须写入成功：${JSON.stringify(put)}`);
  assert.equal(typeof put.mediaId, 'string');
  assert.match(put.mediaId, UUID_PATTERN, 'media_id 必须是契约要求的 uuid 形状');

  // 键名规则：与媒体域**同一条**（不透明 obj_ 引用），不是自造路径/前缀。
  const key = port.objectKeyFor(put.mediaId);
  assert.equal(typeof key, 'string');
  assert.match(newObjectRef(), MEDIA_DOMAIN_KEY_PATTERN, '媒体域规则对照（packages/media 的 newObjectRef）');
  assert.match(key, MEDIA_DOMAIN_KEY_PATTERN, `合成产物键名必须与媒体域同一规则，实际 ${String(key)}`);
  assert.equal(key.includes('/'), false, '键名不得是路径（不得自造 tts/… 之类前缀）');
  assert.deepEqual([...store.objects.keys()], [key], '写入的键必须与 objectKeyFor 报出的键一致');

  // 字节与内容类型原样落进对象存储。
  const stored = store.objects.get(key);
  assert.equal(stored.contentType, REAL_SYNTHESIS_ARTIFACT_CONTENT_TYPE, '必须按真实产物内容类型写入');
  assert.equal(stored.bytes.byteLength, artifact.body.byteLength);

  // 读回往返：长度与 sha256 逐字节一致。
  const read = await port.readArtifact(put.mediaId);
  assert.notEqual(read, null, '刚写入的产物必须读得回来');
  assert.equal(read.contentType, REAL_SYNTHESIS_ARTIFACT_CONTENT_TYPE);
  assert.equal(read.byteLength, artifact.body.byteLength);
  assert.equal(sha256Hex(read.bytes), sha256Hex(artifact.body), '读回字节的 sha256 必须与写入前一致');
  assert.deepEqual([...read.bytes], [...artifact.body], '读回字节必须与写入前逐个相等');

  // 标注与存在性。
  assert.equal(await port.exists(put.mediaId), true);
  const described = await port.describeObject(put.mediaId);
  assert.notEqual(described, null);
  assert.equal(described.contentType, REAL_SYNTHESIS_ARTIFACT_CONTENT_TYPE);
  assert.equal(described.byteLength, artifact.body.byteLength);
  assert.equal(described.substitute, false, '真实端口的产物不得标注成替身');
  assert.equal(typeof described.note, 'string');

  // 每次 put 用新键（不覆盖既有对象），且未知 media_id 如实返回 null。
  const second = await port.put({ ownerUserId: USER, synthesisId: SYNTHESIS_ID, artifact: realArtifact('second') });
  assert.equal(second.ok, true);
  assert.notEqual(port.objectKeyFor(second.mediaId), key);
  assert.equal(store.objects.size, 2);
  assert.equal(port.objectKeyFor(FIXED_MEDIA_ID), null, '未登记过的 media_id 不得凭空给出对象键');
  assert.equal(await port.readArtifact(FIXED_MEDIA_ID), null);
});

// ------------------------------------------------------------- ③ 存储故障 ⇒ 受控失败

test('③-1 写入抛错 ⇒ OBJECT_UNAVAILABLE，不登记索引、不返回 media_id', async () => {
  const store = fakeObjectStore({ fail: { op: 'put', mode: 'throw' } });
  const { port } = wiredPort({ store, idFactory: () => FIXED_MEDIA_ID });
  const put = await port.put({ ownerUserId: USER, synthesisId: SYNTHESIS_ID, artifact: realArtifact() });
  assert.deepEqual(put, { ok: false, code: 'OBJECT_UNAVAILABLE' });
  assert.equal(store.calls.put, 1, '确实尝试过写入（不是没接线就返回）');
  assert.equal(store.objects.size, 0);
  assert.equal(port.objectKeyFor(FIXED_MEDIA_ID), null, '写入失败不得留下「已登记」的索引');
  assert.equal(await port.exists(FIXED_MEDIA_ID), false);
});

test('③-2 写入挂住 ⇒ 截止时间后 OBJECT_UNAVAILABLE（不把作业挂在 running）', async () => {
  const store = fakeObjectStore({ fail: { op: 'put', mode: 'hang' } });
  const { port } = wiredPort({ store, storageTimeoutMs: 30, idFactory: () => FIXED_MEDIA_ID });
  const startedAt = Date.now();
  const put = await port.put({ ownerUserId: USER, synthesisId: SYNTHESIS_ID, artifact: realArtifact() });
  const elapsed = Date.now() - startedAt;
  assert.deepEqual(put, { ok: false, code: 'OBJECT_UNAVAILABLE' }, '超时必须受控失败，绝不落成功');
  assert.ok(elapsed >= 20, `必须在截止时间之后才返回（实际 ${elapsed}ms）`);
  assert.ok(elapsed < 3000, `不得无限等待（实际 ${elapsed}ms）`);
  assert.equal(store.objects.size, 0);
  assert.equal(port.objectKeyFor(FIXED_MEDIA_ID), null);
});

test('③-3 键冲突（存在性检查恒 true）⇒ OBJECT_UNAVAILABLE，且绝不覆盖写入', async () => {
  const store = fakeObjectStore({ hasAlways: true });
  const { port } = wiredPort({ store });
  const put = await port.put({ ownerUserId: USER, synthesisId: SYNTHESIS_ID, artifact: realArtifact() });
  assert.deepEqual(put, { ok: false, code: 'OBJECT_UNAVAILABLE' });
  assert.equal(store.calls.put, 0, '键已存在时不得写入（不得覆盖别人的对象）');
  assert.equal(store.calls.has, 3, '分配尝试必须有界（默认 3 次）');
  assert.equal(store.objects.size, 0);
});

test('③-4 存在性检查抛错 ⇒ OBJECT_UNAVAILABLE，且不尝试写入', async () => {
  const store = fakeObjectStore({ fail: { op: 'has', mode: 'throw' } });
  const { port } = wiredPort({ store });
  const put = await port.put({ ownerUserId: USER, synthesisId: SYNTHESIS_ID, artifact: realArtifact() });
  assert.deepEqual(put, { ok: false, code: 'OBJECT_UNAVAILABLE' });
  assert.equal(store.calls.put, 0);
});

test('③-5 替身产物进真实端口 ⇒ PROVIDER_OUTCOME_UNKNOWN，一个字节都不写', async () => {
  const store = fakeObjectStore();
  const { port } = wiredPort({ store });
  const substituteArtifact = {
    contentType: 'application/vnd.gengyun.substitute+json',
    body: new TextEncoder().encode('替身标注产物（非音频）'),
    substitute: true,
  };
  const put = await port.put({ ownerUserId: USER, synthesisId: SYNTHESIS_ID, artifact: substituteArtifact });
  assert.deepEqual(put, { ok: false, code: 'PROVIDER_OUTCOME_UNKNOWN' }, '替身不得冒充真实产物');
  assert.equal(store.calls.put, 0);
  assert.equal(store.objects.size, 0);
});

test('③-6 声明 audio/mpeg 却没有 MPEG/ID3 头（错误 JSON/HTML）⇒ MEDIA_TYPE_UNSUPPORTED，不写', async () => {
  const store = fakeObjectStore();
  const { port } = wiredPort({ store });
  const notAudio = {
    contentType: REAL_SYNTHESIS_ARTIFACT_CONTENT_TYPE,
    body: new TextEncoder().encode('<html><body>502 Bad Gateway</body></html>'),
    substitute: false,
  };
  assert.equal(hasMpegAudioHeader(notAudio.body), false);
  const put = await port.put({ ownerUserId: USER, synthesisId: SYNTHESIS_ID, artifact: notAudio });
  assert.deepEqual(put, { ok: false, code: 'MEDIA_TYPE_UNSUPPORTED' });
  assert.equal(store.calls.put, 0);

  // 非 audio/mpeg 的真实产物同样拒绝（真实适配器唯一产出是 audio/mpeg）。
  const otherType = { ...realArtifact(), contentType: 'audio/wav' };
  assert.deepEqual(
    await port.put({ ownerUserId: USER, synthesisId: SYNTHESIS_ID, artifact: otherType }),
    { ok: false, code: 'MEDIA_TYPE_UNSUPPORTED' },
  );
  assert.equal(store.objects.size, 0);
});

test('③-7 存在性查询故障 ⇒ exists 返回 false（fail-closed，不声称产物可用）', async () => {
  const store = fakeObjectStore();
  const { port } = wiredPort({ store });
  const put = await port.put({ ownerUserId: USER, synthesisId: SYNTHESIS_ID, artifact: realArtifact() });
  assert.equal(put.ok, true);
  assert.equal(await port.exists(put.mediaId), true);

  store.fail = { op: 'has', mode: 'throw' };
  assert.equal(await port.exists(put.mediaId), false, '没法确认产物仍在 ⇒ 按不可用处理');

  store.fail = null;
  store.objects.delete(port.objectKeyFor(put.mediaId));
  assert.equal(await port.exists(put.mediaId), false, '桶里已没有该键 ⇒ 如实报 false');
});

test('③-8 读回时存储故障 ⇒ 抛错（调用方必须能区分「没有」与「读不到」）', async () => {
  const store = fakeObjectStore();
  const { port } = wiredPort({ store });
  const put = await port.put({ ownerUserId: USER, synthesisId: SYNTHESIS_ID, artifact: realArtifact() });
  store.fail = { op: 'get', mode: 'throw' };
  await assert.rejects(() => port.readArtifact(put.mediaId), /假对象存储：get 失败/);
});

// ------------------------------------------------ ④ 负控制：只有 env / 跨域批准能力

test('④ 负控制：real 且只有 env（含 ambient process.env）⇒ 仍 unwired（撤销注入即红）', async () => {
  const env = {
    OBJECT_STORAGE_ENDPOINT: 'https://storage.example.test',
    OBJECT_STORAGE_BUCKET: 'gy-media-synthetic',
    OBJECT_STORAGE_ACCESS_KEY: 'AKIDR34SYNTHETICONLY',
    OBJECT_STORAGE_SECRET_KEY: 'r34-synthetic-not-a-real-secret',
    OBJECT_STORAGE_REGION: 'ap-shanghai',
    OBJECT_STORAGE_FORCE_PATH_STYLE: 'true',
  };
  const saved = new Map();
  for (const [name, value] of Object.entries(env)) {
    saved.set(name, process.env[name]);
    process.env[name] = value;
  }
  try {
    const cases = [
      ['不传 any 选项', undefined],
      ['空选项', {}],
      ['只传 env 记录', { env }],
      ['只传 env ＋ 一个 s3 端口（没有批准能力）', { env, objectStore: fakeObjectStore() }],
    ];
    for (const [label, options] of cases) {
      const port = options === undefined ? createSynthesisMediaPort('real') : createSynthesisMediaPort('real', options);
      assert.equal(port.kind, 'unwired', `${label}：real 仍必须是未接线端口`);
      assert.deepEqual(
        await port.put({ ownerUserId: USER, synthesisId: SYNTHESIS_ID, artifact: realArtifact() }),
        { ok: false, code: 'OBJECT_UNAVAILABLE' },
        `${label}：put 必须受控失败`,
      );
    }
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('④b 媒体域（#193）的批准能力不能打开合成产物端口（域各自批准）', async () => {
  const port = createSynthesisMediaPort('real', {
    objectStore: fakeObjectStore(),
    realSynthesisMediaApproval: approveRealMediaWiring({ reason: 'media-domain-only' }),
  });
  assert.equal(port.kind, 'unwired', '跨域的批准能力必须无效（两个 WeakSet 各自独立）');
  assert.deepEqual(
    await port.put({ ownerUserId: USER, synthesisId: SYNTHESIS_ID, artifact: realArtifact() }),
    { ok: false, code: 'OBJECT_UNAVAILABLE' },
  );
});

test('④c 同形／派生／Proxy／JSON 往返的「批准对象」一律无效', () => {
  const minted = mintApproval();
  assert.equal(isRealSynthesisMediaWiringApproved(minted), true, '铸造产物本身必须被判为有效');
  assert.equal(isRealSynthesisMediaWiringApproved({ ...minted }), false, '同形字面量/展开副本');
  assert.equal(isRealSynthesisMediaWiringApproved(Object.create(minted)), false, '派生对象');
  assert.equal(isRealSynthesisMediaWiringApproved(JSON.parse(JSON.stringify(minted))), false, 'JSON 往返副本');
  assert.equal(isRealSynthesisMediaWiringApproved(new Proxy(minted, {})), false, 'Proxy 包装');
  assert.equal(isRealSynthesisMediaWiringApproved(null), false);
  assert.equal(isRealSynthesisMediaWiringApproved(undefined), false);
  assert.equal(isRealSynthesisMediaWiringApproved('minted'), false);

  // 用假批准对象构造真实端口 ⇒ 必须抛（而不是悄悄构造出一个真实端口）。
  for (const fake of [{ ...minted }, Object.create(minted)]) {
    assert.throws(
      () => createObjectStoreSynthesisMediaPort({ objectStore: fakeObjectStore(), approval: fake }),
      SynthesisMediaWiringError,
    );
  }
});

test('④d 直接构造时的拒绝原因落在闭集里（approval_not_minted / object_store_not_injected / object_store_not_s3_compatible）', () => {
  const approval = mintApproval();
  const cases = [
    ['假批准对象', { objectStore: fakeObjectStore(), approval: { reason: 'x', approvedAt: '2026-01-01T00:00:00.000Z' } }, 'approval_not_minted'],
    ['没有端口', { objectStore: undefined, approval }, 'object_store_not_injected'],
    ['端口 kind 不对', { objectStore: fakeObjectStore({ kind: 'unwired' }), approval }, 'object_store_not_s3_compatible'],
  ];
  for (const [label, input, refusal] of cases) {
    assert.throws(
      () => createObjectStoreSynthesisMediaPort(input),
      (error) => {
        assert.equal(error.name, 'SynthesisMediaWiringError', label);
        assert.equal(error.refusal, refusal, label);
        assert.equal(SYNTHESIS_MEDIA_WIRING_REFUSALS.includes(error.refusal), true, `${label}：拒绝原因必须在闭集里`);
        return true;
      },
    );
  }
});

// ----------------------------------------------------- ⑤ 装配层与服务层的真实读数

test('⑤ 装配层只转发不铸造：注入完整 ⇒ s3_compatible；缺批准能力 ⇒ unwired；stub ⇒ 替身', async (t) => {
  const realConfig = { ...loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }), executionMode: 'real' };

  const plain = buildApp({ config: realConfig, store: createMemoryAuthStore() });
  t.after(() => plain.close());
  assert.equal(plain.synthesisService.describe().mediaPort, 'unwired', '零注入 + real 必须仍是未接线端口');

  const wired = buildApp({
    config: realConfig,
    store: createMemoryAuthStore(),
    synthesisMediaWiring: { objectStore: fakeObjectStore(), realSynthesisMediaApproval: mintApproval() },
  });
  t.after(() => wired.close());
  assert.equal(wired.synthesisService.describe().mediaPort, 's3_compatible', '显式注入后装配层必须把端口交给工厂');

  const halfWired = buildApp({
    config: realConfig,
    store: createMemoryAuthStore(),
    synthesisMediaWiring: { objectStore: fakeObjectStore() },
  });
  t.after(() => halfWired.close());
  assert.equal(halfWired.synthesisService.describe().mediaPort, 'unwired', '只有端口、没有批准能力 ⇒ 仍 fail-closed');

  const stubApp = buildApp({
    config: loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
    store: createMemoryAuthStore(),
    synthesisMediaWiring: { objectStore: fakeObjectStore(), realSynthesisMediaApproval: mintApproval() },
  });
  t.after(() => stubApp.close());
  assert.equal(stubApp.synthesisService.describe().mediaPort, 'substitute', 'stub 模式注入真实端口不得改变替身语义');
});

test('⑥ 服务层（真实端口）：写入失败 ⇒ 作业 failed + OBJECT_UNAVAILABLE；写入成功 ⇒ succeeded 且字节可读回', async () => {
  /** 真实模式脚本提供者（测试替身：不发任何供应商请求）。 */
  function scriptedRealProvider(artifact) {
    const state = { calls: 0 };
    return {
      state,
      provider: {
        executionMode: 'real',
        providerVersion: 'stub-real-port-test-v1',
        note: '测试脚本提供者（非真实 TTS；不产生任何真实音频，也不构成任何合成质量结论）',
        available: true,
        unavailableReason: null,
        async synthesize() {
          state.calls += 1;
          return { kind: 'completed', artifact };
        },
      },
    };
  }

  const content = createMemoryCheckedContentPort([
    { type: 'answer', id: REF.id, revision: REF.revision, auditState: 'approved', text: TEXT },
  ]);
  let keyCounter = 0;
  const nextKey = () => {
    keyCounter += 1;
    return `r34-i13-media-key-${String(keyCounter).padStart(4, '0')}`;
  };

  // ⑥a 写入失败：作业必须落 failed + OBJECT_UNAVAILABLE（与既有落库失败分类一致），无结果、无记录。
  const failingStore = fakeObjectStore({ fail: { op: 'put', mode: 'throw' } });
  const failingMedia = createSynthesisMediaPort('real', {
    objectStore: failingStore,
    realSynthesisMediaApproval: mintApproval(),
  });
  const failingProvider = scriptedRealProvider(realArtifact());
  const failingService = createSynthesisService({
    store: createMemorySynthesisStore(),
    provider: failingProvider.provider,
    media: failingMedia,
    content,
    idempotencyHmacKey: HMAC_KEY,
    now: () => new Date(),
  });
  const acceptedFail = await failingService.createSynthesis({
    userId: USER,
    body: { checked_content_ref: { ...REF }, locale: 'zh-CN' },
    idempotencyKey: nextKey(),
  });
  await failingService.settle();
  const failedJob = await failingService.inspectJob({ userId: USER, jobId: acceptedFail.job.id });
  assert.equal(failingProvider.state.calls, 1, '作业必须真的执行过一次（否则证明不了落库失败路径）');
  assert.equal(failedJob.state, 'failed', '落库失败不得落 succeeded');
  assert.equal(failedJob.error_code, 'OBJECT_UNAVAILABLE', '错误码必须与既有落库失败分类一致');
  assert.equal(failedJob.result, null, '失败作业不得带出结果（不得凭空给 media_id）');
  assert.equal(failingStore.objects.size, 0);

  // ⑥b 写入成功：作业 succeeded，且 result.media_id 能在端口里读回同一份字节。
  const store = fakeObjectStore();
  const media = createSynthesisMediaPort('real', {
    objectStore: store,
    realSynthesisMediaApproval: mintApproval(),
  });
  const artifact = realArtifact();
  const provider = scriptedRealProvider(artifact);
  const service = createSynthesisService({
    store: createMemorySynthesisStore(),
    provider: provider.provider,
    media,
    content,
    idempotencyHmacKey: HMAC_KEY,
    now: () => new Date(),
  });
  const accepted = await service.createSynthesis({
    userId: USER,
    body: { checked_content_ref: { ...REF }, locale: 'zh-CN' },
    idempotencyKey: nextKey(),
  });
  await service.settle();
  const settled = await service.inspectJob({ userId: USER, jobId: accepted.job.id });
  assert.equal(settled.state, 'succeeded', `真实端口写入成功后作业必须 succeeded：${JSON.stringify({
    state: settled.state,
    error_code: settled.error_code,
  })}`);
  assert.equal(settled.error_code, null);
  assert.notEqual(settled.result, null, '成功作业必须带出 SynthesisResult');
  const mediaId = settled.result.value.media_id;
  assert.match(mediaId, UUID_PATTERN, 'media_id 必须是 uuid');
  const readBack = await media.readArtifact(mediaId);
  assert.notEqual(readBack, null, '作业声称成功后，产物必须真的读得回来');
  assert.equal(sha256Hex(readBack.bytes), sha256Hex(artifact.body), '桶里的字节必须与提供者产物逐字节一致');
  assert.equal(store.objects.size, 1);
});
