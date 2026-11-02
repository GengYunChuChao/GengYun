<script setup>
/**
 * 「社区帖子下架（紧急处置）」页（`#18` 最小片 2）。
 *
 * 写面只调用契约里**存在**的那一个操作：`POST /admin/posts/{id}/hide`（`hidePost`，scope `sources:write`）。
 * 读面也**存在**（2026-11-02 复核）：`GET /admin/posts`（`listAdminPosts`）与 `GET /admin/posts/{id}`
 * （`getAdminPost`），`x-scope` 都是 `sources:read`，路由在 `services/api/src/routes/admin.ts`。
 * 所以本页先「读取帖子确认」：读到就把 revision 回填成**只读值**；读不到（403／404／网络／503）
 * 就回落成手填 revision —— 读面是便利，**不是提交前提**，读失败也不许把提交按钮禁掉。
 * 仍然不造帖子列表/队列：列表页是审核队列（`ModerationQueueView`），再抄一份就是伪造数据
 * （`docs/ui-contract-binding.md` 的口径）。
 *
 * 判断逻辑全在 `../lib/post-takedown-*.mjs`（纯函数）；本组件只把状态机接到 DOM。
 * 权限判定不在这里：`scopes` 只用来提前禁用按钮，真正的拒绝由服务端返回错误码，页面原样显示。
 *
 * **不伪造状态**：`If-Match` 永不为 `*`；real 模式下服务端 503 一律如实显示为失败；
 * 200 只写「服务端已受理（accepted:true）」，不写「已下架成功」（本页无法自证社区可见性）。
 */
import { computed, ref } from 'vue';
import { fetchAdminPostDetail } from '../lib/admin-moderation-queue.mjs';
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
import {
  POST_READ_SCOPE,
  describePostReadFailure,
  postReadSummary,
  readBlockReason,
} from '../lib/post-takedown-read.mjs';

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

/** 读面状态机：`idle → reading → ok｜failed`；改了帖子 ID 让已读结果失效（`stale`）。 */
const readStatus = ref('idle');
const readSummary = ref(null);
const readFailure = ref(null);
/** 读面给的 revision 是否锁成只读（`true` = 不许直接改，只能「改用手填」解锁）。 */
const revisionLocked = ref(false);
/** `stale` 时提示里引用的上一篇标题（不冒充当前 ID 的读面结果）。 */
const staleFrom = ref('');
let readSeq = 0;

const canWrite = computed(() => props.scopes.includes(SOURCES_WRITE_SCOPE));
const blocked = computed(() => submitBlockReason(form.value, { hasWriteScope: canWrite.value, submitting: submitting.value }));
const canSubmit = computed(() => blocked.value === null);

/** 读面 scope 是否在手（只影响「读取」按钮，**不影响**提交）。 */
const canRead = computed(() => props.scopes.includes(POST_READ_SCOPE));
const readBlocked = computed(() =>
  readBlockReason({ hasReadScope: canRead.value, reading: readStatus.value === 'reading', postId: form.value.post_id }),
);

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
  if (key === 'revision' && revisionLocked.value) return;
  if (key === 'post_id' && (revisionLocked.value || readStatus.value === 'ok')) {
    staleFrom.value = readSummary.value === null ? '上一次读取的帖子' : `《${readSummary.value.title}》`;
    readSummary.value = null;
    readStatus.value = 'stale';
    revisionLocked.value = false;
  }
  form.value = { ...form.value, [key]: value };
}

/** 「改用手填 revision」：只解锁，不删掉读面摘要（摘要仍然标记它来自哪一次读取）。 */
function unlockRevision() {
  revisionLocked.value = false;
}

/**
 * 读取帖子确认：`GET /admin/posts/{id}`（`getAdminPost`，scope `sources:read`），复用既有客户端
 * `fetchAdminPostDetail`。读到 ⇒ 展示标题／作者／可见性／revision，并把 revision 锁成**只读值**；
 * 读不到（403／404／会话过期／网络／503）⇒ **保留**操作员已填的值并解锁，显示「为什么读不到 + 手填风险」，
 * 提交按钮照常可用（⛔ 读失败不是禁提交的理由）。
 */
