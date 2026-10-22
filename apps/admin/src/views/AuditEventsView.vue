<script setup>
/**
 * 审计事件只读页（B5）。
 *
 * 只调用契约里存在的读面：GET {API_BASE_URL}/admin/audit-events
 * （operationId `listAuditEvents`，scope `audit:read`，参数只有 `cursor`／`limit`）。
 * 鉴权复用 `src/auth/session.ts` 的既有实现（Bearer + sessionStorage），本页不新造登录。
 * 纯逻辑都在 `src/lib/audit-events.mjs`（契约校验／失败分类／状态机），本组件只负责接到 DOM。
 *
 * 不做的事：不写审计记录、不给"人审通过"之类动作、不把空台账读成结论、
 * 不从 `request_id` 反推责任人（契约只给可选 actor，缺失时如实显示「未提供」）。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { API_BASE_URL, loadAdminSession, signInAdmin, signOutAdmin } from '../auth/session';
import {
  AUDIT_EVENTS_PATH,
  AUDIT_LIMIT_OPTIONS,
  AUDIT_SCOPE,
  actionOptions,
  appendAuditPage,
  canLoadMoreAudit,
  describeAudit,
  emptyAuditCollection,
  fetchAuditEventsPage,
  initialAuditState,
  reduceAudit,
  resultCounts,
  visibleAuditRows,
} from '../lib/audit-events.mjs';

const state = ref(initialAuditState());
const session = ref(null);
const loginName = ref('');
const password = ref('');
const busy = ref(false);

// 每次换会话/重载递增；晚到的旧响应一律丢弃（避免把上一会话的行画到当前会话）。
let requestSeq = 0;
let currentToken = null;

const view = computed(() => describeAudit(state.value));
const rows = computed(() => visibleAuditRows(state.value));
const options = computed(() => actionOptions(state.value));
const counts = computed(() => resultCounts(state.value));
const signedIn = computed(() => state.value.signedIn);
const canRetry = computed(() => view.value.canRetry === true);
const restartNeeded = computed(() => view.value.action === 'restart');
const canLoadMore = computed(() => canLoadMoreAudit(state.value));

function dispatch(action) {
  state.value = reduceAudit(state.value, action);
}

async function requestPage(cursor, { reset }) {
  const token = currentToken;
  if (token === null) {
    dispatch({
      type: 'LOAD_FAIL',
      failure: { ok: false, kind: 'signed_out', status: null, retriable: false, inContract: false, message: '' },
    });
    return;
  }
  const seq = ++requestSeq;
  busy.value = true;
  dispatch({ type: 'LOAD_START', reset });
  const result = await fetchAuditEventsPage({
    baseUrl: API_BASE_URL,
    token,
    cursor,
    limit: state.value.limit,
  });
  if (seq !== requestSeq) return; // 过期响应：丢弃，不改状态
  busy.value = false;
  if (result.ok) {
    const base = reset ? emptyAuditCollection() : state.value.collection;
    const { collection } = appendAuditPage(base, { cursor, page: result.page });
    dispatch({ type: 'LOAD_OK', collection });
  } else {
    dispatch({ type: 'LOAD_FAIL', failure: result });
  }
}

async function startSession(adminSession) {
  session.value = adminSession;
  currentToken = adminSession.accessToken;
  dispatch({ type: 'SIGNED_IN', scopes: adminSession.scopes });
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
        failure: { ok: false, kind: 'signed_out', status: null, retriable: false, inContract: false, message: '登录后未能读到会话详情' },
      });
      return;
    }
    busy.value = false;
    await startSession(refreshed);
  } catch (error) {
    busy.value = false;
    dispatch({
      type: 'SIGN_IN_FAILED',
      failure: {
        ok: false,
        kind: 'http_error',
        status: null,
        retriable: true,
        inContract: false,
        message: error instanceof Error ? error.message : '登录失败',
      },
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
  // 错误态、游标失效、以及当前失败后的重试，都回到第一页重读：续页游标不能复用。
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

function changeLimit(event) {
  const limit = Number(event.target.value);
  if (!Number.isFinite(limit)) return;
  dispatch({ type: 'SET_LIMIT', limit });
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
  <section class="audit">
    <header class="head">
      <div>
        <h2>审计事件（只读）</h2>
        <p class="sub">
          数据源 <code>GET {{ API_BASE_URL }}{{ AUDIT_EVENTS_PATH }}</code>（契约 <code>listAuditEvents</code>，scope
          <code>{{ AUDIT_SCOPE }}</code>）。只读台账，本页不写、不修改、不删除任何审计记录。
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
        当前会话的 scope 列表里没有 <code>{{ AUDIT_SCOPE }}</code>：请求大概率返回
        <code>403 SCOPE_DENIED</code>。以服务端返回为准，本页不猜权限。
      </p>

      <div class="toolbar">
        <label class="field">
          <span>动作（契约字段 <code>action</code>）</span>
          <select :value="state.actionFilter" :disabled="busy || state.collection.items.length === 0" @change="dispatch({ type: 'SET_ACTION_FILTER', value: $event.target.value })">
            <option v-for="option in options" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
        </label>
        <label class="field">
          <span>每页条数</span>
          <select :value="String(state.limit)" :disabled="busy" @change="changeLimit">
            <option v-for="size in AUDIT_LIMIT_OPTIONS" :key="size" :value="String(size)">{{ size }}</option>
          </select>
        </label>
        <button class="ghost" type="button" :disabled="busy" @click="refresh">重新读取</button>
        <button v-if="canLoadMore" class="primary" type="button" :disabled="busy" @click="loadMore">加载下一页</button>
      </div>
      <p class="scope-note">
        动作筛选<strong>仅在已加载的 {{ state.collection.items.length }} 条内</strong>生效：后端该接口只有
        <code>cursor</code>／<code>limit</code> 两个参数，<strong>没有</strong>
        <code>event_type</code>、主体或时间范围之类的过滤参数。
      </p>

      <div class="status" :class="view.tone" role="status">
        <strong>{{ view.title }}</strong>
        <span>{{ view.detail }}</span>
        <code v-if="view.errorCode" class="code-chip">{{ view.errorCode }}</code>
        <button v-if="canRetry || restartNeeded" class="link" type="button" :disabled="busy" @click="retry">
          {{ restartNeeded ? '从第一页重读' : '重试' }}
        </button>
      </div>

      <p v-if="state.collection.items.length > 0" class="counts">
        已加载结果分布：<span class="pill ok">已接受 {{ counts.accepted }}</span>
        <span class="pill warn">已拒绝 {{ counts.denied }}</span>
        <span class="pill danger">失败 {{ counts.failed }}</span>
      </p>

      <table v-if="rows.length > 0" class="grid">
        <thead>
          <tr>
            <th>时间（created_at）</th>
            <th>动作（action）</th>
            <th>scope</th>
            <th>结果</th>
            <th>目标（target_ref）</th>
            <th>操作者（actor）</th>
            <th>变更（before → after）</th>
            <th>request_id</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <template v-for="row in rows" :key="row.id">
            <tr :class="{ selected: row.id === state.expandedId }" @click="dispatch({ type: 'TOGGLE_ROW', id: row.id })">
              <td class="mono">{{ row.createdAt }}</td>
              <td class="mono">{{ row.action }}</td>
              <td class="mono">{{ row.scope }}</td>
              <td><span class="pill" :class="row.resultTone">{{ row.resultLabel }}</span></td>
              <td class="mono" :title="row.targetLabel">{{ row.targetLabel }}</td>
              <td class="mono" :title="row.actorLabel">
                {{ row.actor === null ? '—' : row.shortActor }}…
              </td>
              <td class="mono">{{ row.changeLabel === null ? '—' : row.changeLabel }}</td>
              <td class="mono" :title="row.requestId">{{ row.shortRequestId }}…</td>
              <td class="right">
                <button class="link" type="button">{{ row.id === state.expandedId ? '收起' : '展开原文' }}</button>
              </td>
            </tr>
            <tr v-if="row.id === state.expandedId" :key="`${row.id}-detail`" class="detail">
              <td colspan="9">
                <dl>
                  <dt>id</dt>
                  <dd class="mono">{{ row.id }}</dd>
                  <dt>action</dt>
                  <dd class="mono">{{ row.action }}</dd>
                  <dt>scope</dt>
                  <dd class="mono">{{ row.scope }}</dd>
                  <dt>result</dt>
                  <dd>{{ row.resultLabel }}（<code>{{ row.result }}</code>）</dd>
                  <dt>reason_code</dt>
                  <dd class="mono">{{ row.reasonCode }}</dd>
                  <dt>request_id</dt>
                  <dd class="mono">{{ row.requestId }}</dd>
                  <dt>target_ref</dt>
                  <dd class="mono">{{ row.targetLabel }}</dd>
                  <dt>created_at</dt>
                  <dd class="mono">{{ row.createdAt }}</dd>
                  <dt>actor</dt>
                  <dd class="mono">{{ row.actorLabel }}</dd>
                  <dt>target_hint</dt>
                  <dd class="mono">{{ row.targetHint === null ? '—' : row.targetHint }}</dd>
                  <dt>before_value → after_value</dt>
                  <dd>{{ row.changeLabel === null ? '—（非开关变更行）' : row.changeLabel }}</dd>
                </dl>
                <p class="missing">
                  <strong>操作者与前后值：</strong>契约 <code>AuditEvent</code> 自 R29-S5 起为这四项
                  （<code>actor</code> / <code>target_hint</code> / <code>before_value</code> / <code>after_value</code>）
                  留了<strong>可选且可空</strong>的位置；开关变更行会带上它们，历史行可能为
                  <code>null</code>——此处如实显示「未提供」，仍<strong>不</strong>据
                  <code>request_id</code> 反推责任人。
                </p>
              </td>
            </tr>
          </template>
        </tbody>
      </table>

      <p v-if="state.collection.duplicates > 0" class="foot">
        续页中有 {{ state.collection.duplicates }} 条与已加载条目的 <code>id</code> 重复，已去重（未重复计数）。
      </p>
      <p v-if="state.collection.warnings > 0" class="foot">
        刷新过程中共忽略 {{ state.collection.warnings }} 处契约外字段（不展示、不推断含义）。
      </p>
      <p v-if="state.collection.cycle" class="foot warn-text">
        服务端把请求游标原样返回，已停止续页以防死循环。
      </p>
      <p class="foot">
        游标有效期 15 分钟；台账在分页期间发生变化时服务端返回
        <code>400 INVALID_CURSOR</code>，本页会提示"从第一页重读"。
      </p>
    </template>

    <aside v-if="state.collection.items.length === 0" class="note">
      本页没有可展示的行；空台账不等于"没有后台操作发生过"，只表示当前游标位置读到 0 条。
    </aside>
  </section>
</template>

<style scoped>
.audit {
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
.missing,
.counts {
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
input,
select {
  padding: 0.45rem 0.6rem;
  border: 1px solid #cbd5e0;
  border-radius: 8px;
  font: inherit;
  background: #fff;
}
.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 0.5rem;
}
.field {
  display: grid;
  gap: 0.25rem;
  font-size: 0.82rem;
  color: #4a5568;
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
.code-chip {
  font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
  font-size: 0.8rem;
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  padding: 0.05rem 0.35rem;
}
.grid {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}
.grid th,
.grid td {
  text-align: left;
  padding: 0.5rem 0.6rem;
  border-bottom: 1px solid #e2e8f0;
  vertical-align: top;
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
.grid tr.detail,
.grid tr.detail:hover {
  background: #f8fafc;
  cursor: auto;
}
.detail dl {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.25rem 1rem;
  margin: 0;
  font-size: 0.86rem;
}
.detail dt {
  font-weight: 600;
}
.detail dd {
  margin: 0;
  word-break: break-all;
}
.right {
  text-align: right;
}
.mono {
  font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
  font-size: 0.84rem;
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
.warn-text {
  color: #975a16;
}
</style>
