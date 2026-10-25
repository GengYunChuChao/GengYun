// GY-R34 · **`/ocr/{id}/verify` 待核维度齐备性投影**（与 `/registrations/verify` 同口径）。
//
// 背景（为什么需要它）：契约 `MatchState` 有 `insufficient`（"要素不足"），内核
// `decideMatchState` 只把**必要条件**（`registration_number` / `name`）的缺失判成 insufficient
// —— 「登记号/名称都读到了，但剂型与成分表一个没读」会被判 **matched**，等于把「核对没做完」
// 呈现成「核对通过」。`/registrations/verify` 早已补上同一道投影，本片把它对齐到 OCR 核对面。
//
// 覆盖：
//   1. `matched` + 待核维度缺失 ⇒ `insufficient`（`registration: null` / `conflict_fields: []`，
//      且**清空 `dose_cards`**：没核完不得带出任何用量）；
//   2. 正控制：维度齐备 ⇒ 仍 `matched`（不得误伤）；
//   3. **非 `matched` 档一律原样透传**（conflict / ambiguous / no_match / insufficient /
//      unavailable 全部不得被降级成 insufficient），缺失维度只如实进 `missing_fields`，
//      且内核缺项在前、待核维度在后、不重复；
//   4. 投影**只在 verify 路径**：`createOCR` / `correctOCR` 落库的 `verification` 不受影响
//      （证明没碰被三条链路共用的 `verifyFields`）；
//   5. 归一化口径：空读（纯空白剂型 / 空成分表）**不诬成 conflict**，只按「未采集」处理。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

import { STUB_IDEMPOTENCY_HMAC_KEY } from '../../services/api/src/auth/service.ts';
import { createOcrService } from '../../services/api/src/ocr/service.ts';
import { createMemoryOcrStore } from '../../services/api/src/ocr/store.ts';
import { createOcrProvider } from '../../services/api/src/ocr/provider.ts';
import { createOcrMediaPort } from '../../services/api/src/ocr/media.ts';
import {
  SUBSTITUTE_REGISTRY,
  createOcrDosePort,
  createOcrReferencePort,
  createUnwiredReferencePort,
} from '../../services/api/src/ocr/reference.ts';

// ---------------------------------------------------------------- 辅助

const HMAC_KEY = STUB_IDEMPOTENCY_HMAC_KEY ?? 'gengyun-stub-idempotency-hmac-key';
const USER = 'user-owner-0001';

/** 契约 `Verification` 的五个键（`additionalProperties: false`，投影不得多带或漏带）。 */
const VERIFICATION_KEYS = ['conflict_fields', 'dose_cards', 'match_state', 'missing_fields', 'registration'];

function assertVerificationShape(verification, label) {
  assert.equal(typeof verification, 'object', `${label} 必须是 object`);
  assert.notEqual(verification, null, `${label} 不得为 null`);
  assert.deepEqual(Object.keys(verification).sort(), VERIFICATION_KEYS, `${label} 必须严格五键`);
  assert.ok(Array.isArray(verification.conflict_fields), `${label}.conflict_fields 必须是数组`);
  assert.ok(Array.isArray(verification.missing_fields), `${label}.missing_fields 必须是数组`);
  assert.ok(Array.isArray(verification.dose_cards), `${label}.dose_cards 必须是数组`);
}

