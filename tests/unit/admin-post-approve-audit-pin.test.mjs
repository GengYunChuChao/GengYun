/**
 * GY-R68 · 后台**人工审核**（`approvePost`）＝**合法的人工复核路径**的钉子。
 *
 * ## 这一片要回答的问题
 *
 * 侦察（`.pg17/tmp/p1-social/RECON.md` §3／§5-S6）指出：`POST /admin/posts/{id}/approve` 在 real 装配下
 * 能把 `private` 直接推成 `published`（`services/api/src/admin/ops/community-posts.ts:327-328`），
 * 即**不经过 AI 审核端口**就放出内容，看上去像"依赖未上线人工放行的后门"，与 #14「先审后发」的出发点冲突。
 * 用户已裁定：**这条保留**——它就是人工复核路径。但保留的前提是它必须**可审计、可解释、可证**。
 *
 * 本文件不判断"该不该保留"（那是用户裁定），只把"它凭什么是合法的"钉成可复跑的读数：
 *   1. **有人**：结论行带 `decided_by`（迁移 0045 的列），值是会话里的管理员 id；
 *   2. **有 scope**：缺 `sources:write` ⇒ 403，且库里什么都没发生；
 *   3. **有审计**：`private → published` 与结论行是**同一次原子提交**（同一个 CAS），不是两步；
 *   4. **有 CAS**：版本守卫在写之前比对，冲突即拒——不是"先发布再报冲突"。
 *
 * ## 三条用例（对应派单 ①／②／③）
 *
 * | 臂 | 做什么 | 期望读数 |
 * |---|---|---|
 * | ① 正控制 | `approvePost` 推一条 `private`+`pending` 的帖子 | 200 / `published`+`approved` / revision 1→2 / `community_moderation_decisions` **恰好 1 行** / `decided_by`=该管理员 / `hard_rule_passed=true` |
 * | ② 负控制 | 把「写 decisions」那一步改成**空操作**（唯一改动点：CAS 的 `moderation` 实参换成 `null`） | CAS 照跑、帖子照样 `published`、**仍然 200** ⇒ ① 的断言**必须红**，且红在「人工审核必须留痕」这句上 |
 * | ③ 越权 | 缺 `sources:write`（403）／无会话（401） | 拒绝，且 `visibility` 仍是 `private`、结论行 0 行、内存审计 0 条、revision 不动 |
 *
 * ②是本文件的**核心**：如果"状态真的变了"就能替代"留痕了"，那 ① 只是在断言返回值。
 * ②证明的是"**只**把写 decisions 那一步拿掉，其余全绿也过不了 ①"——即 ① 的绿是被审计钉住的绿，
 * 不是被 `visibility` 撞绿的。为此 ② 用同一份断言函数（不是另写一份更弱的）。
 *
 * ## 审计链（核实到的 `path:line`，逐段可查）
 *
 * | 环节 | 位置 | 事实 |
 * |---|---|---|
 * | 路由 | `services/api/src/routes/admin.ts:569-577` | `POST /admin/posts/:id/approve`，`preHandler` 是 `requireAdmin` + `requireScope(OPS_SCOPES.approvePost)` |
 * | scope 取值 | `services/api/src/admin/ops/service.ts:429` | `approvePost: 'sources:write'`（与 `hidePost` 同门，不新增 scope 值） |
 * | 服务层 | `services/api/src/admin/ops/service.ts:1474` | `resolveContext(ctx, scope)` ⇒ 401 `SESSION_REQUIRED`／403 `SCOPE_DENIED`／（缺 `If-Match`）428 `REVISION_REQUIRED` |
 * | 审谁 | `services/api/src/admin/identity.ts:69-70` | scope 不在会话里即 `SCOPE_DENIED`，不因目标差异改变 |
 * | **可见性推进** | `services/api/src/admin/ops/community-posts.ts:327-328` | `private ⇒ published`（只对 `private` 生效；`hidden`/`deleted` 不翻案） |
 * | 结论行构造 | `services/api/src/admin/ops/community-posts.ts:292` | `decided_by: actorId`（`actorId` 由服务层从会话 `identity.userId` 传入，⛔ 不接受调用方自报） |
 * | **同一次原子提交** | `services/api/src/admin/ops/community-posts.ts:351-361` | 一次 `commitPostIfCurrent`：期望态（revision + visibility + audit_state）+ 新态 + `verdict` |
 * | CAS 版本守卫 | `services/api/src/community/store-pg.ts:470-476` | `FOR UPDATE` 后逐项比对 revision／visibility／audit_state，不符即拒（写之前） |
 * | 可见性 UPDATE | `services/api/src/community/store-pg.ts:479-485` | `visibility = $11::visibility` 与 `audit_state = $12` 同一条 UPDATE |
 * | 结论落库 | `services/api/src/community/store-pg.ts:632` | `if (moderation !== null) await writeModeration(...)`，与帖子行**同一事务** |
 * | 落库 SQL | `services/api/src/community/store-pg.ts:351-383` | `INSERT INTO community_moderation_decisions (... decided_by ...)`，`ON CONFLICT` 覆盖同版本结论 |
 * | 列定义 | `services/api/db/migrations/0045_community_post_review_actor.sql:61` | `ADD COLUMN IF NOT EXISTS decided_by uuid NULL`；`NULL`=机器结论、非 `NULL`=人工结论 |
 * | **不经过 AI 审核端口** | `services/api/src/admin/ops/community-posts.ts:225-236` | 适配器只注入社区 store／事件端口／**规则层发布门**，没有审核服务或模型端口入参；`gate.evaluate` 是确定性硬规则层（`community/moderation-gate.ts`） |
 *
 * ⇒ 「人工复核」的定义就在最后一行：**入口里根本没有 AI 审核端口**，硬规则层的否决仍然拦得住
 * （`community-posts.ts:318-320` 的 `RULE_VETOED` ⇒ 422），剩下的判断由人在 scope 后面做，并留下 `decided_by`。
 *
 * ## 声明（不得误读）
 *
 * - **内存 store 臂**：本文件不连真库、不读真实 `.env`、零外呼；它证明的是"服务层→适配器→CAS 原语"这条链
 *   在**内存实现**上把结论一起写下去了，**不**证明 PG 事务边界（那条在
 *   `tests/integration/admin-community-posts-pg.mjs` 的审核臂，需真库 URL；本文件不复述它的读数）。
 * - **不改业务行为**：`services/**` 零改动。② 的"把写 decisions 改成空操作"落在**测试侧**的端口包装上
 *   （唯一被改的一步就是 CAS 的 `moderation` 实参），生产代码一行没动；同款"临时改生产代码复核负控制后复原"
 *   的做法在 `docs/architecture/acceptance-map.md` 已有先例。
 * - **测试侧只拧一个旋钮**：闸门时钟冻结（`makeGate()`，与 `community-fixtures.mjs` 同一惯例）。理由：出厂规则预算
 *   吃墙钟，并行跑全量时机器一抖就把 `approved` 变成 `RULE_TIMEOUT`（实测过一次：57 条并跑时 ① 变红且理由是
 *   `RULE_TIMEOUT`）。冻结后预算检查照跑，但"过了多少墙钟"不参与判定。⛔ 这个旋钮**不会**让审核变宽——
 *   硬规则否决的用例照旧 422。
 * - **不是质量证据**：正文是合成文本、账号是内存合成账号，不得被引用成审核准确率／误隔离率成绩。
 * - **不主张 AI 免检**：本文件只钉"人工可以通过"，**不**主张"人工通过后不必再抽检"；
 *   反向关系（AI 通过也不免除人工抽检）写进 `docs/architecture/acceptance-map.md` 的验收口径节。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPostReviewAdapter } from '../../services/api/src/admin/ops/community-posts.ts';
import { createMemoryCommunityStore } from '../../services/api/src/community/store.ts';
import {
  ADMIN_USER_ID,
  USER_A,
  createOpsHarness,
  expectApiError,
  opsContext,
  opsKey,
} from './admin-ops-fixtures.mjs';
import { makeGate } from './community-fixtures.mjs';

/** 失败时必须逐字出现的一句：它把"状态变了但没留痕"这种绿钉成红。 */
const TRACE_REQUIRED = '人工审核必须留痕';

