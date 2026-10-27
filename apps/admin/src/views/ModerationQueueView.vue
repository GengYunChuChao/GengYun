<script setup>
/**
 * R62 · 社区审核队列（只读 + 审核动作）页面。
 *
 * 只调四个**已经在服务端落地**的 operation，不新增契约：
 * - `GET  /admin/posts`              `listAdminPosts`  scope `sources:read`（limit / cursor / state / audit_state）
 * - `GET  /admin/posts/{id}`         `getAdminPost`    scope `sources:read`
 * - `POST /admin/posts/{id}/approve` `approvePost`     scope `sources:write`（契约里**没有**请求体）
 * - `POST /admin/posts/{id}/reject`  `rejectPost`      scope `sources:write`（body 只有 `reason_code`）
 * ⛔ 参数名照抄契约：筛选是 `state` 与 `audit_state`，不是 `entity`／`entity_type`。
 * ⛔ 本页不做人审工作流（审核人、投票、专家认证）：那是另一个概念，占位页仍留在原处。
 *
 * 表现约定：
 * - 403（缺 scope）显示明确提示 + 错误码，不伪装成空队列，也不给「重试」；
 * - 503 只有在服务端写 `retryable: true` 时才给「重试」；
 * - 空数组是空态（不是错误）；筛选下为空与「队列本身为空」分开说；
 * - 换筛选／换每页条数一律回第一页（后端游标与 [state,audit_state] 绑定，否则 INVALID_CURSOR）；
 * - 200 + `changed: false` 如实显示「已是该状态」，不假装刚成功，也不改本地行；
 * - 动作成功后按回执更新当前行，并**重新读一次详情**拿到真实 ETag。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { API_BASE_URL, loadAdminSession, signInAdmin, signOutAdmin } from '../auth/session';
import {
  APPROVE_OPERATION_ID,
  AUDIT_STATES,
  AUDIT_STATE_LABELS,
  buildPostReviewRequest,
  canLoadMoreModeration,
  describeQueueFailure,
  describeQueueView,
  describeReviewFailure,
  describeReviewOutcome,
  DETAIL_OPERATION_ID,
  emptyModerationFilters,
  fetchAdminPostDetail,
  fetchModerationQueuePage,
  initialModerationQueueState,
  LIST_OPERATION_ID,
  MODERATION_LIMIT_OPTIONS,
  MODERATION_QUEUE_PATH,
  MODERATION_READ_SCOPE,
  MODERATION_WRITE_SCOPE,
  MODERATION_FILTER_ANY,
  moderationQueueRows,
  moderationRowView,
  POST_REVIEW_REASON_CODES,
  POST_REVIEW_REASON_LABELS,
  reduceModerationQueue,
  REJECT_OPERATION_ID,
  submitPostReview,
  validateModerationFilters,
  VISIBILITY_STATES,
  VISIBILITY_LABELS,
} from '../lib/admin-moderation-queue.mjs';

const state = ref(initialModerationQueueState());
const session = ref(null);
const loginName = ref('');
const password = ref('');
const signInError = ref(null);
const busy = ref(false);
const reasonCode = ref('');
let requestSeq = 0;
let detailSeq = 0;
let keySeq = 0;
let currentToken = null;
/** 同一次动作的重放复用同一个 Idempotency-Key（契约：同主体/方法/路径的键域）。 */
const idempotencyKeys = new Map();

const view = computed(() => describeQueueView(state.value));
const rows = computed(() => moderationQueueRows(state.value));
const signedIn = computed(() => state.value.signedIn);
const filterFailure = computed(() => state.value.filterFailure);
const detail = computed(() => state.value.detail);
const detailRow = computed(() => (state.value.detail === null ? null : moderationRowView(state.value.detail)));
const detailFailureView = computed(() => describeQueueFailure(state.value.detailFailure));
const actionFailureView = computed(() => describeReviewFailure(state.value.actionFailure));
const outcomeView = computed(() => {
  const outcome = state.value.lastOutcome;
  if (outcome === null) return null;
  return describeReviewOutcome(outcome, outcome.decision === 'rejected' ? 'reject' : 'approve');
});
const limitChoices = computed(() => {
  const current = state.value.limit;
  return MODERATION_LIMIT_OPTIONS.includes(current)
    ? MODERATION_LIMIT_OPTIONS
    : [...MODERATION_LIMIT_OPTIONS, current].sort((left, right) => left - right);
});
const actionBlocked = computed(() => state.value.actionBusy === true || state.value.detail === null);

