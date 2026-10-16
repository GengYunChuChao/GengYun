/**
 * GY-I13（#13）**客户端播放生命周期**回归：安全检查在前、播报文本正确性、
 * 语音球与等效控件、离页取消与资源释放、失败文案与「不假记已听取」。
 *
 * 分层（每层都可单独指出）：
 * 1. `utils/speech-text.js`（安全检查闸门 + 播报计划复核）：正例 + 数字/单位/制剂条件/否定词反例；
 * 2. `utils/audio-playback.js`（播放生命周期控制器，端口注入）：状态流转、单一播放者、
 *    停止/释放/离页的资源释放（可复核判据：监听数 0、活动句柄 0）、失败分类文案与主动按钮、
 *    **替身播放不得记「已听取」**、失败**不得**记「已听取」；
 * 3. `pages/voice/voice`（宿主页）：安全检查未过 ⇒ **零合成请求**；通过 ⇒ 恰好一次合成请求；
 *    onHide/onUnload 走同一释放出口；
 * 4. 静态可访问性/布局：语音球与四个等效按钮都有 `aria-role`/`aria-label`、触控下限用
 *    `var(--tap-min, 44px)`（非 rpx）、页面与组件样式**无** position:fixed/absolute、
 *    播报控件在提交按钮之后（不遮挡）、录音控件与播报控件分离；
 * 5. 三处清单一致（app.json.pages / navigation.PAGES / prepare-wechat 白名单）。
 *
 * 声明：本文件**不产生任何音频**、不访问麦克风、不触达真实 TTS；全部为合成夹具与替身端口。
 * 真机音频与交互证据属 #23，不在本文件范围内。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
// 服务端**装配层**注入的替身核对条目（`ruling-451` 缩片）：与客户端替身样本是同一对夹具，
// 这里直接比对两者，锁定「id / revision / 正文」不会单边漂移。
import { SYNTHESIS_SUBSTITUTE_CHECKED_CONTENT } from '../../services/api/src/app.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const requireHere = createRequire(import.meta.url);

const speechText = requireHere('../../miniprogram/utils/speech-text.js');
const audioPlayback = requireHere('../../miniprogram/utils/audio-playback.js');
const substitutePlayer = requireHere('../../miniprogram/utils/substitute-player.js');
const innerAudio = requireHere('../../miniprogram/utils/inner-audio-port.js');

/** 含数字、单位、制剂条件与否定词的正例正文（合成夹具，不是真实用药建议）。 */
const SAMPLE = '稗草苗后茎叶处理：每亩用 30 毫升，兑水 30 升常规喷雾。'
  + '不得在高温时段施药，不要与碱性药剂混用；安全间隔期 14 天。';

/** 可完全观测的替身播放端口（测试专用；`utils/substitute-player.js` 是页面走查用的那一份）。 */
function observablePlayer(options = {}) {
  const state = { created: 0, destroyed: 0, plays: 0, live: 0, lastHandlers: null };
  const port = {
    kind: 'observable_player',
    substitute: options.substitute === true,
    create(src) {
      state.created += 1;
      state.live += 1;
      const listeners = {};
      let destroyed = false;
      let entry;
      const emit = (event, payload) => {
        if (destroyed) return;
        for (const handler of (listeners[event] || []).slice()) handler(payload);
      };
      entry = {
        src,
        emitted: emit,
        on(event, handler) {
          if (!listeners[event]) listeners[event] = [];
          listeners[event].push(handler);
          return () => { listeners[event] = listeners[event].filter((item) => item !== handler); };
        },
        play() { state.plays += 1; if (!options.silentPlay) emit('play'); },
        pause() { emit('pause'); },
        stop() {},
        destroy() {
          if (destroyed) return;
          destroyed = true;
          state.destroyed += 1;
          state.live -= 1;
          for (const key of Object.keys(listeners)) listeners[key] = [];
        }
      };
      state.lastHandlers = entry;
      return entry;
    }
  };
  return { port, state };
}

// ============================================================ 1. 安全检查闸门

test('闸门·只有 check_state=passed 才放行；blocked/未知/缺失一律 SAFETY_CHECK_BLOCKED（不合成、不播报）', () => {
  const passed = speechText.assertSpeakable({ checkState: 'passed', text: SAMPLE, checkedText: SAMPLE });
  assert.equal(passed.ok, true);
  assert.equal(passed.text, SAMPLE);
  assert.ok(passed.segments.length >= 1);

  for (const checkState of ['blocked', 'approved', 'unknown', '', null, undefined, 1]) {
    const out = speechText.assertSpeakable({ checkState, text: SAMPLE, checkedText: SAMPLE });
    assert.equal(out.ok, false, `check_state=${String(checkState)} 必须被拒`);
    assert.equal(out.code, 'SAFETY_CHECK_BLOCKED');
    assert.equal(speechText.gateMessage(out).includes('不能合成'), true);
  }
});

test('反例·passed 但待播报文本与已核对正文不一致 ⇒ TEXT_MISMATCH（客户端不得改写已核对正文）', () => {
  const out = speechText.assertSpeakable({ checkState: 'passed', text: SAMPLE.replace('30 毫升', '300 毫升'), checkedText: SAMPLE });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'TEXT_MISMATCH');
});

test('反例·passed 但已核对正文缺失/超长 ⇒ CHECKED_TEXT_UNREADABLE（不得播报空内容）', () => {
  for (const checkedText of ['', '   ', null, undefined, 42, 'x'.repeat(speechText.MAX_SPEAKABLE_CODE_POINTS + 1)]) {
    const out = speechText.assertSpeakable({ checkState: 'passed', text: checkedText, checkedText: checkedText });
    assert.equal(out.ok, false);
    assert.equal(out.code, 'CHECKED_TEXT_UNREADABLE');
  }
});

// ============================================================ 2. 播报文本正确性（数字/单位/制剂条件/否定词）

test('分段·无损：任一段上限下，拼接结果与正文逐字一致、每段不超上限（不截断、不省略）', () => {
  for (const limit of [8, 12, 20, 40, 120]) {
    const segments = speechText.splitForSpeech(SAMPLE, limit);
    assert.equal(segments.join(''), SAMPLE, `limit=${limit} 拼接必须逐字一致`);
    assert.ok(segments.length >= 1);
    for (const segment of segments) {
      assert.ok(speechText.codePointLength(segment) <= limit, `limit=${limit} 段超长：${segment}`);
    }
  }
  assert.deepEqual(speechText.splitForSpeech('', 10), []);
  assert.deepEqual(speechText.splitForSpeech(null, 10), []);
});

