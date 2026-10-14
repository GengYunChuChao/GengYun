/**
 * GY-I27（#29）· 全模块删除注册协议 + 契约形状回执 + 第三方删除状态机回归。
 *
 * 关键口径：**"全模块"是显式闭集**。只注册/报告部分模块时，无论这些模块多么"完成"，
 * 都不得判整单 `completed`（"全模块注销/删除恢复必要证据未齐"）。完整 7／30 日集成属 GY-I19，
 * 本文件不涉及对象存储/备份/供应商副本的真实删除。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDeletionRegistry } from '../../packages/privacy/deletion.mjs';
import { createDeletionCoordinator, DELETION_MODULE_LIMIT } from '../../packages/privacy/deletion-modules.mjs';
import { PrivacyError } from '../../packages/privacy/errors.mjs';

const CONTRACT = JSON.parse(readFileSync(new URL('../../packages/contracts/openapi.json', import.meta.url), 'utf8'));
const RECEIPT_SCHEMA = CONTRACT.components.schemas.DeletionReceipt;
const HANDLER_SCHEMA = CONTRACT.components.schemas.DeletionHandler;

const MODULES = ['account_identity', 'media_objects', 'conversations'];

function report(overrides = {}) {
  return async () => ({ onlineState: 'completed', backupState: 'completed', evidenceRef: 'EVID-2026-10-14-001', ...overrides });
}

function setup({ requiredModules = MODULES } = {}) {
  const registry = createDeletionRegistry();
  const coordinator = createDeletionCoordinator({ registry, requiredModules });
  for (const module of requiredModules) coordinator.registerModule(module, report());
  return { registry, coordinator };
}

test('必需模块闭集校验：空集/重复/超限/非法名一律拒绝（空集无法证明"全模块"）', () => {
  const registry = createDeletionRegistry();
  const build = (requiredModules) => createDeletionCoordinator({ registry, requiredModules });
  assert.throws(() => build([]), (err) => err.code === 'INVALID_REQUEST');
  assert.throws(() => build(['a', 'a']), (err) => err.code === 'INVALID_REQUEST');
  assert.throws(() => build(['']), (err) => err.code === 'INVALID_REQUEST');
  assert.throws(() => build(['a'.repeat(81)]), (err) => err.code === 'INVALID_REQUEST');
  assert.throws(
    () => build(Array.from({ length: DELETION_MODULE_LIMIT + 1 }, (_value, index) => `m${index}`)),
    (err) => err.code === 'INVALID_REQUEST',
  );
  assert.equal(registry._requests.size, 0);
});

test('未声明的模块不可注册（避免"注册了就算齐"）', () => {
  const { coordinator } = setup();
  assert.throws(
    () => coordinator.registerModule('caches', report()),
    (err) => err.code === 'INVALID_REQUEST',
  );
  assert.deepEqual(coordinator.registeredModules().sort(), [...MODULES].sort());
});

test('全模块未注册齐时不得受理删除请求（不假装能完成）', () => {
  const registry = createDeletionRegistry();
  const coordinator = createDeletionCoordinator({ registry, requiredModules: MODULES });
  coordinator.registerModule('account_identity', report());
  assert.deepEqual(coordinator.missingRegistrations(), ['media_objects', 'conversations']);
  assert.throws(
    () => coordinator.createDeletionRequest({ generation: 1, receiptInput: 'synthetic-receipt' }),
    (err) => err.code === 'OBJECT_UNAVAILABLE',
  );
  assert.equal(registry._requests.size, 0, '不得留下一个永远不可能完成的删除请求');
});

test('闭集在创建任何请求之前声明，之后不可再改（不得按已有结果倒推清单）', () => {
  const { coordinator } = setup();
  coordinator.createDeletionRequest({ generation: 1, receiptInput: 'synthetic-1' });
  assert.throws(
    () => coordinator.declareRequiredModules(['account_identity']),
    (err) => err.code === 'OBJECT_UNAVAILABLE',
  );
  assert.deepEqual(coordinator.requiredModules(), MODULES);
});

test('全部模块报告完成且证据齐全 ⇒ completed（继承 deletion.mjs 的证据要求）', async () => {
  const { registry, coordinator } = setup();
  const request = coordinator.createDeletionRequest({ generation: 1, receiptInput: 'synthetic-1' });
  await coordinator.executeHandlers(request.id);
  const status = coordinator.completionStatus(request.id);
  assert.equal(status.completed, true);
  assert.deepEqual([...status.missingModules], []);
  assert.equal(registry.getRequest(request.id).state, 'completed');
  assert.equal(coordinator.receipt(request.id).state, 'completed');
});

test('缺证据的模块不得让整单完成（证据未齐 ⇒ blocked）', async () => {
  const registry = createDeletionRegistry();
  const coordinator = createDeletionCoordinator({ registry, requiredModules: MODULES });
  coordinator.registerModule('account_identity', report());
  coordinator.registerModule('media_objects', async () => ({ onlineState: 'completed', backupState: 'completed', evidenceRef: '' }));
  coordinator.registerModule('conversations', report());
  const request = coordinator.createDeletionRequest({ generation: 1, receiptInput: 'synthetic-2' });
  await coordinator.executeHandlers(request.id);
  const status = coordinator.completionStatus(request.id);
  assert.equal(status.completed, false);
  assert.equal(status.state, 'blocked');
});

test('**关键反例**：绕过协调器只报告部分模块时，整单不得判完成，且缺口可见', async () => {
  // 直连注册表（模拟"某个集成方自己注册了 1 个模块就执行"）：只报 1 个模块的完成。
  const raw = createDeletionRegistry();
  raw.registerModule('account_identity', report());
  const rawRequest = raw.createDeletionRequest({ generation: 1, receiptInput: 'synthetic-direct' });
  await raw.executeHandlers(rawRequest.id);
  // 直连注册表自己会判"完成"（旧口径：只看已登记行）。
  assert.equal(raw.completionStatus(rawRequest.id).completed, true, '旧口径确实会把部分模块当全模块完成');

  // 协调器用同一逻辑复核：闭集未齐 ⇒ 不完成 + 缺口可见。
  const direct = createDeletionCoordinator({ registry: raw, requiredModules: MODULES });
  const status = direct.completionStatus(rawRequest.id);
  assert.equal(status.completed, false, '全模块闭集未齐不得判完成');
  assert.deepEqual([...status.missingModules].sort(), ['conversations', 'media_objects']);

  const receipt = direct.receipt(rawRequest.id);
  const pending = receipt.handlers.filter((row) => row.online_state === 'pending').map((row) => row.module);
  assert.deepEqual(pending.sort(), ['conversations', 'media_objects'], '未报告的必需模块必须以 pending 出现在回执里');
  assert.equal(receipt.state, 'processing');
});

test('回执与契约 DeletionReceipt / DeletionHandler 逐字段一致（含未报告模块）', async () => {
  const { registry, coordinator } = setup();
  // 正常走一遍：三条 handler 全部完成 -> 回执为 completed
  const request = coordinator.createDeletionRequest({ generation: 1, receiptInput: 'synthetic-3' });
  await coordinator.executeHandlers(request.id);
  const receipt = coordinator.receipt(request.id);
  assert.deepEqual(Object.keys(receipt).sort(), [...RECEIPT_SCHEMA.required].sort());
  assert.equal(receipt.requested_at, receipt.requested_at && new Date(receipt.requested_at).toISOString());
  assert.ok(new Date(receipt.online_due_at) > new Date(receipt.requested_at));
  assert.ok(new Date(receipt.backup_due_at) >= new Date(receipt.online_due_at));
  assert.ok(Number.isSafeInteger(receipt.revision) && receipt.revision >= 1);
  assert.ok(RECEIPT_SCHEMA.properties.state.$ref.endsWith('DeletionState'));
  for (const handler of receipt.handlers) {
    assert.deepEqual(Object.keys(handler).sort(), [...HANDLER_SCHEMA.required].sort());
    assert.ok(HANDLER_SCHEMA.properties.online_state.enum.includes(handler.online_state));
    assert.ok(HANDLER_SCHEMA.properties.backup_state.enum.includes(handler.backup_state));
    assert.ok(MODULES.includes(handler.module));
    assert.equal(handler.third_party_state, null);
    assert.equal(handler.error_code, null);
  }
  assert.deepEqual(receipt.handlers.map((row) => row.module).sort(), [...MODULES].sort());
  assert.equal(registry._requests.size, 1);
  assert.equal(coordinator.receipt('00000000-0000-4000-8000-0000000000ff'), null, '不存在的请求不得伪造回执');
});

test('第三方删除状态机：requested ≠ confirmed；确认必须有证据；失败/不支持保留阻塞', async () => {
  const { coordinator } = setup();
  const request = coordinator.createDeletionRequest({ generation: 1, receiptInput: 'synthetic-4' });
  await coordinator.executeHandlers(request.id);
  assert.equal(coordinator.completionStatus(request.id).completed, true);

  // 新请求 + 第三方待删：requested 阶段**不得**算完成。
  const request2 = coordinator.createDeletionRequest({ generation: 2, receiptInput: 'synthetic-5' });
  await coordinator.executeHandlers(request2.id);
  const requested = coordinator.requestThirdPartyDeletion({ requestId: request2.id, recipientId: 'provider-llm', exportRef: null });
  assert.equal(requested.onlineStatus, 'requested');
  assert.equal(coordinator.completionStatus(request2.id).completed, false, '有在途第三方删除请求时不得判完成');

  const statuses = coordinator.thirdPartyStatuses(request2.id);
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].recipient_id, 'provider-llm');
  assert.equal(statuses[0].completed, false);
  assert.equal(statuses[0].confirmed_at, null);
  assert.equal(statuses[0].evidence_ref, null);

  // 无证据不得确认。
  assert.throws(
    () => coordinator.confirmThirdPartyDeletion({ requestId: request2.id, recipientId: 'provider-llm', exportRef: null }),
    (err) => err.code === 'INVALID_REQUEST',
  );
  const confirmed = coordinator.confirmThirdPartyDeletion({
    requestId: request2.id, recipientId: 'provider-llm', exportRef: null, evidenceRef: 'https://example.invalid/evidence/delete-1',
  });
  assert.equal(confirmed.onlineStatus, 'confirmed');
  assert.equal(coordinator.thirdPartyStatuses(request2.id)[0].completed, true);
  assert.equal(coordinator.completionStatus(request2.id).completed, true, '全部第三方 confirmed（有证据）后才可完成');

  // failed / unsupported 保留阻塞（"无法删除"不等于"已证实完成"）。
  const request3 = coordinator.createDeletionRequest({ generation: 3, receiptInput: 'synthetic-6' });
  await coordinator.executeHandlers(request3.id);
  coordinator.requestThirdPartyDeletion({ requestId: request3.id, recipientId: 'provider-ocr', exportRef: null });
  coordinator.failThirdPartyDeletion({ requestId: request3.id, recipientId: 'provider-ocr', exportRef: null, errorCode: 'PROVIDER_TIMEOUT' });
  assert.equal(coordinator.thirdPartyStatuses(request3.id)[0].online_status, 'failed');
  assert.equal(coordinator.completionStatus(request3.id).completed, false);

  const request4 = coordinator.createDeletionRequest({ generation: 4, receiptInput: 'synthetic-7' });
  await coordinator.executeHandlers(request4.id);
  coordinator.requestThirdPartyDeletion({ requestId: request4.id, recipientId: 'provider-asr', exportRef: null });
  coordinator.markUnsupported({ requestId: request4.id, recipientId: 'provider-asr', exportRef: null });
  assert.equal(coordinator.thirdPartyStatuses(request4.id)[0].online_status, 'unsupported');
  assert.equal(coordinator.completionStatus(request4.id).completed, false);
});

test('回执与第三方状态不含私有正文/媒体/坐标/凭据', async () => {
  const { coordinator } = setup();
  const request = coordinator.createDeletionRequest({ generation: 1, receiptInput: 'synthetic-8' });
  await coordinator.executeHandlers(request.id);
  await coordinator.executeHandlers(request.id);
  const dumped = JSON.stringify({
    receipt: coordinator.receipt(request.id),
    thirdParty: coordinator.thirdPartyStatuses(request.id),
  });
  for (const forbidden of ['私有正文', '31.23041', '121.47370', 'data:image', 'bearer ']) {
    assert.equal(dumped.includes(forbidden), false, `回执不得包含：${forbidden}`);
  }
  assert.throws(() => coordinator.completionStatus('not-a-request'), (err) => err.code === 'NOT_FOUND');
});

test('缺能力时构造期拒绝；隐私错误码可映射（INVALID_REQUEST / NOT_FOUND / OBJECT_UNAVAILABLE）', () => {
  assert.throws(() => createDeletionCoordinator({}), /需要删除注册表提供/);
  // 形状满足接口但缺内部表（handler/第三方/请求）⇒ 构造期拒绝，不投入使用。
  const partial = {
    registerModule: () => 'x',
    createDeletionRequest: () => ({}),
    getRequest: () => null,
    executeHandlers: async () => ({}),
    completionStatus: () => ({ state: 'processing', completed: false }),
    requestThirdPartyDeletion: () => ({}),
    confirmThirdPartyDeletion: () => ({}),
    failThirdPartyDeletion: () => ({}),
    markUnsupported: () => ({}),
  };
  assert.throws(
    () => createDeletionCoordinator({ registry: partial, requiredModules: ['a'] }),
    /需要注册表暴露/,
  );
  assert.ok(new PrivacyError('NOT_FOUND', 'x').status === 404);
});
