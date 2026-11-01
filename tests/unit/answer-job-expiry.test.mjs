/**
 * GY-R72（W34）：作业读面超时裁定（问答域）单测。
 *
 * 缺陷：轮次的作业状态是**受理时写在轮次行上的快照**，进程重启 / 提供者卡死 / store 抛错之后
 * 没有任何人把它推到终态，于是 `GET /jobs/{id}` **永远**回 `queued` / `running`，用户界面上的
 * 「处理中」永不结束。同一缺陷在合成域（`services/api/src/tts/service.ts` 的 `adjudicateExpiredJob`）
 * 与 OCR 域（`services/api/src/ocr/service.ts` 的 `adjudicateExpiredOcrJob`）已经修过，问答域是
 * 核心链路上最后一个。
 *
 * 判据（派单 §2）：
 *   T1 `queued` + 已过期 ⇒ `timed_out` + `PROVIDER_TIMEOUT`、revision 恰好 +1、`result === null`；
 *   T2 `running` + 已过期 ⇒ 同上；
 *   T3 终态即使过期也**一个字都不动**，且**一次写都不尝试**（`settleTurnJob` 调用 0 次）；
 *   T4 未过期（`deadline + 宽限 - 1ms`）⇒ 原样，一次写都没有；
 *   T5 宽限边界**含等号**：`deadline + 5000ms` 整点即裁定，`-1ms` 不裁定；
 *   T6 幂等/并发：连读两次只自增一次；CAS 抢不到 ⇒ 返回 store 现值，不谎报一个自己没写成的终态；
 *   T7 宽限**只有一处定义**（全仓扫源码）：`services/api/src/jobs/expiry.ts`，问答服务里没有第二份；
 *   T8 裁定**不写回答**、不碰其它写路径；越权/不存在仍是 `null`（404 口径不因裁定而变）。
 *
 * 读面一律走**生产那条适配层**（`createAnswerJobSource().get` → `deps.findByJobId` →
 * `service.findByJobId`），断言的是出站契约 `Job`；只有要看 `updated_at` 这类不出站字段时才直接
 * 调 `service.findByJobId`。时钟一律注入（`deps.now`），不读真实时钟：宽限与时序都要可复算。
 *
 * 诚实边界（必须与实现一起读）：`services/api/src/app.ts:2556` 的装配把 answer 源的 `findByJobId`
 * 接到了 `service.store.findTurnByJobId`，**绕过** `service.findByJobId`。本片按派单只改服务层
 * （`app.ts` 在禁区），因此真实 HTTP 读面在本片之后仍未修复 —— 本文件证明的是**服务层语义**，
 * 不是"线上 GET /jobs/{id} 已经不会再卡 queued"。见交付报告「诚实边界」。
 *
 * 断言一律先判 `typeof` / 具体键，再判值；不使用「只要不抛错就算通过」的写法。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JOB_EXPIRY_GRACE_MS, isDeadlineExpired } from '../../services/api/src/jobs/expiry.ts';
import { JOB_EXPIRY_GRACE_MS as TTS_JOB_EXPIRY_GRACE_MS } from '../../services/api/src/tts/service.ts';
import { createAnswerJobSource } from '../../services/api/src/conversations/job.ts';
import {
  createConversationGuard,
  createConversationService,
  createDeterministicAnswerComposer,
} from '../../services/api/src/conversations/service.ts';
import { createUnwiredRetrievalPort } from '../../services/api/src/conversations/guard.ts';
import { createDeterministicDoseAuthority } from '../../services/api/src/conversations/dose.ts';
import { createMemoryConversationStore } from '../../services/api/src/conversations/store.ts';

// ---------------------------------------------------------------- 辅助

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const USER = 'user-owner-0001';
const OTHER_USER = 'user-intruder-0002';
/** 受理时刻（固定，不读真实时钟）。 */
const T0 = new Date('2026-11-01T00:00:00.000Z');
/** 作业截止时长（与服务的 `jobDeadlineMs` 同值；断言不依赖那个常量本身）。 */
const DEADLINE_MS = 30 * 1000;
/** 默认截止时刻（本文件所有夹具都从这里起算宽限边界）。 */
const DEADLINE = new Date(T0.getTime() + DEADLINE_MS);

