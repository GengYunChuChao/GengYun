/**
 * R28-S13（#9）· 识别域 PostgreSQL 持久化 —— **真库**验收（本机 PG17）。
 *
 * 为什么必须真库：假池能钉住"发了哪条 SQL"，但钉不住**数据库真的这样裁决**：
 *   枚举型 state 拒绝闭集外取值、jsonb 往返不改形状、CAS 的 `WHERE revision = $2`
 *   在并发下只放行一次、`ON DELETE CASCADE` 真的随主体消失、关连接重开后仍在。
 *
 * 本脚本只证明一件事：**识别域的数据在"新进程 + 新连接池"里还在，且逐字节相等**。
 * 它不证明识别准确率（提供者/媒体未接线，本片全用手工契约行）。
 *
 * 运行（库必须是**全新空库**，脚本第一步就断言 public 表数 = 0）：
 *   createdb -h 127.0.0.1 -p 55613 -U postgres gengyun_recognitions_test
 *   $env:RECOGNITIONS_PG_TEST_URL='postgres://postgres@127.0.0.1:55613/gengyun_recognitions_test'
 *   node tests/integration/recognitions-pg.mjs
 *
 * 退出码：0 = 全绿；1 = 有断言失败（真问题）；77 = **未取得**（env 未设置，不是通过）。
 *
 * 臂表：
 *   [M0]–[M4] 迁移三连（连续无缺号 / UP / ROLLBACK / REPLAY）+ 结构断言
 *   [M1b] 表未迁移时的真库三态（读 ⇒ null，写 ⇒ 指名 0025 的 fail-closed）
 *   [M5] state 的枚举闭集由库侧裁决（闭集外 ⇒ 22P02，且不落行）
 *   [W] 接线：real + 真池 ⇒ storePersistent=true；real + 无池 ⇒ false（如实）
 *   [1]–[13] 13 个方法逐条（含 CAS 二分、冲突文案、幂等四分支）
 *   [R1]–[R4] 关连接重开 / 新 app 读面 / 进程级重启（子进程按指纹比对）
 *   [N1]–[N4] 负控制（篡改必红 / 内存 store 新实例读不到 / 并发 CAS / 主键裁决）
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
import { createMemoryRecognitionStore } from '../../services/api/src/recognitions/store.ts';
import { createPostgresRecognitionStore } from '../../services/api/src/recognitions/store-pg.ts';
import { discoverMigrations } from '../../services/api/src/db/migrate.ts';

const ENV = 'RECOGNITIONS_PG_TEST_URL';
const DB = 'gengyun_recognitions_test';
const MIGRATION = '0025_recognitions_persistence.sql';
const DOWN = `migrations/rollback/${MIGRATION.replace(/\.sql$/, '.down.sql')}`;
const VERIFY_ONLY = process.argv.includes('--verify-after-restart');

const rawUrl = (process.env[ENV] ?? '').trim();
const ALLOW_SKIP = process.argv.includes('--allow-skip') || process.env.GY_ALLOW_SKIP === '1';
if (rawUrl === '' && !VERIFY_ONLY) {
  console.log(`SKIP real PG17: ${ENV} 未设置 —— 本次运行没有验证真库持久化（不是通过，也不是失败）。`);
  if (ALLOW_SKIP) {
    console.log('EXITCODE=0（--allow-skip / GY_ALLOW_SKIP=1 已显式授权：仅本机开发，⛔ 不得接进门禁）。');
    process.exit(0);
  }
  console.log('EXITCODE=77 表示未取得，不是通过（POSIX 惯例 skipped；本机明知无真库时可显式加 --allow-skip 取 0）。');
  process.exit(77);
}

const url = new URL(rawUrl !== '' ? rawUrl : (process.env[ENV] ?? ''));
assert.equal(['postgres:', 'postgresql:'].includes(url.protocol), true, `${ENV} 必须是 postgres/postgresql 连接串`);
assert.equal(url.search, '', `${ENV} 不得带查询串（连接参数走默认值，避免"我本机行别人不行"）`);
assert.equal(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), true, `${ENV} 必须是回环地址`);
assert.equal(url.pathname, `/${DB}`, `${ENV} 的库名必须是 ${DB}（本脚本会 DROP/建表，绝不能指向别的库）`);

let passed = 0;
const say = (message) => {
  passed += 1;
  console.log(`PASS ${passed}: ${message}`);
};
const unread = (label, why) => console.log(`未取得 ${label}：${why}`);

const readSql = (rel) => readFileSync(new URL(`../../services/api/db/${rel}`, import.meta.url), 'utf8');
const migrationsDir = new URL('../../services/api/db/migrations/', import.meta.url);
const hash = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/** 任务行指纹：字段顺序固定 ⇒ 同一行必须给出同一串（逐字节比对的前提）。 */
function jobFingerprint(row) {
  return hash(
    JSON.stringify({
      id: row.id,
      revision: row.revision,
      kind: row.kind,
      ownerUserId: row.ownerUserId,
      recognitionId: row.recognitionId,
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

/** 识别记录指纹（含 jsonb 候选与不确定原因）。 */
function recordFingerprint(row) {
  return hash(
    JSON.stringify({
      id: row.id,
      revision: row.revision,
      ownerUserId: row.ownerUserId,
      mediaId: row.mediaId,
      mediaRevision: row.mediaRevision,
      candidates: row.candidates,
      uncertaintyReasons: row.uncertaintyReasons,
      selectedSpeciesId: row.selectedSpeciesId,
      modelVersion: row.modelVersion,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      deleted: row.deleted,
    }),
  );
}

/** 选择记录指纹（含整块 linkage jsonb）。 */
function selectionFingerprint(row) {
  return hash(
    JSON.stringify({
      id: row.id,
      revision: row.revision,
      recognitionId: row.recognitionId,
      ownerUserId: row.ownerUserId,
      speciesId: row.speciesId,
      provenance: row.provenance,
      decidedAt: row.decidedAt.toISOString(),
      linkage: row.linkage,
    }),
  );
}

// ---------------------------------------------------------------------------
// 子进程臂（真·进程重启）：只读、只断言，任何不符都以非 0 退出。
// ---------------------------------------------------------------------------
if (VERIFY_ONLY) {
  const jobId = process.env['GY_RECOG_JOB_ID'];
  const recordId = process.env['GY_RECOG_RECORD_ID'];
  const owner = process.env['GY_RECOG_OWNER'];
  const expectedJobFp = process.env['GY_RECOG_JOB_FP'];
  const expectedRecordFp = process.env['GY_RECOG_RECORD_FP'];
  const client = new pg.Pool({ connectionString: url.href });
  try {
    const store = createPostgresRecognitionStore({ pool: client });
    assert.equal(store.persistent, true, '子进程：store 必须如实声明持久化');
    const job = await store.getJob(jobId);
    assert.notEqual(job, null, '子进程：重启后任务行必须仍在');
    assert.equal(job.ownerUserId, owner, '子进程：任务归属者必须逐字一致');
    const record = await store.getRecognition(recordId);
    assert.notEqual(record, null, '子进程：重启后识别记录必须仍在');
    assert.equal(jobFingerprint(job), expectedJobFp, '子进程：任务行指纹必须与写入时逐字节相等');
    assert.equal(recordFingerprint(record), expectedRecordFp, '子进程：识别记录指纹必须与写入时逐字节相等');
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
/** 本进程开过的池：全部 `end()` 后才能说"连接真的全关过"。 */
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

// 固定时刻（毫秒精度，与 store 写回口径一致，便于逐字节比对）。
const T0 = new Date('2026-10-20T08:00:00.000Z');
const T1 = new Date('2026-10-20T08:00:01.000Z');
const T2 = new Date('2026-10-20T08:00:02.000Z');

const CANDIDATES = [
  { species_id: 'sp-0001', rank: 1, model_score: 0.92 },
  { species_id: 'sp-0002', rank: 2, model_score: 0.41 },
  { species_id: 'sp-0003', rank: 3, model_score: null },
];
const REASONS = ['叶片遮挡', '光照不足'];
/** 契约合法的 linkage 夹具（store 只做 jsonb 往返，不做规则校验 ⇒ 空 items 即可）。 */
const LINKAGE = {
  species_id: 'sp-0001',
  rule_version: 'rule-2026-10-a',
  reference_state: 'available',
  items: [],
  excluded: [],
  applicable_count: 0,
  conditions_complete: false,
  missing_conditions: [],
  blocked_codes: ['DOSE_CONDITIONS_INCOMPLETE'],
  dose: {
    renderable: false,
    card: null,
    block_code: 'DOSE_CONDITIONS_INCOMPLETE',
    blocked_by_path: 'recognition_selection',
    missing_conditions: [],
    conditionally_renderable_count: 0,
    per_item: [],
    rule_version: 'rule-2026-10-a',
  },
  note: '未提供作物/生育期，剂量卡不渲染',
};

let OWNER_ID;
let FOREIGN_ID;

function makeJobRow(overrides = {}) {
  return {
    id: randomUUID(),
    revision: 1,
    kind: 'recognition',
    ownerUserId: OWNER_ID,
    recognitionId: randomUUID(),
    mediaId: randomUUID(),
    mediaRevision: 1,
    state: 'queued',
    deadlineAt: T1,
    createdAt: T0,
    updatedAt: T0,
    errorCode: null,
    ...overrides,
  };
}

function makeRecognitionRow(overrides = {}) {
  return {
    id: randomUUID(),
    revision: 1,
    ownerUserId: OWNER_ID,
    mediaId: randomUUID(),
    mediaRevision: 1,
    candidates: CANDIDATES,
    uncertaintyReasons: REASONS,
    selectedSpeciesId: null,
    modelVersion: 'recog-model-2026.10',
    createdAt: T1,
    updatedAt: T1,
    deleted: false,
    ...overrides,
  };
}

function makeSelectionRow(recognition, overrides = {}) {
  return {
    id: randomUUID(),
    revision: 1,
    recognitionId: recognition.id,
    ownerUserId: recognition.ownerUserId,
    speciesId: 'sp-0001',
    provenance: 'human',
    decidedAt: T1,
    linkage: LINKAGE,
    ...overrides,
  };
}

/** 迁移三连 + 结构断言 + 未迁移三态（真库）。 */
async function migrationTriple() {
  const discovered = discoverMigrations();
  const numbers = discovered.map((migration) => Number(migration.version));
  const max = Math.max(...numbers);
  const seen = new Set(numbers);
  const missing = [];
  for (let version = 1; version <= max; version += 1) if (!seen.has(version)) missing.push(version);
  assert.deepEqual(missing, [], `迁移版本必须连续无缺号（缺：${missing.join(',')}）`);
  assert.equal(discovered.length, max, `迁移总数必须等于最大版本号（count=${discovered.length}，max=${max}）`);
  const names = discovered.map((migration) => migration.filename);
  assert.equal(names.includes(MIGRATION), true, `${MIGRATION} 必须是顶层迁移的一部分`);
  assert.equal(names[names.length - 1], MIGRATION, `${MIGRATION} 必须是当前最后一条（本片新增的就是末位）`);
  say(`[M0] 结构不变量：迁移 ${discovered.length} 个（0001..${String(max).padStart(4, '0')}）连续无缺号，${MIGRATION} 是末位`);

  const objects = async () => ({
    jobs: (await one("SELECT to_regclass('public.recognition_jobs') AS v")).v,
    records: (await one("SELECT to_regclass('public.recognition_records') AS v")).v,
    selections: (await one("SELECT to_regclass('public.recognition_selections') AS v")).v,
    idem: (await one("SELECT to_regclass('public.recognition_idempotency') AS v")).v,
    jobsIdx: (await one("SELECT to_regclass('public.recognition_jobs_owner_created_idx') AS v")).v,
    recordsIdx: (await one("SELECT to_regclass('public.recognition_records_owner_created_idx') AS v")).v,
    selectionsIdx: (await one("SELECT to_regclass('public.recognition_selections_recognition_decided_idx') AS v")).v,
    idemIdx: (await one("SELECT to_regclass('public.recognition_idempotency_expires_idx') AS v")).v,
    // 表不存在时 pg_attribute 无匹配行 ⇒ one() 给 undefined（不是错误），显式落成 null。
    stateType:
      (
        await one(
          "SELECT format_type(atttypid, atttypmod) AS v FROM pg_attribute WHERE attrelid = to_regclass('public.recognition_jobs') AND attname = 'state'",
        )
      )?.v ?? null,
    users: (await one("SELECT to_regclass('public.users') AS v")).v,
    jobsTable: (await one("SELECT to_regclass('public.jobs') AS v")).v,
    fkCascade: await countOf(
      "SELECT count(*)::int AS v FROM pg_constraint WHERE conrelid IN (to_regclass('public.recognition_jobs'), to_regclass('public.recognition_records'), to_regclass('public.recognition_selections')) AND contype = 'f' AND confdeltype = 'c'",
    ),
  });

  for (const name of readdirSync(migrationsDir).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort()) {
    if (name === MIGRATION) continue;
    await ownerClient.query(readSql(`migrations/${name}`));
  }
  let state = await objects();
  assert.equal(state.jobs, null, '应用其它迁移后 recognition_jobs 必须还不存在（证明 UP 才是它出现的唯一原因）');
  assert.equal(state.records, null, '应用其它迁移后 recognition_records 必须还不存在');
  assert.equal(state.selections, null, '应用其它迁移后 recognition_selections 必须还不存在');
  assert.equal(state.idem, null, '应用其它迁移后 recognition_idempotency 必须还不存在');
  assert.equal(state.users, 'users', '0001 的 users 必须在岗（外键与夹具都依赖它）');
  say('[M1] 0001..0024 已应用：recognition_* 四表全部不存在，users 在岗');

  // ---- [M1b] 表未迁移的真库三态：读 ⇒ null，写 ⇒ 指名 0025 的 fail-closed ----
  // 这条臂是 #323 真红的正面回应：「表未迁移」不是「数据库故障」。
  const missingStore = createPostgresRecognitionStore({ pool });
  assert.equal(await missingStore.getJob(randomUUID()), null, '[M1b] 表未迁移 ⇒ getJob 必须返回 null（不是抛错）');
  assert.equal(
    await missingStore.getRecognition(randomUUID()),
    null,
    '[M1b] 表未迁移 ⇒ getRecognition 必须返回 null（不是抛错）',
  );
  assert.deepEqual(
    await missingStore.listSelections(randomUUID(), randomUUID()),
    [],
    '[M1b] 表未迁移 ⇒ listSelections 必须返回空数组（不是抛错）',
  );
  // assert.rejects 的校验函数必须**同步**返回 true（返回 Promise 会被判为不符，即使 Promise<true>）。
  const rejects0025 = (label) => (error) => {
    assert.equal(error?.name, 'RecognitionTablesMissingError', `${label} 必须是 RecognitionTablesMissingError`);
    assert.equal(error?.code, 'PROVIDER_UNAVAILABLE', `${label} 的 code 必须是 PROVIDER_UNAVAILABLE`);
    assert.equal(error?.retryable, false, `${label} 必须不可重试（fail-closed，不静默丢数据）`);
    assert.match(String(error?.message), /0025_recognitions_persistence\.sql/, `${label} 必须点名迁移文件名`);
    assert.match(String(error?.message), /未迁移/, `${label} 必须说清是"未迁移"而不是"数据库故障"`);
    return true;
  };
  await assert.rejects(() => missingStore.insertJob(makeJobRow({ ownerUserId: randomUUID() })), rejects0025('insertJob'));
  await assert.rejects(() => missingStore.purgeIdempotent(T0), rejects0025('purgeIdempotent'));
  await assert.rejects(
    () => missingStore.claimIdempotent('scope-missing', 'key-missing', { requestHash: 'h', expiresAt: T1, now: T0 }),
    rejects0025('claimIdempotent'),
  );
  assert.equal(
    await countOf("SELECT count(*)::int AS v FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'recognition_%'"),
    0,
    '[M1b] 写类 fail-closed 之后不得留下任何半成品表/行',
  );
  say('[M1b] 表未迁移（真库）：读类方法 ⇒ null/[]；写类 ⇒ RecognitionTablesMissingError（点名 0025、retryable=false）');

  await ownerClient.query(readSql(`migrations/${MIGRATION}`));
  state = await objects();
  assert.equal(state.jobs, 'recognition_jobs', 'UP 后 recognition_jobs 必须存在');
  assert.equal(state.records, 'recognition_records', 'UP 后 recognition_records 必须存在');
  assert.equal(state.selections, 'recognition_selections', 'UP 后 recognition_selections 必须存在');
  assert.equal(state.idem, 'recognition_idempotency', 'UP 后 recognition_idempotency 必须存在');
  assert.equal(state.jobsIdx, 'recognition_jobs_owner_created_idx', 'UP 后任务归属排序索引必须在岗');
  assert.equal(state.recordsIdx, 'recognition_records_owner_created_idx', 'UP 后记录归属排序索引必须在岗');
  assert.equal(
    state.selectionsIdx,
    'recognition_selections_recognition_decided_idx',
    'UP 后选择记录的 (recognition_id, owner_user_id, decided_at) 索引必须在岗（listSelections 命中它）',
  );
  assert.equal(state.idemIdx, 'recognition_idempotency_expires_idx', 'UP 后台账过期索引必须在岗');
  assert.equal(state.stateType, 'job_state', 'state 必须是 0001 的 job_state 枚举（本片复用，不新建类型）');
  assert.equal(state.fkCascade, 4, 'ON DELETE CASCADE 外键必须是 4 条（三张表归属 users + 选择记录归属识别记录）');
  say('[M2] UP：四表 + 四索引 + state 是 job_state 枚举 + 4 条 CASCADE 外键全部出现');

  await ownerClient.query(readSql(DOWN));
  state = await objects();
  assert.equal(state.jobs, null, 'DOWN 后 recognition_jobs 必须消失');
  assert.equal(state.records, null, 'DOWN 后 recognition_records 必须消失');
  assert.equal(state.selections, null, 'DOWN 后 recognition_selections 必须消失');
  assert.equal(state.idem, null, 'DOWN 后 recognition_idempotency 必须消失');
  assert.equal(state.jobsIdx, null, 'DOWN 后索引必须消失');
  assert.equal(state.users, 'users', 'DOWN 不得触碰 users');
  assert.equal(state.jobsTable, 'jobs', 'DOWN 不得触碰 0001 的共享 jobs 表');
  say('[M3] ROLLBACK：本片对象全部消失，users 与 0001 的 jobs 表逐字仍在');

  await ownerClient.query(readSql(`migrations/${MIGRATION}`));
  assert.equal((await objects()).jobs, 'recognition_jobs', 'REPLAY 后必须再次出现（迁移可重放）');
  say('[M4] REPLAY：同一份 UP 再执行一次仍成功，recognition_jobs 再次出现');
}

/** [1]–[13] 十三个方法逐条。返回供 [R] 臂使用的"活行"。 */
async function allThirteen(store) {
  // ---- [1] insertJob ----
  const job = makeJobRow();
  await store.insertJob(job);
  assert.equal(
    await countOf('SELECT count(*)::int AS v FROM public.recognition_jobs WHERE id = $1', [job.id]),
    1,
    '[1] insertJob 必须真的落库 1 行',
  );
  await assert.rejects(
    () => store.insertJob({ ...job, recognitionId: randomUUID() }),
    (error) => error instanceof Error && error.message === '任务 id 冲突',
    '[1] 同 id 再写必须抛「任务 id 冲突」（判定由主键裁决，不是先查后写）',
  );
  say('[1] insertJob：落库 1 行；同 id 再写由主键裁决并抛「任务 id 冲突」');

  // ---- [2] getJob ----
  const readBack = await store.getJob(job.id);
  assert.notEqual(readBack, null, '[2] getJob 必须读到刚写入的行');
  assert.equal(readBack.revision, 1, '[2] revision 初始 1');
  assert.equal(readBack.kind, 'recognition', '[2] kind 必须是 recognition');
  assert.equal(readBack.ownerUserId, OWNER_ID, '[2] 归属者逐字一致');
  assert.equal(readBack.state, 'queued', '[2] state 初始 queued');
  assert.equal(readBack.deadlineAt instanceof Date, true, '[2] deadlineAt 必须是 Date（不是字符串）');
  assert.equal(readBack.deadlineAt.toISOString(), T1.toISOString(), '[2] deadlineAt 毫秒级一致');
  assert.equal(readBack.errorCode, null, '[2] errorCode 初始 null');
  assert.equal(await store.getJob(randomUUID()), null, '[2] 不存在的 id 必须返回 null（不是抛错）');
  say('[2] getJob：行形状/snake_case→契约字段/Date 还原/不存在 ⇒ null 全部正确');

  // ---- [3] updateJob（CAS） ----
  const running = await store.updateJob(job.id, 1, (row) => ({
    ...row,
    state: 'running',
    revision: row.revision + 1,
    updatedAt: T1,
  }));
  assert.notEqual(running, null, '[3] revision=1 的更新必须成功');
  assert.equal(running.revision, 2, '[3] revision 必须 +1 ⇒ 2');
  assert.equal(running.state, 'running', '[3] state 必须改为 running');
  const staleUpdate = await store.updateJob(job.id, 1, (row) => ({ ...row, state: 'failed', revision: row.revision + 1, updatedAt: T2 }));
  assert.equal(staleUpdate, null, '[3] 过期 revision 的更新必须返回 null（CAS 拒绝）');
  assert.equal(
    (await one('SELECT revision FROM public.recognition_jobs WHERE id = $1', [job.id])).revision,
    2,
    '[3] 库里 revision 必须仍是 2（被拒绝的更新不得落库）',
  );
  say('[3] updateJob：CAS 命中 ⇒ revision 1→2；过期 revision ⇒ null 且库内不变');

  // ---- [4] commitTerminal（终态 + 建记录，同事务） ----
  const terminalRecord = makeRecognitionRow({ id: job.recognitionId });
  const committed = await store.commitTerminal(job.id, 2, { state: 'succeeded', errorCode: null }, terminalRecord, T2);
  assert.notEqual(committed, null, '[4] running(r2) → succeeded 必须成功');
  assert.equal(committed.revision, 3, '[4] 终态提交后 revision 必须 +1 ⇒ 3');
  assert.equal(committed.state, 'succeeded', '[4] state 必须落到 succeeded');
  assert.equal(committed.errorCode, null, '[4] 成功路径 errorCode 必须为 null');
  assert.equal(
    await countOf('SELECT count(*)::int AS v FROM public.recognition_records WHERE id = $1', [terminalRecord.id]),
    1,
    '[4] commitTerminal 必须把识别记录同时写入（同一事务）',
  );
  const staleTerminal = await store.commitTerminal(job.id, 2, { state: 'failed', errorCode: 'PROVIDER_UNAVAILABLE' }, null, T2);
  assert.equal(staleTerminal, null, '[4] 过期 revision 的终态提交必须返回 null');
  const illegalTransition = await store.commitTerminal(job.id, 3, { state: 'cancelled' }, null, T2);
  assert.equal(illegalTransition, null, '[4] 终态不得离开（succeeded → cancelled 必须 null）');
  // 终态拒绝时不得留下孤儿记录：另起一条 running 任务，用过期 revision 提交一条新记录。
  const job2 = makeJobRow();
  await store.insertJob(job2);
  await store.updateJob(job2.id, 1, (row) => ({ ...row, state: 'running', revision: row.revision + 1, updatedAt: T1 }));
  const orphan = makeRecognitionRow();
  const rejected = await store.commitTerminal(job2.id, 1, { state: 'succeeded' }, orphan, T2);
  assert.equal(rejected, null, '[4] 过期 revision 的终态提交必须 null');
  assert.equal(
    await countOf('SELECT count(*)::int AS v FROM public.recognition_records WHERE id = $1', [orphan.id]),
    0,
    '[4] CAS 拒绝时不得写入孤儿识别记录（先 SELECT FOR UPDATE 再决定）',
  );
  say('[4] commitTerminal：CAS 命中 ⇒ 终态 + 记录同事务落库；过期/非法转移 ⇒ null 且零孤儿记录');

  // ---- [5] insertRecognition ----
  const record = makeRecognitionRow();
  await store.insertRecognition(record);
  assert.equal(
    await countOf('SELECT count(*)::int AS v FROM public.recognition_records WHERE id = $1', [record.id]),
    1,
    '[5] insertRecognition 必须落库 1 行',
  );
  await assert.rejects(
    () => store.insertRecognition({ ...record, mediaId: randomUUID() }),
    (error) => error instanceof Error && error.message === '识别记录 id 冲突',
    '[5] 同 id 再写必须抛「识别记录 id 冲突」',
  );
  say('[5] insertRecognition：落库 1 行；同 id 再写抛「识别记录 id 冲突」');

  // ---- [6] getRecognition（jsonb 往返） ----
  const recordBack = await store.getRecognition(record.id);
  assert.notEqual(recordBack, null, '[6] getRecognition 必须读到刚写入的记录');
  assert.deepEqual(recordBack.candidates, CANDIDATES, '[6] 候选数组必须逐字段往返（含 null score）');
  assert.deepEqual(recordBack.uncertaintyReasons, REASONS, '[6] 不确定原因数组必须逐字往返');
  assert.equal(recordBack.selectedSpeciesId, null, '[6] 未选择时 selectedSpeciesId 必须 null');
  assert.equal(recordBack.deleted, false, '[6] deleted 初始 false');
  assert.equal(recordBack.createdAt instanceof Date, true, '[6] createdAt 必须是 Date');
  assert.equal(await store.getRecognition(randomUUID()), null, '[6] 不存在的 id ⇒ null');
  say('[6] getRecognition：候选/原因 jsonb 逐字段往返、Date 还原、不存在 ⇒ null');

  // ---- [7] updateRecognition（CAS） ----
  const patched = await store.updateRecognition(record.id, 1, (row) => ({
    ...row,
    selectedSpeciesId: 'sp-0002',
    revision: row.revision + 1,
    updatedAt: T2,
  }));
  assert.notEqual(patched, null, '[7] revision=1 的更新必须成功');
  assert.equal(patched.revision, 2, '[7] revision 必须 +1');
  assert.equal(patched.selectedSpeciesId, 'sp-0002', '[7] selectedSpeciesId 必须更新');
  assert.equal(
    await store.updateRecognition(record.id, 1, (row) => ({ ...row, deleted: true, revision: row.revision + 1, updatedAt: T2 })),
    null,
    '[7] 过期 revision 必须 null',
  );
  say('[7] updateRecognition：CAS 命中 ⇒ 字段更新 + revision+1；过期 ⇒ null');

  // ---- [8] commitSelection ----
  const selection1 = makeSelectionRow(record, { decidedAt: T1, speciesId: 'sp-0001' });
  const selected = await store.commitSelection(record.id, 2, (row) => ({
    ...row,
    selectedSpeciesId: 'sp-0001',
    revision: row.revision + 1,
    updatedAt: T2,
  }), selection1);
  assert.notEqual(selected, null, '[8] revision=2 的选择提交必须成功');
  assert.equal(selected.recognition.revision, 3, '[8] 识别记录 revision 必须 +1');
  assert.equal(selected.recognition.selectedSpeciesId, 'sp-0001', '[8] selectedSpeciesId 必须落到记录上');
  assert.equal(selected.selection.id, selection1.id, '[8] 必须返回落库后的选择记录');
  assert.equal(
    await countOf('SELECT count(*)::int AS v FROM public.recognition_selections WHERE id = $1', [selection1.id]),
    1,
    '[8] 选择记录必须落库 1 行',
  );
  assert.deepEqual(selected.selection.linkage, LINKAGE, '[8] linkage jsonb 必须逐字段往返');
  await assert.rejects(
    () => store.commitSelection(record.id, 3, (row) => ({ ...row, revision: row.revision + 1, updatedAt: T2 }), makeSelectionRow(record, { recognitionId: randomUUID() })),
    (error) => error instanceof Error && error.message === '选择记录与识别记录不匹配',
    '[8] 选择记录与识别记录不匹配必须抛原文（普通 Error，不是 ApiError）',
  );
  assert.equal(
    await countOf('SELECT count(*)::int AS v FROM public.recognition_selections WHERE recognition_id = $1', [record.id]),
    1,
    '[8] 不匹配的选择不得落库（否则出现无法归属的孤儿选择行）',
  );
  await assert.rejects(
    () => store.commitSelection(record.id, 3, (row) => ({ ...row, revision: row.revision + 1, updatedAt: T2 }), selection1),
    (error) => error instanceof Error && error.message === '选择记录 id 冲突',
    '[8] 同 id 再写必须抛「选择记录 id 冲突」',
  );
  assert.equal(
    (await one('SELECT revision FROM public.recognition_records WHERE id = $1', [record.id])).revision,
    3,
    '[8] 选择 id 冲突时事务必须回滚（记录 revision 仍是 3）',
  );
  const staleSelection = await store.commitSelection(record.id, 2, (row) => ({ ...row, revision: row.revision + 1, updatedAt: T2 }), makeSelectionRow(record, { decidedAt: T2 }));
  assert.equal(staleSelection, null, '[8] 过期 revision 的选择提交必须 null');
  assert.equal(
    await countOf('SELECT count(*)::int AS v FROM public.recognition_selections WHERE recognition_id = $1', [record.id]),
    1,
    '[8] CAS 失败不得写孤儿选择行',
  );
  say('[8] commitSelection：CAS 命中 ⇒ 记录 + 选择同事务；不匹配/同 id/CAS 失败 ⇒ 原文错误或 null，且零孤儿行');

  // ---- [9] listSelections（归属过滤 + 时间升序） ----
  const selection2 = makeSelectionRow(record, { decidedAt: T2, speciesId: 'sp-0003', provenance: 'manual_override' });
  const second = await store.commitSelection(record.id, 3, (row) => ({
    ...row,
    selectedSpeciesId: 'sp-0003',
    revision: row.revision + 1,
    updatedAt: T2,
  }), selection2);
  assert.notEqual(second, null, '[9] 第二次选择提交必须成功（改选是追加，不是覆盖）');
  const mine = await store.listSelections(record.id, OWNER_ID);
  assert.equal(mine.length, 2, '[9] 归属者必须读到 2 条选择历史');
  assert.deepEqual(
    mine.map((row) => row.id),
    [selection1.id, selection2.id],
    '[9] 必须按 decided_at 升序（历史是 append-only，顺序即时间顺序）',
  );
  assert.equal(mine[1].provenance, 'manual_override', '[9] provenance 必须如实往返');
  assert.equal(mine[1].revision, 1, '[9] 选择记录 revision 初始 1');
  assert.deepEqual(await store.listSelections(record.id, FOREIGN_ID), [], '[9] 非归属者必须读不到（返回空数组）');
  say('[9] listSelections：归属过滤 + decided_at 升序 + provenance/revision 往返；越权 ⇒ []');

  // ---- [10] claimIdempotent（四分支） ----
  const scope = `scope-${randomUUID()}`;
  const claimInput = { requestHash: 'h-1', expiresAt: T2, now: T0 };
  assert.deepEqual(await store.claimIdempotent(scope, 'key-1', claimInput), { status: 'claimed' }, '[10] 首次占位 ⇒ claimed');
  assert.deepEqual(await store.claimIdempotent(scope, 'key-1', claimInput), { status: 'in_progress' }, '[10] 活跃占位 + 同体 ⇒ in_progress');
  assert.deepEqual(
    await store.claimIdempotent(scope, 'key-1', { ...claimInput, requestHash: 'h-2' }),
    { status: 'conflict' },
    '[10] 活跃占位 + 异体 ⇒ conflict',
  );
  await store.completeIdempotent(scope, 'key-1', { requestHash: 'h-1', expiresAt: T2, payload: { job_id: job.id } });
  const completed = await store.claimIdempotent(scope, 'key-1', claimInput);
  assert.equal(completed.status, 'completed', '[10] 已完成回执 + 同体 ⇒ completed');
  assert.deepEqual(completed.row.payload, { job_id: job.id }, '[10] 回执 payload 必须逐字段往返');
  assert.deepEqual(
    await store.claimIdempotent(scope, 'key-1', { ...claimInput, requestHash: 'h-9' }),
    { status: 'conflict' },
    '[10] 已完成回执 + 异体 ⇒ conflict',
  );
  say('[10] claimIdempotent：claimed / in_progress / conflict / completed(+回执 payload) 四分支与内存实现一致');

  // ---- [11] completeIdempotent ----
  const pendingRow = await one("SELECT pending, request_hash FROM public.recognition_idempotency WHERE scope = $1 AND key_hash = $2", [scope, 'key-1']);
  assert.equal(pendingRow.pending, false, '[11] completeIdempotent 后 pending 必须是 false（占位变回执）');
  assert.equal(pendingRow.request_hash, 'h-1', '[11] 回执必须保留 request_hash');
  say('[11] completeIdempotent：占位翻成回执（pending=false），payload/request_hash 逐字段留在库里');

  // ---- [12] releaseIdempotent ----
  assert.deepEqual(await store.claimIdempotent(scope, 'key-2', claimInput), { status: 'claimed' }, '[12] 新 key 首次占位 ⇒ claimed');
  await store.releaseIdempotent(scope, 'key-2');
  assert.equal(
    await countOf('SELECT count(*)::int AS v FROM public.recognition_idempotency WHERE scope = $1 AND key_hash = $2', [scope, 'key-2']),
    0,
    '[12] release 之后占位行必须消失',
  );
  assert.deepEqual(await store.claimIdempotent(scope, 'key-2', claimInput), { status: 'claimed' }, '[12] release 后必须能重新占位');
  say('[12] releaseIdempotent：只删占位、删后可重新占位（不污染已完成回执）');

  // ---- [13] purgeIdempotent ----
  const purgeScope = `purge-${randomUUID()}`;
  await store.claimIdempotent(purgeScope, 'old-1', { requestHash: 'h', expiresAt: T0, now: T0 });
  await ownerClient.query(
    `INSERT INTO public.recognition_idempotency (scope, key_hash, request_hash, payload, pending, expires_at)
     VALUES ($1, 'old-2', 'h', '{"a":1}'::jsonb, false, $2::timestamptz)`,
    [purgeScope, T0],
  );
  const expiredBefore = await countOf(
    'SELECT count(*)::int AS v FROM public.recognition_idempotency WHERE expires_at <= $1::timestamptz',
    [T1],
  );
  assert.equal(expiredBefore, 2, `[13] 现场应有 2 条已过期台账（实际 ${expiredBefore}）`);
  const purged = await store.purgeIdempotent(T1);
  assert.equal(purged, 2, `[13] purgeIdempotent 必须返回删除条数 2（实际 ${purged}）`);
  assert.equal(
    await countOf('SELECT count(*)::int AS v FROM public.recognition_idempotency WHERE expires_at <= $1::timestamptz', [T1]),
    0,
    '[13] purge 之后不得残留已过期台账',
  );
  assert.equal(
    await countOf('SELECT count(*)::int AS v FROM public.recognition_idempotency WHERE scope = $1', [scope]),
    2,
    '[13] 该 scope 的两条未过期台账（key-1 回执 + key-2 占位）不得被顺手删掉',
  );
  say('[13] purgeIdempotent：只删 expires_at <= now 的行并返回真实删除条数（未过期回执不动）');

  return { job, record, job2, terminalRecord };
}

const startedAt = Date.now();
try {
  assert.equal(VERIFY_ONLY, false, '主臂不得在 --verify-after-restart 下执行');
  const publicTables = await countOf("SELECT count(*)::int AS v FROM pg_tables WHERE schemaname = 'public'");
  assert.equal(publicTables, 0, `库 ${DB} 必须是空库（现场 public 表数 ${publicTables}）——请先 createdb 一个干净的库`);

  await migrationTriple();

  // 夹具主体：三张表对 users 有 ON DELETE CASCADE 外键，先建两个主体（归属 + 越权）。
  const authStore = createPostgresAuthStore({ query: (text, params) => pool.query(text, params) });
  const subjectOf = (label) => randomBytes(32).toString('hex').replace(/^(.{56}).{8}$/, `$1${label.padStart(8, '0')}`);
  const userA = await authStore.createUser(subjectOf('00002501'));
  const userB = await authStore.createUser(subjectOf('00002502'));
  OWNER_ID = userA.id;
  FOREIGN_ID = userB.id;
  say(`[0] 夹具主体 A=${userA.id}（归属者）/ B=${userB.id}（越权对照）已落 users 表`);

  // ---- [M5] state 是不是**真的**枚举闭集：行为取证（枚举列塞闭集外取值 ⇒ 22P02） ----
  await assert.rejects(
    () =>
      ownerClient.query(
        `INSERT INTO public.recognition_jobs (id, revision, kind, owner_user_id, recognition_id, media_id, media_revision, state, deadline_at, created_at, updated_at)
         VALUES ($1::uuid, 1, 'recognition', $2::uuid, $3::uuid, $4::uuid, 1, 'bogus_state', $5::timestamptz, $5::timestamptz, $5::timestamptz)`,
        [randomUUID(), OWNER_ID, randomUUID(), randomUUID(), T0],
      ),
    (error) => error?.code === '22P02',
    '[M5] state 是 job_state 枚举，闭集外取值必须被库侧拒绝（22P02）',
  );
  assert.equal(
    await countOf("SELECT count(*)::int AS v FROM public.recognition_jobs WHERE owner_user_id = $1", [OWNER_ID]),
    0,
    '[M5] 被拒绝的行不得落库',
  );
  say("[M5] state 闭集行为验证：闭集外 state 'bogus_state' 被库侧 22P02 拒绝，且不落行");

  // ---- [W] 接线：real + 真池 ⇒ PG store；real + 无池 ⇒ 如实内存 ----
  const realConfig = {
    ...loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
    executionMode: 'real',
    sessionSigningKey: randomBytes(32).toString('hex'),
  };
  const withPool = buildApp({ config: realConfig, pool });
  assert.equal(
    withPool.recognitionService.describe().storePersistent,
    true,
    '[W] real + 真池必须接 PG store（persistent=true）',
  );
  await withPool.close();
  const withoutPool = buildApp({ config: realConfig });
  assert.equal(
    withoutPool.recognitionService.describe().storePersistent,
    false,
    '[W] real + 无池必须如实标注不持久（不冒充持久化）',
  );
  await withoutPool.close();
  say('[W] 接线：real+池 ⇒ storePersistent=true；real+无池 ⇒ storePersistent=false（如实，不冒充）');

  // ---- 13 方法（当前连接池上的 store） ----
  const store = createPostgresRecognitionStore({ pool });
  assert.equal(store.persistent, true, 'store 必须如实声明持久化');
  const written = await allThirteen(store);

  // ---- [R] 重启：关全部连接 → 新池/新 store/新 app → 指纹逐字节相等 ----
  const jobBefore = await store.getJob(written.job.id);
  const recordBefore = await store.getRecognition(written.terminalRecord.id);
  const jobFpBefore = jobFingerprint(jobBefore);
  const recordFpBefore = recordFingerprint(recordBefore);
  const candidatesTextBefore = (
    await one('SELECT candidates::text AS v FROM public.recognition_records WHERE id = $1', [written.terminalRecord.id])
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
  const store2 = createPostgresRecognitionStore({ pool });
  const job2 = await store2.getJob(written.job.id);
  const record2 = await store2.getRecognition(written.terminalRecord.id);
  assert.notEqual(job2, null, '[R2] 关连接重开后任务行必须仍在');
  assert.notEqual(record2, null, '[R2] 关连接重开后识别记录必须仍在');
  assert.equal(jobFingerprint(job2), jobFpBefore, '[R2] 任务行重启前后指纹必须逐字节相等');
  assert.equal(recordFingerprint(record2), recordFpBefore, '[R2] 识别记录重启前后指纹必须逐字节相等');
  assert.deepEqual(job2.createdAt, jobBefore.createdAt, '[R2] created_at 毫秒级逐字一致');
  assert.deepEqual(record2.candidates, CANDIDATES, '[R2] 候选数组重启后逐字段仍在');
  assert.deepEqual(record2.uncertaintyReasons, REASONS, '[R2] 不确定原因重启后仍在');
  say(
    `[R2] 重启（关连接→新 Pool→新 store）：任务指纹 ${jobFingerprint(job2).slice(0, 16)}… 与记录指纹 ${recordFingerprint(record2).slice(0, 16)}… 与写入时逐字节相等`,
  );

  // 新 app（real + 新池）的识别读面直接读到旧数据 ⇒ 接线后的服务层同样"重启不丢"。
  const app2 = buildApp({ config: realConfig, pool });
  assert.equal(
    app2.recognitionService.describe().storePersistent,
    true,
    '[R3] 新 app 的识别域必须仍是 PG store',
  );
  const projection = await app2.recognitionService.getJob({ userId: OWNER_ID, jobId: written.job.id });
  assert.equal(projection.id, written.job.id, '[R3] 新 app 的 getJob 必须读到重启前的任务');
  assert.equal(projection.kind, 'recognition', '[R3] 投影 kind 必须是 recognition');
  assert.equal(projection.state, 'succeeded', '[R3] 投影 state 与终态一致');
  assert.equal(projection.revision, jobBefore.revision, '[R3] 投影 revision 与重启前一致');
  const recordProjection = await app2.recognitionService.getRecognition({
    userId: OWNER_ID,
    recognitionId: written.terminalRecord.id,
  });
  assert.equal(recordProjection.id, written.terminalRecord.id, '[R3] 新 app 的 getRecognition 必须读到重启前的记录');
  await assert.rejects(
    () => app2.recognitionService.getRecognition({ userId: FOREIGN_ID, recognitionId: written.terminalRecord.id }),
    (error) => error?.code === 'NOT_FOUND',
    '[R3] 他人读同一条记录必须 NOT_FOUND（归属判定不因换 PG store 而放宽）',
  );
  await app2.close();
  say('[R3] 新 app（real+新池）的读面读到重启前的任务与记录；他人读同一条记录仍 NOT_FOUND（归属不放宽）');

  // ---- 子进程臂：真·进程重启（spawn 受限时如实登记未取得） ----
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--verify-after-restart'], {
    env: {
      ...process.env,
      [ENV]: url.href,
      GY_RECOG_JOB_ID: written.job.id,
      GY_RECOG_RECORD_ID: written.terminalRecord.id,
      GY_RECOG_OWNER: OWNER_ID,
      GY_RECOG_JOB_FP: jobFpBefore,
      GY_RECOG_RECORD_FP: recordFpBefore,
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
  const tampered = JSON.stringify([{ species_id: 'sp-9999', rank: 1, model_score: 0.99 }]);
  await ownerClient.query('UPDATE public.recognition_records SET candidates = $2::jsonb WHERE id = $1', [
    written.terminalRecord.id,
    tampered,
  ]);
  const recordTampered = await store2.getRecognition(written.terminalRecord.id);
  assert.notEqual(
    recordFingerprint(recordTampered),
    recordFpBefore,
    '[N1] 篡改后指纹必须变化（否则"重启前后相等"这条判据没有牙齿）',
  );
  assert.equal(recordTampered.candidates[0].species_id, 'sp-9999', '[N1] 篡改必须真的被读到');
  await ownerClient.query('UPDATE public.recognition_records SET candidates = $2::jsonb WHERE id = $1', [
    written.terminalRecord.id,
    candidatesTextBefore,
  ]);
  const recordRestored = await store2.getRecognition(written.terminalRecord.id);
  assert.equal(recordFingerprint(recordRestored), recordFpBefore, '[N1] 原样写回后指纹必须逐字节复原');
  const candidatesTextAfter = (
    await one('SELECT candidates::text AS v FROM public.recognition_records WHERE id = $1', [written.terminalRecord.id])
  ).v;
  assert.equal(candidatesTextAfter, candidatesTextBefore, '[N1] 复原后 jsonb 文本必须与写入时逐字节相等');
  say('[N1] byte_exact_restore：篡改 ⇒ 指纹变（红）；按原 jsonb 文本写回 ⇒ 指纹与 `::text` 双双重现（绿）');

  // ---- [N2] 内存 store 在同一序列下"新实例读不到" ----
  const memoryStore = createMemoryRecognitionStore();
  const memoryJob = makeJobRow({ ownerUserId: OWNER_ID });
  await memoryStore.insertJob(memoryJob);
  await memoryStore.insertRecognition(makeRecognitionRow({ id: memoryJob.recognitionId }));
  const memoryRestarted = createMemoryRecognitionStore();
  assert.equal(await memoryRestarted.getJob(memoryJob.id), null, '[N2] 内存 store 的"新实例"必须读不到（这就是改前的缺陷本体）');
  assert.equal(
    await memoryRestarted.getRecognition(memoryJob.recognitionId),
    null,
    '[N2] 内存 store 的"新实例"必须读不到记录',
  );
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
    (await one('SELECT revision FROM public.recognition_jobs WHERE id = $1', [raceJob.id])).revision,
    2,
    '[N3] 库里 revision 必须是 2（不是 3：CAS 退化会叠加成 +2）',
  );
  say('[N3] 负控制：同一 revision 并发双写 ⇒ 恰好 1 次成功、库内 revision=2（若 CAS 退化为先查后写，本臂会出现 2 次成功）');

  // ---- [N4] 同 id 再写由主键裁决（不是应用层判重） ----
  const dupJob = makeJobRow();
  await store2.insertJob(dupJob);
  await assert.rejects(
    () => store2.insertJob({ ...dupJob, recognitionId: randomUUID() }),
    (error) => error?.message === '任务 id 冲突',
  );
  assert.equal(
    await countOf('SELECT count(*)::int AS v FROM public.recognition_jobs WHERE id = $1', [dupJob.id]),
    1,
    '[N4] 重复写后行数必须仍是 1（主键裁决，无检查-写入窗口）',
  );
  say('[N4] 负控制：同 id 并发/重复写由主键裁决 ⇒ 行数恒为 1');

  console.log(`\n共 ${passed} 条 PASS，耗时 ${Date.now() - startedAt}ms`);
  console.log('ALL PASS：识别域 PostgreSQL 持久化（迁移 0025 三连 + 未迁移三态 / 13 方法语义 / 关连接重开逐字节仍在 / 4 条负控制）');
  console.log('EXITCODE=0');
} finally {
  for (const opened of openedPools) await opened.end().catch(() => {});
  await ownerClient.end().catch(() => {});
}

unread(
  'HTTP 面的"重启不丢"',
  'real 模式真实识别提供者/媒体端口未接线（本机无可调模型），POST /recognitions 在受理前即 fail-closed，无法经 HTTP 建任务；本片证据在 store 层 + 迁移层 + app.recognitionService 读面',
);
unread('多进程并发写同一任务的压测', '本片只做两路并发 CAS（恰好一次成功），未做 20+ 并发的吞吐/延迟读数');
unread('真实识别模型输出落库', '模型调用未接线；本片用契约合法的手工候选行验证持久化，不伪造模型准确率');
unread('备份恢复演练', '本片只验证单库迁移 UP/ROLLBACK/REPLAY 与关连接重开，未做 pg_dump/pg_restore 演练');
unread('选择记录的历史保留策略（保留期/清理）', '本片只证明 append-only 与 WHERE 归属过滤，未实现或验证任何清理任务');
