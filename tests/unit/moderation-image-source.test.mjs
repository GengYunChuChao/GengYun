/**
 * GY-R70 · **审核域待审图片字节来源（`ModerationImageSource`）** 接线回归（全离线：不外呼、不读凭据、不写台账）。
 *
 * 背景（本片要关的卡点）：`moderation/live-ports.ts:274` 的 `ModerationImageSource` 在装配层缺省取
 * `createUnwiredModerationImageSource(...)`（`moderation/live-vendor.ts:397`），它 `read()` 恒 `null`
 * ⇒ 即使 tms/ims 凭据齐备、策略显式打开，图片送审也一律在「取不到待审图片」处 fail-closed
 * （`failed payload_invalid:image_bytes_missing`，零发包）。本片新增
 * `services/api/src/moderation/image-source.ts`（`createObjectStoreModerationImageSource()`）
 * 并把它接进 `live-wiring.ts` / `service.ts` / `app.ts`，形状对齐同族先例
 * `ai/ocr-image-source.ts`（#766）与 `recognitions/image-source.ts`（#775）。
 *
 * 六条必须一直成立的事（删/改任一条即红，见交付回报的负控制表）：
 *  A. **字节真的来自衍生件**：`read()` 返回的正是对象存储里 `derivativeRef` 对应的那一段字节，
 *     且**逐字节 ≠ 原件（`rawRef`）字节**；端到端时它逐字节出现在送审请求体的 `FileContent` 里。
 *  B. **失败逐条可指**：24 种坏输入 ⇒ `read()` 返回 `null` 且 `lastFailure()` 留下**既有契约错误码**，
 *     适配器一贯 `payload_invalid`、零发包。**绝不返回空字节或替身图**。
 *  C. **「不给端口 ⇒ 行为不变」**：`createLiveModerationPortsFromWiring()` 在**不给** `imageMedia`
 *     （`undefined` / `null`）时，与接线前那份「显式 `createUnwiredModerationImageSource('对象存储属媒体域，
 *     本片未接线')`」**逐字段相同**（端口自述、异常字段、观测、零外呼）。
 *  D. **零外呼**：本文件所有用例都不联网；`globalThis.fetch` 换成**绊线**（被触发即抛错），
 *     手法与 `tests/unit/ai-live-provider-wiring.test.mjs` 的头注一致。
 *  E. **装配点只转发既有端口**：`app.ts` 按 `speechAudioMedia` / `ocrImageMedia` 同形，把媒体域**既有**的
 *     `mediaStore` + `mediaObjectStore` 以**取值器**交给 `createModerationService`；`service.ts` 把它并进
 *     `liveWiring`（wiring 自带优先）；`live-wiring.ts` 三档取值（显式来源 > 取值器 > 未接线）。
 *  F. **结构性自证**：源文件不读 ambient env、不碰文件系统、不出现 `fetch(`；两份闭集与上游**同源**。
 *
 * ⚠ 本文件的字节全部是**合成 PNG 头**（24 字节 + 标记串），不含任何真实照片/EXIF。
 *    本片证明的是「字节端口已接线、失败语义可判定」，**不是**「审核策略有效」或「图片真的被审过」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { MEDIA_PURPOSE_KIND, MEDIA_PURPOSE_MIME, MEDIA_PURPOSES } from '../../packages/media/constants.mjs';

import {
  MODERATION_IMAGE_CONTENT_TYPES,
  MODERATION_IMAGE_FAILURE_CODES,
  MODERATION_IMAGE_PURPOSES,
  createObjectStoreModerationImageSource,
} from '../../services/api/src/moderation/image-source.ts';
import {
  createUnwiredModerationImageSource,
  requireModerationImageBytes,
} from '../../services/api/src/moderation/live-vendor.ts';
import { createLiveModerationPortsFromWiring } from '../../services/api/src/moderation/live-wiring.ts';
import {
  MODERATION_MAX_IMAGE_BYTES,
  MODERATION_VENDOR_ENDPOINTS,
  ModerationPortError,
} from '../../services/api/src/moderation/live-ports.ts';
import { createLiveModerationImagePort } from '../../services/api/src/moderation/ims-live-adapter.ts';
import { createModerationService } from '../../services/api/src/moderation/service.ts';
import { createUnwiredObjectStore } from '../../services/api/src/media/object-store.ts';
import { ERROR_CODES } from '../../services/api/src/contract.ts';

const REPO = new URL('../../', import.meta.url);
const readRepoText = (relative) => readFileSync(new URL(relative, REPO), 'utf8');

const MEDIA_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OTHER_MEDIA_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff';
const RAW_KEY = 'media-raw/synthetic-r70-original-with-exif-0001';
const DERIVED_KEY = 'media-derived/synthetic-r70-stripped-0001';
const OWNER = 'user-owner-r70-moderation-bytes';
const OTHER_OWNER = 'user-other-r70-moderation-bytes';

/** `live-wiring.ts` 里**逐字**写着的那句未接线原因（本片不许它漂移）。 */
const UNWIRED_REASON = '对象存储属媒体域，本片未接线';

