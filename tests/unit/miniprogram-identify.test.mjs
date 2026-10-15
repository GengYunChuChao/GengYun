// GY-I09 小程序侧回归：七类 JobState 的呈现分支 + 打包白名单同步 + 页面生命周期状态写入。
//
// 断言策略：先判 typeof 再判值；对「不得当成识别成功」的情形逐条反向断言（negative control）。
// 不依赖微信运行时：这里用最小 Page/wx 替身加载**仓库里的真实页面源码**。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, join, dirname } from 'node:path';
import { runInNewContext } from 'node:vm';

const root = resolve(import.meta.dirname, '..', '..');
const require = createRequire(import.meta.url);

// —— 加载真实小程序模块：仓库源码（非隔离副本） ——
const identifyApi = require(join(root, 'miniprogram/utils/identify-api.js'));

let captured = null;
globalThis.Page = options => { captured = options; };
globalThis.App = () => {};
globalThis.getApp = () => ({ globalData: { fontScale: 1 } });
const storage = new Map();
globalThis.wx = {
  getStorageSync: key => (storage.has(key) ? storage.get(key) : ''),
  setStorageSync: (key, value) => { storage.set(key, value); },
  removeStorageSync: key => { storage.delete(key); },
  showToast: () => {},
  showModal: () => {},
  request: () => {},
  // 切片 A：关联资料条目跳详情页（由测试内替换以便断言 URL，见文末用例）。
  navigateTo: () => {},
  chooseMedia: () => {},
  getFileInfo: () => {},
  getFileSystemManager: () => ({ readFile: () => {} })
};
require(join(root, 'miniprogram/pages/identify/identify.js'));
assert.ok(captured !== null && typeof captured === 'object', '识别页未注册 Page');

const STATES = ['queued', 'running', 'succeeded', 'uncertain', 'failed', 'timed_out', 'cancelled'];
const TERMINAL = ['succeeded', 'uncertain', 'failed', 'timed_out', 'cancelled'];

function instance() {
  const page = Object.assign({}, captured);
  page.data = JSON.parse(JSON.stringify(captured.data));
  page.setData = function (patch) { Object.assign(this.data, patch); };
  page._pollTimer = null;
  page._generation = 0;
  return page;
}

function jobOf(state, result) {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    revision: state === 'queued' ? 1 : state === 'running' ? 2 : 3,
    state: state,
    target_ref: { type: 'recognition', id: '66666666-6666-4666-8666-666666666666', revision: 1 },
    deadline_at: '2026-10-11T10:00:00.000Z',
    created_at: '2026-10-11T09:59:30.000Z',
    error_code: state === 'failed' ? 'PROVIDER_QUOTA_EXCEEDED' : state === 'timed_out' ? 'PROVIDER_TIMEOUT' : null,
    result: result === undefined ? null : result
  };
}

const RECOGNITION = {
  id: '66666666-6666-4666-8666-666666666666',
  revision: 1,
  candidates: [
    { species_id: 'species_barnyardgrass', rank: 1, model_score: 0.81 },
    { species_id: 'species_foxtail', rank: 2, model_score: 0.33 }
  ],
  uncertainty_reasons: [],
  selected_species_id: null,
  model_version: 'stub-v1'
};

test('GY-I09 小程序：七类 JobState 各自一句、互不相同，且只有 succeeded 算成功', () => {
  assert.deepEqual(identifyApi.JOB_STATES.slice().sort(), STATES.slice().sort());
  const titles = [];
  for (const state of STATES) {
    const view = identifyApi.describeJobState(state);
    assert.equal(typeof view.title, 'string');
    assert.ok(view.title.length > 0, state + ' 缺少标题');
    assert.equal(typeof view.desc, 'string');
    assert.ok(view.desc.length > 0, state + ' 缺少说明');
    assert.equal(view.state, state);
    assert.equal(typeof view.terminal, 'boolean');
    assert.equal(typeof view.success, 'boolean');
    assert.equal(view.success, state === 'succeeded', state + ' 的 success 必须且只能是 succeeded');
    assert.equal(view.terminal, TERMINAL.indexOf(state) !== -1, state + ' 的 terminal 判定错误');
    titles.push(view.title);
  }
  assert.equal(new Set(titles).size, STATES.length, '七类状态必须各有独立呈现文案（不得合并成一句）');
  assert.throws(() => identifyApi.describeJobState('unknown_state'), e => e.code === 'INVALID_RESPONSE');
  assert.throws(() => identifyApi.describeJobState(undefined), e => e.code === 'INVALID_RESPONSE');
  assert.deepEqual(identifyApi.terminalStates().slice().sort(), TERMINAL.slice().sort());
});

test('GY-I09 小程序：视图模型对每个状态给出「是否可当成功 / 是否可进科普路径」', () => {
  for (const state of STATES) {
    const withResult = state === 'succeeded' || state === 'uncertain' ? RECOGNITION : null;
    const model = identifyApi.viewModelForJob(jobOf(state, withResult));
    assert.equal(model.state, state);
    assert.equal(typeof model.showTop3, 'boolean');
    assert.equal(typeof model.candidatesTrusted, 'boolean');
    assert.equal(typeof model.allowReferenceQuery, 'boolean');
    assert.equal(model.candidatesTrusted, state === 'succeeded', state + '：只有 succeeded 的候选可信');
    assert.equal(model.allowReferenceQuery, state === 'succeeded', state + '：只有 succeeded 可进关联科普路径');
    if (state === 'succeeded' || state === 'uncertain') {
      assert.equal(model.showTop3, true);
      assert.equal(model.candidates.length, 2);
      assert.deepEqual(model.candidates.map(c => c.scoreText), ['81%', '33%']);
    } else {
      assert.equal(model.showTop3, false, state + '：不得显示 Top3');
      assert.deepEqual(model.candidates, []);
      assert.deepEqual(model.reasons, []);
    }
  }
  // 无分数候选：文案不得写成百分比，也不得被当成可信。
  const nullScored = identifyApi.viewModelForJob(jobOf('uncertain', Object.assign({}, RECOGNITION, {
    candidates: [{ species_id: 'species_foxtail', rank: 1, model_score: null }], uncertainty_reasons: ['无可信分数']
  })));
  assert.equal(nullScored.candidates[0].scoreText, '无分数');
  assert.equal(nullScored.candidatesTrusted, false);
  assert.equal(nullScored.allowReferenceQuery, false);
  assert.deepEqual(nullScored.reasons, ['无可信分数']);
});

test('GY-I09 小程序：页面 applyJob 逐类写入正确的展示状态（不得把非成功当成功）', () => {
  for (const state of STATES) {
    const page = instance();
    const withResult = state === 'succeeded' || state === 'uncertain' ? RECOGNITION : null;
    page.applyJob(jobOf(state, withResult));
    assert.equal(page.data.stateView.state, state, state + '：状态未如实写入');
    assert.equal(page.data.candidatesTrusted, state === 'succeeded', state + '：候选可信标记错误');
    assert.equal(page.data.showTop3, state === 'succeeded' || state === 'uncertain', state + '：Top3 显示判定错误');
    assert.equal(page.data.busy, TERMINAL.indexOf(state) === -1, state + '：busy 判定错误');
    if (state === 'failed' || state === 'timed_out' || state === 'cancelled') {
      assert.deepEqual(page.data.candidates, [], state + '：非候选状态不得渲染候选');
    }
  }
  // 轮询停止：终态后不得再有定时器。
  const page = instance();
  page.applyJob(jobOf('failed', null));
  assert.equal(page._pollTimer, null, '终态后必须停止轮询');
  // 重试清空展示，不残留上一条结果。
  page.onRetry();
  assert.equal(page.data.stateView, null);
  assert.deepEqual(page.data.candidates, []);
  assert.equal(page.data.recordId, null);
  // 纯函数：未知状态不得被页面当成成功渲染（fail-closed）。
  const fresh = instance();
  assert.throws(() => fresh.applyJob(jobOf('nonsense', null)), e => e.code === 'INVALID_RESPONSE');
});