test('关键令牌·抽取：数字/单位绑定对、裸数字、制剂条件词、否定词都逐项可见', () => {
  const tokens = speechText.criticalTokens(SAMPLE);
  assert.deepEqual(tokens.doses, ['30毫升', '30升']);
  assert.deepEqual(tokens.bareNumbers, ['14']);
  assert.equal(tokens.formulations['苗后'], 1);
  assert.equal(tokens.formulations['茎叶处理'], 1);
  assert.equal(tokens.formulations['每亩'], 1);
  assert.equal(tokens.formulations['兑水'], 1);
  assert.equal(tokens.formulations['常规喷雾'], 1);
  assert.equal(tokens.formulations['安全间隔期'], 1);
  assert.equal(tokens.negations['不得'], 1);
  assert.equal(tokens.negations['不要'], 1);
});

test('正例·分段播报计划通过复核（拼接逐字一致 + 关键令牌齐全）', () => {
  const segments = speechText.splitForSpeech(SAMPLE, 18);
  assert.ok(segments.length > 1, '本用例需要多段以验证拼接');
  const plan = speechText.verifySpeakPlan(segments, SAMPLE);
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.text, SAMPLE);
});

test('反例·数字被改写 / 单位丢失 / 制剂条件丢失 / 否定词丢失 / 截断，各有可指出的判据', () => {
  // ① 数字被改写：30 毫升 → 3 毫升
  const changedNumber = speechText.verifySpeakPlan([SAMPLE.replace('30 毫升', '3 毫升')], SAMPLE);
  assert.equal(changedNumber.ok, false);
  assert.equal(changedNumber.code, 'SPOKEN_TEXT_MISMATCH');
  assert.ok(changedNumber.missing.some((item) => item.includes('数字/单位') && item.includes('30毫升')), JSON.stringify(changedNumber.missing));

  // ② 单位丢失：30 毫升 → 30（裸数字，不再是剂量对）
  const lostUnit = speechText.verifySpeakPlan([SAMPLE.replace('30 毫升', '30')], SAMPLE);
  assert.equal(lostUnit.ok, false);
  assert.ok(lostUnit.missing.some((item) => item.includes('数字/单位 30毫升')), JSON.stringify(lostUnit.missing));

  // ③ 制剂条件丢失：删掉「苗后」
  const lostFormulation = speechText.verifySpeakPlan([SAMPLE.replace('苗后', '')], SAMPLE);
  assert.equal(lostFormulation.ok, false);
  assert.ok(lostFormulation.missing.some((item) => item.includes('制剂/条件 苗后')), JSON.stringify(lostFormulation.missing));

  // ④ 否定词丢失：把「不得」换成「要」
  const lostNegation = speechText.verifySpeakPlan([SAMPLE.replace('不得', '要')], SAMPLE);
  assert.equal(lostNegation.ok, false);
  assert.ok(lostNegation.missing.some((item) => item.includes('否定词 不得')), JSON.stringify(lostNegation.missing));

  // ⑤ 截断：丢掉最后一段
  const segments = speechText.splitForSpeech(SAMPLE, 18);
  const truncated = speechText.verifySpeakPlan(segments.slice(0, segments.length - 1), SAMPLE);
  assert.equal(truncated.ok, false);
  assert.ok(truncated.missing.length > 0, '截断必须被指出');

  // ⑥ 多出正文里没有的否定词（把建议念成禁止同样是错）
  const extraNegation = speechText.verifySpeakPlan([SAMPLE + '切勿随意施药。'], SAMPLE);
  assert.equal(extraNegation.ok, false);
  assert.ok(extraNegation.extra.some((item) => item.includes('切勿')), JSON.stringify(extraNegation.extra));
});

// ============================================================ 3. 播放生命周期控制器

test('生命周期·单段自然播完才置「已听取」；播放中状态为 playing', () => {
  const { port, state } = observablePlayer();
  const changes = [];
  const listened = [];
  const controller = audioPlayback.createPlaybackController({
    player: port,
    onStateChange: (snapshot) => changes.push(snapshot.state),
    onListened: () => listened.push(true)
  });
  assert.equal(controller.play('a.mp3', { auto: true }).ok, true);
  assert.equal(controller.snapshot().state, 'playing');
  assert.equal(controller.isListened(), false, '开始播放不算已听取');
  state.lastHandlers.emitted('ended');
  assert.equal(controller.isListened(), true, '整份计划自然播完才算已听取');
  assert.equal(controller.snapshot().state, 'stopped');
  assert.deepEqual(listened, [true]);
  assert.equal(changes.includes('loading'), true);
});

test('生命周期·多段按序播报，只有最后一段结束才置「已听取」（段间不重复建句柄）', () => {
  const { port, state } = observablePlayer();
  const controller = audioPlayback.createPlaybackController({ player: port });
  controller.play(['s1', 's2', 's3']);
  assert.equal(state.created, 1);
  state.lastHandlers.emitted('ended');
  assert.equal(state.created, 2, '第二段应新建且仅新建一个句柄');
  assert.equal(state.destroyed, 1, '上一段句柄必须被销毁');
  assert.equal(controller.isListened(), false);
  state.lastHandlers.emitted('ended');
  assert.equal(state.created, 3);
  assert.equal(controller.isListened(), false);
  state.lastHandlers.emitted('ended');
  assert.equal(controller.isListened(), true);
  assert.equal(state.live, 0, '播完后不得留下活动句柄');
  assert.equal(controller.listenerCount(), 0, '播完后不得留下监听');
});

test('反例·重复播报：同一计划重复 play 不新建句柄、不重复出声；换计划必先销毁旧句柄', () => {
  const { port, state } = observablePlayer();
  const controller = audioPlayback.createPlaybackController({ player: port });
  controller.play('a.mp3');
  const first = state.created;
  const duplicate = controller.play('a.mp3');
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.code, 'ALREADY_PLAYING');
  assert.equal(state.created, first, '重复请求不得新建句柄（避免重复播报）');
  assert.equal(state.plays, 1, '不得重复出声');

  // 切换计划：旧句柄必须先销毁（不叠音）
  controller.play('b.mp3');
  assert.equal(state.destroyed, 1);
  assert.equal(state.live, 1, '任何时刻最多一个活动句柄');
});

