/**
 * GY-R28 S13（#9）· `createPostgresRecognitionStore` 的**语句形状 + 语义**契约（记录型假池，不连库）。
 *
 * 与真库脚本（`tests/integration/recognitions-pg.mjs`）的分工（与 `ocr-store-pg.test.mjs`、
 * `community-store-pg-contract` 的分层同口径）：
 *   - 这里用假池锁**只有读源码才能判**的性质：CAS 是不是**一条带 `WHERE id = $1::uuid AND revision = $2`
 *     的 UPDATE**、`commitTerminal` 是不是在**同一事务**里 `FOR UPDATE` → INSERT 记录 → UPDATE 任务、
 *     `commitSelection` 的 CAS 失败是不是**根本不写选择行**、`claimIdempotent` 是不是**单条**
 *     `INSERT … ON CONFLICT … WHERE expires_at <= $5`、`purgeIdempotent` 返回的是不是行数；
 *   - 真库锁**只有数据库能证明**的性质：约束真的存在、迁移三连、关连接重开后仍在。
 *
 * 13 个方法逐条都有用例（与 `RecognitionStore` 接口顺序一致）。反向控制：同一条 CAS 判据在
 * "revision 命中"与"revision 不命中"两种输入下必须给出不同结果（若退化成"永远成功/永远 null"，
 * 必有用例红）。文案判据直接与内存实现对照 —— 两条实现的分歧是**行为差异**，不是文案差异。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ApiError } from '../../services/api/src/errors.ts';
import {
  RecognitionStoreConflictError,
  classifyRecognitionDatabaseError,
  createPostgresRecognitionStore,
} from '../../services/api/src/recognitions/store-pg.ts';
import { createMemoryRecognitionStore } from '../../services/api/src/recognitions/store.ts';

const OWNER = '11111111-1111-4111-8111-111111111111';
const FOREIGN = '22222222-2222-4222-8222-222222222222';
const MEDIA = '33333333-3333-4333-8333-333333333333';
const JOB_ID = '44444444-4444-4444-8444-444444444444';
const RECOGNITION_ID = '55555555-5555-4555-8555-555555555555';
const SELECTION_ID = '66666666-6666-4666-8666-666666666666';

const T0 = new Date('2026-10-20T08:00:00.000Z');
const T1 = new Date('2026-10-20T08:00:01.000Z');
const T2 = new Date('2026-10-20T08:00:02.000Z');

/** 最小的合法 `SelectionLinkage`：store 只做 JSON 往返（校验属 linkage.ts 的职责）。 */
const LINKAGE = {
  species_id: 'spp-echinochloa',
  rule_version: 'linkage-v1',
  reference_state: 'unavailable',
  items: [],
  excluded: [],
  applicable_count: 0,
  conditions_complete: false,
  missing_conditions: ['crop_id'],
  blocked_codes: ['CONDITION_MISSING'],
  dose: {
    renderable: false,
    card: null,
    block_code: 'DOSE_BLOCKED',
    blocked_by_path: 'recognition_selection',
    missing_conditions: ['crop_id'],
    conditionally_renderable_count: 0,
    per_item: [],
    rule_version: 'linkage-v1',
  },
  note: '演示环境：未取得可用登记资料',
};

const JOB_ROW = {
  id: JOB_ID,
  revision: 2,
  kind: 'recognition',
  ownerUserId: OWNER,
  recognitionId: RECOGNITION_ID,
  mediaId: MEDIA,
  mediaRevision: 3,
  state: 'running',
  deadlineAt: T1,
  createdAt: T0,
  updatedAt: T1,
  errorCode: null,
};

const RECOGNITION_ROW = {
  id: RECOGNITION_ID,
  revision: 1,
  ownerUserId: OWNER,
  mediaId: MEDIA,
  mediaRevision: 3,
  candidates: [{ species_id: 'spp-echinochloa', rank: 1, model_score: 0.82 }],
  uncertaintyReasons: ['图像分辨率偏低'],
  selectedSpeciesId: null,
  modelVersion: 'mock-2026-10-20',
  createdAt: T0,
  updatedAt: T0,
  deleted: false,
};

/** 数据库行（snake_case + Date）：被测代码必须逐字段映射回契约行。 */
const JOB_DB_ROW = {
  id: JOB_ID,
  revision: 2,
  kind: 'recognition',
  owner_user_id: OWNER,
  recognition_id: RECOGNITION_ID,
  media_id: MEDIA,
  media_revision: 3,
  state: 'running',
  deadline_at: T1,
  created_at: T0,
  updated_at: T1,
  error_code: null,
};

