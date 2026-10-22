<script setup lang="ts">
import { ref } from 'vue';
import { ADMIN_AUTH_API_IMPLEMENTED, API_BASE_URL } from './auth/session';
import AccountsView from './views/AccountsView.vue';
import AuditEventsView from './views/AuditEventsView.vue';
import ContentAdminView from './views/ContentAdminView.vue';
import FlagsView from './views/FlagsView.vue';
import JobsView from './views/JobsView.vue';
import ReviewPlaceholderView from './views/ReviewPlaceholderView.vue';

type TabKey = 'accounts' | 'content' | 'flags' | 'audit' | 'jobs' | 'review';

const tabs: Array<{ key: TabKey; label: string; note: string }> = [
  { key: 'accounts', label: '账号目录（只读）', note: '读面已接入' },
  { key: 'content', label: '资料管理', note: '来源 / 科普 / 分类' },
  { key: 'flags', label: '功能开关', note: '读写已接入' },
  { key: 'audit', label: '审计事件（只读）', note: '读面已接入' },
  { key: 'jobs', label: '作业台', note: '读 + 取消已接入' },
  { key: 'review', label: '人工审核（占位）', note: '未实现' },
];

const active = ref<TabKey>('accounts');
</script>

<template>
  <main class="shell">
    <header class="top">
      <h1>耕云 · 独立后台</h1>
      <p class="api">API 基地址：<code>{{ API_BASE_URL }}</code></p>
    </header>

    <nav class="tabs" aria-label="后台页面">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        type="button"
        class="tab"
        :class="{ active: active === tab.key }"
        :aria-pressed="active === tab.key"
        @click="active = tab.key"
      >
        <span>{{ tab.label }}</span>
        <small>{{ tab.note }}</small>
      </button>
    </nav>

    <AccountsView v-if="active === 'accounts'" />
    <ContentAdminView v-else-if="active === 'content'" />
    <FlagsView v-else-if="active === 'flags'" />
    <AuditEventsView v-else-if="active === 'audit'" />
    <JobsView v-else-if="active === 'jobs'" />
    <ReviewPlaceholderView v-else />

    <footer class="foot">
      <dl>
        <dt>后台鉴权接口</dt>
        <dd>
          {{ ADMIN_AUTH_API_IMPLEMENTED ? '已实现（POST/GET /admin/auth/session、POST /admin/auth/logout）' : '未实现' }}
        </dd>
        <dt>账号目录</dt>
        <dd>只读页：GET /admin/accounts（游标分页）；停用/注销等写操作不在本片</dd>
        <dt>资料管理</dt>
        <dd>
          资料来源 / 科普内容 / 分类：读 <code>sources:read</code>，写 <code>sources:write</code>；写操作带
          <code>Idempotency-Key</code>，编辑/发布/下架另带 <code>If-Match</code>；审计由服务端留痕
        </dd>
        <dt>功能开关</dt>
        <dd>
          读写页：GET /admin/feature-flags（flags:read）；PUT /admin/feature-flags/{key} 带 If-Match 与
          Idempotency-Key（flags:write），失败按服务端错误码如实展示
        </dd>
        <dt>审计事件</dt>
        <dd>只读页：GET /admin/audit-events（游标分页，scope=audit:read）；除契约 8 个必填字段外，另展示 R29-S5 新增的可选留痕字段（actor / target_hint / 前后值），不做本片没有的写操作</dd>
        <dt>作业台</dt>
        <dd>
          读 + 取消页：GET /admin/jobs（jobs:read，游标分页）；POST /admin/jobs/{id}/cancel 带 If-Match（取该行
          revision）与 Idempotency-Key（jobs:cancel），终态行（succeeded / uncertain / failed / timed_out /
          cancelled）按钮禁用，取消后按响应局部刷新该行
        </dd>
        <dt>人工审核</dt>
        <dd>空入口占位，未实现；不伪造队列与审核人</dd>
      </dl>
      <p class="notice">
        后台与小程序端分别鉴权（audience=admin，独立令牌）；本页不读取任何生产密钥，不写日志、不把令牌放进 URL。
      </p>
    </footer>
  </main>
</template>

<style>
:root {
  color-scheme: light;
  font-family: system-ui, "Microsoft YaHei", sans-serif;
}
body {
  margin: 0;
  background: #f7fafc;
}
.shell {
  max-width: 960px;
  margin: 2.5rem auto 4rem;
  padding: 0 1.5rem;
  line-height: 1.7;
  color: #1a202c;
}
.top {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
}
h1 {
  margin: 0;
  font-size: 1.4rem;
}
.api {
  margin: 0;
  font-size: 0.86rem;
  color: #4a5568;
}
.tabs {
  display: flex;
  gap: 0.5rem;
  margin: 1rem 0 1.1rem;
}
.tab {
  display: grid;
  gap: 0.1rem;
  text-align: left;
  padding: 0.5rem 0.9rem;
  border: 1px solid #cbd5e0;
  border-radius: 10px;
  background: #fff;
  font: inherit;
  cursor: pointer;
  color: #1a202c;
}
.tab small {
  color: #718096;
  font-size: 0.76rem;
}
.tab.active {
  border-color: #0f766e;
  box-shadow: inset 0 0 0 1px #0f766e;
  background: #f0fdfa;
}
.tab.active small {
  color: #0f766e;
}
code {
  background: #edf2f7;
  border-radius: 4px;
  padding: 0.05rem 0.3rem;
  font-size: 0.86em;
}
.foot {
  margin-top: 1.6rem;
  border-top: 1px solid #e2e8f0;
  padding-top: 1rem;
}
dl {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.25rem 1rem;
  font-size: 0.9rem;
}
dt {
  font-weight: 600;
}
dd {
  margin: 0;
}
.notice {
  margin: 0.8rem 0 0;
  border-left: 4px solid #b7791f;
  background: #fffbeb;
  padding: 0.6rem 0.9rem;
  font-size: 0.86rem;
  border-radius: 6px;
}
</style>
