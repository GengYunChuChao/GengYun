// GY-I18 本片 · **审计与责任 / 普通账号不能管理 / 硬规则不可绕 / 人审空态** 的回归（`Refs #18`）。
//
// 覆盖：
//   G1. 关键修改（分类、四类资料的版本修改）留**责任人与范围**（此前编辑类不写审计）；
//   G2. 普通账号（role=user）对 9 个后台操作一律 403 SCOPE_DENIED，且**零副作用、零审计**；
//   G3. 只读管理员缺写 scope ⇒ 同样 SCOPE_DENIED，状态不变、不写审计；
//   G4. 硬规则不可绕：语义上"关硬规则/跳过审核/放行未核对"的开关 key 一律显式拒绝并留 denied 审计，
//       且不得因此多出一个开关行；
//   G5. 语义表结构性不变量：任何"放宽 fail-closed"的分类都拒绝接线；
//   G6. **人审入口空态**：任务/审核人/投票/专家认证四个集合恒空且冻结，未接线；
//       34 个后台 operation 的响应 schema 里**没有任何**评审人/投票/专家认证字段（抗伪造扫描）；
//   G7. 不把基础账号管理说成人工评审已完成（审计动作/原因码与投影字段逐条核对）；
//   G8. HTTP：普通用户会话访问后台 ⇒ 403 SCOPE_DENIED；人审空态在装配实例上同样成立。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { createMemoryIdempotencyStore } from '../../services/api/src/auth/idempotency.ts';
import { DEFAULT_FLAG_EFFECTS, assertNoFlagWeakensFailClosed } from '../../services/api/src/admin/ops/flags.ts';
import { projectAuditEvent } from '../../services/api/src/admin/audit.ts';
import { createHumanReviewDirectory, HUMAN_REVIEW_COLLECTIONS } from '../../services/api/src/admin/human-review.ts';
import {
  ALL_OPS_SCOPES,
  JOB_QUEUED,
  USER_A,
  auditRecords,
  createOpsHarness,
  expectApiError,
  makeUuid,
  opsContext,
  opsKey,
} from './admin-ops-fixtures.mjs';
import {
  FAMILY_CASES,
  context,
  createDraft,
  createHarness,
  editRevision,
  publishRevision,
  validKnowledgeInput,
  validPublishBody,
  validWithdrawBody,
} from './admin-fixtures.mjs';

const operations = JSON.parse(readFileSync(new URL('../../packages/contracts/operations.json', import.meta.url), 'utf8'));
const openapi = JSON.parse(readFileSync(new URL('../../packages/contracts/openapi.json', import.meta.url), 'utf8'));
const API = '/api/v1';
const SESSION_KEY = 'synthetic-i18-governance-signing-key-0123456789';

const [SOURCES, KNOWLEDGE, REGISTRATIONS, RESTRICTIONS] = FAMILY_CASES;

// ---------------------------------------------------------------------------
// G1 审计与责任
// ---------------------------------------------------------------------------

test('G1a. 分类修改留责任人与范围（action/scope/主体/目标提示）', async () => {
  const { service, store } = createOpsHarness();
  const response = await service.editCategory({ ...opsContext(), idempotencyKey: opsKey('cat'), ifMatch: '"1"' }, 'crop-rice', {
    name: '水稻（已复核命名）',
    description: '示例分类：水稻',
    active: true,
  });
  assert.equal(response.status, 200);

  const records = auditRecords(store);
  assert.equal(records.length, 1, '分类修改恰好一条审计');
  const record = records[0];
  assert.equal(record.action, 'category.update');
  assert.equal(record.scope, 'sources:write', '范围 = 实际行使的权限 scope');
  assert.equal(record.actor_id, opsContext().identity.userId, '责任人 = 服务端权威主体');
  assert.equal(record.result, 'accepted');
  assert.equal(typeof record.request_id, 'string');
  // 契约 TargetRef 闭集里没有 category ⇒ 目标标识落在内部字段（不外泄）。
  assert.equal(record.target_ref, null);
  assert.equal(record.target_hint, 'category:crop-rice');
});

