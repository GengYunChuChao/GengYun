/**
 * GY-R71 · 统一作业台账 `public.jobs` 的**真库**证据（PostgreSQL 17 + 真实迁移链 + 一次作业生命周期）。
 *
 * 本脚本只讲四件事，逐条给读数：
 *   [M] **一条真实迁移链**：空库起步 ⇒ 按 `services/api/src/db/migrate.ts` 的 `discoverMigrations`
 *       顺序把 `services/api/db/migrations/*.sql` 全部执行（48 条）⇒ `public.jobs` 与三张域内作业表
 *       都在。⛔ 不从迁移里"挑一条"跑：台账的列（`job_state` 枚举、`users.auth_epoch`、`jobs_single_actor`）
 *       分布在 0001 的多处，挑着跑等于自己造一个不会失败的夹具。
 *   [L] **一次作业生命周期**：`createPostgresOcrStore` 的 `insertJob`（queued）⇒ `updateJob`（running）
 *       ⇒ `commitTerminal`（succeeded）三步，每一步后回读 `public.jobs`，逐列断言
 *       （id / owner_id / kind / target_type / target_id / entity_revision / input_hash / auth_epoch /
 *       state / revision / deadline_at / error_code / result_ref / created_at / updated_at）。
 *   [I] **幂等**：同一终态行再写一次 ⇒ 行数不变、`revision` 不变、`updated_at` 不变（同态守卫）；
 *       同一 id 换个 state 再写 ⇒ 仍然只有一行（`ON CONFLICT (id)`）。
 *   [A] **answer 源**：会话 + 轮次走真实 `createPostgresConversationStore`，台账行必须是
 *       `kind='answer'`、`target_type='conversation_turn'`、`target_id=` 轮次 id、主键 = `job_id`。
 *   [C] **取消**：管理台的 `createPostgresAdminJobPort().cancel` 在**同一事务**里写台账 ⇒
 *       `state='cancelled'`、`revision` +1。
 *   [T] **单事务（本片的核心不变量）**：给 `public.jobs` 挂一个 `BEFORE INSERT` 触发器让它必失败，
 *       再跑 `insertJob` ⇒ 抛错 **且** `ocr_jobs` 里没有那一行（台账失败必须把源表一起回滚）。
 *       反向：`commitTerminal` 写重复记录 id ⇒ 抛错 **且** 台账仍停在上一个状态。⛔ 这条是
 *       「台账写在事务外」的唯一行为判据 —— 补写式的实现会在这里留下源表行。
 *
 * 运行（专用测试库必须是**空库**；脚本先断言 public 下 0 张表）：
 *   createdb -h 127.0.0.1 -p <port> gengyun_jobs_ledger_test
 *   JOBS_LEDGER_PG_TEST_URL=postgres://postgres@127.0.0.1:<port>/gengyun_jobs_ledger_test \
 *     node tests/integration/jobs-ledger-pg.mjs
 *
 * 未设置 `JOBS_LEDGER_PG_TEST_URL` ⇒ 打印 `SKIP` 并以 **77** 退出（POSIX「skipped」）：本次运行
 * **没有**验证真库（不是通过）。本机明知无真库、只想看跳过原因时可显式加 `--allow-skip`
 * （或 `GY_ALLOW_SKIP=1`）取 0 —— ⛔ 不得用于门禁。
 * 为什么门是 `JOBS_LEDGER_PG_TEST_URL` 而不是 `GY_PG_BIN`：`GY_PG_BIN` 那一组脚本的条数被
 * `tests/unit/ai-ops-ledger-pins.test.mjs` 的钉子⑤**冻结**（15 个），本脚本与 `ocr-jobs-pg.mjs`
 * 一样按**专用库 URL** 取门，不去动那份冻结清单。
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { createPostgresOcrStore } from '../../services/api/src/ocr/store-pg.ts';
import { createPostgresRecognitionStore } from '../../services/api/src/recognitions/store-pg.ts';
import { createPostgresConversationStore } from '../../services/api/src/conversations/store-pg.ts';
import { DEFAULT_MIGRATIONS_DIR, discoverMigrations } from '../../services/api/src/db/migrate.ts';
import { ledgerParams, ledgerRowFromDomainJob, writeJobLedger } from '../../services/api/src/jobs/ledger.ts';

const ENV = 'JOBS_LEDGER_PG_TEST_URL';
const DB = 'gengyun_jobs_ledger_test';

const rawUrl = process.env[ENV];
const ALLOW_SKIP = process.argv.includes('--allow-skip') || process.env.GY_ALLOW_SKIP === '1';
if (rawUrl === undefined || rawUrl.trim() === '') {
  console.log(`SKIP real PG17: ${ENV} 未设置 —— 本次运行没有验证台账的真库写入（不是通过，也不是失败）。`);
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

const MIGRATIONS_DIR = fileURLToPath(new URL('../../services/api/db/migrations/', import.meta.url));
const pool = new pg.Pool({ connectionString: rawUrl, max: 4 });

let passed = 0;
const say = (message) => {
  passed += 1;
  console.log(`PASS ${passed}: ${message}`);
};

const one = async (text, values = []) => (await pool.query(text, values)).rows[0];
const many = async (text, values = []) => (await pool.query(text, values)).rows;

/** 台账行的**全列**读数（15 列，逐列比对；⛔ 只查 state 会漏掉"字段写错"一整类缺陷）。 */
const LEDGER_COLUMNS =
  'id, owner_id, actor_admin_id, kind, target_type, target_id, entity_revision, input_hash, auth_epoch, '
  + 'state, revision, deadline_at, error_code, result_ref, created_at, updated_at';
