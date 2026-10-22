/**
 * GY-I10（#10）· 登记**精确**核对 + 冲突阻断用量 + 校正台账，走**真实服务链路**
 * （内存 store + 替身提供者 + 替身/注入登记库）。
 *
 * 本文件钉死三条验收面，每条都配一个「改坏一行必红」的负控制：
 *   1) 同名不同制剂**不得静默匹配**：证号精确命中 003 但剂型写的是 004 的 ⇒ `conflict`，
 *      用量端口**一次都不被调用**、`dose_cards` 为空（`REGISTRATION_CONFLICT`）。
 *   2) 四类明确状态各收敛到稳定码：`no_match` → `REGISTRATION_NOT_FOUND`、
 *      `ambiguous` → `REGISTRATION_AMBIGUOUS`、`conflict` → `REGISTRATION_CONFLICT`、
 *      来源失效 → `REGISTRATION_EXPIRED`；四类都**不取用量候选**。
 *   3) 校正只追加台账、原文不可覆盖、核对不得擦掉台账，且 HTTP 投影严格五字段。
 *
 * 用量端口注入的是一张**契约合法的可信候选**（`doseCandidateFor003`）：只有它能证明
 * 「门真的会开」（matched 面放行 1 张），「门真的挡住了」（冲突面 0 张 + 端口零调用）才有意义。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

import { STUB_IDEMPOTENCY_HMAC_KEY } from '../../services/api/src/auth/service.ts';
import { createOcrService } from '../../services/api/src/ocr/service.ts';
import { createMemoryOcrStore } from '../../services/api/src/ocr/store.ts';
import { createOcrProvider } from '../../services/api/src/ocr/provider.ts';
import { createSubstituteMediaPort } from '../../services/api/src/ocr/media.ts';
import {
  SUBSTITUTE_REGISTRY,
  createSubstituteDosePort,
  createSubstituteReferencePort,
} from '../../services/api/src/ocr/reference.ts';
import { deriveOcrVerdict } from '../../services/api/src/ocr/state.ts';

const HMAC_KEY = STUB_IDEMPOTENCY_HMAC_KEY ?? 'gengyun-stub-idempotency-hmac-key';
const USER = 'user-owner-0001';

const DOSE_CONDITIONS_SAMPLE = {
  crop_id: 'rice',
  region_code: '330100',
  species_id: 'species_barnyardgrass',
  growth_stage: '3-5叶期',
  planting_method: '移栽',
  use_scene: '水稻田',
};

const VERIFICATION_KEYS = ['conflict_fields', 'dose_cards', 'match_state', 'missing_fields', 'registration'];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** 替身登记库里的记录（003 悬浮剂 / 004 水分散粒剂，两者共用同一个产品名）。 */
function registryRecord(registrationNumber) {
  const found = SUBSTITUTE_REGISTRY.find((item) => item.formulation.registration_number === registrationNumber);
  assert.ok(found, `替身登记库缺少 ${registrationNumber}`);
  return clone(found);
}

/** 注入登记库：按证号精确返回候选（与 `createSubstituteReferencePort` 同口径）。 */
function injectedReferencePort(records) {
  return {
    kind: 'substitute',
    note: '测试注入：内存登记库（非生产装配）',
    available: true,
    unavailableReason: null,
    async lookup({ registrationNumber }) {
      const key = typeof registrationNumber === 'string' ? registrationNumber.trim().toLowerCase() : null;
      if (key === null || key.length === 0) return { status: 'available', candidates: [] };
      const exact = records.filter((item) => item.formulation.registration_number.toLowerCase() === key);
      return { status: 'available', candidates: clone(exact) };
    },
  };
}

/**
 * 构造一张**测试注入、契约合法、来源可信**的用量卡候选，绑定 003 的制剂。
 * 这是测试夹具（生产替身端口恒返回空候选）：它让「门真的会开」与「门被绕过」都可观测。
 */
