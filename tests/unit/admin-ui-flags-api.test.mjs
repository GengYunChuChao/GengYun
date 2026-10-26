/**
 * 后台「功能开关」HTTP 层单测：`apps/admin/src/lib/flags-api.mjs`（operationId `listFlags` / `setFlag`）。
 *
 * 本片补的是 R64 侦察报告里「有 UI 但无 admin-ui 测试」的两条（`listFlags`、`setFlag`）。
 * 口径：**以契约为事实**。凡是 URL／method／请求头／请求体形状的断言，都在运行期从
 * `packages/contracts/openapi.json` 取，而不是抄写手的记忆：
 *   - `GET  /admin/feature-flags`        `listFlags` scope `flags:read`
 *   - `PUT  /admin/feature-flags/{key}`  `setFlag`   scope `flags:write`；
 *     参数 `IdempotencyKey`（8..128）+ `IfMatch`（`^"[1-9][0-9]*"$`，不允许 `*`），
 *     请求体 `FlagInput = { enabled, reason }`（`additionalProperties: false`，两者 required）。
 *
 * 重点钉住四条：
 *  1. **请求体形状与契约一致**：键集合恰为 `FlagInput.properties`，没有 `key`／`revision`／`scope`
 *     这类契约外字段，且 reason 长度落在契约区间内 —— 不是「发了个 PUT」就算过；
 *  2. **If-Match 只能是 `"<正整数>"`**：`*`／`0`／裸数字在本地就被拒绝，不发必然失败的请求；
 *  3. **Idempotency-Key 缺失／过短在本地就拒绝**（契约 8..128），不把 400 留给服务端；
 *  4. 失败时 `status`／`code`／`retryAfterSeconds` 原样保留，由页面决定怎么显示。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

import {
  FLAG_KEYS,
  FLAGS_PATH,
  FLAGS_READ_SCOPE,
  FLAGS_WRITE_SCOPE,
  IF_MATCH_RE,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  REASON_MAX_LENGTH,
  REASON_MIN_LENGTH,
  buildFlagsUrl,
  etagForRevision,
  fetchFlagsPage,
  newIdempotencyKey,
  putFlag,
  reasonProblem,
  validateFlag,
  validateFlagPage,
} from '../../apps/admin/src/lib/flags-api.mjs';

const CONTRACT = JSON.parse(readFileSync(new URL('../../packages/contracts/openapi.json', import.meta.url), 'utf8'));
const LIST_FLAGS = CONTRACT.paths['/admin/feature-flags'].get;
const SET_FLAG = CONTRACT.paths['/admin/feature-flags/{key}'].put;
const FLAG = CONTRACT.components.schemas.Flag;
const FLAG_INPUT = CONTRACT.components.schemas.FlagInput;
const IDEMPOTENCY_KEY = CONTRACT.components.parameters.IdempotencyKey.schema;
const IF_MATCH = CONTRACT.components.parameters.IfMatch;

const TOKEN = 'synthetic-admin-token';
const BASE_URL = '/api/v1';
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const REASON = '按运营确认关闭用户投稿';

function jsonResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    async json() {
      return body;
    },
  };
}

function envelope(data, headers = {}) {
  return jsonResponse(200, { data, meta: { request_id: REQUEST_ID, contract_version: '1.0.0', execution_mode: 'stub' } }, headers);
}

function errorResponse(status, code, headers = {}) {
  return jsonResponse(
    status,
    { error: { code, message: `服务端说明 ${code}`, retryable: false, details: [] }, meta: { request_id: REQUEST_ID } },
    headers,
  );
}

function spy(responder) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return responder(url, init);
  };
  return { fetchImpl, calls };
}

function flag(overrides = {}) {
  return { key: 'ai_enabled', enabled: false, revision: 3, ...overrides };
}

/** 契约里 operation 的参数名（`$ref` 取末段）。 */
function paramNames(operation) {
  return operation.parameters.map((parameter) => ('$ref' in parameter ? parameter.$ref.split('/').pop() : parameter.name));
}

/**
 * 请求体**形状**断言：键集合与 `FlagInput.properties` 逐字相等（`additionalProperties: false`），
 * required 两条都在，类型与长度边界按契约。⛔ 只断言「发了个 PUT」不算覆盖 setFlag。
 */
