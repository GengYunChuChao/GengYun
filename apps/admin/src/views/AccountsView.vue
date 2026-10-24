<script setup>
/**
 * 账号目录页（GY-I18）：读面 + 停用写面。
 *
 * 读面：GET {API_BASE_URL}/admin/accounts（operationId `listAdminUsers`，scope `accounts:read`）。
 * 写面：POST {API_BASE_URL}/admin/accounts/{id}/suspend（operationId `suspendUser`，scope
 * `accounts:suspend`；必带 `If-Match` 强 ETag 与 `Idempotency-Key`，body 为 `{ reason }`）。
 * 鉴权复用 `src/auth/session.ts` 的既有实现（Bearer + sessionStorage），本页不新造一套登录。
 * 纯逻辑都在 `src/lib/*.mjs`，本组件只负责把状态机接到 DOM。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { API_BASE_URL, loadAdminSession, signInAdmin, signOutAdmin } from '../auth/session';
import { appendPage, emptyCollection, fetchAccountsPage } from '../lib/admin-api.mjs';
import { newIdempotencyKey, suspendAccount } from '../lib/account-suspend-api.mjs';
import {
  canLoadMore,
  canOpenSuspendDialog,
  describe,
  describeSuspendFailure,
  initialState,
  reduce,
  summaryOf,
  suspendReasonProblem,
  suspendTargetView,
  visibleRowViews,
} from '../lib/view-model.mjs';

const state = ref(initialState());
const session = ref(null);
const loginName = ref('');
const password = ref('');
const busy = ref(false);

// 每次换会话/重载/写入递增；晚到的旧响应一律丢弃（避免把上一会话的数据画到当前会话）。
let requestSeq = 0;
let currentToken = null;

const view = computed(() => describe(state.value));
const rows = computed(() => visibleRowViews(state.value));
const summary = computed(() => (state.value.selectedId === null ? null : summaryOf(state.value, state.value.selectedId)));
const signedIn = computed(() => state.value.signedIn);
const canRetry = computed(() => view.value.canRetry === true);
const restartNeeded = computed(() => view.value.action === 'restart');
const suspendTarget = computed(() => suspendTargetView(state.value));
const suspendProblem = computed(() => suspendReasonProblem(state.value));
const suspendFailureView = computed(() => describeSuspendFailure(state.value.suspendFailure));
const canOpenSuspend = computed(() => canOpenSuspendDialog(state.value));
const suspendSaving = computed(() => state.value.suspendStatus === 'saving');
const suspendSaved = computed(() => state.value.suspendStatus === 'saved');

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

/** 进入停用确认态：目标行必须是 active，否则状态机直接丢弃（不猜、不伪造写权限）。 */
function beginSuspend(row) {
  dispatch({ type: 'SUSPEND_BEGIN', id: row.id });
}

function cancelSuspend() {
  dispatch({ type: 'SUSPEND_CANCEL' });
}

function dismissSuspendResult() {
  dispatch({ type: 'SUSPEND_CLEAR' });
}

/** 发一次停用：`idempotencyKey` 每次新生成；重试必须复用同一个键（见 retrySuspend）。 */
async function sendSuspend(intent) {
  const token = currentToken;
  if (token === null) {
    dispatch({ type: 'SUSPEND_FAIL', failure: { ok: false, kind: 'signed_out', status: null, retriable: false } });
    return;
  }
  const seq = ++requestSeq;
  busy.value = true;
  dispatch({
    type: 'SUSPEND_START',
    id: intent.id,
    revision: intent.revision,
    reason: intent.reason,
    idempotencyKey: intent.idempotencyKey,
  });
  const result = await suspendAccount({
    baseUrl: API_BASE_URL,
    token,
    id: intent.id,
    reason: intent.reason,
    revision: intent.revision,
    idempotencyKey: intent.idempotencyKey,
  });
  if (seq !== requestSeq) return; // 过期响应：丢弃，不改状态
  busy.value = false;
  if (result.ok) {
    dispatch({ type: 'SUSPEND_OK', account: result.account });
    refresh(); // 停用会改变行状态/修订，成功后就地刷新第一页
  } else {
    dispatch({ type: 'SUSPEND_FAIL', failure: result });
  }
}

/** 确认停用：If-Match 取自已加载那一行的 revision，不猜；幂等键本次新生成。 */
function confirmSuspend() {
  const target = state.value.suspendTargetId;
  const row = target === null ? undefined : state.value.collection.items.find((item) => item.id === target);
  if (row === undefined) return;
  sendSuspend({
    id: row.id,
    revision: row.revision,
    reason: state.value.suspendReason,
    idempotencyKey: newIdempotencyKey(),
  });
}

