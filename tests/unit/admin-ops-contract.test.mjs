/**
 * GY-I18 阶段 1b · 契约一致性（读 openapi.json 原文比对，只读）。
 *
 * 回答三个问题：
 * 1. 本片的字段镜像表与契约逐字相等吗（含 `AdminJob.result` 的 `{"type":"null"}`）？
 * 2. 本片**恰好**做了 9 个 operationId 吗？其余显式不做的操作有没有被越界实现？
 * 3. 读写 scope 与 `packages/contracts/operations.json` 一致吗？
 *
 * 注意：JSON Schema 的 `enum` 是**无序集合**，因此比对时对 `enum` 数组排序后比较
 * （其余关键字——`type`/`format`/`pattern`/长度/`required`/`additionalProperties`——一律逐字比较）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  OPS_INPUT_SPECS,
  OPS_OUTPUT_SPECS,
  OPS_PAGE_SPECS,
  OPS_ENVELOPE_SPECS,
  OPS_ALL_SPECS,
} from '../../services/api/src/admin/ops/fields.ts';
import { CONTRACT_FLAG_KEYS, FORBIDDEN_FLAG_KEYS } from '../../services/api/src/admin/ops/flags.ts';
import { OPS_IDS, OPS_OUT_OF_SCOPE_IDS, OPS_SCOPES, createOpsHarness, opsContext } from './admin-ops-fixtures.mjs';

const ROOT = new URL('../../', import.meta.url);
const openapi = JSON.parse(readFileSync(new URL('packages/contracts/openapi.json', ROOT), 'utf8'));
const operations = JSON.parse(readFileSync(new URL('packages/contracts/operations.json', ROOT), 'utf8'));

function normalizeContractSchema(node) {
  assert.equal(typeof node, 'object');
  assert.notEqual(node, null);
  if (node.$ref !== undefined) {
    assert.ok(node.$ref.startsWith('#/components/schemas/'), `非本地 schema 引用：${node.$ref}`);
    return { ref: node.$ref.slice('#/components/schemas/'.length) };
  }
  if (node.anyOf !== undefined) {
    assert.equal(node.anyOf.length, 2, 'anyOf 只支持 [T, null]');
    assert.deepEqual(node.anyOf[1], { type: 'null' });
    return { ...normalizeContractSchema(node.anyOf[0]), nullable: true };
  }
  const out = {};
  for (const key of ['type', 'const', 'format', 'pattern', 'minLength', 'maxLength', 'minimum', 'minItems', 'maxItems', 'required']) {
    if (node[key] !== undefined) out[key] = node[key];
  }
  // `enum` 是无序集合：排序后比较。
  if (node.enum !== undefined) out.enum = [...node.enum].sort();
  if (node.items !== undefined) out.items = normalizeContractSchema(node.items);
  if (node.properties !== undefined) {
    out.properties = {};
    for (const [key, value] of Object.entries(node.properties)) out.properties[key] = normalizeContractSchema(value);
  }
  if (node.additionalProperties === false) out.additionalProperties = false;
  return out;
}

/** 镜像表侧的归一化：同样把 `enum` 排序，其余原样。 */
function normalizeMirror(spec) {
  const out = {};
  for (const [key, value] of Object.entries(spec)) {
    if (key === 'enum') out.enum = [...value].sort();
    else if (key === 'items') out.items = normalizeMirror(value);
    else if (key === 'properties') {
      out.properties = {};
      for (const [k, v] of Object.entries(value)) out.properties[k] = normalizeMirror(v);
    } else out[key] = value;
  }
  return out;
}

function assertNoUndefined(value, path) {
  if (value === undefined) assert.fail(`镜像表在 ${path} 处出现 undefined`);
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) assertNoUndefined(child, `${path}.${key}`);
}

