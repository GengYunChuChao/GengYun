/**
 * #29 缺口① · 撤回授权 / 注销必须**同时终止在途作业行**，不只是外发账本行。
 *
 * ## 这条用例钉什么
 * 原缺口：`revokeInFlight` 只 `UPDATE public.exports`（`services/api/src/privacy/ledger-pg.ts` 的
 * `revokeInFlight`），`public.jobs` 里 `queued`/`running` 的识别/OCR/转写/问答作业仍可被调度执行。
 *
 * 本文件同时跑**内存账本**（`packages/privacy/ledger.mjs`）与**真库账本**（`privacy/ledger-pg.ts`，
 * 用按 SQL 文本分流的合成池，不连 PG），逐条钉：
 *   T1 `queued`/`running` 被置 `cancelled` + `CONSENT_WITHDRAWN`，`revision` 恰 +1；五个终态、
 *      另一个 `owner_id`、`owner_id IS NULL` 的 admin 行一行不动；
 *   T2 幂等：连跑两次，第二次零行变化（终态行不动、`revision` 不再涨）；
 *   T3 用途映射：`external_inference` 覆盖 ocr/recognition/transcription/answer；
 *      `media_processing` 不碰 answer；`recording` 只碰 transcription；`public_posting`/未知用途零行；
 *   T4 注销/全撤（`purpose=null`）不按 kind 过滤：全部在途 kind 都终止；
 *   T5 内存版与真库版**判据一致**：同一组输入，两边终止的行集合与终值逐字段相同；
 *   T6 返回值仍是外发账本行数（作业行数不混入）；空主体拒绝、未知用途传空数组；
 *   T7 撤回墓碑：`cancelled + CONSENT_WITHDRAWN` 的行再被 upsert（running/succeeded）严格 no-op，
 *      非墓碑行仍照常更新（证明守卫没有把 upsert 整体关掉）；
 *   T8 同事务：`BEGIN` → exports UPDATE → jobs UPDATE → `COMMIT` 全在同一 client；jobs UPDATE
 *      抛错 ⇒ `ROLLBACK` 且错误向上抛（fail-closed）。
 *
 * ## 为什么合成池不算「真库证据」
 * 合成池只按 SQL 文本分流、用同一组内存行模拟 WHERE；它证明**调用形状与参数**（尤其是 kind 映射）
 * 和内存实现一致，不证明 PG 的列权/执行计划。真库臂是
 * `tests/integration/egress-ledger-pg.mjs`（本片不在无 PG 环境冒充它）。SQL 的关键谓词另有静态断言，
 * 防止「合成池通过、真 SQL 写错」的假绿。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createConsentStore } from '../../packages/privacy/consent.mjs';
import { createExportLedger } from '../../packages/privacy/ledger.mjs';
import { jobKindsForPurpose, PURPOSE_JOB_KINDS } from '../../packages/privacy/job-kinds.mjs';
import {
  JOB_LEDGER_REVOKE_IN_FLIGHT_SQL,
  JOB_LEDGER_UPSERT_SQL,
  revokeJobLedgerInFlight,
  writeJobLedger,
} from '../../services/api/src/jobs/ledger.ts';
import { createPostgresExportLedger } from '../../services/api/src/privacy/ledger-pg.ts';
import { createAccountProvider, createRecipientStore, VERIFIED_RECIPIENT } from '../privacy/_fixtures.mjs';

const OWNER_A = '11111111-1111-4111-8111-1111111111aa';
const OWNER_B = '22222222-2222-4222-8222-2222222222bb';
const BASE_TIME = new Date('2026-11-07T00:00:00.000Z');

const TERMINAL_STATES = ['succeeded', 'uncertain', 'failed', 'timed_out', 'cancelled'];
const IN_FLIGHT_STATES = ['queued', 'running'];

const normalizeSql = (text) => String(text).replace(/\s+/g, ' ').trim();

/** 一条作业事实（与 `public.jobs` 的子集同义；内存/真库两侧从这里各自投影）。 */
function jobFact({ id, ownerId = OWNER_A, kind = 'ocr', state = 'queued', revision = 3, errorCode = null }) {
  return { id, ownerId, kind, state, revision, errorCode };
}

function memoryRow(fact) {
  return {
    id: fact.id,
    ownerId: fact.ownerId,
    kind: fact.kind,
    state: fact.state,
    revision: fact.revision,
    errorCode: fact.errorCode,
    updatedAt: new Date(BASE_TIME),
  };
}

function pgRow(fact) {
  return {
    id: fact.id,
    owner_id: fact.ownerId,
    kind: fact.kind,
    state: fact.state,
    revision: fact.revision,
    error_code: fact.errorCode,
    updated_at: new Date(BASE_TIME),
  };
}

