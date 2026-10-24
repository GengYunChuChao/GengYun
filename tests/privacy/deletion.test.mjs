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

test('所有 handler 完成（含证据）才可完结；有 blocked 则整体 blocked', async () => {
  const reg = createDeletionRegistry();
  reg.registerModule('media', async () => ({ onlineState: 'completed', backupState: 'completed', evidenceRef: 'ev-media' }));
  reg.registerModule('session', async () => ({ onlineState: 'completed', backupState: 'completed', evidenceRef: 'ev-session' }));
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
  reg.registerModule('session', async () => ({ onlineState: 'completed', backupState: 'completed', evidenceRef: 'ev-session' }));
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
    return { onlineState: 'completed', backupState: 'completed', evidenceRef: 'ev-media' };
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
  reg.registerModule('session', async () => ({ onlineState: 'completed', backupState: 'completed', evidenceRef: 'ev-session' }));
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

// ---- 修复轮 2 · 删除完成证据（缺证据/空白证据不可判定完成） ----

test('R2 报称 completed 但缺 evidenceRef 不记完成（阻塞待验证）', async () => {
  const reg = createDeletionRegistry();
  reg.registerModule('media', async () => ({ onlineState: 'completed', backupState: 'completed' }));
  const req = reg.createDeletionRequest({ generation: 1 });
  await reg.executeHandlers(req.id);
  const row = reg._handlerRows[0];
  assert.equal(row.status, 'blocked');
  assert.equal(row.errorCode, 'EVIDENCE_REQUIRED');
  assert.equal(row.evidenceRef, null);
  assert.equal(reg.completionStatus(req.id).completed, false);
  assert.equal(reg.completionStatus(req.id).state, 'blocked');
});

test('R2 空白（纯空格）evidenceRef 不算证据，不记完成', async () => {
  const reg = createDeletionRegistry();
  reg.registerModule('media', async () => ({ onlineState: 'completed', backupState: 'completed', evidenceRef: '   ' }));
  const req = reg.createDeletionRequest({ generation: 1 });
  await reg.executeHandlers(req.id);
  assert.equal(reg._handlerRows[0].status, 'blocked');
  assert.equal(reg.completionStatus(req.id).completed, false);
});

test('R2 完成证据齐全才记完成', async () => {
  const reg = createDeletionRegistry();
  reg.registerModule('media', async () => ({ onlineState: 'completed', backupState: 'completed', evidenceRef: 'deletion-receipt-abc' }));
  const req = reg.createDeletionRequest({ generation: 1 });
  await reg.executeHandlers(req.id);
  assert.equal(reg._handlerRows[0].status, 'completed');
  assert.equal(reg.completionStatus(req.id).completed, true);
});

test('R2 仅有在线完成（backup 仍在跑）不记完成', async () => {
  const reg = createDeletionRegistry();
  reg.registerModule('media', async () => ({ onlineState: 'completed', backupState: 'running', evidenceRef: 'ev-online' }));
  const req = reg.createDeletionRequest({ generation: 1 });
  await reg.executeHandlers(req.id);
  assert.equal(reg.completionStatus(req.id).completed, false);
});

// ---- 修复轮 2 · 原始错误码不入用户回执（映射到固定安全分类） ----

test('R2 处理器抛出的私密原文错误码被映射到固定安全分类，不进回执', async () => {
  const secret = 'synthetic-private-marker-9c1f';
  const reg = createDeletionRegistry();
  reg.registerModule('media', async () => {
    const err = new Error('upstream failed');
    err.code = secret;
    throw err;
  });
  const req = reg.createDeletionRequest({ generation: 1 });
  await reg.executeHandlers(req.id);
  assert.equal(reg._handlerRows[0].errorCode, 'HANDLER_FAILED');
  const projection = reg.receiptProjection(req.id);
  assert.equal(JSON.stringify(projection).includes(secret), false);
  assert.equal(projection.handlers[0].errorCode, 'HANDLER_FAILED');
});

test('R2 处理器返回的未知 errorCode 也映射到固定安全分类', async () => {
  const reg = createDeletionRegistry();
  reg.registerModule('media', async () => ({
    onlineState: 'blocked',
    backupState: 'blocked',
    errorCode: 'RAW_SDK_TEXT_leak_should_not_appear',
  }));
  const req = reg.createDeletionRequest({ generation: 1 });
  await reg.executeHandlers(req.id);
  assert.equal(reg._handlerRows[0].errorCode, 'HANDLER_FAILED');
  assert.equal(
    JSON.stringify(reg.receiptProjection(req.id)).includes('leak_should_not_appear'),
    false,
  );
});

test('R2 处理器返回非字符串（嵌套/对象）errorCode 被映射到固定安全分类', async () => {
  const reg = createDeletionRegistry();
  reg.registerModule('media', async () => ({
    onlineState: 'blocked',
    backupState: 'blocked',
    errorCode: { nested: 'text', token: 'tk-synthetic' },
  }));
  const req = reg.createDeletionRequest({ generation: 1 });
  await reg.executeHandlers(req.id);
  assert.equal(reg._handlerRows[0].errorCode, 'HANDLER_FAILED');
  const json = JSON.stringify(reg.receiptProjection(req.id));
  assert.equal(json.includes('tk-synthetic'), false);
});

test('R2 处理器抛出的嵌套错误（cause 原文）不外泄', async () => {
  const reg = createDeletionRegistry();
  reg.registerModule('media', async () => {
    const err = new TypeError('outer');
    err.code = undefined;
    err.cause = { body: 'synthetic-private-body', token: 'tk-nested' };
    throw err;
  });
  const req = reg.createDeletionRequest({ generation: 1 });
  await reg.executeHandlers(req.id);
  assert.equal(reg._handlerRows[0].errorCode, 'HANDLER_FAILED');
  const json = JSON.stringify(reg.receiptProjection(req.id));
  assert.equal(json.includes('synthetic-private-body'), false);
  assert.equal(json.includes('tk-nested'), false);
});

test('R2 白名单内的安全错误码按原样保留', async () => {
  const reg = createDeletionRegistry();
  reg.registerModule('media', async () => ({ onlineState: 'blocked', backupState: 'blocked', errorCode: 'STORE_UNREACHABLE' }));
  const req = reg.createDeletionRequest({ generation: 1 });
  await reg.executeHandlers(req.id);
  assert.equal(reg._handlerRows[0].errorCode, 'STORE_UNREACHABLE');
});

// ---- R34 / #22 片C · 在途取消（cancelDeletion + completionStatus 短路） ----

test('在途取消：requested 可取消、revision 递增、completionStatus 短路为 cancelled', () => {
  const reg = createDeletionRegistry();
  reg.registerModule('media', async () => ({ onlineState: 'completed', backupState: 'completed', evidenceRef: 'ev-media' }));
  const req = reg.createDeletionRequest({ generation: 1 });

  const cancelled = reg.cancelDeletion(req.id);
  assert.equal(cancelled.state, 'cancelled');
  assert.ok(cancelled.revision > req.revision, '取消必须递增 revision（强 ETag 随之失效）');
  assert.deepEqual(reg.completionStatus(req.id), { state: 'cancelled', completed: false });

  // 终态 cancelled 不可再取消。
  assert.throws(
    () => reg.cancelDeletion(req.id),
    (error) => error instanceof PrivacyError && error.code === 'OBJECT_UNAVAILABLE',
  );
});

test('在途取消：completed 不可取消；不存在的请求 NOT_FOUND', async () => {
  const reg = createDeletionRegistry();
  reg.registerModule('media', async () => ({ onlineState: 'completed', backupState: 'completed', evidenceRef: 'ev-media' }));
  const req = reg.createDeletionRequest({ generation: 1 });
  await reg.executeHandlers(req.id);
  assert.equal(reg.completionStatus(req.id).completed, true);

  assert.throws(
    () => reg.cancelDeletion(req.id),
    (error) => error instanceof PrivacyError && error.code === 'OBJECT_UNAVAILABLE',
  );
  assert.throws(
    () => reg.cancelDeletion('missing-request-id'),
    (error) => error instanceof PrivacyError && error.code === 'NOT_FOUND',
  );
});
