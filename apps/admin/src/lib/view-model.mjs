/**
 * 后台账号页的展示状态机（读面 + 停用写面）——纯 ESM，无 Vue／DOM 依赖。
 *
 * 目的：把「加载中／空／错误／已就绪／未登录／停用确认中／停用写入中／停用失败」
 * 这些**会骗人的**状态收进一个纯函数里，由测试钉住以下不下假的规则：
 *  1. 没有会话就不可能出现行（`LOAD_OK` 在未登录态被丢弃）；
 *  2. 刷新失败时保留旧行但必须标 `stale`，不许把旧数据当新数据；
 *  3. 「接口返回 0 行」与「筛选后 0 行」是两种空态，文案不得混用；
 *  4. 停用写入失败**保留服务端状态码与错误码**（428／409／503…）原样展示；
 *  5. 「可重试」只给真正幂等安全的情形（同一 If-Match + 同一 Idempotency-Key）。
 */
import { describeFailure, serverAllowsRetry } from './admin-api.mjs';
import { ACCOUNTS_SCOPE } from './admin-contract.mjs';
import { ACCOUNTS_SUSPEND_SCOPE, etagForRevision, reasonProblem } from './account-suspend-api.mjs';

/** 账号状态 → 中文标签（与契约 enum 一一对应）。 */
export const STATE_LABELS = Object.freeze({
  active: '启用',
  suspended: '已停用',
  deletion_pending: '注销处理中',
});

/** 状态 → 视觉语气（tone 只影响样式，不影响语义）。 */
export const STATE_TONES = Object.freeze({
  active: 'ok',
  suspended: 'warn',
  deletion_pending: 'danger',
});

/** 初始态：未登录，未发过请求。 */
export function initialState() {
  return {
    phase: 'signed_out',
    signedIn: false,
    collection: { items: [], nextCursor: null, seenIds: [], pages: 0, duplicates: 0, cycle: false },
    requestCursor: null,
    loadingMore: false,
    failure: null,
    filter: '',
    selectedId: null,
    stale: false,
    scopeWarning: false,
    /** 会话 scope 里是否缺少 accounts:suspend（true = 缺，停用按钮禁用，不伪造写权限）。 */
    suspendScopeWarning: false,
    /** 停用理由（契约 ReasonInput.reason，1..500）；进服务端审计。 */
    suspendReason: '',
    /** 正在确认停用的账号 id；null = 未在确认态。 */
    suspendTargetId: null,
    /** 停用写面状态：idle | confirming | saving | saved | failed。 */
    suspendStatus: 'idle',
    /** 停用写失败对象（可重试时保留写意向，同一幂等键 + 同一 If-Match 重发）。 */
    suspendFailure: null,
    /** 可重试的写意向：{ id, revision, reason, idempotencyKey }。 */
    suspendWrite: null,
  };
}

function sameSelection(state, collection) {
  if (state.selectedId === null) return null;
  return collection.items.some((row) => row.id === state.selectedId) ? state.selectedId : null;
}

