/**
 * GY-R28 S20（#20）· 缺表**三态**（迁移未跑 / 探测结果未知 / 运行中才缺表）的 fail-closed 判据。
 *
 * 本文件只关心「表在不在、不知道在不在」这一维：语句内容由 `speech-store-pg.test.mjs` 锁，
 * 这里锁的是**分化行为**与**错误分类**——读返回 null、写抛点名迁移文件的错、探测失败按数据库
 * 故障 fail-closed（未知 ≠ 未迁移，也 ≠ 可以退回内存实现）。
 *
 * 三个负控制（证据页编号 N5/N6/N7）就落在这里：
 *   N5 只要探测结果未知，写入必须失败——⛔ 不允许「不知道就先写写看」；
 *   N6 缺表时读必须返回 null 而不是抛错——否则「迁移没跑」会变成 500；
 *   N7 缺表时必须抛**点名 `0026_speech_persistence.sql`** 的错——否则排障时找不回迁移。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { ApiError } from '../../services/api/src/errors.ts';
import {
  SpeechStoreConflictError,
  SpeechTablesMissingError,
  createPostgresSpeechStore,
} from '../../services/api/src/speech/store-pg.ts';
import { createMemorySpeechStore } from '../../services/api/src/speech/store.ts';

const OWNER = '11111111-1111-4111-8111-111111111111';
const MEDIA = '22222222-2222-4222-8222-222222222222';
const T0 = new Date('2026-10-21T08:00:00.000Z');

const MIGRATION = '0026_speech_persistence.sql';
const CONTROL_SQL = /^(BEGIN|COMMIT|ROLLBACK|SET LOCAL .*|RELEASE)$/;
const PROBE_SQL = /to_regclass/;

/** 与 `speech-store-pg.test.mjs` 同款记录型假池；`probe` 决定就绪探测的应答。 */
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
  return { pool, log, probes, sqls: () => log.map((entry) => entry.sql), store: createPostgresSpeechStore({ pool }) };
}

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

const asApiError = (predicate, label) => (error) => {
  assert.equal(error instanceof ApiError, true, `${label}：必须是 ApiError`);
  assert.equal(predicate(error), true, `${label}：判定不通过（code=${error.code}, retryable=${error.retryable}, message=${error.message}）`);
  return true;
};

test('[三态-1] 探测明确“缺表”：读三个方法全部返回 null，且不抛错（N6）', async () => {
  for (const method of ['getJob', 'getTranscription']) {
    const db = makeDb([], 'missing');
    const result = await db.store[method](randomUUID());
    assert.equal(result, null, `${method} 在缺表时必须返回 null（不得抛错、不得伪造空行）`);
    assert.equal(db.log.length, 0, `${method} 缺表时不得发出任何业务语句`);
    assert.equal(db.probes.length, 1, `${method} 缺表时应当只有一次就绪探测`);
    assert.match(db.probes[0].sql, /to_regclass\('public\.speech_jobs'\)/);
    assert.match(db.probes[0].sql, /to_regclass\('public\.transcriptions'\)/);
    assert.match(db.probes[0].sql, /to_regclass\('public\.speech_idempotency'\)/);
  }

  const db = makeDb([], 'missing');
  assert.equal(await db.store.findIdempotent('scope-x', 'key-hash'), null);
  assert.equal(db.log.length, 0);
});

test('[三态-1] 探测明确“缺表”：写方法抛点名迁移文件的错（N7），且不进入事务', async () => {
  const cases = [
    ['insertJob', (store) => store.insertJob(jobInput())],
    ['insertTranscription', (store) => store.insertTranscription(transcriptionInput())],
    ['updateJob', (store) => store.updateJob(randomUUID(), 1, (row) => row)],
    ['updateTranscription', (store) => store.updateTranscription(randomUUID(), 1, (row) => row)],
    ['commitTerminal', (store) => store.commitTerminal(randomUUID(), 1, { state: 'succeeded', errorCode: null }, null, T0)],
    ['claimIdempotent', (store) => store.claimIdempotent('s', 'k', { requestHash: 'rh', expiresAt: T0, payload: {}, pending: true }, T0)],
    ['finalizeIdempotent', (store) => store.finalizeIdempotent('s', 'k', { accepted: true })],
    ['releaseIdempotent', (store) => store.releaseIdempotent('s', 'k')],
    ['purgeIdempotent', (store) => store.purgeIdempotent(T0)],
  ];
  for (const [method, call] of cases) {
    const db = makeDb([], 'missing');
    await assert.rejects(call(db.store), (error) => {
      assert.equal(error instanceof SpeechTablesMissingError, true, `${method}：必须是 SpeechTablesMissingError`);
      assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
      assert.equal(error.retryable, false, `${method}：缺表不是可重试故障`);
      assert.match(error.message, /0026_speech_persistence\.sql/, `${method}：错文案必须点名迁移文件`);
      return true;
    }, `${method} 缺表时必须 fail-closed`);
    assert.equal(db.log.length, 0, `${method} 缺表时不得发出任何业务语句`);
  }

  // 事务型方法不得先 BEGIN 再发现缺表
  const db = makeDb([], 'missing');
  await assert.rejects(() => db.store.commitTerminal(randomUUID(), 1, { state: 'succeeded', errorCode: null }, null, T0));
  assert.equal(db.sqls().includes('BEGIN'), false, '缺表时不得开启事务（避免留下空事务）');
});