function dispatch(action) {
  state.value = reduceModerationQueue(state.value, action);
}

function newIdempotencyKey() {
  keySeq += 1;
  const random = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID().replace(/-/g, '')
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `admin-moderation-${random}-${keySeq}`;
}

function keyFor(target, decision) {
  const cacheKey = `${target.id}|${decision}|${target.revision}`;
  if (!idempotencyKeys.has(cacheKey)) idempotencyKeys.set(cacheKey, newIdempotencyKey());
  return idempotencyKeys.get(cacheKey);
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
  dispatch({ type: 'LOAD_START', reset, cursor });
  const result = await fetchModerationQueuePage({
    baseUrl: API_BASE_URL,
    token: currentToken,
    cursor,
    limit: state.value.limit,
    filters: state.value.appliedFilters,
  });
  if (seq !== requestSeq) return;
  busy.value = false;
  if (result.ok) {
    dispatch({ type: 'LOAD_OK', reset, cursor, page: result.page });
  } else {
    dispatch({ type: 'LOAD_FAIL', failure: result });
  }
}

async function loadDetail(postId) {
  if (currentToken === null || typeof postId !== 'string') return;
  const seq = ++detailSeq;
  dispatch({ type: 'DETAIL_START' });
  const result = await fetchAdminPostDetail({ baseUrl: API_BASE_URL, token: currentToken, postId });
  if (seq !== detailSeq) return;
  if (result.ok) {
    dispatch({ type: 'DETAIL_OK', post: result.post, etag: result.etag });
  } else {
    dispatch({ type: 'DETAIL_FAIL', failure: result });
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
  busy.value = true;
  const credentials = { loginName: loginName.value, password: password.value };
  password.value = '';
  try {
    await signInAdmin(credentials);
  } catch (error) {
    busy.value = false;
    const message = error instanceof Error && error.message !== '' ? error.message : '后台登录失败';
    signInError.value = message;
    return;
  }
  const adminSession = await loadAdminSession();
  busy.value = false;
  if (adminSession === null) {
    signInError.value = '登录后未能读到会话详情';
    return;
  }
  startSession(adminSession);
}

async function signOut() {
  ++requestSeq;
  ++detailSeq;
  currentToken = null;
  session.value = null;
  busy.value = false;
  loginName.value = '';
  password.value = '';
  signInError.value = null;
  reasonCode.value = '';
  idempotencyKeys.clear();
  dispatch({ type: 'SIGN_OUT' });
  await signOutAdmin();
}

function setDraft(field, value) {
  dispatch({ type: 'SET_DRAFT_FILTERS', filters: { ...state.value.draftFilters, [field]: value } });
}

function changeLimit(value) {
  dispatch({ type: 'SET_LIMIT', limit: Number.parseInt(String(value), 10) });
  requestPage(null, { reset: true });
}

/** 应用筛选：先按契约闭集本地校验（不让必然 400 的输入出网），再无条件回第一页。 */
function applyFilters() {
  if (busy.value) return;
  const checked = validateModerationFilters(state.value.draftFilters);
  if (!checked.ok) {
    dispatch({ type: 'FILTER_FAILED', message: checked.problems.map((problem) => problem.message).join('；') });
    return;
  }
  dispatch({ type: 'FILTERS_APPLIED', filters: checked.filters });
  requestPage(null, { reset: true });
}

function resetFilters() {
  dispatch({ type: 'SET_DRAFT_FILTERS', filters: emptyModerationFilters() });
  dispatch({ type: 'RESET_FILTERS' });
  requestPage(null, { reset: true });
}

function loadMore() {
  const cursor = state.value.collection.nextCursor;
  if (typeof cursor !== 'string' || cursor === '' || !canLoadMoreModeration(state.value)) return;
  requestPage(cursor, { reset: false });
}

function refresh() {
  requestPage(null, { reset: true });
}

/** 点行 → 读详情（`getAdminPost`）。表里那枚按钮不挂自己的 handler，靠父行点击。 */
function selectRow(row) {
  if (row === null || typeof row !== 'object') return;
  dispatch({ type: 'SELECT_ROW', postId: row.id });
  reasonCode.value = '';
  loadDetail(row.id);
}

function retryDetail() {
  const postId = state.value.selectedId;
  if (typeof postId === 'string') loadDetail(postId);
}

function closeDetail() {
  ++detailSeq;
  reasonCode.value = '';
  dispatch({ type: 'SELECT_ROW', postId: null });
}

/**
 * 理由下拉用 `:value` + `@change`（与本目录既有页一致）：`v-model` 在 `<select>` 上会走
 * `@vue/runtime-dom` 的 `vModelSelect`，它直接读 `el.options`／`el.selectedIndex`，
 * 把本页放进内存宿主（`tests/unit/admin-ui-moderation-queue-render.test.mjs`）就装不起来。
 */
function onReasonChange(event) {
  const value = event?.target?.value;
  reasonCode.value = typeof value === 'string' && POST_REVIEW_REASON_CODES.includes(value) ? value : '';
}

/** approve／reject：本地先过一遍契约（approve 无 body、reject 必须带闭集内 reason_code）。 */
async function runReview(decision) {
  if (state.value.actionBusy === true) return;
  const target = state.value.detail !== null && state.value.detail.id === state.value.selectedId
    ? state.value.detail
    : rows.value.find((row) => row.id === state.value.selectedId) ?? null;
  if (target === null) return;

  const built = buildPostReviewRequest({
    baseUrl: API_BASE_URL,
    token: currentToken,
    postId: target.id,
    revision: target.revision,
    decision,
    reasonCode: decision === 'reject' ? reasonCode.value : null,
    idempotencyKey: keyFor(target, decision),
  });
  if (!built.ok) {
    dispatch({
      type: 'REVIEW_FAIL',
      failure: {
        ok: false,
        kind: 'invalid_request',
        retriable: false,
        status: null,
        code: null,
        inContract: null,
        message: `${built.problems.map((problem) => problem.message).join('；')}（本地就拦下，未发请求）`,
      },
    });
    return;
  }

  dispatch({ type: 'REVIEW_START', decision });
  const result = await submitPostReview({
    baseUrl: API_BASE_URL,
    token: currentToken,
    postId: target.id,
    revision: target.revision,
    decision,
    reasonCode: decision === 'reject' ? reasonCode.value : null,
    idempotencyKey: keyFor(target, decision),
  });
  if (result.ok) {
    dispatch({ type: 'REVIEW_OK', outcome: result.outcome });
    idempotencyKeys.delete(`${target.id}|${decision}|${target.revision}`);
    if (result.outcome.changed === true) {
      // 回执已把 revision／audit_state 写进本地行；再读一次详情拿真实 ETag 与完整正文。
      loadDetail(target.id);
    }
    return;
  }
  dispatch({ type: 'REVIEW_FAIL', failure: result });
}

function dismissAction() {
  dispatch({ type: 'DISMISS_ACTION' });
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
  ++detailSeq;
});
</script>

