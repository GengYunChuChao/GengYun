// GY-I10 识别页标签校正：请求形状、成功态与三组负例。
// 断言面只覆盖本片新增的更正链路：PATCH /ocr/{id}/correction 恰好一次、
// If-Match 逐字取当前记录版本、Idempotency-Key 长度 8..128、请求体只含 corrected_fields。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';

const root = resolve(import.meta.dirname, '..', '..');
const API_BASE = 'https://synthetic.invalid/api/v1';
const OCR_ID = '99999999-8888-4777-8666-555555555555';
const JOB_ID = '11111111-2222-4333-8444-555555555555';
const REQUEST_ID = '33333333-4444-4555-8666-777777777777';

/** 沙箱：真实 auth / identify-api / 识别页源码，wx.request 只入列、由用例手动决定成败。 */
function harness() {
  const storage = new Map();
  const requests = [];
  const cache = new Map();
  let definition = null;

  const context = {
    wx: {
      getStorageSync(key) { return storage.has(key) ? storage.get(key) : ''; },
      setStorageSync(key, value) { storage.set(key, value); },
      removeStorageSync(key) { storage.delete(key); },
      getStorageInfoSync() { return { keys: Array.from(storage.keys()), currentSize: 0, limitSize: 10240 }; },
      request(options) { requests.push(options); },
      reLaunch() {},
      switchTab() {},
      navigateTo() {},
      showToast() {},
      showModal(options) { if (options && typeof options.success === 'function') options.success({ confirm: true }); },
      chooseMedia() {},
      getFileInfo() {},
      getFileSystemManager() { return { readFile() {} }; }
    },
    getApp() { return { globalData: { fontScale: 1 } }; },
    App() {},
    Page(value) { definition = value; },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
  };

  function load(path) {
    path = resolve(path);
    if (path.endsWith('config\\runtime.js') || path.endsWith('config/runtime.js')) {
      return { mode: 'local', apiBaseUrl: API_BASE };
    }
    if (cache.has(path)) return cache.get(path).exports;
    const module = { exports: {} };
    cache.set(path, module);
    const wrapper = runInNewContext(
      '(function(require,module,exports){' + readFileSync(path, 'utf8') + '\n})',
      context,
      { filename: path }
    );
    wrapper(relative => load(resolve(dirname(path), relative + '.js')), module, module.exports);
    return module.exports;
  }

  const auth = load(join(root, 'miniprogram/utils/auth.js'));
  const identify = load(join(root, 'miniprogram/utils/identify-api.js'));
  load(join(root, 'miniprogram/pages/identify/identify.js'));
  assert.ok(definition !== null && typeof definition === 'object', '沙箱内识别页未注册 Page');
  const pageDefinition = definition;

  function page() {
    const instance = Object.assign({}, pageDefinition);
    instance.data = JSON.parse(JSON.stringify(pageDefinition.data));
    instance.setData = function (patch) { Object.assign(this.data, patch); };
    instance._pollTimer = null;
    instance._generation = 0;
    return instance;
  }

  /**
   * 播种会话并让它通过 `auth.verifySession` 核实：线上 `auth.isLoggedIn()` 依赖
   * serverVerified，只写缓存不会开门（否则会得到 SESSION_REQUIRED 这种假阴性）。
   */
  async function seedSession() {
    const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
    storage.set('gengyun.session', {
      accessToken: 'synthetic-correction-token',
      audience: 'user',
      expiresAt,
      executionMode: 'stub'
    });
    let verified = null;
    const settled = new Promise(done => {
      auth.verifySession(ok => { verified = ok; done(); });
    });
    assert.equal(requests.length, 1, '核实会话应恰好发出一次 GET /auth/session');
    const probe = requests.shift();
    assert.match(probe.url, /\/auth\/session$/, '核实会话的地址不对：' + probe.url);
    probe.success({ statusCode: 200, data: { data: { audience: 'user', expires_at: expiresAt } } });
    await settled;
    assert.equal(verified, true, '会话核实未通过，后续请求会被判成 SESSION_REQUIRED');
    assert.equal(auth.isLoggedIn(), true);
    assert.equal(requests.length, 0, '核实请求必须已消费，便于用例从空队列起算');
  }

  return { storage, requests, identify, auth, page, seedSession };
}

