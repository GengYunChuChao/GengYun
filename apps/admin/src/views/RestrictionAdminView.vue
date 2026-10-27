<script setup>
/**
 * 限制资料管理页（#18 · 切片 1）——契约 `packages/contracts/openapi.json` 的 6 个操作：
 *  - GET    `/admin/restrictions`               `listAdminRestriction`  scope `sources:read`
 *  - POST   `/admin/restrictions`               `createRestrictionDraft` scope `sources:write`（201，仅 Idempotency-Key）
 *  - GET    `/admin/restrictions/{id}`          `getAdminRestriction`   scope `sources:read`
 *  - PATCH  `/admin/restrictions/{id}`          `editRestrictionDraft`  （Idempotency-Key + If-Match）
 *  - POST   `/admin/restrictions/{id}/publish`  `publishRestriction`    （+ If-Match，体 `SourcePublishInput`）
 *  - POST   `/admin/restrictions/{id}/withdraw` `withdrawRestriction`   （+ If-Match，体 `ReasonInput`）
 *
 * 字段按 `RestrictionInput`（:15189）逐条对齐：`{source_id, source_version, formulation_id(可 null),
 * conditions(不可 null), effect(闭集三值), reason, valid_from, valid_to(可 null)}`；
 * 读面 `Restriction`（:15256）只有 `{id, revision, content, review_status}` —— **没有 visibility**。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  AUDIT_READ_SCOPE,
  RESTRICTION_EFFECTS,
  SOURCES_READ_SCOPE,
  SOURCES_WRITE_SCOPE,
  buildPublishInput,
  buildRestrictionInput,
  buildWithdrawInput,
  emptyRestrictionForm,
  etagFor,
  newIdempotencyKey,
  restrictionFormFromDetail,
} from '../lib/admin-content-contract.mjs';
import {
  createRestriction,
  deriveChanged,
  describeWriteFailure,
  describeWriteOutcome,
  editRestriction,
  findAuditEventsForRequest,
  getRestriction,
  listRestriction,
  publishRestriction,
  withdrawRestriction,
} from '../lib/admin-content-api.mjs';
import {
  EFFECT_LABELS,
  RESTRICTION_NOTE,
  canLoadMoreFamily,
  changedVerdict,
  describeFamilyView,
  initialFamilyState,
  reduceFamily,
  restrictionDetailView,
  restrictionRow,
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
const form = ref(emptyRestrictionForm());
const formErrors = ref([]);
const publishOpen = ref(false);
const publishForm = ref({ evidenceRef: '', reason: '' });
const publishErrors = ref([]);
const withdrawOpen = ref(false);
const withdrawForm = ref({ reason: '' });
const withdrawErrors = ref([]);
/** 2xx 回执的文案（`changed` 三值在这里如实呈现，见 `describeWriteOutcome`）。 */
const outcome = ref(null);

let requestSeq = 0;