test('G1b. 四类资料的「版本修改」逐类留审计（此前不写 ⇒ 事后无法追责）', async () => {
  for (const caseEntry of FAMILY_CASES) {
    const { service, store } = createHarness();
    const created = await createDraft(caseEntry, service);
    const id = created.body.data.id;
    await editRevision(caseEntry, service, id, 1, caseEntry.editedInput());

    const edits = auditRecords(store).filter((record) => record.action === `${caseEntry.noun}.edit`);
    assert.equal(edits.length, 1, `${caseEntry.name} 的版本修改必须留一条审计`);
    const record = edits[0];
    assert.equal(record.actor_id, '11111111-1111-4111-8111-111111111111', '必须有责任人');
    assert.equal(record.scope, caseEntry.descriptor.writeScope, '必须有范围（行使的权限）');
    assert.equal(record.result, 'accepted');
    assert.equal(record.reason_code, 'revision_appended');
    assert.equal(record.target_ref.revision, 2, '必须指向新产生的修订号');
    assert.equal(record.target_ref.type, caseEntry.descriptor.targetRefTypeFor(caseEntry.contentInput()), '目标类型必须落在契约闭集内');
    // 内部"影响范围"：来源类写清引用条数/失效条数；依赖类写清引用的来源版本与判定。
    assert.equal(typeof record.target_hint, 'string');
    if (caseEntry.descriptor.family === 'sources') assert.match(record.target_hint, /^source:.+:rev=2:live=.+:refs=\d+:invalidated=\d+$/);
    else assert.match(record.target_hint, new RegExp(`^${caseEntry.noun}:.+:rev=2:source=.+@.+:state=\\w+$`));
    // 契约投影不得带出内部字段（责任人字段同理：合同的 AuditEvent 没有主体字段）。
    const projected = (await service.listAuditEvents(context())).body.data.items.find((event) => event.action === `${caseEntry.noun}.edit`);
    assert.deepEqual(Object.keys(projected).sort(), ['action', 'created_at', 'id', 'reason_code', 'request_id', 'result', 'scope', 'target_ref']);
  }
});

// ---------------------------------------------------------------------------
// G2/G3 普通账号不能管理
// ---------------------------------------------------------------------------

/** 9 个操作的调用表（scope 门在最前面 ⇒ 不需要其他头部）。 */
function opsCalls(service) {
  const asUser = { identity: { userId: USER_A.userId, authEpoch: 1, role: 'user', scopes: ['user'] } };
  return [
    ['listAdminCategories', () => service.listAdminCategories(asUser)],
    ['editCategory', () => service.editCategory(asUser, 'crop-rice', { name: 'n', description: 'd', active: true })],
    ['listAdminUsers', () => service.listAdminUsers(asUser)],
    ['suspendUser', () => service.suspendUser(asUser, USER_A.userId, { reason: 'x' })],
    ['listAdminJobs', () => service.listAdminJobs(asUser)],
    ['cancelAdminJob', () => service.cancelAdminJob(asUser, JOB_QUEUED, { reason: 'x' })],
    ['listFlags', () => service.listFlags(asUser)],
    ['setFlag', () => service.setFlag(asUser, 'submissions_enabled', { enabled: true, reason: 'x' })],
    ['hidePost', () => service.hidePost(asUser, makeUuid(500), { reason: 'x' })],
  ];
}

test('G2. 普通账号（role=user）对 9 个后台操作一律 SCOPE_DENIED，且零副作用零审计', async () => {
  const { service, store } = createOpsHarness();
  const before = auditRecords(store).length;
  const flagsBefore = store.listFlags().map((flag) => `${flag.key}:${flag.enabled}:${flag.revision}`);
  const calls = opsCalls(service);
  assert.equal(calls.length, 9, '必须逐个覆盖 9 个后台操作');
  for (const [label, call] of calls) {
    const error = await expectApiError(call, 'SCOPE_DENIED');
    assert.equal(error.status, 403, `${label} 必须是 403`);
  }
  assert.equal(auditRecords(store).length, before, '越权调用不得留下任何审计');
  assert.deepEqual(store.listFlags().map((flag) => `${flag.key}:${flag.enabled}:${flag.revision}`), flagsBefore, '越权调用不得改变开关状态');
  assert.equal(store.getAccount(USER_A.userId).state, 'active', '越权调用不得改变账号状态');
});

