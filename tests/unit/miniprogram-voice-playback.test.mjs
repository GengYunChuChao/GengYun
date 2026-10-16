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

// ============================================================ 4b. 真实录音端口（GY-I11 语音问答）

/**
 * 探针录音管理器：完全按 `wx.getRecorderManager()` 的事件语义回放，
 * 并把**每一次平台调用**记进 `calls`（判据：确实调用了 `start`/`stop`，而不是切文案）。
 *
 * 可注入的失败面：
 *   - `deny: true`        ⇒ `wx.getSetting` 报 `scope.record=false`；
 *   - `failStart: '…'`    ⇒ `start()` 后立刻抛 `onError`（含授权类文案）；
 *   - `interrupt: true`   ⇒ `start()` 后抛 `onInterruptionBegin`；
 *   - `format`/`duration` ⇒ `onStop` 回传的产物形状（默认 aac / 1234ms）。
 *
 * **`_autoStop()`：平台自行停止（`duration` 上限到达／系统回收）** —— 按平台语义，此时
 * `onStop` 会被触发**而不经调用方 `stop()`**。这是唯一能结构上覆盖"平台自动停止"的形态：
 * 若替身只会在被调 `stop()` 时回 `onStop`，该分支根本无法被测到。
 *
 * 本探针**不产生任何音频**、不访问麦克风。
 */
function observableRecorderManager(options = {}) {
  const calls = [];
  const handlers = {};
  let recording = false;
  let lastStart = null;
  /** 产物形状：显式给出的 override **优先**（含显式空串 ⇒ 用于构造"平台未返回文件"的反例）。 */
  const pick = (overrides, key, fallback) => {
    if (Object.prototype.hasOwnProperty.call(overrides, key)) return overrides[key];
    if (Object.prototype.hasOwnProperty.call(options, key)) return options[key];
    return fallback;
  };
  const productOf = (overrides = {}) => ({
    tempFilePath: pick(overrides, 'tempFilePath', 'wxfile://tmp/voice-question-test.aac'),
    duration: Number.isFinite(pick(overrides, 'duration', NaN)) ? pick(overrides, 'duration', NaN) : 1234,
    fileSize: Number.isFinite(pick(overrides, 'fileSize', NaN)) ? pick(overrides, 'fileSize', NaN) : 4096,
    format: pick(overrides, 'format', 'aac')
  });
  const manager = {
    onStart: (fn) => { handlers.start = fn },
    onStop: (fn) => { handlers.stop = fn },
    onError: (fn) => { handlers.error = fn },
    onInterruptionBegin: (fn) => { handlers.interruption = fn },
    offStop: () => { delete handlers.stop },
    offError: () => { delete handlers.error },
    offInterruptionBegin: () => { delete handlers.interruption },
    start: (opts) => {
      calls.push({ api: 'start', options: opts });
      lastStart = opts;
      recording = true;
      if (options.failStart) { if (handlers.error) handlers.error({ errMsg: options.failStart }); return }
      if (options.interrupt) { if (handlers.interruption) handlers.interruption({ errMsg: 'recorder interruption begin' }); return }
      if (handlers.start) handlers.start({});
    },
    stop: () => {
      calls.push({ api: 'stop' });
      if (!recording) return;
      recording = false;
      if (handlers.stop) handlers.stop(productOf());
    },
    /**
     * 平台**自行**停止（录满 `duration` 上限／系统回收）：记为 `autoStop`，
     * 与调用方的 `stop()` 在 `_calls` 里**可区分**（用于证明"这次确实不是我们停的"）。
     */
    _autoStop: (overrides = {}) => {
      calls.push({ api: 'autoStop' });
      if (!recording) return;
      recording = false;
      if (handlers.stop) handlers.stop(productOf(overrides));
    },
    /**
     * 平台**自行**报错（录音开始后系统回收麦克风等）：同样**不经**调用方 `stop()`。
     * 用于验证"没有在途 stop() 时结果也**不得**被吞"。
     */
    _autoError: (errMsg) => {
      calls.push({ api: 'autoError' });
      if (!recording) return;
      recording = false;
      if (handlers.error) handlers.error({ errMsg: typeof errMsg === 'string' ? errMsg : 'operateRecorder:fail system error' });
    },
    isRecording: () => recording,
    _calls: calls,
    _lastStart: () => lastStart
  };
  return manager;
}

// ============================================================ 5. 宿主页行为（离页取消与释放、零请求）

