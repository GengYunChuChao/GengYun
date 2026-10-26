<script setup>
/**
 * 分类管理页（#18，B8）。
 *
 * 契约只有两个操作：
 *  - GET   `/admin/categories`      `listAdminCategories`（scope `sources:read`，游标分页）
 *  - PATCH `/admin/categories/{id}` `editCategory`（scope `sources:write`，`Idempotency-Key` + `If-Match`，体 `CategoryInput`）
 *
 * 因此本页**没有**新建／删除按钮：契约里不存在这两个接口，页面不造。`CategoryInput` 也没有 `type` 字段，
 * 分类类型（crop／species）只能在种子数据里，PATCH 不能改——详情里写明了。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  AUDIT_READ_SCOPE,
  CATEGORIES_PATH,
  SOURCES_READ_SCOPE,
  SOURCES_WRITE_SCOPE,
  buildCategoryInput,
  categoryFormFromDetail,
  etagFor,
  newIdempotencyKey,
} from '../lib/admin-content-contract.mjs';
import {
  deriveChanged,
  describeWriteFailure,
  editCategory,
  findAuditEventsForRequest,
  listCategories,
} from '../lib/admin-content-api.mjs';
import {
  LIFECYCLE_NOTE,
  canLoadMoreFamily,
  categoryDetailView,
  categoryRow,
  changedVerdict,
  describeFamily,
  initialFamilyState,
  reduceFamily,
} from '../lib/admin-content-view-model.mjs';
import ContentFieldGrid from './ContentFieldGrid.vue';
import WriteReceipt from './WriteReceipt.vue';

const props = defineProps({
  baseUrl: { type: String, required: true },
  token: { type: String, required: true },
  scopes: { type: Array, required: true },
});
const emit = defineEmits(['signed-out']);

const state = ref(initialFamilyState());
const formMode = ref(null);
const form = ref({ name: '', description: '', active: true });
const formErrors = ref([]);

let requestSeq = 0;

const rows = computed(() => state.value.collection.items.map(categoryRow));
const view = computed(() => describeFamily(state.value, { label: '分类' }));
const detail = computed(() => (state.value.detail === null ? null : categoryDetailView(state.value.detail)));
const canRead = computed(() => props.scopes.includes(SOURCES_READ_SCOPE));
const canWrite = computed(() => props.scopes.includes(SOURCES_WRITE_SCOPE));
const canAudit = computed(() => props.scopes.includes(AUDIT_READ_SCOPE));
const canLoadMore = computed(() => canLoadMoreFamily(state.value));
const busyWrite = computed(() => state.value.busyWrite === true);
/**
 * 写回执的**显式判定**（喂给 `WriteReceipt` 的 `changed` prop）。
 *
 * 本页契约只有一个写操作（`PATCH /admin/categories/{id}`），回执是 `Category`，**不带** `changed` 字段，
 * 所以 `deriveChanged()` 只能走「编辑比 revision 是否前进」这一条：响应里的 `revision` 与本次编辑
 * **所基于**的 `previousRevision`（列表行读到、也是 If-Match 用的那个）比较。
 * 任一侧不是整数 ⇒ `null` ⇒ `'unknown'` ⇒ 回执只写「已受理」，**不按 HTTP 200 猜成功**。
 */
const receiptChanged = computed(() => changedVerdict(state.value.write?.changed));
const ifMatchPreview = computed(() => {
  try {
    return etagFor(state.value.detail?.revision);
  } catch {
    return '—';
  }
});

const fields = computed(() => [
  { key: 'name', label: '名称', type: 'text', required: true, hint: '≤120 字' },
  { key: 'description', label: '说明', type: 'textarea', required: true, wide: true, hint: '≤2000 字' },
  { key: 'active', label: '启用', type: 'checkbox', hint: '停用后不再参与前台分类选择（由服务端决定影响面）。' },
]);

const detailFailure = computed(() => (state.value.detailFailure === null ? null : describeWriteFailure(state.value.detailFailure)));

