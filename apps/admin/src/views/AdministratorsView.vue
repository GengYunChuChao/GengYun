<script setup>
/**
 * R60 · 管理员权限读面 + R67-A05 · 管理员账号停用／恢复入口。
 *
 * 读（scope `scopes:read`）：
 * - `GET /admin/administrators`（operationId `listAdministrators`）—— 管理员目录，每项
 *   `{id, login_name, revision, state, scopes}`，`id` 是 `admin_accounts.id`（⛔ 不是 users.id）；
 * - `GET /admin/administrators/{id}/scopes`（operationId `listAdministratorScopes`）—— 某人当前有效权限。
 *
 * 写（scope `scopes:write`）：
 * - `POST /admin/administrators/{id}/disable`（`disableAdministratorAccount`）
 * - `POST /admin/administrators/{id}/enable`（`enableAdministratorAccount`）
 * - `POST /admin/administrators/{id}/scopes`（`grantAdministratorScope`）—— R68 授权
 * - `DELETE /admin/administrators/{id}/scopes/{scope}`（`revokeAdministratorScope`）—— R68 撤销
 * 三面的 `If-Match` 取自已加载那一行的 `revision`（目录**不发** `ETag`），并带 `Idempotency-Key` 与理由。
 * ⛔ 「停用／恢复」不是终端用户停用（`PATCH /admin/accounts/{id}/suspend`，另一套 id 空间与 scope）。
 * ⛔ 「撤销 scope」也不是「停用」：停用改账号状态并撤会话，撤销只回收一条权限；恢复账号也不会把 scope 还回来。
 * scope 的合法值只来自 `admin-scope-catalog.mjs`（从契约 `AdminScope.enum` 派生），⛔ 视图里不手抄清单。
 * 表现约定：403 显示明确提示 + 错误码（不静默空白）；空目录显示空态；某人不存在显示 404 NOT_FOUND；
 * 写失败用 `WriteReceipt`（它按 `failed` 动态给 `role`/`aria-live`），视图不再另造 alert 横幅。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { API_BASE_URL, loadAdminSession, signInAdmin, signOutAdmin } from '../auth/session';
import {
  ADMINISTRATORS_OPERATION_ID,
  ADMINISTRATORS_PATH,
  ADMINISTRATORS_SCOPE,
  ADMINISTRATOR_SCOPES_OPERATION_ID,
  administratorLimitOptions,
  administratorRows,
  administratorScopesView,
  describeAdministratorScopesView,
  describeAdministratorsView,
  fetchAdministratorScopes,
  fetchAdministratorsPage,
  initialAdministratorsState,
  reduceAdministrators,
} from '../lib/admin-administrators.mjs';
import { reasonProblem } from '../lib/account-suspend-api.mjs';
import {
  ADMINISTRATOR_STATE_LABELS,
  ADMINISTRATOR_STATE_SCOPE,
  canChangeAdministratorState,
  describeAdministratorStateFailure,
  newIdempotencyKey,
  setAdministratorState,
} from '../lib/administrator-state-api.mjs';
import { changedVerdict } from '../lib/admin-content-view-model.mjs';
import { ADMIN_SCOPE_OPTIONS, scopeProblem } from '../lib/admin-scope-catalog.mjs';
import {
  ADMIN_SCOPE_COUNT,
  ADMINISTRATOR_SCOPE_MODE_LABELS,
  ADMINISTRATOR_SCOPE_WRITE_SCOPE,
  canWriteAdministratorScope,
  describeAdministratorScopeFailure,
  grantAdministratorScope,
  revokeAdministratorScope,
} from '../lib/administrator-scope-api.mjs';
import { FOCUSABLE_SELECTOR, nextFocusIndex } from '../lib/dialog-focus.mjs';
import WriteReceipt from './WriteReceipt.vue';

const state = ref(initialAdministratorsState());
const session = ref(null);
const loginName = ref('');
const password = ref('');
const signInError = ref(null);
const busy = ref(false);
const scopesBusy = ref(false);
let requestSeq = 0;
let scopesSeq = 0;
let currentToken = null;

const view = computed(() => describeAdministratorsView(state.value));
const rows = computed(() => administratorRows(state.value));
const scopesView = computed(() => describeAdministratorScopesView(state.value));
const scopesList = computed(() => administratorScopesView(state.value.scopes));
const limitChoices = computed(() => administratorLimitOptions(state.value.limit));
const signedIn = computed(() => state.value.signedIn);
const selectedId = computed(() => state.value.selectedId);

function dispatch(action) {
  state.value = reduceAdministrators(state.value, action);
}

async function requestPage(cursor, { reset }) {
  if (currentToken === null) {
    dispatch({
      type: 'LOAD_FAIL',
      failure: {
        ok: false,
        kind: 'signed_out',
        status: null,
        code: null,
        inContract: false,
        retryAfterSeconds: null,
        message: '没有后台会话令牌',
      },
    });
    return;
  }
  const seq = ++requestSeq;
  busy.value = true;
  dispatch({ type: 'LOAD_START', reset });
  const result = await fetchAdministratorsPage({
    baseUrl: API_BASE_URL,
    token: currentToken,
    cursor,
    limit: state.value.limit,
  });
  if (seq !== requestSeq) return;
  busy.value = false;
  if (result.ok) dispatch({ type: 'LOAD_OK', cursor, page: result.page });
  else dispatch({ type: 'LOAD_FAIL', failure: result });
}

function startSession(adminSession) {
  resetScopeWrite(); // 换会话（登录 / 会话替换）⇒ 上一会话的授权框内容与在途写响应一律作废
  session.value = adminSession;
  currentToken = typeof adminSession?.accessToken === 'string' ? adminSession.accessToken : null;
  dispatch({ type: 'SIGNED_IN', scopes: adminSession?.scopes });
  requestPage(null, { reset: true });
}

async function submitSignIn() {
  if (busy.value) return;
  signInError.value = null;
  dispatch({ type: 'SIGN_IN_START' });
  busy.value = true;
  const credentials = { loginName: loginName.value, password: password.value };
  password.value = '';
  try {
    await signInAdmin(credentials);
  } catch (error) {
    busy.value = false;
    const message = error instanceof Error && error.message !== '' ? error.message : '后台登录失败';
    signInError.value = message;
    dispatch({ type: 'SIGN_IN_FAILED', message });
    return;
  }
  const adminSession = await loadAdminSession();
  busy.value = false;
  if (adminSession === null) {
    signInError.value = '登录后未能读到会话详情';
    dispatch({ type: 'SIGN_IN_FAILED', message: '登录成功但读不到会话详情（GET /admin/auth/session）' });
    return;
  }
  startSession(adminSession);
}

async function signOut() {
  ++requestSeq;
  ++scopesSeq;
  resetScopeWrite(); // 退出即作废：目标管理员 / 理由 / 回执 / 逐行选择，以及 A 的在途写响应
  currentToken = null;
  session.value = null;
  busy.value = false;
  scopesBusy.value = false;
  loginName.value = '';
  password.value = '';
  signInError.value = null;
  dispatch({ type: 'SIGN_OUT' });
  await signOutAdmin();
}

/**
 * 读一次 `/admin/administrators/{id}/scopes` 并把结果灌进面板（**不**切换面板开合）。
 * 从 `openScopes` 里拆出来是因为授权／撤销成功后要「重读该行权威值」，那时面板可能已经开着。
 */
