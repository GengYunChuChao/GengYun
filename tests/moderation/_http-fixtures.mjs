/**
 * GY-I14（#14）审核 HTTP 装配片 · 测试夹具。
 *
 * 声明（必须如实，不得被引用为模型证据）：
 *   - 注入的"模型端口"全部是**合成替身**（`provider.synthetic === true`），**不发任何网络请求**、
 *     不持有凭据、不读环境变量；真实 `tms`/`ims` **未授权**，本片一律不调；
 *   - `docs/evaluation/sample-gap-register.md` 已确认 `ai_moderation_risk` / `ai_moderation_normal`
 *     真实样本**各为 0** ⇒ 本文件与全部用例**不得**被引用为审核准确率／召回率或可用性证据；
 *   - 规则文本夹具复用 `tests/moderation/_fixtures.mjs`、模型端口夹具复用 `_model-fixtures.mjs`
 *     （**同一份**，避免在装配片里复制会漂移的第二份样本）。
 */
import { createModerationService } from '../../services/api/src/moderation/service.ts';
import { createModerationLedger } from '../../services/api/src/moderation/decisions.ts';
import {
  createReadCache,
  createSubstituteContentAuthority,
} from '../../services/api/src/moderation/visibility.ts';
import { signCallbackPayload } from '../../services/api/src/moderation/callback.ts';
import { deriveRuleVersion } from '../../packages/moderation/index.mjs';
import { derivePromptVersionForIds } from '../../packages/moderation/prompt-version.mjs';
import {
  CLEAN_TEXT,
  IMAGE_REF,
  RULE_BUDGET_MS,
  makePort,
  passVerdict,
} from './_model-fixtures.mjs';
import { FROZEN_CLOCK } from './_fixtures.mjs';

export { CLEAN_TEXT, FROZEN_CLOCK, IMAGE_REF, RULE_BUDGET_MS, makePort, passVerdict };
export { RULE_TEXT_FIXTURES, buildScanLimitText, makeExtraRule } from './_fixtures.mjs';
export { modelFailureError, neverResolvingPort, portThrowing, blockVerdict } from './_model-fixtures.mjs';

/** 仅测试用回调验签密钥（不是真实密钥、不入库、不入日志）。 */
export const TEST_CALLBACK_KEY = 'gy-i14-http-test-callback-key';

export const USER_A = Object.freeze({
  userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  role: 'user',
  authEpoch: 1,
});
export const USER_B = Object.freeze({
  userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  role: 'user',
  authEpoch: 1,
});
export const ADMIN = Object.freeze({
  userId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  role: 'admin',
  authEpoch: 1,
});

/** 生成契约格式的确定性 uuid（避免随机性影响断言）。 */
export function makeIdFactory(namespace = '5') {
  let counter = 0;
  return () => {
    counter += 1;
    const suffix = String(counter).padStart(12, '0');
    return `00000000-0000-4000-8${namespace}00-${suffix}`;
  };
}

/** 确定性租约令牌（同样避免随机性）。 */
export function makeLeaseFactory() {
  let counter = 0;
  return () => {
    counter += 1;
    return `lease-${String(counter).padStart(4, '0')}`;
  };
}

