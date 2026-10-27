<script setup>
/**
 * AI 作业台页（issue #18：后台此前对 `/admin/jobs` 零消费方，本页是唯一消费方）。
 *
 * 只调用契约里存在的两个接口：
 * - GET  `{API_BASE_URL}/admin/jobs`（operationId `listAdminJobs`，scope `jobs:read`，游标分页）
 * - POST `{API_BASE_URL}/admin/jobs/{id}/cancel`（operationId `cancelAdminJob`，scope `jobs:cancel`；
 *   必带 `If-Match` 强 ETag（取**已加载那一行**的 revision）与 `Idempotency-Key`，body 为 `{ reason }`）
 *
 * 鉴权复用 `src/auth/session.ts` 的既有实现（Bearer + sessionStorage），本页不新造登录。
 * 登录失败时 `signedIn` 仍是 false、页面停在未登录表单，因此失败结果渲染在**表单内**
 * （`describeSignInFailure()` 的白名单文案；凭据被拒／会话详情读不到两类可区分），
 * 输入与提交按钮保留，可直接再次提交；原始异常 message 与服务端 error.code 一律不上屏。
 * 纯逻辑都在 `src/lib/jobs-api.mjs`（接口封装 + 页面状态机），本组件只负责把状态机接到 DOM。
 *
 * 状态语义（契约 `JobState`）：终态 = succeeded／uncertain／failed／timed_out／cancelled，
 * 这些行不再有取消语义，行内按钮禁用；只有 queued／running 会发出取消请求。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { API_BASE_URL, loadAdminSession, signInAdmin, signOutAdmin } from '../auth/session';
import {
  canCancelNow,
  canLoadMoreJobs,
  cancelJob,
  describeFailure,
  describeJobs,
  describeSignInFailure,
  initialJobsState,
  jobDetailOf,
  jobRowViews,
  listJobs,
  newIdempotencyKey,
  reasonProblem,
  reduceJobs,
  signInFailureOf,
} from '../lib/jobs-api.mjs';

const state = ref(initialJobsState());
const session = ref(null);
const loginName = ref('');
const password = ref('');
const busy = ref(false);

// 每次换会话/重载/取消递增；晚到的旧响应一律丢弃（避免把上一会话的数据画到当前会话）。
let requestSeq = 0;
let currentToken = null;

const view = computed(() => describeJobs(state.value));
// 只有失败（error／stale）用 alert 语义：403 缺 scope 必须能被读屏当错误播报。
// 加载中与正常读数是 role="status"；空态是另一个独立元素（也 role="status"），
// 与失败提示互斥，结构上不可能同时出现 —— 403 不会被渲染成「暂无作业」。
const statusRole = computed(() => (view.value.tone === 'error' || view.value.tone === 'stale' ? 'alert' : 'status'));
const rows = computed(() => jobRowViews(state.value));
const detail = computed(() => jobDetailOf(state.value));
const writeView = computed(() => describeFailure(state.value.writeFailure));
const writeSucceeded = computed(() => state.value.writeStatus === 'saved');
const receipt = computed(() => state.value.receipt);
const reasonErr = computed(() => reasonProblem(state.value.reason));
const cancelable = computed(() => canCancelNow(state.value));
const signedIn = computed(() => state.value.signedIn);
// 登录失败时 signedIn 仍为 false、页面停在未登录表单：失败结果必须渲染在**表单内**（白名单文案）。
const signInNotice = computed(() => describeSignInFailure(state.value.failure));
const moreAvailable = computed(() => canLoadMoreJobs(state.value));
const retryRead = computed(() => view.value.canRetry === true);
const reloadNeeded = computed(() => view.value.action === 'reload');

function dispatch(action) {
  state.value = reduceJobs(state.value, action);
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
  const result = await listJobs({ baseUrl: API_BASE_URL, token, cursor });
  if (seq !== requestSeq) return; // 过期响应：丢弃，不改状态
  busy.value = false;
  if (result.ok) {
    dispatch({ type: 'LOAD_OK', jobs: result.page.items, nextCursor: result.page.nextCursor, reset });
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
      busy.value = false;
      // 会话详情读失败：登录态不成立（不伪造），失败结果渲染回未登录表单。
      dispatch({ type: 'SIGN_IN_FAILED', failure: { ok: false, kind: 'signin_session_unreadable', status: null, retriable: true } });
      return;
    }
    busy.value = false;
    await startSession(refreshed);
  } catch (error) {
    busy.value = false;
    // 归类成安全状态后再入状态机：只保留 kind（不透传异常 message／服务端 error.code）。
    dispatch({ type: 'SIGN_IN_FAILED', failure: signInFailureOf(error) });
  }
}

async function signOut() {
  ++requestSeq;
  await signOutAdmin();
  session.value = null;
  currentToken = null;
  dispatch({ type: 'SIGN_OUT' });
}

/** 读面重试/重读：错误态与修订冲突都回到第一页重读（旧游标不能复用）。 */
function reload() {
  requestPage(null, { reset: true });
}

