/**
 * GY-R29 S7 · 审核判定台账**落库**（迁移 `0028_moderation_persistence.sql`）的单元回归。
 *
 * 覆盖两件事，缺一不可：
 *   1) **SQL 形状**：建行/更新/下架三条语句的列集合、参数顺序、幂等关键字
 *      （`ON CONFLICT (job_id) DO NOTHING` / `ON CONFLICT (target_type,target_id,target_revision) DO NOTHING`）
 *      以及"更新语句不得改写目标身份列"这条不变式；
 *   2) **写面 fail-closed**：台账落不了库时，审核结论不许被当成已受理、公开可见性不许翻成 `published`。
 *      这是本片的行为边界：`flush()` 拒绝 ⇒ 抛 `PROVIDER_UNAVAILABLE`/`PROVIDER_TIMEOUT`，零副作用。
 *
 * 声明：只用**记录型假池**（记录 SQL 文本与参数）+ 内存社区存储 + 替身审核端口，不连真库、不发网络请求。
 * 真库臂见 `tests/integration/moderation-ledger-pg.mjs`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createModerationLedger } from '../../services/api/src/moderation/decisions.ts';
import { createPostgresModerationLedger } from '../../services/api/src/moderation/ledger-pg.ts';
import { createModerationService } from '../../services/api/src/moderation/service.ts';
import { createMemoryCommunityStore } from '../../services/api/src/community/store.ts';
import { createLocalPseudonymousAuthorDirectory } from '../../services/api/src/community/authors.ts';
import { createCommunityContentAuthority } from '../../services/api/src/community/moderation-authority.ts';
import { makeWiredHarness, passingPort, USER_A } from './community-moderation-fixtures.mjs';

const TS = '2026-10-22T04:00:00.000Z';
/** 送审与发布共用的同一份正文（发布闸门会重跑版本/证据核对，正文必须与送审时逐字相同）。 */
const CLEAN = '记录本轮苗情、轮作做法与观察条件，无违规内容。';
const POST_ID = '9a0b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const JOB_1 = '11111111-1111-4111-8111-111111111111';
const JOB_2 = '22222222-2222-4222-8222-222222222222';
const TARGET = Object.freeze({ type: 'post', id: POST_ID, revision: 1 });
const USER_ID = '33333333-3333-4333-8333-333333333333';

/** 记录型假池：把每次 `query()` 的 SQL 与参数原样留下；`fail` 可在第 N 次调用时抛错。 */
function makeRecordingPool(options = {}) {
  const calls = [];
  const pool = {
    async query(text, values) {
      calls.push({ text, values: values ?? [] });
      const fail = options.fail;
      if (typeof fail === 'function') {
        const error = fail(calls.length);
        if (error !== null && error !== undefined) throw error;
      }
      return { rows: [] };
    },
  };
  return { pool, calls };
}

/** 一条形状完整的任务记录（字段取自 `moderation/types.ts:177-212` 的必填面）。 */
function record(overrides = {}) {
  return {
    job_id: JOB_1,
    target_ref: TARGET,
    content_kind: 'text',
    port_kind: 'tms',
    prompt_id: 'text_moderation',
    job_revision: 1,
    state: 'succeeded',
    lease_token: null,
    authorization_epoch: 3,
    submitted_by: USER_ID,
    deadline_at: null,
    decision: 'approved',
    reason_codes: [],
    hard_rule_passed: true,
    rule_version: 'mr1+sha256:b4309f21',
    model_version: 'synthetic-tms-model@1.0',
    prompt_version: 'mp1+sha256:e24f2f6a',
    contract_value: null,
    gate_holder: { schema: 'gate@1', target_ref: TARGET, decision: 'approved' },
    error_code: null,
    evidence: { execution_mode: 'stub', reasons: [], text_length: 12 },
    superseded: false,
    created_at: TS,
    updated_at: TS,
    ...overrides,
  };
}

