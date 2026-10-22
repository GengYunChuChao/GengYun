/**
 * GY-R31 · F13 后续切片：**行级作者注销引用**（迁移 0030 / 方案 C）· 内存实现臂。
 *
 * 裁定：`.pg17/ruling-r31-f13-author-ref-20261022.md`（采用方案 C：`author_id` 可空 +
 * 行内列 `anonymized_author_ref`，不建新表、不回填）；设计：`.pg17/tmp/i474-author-id-design.md`。
 *
 * 本文件只断言**要求本身**，逐条对应裁定 §6 的 blocked 消除与 §7 的验收探针：
 *   1. 安全帖/评论保留，且行级 `author_id = NULL`、`anonymized_author_ref` 形状合法；
 *   2. **不再依赖进程内 Map**：换一个全新的作者目录实例（= 重启）读同一行，仍显示同一注销引用；
 *   3. 多副本：两个独立服务实例读同一行 ⇒ 同一个 `display_id`；
 *   4. `scope='mine'` 不把匿名行算作原用户（否则注销后还能"看到自己的帖子"）；
 *   5. 旧 `visibility='deleted'` 行跳过（不复活、不改作者指针）；
 *   6. 幂等：并发/重放不分裂引用、不重复替换。
 *
 * 真库（CHECK 约束、42501 授权负控制、真 PG 17 上的 forward/rollback）见
 * `tests/unit/community-author-ref-migration.test.mjs`（PGlite 内核）与
 * `tests/integration/community-pg.mjs`（未设 `COMMUNITY_PG_TEST_URL` ⇒ EXITCODE=77，未取得）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalPseudonymousAuthorDirectory } from '../../services/api/src/community/authors.ts';
import { createCommunityOwnerPurgePort } from '../../services/api/src/community/purge.ts';
import { CLEAN_BODY, CLEAN_TITLE, USER_A, USER_B, idem, makeHarness, publishPost } from './community-fixtures.mjs';

const REF_PATTERN = /^gy-anon-[0-9a-f]{16}$/;

/** 走真实端口的注销（与 `app.ts` 同形：同一个 store + 同一个作者目录）。 */
async function purge(h, ownerId) {
  const port = createCommunityOwnerPurgePort({ store: h.store, authors: h.authors });
  return port.purgeOwnerData(ownerId);
}

test('1. 安全帖子/评论：保留且 author_id=NULL、anonymized_author_ref 形状合法、正文与版本不变', async () => {
  const h = makeHarness();
  const post = await publishPost(h.service, USER_A, {}, idem(400));
  const comment = await h.service.createComment(
    USER_B,
    post.id,
    { body: '同问，我这边也差不多。' },
    { idempotencyKey: idem(401), ifMatch: `"${post.revision}"` },
  );
  // A 在自己的帖子下再留一条评论（确保帖与评都能被替换、且共用同一引用）。
  const ownComment = await h.service.createComment(
    USER_A,
    post.id,
    { body: '补充一下：按标签说明处理即可。' },
    { idempotencyKey: idem(402), ifMatch: `"${post.revision}"` },
  );

  const counts = await purge(h, USER_A.userId);
  assert.equal(counts.blocked, 0, `正常路径不得 blocked（现场 ${JSON.stringify(counts.blockedReasons)}）`);
  assert.equal(counts.authorRefsReplaced, 2, 'A 的 1 帖 + 1 评 = 2 行作者指针被替换');
  assert.equal(counts.retained, 2, '两条保留行照旧计入 retained（替换作者指针不算改动正文）');
  assert.equal(counts.records, 0, '替换作者指针不是"改动/删除正文" ⇒ records 必须为 0');

  const storedPost = await h.store.getPost(post.id);
  assert.equal(storedPost.author_id, null);
  assert.match(String(storedPost.anonymized_author_ref), REF_PATTERN);
  assert.equal(storedPost.visibility, 'published', 'F13：安全正文保留可见');
  assert.equal(storedPost.revision, post.revision, '保留不得推进 revision（审核结论按 revision+摘要绑定）');
  assert.equal(storedPost.title, CLEAN_TITLE);
  assert.equal(storedPost.body, CLEAN_BODY);

  const storedOwn = await h.store.getComment(ownComment.id);
  assert.equal(storedOwn.author_id, null);
  assert.equal(
    storedOwn.anonymized_author_ref,
    storedPost.anonymized_author_ref,
    '同一注销主体的帖与评必须共用同一个引用（逐主体独立，不逐行随机）',
  );

  // 他人内容一行不变。
  const storedOther = await h.store.getComment(comment.id);
  assert.equal(storedOther.author_id, USER_B.userId, '他人评论的作者指针不得被 A 的注销带走');
  assert.equal(storedOther.anonymized_author_ref, null);

  // 公开读取：仍是已注销投影，正文原样。
  const projected = await h.service.getPost(USER_B, post.id);
  assert.equal(projected.author.state, 'anonymized');
  assert.equal(projected.author.display_name, '已注销用户');
  assert.equal(projected.author.avatar_media_id, null);
  assert.equal(projected.body, CLEAN_BODY);
});

