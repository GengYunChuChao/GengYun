/**
 * GY-I13（#13）**客户端纯函数加固**：只用负例把既有行为钉住。
 *
 * 范围（刻意收窄）：
 * - 只读复用 `miniprogram/utils/speech-text.js`（安全闸门 + 播报计划复核 + 无损分段）与
 *   `miniprogram/utils/audio-playback.js`（播放生命周期控制器，端口注入）；
 * - **不改任何产品文件、不改页面、不改清单**（零 app.json/navigation/prepare-wechat 变更）；
 * - **不含**服务端「已核对内容」接线（`CheckedContentPort` 的"什么算已核对"另行裁定），
 *   **不含**真机、真实 TTS、真实音频（那是 #23）；本文件不产生任何音频、不访问网络。
 *
 * 分层：
 *   A. 闸门 fail-closed 的**载荷纪律**与判定顺序；
 *   B. 逐字复核的**变异模糊**（单点删除/替换/插入，以及"看似等价"的写法一律拒绝）；
 *   C. 分段的**无损与码点上限**（代理对、非法上限、16000 码点边界）；
 *   D. 关键令牌抽取的边界（数字/单位绑定、多否定叠加、全角与异体字符、空/仅符号）；
 *   E. 播放生命周期负例（迟到事件代次守卫、失败后不自行重试、释放后不再建句柄）；
 *   F. 失败分类负例（四要素、不吞原因、`recordsListened` 恒假）；
 *   G. **KNOWN-GAP：已登记缺陷**——断言"当前行为 + 已登记"，不把缺陷当作设计；
 *      修复落地时这些用例会转红，属预期（详见每条注释）。
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

const speechText = requireHere('../../miniprogram/utils/speech-text.js');
const audioPlayback = requireHere('../../miniprogram/utils/audio-playback.js');

/** 含数字、单位、制剂条件与否定词的正例正文（合成夹具，不是真实用药建议）。 */
const SAMPLE = '稗草苗后茎叶处理：每亩用 30 毫升，兑水 30 升常规喷雾。'
  + '不得在高温时段施药，不要与碱性药剂混用；安全间隔期 14 天。';

/** 只含 Latin 单位/比值/区间的抽检行（合成夹具，不是真实用药建议）。 */
const LATIN_LINE = '每亩用 30 毫升/亩，稀释 1:100，用量 300-500ml，另 20% 悬浮剂 30g/亩。';

/**
 * 可完全观测的替身播放端口（测试专用）。三件事是可复核的：
 * 1. `created/destroyed/live/plays` 计数；
 * 2. `deliver(event, payload)` **直接调用控制器注册过的包装器**——绕过退订与销毁，
 *    用来模拟"平台回调已在飞行中/重复投递"的迟到事件（既有替身端口的 `emit` 会被退订
 *    与 destroyed 挡住，因此那条负例其实没有真正打到代次守卫）；
 * 3. `emitPlayOnPlay` / `emitStopOnStop` 控制 `play()` / `stop()` 是否**同步**回发事件。
 */
function spyPlayer(options = {}) {
  const state = { created: 0, destroyed: 0, live: 0, plays: 0 };
  const handles = [];
  const port = {
    kind: 'spy_player',
    substitute: options.substitute === true,
    create(src) {
      state.created += 1;
      state.live += 1;
      let destroyed = false;
      /** 端口当前有效监听：退订会移除、destroy 清空（合规端口的真实投递面）。 */
      const active = [];
      /** 追加式登记：模拟"包装器已被平台捕获、回调正在飞行"的投递面。 */
      const log = [];
      const emitActive = (event, payload) => {
        for (const item of active.slice()) if (item.event === event) item.handler(payload);
      };
      const handle = {
        src,
        isDestroyed: () => destroyed,
        on(event, handler) {
          const item = { event, handler };
          active.push(item);
          log.push(item);
          return () => {
            const at = active.indexOf(item);
            if (at !== -1) active.splice(at, 1);
          };
        },
        play() {
          state.plays += 1;
          if (options.emitPlayOnPlay !== false) emitActive('play');
        },
        pause() { emitActive('pause'); },
        stop() {
          if (options.emitStopOnStop === true) emitActive('stop');
        },
        destroy() {
          if (destroyed) return;
          destroyed = true;
          state.destroyed += 1;
          state.live -= 1;
          active.length = 0;
        },
        /** 测试专用：把迟到/重复事件直接投给控制器包装器（即使已退订/已销毁）。 */
        deliver(event, payload) {
          for (const item of log.slice()) if (item.event === event) item.handler(payload);
        }
      };
      handles.push(handle);
      return handle;
    }
  };
  return {
    port,
    state,
    handles,
    last: () => handles[handles.length - 1]
  };
}

/** 只实现 `create` 的端口（用于 create 抛错/返回非法句柄的负例）。 */
function createOnlyPort(create) {
  return { kind: 'create_only', create };
}

/** 单个码点是否被切成"半个代理项"（emoji/生僻字被切坏的判据）。 */
function hasLoneSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

// ============================================================ A. 闸门：fail-closed 与判定顺序

test('闸门·fail-closed 纪律：任何拒绝结果都不得携带可播载荷（segments/text 一律不给）', () => {
  assert.deepEqual(speechText.CHECK_STATES, ['passed', 'blocked'], 'CheckState 是契约闭集，不得扩展');

  const rejections = [
    ['SAFETY_CHECK_BLOCKED', speechText.assertSpeakable({ checkState: 'blocked', text: SAMPLE, checkedText: SAMPLE })],
    ['SAFETY_CHECK_BLOCKED', speechText.assertSpeakable({ checkState: undefined, text: SAMPLE, checkedText: SAMPLE })],
    ['CHECKED_TEXT_UNREADABLE', speechText.assertSpeakable({ checkState: 'passed', text: '', checkedText: '' })],
    ['CHECKED_TEXT_UNREADABLE', speechText.assertSpeakable({ checkState: 'passed', text: '   ', checkedText: '   ' })],
    ['TEXT_MISMATCH', speechText.assertSpeakable({ checkState: 'passed', text: '别的正文', checkedText: SAMPLE })]
  ];
  for (const [expected, out] of rejections) {
    assert.equal(out.ok, false, expected);
    assert.equal(out.code, expected);
    assert.equal(out.segments, undefined, `${expected} 不得给出可播分段（否则页面可能念未核对内容）`);
    assert.equal(out.text, undefined, `${expected} 不得给出可播文本`);
    assert.ok(typeof out.reason === 'string' && out.reason.length > 0, `${expected} 必须给出可展示原因`);
    assert.ok(speechText.gateMessage(out).length > 0, `${expected} 必须有页面可展示文案`);
  }

  // 文案兜底：未知失败码也要有非空文案（不得静默空白）。
  assert.ok(speechText.gateMessage({ code: '从未见过的码' }).length > 0);
  assert.ok(speechText.gateMessage(null).length > 0);
});