test('本片字段镜像表与契约逐字相等（含 AdminJob.result 的 type:null）', () => {
  const groups = [
    ['OPS_INPUT_SPECS', OPS_INPUT_SPECS],
    ['OPS_OUTPUT_SPECS', OPS_OUTPUT_SPECS],
    ['OPS_PAGE_SPECS', OPS_PAGE_SPECS],
    ['OPS_ENVELOPE_SPECS', OPS_ENVELOPE_SPECS],
  ];
  let compared = 0;
  for (const [groupName, group] of groups) {
    for (const [name, spec] of Object.entries(group)) {
      assert.equal(typeof spec, 'object', `${groupName}.${name} 必须是对象`);
      assertNoUndefined(spec, `${groupName}.${name}`);
      const contract = openapi.components.schemas[name];
      assert.notEqual(contract, undefined, `契约里没有 ${name}`);
      assert.deepStrictEqual(
        normalizeMirror(spec),
        normalizeContractSchema(contract),
        `${groupName}.${name} 与契约不同形`,
      );
      compared += 1;
    }
  }
  // 本片**新增**的镜像 schema：入参 2 + 出参 7 + 分页 4 + 信封 9 = 22。
  // 其余 4 个（ReasonInput / Meta / ExecutionMode / TargetRef）直接复用阶段 1 的全表，不重复定义。
  assert.equal(compared, 22, '本片新增镜像的 schema 数量应恰好 22');

  // 反向确认归一化没把关键约束吃掉。
  const job = normalizeContractSchema(openapi.components.schemas.AdminJob);
  assert.deepEqual(job.properties.result, { type: 'null' });
  assert.equal(job.additionalProperties, false);
  assert.equal(job.required.length, 9);
  const flag = normalizeContractSchema(openapi.components.schemas.Flag);
  assert.deepEqual(flag.properties.key.enum, [...CONTRACT_FLAG_KEYS].sort());
  // 注册表 = 阶段 1 全表 + 本片新增；共用的 4 个 schema 必须仍来自阶段 1（不重复定义）。
  for (const shared of ['ReasonInput', 'Meta', 'ExecutionMode', 'TargetRef', 'AuditEvent']) {
    assert.notEqual(OPS_ALL_SPECS[shared], undefined, `${shared} 应复用阶段 1 的镜像`);
  }
  assert.ok(Object.keys(OPS_ALL_SPECS).length >= 22);
});

test('setFlag 的 key 是契约闭集枚举（依据取自契约原文，不是猜测）', () => {
  const put = openapi.paths['/admin/feature-flags/{key}'].put;
  const keyParam = put.parameters.find((p) => p.name === 'key' && p.in === 'path');
  assert.notEqual(keyParam, undefined);
  assert.deepStrictEqual(keyParam.schema.enum, [...CONTRACT_FLAG_KEYS]);
  assert.equal(keyParam.required, true);
  // 契约闭集里不存在任何"关闭硬规则/放宽 fail-closed"的 key。
  for (const key of CONTRACT_FLAG_KEYS) {
    assert.equal(FORBIDDEN_FLAG_KEYS.includes(key), false, `${key} 竟是安全语义保留名`);
  }
});

test('恰好实现 12 个 operationId；显式不做的操作未被实现', async () => {
  const byId = new Map();
  for (const [path, item] of Object.entries(openapi.paths)) {
    for (const method of ['get', 'post', 'patch', 'put', 'delete']) {
      const op = item[method];
      if (op !== undefined) byId.set(op.operationId, { path, method: method.toUpperCase(), op });
    }
  }
  for (const id of OPS_IDS) assert.ok(byId.has(id), `契约里没有 ${id}`);
  assert.equal(new Set(OPS_IDS).size, 12);
  const overlap = OPS_IDS.filter((id) => OPS_OUT_OF_SCOPE_IDS.includes(id));
  assert.deepEqual(overlap, [], '本片范围内外不得重叠');

  const { service } = createOpsHarness();
  assert.equal(service.operationIds.length, 12);
  assert.deepStrictEqual([...service.operationIds].sort(), [...OPS_IDS].sort());
  for (const id of OPS_IDS) assert.equal(typeof service[id], 'function', `${id} 未实现`);
  for (const id of OPS_OUT_OF_SCOPE_IDS) assert.equal(service[id], undefined, `本片不得实现 ${id}`);

  // 契约里这 12 个的路径/方法与派单一致。
  assert.equal(byId.get('listAdminCategories').path, '/admin/categories');
  assert.equal(byId.get('editCategory').method, 'PATCH');
  assert.equal(byId.get('listAdminUsers').path, '/admin/accounts');
  assert.equal(byId.get('suspendUser').path, '/admin/accounts/{id}/suspend');
  assert.equal(byId.get('listAdminJobs').path, '/admin/jobs');
  assert.equal(byId.get('cancelAdminJob').path, '/admin/jobs/{id}/cancel');
  assert.equal(byId.get('listFlags').path, '/admin/feature-flags');
  assert.equal(byId.get('setFlag').method, 'PUT');
  assert.equal(byId.get('listFlagAuditEvents').path, '/admin/flag-audit-events');
  assert.equal(byId.get('listFlagAuditEvents').method, 'GET');
  assert.equal(byId.get('hidePost').path, '/admin/posts/{id}/hide');
  assert.equal(byId.get('listAdministrators').path, '/admin/administrators');
  assert.equal(byId.get('listAdministrators').method, 'GET');
  assert.equal(byId.get('listAdministratorScopes').path, '/admin/administrators/{id}/scopes');
  assert.equal(byId.get('listAdministratorScopes').method, 'GET');
});

