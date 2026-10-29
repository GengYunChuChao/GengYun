/**
 * GY-R69 · **OCR 待识别图片字节来源（`OcrImageSource`）** 接线回归（全离线：不外呼、不读任何凭据、不写台账）。
 *
 * 背景（本片要关的卡点）：`services/api/src/ocr/provider.ts` 原先在 `real` + 有被校验快照的分支里**写死**注入
 * `createUnwiredImageSource('真实对象存储未接线…')`，它 `read()` 恒返回 `null` ⇒ 即使凭据齐备，适配器也一个
 * 字节都发不出去（永远 `failed PROVIDER_UNAVAILABLE`）。本片新增 `services/api/src/ai/ocr-image-source.ts`
 * （`createObjectStoreOcrImageSource()`）并把它接进装配，形状与失败语义对齐语音侧
 * `services/api/src/ai/asr-audio-source.ts`。
 *
 * 五条必须一直成立的事（删/改任一条即红，见交付回报里的负控制表）：
 *  A. **字节真的流到适配器**：对象存储端口里的那一段 PNG 逐字节出现在 OCR 请求体的 `ImageBase64` 里
 *     （恰好一次发送）；且**只读**去元数据衍生件（`derivativeRef`），原件键（`rawRef`）**一次都不读**。
 *  B. **失败逐条可指**：记录不存在 / 无对象键 / 只有含元数据原件 / 对象不存在 / 端口未接线 / 端口抛无码错误 /
 *     Content-Type 不受支持 / 空字节 / 未就绪 / 跨用途 / 版本不符 ⇒ `read()` 返回 `null` 且 `lastFailure()`
 *     留下**既有契约错误码**，适配器一律 `failed PROVIDER_UNAVAILABLE`、零预留、零发包。**绝不返回空字节或替身图**。
 *  C. **「不给端口 ⇒ 行为不变」**：`createOcrProvider({...})` 在**不给** `imageSource`（`undefined` / `null`）时，
 *     与接线前的装配（`createLiveOcrProviderFromConfig` + 写死的未接线来源）**逐字段相同**，且装配表达式逐字未变。
 *  D. **零外呼**：本文件所有用例都不联网；`globalThis.fetch` 在需要时换成捕获/绊线实现（手法与
 *     `tests/unit/ai-live-provider-wiring.test.mjs` 的头注一致：绊线被触发即抛错，任何一次真实外呼都会让用例红）。
 *  E. **装配点只转发既有端口**：`app.ts` 按 `speechAudioMedia` 同形转发媒体域**既有**的 `mediaObjectStore` +
 *     `mediaStore`（不新建存储、不读 env、不铸造批准能力），`routes/ocr.ts` 把它交给 `createOcrProvider`。
 *
 * ⚠ 本文件的字节全部是**合成 PNG 头**（24 字节，不含任何真实照片/EXIF）；检出文本是合成占位串，
 *    **不构成任何识别准确率证据**。本片证明的是「字节端口已接线、失败语义可判定」，不是「OCR 能力可用」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import Fastify from 'fastify';

import { MEDIA_PURPOSE_KIND, MEDIA_PURPOSE_MIME, MEDIA_PURPOSES } from '../../packages/media/constants.mjs';

import {
  OCR_IMAGE_CONTENT_TYPES,
  OCR_IMAGE_FAILURE_CODES,
  OCR_IMAGE_PURPOSES,
  createObjectStoreOcrImageSource,
} from '../../services/api/src/ai/ocr-image-source.ts';
import {
  createLiveOcrProviderFromConfig,
  createUnwiredImageSource,
  requireLiveOcrImage,
} from '../../services/api/src/ai/ocr-live-adapter.ts';
import { PRODUCT_GATE_AUTHORIZATION } from '../../services/api/src/ai/live-gate.ts';
import { ERROR_CODES } from '../../services/api/src/contract.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createUnwiredObjectStore } from '../../services/api/src/media/object-store.ts';
import { createOcrProvider } from '../../services/api/src/ocr/provider.ts';
import { createSubstituteMediaPort } from '../../services/api/src/ocr/media.ts';
import { createOcrDosePort, createOcrReferencePort } from '../../services/api/src/ocr/reference.ts';
import { registerOcrRoutes } from '../../services/api/src/routes/ocr.ts';

const REPO = new URL('../../', import.meta.url);
const readRepoText = (relative) => readFileSync(new URL(relative, REPO), 'utf8');

const JOB_ID = '11111111-2222-4333-8444-555555555555';
const MEDIA_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const RAW_KEY = 'media-raw/synthetic-r69-original-with-exif-0001';
const DERIVED_KEY = 'media-derived/synthetic-r69-stripped-0001';
const OWNER = 'user-owner-r69-ocr-bytes';
const REQUEST_ID = '01234567-89ab-cdef-0123-456789abcdef';

/** `loadConfig` 的 real 模式必填项（全部合成占位，不连任何真实资源、不打印任何真实凭据）。 */
const REAL_ENV = {
  APP_EXECUTION_MODE: 'real',
  DATABASE_URL: 'postgres://synthetic_local_only@127.0.0.1:5432/gengyun_synthetic_never_connected',
  SESSION_SIGNING_KEY: 'synthetic-not-a-real-signing-key',
  DELETION_LEDGER_KEY: 'synthetic-not-a-real-ledger-key',
  WECHAT_APP_ID: 'synthetic-not-a-real-appid',
  WECHAT_APP_SECRET: 'synthetic-not-a-real-appsecret',
  OBJECT_STORAGE_ENDPOINT: 'https://example.invalid',
  OBJECT_STORAGE_BUCKET: 'synthetic-not-a-real-bucket',
  OBJECT_STORAGE_ACCESS_KEY: 'synthetic-not-a-real-access-key',
  OBJECT_STORAGE_SECRET_KEY: 'synthetic-not-a-real-secret-key',
};