function loadMore() {
  const cursor = state.value.nextCursor;
  if (cursor === null) return;
  requestPage(cursor, { reset: false });
}

/**
 * 发一次取消。`intent.idempotencyKey` 由调用方持有：**重试必须复用同一个键**，
 * 否则服务端会把重试当成第二次取消。`intent.revision` 取自已加载那一行，不猜。
 */
async function sendCancel(intent) {
  const token = currentToken;
  if (token === null) {
    dispatch({ type: 'WRITE_FAIL', failure: { ok: false, kind: 'signed_out', status: null, retriable: false } });
    return;
  }
  const seq = ++requestSeq;
  busy.value = true;
  dispatch({
    type: 'WRITE_START',
    id: intent.id,
    revision: intent.revision,
    reason: intent.reason,
    idempotencyKey: intent.idempotencyKey,
  });
  const result = await cancelJob({
    baseUrl: API_BASE_URL,
    token,
    id: intent.id,
    revision: intent.revision,
    reason: intent.reason,
    idempotencyKey: intent.idempotencyKey,
  });
  if (seq !== requestSeq) return; // 过期响应：丢弃
  busy.value = false;
  if (result.ok) {
    // 局部刷新：只用服务端返回的那一行替换（不做整表重载）。
    dispatch({
      type: 'WRITE_OK',
      job: result.job,
      receipt: {
        requestId: result.requestId,
        etag: result.etag,
        ifMatch: result.sent['if-match'],
        idempotencyKey: result.sent['idempotency-key'],
      },
    });
  } else {
    dispatch({ type: 'WRITE_FAIL', failure: result });
  }
}

/** 取消一行：If-Match 取自该行的 revision，幂等键每次点击新生成。 */
function cancel(row) {
  if (!row.cancelable || !cancelable.value) return;
  sendCancel({
    id: row.id,
    revision: Number.parseInt(row.revisionLabel, 10),
    reason: state.value.reason,
    idempotencyKey: newIdempotencyKey(),
  });
}