test('GY-I09 小程序：打包白名单必须包含识别页依赖（既往 MODULE_NOT_FOUND 返修点）', () => {
  const prepare = readFileSync(join(root, 'tools/prepare-wechat.mjs'), 'utf8');
  assert.ok(prepare.indexOf("'utils/identify-api.js'") !== -1, 'tools/prepare-wechat.mjs 允许清单缺少 utils/identify-api.js');
  assert.ok(existsSync(join(root, 'miniprogram/utils/identify-api.js')));
  assert.ok(existsSync(join(root, 'miniprogram/pages/identify/identify.wxml')));
  assert.ok(existsSync(join(root, 'miniprogram/pages/identify/identify.wxss')));
  // 识别页引用的模块必须都在白名单里（否则标准包会 MODULE_NOT_FOUND）。
  const page = readFileSync(join(root, 'miniprogram/pages/identify/identify.js'), 'utf8');
  const required = [...page.matchAll(/require\('(\.\.\/\.\.\/[^']+)'\)/g)].map(m => m[1].replace('../../', '') + '.js');
  assert.ok(required.length >= 4);
  for (const dep of required) {
    assert.ok(prepare.indexOf("'" + dep + "'") !== -1, '白名单缺少依赖 ' + dep);
  }
  // 页面不得在缺网络时伪造识别结果：源码中不存在「本地兜底候选」这种写法。
  assert.equal(/fallbackCandidates|fakeResult|MOCK_RESULT/.test(page), false);
  // 既有独立播放入口与「无录音时禁用」的交互必须保留（ui-adaptive.test.mjs 的既有验收）。
  const wxml = readFileSync(join(root, 'miniprogram/pages/identify/identify.wxml'), 'utf8');
  assert.ok(/bindtap="onRecord"/.test(wxml), '缺少独立录音按钮');
  assert.ok(/bindtap="onPlay"/.test(wxml), '缺少独立播放按钮');
  assert.ok(/disabled="\{\{guest \|\| !hasRecording\}\}"/.test(wxml), '播放按钮未在无录音时禁用');
  assert.equal(/getRecorderManager|createInnerAudioContext/.test(readFileSync(join(root, 'miniprogram/pages/identify/identify.js'), 'utf8')), false);
  // 历史区必须绑定「当前已核实主体」，不能只凭本机索引长度。
  assert.ok(/historyOwner/.test(wxml), '历史区未绑定已核实主体（historyOwner）');
  assert.ok(!/wx:if="\{\{history\.length\}\}"/.test(wxml), '历史区不得只凭 history.length 展示');
});

// ---------------------------------------------------------------------------
// GY-I16（#16）切片 C：识别页历史区的**如实说明 + 服务端识别历史入口**。
//
// 本机索引仍然只在进程内（上面的 fail-closed 论证不得放宽）：因此页面必须**如实**说明它只在本次
// 打开期间有效，并给出一条到服务端历史的入口（`/pages/history/history`，与「我的 → 识别历史」
// 同一个页面，不另造第二套历史面）。服务端那一侧的写入点见 `tests/unit/history-http.test.mjs`。
// ---------------------------------------------------------------------------
test('GY-I16 小程序：识别页历史区如实说明「仅本次打开期间有效」并给出服务端识别历史入口', () => {
  const wxml = readFileSync(join(root, 'miniprogram/pages/identify/identify.wxml'), 'utf8');
  assert.ok(/本机索引仅在本次打开期间有效/.test(wxml), '历史区缺「仅本次打开期间有效」的如实说明');
  assert.ok(/跨启动请看/.test(wxml) && /识别历史/.test(wxml), '如实说明未指向「我的 → 识别历史」');
  assert.ok(/bindtap="onOpenServerHistory"/.test(wxml), '历史区缺服务端识别历史入口');
  // 入口与「我的 → 识别历史」必须是**同一个**页面（同一路由，不复制一套历史面）。
  const profile = readFileSync(join(root, 'miniprogram/pages/profile/profile.js'), 'utf8');
  assert.ok(/navigateTo\(\{ url: '\/pages\/history\/history' \}\)/.test(profile), '「我的 → 识别历史」入口路由变了');
  assert.ok(
    /navigateTo\(\{ url: '\/pages\/history\/history' \}\)/.test(readFileSync(join(root, 'miniprogram/pages/identify/identify.js'), 'utf8')),
    '识别页的服务端历史入口未指向 /pages/history/history',
  );
  // 本机索引的 fail-closed 论证不得被本片放宽：仍然不落 wx storage、仍然按已核实主体过滤。
  const page = readFileSync(join(root, 'miniprogram/pages/identify/identify.js'), 'utf8');
  assert.equal(/setStorageSync\(/.test(page), false, '本机历史索引不得写入 wx storage（fail-closed 论证）');
  assert.ok(/historyOwner/.test(wxml), '历史区仍未绑定已核实主体（historyOwner）');
  assert.ok(!/wx:if="\{\{history\.length\}\}"/.test(wxml), '历史区不得只凭 history.length 展示');

  // 行为面：点击该入口确实导航到服务端历史页（在最小沙箱里加载**真实**页面源码驱动）。
  const box = lifecycle();
  const instance = box.page();
  instance.data.guest = false;
  instance.onOpenServerHistory();
  assert.deepEqual(box.launches, ['/pages/history/history'], '历史入口未导航到 /pages/history/history');
  instance.data.guest = true;
  instance.onOpenServerHistory();
  assert.equal(box.launches.length, 1, '未登录（guest）时不得发起导航');
});

// ---------------------------------------------------------------------------
// 生命周期回归（监工 5485989704 [B]/[C]）：用最小 vm 沙箱加载真实页面与真实 auth 模块，
// 手动解析 wx.request，以复现「门禁未核实/失效仍展示私有数据」与「在途响应淘汰」两个实际反例。
// 合成身份与合成响应，绝不外发；不作为微信工具或真机证据。
// ---------------------------------------------------------------------------
const JOB_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RECORD_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REQUEST_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MEDIA_ID = '99999999-9999-4999-8999-999999999999';
/** 合成 sha256（64 位十六进制）：满足契约 pattern，不代表任何真实照片的摘要。 */
const SYNTHETIC_SHA256 = 'a'.repeat(64);
/** 契约识别图用途上限：2 MiB（`packages/media/constants.mjs` MEDIA_PURPOSE_MAX_BYTES.weed_recognition）。 */
const RECOGNITION_MAX_BYTES = 2 * 1024 * 1024;

function lifecycle(sharedStorage, options) {
  // 传入共享 storage 可模拟「同一份本地存储 + 两个独立启动（新 VM、新模块实例）」。
  const storage = sharedStorage instanceof Map ? sharedStorage : new Map();
  const requests = [];
  const launches = [];
  // GY-I10：选图请求（`wx.chooseMedia` 的 options）按调用顺序入列，由用例决定"选了什么图 / 取消"。
  const media = [];
  const cache = new Map();
  const opts = options || {};
  const fileInfo = typeof opts.fileInfo === 'function' ? opts.fileInfo : null;
  const expires = () => new Date(Date.now() + 3600_000).toISOString();
  let definition = null;
  const context = {
    wx: {
      getStorageSync: key => (storage.has(key) ? storage.get(key) : ''),
      setStorageSync: (key, value) => { storage.set(key, value); },
      removeStorageSync: key => { storage.delete(key); },
      getStorageInfoSync: () => ({ keys: Array.from(storage.keys()), currentSize: 0, limitSize: 10240 }),
      request: options => requests.push(options),
      reLaunch: options => launches.push(options.url),
      switchTab: options => launches.push(options.url),
      navigateTo: options => launches.push(options.url),
      showToast: () => {},
      showModal: options => { if (options && typeof options.success === 'function') options.success({ confirm: true }); },
      // 本片（GY-I10）追加：选图请求按调用顺序入列，由用例决定"选了什么图 / 取消"。
      chooseMedia: options => media.push(options),
      getFileInfo: fileInfo === null
        ? () => {}
        : request => {
            const info = fileInfo(request);
            if (info === null || info === undefined) { if (typeof request.fail === 'function') request.fail({}); return; }
            request.success(info);
          },
      getFileSystemManager: () => ({
        readFile: request => {
          if (fileInfo === null) return;
          // 句柄 PUT 用**合成字节**（不是真实照片）：只为走通链路形状，不伪造任何识别结果。
          request.success({ data: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]) });
        }
      })
    },
    getApp: () => ({ globalData: { fontScale: 1 } }),
    App: () => {},
    Page: value => { definition = value; },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
  };
  function load(path) {
    path = resolve(path);
    if (path.endsWith('config\\runtime.js') || path.endsWith('config/runtime.js')) {
      return { mode: 'local', apiBaseUrl: 'https://synthetic.invalid/api/v1' };
    }
    if (cache.has(path)) return cache.get(path).exports;
    const module = { exports: {} };
    cache.set(path, module);
    const wrapper = runInNewContext('(function(require,module,exports){' + readFileSync(path, 'utf8') + '\n})', context, { filename: path });
    wrapper(relative => load(resolve(dirname(path), relative + '.js')), module, module.exports);
    return module.exports;
  }
  const auth = load(resolve(root, 'miniprogram/utils/auth.js'));
  const identify = load(resolve(root, 'miniprogram/utils/identify-api.js'));
  const identifyPage = load(resolve(root, 'miniprogram/pages/identify/identify.js'));
  void identify;
  void identifyPage;
  assert.ok(definition !== null && typeof definition === 'object', '沙箱内识别页未注册 Page');
  const pageDefinition = definition;
  /** 每个用例一份独立页面实例（复制注册定义，不共享 data）。 */
  function page() {
    const instance = Object.assign({}, pageDefinition);
    instance.data = JSON.parse(JSON.stringify(pageDefinition.data));
    instance.setData = function (patch) { Object.assign(this.data, patch); };
    instance._pollTimer = null;
    // onLoad 会置位本字段；直接构造实例时（不经 onLoad）必须同样就位，
    // 否则 beginOperation/isCurrentOperation 的世代比对恒不成立（页面方法会静默早退）。
    instance._generation = 0;
    return instance;
  }
  function seedSession(accessToken) {
    storage.set('gengyun.session', {
      accessToken: typeof accessToken === 'string' && accessToken !== '' ? accessToken : 'synthetic-identify-token',
      audience: 'user',
      expiresAt: expires(),
      executionMode: 'stub'
    });
  }
  function acceptVerification(request, executionMode) {
    const mode = typeof executionMode === 'string' && executionMode !== '' ? executionMode : (opts.mode || 'stub');
    request.success({ statusCode: 200, data: { data: { audience: 'user', expires_at: expires() }, meta: { request_id: REQUEST_ID, contract_version: '1.0.0', execution_mode: mode } } });
  }
  return { storage, requests, launches, media, auth, page, seedSession, acceptVerification, load, mode: opts.mode || 'stub' };
}

function recognitionValue(overrides) {
  return Object.assign({
    id: RECORD_ID,
    revision: 1,
    candidates: [
      { species_id: 'species_barnyardgrass', rank: 1, model_score: 0.81 },
      { species_id: 'species_foxtail', rank: 2, model_score: 0.33 }
    ],
    uncertainty_reasons: [],
    selected_species_id: null,
    model_version: 'stub-v1'
  }, overrides || {});
}

function jobEnvelope(state, result, ids) {
  const jobId = ids && ids.job ? ids.job : JOB_ID;
  const recordId = ids && ids.rec ? ids.rec : RECORD_ID;
  return {
    data: {
      id: jobId,
      revision: state === 'queued' ? 1 : 3,
      kind: 'recognition',
      target_ref: { type: 'recognition', id: recordId, revision: 1 },
      state: state,
      deadline_at: '2026-10-11T10:00:00.000Z',
      created_at: '2026-10-11T09:59:30.000Z',
      error_code: null,
      result: result === undefined ? null : { kind: 'recognition', value: result }
    },
    meta: { request_id: REQUEST_ID, contract_version: '1.0.0', execution_mode: 'stub' }
  };
}

/** 页面 applyJob 接收的是 identify-api **校验后**的 Job（result 已展开为 Recognition 本身）。 */
function validatedJob(state, result, ids) {
  const envelope = jobEnvelope(state, result, ids);
  return Object.assign({}, envelope.data, {
    result: envelope.data.result === null ? null : envelope.data.result.value
  });
}

/** A 主体专用的合成 id（用于验证 B 看不到 A 的条目）。 */
const A_JOB_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const A_RECORD_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

/** 本地存储里残留的历史缓存键（旧全局键 + v2.* 命名空间键）；正常应为空。 */
function historyKeysIn(storage) {
  return Array.from(storage.keys()).filter(function (key) {
    return typeof key === 'string' && key.indexOf('gengyun.identify.history') === 0;
  });
}

test('GY-I09 [B1]：无会话时不得读取/展示任何全局私有识别数据（门禁核实前）', () => {
  const h = lifecycle();
  // 注入一条合成本地旧历史（模拟同设备遗留数据），但**没有**任何会话。
  h.storage.set('gengyun.identify.history', [{ jobId: JOB_ID, recordId: RECORD_ID, state: 'succeeded', stateTitle: '识别完成', selectedSpeciesId: null, at: '2026-10-11T09:00:00.000Z' }]);
  const page = h.page();
  page.onLoad();
  assert.equal(page.data.history.length, 0, '门禁核实前不得装载全局私有历史');
  page.onShow();
  assert.equal(h.auth.isLoggedIn(), false);
  assert.equal(page.data.guest, true);
  assert.equal(page.data.historyOwner, '', '未核实时不得有已核实主体标识');
  assert.equal(page.data.history.length, 0, '门禁未通过时历史必须为空');
  assert.equal(page.data.candidates.length, 0);
  assert.equal(page.data.recordId, null);
  // 无法证明归属的历史遗留全局缓存必须丢弃（fail-closed），而不是"沿用展示"。
  assert.equal(h.storage.has('gengyun.identify.history'), false, '旧全局缓存必须被丢弃');
});

test('GY-I09 [B2]：核实后取得候选/历史，会话被清 → onHide/onShow 必须清空私有展示', () => {
  const h = lifecycle();
  h.seedSession();
  const page = h.page();
  page.onLoad();
  page.onShow();
  h.acceptVerification(h.requests.at(-1));
  assert.equal(page.data.guest, false);
  assert.notEqual(page.data.historyOwner, '');
  // 取得候选与历史（走真实页面方法）。
  const job = validatedJob('succeeded', recognitionValue());
  page.applyJob(job, page._generation);
  page.rememberHistory(job, job.result, page._generation);
  assert.equal(page.data.candidates.length, 2);
  assert.equal(page.data.recordId, RECORD_ID);
  assert.equal(page.data.history.length, 1);
  // 会话被清除 + 重新进入页面。
  h.auth.clearSession();
  page.onHide();
  assert.equal(page.data.guest, true, 'onHide 后必须关闭门禁');
  assert.equal(page.data.candidates.length, 0, 'onHide 必须清空候选');
  assert.equal(page.data.recordId, null, 'onHide 必须清空 recordId');
  assert.equal(page.data.history.length, 0, 'onHide 必须清空私有历史展示');
  page.onShow();
  assert.equal(page.data.guest, true);
  assert.equal(page.data.candidates.length, 0);
  assert.equal(page.data.recordId, null);
  assert.equal(page.data.job, null);
  assert.equal(page.data.history.length, 0);
  assert.equal(page.data.historyOwner, '');
});