/** OCR 凭据齐备的**被校验快照**（经 `loadConfig` 得到，不是手搓对象）。 */
const CONFIGURED = loadConfig({
  ...REAL_ENV,
  LOG_LEVEL: 'silent',
  TENCENTCLOUD_SECRET_ID: 'synthetic-shared-secret-id-r69',
  TENCENTCLOUD_SECRET_KEY: 'synthetic-shared-secret-key-r69',
});

/** 最小合法 PNG 头（8 字节签名 + IHDR 长度 + 'IHDR' + 宽 + 高），24 字节；`requireLiveOcrImage` 认它。 */
const PNG = (() => {
  const buffer = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(2, 16);
  buffer.writeUInt32BE(2, 20);
  return new Uint8Array(buffer);
})();

/** 媒体登记册行（默认＝「已就绪的标签 OCR 图片，衍生件在」；`overrides` 用来制造各种不合格）。 */
function imageRecord(overrides = {}) {
  return {
    id: MEDIA_ID,
    revision: 1,
    state: 'ready',
    purpose: 'label_ocr',
    rawRef: RAW_KEY,
    derivativeRef: DERIVED_KEY,
    ...overrides,
  };
}

/** 假登记册：只实现本端口用到的 `getMedia`，并记录每次读取的 mediaId。 */
function fakeRegistry(records = new Map(), options = {}) {
  const calls = [];
  return {
    kind: 'substitute',
    calls,
    async getMedia(mediaId) {
      calls.push(mediaId);
      if (options.throw !== undefined) throw options.throw;
      return records.get(mediaId) ?? null;
    },
  };
}

/** 假对象存储：记录每次 `getObject(key)` 的键（用来证明「只读衍生件、不碰原件」）。 */
function fakeObjectStore(options = {}) {
  const calls = [];
  return {
    kind: 'substitute',
    calls,
    async getObject(key) {
      calls.push(key);
      if (options.throw !== undefined) throw options.throw;
      return options.objects?.[key] ?? null;
    },
  };
}

/** 只记次数的预算闸：本地拒绝必须**撞不到**它（`reserves === 0` 即"未拆封"）。 */
function fakeGate() {
  const state = { reserves: 0, settles: 0 };
  return {
    state,
    gate: {
      async reserve(input) {
        state.reserves += 1;
        return {
          capability: input.capability,
          authorization: input.authorization,
          reservedCny: 0.0021,
          attemptKey: input.attemptKey,
        };
      },
      async settle() {
        state.settles += 1;
      },
    },
  };
}

/** 捕获型 fetch：记录每一次调用与请求体，返回合成成功响应（**不联网**）。 */
function captureFetch(payload) {
  const state = { calls: 0, urls: [], bodies: [], inits: [] };
  const fn = async (url, init) => {
    state.calls += 1;
    state.urls.push(String(url));
    state.bodies.push(init?.body);
    state.inits.push(init);
    return {
      ok: true,
      status: 200,
      async json() {
        return { Response: payload };
      },
    };
  };
  return { state, fn };
}

