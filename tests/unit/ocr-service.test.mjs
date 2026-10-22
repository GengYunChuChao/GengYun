/**
 * GY-I10 标签 OCR · 服务层单元回归（Refs #10）。
 *
 * 走**真实服务链路**（内存 store + 替身提供者 + 替身登记库），覆盖契约 5 个 operationId
 * 的 fail-closed 语义：越权、revision 冲突、多余字段、提供者失败不得写成功、
 * raw_fields 与 corrected_fields 严格分离、dose_cards 适用性 gate。
 *
 * **用量卡口径**（GY-I07 验收第 3 条「不对模拟记录显示真实用量」）：
 * 生产装配（替身 / 未接线）恒返回空候选 ⇒ 生产路径 dose_cards 恒为 []，
 * 并有专门反例断言 stub 生产路径在 matched + 条件齐全时仍为 []。
 * gate 的**通过面**由本文件**注入**契约合法的可信来源（`createTrustedDosePort`）证明，
 * 绝不用替身来源扮演「已核对有效」来源。
 *
 * 断言一律先判 typeof / Array.isArray 再判值；不使用「只要不抛错就算过」的写法。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

import { STUB_IDEMPOTENCY_HMAC_KEY } from '../../services/api/src/auth/service.ts';
import { createOcrService } from '../../services/api/src/ocr/service.ts';
import { createMemoryOcrStore } from '../../services/api/src/ocr/store.ts';
import { createOcrProvider } from '../../services/api/src/ocr/provider.ts';
import { createOcrMediaPort, createSubstituteMediaPort } from '../../services/api/src/ocr/media.ts';
import {
  SUBSTITUTE_REGISTRY,
  createOcrDosePort,
  createOcrReferencePort,
  createSubstituteDosePort,
  createSubstituteReferencePort,
  createUnwiredDosePort,
  createUnwiredReferencePort,
} from '../../services/api/src/ocr/reference.ts';

// ---------------------------------------------------------------- 辅助

const HMAC_KEY = STUB_IDEMPOTENCY_HMAC_KEY ?? 'gengyun-stub-idempotency-hmac-key';

function assertString(value, label) {
  assert.equal(typeof value, 'string', `${label} 必须是 string，实际是 ${typeof value}`);
}

function assertArray(value, label) {
  assert.ok(Array.isArray(value), `${label} 必须是数组，实际是 ${typeof value}`);
  return value;
}

function assertEmptyArray(value, label) {
  assertArray(value, label);
  assert.equal(value.length, 0, `${label} 必须为空数组，实际有 ${value.length} 项`);
}

function assertObject(value, label) {
  assert.equal(typeof value, 'object', `${label} 必须是 object，实际是 ${typeof value}`);
  assert.notEqual(value, null, `${label} 不得为 null`);
  assert.equal(Array.isArray(value), false, `${label} 不得是数组`);
}

/** 断言抛出指定契约错误码的 ApiError。 */
async function assertApiError(operation, code, label) {
  await assert.rejects(operation, (error) => {
    assert.equal(error.name, 'ApiError', `${label} 应抛 ApiError，实际 ${error.name}: ${error.message}`);
    assert.equal(error.code, code, `${label} 错误码应为 ${code}，实际 ${error.code}`);
    return true;
  });
}

/** 组装一个按执行模式接线的服务（可覆盖端口，用于构造 unavailable / 未接线）。 */
function boot(executionMode = 'stub', overrides = {}) {
  const store = overrides.store ?? createMemoryOcrStore();
  const provider = overrides.provider ?? createOcrProvider({ executionMode });
  const service = createOcrService({
    store,
    provider,
    media: overrides.media ?? createOcrMediaPort(executionMode),
    reference: overrides.reference ?? createOcrReferencePort(executionMode),
    dose: overrides.dose ?? createOcrDosePort(executionMode),
    idempotencyHmacKey: HMAC_KEY,
  });
  return { store, service, provider };
}

// ------------------------------------------- 测试注入的用量卡来源（非生产数据）

/** 用量卡绑定的完整六项条件样例（契约 DoseConditions 要求全齐）。 */
const DOSE_CONDITIONS_SAMPLE = {
  crop_id: 'rice',
  region_code: '330100',
  species_id: 'species_barnyardgrass',
  growth_stage: '3-5叶期',
  planting_method: '移栽',
  use_scene: '水稻田',
};

/**
 * 登记库替身里的第一条记录（R1，登记号 PD20210001）。
 * 注入夹具默认绑定它的制剂，以便与 gate 的"登记制剂交叉核对"一致。
 */
const SERVICE_R1 = SUBSTITUTE_REGISTRY[0];

/**
 * 构造一张**测试注入的、契约合法且来源可信**的用量卡候选。
 *
 * 这是**测试夹具**，不是生产数据：生产替身端口不产出任何候选
 * （GY-I07 验收第 3 条：不对模拟记录显示真实用量）。
 * 只有靠注入才能构造「来源可信」形态，用于证明 gate 的通过面与逐项拒绝面。
 *
 * `card.formulation` **默认取自登记库里的 R1**（同一制剂）—— 因为 gate 现在会把
 * 卡片制剂与本次命中的登记制剂逐字段交叉核对（"原文用量必须绑定登记制剂"）。
 */
function trustedDoseCandidate(overrides = {}) {
  const { conditions: conditionOverrides = {}, card: cardOverrides = {}, formulation: formulationOverrides, ...rest } = overrides;
  const cardId = rest.cardId ?? '55555555-5555-4555-8555-555555555555';
  const conditions = { ...DOSE_CONDITIONS_SAMPLE, ...conditionOverrides };
  const originalText = '测试注入·登记标签原文用量：防除稗草，按登记标签标注的制剂用量与施药方法使用。';
  const locator = '测试注入·标签「使用技术与使用方法」第 1 段';
  const baseFormulation = SERVICE_R1.formulation;
  const formulation = {
    ...baseFormulation,
    ...(formulationOverrides ?? {}),
    ingredients: (formulationOverrides?.ingredients ?? baseFormulation.ingredients).map((item) => ({ ...item })),
  };
  const card = {
    id: cardId,
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
    ...cardOverrides,
  };
  return {
    card,
    formulation_registration_number: formulation.registration_number,
    conditions,
    source_kind: rest.source_kind ?? 'database',
    validity: rest.validity ?? 'valid',
    review_status: rest.review_status ?? 'verified',
    simulated: rest.simulated ?? false,
  };
}

/**
 * **测试注入**的用量端口：返回契约合法的可信来源候选。
 * 仅用于证明 gate 的通过面；生产装配（`createOcrDosePort`）绝不这样返回。
 */
function createTrustedDosePort(candidates = [trustedDoseCandidate()]) {
  return {
    kind: 'unwired',
    note: '测试注入的可信用量来源端口（非生产装配）',
    async listCandidates() {
      return candidates;
    },
  };
}

/** 找一个哈希分桶等于 bucket 的媒体 uuid（与提供者的确定性分桶口径一致）。 */
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
  return `ocr-test-key-${String(keyCounter).padStart(6, '0')}`;
}

/** 受理一个 OCR 任务并等它落定，返回 job / ocr 投影。 */
async function createAndSettle(service, userId, options = {}) {
  const mediaId = options.mediaId ?? mediaIdForBucket(options.bucket ?? 0);
  const { job } = await service.createOcr({
    userId,
    body: { media_id: mediaId, media_revision: 1 },
    idempotencyKey: options.idempotencyKey ?? nextKey(),
  });
  await service.settle();
  const settled = await service.getJob({ userId, jobId: job.id });
  const ocr = settled.result === null ? null : settled.result.value;
  return { job, settled, ocr };
}

const USER = 'user-owner-0001';

// ---------------------------------------------------------------- createOCR / getOCR / getJob

test('createOCR·受理即返回 202 语义（state=queued、result=null、kind=ocr）', async () => {
  const { service } = boot();
  const { job } = await service.createOcr({
    userId: USER,
    body: { media_id: mediaIdForBucket(0), media_revision: 1 },
    idempotencyKey: nextKey(),
  });
  assert.equal(job.kind, 'ocr');
  assert.equal(job.state, 'queued');
  assert.equal(job.result, null, '受理时不得带出结果');
  assertObject(job.target_ref, 'target_ref');
  assert.equal(job.target_ref.type, 'ocr');
  assertString(job.target_ref.id, 'target_ref.id');
  assertString(job.deadline_at, 'deadline_at');
  assertString(job.created_at, 'created_at');
  assert.equal(job.error_code, null);
  await service.settle();
});

