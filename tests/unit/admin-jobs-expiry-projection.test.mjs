/**
 * W47 钉子：运维台作业读面与四域读面**同口径** —— 过期作业对外报 `timed_out`。
 *
 * 缺陷（派单 §0）：四域读面（`conversations` / `ocr` / `speech` / `recognitions` 的 GET）遇到
 * 「库内仍 `queued` / `running`、但 `deadline_at` 已过」的作业会裁定成 `timed_out`，运维台的
 * `GET /admin/jobs` 与 `GET /admin/jobs/{id}` 却原样吐 `queued`——管理员永远看到一条「处理中」。
 *
 * 本文件只做一件事：把「同口径」这句话拆成可执行断言（T1–T6）。全是**假池**，不连 PG：
 * `{ query, connect }` 按 SQL 子串分派（与 `tests/unit/admin-jobs-answer-source.test.mjs` 同一做法）；
 * 时刻靠端口新加的可选 `now` 注入（`createPostgresAdminJobPort({ pool, now })`）钉死。
 *
 *   T1 answer 源：库内 `queued` + `deadline_at` 已过 ⇒ `list()` 与 `get()` 都报
 *      `timed_out` + `error_code = 'PROVIDER_TIMEOUT'`，且 `revision` / `deadline_at` 原样（没写库）。
 *   T2 三个域内源（`ocr` / `recognition` / `transcription`）同一条判据都生效。
 *   T3 宽限边界（`jobs/expiry.ts` 的 `JOB_EXPIRY_GRACE_MS`）：`at = deadline + grace` **算**过期
 *      （含等号）；`at = deadline + grace - 1ms` 不算；`deadline = at - 1ms`（只超 1 毫秒）不算。
 *   T4 不该动的别动：五个终态原样、`deadline_at` 为未来原样、`deadline_at` 为 `null` / 非法
 *      不投影（保持库内原样，绝不当成过期）。
 *   T5 只读证明：`list` / `get` 之后假池没收到任何 `UPDATE` / `INSERT`，也没开事务。
 *   T6 零 SQL 文本漂移：`ADMIN_JOB_SQL` 与基线（`e59973d3`）**逐字相同**。
 *
 * ⚠ 本文件里**不写死**任何 `源文件:行号`（R31 的 `test-line-anchors-guard` 会判红）：
 * 行号一律按内容实时定位，或干脆不断言行号。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ADMIN_JOB_LIST_LIMIT,
  ADMIN_JOB_SQL,
  createPostgresAdminJobPort,
  isReadDeadlineExpired,
} from '../../services/api/src/admin/ops/jobs-pg.ts';
import { JOB_EXPIRY_GRACE_MS } from '../../services/api/src/jobs/expiry.ts';
import { makeUuid } from './admin-ops-fixtures.mjs';

// ---------------------------------------------------------------------------
// 假池：按 `FROM public.<表>` 分派（列表回全表、单条按 `$1::uuid` 定位）
// ---------------------------------------------------------------------------

const TABLE_OCR = 'public.ocr_jobs';
const TABLE_RECOGNITION = 'public.recognition_jobs';
const TABLE_TRANSCRIPTION = 'public.speech_jobs';
const TABLE_ANSWER = 'public.conversation_turns';
const TABLES = [TABLE_OCR, TABLE_RECOGNITION, TABLE_TRANSCRIPTION, TABLE_ANSWER];

/** 四源的「记录外键」列名（`projectRow` 读 `row[source.recordColumn]`）。 */
const RECORD_COLUMN = {
  [TABLE_OCR]: 'ocr_id',
  [TABLE_RECOGNITION]: 'recognition_id',
  [TABLE_TRANSCRIPTION]: 'transcription_id',
  [TABLE_ANSWER]: 'record_id',
};

const JOB_ID = {
  [TABLE_OCR]: makeUuid(1801),
  [TABLE_RECOGNITION]: makeUuid(1802),
  [TABLE_TRANSCRIPTION]: makeUuid(1803),
  [TABLE_ANSWER]: makeUuid(1804),
};

const RECORD_ID = {
  [TABLE_OCR]: makeUuid(1811),
  [TABLE_RECOGNITION]: makeUuid(1812),
  [TABLE_TRANSCRIPTION]: makeUuid(1813),
  [TABLE_ANSWER]: makeUuid(1814),
};

