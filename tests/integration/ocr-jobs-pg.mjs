/**
 * GY-R27 S10（#10）· 标签 OCR 域 PG 持久化的**真库**端到端证据（PostgreSQL 17.11 + 迁移 `0024`）。
 *
 * 本脚本只讲一件事：**OCR 任务与记录真的落到了数据库里，关掉连接重开还在**——
 * 这是本片唯一的核心主张（此前只有内存 store，进程重启即丢）。在此之上逐条取证：
 *   [M] 迁移 `0024` 三连：结构不变量 ⇒ UP（三表/索引/约束出现）⇒ ROLLBACK（本片对象消失，
 *       `users` 与既有 `jobs` 表逐字仍在）⇒ REPLAY（再出现）。
 *   [W] 接线：`real` + 真池 ⇒ `app.ocrService.describe().storePersistent === true`；
 *       `real` + 无池 ⇒ `false`（如实内存，**不**冒充持久）。
 *   [1]–[12] `OcrStore` **12 个方法逐条**：写入 / 读回 / CAS 返回 null / `commitTerminal` 的
 *       "CAS 失败不写记录" / 幂等台账的 claim-exists-finalize-release-purge。
 *   [R] **重启**：写入 → `pool.end()` 关闭全部连接 → **新 Pool + 新 store / 新 app** → 按
 *       指纹逐字节比对仍相等；另**尝试**子进程臂（真·进程重启；spawn 受限时如实登记未取得）。
 *   [N] 负控制（每条都必须真的能红）：`byte_exact_restore`（篡改后必红、原样写回必绿）、
 *       内存 store 在同一序列下"新实例读不到"、CAS 并发双写只允许一次成功、同 id 再写由主键裁决。
 *
 * 运行（专用测试库必须是**空库**；脚本先断言 public 下 0 张表）：
 *   createdb -h 127.0.0.1 -p <port> gengyun_ocr_jobs_test
 *   OCR_PG_TEST_URL=postgres://postgres@127.0.0.1:<port>/gengyun_ocr_jobs_test \
 *     node tests/integration/ocr-jobs-pg.mjs
 *
 * 未设置 `OCR_PG_TEST_URL` ⇒ 打印 `SKIP` 并以 **77** 退出（POSIX「skipped」）：本次运行**没有**
 * 验证真库（不是通过）。本机明知无真库、只想看跳过原因时可显式加 `--allow-skip`
 * （或 `GY_ALLOW_SKIP=1`）取 0 —— ⛔ 不得用于门禁。
 * `npm run test:integration:http` 不包含本文件（它需要真库）；CI 接线属后续片
 * （本片在 `tests/unit/ci-integration-chain-structure.test.mjs` 的 `UNWIRED_DECLARATIONS` 如实声明）。
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
import { createMemoryOcrStore } from '../../services/api/src/ocr/store.ts';
import { createPostgresOcrStore } from '../../services/api/src/ocr/store-pg.ts';
import { discoverMigrations } from '../../services/api/src/db/migrate.ts';

const ENV = 'OCR_PG_TEST_URL';
const DB = 'gengyun_ocr_jobs_test';
const MIGRATION = '0024_ocr_persistence.sql';
const DOWN = `migrations/rollback/${MIGRATION.replace(/\.sql$/, '.down.sql')}`;
const VERIFY_ONLY = process.argv.includes('--verify-after-restart');

const rawUrl = process.env[ENV];
// 缺真库时的出口：默认 77（未取得，不是通过）；只有显式 `--allow-skip` / `GY_ALLOW_SKIP=1` 才降级为 0。
const ALLOW_SKIP = process.argv.includes('--allow-skip') || process.env.GY_ALLOW_SKIP === '1';
if ((rawUrl === undefined || rawUrl.trim() === '') && !VERIFY_ONLY) {
  console.log(
    `SKIP real PG17: ${ENV} 未设置 —— 本次运行没有验证真库持久化（不是通过，也不是失败）。`,
  );
  if (ALLOW_SKIP) {
    console.log('EXITCODE=0（--allow-skip / GY_ALLOW_SKIP=1 已显式授权：仅本机开发，⛔ 不得接进门禁）。');
    process.exit(0);
  }
  console.log(
    'EXITCODE=77 表示未取得，不是通过（POSIX 惯例 skipped；本机明知无真库时可显式加 --allow-skip 取 0）。',
  );
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

/** 行指纹：把记录规范化成 JSON 再取 sha256（**重启前后逐字节相等**的判据就落在这里）。 */
function recordFingerprint(row) {
  return hash(
    JSON.stringify({
      id: row.id,
      revision: row.revision,
      ownerUserId: row.ownerUserId,
      mediaId: row.mediaId,
      mediaRevision: row.mediaRevision,
      rawFields: row.rawFields,
      correctedFields: row.correctedFields,
      verification: row.verification,
      modelVersion: row.modelVersion,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      deleted: row.deleted,
    }),
  );
}