const CREDENTIALS = Object.freeze({
  secretId: 'synthetic-secret-id-not-a-secret',
  secretKey: 'synthetic-secret-key-not-a-secret',
  sessionToken: '',
});

const POLICY = Object.freeze({
  policySelectionVerified: true,
  executionAllowed: true,
  source: 'tests/unit/moderation-image-source.test.mjs',
});

const TEXT_PROFILE_BASE = Object.freeze({
  action: 'TextModeration',
  apiVersion: '2020-12-29',
  region: 'ap-shanghai',
  timeoutMs: 1000,
  maxRetries: 0,
  bizType: 'gy-test-biz',
});

const IMAGE_PROFILE_BASE = Object.freeze({
  ...TEXT_PROFILE_BASE,
  action: 'ImageModeration',
  maxImageBytes: MODERATION_MAX_IMAGE_BYTES,
  mediaTransport: 'inlineBase64',
});

/** 最小合法 PNG 头（魔数 + IHDR 长度 + 'IHDR' + 宽 + 高）＋ 可辨识标记串。 */
function syntheticPng(marker) {
  const header = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(2, 16);
  header.writeUInt32BE(2, 20);
  return Buffer.concat([header, Buffer.from(marker, 'ascii')]);
}

/** 衍生件字节 与 原件字节：两者都是**合法 PNG 头**（否则「读了原件」会被头部嗅探提前挡掉，掩住回归）。 */
const DERIVED_BYTES = syntheticPng('-derived-no-exif-r70');
const RAW_BYTES = syntheticPng('-raw-with-exif-gps-r70');
const b64 = (bytes) => Buffer.from(bytes).toString('base64');

/** 媒体登记册行：默认＝「已就绪的社区投稿图，衍生件在，有归属主体」。 */
function imageRecord(overrides = {}) {
  return {
    id: MEDIA_ID,
    ownerId: OWNER,
    revision: 1,
    state: 'ready',
    purpose: 'community_image',
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
      if (key === RAW_KEY) return { bytes: RAW_BYTES, contentType: 'image/jpeg' };
      if (key === DERIVED_KEY) {
        return { bytes: options.bytes ?? DERIVED_BYTES, contentType: options.contentType ?? 'image/png' };
      }
      return null;
    },
  };
}

/** 一份"合法"的注入端口（记录用，个别用例会覆盖其中一项）。 */
function ports(overrides = {}) {
  const records = new Map([[MEDIA_ID, overrides.record ?? imageRecord()]]);
  return {
    mediaRecords: fakeRegistry(records, overrides.registryOptions ?? {}),
    objectStore: fakeObjectStore(overrides.storeOptions ?? {}),
    ...(overrides.ports ?? {}),
  };
}

/** 不带凭据的未接线来源（**接线前的产品默认值**，逐字取自 `live-wiring.ts`）。 */
const preChangeSource = () => createUnwiredModerationImageSource(UNWIRED_REASON);

function wiring(overrides = {}) {
  return {
    policy: POLICY,
    textProfile: { endpoint: MODERATION_VENDOR_ENDPOINTS.tms, ...TEXT_PROFILE_BASE },
    imageProfile: { endpoint: MODERATION_VENDOR_ENDPOINTS.ims, ...IMAGE_PROFILE_BASE },
    credentials: CREDENTIALS,
    ...overrides,
  };
}

function imsRequest(ids, { withRevision = 1 } = {}) {
  return {
    schema: 'gengyun/moderation/model-request@1',
    kind: 'ims',
    prompt_id: 'image_moderation',
    prompt_version: 'pv-test',
    required_output_fields: ['label', 'reason_codes', 'summary'],
    verdict_labels: ['pass', 'block', 'unsure'],
    target_ref: { type: 'post', id: 'post-1001', revision: 1 },
    content: {
      media_refs: ids.map((id) => ({
        media_id: id,
        ...(withRevision === null ? {} : { media_revision: withRevision }),
        mime: 'image/png',
      })),
    },
  };
}

/** 记录式假 `fetch`：**不联网**，按 URL 区分 tms / ims，回一份合法供应商载荷。 */
function recordingFetch() {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, body: String(init?.body ?? '') });
    return {
      ok: true,
      status: 200,
      async json() {
        return { Response: { RequestId: 'req-synthetic-r70', Suggestion: 'Pass', Label: 'Normal', Score: 99 } };
      },
    };
  };
  return { calls, impl, imsCalls: () => calls.filter((entry) => entry.url === MODERATION_VENDOR_ENDPOINTS.ims) };
}

async function captureFailure(operation) {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  assert.fail('该路径必须抛错（任何失败都不得产出通过）');
}

/** 零外呼绊线：任何一次真实外呼都会让用例红（手法同 `ai-live-provider-wiring.test.mjs` 头注）。 */
function installFetchTripwire() {
  const original = globalThis.fetch;
  const state = { calls: 0 };
  globalThis.fetch = async () => {
    state.calls += 1;
    throw new Error('SYNTHETIC_TRIPWIRE：本片用例不允许任何真实外呼');
  };
  return {
    state,
    restore() {
      globalThis.fetch = original;
    },
  };
}

