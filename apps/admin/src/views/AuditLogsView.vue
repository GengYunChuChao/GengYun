<script setup>
/**
 * R60 · 审计总台账（只读）页面。
 *
 * 只调 `GET /admin/audit-logs`（operationId `listAuditLogs`，x-scope `audit:read`）：
 * 分页读全部后台审计事件，按 action / entity / 时间范围（from、to）筛选。
 * ⛔ 本页不含任何写操作（授权、撤销、审批、拒绝、隐藏都不做）。
 * ⛔ 参数名照抄契约：是 `entity`，不是 `entity_type`。
 *
 * 表现约定：
 * - 403（缺 scope）显示明确提示 + 错误码，不伪装成空台账；
 * - 空数组显示空态；筛选下为空与「台账本身为空」分开说；
 * - 换筛选回第一页（后端游标与 [from,to,action,entity] 绑定，否则 INVALID_CURSOR）。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { API_BASE_URL, loadAdminSession, signInAdmin, signOutAdmin } from '../auth/session';
import {
  AUDIT_LOG_ACTIONS, AUDIT_LOG_ACTION_LABELS,
  AUDIT_LOG_ENTITIES, AUDIT_LOG_ENTITY_LABELS,
  AUDIT_LOGS_OPERATION_ID, AUDIT_LOGS_PATH, AUDIT_LOGS_SCOPE,
  AUDIT_MERGE_FILTER_ANY, AUDIT_MERGE_SOURCE_LABELS, AUDIT_MERGE_SOURCE_TASKS,
  auditLogLimitOptions, auditLogRows,
  auditMergeSourceOptions,
  describeAuditLogView,
  describeMergeSourceCounts,
  fetchAuditLogsPage,
  filterMergedRows,
  initialAuditLogState,
  loadAuditMergeSources,
  mergeAuditSources, reduceAuditLog,
} from '../lib/admin-audit-logs.mjs';

const state = ref(initialAuditLogState());
const session = ref(null);
const loginName = ref('');
const password = ref('');
const signInError = ref(null);
const busy = ref(false);
let requestSeq = 0;
let currentToken = null;

const view = computed(() => describeAuditLogView(state.value));
const rows = computed(() => auditLogRows(state.value));
const limitChoices = computed(() => auditLogLimitOptions(state.value.limit));
const signedIn = computed(() => state.value.signedIn);
const filterFailure = computed(() => state.value.filterFailure);

function dispatch(action) {
  state.value = reduceAuditLog(state.value, action);
}

/** 读一页。`reset` 为真时从第一页读；否则接 `collection.nextCursor`。 */
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
  const result = await fetchAuditLogsPage({
    baseUrl: API_BASE_URL,
    token: currentToken,
    cursor,
    limit: state.value.limit,
    filters: state.value.applied,
  });
  if (seq !== requestSeq) return;
  busy.value = false;
  if (result.ok) {
    dispatch({ type: 'LOAD_OK', cursor, page: result.page });
  } else {
    dispatch({ type: 'LOAD_FAIL', failure: result });
  }
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
  currentToken = null;
  session.value = null;
  busy.value = false;
  loginName.value = '';
  password.value = '';
  signInError.value = null;
  dispatch({ type: 'SIGN_OUT' });
  await signOutAdmin();
}

function setDraft(field, value) {
  dispatch({ type: 'SET_DRAFT_FILTER', field, value });
}

function changeLimit(value) {
  dispatch({ type: 'SET_LIMIT', limit: Number.parseInt(String(value), 10) });
  requestPage(null, { reset: true });
}

/** 应用筛选：先在本地按契约校验（不让后端 400 的输入出网），再无条件回第一页。 */
function applyFilters() {
  if (busy.value) return;
  dispatch({ type: 'FILTERS_APPLIED' });
  if (state.value.filterFailure !== null) return;
  requestPage(null, { reset: true });
}

function resetFilters() {
  setDraft('from', '');
  setDraft('to', '');
  setDraft('action', 'all');
  setDraft('entity', 'all');
  applyFilters();
}

