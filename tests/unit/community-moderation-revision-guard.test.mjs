/**
 * GY-I14（#14）⇄ GY-I15（#15）联动接线 · **同源权威拒绝旧 revision 的可见性写入**（AC16 / AC19）。
 *
 * 覆盖诊断 `.pg17/analysis/i14-moderation-gaps-20261019.md` P1-2 的第 2 处缺陷：
 * `createCommunityContentAuthority` 的 `setVisibility`/`setPublishedRevision` 原先以
 * **行自身当前 revision** 作为 CAS 期望版本，于是"请求 revision=1、权威已是 revision=2"
 * 的旧请求会**写到新版本那一行上**（行被改成 published+approved，随后审核域在写后核对里抛错）。
 *
 * 现在的口径：写入前先核对 `target.revision === record.revision`，不一致 ⇒ `REVISION_CONFLICT`
 * 且**零副作用**（`state/visibility/audit_state/revision/updated_at` 逐字段不变）。
 *
 * 声明：本文件只用内存社区存储与合成夹具，不碰真实内容、不发网络请求。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryCommunityStore } from '../../services/api/src/community/store.ts';
import { createLocalPseudonymousAuthorDirectory } from '../../services/api/src/community/authors.ts';
import { createCommunityContentAuthority } from '../../services/api/src/community/moderation-authority.ts';
import { USER_A, expectApiError } from './community-moderation-fixtures.mjs';

const TS = '2026-10-20T04:00:00.000Z';
const POST_ID = 'post-rg-1001';
const TARGET_V1 = { type: 'post', id: POST_ID, revision: 1 };
const TARGET_V2 = { type: 'post', id: POST_ID, revision: 2 };

function postRow(overrides = {}) {
  return {
    id: POST_ID,
    revision: 2,
    author_id: USER_A,
    title: '苗情与轮作记录',
    body: '记录本轮苗情、轮作做法与观察条件。',
    crop_id: null,
    region_code: null,
    media_ids: [],
    linked_knowledge_ref: null,
    visibility: 'private',
    audit_state: 'pending',
    created_at: TS,
    updated_at: TS,
    ...overrides,
  };
}

async function makeAuthority() {
  const store = createMemoryCommunityStore({ now: () => new Date(TS) });
  const authors = createLocalPseudonymousAuthorDirectory();
  const authority = createCommunityContentAuthority({ store, authors });
  return { store, authors, authority };
}

test('RG-C1. 社区权威：旧 revision 的 setVisibility 在**任何写之前**拒绝，行逐字段不变', async () => {
  const { store, authority } = await makeAuthority();
  assert.equal(await store.insertPost(postRow(), null), true);
  const before = await store.getPost(POST_ID);
  assert.equal(before.revision, 2);

  const refused = await expectApiError(() => authority.setVisibility(TARGET_V1, 'published'), 'REVISION_CONFLICT', 409);
  assert.ok(refused.message.includes('旧版本不得改可见性'), refused.message);

  const after = await store.getPost(POST_ID);
  assert.deepEqual(after, before, '拒绝路径必须零副作用（state/visibility/audit_state/revision/updated_at 全不变）');
  assert.equal(await authority.publishedRevision(TARGET_V2), null, '不得产生"已发布版本"');
});

test('RG-C2. 社区权威：旧 revision 的 setPublishedRevision 同样拒绝，且不落"已发布版本"', async () => {
  const { store, authority } = await makeAuthority();
  assert.equal(await store.insertPost(postRow({ visibility: 'published', audit_state: 'approved' }), null), true);
  const before = await store.getPost(POST_ID);

  await expectApiError(() => authority.setPublishedRevision(TARGET_V1, 1), 'REVISION_CONFLICT', 409);
  await expectApiError(() => authority.setPublishedRevision(TARGET_V1, null), 'REVISION_CONFLICT', 409);
  assert.deepEqual(await store.getPost(POST_ID), before, '声明失败不得改写行');
});

test('RG-C3. 社区权威：版本一致时写入照常成功（正向对照，证明确实按 target.revision 核对而非一律拒绝）', async () => {
  const { store, authority } = await makeAuthority();
  assert.equal(await store.insertPost(postRow(), null), true);

  await authority.setVisibility(TARGET_V2, 'published');
  assert.equal((await store.getPost(POST_ID)).visibility, 'published');
  assert.equal((await store.getPost(POST_ID)).audit_state, 'approved');
  assert.equal((await store.getPost(POST_ID)).revision, 2, '审核域不推进社区 revision');
  await authority.setPublishedRevision(TARGET_V2, 2);
  assert.equal(await authority.publishedRevision(TARGET_V2), 2);
});

test('RG-C4. 社区权威：已删除仍是单向门（旧版本拒绝之外，deleted 也不得被改写）', async () => {
  const { store, authority } = await makeAuthority();
  assert.equal(await store.insertPost(postRow({ visibility: 'deleted', audit_state: 'rejected' }), null), true);
  const before = await store.getPost(POST_ID);

  // 契约里 `OBJECT_UNAVAILABLE` 的状态码是 409（不是 404：已删除不等于"不存在"）。
  await expectApiError(() => authority.setVisibility(TARGET_V2, 'published'), 'OBJECT_UNAVAILABLE', 409);
  assert.deepEqual(await store.getPost(POST_ID), before, '单向门不得被旧/新版本请求绕过');
});