test('生命周期·暂停/继续/停止/重播：停止与暂停都**不**记「已听取」，重播重置计数', () => {
  const { port, state } = observablePlayer();
  const controller = audioPlayback.createPlaybackController({ player: port });
  controller.play(['s1', 's2']);

  controller.pause();
  assert.equal(controller.snapshot().state, 'paused');
  assert.equal(controller.isListened(), false);

  controller.resume();
  assert.equal(controller.snapshot().state, 'playing');

  controller.stop();
  assert.equal(controller.snapshot().state, 'stopped');
  assert.equal(controller.isListened(), false, '用户中断不是听取');
  assert.equal(controller.listenerCount(), 0);
  assert.equal(state.live, 0);

  // 停止后仍可重播：同一计划从头再播，且在播完之前不置已听取
  const replay = controller.replay();
  assert.equal(replay.ok, true);
  assert.equal(state.created, 2, '重播只新建一个新的首段句柄');
  assert.equal(controller.isListened(), false);
  state.lastHandlers.emitted('ended');
  assert.equal(controller.isListened(), false, '第一段播完不等于整份播完');
  state.lastHandlers.emitted('ended');
  assert.equal(controller.isListened(), true);
});

test('释放·release 幂等且彻底：监听 0、活动句柄 0，迟到回调不生效，之后 play 不再建句柄', () => {
  const { port, state } = observablePlayer();
  const controller = audioPlayback.createPlaybackController({ player: port });
  controller.play(['s1', 's2']);
  const handle = state.lastHandlers;
  assert.equal(controller.listenerCount() > 0, true);

  const released = controller.release();
  assert.equal(released.ok, true);
  assert.equal(controller.listenerCount(), 0, '释放后监听必须为 0（无后台残留）');
  assert.equal(state.live, 0, '释放后不得留下活动句柄');
  assert.equal(controller.snapshot().state, 'idle');
  assert.equal(controller.isListened(), false);

  // 负例：释放后迟到的 ended/error 不得改变状态、不得置已听取
  handle.emitted('ended');
  handle.emitted('error', { code: 'MUTED' });
  assert.equal(controller.isListened(), false, '离页之后迟到的回调不得记已听取');
  assert.equal(controller.snapshot().state, 'idle');
  assert.equal(controller.snapshot().failure, null);

  const after = controller.play('c.mp3');
  assert.equal(after.ok, false);
  assert.equal(after.code, 'RELEASED');
  assert.equal(state.created, 1, '释放后不得再创建句柄');

  assert.equal(controller.release().alreadyReleased, true, 'release 必须幂等');
});

// ============================================================ 4. 失败与无障碍（文案 + 主动播放按钮）

test('失败·空计划 ⇒ SOURCE_UNAVAILABLE 文案 + 主动播放按钮，且**不**记已听取', () => {
  const { port } = observablePlayer();
  const failures = [];
  const controller = audioPlayback.createPlaybackController({ player: port, onFailure: (failure) => failures.push(failure) });
  const result = controller.play([], { auto: true });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SOURCE_UNAVAILABLE');
  assert.equal(controller.snapshot().state, 'failed');
  assert.equal(controller.isListened(), false, '自动播放失败不得假记已听取');
  assert.equal(failures.length, 1);
  const failure = failures[0];
  assert.equal(failure.code, 'SOURCE_UNAVAILABLE');
  assert.ok(failure.title.length > 0);
  assert.ok(failure.hint.length > 0);
  assert.ok(failure.actionText.length > 0, '失败必须给出主动播放按钮文案');
  assert.equal(failure.manualStart, true);
  assert.equal(failure.recordsListened, false);
  assert.equal(failure.auto, true, '本次是自动发起的播放');
});

test('失败·静音/蓝牙/拒权/平台阻止自动播放各有**不同**文案与按钮，且都不记已听取', () => {
  const codes = ['AUTOPLAY_BLOCKED', 'MUTED', 'BLUETOOTH', 'PERMISSION_DENIED'];
  const seen = new Map();
  for (const code of codes) {
    const classified = audioPlayback.classifyPlaybackFailure({ code });
    assert.equal(classified.code, code);
    assert.ok(classified.title.length > 0, `${code} 缺标题`);
    assert.ok(classified.hint.length > 0, `${code} 缺说明`);
    assert.ok(classified.actionText.length > 0, `${code} 缺主动播放按钮文案`);
    assert.equal(classified.manualStart, true);
    assert.equal(classified.recordsListened, false);
    seen.set(code, classified.title + '|' + classified.hint + '|' + classified.actionText);
  }
  assert.equal(new Set(seen.values()).size, codes.length, '四类失败文案必须互不相同（不得合并成一句）');
});

test('失败·平台原始错误按特征归类（静音/蓝牙/拒权/自动播放阻止/解码/中断/未知）', () => {
  const cases = [
    ['bluetooth device disconnected', 'BLUETOOTH'],
    ['当前处于静音状态，音量为 0', 'MUTED'],
    ['permission denied: scope.record', 'PERMISSION_DENIED'],
    ['play() failed because the user did not interact first', 'AUTOPLAY_BLOCKED'],
    ['decode error: unsupported format', 'DECODE_FAILED'],
    ['audio interruption begin', 'PLAYBACK_INTERRUPTED'],
    ['完全看不懂的故障', 'UNKNOWN']
  ];
  for (const [raw, expected] of cases) {
    const classified = audioPlayback.classifyPlaybackFailure({ errMsg: raw });
    assert.equal(classified.code, expected, raw);
    assert.ok(classified.actionText.length > 0, `${raw} 也必须有主动播放按钮`);
    assert.equal(classified.recordsListened, false, raw);
    assert.equal(classified.reason, raw, '原始原因必须如实保留，不得吞掉');
  }
  assert.equal(audioPlayback.classifyPlaybackFailure('permission denied').code, 'PERMISSION_DENIED');
  assert.equal(audioPlayback.classifyPlaybackFailure({ code: 'MUTED' }).code, 'MUTED');
});

test('失败·失败码闭集逐个走完控制器：状态 failed、无残留句柄/监听、一律不记已听取', () => {
  for (const code of audioPlayback.FAILURE_CODES) {
    const { port, state } = observablePlayer();
    const failures = [];
    const controller = audioPlayback.createPlaybackController({ player: port, onFailure: (failure) => failures.push(failure) });
    controller.play('a.mp3');
    state.lastHandlers.emitted(code === 'PLAYBACK_INTERRUPTED' ? 'interrupt' : 'error', { code });
    assert.equal(controller.snapshot().state, 'failed', code);
    assert.equal(controller.isListened(), false, `${code} 失败不得记已听取`);
    assert.equal(failures.length, 1, code);
    assert.equal(failures[0].code, code);
    assert.equal(failures[0].recordsListened, false, code);
    assert.equal(state.live, 0, `${code} 失败后不得留下活动句柄`);
    assert.equal(controller.listenerCount(), 0, `${code} 失败后不得留下监听`);
  }
});

