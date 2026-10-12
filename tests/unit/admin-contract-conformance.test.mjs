/**
 * GY-I18 阶段 1 · 契约一致性（**读契约原文比对，只读，不修改 packages/contracts/**）。
 *
 * 这一组用例回答的问题是：「实现真的按 openapi.json 办事，而不是按写手的记忆办事吗？」
 * - 字段镜像表与契约逐字相等（35 个 schema）；
 * - 只做派单指定的 25 个 operationId，其余 14 个后台操作**没有**实现；
 * - TargetRef.type 的临时映射只落在契约闭集内；
 * - 响应体与契约出参 schema 同形；
 * - 读写 scope 与 operations.json 一致。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ALL_SPECS,
  ENVELOPE_SPECS,
  INPUT_SPECS,
  OUTPUT_SPECS,
  PAGE_SPECS,
  TARGET_REF_TYPES,
} from '../../services/api/src/admin/fields.ts';
import { FAMILIES } from '../../services/api/src/admin/families.ts';
import {
  FAMILY_CASES,
  assertMatchesContract,
  createDraft,
  createHarness,
  contractIssues,
  context,
  publishRevision,
  userIdentity,
  validPublishBody,
  withdrawRevision,
} from './admin-fixtures.mjs';

const ROOT = new URL('../../', import.meta.url);
const openapi = JSON.parse(readFileSync(new URL('packages/contracts/openapi.json', ROOT), 'utf8'));
const operations = JSON.parse(readFileSync(new URL('packages/contracts/operations.json', ROOT), 'utf8'));

/** 派单指定的 25 个 operationId（唯一权威口径）。 */
const IN_SCOPE_OPERATION_IDS = [
  'listAdminSources', 'createSourceDraft', 'getAdminSource', 'editSourceDraft', 'publishSource', 'withdrawSource',
  'listAdminKnowledge', 'createKnowledgeDraft', 'getAdminKnowledge', 'editKnowledgeDraft', 'publishKnowledge', 'withdrawKnowledge',
  'listAdminRegistration', 'createRegistrationDraft', 'getAdminRegistration', 'editRegistrationDraft', 'publishRegistration', 'withdrawRegistration',
  'listAdminRestriction', 'createRestrictionDraft', 'getAdminRestriction', 'editRestrictionDraft', 'publishRestriction', 'withdrawRestriction',
  'listAuditEvents',
];

/** 本片显式不做的 14 个后台/公开知识操作。 */
const OUT_OF_SCOPE_OPERATION_IDS = [
  'loginAdmin', 'getAdminSession', 'logoutAdmin',
  'listAdminCategories', 'editCategory',
  'listAdminUsers', 'suspendUser',
  'listAdminJobs', 'cancelAdminJob',
  'listFlags', 'setFlag',
  'hidePost',
  'listKnowledge', 'getKnowledge',
];

/** 把契约 JSON Schema 归一到镜像表的形状（与 fields.ts 的字段一一对应）。 */
function normalizeContractSchema(node) {
  assert.equal(typeof node, 'object', '契约 schema 节点必须是对象');
  assert.notEqual(node, null);
  if (node.$ref !== undefined) {
    assert.equal(typeof node.$ref, 'string');
    assert.ok(node.$ref.startsWith('#/components/schemas/'), `非本地 schema 引用：${node.$ref}`);
    return { ref: node.$ref.slice('#/components/schemas/'.length) };
  }
  if (node.anyOf !== undefined) {
    assert.equal(node.anyOf.length, 2, 'anyOf 只支持 [T, null] 形式');
    assert.deepEqual(node.anyOf[1], { type: 'null' });
    return { ...normalizeContractSchema(node.anyOf[0]), nullable: true };
  }
  const out = {};
  for (const key of ['type', 'const', 'enum', 'format', 'pattern', 'minLength', 'maxLength', 'minimum', 'minItems', 'maxItems', 'required']) {
    if (node[key] !== undefined) out[key] = node[key];
  }
  if (node.items !== undefined) out.items = normalizeContractSchema(node.items);
  if (node.properties !== undefined) {
    out.properties = {};
    for (const [key, value] of Object.entries(node.properties)) out.properties[key] = normalizeContractSchema(value);
  }
  if (node.additionalProperties === false) out.additionalProperties = false;
  return out;
}