test('GY-I09 [B3]：在途 GET /jobs 被服务端 401 拒绝（会话清除）→ 必须关闭门禁并清空展示', async () => {
  const h = lifecycle();
  h.seedSession();
  const page = h.page();
  page.onLoad();
  page.onShow();
  h.acceptVerification(h.requests.at(-1));
  assert.equal(page.data.guest, false);
  const job = validatedJob('succeeded', recognitionValue());
  page.applyJob(job, page._generation);
  page.rememberHistory(job, job.result, page._generation);
  assert.equal(page.data.candidates.length, 2);
  const before = h.requests.length;
  const gen = page._generation;
  const pending = page.refreshJob(gen);
  assert.equal(h.requests.length, before + 1, 'refreshJob 必须发出一次 GET /jobs');
  // 服务端 401 + 契约错误封套：identify-api 会清会话并以 SESSION_REQUIRED 拒绝。
  h.requests.at(-1).success({ statusCode: 401, data: { error: { code: 'SESSION_REQUIRED', message: '需要用户会话', retryable: false, details: [] } } });
  await pending;
  assert.equal(page.data.guest, true, '401 后必须关闭门禁，不能只留提示');
  assert.equal(page.data.candidates.length, 0, '401 后必须清空候选');
  assert.equal(page.data.recordId, null);
  assert.equal(page.data.job, null);
  assert.equal(page.data.history.length, 0);
  assert.equal(page.data.historyOwner, '');
});

test('GY-I09 [C]：隐藏/重试后在途合法 succeeded 响应必须被淘汰（不得恢复展示、不得写历史）', async () => {
  const h = lifecycle();
  h.seedSession();
  const page = h.page();
  page.onLoad();
  page.onShow();
  h.acceptVerification(h.requests.at(-1));
  assert.equal(page.data.guest, false);
  const queued = validatedJob('queued', null);
  page.applyJob(queued, page._generation);
  const gen = page._generation;
  const pending = page.refreshJob(gen);
  assert.equal(h.requests.length, 2);
  // 页面离开 + 重试（两者都必须递增代次）。
  page.onHide();
  page.onRetry();
  assert.equal(page.data.job, null);
  // 迟到的合法 200 succeeded 封套：必须被丢弃。
  h.requests.at(-1).success({ statusCode: 200, data: jobEnvelope('succeeded', recognitionValue()) });
  await pending;
  assert.equal(page.data.job, null, '离页/重试后的旧响应不得恢复展示');
  assert.equal(page.data.candidates.length, 0, '旧响应不得恢复候选');
  assert.equal(page.data.stateView, null);
  assert.equal(page.data.recordId, null);
  assert.equal(page.data.guest, true);
  assert.equal(h.storage.has('gengyun.identify.history'), false, '失效回调不得写入全局私有历史');
});

test('GY-I09 [C 负控制①]：当代次正常完成仍必须生效（不得把功能一起挡掉）', async () => {
  const h = lifecycle();
  h.seedSession();
  const page = h.page();
  page.onLoad();
  page.onShow();
  h.acceptVerification(h.requests.at(-1));
  const queued = validatedJob('queued', null);
  page.applyJob(queued, page._generation);
  const gen = page._generation;
  const pending = page.refreshJob(gen);
  assert.equal(h.requests.length, 2);
  // 未离页、未重试：合法 200 succeeded 必须正常生效并写历史。
  h.requests.at(-1).success({ statusCode: 200, data: jobEnvelope('succeeded', recognitionValue()) });
  await pending;
  assert.equal(page.data.guest, false);
  assert.equal(page.data.job.state, 'succeeded');
  assert.equal(page.data.stateView.state, 'succeeded');
  assert.equal(page.data.candidates.length, 2);
  assert.equal(page.data.recordId, RECORD_ID);
  assert.equal(page.data.history.length, 1, '当代次的正常完成必须写入历史');
});

test('GY-I09 [B4]：跨账号隔离 —— A 写历史后退出，装载 B 必须看不到 A 的私有历史', () => {
  const h = lifecycle();
  h.seedSession('synthetic-identify-token-A');
  const page = h.page();
  page.onLoad();
  page.onShow();
  h.acceptVerification(h.requests.at(-1));
  assert.equal(page.data.guest, false);
  const ownerA = page._ownerKey;
  assert.equal(typeof ownerA, 'string');
  assert.notEqual(ownerA, '', '核实后必须有归属键');
  // A 取得候选并写入历史（走真实页面方法）。
  const jobA = validatedJob('succeeded', recognitionValue({ id: A_RECORD_ID }), { job: A_JOB_ID, rec: A_RECORD_ID });
  page.applyJob(jobA, page._generation);
  page.rememberHistory(jobA, jobA.result, page._generation);
  assert.equal(page.data.history.length, 1);
  // 私有历史**不落 wx storage**（跨启动不可核实归属）：条目只在进程内，且自带 ownerKey。
  assert.deepEqual(historyKeysIn(h.storage), [], '私有历史不得写入本地存储');
  assert.equal(page.data.history[0].ownerKey, ownerA);
  assert.equal(page.data.history[0].recordId, A_RECORD_ID);
  // 退出 → 装载**不同主体 B**（不同令牌 ⇒ 不同会话世代/归属键）。
  page.onHide();
  h.auth.clearSession();
  h.seedSession('synthetic-identify-token-B');
  page.onShow();
  h.acceptVerification(h.requests.at(-1));
  assert.equal(page.data.guest, false, 'B 应通过核实');
  const ownerB = page._ownerKey;
  assert.equal(typeof ownerB, 'string');
  assert.notEqual(ownerB, '', 'B 核实后必须有归属键');
  assert.notEqual(ownerB, ownerA, '归属键必须随主体变化');
  assert.equal(page.data.history.length, 0, 'B 不得看到 A 的私有历史');
  const serialized = JSON.stringify(page.data);
  assert.equal(serialized.includes(A_RECORD_ID), false, 'B 的页面数据不得出现 A 的 recordId');
  assert.equal(serialized.includes(A_JOB_ID), false, 'B 的页面数据不得出现 A 的 jobId');
  assert.equal(page.data.historyOwner, ownerB);
  // 私有历史只存在于进程内（不落 wx storage）：内存里的条目不得被 B 读出。
  assert.deepEqual(historyKeysIn(h.storage), [], '私有历史不得写入本地存储');
});

test('GY-I09 [B4 正控制]：同主体离开再返回仍能读回自己的历史（不得误清）', () => {
  const h = lifecycle();
  h.seedSession('synthetic-identify-token-A');
  const page = h.page();
  page.onLoad();
  page.onShow();
  h.acceptVerification(h.requests.at(-1));
  const ownerA = page._ownerKey;
  const jobA = validatedJob('succeeded', recognitionValue());
  page.applyJob(jobA, page._generation);
  page.rememberHistory(jobA, jobA.result, page._generation);
  assert.equal(page.data.history.length, 1);
  // 同一令牌（同一主体）离开再返回并重新核实：归属键不变，历史必须仍可读。
  page.onHide();
  page.onShow();
  h.acceptVerification(h.requests.at(-1));
  assert.equal(page.data.guest, false);
  assert.equal(page._ownerKey, ownerA, '同一令牌重新核实不得改变归属键');
  assert.equal(page.data.history.length, 1, '同一主体必须仍能读取自己的历史');
  assert.equal(page.data.history[0].recordId, RECORD_ID);
  assert.equal(page.data.history[0].ownerKey, ownerA);
});

test('GY-I09 [B5]：两个独立启动共享同一本地存储 —— 重启后不得读到上一进程/旧缓存的历史', () => {
  const shared = new Map();
  // —— 启动 1：A 核实并写入一条私有历史 ——
  const h1 = lifecycle(shared);
  h1.seedSession('synthetic-identify-token-A');
  const page1 = h1.page();
  page1.onLoad();
  page1.onShow();
  h1.acceptVerification(h1.requests.at(-1));
  assert.equal(page1.data.guest, false);
  const jobA = validatedJob('succeeded', recognitionValue({ id: A_RECORD_ID }), { job: A_JOB_ID, rec: A_RECORD_ID });
  page1.applyJob(jobA, page1._generation);
  page1.rememberHistory(jobA, jobA.result, page1._generation);
  assert.equal(page1.data.history.length, 1);
  // 私有不落本地存储（跨启动不可核实归属 ⇒ 不持久化）。
  assert.deepEqual(historyKeysIn(shared), [], '启动 1 不得把私有历史写入本地存储');
  // 模拟旧版本遗留的本地历史缓存（旧全局键 + v2.* 命名空间键，归属来自旧进程的计数器）。
  const legacyEntry = { ownerKey: '0:0', jobId: A_JOB_ID, recordId: A_RECORD_ID, state: 'succeeded', stateTitle: '识别完成', selectedSpeciesId: null, at: '2026-10-12T05:00:00.000Z' };
  shared.set('gengyun.identify.history', [legacyEntry]);
  shared.set('gengyun.identify.history.v2.0:0', [legacyEntry]);
  // —— 模拟应用重启：全新 VM（新模块实例），共享同一份 wx storage，装载不同主体 B ——
  const h2 = lifecycle(shared);
  h2.seedSession('synthetic-identify-token-B');
  const page2 = h2.page();
  page2.onLoad();
  page2.onShow();
  h2.acceptVerification(h2.requests.at(-1));
  assert.equal(page2.data.guest, false, 'B 应通过核实');
  assert.equal(page2.data.history.length, 0, '重启后不得读出上一进程/旧缓存的历史');
  const serialized = JSON.stringify(page2.data);
  assert.equal(serialized.includes(A_RECORD_ID), false, '重启后不得出现 A 的 recordId');
  assert.equal(serialized.includes(A_JOB_ID), false, '重启后不得出现 A 的 jobId');
  // 清理证据：装载前必须删除无法核实归属的本地历史缓存键。
  assert.deepEqual(historyKeysIn(shared), [], '装载前必须清理无法核实归属的本地历史缓存');
});

test('GY-I09 小程序：未登录/无网络时请求直接拒绝，不发任何请求', async () => {
  const page = instance();
  let calls = 0;
  globalThis.wx.request = () => { calls += 1; };
  // 会话未建立（无 storage 会话）→ SESSION_REQUIRED，且不发起请求。
  await assert.rejects(() => identifyApi.createRecognition('11111111-1111-4111-8111-111111111111', 1), e => e.code === 'SESSION_REQUIRED');
  await assert.rejects(() => identifyApi.serverMode(), e => e.code === 'SESSION_REQUIRED');
  // GY-I10 标签 OCR：三条**既有**契约调用同样零请求（未登录一律不得外发）。
  await assert.rejects(() => identifyApi.createOcr('11111111-1111-4111-8111-111111111111', 1), e => e.code === 'SESSION_REQUIRED');
  await assert.rejects(() => identifyApi.getOcrJob('11111111-1111-4111-8111-111111111111'), e => e.code === 'SESSION_REQUIRED');
  await assert.rejects(() => identifyApi.cancelOcrJob('11111111-1111-4111-8111-111111111111', 1), e => e.code === 'SESSION_REQUIRED');
  await assert.rejects(
    () => identifyApi.uploadPrivatePhoto('/tmp/synthetic-label.jpg', { mime: 'image/jpeg', bytes: 1024, sha256: 'a'.repeat(64) }, identifyApi.OCR_MEDIA_PURPOSE),
    e => e.code === 'SESSION_REQUIRED',
  );
  assert.equal(calls, 0, '未登录时不得发起任何网络请求');
  // 页面在游客态点击入口不动作（含新接入的标签识别入口）。
  page.data.guest = true;
  page.onShoot({ currentTarget: { dataset: { mode: 'weed' } } });
  page.onShoot({ currentTarget: { dataset: { mode: 'ocr' } } });
  assert.equal(calls, 0);
});

