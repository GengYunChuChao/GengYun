<script setup>
/**
 * 资料来源管理页（#18 核心，B8）。
 *
 * 只调用契约里存在的 6 个操作（`packages/contracts/openapi.json`）：
 *  - GET    `/admin/sources`            `listAdminSources`       scope `sources:read`
 *  - POST   `/admin/sources`            `createSourceDraft`      scope `sources:write`（201，仅需 Idempotency-Key）
 *  - GET    `/admin/sources/{id}`       `getAdminSource`         scope `sources:read`（响应带强 ETag）
 *  - PATCH  `/admin/sources/{id}`       `editSourceDraft`        scope `sources:write`（Idempotency-Key + If-Match）
 *  - POST   `/admin/sources/{id}/publish`  `publishSource`       scope `sources:write`（+ If-Match，体 `SourcePublishInput`）
 *  - POST   `/admin/sources/{id}/withdraw` `withdrawSource`      scope `sources:write`（+ If-Match，体 `ReasonInput`）
 *
 * 所有判断逻辑都在 `src/lib/admin-content-*.mjs`；本组件只把状态机接到 DOM。
 * 权限判定**不在这里**：`scopes` 只用来提前禁用按钮，真正的拒绝由服务端返回错误码，页面原样显示。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  AUDIT_READ_SCOPE,
  EVIDENCE_KINDS,
  SOURCES_READ_SCOPE,
  SOURCES_WRITE_SCOPE,
  SOURCE_KINDS,
  buildPublishInput,
  buildSourceInput,
  buildWithdrawInput,
  emptySourceForm,
  etagFor,
  newIdempotencyKey,
  sourceFormFromRef,
} from '../lib/admin-content-contract.mjs';
import {
  createSource,
  deriveChanged,
  describeWriteFailure,
  editSource,
  findAuditEventsForRequest,
  getSource,
  listSources,
  publishSource,
  withdrawSource,
} from '../lib/admin-content-api.mjs';
import {
  EVIDENCE_KIND_LABELS,
  LIFECYCLE_NOTE,
  SOURCE_KIND_LABELS,
  canLoadMoreFamily,
  changedVerdict,
  describeFamilyView,
  initialFamilyState,
  reduceFamily,
  sourceDetailView,
  sourceRow,
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
const form = ref(emptySourceForm());
const formErrors = ref([]);
const publishOpen = ref(false);
const publishForm = ref({ evidenceRef: '', reason: '' });
const publishErrors = ref([]);
const withdrawOpen = ref(false);
const withdrawForm = ref({ reason: '' });
const withdrawErrors = ref([]);

// 过期响应保护：换会话/重载后，晚到的旧响应不落状态。
let requestSeq = 0;

const rows = computed(() => state.value.collection.items.map(sourceRow));
const view = computed(() => describeFamilyView(state.value, { label: '资料来源' }));
const detail = computed(() => (state.value.detail === null ? null : sourceDetailView(state.value.detail)));
const detailFailure = computed(() => (state.value.detailFailure === null ? null : describeWriteFailure(state.value.detailFailure)));
const canRead = computed(() => props.scopes.includes(SOURCES_READ_SCOPE));
const canWrite = computed(() => props.scopes.includes(SOURCES_WRITE_SCOPE));
const canAudit = computed(() => props.scopes.includes(AUDIT_READ_SCOPE));
const canLoadMore = computed(() => canLoadMoreFamily(state.value));
const busyWrite = computed(() => state.value.busyWrite === true);
/**
 * 写回执的**显式判定**（喂给 `WriteReceipt` 的 `changed` prop）。
 *
 * `state.write.changed` 由 `deriveChanged()` 算出：发布／撤回读回执里的**必填布尔** `changed`
 * （`SourcePublicationOutcome`：真迁移 `true`、内存幂等短路 `false`）；编辑比 revision 是否前进；
 * 新建的 201 两样都没有 ⇒ `null` ⇒ `'unknown'` ⇒ 回执只写「已受理」。
 * 回执校验器已保证 publish／withdraw 的 `changed` 一定存在且为布尔，所以这里不会把
 * 「契约里有」误当「拿不到」；也**不按 HTTP 200／ok 猜成功** —— 200 既可能是真迁移也可能是 no-op。
 */
