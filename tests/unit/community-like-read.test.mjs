/**
 * GY-I15（#15）· 点赞的**对外读取面**（`getPostLike` ⇒ `GET /posts/{id}/like`）。
 *
 * 本文件把三件事钉住（派单 §2 A/C/D）：
 *   1. **行为**：0 赞、N 赞、同人重复点赞不重复计数、取消后回落；`liked_by_me` 只反映请求方自己。
 *   2. **鉴权与错误面与既有读帖路径一致**：不存在 / 已下架 / 已删除 / 后台会话 / 非 uuid
 *      一律返回**既有**错误码（`NOT_FOUND` / `SCOPE_DENIED` / `INVALID_REQUEST`），不新造错误码；
 *      作者本人仍可读自己的非删除内容（与 `getPost` 同一条 `readablePost` 闸门）。
 *   3. **契约红线**：读面是**独立** schema `LikeStatus`（`additionalProperties:false`，只有
 *      `count` 与 `liked_by_me` 两个字段）；`Post`/`Comment` **仍然没有**任何点赞计数字段
 *      （对应的负控制仍在 `tests/unit/community-contract.test.mjs`，**一字未改**）。
 *
 * 声明（不得误读）：计数走 `count(*)` 现算（集合大小派生），**没有计数器列**；本文件不连真库
 * （真库行为见 `tests/integration/community-pg.mjs`），也不代表前端已接入该端点。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ADMIN,
  USER_A,
  USER_B,
  assertApiError,
  idem,
  makeHarness,
  publishPost,
} from './community-fixtures.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const openapi = JSON.parse(readFileSync(resolve(root, 'packages/contracts/openapi.json'), 'utf8'));

const likeStatus = openapi.components.schemas.LikeStatus;
const likeStatusEnvelope = openapi.components.schemas.LikeStatusEnvelope;
const ABSENT = '00000000-0000-4000-8000-000000000000';

/** 按契约 `LikeStatus` 校验（手写子集：只用到本 schema 的 `additionalProperties`/`required`/类型）。 */
function checkLikeStatus(value) {
  const problems = [];
  const properties = likeStatus.properties;
  for (const key of Object.keys(value)) {
    if (!(key in properties)) problems.push(`additionalProperties: 未定义字段 ${key}`);
  }
  for (const key of likeStatus.required) {
    if (!(key in value)) problems.push(`required: 缺必填字段 ${key}`);
  }
  if (!Number.isInteger(value.count) || value.count < 0) problems.push('count: 必须是非负整数');
  if (typeof value.liked_by_me !== 'boolean') problems.push('liked_by_me: 必须是布尔');
  return problems;
}

test('GET /posts/{id}/like 的行为：0 赞 / N 赞 / 同人重复点赞不重复计数 / 取消后回落', async () => {
  const h = makeHarness();
  const post = await publishPost(h.service, USER_A, {}, idem(1));
  const ifMatch = `"${post.revision}"`;

  // 0 赞：身份可得 ⇒ `liked_by_me` 恒为布尔（不是 null）。匿名读在本服务不存在：
  // 所有社区读写都是 `guards.requireUser`（游客 401），所以不做"匿名时置 null"的自创变体。
  const zero = await h.service.getPostLike(USER_A, post.id);
  assert.deepEqual(zero, { count: 0, liked_by_me: false });
  assert.deepEqual(checkLikeStatus(zero), [], 'getPostLike 返回必须满足契约 LikeStatus');

  // A 点赞 ⇒ 对 A 是 1/true，对 B 仍是 1/false（计数是公共量，liked_by_me 是身份量）。
  await h.service.likePosts(USER_A, post.id, { idempotencyKey: idem(2), ifMatch });
  assert.deepEqual(await h.service.getPostLike(USER_A, post.id), { count: 1, liked_by_me: true });
  assert.deepEqual(await h.service.getPostLike(USER_B, post.id), { count: 1, liked_by_me: false });

  // B 也点赞 ⇒ 2。
  await h.service.likePosts(USER_B, post.id, { idempotencyKey: idem(3), ifMatch });
  assert.deepEqual(await h.service.getPostLike(USER_A, post.id), { count: 2, liked_by_me: true });

  // 同人重复点赞（**新的**幂等键，绕开幂等重放，真正走第二次 INSERT）⇒ 计数不变。
  await h.service.likePosts(USER_A, post.id, { idempotencyKey: idem(4), ifMatch });
  assert.deepEqual(await h.service.getPostLike(USER_A, post.id), { count: 2, liked_by_me: true }, '同人重复点赞不得重复计数');

  // 取消后回落：B 取消 ⇒ 1，A 的 liked_by_me 不受影响；A 取消 ⇒ 0/false。
  await h.service.unlikePosts(USER_B, post.id, { idempotencyKey: idem(5), ifMatch });
  assert.deepEqual(await h.service.getPostLike(USER_A, post.id), { count: 1, liked_by_me: true });
  assert.deepEqual(await h.service.getPostLike(USER_B, post.id), { count: 1, liked_by_me: false });
  await h.service.unlikePosts(USER_A, post.id, { idempotencyKey: idem(6), ifMatch });
  assert.deepEqual(await h.service.getPostLike(USER_A, post.id), { count: 0, liked_by_me: false });

  // 未点赞再取消一次（幂等空操作）⇒ 计数不为负，读取面也不会漂。
  await h.service.unlikePosts(USER_A, post.id, { idempotencyKey: idem(7), ifMatch });
  assert.deepEqual(await h.service.getPostLike(USER_A, post.id), { count: 0, liked_by_me: false }, '不得回退成 -1');

  // 点赞/取消都不是内容编辑：读面不改变 Post 的 revision（因此读端点也不需要 ETag）。
  assert.equal((await h.service.getPost(USER_B, post.id)).revision, post.revision);
});

