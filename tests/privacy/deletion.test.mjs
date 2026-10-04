import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeletionRegistry } from '../../packages/privacy/deletion.mjs';
import { PrivacyError } from '../../packages/privacy/errors.mjs';

test('createDeletionRequest 记录在线 7 日 / 备份 30 日截止，状态 requested 不等于 completed', () => {
  const reg = createDeletionRegistry();
  const req = reg.createDeletionRequest({ generation: 1 });
  assert.equal(req.state, 'requested');
  const onlineDiff = req.onlineDueAt.getTime() - req.requestedAt.getTime();
  const backupDiff = req.backupDueAt.getTime() - req.requestedAt.getTime();
  assert.equal(onlineDiff, 7 * 24 * 3600 * 1000);
  assert.equal(backupDiff, 30 * 24 * 3600 * 1000);
  // 到期不等于完成：时钟不推进完成
  assert.equal(reg.completionStatus(req.id).completed, false);
});

test('模块删除处理器注册协议：重复注册拒绝', () => {
  const reg = createDeletionRegistry();
  reg.registerModule('media', async () => ({ onlineState: 'completed', backupState: 'completed' }));
  assert.throws(() => reg.registerModule('media', async () => ({})), (e) => e instanceof PrivacyError);
});

test('所有 handler 完成才可完结；有 blocked 则整体 blocked', async () => {
  const reg = createDeletionRegistry();
  reg.registerModule('media', async () => ({ onlineState: 'completed', backupState: 'completed' }));
  reg.registerModule('session', async () => ({ onlineState: 'completed', backupState: 'completed' }));
  const req = reg.createDeletionRequest({ generation: 1 });
  await reg.executeHandlers(req.id);
  assert.equal(reg.completionStatus(req.id).completed, true);
});

test('handler blocked 时 completionStatus 为 blocked 且未完成', async () => {
  const reg = createDeletionRegistry();
  reg.registerModule('media', async () => ({ onlineState: 'blocked', backupState: 'blocked', errorCode: 'STORE_UNREACHABLE' }));
  const req = reg.createDeletionRequest({ generation: 1 });
  await reg.executeHandlers(req.id);
  const status = reg.completionStatus(req.id);
  assert.equal(status.completed, false);
  assert.equal(status.state, 'blocked');
});

test('第三方删除请求/完成/失败可追溯，requested 绝不等于 confirmed', () => {
  const reg = createDeletionRegistry();
  const req = reg.createDeletionRequest({ generation: 1 });
  const row = reg.requestThirdPartyDeletion({ requestId: req.id, recipientId: 'provider-llm' });
  assert.equal(row.onlineStatus, 'requested');
  // 确认必须有证据
  assert.throws(
    () => reg.confirmThirdPartyDeletion({ requestId: req.id, recipientId: 'provider-llm', evidenceRef: null }),
    (e) => e instanceof PrivacyError && e.code === 'INVALID_REQUEST',
  );
  const confirmed = reg.confirmThirdPartyDeletion({
    requestId: req.id,
    recipientId: 'provider-llm',
    evidenceRef: 'deletion-receipt-123',
  });
  assert.equal(confirmed.onlineStatus, 'confirmed');
  assert.ok(confirmed.confirmedAt);
  assert.ok(confirmed.evidenceRef);
});

test('未发起第三方请求时确认报 NOT_FOUND', () => {
  const reg = createDeletionRegistry();
  const req = reg.createDeletionRequest({ generation: 1 });
  assert.throws(
    () => reg.confirmThirdPartyDeletion({ requestId: req.id, recipientId: 'provider-llm', evidenceRef: 'x' }),
    (e) => e instanceof PrivacyError && e.code === 'NOT_FOUND',
  );
});

test('第三方失败导致整体未完成；不支持状态可追溯', async () => {
  const reg = createDeletionRegistry();
  reg.registerModule('session', async () => ({ onlineState: 'completed', backupState: 'completed' }));
  const req = reg.createDeletionRequest({ generation: 1 });
  reg.requestThirdPartyDeletion({ requestId: req.id, recipientId: 'provider-llm' });
  reg.failThirdPartyDeletion({ requestId: req.id, recipientId: 'provider-llm', errorCode: 'PROVIDER_TIMEOUT' });
  await reg.executeHandlers(req.id);
  // 失败的第三方导致整体未完成（不把请求当完成）
  assert.equal(reg.completionStatus(req.id).completed, false);
  assert.equal(reg.completionStatus(req.id).state, 'blocked');
  // 不支持状态可追溯
  reg.requestThirdPartyDeletion({ requestId: req.id, recipientId: 'provider-other' });
  reg.markUnsupported({ requestId: req.id, recipientId: 'provider-other' });
  assert.equal(reg.completionStatus(req.id).completed, false);
});

