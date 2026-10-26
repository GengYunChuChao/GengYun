<script setup>
/**
 * 写操作回执面板（#18 验收「关键修改留责任人和范围」的展示面）。
 *
 * 显示的是**这一次请求真的发生了什么**：
 *  - 服务端返回的 HTTP 状态、`meta.request_id`、响应 ETag；
 *  - 本次真实发出的 `If-Match` / `Idempotency-Key`（不是页面上的期望值）；
 *  - 失败时的错误码（含契约外码），原样显示，不吞不换。
 *
 * 并额外提供「按 request_id 查审计台账」按钮：契约写响应里**没有** audit event id，
 * 也没有 scope／责任人字段，所以这里只能做关联查询，并在页面上写清这一缺口。
 */
import { computed } from 'vue';
import { AUDIT_SCOPE_NOTE, describeAuditLookup, receiptHeading, receiptLines } from '../lib/admin-content-view-model.mjs';

const props = defineProps({
  write: { type: Object, default: null },
  auditLookup: { type: Object, default: null },
  canAudit: { type: Boolean, default: false },
  canReloadDetail: { type: Boolean, default: false },
  /**
   * **显式判定输入**（三值，由调用方用 `changedVerdict()` 从契约事实算出）：
   *  - `'changed'`   确实改动了（publish／withdraw 回执的 `changed:true`，或编辑后 revision 前进）；
   *  - `'unchanged'` 确定没改动（publish／withdraw 回执的 `changed:false`：服务端内存幂等短路）；
   *  - `'unknown'`   回执没带布尔 `changed`（例如 create 的 201）⇒ 只能写「已受理」，不猜。
   *
   * **五个用本组件的页面全部显式传值**（各自的 `receiptChanged`，由 `deriveChanged()` 算出）：
   * `RegistrationAdminView`／`RestrictionAdminView`（`*PublicationOutcome` 的必填 `changed`）、
   * `SourcesView`／`KnowledgeAdminView`（publish／withdraw 同源，edit 比 revision，create 走 unknown）、
   * `CategoriesView`（只有 PATCH，比 revision 前进）。
   *
   * `default: 'changed'` 只为兼容既有调用点**保留**，它**不再代表任何页面的实际行为** ——
   * 不传 `changed` 的调用点会退化成「成功回执」，那是本组件历史上的默认值，不是判定结论。
   * 新调用点必须显式传值；缺失时宁可传 `'unknown'`，也不要靠默认。
   * ⛔ 不要在这里按 `status` 或 `ok` 猜成功 —— 那正是 B1 的成因。
   */
  changed: {
    type: String,
    default: 'changed',
    validator: (value) => ['changed', 'unchanged', 'unknown'].includes(value),
  },
});

const emit = defineEmits(['lookup-audit', 'clear-receipt', 'reload-detail']);

const lines = computed(() => receiptLines(props.write, { verdict: props.changed }));
const heading = computed(() => receiptHeading(props.write, props.changed));
const lookup = computed(() => describeAuditLookup(props.auditLookup));
const settled = computed(() => props.write !== null && props.write !== undefined && props.write.phase !== 'pending');
const failed = computed(() => settled.value && props.write.ok !== true);
const auditAvailable = computed(() => typeof props.write?.requestId === 'string' && props.write.requestId !== '');

function eventTarget(event) {
  const ref = event?.target_ref;
  if (ref === null || ref === undefined) return 'null（契约允许）';
  return JSON.stringify(ref);
}
</script>

<template>
  <section v-if="write !== null" class="receipt" :class="{ failed }">
    <header>
      <h4>{{ heading }}</h4>
      <div class="actions">
        <button v-if="failed && canReloadDetail" class="link" type="button" @click="emit('reload-detail')">重读详情刷新 revision</button>
        <button v-if="settled && canAudit" class="ghost small" type="button" :disabled="!auditAvailable || auditLookup?.phase === 'loading'" @click="emit('lookup-audit')">
          {{ auditLookup?.phase === 'loading' ? '查询中…' : '按 request_id 查审计台账' }}
        </button>
        <button class="link" type="button" @click="emit('clear-receipt')">清除回执</button>
      </div>
    </header>

    <dl class="lines">
      <template v-for="line in lines" :key="line.label">
        <dt>{{ line.label }}</dt>
        <dd class="mono">{{ line.value }}</dd>
      </template>
    </dl>

    <p v-if="settled && !canAudit" class="note">
      当前后台会话的 scope 里没有 <code>audit:read</code>，因此本页不提供审计台账关联查询；上面已显示服务端返回的
      request_id，可在有权限的后台会话里用它检索。
    </p>
    <p v-if="settled && canAudit && !auditAvailable" class="note warn-text">
      服务端没有返回 meta.request_id，无法与审计台账关联（不臆造关联键）。
    </p>
    <p class="note">{{ AUDIT_SCOPE_NOTE }}</p>

    <div v-if="lookup !== null" class="lookup" :class="lookup.tone">
      <strong>{{ lookup.title }}</strong>
      <span>{{ lookup.detail }}</span>
      <ul v-if="auditLookup?.events?.length > 0" class="events">
        <li v-for="event in auditLookup.events" :key="event.id">
          <p class="mono">id {{ event.id }}</p>
          <p>action <code>{{ event.action }}</code> · scope <code>{{ event.scope }}</code> · result <code>{{ event.result }}</code> · reason <code>{{ event.reason_code }}</code></p>
          <p class="mono">target_ref {{ eventTarget(event) }}</p>
          <p class="mono">created_at {{ event.created_at }} · request_id {{ event.request_id }}</p>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.receipt {
  display: grid;
  gap: 0.6rem;
  border: 1px solid #9ae6b4;
  background: #f0fff4;
  border-radius: 10px;
  padding: 0.8rem 1rem;
}
.receipt.failed {
  border-color: #feb2b2;
  background: #fff5f5;
}
header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
h4 {
  margin: 0;
  font-size: 0.95rem;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}
.lines {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.2rem 0.9rem;
  margin: 0;
  font-size: 0.86rem;
}
dt {
  font-weight: 600;
  color: #2d3748;
}
dd {
  margin: 0;
  word-break: break-all;
}
.mono {
  font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
  font-size: 0.84rem;
}
.note {
  margin: 0;
  font-size: 0.8rem;
  color: #4a5568;
  line-height: 1.6;
}
.warn-text {
  color: #975a16;
}
.lookup {
  display: grid;
  gap: 0.3rem;
  font-size: 0.85rem;
  border-left: 4px solid #a0aec0;
  background: #fff;
  padding: 0.5rem 0.7rem;
  border-radius: 6px;
}
.lookup.ready {
  border-left-color: #2f855a;
}
.lookup.stale {
  border-left-color: #b7791f;
}
.lookup.error {
  border-left-color: #c53030;
}
.events {
  margin: 0.2rem 0 0;
  padding-left: 1.1rem;
  display: grid;
  gap: 0.4rem;
}
.events p {
  margin: 0;
  word-break: break-all;
}
code {
  background: #edf2f7;
  border-radius: 4px;
  padding: 0.05rem 0.3rem;
  font-size: 0.86em;
}
button {
  font: inherit;
  cursor: pointer;
  border-radius: 8px;
  padding: 0.3rem 0.6rem;
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
.small {
  font-size: 0.84rem;
}
button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
</style>