/** 一条**待审未发布**的帖子：库里就是 `private` + `pending`（先审后发的队列）。 */
function pendingPost(overrides = {}) {
  return {
    id: randomUUID(),
    revision: 1,
    author_id: USER_A.userId,
    anonymized_author_ref: null,
    title: '苗期观察记录',
    body: '这段时间天气转凉，我记录了田间长势，准备按标签说明处理。',
    crop_id: 'crop-rice',
    region_code: '330100',
    media_ids: [],
    linked_knowledge_ref: null,
    visibility: 'private',
    audit_state: 'pending',
    created_at: '2026-10-22T02:00:00.000Z',
    updated_at: '2026-10-22T02:00:00.000Z',
    ...overrides,
  };
}

/**
 * ②的变异臂：把「写 decisions」那一步改成**空操作**。
 *
 * 唯一改动点：`commitPostIfCurrent` 的第 4 个实参（结论行）换成 `null`
 * ——即 `store-pg.ts:632` 那个 `if (moderation !== null)` 永远走不到。
 * CAS 的期望态、新态、审计参数**原样透传**：帖子照样迁移、照样 200。
 */
export function dropDecisionWrite(store) {
  const calls = [];
  const mutant = {
    ...store,
    async commitPostIfCurrent(id, expected, patch, moderationRecord, audit = null) {
      calls.push({ id, revision: patch?.revision ?? null, decisionDropped: moderationRecord !== null });
      return store.commitPostIfCurrent(id, expected, patch, null, audit);
    },
  };
  return { store: mutant, calls };
}

