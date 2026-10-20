/**
 * GY-R27 S10（#10）· `createPostgresOcrStore` 的**语句形状 + 语义**契约（记录型假池，不连库）。
 *
 * 与真库脚本（`tests/integration/ocr-jobs-pg.mjs`）的分工（与仓内 `community-store-pg-contract`
 * 的分层同口径）：
 *   - 这里用假池锁**只有读源码才能判**的性质：CAS 是不是**一条带 `WHERE revision = $n` 的 UPDATE**、
 *     `claimIdempotent` 是不是**单条** `INSERT … ON CONFLICT … WHERE expires_at <= $at`、
 *     `commitTerminal` 是不是在**同一事务**里 `FOR UPDATE` → INSERT → UPDATE、
 *     读取有没有按过期过滤、purge 返回的是不是行数；
 *   - 真库锁**只有数据库能证明**的性质：约束真的存在、迁移三连、关连接重开后仍在。
 *
 * 12 个方法逐条都有用例（与 `OcrStore` 接口顺序一致）。反向控制：同一条 CAS 判据在
 * "revision 命中"与"revision 不命中"两种输入下必须给出不同结果（若退化成"永远成功/永远 null"，必红）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { ApiError } from '../../services/api/src/errors.ts';
import {
  OcrStoreConflictError,
  classifyOcrDatabaseError,
  createPostgresOcrStore,
} from '../../services/api/src/ocr/store-pg.ts';
import { createMemoryOcrStore } from '../../services/api/src/ocr/store.ts';

const OWNER = '11111111-1111-4111-8111-111111111111';
const MEDIA = '22222222-2222-4222-8222-222222222222';

const FIELDS = {
  registration_number: 'PD20261234',
  name: '草甘膦异丙胺盐可溶液剂',
  ingredients: [{ name: '草甘膦异丙胺盐', content_text: '41', unit_text: '%' }],
  dosage_form: '可溶液剂',
};

const VERIFICATION = {
  match_state: 'insufficient',
  registration: null,
  conflict_fields: [],
  missing_fields: ['name'],
  dose_cards: [],
};

const T0 = new Date('2026-10-20T08:00:00.000Z');

function jobRow(overrides = {}) {
  return {
    id: randomUUID(),
    revision: 1,
    kind: 'ocr',
    owner_user_id: OWNER,
    ocr_id: randomUUID(),
    media_id: MEDIA,
    media_revision: 2,
    state: 'queued',
    deadline_at: new Date(T0.getTime() + 30_000),
    created_at: T0,
    updated_at: T0,
    error_code: null,
    ...overrides,
  };
}

function recordRow(overrides = {}) {
  return {
    id: randomUUID(),
    revision: 1,
    owner_user_id: OWNER,
    media_id: MEDIA,
    media_revision: 2,
    raw_fields: FIELDS,
    corrected_fields: FIELDS,
    verification: VERIFICATION,
    model_version: 'stub-v1',
    created_at: T0,
    updated_at: T0,
    deleted: false,
    ...overrides,
  };
}

/** 事务控制语句：由假池固定应答，**不消耗**业务语句脚本（否则每条用例都要先铺 BEGIN/SET LOCAL）。 */
const CONTROL_SQL = /^(BEGIN|COMMIT|ROLLBACK|SET LOCAL .*|RELEASE)$/;

/** 记录型假池：按脚本顺序逐条返回**业务语句**的应答，`Error` 实例表示该条语句抛错。 */
function makeDb(script = []) {
  const log = [];
  let index = 0;
  const next = async (text, values) => {
    const sql = String(text).replace(/\s+/g, ' ').trim();
    log.push({ sql, values });
    if (CONTROL_SQL.test(sql)) return { rows: [] };
    const response = script[index];
    index += 1;
    if (response instanceof Error) throw response;
    return { rows: response ?? [] };
  };
  const pool = {
    query: next,
    async connect() {
      return {
        query: next,
        release() {
          log.push({ sql: 'RELEASE' });
        },
      };
    },
  };
  const sqls = () => log.map((entry) => entry.sql);
  return { pool, log, sqls, store: createPostgresOcrStore({ pool }) };
}

const uniqueViolation = () => Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });

test('store.persistent 如实为 true（内存实现为 false）', () => {
  const { store } = makeDb();
  assert.equal(store.persistent, true);
  assert.equal(createMemoryOcrStore().persistent, false);
});