test('G3. 只读管理员缺写 scope ⇒ SCOPE_DENIED；状态与审计都不变（权限按调用点重查）', async () => {
  const { service, store } = createOpsHarness();
  const readOnly = { identity: { userId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', authEpoch: 1, role: 'admin', scopes: ['sources:read', 'flags:read', 'accounts:read', 'jobs:read'] } };
  // 读操作照常放行（确认这条反例不是因为整个服务不可用）。
  assert.equal((await service.listFlags(readOnly)).status, 200);
  assert.equal((await service.listAdminCategories(readOnly)).status, 200);

  const before = auditRecords(store).length;
  await expectApiError(() => service.editCategory({ ...readOnly, idempotencyKey: opsKey('ro'), ifMatch: '"1"' }, 'crop-rice', { name: 'n', description: 'd', active: false }), 'SCOPE_DENIED');
  await expectApiError(() => service.suspendUser({ ...readOnly, idempotencyKey: opsKey('ro2'), ifMatch: '"1"' }, USER_A.userId, { reason: 'x' }), 'SCOPE_DENIED');
  await expectApiError(() => service.setFlag({ ...readOnly, idempotencyKey: opsKey('ro3'), ifMatch: '"1"' }, 'ai_enabled', { enabled: false, reason: 'x' }), 'SCOPE_DENIED');
  assert.equal(auditRecords(store).length, before);
  assert.equal(store.getCategory('crop-rice').active, true, '被拒的写不得生效');
  assert.equal(store.getAccount(USER_A.userId).state, 'active');
  assert.equal(ALL_OPS_SCOPES.includes('flags:write'), true, 'sanity');
});

// ---------------------------------------------------------------------------
// G4/G5 不能绕过硬规则
// ---------------------------------------------------------------------------

test('G4. 语义上"关硬规则/跳过审核/放行未核对"的开关一律显式拒绝，并留 denied 审计', async () => {
  const { service, store } = createOpsHarness();
  const forbidden = ['hard_rules_enabled', 'moderation_enabled', 'auto_approve', 'skip_review', 'fail_closed', 'bypass_hard_rules'];
  const keysBefore = store.listFlags().map((flag) => flag.key).sort();

  for (const key of forbidden) {
    const error = await expectApiError(
      () => service.setFlag({ ...opsContext(), idempotencyKey: opsKey(`ff-${key}`), ifMatch: '"1"' }, key, { enabled: true, reason: '示例：试图关闭硬规则' }),
      'INVALID_REQUEST',
    );
    assert.equal(error.status, 400, key);
    assert.deepEqual(error.details, [{ field: 'key', code: 'SAFETY_CRITICAL_KEY' }], key);
  }
  const denied = auditRecords(store).filter((record) => record.result === 'denied');
  assert.equal(denied.length, forbidden.length, '每次尝试都要留一条 denied 审计');
  for (const record of denied) {
    assert.equal(record.action, 'flag.set');
    assert.equal(record.scope, 'flags:write');
    assert.equal(record.reason_code, 'flag_weakening_denied');
    assert.match(record.target_hint, /^flag:/);
    assert.equal(record.actor_id, opsContext().identity.userId, '被拒的尝试同样要留责任人');
  }
  assert.deepEqual(store.listFlags().map((flag) => flag.key).sort(), keysBefore, '被拒的 key 不得因此多出一个开关行');
});

test('G5. 语义表的结构性不变量：任何"放宽 fail-closed"的分类都拒绝接线', () => {
  // 出厂的 3 个 key 全部是能力门：三个放宽标志恒为 false。
  for (const [key, effect] of Object.entries(DEFAULT_FLAG_EFFECTS)) {
    assert.equal(effect.weakens_fail_closed, false, key);
    assert.equal(effect.disables_hard_rules, false, key);
    assert.equal(effect.allows_unverified_publish, false, key);
  }
  assert.doesNotThrow(() => assertNoFlagWeakensFailClosed(DEFAULT_FLAG_EFFECTS));
  // 一旦有人把某个 key 声明成"关硬规则"，接线期就失败（不是运行时才失效）。
  for (const field of ['weakens_fail_closed', 'disables_hard_rules', 'allows_unverified_publish']) {
    const table = { ai_enabled: { ...DEFAULT_FLAG_EFFECTS.ai_enabled, [field]: true } };
    assert.throws(() => assertNoFlagWeakensFailClosed(table), /被声明为可放宽安全判定/);
  }
});

test('G5b. 开关**不能**用来放行"引用已失效"的内容：硬门槛与开关无关', async () => {
  const { service, store } = createHarness();
  // 建来源并发布，然后撤回它；依赖引用它。
  const source = await createDraft(SOURCES, service);
  const sourceId = source.body.data.id;
  await publishRevision(SOURCES, service, sourceId, 1);
  const knowledge = await createDraft(KNOWLEDGE, service, context(), validKnowledgeInput({ source_id: sourceId, source_version: '2026-09' }));
  await service.withdrawSource({ ...context(), idempotencyKey: opsKey('src-w'), ifMatch: '"1"' }, sourceId, validWithdrawBody());
  // 依赖从未发布 ⇒ 发布被引用门槛拦下（与任何开关无关）。
  await expectApiError(
    () => service.publishKnowledge({ ...context(), idempotencyKey: opsKey('k-pub'), ifMatch: '"1"' }, knowledge.body.data.id, validPublishBody()),
    'SOURCE_CONFLICT',
  );
  assert.equal(store.getEntity(knowledge.body.data.id).publishedRevision, null);
});

// ---------------------------------------------------------------------------
// G6/G7 人审空态
// ---------------------------------------------------------------------------

test('G6a. 人审入口空态：四个集合恒空且冻结、未接线、"声称已评审"的入口一律拒绝', () => {
  const directory = createHumanReviewDirectory();
  assert.equal(directory.wired, false, '本片未接入人工评审');
  assert.deepEqual([...directory.collections], [...HUMAN_REVIEW_COLLECTIONS]);
  const state = directory.state();
  assert.equal(state.wired, false);
  for (const name of HUMAN_REVIEW_COLLECTIONS) {
    assert.deepEqual(state[name], [], `${name} 必须是空集合`);
    assert.equal(Array.isArray(state[name]), true);
    assert.equal(Object.isFrozen(state[name]), true, `${name} 必须冻结（不得事后塞人进去）`);
  }
  assert.equal(Object.isFrozen(state), true);
  assert.equal(typeof state.reason === 'string' && state.reason.length > 0, true, '必须如实说明为什么是空的');
  // 唯一的"登记评审结论"入口一律拒绝（不是找不到入口，而是显式失败）。
  assert.throws(() => directory.assertNoReviewClaim('来源 X'), (error) => error.code === 'OBJECT_UNAVAILABLE' && error.status === 409);
});

test('G6b. 抗伪造扫描：全部后台 operation 的响应 schema 里没有任何评审人/投票/专家认证字段', () => {
  const FORBIDDEN = /reviewer|review_task|reviewed_by|votes?$|expert|certification/i;
  // 响应 schema 在 openapi.json（operations.json 只有 id/method/path/scope）。
  const adminPaths = Object.entries(openapi.paths).filter(([path]) => path.startsWith('/admin'));
  const adminOperations = adminPaths.flatMap(([, item]) => Object.values(item));
  assert.equal(adminOperations.length >= 34, true, `后台 operation 数量异常：${adminOperations.length}（路径 ${adminPaths.length} 条）`);

  const seenSchemas = new Set();
  const propertyNames = new Set();
  function collectSchema(schema, depth = 0) {
    if (schema === null || typeof schema !== 'object' || depth > 12) return;
    if (typeof schema.$ref === 'string') {
      const name = schema.$ref.split('/').at(-1);
      if (seenSchemas.has(name)) return;
      seenSchemas.add(name);
      collectSchema(openapi.components.schemas[name], depth + 1);
      return;
    }
    if (schema.properties && typeof schema.properties === 'object') {
      for (const [name, child] of Object.entries(schema.properties)) {
        propertyNames.add(name);
        collectSchema(child, depth + 1);
      }
    }
    for (const key of ['items', 'additionalProperties', 'oneOf', 'anyOf', 'allOf']) {
      const child = schema[key];
      if (Array.isArray(child)) child.forEach((entry) => collectSchema(entry, depth + 1));
      else if (child && typeof child === 'object') collectSchema(child, depth + 1);
    }
  }
  for (const [, item] of adminPaths) {
    for (const operation of Object.values(item)) {
      for (const response of Object.values(operation?.responses ?? {})) {
        const schema = response?.content?.['application/json']?.schema;
        if (schema) collectSchema(schema);
      }
    }
  }
  // 反向控制：扫描确实收集到了字段（否则这个用例会因"什么都没扫到"而假通过）。
  assert.equal(propertyNames.size > 10, true, `扫描未生效，只收集到 ${propertyNames.size} 个字段`);
  assert.equal(seenSchemas.size > 3, true, `只解析到 ${seenSchemas.size} 个 schema`);
  const offending = [...propertyNames].filter((name) => FORBIDDEN.test(name));
  assert.deepEqual(offending, [], `后台响应 schema 不得出现评审人/投票/专家认证类字段：${offending.join(', ')}`);
});

test('G7. 不把基础账号管理说成人工评审已完成（动作/原因码/投影字段逐条核对）', async () => {
  const { service, store } = createOpsHarness();
  await service.suspendUser({ ...opsContext(), idempotencyKey: opsKey('susp'), ifMatch: '"1"' }, USER_A.userId, { reason: '示例：违规停用' });
  const record = auditRecords(store).at(-1);
  assert.equal(record.action, 'account.suspend', '动作是账号管理语义，不是"评审通过"');
  assert.equal(record.reason_code, 'account_suspended');
  assert.doesNotMatch(`${record.action} ${record.reason_code}`, /review|approv|expert|vote/i);
  // 账号视图只投影契约允许的 4 个字段：没有任何"评审人/评审结论"位置。
  const account = store.getAccount(USER_A.userId);
  assert.deepEqual(Object.keys(account).sort(), ['display_name', 'id', 'revision', 'state']);
  // 审计投影同样只有合同 8 字段（内部 actor_id / target_hint 不外泄）。
  const projected = projectAuditEvent(store.audit.list().at(-1));
  assert.deepEqual(Object.keys(projected).sort(), ['action', 'created_at', 'id', 'reason_code', 'request_id', 'result', 'scope', 'target_ref']);
  assert.doesNotMatch(JSON.stringify(projected), /reviewer|expert|vote/i);
});

// ---------------------------------------------------------------------------
// G8 HTTP：普通账号不能管理 + 装配实例的人审空态
// ---------------------------------------------------------------------------

test('G8. HTTP：普通用户会话访问后台 ⇒ 403 SCOPE_DENIED（不泄露后台资源是否存在）', async () => {
  const config = loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent', SESSION_SIGNING_KEY: SESSION_KEY });
  const store = createMemoryAuthStore();
  const app = buildApp({ config, store, idempotency: createMemoryIdempotencyStore() });
  try {
    const login = await app.inject({
      method: 'POST', url: `${API}/auth/wechat`,
      headers: { 'idempotency-key': 'gyi18-gov-login-0001' }, payload: { code: 'synthetic-i18-gov' },
    });
    assert.equal(login.statusCode, 200, login.body);
    const token = login.json().data.access_token;
    const paths = [
      ['GET', `${API}/admin/feature-flags`],
      ['GET', `${API}/admin/categories`],
      ['GET', `${API}/admin/accounts`],
      ['GET', `${API}/admin/jobs`],
      ['GET', `${API}/admin/audit-events`],
    ];
    for (const [method, url] of paths) {
      const res = await app.inject({ method, url, headers: { authorization: `Bearer ${token}` } });
      assert.equal(res.statusCode, 403, `${method} ${url} 必须 403（实际 ${res.statusCode} ${res.body}）`);
      assert.equal(res.json().error.code, 'SCOPE_DENIED');
      assert.equal(res.json().data, undefined);
    }
    // 人审空态在装配实例上同样成立（被装饰，可被回归直接核对）。
    assert.equal(app.humanReviewDirectory.wired, false);
    assert.deepEqual(app.humanReviewDirectory.state().reviewers, []);
  } finally {
    await app.close();
  }
});
