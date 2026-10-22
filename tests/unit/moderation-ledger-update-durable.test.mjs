/**
 * GY-R29 · #434 复审剩余风险收口：**`update` 必须以"实际行变更"为确认依据**。
 *
 * 被复现的路径（`#434` 复审报告 §6，`rev-f1` 探针读数）：
 *   `ledger.update` 直接把 `UPDATE … WHERE job_id = $1` 发出去，**不看命中行数**；
 *   真库命中 0 行（目标行不存在／已被并发改动）时 PostgreSQL **不报错**，于是
 *   `settle()` 照样把这一笔记成 confirmed，`isDurable()` 仍答 `true`；而重放只取未 confirmed 的项
 *   ⇒ 该更新**永远不会再被重试**，库停在建行快照（`state=queued`／`decision=pending`），
 *   内存却已推进到 `succeeded`／`approved`。唯一调用点是 `service.ts:1216` 的 `ingestCallback`。
 *
 * 本文件的断言打在**库表状态**上（不是只打返回值）：
 *   - 持久层：假池与 `pg.Pool` 同形（`connect()` 事务 + `RETURNING` 的命中行），`db.rows` 就是"库里有哪些行"；
 *   - 路径：真实 `createModerationService` 的 `ingestCallback`（`defer_model` 建任务 → 供应商回调落定）。
 *
 * 红前读数（**未修**的实现，本文件 UD1/UD2/UD3 全红）：更新命中 0 行后 `flush()` 仍返回成功、
 * `isDurable` 仍为 `true`，而库里 `state` 停在 `queued`、`decision` 停在 `pending`。
 *
 * 声明：只用**记录型假池**（合成 SQL 故障注入）+ 合成审核端口；不连真库、不发网络请求。
 * 真库臂见 `tests/integration/moderation-ledger-pg.mjs`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresModerationLedger } from '../../services/api/src/moderation/ledger-pg.ts';
import {
  TEST_CALLBACK_KEY,
  USER_A,
  countingPort,
  envelopeForTask,
  makeHarness,
  signedCallback,
  textContent,
} from '../moderation/_http-fixtures.mjs';

const TS = '2026-10-22T04:00:00.000Z';
const TARGET = Object.freeze({ type: 'post', id: 'post-1001', revision: 1 });

/**
 * 假池：与 `pg.Pool` 同形状（有 `connect()` ⇒ 建行走显式事务），并把语句效果落进内存表。
 *
 * 与 `pg` 一致地按 `RETURNING job_id` 报告**实际命中行**（这正是被修的判据）：
 *   - `INSERT`：`ON CONFLICT (job_id) DO NOTHING` ⇒ 已存在时什么也不写（`rows = []`）；
 *   - `UPDATE`：目标行不存在 ⇒ `rows = []`（真库**不报错**）；`db.concurrent_rewrite`
 *     模拟"目标行已被并发改动"：语句匹配 0 行、什么都不写、返回 0 行；
 *   - `db.fail_insert`：建行注入 42501（权限不足），用于复现"建行落不了库 + 回调恰好到达"。
 */
