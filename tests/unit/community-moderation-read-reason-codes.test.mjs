/**
 * 读面「审核结论理由码」：`Post`/`Comment` 的可选字段 `reason_codes`。
 *
 * 覆盖本片（切法 A）的行为契约：
 *   - **能如实归属**时才带：迟到驳回（审核域读取重查给出 `rejected`）与迟到隔离（`pending`/`quarantined`）
 *     都从审核域结论里原样带出理由码，逐项相等、不翻译、不改写、不排序；
 *   - **拿不到就不带**：正常通过（`verdict.reason_codes` 为 `[]`）→ 字段整个缺席，**不写空数组**、
 *     不填 `unknown` 之类占位；台账里没有该版本任务（`present:false`）同样缺席；
 *   - 投影口径：读面的降级是**投影**，存储行与写入时那份结论保持原样；
 *   - **如实边界**：规则层否决 ⇒ 写路径 400 且不落行 ⇒ 读面根本没有这条内容，
 *     理由码只存在于错误封套里。这条边界不是漏实现，是"不落行就没有读面"的直接结果。
 *
 * 声明：模型端口是**合成替身**（`provider.synthetic === true`），不发起任何真实模型/付费调用。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { idem } from './community-fixtures.mjs';
import {
  CLEAN_BODY,
  CLEAN_TITLE,
  USER_A,
  USER_B,
  expectApiError,
  makeWiredHarness,
  mutablePort,
  noTaskConclusionLink,
  passingPort,
  postInput,
} from './community-moderation-fixtures.mjs';

const POST_TEXT = `${CLEAN_TITLE}\n${CLEAN_BODY}`;
const SAFE_COMMENT = '换一种说法：按标签说明处理，注意轮换。';
const ROOT = resolve(import.meta.dirname, '..', '..');

/** 理由码字段的**形状**守卫：出现即必须合法；不做"应该有哪些码"的内容断言。 */
function assertReasonCodesShape(value, where) {
  assert.equal(Array.isArray(value), true, `${where}：reason_codes 出现时必须是数组`);
  assert.ok(value.length >= 1, `${where}：出现即不得为空数组（没有码就不该出现这个字段）`);
  assert.ok(value.length <= 30, `${where}：上限 30 条（契约 maxItems），实际 ${value.length}`);
  for (const code of value) {
    assert.equal(typeof code, 'string', `${where}：理由码必须是字符串，实际 ${typeof code}`);
    assert.ok(code.length > 0, `${where}：理由码不得是空串`);
    assert.equal(code.trim(), code, `${where}：理由码不得带首尾空白（${JSON.stringify(code)}）`);
    assert.equal(/^unknown$/i.test(code), false, `${where}：不得用 unknown 之类占位码`);
  }
}

test('R1. 正常通过且无理由码 ⇒ 读面**不带** reason_codes（帖子 / 我的列表 / 评论都不写空数组）', async () => {
  const h = makeWiredHarness({ ports: { tms: passingPort() } });
  const post = await h.service.createPost(USER_A, postInput(), { idempotencyKey: idem(1) });
  assert.equal(post.audit_state, 'approved', '前提：这条内容通过');
  assert.equal(
    'reason_codes' in post,
    false,
    '通过路径的 verdict.reason_codes 是 []，读面必须整个字段缺席（不写 []，不填占位）',
  );

  const detail = await h.service.getPost(USER_A, post.id);
  assert.equal('reason_codes' in detail, false, '详情读面同样缺席');

  const mine = await h.service.listPosts(USER_A);
  assert.equal(mine.items.length, 1);
  assert.equal('reason_codes' in mine.items[0], false, '列表投影同样缺席');

  const comment = await h.service.createComment(
    USER_B,
    post.id,
    { body: SAFE_COMMENT },
    { idempotencyKey: idem(2), ifMatch: `"${post.revision}"` },
  );
  assert.equal('reason_codes' in comment, false, '评论创建回执同样缺席');
  const readComment = await h.service.getComment(USER_B, comment.id);
  assert.equal('reason_codes' in readComment, false, '评论读面同样缺席');
});

