/**
 * GY-I08 · 剂量卡功能开关默认值守卫（issue #8 验收第 3 条「有功能关闭开关」）。
 *
 * 为什么单独立一条：`APP_GY_I08_DOSE_CARD_ENABLED` / `APP_GY_I08_EXECUTABLE_ENABLED` 都是
 * **关闭型** kill switch —— 默认值一旦被改成 false，整体就是「默认不产出」，而"用量守卫全绿"
 * 会变成另一重**空真**（因为开关压根没开）。所以默认值本身要有独立断言，不能只靠场景用例顺带覆盖。
 *
 * 被断言的三个入口都在 `packages/reference/deterministic.mjs`（行号取自实测快照
 * `upstream/main` = `6c2200087ae5f8841a04505cb1c226284cee7f1b`，2026-10-17）：
 *
 *   1. `readFeatureSwitches(env = process.env)`（:121-130）：两个开关位都用 `fallback=true`
 *      （:122-123）⇒ 未设置/空串/空白一律为**开**；
 *   2. `resolveFeatureSwitches(opts)`（:137-153）：`dose_card_enabled = doseCardRequested && executableEnabled`
 *      （:150）⇒ 可执行建议关了就不得单独开着用量卡；`opts.env` 可显式注入（便于确定性测试）；
 *   3. `parseSwitchValue(raw, fallback)`（:106-115）：**模块内私有、未导出**（`packages/reference/index.mjs`
 *      的 `export *` 不会暴露它）。故这里断言它的**可观察契约**：同一张取值表分别灌进两个开关位，
 *      逐条比对 `switch.enabled` / `switch.unrecognized` / `switch.raw`。重命名或内联不会误红，
 *      语义漂移（默认改 false、拼错当开启、大小写敏感）必红。
 *
 * 取值口径（fail-closed）：`1/true/on/yes` ⇒ 开；`0/false/off/no` ⇒ 关（大小写不敏感）；
 * **其它任何取值 ⇒ 关 且 `unrecognized=true`** —— 拼错的开关不得静默当作开启。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FEATURE_SWITCH_IDS,
  readFeatureSwitches,
  resolveFeatureSwitches,
} from '../../packages/reference/deterministic.mjs';

const EXECUTABLE_ID = 'APP_GY_I08_EXECUTABLE_ENABLED';
const DOSE_CARD_ID = 'APP_GY_I08_DOSE_CARD_ENABLED';

/** 开关取值表：语义逐条写死（含大小写、空白、拼错、数字串）。 */
const SWITCH_VALUE_TABLE = Object.freeze([
  { raw: undefined, enabled: true, unrecognized: false, note: '未设置 ⇒ 沿用默认开' },
  { raw: null, enabled: true, unrecognized: false, note: 'null ⇒ 沿用默认开' },
  { raw: '', enabled: true, unrecognized: false, note: '空串 ⇒ 沿用默认开' },
  { raw: '   ', enabled: true, unrecognized: false, note: '纯空白 ⇒ 沿用默认开' },
  { raw: '1', enabled: true, unrecognized: false, note: '显式开' },
  { raw: 'true', enabled: true, unrecognized: false, note: '显式开' },
  { raw: 'on', enabled: true, unrecognized: false, note: '显式开' },
  { raw: 'yes', enabled: true, unrecognized: false, note: '显式开' },
  { raw: 'TRUE', enabled: true, unrecognized: false, note: '大小写不敏感' },
  { raw: '  On  ', enabled: true, unrecognized: false, note: '大小写与空白不敏感' },
  { raw: '0', enabled: false, unrecognized: false, note: '显式关' },
  { raw: 'false', enabled: false, unrecognized: false, note: '显式关' },
  { raw: 'off', enabled: false, unrecognized: false, note: '显式关' },
  { raw: 'no', enabled: false, unrecognized: false, note: '显式关' },
  { raw: 'FALSE', enabled: false, unrecognized: false, note: '大小写不敏感' },
  { raw: 'ture', enabled: false, unrecognized: true, note: '拼错 ⇒ 保守关闭' },
  { raw: 'enable', enabled: false, unrecognized: true, note: '拼错 ⇒ 保守关闭' },
  { raw: 'maybe', enabled: false, unrecognized: true, note: '无法识别 ⇒ 保守关闭' },
  { raw: '2', enabled: false, unrecognized: true, note: '非开关词 ⇒ 保守关闭' },
]);

const switchFor = (switches, id) =>
  id === EXECUTABLE_ID ? switches.executable_switch : switches.dose_card_switch;

test('GY-I08 开关：通道常量与两个开关标识不得漂移', () => {
  assert.deepEqual(FEATURE_SWITCH_IDS, {
    EXECUTABLE: EXECUTABLE_ID,
    DOSE_CARD: DOSE_CARD_ID,
  });
});

