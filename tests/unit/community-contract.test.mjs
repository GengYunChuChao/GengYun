/**
 * GY-I15（#15）阶段 1 · 契约形状一致性用例。
 *
 * 做法：**在运行期读 `packages/contracts/openapi.json`**（只读），用一个够用的
 * JSON Schema 子集校验器逐字段校验服务真正返回的对象——包括
 * `additionalProperties:false`、`required`、`enum`、长度/数值/模式/`anyOf`。
 * 这样"响应形状"不是靠人手抄字段名对齐的，而是与契约原文对齐。
 *
 * 边界（不得误读）：
 *   - 这不是官方 JSON Schema 完整 validator，只覆盖本项目契约用到的关键字子集；
 *   - 也不代表 HTTP 层、Envelope(`meta`)、数据库或真实 AI 审核已验证。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CLEAN_BODY,
  CLEAN_TITLE,
  USER_A,
  USER_B,
  assertApiError,
  idem,
  makeHarness,
  publishPost,
} from './community-fixtures.mjs';

const openapi = JSON.parse(
  readFileSync(new URL('../../packages/contracts/openapi.json', import.meta.url), 'utf8'),
);
const schemas = openapi.components.schemas;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function resolveRef(schema) {
  if (schema === null || typeof schema !== 'object' || typeof schema.$ref !== 'string') return schema;
  const name = schema.$ref.split('/').pop();
  const target = schemas[name];
  if (target === undefined) throw new Error(`契约里找不到 schema：${schema.$ref}`);
  return target;
}

/** 够用的 JSON Schema 子集校验：返回问题清单（空数组 = 通过）。 */
function validate(schema, value, path, problems) {
  const node = resolveRef(schema);
  if (node === null || typeof node !== 'object') {
    problems.push(`${path}: schema 节点非法`);
    return;
  }

  if (Array.isArray(node.anyOf)) {
    const branches = node.anyOf.map((branch) => {
      const local = [];
      validate(branch, value, path, local);
      return local;
    });
    if (!branches.some((local) => local.length === 0)) {
      problems.push(`${path}: 不满足 anyOf 任一支（${JSON.stringify(value)}）`);
      return;
    }
  }

  if (node.const !== undefined && value !== node.const) {
    problems.push(`${path}: 期望 const ${JSON.stringify(node.const)}，实际 ${JSON.stringify(value)}`);
  }
  if (Array.isArray(node.enum) && !node.enum.includes(value)) {
    problems.push(`${path}: 不在枚举闭集内（${JSON.stringify(value)}）`);
  }

  if (node.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      problems.push(`${path}: 期望 object，实际 ${value === null ? 'null' : typeof value}`);
      return;
    }
    for (const key of node.required ?? []) {
      if (!(key in value)) problems.push(`${path}: 缺必填字段 ${key}`);
    }
    const properties = node.properties ?? {};
    for (const [key, item] of Object.entries(value)) {
      if (!(key in properties)) {
        if (node.additionalProperties === false) {
          problems.push(`${path}.${key}: additionalProperties:false 不允许该字段`);
        }
        continue;
      }
      validate(properties[key], item, `${path}.${key}`, problems);
    }
    return;
  }

  if (node.type === 'array') {
    if (!Array.isArray(value)) {
      problems.push(`${path}: 期望 array，实际 ${typeof value}`);
      return;
    }
    if (typeof node.maxItems === 'number' && value.length > node.maxItems) {
      problems.push(`${path}: 超过 maxItems ${node.maxItems}`);
    }
    if (node.uniqueItems === true) {
      const seen = new Set(value.map((item) => JSON.stringify(item)));
      if (seen.size !== value.length) problems.push(`${path}: 违反 uniqueItems`);
    }
    if (node.items !== undefined) {
      value.forEach((item, index) => validate(node.items, item, `${path}[${index}]`, problems));
    }
    return;
  }

  if (node.type === 'string') {
    if (typeof value !== 'string') {
      problems.push(`${path}: 期望 string，实际 ${typeof value}`);
      return;
    }
    if (typeof node.minLength === 'number' && value.length < node.minLength) {
      problems.push(`${path}: 短于 minLength ${node.minLength}`);
    }
    if (typeof node.maxLength === 'number' && value.length > node.maxLength) {
      problems.push(`${path}: 超过 maxLength ${node.maxLength}`);
    }
    if (typeof node.pattern === 'string' && !new RegExp(node.pattern).test(value)) {
      problems.push(`${path}: 不匹配 pattern ${node.pattern}`);
    }
    if (node.format === 'uuid' && !UUID.test(value)) problems.push(`${path}: 不是 uuid`);
    if (node.format === 'date-time' && Number.isNaN(Date.parse(value))) {
      problems.push(`${path}: 不是 date-time`);
    }
    return;
  }

  if (node.type === 'integer' || node.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      problems.push(`${path}: 期望 number，实际 ${typeof value}`);
      return;
    }
    if (node.type === 'integer' && !Number.isSafeInteger(value)) {
      problems.push(`${path}: 期望 integer`);
    }
    if (typeof node.minimum === 'number' && value < node.minimum) {
      problems.push(`${path}: 小于 minimum ${node.minimum}`);
    }
    if (typeof node.maximum === 'number' && value > node.maximum) {
      problems.push(`${path}: 超过 maximum ${node.maximum}`);
    }
    return;
  }

  if (node.type === 'boolean' && typeof value !== 'boolean') {
    problems.push(`${path}: 期望 boolean，实际 ${typeof value}`);
  }
}