test('2. 重启（全新的作者目录实例）后仍匿名：引用只从**行内**读，不依赖进程内 Map', async () => {
  const h = makeHarness();
  const post = await publishPost(h.service, USER_A, {}, idem(410));
  await purge(h, USER_A.userId);
  const ref = (await h.store.getPost(post.id)).anonymized_author_ref;
  assert.match(String(ref), REF_PATTERN);

  // 模拟重启/换进程：**同一份存储** + 一个完全没有历史状态的作者目录（Map 是空的）。
  const restarted = makeHarness({ store: h.store, authors: createLocalPseudonymousAuthorDirectory() });
  const afterRestart = await restarted.service.getPost(USER_B, post.id);
  assert.equal(afterRestart.author.state, 'anonymized', '重启后仍必须是已注销投影');
  assert.equal(afterRestart.author.display_id, ref, '引用必须逐字来自行内列（换进程不得换 id）');
  assert.equal(afterRestart.author.display_name, '已注销用户');

  // 反向证明"确实没有走 Map"：新目录甚至不知道这个 userId（不知道就不该能反推）。
  const freshAuthors = createLocalPseudonymousAuthorDirectory();
  const byUserId = await freshAuthors.resolve(USER_A.userId);
  assert.equal(byUserId.state, 'active', '新实例对新主体只会给活跃假名 —— 说明上面的匿名只能来自行内引用');
});

test('3. 多副本一致：两个独立服务实例读同一行 ⇒ 同一个 display_id；重复注销不换串', async () => {
  const h = makeHarness();
  const post = await publishPost(h.service, USER_A, {}, idem(420));
  const first = await purge(h, USER_A.userId);
  assert.equal(first.authorRefsReplaced, 1);
  const ref = (await h.store.getPost(post.id)).anonymized_author_ref;

  const replicaA = makeHarness({ store: h.store, authors: createLocalPseudonymousAuthorDirectory() });
  const replicaB = makeHarness({ store: h.store, authors: createLocalPseudonymousAuthorDirectory() });
  const [viewA, viewB] = await Promise.all([
    replicaA.service.getPost(USER_B, post.id),
    replicaB.service.getPost(USER_B, post.id),
  ]);
  assert.equal(viewA.author.display_id, ref);
  assert.equal(viewB.author.display_id, ref);
  assert.equal(viewA.author.display_id, viewB.author.display_id, '多副本读同一行必须是同一串');

  // 重放（含并发）：已经匿名 ⇒ 一行都不替换；引用不得分裂。
  const replay = await Promise.all([purge(h, USER_A.userId), purge(h, USER_A.userId)]);
  for (const counts of replay) {
    assert.equal(counts.authorRefsReplaced, 0, '已匿名行不得被第二次替换');
    assert.equal(counts.blocked, 0);
    assert.equal(counts.retained, 0, '该主体名下已无行（author_id 已置空）⇒ retained 如实为 0');
  }
  assert.equal((await h.store.getPost(post.id)).anonymized_author_ref, ref, '引用不得被重放改成另一串');
});