const RECOGNITION_DB_ROW = {
  id: RECOGNITION_ID,
  revision: 1,
  owner_user_id: OWNER,
  media_id: MEDIA,
  media_revision: 3,
  candidates: RECOGNITION_ROW.candidates,
  uncertainty_reasons: RECOGNITION_ROW.uncertaintyReasons,
  selected_species_id: null,
  model_version: RECOGNITION_ROW.modelVersion,
  created_at: T0,
  updated_at: T0,
  deleted: false,
};

const SELECTION_DB_ROW = {
  id: SELECTION_ID,
  revision: 1,
  recognition_id: RECOGNITION_ID,
  owner_user_id: OWNER,
  species_id: 'spp-echinochloa',
  provenance: 'human',
  decided_at: T2,
  linkage: LINKAGE,
};

const CONTROL_SQL = /^(BEGIN|COMMIT|ROLLBACK|SET LOCAL .*|RELEASE)$/;
const PROBE_SQL = /to_regclass/;

/**
 * 记录型假池：探针语句与控制语句**不消耗**业务脚本，因此 `script` 里只放业务语句的应答。
 * 一条语句应答 = 该语句返回的 `rows` 数组（或一个要抛出的 Error）。
 */
function makeDb(script = [], probe = 'ready') {
  const log = [];
  const probes = [];
  let index = 0;
  const answerProbe = () => {
    if (probe instanceof Error) throw probe;
    if (probe === 'ready') return { rows: [{ ready: true }] };
    if (probe === 'missing') return { rows: [{ ready: false }] };
    return { rows: [] };
  };
  const next = async (text, values) => {
    const sql = String(text).replace(/\s+/g, ' ').trim();
    if (PROBE_SQL.test(sql)) {
      probes.push({ sql, values });
      return answerProbe();
    }
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
  const store = createPostgresRecognitionStore({ pool });
  return { pool, log, probes, sqls, store };
}

const uniqueViolation = () =>
  Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });

test('接口形状：persistent = true，且 13 个方法一个不少（与内存实现同名同序）', () => {
  const { store } = makeDb();
  assert.equal(store.persistent, true);
  const methods = [
    'insertJob',
    'getJob',
    'updateJob',
    'commitTerminal',
    'insertRecognition',
    'getRecognition',
    'updateRecognition',
    'commitSelection',
    'listSelections',
    'claimIdempotent',
    'completeIdempotent',
    'releaseIdempotent',
    'purgeIdempotent',
  ];
  for (const name of methods) assert.equal(typeof store[name], 'function', `缺方法 ${name}`);
  const memory = createMemoryRecognitionStore();
  assert.deepEqual(Object.keys(memory).sort(), Object.keys(store).sort());
});