const rows = computed(() => state.value.collection.items.map(restrictionRow));
const view = computed(() => describeFamilyView(state.value, { label: '限制资料' }));
const detail = computed(() => (state.value.detail === null ? null : restrictionDetailView(state.value.detail)));
const detailFailure = computed(() => (state.value.detailFailure === null ? null : describeWriteFailure(state.value.detailFailure)));
const failureView = computed(() => (state.value.failure === null ? null : describeWriteFailure(state.value.failure)));
const canRead = computed(() => props.scopes.includes(SOURCES_READ_SCOPE));
const canWrite = computed(() => props.scopes.includes(SOURCES_WRITE_SCOPE));
const canAudit = computed(() => props.scopes.includes(AUDIT_READ_SCOPE));
const canLoadMore = computed(() => canLoadMoreFamily(state.value));
const busyWrite = computed(() => state.value.busyWrite === true);
/**
 * 写回执的**显式判定**（喂给 `WriteReceipt` 的 `changed` prop）。
 * `state.write.changed` 由 `deriveChanged()` 算出：发布／撤回读回执里的**必填布尔** `changed`
 * （`RestrictionPublicationOutcome`：真迁移 `true`、内存幂等短路 `false`），新建的 201 拿不到
 * ⇒ `null` ⇒ `'unknown'` ⇒ 只写「已受理」。
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

const formTitle = computed(() =>
  formMode.value === 'create'
    ? '新建限制资料草稿（POST /admin/restrictions）'
    : '编辑限制资料草稿（PATCH /admin/restrictions/{id}）',
);

const fields = computed(() => [
  { key: 'source_id', label: '来源 ID source_id', type: 'text', required: true, placeholder: 'uuid（可在「来源」子页核对）' },
  { key: 'source_version', label: '来源版本 source_version', type: 'text', required: true, placeholder: '≤80 字' },
  { key: 'formulation_id', label: '制剂 ID formulation_id', type: 'text', hint: 'uuid 或留空（契约允许 null）' },
  {
    key: 'effect',
    label: '限制结论 effect',
    type: 'select',
    required: true,
    options: RESTRICTION_EFFECTS.map((value) => ({ value, label: `${EFFECT_LABELS[value]}（${value}）` })),
  },
  { key: 'reason', label: '理由 reason', type: 'textarea', required: true, wide: true, hint: '≤2000 字' },
  { key: 'valid_from', label: '生效时间 valid_from', type: 'datetime-local', required: true, hint: '按本地时区选择，提交时转成 RFC 3339（UTC）。' },
  { key: 'valid_to', label: '失效时间 valid_to', type: 'datetime-local', hint: '留空表示 null（长期有效）。' },
  { key: 'crop_id', label: '条件 · 作物 ID crop_id', type: 'text', required: true, hint: '契约 Conditions 的 required，不可为空' },
  { key: 'region_code', label: '条件 · 地区码 region_code', type: 'text', required: true, hint: '33 开头的 6 位数字（^33[0-9]{4}$）' },
  { key: 'species_id', label: '条件 · 物种 ID species_id', type: 'text', hint: '可选，≤80 字' },
  { key: 'growth_stage', label: '条件 · 生育期 growth_stage', type: 'text', hint: '可选，≤80 字' },
  { key: 'planting_method', label: '条件 · 种植方式 planting_method', type: 'text', hint: '可选，≤80 字' },
  { key: 'use_scene', label: '条件 · 使用场景 use_scene', type: 'text', hint: '可选，≤80 字' },
]);

function dispatch(action) {
  state.value = reduceFamily(state.value, action);
}

async function requestPage(cursor, { reset }) {
  const seq = ++requestSeq;
  dispatch({ type: 'LOAD_START', reset });
  const result = await listRestriction({ baseUrl: props.baseUrl, token: props.token, cursor, limit: 20 });
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
  const result = await getRestriction({ baseUrl: props.baseUrl, token: props.token, id });
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
  form.value = emptyRestrictionForm();
  formErrors.value = [];
  formMode.value = 'create';
  publishOpen.value = false;
  withdrawOpen.value = false;
}

function startEdit() {
  // R1：只允许编辑**当前选中**的那一行（`detail` 可能由新建成功路径单独写入，
  // 不能只看 `detail !== null`，否则能对一个未被选中的对象发起 PATCH）。
  if (state.value.selectedId === null || state.value.detail === null) return;
  form.value = restrictionFormFromDetail(state.value.detail);
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
     * `changed`，edit 比 revision 前进；回执面板据此写「成功回执」「已受理（本次未产生变更）」
     * 或只写「已受理」。
     */
    changed: deriveChanged(action, result, { previousRevision }),
  };
  dispatch({ type: 'WRITE_SETTLED', receipt });
  outcome.value = describeWriteOutcome(result, { action, previousRevision, familyLabel: '限制资料' });
  if (result.ok) {
    // R1：新建成功后**同时选中**新对象（选中态与详情态必须一致）。
    if (action === 'create') dispatch({ type: 'SELECT', id: result.item.id });
    dispatch({ type: 'ROW_UPSERT', item: result.item });
    dispatch({ type: 'DETAIL_OK', item: result.item });
    return result;
  }
  if (result.kind === 'signed_out') emit('signed-out');
  return result;
}

