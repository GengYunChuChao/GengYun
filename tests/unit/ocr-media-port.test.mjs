/**
 * GY-R70 · `POST /ocr` **受理前媒体门**（`OcrMediaPort`）的真实端口接线回归 —— 全离线。
 *
 * 背景（本片要关的卡点）：`services/api/src/ocr/media.ts` 在本片之前是
 * `executionMode === 'real' ? createUnwiredMediaPort() : createSubstituteMediaPort()`，
 * 即 `real` 恒**未接线** ⇒ 即使 OCR 凭据齐备、图片字节也已接线（GY-R69 #766），
 * `POST /ocr` 仍必然在 `media.resolve` 被拒（409 `OBJECT_UNAVAILABLE`），受理永远做不到 202。
 * 本片补的就是那一格：`createObjectStoreOcrMediaPort()`（媒体域**既有**的 `mediaStore` +
 * `mediaObjectStore` 两个端口，不新建存储、不读新 env、不改 `config.ts`）。
 *
 * 六条必须一直成立的事（删/改任一条即红，见交付回报的负控制表）：
 *  A. **坏输入逐条可判定**（> 15 种）：记录不存在 / 越权 / 版本不符 / 未就绪 / 用途不符 / 无衍生件键 /
 *     对象取不到 / 空字节 / Content-Type 不受支持 / 端口抛错 …… 每种都落到**既有三码闭集**
 *     （`NOT_FOUND` / `REVISION_CONFLICT` / `OBJECT_UNAVAILABLE`），⛔ 不新造错误码、⛔ 不回退替身。
 *  B. **正控制**：给了端口 + 合法媒体 + 有凭据配置 ⇒ `resolve()` 返回 ok，`POST /ocr` 真的 202。
 *     ⚠ 这只证明**受理门不再恒拒**，**不**证明 OCR 能力可用（没有真实凭据时是否真发包、识别质量
 *     如何，都不在本片；本文件一次真实外呼都没有，见 D）。
 *  C. **「不给端口 ⇒ 行为不变」**：同一个 `POST /ocr` 探针在「改前装配」（显式装
 *     `createUnwiredMediaPort()`）与「改后装配」（`deps.mediaWiring` 缺省）上读数**逐字段相同**：
 *     `409 / OBJECT_UNAVAILABLE / mediaPort="unwired"`、`mediaNote` 逐字相同、`providerCalls=0`。
 *  D. **零外呼**：全过程 `globalThis.fetch` 换成**绊线**（手法与
 *     `tests/unit/ai-live-provider-wiring.test.mjs` / `ocr-image-source.test.mjs` 头注一致：
 *     绊线被触发即抛错，任何一次真实外呼都会让用例红）。本文件不读凭据、不联网、不写台账。
 *  E. **失败序**：`real` 下 `provider.available` 的判定**先于**本端口 ⇒ 无凭据仍是 503；
 *     凭据齐备才轮到媒体门 ⇒ 409/404；全成立 ⇒ 202。顺序颠倒即红。
 *  F. **装配点只转发既有端口**：`app.ts` 把已经建好的 `mediaObjectStore` + `mediaStore` 按
 *     `ocrImageMedia` 同形转发成 `mediaWiring`；`routes/ocr.ts` 缺省（`undefined`）时不传。
 *
 * ⚠ 本文件的媒体字节是**合成 PNG 头**（24 字节，不含任何真实照片/EXIF）；登记册行是合成夹具。
 *   本片证明的是「受理前的媒体门不再恒拒、且失败可判定」，**不是**「OCR 能力可用」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import Fastify from 'fastify';

import { MEDIA_PURPOSES } from '../../packages/media/constants.mjs';
import { OCR_IMAGE_CONTENT_TYPES, OCR_IMAGE_PURPOSES } from '../../services/api/src/ai/ocr-image-source.ts';
import { buildApp } from '../../services/api/src/app.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { ERROR_CODES } from '../../services/api/src/contract.ts';
import { ApiError } from '../../services/api/src/errors.ts';
import { createMemoryMediaStore } from '../../services/api/src/media/store.ts';
import { createUnwiredObjectStore } from '../../services/api/src/media/object-store.ts';
import {
  OCR_MEDIA_REAL_REFUSALS,
  createObjectStoreOcrMediaPort,
  createOcrMediaPort,
  createSubstituteMediaPort,
  createUnwiredMediaPort,
  ocrMediaRealRefusal,
} from '../../services/api/src/ocr/media.ts';
import { createOcrDosePort, createOcrReferencePort } from '../../services/api/src/ocr/reference.ts';
import { createMemoryOcrStore } from '../../services/api/src/ocr/store.ts';
import { registerOcrRoutes } from '../../services/api/src/routes/ocr.ts';

// ---------------------------------------------------------------- 夹具

const REPO = new URL('../../', import.meta.url);
const readRepoText = (relative) => readFileSync(new URL(relative, REPO), 'utf8');

const OWNER = 'user-owner-r70-ocr-media';
const OTHER_OWNER = 'user-other-r70-ocr-media';
const MEDIA_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const DERIVED_KEY = 'media-derived/synthetic-r70-stripped-0001';
const RAW_KEY = 'media-raw/synthetic-r70-original-with-exif-0001';
const KEY_HEADER = 'synthetic-r70-ocr-media-0001';

/** 最小合法 PNG 头（8 字节签名 + IHDR 长度 + 'IHDR' + 宽 + 高），24 字节。 */
const PNG = (() => {
  const buffer = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(2, 16);
  buffer.writeUInt32BE(2, 20);
  return new Uint8Array(buffer);
})();