test('getPostLike 的可见性闸门与 getPost 同一道：不存在/已下架/已删除/后台会话/非 uuid ⇒ 既有错误码', async () => {
  const h = makeHarness();
  const post = await publishPost(h.service, USER_A, {}, idem(11));

  // ① 不存在的 id：与 `getPost` 同形（`NOT_FOUND`，不泄露存在性）。
  await assert.rejects(h.service.getPostLike(USER_A, ABSENT), assertApiError('NOT_FOUND', 404));
  await assert.rejects(h.service.getPost(USER_A, ABSENT), assertApiError('NOT_FOUND', 404));

  // ② 非 uuid：与既有读路径同一校验（`INVALID_REQUEST` 400），不是新错误码。
  await assert.rejects(h.service.getPostLike(USER_A, 'not-a-uuid'), assertApiError('INVALID_REQUEST', 400));
  await assert.rejects(h.service.getPost(USER_A, 'not-a-uuid'), assertApiError('INVALID_REQUEST', 400));

  // ③ 后台会话：`requireUserActor` 兜底（`SCOPE_DENIED` 403，后台会话不得代替用户会话）。
  await assert.rejects(h.service.getPostLike(ADMIN, post.id), assertApiError('SCOPE_DENIED', 403));
  await assert.rejects(h.service.getPost(ADMIN, post.id), assertApiError('SCOPE_DENIED', 403));

  // ④ 已下架：他人读不到（同一个 404），作者本人仍可读自己的非删除内容（与 `getPost` 一致）。
  const hidden = await h.store.commitPostIfCurrent(
    post.id,
    { revision: post.revision, visibility: 'published' },
    { revision: post.revision + 1, visibility: 'hidden' },
    null,
  );
  assert.equal(hidden.ok, true, '夹具前置：把帖子改成 hidden 必须成功');
  await assert.rejects(h.service.getPostLike(USER_B, post.id), assertApiError('NOT_FOUND', 404));
  await assert.rejects(h.service.getPost(USER_B, post.id), assertApiError('NOT_FOUND', 404));
  const mine = await h.service.getPostLike(USER_A, post.id);
  assert.deepEqual(checkLikeStatus(mine), []);
  assert.equal((await h.service.getPost(USER_A, post.id)).visibility, 'hidden');

  // ⑤ 已删除：作者自己也读不到（软删是单向门）——两条路径的结论必须一致。
  const deleted = await h.service.deletePost(USER_A, post.id, {
    idempotencyKey: idem(12),
    ifMatch: `"${post.revision + 1}"`,
  });
  assert.equal(deleted.accepted, true);
  await assert.rejects(h.service.getPostLike(USER_A, post.id), assertApiError('NOT_FOUND', 404));
  await assert.rejects(h.service.getPost(USER_A, post.id), assertApiError('NOT_FOUND', 404));
});

test('契约 LikeStatus 形状：只允许 count 与 liked_by_me，且 Post/Comment 仍然没有点赞计数字段', () => {
  // ① 独立 schema：`additionalProperties:false` + 两个必填字段，没有别的。
  assert.equal(likeStatus.type, 'object');
  assert.equal(likeStatus.additionalProperties, false);
  assert.deepEqual(Object.keys(likeStatus.properties).sort(), ['count', 'liked_by_me']);
  assert.deepEqual([...likeStatus.required].sort(), ['count', 'liked_by_me']);
  assert.equal(likeStatus.properties.count.type, 'integer');
  assert.equal(likeStatus.properties.count.minimum, 0);
  assert.equal(likeStatus.properties.liked_by_me.type, 'boolean');

  // ② 封套与既有 envelope 同形（data + meta，不允许额外字段）。
  assert.equal(likeStatusEnvelope.additionalProperties, false);
  assert.deepEqual([...likeStatusEnvelope.required].sort(), ['data', 'meta']);
  assert.equal(likeStatusEnvelope.properties.data.$ref, '#/components/schemas/LikeStatus');
  assert.equal(likeStatusEnvelope.properties.meta.$ref, '#/components/schemas/Meta');

  // ③ 路径登记：独立读端点，鉴权与既有读帖路径同一档（`userSession`），不需要 If-Match。
  const op = openapi.paths['/posts/{id}/like'].get;
  assert.equal(op.operationId, 'getPostLike');
  assert.deepEqual(op.security, [{ userSession: [] }]);
  assert.equal(op['x-scope'], 'user');
  assert.equal(op['x-version-required'], false);
  const headerNames = (op.parameters ?? []).filter((item) => item.in === 'header').map((item) => item.name);
  assert.deepEqual(headerNames, [], '只读端点不要求 Idempotency-Key / If-Match');

  // ④ **红线**：`Post` / `Comment` 依旧没有任何点赞计数字段（拒绝"加字段"的替代方案）。
  for (const name of ['Post', 'Comment']) {
    const schema = openapi.components.schemas[name];
    const fields = Object.keys(schema.properties);
    assert.equal(fields.some((field) => field.toLowerCase().includes('like')), false, `契约 ${name} 不得含点赞字段：${fields}`);
    assert.equal(schema.additionalProperties, false, `契约 ${name} 必须是 additionalProperties:false`);
  }
});