function assertFlagInputBody(bodyText, expected) {
  assert.equal(typeof bodyText, 'string', '写请求必须带 JSON 请求体');
  const body = JSON.parse(bodyText);
  const contractKeys = Object.keys(FLAG_INPUT.properties).sort();
  assert.deepEqual(FLAG_INPUT.required.slice().sort(), ['enabled', 'reason'], '契约 FlagInput.required 变了');
  assert.equal(FLAG_INPUT.additionalProperties, false, '契约 FlagInput 必须是 additionalProperties:false');
  assert.deepEqual(Object.keys(body).sort(), contractKeys, `请求体键集合必须恰为契约 FlagInput.properties（实测 ${JSON.stringify(Object.keys(body))}）`);
  for (const forbidden of ['key', 'revision', 'scope', 'id', 'updated_at']) {
    assert.equal(forbidden in body, false, `请求体不得出现契约外字段 ${forbidden}`);
  }
  assert.equal(typeof body.enabled, 'boolean', '契约 FlagInput.enabled 是布尔');
  assert.equal(typeof body.reason, 'string', '契约 FlagInput.reason 是字符串');
  const length = [...body.reason].length;
  assert.ok(
    length >= FLAG_INPUT.properties.reason.minLength && length <= FLAG_INPUT.properties.reason.maxLength,
    `reason 长度 ${length} 必须落在契约 ${FLAG_INPUT.properties.reason.minLength}..${FLAG_INPUT.properties.reason.maxLength}`,
  );
  assert.equal(body.enabled, expected.enabled);
  assert.equal(body.reason, expected.reason);
  return body;
}

test('契约同形：路径／操作／scope／闭集边界与 openapi.json 逐条相等', () => {
  assert.equal(FLAGS_PATH, '/admin/feature-flags');
  assert.equal(LIST_FLAGS.operationId, 'listFlags');
  assert.equal(SET_FLAG.operationId, 'setFlag');
  assert.equal(LIST_FLAGS['x-scope'], FLAGS_READ_SCOPE);
  assert.equal(SET_FLAG['x-scope'], FLAGS_WRITE_SCOPE);

  // 写面参数：必须同时要求 Idempotency-Key 与 If-Match（缺一个页面就会发出必败请求）。
  assert.deepEqual(paramNames(SET_FLAG).sort(), ['IdempotencyKey', 'IfMatch', 'key']);
  assert.equal(IDEMPOTENCY_KEY_MIN_LENGTH, IDEMPOTENCY_KEY.minLength);
  assert.equal(IDEMPOTENCY_KEY_MAX_LENGTH, IDEMPOTENCY_KEY.maxLength);
  assert.equal(IF_MATCH_RE.source, IF_MATCH.schema.pattern, '本地 ETag 正则必须与契约 IfMatch.pattern 同源');
  assert.match(IF_MATCH.description, /不允许\*/);
  assert.equal(IF_MATCH_RE.test('*'), false, '契约 If-Match 不允许通配');
  assert.equal(IF_MATCH_RE.test('3'), false, '裸数字不是 ETag（必须带引号）');

  // 开关键闭集与 Flag.key enum 逐字相等（不是子集）。
  assert.deepEqual([...FLAG_KEYS].sort(), [...FLAG.properties.key.enum].sort());
  assert.equal(REASON_MIN_LENGTH, FLAG_INPUT.properties.reason.minLength);
  assert.equal(REASON_MAX_LENGTH, FLAG_INPUT.properties.reason.maxLength);
  // 契约 Flag 没有 scope 字段：页面上的「本会话写权限」只能是会话 scope，不能来自 Flag。
  assert.deepEqual(Object.keys(FLAG.properties).sort(), ['enabled', 'key', 'revision']);
  assert.equal('scope' in FLAG.properties, false);
});

test('列出开关：GET /admin/feature-flags?limit=20，只带 authorization，不带 If-Match／Idempotency-Key', async () => {
  const { fetchImpl, calls } = spy(() => envelope({ items: [flag({ key: 'ai_enabled', enabled: true, revision: 4 })], next_cursor: null }));
  const result = await fetchFlagsPage({ fetchImpl, baseUrl: BASE_URL, token: TOKEN });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/v1/admin/feature-flags?limit=20');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].init.headers.accept, 'application/json');
  assert.equal('if-match' in calls[0].init.headers, false, '读面不得带 If-Match');
  assert.equal('idempotency-key' in calls[0].init.headers, false, '读面不得带 Idempotency-Key');
  assert.equal('body' in calls[0].init, false, 'GET 不得带请求体');
  assert.equal(result.page.items.length, 1);
  assert.equal(result.page.items[0].revision, 4);
  assert.equal(result.page.nextCursor, null);

  assert.equal(buildFlagsUrl(BASE_URL, { cursor: 'c1', limit: 5 }), '/api/v1/admin/feature-flags?limit=5&cursor=c1');
});

test('列出开关：游标超契约上限 ⇒ 本地拒绝、一个请求都不发', async () => {
  const { fetchImpl, calls } = spy(() => envelope({ items: [], next_cursor: null }));
  const tooLong = 'c'.repeat(2049);
  const result = await fetchFlagsPage({ fetchImpl, baseUrl: BASE_URL, token: TOKEN, cursor: tooLong });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'invalid_cursor');
  assert.equal(calls.length, 0, '必然 400 的请求不许发出去');

  const noToken = await fetchFlagsPage({ fetchImpl, baseUrl: BASE_URL, token: '' });
  assert.equal(noToken.kind, 'signed_out');
  assert.equal(calls.length, 0);
});