test('失败·中断（来电/其它音频/蓝牙切换）不记已听取，并给出 PLAYBACK_INTERRUPTED 文案', () => {
  const { port, state } = observablePlayer();
  const failures = [];
  const controller = audioPlayback.createPlaybackController({ player: port, onFailure: (f) => failures.push(f) });
  controller.play(['s1', 's2']);
  state.lastHandlers.emitted('interrupt', { code: 'PLAYBACK_INTERRUPTED' });
  assert.equal(controller.snapshot().state, 'failed');
  assert.equal(controller.isListened(), false);
  assert.equal(failures[0].code, 'PLAYBACK_INTERRUPTED');
  assert.equal(failures[0].actionText.length > 0, true);
});

test('替身播放·整份计划走完只置 substituteCompleted，**绝不**记「已听取」', () => {
  const port = substitutePlayer.createSubstitutePlayerPort({ segmentMs: 0 });
  const states = [];
  const listened = [];
  const controller = audioPlayback.createPlaybackController({
    player: port,
    onStateChange: (snapshot) => states.push(snapshot.state),
    onListened: () => listened.push(true)
  });
  assert.equal(port.substitute, true);
  const result = controller.play(['substitute://0', 'substitute://1'], { auto: true });
  assert.equal(result.ok, true);
  return new Promise((done) => {
    setTimeout(() => {
      const snapshot = controller.snapshot();
      assert.equal(snapshot.substitute, true);
      assert.equal(snapshot.substituteCompleted, true, '替身播放应如实标记"计划已走完"');
      assert.equal(snapshot.listened, false, '替身没有声音，不得记为「已听取」');
      assert.deepEqual(listened, [], 'onListened 在替身端口下永不触发');
      assert.equal(states.includes('playing'), true);
      assert.equal(states.includes('stopped'), true);
      controller.release();
      assert.equal(controller.listenerCount(), 0);
      done();
    }, 40);
  });
});

test('真机端口缺能力 ⇒ 如实失败（不伪造播放完成、不记已听取）', () => {
  const port = innerAudio.createInnerAudioPort();
  assert.equal(port.available, false, 'Node/测试环境不提供 wx.createInnerAudioContext');
  assert.equal(port.kind, 'unavailable');
  const controller = audioPlayback.createPlaybackController({ player: port });
  const failures = [];
  controller.release();
  const c2 = audioPlayback.createPlaybackController({ player: port, onFailure: (f) => failures.push(f) });
  c2.play('substitute://none');
  return new Promise((done) => {
    setTimeout(() => {
      assert.equal(c2.snapshot().state, 'failed');
      assert.equal(c2.isListened(), false);
      assert.equal(failures[0].code, 'SOURCE_UNAVAILABLE');
      assert.equal(controller.isListened(), false);
      done();
    }, 20);
  });
});

// ============================================================ 5. 宿主页行为（离页取消与释放、零请求）

/** 在受控环境里加载真实页面/工具模块（依赖通过 vm 注入，模块本身是仓库里的真代码）。 */
function loadPageHarness() {
  const requests = [];
  const toasts = [];
  const sets = [];

  const auth = {
    isLoggedIn: () => true,
    getSession: () => ({ accessToken: 'synthetic-token' }),
    sessionEpoch: () => 'epoch-1',
    networkEnabled: () => true,
    requireLogin: (callback) => callback(true),
    clearSession: () => {}
  };
  const runtime = { mode: 'local', apiBaseUrl: 'http://127.0.0.1:3000' };
  const debug = { localEnabled: (wxApi) => runtime.mode === 'local' && !!wxApi && typeof wxApi.getAccountInfoSync === 'function' };
  const pageGate = { start: (page, callback) => callback(true), cancel: () => {} };
  const fontScale = { applyFontScale: () => {}, currentFontScale: () => 1, DEFAULT_FONT_SCALE: 1 };

  const fakeWx = {
    request: (options) => { requests.push(options); },
    getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop' } }),
    showToast: (options) => { toasts.push(options); },
    getStorageSync: () => '',
    setStorageSync: () => {},
    removeStorageSync: () => {}
  };

  const cache = new Map();
  function loadReal(file, resolveDep) {
    if (cache.has(file)) return cache.get(file);
    const source = readFileSync(file, 'utf8');
    const module = { exports: {} };
    cache.set(file, module.exports);
    const wrapper = vm.compileFunction(source, ['module', 'exports', 'require', '__filename', '__dirname'], { filename: file });
    wrapper(module, module.exports, resolveDep, file, dirname(file));
    cache.set(file, module.exports);
    return module.exports;
  }

  const bySuffix = (suffix) => join(ROOT, 'miniprogram', 'utils', suffix);
  const resolveDep = (id) => {
    if (id === './auth' || id === '../config/runtime' || id === './debug') {
      if (id === './auth') return auth;
      if (id === './debug') return debug;
      return runtime;
    }
    const base = id.split('/').pop();
    if (base === 'page-gate') return pageGate;
    if (base === 'font-scale') return fontScale;
    if (base === 'auth') return auth;
    if (base === 'debug') return debug;
    if (base === 'speech-text') return loadReal(bySuffix('speech-text.js'), resolveDep);
    if (base === 'audio-playback') return loadReal(bySuffix('audio-playback.js'), resolveDep);
    if (base === 'inner-audio-port') return loadReal(bySuffix('inner-audio-port.js'), resolveDep);
    if (base === 'substitute-player') return loadReal(bySuffix('substitute-player.js'), resolveDep);
    if (base === 'voice-api') return loadReal(bySuffix('voice-api.js'), resolveDep);
    throw new Error('unexpected require: ' + id);
  };

  let definition = null;
  // `wx` 必须在**模块加载期与调用期**都可见（voice-api/inner-audio-port 在调用时读 `typeof wx`）。
  globalThis.wx = fakeWx;
  globalThis.Page = (value) => { definition = value; };
  try {
    loadReal(join(ROOT, 'miniprogram', 'pages', 'voice', 'voice.js'), resolveDep);
  } finally {
    delete globalThis.Page;
  }
  assert.ok(definition, '播报页必须注册 Page');

  const page = Object.assign({}, definition, {
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(patch) { Object.assign(this.data, patch); sets.push(patch); },
    route: 'pages/voice/voice'
  });
  return { page, requests, toasts, sets, auth, runtime, wx: fakeWx, voiceApi: loadReal(bySuffix('voice-api.js'), resolveDep) };
}

function bootPage() {
  const harness = loadPageHarness();
  globalThis.wx = harness.wx;
  harness.page.onLoad();
  harness.page.onShow();
  return harness;
}