// ---------------------------------------------------------------- A. 正控制

test('A·正控制：只读去元数据衍生件；返回的字节逐字节 ≠ 原件字节', async () => {
  const objectStore = fakeObjectStore();
  const registry = fakeRegistry(new Map([[MEDIA_ID, imageRecord()]]));
  const source = createObjectStoreModerationImageSource(() => ({ mediaRecords: registry, objectStore }));

  const bytes = await source.read({ mediaId: MEDIA_ID, mediaRevision: 1 });

  assert.equal(bytes instanceof Uint8Array || Buffer.isBuffer(bytes), true, '必须真的返回字节');
  assert.deepEqual([...bytes], [...DERIVED_BYTES], '返回的必须是衍生件字节');
  assert.notDeepEqual([...bytes], [...RAW_BYTES], '⛔ 返回的字节不得等于原件字节（含 EXIF/GPS 的那一份）');
  assert.equal(b64(bytes) === b64(RAW_BYTES), false, 'base64 形态同样不得与原件相同');
  assert.deepEqual(objectStore.calls, [DERIVED_KEY], '只允许按 derivativeRef 取一次字节，原件键一次都不许碰');
  assert.deepEqual(registry.calls, [MEDIA_ID]);
  assert.equal(source.lastFailure(), null);
  assert.equal(source.lastFailureReason(), null);
  assert.equal(source.readAttempts, 1);
  assert.equal(source.kind, 'wired');
});

test('A·版本未钉（null）＝社区送审载荷常态：读登记册当前版本的衍生件，仍然只读衍生件', async () => {
  const objectStore = fakeObjectStore();
  const registry = fakeRegistry(new Map([[MEDIA_ID, imageRecord({ revision: 7 })]]));
  const source = createObjectStoreModerationImageSource(() => ({ mediaRecords: registry, objectStore }));

  const bytes = await source.read({ mediaId: MEDIA_ID, mediaRevision: null });
  assert.deepEqual([...bytes], [...DERIVED_BYTES]);
  assert.deepEqual(objectStore.calls, [DERIVED_KEY], '不得因为"没钉版本"就去读原件或猜对象键');
});

test('A·端到端（假 fetch，零外呼）：衍生件字节逐字节进 `FileContent`，且 ≠ 原件 base64', async () => {
  const objectStore = fakeObjectStore();
  const registry = fakeRegistry(new Map([[MEDIA_ID, imageRecord()]]));
  const fetchRecorder = recordingFetch();
  // 刻意**不带版本**：与社区投稿的送审载荷同形（`mediaInputs()` 只回 `{media_id}`）。
  const ims = createLiveModerationImagePort({
    policy: POLICY,
    profile: { endpoint: MODERATION_VENDOR_ENDPOINTS.ims, ...IMAGE_PROFILE_BASE },
    credentials: CREDENTIALS,
    imageSource: createObjectStoreModerationImageSource(() => ({ mediaRecords: registry, objectStore })),
    fetchImpl: fetchRecorder.impl,
    now: () => 1_700_000_000_000,
  });

  const tripwire = installFetchTripwire();
  try {
    const verdict = await ims.evaluate(imsRequest([MEDIA_ID], { withRevision: null }));
    assert.equal(verdict.label, 'pass', '假供应商回 Pass ⇒ 端口结论 pass');
    assert.equal(tripwire.state.calls, 0, '零外呼：必须走注入的 fetchImpl');

    assert.equal(fetchRecorder.calls.length, 1, '恰好一次发送（零重试）');
    const body = JSON.parse(fetchRecorder.calls[0].body);
    assert.equal(body.FileContent, b64(DERIVED_BYTES), '送审的必须是衍生件字节');
    assert.notEqual(body.FileContent, b64(RAW_BYTES), '⛔ 送审的绝不能是原件字节');
    assert.equal(body.BizType, IMAGE_PROFILE_BASE.bizType);
    assert.deepEqual(objectStore.calls, [DERIVED_KEY]);
  } finally {
    tripwire.restore();
  }
});

// ---------------------------------------------------------------- B. 失败矩阵

