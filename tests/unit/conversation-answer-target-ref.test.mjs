// GY-R72 W40 · 问答作业 `target_ref.revision` 的口径钉子（`answer` 域与其它四域同形）。
//
// ── 被钉的口径 ─────────────────────────────────────────────────────────────
// 契约 `Job.target_ref` 回答的是「**这个作业作用在哪条记录、哪一版**」：`revision` 是**被指记录
// 自己**的版本，不是作业的状态迁移计数。真实形态见 `services/api/src/ocr/service.ts:282`：
//     target_ref: { type: 'ocr', id: row.ocrId, revision: ocr === null ? 1 : ocr.revision },
// 问答域的两处副本（`services/api/src/conversations/job.ts` 的 `projectTurnJob`、
// `services/api/src/conversations/service.ts` 的 `jobViewOf`）曾把作业快照里的 `turn.revision`
// 填进 `target_ref.revision`；而 `turn.revision` 是**作业**迁移计数（受理 1、claim +1、
// cancel +1、settle +1，见 `services/api/src/conversations/store.ts` 的
// `claimTurnJob`/`cancelTurnJob`/`settleTurnJob` 三处 `revision: record.revision + 1`）。
// 后果有两个，本文件两段分别钉住：
//   ① **同一作业在两个官方面上报出不同的目标版本**：管理台读面
//      `services/api/src/admin/ops/jobs-pg.ts` 对 `answer` 恒取 `UNCREATED_RECORD_REVISION = 1`
//      （理由见该文件 `:660-664`：answer 行不可修订），域内 `GET /jobs/{id}` 却随每次迁移往上跳；
//   ② **`target_ref` 会被作业迁移改写**：这正是别处已钉死的不变量
//      （`tests/unit/tts-jobs-http.test.mjs:290`「取消不得改写 target_ref」）。
//
// ── 真值 ─────────────────────────────────────────────────────────────────
// `target_ref.revision` = **回答行自己的** `revision`；回答行还没产出时取记录初始版本 `1`。
//
// ── 边界（别把本文件读成什么） ──────────────────────────────────────────────
// 本文件**不**主张"回答可修订"。今天 answer 行恒 `revision = 1`（`services/api/src/conversations/store.ts:80`
// 的插入、`20-login-roles.sql:1127-1128` 也没有 UPDATE 授权），T2/T3 里 `answer.revision = 3`、
// `turn.revision = 5 / answer.revision = 2` 是**构造出来的**记录，只用来证明投影取的是记录版本、
// 而不是把常数 1 写死；生产路径上那条分支恒取 1。T5 静态钉住"别处不必改"这件事实（管理台读面
// 与两个投影点必须继续同口径）。
//
// ── T4 的串行门（测试专用，语义零改动）──────────────────────────────────────
// T4 要观测"受理后、claim 前"这个窗口：`createTurn` 会在同一 tick 里发起 `scheduleAnswer`，
// 不挡一下就拿不到 `revision = 1` 的作业视图。所以这里给 store 包一层**只加等待**的
// `claimTurnJob`，并在检索端口上再挂一道-release 门（避免结算先于取消落地）。两道门都不改
// 任何状态谓词、不改返回值：claim 的 `revision + 1` 与状态迁移仍由 store 本体执行。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { projectTurnJob } from '../../services/api/src/conversations/job.ts';
import {
  createConversationGuard,
  createConversationService,
  createDeterministicAnswerComposer,
} from '../../services/api/src/conversations/service.ts';
import { createWiredRetrievalPort } from '../../services/api/src/conversations/guard.ts';
import { createDeterministicDoseAuthority } from '../../services/api/src/conversations/dose.ts';
import { createModerationRiskScreen } from '../../services/api/src/conversations/screen.ts';
import { createMemoryConversationStore } from '../../services/api/src/conversations/store.ts';
import { FROZEN_CLOCK, retrievalSet } from './conversation-fixtures.mjs';

const AT = new Date(Date.UTC(2026, 10, 1, 2, 0, 0));
const QUESTION = '稻田里的稗草怎么识别？';
const OWNER = 'user-t4-target-ref';
const CONVERSATION_ID = '2b1f5f5e-2d4a-4c1e-9b7a-0f1d2c3b4a51';
const TURN_ID = '9f1c0a7e-3d2b-4c8a-8f10-6b7e5d4c3a21';
const JOB_ID = '5c2d8e91-7a4f-4b3e-9d10-8e7f6a5b4c32';
const ANSWER_ID = 'c4a7b8d9-1e2f-4a3b-8c5d-9e0f1a2b3c43';