/** 媒体登记册行（默认＝「调用者名下、已就绪的标签 OCR 图片，衍生件在」）。 */
function mediaRecord(overrides = {}) {
  return {
    ownerId: OWNER,
    revision: 1,
    state: 'ready',
    purpose: 'label_ocr',
    rawRef: RAW_KEY,
    derivativeRef: DERIVED_KEY,
    ...overrides,
  };
}

/** 假登记册：只实现本端口用到的 `getMedia`，并记录每次读取的 mediaId（证明「读了几次」）。 */
function fakeRegistry(records = new Map(), options = {}) {
  const calls = [];
  return {
    calls,
    async getMedia(mediaId) {
      calls.push(mediaId);
      if (options.throw !== undefined) throw options.throw;
      return records.get(mediaId) ?? null;
    },
  };
}

/** 假对象存储：`kind` 默认是**真实适配器身份**（`s3_compatible`），记录每次 `getObject(key)` 的键。 */
function fakeObjectStore(options = {}) {
  const calls = [];
  return {
    kind: options.kind ?? 's3_compatible',
    calls,
    async getObject(key) {
      calls.push(key);
      if (options.throw !== undefined) throw options.throw;
      return options.objects?.[key] ?? null;
    },
  };
}

/** 「端口齐备且全部合格」的基线：正控制与各类单点破坏都以它为起点。 */
function wiredBag(recordOverrides = {}, storeOptions = {}) {
  const mediaRecords = fakeRegistry(new Map([[MEDIA_ID, mediaRecord(recordOverrides)]]));
  const objectStore = fakeObjectStore({
    objects: { [DERIVED_KEY]: { bytes: PNG, contentType: 'image/png' } },
    ...storeOptions,
  });
  return { port: createObjectStoreOcrMediaPort({ mediaRecords, objectStore }), mediaRecords, objectStore };
}

const ASK = { ownerUserId: OWNER, mediaId: MEDIA_ID, mediaRevision: 1 };

/** 绊线 fetch：任何一次调用都算失败（证明「零外呼」）。 */
function tripwireFetch() {
  const state = { calls: 0 };
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    state.calls += 1;
    throw new Error(`绊线被触发：本测试不得发出任何真实请求（${String(url)}）`);
  };
  return { state, restore: () => { globalThis.fetch = original; } };
}

/**
 * 接缝替身提供者（**明确标注的替身**，不触达任何真实供应商）。
 *
 * `available: true` 是本片的关键：没有它，`provider.available` 的 503 会挡住媒体门，
 * 媒体门的红绿就无从观测（这正是失败序「503 在前」的成因，见 E 组）。
 */
function seamProvider(options = {}) {
  return {
    executionMode: 'real',
    modelVersion: 'stub-seam-r70-v1',
    available: options.available ?? true,
    unavailableReason: options.available === false ? '合成：真实 OCR 供应商凭据缺席（fail-closed）' : null,
    async extract() {
      return {
        kind: 'completed',
        fields: {
          registration_number: 'PD20210001',
          name: '合成示例草甘膦水剂',
          ingredients: [{ name: '草甘膦', content_text: '41', unit_text: '%' }],
          dosage_form: '水剂',
        },
      };
    },
  };
}

/** `real` 执行模式的**最小**合成配置（只填本域用到的键；不读任何环境变量）。 */
const REAL_CONFIG = { executionMode: 'real', sessionSigningKey: 'synthetic-not-a-real-signing-key-r70', apiPrefix: '/api/v1' };

/**
 * `loadConfig` 的 real 模式必填项（**全部合成占位**，不连任何真实资源、不打印任何真实凭据）。
 *
 * ⚠ 刻意**不含** `TENCENTCLOUD_*`：本片要证明「媒体门接上了」，同时**不能**让 202 之后的执行期
 * 真的去发供应商请求（本片禁止任何真实外呼）。无凭据 ⇒ 受理停在 503，执行期根本不会启动。
 */
const REAL_ENV = {
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

/**
 * `POST /ocr` 探针：用**产品同一个** `registerOcrRoutes` 注册，只替换身份与错误出口。
 * 身份由 `onRequest` 钩子写入（`readIdentity` 只认服务端解析出的身份）。
 */
function buildProbeApp(deps, options = {}) {
  const app = Fastify({ logger: false, genReqId: () => randomUUID() });
  for (const key of ['userId', 'authEpoch', 'role', 'sessionId', 'sessionExpiresAt', 'accountRevision', 'authScopes']) {
    app.decorateRequest(key, null);
  }
  app.addHook('onRequest', async (request) => {
    request.userId = options.userId ?? OWNER;
    request.authEpoch = 1;
    request.role = 'user';
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      reply.status(error.status).send({ error: { code: error.code, message: error.message, retryable: error.retryable } });
      return;
    }
    reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: '内部错误', retryable: false } });
  });
  const service = registerOcrRoutes(app, REAL_CONFIG, { guards: { requireUser: async () => {} }, ...deps });
  return { app, service };
}

