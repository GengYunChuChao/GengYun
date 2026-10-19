// GY-I12（#12）文字问答域回归夹具：真实回环 HTTP + **契约机械判据**。
//
// 本文件只提供夹具与判据，不含用例。三件东西：
//   1) `conversationFixture`：在 `stub` 模式下真起一个 fastify 实例（合成账号、内存会话 store、
//      无 PG、无真实模型、无真实供应商），并给出可注入检索/用量端口的位置；
//   2) `loadSchema` / `shapeIssues` / `assertShape`：**从 `packages/contracts/openapi.json` 现读**
//      的逐键校验器（不手抄字段名 —— 手抄的副本会与契约漂移，正是"机械判据"要排除的东西）；
//   3) 合成本源与检索条目（`SourceRef` 十键齐备、`url` 为 https、`id` 为 uuid）。
//
// 刻意**不导入** `packages/reference` 的真实资料：真实浙江资料基座的条目 `usable_as_dose=false` /
// `card_ready=false`（见 `packages/knowledge/README.md`），用它构造"能通过确定性判定"的用例在
// 结构上不可能；因此需要"判定通过"这一方向时，**显式注入测试替身端口**（并在用例里写清楚它是替身）。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';
import { createMemoryConversationStore } from '../../services/api/src/conversations/store.ts';
import { CONVERSATION_KEYS, TURN_KEYS, ANSWER_KEYS, SOURCE_REF_KEYS } from '../../services/api/src/conversations/types.ts';

export const START = Date.UTC(2026, 9, 14, 6);
export const CONVERSATIONS = '/api/v1/conversations';
export const JOBS = '/api/v1/jobs';
export const ABSENT_ID = '00000000-0000-4000-8f00-0000000000ff';

/** 键集常量也从实现里导入（同一份事实，不另抄一份）。 */
export const KEYS = { CONVERSATION_KEYS, TURN_KEYS, ANSWER_KEYS, SOURCE_REF_KEYS };

/**
 * 合成本源（契约 `SourceRef` 十键）。
 *
 * `url` 用 `https://example.invalid/...`：`.invalid` 是 RFC 2606 保留的**不可解析**顶级域，
 * 因此用例永远不会真的去访问它，也不可能被误当成一个真实可点开的资料链接。
 * `review_status: 'unverified'` 与真实种子一致（如实标注未核对）。
 */
export function syntheticSource(overrides = {}) {
  return {
    id: overrides.id ?? '8de526e2-ada8-514a-bbab-a0da3e784b0d',
    version: overrides.version ?? 'synthetic-source-2026.10',
    title: overrides.title ?? '合成资料条目（测试替身，非真实资料）',
    url: overrides.url ?? 'https://example.invalid/gengyun/synthetic-source',
    publisher: overrides.publisher ?? '合成发布方（测试替身）',
    source_kind: overrides.source_kind ?? 'verified_seed',
    evidence_kind: overrides.evidence_kind ?? 'mixed',
    validity: overrides.validity ?? 'valid',
    review_status: overrides.review_status ?? 'unverified',
    updated_at: overrides.updated_at ?? '2026-10-14T00:00:00.000Z',
  };
}

/** 一条检索条目（`RetrievalItem` 形状：`raw` 供确定性用量判定读取）。 */
export function retrievalItem(overrides = {}) {
  // `source.id` 默认跟随条目 id：契约 `SourceRef.id` 就是"这条资料的来源 id"，两者不一致会让
  // "引用只能取自本次检索集合"的核对失去意义（守卫按 `citation.id === item.id` 定位条目）。
  const source = syntheticSource({
    ...(overrides.id === undefined ? {} : { id: overrides.id }),
    ...(overrides.source ?? {}),
  });
  return {
    id: overrides.id ?? source.id,
    revision: overrides.revision ?? 1,
    type: overrides.type ?? 'herbicide',
    title: overrides.title ?? '合成资料条目（测试替身，非真实资料）',
    body: overrides.body ?? '合成正文：仅用于回归，不含真实用量建议。',
    source,
    raw: overrides.raw ?? { item_id: overrides.id ?? source.id, kind: 'herbicide', usable_as_dose: false, card_ready: false },
  };
}