/** 冻结时刻（差一毫秒也不能错）：返回新的 `Date`，避免调用方改写共享值。 */
function at(ms) {
  return new Date(ms);
}

function atDeadlinePlus(deadlineAt, deltaMs) {
  return at(deadlineAt.getTime() + deltaMs);
}

/**
 * 计数用的 store 包装：**每一个写方法**的调用次数，外加 `settleTurnJob` 的逐次入参。
 *
 * 为什么不能只看 `revision`：「写一次」与「写两次但第二次被 CAS 拒掉」在结果上完全相同，
 * 而「读面在终态上仍然尝试写」正是本片最容易漏掉的那条（见 T3）。
 *
 * @param {ReturnType<typeof createMemoryConversationStore>} store
 */
function instrumentStore(store) {
  const WRITE_METHODS = [
    'insertConversation',
    'deleteConversation',
    'insertTurn',
    'deleteTurn',
    'claimTurnJob',
    'cancelTurnJob',
    'settleTurnJob',
    'deleteAllByOwner',
  ];
  const state = { counts: Object.create(null), settleTurnJob: [] };

  for (const name of WRITE_METHODS) {
    assert.equal(typeof store[name], 'function', `内存 store 缺少写方法 ${name}（夹具与端口脱节）`);
    const original = store[name].bind(store);
    store[name] = async (...args) => {
      state.counts[name] = (state.counts[name] ?? 0) + 1;
      if (name === 'settleTurnJob') state.settleTurnJob.push(structuredClone(args[0]));
      return original(...args);
    };
  }

  return {
    state,
    reset() {
      for (const key of Object.keys(state.counts)) delete state.counts[key];
      state.settleTurnJob.length = 0;
    },
    /** 当前各写方法的调用次数（只列非零项，便于 `deepEqual` 直接判「只写了这一次」）。 */
    writes() {
      return { ...state.counts };
    },
  };
}

/**
 * 组装服务 + 生产同形作业源。
 *
 * `cancelJob` 照 `app.ts:2558-2563` 的装配接到域内 `cancelTurn`（本文件不测取消面，但**端口要真接**，
 * 否则将来有人把 'answer' 源的 cancel 改成桩实现也没人发现）。
 */
function boot({ at: startAt = T0 } = {}) {
  const store = createMemoryConversationStore();
  const instrument = instrumentStore(store);
  const clock = { at: startAt };

  const service = createConversationService({
    store,
    // 读面不查资料（本文件只判读面的状态裁定）；用未接线端口而非自造替身，避免"看起来查了"。
    retrieval: createUnwiredRetrievalPort(),
    guard: createConversationGuard({ dose: createDeterministicDoseAuthority() }),
    composer: createDeterministicAnswerComposer(),
    signingKey: 'synthetic-signing-key-not-a-real-key',
    jobDeadlineMs: DEADLINE_MS,
    now: () => at(clock.at.getTime()),
  });

  const source = createAnswerJobSource({
    findByJobId: async ({ userId, jobId }) => service.findByJobId({ userId, jobId }),
    cancelJob: async ({ userId, jobId, ifMatch, idempotencyKey }) =>
      (await service.cancelTurn({ userId, jobId, ifMatch, idempotencyKey })).data,
  });

  return { store, service, source, clock, instrument };
}

/** 直接向内存 store 落一条轮次行（精确构造 queued / running / 终态现场，不经过受理与执行器）。 */
async function seedTurn(store, overrides = {}) {
  const record = {
    id: randomUUID(),
    conversation_id: randomUUID(),
    owner_id: USER,
    input_text: '合成问题：稗草怎么识别？（测试替身，不含真实用量建议）',
    transcription_ref: null,
    job_id: randomUUID(),
    job_state: 'queued',
    job_deadline_at: DEADLINE,
    job_created_at: T0,
    job_error_code: null,
    created_at: T0,
    ...overrides,
  };
  await store.insertTurn(record);
  return record;
}