// ---------------------------------------------------------------------------
// 切片 B：real 模式媒体失败的**如实归因** + 上传前 2 MiB 预检（解除 1-B / 1-C / 7-H）。
//
// 断言口径：①超限 ⇒ 零上传请求 + 页面可操作提示；②PROVIDER_UNAVAILABLE ⇒ 新文案，
// 且不再出现"/media 内容端点未挂载"这类与事实不符的断言；③INVALID_REQUEST ⇒ 用途限制口径；
// ④不回归：未登录/门禁拒绝仍零请求（见上文「未登录…不发任何请求」用例），正常小图逐跳行为不变。
// ---------------------------------------------------------------------------

/** 取本轮发往 `POST /media/uploads` 的请求（含创建句柄与完成上传两跳）。 */
function mediaUploadRequests(requests) {
  return requests.filter(r => typeof r.url === 'string' && r.url.includes('/media/uploads'));
}

/** 取本轮创建识别任务的请求。 */
function recognitionRequests(requests) {
  return requests.filter(r => typeof r.url === 'string' && r.url.includes('/recognitions'));
}

/**
 * 走真实门禁：seedSession → onLoad → onShow → 接受一次会话核实（与既有 B 系列同法）。
 * 未通过门禁时页面**不动作**，因此切片 B 的用例必须先过门禁再谈请求。
 *
 * 返回的 `requests` 是**动态视图**（门禁核实之后的请求），不是快照 ——
 * 否则在 prepareMedia 之后再取会漏掉新发出的请求。
 */
function gatedPage(h) {
  h.seedSession();
  const page = h.page();
  page.onLoad();
  page.onShow();
  const verification = h.requests.at(-1);
  h.acceptVerification(verification);
  assert.ok(h.requests.length >= 1, '门禁必须发出一次会话核实请求');
  const gateIndex = h.requests.indexOf(verification);
  return {
    page,
    get requests() { return h.requests.slice(gateIndex + 1); }
  };
}

test('GY-I09 切片B①：>2 MiB 照片上传前预检 ⇒ 不发任何 POST /media/uploads，且给出可操作提示', async () => {
  const oversized = RECOGNITION_MAX_BYTES + 1;
  const h = lifecycle(undefined, {
    mode: 'real',
    fileInfo: request => {
      assert.equal(request.digestAlgorithm, 'sha256', 'readFileInfo 必须按契约取 sha256 摘要');
      return { size: oversized, digest: SYNTHETIC_SHA256 };
    }
  });
  const gated = gatedPage(h);
  const page = gated.page;
  const pending = page.prepareMedia('/synthetic/tmp/oversized.jpg');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(gated.requests.length, 1, '第一次请求必须是读执行模式');
  gated.requests[0].success({
    statusCode: 200,
    data: { data: { mode: 'real' }, meta: { request_id: REQUEST_ID, contract_version: '1.0.0', execution_mode: 'real' } }
  });
  await pending;
  // 只允许发一次「读执行模式」的公开请求；**不得**发出任何上传请求、也不得建识别任务。
  assert.equal(gated.requests.length, 1, '超限时必须只发一次读模式请求，不得再有其它请求');
  assert.equal(gated.requests[0].url.endsWith('/public/home'), true, '唯一请求必须是读执行模式的 GET /public/home');
  assert.equal(gated.requests[0].method, 'GET');
  assert.deepEqual(mediaUploadRequests(gated.requests), [], '超限时不得发出任何 POST /media/uploads');
  assert.deepEqual(recognitionRequests(gated.requests), [], '超限时不得创建识别任务');
  assert.equal(page.data.busy, false, '预检拦截后必须结束忙态');
  assert.equal(typeof page.data.errorText, 'string');
  assert.ok(page.data.errorText.includes('照片过大'), '必须给出「照片过大」类可操作提示，实际：' + page.data.errorText);
  assert.ok(page.data.errorText.includes('未上传任何照片'), '提示必须如实说明本次未上传，实际：' + page.data.errorText);
});

test('GY-I09 切片B①负控制：恰为 2 MiB 的照片必须放行走到上传（不得连带挡掉合规照片）', async () => {
  const h = lifecycle(undefined, {
    mode: 'real',
    fileInfo: () => ({ size: RECOGNITION_MAX_BYTES, digest: SYNTHETIC_SHA256 })
  });
  const gated = gatedPage(h);
  const page = gated.page;
  const pending = page.prepareMedia('/synthetic/tmp/exactly-2mib.jpg');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(gated.requests.length, 1, '合规尺寸必须继续走到上传（读模式请求）');
  gated.requests[0].success({
    statusCode: 200,
    data: { data: { mode: 'real' }, meta: { request_id: REQUEST_ID, contract_version: '1.0.0', execution_mode: 'real' } }
  });
  // 等预检与 readFileInfo 的微任务落地：放行 ⇒ 发出 POST /media/uploads。
  await new Promise(resolve => setImmediate(resolve));
  const uploads = mediaUploadRequests(gated.requests);
  assert.equal(uploads.length, 1, '恰为上限（2 MiB）必须放行上传，不得被预检误挡');
  assert.equal(uploads[0].method, 'POST');
  assert.equal(uploads[0].data.bytes, RECOGNITION_MAX_BYTES, '上传声明必须带真实字节数');
  assert.equal(page.data.errorText, '', '合规照片不得被写入错误提示');
  uploads[0].success({ statusCode: 500, data: {} });
  await pending;
});

test('GY-I09 切片B②：POST /media/uploads 返回 503 PROVIDER_UNAVAILABLE ⇒ 文案指向「真实对象存储未接线」，不再说「/media 内容端点未挂载」', async () => {
  const h = lifecycle(undefined, {
    mode: 'real',
    fileInfo: () => ({ size: 1024, digest: SYNTHETIC_SHA256 })
  });
  const gated = gatedPage(h);
  const page = gated.page;
  const viaMessage = h.load(resolve(root, 'miniprogram/utils/identify-api.js')).messageFor({ code: 'PROVIDER_UNAVAILABLE' });
  assert.ok(viaMessage.includes('服务端真实对象存储尚未接线'), 'PROVIDER_UNAVAILABLE 文案必须指向真实对象存储未接线，实际：' + viaMessage);
  assert.equal(viaMessage.includes('未挂载'), false, '不得再出现「未挂载」归因');
  assert.equal(viaMessage.includes('识别服务当前不可用'), false, '不得沿用「识别服务当前不可用」的旧口径');

  const pending = page.prepareMedia('/synthetic/tmp/small.jpg');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(gated.requests.length, 1);
  gated.requests[0].success({
    statusCode: 200,
    data: { data: { mode: 'real' }, meta: { request_id: REQUEST_ID, contract_version: '1.0.0', execution_mode: 'real' } }
  });
  await new Promise(resolve => setImmediate(resolve));
  const uploads = mediaUploadRequests(gated.requests);
  assert.equal(uploads.length, 1, '合规照片必须发出一次 POST /media/uploads');
  // 服务端**如实**返回契约错误封套（与 packages/media 的 toErrorEnvelope 同形）。
  uploads[0].success({
    statusCode: 503,
    data: { error: { code: 'PROVIDER_UNAVAILABLE', message: '对象存储未接线', retryable: false, details: [] } }
  });
  await pending;
  assert.equal(page.data.busy, false);
  assert.equal(page.data.errorText, viaMessage, '页面文案必须与 messageFor 的如实文案逐字一致');
  assert.equal(page.data.errorText.includes('未挂载'), false, '不得再出现「未挂载」归因');
  assert.equal(mediaUploadRequests(gated.requests).length, 1, '归因失败后不得再发起上传或重试请求');
});

test('GY-I09 切片B③：400 INVALID_REQUEST / 413 MEDIA_TOO_LARGE ⇒ 文案指向用途限制（≤2 MiB / 仅 JPG·PNG·WebP）', () => {
  const invalid = identifyApi.messageFor({ code: 'INVALID_REQUEST' });
  assert.ok(invalid.includes('照片不符合用途限制'), 'INVALID_REQUEST 必须指向用途限制，实际：' + invalid);
  assert.ok(invalid.includes('2 MiB'), '用途限制文案必须写明 2 MiB 上限');
  assert.ok(invalid.includes('JPG'), '用途限制文案必须写明允许的图片类型');
  for (const code of ['MEDIA_TOO_LARGE', 'MEDIA_TYPE_UNSUPPORTED']) {
    assert.equal(identifyApi.messageFor({ code }), invalid, code + ' 必须与 INVALID_REQUEST 同口径');
  }
  // 未知错误码不得被当成契约事实呈现。
  assert.equal(identifyApi.messageFor({ code: 'NOT_A_CONTRACT_CODE' }).includes('NOT_A_CONTRACT_CODE'), false);
});

