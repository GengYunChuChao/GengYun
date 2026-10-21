/**
 * GY-R28 S20（#20）· `createPostgresSpeechStore` 的**语句形状 + 语义**契约（记录型假池，不连库）。
 *
 * 与真库脚本（`tests/integration/speech-pg.mjs`）的分工（与仓内 `ocr-store-pg` 的分层同口径）：
 *   - 这里用假池锁**只有读源码才能判**的性质：CAS 是不是**一条带 `WHERE revision = $n` 的 UPDATE**、
 *     `claimIdempotent` 是不是**单条** `INSERT … ON CONFLICT … DO NOTHING`（不是先 SELECT 再 INSERT）、
 *     `commitTerminal` 是不是在**同一事务**里 `FOR UPDATE` → INSERT → UPDATE、
 *     `updateTranscription` 的原样输出不变量是否**在发 UPDATE 之前**就拒掉、purge 返回的是不是行数；
 *   - 真库锁**只有数据库能证明**的性质：约束真的存在、迁移三连、关连接重开后仍在。
 *
 * 12 个方法逐条都有用例（与 `SpeechStore` 接口顺序一致）。反向控制：同一条 CAS 判据在
 * "revision 命中"与"revision 不命中"两种输入下必须给出不同结果（若退化成"永远成功/永远 null"，必红）；
 * `claimIdempotent` 在"插入成功"与"已存在"两种池应答下必须给出 `claimed` / `exists` 两个不同值。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { ApiError } from '../../services/api/src/errors.ts';
import {
  SpeechStoreConflictError,
  SpeechTablesMissingError,
  classifySpeechDatabaseError,
  createPostgresSpeechStore,
} from '../../services/api/src/speech/store-pg.ts';
import { createMemorySpeechStore } from '../../services/api/src/speech/store.ts';

const OWNER = '11111111-1111-4111-8111-111111111111';
const MEDIA = '22222222-2222-4222-8222-222222222222';
const T0 = new Date('2026-10-21T08:00:00.000Z');
const T1 = new Date('2026-10-21T08:00:01.000Z');

const SCHEMA_ERROR = '转写持久化表未迁移（0026_speech_persistence.sql）：拒绝写入，避免静默丢数据';

/** 事务控制语句：由假池固定应答，**不消耗**业务语句脚本（否则每条用例都要先铺 BEGIN/SET LOCAL）。 */
const CONTROL_SQL = /^(BEGIN|COMMIT|ROLLBACK|SET LOCAL .*|RELEASE)$/;

/** 就绪探测语句（`to_regclass` 三表合判）：**不消耗**业务脚本，单独走 `probes` 流。 */
const PROBE_SQL = /to_regclass/;