test('宿主页·安全检查未过 ⇒ **零**合成请求、无播放器、不播报（反例）', () => {
  const h = bootPage();
  assert.deepEqual(h.page.data.samples.map((s) => s.id), ['sample-i13-passed', 'sample-i13-blocked']);
  h.page.onSelectSample({ currentTarget: { dataset: { id: 'sample-i13-blocked' } } });
  assert.equal(h.page.data.checkPassed, false);
  assert.equal(h.page.data.checkState, 'blocked');
  assert.equal(h.page.data.checkMessage.includes('不能合成'), true);

  // 直接点提交（即使按钮被禁用，逻辑也必须自己再判一次）
  h.page.onBroadcast();
  assert.equal(h.requests.length, 0, '安全检查未过不得发起任何合成请求');
  assert.equal(h.page.data.synthesisNote.includes('未发起任何合成请求'), true);
  assert.equal(h.page._controller, null, '未通过检查时不得创建播放器');
});

test('宿主页·安全检查通过 ⇒ 恰好一次 POST /speech/synthesis（带 8..128 的 Idempotency-Key）', async () => {
  const h = bootPage();
  h.page.onSelectSample({ currentTarget: { dataset: { id: 'sample-i13-passed' } } });
  assert.equal(h.page.data.checkPassed, true);
  assert.ok(h.page.data.segmentCount >= 1);

  const pending = h.page.onBroadcast();
  assert.equal(h.requests.length, 1);
  const request = h.requests[0];
  assert.equal(request.method, 'POST');
  assert.equal(request.url.endsWith('/speech/synthesis'), true);
  const key = request.header['Idempotency-Key'];
  assert.equal(typeof key, 'string');
  assert.ok(key.length >= 8 && key.length <= 128);
  assert.deepEqual(JSON.parse(JSON.stringify(request.data)), {
    checked_content_ref: { type: 'answer', id: 'sample-i13-passed', revision: 1 },
    locale: 'zh-CN'
  });
  // 服务端如实拒绝（真实提供者未接线 / 替身核对源无该条目）：页面如实显示，不伪造任务
  request.success({ statusCode: 503, data: { error: { code: 'PROVIDER_UNAVAILABLE', retryable: true } }, header: {} });
  await pending;
  assert.equal(h.requests.length, 1, '失败不得重试发出额外请求');
  assert.equal(h.page.data.synthesisNote.includes('真实 TTS 提供者未接线'), true);
  assert.equal(h.page.data.stage, 'playback');
  h.page.onUnload();
});

test('宿主页·合成成功但无可播音频 ⇒ 自动播放失败：文案 + 主动播放按钮，且不记已听取', async () => {
  const h = bootPage();
  h.page.onSelectSample({ currentTarget: { dataset: { id: 'sample-i13-passed' } } });
  h.page.setData({ localEnabled: false, substituteWalkthrough: false });
  const pending = h.page.onBroadcast();
  const job = {
    id: '00000000-0000-4000-8000-000000000001',
    revision: 3,
    kind: 'synthesis',
    target_ref: { type: 'answer', id: 'sample-i13-passed', revision: 1 },
    state: 'succeeded',
    deadline_at: '2026-10-14T06:00:30.000Z',
    created_at: '2026-10-14T06:00:00.000Z',
    error_code: null,
    result: {
      kind: 'synthesis',
      value: {
        id: '00000000-0000-4000-8000-000000000002',
        revision: 1,
        checked_content_ref: { type: 'answer', id: 'sample-i13-passed', revision: 1 },
        media_id: '00000000-0000-4000-8000-000000000003'
      }
    }
  };
  h.requests[0].success({
    statusCode: 202,
    data: { data: job, meta: { request_id: job.id, contract_version: '1.0.0', execution_mode: 'stub' } },
    header: { ETag: '"3"' }
  });
  await pending;

  assert.equal(h.page.data.job.state, 'succeeded');
  assert.equal(h.page.data.playbackState, 'failed');
  assert.equal(h.page.data.listened, false, '没有音频源时绝不记「已听取」');
  assert.ok(h.page.data.failure, '必须给出失败文案对象');
  assert.ok(h.page.data.failure.title.length > 0);
  assert.ok(h.page.data.failure.actionText.length > 0, '失败必须有主动播放按钮');
  assert.equal(h.page.data.failure.code, 'SOURCE_UNAVAILABLE');
  h.page.onUnload();
});

// ============================================================ 5b. 缩片（`ruling-451`）：受理链路打通 + 如实不可播
//
// 范围（不放开契约、不改服务端语义）：① stub/preset_demo 下经装配层替身条目打通「受理 202 →
// `GET /jobs/{id}` 读面」；② 取不到可播放来源 ⇒ 仍 `SOURCE_UNAVAILABLE` 且页面**如实**写
// 「本环境无可播放音频（契约无客户端音频出口）」，**不得**显示「播放中／已播放」；
// ③ 客户端**不得**硬编码 `revision: 1`（取契约值，且**优先**服务端回传的 revision）。

/** 契约 `Job`（九键）夹具；`target` 同时用于 `target_ref` 与 `result.value.checked_content_ref`（二者必须一致）。 */
function jobFixture(input = {}) {
  const target = input.target === undefined ? { type: 'answer', id: 'sample-i13-passed', revision: 1 } : input.target;
  const suffix = input.suffix === undefined ? '1' : input.suffix;
  return {
    id: `00000000-0000-4000-8000-00000000000${suffix}`,
    revision: 3,
    kind: 'synthesis',
    target_ref: { ...target },
    state: 'succeeded',
    deadline_at: '2026-10-14T06:00:30.000Z',
    created_at: '2026-10-14T06:00:00.000Z',
    error_code: null,
    result: {
      kind: 'synthesis',
      value: {
        id: `00000000-0000-4000-8000-0000000000${suffix}1`,
        revision: 1,
        checked_content_ref: { ...target },
        media_id: `00000000-0000-4000-8000-0000000000${suffix}2`
      }
    }
  };
}

function acceptJob(request, job, mode = 'stub') {
  request.success({
    statusCode: 202,
    data: { data: job, meta: { request_id: job.id, contract_version: '1.0.0', execution_mode: mode } },
    header: { ETag: '"3"' }
  });
}