test('R2. 迟到驳回 ⇒ hidden/rejected，且 reason_codes 与审核域结论**逐项相同**（原样透传）', async () => {
  const mutable = mutablePort({ initial: 'pass' });
  const h = makeWiredHarness({ ports: { tms: mutable.port } });
  const post = await h.service.createPost(USER_A, postInput(), { idempotencyKey: idem(1) });
  assert.equal(post.audit_state, 'approved', '前提：先正常通过并公开');

  // 之后审核域对同一版本给出明确驳回（走审核域自己的送审口，不经过社区写路径）。
  mutable.setMode('block');
  const outcome = await h.moderation.submitScreening({
    actor: USER_A,
    content: { target_ref: { type: 'post', id: post.id, revision: 1 }, text: POST_TEXT, media: [] },
  });
  assert.equal(outcome.overall.decision, 'rejected', '前提：审核域此刻给出明确驳回');

  const conclusion = h.link.conclusionFor({ type: 'post', id: post.id, revision: 1 });
  assert.equal(conclusion.decision, 'rejected');
  assert.ok(conclusion.reason_codes.length > 0, '前提：审核域结论里确实带理由码');

  const mine = await h.service.getPost(USER_A, post.id);
  assert.equal(mine.visibility, 'hidden');
  assert.equal(mine.audit_state, 'rejected');
  assert.deepEqual(
    mine.reason_codes,
    conclusion.reason_codes,
    '读面必须原样给出审核域的理由码（不翻译、不改写、不按严重程度重排）',
  );
  assertReasonCodesShape(mine.reason_codes, '迟到驳回');

  // 投影口径：存储行与写入时那份结论都没有被改写。
  assert.equal((await h.store.getPost(post.id)).visibility, 'published', '读取重查不得改写存储行');
  assert.equal((await h.store.getModeration('post', post.id, 1)).decision, 'approved');
});

test('R3. 迟到隔离 ⇒ hidden + pending/quarantined；理由码有就带、没有就缺席（两种都如实）', async () => {
  // ---- (A) 迟到 `pending`（异步供应商路径：该版本被取代为"待回调"）----
  const pendingHarness = makeWiredHarness({ ports: { tms: passingPort() } });
  const pendingPost = await pendingHarness.service.createPost(USER_A, postInput(), { idempotencyKey: idem(1) });
  const deferred = await pendingHarness.moderation.submitScreening({
    actor: USER_A,
    content: { target_ref: { type: 'post', id: pendingPost.id, revision: 1 }, text: POST_TEXT, media: [] },
    defer_model: true,
  });
  assert.equal(deferred.overall.decision, 'pending', '前提：该版本当前结论为 pending');
  const pendingConclusion = pendingHarness.link.conclusionFor({
    type: 'post',
    id: pendingPost.id,
    revision: 1,
  });

  const pendingMine = await pendingHarness.service.getPost(USER_A, pendingPost.id);
  assert.equal(pendingMine.visibility, 'hidden');
  assert.equal(pendingMine.audit_state, 'pending');
  assert.equal(
    'reason_codes' in pendingMine,
    pendingConclusion.reason_codes.length > 0,
    '隔离路径要么原样带上结论里的码，要么整个字段缺席——不得凭空补，也不得丢',
  );
  if ('reason_codes' in pendingMine) {
    assert.deepEqual(pendingMine.reason_codes, pendingConclusion.reason_codes);
    assertReasonCodesShape(pendingMine.reason_codes, '迟到 pending');
  }

  // ---- (B) 迟到无结论（端口回报 unsure ⇒ 隔离 quarantine）----
  const mutable = mutablePort({ initial: 'pass' });
  const quarantineHarness = makeWiredHarness({ ports: { tms: mutable.port } });
  const post = await quarantineHarness.service.createPost(USER_A, postInput(), { idempotencyKey: idem(1) });
  mutable.setMode('unsure');
  const screened = await quarantineHarness.moderation.submitScreening({
    actor: USER_A,
    content: { target_ref: { type: 'post', id: post.id, revision: 1 }, text: POST_TEXT, media: [] },
  });
  assert.equal(screened.overall.decision, 'quarantined', '前提：该版本当前结论为隔离');
  const conclusion = quarantineHarness.link.conclusionFor({ type: 'post', id: post.id, revision: 1 });
  assert.equal(conclusion.decision, 'quarantined');

  const mine = await quarantineHarness.service.getPost(USER_A, post.id);
  assert.equal(mine.visibility, 'hidden');
  assert.equal(mine.audit_state, 'quarantined');
  assert.equal(
    'reason_codes' in mine,
    conclusion.reason_codes.length > 0,
    '隔离路径同一口径：有码就带，没码就不带',
  );
  if ('reason_codes' in mine) {
    assert.deepEqual(mine.reason_codes, conclusion.reason_codes);
    assertReasonCodesShape(mine.reason_codes, '迟到隔离');
  }
});

