<script setup>
/**
 * 账号目录只读页（GY-I18）。
 *
 * 只调用契约里存在的读面：GET {API_BASE_URL}/admin/accounts（operationId `listAdminUsers`，scope `accounts:read`）。
 * 鉴权复用 `src/auth/session.ts` 的既有实现（Bearer + sessionStorage），本页不新造一套登录。
 * 纯逻辑都在 `src/lib/*.mjs`，本组件只负责把状态机接到 DOM。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { API_BASE_URL, loadAdminSession, signInAdmin, signOutAdmin } from '../auth/session';
import { appendPage, emptyCollection, fetchAccountsPage } from '../lib/admin-api.mjs';
import { canLoadMore, describe, initialState, reduce, summaryOf, visibleRowViews } from '../lib/view-model.mjs';

const state = ref(initialState());
const session = ref(null);
const loginName = ref('');
const password = ref('');
const busy = ref(false);

// 每次换会话/重载递增；晚到的旧响应一律丢弃（避免把上一会话的数据画到当前会话）。
let requestSeq = 0;
let currentToken = null;

const view = computed(() => describe(state.value));
const rows = computed(() => visibleRowViews(state.value));
const summary = computed(() => (state.value.selectedId === null ? null : summaryOf(state.value, state.value.selectedId)));
const signedIn = computed(() => state.value.signedIn);
const canRetry = computed(() => view.value.canRetry === true);
const restartNeeded = computed(() => view.value.action === 'restart');

function dispatch(action) {
  state.value = reduce(state.value, action);
}

async function requestPage(cursor, { reset }) {
  const token = currentToken;
  if (token === null) {
    dispatch({ type: 'LOAD_FAIL', failure: { ok: false, kind: 'signed_out', status: null, retriable: false } });
    return;
  }
  const seq = ++requestSeq;
  busy.value = true;
  dispatch({ type: 'LOAD_START', reset });
  const result = await fetchAccountsPage({ baseUrl: API_BASE_URL, token, cursor });
  if (seq !== requestSeq) return; // 过期响应：丢弃，不改状态
  busy.value = false;
  if (result.ok) {
    const base = reset ? emptyCollection() : state.value.collection;
    const { collection } = appendPage(base, { cursor, page: result.page });
    dispatch({ type: 'LOAD_OK', collection });
  } else {
    dispatch({ type: 'LOAD_FAIL', failure: result });
  }
}

async function startSession(adminSession) {
  session.value = adminSession;
  currentToken = adminSession.accessToken;
  dispatch({ type: 'SIGNED_IN', scopes: adminSession.scopes, scopesProvided: true });
  await requestPage(null, { reset: true });
}

async function submitSignIn() {
  if (loginName.value.trim() === '' || password.value === '') return;
  dispatch({ type: 'SIGN_IN_START' });
  busy.value = true;
  try {
    await signInAdmin({ loginName: loginName.value.trim(), password: password.value });
    password.value = ''; // 提交后立刻丢弃明文口令，不留在内存/表单里
    // 登录响应不含 scope，按仓内既有做法再读一次 GET /admin/auth/session。
    const refreshed = await loadAdminSession();
    if (refreshed === null) {
      dispatch({
        type: 'SIGN_IN_FAILED',
        failure: { ok: false, kind: 'signed_out', status: null, retriable: false, message: '登录后未能读到会话详情' },
      });
      return;
    }
    busy.value = false;
    await startSession(refreshed);
  } catch (error) {
    busy.value = false;
    dispatch({
      type: 'SIGN_IN_FAILED',
      failure: { ok: false, kind: 'http_error', status: null, retriable: true, message: error instanceof Error ? error.message : '登录失败' },
    });
  }
}

async function signOut() {
  ++requestSeq;
  await signOutAdmin();
  session.value = null;
  currentToken = null;
  dispatch({ type: 'SIGN_OUT' });
}

function retry() {
  // 错误态与游标失效都回到第一页重读；续页游标不能复用。
  requestPage(null, { reset: true });
}

function loadMore() {
  const cursor = state.value.collection.nextCursor;
  if (cursor === null) return;
  requestPage(cursor, { reset: false });
}

function refresh() {
  requestPage(null, { reset: true });
}

onMounted(async () => {
  const existing = await loadAdminSession();
  if (existing === null) {
    dispatch({ type: 'SESSION_MISSING' });
    return;
  }
  await startSession(existing);
});

onBeforeUnmount(() => {
  ++requestSeq; // 卸载后晚到的响应不再落状态
});
</script>

<template>
  <section class="accounts">
    <header class="head">
      <div>
        <h2>账号目录（只读）</h2>
        <p class="sub">
          数据源 <code>GET {{ API_BASE_URL }}/admin/accounts</code>（契约 <code>listAdminUsers</code>，scope
          <code>accounts:read</code>）。本页只读，不提供停用/注销等写操作。
        </p>
      </div>
      <button v-if="signedIn" class="ghost" type="button" :disabled="busy" @click="signOut">退出登录</button>
    </header>

    <form v-if="!signedIn" class="signin" @submit.prevent="submitSignIn">
      <p class="hint">
        未登录。登录走既有 <code>POST /admin/auth/session</code>（<code>src/auth/session.ts</code>），
        令牌只存 sessionStorage，不写入 URL。
      </p>
      <label>
        <span>登录名</span>
        <input v-model="loginName" name="login_name" autocomplete="username" :disabled="busy" />
      </label>
      <label>
        <span>密码</span>
        <input v-model="password" name="password" type="password" autocomplete="current-password" :disabled="busy" />
      </label>
      <button class="primary" type="submit" :disabled="busy || loginName.trim() === '' || password === ''">
        {{ busy ? '登录中…' : '登录' }}
      </button>
    </form>

    <template v-else>
      <p v-if="state.scopeWarning" class="banner warn">
        当前会话的 scope 列表里没有 <code>accounts:read</code>：请求大概率返回
        <code>403 SCOPE_DENIED</code>。以服务端返回为准，本页不猜权限。
      </p>

      <div class="toolbar">
        <input
          :value="state.filter"
          class="filter"
          type="search"
          placeholder="在已加载的行内按显示名 / 账号 ID 筛选"
          @input="dispatch({ type: 'SET_FILTER', value: $event.target.value })"
        />
        <button class="ghost" type="button" :disabled="busy" @click="refresh">重新读取</button>
        <button v-if="canLoadMore" class="primary" type="button" :disabled="busy" @click="loadMore">加载下一页</button>
      </div>
      <p class="scope-note">
        关键字筛选<strong>仅在已加载的 {{ state.collection.items.length }} 行内</strong>生效：后端该接口只有
        <code>cursor</code>／<code>limit</code> 两个参数，没有关键字参数。
      </p>

      <div class="status" :class="view.tone" role="status">
        <strong>{{ view.title }}</strong>
        <span>{{ view.detail }}</span>
        <button v-if="canRetry || restartNeeded" class="link" type="button" :disabled="busy" @click="retry">
          {{ restartNeeded ? '从第一页重读' : '重试' }}
        </button>
      </div>

      <table v-if="rows.length > 0" class="grid">
        <thead>
          <tr>
            <th>显示名</th>
            <th>状态</th>
            <th>revision</th>
            <th>账号 ID</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in rows"
            :key="row.id"
            :class="{ selected: row.id === state.selectedId }"
            @click="dispatch({ type: 'SELECT', id: row.id })"
          >
            <td>{{ row.displayName }}</td>
            <td><span class="pill" :class="row.stateTone">{{ row.stateLabel }}</span></td>
            <td class="mono">{{ row.revisionLabel }}</td>
            <td class="mono" :title="row.id">{{ row.shortId }}…</td>
            <td class="right"><button class="link" type="button">详情摘要</button></td>
          </tr>
        </tbody>
      </table>

      <p v-if="state.collection.duplicates > 0" class="foot">
        续页中有 {{ state.collection.duplicates }} 行与已加载行 ID 重复，已去重（未重复计数）。
      </p>
      <p v-if="state.collection.cycle" class="foot warn-text">
        服务端把请求游标原样返回，已停止续页以防死循环。
      </p>
    </template>

    <aside v-if="summary" class="summary">
      <header>
        <h3>{{ summary.title }}</h3>
        <button class="link" type="button" @click="dispatch({ type: 'CLOSE_SUMMARY' })">关闭</button>
      </header>
      <dl>
        <template v-for="field in summary.fields" :key="field.label">
          <dt>{{ field.label }}</dt>
          <dd class="mono">{{ field.value }}</dd>
        </template>
      </dl>
      <p class="missing">
        读面未提供：{{ summary.missing.join('、') }}。
      </p>
      <p class="note">{{ summary.note }}</p>
    </aside>
  </section>
</template>

<style scoped>
.accounts {
  display: grid;
  gap: 0.9rem;
}
.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
}
h2 {
  margin: 0;
  font-size: 1.15rem;
}
.sub,
.hint,
.scope-note,
.foot,
.note,
.missing {
  margin: 0.35rem 0 0;
  font-size: 0.86rem;
  color: #4a5568;
  line-height: 1.65;
}
code {
  background: #edf2f7;
  border-radius: 4px;
  padding: 0.05rem 0.3rem;
  font-size: 0.86em;
}
.signin {
  display: grid;
  gap: 0.6rem;
  max-width: 26rem;
  padding: 1rem;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  background: #fff;
}
.signin label {
  display: grid;
  gap: 0.25rem;
  font-size: 0.9rem;
}
input {
  padding: 0.45rem 0.6rem;
  border: 1px solid #cbd5e0;
  border-radius: 8px;
  font: inherit;
}
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.filter {
  flex: 1 1 18rem;
}
button {
  font: inherit;
  cursor: pointer;
  border-radius: 8px;
  padding: 0.45rem 0.85rem;
}
button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
.primary {
  border: 1px solid #0f766e;
  background: #0f766e;
  color: #fff;
}
.ghost {
  border: 1px solid #cbd5e0;
  background: #fff;
  color: #1a202c;
}
.link {
  border: 0;
  background: none;
  color: #0f766e;
  padding: 0.1rem 0.25rem;
  text-decoration: underline;
}
.banner {
  margin: 0;
  padding: 0.6rem 0.8rem;
  border-radius: 8px;
  font-size: 0.88rem;
}
.banner.warn {
  background: #fffbeb;
  border-left: 4px solid #b7791f;
}
.status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  padding: 0.6rem 0.8rem;
  border-radius: 8px;
  font-size: 0.9rem;
  background: #f7fafc;
  border-left: 4px solid #a0aec0;
}
.status.ready {
  background: #f0fdf4;
  border-left-color: #2f855a;
}
.status.stale {
  background: #fffbeb;
  border-left-color: #b7791f;
}
.status.error {
  background: #fff5f5;
  border-left-color: #c53030;
}
.status.empty,
.status.empty_filtered {
  background: #f7fafc;
  border-left-color: #4a5568;
}
.grid {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.92rem;
}
.grid th,
.grid td {
  text-align: left;
  padding: 0.5rem 0.6rem;
  border-bottom: 1px solid #e2e8f0;
}
.grid tbody tr {
  cursor: pointer;
}
.grid tbody tr:hover {
  background: #f0fdfa;
}
.grid tr.selected {
  background: #ccfbf1;
}
.right {
  text-align: right;
}
.mono {
  font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
  font-size: 0.86rem;
}
.pill {
  display: inline-block;
  padding: 0.05rem 0.5rem;
  border-radius: 999px;
  font-size: 0.82rem;
}
.pill.ok {
  background: #def7ec;
  color: #22543d;
}
.pill.warn {
  background: #fef3c7;
  color: #744210;
}
.pill.danger {
  background: #fed7d7;
  color: #822727;
}
.summary {
  border: 1px solid #cbd5e0;
  border-radius: 10px;
  padding: 0.9rem 1rem;
  background: #fff;
}
.summary header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.summary h3 {
  margin: 0;
  font-size: 1rem;
}
.summary dl {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.3rem 1rem;
  margin: 0.6rem 0 0;
  font-size: 0.9rem;
}
.summary dt {
  font-weight: 600;
}
.summary dd {
  margin: 0;
  word-break: break-all;
}
.warn-text {
  color: #975a16;
}
</style>