test('读写 scope 与 operations.json 一致', () => {
  const scopeById = new Map(operations.operations.map((entry) => [entry.id, entry.scope]));
  for (const [id, scope] of Object.entries(OPS_SCOPES)) {
    assert.equal(scopeById.get(id), scope, `${id} 的契约 scope 不符`);
  }
  // 逐条核对派单里列出的 scope（防止我抄错）。
  assert.equal(scopeById.get('listAdminCategories'), 'sources:read');
  assert.equal(scopeById.get('editCategory'), 'sources:write');
  assert.equal(scopeById.get('listAdminUsers'), 'accounts:read');
  assert.equal(scopeById.get('suspendUser'), 'accounts:suspend');
  assert.equal(scopeById.get('listAdminJobs'), 'jobs:read');
  assert.equal(scopeById.get('cancelAdminJob'), 'jobs:cancel');
  assert.equal(scopeById.get('listFlags'), 'flags:read');
  assert.equal(scopeById.get('setFlag'), 'flags:write');
  assert.equal(scopeById.get('hidePost'), 'sources:write');
  assert.equal(scopeById.get('listAdministrators'), 'scopes:read');
  assert.equal(scopeById.get('listAdministratorScopes'), 'scopes:read');
});

test('响应体与契约出参 schema 同形（含分页信封与作业的 result:null）', async () => {
  const { service } = createOpsHarness();
  const ctx = opsContext();

  const categories = await service.listAdminCategories(ctx);
  assert.equal(typeof categories.status, 'number');
  assert.equal(categories.status, 200);
  assert.equal(categories.headers['ETag'], undefined, '列表响应不得带 ETag');
  assert.equal(categories.headers['Cache-Control'], 'no-store');
  // 手工核对（不经测试自带的 helper），确保断言真的在契约上。
  const contractPage = normalizeContractSchema(openapi.components.schemas.CategoryPage);
  assert.deepEqual(Object.keys(categories.body.data).sort(), [...contractPage.required].sort());

  const users = await service.listAdminUsers(ctx);
  assert.equal(users.body.data.items.length, 3);
  const flags = await service.listFlags(ctx);
  assert.equal(flags.body.data.items.length, 3, '契约闭集 3 个 key 都必须有状态');

  const jobs = await service.listAdminJobs(ctx);
  assert.equal(jobs.body.data.items.length, 4);
  for (const item of jobs.body.data.items) {
    assert.equal(item.result, null, '契约里 result 恒为 null，不得填占位内容');
    // 契约允许 `error_code` 为 null（`anyOf [ErrorCode, null]`）。
    assert.ok(item.error_code === null || typeof item.error_code === 'string', 'error_code 只能是 ErrorCode 或 null');
  }

  const edited = await service.editCategory(
    { ...ctx, idempotencyKey: 'gy-i18b-cat-0001', ifMatch: '"1"' },
    'crop-rice',
    { name: '水稻（改）', description: '示例分类：水稻（改）', active: false },
  );
  assert.equal(typeof edited.headers['ETag'], 'string');
  assert.equal(edited.headers['ETag'], '"2"');

  const suspended = await service.suspendUser(
    { ...ctx, idempotencyKey: 'gy-i18b-acc-0001', ifMatch: '"1"' },
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    { reason: '示例：违规内容多发' },
  );
  assert.equal(suspended.body.data.state, 'suspended');

  const flag = await service.setFlag(
    { ...ctx, idempotencyKey: 'gy-i18b-flag-0001', ifMatch: '"1"' },
    'ai_enabled',
    { enabled: true, reason: '示例：开启 AI 能力' },
  );
  assert.equal(flag.body.data.enabled, true);

  const cancelled = await service.cancelAdminJob(
    { ...ctx, idempotencyKey: 'gy-i18b-job-0001', ifMatch: '"1"' },
    '00000000-0000-4000-a000-000000000101',
    { reason: '示例：作业超时' },
  );
  assert.equal(cancelled.body.data.state, 'cancelled');
});
