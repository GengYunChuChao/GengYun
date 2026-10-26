<script setup>
/**
 * R60 · 管理员权限读面页面（只读）。
 *
 * 只调两条 GET：
 * - `GET /admin/administrators`（operationId `listAdministrators`）—— 管理员目录，每项
 *   `{id, login_name, state, scopes}`，`id` 是 `admin_accounts.id`（⛔ 不是 users.id）；
 * - `GET /admin/administrators/{id}/scopes`（operationId `listAdministratorScopes`）—— 某人当前有效权限。
 * 两条的 x-scope 都是 `scopes:read`。
 *
 * ⛔ 不做授权 / 撤销（scopes:write 不在本片范围），不改权限模型。
 * 表现约定：403 显示明确提示 + 错误码（不静默空白）；空目录显示空态；某人不存在显示 404 NOT_FOUND。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
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
        retriable: false,
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

/** 点某一行「查看权限」：读一次 /admin/administrators/{id}/scopes。 */
async function openScopes(row) {
  if (currentToken === null) {
    dispatch({ type: 'SCOPES_FAIL', failure: { ok: false, kind: 'signed_out', retriable: false, status: null, code: null, inContract: false, retryAfterSeconds: null, message: '没有后台会话令牌' } });
    return;
  }
  if (state.value.selectedId === row.id && state.value.scopesPhase === 'ready') {
    dispatch({ type: 'CLOSE_SCOPES' });
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
  requestPage(null, { reset: true });
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
        <code>{{ ADMINISTRATORS_SCOPE }}</code>。本页只读：不授权、不撤销、不改权限模型。
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
            <td class="mono scopes-cell">{{ row.scopesText }}</td>
            <td class="mono">{{ row.id }}</td>
            <td>
              <button class="link" type="button" data-testid="administrator-view-scopes" @click="openScopes(row)">
                {{ state.selectedId === row.id ? '收起权限' : '查看权限' }}
              </button>
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

      <div class="pager">
        <button class="ghost" type="button" :disabled="!view.canLoadMore" data-testid="administrators-load-more" @click="loadMore">读取下一页</button>
      </div>

      <p class="foot">
        只读说明：本页只有两条 GET。<code>scopes</code> 是「当前有效（revoked_at IS NULL）」的权限，去重 + 码元序，只含 scope
        字符串 —— ⛔ 不含 <code>granted_by</code> / <code>granted_at</code>（运行时角色对 <code>admin_scopes</code> 只有三列 SELECT
        权限，写进契约就是无法兑现的承诺）。授权 / 撤销需要 <code>scopes:write</code>，不在本片范围。
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
</style>
