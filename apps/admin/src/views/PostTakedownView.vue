<script setup>
/**
 * 「社区帖子下架（紧急处置）」页（`#18` 最小片 2）。
 *
 * 只调用契约里**存在**的那一个操作：`POST /admin/posts/{id}/hide`（`hidePost`，scope `sources:write`）。
 * 契约里**没有**帖子读面（没有 `/admin/posts` 列表、没有帖子详情）⇒ 本页**按 ID 直接下架**，
 * 不造帖子列表/队列（造列表＝伪造数据，见 `docs/ui-contract-binding.md` 的口径）。
 *
 * 判断逻辑全在 `../lib/post-takedown-*.mjs`（纯函数）；本组件只把状态机接到 DOM。
 * 权限判定不在这里：`scopes` 只用来提前禁用按钮，真正的拒绝由服务端返回错误码，页面原样显示。
 *
 * **不伪造状态**：`If-Match` 永不为 `*`；real 模式下服务端 503 一律如实显示为失败；
 * 200 只写「服务端已受理（accepted:true）」，不写「已下架成功」（本页无法自证社区可见性）。
 */
import { computed, ref } from 'vue';
import {
  SOURCES_WRITE_SCOPE,
  buildIfMatch,
  describeTakedownFailure,
  describeTakedownSuccess,
  hidePost,
  planIdempotencyKey,
  requestFingerprint,
  validateRevision,
} from '../lib/post-takedown-api.mjs';
import {
  CONFIRM_LABEL,
  FORM_NOTE,
  emptyTakedownForm,
  submitBlockReason,
  validateTakedownForm,
} from '../lib/post-takedown-form.mjs';

const props = defineProps({
  baseUrl: { type: String, required: true },
  token: { type: String, required: true },
  scopes: { type: Array, required: true },
});
const emit = defineEmits(['signed-out']);

const form = ref(emptyTakedownForm());
const problems = ref([]);
const submitting = ref(false);
const receipt = ref(null);

/** 结果未知（网络错误／503／504）时保留 `{key, fingerprint}`，供**有意**重放时复用同一幂等键。 */
let pendingKey = null;

/** 过期响应保护：换会话/重载后，晚到的旧响应不落状态（沿用 `SourcesView` 的写法）。 */
let requestSeq = 0;

const canWrite = computed(() => props.scopes.includes(SOURCES_WRITE_SCOPE));
const blocked = computed(() => submitBlockReason(form.value, { hasWriteScope: canWrite.value, submitting: submitting.value }));
const canSubmit = computed(() => blocked.value === null);

/** 将要发出的 `If-Match`（永远不会是 `*`；revision 不合法时显示 `—`）。 */
const ifMatchPreview = computed(() => {
  const checked = validateRevision(form.value.revision);
  if (!checked.ok) return '—';
  try {
    return buildIfMatch(checked.revision);
  } catch {
    return '—';
  }
});

function updateField(key, value) {
  form.value = { ...form.value, [key]: value };
}

async function submit() {
  if (submitting.value) return;
  const checked = validateTakedownForm(form.value);
  problems.value = checked.problems;
  if (!checked.ok) return;

  const ifMatch = buildIfMatch(checked.value.revision);
  const fingerprint = requestFingerprint({
    postId: checked.value.postId,
    ifMatch,
    reason: checked.value.reason,
  });
  const plan = planIdempotencyKey({ previous: pendingKey, fingerprint });

  submitting.value = true;
  receipt.value = null;
  const seq = ++requestSeq;
  try {
    const result = await hidePost({
      baseUrl: props.baseUrl,
      token: props.token,
      postId: checked.value.postId,
      revision: checked.value.revision,
      reason: checked.value.reason,
      idempotencyKey: plan.key,
    });
    if (seq !== requestSeq) return;

    if (result.ok === true) {
      pendingKey = null;
      receipt.value = describeTakedownSuccess(result);
      form.value = emptyTakedownForm();
      return;
    }
    // 结果未知才留键（重放安全）；确定性失败一律作废，下一次提交换新键。
    pendingKey = result.maybeEffective === true ? { key: plan.key, fingerprint } : null;
    receipt.value = describeTakedownFailure(result);
    if (result.kind === 'signed_out') emit('signed-out');
  } finally {
    if (seq === requestSeq) submitting.value = false;
  }
}
</script>