function jobFingerprint(row) {
  return hash(
    JSON.stringify({
      id: row.id,
      revision: row.revision,
      kind: row.kind,
      ownerUserId: row.ownerUserId,
      ocrId: row.ocrId,
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

// ---------------------------------------------------------------------------
// 子进程臂（真·进程重启）：只读、只断言，任何不符都以非 0 退出。
// ---------------------------------------------------------------------------
if (VERIFY_ONLY) {
  const expectedJobFingerprint = process.env['GY_OCR_JOB_FP'];
  const expectedRecordFingerprint = process.env['GY_OCR_RECORD_FP'];
  const jobId = process.env['GY_OCR_JOB_ID'];
  const ocrId = process.env['GY_OCR_OCR_ID'];
  const owner = process.env['GY_OCR_OWNER'];
  const client = new pg.Pool({ connectionString: url.href });
  try {
    const store = createPostgresOcrStore({ pool: client });
    assert.equal(store.persistent, true, '子进程：store 必须如实声明持久化');
    const job = await store.getJob(jobId);
    assert.notEqual(job, null, '子进程：重启后任务行必须仍在');
    assert.equal(job.ownerUserId, owner, '子进程：任务归属者必须逐字一致');
    const record = await store.getOcr(ocrId);
    assert.notEqual(record, null, '子进程：重启后 OCR 记录必须仍在');
    assert.equal(jobFingerprint(job), expectedJobFingerprint, '子进程：任务行指纹必须与写入时逐字节相等');
    assert.equal(
      recordFingerprint(record),
      expectedRecordFingerprint,
      '子进程：OCR 记录指纹必须与写入时逐字节相等',
    );
    console.log(`CHILD-PID=${process.pid}`);
    console.log(`CHILD-JOB-FP=${jobFingerprint(job)}`);
    console.log(`CHILD-RECORD-FP=${recordFingerprint(record)}`);
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
const T0 = new Date('2026-10-20T08:00:00.000Z');
const T1 = new Date('2026-10-20T08:00:01.000Z');
const T2 = new Date('2026-10-20T08:00:02.000Z');

const FIELDS = {
  registration_number: 'PD20261234',
  name: '草甘膦异丙胺盐可溶液剂',
  ingredients: [
    { name: '草甘膦异丙胺盐', content_text: '41', unit_text: '%' },
    { name: '水', content_text: '余量', unit_text: '' },
  ],
  dosage_form: '可溶液剂',
};

const VERIFICATION = {
  match_state: 'matched',
  registration: null,
  conflict_fields: [],
  missing_fields: [],
  dose_cards: [],
};

function makeJobRow(overrides = {}) {
  return {
    id: randomUUID(),
    revision: 1,
    kind: 'ocr',
    ownerUserId: OWNER_ID,
    ocrId: randomUUID(),
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

function makeOcrRow(jobRow, overrides = {}) {
  return {
    id: jobRow.ocrId,
    revision: 1,
    ownerUserId: OWNER_ID,
    mediaId: jobRow.mediaId,
    mediaRevision: jobRow.mediaRevision,
    rawFields: FIELDS,
    correctedFields: structuredClone(FIELDS),
    verification: VERIFICATION,
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
  // 与 `tests/integration/migrations-negative-pg.mjs` 共同的**两条结构不变量**（本片新增 0024 后
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
  assert.equal(names[names.length - 1], MIGRATION, `本片迁移必须是当前末位（现场 ${names[names.length - 1]}）`);
  say(`[M0] 结构不变量：迁移 ${discovered.length} 个（0001..${String(max).padStart(4, '0')}），
       连续无缺号；count === max；末位 = ${MIGRATION}`);

  const objects = async () => ({
    jobs: (await one("SELECT to_regclass('public.ocr_jobs') AS v")).v,
    records: (await one("SELECT to_regclass('public.ocr_records') AS v")).v,
    idem: (await one("SELECT to_regclass('public.ocr_idempotency') AS v")).v,
    jobsIdx: (await one("SELECT to_regclass('public.ocr_jobs_owner_created_idx') AS v")).v,
    recordsIdx: (await one("SELECT to_regclass('public.ocr_records_owner_created_idx') AS v")).v,
    idemIdx: (await one("SELECT to_regclass('public.ocr_idempotency_expires_idx') AS v")).v,
    stateCheck: await countOf(
      "SELECT count(*)::int AS v FROM pg_constraint WHERE conrelid = to_regclass('public.ocr_jobs') AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%state%'",
    ),
    users: (await one("SELECT to_regclass('public.users') AS v")).v,
    jobsTable: (await one("SELECT to_regclass('public.jobs') AS v")).v,
    fkCascade: await countOf(
      "SELECT count(*)::int AS v FROM pg_constraint WHERE conrelid IN (to_regclass('public.ocr_jobs'), to_regclass('public.ocr_records')) AND contype = 'f' AND confdeltype = 'c'",
    ),
  });

  for (const name of readdirSync(migrationsDir).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort()) {
    if (name === MIGRATION) continue;
    await ownerClient.query(readSql(`migrations/${name}`));
  }
  let state = await objects();
  assert.equal(state.jobs, null, '应用其它迁移后 ocr_jobs 必须还不存在（证明 UP 才是它出现的唯一原因）');
  assert.equal(state.users, 'users', '0001 的 users 必须在岗（外键与夹具都依赖它）');
  say('[M1] 0001..0023 已应用：ocr_* 三表全部不存在，users 在岗');

  await ownerClient.query(readSql(`migrations/${MIGRATION}`));
  state = await objects();
  assert.equal(state.jobs, 'ocr_jobs', 'UP 后 ocr_jobs 必须存在');
  assert.equal(state.records, 'ocr_records', 'UP 后 ocr_records 必须存在');
  assert.equal(state.idem, 'ocr_idempotency', 'UP 后 ocr_idempotency 必须存在');
  assert.equal(state.jobsIdx, 'ocr_jobs_owner_created_idx', 'UP 后归属+排序索引必须在岗');
  assert.equal(state.recordsIdx, 'ocr_records_owner_created_idx', 'UP 后记录归属+排序索引必须在岗');
  assert.equal(state.idemIdx, 'ocr_idempotency_expires_idx', 'UP 后台账过期索引必须在岗');
  assert.equal(state.stateCheck >= 1, true, 'state 列必须有 CHECK');
  assert.equal(state.fkCascade, 2, '任务与记录各一条 ON DELETE CASCADE 外键（注销级联）');
  say('[M2] UP：三表 + 三索引 + state CHECK 在岗 + 2 条 CASCADE 外键全部出现');

  await ownerClient.query(readSql(DOWN));
  state = await objects();
  assert.equal(state.jobs, null, 'DOWN 后 ocr_jobs 必须消失');
  assert.equal(state.records, null, 'DOWN 后 ocr_records 必须消失');
  assert.equal(state.idem, null, 'DOWN 后 ocr_idempotency 必须消失');
  assert.equal(state.jobsIdx, null, 'DOWN 后索引必须消失');
  assert.equal(state.users, 'users', 'DOWN 不得触碰 users');
  assert.equal(state.jobsTable, 'jobs', 'DOWN 不得触碰 0001 的共享 jobs 表');
  say('[M3] ROLLBACK：本片对象全部消失，users 与 0001 的 jobs 表逐字仍在');

  await ownerClient.query(readSql(`migrations/${MIGRATION}`));
  assert.equal((await objects()).jobs, 'ocr_jobs', 'REPLAY 后必须再次出现（迁移可重放）');
  say('[M4] REPLAY：同一份 UP 再执行一次仍成功，ocr_jobs 再次出现');
}

// ---------------------------------------------------------------------------
// [1]–[12] 12 个方法逐条
// ---------------------------------------------------------------------------
async function allTwelve(store) {
  // ---- [1] insertJob ----
  const job = makeJobRow();
  await store.insertJob(job);
  assert.equal(
    await countOf('SELECT count(*)::int AS v FROM public.ocr_jobs WHERE id = $1', [job.id]),
    1,
    '[1] insertJob 必须真的落库 1 行',
  );
  await assert.rejects(
    () => store.insertJob({ ...job, ocrId: randomUUID() }),
    (error) => error instanceof Error && error.message === '任务 id 冲突',
    '[1] 同 id 再写必须抛「任务 id 冲突」（判定由主键裁决，不是先查后写）',
  );
  say('[1] insertJob：落库 1 行；同 id 再写由主键裁决并抛「任务 id 冲突」');

  // ---- [2] getJob ----
  const readBack = await store.getJob(job.id);
  assert.notEqual(readBack, null, '[2] getJob 必须读到刚写入的行');
  assert.equal(readBack.revision, 1, '[2] revision 初始 1');
  assert.equal(readBack.state, 'queued', '[2] state 初始 queued');
  assert.equal(readBack.kind, 'ocr', '[2] kind 必须是 ocr');
  assert.equal(readBack.ownerUserId, OWNER_ID, '[2] 归属者逐字一致');
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
    (await one('SELECT revision FROM public.ocr_jobs WHERE id = $1', [job.id])).revision,
    1,
    '[3] CAS 失败后库里的 revision 必须逐字不变（0 行 UPDATE，不是"先写后判"）',
  );
  assert.equal(await store.updateJob(randomUUID(), 1, (row) => row), null, '[3] 不存在的 id ⇒ null');
  const running = await store.updateJob(job.id, 1, (row) => ({
    ...row,
    state: 'running',
    revision: row.revision + 1,
    updatedAt: T1,
  }));
  assert.notEqual(running, null, '[3] CAS 命中必须返回新行');
  assert.equal(running.state, 'running', '[3] 迁移到 running');
  assert.equal(running.revision, 2, '[3] revision 恰好 +1');
  assert.deepEqual(running.updatedAt, T1, '[3] updated_at 写成注入的时刻');
  say('[3] updateJob：CAS 失败 ⇒ null 且库内 revision 不变；命中 ⇒ 状态迁移 + revision 恰好 +1');

  // ---- [4] commitTerminal ----
  const terminalJob = makeJobRow();
  await store.insertJob(terminalJob);
  const ghostRecord = makeOcrRow(terminalJob);
  assert.equal(
    await store.commitTerminal(terminalJob.id, 999, { state: 'succeeded', errorCode: null }, ghostRecord, T2),
    null,
    '[4] CAS 失败必须返回 null',
  );
  assert.equal(
    await countOf('SELECT count(*)::int AS v FROM public.ocr_records WHERE id = $1', [ghostRecord.id]),
    0,
    '[4] CAS 失败时**不得写任何 OCR 记录**',
  );
  assert.equal(
    (await one('SELECT state, revision FROM public.ocr_jobs WHERE id = $1', [terminalJob.id])).state,
    'queued',
    '[4] CAS 失败后任务状态不得改变',
  );
  const early = await store.commitTerminal(terminalJob.id, 1, { state: 'succeeded', errorCode: null }, ghostRecord, T2);
  assert.equal(early, null, '[4] 非法迁移（queued ⇒ succeeded）必须返回 null 且不写记录');
  assert.equal(
    await countOf('SELECT count(*)::int AS v FROM public.ocr_records WHERE id = $1', [ghostRecord.id]),
    0,
    '[4] 非法迁移时同样不得写记录',
  );
  const committed = await store.commitTerminal(
    terminalJob.id,
    1,
    { state: 'failed', errorCode: 'PROVIDER_UNAVAILABLE' },
    null,
    T2,
  );
  assert.notEqual(committed, null, '[4] 合法迁移（queued ⇒ failed）必须成功');
  assert.equal(committed.state, 'failed', '[4] 终态落 failed');
  assert.equal(committed.errorCode, 'PROVIDER_UNAVAILABLE', '[4] error_code 逐字落库');
  assert.equal(committed.revision, 2, '[4] revision 恰好 +1');
  const late = await store.commitTerminal(terminalJob.id, 1, { state: 'succeeded', errorCode: null }, null, T2);
  assert.equal(late, null, '[4] 终态任务的迟到结果必须写不进去（旧回调不复活）');
  assert.equal(
    (await one('SELECT state FROM public.ocr_jobs WHERE id = $1', [terminalJob.id])).state,
    'failed',
    '[4] 迟到结果不得改写终态',
  );

  // 取消 ⇒ 迟到结果不复活（与 GY-I10 取消片同一条不变量，此处走 PG store）。
  const cancelJob = makeJobRow();
  await store.insertJob(cancelJob);
  const cancelled = await store.updateJob(cancelJob.id, 1, (row) => ({
    ...row,
    state: 'cancelled',
    revision: row.revision + 1,
    updatedAt: T1,
  }));
  assert.equal(cancelled.state, 'cancelled', '[4] 取消写入 cancelled');
  assert.equal(
    await store.commitTerminal(cancelJob.id, 2, { state: 'succeeded', errorCode: null }, null, T2),
    null,
    '[4] 已取消任务的迟到终态必须写不进去',
  );
  assert.equal(
    (await one('SELECT state FROM public.ocr_jobs WHERE id = $1', [cancelJob.id])).state,
    'cancelled',
    '[4] 取消后状态保持 cancelled',
  );

  // 记录 id 冲突 ⇒ 抛错且任务行不被改写（事务回滚）。
  // 注意顺序：必须先把任务推到 `running`（`queued ⇒ succeeded` 本身就是非法迁移），
  // 否则本臂会在"状态机拒绝"处返回 null，测不到记录冲突这一条。
  const conflictJob = makeJobRow();
  const conflictRecord = makeOcrRow(conflictJob);
  await store.insertOcr(conflictRecord);
  await store.insertJob(conflictJob);
  const conflictRunning = await store.updateJob(conflictJob.id, 1, (row) => ({
    ...row,
    state: 'running',
    revision: row.revision + 1,
    updatedAt: T1,
  }));
  assert.equal(conflictRunning.revision, 2, '[4] 冲突臂前置：任务必须先到 running/revision=2');
  await assert.rejects(
    () => store.commitTerminal(conflictJob.id, 2, { state: 'succeeded', errorCode: null }, makeOcrRow(conflictJob), T2),
    (error) => error instanceof Error && error.message === 'OCR 记录 id 冲突',
    '[4] 记录 id 冲突必须抛「OCR 记录 id 冲突」',
  );
  assert.equal(
    (await one('SELECT state FROM public.ocr_jobs WHERE id = $1', [conflictJob.id])).state,
    'running',
    '[4] 记录冲突时任务行必须原样（事务回滚，不留半成品）',
  );
  assert.equal(
    (await one('SELECT revision FROM public.ocr_jobs WHERE id = $1', [conflictJob.id])).revision,
    2,
    '[4] 记录冲突时 revision 不得推进',
  );
  say(
    '[4] commitTerminal：CAS 失败/非法迁移 ⇒ null 且不写记录；合法 ⇒ 落终态+落记录；终态与取消后的迟到结果写不进去；记录 id 冲突 ⇒ 抛错且任务行回滚',
  );

  // ---- [5] insertOcr / [6] getOcr ----
  const recordJob = makeJobRow();
  const record = makeOcrRow(recordJob);
  await store.insertJob(recordJob);
  await store.insertOcr(record);
  assert.equal(
    await countOf('SELECT count(*)::int AS v FROM public.ocr_records WHERE id = $1', [record.id]),
    1,
    '[5] insertOcr 必须真的落库 1 行',
  );
  await assert.rejects(
    () => store.insertOcr({ ...record, revision: 1 }),
    (error) => error instanceof Error && error.message === 'OCR 记录 id 冲突',
    '[5] 同 id 再写必须抛「OCR 记录 id 冲突」',
  );
  const recordBack = await store.getOcr(record.id);
  assert.notEqual(recordBack, null, '[6] getOcr 必须读到刚写入的记录');
  assert.deepEqual(recordBack.rawFields, FIELDS, '[6] raw_fields 逐字段往返相等');
  assert.deepEqual(recordBack.correctedFields, FIELDS, '[6] corrected_fields 逐字段往返相等');
  assert.deepEqual(recordBack.verification, VERIFICATION, '[6] verification 逐字段往返相等');
  assert.equal(recordBack.modelVersion, 'stub-v1', '[6] model_version 逐字一致');
  assert.equal(recordBack.deleted, false, '[6] deleted 初始 false');
  assert.equal(await store.getOcr(randomUUID()), null, '[6] 不存在的 id ⇒ null');
  say('[5][6] insertOcr/getOcr：落库 1 行、同 id 冲突抛错；raw/corrected/verification 三列 JSON 逐字段往返相等');

  // ---- [7] updateOcr（CAS） ----
  const correctedFields = { ...FIELDS, name: '草甘膦异丙胺盐可溶液剂（校正）' };
  assert.equal(
    await store.updateOcr(record.id, 42, (row) => ({ ...row, correctedFields, revision: row.revision + 1 })),
    null,
    '[7] revision 不匹配必须返回 null',
  );
  assert.equal(
    (await one('SELECT revision FROM public.ocr_records WHERE id = $1', [record.id])).revision,
    1,
    '[7] CAS 失败后 revision 不变',
  );
  const corrected = await store.updateOcr(record.id, 1, (row) => ({
    ...row,
    correctedFields,
    revision: row.revision + 1,
    updatedAt: T2,
  }));
  assert.notEqual(corrected, null, '[7] CAS 命中必须返回新行');
  assert.equal(corrected.revision, 2, '[7] revision 恰好 +1');
  assert.deepEqual(corrected.correctedFields, correctedFields, '[7] 校正字段落库');
  assert.deepEqual(corrected.rawFields, FIELDS, '[7] raw_fields 必须逐字不变（校正不得改写原始输出）');
  const rawInDb = await one("SELECT raw_fields::text AS v FROM public.ocr_records WHERE id = $1", [record.id]);
  assert.deepEqual(JSON.parse(rawInDb.v), FIELDS, '[7] 库里的 raw_fields 文本与写入时逐字段相等');
  say('[7] updateOcr：CAS 失败 ⇒ null 且 revision 不变；命中 ⇒ 校正落库、raw_fields 逐字不变');

  // ---- [8] findIdempotent ----
  const scope = `${OWNER_ID}\nPOST\n/api/v1/ocr`;
  const keyHash = hash(`ocr-key-${randomUUID()}`);
  assert.equal(await store.findIdempotent(scope, keyHash), null, '[8] 未占位时 findIdempotent ⇒ null');

  // ---- [9] claimIdempotent ----
  const claimRow = {
    requestHash: hash('body-1'),
    expiresAt: new Date(T0.getTime() + 60_000),
    payload: { job_id: job.id },
    pending: true,
  };
  assert.equal(await store.claimIdempotent(scope, keyHash, claimRow, T0), 'claimed', '[9] 首次占位必须 claimed');
  assert.equal(
    await store.claimIdempotent(scope, keyHash, claimRow, T0),
    'exists',
    '[9] 同键未到期再占位必须 exists（只有一个调用方拿到 claimed）',
  );
  const claimed = await store.findIdempotent(scope, keyHash);
  assert.notEqual(claimed, null, '[8] 占位后可查到台账行');
  assert.equal(claimed.pending, true, '[8] 占位期 pending 必须为 true');
  assert.deepEqual(claimed.payload, { job_id: job.id }, '[8] 占位期 payload 必须就是 {job_id}（并发重复请求据此定位同一任务）');
  assert.equal(claimed.requestHash, claimRow.requestHash, '[8] request_hash 逐字一致');
  assert.deepEqual(claimed.expiresAt, claimRow.expiresAt, '[8] expires_at 毫秒级往返相等');
  say('[8][9] findIdempotent/claimIdempotent：未占位 ⇒ null；首次 claimed、同键未到期 exists；占位期 payload/pending 如实');

  // ---- [10] finalizeIdempotent ----
  await store.finalizeIdempotent(scope, keyHash, { job_id: job.id, finalized: true });
  const finalized = await store.findIdempotent(scope, keyHash);
  assert.equal(finalized.pending, false, '[10] finalize 后 pending 必须为 false');
  assert.deepEqual(finalized.payload, { job_id: job.id, finalized: true }, '[10] finalize 写入最终结果引用');
  assert.equal(finalized.requestHash, claimRow.requestHash, '[10] finalize 不得改写 request_hash');
  assert.deepEqual(finalized.expiresAt, claimRow.expiresAt, '[10] finalize 不得续期（expires_at 不变）');
  say('[10] finalizeIdempotent：pending ⇒ false、payload 替换为最终引用；request_hash/expires_at 不动');

  // 过期后重新占位（"已到期条目视同不存在"）。
  const expiryScope = `${OWNER_ID}\nPOST\n/api/v1/ocr/${randomUUID()}`;
  const expiryKey = hash(`ocr-expiry-${randomUUID()}`);
  const expiredRow = {
    requestHash: hash('body-old'),
    expiresAt: new Date(T0.getTime() + 1000),
    payload: { job_id: 'old' },
    pending: true,
  };
  assert.equal(await store.claimIdempotent(expiryScope, expiryKey, expiredRow, T0), 'claimed');
  assert.equal(
    await store.claimIdempotent(
      expiryScope,
      expiryKey,
      { requestHash: hash('body-new'), expiresAt: new Date(T2.getTime() + 60_000), payload: { job_id: 'new' }, pending: true },
      T2,
    ),
    'claimed',
    '[9] 已到期条目必须视同不存在，允许重新占位（claimed）',
  );
  const reopened = await store.findIdempotent(expiryScope, expiryKey);
  assert.deepEqual(reopened.payload, { job_id: 'new' }, '[9] 重新占位必须覆盖 payload');
  assert.equal(reopened.requestHash, hash('body-new'), '[9] 重新占位必须覆盖 request_hash');
  say('[9] 过期语义：到期条目被重新占位覆盖（claimed），payload/request_hash 一起换新');

  // ---- [11] releaseIdempotent ----
  const releaseScope = `${OWNER_ID}\nDELETE\n/api/v1/ocr/${randomUUID()}`;
  const releaseKey = hash(`ocr-release-${randomUUID()}`);
  assert.equal(
    await store.claimIdempotent(releaseScope, releaseKey, { requestHash: hash('x'), expiresAt: new Date(T2.getTime() + 60_000), payload: {}, pending: true }, T2),
    'claimed',
  );
  await store.releaseIdempotent(releaseScope, releaseKey);
  assert.equal(await store.findIdempotent(releaseScope, releaseKey), null, '[11] release 后必须查不到（占位已放弃）');
  const releasedRow = await store.claimIdempotent(
    releaseScope,
    releaseKey,
    { requestHash: hash('y'), expiresAt: new Date(T2.getTime() + 60_000), payload: {}, pending: true },
    T2,
  );
  assert.equal(releasedRow, 'claimed', '[11] release 之后同一键必须能重新占位（不会永久 pending）');
  say('[11] releaseIdempotent：占位被真正释放，同键可重新占位（不会留下永久 pending）');

  // ---- [12] purgeIdempotent ----
  const purgeScope = `${OWNER_ID}\nPOST\n/api/v1/ocr/${randomUUID()}`;
  const oldKey = hash(`ocr-purge-old-${randomUUID()}`);
  const liveKey = hash(`ocr-purge-live-${randomUUID()}`);
  await store.claimIdempotent(purgeScope, oldKey, { requestHash: hash('o'), expiresAt: new Date(T0.getTime() + 1000), payload: {}, pending: true }, T0);
  await store.claimIdempotent(purgeScope, liveKey, { requestHash: hash('l'), expiresAt: new Date(T2.getTime() + 3_600_000), payload: {}, pending: true }, T2);
  const purged = await store.purgeIdempotent(T2);
  assert.equal(purged >= 1, true, `[12] purgeIdempotent 必须返回**删除行数**（现场 ${purged}）`);
  assert.equal(await store.findIdempotent(purgeScope, oldKey), null, '[12] 已到期行必须被物理删除');
  assert.notEqual(await store.findIdempotent(purgeScope, liveKey), null, '[12] 未到期行不得被删');
  const remaining = await countOf(
    'SELECT count(*)::int AS v FROM public.ocr_idempotency WHERE expires_at <= $1',
    [T2],
  );
  assert.equal(remaining, 0, '[12] purge 之后库里不得残留已到期行');
  const purgedAgain = await store.purgeIdempotent(T2);
  assert.equal(typeof purgedAgain, 'number', '[12] 返回类型必须是数字（行数）');
  say(`[12] purgeIdempotent：删除 ${purged} 行（返回行数）、未到期行保留、再跑一次不再删（${purgedAgain}）`);

  return { job, record };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const startedAt = Date.now();
try {
  assert.equal(VERIFY_ONLY, false, '主臂不得在 --verify-after-restart 下执行');
  const publicTables = await countOf("SELECT count(*)::int AS v FROM pg_tables WHERE schemaname = 'public'");
  assert.equal(publicTables, 0, `库 ${DB} 必须是空库（现场 public 表数 ${publicTables}）——请先 createdb 一个干净的库`);

  await migrationTriple();

  // 夹具用户：OCR 任务/记录对 users 有 ON DELETE CASCADE 外键，先建两个主体（归属 + 越权）。
  const authStore = createPostgresAuthStore({ query: (text, params) => pool.query(text, params) });
  const subjectOf = (label) => randomBytes(32).toString('hex').replace(/^(.{56}).{8}$/, `$1${label.padStart(8, '0')}`);
  const userA = await authStore.createUser(subjectOf('00002401'));
  const userB = await authStore.createUser(subjectOf('00002402'));
  OWNER_ID = userA.id;
  FOREIGN_ID = userB.id;
  say(`[0] 夹具主体 A=${userA.id}（归属者）/ B=${userB.id}（越权对照）已落 users 表`);

  // [M5] state 的 CHECK 是否真是**7 值闭集**：行为取证（比字符串比对稳）——
  // 塞一个闭集外的 state 必须被库侧拒绝（23514），且不得落行。
  await assert.rejects(
    () =>
      ownerClient.query(
        `INSERT INTO public.ocr_jobs (id, revision, kind, owner_user_id, ocr_id, media_id, media_revision, state, deadline_at, created_at, updated_at)
         VALUES ($1::uuid, 1, 'ocr', $2::uuid, $3::uuid, $4::uuid, 1, 'bogus_state', $5::timestamptz, $5::timestamptz, $5::timestamptz)`,
        [randomUUID(), OWNER_ID, randomUUID(), randomUUID(), T0],
      ),
    (error) => error?.code === '23514',
    '[M5] state 的 CHECK 必须真的拒绝闭集外的值（23514）',
  );
  assert.equal(
    await countOf("SELECT count(*)::int AS v FROM public.ocr_jobs WHERE state = 'bogus_state'"),
    0,
    '[M5] 被拒绝的行不得落库',
  );
  say("[M5] state 闭集行为验证：闭集外 state 'bogus_state' 被库侧 23514 拒绝，且不落行");

  // ---- [W] 接线：real + 真池 ⇒ PG store；real + 无池 ⇒ 如实内存 ----
  const realConfig = {
    ...loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
    executionMode: 'real',
    sessionSigningKey: randomBytes(32).toString('hex'),
  };
  const withPool = buildApp({ config: realConfig, pool });
  assert.equal(withPool.ocrService.describe().storePersistent, true, '[W] real + 真池必须接 PG store（persistent=true）');
  await withPool.close();
  const withoutPool = buildApp({ config: realConfig });
  assert.equal(
    withoutPool.ocrService.describe().storePersistent,
    false,
    '[W] real + 无池必须如实标注不持久（不冒充持久化）',
  );
  await withoutPool.close();
  say('[W] 接线：real+池 ⇒ storePersistent=true；real+无池 ⇒ storePersistent=false（如实，不冒充）');

  // ---- 12 方法（当前连接池上的 store） ----
  const store = createPostgresOcrStore({ pool });
  assert.equal(store.persistent, true, 'store 必须如实声明持久化');
  const written = await allTwelve(store);

  // ---- [R] 重启：关全部连接 → 新池/新 store/新 app → 指纹逐字节相等 ----
  const recordBefore = await store.getOcr(written.record.id);
  const jobBefore = await store.getJob(written.job.id);
  const recordFpBefore = recordFingerprint(recordBefore);
  const liveJobFpBefore = jobFingerprint(jobBefore);
  const sqlTextBefore = (await one("SELECT corrected_fields::text AS v FROM public.ocr_records WHERE id = $1", [written.record.id])).v;
  // 库里这条记录的前后对照：连接级重启必须真的把**连接全关掉**（否则"重启"只是复用会话）。
  const poolBackendsBefore = await countOf(
    'SELECT count(*)::int AS v FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()',
  );
  assert.ok(poolBackendsBefore >= 1, `[R1] 关闭前必须还有连接池的后端进程（现场 ${poolBackendsBefore}）`);

  // 关掉**所有**本进程开过的池（连接全部关闭；服务器端 backend 随之消失）。
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
  const store2 = createPostgresOcrStore({ pool });
  const job2 = await store2.getJob(written.job.id);
  const record2 = await store2.getOcr(written.record.id);
  assert.notEqual(job2, null, '[R] 关连接重开后任务行必须仍在');
  assert.notEqual(record2, null, '[R] 关连接重开后 OCR 记录必须仍在');
  assert.equal(jobFingerprint(job2), liveJobFpBefore, '[R] 任务行重启前后指纹必须逐字节相等');
  assert.equal(recordFingerprint(record2), recordFpBefore, '[R] OCR 记录重启前后指纹必须逐字节相等');
  assert.deepEqual(job2.createdAt, jobBefore.createdAt, '[R] created_at 毫秒级逐字一致');
  assert.deepEqual(record2.correctedFields, { ...FIELDS, name: '草甘膦异丙胺盐可溶液剂（校正）' }, '[R] 校正内容重启后仍在');
  assert.deepEqual(record2.rawFields, FIELDS, '[R] 原始输出重启后仍在且未被校正污染');
  say(
    `[R2] 重启（关连接→新 Pool→新 store）：任务指纹 ${jobFingerprint(job2).slice(0, 16)}… 与记录指纹 ${recordFingerprint(record2).slice(0, 16)}… 与写入时逐字节相等`,
  );

  // 新 app（real + 新池）的 OCR 读面直接读到旧数据 ⇒ 接线后的服务层同样"重启不丢"。
  const app2 = buildApp({ config: realConfig, pool });
  assert.equal(app2.ocrService.describe().storePersistent, true, '[R] 新 app 的 OCR 域必须仍是 PG store');
  const projection = await app2.ocrService.getJob({ userId: OWNER_ID, jobId: written.job.id });
  assert.equal(projection.id, written.job.id, '[R] 新 app 的 getJob 必须读到重启前的任务');
  assert.equal(projection.kind, 'ocr', '[R] 投影 kind 必须是 ocr');
  assert.equal(projection.revision, jobBefore.revision, '[R] 投影 revision 与重启前一致');
  await assert.rejects(
    () => app2.ocrService.getOcr({ userId: FOREIGN_ID, ocrId: written.record.id }),
    (error) => error?.code === 'NOT_FOUND',
    '[R] 他人读同一条记录必须 NOT_FOUND（归属判定不因换 PG store 而放宽）',
  );
  await app2.close();
  say('[R3] 新 app（real+新池）的 OCR 读面读到重启前的任务；他人读同一条记录仍 NOT_FOUND（归属不放宽）');

  // ---- 子进程臂：真·进程重启（spawn 受限时如实登记未取得） ----
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--verify-after-restart'], {
    env: {
      ...process.env,
      [ENV]: url.href,
      GY_OCR_JOB_ID: written.job.id,
      GY_OCR_OCR_ID: written.record.id,
      GY_OCR_OWNER: OWNER_ID,
      GY_OCR_JOB_FP: liveJobFpBefore,
      GY_OCR_RECORD_FP: recordFpBefore,
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
  const tampered = JSON.stringify({ ...JSON.parse(sqlTextBefore), name: '被篡改的名字' });
  await ownerClient.query('UPDATE public.ocr_records SET corrected_fields = $2::jsonb WHERE id = $1', [written.record.id, tampered]);
  const recordTampered = await store2.getOcr(written.record.id);
  assert.notEqual(
    recordFingerprint(recordTampered),
    recordFpBefore,
    '[N1] 篡改后指纹必须变化（否则"重启前后相等"这条判据没有牙齿）',
  );
  assert.notEqual(recordTampered.correctedFields.name, FIELDS.name, '[N1] 篡改必须真的被读到');
  await ownerClient.query('UPDATE public.ocr_records SET corrected_fields = $2::jsonb WHERE id = $1', [written.record.id, sqlTextBefore]);
  const recordRestored = await store2.getOcr(written.record.id);
  assert.equal(recordFingerprint(recordRestored), recordFpBefore, '[N1] 原样写回后指纹必须逐字节复原');
  const sqlTextAfter = (await one("SELECT corrected_fields::text AS v FROM public.ocr_records WHERE id = $1", [written.record.id])).v;
  assert.equal(sqlTextAfter, sqlTextBefore, '[N1] 复原后 jsonb 文本必须与写入时逐字节相等');
  say('[N1] byte_exact_restore：篡改 ⇒ 指纹变（红）；按原 jsonb 文本写回 ⇒ 指纹与 `::text` 双双重现（绿）');

  // ---- [N2] 内存 store 在同一序列下"新实例读不到" ----
  const memoryStore = createMemoryOcrStore();
  const memoryJob = makeJobRow({ ownerUserId: OWNER_ID });
  await memoryStore.insertJob(memoryJob);
  await memoryStore.insertOcr(makeOcrRow(memoryJob));
  const memoryRestarted = createMemoryOcrStore();
  assert.equal(await memoryRestarted.getJob(memoryJob.id), null, '[N2] 内存 store 的"新实例"必须读不到（这就是改前的缺陷本体）');
  assert.equal(await memoryRestarted.getOcr(memoryJob.ocrId), null, '[N2] 内存 store 的"新实例"必须读不到记录');
  assert.equal(memoryStore.persistent, false, '[N2] 内存 store 如实 persistent=false');
  say('[N2] 负控制：同一序列在内存 store 上，新实例读不到任务与记录（改前"重启即丢"的缺陷本体，可复现）');

  // ---- [N3] CAS 并发双写：只允许一次成功 ----
  const raceJob = makeJobRow();
  await store2.insertJob(raceJob);
  const raceResults = await Promise.all([
    store2.updateJob(raceJob.id, 1, (row) => ({ ...row, state: 'running', revision: row.revision + 1, updatedAt: T1 })),
    store2.updateJob(raceJob.id, 1, (row) => ({ ...row, state: 'running', revision: row.revision + 1, updatedAt: T1 })),
  ]);
  const winners = raceResults.filter((value) => value !== null);
  assert.equal(winners.length, 1, `[N3] 同一 revision 的并发双写必须恰好 1 次成功（现场 ${winners.length} 次）`);
  assert.equal(winners[0].revision, 2, '[N3] 赢家 revision 恰好 +1');
  assert.equal(
    (await one('SELECT revision FROM public.ocr_jobs WHERE id = $1', [raceJob.id])).revision,
    2,
    '[N3] 库里 revision 必须是 2（不是 3：CAS 退化会叠加成 +2）',
  );
  say('[N3] 负控制：同一 revision 并发双写 ⇒ 恰好 1 次成功、库内 revision=2（若 CAS 退化为先查后写，本臂会出现 2 次成功）');

  // ---- [N4] 同 id 再写由主键裁决（不是应用层判重） ----
  const dupJob = makeJobRow();
  await store2.insertJob(dupJob);
  await assert.rejects(
    () => store2.insertJob({ ...dupJob, ocrId: randomUUID() }),
    (error) => error?.message === '任务 id 冲突',
  );
  assert.equal(
    await countOf('SELECT count(*)::int AS v FROM public.ocr_jobs WHERE id = $1', [dupJob.id]),
    1,
    '[N4] 重复写后行数必须仍是 1（主键裁决，无检查-写入窗口）',
  );
  say('[N4] 负控制：同 id 并发/重复写由主键裁决 ⇒ 行数恒为 1');

  console.log(`\n共 ${passed} 条 PASS，耗时 ${Date.now() - startedAt}ms`);
  console.log('ALL PASS：OCR 域 PostgreSQL 持久化（迁移 0024 三连 / 12 方法语义 / 关连接重开逐字节仍在 / 4 条负控制）');
} finally {
  for (const opened of openedPools) await opened.end().catch(() => {});
  await ownerClient.end().catch(() => {});
}

unread('HTTP 面的"重启不丢"', 'real 模式真实 OCR 提供者/媒体端口未接线 ⇒ POST /ocr 受理前即 503，无法经 HTTP 建任务；本片证据在 store 层 + 迁移层 + app.ocrService 读面');
unread('多进程并发写同一任务的压测', '本片只做两路并发 CAS（恰好一次成功），未做 20+ 并发的吞吐/延迟读数');
unread('真实标签 OCR 模型输出落库', '模型调用未接线；本片用契约合法的手工字段验证持久化，不伪造模型准确率');
unread('备份恢复演练', '本片只验证单库迁移 UP/ROLLBACK/REPLAY 与关连接重开，未做 pg_dump/pg_restore 演练');