test('getOCR·OCREnvelope 的 OCR 六字段全存在且类型正确（typeof 逐个断言）', async () => {
  const { service } = boot();
  const { job, settled, ocr } = await createAndSettle(service, USER, { bucket: 0 });
  assert.equal(settled.state, 'succeeded');
  assert.equal(settled.error_code, null);
  assert.equal(settled.result.kind, 'ocr');
  assert.notEqual(ocr, null, '成功任务必须产出 OCR 记录');

  const fetched = await service.getOcr({ userId: USER, ocrId: job.target_ref.id });
  assertString(fetched.id, 'ocr.id');
  assert.equal(typeof fetched.revision, 'number');
  assertObject(fetched.raw_fields, 'ocr.raw_fields');
  assertObject(fetched.corrected_fields, 'ocr.corrected_fields');
  assertObject(fetched.verification, 'ocr.verification');
  assertString(fetched.model_version, 'ocr.model_version');
  // additionalProperties:false：不得多出契约外字段。
  assert.deepEqual(
    Object.keys(fetched).sort(),
    ['corrected_fields', 'id', 'model_version', 'raw_fields', 'revision', 'verification'],
  );
});

test('getOCR·verification 五字段全存在（含 dose_cards 为空数组）', async () => {
  const { service } = await boot();
  const { ocr } = await createAndSettle(service, USER, { bucket: 0 });
  const verification = ocr.verification;
  assertString(verification.match_state, 'verification.match_state');
  assertArray(verification.conflict_fields, 'verification.conflict_fields');
  assertArray(verification.missing_fields, 'verification.missing_fields');
  assertArray(verification.dose_cards, 'verification.dose_cards');
  assert.ok('registration' in verification, 'verification.registration 字段必须存在（可为 null）');
  // 首次核对不带 conditions ⇒ 即使 matched，dose_cards 也必须为空。
  assert.equal(verification.match_state, 'matched');
  assertEmptyArray(verification.dose_cards, '首次核对（无 conditions）的 dose_cards');
});

test('替身标注·model_version 与 execution_mode 如实标注替身（不冒充真实 OCR）', async () => {
  const { service } = boot('stub');
  const { ocr } = await createAndSettle(service, USER, { bucket: 0 });
  assertString(ocr.model_version, 'model_version');
  assert.equal(ocr.model_version, 'stub-v1');
  const described = service.describe();
  assert.equal(described.executionMode, 'stub');
  assert.equal(described.referencePort, 'substitute');
  assert.equal(described.dosePort, 'substitute');
  assert.equal(described.storePersistent, false, '内存 store 必须如实标注非持久化');
});

// ---------------------------------------------------------------- 6 类 MatchState 经真实链路观测

test('六类 MatchState 经真实服务链路逐类可构造并观测（含 unavailable 需未接线登记库）', async () => {
  const expectations = [
    { bucket: 0, state: 'matched' },
    { bucket: 1, state: 'insufficient' },
    { bucket: 2, state: 'conflict' },
    { bucket: 3, state: 'ambiguous' },
    { bucket: 4, state: 'no_match' },
    { bucket: 5, state: 'insufficient' },
  ];
  const observed = [];
  for (const item of expectations) {
    const { service } = boot();
    const { ocr } = await createAndSettle(service, USER, { bucket: item.bucket });
    assert.notEqual(ocr, null, `分桶 ${item.bucket} 必须产出记录`);
    assertString(ocr.verification.match_state, `分桶 ${item.bucket} 的 match_state`);
    assert.equal(ocr.verification.match_state, item.state, `分桶 ${item.bucket} 期望 ${item.state}`);
    observed.push(ocr.verification.match_state);
  }

  // unavailable：替身提供者 + **未接线**登记库 → 不得被 no_match 掩盖。
  const wired = boot('stub', { reference: createUnwiredReferencePort() });
  const unavailableRun = await createAndSettle(wired.service, USER, { bucket: 0 });
  assert.equal(unavailableRun.ocr.verification.match_state, 'unavailable');
  observed.push(unavailableRun.ocr.verification.match_state);

  assert.equal(new Set(observed).size, 6, `应观测到全部 6 类，实际 ${JSON.stringify(observed)}`);
  assert.deepEqual(
    [...new Set(observed)].sort(),
    ['ambiguous', 'conflict', 'insufficient', 'matched', 'no_match', 'unavailable'],
  );
});

test('反例·登记库未接线时绝不落 no_match（不可用不得伪装成无匹配）', async () => {
  const { service } = boot('stub', { reference: createUnwiredReferencePort() });
  const { ocr } = await createAndSettle(service, USER, { bucket: 4 });
  assertString(ocr.verification.match_state, 'match_state');
  assert.equal(ocr.verification.match_state, 'unavailable');
  assert.notEqual(ocr.verification.match_state, 'no_match');
  assert.equal(ocr.verification.registration, null);
});

test('反例·missing_fields 非空的记录绝不得是 matched（经真实链路）', async () => {
  const { service } = boot();
  const { ocr } = await createAndSettle(service, USER, { bucket: 1 });
  assert.equal(ocr.verification.match_state, 'insufficient');
  assert.ok(ocr.verification.missing_fields.length > 0, '缺项记录必须列出 missing_fields');
  assert.notEqual(ocr.verification.match_state, 'matched');
  assert.equal(ocr.raw_fields.registration_number, null);
});

test('反例·conflict 记录必须列出冲突字段且 registration 带出以便复核', async () => {
  const { service } = boot();
  const { ocr } = await createAndSettle(service, USER, { bucket: 2 });
  assert.equal(ocr.verification.match_state, 'conflict');
  assert.ok(ocr.verification.conflict_fields.length > 0);
  assert.notEqual(ocr.verification.registration, null, 'conflict 应带出被冲突的登记记录');
  assertString(ocr.verification.registration.formulation.registration_number, 'registration.formulation.registration_number');
});

test('反例·ambiguous 记录不得擅自挑一条候选当结论', async () => {
  const { service } = boot();
  const { ocr } = await createAndSettle(service, USER, { bucket: 3 });
  assert.equal(ocr.verification.match_state, 'ambiguous');
  assert.equal(ocr.verification.registration, null);
  assertEmptyArray(ocr.verification.dose_cards, 'ambiguous 时不得给用量卡');
});

// ---------------------------------------------------------------- raw / corrected 严格分离

test('反例·correctOCR 只写 corrected_fields，绝不覆写 raw_fields', async () => {
  const { service } = boot();
  const { job, ocr } = await createAndSettle(service, USER, { bucket: 0 });
  const raw = ocr.raw_fields;
  assert.equal(ocr.raw_fields.registration_number, 'PD20210001');
  assert.equal(ocr.corrected_fields.registration_number, 'PD20210001');

  const corrected = await service.correctOcr({
    userId: USER,
    ocrId: job.target_ref.id,
    body: {
      corrected_fields: {
        registration_number: 'PD20210002',
        name: '用户手改的名称',
        ingredients: [{ name: '乙草胺', content_text: '50', unit_text: '%' }],
        dosage_form: '乳油',
      },
    },
    ifMatch: `"${ocr.revision}"`,
    idempotencyKey: nextKey(),
  });

  // raw_fields 必须**原样**保留（逐字段比对，含数组内容）。
  assert.equal(corrected.raw_fields.registration_number, 'PD20210001');
  assert.equal(corrected.raw_fields.name, raw.name);
  assert.equal(corrected.raw_fields.dosage_form, '水剂');
  assert.equal(corrected.raw_fields.ingredients.length, 1);
  assert.equal(corrected.raw_fields.ingredients[0].name, '草甘膦');
  assert.deepEqual(corrected.raw_fields, raw, 'raw_fields 必须与校正前逐字段一致');

  // corrected_fields 才是被写入的那一份。
  assert.equal(corrected.corrected_fields.registration_number, 'PD20210002');
  assert.equal(corrected.corrected_fields.dosage_form, '乳油');
  assert.equal(corrected.revision, ocr.revision + 1, '校正必须递增 revision');
  // 模型版本不得因用户校正而变化（手改不计入模型准确率）。
  assert.equal(corrected.model_version, ocr.model_version);
});