/** 文本内容（无媒体）。 */
export function textContent(overrides = {}) {
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

/** 带一张图片的内容（媒体为**不透明引用**，不含字节）。 */
export function mediaContent(overrides = {}) {
  return textContent({ media: [{ ...IMAGE_REF }], ...overrides });
}

/** 合成端口 + 调用计数（用于断言"规则先挡 ⇒ 模型端口不跑"）。 */
export function countingPort(kind, options = {}) {
  const calls = { count: 0, requests: [] };
  const modelVersion = options.model_version ?? `synthetic-${kind}-model@1.0`;
  const evaluate = options.evaluate ?? (() => passVerdict());
  const port = makePort({
    kind,
    model_version: modelVersion,
    evaluate: (request) => {
      calls.count += 1;
      calls.requests.push(request);
      return evaluate(request);
    },
    ...(options.provider === undefined ? {} : { provider: options.provider }),
  });
  return { port, calls, model_version: modelVersion };
}

/**
 * 构造审核域测试夹具（默认 `stub`；注入端口全部是**合成替身**）。
 * `now` 每次调用递增 1 秒，保证时间戳可断言。
 */
export function makeHarness(options = {}) {
  let tick = 0;
  const base = Date.UTC(2026, 9, 14, 3, 0, 0);
  const now = options.now ?? (() => new Date(base + (tick += 1) * 1000));
  const ledger = options.ledger ?? createModerationLedger();
  const cache = options.cache ?? createReadCache();
  const authority = options.authority ?? createSubstituteContentAuthority();
  const newId = options.newId ?? makeIdFactory();
  const service = createModerationService({
    executionMode: options.executionMode ?? 'stub',
    store: ledger,
    cache,
    authority,
    callbackKey: options.callbackKey === undefined ? TEST_CALLBACK_KEY : options.callbackKey,
    now,
    newId,
    newLeaseToken: options.newLeaseToken ?? makeLeaseFactory(),
    ...(options.ports === undefined ? {} : { ports: options.ports }),
    ruleOptions: { clock: FROZEN_CLOCK, budget_ms: RULE_BUDGET_MS, ...(options.ruleOptions ?? {}) },
    ...(options.modelDeadlineMs === undefined ? {} : { modelDeadlineMs: options.modelDeadlineMs }),
  });
  return { service, ledger, cache, authority, now, newId };
}

/** 登记一个"权威侧"目标（替身权威；测试用它模拟真实内容状态）。 */
export function seedAuthority(authority, target, overrides = {}) {
  authority.seed(target, {
    visibility: overrides.visibility ?? 'private',
    author_state: overrides.author_state ?? 'active',
    source_kind: overrides.source_kind ?? 'database',
    owner_id: overrides.owner_id ?? USER_A.userId,
    current_revision: overrides.current_revision ?? target.revision,
  });
}

/** 捕获错误（断言契约错误码/状态/可重试标志，以及 details 里的原因码）。 */
export async function captureError(run) {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('期望抛出错误，但没有抛出');
}

/** 回调信封（默认值可由用例覆盖）。 */
export function callbackEnvelope(overrides = {}) {
  return {
    schema: 'gengyun/moderation/provider-callback@1',
    event_id: overrides.event_id ?? 'evt-0001',
    issued_at: overrides.issued_at ?? new Date(Date.UTC(2026, 9, 14, 3, 0, 0)).toISOString(),
    job_id: overrides.job_id ?? '00000000-0000-4000-8500-000000000001',
    job_revision: overrides.job_revision ?? 1,
    lease_token: overrides.lease_token ?? 'lease-0001',
    input_digest: overrides.input_digest ?? 'mib1+sha256:' + '0'.repeat(32),
    target_ref: overrides.target_ref ?? { type: 'post', id: 'post-1001', revision: 1 },
    content_kind: overrides.content_kind ?? 'text',
    rule_version: overrides.rule_version ?? 'mr1+sha256:' + '0'.repeat(32),
    model_version: overrides.model_version ?? 'synthetic-tms-model@1.0',
    prompt_version: overrides.prompt_version ?? 'mp1+sha256:' + '0'.repeat(32),
    authorization_epoch: overrides.authorization_epoch ?? 1,
    verdict: overrides.verdict ?? { label: 'pass', reason_codes: [], summary: 'synthetic' },
    ...(overrides.extra === undefined ? {} : overrides.extra),
  };
}

/** 签名后的回调请求（`raw_body` 是逐字节请求体，签名覆盖它）。 */
export function signedCallback(envelope, key = TEST_CALLBACK_KEY, options = {}) {
  const raw = options.raw_body ?? JSON.stringify(envelope);
  return { raw_body: raw, signature: options.signature ?? signCallbackPayload(raw, key) };
}

/** 夹具时钟基准（`makeHarness` 的 `now` 从它起每调用 +1 秒）。 */
export const HARNESS_BASE_ISO = new Date(Date.UTC(2026, 9, 14, 3, 0, 0)).toISOString();

/** 当前出厂规则集派生版本 / prompt 版本（回调核对用；由内容决定需要的 prompt 集合）。 */
export const RULE_VERSION_CURRENT = deriveRuleVersion();
export const TEXT_PROMPT_VERSION = derivePromptVersionForIds(['text_moderation']);
export const IMAGE_PROMPT_VERSION = derivePromptVersionForIds(['image_moderation']);
export const TEXT_AND_IMAGE_PROMPT_VERSION = derivePromptVersionForIds(['text_moderation', 'image_moderation']);

/**
 * 为一**待回调**任务构造合法回调信封（默认全部字段与任务当前值一致 ⇒ 可被接受）。
 * 用例通过 `overrides` 只改一项来构造"伪造/过期/回放/版本过期"等负例。
 */
export function envelopeForTask(task, overrides = {}) {
  return callbackEnvelope({
    event_id: overrides.event_id ?? 'evt-0001',
    issued_at: overrides.issued_at ?? HARNESS_BASE_ISO,
    job_id: overrides.job_id ?? task.job_id,
    job_revision: overrides.job_revision ?? task.job_revision,
    lease_token: overrides.lease_token ?? task.lease_token,
    input_digest: overrides.input_digest ?? task.evidence.input_binding_digest,
    target_ref: overrides.target_ref ?? task.target_ref,
    content_kind: overrides.content_kind ?? task.content_kind,
    rule_version: overrides.rule_version ?? RULE_VERSION_CURRENT,
    model_version: overrides.model_version ?? 'synthetic-tms-model@1.0',
    prompt_version: overrides.prompt_version ?? TEXT_PROMPT_VERSION,
    authorization_epoch: overrides.authorization_epoch ?? task.authorization_epoch,
    verdict: overrides.verdict ?? { label: 'pass', reason_codes: [], summary: 'synthetic' },
    ...(overrides.extra === undefined ? {} : overrides.extra),
  });
}