<template>
  <section class="queue">
    <header class="head">
      <h2>社区审核队列（只读 + 审核动作）</h2>
      <p class="sub">
        列表调 <code>GET {{ MODERATION_QUEUE_PATH }}</code>（<code>{{ LIST_OPERATION_ID }}</code>，scope
        <code>{{ MODERATION_READ_SCOPE }}</code>），详情调 <code>{{ DETAIL_OPERATION_ID }}</code>，动作调
        <code>{{ APPROVE_OPERATION_ID }}</code> 与 <code>{{ REJECT_OPERATION_ID }}</code>（scope
        <code>{{ MODERATION_WRITE_SCOPE }}</code>）。参数名照抄契约：<code>state</code> 与 <code>audit_state</code>。
      </p>
      <button v-if="signedIn" class="ghost" type="button" data-testid="moderation-sign-out" @click="signOut">退出登录</button>
    </header>

    <form v-if="!signedIn" class="signin" data-testid="moderation-signin" @submit.prevent="submitSignIn">
      <h3>登录后台</h3>
      <p class="hint">读取需要 <code>{{ MODERATION_READ_SCOPE }}</code>，审核动作需要 <code>{{ MODERATION_WRITE_SCOPE }}</code>；令牌只存 sessionStorage，不写日志、不进 URL。</p>
      <label class="field">
        <span>登录名</span>
        <input v-model="loginName" name="loginName" autocomplete="username" required />
      </label>
      <label class="field">
        <span>口令</span>
        <input v-model="password" name="password" type="password" autocomplete="current-password" required />
      </label>
      <button class="primary" type="submit" :disabled="busy" data-testid="moderation-signin-submit">登录</button>
      <p v-if="signInError !== null" class="banner error" role="alert" data-testid="moderation-signin-error">{{ signInError }}</p>
    </form>

    <template v-else>
      <p v-if="state.scopeWarning" class="banner warn" data-testid="moderation-scope-warning">
        当前后台会话的 scope 列表里没有 <code>{{ MODERATION_READ_SCOPE }}</code>：读取会被后端以 403 SCOPE_DENIED 拒绝，下面会如实显示，不静默空白。
      </p>

      <form class="toolbar" data-testid="moderation-filters" @submit.prevent="applyFilters">
        <label class="field">
          <span>state（可见性）</span>
          <select data-testid="moderation-filter-state" :value="state.draftFilters.state" @change="setDraft('state', $event.target.value)">
            <option :value="MODERATION_FILTER_ANY">全部（不带 state）</option>
            <option v-for="value in VISIBILITY_STATES" :key="value" :value="value">{{ value }} · {{ VISIBILITY_LABELS[value] }}</option>
          </select>
        </label>
        <label class="field">
          <span>audit_state（审核态）</span>
          <select data-testid="moderation-filter-audit-state" :value="state.draftFilters.auditState" @change="setDraft('auditState', $event.target.value)">
            <option :value="MODERATION_FILTER_ANY">全部（不带 audit_state）</option>
            <option v-for="value in AUDIT_STATES" :key="value" :value="value">{{ value }} · {{ AUDIT_STATE_LABELS[value] }}</option>
          </select>
        </label>
        <label class="field">
          <span>每页</span>
          <select data-testid="moderation-filter-limit" :value="String(state.limit)" @change="changeLimit($event.target.value)">
            <option v-for="choice in limitChoices" :key="choice" :value="String(choice)">{{ choice }}</option>
          </select>
        </label>
        <div class="actions">
          <button class="primary" type="submit" :disabled="busy" data-testid="moderation-apply-filters">应用筛选</button>
          <button class="ghost" type="button" :disabled="busy" data-testid="moderation-reset-filters" @click="resetFilters">清空筛选</button>
        </div>
      </form>

      <p v-if="filterFailure !== null" class="banner error" role="alert" data-testid="moderation-filter-error">
        <strong>筛选条件不合法：</strong>
        <span>{{ filterFailure.message }}</span>
      </p>

      <div class="status" :class="view.tone" :role="view.role" data-testid="moderation-status">
        <strong>{{ view.title }}</strong>
        <span>{{ view.detail }}</span>
        <code v-if="state.failure !== null && state.failure.code !== null" class="code-chip" data-testid="moderation-error-code">{{ state.failure.code }}</code>
        <button v-if="view.canRetry" class="link" type="button" data-testid="moderation-retry" @click="refresh">
          {{ view.restartNeeded ? '回第一页重读' : '重试' }}
        </button>
      </div>

      <p class="counts">
        <span class="pill ok">已读 {{ rows.length }} 条</span>
        <span class="pill">筛选：{{ view.tone === 'empty_filtered' ? '命中 0 条' : '见工具栏' }}</span>
        <span v-if="state.collection.duplicates > 0" class="pill warn">去重 {{ state.collection.duplicates }} 条</span>
        <span v-if="state.collection.cycle" class="pill danger">游标原地踏步</span>
        <span v-if="canLoadMoreModeration(state)" class="pill">还有下一页</span>
        <span v-else-if="rows.length > 0" class="pill ok">已到最后一页</span>
      </p>

      <table v-if="rows.length > 0" class="grid" data-testid="moderation-table">
        <thead>
          <tr>
            <th>标题</th>
            <th>audit_state</th>
            <th>visibility</th>
            <th>revision</th>
            <th>作者</th>
            <th>提交时间（UTC）</th>
            <th>详情</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in rows"
            :key="row.id"
            :class="{ selected: state.selectedId === row.id }"
            data-testid="moderation-row"
            tabindex="0"
            :aria-label="`打开帖子《${row.title}》查看详情（${row.id}）`"
            @click="selectRow(row)"
            @keydown.enter.self.prevent="selectRow(row)"
            @keydown.space.self.prevent="selectRow(row)"
          >
            <td>
              <span>{{ row.title }}</span>
              <small class="label mono">{{ row.id }}</small>
            </td>
            <td><span class="pill" :class="row.auditState === 'approved' ? 'ok' : row.auditState === 'rejected' ? 'danger' : 'warn'">{{ row.auditStateLabel }}</span></td>
            <td class="mono">{{ row.visibilityLabel }}</td>
            <td class="mono">{{ row.revision }}</td>
            <td class="mono">{{ row.authorLabel }}</td>
            <td class="mono">{{ row.createdAtLabel }}</td>
            <td>
              <button
                class="link"
                type="button"
                :data-testid="'moderation-open-' + row.id"
                :aria-label="`打开帖子《${row.title}》查看详情（${row.id}）`"
                @click.stop="selectRow(row)"
              >
                查看详情
              </button>
            </td>
          </tr>
        </tbody>
      </table>

      <aside v-else-if="view.tone === 'empty' || view.tone === 'empty_filtered'" class="note" data-testid="moderation-empty">
        <strong>{{ view.title }}</strong>
        <p>{{ view.detail }}</p>
        <button v-if="view.tone === 'empty_filtered'" class="ghost" type="button" data-testid="moderation-empty-reset" @click="resetFilters">清空筛选</button>
      </aside>

      <aside v-if="state.selectedId !== null" class="panel" data-testid="moderation-detail">
        <header class="panel-head">
          <h3>详情（{{ DETAIL_OPERATION_ID }}）</h3>
          <button class="ghost" type="button" data-testid="moderation-detail-close" @click="closeDetail">收起</button>
        </header>

        <p v-if="state.detailLoading" class="hint" data-testid="moderation-detail-loading">读取中…</p>

        <template v-else-if="detailFailureView !== null">
          <p class="banner error" role="alert" data-testid="moderation-detail-error">
            <strong>{{ detailFailureView.title }}</strong>
            <span>{{ detailFailureView.detail }}</span>
          </p>
          <button class="ghost" type="button" data-testid="moderation-detail-retry" @click="retryDetail">重读详情</button>
        </template>

        <template v-else-if="detail !== null">
          <dl class="facts">
            <dt>标题</dt>
            <dd>{{ detail.title }}</dd>
            <dt>audit_state</dt>
            <dd><span class="mono">{{ detail.audit_state }}</span> · {{ detailRow?.auditStateLabel ?? '' }}</dd>
            <dt>visibility</dt>
            <dd><span class="mono">{{ detail.visibility }}</span> · {{ detailRow?.visibilityLabel ?? '' }}（库内存储值，不是公开读面的生效值）</dd>
            <dt>revision / ETag</dt>
            <dd class="mono">{{ detail.revision }} · {{ state.detailEtag === null ? '（响应未带 ETag）' : state.detailEtag }}</dd>
            <dt>作者</dt>
            <dd class="mono">{{ detailRow?.authorLabel ?? '' }}</dd>
            <dt>作物 / 地区</dt>
            <dd class="mono">{{ detail.crop_id ?? '（无）' }} / {{ detail.region_code ?? '（无）' }}</dd>
            <dt>媒体</dt>
            <dd class="mono">{{ detailRow?.mediaCount ?? 0 }} 个（契约上限 3）</dd>
            <dt>关联知识</dt>
            <dd class="mono">{{ detail.linked_knowledge_ref === null ? '（无）' : `${detail.linked_knowledge_ref.type} · ${detail.linked_knowledge_ref.id} · rev ${detail.linked_knowledge_ref.revision}` }}</dd>
            <dt>提交 / 更新</dt>
            <dd class="mono">{{ detailRow?.createdAtLabel ?? '' }} / {{ detailRow?.updatedAtLabel ?? '' }}</dd>
            <dt>正文</dt>
            <dd class="body" data-testid="moderation-detail-body">{{ detail.body }}</dd>
          </dl>

          <div class="actions">
            <label class="field">
              <span>驳回理由（reject 必填，闭集 10 值）</span>
              <select :value="reasonCode" data-testid="moderation-reason" @change="onReasonChange">
                <option value="">（未选择）</option>
                <option v-for="code in POST_REVIEW_REASON_CODES" :key="code" :value="code">{{ code }} · {{ POST_REVIEW_REASON_LABELS[code] }}</option>
              </select>
            </label>
            <button class="primary" type="button" :disabled="actionBlocked" data-testid="moderation-approve" @click="runReview('approve')">
              通过（approvePost）
            </button>
            <button class="danger" type="button" :disabled="actionBlocked" data-testid="moderation-reject" @click="runReview('reject')">
              驳回（rejectPost）
            </button>
            <span v-if="state.actionBusy" class="hint" data-testid="moderation-action-busy">提交中…</span>
          </div>

          <p class="foot">
            approve 只写 <code>audit_state=approved</code>、不改可见性；reject 同时把 <code>visibility</code> 置为
            <code>hidden</code> 并通知作者。两个动作都要 <code>If-Match: "&lt;revision&gt;"</code> 与
            <code>Idempotency-Key</code>；重复提交同一结论时服务端回 <code>changed:false</code>。
            本页<strong>不显示审核人</strong>：<code>audit_state</code> 只记状态，谁审的落在审计台账（<code>audit:read</code>），
            帖子行里没有这个字段，页面不替它编。
          </p>
        </template>
      </aside>

      <p v-if="outcomeView !== null" class="banner" :class="outcomeView.tone === 'warn' ? 'warn' : 'ok'" role="status" data-testid="moderation-action-notice">
        <strong>{{ outcomeView.title }}</strong>
        <span>{{ outcomeView.detail }}</span>
        <small>{{ outcomeView.advice }}</small>
      </p>

      <p v-if="actionFailureView !== null" class="banner error" role="alert" data-testid="moderation-action-error">
        <strong>{{ actionFailureView.title }}</strong>
        <span>{{ actionFailureView.detail }}</span>
        <small>{{ actionFailureView.advice }}</small>
        <button class="link" type="button" data-testid="moderation-action-dismiss" @click="dismissAction">知道了</button>
      </p>

      <div class="pager">
        <button class="ghost" type="button" :disabled="!canLoadMoreModeration(state)" data-testid="moderation-load-more" @click="loadMore">读取下一页</button>
        <button class="ghost" type="button" :disabled="busy" data-testid="moderation-refresh" @click="refresh">重新读取第一页</button>
        <span v-if="busy" class="hint" data-testid="moderation-busy">读取中…</span>
      </div>

      <p class="foot">
        游标与 <code>[state,audit_state]</code> 绑定：<strong>换筛选必须回第一页</strong>，否则后端回
        <code>INVALID_CURSOR</code>（页面会给出「回第一页重读」）。空队列与「无权限」是两件事：403 会显示权限提示与错误码，
        不会伪装成 0 条；403 不给重试，503 只在服务端声明 <code>retryable: true</code> 时才给。
      </p>
    </template>
  </section>
