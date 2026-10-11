// GY-I09 小程序侧回归：七类 JobState 的呈现分支 + 打包白名单同步 + 页面生命周期状态写入。
//
// 断言策略：先判 typeof 再判值；对「不得当成识别成功」的情形逐条反向断言（negative control）。
// 不依赖微信运行时：这里用最小 Page/wx 替身加载**仓库里的真实页面源码**。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';

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
