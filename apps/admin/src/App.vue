<script setup lang="ts">
import { ADMIN_AUTH_IMPLEMENTED, API_BASE_URL } from './auth/session';
</script>

<template>
  <main class="shell">
    <h1>耕云 · 独立后台（工程骨架）</h1>
    <p class="notice">
      这是<strong>后台骨架</strong>，只有独立鉴权入口占位<strong>没有业务页面</strong>。
      分类、资料来源、药剂规则、账号、AI 状态与功能开关等由后续任务实现
      （见 F08 / F13 / GY-I18）。
    </p>
    <dl>
      <dt>鉴权状态</dt>
      <dd>{{ ADMIN_AUTH_IMPLEMENTED ? '已接入' : '未接入（占位，不伪造登录）' }}</dd>
      <dt>API 基地址</dt>
      <dd>{{ API_BASE_URL }}</dd>
    </dl>
    <p class="footnote">
      后台与小程序端分别鉴权；此骨架不提供任何登录成功路径，也不读取生产密钥。
    </p>
  </main>
</template>

<style>
:root {
  color-scheme: light;
  font-family: system-ui, "Microsoft YaHei", sans-serif;
}
.shell {
  max-width: 720px;
  margin: 4rem auto;
  padding: 0 1.5rem;
  line-height: 1.7;
  color: #1a202c;
}
.notice {
  border-left: 4px solid #b7791f;
  background: #fffbeb;
  padding: 0.75rem 1rem;
}
dl {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.25rem 1rem;
}
dt {
  font-weight: 600;
}
.footnote {
  color: #4a5568;
  font-size: 0.9rem;
}
</style>