/** 检索集合（`RetrievalSet` 形状）。 */
export function retrievalSet(userId, items, note = '合成检索集合（测试替身）') {
  return { user_id: userId, items, note };
}

/** 可显式推进的时钟（与 `tests/unit/favorites-history-fixtures.mjs` 同口径）。 */
export function scriptedClock(baseMs) {
  let current = baseMs;
  return {
    now: () => new Date(current),
    advance: (ms) => {
      current += ms;
    },
  };
}

// ---------------------------------------------------------------------------
// 契约机械判据：从 `packages/contracts/openapi.json` 现读的逐键校验器
// ---------------------------------------------------------------------------

const OPENAPI = JSON.parse(readFileSync(new URL('../../packages/contracts/openapi.json', import.meta.url), 'utf8'));
const SCHEMAS = OPENAPI.components.schemas;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 取具名 schema（不存在即断言失败 —— 契约里没有的名字不允许出现在判据里）。 */
export function loadSchema(name) {
  const schema = SCHEMAS[name];
  assert.ok(schema !== undefined, `契约里没有 schema：${name}`);
  return schema;
}

/** 契约里本域相关的全部 operation（`operations.json` 现读，不手抄）。 */
export function conversationOperations() {
  const operations = JSON.parse(readFileSync(new URL('../../packages/contracts/operations.json', import.meta.url), 'utf8'));
  return operations.operations.filter((operation) => operation.id === 'createConversation'
    || operation.id === 'listConversations'
    || operation.id === 'getConversation'
    || operation.id === 'deleteConversation'
    || operation.id === 'createTurn'
    || operation.id === 'listTurns'
    || operation.id === 'deleteTurn');
}

