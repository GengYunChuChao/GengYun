// GY-R72（w37）：**取消**也是终态迁移 ⇒ `public.jobs` 必须同事务落 `cancelled`。
//
// 派单 §0 的缺陷：`services/api/src/conversations/store-pg.ts` 有四个改作业状态的写点，其中
// `insertTurn` / `claimTurnJob` / `settleTurnJob` 三处与台账同事务，只有 `cancelTurnJob` 是裸
// `pool.query`（无事务、不写台账）⇒ 取消之后 `public.jobs` 永远停在 `queued`/`running`。
// 本文件用内存 PostgreSQL 引擎（PGlite 0.5.8，PostgreSQL 18.x 内核）逐条执行**真实迁移 SQL**
// 与 `store-pg.ts` 的真实实现，钉住"取消与台账同一事务"这件事的四个面：
//   T1 取消后的轮次行与台账行逐列读数；T2 已结算后的取消是 no-op（不改台账）；
//   T3 台账写失败 ⇒ 整个取消事务回滚（不留半截）；T4 与 `settleTurnJob` 的四格映射同形；
//   T5 源码静态钉子；T6 读面回归与二次取消的幂等性。
//
// 如实标注（同 `tests/unit/conversation-store-pg.test.mjs` 头注）：这只证明 SQL 语义与该 store 的
// 事务边界，**不**构成目标 PostgreSQL 17.11 的真实实例验收；真库臂 `tests/integration/conversations-pg.mjs`
// 需要真实 DATABASE_URL，不在本片门禁里。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';

import { createPostgresConversationStore } from '../../services/api/src/conversations/store-pg.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const migrationsDir = resolve(root, 'services/api/db/migrations');
const storePgPath = resolve(root, 'services/api/src/conversations/store-pg.ts');

function migrationSql(name) {
  return readFileSync(resolve(migrationsDir, name), 'utf8');
}

/** 把 PGlite 包成 store 需要的 `TransactionalPool`（⚠ 单连接：用例内顺序执行，无并发）。 */
function poolOf(db) {
  const runner = { query: (text, values) => db.query(text, values) };
  return { query: runner.query, connect: async () => ({ query: runner.query, release: () => {} }) };
}

/** 建带 `users` 的库并应用到 0013（会话域自己的迁移）。 */
async function migratedDatabase() {
  const db = new PGlite();
  await db.exec(migrationSql('0001_initial_schema.sql'));
  await db.exec(migrationSql('0013_conversations.sql'));
  const owner = await db.query('INSERT INTO users DEFAULT VALUES RETURNING id');
  const other = await db.query('INSERT INTO users DEFAULT VALUES RETURNING id');
  return { db, ownerId: String(owner.rows[0].id), otherId: String(other.rows[0].id) };
}

const AT = new Date('2026-10-14T06:00:00.000Z');
const UUID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function conversationRecord(ownerId, n, options = {}) {
  return {
    id: UUID(n),
    revision: options.revision ?? 1,
    owner_id: ownerId,
    conditions: options.conditions ?? null,
    created_at: options.created_at ?? AT,
    updated_at: options.updated_at ?? AT,
  };
}

function turnRecord(ownerId, conversationId, n, options = {}) {
  return {
    id: UUID(1000 + n),
    revision: options.revision ?? 1,
    conversation_id: conversationId,
    owner_id: ownerId,
    input_text: options.input_text ?? `合成提问 ${n}（测试替身）`,
    transcription_ref: options.transcription_ref ?? null,
    job_id: UUID(2000 + n),
    job_state: options.job_state ?? 'queued',
    job_deadline_at: options.job_deadline_at ?? new Date(AT.getTime() + 30_000),
    job_created_at: options.job_created_at ?? AT,
    job_error_code: options.job_error_code ?? null,
    answer_id: null,
    created_at: options.created_at ?? AT,
    updated_at: options.updated_at ?? AT,
  };
}