/** 回答落库输入（只用于把终态夹具做成"确实有结果"的那种终态）。 */
function answerInput(turnId, overrides = {}) {
  return {
    id: randomUUID(),
    turn_id: turnId,
    owner_id: USER,
    status: 'answered',
    checked_text: '合成回答正文（测试替身，不含真实用量建议）',
    check_state: 'passed',
    citations: [],
    dose_cards: [],
    model_version: 'unimplemented:no-real-model/1',
    prompt_version: 'unimplemented:no-real-prompt/1',
    rule_version: 'unimplemented:no-real-rule/1',
    created_at: T0,
    ...overrides,
  };
}

/** 读面（生产适配层）：契约 `Job` 或 `null`（不存在/越权同形）。 */
async function readJob(harness, { userId = USER, jobId }) {
  return await harness.source.get({ userId, jobId });
}

// ---------------------------------------------------------------------------
// T1 / T2：非终态 + 已过期 ⇒ 读面落 timed_out
// ---------------------------------------------------------------------------

/**
 * 两条非终态共用的判据。`state` 只影响夹具的初始行，断言完全相同 —— 这正是要钉的：
 * `queued` 与 `running` 在执行器缺席时应该有**同一个**结局。
 */
async function assertSettlesToTimedOut(harness, state) {
  const turn = await seedTurn(harness.store, { job_state: state });
  harness.clock.at = atDeadlinePlus(turn.job_deadline_at, JOB_EXPIRY_GRACE_MS + 1);
  harness.instrument.reset();

  const job = await readJob(harness, { jobId: turn.job_id });

  assert.notEqual(job, null, '已存在且未越权的作业不得读成 null');
  assert.equal(job.id, turn.job_id, '裁定的不是另一个作业（job id 必须原样）');
  assert.equal(job.kind, 'answer');
  assert.equal(job.state, 'timed_out', `${state} + 过期必须裁定为 timed_out（不是 ${job.state}）`);
  assert.equal(job.error_code, 'PROVIDER_TIMEOUT', '裁定必须用契约闭集内的 PROVIDER_TIMEOUT');
  assert.equal(job.revision, 1 + 1, `裁定必须让 revision 恰好 +1（实得 ${job.revision}）`);
  assert.equal(job.result, null, 'timed_out 不产出回答 ⇒ result 必须为 null');
  assert.equal(job.deadline_at, turn.job_deadline_at.toISOString(), '裁定不改截止时刻');
  assert.equal(job.created_at, turn.job_created_at.toISOString(), '裁定不改受理时刻');

  // 写**恰好一次**，且入参逐项正确：`answer` 为 null、`at` 是注入的裁定时刻。
  assert.deepEqual(harness.instrument.writes(), { settleTurnJob: 1 }, '裁定只能写一次、且只走 settleTurnJob');
  const [call] = harness.instrument.state.settleTurnJob;
  assert.equal(call.turnId, turn.id);
  assert.equal(call.ownerId, USER, '写必须带归属谓词（owner 一次都不能少）');
  assert.equal(call.state, 'timed_out');
  assert.equal(call.errorCode, 'PROVIDER_TIMEOUT');
  assert.equal(call.answer, null, '读面裁定不是一次执行的产物 ⇒ 绝不写回答');
  assert.equal(
    call.at.getTime(),
    harness.clock.at.getTime(),
    '`at` 必须是裁定时刻（不是 deadline、不是 job_created_at）—— 否则 updated_at 会写错',
  );

  // 落库后的内部字段（不出现在契约 Job 里，但决定下一次读面的判断）。
  const reread = await harness.service.findByJobId({ userId: USER, jobId: turn.job_id });
  assert.notEqual(reread, null);
  assert.equal(reread.turn.job_state, 'timed_out');
  assert.equal(reread.turn.job_error_code, 'PROVIDER_TIMEOUT');
  assert.equal(reread.answer, null, '裁定不得挂上任何回答行');
  assert.equal(reread.turn.updated_at.getTime(), harness.clock.at.getTime(), 'updated_at 必须取裁定时刻');
  assert.equal(reread.turn.revision, 2);
}

test('T1 queued + 过期 ⇒ timed_out + PROVIDER_TIMEOUT，revision 恰好 +1，result === null', async () => {
  const harness = boot();
  await assertSettlesToTimedOut(harness, 'queued');
});

test('T2 running + 过期 ⇒ timed_out + PROVIDER_TIMEOUT，revision 恰好 +1，result === null', async () => {
  const harness = boot();
  await assertSettlesToTimedOut(harness, 'running');
});