const receiptChanged = computed(() => changedVerdict(state.value.write?.changed));
const detailRevision = computed(() => (state.value.detail === null ? null : state.value.detail.revision));
const ifMatchPreview = computed(() => {
  try {
    return etagFor(detailRevision.value);
  } catch {
    return '—';
  }
});

const formTitle = computed(() => (formMode.value === 'create' ? '新建资料来源草稿（POST /admin/sources）' : '编辑资料来源草稿（PATCH /admin/sources/{id}）'));

const fields = computed(() => [
  { key: 'title', label: '标题', type: 'text', required: true, wide: true, placeholder: '资料标题（≤200 字）' },
  { key: 'url', label: '链接', type: 'url', required: true, placeholder: 'https://…' },
  { key: 'publisher', label: '发布方', type: 'text', required: true, placeholder: '机构／作者（≤200 字）' },
  { key: 'version', label: '版本', type: 'text', required: true, placeholder: '如 2026.1（≤80 字）' },
  {
    key: 'source_kind',
    label: '来源类型',
    type: 'select',
    required: true,
    options: SOURCE_KINDS.map((value) => ({ value, label: `${SOURCE_KIND_LABELS[value]}（${value}）` })),
  },
  {
    key: 'evidence_kind',
    label: '证据类型',
    type: 'select',
    required: true,
    options: EVIDENCE_KINDS.map((value) => ({ value, label: `${EVIDENCE_KIND_LABELS[value]}（${value}）` })),
  },
  {
    key: 'content_hash',
    label: '内容指纹',
    type: 'text',
    required: true,
    wide: true,
    hint: '64 位小写十六进制。读面 SourceRef 不返回该字段，编辑时必须按原始资料重新计算后填写。',
  },
  { key: 'locator', label: '定位串', type: 'text', required: true, hint: '如 p12-l34（≤200 字）。读面同样不返回，需重填。' },
  { key: 'valid_from', label: '生效时间', type: 'datetime-local', required: true, hint: '按本地时区选择，提交时转成 RFC 3339（UTC）。' },
  { key: 'valid_to', label: '失效时间', type: 'datetime-local', hint: '留空表示 null（长期有效）。' },
]);

function dispatch(action) {
  state.value = reduceFamily(state.value, action);
}

async function requestPage(cursor, { reset }) {
  const seq = ++requestSeq;
  dispatch({ type: 'LOAD_START', reset });
  const result = await listSources({ baseUrl: props.baseUrl, token: props.token, cursor, limit: 20 });
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
  publishOpen.value = false;
  withdrawOpen.value = false;
  requestPage(null, { reset: true });
}

function loadMore() {
  const cursor = state.value.collection.nextCursor;
  if (cursor === null) return;
  requestPage(cursor, { reset: false });
}

async function openDetail(id) {
  dispatch({ type: 'SELECT', id });
  formMode.value = null;
  publishOpen.value = false;
  withdrawOpen.value = false;
  const seq = ++requestSeq;
  dispatch({ type: 'DETAIL_START' });
  const result = await getSource({ baseUrl: props.baseUrl, token: props.token, id });
  if (seq !== requestSeq) return;
  if (result.ok) {
    dispatch({ type: 'DETAIL_OK', item: result.item });
  } else {
    dispatch({ type: 'DETAIL_FAIL', failure: result });
    if (result.kind === 'signed_out') emit('signed-out');
  }
}

function reloadDetail() {
  if (state.value.selectedId === null) return;
  openDetail(state.value.selectedId);
}

function closeDetail() {
  dispatch({ type: 'SELECT', id: null });
  formMode.value = null;
  publishOpen.value = false;
  withdrawOpen.value = false;
}

function startCreate() {
  dispatch({ type: 'SELECT', id: null });
  form.value = emptySourceForm();
  formErrors.value = [];
  formMode.value = 'create';
  publishOpen.value = false;
  withdrawOpen.value = false;
}