function loadMore() {
  const cursor = state.value.collection.nextCursor;
  if (typeof cursor !== 'string' || cursor === '') return;
  requestPage(cursor, { reset: false });
}

function refresh() {
  requestPage(null, { reset: true });
}

function toggleRow(id) {
  dispatch({ type: 'TOGGLE_ROW', id });
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
});

// ------------------------------------------------ 三读面合并读数（GY-R68-C4）

/**
 * 把三条审计读面（`/admin/audit-logs` 全表、`/admin/audit-events` 内存、`/admin/flag-audit-events` 开关库）
 * 合并成**一张表**：按 `(created_at, id)` 降序，同一 `id` 跨源只留一行并标注全部来源。
 * 服务端零改动——三条读面都已在契约里，这里只是把三个既有 GET 的读数并到一页。
 *
 * ⛔ 按需读、不在挂载时读：本页既有渲染用例钉住「挂载只发 1 个请求」
 *    （`GET /admin/audit-logs?limit=20`），合并读数是**显式动作**，不抢首屏请求预算，
 *    也不动上面那张单源表格的任何既有语义。
 * ⛔ 失败隔离：任一源失败只把那一源写进 `failures`（单独 `role="alert"` 播报），另两源照常出数——
 *    整页判失败会把「另外两源明明有数」一起埋掉。
 */
const mergeTasks = AUDIT_MERGE_SOURCE_TASKS.map((task) => ({ ...task, label: AUDIT_MERGE_SOURCE_LABELS[task.source] }));
const mergeSourceOptions = auditMergeSourceOptions();
const mergeEntries = ref([]);
const mergeFilter = ref(AUDIT_MERGE_FILTER_ANY);
const mergeBusy = ref(false);
const mergeLoaded = ref(false);
let mergeSeq = 0;

const merged = computed(() => mergeAuditSources(mergeEntries.value));
const mergeRows = computed(() => filterMergedRows(merged.value.rows, mergeFilter.value));
const mergeSourceCounts = computed(() => describeMergeSourceCounts(merged.value));

/** 切来源筛选：只筛已读到的行，不重发请求（三源读数已在内存里）。 */
function setMergeFilter(value) {
  mergeFilter.value = value;
}

/** 读三源（并发；任一源抛错只记在那一源上），成功后把结果交给纯函数层合并。 */
async function loadMerged() {
  if (currentToken === null || mergeBusy.value) return;
  const seq = ++mergeSeq;
  mergeBusy.value = true;
  const entries = await loadAuditMergeSources({
    baseUrl: API_BASE_URL,
    token: currentToken,
    limit: state.value.limit,
  });
  if (seq !== mergeSeq) return;
  mergeBusy.value = false;
  if (currentToken === null) return;
  mergeEntries.value = entries;
  mergeLoaded.value = true;
}
</script>