/** 一行作业的**投影形状**（列名照各源 `listSelect` / `getSql` 的别名）。 */
function jobRow(table, overrides = {}) {
  return {
    id: JOB_ID[table],
    revision: 1,
    [RECORD_COLUMN[table]]: RECORD_ID[table],
    state: 'queued',
    deadline_at: new Date(Date.parse('2026-11-02T12:00:00.000Z') - 10 * 60_000).toISOString(),
    created_at: '2026-11-02T11:40:00.000Z',
    error_code: null,
    target_revision: null,
    ...overrides,
  };
}

/**
 * 读面假池。
 *
 * 列表语句（带 `LIMIT $1::integer`）回整张表（`list()` 测试都不带过滤），单条语句按 `$1::uuid`
 * 命中一行——`get` 逐源试，命中的那一条就是来源。`connect()` 一律记账后抛错：
 * 读面开事务本身就是缺陷（同时是 T5 的第二道证据）。
 */
function fakePool(rowsByTable) {
  const calls = [];
  let connectCalls = 0;
  return {
    calls,
    get connectCalls() {
      return connectCalls;
    },
    async query(text, values = []) {
      calls.push({ text, values: [...values] });
      const table = TABLES.find((name) => text.includes(`FROM ${name} `) || text.includes(`FROM ${name}\n`));
      if (table === undefined) return { rows: [] };
      const rows = rowsByTable[table] ?? [];
      if (text.includes('LIMIT $1::integer')) return { rows };
      return { rows: rows.filter((row) => row.id === values[0]) };
    },
    async connect() {
      connectCalls += 1;
      throw new Error('读面不该开事务（只读投影，绝不写库）');
    },
  };
}

const portWith = (pool, now) => createPostgresAdminJobPort({
  pool,
  limit: ADMIN_JOB_LIST_LIMIT,
  ...(now === undefined ? {} : { now }),
});

const fixedNow = (iso) => () => new Date(iso);
const NOW_ISO = '2026-11-02T12:00:00.000Z';

/** 读一条作业（`get`），断言它存在的来源不存在就当场失败（比索引 `[0]` 更好读）。 */
async function getOrFail(port, table) {
  const job = await port.get(JOB_ID[table]);
  assert.ok(job !== null, `get(${JOB_ID[table]}) 返回 null：假池没把 ${table} 的那一行交出来`);
  return job;
}

// ---------------------------------------------------------------------------
// T1：answer 源 —— 最要紧的一条（`/admin/jobs` 上最长寿的「假 queued」）
// ---------------------------------------------------------------------------

test('T1 answer 源：库内 queued + deadline 已过 ⇒ list 与 get 都报 timed_out', async () => {
  const pool = fakePool({ [TABLE_ANSWER]: [jobRow(TABLE_ANSWER)] });
  const port = portWith(pool, fixedNow(NOW_ISO));

  const listed = await port.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].kind, 'answer');
  assert.equal(listed[0].state, 'timed_out', 'list() 仍把过期作业报成 queued：运维台与四域读面不同口径');
  assert.equal(listed[0].error_code, 'PROVIDER_TIMEOUT');

  // 只读投影：除了 `state` / `error_code`，其余列一律照库里的原样透出（revision 不 +1）。
  const one = await getOrFail(port, TABLE_ANSWER);
  assert.equal(one.state, 'timed_out');
  assert.equal(one.error_code, 'PROVIDER_TIMEOUT');
  assert.equal(one.revision, 1, '读面把 revision 改了：说明有人把「投影」写成了「落库」');
  assert.equal(one.deadline_at, jobRow(TABLE_ANSWER).deadline_at, 'deadline_at 被改写了：投影只该动 state / error_code');
  assert.equal(one.result, null, 'timed_out 不产出结果，result 必须恒 null');
});

// ---------------------------------------------------------------------------
// T2：三个域内源同判据（四源统一，别只修 answer）
// ---------------------------------------------------------------------------

