/**
 * GY-I13（#13）**自动播报策略**：用户可关 + 同一页同一版本只自动播报一次 + fail-closed。
 *
 * 范围（刻意收窄，不越界）：
 * - 只测 `miniprogram/utils/speech-autoplay.js`（纯判定 + 注入存储）；不合成、不产生音频、不访问网络；
 * - 不涉及契约（`packages/contracts/**` 只读）、不新增/不扩展任何契约 `ErrorCode`：
 *   本模块的原因码是**客户端本地**小写连字符码，永不出客户端（用例 9 逐条钉住这一点）；
 * - 页面接线只做**源码级**判据（是否经策略判定、被拒时是否仍然播、开关与说明是否渲染）。
 *
 * 判据来源：`docs/architecture/state-contract.md:64`「同一页同一版本自动播报一次，离页/隐藏停止」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const requireHere = createRequire(import.meta.url);

const autoplay = requireHere('../../miniprogram/utils/speech-autoplay.js');

/** 契约形态的版本化引用（与 `voice-api` 的 `checked_content_ref` 同形状）。 */
const REF = { type: 'answer', id: 'sample-i13-passed', revision: 1 };

/** 内存存储端口（**注入**，不触碰 wx）：记录写入，可配置抛错。 */
function memoryStore(initial, options = {}) {
  const state = { raw: initial, writes: [] };
  const store = {
    read() {
      if (options.readThrows) throw new Error('storage boom');
      return state.raw;
    },
    write(value) {
      if (options.writeThrows) throw new Error('storage boom');
      state.writes.push(value);
      state.raw = value;
    }
  };
  return { store, state };
}

function newPolicy(initial, options) {
  const memory = memoryStore(initial, options);
  return { policy: autoplay.createAutoSpeakPolicy({ store: memory.store }), memory };
}

// ---------------------------------------------------------------- 1. 版本键

test('版本键·只接受 type/id/revision 三件齐备且 revision 为 ≥1 整数（其余一律 null，不猜）', () => {
  assert.equal(autoplay.targetKeyFor(REF), 'answer:sample-i13-passed:1');
  assert.equal(autoplay.targetKeyFor({ ...REF, revision: 7 }), 'answer:sample-i13-passed:7');
  assert.equal(autoplay.targetKeyFor({ ...REF, type: 'medication' }), 'medication:sample-i13-passed:1');

  const rejected = [
    ['revision 为字符串（不得把 "1" 当 1）', { ...REF, revision: '1' }],
    ['revision 为小数', { ...REF, revision: 1.5 }],
    ['revision 为 0', { ...REF, revision: 0 }],
    ['revision 为负数', { ...REF, revision: -1 }],
    ['revision 缺失', { type: 'answer', id: 'sample-i13-passed' }],
    ['id 为空白串', { ...REF, id: '   ' }],
    ['id 非字符串', { ...REF, id: 42 }],
    ['type 缺失', { id: 'sample-i13-passed', revision: 1 }],
    ['null', null],
    ['数组', [REF]],
    ['字符串', 'answer:sample-i13-passed:1']
  ];
  for (const [label, ref] of rejected) {
    assert.equal(autoplay.targetKeyFor(ref), null, label);
  }
});

// ---------------------------------------------------------------- 2–5. 判定

test('默认开启·首次合成落定 ⇒ 自动播报（且原因码是客户端本地的 auto-speak-enabled）', () => {
  const { policy } = newPolicy('');
  assert.equal(policy.isEnabled(), true, '读不到偏好（空串）视为未设置 ⇒ 用默认开启');
  const decision = policy.decide({ targetRef: REF, planSize: 2 });
  assert.equal(decision.auto, true);
  assert.equal(decision.code, autoplay.CODES.AUTO);
  assert.equal(decision.targetKey, 'answer:sample-i13-passed:1');
  assert.equal(decision.reason, autoplay.REASON_TEXT['auto-speak-enabled']);
  assert.deepEqual(policy.playedKeys(), [], '判定本身不得预先记账（记账只发生在真的发起播报后）');
});

test('同一页同一版本只自动播报一次：记过之后同键不再自动，换版本/换内容仍自动', () => {
  const { policy } = newPolicy('');
  const first = policy.decide({ targetRef: REF, planSize: 2 });
  assert.equal(first.auto, true);
  policy.markAutoPlayed(first.targetKey);

  const again = policy.decide({ targetRef: REF, planSize: 2 });
  assert.equal(again.auto, false, '同一页同一 revision 不得二次自动出声');
  assert.equal(again.code, autoplay.CODES.ALREADY_PLAYED);
  assert.ok(again.reason.includes('重播'), again.reason);

  assert.equal(policy.decide({ targetRef: { ...REF, revision: 2 }, planSize: 2 }).auto, true, '换 revision 是新版本');
  assert.equal(policy.decide({ targetRef: { ...REF, id: 'answer-other' }, planSize: 2 }).auto, true, '换内容是另一份内容');
  assert.deepEqual(policy.playedKeys(), ['answer:sample-i13-passed:1'], '只记真正播过的那一个版本键');
});