function doseCandidateFor003() {
  const formulation = registryRecord('PD20210003').formulation;
  const conditions = { ...DOSE_CONDITIONS_SAMPLE };
  const originalText = '测试注入·登记标签原文用量：防除稗草，按登记标签标注的制剂用量与施药方法使用。';
  const locator = '测试注入·标签「使用技术与使用方法」第 1 段';
  return {
    card: {
      id: '55555555-5555-4555-8555-555555555555',
      revision: 1,
      formulation,
      conditions,
      original_text: originalText,
      unit_text: '毫升/亩',
      method_text: '测试注入·定向喷雾，避免药液漂移到邻近敏感作物。',
      precautions_text: '测试注入·注意事项。',
      source: {
        id: 'bbbbbbbb-0000-4000-8000-000000000001',
        version: 'test-injected-1',
        title: '测试注入用量登记资料',
        url: 'https://example.invalid/test-injected/dose',
        publisher: '测试注入本地用量库',
        source_kind: 'database',
        evidence_kind: 'mixed',
        validity: 'valid',
        review_status: 'verified',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      locator,
      content_hash: createHash('sha256')
        .update(`${originalText}\u0000${locator}\u0000${formulation.registration_number}`, 'utf8')
        .digest('hex'),
    },
    formulation_registration_number: formulation.registration_number,
    conditions,
    source_kind: 'database',
    validity: 'valid',
    review_status: 'verified',
    simulated: false,
  };
}

/** 计数用量端口：记录「被调用了几次」，并返回注入候选。 */
function countingDosePort(candidates = []) {
  const calls = [];
  return {
    calls,
    port: {
      kind: 'unwired',
      note: '测试注入：计数端口（非生产装配）',
      async listCandidates(input) {
        calls.push(input.registrationNumber);
        return candidates;
      },
    },
  };
}

function boot(overrides = {}) {
  const store = createMemoryOcrStore();
  const service = createOcrService({
    store,
    provider: createOcrProvider({ executionMode: 'stub' }),
    media: createSubstituteMediaPort(),
    reference: overrides.reference ?? createSubstituteReferencePort(),
    dose: overrides.dose ?? createSubstituteDosePort(),
    idempotencyHmacKey: HMAC_KEY,
  });
  return { store, service };
}

const bucketCache = new Map();
function mediaIdForBucket(bucket) {
  if (bucketCache.has(bucket)) return bucketCache.get(bucket);
  for (let attempt = 0; attempt < 500000; attempt += 1) {
    const candidate = randomUUID();
    if (createHash('sha256').update(candidate).digest()[0] % 6 === bucket) {
      bucketCache.set(bucket, candidate);
      return candidate;
    }
  }
  throw new Error(`未能找到分桶 ${bucket} 的媒体 uuid`);
}

let keyCounter = 0;
function nextKey() {
  keyCounter += 1;
  return `ocr-i10-key-${String(keyCounter).padStart(6, '0')}`;
}

async function createAndSettle(service, options = {}) {
  const mediaId = options.mediaId ?? mediaIdForBucket(options.bucket ?? 0);
  const { job } = await service.createOcr({
    userId: USER,
    body: { media_id: mediaId, media_revision: 1 },
    idempotencyKey: options.idempotencyKey ?? nextKey(),
  });
  await service.settle();
  const settled = await service.getJob({ userId: USER, jobId: job.id });
  return { job, ocr: settled.result === null ? null : settled.result.value };
}

/** 提交一次核对（任意字段 + 完整条件），返回 `{ verification, revision }`。 */
async function verify(service, ocrId, fields, options = {}) {
  const current = await service.getOcr({ userId: USER, ocrId });
  return service.verifyOcrWithRevision({
    userId: USER,
    ocrId,
    body: { fields, conditions: options.conditions ?? DOSE_CONDITIONS_SAMPLE },
    ifMatch: `"${current.revision}"`,
    idempotencyKey: nextKey(),
  });
}

/** 003 自己的标签字段（精确命中面）。 */
function labelOf003(overrides = {}) {
  const record = registryRecord('PD20210003');
  return {
    registration_number: record.formulation.registration_number,
    name: '替身示例复配歧义剂',
    ingredients: record.formulation.ingredients.map((item) => ({ ...item })),
    dosage_form: record.formulation.dosage_form,
    ...overrides,
  };
}

// ---------------------------------------------------------------- 同名不同制剂：不得静默匹配

test('反例·同名不同制剂（003 证号 + 004 剂型）必须 conflict，且用量端口一次都不被调用', async () => {
  const { calls, port } = countingDosePort([doseCandidateFor003()]);
  const { service } = boot({ dose: port });
  const { ocr } = await createAndSettle(service);
  // 只统计「核对阶段」的取数：受理时的初次扫描也会走同一端口，先清零基线。
  calls.length = 0;

  const label = labelOf003({ dosage_form: registryRecord('PD20210004').formulation.dosage_form });
  assert.notEqual(label.dosage_form, registryRecord('PD20210003').formulation.dosage_form, '前提：剂型确实不同');

  const verified = await verify(service, ocr.id, label);
  const verification = verified.verification;

  assert.equal(verification.match_state, 'conflict', '同名不同制剂不得静默 matched');
  assert.ok(
    verification.conflict_fields.includes('dosage_form'),
    `冲突字段应含 dosage_form，实际 ${JSON.stringify(verification.conflict_fields)}`,
  );
  assert.deepEqual(verification.dose_cards, [], '冲突时不得下发用量卡');
  assert.equal(calls.length, 0, `冲突时用量端口不得被调用，实际调用 ${JSON.stringify(calls)}`);

  const verdict = deriveOcrVerdict(verification);
  assert.equal(verdict.code, 'REGISTRATION_CONFLICT');
  assert.equal(verdict.dose_blocked, true);
  assert.equal(verdict.block_reason, 'REGISTRATION_FIELD_CONFLICT');
});

test('正例·003 自己的完整字段精确命中 ⇒ matched，用量端口恰好被调用一次并放行 1 张卡', async () => {
  const { calls, port } = countingDosePort([doseCandidateFor003()]);
  const { service } = boot({ dose: port });
  const { ocr } = await createAndSettle(service);
  calls.length = 0;

  const verified = await verify(service, ocr.id, labelOf003());
  assert.equal(verified.verification.match_state, 'matched');
  assert.deepEqual(verified.verification.conflict_fields, []);
  assert.equal(verified.verification.registration.formulation.registration_number, 'PD20210003');
  assert.deepEqual(calls, ['PD20210003'], '只有在 matched 面才取用量候选，且用精确证号');
  assert.equal(
    verified.verification.dose_cards.length,
    1,
    'matched + 注入可信候选 ⇒ 门必须放行（否则「冲突被挡住」证明不了挡住了什么）',
  );
  assert.equal(verified.verification.dose_cards[0].formulation.registration_number, 'PD20210003');
});

// ---------------------------------------------------------------- 四类明确状态

test('四类明确状态·无匹配：证号/名称都不存在 ⇒ no_match + REGISTRATION_NOT_FOUND，不取用量', async () => {
  const { calls, port } = countingDosePort([doseCandidateFor003()]);
  const { service } = boot({ dose: port });
  const { ocr } = await createAndSettle(service);
  calls.length = 0;

  const verified = await verify(service, ocr.id, {
    registration_number: 'PD99999999',
    name: '查无此名的制剂',
    ingredients: [{ name: '草甘膦', content_text: '41', unit_text: '%' }],
    dosage_form: '水剂',
  });
  assert.equal(verified.verification.match_state, 'no_match');
  assert.equal(verified.verification.registration, null);
  assert.equal(deriveOcrVerdict(verified.verification).code, 'REGISTRATION_NOT_FOUND');
  assert.equal(calls.length, 0);
});

test('四类明确状态·多结果：同名两条且证号读错 ⇒ ambiguous，不得擅自挑一条', async () => {
  const { calls, port } = countingDosePort([doseCandidateFor003()]);
  const { service } = boot({ dose: port });
  const { ocr } = await createAndSettle(service);
  calls.length = 0;

  const verified = await verify(service, ocr.id, labelOf003({ registration_number: 'PD2021000X' }));
  assert.equal(verified.verification.match_state, 'ambiguous');
  assert.equal(verified.verification.registration, null, 'ambiguous 不得带出任何一条候选当结论');
  const verdict = deriveOcrVerdict(verified.verification);
  assert.equal(verdict.code, 'REGISTRATION_AMBIGUOUS');
  assert.equal(verdict.block_reason, 'SAME_NAME_MULTIPLE_REGISTRATIONS');
  assert.equal(calls.length, 0);
});

test('四类明确状态·已失效：来源 validity=expired ⇒ conflict 且稳定码升级为 REGISTRATION_EXPIRED', async () => {
  const expired = registryRecord('PD20210003');
  expired.source = { ...expired.source, validity: 'expired' };
  const { calls, port } = countingDosePort([doseCandidateFor003()]);
  const { service } = boot({ reference: injectedReferencePort([expired]), dose: port });
  const { ocr } = await createAndSettle(service);
  calls.length = 0;

  const verified = await verify(service, ocr.id, labelOf003());
  assert.equal(verified.verification.match_state, 'conflict');
  assert.ok(
    verified.verification.conflict_fields.includes('source.validity'),
    `冲突字段应含 source.validity，实际 ${JSON.stringify(verified.verification.conflict_fields)}`,
  );
  assert.equal(deriveOcrVerdict(verified.verification).code, 'REGISTRATION_EXPIRED');
  assert.equal(calls.length, 0, '已失效不得取用量候选');
  assert.deepEqual(verified.verification.dose_cards, []);
});

test('四类明确状态·未接线登记库 ⇒ unavailable（不得降级成 no_match）', async () => {
  const unavailable = {
    kind: 'unwired',
    note: '测试注入：不可用登记库',
    available: false,
    unavailableReason: '真实登记库尚未接线',
    async lookup() {
      return { status: 'unavailable', reason: '真实登记库尚未接线' };
    },
  };
  const { calls, port } = countingDosePort([doseCandidateFor003()]);
  const { service } = boot({ reference: unavailable, dose: port });
  const { ocr } = await createAndSettle(service);
  calls.length = 0;

  const verified = await verify(service, ocr.id, labelOf003());
  assert.equal(verified.verification.match_state, 'unavailable');
  assert.notEqual(verified.verification.match_state, 'no_match');
  assert.equal(deriveOcrVerdict(verified.verification).code, 'REGISTRY_UNAVAILABLE');
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------- 校正台账

test('校正·两版改写逐版留档（谁改的 / 改了哪个字段 / 改前原文），raw_fields 全程不动', async () => {
  const { store, service } = boot();
  const { ocr } = await createAndSettle(service);
  const rawSnapshot = clone(ocr.raw_fields);
  assert.equal(ocr.raw_fields.registration_number, 'PD20210001');

  const first = await service.correctOcr({
    userId: USER,
    ocrId: ocr.id,
    body: { corrected_fields: { ...rawSnapshot, dosage_form: '乳油' } },
    ifMatch: `"${ocr.revision}"`,
    idempotencyKey: nextKey(),
  });
  assert.equal(first.revision, ocr.revision + 1);
  assert.deepEqual(Object.keys(first.verification).sort(), VERIFICATION_KEYS, 'HTTP 投影必须严格五字段');
  assert.equal(first.verification.correction_log, undefined, '台账不得外泄到契约面');

  const second = await service.correctOcr({
    userId: USER,
    ocrId: ocr.id,
    body: { corrected_fields: { ...rawSnapshot, dosage_form: '乳油', name: '用户手改名' } },
    ifMatch: `"${first.revision}"`,
    idempotencyKey: nextKey(),
  });
  assert.equal(second.revision, first.revision + 1);

  const row = await store.getOcr(ocr.id);
  assert.notEqual(row, null);
  assert.deepEqual(row.rawFields, rawSnapshot, 'rawFields 必须原样保留（不可覆盖）');

  const ledger = row.verification.correction_log;
  assert.equal(ledger.version, 'gy-i10-correction/1.0.0');
  assert.equal(ledger.entries.length, 2);

  const [entry1, entry2] = ledger.entries;
  assert.equal(entry1.version, 1);
  assert.equal(entry1.actor_user_id, USER, '必须记录「谁改的」');
  assert.deepEqual(entry1.changes, [{ field: 'dosage_form', before: '水剂', after: '乳油' }]);
  assert.deepEqual(entry1.raw_fields, rawSnapshot, '每一版都要留校正时点的原文快照');
  assert.equal(entry2.version, 2);
  assert.deepEqual(entry2.changes, [{ field: 'name', before: '替身示例草甘膦水剂', after: '用户手改名' }]);

  // 核对（verifyOCR）不得擦掉台账：台账只由 correctOCR 追加。
  const verified = await verify(service, ocr.id, row.correctedFields);
  assert.deepEqual(Object.keys(verified.verification).sort(), VERIFICATION_KEYS);
  const afterVerify = await store.getOcr(ocr.id);
  assert.equal(afterVerify.verification.correction_log.entries.length, 2, 'verifyOCR 不得擦掉校正台账');
  assert.deepEqual(afterVerify.rawFields, rawSnapshot);

  // 原样重提（diff 为空）不产生新版本。
  const third = await service.correctOcr({
    userId: USER,
    ocrId: ocr.id,
    body: { corrected_fields: { ...rawSnapshot, dosage_form: '乳油', name: '用户手改名' } },
    ifMatch: `"${verified.revision}"`,
    idempotencyKey: nextKey(),
  });
  const afterNoop = await store.getOcr(ocr.id);
  assert.equal(afterNoop.revision, third.revision);
  assert.equal(afterNoop.verification.correction_log.entries.length, 2, '空 diff 不得记成一次改写');
});