async function loadScopes(row) {
  if (currentToken === null) {
    dispatch({ type: 'SCOPES_FAIL', failure: { ok: false, kind: 'signed_out', status: null, code: null, inContract: false, retryAfterSeconds: null, message: '没有后台会话令牌' } });
    return;
  }
  const seq = ++scopesSeq;
  scopesBusy.value = true;
  dispatch({ type: 'SCOPES_LOAD_START', id: row.id, loginName: row.loginName });
  const result = await fetchAdministratorScopes({ baseUrl: API_BASE_URL, token: currentToken, id: row.id });
  if (seq !== scopesSeq) return;
  scopesBusy.value = false;
  if (result.ok) dispatch({ type: 'SCOPES_OK', scopes: result.scopes });
  else dispatch({ type: 'SCOPES_FAIL', failure: result });
}

/** 点某一行「查看权限」：开／合面板；打开时读一次 scopes。 */
async function openScopes(row) {
  if (currentToken === null) {
    dispatch({ type: 'SCOPES_FAIL', failure: { ok: false, kind: 'signed_out', status: null, code: null, inContract: false, retryAfterSeconds: null, message: '没有后台会话令牌' } });
    return;
  }
  if (state.value.selectedId === row.id && state.value.scopesPhase === 'ready') {
    dispatch({ type: 'CLOSE_SCOPES' });
    return;
  }
  await loadScopes(row);
}

function retryScopes() {
  const row = rows.value.find((item) => item.id === state.value.selectedId);
  if (row === undefined) return;
  openScopes(row);
}

function closeScopes() {
  ++scopesSeq;
  scopesBusy.value = false;
  dispatch({ type: 'CLOSE_SCOPES' });
}

function changeLimit(value) {
  dispatch({ type: 'SET_LIMIT', limit: Number.parseInt(String(value), 10) });
  requestPage(null, { reset: true });
}

function loadMore() {
  const cursor = state.value.collection.nextCursor;
  if (typeof cursor !== 'string' || cursor === '') return;
  requestPage(cursor, { reset: false });
}

function refresh() {
  return requestPage(null, { reset: true });
}

// ---------------------------------------------------------------- 停用 / 恢复（R67-A05）
//
// 两条写面：`POST /admin/administrators/{id}/disable|enable`（scope `scopes:write`）。
// ⛔ 不是终端用户停用（那是 `PATCH /admin/accounts/{id}/suspend`，另一套 id 空间与 scope）。
// `If-Match` 只能取自已加载那一行的 `revision`：目录**不发** `ETag`，所以 revision 必须由
// `AdminAdministratorView` 带回来（本片契约新增字段），页面不猜。

/** 当前打开的确认框目标；null 表示没开框。 */
const changeTarget = ref(null);
const changeReason = ref('');
const changeSaving = ref(false);
/** 失败说明（中文）；⛔ 不自己做 alert 横幅，失败回执由 `WriteReceipt` 呈现。 */
const changeFailure = ref(null);
/** 回执 `{ write, verdict }`：`write` 是 WriteReceipt 的入参，`verdict` 是 changed 三值。 */
const changeReceipt = ref(null);
/** 成功后的结果摘要（用来显示"这次到底改成了什么"）。 */
const changeOutcome = ref(null);
const changeDialog = ref(null);
const changeTitle = ref(null);
let changeTrigger = null;
let changeKey = null;
let changeSeq = 0;

const changeProblem = computed(() => reasonProblem(changeReason.value));

/** 这一行在这一模式下能不能发请求：判据在 lib（`canChangeAdministratorState`），模板里不散写。 */
function canChange(row, mode) {
  return canChangeAdministratorState(row, mode);
}

function changeLabel(mode) {
  return ADMINISTRATOR_STATE_LABELS[mode] ?? mode;
}

/** 打开确认框：记住触发按钮（关闭后焦点还给它）；幂等键此时生成，重试复用同一个。 */
function openStateChange(row, mode, event) {
  if (!canChange(row, mode)) return;
  changeTrigger = event?.currentTarget ?? null;
  changeTarget.value = { id: row.id, loginName: row.loginName, mode, revision: row.revision };
  changeReason.value = '';
  changeFailure.value = null;
  changeOutcome.value = null;
  changeKey = newIdempotencyKey();
}

/** 焦点送进框内标题：读屏打开对话框后先播报名字，再 Tab 到理由输入框。 */
function focusChangeTitle() {
  const title = changeTitle.value;
  if (title !== null && title !== undefined && typeof title.focus === 'function') title.focus();
}

function closeStateChange() {
  changeTarget.value = null;
}