test('反例·correctOCR 会重算并 invalidate 旧登记核对（不留陈旧结论）', async () => {
  const { service } = boot();
  const { job, ocr } = await createAndSettle(service, USER, { bucket: 0 });
  assert.equal(ocr.verification.match_state, 'matched');

  const corrected = await service.correctOcr({
    userId: USER,
    ocrId: job.target_ref.id,
    body: {
      corrected_fields: {
        registration_number: 'PD99999999',
        name: '改名后不再命中',
        ingredients: [],
        dosage_form: '可溶液剂',
      },
    },
    ifMatch: `"${ocr.revision}"`,
    idempotencyKey: nextKey(),
  });
  assert.equal(corrected.verification.match_state, 'no_match');
  assert.notEqual(corrected.verification.match_state, 'matched', '旧 matched 结论必须被替换');
});

// ---------------------------------------------------------------- dose_cards gate（服务层）

test('dose gate 通过面（**测试注入**契约合法可信来源）·matched + 条件齐全 ⇒ 放行 1 张并绑定登记制剂与六项条件', async () => {
  const { service } = boot('stub', { dose: createTrustedDosePort() });
  const { job, ocr } = await createAndSettle(service, USER, { bucket: 0 });
  const verification = await service.verifyOcr({
    userId: USER,
    ocrId: job.target_ref.id,
    body: { fields: ocr.raw_fields, conditions: { ...DOSE_CONDITIONS_SAMPLE } },
    ifMatch: `"${ocr.revision}"`,
    idempotencyKey: nextKey(),
  });
  assert.equal(verification.match_state, 'matched');
  assertArray(verification.dose_cards, 'dose_cards');
  assert.equal(verification.dose_cards.length, 1, `应放行 1 张，实际 ${verification.dose_cards.length}`);
  const card = verification.dose_cards[0];
  assertString(card.original_text, 'dose_card.original_text');
  assert.equal(card.formulation.registration_number, 'PD20210001', '用量原文必须绑定命中的登记制剂');
  assert.equal(card.conditions.growth_stage, DOSE_CONDITIONS_SAMPLE.growth_stage);
  assert.equal(card.conditions.species_id, DOSE_CONDITIONS_SAMPLE.species_id);
  assert.equal(card.source.review_status, 'verified');
});

test('反例·**stub 生产路径不得产出用量卡**：matched + 条件齐全时 dose_cards 必须为 []', async () => {
  // 生产装配（不注入任何东西）：替身用量端口恒返回空候选 —— #7 验收第 3 条要求的行为。
  const { service } = boot('stub');
  const { job, ocr } = await createAndSettle(service, USER, { bucket: 0 });
  const verification = await service.verifyOcr({
    userId: USER,
    ocrId: job.target_ref.id,
    body: { fields: ocr.raw_fields, conditions: { ...DOSE_CONDITIONS_SAMPLE } },
    ifMatch: `"${ocr.revision}"`,
    idempotencyKey: nextKey(),
  });
  // 必须是 matched，才能证明空剂量不是靠"压根没匹配上"换来的。
  assert.equal(verification.match_state, 'matched');
  assertEmptyArray(verification.dose_cards, 'stub 生产路径的 dose_cards');
  assert.equal(verification.dose_cards.length, 0);
  // 落库后也不得出现任何用量卡。
  const fetched = await service.getOcr({ userId: USER, ocrId: job.target_ref.id });
  assertEmptyArray(fetched.verification.dose_cards, '落库后的 dose_cards');
});

test('反例·preset_demo 生产路径同样不得产出用量卡', async () => {
  const { service } = boot('preset_demo');
  const { job, ocr } = await createAndSettle(service, USER, { bucket: 0 });
  assert.equal(ocr.verification.match_state, 'matched');
  const verification = await service.verifyOcr({
    userId: USER,
    ocrId: job.target_ref.id,
    body: { fields: ocr.raw_fields, conditions: { ...DOSE_CONDITIONS_SAMPLE } },
    ifMatch: `"${ocr.revision}"`,
    idempotencyKey: nextKey(),
  });
  assert.equal(verification.match_state, 'matched');
  assertEmptyArray(verification.dose_cards, 'preset_demo 生产路径的 dose_cards');
});

test('反例·注入可信来源但不带 conditions 时 dose_cards 必为 []（matched 也不例外）', async () => {
  const { service } = boot('stub', { dose: createTrustedDosePort() });
  const { job, ocr } = await createAndSettle(service, USER, { bucket: 0 });
  const verification = await service.verifyOcr({
    userId: USER,
    ocrId: job.target_ref.id,
    body: { fields: ocr.raw_fields },
    ifMatch: `"${ocr.revision}"`,
    idempotencyKey: nextKey(),
  });
  assert.equal(verification.match_state, 'matched');
  assertEmptyArray(verification.dose_cards, '无 conditions 时的 dose_cards');
});

test('反例·注入可信来源但 conditions 不全（只给 crop_id + region_code）时 dose_cards 必为 []', async () => {
  const { service } = boot('stub', { dose: createTrustedDosePort() });
  const { job, ocr } = await createAndSettle(service, USER, { bucket: 0 });
  const verification = await service.verifyOcr({
    userId: USER,
    ocrId: job.target_ref.id,
    body: { fields: ocr.raw_fields, conditions: { crop_id: 'rice', region_code: '330100' } },
    ifMatch: `"${ocr.revision}"`,
    idempotencyKey: nextKey(),
  });
  assertEmptyArray(verification.dose_cards, 'conditions 不全时的 dose_cards');
});

test('反例·注入可信来源但 conditions 与卡片绑定条件不一致时 dose_cards 必为 []', async () => {
  const { service } = boot('stub', { dose: createTrustedDosePort() });
  const { job, ocr } = await createAndSettle(service, USER, { bucket: 0 });
  const verification = await service.verifyOcr({
    userId: USER,
    ocrId: job.target_ref.id,
    body: {
      fields: ocr.raw_fields,
      conditions: { ...DOSE_CONDITIONS_SAMPLE, growth_stage: '分蘖期' },
    },
    ifMatch: `"${ocr.revision}"`,
    idempotencyKey: nextKey(),
  });
  assertEmptyArray(verification.dose_cards, '条件不一致时的 dose_cards');
});

test('反例·注入的候选来源为模拟 / 未核对 / 过期时 dose_cards 恒为 []（不得以模拟记录呈现真实用量）', async () => {
  const variants = [
    { label: '模拟来源', candidate: trustedDoseCandidate({ simulated: true, source_kind: 'simulation' }) },
    { label: '未核对来源', candidate: trustedDoseCandidate({ review_status: 'unverified' }) },
    { label: '过期来源', candidate: trustedDoseCandidate({ validity: 'expired' }) },
  ];
  for (const variant of variants) {
    const { service } = boot('stub', { dose: createTrustedDosePort([variant.candidate]) });
    const { job, ocr } = await createAndSettle(service, USER, { bucket: 0 });
    const verification = await service.verifyOcr({
      userId: USER,
      ocrId: job.target_ref.id,
      body: { fields: ocr.raw_fields, conditions: { ...DOSE_CONDITIONS_SAMPLE } },
      ifMatch: `"${ocr.revision}"`,
      idempotencyKey: nextKey(),
    });
    assert.equal(verification.match_state, 'matched', `${variant.label}：核对状态应为 matched`);
    assertEmptyArray(verification.dose_cards, `${variant.label}时的 dose_cards`);
  }
});

test('反例·注入可信来源但未命中（no_match / ambiguous）时即使条件齐全 dose_cards 也必为 []', async () => {
  for (const bucket of [3, 4]) {
    const { service } = boot('stub', { dose: createTrustedDosePort() });
    const { job, ocr } = await createAndSettle(service, USER, { bucket });
    const verification = await service.verifyOcr({
      userId: USER,
      ocrId: job.target_ref.id,
      body: { fields: ocr.raw_fields, conditions: { ...DOSE_CONDITIONS_SAMPLE } },
      ifMatch: `"${ocr.revision}"`,
      idempotencyKey: nextKey(),
    });
    assert.notEqual(verification.match_state, 'matched');
    assertEmptyArray(verification.dose_cards, `分桶 ${bucket} 的 dose_cards`);
  }
});

test('反例·real 模式用量端口未接线时 dose_cards 恒为 []（不补造、不回退替身）', async () => {
  const { service } = boot('stub', { dose: createUnwiredDosePort() });
  const { job, ocr } = await createAndSettle(service, USER, { bucket: 0 });
  const verification = await service.verifyOcr({
    userId: USER,
    ocrId: job.target_ref.id,
    body: { fields: ocr.raw_fields, conditions: { ...DOSE_CONDITIONS_SAMPLE } },
    ifMatch: `"${ocr.revision}"`,
    idempotencyKey: nextKey(),
  });
  assert.equal(verification.match_state, 'matched', '登记库仍可用：匹配状态不受用量端口影响');
  assertEmptyArray(verification.dose_cards, '用量端口未接线时的 dose_cards');
});