test('闸门·判定顺序：安全状态 → 正文可读性 → 逐字一致（前面一关不过就不看后面）', () => {
  // ① 安全未过时，即使正文为空/文本不一致，也必须只报 SAFETY_CHECK_BLOCKED（不得泄漏后续判据）。
  const blockedBiased = speechText.assertSpeakable({ checkState: 'blocked', text: '完全不同', checkedText: '' });
  assert.equal(blockedBiased.code, 'SAFETY_CHECK_BLOCKED');

  // ② 契约闭集外的值（哪怕像"已通过"）一律 fail-closed。
  for (const checkState of ['approved', 'pass', 'PASSED', '', null, 0, true]) {
    assert.equal(speechText.assertSpeakable({ checkState, text: SAMPLE, checkedText: SAMPLE }).code, 'SAFETY_CHECK_BLOCKED', String(checkState));
  }

  // ③ 正文不可读优先于文本比对（空正文不得被判成"改写了正文"）。
  assert.equal(speechText.assertSpeakable({ checkState: 'passed', text: '', checkedText: '' }).code, 'CHECKED_TEXT_UNREADABLE');
  // ④ 只有前三关都过，才轮到逐字一致。
  assert.equal(speechText.assertSpeakable({ checkState: 'passed', text: '别的', checkedText: SAMPLE }).code, 'TEXT_MISMATCH');
});

