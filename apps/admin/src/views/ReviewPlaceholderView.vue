<script setup>
/**
 * 人工审核入口——**明确占位**（GY-I18）。
 *
 * 本组件不含任何请求、不含任何假队列／假审核人／假"专家已审"标记。
 * 依据逐条可核（见下方 citations），首版口径就是"人工审核只空入口"。
 */
const citations = [
  {
    quote: '人工审核只空入口。',
    file: 'docs/requirements.md:20',
  },
  {
    quote: '首版没有 人审队列、审核人、专家认证；`humanReviewQueue()` 恒为空态（`human_review_state = \'under_construction\'`，取自契约 `Home.human_review_state` 的 `const`）。',
    file: 'docs/moderation/http-layer.md:130-131',
  },
  {
    quote: '人审：未上线（空态）；公众票决：首版不进入。',
    file: 'docs/moderation/http-layer.md:206',
  },
  {
    quote: '`approved` 只说明 AI 筛查，不等于专业审核；AI 超时/异常/不明为 `quarantined`，没有人审放行兜底。',
    file: 'docs/architecture/state-contract.md:95',
  },
];

const codeFacts = [
  {
    symbol: 'humanReviewQueue()',
    file: 'services/api/src/moderation/nonbypass.ts:159-165',
    note: '服务端人审入口恒返回 { human_review_state: under_construction, voting: disabled, items: [] }。',
  },
  {
    symbol: 'OPS_OPERATION_IDS（9 项）',
    file: 'services/api/src/admin/ops/service.ts:155-165',
    note: '后台运维面只有分类/账号/任务/开关/帖子 9 个 operationId，其中没有任何审核队列接口。',
  },
  {
    symbol: 'AdminAccountViewEnvelope',
    file: 'packages/contracts/openapi.json:16185',
    note: '契约里该信封只被 suspendUser（POST /admin/accounts/{id}/suspend）使用，不存在审核队列资源。',
  },
];
</script>

<template>
  <section class="review">
    <header class="head">
      <h2>人工审核入口</h2>
      <span class="badge">未实现 · 占位</span>
    </header>

    <p class="lead">
      本页是<strong>空入口</strong>：没有审核队列、没有待审列表、没有审核人、没有"专家已审"标记。
      首版需求口径即"人工审核只空入口"，服务端 <code>humanReviewQueue()</code> 也恒为空态。
      这里<strong>不会</strong>用假数据让你以为审核能力已可用。
    </p>

    <div class="panel">
      <h3>为什么是占位（需求口径）</h3>
      <ul>
        <li v-for="item in citations" :key="item.file">
          <p class="quote">「{{ item.quote }}」</p>
          <p class="src"><code>{{ item.file }}</code></p>
        </li>
      </ul>
    </div>

    <div class="panel">
      <h3>为什么是占位（代码与契约现状）</h3>
      <ul>
        <li v-for="item in codeFacts" :key="item.symbol">
          <p class="quote"><code>{{ item.symbol }}</code> — {{ item.note }}</p>
          <p class="src"><code>{{ item.file }}</code></p>
        </li>
      </ul>
    </div>

    <div class="panel todo">
      <h3>未取得项（要真做需要先有接口）</h3>
      <ul>
        <li>契约没有审核队列读接口，也没有审核动作（通过/驳回/隔离）接口 → 前端无法读取真实待审条目。</li>
        <li>契约没有审核人身份与专家认证字段 → 不能展示"审核人是谁"，更不能标"专家已审"。</li>
        <li>AI 筛查结果与 content visibility（private/published/hidden/deleted）由服务端状态机决定，后台读面尚未提供对应查询。</li>
      </ul>
      <p class="src">
        结论：本页只做入口与说明；接入真实审核能力需要先补契约与服务端接口，不在本片范围内，也不由前端伪造。
      </p>
    </div>
  </section>
</template>

<style scoped>
.review {
  display: grid;
  gap: 0.9rem;
}
.head {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}
h2 {
  margin: 0;
  font-size: 1.15rem;
}
.badge {
  padding: 0.1rem 0.55rem;
  border-radius: 999px;
  background: #fef3c7;
  color: #744210;
  font-size: 0.8rem;
  font-weight: 600;
}
.lead {
  margin: 0;
  padding: 0.7rem 0.9rem;
  border-left: 4px solid #b7791f;
  background: #fffbeb;
  border-radius: 6px;
  font-size: 0.92rem;
  line-height: 1.7;
}
.panel {
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 0.8rem 1rem;
  background: #fff;
}
.panel h3 {
  margin: 0 0 0.4rem;
  font-size: 0.98rem;
}
.panel ul {
  margin: 0;
  padding-left: 1.1rem;
  display: grid;
  gap: 0.55rem;
}
.quote {
  margin: 0;
  font-size: 0.9rem;
  line-height: 1.7;
  color: #1a202c;
}
.src {
  margin: 0.15rem 0 0;
  font-size: 0.82rem;
  color: #4a5568;
}
.todo {
  border-color: #fbd38d;
  background: #fffaf0;
}
code {
  background: #edf2f7;
  border-radius: 4px;
  padding: 0.05rem 0.3rem;
  font-size: 0.86em;
}
</style>