/** 纯 reducer：不合法的事件（例如未登录态下的成功回调）原样返回旧状态。 */
export function reduce(state, action) {
  switch (action?.type) {
    case 'SESSION_MISSING':
      return { ...initialState(), failure: action.failure ?? null };

    case 'SIGN_IN_START':
      return { ...initialState(), phase: 'signing_in' };

    case 'SIGN_IN_FAILED':
      return { ...initialState(), failure: action.failure ?? null };

    case 'SIGNED_IN':
      return {
        ...state,
        signedIn: true,
        phase: 'loading',
        failure: null,
        scopeWarning: action.scopesProvided === true && !arrayContainsScope(action.scopes, ACCOUNTS_SCOPE),
        suspendScopeWarning: action.scopesProvided === true && !arrayContainsScope(action.scopes, ACCOUNTS_SUSPEND_SCOPE),
      };

    case 'SIGN_OUT':
      return initialState();

    case 'LOAD_START':
      if (!state.signedIn) return state;
      if (action.reset === true) {
        return {
          ...state,
          phase: state.collection.items.length > 0 ? 'ready' : 'loading',
          requestCursor: null,
          failure: null,
          stale: state.collection.items.length > 0,
          selectedId: null,
        };
      }
      return { ...state, loadingMore: true, failure: null, requestCursor: state.collection.nextCursor };

    case 'LOAD_OK': {
      // 未登录却收到成功回调：丢弃（不显示任何行）。
      if (!state.signedIn) return state;
      const collection = action.collection;
      const nextCursor = collection.nextCursor ?? null;
      return {
        ...state,
        phase: 'ready',
        collection,
        loadingMore: false,
        failure: null,
        stale: false,
        requestCursor: nextCursor,
        selectedId: sameSelection(state, collection),
      };
    }

    case 'LOAD_FAIL': {
      if (!state.signedIn) return state;
      const failure = action.failure;
      if (failure && failure.kind === 'signed_out') {
        return { ...initialState(), failure };
      }
      const hasRows = state.collection.items.length > 0;
      return {
        ...state,
        phase: hasRows ? 'ready' : 'error',
        loadingMore: false,
        failure,
        // 有旧行时保留并显式标注「未刷新」，不把旧数据当成本次结果。
        stale: hasRows ? true : false,
      };
    }

    case 'SET_FILTER':
      return { ...state, filter: typeof action.value === 'string' ? action.value : '' };

    case 'SELECT': {
      const id = action.id;
      if (typeof id !== 'string') return state;
      if (!state.collection.items.some((row) => row.id === id)) return state;
      return { ...state, selectedId: id };
    }

    case 'CLOSE_SUMMARY':
      return { ...state, selectedId: null };

    case 'SET_SUSPEND_REASON':
      return { ...state, suspendReason: typeof action.value === 'string' ? action.value : '' };

    case 'SUSPEND_BEGIN': {
      // 只有登录后、且目标行确实处于 active 才进入确认态（不猜、不伪造写权限）。
      if (!state.signedIn) return state;
      const id = action.id;
      if (typeof id !== 'string') return state;
      const row = state.collection.items.find((item) => item.id === id);
      if (row === undefined || row.state !== 'active') return state;
      return { ...state, suspendTargetId: id, suspendStatus: 'confirming', suspendFailure: null };
    }

    case 'SUSPEND_CANCEL':
      return { ...state, suspendTargetId: null, suspendStatus: 'idle', suspendFailure: null, suspendWrite: null };

    case 'SUSPEND_START': {
      if (!state.signedIn) return state;
      if (typeof action.id !== 'string') return state;
      // 本地校验不过 ⇒ 不发请求、不改状态（理由必须满足 ReasonInput，If-Match 必须可推出）。
      if (reasonProblem(action.reason) !== null) return state;
      if (etagForRevision(action.revision) === null) return state;
      return {
        ...state,
        suspendStatus: 'saving',
        suspendFailure: null,
        suspendWrite: {
          id: action.id,
          revision: action.revision,
          reason: action.reason,
          idempotencyKey: action.idempotencyKey,
        },
      };
    }

    case 'SUSPEND_OK': {
      if (!state.signedIn) return state;
      const account = action.account;
      const items =
        account && typeof account.id === 'string'
          ? state.collection.items.map((row) => (row.id === account.id ? account : row))
          : state.collection.items;
      return {
        ...state,
        collection: { ...state.collection, items },
        suspendStatus: 'saved',
        suspendWrite: null,
        suspendFailure: null,
        suspendTargetId: null,
      };
    }

    case 'SUSPEND_FAIL': {
      if (!state.signedIn) return state;
      const failure = action.failure ?? { ok: false, kind: 'http_error', retriable: false, message: '未知错误' };
      if (failure.kind === 'signed_out') return { ...initialState(), failure };
      return {
        ...state,
        suspendStatus: 'failed',
        suspendFailure: failure,
        // 可重试 ⇒ 保留写意向（同一幂等键 + 同一 If-Match 重发）；否则丢弃，逼用户重新读取。
        suspendWrite: failure.retriable === true ? state.suspendWrite : null,
        stale: true,
      };
    }

    case 'SUSPEND_CLEAR':
      return { ...state, suspendStatus: 'idle', suspendWrite: null, suspendFailure: null, suspendTargetId: null };

    default:
      return state;
  }
}

