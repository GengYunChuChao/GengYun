/**
 * 后台「功能开关」页的展示状态机——纯 ESM，无 Vue／DOM 依赖。
 *
 * 目的与账号页同一口径：把「未登录／加载中／空／错误／已就绪／写入中／写入失败」
 * 收进纯函数，钉住四条不下假的规则：
 *  1. 没有会话就不可能显示开关行（`LOAD_OK` 在未登录态被丢弃）；
 *  2. 刷新失败时保留旧行但标 `stale`，不把旧数据当本次结果；
 *  3. 写入失败**保留服务端的状态码与错误码**（428／409／503…）原样展示，不改写成泛化文案；
 *  4. 「可重试」只给真正幂等安全的情形（同一 If-Match + 同一 Idempotency-Key）；
 *     修订冲突（409）不给原样重试，只给「重新读取」。
 *
 * 契约事实：`Flag` 只有 `key`/`enabled`/`revision` 三个字段（`additionalProperties: false`），
 * **没有 scope、没有描述、没有修改人**——所以页面不造这些列，只把「本会话是否有 flags:write」
 * 作为**会话权限**单独展示，并明说它不是开关属性。
 */
import { FLAGS_READ_SCOPE, FLAGS_WRITE_SCOPE, etagForRevision, reasonProblem } from './flags-api.mjs';

/** 初始态：未登录，未发过请求。 */
export function initialState() {
  return {
    phase: 'signed_out',
    signedIn: false,
    flags: [],
    nextCursor: null,
    pages: 0,
    loadingMore: false,
    readFailure: null,
    stale: false,
    selectedKey: null,
    reason: '',
    scopesProvided: false,
    hasReadScope: false,
    hasWriteScope: false,
    /** 进行中／可重试的写意向：重试必须复用它里面的 `idempotencyKey` 与 `revision`。 */
    write: null,
    writeStatus: 'idle',
    writeFailure: null,
  };
}

function containsScope(scopes, scope) {
  return Array.isArray(scopes) && scopes.includes(scope);
}

function mergeFlags(current, incoming) {
  const byKey = new Map(current.map((flag) => [flag.key, flag]));
  for (const flag of incoming) byKey.set(flag.key, flag);
  // 契约闭集只有 3 个键；顺序按 `FLAG_KEYS` 的稳定次序，未知名排在末尾（不会走到这里：校验器已拒绝）。
  return Array.from(byKey.values());
}

/** 纯 reducer：不合法的事件（例如未登录态下的成功回调）原样返回旧状态。 */
export function reduce(state, action) {
  switch (action?.type) {
    case 'SESSION_MISSING':
      return { ...initialState(), readFailure: action.failure ?? null };

    case 'SIGN_IN_START':
      return { ...initialState(), phase: 'signing_in' };

    case 'SIGN_IN_FAILED':
      return { ...initialState(), readFailure: action.failure ?? null };

    case 'SIGNED_IN':
      return {
        ...state,
        signedIn: true,
        phase: 'loading',
        readFailure: null,
        scopesProvided: action.scopesProvided === true,
        hasReadScope: !(action.scopesProvided === true) || containsScope(action.scopes, FLAGS_READ_SCOPE),
        hasWriteScope: !(action.scopesProvided === true) || containsScope(action.scopes, FLAGS_WRITE_SCOPE),
      };

    case 'SIGN_OUT':
      return initialState();

    case 'LOAD_START':
      if (!state.signedIn) return state;
      if (action.reset === true) {
        return {
          ...state,
          phase: state.flags.length > 0 ? 'ready' : 'loading',
          readFailure: null,
          stale: state.flags.length > 0,
          selectedKey: null,
        };
      }
      return { ...state, loadingMore: true, readFailure: null };

    case 'LOAD_OK': {
      if (!state.signedIn) return state; // 未登录却收到成功回调：丢弃，不显示任何行
      const incoming = Array.isArray(action.flags) ? action.flags : [];
      const flags = action.reset === true ? incoming : mergeFlags(state.flags, incoming);
      return {
        ...state,
        phase: 'ready',
        flags,
        nextCursor: action.nextCursor ?? null,
        pages: state.pages + 1,
        loadingMore: false,
        readFailure: null,
        stale: false,
        selectedKey: flags.some((flag) => flag.key === state.selectedKey) ? state.selectedKey : null,
      };
    }

    case 'LOAD_FAIL': {
      if (!state.signedIn) return state;
      const failure = action.failure;
      if (failure && failure.kind === 'signed_out') return { ...initialState(), readFailure: failure };
      const hasRows = state.flags.length > 0;
      return {
        ...state,
        phase: hasRows ? 'ready' : 'error',
        loadingMore: false,
        readFailure: failure,
        stale: hasRows,
      };
    }

    case 'SELECT': {
      const key = action.key;
      if (typeof key !== 'string') return state;
      if (!state.flags.some((flag) => flag.key === key)) return state;
      return { ...state, selectedKey: key };
    }

    case 'CLOSE_DETAIL':
      return { ...state, selectedKey: null };

    case 'SET_REASON':
      return { ...state, reason: typeof action.value === 'string' ? action.value : '' };

    case 'WRITE_START': {
      if (!state.signedIn) return state;
      const problem = reasonProblem(action.reason);
      if (problem !== null) return state; // 本地就不合法：不发请求、不改状态
      if (etagForRevision(action.revision) === null) return state; // 没有可用 ETag 时不猜 If-Match
      return {
        ...state,
        writeStatus: 'saving',
        writeFailure: null,
        write: {
          key: action.key,
          enabled: action.enabled === true,
          revision: action.revision,
          reason: action.reason,
          idempotencyKey: action.idempotencyKey,
          attempts: (state.write?.attempts ?? 0) + 1,
        },
      };
    }

    case 'WRITE_OK': {
      if (!state.signedIn) return state;
      const flag = action.flag;
      return {
        ...state,
        flags: state.flags.map((row) => (row.key === flag.key ? flag : row)),
        writeStatus: 'saved',
        write: null,
        writeFailure: null,
        stale: false,
      };
    }

    case 'WRITE_FAIL': {
      if (!state.signedIn) return state;
      const failure = action.failure ?? { ok: false, kind: 'http_error', retriable: false, message: '未知错误' };
      if (failure.kind === 'signed_out') return { ...initialState(), readFailure: failure };
      return {
        ...state,
        writeStatus: 'failed',
        writeFailure: failure,
        // 可重试 ⇒ 保留写意向（同一幂等键 + 同一 If-Match 重发）；否则丢弃意向，
        // 逼用户重新读取（修订冲突后原样重发只会再 409）。
        write: failure.retriable === true ? state.write : null,
        // 写入失败意味着手里的行可能已过期：标 stale，但不改行内容（不猜新值）。
        stale: true,
      };
    }

    case 'WRITE_CLEAR':
      return { ...state, writeStatus: 'idle', write: null, writeFailure: null };

    default:
      return state;
  }
}