/** 取某 operation 的 openapi 节点（按 method + path 定位）。 */
export function operationNode(operation) {
  const node = OPENAPI.paths[operation.path]?.[operation.method];
  assert.ok(node !== undefined, `契约里没有路径：${operation.method.toUpperCase()} ${operation.path}`);
  return node;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 逐键校验（契约子集：type/required/additionalProperties/properties/items/enum/const/
 * minLength/maxLength/minimum/maximum/maxItems/oneOf/format/pattern）。
 *
 * 返回问题清单（空数组 = 通过）。**只**按契约里真实存在的关键字判，遇到不认识的关键字
 * 直接在问题里报出来（"判据覆盖不到"必须是可见的，不能静默放过）。
 */
export function shapeIssues(schema, value, path, issues = []) {
  if (!isPlainObject(schema)) {
    issues.push(`${path}: 判据本身收到非法 schema`);
    return issues;
  }
  if (typeof schema.$ref === 'string') {
    const name = schema.$ref.replace('#/components/schemas/', '');
    return shapeIssues(loadSchema(name), value, path, issues);
  }
  const known = new Set([
    '$ref', 'type', 'required', 'additionalProperties', 'properties', 'items', 'enum', 'const',
    'minLength', 'maxLength', 'minimum', 'maximum', 'maxItems', 'minItems', 'oneOf', 'anyOf', 'format',
    'pattern', 'description', 'discriminator', 'default', 'title',
  ]);
  for (const key of Object.keys(schema)) {
    if (!known.has(key)) issues.push(`${path}: 契约里出现了本判据不认识的关键字 ${key}`);
  }
  if (schema.const !== undefined && value !== schema.const) {
    issues.push(`${path}: 期望常量 ${JSON.stringify(schema.const)}，实得 ${JSON.stringify(value)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    issues.push(`${path}: 不在枚举 ${JSON.stringify(schema.enum)} 内：${JSON.stringify(value)}`);
  }
  if (Array.isArray(schema.oneOf)) {
    const hits = schema.oneOf.filter((branch) => shapeIssues(branch, value, path, []).length === 0);
    if (hits.length === 0) issues.push(`${path}: 不满足 oneOf 的任何一个分支`);
  }
  // openapi 3.1 表达「可空」用 `anyOf: [{$ref}, {type:'null'}]`（`Conversation.conditions` 就是这种）。
  if (Array.isArray(schema.anyOf)) {
    const hits = schema.anyOf.filter((branch) => shapeIssues(branch, value, path, []).length === 0);
    if (hits.length === 0) issues.push(`${path}: 不满足 anyOf 的任何一个分支`);
  }
  const type = schema.type;
  if (type === 'object') {
    if (!isPlainObject(value)) {
      issues.push(`${path}: 期望对象，实得 ${value === null ? 'null' : typeof value}`);
      return issues;
    }
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!(key in value)) issues.push(`${path}: 缺少必填键 ${key}`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) issues.push(`${path}: 多出未定义键 ${key}`);
      }
    }
    for (const [key, sub] of Object.entries(properties)) {
      if (key in value) shapeIssues(sub, value[key], `${path}.${key}`, issues);
    }
    return issues;
  }
  if (type === 'array') {
    if (!Array.isArray(value)) {
      issues.push(`${path}: 期望数组，实得 ${typeof value}`);
      return issues;
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      issues.push(`${path}: 元素个数 ${value.length} 超出 maxItems ${schema.maxItems}`);
    }
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      issues.push(`${path}: 元素个数 ${value.length} 少于 minItems ${schema.minItems}`);
    }
    if (schema.items !== undefined) value.forEach((item, index) => shapeIssues(schema.items, item, `${path}[${index}]`, issues));
    return issues;
  }
  if (type === 'string') {
    if (typeof value !== 'string') {
      issues.push(`${path}: 期望字符串，实得 ${value === null ? 'null' : typeof value}`);
      return issues;
    }
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) issues.push(`${path}: 长度 < minLength ${schema.minLength}`);
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) issues.push(`${path}: 长度 > maxLength ${schema.maxLength}`);
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) {
      issues.push(`${path}: 不匹配 pattern ${schema.pattern}`);
    }
    if (schema.format === 'uuid' && !UUID_RE.test(value)) issues.push(`${path}: 不是 uuid：${value}`);
    if (schema.format === 'date-time' && Number.isNaN(Date.parse(value))) issues.push(`${path}: 不是可解析的 date-time：${value}`);
    if (schema.format === 'uri' && !/^[a-z][a-z0-9+.-]*:/i.test(value)) issues.push(`${path}: 不是 uri：${value}`);
    return issues;
  }
  if (type === 'integer' || type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      issues.push(`${path}: 期望数字，实得 ${value === null ? 'null' : typeof value}`);
      return issues;
    }
    if (type === 'integer' && !Number.isSafeInteger(value)) issues.push(`${path}: 不是安全整数：${value}`);
    if (typeof schema.minimum === 'number' && value < schema.minimum) issues.push(`${path}: ${value} < minimum ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) issues.push(`${path}: ${value} > maximum ${schema.maximum}`);
    return issues;
  }
  if (type === 'boolean') {
    if (typeof value !== 'boolean') issues.push(`${path}: 期望布尔，实得 ${value === null ? 'null' : typeof value}`);
    return issues;
  }
  if (type === 'null' && value !== null) issues.push(`${path}: 期望 null`);
  return issues;
}

/** 断言某个值满足具名契约 schema（失败时把逐键问题全部打出来）。 */
export function assertShape(schemaName, value, label = schemaName) {
  const issues = shapeIssues(loadSchema(schemaName), value, label);
  assert.deepEqual(issues, [], `${label} 不满足契约 ${schemaName}：\n${issues.join('\n')}`);
}

/** 对 200/201/202 响应的整封套做形状校验（成功响应都是 `{data,meta}`）。 */
export function assertEnvelopeShape(schemaName, body, label) {
  assertShape(schemaName, body, label);
  assert.deepEqual(Object.keys(body).sort(), ['data', 'meta'], `${label} 封套键集`);
  assert.deepEqual(Object.keys(body.meta).sort(), ['contract_version', 'execution_mode', 'request_id'], `${label} meta 键集`);
  assert.equal(body.meta.contract_version, '1.0.0', `${label} contract_version`);
}

/** 契约错误封套形状（`errors.ts#buildErrorEnvelope`）。 */
export function assertErrorShape(body, code, status, label) {
  assert.deepEqual(Object.keys(body).sort(), ['error', 'meta'], `${label} 错误封套键集`);
  assert.deepEqual(
    Object.keys(body.error).sort(),
    ['code', 'details', 'message', 'retryable'],
    `${label} error 键集`,
  );
  assert.equal(body.error.code, code, `${label} 错误码`);
  assert.ok([200, 201, 202, 400, 401, 403, 404, 409, 413, 415, 422, 428, 429, 503, 504].includes(status), `${label} 状态`);
}

// ---------------------------------------------------------------------------
// 回环 HTTP 夹具
// ---------------------------------------------------------------------------

export async function conversationFixture(t, options = {}) {
  const clock = scriptedClock(options.startMs ?? START);
  const auth = createMemoryAuthStore();
  const conversationStore = options.injection?.store ?? options.store ?? createMemoryConversationStore();
  const config = {
    ...loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: options.logLevel ?? 'silent' }),
    ...(options.real === true ? { executionMode: 'real', requiresRealCredentials: true } : {}),
  };
  const app = buildApp({
    config,
    store: auth,
    now: clock.now,
    // 会话 store 恒注入：夹具要在 HTTP 之外**直接读同一份持久化状态**（级联用例靠它给双读数）。
    conversationInjection: { store: conversationStore, ...(options.injection ?? {}) },
    ...(options.pool === undefined ? {} : { pool: options.pool }),
    // 仅测试注入：日志写入目标（用于断言「日志不回声令牌/手机号/openid」）。不传时行为不变。
    ...(options.logStream === undefined ? {} : { logStream: options.logStream }),
  });
  async function account(subject) {
    const user = await auth.createUser(subject.repeat(64));
    const token = `synthetic-i12-conversation-${subject}`;
    await auth.createSession({
      userId: user.id,
      tokenHashHex: hashToken(token),
      authEpoch: user.authEpoch,
      expiresAt: new Date((options.startMs ?? START) + 48 * 3600_000),
      audience: 'user',
    });
    return { user, token };
  }
  const a = await account('a');
  const b = await account('b');
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(() => app.close());

  async function call(method, path, actor = a, extra = {}) {
    const contentType = extra.contentType ?? (extra.payload === undefined ? undefined : 'application/json');
    const body = extra.payload === undefined ? undefined : JSON.stringify(extra.payload);
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(actor === null ? {} : { authorization: `Bearer ${actor.token}` }),
        ...(extra.headers ?? {}),
        ...(contentType === undefined ? {} : { 'content-type': contentType }),
      },
      ...(body === undefined ? {} : { body }),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text === '' ? null : JSON.parse(text),
      etag: response.headers.get('etag'),
      cache: response.headers.get('cache-control'),
      cascade: response.headers.get('x-gy-cascade'),
    };
  }

  /** 受理一条文字轮次并等待异步回答结算（`drain()` 让 202 之后的推进可确定性观测）。 */
  async function createTurn(conversationId, revision, payload, extra = {}) {
    const accepted = await call('POST', `${CONVERSATIONS}/${conversationId}/turns`, extra.actor ?? a, {
      payload,
      headers: {
        'idempotency-key': extra.key ?? `idem-turn-${extra.tag ?? '1'}`,
        'if-match': `"${revision}"`,
        ...(extra.headers ?? {}),
      },
    });
    if (app.conversationService !== null) await app.conversationService.drain();
    return accepted;
  }

  async function createConversation(payload = {}, extra = {}) {
    return call('POST', CONVERSATIONS, extra.actor ?? a, {
      payload,
      headers: { 'idempotency-key': extra.key ?? `idem-conv-${extra.tag ?? '1'}` },
    });
  }

  return { app, auth, clock, conversationStore, a, b, base, call, createTurn, createConversation };
}