/** 打开 → 焦点进框；关闭 → 焦点回触发按钮（按钮被重渲染掉时不硬拉焦点）。 */
watch(changeTarget, async (target) => {
  if (target === null) {
    const trigger = changeTrigger;
    changeTrigger = null;
    await nextTick();
    if (trigger !== null && trigger.isConnected !== false && typeof trigger.focus === 'function') trigger.focus();
    return;
  }
  await nextTick();
  focusChangeTitle();
});

/**
 * 对话框键盘行为：Esc 关闭（提交中不关）、Tab／Shift+Tab 框内循环。
 * 下标算法与可聚焦选择器都来自 `lib/dialog-focus.mjs`（纯函数、有单测），这里只做 DOM 枚举与 focus。
 */
function onStateKeydown(event) {
  if (event.key === 'Escape') {
    if (changeSaving.value) return; // 与「取消」按钮 disabled 一致：提交中不允许关
    event.preventDefault();
    closeStateChange();
    return;
  }
  if (event.key !== 'Tab') return;
  const dialog = changeDialog.value;
  if (dialog === null || dialog === undefined || typeof dialog.querySelectorAll !== 'function') return;
  const items = Array.from(dialog.querySelectorAll(FOCUSABLE_SELECTOR));
  const active = globalThis.document === undefined ? null : globalThis.document.activeElement;
  const index = nextFocusIndex({
    count: items.length,
    index: items.indexOf(active ?? null),
    shift: event.shiftKey === true,
  });
  event.preventDefault(); // 目标一律由这里搬运，Tab 不跑出框
  if (index === -1) {
    focusChangeTitle();
    return;
  }
  const next = items[index];
  if (next !== undefined && typeof next.focus === 'function') next.focus();
}

/** 发一次停用／恢复：幂等键复用 `changeKey`；成功后刷新目录（revision 已前进，旧行不能再用）。 */
async function submitStateChange() {
  const target = changeTarget.value;
  if (target === null || changeSaving.value) return;
  if (changeProblem.value !== null) return;
  const reason = changeReason.value.trim();
  const key = changeKey ?? newIdempotencyKey();
  changeKey = key;
  const label = `${changeLabel(target.mode)}管理员账号 ${target.loginName}`;
  const seq = ++changeSeq;
  changeSaving.value = true;
  changeReceipt.value = { write: { phase: 'pending', label }, verdict: 'unknown' };

  const result = await setAdministratorState({
    baseUrl: API_BASE_URL,
    token: currentToken ?? '',
    id: target.id,
    revision: target.revision,
    mode: target.mode,
    reason,
    idempotencyKey: key,
  });
  if (seq !== changeSeq) return; // 过期响应：丢弃，不改状态
  changeSaving.value = false;

  const write = {
    label,
    ok: result.ok === true,
    status: result.status,
    requestUrl: result.requestUrl,
    requestId: result.requestId ?? null,
    code: result.ok === true ? null : result.code,
    inContract: result.inContract === true,
    message: result.ok === true ? '' : result.message,
    etag: result.ok === true ? result.etag : undefined,
    sentHeaders: result.sentHeaders ?? { 'if-match': `"${target.revision}"`, 'idempotency-key': key },
    changed: result.ok === true ? result.changed : null,
  };
  changeReceipt.value = { write, verdict: result.ok === true ? changedVerdict(result.changed) : 'unknown' };

  if (result.ok === true) {
    changeFailure.value = null;
    changeOutcome.value = {
      mode: target.mode,
      loginName: target.loginName,
      revisionFrom: target.revision,
      revision: result.revision,
      state: result.state,
      changed: result.changed,
      revokedSessions: result.revokedSessions,
    };
    closeStateChange();
    refresh();
    return;
  }
  changeOutcome.value = null;
  changeFailure.value = describeAdministratorStateFailure(result);
}

function dismissStateReceipt() {
  changeReceipt.value = null;
  changeFailure.value = null;
}

// ---------------------------------------------------------------- 授权 / 撤销（R68）
//
// 两条写面：`POST /admin/administrators/{id}/scopes`（grant）与 `DELETE …/scopes/{scope}`（revoke），
// 门同为 `scopes:write`。scope 的合法值只来自 `admin-scope-catalog.mjs`（契约 `AdminScope.enum` 派生）：
// 选择器 option、本地闭集校验、行判定都走 lib，⛔ 视图里不写第二份清单。
// 顺序是「先确认、再发请求」：点按钮只开确认框，真正发请求在 `submitScopeWrite`。

/** 选择器选项（契约闭集，顺序同 enum）。 */
const scopeOptions = computed(() => ADMIN_SCOPE_OPTIONS);
/** 每行当前选中的 scope：`{ [rowId]: scope }`。⛔ 不用 `v-model`：渲染层只认显式 `:value` + `@change`。 */
const scopePicks = ref({});
const scopeTarget = ref(null);
const scopeReason = ref('');
const scopeSaving = ref(false);
/** 写失败说明（`describeAdministratorScopeFailure` 的产物，带具体错误码）。 */
const scopeFailure = ref(null);
/** 成功摘要：这次到底授／撤了谁的哪条权限。 */
const scopeOutcome = ref(null);
/** 选择器本身不合法时的就地提示：不发请求、不开确认框。 */
const scopePickProblem = ref(null);
const scopeDialog = ref(null);
const scopeTitle = ref(null);
let scopeTrigger = null;
let scopeKey = null;
let scopeSeq = 0;

const scopeReasonIssue = computed(() => reasonProblem(scopeReason.value));

function scopePick(row) {
  const picked = scopePicks.value[row.id];
  return typeof picked === 'string' ? picked : '';
}

function pickScope(row, value) {
  scopePicks.value = { ...scopePicks.value, [row.id]: typeof value === 'string' ? value : '' };
  scopePickProblem.value = null;
}

/** 选中的 scope 在契约闭集内 **且** 这一行可写 ⇒ 按钮才可用（判据都在 lib，模板里不散写）。 */
function canPickScope(row, mode) {
  return canWriteAdministratorScope(row, mode) && scopeProblem(scopePick(row)) === null;
}

function scopeModeLabel(mode) {
  return ADMINISTRATOR_SCOPE_MODE_LABELS[mode] ?? mode;
}