test('B·失败矩阵：24 种坏输入逐条可判定（既有契约码原样保留），适配器一律 payload_invalid 且零发包', async () => {
  const providerUnavailable = Object.assign(new Error('synthetic unwired port'), {
    code: 'PROVIDER_UNAVAILABLE',
    retryable: false,
  });

  const cases = [
    { name: '媒体引用为空（mediaId = ""）', record: null, read: { mediaId: '' }, expect: 'NOT_FOUND' },
    { name: '媒体记录不存在', record: null, expect: 'NOT_FOUND' },
    { name: '媒体没有归属主体（ownerId = ""）', record: imageRecord({ ownerId: '' }), expect: 'NOT_FOUND' },
    { name: '媒体没有归属主体（ownerId = null）', record: imageRecord({ ownerId: null }), expect: 'NOT_FOUND' },
    { name: '归属主体不符（装配层钉死 ownerUserId）', record: imageRecord(), ports: { ownerUserId: OTHER_OWNER }, expect: 'NOT_FOUND' },
    { name: '请求版本已推进（登记 1 / 请求 2）', record: imageRecord(), read: { mediaRevision: 2 }, expect: 'REVISION_CONFLICT' },
    { name: '请求版本形状不合法（0）', record: imageRecord(), read: { mediaRevision: 0 }, expect: 'REVISION_CONFLICT' },
    { name: '请求版本形状不合法（1.5）', record: imageRecord(), read: { mediaRevision: 1.5 }, expect: 'REVISION_CONFLICT' },
    { name: '请求版本形状不合法（NaN）', record: imageRecord(), read: { mediaRevision: Number.NaN }, expect: 'REVISION_CONFLICT' },
    { name: '未就绪（processing）', record: imageRecord({ state: 'processing' }), expect: 'OBJECT_UNAVAILABLE' },
    { name: '未就绪（initiated）', record: imageRecord({ state: 'initiated' }), expect: 'OBJECT_UNAVAILABLE' },
    { name: '未就绪（deleted）', record: imageRecord({ state: 'deleted' }), expect: 'OBJECT_UNAVAILABLE' },
    { name: '跨用途（label_ocr）', record: imageRecord({ purpose: 'label_ocr' }), expect: 'OBJECT_UNAVAILABLE' },
    { name: '跨用途（weed_recognition）', record: imageRecord({ purpose: 'weed_recognition' }), expect: 'OBJECT_UNAVAILABLE' },
    { name: '跨用途（voice_question）', record: imageRecord({ purpose: 'voice_question' }), expect: 'OBJECT_UNAVAILABLE' },
    { name: '只有含元数据的原件（derivativeRef = null）', record: imageRecord({ derivativeRef: null }), expect: 'OBJECT_UNAVAILABLE' },
    { name: '衍生件键为空串', record: imageRecord({ derivativeRef: '' }), expect: 'OBJECT_UNAVAILABLE' },
    { name: '对象存储里没有该对象', record: imageRecord({ derivativeRef: 'media-derived/absent' }), expect: 'OBJECT_UNAVAILABLE' },
    { name: '对象字节为空', record: imageRecord(), storeOptions: { bytes: new Uint8Array(0) }, expect: 'OBJECT_UNAVAILABLE' },
    { name: 'Content-Type 不受支持（image/webp）', record: imageRecord(), storeOptions: { contentType: 'image/webp' }, expect: 'OBJECT_UNAVAILABLE' },
    { name: 'Content-Type 缺失（application/octet-stream）', record: imageRecord(), storeOptions: { contentType: 'application/octet-stream' }, expect: 'OBJECT_UNAVAILABLE' },
    { name: 'Content-Type 为空串', record: imageRecord(), storeOptions: { contentType: '' }, expect: 'OBJECT_UNAVAILABLE' },
    { name: '对象存储抛闭集码（未接线端口的 PROVIDER_UNAVAILABLE，原样保留）', record: imageRecord(), storeOptions: { throw: providerUnavailable }, expect: 'PROVIDER_UNAVAILABLE' },
    { name: '对象存储抛无码错误', record: imageRecord(), storeOptions: { throw: new Error('synthetic boom') }, expect: 'OBJECT_UNAVAILABLE' },
    { name: '媒体登记册抛闭集码（PROVIDER_UNAVAILABLE，原样保留）', registryOptions: { throw: providerUnavailable }, expect: 'PROVIDER_UNAVAILABLE' },
    { name: '媒体登记册抛无码错误', registryOptions: { throw: new Error('synthetic boom') }, expect: 'PROVIDER_UNAVAILABLE' },
    { name: '端口未配置（取值器给空对象）', emptyPorts: true, expect: 'PROVIDER_UNAVAILABLE' },
    { name: '端口取值器自己抛错', resolverThrows: true, expect: 'PROVIDER_UNAVAILABLE' },
  ];
  assert.equal(cases.length >= 12, true, '坏输入矩阵至少 12 种');

  const tripwire = installFetchTripwire();
  try {
    for (const item of cases) {
      const built = ports({
        record: item.record === null ? undefined : item.record,
        registryOptions: item.registryOptions,
        storeOptions: item.storeOptions,
        ports: item.ports,
      });
      if (item.record === null) built.mediaRecords = fakeRegistry(new Map());
      const resolver = item.resolverThrows
        ? () => {
            throw new Error('synthetic resolver boom');
          }
        : item.emptyPorts
          ? () => ({})
          : () => built;

      const source = createObjectStoreModerationImageSource(resolver);
      const input = { mediaId: MEDIA_ID, mediaRevision: 1, ...(item.read ?? {}) };
      const bytes = await source.read(input);
      assert.equal(bytes, null, `${item.name}：必须 fail-closed（read() → null），绝不返回空字节或替身`);
      assert.equal(source.lastFailure(), item.expect, `${item.name}：诊断码不对（实际 ${String(source.lastFailure())}）`);
      assert.equal(MODERATION_IMAGE_FAILURE_CODES.includes(source.lastFailure()), true, `${item.name}：诊断码必须在闭集内`);
      assert.equal(ERROR_CODES.includes(source.lastFailure()), true, `${item.name}：诊断码必须是既有契约码（不新造）`);
      const reason = source.lastFailureReason();
      assert.equal(typeof reason, 'string', `${item.name}：必须留下可读原因`);
      assert.equal(reason.includes(DERIVED_KEY) || reason.includes(RAW_KEY), false, `${item.name}：原因不得泄露对象键`);
      assert.equal(built.objectStore.calls.includes(RAW_KEY), false, `${item.name}：⛔ 任何失败路径都不得去读原件`);
    }

    // 适配器一贯：本地拒绝 ⇒ payload_invalid（零发包）。抽四档代表各验一次。
    const adapterCases = [
      { name: '媒体记录不存在', record: null, read: { mediaRevision: 1 } },
      { name: '版本已推进', record: imageRecord(), read: { mediaRevision: 2 } },
      { name: '未就绪', record: imageRecord({ state: 'processing' }), read: { mediaRevision: 1 } },
      { name: '跨用途', record: imageRecord({ purpose: 'label_ocr' }), read: { mediaRevision: 1 } },
    ];
    for (const item of adapterCases) {
      const built = ports({ record: item.record === null ? undefined : item.record });
      if (item.record === null) built.mediaRecords = fakeRegistry(new Map());
      const fetchRecorder = recordingFetch();
      const ims = createLiveModerationImagePort({
        policy: POLICY,
        profile: { endpoint: MODERATION_VENDOR_ENDPOINTS.ims, ...IMAGE_PROFILE_BASE },
        credentials: CREDENTIALS,
        imageSource: createObjectStoreModerationImageSource(() => built),
        fetchImpl: fetchRecorder.impl,
      });
      const error = await captureFailure(() => ims.evaluate(imsRequest([MEDIA_ID], { withRevision: item.read.mediaRevision })));
      assert.equal(error instanceof ModerationPortError, true, `${item.name}：必须抛 ModerationPortError`);
      assert.equal(error.model_failure, 'payload_invalid', `${item.name}：本地拒绝必须是 payload_invalid`);
      assert.equal(error.result_may_have_been_processed, false, `${item.name}：本地拒绝不可能已被供应商处理`);
      assert.equal(fetchRecorder.calls.length, 0, `${item.name}：本地拒绝不得外呼`);
    }
    assert.equal(tripwire.state.calls, 0, '整张矩阵零外呼');
  } finally {
    tripwire.restore();
  }
});