/** 在受控环境里加载真实页面/工具模块（依赖通过 vm 注入，模块本身是仓库里的真代码）。 */
function loadPageHarness(options = {}) {
  const requests = [];
  const toasts = [];
  const sets = [];
  const recorder = options.recorder || observableRecorderManager(options.recorderOptions || {});
  /** 平台调用序列（`getRecorderManager` + 管理器上的 start/stop）。 */
  const wxCalls = [];

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
  /** 服务端执行模式探针（`identify-api.serverMode` 经 `GET /public/home` 的 meta 读出）。 */
  const serverMode = options.serverMode === undefined ? 'real' : options.serverMode;

  const fakeWx = {
    request: (o) => { requests.push(o); },
    getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop' } }),
    showToast: (o) => { toasts.push(o); },
    getStorageSync: () => '',
    setStorageSync: () => {},
    removeStorageSync: () => {},
    getSetting: (o) => { if (o && o.success) o.success({ authSetting: { 'scope.record': options.recorderOptions && options.recorderOptions.deny ? false : true } }) },
    getRecorderManager: () => { wxCalls.push({ api: 'getRecorderManager' }); return recorder },
    getFileSystemManager: () => ({ readFile: (o) => { if (o && o.success) o.success({ data: 'SYNTHETIC_AUDIO_BYTES' }) } }),
    getFileInfo: (o) => {
      if (o && o.success) o.success({ size: options.fileSize === undefined ? 4096 : options.fileSize, digest: 'a'.repeat(64) });
    }
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
    // GY-I11：录音端口是**真代码**（内含真实的 wx.getRecorderManager 调用），只把平台换成探针。
    if (base === 'recorder-port') return loadReal(bySuffix('recorder-port.js'), resolveDep);
    // 上传链路：`uploadVoiceQuestion` 的真实实现（requests/wxCalls 记录其发出的每一个请求）。
    if (base === 'identify-api') return identifyApi;
    throw new Error('unexpected require: ' + id);
  };

  /**
   * 上传链路探针：**逐字镜像** `utils/identify-api.js` 对页面暴露的 `uploadVoiceQuestion` 契约
   * （同样的入参形状与 `{ mediaId, mediaRevision }` 出参），并记录页面真正发出的每一个请求。
   *
   * 它**不**代替被测对象：被测的是页面「按用途 voice_question + 带 duration_ms」的调用形状；
   * 真实 3 段上传流程（createUpload → PUT → completeUpload）由
   * `tests/unit/miniprogram-identify.test.mjs` 对同一份实现断言（本片在那里补音频用例）。
   */
  let uploadCount = 0;
  /**
   * `deferredUpload: true` ⇒ 上传**保持在途**（不自动落定），由用例用 `deferredOf()` 决定何时
   * resolve/reject。这是覆盖「上传中离页」「上传中 401」的必要形态：上传必须真的挂在那里。
   */
  let deferred = null;
  const identifyApi = {
    VOICE_MEDIA_PURPOSE: 'voice_question',
    serverMode: () => Promise.resolve(serverMode),
    uploadVoiceQuestion: (tempFilePath, declaration) => {
      uploadCount += 1;
      requests.push({ stage: 'uploadVoiceQuestion', tempFilePath, declaration: Object.assign({}, declaration) });
      if (options.uploadError) {
        const e = new Error(options.uploadError.code);
        e.code = options.uploadError.code;
        e.status = options.uploadError.status;
        return Promise.reject(e);
      }
      if (options.deferredUpload === true) {
        return new Promise((resolve, reject) => { deferred = { resolve, reject } });
      }
      return Promise.resolve({ mediaId: '00000000-0000-4000-8000-0000000000vv', mediaRevision: 1 });
    }
  };

  // `wx` 必须在**模块加载期与调用期**都可见（voice-api/recorder-port/identify-api 在调用时读 `typeof wx`）。
  globalThis.wx = fakeWx;
  try {
    let definition = null;
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
    return {
      page, requests, toasts, sets, auth, runtime, wx: fakeWx,
      recorder, recorderOptions: options.recorderOptions || {}, wxCalls,
      uploads: () => uploadCount,
      deferredOf: () => deferred,
      /** 端口模块本体（与页面用的是**同一份** vm 内实例）：用于端口层确定性用例。 */
      portModule: loadReal(bySuffix('recorder-port.js'), resolveDep)
    };
  } finally {
    delete globalThis.wx;
  }
}