function check(name, value) {
  const problems = [];
  validate({ $ref: `#/components/schemas/${name}` }, value, name, problems);
  return problems;
}

test('元测试：校验器本身有牙齿（多余字段/缺必填/越界长度都能被抓到）', () => {
  assert.ok(check('Author', { display_name: 'ok', display_id: 'ok', state: 'active', avatar_media_id: null, revision: 1, avatar_media: null }).length === 0);
  assert.ok(
    check('Author', {
      display_name: 'ok',
      display_id: 'ok',
      state: 'active',
      avatar_media_id: null,
      revision: 1,
      avatar_media: null,
      extra: 1,
    }).some((item) => item.includes('additionalProperties')),
  );
  assert.ok(
    check('Author', { display_name: 'ok', display_id: 'ok', state: 'active', avatar_media_id: null, revision: 1 }).some(
      (item) => item.includes('缺必填字段 avatar_media'),
    ),
  );
  assert.ok(
    check('Author', { display_name: '', display_id: 'ok', state: 'active', avatar_media_id: null, revision: 1, avatar_media: null }).some(
      (item) => item.includes('短于 minLength'),
    ),
  );
  assert.ok(
    check('Author', { display_name: 'ok', display_id: 'ok', state: 'bogus', avatar_media_id: null, revision: 1, avatar_media: null }).some(
      (item) => item.includes('枚举'),
    ),
  );
});

test('createPost / getPost / listPosts 的响应形状与契约 Post 完全一致', async () => {
  const h = makeHarness();
  const created = await publishPost(h.service, USER_A, {}, idem(1));
  assert.deepEqual(check('Post', created), [], 'createPost 返回必须满足契约 Post');

  const detail = await h.service.getPost(USER_B, created.id);
  assert.deepEqual(check('Post', detail), []);

  const comment = await h.service.createComment(USER_B, created.id, { body: '评论区内容' }, {
    idempotencyKey: idem(2),
    ifMatch: `"${created.revision}"`,
  });
  assert.deepEqual(check('Comment', comment), [], 'createComment 返回必须满足契约 Comment');
  assert.equal(comment.post_id, created.id);

  const posts = await h.service.listPosts(USER_A, { limit: 1 });
  assert.deepEqual(check('PostPage', posts), [], '列表必须是 {items[], next_cursor}');
  assert.equal(posts.next_cursor, null);
  const comments = await h.service.listComments(USER_B, created.id, {});
  assert.deepEqual(check('CommentPage', comments), []);
  assert.ok(comments.items.length <= 50);
});