// ---------------------------------------------------------------------------
// T3：终态永不动（连"尝试写"都不许有）
// ---------------------------------------------------------------------------

/**
 * 五个终态（派单点名四个 + `timed_out` 自己）逐态判两件事：
 *   ① 读面出站对象**逐字不变**（含 `result`：成功作业仍读得出结果，绝不因过期被改写成超时）；
 *   ② `settleTurnJob` 调用 **0 次** —— 只看 ① 不够：少了终态判定后 CAS 也会拒写，出站结果一模一样，
 *      只有"有没有去写"能区分"判了终态"与"没判、被 CAS 救了"。
 *
 * 夹具用**真实迁移**构造（seed queued → settleTurnJob），`succeeded` / `uncertain` 挂真回答行，
 * 这样 `result` 是非 null 的结构，才谈得上"逐字不变"。
 */
async function buildTerminalTurn(harness, state) {
  const turn = await seedTurn(harness.store, { job_state: 'queued' });
  const keepsAnswer = state === 'succeeded' || state === 'uncertain';
  const settled = await harness.store.settleTurnJob({
    turnId: turn.id,
    ownerId: USER,
    state,
    errorCode: state === 'failed' ? 'PROVIDER_UNAVAILABLE' : null,
    answer: keepsAnswer ? answerInput(turn.id) : null,
    at: T0,
  });
  assert.notEqual(settled, null, `夹具迁移必须成立：queued → ${state}`);
  return settled;
}

test('T3 终态（succeeded/uncertain/failed/cancelled/timed_out）即使过期也一个字都不动，且一次写都不尝试', async () => {
  const states = ['succeeded', 'uncertain', 'failed', 'cancelled', 'timed_out'];
  for (const state of states) {
    const harness = boot();
    const settled = await buildTerminalTurn(harness, state);

    // 先取"没过期时刻"的读数作为基准 —— 此时读面本来就不该裁定，基准才干净。
    harness.clock.at = T0;
    const before = await readJob(harness, { jobId: settled.job_id });
    assert.notEqual(before, null);
    assert.equal(before.state, state, `基准读数必须是 ${state}（实得 ${before.state}）`);
    if (state === 'succeeded' || state === 'uncertain') {
      assert.notEqual(before.result, null, `${state} 必须真的有结果（否则"不变"没有意义）`);
      assert.equal(before.result.kind, 'answer');
    } else {
      assert.equal(before.result, null, `${state} 按如实性不变式不得带结果`);
    }

    // 再把时钟推到过期之后重读：逐字不变 + 零写。
    harness.clock.at = atDeadlinePlus(settled.job_deadline_at, JOB_EXPIRY_GRACE_MS + 60 * 1000);
    harness.instrument.reset();
    const after = await readJob(harness, { jobId: settled.job_id });

    assert.deepEqual(after, before, `终态 ${state} 在过期后必须逐字不变（state/revision/result 全等）`);
    assert.deepEqual(harness.instrument.writes(), {}, `终态 ${state} 的读面不得尝试写（settleTurnJob 必须 0 次）`);
  }
});

// ---------------------------------------------------------------------------
// T4 / T5：未过期不裁定；宽限边界含等号
// ---------------------------------------------------------------------------

test('T4 未过期 ⇒ 原样返回 queued / running，一次写都没有', async () => {
  for (const state of ['queued', 'running']) {
    const harness = boot();
    const turn = await seedTurn(harness.store, { job_state: state });
    harness.clock.at = atDeadlinePlus(turn.job_deadline_at, JOB_EXPIRY_GRACE_MS - 1);
    harness.instrument.reset();

    const job = await readJob(harness, { jobId: turn.job_id });

    assert.notEqual(job, null);
    assert.equal(job.state, state, `未过期不得裁定（${state} 被写成了 ${job.state}）`);
    assert.equal(job.revision, 1, '未过期不得自增 revision');
    assert.equal(job.error_code, null);
    assert.equal(job.result, null, 'queued/running 不带结果');
    assert.deepEqual(harness.instrument.writes(), {}, '未过期时读面必须一个字都不写');
  }
});