function answerRecord(ownerId, turnId, n, options = {}) {
  return {
    id: UUID(3000 + n),
    revision: 1,
    turn_id: turnId,
    owner_id: ownerId,
    status: options.status ?? 'insufficient',
    checked_text: options.checked_text ?? '资料不足：本次未取得任何可核对依据，不提供结论与用量。',
    check_state: options.check_state ?? 'passed',
    citations: options.citations ?? [],
    dose_cards: options.dose_cards ?? [],
    model_version: options.model_version ?? 'unimplemented:no-real-model/text-qa-deterministic',
    prompt_version: options.prompt_version ?? 'unimplemented:no-real-prompt/citation-guard-only',
    rule_version: options.rule_version ?? 'unimplemented:no-real-rule/citation-guard+test',
    created_at: AT,
    updated_at: AT,
  };
}

/** 台账行逐列读取（`state` 转 text 以免枚举类型参与严格相等时的歧义）。 */
const LEDGER_COLUMNS = `id, owner_id, kind, target_type, target_id, entity_revision,
       state::text AS state, revision, input_hash, auth_epoch, consent_epoch, deadline_at,
       attempt, retry_of, provider_config_version, error_code, result_ref, created_at, updated_at`;

async function ledgerRows(db, jobId) {
  const result = await db.query(
    `SELECT ${LEDGER_COLUMNS} FROM public.jobs WHERE id = $1::uuid`,
    [jobId],
  );
  return result.rows;
}

/** 台账行里"会随状态迁移变"的四格 ↔ 轮次行里对应的四格（T4 的同形性判据）。 */
const ledgerFour = (row) => ({
  state: row.state,
  revision: row.revision,
  errorCode: row.error_code,
  resultRef: row.result_ref,
});
const turnFour = (turn) => ({
  state: turn.job_state,
  revision: turn.revision,
  errorCode: turn.job_error_code,
  resultRef: turn.answer_id,
});

test('T1 取消：轮次落 cancelled/revision 3/error_code 空，public.jobs 同事务落 cancelled（恰 1 行）', async () => {
  const { db, ownerId } = await migratedDatabase();
  const store = createPostgresConversationStore(poolOf(db));
  const conversation = await store.insertConversation(conversationRecord(ownerId, 1));
  const turn = await store.insertTurn(turnRecord(ownerId, conversation.id, 1));

  const claimed = await store.claimTurnJob(turn.id, ownerId);
  assert.equal(claimed.job_state, 'running');
  assert.equal(claimed.revision, 2);

  const cancelled = await store.cancelTurnJob(turn.id, ownerId);
  assert.notEqual(cancelled, null, 'queued/running 的轮次必须能被取消');
  assert.equal(cancelled.job_state, 'cancelled');
  assert.equal(cancelled.job_error_code, null, 'cancelled 不带错误码（与 DDL 的对偶约束一致）');
  assert.equal(cancelled.revision, 3, '取消是状态迁移 ⇒ revision 必须递增（强 ETag 跟着走）');

  const rows = await ledgerRows(db, turn.job_id);
  assert.equal(rows.length, 1, 'public.jobs 里该作业必须恰 1 行（upsert 不得留下两行）');
  const row = rows[0];
  console.log(`[cancel-ledger-T1] ${JSON.stringify({
    id: row.id,
    owner_id: row.owner_id,
    kind: row.kind,
    target_type: row.target_type,
    target_id: row.target_id,
    entity_revision: Number(row.entity_revision),
    state: row.state,
    revision: Number(row.revision),
    error_code: row.error_code,
    result_ref: row.result_ref,
    auth_epoch: Number(row.auth_epoch),
    consent_epoch: Number(row.consent_epoch),
    attempt: Number(row.attempt),
    deadline_at: row.deadline_at instanceof Date ? row.deadline_at.toISOString() : String(row.deadline_at),
    input_hash: String(row.input_hash),
  })}`);

  // ---- 台账行的身份列：三个 id 各就各位（作业 id / 轮次 id / 回答 id）----
  assert.equal(row.id, turn.job_id, '台账主键是**作业 id**（GET /jobs/{id} 认的那个）');
  assert.equal(row.owner_id, ownerId);
  assert.equal(row.kind, 'answer');
  assert.equal(row.target_type, 'conversation_turn');
  assert.equal(row.target_id, turn.id, '目标对象是**轮次**，不是作业、也不是回答');
  // `entity_revision` 是**作业身份**的一部分（`JOB_LEDGER_UPSERT_SQL` 的 `DO UPDATE` 只改
  // state/revision/error_code/result_ref/updated_at 五列，冲突时不碰它）⇒ 它停在创建时的 1，
  // 跟着状态迁移前进的是 `revision` 列。这条断言把"哪一列会动"钉死，免得下一个人误读。
  assert.equal(Number(row.entity_revision), 1, 'entity_revision 停在创建时的快照（upsert 只改五列）');
  assert.equal(Number(row.revision), 3, '跟着状态迁移前进的是 revision 列');
  assert.match(String(row.input_hash), /^[0-9a-f]{64}$/);
  assert.ok(Number(row.auth_epoch) >= 1);
  assert.notEqual(row.deadline_at, null);
  assert.notEqual(row.created_at, null);
  assert.notEqual(row.updated_at, null);

  // ---- 本片的判据：四格落 cancelled ----
  assert.equal(row.state, 'cancelled', '取消之后台账必须落 cancelled（缺陷态是永远停在 running）');
  assert.equal(Number(row.revision), 3);
  assert.equal(row.error_code, null);
  assert.equal(row.result_ref, null);

  // SQL 侧同一读数（`IS NULL` 是判据原文的一部分，不用 JS 的 null 代替）。
  const nulls = await db.query(
    `SELECT count(*) AS n FROM public.jobs
      WHERE id = $1::uuid AND state = 'cancelled' AND error_code IS NULL AND result_ref IS NULL`,
    [turn.job_id],
  );
  assert.equal(Number(nulls.rows[0].n), 1, '`state = cancelled AND error_code IS NULL AND result_ref IS NULL` 必须命中 1 行');

  await db.close();
});

