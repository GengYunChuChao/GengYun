/**
 * GY-I27 第三片：**契约外第二资料维度**（非媒体外发，合成域朗读）的语义钉子。
 *
 * 为什么必须有这个文件：
 *   - 冻结契约的 `MediaPurpose` 只含四类媒体资料，合成域（TTS）不在其中；给 `MEDIA_PURPOSES`
 *     加成员会立刻打红 `tests/privacy/contract.test.mjs:28` 的 deepEqual ⇒ 第二维度必须**契约外**新增；
 *   - 第二维度**只要求最小必需用途集合** `['external_inference']`：若复用媒体维（例如借用
 *     `voice_question` 的必需集合），只授 `external_inference` 的账号会被多索要 `recording`
 *     ⇒ 合法朗读被 `CONSENT_REQUIRED` 拒。本文件把「不得要求 recording」写成断言钉住；
 *   - 同时钉住**媒体维逐字未变**（第二维度不得反向放宽或改动媒体维的任何一项）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MEDIA_PURPOSES,
  MEDIA_PURPOSE_REQUIRED_CONSENTS,
  NON_MEDIA_DATA_TYPES,
  NON_MEDIA_REQUIRED_CONSENTS,
  isKnownDataType,
  requiredConsentsForDataType,
} from '../../packages/privacy/constants.mjs';
import { createPrivacyGuard } from '../../packages/privacy/guard.mjs';
import { createConsentStore } from '../../packages/privacy/consent.mjs';
import { createExportLedger } from '../../packages/privacy/ledger.mjs';
import { PrivacyError } from '../../packages/privacy/errors.mjs';
import { createAccountProvider, createRecipientStore, VERIFIED_RECIPIENT } from './_fixtures.mjs';

/** 合成域接收方：能力 `tts`（`0003` 的 capability 闭集已含它）。 */
const TTS_RECIPIENT = Object.freeze({
  ...VERIFIED_RECIPIENT,
  id: 'provider-tts',
  display_name: 'TTS Provider',
  capability: 'tts',
});

async function setup() {
  const account = createAccountProvider({ u1: { state: 'active', authEpoch: 1 } });
  const consentStore = createConsentStore();
  const recipientStore = createRecipientStore({ [TTS_RECIPIENT.id]: TTS_RECIPIENT });
  const ledger = createExportLedger({ consentStore, account, recipientStore });
  const guard = createPrivacyGuard({ consentStore, account });
  return { account, consentStore, ledger, guard };
}

async function grant(consentStore, purposes, recipientId = TTS_RECIPIENT.id, userId = 'u1') {
  for (const p of purposes) {
    await consentStore.grant({ userId, purpose: p, policyVersion: '1.0.0', recipientIds: [recipientId] });
  }
}

/** 非媒体外发（合成域）：对象标识是**文本键**，不是 uuid。 */
const baseCheckedContentExport = {
  userId: 'u1',
  authEpoch: 1,
  objectType: 'checked_content',
  objectKey: 'answer:sample-i27-approved',
  objectRevision: 1,
  dataType: 'checked_content',
  purpose: 'external_inference',
  recipientId: TTS_RECIPIENT.id,
  sourceVersion: null,
};

test('第二维度只要求 external_inference（不得把 recording / media_processing 一并索要）', () => {
  assert.deepEqual(NON_MEDIA_DATA_TYPES, ['checked_content']);
  assert.deepEqual(NON_MEDIA_REQUIRED_CONSENTS, { checked_content: ['external_inference'] });
  assert.deepEqual(requiredConsentsForDataType('checked_content'), ['external_inference']);
  assert.equal(requiredConsentsForDataType('checked_content').includes('recording'), false, '第二维度不得要求 recording');
  assert.equal(requiredConsentsForDataType('checked_content').includes('media_processing'), false, '第二维度不得要求 media_processing');
  assert.equal(isKnownDataType('checked_content'), true);
  // `tts` 是**接收方能力**，不是资料类型：不得被当成已知资料类型放行。
  assert.equal(requiredConsentsForDataType('tts'), null);
  assert.equal(isKnownDataType('tts'), false);
  assert.equal(isKnownDataType(undefined), false);
});

test('媒体维逐字未变（第二维度不得改动 MEDIA_PURPOSES 与各媒体类型的必需用途集合）', () => {
  assert.deepEqual(MEDIA_PURPOSES, ['weed_recognition', 'label_ocr', 'voice_question', 'community_image']);
  assert.deepEqual(MEDIA_PURPOSE_REQUIRED_CONSENTS, {
    weed_recognition: ['media_processing', 'external_inference'],
    label_ocr: ['media_processing', 'external_inference'],
    voice_question: ['recording', 'media_processing', 'external_inference'],
    community_image: ['media_processing', 'public_posting', 'external_inference'],
  });
  for (const mediaType of MEDIA_PURPOSES) {
    assert.deepEqual(
      requiredConsentsForDataType(mediaType),
      MEDIA_PURPOSE_REQUIRED_CONSENTS[mediaType],
      `媒体类型 ${mediaType} 的必需用途集合必须逐字不变`,
    );
    assert.equal(isKnownDataType(mediaType), true);
  }
});

