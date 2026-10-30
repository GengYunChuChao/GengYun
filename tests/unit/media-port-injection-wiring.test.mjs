/**
 * GY-R31（Refs #9 #10 #11）· 「媒体端口注入」在三域（OCR / 识别 / 语音）的**装配判据**。
 *
 * 背景（如实记录）：基线 `1a333920` 上，识别域（`BuildAppOptions.recognitionMedia`）与语音域
 * （`speechMedia`）**已有**按域媒体引用端口注入口；OCR 域路由层（`OcrRouteDeps['media']`）也支持注入，
 * 但装配层 `app.ts` 的 `registerOcrRoutes(...)` **没有**把端口交下去 ⇒ `real` 模式下 OCR 只能拿到
 * `createUnwiredMediaPort()`（`kind: 'unwired'`），注入桩件无法接管。
 * 本文件判据：
 *   ① 注入可用端口 ⇒ 三域**逐域**都拿到该端口（`describe().mediaPort` / `mediaNote`）；
 *   ② 不注入且 `real` ⇒ 三域保持**原有** fail-closed 形态与**逐字**错误码/文案（HTTP 503 原文）；
 *      ⚠ GY-R70 一处如实变更：识别域的媒体引用端口已接媒体域既有两个端口（`mediaStore` +
 *      `mediaObjectStore`），因此「零注入 + real」下该域 `describe().mediaPort` 由 `unwired` 变为
 *      `wired`、文案换成新的一份（判据仍逐字相等）；**HTTP 结局不变**（无凭据 ⇒ 503 原文逐字不变；
 *      有凭据 ⇒ 409 `OBJECT_UNAVAILABLE`，见 `tests/unit/recognitions-live-adapter.test.mjs` 的失败序②）。
 *   ③ 非 real（`stub` / `preset_demo`，纯内存装配）不受影响：默认仍是明确标注的替身；
 *   ④ 注入的是**同一个实例**（不是内部又 new 了一个）——用 `note` getter 逐次递增来证明服务持有的是
 *      传进去的那个对象本身；
 *   ⑤ 结构：`BuildAppOptions` 的槽位与装配行的传值都在（改前必红的那一条）。
 *
 * 反向控制（本文件自带牙齿）：把 app.ts 里的 `media: ocrMedia` 删掉 ⇒ ①逐域里的 OCR 一支必红；
 * 把 `recognitionMedia`/`speechMedia` 的既有传值删掉 ⇒ 对应域必红（证明断言不是"恒真"）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken, mintOpaqueToken } from '../../services/api/src/auth/tokens.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const APP_SOURCE = readFileSync(join(ROOT, 'services/api/src/app.ts'), 'utf8');

/** 基线实测原文（`1a333920` 探针读数，见证据页「改前读数」）。 */
const OCR_UNWIRED_NOTE = '媒体 HTTP 路由已注册，但未接真实对象存储：无法读取私有媒体字节（fail-closed）';
const RECOGNITION_UNWIRED_NOTE = OCR_UNWIRED_NOTE;
/** GY-R70：识别域「零注入 + real」下**已接线**端口的文案（逐字；端口交给媒体域既有两个端口）。 */
const RECOGNITION_WIRED_NOTE =
  '真实识别媒体引用：按 media_id+revision 读媒体域登记册（归属/版本/状态/用途/衍生件键）→ 只从对象存储'
  + '取**去元数据衍生件**并校验 Content-Type；不读含 EXIF/GPS 的原件、不读 ambient env、不伪造字节'
  + '（任一环节不成立即 OBJECT_UNAVAILABLE，绝不静默放行）';
const SPEECH_UNWIRED_NOTE = '媒体 HTTP 路由已注册，但未接真实对象存储：无法读取私有录音字节（fail-closed）';

/** 基线实测原文：real 缺供应商凭据时，三域在触达媒体端口**之前**就 fail-closed。 */
const REAL_PROVIDER_REFUSALS = [
  { domain: 'OCR', url: '/api/v1/ocr', code: 'PROVIDER_UNAVAILABLE', message: '缺少真实 OCR 供应商凭据（fail-closed，不回退替身）' },
  { domain: '识别', url: '/api/v1/recognitions', code: 'PROVIDER_UNAVAILABLE', message: '缺少真实识别供应商凭据（fail-closed，不回退替身）' },
  { domain: '语音', url: '/api/v1/speech/transcriptions', code: 'PROVIDER_UNAVAILABLE', message: '缺少真实 ASR 供应商凭据（fail-closed，不回退替身）' },
];