test('用户关闭自动播报 ⇒ 不自动出声，但文案明确“文字照常 + 可用播报按钮主动播放”', () => {
  const { policy, memory } = newPolicy({ enabled: false });
  assert.equal(policy.isEnabled(), false);
  const decision = policy.decide({ targetRef: REF, planSize: 3 });
  assert.equal(decision.auto, false);
  assert.equal(decision.code, autoplay.CODES.USER_DISABLED);
  assert.ok(decision.reason.includes('文字'), decision.reason);
  assert.ok(decision.reason.includes('播放'), decision.reason);
  assert.deepEqual(memory.state.writes, [], '判定不得写存储');

  // 重新打开（同一实例）⇒ 说明文字不再回头播已播过的版本，但新版本可以自动播。
  const turned = policy.setEnabled(true);
  assert.deepEqual(turned, { enabled: true, persisted: true });
  assert.equal(policy.decide({ targetRef: { ...REF, revision: 4 }, planSize: 1 }).auto, true);
});

test('没有可播分段 ⇒ 不自动播报（EMPTY_PLAN 优先于开关）；缺版本化引用 ⇒ 不自动播报（MISSING_TARGET_REF）', () => {
  const { policy } = newPolicy('');
  const empty = policy.decide({ targetRef: REF, planSize: 0 });
  assert.equal(empty.auto, false);
  assert.equal(empty.code, autoplay.CODES.EMPTY_PLAN);
  assert.ok(empty.reason.includes('不伪造音频'), empty.reason);

  const disabledAndEmpty = newPolicy({ enabled: false }).policy.decide({ targetRef: REF, planSize: 0 });
  assert.equal(disabledAndEmpty.code, autoplay.CODES.EMPTY_PLAN, '先报“没有内容可播”这件事实，再谈开关');

  const noRef = policy.decide({ targetRef: null, planSize: 2 });
  assert.equal(noRef.auto, false);
  assert.equal(noRef.code, autoplay.CODES.MISSING_TARGET_REF);
  assert.equal(noRef.targetKey, null);
  assert.ok(noRef.reason.includes('同一页同一版本'), noRef.reason);

  const badRef = policy.decide({ targetRef: { ...REF, revision: '1' }, planSize: 2 });
  assert.equal(badRef.code, autoplay.CODES.MISSING_TARGET_REF, '形态不合法的 revision 不得被当成版本键');
});

// ---------------------------------------------------------------- 6–8. 存储与 fail-closed

test('偏好读不出来（存储抛错）⇒ fail-closed 不自动出声，且如实说明“读不到偏好”', () => {
  const { policy } = newPolicy(undefined, { readThrows: true });
  assert.equal(policy.isEnabled(), false, '读不到偏好不得擅自出声');
  assert.equal(policy.isPreferenceUnreadable(), true);
  const decision = policy.decide({ targetRef: REF, planSize: 2 });
  assert.equal(decision.auto, false);
  assert.equal(decision.code, autoplay.CODES.PREFERENCE_UNREADABLE);
  assert.ok(decision.reason.includes('读不到'), decision.reason);

  // 用户显式打开后该实例恢复（并尝试持久化）。
  const turned = policy.setEnabled(true);
  assert.equal(turned.enabled, true);
  assert.equal(policy.isPreferenceUnreadable(), false);
});

test('偏好形态不认识（字符串/缺字段对象）⇒ 视为“未设置”用默认开启；不误当关闭', () => {
  for (const raw of ['', 'yes', 0, {}, { enabled: 'true' }, []]) {
    const { policy } = newPolicy(raw);
    assert.equal(policy.isEnabled(), true, `形态 ${JSON.stringify(raw)} 应回落到默认开启`);
    assert.equal(policy.isPreferenceUnreadable(), false, '“没有偏好”不是“读不到偏好”');
  }
  assert.equal(newPolicy({ enabled: false }).policy.isEnabled(), false);
  assert.equal(newPolicy(false).policy.isEnabled(), false);
});

test('setEnabled 写成功 ⇒ persisted:true 且只存 {enabled}；写失败 ⇒ persisted:false 但内存生效（不谎称已记住）', () => {
  const ok = newPolicy('');
  assert.deepEqual(ok.policy.setEnabled(false), { enabled: false, persisted: true });
  assert.deepEqual(ok.memory.state.writes, [{ enabled: false }]);
  assert.equal(ok.policy.isEnabled(), false, '写成功的偏好立即生效');

  const failing = newPolicy('', { writeThrows: true });
  assert.deepEqual(failing.policy.setEnabled(false), { enabled: false, persisted: false });
  assert.equal(failing.policy.isEnabled(), false, '写失败也要在当前页面生效');

  // 无存储注入（store 缺省）⇒ 不声称已持久化。
  const noStore = autoplay.createAutoSpeakPolicy();
  assert.equal(noStore.isEnabled(), true);
  assert.deepEqual(noStore.setEnabled(false), { enabled: false, persisted: false });
});