test('T5 宽限边界含等号：deadline + 5000ms 整点即裁定，+4999ms 不裁定', async () => {
  // 边界口径本身（纯函数，与读面共用同一份实现）。
  assert.equal(isDeadlineExpired(DEADLINE, atDeadlinePlus(DEADLINE, JOB_EXPIRY_GRACE_MS)), true, '含等号');
  assert.equal(isDeadlineExpired(DEADLINE, atDeadlinePlus(DEADLINE, JOB_EXPIRY_GRACE_MS - 1)), false);

  const exact = boot();
  const exactTurn = await seedTurn(exact.store);
  exact.clock.at = atDeadlinePlus(exactTurn.job_deadline_at, JOB_EXPIRY_GRACE_MS);
  const exactJob = await readJob(exact, { jobId: exactTurn.job_id });
  assert.equal(exactJob.state, 'timed_out', '恰好在 deadline + 宽限这一刻就必须裁定（否则同一份数据给两个答案）');
  assert.equal(exactJob.revision, 2);

  const before = boot();
  const beforeTurn = await seedTurn(before.store);
  before.clock.at = atDeadlinePlus(beforeTurn.job_deadline_at, JOB_EXPIRY_GRACE_MS - 1);
  before.instrument.reset();
  const beforeJob = await readJob(before, { jobId: beforeTurn.job_id });
  assert.equal(beforeJob.state, 'queued', '差 1 毫秒不得裁定：毫秒级提交竞态让给执行器');
  assert.equal(beforeJob.revision, 1);
  assert.deepEqual(before.instrument.writes(), {});
});

// ---------------------------------------------------------------------------
// T6：幂等 / 并发（CAS 抢不到不许自造终态）
// ---------------------------------------------------------------------------

test('T6a 连读两次 revision 只 +1：第二次已在终态，不再自增、不再写', async () => {
  const harness = boot();
  const turn = await seedTurn(harness.store);
  harness.clock.at = atDeadlinePlus(turn.job_deadline_at, JOB_EXPIRY_GRACE_MS + 1);

  harness.instrument.reset();
  const first = await readJob(harness, { jobId: turn.job_id });
  assert.equal(first.state, 'timed_out');
  assert.equal(first.revision, 2);
  assert.deepEqual(harness.instrument.writes(), { settleTurnJob: 1 });

  harness.instrument.reset();
  const second = await readJob(harness, { jobId: turn.job_id });
  assert.deepEqual(second, first, '第二次读必须与第一次逐字相同');
  assert.equal(second.revision, 2, '已裁定的终态再读不得自增 revision');
  assert.deepEqual(harness.instrument.writes(), {}, '第二次读一次写都不许有');
});

test('T6b CAS 抢不到 ⇒ 返回 store 现值（不谎报自己没写成的 timed_out）', async () => {
  const harness = boot();
  const turn = await seedTurn(harness.store);
  harness.clock.at = atDeadlinePlus(turn.job_deadline_at, JOB_EXPIRY_GRACE_MS + 1);

  // 模拟并发：另一个裁定者/取消方先落 `cancelled`，本次 CAS 因此拿不到行。
  const wrapped = harness.store.settleTurnJob;
  harness.store.settleTurnJob = async (input) => {
    await wrapped({ ...input, state: 'cancelled', errorCode: null });
    return null;
  };
  try {
    const job = await readJob(harness, { jobId: turn.job_id });
    assert.equal(job.state, 'cancelled', `CAS 失手必须如实回 store 现值 cancelled，实得 ${job.state}`);
    assert.equal(job.error_code, null, 'cancelled 的 error_code 必须为 null（不是自己编的 PROVIDER_TIMEOUT）');
    assert.equal(job.revision, 2, '返回的是并发方写成的那一版');
    assert.equal(job.result, null);
  } finally {
    harness.store.settleTurnJob = wrapped;
  }

  // 落库事实必须仍是并发方写的 cancelled：读面绝不覆盖别人已经落下的终态。
  const stored = await harness.service.findByJobId({ userId: USER, jobId: turn.job_id });
  assert.notEqual(stored, null);
  assert.equal(stored.turn.job_state, 'cancelled');
  assert.equal(stored.turn.job_error_code, null);
});