test('insertJob：单条 INSERT，值序 = 契约行字段序；23505 翻成与内存实现同文案的冲突错误', async () => {
  const ok = makeDb([[]]);
  await ok.store.insertJob(JOB_ROW);
  // GY-R71：insertJob 从「单句」变成「一个事务里的两句」——源表 INSERT + 台账 upsert（同一提交点）。
  const okSqls = ok.sqls();
  assert.equal(okSqls[0], 'BEGIN', 'insertJob 必须开事务（台账与源表同一个提交点）');
  assert.match(okSqls[2], /^INSERT INTO public\.recognition_jobs \(/);
  assert.match(okSqls[2], /RETURNING id$/);
  assert.match(okSqls[3], /^INSERT INTO public\.jobs \(/, '台账 upsert 必须紧跟源表 INSERT（同一事务内）');
  assert.match(okSqls[3], /ON CONFLICT \(id\) DO UPDATE/);
  assert.equal(okSqls[4], 'COMMIT');
  assert.equal(okSqls[5], 'RELEASE');
  assert.deepEqual(ok.log[2].values, [
    JOB_ID,
    2,
    'recognition',
    OWNER,
    RECOGNITION_ID,
    MEDIA,
    3,
    'running',
    T1,
    T0,
    T1,
    null,
  ]);

  const dup = makeDb([uniqueViolation()]);
  const error = await dup.store.insertJob(JOB_ROW).then(
    () => null,
    (thrown) => thrown,
  );
  assert.ok(error instanceof RecognitionStoreConflictError, '重复 id 必须是冲突错误');
  const memory = createMemoryRecognitionStore();
  await memory.insertJob(JOB_ROW);
  const memoryError = await memory.insertJob(JOB_ROW).then(
    () => null,
    (thrown) => thrown,
  );
  assert.equal(error.message, memoryError.message, '文案必须与内存实现逐字相同');
  assert.equal(error.message, '任务 id 冲突');
});

test('getJob：单条 SELECT + 行映射（snake_case ⇒ 契约行，时间列回 Date）；未命中 ⇒ null', async () => {
  const hit = makeDb([[JOB_DB_ROW]]);
  const row = await hit.store.getJob(JOB_ID);
  assert.deepEqual(hit.sqls(), [
    'SELECT id, revision, kind, owner_user_id, recognition_id, media_id, media_revision, state, deadline_at, created_at, updated_at, error_code FROM public.recognition_jobs WHERE id = $1::uuid',
  ]);
  assert.deepEqual(hit.log[0].values, [JOB_ID]);
  assert.deepEqual(row, JOB_ROW);
  assert.ok(row.createdAt instanceof Date);

  const miss = makeDb([[]]);
  assert.equal(await miss.store.getJob(JOB_ID), null);
});

test('getJob：库里的 state 超出闭集 ⇒ 内部不变式错误（fail-closed，不返回半成品行）', async () => {
  const db = makeDb([[{ ...JOB_DB_ROW, state: 'done' }]]);
  const error = await db.store.getJob(JOB_ID).then(
    () => null,
    (thrown) => thrown,
  );
  assert.ok(error instanceof ApiError);
  assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(error.retryable, false);
  assert.match(error.message, /形状不合约定/);
});

test('updateJob：CAS 是**一条带 WHERE id AND revision 的 UPDATE**；revision 命中与不命中必须分叉', async () => {
  const mutate = (row) => ({ ...row, revision: row.revision + 1, state: 'running', updatedAt: T2 });

  // 命中：SELECT 快照 revision=2，期望 2 ⇒ 发 UPDATE，返回改写后的行。
  const hit = makeDb([[JOB_DB_ROW], [{ ...JOB_DB_ROW, revision: 3, updated_at: T2 }]]);
  const updated = await hit.store.updateJob(JOB_ID, 2, mutate);
  assert.match(hit.sqls()[2], /^SELECT .* FROM public\.recognition_jobs WHERE id = \$1::uuid$/);
  assert.match(
    hit.sqls()[3],
    /^UPDATE public\.recognition_jobs SET .* WHERE id = \$1::uuid AND revision = \$2 RETURNING /,
  );
  assert.match(hit.sqls()[4], /^INSERT INTO public\.jobs \(/, 'running 迁移必须在同一事务里写台账');
  assert.deepEqual(hit.log[3].values, [
    JOB_ID,
    2,
    3,
    'running',
    T1,
    T2,
    null,
  ]);
  assert.equal(updated.revision, 3);

  // 不命中（快照 revision 已变）：**不发 UPDATE**、不写台账，直接 null。
  const stale = makeDb([[JOB_DB_ROW]]);
  assert.equal(await stale.store.updateJob(JOB_ID, 1, mutate), null);
  assert.equal(stale.sqls().filter((sql) => /^UPDATE/.test(sql)).length, 0, '无效 CAS 不得发 UPDATE');
  assert.equal(
    stale.sqls().filter((sql) => sql.startsWith('INSERT INTO public.jobs')).length,
    0,
    '无效 CAS 不得写台账',
  );

  // 不命中（UPDATE 0 行：并发已在两次读之间改写）：也必须是 null，不得乐观返回 mutate 结果。
  const raced = makeDb([[JOB_DB_ROW], []]);
  assert.equal(await raced.store.updateJob(JOB_ID, 2, mutate), null);
  assert.equal(raced.sqls().filter((sql) => /^UPDATE/.test(sql)).length, 1);
  assert.equal(
    raced.sqls().filter((sql) => sql.startsWith('INSERT INTO public.jobs')).length,
    0,
    'UPDATE 0 行时不得写台账',
  );
});

test('commitTerminal：同一事务内 FOR UPDATE → INSERT 记录 → UPDATE 任务；revision 不命中 ⇒ null 且零写入', async () => {
  const recognition = { ...RECOGNITION_ROW };
  const db = makeDb([
    [JOB_DB_ROW],
    [],
    [{ ...JOB_DB_ROW, revision: 3, state: 'succeeded', error_code: null, updated_at: T2 }],
  ]);
  const row = await db.store.commitTerminal(
    JOB_ID,
    2,
    { state: 'succeeded', errorCode: null },
    recognition,
    T2,
  );
  assert.deepEqual(db.sqls().slice(0, 2), ['BEGIN', "SET LOCAL lock_timeout = '4s'"]);
  assert.match(
    db.sqls()[2],
    /^SELECT .* FROM public\.recognition_jobs WHERE id = \$1::uuid FOR UPDATE$/,
  );
  assert.match(db.sqls()[3], /^INSERT INTO public\.recognition_records \(/);
  assert.match(db.sqls()[4], /^\s*UPDATE public\.recognition_jobs/);
  assert.match(db.sqls()[4], /\brevision = revision \+ 1,/);
  assert.match(db.sqls()[4], / WHERE id = \$1::uuid AND revision = \$2 RETURNING /);
  assert.match(db.sqls()[5], /^INSERT INTO public\.jobs \(/, '终态台账 upsert 必须在同一事务内、紧跟作业行 UPDATE');
  assert.equal(db.sqls()[6], 'COMMIT');
  assert.equal(db.sqls()[7], 'RELEASE');
  assert.equal(row.state, 'succeeded');
  assert.equal(row.revision, 3);

  // revision 不命中：事务里只读到过期快照，**不写记录、不写任务**，返回 null。
  const stale = makeDb([[{ ...JOB_DB_ROW, revision: 5 }]]);
  assert.equal(
    await stale.store.commitTerminal(JOB_ID, 2, { state: 'succeeded', errorCode: null }, recognition, T2),
    null,
  );
  assert.deepEqual(stale.sqls(), ['BEGIN', "SET LOCAL lock_timeout = '4s'", stale.sqls()[2], 'COMMIT', 'RELEASE']);
  assert.match(stale.sqls()[2], / FOR UPDATE$/);
});

test('commitTerminal：状态机不允许的迁移 ⇒ null（已终态不被迟到结果改写）；记录 id 冲突 ⇒ 抛错并回滚', async () => {
  // 已 cancelled 的任务收到 succeeded：canTransitionJob 拒绝 ⇒ 正常返回 null（不是异常，故事务提交空转）。
  const terminal = makeDb([[{ ...JOB_DB_ROW, state: 'cancelled' }]]);
  assert.equal(
    await terminal.store.commitTerminal(JOB_ID, 2, { state: 'succeeded', errorCode: null }, null, T2),
    null,
  );
  assert.deepEqual(terminal.sqls().slice(3), ['COMMIT', 'RELEASE']);
  assert.equal(
    terminal.sqls().filter((sql) => /^(INSERT|UPDATE)/.test(sql)).length,
    0,
    '状态机拒绝后不得写记录或任务行',
  );

  // 记录 id 已存在：冲突错误 + ROLLBACK（任务行不得被改写）。
  const dup = makeDb([[JOB_DB_ROW], uniqueViolation()]);
  const error = await dup.store
    .commitTerminal(JOB_ID, 2, { state: 'succeeded', errorCode: null }, RECOGNITION_ROW, T2)
    .then(
      () => null,
      (thrown) => thrown,
    );
  assert.ok(error instanceof RecognitionStoreConflictError);
  assert.equal(error.message, '识别记录 id 冲突');
  assert.equal(dup.sqls().at(-1), 'RELEASE');
  assert.equal(dup.sqls().at(-2), 'ROLLBACK');
  // UPDATE 任务那一句从未发出（只有 SELECT + INSERT 两条业务语句）。
  assert.equal(dup.sqls().filter((sql) => /^UPDATE public\.recognition_jobs/.test(sql)).length, 0);

  // recognition = null（失败终态）：不写记录，只有 UPDATE。
  const bare = makeDb([[JOB_DB_ROW], [{ ...JOB_DB_ROW, revision: 3, state: 'failed', error_code: 'PROVIDER_UNAVAILABLE' }]]);
  const failed = await bare.store.commitTerminal(
    JOB_ID,
    2,
    { state: 'failed', errorCode: 'PROVIDER_UNAVAILABLE' },
    null,
    T2,
  );
  assert.equal(failed.errorCode, 'PROVIDER_UNAVAILABLE');
  assert.equal(bare.sqls().filter((sql) => /^INSERT INTO public\.recognition_records/.test(sql)).length, 0);
});

test('insertRecognition / getRecognition / updateRecognition：jsonb 往返 + CAS + 未命中 null', async () => {
  const insert = makeDb([[]]);
  await insert.store.insertRecognition(RECOGNITION_ROW);
  assert.match(insert.sqls()[0], /^INSERT INTO public\.recognition_records \(/);
  assert.deepEqual(insert.log[0].values, [
    RECOGNITION_ID,
    1,
    OWNER,
    MEDIA,
    3,
    JSON.stringify(RECOGNITION_ROW.candidates),
    JSON.stringify(RECOGNITION_ROW.uncertaintyReasons),
    null,
    'mock-2026-10-20',
    T0,
    T0,
    false,
  ]);

  const dup = makeDb([uniqueViolation()]);
  const error = await dup.store.insertRecognition(RECOGNITION_ROW).then(
    () => null,
    (thrown) => thrown,
  );
  assert.ok(error instanceof RecognitionStoreConflictError);
  assert.equal(error.message, '识别记录 id 冲突');

  const read = makeDb([[RECOGNITION_DB_ROW]]);
  const row = await read.store.getRecognition(RECOGNITION_ID);
  assert.match(read.sqls()[0], /^SELECT .* FROM public\.recognition_records WHERE id = \$1::uuid$/);
  assert.deepEqual(row, RECOGNITION_ROW);
  assert.equal(await makeDb([[]]).store.getRecognition(RECOGNITION_ID), null);

  const mutate = (current) => ({ ...current, revision: current.revision + 1, deleted: true, updatedAt: T2 });
  const updated = makeDb([[RECOGNITION_DB_ROW], [{ ...RECOGNITION_DB_ROW, revision: 2, deleted: true, updated_at: T2 }]]);
  const after = await updated.store.updateRecognition(RECOGNITION_ID, 1, mutate);
  assert.match(updated.sqls()[1], /^UPDATE public\.recognition_records SET /);
  assert.match(updated.sqls()[1], / WHERE id = \$1::uuid AND revision = \$2 RETURNING /);
  assert.equal(after.deleted, true);
  assert.equal(after.revision, 2);

  const stale = makeDb([[RECOGNITION_DB_ROW]]);
  assert.equal(await stale.store.updateRecognition(RECOGNITION_ID, 9, mutate), null);
  assert.equal(stale.sqls().length, 1);
});

test('getRecognition：候选形状越界（rank > 3）⇒ 内部不变式错误，不做静默截断', async () => {
  const db = makeDb([
    [
      {
        ...RECOGNITION_DB_ROW,
        candidates: [
          { species_id: 'a', rank: 1, model_score: null },
          { species_id: 'b', rank: 9, model_score: null },
        ],
      },
    ],
  ]);
  const error = await db.store.getRecognition(RECOGNITION_ID).then(
    () => null,
    (thrown) => thrown,
  );
  assert.ok(error instanceof ApiError);
  assert.equal(error.retryable, false);
  assert.match(error.message, /candidates/);
});

test('commitSelection：CAS 失败 ⇒ 不写选择行；记录与选择不匹配 ⇒ 抛原文；成功时同事务写两张表', async () => {
  const mutate = (row) => ({ ...row, revision: row.revision + 1, selectedSpeciesId: 'spp-echinochloa', updatedAt: T2 });
  const selection = {
    id: SELECTION_ID,
    revision: 1,
    recognitionId: RECOGNITION_ID,
    ownerUserId: OWNER,
    speciesId: 'spp-echinochloa',
    provenance: 'human',
    decidedAt: T2,
    linkage: LINKAGE,
  };

  // 成功：FOR UPDATE → INSERT 选择 → UPDATE 记录（selected_species_id 生效）。
  const ok = makeDb([
    [RECOGNITION_DB_ROW],
    [SELECTION_DB_ROW],
    [{ ...RECOGNITION_DB_ROW, revision: 2, selected_species_id: 'spp-echinochloa', updated_at: T2 }],
  ]);
  const result = await ok.store.commitSelection(RECOGNITION_ID, 1, mutate, selection);
  assert.deepEqual(ok.sqls().slice(0, 2), ['BEGIN', "SET LOCAL lock_timeout = '4s'"]);
  assert.match(
    ok.sqls()[2],
    /^SELECT .* FROM public\.recognition_records WHERE id = \$1::uuid FOR UPDATE$/,
  );
  assert.match(ok.sqls()[3], /^INSERT INTO public\.recognition_selections \(/);
  assert.match(ok.sqls()[4], /^\s*UPDATE public\.recognition_records SET revision = revision \+ 1, /);
  assert.match(ok.sqls()[4], /selected_species_id = \$5::text/);
  assert.equal(ok.sqls()[5], 'COMMIT');
  assert.equal(ok.sqls().at(-1), 'RELEASE');
  assert.equal(result.recognition.selectedSpeciesId, 'spp-echinochloa');
  assert.equal(result.recognition.revision, 2);
  assert.deepEqual(result.selection, selection);

  // CAS 失败：选择行**一条都不许写**。
  const stale = makeDb([[{ ...RECOGNITION_DB_ROW, revision: 4 }]]);
  assert.equal(await stale.store.commitSelection(RECOGNITION_ID, 1, mutate, selection), null);
  assert.equal(
    stale.sqls().filter((sql) => /^INSERT INTO public\.recognition_selections/.test(sql)).length,
    0,
    'CAS 失败后不得留下孤儿选择行',
  );

  // 记录 id 与选择行不一致：与内存实现同一条原文（普通 Error，不被折成数据库故障）。
  const mismatch = makeDb([[RECOGNITION_DB_ROW]]);
  const mismatchError = await mismatch.store
    .commitSelection(RECOGNITION_ID, 1, mutate, { ...selection, recognitionId: 'other-recognition' })
    .then(
      () => null,
      (thrown) => thrown,
    );
  assert.ok(mismatchError instanceof Error);
  assert.equal(mismatchError.message, '选择记录与识别记录不匹配');
  assert.equal(mismatchError.code, undefined, '内部不变式错误不得带驱动码/契约码');

  // 选择 id 冲突：与内存实现同文案。
  const dup = makeDb([[RECOGNITION_DB_ROW], uniqueViolation()]);
  const dupError = await dup.store.commitSelection(RECOGNITION_ID, 1, mutate, selection).then(
    () => null,
    (thrown) => thrown,
  );
  assert.ok(dupError instanceof RecognitionStoreConflictError);
  assert.equal(dupError.message, '选择记录 id 冲突');
});

test('listSelections：按 recognition + owner 过滤并按 decided_at 升序；未命中 ⇒ []', async () => {
  const db = makeDb([[SELECTION_DB_ROW]]);
  const rows = await db.store.listSelections(RECOGNITION_ID, OWNER);
  assert.match(db.sqls()[0], /^SELECT .* FROM public\.recognition_selections WHERE recognition_id = \$1::uuid AND owner_user_id = \$2::uuid ORDER BY decided_at ASC, id ASC$/);
  assert.deepEqual(db.log[0].values, [RECOGNITION_ID, OWNER]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    id: SELECTION_ID,
    revision: 1,
    recognitionId: RECOGNITION_ID,
    ownerUserId: OWNER,
    speciesId: 'spp-echinochloa',
    provenance: 'human',
    decidedAt: T2,
    linkage: LINKAGE,
  });

  assert.deepEqual(await makeDb([[]]).store.listSelections(RECOGNITION_ID, FOREIGN), []);
});

test('claimIdempotent：单条 INSERT … ON CONFLICT … WHERE expires_at <= $5；四分支按读回判定', async () => {
  const input = { requestHash: 'hash-a', expiresAt: T1, now: T0 };

  // claimed：占位写入（或覆盖过期行）返回行。
  const claimed = makeDb([[{ scope: 'recognitions.create' }]]);
  assert.deepEqual(await claimed.store.claimIdempotent('recognitions.create', 'key-a', input), {
    status: 'claimed',
  });
  assert.match(claimed.sqls()[0], /^INSERT INTO public\.recognition_idempotency \(/);
  assert.match(claimed.sqls()[0], /ON CONFLICT \(scope, key_hash\) DO UPDATE/);
  assert.match(claimed.sqls()[0], /WHERE public\.recognition_idempotency\.expires_at <= \$5::timestamptz/);
  assert.deepEqual(claimed.log[0].values, ['recognitions.create', 'key-a', 'hash-a', T1, T0]);

  // in_progress：行在、未到期、同请求体、占位未完成。
  const pending = makeDb([
    [],
    [{ request_hash: 'hash-a', payload: {}, pending: true, expires_at: T1 }],
  ]);
  assert.deepEqual(await pending.store.claimIdempotent('recognitions.create', 'key-a', input), {
    status: 'in_progress',
  });
  assert.match(pending.sqls()[1], /^SELECT request_hash, payload, pending, expires_at FROM public\.recognition_idempotency WHERE scope = \$1 AND key_hash = \$2$/);

  // completed：行在、同请求体、占位已完成 ⇒ 回执（expiresAt 回 Date）。
  const done = makeDb([
    [],
    [{ request_hash: 'hash-a', payload: { jobId: JOB_ID }, pending: false, expires_at: T1 }],
  ]);
  assert.deepEqual(await done.store.claimIdempotent('recognitions.create', 'key-a', input), {
    status: 'completed',
    row: { requestHash: 'hash-a', expiresAt: T1, payload: { jobId: JOB_ID } },
  });
  assert.ok((await done.store.claimIdempotent('recognitions.create', 'key-a', input)) instanceof Object);

  // conflict：行在但请求体不同（同键不同体）。
  const conflict = makeDb([
    [],
    [{ request_hash: 'hash-b', payload: {}, pending: false, expires_at: T1 }],
  ]);
  assert.deepEqual(await conflict.store.claimIdempotent('recognitions.create', 'key-a', input), {
    status: 'conflict',
  });

  // 两轮都读不到（占位在输掉 ON CONFLICT 与读回之间被 release/purge 删掉）：保守报 in_progress。
  const vanished = makeDb([[], []]);
  assert.deepEqual(await vanished.store.claimIdempotent('recognitions.create', 'key-a', input), {
    status: 'in_progress',
  });
  assert.equal(vanished.sqls().filter((sql) => /^INSERT INTO public\.recognition_idempotency/.test(sql)).length, 2);
});

test('completeIdempotent / releaseIdempotent / purgeIdempotent：回执 upsert、只删占位、purge 返回行数', async () => {
  const complete = makeDb([[]]);
  await complete.store.completeIdempotent('recognitions.create', 'key-a', {
    requestHash: 'hash-a',
    expiresAt: T1,
    payload: { jobId: JOB_ID },
  });
  assert.match(complete.sqls()[0], /^INSERT INTO public\.recognition_idempotency \(/);
  assert.match(complete.sqls()[0], /pending = false/);
  assert.deepEqual(complete.log[0].values, [
    'recognitions.create',
    'key-a',
    'hash-a',
    JSON.stringify({ jobId: JOB_ID }),
    T1,
  ]);

  const release = makeDb([[]]);
  await release.store.releaseIdempotent('recognitions.create', 'key-a');
  assert.equal(
    release.sqls()[0],
    'DELETE FROM public.recognition_idempotency WHERE scope = $1 AND key_hash = $2 AND pending',
  );
  assert.deepEqual(release.log[0].values, ['recognitions.create', 'key-a']);

  const purge = makeDb([[{ scope: 's' }, { scope: 't' }]]);
  assert.equal(await purge.store.purgeIdempotent(T0), 2);
  assert.equal(
    purge.sqls()[0],
    'DELETE FROM public.recognition_idempotency WHERE expires_at <= $1::timestamptz RETURNING scope',
  );
  assert.deepEqual(purge.log[0].values, [T0]);

  assert.equal(await makeDb([[]]).store.purgeIdempotent(T0), 0);
});

test('SQL 层 CAS 与幂等过期谓词锚点：四个写方法逐条点名 + 过期重占两个子句（变异防线）', async () => {
  // 为什么单独一条：真库臂的「过期 revision ⇒ null」首先被**应用层预检**挡住（快照 revision 与入参不等
  // ⇒ 根本不发 UPDATE），所以把 SQL 里的 `AND revision = $2` 删掉，那条臂照样绿。这里逐条把
  // 发出去的 UPDATE 文本钉死，去掉任何一个 CAS 谓词都必须在这里红。
  const CAS_CLAUSE = 'AND revision = $2';
  const casHint = (method, table) =>
    `[${method}] 这条 SQL 的 CAS 谓词被去掉了：UPDATE ${table} 必须带 "${CAS_CLAUSE}"` +
    '（判定权必须留在数据库；应用层预检遮不住并发写，缺谓词会静默覆盖他人写入）';

  const job = makeDb([[JOB_DB_ROW], [{ ...JOB_DB_ROW, revision: 3, updated_at: T2 }]]);
  await job.store.updateJob(JOB_ID, 2, (row) => ({ ...row, revision: row.revision + 1, updatedAt: T2 }));
  const jobUpdate = job.sqls().find((sql) => /^UPDATE public\.recognition_jobs/.test(sql));
  assert.ok(jobUpdate, '[updateJob] 必须发出一条 UPDATE public.recognition_jobs');
  assert.ok(jobUpdate.includes(CAS_CLAUSE), casHint('updateJob', 'public.recognition_jobs'));

  const recognition = makeDb([
    [RECOGNITION_DB_ROW],
    [{ ...RECOGNITION_DB_ROW, revision: 2, updated_at: T2 }],
  ]);
  await recognition.store.updateRecognition(RECOGNITION_ID, 1, (row) => ({
    ...row,
    revision: row.revision + 1,
    updatedAt: T2,
  }));
  const recognitionUpdate = recognition
    .sqls()
    .find((sql) => /^UPDATE public\.recognition_records/.test(sql));
  assert.ok(recognitionUpdate, '[updateRecognition] 必须发出一条 UPDATE public.recognition_records');
  assert.ok(
    recognitionUpdate.includes(CAS_CLAUSE),
    casHint('updateRecognition', 'public.recognition_records'),
  );

  const terminal = makeDb([
    [JOB_DB_ROW],
    [],
    [{ ...JOB_DB_ROW, revision: 3, state: 'succeeded', updated_at: T2 }],
  ]);
  await terminal.store.commitTerminal(JOB_ID, 2, { state: 'succeeded', errorCode: null }, null, T2);
  const terminalUpdate = terminal
    .sqls()
    .find((sql) => /^\s*UPDATE public\.recognition_jobs/.test(sql));
  assert.ok(terminalUpdate, '[commitTerminal] 必须发出一条 UPDATE public.recognition_jobs');
  assert.ok(terminalUpdate.includes(CAS_CLAUSE), casHint('commitTerminal', 'public.recognition_jobs'));

  const selection = makeDb([
    [RECOGNITION_DB_ROW],
    [SELECTION_DB_ROW],
    [{ ...RECOGNITION_DB_ROW, revision: 2, selected_species_id: 'spp-echinochloa', updated_at: T2 }],
  ]);
  await selection.store.commitSelection(
    RECOGNITION_ID,
    1,
    (row) => ({ ...row, revision: row.revision + 1, selectedSpeciesId: 'spp-echinochloa', updatedAt: T2 }),
    {
      id: SELECTION_ID,
      revision: 1,
      recognitionId: RECOGNITION_ID,
      ownerUserId: OWNER,
      speciesId: 'spp-echinochloa',
      provenance: 'human',
      decidedAt: T2,
      linkage: LINKAGE,
    },
  );
  const selectionUpdate = selection
    .sqls()
    .find((sql) => /^UPDATE public\.recognition_records/.test(sql));
  assert.ok(selectionUpdate, '[commitSelection] 必须发出一条 UPDATE public.recognition_records');
  assert.ok(
    selectionUpdate.includes(CAS_CLAUSE),
    casHint('commitSelection', 'public.recognition_records'),
  );

  // 幂等：过期行的「可被覆盖」判定（WHERE）与「覆盖后刷新到期时间」（SET … = EXCLUDED.…）各一条。
  const claim = makeDb([[{ scope: 'recognitions.create' }]]);
  await claim.store.claimIdempotent('recognitions.create', 'key-a', {
    requestHash: 'hash-a',
    expiresAt: T1,
    now: T0,
  });
  const claimSql = claim.sqls()[0];
  assert.ok(
    claimSql.includes('expires_at = EXCLUDED.expires_at'),
    '[claimIdempotent] 这条 SQL 的「覆盖后刷新到期时间」被去掉了：DO UPDATE 必须带 ' +
      '"expires_at = EXCLUDED.expires_at"（否则重占的行会带着旧到期时间，下一轮又立刻"过期"）',
  );
  assert.ok(
    claimSql.includes('public.recognition_idempotency.expires_at <= $5::timestamptz'),
    '[claimIdempotent] 这条 SQL 的过期闸门被去掉了（或改成恒真/恒假）：ON CONFLICT 必须带 ' +
      '"WHERE public.recognition_idempotency.expires_at <= $5::timestamptz"，' +
      '未过期的占位绝不能被第二个请求覆盖',
  );
});

test('就绪探测：确定结论只探一次；读类不因缓存缺失重复探测', async () => {
  const db = makeDb([[JOB_DB_ROW], []]);
  await db.store.getJob(JOB_ID);
  await db.store.getJob(JOB_ID);
  assert.equal(db.probes.length, 1, 'ready 结论应被缓存');
  assert.match(db.probes[0].sql, /to_regclass\('public\.recognition_jobs'\)/);
  assert.match(db.probes[0].sql, /to_regclass\('public\.recognition_idempotency'\)/);
});

test('错误折叠：57014/55P03 ⇒ PROVIDER_TIMEOUT（可重试）；其它驱动码 ⇒ PROVIDER_UNAVAILABLE（可重试）；契约错误原样抛', () => {
  // 该函数的返回类型是 `never`：它是**抛出式**折叠器，不是「返回一个错误对象」的工厂。
  for (const code of ['57014', '55P03']) {
    assert.throws(
      () => classifyRecognitionDatabaseError(Object.assign(new Error('timeout'), { code })),
      (thrown) =>
        thrown instanceof ApiError && thrown.code === 'PROVIDER_TIMEOUT' && thrown.retryable === true,
    );
  }
  assert.throws(
    () => classifyRecognitionDatabaseError(Object.assign(new Error('boom'), { code: '08006' })),
    (thrown) =>
      thrown instanceof ApiError && thrown.code === 'PROVIDER_UNAVAILABLE' && thrown.retryable === true,
  );

  const conflict = new RecognitionStoreConflictError('任务 id 冲突');
  assert.throws(() => classifyRecognitionDatabaseError(conflict), (thrown) => thrown === conflict);
  const api = new ApiError('BAD_REQUEST', 'x', { retryable: false });
  assert.throws(() => classifyRecognitionDatabaseError(api), (thrown) => thrown === api);
});
