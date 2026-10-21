<script setup>
/**
 * 科普内容管理页（#18 核心，B8）。
 *
 * 契约 6 个操作：GET/POST `/admin/knowledge`、GET/PATCH `/admin/knowledge/{id}`、
 * POST `/admin/knowledge/{id}/publish`（体同为 `SourcePublishInput`）、POST `/admin/knowledge/{id}/withdraw`（体 `ReasonInput`）。
 * scope 与资料来源同源：`sources:read` / `sources:write`。
 *
 * 与资料来源页的差别（都来自契约，不是页面偏好）：
 *  - `KnowledgeDraft.content` 是**完整** `KnowledgeDraftInput`，因此编辑时能整表回填；
 *  - 读面没有 `updated_at`，表格时间列如实写「契约未提供」；
 *  - 发布时要引用一条来源（`source_id` + `source_version`），页面只**读**来源列表帮忙挑选，不代替服务端校验。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  AUDIT_READ_SCOPE,
  KNOWLEDGE_TYPES,
  SOURCES_READ_SCOPE,
  SOURCES_WRITE_SCOPE,
  buildKnowledgeInput,
  buildPublishInput,
  buildWithdrawInput,
  emptyKnowledgeForm,
  etagFor,
  knowledgeFormFromDetail,
  newIdempotencyKey,
} from '../lib/admin-content-contract.mjs';
import {
  createKnowledge,
  describeWriteFailure,
  editKnowledge,
  findAuditEventsForRequest,
  getKnowledge,
  listKnowledge,
  listSources,
  publishKnowledge,
  withdrawKnowledge,
} from '../lib/admin-content-api.mjs';
import {
  KNOWLEDGE_TYPE_LABELS,
  LIFECYCLE_NOTE,
  canLoadMoreFamily,
  describeFamily,
  initialFamilyState,
  knowledgeDetailView,
  knowledgeRow,
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
const form = ref(emptyKnowledgeForm());
const formErrors = ref([]);
const publishOpen = ref(false);
const publishForm = ref({ evidenceRef: '', reason: '' });
const publishErrors = ref([]);
const withdrawOpen = ref(false);
const withdrawForm = ref({ reason: '' });
const withdrawErrors = ref([]);

// 来源挑选（只读辅助，不代替服务端引用校验）
const sourceOptions = ref([]);
const sourceLoading = ref(false);
const sourceFailure = ref(null);
const pickedSourceId = ref('');

let requestSeq = 0;

const rows = computed(() => state.value.collection.items.map(knowledgeRow));
const view = computed(() => describeFamily(state.value, { label: '科普内容' }));
const detail = computed(() => (state.value.detail === null ? null : knowledgeDetailView(state.value.detail)));
const detailFailure = computed(() => (state.value.detailFailure === null ? null : describeWriteFailure(state.value.detailFailure)));
const canRead = computed(() => props.scopes.includes(SOURCES_READ_SCOPE));
const canWrite = computed(() => props.scopes.includes(SOURCES_WRITE_SCOPE));
const canAudit = computed(() => props.scopes.includes(AUDIT_READ_SCOPE));
const canLoadMore = computed(() => canLoadMoreFamily(state.value));
const busyWrite = computed(() => state.value.busyWrite === true);
const detailRevision = computed(() => (state.value.detail === null ? null : state.value.detail.revision));
const ifMatchPreview = computed(() => {
  try {
    return etagFor(detailRevision.value);
  } catch {
    return '—';
  }
});
const formTitle = computed(() => (formMode.value === 'create' ? '新建科普内容草稿（POST /admin/knowledge）' : '编辑科普内容草稿（PATCH /admin/knowledge/{id}）'));

const fields = computed(() => [
  {
    key: 'type',
    label: '类型',
    type: 'select',
    required: true,
    options: KNOWLEDGE_TYPES.map((value) => ({ value, label: `${KNOWLEDGE_TYPE_LABELS[value]}（${value}）` })),
  },
  { key: 'title', label: '标题', type: 'text', required: true, placeholder: '≤200 字' },
  { key: 'body', label: '正文', type: 'textarea', required: true, wide: true, hint: '≤20000 字。不使用处方混配换算口径。' },
  { key: 'source_id', label: '来源 ID', type: 'text', required: true, hint: 'uuid；可用下方「从来源列表挑选」回填。' },
  { key: 'source_version', label: '来源版本', type: 'text', required: true, hint: '必须与来源的 version 一致（≤80 字）。' },
  { key: 'with_conditions', label: '带适用条件（conditions）', type: 'checkbox', hint: '不勾选时提交 conditions: null。' },
  { key: 'crop_id', label: '作物 ID', type: 'text', hint: '勾选条件时必填（≤80 字）。' },
  { key: 'region_code', label: '地区码', type: 'text', hint: '勾选条件时必填，33 开头 6 位数字。' },
  { key: 'species_id', label: '物种 ID', type: 'text', hint: '可选。' },
  { key: 'growth_stage', label: '生育期', type: 'text', hint: '可选（≤80 字）。' },
  { key: 'formulation_id', label: '制剂 ID', type: 'text', hint: '可选；留空表示 null。' },
]);

function dispatch(action) {
  state.value = reduceFamily(state.value, action);
}

async function requestPage(cursor, { reset }) {
  const seq = ++requestSeq;
  dispatch({ type: 'LOAD_START', reset });
  const result = await listKnowledge({ baseUrl: props.baseUrl, token: props.token, cursor, limit: 20 });
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
  const result = await getKnowledge({ baseUrl: props.baseUrl, token: props.token, id });
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
  form.value = emptyKnowledgeForm();
  formErrors.value = [];
  formMode.value = 'create';
  publishOpen.value = false;
  withdrawOpen.value = false;
}

function startEdit() {
  if (state.value.detail === null) return;
  form.value = knowledgeFormFromDetail(state.value.detail);
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

async function loadSourceOptions() {
  sourceLoading.value = true;
  sourceFailure.value = null;
  const result = await listSources({ baseUrl: props.baseUrl, token: props.token, limit: 20 });
  sourceLoading.value = false;
  if (result.ok) {
    sourceOptions.value = result.page.items;
    if (result.page.items.length > 0 && pickedSourceId.value === '') pickedSourceId.value = result.page.items[0].id;
    return;
  }
  sourceOptions.value = [];
  sourceFailure.value = result;
  if (result.kind === 'signed_out') emit('signed-out');
}

function applyPickedSource() {
  const picked = sourceOptions.value.find((item) => item.id === pickedSourceId.value);
  if (picked === undefined) return;
  form.value = { ...form.value, source_id: picked.id, source_version: picked.source.version };
}

async function runWrite(label, send) {
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
  const built = buildKnowledgeInput(form.value);
  formErrors.value = built.errors;
  if (!built.ok) return;

  if (formMode.value === 'create') {
    const result = await runWrite('新建科普内容草稿（POST /admin/knowledge）', () =>
      createKnowledge({ baseUrl: props.baseUrl, token: props.token, idempotencyKey: newIdempotencyKey(), body: built.value }),
    );
    if (result.ok) formMode.value = null;
    return;
  }

  let ifMatch;
  try {
    ifMatch = etagFor(detailRevision.value);
  } catch {
    formErrors.value = [{ field: 'title', message: '详情未加载到 revision，无法生成 If-Match：请先点开该行详情' }];
    return;
  }
  const id = state.value.detail.id;
  const result = await runWrite('编辑科普内容草稿（PATCH /admin/knowledge/{id}）', () =>
    editKnowledge({ baseUrl: props.baseUrl, token: props.token, id, ifMatch, idempotencyKey: newIdempotencyKey(), body: built.value }),
  );
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
  const result = await runWrite('发布科普内容（POST /admin/knowledge/{id}/publish）', () =>
    publishKnowledge({ baseUrl: props.baseUrl, token: props.token, id, ifMatch, idempotencyKey: newIdempotencyKey(), body: built.value }),
  );
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
  const result = await runWrite('下架科普内容（POST /admin/knowledge/{id}/withdraw）', () =>
    withdrawKnowledge({ baseUrl: props.baseUrl, token: props.token, id, ifMatch, idempotencyKey: newIdempotencyKey(), body: built.value }),
  );
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
        <h3>科普内容（knowledge）</h3>
        <p class="sub">
          读 <code>GET {{ baseUrl }}/admin/knowledge</code>（<code>listAdminKnowledge</code>）· 写
          <code>POST/PATCH …/admin/knowledge</code>（scope <code>sources:write</code>）。写操作带
          <code>Idempotency-Key</code>，编辑／发布／下架另带 <code>If-Match</code>。
        </p>
      </div>
      <div class="head-actions">
        <button class="primary" type="button" :disabled="!canWrite || busyWrite" @click="startCreate">新建草稿</button>
        <button class="ghost" type="button" :disabled="busyWrite" @click="refresh">重新读取</button>
      </div>
    </header>

    <p v-if="!canRead" class="banner warn">
      当前后台会话的 scope 列表里没有 <code>sources:read</code>，本页不发列表请求（服务端会回
      <code>403 SCOPE_DENIED</code>）。
    </p>
    <p v-else-if="!canWrite" class="banner warn">
      当前会话没有 <code>sources:write</code>：写操作按钮已禁用；真实拒绝仍由服务端判定。
    </p>

    <form v-if="formMode !== null" class="editor" @submit.prevent="submitForm">
      <header>
        <h4>{{ formTitle }}</h4>
        <button class="link" type="button" @click="cancelForm">取消</button>
      </header>
      <p class="hint">
        <template v-if="formMode === 'create'">
          创建时资源还不存在，契约不要求 <code>If-Match</code>；本次仍带新的 <code>Idempotency-Key</code>。
        </template>
        <template v-else>
          将发送 <code>If-Match: {{ ifMatchPreview }}</code>（来自详情 Revision {{ detailRevision }}）。`KnowledgeDraft.content`
          是完整输入体，下表已按详情回填。
        </template>
      </p>

      <div class="picker">
        <span class="label">从来源列表挑选（只读，scope <code>sources:read</code>）</span>
        <button class="ghost" type="button" :disabled="sourceLoading" @click="loadSourceOptions">
          {{ sourceLoading ? '读取中…' : '读取来源列表' }}
        </button>
        <select v-if="sourceOptions.length > 0" v-model="pickedSourceId">
          <option v-for="item in sourceOptions" :key="item.id" :value="item.id">
            {{ item.source.title }} · {{ item.source.version }} · {{ item.visibility }}
          </option>
        </select>
        <button class="link" type="button" :disabled="sourceOptions.length === 0" @click="applyPickedSource">回填 source_id / source_version</button>
        <span v-if="sourceFailure !== null" class="err">
          来源列表读取失败：{{ sourceFailure.code ?? '无错误码' }}（HTTP {{ sourceFailure.status ?? '—' }}）{{ sourceFailure.message }}
        </span>
      </div>

      <ContentFieldGrid :fields="fields" :form="form" :errors="formErrors" :disabled="busyWrite" @update="updateField" />
      <div class="row">
        <button class="primary" type="submit" :disabled="busyWrite || !canWrite">{{ busyWrite ? '提交中…' : formMode === 'create' ? '创建草稿' : '保存编辑' }}</button>
        <button class="ghost" type="button" :disabled="busyWrite" @click="cancelForm">取消</button>
      </div>
    </form>

    <form v-if="publishOpen" class="editor" @submit.prevent="submitPublish">
      <header>
        <h4>发布（POST /admin/knowledge/{id}/publish）</h4>
        <button class="link" type="button" @click="publishOpen = false">取消</button>
      </header>
      <p class="hint">
        请求体与资料来源发布同为 <code>SourcePublishInput</code>。服务端核对来源／证据／剂量规则；未通过返回
        <code>INVALID_REQUEST</code>／<code>SOURCE_CONFLICT</code>，页面原样显示。本次带 <code>If-Match: {{ ifMatchPreview }}</code>。
      </p>
      <ContentFieldGrid
        :fields="[
          { key: 'evidenceRef', label: '证据引用 evidence_ref', type: 'text', required: true, wide: true, hint: '≤80 字，受控引用' },
          { key: 'reason', label: '发布理由 reason', type: 'textarea', required: true, wide: true, hint: '≤500 字' },
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
        <h4>下架（POST /admin/knowledge/{id}/withdraw）</h4>
        <button class="link" type="button" @click="withdrawOpen = false">取消</button>
      </header>
      <p class="hint">
        未发布过的内容下架返回 <code>409 OBJECT_UNAVAILABLE</code>；已下架的重复下架是 200 幂等 no-op。本次带
        <code>If-Match: {{ ifMatchPreview }}</code>。
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
          <th>类型</th>
          <th>来源版本</th>
          <th>状态</th>
          <th>核验</th>
          <th>时间</th>
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
          <td>{{ row.typeLabel }}</td>
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

      <p v-if="state.detailPhase === 'loading'" class="note">正在读取 GET /admin/knowledge/{id}…</p>
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
.head-actions,
.picker,
.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}
.picker {
  border: 1px dashed #cbd5e0;
  border-radius: 8px;
  padding: 0.5rem 0.7rem;
  font-size: 0.84rem;
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
select,
input,
textarea {
  padding: 0.4rem 0.55rem;
  border: 1px solid #cbd5e0;
  border-radius: 8px;
  font: inherit;
  background: #fff;
}
.err {
  color: #c53030;
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
