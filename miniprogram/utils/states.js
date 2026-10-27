/**
 * 统一状态层（B7 / #28）
 * ---------------------------------------------------------------------------
 * 把「接口错误码」与「页面阶段」翻译成 `components/state-view` 能直接渲染的状态，
 * 让全站只有**一套**失败/空态/模拟标记的表达，各页面不再自写灰字或各造一套语气。
 *
 * B7 任务口径的五个状态（与组件既有状态名的对照，不重命名既有状态以免与既有证据冲突）：
 *
 *   loading  处理中        → status="loading"
 *   empty    空结果        → status="empty"
 *   error    失败（分 kind）→ status="error" + kind（见 KIND）
 *   mock     模拟/替身数据  → status="mock"（组件内等价于既有 status="stub"，文案逐字相同）
 *   denied   无权（已登录但无权限）→ status="denied"
 *
 * `denied` 与 `guest` 必须分开：`guest` 是「还没登录」（401 SESSION_REQUIRED 系列），
 * `denied` 是「登录了但这件东西不给你」（403 SCOPE_DENIED / CONSENT_REQUIRED / ACCOUNT_INACTIVE /
 * SELF_SCOPE_GRANT_DENIED）。把后者折叠成「请先登录」会让用户反复登录却不明白为什么还是不行。
 * `refused` 是第三类拒绝：登录了、也有这项权限，但这条业务规则不让做（409 LAST_SCOPE_MANAGER /
 * SELF_DISABLE_DENIED）。它既不是「权限不够」（换账号也还是不行），也不是「内容已变更」（重读无用）。
 *
 * 错误码取值来源：`services/api/src/contract.ts` 的 ERROR_STATUS_MAP（契约 1.0.0）。
 * 本模块**只读**消费契约，不修改 packages/contracts 与 services/api；
 * 覆盖率由 `tests/ui-unified-states.test.mjs` 对着 contract.ts 逐码核对。
 */

