/**
 * GY-R29 · #434 监工 P1 收口：**台账落库失败后，未落库的结论不得被后续空队列 flush 洗白**。
 *
 * 被复现的路径（监工 `supervisor-1022-0659-pr434`，证据评论 6333903818）：
 *   1) 首次 `submitScreening` ⇒ 真实 `createPostgresModerationLedger` 的建行 INSERT 失败
 *      （合成 SQL 端口报 42501）⇒ `flush()` 拒绝 ⇒ 送审按"未落库"报 `PROVIDER_UNAVAILABLE`；
 *   2) 但**内存**台账里那条 `approved` 记录仍在，而持久实现把失败标记清掉了；
 *   3) 同一目标随后 `publish` ⇒ `flush()` 面对**空队列**返回成功 ⇒ 目标 `private→published`
 *      —— 库里 0 行、公开面却已发布：写面 fail-closed 的承诺被绕过。
 *
 * 本文件的断言**打在持久层与目标可见性上**（不是只打返回值）：
 *   - 持久层：假池按真实 `pg.Pool` 形状（`connect()` 事务）记录行，`db.rows` 就是"库里有哪些行"；
 *   - 目标可见性：真实 `createCommunityContentAuthority` + 内存社区存储，读 `store.getPost()`。
 *
 * FC5／FC6 收口监工 P2（`supervisor-1022-0932-pr434`）：**同目标同 content_kind 的 A、B 两条记录**
 * 在 A 落库失败后重放时，不得把 B（内存里的现任任务）一起退位。断言打在**库表状态**上：
 * 恢复后必须**恰好一条** `superseded = FALSE` 的行（＝B），A 为历史行（`superseded = TRUE`）；
 * 旧实现的读数正是反过来——A、B 两行都 `superseded = TRUE`、当前行 0 条（当前审核记录丢失）。
 *
 * 声明：只用**记录型假池**（合成 SQL 故障注入）+ 内存社区存储 + 替身审核端口；
 * 不连真库、不发网络请求、不调用真实模型。真库臂见 `tests/integration/moderation-ledger-pg.mjs`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresModerationLedger } from '../../services/api/src/moderation/ledger-pg.ts';
import { createModerationService } from '../../services/api/src/moderation/service.ts';
import { createMemoryCommunityStore } from '../../services/api/src/community/store.ts';
import { createLocalPseudonymousAuthorDirectory } from '../../services/api/src/community/authors.ts';
import { createCommunityContentAuthority } from '../../services/api/src/community/moderation-authority.ts';
import { passingPort, USER_A } from './community-moderation-fixtures.mjs';

const TS = '2026-10-22T04:00:00.000Z';
/** 送审与发布共用的同一份正文（发布闸门会重跑版本/证据核对，正文必须与送审时逐字相同）。 */
const CLEAN = '记录本轮苗情、轮作做法与观察条件，无违规内容。';
const POST_ID = '9a0b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const TARGET = Object.freeze({ type: 'post', id: POST_ID, revision: 1 });
const ADMIN = Object.freeze({ ...USER_A, role: 'admin' });
const CONTENT = Object.freeze({ target_ref: TARGET, text: CLEAN, media: [] });

/**
 * 假池：与 `pg.Pool` 同形状（有 `connect()` ⇒ 台账走显式事务），并把语句效果落进内存表。
 *
 * `db.fail_insert` 是**故障注入开关**：为 true 时建行 INSERT 抛 42501（权限不足），
 * 其余语句（BEGIN/退位 UPDATE/COMMIT）照常成功——正是监工那条"只有 INSERT 失败"的合成端口。
 */