/** 三域各自的 `describe()` 取用点（与 `app.ts` 的装饰名一致）。 */
const DOMAINS = [
  { domain: 'OCR', describe: (app) => app.ocrService.describe(), option: 'ocrMedia', unwiredNote: OCR_UNWIRED_NOTE, zeroPort: 'unwired', zeroNote: OCR_UNWIRED_NOTE },
  { domain: '识别', describe: (app) => app.recognitionService.describe(), option: 'recognitionMedia', unwiredNote: RECOGNITION_UNWIRED_NOTE, zeroPort: 'wired', zeroNote: RECOGNITION_WIRED_NOTE },
  { domain: '语音', describe: (app) => app.speechService.describe(), option: 'speechMedia', unwiredNote: SPEECH_UNWIRED_NOTE, zeroPort: 'unwired', zeroNote: SPEECH_UNWIRED_NOTE },
];

/** 可辨识的媒体引用端口（`note` 带随机标记：自建实例不可能复刻）。 */
function markedMediaPort(label, mark) {
  return {
    kind: 'substitute',
    note: `${mark}:${label}`,
    async resolve({ mediaRevision }) {
      return { ok: true, revision: mediaRevision };
    },
  };
}

/**
 * `note` 逐次递增的端口：服务若在构造期**拷贝**了 note、或内部另 new 了一个端口，
 * 两次 `describe()` 就不可能都读到递增后的值 ⇒ 用它证明「持有的是同一个实例」。
 */
function liveMediaPort(label, mark) {
  let reads = 0;
  return {
    kind: 'substitute',
    get note() {
      reads += 1;
      return `${mark}:${label}#${reads}`;
    },
    async resolve({ mediaRevision }) {
      return { ok: true, revision: mediaRevision };
    },
  };
}

/** 装配一个 app：配置沿用 stub 基线，只换 `executionMode`（与本仓 `ocr-store-pg-wiring.test.mjs` 同法）。 */
function makeApp({ executionMode, options = {} }) {
  const config = { ...loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }), executionMode };
  return buildApp({ config, store: createMemoryAuthStore(), ...options });
}

/** 直接签一份会话（不发登录请求、不外呼）。 */
async function seedSession(store, label) {
  const user = await store.createUser(`${label}-${randomUUID().replace(/-/g, '')}`);
  const token = mintOpaqueToken();
  await store.createSession({
    userId: user.id,
    tokenHashHex: hashToken(token),
    authEpoch: user.authEpoch,
    expiresAt: new Date(Date.now() + 3_600_000),
    audience: 'user',
  });
  return token;
}

async function postMediaJob(app, token, url) {
  const response = await app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    payload: JSON.stringify({ media_id: randomUUID(), media_revision: 1 }),
  });
  return { status: response.statusCode, body: response.json() };
}

test('① 注入可用端口 ⇒ 三域都拿到该端口（逐域断言；OCR 一支改前必红）', async (t) => {
  const mark = `gy-r31-${randomUUID()}`;
  const ports = { ocrMedia: markedMediaPort('ocr', mark), recognitionMedia: markedMediaPort('recognition', mark), speechMedia: markedMediaPort('speech', mark) };
  const app = makeApp({ executionMode: 'real', options: ports });
  t.after(() => app.close());

  for (const { domain, describe, option } of DOMAINS) {
    const described = describe(app);
    assert.equal(
      described.mediaPort,
      'substitute',
      `${domain}域：注入替身端口后 describe().mediaPort 必须是 substitute（实际 ${described.mediaPort} ⇒ 注入口未接线）`,
    );
    assert.equal(described.mediaNote, ports[option].note, `${domain}域：describe().mediaNote 必须原样回显注入端口的 note`);
    assert.notEqual(described.mediaNote, OCR_UNWIRED_NOTE, `${domain}域：不得再是未接线端口的默认文案`);
  }
});