// ---- P1-4：删除处理器缺返回值、pending/running 都不能记完成 ----

test('P1-4 handler 缺返回值（undefined）不记完成', async () => {
  const reg = createDeletionRegistry();
  reg.registerModule('media', async () => undefined);
  const req = reg.createDeletionRequest({ generation: 1 });
  await reg.executeHandlers(req.id);
  const status = reg.completionStatus(req.id);
  assert.equal(status.completed, false);
  assert.equal(status.state, 'blocked');
  assert.equal(reg._handlerRows[0].errorCode, 'INVALID_HANDLER_RESULT');
});

test('P1-4 handler 异步（running/pending）不记完成', async () => {
  const reg = createDeletionRegistry();
  reg.registerModule('media', async () => ({ onlineState: 'running', backupState: 'pending' }));
  const req = reg.createDeletionRequest({ generation: 1 });
  await reg.executeHandlers(req.id);
  assert.equal(reg._handlerRows[0].status, 'running');
  assert.equal(reg.completionStatus(req.id).completed, false);
});

test('P1-4 handler 非法状态值不记完成', async () => {
  const reg = createDeletionRegistry();
  reg.registerModule('media', async () => ({ onlineState: 'bogus', backupState: 'completed' }));
  const req = reg.createDeletionRequest({ generation: 1 });
  await reg.executeHandlers(req.id);
  assert.equal(reg._handlerRows[0].status, 'blocked');
  assert.equal(reg.completionStatus(req.id).completed, false);
});

test('P1-4 handler 失败后可重试至完成', async () => {
  const reg = createDeletionRegistry();
  let attempts = 0;
  reg.registerModule('media', async () => {
    attempts += 1;
    if (attempts === 1) throw new PrivacyError('HANDLER_FAILED', 'first attempt fails');
    return { onlineState: 'completed', backupState: 'completed' };
  });
  const req = reg.createDeletionRequest({ generation: 1 });
  await reg.executeHandlers(req.id);
  assert.equal(reg.completionStatus(req.id).completed, false);
  // 重试：已完成/未完成的 blocked 行被重跑
  await reg.executeHandlers(req.id);
  assert.equal(attempts, 2);
  assert.equal(reg.completionStatus(req.id).completed, true);
});

// ---- P1-5：第三方 unsupported 必须保留阻塞 ----

test('P1-5 唯一第三方 unsupported 保留阻塞（无法删除≠已证实完成）', async () => {
  const reg = createDeletionRegistry();
  reg.registerModule('session', async () => ({ onlineState: 'completed', backupState: 'completed' }));
  const req = reg.createDeletionRequest({ generation: 1 });
  reg.requestThirdPartyDeletion({ requestId: req.id, recipientId: 'provider-llm' });
  reg.markUnsupported({ requestId: req.id, recipientId: 'provider-llm' });
  await reg.executeHandlers(req.id);
  const status = reg.completionStatus(req.id);
  assert.equal(status.completed, false);
  assert.equal(status.state, 'blocked');
});

test('回执投影不含私有正文/图片/音频/坐标/凭据', async () => {
  const reg = createDeletionRegistry();
  reg.registerModule('identity', async () => ({
    onlineState: 'completed',
    backupState: 'completed',
    evidenceRef: 'opaque-evidence',
  }));
  const req = reg.createDeletionRequest({ generation: 1 });
  await reg.executeHandlers(req.id);
  const projection = reg.receiptProjection(req.id);
  const json = JSON.stringify(projection);
  // 回执不含任何私有内容字段（模块名/进度/期限/失败码是允许的元数据）
  for (const forbidden of ['body', 'transcription', 'image', 'audio', 'token', 'password', 'coordinate', 'latitude', 'longitude']) {
    assert.equal(json.includes(forbidden), false, `回执不应含 ${forbidden}`);
  }
  // 只暴露进度/期限/最小失败码
  assert.ok(projection.handlers.length >= 1);
  assert.ok(projection.onlineDueAt);
  assert.ok(projection.backupDueAt);
  // handler 条目只含允许键，不夹带私有字段
  for (const h of projection.handlers) {
    assert.deepEqual(
      Object.keys(h).sort(),
      ['backupState', 'errorCode', 'module', 'onlineState', 'thirdPartyState'],
    );
  }
});