/**
 * 打开确认框。**第一步校验**在这里：scope 不合法就只上屏提示——不发请求、不开框
 * （闭集外的值发出去只会换来 400 INVALID_REQUEST，还要白占一个幂等键）。
 */
function openScopeWrite(row, mode, event) {
  const picked = scopePick(row);
  const issue = scopeProblem(picked);
  if (issue !== null) {
    scopePickProblem.value = issue;
    scopeFailure.value = null;
    scopeOutcome.value = null;
    return;
  }
  if (!canWriteAdministratorScope(row, mode)) return;
  scopePickProblem.value = null;
  scopeTrigger = event?.currentTarget ?? null;
  scopeTarget.value = { id: row.id, loginName: row.loginName, mode, revision: row.revision, scope: picked };
  scopeReason.value = '';
  scopeFailure.value = null;
  scopeOutcome.value = null;
  scopeKey = newIdempotencyKey();
}

function focusScopeTitle() {
  const title = scopeTitle.value;
  if (title !== null && title !== undefined && typeof title.focus === 'function') title.focus();
}

function closeScopeWrite() {
  scopeTarget.value = null;
}

/**
 * 会话边界清理：登录／退出／卸载时把授／撤权这一片**全部**作废。
 *
 * 两件事必须一起做，少一件就是跨会话串数据：
 * ① `++scopeSeq` —— 让在途写响应认不出自己（`submitScopeWrite` 里 `seq !== scopeSeq` 就丢弃），
 *    否则 A 的写请求会在 B 的会话里落地、甚至替 B 触发一次刷新读；
 * ② 清 `scopeTarget/scopeReason/scopeOutcome/scopeFailure/scopePickProblem/scopePicks` 并把
 *    `scopeSaving` 复位 —— 否则 A 打开过的确认框（目标管理员 + 理由）与成功回执会留在 B 的页面上，
 *    而 B 可能根本没有 `scopes:read`。
 *
 * ⚠️ 先清 `scopeTrigger` 再清 `scopeTarget`：`watch(scopeTarget)` 在关闭时会把焦点还给触发按钮，
 * 会话边界不该把焦点拉回一个已经换掉的页面。
 */
function resetScopeWrite() {
  ++scopeSeq;
  scopeTrigger = null;
  scopeKey = null;
  scopeTarget.value = null;
  scopeReason.value = '';
  scopeSaving.value = false;
  scopeFailure.value = null;
  scopeOutcome.value = null;
  scopePickProblem.value = null;
  scopePicks.value = {};
}

/** 打开 → 焦点进框；关闭 → 焦点回触发按钮（按钮被重渲染掉时不硬拉焦点）。 */
watch(scopeTarget, async (target) => {
  if (target === null) {
    const trigger = scopeTrigger;
    scopeTrigger = null;
    await nextTick();
    if (trigger !== null && trigger.isConnected !== false && typeof trigger.focus === 'function') trigger.focus();
    return;
  }
  await nextTick();
  focusScopeTitle();
});

/** 对话框键盘行为：Esc 关闭（提交中不关）、Tab／Shift+Tab 框内循环（与停用／恢复完全一致）。 */
function onScopeKeydown(event) {
  if (event.key === 'Escape') {
    if (scopeSaving.value) return;
    event.preventDefault();
    closeScopeWrite();
    return;
  }
  if (event.key !== 'Tab') return;
  const dialog = scopeDialog.value;
  if (dialog === null || dialog === undefined || typeof dialog.querySelectorAll !== 'function') return;
  const items = Array.from(dialog.querySelectorAll(FOCUSABLE_SELECTOR));
  const active = globalThis.document === undefined ? null : globalThis.document.activeElement;
  const index = nextFocusIndex({
    count: items.length,
    index: items.indexOf(active ?? null),
    shift: event.shiftKey === true,
  });
  event.preventDefault();
  if (index === -1) {
    focusScopeTitle();
    return;
  }
  const next = items[index];
  if (next !== undefined && typeof next.focus === 'function') next.focus();
}

/**
 * 发一次授权／撤销。
 *
 * 两个函数**按名字**调（不塞进一个 `const write = …` 再调）：能力图按「视图里有没有
 * `grantAdministratorScope(` / `revokeAdministratorScope(` 这行调用 + 该函数自己的 fetch 调用点」
 * 判 UI 入口，绕一层变量就会判成「无入口」。
 */
async function submitScopeWrite() {
  const target = scopeTarget.value;
  if (target === null || scopeSaving.value) return;
  const issue = scopeProblem(target.scope); // 第二道闸：确认框开着时 scope 也不许跑出闭集
  if (issue !== null) {
    scopePickProblem.value = issue;
    return;
  }
  if (scopeReasonIssue.value !== null) return;
  const reason = scopeReason.value.trim();
  const key = scopeKey ?? newIdempotencyKey();
  scopeKey = key;
  const seq = ++scopeSeq;
  scopeSaving.value = true;
  scopeFailure.value = null;
  scopeOutcome.value = null;

  const request = {
    baseUrl: API_BASE_URL,
    token: currentToken ?? '',
    administratorId: target.id,
    scope: target.scope,
    revision: target.revision,
    reason,
    idempotencyKey: key,
  };
  const result = target.mode === 'grant'
    ? await grantAdministratorScope(request)
    : await revokeAdministratorScope(request);
  if (seq !== scopeSeq) return; // 过期响应：丢弃，不往已换掉的目标里写
  if (currentToken === null) return; // 兜底：会话已经退出／被换掉，即便 seq 没变也不往空会话里写
  scopeSaving.value = false;

  if (result.ok === true) {
    scopeOutcome.value = {
      mode: target.mode,
      loginName: target.loginName,
      scope: target.scope,
      revisionFrom: target.revision,
      revision: result.revision,
      scopes: result.scopes,
      changed: result.changed,
    };
    closeScopeWrite();
    await refreshAfterScopeWrite(target.id);
    return;
  }
  scopeOutcome.value = null;
  scopeFailure.value = describeAdministratorScopeFailure(result);
}