test('T2 ocr / recognition / transcription：同一条判据三个源都生效', async () => {
  const cases = [
    { table: TABLE_OCR, kind: 'ocr', state: 'queued' },
    { table: TABLE_RECOGNITION, kind: 'recognition', state: 'running' },
    { table: TABLE_TRANSCRIPTION, kind: 'transcription', state: 'queued' },
  ];
  for (const item of cases) {
    const pool = fakePool({ [item.table]: [jobRow(item.table, { state: item.state })] });
    const port = portWith(pool, fixedNow(NOW_ISO));
    const listed = await port.list();
    assert.equal(listed.length, 1, `${item.table} 的列表没回那一行`);
    assert.equal(listed[0].kind, item.kind);
    assert.equal(listed[0].state, 'timed_out', `${item.kind} 源的 ${item.state} 行过期后仍报 ${listed[0].state}`);
    const one = await getOrFail(port, item.table);
    assert.equal(one.state, 'timed_out', `${item.kind} 源的 get 没投影成 timed_out`);
    assert.equal(one.error_code, 'PROVIDER_TIMEOUT');
  }
});

// ---------------------------------------------------------------------------
// T3：宽限边界（`isDeadlineExpired` 含等号，别自己写 `>`）
// ---------------------------------------------------------------------------

/** 在 `nowMs` 这一刻读一条 `deadline_at = deadlineMs` 的作业，返回它的 state。 */
async function stateAt(deadlineMs, nowMs) {
  const pool = fakePool({
    [TABLE_OCR]: [jobRow(TABLE_OCR, { deadline_at: new Date(deadlineMs).toISOString() })],
  });
  const port = portWith(pool, fixedNow(new Date(nowMs).toISOString()));
  return (await getOrFail(port, TABLE_OCR)).state;
}

test('T3 宽限边界：deadline + grace 当刻算过期、早 1 毫秒不算、只超 1 毫秒也不算', async () => {
  const deadline = Date.parse(NOW_ISO);
  const grace = JOB_EXPIRY_GRACE_MS;
  assert.ok(Number.isInteger(grace) && grace > 0, 'JOB_EXPIRY_GRACE_MS 应是正整数（共享真源在 jobs/expiry.ts）');

  // 含等号：`at >= deadline + grace` 即过期。
  assert.equal(await stateAt(deadline, deadline + grace), 'timed_out', '`at === deadline + grace` 必须算过期（判据是 >=，不是 >）');
  // 差 1 毫秒还没到宽限。
  assert.equal(await stateAt(deadline, deadline + grace - 1), 'queued', '`at === deadline + grace - 1ms` 不该判过期');
  // 刚过截止 1 毫秒、但仍在宽限内。
  assert.equal(await stateAt(deadline, deadline + 1), 'queued', '只超 deadline 1 毫秒就判过期：宽限被丢了');
  // 正好到截止（宽限内最左端）。
  assert.equal(await stateAt(deadline, deadline), 'queued', '`at === deadline` 不该判过期（宽限还有 5s）');
  // 宽限之外 1 毫秒。
  assert.equal(await stateAt(deadline, deadline + grace + 1), 'timed_out');
});

// ---------------------------------------------------------------------------
// T4：不该动的别动（终态原样、未来 deadline 原样、null / 非法 deadline 不投影）
// ---------------------------------------------------------------------------

test('T4 五个终态 + 未来 deadline 一律原样（读面不是第二次判决）', async () => {
  const untouched = [
    { state: 'succeeded', error_code: null },
    { state: 'failed', error_code: 'PROVIDER_TIMEOUT' },
    { state: 'timed_out', error_code: 'PROVIDER_TIMEOUT' },
    { state: 'cancelled', error_code: null },
    { state: 'uncertain', error_code: 'INPUT_UNCERTAIN' },
  ];
  for (const item of untouched) {
    // deadline 早已过去，但状态是终态 ⇒ 一个字节都不许改。
    const pool = fakePool({ [TABLE_ANSWER]: [jobRow(TABLE_ANSWER, item)] });
    const port = portWith(pool, fixedNow(NOW_ISO));
    const one = await getOrFail(port, TABLE_ANSWER);
    assert.equal(one.state, item.state, `终态 ${item.state} 被读面改写了`);
    assert.equal(one.error_code, item.error_code, `终态 ${item.state} 的 error_code 被读面改写了`);
  }

  // queued 但 deadline 在未来 ⇒ 原样 queued（投影只对「已过期」生效）。
  const future = new Date(Date.parse(NOW_ISO) + 60 * 60_000).toISOString();
  const pool = fakePool({ [TABLE_ANSWER]: [jobRow(TABLE_ANSWER, { deadline_at: future })] });
  const port = portWith(pool, fixedNow(NOW_ISO));
  const pending = await getOrFail(port, TABLE_ANSWER);
  assert.equal(pending.state, 'queued', '还没到期的作业被判成超时了');
  assert.equal(pending.error_code, null, '还没到期的作业被塞了 error_code');
});