function makeFakePool(options = {}) {
  const db = {
    rows: new Map(),
    statements: [],
    insert_attempts: 0,
    update_attempts: 0,
    fail_insert: options.fail_insert === true,
    /** 模拟"已被并发改动"：UPDATE 匹配 0 行（返回 0 行）且不写任何列。 */
    concurrent_rewrite: false,
    /** 事务快照：`BEGIN` 留底、`ROLLBACK` 整体还原（真库语义）。 */
    snapshot: null,
  };

  function execute(text, values) {
    const sql = String(text);
    const label = sql.trim().split(/\s+/u)[0];
    db.statements.push(label);
    const args = values ?? [];
    if (label === 'BEGIN') {
      db.snapshot = new Map([...db.rows].map(([key, row]) => [key, { ...row }]));
      return { rows: [] };
    }
    if (label === 'COMMIT') {
      db.snapshot = null;
      return { rows: [] };
    }
    if (label === 'ROLLBACK') {
      if (db.snapshot !== null) db.rows = db.snapshot;
      db.snapshot = null;
      return { rows: [] };
    }
    if (label === 'SELECT') {
      // 建行后的读回确认：`SELECT superseded … WHERE job_id = $1`。
      const row = db.rows.get(args[0]);
      return { rows: row === undefined ? [] : [{ superseded: row.superseded }] };
    }
    if (label === 'INSERT') {
      db.insert_attempts += 1;
      if (db.fail_insert) {
        throw Object.assign(new Error('permission denied for table moderation_decisions'), { code: '42501' });
      }
      const jobId = args[0];
      if (db.rows.has(jobId)) return { rows: [] }; // ON CONFLICT (job_id) DO NOTHING
      db.rows.set(jobId, {
        job_id: jobId,
        target_type: args[1],
        target_id: args[2],
        target_revision: args[3],
        content_kind: args[4],
        job_revision: args[7],
        state: args[8],
        decision: args[13],
        superseded: args[23] === true,
      });
      return { rows: [] };
    }
    if (label === 'UPDATE') {
      if (sql.includes('SET superseded = TRUE')) {
        // 退位语句（建行前）：同一目标版本上仍现任的行置 superseded。
        const exclude = args.length > 5 ? args[5] : null;
        for (const row of db.rows.values()) {
          if (
            row.target_type === args[0] &&
            row.target_id === args[1] &&
            row.target_revision === args[2] &&
            row.content_kind === args[3] &&
            row.superseded === false &&
            row.job_id !== exclude
          ) {
            row.superseded = true;
          }
        }
        return { rows: [] };
      }
      // 状态推进/回调落定（本片被修的那条语句）：只改可变列，并返回 `RETURNING job_id` 的命中行。
      db.update_attempts += 1;
      const row = db.rows.get(args[0]);
      if (row === undefined || db.concurrent_rewrite) return { rows: [] };
      row.state = args[1];
      row.decision = args[3];
      row.superseded = args[13] === true;
      return { rows: [{ job_id: args[0] }] };
    }
    throw new Error(`未预期的语句：${label}`);
  }

  const client = {
    async query(text, values) {
      return execute(text, values);
    },
    release() {
      db.statements.push('RELEASE');
    },
  };
  return {
    db,
    pool: {
      async connect() {
        return client;
      },
      async query(text, values) {
        return execute(text, values);
      },
    },
  };
}

/** 等待回调目录里那条"待回调"任务落库（`defer_model` 路径：queued/pending）。 */
async function queueTask({ db, pool }) {
  const ledger = createPostgresModerationLedger({ pool, now: () => new Date(TS) });
  const h = makeHarness({ ledger, ports: { tms: countingPort('tms').port } });
  const out = await h.service.submitScreening({ actor: USER_A, content: textContent(), defer_model: true });
  const task = out.tasks[0];
  assert.equal(task.state, 'queued');
  assert.equal(task.decision, 'pending');
  assert.equal(db.rows.get(task.job_id)?.state, 'queued', '建行落的应是 queued 快照');
  assert.equal(db.rows.get(task.job_id)?.decision, 'pending');
  return { ledger, h, task };
}

test('UD1. 目标行不存在（已被并发删掉）⇒ UPDATE 命中 0 行：不得确认、库继续无行、重放必须真的重试', async () => {
  const { db, pool } = makeFakePool();
  const { ledger, h, task } = await queueTask({ db, pool });

  // 另一写者把这一行删了（真库上 `UPDATE … WHERE job_id = $1` 命中 0 行，**不报错**）。
  db.rows.delete(task.job_id);
  const envelope = envelopeForTask(task, { event_id: 'evt-ud1' });

  await assert.rejects(
    () => h.service.ingestCallback(signedCallback(envelope)),
    (error) => {
      assert.equal(error.code, 'PROVIDER_UNAVAILABLE', `实际 ${error.code}：${error.message}`);
      assert.match(error.message, /未落定/u, '错误文案必须点明"未落定"，不允许被读成"已保存"');
      return true;
    },
    '回调落定命中 0 行 ⇒ 必须按"未落库"拒绝（沿用既有 503 口径，不新造错误码）',
  );

  const inMemory = ledger.current(TARGET, 'text');
  assert.equal(inMemory.state, 'succeeded', '内存已推进（"内存领先"是本实现的固有形态）');
  assert.equal(inMemory.decision, 'approved');
  assert.equal(ledger.isDurable(inMemory), false, '没有命中任何行的更新不得被标成"已持久化"');
  assert.equal(db.rows.size, 0, '库里仍然 0 行（这次更新什么也没写）');

  const attemptsAfterFirst = db.update_attempts;
  await assert.rejects(
    () => ledger.flush(),
    (error) => error.code === 'PROVIDER_UNAVAILABLE',
    '未落定的更新必须留在日志里：下一次 flush 仍要拒绝（不得被"队列已空"洗白）',
  );
  assert.equal(db.update_attempts, attemptsAfterFirst + 1, '重放必须**真的重新发一次** UPDATE（不是"抛一次就忘"）');
  assert.equal(ledger.isDurable(inMemory), false);
});