/** 绊线 fetch：任何一次调用都算失败（用来证明"零外呼"）。 */
function tripwireFetch() {
  const state = { calls: 0 };
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    state.calls += 1;
    throw new Error(`绊线被触发：本测试不得发出任何真实请求（${String(url)}）`);
  };
  return {
    state,
    restore() {
      globalThis.fetch = original;
    },
  };
}

const OK_PAYLOAD = {
  RequestId: REQUEST_ID,
  TextDetections: [
    { DetectedText: '农药登记证号：PD20210001', Confidence: 99 },
    { DetectedText: '农药名称：合成示例草甘膦水剂', Confidence: 98 },
  ],
};

/** 一个「端口齐备且全部合格」的字节来源（正控制 / 侧向用例的基线）。 */
function wiredSource(recordOverrides = {}, storeOptions = {}) {
  const mediaRecords = fakeRegistry(new Map([[MEDIA_ID, imageRecord(recordOverrides)]]));
  const objectStore = fakeObjectStore({
    objects: { [DERIVED_KEY]: { bytes: PNG, contentType: 'image/png' } },
    ...storeOptions,
  });
  return { source: createObjectStoreOcrImageSource({ mediaRecords, objectStore }), mediaRecords, objectStore };
}

// ---------------------------------------------------------------- A. 字节真的流到适配器

test('A·正控制：只读去元数据衍生件取到字节，且字节逐字节进请求体、恰好一次发送', async () => {
  const bag = wiredSource();
  const bytes = await bag.source.read({ jobId: JOB_ID, mediaId: MEDIA_ID, mediaRevision: 1 });
  assert.equal(bytes instanceof Uint8Array, true, '应当取到字节');
  assert.equal(Buffer.compare(Buffer.from(bytes), Buffer.from(PNG)), 0, '取到的必须是对象存储里的那一段字节');
  assert.equal(bag.source.lastFailure(), null);
  assert.equal(bag.source.lastFailureReason(), null);
  assert.equal(bag.source.kind, 'wired');
  // 隐私红线：只读衍生件；**原件（含 EXIF/GPS）一次都不读**。
  assert.deepEqual(bag.objectStore.calls, [DERIVED_KEY], '只允许读去元数据衍生件，不得读 rawRef');
  assert.equal(bag.objectStore.calls.includes(RAW_KEY), false, '原件键不得出现在任何一次 getObject 里');

  // 经**产品同一个适配器**（`createLiveOcrProviderFromConfig`）证明字节真的被发出去。
  const fetched = captureFetch(OK_PAYLOAD);
  const gateBag = fakeGate();
  const provider = createLiveOcrProviderFromConfig(CONFIGURED.aiProviders.ocr, {
    authorization: PRODUCT_GATE_AUTHORIZATION,
    imageSource: bag.source,
    liveGate: gateBag.gate,
    fetchImpl: fetched.fn,
  });
  const outcome = await provider.extract({ jobId: JOB_ID, mediaId: MEDIA_ID, mediaRevision: 1 });
  assert.equal(outcome.kind, 'completed');
  assert.equal(fetched.state.calls, 1, '恰好发送一次');
  assert.equal(fetched.state.urls[0], 'https://ocr.tencentcloudapi.com');
  const body = JSON.parse(fetched.state.bodies[0]);
  assert.deepEqual(Object.keys(body), ['ImageBase64']);
  assert.equal(
    Buffer.compare(Buffer.from(body.ImageBase64, 'base64'), Buffer.from(PNG)),
    0,
    '请求体里的图片字节必须与对象存储端口里的那一段逐字节相同（不是空、不是占位、不是别的对象）',
  );
  assert.equal(gateBag.state.reserves, 1);
  assert.equal(gateBag.state.settles, 1);
});

test('A·Content-Type 归一：`IMAGE/PNG; charset=binary` 判为 image/png 并放行（不是"什么都拒"）', async () => {
  const bag = wiredSource({}, { objects: { [DERIVED_KEY]: { bytes: PNG, contentType: 'IMAGE/PNG; charset=binary' } } });
  const bytes = await bag.source.read({ jobId: JOB_ID, mediaId: MEDIA_ID, mediaRevision: 1 });
  assert.equal(Buffer.compare(Buffer.from(bytes), Buffer.from(PNG)), 0);
  assert.equal(bag.source.lastFailure(), null);
});