<template>
  <section class="family">
    <header class="head">
      <div>
        <h3>社区帖子下架（紧急处置）</h3>
        <p class="sub">
          <code>POST {{ baseUrl }}/admin/posts/{id}/hide</code>（<code>hidePost</code>，scope
          <code>sources:write</code>）：按<strong>帖子 ID</strong> 直接下架。契约里没有帖子读面（无列表、无详情），
          所以本页不造队列、不预填任何数据；revision 必须由操作员从处置现场填入。
        </p>
      </div>
    </header>

    <p v-if="!canWrite" class="banner warn" data-testid="scope-banner">
      当前后台会话的 scope 列表里没有 <code>sources:write</code>：提交按钮已禁用。权限判定以服务端为准（真实拒绝仍是服务端回的
      <code>403 SCOPE_DENIED</code>）。
    </p>

    <form class="editor" data-testid="takedown-form" @submit.prevent="submit">
      <header>
        <h4>下架参数（服务端拒绝通配与猜测）</h4>
      </header>

      <p class="hint">
        <code>If-Match</code> 必须形如 <code>"7"</code>：服务端显式拒绝 <code>*</code>（缺头 428、形状不符 400、不匹配 409）。
        本次将发送 <code>If-Match: {{ ifMatchPreview }}</code>。请求体只有 <code>{"reason": "…"}</code>（1..500 字）。
      </p>

      <label>
        <span>帖子 ID（uuid）</span>
        <input
          :value="form.post_id"
          type="text"
          autocomplete="off"
          spellcheck="false"
          data-testid="post-id"
          :disabled="submitting"
          placeholder="00000000-0000-0000-0000-000000000000"
          @input="updateField('post_id', $event.target.value)"
        />
      </label>

      <label>
        <span>当前 revision（整数，形如 7；不接受 <code>*</code>）</span>
        <input
          :value="form.revision"
          type="text"
          inputmode="numeric"
          autocomplete="off"
          data-testid="revision"
          :disabled="submitting"
          placeholder="7"
          @input="updateField('revision', $event.target.value)"
        />
      </label>

      <label>
        <span>下架理由 reason（1..500 字，会进服务端审计）</span>
        <textarea
          :value="form.reason"
          rows="3"
          data-testid="reason"
          :disabled="submitting"
          placeholder="例：社区举报核实为不实用药建议，紧急下架"
          @input="updateField('reason', $event.target.value)"
        />
      </label>

      <label class="confirm">
        <input
          type="checkbox"
          data-testid="confirm"
          :checked="form.confirmed"
          :disabled="submitting"
          @change="updateField('confirmed', $event.target.checked)"
        />
        <span>{{ CONFIRM_LABEL }}</span>
      </label>

      <div class="row">
        <button class="primary" type="submit" data-testid="submit" :disabled="!canSubmit">
          {{ submitting ? '提交中…' : '确认下架' }}
        </button>
      </div>

      <p v-if="blocked !== null && !submitting" class="hint warn-text" data-testid="blocked">
        提交按钮已禁用：{{ blocked.message }}
      </p>

      <div v-if="problems.length > 0" class="status error" role="alert" data-testid="problems">
        <strong>表单未通过校验</strong>
        <ul>
          <li v-for="problem in problems" :key="problem.field">{{ problem.message }}</li>
        </ul>
      </div>
    </form>

    <div v-if="receipt !== null" class="status" :class="receipt.tone" role="alert" data-testid="receipt">
      <strong>{{ receipt.title }}</strong>
      <span>{{ receipt.detail }}</span>
      <span class="advice">{{ receipt.advice }}</span>
    </div>

    <p class="note">{{ FORM_NOTE }}</p>
    <p class="note">
      审计由服务端留痕（<code>post.hide</code> + 审核域 <code>withdrawn</code> 联动），本页不写本地审计行；核对请到「审计事件」页按
      <code>request_id</code> 查。<strong>real 模式</strong>下该能力默认未接线（
      <code>hidePostWired=false</code>）⇒ 服务端回 <code>503 PROVIDER_UNAVAILABLE</code>，本页会原样显示为失败。
    </p>
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
.note,
.advice {
  margin: 0.3rem 0 0;
  font-size: 0.84rem;
  color: #4a5568;
  line-height: 1.6;
}
.advice {
  display: block;
  color: #744210;
}
code {
  background: #edf2f7;
  border-radius: 4px;
  padding: 0.05rem 0.3rem;
  font-size: 0.86em;
}
.editor {
  display: grid;
  gap: 0.6rem;
  border: 1px solid #cbd5e0;
  border-radius: 10px;
  padding: 0.85rem 1rem;
  background: #fff;
}
.editor label {
  display: grid;
  gap: 0.25rem;
  font-size: 0.88rem;
}
.editor label.confirm {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  font-size: 0.86rem;
  line-height: 1.5;
}
input,
textarea {
  padding: 0.4rem 0.55rem;
  border: 1px solid #cbd5e0;
  border-radius: 8px;
  font: inherit;
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
  gap: 0.25rem;
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
.status.error {
  background: #fff5f5;
  border-left-color: #c53030;
}
.status ul {
  margin: 0;
  padding-left: 1.1rem;
}
.warn-text {
  color: #975a16;
}
</style>
