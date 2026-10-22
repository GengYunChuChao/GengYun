/**
 * GY-R31（`Refs #14`）· 图片审核的**产品路径**与**能力位 fail-closed**（缺口 G3）。
 *
 * 覆盖（见 `docs/verification/gy-r31-i14-image-path-20261022.md`）：
 *   I1 能力就绪（`tms` + `ims` 都已接线）⇒ 带媒体投稿**进入审核链路**：受理为
 *      「私有 / 待审」内容行、建立该 revision 的 `text` + `image` 两个版本级任务、
 *      **不**调用发布闸门、结论如实留档（`quarantined`，不是 `approved`）；
 *   I2 能力缺失（只接线 `tms`，`ims` 只有替身）⇒ 仍**拒**（422 `INPUT_UNCERTAIN`），
 *      理由码**可区分**（含 `IMAGE_MODERATION_UNAVAILABLE`），且零内容行、零任务、零送审；
 *   I3 对照：同样的能力缺失状态 + **纯文本**硬规则命中 ⇒ 400 `INVALID_REQUEST` 且
 *      理由码里**没有** `IMAGE_MODERATION_UNAVAILABLE`（证明该码只标记"图片审核未就绪"）；
 *   I4 不变式仍在：规则层一旦被换成"会放行媒体"的实现、且审核域明确放行 ⇒ 仍 503 拒绝
 *      （不得因为补了产品路径就把带媒体内容当通过发出去）；
 *   I5 编辑同口径：新 revision 带媒体 ⇒ 落「私有 / 待审」、**不**调发布闸门。
 *
 * 声明：模型端口全是**合成端口**（`provider.synthetic === true`），本文件**不发起任何真实
 * 模型/付费调用**；断言只证明"接线与产品路径"，不构成图片审核准确率或供应商可用性证据。
 * 另：本片**没有**解决"媒体引用缺 `mime`/`media_revision`"（媒体域投影未接线），
 * 因此图片端口此刻仍不会被真正求值——这是如实记录的**未取得项**，由 I1 的结论码钉住。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLEAN_TITLE, DANGEROUS_BODY, idem } from './community-fixtures.mjs';
import {
  CLEAN_BODY,
  USER_A,
  expectApiError,
  makeHarness,
  makeWiredHarness,
  passingPort,
  postInput,
} from './community-moderation-fixtures.mjs';

const MEDIA = '22222222-2222-4222-8222-222222222222';

/** 带媒体投稿的入参（`media_ids` 走契约 `uuid` 形态，条数上限 3）。 */
function mediaPostInput(overrides = {}) {
  return postInput({ media_ids: [MEDIA], ...overrides });
}

/** 自建"已放行媒体"的规则闸门替身（只为证明第二道不变式仍然生效）。 */
function gateThatPublishesMedia() {
  const publishableOutcome = {
    decision: 'approved',
    hard_rule_passed: true,
    publishable: true,
    reason_codes: [],
    refusal_reason_codes: [],
    fail_closed: false,
  };
  return {
    evaluate: () => ({ ...publishableOutcome }),
    assess: () => ({ stale: false, publishable: true }),
  };
}

/** 自建"明确放行"的审核域联动端口替身（只为证明第二道不变式仍然生效）。 */
function linkThatApproves() {
  return {
    wired: true,
    note: 'synthetic-approving-link',
    screen: async () => ({
      decision: 'approved',
      reason_codes: [],
      publishable: true,
      vetoed: false,
      isolation: false,
      task_kinds: ['text', 'image'],
      rule_layer: 'passed',
      model_layer: 'approved',
    }),
    publish: async () => ({ published: true }),
    withdraw: async () => ({ withdrawn: true }),
    readView: async () => null,
    conclusionFor: () => null,
    counts: () => ({ tasks: 0 }),
  };
}

// ---------------------------------------------------------------------------
// I1 能力就绪 ⇒ 进入审核链路（已提交审核）
// ---------------------------------------------------------------------------