test('LP1. 建行 = 退位语句 + 插入语句（真池上包在同一事务），参数 5 + 26', async () => {
  const { pool, calls } = makeRecordingPool();
  const ledger = createPostgresModerationLedger({ pool, now: () => new Date(TS) });
  assert.equal(ledger.persistent, true, '持久台账必须如实声明 persistent');

  ledger.create(record());
  await ledger.flush();
  assert.equal(calls.length, 2, '建行必须发两条语句：先把旧的当前行置 superseded，再插入新行');

  const supersede = calls[0];
  assert.ok(supersede.text.includes('UPDATE public.moderation_decisions'), '第一条必须是退位语句');
  assert.ok(supersede.text.includes('SET superseded = TRUE'), '退位 = 置 superseded');
  assert.ok(!supersede.text.includes('INSERT'), '退位与插入必须是两条语句：数据修改型 CTE 的 UPDATE 对同语句 INSERT 不可见');
  assert.ok(
    /AND content_kind = \$4 AND superseded = FALSE/u.test(supersede.text),
    '只退位同一目标版本上仍现任的行',
  );
  assert.deepEqual(supersede.values, ['post', POST_ID, 1, 'text', TS], '退位按目标版本定位，updated_at 与插入同戳');

  const insert = calls[1];
  assert.ok(insert.text.includes('INSERT INTO public.moderation_decisions'), '第二条必须写入台账表');
  assert.ok(insert.text.includes('ON CONFLICT (job_id) DO NOTHING'), '同一任务重放不得产生第二行（幂等由主键给）');
  const values = insert.values;
  assert.equal(values.length, 26, `参数个数 ${values.length} 必须与列集合一致`);
  assert.equal(values[0], JOB_1);
  assert.deepEqual([values[1], values[2], values[3]], ['post', POST_ID, 1]);
  assert.equal(values[4], 'text');
  assert.equal(values[5], 'tms');
  assert.equal(values[14], '[]', 'reason_codes 必须以 jsonb 数组字符串落库');
  assert.equal(typeof values[22], 'string', 'evidence 以 jsonb 字符串落库');
  assert.equal(values[23], false, '新行 superseded=false');
  assert.equal(values[25], TS, 'updated_at 与退位语句同戳');
});

test('LP2. 重复 job_id：同步抛错且**不入队**（绝不先写库再报错）', async () => {
  const { pool, calls } = makeRecordingPool();
  const ledger = createPostgresModerationLedger({ pool, now: () => new Date(TS) });
  ledger.create(record());
  await ledger.flush();
  assert.throws(() => ledger.create(record()), /审核任务 job_id 重复/u);
  await ledger.flush();
  assert.equal(calls.length, 2, '重复的那次不得再发语句（第一次 create 的两条是上限）');
});

test('LP3. supersede 语义与内存台账逐字一致：current 前进、history 保留两行、旧行 superseded=true', async () => {
  const { pool, calls } = makeRecordingPool();
  const ledger = createPostgresModerationLedger({ pool, now: () => new Date(TS) });
  ledger.create(record());
  ledger.create(record({ job_id: JOB_2, model_version: 'synthetic-tms-model@2.0' }));
  await ledger.flush();

  assert.equal(ledger.current(TARGET, 'text')?.job_id, JOB_2, 'current 必须指向新任务');
  assert.equal(ledger.history(TARGET).length, 2, '旧任务进历史，不删');
  assert.equal(ledger.byJobId(JOB_1)?.superseded, true, '旧行 superseded=true');
  assert.equal(ledger.snapshotCounts().current, 1, '每个目标版本每个内容类别至多一条当前任务');
  assert.equal(calls.length, 4, '两次 create 各两条语句');
});

test('LP4. 未知 job_id 的更新：同步抛错且不入队（调用方必须先 create）', async () => {
  const { pool, calls } = makeRecordingPool();
  const ledger = createPostgresModerationLedger({ pool, now: () => new Date(TS) });
  assert.throws(() => ledger.update(record()), /审核任务不存在，无法更新/u);
  await ledger.flush();
  assert.equal(calls.length, 0);
});

test('LP5. 更新语句只动可变列：目标身份列（target_*/content_kind/job_revision）不得出现在 SET 里', async () => {
  const { pool, calls } = makeRecordingPool();
  const ledger = createPostgresModerationLedger({ pool, now: () => new Date(TS) });
  ledger.create(record({ state: 'queued', decision: 'pending' }));
  ledger.update(record({ state: 'succeeded', decision: 'approved' }));
  await ledger.flush();

  assert.equal(calls.length, 3, 'create 两条 + update 一条');
  const sql = calls[2].text;
  assert.ok(sql.includes('UPDATE public.moderation_decisions SET'), '状态推进走 UPDATE');
  assert.ok(sql.includes('WHERE job_id = $1'), '按主键定位');
  for (const column of ['target_type', 'target_id', 'target_revision', 'content_kind', 'job_revision', 'created_at']) {
    assert.ok(!sql.includes(`  ${column} = `), `身份列 ${column} 不得被更新语句改写`);
  }
  assert.equal(calls[2].values[0], JOB_1);
  assert.equal(calls[2].values[1], 'succeeded');
  assert.equal(calls[2].values[3], 'approved');
});