/** 合成 `TurnRecord`（字段集同 `services/api/src/conversations/types.ts:125`）。 */
function turnRecord(overrides = {}) {
  return {
    id: TURN_ID,
    revision: 1,
    conversation_id: CONVERSATION_ID,
    owner_id: OWNER,
    input_text: QUESTION,
    transcription_ref: null,
    job_id: JOB_ID,
    job_state: 'queued',
    job_deadline_at: new Date(AT.getTime() + 30_000),
    job_created_at: AT,
    job_error_code: null,
    answer_id: null,
    created_at: AT,
    updated_at: AT,
    ...overrides,
  };
}

/** 合成 `AnswerRecord`（字段集同 `services/api/src/conversations/types.ts:143`）。 */
function answerRecord(overrides = {}) {
  return {
    id: ANSWER_ID,
    revision: 1,
    turn_id: TURN_ID,
    owner_id: OWNER,
    status: 'answered',
    checked_text: '合成正文：只用于回归测试，不含真实用量建议。',
    check_state: 'passed',
    citations: [],
    dose_cards: [],
    model_version: 'unimplemented:no-real-model/test',
    prompt_version: 'unimplemented:no-real-prompt/test',
    rule_version: 'unimplemented:no-real-rule/test',
    created_at: AT,
    updated_at: AT,
    ...overrides,
  };
}

/** 身份对象（字段集同 `tests/unit/conversation-qa-source-recovery.test.mjs:347`）。 */
function identityOf(userId) {
  return {
    userId,
    authEpoch: 1,
    role: 'user',
    sessionId: `synthetic-session-${userId}`,
    expiresAt: new Date(AT.getTime() + 3600_000),
    revision: 1,
    scopes: ['user'],
  };
}

function deferred(label) {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { label, promise, resolve };
}

// ---------------------------------------------------------------------------
// T1–T3：两个投影点（`projectTurnJob` / `jobViewOf`）在记录版本上的行为
// ---------------------------------------------------------------------------

test('T1 回答行未产出 ⇒ target_ref.revision 恒为记录初始版本 1（作业 revision 是多少都不跟）', () => {
  for (const jobState of ['queued', 'running']) {
    for (const jobRevision of [1, 7]) {
      const turn = turnRecord({ revision: jobRevision, job_state: jobState });
      const job = projectTurnJob(turn, null);
      const label = `job_state=${jobState}、turn.revision=${jobRevision}`;

      assert.equal(
        job.target_ref.revision,
        1,
        `真值：回答行不存在 ⇒ 被指记录尚未产出，target_ref.revision 取记录初始版本 1（与 ` +
          `services/api/src/ocr/service.ts:282 的 ocr === null ? 1 同口径）；实得 ` +
          `${job.target_ref.revision}（${label}）。作业迁移计数不是被指记录的版本：受理=1、` +
          `claim=2、cancel=3、settle=4，跟它走会让「同一个还不存在的回答」报出四个不同版本。`,
      );
      // 反面判据：作业自己的版本必须照旧如实报（本片只动 target_ref，不动作业 revision）。
      assert.equal(
        job.revision,
        jobRevision,
        `作业自己的 revision 必须如实等于轮次行的迁移计数（${label}），` +
          `实得 ${job.revision}。`,
      );
      assert.deepEqual(
        job.target_ref,
        { type: 'answer', id: TURN_ID, revision: 1 },
        `target_ref 三键必须整体是「answer + 轮次 id + 记录初始版本 1」（${label}），` +
          `实得 ${JSON.stringify(job.target_ref)}。`,
      );
      assert.equal(
        job.result,
        null,
        `真值：${jobState} 状态没有回答行 ⇒ result 必须是 null（如实性硬边界，` +
          `services/api/src/conversations/service.ts:1100-1105），实得 ` +
          `${JSON.stringify(job.result)}。`,
      );
    }
  }
});