test('I1. 图片审核能力就绪（tms+ims 均已接线）⇒ 带媒体投稿受理为「私有/待审」并留在审核链路', async () => {
  const h = makeWiredHarness({
    ports: { tms: passingPort({ kind: 'tms' }), ims: passingPort({ kind: 'ims' }) },
  });

  // 能力位读数：两条 kind 都是 `wired` + `ready`（这不是"猜"，是审核域自己的口径）。
  const readiness = h.link.imageReadiness();
  assert.equal(typeof readiness, 'object');
  assert.equal(readiness.ready, true, '能力就绪时 imageReadiness.ready 必须为 true');
  assert.equal(readiness.state, 'wired');
  const capabilities = await h.moderation.capabilities();
  assert.equal(capabilities.image.ready, true, '审核域的 image 能力位必须就绪');
  assert.deepEqual(h.moderation.counts().substitutes, [], '有一个 ims 端口被接线时不应存在 ims 替身');

  const created = await h.service.createPost(USER_A, mediaPostInput(), { idempotencyKey: idem(901) });

  // 受理结果：对外投影如实（结论是 `quarantined`，不是 `approved`）。
  assert.equal(created.visibility, 'private', '带媒体内容受理后不得公开');
  assert.equal(created.audit_state, 'quarantined', '未获模型层放行时不得给出 approved 结论');

  // 落库形态：私有 + 待审（"已提交审核"的那一态），媒体 id 原样保留。
  const row = await h.store.getPost(created.id);
  assert.notEqual(row, null);
  assert.equal(row.visibility, 'private');
  assert.equal(row.audit_state, 'pending');
  assert.deepEqual(row.media_ids, [MEDIA]);

  // 真的送审了：一次 screen、两个版本级任务（text + image）。
  assert.equal(h.calls.screen.length, 1, '必须且只送审一次');
  assert.deepEqual([...h.calls.screen[0].result.task_kinds].sort(), ['image', 'text']);
  assert.equal(h.moderation.counts().tasks, 2, 'text 与 image 各一条任务');

  // 发布闸门**一次都没被调用**：带媒体内容留在审核链路里，不发布。
  assert.equal(h.calls.publish.length, 0, '带媒体内容不得调用发布闸门');

  // 结论如实留档：`quarantined`（不是 approved、也不是 rejected）。
  const verdict = await h.store.getModeration('post', created.id, 1);
  assert.notEqual(verdict, null);
  assert.equal(verdict.decision, 'quarantined');
  assert.equal(verdict.contract_complete, false, '模型层未真正求值时不得声称契约完整');
  assert.ok(
    verdict.reason_codes.includes('MEDIA_NOT_EVALUATED_BY_RULE_LAYER'),
    '规则层不评估媒体的声明码必须如实保留',
  );

  // 未取得项（如实钉住）：媒体引用缺 `mime`/`media_revision`（媒体域投影未接线），
  // 因此图片端口此刻仍不会被真正求值 —— 这是记录，不是断言"已审图片"。
  assert.ok(
    verdict.reason_codes.includes('MODEL_MEDIA_UNSUPPORTED'),
    '未接媒体投影时必须如实报 MODEL_MEDIA_UNSUPPORTED（不得伪造成"已求值"）',
  );
});

// ---------------------------------------------------------------------------
// I2 能力缺失 ⇒ 仍然拒（fail-closed），且理由码可区分
// ---------------------------------------------------------------------------

test('I2. 图片审核能力缺失（ims 只有替身）⇒ 422 拒绝、理由码可区分、零内容行零任务', async () => {
  const h = makeWiredHarness({ ports: { tms: passingPort({ kind: 'tms' }) } });

  const readiness = h.link.imageReadiness();
  assert.equal(readiness.ready, false, 'ims 只有替身时能力位必须为 false');
  assert.equal(readiness.state, 'substitute');

  const error = await expectApiError(
    () => h.service.createPost(USER_A, mediaPostInput(), { idempotencyKey: idem(902) }),
    'INPUT_UNCERTAIN',
    422,
  );
  const codes = (error.details ?? []).filter((detail) => detail.field === 'reason_codes').map((detail) => detail.code);
  assert.ok(
    codes.includes('IMAGE_MODERATION_UNAVAILABLE'),
    `理由码必须能区分"图片审核未就绪"：${JSON.stringify(codes)}`,
  );
  assert.ok(
    codes.includes('MEDIA_NOT_EVALUATED_BY_RULE_LAYER'),
    '规则层的原始声明码仍须一并回传（不抹掉既有口径）',
  );

  // fail-closed：零内容行、零任务、零送审、零发布。
  assert.equal(h.store.snapshotCounts().posts, 0);
  assert.equal(h.moderation.counts().tasks, 0);
  assert.equal(h.calls.screen.length, 0);
  assert.equal(h.calls.publish.length, 0);
});