test('缩片·配对夹具：客户端替身样本的 targetRef 与服务端装配层替身核对条目逐项一致（含正文逐字一致）', () => {
  const h = loadPageHarness();
  const samples = h.voiceApi.SUBSTITUTE_SPEAK_SAMPLES;
  const declared = samples.filter((sample) => sample.targetRef !== undefined);
  assert.equal(declared.length, 1, '本片刻度：只有正例样本声明契约目标引用');
  const sample = declared[0];
  assert.deepEqual(
    { type: sample.targetRef.type, id: sample.targetRef.id, revision: sample.targetRef.revision },
    { type: 'answer', id: 'sample-i13-passed', revision: 1 }
  );
  // 反例样本刻意不声明（安全检查不通过 ⇒ 永不合成 ⇒ 不该有可合成引用）。
  assert.equal(samples.filter((item) => item.id === 'sample-i13-blocked')[0].targetRef, undefined);

  assert.equal(SYNTHESIS_SUBSTITUTE_CHECKED_CONTENT.length, 1, '装配层只注入正例那一条替身条目');
  const entry = SYNTHESIS_SUBSTITUTE_CHECKED_CONTENT[0];
  assert.equal(entry.type, sample.targetRef.type, '服务端条目 type 必须与客户端样本一致');
  assert.equal(entry.id, sample.targetRef.id, '服务端条目 id 必须与客户端样本一致');
  assert.equal(entry.revision, sample.targetRef.revision, '服务端条目 revision 必须与客户端样本一致');
  assert.equal(entry.auditState, 'approved', '替身条目必须是「已核对通过」，否则受理必被拒');
  assert.equal(entry.text, sample.checkedText, '服务端条目正文必须与客户端样本逐字一致（不得改写/归一化）');
});

test('反例·revision 不硬编码：首次取样本声明的契约值，之后**优先**服务端回传的 revision，且不得张冠李戴', async () => {
  const h = bootPage();
  h.page.onSelectSample({ currentTarget: { dataset: { id: 'sample-i13-passed' } } });

  // ① 首次提交：revision = 样本声明的契约值（1），且页面**代码**里没有内联字面量。
  //    判据按仓库既有做法先**去注释**（注释里说明"不得内联"是允许的，被检的是可执行代码）。
  const pageSource = read('miniprogram/pages/voice/voice.js');
  const pageCode = pageSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(/voiceApi\.checkedContentRefForSample\(/.test(pageCode), '页面必须经契约取值函数取目标引用');
  assert.equal(/revision:\s*1\b/.test(pageCode), false, '页面代码不得内联硬编码 revision: 1（注释不算）');
  assert.ok(/revision:\s*1\b/.test(pageSource), '页面须保留一行注释说明该口径（便于审阅者复核）');

  const first = h.page.onBroadcast();
  assert.equal(h.requests.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.requests[0].data.checked_content_ref)), {
    type: 'answer', id: 'sample-i13-passed', revision: 1
  });

  // ② 服务端回传一个**不同**的 revision（权威值由服务端给出）⇒ 客户端必须采纳。
  acceptJob(h.requests[0], jobFixture({ target: { type: 'answer', id: 'sample-i13-passed', revision: 7 }, suffix: '7' }));
  await first;
  assert.equal(h.voiceApi.serverRevisionFor({ type: 'answer', id: 'sample-i13-passed' }), 7, '必须记下服务端回传的 revision');

  const second = h.page.onBroadcast();
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].data.checked_content_ref.revision, 7, '第二次必须用服务端回传的 revision（而不是夹具里的 1）');

  // ③ 负例·张冠李戴：服务端这次回的是**别的内容目标**（id 不同）⇒ 不得把它的 revision 记到本样本上。
  acceptJob(h.requests[1], jobFixture({ target: { type: 'answer', id: 'answer-other-target', revision: 9 }, suffix: '9' }));
  await second;
  assert.equal(h.voiceApi.serverRevisionFor({ type: 'answer', id: 'sample-i13-passed' }), 7, '别的目标的 revision 不得被记到本样本');
  assert.equal(h.voiceApi.serverRevisionFor({ type: 'answer', id: 'answer-other-target' }), 9, '该记在它自己的 (type,id) 下');

  const third = h.page.onBroadcast();
  assert.equal(h.requests.length, 3);
  assert.equal(h.requests[2].data.checked_content_ref.revision, 7, '仍然用本样本自己的服务端 revision');
  assert.equal(h.requests[2].data.checked_content_ref.id, 'sample-i13-passed', '目标引用不得被别的目标顶替');
  third.catch(() => {});
  h.page.onUnload();
});

test('反例·样本未声明契约目标引用 ⇒ 不发明引用、零合成请求（如实说明）', () => {
  const h = bootPage();
  // 手工构造一个「安全检查通过、却没声明 targetRef」的样本（模拟夹具缺字段/被改坏）。
  h.page.setData({
    samples: [{ id: 'sample-no-ref', label: '无契约引用的样本', checkState: 'passed', checkedText: SAMPLE }],
    selectedSampleId: 'sample-no-ref',
    checkPassed: true,
    checkedText: SAMPLE
  });
  h.page.onBroadcast();
  assert.equal(h.requests.length, 0, '没有契约目标引用时不得发起任何合成请求');
  assert.ok(h.page.data.synthesisNote.includes('没有声明契约目标引用'), h.page.data.synthesisNote);
  h.page.onUnload();
});

test('缩片·取不到可播放来源 ⇒ 页面如实呈现「本环境无可播放音频（契约无客户端音频出口）」，绝不显示「播放中／已播放」', async () => {
  const h = bootPage();
  h.page.onSelectSample({ currentTarget: { dataset: { id: 'sample-i13-passed' } } });
  assert.equal(h.page.data.substituteWalkthrough, false, '替身走查默认必须是关（否则会出现"没有来源 + 正在播报"的自相矛盾态）');

  const pending = h.page.onBroadcast();
  acceptJob(h.requests[0], jobFixture({ suffix: '3' }));
  await pending;

  // ① 终态：失败出口（不是「正在播报」），且没有替身计划、没有记已听取。
  assert.equal(h.page.data.job.state, 'succeeded', '受理与读面必须如实打通（合成确实成功了）');
  assert.equal(h.page.data.playbackState, 'failed', '取不到来源必须是失败态，绝不能是 playing/stopped');
  assert.equal(h.page.data.listened, false);
  assert.equal(h.page.data.substitute, false, '不得把替身当真实播放');
  assert.equal(h.page._plan.length, 0, '没有可播放来源 ⇒ 计划为空');
  assert.equal(h.page.data.ballHint, '');

  // ② 文案口径：必须是**契约层**事实，不是"网络问题"，且与客户端常量逐字一致。
  const note = h.page.data.sourceNotice;
  assert.ok(note.includes('本环境无可播放音频'), note);
  assert.ok(note.includes('契约无客户端音频出口'), note);
  assert.equal(note.startsWith(h.voiceApi.NO_CLIENT_AUDIO_EGRESS_NOTE), true, '页面必须原样展示该常量（不得自造措辞）');

  // ③ 客户端 API 层：stub 与 real 两支都如实不可播，且原因各不相同（不得都写成"网络问题/登录失效"）。
  const stubSource = h.voiceApi.audioSourceForJob(jobFixture({ suffix: '4' }), 'stub');
  const realSource = h.voiceApi.audioSourceForJob(jobFixture({ suffix: '5' }), 'real');
  assert.equal(stubSource.code, 'SOURCE_UNAVAILABLE');
  assert.equal(realSource.code, 'SOURCE_UNAVAILABLE');
  assert.notEqual(stubSource.reason, realSource.reason, 'stub 与 real 的如实原因必须各自可指出');
  assert.ok(stubSource.reason.includes('非音频'), stubSource.reason);
  assert.ok(realSource.reason.includes('契约没有面向客户端的音频出口'), realSource.reason);

  // ④ 静态口径：wxml 必须渲染该提示，且**渲染内容**里没有任何「已播放」表述（注释不算）。
  const wxml = read('miniprogram/pages/voice/voice.wxml');
  assert.ok(/wx:if="\{\{sourceNotice\}\}"/.test(wxml), 'wxml 必须渲染 sourceNotice');
  assert.ok(wxml.includes('{{sourceNotice}}'), 'wxml 必须原样展示该提示文本');
  const wxmlRendered = wxml.replace(/<!--[\s\S]*?-->/g, '');
  assert.equal(wxmlRendered.includes('已播放'), false, '页面渲染内容不得出现「已播放」表述');
  h.page.onUnload();
});