test('闸门·唯一权威：播放控制器不做安全检查（不得出现第二套/旁路判据）', () => {
  const source = read('miniprogram/utils/audio-playback.js');
  assert.ok(/require\(['"]\.\/speech-text['"]\)/.test(source), '控制器只应复用 speech-text 的分段能力');
  assert.equal(source.includes('checkState'), false, '控制器不得自行判定 check_state（安全判定唯一入口是 assertSpeakable）');
  assert.equal(source.includes('assertSpeakable'), false, '控制器不得成为第二条放行路径');
  assert.equal(/playback\s*[:=]\s*['"]?(safe|allow|bypass)/i.test(source), false);
});

// ============================================================ B. 逐字复核：变异模糊

test('反例·逐字复核：单点删除/替换/插入任何字符都必须被拒（变异模糊，正例对照不空跑）', () => {
  const positive = speechText.verifySpeakPlan([SAMPLE], SAMPLE);
  assert.equal(positive.ok, true, '对照组：原文必须通过');
  assert.equal(speechText.verifySpeakPlan(speechText.splitForSpeech(SAMPLE, 9), SAMPLE).ok, true, '对照组：无损分段必须通过');

  let checked = 0;
  for (let index = 0; index < SAMPLE.length; index += 1) {
    const deleted = SAMPLE.slice(0, index) + SAMPLE.slice(index + 1);
    const out = speechText.verifySpeakPlan([deleted], SAMPLE);
    assert.equal(out.ok, false, `删除第 ${index} 个字符必须被拒：${deleted}`);
    assert.equal(out.code, 'SPOKEN_TEXT_MISMATCH');
    assert.ok(out.reason.includes('逐字一致'), `删除必须报"逐字不一致"：${out.reason}`);
    checked += 1;
  }
  for (let index = 0; index < SAMPLE.length; index += 1) {
    // 换成一个必然不同的字符（原文该位就是句号时改感叹号，避免"改了个寂寞"的假变异）。
    const replacement = SAMPLE[index] === '。' ? '！' : '。';
    const substituted = SAMPLE.slice(0, index) + replacement + SAMPLE.slice(index + 1);
    assert.equal(speechText.verifySpeakPlan([substituted], SAMPLE).ok, false, `替换第 ${index} 个字符必须被拒：${substituted}`);
    checked += 1;
  }
  for (let index = 0; index <= SAMPLE.length; index += 1) {
    const inserted = SAMPLE.slice(0, index) + ' ' + SAMPLE.slice(index);
    assert.equal(speechText.verifySpeakPlan([inserted], SAMPLE).ok, false, `插入空白（第 ${index} 位）必须被拒`);
    checked += 1;
  }
  assert.ok(checked > 150, `变异样本数应足够多（实际 ${checked}）`);
});

test('反例·不做任何空白/换行/全半角/异体字符归一化（"看起来等价"一律拒绝）', () => {
  const cases = [
    ['换行风格：CRLF vs LF', '第一句\r\n第二句', '第一句\n第二句'],
    ['空格数量：多一个空格', '30  毫升', '30 毫升'],
    ['尾随空格', SAMPLE + ' ', SAMPLE],
    ['首部空格', ' ' + SAMPLE, SAMPLE],
    ['全角空格 U+3000 vs 半角空格', '30\u3000毫升', '30 毫升'],
    ['全角数字 vs 半角数字', '３０毫升', '30毫升'],
    ['中文句号 vs 半角句号', '水稻。', '水稻.'],
    ['连字符 vs 全角破折号', '300-500', '300－500'],
    ['兼容字符 ㎎ vs 毫克', '1㎎', '1毫克'],
    ['顿号 vs 逗号', '甲、乙', '甲，乙']
  ];
  for (const [label, spoken, checkedText] of cases) {
    const out = speechText.verifySpeakPlan([spoken], checkedText);
    assert.equal(out.ok, false, `${label} 必须被拒（不得归一化后放行）`);
    assert.equal(out.code, 'SPOKEN_TEXT_MISMATCH');
  }

  // 关键：空白差异在**令牌层看不到**（去掉空白后剂量对完全相同），必须由"逐字一致"这一条拦住。
  const whitespaceOnly = speechText.verifySpeakPlan(['30 毫升'], '30毫升');
  assert.equal(whitespaceOnly.ok, false);
  assert.deepEqual(whitespaceOnly.missing, [], '令牌层确实看不到空白差异');
  assert.deepEqual(whitespaceOnly.extra, []);
  assert.ok(whitespaceOnly.reason.includes('逐字一致'), '此时唯一判据必须是逐字一致');
});

test('反例·分段：重排/调换/重复/丢弃/追加必须被拒；只认"拼接后逐字一致"', () => {
  const segments = speechText.splitForSpeech(SAMPLE, 9);
  assert.ok(segments.length > 3, '本用例需要多段');

  const reversed = segments.slice().reverse();
  assert.equal(speechText.verifySpeakPlan(reversed, SAMPLE).ok, false, '段序颠倒必须被拒');

  const swapped = segments.slice();
  [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
  assert.equal(speechText.verifySpeakPlan(swapped, SAMPLE).ok, false, '相邻段调换必须被拒');

  assert.equal(speechText.verifySpeakPlan([segments[0], ...segments], SAMPLE).ok, false, '段重复必须被拒');
  assert.equal(speechText.verifySpeakPlan(segments.slice(0, -1), SAMPLE).ok, false, '丢段必须被拒');
  assert.equal(speechText.verifySpeakPlan([...segments, '。'], SAMPLE).ok, false, '追加内容必须被拒');

  // 分段边界本身不参与判定：把边界左右挪一位，只要拼接一致就放行（这是**正确**行为，钉住它）。
  assert.equal(speechText.verifySpeakPlan(['abc', 'def'], 'abcdef').ok, true);
  assert.equal(speechText.verifySpeakPlan(['a', 'bcdef'], 'abcdef').ok, true);
  assert.equal(speechText.verifySpeakPlan(['abc', '', 'def'], 'abcdef').ok, true, '空段不改变内容，放行');
  assert.equal(speechText.verifySpeakPlan('abcdef', 'abcdef').ok, true, '允许整串（不经分段）');

  // 空计划不是"通过"而是明确拒绝。
  for (const spoken of [[], '', null, undefined, ['', '']]) {
    const out = speechText.verifySpeakPlan(spoken, SAMPLE);
    assert.equal(out.ok, false, `空计划必须被拒：${JSON.stringify(spoken)}`);
    assert.equal(out.code, 'SPOKEN_TEXT_EMPTY');
  }
});

// ============================================================ C. 分段：无损与码点上限

test('分段·任意（含非法/极端）单段上限下都必须无损：拼接逐字一致、每段不超上限、无空段', () => {
  const limits = [1, 2, 3, 7, 8, 61, 62, 63, 120, 1000];
  for (const limit of limits) {
    const segments = speechText.splitForSpeech(SAMPLE, limit);
    assert.equal(segments.join(''), SAMPLE, `limit=${limit} 拼接必须逐字一致`);
    assert.ok(segments.length >= 1);
    for (const segment of segments) {
      assert.ok(segment.length > 0, `limit=${limit} 不得产出空段`);
      assert.ok(speechText.codePointLength(segment) <= limit, `limit=${limit} 段超长：${segment}`);
    }
  }

  // 非法上限（0/负数/小数/NaN/字符串/空/Infinity）一律退化为默认上限——
  // 既不得"不切分"，也不得"切坏"。
  assert.equal(speechText.DEFAULT_SEGMENT_CODE_POINTS, 120);
  const long = 'x'.repeat(300);
  for (const limit of [0, -1, 1.5, NaN, '120', null, undefined, Infinity, {}]) {
    const segments = speechText.splitForSpeech(long, limit);
    assert.equal(segments.join(''), long, `非法上限 ${String(limit)} 仍必须无损`);
    assert.deepEqual(segments.map((item) => item.length), [120, 120, 60], `非法上限 ${String(limit)} 应退化为默认 120`);
  }
  // 合法上限必须被尊重（不是被忽略）。
  assert.deepEqual(speechText.splitForSpeech(long, 50).map((item) => item.length), [50, 50, 50, 50, 50, 50]);
  assert.deepEqual(speechText.splitForSpeech('', 10), []);
  assert.deepEqual(speechText.splitForSpeech(null, 10), []);
  assert.deepEqual(speechText.splitForSpeech(42, 10), []);
});

test('分段·代理对不得被切成半个字符（emoji/生僻字逐段仍是合法 Unicode）', () => {
  const text = '😀👍🏅';
  for (const limit of [1, 2]) {
    const segments = speechText.splitForSpeech(text, limit);
    assert.equal(segments.join(''), text, `limit=${limit} emoji 拼接必须逐字一致`);
    for (const segment of segments) {
      assert.equal(hasLoneSurrogate(segment), false, `limit=${limit} 切出了孤立代理项：${JSON.stringify(segment)}`);
      assert.ok(speechText.codePointLength(segment) <= limit);
    }
  }
  // ZWJ 家族序列：按码点切分是既有口径（只保证不切出半个字符、不丢字符），钉住即可。
  const zwj = '👩\u200d🌾';
  const zwjSegments = speechText.splitForSpeech(zwj, 1);
  assert.equal(zwjSegments.join(''), zwj);
  assert.equal(zwjSegments.every((segment) => hasLoneSurrogate(segment) === false), true);
});

test('分段·超长单段与 16000 码点边界：>段上限不拒但必须再切；按码点（非 UTF-16 长度）判超长', () => {
  const long = 'x'.repeat(500);
  const gated = speechText.assertSpeakable({ checkState: 'passed', text: long, checkedText: long });
  assert.equal(gated.ok, true, '超长正文不得被拒（分段只影响切分，不影响内容）');
  assert.equal(gated.segments.join(''), long);
  assert.deepEqual(gated.segments.map((item) => item.length), [120, 120, 120, 120, 20]);
  assert.ok(gated.segments.every((item) => speechText.codePointLength(item) <= 120));

  // 16000 个 emoji = 32000 个 UTF-16 码元：若按 UTF-16 长度判，这里会被误拒。
  const maxText = '😀'.repeat(speechText.MAX_SPEAKABLE_CODE_POINTS);
  assert.equal(maxText.length, speechText.MAX_SPEAKABLE_CODE_POINTS * 2);
  const maxGated = speechText.assertSpeakable({ checkState: 'passed', text: maxText, checkedText: maxText });
  assert.equal(maxGated.ok, true, '刚好 16000 码点必须放行');
  assert.equal(maxGated.segments.join(''), maxText, '16000 码点分段也必须无损');
  assert.ok(maxGated.segments.every((item) => speechText.codePointLength(item) <= 120));
  assert.ok(maxGated.segments.length > 100);

  const over = '😀'.repeat(speechText.MAX_SPEAKABLE_CODE_POINTS + 1);
  assert.equal(speechText.assertSpeakable({ checkState: 'passed', text: over, checkedText: over }).code, 'CHECKED_TEXT_UNREADABLE');

  // 段上限只约束"分段"，不约束"内容"：单段超长在复核层不算内容错误。
  assert.equal(speechText.verifySpeakPlan([long], long).ok, true);
  assert.equal(speechText.codePointLength('😀'), 1);
});

// ============================================================ D. 关键令牌：数字/单位/否定词/字符形态

test('关键令牌·数字与单位绑定：30 毫升/亩 是一个剂量对；Latin 单位不被收录 ⇒ 落为裸数字（只影响可读原因）', () => {
  const tokens = speechText.criticalTokens(LATIN_LINE);
  assert.deepEqual(tokens.doses, ['30毫升/亩', '20%'], '中文单位必须与数字绑定为一个剂量对');
  // 观察（非阻塞）：Latin 单位（g/ml）与区间连接符不在 UNIT_WORDS/NUMBER 口径内——
  // 「300-500ml」的区间符被当作后一个数字的负号，故为 ['300','-500']。
  // 这只影响失败原因的**可读性**：第 1 条"逐字一致"始终是主判据，改一个字符必被拒。
  assert.deepEqual(tokens.bareNumbers, ['1', '100', '300', '-500', '30']);
  assert.equal(tokens.formulations['稀释'], 1);
  assert.equal(tokens.formulations['每亩'], 1);
  assert.equal(tokens.formulations['悬浮剂'], 1);
  // 空格不影响绑定：'30 毫升/亩' 归一为 '30毫升/亩'（绑定本身不丢）。
  assert.deepEqual(speechText.criticalTokens('30 毫升/亩').doses, ['30毫升/亩']);

  // 负例：丢单位 / 改比值 / 改区间 都必须被拒，并给出可指出的判据。
  const dropped = speechText.verifySpeakPlan(['每亩用 30 毫升，稀释 1:100'], '每亩用 30 毫升/亩，稀释 1:100');
  assert.equal(dropped.ok, false);
  assert.deepEqual(dropped.missing, ['数字/单位 30毫升/亩']);
  assert.deepEqual(dropped.extra, ['数字/单位 30毫升（正文中没有）']);

  const ratio = speechText.verifySpeakPlan(['1:10'], '1:100');
  assert.equal(ratio.ok, false);
  assert.deepEqual(ratio.missing, ['数字 100']);

  const range = speechText.verifySpeakPlan(['300-500毫升'], '300-500ml');
  assert.equal(range.ok, false);
  assert.deepEqual(range.missing, ['数字 -500']);
});

test('关键令牌·多否定词叠加：逐词非重叠计数；顺序被调换（多重集相同）仍必须拒绝', () => {
  assert.equal(speechText.NEGATION_WORDS.length, 13);
  const stacked = speechText.criticalTokens('不得、不要、不可、不能、不准、禁止、严禁、切勿、切忌、避免、勿、莫、忌。').negations;
  for (const word of speechText.NEGATION_WORDS) {
    assert.ok(stacked[word] >= 1, `否定词 ${word} 必须可见`);
  }
  // 计数是"每个词各自非重叠计数"：'切勿' 里的 '勿'、'切忌' 里的 '忌' 会被各自再数一次。
  assert.equal(stacked['切勿'], 1);
  assert.equal(stacked['勿'], 2);
  assert.equal(stacked['忌'], 2);
  assert.equal(speechText.criticalTokens('不得不得').negations['不得'], 2, '连续否定词必须计两次');

  // ① 顺序调换：多重集完全相同，仍然必须拒绝（证明"逐字一致"不是只比令牌）。
  assert.equal(speechText.verifySpeakPlan(['不要不得随意施药'], '不得不要随意施药').ok, false);
  // ② 叠加中丢掉一个：必须指出丢的是哪一个（原因里带计数，便于定位）。
  const lostOne = speechText.verifySpeakPlan(['不得随意施药'], '不得不要随意施药');
  assert.equal(lostOne.ok, false);
  assert.deepEqual(lostOne.missing.map((item) => item.replace(/（.*$/, '')), ['否定词 不要']);
  // ③ 多出一个否定词（把建议念成禁止）同样必须拒绝。
  // 注意逐词非重叠计数：多出 '切勿' 时 '勿' 也会各自多计一次（两条都要能被指出）。
  const addedOne = speechText.verifySpeakPlan(['切勿不得不要随意施药'], '不得不要随意施药');
  assert.equal(addedOne.ok, false);
  assert.deepEqual(addedOne.extra.map((item) => item.replace(/（.*$/, '')), ['否定词 切勿', '否定词 勿']);
  assert.ok(addedOne.extra.every((item) => item.includes('正文中没有')));
});

test('关键令牌·字符形态：全角数字/异体字符不进令牌层，必须由逐字一致拦住；空/纯空白/仅符号各有口径', () => {
  // 全角数字不被 NUMBER_PATTERN 命中 ⇒ 令牌为空，"全靠逐字一致"。
  assert.deepEqual(speechText.criticalTokens('３０毫升'), { doses: [], bareNumbers: [], formulations: {}, negations: {} });
  assert.equal(speechText.verifySpeakPlan(['３０毫升'], '30毫升').ok, false);
  assert.equal(speechText.criticalTokens(null).doses.length, 0, '非字符串输入不得抛错，按空处理');

  // 已核对正文的放行口径：只看"非空且不超长"——纯空白拒，仅标点放行（设计如此，钉住它）。
  assert.equal(speechText.assertSpeakable({ checkState: 'passed', text: '。。。', checkedText: '。。。' }).ok, true);
  assert.equal(speechText.assertSpeakable({ checkState: 'passed', text: '？', checkedText: '？' }).ok, true);
  for (const bad of ['', '   ', '\n\t ', null, undefined, 42, {}, [], true]) {
    const out = speechText.assertSpeakable({ checkState: 'passed', text: bad, checkedText: bad });
    assert.equal(out.ok, false, `正文 ${JSON.stringify(bad)} 必须被拒`);
    assert.equal(out.code, 'CHECKED_TEXT_UNREADABLE');
  }

  // 待播报文本必须是**字符串**且逐字相同：数组/对象一律 TEXT_MISMATCH（不得被 String() 后放行）。
  for (const text of [['分段一', '分段二'], { 0: 'x' }, SAMPLE.split(''), 42, null]) {
    const out = speechText.assertSpeakable({ checkState: 'passed', text, checkedText: SAMPLE });
    assert.equal(out.ok, false, `text=${JSON.stringify(text)} 必须被拒`);
    assert.equal(out.code, 'TEXT_MISMATCH');
  }
});

// ============================================================ E. 播放生命周期负例

test('生命周期·迟到事件（白盒直投已注册回调）：停止/释放/换计划后一律不得复活状态、不得置 listened、不得新建句柄', () => {
  // ① 停止之后：迟到的 play/ended/error/interrupt 都不得生效（代次守卫）。
  const first = spyPlayer();
  const firstFailures = [];
  const stopped = audioPlayback.createPlaybackController({
    player: first.port,
    onFailure: (failure) => firstFailures.push(failure.code)
  });
  stopped.play(['s1', 's2']);
  stopped.stop();
  const staleHandle = first.handles[0];
  staleHandle.deliver('play');
  staleHandle.deliver('ended');
  staleHandle.deliver('error', { code: 'MUTED' });
  staleHandle.deliver('interrupt', { code: 'PLAYBACK_INTERRUPTED' });
  assert.equal(stopped.snapshot().state, 'stopped', '停止后不得被迟到事件改状态');
  assert.equal(stopped.isListened(), false, '停止后迟到 ended 不得置已听取');
  assert.deepEqual(firstFailures, [], '停止后迟到 error 不得把已停止会话翻成失败');
  assert.equal(first.state.created, 1, '停止后不得新建句柄');

  // ② 释放之后（幂等出口）：同样一律不生效。
  const second = spyPlayer();
  const secondFailures = [];
  const released = audioPlayback.createPlaybackController({
    player: second.port,
    onFailure: (failure) => secondFailures.push(failure.code)
  });
  released.play(['s1']);
  const releasedHandle = second.handles[0];
  assert.equal(released.listenerCount() > 0, true, '释放前应有注册监听');
  released.release();
  releasedHandle.deliver('play');
  releasedHandle.deliver('ended');
  releasedHandle.deliver('interrupt', {});
  assert.equal(released.snapshot().state, 'idle');
  assert.equal(released.isListened(), false);
  assert.deepEqual(secondFailures, []);
  assert.equal(released.listenerCount(), 0);

  // ③ 释放之后一切操作都不得再建句柄、不得置 listened。
  assert.deepEqual(released.pause(), { ok: false, code: 'NOT_PLAYING' });
  assert.deepEqual(released.resume(), { ok: false, code: 'NOT_PLAYING' });
  assert.deepEqual(released.stop(), { ok: false, code: 'RELEASED' });
  assert.deepEqual(released.replay(), { ok: false, code: 'RELEASED' });
  assert.equal(second.state.created, 1);
  assert.equal(released.isListened(), false);

  // ④ 换计划之后：旧句柄的迟到 ended 不得推进新计划的段号。
  const third = spyPlayer();
  const switched = audioPlayback.createPlaybackController({ player: third.port });
  switched.play(['s1', 's2']);
  const oldHandle = third.handles[0];
  switched.play(['t1', 't2', 't3']);
  oldHandle.deliver('ended');
  oldHandle.deliver('ended');
  assert.equal(switched.snapshot().index, 0, '换计划后旧句柄迟到事件不得推进段号');
  assert.equal(switched.isListened(), false);
  assert.equal(third.state.created, 2);
  assert.equal(third.last().src, 't1');
});

test('生命周期·失败后不得自行重试/自动补播（无隐藏重试与退避），只有显式请求才重建句柄', async () => {
  const { port, state, handles } = spyPlayer();
  const failures = [];
  const controller = audioPlayback.createPlaybackController({
    player: port,
    onFailure: (failure) => failures.push(failure)
  });
  assert.equal(controller.play('a.mp3', { auto: true }).ok, true);
  handles[0].deliver('error', { code: 'SOURCE_UNAVAILABLE' });
  assert.equal(controller.snapshot().state, 'failed');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].auto, true, '自动发起的失败必须如实标记 auto');
  assert.equal(controller.isListened(), false, '自动播放失败不得假记已听取');
  assert.equal(controller.listenerCount(), 0);
  assert.equal(state.live, 0);

  const createdAfterFailure = state.created;
  await new Promise((done) => setTimeout(done, 30));
  assert.equal(state.created, createdAfterFailure, '失败后不得自行重试（不得出现隐藏重试/退避）');
  assert.equal(state.plays, 1, '失败后不得自动补播（不得再次出声）');
  assert.equal(controller.snapshot().state, 'failed');

  // 显式重试才允许重建（此时替身端口仍无音频，但"再试"是用户主动动作）。
  assert.equal(controller.play('a.mp3').ok, true);
  assert.equal(state.created, createdAfterFailure + 1);
  assert.equal(controller.isListened(), false, '重试本身不等于已听取');
});

test('生命周期·自然播完的语义：只有最后一段结束才 listened，onListened 恰好一次，状态终态 stopped', () => {
  const { port, state, handles } = spyPlayer();
  const published = [];
  const listened = [];
  const controller = audioPlayback.createPlaybackController({
    player: port,
    onStateChange: (snapshot) => published.push({ state: snapshot.state, listened: snapshot.listened }),
    onListened: (snapshot) => listened.push(snapshot.listened)
  });
  assert.equal(controller.play(['s1', 's2', 's3'], { auto: true }).ok, true);
  assert.equal(controller.snapshot().auto, true);
  assert.equal(controller.isListened(), false, '刚开始播放不算已听取');

  handles[0].deliver('ended');
  assert.equal(controller.isListened(), false, '第 1 段结束不等于整份播完');
  assert.equal(state.created, 2, '第 2 段应新建且仅新建一个句柄');
  assert.equal(state.destroyed, 1, '上一段句柄必须已销毁');

  handles[1].deliver('ended');
  assert.equal(controller.isListened(), false, '第 2 段结束不等于整份播完');
  assert.equal(state.created, 3);

  handles[2].deliver('ended');
  assert.equal(controller.isListened(), true, '最后一段结束才算已听取');
  assert.deepEqual(listened, [true], 'onListened 恰好一次，且带 listened=true');
  assert.equal(controller.snapshot().state, 'stopped');
  assert.equal(published[published.length - 1].listened, true, '终态快照必须如实带 listened=true');
  assert.equal(state.live, 0, '播完后不得留下活动句柄');
  assert.equal(controller.listenerCount(), 0, '播完后不得留下监听');
});

// ============================================================ F. 失败分类

test('反例·失败分类：闭集码直采用（不得被 errMsg 特征覆盖），未知码不得被误当成已知码', () => {
  // code 优先于 errmMsg：即使 errMsg 命中别的特征，也必须用显式 code。
  assert.equal(audioPlayback.classifyPlaybackFailure({ code: 'MUTED', errMsg: 'permission denied' }).code, 'MUTED');
  assert.equal(audioPlayback.classifyPlaybackFailure({ code: 'PERMISSION_DENIED', errMsg: 'bluetooth lost' }).code, 'PERMISSION_DENIED');
  assert.equal(audioPlayback.classifyPlaybackFailure({ code: 'SOURCE_UNAVAILABLE', errMsg: 'decode error' }).code, 'SOURCE_UNAVAILABLE');
  // reason 必须如实保留原始信息（不得吞掉）。
  assert.equal(audioPlayback.classifyPlaybackFailure({ code: 'MUTED', errMsg: 'volume is 0' }).reason, 'volume is 0');

  // 闭集外的 code 不得被当成闭集成员；认不出就 UNKNOWN（安全兜底，不得瞎归类成"更轻微"的类别）。
  for (const code of ['NETWORK_ERROR', 'PLAYBACK_FAILED', 'NOT_A_CODE']) {
    assert.equal(audioPlayback.classifyPlaybackFailure({ code }).code, 'UNKNOWN', code);
  }
  // 没有任何原始信息 ⇒ reason=null（不得编造原因）；有原始信息 ⇒ 如实保留（含纯空白串）。
  for (const raw of [null, undefined, '', 42, {}, [], { errMsg: '' }]) {
    const out = audioPlayback.classifyPlaybackFailure(raw);
    assert.equal(out.code, 'UNKNOWN', JSON.stringify(raw));
    assert.equal(out.reason, null, `无原始信息时不得编造原因：${JSON.stringify(raw)}`);
  }
  for (const raw of ['完全看不懂的故障', '   ']) {
    const unmapped = audioPlayback.classifyPlaybackFailure(raw);
    assert.equal(unmapped.code, 'UNKNOWN', raw);
    assert.equal(unmapped.reason, raw, '认不出也要如实保留原始原因');
  }
});

test('反例·失败要素：所有形态（Error/字符串/对象/空值/码字符串）都必须四要素齐全且 recordsListened 恒假', () => {
  const inputs = [
    null, undefined, 0, 42, true, '', 'permission denied', 'bluetooth device disconnected',
    '当前处于静音状态，音量为 0', 'play() failed because the user did not interact first',
    'decode error: unsupported format', 'no source: src is empty', 'audio interruption begin',
    new Error('decode failed'), { errMsg: 'decode failed' }, { code: 'UNKNOWN' }, {}
  ];
  for (const input of inputs) {
    const failure = audioPlayback.classifyPlaybackFailure(input);
    const label = input instanceof Error ? input.message : JSON.stringify(input);
    assert.ok(audioPlayback.FAILURE_CODES.includes(failure.code), `${label} 的失败码必须在闭集内`);
    assert.ok(typeof failure.title === 'string' && failure.title.length > 0, `${label} 缺 title`);
    assert.ok(typeof failure.hint === 'string' && failure.hint.length > 0, `${label} 缺 hint`);
    assert.ok(typeof failure.actionText === 'string' && failure.actionText.length > 0, `${label} 缺主动播放按钮文案`);
    assert.equal(failure.manualStart, true, `${label} 必须要求用户主动播放`);
    assert.equal(failure.recordsListened, false, `${label} 一律不得记已听取`);
  }

  // 关键类别不得被合并成同一句话（此前已钉住，这里补"跨类别互不相同"的负例）。
  const titles = new Set(audioPlayback.FAILURE_CODES.map((code) => audioPlayback.classifyPlaybackFailure({ code }).title));
  assert.equal(titles.size, audioPlayback.FAILURE_CODES.length, '每个失败码必须有独立标题');
});

test('反例·分类映射：网络/解码/权限/自动播放/中断各自独立，且失败不触达播放完成语义', () => {
  const cases = [
    ['网络/来源不可用', 'no source: src is empty', 'SOURCE_UNAVAILABLE'],
    ['404', '404 not found', 'SOURCE_UNAVAILABLE'],
    ['解码失败', 'decode error: unsupported container', 'DECODE_FAILED'],
    ['格式不支持', 'unsupported format', 'DECODE_FAILED'],
    ['拒权', 'permission denied: scope.record', 'PERMISSION_DENIED'],
    ['未授权', 'not authorized', 'PERMISSION_DENIED'],
    ['自动播放被阻止', 'play() failed because the user did not interact first', 'AUTOPLAY_BLOCKED'],
    ['自动播放被阻止（中文）', '自动播放被系统阻止', 'AUTOPLAY_BLOCKED'],
    ['静音', '当前处于静音状态', 'MUTED'],
    ['静音（英文）', 'the player is muted', 'MUTED'],
    ['蓝牙/耳机', 'bluetooth headset a2dp disconnected', 'BLUETOOTH'],
    ['中断', 'audio interruption begin', 'PLAYBACK_INTERRUPTED'],
    ['中断（中文）', '被其它音频中断', 'PLAYBACK_INTERRUPTED']
  ];
  const seen = new Map();
  for (const [label, raw, expected] of cases) {
    const failure = audioPlayback.classifyPlaybackFailure({ errMsg: raw });
    assert.equal(failure.code, expected, `${label}（${raw}）`);
    assert.equal(failure.reason, raw, `${label} 必须保留原始原因`);
    assert.equal(failure.recordsListened, false);
    seen.set(expected, (seen.get(expected) || 0) + 1);
  }
  assert.ok(seen.size >= 6, '至少覆盖 6 类独立失败');

  // Error 实例与字符串同样走分类；成功语义（listened）永远只能来自"自然播完"。
  assert.equal(audioPlayback.classifyPlaybackFailure(new Error('permission denied')).code, 'PERMISSION_DENIED');
  assert.equal(audioPlayback.classifyPlaybackFailure('permission denied').code, 'PERMISSION_DENIED');
});

// ============================================================ G. KNOWN-GAP：已登记缺陷

/**
 * KNOWN-GAP 组（本片只登记，不改产品代码——改行为需另开修复片）。
 * 每条都断言**当前行为**，因此修复落地后这些用例会转红：这是刻意的，请连同注释一起更新。
 */

test('KNOWN-GAP（高）·同一计划内**段级**迟到 ended 不被代次守卫拦截 ⇒ 可假记 listened', () => {
  // 根因：`attach(target, token)` 的 token 是**计划级**代次（只在 play/stop/release 递增），
  // 与具体段句柄无关；`onSegmentEnded` 只看 token，不看事件来自哪一段。
  // 末段分支先 `destroyHandle()`（连同正在播的段句柄一起销毁）再置 listened，因此：
  // 段 1 的重复/迟到 ended（平台在途回调）会把"整份计划"判定为播完——而段 2 从未播放。
  // 与硬断言"播放成功 ≠ 已听取 / 不假记 listened"（audio-playback.js 头注释 3、6）冲突。
  // 最小复现见下面 4 行；建议修复：段级 token 或 `if (thisHandle !== handle) return` 去重 + 完成后再置位。
  const { port, state, handles } = spyPlayer();
  const listened = [];
  const controller = audioPlayback.createPlaybackController({
    player: port,
    onListened: () => listened.push(true)
  });
  controller.play(['s1', 's2']);
  handles[0].deliver('ended'); // 段 1 自然结束 → 段 2 开始
  assert.equal(state.created, 2);
  assert.equal(controller.snapshot().index, 1);
  handles[0].deliver('ended'); // KNOWN-GAP：段 1 的迟到/重复 ended
  assert.equal(controller.isListened(), true, '当前行为（已登记）：段 2 未播放就记为「已听取」');
  assert.deepEqual(listened, [true], '当前行为（已登记）：onListened 被触发');
  assert.equal(state.plays, 2, '段 2 只被 play() 过，从未播完（无第二个 ended 投递）');
});

test('KNOWN-GAP（高）·同因导致**跳段**：段 1 迟到 ended 会直接开始第 3 段、跳过第 2 段', () => {
  // 根因同上（计划级 token + 迟到事件被当作"当前段结束"）。后果是内容被整段省略，
  // 与 speech-text 侧"不截断、不省略"的口径不在同一层但同样严重。
  const { port, state, handles } = spyPlayer();
  const controller = audioPlayback.createPlaybackController({ player: port });
  controller.play(['s1', 's2', 's3']);
  handles[0].deliver('ended'); // → 段 2 开始
  assert.equal(controller.snapshot().index, 1);
  handles[0].deliver('ended'); // KNOWN-GAP：段 1 迟到 ended
  assert.equal(controller.snapshot().index, 2, '当前行为（已登记）：段号被推到第 3 段');
  assert.equal(controller.isListened(), false);
  assert.equal(handles[handles.length - 1].src, 's3', '当前行为（已登记）：直接播第 3 段，第 2 段被跳过');
});

test('KNOWN-GAP（中）·播完后重复 ended ⇒ onListened 重复触发（一次计划、多次"已听取"）', () => {
  const { port, handles } = spyPlayer();
  const listened = [];
  const controller = audioPlayback.createPlaybackController({ player: port, onListened: () => listened.push(true) });
  controller.play('a.mp3');
  handles[0].deliver('ended');
  assert.equal(listened.length, 1);
  handles[0].deliver('ended');
  handles[0].deliver('ended');
  // 当前行为（已登记）：末段分支没有"已完成"短路，重复 ended 会再次走末段分支并再次回调。
  assert.equal(listened.length, 3, '当前行为（已登记）：应为 1 次');
  assert.equal(controller.isListened(), true);
});

test('KNOWN-GAP（中）·播完后（listened=true）迟到 error ⇒ 状态翻成 failed，成功与失败并存', () => {
  const { port, handles } = spyPlayer();
  const failures = [];
  const controller = audioPlayback.createPlaybackController({ player: port, onFailure: (failure) => failures.push(failure) });
  controller.play('a.mp3');
  handles[0].deliver('ended');
  assert.equal(controller.isListened(), true);
  handles[0].deliver('error', { code: 'MUTED' });
  // 当前行为（已登记）：迟到的 error 把已完成的会话翻成 failed；isListened() 仍为 true，
  // onFailure 又报 recordsListened:false ⇒ 同一份计划同时"已听取"与"未听取"。
  assert.equal(controller.snapshot().state, 'failed');
  assert.equal(controller.isListened(), true);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].recordsListened, false);
});

test('KNOWN-GAP（中）·play() 同步失败仍返回 {ok:true}（调用方按返回值判断会以为在播）', () => {
  const cases = [
    ['create 抛错 ⇒ 归类为解码失败', createOnlyPort(() => { throw new Error('decode error: bad container'); }), 'DECODE_FAILED'],
    ['create 返回 null ⇒ 来源不可用', createOnlyPort(() => null), 'SOURCE_UNAVAILABLE'],
    ['create 返回无 play() 的句柄 ⇒ 来源不可用', createOnlyPort(() => ({ stop() {}, destroy() {} })), 'SOURCE_UNAVAILABLE']
  ];
  for (const [label, player, expectedCode] of cases) {
    const failures = [];
    const controller = audioPlayback.createPlaybackController({ player, onFailure: (failure) => failures.push(failure) });
    const result = controller.play('a.mp3');
    assert.equal(controller.snapshot().state, 'failed', label);
    assert.equal(failures.length, 1, label);
    assert.equal(failures[0].code, expectedCode, label);
    assert.equal(failures[0].recordsListened, false, label);
    assert.equal(controller.isListened(), false, label);
    // 当前行为（已登记）：应为 { ok:false, code }，现在却报成功。
    assert.deepEqual(result, { ok: true }, `${label}：当前行为（已登记）`);
  }
});

test('KNOWN-GAP（中）·interrupt 事件空载荷 ⇒ 归类为 UNKNOWN，而事件语义本身已知', () => {
  const controllerFailure = (payload) => {
    const handlers = {};
    const port = {
      kind: 'capture',
      create() {
        return {
          on(event, handler) { (handlers[event] = handlers[event] || []).push(handler); return () => {}; },
          play() {}, pause() {}, stop() {}, destroy() {}
        };
      }
    };
    const failures = [];
    const controller = audioPlayback.createPlaybackController({ player: port, onFailure: (failure) => failures.push(failure) });
    controller.play('a.mp3');
    for (const handler of (handlers.interrupt || []).slice()) handler(payload);
    return { code: failures[0] && failures[0].code, state: controller.snapshot().state, listened: controller.isListened(), recordsListened: failures[0] && failures[0].recordsListened, manualStart: failures[0] && failures[0].manualStart };
  };
  // 语义已知的形态：必须如实归为 PLAYBACK_INTERRUPTED。
  for (const payload of [undefined, 'interrupt', { errMsg: 'audio interruption begin' }, { code: 'PLAYBACK_INTERRUPTED' }]) {
    const out = controllerFailure(payload);
    assert.equal(out.code, 'PLAYBACK_INTERRUPTED', JSON.stringify(payload));
    assert.equal(out.listened, false);
  }
  // 当前行为（已登记）：空对象/空 errMsg 的 interrupt 落到 UNKNOWN（文案退化为"原因未能识别"）。
  // 安全侧不受影响（仍 manualStart + recordsListened:false），属文案/归因缺口。
  for (const payload of [{}, { errMsg: '' }]) {
    const out = controllerFailure(payload);
    assert.equal(out.code, 'UNKNOWN', `当前行为（已登记）：${JSON.stringify(payload)}`);
    assert.equal(out.manualStart, true);
    assert.equal(out.recordsListened, false);
    assert.equal(out.listened, false);
  }
});

test('KNOWN-GAP（低·前置：端口退订为空操作）·destroyHandle 期间的同步 stop 事件让终态快照 listened 停在 false', () => {
  // 成因：末段分支的顺序是 destroyHandle() → listened=true → setState('stopped')。
  // destroyHandle() 先 detachAll() 再 stop()/destroy()，所以**退订真的生效**的端口不可能在此时
  // 把事件投回来（问题不可达）。只有"退订是空操作、端口仍向已注册回调投递"的不合规端口才会：
  // stop 事件让 setState('stopped') 提前 publish 一次 listened=false，之后 listened=true 时
  // setState('stopped') 因状态未变不再 publish ⇒ 最后一次快照与实际不符（isListened()/onListened 是对的）。
  // 影响面：需要不合规端口；生产端口（utils/inner-audio-port.js）的退订会真的摘除监听。
  function leakyPlayer() {
    const published = [];
    const handles = [];
    const port = {
      kind: 'leaky_no_unsubscribe',
      create() {
        const log = [];
        const handle = {
          /** 退订=空操作（不合规端口；模块的 listenerCount 判据依赖它真的摘除）。 */
          on(event, handler) { log.push({ event, handler }); return () => {}; },
          play() { for (const item of log.slice()) if (item.event === 'play') item.handler(); },
          pause() {},
          stop() { for (const item of log.slice()) if (item.event === 'stop') item.handler(); },
          destroy() {},
          deliver(event, payload) { for (const item of log.slice()) if (item.event === event) item.handler(payload); }
        };
        handles.push(handle);
        return handle;
      }
    };
    const controller = audioPlayback.createPlaybackController({
      player: port,
      onStateChange: (snapshot) => published.push({ state: snapshot.state, listened: snapshot.listened })
    });
    return { controller, published, handles };
  }

  // ① 合规端口（退订真的摘除监听）：终态快照正确 ⇒ 本 GAP 有前置条件，不是普适缺陷。
  const conforming = spyPlayer({ emitStopOnStop: true });
  const publishedOk = [];
  const okController = audioPlayback.createPlaybackController({
    player: conforming.port,
    onStateChange: (snapshot) => publishedOk.push({ state: snapshot.state, listened: snapshot.listened })
  });
  okController.play('a.mp3');
  conforming.handles[0].deliver('ended');
  assert.equal(okController.isListened(), true);
  assert.equal(publishedOk[publishedOk.length - 1].state, 'stopped');
  assert.equal(publishedOk[publishedOk.length - 1].listened, true, '合规端口下终态快照正确（本 GAP 不可达）');

  // ② 不合规端口（退订为空操作）：当前行为（已登记）——快照 listened=false，而 isListened() 为 true。
  const leaky = leakyPlayer();
  leaky.controller.play('a.mp3');
  leaky.handles[0].deliver('ended');
  assert.equal(leaky.controller.isListened(), true, 'isListened() 是对的');
  assert.equal(leaky.published[leaky.published.length - 1].state, 'stopped');
  assert.equal(leaky.published[leaky.published.length - 1].listened, false, '当前行为（已登记）：终态快照与 isListened() 不一致');
});

test('KNOWN-GAP（低）·失败分类不对称：字符串形式的 SOURCE_UNAVAILABLE 不自映射；errCode/网络类无独立分类', () => {
  // ① 8 个闭集码以**字符串**形式传入时，只有 SOURCE_UNAVAILABLE 不自映射（其余 7 个靠特征侥幸命中）。
  const codes = audioPlayback.FAILURE_CODES;
  const selfMapped = codes.filter((code) => audioPlayback.classifyPlaybackFailure(code).code === code);
  assert.equal(selfMapped.length, codes.length - 1, '当前行为（已登记）：仅 SOURCE_UNAVAILABLE 不自映射');
  assert.equal(audioPlayback.classifyPlaybackFailure('SOURCE_UNAVAILABLE').code, 'UNKNOWN');
  assert.equal(audioPlayback.classifyPlaybackFailure('SOURCE_UNAVAILABLE').reason, 'SOURCE_UNAVAILABLE', '原因至少如实保留');

  // ② `errCode`（平台常见字段）完全不参与分类：只有 errCode 的网络/解码错误落 UNKNOWN。
  assert.equal(audioPlayback.classifyPlaybackFailure({ errCode: 10002 }).code, 'UNKNOWN');
  assert.equal(audioPlayback.classifyPlaybackFailure({ errCode: 10003 }).code, 'UNKNOWN');
  // ③ FAILURE_CODES 没有"网络"类；网络类文案落 UNKNOWN（有兜底文案与主动按钮，安全侧不受影响）。
  assert.equal(audioPlayback.FAILURE_CODES.includes('NETWORK'), false);
  assert.equal(audioPlayback.classifyPlaybackFailure('network error').code, 'UNKNOWN');
  assert.equal(audioPlayback.classifyPlaybackFailure({ errCode: 10002, errMsg: 'operateBackgroundAudio:fail' }).code, 'UNKNOWN');
});

test('KNOWN-GAP（低）·verifySpeakPlan 只比对拼接结果：含 null/嵌套数组的"计划"也能通过并原样回传', () => {
  const withNull = speechText.verifySpeakPlan([SAMPLE, null], SAMPLE);
  // 当前行为（已登记）：join('') 抹平了非字符串项，计划里带着 null 段也判 ok。
  assert.equal(withNull.ok, true);
  assert.equal(withNull.segments[1], null, '非字符串分段被原样回传');
  assert.equal(speechText.verifySpeakPlan([[SAMPLE]], SAMPLE).ok, true, '嵌套数组同样通过');
  // 对照：会改变拼接结果的项仍会被拒。
  assert.equal(speechText.verifySpeakPlan([SAMPLE, 0], SAMPLE).ok, false);

  // 影响面有限：闸门入口 assertSpeakable 只接受**字符串** text，不经过数组路径。
  assert.equal(speechText.assertSpeakable({ checkState: 'passed', text: [SAMPLE], checkedText: SAMPLE }).code, 'TEXT_MISMATCH');
  assert.equal(speechText.assertSpeakable({ checkState: 'passed', text: SAMPLE, checkedText: SAMPLE }).ok, true);
});

test('KNOWN-GAP（低）·令牌覆盖缺口：禁用/不宜/不建议 不在否定词表；若/仅 不在条件词表（只影响可读原因）', () => {
  const tokens = speechText.criticalTokens('禁用 不宜 不建议 不推荐 若高温 仅限上午 切勿');
  assert.deepEqual(Object.keys(tokens.negations).sort(), ['切勿', '勿'], '当前行为（已登记）：只有 切勿/勿 命中');
  for (const missed of ['禁用', '不宜', '不建议', '不推荐']) {
    assert.equal(tokens.negations[missed], undefined, missed);
  }
  assert.equal(tokens.formulations['若'], undefined, '"若" 不在条件词表');
  assert.equal(tokens.formulations['仅'], undefined, '"仅" 不在条件词表');
  // 对照：表内词仍命中。
  assert.equal(speechText.criticalTokens('禁止使用').negations['禁止'], 1);
  assert.equal(speechText.criticalTokens('不得施药').negations['不得'], 1);

  // 覆盖缺口**不削弱闸门**：逐字一致才是主判据，改写/删除仍被拒。
  assert.equal(speechText.verifySpeakPlan(['禁用随意施药'], '严禁随意施药').ok, false);
  assert.equal(speechText.verifySpeakPlan(['若高温则施药'], '仅高温则施药').ok, false);
});

test('KNOWN-GAP（低）·replay() 在播放中返回 ALREADY_PLAYING 且不从头重播（与注释"先彻底停掉"不一致）', () => {
  const { port, state } = spyPlayer();
  const controller = audioPlayback.createPlaybackController({ player: port });
  controller.play('a.mp3');
  assert.equal(controller.snapshot().state, 'playing');
  const replayed = controller.replay();
  // 当前行为（已登记）：replay() 走 play(plan) 被"同一计划防叠音"短路，用户按"重播"看不到从头开始。
  assert.deepEqual(replayed, { ok: false, code: 'ALREADY_PLAYING' });
  assert.equal(state.created, 1, '没有重建句柄，也就没有从头重播');
  assert.equal(controller.isListened(), false);
  // 停止之后再重播才按注释语义工作。
  controller.stop();
  assert.equal(controller.replay().ok, true);
});

test('KNOWN-GAP（低）·端口 on() 抛异常时 play() 同步抛出，状态停在 loading 且句柄未释放', () => {
  const player = createOnlyPort(() => ({
    on() { throw new Error('基础库不支持事件绑定'); },
    play() {}, pause() {}, stop() {}, destroy() {}
  }));
  const failures = [];
  const controller = audioPlayback.createPlaybackController({ player, onFailure: (failure) => failures.push(failure) });
  // 当前行为（已登记）：attach() 未做异常兜底 ⇒ play() 直接抛出；既没归类失败，也没释放句柄。
  assert.throws(() => controller.play('a.mp3'), /基础库不支持事件绑定/);
  assert.equal(controller.snapshot().state, 'loading');
  assert.equal(controller.snapshot().hasHandle, true);
  assert.deepEqual(failures, [], '没有走失败通道（四要素文案与主动按钮都没有）');
  assert.equal(controller.isListened(), false);
  // 生产端口（utils/inner-audio-port.js）对平台绑定已做 try/catch，因此这是"端口不合规"时的健壮性缺口。
  assert.equal(read('miniprogram/utils/inner-audio-port.js').includes('播放器事件绑定失败'), true);
});
