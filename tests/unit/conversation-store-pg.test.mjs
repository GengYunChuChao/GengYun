// GY-I12（#12）：会话域 **PostgreSQL 持久化与删除级联**的回归。
//
// 用内存 PostgreSQL 引擎（PGlite 0.5.8，PostgreSQL 18.x 内核）逐条执行**真实迁移 SQL**
// 与 `services/api/src/conversations/store-pg.ts` 的真实实现。
//
// 注意（如实标注）：这只证明 SQL 语义与该 store 的读写/级联行为，**不**构成目标
// PostgreSQL 17.11 的真实实例验收，也**不**证明迁移在真实库上的可重复应用（那需要真实 DATABASE_URL）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { createPostgresConversationStore } from '../../services/api/src/conversations/store-pg.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const migrationsDir = resolve(root, 'services/api/db/migrations');

function migrationSql(name) {
  return readFileSync(resolve(migrationsDir, name), 'utf8');
}

/** 把 PGlite 包成 store 需要的 `TransactionalPool`（单连接：测试里顺序执行，无并发）。 */
function poolOf(db) {
  const runner = { query: (text, values) => db.query(text, values) };
  return { query: runner.query, connect: async () => ({ query: runner.query, release: () => {} }) };
}

/** 建带 `users` 的库并应用到 0012（会话域自己的迁移）。 */
async function migratedDatabase() {
  const db = new PGlite();
  await db.exec(migrationSql('0001_initial_schema.sql'));
  await db.exec(migrationSql('0012_conversations.sql'));
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

test('0012 会话迁移在内存 PostgreSQL 引擎可整体执行，且回滚脚本把三张表撤回', async () => {
  const db = new PGlite();
  await db.exec(migrationSql('0001_initial_schema.sql'));
  await db.exec(migrationSql('0012_conversations.sql'));
  const created = await db.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'conversation%' ORDER BY tablename`,
  );
  assert.deepEqual(created.rows.map((row) => row.tablename), [
    'conversation_answers',
    'conversation_turns',
    'conversations',
  ]);

  await db.exec(readFileSync(resolve(migrationsDir, 'rollback/0012_conversations.down.sql'), 'utf8'));
  const reverted = await db.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'conversation%'`,
  );
  assert.deepEqual(reverted.rows.map((row) => row.tablename), []);
  // 回滚脚本**不得**动别的域的表（注销/历史/资料各自独立）。
  const survivors = await db.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('users', 'sessions', 'media') ORDER BY tablename`,
  );
  assert.deepEqual(survivors.rows.map((row) => row.tablename), ['media', 'sessions', 'users']);
  await db.close();
});

test('会话/轮次/回答往返读回（含 jsonb 字段与作业快照）', async () => {
  const { db, ownerId } = await migratedDatabase();
  const store = createPostgresConversationStore(poolOf(db));

  const conversation = await store.insertConversation(conversationRecord(ownerId, 1, {
    conditions: { crop_id: 'rice', region_code: '330100' },
  }));
  assert.equal(conversation.revision, 1);
  assert.deepEqual(conversation.conditions, { crop_id: 'rice', region_code: '330100' });

  const read = await store.getConversation(conversation.id, ownerId);
  assert.deepEqual(read, conversation);

  const turn = await store.insertTurn(turnRecord(ownerId, conversation.id, 1));
  assert.equal(turn.job_state, 'queued');
  assert.equal(turn.answer_id, null);

  const claimed = await store.claimTurnJob(turn.id, ownerId);
  assert.equal(claimed.job_state, 'running');
  assert.equal(claimed.revision, 2, '受理推进必须递增 revision（Turn.revision 就是强 ETag）');
  assert.equal(await store.claimTurnJob(turn.id, ownerId), null, '已推进的作业不得被再次 claim');

  const answer = answerRecord(ownerId, turn.id, 1, {
    status: 'answered',
    check_state: 'passed',
    checked_text: '合成回答正文（测试替身）',
    citations: [{
      id: '8de526e2-ada8-514a-bbab-a0da3e784b0d',
      version: 'synthetic-source-2026.10',
      title: '合成资料条目（测试替身，非真实资料）',
      url: 'https://example.invalid/gengyun/synthetic-source',
      publisher: '合成发布方（测试替身）',
      source_kind: 'verified_seed',
      evidence_kind: 'mixed',
      validity: 'valid',
      review_status: 'unverified',
      updated_at: '2026-10-14T00:00:00.000Z',
    }],
  });
  const settled = await store.settleTurnJob({
    turnId: turn.id,
    ownerId,
    state: 'succeeded',
    errorCode: null,
    answer,
    at: AT,
  });
  assert.equal(settled.job_state, 'succeeded');
  assert.equal(settled.answer_id, answer.id);
  assert.equal(settled.revision, 3);

  const loaded = await store.getTurn(conversation.id, turn.id, ownerId);
  assert.equal(loaded.answer.status, 'answered');
  assert.equal(loaded.answer.citations.length, 1);
  assert.equal(loaded.answer.citations[0].url, 'https://example.invalid/gengyun/synthetic-source');

  const byJob = await store.findTurnByJobId(turn.job_id, ownerId);
  assert.equal(byJob.turn.id, turn.id);
  assert.equal(byJob.answer.id, answer.id);
  assert.equal(await store.getAnswer(answer.id, ownerId) !== null, true);
  assert.equal(await store.listTurns(conversation.id, ownerId, { limit: 10 }).then((rows) => rows.length), 1);
  await db.close();
});

test('所有权与 CAS：他人与不存在同形（NOT_FOUND），revision 不符是 REVISION_CHANGED', async () => {
  const { db, ownerId, otherId } = await migratedDatabase();
  const store = createPostgresConversationStore(poolOf(db));
  const conversation = await store.insertConversation(conversationRecord(ownerId, 2));
  const turn = await store.insertTurn(turnRecord(ownerId, conversation.id, 2));
  await store.settleTurnJob({
    turnId: turn.id, ownerId, state: 'succeeded', errorCode: null,
    answer: answerRecord(ownerId, turn.id, 2), at: AT,
  });
  const loaded = await store.getTurn(conversation.id, turn.id, ownerId);

  assert.equal(await store.getConversation(conversation.id, otherId), null, '他人读不到（与不存在同形）');
  assert.equal(await store.getTurn(conversation.id, turn.id, otherId), null);
  assert.equal(await store.findTurnByJobId(turn.job_id, otherId), null);
  assert.deepEqual(
    await store.deleteConversation(conversation.id, otherId, 1),
    { ok: false, reason: 'NOT_FOUND' },
    '他人删会话不得泄露"存在但无权"（与不存在同形）',
  );
  assert.deepEqual(
    await store.deleteTurn(conversation.id, turn.id, otherId, loaded.turn.revision),
    { ok: false, reason: 'NOT_FOUND' },
  );
  assert.deepEqual(
    await store.deleteConversation(conversation.id, ownerId, 99),
    { ok: false, reason: 'REVISION_CHANGED' },
    'If-Match 不符必须显式区分（HTTP 层要映成 409）',
  );
  assert.equal((await store.getConversation(conversation.id, ownerId)) !== null, true, '失败不得误删');
  await db.close();
});

test('删除级联：删会话连带其下轮次与回答；删轮次连带其回答', async () => {
  const { db, ownerId } = await migratedDatabase();
  const store = createPostgresConversationStore(poolOf(db));
  const conversation = await store.insertConversation(conversationRecord(ownerId, 3));
  const turn = await store.insertTurn(turnRecord(ownerId, conversation.id, 3));
  const settledTurn = await store.settleTurnJob({
    turnId: turn.id, ownerId, state: 'succeeded', errorCode: null,
    answer: answerRecord(ownerId, turn.id, 3), at: AT,
  });

  const counts = async () => {
    const rows = await db.query(
      `SELECT (SELECT count(*) FROM conversations) AS c,
              (SELECT count(*) FROM conversation_turns) AS t,
              (SELECT count(*) FROM conversation_answers) AS a`,
    );
    return { c: Number(rows.rows[0].c), t: Number(rows.rows[0].t), a: Number(rows.rows[0].a) };
  };
  assert.deepEqual(await counts(), { c: 1, t: 1, a: 1 });

  // 第二条轮次（带回答）留给"删轮次"这条边。
  const turn2 = await store.insertTurn(turnRecord(ownerId, conversation.id, 4));
  await store.settleTurnJob({
    turnId: turn2.id, ownerId, state: 'failed', errorCode: 'PROVIDER_UNAVAILABLE',
    answer: null, at: AT,
  });
  assert.deepEqual(await counts(), { c: 1, t: 2, a: 1 });

  const deletedTurn = await store.deleteTurn(conversation.id, turn.id, ownerId, settledTurn.revision);
  assert.equal(deletedTurn.ok, true);
  assert.deepEqual(await counts(), { c: 1, t: 1, a: 0 }, '删轮次必须连带它的回答（不得留下孤儿回答）');

  const deleted = await store.deleteConversation(conversation.id, ownerId, 1);
  assert.equal(deleted.ok, true);
  assert.deepEqual(await counts(), { c: 0, t: 0, a: 0 }, '删会话必须连带其下全部轮次与回答');
  await db.close();
});

test('数据库侧约束：契约外状态、越界引用数、无因失败一律写不进去', async () => {
  const { db, ownerId } = await migratedDatabase();
  // 这一组直接对 SQL 施压（store 会把数据库错误统一折成 503 以不泄露内部细节，
  // 而这里要证明的正是"数据库自己就拒绝"）。
  const conversation = await db.query(
    'INSERT INTO conversations (owner_id, revision) VALUES ($1::uuid, 1) RETURNING id',
    [ownerId],
  );
  const conversationId = String(conversation.rows[0].id);
  const turn = await db.query(
    `INSERT INTO conversation_turns (conversation_id, owner_id, input_text, job_id, job_deadline_at)
     VALUES ($1::uuid, $2::uuid, '合成提问（测试替身）', gen_random_uuid(), now() + interval '30 seconds') RETURNING id`,
    [conversationId, ownerId],
  );
  const turnId = String(turn.rows[0].id);

  const insertAnswer = (columns) => db.query(
    `INSERT INTO conversation_answers
       (turn_id, owner_id, status, checked_text, check_state, model_version, prompt_version, rule_version, citations)
     VALUES ($1::uuid, $2::uuid, $3, '正文', 'passed', 'unimplemented:no-real-model/x',
             'unimplemented:no-real-prompt/x', 'unimplemented:no-real-rule/x', $4::jsonb)`,
    [turnId, ownerId, columns.status, JSON.stringify(columns.citations ?? [])],
  );

  await assert.rejects(
    () => insertAnswer({ status: 'ok' }),
    (error) => /conversation_answers_status_check|check constraint/i.test(String(error && error.message)),
    '契约外的 status 必须被数据库拒绝',
  );
  await assert.rejects(
    () => insertAnswer({ status: 'answered', citations: Array.from({ length: 21 }, () => ({})) }),
    (error) => /conversation_answers_citations_max|check constraint/i.test(String(error && error.message)),
    'citations 超过契约 maxItems 20 必须被数据库拒绝',
  );
  await assert.rejects(
    () => db.query(
      `INSERT INTO conversation_answers
         (turn_id, owner_id, status, checked_text, check_state, model_version, prompt_version, rule_version)
       VALUES ($1::uuid, $2::uuid, 'answered', '', 'passed', 'unimplemented:no-real-model/x',
               'unimplemented:no-real-prompt/x', 'unimplemented:no-real-rule/x')`,
      [turnId, ownerId],
    ),
    (error) => /conversation_answers_checked_text_check|check constraint/i.test(String(error && error.message)),
    '契约 minLength 1 的正文不得写空串',
  );
  await assert.rejects(
    () => db.query(`UPDATE conversation_turns SET job_state = 'failed', job_error_code = NULL WHERE id = $1::uuid`, [turnId]),
    (error) => /conversation_turns_job_error_pair|check constraint/i.test(String(error && error.message)),
    'failed 却没有 error_code 必须被数据库拒绝（如实性不变式）',
  );
  await assert.rejects(
    () => db.query(`UPDATE conversation_turns SET job_state = 'succeeded', job_error_code = 'PROVIDER_TIMEOUT' WHERE id = $1::uuid`, [turnId]),
    (error) => /conversation_turns_job_error_pair|check constraint/i.test(String(error && error.message)),
    'succeeded 却带 error_code 必须被数据库拒绝（不得同时"成功"又带错）',
  );

  const state = await db.query('SELECT job_state, job_error_code FROM conversation_turns WHERE id = $1::uuid', [turnId]);
  assert.equal(state.rows[0].job_state, 'queued', '被拒绝的写入不得留下半截状态');
  assert.equal(state.rows[0].job_error_code, null);
  await db.close();
});

test('deleteAllByOwner 只清自己的会话（注销擦除路径）', async () => {
  const { db, ownerId, otherId } = await migratedDatabase();
  const store = createPostgresConversationStore(poolOf(db));
  const mine = await store.insertConversation(conversationRecord(ownerId, 6));
  const theirs = await store.insertConversation(conversationRecord(otherId, 7));
  await store.insertTurn(turnRecord(ownerId, mine.id, 6));
  await store.insertTurn(turnRecord(otherId, theirs.id, 7));

  assert.equal(await store.deleteAllByOwner(ownerId), 1);
  const left = await db.query(
    `SELECT (SELECT count(*) FROM conversations) AS c,
            (SELECT count(*) FROM conversation_turns) AS t`,
  );
  assert.equal(Number(left.rows[0].c), 1);
  assert.equal(Number(left.rows[0].t), 1, '只删会话不删轮次是错的：级联必须连带');
  assert.equal((await store.getConversation(theirs.id, otherId)) !== null, true);
  await db.close();
});