async function submitForm() {
  const built = buildRestrictionInput(form.value);
  formErrors.value = built.errors;
  if (!built.ok) return;

  if (formMode.value === 'create') {
    const result = await runWrite({
      label: '新建限制资料草稿（POST /admin/restrictions）',
      action: 'create',
      send: () => createRestriction({ baseUrl: props.baseUrl, token: props.token, idempotencyKey: newIdempotencyKey(), body: built.value }),
    });
    if (result.ok) formMode.value = null;
    return;
  }

  let ifMatch;
  try {
    ifMatch = etagFor(detailRevision.value);
  } catch {
    formErrors.value = [{ field: 'reason', message: '详情未加载到 revision，无法生成 If-Match：请先点开该行详情' }];
    return;
  }
  const id = state.value.detail.id;
  const previousRevision = detailRevision.value;
  const result = await runWrite({
    label: '编辑限制资料草稿（PATCH /admin/restrictions/{id}）',
    action: 'edit',
    previousRevision,
    send: () => editRestriction({ baseUrl: props.baseUrl, token: props.token, id, ifMatch, idempotencyKey: newIdempotencyKey(), body: built.value }),
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
    label: '发布限制资料（POST /admin/restrictions/{id}/publish）',
    action: 'publish',
    send: () => publishRestriction({ baseUrl: props.baseUrl, token: props.token, id, ifMatch, idempotencyKey: newIdempotencyKey(), body: built.value }),
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
    label: '撤回限制资料（POST /admin/restrictions/{id}/withdraw）',
    action: 'withdraw',
    send: () => withdrawRestriction({ baseUrl: props.baseUrl, token: props.token, id, ifMatch, idempotencyKey: newIdempotencyKey(), body: built.value }),
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
        <h3>限制资料（restrictions）</h3>
        <p class="sub">
          读 <code>GET {{ baseUrl }}/admin/restrictions</code>（<code>listAdminRestriction</code>，scope <code>sources:read</code>）· 写
          <code>POST/PATCH …/admin/restrictions</code>（scope <code>sources:write</code>）。每次写操作都带
          <code>Idempotency-Key</code>；编辑／发布／撤回另带 <code>If-Match: "&lt;revision&gt;"</code>。
        </p>
        <p class="sub">
          本页只调用契约里的 6 个操作：<code>listAdminRestriction</code> · <code>getAdminRestriction</code> ·
          <code>createRestrictionDraft</code> · <code>editRestrictionDraft</code> · <code>publishRestriction</code> ·
          <code>withdrawRestriction</code>。
        </p>
      </div>
      <div class="head-actions">
        <button class="primary" type="button" data-testid="create" :disabled="!canWrite || busyWrite" @click="startCreate">新建草稿</button>
        <button class="ghost" type="button" data-testid="refresh" :disabled="busyWrite" @click="refresh">重新读取</button>
      </div>
    </header>

    <p v-if="!canRead" class="banner warn" data-testid="scope-banner">
      当前后台会话的 scope 列表里没有 <code>sources:read</code>，本页不发列表请求（服务端会回
      <code>403 SCOPE_DENIED</code>）。权限判定以服务端为准。
    </p>
    <p v-else-if="!canWrite" class="banner warn" data-testid="scope-banner">
      当前会话没有 <code>sources:write</code>：新建／编辑／发布／撤回按钮已禁用；真实拒绝仍由服务端判定。
    </p>

    <form v-if="formMode !== null" class="editor" data-testid="restriction-form" @submit.prevent="submitForm">
      <header>
        <h4>{{ formTitle }}</h4>
        <button class="link" type="button" @click="cancelForm">取消</button>
      </header>
      <p class="hint">
        <template v-if="formMode === 'create'">
          创建时资源还不存在，契约不要求 <code>If-Match</code>；本次仍会带一个新的 <code>Idempotency-Key</code>。
        </template>
        <template v-else>
          将发送 <code>If-Match: {{ ifMatchPreview }}</code>（来自详情 Revision {{ detailRevision }}）。
          <code>Restriction.content</code> 是完整输入，编辑时各字段已按服务端返回的值回填。
        </template>
      </p>
      <ContentFieldGrid :fields="fields" :form="form" :errors="formErrors" :disabled="busyWrite" @update="updateField" />
      <div class="row">
        <button class="primary" type="submit" data-testid="submit" :disabled="busyWrite || !canWrite">{{ busyWrite ? '提交中…' : formMode === 'create' ? '创建草稿' : '保存编辑' }}</button>
        <button class="ghost" type="button" :disabled="busyWrite" @click="cancelForm">取消</button>
      </div>
    </form>

    <form v-if="publishOpen" class="editor" data-testid="publish-form" @submit.prevent="submitPublish">
      <header>
        <h4>发布（POST /admin/restrictions/{id}/publish）</h4>
        <button class="link" type="button" @click="publishOpen = false">取消</button>
      </header>
      <p class="hint">
        请求体是契约共用的 <code>SourcePublishInput</code>（<code>evidence_ref</code> + <code>reason</code>）。
        未通过门槛返回 <code>INVALID_REQUEST</code>／<code>SOURCE_CONFLICT</code>，页面原样显示错误码。
        本次将带 <code>If-Match: {{ ifMatchPreview }}</code>。
      </p>
      <ContentFieldGrid
        :fields="[
          { key: 'evidenceRef', label: '证据引用 evidence_ref', type: 'text', required: true, wide: true, hint: '服务端只接受受控引用（≤80 字）' },
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

    <form v-if="withdrawOpen" class="editor" data-testid="withdraw-form" @submit.prevent="submitWithdraw">
      <header>
        <h4>撤回（POST /admin/restrictions/{id}/withdraw）</h4>
        <button class="link" type="button" @click="withdrawOpen = false">取消</button>
      </header>
      <p class="hint">
        请求体是契约共用的 <code>ReasonInput</code>。从未发布过的资料撤回会返回
        <code>409 OBJECT_UNAVAILABLE</code>；已撤回的重复撤回是 200 幂等 no-op（服务端不再写审计，本页也不会显示成「刚刚成功」）。
        本次将带 <code>If-Match: {{ ifMatchPreview }}</code>。
      </p>
      <ContentFieldGrid
        :fields="[{ key: 'reason', label: '撤回理由 reason', type: 'textarea', required: true, wide: true, hint: '≤500 字' }]"
        :form="withdrawForm"
        :errors="withdrawErrors"
        :disabled="busyWrite"
        @update="(key, value) => (withdrawForm = { ...withdrawForm, [key]: value })"
      />
      <div class="row">
        <button class="primary" type="submit" :disabled="busyWrite || !canWrite">{{ busyWrite ? '提交中…' : '确认撤回' }}</button>
        <button class="ghost" type="button" :disabled="busyWrite" @click="withdrawOpen = false">取消</button>
      </div>
    </form>

    <div class="status" :class="view.tone" :role="view.tone === 'error' ? 'alert' : 'status'" data-testid="family-status">
      <strong>{{ view.title }}</strong>
      <span>{{ view.detail }}</span>
      <button v-if="view.canRetry" class="link" type="button" @click="refresh">重试</button>
    </div>

    <div v-if="failureView !== null && view.phase !== 'unwired'" class="status error" role="alert" data-testid="failure-banner">
      <strong>{{ failureView.title }}</strong>
      <span>{{ failureView.detail }}</span>
    </div>

    <table v-if="rows.length > 0" class="grid" data-testid="rows">
      <thead>
        <tr>
          <th>限制结论</th>
          <th>条件（作物 / 地区）</th>
          <th>来源版本</th>
          <th>理由</th>
          <th>核验</th>
          <th>修订</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="row in rows"
          :key="row.id"
          :class="{ selected: row.id === state.selectedId }"
          tabindex="0"
          :aria-label="`打开限制结论「${row.effectLabel} · ${row.conditionsLabel}」详情（${row.id}）`"
          @click="openDetail(row.id)"
          @keydown.enter.self.prevent="openDetail(row.id)"
          @keydown.space.self.prevent="openDetail(row.id)"
        >
          <td><span class="pill" :class="row.effectTone">{{ row.effectLabel }}</span></td>
          <td class="mono">{{ row.conditionsLabel }}</td>
          <td class="mono">{{ row.versionLabel }}</td>
          <td>{{ row.reasonLabel }}</td>
          <td><span class="pill" :class="row.reviewTone">{{ row.reviewLabel }}</span></td>
          <td class="mono" :title="row.id">{{ row.revisionLabel }}</td>
          <td class="right">
            <button
              class="link"
              type="button"
              :aria-label="`打开限制结论「${row.effectLabel} · ${row.conditionsLabel}」详情（${row.id}）`"
              @click.stop="openDetail(row.id)"
            >
              详情
            </button>
          </td>
        </tr>
      </tbody>
    </table>

    <div class="toolbar">
      <button v-if="canLoadMore" class="ghost" type="button" :disabled="busyWrite" @click="loadMore">加载下一页</button>
      <span v-if="state.collection.duplicates > 0" class="foot">续页中有 {{ state.collection.duplicates }} 行与已加载行 ID 重复，已去重（未重复计数）。</span>
      <span v-if="state.collection.cycle" class="foot warn-text">服务端把请求游标原样返回，已停止续页以防死循环。</span>
    </div>

    <p class="note">{{ RESTRICTION_NOTE }}</p>

    <div v-if="outcome !== null" class="status outcome" :class="outcome.tone" role="status" data-testid="outcome">
      <strong>{{ outcome.title }}</strong>
      <span>{{ outcome.detail }}</span>
      <span class="changed">changed：{{ outcome.changedLabel }}</span>
      <span class="advice">{{ outcome.advice }}</span>
    </div>

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

      <p v-if="state.detailPhase === 'loading'" class="note">正在读取 GET /admin/restrictions/{id}…</p>
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
          <button class="primary" type="button" data-testid="start-edit" :disabled="!canWrite || busyWrite" @click="startEdit">编辑草稿</button>
          <button class="ghost" type="button" data-testid="open-publish" :disabled="!canWrite || busyWrite" @click="openPublish">发布</button>
          <button class="ghost" type="button" data-testid="open-withdraw" :disabled="!canWrite || busyWrite" @click="openWithdraw">撤回</button>
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
.small {
  font-size: 0.84rem;
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
  display: grid;
  gap: 0.15rem;
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
.status.warn {
  background: #fffbeb;
  border-left-color: #b7791f;
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
.status .changed,
.status .advice {
  font-size: 0.82rem;
  color: #4a5568;
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