test('UD2. 目标行已被并发改动（UPDATE 匹配 0 行但行还在）⇒ 库保持旧值、不得确认；恢复后重放才收敛', async () => {
  const { db, pool } = makeFakePool();
  const { ledger, h, task } = await queueTask({ db, pool });

  // 行还在，但这次状态推进匹配 0 行（真库不报错、`RETURNING` 返回 0 行：并发改动后条件不再成立）。
  db.concurrent_rewrite = true;
  await assert.rejects(
    () => h.service.ingestCallback(signedCallback(envelopeForTask(task, { event_id: 'evt-ud2' }))),
    (error) => error.code === 'PROVIDER_UNAVAILABLE',
    '命中 0 行的更新不得算落定',
  );

  const stale = db.rows.get(task.job_id);
  assert.equal(stale.state, 'queued', `库不得被当成已推进（实际 state=${stale.state}）`);
  assert.equal(stale.decision, 'pending', `库不得被当成已推进（实际 decision=${stale.decision}）`);
  assert.equal(ledger.current(TARGET, 'text').state, 'succeeded', '内存里确实已经 succeeded（不一致的源头）');
  assert.equal(ledger.isDurable(ledger.current(TARGET, 'text')), false, '库没跟上的记录不得自称"已持久化"');

  // 再 flush 一次：仍拒绝；然后把"并发改动"解除（行重新可写）⇒ 重放必须把这条更新补上。
  await assert.rejects(() => ledger.flush(), (error) => error.code === 'PROVIDER_UNAVAILABLE');
  db.concurrent_rewrite = false;
  await ledger.flush();

  const converged = db.rows.get(task.job_id);
  assert.equal(converged.state, 'succeeded', `重放收敛后库 state 必须等于内存（实际 ${converged.state}）`);
  assert.equal(converged.decision, 'approved', `重放收敛后库 decision 必须等于内存（实际 ${converged.decision}）`);
  assert.equal(db.rows.size, 1, '重放更新不得产生第二行');
  assert.equal(ledger.isDurable(ledger.current(TARGET, 'text')), true, '真正落定之后才是"已持久化"');
});