async function readPost() {
  if (readBlocked.value !== null) return;
  const seq = ++readSeq;
  readStatus.value = 'reading';
  readFailure.value = null;

  const result = await fetchAdminPostDetail({ baseUrl: props.baseUrl, token: props.token, postId: form.value.post_id });
  if (seq !== readSeq) return;

  if (result.ok === true) {
    const summary = postReadSummary(result.post);
    if (summary.ok) {
      readSummary.value = summary;
      readStatus.value = 'ok';
      revisionLocked.value = true;
      form.value = { ...form.value, post_id: summary.postId, revision: String(summary.revision) };
      return;
    }
    readFailure.value = describePostReadFailure({
      ok: false,
      kind: 'invalid_response',
      status: result.status,
      code: null,
      message: summary.problems.map((problem) => `${problem.field} ${problem.message}`).join('；'),
    });
  } else {
    readFailure.value = describePostReadFailure(result);
    if (result.kind === 'signed_out') emit('signed-out');
  }

  // 回落：读不到不阻塞下架——保留当前 revision、解锁、提交按钮不禁。
  readSummary.value = null;
  revisionLocked.value = false;
  readStatus.value = 'failed';
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
      readStatus.value = 'idle';
      readSummary.value = null;
      readFailure.value = null;
      revisionLocked.value = false;
      staleFrom.value = '';
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
          <code>sources:write</code>）：按<strong>帖子 ID</strong> 直接下架。契约<strong>有</strong>帖子读面
          （<code>GET /admin/posts</code> 列表、<code>GET /admin/posts/{id}</code> 详情，scope
          <code>sources:read</code>），所以本页先「读取帖子确认」把当前 revision 读回来；
          读不到（403／404／网络）就回落成手填——<strong>读面是便利，不是提交前提</strong>。
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

      <div class="read" data-testid="read-step">
        <p class="hint">
          ① 读取帖子确认：<code>GET {{ baseUrl }}/admin/posts/{id}</code>（<code>getAdminPost</code>，scope
          <code>{{ POST_READ_SCOPE }}</code>）。读到的 revision 会回填成只读值；读不到就用下面的手填值，提交照常。
        </p>
        <div class="row">
          <button class="ghost" type="button" data-testid="read-post" :disabled="readBlocked !== null" @click="readPost">
            {{ readStatus === 'reading' ? '读取中…' : '读取帖子确认' }}
          </button>
          <span class="hint" data-testid="read-blocked">{{ readBlocked === null ? '' : readBlocked.message }}</span>
        </div>

        <dl v-if="readStatus === 'ok' && readSummary !== null" class="facts" data-testid="read-summary">
          <dt>标题</dt>
          <dd>{{ readSummary.title }}</dd>
          <dt>作者</dt>
          <dd class="mono">{{ readSummary.author }}</dd>
          <dt>当前可见性</dt>
          <dd class="mono">{{ readSummary.visibility }} · {{ readSummary.visibilityLabel }}</dd>
          <dt>audit_state</dt>
          <dd class="mono">{{ readSummary.auditState }} · {{ readSummary.auditStateLabel }}</dd>
          <dt>revision</dt>
          <dd class="mono">{{ readSummary.revision }}（已回填为只读值；更新于 {{ readSummary.updatedAtLabel }}）</dd>
        </dl>

        <div v-if="readFailure !== null" class="status warn" role="status" data-testid="read-fallback">
          <strong>{{ readFailure.title }}</strong>
          <span>{{ readFailure.detail }}</span>
          <span>{{ readFailure.risk }}</span>
          <span>{{ readFailure.fallback }}</span>
        </div>

        <p v-if="readStatus === 'stale'" class="hint warn-text" data-testid="read-stale">
          帖子 ID 已变更：{{ staleFrom }} 的 revision 不再适用于当前 ID，已解锁为手填，请重新读取或自己核对。
        </p>
      </div>

      <label>
        <span>
          ② 当前 revision（整数，形如 7；不接受 <code>*</code>）
          <template v-if="revisionLocked">——读面回填，<strong>只读</strong></template>
          <template v-else>——手填</template>
        </span>
        <input
          :value="form.revision"
          type="text"
          inputmode="numeric"
          autocomplete="off"
          data-testid="revision"
          :disabled="submitting"
          :readonly="revisionLocked"
          placeholder="7"
          @input="updateField('revision', $event.target.value)"
        />
      </label>

      <p v-if="revisionLocked" class="hint" data-testid="revision-locked">
        这个 revision 来自读面（<code>getAdminPost</code>），已锁成只读值。
        <button class="link" type="button" data-testid="revision-manual" @click="unlockRevision">改用手填 revision</button>
      </p>

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
.read {
  display: grid;
  gap: 0.5rem;
  border: 1px dashed #cbd5e0;
  border-radius: 10px;
  padding: 0.6rem 0.8rem;
  background: #f7fafc;
}
.facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.2rem 0.7rem;
  margin: 0;
  font-size: 0.86rem;
}
.facts dt {
  color: #4a5568;
}
.facts dd {
  margin: 0;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.ghost {
  border: 1px solid #cbd5e0;
  background: #fff;
  color: #1a202c;
}
.link {
  border: 0;
  background: none;
  color: #2b6cb0;
  padding: 0;
  text-decoration: underline;
  font-size: 0.84rem;
}
</style>