test('T2 回答行已产出 ⇒ target_ref.revision 取回答行自己的 revision（不是常数 1 写死）', () => {
  const one = projectTurnJob(turnRecord({ revision: 4, job_state: 'succeeded' }), answerRecord({ revision: 1 }));
  assert.equal(
    one.target_ref.revision,
    1,
    `真值：answer 行 revision=1 ⇒ target_ref.revision=1；实得 ${one.target_ref.revision}。` +
      `注意这条**也**在旧口径下为真（succeeded 时作业 revision 恰为 4，不该是 1）——` +
      `单看它区分不出新旧口径，所以 T1/T3 才是判据。`,
  );
  assert.equal(
    one.revision,
    4,
    `同一快照里作业 revision 仍如实报 4（与 target_ref.revision=1 互不影响），实得 ${one.revision}。`,
  );

  // 构造出来的假记录：只为证明取的是"记录版本"这条逻辑分支，生产路径恒 1（见文件头边界）。
  const three = projectTurnJob(
    turnRecord({ revision: 4, job_state: 'succeeded' }),
    answerRecord({ revision: 3 }),
  );
  assert.equal(
    three.target_ref.revision,
    3,
    `真值：answer 行 revision=3 ⇒ target_ref.revision=3（取记录版本，不写死 1）；` +
      `实得 ${three.target_ref.revision}。写成常数 1 的实现会在这里红。`,
  );
  assert.equal(
    three.revision,
    4,
    `作业 revision 与回答行 revision 是两个独立的数：同一快照里作业 4、目标 3，实得 ${three.revision}。`,
  );
});

test('T3 作业 revision 与回答行 revision 互不影响（5 与 2 同快照并存）', () => {
  const turn = turnRecord({ revision: 5, job_state: 'uncertain', answer_id: ANSWER_ID });
  const answer = answerRecord({ revision: 2 });
  const projected = projectTurnJob(turn, answer);
  assert.equal(
    projected.revision,
    5,
    `作业 revision 必须来自轮次行（turn.revision=5），实得 ${projected.revision}。`,
  );
  assert.equal(
    projected.target_ref.revision,
    2,
    `真值：target_ref.revision 必须来自**回答行**（answer.revision=2），实得 ` +
      `${projected.target_ref.revision}。旧口径在这里报 5；任何把两个数耦合起来的实现` +
      `（例如 target_ref.revision = turn.revision - 3 之类）都会在 T1/T3 之间自相矛盾。`,
  );
  assert.equal(
    projected.target_ref.id,
    TURN_ID,
    `target_ref.id 仍然是轮次 id（回答行由轮次唯一决定），实得 ${projected.target_ref.id}。`,
  );
  assert.equal(
    projected.state,
    'uncertain',
    `uncertain 也必须给 result（回答行在），实得 state=${projected.state}。`,
  );
  assert.notEqual(
    projected.result,
    null,
    `真值：state ∈ {succeeded, uncertain} 且回答行存在 ⇒ result 非 null，实得 ` +
      `${JSON.stringify(projected.result)}。`,
  );
});

// ---------------------------------------------------------------------------
// T4：真实服务层 —— 受理 → claim → 取消，作业 revision 1→2→3，target_ref.revision 恒 1
// ---------------------------------------------------------------------------