// ------------------------- 监工 5487924164 / 行内 4245800045：端到端复核"只信外层"已修

test('反例·端到端：外层候选标称可信、但**卡片载荷**条件与请求不一致 ⇒ dose_cards 为 []', async () => {
  // 外层 candidate.conditions 与请求一致（rice 系列），只有 card.conditions.crop_id=wheat。
  // 这正是原实现只校验 candidate.* 时会放行"错误作物用量原文"的形态。
  const lying = trustedDoseCandidate({
    card: { conditions: { ...DOSE_CONDITIONS_SAMPLE, crop_id: 'wheat' } },
  });
  assert.equal(lying.card.conditions.crop_id, 'wheat', '前提：卡片载荷条件为 wheat');
  assert.equal(lying.conditions.crop_id, 'rice', '前提：外层候选条件为 rice');
  const { service } = boot('stub', { dose: createTrustedDosePort([lying]) });
  const { job, ocr } = await createAndSettle(service, USER, { bucket: 0 });
  const verification = await service.verifyOcr({
    userId: USER,
    ocrId: job.target_ref.id,
    body: { fields: ocr.raw_fields, conditions: { ...DOSE_CONDITIONS_SAMPLE } },
    ifMatch: `"${ocr.revision}"`,
    idempotencyKey: nextKey(),
  });
  assert.equal(verification.match_state, 'matched');
  assertEmptyArray(verification.dose_cards, '载荷条件不符时的 dose_cards');
  // 也不能靠"绕过 gate 直接落库"把卡片带进记录。
  const fetched = await service.getOcr({ userId: USER, ocrId: job.target_ref.id });
  assertEmptyArray(fetched.verification.dose_cards, '落库后的 dose_cards');
});

test('反例·端到端：外层候选来源标称可信、但**卡片载荷**来源不可信 ⇒ dose_cards 为 []', async () => {
  const base = trustedDoseCandidate();
  const variants = [
    { label: 'validity=withdrawn', source: { validity: 'withdrawn' } },
    { label: 'review_status=rejected', source: { review_status: 'rejected' } },
    { label: 'source_kind=simulation', source: { source_kind: 'simulation' } },
  ];
  for (const variant of variants) {
    const lying = trustedDoseCandidate({ card: { source: { ...base.card.source, ...variant.source } } });
    // 前提：外层来源三项全部标称可信 —— 原实现只看这三项，因此会放行。
    assert.equal(lying.source_kind, 'database', `${variant.label} 前提：外层 source_kind 标称可信`);
    assert.equal(lying.validity, 'valid', `${variant.label} 前提：外层 validity 标称有效`);
    assert.equal(lying.review_status, 'verified', `${variant.label} 前提：外层已核对`);

    const { service } = boot('stub', { dose: createTrustedDosePort([lying]) });
    const { job, ocr } = await createAndSettle(service, USER, { bucket: 0 });
    const verification = await service.verifyOcr({
      userId: USER,
      ocrId: job.target_ref.id,
      body: { fields: ocr.raw_fields, conditions: { ...DOSE_CONDITIONS_SAMPLE } },
      ifMatch: `"${ocr.revision}"`,
      idempotencyKey: nextKey(),
    });
    assert.equal(verification.match_state, 'matched', `${variant.label}：核对状态仍是 matched`);
    assertEmptyArray(verification.dose_cards, `${variant.label} 时的 dose_cards`);
  }
});

test('反例·端到端：**卡片制剂**与登记库命中的制剂不符 ⇒ dose_cards 为 []（收口"登记制剂绑定"）', async () => {
  const variants = [
    { label: 'dosage_form 不符', formulation: { dosage_form: '乳油' } },
    { label: 'producer 不符', formulation: { producer: '另一家合成生产企业' } },
    { label: '含量不符', formulation: { ingredients: [{ name: '草甘膦', content_text: '30', unit_text: '%' }] } },
    { label: '名称不符', formulation: { ingredients: [{ name: '乙草胺', content_text: '41', unit_text: '%' }] } },
    { label: 'formulation.id 不符', formulation: { id: '99999999-9999-4999-8999-999999999999' } },
  ];
  for (const variant of variants) {
    const lying = trustedDoseCandidate({ formulation: variant.formulation });
    // 前提：登记号仍命中 R1（所以不是靠"登记号都没对上"来拒绝）。
    assert.equal(lying.formulation_registration_number, 'PD20210001', `${variant.label} 前提：登记号仍是 R1`);
    const { service } = boot('stub', { dose: createTrustedDosePort([lying]) });
    const { job, ocr } = await createAndSettle(service, USER, { bucket: 0 });
    const verification = await service.verifyOcr({
      userId: USER,
      ocrId: job.target_ref.id,
      body: { fields: ocr.raw_fields, conditions: { ...DOSE_CONDITIONS_SAMPLE } },
      ifMatch: `"${ocr.revision}"`,
      idempotencyKey: nextKey(),
    });
    assert.equal(verification.match_state, 'matched', `${variant.label}：核对仍未 matched`);
    assertEmptyArray(verification.dose_cards, `${variant.label} 时的 dose_cards`);
    // 落库后也不得带进记录。
    const fetched = await service.getOcr({ userId: USER, ocrId: job.target_ref.id });
    assertEmptyArray(fetched.verification.dose_cards, `${variant.label} 落库后的 dose_cards`);
  }
});

test('正控制·端到端：仅排版性差异（大小写 / 首尾空白 / 全半角）⇒ 仍放出 1 张', async () => {
  const base = trustedDoseCandidate();
  const styled = trustedDoseCandidate({
    formulation: {
      producer: `  ${SERVICE_R1.formulation.producer.toUpperCase()}  `,
      ingredients: [{ name: '草甘膦', content_text: '４１', unit_text: '％' }],
    },
  });
  const { service } = boot('stub', { dose: createTrustedDosePort([styled]) });
  const { job, ocr } = await createAndSettle(service, USER, { bucket: 0 });
  const verification = await service.verifyOcr({
    userId: USER,
    ocrId: job.target_ref.id,
    body: { fields: ocr.raw_fields, conditions: { ...DOSE_CONDITIONS_SAMPLE } },
    ifMatch: `"${ocr.revision}"`,
    idempotencyKey: nextKey(),
  });
  assert.equal(verification.match_state, 'matched');
  assert.equal(verification.dose_cards.length, 1, '仅排版差异不得被误杀');
  assert.equal(verification.dose_cards[0].formulation.id, base.card.formulation.id);
});

test('反例·端到端：登记库返回不可解析载荷 ⇒ unavailable（不得 no_match，也不得打成 500）', async () => {
  const malformedPorts = [
    { label: 'candidates 非数组', lookup: async () => ({ status: 'available', candidates: null }) },
    {
      label: '候选缺 formulation',
      lookup: async () => ({ status: 'available', candidates: [{ id: '11111111-1111-4111-8111-111111111111', revision: 1 }] }),
    },
    { label: '返回非对象', lookup: async () => 'garbage' },
    { label: 'status 未知', lookup: async () => ({ status: 'weird' }) },
  ];
  for (const item of malformedPorts) {
    const reference = {
      kind: 'substitute',
      note: `测试注入：${item.label}`,
      available: true,
      unavailableReason: null,
      lookup: item.lookup,
    };
    const { service } = boot('stub', { reference });
    const { job, ocr } = await createAndSettle(service, USER, { bucket: 0 });
    assert.notEqual(ocr, null, `${item.label}：任务仍应成功产出记录`);
    assert.equal(ocr.verification.match_state, 'unavailable', `${item.label} 应如实 unavailable`);
    assert.notEqual(ocr.verification.match_state, 'no_match', `${item.label} 不得伪装成 no_match`);
    assertEmptyArray(ocr.verification.dose_cards, `${item.label} 时的 dose_cards`);
    // 也确认 verify 路径不会因此抛错（不得打成 500）。
    const verification = await service.verifyOcr({
      userId: USER,
      ocrId: job.target_ref.id,
      body: { fields: ocr.raw_fields, conditions: { ...DOSE_CONDITIONS_SAMPLE } },
      ifMatch: `"${ocr.revision}"`,
      idempotencyKey: nextKey(),
    });
    assert.equal(verification.match_state, 'unavailable');
    assertEmptyArray(verification.dose_cards);
  }
});

