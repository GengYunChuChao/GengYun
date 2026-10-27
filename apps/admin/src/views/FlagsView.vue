<script setup>
/**
 * 功能开关页（GY-I18 / B1）。
 *
 * 只调用契约里存在的两个接口：
 * - GET `{API_BASE_URL}/admin/feature-flags`（operationId `listFlags`，scope `flags:read`）
 * - PUT `{API_BASE_URL}/admin/feature-flags/{key}`（operationId `setFlag`，scope `flags:write`；
 *   必带 `If-Match` 强 ETag 与 `Idempotency-Key`，body 为 `{ enabled, reason }`）
 *
 * 鉴权复用 `src/auth/session.ts` 的既有实现（Bearer + sessionStorage），本页不新造登录。
 * 纯逻辑都在 `src/lib/flags-*.mjs`，本组件只负责把状态机接到 DOM。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { API_BASE_URL, loadAdminSession, signInAdmin, signOutAdmin } from '../auth/session';
import { fetchFlagsPage, newIdempotencyKey, putFlag } from '../lib/flags-api.mjs';
import {
  canLoadMore,
  canWrite,
  describe,
  describeWriteFailure,
  detailOf,
  initialState,
  reasonProblemOf,
  reduce,
  rowViews,
} from '../lib/flags-view-model.mjs';

const state = ref(initialState());
const session = ref(null);
const loginName = ref('');
const password = ref('');
const busy = ref(false);

// 每次换会话/重载/写入递增；晚到的旧响应一律丢弃（避免把上一会话的数据画到当前会话）。
let requestSeq = 0;
let currentToken = null;

const view = computed(() => describe(state.value));
const rows = computed(() => rowViews(state.value));
const detail = computed(() => detailOf(state.value));
const writeView = computed(() => describeWriteFailure(state.value.writeFailure));
const writeSucceeded = computed(() => state.value.writeStatus === 'saved');
const reasonErr = computed(() => reasonProblemOf(state.value));
const writable = computed(() => canWrite(state.value));
const signedIn = computed(() => state.value.signedIn);
const moreAvailable = computed(() => canLoadMore(state.value));
const retryRead = computed(() => view.value.canRetry === true);
const reloadNeeded = computed(() => view.value.action === 'reload');

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
  const result = await fetchFlagsPage({ baseUrl: API_BASE_URL, token, cursor });
  if (seq !== requestSeq) return; // 过期响应：丢弃，不改状态
  busy.value = false;
  if (result.ok) {
    dispatch({ type: 'LOAD_OK', flags: result.page.items, nextCursor: result.page.nextCursor, reset });
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
 * 发一次写入。`intent.idempotencyKey` 由调用方持有：**重试必须复用同一个键**，
 * 否则服务端会把重试当成第二次写（`Idempotency-Key` 与 body 的绑定在服务端核验）。
 */
async function sendWrite(intent) {
  const token = currentToken;
  if (token === null) {
    dispatch({ type: 'WRITE_FAIL', failure: { ok: false, kind: 'signed_out', status: null, retriable: false } });
    return;
  }
  const seq = ++requestSeq;
  busy.value = true;
  dispatch({
    type: 'WRITE_START',
    key: intent.key,
    enabled: intent.enabled,
    revision: intent.revision,
    reason: intent.reason,
    idempotencyKey: intent.idempotencyKey,
  });
  const result = await putFlag({
    baseUrl: API_BASE_URL,
    token,
    key: intent.key,
    enabled: intent.enabled,
    reason: intent.reason,
    revision: intent.revision,
    idempotencyKey: intent.idempotencyKey,
  });
  if (seq !== requestSeq) return; // 过期响应：丢弃
  busy.value = false;
  if (result.ok) {
    dispatch({ type: 'WRITE_OK', flag: result.flag });
  } else {
    dispatch({ type: 'WRITE_FAIL', failure: result });
  }
}

/** 切换一行的布尔值：If-Match 取自**已加载那一行**的 revision，不猜。 */
function toggle(row) {
  const flag = state.value.flags.find((item) => item.key === row.key);
  if (flag === undefined) return;
  sendWrite({
    key: flag.key,
    enabled: !flag.enabled,
    revision: flag.revision,
    reason: state.value.reason,
    idempotencyKey: newIdempotencyKey(),
  });
}