test('readFeatureSwitches：env 未设置或为空串时两个开关默认 true（kill switch 默认开启）', () => {
  const environments = [
    { label: '空对象', env: {} },
    { label: '空串', env: { [EXECUTABLE_ID]: '', [DOSE_CARD_ID]: '' } },
    { label: 'undefined', env: { [EXECUTABLE_ID]: undefined, [DOSE_CARD_ID]: undefined } },
    { label: '纯空白', env: { [EXECUTABLE_ID]: '  ', [DOSE_CARD_ID]: '\t' } },
  ];
  for (const { label, env } of environments) {
    const switches = readFeatureSwitches(env);
    assert.equal(switches.executable_enabled, true, `${label}：可执行建议开关必须默认为 true`);
    assert.equal(switches.dose_card_enabled, true, `${label}：用量卡开关必须默认为 true`);
    for (const id of [EXECUTABLE_ID, DOSE_CARD_ID]) {
      const sw = switchFor(switches, id);
      assert.equal(sw.id, id, `${label}：开关对象的 id 必须回指自己`);
      assert.equal(sw.enabled, true, `${label}：${id} 必须默认为开启`);
      assert.equal(sw.unrecognized, false, `${label}：${id} 未设置时不得标记 unrecognized`);
    }
  }

  // 显式关闭只影响自己那一位，不串位。
  const dosesOff = readFeatureSwitches({ [DOSE_CARD_ID]: 'off' });
  assert.equal(dosesOff.executable_enabled, true, '关用量卡不得连带关闭可执行建议');
  assert.equal(dosesOff.dose_card_enabled, false, '显式 off 必须读成 false');
  assert.equal(dosesOff.dose_card_switch.raw, 'off', '原始取值必须原样保留（便于排障）');

  const executableOff = readFeatureSwitches({ [EXECUTABLE_ID]: '0' });
  assert.equal(executableOff.executable_enabled, false, '显式 0 必须读成 false');
  assert.equal(executableOff.dose_card_enabled, true, 'readFeatureSwitches 只解析本位，不做下位联动');
});

test('parseSwitchValue（经两个开关位的可观察契约）：默认开、显式关、拼错 fail-closed', () => {
  for (const { raw, enabled, unrecognized, note } of SWITCH_VALUE_TABLE) {
    for (const id of [EXECUTABLE_ID, DOSE_CARD_ID]) {
      const sw = switchFor(readFeatureSwitches({ [id]: raw }), id);
      assert.equal(
        sw.enabled,
        enabled,
        `${id}=${JSON.stringify(raw)} 应解析为 enabled=${enabled}（${note}）`,
      );
      assert.equal(
        sw.unrecognized,
        unrecognized,
        `${id}=${JSON.stringify(raw)} 应解析为 unrecognized=${unrecognized}（${note}）`,
      );
      if (raw !== undefined && raw !== null) {
        assert.equal(sw.raw, String(raw), `${id}=${JSON.stringify(raw)} 的 raw 必须原样保留`);
      } else {
        assert.equal(sw.raw, null, `${id}=${JSON.stringify(raw)} 的 raw 必须为 null`);
      }
    }
  }

  // 关键回归（派单点名）：把 true 拼成 ture，必须关且标记未识别，绝不静默当开启。
  const typo = readFeatureSwitches({ [DOSE_CARD_ID]: 'ture' }).dose_card_switch;
  assert.equal(typo.enabled, false, '拼错 ture 必须解析为关闭');
  assert.equal(typo.unrecognized, true, '拼错 ture 必须标记 unrecognized');
});

test('resolveFeatureSwitches：executableEnabled=false 时剂量卡必须一并关闭', () => {
  const closed = resolveFeatureSwitches({ executableEnabled: false });
  assert.equal(closed.executable_enabled, false, '显式关闭可执行建议必须生效');
  assert.equal(closed.dose_card_enabled, false, '可执行建议关闭时用量卡不得单独开着（下位约束）');

  const defaults = resolveFeatureSwitches({ env: {} });
  assert.equal(defaults.executable_enabled, true, 'opts.env 为空时默认开启');
  assert.equal(defaults.dose_card_enabled, true, 'opts.env 为空时用量卡默认开启');

  const doseOnlyClosed = resolveFeatureSwitches({ env: {}, doseCardEnabled: false });
  assert.equal(doseOnlyClosed.executable_enabled, true, '只关用量卡不得连带关闭可执行建议');
  assert.equal(doseOnlyClosed.dose_card_enabled, false, '显式关闭用量卡必须生效');

  // 冲突入参：上层开、下层关 ⇒ 以下层为准。
  const conflict = resolveFeatureSwitches({ env: {}, executableEnabled: true, doseCardEnabled: false });
  assert.equal(conflict.executable_enabled, true);
  assert.equal(conflict.dose_card_enabled, false, 'doseCardEnabled=false 必须压过 executableEnabled=true');

  // 反向冲突：下层想开、上层关 ⇒ 仍关闭。
  const reverseConflict = resolveFeatureSwitches({ env: {}, executableEnabled: false, doseCardEnabled: true });
  assert.equal(reverseConflict.dose_card_enabled, false, 'executableEnabled=false 必须压过 doseCardEnabled=true');

  assert.equal(typeof defaults.env, 'object', 'resolveFeatureSwitches 必须回吐 env 解析结果（便于排障）');
  assert.notEqual(defaults.env, null, 'env 解析结果不得为 null');
  assert.equal(defaults.env?.dose_card_enabled, true, 'env 解析结果里用量卡默认开启');
});

test('resolveFeatureSwitches：环境变量经 opts.env 注入时语义与 readFeatureSwitches 一致', () => {
  const executableOff = resolveFeatureSwitches({ env: { [EXECUTABLE_ID]: 'off' } });
  assert.equal(executableOff.executable_enabled, false, 'env 显式关可执行建议必须生效');
  assert.equal(executableOff.dose_card_enabled, false, '上位关闭时用量卡必须一并关闭');

  const doseOff = resolveFeatureSwitches({ env: { [DOSE_CARD_ID]: 'no' } });
  assert.equal(doseOff.executable_enabled, true);
  assert.equal(doseOff.dose_card_enabled, false, 'env 显式关用量卡必须生效');

  const typo = resolveFeatureSwitches({ env: { [DOSE_CARD_ID]: 'ture' } });
  assert.equal(typo.dose_card_enabled, false, 'env 拼错必须保守关闭');
  assert.equal(
    typo.env?.dose_card_switch?.unrecognized,
    true,
    '拼错必须留痕（unrecognized=true），便于运维发现配置写错',
  );
});