test('未知资料类型仍逐字拒 SCOPE_DENIED（内存参考实现）', async () => {
  const { ledger, consentStore } = await setup();
  await grant(consentStore, ['external_inference']);
  await assert.rejects(
    () => ledger.reserve({ ...baseCheckedContentExport, dataType: 'tts' }),
    (err) => err instanceof PrivacyError && err.code === 'SCOPE_DENIED' && /未知资料类型：tts/.test(err.message),
  );
  await assert.rejects(
    () => ledger.reserve({ ...baseCheckedContentExport, dataType: undefined }),
    (err) => err instanceof PrivacyError && err.code === 'SCOPE_DENIED' && /未知资料类型：undefined/.test(err.message),
  );
});

test('非媒体维：只授 external_inference 即可受理（不因媒体维而多要 recording）', async () => {
  const { ledger, consentStore } = await setup();
  await grant(consentStore, ['external_inference']);
  const record = await ledger.reserve(baseCheckedContentExport);
  assert.equal(record.state, 'reserved');
  assert.equal(record.purpose, 'external_inference');
  assert.equal(record.objectType, 'checked_content');
  assert.equal(record.objectId, baseCheckedContentExport.objectKey, '非媒体维用文本键承载对象标识');
  assert.deepEqual(Object.keys(record.requiredConsents), ['external_inference'], '快照只冻结外部推理这一项用途');
});

test('非媒体维：只授媒体用途（recording + media_processing）不足以受理', async () => {
  const { ledger, consentStore } = await setup();
  await grant(consentStore, ['recording', 'media_processing']);
  await assert.rejects(
    () => ledger.reserve(baseCheckedContentExport),
    (err) => err instanceof PrivacyError && err.code === 'CONSENT_REQUIRED' && /缺少用途授权：external_inference/.test(err.message),
  );
});

test('非媒体维：错用途仍拒 SCOPE_DENIED（逐字文案不变）', async () => {
  const { ledger, consentStore } = await setup();
  await grant(consentStore, ['external_inference', 'media_processing']);
  await assert.rejects(
    () => ledger.reserve({ ...baseCheckedContentExport, purpose: 'media_processing' }),
    (err) =>
      err instanceof PrivacyError &&
      err.code === 'SCOPE_DENIED' &&
      /用途 media_processing 与资料类型 checked_content 不匹配（错用途）/.test(err.message),
  );
});

test('非媒体维必须用文本键：object_id 与 object_key 恰好给一个', async () => {
  const { ledger, consentStore } = await setup();
  await grant(consentStore, ['external_inference']);
  const uuid = '00000000-0000-4000-8000-0000000000ff';
  await assert.rejects(
    () => ledger.reserve({ ...baseCheckedContentExport, objectKey: undefined, objectId: uuid }),
    (err) => err instanceof PrivacyError && err.code === 'INVALID_REQUEST',
  );
  await assert.rejects(
    () => ledger.reserve({ ...baseCheckedContentExport, objectId: uuid }),
    (err) => err instanceof PrivacyError && err.code === 'INVALID_REQUEST',
  );
  await assert.rejects(
    () => ledger.reserve({ ...baseCheckedContentExport, objectKey: undefined }),
    (err) => err instanceof PrivacyError && err.code === 'INVALID_REQUEST',
  );
  await assert.rejects(
    () => ledger.reserve({ ...baseCheckedContentExport, objectKey: 'has space' }),
    (err) => err instanceof PrivacyError && err.code === 'INVALID_REQUEST',
  );
});

test('媒体维仍必须 uuid：给 object_key 不得放行（既有口径未被放宽）', async () => {
  const { ledger, consentStore } = await setup();
  await grant(consentStore, ['recording', 'media_processing', 'external_inference'], VERIFIED_RECIPIENT.id);
  await assert.rejects(
    () =>
      ledger.reserve({
        userId: 'u1',
        authEpoch: 1,
        objectType: 'media',
        objectKey: 'voice_question:1',
        objectRevision: 1,
        dataType: 'voice_question',
        purpose: 'external_inference',
        recipientId: VERIFIED_RECIPIENT.id,
        sourceVersion: null,
      }),
    (err) => err instanceof PrivacyError && err.code === 'INVALID_REQUEST',
  );
});

test('guard：dataType=checked_content 只核 external_inference（不再索要 recording）', async () => {
  const { guard, consentStore } = await setup();
  await grant(consentStore, ['external_inference']);
  const result = await guard.requireConsent({ purpose: 'external_inference', dataType: 'checked_content' })({
    userId: 'u1',
    authEpoch: 1,
  });
  assert.equal(result.purpose, 'external_inference');
  assert.equal(result.consentEpoch >= 1, true);
  await assert.rejects(
    () => guard.assertConsent({ userId: 'u1', purpose: 'external_inference', dataType: 'tts' }),
    (err) => err instanceof PrivacyError && err.code === 'SCOPE_DENIED' && /未知资料类型：tts/.test(err.message),
  );
});

test('guard：只授媒体用途不能代替第二维度的 external_inference 授权', async () => {
  const { guard, consentStore } = await setup();
  await grant(consentStore, ['recording', 'media_processing']);
  await assert.rejects(
    () => guard.requireConsent({ purpose: 'external_inference', dataType: 'checked_content' })({ userId: 'u1', authEpoch: 1 }),
    (err) => err instanceof PrivacyError && err.code === 'CONSENT_REQUIRED' && /缺少用途授权：external_inference/.test(err.message),
  );
});
