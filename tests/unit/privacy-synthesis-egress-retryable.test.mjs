/**
 * GY-I27（#29）／GY-I22 · 合成域外发账本接线 · 「缺真实 TTS 凭据」的 retryable 口径回归。
 *
 * 钉住一条口径：`real` 且真实 TTS 传输未接入（缺真实凭据）⇒ 受理前 fail-closed：
 * 503 `PROVIDER_UNAVAILABLE` **且 `retryable === false`** —— 未接线／缺凭据属配置类，
 * 需运维改配置，同一请求反复重试不会自愈（口径原文见 `services/api/src/errors.ts:32/:35`；
 * 同构域 `services/api/src/privacy/task-egress.ts:91-92`、
 * `packages/privacy/egress.mjs:116-117` 亦为 false）。
 *
 * 零端口注入、零网络、零账本变更：本用例只触达「受理前」那一段。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSynthesisEgress } from '../../services/api/src/privacy/synthesis-egress.ts';
import { PrivacyError, toErrorEnvelope } from '../../packages/privacy/errors.mjs';

const USER_ID = '00000000-0000-4000-8000-00000000b001';
const PROVIDER_REASON = '缺少真实 TTS 供应商凭据（fail-closed，不回退替身）';

/**
 * 缺凭据必须在**任何**账本/正文端口调用之前就被拒绝 ⇒ 端口一旦被触达，用例即判失败
 * （同时记录触达点，便于失败时定位是哪一步越过了 fail-closed）。
 */
function buildEgress({ executionMode = 'real', available = false, unavailableReason = null } = {}) {
  const touched = [];
  const trip = (label) => () => {
    touched.push(label);
    throw new Error(`不应触达 ${label}：缺真实凭据必须在任何账本变更之前 fail-closed`);
  };
  const ledger = {
    findReservedByObject: trip('ledger.findReservedByObject'),
    resolveRecipient: trip('ledger.resolveRecipient'),
    reserve: trip('ledger.reserve'),
    linkJob: trip('ledger.linkJob'),
    markSent: trip('ledger.markSent'),
    markFailed: trip('ledger.markFailed'),
  };
  const inFlight = {
    assertExecutable: trip('inFlight.assertExecutable'),
    saveResult: trip('inFlight.saveResult'),
  };
  const content = { read: trip('content.read') };
  const egress = createSynthesisEgress({ ledger, inFlight, executionMode, content, capability: 'tts' });
  // 真实传输未接入：提供者自报不可用（`app.ts:887` 装配时同样经 `provider()` 捕获可用性）。
  egress.provider({ available, unavailableReason });
  return { egress, touched };
}

const reserveInput = () => ({
  userId: USER_ID,
  authEpoch: 1,
  contentType: 'answer',
  contentId: 'answer_0001',
  contentRevision: 1,
});

test('缺真实 TTS 凭据：real 受理前 503 PROVIDER_UNAVAILABLE 且 retryable=false（不可重试），零账本变更', async () => {
  const { egress, touched } = buildEgress({ available: false, unavailableReason: PROVIDER_REASON });
  assert.equal(egress.engaged, true, '只有 real 才接管派发');

  await assert.rejects(
    () => egress.withOwner(USER_ID).reserveForAcceptance(reserveInput()),
    (err) => {
      assert.ok(err instanceof PrivacyError);
      assert.equal(err.code, 'PROVIDER_UNAVAILABLE');
      assert.equal(err.status, 503, '契约 error_status_map：PROVIDER_UNAVAILABLE ⇒ 503');
      assert.equal(err.message, PROVIDER_REASON, '如实回传提供者给出的不可用原因');
      assert.equal(
        err.retryable,
        false,
        '缺真实凭据＝配置类（需运维改配置，时间不解决）⇒ retryable 必须为 false（口径见 services/api/src/errors.ts:32/:35）',
      );
      // 产品 HTTP 层直接投影该字段（`packages/privacy/errors.mjs` 的 toErrorEnvelope）⇒ 封套同样不得自称可重试。
      assert.equal(toErrorEnvelope(err).error.retryable, false);
      return true;
    },
  );
  assert.equal(touched.length, 0, `fail-closed 必须发生在任何账本/正文端口调用之前（实际触达：${touched.join('、')}）`);
});

test('对照臂：同一实例在「提供者可用」时不会误报 503（分支只因缺凭据而 fail-closed）', async () => {
  const { egress, touched } = buildEgress({ available: true, unavailableReason: null });

  await assert.rejects(
    () => egress.withOwner(USER_ID).reserveForAcceptance(reserveInput()),
    (err) => {
      assert.ok(err instanceof PrivacyError);
      assert.equal(err.code, 'OBJECT_UNAVAILABLE', '不是「缺凭据」分支，而是后续读快照那一刻的既有拒绝');
      assert.notEqual(err.status, 503);
      return true;
    },
  );
  assert.deepEqual(touched, ['content.read'], '可用时才会走到读快照（说明上一臂的零触达是真 fail-closed）');
});