test('[三态-1] 缺表时仍如实报告 persistent=true（N6 配套：绝不静默退回内存实现）', async () => {
  const db = makeDb([], 'missing');
  assert.equal(db.store.persistent, true, '持久化实现即便当前缺表也不得自我降级为内存语义');
  assert.equal(createMemorySpeechStore().persistent, false);
  // 读路径在缺表下仍返回 null，而不是任何"内存兜底"的数据
  assert.equal(await db.store.getJob(randomUUID()), null);
});

test('[三态-2] 探测本身失败（连接/权限/超时）：fail-closed 为数据库故障，不冒充“未迁移”（N5）', async () => {
  const db = makeDb([], Object.assign(new Error('connect ECONNREFUSED'), { code: '57P01' }));
  await assert.rejects(
    () => db.store.getJob(randomUUID()),
    asApiError(
      (error) => error.code === 'PROVIDER_UNAVAILABLE' && error.retryable === true,
      '探测失败后的读',
    ),
  );
  assert.equal(db.log.length, 0, '探测失败时不得发出业务语句');

  // 未知结果不得被缓存：下一次调用必须重新探测（数据库恢复后能自愈）
  assert.equal(db.probes.length, 1);
  await assert.rejects(() => db.store.getJob(randomUUID()));
  assert.equal(db.probes.length, 2, '未知结果不得缓存（否则一次抖动会永久 fail-closed）');

  // 写入同样 fail-closed，且错误类型不是"缺表"
  const writeDb = makeDb([], Object.assign(new Error('timeout'), { code: '57014' }));
  await assert.rejects(
    () => writeDb.store.insertJob(jobInput()),
    (error) => {
      assert.equal(error instanceof SpeechTablesMissingError, false, '探测失败不得冒充缺表（否则会误导排障去跑迁移）');
      assert.equal(error.code, 'PROVIDER_TIMEOUT', '超时类探测失败保留可重试的超时分类');
      assert.equal(error.retryable, true);
      return true;
    },
  );
  assert.equal(writeDb.log.length, 0);
});

test('[三态-2] 探测应答形状读不懂（空行 / 无 ready 字段）：仍按“未知”fail-closed，不当作缺表', async () => {
  for (const probe of ['unknown']) {
    const db = makeDb([], probe);
    await assert.rejects(
      () => db.store.insertJob(jobInput()),
      (error) => {
        assert.equal(error instanceof SpeechTablesMissingError, false, '形状未知不得当作缺表');
        assert.equal(error instanceof ApiError, true);
        assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
        // R31-S-retryable：形状读不懂是驱动/查询形状类确定性缺陷，同一请求重试永远不会变好 ⇒ 不可重试。
        assert.equal(error.retryable, false);
        assert.ok(
          Array.isArray(error.details) && error.details.some((entry) => entry.code === 'PROBE_SHAPE_UNKNOWN'),
          '原因必须分类进 details（不得只改布尔值而丢掉原因）',
        );
        assert.match(error.message, /未知/, '错文案必须能看出是"探测结果未知"');
        return true;
      },
    );
  }
});

test('[三态-3] 运行中才缺表（42P01）：读写各自处置并让缓存失效，下一轮重新探测', async () => {
  // 读：42P01 ⇒ null，且缓存作废（下一轮重新探测）
  const readDb = makeDb([Object.assign(new Error('relation does not exist'), { code: '42P01' })], 'ready');
  assert.equal(await readDb.store.getJob(randomUUID()), null, '运行中缺表的读必须折成 null');
  assert.equal(readDb.probes.length, 1);
  assert.equal(await readDb.store.getJob(randomUUID()), null);
  assert.equal(readDb.probes.length, 2, '42P01 之后必须重新探测（不得沿用 ready 缓存）');

  // 写：42P01 ⇒ 点名迁移文件的错
  const writeDb = makeDb([Object.assign(new Error('relation does not exist'), { code: '42P01' })], 'ready');
  await assert.rejects(
    () => writeDb.store.insertJob(jobInput()),
    (error) => error instanceof SpeechTablesMissingError && /0026_speech_persistence\.sql/.test(error.message),
  );

  // 事务型方法：42P01 在事务内发生 ⇒ 回滚 + 缺表错（不得 COMMIT）
  const txDb = makeDb([Object.assign(new Error('relation does not exist'), { code: '42P01' })], 'ready');
  await assert.rejects(
    () => txDb.store.commitTerminal(randomUUID(), 1, { state: 'succeeded', errorCode: null }, null, T0),
    (error) => error instanceof SpeechTablesMissingError,
  );
  assert.equal(txDb.sqls().includes('ROLLBACK'), true, '事务内缺表必须回滚');
  assert.equal(txDb.sqls().includes('COMMIT'), false);
});

test('[三态-3] 缺表判定不吞掉冲突错误（23505 仍是冲突，不是缺表）', async () => {
  const db = makeDb([Object.assign(new Error('duplicate key'), { code: '23505' })], 'ready');
  await assert.rejects(
    () => db.store.insertJob(jobInput()),
    (error) => error instanceof SpeechStoreConflictError && error.message === '任务 id 冲突',
  );
});