test('反例·端到端：用量端口返回非数组 / 畸形候选 ⇒ dose_cards 为 []，请求不得失败', async () => {
  const brokenPorts = [
    { label: '返回 null', list: async () => null },
    { label: '返回字符串', list: async () => 'nope' },
    { label: '元素为 null', list: async () => [null] },
    { label: '元素缺 card', list: async () => [{ formulation_registration_number: 'PD20210001' }] },
    { label: 'card 非对象', list: async () => [{ card: 'x' }] },
  ];
  for (const item of brokenPorts) {
    const dosePort = { kind: 'unwired', note: `测试注入：${item.label}`, listCandidates: item.list };
    const { service } = boot('stub', { dose: dosePort });
    const { job, ocr } = await createAndSettle(service, USER, { bucket: 0 });
    assert.equal(ocr.verification.match_state, 'matched', `${item.label}：核对仍应 matched`);
    assertEmptyArray(ocr.verification.dose_cards, `${item.label} 时的 dose_cards`);
    const verification = await service.verifyOcr({
      userId: USER,
      ocrId: job.target_ref.id,
      body: { fields: ocr.raw_fields, conditions: { ...DOSE_CONDITIONS_SAMPLE } },
      ifMatch: `"${ocr.revision}"`,
      idempotencyKey: nextKey(),
    });
    assertEmptyArray(verification.dose_cards, `${item.label} verify 时的 dose_cards`);
  }
});

test('反例·verifyOCR 不得改动 raw_fields 与 corrected_fields', async () => {
  const { service } = boot();
  const { job, ocr } = await createAndSettle(service, USER, { bucket: 0 });
  await service.verifyOcr({
    userId: USER,
    ocrId: job.target_ref.id,
    body: { fields: { ...ocr.raw_fields, dosage_form: '乳油' }, conditions: null },
    ifMatch: `"${ocr.revision}"`,
    idempotencyKey: nextKey(),
  });
  const after = await service.getOcr({ userId: USER, ocrId: job.target_ref.id });
  assert.deepEqual(after.raw_fields, ocr.raw_fields, 'verify 不得改 raw_fields');
  assert.deepEqual(after.corrected_fields, ocr.corrected_fields, 'verify 不得改 corrected_fields');
  assert.equal(after.revision, ocr.revision + 1, 'verify 必须递增 revision');
});

// ---------------------------------------------------------------- 越权 / 存在性

test('反例·他人 OCR 任务一律 NOT_FOUND（不泄露存在性）', async () => {
  const { service } = boot();
  const { job } = await createAndSettle(service, USER, { bucket: 0 });
  await assertApiError(
    () => service.getOcr({ userId: 'user-other-9999', ocrId: job.target_ref.id }),
    'NOT_FOUND',
    '他人任务读取',
  );
  await assertApiError(
    () =>
      service.correctOcr({
        userId: 'user-other-9999',
        ocrId: job.target_ref.id,
        body: { corrected_fields: { registration_number: null, name: null, ingredients: [], dosage_form: null } },
        ifMatch: '"1"',
        idempotencyKey: nextKey(),
      }),
    'NOT_FOUND',
    '他人任务校正',
  );
  await assertApiError(
    () => service.deleteOcr({ userId: 'user-other-9999', ocrId: job.target_ref.id, ifMatch: '"1"', idempotencyKey: nextKey() }),
    'NOT_FOUND',
    '他人任务删除',
  );
});

test('反例·不存在与越权的响应同形（错误码与消息一致，无法据此区分存在性）', async () => {
  const { service } = boot();
  const { job } = await createAndSettle(service, USER, { bucket: 0 });
  let forbidden = null;
  let missing = null;
  try {
    await service.getOcr({ userId: 'user-other-9999', ocrId: job.target_ref.id });
  } catch (error) {
    forbidden = error;
  }
  try {
    await service.getOcr({ userId: USER, ocrId: randomUUID() });
  } catch (error) {
    missing = error;
  }
  assert.notEqual(forbidden, null);
  assert.notEqual(missing, null);
  assert.equal(forbidden.code, missing.code);
  assert.equal(forbidden.message, missing.message, '越权与不存在必须同形，不泄露存在性');
});

test('反例·他人任务的任务查询同样 NOT_FOUND', async () => {
  const { service } = boot();
  const { job } = await createAndSettle(service, USER, { bucket: 0 });
  await assertApiError(
    () => service.getJob({ userId: 'user-other-9999', jobId: job.id }),
    'NOT_FOUND',
    '他人任务查询',
  );
});

// ---------------------------------------------------------------- 多余字段 / 参数校验

test('反例·createOCR body 多余字段 ⇒ INVALID_REQUEST', async () => {
  const { service } = boot();
  await assertApiError(
    () =>
      service.createOcr({
        userId: USER,
        body: { media_id: mediaIdForBucket(0), media_revision: 1, extra_field: true },
        idempotencyKey: nextKey(),
      }),
    'INVALID_REQUEST',
    'createOCR 多余字段',
  );
});

test('反例·correctOCR body 多余字段 ⇒ INVALID_REQUEST', async () => {
  const { service } = boot();
  const { job, ocr } = await createAndSettle(service, USER, { bucket: 0 });
  await assertApiError(
    () =>
      service.correctOcr({
        userId: USER,
        ocrId: job.target_ref.id,
        body: { corrected_fields: ocr.raw_fields, unexpected: 1 },
        ifMatch: `"${ocr.revision}"`,
        idempotencyKey: nextKey(),
      }),
    'INVALID_REQUEST',
    'correctOCR 多余字段',
  );
});

test('反例·verifyOCR body 多余字段 ⇒ INVALID_REQUEST', async () => {
  const { service } = boot();
  const { job, ocr } = await createAndSettle(service, USER, { bucket: 0 });
  await assertApiError(
    () =>
      service.verifyOcr({
        userId: USER,
        ocrId: job.target_ref.id,
        body: { fields: ocr.raw_fields, extra: 'x' },
        ifMatch: `"${ocr.revision}"`,
        idempotencyKey: nextKey(),
      }),
    'INVALID_REQUEST',
    'verifyOCR 多余字段',
  );
});

test('反例·LabelFields 缺字段与非法 uuid 一律 INVALID_REQUEST（不静默补 null）', async () => {
  const { service } = boot();
  const { job, ocr } = await createAndSettle(service, USER, { bucket: 0 });
  await assertApiError(
    () =>
      service.verifyOcr({
        userId: USER,
        ocrId: job.target_ref.id,
        body: { fields: { name: null, ingredients: [], dosage_form: null } },
        ifMatch: `"${ocr.revision}"`,
        idempotencyKey: nextKey(),
      }),
    'INVALID_REQUEST',
    'fields 缺 registration_number',
  );
  await assertApiError(
    () =>
      service.createOcr({
        userId: USER,
        body: { media_id: 'not-a-uuid', media_revision: 1 },
        idempotencyKey: nextKey(),
      }),
    'INVALID_REQUEST',
    'media_id 非 uuid',
  );
});

test('反例·缺少或过短 Idempotency-Key ⇒ IDEMPOTENCY_KEY_REQUIRED', async () => {
  const { service } = boot();
  await assertApiError(
    () => service.createOcr({ userId: USER, body: { media_id: mediaIdForBucket(0), media_revision: 1 }, idempotencyKey: undefined }),
    'IDEMPOTENCY_KEY_REQUIRED',
    '缺少 Idempotency-Key',
  );
  await assertApiError(
    () => service.createOcr({ userId: USER, body: { media_id: mediaIdForBucket(0), media_revision: 1 }, idempotencyKey: 'short' }),
    'IDEMPOTENCY_KEY_REQUIRED',
    '过短 Idempotency-Key',
  );
});

// ---------------------------------------------------------------- revision 冲突

test('反例·correctOCR 的 If-Match 与当前 revision 不一致 ⇒ REVISION_CONFLICT', async () => {
  const { service } = boot();
  const { job, ocr } = await createAndSettle(service, USER, { bucket: 0 });
  await assertApiError(
    () =>
      service.correctOcr({
        userId: USER,
        ocrId: job.target_ref.id,
        body: { corrected_fields: ocr.raw_fields },
        ifMatch: `"${ocr.revision + 5}"`,
        idempotencyKey: nextKey(),
      }),
    'REVISION_CONFLICT',
    'correctOCR revision 冲突',
  );
});