// ---------------------------------------------------------------- B. 失败矩阵（逐条可指）

test('B·失败矩阵：六类坏输入 + 四类附带情形 ⇒ 可判定失败码，适配器对外一律 PROVIDER_UNAVAILABLE、零预留零发包', async () => {
  const cases = [
    {
      label: '媒体记录不存在',
      expect: 'NOT_FOUND',
      reasonIncludes: '媒体记录不存在',
      spec: { registryRecords: new Map() },
    },
    {
      label: 'rawRef 与 derivativeRef 均为空（无对象键）',
      expect: 'OBJECT_UNAVAILABLE',
      reasonIncludes: '没有对象键',
      spec: { record: { rawRef: null, derivativeRef: null } },
    },
    {
      label: '只有含元数据的原件（derivativeRef 为空，绝不回退读原件）',
      expect: 'OBJECT_UNAVAILABLE',
      reasonIncludes: '原始对象不出网',
      spec: { record: { derivativeRef: null } },
    },
    {
      label: 'getObject 返回 null（对象不存在）',
      expect: 'OBJECT_UNAVAILABLE',
      reasonIncludes: '没有该对象',
      spec: { storeOptions: { objects: {} } },
    },
    {
      label: 'getObject 抛 MediaError(PROVIDER_UNAVAILABLE)（未接线端口）——码必须原样保留',
      expect: 'PROVIDER_UNAVAILABLE',
      reasonIncludes: '取字节失败',
      spec: { objectStoreUnwired: true },
    },
    {
      label: 'getObject 抛无码错误',
      expect: 'OBJECT_UNAVAILABLE',
      reasonIncludes: '取字节失败',
      spec: { storeOptions: { throw: new Error('synthetic port failure') } },
    },
    {
      label: 'Content-Type 不受支持（image/webp：label_ocr 合法上传、本适配器不可识别）',
      expect: 'OBJECT_UNAVAILABLE',
      reasonIncludes: 'Content-Type',
      spec: { storeOptions: { objects: { [DERIVED_KEY]: { bytes: PNG, contentType: 'image/webp' } } } },
    },
    {
      label: 'Content-Type 缺失（application/octet-stream）',
      expect: 'OBJECT_UNAVAILABLE',
      reasonIncludes: 'Content-Type',
      spec: { storeOptions: { objects: { [DERIVED_KEY]: { bytes: PNG, contentType: 'application/octet-stream' } } } },
    },
    {
      label: '对象字节为空（不许交空字节包）',
      expect: 'OBJECT_UNAVAILABLE',
      reasonIncludes: '字节为空',
      spec: { storeOptions: { objects: { [DERIVED_KEY]: { bytes: new Uint8Array(0), contentType: 'image/png' } } } },
    },
    {
      label: '媒体未就绪（uploaded）',
      expect: 'OBJECT_UNAVAILABLE',
      reasonIncludes: '未就绪',
      spec: { record: { state: 'uploaded' } },
    },
    {
      label: '用途不是标签 OCR（weed_recognition 杂草照片）',
      expect: 'OBJECT_UNAVAILABLE',
      reasonIncludes: '用途不是标签 OCR',
      spec: { record: { purpose: 'weed_recognition' } },
    },
    {
      label: '登记册 revision 已推进（1 → 2）',
      expect: 'REVISION_CONFLICT',
      reasonIncludes: '版本',
      spec: { record: { revision: 2 } },
    },
    {
      label: '登记册端口自身抛错',
      expect: 'PROVIDER_UNAVAILABLE',
      reasonIncludes: '登记册读取失败',
      spec: { registryThrow: new Error('synthetic registry failure') },
    },
  ];

  for (const item of cases) {
    const mediaRecords = fakeRegistry(
      item.spec.registryRecords ?? new Map([[MEDIA_ID, imageRecord(item.spec.record ?? {})]]),
      item.spec.registryThrow === undefined ? {} : { throw: item.spec.registryThrow },
    );
    const objectStore = item.spec.objectStoreUnwired === true
      ? createUnwiredObjectStore('测试：真实对象存储未接线')
      : fakeObjectStore({
          objects: { [DERIVED_KEY]: { bytes: PNG, contentType: 'image/png' } },
          ...(item.spec.storeOptions ?? {}),
        });
    const source = createObjectStoreOcrImageSource({ mediaRecords, objectStore });

    const read = await source.read({ jobId: JOB_ID, mediaId: MEDIA_ID, mediaRevision: 1 });
    assert.equal(read, null, `${item.label}：必须返回 null（绝不返回空字节/替身图）`);
    assert.equal(source.lastFailure(), item.expect, `${item.label}：内部失败码`);
    const reason = source.lastFailureReason();
    assert.equal(typeof reason, 'string', `${item.label}：必须留下可读原因`);
    assert.equal(reason.includes(item.reasonIncludes), true, `${item.label}：原因应为「${item.reasonIncludes}」，实际「${reason}」`);
    // 诊断文本不得泄露私有对象键（不落私有引用）。
    assert.equal(reason.includes(DERIVED_KEY), false, `${item.label}：原因不得包含对象键`);
    assert.equal(reason.includes(RAW_KEY), false, `${item.label}：原因不得包含对象键`);

    // 适配器对外一律 fail-closed：零预留、零结算、零发包。
    const fetched = captureFetch(OK_PAYLOAD);
    const gateBag = fakeGate();
    const provider = createLiveOcrProviderFromConfig(CONFIGURED.aiProviders.ocr, {
      authorization: PRODUCT_GATE_AUTHORIZATION,
      imageSource: source,
      liveGate: gateBag.gate,
      fetchImpl: fetched.fn,
    });
    assert.deepEqual(
      await provider.extract({ jobId: JOB_ID, mediaId: MEDIA_ID, mediaRevision: 1 }),
      { kind: 'failed', code: 'PROVIDER_UNAVAILABLE' },
      `${item.label}：对外一律 fail-closed`,
    );
    assert.equal(gateBag.state.reserves, 0, `${item.label}：不得预留预算`);
    assert.equal(gateBag.state.settles, 0, `${item.label}：没预留就没有结算`);
    assert.equal(fetched.state.calls, 0, `${item.label}：不得发包`);
  }
});