function makeFakePool() {
  const db = {
    fail_insert: true,
    insert_attempts: 0,
    rows: new Map(),
    statements: [],
    /** 事务快照：`BEGIN` 时留底、`ROLLBACK` 时整体还原（真库语义；否则失败语句的副作用会留在表里）。 */
    snapshot: null,
  };
  const client = {
    async query(text, values) {
      const sql = String(text);
      const label = sql.trim().split(/\s+/u)[0];
      db.statements.push(label);
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
        // 读回确认：`SELECT superseded … WHERE job_id = $1`（行不存在 ⇒ 0 行，由台账判失败）。
        const row = db.rows.get(values[0]);
        return { rows: row === undefined ? [] : [{ superseded: row.superseded }] };
      }
      if (label === 'UPDATE') {
        if (sql.includes('SET superseded = $2')) {
          // 最小纠正：只改 superseded（真库上由授权列清单兜底）。
          const row = db.rows.get(values[0]);
          if (row !== undefined) row.superseded = values[1] === true;
          return { rows: [] };
        }
        // 退位语句：同一目标版本上仍现任的行置 superseded（与真库语义一致）。
        // `job_id <> $6` 是真库的部分：语句带了这个约束才排除自己，否则（旧实现）连自己一起退位。
        const exclude = values.length > 5 ? values[5] : null;
        for (const row of db.rows.values()) {
          if (
            row.target_type === values[0] &&
            row.target_id === values[1] &&
            row.target_revision === values[2] &&
            row.content_kind === values[3] &&
            row.superseded === false &&
            row.job_id !== exclude
          ) {
            row.superseded = true;
          }
        }
        return { rows: [] };
      }
      if (label === 'INSERT') {
        db.insert_attempts += 1;
        if (db.fail_insert) {
          throw Object.assign(new Error('permission denied for table moderation_decisions'), { code: '42501' });
        }
        const jobId = values[0];
        // `ON CONFLICT (job_id) DO NOTHING`：重放不产生第二行。
        if (!db.rows.has(jobId)) {
          db.rows.set(jobId, {
            job_id: jobId,
            target_type: values[1],
            target_id: values[2],
            target_revision: values[3],
            content_kind: values[4],
            job_revision: values[7],
            state: values[8],
            decision: values[13],
            superseded: values[23],
          });
        }
        return { rows: [] };
      }
      throw new Error(`未预期的语句：${label}`);
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
      async query(text) {
        // 下架集合回填（W43）：一次独立的**只读**查询，真库上就是 `pool.query`（不进事务）。
        // 假池必须答它（库里没有下架行 ⇒ 0 行）；写面语句仍然只许走事务连接。
        if (/SELECT[^;]*FROM public\.moderation_withdrawals/iu.test(String(text))) return { rows: [] };
        throw new Error('真池路径不得绕过事务直连 query');
      },
    },
  };
}

/** 真实社区权威 + 真实审核服务（内存社区存储、替身审核端口）。 */
async function makeLiveService(ledger) {
  const store = createMemoryCommunityStore({ now: () => new Date(TS) });
  const authors = createLocalPseudonymousAuthorDirectory();
  const authority = createCommunityContentAuthority({ store, authors });
  await store.insertPost(
    {
      id: POST_ID,
      revision: 1,
      author_id: USER_A.userId,
      title: '苗情与轮作记录',
      body: '记录本轮苗情、轮作做法与观察条件。',
      crop_id: null,
      region_code: null,
      media_ids: [],
      linked_knowledge_ref: null,
      visibility: 'private',
      audit_state: 'pending',
      created_at: TS,
      updated_at: TS,
    },
    null,
  );
  const service = createModerationService({
    executionMode: 'stub',
    ports: { tms: passingPort() },
    authority,
    store: ledger,
  });
  return { store, service };
}

/** 送审并在"建行落库失败"下取到那条**只存在于内存**的 approved 记录。 */
async function screenWithFailedInsert(service, ledger, db) {
  await assert.rejects(
    () => service.submitScreening({ actor: USER_A, content: CONTENT }),
    (error) => error.code === 'PROVIDER_UNAVAILABLE',
    '结论落不了库 ⇒ 送审必须按"未落库"拒绝（既有 503 口径，不新造错误码）',
  );
  assert.equal(db.rows.size, 0, '持久层此时必须 0 行');
  const inMemory = ledger.current(TARGET, 'text');
  assert.equal(inMemory?.decision, 'approved', '内存里确实残留一条 approved 记录（监工 P1 的前提）');
  return inMemory;
}

test('FC1. 首次建行落库失败后 publish 必须拒绝：目标保持 private、台账 0 行（监工 P1 原路径）', async () => {
  const { db, pool } = makeFakePool();
  const ledger = createPostgresModerationLedger({ pool, now: () => new Date(TS) });
  const { store, service } = await makeLiveService(ledger);

  await screenWithFailedInsert(service, ledger, db);

  await assert.rejects(
    () => service.publish({ actor: ADMIN, content: CONTENT }),
    (error) => error.code === 'PROVIDER_UNAVAILABLE',
    '未落库的 approved 记录不得被用于发布：必须以既有 503 拒绝',
  );
  const after = await store.getPost(POST_ID);
  assert.equal(after.visibility, 'private', '落不了库就不许翻公开可见性');
  assert.equal(after.audit_state, 'pending', '审核态同样不得前进');
  assert.equal(db.rows.size, 0, '发布不得在"库里有 0 行"的状态下发生');
});