function fields(overrides) {
  return Object.assign({
    registration_number: 'PD20210001',
    name: '替身示例草甘膦水剂',
    ingredients: [{ name: '草甘膦', content_text: '41', unit_text: '%' }],
    dosage_form: '水剂'
  }, overrides || {});
}

function ocrValue(overrides) {
  const value = overrides || {};
  const corrected = value.corrected_fields;
  return {
    id: OCR_ID,
    revision: typeof value.revision === 'number' ? value.revision : 3,
    raw_fields: value.raw_fields === undefined ? fields() : value.raw_fields,
    corrected_fields: corrected === undefined ? fields() : fields(corrected),
    verification: value.verification === undefined ? matchedVerification() : value.verification,
    model_version: 'stub-v1'
  };
}

function matchedVerification() {
  return {
    match_state: 'matched',
    registration: { id: 'synthetic-registration' },
    conflict_fields: [],
    missing_fields: [],
    dose_cards: []
  };
}

function envelope(record) {
  return { data: record, meta: { request_id: REQUEST_ID, contract_version: '1.0.0', execution_mode: 'stub' } };
}

async function waitFor(h, count) {
  for (let i = 0; i < 500; i += 1) {
    if (h.requests.length >= count) return;
    await new Promise(done => setTimeout(done, 0));
  }
  throw new Error('等待请求超时：期望至少 ' + count + ' 个，实际 ' + h.requests.length);
}

/** 让页面拿到一条真实记录（走 historyApi.getOcr → ocrResultView，与线上路径一致）。 */
async function readyPage(h, overrides) {
  const page = h.page();
  page.data.guest = false;
  page.data.ocr = {
    jobId: JOB_ID,
    ocrId: OCR_ID,
    revision: 0,
    state: 'succeeded',
    errorCode: null,
    terminal: true,
    success: true,
    hasResult: true,
    record: null,
    recordNote: '',
    cancelNote: ''
  };
  const loading = page.loadOcrRecord({ id: JOB_ID, target_ref: { id: OCR_ID }, state: 'succeeded' }, 0);
  await waitFor(h, 1);
  h.requests[0].success({ statusCode: 200, data: envelope(ocrValue(overrides)) });
  await loading;
  assert.ok(page.data.ocr.record !== null, '记录读取失败：' + page.data.ocr.recordNote);
  return page;
}