/**
 * 记录型假池：按脚本顺序逐条返回**业务语句**的应答，`Error` 实例表示该条语句抛错。
 *
 * `probe` 是就绪探测的应答（默认 `'ready'`；`'missing'` 模拟子集迁移库，`'unknown'` 模拟
 * 读不懂的应答，`Error` 模拟探测本身失败）。探测不进 `log`，因此本文件既有的语句位置/条数
 * 断言逐条保持原样；读写分化本身的判据在 `speech-store-pg-tables-missing.test.mjs`。
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
  return { pool, log, probes, sqls, store: createPostgresSpeechStore({ pool }) };
}

const uniqueViolation = () => Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });

/** 数据库行（snake_case，假池应答用）。 */
function dbJobRow(overrides = {}) {
  return {
    id: randomUUID(),
    revision: 1,
    kind: 'transcription',
    owner_user_id: OWNER,
    transcription_id: randomUUID(),
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

function dbTranscriptionRow(overrides = {}) {
  return {
    id: randomUUID(),
    revision: 1,
    owner_user_id: OWNER,
    media_id: MEDIA,
    media_revision: 2,
    raw_text: '合成用例·原始转写文本',
    uncertain_spans: [{ start: 0, end: 4, reason: '合成用例·前缀不确定' }],
    confirmed_text: null,
    confirmed_at: null,
    model_version: 'stub-v1',
    created_at: T0,
    updated_at: T0,
    deleted: false,
    ...overrides,
  };
}

/** 契约行（camelCase，写入/比较用）。 */
function jobInput(overrides = {}) {
  return {
    id: randomUUID(),
    revision: 1,
    kind: 'transcription',
    ownerUserId: OWNER,
    transcriptionId: randomUUID(),
    mediaId: MEDIA,
    mediaRevision: 2,
    state: 'queued',
    deadlineAt: new Date(T0.getTime() + 30_000),
    createdAt: T0,
    updatedAt: T0,
    errorCode: null,
    ...overrides,
  };
}

function transcriptionInput(overrides = {}) {
  return {
    id: randomUUID(),
    revision: 1,
    ownerUserId: OWNER,
    mediaId: MEDIA,
    mediaRevision: 2,
    rawText: '合成用例·原始转写文本',
    uncertainSpans: [{ start: 0, end: 4, reason: '合成用例·前缀不确定' }],
    confirmedText: null,
    confirmedAt: null,
    modelVersion: 'stub-v1',
    createdAt: T0,
    updatedAt: T0,
    deleted: false,
    ...overrides,
  };
}

test('store.persistent 如实为 true（内存实现为 false）', () => {
  const { store } = makeDb();
  assert.equal(store.persistent, true);
  assert.equal(createMemorySpeechStore().persistent, false);
});

test('[1] insertJob：单条 INSERT；同 id 冲突由唯一性裁决（23505 ⇒ 与内存同文案的冲突错误）', async () => {
  const row = jobInput();
  const ok = makeDb([[]]);
  await ok.store.insertJob(row);
  assert.equal(ok.log.length, 1, 'insertJob 必须只发一条语句');
  assert.match(ok.sqls()[0], /^INSERT INTO public\.speech_jobs /);
  assert.equal(ok.log[0].values[0], row.id);

  const dup = makeDb([uniqueViolation()]);
  await assert.rejects(
    () => dup.store.insertJob(row),
    (error) => error instanceof SpeechStoreConflictError && error.message === '任务 id 冲突',
    '同 id 再写必须抛与内存实现同文案的冲突错误（不得折成 PROVIDER_UNAVAILABLE）',
  );
});

test('[2] getJob：按主键单条读；未命中 ⇒ null；行逐字段映射（含 Date 与 error_code）', async () => {
  const row = dbJobRow({ state: 'failed', error_code: 'PROVIDER_TIMEOUT', revision: 4 });
  const hit = makeDb([[row]]);
  const read = await hit.store.getJob(row.id);
  assert.match(hit.sqls()[0], /^SELECT .* FROM public\.speech_jobs WHERE id = \$1::uuid$/);
  assert.equal(read.id, row.id);
  assert.equal(read.state, 'failed');
  assert.equal(read.revision, 4);
  assert.equal(read.kind, 'transcription');
  assert.equal(read.ownerUserId, OWNER);
  assert.equal(read.transcriptionId, row.transcription_id);
  assert.equal(read.errorCode, 'PROVIDER_TIMEOUT');
  assert.equal(read.deadlineAt instanceof Date, true, 'timestamptz 必须回成 Date');
  assert.equal(read.createdAt instanceof Date, true);
  assert.equal(read.updatedAt instanceof Date, true);

  const miss = makeDb([[]]);
  assert.equal(await miss.store.getJob(randomUUID()), null, '不存在 ⇒ null（与"查不到"同形）');

  // 坏行（state 不在闭集内）⇒ 内部不变式违反，不静默降级
  const bad = makeDb([[dbJobRow({ state: 'exploded' })]]);
  await assert.rejects(
    () => bad.store.getJob('x'),
    (error) => error instanceof ApiError && error.code === 'PROVIDER_UNAVAILABLE' && error.retryable === false,
  );
});

test('[3] updateJob：CAS 判定在**单条**带 WHERE revision = $n 的 UPDATE；0 行 ⇒ null', async () => {
  const row = dbJobRow();

  // (a) revision 不匹配 ⇒ null，且**不得**发出 UPDATE
  const stale = makeDb([[row]]);
  const staleResult = await stale.store.updateJob(row.id, 9, (current) => ({ ...current, revision: current.revision + 1 }));
  assert.equal(staleResult, null);
  assert.equal(stale.log.length, 1, 'revision 不匹配时不得发出 UPDATE（现场发了第二条语句）');

  // (b) 命中 ⇒ 一条带 revision 谓词的 UPDATE，返回值即库返回行
  const nextRow = dbJobRow({ id: row.id, revision: 2, state: 'running', updated_at: T1 });
  const hit = makeDb([[row], [nextRow]]);
  const updated = await hit.store.updateJob(row.id, 1, (current) => ({
    ...current,
    state: 'running',
    revision: current.revision + 1,
    updatedAt: T1,
  }));
  assert.equal(updated.revision, 2);
  assert.equal(updated.state, 'running');
  assert.match(hit.sqls()[1], /^UPDATE public\.speech_jobs SET /);
  assert.match(hit.sqls()[1], / WHERE id = \$1::uuid AND revision = \$2 RETURNING /);
  assert.equal(hit.log[1].values[1], 1, 'CAS 的比较值必须是调用方给的 expectedRevision');
  assert.equal(hit.log[1].values[2], 2, '写入的 revision 必须是 mutate 返回的新版本（不是 SQL 再 +1）');

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
  const row = dbJobRow({ state: 'running', revision: 2 });
  const committed = dbJobRow({ id: row.id, state: 'succeeded', revision: 3 });
  const record = transcriptionInput({ id: row.transcription_id });
  const db = makeDb([[row], [], [committed]]);
  const result = await db.store.commitTerminal(row.id, 2, { state: 'succeeded', errorCode: null }, record, T1);
  assert.equal(result.state, 'succeeded');
  assert.equal(result.revision, 3);
  const sqls = db.sqls();
  assert.deepEqual(sqls.slice(0, 2), ['BEGIN', "SET LOCAL lock_timeout = '4s'"]);
  assert.match(sqls[2], /^SELECT .* FROM public\.speech_jobs WHERE id = \$1::uuid FOR UPDATE$/);
  assert.match(sqls[3], /^INSERT INTO public\.transcriptions /);
  assert.match(sqls[4], /^UPDATE public\.speech_jobs SET state = \$3, error_code = \$4, revision = revision \+ 1/);
  assert.equal(sqls[5], 'COMMIT');
  assert.equal(sqls[6], 'RELEASE', '连接必须归还（事务结束后）');
  // 记录行必须在**同一个事务连接**上写（不是另开一次池查询）
  assert.equal(db.log[3].values[0], record.id);

  // transcription 为 null ⇒ 不写记录表
  const noRecord = makeDb([[row], [committed]]);
  await noRecord.store.commitTerminal(row.id, 2, { state: 'succeeded', errorCode: null }, null, T1);
  assert.equal(noRecord.sqls().some((sql) => sql.startsWith('INSERT')), false, '无记录时不得 INSERT 转写记录');

  // CAS 失败：只锁读 + COMMIT，**不得**写记录、不得改任务
  const casFail = makeDb([[row]]);
  assert.equal(await casFail.store.commitTerminal(row.id, 99, { state: 'succeeded', errorCode: null }, record, T1), null);
  assert.deepEqual(casFail.sqls(), ['BEGIN', "SET LOCAL lock_timeout = '4s'", casFail.sqls()[2], 'COMMIT', 'RELEASE']);
  assert.equal(casFail.sqls().some((sql) => sql.startsWith('INSERT')), false, 'CAS 失败不得写任何记录');
  assert.equal(casFail.sqls().some((sql) => sql.startsWith('UPDATE')), false, 'CAS 失败不得改任务行');

  // 非法迁移（终态不可离开）⇒ null 且不写
  const terminal = dbJobRow({ state: 'cancelled', revision: 3 });
  const illegal = makeDb([[terminal]]);
  assert.equal(
    await illegal.store.commitTerminal(terminal.id, 3, { state: 'succeeded', errorCode: null }, null, T1),
    null,
    '已取消任务不得被迟到结果改写',
  );
  assert.equal(illegal.sqls().some((sql) => sql.startsWith('INSERT')), false);

  // 记录 id 冲突 ⇒ 抛错 + ROLLBACK（任务行不留半成品）
  const conflict = makeDb([[row], uniqueViolation()]);
  await assert.rejects(
    () => conflict.store.commitTerminal(row.id, 2, { state: 'succeeded', errorCode: null }, record, T1),
    (error) => error instanceof SpeechStoreConflictError && error.message === '转写记录 id 冲突',
  );
  assert.equal(conflict.sqls().includes('ROLLBACK'), true, '记录冲突必须回滚事务');
  assert.equal(conflict.sqls().includes('COMMIT'), false, '记录冲突不得提交');
});

test('[5] insertTranscription：单条 INSERT；同 id 冲突 ⇒ 与内存同文案的冲突错误', async () => {
  const record = transcriptionInput();
  const ok = makeDb([[]]);
  await ok.store.insertTranscription(record);
  assert.equal(ok.log.length, 1, 'insertTranscription 必须只发一条语句');
  assert.match(ok.sqls()[0], /^INSERT INTO public\.transcriptions /);
  assert.equal(ok.log[0].values[0], record.id);
  assert.equal(ok.log[0].values[6], JSON.stringify(record.uncertainSpans), 'uncertain_spans 必须以 jsonb 文本写入');

  const dup = makeDb([uniqueViolation()]);
  await assert.rejects(
    () => dup.store.insertTranscription(record),
    (error) => error instanceof SpeechStoreConflictError && error.message === '转写记录 id 冲突',
  );
});

test('[6] getTranscription：按主键单条读；未命中 ⇒ null；uncertain_spans 逐项映射', async () => {
  const spans = [{ start: 0, end: 2, reason: 'a' }, { start: 5, end: 9, reason: 'b' }];
  const row = dbTranscriptionRow({ uncertain_spans: spans, confirmed_text: '合成用例·核对后文本', confirmed_at: T1 });
  const hit = makeDb([[row]]);
  const read = await hit.store.getTranscription(row.id);
  assert.match(hit.sqls()[0], /^SELECT .* FROM public\.transcriptions WHERE id = \$1::uuid$/);
  assert.deepEqual(read.uncertainSpans, spans, '区间必须逐项原样（不补造、不排序、不合并）');
  assert.equal(read.rawText, row.raw_text);
  assert.equal(read.confirmedText, '合成用例·核对后文本');
  assert.equal(read.confirmedAt instanceof Date, true, 'confirmed_at 必须回成 Date');
  assert.equal(read.deleted, false);

  // 无核对行：confirmed_text/confirmed_at 为 null
  const fresh = await makeDb([[dbTranscriptionRow()]]).store.getTranscription('x');
  assert.equal(fresh.confirmedText, null);
  assert.equal(fresh.confirmedAt, null);

  const miss = makeDb([[]]);
  assert.equal(await miss.store.getTranscription(randomUUID()), null);
});

test('[7] updateTranscription：CAS + 原始输出不可变（改写 raw_text / spans ⇒ 抛错且**不发** UPDATE）', async () => {
  const row = dbTranscriptionRow({ revision: 1 });

  // (a) revision 不匹配 ⇒ null，且不得发 UPDATE
  const stale = makeDb([[row]]);
  assert.equal(await stale.store.updateTranscription(row.id, 9, (current) => current), null);
  assert.equal(stale.log.length, 1);

  // (b) 正常确认：一条带 revision 谓词的 UPDATE，revision 用 mutate 的新值
  const confirmed = dbTranscriptionRow({ revision: 2, confirmed_text: '合成用例·核对后文本', confirmed_at: T1, updated_at: T1 });
  const hit = makeDb([[row], [confirmed]]);
  const updated = await hit.store.updateTranscription(row.id, 1, (current) => ({
    ...current,
    confirmedText: '合成用例·核对后文本',
    confirmedAt: T1,
    revision: current.revision + 1,
    updatedAt: T1,
  }));
  assert.equal(updated.confirmedText, '合成用例·核对后文本');
  assert.equal(updated.revision, 2);
  assert.match(hit.sqls()[1], /^UPDATE public\.transcriptions SET /);
  assert.match(hit.sqls()[1], / WHERE id = \$1::uuid AND revision = \$2 RETURNING /);
  assert.equal(hit.log[1].values[1], 1);
  assert.equal(hit.log[1].values[2], 2);

  // (c) 原始输出被改写 ⇒ 抛与内存同文案的错，且**根本不发 UPDATE**
  for (const mutate of [
    (current) => ({ ...current, rawText: `${current.rawText}（被改写）` }),
    (current) => ({ ...current, uncertainSpans: current.uncertainSpans.slice(1) }),
    (current) => ({ ...current, uncertainSpans: [...current.uncertainSpans, { start: 9, end: 9, reason: '补造' }] }),
    (current) => ({
      ...current,
      uncertainSpans: current.uncertainSpans.map((span) => ({ ...span, reason: `${span.reason}!` })),
    }),
  ]) {
    const immutable = makeDb([[row]]);
    await assert.rejects(
      () => immutable.store.updateTranscription(row.id, 1, mutate),
      (error) =>
        error instanceof Error
        && error.message === '转写记录的 raw_text / uncertain_spans 不可改写（存储层不变量）',
      '改写原始输出必须抛错（⛔ 不得静默接受）',
    );
    assert.equal(immutable.log.length, 1, '拒掉之后不得再发 UPDATE');
  }

  // (d) 软删：deleted=true 也是普通 CAS 写（raw/spans 不动）
  const deletedRow = dbTranscriptionRow({ revision: 2, deleted: true });
  const del = makeDb([[row], [deletedRow]]);
  const deleted = await del.store.updateTranscription(row.id, 1, (current) => ({
    ...current,
    deleted: true,
    revision: current.revision + 1,
  }));
  assert.equal(deleted.deleted, true);

  // (e) 行不存在 / CAS 0 行 ⇒ null
  assert.equal(await makeDb([[]]).store.updateTranscription(randomUUID(), 1, (current) => current), null);
  assert.equal(
    await makeDb([[row], []]).store.updateTranscription(row.id, 1, (current) => ({ ...current, revision: 2 })),
    null,
  );
});

test('[8] findIdempotent：单条按 (scope,key_hash) 读，**不**按过期过滤（与内存实现逐条一致）', async () => {
  const expiresAt = new Date(T0.getTime() + 86_400_000);
  const db = makeDb([[{ request_hash: 'rh', payload: { job_id: 'j1' }, pending: true, expires_at: expiresAt }]]);
  const found = await db.store.findIdempotent('scope-x', 'key-hash');
  assert.match(db.sqls()[0], /^SELECT request_hash, payload, pending, expires_at FROM public\.speech_idempotency WHERE scope = \$1 AND key_hash = \$2$/);
  assert.equal(/expires_at\s*<=/.test(db.sqls()[0]), false, 'findIdempotent 不得自带过期过滤（过滤在内存实现里也没有）');
  assert.equal(db.log[0].values[0], 'scope-x');
  assert.equal(db.log[0].values[1], 'key-hash');
  assert.equal(found.requestHash, 'rh');
  assert.deepEqual(found.payload, { job_id: 'j1' });
  assert.equal(found.pending, true);
  assert.equal(found.expiresAt instanceof Date, true);

  // jsonb 以字符串返回（部分驱动/pg 配置）也要能读
  const asText = makeDb([[{ request_hash: 'rh', payload: '{"accepted":true}', pending: false, expires_at: T0 }]]);
  assert.deepEqual((await asText.store.findIdempotent('s', 'k')).payload, { accepted: true });

  assert.equal(await makeDb([[]]).store.findIdempotent('s', 'k'), null);
});

test('[9] claimIdempotent：单条 INSERT … ON CONFLICT (scope,key_hash) DO NOTHING；据返回行判 claimed/exists', async () => {
  const row = {
    requestHash: 'rh',
    expiresAt: new Date(T0.getTime() + 60_000),
    payload: { job_id: 'j1' },
    pending: true,
  };
  const claimedDb = makeDb([[{ scope: 's' }]]);
  assert.equal(await claimedDb.store.claimIdempotent('s', 'k', row, T0), 'claimed');
  assert.equal(claimedDb.log.length, 1, '占位必须是**单条**语句（⛔ 不许先 SELECT 再 INSERT）');
  const sql = claimedDb.sqls()[0];
  assert.match(sql, /^INSERT INTO public\.speech_idempotency /);
  assert.match(sql, / ON CONFLICT \(scope, key_hash\) DO NOTHING/);
  assert.equal(/DO UPDATE/.test(sql), false, '必须 DO NOTHING（到期行由调用方先 purge）');
  assert.equal(claimedDb.log[0].values[0], 's');
  assert.equal(claimedDb.log[0].values[1], 'k');
  assert.equal(claimedDb.log[0].values[2], 'rh');
  assert.equal(claimedDb.log[0].values[3], '{"job_id":"j1"}');
  assert.equal(claimedDb.log[0].values[4], true);
  assert.deepEqual(claimedDb.log[0].values[5], row.expiresAt);

  // 已存在 ⇒ 数据库不返回行（DO NOTHING）⇒ exists
  const existsDb = makeDb([[]]);
  assert.equal(await existsDb.store.claimIdempotent('s', 'k', row, T0), 'exists');
  assert.equal(existsDb.log.length, 1, 'exists 也必须是单条语句（没有第二次读）');
});

test('[10] finalizeIdempotent：单条 UPDATE 回填 payload + pending=false；行不存在是空操作', async () => {
  const db = makeDb([[]]);
  await db.store.finalizeIdempotent('s', 'k', { accepted: true });
  assert.equal(db.log.length, 1);
  assert.match(db.sqls()[0], /^UPDATE public\.speech_idempotency SET payload = \$3::jsonb, pending = false WHERE scope = \$1 AND key_hash = \$2$/);
  assert.equal(db.log[0].values[2], '{"accepted":true}');
});

test('[11] releaseIdempotent：单条 DELETE，无条件删（与内存实现的 delete 同义）', async () => {
  const db = makeDb([[]]);
  await db.store.releaseIdempotent('s', 'k');
  assert.equal(db.log.length, 1);
  assert.match(db.sqls()[0], /^DELETE FROM public\.speech_idempotency WHERE scope = \$1 AND key_hash = \$2$/);
  assert.equal(/pending/.test(db.sqls()[0]), false, '释放不得按完成态过滤（内存实现是无条件 delete）');
});

test('[12] purgeIdempotent：单条 DELETE … expires_at <= $1 RETURNING scope，返回删除行数', async () => {
  const db = makeDb([[{ scope: 'a' }, { scope: 'b' }]]);
  assert.equal(await db.store.purgeIdempotent(T0), 2);
  assert.equal(db.log.length, 1);
  assert.match(db.sqls()[0], /^DELETE FROM public\.speech_idempotency WHERE expires_at <= \$1::timestamptz RETURNING scope$/);
  assert.deepEqual(db.log[0].values, [T0]);
  assert.equal(await makeDb([[]]).store.purgeIdempotent(T0), 0);
});

test('错误折叠：57014/55P03 ⇒ PROVIDER_TIMEOUT；瞬态类 ⇒ PROVIDER_UNAVAILABLE(可重试)；内部错误/非驱动错误不标可重试', async () => {
  for (const code of ['57014', '55P03']) {
    const db = makeDb([Object.assign(new Error('timeout'), { code })]);
    await assert.rejects(
      () => db.store.getJob(randomUUID()),
      (error) => error instanceof ApiError && error.code === 'PROVIDER_TIMEOUT' && error.retryable === true,
    );
  }
  const broken = makeDb([Object.assign(new Error('boom'), { code: 'XX000' })]);
  await assert.rejects(
    () => broken.store.getJob(randomUUID()),
    // 改前断言 `retryable === true`（旧口径）；XX000 是内部错误，同一请求原样重试大概率复现
    // ⇒ R28-S62 订正为 false（状态码仍是 503，只改分档）。
    (error) => error instanceof ApiError && error.code === 'PROVIDER_UNAVAILABLE' && error.retryable === false,
  );
  // 瞬态类仍必须可重试（本片只收紧「不是时间能解决的」那一类，没有砍掉可重试面）。
  const transientDb = makeDb([Object.assign(new Error('socket'), { code: '08006' })]);
  await assert.rejects(
    () => transientDb.store.getJob(randomUUID()),
    (error) => error instanceof ApiError && error.code === 'PROVIDER_UNAVAILABLE' && error.retryable === true,
  );
  // 非驱动错误（mutate 抛的普通 Error / 实现缺陷）不得被折成 provider 故障
  const original = new Error('实现缺陷·必须原样抛出');
  assert.throws(() => classifySpeechDatabaseError(original), (error) => error === original);
  // 冲突错误与 ApiError 直通（不被二次折叠）
  const conflict = new SpeechStoreConflictError('任务 id 冲突');
  assert.throws(() => classifySpeechDatabaseError(conflict), (error) => error === conflict);
  const apiError = new ApiError('NOT_FOUND', '不存在');
  assert.throws(() => classifySpeechDatabaseError(apiError), (error) => error === apiError);
});

test('迁移缺席的错误类型可被调用方按类型区分（文案点名 0026，retryable=false）', () => {
  const error = new SpeechTablesMissingError();
  assert.equal(error instanceof ApiError, true);
  assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(error.message, SCHEMA_ERROR);
  assert.equal(error.retryable, false);
});