/** 同一 POST /ocr 探针的**逐字段读数**（等价性用例比对的就是这份对象）。 */
async function probeReading(deps) {
  const { app, service } = buildProbeApp(deps);
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/ocr',
      headers: { 'content-type': 'application/json', 'idempotency-key': KEY_HEADER },
      payload: JSON.stringify({ media_id: MEDIA_ID, media_revision: 1 }),
    });
    await service.settle();
    const described = service.describe();
    const json = response.json();
    return {
      status: response.statusCode,
      errorCode: json?.error?.code ?? null,
      errorMessage: json?.error?.message ?? null,
      retryable: json?.error?.retryable ?? null,
      jobState: json?.data?.state ?? null,
      mediaPort: described.mediaPort,
      mediaNote: described.mediaNote,
      providerCalls: described.providerCalls,
    };
  } finally {
    await app.close();
  }
}

// ---------------------------------------------------------------- A. 坏输入逐条可判定

test('A·失败语义表：> 15 种坏输入各自落到既有三码闭集（不新造码、不回退替身）', async () => {
  const thrownNotFound = Object.assign(new Error('synthetic registry NOT_FOUND'), { code: 'NOT_FOUND' });
  const thrownProvider = Object.assign(new Error('synthetic object store unwired'), { code: 'PROVIDER_UNAVAILABLE' });
  const cases = [
    // ---- 形状（端口自身再判一次，不信任上游）----
    { label: 'revision 为 0', expect: 'REVISION_CONFLICT', ask: { mediaRevision: 0 } },
    { label: 'revision 为小数', expect: 'REVISION_CONFLICT', ask: { mediaRevision: 1.5 } },
    { label: 'revision 为负', expect: 'REVISION_CONFLICT', ask: { mediaRevision: -3 } },
    // ---- 登记册 ----
    { label: '记录不存在', expect: 'NOT_FOUND', spec: { records: new Map() } },
    { label: '归属者不符（越权与不存在同形）', expect: 'NOT_FOUND', ask: { ownerUserId: OTHER_OWNER } },
    { label: '版本不符（登记 2，请求 1）', expect: 'REVISION_CONFLICT', spec: { record: { revision: 2 } } },
    { label: '登记册抛 NOT_FOUND', expect: 'NOT_FOUND', spec: { registryThrow: thrownNotFound } },
    { label: '登记册抛无码错误', expect: 'OBJECT_UNAVAILABLE', spec: { registryThrow: new Error('synthetic registry failure') } },
    // ---- 状态 ----
    { label: '未就绪 initiated', expect: 'OBJECT_UNAVAILABLE', spec: { record: { state: 'initiated' } } },
    { label: '未就绪 processing', expect: 'OBJECT_UNAVAILABLE', spec: { record: { state: 'processing' } } },
    { label: '已驳回 rejected', expect: 'OBJECT_UNAVAILABLE', spec: { record: { state: 'rejected' } } },
    { label: '已删除 deleted', expect: 'OBJECT_UNAVAILABLE', spec: { record: { state: 'deleted' } } },
    // ---- 用途 ----
    { label: '用途是杂草识别', expect: 'OBJECT_UNAVAILABLE', spec: { record: { purpose: 'weed_recognition' } } },
    { label: '用途是社区图', expect: 'OBJECT_UNAVAILABLE', spec: { record: { purpose: 'community_image' } } },
    { label: '用途是录音', expect: 'OBJECT_UNAVAILABLE', spec: { record: { purpose: 'voice_question' } } },
    // ---- 对象键 ----
    { label: '无衍生件键（只有含元数据原件）', expect: 'OBJECT_UNAVAILABLE', spec: { record: { derivativeRef: null } } },
    { label: '衍生件键是空串', expect: 'OBJECT_UNAVAILABLE', spec: { record: { derivativeRef: '' } } },
    // ---- 对象本身 ----
    { label: '对象不存在', expect: 'OBJECT_UNAVAILABLE', spec: { storeOptions: { objects: {} } } },
    { label: '对象字节为空', expect: 'OBJECT_UNAVAILABLE', spec: { storeOptions: { objects: { [DERIVED_KEY]: { bytes: new Uint8Array(0), contentType: 'image/png' } } } } },
    { label: '对象读不到（端口抛无码错误）', expect: 'OBJECT_UNAVAILABLE', spec: { storeOptions: { throw: new Error('synthetic object store failure') } } },
    { label: '对象存储是未接线端口（抛 PROVIDER_UNAVAILABLE）', expect: 'OBJECT_UNAVAILABLE', spec: { storeOptions: { throw: thrownProvider } } },
    { label: '对象存储抛 NOT_FOUND（闭集码原样保留）', expect: 'NOT_FOUND', spec: { storeOptions: { throw: thrownNotFound } } },
    // ---- Content-Type ----
    { label: 'Content-Type 是 webp（合法上传但适配器不吃）', expect: 'OBJECT_UNAVAILABLE', spec: { storeOptions: { objects: { [DERIVED_KEY]: { bytes: PNG, contentType: 'image/webp' } } } } },
    { label: 'Content-Type 是 octet-stream', expect: 'OBJECT_UNAVAILABLE', spec: { storeOptions: { objects: { [DERIVED_KEY]: { bytes: PNG, contentType: 'application/octet-stream' } } } } },
    { label: 'Content-Type 缺失（空串）', expect: 'OBJECT_UNAVAILABLE', spec: { storeOptions: { objects: { [DERIVED_KEY]: { bytes: PNG, contentType: '' } } } } },
    { label: 'Content-Type 是 text/plain', expect: 'OBJECT_UNAVAILABLE', spec: { storeOptions: { objects: { [DERIVED_KEY]: { bytes: PNG, contentType: 'text/plain' } } } } },
  ];
  assert.ok(cases.length >= 16, `失败语义表必须覆盖 15 种以上坏输入（实际 ${cases.length}）`);

  for (const item of cases) {
    const records = item.spec?.records ?? new Map([[MEDIA_ID, mediaRecord(item.spec?.record ?? {})]]);
    const mediaRecords = fakeRegistry(records, item.spec?.registryThrow === undefined ? {} : { throw: item.spec.registryThrow });
    const objectStore = fakeObjectStore({
      objects: { [DERIVED_KEY]: { bytes: PNG, contentType: 'image/png' } },
      ...(item.spec?.storeOptions ?? {}),
    });
    const port = createObjectStoreOcrMediaPort({ mediaRecords, objectStore });

    const resolution = await port.resolve({ ...ASK, ...(item.ask ?? {}) });
    assert.equal(resolution.ok, false, `${item.label}：必须拒绝（绝不静默放过）`);
    assert.equal(resolution.code, item.expect, `${item.label}：错误码应为 ${item.expect}，实际 ${resolution.code}`);
    assert.equal(ERROR_CODES.includes(resolution.code), true, `${item.label}：${resolution.code} 必须是契约既有错误码`);
    // 不得泄露私有对象键（拒绝码是闭集，不含任何引用）。
    assert.equal(Object.keys(resolution).sort().join(','), 'code,ok', `${item.label}：拒绝结果不得携带额外字段`);
    assert.equal(port.kind, 'real', `${item.label}：端口身份仍是 real（不是替身、不是未接线）`);
  }
});