test('校正请求形状：恰好一次 PATCH，If-Match 取当前版本，幂等键 8..128，请求体只含 corrected_fields', async () => {
  const h = harness();
  await h.seedSession();
  const draft = {
    registration_number: 'PD20210001',
    name: '替身示例草甘膦水剂',
    ingredients: [{ name: '草甘膦', content_text: '41', unit_text: '%' }],
    dosage_form: '水剂'
  };

  const pending = h.identify.correctOcrLabel(OCR_ID, 3, draft);
  assert.equal(h.requests.length, 1, '提交必须恰好发出一次请求（无内部重试）');

  const patch = h.requests[0];
  assert.equal(patch.method, 'PATCH');
  assert.equal(patch.url, API_BASE + '/ocr/' + OCR_ID + '/correction');
  assert.equal(patch.header['If-Match'], '"3"', 'If-Match 必须是带引号的当前记录版本');
  assert.match(patch.header['If-Match'], /^"[1-9][0-9]*"$/, 'If-Match 不得是弱校验或裸数字');

  const key = patch.header['Idempotency-Key'];
  assert.match(key, /^ocr-correct-[0-9]+-[a-z0-9]+$/, '幂等键须带前缀，便于排查重复提交');
  assert.ok(key.length >= 8 && key.length <= 128, '幂等键长度须在 8..128 之间，实际 ' + key.length);

  assert.deepEqual(Object.keys(patch.data), ['corrected_fields'], '请求体只允许出现 corrected_fields');
  assert.deepEqual(
    Object.keys(patch.data.corrected_fields),
    ['registration_number', 'name', 'ingredients', 'dosage_form'],
    'corrected_fields 必须是服务端闭集四键'
  );
  assert.equal(patch.data.corrected_fields.name, '替身示例草甘膦水剂');
  assert.equal(patch.data.raw_fields, undefined, '原始读数不得回传（服务端只接受 corrected_fields）');
  assert.equal(patch.data.revision, undefined, '版本只能走 If-Match，不得塞进请求体');

  patch.success({
    statusCode: 200,
    header: { ETag: '"4"' },
    data: envelope(ocrValue({ revision: 4, corrected_fields: { name: '改动后药名' } }))
  });
  const result = await pending;
  assert.equal(result.ocr.revision, 4);
  assert.equal(result.etag, '"4"');
  assert.equal(h.requests.length, 1, '成功路径不得自动重发');

  // 第二次提交必须是新的幂等键（不得复用上一次的键，否则服务端会当成重放）。
  const second = h.identify.correctOcrLabel(OCR_ID, 4, draft);
  assert.equal(h.requests.length, 2);
  assert.notEqual(h.requests[1].header['Idempotency-Key'], key);
  assert.equal(h.requests[1].header['If-Match'], '"4"');
  h.requests[1].success({ statusCode: 200, data: envelope(ocrValue({ revision: 5 })) });
  await second;
  assert.equal(h.requests.length, 2);
});

test('校正输入在本地被拒绝时零请求：超长不裁剪、空串归 null、空成分行被丢弃、不 trim', async () => {
  const h = harness();
  await h.seedSession();

  const normalized = h.identify.buildCorrectionInput({
    registration_number: '  PD20210001 ',
    name: '',
    dosage_form: null,
    ingredients: [
      { name: 'a', content_text: '1', unit_text: '%' },
      { name: '', content_text: '', unit_text: '' }
    ]
  });
  assert.equal(normalized.registration_number, '  PD20210001 ', '本页不得替用户 trim 字段内容');
  assert.equal(normalized.name, null, '空串必须是 null，而不是补造内容');
  assert.equal(normalized.ingredients.length, 1, '整行全空的成分必须被丢弃');

  await assert.rejects(
    h.identify.correctOcrLabel(OCR_ID, 3, { name: 'x'.repeat(81) }),
    error => error.code === 'INVALID_INPUT' && error.reason === 'TOO_LONG' && error.length === 81,
    '超长字段必须在本地被拒绝'
  );
  assert.equal(h.requests.length, 0, '超长字段被拒绝时不得发出任何请求（更不得截断后提交）');

  await assert.rejects(h.identify.correctOcrLabel('not-a-uuid', 3, {}), error => error.code === 'INVALID_INPUT');
  await assert.rejects(h.identify.correctOcrLabel(OCR_ID, 0, {}), error => error.code === 'INVALID_INPUT');
  assert.equal(h.requests.length, 0, '非法记录 id / 版本同样零请求');
});