<template>
  <section class="ledger">
    <header class="head">
      <h2>审计总台账（只读）</h2>
      <p class="sub">
        调用 <code>GET {{ AUDIT_LOGS_PATH }}</code>（operationId <code>{{ AUDIT_LOGS_OPERATION_ID }}</code>，scope
        <code>{{ AUDIT_LOGS_SCOPE }}</code>）：分页读全部后台审计事件，可按 action / entity / 时间范围筛选。
        本页只读，不提供授权、撤销、审批、拒绝、隐藏等写操作。
      </p>
      <button v-if="signedIn" class="ghost" type="button" data-testid="audit-log-sign-out" @click="signOut">退出登录</button>
    </header>

    <form v-if="!signedIn" class="signin" data-testid="audit-log-signin" @submit.prevent="submitSignIn">
      <h3>登录后台</h3>
      <p class="hint">审计总台账要求 scope <code>audit:read</code>；令牌只存 sessionStorage，不写日志、不进 URL。</p>
      <label class="field">
        <span>登录名</span>
        <input v-model="loginName" name="loginName" autocomplete="username" required />
      </label>
      <label class="field">
        <span>口令</span>
        <input v-model="password" name="password" type="password" autocomplete="current-password" required />
      </label>
      <button class="primary" type="submit" :disabled="busy" data-testid="audit-log-signin-submit">登录</button>
      <p v-if="signInError !== null" class="banner error" role="alert" data-testid="audit-log-signin-error">{{ signInError }}</p>
    </form>

    <template v-else>
      <p v-if="state.scopeWarning" class="banner warn" data-testid="audit-log-scope-warning">
        当前后台会话的 scope 列表里没有 <code>audit:read</code>：读取会被后端以 403 SCOPE_DENIED 拒绝，下面会如实显示，不静默空白。
      </p>

      <section class="merged" data-testid="audit-merge-panel">
        <header class="merged-head">
          <h3>三读面合并读数</h3>
          <p class="sub">
            同一张表读三条审计读面：<template v-for="(task, index) in mergeTasks" :key="task.source"
              ><span v-if="index > 0">、</span><code>GET {{ task.path }}</code>（<code>{{ task.operationId }}</code>，scope
              <code>{{ task.scope }}</code>，{{ task.label }}）</template
            >。按 <code>(created_at, id)</code> 降序合并，同一 <code>id</code> 跨源只留一行并标注全部来源；某一源读取失败时另外两源照常出数。
          </p>
          <div class="actions">
            <button class="primary" type="button" :disabled="mergeBusy" data-testid="audit-merge-load" @click="loadMerged">
              读取三源
            </button>
            <label class="field">
              <span>来源筛选</span>
              <select data-testid="audit-merge-filter" :value="mergeFilter" @change="setMergeFilter($event.target.value)">
                <option v-for="option in mergeSourceOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
              </select>
            </label>
          </div>
        </header>

        <p
          v-for="(failure, failureIndex) in merged.failures"
          :key="failure.source + '#' + failureIndex"
          class="banner error"
          role="alert"
          data-testid="audit-merge-failure"
          :data-source="failure.source"
        >
          <strong>{{ failure.sourceLabel }}读取失败：</strong><span>{{ failure.message }}</span>
        </p>

        <template v-if="mergeLoaded">
          <p class="counts" data-testid="audit-merge-counts">
            <span class="pill" :class="merged.failures.length > 0 ? 'warn' : 'ok'" data-testid="audit-merge-summary">{{ merged.summary }}</span>
            <span
              v-for="item in mergeSourceCounts"
              :key="item.source"
              class="pill"
              :class="item.failed ? 'warn' : ''"
              :data-testid="'audit-merge-count-' + item.source"
              >{{ item.text }}</span
            >
          </p>

          <table v-if="mergeRows.length > 0" class="grid merged-grid" data-testid="audit-merge-table">
            <thead>
              <tr>
                <th scope="col">时间（UTC）</th>
                <th scope="col">来源</th>
                <th scope="col">action</th>
                <th scope="col">结果</th>
                <th scope="col">scope</th>
                <th scope="col">目标</th>
                <th scope="col">actor</th>
                <th scope="col">request_id</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(row, index) in mergeRows"
                :key="row.id === '' ? row.source + '-' + index : row.id"
                data-testid="audit-merge-row"
                :data-source="row.source"
              >
                <td class="mono">{{ row.createdAtText }}</td>
                <td><span class="pill source" data-testid="audit-merge-row-source">{{ row.sourceText }}</span></td>
                <td>
                  <span class="mono">{{ row.action }}</span>
                  <small class="label">{{ row.actionLabel }}</small>
                </td>
                <td><span class="pill" :class="row.resultTone">{{ row.resultLabel }}</span></td>
                <td class="mono">{{ row.scope }}</td>
                <td class="mono">{{ row.targetText }}</td>
                <td class="mono">{{ row.actor === '' ? '（无）' : row.actor }}</td>
                <td class="mono">{{ row.requestId === '' ? '（无）' : row.requestId }}</td>
              </tr>
            </tbody>
          </table>

          <aside v-else class="note" data-testid="audit-merge-empty">
            <strong>三源合并后没有任何行</strong>
            <p v-if="merged.failures.length === 0">三条读面都读成功但都没返回行；这与「某一源读取异常」是两件事——空台账不是错误，异常会在上面单独点名。</p>
            <p v-else>成功的读面没有返回任何行；失败的读面已在上面点名。</p>
          </aside>

          <p class="hint" data-testid="audit-merge-hint">
            合并读数与上面的筛选栏不是同一口径：另两个读面只接受 <code>cursor</code> / <code>limit</code>，没有 action / entity / 时间参数，
            所以这里只读每源最近 {{ state.limit }} 条；要看筛选后的单源台账请用上面的表格。
          </p>
        </template>
      </section>

      <form class="toolbar" data-testid="audit-log-filters" @submit.prevent="applyFilters">
        <label class="field">
          <span>action</span>
          <select data-testid="audit-log-filter-action" :value="state.draft.action" @change="setDraft('action', $event.target.value)">
            <option value="all">全部（不带 action）</option>
            <option v-for="action in AUDIT_LOG_ACTIONS" :key="action" :value="action">{{ action }} · {{ AUDIT_LOG_ACTION_LABELS[action] }}</option>
          </select>
        </label>
        <label class="field">
          <span>entity</span>
          <select data-testid="audit-log-filter-entity" :value="state.draft.entity" @change="setDraft('entity', $event.target.value)">
            <option value="all">全部（不带 entity）</option>
            <option v-for="entity in AUDIT_LOG_ENTITIES" :key="entity" :value="entity">{{ entity }} · {{ AUDIT_LOG_ENTITY_LABELS[entity] }}</option>
          </select>
        </label>
        <label class="field">
          <span>from（RFC 3339）</span>
          <input
            data-testid="audit-log-filter-from"
            :value="state.draft.from"
            placeholder="2026-10-23T00:00:00Z"
            @input="setDraft('from', $event.target.value)"
          />
        </label>
        <label class="field">
          <span>to（RFC 3339）</span>
          <input
            data-testid="audit-log-filter-to"
            :value="state.draft.to"
            placeholder="2026-10-24T00:00:00Z"
            @input="setDraft('to', $event.target.value)"
          />
        </label>
        <label class="field">
          <span>每页</span>
          <select data-testid="audit-log-filter-limit" :value="String(state.limit)" @change="changeLimit($event.target.value)">
            <option v-for="choice in limitChoices" :key="choice" :value="String(choice)">{{ choice }}</option>
          </select>
        </label>
        <div class="actions">
          <button class="primary" type="submit" :disabled="busy" data-testid="audit-log-apply-filters">应用筛选</button>
          <button class="ghost" type="button" :disabled="busy" data-testid="audit-log-reset-filters" @click="resetFilters">清空筛选</button>
        </div>
      </form>

      <p v-if="filterFailure !== null" class="banner error" role="alert" data-testid="audit-log-filter-error">
        <strong>筛选条件不合法：</strong>
        <span>{{ filterFailure.message }}</span>
      </p>

      <div class="status" :class="view.tone" :role="view.tone === 'error' ? 'alert' : 'status'" data-testid="audit-log-status">
        <strong>{{ view.title }}</strong>
        <span>{{ view.detail }}</span>
        <code v-if="view.errorCode !== ''" class="code-chip" data-testid="audit-log-error-code">{{ view.errorCode }}</code>
        <button v-if="view.canRetry" class="link" type="button" data-testid="audit-log-retry" @click="refresh">
          {{ view.restartNeeded ? '回第一页重读' : '重试' }}
        </button>
      </div>

      <p class="counts">
        <span class="pill ok">已读 {{ view.total }} 条</span>
        <span class="pill">筛选：{{ view.filtered ? view.filterText : '无' }}</span>
        <span v-if="view.duplicates > 0" class="pill warn">去重 {{ view.duplicates }} 条</span>
        <span v-if="view.nextCursor !== null" class="pill">还有下一页</span>
        <span v-else-if="view.total > 0" class="pill ok">已到最后一页</span>
      </p>

      <table v-if="rows.length > 0" class="grid" data-testid="audit-log-table">
        <thead>
          <tr>
            <th>时间（UTC）</th>
            <th>action</th>
            <th>结果</th>
            <th>scope</th>
            <th>reason_code</th>
            <th>目标</th>
            <th>actor</th>
            <th>详情</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="row in rows" :key="row.id">
            <tr data-testid="audit-log-row">
              <td class="mono">{{ row.createdAtText }}</td>
              <td>
                <span class="mono">{{ row.action }}</span>
                <small class="label">{{ row.actionLabel }}</small>
              </td>
              <td><span class="pill" :class="row.resultTone">{{ row.resultLabel }}</span></td>
              <td class="mono">{{ row.scope }}</td>
              <td class="mono">{{ row.reasonCode }}</td>
              <td class="mono">{{ row.targetText }}</td>
              <td class="mono">{{ row.actor === '' ? '（无）' : row.actor }}</td>
              <td>
                <button class="link" type="button" :data-testid="'audit-log-toggle-' + row.id" @click="toggleRow(row.id)">
                  {{ state.expandedId === row.id ? '收起' : '展开' }}
                </button>
              </td>
            </tr>
            <tr v-if="state.expandedId === row.id" class="detail" data-testid="audit-log-detail">
              <td colspan="8">
                <dl>
                  <template v-for="entry in row.trail" :key="entry.label">
                    <dt>{{ entry.label }}</dt>
                    <dd class="mono">{{ entry.value }}</dd>
                  </template>
                </dl>
              </td>
            </tr>
          </template>
        </tbody>
      </table>

      <aside v-else-if="view.tone === 'empty' || view.tone === 'empty_filtered'" class="note" data-testid="audit-log-empty">
        <strong>{{ view.title }}</strong>
        <p>{{ view.detail }}</p>
        <button v-if="view.filtered" class="ghost" type="button" data-testid="audit-log-empty-reset" @click="resetFilters">清空筛选</button>
      </aside>

      <div class="pager">
        <button class="ghost" type="button" :disabled="!view.canLoadMore" data-testid="audit-log-load-more" @click="loadMore">读取下一页</button>
        <button class="ghost" type="button" :disabled="busy" data-testid="audit-log-refresh" @click="refresh">重新读取第一页</button>
        <span v-if="busy" class="hint" data-testid="audit-log-busy">读取中…</span>
      </div>

      <p class="foot">
        游标有效期 15 分钟，且与 <code>[from,to,action,entity]</code> 绑定：<strong>换筛选必须回第一页</strong>，否则后端回
        <code>INVALID_CURSOR</code>。空台账与「无权限」是两件事：403 会显示上面的权限提示与错误码，不会伪装成 0 条。
      </p>
    </template>
  </section>