test('FC2. 失败一次后**再次** publish（队列已空）仍须拒绝：空队列不得洗白上一次失败', async () => {
  const { db, pool } = makeFakePool();
  const ledger = createPostgresModerationLedger({ pool, now: () => new Date(TS) });
  const { store, service } = await makeLiveService(ledger);

  await screenWithFailedInsert(service, ledger, db);

  await assert.rejects(
    () => service.publish({ actor: ADMIN, content: CONTENT }),
    (error) => error.code === 'PROVIDER_UNAVAILABLE',
    '第一次 publish 必须拒绝',
  );
  await assert.rejects(
    () => service.publish({ actor: ADMIN, content: CONTENT }),
    (error) => error.code === 'PROVIDER_UNAVAILABLE',
    '第二次 publish 同样必须拒绝（失败不被"队列已空"洗白）',
  );
  const after = await store.getPost(POST_ID);
  assert.equal(after.visibility, 'private', '连续两次发布尝试后目标仍是 private');
  assert.equal(db.rows.size, 0, '持久层仍然 0 行');
});

test('FC3. 失败后对空队列 flush ⇒ 必须继续拒绝，且内存记录不得被标成已落库', async () => {
  const { db, pool } = makeFakePool();
  const ledger = createPostgresModerationLedger({ pool, now: () => new Date(TS) });
  const { store, service } = await makeLiveService(ledger);

  const inMemory = await screenWithFailedInsert(service, ledger, db);

  // 队列此刻已空（首次 flush 已把失败"消费"掉）：这正是监工指出的洗白入口。
  await assert.rejects(
    () => ledger.flush(),
    (error) => error.code === 'PROVIDER_UNAVAILABLE',
    '空队列 flush 不得因为"没有新写入"就返回成功',
  );
  await assert.rejects(
    () => ledger.flush(),
    (error) => error.code === 'PROVIDER_UNAVAILABLE',
    '再次空队列 flush 仍不得放行（失败状态必须保留到真正落库为止）',
  );
  assert.equal(ledger.isDurable(inMemory), false, '这条记录不得被标成"已持久化"');
  assert.equal(db.rows.size, 0, '持久层仍然 0 行');

  // 状态没被洗白 ⇒ 发布路径也仍然拒绝（断言打在目标可见性上）。
  await assert.rejects(
    () => service.publish({ actor: ADMIN, content: CONTENT }),
    (error) => error.code === 'PROVIDER_UNAVAILABLE',
  );
  assert.equal((await store.getPost(POST_ID)).visibility, 'private');
});

/** 一条形状完整的任务记录（字段取自 `moderation/types.ts` 的必填面）。 */
function taskRecord(jobId) {
  return {
    job_id: jobId,
    target_ref: TARGET,
    content_kind: 'text',
    port_kind: 'tms',
    prompt_id: 'text_moderation',
    job_revision: 1,
    state: 'succeeded',
    lease_token: null,
    authorization_epoch: 3,
    submitted_by: USER_A.userId,
    deadline_at: null,
    decision: 'approved',
    reason_codes: [],
    hard_rule_passed: true,
    rule_version: 'mr1+sha256:b4309f21',
    model_version: 'synthetic-tms-model@1.0',
    prompt_version: 'mp1+sha256:e24f2f6a',
    contract_value: null,
    gate_holder: null,
    error_code: null,
    evidence: { execution_mode: 'stub', reasons: [], text_length: 12 },
    superseded: false,
    created_at: TS,
    updated_at: TS,
  };
}

const JOB_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const JOB_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** 表里仍现任的行（真库口径：`superseded = FALSE` 的行；部分唯一索引保证至多一条）。 */
function currentRows(db) {
  return [...db.rows.values()].filter((row) => row.superseded === false);
}

test('FC4. 存储恢复后再次 publish ⇒ 持久化成功才允许发布（正向对照）', async () => {
  const { db, pool } = makeFakePool();
  const ledger = createPostgresModerationLedger({ pool, now: () => new Date(TS) });
  const { store, service } = await makeLiveService(ledger);

  const inMemory = await screenWithFailedInsert(service, ledger, db);
  await assert.rejects(
    () => service.publish({ actor: ADMIN, content: CONTENT }),
    (error) => error.code === 'PROVIDER_UNAVAILABLE',
  );
  assert.equal((await store.getPost(POST_ID)).visibility, 'private');

  // 存储恢复：故障注入关闭，同一目标、同一份内容重新走一次发布。
  db.fail_insert = false;
  const outcome = await service.publish({ actor: ADMIN, content: CONTENT });

  assert.equal(outcome.published, true, '落库成功后发布放行');
  assert.equal((await store.getPost(POST_ID)).visibility, 'published');
  assert.equal(db.rows.size, 1, '持久层恰好一行（重放走 ON CONFLICT DO NOTHING，不产生第二行）');
  assert.equal(db.rows.get(inMemory.job_id)?.decision, 'approved', '落库内容就是那条 approved 结论');
  assert.ok(db.insert_attempts >= 2, `建行必须被真正重试过（实际尝试 ${db.insert_attempts} 次）`);
  assert.equal(ledger.isDurable(inMemory), true, '落库确认后记录才是"已持久化"');
});