</template>

<style scoped>
.queue {
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
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: flex-end;
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

.danger {
  padding: 0.45rem 0.9rem;
  border: 1px solid #c53030;
  border-radius: 8px;
  background: #c53030;
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
  display: grid;
  gap: 0.2rem;
  margin: 0;
  padding: 0.5rem 0.7rem;
  border-radius: 8px;
  font-size: 0.86rem;
}

.banner small {
  color: #4a5568;
}

.banner.warn {
  border-left: 3px solid #b7791f;
  background: #fffbeb;
  color: #744210;
}

.banner.ok {
  border-left: 3px solid #2f855a;
  background: #f0fdf4;
  color: #22543d;
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
.status.empty_filtered,
.status.loading {
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

tr.selected {
  background: #e6fffa;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  word-break: break-all;
}

.label {
  display: block;
  color: #718096;
}

.panel {
  display: grid;
  gap: 0.6rem;
  padding: 0.8rem 0.9rem;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  background: #fff;
}

.panel-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
}

.facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.25rem 0.9rem;
  margin: 0;
  font-size: 0.84rem;
}

.facts dt {
  color: #4a5568;
}

.facts dd {
  margin: 0;
}

.body {
  white-space: pre-wrap;
  line-height: 1.55;
  word-break: break-word;
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
</style>
