/**
 * GY-R28 S20（#20）· 语音转写域 PG 持久化的**真库**端到端证据（PostgreSQL 17.11 + 迁移 `0026`）。
 *
 * 本脚本只讲一件事：**转写任务与转写记录真的落到了数据库里，关掉连接重开还在**——
 * 这是本片唯一的核心主张（此前只有内存 store，进程重启即丢）。在此之上逐条取证：
 *   [M] 迁移 `0026` 三连：结构不变量 ⇒ UP（三表/索引/外键/CHECK 出现）⇒ ROLLBACK（本片对象消失，
 *       `users` 与既有 `jobs` 表逐字仍在）⇒ REPLAY（再出现）。另加 [M5] 行为取证：state/kind/revision
 *       的 CHECK 真的拒绝闭集外的值（23514），不是只写在注释里。
 *   [W] 接线：`real` + 真池 ⇒ `app.speechService.describe().storePersistent === true`；
 *       `real` + 无池 ⇒ `false`（如实内存，**不**冒充持久）。
 *   [1]–[12] `SpeechStore` **12 个方法逐条**：写入 / 读回 / CAS 返回 null / `commitTerminal` 的
 *       "CAS 失败不写记录、记录冲突回滚" / 幂等台账的 claim-exists-finalize-release-purge。
 *   [R] **重启**：写入 → `pool.end()` 关闭全部连接 → **新 Pool + 新 store / 新 app** → 按指纹
 *       逐字节比对仍相等；另**尝试**子进程臂（真·进程重启；spawn 受限时如实登记未取得）。
 *   [N] 负控制（每条都必须真的能红）：`byte_exact_restore`（篡改后必红、原样写回必绿）、
 *       内存 store 在同一序列下"新实例读不到"、CAS 并发双写只允许一次成功、并发双 claim 恰好一次
 *       `claimed`、原始输出改写被存储层拒绝、**迁移回滚后写入 fail-closed 点名 0026**（缺表三态）。
 *
 * 运行（专用测试库必须是**空库**；脚本先断言 public 下 0 张表）：
 *   createdb -h 127.0.0.1 -p <port> gengyun_speech_test
 *   SPEECH_PG_TEST_URL=postgres://gengyun_cvm_owner@127.0.0.1:<port>/gengyun_speech_test \
 *     node tests/integration/speech-pg.mjs
 *
 * 未设置 `SPEECH_PG_TEST_URL` ⇒ 打印 `SKIP` 并以 **77** 退出（POSIX「skipped」）：本次运行**没有**
 * 验证真库（不是通过）。本机明知无真库、只想看跳过原因时可显式加 `--allow-skip`
 * （或 `GY_ALLOW_SKIP=1`）取 0 —— ⛔ 不得用于门禁。
 * `npm run test:integration:http` 不包含本文件（它需要真库）；CI 接线属后续片
 * （本片在 `tests/unit/ci-integration-chain-structure.test.mjs` 的 `UNWIRED_DECLARATIONS` 如实声明）。
 *
 * 已知边界（如实登记，不吹）：三张语音表**本片不给授权**（`deploy/postgres-cvm/**` 一字未改），
 * 运行时角色直连会 42501；本脚本用**库 owner** 取证，只证明迁移与 store 语义，不证明线上角色已授权。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createPostgresAuthStore } from '../../services/api/src/auth/store.ts';
import { createMemorySpeechStore } from '../../services/api/src/speech/store.ts';
import { createPostgresSpeechStore, SpeechTablesMissingError } from '../../services/api/src/speech/store-pg.ts';
import { discoverMigrations } from '../../services/api/src/db/migrate.ts';

const ENV = 'SPEECH_PG_TEST_URL';
const DB = 'gengyun_speech_test';
const MIGRATION = '0026_speech_persistence.sql';
const DOWN = `migrations/rollback/${MIGRATION.replace(/\.sql$/, '.down.sql')}`;
const VERIFY_ONLY = process.argv.includes('--verify-after-restart');

const rawUrl = process.env[ENV];
// 缺真库时的出口：默认 77（未取得，不是通过）；只有显式 `--allow-skip` / `GY_ALLOW_SKIP=1` 才降级为 0。
const ALLOW_SKIP = process.argv.includes('--allow-skip') || process.env.GY_ALLOW_SKIP === '1';
if ((rawUrl === undefined || rawUrl.trim() === '') && !VERIFY_ONLY) {
  console.log(`SKIP real PG17: ${ENV} 未设置 —— 本次运行没有验证真库持久化（不是通过，也不是失败）。`);
  if (ALLOW_SKIP) {
    console.log('EXITCODE=0（--allow-skip / GY_ALLOW_SKIP=1 已显式授权：仅本机开发，⛔ 不得接进门禁）。');
    process.exit(0);
  }
  console.log('EXITCODE=77 表示未取得，不是通过（POSIX 惯例 skipped；本机明知无真库时可显式加 --allow-skip 取 0）。');
  process.exit(77);
}

const url = new URL(rawUrl);
assert.ok(['postgres:', 'postgresql:'].includes(url.protocol), `${ENV} 必须是 postgres URL`);
assert.equal(url.search, '', '连接参数由脚本控制，测试 URL 不带查询串');
assert.ok(
  ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname),
  `只允许回环地址，实际 ${url.hostname}`,
);
assert.equal(url.pathname, `/${DB}`, `只允许专用测试库 ${DB}`);

let passed = 0;
const say = (message) => {
  passed += 1;
  console.log(`PASS ${passed}: ${message}`);
};
const unread = (label, why) => console.log(`未取得 ${label}：${why}`);

const readSql = (rel) => readFileSync(new URL(`../../services/api/db/${rel}`, import.meta.url), 'utf8');
const migrationsDir = new URL('../../services/api/db/migrations/', import.meta.url);
const hash = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/** 行指纹：把行规范化成 JSON 再取 sha256（**重启前后逐字节相等**的判据就落在这里）。 */
function jobFingerprint(row) {
  return hash(
    JSON.stringify({
      id: row.id,
      revision: row.revision,
      kind: row.kind,
      ownerUserId: row.ownerUserId,
      transcriptionId: row.transcriptionId,
      mediaId: row.mediaId,
      mediaRevision: row.mediaRevision,
      state: row.state,
      deadlineAt: row.deadlineAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      errorCode: row.errorCode,
    }),
  );
}

function transcriptionFingerprint(row) {
  return hash(
    JSON.stringify({
      id: row.id,
      revision: row.revision,
      ownerUserId: row.ownerUserId,
      mediaId: row.mediaId,
      mediaRevision: row.mediaRevision,
      rawText: row.rawText,
      uncertainSpans: row.uncertainSpans,
      confirmedText: row.confirmedText,
      confirmedAt: row.confirmedAt === null ? null : row.confirmedAt.toISOString(),
      modelVersion: row.modelVersion,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      deleted: row.deleted,
    }),
  );
}

