<script setup>
/**
 * 「资料管理」tab 的容器（#18 核心，B8）。
 *
 * 内部用子 tab 切换三类资料，避免顶部 tab 过多：
 *  - 资料来源（sources）   `/admin/sources`
 *  - 科普内容（knowledge） `/admin/knowledge`
 *  - 分类（categories）    `/admin/categories`
 *
 * 本组件只做两件事：**拿后台会话**、**把 baseUrl/token/scopes 传给子页**。
 * 权限判定不在前端：子页只用 scopes 提示「本会话有没有这个 scope」，真实 403 由服务端回。
 */
import { computed, onMounted, ref } from 'vue';
import { API_BASE_URL, loadAdminSession, signInAdmin } from '../auth/session';
import CategoriesView from './CategoriesView.vue';
import KnowledgeAdminView from './KnowledgeAdminView.vue';
import PostTakedownView from './PostTakedownView.vue';
import SourcesView from './SourcesView.vue';

const FAMILIES = [
  { key: 'sources', label: '资料来源', note: '/admin/sources' },
  { key: 'knowledge', label: '科普内容', note: '/admin/knowledge' },
  { key: 'categories', label: '分类', note: '/admin/categories' },
  { key: 'posts', label: '帖子下架（紧急处置）', note: '/admin/posts/{id}/hide' },
];

const active = ref('sources');
const phase = ref('loading');
const session = ref(null);
const loginForm = ref({ loginName: '', password: '' });
const loginError = ref(null);
const signingIn = ref(false);

const scopes = computed(() => (session.value === null ? [] : session.value.scopes));
const baseUrl = API_BASE_URL;