test('B·端口未配置：构造器本身不该产出「未接线」形态 —— 缺端口由装配层落回自带实现', async () => {
  const source = createObjectStoreModerationImageSource(() => ({}));
  assert.equal(source.kind, 'wired', '构造器拿到取值器就构造真实形态（缺端口是运行期诊断，不是替身）');
  assert.equal(await source.read({ mediaId: MEDIA_ID, mediaRevision: null }), null);
  assert.equal(source.lastFailure(), 'PROVIDER_UNAVAILABLE');
  assert.match(String(source.lastFailureReason()), /端口未配置/);
  assert.equal(source.readAttempts, 1);

  // 取值器不是函数 ⇒ 落回未接线形态（`kind === 'unwired'`，恒 null）。
  const notAFunction = createObjectStoreModerationImageSource(undefined);
  assert.equal(notAFunction.kind, 'unwired');
  assert.equal(await notAFunction.read({ mediaId: MEDIA_ID, mediaRevision: 1 }), null);
  assert.equal(notAFunction.lastFailure(), 'PROVIDER_UNAVAILABLE');
});

// ---------------------------------------------------------------- C. 等价性

test('C·等价性：不给端口（undefined / null）⇒ 与接线前逐字段相同', async () => {
  const observationsA = [];
  const observationsB = [];
  const fetchA = recordingFetch();
  const fetchB = recordingFetch();
  const fetchC = recordingFetch();

  // 「改前」：产品装配里那份**显式**未接线来源（逐字复刻 `live-wiring.ts` 的默认值）。
  const before = createLiveModerationImagePort({
    policy: POLICY,
    profile: { endpoint: MODERATION_VENDOR_ENDPOINTS.ims, ...IMAGE_PROFILE_BASE },
    credentials: CREDENTIALS,
    imageSource: preChangeSource(),
    fetchImpl: fetchA.impl,
    now: () => 1_700_000_000_000,
    onObservation: (observation) => observationsA.push(observation),
  });
  // 「改后」：不给 imageMedia（键缺省）。
  const afterAbsent = createLiveModerationPortsFromWiring(
    wiring({
      fetchImpl: fetchB.impl,
      now: () => 1_700_000_000_000,
      onObservation: (observation) => observationsB.push(observation),
    }),
  );
  // 「改后」：显式 `imageMedia: null`（同一档，不得因为"给了个空值"就改变形态）。
  const afterNull = createLiveModerationPortsFromWiring(
    wiring({
      imageMedia: null,
      fetchImpl: fetchC.impl,
      now: () => 1_700_000_000_000,
    }),
  );
  assert.notEqual(afterAbsent, null, '给了凭据与策略 ⇒ 必须装配出真实端口对');
  assert.notEqual(afterNull, null);

  for (const [label, port] of [
    ['键缺省', afterAbsent.ims],
    ['显式 null', afterNull.ims],
  ]) {
    assert.equal(port.kind, before.kind, `${label}：端口类型必须相同`);
    assert.equal(port.model_version, before.model_version, `${label}：模型版本必须相同`);
    assert.deepEqual(port.provider, before.provider, `${label}：provider 自述必须逐字段相同`);
    assert.deepEqual(Object.keys(port.seams).sort(), Object.keys(before.seams).sort(), `${label}：seam 闭集必须相同`);
  }

  const failureFields = (error) => ({
    name: error?.name,
    message: error?.message,
    model_failure: error?.model_failure,
    http_status: error?.http_status,
    provider_error_code: error?.provider_error_code,
    result_may_have_been_processed: error?.result_may_have_been_processed,
  });

  const tripwire = installFetchTripwire();
  try {
    const beforeError = await captureFailure(() => before.evaluate(imsRequest([MEDIA_ID])));
    const afterError = await captureFailure(() => afterAbsent.ims.evaluate(imsRequest([MEDIA_ID])));
    const nullError = await captureFailure(() => afterNull.ims.evaluate(imsRequest([MEDIA_ID])));

    assert.deepEqual(failureFields(afterError), failureFields(beforeError), '不给端口 ⇒ 异常逐字段相同（message/类别/状态/是否可能已处理）');
    assert.deepEqual(failureFields(nullError), failureFields(beforeError), '`imageMedia: null` 同样逐字段相同');
    assert.equal(beforeError.model_failure, 'payload_invalid');
    assert.equal(beforeError.message, afterError.message, '异常文案逐字相同');
    assert.deepEqual(failureFields(afterError), failureFields(nullError));

    assert.deepEqual(observationsB, observationsA, '观测逐字段相同');
    assert.equal(fetchA.calls.length, 0);
    assert.equal(fetchB.calls.length, 0);
    assert.equal(fetchC.calls.length, 0);
    assert.equal(tripwire.state.calls, 0);
  } finally {
    tripwire.restore();
  }

  // 结构钉子：默认值那句未接线原因**逐字**还在（负控制④就是打这里）。
  const wiringSource = readRepoText('services/api/src/moderation/live-wiring.ts');
  assert.equal(
    wiringSource.includes(`createUnwiredModerationImageSource('${UNWIRED_REASON}')`),
    true,
    '`live-wiring.ts` 里「不给端口 ⇒ 未接线」那一档必须逐字保留（含原因为字符串字面量）',
  );
});

