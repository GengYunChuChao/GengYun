/**
 * GY-R28 S13（#9）· **「表未迁移」≠「数据库故障」**（#323 的真红就死在这一条上）。
 *
 * 本文件逐条钉住三态探测的对外可观察后果：
 *   [A] 表确实不存在（探测确定结论 `missing`）⇒ **读类返回 null/[]**（等价于"没有已持久化的数据"），
 *       且**一条业务 SQL 都不发**；结论被缓存，不会每次调用都探一次。
 *   [B] 同一状态下的**写类必须 fail-closed**：抛 `RecognitionTablesMissingError`（`PROVIDER_UNAVAILABLE`
 *       + `retryable: false` + 点名 `0025_recognitions_persistence.sql`），并且**连事务连接都不开**。
 *   [C] 探测本身失败（连接/权限/超时）、或探测结果形状读不懂 ⇒ **状态未知**：fail-closed 抛，
 *       ⛔ 不得当成 `missing` 放行读、⛔ 不得把 `unknown` 写进缓存（否则一次抖动会粘成长期"未迁移"）。
 *   [D] 探测说 ready 但语句真失败 ⇒ **真故障照旧抛**，不被"未迁移"分支吞成 null。
 *
 * 反向控制：同一个 `run` 的 catch 对 `42P01` 与 `08006` 必须给出**不同**结果（未迁移 vs 数据库故障）；
 * 若把两者混成一种，对应用例必红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ApiError } from '../../services/api/src/errors.ts';
import {
  RecognitionTablesMissingError,
  createPostgresRecognitionStore,
} from '../../services/api/src/recognitions/store-pg.ts';

const OWNER = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '44444444-4444-4444-8444-444444444444';
const RECOGNITION_ID = '55555555-5555-4555-8555-555555555555';
const T0 = new Date('2026-10-20T08:00:00.000Z');

const CONTROL_SQL = /^(BEGIN|COMMIT|ROLLBACK|SET LOCAL .*|RELEASE)$/;
const PROBE_SQL = /to_regclass/;

function makeDb({ script = [], probe = 'missing' } = {}) {
  const state = { probe, script };
  const log = [];
  const probes = [];
  let connects = 0;
  let index = 0;
  const answerProbe = () => {
    if (state.probe instanceof Error) throw state.probe;
    if (state.probe === 'ready') return { rows: [{ ready: true }] };
    if (state.probe === 'missing') return { rows: [{ ready: false }] };
    if (state.probe === 'unreadable') return { rows: [{}] };
    if (state.probe === 'empty') return { rows: [] };
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
    const response = state.script[index];
    index += 1;
    if (response instanceof Error) throw response;
    return { rows: response ?? [] };
  };
  const pool = {
    query: next,
    async connect() {
      connects += 1;
      return {
        query: next,
        release() {
          log.push({ sql: 'RELEASE' });
        },
      };
    },
  };
  const store = createPostgresRecognitionStore({ pool });
  const sqls = () => log.map((entry) => entry.sql);
  return {
    store,
    probes,
    sqls,
    connects: () => connects,
    setProbe(value) {
      state.probe = value;
    },
    setScript(value) {
      state.script = value;
      index = 0;
    },
  };
}

const READERS = [
  ['getJob', (store) => store.getJob(JOB_ID), null],
  ['getRecognition', (store) => store.getRecognition(RECOGNITION_ID), null],
  ['listSelections', (store) => store.listSelections(RECOGNITION_ID, OWNER), []],
];

const WRITERS = [
  [
    'insertJob',
    (store) =>
      store.insertJob({
        id: JOB_ID,
        revision: 1,
        kind: 'recognition',
        ownerUserId: OWNER,
        recognitionId: RECOGNITION_ID,
        mediaId: '33333333-3333-4333-8333-333333333333',
        mediaRevision: 1,
        state: 'queued',
        deadlineAt: T0,
        createdAt: T0,
        updatedAt: T0,
        errorCode: null,
      }),
  ],
  ['updateJob', (store) => store.updateJob(JOB_ID, 1, (row) => row)],
  [
    'commitTerminal',
    (store) => store.commitTerminal(JOB_ID, 1, { state: 'succeeded', errorCode: null }, null, T0),
  ],
  ['insertRecognition', (store) => store.insertRecognition(null)],
  ['updateRecognition', (store) => store.updateRecognition(RECOGNITION_ID, 1, (row) => row)],
  [
    'commitSelection',
    (store) => store.commitSelection(RECOGNITION_ID, 1, (row) => row, { recognitionId: RECOGNITION_ID }),
  ],
  [
    'claimIdempotent',
    (store) =>
      store.claimIdempotent('recognitions.create', 'key', { requestHash: 'h', expiresAt: T0, now: T0 }),
  ],
  [
    'completeIdempotent',
    (store) =>
      store.completeIdempotent('recognitions.create', 'key', { requestHash: 'h', expiresAt: T0, payload: {} }),
  ],
  ['releaseIdempotent', (store) => store.releaseIdempotent('recognitions.create', 'key')],
  ['purgeIdempotent', (store) => store.purgeIdempotent(T0)],
];

function assertTablesMissing(error) {
  assert.ok(error instanceof RecognitionTablesMissingError, `应抛 RecognitionTablesMissingError，实得 ${error}`);
  assert.ok(error instanceof ApiError);
  assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(error.retryable, false, '未迁移是确定结论，重试不会变好 ⇒ 不可重试');
  assert.match(error.message, /0025_recognitions_persistence\.sql/);
  assert.match(error.message, /未迁移/);
  assert.equal(error.name, 'RecognitionTablesMissingError');
}

test('[A] 表未迁移：读类返回 null/[]，且一条业务 SQL 都不发', async () => {
  for (const [name, call, expected] of READERS) {
    const db = makeDb({ probe: 'missing' });
    assert.deepEqual(await call(db.store), expected, `${name} 在表未迁移时必须返回 ${JSON.stringify(expected)}`);
    assert.deepEqual(db.sqls(), [], `${name} 不得发业务 SQL`);
    assert.equal(db.probes.length, 1, `${name} 应探测一次`);
  }
});

test('[A] 表未迁移：确定结论被缓存，连续调用不再探测', async () => {
  const db = makeDb({ probe: 'missing' });
  await db.store.getJob(JOB_ID);
  await db.store.getJob(JOB_ID);
  await db.store.listSelections(RECOGNITION_ID, OWNER);
  assert.equal(db.probes.length, 1, 'missing 是确定结论 ⇒ 只探一次');
});

test('[A] 42P01：失效缓存并把本句按未迁移处理（读 ⇒ null），下一次调用重探', async () => {
  const db = makeDb({
    probe: 'ready',
    script: [Object.assign(new Error('relation "public.recognition_jobs" does not exist'), { code: '42P01' })],
  });
  assert.equal(await db.store.getJob(JOB_ID), null, '42P01 后本句按未迁移返回 null，而不是抛故障');
  assert.equal(db.probes.length, 1);
  // 缓存已失效：下一次调用必须重新探测（此时改为确定缺失）。
  db.setProbe('missing');
  assert.equal(await db.store.getJob(JOB_ID), null);
  assert.equal(db.probes.length, 2, '42P01 必须让缓存失效并重探');
});

test('[B] 表未迁移：写类全部 fail-closed，且连事务连接都不开', async () => {
  for (const [name, call] of WRITERS) {
    const db = makeDb({ probe: 'missing' });
    const error = await call(db.store).then(
      () => null,
      (thrown) => thrown,
    );
    assertTablesMissing(error);
    assert.equal(db.connects(), 0, `${name} 不得为未迁移的表开连接`);
    assert.deepEqual(db.sqls(), [], `${name} 不得发业务 SQL`);
  }
});

test('[C] 探测失败（连接/权限）：读写都 fail-closed，⛔ 读不得被当成"没有数据"', async () => {
  const failure = () => Object.assign(new Error('connect ECONNREFUSED'), { code: '08006' });

  const read = makeDb({ probe: failure() });
  const readError = await read.store.getJob(JOB_ID).then(
    () => null,
    (thrown) => thrown,
  );
  // 探测抛错：先按**既有分类**折叠原因（这里 08006 ⇒ PROVIDER_UNAVAILABLE），仍是 fail-closed。
  assert.ok(readError instanceof ApiError);
  assert.equal(readError.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(readError.retryable, true);
  assert.doesNotMatch(readError.message, /未迁移/, '连接失败不得被说成"表未迁移"');

  const write = makeDb({ probe: failure() });
  const writeError = await write.store.purgeIdempotent(T0).then(
    () => null,
    (thrown) => thrown,
  );
  assert.ok(writeError instanceof ApiError);
  assert.equal(writeError.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(writeError.retryable, true);

  // `unknown` 不入缓存：再调一次必须重新探测（否则一次抖动会粘成长期"未迁移"）。
  await read.store.getJob(JOB_ID).catch(() => null);
  assert.equal(read.probes.length, 2, 'unknown 不得被缓存');
});

test('[C] 探测超时码原样保留为 PROVIDER_TIMEOUT（不因"未知"被降级成普通不可用）', async () => {
  const db = makeDb({ probe: Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }) });
  const error = await db.store.getJob(JOB_ID).then(
    () => null,
    (thrown) => thrown,
  );
  assert.ok(error instanceof ApiError);
  assert.equal(error.code, 'PROVIDER_TIMEOUT');
  assert.equal(error.retryable, true);
});

test('[C] 探测结果形状读不懂（rows[0] 没有 ready 布尔）⇒ 未知，不是 missing', async () => {
  for (const probe of ['unreadable', 'empty']) {
    const db = makeDb({ probe });
    const error = await db.store.getJob(JOB_ID).then(
      () => null,
      (thrown) => thrown,
    );
    assert.ok(error instanceof ApiError, `${probe}: 应 fail-closed`);
    assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
    assert.match(error.message, /就绪探测结果未知/);
    assert.equal(db.sqls().length, 0, '未知状态下不得发业务 SQL（读也不许放行）');
  }
});

test('[D] 探测 ready 但语句真失败 ⇒ 真故障照旧抛（不得被"未迁移"分支吞成 null）', async () => {
  const db = makeDb({
    probe: 'ready',
    script: [Object.assign(new Error('terminating connection'), { code: '08006' })],
  });
  const error = await db.store.getJob(JOB_ID).then(
    () => null,
    (thrown) => thrown,
  );
  assert.ok(error instanceof ApiError);
  assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(error.retryable, true);
  assert.doesNotMatch(error.message, /0025_recognitions_persistence\.sql/, '真故障不得被说成"未迁移"');
});

test('[D] 写类的非 42P01 故障 ⇒ 数据库故障（不是"未迁移"），且未迁移错误类不会被误用', async () => {
  const db = makeDb({
    probe: 'ready',
    script: [Object.assign(new Error('deadlock detected'), { code: '40P01' })],
  });
  const error = await db.store.insertJob({
    id: JOB_ID,
    revision: 1,
    kind: 'recognition',
    ownerUserId: OWNER,
    recognitionId: RECOGNITION_ID,
    mediaId: '33333333-3333-4333-8333-333333333333',
    mediaRevision: 1,
    state: 'queued',
    deadlineAt: T0,
    createdAt: T0,
    updatedAt: T0,
    errorCode: null,
  }).then(
    () => null,
    (thrown) => thrown,
  );
  assert.ok(error instanceof ApiError);
  assert.ok(!(error instanceof RecognitionTablesMissingError), '死锁不是"表未迁移"');
  assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(error.retryable, true);
});

test('错误类形态：手写文案与 flag 与"未迁移"语义一致', () => {
  const error = new RecognitionTablesMissingError();
  assertTablesMissing(error);
  assert.deepEqual(error.details, []);
});