test('② 未注入且 real ⇒ 三域保持原有 fail-closed（端口形态 + HTTP 错误码/文案逐字）', async (t) => {
  const store = createMemoryAuthStore();
  const app = makeApp({ executionMode: 'real', options: { store } });
  t.after(() => app.close());

  for (const { domain, describe, zeroPort, zeroNote } of DOMAINS) {
    const described = describe(app);
    assert.equal(described.mediaPort, zeroPort, `${domain}域：零注入 + real 的端口形态（该域真实接线状态）`);
    assert.equal(described.mediaNote, zeroNote, `${domain}域：零注入 + real 的文案必须逐字相等`);
  }

  const token = await seedSession(store, 'gy-r31-real');
  for (const { domain, url, code, message } of REAL_PROVIDER_REFUSALS) {
    const { status, body } = await postMediaJob(app, token, url);
    assert.equal(status, 503, `${domain}域：零注入 + real 的受理状态码必须仍是 503（实际 ${status}）`);
    assert.equal(body.error.code, code, `${domain}域：错误码必须逐字不变`);
    assert.equal(body.error.message, message, `${domain}域：错误文案必须逐字不变`);
    assert.equal(body.error.retryable, false, `${domain}域：必须仍标 retryable=false`);
  }
});

test('③ memory 模式（stub / preset_demo）不受影响：默认替身，注入仍生效', async (t) => {
  for (const executionMode of ['stub', 'preset_demo']) {
    const plain = makeApp({ executionMode });
    t.after(() => plain.close());
    for (const { domain, describe } of DOMAINS) {
      assert.equal(describe(plain).mediaPort, 'substitute', `${executionMode} 下 ${domain}域默认必须是明确标注的替身端口`);
    }

    const mark = `gy-r31-${executionMode}-${randomUUID()}`;
    const ports = { ocrMedia: markedMediaPort('ocr', mark), recognitionMedia: markedMediaPort('recognition', mark), speechMedia: markedMediaPort('speech', mark) };
    const injected = makeApp({ executionMode, options: ports });
    t.after(() => injected.close());
    for (const { domain, describe, option } of DOMAINS) {
      assert.equal(describe(injected).mediaNote, ports[option].note, `${executionMode} 下 ${domain}域注入必须仍然生效`);
    }
  }
});

test('④ 注入的是同一个实例（不是内部又 new 了一个）', async (t) => {
  const mark = `gy-r31-live-${randomUUID()}`;
  const ports = { ocrMedia: liveMediaPort('ocr', mark), recognitionMedia: liveMediaPort('recognition', mark), speechMedia: liveMediaPort('speech', mark) };
  const app = makeApp({ executionMode: 'real', options: ports });
  t.after(() => app.close());

  for (const { domain, describe, option } of DOMAINS) {
    const first = describe(app).mediaNote;
    const second = describe(app).mediaNote;
    assert.match(first, new RegExp(`^${mark}:${option === 'ocrMedia' ? 'ocr' : option === 'recognitionMedia' ? 'recognition' : 'speech'}#1$`), `${domain}域：首次 describe 必须直接读到注入实例的 getter`);
    assert.notEqual(second, first, `${domain}域：第二次 describe 必须再次触达**同一个** getter（note 已变 ${second}）⇒ 证明持有的就是注入实例，不是拷贝/新建`);
  }
});

test('⑤ 结构：BuildAppOptions 有 ocrMedia 槽位、装配行把它交下去、import 禁项仍成立', () => {
  assert.match(APP_SOURCE, /ocrMedia\?: OcrRouteDeps\['media'\];/, 'BuildAppOptions 必须有 ocrMedia 槽位（类型取自 OcrRouteDeps）');
  const registrationLine = APP_SOURCE.split(/\r?\n/).find((line) => line.includes('registerOcrRoutes(app, config,'));
  assert.notEqual(registrationLine, undefined, 'app.ts 必须有 OCR 域装配行');
  assert.match(registrationLine, /\bmedia: ocrMedia\b/, `装配行必须把 ocrMedia 交给 OCR 域：${registrationLine.trim()}`);
  for (const forbidden of ['ocr/provider', 'ocr/store', 'ocr/media', 'ocr/reference']) {
    assert.equal(APP_SOURCE.includes(forbidden), false, `app.ts 仍不得引用 ${forbidden}（装配层不接触适配器模块）`);
  }
});