function memoryLedger(facts) {
  const jobRows = new Map(facts.map((fact) => [fact.id, memoryRow(fact)]));
  // 固定「撤回时刻」：初始行用 BASE_TIME；撤回写入得到更晚的 updatedAt（证明真的刷新了）。
  const now = () => new Date(BASE_TIME.getTime() + 1000);
  const account = createAccountProvider({
    [OWNER_A]: { state: 'active', authEpoch: 1 },
    [OWNER_B]: { state: 'active', authEpoch: 1 },
  });
  const consentStore = createConsentStore({ now });
  const recipientStore = createRecipientStore({ [VERIFIED_RECIPIENT.id]: VERIFIED_RECIPIENT });
  const ledger = createExportLedger({
    consentStore,
    account,
    recipientStore,
    jobs: jobRows,
    now,
  });
  return { ledger, jobRows };
}

/**
 * 合成 PG 池：只识别本用例会碰到的语句，并模拟**一个事务客户端**。
 *
 * - 就绪探测：`to_regclass('public.export_writebacks')` ⇒ 返回已就绪（否则 `assertProvisioned` 先 409）；
 * - `BEGIN` / `SET LOCAL lock_timeout` / `COMMIT` / `ROLLBACK`：只记账；`ROLLBACK` 时把行恢复成 `BEGIN`
 *   前的快照（证明「整笔回滚」不是一句口号）；
 * - `UPDATE public.exports`：按 `$1` 用户 + `$2` 用途（`required_consents ? purpose`）筛；
 * - `UPDATE public.jobs`：按 `$1` 属主 + `$2` kind 数组（`null` = 全量）筛；`failJobsUpdate` 时抛 42501。
 *
 * 事务控制语句与两条 UPDATE 都走 `pool.connect()` 返回的**同一个 client**；`pool.query` 只用于
 * 就绪探测与 T6 直接调用 `revokeJobLedgerInFlight(pool, …)` 的场景。每条调用都记 `via`，T8 用它
 * 断言「同一 client」而不是只看语句顺序。
 *
 * ⛔ 不把 `kinds` 再翻译一次：池收到的就是账本传的参数，T3/T5 正是要证明这个参数与内存映射同值。
 */
function pgHarness({ facts = [], exports = [], failJobsUpdate = false } = {}) {
  const calls = [];
  const jobs = facts.map(pgRow);
  const cloneRows = (rows) =>
    rows.map((row) => ({
      ...row,
      required_consents: row.required_consents === undefined ? undefined : { ...row.required_consents },
      updated_at: new Date(row.updated_at),
    }));
  let transactionSnapshot = null;
  let connectCalls = 0;
  const client = {
    released: false,
    async query(text, values) {
      return run('client', text, values);
    },
    release() {
      client.released = true;
    },
  };

  async function run(via, text, values) {
    const sql = normalizeSql(text);
    calls.push({ text: sql, values, via });
    if (sql.includes("to_regclass('public.export_writebacks')")) {
      return {
        rows: [{ wb: 'public.export_writebacks', upd: true, upd_cancel: true }],
        rowCount: 1,
      };
    }
    if (sql === 'BEGIN') {
      transactionSnapshot = { jobs: cloneRows(jobs), exports: cloneRows(exports) };
      return { rows: [], rowCount: 0 };
    }
    if (sql === 'COMMIT') {
      transactionSnapshot = null;
      return { rows: [], rowCount: 0 };
    }
    if (sql === 'ROLLBACK') {
      if (transactionSnapshot !== null) {
        jobs.splice(0, jobs.length, ...cloneRows(transactionSnapshot.jobs));
        exports.splice(0, exports.length, ...cloneRows(transactionSnapshot.exports));
        transactionSnapshot = null;
      }
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith('SET LOCAL ')) return { rows: [], rowCount: 0 };
    if (sql.startsWith('UPDATE public.exports')) {
      const [userId, purpose] = values;
      const matched = exports.filter(
        (row) =>
          row.user_id === userId &&
          (row.state === 'reserved' || row.state === 'sent') &&
          (purpose === null || Object.prototype.hasOwnProperty.call(row.required_consents ?? {}, purpose)),
      );
      for (const row of matched) {
        row.state = 'failed';
        row.error_code = 'CONSENT_WITHDRAWN';
        row.revision += 1;
        row.updated_at = new Date(BASE_TIME.getTime() + 1000);
      }
      return { rows: matched.map((row) => ({ id: row.id })), rowCount: matched.length };
    }
    if (sql.startsWith('UPDATE public.jobs')) {
      if (failJobsUpdate) {
        throw Object.assign(new Error('合成池：注入 jobs UPDATE 失败'), { code: '42501' });
      }
      const [ownerId, kinds] = values;
      const matched = jobs.filter(
        (row) =>
          row.owner_id === ownerId &&
          IN_FLIGHT_STATES.includes(row.state) &&
          (kinds === null || kinds.includes(row.kind)),
      );
      for (const row of matched) {
        row.state = 'cancelled';
        row.error_code = 'CONSENT_WITHDRAWN';
        row.revision += 1;
        row.updated_at = new Date(BASE_TIME.getTime() + 1000);
      }
      return { rows: matched.map((row) => ({ id: row.id })), rowCount: matched.length };
    }
    throw new Error(`合成池遇到未登记的 SQL：${sql}`);
  }

  const pool = {
    async query(text, values) {
      return run('pool', text, values);
    },
    async connect() {
      connectCalls += 1;
      client.released = false;
      return client;
    },
  };
  return {
    ledger: createPostgresExportLedger({ pool }),
    pool,
    calls,
    jobs,
    exports,
    client,
    get connectCalls() {
      return connectCalls;
    },
  };
}