test('B·端口未配置（缺登记册 / 缺对象存储 / 全缺）⇒ unwired 形态、恒 null、码为 PROVIDER_UNAVAILABLE', async () => {
  const mediaRecords = fakeRegistry(new Map([[MEDIA_ID, imageRecord()]]));
  const objectStore = fakeObjectStore({ objects: { [DERIVED_KEY]: { bytes: PNG, contentType: 'image/png' } } });
  const cases = [
    ['全缺', {}],
    ['缺登记册', { objectStore }],
    ['缺对象存储', { mediaRecords }],
  ];
  for (const [label, ports] of cases) {
    const source = createObjectStoreOcrImageSource(ports);
    assert.equal(source.kind, 'unwired', label);
    assert.match(source.note, /未接线/, `${label}：note 必须如实说明未接线`);
    assert.equal(await source.read({ jobId: JOB_ID, mediaId: MEDIA_ID, mediaRevision: 1 }), null, label);
    assert.equal(source.lastFailure(), 'PROVIDER_UNAVAILABLE', label);
    assert.equal(source.readAttempts, 1, label);
  }
  const wired = createObjectStoreOcrImageSource({ mediaRecords, objectStore });
  assert.equal(wired.kind, 'wired');
  assert.equal(wired.note.includes('不伪造字节'), true);
});

// ---------------------------------------------------------------- C. 不给端口 ⇒ 行为不变