test('T4 服务层：作业 revision 1→2→3 期间 target_ref.revision 恒 1，取消不改写 target_ref', async () => {
  const claimGate = deferred('claim');
  const claimedSeen = deferred('claimed');
  const retrieveGate = deferred('retrieve');

  const raw = createMemoryConversationStore();
  const store = {
    ...raw,
    // 只加等待的 claim（语义零改动：`revision + 1` 与状态迁移仍由 store 本体执行）。
    async claimTurnJob(turnId, ownerId) {
      await claimGate.promise;
      const claimed = await raw.claimTurnJob(turnId, ownerId);
      claimedSeen.resolve(claimed);
      return claimed;
    },
  };
  const retrieval = createWiredRetrievalPort({
    note: '测试替身检索端口（本用例只把它当「受理之后、结算之前」的观察窗口，不查资料库）',
    async read(input) {
      await retrieveGate.promise;
      return retrievalSet(input.identity.userId, []);
    },
  });
  const service = createConversationService({
    store,
    retrieval,
    guard: createConversationGuard({ dose: createDeterministicDoseAuthority() }),
    composer: createDeterministicAnswerComposer(),
    // 规则层读墙钟（50ms 预算）：注入冻结时钟，判定仍走生产同一行代码，去掉时序抖动。
    riskScreen: createModerationRiskScreen({ clock: FROZEN_CLOCK }),
    now: () => new Date(AT),
    signingKey: 'synthetic-signing-key-not-a-real-key',
  });
  const identity = identityOf(OWNER);

  const created = await service.createConversation(identity, {}, { idempotencyKey: 'idem-t4-conv' });
  assert.equal(created.status, 201, `建会话应 201：${JSON.stringify(created.data)}`);

  const accepted = await service.createTurn(
    { identity, token: 'synthetic-bearer-not-a-real-token' },
    created.data.id,
    { input_type: 'text', text: QUESTION },
    { idempotencyKey: 'idem-t4-turn', ifMatch: '"1"' },
  );
  assert.equal(accepted.status, 202, `受理应 202：${JSON.stringify(accepted.data)}`);
  const jobId = accepted.data.id;
  assert.equal(
    accepted.data.revision,
    1,
    `前提：受理后作业 revision 必须还是 1（claim 被串行门挡住），实得 ${accepted.data.revision}。`,
  );
  assert.equal(
    accepted.data.target_ref.revision,
    1,
    `真值：受理时还没有回答行 ⇒ target_ref.revision=1（旧口径在这里也报 1，本行不区分新旧；` +
      `它是后面三处读数的基线）。实得 ${accepted.data.target_ref.revision}。`,
  );

  // ---- 放行 claim：作业 revision 必须真的 +1（否则"恒 1"这条判据是空的）----
  claimGate.resolve();
  const claimed = await claimedSeen.promise;
  assert.equal(
    claimed.revision,
    2,
    `前提：claim 必须真的发生并把作业 revision 推到 2，实得 ${claimed.revision}。` +
      `若这里不是 2，说明串行门改变了 store 语义——本用例的其余断言都不再可信。`,
  );
  assert.equal(
    claimed.job_state,
    'running',
    `前提：claim 后作业状态应为 running，实得 ${claimed.job_state}。`,
  );

  const afterClaim = await service.findByJobId({ userId: identity.userId, jobId });
  assert.notEqual(afterClaim, null, 'claim 之后必须能按作业 id 取回轮次。');
  assert.equal(afterClaim.turn.revision, 2, `读面读到的作业 revision 应为 2，实得 ${afterClaim.turn.revision}。`);
  const jobAfterClaim = service.jobViewOf(afterClaim.turn, afterClaim.answer);
  assert.equal(
    jobAfterClaim.revision,
    2,
    `作业自己的 revision 必须如实报 2（迁移计数），实得 ${jobAfterClaim.revision}。`,
  );
  assert.equal(
    jobAfterClaim.target_ref.revision,
    1,
    `真值：claim 让**作业** revision 从 1 跳到 2，但**被指记录**（还没有回答行）仍是初始版本 1；` +
      `实得 ${jobAfterClaim.target_ref.revision}。旧口径在这里报 2 —— 这就是"同一作业在两个官方` +
      `面上报不同目标版本"的那一半（管理台读面恒 1）。`,
  );
  assert.notEqual(
    jobAfterClaim.target_ref.revision,
    jobAfterClaim.revision,
    `target_ref.revision（${jobAfterClaim.target_ref.revision}）必须与作业 revision` +
      `（${jobAfterClaim.revision}）解耦。`,
  );

  const cancelled = await service.cancelTurn({
    userId: identity.userId,
    jobId,
    ifMatch: '"2"',
    idempotencyKey: 'idem-t4-cancel',
  });
  assert.equal(cancelled.status, 200, `取消应 200：${JSON.stringify(cancelled.data)}`);
  assert.equal(cancelled.data.revision, 3, `取消应把作业 revision 推到 3，实得 ${cancelled.data.revision}。`);
  assert.equal(cancelled.data.state, 'cancelled', `取消后状态应为 cancelled，实得 ${cancelled.data.state}。`);
  assert.equal(
    cancelled.data.target_ref.revision,
    1,
    `真值：取消是**作业**迁移，被指记录的版本不变 ⇒ target_ref.revision 仍 1；实得 ` +
      `${cancelled.data.target_ref.revision}。旧口径在这里报 3 —— 一次取消就把目标版本改写了。`,
  );

  const afterCancel = await service.findByJobId({ userId: identity.userId, jobId });
  assert.notEqual(afterCancel, null, '取消之后必须仍能按作业 id 取回轮次。');
  const jobAfterCancel = service.jobViewOf(afterCancel.turn, afterCancel.answer);
  assert.equal(jobAfterCancel.revision, 3, `取消后作业 revision 应为 3，实得 ${jobAfterCancel.revision}。`);

  // 「取消不得改写 target_ref」—— 与 `tests/unit/tts-jobs-http.test.mjs:290` 同一条不变量。
  assert.deepEqual(
    jobAfterCancel.target_ref,
    accepted.data.target_ref,
    `取消不得改写 target_ref：受理时 ${JSON.stringify(accepted.data.target_ref)}，` +
      `取消后 ${JSON.stringify(jobAfterCancel.target_ref)}。`,
  );
  assert.deepEqual(
    jobAfterCancel.target_ref,
    jobAfterClaim.target_ref,
    `claim 也不得改写 target_ref：claim 后 ${JSON.stringify(jobAfterClaim.target_ref)}，` +
      `取消后 ${JSON.stringify(jobAfterCancel.target_ref)}。`,
  );

  // ---- 迟到的生成结果不得落回答行（取消在存储层堵住），顺带证明上面"没有回答行"是真的 ----
  retrieveGate.resolve();
  await service.drain();
  const settled = await service.findByJobId({ userId: identity.userId, jobId });
  assert.notEqual(settled, null, 'drain 之后必须仍能按作业 id 取回轮次。');
  assert.equal(
    settled.answer,
    null,
    `真值：取消后迟到的生成结果不得落回答行（settleTurnJob 的状态谓词不命中），` +
      `实得 ${JSON.stringify(settled.answer)}。`,
  );
  assert.equal(settled.turn.job_state, 'cancelled', `drain 之后作业状态应仍是 cancelled，实得 ${settled.turn.job_state}。`);
  assert.equal(
    settled.turn.revision,
    3,
    `真值：落空的结算不得再推进作业 revision（应是 3，不是 4），实得 ${settled.turn.revision}。`,
  );
  assert.equal(
    service.jobViewOf(settled.turn, settled.answer).target_ref.revision,
    1,
    `drain 之后 target_ref.revision 仍必须是 1（终态读面同口径）。`,
  );
});