function arrayContainsScope(scopes, scope) {
  return Array.isArray(scopes) && scopes.includes(scope);
}

/** 已加载的行（未筛选）。 */
export function rowsOf(state) {
  return state.collection.items;
}

/**
 * 关键字筛选：**只在已加载行内**按 `display_name` 与 `id` 匹配。
 * 后端 `listAdminUsers` 只有 `cursor`／`limit` 两个参数，没有关键字参数——
 * 因此这是客户端筛选，文案必须写明作用域，不能让人误以为筛了全库。
 */
export function visibleRows(state) {
  const keyword = state.filter.trim().toLowerCase();
  if (keyword === '') return state.collection.items;
  return state.collection.items.filter(
    (row) => row.display_name.toLowerCase().includes(keyword) || row.id.toLowerCase().includes(keyword),
  );
}

export function canLoadMore(state) {
  return state.phase === 'ready' && state.collection.nextCursor !== null && !state.loadingMore && !state.collection.cycle;
}

/** 页面级描述：空态／加载／错误／就绪，文案互斥且如实。 */
export function describe(state) {
  if (state.phase === 'signing_in') {
    return { tone: 'loading', title: '正在登录', detail: '提交登录名与密码', canLoadMore: false, canRetry: false, action: 'none' };
  }
  if (state.phase === 'signed_out') {
    const failure = describeFailure(state.failure);
    return {
      tone: 'signed_out',
      title: '未登录',
      detail: failure ? `${failure.title}：${failure.detail}` : '登录后台后才能读取账号目录',
      canLoadMore: false,
      canRetry: false,
      action: 'sign_in',
    };
  }
  if (state.phase === 'loading') {
    return {
      tone: 'loading',
      title: '正在读取账号目录',
      detail: 'GET /admin/accounts',
      canLoadMore: false,
      canRetry: false,
      action: 'none',
    };
  }
  if (state.phase === 'error') {
    const failure = describeFailure(state.failure);
    return {
      tone: 'error',
      title: failure?.title ?? '读取失败',
      detail: failure?.detail ?? '未知错误',
      canLoadMore: false,
      canRetry: failure?.retriable === true,
      action: failure?.action ?? 'none',
    };
  }

  const failure = describeFailure(state.failure);
  const total = state.collection.items.length;
  const visible = visibleRows(state).length;
  const filtered = state.filter.trim() !== '';
  const base = {
    canLoadMore: canLoadMore(state),
    canRetry: failure?.retriable === true,
    action: failure?.action ?? 'none',
    total,
    visible,
    filtered,
  };

  if (total === 0) {
    return {
      ...base,
      tone: 'empty',
      title: '账号目录为空',
      detail: '接口返回 0 行（items 为空且 next_cursor 为 null），这是空列表，不是错误',
    };
  }
  if (visible === 0) {
    return {
      ...base,
      tone: 'empty_filtered',
      title: '没有匹配的账号',
      detail: `关键字「${state.filter.trim()}」只在已加载的 ${total} 行内匹配（后端无关键字参数）`,
    };
  }
  return {
    ...base,
    tone: state.stale ? 'stale' : 'ready',
    title: state.stale ? '显示的是上次成功读取的数据' : '已读取账号目录',
    detail: state.stale
      ? `共 ${visible} 行（已加载 ${total} 行）；最近一次刷新失败，需重试后才算最新`
      : `共 ${visible} 行（已加载 ${total} 行，已翻 ${state.collection.pages} 页）`,
  };
}