test('C·等价性：不给 imageSource（undefined / null）⇒ 与接线前逐字段相同（fail-closed 码/原因一致）', async () => {
  // 「接线前」的装配：`createLiveOcrProviderFromConfig` + 写死的未接线来源（逐字复刻被替换的那一句）。
  const legacy = createLiveOcrProviderFromConfig(CONFIGURED.aiProviders.ocr, {
    authorization: PRODUCT_GATE_AUTHORIZATION,
    imageSource: createUnwiredImageSource('真实对象存储未接线：取不到待识别的私有图片字节'),
  });
  const current = createOcrProvider({ executionMode: 'real', aiProviders: CONFIGURED.aiProviders.ocr });
  const explicitNull = createOcrProvider({ executionMode: 'real', aiProviders: CONFIGURED.aiProviders.ocr, imageSource: null });

  for (const [label, provider] of [['undefined', current], ['null', explicitNull]]) {
    // 逐字段：对外可观测的四个字段必须相同（executionMode / modelVersion / available / unavailableReason）。
    assert.equal(provider.executionMode, legacy.executionMode, `${label}：executionMode`);
    assert.equal(provider.modelVersion, legacy.modelVersion, `${label}：modelVersion`);
    assert.equal(provider.available, legacy.available, `${label}：available`);
    assert.equal(provider.unavailableReason, legacy.unavailableReason, `${label}：unavailableReason`);
    // 行为：同一输入下 apply 结局逐字段相同（取不到字节 ⇒ failed PROVIDER_UNAVAILABLE）。
    const input = { jobId: JOB_ID, mediaId: MEDIA_ID, mediaRevision: 1 };
    assert.deepEqual(await provider.extract(input), await legacy.extract(input), `${label}：extract 结局必须逐字段相同`);
    assert.deepEqual(await provider.extract(input), { kind: 'failed', code: 'PROVIDER_UNAVAILABLE' }, `${label}：仍是 fail-closed`);
  }

  // 装配表达式本身逐字未变（`note` 只在端口内部，不入 provider 的任何对外字段 ⇒ 行为等价的最后一道钉子）。
  const providerSource = readRepoText('services/api/src/ocr/provider.ts');
  assert.equal(
    providerSource.includes("imageSource: input.imageSource ?? createUnwiredImageSource('真实对象存储未接线：取不到待识别的私有图片字节'),"),
    true,
    '未给端口时必须仍用写死的未接线来源（含逐字未变的 reason）',
  );
  assert.equal(
    providerSource.includes('authorization: PRODUCT_GATE_AUTHORIZATION,'),
    true,
    'authorization 必须原样保留（产品闸门授权串不得被本片改动）',
  );
});

test('C·给了端口 ⇒ 装配失败仍回落 fail-closed（绝不回退替身），且不吞掉真实适配器分支', async () => {
  // 坏快照（region 不符被适配器构造期拒绝）⇒ `createLiveOcrProviderFromConfig` 抛错 ⇒ 回落 fail-closed。
  const broken = { ...CONFIGURED.aiProviders.ocr, region: 'ap-beijing' };
  const provider = createOcrProvider({
    executionMode: 'real',
    aiProviders: broken,
    imageSource: createUnwiredImageSource('synthetic'),
  });
  assert.equal(provider.executionMode, 'real');
  assert.equal(provider.modelVersion, 'real-unconfigured', '装配失败必须回落到接线前的 fail-closed 真实提供者');
  assert.deepEqual(await provider.extract({ jobId: JOB_ID, mediaId: MEDIA_ID, mediaRevision: 1 }), {
    kind: 'failed',
    code: 'PROVIDER_UNAVAILABLE',
  });
  // 正控制：同一快照修好 region ⇒ 真的装上真实适配器（说明上面的回落不是"恒回落"）。
  const fixed = createOcrProvider({
    executionMode: 'real',
    aiProviders: CONFIGURED.aiProviders.ocr,
    imageSource: createUnwiredImageSource('synthetic'),
  });
  assert.equal(fixed.modelVersion.startsWith('tencent-generalaccurateocr-'), true);
});

// ---------------------------------------------------------------- D. 零外呼

test('D·零外呼：没给端口 / 给了端口但取不到字节 ⇒ globalThis.fetch 绊线一次都不触发', async () => {
  const tripwire = tripwireFetch();
  try {
    // ① 完全不给端口（接线前的同一结局）。
    const bare = createOcrProvider({ executionMode: 'real', aiProviders: CONFIGURED.aiProviders.ocr });
    assert.deepEqual(await bare.extract({ jobId: JOB_ID, mediaId: MEDIA_ID, mediaRevision: 1 }), {
      kind: 'failed',
      code: 'PROVIDER_UNAVAILABLE',
    });
    // ② 给了端口但端口未配置（缺对象存储）⇒ 同样 fail-closed，绝不改用别的来源补字节。
    const partial = createOcrProvider({
      executionMode: 'real',
      aiProviders: CONFIGURED.aiProviders.ocr,
      imageSource: createObjectStoreOcrImageSource({ mediaRecords: fakeRegistry(new Map()) }),
    });
    assert.deepEqual(await partial.extract({ jobId: JOB_ID, mediaId: MEDIA_ID, mediaRevision: 1 }), {
      kind: 'failed',
      code: 'PROVIDER_UNAVAILABLE',
    });
    // ③ 端口齐备但登记册里没有这一行 ⇒ 同样 fail-closed。
    const miss = createOcrProvider({
      executionMode: 'real',
      aiProviders: CONFIGURED.aiProviders.ocr,
      imageSource: createObjectStoreOcrImageSource({
        mediaRecords: fakeRegistry(new Map()),
        objectStore: fakeObjectStore({ objects: { [DERIVED_KEY]: { bytes: PNG, contentType: 'image/png' } } }),
      }),
    });
    assert.deepEqual(await miss.extract({ jobId: JOB_ID, mediaId: MEDIA_ID, mediaRevision: 1 }), {
      kind: 'failed',
      code: 'PROVIDER_UNAVAILABLE',
    });
    assert.equal(tripwire.state.calls, 0, '取不到字节时绝不允许发出任何请求');
  } finally {
    tripwire.restore();
  }
});

