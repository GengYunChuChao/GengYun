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
// 生命周期回归（监工 5485989704 [B]/[C]）：用最小 vm 沙箱加载真实页面与真实 auth 模块，
// 手动解析 wx.request，以复现「门禁未核实/失效仍展示私有数据」与「在途响应淘汰」两个实际反例。
// 合成身份与合成响应，绝不外发；不作为微信工具或真机证据。
// ---------------------------------------------------------------------------
function lifecycle(sharedStorage) {
  // 传入共享 storage 可模拟「同一份本地存储 + 两个独立启动（新 VM、新模块实例）」。
  const storage = sharedStorage instanceof Map ? sharedStorage : new Map();
  const requests = [];
  const launches = [];
  const cache = new Map();
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
      chooseMedia: () => {},
      getFileInfo: () => {},
      getFileSystemManager: () => ({ readFile: () => {} })
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
  function acceptVerification(request) {
    request.success({ statusCode: 200, data: { data: { audience: 'user', expires_at: expires() } } });
  }
  return { storage, requests, launches, auth, page, seedSession, acceptVerification, load };
}

const JOB_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RECORD_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REQUEST_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

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
  assert.equal(calls, 0, '未登录时不得发起任何网络请求');
  // 页面在游客态点击入口不动作。
  page.data.guest = true;
  page.onShoot({ currentTarget: { dataset: { mode: 'weed' } } });
  assert.equal(calls, 0);
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