test('[1] insertJob：单条 INSERT；同 id 冲突由唯一性裁决（23505 ⇒ 与内存同文案的冲突错误）', async () => {
  const row = jobRow();
  const ok = makeDb([[]]);
  await ok.store.insertJob({
    id: row.id,
    revision: 1,
    kind: 'ocr',
    ownerUserId: OWNER,
    ocrId: row.ocr_id,
    mediaId: MEDIA,
    mediaRevision: 2,
    state: 'queued',
    deadlineAt: row.deadline_at,
    createdAt: T0,
    updatedAt: T0,
    errorCode: null,
  });
  assert.equal(ok.log.length, 1, 'insertJob 必须只发一条语句');
  assert.match(ok.sqls()[0], /^INSERT INTO public\.ocr_jobs /);
  assert.equal(ok.log[0].values[0], row.id);

  const dup = makeDb([uniqueViolation()]);
  await assert.rejects(
    () =>
      dup.store.insertJob({
        id: row.id,
        revision: 1,
        kind: 'ocr',
        ownerUserId: OWNER,
        ocrId: row.ocr_id,
        mediaId: MEDIA,
        mediaRevision: 2,
        state: 'queued',
        deadlineAt: row.deadline_at,
        createdAt: T0,
        updatedAt: T0,
        errorCode: null,
      }),
    (error) => error instanceof OcrStoreConflictError && error.message === '任务 id 冲突',
    '同 id 再写必须抛与内存实现同文案的冲突错误（不得折成 PROVIDER_UNAVAILABLE）',
  );
});

test('[2] getJob：按主键单条读；未命中 ⇒ null；行逐字段映射（含 Date 与 error_code）', async () => {
  const row = jobRow({ state: 'failed', error_code: 'PROVIDER_TIMEOUT', revision: 4 });
  const hit = makeDb([[row]]);
  const read = await hit.store.getJob(row.id);
  assert.match(hit.sqls()[0], /^SELECT .* FROM public\.ocr_jobs WHERE id = \$1::uuid$/);
  assert.equal(read.id, row.id);
  assert.equal(read.state, 'failed');
  assert.equal(read.revision, 4);
  assert.equal(read.kind, 'ocr');
  assert.equal(read.ownerUserId, OWNER);
  assert.equal(read.errorCode, 'PROVIDER_TIMEOUT');
  assert.equal(read.deadlineAt instanceof Date, true, 'timestamptz 必须回成 Date');

  const miss = makeDb([[]]);
  assert.equal(await miss.store.getJob(randomUUID()), null, '不存在 ⇒ null（与"查不到"同形）');
});

test('[3] updateJob：CAS 判定在**单条**带 WHERE revision = $n 的 UPDATE；0 行 ⇒ null', async () => {
  const row = jobRow();

  // (a) revision 不匹配 ⇒ null，且**不得**发出 UPDATE
  const stale = makeDb([[row]]);
  const staleResult = await stale.store.updateJob(row.id, 9, (current) => ({ ...current, revision: current.revision + 1 }));
  assert.equal(staleResult, null);
  assert.equal(stale.log.length, 1, 'revision 不匹配时不得发出 UPDATE（现场发了第二条语句）');

  // (b) 命中 ⇒ 一条带 revision 谓词的 UPDATE，返回值即库返回行
  const nextRow = jobRow({ id: row.id, revision: 2, state: 'running', updated_at: T0 });
  const hit = makeDb([[row], [nextRow]]);
  const updated = await hit.store.updateJob(row.id, 1, (current) => ({
    ...current,
    state: 'running',
    revision: current.revision + 1,
  }));
  assert.equal(updated.revision, 2);
  assert.equal(updated.state, 'running');
  assert.match(hit.sqls()[1], /^UPDATE public\.ocr_jobs SET /);
  assert.match(hit.sqls()[1], / WHERE id = \$1::uuid AND revision = \$2 RETURNING /);
  assert.equal(hit.log[1].values[1], 1, 'CAS 的比较值必须是调用方给的 expectedRevision');

  // (c) SELECT 命中但 UPDATE 0 行（两次读之间被并发改写）⇒ null，不覆盖他人写
  const raced = makeDb([[row], []]);
  assert.equal(
    await raced.store.updateJob(row.id, 1, (current) => ({ ...current, revision: current.revision + 1 })),
    null,
    '并发写之后必须返回 null（不得把他人写覆盖掉）',
  );

  // (d) 行不存在 ⇒ null
  const missing = makeDb([[]]);
  assert.equal(await missing.store.updateJob(randomUUID(), 1, (current) => current), null);
});