test('UD3. #434 §6 原路径：建行落不了库 + 回调恰好到达 ⇒ 存储恢复后重放必须把 update 一起补上', async () => {
  const { db, pool } = makeFakePool({ fail_insert: true });
  const ledger = createPostgresModerationLedger({ pool, now: () => new Date(TS) });
  const h = makeHarness({ ledger, ports: { tms: countingPort('tms').port } });

  // ① 建行被 42501 拒（整事务回滚）⇒ 送审按"未落库"拒绝；内存里残留 queued/pending 记录。
  await assert.rejects(
    () => h.service.submitScreening({ actor: USER_A, content: textContent(), defer_model: true }),
    (error) => error.code === 'PROVIDER_UNAVAILABLE',
  );
  assert.equal(db.rows.size, 0, '失败事务整笔回滚：库中 0 行');
  const queued = ledger.current(TARGET, 'text');
  assert.equal(queued.state, 'queued');

  // ② 供应商回调恰好到达：`ingestCallback` 走 `ledger.update(updated)`，此时库里**没有**这一行。
  await assert.rejects(
    () => h.service.ingestCallback(signedCallback(envelopeForTask(queued, { event_id: 'evt-ud3-a' }))),
    (error) => error.code === 'PROVIDER_UNAVAILABLE',
    '还有未落定的写入（建行 / 这次更新）⇒ 回调不得被当成已结算',
  );
  assert.equal(ledger.isDurable(ledger.current(TARGET, 'text')), false, '建行都没落库，谈不上"已持久化"');

  // ③ 存储恢复（此后任何一次 `flush()`——送审、发布、下一个回调都会触发）：重放必须**按登记顺序**
  //    把建行与那条更新都补上。旧实现把更新提前记成 confirmed，重放只取未 confirmed
  //    ⇒ 这条更新永远不会再发一次，库停在 queued/pending。
  db.fail_insert = false;
  const settledJobId = queued.job_id;
  await ledger.flush();

  assert.equal(db.rows.size, 1, '重放不得产生第二行');
  const row = db.rows.get(settledJobId);
  assert.equal(row.state, 'succeeded', `库 state 必须跟上内存（实际 ${row.state}）`);
  assert.equal(row.decision, 'approved', `库 decision 必须跟上内存（实际 ${row.decision}）`);
  assert.equal(ledger.current(TARGET, 'text').state, 'succeeded', '内存与库对同一条结论的口径必须一致');
  assert.equal(ledger.isDurable(ledger.current(TARGET, 'text')), true);
});

test('UD4. 幂等（正控制）：重复 update 只有一行、值一致、每次都被真正确认', async () => {
  const { db, pool } = makeFakePool();
  const { ledger, h, task } = await queueTask({ db, pool });

  const outcome = await h.service.ingestCallback(signedCallback(envelopeForTask(task, { event_id: 'evt-ud4' })));
  assert.equal(outcome.accepted, true, JSON.stringify(outcome.issues));
  const settled = ledger.current(TARGET, 'text');
  const before = db.rows.get(task.job_id);
  assert.equal(before.state, 'succeeded');
  assert.equal(before.decision, 'approved');
  assert.equal(ledger.isDurable(settled), true);
  const updateCallsBefore = db.update_attempts;

  // 重复落定同一份记录（同一 job 的幂等写入）：不得产生第二行、不得写出别的值。
  ledger.update({ ...settled });
  await ledger.flush();
  assert.equal(db.update_attempts, updateCallsBefore + 1, '重复 update 应当真发一次语句（数据库侧按主键覆盖）');
  assert.equal(db.rows.size, 1, '重复 update 不得产生第二行');
  assert.equal(db.rows.get(task.job_id)?.state, 'succeeded');
  assert.equal(db.rows.get(task.job_id)?.decision, 'approved');
  assert.equal(ledger.isDurable(settled), true, '重复落定之后仍是"已持久化"');

  // 已确认的写入不进重放队列：再 flush 一次不会重发语句。
  const updateCallsAfter = db.update_attempts;
  await ledger.flush();
  assert.equal(db.update_attempts, updateCallsAfter, '已 confirmed 的更新不得被重放（否则每次 flush 都白打一次库）');
});

/** 校验假池的确认口径（`RETURNING job_id` 的命中行）：否则"0 行与 1 行可区分"这条判据在测试里无从成立。 */
test('UD5. 假池口径自检：状态推进语句按 RETURNING 返回命中行，命中 0 行与命中 1 行可区分', async () => {
  const { db, pool } = makeFakePool();
  const missing = await pool.query(
    'UPDATE public.moderation_decisions SET state = $2 WHERE job_id = $1 RETURNING job_id',
    ['no-such-job', 'succeeded'],
  );
  assert.deepEqual(missing.rows, [], '目标行不存在 ⇒ RETURNING 0 行（真库同样不报错）');
  assert.equal(db.update_attempts, 1);

  db.rows.set('job-x', { job_id: 'job-x', state: 'queued', decision: 'pending', superseded: false });
  const hit = await pool.query(
    'UPDATE public.moderation_decisions SET state = $2 WHERE job_id = $1 RETURNING job_id',
    ['job-x', 'succeeded'],
  );
  assert.deepEqual(hit.rows, [{ job_id: 'job-x' }], '命中 1 行 ⇒ RETURNING 返回那一行');
  assert.equal(db.rows.get('job-x')?.state, 'succeeded');
});