test('R4. 台账里没有该版本任务（present:false）⇒ 没有结论可归属 ⇒ 字段缺席（不编占位码）', async () => {
  const h = makeWiredHarness({
    ports: { tms: passingPort() },
    communityLinkWrapper: noTaskConclusionLink,
  });
  const post = await h.service.createPost(USER_A, postInput(), { idempotencyKey: idem(1) });
  const conclusion = h.link.conclusionFor({ type: 'post', id: post.id, revision: 1 });
  assert.equal(conclusion.present, false, '前提：读取面声称台账里没有该版本任务');

  const mine = await h.service.getPost(USER_A, post.id);
  assert.equal(
    'reason_codes' in mine,
    false,
    '没有结论就没有可归属的理由码：整个字段缺席，比编一个 unknown 诚实',
  );
});

test('R5. 契约侧仍然**可选**：不进 required、不改 additionalProperties、上限 30、minItems 1', () => {
  const openapi = JSON.parse(readFileSync(resolve(ROOT, 'packages/contracts/openapi.json'), 'utf8'));
  for (const name of ['Post', 'Comment']) {
    const schema = openapi.components.schemas[name];
    assert.equal(schema.additionalProperties, false, `${name}：本片不得放开 additionalProperties`);
    assert.equal(
      schema.required.includes('reason_codes'),
      false,
      `${name}：reason_codes 必须保持可选（否则"拿不到就不带"会变成违约）`,
    );
    const field = schema.properties.reason_codes;
    assert.equal(field.type, 'array', `${name}.reason_codes 必须是数组`);
    assert.equal(field.items.type, 'string', `${name}.reason_codes 元素必须是字符串`);
    assert.equal(field.items.minLength, 1, `${name}.reason_codes 元素不得为空串`);
    assert.equal(field.minItems, 1, `${name}.reason_codes 出现即至少一条（空数组不是"没有理由"的写法）`);
    assert.equal(field.maxItems, 30, `${name}.reason_codes 上限须与 Moderation.reason_codes 一致`);
  }
});

test('R6. 【如实边界】规则层否决 ⇒ 写路径 400 且不落行 ⇒ 读面根本无从带理由码', async () => {
  const h = makeWiredHarness({ ports: { tms: passingPort() } });
  const error = await expectApiError(
    () =>
      h.service.createPost(USER_A, postInput({ body: '敌敌畏和百草枯一起打，效果更好' }), {
        idempotencyKey: idem(1),
      }),
    'INVALID_REQUEST',
    400,
  );
  assert.ok(
    (error.details ?? []).some((detail) => detail.code === 'DANGEROUS_MIX'),
    '规则层理由码只出现在错误封套的 details[].code 里',
  );

  const mine = await h.service.listPosts(USER_A);
  assert.deepEqual(mine.items, [], '规则层否决不落行：读面没有这条内容，也就没有"读面理由码"可言');
  assert.equal(h.store.snapshotCounts().posts, 0, '不落行是这条路径的既有语义，不是本片加的');
});