/** 契约错误码 → 分类（kind）。分类决定语气、图标与「能不能重试」，不负责具体文案。 */
const CODE_KIND = {
  // —— 400 请求本身不合法：改条件再试，原样重发不会变好 ——
  INVALID_REQUEST: 'input',
  INVALID_CURSOR: 'input',
  IDEMPOTENCY_KEY_REQUIRED: 'input',
  // —— 401 会话类：等价于「没登录/登录过期」，走 guest ——
  SESSION_REQUIRED: 'session',
  SESSION_EXPIRED: 'session',
  // —— 403 权限类：登录了也不给，走 denied ——
  SCOPE_DENIED: 'denied',
  CONSENT_REQUIRED: 'denied',
  ACCOUNT_INACTIVE: 'denied',
  SELF_SCOPE_GRANT_DENIED: 'denied',
  // —— 404 找不到：可能是下架/不可见，走 invalid（不是网络错） ——
  NOT_FOUND: 'notfound',
  // —— 409／428 冲突/已失效：要重新读取后重来 ——
  REVISION_CONFLICT: 'conflict',
  REVISION_REQUIRED: 'conflict',
  IDEMPOTENCY_CONFLICT: 'conflict',
  OBJECT_UNAVAILABLE: 'notfound',
  REQUEST_IN_PROGRESS: 'conflict',
  // —— 409 但不是「内容已变更」：业务规则明令拒绝，重读、重试都不会变好 ——
  // LAST_SCOPE_MANAGER＝撤掉/停用最后一名管理员，后台就没人能管了：得先把管理员权限授给另一位同事；
  // SELF_DISABLE_DENIED＝不能停用自己（会把自己锁在门外）：请另一位管理员来停用你的账号。
  // 为什么不是 conflict：conflict 会给「可以重试」并说「内容已变更」，这两个提示都是假的。
  // 为什么不是 denied：utils/auth.js 的 FORBIDDEN_CODES 由 kind === 'denied' 反推（契约 403 闭集），
  // 把 409 混进去会让 401/403 归因多出两个永不出现的成员。呈现仍与 denied 同形态（见 statusForCode）。
  LAST_SCOPE_MANAGER: 'refused',
  SELF_DISABLE_DENIED: 'refused',
  // —— 413/415 媒体限制：本机文件不合用途要求 ——
  MEDIA_TOO_LARGE: 'input',
  MEDIA_TYPE_UNSUPPORTED: 'input',
  // —— 422 条件/来源不足：不是错误，但结果不可用 ——
  CONDITIONS_INCOMPLETE: 'input',
  SOURCE_CONFLICT: 'conflict',
  INPUT_UNCERTAIN: 'input',
  // —— 429/5xx 服务侧：稍后可重试 ——
  RATE_LIMITED: 'throttled',
  PROVIDER_QUOTA_EXCEEDED: 'throttled',
  PROVIDER_UNAVAILABLE: 'unavailable',
  PROVIDER_OUTCOME_UNKNOWN: 'unavailable',
  PROVIDER_TIMEOUT: 'unavailable',
  // —— 500 服务端自身缺陷：兜底信封返回的**未归类异常**，同属服务侧但**不可重试** ——
  // HTTP 500：服务端未归类异常时由 `services/api/src/app.ts` 的 setErrorHandler 兜底信封返回
  // （#688 起契约里才有这个码，`ERROR_STATUS_MAP` 的 `500: ['INTERNAL_ERROR']`）。可重试性：否。
  // 为什么不是 unavailable：那一类装的是**上游/装配**问题，不是服务端自身缺陷——503 的
  // `PROVIDER_UNAVAILABLE`／`PROVIDER_OUTCOME_UNKNOWN`、504 的 `PROVIDER_TIMEOUT`，连同客户端自造码
  // `UNAVAILABLE`，共 **4** 个码，过一会儿重发有意义；500 是服务端自己的代码缺陷，原样重发只会再撞
  // 一次同样的异常，给「重试」按钮等于让用户白点——且 `KIND_RETRYABLE.unavailable` 为 true，
  // 改它等于一次改掉上面 4 个码的可重试性。
  // 为什么不是 unknown：码是契约里已知的兜底码，标成「未分类的失败」会让用户以为页面没识别出来。
  INTERNAL_ERROR: 'server',
  // —— 客户端自造码（不在契约里，仅本仓 miniprogram 适配层使用） ——
  // auth.js / *-api.js 在本地判定不可联网、服务端未接线时抛这两个，必须同样有归类，
  // 否则会出现「有码但无状态」的空白提示。它们不是契约码，故单列在此并注明来源。
  SESSION_CHANGED: 'session', // utils/auth.js
  UNAVAILABLE: 'unavailable' // */api.js：非 200 且非已知码时的兜底分类
};

/**
 * 客户端自造码的**显式允许清单**（不属契约；双向判据的反向半边靠它兜底）。
 * `tests/ui-unified-states.test.mjs` 用它把「多出来的码」也判成红：
 * CODE_KIND 的每个键必须 ∈ 契约码 ∪ 本清单，本清单的每一项也必须真的在 CODE_KIND 里。
 * 为什么它们不需要契约：来源是本仓适配层的本地判定（auth.js 发现令牌被换掉、
 * *-api.js 遇到非 200 且码不可识别），服务端根本不会返回它们；但同样必须有归类，
 * 否则会出现「有码但无状态」的空白提示。
 */
const CLIENT_ONLY_CODES = Object.freeze(['SESSION_CHANGED', 'UNAVAILABLE']);

/** kind 的中文名，用于组件上的可读标签（不替代标题，只补一行「这是哪类问题」）。 */
const KIND_LABEL = {
  session: '未登录／登录已过期',
  denied: '没有权限',
  refused: '操作不被允许',
  notfound: '内容不存在或已失效',
  conflict: '内容已变更，需重新读取',
  input: '条件不合法',
  throttled: '请求过于频繁',
  unavailable: '服务暂时不可用',
  server: '服务端错误',
  unknown: '未分类的失败'
};