// ---------------------------------------------------------------------------
// T5：静态钉 —— 别处与本域的读面必须继续同口径
// ---------------------------------------------------------------------------

const STALE_TARGET_REF = /target_ref:\s*\{[^}]*type:\s*'answer'[^}]*revision:\s*turn\.revision[^}]*\}/;
const FRESH_TARGET_REF =
  /target_ref:\s*\{ type: 'answer', id: turn\.id, revision: answer === null \? 1 : answer\.revision \}/;

function readRepoFile(relativePath) {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
}

test('T5 静态钉：管理台读面仍以 UNCREATED_RECORD_REVISION=1 兜 answer 目标版本，两个投影点不再跟作业 revision', () => {
  const adminJobsPg = readRepoFile('services/api/src/admin/ops/jobs-pg.ts');
  const jobSource = readRepoFile('services/api/src/conversations/job.ts');
  const conversationService = readRepoFile('services/api/src/conversations/service.ts');

  // ① 管理台读面这两行是"answer 行不可修订"的机器判据，本片不得改它（改了就是放宽口径）。
  assert.equal(
    adminJobsPg.includes('const UNCREATED_RECORD_REVISION = 1;'),
    true,
    '管理台读面必须仍声明 const UNCREATED_RECORD_REVISION = 1;（services/api/src/admin/ops/jobs-pg.ts）。' +
      '这两行是"answer 行不可修订、目标版本恒 1"的机器判据；本片只改问答域两处投影，不改读面。',
  );
  assert.equal(
    adminJobsPg.includes('revision: targetRevision ?? UNCREATED_RECORD_REVISION'),
    true,
    '管理台读面必须仍以 revision: targetRevision ?? UNCREATED_RECORD_REVISION 兜底' +
      '（services/api/src/admin/ops/jobs-pg.ts）。它若被删/被改，说明有人在放宽口径而不是修投影点。',
  );

  // ② 两个投影点（各一处）都已换成记录版本，且旧写法一处不剩。
  for (const [file, source] of [
    ['services/api/src/conversations/job.ts', jobSource],
    ['services/api/src/conversations/service.ts', conversationService],
  ]) {
    assert.equal(
      STALE_TARGET_REF.test(source),
      false,
      `${file} 仍存在 target_ref 里填 turn.revision 的写法：${JSON.stringify(
        (source.match(STALE_TARGET_REF) ?? [])[0],
      )}。真值：target_ref.revision 取被指记录（回答行）的版本，未产出时取 1，绝不跟作业 revision 走。`,
    );
    assert.equal(
      FRESH_TARGET_REF.test(source),
      true,
      `${file} 必须保留 target_ref: { type: 'answer', id: turn.id, revision: answer === null ? 1 : answer.revision }` +
        ' 这行整行写法（与 services/api/src/ocr/service.ts:282 同口径）。',
    );
    // 作业自己的 revision 那一行必须还在（本片只换 target_ref 那一行，不顺手删作业 revision）。
    const turnRevisionLines = source.match(/revision: turn\.revision\b/g) ?? [];
    assert.equal(
      turnRevisionLines.length,
      1,
      `${file} 里 revision: turn.revision 应恰好剩 1 处（作业快照的 revision 键），` +
        `实得 ${turnRevisionLines.length} 处 —— 多出说明旧写法没清干净，为 0 说明把作业 revision 也误改了。`,
    );
  }
});