const readLedger = async (id) => one(`SELECT ${LEDGER_COLUMNS} FROM public.jobs WHERE id = $1::uuid`, [id]);
const countLedger = async () => Number((await one('SELECT count(*)::int AS n FROM public.jobs')).n);

try {
  // -------------------------------------------------------------------------
  // [M] 迁移链
  // -------------------------------------------------------------------------
  const preexisting = Number(
    (await one(
      "SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'",
    )).n,
  );
  assert.equal(preexisting, 0, `专用测试库必须是空库（public 下已存在 ${preexisting} 个关系）：脚本要自己跑迁移链`);
  say('空库起步：public 下 0 个关系，迁移链由本脚本自己跑');

  const migrations = discoverMigrations(DEFAULT_MIGRATIONS_DIR);
  assert.ok(migrations.length >= 40, `迁移链太短（${migrations.length} 条）：目录读取或编号派生坏了`);
  const client = await pool.connect();
  try {
    for (const migration of migrations) {
      const sql = readFileSync(join(MIGRATIONS_DIR, migration.filename), 'utf8');
      await client.query(sql);
    }
  } finally {
    client.release();
  }
  const after = await one(
    "SELECT to_regclass('public.jobs') AS jobs, to_regclass('public.ocr_jobs') AS ocr_jobs,"
    + " to_regclass('public.recognition_jobs') AS recognition_jobs, to_regclass('public.speech_jobs') AS speech_jobs",
  );
  assert.equal(after.jobs, 'jobs');
  assert.equal(after.ocr_jobs, 'ocr_jobs');
  assert.equal(after.recognition_jobs, 'recognition_jobs');
  assert.equal(after.speech_jobs, 'speech_jobs');
  say(`真实迁移链 ${migrations.length} 条全部执行成功；public.jobs 与三张域内作业表都在（max=${migrations[migrations.length - 1].version}）`);

  const stateColumnType = await one(
    "SELECT format_type(a.atttypid, a.atttypmod) AS t FROM pg_attribute a WHERE a.attrelid = 'public.jobs'::regclass AND a.attname = 'state'",
  );
  assert.equal(stateColumnType.t, 'job_state', `public.jobs.state 必须是 job_state 枚举，实际 ${stateColumnType.t}`);
  say('public.jobs.state 的列类型是 job_state 枚举（与契约 JobState 同一闭集）');

  // -------------------------------------------------------------------------
  // [L] 作业生命周期：queued → running → succeeded
  // -------------------------------------------------------------------------
  const ownerId = randomUUID();
  await pool.query('INSERT INTO users (id, auth_epoch) VALUES ($1::uuid, 7)', [ownerId]);
  const store = createPostgresOcrStore({ pool });

  const jobId = randomUUID();
  const ocrId = randomUUID();
  const mediaId = randomUUID();
  const now = new Date('2026-10-30T01:00:00.000Z');
  const deadline = new Date('2026-10-30T01:00:30.000Z');
  const job = {
    id: jobId,
    revision: 1,
    kind: 'ocr',
    ownerUserId: ownerId,
    ocrId,
    mediaId,
    mediaRevision: 4,
    state: 'queued',
    deadlineAt: deadline,
    createdAt: now,
    updatedAt: now,
    errorCode: null,
  };

  await store.insertJob(job);
  const created = await readLedger(jobId);
  assert.notEqual(created, undefined, 'insertJob 之后 public.jobs 必须有那一行（台账写在事务外的实现会在这里就失败）');
  assert.equal(created.id, jobId);
  assert.equal(created.owner_id, ownerId);
  assert.equal(created.actor_admin_id, null, '用户作业的 actor_admin_id 必须是 NULL（jobs_single_actor 要求 owner/admin 恰一）');
  assert.equal(created.kind, 'ocr');
  assert.equal(created.target_type, 'media');
  assert.equal(created.target_id, mediaId);
  assert.equal(created.entity_revision, 4);
  assert.equal(String(created.input_hash).length, 64);
  assert.equal(String(created.input_hash), ledgerParams(ledgerRowFromDomainJob('ocr', job, ocrId))[6], 'input_hash 必须与映射函数同值（同一口径）');
  assert.equal(Number(created.auth_epoch), 7, 'auth_epoch 必须取 users 的真值（不是哨兵 1）');
  assert.equal(created.state, 'queued');
  assert.equal(Number(created.revision), 1);
  assert.equal(created.deadline_at.toISOString(), deadline.toISOString());
  assert.equal(created.error_code, null);
  assert.equal(created.result_ref, ocrId, 'result_ref 是域内预分配的产出行 id（ocr_jobs.ocr_id NOT NULL）');
  assert.equal(created.created_at.toISOString(), now.toISOString());
  assert.equal(created.updated_at.toISOString(), now.toISOString());
  assert.equal(await countLedger(), 1);
  say('queued：台账 16 列逐列对上（owner/kind/target=media@4/input_hash 64 位/auth_epoch=users 真值 7/state/revision=1/result_ref=ocr_id）');

  const running = await store.updateJob(jobId, 1, (row) => ({
    ...row,
    revision: row.revision + 1,
    state: 'running',
    updatedAt: new Date('2026-10-30T01:00:10.000Z'),
  }));
  assert.equal(running.state, 'running');
  const afterRunning = await readLedger(jobId);
  assert.equal(afterRunning.state, 'running');
  assert.equal(Number(afterRunning.revision), 2);
  assert.equal(await countLedger(), 1, '状态迁移不得新增台账行（同一 job_id 只有一行）');
  say('running：台账 state=revision 同步迁移到 2，行数仍 1');

  const committed = await store.commitTerminal(
    jobId,
    running.revision,
    { state: 'succeeded', errorCode: null },
    {
      id: ocrId,
      revision: 1,
      ownerUserId: ownerId,
      mediaId,
      mediaRevision: 4,
      rawFields: {},
      correctedFields: {},
      verification: {},
      modelVersion: 'jobs-ledger-pg',
      createdAt: new Date('2026-10-30T01:00:20.000Z'),
      updatedAt: new Date('2026-10-30T01:00:20.000Z'),
      deleted: false,
    },
    new Date('2026-10-30T01:00:20.000Z'),
  );
  assert.equal(committed.state, 'succeeded');
  const afterTerminal = await readLedger(jobId);
  assert.equal(afterTerminal.state, 'succeeded');
  assert.equal(Number(afterTerminal.revision), 3);
  assert.equal(afterTerminal.error_code, null);
  assert.equal(afterTerminal.result_ref, ocrId);
  assert.equal(await countLedger(), 1);
  say('succeeded：台账 state=succeeded / revision=3 / result_ref 指向产出行，行数仍 1');

  // -------------------------------------------------------------------------
  // [I] 幂等
  // -------------------------------------------------------------------------
  const terminalSnapshot = await readLedger(jobId);
  const replayClient = await pool.connect();
  try {
    await replayClient.query('BEGIN');
    await writeJobLedger(
      replayClient,
      ledgerRowFromDomainJob('ocr', { ...job, state: 'succeeded', revision: 3 }, ocrId),
    );
    await replayClient.query('COMMIT');
  } finally {
    replayClient.release();
  }
  const afterReplay = await readLedger(jobId);
  assert.equal(await countLedger(), 1, '同态重放不得新增台账行');
  assert.equal(Number(afterReplay.revision), 3, '同态重放不得改动 revision');
  assert.equal(afterReplay.updated_at.toISOString(), terminalSnapshot.updated_at.toISOString(), '同态重放必须严格 no-op（updated_at 都不许动）');
  say('幂等（同态）：同一终态再写一次 ⇒ 行数 1、revision 不变、updated_at 逐字不变（WHERE … IS DISTINCT FROM 生效）');

  // 同一 id 换 state ⇒ 仍只有一行（ON CONFLICT (id) 的 upsert，而不是"再插一行"）。
  const bumpClient = await pool.connect();
  try {
    await bumpClient.query('BEGIN');
    await writeJobLedger(
      bumpClient,
      ledgerRowFromDomainJob('ocr', { ...job, state: 'failed', revision: 4 }, ocrId),
    );
    await bumpClient.query('COMMIT');
  } finally {
    bumpClient.release();
  }
  const afterFail = await readLedger(jobId);
  assert.equal(afterFail.state, 'failed');
  assert.equal(Number(afterFail.revision), 4);
  assert.equal(await countLedger(), 1, '同一 job_id 换状态仍必须是**一行**（ON CONFLICT 而不是再插一行）');
  say('幂等（异态）：同一 job_id 迁移到 failed ⇒ 仍是 1 行、state/revision 就地更新');

  // -------------------------------------------------------------------------
  // [A] answer 源（会话 + 轮次走真实 store）
  // -------------------------------------------------------------------------
  const conversations = createPostgresConversationStore(pool);
  const conversationId = randomUUID();
  await conversations.insertConversation({
    id: conversationId,
    owner_id: ownerId,
    revision: 1,
    conditions: null,
    created_at: now,
    updated_at: now,
  });
  const turnId = randomUUID();
  const answerJobId = randomUUID();
  const turn = await conversations.insertTurn({
    id: turnId,
    conversation_id: conversationId,
    owner_id: ownerId,
    input_text: '玉米叶片发黄是什么原因？',
    transcription_ref: null,
    job_id: answerJobId,
    job_state: 'queued',
    job_deadline_at: deadline,
    job_created_at: now,
    job_error_code: null,
    created_at: now,
  });
  assert.equal(turn.job_state, 'queued');
  const answerRow = await readLedger(answerJobId);
  assert.notEqual(answerRow, undefined, 'insertTurn 之后必须有一行 answer 台账（主键是 job_id）');
  assert.equal(answerRow.id, answerJobId, 'answer 的台账主键是 job_id，不是轮次 id');
  assert.equal(answerRow.kind, 'answer');
  assert.equal(answerRow.target_type, 'conversation_turn');
  assert.equal(answerRow.target_id, turnId);
  assert.equal(answerRow.entity_revision, 1);
  assert.equal(answerRow.state, 'queued');
  assert.equal(answerRow.result_ref, null, '还没有回答行时 result_ref 必须是 NULL（不占位）');
  const claimed = await conversations.claimTurnJob(turnId, ownerId);
  assert.equal(claimed.job_state, 'running');
  const answerRunning = await readLedger(answerJobId);
  assert.equal(answerRunning.state, 'running');
  assert.equal(Number(answerRunning.revision), 2);
  say('answer：queued → running 两次迁移都落到同一行（kind=answer / target=conversation_turn:<turn> / result_ref 先 NULL）');

  // -------------------------------------------------------------------------
  // [C] 取消
  // -------------------------------------------------------------------------
  // ⚠ 这里走的是**用户面**取消（`updateJob` 把行推进到 `cancelled`），不是管理台的
  // `admin/ops/jobs-pg.ts` 取消面：后者要在同一事务里调 `record_admin_job_cancel_audit(...)`，
  // 而那个函数要求"真实存在且 active、且当前持 `jobs:cancel` 的后台账号"——造这套夹具等价于
  // 起半个 app（`tests/integration/admin-jobs-pg.mjs` 就是走 HTTP 建的）。本脚本不重复造它；
  // 管理台取消那一个写点的证据是：单测假池（tests/unit/admin-jobs-list-filter.test.mjs 的取消面
  // 用例，台账语句被识别并回"写成功"）+ 静态接线钉子（tests/unit/jobs-ledger-mapping.test.mjs）。
  // ⛔ 这条边界写在证据页的「没证明什么」里，不当成已验。
  const recognitionStore = createPostgresRecognitionStore({ pool });
  const cancelJobId = randomUUID();
  await recognitionStore.insertJob({
    id: cancelJobId,
    revision: 1,
    kind: 'recognition',
    ownerUserId: ownerId,
    recognitionId: randomUUID(),
    mediaId: randomUUID(),
    mediaRevision: 2,
    state: 'queued',
    deadlineAt: deadline,
    createdAt: now,
    updatedAt: now,
    errorCode: null,
  });
  const cancelledRow = await recognitionStore.updateJob(cancelJobId, 1, (row) => ({
    ...row,
    revision: row.revision + 1,
    state: 'cancelled',
    updatedAt: new Date('2026-10-30T01:00:05.000Z'),
  }));
  assert.equal(cancelledRow.state, 'cancelled');
  const cancelled = await readLedger(cancelJobId);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(Number(cancelled.revision), 2);
  assert.equal(cancelled.kind, 'recognition');
  assert.equal(cancelled.error_code, null, '取消不是失败：error_code 必须留空');
  say('取消（用户面）：recognition 作业 queued→cancelled 落到台账（state=cancelled / revision=2 / kind=recognition）');

  // -------------------------------------------------------------------------
  // [T] 单事务不变量
  // -------------------------------------------------------------------------
  await pool.query(
    `CREATE OR REPLACE FUNCTION public.r71_reject_jobs() RETURNS trigger AS $$
     BEGIN RAISE EXCEPTION 'r71-negative-control: jobs insert refused'; END; $$ LANGUAGE plpgsql`,
  );
  await pool.query('CREATE TRIGGER r71_reject_jobs BEFORE INSERT ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.r71_reject_jobs()');
  const blockedJobId = randomUUID();
  const beforeOcr = Number((await one('SELECT count(*)::int AS n FROM public.ocr_jobs')).n);
  await assert.rejects(
    () => store.insertJob({ ...job, id: blockedJobId, ocrId: randomUUID(), state: 'queued', revision: 1 }),
    (error) => {
      // 触发器抛的 55000 会被 `classifyOcrDatabaseError` 折成契约错误 —— 这是**对的**（写类故障不得
      // 静默成功）。所以这里只判"真的抛了"，事务性由下面两行真库读数裁决。
      const code = error?.code;
      return error instanceof Error && (code === 'PROVIDER_UNAVAILABLE' || /r71-negative-control/.test(error.message));
    },
    '台账写不进去时 insertJob 必须抛错（⛔ 不许吞掉）',
  );
  const afterOcr = Number((await one('SELECT count(*)::int AS n FROM public.ocr_jobs')).n);
  assert.equal(afterOcr, beforeOcr, '台账写失败时 ocr_jobs **不得**留下那一行：两笔必须同一个事务（台账写在事务外会在这里留行）');
  assert.equal(await readLedger(blockedJobId), undefined, '台账写失败时也不得有半行');
  await pool.query('DROP TRIGGER r71_reject_jobs ON public.jobs');
  await pool.query('DROP FUNCTION public.r71_reject_jobs()');
  say('单事务（正向）：给 public.jobs 挂拒绝触发器后 insertJob 抛错，且 ocr_jobs 行数不变 —— 台账失败把源表一起回滚');

  // 反向：源表写失败（重复记录 id）时，台账必须停在**上一状态**（不是先写台账再写源表）。
  const conflictJobId = randomUUID();
  await store.insertJob({ ...job, id: conflictJobId, ocrId: randomUUID(), state: 'queued', revision: 1 });
  const conflictRunning = await store.updateJob(conflictJobId, 1, (row) => ({
    ...row,
    revision: row.revision + 1,
    state: 'running',
    updatedAt: new Date('2026-10-30T01:00:15.000Z'),
  }));
  assert.equal(conflictRunning.state, 'running');
  const beforeState = await readLedger(conflictJobId);
  await assert.rejects(
    () =>
      store.commitTerminal(
        conflictJobId,
        conflictRunning.revision,
        { state: 'succeeded', errorCode: null },
        {
          id: ocrId, // 已存在的记录 id ⇒ 唯一冲突（记录行与作业行在同一事务里）
          revision: 1,
          ownerUserId: ownerId,
          mediaId,
          mediaRevision: 4,
          rawFields: {},
          correctedFields: {},
          verification: {},
          modelVersion: 'jobs-ledger-pg',
          createdAt: now,
          updatedAt: now,
          deleted: false,
        },
        new Date('2026-10-30T01:00:40.000Z'),
      ),
    /冲突|conflict|duplicate/i,
  );
  const afterState = await readLedger(conflictJobId);
  assert.equal(afterState.state, beforeState.state, '源表写失败时台账不得前移（台账先写会在这里露出）');
  assert.equal(Number(afterState.revision), Number(beforeState.revision));
  say('单事务（反向）：终态事务里记录行冲突 ⇒ 整笔回滚，台账仍停在 running / revision=2');

  // -------------------------------------------------------------------------
  // [N] 计数总账
  // -------------------------------------------------------------------------
  const total = await countLedger();
  assert.equal(total, 4, `台账应恰有 4 行（ocr 作业 2 + answer 作业 1 + recognition 作业 1），实际 ${total}`);
  say('计数总账：public.jobs 恰 4 行（两个 ocr + 一个 answer + 一个 recognition，无孤儿行）');

  console.log(`\nSUMMARY: ${passed} 项实测通过（真库 ${DB}）；台账总行数 ${total}`);
} finally {
  await pool.end();
}