test('反例·deleteOCR 的 If-Match 与当前 revision 不一致 ⇒ REVISION_CONFLICT', async () => {
  const { service } = boot();
  const { job, ocr } = await createAndSettle(service, USER, { bucket: 0 });
  await assertApiError(
    () => service.deleteOcr({ userId: USER, ocrId: job.target_ref.id, ifMatch: '"99"', idempotencyKey: nextKey() }),
    'REVISION_CONFLICT',
    'deleteOCR revision 冲突',
  );
  assert.equal(ocr.revision, 1);
});

test('反例·verifyOCR 的 If-Match 与当前 revision 不一致 ⇒ REVISION_CONFLICT', async () => {
  const { service } = boot();
  const { job, ocr } = await createAndSettle(service, USER, { bucket: 0 });
  await assertApiError(
    () =>
      service.verifyOcr({
        userId: USER,
        ocrId: job.target_ref.id,
        body: { fields: ocr.raw_fields },
        ifMatch: '"42"',
        idempotencyKey: nextKey(),
      }),
    'REVISION_CONFLICT',
    'verifyOCR revision 冲突',
  );
});

test('反例·缺少 If-Match（428）与格式非法（400）分别落 REVISION_REQUIRED / INVALID_REQUEST', async () => {
  const { service } = boot();
  const { job } = await createAndSettle(service, USER, { bucket: 0 });
  await assertApiError(
    () => service.deleteOcr({ userId: USER, ocrId: job.target_ref.id, ifMatch: undefined, idempotencyKey: nextKey() }),
    'REVISION_REQUIRED',
    '缺少 If-Match',
  );
  await assertApiError(
    () => service.deleteOcr({ userId: USER, ocrId: job.target_ref.id, ifMatch: '*', idempotencyKey: nextKey() }),
    'INVALID_REQUEST',
    'If-Match 为 *',
  );
});

// ---------------------------------------------------------------- 提供者 fail-closed

test('反例·real 缺凭据 ⇒ 受理前 fail-closed（PROVIDER_UNAVAILABLE），不排队也不回退替身', async () => {
  const { service, provider } = boot('real');
  assert.equal(provider.available, false, '缺凭据的 real 提供者必须不可用');
  assertString(provider.unavailableReason, 'unavailableReason');
  assert.equal(provider.modelVersion, 'real-unconfigured');
  await assertApiError(
    () => service.createOcr({ userId: USER, body: { media_id: mediaIdForBucket(0), media_revision: 1 }, idempotencyKey: nextKey() }),
    'PROVIDER_UNAVAILABLE',
    'real 缺凭据受理',
  );
  const described = service.describe();
  assert.equal(described.executionMode, 'real');
  assert.equal(described.providerAvailable, false);
  assertString(described.providerUnavailableReason, 'providerUnavailableReason');
  // 未回退替身：model_version 仍为 real 标注。
  assert.equal(described.modelVersion, 'real-unconfigured');
});

test('反例·real 凭据齐备但无已审适配器 ⇒ 任务失败，绝不写成功、不产生 OCR 记录', async () => {
  // 注入替身媒体端口，隔离出「提供者凭据齐备但无已审适配器」这一条路径
  // （real 模式下媒体端口本身也会先 fail-closed，另有专门用例覆盖）。
  const { service } = boot('real', {
    provider: createOcrProvider({ executionMode: 'real', endpoint: 'https://provider.invalid', apiKey: 'x'.repeat(20) }),
    media: createSubstituteMediaPort(),
  });
  const { job } = await service.createOcr({
    userId: USER,
    body: { media_id: mediaIdForBucket(0), media_revision: 1 },
    idempotencyKey: nextKey(),
  });
  await service.settle();
  const settled = await service.getJob({ userId: USER, jobId: job.id });
  assert.notEqual(settled.state, 'succeeded', '提供者失败不得写成 succeeded');
  assert.equal(settled.state, 'failed');
  assert.equal(settled.error_code, 'PROVIDER_UNAVAILABLE');
  assert.equal(settled.result, null, '失败任务不得带出结果');
  await assertApiError(
    () => service.getOcr({ userId: USER, ocrId: job.target_ref.id }),
    'NOT_FOUND',
    '失败任务的记录读取',
  );
});

test('反例·real 模式媒体端口未接线 ⇒ 受理前即 OBJECT_UNAVAILABLE（先于提供者，不静默放过）', async () => {
  const { service, provider } = boot('real', {
    provider: createOcrProvider({ executionMode: 'real', endpoint: 'https://provider.invalid', apiKey: 'x'.repeat(20) }),
  });
  assert.equal(provider.available, true, '本用例的凭据是齐备的，失败必须来自媒体门禁');
  await assertApiError(
    () => service.createOcr({ userId: USER, body: { media_id: mediaIdForBucket(0), media_revision: 1 }, idempotencyKey: nextKey() }),
    'OBJECT_UNAVAILABLE',
    'real 媒体端口未接线',
  );
  assert.equal(service.describe().mediaPort, 'unwired');
});

test('反例·提供者输出协议违规（缺必填字段）⇒ 任务 failed + PROVIDER_OUTCOME_UNKNOWN，不产生记录', async () => {
  const brokenProvider = {
    executionMode: 'stub',
    modelVersion: 'stub-v1',
    available: true,
    unavailableReason: null,
    async extract() {
      // 缺 registration_number：契约 LabelFields 四字段全必填。
      return { kind: 'completed', fields: { name: '缺字段输出', ingredients: [], dosage_form: '水剂' } };
    },
  };
  const { service } = boot('stub', { provider: brokenProvider });
  const { job } = await service.createOcr({
    userId: USER,
    body: { media_id: mediaIdForBucket(0), media_revision: 1 },
    idempotencyKey: nextKey(),
  });
  await service.settle();
  const settled = await service.getJob({ userId: USER, jobId: job.id });
  assert.equal(settled.state, 'failed');
  assert.equal(settled.error_code, 'PROVIDER_OUTCOME_UNKNOWN');
  assert.equal(settled.result, null);
  await assertApiError(() => service.getOcr({ userId: USER, ocrId: job.target_ref.id }), 'NOT_FOUND', '协议违规的记录读取');
});

test('反例·提供者抛错 ⇒ 任务 failed（不得落 succeeded）', async () => {
  const throwingProvider = {
    executionMode: 'stub',
    modelVersion: 'stub-v1',
    available: true,
    unavailableReason: null,
    async extract() {
      throw new Error('替身注入故障');
    },
  };
  const { service } = boot('stub', { provider: throwingProvider });
  const { job } = await service.createOcr({
    userId: USER,
    body: { media_id: mediaIdForBucket(0), media_revision: 1 },
    idempotencyKey: nextKey(),
  });
  await service.settle();
  const settled = await service.getJob({ userId: USER, jobId: job.id });
  assert.equal(settled.state, 'failed');
  assert.notEqual(settled.state, 'succeeded');
  assert.equal(settled.error_code, 'PROVIDER_OUTCOME_UNKNOWN');
});

// ---------------------------------------------------------------- delete / 幂等

test('deleteOCR·软删除后 getOCR 一律 NOT_FOUND', async () => {
  const { service } = boot();
  const { job, ocr } = await createAndSettle(service, USER, { bucket: 0 });
  const ack = await service.deleteOcr({
    userId: USER,
    ocrId: job.target_ref.id,
    ifMatch: `"${ocr.revision}"`,
    idempotencyKey: nextKey(),
  });
  assert.equal(ack.accepted, true);
  await assertApiError(() => service.getOcr({ userId: USER, ocrId: job.target_ref.id }), 'NOT_FOUND', '删除后读取');
});

test('幂等·同一 Idempotency-Key 与同一请求体重放返回同一任务', async () => {
  const { service } = boot();
  const mediaId = mediaIdForBucket(0);
  const key = nextKey();
  const first = await service.createOcr({ userId: USER, body: { media_id: mediaId, media_revision: 1 }, idempotencyKey: key });
  const second = await service.createOcr({ userId: USER, body: { media_id: mediaId, media_revision: 1 }, idempotencyKey: key });
  assert.equal(second.replayed, true);
  assert.equal(second.job.id, first.job.id, '同键重放必须收敛到同一任务');
  await service.settle();
});

test('反例·同一 Idempotency-Key 配不同请求体 ⇒ IDEMPOTENCY_CONFLICT', async () => {
  const { service } = boot();
  const key = nextKey();
  await service.createOcr({ userId: USER, body: { media_id: mediaIdForBucket(0), media_revision: 1 }, idempotencyKey: key });
  await assertApiError(
    () => service.createOcr({ userId: USER, body: { media_id: mediaIdForBucket(1), media_revision: 1 }, idempotencyKey: key }),
    'IDEMPOTENCY_CONFLICT',
    '同键不同请求体',
  );
  await service.settle();
});

