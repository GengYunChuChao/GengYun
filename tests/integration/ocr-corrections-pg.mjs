/**
 * GY-I10（#10）· 用户校正台账 + 冲突阻断的**真库**证据（PostgreSQL 17.11）。
 *
 * 本臂只主张四件事，且每件都在**真 PG**上取证（内存 store 证不了 jsonb 往返与重启后仍在）：
 *   [1] 校正台账真的落进 `ocr_records.verification->'correction_log'`（jsonb 数组长度、actor 逐字），
 *       且 `raw_fields` 列**一个字节都没被改写**。
 *   [2] 关掉连接、新 Pool、新 store 重开 ⇒ 台账与原文都还在（append-only 的持久性）。
 *   [3] 契约投影：HTTP 面仍是**五字段**，`correction_log` 不外泄。
 *   [4] 负控制（必须真的能红）：库侧把 `raw_fields` 改掉 ⇒ `assertRawPreserved` 抛「原文被覆盖」；
 *       原样写回 ⇒ 复绿。
 *
 * 运行（专用测试库必须是**空库**）：
 *   createdb -h 127.0.0.1 -p <port> gengyun_ocr_corrections_test
 *   OCR_PG_TEST_URL=postgres://postgres@127.0.0.1:<port>/gengyun_ocr_corrections_test \
 *     node tests/integration/ocr-corrections-pg.mjs
 *
 * 未设置环境变量 ⇒ 打印 SKIP 并以 77 退出（未取得，不是通过）。
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';

import { STUB_IDEMPOTENCY_HMAC_KEY } from '../../services/api/src/auth/service.ts';
import { createPostgresAuthStore } from '../../services/api/src/auth/store.ts';
import { applyMigrations } from '../../services/api/src/db/migrate.ts';
import { createSubstituteMediaPort } from '../../services/api/src/ocr/media.ts';
import { createOcrProvider } from '../../services/api/src/ocr/provider.ts';
import {
  createSubstituteDosePort,
  createSubstituteReferencePort,
} from '../../services/api/src/ocr/reference.ts';
import { createOcrService } from '../../services/api/src/ocr/service.ts';
import { createPostgresOcrStore } from '../../services/api/src/ocr/store-pg.ts';
import { assertRawPreserved, MAX_INGREDIENTS, MAX_LABEL_TEXT_LENGTH, MAX_RENDERED_FIELD_LENGTH } from '../../services/api/src/ocr/state.ts';

const ENV = 'OCR_PG_TEST_URL';
const DB = 'gengyun_ocr_corrections_test';
const rawUrl = process.env[ENV];
if (rawUrl === undefined || rawUrl.trim() === '') {
  console.log(`SKIP real PG17: ${ENV} 未设置 —— 本次运行没有验证真库（不是通过，也不是失败）。`);
  process.exit(77);
}
const url = new URL(rawUrl);
assert.ok(['postgres:', 'postgresql:'].includes(url.protocol), `${ENV} 必须是 postgres URL`);
assert.equal(url.search, '', '连接参数由脚本控制，测试 URL 不带查询串');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), `只允许回环地址，实际 ${url.hostname}`);
assert.equal(url.pathname, `/${DB}`, `只允许专用测试库 ${DB}`);

let passed = 0;
const say = (message) => {
  passed += 1;
  console.log(`PASS ${passed}: ${message}`);
};

const T0 = new Date('2026-05-01T02:03:04.000Z');
const RAW = {
  registration_number: 'PD20210001',
  name: '替身示例草甘膦水剂',
  ingredients: [{ name: '草甘膦', content_text: '41', unit_text: '%' }],
  dosage_form: '水剂',
};
const VERIFICATION_KEYS = ['conflict_fields', 'dose_cards', 'match_state', 'missing_fields', 'registration'];

function makeOcrRow(ownerUserId, overrides = {}) {
  return {
    id: randomUUID(),
    revision: 1,
    ownerUserId,
    mediaId: randomUUID(),
    mediaRevision: 1,
    rawFields: structuredClone(RAW),
    correctedFields: structuredClone(RAW),
    verification: {
      match_state: 'no_match',
      registration: null,
      conflict_fields: [],
      missing_fields: [],
      dose_cards: [],
    },
    modelVersion: 'test-injected-ocr/1',
    createdAt: T0,
    updatedAt: T0,
    deleted: false,
    ...overrides,
  };
}

function newService(pool) {
  return createOcrService({
    store: createPostgresOcrStore({ pool }),
    provider: createOcrProvider({ executionMode: 'stub' }),
    media: createSubstituteMediaPort(),
    reference: createSubstituteReferencePort(),
    dose: createSubstituteDosePort(),
    idempotencyHmacKey: STUB_IDEMPOTENCY_HMAC_KEY ?? 'gengyun-stub-idempotency-hmac-key',
  });
}

const pool = new pg.Pool({ connectionString: rawUrl });
const one = async (text, params) => (await pool.query(text, params)).rows[0];
let keyCounter = 0;
const nextKey = () => `ocr-i10-pg-${String((keyCounter += 1)).padStart(6, '0')}`;

try {
  const publicTables = await one("SELECT count(*)::int AS v FROM pg_tables WHERE schemaname = 'public'");
  assert.equal(publicTables.v, 0, `库 ${DB} 必须是空库（现场 public 表数 ${publicTables.v}）`);

  const applied = await applyMigrations(pool);
  assert.ok(applied.applied.length > 0, '迁移必须真的执行');
  say(`[0] 迁移全部应用到空库（${applied.applied.length} 个版本），ocr_records 就位`);

  const authStore = createPostgresAuthStore({ query: (text, params) => pool.query(text, params) });
  const subject = randomBytes(32).toString('hex');
  const user = await authStore.createUser(subject);
  say(`[0] 夹具主体 ${user.id} 已落 users 表（OCR 记录对 users 有外键）`);

  const store = createPostgresOcrStore({ pool });
  const service = newService(pool);
  const row = makeOcrRow(user.id);
  await store.insertOcr(row);

  // [1] 两次校正 ⇒ 台账两版，raw_fields 列不动。
  const first = await service.correctOcr({
    userId: user.id,
    ocrId: row.id,
    body: { corrected_fields: { ...RAW, dosage_form: '乳油' } },
    ifMatch: '"1"',
    idempotencyKey: nextKey(),
  });
  assert.deepEqual(Object.keys(first.verification).sort(), VERIFICATION_KEYS, '[1] HTTP 投影必须严格五字段');
  const second = await service.correctOcr({
    userId: user.id,
    ocrId: row.id,
    body: { corrected_fields: { ...RAW, dosage_form: '乳油', name: '用户手改名' } },
    ifMatch: `"${first.revision}"`,
    idempotencyKey: nextKey(),
  });
  assert.equal(second.revision, first.revision + 1);

  const dbFirst = await one(
    `SELECT jsonb_array_length(verification->'correction_log'->'entries') AS entries,
            verification->'correction_log'->'entries'->0->>'actor_user_id' AS actor,
            verification->'correction_log'->'entries'->0->'changes'->0->>'field' AS field,
            raw_fields->>'dosage_form' AS raw_form,
            corrected_fields->>'dosage_form' AS corrected_form,
            verification ? 'correction_log' AS has_ledger
       FROM public.ocr_records WHERE id = $1`,
    [row.id],
  );
  assert.equal(dbFirst.entries, 2, '[1] 真库 jsonb 数组长度必须是 2');
  assert.equal(dbFirst.actor, user.id, '[1] 真库必须逐字记下「谁改的」');
  assert.equal(dbFirst.field, 'dosage_form', '[1] 真库必须记下「改了哪个字段」');
  assert.equal(dbFirst.raw_form, '水剂', '[1] raw_fields 列不得被校正改写');
  assert.equal(dbFirst.corrected_form, '乳油', '[1] corrected_fields 列是校正后的这一版');
  assert.equal(dbFirst.has_ledger, true, '[1] 台账键必须真的落进 verification jsonb');
  say('[1] 两版校正逐字落库：entries=2、actor=夹具主体、changes.field=dosage_form、raw_fields 未被改写');

  // [2] 关连接 / 新 Pool / 新 store ⇒ 台账与原文都还在。
  const rowBeforeRestart = await store.getOcr(row.id);
  const fingerprint = JSON.stringify({
    raw: rowBeforeRestart.rawFields,
    corrected: rowBeforeRestart.correctedFields,
    ledger: rowBeforeRestart.verification.correction_log,
  });
  await pool.end();
  const pool2 = new pg.Pool({ connectionString: rawUrl });
  try {
    const store2 = createPostgresOcrStore({ pool: pool2 });
    const rowAfterRestart = await store2.getOcr(row.id);
    const fingerprint2 = JSON.stringify({
      raw: rowAfterRestart.rawFields,
      corrected: rowAfterRestart.correctedFields,
      ledger: rowAfterRestart.verification.correction_log,
    });
    assert.equal(fingerprint2, fingerprint, '[2] 重启后台账与原文必须逐字节相等');
    assert.equal(rowAfterRestart.verification.correction_log.entries.length, 2, '[2] 重启后台账仍是两版');
    assert.deepEqual(rowAfterRestart.rawFields, RAW, '[2] 重启后原文仍是模型原始输出');
    say('[2] 关连接 + 新 Pool + 新 store：台账两版与 raw_fields 逐字节相等（真·持久）');

    // [3] 契约投影五字段（台账在投影处被剥掉）。
    const projection = await newService(pool2).getOcr({ userId: user.id, ocrId: row.id });
    assert.deepEqual(Object.keys(projection.verification).sort(), VERIFICATION_KEYS, '[3] 对外必须是五字段');
    assert.equal(projection.verification.correction_log, undefined, '[3] 台账不得外泄到契约面');
    say('[3] 契约投影严格五字段：correction_log 不外泄');

    // [4] 负控制：库侧改写 raw_fields ⇒ 必须抛「原文被覆盖」；写回 ⇒ 复绿。
    await pool2.query(
      `UPDATE public.ocr_records SET raw_fields = jsonb_set(raw_fields, '{name}', '"被覆盖的名字"') WHERE id = $1`,
      [row.id],
    );
    const tampered = await store2.getOcr(row.id);
    assert.throws(
      () => assertRawPreserved(tampered.verification.correction_log, tampered.rawFields),
      /原文被覆盖/,
      '[4] 库侧改写原文必须被 assertRawPreserved 抓住',
    );
    await pool2.query(`UPDATE public.ocr_records SET raw_fields = $2::jsonb WHERE id = $1`, [row.id, JSON.stringify(RAW)]);
    const restored = await store2.getOcr(row.id);
    assert.doesNotThrow(() => assertRawPreserved(restored.verification.correction_log, restored.rawFields));
    say('[4] 负控制真红：库侧改写 raw_fields ⇒ 「原文被覆盖」；原样写回后复绿');

    // [5] 监工 1927 轮 [P2] 的真库面：**最大合法**校正（20 项 × 每字段 80 字）落库后
    //     必须能被读路径读回（`store-pg.readVerification` 每次都调 `parseCorrectionLedger`）。
    //     旧行为：写回侧不限长、读回侧硬拒 >2000 ⇒ 这条合法校正写进去就再也读不出来。
    const saturated = Array.from({ length: MAX_INGREDIENTS }, (_, index) => {
      const fill = (prefix) => prefix + 'x'.repeat(MAX_LABEL_TEXT_LENGTH - prefix.length);
      return { name: fill(`名${index}-`), content_text: fill(`${index}`), unit_text: fill(`单${index}`) };
    });
    const maxRow = makeOcrRow(user.id);
    await store2.insertOcr(maxRow);
    const maxCorrected = await newService(pool2).correctOcr({
      userId: user.id,
      ocrId: maxRow.id,
      body: { corrected_fields: { ...RAW, ingredients: saturated } },
      ifMatch: '"1"',
      idempotencyKey: nextKey(),
    });
    assert.deepEqual(Object.keys(maxCorrected.verification).sort(), VERIFICATION_KEYS, '[5] HTTP 投影仍是严格五字段');

    const pool3 = new pg.Pool({ connectionString: rawUrl });
    try {
      // 新 Pool ⇒ 只能从 jsonb 读回，读路径必须解析整份台账（含 4897 字符的成分聚合）。
      const store3 = createPostgresOcrStore({ pool: pool3 });
      const backMax = await store3.getOcr(maxRow.id);
      const maxChange = backMax.verification.correction_log.entries[0].changes
        .find((item) => item.field === 'ingredients');
      assert.equal(maxChange.after.length, MAX_RENDERED_FIELD_LENGTH, '[5] 真库读回的聚合串必须与契约上界等长（未截断）');
      assert.equal(maxChange.after.length > 2000, true, '[5] 该形状必须真的越过旧的 2000 字符读回上限');
      assert.deepEqual(backMax.correctedFields.ingredients, saturated, '[5] 校正后的成分必须逐字保留');
      assert.deepEqual(backMax.rawFields, RAW, '[5] raw_fields 列仍不得被校正改写');
      const maxDb = await (await pool3.query(
        `SELECT length(verification->'correction_log'->'entries'->0->'changes'->0->>'after') AS after_len
           FROM public.ocr_records WHERE id = $1`,
        [maxRow.id],
      )).rows[0];
      assert.equal(maxDb.after_len, MAX_RENDERED_FIELD_LENGTH, '[5] 库里存的 after 长度必须与读回一致（没有写侧截断）');
      // 再校正一次 ⇒ 读路径必须仍然可用（一次合法校正不得让该记录「以后都读不了」）。
      const again = await newService(pool3).correctOcr({
        userId: user.id,
        ocrId: maxRow.id,
        body: { corrected_fields: { ...RAW, ingredients: [...saturated].reverse(), dosage_form: '微乳剂' } },
        ifMatch: `"${maxCorrected.revision}"`,
        idempotencyKey: nextKey(),
      });
      assert.equal(again.revision, maxCorrected.revision + 1, '[5] 最大形状落库后仍能做第二次校正');
      const afterAgain = await store3.getOcr(maxRow.id);
      assert.equal(afterAgain.verification.correction_log.entries.length, 2, '[5] 第二版仍落地（纯顺序变化不算改写，dosage_form 才算）');
      say(`[5] 真库：最大合法校正（after=${MAX_RENDERED_FIELD_LENGTH} 字符）写得进也读得回，且能再校正（entries=2）`);
    } finally {
      await pool3.end();
    }
  } finally {
    await pool2.end();
  }

  console.log(`\nOK ${passed} 项真库读数全部通过（数据库 ${DB}）。`);
  process.exit(0);
} catch (error) {
  console.error(`FAIL 真库臂：${error instanceof Error ? error.message : String(error)}`);
  await pool.end().catch(() => {});
  process.exit(1);
}