function startEdit() {
  if (state.value.detail === null) return;
  form.value = sourceFormFromRef(state.value.detail.source);
  formErrors.value = [];
  formMode.value = 'edit';
  publishOpen.value = false;
  withdrawOpen.value = false;
}

function cancelForm() {
  formMode.value = null;
  formErrors.value = [];
}

function updateField(key, value) {
  form.value = { ...form.value, [key]: value };
}

/**
 * 执行一次写操作并把回执落到状态里。
 *
 * 成功：用**服务端返回的资源**更新列表行与详情（`ROW_UPSERT` / `DETAIL_OK`），并关闭对应表单。
 * 失败：回执照常落状态（含错误码与本次真实发出的写头），表单不关，用户可改后重试。
 *
 * `action` 只用来算回执的 `changed` 三值（`'create' | 'edit' | 'publish' | 'withdraw'`）；
 * `previousRevision` 是这次编辑**所基于**的 revision（即 If-Match 用的那个），不是响应回传的新值。
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
     * 三值：`true`／`false`／`null`（拿不到契约真值）。publish／withdraw 读回执的必填布尔
     * `changed`，edit 比 revision 前进，create 的 201 两者都没有 ⇒ `null`。回执面板据此写
     * 「成功回执」「已受理（本次未产生变更）」或只写「已受理」。
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
  const built = buildSourceInput(form.value);
  formErrors.value = built.errors;
  if (!built.ok) return;

  if (formMode.value === 'create') {
    const result = await runWrite({
      label: '新建资料来源草稿（POST /admin/sources）',
      action: 'create',
      send: () => createSource({ baseUrl: props.baseUrl, token: props.token, idempotencyKey: newIdempotencyKey(), body: built.value }),
    });
    if (result.ok) formMode.value = null;
    return;
  }

  // 这次编辑**所基于**的 revision（即 If-Match 用的那个），不是响应回传的新 revision。
  const previousRevision = detailRevision.value;
  let ifMatch;
  try {
    ifMatch = etagFor(previousRevision);
  } catch {
    formErrors.value = [{ field: 'title', message: '详情未加载到 revision，无法生成 If-Match：请先点开该行详情' }];
    return;
  }
  const id = state.value.detail.id;
  const result = await runWrite({
    label: '编辑资料来源草稿（PATCH /admin/sources/{id}）',
    action: 'edit',
    previousRevision,
    send: () => editSource({ baseUrl: props.baseUrl, token: props.token, id, ifMatch, idempotencyKey: newIdempotencyKey(), body: built.value }),
  });
  if (result.ok) formMode.value = null;
}

function openPublish() {
  publishForm.value = { evidenceRef: '', reason: '' };
  publishErrors.value = [];
  publishOpen.value = true;
  withdrawOpen.value = false;
  formMode.value = null;
}

async function submitPublish() {
  const built = buildPublishInput(publishForm.value);
  publishErrors.value = built.errors;
  if (!built.ok) return;
  let ifMatch;
  try {
    ifMatch = etagFor(detailRevision.value);
  } catch {
    publishErrors.value = [{ field: 'evidence_ref', message: '详情未加载到 revision，无法生成 If-Match' }];
    return;
  }
  const id = state.value.detail.id;
  const result = await runWrite({
    label: '发布资料来源（POST /admin/sources/{id}/publish）',
    action: 'publish',
    send: () => publishSource({ baseUrl: props.baseUrl, token: props.token, id, ifMatch, idempotencyKey: newIdempotencyKey(), body: built.value }),
  });
  if (result.ok) publishOpen.value = false;
}

function openWithdraw() {
  withdrawForm.value = { reason: '' };
  withdrawErrors.value = [];
  withdrawOpen.value = true;
  publishOpen.value = false;
  formMode.value = null;
}

async function submitWithdraw() {
  const built = buildWithdrawInput(withdrawForm.value);
  withdrawErrors.value = built.errors;
  if (!built.ok) return;
  let ifMatch;
  try {
    ifMatch = etagFor(detailRevision.value);
  } catch {
    withdrawErrors.value = [{ field: 'reason', message: '详情未加载到 revision，无法生成 If-Match' }];
    return;
  }
  const id = state.value.detail.id;
  const result = await runWrite({
    label: '下架资料来源（POST /admin/sources/{id}/withdraw）',
    action: 'withdraw',
    send: () => withdrawSource({ baseUrl: props.baseUrl, token: props.token, id, ifMatch, idempotencyKey: newIdempotencyKey(), body: built.value }),
  });
  if (result.ok) withdrawOpen.value = false;
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
        <h3>资料来源（sources）</h3>
        <p class="sub">
          读 <code>GET {{ baseUrl }}/admin/sources</code>（<code>listAdminSources</code>）· 写
          <code>POST/PATCH …/admin/sources</code>（scope <code>sources:write</code>）。每次写操作都带
          <code>Idempotency-Key</code>；编辑／发布／下架另带 <code>If-Match: "&lt;revision&gt;"</code>。
        </p>
      </div>
      <div class="head-actions">
        <button class="primary" type="button" :disabled="!canWrite || busyWrite" @click="startCreate">新建草稿</button>
        <button class="ghost" type="button" :disabled="busyWrite" @click="refresh">重新读取</button>
      </div>
    </header>

    <p v-if="!canRead" class="banner warn">
      当前后台会话的 scope 列表里没有 <code>sources:read</code>，本页不发列表请求（服务端会回
      <code>403 SCOPE_DENIED</code>）。权限判定以服务端为准。
    </p>
    <p v-else-if="!canWrite" class="banner warn">
      当前会话没有 <code>sources:write</code>：新建／编辑／发布／下架按钮已禁用；真实拒绝仍由服务端判定。
    </p>

    <form v-if="formMode !== null" class="editor" @submit.prevent="submitForm">
      <header>
        <h4>{{ formTitle }}</h4>
        <button class="link" type="button" @click="cancelForm">取消</button>
      </header>
      <p class="hint">
        <template v-if="formMode === 'create'">
          创建时资源还不存在，契约不要求 <code>If-Match</code>；本次仍会带一个新的 <code>Idempotency-Key</code>。
        </template>
        <template v-else>
          将发送 <code>If-Match: {{ ifMatchPreview }}</code>（来自详情 Revision {{ detailRevision }}）。读面不返回内容指纹／定位串／有效期，
          下表这些字段需要按原始资料重新填写，页面不会用旧值冒充。
        </template>
      </p>
      <ContentFieldGrid :fields="fields" :form="form" :errors="formErrors" :disabled="busyWrite" @update="updateField" />
      <div class="row">
        <button class="primary" type="submit" :disabled="busyWrite || !canWrite">{{ busyWrite ? '提交中…' : formMode === 'create' ? '创建草稿' : '保存编辑' }}</button>
        <button class="ghost" type="button" :disabled="busyWrite" @click="cancelForm">取消</button>
      </div>
    </form>

    <form v-if="publishOpen" class="editor" @submit.prevent="submitPublish">
      <header>
        <h4>发布（POST /admin/sources/{id}/publish）</h4>
        <button class="link" type="button" @click="publishOpen = false">取消</button>
      </header>
      <p class="hint">
        服务端会核对受控 <code>evidence_ref</code>、责任人、登记制剂与有效期门槛；未通过会返回 <code>INVALID_REQUEST</code>／
        <code>SOURCE_CONFLICT</code>，页面原样显示错误码。本次将带 <code>If-Match: {{ ifMatchPreview }}</code>。
      </p>
      <ContentFieldGrid
        :fields="[
          { key: 'evidenceRef', label: '证据引用 evidence_ref', type: 'text', required: true, wide: true, hint: '服务端只接受受控引用（≤80 字）' },
          { key: 'reason', label: '发布理由 reason', type: 'textarea', required: true, wide: true, hint: '≤500 字，会进审计 reason_code 之外的说明' },
        ]"
        :form="publishForm"
        :errors="publishErrors"
        :disabled="busyWrite"
        @update="(key, value) => (publishForm = { ...publishForm, [key]: value })"
      />
      <div class="row">
        <button class="primary" type="submit" :disabled="busyWrite || !canWrite">{{ busyWrite ? '提交中…' : '确认发布' }}</button>
        <button class="ghost" type="button" :disabled="busyWrite" @click="publishOpen = false">取消</button>
      </div>
    </form>

    <form v-if="withdrawOpen" class="editor" @submit.prevent="submitWithdraw">
      <header>
        <h4>下架（POST /admin/sources/{id}/withdraw）</h4>
        <button class="link" type="button" @click="withdrawOpen = false">取消</button>
      </header>
      <p class="hint">
        从未发布过的资料下架会返回 <code>409 OBJECT_UNAVAILABLE</code>；已下架的重复下架是 200 幂等 no-op（服务端不再写审计）。
        本次将带 <code>If-Match: {{ ifMatchPreview }}</code>。
      </p>
      <ContentFieldGrid
        :fields="[{ key: 'reason', label: '下架理由 reason', type: 'textarea', required: true, wide: true, hint: '≤500 字' }]"
        :form="withdrawForm"
        :errors="withdrawErrors"
        :disabled="busyWrite"
        @update="(key, value) => (withdrawForm = { ...withdrawForm, [key]: value })"
      />
      <div class="row">
        <button class="primary" type="submit" :disabled="busyWrite || !canWrite">{{ busyWrite ? '提交中…' : '确认下架' }}</button>
        <button class="ghost" type="button" :disabled="busyWrite" @click="withdrawOpen = false">取消</button>
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
          <th>标题</th>
          <th>版本</th>
          <th>状态</th>
          <th>核验</th>
          <th>更新时间</th>
          <th>修订</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="row in rows"
          :key="row.id"
          :class="{ selected: row.id === state.selectedId }"
          @click="openDetail(row.id)"
        >
          <td>{{ row.title }}</td>
          <td class="mono">{{ row.versionLabel }}</td>
          <td><span class="pill" :class="row.statusTone">{{ row.statusLabel }}</span></td>
          <td><span class="pill" :class="row.reviewTone">{{ row.reviewLabel }}</span></td>
          <td class="mono">{{ row.updatedLabel }}</td>
          <td class="mono" :title="row.id">{{ row.revisionLabel }}</td>
          <td class="right"><button class="link" type="button">详情</button></td>
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

    <p class="note">{{ LIFECYCLE_NOTE }}</p>

    <WriteReceipt
      :write="state.write"
      :changed="receiptChanged"
      :audit-lookup="state.auditLookup"
      :can-audit="canAudit"
      :can-reload-detail="state.selectedId !== null"
      @lookup-audit="lookupAudit"
      @clear-receipt="dispatch({ type: 'WRITE_CLEAR' })"
      @reload-detail="reloadDetail"
    />

    <aside v-if="state.selectedId !== null" class="detail">
      <header>
        <h4>详情</h4>
        <button class="link" type="button" @click="closeDetail">关闭</button>
      </header>

      <p v-if="state.detailPhase === 'loading'" class="note">正在读取 GET /admin/sources/{id}…</p>
      <div v-else-if="detailFailure !== null" class="status error" role="alert">
        <strong>{{ detailFailure.title }}</strong>
        <span>{{ detailFailure.detail }}</span>
        <button class="link" type="button" @click="reloadDetail">重读详情</button>
      </div>
      <template v-else-if="detail !== null">
        <dl>
          <template v-for="field in detail.fields" :key="field.label">
            <dt>{{ field.label }}</dt>
            <dd class="mono">{{ field.value }}</dd>
          </template>
        </dl>
        <p class="missing">读面未提供：{{ detail.missing.join('、') }}。</p>
        <p class="note">{{ detail.note }}</p>
        <div class="row">
          <button class="primary" type="button" :disabled="!canWrite || busyWrite" @click="startEdit">编辑草稿</button>
          <button class="ghost" type="button" :disabled="!canWrite || busyWrite" @click="openPublish">发布</button>
          <button class="ghost" type="button" :disabled="!canWrite || busyWrite" @click="openWithdraw">下架</button>
          <button class="link" type="button" @click="reloadDetail">重读详情</button>
        </div>
      </template>
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
.head-actions {
  display: flex;
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
.row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
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