test("4. scope='mine' 不把匿名行算作原用户（注销后 @me 里不得再出现这些内容）", async () => {
  const h = makeHarness();
  const post = await publishPost(h.service, USER_A, {}, idem(430));
  const other = await publishPost(h.service, USER_B, {}, idem(431));
  const before = await h.service.listPosts(USER_A, { mine: true, limit: 10 });
  assert.equal(before.items.some((item) => item.id === post.id), true, '基线：注销前 A 能在 @me 里看到自己的帖子');

  await purge(h, USER_A.userId);

  const after = await h.service.listPosts(USER_A, { mine: true, limit: 10 });
  assert.equal(after.items.some((item) => item.id === post.id), false, '匿名行（author_id=NULL）不属于任何主体');
  assert.equal(after.items.some((item) => item.id === other.id), false, "他人的内容本来就不该出现在 A 的 @me 里");

  // 但公开面照旧可见（保留正文、投影为已注销）—— "不属于原用户"≠"内容消失"。
  const publicView = await h.service.getPost(USER_B, post.id);
  assert.equal(publicView.id, post.id);
  assert.equal(publicView.author.state, 'anonymized');
  // B 的 @me 不受影响。
  const bMine = await h.service.listPosts(USER_B, { mine: true, limit: 10 });
  assert.equal(bMine.items.some((item) => item.id === other.id), true);
});

test('5. 旧 visibility=deleted 行跳过：不复活、不改作者指针、不计入替换行数', async () => {
  const h = makeHarness();
  const post = await publishPost(h.service, USER_A, {}, idem(440));
  const kept = await publishPost(h.service, USER_A, {}, idem(441));
  await h.service.deletePost(USER_A, post.id, { idempotencyKey: idem(442), ifMatch: `"${post.revision}"` });

  const counts = await purge(h, USER_A.userId);
  assert.equal(counts.authorRefsReplaced, 1, '只有未删除的 1 行被替换');
  assert.equal(counts.retained, 1);

  const deletedRow = await h.store.getPost(post.id);
  assert.equal(deletedRow.visibility, 'deleted', '不得复活已删除内容');
  // 如实残留（待裁口径未覆盖）：作者自己删掉的行沿用"原样跳过"，不替换作者指针。
  assert.equal(deletedRow.author_id, USER_A.userId);
  assert.equal(deletedRow.anonymized_author_ref, null);

  const keptRow = await h.store.getPost(kept.id);
  assert.equal(keptRow.author_id, null);
  assert.match(String(keptRow.anonymized_author_ref), REF_PATTERN);
});

test('6. 引用不可反查：不含原 id 的任何片段，且与"主体 id 无关的随机值"同分布', async () => {
  const h = makeHarness();
  const post = await publishPost(h.service, USER_A, {}, idem(450));
  await purge(h, USER_A.userId);
  const ref = String((await h.store.getPost(post.id)).anonymized_author_ref);
  assert.match(ref, REF_PATTERN);
  assert.equal(ref.includes(USER_A.userId), false);
  assert.equal(ref.includes(USER_A.userId.slice(0, 8)), false);
  assert.equal(ref.length, 'gy-anon-'.length + 16, '形状固定 24 字符（与列宽 varchar(40)、CHECK 一致）');

  // 同一主体第二个副本（另一个 harness）的引用不得与这里相同 ——
  // 证明引用是"每次注销现生成的随机值"，不是由主体 id 派生（可反查/可确认即不合格）。
  const h2 = makeHarness();
  const post2 = await publishPost(h2.service, USER_A, {}, idem(451));
  await purge(h2, USER_A.userId);
  const ref2 = String((await h2.store.getPost(post2.id)).anonymized_author_ref);
  assert.notEqual(ref2, ref, '同一 userId 在不同实例注销得到的引用不得相同（不是 id 的摘要）');
});