test('A·正控制：合法媒体 ⇒ resolve() 返回 ok；只读去元数据衍生件，原件一次都不读', async () => {
  const bag = wiredBag();
  const resolution = await bag.port.resolve(ASK);
  assert.deepEqual(resolution, { ok: true, revision: 1 }, '合法媒体必须放行，且回传**登记册的** revision');
  assert.equal(bag.port.kind, 'real');
  assert.match(bag.port.note, /真实媒体引用端口/);
  // 隐私红线：只读衍生件；原件（含 EXIF/GPS）不出网。
  assert.deepEqual(bag.objectStore.calls, [DERIVED_KEY], '只允许读去元数据衍生件');
  assert.equal(bag.objectStore.calls.includes(RAW_KEY), false, '原件键不得出现在任何一次 getObject 里');
  assert.deepEqual(bag.mediaRecords.calls, [MEDIA_ID], '登记册只按 media_id 读一次');
  // `image/png; charset=binary` 这类带参数的写法必须被归一后接受（否则真实桶的元数据会把合法图拒掉）。
  const flat = wiredBag({}, { objects: { [DERIVED_KEY]: { bytes: PNG, contentType: 'IMAGE/PNG; charset=binary' } } });
  assert.deepEqual(await flat.port.resolve(ASK), { ok: true, revision: 1 }, 'Content-Type 必须小写化并按参数切分后再判');
});

// ---------------------------------------------------------------- C. 不给端口 ⇒ 行为不变

test('C·等价性：不给端口 ⇒ 同一个 POST /ocr 探针读数逐字段相同（409 / OBJECT_UNAVAILABLE / mediaPort=unwired）', async () => {
  // 「改前装配」：显式装 `createUnwiredMediaPort()` —— 就是被本片替换掉的那一句的产物。
  const before = await probeReading({
    provider: seamProvider(),
    media: createUnwiredMediaPort(),
    reference: createOcrReferencePort('real'),
    dose: createOcrDosePort('real'),
    store: createMemoryOcrStore(),
  });
  // 「改后装配」：不传 `media`、也不传本片新增的 `mediaWiring`（= 装配层不给端口）。
  const after = await probeReading({
    provider: seamProvider(),
    reference: createOcrReferencePort('real'),
    dose: createOcrDosePort('real'),
    store: createMemoryOcrStore(),
  });

  // ① 逐字段相同（不是「都失败了」就算数：message/retryable/note/providerCalls 也逐字比）。
  assert.deepEqual(after, before, '不给端口时读数必须与改前逐字段相同');

  // ② 任务书要求的三个具体读数，单独钉住（避免"整体相等"掩盖方向错）。
  for (const [label, reading] of [['改前', before], ['改后', after]]) {
    assert.equal(reading.status, 409, `${label}：状态码必须是 409`);
    assert.equal(reading.errorCode, 'OBJECT_UNAVAILABLE', `${label}：错误码必须是 OBJECT_UNAVAILABLE`);
    assert.equal(reading.mediaPort, 'unwired', `${label}：媒体端口必须是 unwired`);
    assert.equal(reading.providerCalls, 0, `${label}：受理前拒绝 ⇒ 不得调用提供者`);
    assert.equal(reading.jobState, null, `${label}：不得建任务`);
  }

  // ③ 运行期文案逐字未变（`runtime-strings-truth` 也钉这条；此处再钉一次在**探针面**上）。
  assert.equal(
    after.mediaNote,
    '媒体 HTTP 路由已注册，但未接真实对象存储：无法读取私有媒体字节（fail-closed）',
    '未接线端口的 note 必须逐字不变（含默认 reason 与（fail-closed）后缀）',
  );

  // ④ 装配层把 `mediaWiring` 转发了、但对象存储仍是**未接线**端口（= 默认 real 产品装配）⇒ 仍是 unwired。
  //    这条覆盖「app.ts 无条件转发」的那一格：转发 ≠ 放行，判据在 `ocrMediaRealRefusal`。
  const productShape = createOcrMediaPort('real', { objectStore: createUnwiredObjectStore(), mediaRecords: fakeRegistry() });
  assert.equal(productShape.kind, 'unwired', '对象存储是未接线端口 ⇒ 媒体门必须仍是 unwired');
  assert.equal(productShape.note, after.mediaNote, '产品装配形态的 note 也必须逐字相同');
  assert.deepEqual(await productShape.resolve(ASK), { ok: false, code: 'OBJECT_UNAVAILABLE' });
});