test('缩片·替身走查**显式**开启时：只走控件生命周期、仍不记已听取、且明示不代表已取得可播放来源', async () => {
  const h = bootPage();
  h.page.onSelectSample({ currentTarget: { dataset: { id: 'sample-i13-passed' } } });
  h.page.setData({ substituteWalkthrough: true });
  const pending = h.page.onBroadcast();
  acceptJob(h.requests[0], jobFixture({ suffix: '6' }));
  await pending;

  assert.equal(h.page.data.playbackState, 'playing', '替身走查是**显式**开启的控件生命周期走查');
  assert.equal(h.page.data.substitute, true, '必须如实标记为替身');
  assert.equal(h.page.data.listened, false, '替身没有声音，绝不记「已听取」');
  assert.ok(h.page._plan.every((item) => String(item.src).startsWith('substitute://segment/')), '替身计划的源必须是标注占位，不得是真实音频');
  // 来源口径必须仍在（走查不改变"契约无客户端音频出口"这一事实）。
  assert.ok(h.page.data.sourceNotice.includes('契约无客户端音频出口'), h.page.data.sourceNotice);
  const wxml = read('miniprogram/pages/voice/voice.wxml');
  assert.ok(wxml.includes('不代表已取得可播放来源'), '替身走查提示必须明示它不代表已取得可播放来源');
  h.page.onUnload();
});

test('宿主页·离页（隐藏/卸载）取消在途请求并释放播放器：监听 0、句柄 0、迟到回调无效', async () => {
  const h = bootPage();
  h.page.onSelectSample({ currentTarget: { dataset: { id: 'sample-i13-passed' } } });
  // 缩片（`ruling-451`）起：替身走查**默认关闭**（默认下页面如实走"无可播放来源"出口，
  // 不显示「正在播报」）。本用例的意图是"释放一份**活动**的播报计划"，因此**显式**开启走查开关。
  h.page.setData({ substituteWalkthrough: true });
  const job = {
    id: '00000000-0000-4000-8000-000000000009',
    revision: 3,
    kind: 'synthesis',
    target_ref: { type: 'answer', id: 'sample-i13-passed', revision: 1 },
    state: 'succeeded',
    deadline_at: '2026-10-14T06:00:30.000Z',
    created_at: '2026-10-14T06:00:00.000Z',
    error_code: null,
    result: {
      kind: 'synthesis',
      value: {
        id: '00000000-0000-4000-8000-00000000000a',
        revision: 1,
        checked_content_ref: { type: 'answer', id: 'sample-i13-passed', revision: 1 },
        media_id: '00000000-0000-4000-8000-00000000000b'
      }
    }
  };
  const pending = h.page.onBroadcast();
  assert.equal(h.requests.length, 1);
  h.requests[0].success({
    statusCode: 202,
    data: { data: job, meta: { request_id: job.id, contract_version: '1.0.0', execution_mode: 'stub' } },
    header: { ETag: '"3"' }
  });
  await pending;

  const controller = h.page._controller;
  assert.ok(controller, '进入播放段必须已建控制器');
  assert.ok(h.page._plan.length > 0, '替身走查下应给出替身播报计划');
  assert.equal(controller.isReleased(), false);

  h.page.onHide();
  assert.equal(h.page._controller, null, '离页必须释放控制器');
  assert.equal(controller.isReleased(), true);
  assert.equal(controller.listenerCount(), 0, '离页后监听必须为 0');
  assert.equal(controller.snapshot().state, 'idle');
  assert.equal(h.page.data.exitReason, 'hide');
  assert.equal(h.page.data.listened, false);
  // 迟到的播放请求不得复活（也不会把页面改回"在播"）
  assert.equal(controller.play('late.mp3').code, 'RELEASED');
  assert.equal(h.page.data.playbackState, 'idle');

  // 负例·在途请求作废：先提交（请求在途），再离页，然后才收到响应 ⇒ 不得进入播放段
  const late = h.page.onBroadcast();
  assert.equal(h.requests.length, 2);
  h.page.onHide(); // 在途期间离页：客户端代次 + 在途代次一并前移
  const stageBefore = h.page.data.stage;
  h.requests[1].success({
    statusCode: 202,
    data: { data: job, meta: { request_id: job.id, contract_version: '1.0.0', execution_mode: 'stub' } },
    header: { ETag: '"3"' }
  });
  await late;
  assert.equal(h.page._controller, null, '在途请求作废后不得进入播放段');
  assert.equal(h.page.data.playbackState, 'idle');
  assert.equal(h.page.data.stage, stageBefore, '作废的迟到响应不得推进阶段');
  assert.equal(h.page.data.listened, false);

  h.page.onUnload();
  assert.equal(h.page.data.exitReason, 'unload');
});

test('宿主页·录音控件与播报控件分离，且录音如实标注未接线（不调用任何录音能力）', () => {
  const js = read('miniprogram/pages/voice/voice.js');
  const wxml = read('miniprogram/pages/voice/voice.wxml');
  assert.equal(/getRecorderManager/.test(js), false, '未接线时不得调用录音能力');
  assert.ok(/bindtap="onRecord"/.test(wxml), '录音入口必须是独立控件');
  assert.ok(/bindtap="onBroadcast"/.test(wxml), '提交（合成）入口必须存在');
  assert.equal(/hasRecording/.test(wxml), false, '录音未接线：不得假装有录音可播');
});

