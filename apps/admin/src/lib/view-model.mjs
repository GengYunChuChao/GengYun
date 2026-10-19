/**
 * 后台账号只读页的展示状态机——纯 ESM，无 Vue／DOM 依赖。
 *
 * 目的：把「加载中／空／错误／已就绪／未登录」这些**会骗人的**状态收进一个纯函数里，
 * 由测试钉住三条不下假的规则：
 *  1. 没有会话就不可能出现行（`LOAD_OK` 在未登录态被丢弃）；
 *  2. 刷新失败时保留旧行但必须标 `stale`，不许把旧数据当新数据；
 *  3. 「接口返回 0 行」与「筛选后 0 行」是两种空态，文案不得混用。
 */
import { describeFailure } from './admin-api.mjs';
import { ACCOUNTS_SCOPE } from './admin-contract.mjs';

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