test('FC5. 同目标同 content_kind 的 A、B：重放不得把 B 一起退位（监工 P2 场景，恢复后恰好一条 current）', async () => {
  const { db, pool } = makeFakePool();
  const ledger = createPostgresModerationLedger({ pool, now: () => new Date(TS) });

  // ① A 建行被 42501 拒（整事务回滚）⇒ flush 拒绝，A 未落定。
  const recordA = ledger.create(taskRecord(JOB_A));
  await assert.rejects(
    () => ledger.flush(),
    (error) => error.code === 'PROVIDER_UNAVAILABLE',
    'A 的建行落不了库 ⇒ flush 必须拒绝',
  );
  assert.equal(db.rows.size, 0, '失败事务必须整笔回滚：库中 0 行');
  assert.equal(ledger.isDurable(recordA), false);

  // ② 存储恢复后建 B（同目标、同 content_kind ⇒ 内存里 A 被 B 接任）。
  //    B 的建行成功，但 **A 尚未落定** ⇒ 本次 flush 仍必须拒绝。
  db.fail_insert = false;
  const recordB = ledger.create(taskRecord(JOB_B));
  assert.equal(ledger.current(TARGET, 'text')?.job_id, JOB_B, '内存 current 前进到 B');
  await assert.rejects(
    () => ledger.flush(),
    (error) => error.code === 'PROVIDER_UNAVAILABLE',
    'A 尚未落定 ⇒ 即便 B 这一笔成功，本次 flush 也必须拒绝（不得只报成功的那一笔）',
  );
  assert.equal(db.rows.get(JOB_B)?.superseded, false, '此时库里 B 是现任行');
  assert.equal(db.rows.has(JOB_A), false, 'A 仍未落库');

  // ③ 第三次 flush：重放 A（此时 A 已是历史任务）⇒ 必须收敛到「B 为 current、A 为 superseded」。
  await ledger.flush();

  assert.equal(db.rows.size, 2, 'A、B 各一行（重放不得产生第三行）');
  const live = currentRows(db);
  assert.equal(live.length, 1, `恢复后库中必须**恰好一条** current 行（实际 ${live.length} 条；0 条＝当前审核记录丢失）`);
  assert.equal(live[0]?.job_id, JOB_B, 'current 行必须是 B');
  assert.equal(db.rows.get(JOB_A)?.superseded, true, 'A 是历史行：必须被退位');
  assert.equal(db.rows.get(JOB_B)?.superseded, false, 'B 是现任行：重放**不得**把 B 自己退位');
  assert.equal(ledger.isDurable(recordB), true, 'B 落定后才是"已持久化"');
  assert.equal(ledger.current(TARGET, 'text')?.job_id, JOB_B, '内存与库对"当前结论"的口径必须一致');
});

test('FC6. A、B 两笔都失败后再恢复：重放顺序必须收敛到「A 退位、B 现任」', async () => {
  const { db, pool } = makeFakePool();
  const ledger = createPostgresModerationLedger({ pool, now: () => new Date(TS) });

  const recordA = ledger.create(taskRecord(JOB_A));
  await assert.rejects(() => ledger.flush(), (error) => error.code === 'PROVIDER_UNAVAILABLE');
  const recordB = ledger.create(taskRecord(JOB_B));
  await assert.rejects(
    () => ledger.flush(),
    (error) => error.code === 'PROVIDER_UNAVAILABLE',
    'A 未落定 ⇒ flush 拒绝（B 自己也刚刚失败）',
  );
  assert.equal(db.rows.size, 0, '两笔都失败（各自整笔回滚）时库里仍是 0 行');

  // 存储恢复：一次 flush 重放两笔（按登记顺序 A → B）。
  db.fail_insert = false;
  await ledger.flush();

  assert.equal(db.rows.size, 2);
  assert.equal(db.rows.get(JOB_A)?.superseded, true, '先登记的 A 必须作为历史行落库');
  assert.equal(db.rows.get(JOB_B)?.superseded, false, '后登记的 B 才是现任行');
  assert.equal(currentRows(db).length, 1, '库中当前行恰好一条（部分唯一索引口径）');
  assert.equal(ledger.isDurable(recordA), true, 'A 的历史行也确实落库了');
  assert.equal(ledger.isDurable(recordB), true);
});