function dispatch(action) {
  state.value = reduceFamily(state.value, action);
}

async function requestPage(cursor, { reset }) {
  const seq = ++requestSeq;
  dispatch({ type: 'LOAD_START', reset });
  const result = await listCategories({ baseUrl: props.baseUrl, token: props.token, cursor, limit: 20 });
  if (seq !== requestSeq) return;
  if (result.ok) {
    dispatch({ type: 'LOAD_OK', cursor, page: result.page });
  } else {
    dispatch({ type: 'LOAD_FAIL', failure: result });
    if (result.kind === 'signed_out') emit('signed-out');
  }
}

function refresh() {
  formMode.value = null;
  requestPage(null, { reset: true });
}

function loadMore() {
  const cursor = state.value.collection.nextCursor;
  if (cursor === null) return;
  requestPage(cursor, { reset: false });
}

/**
 * 选中一行并进入编辑态。
 *
 * 契约**没有** `GET /admin/categories/{id}`，所以详情与 If-Match 都取自**列表行**（行自带 `revision`）。
 * 页面如实标注这一点：If-Match 来自列表读到的 revision，不是重新读到的。
 */
function select(row) {
  dispatch({ type: 'SELECT', id: row.id });
  const hit = state.value.collection.items.find((item) => item.id === row.id);
  if (hit === undefined) return;
  dispatch({ type: 'DETAIL_OK', item: hit });
  form.value = categoryFormFromDetail(hit);
  formErrors.value = [];
  formMode.value = 'edit';
}

function closeDetail() {
  dispatch({ type: 'SELECT', id: null });
  formMode.value = null;
}

function updateField(key, value) {
  form.value = { ...form.value, [key]: value };
}

/**
 * 执行一次写操作并把回执落到状态里。
 *
 * `action` 只用来算回执的 `changed` 三值（本页只有 `'edit'`）；`previousRevision` 是这次编辑
 * **所基于**的 revision（即 If-Match 用的那个），不是响应回传的新值。
 */
async function runWrite({ label, action, send, previousRevision = null }) {
  dispatch({ type: 'WRITE_START', label });
  const result = await send();
  const receipt = {
    phase: 'settled',
    label,
    ok: result.ok === true,
    status: result.status ?? null,
    code: result.code ?? null,
    inContract: result.inContract === true,
    message: result.message ?? '',
    requestUrl: result.requestUrl ?? null,
    requestId: result.requestId ?? null,
    etag: result.etag ?? null,
    sentHeaders: result.sentHeaders ?? null,
    /**
     * 三值：`true`／`false`／`null`（拿不到契约真值）。`Category` 回执没有 `changed` 字段，
     * 只能比 revision 前进；两侧缺一不可比 ⇒ `null`。回执面板据此写「成功回执」
     * 「已受理（本次未产生变更）」或只写「已受理」。
     */
    changed: deriveChanged(action, result, { previousRevision }),
  };
  dispatch({ type: 'WRITE_SETTLED', receipt });
  if (result.ok) {
    dispatch({ type: 'ROW_UPSERT', item: result.item });
    dispatch({ type: 'DETAIL_OK', item: result.item });
    return result;
  }
  if (result.kind === 'signed_out') emit('signed-out');
  return result;
}

async function submitForm() {
  const built = buildCategoryInput(form.value);
  formErrors.value = built.errors;
  if (!built.ok) return;
  // 这次编辑**所基于**的 revision（列表行读到的那个，也是 If-Match 用的那个），不是响应回传的新值。
  const previousRevision = state.value.detail?.revision ?? null;
  let ifMatch;
  try {
    ifMatch = etagFor(previousRevision);
  } catch {
    formErrors.value = [{ field: 'name', message: '没有可用的 revision，无法生成 If-Match：请重新读取列表后再选一次' }];
    return;
  }
  const id = state.value.detail.id;
  const result = await runWrite({
    label: '编辑分类（PATCH /admin/categories/{id}）',
    action: 'edit',
    previousRevision,
    send: () => editCategory({ baseUrl: props.baseUrl, token: props.token, id, ifMatch, idempotencyKey: newIdempotencyKey(), body: built.value }),
  });
  if (result.ok) formMode.value = null;
}