test('describe·未接线端口如实暴露 kind 与说明（供证据文档引用）', async () => {
  const { service } = boot('real');
  const described = service.describe();
  assert.equal(described.referencePort, 'unwired');
  assert.equal(described.mediaPort, 'unwired');
  assert.equal(described.dosePort, 'unwired');
  assertString(described.referenceNote, 'referenceNote');
  assertString(described.mediaNote, 'mediaNote');
  assertString(described.doseNote, 'doseNote');
  assert.equal(described.referenceAvailable, false);
});

test('反例·替身用量端口恒返回空（不得以模拟记录呈现真实用量，也不得凭空补造）', async () => {
  const dosePort = createSubstituteDosePort();
  assert.equal(dosePort.kind, 'substitute');
  // 命中已登记制剂的登记号也不得给候选 —— 替身不提供用量。
  assertEmptyArray(await dosePort.listCandidates({ registrationNumber: 'PD20210001' }), 'PD20210001 的候选');
  assertEmptyArray(await dosePort.listCandidates({ registrationNumber: 'PD20210002' }), 'PD20210002 的候选');
  // 歧义记录、未命中、null 一律为空。
  assertEmptyArray(await dosePort.listCandidates({ registrationNumber: 'PD20210003' }), 'PD20210003 的候选');
  assertEmptyArray(await dosePort.listCandidates({ registrationNumber: 'PD99999999' }), '未命中登记号的候选');
  assertEmptyArray(await dosePort.listCandidates({ registrationNumber: null }), '登记号为 null 的候选');

  // 未接线端口同样恒空。
  const unwiredPort = createUnwiredDosePort();
  assert.equal(unwiredPort.kind, 'unwired');
  assertEmptyArray(await unwiredPort.listCandidates({ registrationNumber: 'PD20210001' }), '未接线端口的候选');

  // 两种执行模式经工厂装配都恒空（生产路径不可能产出用量卡）。
  for (const mode of ['stub', 'preset_demo', 'real']) {
    const port = createOcrDosePort(mode);
    assertEmptyArray(await port.listCandidates({ registrationNumber: 'PD20210001' }), `${mode} 模式的候选`);
  }

  // 登记库替身端口仍然可用（替身只服务核对链路，不服务用量）。
  const referencePort = createSubstituteReferencePort();
  const lookup = await referencePort.lookup({ registrationNumber: 'PD20210005', name: '替身示例复配歧义剂' });
  assert.equal(lookup.status, 'available');
  assert.equal(lookup.candidates.length, 2, '靠名称应命中两条歧义记录');
});

// ---------------------------------------------------------------- 幂等并发（先占位再建任务）

/** 包一层计数，用于断言「提供者恰好被调用一次」。 */
function withCallCounter(inner) {
  const state = { calls: 0 };
  return {
    state,
    provider: {
      executionMode: inner.executionMode,
      modelVersion: inner.modelVersion,
      available: inner.available,
      unavailableReason: inner.unavailableReason,
      async extract(input) {
        state.calls += 1;
        return inner.extract(input);
      },
    },
  };
}

test('反例·同键同体**并发** createOCR 只受理一次：恰好 1 个任务、恰好 1 次提供者调用', async () => {
  const counter = withCallCounter(createOcrProvider({ executionMode: 'stub' }));
  const { service } = boot('stub', { provider: counter.provider });
  const mediaId = mediaIdForBucket(0);
  const key = nextKey();
  const body = { media_id: mediaId, media_revision: 1 };

  const results = await Promise.allSettled([
    service.createOcr({ userId: USER, body, idempotencyKey: key }),
    service.createOcr({ userId: USER, body, idempotencyKey: key }),
    service.createOcr({ userId: USER, body, idempotencyKey: key }),
  ]);
  await service.settle();

  const fulfilled = results.filter((item) => item.status === 'fulfilled').map((item) => item.value);
  const rejected = results.filter((item) => item.status === 'rejected');
  assert.ok(fulfilled.length >= 1, '至少一个并发请求应当成功');

  // 硬要求 1：所有成功者必须收敛到**同一个**任务。
  const jobIds = new Set(fulfilled.map((item) => item.job.id));
  assert.equal(jobIds.size, 1, `并发同键必须收敛到同一任务，实际 ${JSON.stringify([...jobIds])}`);
  // 硬要求 2：恰好一个请求是首次受理（replayed=false）。
  assert.equal(fulfilled.filter((item) => item.replayed === false).length, 1);
  // 硬要求 3：提供者**恰好**被调用 1 次（若建出 2 个任务这里会是 2）。
  assert.equal(counter.state.calls, 1, `提供者调用次数应为 1，实际 ${counter.state.calls}`);
  // 落败者只能是契约内的 REQUEST_IN_PROGRESS，不得静默重复建单。
  for (const item of rejected) {
    assert.equal(item.reason.name, 'ApiError', `落败者应为 ApiError，实际 ${item.reason.name}`);
    assert.equal(item.reason.code, 'REQUEST_IN_PROGRESS');
  }

  // 落定之后，同键再请求必须回放同一任务（pending 已解除）。
  const settled = await service.createOcr({ userId: USER, body, idempotencyKey: key });
  assert.equal(settled.replayed, true);
  assert.equal(settled.job.id, [...jobIds][0]);
  assert.equal(counter.state.calls, 1, '重放不得再次调用提供者');
});