test('T4 deadline_at 为 null / 非法 ⇒ 不投影（保持原样，绝不当成过期）', async () => {
  const at = new Date(NOW_ISO);
  assert.equal(
    isReadDeadlineExpired({ state: 'queued', deadline_at: null }, at),
    false,
    'deadline_at 为 null 的行被判成过期：null 不等于「无限早」',
  );
  assert.equal(isReadDeadlineExpired({ state: 'queued' }, at), false, '没有 deadline_at 这一列时也不许判过期');
  assert.equal(
    isReadDeadlineExpired({ state: 'queued', deadline_at: 'not-a-timestamp' }, at),
    false,
    '非法 deadline_at 被判成过期了',
  );
  assert.equal(
    isReadDeadlineExpired({ state: 'queued', deadline_at: new Date(Number.NaN) }, at),
    false,
    'Invalid Date 被判成过期了',
  );
  // 判据本身的反面：同一行给一个合法且已过的 deadline ⇒ true（证明上面几条不是「函数恒 false」）。
  assert.equal(
    isReadDeadlineExpired({ state: 'queued', deadline_at: '2026-11-02T11:00:00.000Z' }, at),
    true,
    '合法且已过的 deadline 没被判成过期：判据根本没生效',
  );

  // `pg` 驱动对 `timestamptz` 给的是 `Date` 实例（假池给的是 ISO 字符串）：两条路都必须走得通，
  // 否则真库上「过期」这件事会因为「值不是字符串」被静默跳过。
  assert.equal(
    isReadDeadlineExpired({ state: 'queued', deadline_at: new Date('2026-11-02T11:00:00.000Z') }, at),
    true,
    '`deadline_at` 是 Date 实例（真 pg 的形状）且已过 ⇒ 必须判过期',
  );
  const datePool = fakePool({
    [TABLE_ANSWER]: [jobRow(TABLE_ANSWER, { deadline_at: new Date('2026-11-02T11:00:00.000Z') })],
  });
  const dateJob = await getOrFail(portWith(datePool, fixedNow(NOW_ISO)), TABLE_ANSWER);
  assert.equal(dateJob.state, 'timed_out', '`deadline_at` 为 Date 实例时读面没投影（真库的默认形状）');

  // 端口层面：`deadline_at` 为 null 的行本来就过不了 `toAdminJobView`（`isoAt` 要求合法时间戳），
  // 这是**本片之前就有**的行为，投影不改变它——只是别让「null ⇒ timed_out」发生。
  const pool = fakePool({ [TABLE_ANSWER]: [jobRow(TABLE_ANSWER, { deadline_at: null })] });
  const port = portWith(pool, fixedNow(NOW_ISO));
  await assert.rejects(
    () => port.get(JOB_ID[TABLE_ANSWER]),
    /deadline_at/,
    'deadline_at 为 null 时读面应沿用既有的 503（而不是把这一行报成 timed_out）',
  );
});

// ---------------------------------------------------------------------------
// T5：只读证明（投影绝不写库，也不开事务）
// ---------------------------------------------------------------------------

test('T5 只读：list / get 不产生任何 UPDATE / INSERT，也不开事务', async () => {
  const pool = fakePool({
    [TABLE_OCR]: [jobRow(TABLE_OCR)],
    [TABLE_ANSWER]: [jobRow(TABLE_ANSWER)],
  });
  const port = portWith(pool, fixedNow(NOW_ISO));

  await port.list();
  await getOrFail(port, TABLE_OCR);
  await getOrFail(port, TABLE_ANSWER);

  assert.ok(pool.calls.length >= 3, '假池一次查询都没收到：这些用例没走到读面');
  const writes = pool.calls.filter((call) => /^\s*(?:UPDATE|INSERT)\b/i.test(call.text));
  assert.deepEqual(writes.map((call) => call.text), [], '读面发出了写语句：投影必须是只读的');
  const transactions = pool.calls.filter((call) => /^\s*(?:BEGIN|COMMIT|ROLLBACK)\b|lock_timeout/i.test(call.text));
  assert.deepEqual(transactions.map((call) => call.text), [], '读面开了事务：GET 不该像取消那样走事务');
  assert.equal(pool.connectCalls, 0, '读面调了 connect()：只有取消事务才该开连接');
});