// ---------------------------------------------------------------------------
// I3 对照：纯文本硬规则命中 ⇒ 不含图片能力位理由码（可区分性反证）
// ---------------------------------------------------------------------------

test('I3. 对照（能力缺失 + 纯文本硬规则命中）⇒ 400 且理由码不含 IMAGE_MODERATION_UNAVAILABLE', async () => {
  const h = makeWiredHarness({ ports: { tms: passingPort({ kind: 'tms' }) } });
  assert.equal(h.link.imageReadiness().ready, false);

  const error = await expectApiError(
    () => h.service.createPost(USER_A, postInput({ title: CLEAN_TITLE, body: DANGEROUS_BODY }), { idempotencyKey: idem(903) }),
    'INVALID_REQUEST',
    400,
  );
  const codes = (error.details ?? []).filter((detail) => detail.field === 'reason_codes').map((detail) => detail.code);
  assert.ok(codes.length > 0, '驳回必须带理由码');
  assert.equal(
    codes.includes('IMAGE_MODERATION_UNAVAILABLE'),
    false,
    '纯文本投稿不得被标成"图片审核未就绪"（该码只属带媒体场景）',
  );
  assert.equal(h.store.snapshotCounts().posts, 0);
  assert.equal(h.moderation.counts().tasks, 0);
});

// ---------------------------------------------------------------------------
// I4 第二道不变式仍在：规则层若放行媒体 + 审核域明确放行 ⇒ 仍不得发布
// ---------------------------------------------------------------------------

test('I4. 规则层被换成"会放行媒体"的实现且审核域明确放行 ⇒ 仍 503 拒绝（不变式未放宽）', async () => {
  const h = makeHarness({
    gate: gateThatPublishesMedia(),
    communityModeration: linkThatApproves(),
  });
  // 该替身**没有**能力位读数 ⇒ 一律视为未就绪（`readImageModerationReadiness` 的 fail-closed 口径）。

  await expectApiError(
    () => h.service.createPost(USER_A, mediaPostInput(), { idempotencyKey: idem(904) }),
    'PROVIDER_UNAVAILABLE',
    503,
  );
  assert.equal(h.store.snapshotCounts().posts, 0, '不变式拒绝时不得留下内容行');
});

// ---------------------------------------------------------------------------
// I5 编辑同口径：新 revision 带媒体 ⇒ 私有/待审、不发布
// ---------------------------------------------------------------------------

test('I5. 编辑带媒体 ⇒ 新 revision 同样落「私有/待审」且不调用发布闸门', async () => {
  const h = makeWiredHarness({
    ports: { tms: passingPort({ kind: 'tms' }), ims: passingPort({ kind: 'ims' }) },
  });
  const created = await h.service.createPost(USER_A, mediaPostInput(), { idempotencyKey: idem(905) });

  const edited = await h.service.editPost(USER_A, created.id, mediaPostInput({ body: `${CLEAN_BODY}（带图编辑）` }), {
    idempotencyKey: idem(906),
    ifMatch: `"${created.revision}"`,
  });
  assert.equal(edited.revision, 2);
  assert.equal(edited.visibility, 'private');
  assert.equal(edited.audit_state, 'quarantined');

  const row = await h.store.getPost(created.id);
  assert.equal(row.revision, 2);
  assert.equal(row.visibility, 'private');
  assert.equal(row.audit_state, 'pending');
  assert.deepEqual(row.media_ids, [MEDIA]);
  assert.equal(h.calls.publish.length, 0, '编辑带媒体同样不得调用发布闸门');
  assert.equal(h.moderation.counts().tasks, 4, '两个 revision 各两条任务');
});