async function refreshSession() {
  phase.value = 'loading';
  loginError.value = null;
  try {
    const loaded = await loadAdminSession();
    session.value = loaded;
    phase.value = loaded === null ? 'signed_out' : 'ready';
  } catch (error) {
    session.value = null;
    phase.value = 'signed_out';
    loginError.value = { title: '读取会话失败', detail: messageOf(error), code: codeOf(error) };
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function codeOf(error) {
  if (error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  return null;
}

async function submitLogin() {
  signingIn.value = true;
  loginError.value = null;
  try {
    await signInAdmin({ loginName: loginForm.value.loginName.trim(), password: loginForm.value.password });
    loginForm.value = { loginName: '', password: '' };
    // 登录响应不带 scope（session.ts:17）；按 AccountsView 的既有做法立刻用同一 token 再读一次
    // GET /admin/auth/session，否则下面 4 个子页拿到的 scopes 恒为空，写/审计按钮全被禁用。
    const loaded = await loadAdminSession();
    if (loaded === null) {
      // 网络失败或 401：不静默留空 scope，给出可见失败态（令牌若仍在，可点「重读会话」重试）。
      session.value = null;
      phase.value = 'signed_out';
      loginError.value = {
        title: '登录后读取会话失败',
        detail: '登录已成功，但再读 GET /admin/auth/session 未返回会话（网络失败 / 401 / 本地令牌不可用）；scope 未知前不进入内容页，请点「重读会话」重试或重新登录。',
        code: null,
      };
      return;
    }
    session.value = loaded;
    phase.value = 'ready';
  } catch (error) {
    loginError.value = { title: '登录失败', detail: messageOf(error), code: codeOf(error) };
  } finally {
    signingIn.value = false;
  }
}

function handleSignedOut() {
  session.value = null;
  phase.value = 'signed_out';
  loginError.value = { title: '会话已失效', detail: '服务端返回 401 SESSION_REQUIRED/SESSION_EXPIRED；请重新登录后再操作。', code: null };
}

onMounted(refreshSession);
</script>

<template>
  <section class="content">
    <nav class="sub-tabs" aria-label="资料类别">
      <button
        v-for="family in FAMILIES"
        :key="family.key"
        type="button"
        class="sub-tab"
        :class="{ active: active === family.key }"
        :aria-pressed="active === family.key"
        @click="active = family.key"
      >
        <span>{{ family.label }}</span>
        <small>{{ family.note }}</small>
      </button>
    </nav>

    <p class="note">
      权限判定完全在服务端（<code>sources:read</code> / <code>sources:write</code> / <code>audit:read</code>）；页面只按本会话
      scope 提示并禁用按钮，不做前端放行。当前会话 scope：
      <code>{{ scopes.length === 0 ? '（未读取）' : scopes.join('、') }}</code>
    </p>

    <div v-if="phase === 'loading'" class="status" role="status">
      <strong>正在读取后台会话…</strong>
    </div>

    <form v-else-if="phase === 'signed_out'" class="signin" @submit.prevent="submitLogin">
      <h3>需要后台会话</h3>
      <p class="note">
        资料管理页的每个请求都带 <code>Authorization: Bearer &lt;admin token&gt;</code>；令牌只存 sessionStorage（
        <code>gengyun.admin.session</code>），不进 URL、不写日志。本页不做登录态缓存，刷新即重新读会话。
      </p>
      <div v-if="loginError !== null" class="status error" role="alert">
        <strong>{{ loginError.title }}</strong>
        <span>{{ loginError.detail }}<template v-if="loginError.code !== null">（<code>{{ loginError.code }}</code>）</template></span>
      </div>
      <label>
        <span>登录名</span>
        <input v-model="loginForm.loginName" type="text" autocomplete="username" required data-testid="login-name" />
      </label>
      <label>
        <span>口令</span>
        <input v-model="loginForm.password" type="password" autocomplete="current-password" required data-testid="login-password" />
      </label>
      <div class="row">
        <button class="primary" type="submit" :disabled="signingIn">{{ signingIn ? '登录中…' : '登录' }}</button>
        <button class="ghost" type="button" :disabled="signingIn" @click="refreshSession">重读会话</button>
      </div>
    </form>

    <template v-else-if="session !== null">
      <SourcesView
        v-if="active === 'sources'"
        :base-url="baseUrl"
        :token="session.accessToken"
        :scopes="scopes"
        @signed-out="handleSignedOut"
      />
      <KnowledgeAdminView
        v-else-if="active === 'knowledge'"
        :base-url="baseUrl"
        :token="session.accessToken"
        :scopes="scopes"
        @signed-out="handleSignedOut"
      />
      <PostTakedownView
        v-else-if="active === 'posts'"
        :base-url="baseUrl"
        :token="session.accessToken"
        :scopes="scopes" @signed-out="handleSignedOut"
      />
      <CategoriesView
        v-else
        :base-url="baseUrl"
        :token="session.accessToken"
        :scopes="scopes"
        @signed-out="handleSignedOut"
      />
    </template>
  </section>
</template>

<style scoped>
.content {
  display: grid;
  gap: 0.9rem;
}
.sub-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.sub-tab {
  display: grid;
  gap: 0.1rem;
  text-align: left;
  padding: 0.4rem 0.8rem;
  border: 1px solid #cbd5e0;
  border-radius: 8px;
  background: #fff;
  font: inherit;
  cursor: pointer;
  color: #1a202c;
}
.sub-tab small {
  color: #718096;
  font-size: 0.74rem;
  font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
}
.sub-tab.active {
  border-color: #0f766e;
  box-shadow: inset 0 0 0 1px #0f766e;
  background: #f0fdfa;
}
.sub-tab.active small {
  color: #0f766e;
}
.signin {
  display: grid;
  gap: 0.6rem;
  max-width: 460px;
  border: 1px solid #cbd5e0;
  border-radius: 10px;
  padding: 1rem 1.1rem;
  background: #fff;
}
.signin h3 {
  margin: 0;
  font-size: 1rem;
}
.signin label {
  display: grid;
  gap: 0.25rem;
  font-size: 0.88rem;
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
input {
  padding: 0.4rem 0.55rem;
  border: 1px solid #cbd5e0;
  border-radius: 8px;
  font: inherit;
}
.note {
  margin: 0;
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
.status.error {
  background: #fff5f5;
  border-left-color: #c53030;
}
</style>