test('GY-I09 切片B④不回归：正常小图逐跳行为不变（建句柄 → PUT 句柄 URL → 完成上传 → 返回媒体引用）', async () => {
  const h = lifecycle(undefined, {
    mode: 'real',
    fileInfo: () => ({ size: 1024, digest: SYNTHETIC_SHA256 })
  });
  const gated = gatedPage(h);
  const page = gated.page;
  const pending = page.prepareMedia('/synthetic/tmp/small.jpg');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(gated.requests.length, 1, '第一次请求必须是读执行模式');
  gated.requests[0].success({
    statusCode: 200,
    data: { data: { mode: 'real' }, meta: { request_id: REQUEST_ID, contract_version: '1.0.0', execution_mode: 'real' } }
  });
  await new Promise(resolve => setImmediate(resolve));
  const create = mediaUploadRequests(gated.requests)[0];
  assert.ok(create, '必须发出创建上传句柄请求');
  assert.equal(create.url.endsWith('/media/uploads'), true);
  assert.equal(create.method, 'POST');
  // 沙箱（vm 新 realm）里的对象原型与测试 realm 不同，故逐字段比较而非 deepEqual。
  assert.equal(create.data.purpose, 'weed_recognition');
  assert.equal(create.data.mime, 'image/jpeg');
  assert.equal(create.data.bytes, 1024);
  assert.equal(create.data.sha256, SYNTHETIC_SHA256);
  assert.deepEqual(Object.keys(create.data).sort(), ['bytes', 'mime', 'purpose', 'sha256'], '上传声明必须恰为契约 UploadInput 四字段');
  // 合法 201 句柄（字段与契约 UploadGrantEnvelope 逐项一致）。
  create.success({
    statusCode: 201,
    data: {
      data: {
        media: { id: MEDIA_ID, revision: 1, purpose: 'weed_recognition', mime: 'image/jpeg', bytes: 1024, duration_ms: null, state: 'initiated', sha256: SYNTHETIC_SHA256, failure_code: null },
        upload: { url: 'https://synthetic.invalid/put/handle', expires_at: new Date(Date.now() + 300000).toISOString(), method: 'PUT', access_token: 'synthetic-handle-token' }
      },
      meta: { request_id: REQUEST_ID, contract_version: '1.0.0', execution_mode: 'real' }
    }
  });
  await new Promise(resolve => setImmediate(resolve));
  const put = gated.requests.find(r => r.url === 'https://synthetic.invalid/put/handle');
  assert.ok(put, '必须把字节 PUT 到服务端给出的句柄 URL');
  assert.equal(put.method, 'PUT');
  put.success({ statusCode: 200 });
  await new Promise(resolve => setImmediate(resolve));
  const complete = mediaUploadRequests(gated.requests).find(r => r.url.endsWith('/complete'));
  assert.ok(complete, '必须调用 completeUpload');
  assert.equal(complete.header['If-Match'], '"1"', 'completeUpload 必须带 If-Match 版本');
  complete.success({
    statusCode: 202,
    data: {
      data: { id: MEDIA_ID, revision: 2, purpose: 'weed_recognition', mime: 'image/jpeg', bytes: 1024, duration_ms: null, state: 'ready', sha256: SYNTHETIC_SHA256, failure_code: null },
      meta: { request_id: REQUEST_ID, contract_version: '1.0.0', execution_mode: 'real' }
    }
  });
  await new Promise(resolve => setImmediate(resolve));
  const recognition = recognitionRequests(gated.requests)[0];
  assert.ok(recognition, '媒体就绪后必须按既有行为创建识别任务');
  // 沙箱（vm 新 realm）里的对象原型与测试 realm 不同，故逐字段比较而非 deepEqual。
  assert.equal(recognition.data.media_id, MEDIA_ID, '识别任务必须引用真实媒体引用');
  assert.equal(recognition.data.media_revision, 2);
  assert.deepEqual(Object.keys(recognition.data).sort(), ['media_id', 'media_revision'], '识别任务体必须恰为契约字段');
  recognition.success({ statusCode: 500, data: {} });
  await pending;
});

// ---------------------------------------------------------------------------
// GY-I09 第二片：小程序侧镜像与**服务端闭集逐项一致**（跨端漂移即失败），
// 以及「选择后也拿不到用量」的页面级负例。
// ---------------------------------------------------------------------------

test('GY-I09 跨端一致性：小程序的规则版本/条件字段/六类分支镜像与服务端逐项相同', async () => {
  // 动态 import 服务端模块（TS 源码由 node 直接加载，与本仓库其它测试同法）。
  const linkage = await import('../../services/api/src/recognitions/linkage.ts');
  const branches = await import('../../services/api/src/recognitions/branches.ts');
  const reference = await import('../../packages/reference/index.mjs');

  // 1) GY-I08 规则版本：域库 = 服务端关联层 = 小程序镜像，三者同值。
  assert.equal(linkage.LINKAGE_RULE_VERSION, reference.APPLICABILITY_RULE_VERSION);
  assert.equal(identifyApi.APPLICABILITY_RULE_VERSION, reference.APPLICABILITY_RULE_VERSION);
  assert.equal(identifyApi.APPLICABILITY_RULE_VERSION, linkage.LINKAGE_RULE_VERSION);

  // 2) 条件字段闭集与顺序逐项相同。
  assert.deepEqual(identifyApi.DOSE_CONDITION_FIELDS, linkage.DOSE_CONDITION_FIELDS.slice());

  // 3) 用量路径阻断类别同值。
  assert.equal(identifyApi.DOSE_PATH_BLOCK_CODE, linkage.DOSE_PATH_BLOCK_CODE);

  // 4) 六类分支闭集与顺序逐项相同。
  assert.deepEqual(identifyApi.FAILURE_BRANCHES, branches.FAILURE_BRANCHES.slice());

  // 5) 逐分支的落点/错误码/可重试语义/如实原因逐项相同。
  for (const branch of branches.FAILURE_BRANCHES) {
    const server = branches.BRANCH_DESCRIPTORS[branch];
    const retry = branches.retrySemanticsFor(branch);
    const client = identifyApi.describeBranch(branch);
    assert.ok(client !== null, `${branch} 在小程序侧必须存在`);
    assert.equal(client.jobState, server.jobState, `${branch} 落点漂移`);
    assert.equal(client.errorCode, server.errorCode, `${branch} 错误码漂移`);
    assert.equal(client.retryable, retry.retryable, `${branch} 可重试语义漂移`);
    assert.equal(client.retryAction, retry.retryAction, `${branch} 重试动作漂移`);
    assert.equal(client.reason, server.reason, `${branch} 如实原因漂移`);
    assert.equal(client.createsJob, branches.branchCreatesJob(branch));
  }

  // 6) 覆盖外/低质量细分原因文本与服务端闭集一致（客户端按文本归类，必须同文本）。
  assert.deepEqual(identifyApi.COVERAGE_REASONS, branches.COVERAGE_REASONS.slice());

  // 7) 未知分支不得被当成有效分支（页面据此不给重试入口）。
  assert.equal(identifyApi.describeBranch('not_a_branch'), null);
  assert.equal(identifyApi.branchGuide().length, 6);
});

test('GY-I09 小程序：六类分支归类只凭契约可见信息，且不把任何分支当成成功', () => {
  const cases = [
    { state: 'uncertain', errorCode: null, reasons: [], expect: 'uncertain' },
    { state: 'uncertain', errorCode: null, reasons: ['拍摄对象不在当前覆盖范围内'], expect: 'out_of_coverage_or_low_quality' },
    { state: 'uncertain', errorCode: null, reasons: ['照片模糊/遮挡/光照不足，无法可靠判定'], expect: 'out_of_coverage_or_low_quality' },
    { state: 'uncertain', errorCode: null, reasons: ['拍摄条件不合格，建议重新拍摄'], expect: 'reshoot_required' },
    { state: 'uncertain', errorCode: null, reasons: ['模型未返回任何候选'], expect: 'no_result' },
    { state: 'timed_out', errorCode: 'PROVIDER_TIMEOUT', reasons: [], expect: 'timeout' },
    { state: 'failed', errorCode: 'CONSENT_REQUIRED', reasons: [], expect: 'permission_denied' },
    // 不在六类之内的一律 null：不得硬塞进某个分支。
    { state: 'succeeded', errorCode: null, reasons: [], expect: null },
    { state: 'failed', errorCode: 'PROVIDER_QUOTA_EXCEEDED', reasons: [], expect: null },
    { state: 'cancelled', errorCode: null, reasons: [], expect: null },
    { state: 'queued', errorCode: null, reasons: [], expect: null }
  ];
  for (const item of cases) {
    assert.equal(identifyApi.branchFor(item.state, item.errorCode, item.reasons), item.expect,
      `${item.state}/${item.errorCode}/${JSON.stringify(item.reasons)}`);
    // 任何分支都不允许被当成识别成功。
    const info = identifyApi.describeBranch(item.expect);
    if (info !== null) {
      assert.notEqual(info.jobState, 'succeeded', '分支不得落 succeeded');
      assert.equal(identifyApi.isSuccessState(info.jobState || item.state), false);
    }
  }
  // 视图模型必须把分支与呈现状态一并带出（页面据此渲染重试入口）。
  const vm = identifyApi.viewModelForJob(jobOf('timed_out', null));
  assert.equal(vm.branch, 'timeout');
  assert.equal(vm.branchInfo.retryAction, 'new_task');
  assert.equal(vm.stateComponent, 'error', '失败态必须收口到 state-view 的 error');
  const okVm = identifyApi.viewModelForJob(jobOf('succeeded', RECOGNITION));
  assert.equal(okVm.branch, null, '成功不属于六类分支');
  assert.equal(okVm.stateComponent, 'ready');
});

test('GY-I09 小程序：用量路径守护——条件不全阻断，且条件完整时**仍**不给用量', () => {
  const incomplete = { species_id: 'species_barnyardgrass' };
  const partial = identifyApi.dosePathGuard(incomplete);
  assert.equal(partial.renderable, false, '识别路径恒不给用量');
  assert.equal(partial.card, null);
  assert.equal(partial.blockCode, identifyApi.DOSE_PATH_BLOCK_CODE);
  assert.equal(partial.blockedByPath, 'recognition_selection');
  assert.equal(partial.conditionsComplete, false);
  assert.ok(partial.missingConditions.length >= 1);
  assert.ok(partial.missingConditionLabels.includes('作物'), JSON.stringify(partial.missingConditionLabels));

  const completeConditions = {
    crop_id: 'crop_rice', region_code: '330100', species_id: 'species_barnyardgrass',
    growth_stage: '苗后', planting_method: 'transplant', use_scene: '水稻移栽田'
  };
  assert.equal(identifyApi.isConditionsComplete(completeConditions), true);
  assert.deepEqual(identifyApi.missingDoseConditions(completeConditions), []);
  const full = identifyApi.dosePathGuard(completeConditions);
  // 关键：条件完整**也不放行**——阻断来自路径本身，不是"恰好没数据"。
  assert.equal(full.renderable, false, '条件完整时识别路径仍不得给用量');
  assert.equal(full.card, null);
  assert.equal(full.blockCode, identifyApi.DOSE_PATH_BLOCK_CODE);
  assert.equal(full.conditionsComplete, true);
  assert.equal(full.ruleVersion, identifyApi.APPLICABILITY_RULE_VERSION);
  // 形状不符的地区码算缺项（不静默接受）。
  assert.ok(identifyApi.missingDoseConditions(Object.assign({}, completeConditions, { region_code: '9911' })).includes('region_code'));
});