/** 镜像表里不允许出现 undefined 值：否则归一化会把漏写悄悄吞掉。 */
function assertNoUndefined(value, path) {
  if (value === undefined) assert.fail(`镜像表在 ${path} 处出现 undefined（会被静默吞掉）`);
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) assertNoUndefined(child, `${path}.${key}`);
}

function collectOperations(predicate) {
  const found = [];
  for (const [path, item] of Object.entries(openapi.paths)) {
    for (const method of ['get', 'post', 'patch', 'put', 'delete']) {
      const operation = item[method];
      if (operation === undefined) continue;
      const entry = { path, method: method.toUpperCase(), operationId: operation.operationId, tags: operation.tags ?? [] };
      if (predicate(entry)) found.push(entry);
    }
  }
  return found;
}

/** 契约里 `/admin/**` 下的全部操作。 */
const collectAdminPathOperations = () => collectOperations((entry) => entry.path.startsWith('/admin/'));
/** 派单口径的「admin 相关 39 个」= `/admin/**` 37 个 + 公开知识读 2 个。 */
const collectAdminScopeOperations = () =>
  collectOperations((entry) => entry.path.startsWith('/admin/') || entry.operationId === 'listKnowledge' || entry.operationId === 'getKnowledge');

test('契约镜像表与 openapi.json 逐字相等（35 个 schema，逐字段比对）', () => {
  const groups = [['INPUT_SPECS', INPUT_SPECS], ['OUTPUT_SPECS', OUTPUT_SPECS], ['PAGE_SPECS', PAGE_SPECS], ['ENVELOPE_SPECS', ENVELOPE_SPECS]];
  let compared = 0;
  for (const [groupName, group] of groups) {
    assert.equal(typeof group, 'object');
    for (const [name, spec] of Object.entries(group)) {
      // 先判 typeof，再比对：镜像表的每个值都必须是对象。
      assert.equal(typeof spec, 'object', `${groupName}.${name} 必须是对象`);
      assertNoUndefined(spec, `${groupName}.${name}`);
      const contract = openapi.components.schemas[name];
      assert.notEqual(contract, undefined, `契约里没有 ${name}`);
      assert.deepStrictEqual(
        JSON.parse(JSON.stringify(spec)),
        normalizeContractSchema(contract),
        `${groupName}.${name} 与契约不同形`,
      );
      compared += 1;
    }
  }
  assert.equal(compared, Object.keys(ALL_SPECS).length, '镜像表必须被完整覆盖');
  assert.equal(compared, 35, '本片镜像的 schema 数量应恰好 35');
  // 反向确认归一化没有把契约的关键约束吃掉。
  const draftInput = normalizeContractSchema(openapi.components.schemas.SourceDraftInput);
  assert.equal(draftInput.additionalProperties, false);
  assert.equal(typeof draftInput.required.length, 'number');
  assert.equal(draftInput.required.length, 10);
  assert.equal(draftInput.properties.title.maxLength, 200);
});