test('C·给了取值器 ⇒ 真实来源；同时显式 `imageSource` 仍然优先', async () => {
  const objectStore = fakeObjectStore();
  const registry = fakeRegistry(new Map([[MEDIA_ID, imageRecord()]]));
  const fetchRecorder = recordingFetch();

  const wiredPorts = createLiveModerationPortsFromWiring(
    wiring({
      imageMedia: () => ({ mediaRecords: registry, objectStore }),
      fetchImpl: fetchRecorder.impl,
    }),
  );
  const verdict = await wiredPorts.ims.evaluate(imsRequest([MEDIA_ID], { withRevision: null }));
  assert.equal(verdict.label, 'pass');
  assert.equal(JSON.parse(fetchRecorder.calls[0].body).FileContent, b64(DERIVED_BYTES), '给了取值器就必须送衍生件字节');

  // 显式 imageSource 优先：即便同时给了 imageMedia，也不得去碰媒体域端口。
  const untouched = fakeObjectStore();
  const untouchedRegistry = fakeRegistry(new Map([[MEDIA_ID, imageRecord()]]));
  const explicitCalls = [];
  const fetchExplicit = recordingFetch();
  const explicit = createLiveModerationPortsFromWiring(
    wiring({
      imageMedia: () => ({ mediaRecords: untouchedRegistry, objectStore: untouched }),
      imageSource: {
        kind: 'wired',
        note: 'synthetic explicit source',
        async read({ mediaId }) {
          explicitCalls.push(mediaId);
          return DERIVED_BYTES;
        },
      },
      fetchImpl: fetchExplicit.impl,
    }),
  );
  await explicit.ims.evaluate(imsRequest([MEDIA_ID]));
  assert.deepEqual(explicitCalls, [MEDIA_ID], '显式来源必须被使用');
  assert.deepEqual(untouched.calls, [], '显式来源在场时不得再去读媒体域对象存储');
});

// ---------------------------------------------------------------- D. 零外呼绊线