test('T2 已结算（failed）之后再取消：返回 null，且台账行一格都不动', async () => {
  const { db, ownerId } = await migratedDatabase();
  const store = createPostgresConversationStore(poolOf(db));
  const conversation = await store.insertConversation(conversationRecord(ownerId, 2));
  const turn = await store.insertTurn(turnRecord(ownerId, conversation.id, 2));

  await store.claimTurnJob(turn.id, ownerId);
  const settled = await store.settleTurnJob({
    turnId: turn.id,
    ownerId,
    state: 'failed',
    errorCode: 'PROVIDER_UNAVAILABLE',
    answer: null,
    at: AT,
  });
  assert.equal(settled.job_state, 'failed');
  assert.equal(settled.revision, 3);

  const before = await ledgerRows(db, turn.job_id);
  assert.equal(before.length, 1);
  assert.equal(before[0].state, 'failed');

  const cancelled = await store.cancelTurnJob(turn.id, ownerId);
  assert.equal(cancelled, null, '终态（failed）之后不得再取消 ⇒ 与"不存在"同形的 null');

  const after = await ledgerRows(db, turn.job_id);
  assert.equal(after.length, 1, '取消是 no-op ⇒ 台账行数不变');
  assert.deepEqual(
    { ...after[0] },
    { ...before[0] },
    '取消是 no-op ⇒ 台账行逐列不变（revision 不得再自增，state 不得被改成 cancelled）',
  );

  const row = await db.query(
    'SELECT job_state, job_error_code, revision FROM conversation_turns WHERE id = $1::uuid',
    [turn.id],
  );
  assert.equal(row.rows[0].job_state, 'failed', 'CAS 不命中 ⇒ 轮次行也不得被改');
  assert.equal(row.rows[0].job_error_code, 'PROVIDER_UNAVAILABLE');
  assert.equal(Number(row.rows[0].revision), 3);

  await db.close();
});