// ============================================================ 6. 静态可访问性 / 布局 / 清单一致

test('无障碍·语音球与四个等效按钮都有 aria-role/aria-label（可被读屏识别）', () => {
  const wxml = read('miniprogram/components/gy-voice-ball/gy-voice-ball.wxml');
  const roles = wxml.match(/aria-role="button"/g) || [];
  assert.ok(roles.length >= 6, `语音球 + 播放/暂停/停止/重播 + 主动播放按钮都需 aria-role，实际 ${roles.length}`);
  const labels = wxml.match(/aria-label="/g) || [];
  assert.ok(labels.length >= 6, `实际 aria-label 数量 ${labels.length}`);
  for (const text of ['播放', '暂停', '停止', '重播']) {
    assert.ok(wxml.includes(`aria-label="${text}播报"`), `缺少 ${text} 按钮的可读名称`);
  }
  assert.ok(/voice-ball__state/.test(wxml), '语音球必须以文字说明当前状态（不只靠颜色）');
});

test('布局·控件走正常文档流（无 fixed/absolute）、触控下限用 px 令牌、字号随 --font-scale', () => {
  const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
  const componentCss = stripComments(read('miniprogram/components/gy-voice-ball/gy-voice-ball.wxss'));
  const pageCss = stripComments(read('miniprogram/pages/voice/voice.wxss'));
  for (const css of [componentCss, pageCss]) {
    assert.equal(/position\s*:\s*(fixed|absolute)/.test(css), false, '控件不得使用 fixed/absolute（会遮挡提交按钮或风险信息）');
    assert.ok(/var\(--tap-min,\s*44px\)/.test(css), '触控下限必须用 var(--tap-min, 44px) 形态');
    assert.equal(/min-(height|width)\s*:\s*[\d.]+rpx/.test(css), false, '触控下限不得用 rpx（320px 窄屏会缩水）');
    assert.ok(/var\(--font-scale/.test(css), '字号必须随 --font-scale 放大');
    assert.equal(/white-space\s*:\s*nowrap/.test(css), false, '不得用 nowrap 裁切放大后的文字');
  }
});

test('布局·播报控件在提交按钮与风险信息之后（DOM 顺序即不遮挡判据）', () => {
  const wxml = read('miniprogram/pages/voice/voice.wxml');
  const notice = wxml.indexOf('notice--danger');
  const submit = wxml.indexOf('bindtap="onBroadcast"');
  const ball = wxml.indexOf('<gy-voice-ball');
  assert.ok(notice !== -1 && submit !== -1 && ball !== -1);
  assert.ok(notice < submit, '风险信息必须在提交按钮之前');
  assert.ok(submit < ball, '播报控件必须在提交按钮之后（不遮挡提交入口）');
  assert.ok(wxml.indexOf('语音球 · 播放/暂停/停止/重播') < ball, '控件区标题须在控件之前，便于读屏顺序');
});

test('文案·新增文件不含绝对化风险表述', () => {
  const banned = ['绝对安全', '零风险', '保证无害', '百分百有效', '无副作用', '包治'];
  for (const file of [
    'miniprogram/pages/voice/voice.wxml',
    'miniprogram/pages/voice/voice.js',
    'miniprogram/components/gy-voice-ball/gy-voice-ball.wxml',
    'miniprogram/components/gy-voice-ball/gy-voice-ball.js',
    'miniprogram/utils/speech-text.js',
    'miniprogram/utils/audio-playback.js',
    'miniprogram/utils/voice-api.js'
  ]) {
    const content = read(file).replace(/<!--[\s\S]*?-->/g, '');
    for (const phrase of banned) assert.equal(content.includes(phrase), false, `${file} 出现禁止表述：${phrase}`);
  }
});

test('清单·三处页面清单逐项一致（app.json.pages / navigation.PAGES / prepare-wechat 白名单）', () => {
  const app = JSON.parse(read('miniprogram/app.json'));
  const nav = requireHere('../../miniprogram/utils/navigation.js');
  assert.deepEqual(nav.PAGES, app.pages, 'navigation.PAGES 必须与 app.json.pages 逐项一致');
  assert.equal(app.pages.includes('pages/voice/voice'), true);
  assert.equal(nav.TAB_PAGES.includes('pages/voice/voice'), false, '播报页不是底部 Tab');

  const prepare = read('tools/prepare-wechat.mjs');
  const block = prepare.slice(prepare.indexOf('const pages = ['), prepare.indexOf('];', prepare.indexOf('const pages = [')));
  for (const page of app.pages) {
    assert.ok(block.includes(`'${page}'`), `prepare-wechat 白名单缺少 ${page}`);
  }
  for (const dep of [
    'utils/speech-text.js', 'utils/audio-playback.js', 'utils/inner-audio-port.js',
    'utils/substitute-player.js', 'utils/voice-api.js', 'components/gy-voice-ball/gy-voice-ball.js'
  ]) {
    assert.ok(prepare.includes(`'${dep}'`) || prepare.includes('${name}'), `prepare-wechat 缺少依赖 ${dep}`);
  }
});

test('页面可被标准包加载：页面与组件的四个文件齐备且 json 合法（CJS，无 ESM 语法）', () => {
  for (const file of ['voice.js', 'voice.json', 'voice.wxml', 'voice.wxss']) {
    assert.ok(read(`miniprogram/pages/voice/${file}`).length > 0, `缺少 pages/voice/${file}`);
  }
  for (const file of ['gy-voice-ball.js', 'gy-voice-ball.json', 'gy-voice-ball.wxml', 'gy-voice-ball.wxss']) {
    assert.ok(read(`miniprogram/components/gy-voice-ball/${file}`).length > 0, `缺少 components/gy-voice-ball/${file}`);
  }
  const pageJson = JSON.parse(read('miniprogram/pages/voice/voice.json'));
  assert.equal(pageJson.usingComponents['gy-voice-ball'], '/components/gy-voice-ball/gy-voice-ball');
  const componentJson = JSON.parse(read('miniprogram/components/gy-voice-ball/gy-voice-ball.json'));
  assert.equal(componentJson.component, true);
  const js = read('miniprogram/pages/voice/voice.js');
  assert.equal(/^\s*(import|export)\s/m.test(js), false, '页面必须是 CJS（标准包用 require 加载）');
  assert.equal(/createInnerAudioContext/.test(js), false, '页面不得直接引用平台音频能力（只能经注入端口）');
});