// ---------------------------------------------------------------------------
// T6：零 SQL 文本漂移（派单 §1④：SQL 一个字都不许动）
// ---------------------------------------------------------------------------

/**
 * 基线（`e59973d3` = `origin/main`）的 `ADMIN_JOB_SQL`，**逐字抄写**。
 *
 * 为什么整份抄：本片只允许改「返回视图」，`listSelect` / `listTail` / `getSql` / `lockSql` /
 * `updateSql` / `listWhereFor` / 审计语句一个字都不许动；抄一份基线再 `deepEqual`，比
 * 「断言某几个关键字还在」强得多——改一个列名、挪一个空格都会被这条打红。
 */
const BASELINE_SQL = {
  list: [
    'SELECT j.id, j.revision, j.ocr_id, j.state, j.deadline_at, j.created_at, j.error_code, r.revision AS target_revision FROM public.ocr_jobs AS j LEFT JOIN public.ocr_records AS r ON r.id = j.ocr_id ORDER BY j.created_at DESC, j.id DESC LIMIT $1::integer',
    'SELECT j.id, j.revision, j.recognition_id, j.state, j.deadline_at, j.created_at, j.error_code, r.revision AS target_revision FROM public.recognition_jobs AS j LEFT JOIN public.recognition_records AS r ON r.id = j.recognition_id ORDER BY j.created_at DESC, j.id DESC LIMIT $1::integer',
    'SELECT j.id, j.revision, j.transcription_id, j.state, j.deadline_at, j.created_at, j.error_code, r.revision AS target_revision FROM public.speech_jobs AS j LEFT JOIN public.transcriptions AS r ON r.id = j.transcription_id ORDER BY j.created_at DESC, j.id DESC LIMIT $1::integer',
    'SELECT j.job_id AS id, j.revision, j.id AS record_id, j.job_state AS state, j.job_deadline_at AS deadline_at, j.job_created_at AS created_at, j.job_error_code AS error_code FROM public.conversation_turns j ORDER BY j.job_created_at DESC, j.id DESC LIMIT $1::integer',
  ],
  listWhere: [
    {
      kind: 'ocr',
      stateCast: 'text',
      where: {
        state: ' WHERE state = $2::text',
        error_code: ' WHERE error_code = $2::text',
        state_and_error_code: ' WHERE state = $2::text AND error_code = $3::text',
      },
    },
    {
      kind: 'recognition',
      stateCast: 'job_state',
      where: {
        state: ' WHERE state = $2::job_state',
        error_code: ' WHERE error_code = $2::text',
        state_and_error_code: ' WHERE state = $2::job_state AND error_code = $3::text',
      },
    },
    {
      kind: 'transcription',
      stateCast: 'job_state',
      where: {
        state: ' WHERE state = $2::job_state',
        error_code: ' WHERE error_code = $2::text',
        state_and_error_code: ' WHERE state = $2::job_state AND error_code = $3::text',
      },
    },
    {
      kind: 'answer',
      stateCast: 'text',
      where: {
        state: ' WHERE job_state = $2::text',
        error_code: ' WHERE job_error_code = $2::text',
        state_and_error_code: ' WHERE job_state = $2::text AND job_error_code = $3::text',
      },
    },
  ],
  get: [
    'SELECT j.id, j.revision, j.ocr_id, j.state, j.deadline_at, j.created_at, j.error_code, r.revision AS target_revision FROM public.ocr_jobs AS j LEFT JOIN public.ocr_records AS r ON r.id = j.ocr_id WHERE j.id = $1::uuid',
    'SELECT j.id, j.revision, j.recognition_id, j.state, j.deadline_at, j.created_at, j.error_code, r.revision AS target_revision FROM public.recognition_jobs AS j LEFT JOIN public.recognition_records AS r ON r.id = j.recognition_id WHERE j.id = $1::uuid',
    'SELECT j.id, j.revision, j.transcription_id, j.state, j.deadline_at, j.created_at, j.error_code, r.revision AS target_revision FROM public.speech_jobs AS j LEFT JOIN public.transcriptions AS r ON r.id = j.transcription_id WHERE j.id = $1::uuid',
    'SELECT j.job_id AS id, j.revision, j.id AS record_id, j.job_state AS state, j.job_deadline_at AS deadline_at, j.job_created_at AS created_at, j.job_error_code AS error_code FROM public.conversation_turns j WHERE j.job_id = $1::uuid',
  ],
  lock: [
    'SELECT id, revision, ocr_id, owner_user_id, media_id, media_revision, state, deadline_at, created_at, error_code FROM public.ocr_jobs WHERE id = $1::uuid FOR UPDATE',
    'SELECT id, revision, recognition_id, owner_user_id, media_id, media_revision, state, deadline_at, created_at, error_code FROM public.recognition_jobs WHERE id = $1::uuid FOR UPDATE',
    'SELECT id, revision, transcription_id, owner_user_id, media_id, media_revision, state, deadline_at, created_at, error_code FROM public.speech_jobs WHERE id = $1::uuid FOR UPDATE',
    'SELECT j.job_id AS id, j.revision, j.id AS record_id, j.owner_id AS owner_user_id, j.job_state AS state, j.job_deadline_at AS deadline_at, j.job_created_at AS created_at, j.job_error_code AS error_code, j.updated_at FROM public.conversation_turns j WHERE j.job_id = $1::uuid FOR UPDATE',
  ],
  update: [
    "UPDATE public.ocr_jobs SET state = 'cancelled', revision = revision + 1, updated_at = now() WHERE id = $1::uuid AND revision = $2::integer AND state IN ('queued','running') RETURNING id, revision, ocr_id, state, deadline_at, created_at, error_code, updated_at",
    "UPDATE public.recognition_jobs SET state = 'cancelled', revision = revision + 1, updated_at = now() WHERE id = $1::uuid AND revision = $2::integer AND state IN ('queued','running') RETURNING id, revision, recognition_id, state, deadline_at, created_at, error_code, updated_at",
    "UPDATE public.speech_jobs SET state = 'cancelled', revision = revision + 1, updated_at = now() WHERE id = $1::uuid AND revision = $2::integer AND state IN ('queued','running') RETURNING id, revision, transcription_id, state, deadline_at, created_at, error_code, updated_at",
    "UPDATE public.conversation_turns SET job_state = 'cancelled', job_error_code = NULL, revision = revision + 1, updated_at = now() WHERE job_id = $1::uuid AND revision = $2::integer AND job_state IN ('queued', 'running') RETURNING job_id AS id, revision, id AS record_id, job_state AS state, job_deadline_at AS deadline_at, job_created_at AS created_at, job_error_code AS error_code, updated_at",
  ],
  cancelAudit: 'SELECT public.record_admin_job_cancel_audit($1::uuid, $2::uuid, $3::integer, $4::text, $5::uuid) AS audit_event_id',
  limit: 200,
};

test('T6 零 SQL 文本漂移：ADMIN_JOB_SQL 与基线逐字相同', () => {
  assert.deepEqual(
    ADMIN_JOB_SQL,
    BASELINE_SQL,
    'SQL 文本被改动了：本片只允许改「返回视图」，`listSelect` / `listTail` / `getSql` / `lockSql` / '
      + '`updateSql` / 过滤片段 / 审计语句一个字都不许动（`sql-column-coverage` 与 T6 都会抓）',
  );
  // 四源 × 四条 + 审计一条 = 17 条（`sql-column-coverage.test.mjs` 的逐文件计数器）。
  assert.equal(ADMIN_JOB_SQL.list.length, 4);
  assert.equal(ADMIN_JOB_SQL.get.length, 4);
  assert.equal(ADMIN_JOB_SQL.lock.length, 4);
  assert.equal(ADMIN_JOB_SQL.update.length, 4);
  assert.equal(ADMIN_JOB_SQL.limit, ADMIN_JOB_LIST_LIMIT);
});