function boot(executionMode = 'stub', overrides = {}) {
  const store = overrides.store ?? createMemoryOcrStore();
  const service = createOcrService({
    store,
    provider: overrides.provider ?? createOcrProvider({ executionMode }),
    media: overrides.media ?? createOcrMediaPort(executionMode),
    reference: overrides.reference ?? createOcrReferencePort(executionMode),
    dose: overrides.dose ?? createOcrDosePort(executionMode),
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
  return `gyr34-projection-key-${String(keyCounter).padStart(6, '0')}`;
}

/** 受理一个 OCR 任务并等它落定，返回记录投影。 */
async function createAndSettle(service, options = {}) {
  const mediaId = options.mediaId ?? mediaIdForBucket(options.bucket ?? 0);
  const { job } = await service.createOcr({
    userId: USER,
    body: { media_id: mediaId, media_revision: 1 },
    idempotencyKey: nextKey(),
  });
  await service.settle();
  const settled = await service.getJob({ userId: USER, jobId: job.id });
  return { job, settled, ocr: settled.result === null ? null : settled.result.value };
}

/** 对一条已落定记录发起核对（`fields` 默认取记录自带的 `raw_fields`，只覆盖 `patch`）。 */
function verify(service, created, patch = {}, extra = {}) {
  const fields = { ...created.ocr.raw_fields, ...patch };
  return service.verifyOcr({
    userId: USER,
    ocrId: created.job.target_ref.id,
    body: { fields, ...extra },
    ifMatch: `"${created.ocr.revision}"`,
    idempotencyKey: nextKey(),
  });
}

// ------------------------------------------------- 测试注入的可信用量来源（非生产数据）

/** 用量卡绑定的完整六项条件样例（契约 `DoseConditions` 要求全齐）。 */
const DOSE_CONDITIONS_SAMPLE = {
  crop_id: 'rice',
  region_code: '330100',
  species_id: 'species_barnyardgrass',
  growth_stage: '3-5叶期',
  planting_method: '移栽',
  use_scene: '水稻田',
};

/** 登记库替身里的第一条记录（R1，登记号 PD20210001）。 */
const SERVICE_R1 = SUBSTITUTE_REGISTRY[0];

/**
 * 构造一张**测试注入的、契约合法且来源可信**的用量卡候选（仅用于证明 gate 的通过面与
 * 「降级必须清空用量」这一条；生产替身端口不产出任何候选）。
 */
function trustedDoseCandidate() {
  const conditions = { ...DOSE_CONDITIONS_SAMPLE };
  const formulation = {
    ...SERVICE_R1.formulation,
    ingredients: SERVICE_R1.formulation.ingredients.map((item) => ({ ...item })),
  };
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

function createTrustedDosePort(candidates = [trustedDoseCandidate()]) {
  return {
    kind: 'unwired',
    note: '测试注入的可信用量来源端口（非生产装配）',
    async listCandidates() {
      return candidates;
    },
  };
}

// ---------------------------------------------------------------------------
// 1. matched + 待核维度缺失 ⇒ insufficient（含 failed-closed：清空用量卡）
// ---------------------------------------------------------------------------

test('G1. matched 但剂型与成分表都未采集 ⇒ 改判 insufficient，registration=null / conflict_fields=[]', async () => {
  const { service } = boot();
  const created = await createAndSettle(service, { bucket: 0 });
  // 前提：内核本身判了 matched（否则本用例不成立）。
  assert.equal(created.ocr.verification.match_state, 'matched', '夹具前提：替身 0 桶应 matched');

  const verification = await verify(service, created, { dosage_form: null, ingredients: [] });
  assertVerificationShape(verification, 'verification');
  assert.equal(verification.match_state, 'insufficient', '待核维度缺齐必须改判 insufficient');
  assert.equal(verification.registration, null, 'insufficient 不得带出候选记录');
  assert.deepEqual(verification.conflict_fields, []);
  assert.deepEqual(verification.missing_fields, ['dosage_form', 'ingredients']);
  assert.deepEqual(verification.dose_cards, []);

  // 结论必须落库（不是只改了返回值）。
  const fetched = await service.getOcr({ userId: USER, ocrId: created.job.target_ref.id });
  assert.equal(fetched.verification.match_state, 'insufficient');
  assert.deepEqual(fetched.verification.missing_fields, ['dosage_form', 'ingredients']);
  assert.equal(fetched.revision, created.ocr.revision + 1, '核对成功必须递增 revision');
});

test('G2. 只缺剂型 ⇒ insufficient，missing_fields 只点名 dosage_form', async () => {
  const { service } = boot();
  const created = await createAndSettle(service, { bucket: 0 });
  const verification = await verify(service, created, { dosage_form: null });
  assert.equal(verification.match_state, 'insufficient');
  assert.deepEqual(verification.missing_fields, ['dosage_form']);
});

test('G3. 只缺成分表（ingredients=[]）⇒ insufficient，missing_fields 只点名 ingredients', async () => {
  const { service } = boot();
  const created = await createAndSettle(service, { bucket: 0 });
  const verification = await verify(service, created, { ingredients: [] });
  assert.equal(verification.match_state, 'insufficient');
  assert.deepEqual(verification.missing_fields, ['ingredients']);
});

test('G4. 降级必须清空用量卡：注入可信来源 + 条件齐全时也不得带出任何 dose_card', async () => {
  const { service } = boot('stub', { dose: createTrustedDosePort() });
  const created = await createAndSettle(service, { bucket: 0 });

  // 先证明同一装配下「维度齐备」确实会放行一张卡（证明 gate 本身是通的，不是恒空）。
  const complete = await verify(service, created, {}, { conditions: { ...DOSE_CONDITIONS_SAMPLE } });
  assert.equal(complete.match_state, 'matched');
  assert.equal(complete.dose_cards.length, 1, '维度齐备 + 条件齐全 ⇒ 应放行 1 张（gate 通过面）');

  // 再证明「降级为 insufficient」时同一张卡必须被清空（没核完不得带出用量）。
  const after = await service.getOcr({ userId: USER, ocrId: created.job.target_ref.id });
  const downgraded = await verify(service, { ...created, ocr: after }, { dosage_form: null }, {
    conditions: { ...DOSE_CONDITIONS_SAMPLE },
  });
  assert.equal(downgraded.match_state, 'insufficient');
  assert.deepEqual(downgraded.dose_cards, [], '改判 insufficient 后不得带出用量卡');
});

// ---------------------------------------------------------------------------
// 2. 正控制：维度齐备 ⇒ 仍 matched（不误伤）
// ---------------------------------------------------------------------------

test('P1. 正控制·维度齐备且一致 ⇒ 仍 matched，registration 带出、missing_fields=[]', async () => {
  const { service } = boot();
  const created = await createAndSettle(service, { bucket: 0 });
  const verification = await verify(service, created);
  assert.equal(verification.match_state, 'matched');
  assert.deepEqual(verification.missing_fields, []);
  assert.deepEqual(verification.conflict_fields, []);
  assert.notEqual(verification.registration, null, 'matched 必须带出命中的登记记录');
  assert.equal(verification.registration.formulation.registration_number, 'PD20210001');
});

// ---------------------------------------------------------------------------
// 3. 非 matched 档：原样透传（⛔ 不许越界改判）
// ---------------------------------------------------------------------------

test('N1. conflict 档 ⇒ 不降级为 insufficient（缺失维度只进 missing_fields）', async () => {
  const { service } = boot();
  const created = await createAndSettle(service, { bucket: 2 });
  assert.equal(created.ocr.verification.match_state, 'conflict', '夹具前提：2 桶应 conflict');

  const verification = await verify(service, created, { ingredients: [] });
  assert.equal(verification.match_state, 'conflict', '已判 conflict 的强结论不得被降级');
  assert.notEqual(verification.registration, null, 'conflict 仍须带出被冲突的登记记录');
  assert.ok(verification.conflict_fields.includes('dosage_form'));
  assert.deepEqual(verification.missing_fields, ['ingredients'], '缺失维度仍须如实体现，不得被吞掉');
});

test('N2. ambiguous 档 ⇒ 原样透传（不得改成 insufficient，也不得挑一条候选）', async () => {
  const { service } = boot();
  const created = await createAndSettle(service, { bucket: 3 });
  assert.equal(created.ocr.verification.match_state, 'ambiguous', '夹具前提：3 桶应 ambiguous');

  const verification = await verify(service, created, { dosage_form: null, ingredients: [] });
  assert.equal(verification.match_state, 'ambiguous');
  assert.equal(verification.registration, null);
  assert.deepEqual(verification.missing_fields, ['dosage_form', 'ingredients']);
  assert.deepEqual(verification.dose_cards, []);
});

test('N3. no_match 档 ⇒ 原样透传（不得因缺维度改判 insufficient）', async () => {
  const { service } = boot();
  const created = await createAndSettle(service, { bucket: 4 });
  assert.equal(created.ocr.verification.match_state, 'no_match', '夹具前提：4 桶应 no_match');

  // 4 桶自带 `ingredients: []` ⇒ 即使不额外覆盖，也已在缺失之内。
  const verification = await verify(service, created);
  assert.equal(verification.match_state, 'no_match');
  assert.equal(verification.registration, null);
  assert.deepEqual(verification.missing_fields, ['ingredients'], '缺失维度如实体现');
});

test('N4. insufficient 档 ⇒ 保持 insufficient，且内核缺项在前、待核维度在后、不重复', async () => {
  const { service } = boot();
  const created = await createAndSettle(service, { bucket: 1 });
  assert.equal(created.ocr.verification.match_state, 'insufficient', '夹具前提：1 桶（登记号缺失）');
  assert.deepEqual(created.ocr.verification.missing_fields, ['registration_number']);

  const verification = await verify(service, created, { dosage_form: null, ingredients: [] });
  assert.equal(verification.match_state, 'insufficient');
  assert.deepEqual(
    verification.missing_fields,
    ['registration_number', 'dosage_form', 'ingredients'],
    '内核缺项必须在前且不被覆盖',
  );
});

test('N5. unavailable 档（登记库未接线）⇒ 原样透传，不得伪装成 insufficient/no_match', async () => {
  const { service } = boot('stub', { reference: createUnwiredReferencePort() });
  const created = await createAndSettle(service, { bucket: 0 });
  assert.equal(created.ocr.verification.match_state, 'unavailable');

  const verification = await verify(service, created, { dosage_form: null, ingredients: [] });
  assert.equal(verification.match_state, 'unavailable');
  assert.equal(verification.registration, null);
  assert.deepEqual(verification.missing_fields, ['dosage_form', 'ingredients']);
});

test('N6. 重复项不重复：同一维度既被内核点名又在待核清单里时，missing_fields 不出现重复项', async () => {
  const { service } = boot();
  const created = await createAndSettle(service, { bucket: 1 });
  // 1 桶的 raw_fields 里 dosage_form 是 '水剂'、ingredients 齐全；这里只额外造一例「缺失维度
  // 与内核缺项同名」不可能（内核只点名必要条件），故用「连续两次核对」证明清单仍稳定有序。
  const first = await verify(service, created, { ingredients: [] });
  assert.deepEqual(first.missing_fields, ['registration_number', 'ingredients']);
  const fetched = await service.getOcr({ userId: USER, ocrId: created.job.target_ref.id });
  const second = await verify(service, { ...created, ocr: fetched }, { ingredients: [] });
  assert.deepEqual(second.missing_fields, ['registration_number', 'ingredients'], '结论必须可逐字节复现');
  assert.equal(new Set(second.missing_fields).size, second.missing_fields.length, '不得出现重复项');
});

// ---------------------------------------------------------------------------
// 4. 投影只在 verify 路径（证明没碰被三条链路共用的 `verifyFields`）
// ---------------------------------------------------------------------------

test('S1. createOCR 落库的 verification 仍是内核结论（matched 不被改判）', async () => {
  const { service } = boot();
  const created = await createAndSettle(service, { bucket: 0 });
  assert.equal(created.ocr.verification.match_state, 'matched');
  assert.deepEqual(created.ocr.verification.missing_fields, []);
});

test('S2. correctOCR 即使把待核维度改成空读，落库的 verification 仍是内核结论（matched）', async () => {
  const { service } = boot();
  const created = await createAndSettle(service, { bucket: 0 });

  const corrected = await service.correctOcr({
    userId: USER,
    ocrId: created.job.target_ref.id,
    body: {
      corrected_fields: {
        ...created.ocr.raw_fields,
        dosage_form: null,
        ingredients: [],
      },
    },
    ifMatch: `"${created.ocr.revision}"`,
    idempotencyKey: nextKey(),
  });
  assert.equal(
    corrected.verification.match_state,
    'matched',
    'correctOCR 的 verification 必须仍走内核口径（投影只属于 verify 路径）',
  );
  assert.deepEqual(corrected.verification.missing_fields, [], 'correctOCR 不得被投影写入待核维度缺项');
});

// ---------------------------------------------------------------------------
// 5. 归一化口径：空读不诬成 conflict
// ---------------------------------------------------------------------------

test('V1. 纯空白剂型 ⇒ 按「未采集」处理，不得被判成「读到的剂型不一致」（不诬成 conflict）', async () => {
  const { service } = boot();
  const created = await createAndSettle(service, { bucket: 0 });
  const verification = await verify(service, created, { dosage_form: '   ' });
  assert.equal(verification.match_state, 'insufficient', '空白剂型不得判 matched');
  assert.deepEqual(verification.conflict_fields, [], '空读不是「另一种剂型」');
  assert.deepEqual(verification.missing_fields, ['dosage_form']);
});

test('V2. 空读归一化不得吞掉真实冲突：真不一致的剂型仍判 conflict', async () => {
  const { service } = boot();
  const created = await createAndSettle(service, { bucket: 0 });
  const verification = await verify(service, created, { dosage_form: '乳油' });
  assert.equal(verification.match_state, 'conflict');
  assert.ok(verification.conflict_fields.includes('dosage_form'));
});