/** 重试可重试的写入失败：复用挂起意向里的幂等键与 If-Match。 */
function retryWrite() {
  const intent = state.value.write;
  if (intent === null) return;
  sendWrite({
    key: intent.key,
    enabled: intent.enabled,
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
  <section class="flags">
    <header class="head">
      <div>
        <h2>功能开关</h2>
        <p class="sub">
          数据源 <code>GET {{ API_BASE_URL }}/admin/feature-flags</code>（契约 <code>listFlags</code>，scope
          <code>flags:read</code>）；切换走
          <code>PUT {{ API_BASE_URL }}/admin/feature-flags/{key}</code>（契约 <code>setFlag</code>，scope
          <code>flags:write</code>）。
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
      <p v-if="!state.hasReadScope" class="banner warn">
        当前会话的 scope 列表里没有 <code>flags:read</code>：读取大概率返回
        <code>403 SCOPE_DENIED</code>。以服务端返回为准，本页不猜权限。
      </p>
      <p v-if="!state.hasWriteScope" class="banner warn">
        当前会话没有 <code>flags:write</code>：切换按钮已禁用（服务端也会回 <code>403 SCOPE_DENIED</code>），
        本页不伪造写权限。
      </p>

      <div class="toolbar">
        <label class="reason">
          <span>变更理由（必填，进服务端审计；契约 <code>FlagInput.reason</code> 1–500 字符）</span>
          <input
            :value="state.reason"
            name="reason"
            type="text"
            maxlength="500"
            placeholder="例如：按运营确认关闭用户投稿"
            @input="dispatch({ type: 'SET_REASON', value: $event.target.value })"
          />
        </label>
        <button class="ghost" type="button" :disabled="busy" @click="reload">重新读取</button>
        <button v-if="moreAvailable" class="primary" type="button" :disabled="busy" @click="loadMore">加载下一页</button>
      </div>
      <p v-if="reasonErr" class="foot warn-text">理由不可用：{{ reasonErr }}</p>

      <div class="status" :class="view.tone" :role="view.tone === 'error' ? 'alert' : 'status'">
        <strong>{{ view.title }}</strong>
        <span>{{ view.detail }}</span>
        <button v-if="retryRead || reloadNeeded" class="link" type="button" :disabled="busy" @click="reload">
          {{ reloadNeeded ? '重新读取' : '重试' }}
        </button>
      </div>

      <div v-if="writeSucceeded" class="banner ok" role="status">
        写入已生效：服务端返回了新的 <code>revision</code>，表格已用响应值更新（不是本地推断）。
        <button class="link" type="button" @click="dispatch({ type: 'WRITE_CLEAR' })">知道了</button>
      </div>

      <div v-if="writeView" class="banner error" role="alert">
        <strong>{{ writeView.title }}</strong>
        <span>{{ writeView.detail }}</span>
        <span v-if="writeView.code" class="code">code={{ writeView.code }}</span>
        <span v-if="writeView.status !== null" class="code">status={{ writeView.status }}</span>
        <span class="actions">
          <button v-if="writeView.retriable" class="link" type="button" :disabled="busy" @click="retryWrite">
            用同一幂等键重试
          </button>
          <button v-if="writeView.action === 'reload'" class="link" type="button" :disabled="busy" @click="reload">
            重新读取后再试
          </button>
          <button v-if="writeView.action === 'sign_in'" class="link" type="button" @click="signOut">重新登录</button>
          <button class="link" type="button" :disabled="busy" @click="dispatch({ type: 'WRITE_CLEAR' })">忽略</button>
        </span>
      </div>

      <table v-if="rows.length > 0" class="grid">
        <thead>
          <tr>
            <th>key</th>
            <th>值</th>
            <th>revision</th>
            <th>If-Match</th>
            <th>本会话写权限</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in rows"
            :key="row.key"
            :class="{ selected: row.key === state.selectedKey }"
            @click="dispatch({ type: 'SELECT', key: row.key })"
          >
            <td class="mono">{{ row.key }}</td>
            <td><span class="pill" :class="row.tone">{{ row.enabledLabel }}</span></td>
            <td class="mono">{{ row.revisionLabel }}</td>
            <td class="mono">{{ row.etag }}</td>
            <td>
              <span class="pill" :class="row.hasWriteScope ? 'ok' : 'danger'">
                {{ row.hasWriteScope ? '有 flags:write' : '无 flags:write' }}
              </span>
            </td>
            <td class="right">
              <button
                class="ghost small"
                type="button"
                :disabled="!writable || row.writing"
                :title="writable ? '带 If-Match 与 Idempotency-Key 写入' : '需要 flags:write 与合法的变更理由'"
                @click.stop="toggle(row)"
              >
                {{ row.writing ? '写入中…' : row.enabled ? '切换为关闭' : '切换为启用' }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>

      <p class="foot">
        说明：契约 <code>Flag</code> 只有 <code>key</code>／<code>enabled</code>／<code>revision</code> 三个字段
        （<code>additionalProperties: false</code>），<strong>没有 scope 字段</strong>；上表「本会话写权限」是
        <em>当前后台会话</em>的 scope（来自 <code>GET /admin/auth/session</code>），不是开关自身的属性。
        <code>If-Match</code> 由 <code>revision</code> 按服务端 <code>etagOf()</code> 口径推出（形如
        <code>"3"</code>），列表响应没有 ETag 头。
      </p>
      <p class="foot">
        服务端幂等语义：同一 <code>Idempotency-Key</code> + 同一路径 + 同一 body 的重试会收敛到同一次写入；
        换了 body 还用旧键会得到 <code>409 IDEMPOTENCY_CONFLICT</code>。切换按钮每次点击都生成新键，
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
.flags {
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