/** 重试可重试的停用失败：复用挂起意向里的幂等键与 If-Match。 */
function retrySuspend() {
  const intent = state.value.suspendWrite;
  if (intent === null) return;
  sendSuspend(intent);
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
        <h2>账号目录</h2>
        <p class="sub">
          数据源 <code>GET {{ API_BASE_URL }}/admin/accounts</code>（契约 <code>listAdminUsers</code>，scope
          <code>accounts:read</code>）；停用走
          <code>POST {{ API_BASE_URL }}/admin/accounts/{id}/suspend</code>（契约 <code>suspendUser</code>，scope
          <code>accounts:suspend</code>）。注销/恢复等其它写操作本页仍不提供。
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
      <p v-if="state.suspendScopeWarning" class="banner warn">
        当前会话的 scope 列表里没有 <code>accounts:suspend</code>：停用按钮已禁用（服务端也会回
        <code>403 SCOPE_DENIED</code>），本页不伪造写权限。
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

      <div v-if="suspendTarget" class="suspend-confirm" role="dialog" aria-label="确认停用账号">
        <header>
          <strong>确认停用账号</strong>
          <span class="mono" :title="suspendTarget.id">{{ suspendTarget.id }}</span>
        </header>
        <p class="hint">
          将停用 <strong>{{ suspendTarget.displayName }}</strong>（当前 revision
          <code>{{ suspendTarget.revision }}</code>，If-Match <code>{{ suspendTarget.etag }}</code>）。
          服务端会在单事务内完成：写 state、递增 auth_epoch、撤销会话、写审计。
        </p>
        <label class="reason">
          <span>停用理由（必填，进服务端审计；契约 <code>ReasonInput.reason</code> 1–500 字符）</span>
          <input
            :value="state.suspendReason"
            name="suspend_reason"
            type="text"
            maxlength="500"
            placeholder="例如：违反社区规范，按运营裁定停用"
            :disabled="suspendSaving"
            @input="dispatch({ type: 'SET_SUSPEND_REASON', value: $event.target.value })"
          />
        </label>
        <p v-if="suspendProblem" class="foot warn-text">理由不可用：{{ suspendProblem }}</p>
        <div class="actions">
          <button class="primary" type="button" :disabled="suspendSaving || suspendProblem !== null || busy" @click="confirmSuspend">
            {{ suspendSaving ? '停用中…' : '确认停用' }}
          </button>
          <button class="ghost" type="button" :disabled="suspendSaving" @click="cancelSuspend">取消</button>
        </div>
      </div>

      <div v-if="suspendSaved" class="banner ok" role="status">
        停用已生效：服务端返回了新的 <code>revision</code>，列表正在重新读取（不是本地推断）。
        <button class="link" type="button" @click="dismissSuspendResult">知道了</button>
      </div>

      <div v-if="suspendFailureView" class="banner error" role="alert">
        <strong>{{ suspendFailureView.title }}</strong>
        <span>{{ suspendFailureView.detail }}</span>
        <span v-if="suspendFailureView.code" class="code">code={{ suspendFailureView.code }}</span>
        <span v-if="suspendFailureView.status !== null" class="code">status={{ suspendFailureView.status }}</span>
        <span class="actions">
          <button v-if="suspendFailureView.retriable" class="link" type="button" :disabled="busy" @click="retrySuspend">
            用同一幂等键重试
          </button>
          <button v-if="suspendFailureView.action === 'reload'" class="link" type="button" :disabled="busy" @click="refresh">
            重新读取后再试
          </button>
          <button v-if="suspendFailureView.action === 'sign_in'" class="link" type="button" @click="signOut">重新登录</button>
          <button class="link" type="button" :disabled="busy" @click="dismissSuspendResult">忽略</button>
        </span>
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
            <td class="right">
              <button
                v-if="row.state === 'active'"
                class="link danger"
                type="button"
                :disabled="!canOpenSuspend || busy"
                :title="canOpenSuspend ? '带 If-Match 与 Idempotency-Key 停用' : '需要 accounts:suspend 且列表已就绪（理由在确认框里填写）'"
                @click.stop="beginSuspend(row)"
              >
                停用
              </button>
              <button class="link" type="button">详情摘要</button>
            </td>
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
.signin label,
.suspend-confirm .reason {
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
.link.danger {
  color: #c53030;
}
.banner {
  margin: 0;
  padding: 0.6rem 0.8rem;
  border-radius: 8px;
  font-size: 0.88rem;
  line-height: 1.7;
}
.banner.warn {
  background: #fffbeb;
  border-left: 4px solid #b7791f;
}
.banner.ok {
  background: #f0fdf4;
  border-left: 4px solid #2f855a;
}
.banner.error {
  background: #fff5f5;
  border-left: 4px solid #c53030;
}
.banner .code {
  display: inline-block;
  margin-left: 0.5rem;
  font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
  font-size: 0.82rem;
  color: #742a2a;
}
.banner .actions {
  display: inline-flex;
  gap: 0.4rem;
  margin-left: 0.5rem;
}
.suspend-confirm {
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 0.9rem 1rem;
  background: #fff;
  display: grid;
  gap: 0.6rem;
}
.suspend-confirm header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
}
.suspend-confirm header strong {
  font-size: 1rem;
}
.suspend-confirm .reason {
  max-width: 34rem;
}
.suspend-confirm .actions {
  display: flex;
  gap: 0.5rem;
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