test('D·零外呼：正控制（走注入 fetchImpl）与全部失败路径都不触发 globalThis.fetch', async () => {
  const tripwire = installFetchTripwire();
  try {
    // 正控制：给了端口 + 合法媒体 ⇒ 只走注入的 fetchImpl。
    const built = ports();
    const recorder = recordingFetch();
    const ims = createLiveModerationImagePort({
      policy: POLICY,
      profile: { endpoint: MODERATION_VENDOR_ENDPOINTS.ims, ...IMAGE_PROFILE_BASE },
      credentials: CREDENTIALS,
      imageSource: createObjectStoreModerationImageSource(() => built),
      fetchImpl: recorder.impl,
    });
    await ims.evaluate(imsRequest([MEDIA_ID], { withRevision: 1 }));
    assert.equal(recorder.calls.length, 1);

    // 未接线端口当对象存储（real 下未注入真实存储的默认形态）：fail-closed 且零外呼。
    const unwiredStore = createUnwiredObjectStore('synthetic unwired store');
    const unwiredSource = createObjectStoreModerationImageSource(() => ({
      mediaRecords: fakeRegistry(new Map([[MEDIA_ID, imageRecord()]])),
      objectStore: unwiredStore,
    }));
    assert.equal(await unwiredSource.read({ mediaId: MEDIA_ID, mediaRevision: 1 }), null);
    assert.equal(unwiredSource.lastFailure(), 'PROVIDER_UNAVAILABLE', '未接线端口抛的 PROVIDER_UNAVAILABLE 必须原样保留');

    assert.equal(tripwire.state.calls, 0, '全程零外呼（绊线一次都没被触发）');
  } finally {
    tripwire.restore();
  }
});

// ---------------------------------------------------------------- E. 装配点

test('E·装配点：app.ts 以取值器转发既有媒体端口；service.ts 并进 wiring；live-wiring 三档取值', () => {
  const appSource = readRepoText('services/api/src/app.ts');
  const serviceSource = readRepoText('services/api/src/moderation/service.ts');
  const wiringSource = readRepoText('services/api/src/moderation/live-wiring.ts');

  // ① app.ts：在 `createModerationService(...)` 里以取值器转发**既有**的两个实例。
  assert.equal(
    appSource.includes('imageMedia: () => ({ objectStore: mediaObjectStore, mediaRecords: mediaStore })'),
    true,
    'app.ts 必须把媒体域既有的 mediaObjectStore + mediaStore 以取值器交给审核域',
  );
  const moderationCall = appSource.split(/\r?\n/).findIndex((line) => line.includes('createModerationService({'));
  assert.notEqual(moderationCall, -1, 'app.ts 必须有审核域装配调用');
  const moderationBlock = appSource.split(/\r?\n/).slice(moderationCall, moderationCall + 20).join('\n');
  assert.match(moderationBlock, /imageMedia: \(\) => \(\{ objectStore: mediaObjectStore, mediaRecords: mediaStore \}\)/, '取值器必须落在 `createModerationService` 的实参块内');
  // ② 装配层仍然不接触字节端口实现模块（端口实现只在域内）。
  assert.equal(appSource.includes('moderation/image-source'), false, 'app.ts 不得 import 字节端口实现（装配层只转发既有端口）');
  assert.equal(appSource.includes('createObjectStoreModerationImageSource'), false, 'app.ts 不得构造真实字节来源（构造点在 live-wiring.ts）');

  // ④ service.ts：把 deps.imageMedia 并进 wiring（wiring 自带优先）。
  assert.match(
    serviceSource,
    /deps\.imageMedia === undefined \|\| deps\.imageMedia === null \|\| deps\.liveWiring\.imageMedia !== undefined \? deps\.liveWiring : \{ \.\.\.deps\.liveWiring, imageMedia: deps\.imageMedia \}/,
    'service.ts 必须把装配层的取值器并进 liveWiring（不得覆盖 wiring 自带的 imageMedia）',
  );
  // ⑤ live-wiring.ts：三档优先级逐字可见。
  assert.match(
    wiringSource,
    /wiring\.imageSource \?\? \(wiring\.imageMedia === undefined \|\| wiring\.imageMedia === null \? createUnwiredModerationImageSource\('对象存储属媒体域，本片未接线'\) : createObjectStoreModerationImageSource\(wiring\.imageMedia\)\)/,
    'live-wiring.ts 必须是「显式来源 > 取值器 > 未接线」三档',
  );
});

// ---------------------------------------------------------------- F. 结构性自证