/**
 * 写成功后刷新：先重读目录（行内 `scopes` / `revision` 都由它更新），
 * 若该行的 scopes 面板正开着，再重读一次权威值——否则面板会留着改动前的旧列表。
 */
async function refreshAfterScopeWrite(administratorId) {
  await refresh();
  const row = rows.value.find((item) => item.id === administratorId);
  if (row === undefined) return;
  if (state.value.selectedId === administratorId && state.value.scopesPhase !== 'idle') await loadScopes(row);
}

onMounted(async () => {
  const adminSession = await loadAdminSession();
  if (adminSession === null) {
    dispatch({ type: 'SESSION_MISSING' });
    return;
  }
  startSession(adminSession);
});

onBeforeUnmount(() => {
  ++requestSeq;
  ++scopesSeq;
  ++changeSeq; // 卸载后回来的写响应一律丢弃，不往已卸载的状态里写
  resetScopeWrite(); // 同上，连 `++scopeSeq` 一起（不在两处各写一份）
});
</script>

<template>
  <section class="directory">
    <header class="head">
      <h2>管理员权限读面</h2>
      <p class="sub">
        调用 <code>GET {{ ADMINISTRATORS_PATH }}</code>（operationId <code>{{ ADMINISTRATORS_OPERATION_ID }}</code>）读管理员目录，
        点某一行再调 <code>GET {{ ADMINISTRATORS_PATH }}/{id}/scopes</code>（operationId
        <code>{{ ADMINISTRATOR_SCOPES_OPERATION_ID }}</code>）看该管理员当前有效权限。两条的 scope 都是
        <code>{{ ADMINISTRATORS_SCOPE }}</code>。本页读之外还提供三条写入口：<strong>停用／恢复</strong>账号（写面 scope
        <code>{{ ADMINISTRATOR_STATE_SCOPE }}</code>）与 <strong>授权／撤销</strong>单条 scope（同样
        <code>{{ ADMINISTRATOR_SCOPE_WRITE_SCOPE }}</code>）；<code>If-Match</code> 一律取自行内 revision，
        并需 <code>Idempotency-Key</code> 与理由。scope 的可选值来自契约 <code>AdminScope</code> 闭集（共
        {{ ADMIN_SCOPE_COUNT }} 项）。
      </p>
      <button v-if="signedIn" class="ghost" type="button" data-testid="administrators-sign-out" @click="signOut">退出登录</button>
    </header>

    <form v-if="!signedIn" class="signin" data-testid="administrators-signin" @submit.prevent="submitSignIn">
      <h3>登录后台</h3>
      <p class="hint">
        管理员权限读面要求 scope <code>scopes:read</code>；这里的 <code>id</code> 是 <code>admin_accounts.id</code>，不是终端用户的
        <code>users.id</code>。
      </p>
      <label class="field">
        <span>登录名</span>
        <input v-model="loginName" name="loginName" autocomplete="username" required />
      </label>
      <label class="field">
        <span>口令</span>
        <input v-model="password" name="password" type="password" autocomplete="current-password" required />
      </label>
      <button class="primary" type="submit" :disabled="busy" data-testid="administrators-signin-submit">登录</button>
      <p v-if="signInError !== null" class="banner error" role="alert" data-testid="administrators-signin-error">{{ signInError }}</p>
    </form>

    <template v-else>
      <p v-if="state.scopeWarning" class="banner warn" data-testid="administrators-scope-warning">
        当前后台会话的 scope 列表里没有 <code>scopes:read</code>：读取会被后端以 403 SCOPE_DENIED 拒绝，下面会如实显示，不静默空白。
      </p>

      <div class="toolbar">
        <label class="field">
          <span>每页</span>
          <select data-testid="administrators-filter-limit" :value="String(state.limit)" @change="changeLimit($event.target.value)">
            <option v-for="choice in limitChoices" :key="choice" :value="String(choice)">{{ choice }}</option>
          </select>
        </label>
        <button class="ghost" type="button" :disabled="busy" data-testid="administrators-refresh" @click="refresh">重新读取第一页</button>
        <span v-if="busy" class="hint" data-testid="administrators-busy">读取中…</span>
      </div>

      <div class="status" :class="view.tone" :role="view.tone === 'error' ? 'alert' : 'status'" data-testid="administrators-status">
        <strong>{{ view.title }}</strong>
        <span>{{ view.detail }}</span>
        <code v-if="view.errorCode !== ''" class="code-chip" data-testid="administrators-error-code">{{ view.errorCode }}</code>
        <button v-if="view.canRetry" class="link" type="button" data-testid="administrators-retry" @click="refresh">重试</button>
      </div>

      <p class="counts">
        <span class="pill ok">已读 {{ view.total }} 个管理员</span>
        <span v-if="view.duplicates > 0" class="pill warn">去重 {{ view.duplicates }} 个</span>
        <span v-if="view.nextCursor !== null" class="pill">还有下一页</span>
        <span v-else-if="view.total > 0" class="pill ok">已到最后一页</span>
      </p>

      <table v-if="rows.length > 0" class="grid" data-testid="administrators-table">
        <thead>
          <tr>
            <th>login_name</th>
            <th>state</th>
            <th>scopes（列表项自带）</th>
            <th>id（admin_accounts.id）</th>
            <th>revision（If-Match 来源）</th>
            <th>权限</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in rows"
            :key="row.id"
            data-testid="administrators-row"
            :class="{ selected: state.selectedId === row.id }"
          >
            <td class="mono">{{ row.loginName }}</td>
            <td><span class="pill" :class="row.stateTone">{{ row.stateLabel }}</span></td>
            <td class="mono scopes-cell" data-testid="administrator-scopes-text">{{ row.scopesText }}</td>
            <td class="mono">{{ row.id }}</td>
            <td class="mono" data-testid="administrator-revision">{{ row.revisionLabel }}</td>
            <td>
              <button class="link" type="button" data-testid="administrator-view-scopes" @click="openScopes(row)">
                {{ state.selectedId === row.id ? '收起权限' : '查看权限' }}
              </button>
              <button
                v-if="row.state === 'active'"
                class="link danger"
                type="button"
                data-testid="administrator-disable"
                :disabled="!canChange(row, 'disable') || busy || changeSaving"
                @click.stop="openStateChange(row, 'disable', $event)"
              >停用</button>
              <button
                v-if="row.state === 'suspended'"
                class="link danger"
                type="button"
                data-testid="administrator-enable"
                :disabled="!canChange(row, 'enable') || busy || changeSaving"
                @click.stop="openStateChange(row, 'enable', $event)"
              >恢复</button>
              <template v-if="row.state === 'active'">
                <select
                  class="scope-pick"
                  data-testid="administrator-scope-pick"
                  :value="scopePick(row)"
                  :aria-label="`为 ${row.loginName} 选择要授权或撤销的 scope（契约 AdminScope 闭集）`"
                  :disabled="busy || scopeSaving || changeSaving"
                  @change="pickScope(row, $event.target.value)"
                >
                  <option value="">选择 scope…</option>
                  <option v-for="option in scopeOptions" :key="option.value" :value="option.value">
                    {{ option.value }} · {{ option.label }}
                  </option>
                </select>
                <button
                  class="link"
                  type="button"
                  data-testid="administrator-grant"
                  :aria-label="`给 ${row.loginName} 授予所选 scope`"
                  :aria-disabled="canPickScope(row, 'grant') ? 'false' : 'true'"
                  :disabled="!canPickScope(row, 'grant') || busy || scopeSaving || changeSaving"
                  @click.stop="openScopeWrite(row, 'grant', $event)"
                >授权</button>
                <button
                  class="link danger"
                  type="button"
                  data-testid="administrator-revoke"
                  :aria-label="`撤销 ${row.loginName} 的所选 scope`"
                  :aria-disabled="canPickScope(row, 'revoke') ? 'false' : 'true'"
                  :disabled="!canPickScope(row, 'revoke') || busy || scopeSaving || changeSaving"
                  @click.stop="openScopeWrite(row, 'revoke', $event)"
                >撤销</button>
              </template>
            </td>
          </tr>
        </tbody>
      </table>

      <aside v-else-if="view.tone === 'empty'" class="note" data-testid="administrators-empty">
        <strong>{{ view.title }}</strong>
        <p>{{ view.detail }}</p>
      </aside>

      <section
        v-if="state.scopesPhase !== 'idle'"
        class="panel"
        :class="scopesView.tone"
        data-testid="administrator-scopes-panel"
      >
        <header class="panel-head">
          <strong data-testid="administrator-scopes-title">{{ scopesView.title }}</strong>
          <button class="link" type="button" data-testid="administrator-scopes-close" @click="closeScopes">关闭</button>
        </header>
        <p class="panel-detail">{{ scopesView.detail }}</p>
        <code v-if="scopesView.errorCode !== ''" class="code-chip" data-testid="administrator-scopes-error">{{ scopesView.errorCode }}</code>
        <button v-if="scopesView.canRetry" class="ghost" type="button" data-testid="administrator-scopes-retry" @click="retryScopes">重试</button>
        <ul v-if="scopesList.length > 0" class="scope-list">
          <li v-for="item in scopesList" :key="item.scope" data-testid="administrator-scope">
            <span class="mono">{{ item.scope }}</span>
            <small class="label">{{ item.label }}</small>
          </li>
        </ul>
        <button class="ghost" type="button" data-testid="administrator-scopes-load" :disabled="scopesBusy" @click="retryScopes">
          重新读取当前选择
        </button>
      </section>

      <p v-if="changeOutcome !== null" class="banner ok" role="status" data-testid="administrator-state-ok">
        {{ changeOutcome.mode === 'disable' ? '已停用' : '已恢复' }} <code>{{ changeOutcome.loginName }}</code>：
        现在 state <code>{{ changeOutcome.state }}</code>、revision <code>{{ changeOutcome.revision }}</code>（本行原是
        <code>{{ changeOutcome.revisionFrom }}</code>）·{{ changeOutcome.changed ? ' 本次确实发生了状态变更' : ' 本次未产生变更（同键重放或目标本就在该状态）' }}。
        <span class="hint">
          ⓘ 恢复只改账号状态：<strong>不会恢复被撤销的会话</strong>，<strong>不会恢复被撤销的 scope</strong> ——
          该管理员需要重新登录、并由他人重新授权后才能再进后台。
        </span>
      </p>

      <p v-if="changeFailure !== null" class="hint warn-text" data-testid="administrator-state-failure">
        {{ changeFailure.title }}<template v-if="changeFailure.detail !== ''"> · {{ changeFailure.detail }}</template>
        <template v-if="changeFailure.canRetry"> · 可以用同一幂等键重试。</template>
      </p>

      <WriteReceipt
        v-if="changeReceipt !== null"
        :write="changeReceipt.write"
        :changed="changeReceipt.verdict"
        @clear-receipt="dismissStateReceipt"
      />

      <div
        v-if="changeTarget !== null"
        ref="changeDialog"
        class="state-confirm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="administrator-state-title"
        data-testid="administrator-state-dialog"
        tabindex="-1"
        @keydown="onStateKeydown"
      >
        <strong id="administrator-state-title" ref="changeTitle" tabindex="-1">
          {{ changeTarget.mode === 'disable' ? '确认停用管理员账号' : '确认恢复管理员账号' }}
        </strong>
        <p class="hint">
          <code>POST {{ ADMINISTRATORS_PATH }}/{{ changeTarget.id }}/{{ changeTarget.mode }}</code> · scope
          <code>{{ ADMINISTRATOR_STATE_SCOPE }}</code> · <code>If-Match: "{{ changeTarget.revision }}"</code>
          （取自已加载那一行的 revision：目录不发 ETag）· 需要 <code>Idempotency-Key</code> 与理由。
        </p>
        <label class="field">
          <span>理由（契约 <code>ReasonInput.reason</code>，1..500 字符，写进审计）</span>
          <input
            v-model="changeReason"
            name="administrator_state_reason"
            maxlength="500"
            :disabled="changeSaving"
            data-testid="administrator-state-reason"
          />
        </label>
        <p v-if="changeProblem !== null" class="hint warn-text" data-testid="administrator-state-problem">{{ changeProblem }}</p>
        <p v-if="changeSaving" class="hint" data-testid="administrator-state-progress">
          提交中…（请求已发出，正在等服务端回执）
        </p>
        <div class="state-actions">
          <button
            class="primary"
            type="button"
            :disabled="changeSaving || changeProblem !== null"
            data-testid="administrator-state-submit"
            @click="submitStateChange"
          >
            {{ changeSaving ? (changeTarget.mode === 'disable' ? '停用中…' : '恢复中…') : `确认${changeLabel(changeTarget.mode)}` }}
          </button>
          <button class="ghost" type="button" :disabled="changeSaving" data-testid="administrator-state-cancel" @click="closeStateChange">取消</button>
        </div>
        <p class="hint">
          ⓘ 停用会撤销该管理员的会话并让 <code>auth_epoch</code> 前进；恢复不会把会话或 scope 还回去。
        </p>
      </div>

      <p v-if="scopePickProblem !== null" class="banner error" role="alert" data-testid="administrator-scope-error">
        {{ scopePickProblem }}
        <span class="hint">ⓘ 这次没有发出任何请求：scope 必须在契约 <code>AdminScope</code> 闭集内（共 {{ ADMIN_SCOPE_COUNT }} 项）。</span>
      </p>

      <p v-if="scopeFailure !== null" class="banner error" role="alert" data-testid="administrator-scope-failure">
        {{ scopeFailure.title }}<template v-if="scopeFailure.detail !== ''"> · {{ scopeFailure.detail }}</template>
        <template v-if="scopeFailure.canRetry"> · 可以用同一幂等键重试。</template>
      </p>

      <p v-if="scopeOutcome !== null" class="banner ok" role="status" data-testid="administrator-scope-ok">
        {{ scopeOutcome.mode === 'grant' ? '已授权' : '已撤销' }} <code>{{ scopeOutcome.loginName }}</code> 的
        <code>{{ scopeOutcome.scope }}</code>：现在 revision <code>{{ scopeOutcome.revision }}</code>（本行原是
        <code>{{ scopeOutcome.revisionFrom }}</code>）·{{ scopeOutcome.changed
          ? ' 本次确实发生了权限变更'
          : ' 本次未产生变更（同键重放，或该 scope 本来就在／本来就没有）' }}。
      </p>

      <div
        v-if="scopeTarget !== null"
        ref="scopeDialog"
        class="state-confirm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="administrator-scope-title"
        data-testid="administrator-scope-dialog"
        tabindex="-1"
        @keydown="onScopeKeydown"
      >
        <strong id="administrator-scope-title" ref="scopeTitle" tabindex="-1">
          {{ scopeTarget.mode === 'grant' ? '确认授权 scope' : '确认撤销 scope' }}：<code>{{ scopeTarget.scope }}</code>
        </strong>
        <p class="hint">
          <code>{{ scopeTarget.mode === 'grant' ? 'POST' : 'DELETE' }} {{ ADMINISTRATORS_PATH }}/{{ scopeTarget.id }}/scopes<template v-if="scopeTarget.mode === 'revoke'">/{{ scopeTarget.scope }}</template></code>
          · scope <code>{{ ADMINISTRATOR_SCOPE_WRITE_SCOPE }}</code> · <code>If-Match: "{{ scopeTarget.revision }}"</code>
          （取自已加载那一行的 revision：目录不发 ETag）· 需要 <code>Idempotency-Key</code> 与理由。scope 闭集来自契约
          <code>AdminScope</code>（共 {{ ADMIN_SCOPE_COUNT }} 项）。
        </p>
        <label class="field">
          <span>理由（契约 <code>ReasonInput.reason</code>，1..500 字符，写进审计）</span>
          <input
            name="administrator_scope_reason"
            maxlength="500"
            :value="scopeReason"
            :disabled="scopeSaving"
            data-testid="administrator-scope-reason"
            @input="scopeReason = $event.target.value"
          />
        </label>
        <p v-if="scopeReasonIssue !== null" class="hint warn-text" data-testid="administrator-scope-problem">{{ scopeReasonIssue }}</p>
        <p v-if="scopeSaving" class="hint" data-testid="administrator-scope-progress">提交中…（请求已发出，正在等服务端回执）</p>
        <div class="state-actions">
          <button
            class="primary"
            type="button"
            :disabled="scopeSaving || scopeReasonIssue !== null"
            data-testid="administrator-scope-submit"
            @click="submitScopeWrite"
          >
            {{ scopeSaving ? '提交中…' : `确认${scopeModeLabel(scopeTarget.mode)}` }}
          </button>
          <button class="ghost" type="button" :disabled="scopeSaving" data-testid="administrator-scope-cancel" @click="closeScopeWrite">取消</button>
        </div>
        <p class="hint">
          ⓘ 撤销一条本来就没有的 scope 是幂等空操作（<code>changed:false</code>，不写审计、不推 revision）；
          撤掉最后一名 <code>scopes:write</code> 有效持有人会被服务端 409 <code>LAST_SCOPE_MANAGER</code> 拒。
        </p>
      </div>

      <div class="pager">
        <button class="ghost" type="button" :disabled="!view.canLoadMore" data-testid="administrators-load-more" @click="loadMore">读取下一页</button>
      </div>

      <p class="foot">
        说明：读面是两条 GET（<code>scopes:read</code>），写面是 <code>POST …/disable</code>、
        <code>POST …/enable</code>、<code>POST …/scopes</code>（授权）与 <code>DELETE …/scopes/{scope}</code>（撤销）
        —— 全部 <code>scopes:write</code>，都需 <code>If-Match</code> + <code>Idempotency-Key</code> + 理由。
        <code>scopes</code> 是「当前有效（revoked_at IS NULL）」的权限，去重 + 码元序，只含 scope
        字符串 —— ⛔ 不含 <code>granted_by</code> / <code>granted_at</code>（运行时角色对 <code>admin_scopes</code> 只有三列 SELECT
        权限，写进契约就是无法兑现的承诺）。停用 ≠ 撤销 scope：停用改账号状态并撤会话，
        恢复也不会把 scope 还回来——要收回某条权限，用行内的「撤销」。
      </p>
    </template>
  </section>