function bootPage(options = {}) {
  const harness = loadPageHarness(options);
  globalThis.wx = harness.wx;
  harness.page.onLoad();
  harness.page.onShow();
  return harness;
}

/** 把在途 promise 链推到底（`setImmediate` 之间微任务会被排干，比单纯 `await` 更可靠）。 */
async function flushMicrotasks(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * 录音按钮是否禁用：**直接取 `voice.wxml` 的 `disabled` 表达式**并按同一判据求值
 * （不复制语义：表达式若被改动，本辅助函数会先失败）。
 */
function recordButtonDisabled(page) {
  const wxml = read('miniprogram/pages/voice/voice.wxml');
  const match = /disabled="\{\{(guest \|\| recordState === 'uploading')\}\}"/.exec(wxml);
  assert.ok(match, '录音按钮的 disabled 表达式必须仍是 guest || recordState === \'uploading\'');
  return page.data.guest === true || page.data.recordState === 'uploading';
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

test('宿主页·离页（隐藏/卸载）取消在途请求并释放播放器：监听 0、句柄 0、迟到回调无效', async () => {
  const h = bootPage();
  h.page.onSelectSample({ currentTarget: { dataset: { id: 'sample-i13-passed' } } });
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

test('宿主页·录音控件与播报控件分离（独立入口/独立状态，页面仍不直接引用平台录音与播放能力）', () => {
  const raw = read('miniprogram/pages/voice/voice.js');
  // 只检查**代码**：注释里出现平台 API 名字是说明，不是调用（本片新增的注释就解释了端口边界）。
  const js = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const wxml = read('miniprogram/pages/voice/voice.wxml');
  assert.ok(/bindtap="onRecord"/.test(wxml), '录音入口必须是独立控件');
  assert.ok(/bindtap="onBroadcast"/.test(wxml), '提交（合成）入口必须存在');
  // 分离判据：录音态与播报态是两组互不复用的 data 键。
  assert.ok(/recording/.test(js) && /playbackState/.test(js), '录音态与播报态必须各自独立');
  // 只禁「真的调用」：注释与用户可见文案里出现能力名字是说明，不是调用。
  assert.equal(/wx\.getRecorderManager\s*\(/.test(js), false, '页面不得直接调用平台录音能力（只能经 recorder-port）');
  assert.equal(/wx\.createInnerAudioContext\s*\(/.test(js), false, '页面不得直接调用平台音频播放能力（只能经注入端口）');
  assert.equal(/recordNote:\s*RECORD_NOTE/.test(js), true, '录音说明必须由页面常量给出（含麦克风授权口径）');
  // 端口是**唯一**引用平台录音 API 的地方（可复核：其它 miniprogram 代码一次都不出现）。
  const port = read('miniprogram/utils/recorder-port.js');
  assert.ok(/wx\.getRecorderManager\(\)/.test(port), '唯一出现处必须是 recorder-port');
});

// ============================================================ 5b. GY-I11 真实录音 + 按用途上传（验收 1–4）

test('验收1·探针下桩 wx.getRecorderManager ⇒ 确实调用了 start/stop（贴出真实调用序列）', async () => {
  const h = bootPage();
  assert.equal(h.page.data.recordSupported, true, '探针提供 getRecorderManager ⇒ 能力自述应为可用');

  await h.page.onRecord();
  assert.equal(h.page.data.recording, true, '端口真的开始后才进入录音态');
  assert.equal(h.page.data.recordState, 'recording');
  assert.equal(h.recorder.isRecording(), true, '平台录音器必须真的在录');

  const start = h.recorder._lastStart();
  assert.equal(start.format, 'aac', '编码必须是契约允许的 aac（容器 m4a ⇒ audio/aac）');
  assert.equal(start.duration, 60000, '时长上限必须由契约收口（duration_ms.maximum = 60000）');
  assert.equal(start.numberOfChannels, 1, '单声道');
  assert.equal(start.sampleRate, 16000);

  await h.page.onRecord();
  assert.equal(h.page.data.recording, false);
  const sequence = h.wxCalls.concat(h.recorder._calls).map((c) => c.api);
  assert.deepEqual(sequence, ['getRecorderManager', 'start', 'stop'], '调用序列：' + JSON.stringify(sequence));
  assert.equal(h.page.data.recordState, 'stopped', '录音完成后应落在「已录音」态');
  assert.equal(h.page.data.recordDurationMs, 1234, '时长必须取平台 onStop 的真实 duration');
  assert.equal(h.page.data.hasRecording, true);
  h.page.onUnload();
});

test('验收1反例·拒绝授权 ⇒ 无 start、有如实提示（不假装在录）', async () => {
  const h = bootPage({ recorderOptions: { deny: true } });
  await h.page.onRecord();

  assert.equal(h.recorder._calls.filter((c) => c.api === 'start').length, 0, '授权被拒时不得调用 start');
  assert.equal(h.recorder.isRecording(), false, '授权被拒时平台录音器不得处于录音中');
  assert.equal(h.page.data.recording, false, '不得假装在录');
  assert.equal(h.page.data.recordState, 'failed', '必须落在可分辨的失败态');
  assert.equal(h.page.data.recordStageNote.includes('麦克风授权被拒绝'), true, h.page.data.recordStageNote);
  assert.equal(h.page.data.recordStageNote.includes('没有开始录音'), true);
  assert.equal(h.page.data.uploadErrorCode, 'RECORD_AUTH_DENIED');
  assert.equal(h.requests.length, 0, '拒绝授权不得发出任何上传请求');
  assert.equal(h.page.data.uploadedMediaId, null, '不得伪造 media_id');
  h.page.onUnload();
});

test('验收1反例·录音启动失败/中断 ⇒ 如实呈现，不伪造「已录音」', async () => {
  for (const scenario of [
    { options: { failStart: 'operateRecorder:fail auth deny' }, code: 'RECORD_AUTH_DENIED', expect: '麦克风授权被拒绝' },
    { options: { failStart: 'operateRecorder:fail system error' }, code: 'RECORD_FAILED', expect: '录音未能完成' },
    { options: { interrupt: true }, code: 'RECORD_INTERRUPTED', expect: '录音被中断' }
  ]) {
    const h = bootPage({ recorderOptions: scenario.options });
    await h.page.onRecord();
    assert.equal(h.page.data.recordState, 'failed', JSON.stringify(scenario.options));
    assert.equal(h.page.data.recording, false);
    assert.equal(h.page.data.hasRecording, false, '失败不得留下"有录音可播"的假象');
    assert.equal(h.page.data.uploadErrorCode, scenario.code);
    assert.equal(h.page.data.recordStageNote.includes(scenario.expect), true, h.page.data.recordStageNote);
    assert.equal(h.requests.length, 0);
    h.page.onUnload();
  }
});

test('验收2·上传参数：purpose=voice_question 在场且带真实 duration_ms（贴请求摘要，不打印音频体）', async () => {
  const h = bootPage({ recorderOptions: { duration: 4321, format: 'aac' } });
  await h.page.onRecord();
  await h.page.onRecord();

  assert.equal(h.uploads(), 1, '恰好多一次上传调用');
  const upload = h.requests.filter((r) => r.stage === 'uploadVoiceQuestion')[0];
  assert.ok(upload, '必须经既有私有媒体上传通道（uploadVoiceQuestion）');
  assert.equal(upload.tempFilePath, 'wxfile://tmp/voice-question-test.aac', '上传的是平台真实产物路径');
  assert.equal(upload.declaration.mime, 'audio/aac');
  assert.equal(upload.declaration.durationMs, 4321, 'duration_ms 必须是平台真实时长');
  assert.equal(upload.declaration.bytes, 4096, 'bytes 来自 wx.getFileInfo');
  assert.equal(upload.declaration.sha256, 'a'.repeat(64), 'sha256 来自 wx.getFileInfo');
  // 上传链路只被喂了这四个声明字段：不新造字段、不打印任何二进制体。
  assert.deepEqual(Object.keys(upload.declaration).sort(), ['bytes', 'durationMs', 'mime', 'sha256']);
  assert.equal(h.page.data.uploadedPurpose, 'voice_question', '用途必须是契约既有成员 voice_question');
  assert.equal(h.page.data.uploadedMediaId, '00000000-0000-4000-8000-0000000000vv');
  assert.equal(h.page.data.recordStageNote.includes('voice_question'), true);
  assert.equal(h.page.data.recordStageNote.includes('已回答'), true, '必须显式声明本页不显示「已回答」一类结论');
  h.page.onUnload();
});

test('验收2·上传前预检：时长/字节超契约上限 ⇒ 零请求、如实提示（服务端必拒的不发出去）', async () => {
  const h = bootPage({ recorderOptions: { duration: 60001 }, fileSize: 10 * 1048576 + 1 });
  await h.page.onRecord();
  await h.page.onRecord();
  assert.equal(h.requests.filter((r) => r.stage === 'uploadVoiceQuestion').length, 0, '超时长上限不得发出上传请求');
  assert.equal(h.page.data.recordState, 'failed');
  assert.equal(h.page.data.uploadErrorCode, 'INVALID_INPUT');
  assert.equal(h.page.data.recordStageNote.includes('超过契约上限'), true, h.page.data.recordStageNote);

  const oversized = bootPage({ fileSize: 10 * 1048576 + 1 * 1048576 });
  oversized.page.setData({ recordDurationMs: 0 });
  await oversized.page.onRecord();
  await oversized.page.onRecord();
  assert.equal(oversized.requests.filter((r) => r.stage === 'uploadVoiceQuestion').length, 0, '超字节上限不得发出上传请求');
  assert.equal(oversized.page.data.uploadErrorCode, 'MEDIA_TOO_LARGE');
  assert.equal(oversized.page.data.recordStageNote.includes('超过用途上限'), true, oversized.page.data.recordStageNote);
  h.page.onUnload();
  oversized.page.onUnload();
});

test('验收2·非 real 执行模式（真实对象存储未接线）⇒ 不上传、不伪造 media_id、如实标注「待接线」', async () => {
  const h = bootPage({ serverMode: 'stub' });
  await h.page.onRecord();
  await h.page.onRecord();
  assert.equal(h.uploads(), 0, '非 real 模式不得上传');
  assert.equal(h.page.data.uploadedMediaId, null, '不得伪造 media_id');
  assert.equal(h.page.data.recordState, 'stopped');
  assert.equal(h.page.data.recordStageNote.includes('stub'), true);
  assert.equal(h.page.data.recordStageNote.includes('真实对象存储未接线'), true, h.page.data.recordStageNote);
  assert.equal(h.page.data.recordStageNote.includes('没有上传'), true);
  h.page.onUnload();
});

test('验收3·失败态按契约错误码如实归因：503/413/415/403(CONSENT_REQUIRED)/403(SCOPE_DENIED) 文案各不相同', async () => {
  const cases = [
    { code: 'PROVIDER_UNAVAILABLE', status: 503, must: '真实对象存储未接线', mustNot: '网络' },
    { code: 'MEDIA_TOO_LARGE', status: 413, must: '≤10 MiB', mustNot: '网络' },
    { code: 'MEDIA_TYPE_UNSUPPORTED', status: 415, must: '仅 MP3 / WAV / AAC', mustNot: '登录' },
    { code: 'CONSENT_REQUIRED', status: 403, must: '缺少用途授权', mustNot: '登录状态已失效' },
    { code: 'SCOPE_DENIED', status: 403, must: '无权使用该能力', mustNot: '登录状态已失效' }
  ];
  const seen = new Map();
  for (const item of cases) {
    const h = bootPage({ uploadError: { code: item.code, status: item.status } });
    await h.page.onRecord();
    await h.page.onRecord();
    const note = h.page.data.recordStageNote;
    assert.equal(h.page.data.recordState, 'failed', item.code);
    assert.equal(h.page.data.uploadErrorCode, item.code, '错误码必须原样带出：' + item.code);
    assert.equal(note.includes(item.must), true, `${item.code} 文案缺少「${item.must}」：${note}`);
    assert.equal(note.includes(item.mustNot), false, `${item.code} 文案不得含「${item.mustNot}」：${note}`);
    assert.equal(h.page.data.uploadedMediaId, null, '失败不得伪造 media_id');
    seen.set(item.code, note);
    h.page.onUnload();
  }
  // 两个 403 必须**各不相同**，且都不是"登录失效"。
  assert.notEqual(seen.get('CONSENT_REQUIRED'), seen.get('SCOPE_DENIED'), '两类 403 不得折叠成同一句');
  for (const note of seen.values()) {
    assert.equal(note.includes('登录状态已失效'), false, '不得把所有 403 说成「登录失效」：' + note);
  }
  assert.equal(new Set(seen.values()).size, cases.length, '五种失败态文案必须两两不同');
});

test('验收4·录音中触发出页 ⇒ stop 被调用、计时器清零、无残留挂起状态（贴输出）', async () => {
  const h = bootPage();
  await h.page.onRecord();
  assert.equal(h.recorder.isRecording(), true);
  const timerBefore = h.page._recTimer;
  assert.ok(timerBefore !== null && timerBefore !== undefined, '录音中应存在已录计时器');

  h.page.onUnload();
  const sequence = h.wxCalls.concat(h.recorder._calls).map((c) => c.api);
  assert.deepEqual(sequence, ['getRecorderManager', 'start', 'stop'], '出页必须调用 stop：' + JSON.stringify(sequence));
  assert.equal(h.page._recTimer, null, '离页不得残留计时器');
  assert.equal(h.page._recorder, null, '离页必须释放录音端口');
  assert.equal(h.page.data.recording, false, '离页不得留「录音中」挂起态');
  assert.equal(h.page.data.recordState, 'idle');
  assert.equal(h.page.data.exitReason, 'unload');
  assert.equal(h.page.data.recordStageNote.includes('录音已停止并释放麦克风'), true);

  // 出页后再点录音：端口已释放 ⇒ 如实提示，不偷偷重启一个麦克风。
  await h.page.onRecord();
  assert.equal(h.recorder._calls.filter((c) => c.api === 'start').length, 1, '释放后不得再调用 start');
  assert.equal(h.page.data.recording, false);
});

test('验收4·onHide 走同一释放出口（切页/隐藏与返回同口径）', async () => {
  const h = bootPage();
  await h.page.onRecord();
  h.page.onHide();
  const sequence = h.wxCalls.concat(h.recorder._calls).map((c) => c.api);
  assert.deepEqual(sequence, ['getRecorderManager', 'start', 'stop']);
  assert.equal(h.page._recTimer, null);
  assert.equal(h.page.data.exitReason, 'hide');
  assert.equal(h.page.data.recording, false);
});

// ============================================================ 5c. r2 返修：F1 挂起态 / F2 产物被吞

test('验收F1a·上传中 onHide（切走再回）⇒ 录音态复位到可再次录音、清除「上传中」，迟到落定不复活挂起态', async () => {
  const h = bootPage({ deferredUpload: true, recorderOptions: { duration: 4321 } });
  await h.page.onRecord();
  void h.page.onRecord();                       // 停止并进入上传（**不 await**：上传保持挂起）
  await flushMicrotasks();
  assert.equal(h.page.data.recordState, 'uploading', '先确认确实进入「上传中」');
  assert.equal(h.uploads(), 1, '上传已在途');
  assert.equal(recordButtonDisabled(h.page), true, '上传中按钮按 WXML 表达式应为禁用');

  h.page.onHide();                              // ← 上传中切页（改前：recordState 永久残留 uploading）
  assert.equal(h.page.data.recordState, 'idle', '离页不得残留「上传中」');
  assert.equal(h.page.data.recordLabel, '开始录音');
  assert.equal(h.page.data.recording, false);
  assert.equal(h.page.data.recordStageNote.includes('本次上传已作废'), true, h.page.data.recordStageNote);
  assert.equal(h.page.data.recordStageNote.includes('没有上传成功、也没有 media_id'), true);
  assert.equal(h.page.data.uploadedMediaId, null, '不得伪造 media_id');

  h.page.onShow();                              // 切回来
  assert.notEqual(h.page.data.recordState, 'uploading', '回页后不得仍显示「上传中」挂起态');
  assert.equal(recordButtonDisabled(h.page), false, '回页后录音按钮必须可用（不得永久禁用）');

  // 迟到的上传落定：作废的上传不得复活挂起态、也不得写入 media_id。
  h.deferredOf().resolve({ mediaId: '00000000-0000-4000-8000-0000000000vv', mediaRevision: 1 });
  await flushMicrotasks();
  assert.equal(h.page.data.recordState, 'idle', '迟到落定不得复活「上传中」');
  assert.equal(h.page.data.uploadedMediaId, null, '已作废的上传不得写入 media_id');
  assert.equal(recordButtonDisabled(h.page), false, '按钮仍须可用');

  // 关键：复位后**必须真的能再次录音**
  await h.page.onRecord();
  assert.equal(h.page.data.recording, true, '复位后必须可以再次录音');
  assert.equal(h.page.data.recordState, 'recording');
  h.page.onUnload();
});

test('验收F1b·上传中收到 401/会话失效 ⇒ 录音态复位到可再次录音、清除「上传中」，不伪造结果', async () => {
  const h = bootPage({ deferredUpload: true });
  await h.page.onRecord();
  void h.page.onRecord();
  await flushMicrotasks();
  assert.equal(h.page.data.recordState, 'uploading');

  const sessionLost = new Error('SESSION_REQUIRED');
  sessionLost.code = 'SESSION_REQUIRED';
  h.deferredOf().reject(sessionLost);
  await flushMicrotasks();

  assert.equal(h.page.data.recordState, 'idle', '401 后不得残留「上传中」');
  assert.notEqual(h.page.data.recordState, 'uploading');
  assert.equal(h.page.data.recording, false);
  assert.equal(h.page.data.uploadedMediaId, null, '会话失效不得伪造 media_id');
  assert.equal(recordButtonDisabled(h.page), false, '401 后录音按钮不得永久禁用');
  assert.equal(h.page.data.recordStageNote.includes('本次上传已作废'), true, h.page.data.recordStageNote);
  assert.equal(h.page.data.recordStageNote.includes('会话'), true, h.page.data.recordStageNote);
  h.page.onUnload();
});

test('验收F2a·端口层：平台按 duration 自行 onStop（不经 stop()）⇒ 产物存入槽并由下一次 stop() 如实交出', async () => {
  const h = loadPageHarness({ recorderOptions: { duration: 60000 } });
  globalThis.wx = h.wx;
  try {
    const port = h.portModule.createRecorderPort();
    const started = await port.start({ format: 'aac' });
    assert.equal(started.ok, true, 'start 必须成功：' + JSON.stringify(started));

    // 平台**自行**停止：调用方一次都没调 stop()。
    h.recorder._autoStop({ duration: 60000 });
    assert.equal(h.recorder._calls.filter((c) => c.api === 'stop').length, 0, '证明这次不是调用方停的');
    assert.equal(h.recorder._calls.filter((c) => c.api === 'autoStop').length, 1);
    assert.equal(port.isRecording(), false, '端口应已知平台已停止');

    const product = await port.stop();
    assert.equal(product.ok, true, '产物**必须**被接收（不得被吞）：' + JSON.stringify(product));
    assert.equal(product.tempFilePath, 'wxfile://tmp/voice-question-test.aac');
    assert.equal(product.durationMs, 60000, '时长取平台真实值（不是本地计时）');
    assert.equal(product.mime, 'audio/aac');

    // 产物只能被取走一次：不得把同一份结果重复交出。
    const again = await port.stop();
    assert.equal(again.ok, false);
    assert.equal(again.code, 'RECORD_NOT_STARTED');
    port.release();
  } finally {
    delete globalThis.wx;
  }
});

test('验收F2b·页面层：录满上限时平台自动停止 ⇒ 页面到点出口接收产物并**恰一次**上传（duration_ms 为平台值）', async () => {
  const h = bootPage({ recorderOptions: { duration: 60000, format: 'aac' } });
  await h.page.onRecord();
  assert.equal(h.page.data.recording, true);
  assert.equal(h.recorder.isRecording(), true);

  // 平台在 duration 上限处**自行** onStop（这正是真机上先于页面 100ms tick 发生的那条路径）。
  h.recorder._autoStop({ duration: 60000 });
  assert.equal(h.recorder._calls.filter((c) => c.api === 'stop').length, 0, '平台自行停止：调用方未调 stop()');
  assert.equal(h.recorder.isRecording(), false);
  assert.equal(h.uploads(), 0, '此刻页面尚未到点，还没有上传');

  // 页面"到达上限"的出口 —— 与 100ms tick 到 60000ms 时调用的是**同一个**函数。
  await h.page.stopAndUpload();

  assert.equal(h.uploads(), 1, '产物必须被接收并上传，**恰一次**');
  const upload = h.requests.filter((r) => r.stage === 'uploadVoiceQuestion')[0];
  assert.ok(upload, '必须走既有私有媒体上传通道');
  assert.equal(upload.declaration.durationMs, 60000, 'duration_ms 仍取平台真实值');
  assert.equal(upload.declaration.mime, 'audio/aac');
  assert.equal(h.page.data.recordDurationMs, 60000);
  assert.equal(h.page.data.recordState, 'stopped', '应落在「已录音」而非失败态');
  assert.equal(h.page.data.uploadErrorCode, '', '不得出现任何失败码');
  assert.equal(/没有正在进行的录音/.test(h.page.data.recordStageNote), false,
    '不得把"已录满"说成"没有正在进行的录音"：' + h.page.data.recordStageNote);
  assert.equal(h.page.data.uploadedMediaId, '00000000-0000-4000-8000-0000000000vv');
  h.page.onUnload();
});

test('验收F2c·页面层：平台自动停止且产物不可用（无文件）⇒ 如实失败，不伪造上传', async () => {
  const h = bootPage({ recorderOptions: { duration: 60000 } });
  await h.page.onRecord();
  h.recorder._autoStop({ duration: 60000, tempFilePath: '' });
  assert.equal(h.recorder._calls.filter((c) => c.api === 'stop').length, 0);
  await h.page.stopAndUpload();
  assert.equal(h.uploads(), 0, '无产物不得上传');
  assert.equal(h.page.data.recordState, 'failed');
  assert.equal(h.page.data.recordStageNote.includes('录音未能完成'), true, h.page.data.recordStageNote);
  assert.equal(h.page.data.uploadedMediaId, null);
  h.page.onUnload();
});

test('验收F2d·端口层：cancel() 后平台回传的产物一律丢弃（不得交给下一次 stop()）', async () => {
  const h = loadPageHarness({ recorderOptions: { duration: 60000 } });
  globalThis.wx = h.wx;
  try {
    const port = h.portModule.createRecorderPort();
    await port.start({ format: 'aac' });
    await port.cancel();
    const after = await port.stop();
    assert.equal(after.ok, false);
    assert.equal(after.code, 'RECORD_NOT_STARTED', '取消后的产物不得被交出：' + JSON.stringify(after));
    port.release();
  } finally {
    delete globalThis.wx;
  }
});

test('验收F2e·端口层：平台自行报错（无在途 stop()）⇒ 结果存入槽并由下一次 stop() 如实交出，不静默丢失', async () => {
  const h = loadPageHarness({ recorderOptions: { duration: 60000 } });
  globalThis.wx = h.wx;
  try {
    const port = h.portModule.createRecorderPort();
    await port.start({ format: 'aac' });
    // 录音开始后平台**自行**报错：没有在途 stop()。
    h.recorder._autoError('operateRecorder:fail system error');
    assert.equal(h.recorder._calls.filter((c) => c.api === 'stop').length, 0, '证明不是调用方停的');
    assert.equal(port.isRecording(), false);

    const outcome = await port.stop();
    assert.equal(outcome.ok, false, '平台报错必须如实交出为失败');
    assert.equal(outcome.code, 'RECORD_FAILED', '失败码如实：' + JSON.stringify(outcome));
    assert.notEqual(outcome.code, 'RECORD_NOT_STARTED', '不得把"平台已报错"说成"没有正在进行的录音"');
    port.release();
  } finally {
    delete globalThis.wx;
  }
});

test('边界·重复 stop / 未录音时 stop ⇒ RECORD_NOT_STARTED（幂等安全，不抛异常、不发请求）', async () => {
  const h = bootPage();
  const port = h.page.ensureRecorder();
  const idle = await port.stop();
  assert.equal(idle.ok, false);
  assert.equal(idle.code, 'RECORD_NOT_STARTED');
  assert.equal(h.recorder._calls.filter((c) => c.api === 'stop').length, 0, '未录音时不得调用平台 stop');

  await h.page.onRecord();
  const first = await port.stop();
  assert.equal(first.ok, true);
  const second = await port.stop();
  assert.equal(second.ok, false, '重复 stop 必须如实失败，不得返回旧产物');
  assert.equal(second.code, 'RECORD_NOT_STARTED');
  h.page.onUnload();
});

test('边界·端口在不支持录音的环境里如实失败（RECORDER_UNAVAILABLE，零采集零上传）', async () => {
  const h = bootPage();
  // 平台缺能力：把探针摘掉（页面必须如实报不可用，而不是假装在录）。
  h.wx.getRecorderManager = undefined;
  h.page._recorder = null;
  h.page.setData({ recordSupported: false });
  await h.page.onRecord();
  assert.equal(h.page.data.recording, false);
  assert.equal(h.page.data.recordState, 'failed');
  assert.equal(h.page.data.uploadErrorCode, 'RECORDER_UNAVAILABLE');
  assert.equal(h.page.data.recordStageNote.includes('不提供录音能力'), true);
  assert.equal(h.requests.length, 0);
  h.page.onUnload();
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