test('只实现派单指定的 25 个 operationId；另外 14 个未实现、未越界', async () => {
  // 口径澄清：契约里 `/admin/**` 共 37 个操作；派单说的「admin 共 39 个」
  // = 这 37 个 + 公开知识读 GET /knowledge、GET /knowledge/{id}。
  const adminPathOperations = collectAdminPathOperations();
  assert.equal(adminPathOperations.length, 37, '契约里 /admin/** 操作应为 37 个');
  const adminScopeOperations = collectAdminScopeOperations();
  assert.equal(adminScopeOperations.length, 39, '派单口径的 admin 相关操作应为 39 个');
  const contractIds = new Set(adminScopeOperations.map((entry) => entry.operationId));

  for (const id of IN_SCOPE_OPERATION_IDS) assert.ok(contractIds.has(id), `契约里没有 ${id}`);
  assert.equal(new Set(IN_SCOPE_OPERATION_IDS).size, 25);
  assert.equal(new Set(OUT_OF_SCOPE_OPERATION_IDS).size, 14);
  const overlap = IN_SCOPE_OPERATION_IDS.filter((id) => OUT_OF_SCOPE_OPERATION_IDS.includes(id));
  assert.deepEqual(overlap, [], '本片范围内外不得重叠');
  assert.equal(IN_SCOPE_OPERATION_IDS.length + OUT_OF_SCOPE_OPERATION_IDS.length, 39, '25 + 14 必须恰好覆盖 39 个 admin 操作');
  // 25 + 14 必须**恰好**是契约里那 39 个，一个不多一个不少。
  assert.deepStrictEqual(
    [...new Set([...IN_SCOPE_OPERATION_IDS, ...OUT_OF_SCOPE_OPERATION_IDS])].sort(),
    [...contractIds].sort(),
  );

  const { service } = createHarness();
  assert.equal(typeof service.operationIds, 'object');
  assert.equal(service.operationIds.length, 25);
  assert.deepStrictEqual([...service.operationIds].sort(), [...IN_SCOPE_OPERATION_IDS].sort());

  for (const id of IN_SCOPE_OPERATION_IDS) assert.equal(typeof service[id], 'function', `${id} 未实现`);
  // 越界即缺陷：不在本片的操作连方法都不该存在。
  for (const id of OUT_OF_SCOPE_OPERATION_IDS) {
    assert.equal(service[id], undefined, `本片不得实现 ${id}`);
  }

  // 描述符里的 operationId / 路径 / 方法必须与契约逐条对上。
  const byId = new Map(adminPathOperations.map((entry) => [entry.operationId, entry]));
  for (const descriptor of FAMILIES) {
    for (const [action, operationId] of Object.entries(descriptor.operations)) {
      const contractEntry = byId.get(operationId);
      assert.notEqual(contractEntry, undefined, `契约缺 ${operationId}`);
      assert.ok(contractEntry.path.startsWith(descriptor.path), `${operationId} 路径前缀不符：${contractEntry.path}`);
      const expectedMethod = action === 'list' || action === 'get' ? 'GET' : action === 'edit' ? 'PATCH' : 'POST';
      assert.equal(contractEntry.method, expectedMethod, `${operationId} 方法不符`);
    }
  }
  const auditEntry = byId.get('listAuditEvents');
  assert.equal(auditEntry.path, '/admin/audit-events');
  assert.equal(auditEntry.method, 'GET');
});

test('读写 scope 与契约 operations.json 一致（四类资料共用 sources:read / sources:write）', () => {
  const scopeById = new Map(operations.operations.map((entry) => [entry.id, entry.scope]));
  assert.equal(scopeById.get('listAuditEvents'), 'audit:read');
  for (const descriptor of FAMILIES) {
    assert.equal(descriptor.readScope, 'sources:read');
    assert.equal(descriptor.writeScope, 'sources:write');
    for (const [action, operationId] of Object.entries(descriptor.operations)) {
      const expected = action === 'list' || action === 'get' ? 'sources:read' : 'sources:write';
      assert.equal(scopeById.get(operationId), expected, `${operationId} 的契约 scope 不符`);
    }
  }
  assert.equal(typeof operations.contract_version, 'string');
});