/** 行视图：只做展示，不改变字段含义。 */
export function rowViews(state) {
  return state.flags.map((flag) => ({
    key: flag.key,
    enabled: flag.enabled,
    enabledLabel: flag.enabled ? '启用' : '关闭',
    tone: flag.enabled ? 'ok' : 'off',
    revision: flag.revision,
    revisionLabel: `r${flag.revision}`,
    etag: etagForRevision(flag.revision) ?? '—',
    writing: state.writeStatus === 'saving' && state.write?.key === flag.key,
    hasWriteScope: state.hasWriteScope,
  }));
}

export function canLoadMore(state) {
  return state.phase === 'ready' && state.nextCursor !== null && !state.loadingMore;
}

/** 当前输入的理由是否可用；返回错误文案或 null。 */
export function reasonProblemOf(state) {
  return reasonProblem(state.reason);
}

/**
 * 本会话能否发起写入。
 *
 * - 未登录 / 未就绪 ⇒ 否；
 * - 会话 scope 明确不含 `flags:write` ⇒ 否（服务端会 403，不必先发一次必失败的请求）；
 * - 理由不合法 ⇒ 否（契约 `FlagInput.reason` 必填）；
 * - 正在写入 ⇒ 否。
 */
export function canWrite(state) {
  if (!state.signedIn) return false;
  if (state.phase !== 'ready') return false;
  if (!state.hasWriteScope) return false;
  if (state.writeStatus === 'saving') return false;
  return reasonProblem(state.reason) === null;
}