/** 行视图：只做展示，不改变字段含义。 */
export function formatRow(view) {
  return {
    id: view.id,
    shortId: view.id.slice(0, 8),
    displayName: view.display_name,
    state: view.state,
    stateLabel: STATE_LABELS[view.state] ?? `未知状态(${view.state})`,
    stateTone: STATE_TONES[view.state] ?? 'warn',
    revision: view.revision,
    revisionLabel: `r${view.revision}`,
  };
}

export function visibleRowViews(state) {
  return visibleRows(state).map(formatRow);
}

/** 停用理由是否可用；返回错误文案或 null。 */
export function suspendReasonProblem(state) {
  return reasonProblem(state.suspendReason);
}

/**
 * 本会话能否发起停用。
 *
 * - 未登录 / 未就绪 ⇒ 否；
 * - 会话 scope 明确不含 `accounts:suspend` ⇒ 否（服务端会 403，不必先发一次必失败的请求）；
 * - 理由不合法 ⇒ 否（契约 `ReasonInput.reason` 必填）；
 * - 正在写入 ⇒ 否。
 */
export function canSuspend(state) {
  if (!state.signedIn) return false;
  if (state.phase !== 'ready') return false;
  if (state.suspendScopeWarning) return false;
  if (state.suspendStatus === 'saving') return false;
  return reasonProblem(state.suspendReason) === null;
}

/**
 * 停用入口（每行「停用」按钮）是否可达：只要能打开确认对话框即可，**不要求理由非空**。
 *
 * 理由只在确认对话框里输入；入口若拿理由判禁用会死锁（理由空 → 入口禁用 → 打不开框 → 输不了理由）。
 * 因此这里只判登录／就绪／写面 scope／未在写入；行级 `state === 'active'` 由模板的 v-if 承担。
 */
export function canOpenSuspendDialog(state) {
  if (!state.signedIn) return false;
  if (state.phase !== 'ready') return false;
  if (state.suspendScopeWarning) return false;
  if (state.suspendStatus === 'saving') return false;
  return true;
}

/** 正在确认停用的目标行视图；非确认态或目标不存在返回 null。 */
export function suspendTargetView(state) {
  if (state.suspendTargetId === null) return null;
  const row = state.collection.items.find((item) => item.id === state.suspendTargetId);
  if (row === undefined) return null;
  return {
    id: row.id,
    displayName: row.display_name,
    revision: row.revision,
    etag: etagForRevision(row.revision) ?? '—',
  };
}