// ---------------------------------------------------------------------------
// T7：宽限只有一处定义
// ---------------------------------------------------------------------------

test('T7 宽限全仓只有一处定义（jobs/expiry.ts），问答服务里没有第二份', () => {
  // 判据串**拼**出来，免得本文件自己成为第二处匹配（自指会让这条钉子永远假绿）。
  const NEEDLE = ['export', 'const', 'JOB_EXPIRY_GRACE_MS'].join(' ');
  const SOURCE_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
  const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.local', '.pg17', 'coverage', '.cache']);

  const hits = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const dot = entry.name.lastIndexOf('.');
      if (dot < 0 || !SOURCE_EXT.has(entry.name.slice(dot))) continue;
      const full = join(dir, entry.name);
      if (statSync(full).size > 2 * 1024 * 1024) continue;
      const text = readFileSync(full, 'utf8');
      if (!text.includes(NEEDLE)) continue;
      hits.push(full.slice(REPO_ROOT.length + 1).replaceAll('\\', '/'));
    }
  };
  walk(REPO_ROOT);

  assert.deepEqual(
    hits,
    ['services/api/src/jobs/expiry.ts'],
    `宽限只许在 jobs/expiry.ts 定义一处，实得 ${JSON.stringify(hits)}（多一处 = 将来只改一处就会两种说法）`,
  );

  const conversationService = readFileSync(join(REPO_ROOT, 'services/api/src/conversations/service.ts'), 'utf8');
  assert.equal(
    conversationService.includes(NEEDLE),
    false,
    '问答服务不得定义第二份宽限：它只许 from jobs/expiry.ts 取',
  );
  assert.equal(conversationService.includes('isDeadlineExpired'), true, '问答服务必须复用共享的过期判据');

  // 值本身与"同源"：合成域的 re-export 必须就是同一个数字（不是各自抄了一份常量）。
  assert.equal(typeof JOB_EXPIRY_GRACE_MS, 'number');
  assert.equal(JOB_EXPIRY_GRACE_MS, 5 * 1000, '宽限口径必须仍是 5 秒');
  assert.equal(TTS_JOB_EXPIRY_GRACE_MS, JOB_EXPIRY_GRACE_MS, '合成域必须是同一份宽限（re-export）');
});

// ---------------------------------------------------------------------------
// T8：裁定不写回答；越权/不存在口径不变
// ---------------------------------------------------------------------------

test('T8 裁定不写回答、不碰其它写路径；越权与不存在仍是 null 且不改别人的状态', async () => {
  const harness = boot();
  const turn = await seedTurn(harness.store);
  harness.clock.at = atDeadlinePlus(turn.job_deadline_at, JOB_EXPIRY_GRACE_MS + 1);
  harness.instrument.reset();

  const job = await readJob(harness, { jobId: turn.job_id });
  assert.equal(job.state, 'timed_out', '正控制：这一条先要求裁定真的发生了，否则下面"没写回答"是空话');

  assert.equal(harness.instrument.state.settleTurnJob.length, 1, '裁定必须恰好调用一次 settleTurnJob');
  for (const call of harness.instrument.state.settleTurnJob) {
    assert.equal(call.answer, null, 'settleTurnJob 的 answer 必须是 null（读面裁定不是一次执行的产物）');
  }
  assert.deepEqual(
    harness.instrument.writes(),
    { settleTurnJob: 1 },
    '读面除这一条 CAS 之外不得触碰任何写方法（受理/认领/取消/删除都不许）',
  );

  const snapshot = harness.store.snapshot();
  assert.equal(snapshot.answers.length, 0, '裁定不得产出任何回答行');
  assert.equal(snapshot.turns.length, 1);
  assert.equal(snapshot.turns[0].answer_id, null, '轮次行不得挂上回答');

  // 存储端口上**没有**独立的回答写入方法：回答只能由 settleTurnJob 在同一次 CAS 里落库。
  for (const name of ['insertAnswer', 'writeAnswer', 'saveAnswer', 'upsertAnswer', 'createAnswer']) {
    assert.equal(typeof harness.store[name], 'undefined', `存储端口不得有独立的回答写入方法 ${name}`);
  }

  // 越权：同形 null，且**不得**替别人裁定（否则等于绕过归属谓词替他人改状态）。
  const foreign = await seedTurn(harness.store, { job_state: 'queued' });
  harness.instrument.reset();
  const denied = await readJob(harness, { userId: OTHER_USER, jobId: foreign.job_id });
  assert.equal(denied, null, '越权必须与不存在同形（null）');
  assert.deepEqual(harness.instrument.writes(), {}, '越权读不得写任何东西');
  // 归属判定要看**存储行**本身，不能再用读面看：这个夹具的时钟已经过期，属主读面会（正确地）
  // 自己裁定一次 —— 那就分不清"越权读动了别人的行"还是"我后来自己动的"了。
  const foreignRow = await harness.store.findTurnByJobId(foreign.job_id, USER);
  assert.notEqual(foreignRow, null);
  assert.equal(foreignRow.turn.job_state, 'queued', '别人的作业不得被我的读面裁定');
  assert.equal(foreignRow.turn.revision, 1);

  // 不存在：同样 null，且同样零写。
  harness.instrument.reset();
  const missing = await readJob(harness, { jobId: randomUUID() });
  assert.equal(missing, null, '不存在必须为 null');
  assert.deepEqual(harness.instrument.writes(), {}, '不存在的作业读面不得写任何东西');
});