test('[4] commitTerminal：单事务 BEGIN → FOR UPDATE → INSERT（可空）→ UPDATE → COMMIT', async () => {
  const row = jobRow({ state: 'running', revision: 2 });
  const committed = jobRow({ state: 'succeeded', revision: 3 });
  const db = makeDb([[row], [], [committed]]);
  const result = await db.store.commitTerminal(
    row.id,
    2,
    { state: 'succeeded', errorCode: null },
    {
      id: row.ocr_id,
      revision: 1,
      ownerUserId: OWNER,
      mediaId: MEDIA,
      mediaRevision: 2,
      rawFields: FIELDS,
      correctedFields: FIELDS,
      verification: VERIFICATION,
      modelVersion: 'stub-v1',
      createdAt: T0,
      updatedAt: T0,
      deleted: false,
    },
    T0,
  );
  assert.equal(result.state, 'succeeded');
  assert.equal(result.revision, 3);
  const sqls = db.sqls();
  assert.deepEqual(sqls.slice(0, 2), ['BEGIN', "SET LOCAL lock_timeout = '4s'"]);
  assert.match(sqls[2], /^SELECT .* FROM public\.ocr_jobs WHERE id = \$1::uuid FOR UPDATE$/);
  assert.match(sqls[3], /^INSERT INTO public\.ocr_records /);
  assert.match(sqls[4], /^UPDATE public\.ocr_jobs SET state = \$3, error_code = \$4, revision = revision \+ 1/);
  assert.equal(sqls[5], 'COMMIT');
  assert.equal(sqls[6], 'RELEASE', '连接必须归还（事务结束后）');

  // CAS 失败：只锁读 + COMMIT，**不得**写记录、不得改任务
  const casFail = makeDb([[row]]);
  assert.equal(
    await casFail.store.commitTerminal(row.id, 99, { state: 'succeeded', errorCode: null }, null, T0),
    null,
  );
  assert.deepEqual(casFail.sqls(), ['BEGIN', "SET LOCAL lock_timeout = '4s'", casFail.sqls()[2], 'COMMIT', 'RELEASE']);
  assert.equal(casFail.sqls().some((sql) => sql.startsWith('INSERT')), false, 'CAS 失败不得写任何记录');
  assert.equal(casFail.sqls().some((sql) => sql.startsWith('UPDATE')), false, 'CAS 失败不得改任务行');

  // 非法迁移（终态不可离开）⇒ null 且不写
  const terminal = jobRow({ state: 'cancelled', revision: 3 });
  const illegal = makeDb([[terminal]]);
  assert.equal(
    await illegal.store.commitTerminal(terminal.id, 3, { state: 'succeeded', errorCode: null }, null, T0),
    null,
    '已取消任务不得被迟到结果改写',
  );
  assert.equal(illegal.sqls().some((sql) => sql.startsWith('INSERT')), false);

  // 记录 id 冲突 ⇒ 抛错 + ROLLBACK（任务行不留半成品）
  const conflict = makeDb([[row], uniqueViolation()]);
  await assert.rejects(
    () =>
      conflict.store.commitTerminal(
        row.id,
        2,
        { state: 'succeeded', errorCode: null },
        {
          id: row.ocr_id,
          revision: 1,
          ownerUserId: OWNER,
          mediaId: MEDIA,
          mediaRevision: 2,
          rawFields: FIELDS,
          correctedFields: FIELDS,
          verification: VERIFICATION,
          modelVersion: 'stub-v1',
          createdAt: T0,
          updatedAt: T0,
          deleted: false,
        },
        T0,
      ),
    (error) => error instanceof OcrStoreConflictError && error.message === 'OCR 记录 id 冲突',
  );
  assert.equal(conflict.sqls().includes('ROLLBACK'), true, '记录冲突必须回滚事务');
  assert.equal(conflict.sqls().includes('COMMIT'), false, '记录冲突不得提交');
});