async function lookupAudit() {
  const requestId = state.value.write?.requestId ?? null;
  dispatch({ type: 'AUDIT_START' });
  const result = await findAuditEventsForRequest({ baseUrl: props.baseUrl, token: props.token, requestId });
  if (result.ok) {
    dispatch({ type: 'AUDIT_OK', events: result.events, scanned: result.scanned, truncated: result.truncated });
  } else {
    dispatch({ type: 'AUDIT_FAIL', failure: result });
  }
}

onMounted(() => {
  if (canRead.value) requestPage(null, { reset: true });
});

onBeforeUnmount(() => {
  ++requestSeq;
});
</script>

<template>
  <section class="family">
    <header class="head">
      <div>
        <h3>分类（categories）</h3>
        <p class="sub">
          读 <code>GET {{ baseUrl }}{{ CATEGORIES_PATH }}</code>（<code>listAdminCategories</code>，scope <code>sources:read</code>）· 写
          <code>PATCH {{ CATEGORIES_PATH }}/{id}</code>（<code>editCategory</code>，scope <code>sources:write</code>，带
          <code>Idempotency-Key</code> + <code>If-Match</code>）。契约没有新建／删除分类的接口，本页也不提供。
        </p>
      </div>
      <div class="head-actions">
        <button class="ghost" type="button" :disabled="busyWrite" @click="refresh">重新读取</button>
      </div>
    </header>

    <p v-if="!canRead" class="banner warn">
      当前后台会话的 scope 列表里没有 <code>sources:read</code>，本页不发列表请求（服务端会回
      <code>403 SCOPE_DENIED</code>）。
    </p>
    <p v-else-if="!canWrite" class="banner warn">
      当前会话没有 <code>sources:write</code>：保存按钮已禁用；真实拒绝仍由服务端判定。
    </p>

    <form v-if="formMode === 'edit' && state.detail !== null" class="editor" @submit.prevent="submitForm">
      <header>
        <h4>编辑分类（If-Match {{ ifMatchPreview }}）</h4>
        <button class="link" type="button" @click="closeDetail">取消</button>
      </header>
      <p class="hint">
        <code>If-Match: {{ ifMatchPreview }}</code> 取自**列表行**的 revision（契约没有单分类详情接口，不重新读一次）。
        若其他会话已改过该分类，服务端会返回 <code>409 REVISION_CONFLICT</code>，页面原样显示错误码。
      </p>
      <ContentFieldGrid :fields="fields" :form="form" :errors="formErrors" :disabled="busyWrite" @update="updateField" />
      <div class="row">
        <button class="primary" type="submit" :disabled="busyWrite || !canWrite">{{ busyWrite ? '提交中…' : '保存分类' }}</button>
        <button class="ghost" type="button" :disabled="busyWrite" @click="closeDetail">取消</button>
      </div>
    </form>

    <div class="status" :class="view.tone" role="status">
      <strong>{{ view.title }}</strong>
      <span>{{ view.detail }}</span>
      <button v-if="view.canRetry" class="link" type="button" @click="refresh">重试</button>
    </div>

    <table v-if="rows.length > 0" class="grid">
      <thead>
        <tr>
          <th>名称</th>
          <th>类型</th>
          <th>状态</th>
          <th>修订</th>
          <th>分类 ID</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="row in rows"
          :key="row.id"
          :class="{ selected: row.id === state.selectedId }"
          @click="select(row)"
        >
          <td>{{ row.title }}</td>
          <td>{{ row.versionLabel }}</td>
          <td><span class="pill" :class="row.statusTone">{{ row.statusLabel }}</span></td>
          <td class="mono">{{ row.revisionLabel }}</td>
          <td class="mono" :title="row.id">{{ row.id }}</td>
          <td class="right"><button class="link" type="button">编辑</button></td>
        </tr>
      </tbody>
    </table>

    <div class="toolbar">
      <button v-if="canLoadMore" class="ghost" type="button" :disabled="busyWrite" @click="loadMore">加载下一页</button>
      <span v-if="state.collection.duplicates > 0" class="foot">
        续页中有 {{ state.collection.duplicates }} 行与已加载行 ID 重复，已去重（未重复计数）。
      </span>
      <span v-if="state.collection.cycle" class="foot warn-text">服务端把请求游标原样返回，已停止续页以防死循环。</span>
    </div>

    <p class="note">
      分类的启用状态由服务端决定影响面；页面只显示契约字段 {{ LIFECYCLE_NOTE }}
    </p>

    <WriteReceipt
      :write="state.write"
      :changed="receiptChanged"
      :audit-lookup="state.auditLookup"
      :can-audit="canAudit"
      :can-reload-detail="false"
      @lookup-audit="lookupAudit"
      @clear-receipt="dispatch({ type: 'WRITE_CLEAR' })"
    />

    <aside v-if="state.selectedId !== null && detail !== null" class="detail">
      <header>
        <h4>详情</h4>
        <button class="link" type="button" @click="closeDetail">关闭</button>
      </header>
      <div v-if="detailFailure !== null" class="status error" role="alert">
        <strong>{{ detailFailure.title }}</strong>
        <span>{{ detailFailure.detail }}</span>
      </div>
      <dl>
        <template v-for="field in detail.fields" :key="field.label">
          <dt>{{ field.label }}</dt>
          <dd class="mono">{{ field.value }}</dd>
        </template>
      </dl>
      <p class="missing">读面未提供：{{ detail.missing.join('、') }}。</p>
      <p class="note">{{ detail.note }}</p>
      <div class="row">
        <button class="ghost" type="button" :disabled="busyWrite" @click="select({ id: state.selectedId })">重新编辑</button>
      </div>
    </aside>
  </section>