/** 停用写失败 → 面板文案；`status`／`code` 原样带上，不用泛化文案顶替。 */
export function describeSuspendFailure(failure) {
  if (!failure || failure.ok !== false) return null;
  const codeTag = [failure.status === null || failure.status === undefined ? null : `HTTP ${failure.status}`, failure.code]
    .filter((part) => part !== null && part !== '')
    .join(' · ');
  const suffix = codeTag === '' ? '' : `（${codeTag}）`;
  const out = (title, detail, action, retriable) => ({
    title: `${title}${suffix}`,
    detail,
    action,
    retriable: retriable === true,
    code: failure.code ?? null,
    status: failure.status ?? null,
  });
  // R67-B04：服务端声明优先——显式 `retryable:false` 时既不给「用同一幂等键重试」，
  // 也不承诺「稍后重试」（重试必然还是同一个失败），改为指引人工处理。
  const retry = serverAllowsRetry(failure);
  switch (failure.kind) {
    case 'signed_out':
      return out('未登录或会话已过期', '请重新登录后台后再试', 'sign_in', false);
    case 'forbidden':
      return out('权限不足（缺少 accounts:suspend）', '后台会话有效，但停用要求 scope accounts:suspend', 'none', false);
    case 'revision_required':
      return out('缺少 If-Match', '服务端要求强 ETag（形如 "3"）；请「重新读取」拿到最新 revision 后再停用', 'reload', false);
    case 'revision_conflict':
      return out('账号已被改动（修订冲突）', '本次 If-Match 与服务端当前 ETag 不一致；请「重新读取」后再决定是否停用', 'reload', false);
    case 'idempotency_conflict':
      return out('同一幂等键的请求内容不一致', '本页复用了幂等键但换了请求体；请「重新读取」后重新发起', 'reload', false);
    case 'idempotency_key_required':
      return out('缺少 Idempotency-Key', '写操作必须带幂等键；请「重新读取」后重试', 'reload', false);
    case 'in_progress':
      if (!retry) {
        return out(
          '同一操作正在处理中',
          '服务端判定该幂等键的在途请求未完成，且声明不可自动重试（retryable=false）；请先「重新读取」确认账号当前状态，再人工确认在途请求的结果',
          'reload',
          false,
        );
      }
      return out('同一操作正在处理中', '服务端判定该幂等键的在途请求未完成；稍后用同一幂等键重试会命中同一结果', 'retry', true);
    case 'not_found':
      return out('账号不存在', '服务端返回 404；请「重新读取」确认当前账号集合', 'reload', false);
    case 'invalid_request':
      return out('请求被拒绝', failure.message || '服务端判定请求体/参数不合法', 'none', false);
    case 'rate_limited':
      if (!retry) {
        return out(
          '请求过于频繁',
          '后端限流，且服务端声明不可自动重试（retryable=false）；请人工确认后端状态后再手动重读本页',
          'reload',
          false,
        );
      }
      return out(
        '请求过于频繁',
        failure.retryAfterSeconds === null || failure.retryAfterSeconds === undefined
          ? '稍后重试'
          : `约 ${failure.retryAfterSeconds} 秒后重试`,
        'retry',
        true,
      );
    case 'unavailable':
      if (!retry) {
        return out(
          '服务暂不可用',
          '账号停用端口未接线或暂时不可用（不返回伪造的成功值）；服务端声明不可自动重试（retryable=false），本页不重发停用请求，请先「重新读取」确认账号当前状态后人工处理',
          'reload',
          false,
        );
      }
      return out('服务暂不可用', '账号停用端口未接线或暂时不可用（不返回伪造的成功值）；稍后重试', 'retry', true);
    case 'network_error':
      if (!retry) {
        return out('网络请求失败', '服务端声明不可自动重试（retryable=false）；请人工确认后端状态后再手动重读本页', 'reload', false);
      }
      return out('网络请求失败', failure.message || '检查 API 基地址与网络后重试', 'retry', true);
    case 'invalid_response':
      return out('响应不符合契约', failure.message || '未渲染任何猜测值', 'none', false);
    default:
      return out('请求失败', failure.message || '未知错误', 'none', false);
  }
}

/**
 * 详情摘要：**只有**列表行返回的 4 个字段。
 *
 * 契约没有 `GET /admin/accounts/{id}`（`AdminAccountViewEnvelope` 只被 `suspendUser` 的 POST 用于返回），
 * 所以创建时间、最近登录、角色权限等一律标注「读面未提供」，不用占位假值填充。
 */
export function summaryOf(state, id) {
  const row = state.collection.items.find((item) => item.id === id);
  if (row === undefined) return null;
  return {
    id: row.id,
    title: row.display_name,
    fields: [
      { label: '账号 ID', value: row.id, source: 'list' },
      { label: '显示名', value: row.display_name, source: 'list' },
      { label: '状态', value: STATE_LABELS[row.state] ?? `未知状态(${row.state})`, source: 'list' },
      { label: 'revision', value: String(row.revision), source: 'list' },
    ],
    missing: ['创建时间', '最近登录时间', '角色与权限明细', '绑定手机/微信'],
    note: '字段仅取自 GET /admin/accounts 的列表行；契约未提供单账号只读详情接口，以上缺项不是"加载失败"，是读面本来没有。',
  };
}