/** 重试可重试的失败：复用挂起意向里的幂等键与 If-Match（若该行已被改动，服务端会回 409 让页面重读）。 */
function retryCancel() {
  const intent = state.value.write;
  if (intent === null) return;
  sendCancel({
    id: intent.id,
    revision: intent.revision,
    reason: intent.reason,
    idempotencyKey: intent.idempotencyKey,
  });
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
  <section class="jobs">
    <header class="head">
      <div>
        <h2>作业台</h2>
        <p class="sub">
          数据源 <code>GET {{ API_BASE_URL }}/admin/jobs</code>（契约 <code>listAdminJobs</code>，scope
          <code>jobs:read</code>，游标分页）；取消走
          <code>POST {{ API_BASE_URL }}/admin/jobs/{id}/cancel</code>（契约 <code>cancelAdminJob</code>，scope
          <code>jobs:cancel</code>，必带 <code>If-Match</code> 与 <code>Idempotency-Key</code>）。
        </p>
      </div>
      <button v-if="signedIn" class="ghost" type="button" data-testid="jobs-sign-out" :disabled="busy" @click="signOut">退出登录</button>
    </header>

    <form v-if="!signedIn" class="signin" @submit.prevent="submitSignIn">
      <p class="hint">
        未登录。登录走既有 <code>POST /admin/auth/session</code>（<code>src/auth/session.ts</code>），
        令牌只存 sessionStorage，不写入 URL。
      </p>
      <div v-if="signInNotice" class="banner error" role="alert">
        <strong>{{ signInNotice.title }}</strong>
        <span>{{ signInNotice.detail }}</span>
      </div>
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
      <p v-if="!state.hasReadScope" class="banner warn">
        当前会话的 scope 列表里没有 <code>jobs:read</code>：读取大概率返回
        <code>403 SCOPE_DENIED</code>。以服务端返回为准，本页不猜权限。
      </p>
      <p v-if="!state.hasCancelScope" class="banner warn">
        当前会话没有 <code>jobs:cancel</code>：取消按钮已禁用（服务端也会回 <code>403 SCOPE_DENIED</code>），
        本页不伪造取消权限。
      </p>

      <div class="toolbar">
        <label class="reason">
          <span>取消理由（必填，进服务端审计；契约 <code>ReasonInput.reason</code> 1–500 字符）</span>
          <input
            :value="state.reason"
            name="reason"
            type="text"
            maxlength="500"
            placeholder="例如：作业卡在排队，按运维确认取消"
            @input="dispatch({ type: 'SET_REASON', value: $event.target.value })"
          />
        </label>
        <button class="ghost" type="button" :disabled="busy" @click="reload">重新读取</button>
        <button v-if="moreAvailable" class="primary" type="button" :disabled="busy" @click="loadMore">加载下一页</button>
      </div>
      <p v-if="reasonErr" class="foot warn-text">取消理由不可用：{{ reasonErr }}</p>

      <!--
        错误与空态**不能混**：错误（含 403 缺 scope）是 role="alert" 的明确提示，
        空数据是 role="status" 的空态。两者是互斥的两个元素，结构上不可能同时出现。
      -->
      <div
        v-if="view.tone !== 'empty'"
        class="status"
        :class="view.tone"
        :role="statusRole"
        data-testid="jobs-status"
      >
        <strong>{{ view.title }}</strong>
        <span>{{ view.detail }}</span>
        <code v-if="view.errorCode" class="code" data-testid="jobs-error-code">{{ view.errorCode }}</code>
        <button
          v-if="retryRead || reloadNeeded"
          class="link"
          type="button"
          data-testid="jobs-retry"
          :disabled="busy"
          @click="reload"
        >
          {{ reloadNeeded ? '重新读取' : '重试' }}
        </button>
      </div>

      <aside v-else class="note" role="status" data-testid="jobs-empty">
        <strong>{{ view.title }}</strong>
        <span>{{ view.detail }}</span>
        <button class="link" type="button" data-testid="jobs-empty-reload" :disabled="busy" @click="reload">
          重新读取
        </button>
      </aside>

      <div v-if="writeSucceeded" class="banner ok" role="status">
        取消已生效：服务端返回了该行的新 <code>state</code>／<code>revision</code>，表格已用响应值局部刷新
        （不是本地推断、不整表重载）。
        <span v-if="receipt" class="code">etag={{ receipt.etag }}</span>
        <span v-if="receipt && receipt.requestId" class="code">request_id={{ receipt.requestId }}</span>
        <button class="link" type="button" @click="dispatch({ type: 'WRITE_CLEAR' })">知道了</button>
      </div>

      <div v-if="writeView" class="banner error" role="alert">
        <strong>{{ writeView.title }}</strong>
        <span>{{ writeView.detail }}</span>
        <span v-if="writeView.status !== null" class="code">status={{ writeView.status }}</span>
        <span class="actions">
          <button v-if="writeView.retriable" class="link" type="button" :disabled="busy" @click="retryCancel">
            用同一幂等键重试
          </button>
          <button v-if="writeView.action === 'reload'" class="link" type="button" :disabled="busy" @click="reload">
            重新读取后再试
          </button>
          <button v-if="writeView.action === 'sign_in'" class="link" type="button" @click="signOut">重新登录</button>
          <button class="link" type="button" :disabled="busy" @click="dispatch({ type: 'WRITE_CLEAR' })">忽略</button>
        </span>
      </div>

      <table v-if="rows.length > 0" class="grid" data-testid="jobs-table">
        <thead>
          <tr>
            <th>kind</th>
            <th>state</th>
            <th>error_code</th>
            <th>created_at</th>
            <th>deadline_at</th>
            <th>If-Match</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in rows"
            :key="row.id"
            data-testid="jobs-row"
            :class="{ selected: row.selected }"
            tabindex="0"
            :aria-label="`选中作业 ${row.kind}（${row.id}）`"
            @click="dispatch({ type: 'SELECT', id: row.id })"
            @keydown.enter.self.prevent="dispatch({ type: 'SELECT', id: row.id })"
            @keydown.space.self.prevent="dispatch({ type: 'SELECT', id: row.id })"
          >
            <td class="mono" :title="row.targetRef">{{ row.kind }}</td>
            <td><span class="pill" :class="row.tone" :title="row.stateTitle">{{ row.state }}</span></td>
            <td class="mono">{{ row.errorCode }}</td>
            <td class="mono">{{ row.createdAt }}</td>
            <td class="mono">{{ row.deadlineAt }}</td>
            <td class="mono">{{ row.etag }}</td>
            <td class="right">
              <button
                class="ghost small"
                type="button"
                :disabled="!row.cancelable || row.writing || !cancelable"
                :title="row.cancelable ? (cancelable ? '带 If-Match 与 Idempotency-Key 取消' : '需要 jobs:cancel 与合法的取消理由') : row.cancelBlockedReason"
                @click.stop="cancel(row)"
              >
                {{ row.writing ? '取消中…' : row.terminal ? '已终态' : '取消' }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>

      <p class="foot">
        说明：契约 <code>AdminJob</code> 只有 <code>id</code>／<code>revision</code>／<code>kind</code>／
        <code>target_ref</code>／<code>state</code>／<code>deadline_at</code>／<code>created_at</code>／
        <code>error_code</code>／<code>result</code> 九个字段（<code>additionalProperties: false</code>）；
        <code>created_at</code>／<code>deadline_at</code> 原样展示，不本地化、不重排时区。
        <code>If-Match</code> 由该行的 <code>revision</code> 按服务端 <code>etagOf()</code> 口径推出（形如
        <code>"3"</code>），列表响应没有 ETag 头。
      </p>
      <p class="foot">
        终态语义：<code>succeeded</code>／<code>uncertain</code>／<code>failed</code>／<code>timed_out</code>／
        <code>cancelled</code> 的行按钮禁用（契约没有 <code>completed</code>；<code>uncertain</code> 是「结果未定」，
        不能当成成功）。只有 <code>queued</code>／<code>running</code> 会真的发出取消请求。
      </p>
      <p class="foot">
        服务端幂等语义：同一 <code>Idempotency-Key</code> + 同一路径 + 同一 body 的重试会收敛到同一次取消；
        换了 body 还用旧键会得到 <code>409 IDEMPOTENCY_CONFLICT</code>。行内按钮每次点击都生成新键，
        只有面板里的「用同一幂等键重试」会复用旧键。
      </p>
    </template>

    <aside v-if="detail" class="summary">
      <header>
        <h3>{{ detail.title }}</h3>
        <button class="link" type="button" @click="dispatch({ type: 'CLOSE_DETAIL' })">关闭</button>
      </header>
      <dl>
        <template v-for="field in detail.fields" :key="field.label">
          <dt>{{ field.label }}</dt>
          <dd class="mono">{{ field.value }}</dd>
        </template>
      </dl>
      <p class="missing">读面未提供：{{ detail.missing.join('、') }}。</p>
      <p class="note">{{ detail.note }}</p>
    </aside>
  </section>
</template>

<style scoped>
.jobs {
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
.reason {
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
  align-items: flex-end;
  gap: 0.5rem;
}
.reason {
  flex: 1 1 20rem;
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
.ghost.small {
  padding: 0.25rem 0.6rem;
  font-size: 0.85rem;
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
  line-height: 1.6;
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
.banner.ok .code {
  color: #22543d;
}
.banner .actions {
  display: inline-flex;
  gap: 0.4rem;
  margin-left: 0.5rem;
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
.status.empty {
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
.grid th {
  white-space: nowrap;
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
.pill.pending {
  background: #e6fffa;
  color: #234e52;
}
.pill.warn {
  background: #fef3c7;
  color: #744210;
}
.pill.off {
  background: #edf2f7;
  color: #2d3748;
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
