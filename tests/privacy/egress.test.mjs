/**
 * GY-I27（#29）· 外发消费者（egress consumer）回归。
 *
 * 覆盖 issue #29 验收中「无授权与错用途不能触发实际外发」与「real 未接真实依赖必须 fail-closed：
 * 不得用替身返回成功封套」两条口径。**全部使用注入身份 + 替身传输 + 内存账本**，
 * 不依赖微信真实登录（不读 GY-I04），**不发起任何真实网络请求**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createConsentStore } from '../../packages/privacy/consent.mjs';
import { createExportLedger } from '../../packages/privacy/ledger.mjs';
import { PrivacyError } from '../../packages/privacy/errors.mjs';
import {
  createEgressConsumer,
  createRealEgressTransport,
  createStubEgressTransport,
  listExportsForUser,
  resolveEgressTransport,
  toContractExport,
  STUB_EGRESS_LABEL,
} from '../../packages/privacy/egress.mjs';
import { createAccountProvider, createRecipientStore, VERIFIED_RECIPIENT } from './_fixtures.mjs';

const OBJECT_ID = '00000000-0000-4000-8000-0000000000a1';
const CONTRACT = JSON.parse(readFileSync(new URL('../../packages/contracts/openapi.json', import.meta.url), 'utf8'));
const EXPORT_SCHEMA = CONTRACT.components.schemas.Export;

function setup({ executionMode = 'stub', transport = null, logSink = null } = {}) {
  const account = createAccountProvider({ u1: { state: 'active', authEpoch: 1 } });
  const consentStore = createConsentStore();
  const recipientStore = createRecipientStore({ [VERIFIED_RECIPIENT.id]: VERIFIED_RECIPIENT });
  const ledger = createExportLedger({ consentStore, account, recipientStore });
  const resolved = transport ?? resolveEgressTransport({ executionMode });
  const consumer = createEgressConsumer({ ledger, transport: resolved, executionMode, logSink });
  return { account, consentStore, recipientStore, ledger, transport: resolved, consumer };
}

async function grantVoice(consentStore, userId = 'u1', recipientId = VERIFIED_RECIPIENT.id) {
  for (const purpose of ['recording', 'media_processing', 'external_inference']) {
    await consentStore.grant({ userId, purpose, policyVersion: '1.0.0', recipientIds: [recipientId] });
  }
}

function sendInput(identity = { userId: 'u1', authEpoch: 1 }, extra = {}) {
  return {
    identity,
    objectType: 'transcription',
    objectId: OBJECT_ID,
    objectRevision: 1,
    dataType: 'voice_question',
    purpose: 'external_inference',
    recipientId: VERIFIED_RECIPIENT.id,
    sourceVersion: 'asr-v1',
    payload: { text: '私有转写正文', coordinates: '31.23041,121.47370', token: 'bearer-secret-abc' },
    ...extra,
  };
}

test('无授权：send 抛 CONSENT_REQUIRED，且替身传输零调用、账本零记录', async () => {
  const { consumer, transport, ledger } = setup();
  await assert.rejects(
    () => consumer.send(sendInput()),
    (err) => err instanceof PrivacyError && err.code === 'CONSENT_REQUIRED',
  );
  assert.equal(transport.deliveries.length, 0, '无授权不得触发任何实际外发（零调用）');
  assert.equal(ledger.list({ userId: 'u1' }).items.length, 0, '无授权不得留下外发登记');
});

test('错用途：send 抛 SCOPE_DENIED，且替身传输零调用', async () => {
  const { consumer, consentStore, transport } = setup();
  await consentStore.grant({
    userId: 'u1', purpose: 'public_posting', policyVersion: '1.0.0', recipientIds: [VERIFIED_RECIPIENT.id],
  });
  await assert.rejects(
    () => consumer.send(sendInput({ userId: 'u1', authEpoch: 1 }, { purpose: 'public_posting' })),
    (err) => err instanceof PrivacyError && err.code === 'SCOPE_DENIED',
  );
  assert.equal(transport.deliveries.length, 0, '错用途不得触发任何实际外发（零调用）');
});

test('授权齐全：如实落账 userid/purpose/recipient/source_version，恰一次外发且审计为 sent', async () => {
  const { consumer, consentStore, transport, ledger } = setup();
  await grantVoice(consentStore);

  const receipt = await consumer.send(sendInput());
  assert.equal(receipt.state, 'sent');
  assert.equal(receipt.egress.kind, 'stub');
  assert.equal(receipt.egress.stub, true, '替身必须自报替身');
  assert.equal(transport.deliveries.length, 1, '授权齐全时应恰好外发一次');

  const rows = ledger.list({ userId: 'u1' }).items;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].userId, 'u1');
  assert.equal(rows[0].purpose, 'external_inference');
  assert.equal(rows[0].recipientId, VERIFIED_RECIPIENT.id);
  assert.equal(rows[0].sourceVersion, 'asr-v1');
  assert.equal(rows[0].state, 'sent');
  assert.equal(rows[0].authEpoch, 1);

  assert.deepEqual(
    consumer.audit().map((entry) => [entry.state, entry.purpose, entry.recipientId]),
    [['sent', 'external_inference', VERIFIED_RECIPIENT.id]],
  );
});

test('撤回与任务竞争：撤回后派发被原子边界拒绝（零调用），记录不得被置 sent', async () => {
  const { consumer, consentStore, transport, ledger } = setup();
  await grantVoice(consentStore);
  const reserved = await consumer.reserve({
    userId: 'u1', authEpoch: 1, objectType: 'transcription', objectId: OBJECT_ID, objectRevision: 1,
    dataType: 'voice_question', purpose: 'external_inference', recipientId: VERIFIED_RECIPIENT.id, sourceVersion: 'asr-v1',
  });
  await consentStore.withdraw({ userId: 'u1', purpose: 'external_inference' });

  await assert.rejects(
    () => consumer.dispatch({ exportId: reserved.id, userId: 'u1', payload: { text: 'x' } }),
    (err) => err instanceof PrivacyError && err.code === 'OBJECT_UNAVAILABLE',
  );
  assert.equal(transport.deliveries.length, 0, '撤回后不得触发实际外发（零调用）');
  assert.equal(ledger.get(reserved.id).state, 'reserved', '派发被拒时不得把记录置为 sent');
});

test('注销与任务竞争：auth_epoch 前进后派发被拒（零调用，ACCOUNT_INACTIVE）', async () => {
  const { consumer, consentStore, transport, account } = setup();
  await grantVoice(consentStore);
  const reserved = await consumer.reserve({
    userId: 'u1', authEpoch: 1, objectType: 'transcription', objectId: OBJECT_ID, objectRevision: 1,
    dataType: 'voice_question', purpose: 'external_inference', recipientId: VERIFIED_RECIPIENT.id, sourceVersion: 'asr-v1',
  });
  account.set('u1', { state: 'deletion_pending', authEpoch: 2 });

  await assert.rejects(
    () => consumer.dispatch({ exportId: reserved.id, userId: 'u1', payload: { text: 'x' } }),
    (err) => err instanceof PrivacyError && (err.code === 'ACCOUNT_INACTIVE' || err.code === 'OBJECT_UNAVAILABLE'),
  );
  assert.equal(transport.deliveries.length, 0, '注销后不得触发实际外发（零调用）');
});

test('重复派发被拒（零重复外发）：已 sent 的记录再次 dispatch 不再调用传输', async () => {
  const { consumer, consentStore, transport, ledger } = setup();
  await grantVoice(consentStore);
  const receipt = await consumer.send(sendInput());
  assert.equal(transport.deliveries.length, 1);

  await assert.rejects(
    () => consumer.dispatch({ exportId: receipt.exportId, userId: 'u1', payload: { text: 'x' } }),
    (err) => err instanceof PrivacyError && err.code === 'OBJECT_UNAVAILABLE',
  );
  assert.equal(transport.deliveries.length, 1, '第二次派发不得再次发出数据');
  assert.equal(ledger.get(receipt.exportId).state, 'sent');
});

test('外发失败：账本落 failed + 抛 PROVIDER_UNAVAILABLE(retryable)，绝不写成成功', async () => {
  const failing = Object.freeze({
    kind: 'stub', stub: true, available: true, label: STUB_EGRESS_LABEL, note: '替身',
    unavailableReason: null,
    async send() { throw new Error('替身传输模拟失败（不联网）'); },
  });
  const { consumer, consentStore, ledger } = setup({ transport: failing });
  await grantVoice(consentStore);

  await assert.rejects(
    () => consumer.send(sendInput()),
    (err) => err instanceof PrivacyError && err.code === 'PROVIDER_UNAVAILABLE' && err.retryable === true,
  );
  const rows = ledger.list({ userId: 'u1' }).items;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'failed', '失败必须如实落账，不得写成 sent/succeeded');
  assert.equal(consumer.audit().at(-1).errorCode, 'PROVIDER_UNAVAILABLE');
});

test('结果未知：账本落 outcome_unknown 且 retryable=false（不自动重试/重复计费）', async () => {
  const unknown = Object.freeze({
    kind: 'stub', stub: true, available: true, label: STUB_EGRESS_LABEL, note: '替身',
    unavailableReason: null,
    async send() { throw new PrivacyError('PROVIDER_OUTCOME_UNKNOWN', '结果未知'); },
  });
  const { consumer, consentStore, ledger } = setup({ transport: unknown });
  await grantVoice(consentStore);

  await assert.rejects(
    () => consumer.send(sendInput()),
    (err) => err instanceof PrivacyError && err.code === 'PROVIDER_OUTCOME_UNKNOWN' && err.retryable === false,
  );
  assert.equal(ledger.list({ userId: 'u1' }).items[0].state, 'outcome_unknown');
});

test('real + 未接真实依赖 ⇒ fail-closed：503 PROVIDER_UNAVAILABLE(retryable)、零外发、零账本变更', async () => {
  const { consumer, transport, ledger, consentStore } = setup({ executionMode: 'real' });
  await grantVoice(consentStore);

  assert.equal(consumer.executionMode, 'real');
  assert.equal(consumer.available, false, 'real 未接真实适配器必须自报不可用');
  assert.equal(transport.kind, 'real');
  assert.equal(transport.stub, false, 'real 路径不得是替身');

  await assert.rejects(
    () => consumer.send(sendInput()),
    (err) => {
      assert.ok(err instanceof PrivacyError);
      assert.equal(err.code, 'PROVIDER_UNAVAILABLE');
      assert.equal(err.status, 503, '契约 error_status_map：503');
      assert.equal(
        err.retryable,
        false,
        '未接真实依赖＝能力未装配（需运维接线），同一请求重试不会成功 ⇒ retryable 必须为 false（口径见 services/api/src/errors.ts）',
      );
      return true;
    },
  );
  assert.equal(ledger.list({ userId: 'u1' }).items.length, 0, 'fail-closed 时不得留下外发登记（更不得置 sent）');
});

test('real + 显式放行 + 已审适配器 ⇒ 走真实传输（测试内替身适配器，不代表真实第三方已接入）', async () => {
  const calls = [];
  const adapter = {
    async send(entry) { calls.push(entry.exportId); return { transportRef: 'approved-adapter-ref', note: '测试内适配器' }; },
  };
  const approved = createRealEgressTransport({ adapter });
  const { consumer, consentStore, ledger } = setup({
    executionMode: 'real',
    transport: resolveEgressTransport({ executionMode: 'real', realTransport: approved, realTransportApproved: true }),
  });
  await grantVoice(consentStore);

  assert.equal(consumer.available, true);
  const receipt = await consumer.send(sendInput());
  assert.equal(receipt.egress.kind, 'real');
  assert.equal(receipt.egress.stub, false);
  assert.equal(calls.length, 1, '显式放行后恰好派发一次');
  assert.equal(ledger.list({ userId: 'u1' }).items[0].state, 'sent');
});

test('模式与传输不匹配 ⇒ 构造期拒绝（替身不得冒充真实，真实不得出现在替身/演示模式）', async () => {
  const { ledger, consentStore } = setup();
  await grantVoice(consentStore);
  const stub = createStubEgressTransport({ executionMode: 'stub' });
  const real = createRealEgressTransport({ adapter: { async send() { return {}; } } });

  assert.throws(
    () => createEgressConsumer({ ledger, transport: stub, executionMode: 'real' }),
    /模式与执行模式不一致/,
  );
  assert.throws(
    () => createEgressConsumer({ ledger, transport: real, executionMode: 'stub' }),
    /模式与执行模式不一致/,
  );
  assert.throws(
    () => resolveEgressTransport({ executionMode: 'stub', realTransport: real, realTransportApproved: true }),
    /不得注入真实外发传输/,
  );
  assert.throws(() => resolveEgressTransport({ executionMode: 'preset_demo', realTransport: real }), /不得注入真实外发传输/);
});

test('替身传输带明确标注（label/note 明写替身），不回执为真实', async () => {
  const { consumer, consentStore } = setup({ executionMode: 'preset_demo' });
  await grantVoice(consentStore);
  const receipt = await consumer.send(sendInput());
  assert.match(consumer.label, /替身|预设演示/);
  assert.match(consumer.label, /预设演示/);
  assert.match(String(receipt.note), /替身/);
  assert.equal(receipt.egress.stub, true);
});

test('日志脱敏：私有正文/精确坐标/凭据不进审计轨迹与日志出口', async () => {
  const sink = [];
  const { consumer, consentStore, transport } = setup({ logSink: (entry) => sink.push(entry) });
  await grantVoice(consentStore);

  const secretText = '私有转写正文·水稻田稗草三叶期，我家地在东经121.47370北纬31.23041';
  await consumer.send(sendInput(undefined, {
    payload: {
      text: secretText,
      transcription: secretText,
      image: `data:image/png;base64,${'A'.repeat(160)}`,
      coordinates: '31.23041,121.47370',
      lat: 31.23041,
      lng: 121.47370,
      access_token: 'bearer-secret-abc',
      providerRequestRefCipher: 'cipher-ref-xyz',
    },
  }));

  const dumped = JSON.stringify({ audit: consumer.audit(), sink, deliveries: transport.deliveries });
  for (const forbidden of [
    secretText, '31.23041', '121.47370', 'bearer-secret-abc', 'cipher-ref-xyz', 'data:image/png', 'A'.repeat(120),
  ]) {
    assert.equal(dumped.includes(forbidden), false, `日志/审计不得包含：${forbidden.slice(0, 32)}`);
  }
  // 非敏感维度仍如实留痕（可追溯）。
  assert.equal(consumer.audit()[0].recipientId, VERIFIED_RECIPIENT.id);
  assert.equal(consumer.audit()[0].sourceVersion, 'asr-v1');
});

test('账本读面：契约 Export 形状 + keyset 游标分页；畸形游标抛 INVALID_CURSOR', async () => {
  const { consumer, consentStore, ledger } = setup();
  await grantVoice(consentStore);
  for (let index = 0; index < 3; index += 1) {
    await consumer.send(sendInput(undefined, { objectId: OBJECT_ID, sourceVersion: `asr-v${index}` }));
  }
  // 另一个用户的外发不得出现在本用户读面（归属隔离）。
  await consentStore.grant({ userId: 'u2', purpose: 'external_inference', policyVersion: '1.0.0', recipientIds: [VERIFIED_RECIPIENT.id] });

  const page1 = await listExportsForUser(ledger, { userId: 'u1', limit: 2 });
  assert.equal(page1.items.length, 2);
  assert.equal(typeof page1.next_cursor, 'string');

  const page2 = await listExportsForUser(ledger, { userId: 'u1', limit: 2, cursor: page1.next_cursor });
  assert.equal(page2.items.length, 1);
  assert.equal(page2.next_cursor, null);

  const ids = new Set([...page1.items, ...page2.items].map((item) => item.id));
  assert.equal(ids.size, 3, '分页不得重复或漏条');

  const required = EXPORT_SCHEMA.required;
  const allowed = Object.keys(EXPORT_SCHEMA.properties);
  for (const item of page1.items) {
    assert.deepEqual(Object.keys(item).sort(), [...required].sort(), '契约 Export 必填字段必须齐全');
    for (const key of Object.keys(item)) assert.ok(allowed.includes(key), `契约外字段：${key}`);
    assert.ok(EXPORT_SCHEMA.properties.state.enum.includes(item.state));
    assert.deepEqual(Object.keys(item.object_ref).sort(), ['id', 'revision', 'type']);
    assert.equal(typeof item.object_ref.revision, 'number');
    assert.equal(item.sent_at, new Date(item.sent_at).toISOString());
  }

  // 负例保持在同一断言强度上：畸形游标 / 越界 limit 仍必须被拒（接口 async 化不改变判定）。
  await assert.rejects(
    () => listExportsForUser(ledger, { userId: 'u1', cursor: 'not-a-cursor' }),
    (err) => err.code === 'INVALID_CURSOR',
  );
  await assert.rejects(
    () => listExportsForUser(ledger, { userId: 'u1', limit: 500 }),
    (err) => err.code === 'INVALID_REQUEST',
  );
  await assert.rejects(
    () => listExportsForUser(ledger, { userId: '', limit: 1 }),
    (err) => err.code === 'SESSION_REQUIRED',
  );
});

test('契约形状不符的账本记录：宁可报 PROVIDER_UNAVAILABLE，也不输出自相矛盾条目', async () => {
  const { consumer, consentStore, ledger } = setup();
  await grantVoice(consentStore);
  const receipt = await consumer.send(sendInput());
  const record = ledger.get(receipt.exportId);
  assert.equal(toContractExport(record).state, 'sent');
  assert.throws(
    () => toContractExport({ ...record, state: 'succeeded' }),
    (err) => err instanceof PrivacyError && err.code === 'PROVIDER_UNAVAILABLE',
  );
  assert.throws(
    () => toContractExport({ ...record, objectRevision: 0 }),
    (err) => err instanceof PrivacyError && err.code === 'PROVIDER_UNAVAILABLE',
  );
});