test('F·结构性自证：不读环境/不碰文件系统/不外呼；闭集与上游同源', () => {
  const source = readRepoText('services/api/src/moderation/image-source.ts');
  // 去掉注释后再断言：注释里**必须**能写出这条纪律，代码里**一次都不许出现**（手法同 `ocr-image-source.test.mjs`）。
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['node:fs', 'node:child_process', 'node:path', 'process.env', 'process.cwd', 'fetch(', '\\']) {
    assert.equal(code.includes(forbidden), false, `字节端口源码（去注释后）不得出现 ${forbidden}`);
  }
  assert.equal(/\breadFileSync\b|\breadFile\b|\bwriteFileSync\b/.test(code), false, '不得读写文件');
  assert.equal(code.includes('S3'), false, '不得在本文件里构造第二套对象存储客户端');
  assert.equal(/import\s+[^;]*from\s+'node:/.test(code), false, '不得 import 任何 node: 内置模块');

  // 失败码闭集：与契约闭集相容，且与同族两份逐字同集合。
  for (const code of MODERATION_IMAGE_FAILURE_CODES) {
    assert.equal(ERROR_CODES.includes(code), true, `${code} 必须是既有契约码`);
  }
  assert.deepEqual([...MODERATION_IMAGE_FAILURE_CODES], ['NOT_FOUND', 'REVISION_CONFLICT', 'OBJECT_UNAVAILABLE', 'PROVIDER_UNAVAILABLE']);
  const ocrSource = readRepoText('services/api/src/ai/ocr-image-source.ts');
  for (const code of MODERATION_IMAGE_FAILURE_CODES) {
    assert.equal(ocrSource.includes(`'${code}'`), true, `同族 OCR 端口也必须有 ${code}（口径对读）`);
  }

  // 用途闭集：只取社区投稿图，且必须是 image 类、且是该用途合法上传类型之一。
  assert.deepEqual([...MODERATION_IMAGE_PURPOSES], ['community_image']);
  for (const purpose of MODERATION_IMAGE_PURPOSES) {
    assert.equal(MEDIA_PURPOSES.includes(purpose), true, `${purpose} 必须是契约用途`);
    assert.equal(MEDIA_PURPOSE_KIND[purpose], 'image', `${purpose} 必须是图片类用途`);
  }
  // Content-Type 收窄：必须真子集于该用途的合法上传类型，且与适配器真正能吃的两种一致。
  assert.deepEqual([...MODERATION_IMAGE_CONTENT_TYPES], ['image/jpeg', 'image/png']);
  for (const contentType of MODERATION_IMAGE_CONTENT_TYPES) {
    assert.equal(MEDIA_PURPOSE_MIME.community_image.includes(contentType), true, `${contentType} 必须是 community_image 的合法上传类型`);
  }
  assert.equal(MEDIA_PURPOSE_MIME.community_image.includes('image/webp'), true, 'image/webp 是合法上传类型（因此上面那份收窄是真收窄，不是同义反复）');
  assert.equal([...MODERATION_IMAGE_CONTENT_TYPES].includes('image/webp'), false, 'webp 必须被排除（适配器只认 PNG/JPEG 头）');

  // 与适配器的头部嗅探对齐：PNG/JPEG 被接受，webp 被拒。
  assert.doesNotThrow(() => requireModerationImageBytes(DERIVED_BYTES, MODERATION_MAX_IMAGE_BYTES));
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x41, 0x42, 0xff, 0xd9]);
  assert.doesNotThrow(() => requireModerationImageBytes(jpeg, MODERATION_MAX_IMAGE_BYTES));
  const webp = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.alloc(4), Buffer.from('WEBP', 'ascii'), Buffer.alloc(8)]);
  assert.throws(() => requireModerationImageBytes(webp, MODERATION_MAX_IMAGE_BYTES), /真实审核端口失败/);
});

test('G·服务装配：deps.imageMedia 真的被消费（无取值器 ⇒ 图片层取不到字节；有 ⇒ 送衍生件）', async () => {
  const baseContent = {
    target_ref: { type: 'post', id: 'post-2002', revision: 1 },
    text: '今年雨水多，田里的稗草长得快，先看苗情再定药剂。',
    media: [{ media_id: MEDIA_ID, mime: 'image/png' }],
  };
  const actor = { userId: 'u-1', role: 'user', authEpoch: 1 };

  const withoutPorts = recordingFetch();
  const serviceWithout = createModerationService({
    executionMode: 'real',
    liveWiring: wiring({ fetchImpl: withoutPorts.impl }),
  });
  await serviceWithout.runModelScreening({ actor, content: baseContent }).catch(() => null);
  assert.equal(withoutPorts.imsCalls().length, 0, '没有取值器 ⇒ 图片层取不到字节，绝不外呼');

  const objectStore = fakeObjectStore();
  const registry = fakeRegistry(new Map([[MEDIA_ID, imageRecord()]]));
  const withPorts = recordingFetch();
  const serviceWith = createModerationService({
    executionMode: 'real',
    liveWiring: wiring({ fetchImpl: withPorts.impl }),
    imageMedia: () => ({ mediaRecords: registry, objectStore }),
  });
  assert.equal(serviceWith.capabilities().image.ready, true, '凭据齐备 ⇒ 图片端口就绪');
  await serviceWith.runModelScreening({ actor, content: baseContent }).catch(() => null);
  assert.equal(withPorts.imsCalls().length, 1, '给了取值器 ⇒ 图片层真的送审一次');
  assert.equal(JSON.parse(withPorts.imsCalls()[0].body).FileContent, b64(DERIVED_BYTES), '送审的必须是衍生件字节');
  assert.deepEqual(objectStore.calls, [DERIVED_KEY], '只按 derivativeRef 取一次');
});