test('GY-I09 小程序：记录选择后的关联科普**恒不含用量**，并如实列出条件缺项', async () => {
  const page = instance();
  page.data.guest = false;
  page.data.recordId = '66666666-6666-4666-8666-666666666666';
  page.data.recordRevision = 1;
  page._generation = 7;
  page._ownerKey = 'synthetic-owner-key';
  // 替身选择响应：只回模型原始候选（与真实服务端同形），不含任何用量字段。
  const original = identifyApi.selectSpecies;
  identifyApi.selectSpecies = async () => ({
    recognition: {
      id: page.data.recordId, revision: 2,
      candidates: [{ species_id: 'species_barnyardgrass', rank: 1, model_score: 0.81 }],
      uncertainty_reasons: [], selected_species_id: 'species_barnyardgrass', model_version: 'stub-v1'
    }
  });
  try {
    await page.recordSelection('species_barnyardgrass');
  } finally {
    identifyApi.selectSpecies = original;
  }
  const related = page.data.relatedKnowledge;
  assert.ok(related !== null && typeof related === 'object', '选择后必须解析关联科普');
  // —— 切片 A 的口径断言：空集**不再**算通过 ——
  // 旧口径用结构化 `species_id` 查本地资料层，本地记录永远不可能命中 ⇒ `items` 恒 0，
  // 而上面所有"恒不给用量"的断言在**空集上也成立**，本片会被同一条绿测试掩盖。
  // 因此这里必须明确要求：命中 `species_barnyardgrass`（组名「稗草」）时 `items` 非空。
  assert.ok(related.items.length > 0, '按名称文本匹配后必须命中资料（空集不得算通过）');
  assert.equal(related.matchState, 'matched');
  // 查询口径必须如实带出，且不得再带结构化 `species_id` 条件。
  assert.equal(related.speciesName, '稗草');
  assert.ok(/未结构化标注杂草对象/.test(related.matchNote), related.matchNote);
  assert.ok(/按名称文本匹配/.test(related.matchNote), related.matchNote);
  const source = readFileSync(join(root, 'miniprogram/pages/identify/identify.js'), 'utf8');
  assert.equal(/queryParams\s*=\s*\{\s*species_id/.test(source), false, '不得再用结构化 species_id 查询本地资料');
  // 用量恒不可展示（页面上也不会出现任何剂量数字字段）。
  assert.equal(related.dose.renderable, false);
  assert.equal(related.dose.card, null);
  assert.equal(related.dose.blockCode, identifyApi.DOSE_PATH_BLOCK_CODE);
  assert.equal(related.conditionsComplete, false, '本页只掌握杂草对象，条件必然不完整');
  assert.ok(related.missingConditionLabels.length >= 1);
  assert.equal(JSON.stringify(related).includes('"number"'), false, '关联结果不得含任何用量数字');
  // 规则版本与 GY-I08 一致。
  assert.equal(related.ruleVersion, identifyApi.APPLICABILITY_RULE_VERSION);
  // 逐条资料也标注了不可展示用量及其原因/版本。
  for (const item of related.items) {
    assert.equal(item.doseRenderable, false);
    assert.equal(item.doseRuleVersion, identifyApi.APPLICABILITY_RULE_VERSION);
    // 逐条归因必须与页面口径一致（不是"功能开关已关闭"）。
    assert.equal(item.doseReason, '识别/选择路径恒不给用量');
    assert.equal(item.doseBlockCode, identifyApi.DOSE_PATH_BLOCK_CODE);
    // 来源/审核标签必须带出（页面据此渲染，不得丢字段）。
    assert.equal(typeof item.labels, 'object');
    assert.ok(item.labels.source_kind.length > 0);
    assert.ok(item.labels.review_status.length > 0);
    // record_id 形状必须与 referencedetail 页的 id 校验一致，否则"点进去"必然落空态。
    assert.match(item.recordId, /^[A-Za-z0-9_-]{1,128}$/);
  }
  // —— 点击条目 → 资料详情（路由 + id 形状 + 非法 id 不跳转）——
  const navigations = [];
  const originalNavigate = globalThis.wx.navigateTo;
  globalThis.wx.navigateTo = options => navigations.push(options.url);
  try {
    page.onOpenKnowledgeDetail({ currentTarget: { dataset: { id: related.items[0].recordId } } });
    // 形状非法的 id 一律不跳转（不把任意字符串拼进查询串）。
    page.onOpenKnowledgeDetail({ currentTarget: { dataset: { id: '../../etc/passwd' } } });
    page.onOpenKnowledgeDetail({});
  } finally {
    globalThis.wx.navigateTo = originalNavigate;
  }
  assert.equal(navigations.length, 1, '只有合法 record_id 才允许跳转');
  assert.equal(navigations[0],
    '/pages/referencedetail/referencedetail?id=' + encodeURIComponent(related.items[0].recordId));
  // 页面模板必须真的把这些条目接到该动作上（不是只有 JS 里存在这个方法）。
  const wxml = readFileSync(join(root, 'miniprogram/pages/identify/identify.wxml'), 'utf8');
  assert.ok(/bindtap="onOpenKnowledgeDetail"/.test(wxml), '关联资料条目缺少 bindtap');
  assert.ok(/data-id="\{\{item\.recordId\}\}"/.test(wxml), '关联资料条目未带 recordId');
  assert.ok(/item\.labels\.source_kind/.test(wxml), '来源/审核标签未渲染');
  assert.ok(/item\.doseBlockCode/.test(wxml), '逐条用量归因未与页面口径对齐');
  assert.equal(/GY-I08 判定/.test(wxml), false, '逐条用量不得再归因于「GY-I08 判定」开关原因');
});

test('GY-I09 小程序：目录外对象（stub 替身候选）不得下发无条件查询，更不得显示为「已找到」', async () => {
  // F1/F2 护栏：stub 模式的三个替身候选（services/api/src/recognitions/provider.ts:54
  // 的 synthetic_weed_a/b/c）都不在本地杂草目录里 ⇒ speciesNameText 取不到名称文本。
  // 此时若"清空查询条件"下发 reference.query({limit:5})，本地层按**无条件**语义全量命中
  // （match_state='matched'、total=20），页面会渲染「关联科普（已找到符合条件的资料）」
  // ＋ 5 条与该对象毫无关联的除草剂 —— 假关联／错误指导。
  // 正确行为：不下发查询、items 为空、matchState 不得为 matched、文案如实。
  // 边界：目录外 id 也一并覆盖（不依赖替身命名的具体值）。
  const OUT_OF_CATALOG = ['synthetic_weed_a', 'synthetic_weed_b', 'synthetic_weed_c', 'species_not_in_catalog'];
  const original = identifyApi.selectSpecies;
  try {
    for (const speciesId of OUT_OF_CATALOG) {
      const page = instance();
      page.data.guest = false;
      page.data.recordId = '66666666-6666-4666-8666-666666666666';
      page.data.recordRevision = 1;
      page._generation = 7;
      page._ownerKey = 'synthetic-owner-key';
      identifyApi.selectSpecies = async () => ({
        recognition: {
          id: page.data.recordId, revision: 2,
          candidates: [{ species_id: speciesId, rank: 1, model_score: 0.77 }],
          uncertainty_reasons: [], selected_species_id: speciesId, model_version: 'stub-v1'
        }
      });
      await page.recordSelection(speciesId);
      const related = page.data.relatedKnowledge;
      assert.ok(related !== null && typeof related === 'object', `${speciesId}：选择后必须解析关联科普`);
      assert.equal(related.speciesName, '', `${speciesId}：本地目录里不存在该对象，名称文本必须为空`);
      assert.equal(related.items.length, 0, `${speciesId}：不得下发无条件查询换来"有资料"（items 必须为空）`);
      assert.notEqual(related.matchState, 'matched', `${speciesId}：不得显示为已匹配`);
      // 页面标题取自 matchStateLabel ⇒ 绝不能是「已找到符合条件的资料」。
      assert.notEqual(related.matchStateLabel, '已找到符合条件的资料', `${speciesId}：不得显示为已找到资料`);
      assert.ok(/不在本地杂草目录/.test(related.matchNote), `${speciesId}：口径未如实标注 -> ${related.matchNote}`);
      assert.ok(/未取得名称文本/.test(related.matchNote), `${speciesId}：口径未如实标注 -> ${related.matchNote}`);
      assert.ok(/本次不进行资料匹配/.test(related.matchNote), `${speciesId}：口径未如实标注 -> ${related.matchNote}`);
      // 用量守卫在该分支同样不得放松。
      assert.equal(related.dose.renderable, false, `${speciesId}：识别路径恒不给用量`);
      assert.equal(related.dose.card, null);
      assert.equal(related.dose.blockCode, identifyApi.DOSE_PATH_BLOCK_CODE);
      // 每轮结束时不得残留条目（页面不得有可点进详情的假关联）。
      assert.equal(related.items.length, 0, `${speciesId}：不得留下任何可点条目`);
    }
  } finally {
    identifyApi.selectSpecies = original;
  }
  // 模板层：标题仍取自 matchStateLabel（本分支已确认它不是「已找到符合条件的资料」）。
  const wxml = readFileSync(join(root, 'miniprogram/pages/identify/identify.wxml'), 'utf8');
  assert.ok(/关联科普（\{\{relatedKnowledge\.matchStateLabel\}\}）/.test(wxml), '标题口径漂移');
  // 源码层：查询必须由名称文本派生 ⇒ 不存在"无条件下发"的空条件查询。
  const source = readFileSync(join(root, 'miniprogram/pages/identify/identify.js'), 'utf8');
  assert.ok(/if \(speciesName === ''\) \{/.test(source), '缺少"取不到名称文本"的 fail-closed 分支');
  assert.equal(/if \(speciesName !== ''\) queryParams\.keyword/.test(source), false,
    'keyword 必须是该分支之后的必填项，不得再写成"可有可无"');
});

// ---------------------------------------------------------------------------
// GY-I10 第三片：标签 OCR（#10）客户端入口。
//
// 口径：走**与识草同一套**私有媒体上传与**既有** OCR 路由（`POST /ocr` → `GET /jobs/{id}` →
// `GET /ocr/{id}`），七类 JobState 逐类呈现；标签正文**只读**展示（原样文本 + 来源/状态标签）；
// **不是权威判读**；**永不渲染任何剂量数字**（用量卡只报条数）。
// 全部为合成身份与合成响应，绝不外发；不作为微信工具或真机证据。
// ---------------------------------------------------------------------------

const OCR_JOB_ID = '11111111-2222-4333-8444-555555555555';
const OCR_RECORD_ID = '99999999-8888-4777-8666-555555555555';
const OCR_TMP_PATH = '/tmp/synthetic-label.jpg';
/** 剂量哨兵：替身用量卡的正文（**不得**出现在页面任何位置）。 */
const OCR_DOSE_SENTINEL = '每公顷 1234 毫升（剂量哨兵：不得渲染）';

/** 等待页面把第 n 个请求发出来（不依赖真实定时器与真实网络）。 */
async function waitForRequests(h, n) {
  for (let i = 0; i < 500; i += 1) {
    if (h.requests.length >= n) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error('等待请求超时：期望 ' + n + ' 个，实际 ' + h.requests.length);
}

function syntheticMeta() {
  return { request_id: REQUEST_ID, contract_version: '1.0.0', execution_mode: 'stub' };
}

/** 契约错误封套（与 `errors.ts` 同形）。 */
function errorEnvelope(code, retryable) {
  return { error: { code, message: '合成错误（测试）', retryable: retryable === true, details: [] }, meta: syntheticMeta() };
}

/** 标签 OCR 任务封套（`POST /ocr` 202 与 `GET /jobs/{id}` 200 同形；九键、kind='ocr'）。 */
function ocrJobEnvelope(state, result, ids) {
  const jobId = (ids && ids.job) || OCR_JOB_ID;
  const ocrId = (ids && ids.ocr) || OCR_RECORD_ID;
  return {
    data: {
      id: jobId,
      revision: state === 'queued' ? 1 : state === 'running' ? 2 : 3,
      kind: 'ocr',
      target_ref: { type: 'ocr', id: ocrId, revision: 1 },
      state,
      deadline_at: '2026-10-16T10:00:00.000Z',
      created_at: '2026-10-16T09:59:30.000Z',
      error_code: state === 'timed_out' ? 'PROVIDER_TIMEOUT' : state === 'failed' ? 'PROVIDER_OUTCOME_UNKNOWN' : null,
      result: result === undefined ? null : { kind: 'ocr', value: result }
    },
    meta: syntheticMeta()
  };
}

/** 契约 `OCR` 投影（六键）：原样文本 + 核对结论；用量卡**正文**只存在于响应里（页面不得渲染）。 */
function ocrRecordValue(overrides) {
  const fields = () => ({
    registration_number: 'PD20210001',
    name: '替身示例草甘膦水剂',
    ingredients: [{ name: '草甘膦', content_text: '41', unit_text: '%' }],
    dosage_form: '水剂'
  });
  return Object.assign({
    id: OCR_RECORD_ID,
    revision: 1,
    raw_fields: fields(),
    corrected_fields: fields(),
    verification: {
      match_state: 'matched',
      registration: { id: 'synthetic-registration' },
      conflict_fields: [],
      missing_fields: [],
      dose_cards: [{ dose_text: OCR_DOSE_SENTINEL }]
    },
    model_version: 'stub-v1'
  }, overrides || {});
}

function ocrRecordEnvelope(overrides) { return { data: ocrRecordValue(overrides), meta: syntheticMeta() }; }

/** 已登录 + 门禁已核实的页面（沙箱内真实页面与真实 auth/identify-api 模块实例）。 */
async function verifiedPage() {
  const h = lifecycle();
  h.seedSession();
  const page = h.page();
  page.onLoad();
  page.onShow();
  h.acceptVerification(h.requests.at(-1));
  assert.equal(page.data.guest, false, '合成会话核实后必须通过门禁');
  return { h, page };
}

test('GY-I10 小程序：标签识别入口 → 既有 OCR 路由 → 七类状态轮询 → 只读展示（无剂量数字）', async () => {
  const { h, page } = await verifiedPage();
  // —— 入口：卡片已接入（不再是「尚未接入」的 toast），点击必须打开选图 ——
  const ocrMode = page.data.modes.filter(m => m.key === 'ocr')[0];
  assert.equal(ocrMode.action, '拍照识别', '标签识别卡片仍是「尚未接入」');
  assert.ok(/非权威判读/.test(ocrMode.desc), ocrMode.desc);
  page.onShoot({ currentTarget: { dataset: { mode: 'ocr' } } });
  assert.equal(h.media.length, 1, '标签识别入口必须打开选图');
  assert.equal(h.media[0].mediaType.length, 1);
  assert.equal(h.media[0].mediaType[0], 'image');
  assert.equal(h.media[0].count, 1);
  // 取消选图：如实提示、零请求。
  const beforeCancel = h.requests.length;
  h.media[0].fail({});
  assert.equal(h.requests.length, beforeCancel, '取消选图不得发请求');
  assert.equal(page.data.errorText, '未选择照片，已取消。');

  // —— 选图 → 替身模式（照片不上传）→ `POST /ocr` 受理 202 ——
  let flow = null;
  const originalPrepare = page.prepareOcrMedia;
  page.prepareOcrMedia = function (path) { flow = originalPrepare.call(this, path); return flow; };
  page.onShoot({ currentTarget: { dataset: { mode: 'ocr' } } });
  h.media.at(-1).success({ tempFiles: [{ tempFilePath: OCR_TMP_PATH }] });
  assert.ok(flow !== null, '选图成功后必须进入标签识别流程');
  await waitForRequests(h, 2);
  assert.ok(/\/public\/home$/.test(h.requests[1].url), '必须先读服务端执行模式');
  h.requests[1].success({ statusCode: 200, data: { data: {}, meta: syntheticMeta() } });
  await waitForRequests(h, 3);
  const created = h.requests[2];
  assert.equal(created.method, 'POST');
  assert.ok(/\/ocr$/.test(created.url), '标签任务必须走既有 POST /ocr：' + created.url);
  assert.deepEqual(Object.keys(created.data).sort(), ['media_id', 'media_revision'], 'body 必须恰为 MediaJobInput');
  assert.match(created.data.media_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.equal(created.data.media_revision, 1);
  assert.ok(typeof created.header['Idempotency-Key'] === 'string' && created.header['Idempotency-Key'].length >= 8);
  assert.ok(/照片不会上传/.test(page.data.substituteNotice), page.data.substituteNotice);
  created.success({ statusCode: 202, data: ocrJobEnvelope('queued') });
  await flow;
  page.stopPoll();
  assert.equal(page.data.ocr.state, 'queued');
  assert.equal(page.data.ocr.stateTitle, identifyApi.describeJobState('queued').title);
  assert.equal(page.data.ocr.terminal, false);
  assert.equal(page.data.ocr.ocrId, OCR_RECORD_ID);
  assert.equal(page.data.ocr.errorCode, null);
  assert.equal(page.data.busy, true);

  // —— 轮询（与识草同一读面与停止条件）：running → succeeded ——
  const gen = page._generation;
  let poll = page.refreshOcrJob(gen);
  await waitForRequests(h, 4);
  assert.equal(h.requests[3].method, 'GET');
  assert.ok(/\/jobs\//.test(h.requests[3].url), '状态必须从既有 GET /jobs/{id} 读：' + h.requests[3].url);
  h.requests[3].success({ statusCode: 200, data: ocrJobEnvelope('running') });
  await poll;
  assert.equal(page.data.ocr.state, 'running');
  assert.equal(page.data.ocr.terminal, false);
  assert.equal(page.data.busy, true);

  poll = page.refreshOcrJob(gen);
  await waitForRequests(h, 5);
  h.requests[4].success({ statusCode: 200, data: ocrJobEnvelope('succeeded', ocrRecordValue()) });
  await waitForRequests(h, 6);
  assert.equal(h.requests[5].method, 'GET');
  assert.ok(/\/ocr\//.test(h.requests[5].url), '任务成功后必须读既有 GET /ocr/{id}');
  h.requests[5].success({ statusCode: 200, data: ocrRecordEnvelope() });
  await poll;

  const ocr = page.data.ocr;
  assert.equal(ocr.state, 'succeeded');
  assert.equal(ocr.terminal, true);
  assert.equal(ocr.success, true);
  assert.equal(page.data.busy, false);
  assert.equal(page._ocrPollTimer, null, '终态后必须停止轮询');
  assert.equal(ocr.errorCode, null);
  // 原样文本：逐字段照录（含来源/状态标签）
  assert.deepEqual(Array.from(ocr.record.readRows, row => row.label), ['登记证号', '药名', '剂型', '有效成分']);
  assert.equal(ocr.record.readRows[0].value, 'PD20210001');
  assert.equal(ocr.record.readRows[1].value, '替身示例草甘膦水剂');
  assert.equal(ocr.record.readRows[3].value, '草甘膦 41%');
  assert.equal(ocr.record.sourceVersion, 'stub-v1');
  assert.equal(ocr.record.revision, 1);
  assert.equal(ocr.record.matchLabel, '已匹配到登记资料');
  assert.equal(ocr.record.hasRegistration, true);
  assert.equal(ocr.record.correctedDiffers, false);
  assert.equal(ocr.record.jobState, 'succeeded');
  // 如实标注：**不是权威判读** + 只读（不发明编辑能力）
  assert.ok(/不是权威判读/.test(ocr.record.authorityNote), ocr.record.authorityNote);
  assert.ok(/只读/.test(ocr.record.readOnlyNote), ocr.record.readOnlyNote);
  // —— 用药安全：用量卡只报条数，正文与任何剂量数字都不得出现 ——
  assert.equal(ocr.record.doseCardCount, 1, '用量卡只允许报条数');
  const serialized = JSON.stringify(page.data);
  assert.equal(serialized.includes(OCR_DOSE_SENTINEL), false, '用量卡正文不得进入页面数据');
  assert.equal(serialized.includes('dose_cards'), false, '用量卡结构不得进入页面数据');
  assert.equal(/每公顷/.test(serialized), false, '不得出现任何剂量数字');
  // 私有关闭：离页必须清空标签区块（与识别域同口径）。
  page.onHide();
  assert.equal(page.data.ocr, null);
  assert.equal(page._ocrPollTimer, null);
});

test('GY-I10 小程序：标签 OCR 失败一律按契约 error.code 如实归因（不得一律「未挂载」）', async () => {
  const { h, page } = await verifiedPage();
  void page;
  const api = h.load(resolve(root, 'miniprogram/utils/identify-api.js'));
  const declaration = { mime: 'image/jpeg', bytes: 1024, sha256: 'a'.repeat(64) };
  /** 发一次真实上传调用并喂入合成响应；返回（请求, 错误）。 */
  async function uploadOnce(statusCode, payload, purpose) {
    const before = h.requests.length;
    const pending = api.uploadPrivatePhoto(OCR_TMP_PATH, declaration, purpose === undefined ? api.OCR_MEDIA_PURPOSE : purpose);
    await waitForRequests(h, before + 1);
    const request = h.requests.at(-1);
    assert.equal(request.method, 'POST');
    assert.ok(/\/media\/uploads$/.test(request.url));
    request.success({ statusCode, data: payload });
    return { request, error: await pending.then(() => null, e => e) };
  }

  // ① 503 PROVIDER_UNAVAILABLE ⇒ 指向**真实对象存储未接线**；不得再断言「/media 端点未挂载」。
  const a = await uploadOnce(503, errorEnvelope('PROVIDER_UNAVAILABLE', true));
  assert.equal(a.request.data.purpose, 'label_ocr', '标签图必须声明契约既有用途 label_ocr');
  assert.equal(a.error.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(a.error.status, 503);
  const textA = api.messageFor(a.error);
  assert.equal(/未挂载|尚未接入服务端/.test(textA), false, '不得再一律说成"通道未挂载"：' + textA);
  assert.ok(/对象存储/.test(textA), textA);
  // ② 400/413/415 ⇒ 用途限制（同一句，不冒充其它原因）。
  const b = await uploadOnce(400, errorEnvelope('INVALID_REQUEST', false));
  assert.equal(b.error.code, 'INVALID_REQUEST');
  assert.equal(api.messageFor(b.error), api.MEDIA_USE_LIMIT_TEXT);
  const c = await uploadOnce(413, errorEnvelope('MEDIA_TOO_LARGE', false));
  assert.equal(api.messageFor(c.error), api.MEDIA_USE_LIMIT_TEXT);
  const t = await uploadOnce(415, errorEnvelope('MEDIA_TYPE_UNSUPPORTED', false));
  assert.equal(api.messageFor(t.error), api.MEDIA_USE_LIMIT_TEXT);
  // ③ 无封套 / 未知码 ⇒ 如实回落"上传未完成"，且**不透出**未知码。
  const d = await uploadOnce(500, null);
  assert.equal(d.error.code, 'MEDIA_CHANNEL_UNAVAILABLE');
  assert.equal(/未挂载/.test(api.messageFor(d.error)), false, api.messageFor(d.error));
  const e = await uploadOnce(502, errorEnvelope('SYNTHETIC_UNKNOWN_CODE', false));
  assert.equal(e.error.code, 'MEDIA_CHANNEL_UNAVAILABLE', '未知码不得当契约事实透出');
  assert.equal(api.messageFor(e.error).includes('SYNTHETIC_UNKNOWN_CODE'), false);
  // ④ 用途白名单：只放行契约图片用途（音频用途本地即拒，不发请求）。
  const beforeReject = h.requests.length;
  const rejected = await api.uploadPrivatePhoto(OCR_TMP_PATH, declaration, 'voice_question').then(() => null, err => err);
  assert.equal(rejected.code, 'INVALID_INPUT');
  assert.equal(h.requests.length, beforeReject, '用途非法时不得发出请求');

  // ⑤ 执行模式探测（既有缺陷 1-D 的修复）：`/public/home` 的数据在非 real 模式下**按设计 503**
  //    （db/catalog.ts 的 fail-closed），但契约 `ErrorEnvelope.meta` 必填 ⇒ 仍须如实读出执行模式；
  //    **只有**封套无可核对 meta 或网络失败才报不可用（不猜模式、不把入口在第一步打死）。
  async function serverModeOnce(response) {
    const before = h.requests.length;
    const pending = api.serverMode();
    await waitForRequests(h, before + 1);
    const request = h.requests.at(-1);
    assert.ok(/\/public\/home$/.test(request.url), request.url);
    if (response === null) request.fail({}); else request.success(response);
    return await pending.then(mode => ({ mode }), error => ({ error }));
  }
  const modeFromErrorEnvelope = await serverModeOnce({
    statusCode: 503,
    data: { error: { code: 'PROVIDER_UNAVAILABLE', message: '主页资料数据库尚未接入', retryable: false, details: [] }, meta: syntheticMeta() },
  });
  assert.equal(modeFromErrorEnvelope.mode, 'stub', '非 real 模式下公共读面按设计 503，但封套 meta 仍须如实给出执行模式');
  const modeOk = await serverModeOnce({ statusCode: 200, data: { data: { previews: [], human_review_state: 'under_construction' }, meta: syntheticMeta() } });
  assert.equal(modeOk.mode, 'stub');
  const modeNoMeta = await serverModeOnce({ statusCode: 503, data: { error: { code: 'PROVIDER_UNAVAILABLE' } } });
  assert.equal(modeNoMeta.error.code, 'UNAVAILABLE', '封套无 meta ⇒ 如实报不可用（不猜执行模式）');
  const modeNetworkFail = await serverModeOnce(null);
  assert.equal(modeNetworkFail.error.code, 'NETWORK_UNCERTAIN');

  // —— `POST /ocr` 非 2xx：站点特定归因（不得指向对象存储） ——
  async function createOnce(statusCode, payload) {
    const before = h.requests.length;
    const pending = api.createOcr(OCR_RECORD_ID, 1);
    await waitForRequests(h, before + 1);
    const request = h.requests.at(-1);
    assert.ok(/\/ocr$/.test(request.url));
    request.success({ statusCode, data: payload });
    return await pending.then(() => null, err => err);
  }
  const f = await createOnce(503, errorEnvelope('PROVIDER_UNAVAILABLE', true));
  assert.equal(f.code, 'PROVIDER_UNAVAILABLE');
  assert.ok(/OCR 提供者/.test(api.ocrMessageFor(f)), api.ocrMessageFor(f));
  assert.equal(/对象存储/.test(api.ocrMessageFor(f)), false, '不得把 OCR 提供者未接线说成对象存储未接线');
  const g = await createOnce(409, errorEnvelope('OBJECT_UNAVAILABLE', false));
  assert.equal(g.code, 'OBJECT_UNAVAILABLE');
  assert.ok(/标签识别/.test(api.ocrMessageFor(g)), api.ocrMessageFor(g));
  const consent = await createOnce(403, errorEnvelope('CONSENT_REQUIRED', false));
  assert.equal(consent.code, 'CONSENT_REQUIRED', '403 的授权类拒绝必须按契约码如实带出（不得说成"登录失效"）');
  assert.equal(consent.status, 403);
  assert.ok(/授权/.test(api.ocrMessageFor(consent)), api.ocrMessageFor(consent));
  assert.equal(h.auth.isLoggedIn(), true, '403 CONSENT_REQUIRED 不得误清会话（用户只是没授权）');

  // —— 404「作业不存在」 vs 503「取消能力未接线」：必须可区分（不得混用同一句） ——
  const jobsBefore = h.requests.length;
  const jobRead = api.getOcrJob(OCR_JOB_ID);
  await waitForRequests(h, jobsBefore + 1);
  assert.ok(/\/jobs\//.test(h.requests.at(-1).url));
  h.requests.at(-1).success({ statusCode: 404, data: errorEnvelope('NOT_FOUND', false) });
  const notFound = await jobRead.then(() => null, err => err);
  assert.equal(notFound.code, 'NOT_FOUND');
  assert.ok(/不存在/.test(api.ocrMessageFor(notFound)), api.ocrMessageFor(notFound));

  const cancelBefore = h.requests.length;
  const cancel = api.cancelOcrJob(OCR_JOB_ID, 1);
  await waitForRequests(h, cancelBefore + 1);
  const cancelRequest = h.requests.at(-1);
  assert.equal(cancelRequest.method, 'POST');
  assert.ok(/\/jobs\/[0-9a-f-]+\/cancel$/.test(cancelRequest.url), cancelRequest.url);
  assert.equal(cancelRequest.header['If-Match'], '"1"');
  assert.ok(typeof cancelRequest.header['Idempotency-Key'] === 'string');
  cancelRequest.success({ statusCode: 503, data: errorEnvelope('PROVIDER_UNAVAILABLE', true) });
  const cancelError = await cancel.then(() => null, err => err);
  assert.equal(cancelError.code, 'PROVIDER_UNAVAILABLE', '错误码必须原样保留（不改写成私有码）');
  assert.equal(cancelError.retryable, true);
  const cancelText = api.ocrMessageFor(cancelError, 'cancel');
  assert.ok(/取消能力/.test(cancelText), cancelText);
  assert.ok(/不是"任务不存在"/.test(cancelText), cancelText);
  assert.notEqual(cancelText, api.ocrMessageFor(notFound), '取消未接线不得与"作业不存在"同句');

  // —— 作业形状守卫：识别域作业塞进 OCR 校验 ⇒ INVALID_RESPONSE（fail-closed，不放宽） ——
  assert.throws(() => api.validateOcrJob(jobEnvelope('succeeded', recognitionValue()).data),
    err => err.code === 'INVALID_RESPONSE');

  // —— 对照：401 仍按会话失效处理（并清会话）——不得因为上面的 403 改动而放宽 ——
  const sessionLost = await createOnce(401, errorEnvelope('SESSION_REQUIRED', false));
  assert.equal(sessionLost.code, 'SESSION_REQUIRED');
  assert.equal(h.auth.isLoggedIn(), false, '401 必须清会话（守卫不放宽）');
});

test('GY-I10 小程序：标签区块绑定门禁、模板只读且不渲染任何用量正文', () => {
  const source = readFileSync(join(root, 'miniprogram/pages/identify/identify.js'), 'utf8');
  const wxml = readFileSync(join(root, 'miniprogram/pages/identify/identify.wxml'), 'utf8');
  // 入口与路由：**只复用既有 operation**（不新增契约操作、不新增服务端调用点）。
  assert.ok(/key === 'ocr'/.test(source), '缺少 ocr 入口分支');
  assert.ok(/identifyApi\.createOcr\(/.test(source), '标签任务未走既有 POST /ocr');
  assert.ok(/identifyApi\.getOcrJob\(/.test(source), '任务状态未走既有 GET /jobs/{id}');
  assert.ok(/identifyApi\.cancelOcrJob\(/.test(source), '取消未走既有 POST /jobs/{id}/cancel');
  assert.ok(/historyApi\.getOcr\(/.test(source), '标签正文未复用既有 GET /ocr/{id} 消费层');
  assert.ok(/identifyApi\.OCR_MEDIA_PURPOSE/.test(source), '标签图未声明契约既有用途 label_ocr');
  assert.equal(/我造|fallbackFields|fakeFields/.test(source), false, '不得伪造标签字段');
  // 模板：门禁、状态、原样文本、来源/状态标签、非权威、只读、无用量正文。
  assert.ok(/wx:if="\{\{ocr && !guest\}\}"/.test(wxml), '标签区块未绑定门禁（guest 时不得展示）');
  assert.ok(/bindtap="onCancelOcrJob"/.test(wxml), '缺少取消入口');
  assert.ok(/bindtap="onOcrRetry"/.test(wxml), '缺少重新拍摄入口');
  assert.ok(/ocr\.record\.readRows/.test(wxml), '原样文本未渲染');
  assert.ok(/ocr\.record\.sourceVersion/.test(wxml), '来源版本标签未渲染');
  assert.ok(/ocr\.record\.matchLabel/.test(wxml), '核对状态标签未渲染');
  assert.ok(/机器读数 · 非权威判读 · 不提供用量/.test(wxml), '缺少非权威判读标注');
  assert.ok(/用量：不可展示/.test(wxml), '缺少用量阻断标注');
  assert.equal(/dose_cards/.test(wxml), false, '模板不得引用用量卡结构（只允许条数）');
  // 源码层：OCR 分支不得出现任何"给用量/给数字"的写法。
  assert.equal(/doseCard\s*(:|\.card)/.test(source), false, '不得构造用量卡对象');
});

/** 标签 OCR 任务创建请求（`POST /ocr`）。 */
function ocrCreateRequests(list) {
  return list.filter(request => request.method === 'POST' && /\/ocr$/.test(request.url));
}

test('GY-I10：>2 MiB 标签图上传前预检 ⇒ 不发任何 POST /media/uploads、也不建任务（与识草同一口径）', async () => {
  const h = lifecycle(undefined, {
    mode: 'real',
    fileInfo: () => ({ size: 2 * 1024 * 1024 + 1, digest: SYNTHETIC_SHA256 })
  });
  const gated = gatedPage(h);
  const page = gated.page;
  const pending = page.prepareOcrMedia('/synthetic/tmp/oversized-label.jpg');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(gated.requests.length, 1, '第一次请求必须是读执行模式');
  gated.requests[0].success({
    statusCode: 200,
    data: { data: { mode: 'real' }, meta: { request_id: REQUEST_ID, contract_version: '1.0.0', execution_mode: 'real' } }
  });
  await pending;
  assert.equal(gated.requests.length, 1, '超限时只能发一次读模式请求，不得再有其它请求');
  assert.deepEqual(mediaUploadRequests(gated.requests), [], '超限时不得发出任何 POST /media/uploads');
  assert.deepEqual(ocrCreateRequests(gated.requests), [], '超限时不得创建标签 OCR 任务');
  assert.equal(page.data.busy, false);
  assert.ok(page.data.errorText.includes('照片过大'), '必须给出「照片过大」类可操作提示，实际：' + page.data.errorText);
  assert.ok(page.data.errorText.includes('未上传任何照片'), '提示必须如实说明本次未上传，实际：' + page.data.errorText);
});

test('GY-I10 负控制：恰为 2 MiB 的标签图必须放行走到上传（否则合规照片被连带挡掉）', async () => {
  const h = lifecycle(undefined, {
    mode: 'real',
    fileInfo: () => ({ size: 2 * 1024 * 1024, digest: SYNTHETIC_SHA256 })
  });
  const gated = gatedPage(h);
  const page = gated.page;
  const pending = page.prepareOcrMedia('/synthetic/tmp/exactly-2mib-label.jpg');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(gated.requests.length, 1, '合规尺寸必须继续走到上传（读模式请求）');
  gated.requests[0].success({
    statusCode: 200,
    data: { data: { mode: 'real' }, meta: { request_id: REQUEST_ID, contract_version: '1.0.0', execution_mode: 'real' } }
  });
  await new Promise(resolve => setImmediate(resolve));
  const uploads = mediaUploadRequests(gated.requests);
  assert.equal(uploads.length, 1, '恰为上限（2 MiB）必须放行上传');
  assert.equal(uploads[0].data.bytes, 2 * 1024 * 1024, '上传声明必须带真实字节数');
  assert.equal(uploads[0].data.purpose, 'label_ocr', '标签图必须声明契约既有用途 label_ocr（不是 weed_recognition）');
  assert.equal(page.data.errorText, '');
  uploads[0].success({ statusCode: 503, data: errorEnvelope('PROVIDER_UNAVAILABLE', true) });
  await pending;
  // 失败发生在**上传**这一步 ⇒ 必须用媒体站点的措辞（对象存储未接线），不得说成 OCR 提供者未接线。
  assert.equal(page.data.errorText.includes('对象存储'), true, 'real 模式对象存储未接线必须如实归因，实际：' + page.data.errorText);
  assert.equal(page.data.errorText.includes('OCR 提供者'), false, '上传失败不得归因到 OCR 提供者（站点串了），实际：' + page.data.errorText);
});