test('C·缺省判定：wiring 缺省 / 缺对象存储 / 对象存储非真实 / 缺登记册 各自的闭集原因', () => {
  const registry = fakeRegistry(new Map());
  const realStore = fakeObjectStore();
  const cases = [
    ['wiring 缺省（装配层没转发）', undefined, 'object_store_not_wired'],
    ['对象存储缺省', { mediaRecords: registry }, 'object_store_not_wired'],
    ['对象存储是替身端口', { objectStore: fakeObjectStore({ kind: 'substitute' }), mediaRecords: registry }, 'object_store_not_wired'],
    ['对象存储是未接线端口', { objectStore: fakeObjectStore({ kind: 'unwired' }), mediaRecords: registry }, 'object_store_not_wired'],
    ['缺登记册', { objectStore: realStore }, 'media_registry_not_configured'],
    ['全齐', { objectStore: realStore, mediaRecords: registry }, null],
  ];
  for (const [label, wiring, expect] of cases) {
    assert.equal(ocrMediaRealRefusal(wiring), expect, `${label}：拒绝原因`);
  }
  // 闭集自证：只有这两条原因，且都能生成可读 note。
  assert.deepEqual([...OCR_MEDIA_REAL_REFUSALS].sort(), ['media_registry_not_configured', 'object_store_not_wired']);
  // 两条原因都只落 unwired，绝不落替身（substitute 是 stub/preset_demo 的专属）。
  for (const wiring of [undefined, { objectStore: realStore }, { mediaRecords: registry }]) {
    assert.equal(createOcrMediaPort('real', wiring).kind, 'unwired', '缺任一门 ⇒ unwired，不得替身');
  }
  // 非 real 模式不受影响：仍是明确标注的替身（与接线前逐字一致）。
  for (const mode of ['stub', 'preset_demo']) {
    const port = createOcrMediaPort(mode, { objectStore: realStore, mediaRecords: registry });
    assert.equal(port.kind, 'substitute', `${mode}：注入真实端口也不得改变替身语义`);
    assert.equal(port.note, createSubstituteMediaPort().note, `${mode}：替身文案逐字不变`);
  }
});

// ---------------------------------------------------------------- B + E. 正控制与失败序

test('B·正控制：给了端口 + 合法媒体 + 有凭据配置 ⇒ 端口 ok 且 POST /ocr 真的 202（受理得以继续）', async () => {
  const tripwire = tripwireFetch();
  try {
    const mediaRecords = fakeRegistry(new Map([[MEDIA_ID, mediaRecord()]]));
    const objectStore = fakeObjectStore({ objects: { [DERIVED_KEY]: { bytes: PNG, contentType: 'image/png' } } });
    const { app, service } = buildProbeApp({
      provider: seamProvider(),
      reference: createOcrReferencePort('real'),
      dose: createOcrDosePort('real'),
      store: createMemoryOcrStore(),
      mediaWiring: { objectStore, mediaRecords },
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/ocr',
        headers: { 'content-type': 'application/json', 'idempotency-key': KEY_HEADER },
        payload: JSON.stringify({ media_id: MEDIA_ID, media_revision: 1 }),
      });
      assert.equal(response.statusCode, 202, `给了端口 + 合法媒体 ⇒ 必须受理（实际 ${response.statusCode} ${response.body}）`);
      const json = response.json();
      assert.equal(json.data.kind, 'ocr');
      assert.equal(json.data.state, 'queued', '受理即 queued（执行期状态与识别质量不在本片证明范围）');
      assert.equal(service.describe().mediaPort, 'real', '装配点必须把这个端口真的交给服务（不是只存在变量里）');
      assert.match(service.describe().mediaNote, /真实媒体引用端口/);
      // 端口**真的**取了那一个衍生件（证明 202 不是「跳过媒体门」得来的）。
      assert.deepEqual(objectStore.calls, [DERIVED_KEY]);
      await service.settle();
    } finally {
      await app.close();
    }
    assert.equal(tripwire.state.calls, 0, '受理与执行全程不得发出任何真实请求');
  } finally {
    tripwire.restore();
  }
});