// ---------------------------------------------------------------------------
// T9：生产接线钉子（读面裁定必须真的被接到 `GET /jobs/{id}` 上）
// ---------------------------------------------------------------------------

/**
 * 为什么要有这条：T1–T8 证明的是**服务层**语义（`service.findByJobId`）。可是 `GET /jobs/{id}`
 * 并不直接调服务层 —— 它经 `jobs/registry.ts` → `createAnswerJobSource().get` →
 * `AnswerJobSourceDeps.findByJobId`。装配层（`services/api/src/app.ts`）此前把这个端口接成了
 * `service.store.findTurnByJobId(jobId, userId)`，**绕过** `service.findByJobId`：
 * 服务层的六步裁定于是永远不会被走到，单测全绿而线上 `queued` 永不结束 —— 这正是本片要修的缺陷。
 *
 * 所以这条钉子钉的是**接线**，不是行为：谁把那一行改回绕过，这里立刻红。
 * （本机没有 HTTP 层运行证据；生产路径的连通性由这条文本钉子 + `app.ts:2556` 的单行改动共同保证。）
 */
test('T9 生产接线钉子：app.ts 的 answer 作业源必须走 service.findByJobId，不得绕过到 service.store', () => {
  const appSource = readFileSync(join(REPO_ROOT, 'services/api/src/app.ts'), 'utf8');

  const START = 'createAnswerJobSource({';
  const first = appSource.indexOf(START);
  assert.notEqual(first, -1, `app.ts 里找不到 ${START}：answer 作业源的唯一注册点不见了（装配被改动了？）`);
  assert.equal(
    appSource.indexOf(START, first + START.length),
    -1,
    `${START} 出现了不止一次：本钉子只认那一个唯一注册点，多出来的注册点需要人工核`,
  );

  const END = '\n    }),';
  const end = appSource.indexOf(END, first);
  assert.notEqual(end, -1, 'answer 作业源那段没有闭合（`}),` 找不到）：装配形状变了，钉子需要跟着改');
  const block = appSource.slice(first, end);

  assert.equal(
    block.includes('service.findByJobId({ userId, jobId })'),
    true,
    'app.ts 的 answer 作业源必须走 service.findByJobId（否则读面的六步超时裁定永远不会被走到，'
      + '线上 GET /jobs/{id} 会永远回 queued/running —— 本片修的正是这个）',
  );
  assert.equal(
    block.includes('service.store.findTurnByJobId'),
    false,
    'app.ts 的 answer 作业源不得绕过服务层直接读 service.store：那样绕过了超时裁定、'
      + '也绕过了服务层对越权/不存在/终态的全部口径',
  );
  // 未装配（real + 无池）时仍须回 null（与"越权/不存在"同形 404），不许 503、不许抛。
  assert.equal(
    block.includes('if (service === null) return null;'),
    true,
    '未装配服务的分支必须保留：`return null`（404 同形），不得改成抛错/503',
  );
});