test('LP6. 下架标记幂等：重放不新增行，内存 isWithdrawn 与落库语句一致', async () => {
  const { pool, calls } = makeRecordingPool();
  const ledger = createPostgresModerationLedger({ pool, now: () => new Date(TS) });
  ledger.markWithdrawn(TARGET);
  ledger.markWithdrawn(TARGET);
  await ledger.flush();

  assert.equal(ledger.isWithdrawn(TARGET), true);
  assert.equal(ledger.snapshotCounts().withdrawn, 1, '同一 (target,revision) 只算一次下架');
  assert.equal(calls.length, 2, '重放仍然发语句（数据库侧 DO NOTHING 兜底），但不产生第二行');
  for (const call of calls) {
    assert.ok(call.text.includes('INSERT INTO public.moderation_withdrawals'));
    assert.ok(call.text.includes('ON CONFLICT (target_type, target_id, target_revision) DO NOTHING'));
    assert.deepEqual(call.values.slice(0, 3), ['post', POST_ID, 1], '下架键含 revision（与内存 withdrawn 集合逐键一致）');
  }
});

test('LP7. flush 失败 ⇒ PROVIDER_UNAVAILABLE；**空队列不得洗白**，存储恢复后重放成功（不永久毒化台账）', async () => {
  let armed = true;
  const { pool, calls } = makeRecordingPool({
    fail: () => (armed ? Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) : null),
  });
  const ledger = createPostgresModerationLedger({ pool, now: () => new Date(TS) });
  const stored = ledger.create(record());

  await assert.rejects(
    () => ledger.flush(),
    (error) => {
      assert.equal(error.code, 'PROVIDER_UNAVAILABLE', `实际 ${error.code}：${error.message}`);
      assert.ok(error.message.includes('结论未落定'), '错误文案必须点明"未落定"，不允许被读成"已保存"');
      return true;
    },
  );
  assert.equal(ledger.isDurable(stored), false, '未落库的记录不得被标成"已持久化"');

  // 队列此刻已空：**不得**因为"没有新写入"就返回成功——否则内存里残留的结论会被当成已落库
  // （#434 监工 P1 的洗白入口：首次建行失败 → 空队列 flush 成功 → 目标被 private→published）。
  await assert.rejects(() => ledger.flush(), (error) => error.code === 'PROVIDER_UNAVAILABLE');
  assert.equal(ledger.isDurable(stored), false, '空队列 flush 之后仍不得被标成"已持久化"');

  // 存储恢复 ⇒ 下一次 flush 重放失败项并落定：既不被洗白，也不永久毒化台账。
  armed = false;
  await ledger.flush();
  assert.equal(ledger.isDurable(stored), true, '重放落定之后才是"已持久化"');
  // 每次建行尝试都以退位语句开头 ⇒ 用它数"这条写入被真正试过几次"（首次 + 两次重放）。
  assert.ok(
    calls.filter((call) => call.text.includes('UPDATE public.moderation_decisions')).length >= 3,
    '失败的建行必须被真正重试过（不是"抛一次就忘"）',
  );
});

test('LP8. 语句超时/锁不可得（57014/55P03）⇒ PROVIDER_TIMEOUT，与 messages/store-pg.ts 同口径', async () => {
  const { pool } = makeRecordingPool({ fail: () => Object.assign(new Error('canceling statement'), { code: '57014' }) });
  const ledger = createPostgresModerationLedger({ pool, now: () => new Date(TS) });
  ledger.create(record());
  await assert.rejects(() => ledger.flush(), (error) => error.code === 'PROVIDER_TIMEOUT');
});

/** 社区权威 + 审核服务的最小真实装配（内存社区存储 + 替身端口），供写面 fail-closed 用例。 */
async function makeLiveService(ledger) {
  const store = createMemoryCommunityStore({ now: () => new Date(TS) });
  const authors = createLocalPseudonymousAuthorDirectory();
  const authority = createCommunityContentAuthority({ store, authors });
  await store.insertPost({
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
  }, null);
  const service = createModerationService({
    executionMode: 'stub',
    ports: { tms: passingPort() },
    authority,
    store: ledger,
  });
  return { store, service };
}