test('E·失败序：无凭据时 503 在前（媒体门根本不执行）→ 凭据齐备才轮到媒体门 → 全成立才 202', async () => {
  const goodWiring = () => ({
    objectStore: fakeObjectStore({ objects: { [DERIVED_KEY]: { bytes: PNG, contentType: 'image/png' } } }),
    mediaRecords: fakeRegistry(new Map([[MEDIA_ID, mediaRecord()]])),
  });

  // ① 无凭据（不注入 provider ⇒ `createOcrProvider({executionMode:'real', aiProviders:null})` 不可用）
  //    + **完全合法**的媒体端口 ⇒ 仍是 503：证明 `provider.available` 的判定先于 `media.resolve`。
  const uncredentialed = await probeReading({
    reference: createOcrReferencePort('real'),
    dose: createOcrDosePort('real'),
    store: createMemoryOcrStore(),
    mediaWiring: goodWiring(),
  });
  assert.equal(uncredentialed.status, 503, '无凭据必须 503（不得因为媒体门已接线就放行）');
  assert.equal(uncredentialed.errorCode, 'PROVIDER_UNAVAILABLE');
  assert.equal(uncredentialed.retryable, false, '能力未接线 ⇒ retryable=false');
  assert.equal(uncredentialed.providerCalls, 0, '受理前 fail-closed ⇒ 零提供者调用');
  assert.equal(uncredentialed.jobState, null, '不得建任务');

  // ② 凭据齐备 + 媒体未就绪 ⇒ 409 OBJECT_UNAVAILABLE（媒体门成为第一道拒绝者）。
  const notReady = await probeReading({
    provider: seamProvider(),
    reference: createOcrReferencePort('real'),
    dose: createOcrDosePort('real'),
    store: createMemoryOcrStore(),
    mediaWiring: {
      objectStore: fakeObjectStore({ objects: { [DERIVED_KEY]: { bytes: PNG, contentType: 'image/png' } } }),
      mediaRecords: fakeRegistry(new Map([[MEDIA_ID, mediaRecord({ state: 'initiated' })]])),
    },
  });
  assert.equal(notReady.status, 409);
  assert.equal(notReady.errorCode, 'OBJECT_UNAVAILABLE');
  assert.equal(notReady.providerCalls, 0, '媒体门拒绝 ⇒ 零提供者调用');

  // ③ 凭据齐备 + 媒体记录不存在 ⇒ 404 NOT_FOUND（越权同形）。
  const missing = await probeReading({
    provider: seamProvider(),
    reference: createOcrReferencePort('real'),
    dose: createOcrDosePort('real'),
    store: createMemoryOcrStore(),
    mediaWiring: { objectStore: fakeObjectStore(), mediaRecords: fakeRegistry(new Map()) },
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.errorCode, 'NOT_FOUND');

  // ④ 三样齐备 ⇒ 202。
  const accepted = await probeReading({
    provider: seamProvider(),
    reference: createOcrReferencePort('real'),
    dose: createOcrDosePort('real'),
    store: createMemoryOcrStore(),
    mediaWiring: goodWiring(),
  });
  assert.equal(accepted.status, 202);
  assert.equal(accepted.jobState, 'queued');
  assert.equal(accepted.mediaPort, 'real');

  // 顺序的显式对读：三档状态码互不相同，且**只能**按 503 → 409/404 → 202 的顺序出现。
  assert.deepEqual(
    [uncredentialed.status, notReady.status, missing.status, accepted.status],
    [503, 409, 404, 202],
    '失败序必须是 503（凭据门）在前 → 409/404（媒体门）→ 202（受理）',
  );
});

test('B·产品装配（buildApp，真实装配处）：注入真实对象存储 ⇒ mediaPort=real（转发有效）；不注入 ⇒ unwired', async (t) => {
  const tripwire = tripwireFetch();
  try {
    const objectStore = fakeObjectStore({ objects: { [DERIVED_KEY]: { bytes: PNG, contentType: 'image/png' } } });
    const seededStore = createMemoryMediaStore({ now: () => 1_760_000_000_000 });
    await seededStore.createMedia({
      id: MEDIA_ID,
      ownerId: OWNER,
      revision: 1,
      purpose: 'label_ocr',
      mime: 'image/png',
      bytes: PNG.length,
      duration_ms: null,
      sha256: '0'.repeat(64),
      state: 'ready',
      failure_code: null,
      rawRef: RAW_KEY,
      derivativeRef: DERIVED_KEY,
      createdAt: 1_760_000_000_000,
      updatedAt: 1_760_000_000_000,
      expiresAt: 1_760_086_400_000,
    });
    const config = loadConfig({ APP_EXECUTION_MODE: 'real', LOG_LEVEL: 'silent', ...REAL_ENV });

    // ① 不注入对象存储（默认 = 未接线端口）⇒ 媒体门必须仍是 unwired（与接线前逐字相同）。
    const plain = buildApp({ config, store: createMemoryAuthStore() });
    t.after(() => plain.close());
    assert.equal(plain.ocrService.describe().mediaPort, 'unwired', '零注入 + real 必须仍是未接线（app.ts 转发不改变这一格）');

    // ② 注入**真实适配器身份**的对象存储 + 已就绪的登记册 ⇒ `app.ts` 的 `mediaWiring` 转发**真的**到了端口。
    const wired = buildApp({
      config,
      store: createMemoryAuthStore(),
      mediaStore: seededStore,
      mediaObjectStore: objectStore,
    });
    t.after(() => wired.close());
    assert.equal(
      wired.ocrService.describe().mediaPort,
      'real',
      '注入真实对象存储 + 已就绪登记册 ⇒ 受理前媒体门必须真的接上（否则 app.ts 的转发形同虚设）',
    );
    assert.match(wired.ocrService.describe().mediaNote, /真实媒体引用端口/);

    // ③ 同一装配下**媒体门本身**能过（用装配处转发的**同一对**端口构造同一条判据）。
    const sameWiring = createOcrMediaPort('real', { objectStore, mediaRecords: seededStore });
    assert.deepEqual(await sameWiring.resolve(ASK), { ok: true, revision: 1 }, '产品装配转发的正是能放行的那一对端口');

    // ④ 但受理仍停在**前一道**域级闸门：本 config 没有真实 OCR 凭据 ⇒ 503，且零提供者调用、零外呼。
    await assert.rejects(
      () => wired.ocrService.createOcr({ userId: OWNER, body: { media_id: MEDIA_ID, media_revision: 1 }, idempotencyKey: KEY_HEADER }),
      (error) => {
        assert.equal(error.code, 'PROVIDER_UNAVAILABLE', '无凭据必须 503（媒体门接线不得越过凭据门）');
        assert.equal(error.status, 503);
        assert.equal(error.retryable, false);
        return true;
      },
      '产品装配：媒体门已接线但缺凭据 ⇒ 仍是 503',
    );
    assert.equal(wired.ocrService.describe().providerCalls, 0, '受理前拒绝 ⇒ 零提供者调用');
    assert.equal(tripwire.state.calls, 0, '产品装配路径同样不得发出任何真实请求');
  } finally {
    tripwire.restore();
  }
});

// ---------------------------------------------------------------- D. 零外呼绊线
test('D·零外呼：全部拒绝路径 + 正控制全程不触发 globalThis.fetch 绊线', async () => {
  const tripwire = tripwireFetch();
  try {
    // ① 端口层：各种坏输入都不联网（端口只与注入的两个端口对话）。
    const bad = createObjectStoreOcrMediaPort({
      objectStore: fakeObjectStore({ objects: {} }),
      mediaRecords: fakeRegistry(new Map([[MEDIA_ID, mediaRecord()]])),
    });
    assert.equal((await bad.resolve(ASK)).ok, false);
    // ② 未接线端口形态：一次都不联网。
    assert.equal((await createUnwiredMediaPort().resolve(ASK)).ok, false);
    // ③ 产品装配形态（未接线的对象存储）：一次都不联网。
    const productShape = createOcrMediaPort('real', { objectStore: createUnwiredObjectStore(), mediaRecords: fakeRegistry() });
    assert.equal((await productShape.resolve(ASK)).ok, false);
    // ④ HTTP 层：503 与 409 两条拒绝路径都不联网。
    await probeReading({ reference: createOcrReferencePort('real'), dose: createOcrDosePort('real'), store: createMemoryOcrStore() });
    await probeReading({
      provider: seamProvider(),
      reference: createOcrReferencePort('real'),
      dose: createOcrDosePort('real'),
      store: createMemoryOcrStore(),
      mediaWiring: { objectStore: fakeObjectStore(), mediaRecords: fakeRegistry(new Map([[MEDIA_ID, mediaRecord()]])) },
    });
    assert.equal(tripwire.state.calls, 0, '受理前的任何一条路径都不得发出真实请求');
  } finally {
    tripwire.restore();
  }
});

// ---------------------------------------------------------------- F. 装配点与结构性自证

test('F·装配点结构：app.ts 按 `ocrImageMedia` 同形转发同一对既有端口；routes 缺省时不传', () => {
  const appSource = readRepoText('services/api/src/app.ts');
  // ① 转发的是**既有**变量（不新建对象存储、不读新 env、不铸造批准能力）。
  //    GY-R70 的口径：`mediaWiring` 复用**同一个** `ocrImageMedia` 对象（一对端口、两处消费 ⇒ 永远同源），
  //    因此 app.ts 里**没有**第二个 `{ objectStore, mediaRecords }` 字面量。
  assert.match(
    appSource,
    /registerOcrRoutes\(app, config, \{[\s\S]*?imageMedia: ocrImageMedia, mediaWiring: ocrImageMedia \}/,
    'app.ts 必须把既有 `ocrImageMedia`（mediaObjectStore + mediaStore）同时交给 imageMedia 与 mediaWiring',
  );
  assert.equal(
    appSource.split('{ objectStore: mediaObjectStore, mediaRecords: mediaStore }').length - 1,
    3,
    'app.ts 只允许三处 `{ objectStore, mediaRecords }` 字面量（speechAudioMedia + ocrImageMedia + GY-R70 审核域 imageMedia 取值器），三处都只转发既有实例',
  );
  assert.equal(
    appSource.includes('const ocrImageMedia = /* GY-R69'),
    true,
    'GY-R69 的 ocrImageMedia 转发行必须原样保留（本片与它同形，不改它）',
  );
  // ② 装配行把端口交下去，且**不**在这里做任何放行判断（判据只在 ocr/media.ts）。
  const registrationLine = appSource.split(/\r?\n/).find((line) => line.includes('registerOcrRoutes(app, config,'));
  assert.notEqual(registrationLine, undefined, 'app.ts 必须有 OCR 域装配行');
  assert.match(registrationLine, /\bmediaWiring: ocrImageMedia\b/, `装配行必须转发 mediaWiring：${registrationLine.trim()}`);
  const keys = [...registrationLine.matchAll(/([A-Za-z]+):/g)].map((match) => match[1]).sort();
  assert.deepEqual(
    keys,
    ['consent', 'egress', 'guards', 'history', 'imageMedia', 'media', 'mediaWiring'],
    `装配行只允许这七个键（不得塞入 store/provider/reference 等实现层端口）：${registrationLine.trim()}`,
  );
  // ③ 装配层仍不接触 OCR 适配器模块（端口实现只在域内）。
  for (const forbidden of ['ocr/provider', 'ocr/store', 'ocr/media', 'ocr/reference']) {
    assert.equal(appSource.includes(forbidden), false, `app.ts 不得引用 ${forbidden}`);
  }
  // ④ 路由层把槽位原样交给域内工厂（缺省 undefined ⇒ 与接线前逐字节相同）。
  const routesSource = readRepoText('services/api/src/routes/ocr.ts');
  assert.equal(
    routesSource.includes('deps.media ?? createOcrMediaPort(config.executionMode, deps.mediaWiring)'),
    true,
    'routes/ocr.ts 必须把 mediaWiring 交给 createOcrMediaPort（缺省 undefined ⇒ 域内自建 = 接线前行为）',
  );
  // ⑤ `OcrRouteDeps.mediaWiring` 必须**可选**（缺省 undefined 是等价性的前提）。
  assert.match(routesSource, /mediaWiring\?: OcrMediaPortWiring;/, 'mediaWiring 在 OcrRouteDeps 里必须是可选字段');
});

test('F·结构性自证：不读 ambient env / 不碰文件系统 / 不写对象存储 / 错误码全在契约闭集 / 口径同源', () => {
  const source = readRepoText('services/api/src/ocr/media.ts');
  // 去掉注释后再断言：注释里**必须**能写出这些纪律，代码里**一次都不许出现**。
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(code.includes('process.env'), false, '不得读 ambient env');
  assert.equal(code.includes('node:fs'), false, '不得碰文件系统');
  assert.equal(code.includes('process.cwd'), false, '不得按工作目录推断路径');
  assert.equal(/\breadFileSync\b|\breadFile\b/.test(code), false, '不得读文件');
  assert.equal(code.includes('fetch('), false, '媒体门不得自己发包');
  assert.equal(code.includes('putObject'), false, '媒体门只读：不得写对象存储');
  assert.equal(code.includes('deleteObject'), false, '媒体门只读：不得删对象存储');

  // 错误码闭集：本端口只可能回这三个（**不新造**，`MediaResolutionCode` 未扩容）。
  const resolutionCodes = /export type MediaResolutionCode = ([^;]+);/.exec(source)?.[1] ?? '';
  for (const codeName of ['NOT_FOUND', 'REVISION_CONFLICT', 'OBJECT_UNAVAILABLE']) {
    assert.equal(resolutionCodes.includes(`'${codeName}'`), true, `MediaResolutionCode 必须含 ${codeName}`);
    assert.equal(ERROR_CODES.includes(codeName), true, `${codeName} 必须是契约既有错误码`);
  }
  assert.equal(/PROVIDER_UNAVAILABLE/.test(resolutionCodes), false, '不得把 PROVIDER_UNAVAILABLE 塞进受理码闭集');

  // 口径同源：受理门与识别期字节来源吃**同一份**用途/类型常量（不复制、不漂移）。
  assert.equal(source.includes("from '../ai/ocr-image-source.ts'"), true, '必须 import 既有常量而不是复制');
  for (const purpose of OCR_IMAGE_PURPOSES) {
    assert.equal(MEDIA_PURPOSES.includes(purpose), true, `${purpose} 必须是 packages/media 的既有用途`);
  }
  const port = createObjectStoreOcrMediaPort({
    objectStore: fakeObjectStore({ objects: { [DERIVED_KEY]: { bytes: PNG, contentType: 'image/jpeg' } } }),
    mediaRecords: fakeRegistry(new Map([[MEDIA_ID, mediaRecord()]])),
  });
  assert.notEqual(port, null);
  // 行为面同源：`OCR_IMAGE_CONTENT_TYPES` 里的每一种都必须被受理，不在其中的必须被拒。
  return (async () => {
    for (const contentType of OCR_IMAGE_CONTENT_TYPES) {
      const bag = wiredBag({}, { objects: { [DERIVED_KEY]: { bytes: PNG, contentType } } });
      assert.deepEqual(await bag.port.resolve(ASK), { ok: true, revision: 1 }, `${contentType} 必须被受理`);
    }
    for (const contentType of ['image/webp', 'image/gif', 'application/pdf']) {
      assert.equal(OCR_IMAGE_CONTENT_TYPES.includes(contentType), false, `${contentType} 不在可接受类型内（前提）`);
      const bag = wiredBag({}, { objects: { [DERIVED_KEY]: { bytes: PNG, contentType } } });
      assert.deepEqual(await bag.port.resolve(ASK), { ok: false, code: 'OBJECT_UNAVAILABLE' }, `${contentType} 必须被拒`);
    }
  })();
});