// ---------------------------------------------------------------- E. 装配点（路由层行为 + app.ts 结构）

test('E·装配点行为：`registerOcrRoutes({ imageMedia })` 真的把媒体域端口交给 provider —— 字节进请求体、任务落 succeeded', async () => {
  const mediaRecords = fakeRegistry(new Map([[MEDIA_ID, imageRecord()]]));
  const objectStore = fakeObjectStore({ objects: { [DERIVED_KEY]: { bytes: PNG, contentType: 'image/png' } } });
  const fetched = captureFetch(OK_PAYLOAD);
  // ⚠ 顺序是硬要求：真实适配器在**构造期**捕获 `globalThis.fetch`（`ocr-live-adapter.ts` 的
  //   `const fetchImpl = ports.fetchImpl ?? globalThis.fetch`），而 provider 是在 `registerOcrRoutes`
  //   里构造的 ⇒ 捕获型 fetch 必须**先**装好，否则这一行会拿真 fetch 去打真端点。
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetched.fn;
  try {
    const app = Fastify();
    const service = registerOcrRoutes(app, CONFIGURED, {
      guards: { requireUser: async () => {} },
      // 媒体引用端口与登记库端口在本用例里**显式**换成替身（只为本用例构造隔离场景）：
      // 本用例的被测点是 `imageMedia` 槽位。
      media: createSubstituteMediaPort(),
      reference: createOcrReferencePort('stub'),
      dose: createOcrDosePort('stub'),
      imageMedia: { mediaRecords, objectStore },
    });
    const { job } = await service.createOcr({
      userId: OWNER,
      body: { media_id: MEDIA_ID, media_revision: 1 },
      idempotencyKey: 'synthetic-r69-ocr-image-source-0001',
    });
    await service.settle();
    const settled = await service.getJob({ userId: OWNER, jobId: job.id });
    assert.equal(settled.state, 'succeeded', `装配点把端口交下去 ⇒ 任务可以成功（实际 ${settled.state}/${String(settled.error_code)}）`);
    assert.equal(settled.error_code, null);
    assert.equal(fetched.state.calls, 1, '恰好发送一次');
    const body = JSON.parse(fetched.state.bodies[0]);
    assert.equal(Buffer.compare(Buffer.from(body.ImageBase64, 'base64'), Buffer.from(PNG)), 0);
    assert.deepEqual(objectStore.calls, [DERIVED_KEY]);
    assert.equal(service.describe().providerCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('E·装配点结构：app.ts 按 `speechAudioMedia` 同形转发**既有**媒体端口，键集只增 `imageMedia`', () => {
  const appSource = readRepoText('services/api/src/app.ts');
  // ① 转发的是**既有**变量（不新建对象存储、不读 env、不铸造批准能力）。
  assert.match(
    appSource,
    /const ocrImageMedia = \/\*[\s\S]*?\*\/ \{ objectStore: mediaObjectStore, mediaRecords: mediaStore \};/,
    'app.ts 必须把既有的 mediaObjectStore + mediaStore 按 speechAudioMedia 同形转发（`{ objectStore, mediaRecords }`）',
  );
  assert.equal(
    appSource.includes('const speechAudioMedia = { objectStore: mediaObjectStore, mediaRecords: mediaStore };'),
    true,
    '语音侧的既有转发行必须原样保留（本片与它同形，不改它）',
  );
  // ② 装配行把端口交下去。
  const registrationLine = appSource.split(/\r?\n/).find((line) => line.includes('registerOcrRoutes(app, config,'));
  assert.notEqual(registrationLine, undefined, 'app.ts 必须有 OCR 域装配行');
  assert.match(registrationLine, /\bimageMedia: ocrImageMedia\b/, `装配行必须把 imageMedia 交给 OCR 域：${registrationLine.trim()}`);
  const keys = [...registrationLine.matchAll(/([A-Za-z]+):/g)].map((match) => match[1]).sort();
  assert.deepEqual(
    keys,
    ['consent', 'egress', 'guards', 'history', 'imageMedia', 'media'],
    `装配行只允许这六个键（不得塞入 store/provider/reference 等实现层端口）：${registrationLine.trim()}`,
  );
  // ③ import 禁项逐字保留（装配层不接触 OCR 适配器模块）——本片新增的转发**不得**靠 import 适配器实现。
  for (const forbidden of ['ocr/provider', 'ocr/store', 'ocr/media', 'ocr/reference']) {
    assert.equal(appSource.includes(forbidden), false, `app.ts 不得引用 ${forbidden}`);
  }
  // ④ 路由层把槽位交给 provider（缺省 undefined ⇒ `createOcrProvider` 走写死的未接线来源）。
  const routesSource = readRepoText('services/api/src/routes/ocr.ts');
  assert.equal(
    routesSource.includes('...(deps.imageMedia === undefined ? {} : { imageSource: createObjectStoreOcrImageSource(deps.imageMedia) })'),
    true,
    'routes/ocr.ts 必须把 imageMedia 槽位交给 createOcrProvider，且缺省时不传（行为不变）',
  );
});

// ---------------------------------------------------------------- F. 结构性自证

test('F·结构性自证：不读 ambient env / 不碰文件系统；失败码全在契约闭集；用途与类型与既有口径对齐', () => {
  const source = readRepoText('services/api/src/ai/ocr-image-source.ts');
  // 去掉注释后再断言：注释里**必须**能写出这条纪律，代码里**一次都不许出现**。
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(code.includes('process.env'), false, '不得读 ambient env');
  assert.equal(code.includes('node:fs'), false, '不得碰文件系统（无磁盘默认路径回退）');
  assert.equal(code.includes('process.cwd'), false, '不得按工作目录推断路径');
  assert.equal(/\breadFileSync\b|\breadFile\b/.test(code), false, '不得读文件');
  assert.equal(code.includes('fetch('), false, '字节来源本身不得发包（只有适配器发）');

  // 失败码闭集：全部是既有契约错误码（**不新造**）。
  assert.deepEqual([...OCR_IMAGE_FAILURE_CODES].sort(), [
    'NOT_FOUND',
    'OBJECT_UNAVAILABLE',
    'PROVIDER_UNAVAILABLE',
    'REVISION_CONFLICT',
  ]);
  for (const failureCode of OCR_IMAGE_FAILURE_CODES) {
    assert.equal(ERROR_CODES.includes(failureCode), true, `${failureCode} 必须是契约既有错误码`);
  }

  // 用途只许标签 OCR：与 packages/media 的口径逐条对齐（防两处漂移）。
  for (const purpose of OCR_IMAGE_PURPOSES) {
    assert.equal(MEDIA_PURPOSES.includes(purpose), true, `${purpose} 必须是 packages/media 的既有用途`);
    assert.equal(MEDIA_PURPOSE_KIND[purpose], 'image', `${purpose} 必须是图片类用途`);
  }

  // Content-Type 收窄关系：⊂ label_ocr 合法上传类型，且**恰好**是适配器真正能解析的两种。
  const labelOcrMimes = MEDIA_PURPOSE_MIME.label_ocr;
  for (const mime of OCR_IMAGE_CONTENT_TYPES) {
    assert.equal(labelOcrMimes.includes(mime), true, `${mime} 必须在 label_ocr 的合法上传类型内`);
  }
  assert.equal(labelOcrMimes.includes('image/webp'), true, 'packages/media 允许 webp 上传（前提事实）');
  assert.equal(OCR_IMAGE_CONTENT_TYPES.includes('image/webp'), false, '本适配器不吃 webp ⇒ 必须明确拒绝');
  // 判据同源：适配器自己的头部校验只认 PNG / JPEG（本常量的来源）。
  assert.doesNotThrow(() => requireLiveOcrImage(PNG, 2 * 1024 * 1024), 'PNG 头必须被适配器接受（正控制）');
  assert.throws(() => requireLiveOcrImage(new Uint8Array([1, 2, 3, 4]), 2 * 1024 * 1024), '非法头部必须被适配器拒绝');
});