test('反例·同键不同体并发 ⇒ 一个受理、另一个 IDEMPOTENCY_CONFLICT', async () => {
  const { service } = boot();
  const key = nextKey();
  const results = await Promise.allSettled([
    service.createOcr({ userId: USER, body: { media_id: mediaIdForBucket(0), media_revision: 1 }, idempotencyKey: key }),
    service.createOcr({ userId: USER, body: { media_id: mediaIdForBucket(1), media_revision: 1 }, idempotencyKey: key }),
  ]);
  await service.settle();
  const rejected = results.filter((item) => item.status === 'rejected');
  assert.equal(rejected.length, 1, '不同请求体共用同一键必须有且仅有一个被拒');
  assert.equal(rejected[0].reason.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
});

test('反例·同键并发 correctOCR 只生效一次（revision 只 +1，落败者为 REQUEST_IN_PROGRESS）', async () => {
  const { service } = boot();
  const { job, ocr } = await createAndSettle(service, USER, { bucket: 0 });
  const key = nextKey();
  const correctedFields = {
    registration_number: 'PD20210002',
    name: '并发校正',
    ingredients: [{ name: '乙草胺', content_text: '50', unit_text: '%' }],
    dosage_form: '乳油',
  };
  const results = await Promise.allSettled([
    service.correctOcr({ userId: USER, ocrId: job.target_ref.id, body: { corrected_fields: correctedFields }, ifMatch: `"${ocr.revision}"`, idempotencyKey: key }),
    service.correctOcr({ userId: USER, ocrId: job.target_ref.id, body: { corrected_fields: correctedFields }, ifMatch: `"${ocr.revision}"`, idempotencyKey: key }),
  ]);
  const after = await service.getOcr({ userId: USER, ocrId: job.target_ref.id });
  // 关键：并发同键不得把同一次校正应用两遍。
  assert.equal(after.revision, ocr.revision + 1, `revision 只应 +1，实际 ${after.revision}`);
  assert.equal(after.corrected_fields.registration_number, 'PD20210002');
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  const rejected = results.filter((item) => item.status === 'rejected');
  assert.equal(rejected[0].reason.code, 'REQUEST_IN_PROGRESS');
  // raw_fields 依旧未被触碰。
  assert.equal(after.raw_fields.registration_number, 'PD20210001');
});

test('反例·占位在业务失败后必须释放，同键可正常重试（不得留下永久 pending）', async () => {
  const { service } = boot();
  const { job, ocr } = await createAndSettle(service, USER, { bucket: 0 });
  const key = nextKey();
  const correctedFields = {
    registration_number: 'PD20210002',
    name: '重试校正',
    ingredients: [],
    dosage_form: '乳油',
  };
  // 首次用错误 revision：应如实 REVISION_CONFLICT，并释放占位。
  await assertApiError(
    () =>
      service.correctOcr({
        userId: USER,
        ocrId: job.target_ref.id,
        body: { corrected_fields: correctedFields },
        ifMatch: '"99"',
        idempotencyKey: key,
      }),
    'REVISION_CONFLICT',
    '错误 revision 的首次校正',
  );
  // 同键改对 revision 重试必须成功（若占位未释放，这里会得到 REQUEST_IN_PROGRESS）。
  const corrected = await service.correctOcr({
    userId: USER,
    ocrId: job.target_ref.id,
    body: { corrected_fields: correctedFields },
    ifMatch: `"${ocr.revision}"`,
    idempotencyKey: key,
  });
  assert.equal(corrected.corrected_fields.registration_number, 'PD20210002');
  assert.equal(corrected.revision, ocr.revision + 1);
});

test('反例·deleteOCR 同键并发只删除一次，且成功后可回放 202', async () => {
  const { service } = boot();
  const { job, ocr } = await createAndSettle(service, USER, { bucket: 0 });
  const key = nextKey();
  const results = await Promise.allSettled([
    service.deleteOcr({ userId: USER, ocrId: job.target_ref.id, ifMatch: `"${ocr.revision}"`, idempotencyKey: key }),
    service.deleteOcr({ userId: USER, ocrId: job.target_ref.id, ifMatch: `"${ocr.revision}"`, idempotencyKey: key }),
  ]);
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  const rejected = results.filter((item) => item.status === 'rejected');
  assert.equal(rejected[0].reason.code, 'REQUEST_IN_PROGRESS');
  // 重放：同键再次调用应回放 accepted，而不是因为已删除而 404。
  const replay = await service.deleteOcr({
    userId: USER,
    ocrId: job.target_ref.id,
    ifMatch: `"${ocr.revision}"`,
    idempotencyKey: key,
  });
  assert.equal(replay.accepted, true);
  await assertApiError(() => service.getOcr({ userId: USER, ocrId: job.target_ref.id }), 'NOT_FOUND', '删除后读取');
});

// ---------------------------------------------------------------- 2a 薄适配的等价性（可执行断言）

/**
 * 阶段 2a 在 `ocr/service.ts` **纯追加**了 `verifyOcrWithRevision` / `deleteOcrWithRevision`
 * （供路由写契约要求的强 ETag；`Verification` 是 `additionalProperties:false` 的五字段对象，
 * 塞不进 revision），既有 `verifyOcr` / `deleteOcr` 改为**委托**。
 *
 * 下面两条把"既有函数返回值与语义逐字节不变"从**声明**变成**可执行断言**：
 * 同一输入 × 两条独立记录（同样的替身脚本与同样的请求体）⇒ 两条路径产出的结果必须**逐字段相同**，
 * 且 `deleteOcr` 的返回对象**键集恰为 `{accepted}`**（不得多出内部 revision）。
 */

test('等价性·verifyOcr(...) 与 verifyOcrWithRevision(...).verification 逐字段相同', async () => {
  const { service } = boot();
  // 两条独立记录：同一分桶 ⇒ 替身脚本产出完全相同的 raw_fields。
  const first = await createAndSettle(service, USER, { bucket: 0 });
  const second = await createAndSettle(service, USER, { bucket: 0 });
  assert.deepEqual(first.ocr.raw_fields, second.ocr.raw_fields, '前提：两条记录的原始字段应相同');
  assert.equal(first.ocr.revision, 1);
  assert.equal(second.ocr.revision, 1);

  const body = { fields: first.ocr.raw_fields, conditions: { ...DOSE_CONDITIONS_SAMPLE } };
  const legacy = await service.verifyOcr({
    userId: USER,
    ocrId: first.job.target_ref.id,
    body,
    ifMatch: '"1"',
    idempotencyKey: nextKey(),
  });
  const adapted = await service.verifyOcrWithRevision({
    userId: USER,
    ocrId: second.job.target_ref.id,
    body,
    ifMatch: '"1"',
    idempotencyKey: nextKey(),
  });

  // 逐字段相同（不是"都非空"这类弱断言）。
  assert.deepEqual(adapted.verification, legacy, '两条路径的 verification 必须逐字段相同');
  assert.deepEqual(Object.keys(adapted.verification).sort(), ['conflict_fields', 'dose_cards', 'match_state', 'missing_fields', 'registration']);
  assert.equal(adapted.verification.match_state, 'matched');
  // 新增的分支只多带回 revision，且该 revision 与落库记录一致。
  assert.equal(adapted.revision, 2, 'verify 后 revision 应为 2');
  const persisted = await service.getOcr({ userId: USER, ocrId: second.job.target_ref.id });
  assert.equal(persisted.revision, adapted.revision);
  assert.deepEqual(persisted.verification, legacy, '落库后的 verification 也应与既有路径一致');
});

test('等价性·deleteOcr(...) 与 deleteOcrWithRevision(...) 的 accepted 相同，且返回值键集不变', async () => {
  const { service } = boot();
  const first = await createAndSettle(service, USER, { bucket: 0 });
  const second = await createAndSettle(service, USER, { bucket: 0 });

  const legacy = await service.deleteOcr({
    userId: USER,
    ocrId: first.job.target_ref.id,
    ifMatch: '"1"',
    idempotencyKey: nextKey(),
  });
  const adapted = await service.deleteOcrWithRevision({
    userId: USER,
    ocrId: second.job.target_ref.id,
    ifMatch: '"1"',
    idempotencyKey: nextKey(),
  });

  // 既有返回值必须**恰为** { accepted: true }：既逐字段相等，键集也不得漂移。
  assert.deepEqual(legacy, { accepted: true });
  assert.deepEqual(Object.keys(legacy).sort(), ['accepted'], 'deleteOcr 返回值不得多出内部字段');
  assert.equal(adapted.accepted, legacy.accepted);
  assert.equal(adapted.revision, 2, '删除后 revision 应为 2');
  // 新增分支多出的只有 revision（这正是路由写 ETag 需要的）。
  const { revision, ...rest } = adapted;
  assert.equal(revision, 2);
  assert.deepEqual(rest, legacy, '去掉新增的 revision 后必须与既有返回值逐字段相同');
});

// ---------------------------------------------------------------- 可重试口径（GY-R31 / #7）

/** **负臂**（独立成例，改动前后都必须绿）：确定性请求错误仍是 400 `INVALID_REQUEST` 且 `retryable:false`。 */
test('可重试口径·负臂：非法请求体 ⇒ 400 INVALID_REQUEST 仍 retryable:false（两种状态下都必须绿）', async () => {
  const { service } = boot('stub');
  await assert.rejects(
    () => service.createOcr({
      userId: USER,
      body: { media_id: mediaIdForBucket(0), media_revision: 1, extra_field: true },
      idempotencyKey: nextKey(),
    }),
    error => {
      assert.equal(error.code, 'INVALID_REQUEST');
      assert.equal(error.status, 400, '状态码口径不变：仍为 400');
      assert.equal(error.retryable, false, '请求体不合契约是确定性拒绝，不得谎称可重试');
      return true;
    },
  );
});

/**
 * 「同一 Idempotency-Key 的请求仍在处理中」是**时间能解决的瞬时态**（等待后重放不会重复执行副作用），
 * 且 HTTP 出口已为该码发 `Retry-After: 1`（`services/api/src/app.ts:1836-1837`）⇒ 必须 `retryable: true`。
 * 状态码仍是 409（**不变**）。
 *
 * 确定性构造：占位者已落定（`pending:false`）但其结果引用的 `job_id` 从未落库 ⇒ `createOcr` 走到 `inProgress()`。
 */
test('可重试口径·同键占位未落定 ⇒ 409 REQUEST_IN_PROGRESS 且 retryable:true（状态码不变）', async () => {
  const base = createMemoryOcrStore();
  let claimed = null;
  const occupied = {
    ...base,
    async claimIdempotent(scope, keyHashHex, row) {
      claimed = { scope, keyHashHex, row };
      return 'exists';
    },
    async findIdempotent(scope, keyHashHex) {
      if (claimed === null || claimed.scope !== scope || claimed.keyHashHex !== keyHashHex) return null;
      return { ...claimed.row, pending: false };
    },
  };
  const { service } = boot('stub', { store: occupied });
  await assert.rejects(
    () => service.createOcr({
      userId: USER,
      body: { media_id: mediaIdForBucket(0), media_revision: 1 },
      idempotencyKey: nextKey(),
    }),
    error => {
      assert.equal(error.name, 'ApiError');
      assert.equal(error.code, 'REQUEST_IN_PROGRESS');
      assert.equal(error.status, 409, '状态码口径不变：仍为 409');
      assert.equal(error.retryable, true, 'REQUEST_IN_PROGRESS 必须可重试（与 Retry-After: 1 一致）');
      return true;
    },
  );
});