test('[5][6] insertOcr / getOcr：单条 INSERT、同 id 冲突抛错；读出逐字段重建（含 jsonb 三列）', async () => {
  const row = recordRow();
  const insert = makeDb([[]]);
  await insert.store.insertOcr({
    id: row.id,
    revision: 1,
    ownerUserId: OWNER,
    mediaId: MEDIA,
    mediaRevision: 2,
    rawFields: FIELDS,
    correctedFields: FIELDS,
    verification: VERIFICATION,
    modelVersion: 'stub-v1',
    createdAt: T0,
    updatedAt: T0,
    deleted: false,
  });
  assert.match(insert.sqls()[0], /^INSERT INTO public\.ocr_records /);
  assert.equal(insert.log[0].values[5], JSON.stringify(FIELDS), 'raw_fields 以 JSON 文本入参');

  const dup = makeDb([uniqueViolation()]);
  await assert.rejects(
    () =>
      dup.store.insertOcr({
        id: row.id,
        revision: 1,
        ownerUserId: OWNER,
        mediaId: MEDIA,
        mediaRevision: 2,
        rawFields: FIELDS,
        correctedFields: FIELDS,
        verification: VERIFICATION,
        modelVersion: 'stub-v1',
        createdAt: T0,
        updatedAt: T0,
        deleted: false,
      }),
    (error) => error instanceof OcrStoreConflictError && error.message === 'OCR 记录 id 冲突',
  );

  const hit = makeDb([[row]]);
  const read = await hit.store.getOcr(row.id);
  assert.match(hit.sqls()[0], /^SELECT .* FROM public\.ocr_records WHERE id = \$1::uuid$/);
  assert.deepEqual(read.rawFields, FIELDS);
  assert.deepEqual(read.correctedFields, FIELDS);
  assert.deepEqual(read.verification, VERIFICATION);
  assert.equal(read.modelVersion, 'stub-v1');
  assert.equal(read.deleted, false);
  assert.equal(read.createdAt instanceof Date, true);

  assert.equal(await makeDb([[]]).store.getOcr(randomUUID()), null);

  // 坏行：verification 形状不符 ⇒ 内部不变式违反（不静默降级、不当成空对象）
  const broken = makeDb([[{ ...row, verification: null }]]);
  await assert.rejects(
    () => broken.store.getOcr(row.id),
    (error) => error instanceof ApiError && error.code === 'PROVIDER_UNAVAILABLE' && error.retryable === false,
  );
});

test('[7] updateOcr：CAS 单条 UPDATE；白名单列含 raw/corrected/verification/deleted', async () => {
  const row = recordRow();
  const nextRow = recordRow({ id: row.id, revision: 2, deleted: true });
  const hit = makeDb([[row], [nextRow]]);
  const updated = await hit.store.updateOcr(row.id, 1, (current) => ({
    ...current,
    deleted: true,
    revision: current.revision + 1,
  }));
  assert.equal(updated.revision, 2);
  assert.equal(updated.deleted, true);
  const sql = hit.sqls()[1];
  assert.match(sql, /^UPDATE public\.ocr_records SET revision = \$3, raw_fields = \$4::jsonb, corrected_fields = \$5::jsonb, verification = \$6::jsonb, model_version = \$7, updated_at = \$8::timestamptz, deleted = \$9/);
  assert.match(sql, / WHERE id = \$1::uuid AND revision = \$2 RETURNING /);

  const stale = makeDb([[row]]);
  assert.equal(
    await stale.store.updateOcr(row.id, 7, (current) => ({ ...current, revision: current.revision + 1 })),
    null,
  );
  assert.equal(stale.log.length, 1, 'revision 不匹配时不得发出 UPDATE');
});

test('[8] findIdempotent：按 (scope,key_hash) 单条读，**不**按过期过滤（与内存实现逐条一致）', async () => {
  const db = makeDb([
    [{ request_hash: 'h1', payload: { job_id: 'job-1' }, pending: true, expires_at: new Date(T0.getTime() + 1000) }],
  ]);
  const row = await db.store.findIdempotent('scope-1', 'keyhash-1');
  assert.match(db.sqls()[0], /^SELECT request_hash, payload, pending, expires_at FROM public\.ocr_idempotency WHERE scope = \$1 AND key_hash = \$2$/);
  assert.equal(db.sqls()[0].includes('expires_at >'), false, 'findIdempotent 不得按过期过滤（内存实现不过滤）');
  assert.equal(row.requestHash, 'h1');
  assert.deepEqual(row.payload, { job_id: 'job-1' });
  assert.equal(row.pending, true);
  assert.equal(row.expiresAt instanceof Date, true);
  assert.equal(await makeDb([[]]).store.findIdempotent('s', 'k'), null);
});