/** 失败对象 → 展示文案；`status`／`code` 原样带上，不用泛化文案顶替。 */
function failureView(failure, { label }) {
  const codeTag = [failure.status === null || failure.status === undefined ? null : `HTTP ${failure.status}`, failure.code]
    .filter((part) => part !== null && part !== '')
    .join(' · ');
  const suffix = codeTag === '' ? '' : `（${codeTag}）`;
  const out = (title, detail, action, retriable) => ({ title: `${title}${suffix}`, detail, action, retriable: retriable === true, code: failure.code ?? null, status: failure.status ?? null });
  switch (failure.kind) {
    case 'signed_out':
      return out('未登录或会话已过期', '请重新登录后台后再试', 'sign_in', false);
    case 'forbidden':
      return out('权限不足（缺少 flags:write）', `后台会话有效，但${label}要求 scope flags:write`, 'none', false);
    case 'revision_required':
      return out('缺少 If-Match', '服务端要求强 ETag（形如 "3"）；请点「重新读取」拿到最新 revision 后再写', 'reload', false);
    case 'revision_conflict':
      return out('开关已被改动（修订冲突）', '本次 If-Match 与服务端当前 ETag 不一致；请「重新读取」后再决定是否重试', 'reload', false);
    case 'idempotency_conflict':
      return out('同一幂等键的请求内容不一致', '本页复用了幂等键但换了请求体；请「重新读取」后重新发起（不要原样重发）', 'reload', false);
    case 'idempotency_key_required':
      return out('缺少 Idempotency-Key', '写操作必须带幂等键；请「重新读取」后重试', 'reload', false);
    case 'in_progress':
      return out('同一操作正在处理中', '服务端判定该幂等键的在途请求未完成；稍后用同一幂等键重试会命中同一结果', 'retry', true);
    case 'not_found':
      return out('开关不存在', '服务端返回 404；请「重新读取」确认当前开关集合', 'reload', false);
    case 'invalid_request':
      return out('请求被拒绝', failure.message || '服务端判定请求体/参数不合法', 'none', false);
    case 'invalid_cursor':
      return out('游标无效', '需从第一页重新读取', 'reload', false);
    case 'rate_limited':
      return out(
        '请求过于频繁',
        failure.retryAfterSeconds === null || failure.retryAfterSeconds === undefined
          ? '稍后重试'
          : `约 ${failure.retryAfterSeconds} 秒后重试`,
        'retry',
        true,
      );
    case 'unavailable':
      return out('服务暂不可用', '开关端口未接线或暂时不可用（不返回伪造的成功值）；稍后重试', 'retry', true);
    case 'network_error':
      return out('网络请求失败', failure.message || '检查 API 基地址与网络后重试', 'retry', true);
    case 'invalid_response':
      return out('响应不符合契约', failure.message || '未渲染任何猜测值', 'none', false);
    default:
      return out('请求失败', failure.message || '未知错误', 'none', false);
  }
}

/** 读面失败 → 页面文案。 */
export function describeReadFailure(failure) {
  if (!failure || failure.ok !== false) return null;
  return failureView(failure, { label: '读取开关列表' });
}

/** 写面失败 → 面板文案。 */
export function describeWriteFailure(failure) {
  if (!failure || failure.ok !== false) return null;
  return failureView(failure, { label: '切换开关' });
}

/** 页面级状态描述：文案互斥且如实。 */
export function describe(state) {
  if (state.phase === 'signing_in') {
    return { tone: 'loading', title: '正在登录', detail: '提交登录名与密码', action: 'none', canRetry: false };
  }
  if (state.phase === 'signed_out') {
    const failure = describeReadFailure(state.readFailure);
    return {
      tone: 'signed_out',
      title: '未登录',
      detail: failure ? `${failure.title}：${failure.detail}` : '登录后台后才能读取功能开关',
      action: 'sign_in',
      canRetry: false,
    };
  }
  if (state.phase === 'loading') {
    return { tone: 'loading', title: '正在读取功能开关', detail: 'GET /admin/feature-flags', action: 'none', canRetry: false };
  }
  if (state.phase === 'error') {
    const failure = describeReadFailure(state.readFailure);
    return {
      tone: 'error',
      title: failure?.title ?? '读取失败',
      detail: failure?.detail ?? '未知错误',
      action: failure?.action ?? 'none',
      canRetry: failure?.retriable === true,
    };
  }

  const failure = describeReadFailure(state.readFailure);
  const total = state.flags.length;
  const base = { action: failure?.action ?? 'none', canRetry: failure?.retriable === true, total };
  if (total === 0) {
    return {
      ...base,
      tone: 'empty',
      title: '开关列表为空',
      detail: '接口返回 0 行（items 为空且 next_cursor 为 null）：这是空列表，不是错误，也不代表开关"全部关闭"',
    };
  }
  return {
    ...base,
    tone: state.stale ? 'stale' : 'ready',
    title: state.stale ? '显示的可能不是最新值' : '已读取功能开关',
    detail: state.stale
      ? `共 ${total} 行；最近一次读取或写入失败，需重新读取后才算最新`
      : `共 ${total} 行（已翻 ${state.pages} 页）`,
  };
}

/**
 * 详情：**只有**列表行返回的 3 个字段 + 由 revision 推出的 ETag。
 * 契约没有单开关详情接口，也没有 scope／描述／修改人字段 ⇒ 一律标注「读面未提供」，不填假值。
 */
export function detailOf(state) {
  if (state.selectedKey === null) return null;
  const flag = state.flags.find((row) => row.key === state.selectedKey);
  if (flag === undefined) return null;
  return {
    key: flag.key,
    title: flag.key,
    fields: [
      { label: 'key', value: flag.key },
      { label: 'enabled', value: String(flag.enabled) },
      { label: 'revision', value: String(flag.revision) },
      { label: 'If-Match（由 revision 推出）', value: etagForRevision(flag.revision) ?? '—' },
    ],
    missing: ['开关的人类可读说明', '最后修改人与时间', '变更审计记录', '开关所属作用域（scope）'],
    note: '字段仅取自 GET /admin/feature-flags 的列表行；契约 Flag 只有 key/enabled/revision 三个字段，以上缺项不是"加载失败"，是读面本来没有。',
  };
}