</template>

<style scoped>
.directory {
  display: grid;
  gap: 0.9rem;
}

.head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.5rem 0.9rem;
}

h2 {
  margin: 0;
  font-size: 1.15rem;
}

h3 {
  margin: 0;
  font-size: 1rem;
}

.sub,
.hint,
.foot,
.note p,
.counts,
.panel-detail {
  font-size: 0.86rem;
  color: #4a5568;
}

.sub {
  flex: 1 1 20rem;
  margin: 0;
  line-height: 1.55;
}

.hint,
.panel-detail {
  margin: 0;
}

.signin {
  display: grid;
  gap: 0.6rem;
  max-width: 30rem;
  padding: 0.9rem 1rem;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  background: #fff;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem 0.9rem;
  align-items: flex-end;
}

.field {
  display: grid;
  gap: 0.25rem;
  font-size: 0.82rem;
  color: #4a5568;
}

input,
select {
  padding: 0.45rem 0.6rem;
  border: 1px solid #cbd5e0;
  border-radius: 8px;
  font: inherit;
  background: #fff;
}

input {
  min-width: 13rem;
}

button {
  font: inherit;
  cursor: pointer;
}

button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.primary {
  padding: 0.45rem 0.9rem;
  border: 1px solid #0f766e;
  border-radius: 8px;
  background: #0f766e;
  color: #fff;
}

