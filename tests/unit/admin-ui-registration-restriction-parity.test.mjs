/**
 * 契约派生用例：**注册资料 / 限制资料两族的 12 条 operationId 必须有客户端函数接住**。
 *
 * 动机（本片的立项原因）：`/admin/registrations*` 与 `/admin/restrictions*` 这 12 条 operation
 * 曾经「有路由、有契约、零客户端」——契约里查得到、服务端能应答，但后台页面没有任何入口。
 * 这类缺口靠人工核对会复现，所以这里直接从 `packages/contracts/openapi.json` 读事实：
 *
 *  1. 两条路径家族下的 `operationId` 集合必须是 **12 条**，且与
 *     `admin-content-api.mjs` 的 `REGISTRATION_RESTRICTION_OPERATIONS` 表**双向相等**（缺一条或多一条都红）；
 *  2. 表里每个值必须是该模块真实导出的**函数**（不是字符串别名）；
 *  3. 每个 `operationId` 必须出现在对应页面的**可见文案**里（页面自述自己调了哪几条，便于审查对照）；
 *  4. `ContentAdminView.vue` 必须真的把两个页面挂进子 tab（页面存在但没入口 = 本次要消灭的形态）。
 *
 * 注意：本用例读的是**仓库里真实的** `packages/contracts/openapi.json`（不是手抄常量），
 * 因此契约一改、客户端没跟上，这条用例先红。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import * as api from '../../apps/admin/src/lib/admin-content-api.mjs';

const CONTRACT_PATH = fileURLToPath(new URL('../../packages/contracts/openapi.json', import.meta.url));
const CONTENT_VIEW_PATH = fileURLToPath(new URL('../../apps/admin/src/views/ContentAdminView.vue', import.meta.url));
const REGISTRATION_VIEW_PATH = fileURLToPath(new URL('../../apps/admin/src/views/RegistrationAdminView.vue', import.meta.url));
const RESTRICTION_VIEW_PATH = fileURLToPath(new URL('../../apps/admin/src/views/RestrictionAdminView.vue', import.meta.url));

const contract = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8'));

/** 从契约里取某族（`/admin/registrations` 或 `/admin/restrictions`）的全部 operationId。 */
function operationIdsOf(familyPath) {
  const found = [];
  for (const [path, operations] of Object.entries(contract.paths)) {
    if (path !== familyPath && !path.startsWith(`${familyPath}/`)) continue;
    for (const [method, operation] of Object.entries(operations)) {
      if (!['get', 'post', 'patch', 'put', 'delete'].includes(method)) continue;
      assert.equal(typeof operation.operationId, 'string', `${method.toUpperCase()} ${path} 必须有 operationId`);
      found.push({ operationId: operation.operationId, method: method.toUpperCase(), path, scope: operation['x-scope'] });
    }
  }
  return found;
}

test('契约里这两族恰好 12 条 operationId，且 scope 仍是 sources:read / sources:write', () => {
  const registrations = operationIdsOf('/admin/registrations');
  const restrictions = operationIdsOf('/admin/restrictions');
  assert.equal(registrations.length, 6, `注册资料族应为 6 条，实际 ${registrations.length}`);
  assert.equal(restrictions.length, 6, `限制资料族应为 6 条，实际 ${restrictions.length}`);

  // 每族 2 条读面（列表 + 详情）、4 条写面（创建/编辑/发布/撤回）。
  const readScope = [...registrations, ...restrictions].filter((operation) => operation.method === 'GET');
  assert.deepEqual(readScope.map((operation) => operation.scope), Array(4).fill('sources:read'));
  const writeScope = [...registrations, ...restrictions].filter((operation) => operation.method !== 'GET');
  assert.deepEqual(writeScope.map((operation) => operation.scope), Array(8).fill('sources:write'));

  // 不许自造 registrations:* / restrictions:* 之类的 scope（本片红线）。
  for (const operation of [...registrations, ...restrictions]) {
    assert.match(operation.scope, /^sources:(read|write)$/, `${operation.operationId} 的 scope 越界：${operation.scope}`);
  }
});

