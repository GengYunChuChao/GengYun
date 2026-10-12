/**
 * GY-I14 模型层（第二片）· 测试夹具。
 *
 * 声明（必须如实）：
 *   - 这里全部是**合成夹具**：注入的"模型端口"是**合成替身**（`provider.synthetic === true`），
 *     **不发任何网络请求**、不持有任何凭据、不读任何环境变量；
 *   - 真实 `tms`/`ims` 调用需要用户交接两个真实 `BizType`（现为占位值），本片一律不调；
 *   - `docs/evaluation/sample-gap-register.md` 已确认 `ai_moderation_risk` / `ai_moderation_normal`
 *     真实样本**各为 0**，因此本文件与全部用例**不得**被引用为任何模型准确率／召回率证据。
 */
import { evaluateHardRules } from '../../packages/moderation/engine.mjs';

/**
 * 夹具显式给定的规则预算（毫秒）。
 *
 * 为什么要显式给：规则层默认预算是 **50ms 墙钟**，超出即 `RULE_TIMEOUT` + `quarantined`
 * （规则层自己的用例已证明这一点）。模型层夹具要的是"规则层已通过的确定性前提"，
 * 不该把并行跑整套 `test:unit` 时的**偶发调度停顿**变成模型层用例的假失败，
 * 所以这里给一个宽裕的显式预算——规则层"慢"的回归由规则层自己的用例负责。
 */
export const RULE_BUDGET_MS = 5000;

/** 用显式预算跑规则层（模型层夹具的统一入口）。 */
export function runRules(input, options = {}) {
  return evaluateHardRules(input, { budget_ms: RULE_BUDGET_MS, ...options });
}

/** 干净文本（与规则层夹具同源，不含任何命中形态）。 */
export const CLEAN_TEXT =
  '今年雨水多，田里的稗草长得快，准备按标签说明选择登记药剂，先看苗情再说。';

/** 命中隐私规则的文本（规则层应判 rejected）。 */
export const PRIVACY_TEXT = '有事打我电话 13812345678，或者晚上再联系。';

/** 一张图片的不透明引用（**不含字节**）。 */
export const IMAGE_REF = Object.freeze({
  media_id: '22222222-2222-4222-8222-222222222222',
  media_revision: 1,
  mime: 'image/png',
});

/** 合法输入：文本 + 显式声明无媒体。 */
export function makeContent(overrides = {}) {
  const base = {
    target_ref: { type: 'post', id: 'post-1001', revision: 1 },
    text: CLEAN_TEXT,
    media: [],
  };
  return {
    ...base,
    ...overrides,
    target_ref: overrides.target_ref === undefined ? base.target_ref : overrides.target_ref,
    media: overrides.media === undefined ? base.media : overrides.media,
  };
}

/** 合法输入：文本 + 一张图片。 */
export function makeMediaContent(overrides = {}) {
  return makeContent({ media: [{ ...IMAGE_REF }], ...overrides });
}

/** 规则层结果：干净文本 ⇒ approved（**规则层**口径，尚未补模型层字段）。 */
export const CLEAN_RULE_RESULT = runRules(makeContent());

/** 规则层结果：隐私命中 ⇒ rejected。 */
export const REJECTED_RULE_RESULT = runRules(makeContent({ text: PRIVACY_TEXT }));

/** 规则层结果：带图片 ⇒ quarantined（硬规则一条都没跑）。 */
export const MEDIA_RULE_RESULT = runRules(makeMediaContent());

/** 规则层结果：输入闸门不通过（空文本）⇒ quarantined 且 input.valid=false。 */
export const INVALID_INPUT_RULE_RESULT = runRules(makeContent({ text: '   ' }));

/** 通过的模型回报。 */
export function passVerdict(overrides = {}) {
  return { label: 'pass', reason_codes: [], summary: 'synthetic pass', ...overrides };
}

/** 不通过的模型回报。 */
export function blockVerdict(overrides = {}) {
  return { label: 'block', reason_codes: ['SYNTHETIC_MODEL_BLOCK'], summary: 'synthetic block', ...overrides };
}

/** 合成端口：网络 seam 全部由"注入方"持有（此处是合成替身，永不联网）。 */
export function makePort(overrides = {}) {
  const kind = overrides.kind ?? 'tms';
  const modelVersion = overrides.model_version ?? `synthetic-${kind}-model@1.0`;
  const evaluate = overrides.evaluate ?? (() => passVerdict());
  // seams **整体替换**（不是逐键合并）：便于构造"少声明一个 seam"的反例。
  const seams = overrides.seams ?? {
    // 这些 seam 故意是"抛错/不可用"的替身：本包**从不**调用它们（用例会断言这一点）。
    fetchImpl: () => {
      throw new Error('synthetic seam must never be called by packages/moderation');
    },
    credentials: { kind: 'synthetic-placeholder-not-a-secret' },
    liveGate: { open: false },
    now: () => 0,
  };
  const provider = {
    biz_type: 'synthetic-biz-placeholder',
    biz_type_selection_verified: true,
    synthetic: true,
    timeout_ms: 1000,
    ...overrides.provider,
  };
  const port = { kind, model_version: modelVersion, evaluate, seams, provider };
  if (overrides.drop) for (const field of overrides.drop) delete port[field];
  return port;
}

/** 合成端口：调用即抛出给定异常。 */
export function portThrowing(error, overrides = {}) {
  return makePort({ ...overrides, evaluate: () => { throw error; } });
}

/** 合成端口：永不 resolve（配合 deadline_ms 触发合流层自己的超时闸门）。 */
export function neverResolvingPort(overrides = {}) {
  return makePort({ ...overrides, evaluate: () => new Promise(() => {}) });
}

/** 构造带 `model_failure` 显式声明的异常。 */
export function modelFailureError(failureClass, overrides = {}) {
  return Object.assign(new Error(`synthetic model failure: ${failureClass}`), {
    model_failure: failureClass,
    ...overrides,
  });
}

/** 合法的“当前版本三元组”（供重审用例使用）。 */
export function currentBinding(overrides = {}) {
  return {
    rule_version: CLEAN_RULE_RESULT.rule_version,
    model_version: 'synthetic-tms-model@1.0',
    prompt_version: null,
    target_ref: makeContent().target_ref,
    ...overrides,
  };
}

/** 与规则层结果**逐字段一致**的合成"既有结论"（已补齐模型层字段）。 */
export function existingApproved(overrides = {}) {
  return {
    target_ref: makeContent().target_ref,
    decision: 'approved',
    reason_codes: [],
    hard_rule_passed: true,
    rule_version: CLEAN_RULE_RESULT.rule_version,
    model_version: 'synthetic-tms-model@1.0',
    prompt_version: 'mp1+sha256:' + 'a'.repeat(32),
    ...overrides,
  };
}