.ghost {
  padding: 0.35rem 0.8rem;
  border: 1px solid #cbd5e0;
  border-radius: 8px;
  background: #fff;
  color: #1a202c;
}

.link {
  padding: 0;
  border: 0;
  background: none;
  color: #0f766e;
  text-decoration: underline;
}

.banner {
  margin: 0;
  padding: 0.5rem 0.7rem;
  border-radius: 8px;
  font-size: 0.86rem;
}

.banner.warn {
  border-left: 3px solid #b7791f;
  background: #fffbeb;
  color: #744210;
}

.banner.error {
  border-left: 3px solid #c53030;
  background: #fff5f5;
  color: #822727;
}

.banner.ok {
  border-left: 3px solid #2f855a;
  background: #f0fff4;
  color: #22543d;
}

/* 行内「停用／恢复」与既有「查看权限」并排：同一种 link 样式，只是危险动作用红色。 */
.link.danger {
  margin-left: 0.5rem;
  color: #c53030;
}

.warn-text {
  color: #9c2b2b;
}

/* 写确认框（照 AccountsView 的停用确认框形态：标题 + 契约说明 + 理由 + 动作）。 */
.state-confirm {
  display: grid;
  gap: 0.6rem;
  border: 1px solid #cbd5e0;
  border-radius: 10px;
  background: #f7fafc;
  padding: 0.8rem 1rem;
}