test('切换开关：PUT /admin/feature-flags/{key}，If-Match 是 "3" 不是 *，Idempotency-Key 原样发出', async () => {
  const { fetchImpl, calls } = spy(() => envelope(flag({ key: 'ai_enabled', enabled: true, revision: 4 }), { etag: '"4"' }));
  const result = await putFlag({
    fetchImpl,
    baseUrl: BASE_URL,
    token: TOKEN,
    key: 'ai_enabled',
    enabled: true,
    reason: REASON,
    revision: 3,
    idempotencyKey: 'flag-00000000000000000000000000000001',
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, '/api/v1/admin/feature-flags/ai_enabled', '路径必须是契约 /admin/feature-flags/{key}');
  assert.equal(init.method, 'PUT', 'setFlag 是 PUT（不是 POST/PATCH）');
  assert.equal(init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(init.headers['content-type'], 'application/json');
  assert.equal(init.headers['if-match'], '"3"', 'If-Match 必须来自已加载行的 revision');
  assert.notEqual(init.headers['if-match'], '*', '契约 IfMatch.pattern 明确不允许 *');
  assert.match(init.headers['if-match'], IF_MATCH_RE);
  assert.equal(init.headers['idempotency-key'], 'flag-00000000000000000000000000000001');
  assert.equal(init.credentials, 'omit', '后台请求不携带 cookie');

  // 请求体形状与契约一致（本用例的核心断言，见 helper 注释）。
  assertFlagInputBody(init.body, { enabled: true, reason: REASON });

  assert.equal(result.flag.revision, 4);
  assert.equal(result.etag, '"4"', '响应带强 ETag 时原样用');
  assert.equal(result.status, 200);
});

test('切换开关：没有服务端 ETag 时按 revision 推出；key 走 encodeURIComponent', async () => {
  const { fetchImpl, calls } = spy(() => envelope(flag({ key: 'submissions_enabled', enabled: false, revision: 7 })));
  const result = await putFlag({
    fetchImpl,
    baseUrl: BASE_URL,
    token: TOKEN,
    key: 'submissions_enabled',
    enabled: false,
    reason: REASON,
    revision: 7,
    idempotencyKey: 'flag-00000000000000000000000000000002',
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(calls[0].url, '/api/v1/admin/feature-flags/submissions_enabled');
  assert.equal(result.etag, '"7"', '无 ETag 头 ⇒ 由响应 revision 推出，不猜');
  assertFlagInputBody(calls[0].init.body, { enabled: false, reason: REASON });
});

test('本地拒绝：key 不在闭集／reason 不合法／If-Match 不可推出／幂等键过短 ⇒ 一个请求都不发', async () => {
  const { fetchImpl, calls } = spy(() => envelope(flag()));
  const base = {
    fetchImpl,
    baseUrl: BASE_URL,
    token: TOKEN,
    key: 'ai_enabled',
    enabled: true,
    reason: REASON,
    revision: 3,
    idempotencyKey: 'flag-00000000000000000000000000000003',
  };

  const badKey = await putFlag({ ...base, key: 'not_a_contract_flag' });
  assert.equal(badKey.ok, false);
  assert.equal(badKey.kind, 'invalid_request');
  assert.match(badKey.message, /闭集/);

  const tooLongReason = await putFlag({ ...base, reason: 'x'.repeat(501) });
  assert.equal(tooLongReason.ok, false, `reason 长度 501 应本地拒绝（契约上限 ${REASON_MAX_LENGTH}）`);
  assert.equal(tooLongReason.kind, 'invalid_request');

  const emptyReason = await putFlag({ ...base, reason: '' });
  assert.equal(emptyReason.kind, 'invalid_request');
  assert.match(emptyReason.message, /理由不能为空/);

  for (const revision of [null, 0, -1, 1.5, '*', '3']) {
    const badRevision = await putFlag({ ...base, revision });
    assert.equal(badRevision.ok, false, `revision=${String(revision)} 不得推出 If-Match`);
    assert.equal(badRevision.kind, 'invalid_request');
  }

  const shortKey = await putFlag({ ...base, idempotencyKey: 'short' });
  assert.equal(shortKey.kind, 'idempotency_key_required');
  const longKey = await putFlag({ ...base, idempotencyKey: 'k'.repeat(129) });
  assert.equal(longKey.ok, false);
  assert.equal(longKey.kind, 'invalid_request');

  assert.equal(calls.length, 0, '本地校验失败时不得发出必然失败的请求');
});

test('失败分类：428／409／403／503／429 的 status 与 code 原样保留，可重试性按失败类型', async () => {
  const cases = [
    [428, 'REVISION_REQUIRED', 'revision_required', false],
    [409, 'REVISION_CONFLICT', 'revision_conflict', false],
    [403, 'SCOPE_DENIED', 'forbidden', false],
    [503, 'PROVIDER_UNAVAILABLE', 'unavailable', true],
    [429, 'RATE_LIMITED', 'rate_limited', true],
  ];
  for (const [status, code, kind, retriable] of cases) {
    const { fetchImpl, calls } = spy(() => errorResponse(status, code, { 'retry-after': '7' }));
    const result = await putFlag({
      fetchImpl,
      baseUrl: BASE_URL,
      token: TOKEN,
      key: 'ai_enabled',
      enabled: true,
      reason: REASON,
      revision: 3,
      idempotencyKey: 'flag-00000000000000000000000000000004',
    });
    assert.equal(result.ok, false, `${code} 必须判失败`);
    assert.equal(result.kind, kind, `${code} 应归类为 ${kind}，实测 ${result.kind}`);
    assert.equal(result.status, status, 'HTTP 状态必须原样保留');
    assert.equal(result.code, code, '契约错误码必须原样保留');
    assert.equal(result.retriable, retriable, `${code} 的可重试性`);
    assert.equal(calls.length, 1, `${code} 只发一次，不自动重试`);
    if (kind === 'rate_limited') assert.equal(result.retryAfterSeconds, 7);
  }
});

test('票据工具：幂等键长度落在契约 8..128 且不含身份信息；ETag 只对正整数 revision 成立', () => {
  const first = newIdempotencyKey();
  const second = newIdempotencyKey();
  assert.notEqual(first, second, '每次写入必须换新键');
  for (const key of [first, second]) {
    assert.match(key, /^flag-[0-9a-f]{32}$/);
    assert.ok([...key].length >= IDEMPOTENCY_KEY.minLength && [...key].length <= IDEMPOTENCY_KEY.maxLength);
    assert.doesNotMatch(key, /synthetic|token|admin/i, '幂等键不得含身份信息');
  }
  assert.equal(etagForRevision(3), '"3"');
  assert.match(etagForRevision(3), IF_MATCH_RE);
  for (const bad of [0, -2, 1.5, '3', null, undefined]) assert.equal(etagForRevision(bad), null, `revision=${String(bad)} 不得推出 ETag`);
  assert.equal(reasonProblem(REASON), null);
  assert.equal(reasonProblem(''), '理由不能为空（契约 FlagInput.reason 必填）');
});

test('响应校验：契约外 key／缺 enabled／revision 0 整体判畸形；多余字段只告警不猜含义', () => {
  const missingEnabled = validateFlag({ key: 'ai_enabled', revision: 3 });
  assert.equal(missingEnabled.ok, false);
  assert.deepEqual(missingEnabled.errors.map((error) => error.path), ['$.enabled']);

  const unknownKey = validateFlag({ key: 'ghost_flag', enabled: true, revision: 1 });
  assert.equal(unknownKey.ok, false);
  assert.match(unknownKey.errors[0].problem, /闭集/);

  const zeroRevision = validateFlag({ key: 'ai_enabled', enabled: true, revision: 0 });
  assert.equal(zeroRevision.ok, false);

  const extra = validateFlag({ key: 'ai_enabled', enabled: true, revision: 2, scope: 'flags:write' });
  assert.equal(extra.ok, true, '契约外字段只告警，不整行拒绝');
  assert.equal(extra.warnings.length, 1, 'scope 是契约外字段（Flag 没有 scope）');
  assert.match(extra.warnings[0].problem, /契约外字段/);

  const page = validateFlagPage({ items: [], next_cursor: undefined });
  assert.equal(page.ok, false, 'next_cursor 必须显式给出（末页为 null）');
  assert.equal(validateFlagPage({ items: [], next_cursor: null }).ok, true);
});

test('畸形响应：data 缺 meta／行不合契约 ⇒ invalid_response，不渲染猜测值', async () => {
  const noMeta = await fetchFlagsPage({
    fetchImpl: async () => jsonResponse(200, { data: { items: [], next_cursor: null } }),
    baseUrl: BASE_URL,
    token: TOKEN,
  });
  assert.equal(noMeta.ok, false);
  assert.equal(noMeta.kind, 'invalid_response');

  const badRow = await fetchFlagsPage({
    fetchImpl: async () => jsonResponse(200, { data: { items: [{ key: 'ghost', enabled: true, revision: 1 }], next_cursor: null }, meta: { request_id: REQUEST_ID } }),
    baseUrl: BASE_URL,
    token: TOKEN,
  });
  assert.equal(badRow.ok, false);
  assert.equal(badRow.kind, 'invalid_response');
  assert.match(badRow.message, /\$\.items\[0\]\.key/);
});