/**
 * ①／② **共用的同一条断言**（②不改写、不弱化它）。
 *
 * 判据顺序刻意如此：先看"有没有留下那一行"，再看"那一行指向谁"。
 * 前一条先红，噪声最小——运维看到的是「没留痕」，而不是"字段值是 undefined"。
 */
async function assertHumanReviewTraced(store, { postId, revision, actorId }) {
  const counts = store.snapshotCounts();
  assert.equal(
    counts.moderation,
    1,
    `${TRACE_REQUIRED}：private→published 必须恰好落 1 行 community_moderation_decisions，实际 ${counts.moderation} 行`
      + '（状态变了但没有结论行＝这件事不可回溯，与"绕过审核的后门"无法区分）',
  );

  const row = await store.getModeration('post', postId, revision);
  assert.notEqual(
    row,
    null,
    `${TRACE_REQUIRED}：结论必须与**新**版本 revision=${revision} 同版本落库`
      + '（读面按 target_ref.revision 比对，写错版本等于没写）',
  );
  assert.equal(row.target_ref.type, 'post', `${TRACE_REQUIRED}：结论的目标类型必须是 post`);
  assert.equal(row.target_ref.id, postId, `${TRACE_REQUIRED}：结论必须指向被审核的那条帖子`);
  assert.equal(row.target_ref.revision, revision, `${TRACE_REQUIRED}：结论必须指向新版本 revision=${revision}`);
  assert.equal(row.decision, 'approved', `${TRACE_REQUIRED}：人工通过必须落 decision=approved，实际 ${row.decision}`);
  assert.equal(
    row.hard_rule_passed,
    true,
    `${TRACE_REQUIRED}：approved ⇒ hard_rule_passed 必须 true（审核域的硬约束，写反会被读面判 quarantined）`,
  );
  assert.equal(
    row.decided_by,
    actorId.toLowerCase(),
    `${TRACE_REQUIRED}：decided_by 必须指向做出该结论的管理员（迁移 0045 的列），实际 ${row.decided_by}`
      + '（NULL 会被读成"机器结论"，人工动作就混进了机器口径里）',
  );
}

/** 一套真能审的装配：内存社区 store + 人工审核适配器 + 后台运营服务。 */
function harnessWith(port) {
  // 闸门注入**只冻结规则求值时钟**（与 `community-fixtures.mjs:65` 的 `makeGate` 同一惯例）：
  // 出厂预算吃墙钟，并行跑全量时机器一抖就会把 `approved` 变成 `RULE_TIMEOUT` ⇒ 判决变 422，
  // 那就成了"机器速度决定断言"。冻结后预算检查照跑，但"过了多少墙钟"不参与判定。
  const adapter = createPostReviewAdapter({ port, gate: makeGate() });
  return createOpsHarness({ communityStore: port, postReview: adapter });
}

function approveCtx(overrides = {}) {
  return { ...opsContext(), idempotencyKey: opsKey('approve'), ifMatch: '"1"', ...overrides };
}

test(`① approvePost 把 private 推成 published，且落 1 行 decisions、decided_by=该管理员（${TRACE_REQUIRED}）`, async () => {
  const store = createMemoryCommunityStore({ now: () => Date.now() });
  const harness = harnessWith(store);
  const post = pendingPost();
  assert.equal(await store.insertPost(post, null), true, '夹具：待审帖落库时**没有**结论行（pending 就是这个意思）');
  assert.equal(store.snapshotCounts().moderation, 0, '夹具前置：插入待审帖本身不产生结论行');

  const res = await harness.service.approvePost(approveCtx(), post.id, undefined);
  assert.equal(res.status, 200);
  assert.equal(res.headers.ETag, '"2"', '通过必须推进版本并回写新 ETag（1 → 2）');
  assert.equal(res.body.data.changed, true);
  assert.equal(res.body.data.visibility, 'published', '人工通过同时承担发布语义（private → published）');
  assert.equal(res.body.data.audit_state, 'approved');

  const after = await store.getPost(post.id);
  assert.equal(after.visibility, 'published');
  assert.equal(after.audit_state, 'approved');
  assert.equal(after.revision, 2);
  assert.equal(after.author_id, post.author_id, '审核不改作者归属');
  assert.equal(after.title, post.title, '审核不改正文');

  // ← 这一句是 ① 的全部重量：状态变了**不算**通过，必须同时留下那一行。
  await assertHumanReviewTraced(store, { postId: post.id, revision: 2, actorId: ADMIN_USER_ID });
});