test('markAutoPlayed 幂等且拒绝空键；reset 只清“已自动播报”记录、不动用户偏好', () => {
  const { policy } = newPolicy('');
  assert.deepEqual(policy.markAutoPlayed(''), []);
  assert.deepEqual(policy.markAutoPlayed(null), []);
  policy.markAutoPlayed('a:1:1');
  policy.markAutoPlayed('a:1:1');
  assert.deepEqual(policy.playedKeys(), ['a:1:1']);

  policy.setEnabled(false);
  assert.deepEqual(policy.reset(), []);
  assert.deepEqual(policy.playedKeys(), []);
  assert.equal(policy.isEnabled(), false, 'reset 不得把偏好改回开启');
});

// ---------------------------------------------------------------- 9. 常量纪律

test('常量纪律：存储键稳定、默认开启、原因码是小写连字符的客户端码（不冒充契约 ErrorCode）', () => {
  assert.equal(autoplay.STORAGE_KEY, 'gengyun_speech_autoplay');
  assert.equal(autoplay.DEFAULT_ENABLED, true, 'F12/AC06 要求核对完成后自动播报，默认必须开启');

  const codes = Object.values(autoplay.CODES);
  assert.deepEqual(codes.slice().sort(), [
    'auto-speak-already-played',
    'auto-speak-disabled',
    'auto-speak-empty-plan',
    'auto-speak-enabled',
    'auto-speak-missing-target-ref',
    'auto-speak-preference-unreadable'
  ]);
  for (const code of codes) {
    assert.match(code, /^[a-z]+(-[a-z]+)*$/, `原因码必须是小写连字符：${code}`);
    assert.ok(autoplay.REASON_TEXT[code] && autoplay.REASON_TEXT[code].length > 0, `缺少文案：${code}`);
  }

  // 契约 ErrorCode 是**引号里的** SCREAMING_SNAKE 字面量；本模块一个都不出现（不新增、不扩展契约闭集）。
  // 注意：不扫全大写标识符（`DEFAULT_ENABLED` 这类常量不是错误码），只扫字符串字面量。
  const source = read('miniprogram/utils/speech-autoplay.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/['"`][A-Z][A-Z0-9_]{2,}['"`]/.test(source), false, '源码里不得出现契约风格的 ErrorCode 字面量');
  assert.equal(/ErrorCode/.test(source), false, '不得声明自己是契约错误码');
});

// ---------------------------------------------------------------- 10. 页面接线

test('页面接线·自动播报一律经策略判定：被拒时不启动播报、不留“正在播报”', () => {
  const raw = read('miniprogram/pages/voice/voice.js');
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(/require\('\.\.\/\.\.\/utils\/speech-autoplay'\)/.test(code), '页面必须引入自动播报策略');
  assert.ok(/autoSpeakPolicy\(\)\.decide\(/.test(code), 'afterSynthesis 必须经 decide() 判定是否自动出声');
  assert.ok(/if \(decision\.auto !== true\) return/.test(code), '判定为“不自动”时必须直接返回，不得继续 play()');
  assert.ok(/autoSpeakPolicy\(\)\.markAutoPlayed\(decision\.targetKey\)/.test(code), '真的发起自动播报后才记账');

  // 记账必须发生在 play 之前，且“不自动”的分支里没有任何 play(segments…) 调用。
  const autoBranch = code.slice(code.indexOf('if (decision.auto !== true) return'));
  const playAfterDecision = autoBranch.indexOf('play(segments');
  const markAfterDecision = autoBranch.indexOf('markAutoPlayed');
  assert.ok(markAfterDecision > 0 && playAfterDecision > markAfterDecision, '顺序：判定 → 记账 → 播放');

  const wxml = read('miniprogram/pages/voice/voice.wxml');
  assert.ok(/bindtap="onToggleAutoSpeak"/.test(wxml), '必须有关得掉的自动播报开关');
  assert.ok(/\{\{autoSpeakNote\}\}/.test(wxml), '判定原因必须渲染给用户看（可见即可审）');
  assert.ok(/\{\{autoSpeakEnabled \? '关闭自动播报' : '开启自动播报'\}\}/.test(wxml), '开关文案必须与当前状态一致');
});

test('页面接线·自动播报偏好随页面作用域重置（换页面/重建页面不得沿用“已播过”的记账）', () => {
  const raw = read('miniprogram/pages/voice/voice.js');
  assert.ok(/this\._autoSpeak = null/.test(raw), 'onLoad 必须把策略实例置空（页面作用域）');
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/speechAutoplay\.createAutoSpeakPolicy\(\{[^}]*played/.test(code), false, '不得把“已播过”持久化到存储');
  assert.equal(code.includes('setStorageSync'), false, '页面不得直接写存储（只能经注入的存储端口）');

  const prepare = read('tools/prepare-wechat.mjs');
  assert.ok(prepare.includes("'utils/speech-autoplay.js'"), '标准包依赖清单必须包含新模块（否则 MODULE_NOT_FOUND）');
});