</template>

<style scoped>
.ledger {
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
.counts {
  font-size: 0.86rem;
  color: #4a5568;
}

.sub {
  flex: 1 1 20rem;
  margin: 0;
  line-height: 1.55;
}

.hint {
  margin: 0;
}

.signin {
  display: grid;
  gap: 0.6rem;
  max-width: 26rem;
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

.actions {
  display: flex;
  gap: 0.5rem;
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

.status.empty,
.status.empty_filtered {
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

.pill.danger {
  background: #fff5f5;
  color: #822727;
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

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  word-break: break-all;
}

.label {
  display: block;
  color: #718096;
}

.detail dl {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.2rem 0.8rem;
  margin: 0;
  font-size: 0.8rem;
}

.detail dt {
  color: #4a5568;
}

.detail dd {
  margin: 0;
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

/* 三读面合并读数（GY-R68-C4）：与单源台账同一套 pill/grid，只加一个承装容器与来源标记。 */
.merged {
  display: grid;
  gap: 0.6rem;
  padding: 0.85rem 0.9rem;
  border: 1px solid rgba(15, 118, 110, 0.28);
  border-radius: 0.6rem;
}

.merged-head {
  display: grid;
  gap: 0.4rem;
}

.merged-head h3 {
  margin: 0;
  font-size: 1rem;
}

.merged-head .sub {
  margin: 0;
}

.pill.source {
  background: rgba(15, 118, 110, 0.14);
  color: #0f766e;
}

.merged-grid small.label {
  display: block;
}
</style>