test('LP9. 写面 fail-closed：发布前 flush 拒绝 ⇒ publish 抛错，内容**不**翻 published（正负对照）', async () => {
  const inner = createModerationLedger();
  let armed = false;
  const hostile = {
    ...inner,
    async flush() {
      if (armed) throw Object.assign(new Error('pg down'), { code: 'ECONNREFUSED' });
    },
  };
  const { store, service } = await makeLiveService(hostile);
  const actor = USER_A;

  // ① 先送审（flush 未武装 ⇒ 通过），拿到可发布的结论。
  armed = false;
  const screening = await service.submitScreening({
    actor,
    content: { target_ref: TARGET, text: CLEAN, media: [] },
  });
  assert.equal(screening.overall.publishable, true, '正控制：干净正文必须可发布');

  // ② 武装 flush ⇒ 发布必须在翻可见性**之前**失败。
  armed = true;
  const admin = { ...USER_A, role: 'admin' };
  await assert.rejects(
    () => service.publish({ actor: admin, content: { target_ref: TARGET, text: CLEAN, media: [] } }),
    (error) => error.code === 'PROVIDER_UNAVAILABLE',
  );
  const after = await store.getPost(POST_ID);
  assert.equal(after.visibility, 'private', '落不了库就不许翻公开可见性');
  assert.equal(after.audit_state, 'pending', '审核态同样不得前进');

  // ③ 负控制的反面：解除武装后同一次发布通过（证明①的失败来自 flush，不是别的门禁）。
  armed = false;
  const published = await service.publish({ actor: admin, content: { target_ref: TARGET, text: CLEAN, media: [] } });
  assert.equal(published.published, true);
  const done = await store.getPost(POST_ID);
  assert.equal(done.visibility, 'published');
});

test('LP10. 装配缝：有连接池才注入持久台账（无池 ⇒ 内存台账，flush 不存在）', async () => {
  const harness = makeWiredHarness({ ports: { tms: passingPort() } });
  const ledger = harness.app?.moderationService?.ledger;
  // 内存装配下台账不可达（不导出），这里只钉"内存实现没有 flush 成员"这条接口事实。
  assert.equal(typeof createModerationLedger().flush, 'undefined', '内存台账没有 flush ⇒ 调用方 flush?.() 是空操作');
  assert.equal(ledger, undefined, '内存装配不暴露台账对象（不新增对外面）');
});

/** 真池的最小替身：只实现 `connect()`，把每条语句归一成短标签记下来。 */
function makeTransactionalPool(options = {}) {
  const seen = [];
  const failOn = options.failOn ?? null;
  const client = {
    async query(text) {
      const label = String(text).trim().split(/\s+/u)[0];
      seen.push(label);
      if (failOn !== null && label === failOn) {
        throw Object.assign(new Error('insert failed'), { code: '23505' });
      }
      return { rows: [] };
    },
    release() {
      seen.push('RELEASE');
    },
  };
  return {
    seen,
    pool: {
      async query() {
        throw new Error('真池路径不得绕过事务直连 query');
      },
      async connect() {
        return client;
      },
    },
  };
}

test('LP11. 真池路径（有 connect）：退位与插入包在同一个事务里，顺序 BEGIN → 退位 → 插入 → COMMIT → release', async () => {
  const { pool, seen } = makeTransactionalPool();
  const ledger = createPostgresModerationLedger({ pool, now: () => new Date(TS) });
  ledger.create(record());
  await ledger.flush();

  assert.deepEqual(seen, ['BEGIN', 'UPDATE', 'INSERT', 'COMMIT', 'RELEASE'], '退位与插入必须原子成对，连接必须归还');
});

test('LP12. 事务内失败 ⇒ ROLLBACK 后抛 PROVIDER_UNAVAILABLE，且连接一定 release（不留悬挂事务）', async () => {
  const { pool, seen } = makeTransactionalPool({ failOn: 'INSERT' });
  const ledger = createPostgresModerationLedger({ pool, now: () => new Date(TS) });
  const stored = ledger.create(record());
  await assert.rejects(() => ledger.flush(), (error) => error.code === 'PROVIDER_UNAVAILABLE');
  assert.deepEqual(seen, ['BEGIN', 'UPDATE', 'INSERT', 'ROLLBACK', 'RELEASE'], '失败路径必须回滚并归还连接');
  assert.equal(ledger.isDurable(stored), false, '回滚过的建行不算落库');

  // 再 flush 一次（队列已空）：必须**重放**那次失败，且同样回滚并归还连接——
  // 不允许"事务失败后空队列即放行"（#434 监工 P1）。
  seen.length = 0;
  await assert.rejects(() => ledger.flush(), (error) => error.code === 'PROVIDER_UNAVAILABLE');
  assert.deepEqual(seen, ['BEGIN', 'UPDATE', 'INSERT', 'ROLLBACK', 'RELEASE'], '重放同样必须回滚并归还连接（不留悬挂事务）');
});