/**
 * kind → 可重试性。
 * 只有「服务侧临时问题」和「冲突需重读」值得让用户原地重试；
 * 请求不合法、无权限、找不到的内容，重试不会变好，重试按钮只会让人白点。
 */
const KIND_RETRYABLE = {
  session: false, // 需要重新登录，不是重试
  denied: false,
  refused: false, // 业务规则拒绝：要换人操作或先补人，原地重试永远同样的结果
  notfound: false,
  conflict: true,
  input: false,
  throttled: true,
  unavailable: true,
  server: false, // HTTP 500 兜底：服务端自身缺陷，同一请求重发只会再撞一次同样的异常
  unknown: false
};

/** 组件状态名。mock 落到既有 `stub`（替身）形态与文案，避免同一件事两个名字两套样式。 */
const STATUS = {
  LOADING: 'loading',
  EMPTY: 'empty',
  ERROR: 'error',
  MOCK: 'stub',
  DENIED: 'denied',
  INVALID: 'invalid',
  GUEST: 'guest'
};

/** 服务端 mode 为替身/预设演示时的统一判定（与 identify-api / community-api 的既有口径一致）。 */
function isMockMode(mode) {
  return mode === 'stub' || mode === 'preset_demo';
}

/** kind 标签；未知码返回空串（不编造分类）。 */
function kindLabel(code) {
  const kind = CODE_KIND[code];
  return kind ? KIND_LABEL[kind] : '';
}

/**
 * 错误码 → 组件 status。
 *   401 系列 → guest（没登录）
 *   403 系列 → denied（登录了但无权）
 *   refused  → denied（业务规则拒绝：同一形态——锁住、不给重试，只是标签说得更准）
 *   404/OBJECT_UNAVAILABLE → invalid（内容已失效）
 *   其它     → error
 * 未知码一律 error：宁可显示通用失败，也不假装成功。
 */
function statusForCode(code) {
  const kind = CODE_KIND[code];
  if (kind === 'session') return STATUS.GUEST;
  if (kind === 'denied') return STATUS.DENIED;
  if (kind === 'refused') return STATUS.DENIED;
  if (kind === 'notfound') return STATUS.INVALID;
  return STATUS.ERROR;
}

/** 错误码是否值得让用户原地重试。未知码按「不可重试」处理，避免无效重试。 */
function retryableForCode(code) {
  const kind = CODE_KIND[code];
  return kind ? KIND_RETRYABLE[kind] === true : false;
}

/**
 * 页面接入用的解析器：给定错误码与页面自有文案，返回组件属性。
 * 页面自己的领域文案（如「照片未上传」）优先，本函数只补「哪类问题 + 能否重试」。
 *
 * @param {string} code 契约错误码或客户端自造码
 * @param {{title?: string, desc?: string, retryable?: boolean}} [fallback]
 * @returns {{status: string, code: string, kindLabel: string, retryable: boolean}}
 */
function resolve(code, fallback) {
  const options = fallback || {};
  const value = typeof code === 'string' ? code : '';
  const known = !!CODE_KIND[value];
  return {
    status: value ? statusForCode(value) : STATUS.ERROR,
    code: value,
    kindLabel: kindLabel(value),
    retryable: options.retryable === undefined ? retryableForCode(value) : options.retryable === true,
    known: known
  };
}

module.exports = {
  STATUS,
  KIND_LABEL,
  // 导出只为让 `tests/ui-unified-states.test.mjs` 能判「每个 kind 都显式声明了可重试性」：
  // 少了条目时 `retryableForCode` 对未知 kind 一律回 false，行为上看不出差别（等于静默失效）。
  KIND_RETRYABLE,
  CODE_KIND,
  CLIENT_ONLY_CODES,
  isMockMode,
  kindLabel,
  statusForCode,
  retryableForCode,
  resolve
};