test('T3 事务性：台账表不可写时取消整体失败（轮次回滚到 running，台账没被推进到 cancelled）', async () => {
  const { db, ownerId } = await migratedDatabase();
  const store = createPostgresConversationStore(poolOf(db));
  const conversation = await store.insertConversation(conversationRecord(ownerId, 3));
  const turn = await store.insertTurn(turnRecord(ownerId, conversation.id, 3));
  await store.claimTurnJob(turn.id, ownerId);

  const before = await ledgerRows(db, turn.job_id);
  assert.equal(before.length, 1);
  assert.equal(before[0].state, 'running');

  // 让**台账**那一句必然写失败，且只让台账失败（轮次表照常可写）。
  // 若取消仍是"裸 pool.query + 事后补写"，这里不会有任何异常（或只有补写失败）⇒ 用例必红。
  await db.exec('ALTER TABLE public.jobs RENAME TO jobs_ledger_backup');
  let failure = null;
  try {
    await store.cancelTurnJob(turn.id, ownerId);
  } catch (error) {
    failure = error;
  }
  assert.notEqual(failure, null, '台账写不进去时，取消必须**整体失败**（不得先改轮次再补写台账）');
  console.log(`[cancel-ledger-T3] reject: ${String(failure && failure.message).split('\n')[0]}`);

  await db.exec('ALTER TABLE jobs_ledger_backup RENAME TO jobs');

  // 回滚证据 ①：轮次行仍是 running / revision 2（CAS UPDATE 被同一事务回滚了）。
  const row = await db.query(
    'SELECT job_state, job_error_code, revision FROM conversation_turns WHERE id = $1::uuid',
    [turn.id],
  );
  assert.equal(row.rows[0].job_state, 'running', '回滚证据：轮次行必须停在 running（没有被改成 cancelled）');
  assert.equal(row.rows[0].job_error_code, null);
  assert.equal(Number(row.rows[0].revision), 2, '回滚证据：revision 不得被推进到 3');

  // 回滚证据 ②：台账没有该作业的 cancelled 行，且既有那一行还原封不动。
  const cancelledRows = await db.query(
    `SELECT count(*) AS n FROM public.jobs WHERE id = $1::uuid AND state = 'cancelled'`,
    [turn.job_id],
  );
  assert.equal(Number(cancelledRows.rows[0].n), 0, '台账里不得出现 cancelled 行');
  const after = await ledgerRows(db, turn.job_id);
  assert.equal(after.length, 1);
  assert.deepEqual({ ...after[0] }, { ...before[0] }, '取消失败 ⇒ 台账行逐列不变');

  await db.close();
});

test('T4 与 settleTurnJob（终态）同形：state/revision/error_code/result_ref 四格都取自轮次行', async () => {
  const { db, ownerId } = await migratedDatabase();
  const store = createPostgresConversationStore(poolOf(db));
  const conversation = await store.insertConversation(conversationRecord(ownerId, 4));

  // ---- 臂 A：取消（cancelled，无回答）----
  const cancelTurn = await store.insertTurn(turnRecord(ownerId, conversation.id, 4));
  await store.claimTurnJob(cancelTurn.id, ownerId);
  const cancelled = await store.cancelTurnJob(cancelTurn.id, ownerId);
  const cancelLedger = (await ledgerRows(db, cancelTurn.job_id))[0];
  assert.deepEqual(
    ledgerFour(cancelLedger),
    turnFour(cancelled),
    '取消路径：台账四格必须逐格等于轮次行自身的四格（不得写固定值、不得写 CAS 之前的旧快照）',
  );
  assert.deepEqual(ledgerFour(cancelLedger), { state: 'cancelled', revision: 3, errorCode: null, resultRef: null });

  // ---- 臂 B：结算（failed，无回答）----
  const settleTurn = await store.insertTurn(turnRecord(ownerId, conversation.id, 5));
  await store.claimTurnJob(settleTurn.id, ownerId);
  const settled = await store.settleTurnJob({
    turnId: settleTurn.id,
    ownerId,
    state: 'failed',
    errorCode: 'PROVIDER_TIMEOUT',
    answer: null,
    at: AT,
  });
  const settleLedger = (await ledgerRows(db, settleTurn.job_id))[0];
  assert.deepEqual(
    ledgerFour(settleLedger),
    turnFour(settled),
    '结算路径同样逐格相等 —— 两条终态路径的映射规则必须一视同仁',
  );
  assert.deepEqual(ledgerFour(settleLedger), { state: 'failed', revision: 3, errorCode: 'PROVIDER_TIMEOUT', resultRef: null });

  // ---- 臂 C：结算（succeeded，带回答）⇒ 第四格 result_ref 必须跟上 ----
  const answerTurn = await store.insertTurn(turnRecord(ownerId, conversation.id, 6));
  await store.claimTurnJob(answerTurn.id, ownerId);
  const answer = answerRecord(ownerId, answerTurn.id, 6, { status: 'answered', checked_text: '合成回答正文（测试替身）' });
  const succeeded = await store.settleTurnJob({
    turnId: answerTurn.id,
    ownerId,
    state: 'succeeded',
    errorCode: null,
    answer,
    at: AT,
  });
  const answerLedger = (await ledgerRows(db, answerTurn.job_id))[0];
  assert.deepEqual(ledgerFour(answerLedger), turnFour(succeeded));
  assert.deepEqual(ledgerFour(answerLedger), { state: 'succeeded', revision: 3, errorCode: null, resultRef: answer.id });

  await db.close();
});