test('成功态：PATCH 一次，raw 与 corrected 同时呈现且差异可辨', async () => {
  const h = harness();
  await h.seedSession();
  const page = await readyPage(h, { revision: 3 });

  let record = page.data.ocr.record;
  assert.equal(record.revision, 3);
  assert.equal(record.canCorrect, true);
  assert.equal(record.correctedDiffers, false);
  assert.match(record.authorityNote, /不是权威判读/);
  assert.match(record.readOnlyNote, /只读/);

  page.onStartCorrection();
  const panel = page.data.labelCorrection;
  assert.equal(panel.open, true);
  assert.equal(panel.revision, 3);
  assert.equal(panel.confirmed, true, '登记已匹配时无需额外勾选即可提交');
  assert.equal(panel.fields.map(row => row.key).join(','), 'registration_number,name,dosage_form');
  assert.equal(panel.ingredients.length, 1);

  page.onCorrectionFieldInput({ currentTarget: { dataset: { index: 1 } }, detail: { value: '改动后药名' } });
  const submit = page.onCorrectionSubmit();
  await waitFor(h, 2);

  const patch = h.requests[1];
  assert.equal(patch.method, 'PATCH');
  assert.equal(patch.header['If-Match'], '"3"');
  assert.deepEqual(Object.keys(patch.data), ['corrected_fields']);
  assert.equal(patch.data.corrected_fields.name, '改动后药名');
  assert.equal(patch.data.corrected_fields.registration_number, 'PD20210001', '未改动的字段原样提交');

  patch.success({
    statusCode: 200,
    header: { ETag: '"4"' },
    data: envelope(ocrValue({ revision: 4, corrected_fields: { name: '改动后药名' } }))
  });
  await submit;

  record = page.data.ocr.record;
  assert.equal(record.revision, 4);
  assert.equal(record.correctedDiffers, true);
  const nameRow = record.diffRows[1];
  assert.equal(nameRow.changed, true);
  assert.equal(nameRow.raw, '替身示例草甘膦水剂', '机器原始读数不得被这次提交改写');
  assert.equal(nameRow.corrected, '改动后药名');
  assert.equal(record.fields.name, '改动后药名');
  assert.match(page.data.labelCorrection.successText, /已提交更正（记录版本 4）/);
  assert.match(page.data.labelCorrection.successText, /不代表识别准确/);
  assert.equal(page.data.labelCorrection.submitting, false);
  assert.equal(h.requests.length, 2, '整个成功路径只有一次 GET + 一次 PATCH');
});

test('负例①：超长字段被拒绝并说明原因，不裁剪、不提交', async () => {
  const h = harness();
  await h.seedSession();
  const page = await readyPage(h, { revision: 3 });
  page.onStartCorrection();
  const used = h.requests.length;

  page.onCorrectionFieldInput({ currentTarget: { dataset: { index: 1 } }, detail: { value: 'x'.repeat(81) } });
  await page.onCorrectionSubmit();

  assert.equal(h.requests.length, used, '超长字段不得触发任何 PATCH');
  assert.match(page.data.labelCorrection.errorText, /超长/);
  assert.match(page.data.labelCorrection.errorText, /81/);
  assert.match(page.data.labelCorrection.errorText, /不会替你截断/);
  assert.equal(page.data.ocr.record.revision, 3, '记录版本不得被本地失败提交推进');
  assert.equal(page.data.labelCorrection.submitting, false, '失败后必须回到可再次编辑的状态');
});

test('负例②：REVISION_CONFLICT 只重读一次并强制再确认，绝不静默重发', async () => {
  const h = harness();
  await h.seedSession();
  const page = await readyPage(h, { revision: 3 });
  page.onStartCorrection();
  page.onCorrectionFieldInput({ currentTarget: { dataset: { index: 1 } }, detail: { value: '改动后药名' } });

  const submit = page.onCorrectionSubmit();
  await waitFor(h, 2);
  h.requests[1].success({
    statusCode: 409,
    data: { error: { code: 'REVISION_CONFLICT', message: 'synthetic', retryable: false } }
  });
  await waitFor(h, 3);

  assert.equal(h.requests.length, 3);
  assert.equal(h.requests[2].method, 'GET', '冲突后只能重新读取最新内容');
  assert.equal(h.requests[2].url, API_BASE + '/ocr/' + OCR_ID);

  h.requests[2].success({ statusCode: 200, data: envelope(ocrValue({ revision: 9 })) });
  await submit;

  assert.equal(h.requests.length, 3, '冲突后不得自动重发 PATCH');
  assert.equal(page.data.labelCorrection.confirmed, false, '重读后必须请用户重新确认');
  assert.equal(page.data.labelCorrection.revision, 9, '草稿基线必须换成最新版本');
  assert.match(page.data.labelCorrection.conflictText, /已重新读取最新内容（记录版本 9）/);
  assert.match(page.data.labelCorrection.conflictText, /不会自动重发/);
  assert.equal(page.data.ocr.record.revision, 9);

  const after = h.requests.length;
  await page.onCorrectionSubmit();
  assert.equal(h.requests.length, after, '未重新确认前再次提交必须零请求');

  page.onCorrectionToggleConfirm();
  assert.equal(page.data.labelCorrection.confirmed, true);
});