test('② 负控制：把「写 decisions」改成空操作 ⇒ ① 的断言必须红，并点名「人工审核必须留痕」', async () => {
  const base = createMemoryCommunityStore({ now: () => Date.now() });
  const mutant = dropDecisionWrite(base);
  const harness = harnessWith(mutant.store);
  const post = pendingPost();
  assert.equal(await base.insertPost(post, null), true);

  const res = await harness.service.approvePost(approveCtx(), post.id, undefined);
  // 变异臂**照常成功**：CAS 过了、帖子真发布了、响应也是 200 —— 这正是"靠返回值断言"会漏掉的那种绿。
  assert.equal(res.status, 200, '变异只拿掉结论行，不该改变可见性迁移的结果（否则变异打偏了）');
  assert.equal(res.body.data.changed, true);
  assert.equal(res.body.data.visibility, 'published');
  const after = await base.getPost(post.id);
  assert.equal(after.visibility, 'published', '变异臂里帖子**真的**公开了：这条臂的可怕之处就在这儿');
  assert.equal(after.audit_state, 'approved');

  // 变异确实生效（不是"打了个空补丁"）：写 decisions 的那一步被调用过，但结论行被丢弃。
  assert.equal(mutant.calls.length, 1, '夹具自检：变异点必须被调用恰好一次');
  assert.equal(mutant.calls[0].decisionDropped, true, '夹具自检：被丢弃的必须是一条**非空**结论（空结论不叫变异）');
  assert.equal(base.snapshotCounts().moderation, 0, '变异生效的读数是"结论行 0 行"');

  // ← 同一份断言，在变异臂上必须红，且红在「人工审核必须留痕」这句上。
  await assert.rejects(
    () => assertHumanReviewTraced(base, { postId: post.id, revision: 2, actorId: ADMIN_USER_ID }),
    (error) => {
      assert.match(String(error?.message), /人工审核必须留痕/, `变异臂必须点名「${TRACE_REQUIRED}」，实际：${error?.message}`);
      return true;
    },
    '把「写 decisions」改成空操作后，① 的核心断言必须变红——否则 ① 的绿只是被 visibility 撞绿的',
  );
});

test('③ 越权：缺 sources:write ⇒ 403、无会话 ⇒ 401，且都不产生 published 迁移与结论行', async () => {
  const store = createMemoryCommunityStore({ now: () => Date.now() });
  const harness = harnessWith(store);
  const post = pendingPost();
  assert.equal(await store.insertPost(post, null), true);

  // ③a 有会话、没 scope：`sources:read` 不是这道门的钥匙（门是 `sources:write`，见 service.ts:429）。
  const unauthorised = opsContext({
    identity: { ...opsContext().identity, scopes: ['sources:read'] },
  });
  const denied = await expectApiError(
    () => harness.service.approvePost({ ...unauthorised, idempotencyKey: opsKey('noscope'), ifMatch: '"1"' }, post.id, undefined),
    'SCOPE_DENIED',
  );
  assert.equal(denied.status, 403, '越权口径是 403（contract.ts 的 SCOPE_DENIED 档），不是 404');

  // ③b 连会话都没有：401 SESSION_REQUIRED（同一道门前置的身份判据）。
  const anonymous = { identity: { authEpoch: 1, role: 'admin', scopes: ['sources:write'] } };
  const noSession = await expectApiError(
    () => harness.service.approvePost({ ...anonymous, idempotencyKey: opsKey('nosession'), ifMatch: '"1"' }, post.id, undefined),
    'SESSION_REQUIRED',
  );
  assert.equal(noSession.status, 401);

  // 两条拒绝路径都**零副作用**：帖子还在原地，结论行 0，内存审计 0。
  const after = await store.getPost(post.id);
  assert.equal(after.visibility, 'private', '被拒的越权请求不得把帖子推成 published');
  assert.equal(after.audit_state, 'pending');
  assert.equal(after.revision, post.revision, '被拒的越权请求不得推进 revision');
  assert.equal(store.snapshotCounts().moderation, 0, '被拒的越权请求不得留下结论行');
  assert.equal(harness.store.audit.list().length, 0, '被拒的越权请求不得留下后台审计');
});