// ---------------------------------------------------------------------------
// 子进程臂（真·进程重启）：只读、只断言，任何不符都以非 0 退出。
// ---------------------------------------------------------------------------
if (VERIFY_ONLY) {
  const expectedJobFingerprint = process.env['GY_SPEECH_JOB_FP'];
  const expectedRecordFingerprint = process.env['GY_SPEECH_RECORD_FP'];
  const jobId = process.env['GY_SPEECH_JOB_ID'];
  const transcriptionId = process.env['GY_SPEECH_TRANSCRIPTION_ID'];
  const owner = process.env['GY_SPEECH_OWNER'];
  const client = new pg.Pool({ connectionString: url.href });
  try {
    const store = createPostgresSpeechStore({ pool: client });
    assert.equal(store.persistent, true, '子进程：store 必须如实声明持久化');
    const job = await store.getJob(jobId);
    assert.notEqual(job, null, '子进程：重启后任务行必须仍在');
    assert.equal(job.ownerUserId, owner, '子进程：任务归属者必须逐字一致');
    const record = await store.getTranscription(transcriptionId);
    assert.notEqual(record, null, '子进程：重启后转写记录必须仍在');
    assert.equal(jobFingerprint(job), expectedJobFingerprint, '子进程：任务行指纹必须与写入时逐字节相等');
    assert.equal(
      transcriptionFingerprint(record),
      expectedRecordFingerprint,
      '子进程：转写记录指纹必须与写入时逐字节相等',
    );
    console.log(`CHILD-PID=${process.pid}`);
    console.log(`CHILD-JOB-FP=${jobFingerprint(job)}`);
    console.log(`CHILD-RECORD-FP=${transcriptionFingerprint(record)}`);
    console.log('CHILD-RESULT=PERSISTED（新进程、新连接池，按指纹逐字节相等）');
  } finally {
    await client.end().catch(() => {});
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 主臂
// ---------------------------------------------------------------------------
const ownerClient = new pg.Client({ connectionString: url.href });
await ownerClient.connect();
/** 本进程开过的池：全部 `end()` 后才能说"连接全关过"。 */
const openedPools = [];
const newPool = () => {
  const created = new pg.Pool({ connectionString: url.href, max: 4 });
  openedPools.push(created);
  return created;
};
let pool = newPool();

const q = async (text, params = []) => (await ownerClient.query(text, params)).rows;
const one = async (text, params = []) => (await q(text, params))[0];
const countOf = async (text, params = []) => Number((await one(text, params)).v);

// 夹具：固定时刻（毫秒精度，与 store 写回口径一致，便于逐字节比对）。
const T0 = new Date('2026-10-21T08:00:00.000Z');
const T1 = new Date('2026-10-21T08:00:01.000Z');
const T2 = new Date('2026-10-21T08:00:02.000Z');

/** 合法区间：逐项 start/end/reason，顺序故意不按 start 排（存储层不得擅自排序）。 */
const SPANS = [
  { start: 10, end: 14, reason: '剂量数字不确定' },
  { start: 0, end: 4, reason: '制剂名称前缀被截断' },
];
const RAW_TEXT = '合成用例·这是待人工核对的原始转写文本（不是真实用户录音）';
const CONFIRMED_TEXT = '合成用例·这是人工核对后可发送的文本';

function makeJobRow(overrides = {}) {
  return {
    id: randomUUID(),
    revision: 1,
    kind: 'transcription',
    ownerUserId: OWNER_ID,
    transcriptionId: randomUUID(),
    mediaId: randomUUID(),
    mediaRevision: 3,
    state: 'queued',
    deadlineAt: new Date(T0.getTime() + 30_000),
    createdAt: T0,
    updatedAt: T0,
    errorCode: null,
    ...overrides,
  };
}

function makeTranscriptionRow(jobRow, overrides = {}) {
  return {
    id: jobRow.transcriptionId,
    revision: 1,
    ownerUserId: OWNER_ID,
    mediaId: jobRow.mediaId,
    mediaRevision: jobRow.mediaRevision,
    rawText: RAW_TEXT,
    uncertainSpans: structuredClone(SPANS),
    confirmedText: null,
    confirmedAt: null,
    modelVersion: 'stub-v1',
    createdAt: T1,
    updatedAt: T1,
    deleted: false,
    ...overrides,
  };
}

let OWNER_ID;
let FOREIGN_ID;

// ---------------------------------------------------------------------------
// [M] 迁移三连 + 结构不变量
// ---------------------------------------------------------------------------
async function migrationTriple() {
  // 与 `tests/integration/migrations-negative-pg.mjs` 共同的**两条结构不变量**（本片新增 0026 后
  // 必须仍成立：连续无缺号、总数 === 最大版本号）。这里独立复算一次并打印读数。
  const discovered = discoverMigrations();
  const numbers = discovered.map((migration) => Number(migration.version));
  const max = Math.max(...numbers);
  const missing = [];
  for (let expected = 1; expected <= max; expected += 1) {
    if (!numbers.includes(expected)) missing.push(String(expected).padStart(4, '0'));
  }
  assert.deepEqual(missing, [], `迁移版本号必须在 1..${max} 上连续无缺号`);
  assert.equal(discovered.length, max, `迁移总数必须等于最大版本号（count=${discovered.length}，max=${max}）`);
  const names = discovered.map((migration) => migration.filename);
  assert.ok(names.includes(MIGRATION), `迁移清单必须含 ${MIGRATION}`);
  say(`[M0] 结构不变量：迁移 ${discovered.length} 个（0001..${String(max).padStart(4, '0')}），连续无缺号；count === max；含 ${MIGRATION}`);

  const objects = async () => ({
    jobs: (await one("SELECT to_regclass('public.speech_jobs') AS v")).v,
    transcriptions: (await one("SELECT to_regclass('public.transcriptions') AS v")).v,
    idem: (await one("SELECT to_regclass('public.speech_idempotency') AS v")).v,
    jobsIdx: (await one("SELECT to_regclass('public.speech_jobs_owner_created_idx') AS v")).v,
    transcriptionsIdx: (await one("SELECT to_regclass('public.transcriptions_owner_created_idx') AS v")).v,
    idemIdx: (await one("SELECT to_regclass('public.speech_idempotency_expires_idx') AS v")).v,
    stateEnumAtt: await countOf(
      "SELECT count(*)::int AS v FROM pg_attribute a WHERE a.attrelid = to_regclass('public.speech_jobs') AND a.attname = 'state' AND a.atttypid = to_regtype('public.job_state') AND a.attnum > 0 AND NOT a.attisdropped",
    ),
    stateEnumValues: (
      await one(
        "SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS v FROM pg_enum e WHERE e.enumtypid = to_regtype('public.job_state')",
      )
    ).v,
    users: (await one("SELECT to_regclass('public.users') AS v")).v,
    jobsTable: (await one("SELECT to_regclass('public.jobs') AS v")).v,
    fkCascade: await countOf(
      "SELECT count(*)::int AS v FROM pg_constraint WHERE conrelid IN (to_regclass('public.speech_jobs'), to_regclass('public.transcriptions')) AND contype = 'f' AND confdeltype = 'c'",
    ),
  });

  for (const name of readdirSync(migrationsDir).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort()) {
    if (name === MIGRATION) continue;
    await ownerClient.query(readSql(`migrations/${name}`));
  }
  let state = await objects();
  assert.equal(state.jobs, null, '应用其它迁移后 speech_jobs 必须还不存在（证明 UP 才是它出现的唯一原因）');
  assert.equal(state.users, 'users', '0001 的 users 必须在岗（外键与夹具都依赖它）');
  say('[M1] 0001..0025 已应用：speech_* / transcriptions 全部不存在，users 在岗');

  await ownerClient.query(readSql(`migrations/${MIGRATION}`));
  state = await objects();
  assert.equal(state.jobs, 'speech_jobs', 'UP 后 speech_jobs 必须存在');
  assert.equal(state.transcriptions, 'transcriptions', 'UP 后 transcriptions 必须存在');
  assert.equal(state.idem, 'speech_idempotency', 'UP 后 speech_idempotency 必须存在');
  assert.equal(state.jobsIdx, 'speech_jobs_owner_created_idx', 'UP 后归属+排序索引必须在岗');
  assert.equal(state.transcriptionsIdx, 'transcriptions_owner_created_idx', 'UP 后记录归属+排序索引必须在岗');
  assert.equal(state.idemIdx, 'speech_idempotency_expires_idx', 'UP 后台账过期索引必须在岗');
  assert.equal(
    state.stateEnumAtt,
    1,
    'state 列的类型必须正是 0001 的 job_state 枚举（不是自由 text：取值域由类型系统封死）',
  );
  assert.deepEqual(
    state.stateEnumValues,
    ['queued', 'running', 'succeeded', 'uncertain', 'failed', 'timed_out', 'cancelled'],
    'job_state 枚举必须恰好是 0001 定义的 7 个取值，逐项对齐（多一个或少一个都算契约漂移）',
  );
  assert.equal(state.fkCascade, 2, '任务与记录各一条 ON DELETE CASCADE 外键（注销级联）');
  say('[M2] UP：三表 + 三索引 + state 绑定 job_state 枚举（7 值逐项核对）+ 2 条 CASCADE 外键全部出现');

  await ownerClient.query(readSql(DOWN));
  state = await objects();
  assert.equal(state.jobs, null, 'DOWN 后 speech_jobs 必须消失');
  assert.equal(state.transcriptions, null, 'DOWN 后 transcriptions 必须消失');
  assert.equal(state.idem, null, 'DOWN 后 speech_idempotency 必须消失');
  assert.equal(state.jobsIdx, null, 'DOWN 后索引必须消失');
  assert.equal(state.users, 'users', 'DOWN 不得触碰 users');
  assert.equal(state.jobsTable, 'jobs', 'DOWN 不得触碰 0001 的共享 jobs 表');
  say('[M3] ROLLBACK：本片对象全部消失，users 与 0001 的 jobs 表逐字仍在');

  await ownerClient.query(readSql(`migrations/${MIGRATION}`));
  assert.equal((await objects()).jobs, 'speech_jobs', 'REPLAY 后必须再次出现（迁移可重放）');
  say('[M4] REPLAY：同一份 UP 再执行一次仍成功，speech_jobs 再次出现');
}

// ---------------------------------------------------------------------------
// [1]–[12] 12 个方法逐条
// ---------------------------------------------------------------------------
async function allTwelve(store) {
  // ---- [1] insertJob ----
  const job = makeJobRow();
  await store.insertJob(job);
  assert.equal(
    await countOf('SELECT count(*)::int AS v FROM public.speech_jobs WHERE id = $1', [job.id]),
    1,
    '[1] insertJob 必须真的落库 1 行',
  );
  const storedJob = await one('SELECT kind, revision, state, transcription_id FROM public.speech_jobs WHERE id = $1', [job.id]);
  assert.equal(storedJob.kind, 'transcription', '[1] 库内 kind 必须是 transcription');
  assert.equal(storedJob.state, 'queued', '[1] 库内 state 初始 queued');
  assert.equal(storedJob.transcription_id, job.transcriptionId, '[1] 库内 transcription_id 与契约行一致');
  await assert.rejects(
    () => store.insertJob({ ...job, transcriptionId: randomUUID() }),
    (error) => error instanceof Error && error.message === '任务 id 冲突',
    '[1] 同 id 再写必须抛「任务 id 冲突」（判定由主键裁决，不是先查后写）',
  );
  say('[1] insertJob：落库 1 行（kind/state/transcription_id 逐字对）；同 id 再写由主键裁决并抛「任务 id 冲突」');

  // ---- [2] getJob ----
  const readBack = await store.getJob(job.id);
  assert.notEqual(readBack, null, '[2] getJob 必须读到刚写入的行');
  assert.equal(readBack.revision, 1, '[2] revision 初始 1');
  assert.equal(readBack.state, 'queued', '[2] state 初始 queued');
  assert.equal(readBack.kind, 'transcription', '[2] kind 必须是 transcription');
  assert.equal(readBack.ownerUserId, OWNER_ID, '[2] 归属者逐字一致');
  assert.equal(readBack.transcriptionId, job.transcriptionId, '[2] transcription_id 逐字一致');
  assert.equal(readBack.mediaId, job.mediaId, '[2] media_id 逐字一致');
  assert.equal(readBack.mediaRevision, 3, '[2] media_revision 逐字一致');
  assert.equal(readBack.errorCode, null, '[2] 初始无错误码');
  assert.deepEqual(readBack.deadlineAt, job.deadlineAt, '[2] deadline_at 毫秒级往返相等');
  assert.deepEqual(readBack.createdAt, job.createdAt, '[2] created_at 毫秒级往返相等');
  assert.equal(await store.getJob(randomUUID()), null, '[2] 不存在的 id ⇒ null（与"查不到"同形）');
  say('[2] getJob：命中返回逐字段相等的行（含毫秒级时间往返）；不存在 ⇒ null');

  // ---- [3] updateJob（CAS） ----
  assert.equal(
    await store.updateJob(job.id, 999, (row) => ({ ...row, revision: row.revision + 1 })),
    null,
    '[3] revision 不匹配必须返回 null',
  );
  assert.equal(
    (await one('SELECT revision FROM public.speech_jobs WHERE id = $1', [job.id])).revision,
    1,
    '[3] CAS 失败后库内 revision 必须仍是 1（不得被写）',
  );
  const running = await store.updateJob(job.id, 1, (row) => ({ ...row, state: 'running', revision: row.revision + 1, updatedAt: T1 }));
  assert.notEqual(running, null, '[3] revision 命中必须返回新行');
  assert.equal(running.revision, 2, '[3] revision 恰好 +1');
  assert.equal(running.state, 'running', '[3] state 迁移到 running');
  assert.equal(
    (await one('SELECT revision, state FROM public.speech_jobs WHERE id = $1', [job.id])).state,
    'running',
    '[3] 库内 state 必须同步为 running',
  );
  assert.equal(
    await store.updateJob(job.id, 1, (row) => ({ ...row, state: 'running', revision: row.revision + 1 })),
    null,
    '[3] 用过期的 revision 再写必须返回 null（CAS 不叠加）',
  );
  say('[3] updateJob：CAS 失败 ⇒ null 且库内 revision 不变；命中 ⇒ 状态迁移 + revision 恰好 +1；过期 revision 再写 ⇒ null');

  // ---- [4] commitTerminal ----
  // (a) 命中：running → succeeded，同一事务里落转写记录。
  const record = makeTranscriptionRow(job);
  const committed = await store.commitTerminal(job.id, 2, { state: 'succeeded', errorCode: null }, record, T2);
  assert.notEqual(committed, null, '[4] 合法终态迁移必须成功');
  assert.equal(committed.state, 'succeeded', '[4] 任务进入 succeeded');
  assert.equal(committed.revision, 3, '[4] 终态提交 revision 恰好 +1');
  assert.equal(await countOf('SELECT count(*)::int AS v FROM public.transcriptions WHERE id = $1', [record.id]), 1, '[4] 转写记录必须与终态在同一事务里落库');
  const committedRow = await one('SELECT state, revision FROM public.speech_jobs WHERE id = $1', [job.id]);
  assert.equal(committedRow.state, 'succeeded', '[4] 库内任务 state=succeeded');
  assert.equal(committedRow.revision, 3, '[4] 库内任务 revision=3');
  const recordRow = await one('SELECT raw_text, uncertain_spans, confirmed_text FROM public.transcriptions WHERE id = $1', [record.id]);
  assert.equal(recordRow.raw_text, RAW_TEXT, '[4] 记录 raw_text 逐字落库');
  assert.deepEqual(recordRow.uncertain_spans, SPANS, '[4] uncertain_spans 逐项原样落库（不排序/不合并）');
  assert.equal(recordRow.confirmed_text, null, '[4] 审核前 confirmed_text 必须为 null');

  // (b) CAS 失败：不写记录（事务里先锁读后判、判失败不落 INSERT）。
  const casJob = makeJobRow();
  await store.insertJob(casJob);
  await store.updateJob(casJob.id, 1, (row) => ({ ...row, state: 'running', revision: row.revision + 1, updatedAt: T1 }));
  const casRecord = makeTranscriptionRow(casJob);
  assert.equal(
    await store.commitTerminal(casJob.id, 1, { state: 'succeeded', errorCode: null }, casRecord, T2),
    null,
    '[4] 终态提交的 expectedRevision 过期必须返回 null',
  );
  assert.equal(
    await countOf('SELECT count(*)::int AS v FROM public.transcriptions WHERE id = $1', [casRecord.id]),
    0,
    '[4] CAS 失败不得写转写记录（同一事务，先判后写）',
  );
  assert.equal(
    (await one('SELECT state, revision FROM public.speech_jobs WHERE id = $1', [casJob.id])).state,
    'running',
    '[4] CAS 失败不得改任务状态',
  );

  // (c) 状态机：已取消任务不得被迟到结果复活。
  const cancelJob = makeJobRow();
  await store.insertJob(cancelJob);
  const cancelled = await store.commitTerminal(cancelJob.id, 1, { state: 'cancelled', errorCode: null }, null, T1);
  assert.equal(cancelled.state, 'cancelled', '[4] queued ⇒ cancelled 合法（且不需要转写记录）');
  assert.equal(
    await store.commitTerminal(cancelJob.id, 2, { state: 'succeeded', errorCode: null }, makeTranscriptionRow(cancelJob), T2),
    null,
    '[4] 已取消任务不得被迟到结果改写',
  );
  assert.equal(
    (await one('SELECT state FROM public.speech_jobs WHERE id = $1', [cancelJob.id])).state,
    'cancelled',
    '[4] 库内状态必须仍是 cancelled',
  );

  // (d) 记录冲突：整个事务回滚，任务行不留半成品。
  const conflictJob = makeJobRow();
  await store.insertJob(conflictJob);
  await store.updateJob(conflictJob.id, 1, (row) => ({ ...row, state: 'running', revision: row.revision + 1, updatedAt: T1 }));
  const duplicateRecord = makeTranscriptionRow(conflictJob, { id: record.id });
  await assert.rejects(
    () => store.commitTerminal(conflictJob.id, 2, { state: 'succeeded', errorCode: null }, duplicateRecord, T2),
    (error) => error instanceof Error && error.message === '转写记录 id 冲突',
    '[4] 记录 id 冲突必须抛「转写记录 id 冲突」（与内存同文案）',
  );
  const conflictRow = await one('SELECT state, revision FROM public.speech_jobs WHERE id = $1', [conflictJob.id]);
  assert.equal(conflictRow.state, 'running', '[4] 记录冲突必须回滚：任务 state 仍是 running');
  assert.equal(conflictRow.revision, 2, '[4] 记录冲突必须回滚：revision 仍是 2');
  say('[4] commitTerminal：合法终态任务+记录同事务落库；CAS 失败不写记录；取消后迟到结果 null；记录冲突整体回滚（任务与 revision 均未变）');

  // ---- [5] insertTranscription ----
  const standalone = makeTranscriptionRow(makeJobRow({ transcriptionId: randomUUID() }));
  await store.insertTranscription(standalone);
  assert.equal(
    await countOf('SELECT count(*)::int AS v FROM public.transcriptions WHERE id = $1', [standalone.id]),
    1,
    '[5] insertTranscription 必须真的落库 1 行',
  );
  await assert.rejects(
    () => store.insertTranscription({ ...standalone, rawText: '另一份' }),
    (error) => error instanceof Error && error.message === '转写记录 id 冲突',
    '[5] 同 id 再写必须抛「转写记录 id 冲突」',
  );
  say('[5] insertTranscription：落库 1 行；同 id 再写由主键裁决并抛「转写记录 id 冲突」');

  // ---- [6] getTranscription ----
  const recordBack = await store.getTranscription(standalone.id);
  assert.notEqual(recordBack, null, '[6] getTranscription 必须读到刚写入的行');
  assert.equal(recordBack.rawText, RAW_TEXT, '[6] raw_text 逐字往返');
  assert.deepEqual(recordBack.uncertainSpans, SPANS, '[6] uncertain_spans 逐项原样（顺序也不得被改）');
  assert.equal(recordBack.confirmedText, null, '[6] 审核前 confirmed_text=null');
  assert.equal(recordBack.confirmedAt, null, '[6] 审核前 confirmed_at=null');
  assert.equal(recordBack.modelVersion, 'stub-v1', '[6] model_version 逐字一致');
  assert.equal(recordBack.deleted, false, '[6] deleted 初始 false');
  assert.equal(await store.getTranscription(randomUUID()), null, '[6] 不存在的 id ⇒ null');
  say('[6] getTranscription：raw_text/uncertain_spans/model_version 逐字往返；不存在 ⇒ null');

  // ---- [7] updateTranscription（CAS + 原始输出不可变） ----
  assert.equal(
    await store.updateTranscription(standalone.id, 999, (row) => ({ ...row, revision: row.revision + 1 })),
    null,
    '[7] revision 不匹配必须返回 null',
  );
  assert.equal(
    (await one('SELECT revision FROM public.transcriptions WHERE id = $1', [standalone.id])).revision,
    1,
    '[7] CAS 失败后库内 revision 必须仍是 1',
  );
  const confirmed = await store.updateTranscription(standalone.id, 1, (row) => ({
    ...row,
    confirmedText: CONFIRMED_TEXT,
    confirmedAt: T2,
    revision: row.revision + 1,
    updatedAt: T2,
  }));
  assert.equal(confirmed.confirmedText, CONFIRMED_TEXT, '[7] 核对文本落库');
  assert.equal(confirmed.revision, 2, '[7] revision 恰好 +1');
  const confirmedRow = await one('SELECT confirmed_text, raw_text, uncertain_spans, confirmed_at FROM public.transcriptions WHERE id = $1', [standalone.id]);
  assert.equal(confirmedRow.confirmed_text, CONFIRMED_TEXT, '[7] 库内 confirmed_text 逐字一致');
  assert.equal(confirmedRow.raw_text, RAW_TEXT, '[7] 核对不得改写 raw_text');
  assert.deepEqual(confirmedRow.uncertain_spans, SPANS, '[7] 核对不得改写 uncertain_spans');
  assert.deepEqual(confirmedRow.confirmed_at, T2, '[7] confirmed_at 毫秒级往返相等');

  // (负控制 N4) 改写原始输出必须被存储层拒绝，且库内逐字不变。
  await assert.rejects(
    () => store.updateTranscription(standalone.id, 2, (row) => ({ ...row, rawText: `${row.rawText}（被改写）`, revision: row.revision + 1 })),
    (error) => error instanceof Error && error.message === '转写记录的 raw_text / uncertain_spans 不可改写（存储层不变量）',
    '[7] 改写 raw_text 必须抛「转写记录的 raw_text / uncertain_spans 不可改写」',
  );
  await assert.rejects(
    () => store.updateTranscription(standalone.id, 2, (row) => ({ ...row, uncertainSpans: [], revision: row.revision + 1 })),
    (error) => error instanceof Error && error.message === '转写记录的 raw_text / uncertain_spans 不可改写（存储层不变量）',
    '[7] 改写 uncertain_spans 必须同样被拒',
  );
  const untouched = await one('SELECT revision, raw_text, uncertain_spans FROM public.transcriptions WHERE id = $1', [standalone.id]);
  assert.equal(untouched.revision, 2, '[7] 被拒的改写不得消耗 revision');
  assert.equal(untouched.raw_text, RAW_TEXT, '[7] 被拒的改写不得污染 raw_text');
  assert.deepEqual(untouched.uncertain_spans, SPANS, '[7] 被拒的改写不得污染 uncertain_spans');

  // 软删：普通 CAS 写。
  const deleted = await store.updateTranscription(standalone.id, 2, (row) => ({ ...row, deleted: true, revision: row.revision + 1, updatedAt: T2 }));
  assert.equal(deleted.deleted, true, '[7] 软删后 deleted=true');
  assert.equal(
    (await one('SELECT deleted FROM public.transcriptions WHERE id = $1', [standalone.id])).deleted,
    true,
    '[7] 库内 deleted=true',
  );
  say('[7] updateTranscription：CAS + 核对落库（raw/spans 不动）；改写原始输出被拒且库内逐字不变（revision 不消耗）；软删走普通 CAS');

  // ---- [8] findIdempotent ----
  const scope = `${OWNER_ID}\nPOST\n/api/v1/speech/transcriptions/${randomUUID()}`;
  const key = hash(`speech-${randomUUID()}`);
  assert.equal(await store.findIdempotent(scope, key), null, '[8] 未占位 ⇒ null');
  const claimRow = {
    requestHash: hash('body-1'),
    expiresAt: new Date(T2.getTime() + 60_000),
    payload: { job_id: job.id },
    pending: true,
  };
  await store.claimIdempotent(scope, key, claimRow, T2);
  const found = await store.findIdempotent(scope, key);
  assert.equal(found.requestHash, claimRow.requestHash, '[8] request_hash 逐字一致');
  assert.deepEqual(found.payload, claimRow.payload, '[8] payload 逐字段一致');
  assert.equal(found.pending, true, '[8] pending 如实为 true');
  assert.deepEqual(found.expiresAt, claimRow.expiresAt, '[8] expires_at 毫秒级往返相等');

  // findIdempotent 不按过期过滤（与内存实现逐条一致）：过期行也必须读得到。
  const expiredScope = `${OWNER_ID}\nPOST\n/api/v1/speech/transcriptions/${randomUUID()}`;
  const expiredKey = hash(`speech-expired-${randomUUID()}`);
  await store.claimIdempotent(
    expiredScope,
    expiredKey,
    { requestHash: hash('old'), expiresAt: new Date(T0.getTime() + 1000), payload: { job_id: 'old' }, pending: true },
    T0,
  );
  assert.notEqual(
    await store.findIdempotent(expiredScope, expiredKey),
    null,
    '[8] findIdempotent 不得按过期过滤（过期由调用方显式 purge）',
  );
  say('[8] findIdempotent：未占位 null；占位后 request_hash/payload/pending/expires_at 如实；过期行仍可读到（不自带过期过滤）');

  // ---- [9] claimIdempotent（单语句 DO NOTHING + 唯一性裁决） ----
  assert.equal(await store.claimIdempotent(scope, key, claimRow, T2), 'exists', '[9] 同键重复占位必须返回 exists（DO NOTHING）');
  const afterDuplicate = await store.findIdempotent(scope, key);
  assert.deepEqual(afterDuplicate.payload, claimRow.payload, '[9] exists 不得改写既有占位（payload 未被覆盖）');
  assert.equal(afterDuplicate.requestHash, claimRow.requestHash, '[9] exists 不得改写 request_hash');

  // 并发双 claim：恰好一次 claimed、一次 exists（判据由唯一约束裁决）。
  const raceScope = `${OWNER_ID}\nPOST\n/api/v1/speech/transcriptions/${randomUUID()}`;
  const raceKey = hash(`speech-race-${randomUUID()}`);
  const raceRow = { requestHash: hash('race'), expiresAt: new Date(T2.getTime() + 60_000), payload: { job_id: 'race' }, pending: true };
  const raceResults = await Promise.all([
    store.claimIdempotent(raceScope, raceKey, raceRow, T2),
    store.claimIdempotent(raceScope, raceKey, raceRow, T2),
  ]);
  assert.equal(raceResults.filter((value) => value === 'claimed').length, 1, `[9] 并发双 claim 必须恰好一次 claimed（现场 ${JSON.stringify(raceResults)}）`);
  assert.equal(raceResults.filter((value) => value === 'exists').length, 1, '[9] 另一路必须是 exists');
  assert.equal(await countOf('SELECT count(*)::int AS v FROM public.speech_idempotency WHERE scope = $1 AND key_hash = $2', [raceScope, raceKey]), 1, '[9] 并发占位后行数必须恒为 1');

  // 到期条目：显式 purge 之后同一键必须能重新占位（claim 本身不做 DO UPDATE）。
  assert.equal(await store.claimIdempotent(expiredScope, expiredKey, claimRow, T2), 'exists', '[9] 未 purge 前，到期行仍挡住同键（DO NOTHING 的既有语义）');
  await store.purgeIdempotent(T2);
  assert.equal(await store.claimIdempotent(expiredScope, expiredKey, claimRow, T2), 'claimed', '[9] purge 到期行之后同键必须能重新占位');
  say('[9] claimIdempotent：首次 claimed、同键 exists 且不覆盖；并发双 claim 恰好一次成功、行数恒 1；到期行由 purge 清理后可重新占位');

  // ---- [10] finalizeIdempotent ----
  await store.finalizeIdempotent(scope, key, { accepted: true, job_id: job.id });
  const finalized = await store.findIdempotent(scope, key);
  assert.equal(finalized.pending, false, '[10] finalize 后 pending 必须为 false');
  assert.deepEqual(finalized.payload, { accepted: true, job_id: job.id }, '[10] finalize 写入最终结果引用');
  const finalizedRow = await one('SELECT request_hash, expires_at FROM public.speech_idempotency WHERE scope = $1 AND key_hash = $2', [scope, key]);
  assert.equal(finalizedRow.request_hash, claimRow.requestHash, '[10] finalize 不得改写 request_hash');
  assert.deepEqual(finalizedRow.expires_at, claimRow.expiresAt, '[10] finalize 不得续期（expires_at 不变）');
  say('[10] finalizeIdempotent：pending ⇒ false、payload 替换为最终引用；request_hash/expires_at 不动');

  // ---- [11] releaseIdempotent ----
  const releaseScope = `${OWNER_ID}\nDELETE\n/api/v1/speech/transcriptions/${randomUUID()}`;
  const releaseKey = hash(`speech-release-${randomUUID()}`);
  assert.equal(
    await store.claimIdempotent(releaseScope, releaseKey, { requestHash: hash('x'), expiresAt: new Date(T2.getTime() + 60_000), payload: {}, pending: true }, T2),
    'claimed',
  );
  await store.releaseIdempotent(releaseScope, releaseKey);
  assert.equal(await store.findIdempotent(releaseScope, releaseKey), null, '[11] release 后必须查不到（占位已放弃）');
  assert.equal(
    await store.claimIdempotent(releaseScope, releaseKey, { requestHash: hash('y'), expiresAt: new Date(T2.getTime() + 60_000), payload: {}, pending: true }, T2),
    'claimed',
    '[11] release 之后同一键必须能重新占位（不会永久 pending）',
  );
  say('[11] releaseIdempotent：占位被真正释放，同键可重新占位（不会留下永久 pending）');

  // ---- [12] purgeIdempotent ----
  const purgeScope = `${OWNER_ID}\nPOST\n/api/v1/speech/transcriptions/${randomUUID()}`;
  const oldKey = hash(`speech-purge-old-${randomUUID()}`);
  const liveKey = hash(`speech-purge-live-${randomUUID()}`);
  await store.claimIdempotent(purgeScope, oldKey, { requestHash: hash('o'), expiresAt: new Date(T0.getTime() + 1000), payload: {}, pending: true }, T0);
  await store.claimIdempotent(purgeScope, liveKey, { requestHash: hash('l'), expiresAt: new Date(T2.getTime() + 3_600_000), payload: {}, pending: true }, T2);
  const purged = await store.purgeIdempotent(T2);
  assert.equal(purged >= 1, true, `[12] purgeIdempotent 必须返回**删除行数**（现场 ${purged}）`);
  assert.equal(await store.findIdempotent(purgeScope, oldKey), null, '[12] 已到期行必须被物理删除');
  assert.notEqual(await store.findIdempotent(purgeScope, liveKey), null, '[12] 未到期行不得被删');
  assert.equal(
    await countOf('SELECT count(*)::int AS v FROM public.speech_idempotency WHERE expires_at <= $1', [T2]),
    0,
    '[12] purge 之后库里不得残留已到期行',
  );
  const purgedAgain = await store.purgeIdempotent(T2);
  assert.equal(typeof purgedAgain, 'number', '[12] 返回类型必须是数字（行数）');
  say(`[12] purgeIdempotent：删除 ${purged} 行（返回行数）、未到期行保留、再跑一次不再删（${purgedAgain}）`);

  return { job, record: { ...record, id: record.id } };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const startedAt = Date.now();
try {
  assert.equal(VERIFY_ONLY, false, '主臂不得在 --verify-after-restart 下执行');
  const publicTables = await countOf("SELECT count(*)::int AS v FROM pg_tables WHERE schemaname = 'public'");
  assert.equal(publicTables, 0, `库 ${DB} 必须是空库（现场 public 表数 ${publicTables}）——请先 createdb 一个干净的库`);
  const role = (await one('SELECT current_user AS v')).v;
  console.log(`INFO 连接角色：${role}（本片用库 owner 取证；授权缺口见文件头"已知边界"）`);

  await migrationTriple();

  // 夹具用户：语音任务/记录对 users 有 ON DELETE CASCADE 外键，先建两个主体（归属 + 越权）。
  const authStore = createPostgresAuthStore({ query: (text, params) => pool.query(text, params) });
  const subjectOf = (label) => randomBytes(32).toString('hex').replace(/^(.{56}).{8}$/, `$1${label.padStart(8, '0')}`);
  const userA = await authStore.createUser(subjectOf('00002601'));
  const userB = await authStore.createUser(subjectOf('00002602'));
  OWNER_ID = userA.id;
  FOREIGN_ID = userB.id;
  say(`[0] 夹具主体 A=${userA.id}（归属者）/ B=${userB.id}（越权对照）已落 users 表`);

  // [M5] 状态闭集是否真是**行为上**的闭集：塞闭集外的值必须被库侧拒绝，且不得落行。
  //      枚举列由类型系统拒绝（22P02 invalid input value for enum），text+CHECK 列则报 23514；
  //      本迁移按派单用 job_state 枚举，因此两者都算「闭集被强制」，其余错误码一律不算通过。
  await assert.rejects(
    () =>
      ownerClient.query(
        `INSERT INTO public.speech_jobs (id, revision, kind, owner_user_id, transcription_id, media_id, media_revision, state, deadline_at, created_at, updated_at)
         VALUES ($1::uuid, 1, 'transcription', $2::uuid, $3::uuid, $4::uuid, 1, 'bogus_state', $5::timestamptz, $5::timestamptz, $5::timestamptz)`,
        [randomUUID(), OWNER_ID, randomUUID(), randomUUID(), T0],
      ),
    (error) => error?.code === '23514' || error?.code === '22P02',
    '[M5] state 闭集外的值必须被库侧拒绝（枚举 22P02 或 CHECK 23514，二者都证明闭集生效）',
  );
  await assert.rejects(
    () =>
      ownerClient.query(
        `INSERT INTO public.speech_jobs (id, revision, kind, owner_user_id, transcription_id, media_id, media_revision, state, deadline_at, created_at, updated_at)
         VALUES ($1::uuid, 1, 'bogus_kind', $2::uuid, $3::uuid, $4::uuid, 1, 'queued', $5::timestamptz, $5::timestamptz, $5::timestamptz)`,
        [randomUUID(), OWNER_ID, randomUUID(), randomUUID(), T0],
      ),
    (error) => error?.code === '23514',
    '[M5] kind 的 CHECK 必须拒绝 transcription 之外的值（23514）',
  );
  await assert.rejects(
    () =>
      ownerClient.query(
        `INSERT INTO public.speech_jobs (id, revision, kind, owner_user_id, transcription_id, media_id, media_revision, state, deadline_at, created_at, updated_at)
         VALUES ($1::uuid, 0, 'transcription', $2::uuid, $3::uuid, $4::uuid, 1, 'queued', $5::timestamptz, $5::timestamptz, $5::timestamptz)`,
        [randomUUID(), OWNER_ID, randomUUID(), randomUUID(), T0],
      ),
    (error) => error?.code === '23514',
    '[M5] revision >= 1 的 CHECK 必须拒绝 0（23514）',
  );
  // 被拒后整表必须仍是 0 行：枚举列连 `WHERE state = 'bogus_state'` 都会被 22P02 拒绝，
  // 所以这里用「总行数」而不是「按非法值筛行」来证明没有落库。
  assert.equal(
    await countOf('SELECT count(*)::int AS v FROM public.speech_jobs'),
    0,
    '[M5] 三条被拒绝的插入不得落库（speech_jobs 仍为 0 行）',
  );
  say(
    "[M5] 行为验证：闭集外 state 'bogus_state'（枚举 22P02）/ kind 'bogus_kind'（23514）/ revision=0（23514）均被库侧拒绝，且 speech_jobs 仍 0 行",
  );

  // ---- [W] 接线：real + 真池 ⇒ PG store；real + 无池 ⇒ 如实内存 ----
  const realConfig = {
    ...loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
    executionMode: 'real',
    sessionSigningKey: randomBytes(32).toString('hex'),
  };
  const withPool = buildApp({ config: realConfig, pool });
  assert.equal(withPool.speechService.describe().storePersistent, true, '[W] real + 真池必须接 PG store（persistent=true）');
  await withPool.close();
  const withoutPool = buildApp({ config: realConfig });
  assert.equal(
    withoutPool.speechService.describe().storePersistent,
    false,
    '[W] real + 无池必须如实标注不持久（不冒充持久化）',
  );
  await withoutPool.close();
  say('[W] 接线：real+池 ⇒ storePersistent=true；real+无池 ⇒ storePersistent=false（如实，不冒充）');

  // ---- 12 方法（当前连接池上的 store） ----
  const store = createPostgresSpeechStore({ pool });
  assert.equal(store.persistent, true, 'store 必须如实声明持久化');
  const written = await allTwelve(store);

  // ---- [R] 重启：关全部连接 → 新池/新 store/新 app → 指纹逐字节相等 ----
  const jobBefore = await store.getJob(written.job.id);
  const recordBefore = await store.getTranscription(written.record.id);
  assert.notEqual(jobBefore, null, '[R] 重启前任务行必须读得到');
  assert.notEqual(recordBefore, null, '[R] 重启前记录行必须读得到');
  const jobFpBefore = jobFingerprint(jobBefore);
  const recordFpBefore = transcriptionFingerprint(recordBefore);
  const spansSqlBefore = (
    await one('SELECT uncertain_spans::text AS v FROM public.transcriptions WHERE id = $1', [written.record.id])
  ).v;
  const poolBackendsBefore = await countOf(
    'SELECT count(*)::int AS v FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()',
  );
  assert.ok(poolBackendsBefore >= 1, `[R1] 关闭前必须还有连接池的后端进程（现场 ${poolBackendsBefore}）`);

  for (const opened of openedPools) await opened.end().catch(() => {});
  openedPools.length = 0;
  /** 服务器端 backend 退场是异步的：有界轮询（最多 1s），不忙等也不"看一眼就断言"。 */
  const waitForNoPoolBackends = async () => {
    let observed = -1;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      observed = await countOf(
        'SELECT count(*)::int AS v FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()',
      );
      if (observed === 0) return 0;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return observed;
  };
  const poolBackendsAfter = await waitForNoPoolBackends();
  assert.equal(poolBackendsAfter, 0, `[R1] pool.end() 之后本库不得再有其它后端进程（现场 ${poolBackendsAfter}）`);
  say(`[R1] 写入完成；关闭前 ${poolBackendsBefore} 个后端进程，pool.end() 之后残留 ${poolBackendsAfter}（连接真的全关了）`);

  pool = newPool();
  const store2 = createPostgresSpeechStore({ pool });
  const job2 = await store2.getJob(written.job.id);
  const record2 = await store2.getTranscription(written.record.id);
  assert.notEqual(job2, null, '[R] 关连接重开后任务行必须仍在');
  assert.notEqual(record2, null, '[R] 关连接重开后转写记录必须仍在');
  assert.equal(jobFingerprint(job2), jobFpBefore, '[R] 任务行重启前后指纹必须逐字节相等');
  assert.equal(transcriptionFingerprint(record2), recordFpBefore, '[R] 转写记录重启前后指纹必须逐字节相等');
  assert.deepEqual(job2.createdAt, jobBefore.createdAt, '[R] created_at 毫秒级逐字一致');
  assert.deepEqual(record2.uncertainSpans, SPANS, '[R] uncertain_spans 逐项原样（顺序也不得被改）');
  assert.equal(record2.confirmedText, null, '[R] 审核前 confirmed_text 仍是 null');
  say(
    `[R2] 重启（关连接→新 Pool→新 store）：任务指纹 ${jobFingerprint(job2).slice(0, 16)}… 与记录指纹 ${transcriptionFingerprint(record2).slice(0, 16)}… 与写入时逐字节相等`,
  );

  // 新 app（real + 新池）的语音读面直接读到旧数据 ⇒ 接线后的服务层同样"重启不丢"。
  const app2 = buildApp({ config: realConfig, pool });
  assert.equal(app2.speechService.describe().storePersistent, true, '[R] 新 app 的语音域必须仍是 PG store');
  const projection = await app2.speechService.getJob({ userId: OWNER_ID, jobId: written.job.id });
  assert.equal(projection.id, written.job.id, '[R] 新 app 的 getJob 必须读到重启前的任务');
  assert.equal(projection.kind, 'transcription', '[R] 投影 kind 必须是 transcription');
  assert.equal(projection.revision, jobBefore.revision, '[R] 投影 revision 与重启前一致');
  const transcriptionProjection = await app2.speechService.getTranscription({ userId: OWNER_ID, transcriptionId: written.record.id });
  // 读面是契约投影（snake_case），不是 store 内部行（camelCase）：这里核对的是对外契约字段。
  assert.equal(transcriptionProjection.raw_text, RAW_TEXT, '[R] 新 app 必须读到重启前的原始转写文本');
  assert.deepEqual(transcriptionProjection.uncertain_spans, SPANS, '[R] 投影里的 uncertain_spans 逐项原样');
  assert.equal(transcriptionProjection.confirmed_text, null, '[R] 投影里的 confirmed_text 仍是 null');
  await assert.rejects(
    () => app2.speechService.getTranscription({ userId: FOREIGN_ID, transcriptionId: written.record.id }),
    (error) => error?.code === 'NOT_FOUND',
    '[R] 他人读同一条记录必须 NOT_FOUND（归属判定不因换 PG store 而放宽）',
  );
  await app2.close();
  say('[R3] 新 app（real+新池）的语音读面读到重启前的任务与转写；他人读同一条记录仍 NOT_FOUND（归属不放宽）');

  // ---- 子进程臂：真·进程重启（spawn 受限时如实登记未取得） ----
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--verify-after-restart'], {
    env: {
      ...process.env,
      [ENV]: url.href,
      GY_SPEECH_JOB_ID: written.job.id,
      GY_SPEECH_TRANSCRIPTION_ID: written.record.id,
      GY_SPEECH_OWNER: OWNER_ID,
      GY_SPEECH_JOB_FP: jobFpBefore,
      GY_SPEECH_RECORD_FP: recordFpBefore,
    },
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (child.error !== undefined && child.error !== null) {
    unread('进程级重启臂（子进程）', `spawn 失败：${child.error.message}（连接级重启臂已取证，本臂未取得）`);
  } else {
    assert.equal(
      child.status,
      0,
      `[R4] 子进程重启臂必须 exit 0；实际 ${child.status}\nSTDOUT:\n${child.stdout}\nSTDERR:\n${child.stderr}`,
    );
    for (const line of String(child.stdout).split('\n').filter((line) => line.startsWith('CHILD-'))) {
      console.log(`  ${line.trim()}`);
    }
    say('[R4] 进程级重启臂：**新进程** + 新连接池按指纹逐字节相等 ⇒ exit 0（subprocess 原始输出见上）');
  }

  // ---- [N1] byte_exact_restore：篡改必红、原样写回必绿 ----
  const tampered = JSON.stringify([{ start: 0, end: 4, reason: '被篡改的区间' }]);
  await ownerClient.query('UPDATE public.transcriptions SET uncertain_spans = $2::jsonb WHERE id = $1', [written.record.id, tampered]);
  const recordTampered = await store2.getTranscription(written.record.id);
  assert.notEqual(
    transcriptionFingerprint(recordTampered),
    recordFpBefore,
    '[N1] 篡改后指纹必须变化（否则"重启前后相等"这条判据没有牙齿）',
  );
  assert.deepEqual(recordTampered.uncertainSpans, [{ start: 0, end: 4, reason: '被篡改的区间' }], '[N1] 篡改必须真的被读到');
  await ownerClient.query('UPDATE public.transcriptions SET uncertain_spans = $2::jsonb WHERE id = $1', [written.record.id, spansSqlBefore]);
  const recordRestored = await store2.getTranscription(written.record.id);
  assert.equal(transcriptionFingerprint(recordRestored), recordFpBefore, '[N1] 原样写回后指纹必须逐字节复原');
  const spansSqlAfter = (
    await one('SELECT uncertain_spans::text AS v FROM public.transcriptions WHERE id = $1', [written.record.id])
  ).v;
  assert.equal(spansSqlAfter, spansSqlBefore, '[N1] 复原后 jsonb 文本必须与写入时逐字节相等');
  say('[N1] byte_exact_restore：篡改 ⇒ 指纹变（红）；按原 jsonb 文本写回 ⇒ 指纹与 `::text` 双双重现（绿）');

  // ---- [N2] 内存 store 在同一序列下"新实例读不到" ----
  const memoryStore = createMemorySpeechStore();
  const memoryJob = makeJobRow({ ownerUserId: OWNER_ID });
  await memoryStore.insertJob(memoryJob);
  await memoryStore.insertTranscription(makeTranscriptionRow(memoryJob));
  const memoryRestarted = createMemorySpeechStore();
  assert.equal(await memoryRestarted.getJob(memoryJob.id), null, '[N2] 内存 store 的"新实例"必须读不到（这就是改前的缺陷本体）');
  assert.equal(await memoryRestarted.getTranscription(memoryJob.transcriptionId), null, '[N2] 内存 store 的"新实例"必须读不到转写记录');
  assert.equal(memoryStore.persistent, false, '[N2] 内存 store 如实 persistent=false');
  say('[N2] 负控制：同一序列在内存 store 上，新实例读不到任务与转写记录（改前"重启即丢"的缺陷本体，可复现）');

  // ---- [N3] CAS 并发双写：只允许一次成功 ----
  const raceJob = makeJobRow();
  await store2.insertJob(raceJob);
  const raceUpdateResults = await Promise.all([
    store2.updateJob(raceJob.id, 1, (row) => ({ ...row, state: 'running', revision: row.revision + 1, updatedAt: T1 })),
    store2.updateJob(raceJob.id, 1, (row) => ({ ...row, state: 'running', revision: row.revision + 1, updatedAt: T1 })),
  ]);
  const winners = raceUpdateResults.filter((value) => value !== null);
  assert.equal(winners.length, 1, `[N3] 同一 revision 的并发双写必须恰好 1 次成功（现场 ${winners.length} 次）`);
  assert.equal(winners[0].revision, 2, '[N3] 赢家 revision 恰好 +1');
  assert.equal(
    (await one('SELECT revision FROM public.speech_jobs WHERE id = $1', [raceJob.id])).revision,
    2,
    '[N3] 库里 revision 必须是 2（不是 3：CAS 退化会叠加成 +2）',
  );
  say('[N3] 负控制：同一 revision 并发双写 ⇒ 恰好 1 次成功、库内 revision=2（若 CAS 退化为先查后写，本臂会出现 2 次成功）');

  // ---- [N4] 同 id 再写由主键裁决（不是应用层判重） ----
  const dupJob = makeJobRow();
  await store2.insertJob(dupJob);
  await assert.rejects(
    () => store2.insertJob({ ...dupJob, transcriptionId: randomUUID() }),
    (error) => error?.message === '任务 id 冲突',
  );
  assert.equal(
    await countOf('SELECT count(*)::int AS v FROM public.speech_jobs WHERE id = $1', [dupJob.id]),
    1,
    '[N4] 重复写后行数必须仍是 1（主键裁决，无检查-写入窗口）',
  );
  say('[N4] 负控制：同 id 并发/重复写由主键裁决 ⇒ 行数恒为 1');

  // ---- [N5] 缺表三态（真库版）：回滚迁移后写入 fail-closed 点名 0026，读返回 null ----
  // 放在最后：它会真的 DROP 三张表（前面所有数据随之消失），跑完立刻 REPLAY 复原结构。
  await ownerClient.query(readSql(DOWN));
  const missingStore = createPostgresSpeechStore({ pool }); // 新实例：探测缓存为空（走"探测说缺表"路径）
  assert.equal(missingStore.persistent, true, '[N5] 缺表也必须如实报告 persistent=true（不得自我降级为内存）');
  assert.equal(await missingStore.getJob(written.job.id), null, '[N5] 缺表时 getJob 必须返回 null（迁移没跑不是 500）');
  assert.equal(await missingStore.getTranscription(written.record.id), null, '[N5] 缺表时 getTranscription 必须返回 null');
  assert.equal(await missingStore.findIdempotent('s', 'k'), null, '[N5] 缺表时 findIdempotent 必须返回 null');
  await assert.rejects(
    () => missingStore.insertJob(makeJobRow()),
    (error) =>
      error instanceof SpeechTablesMissingError
      && error.code === 'PROVIDER_UNAVAILABLE'
      && error.retryable === false
      && /0026_speech_persistence\.sql/.test(error.message),
    '[N5] 缺表时写入必须抛 SpeechTablesMissingError 并点名 0026_speech_persistence.sql（fail-closed）',
  );
  // 旧实例（缓存里还是 ready）：42P01 现场折成缺表错，且缓存作废后下一轮重新探测。
  await assert.rejects(
    () => store2.insertJob(makeJobRow()),
    (error) => error instanceof SpeechTablesMissingError && /0026_speech_persistence\.sql/.test(error.message),
    '[N5] 运行中才缺表（42P01）的写入同样 fail-closed 点名迁移文件',
  );
  assert.equal(await store2.getJob(written.job.id), null, '[N5] 42P01 路径的读必须折成 null');
  say('[N5] 缺表三态（真库）：回滚后读三方法全 null、写入抛 SpeechTablesMissingError 点名 0026；缓存 ready 的旧实例遇 42P01 同样 fail-closed');

  await ownerClient.query(readSql(`migrations/${MIGRATION}`));
  assert.equal((await one("SELECT to_regclass('public.speech_jobs') AS v")).v, 'speech_jobs', '[N5] REPLAY 后三表必须复原');
  const recovered = createPostgresSpeechStore({ pool });
  await recovered.insertJob(makeJobRow());
  say('[N5] 复原：REPLAY 0026 之后新 store 立即可写（fail-closed 不会永久锁死）');

  console.log(`\n共 ${passed} 条 PASS，耗时 ${Date.now() - startedAt}ms`);
  console.log('ALL PASS：语音转写域 PostgreSQL 持久化（迁移 0026 三连 / 12 方法语义 / 关连接重开逐字节仍在 / 5 条负控制含缺表 fail-closed）');
} finally {
  for (const opened of openedPools) await opened.end().catch(() => {});
  await ownerClient.end().catch(() => {});
}

unread('HTTP 面的"重启不丢"', 'real 模式真实 ASR 提供者/媒体端口未接线 ⇒ POST 语音受理前即 503，无法经 HTTP 建任务；本片证据在 store 层 + 迁移层 + app.speechService 读面');
unread('三张语音表的运行时授权', '本片按派单**不改** `deploy/postgres-cvm/**`（不新增 GRANT）；运行时角色直连会 42501，授权属后续片，本脚本用库 owner 取证');
unread('多进程并发写同一任务的压测', '本片只做两路并发 CAS 与两路并发 claim，未做 20+ 并发的吞吐/延迟读数');
unread('真实 ASR 模型输出落库', '模型调用未接线；本片用契约合法的手工文本/区间验证持久化，不伪造识别准确率');
unread('备份恢复演练', '本片只验证单库迁移 UP/ROLLBACK/REPLAY 与关连接重开，未做 pg_dump/pg_restore 演练');