test('T5 静态钉子：cancelTurnJob 在 guarded 里写台账、不得再有裸 pool.query；SQL 常量在模块作用域', () => {
  const source = readFileSync(storePgPath, 'utf8');

  const start = source.indexOf('async cancelTurnJob(');
  assert.ok(start > 0, 'store-pg.ts 里找不到 `async cancelTurnJob(`');
  const end = source.indexOf('async settleTurnJob(', start);
  assert.ok(end > start, '找不到 cancelTurnJob 与 settleTurnJob 的边界');
  const body = source.slice(start, end);

  assert.ok(body.includes('return guarded(async (sql) => {'), '取消必须在 `guarded`（= withTransaction）里跑');
  assert.ok(
    body.includes('writeJobLedger(sql, ledgerRowFromTurn(turn))'),
    '取消必须在同一事务里写台账行，且行必须取自 CAS 之后的那一行（`ledgerRowFromTurn(turn)`）',
  );
  assert.equal(
    /pool\.query\(/.test(body),
    false,
    '取消函数里不得再出现裸 `pool.query(`：那是"绕开事务"的唯一入口，也是本片修的缺陷本体',
  );
  assert.ok(body.includes('await sql.query(CANCEL_TURN_JOB_SQL'), 'CAS 语句必须走事务连接（`sql.query`）');

  // 语句搬到模块作用域，但仍用 `TURN_COLUMNS` 插值（`sql-column-coverage` 要按列面判）。
  const declared = source.match(/const CANCEL_TURN_JOB_SQL = `[^`]*`/g) ?? [];
  assert.equal(declared.length, 1, 'CANCEL_TURN_JOB_SQL 必须**恰好**声明一次');
  assert.ok(declared[0].includes('RETURNING ${TURN_COLUMNS}'), '列清单仍走 TURN_COLUMNS 插值');
  assert.ok(declared[0].includes("job_state IN ('queued', 'running')"), 'CAS 谓词原文不得被改写');
  assert.ok(declared[0].includes("SET job_state = 'cancelled', job_error_code = NULL"));

  console.log(`[cancel-ledger-T5] 静态读数：裸 pool.query=0、writeJobLedger=1、CANCEL_TURN_JOB_SQL 声明=1`);
});

test('T6 读面回归：取消后 getTurn 仍读得到轮次（回答为 null）；二次取消返回 null 且台账 revision 不再自增', async () => {
  const { db, ownerId } = await migratedDatabase();
  const store = createPostgresConversationStore(poolOf(db));
  const conversation = await store.insertConversation(conversationRecord(ownerId, 7));
  const turn = await store.insertTurn(turnRecord(ownerId, conversation.id, 7));
  await store.claimTurnJob(turn.id, ownerId);
  const cancelled = await store.cancelTurnJob(turn.id, ownerId);
  assert.equal(cancelled.job_state, 'cancelled');

  const loaded = await store.getTurn(conversation.id, turn.id, ownerId);
  assert.notEqual(loaded, null, '取消不删记录：读面必须还看得见这条轮次');
  assert.equal(loaded.turn.job_state, 'cancelled');
  assert.equal(loaded.turn.revision, 3);
  assert.equal(loaded.answer, null, '取消不写回答（本片不碰回答面）');
  assert.equal(await store.findTurnByJobId(turn.job_id, ownerId).then((found) => found.turn.job_state), 'cancelled');

  const again = await store.cancelTurnJob(turn.id, ownerId);
  assert.equal(again, null, '已 cancelled 的轮次再取消 ⇒ null（幂等：状态谓词不再命中）');

  const rows = await ledgerRows(db, turn.job_id);
  assert.equal(rows.length, 1, '二次取消不得插出第二行台账');
  assert.equal(rows[0].state, 'cancelled');
  assert.equal(Number(rows[0].revision), 3, '二次取消不得让台账 revision 再自增');

  await db.close();
});