test('editPost / deletePost / 点赞 的响应形状与契约一致（Post / Ack）', async () => {
  const h = makeHarness();
  const created = await publishPost(h.service, USER_A, {}, idem(3));
  const edited = await h.service.editPost(USER_A, created.id, { title: CLEAN_TITLE, body: `${CLEAN_BODY}补充` , media_ids: [] }, {
    idempotencyKey: idem(4),
    ifMatch: `"${created.revision}"`,
  });
  assert.deepEqual(check('Post', edited), []);
  assert.equal(edited.revision, created.revision + 1);

  const ack = await h.service.likePosts(USER_B, edited.id, { idempotencyKey: idem(5), ifMatch: `"${edited.revision}"` });
  assert.deepEqual(check('Ack', ack), []);
  const unlike = await h.service.unlikePosts(USER_B, edited.id, { idempotencyKey: idem(6), ifMatch: `"${edited.revision}"` });
  assert.deepEqual(check('Ack', unlike), []);

  const deleted = await h.service.deletePost(USER_A, edited.id, {
    idempotencyKey: idem(7),
    ifMatch: `"${edited.revision}"`,
  });
  assert.deepEqual(check('Ack', deleted), []);
});

test('createReport / getOwnReport 的响应形状与契约 Report 一致', async () => {
  const h = makeHarness();
  const post = await publishPost(h.service, USER_A, { title: CLEAN_TITLE, body: CLEAN_BODY }, idem(8));
  const report = await h.service.createReport(
    USER_B,
    { target_ref: { type: 'post', id: post.id, revision: post.revision }, reason_code: 'misleading', detail: '合成举报说明' },
    { idempotencyKey: idem(9) },
  );
  assert.deepEqual(check('Report', report), []);
  const own = await h.service.getOwnReport(USER_B, report.id);
  assert.deepEqual(check('Report', own), []);
  assert.deepEqual(check('ReportTarget', report.target_ref), []);
});

test('反例：审核台账**不得**冒充契约 Moderation（缺 model_version/prompt_version 必须被契约拒绝）', async () => {
  const h = makeHarness();
  const post = await publishPost(h.service, USER_A, {}, idem(10));
  const record = await h.service.getModerationDecision(USER_A, { type: 'post', id: post.id, revision: 1 });
  assert.equal(typeof record.decision, 'string');
  assert.equal(record.contract_complete, false);
  assert.ok(record.missing_contract_fields.includes('model_version'));
  assert.ok(record.missing_contract_fields.includes('prompt_version'));

  const problems = check('Moderation', record);
  assert.ok(
    problems.some((item) => item.includes('model_version')) &&
      problems.some((item) => item.includes('prompt_version')),
    `契约必须拒绝这份不完整的 Moderation，实际问题：${JSON.stringify(problems)}`,
  );
  // 规则层真正产出的四个字段必须本身合规。
  assert.equal(typeof record.rule_version, 'string');
  assert.equal(typeof record.hard_rule_passed, 'boolean');
  assert.ok(record.reason_codes.length <= 30);
});