test('[9] claimIdempotent：单条 INSERT … ON CONFLICT DO UPDATE … WHERE expires_at <= $at 决定 claimed/exists', async () => {
  const row = { requestHash: 'h', expiresAt: new Date(T0.getTime() + 1000), payload: { job_id: 'j' }, pending: true };
  const claimed = makeDb([[{ scope: 's' }]]);
  assert.equal(await claimed.store.claimIdempotent('s', 'k', row, T0), 'claimed');
  assert.match(claimed.sqls()[0], /^INSERT INTO public\.ocr_idempotency /);
  assert.match(claimed.sqls()[0], /ON CONFLICT \(scope, key_hash\) DO UPDATE /);
  assert.match(claimed.sqls()[0], /WHERE public\.ocr_idempotency\.expires_at <= \$7::timestamptz/);
  assert.match(claimed.sqls()[0], /RETURNING scope$/);
  assert.equal(claimed.log.length, 1, 'claimIdempotent 必须是**一条**语句（检查+写入同一临界区）');

  const exists = makeDb([[]]);
  assert.equal(await exists.store.claimIdempotent('s', 'k', row, T0), 'exists');
  assert.equal(exists.log.length, 1);
});

test('[10] finalizeIdempotent：pending ⇒ false 并替换 payload；行不存在是空操作', async () => {
  const db = makeDb([[]]);
  await db.store.finalizeIdempotent('s', 'k', { accepted: true });
  assert.match(db.sqls()[0], /^UPDATE public\.ocr_idempotency SET payload = \$3::jsonb, pending = false WHERE scope = \$1 AND key_hash = \$2$/);
  assert.equal(db.log[0].values[2], JSON.stringify({ accepted: true }));

  const noop = makeDb([[]]);
  await noop.store.finalizeIdempotent('s', 'k', {});
  assert.equal(noop.log.length, 1, '0 行更新也是空操作（不抛错，与内存实现 `if (row === undefined) return;` 同义）');
});

test('[11] releaseIdempotent：无条件 DELETE（与内存实现的 `Map.delete` 同义）', async () => {
  const db = makeDb([[]]);
  await db.store.releaseIdempotent('s', 'k');
  assert.match(db.sqls()[0], /^DELETE FROM public\.ocr_idempotency WHERE scope = \$1 AND key_hash = \$2$/);
});

test('[12] purgeIdempotent：DELETE … RETURNING 并以**行数**作返回值', async () => {
  const db = makeDb([[{ scope: 'a' }, { scope: 'b' }]]);
  assert.equal(await db.store.purgeIdempotent(T0), 2);
  assert.match(db.sqls()[0], /^DELETE FROM public\.ocr_idempotency WHERE expires_at <= \$1::timestamptz RETURNING scope$/);
  assert.deepEqual(db.log[0].values, [T0]);

  const none = makeDb([[]]);
  assert.equal(await none.store.purgeIdempotent(T0), 0);
});

test('错误折叠：57014/55P03 ⇒ PROVIDER_TIMEOUT；其它数据库异常 ⇒ PROVIDER_UNAVAILABLE', () => {
  const timeoutError = Object.assign(new Error('statement timeout'), { code: '57014' });
  assert.throws(
    () => classifyOcrDatabaseError(timeoutError),
    (error) => error instanceof ApiError && error.code === 'PROVIDER_TIMEOUT' && error.retryable === true,
  );
  assert.throws(
    () => classifyOcrDatabaseError(Object.assign(new Error('lock'), { code: '55P03' })),
    (error) => error instanceof ApiError && error.code === 'PROVIDER_TIMEOUT',
  );
  assert.throws(
    () => classifyOcrDatabaseError(Object.assign(new Error('boom'), { code: '42P01' })),
    (error) => error instanceof ApiError && error.code === 'PROVIDER_UNAVAILABLE' && error.retryable === true,
  );
  // 存储层自身的冲突错误必须原样穿过折叠（不得被改写成数据库不可用）。
  assert.throws(
    () => classifyOcrDatabaseError(new OcrStoreConflictError('任务 id 冲突')),
    (error) => error instanceof OcrStoreConflictError && error.message === '任务 id 冲突',
  );
});

test('坏行守卫：state 不在 7 值闭集内 ⇒ 内部不变式违反（不静默降级）', async () => {
  const row = jobRow({ state: 'not_a_state' });
  await assert.rejects(
    () => makeDb([[row]]).store.getJob(row.id),
    (error) => error instanceof ApiError && error.code === 'PROVIDER_UNAVAILABLE' && error.retryable === false,
  );
});