test('负例③：ambiguous / 同名不同制剂时阻断用量并显式选择，未确认零请求', async () => {
  const h = harness();
  await h.seedSession();
  const page = await readyPage(h, {
    revision: 2,
    verification: {
      match_state: 'ambiguous',
      registration: null,
      conflict_fields: ['name', 'dosage_form'],
      missing_fields: [],
      dose_cards: []
    }
  });

  const record = page.data.ocr.record;
  assert.equal(record.needsExplicitReview, true);
  assert.equal(record.doseBlocked, true);
  assert.match(record.doseBlockReason, /用量展示已阻断/);
  assert.equal(record.doseCardCount, 0);

  page.onStartCorrection();
  assert.equal(page.data.labelCorrection.confirmed, false, '存在多条可能匹配时默认不确认');
  assert.match(page.data.labelCorrection.blockedNote, /用量展示已阻断/);

  const used = h.requests.length;
  await page.onCorrectionSubmit();
  assert.equal(h.requests.length, used, '未显式选择前不得提交');
  assert.match(page.data.labelCorrection.errorText, /勾选/);
  assert.match(page.data.labelCorrection.errorText, /不会自动重发/);

  page.onCorrectionToggleConfirm();
  assert.equal(page.data.labelCorrection.confirmed, true);

  const submit = page.onCorrectionSubmit();
  await waitFor(h, used + 1);
  const patch = h.requests[h.requests.length - 1];
  assert.equal(patch.method, 'PATCH');
  assert.equal(patch.header['If-Match'], '"2"', 'If-Match 必须取最新读到的版本');
  patch.success({ statusCode: 200, header: { ETag: '"3"' }, data: envelope(ocrValue({ revision: 3 })) });
  await submit;
  assert.ok(page.data.labelCorrection.successText.length > 0);
  assert.equal(page.data.ocr.record.revision, 3);
});

test('模板与源码接线：校正面板可点、差异行同时给出 raw/corrected、提交点唯一', () => {
  const wxml = readFileSync(join(root, 'miniprogram/pages/identify/identify.wxml'), 'utf8');
  assert.ok(/bindtap="onStartCorrection"/.test(wxml), '页面须有进入核对的入口');
  assert.ok(/bindtap="onCorrectionSubmit"/.test(wxml), '页面须有提交更正的按钮');
  assert.ok(/bindtap="onCorrectionToggleConfirm"/.test(wxml), '页面须有显式核对开关');
  assert.ok(/ocr\.record\.diffRows/.test(wxml), '差异行须逐项渲染');
  assert.ok(/labelCorrection\.conflictText/.test(wxml), '冲突提示须在页面上可见');
  assert.ok(/labelCorrection\.errorText/.test(wxml), '本地拒绝原因须在页面上可见');
  assert.ok(/机器读数 · 非权威判读 · 不提供用量/.test(wxml), '机器读数、非权威判读的文案不得丢');
  assert.equal(/dose_cards/.test(wxml), false, '页面不得引用用量字段名');

  const source = readFileSync(join(root, 'miniprogram/pages/identify/identify.js'), 'utf8');
  assert.equal(source.split('correctOcrLabel').length - 1, 1, '提交点必须唯一（恰好一处调用）');
  assert.ok(/不会自动重发更正/.test(source));
  assert.ok(/raw_fields/.test(source) && /corrected_fields/.test(source), '原始读数与更正字段须分别呈现');

  const api = readFileSync(join(root, 'miniprogram/utils/identify-api.js'), 'utf8');
  assert.ok(/'If-Match'/.test(api), '客户端须显式发 If-Match');
  assert.ok(/'Idempotency-Key'/.test(api), '客户端须显式发 Idempotency-Key');
  assert.ok(/corrected_fields: correctedFields/.test(api), '请求体只能包 corrected_fields');
});