function memorySnapshot(jobRows) {
  return [...jobRows.values()]
    .map((row) => ({
      id: row.id,
      ownerId: row.ownerId,
      kind: row.kind,
      state: row.state,
      revision: row.revision,
      errorCode: row.errorCode,
      updatedAt: row.updatedAt.getTime(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function pgSnapshot(jobs) {
  return jobs
    .map((row) => ({
      id: row.id,
      ownerId: row.owner_id,
      kind: row.kind,
      state: row.state,
      revision: row.revision,
      errorCode: row.error_code,
      updatedAt: row.updated_at.getTime(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

const cancelledIds = (rows) =>
  rows.filter((row) => row.state === 'cancelled').map((row) => row.id).sort();

/** 一条完整台账行（只给 upsert 行为用例用；字段与 `JobLedgerRow` 同形）。 */
function ledgerRow(overrides = {}) {
  return {
    id: 'tombstone-1',
    ownerId: OWNER_A,
    kind: 'ocr',
    targetType: 'media',
    targetId: '33333333-3333-4333-8333-3333333333cc',
    entityRevision: 1,
    inputHash: 'a'.repeat(64),
    state: 'running',
    revision: 2,
    deadlineAt: new Date(BASE_TIME.getTime() + 30_000),
    errorCode: null,
    resultRef: '44444444-4444-4444-8444-4444444444dd',
    createdAt: new Date(BASE_TIME),
    updatedAt: new Date(BASE_TIME),
    ...overrides,
  };
}

/**
 * 台账 upsert 的**形状感知**合成执行器：按 `JOB_LEDGER_UPSERT_SQL` 里真实存在的撤回墓碑谓词
 * 决定冲突分支是否更新，而不是在测试里另写一份「墓碑」开关。
 *
 * 它不替代真 PG：证明的是「SQL 文本含墓碑谓词 + 该谓词对同态/异态行的效果符合预期」。
 * PG 的列权与执行计划由 `tests/integration/jobs-ledger-pg.mjs` 的真库臂负责。
 */
function upsertHarness(initialRows) {
  const rows = new Map(initialRows.map((row) => [row.id, { ...row }]));
  const calls = [];
  const sqlRunner = {
    async query(text, values) {
      const sql = normalizeSql(text);
      calls.push({ text: sql, values });
      assert.equal(sql, normalizeSql(JOB_LEDGER_UPSERT_SQL), 'upsert 必须原样使用导出的 SQL 常量');
      const [id, ownerId, kind, targetType, targetId, entityRevision, inputHash, state, revision, deadlineAt,
        errorCode, resultRef, createdAt, updatedAt] = values;
      const next = {
        id, ownerId, kind, targetType, targetId, entityRevision, inputHash, state, revision,
        deadlineAt, errorCode, resultRef, createdAt, updatedAt,
      };
      const existing = rows.get(next.id);
      if (existing === undefined) {
        rows.set(next.id, next);
        return { rows: [], rowCount: 1 };
      }
      const tombstoneGuard = /NOT \(jobs\.state = 'cancelled'::job_state\s+AND jobs\.error_code IS NOT DISTINCT FROM 'CONSENT_WITHDRAWN'\)/.test(sql);
      const isTombstone = existing.state === 'cancelled' && existing.errorCode === 'CONSENT_WITHDRAWN';
      const shouldUpdate = existing.state !== next.state && !(tombstoneGuard && isTombstone);
      if (shouldUpdate) {
        existing.state = next.state;
        existing.revision = next.revision;
        existing.errorCode = next.errorCode;
        existing.resultRef = next.resultRef;
        existing.updatedAt = next.updatedAt;
      }
      return { rows: [], rowCount: shouldUpdate ? 1 : 0 };
    },
  };
  return { rows, calls, write: (row) => writeJobLedger(sqlRunner, row) };
}

test('T1 queued/running 置 cancelled + CONSENT_WITHDRAWN、revision 恰 +1；终态/他人/admin 一行不动', async () => {
  const facts = [
    jobFact({ id: 'a-queued-ocr', kind: 'ocr', state: 'queued', revision: 3 }),
    jobFact({ id: 'a-running-answer', kind: 'answer', state: 'running', revision: 5 }),
    ...TERMINAL_STATES.map((state, index) =>
      jobFact({
        id: `a-terminal-${state}`,
        kind: index % 2 === 0 ? 'recognition' : 'transcription',
        state,
        revision: 7,
        errorCode: state === 'failed' ? 'PROVIDER_UNAVAILABLE' : null,
      }),
    ),
    jobFact({ id: 'b-queued-ocr', ownerId: OWNER_B, kind: 'ocr', state: 'queued', revision: 2 }),
    // admin 作业：`jobs_single_actor` 保证 owner_id 为 NULL、actor_admin_id 非空。
    jobFact({ id: 'admin-queued-ocr', ownerId: null, kind: 'ocr', state: 'queued', revision: 1 }),
  ];

  const memory = memoryLedger(facts);
  const pg = pgHarness({ facts });
  const beforeMemory = memorySnapshot(memory.jobRows);
  const beforePg = pgSnapshot(pg.jobs);

  const memoryCount = memory.ledger.revokeInFlight({ userId: OWNER_A, purpose: 'external_inference' });
  const pgCount = await pg.ledger.revokeInFlight({ userId: OWNER_A, purpose: 'external_inference' });
  assert.equal(memoryCount, 0, '本用例没有 exports 行：返回值只数外发账本');
  assert.equal(pgCount, 0, '本用例没有 exports 行：返回值只数外发账本');

  for (const snapshot of [memorySnapshot(memory.jobRows), pgSnapshot(pg.jobs)]) {
    const byId = new Map(snapshot.map((row) => [row.id, row]));
    for (const id of ['a-queued-ocr', 'a-running-answer']) {
      const row = byId.get(id);
      const before = beforeMemory.find((entry) => entry.id === id);
      assert.equal(row.state, 'cancelled', `${id} 必须被终止（⛔ 不是 failed）`);
      assert.equal(row.errorCode, 'CONSENT_WITHDRAWN', `${id} 必须带撤回原因码（与 exports 同码）`);
      assert.equal(row.revision, before.revision + 1, `${id} 的 revision 必须恰 +1`);
      assert.notEqual(row.updatedAt, before.updatedAt, `${id} 的 updated_at 必须刷新`);
    }
    for (const state of TERMINAL_STATES) {
      const id = `a-terminal-${state}`;
      assert.deepEqual(
        byId.get(id),
        beforeMemory.find((entry) => entry.id === id),
        `${state} 是终态：一行不动（state/revision/error_code/updated_at）`,
      );
    }
    assert.deepEqual(
      byId.get('b-queued-ocr'),
      beforeMemory.find((entry) => entry.id === 'b-queued-ocr'),
      '别的 owner_id 一行不动（越权终止是最严重的错）',
    );
    assert.deepEqual(
      byId.get('admin-queued-ocr'),
      beforeMemory.find((entry) => entry.id === 'admin-queued-ocr'),
      'owner_id IS NULL 的 admin 作业一行不动',
    );
  }

  // 真库侧收到的参数必须就是映射表的结果；SQL 谓词也要静态钉住（合成池不证明 SQL 文本）。
  const jobCall = pg.calls.find((call) => call.text.startsWith('UPDATE public.jobs'));
  assert.ok(jobCall, '真库账本必须发一条 UPDATE public.jobs');
  assert.deepEqual(
    jobCall.values,
    [OWNER_A, ['ocr', 'recognition', 'transcription', 'answer']],
    'external_inference 的 kind 集合必须与映射表逐项相同',
  );
  assert.equal(jobCall.text, normalizeSql(JOB_LEDGER_REVOKE_IN_FLIGHT_SQL), '必须原样使用导出的 SQL 常量');
  for (const predicate of [
    'WHERE owner_id = $1::uuid',
    "state IN ('queued','running')",
    '($2::text[] IS NULL OR kind = ANY($2::text[]))',
    'revision = revision + 1',
    "error_code = 'CONSENT_WITHDRAWN'",
    "state = 'cancelled'::job_state",
    'RETURNING id',
  ]) {
    assert.ok(JOB_LEDGER_REVOKE_IN_FLIGHT_SQL.includes(predicate), `SQL 缺关键谓词：${predicate}`);
  }
  assert.doesNotMatch(JOB_LEDGER_REVOKE_IN_FLIGHT_SQL, /RETURNING\s+\*/i, '不 RETURNING *：不把私有列再读出来');
  assert.equal(beforePg.length, pgSnapshot(pg.jobs).length, '合成池不得增删作业行');
});

test('T2 幂等：连跑两次，第二次不产生任何行变化（终态行不动、revision 不再涨）', async () => {
  const facts = [
    jobFact({ id: 'idem-queued', kind: 'ocr', state: 'queued', revision: 3 }),
    jobFact({ id: 'idem-running', kind: 'transcription', state: 'running', revision: 4 }),
    jobFact({ id: 'idem-succeeded', kind: 'answer', state: 'succeeded', revision: 9 }),
  ];
  const memory = memoryLedger(facts);
  const pg = pgHarness({ facts });

  assert.equal(memory.ledger.revokeInFlight({ userId: OWNER_A, purpose: 'external_inference' }), 0);
  assert.equal(await pg.ledger.revokeInFlight({ userId: OWNER_A, purpose: 'external_inference' }), 0);
  const afterFirstMemory = memorySnapshot(memory.jobRows);
  const afterFirstPg = pgSnapshot(pg.jobs);

  assert.equal(memory.ledger.revokeInFlight({ userId: OWNER_A, purpose: 'external_inference' }), 0);
  assert.equal(await pg.ledger.revokeInFlight({ userId: OWNER_A, purpose: 'external_inference' }), 0);

  assert.deepEqual(memorySnapshot(memory.jobRows), afterFirstMemory, '内存版第二次调用必须严格 no-op');
  assert.deepEqual(pgSnapshot(pg.jobs), afterFirstPg, '真库版第二次调用必须严格 no-op');
  assert.equal(
    memory.jobRows.get('idem-queued').revision,
    4,
    'revision 只涨一次：第二次命中 0 行（state 已不是 queued/running）',
  );
});

test('T3 按用途只命中映射表里的 kind；映射表外的 kind 不动', async () => {
  const facts = [
    jobFact({ id: 'kind-ocr', kind: 'ocr', state: 'queued', revision: 1 }),
    jobFact({ id: 'kind-recognition', kind: 'recognition', state: 'queued', revision: 1 }),
    jobFact({ id: 'kind-transcription', kind: 'transcription', state: 'queued', revision: 1 }),
    jobFact({ id: 'kind-answer', kind: 'answer', state: 'queued', revision: 1 }),
    // 台账未接的两源（若将来有行）：映射表没写 ⇒ 不猜、不动。
    jobFact({ id: 'kind-synthesis', kind: 'synthesis', state: 'queued', revision: 1 }),
    jobFact({ id: 'kind-moderation', kind: 'moderation', state: 'queued', revision: 1 }),
  ];

  const cases = [
    {
      purpose: 'external_inference',
      expected: ['kind-answer', 'kind-ocr', 'kind-recognition', 'kind-transcription'],
      kinds: ['ocr', 'recognition', 'transcription', 'answer'],
    },
    {
      purpose: 'media_processing',
      expected: ['kind-ocr', 'kind-recognition', 'kind-transcription'],
      kinds: ['ocr', 'recognition', 'transcription'],
    },
    { purpose: 'recording', expected: ['kind-transcription'], kinds: ['transcription'] },
    { purpose: 'public_posting', expected: [], kinds: [] },
    { purpose: 'future_unknown_purpose', expected: [], kinds: [] },
  ];

  for (const { purpose, expected, kinds } of cases) {
    const memory = memoryLedger(facts);
    const pg = pgHarness({ facts });
    memory.ledger.revokeInFlight({ userId: OWNER_A, purpose });
    await pg.ledger.revokeInFlight({ userId: OWNER_A, purpose });
    assert.deepEqual(cancelledIds(memorySnapshot(memory.jobRows)), expected, `内存版 ${purpose} 的命中集合`);
    assert.deepEqual(cancelledIds(pgSnapshot(pg.jobs)), expected, `真库版 ${purpose} 的命中集合`);
    const jobCall = pg.calls.find((call) => call.text.startsWith('UPDATE public.jobs'));
    assert.deepEqual(jobCall.values, [OWNER_A, kinds], `${purpose} 传给真库的 kind 集合`);
  }

  assert.deepEqual(PURPOSE_JOB_KINDS.external_inference, ['ocr', 'recognition', 'transcription', 'answer']);
  assert.deepEqual(PURPOSE_JOB_KINDS.media_processing, ['ocr', 'recognition', 'transcription']);
  assert.deepEqual(PURPOSE_JOB_KINDS.recording, ['transcription']);
  assert.deepEqual(PURPOSE_JOB_KINDS.public_posting, []);
  assert.equal(jobKindsForPurpose(null), null, 'purpose=null 是全量（注销/全撤）');
  assert.equal(jobKindsForPurpose(''), null, '空串与 exports 的 `if (purpose && …)` 同义：全量');
  assert.deepEqual(jobKindsForPurpose('future_unknown_purpose'), [], '表外用途 ⇒ 空数组（不动任何行）');
});

test('T4 注销/全撤（purpose=null）不按 kind 过滤：所有在途 kind 都终止', async () => {
  const facts = [
    jobFact({ id: 'all-ocr', kind: 'ocr', state: 'queued', revision: 1 }),
    jobFact({ id: 'all-recognition', kind: 'recognition', state: 'running', revision: 1 }),
    jobFact({ id: 'all-transcription', kind: 'transcription', state: 'queued', revision: 1 }),
    jobFact({ id: 'all-answer', kind: 'answer', state: 'running', revision: 1 }),
    jobFact({ id: 'all-synthesis', kind: 'synthesis', state: 'queued', revision: 1 }),
    jobFact({ id: 'all-moderation', kind: 'moderation', state: 'running', revision: 1 }),
    jobFact({ id: 'all-terminal', kind: 'ocr', state: 'succeeded', revision: 1 }),
    jobFact({ id: 'all-other-owner', ownerId: OWNER_B, kind: 'ocr', state: 'queued', revision: 1 }),
  ];
  const memory = memoryLedger(facts);
  const pg = pgHarness({ facts });

  memory.ledger.revokeInFlight({ userId: OWNER_A });
  await pg.ledger.revokeInFlight({ userId: OWNER_A });

  const expected = [
    'all-answer',
    'all-moderation',
    'all-ocr',
    'all-recognition',
    'all-synthesis',
    'all-transcription',
  ];
  assert.deepEqual(cancelledIds(memorySnapshot(memory.jobRows)), expected);
  assert.deepEqual(cancelledIds(pgSnapshot(pg.jobs)), expected);
  assert.equal(memory.jobRows.get('all-terminal').state, 'succeeded', '终态行不动');
  assert.equal(memory.jobRows.get('all-other-owner').state, 'queued', '他人行不动');
  const jobCall = pg.calls.find((call) => call.text.startsWith('UPDATE public.jobs'));
  assert.deepEqual(jobCall.values, [OWNER_A, null], 'purpose=null 必须把 $2 传成 null（SQL 不再按 kind 过滤）');
});

test('T5 内存版与真库版判据一致：同一组输入，两边终止的行集合与终值逐字段相同', async () => {
  const facts = [
    jobFact({ id: 'parity-a-ocr', kind: 'ocr', state: 'queued', revision: 2 }),
    jobFact({ id: 'parity-a-recognition', kind: 'recognition', state: 'running', revision: 3 }),
    jobFact({ id: 'parity-a-transcription', kind: 'transcription', state: 'queued', revision: 4 }),
    jobFact({ id: 'parity-a-answer', kind: 'answer', state: 'running', revision: 5 }),
    jobFact({ id: 'parity-a-synthesis', kind: 'synthesis', state: 'queued', revision: 6 }),
    jobFact({ id: 'parity-a-done', kind: 'ocr', state: 'timed_out', revision: 7 }),
    jobFact({ id: 'parity-b-ocr', ownerId: OWNER_B, kind: 'ocr', state: 'queued', revision: 8 }),
  ];

  for (const purpose of ['external_inference', 'media_processing', 'recording', 'public_posting', null]) {
    const memory = memoryLedger(facts);
    const pg = pgHarness({ facts });
    memory.ledger.revokeInFlight({ userId: OWNER_A, purpose });
    await pg.ledger.revokeInFlight({ userId: OWNER_A, purpose });
    const memoryRows = memorySnapshot(memory.jobRows);
    const pgRows = pgSnapshot(pg.jobs);
    assert.deepEqual(pgRows, memoryRows, `purpose=${String(purpose)}：内存版与真库版的终值必须逐字段相同`);
    assert.deepEqual(
      cancelledIds(pgRows),
      cancelledIds(memoryRows),
      `purpose=${String(purpose)}：两边终止的行集合必须相同`,
    );
  }
});

test('T6 返回值仍是外发账本行数；空主体拒绝；未知用途传空数组', async () => {
  const exportRow = {
    id: 'export-reserved-1',
    user_id: OWNER_A,
    state: 'reserved',
    revision: 2,
    required_consents: { external_inference: 1 },
    error_code: null,
    updated_at: new Date(BASE_TIME),
  };
  const facts = [
    jobFact({ id: 'ret-queued-1', kind: 'ocr', state: 'queued', revision: 1 }),
    jobFact({ id: 'ret-queued-2', kind: 'answer', state: 'queued', revision: 1 }),
  ];
  const pg = pgHarness({ facts, exports: [exportRow] });
  const count = await pg.ledger.revokeInFlight({ userId: OWNER_A, purpose: 'external_inference' });
  assert.equal(count, 1, '返回值只数 public.exports 的撤销行（作业行数不混入，既有审计语义不变）');
  assert.equal(exportRow.state, 'failed');
  assert.deepEqual(cancelledIds(pgSnapshot(pg.jobs)), ['ret-queued-1', 'ret-queued-2']);

  const callsBefore = pg.calls.length;
  await assert.rejects(
    () => revokeJobLedgerInFlight(pg.pool, { ownerId: '   ' }),
    /台账撤回缺少主体/,
    '空主体必须拒绝（⛔ 不许退化成终止全部作业行）',
  );
  assert.equal(pg.calls.length, callsBefore, '空主体在发 SQL 之前就拒绝：零查询');

  const empty = pgHarness({ facts });
  const revoked = await revokeJobLedgerInFlight(empty.pool, { ownerId: OWNER_A, purpose: 'public_posting' });
  assert.equal(revoked, 0, 'public_posting 不产生作业行：真实命中 0 行');
  const jobCall = empty.calls.find((call) => call.text.startsWith('UPDATE public.jobs'));
  assert.deepEqual(jobCall.values, [OWNER_A, []], '表外/无作业用途必须传空数组，而不是 null（null 是全量）');
});

test('T7 撤回墓碑：cancelled + CONSENT_WITHDRAWN 的行再 upsert running/succeeded 均严格 no-op；非墓碑行照常更新', async () => {
  const tombstone = ledgerRow({
    id: 'tombstone-1',
    state: 'cancelled',
    revision: 5,
    errorCode: 'CONSENT_WITHDRAWN',
    resultRef: 'old-result',
    updatedAt: new Date(BASE_TIME),
  });
  const harness = upsertHarness([tombstone]);
  const before = { ...harness.rows.get('tombstone-1') };

  // 两种「域内作业下一次写台账」的典型状态：running 与 succeeded。都必须被墓碑挡住。
  await harness.write(ledgerRow({
    id: 'tombstone-1',
    state: 'running',
    revision: 6,
    errorCode: null,
    resultRef: 'new-running-result',
    updatedAt: new Date(BASE_TIME.getTime() + 1000),
  }));
  assert.deepEqual(
    harness.rows.get('tombstone-1'),
    before,
    'running upsert 必须严格 no-op（state/revision/error_code/result_ref/updated_at 全不动）',
  );

  await harness.write(ledgerRow({
    id: 'tombstone-1',
    state: 'succeeded',
    revision: 7,
    errorCode: null,
    resultRef: 'new-succeeded-result',
    updatedAt: new Date(BASE_TIME.getTime() + 2000),
  }));
  assert.deepEqual(
    harness.rows.get('tombstone-1'),
    before,
    'succeeded upsert 也必须严格 no-op：撤回审计痕迹不能被一次正常完成覆盖',
  );

  // 对照：非墓碑行仍按原来的「异态才更新」语义前进，证明墓碑守卫没有把 upsert 整体关掉。
  const normal = ledgerRow({
    id: 'normal-1',
    state: 'running',
    revision: 2,
    errorCode: null,
    resultRef: 'normal-old',
    updatedAt: new Date(BASE_TIME),
  });
  const normalHarness = upsertHarness([normal]);
  await normalHarness.write(ledgerRow({
    id: 'normal-1',
    state: 'succeeded',
    revision: 3,
    errorCode: null,
    resultRef: 'normal-new',
    updatedAt: new Date(BASE_TIME.getTime() + 1000),
  }));
  const advanced = normalHarness.rows.get('normal-1');
  assert.equal(advanced.state, 'succeeded');
  assert.equal(advanced.revision, 3);
  assert.equal(advanced.errorCode, null);
  assert.equal(advanced.resultRef, 'normal-new');
  assert.equal(advanced.updatedAt.getTime(), BASE_TIME.getTime() + 1000);

  // 空值边界：普通用户取消是 `cancelled + error_code=NULL`，不是撤回墓碑。墓碑判据必须用
  // `IS NOT DISTINCT FROM`（或等价的空值安全写法）；写成 `=` 会让 `NOT (true AND NULL)` 变成 NULL，
  // 连这条普通取消也被误判成墓碑而永远不再更新。
  const cancelledNoCode = upsertHarness([
    ledgerRow({ id: 'cancel-null-1', state: 'cancelled', revision: 2, errorCode: null }),
  ]);
  await cancelledNoCode.write(ledgerRow({
    id: 'cancel-null-1',
    state: 'succeeded',
    revision: 3,
    errorCode: null,
    resultRef: 'cancel-null-new',
    updatedAt: new Date(BASE_TIME.getTime() + 1500),
  }));
  const afterCancelledNoCode = cancelledNoCode.rows.get('cancel-null-1');
  assert.equal(afterCancelledNoCode.state, 'succeeded', 'error_code=NULL 的普通取消不得被墓碑判据误伤');
  assert.equal(afterCancelledNoCode.revision, 3);
  assert.equal(afterCancelledNoCode.resultRef, 'cancel-null-new');
  assert.equal(afterCancelledNoCode.updatedAt.getTime(), BASE_TIME.getTime() + 1500);

  // 同态重放（state 未变）仍按既有守卫 no-op；这条不是墓碑特例，别把两件事混成一件。
  const sameState = upsertHarness([ledgerRow({ id: 'same-1', state: 'running', revision: 2 })]);
  const sameBefore = { ...sameState.rows.get('same-1') };
  await sameState.write(ledgerRow({
    id: 'same-1',
    state: 'running',
    revision: 9,
    errorCode: null,
    resultRef: 'same-new',
    updatedAt: new Date(BASE_TIME.getTime() + 3000),
  }));
  assert.deepEqual(sameState.rows.get('same-1'), sameBefore, '同态重放仍必须严格 no-op（既有语义不变）');

  // SQL 文本本身也要钉住：合成执行器读到的是这条谓词，去掉它 T7 会先在行为断言上红。
  assert.match(
    normalizeSql(JOB_LEDGER_UPSERT_SQL),
    /WHERE jobs\.state IS DISTINCT FROM EXCLUDED\.state AND NOT \(jobs\.state = 'cancelled'::job_state AND jobs\.error_code IS NOT DISTINCT FROM 'CONSENT_WITHDRAWN'\)/,
    'upsert 的冲突分支必须同时保留同态守卫与撤回墓碑守卫（error_code 用 IS NOT DISTINCT FROM，空值不能误判）',
  );
});

test('T8 同一事务：BEGIN → exports UPDATE → jobs UPDATE → COMMIT 全在同一 client；jobs 失败 ⇒ ROLLBACK + 错误上抛', async () => {
  const exportRow = {
    id: 'export-tx-1',
    user_id: OWNER_A,
    state: 'reserved',
    revision: 2,
    required_consents: { external_inference: 1 },
    error_code: null,
    updated_at: new Date(BASE_TIME),
  };
  const facts = [jobFact({ id: 'tx-queued-1', kind: 'ocr', state: 'queued', revision: 1 })];
  const ok = pgHarness({ facts, exports: [exportRow] });

  const count = await ok.ledger.revokeInFlight({ userId: OWNER_A, purpose: 'external_inference' });
  assert.equal(count, 1, '返回值仍是 public.exports 的命中行数');
  const relevant = ok.calls.filter(
    (call) =>
      call.text === 'BEGIN' ||
      call.text === 'COMMIT' ||
      call.text.startsWith('UPDATE public.exports') ||
      call.text.startsWith('UPDATE public.jobs'),
  );
  assert.deepEqual(
    relevant.map((call) =>
      call.text === 'BEGIN' || call.text === 'COMMIT'
        ? call.text
        : call.text.startsWith('UPDATE public.exports')
          ? 'exports UPDATE'
          : 'jobs UPDATE',
    ),
    ['BEGIN', 'exports UPDATE', 'jobs UPDATE', 'COMMIT'],
    '语句顺序必须是 BEGIN → exports UPDATE → jobs UPDATE → COMMIT',
  );
  assert.deepEqual(
    [...new Set(relevant.map((call) => call.via))],
    ['client'],
    '四条语句必须都走同一个 pool.connect() 返回的 client（⛔ 不许 exports 走 pool、jobs 走 client）',
  );
  assert.equal(ok.connectCalls, 1, '一次撤回只借一个连接（一个事务）');
  assert.equal(ok.client.released, true, '事务结束必须 release');
  assert.equal(
    ok.calls.some((call) => call.via === 'pool' && /^UPDATE /.test(call.text)),
    false,
    '写语句不得绕过事务 client 直接走 pool',
  );

  // 失败臂：jobs UPDATE 抛错 ⇒ 两条 UPDATE 一起回滚，错误向上抛（不是吞掉后返回 exports 行数）。
  const failingExport = {
    id: 'export-tx-2',
    user_id: OWNER_A,
    state: 'reserved',
    revision: 4,
    required_consents: { external_inference: 1 },
    error_code: null,
    updated_at: new Date(BASE_TIME),
  };
  const failing = pgHarness({ facts, exports: [failingExport], failJobsUpdate: true });
  await assert.rejects(
    () => failing.ledger.revokeInFlight({ userId: OWNER_A, purpose: 'external_inference' }),
    (error) => error?.code === 'PROVIDER_UNAVAILABLE' && error?.retryable === false,
    'jobs UPDATE 失败必须向调用方抛契约错误（fail-closed），不能静默返回外发行数',
  );
  const failedRelevant = failing.calls.filter(
    (call) =>
      call.text === 'BEGIN' ||
      call.text === 'COMMIT' ||
      call.text === 'ROLLBACK' ||
      call.text.startsWith('UPDATE public.exports') ||
      call.text.startsWith('UPDATE public.jobs'),
  );
  assert.deepEqual(
    failedRelevant.map((call) =>
      call.text === 'BEGIN' || call.text === 'COMMIT' || call.text === 'ROLLBACK'
        ? call.text
        : call.text.startsWith('UPDATE public.exports')
          ? 'exports UPDATE'
          : 'jobs UPDATE',
    ),
    ['BEGIN', 'exports UPDATE', 'jobs UPDATE', 'ROLLBACK'],
    'jobs 失败后必须 ROLLBACK，且不得 COMMIT',
  );
  assert.equal(failing.calls.some((call) => call.text === 'COMMIT'), false, '失败臂不得 COMMIT');
  assert.equal(failing.client.released, true, '失败臂也必须 release');
  // 回滚证据：exports 回到 reserved（不是 failed），jobs 仍在 queued。
  const restored = failing.exports[0];
  assert.equal(restored.state, 'reserved', 'exports UPDATE 必须随事务回滚（不留下"外发已撤"的半截状态）');
  assert.equal(restored.revision, 4, 'exports.revision 也必须回到事务前');
  assert.equal(restored.error_code, null);
  assert.equal(restored.updated_at.getTime(), BASE_TIME.getTime());
  assert.equal(failing.jobs[0].state, 'queued', 'jobs 行不得被半截更新');
});