test('getComment / editComment / deleteComment 的响应形状与契约一致（Comment / Ack）', async () => {
  const h = makeHarness();
  const post = await publishPost(h.service, USER_A, {}, idem(11));
  const comment = await h.service.createComment(USER_B, post.id, { body: '评论区的第一版正文' }, {
    idempotencyKey: idem(12),
    ifMatch: `"${post.revision}"`,
  });
  assert.deepEqual(check('Comment', comment), [], 'createComment 返回必须满足契约 Comment');
  assert.equal(comment.revision, 1, '新评论从 revision 1 起（下面"旧 revision"反例要用字面量 "1"）');

  const read = await h.service.getComment(USER_B, comment.id);
  assert.deepEqual(check('Comment', read), [], 'getComment 返回必须满足契约 Comment');
  assert.equal(read.id, comment.id);
  assert.equal(read.post_id, post.id);
  assert.equal(read.revision, comment.revision);

  const edited = await h.service.editComment(USER_B, comment.id, { body: '改后的正文' }, {
    idempotencyKey: idem(13),
    ifMatch: `"${comment.revision}"`,
  });
  assert.deepEqual(check('Comment', edited), [], 'editComment 返回必须满足契约 Comment');
  assert.equal(edited.revision, comment.revision + 1);
  assert.equal(edited.body, '改后的正文');

  // 反例一：非作者编辑 ⇒ 与他人不可见同形的 404（不泄露存在性），且不落新版本。
  await assert.rejects(
    h.service.editComment(USER_A, comment.id, { body: '越权的改写' }, {
      idempotencyKey: idem(14),
      ifMatch: `"${edited.revision}"`,
    }),
    assertApiError('NOT_FOUND', 404),
  );

  // 反例二：拿旧 revision 编辑（当前已是 2，If-Match 仍给 "1"）⇒ 409 REVISION_CONFLICT。
  await assert.rejects(
    h.service.editComment(USER_B, comment.id, { body: '拿着旧版本再改' }, {
      idempotencyKey: idem(15),
      ifMatch: '"1"',
    }),
    assertApiError('REVISION_CONFLICT', 409),
  );

  const deleted = await h.service.deleteComment(USER_B, comment.id, {
    idempotencyKey: idem(16),
    ifMatch: `"${edited.revision}"`,
  });
  assert.deepEqual(check('Ack', deleted), [], 'deleteComment 返回必须满足契约 Ack');

  // 反例三：软删后读不到（不是返回一条 visibility=deleted 的 Comment）。
  await assert.rejects(h.service.getComment(USER_B, comment.id), assertApiError('NOT_FOUND', 404));
});

test('likeComments / unlikeComments 的响应形状与契约一致（Ack），重复 PUT 幂等、未点赞取消不回退', async () => {
  const h = makeHarness();
  const post = await publishPost(h.service, USER_A, {}, idem(17));
  const comment = await h.service.createComment(USER_B, post.id, { body: '被点赞的那条评论' }, {
    idempotencyKey: idem(18),
    ifMatch: `"${post.revision}"`,
  });
  const ifMatch = `"${comment.revision}"`;

  const liked = await h.service.likeComments(USER_A, comment.id, { idempotencyKey: idem(19), ifMatch });
  assert.deepEqual(check('Ack', liked), [], 'likeComments 返回必须满足契约 Ack');
  assert.equal(liked.accepted, true);

  // 同一把幂等键重复 PUT：走幂等重放，同样是 Ack，不得抛错、不得重复计数。
  const replayed = await h.service.likeComments(USER_A, comment.id, { idempotencyKey: idem(19), ifMatch });
  assert.deepEqual(check('Ack', replayed), [], '重复 PUT 的幂等重放也必须满足契约 Ack');
  assert.equal(replayed.accepted, true);

  const afterLike = await h.service.getComment(USER_B, comment.id);
  assert.deepEqual(check('Comment', afterLike), []);
  // 契约 Comment **没有** like_count（且 additionalProperties:false 不许带额外字段），
  // 所以计数不能从契约读面取——本文件用这条断言把"契约缺该字段"钉住，计数改由服务诊断口 countLikes 读。
  assert.ok(
    check('Comment', { ...afterLike, like_count: 1 }).some((item) => item.includes('additionalProperties')),
    '契约 Comment 不含 like_count，计数只能取服务诊断口 countLikes',
  );
  assert.equal(await h.service.countLikes('comment', comment.id), 1, '重复 PUT 不得重复计数（不得为 2）');

  const unliked = await h.service.unlikeComments(USER_A, comment.id, { idempotencyKey: idem(20), ifMatch });
  assert.deepEqual(check('Ack', unliked), [], 'unlikeComments 返回必须满足契约 Ack');
  assert.equal(await h.service.countLikes('comment', comment.id), 0);

  // 未点赞状态再取消一次：仍 Ack、不抛错，计数不回退成 -1。
  const unlikedAgain = await h.service.unlikeComments(USER_A, comment.id, { idempotencyKey: idem(21), ifMatch });
  assert.deepEqual(check('Ack', unlikedAgain), []);
  assert.equal(unlikedAgain.accepted, true);
  assert.equal(await h.service.countLikes('comment', comment.id), 0, '不得回退成 -1');
  // 点赞/取消都不是内容编辑：不得抬高 revision/ETag。
  assert.equal((await h.service.getComment(USER_B, comment.id)).revision, comment.revision);
});