test('TargetRef.type 的临时映射只使用契约闭集成员（契约缺口不越界）', async () => {
  const contractEnum = openapi.components.schemas.TargetRef.properties.type.enum;
  assert.deepStrictEqual([...contractEnum], [...TARGET_REF_TYPES], '闭集镜像与契约不一致');
  // 缺口本身要被验证到：闭集里确实没有这三类资料的成员。
  for (const missing of ['knowledge', 'registration', 'restriction']) {
    assert.equal(contractEnum.includes(missing), false, `${missing} 竟已在闭集内，映射表需要复核`);
  }

  const { service, store } = createHarness();
  for (const caseEntry of FAMILY_CASES) {
    const created = await createDraft(caseEntry, service);
    const id = created.body.data.id;
    assert.equal(typeof id, 'string');
    await publishRevision(caseEntry, service, id, 1);
  }
  const events = (await service.listAuditEvents(context())).body.data.items;
  assert.equal(events.length, 4);
  for (const event of events) {
    assert.equal(typeof event.target_ref.type, 'string');
    assert.ok(contractEnum.includes(event.target_ref.type), `审计目标类型越出闭集：${event.target_ref.type}`);
    assert.equal(typeof event.target_ref.revision, 'number');
  }
  assert.deepStrictEqual(events.map((event) => event.action).sort(), ['knowledge.publish', 'registration.publish', 'restriction.publish', 'source.publish']);
  assert.equal(store.persistent, false, '本片存储必须如实标注为内存实现');
});

test('所有响应体与契约出参 schema 同形（含分页信封与审计投影）', async () => {
  const { service } = createHarness();
  for (const caseEntry of FAMILY_CASES) {
    const created = await createDraft(caseEntry, service);
    assertMatchesContract(caseEntry.descriptor.envelopeSchema, created.body, `${caseEntry.name} 创建响应`);

    const id = created.body.data.id;
    const fetched = await caseEntry.ops(service).get(context(), id);
    assertMatchesContract(caseEntry.descriptor.envelopeSchema, fetched.body, `${caseEntry.name} 详情响应`);

    await publishRevision(caseEntry, service, id, 1);
    const listed = await caseEntry.ops(service).list(context());
    assertMatchesContract(caseEntry.descriptor.pageEnvelopeSchema, listed.body, `${caseEntry.name} 列表响应`);
    // 列表响应不得带 ETag（契约 headers 描述：列表无此头）。
    assert.equal(listed.headers['ETag'], undefined);
    assert.equal(listed.headers['Cache-Control'], 'no-store');
    // 单资源响应必须带强 ETag。
    assert.equal(fetched.headers['ETag'], '"1"');

    await withdrawRevision(caseEntry, service, id, 1);
  }
  const audit = await service.listAuditEvents(context());
  assertMatchesContract('AuditEventPageEnvelope', audit.body);
  assert.equal(audit.body.data.items.length, 8, '四类资料各一次发布 + 一次撤回');
  for (const event of audit.body.data.items) {
    // 契约出口必须恰好是合同的 8 个字段：内部 actor_id 不得泄漏。
    assert.deepStrictEqual(
      Object.keys(event).sort(),
      ['action', 'created_at', 'id', 'reason_code', 'request_id', 'result', 'scope', 'target_ref'],
    );
    assert.deepStrictEqual(contractIssues('AuditEvent', event), []);
  }
});

test('非 admin 身份对 25 个操作一律拒绝（口径与契约闭集一致）', async () => {
  const { service } = createHarness();
  const asUser = { identity: userIdentity() };
  const cases = [
    (ctx) => service.listAdminSources(ctx),
    (ctx) => service.createSourceDraft(ctx, FAMILY_CASES[0].contentInput()),
    (ctx) => service.publishSource(ctx, '00000000-0000-4000-8000-000000000000', validPublishBody()),
    (ctx) => service.listAdminKnowledge(ctx),
    (ctx) => service.listAdminRegistration(ctx),
    (ctx) => service.listAdminRestriction(ctx),
    (ctx) => service.listAuditEvents(ctx),
  ];
  for (const call of cases) {
    await assert.rejects(call(asUser), (error) => {
      assert.equal(typeof error.code, 'string');
      assert.equal(error.code, 'SCOPE_DENIED');
      assert.equal(error.status, 403);
      return true;
    });
  }
});