.state-confirm strong {
  font-size: 0.95rem;
}

.state-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  padding: 0.55rem 0.7rem;
  border-left: 3px solid #a0aec0;
  background: #f7fafc;
  font-size: 0.88rem;
}

.status.ready {
  border-left-color: #2f855a;
  background: #f0fdf4;
}

.status.empty {
  border-left-color: #3182ce;
  background: #ebf8ff;
}

.status.stale {
  border-left-color: #b7791f;
  background: #fffbeb;
}

.status.error {
  border-left-color: #c53030;
  background: #fff5f5;
}

.code-chip {
  padding: 0.1rem 0.35rem;
  border-radius: 4px;
  background: #edf2f7;
  font-size: 0.78rem;
}

.counts {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin: 0;
}

.pill {
  padding: 0.12rem 0.5rem;
  border-radius: 999px;
  background: #edf2f7;
  color: #2d3748;
  font-size: 0.78rem;
}

.pill.ok {
  background: #e6fffa;
  color: #234e52;
}

.pill.warn {
  background: #fffaf0;
  color: #7b341e;
}

.grid {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.82rem;
  background: #fff;
}

th,
td {
  padding: 0.45rem 0.5rem;
  border-bottom: 1px solid #e2e8f0;
  text-align: left;
  vertical-align: top;
}

th {
  color: #4a5568;
  font-weight: 600;
  white-space: nowrap;
}

tr.selected {
  background: #f0fdfa;
}

.scopes-cell {
  max-width: 22rem;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  word-break: break-all;
}

.label {
  display: block;
  color: #718096;
}

.note {
  padding: 0.7rem 0.9rem;
  border: 1px dashed #cbd5e0;
  border-radius: 10px;
  background: #fff;
  font-size: 0.88rem;
}

.note p {
  margin: 0.35rem 0 0;
}

.panel {
  display: grid;
  gap: 0.5rem;
  padding: 0.8rem 0.9rem;
  border: 1px solid #cbd5e0;
  border-radius: 10px;
  background: #fff;
  font-size: 0.88rem;
}

.panel.ready {
  border-color: #c6f6d5;
  background: #f0fff4;
}

.panel.error {
  border-color: #fed7d7;
  background: #fff5f5;
}

.panel-head {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
  align-items: baseline;
}

.scope-list {
  display: grid;
  gap: 0.25rem;
  margin: 0;
  padding-left: 1.1rem;
  font-size: 0.84rem;
}

.pager {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}

.foot {
  margin: 0;
  line-height: 1.6;
}

/* 行内 scope 选择器：操作列本来就窄，给一个够用的上限，不把整行撑开。 */
.scope-pick {
  max-width: 11rem;
  font: inherit;
  font-size: 0.8rem;
  padding: 0.1rem 0.25rem;
}

/* 键盘可达：本页按钮全是 `.link` / `.ghost` 这类轻样式，必须自带可见焦点环
   （默认 outline 在重置过的按钮上不一定看得见）。鼠标点击不触发 `:focus-visible`。 */
button:focus-visible,
input:focus-visible,
select:focus-visible,
a:focus-visible {
  outline: 2px solid #0f766e;
  outline-offset: 2px;
}
</style>