</template>

<style scoped>
.family {
  display: grid;
  gap: 0.9rem;
}
.head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.8rem;
}
.head-actions,
.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}
h3 {
  margin: 0;
  font-size: 1.05rem;
}
h4 {
  margin: 0;
  font-size: 0.95rem;
}
.sub,
.hint,
.foot,
.note,
.missing {
  margin: 0.3rem 0 0;
  font-size: 0.84rem;
  color: #4a5568;
  line-height: 1.6;
}
code {
  background: #edf2f7;
  border-radius: 4px;
  padding: 0.05rem 0.3rem;
  font-size: 0.86em;
}
.editor,
.detail {
  display: grid;
  gap: 0.6rem;
  border: 1px solid #cbd5e0;
  border-radius: 10px;
  padding: 0.85rem 1rem;
  background: #fff;
}
.editor header,
.detail header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.6rem;
}
button {
  font: inherit;
  cursor: pointer;
  border-radius: 8px;
  padding: 0.42rem 0.8rem;
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
  padding: 0.55rem 0.8rem;
  border-radius: 8px;
  font-size: 0.86rem;
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
  padding: 0.55rem 0.8rem;
  border-radius: 8px;
  font-size: 0.88rem;
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
  font-size: 0.9rem;
}
.grid th,
.grid td {
  text-align: left;
  padding: 0.45rem 0.55rem;
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
  font-size: 0.84rem;
}
.pill {
  display: inline-block;
  padding: 0.05rem 0.5rem;
  border-radius: 999px;
  font-size: 0.8rem;
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
.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.6rem;
}
.detail dl {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.25rem 1rem;
  margin: 0;
  font-size: 0.88rem;
}
.detail dt {
  font-weight: 600;
  color: #2d3748;
}
.detail dd {
  margin: 0;
  word-break: break-all;
}
.warn-text {
  color: #975a16;
}
</style>
