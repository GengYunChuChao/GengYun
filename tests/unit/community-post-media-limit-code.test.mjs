// GY-R87（#1030 验收口径第 1 条）· 发帖/改帖「第 4 张图」的 HTTP 机器码回归。
//
// 缺口：`postBody.media_ids.maxItems: 3` 会先被 ajv 拦下，`app.ts` 把校验失败折叠成
// `400 INVALID_REQUEST`，`details[].code` 是 ajv 英文文案（`must NOT have more than 3 items in array`），
// 客户端拿不到领域同款的机器码 `post_image_limit`。
//
// 断言口径：逐条独立反例，先判 HTTP 状态、再判 `error.details` 逐字内容；
// 正控制确保「只换这一种失败的文案」，其它校验失败（uuid 格式等）仍然走 ajv 折叠。
// 全部为 stub 模式 + 合成身份（微信登录替身 code），不含真实个人数据或真实存储。
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';

/** 超限文案：与领域侧 / 上传面同一句（`每个帖子最多 3 张图片`）。 */
const LIMIT_MESSAGE = '每个帖子最多 3 张图片';
/** 期望的 details 首项：与领域侧 `store-pg.ts` 逐字一致。 */
const LIMIT_DETAIL = { field: '/media_ids', code: 'post_image_limit' };

let shared = null;

async function client() {
  if (shared !== null) return shared;
  const app = buildApp({
    config: { ...loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }), executionMode: 'stub' },
    now: () => new Date(1_700_000_000_000),
  });
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/wechat',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'login-key-r87-media-limit' },
    payload: { code: 'r87-media-limit' },
  });
  assert.equal(login.statusCode, 200, login.body);
  shared = { app, token: login.json().data.access_token };
  return shared;
}

after(async () => {
  if (shared !== null) await shared.app.close();
});

/** 发一次请求并归一化：`details` 永远是数组（缺失时是 `[]`），顺带留下原始 body 供诊断。 */
async function call(method, url, { payload, headers } = {}) {
  const { app, token } = await client();
  const response = await app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload }),
    headers: {
      authorization: `Bearer ${token}`,
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      ...(headers ?? {}),
    },
  });
  let body = null;
  try {
    body = response.json();
  } catch {
    body = null;
  }
  const details = Array.isArray(body?.error?.details) ? body.error.details : [];
  return {
    status: response.statusCode,
    code: body?.error?.code,
    message: body?.error?.message,
    details,
    body,
  };
}

const uuids = (n) => Array.from({ length: n }, () => randomUUID());
const postBodyWith = (mediaIds) => ({ title: '第 4 张图', body: '正文', media_ids: mediaIds });

/** 断言「详情里没有 post_image_limit」——正控制用。 */
function assertNoPostImageLimit(result, label) {
  const hit = result.details.filter((item) => item?.code === 'post_image_limit');
  assert.deepEqual(hit, [], `${label}：details 里不应出现 post_image_limit，实际 ${JSON.stringify(result.details)}`);
}

test('① POST /api/v1/posts 带 4 个 media_ids ⇒ 400，details[0] 逐字等于 { field: /media_ids, code: post_image_limit }', async (t) => {
  const result = await call('POST', '/api/v1/posts', {
    payload: postBodyWith(uuids(4)),
    headers: { 'idempotency-key': 'r87-post-4-media' },
  });
  t.diagnostic(`POST 4 uuid 实测：status=${result.status} code=${result.code} details=${JSON.stringify(result.details)}`);
  assert.equal(result.status, 400, result.body === null ? '' : JSON.stringify(result.body));
  assert.equal(result.code, 'INVALID_REQUEST');
  assert.deepEqual(result.details[0], LIMIT_DETAIL);
  // 文案与领域侧同句（不是 ajv 的 `must NOT have more than 3 items in array`）。
  assert.equal(result.message, LIMIT_MESSAGE);
});

test('② PATCH /api/v1/posts/{id} 带 4 个 media_ids ⇒ 400，details[0] 逐字等于 post_image_limit', async (t) => {
  // `preValidation` 在 `preHandler`（鉴权）与处理器（存在性 404 / If-Match 428）之前跑，
  // 所以这里不必先造出一个真实帖子：这正是不变量——4 个 media_ids 永远停在机器码这一层。
  const result = await call('PATCH', `/api/v1/posts/${randomUUID()}`, {
    payload: postBodyWith(uuids(4)),
    headers: { 'idempotency-key': 'r87-patch-4-media', 'if-match': '"1"' },
  });
  t.diagnostic(`PATCH 4 uuid 实测：status=${result.status} code=${result.code} details=${JSON.stringify(result.details)}`);
  assert.equal(result.status, 400, result.body === null ? '' : JSON.stringify(result.body));
  assert.equal(result.code, 'INVALID_REQUEST');
  assert.deepEqual(result.details[0], LIMIT_DETAIL);
  assert.equal(result.message, LIMIT_MESSAGE);
});

test('③ 正控制：3 个 media_ids 不被当成超限（details 里没有 post_image_limit）', async (t) => {
  const result = await call('POST', '/api/v1/posts', {
    payload: postBodyWith(uuids(3)),
    headers: { 'idempotency-key': 'r87-post-3-media' },
  });
  // stub 模式下带媒体投稿一定停在「规则层不评图 / 图审能力未接线」，故 422；这里只钉「不是超限码」，
  // 实际状态码写进诊断，未来审核装配变了也不必改这条断言。
  t.diagnostic(`3 uuid 实测：status=${result.status} code=${result.code} details=${JSON.stringify(result.details)}`);
  assertNoPostImageLimit(result, 'POST 3 uuid');
  // 也不该是「我们这个闸」拦下来的：超限判据只在 length > 3 时抛，3 个必然放行到后续环节。
  assert.notEqual(result.message, LIMIT_MESSAGE, `3 uuid 不应被超限闸拦下：${JSON.stringify(result.body)}`);
});

test('④ 正控制：2 个 media_ids 但第 2 个不是 uuid ⇒ 仍是 400 INVALID_REQUEST，code 是 ajv 文案', async (t) => {
  const result = await call('POST', '/api/v1/posts', {
    payload: postBodyWith([randomUUID(), 'not-a-uuid']),
    headers: { 'idempotency-key': 'r87-post-bad-uuid' },
  });
  t.diagnostic(`非 uuid 实测：status=${result.status} code=${result.code} details=${JSON.stringify(result.details)}`);
  assert.equal(result.status, 400);
  assert.equal(result.code, 'INVALID_REQUEST');
  assert.deepEqual(result.details, [{ field: '/media_ids/1', code: 'must match format "uuid"' }]);
  // 证明没有把别的校验失败一起吞成超限码。
  assertNoPostImageLimit(result, 'POST 非 uuid');
  assert.notEqual(result.message, LIMIT_MESSAGE);
});
