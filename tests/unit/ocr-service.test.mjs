/**
 * GY-I10 标签 OCR · 服务层单元回归（Refs #10）。
 *
 * 走**真实服务链路**（内存 store + 替身提供者 + 替身登记库 + 替身用量库），覆盖契约 5 个 operationId
 * 的 fail-closed 语义：越权、revision 冲突、多余字段、提供者失败不得写成功、
 * raw_fields 与 corrected_fields 严格分离、dose_cards 适用性 gate。
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
  SUBSTITUTE_DOSE_CONDITIONS,
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
  const store = createMemoryOcrStore();
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

test('verifyOCR·conditions 齐全且命中时给出用量卡，并绑定登记制剂与六项条件', async () => {
  const { service } = boot();
  const { job, ocr } = await createAndSettle(service, USER, { bucket: 0 });
  const verification = await service.verifyOcr({
    userId: USER,
    ocrId: job.target_ref.id,
    body: { fields: ocr.raw_fields, conditions: { ...SUBSTITUTE_DOSE_CONDITIONS } },
    ifMatch: `"${ocr.revision}"`,
    idempotencyKey: nextKey(),
  });
  assert.equal(verification.match_state, 'matched');
  assertArray(verification.dose_cards, 'dose_cards');
  assert.equal(verification.dose_cards.length, 1, `应放行 1 张，实际 ${verification.dose_cards.length}`);
  const card = verification.dose_cards[0];
  assertString(card.original_text, 'dose_card.original_text');
  assert.equal(card.formulation.registration_number, 'PD20210001', '用量原文必须绑定命中的登记制剂');
  assert.equal(card.conditions.growth_stage, SUBSTITUTE_DOSE_CONDITIONS.growth_stage);
  assert.equal(card.source.review_status, 'verified');
});

test('反例·verifyOCR 不带 conditions 时 dose_cards 必为 []（matched 也不例外）', async () => {
  const { service } = boot();
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

test('反例·conditions 不全（只给 crop_id + region_code）时 dose_cards 必为 []', async () => {
  const { service } = boot();
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

test('反例·conditions 与用量来源绑定条件不一致时 dose_cards 必为 []', async () => {
  const { service } = boot();
  const { job, ocr } = await createAndSettle(service, USER, { bucket: 0 });
  const verification = await service.verifyOcr({
    userId: USER,
    ocrId: job.target_ref.id,
    body: {
      fields: ocr.raw_fields,
      conditions: { ...SUBSTITUTE_DOSE_CONDITIONS, growth_stage: '分蘖期' },
    },
    ifMatch: `"${ocr.revision}"`,
    idempotencyKey: nextKey(),
  });
  assertEmptyArray(verification.dose_cards, '条件不一致时的 dose_cards');
});

test('反例·未命中（no_match / ambiguous）时即使条件齐全 dose_cards 也必为 []', async () => {
  for (const bucket of [3, 4]) {
    const { service } = boot();
    const { job, ocr } = await createAndSettle(service, USER, { bucket });
    const verification = await service.verifyOcr({
      userId: USER,
      ocrId: job.target_ref.id,
      body: { fields: ocr.raw_fields, conditions: { ...SUBSTITUTE_DOSE_CONDITIONS } },
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
    body: { fields: ocr.raw_fields, conditions: { ...SUBSTITUTE_DOSE_CONDITIONS } },
    ifMatch: `"${ocr.revision}"`,
    idempotencyKey: nextKey(),
  });
  assert.equal(verification.match_state, 'matched', '登记库仍可用：匹配状态不受用量端口影响');
  assertEmptyArray(verification.dose_cards, '用量端口未接线时的 dose_cards');
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

test('端口装配·替身用量库只对已登记制剂给候选（歧义那两条没有卡片，不得补造）', async () => {
  const dosePort = createSubstituteDosePort();
  const forFirst = await dosePort.listCandidates({ registrationNumber: 'PD20210001' });
  assert.equal(forFirst.length, 1);
  const forAmbiguous = await dosePort.listCandidates({ registrationNumber: 'PD20210003' });
  assertEmptyArray(forAmbiguous, 'PD20210003 的候选');
  const forNull = await dosePort.listCandidates({ registrationNumber: null });
  assertEmptyArray(forNull, '登记号为 null 的候选');
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
