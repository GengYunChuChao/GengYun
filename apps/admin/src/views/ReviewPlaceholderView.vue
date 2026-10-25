<script setup>
/**
 * 人工审核入口——**真实空态**（B5，接替原 GY-I18 占位页）。
 *
 * 本组件**不发起任何网络请求**：契约里根本没有审核队列的读面（`packages/contracts/openapi.json`
 * 中 path 含 `review` 的数量为 0），`services/api/src/routes/` 也没有任何 review 路由。
 * 因此本页不伪造队列、不伪造待审计数、不伪造审核人／专家认证标记，
 * 而是把「当前系统里实际待审对象 = 0（结构性零）」连同**数据来源**一起写清楚。
 *
 * 计数的确定性来自服务端实现本身：
 * - `services/api/src/moderation/nonbypass.ts:161-168` `humanReviewQueue()` → `items: []` 恒空；
 * - `services/api/src/admin/human-review.ts:68-89` `createHumanReviewDirectory()` →
 *   tasks/reviewers/votes/expert_certifications 四个集合全是 `Object.freeze([])`，`wired: false`；
 * - 且没有任何持久表（模块头注释 1-25 行明写"没有评审任务队列、没有评审人目录、没有投票、
 *   没有专家认证，也没有任何持久表"）。
 */
import { HUMAN_REVIEW_COLLECTIONS_COUNT, REVIEW_COUNT, REVIEW_COUNT_BADGE, reviewCountSources } from '../lib/review-state.mjs';

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
    file: 'services/api/src/moderation/nonbypass.ts:161-168',
    note: '人审入口恒返回 { human_review_state: under_construction, voting: disabled, items: [] }；items 空数组即真实待审条数。',
  },
  {
    symbol: 'createHumanReviewDirectory()',
    file: 'services/api/src/admin/human-review.ts:68-89',
    note: 'tasks／reviewers／votes／expert_certifications 四个集合都是冻结空数组，wired: false，并附 reason 说明；assertNoReviewClaim() 一律抛 OBJECT_UNAVAILABLE。',
  },
  {
    symbol: 'HUMAN_REVIEW_STATE',
    file: 'services/api/src/moderation/types.ts:114',
    note: "全仓唯一的『人审未上线』事实表达：export const HUMAN_REVIEW_STATE = 'under_construction'；对应契约 packages/contracts/openapi.json:12139-12157 的 const。",
  },
  {
    symbol: '公开首页人审位',
    file: 'services/api/src/routes/public-home.ts:13',
    note: "该路由直接硬编码 data: { …, human_review_state: 'under_construction' }，不是从队列读出来的。",
  },
  {
    symbol: 'OPS_OPERATION_IDS（9 项）',
    file: 'services/api/src/admin/ops/service.ts:163-173',
    note: '后台运维面只有分类/账号/任务/开关/帖子 9 个 operationId，其中没有任何审核队列接口。',
  },
];
</script>

<template>
  <section class="review">
    <header class="head">
      <h2>人工审核入口</h2>
      <span class="badge">本版不实现人审工作流 · 仅保留入口</span>
    </header>

    <p class="lead">
      本版<strong>不实现人审工作流</strong>，只保留入口：没有审核队列、没有待审列表、没有审核人、没有投票、
      没有专家认证、没有「人审已通过」标记。服务端同样未接线（<code>wired: false</code>），
      本页<strong>不会</strong>用假任务／假审核人让你以为审核能力已可用。
    </p>

    <div class="panel count">
      <h3>当前待审核对象计数</h3>
      <p class="big">
        <span class="num">{{ REVIEW_COUNT }}</span>
        <span class="unit">个待审核对象</span>
        <span class="tag">{{ REVIEW_COUNT_BADGE }}</span>
      </p>
      <p class="src">
        这是<strong>结构性零</strong>，不是「暂时没加载到」，也不是本页编造的数字：服务端人审入口的
        <code>items</code> 恒为空数组、四个集合恒为冻结空数组，且全仓没有对应的持久表
        （共 {{ HUMAN_REVIEW_COLLECTIONS_COUNT }} 个集合，全部为空）。
      </p>
      <p class="src">
        <strong>为什么后台拿不到 HTTP 计数：</strong>契约里没有审核队列读接口
        （<code>packages/contracts/openapi.json</code> 中 path 含 <code>review</code> 的数量为 0），
        <code>services/api/src/routes/</code> 也没有 review 路由 —— 本页因此不发起任何网络请求。
      </p>
      <ul>
        <li v-for="item in reviewCountSources" :key="item.file">
          <p class="quote">{{ item.note }}</p>
          <p class="src"><code>{{ item.file }}</code></p>
        </li>
      </ul>
    </div>

    <div class="panel">
      <h3>需求口径（逐条可核）</h3>
      <ul>
        <li v-for="item in citations" :key="item.file">
          <p class="quote">「{{ item.quote }}」</p>
          <p class="src"><code>{{ item.file }}</code></p>
        </li>
      </ul>
    </div>

    <div class="panel">
      <h3>代码与契约现状</h3>
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
        <li>契约没有审核人身份与专家认证字段 → 不能展示「审核人是谁」，更不能标「专家已审」。</li>
        <li>AI 筛查结果与 content visibility（private/published/hidden/deleted）由服务端状态机决定，后台读面尚未提供对应查询。</li>
        <li>即使把「待审核」定义为某个 visibility 状态的行数，也没有对应读面；本页不拿账号目录或帖子列表凑数。</li>
      </ul>
      <p class="src">
        结论：本页只做入口与说明；接入真实审核能力需要先补契约与服务端接口，不在本片范围内，也不由前端伪造。
        想看「后台到底发生过哪些动作」，请用「审计事件」tab（真实只读台账）。
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
  flex-wrap: wrap;
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
  margin: 0.4rem 0 0;
  padding-left: 1.1rem;
  display: grid;
  gap: 0.55rem;
}
.count {
  border-color: #cbd5e0;
}
.big {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.5rem;
  margin: 0.2rem 0 0.4rem;
}
.num {
  font-size: 2rem;
  font-weight: 700;
  color: #0f766e;
  line-height: 1.1;
}
.unit {
  font-size: 0.95rem;
  font-weight: 600;
}
.tag {
  font-size: 0.8rem;
  padding: 0.1rem 0.5rem;
  border-radius: 999px;
  background: #edf2f7;
  color: #2d3748;
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
  line-height: 1.65;
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
