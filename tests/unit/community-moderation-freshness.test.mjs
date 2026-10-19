/**
 * GY-I14（#14）⇄ GY-I15（#15）· **源版本前进 ⇒ 已公开内容退为"待重评"**（`Refs #14`, `Refs #15`）。
 *
 * 诊断 `.pg17/analysis/i14-moderation-gaps-20261019.md` 的 4-3 / 派单 P2-2：
 * 已公开内容在源版本（此处是审核域的模型版本）前进后，必须被标为待重评，
 * 且**读面不得把待重评内容当已审返回**。
 *
 * 表达方式（**不新增契约状态**）：沿用既有 `audit_state: 'pending'`——过期既不是驳回，
 * 也不是通过；对用户就是"待重评"。审核域侧另给 `RESCREEN_REQUIRED`（非契约原因码）。
 *
 * 声明：模型端口是合成替身（不发网络请求、无凭据）；不发起任何真实模型/付费调用。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryCommunityStore } from '../../services/api/src/community/store.ts';
import { createLocalPseudonymousAuthorDirectory } from '../../services/api/src/community/authors.ts';
import { createCommunityContentAuthority } from '../../services/api/src/community/moderation-authority.ts';
import { createModerationService } from '../../services/api/src/moderation/service.ts';
import { createModerationLedger } from '../../services/api/src/moderation/decisions.ts';
import {
  START,
  USER_A,
  USER_B,
  expectApiError,
  idem,
  makeServiceHarness,
  makeWiredHarness,
  passingPort,
  postInput,
} from './community-moderation-fixtures.mjs';

test('模型版本前进 ⇒ 已公开内容退出公开面，作者视角退为 hidden + pending（既有状态，不新增）', async () => {
  // 一套**共享**的社区存储 + 内容权威 + 审核台账：版本前进前后必须看的是同一份事实。
  const store = createMemoryCommunityStore({ now: () => START });
  const authors = createLocalPseudonymousAuthorDirectory();
  const authority = createCommunityContentAuthority({ store, authors });
  const ledger = createModerationLedger();
  const moderation = createModerationService({
    executionMode: 'stub',
    ports: { tms: passingPort() },
    authority,
    store: ledger,
  });
  const h = makeWiredHarness({ store, authors, authority, moderation, ports: { tms: passingPort() } });

  const post = await h.service.createPost(USER_A, postInput(), { idempotencyKey: idem(1) });
  const published = await h.service.getPost(USER_A, post.id);
  assert.equal(published.visibility, 'published', '前提：投稿通过后已公开');
  assert.equal(published.audit_state, 'approved', '前提：当前版本下结论为 approved');
  assert.equal((await h.service.listPosts(USER_B, {})).items.length, 1, '前提：他人 feed 里可见');

  // **源版本前进**：同一份台账/权威/存储上换一个声明了新模型版本的审核域实例
  // （旧结论是"按 @1.0 审过的"，不能继续当作"按 @2.0 已审"）。
  const upgradedModeration = createModerationService({
    executionMode: 'stub',
    ports: { tms: passingPort({ model_version: 'synthetic-tms-model@2.0' }) },
    authority,
    store: ledger,
  });
  const upgraded = makeServiceHarness({ moderation: upgradedModeration, store, authors });

  // 作者视角：退为 hidden + pending（＝待重评），而不是仍报 approved。
  const demoted = await upgraded.service.getPost(USER_A, post.id);
  assert.equal(demoted.visibility, 'hidden', '过期内容不得继续以 published 返回');
  assert.equal(demoted.audit_state, 'pending', '过期必须表达为既有状态 pending（不新增状态值）');

  // 公开面：列表里消失、详情 404（未审内容不得对外）。
  assert.equal((await upgraded.service.listPosts(USER_B, {})).items.length, 0, '过期内容必须退出公开列表');
  await expectApiError(() => upgraded.service.getPost(USER_B, post.id), 'NOT_FOUND', 404);

  // **派生而非落库**：行本身没有被改写（重新用旧版本读，仍然可见）——
  // 这证明"待重评"是读面按版本派生出来的，不是把数据改坏了。
  const row = await store.getPost(post.id);
  assert.equal(row.visibility, 'published', '只是读面降级，社区内容行不得被改写');
  const stillFresh = makeServiceHarness({ moderation, store, authors });
  const again = await stillFresh.service.getPost(USER_B, post.id);
  assert.equal(again.visibility, 'published', '同一份数据在旧版本下仍可见（证明降级源于版本前进）');
  assert.equal(again.audit_state, 'approved');
});

test('负控制：没有版本前进时，同一条内容不得被降级（证明上一条不是"任何读都会 pending"）', async () => {
  const store = createMemoryCommunityStore({ now: () => START });
  const authors = createLocalPseudonymousAuthorDirectory();
  const authority = createCommunityContentAuthority({ store, authors });
  const ledger = createModerationLedger();
  const moderation = createModerationService({
    executionMode: 'stub',
    ports: { tms: passingPort() },
    authority,
    store: ledger,
  });
  const h = makeWiredHarness({ store, authors, authority, moderation, ports: { tms: passingPort() } });
  const post = await h.service.createPost(USER_A, postInput(), { idempotencyKey: idem(1) });

  const same = makeServiceHarness({ moderation, store, authors });
  const record = await same.service.getPost(USER_B, post.id);
  assert.equal(record.visibility, 'published');
  assert.equal(record.audit_state, 'approved');
  assert.equal((await same.service.listPosts(USER_B, {})).items.length, 1);
});