test('12 个 operationId 与 REGISTRATION_RESTRICTION_OPERATIONS 表双向相等（缺一条/多一条都红）', () => {
  const contractIds = [...operationIdsOf('/admin/registrations'), ...operationIdsOf('/admin/restrictions')]
    .map((operation) => operation.operationId)
    .sort();
  assert.equal(contractIds.length, 12);
  assert.equal(new Set(contractIds).size, 12, '契约里 operationId 不得重复');

  const boundIds = Object.keys(api.REGISTRATION_RESTRICTION_OPERATIONS).sort();
  assert.deepEqual(boundIds, contractIds, '客户端绑定表必须与契约 operationId 一一对应');

  // 表里每个值都必须是**真实导出的函数**，不是占位字符串。
  for (const [operationId, functionName] of Object.entries(api.REGISTRATION_RESTRICTION_OPERATIONS)) {
    assert.equal(typeof api[functionName], 'function', `${operationId} 对应的 ${functionName} 必须由 admin-content-api.mjs 导出`);
  }

  // 方法/路径逐条对齐：列表 GET、详情 GET、创建 POST、编辑 PATCH、发布/撤回 POST + 后缀。
  const byId = Object.fromEntries(
    [...operationIdsOf('/admin/registrations'), ...operationIdsOf('/admin/restrictions')].map((operation) => [operation.operationId, operation]),
  );
  const expected = {
    listAdminRegistration: ['GET', '/admin/registrations'],
    getAdminRegistration: ['GET', '/admin/registrations/{id}'],
    createRegistrationDraft: ['POST', '/admin/registrations'],
    editRegistrationDraft: ['PATCH', '/admin/registrations/{id}'],
    publishRegistration: ['POST', '/admin/registrations/{id}/publish'],
    withdrawRegistration: ['POST', '/admin/registrations/{id}/withdraw'],
    listAdminRestriction: ['GET', '/admin/restrictions'],
    getAdminRestriction: ['GET', '/admin/restrictions/{id}'],
    createRestrictionDraft: ['POST', '/admin/restrictions'],
    editRestrictionDraft: ['PATCH', '/admin/restrictions/{id}'],
    publishRestriction: ['POST', '/admin/restrictions/{id}/publish'],
    withdrawRestriction: ['POST', '/admin/restrictions/{id}/withdraw'],
  };
  for (const [operationId, [method, path]] of Object.entries(expected)) {
    assert.equal(byId[operationId].method, method, `${operationId} 的方法与契约不符`);
    assert.equal(byId[operationId].path, path, `${operationId} 的路径与契约不符`);
  }
});

test('两个页面自述了各自 6 个 operationId，且容器页真的把它们挂进子 tab', () => {
  const registrationSource = readFileSync(REGISTRATION_VIEW_PATH, 'utf8');
  const restrictionSource = readFileSync(RESTRICTION_VIEW_PATH, 'utf8');

  for (const operation of operationIdsOf('/admin/registrations')) {
    assert.ok(registrationSource.includes(operation.operationId), `RegistrationAdminView.vue 必须写明 ${operation.operationId}`);
    assert.ok(registrationSource.includes(operation.path.replace('{id}', '{id}')), `RegistrationAdminView.vue 必须写明路径 ${operation.path}`);
  }
  for (const operation of operationIdsOf('/admin/restrictions')) {
    assert.ok(restrictionSource.includes(operation.operationId), `RestrictionAdminView.vue 必须写明 ${operation.operationId}`);
  }

  const containerSource = readFileSync(CONTENT_VIEW_PATH, 'utf8');
  assert.ok(containerSource.includes("key: 'registrations'"), '容器页必须有「注册资料」子 tab');
  assert.ok(containerSource.includes("key: 'restrictions'"), '容器页必须有「限制资料」子 tab');
  assert.ok(containerSource.includes("import RegistrationAdminView from './RegistrationAdminView.vue'"), '容器页必须 import RegistrationAdminView.vue');
  assert.ok(containerSource.includes("import RestrictionAdminView from './RestrictionAdminView.vue'"), '容器页必须 import RestrictionAdminView.vue');
  assert.ok(containerSource.includes('active === \'registrations\''), '容器页必须有 registrations 的渲染分支');
  assert.ok(containerSource.includes('active === \'restrictions\''), '容器页必须有 restrictions 的渲染分支');
  assert.ok(containerSource.includes('<RegistrationAdminView'), '容器页必须渲染 RegistrationAdminView');
  assert.ok(containerSource.includes('<RestrictionAdminView'), '容器页必须渲染 RestrictionAdminView');
  // 子页必须拿到 baseUrl/token/scopes，否则页面拿不到会话（会被当成「未登录」）。
  for (const tag of ['<RegistrationAdminView', '<RestrictionAdminView']) {
    const start = containerSource.indexOf(tag);
    const end = containerSource.indexOf('/>', start);
    const block = containerSource.slice(start, end);
    for (const prop of [':base-url="baseUrl"', ':token="session.accessToken"', ':scopes="scopes"']) {
      assert.ok(block.includes(prop), `${tag} 必须接收 ${prop}`);
    }
  }
});
