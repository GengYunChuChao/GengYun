// GY-R71 · G3：「隐私类失败在**异步作业面**保留原码」的可执行钉子。
//
// 缺陷（GY-R70 登记，`docs/architecture/acceptance-map.md` 末节 G3）：`settleCodeOf`
// （`services/api/src/conversations/service.ts`）只认 `instanceof ApiError`；问答外发口
// （`services/api/src/privacy/task-egress.ts`）抛的却是 `PrivacyError`
// （`packages/privacy/errors.mjs`，**不是** `ApiError`）。于是
//   403 `CONSENT_REQUIRED`（需要用途授权）、409 `OBJECT_UNAVAILABLE`（对象取不到）、
//   400 `INVALID_REQUEST`
// 在作业面**统统落成** 503 `PROVIDER_UNAVAILABLE` —— 与「供应商挂了」同码同 state，
// 客户端无法把「去授权」（用户动作）与「重试/报运维」（时间或运维动作）分开。
//
// 本文件只做四件事（不改任何语义）：
//   P1 **四码矩阵**：作业面 `state` + `error_code` 保留原码；封套仍是契约九键、且**没有** `retryable`
//      （`retryable` 不进作业封套这条冻结口径由 P1 与既有 D6 共同钉住）。
//   P2 **可分流性**：三个隐私码与 `PROVIDER_UNAVAILABLE` 在作业面**同 state、四码互不相同** ——
//      唯一判据是 `error_code`，且每码的 HTTP 语义（403/409/400/503）取自契约同一张表。
//   P3 **未被波及（折叠口径未放宽）**：域外异常仍一律折成 `PROVIDER_UNAVAILABLE` ——
//      普通 `Error`、自带闭集码的第三方错误对象、`PrivacyError` 携带**闭集外**码，三者逐一断言。
//   P4 **未被波及（`ApiError` 分支不变）**：`ApiError('PROVIDER_UNAVAILABLE')` 仍是该码、
//      `ApiError('PROVIDER_TIMEOUT')` 仍落 `timed_out`（不是 `failed`）。
//
// 取证手法：P1 的前三行不是"测试替身随手抛一个码"，而是把本轮**真的**交给
// `createChatEgress(...).send`（生产同一个 `ChatEgress` 实现），由账本/在途守卫替身在
// **与生产同一行**的位置抛出**同一条** `PrivacyError`（异常文案与码逐字对齐被引用的源码行）。
// P4 的正向对照断言这些替身**确实被走到**，因此"码是从守卫路径出来的"不是自我声明。
//
// 全部离线：回环 HTTP 夹具、无 PG、无真实模型调用、无真实外发、无任何凭据。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONVERSATIONS,
  JOBS,
  conversationFixture,
  loadSchema,
  retrievalItem,
  retrievalSet,
} from './conversation-fixtures.mjs';
import { createWiredRetrievalPort } from '../../services/api/src/conversations/guard.ts';
import { projectTurnJob } from '../../services/api/src/conversations/job.ts';
import { ERROR_STATUS_MAP } from '../../services/api/src/contract.ts';
import { ApiError } from '../../services/api/src/errors.ts';
import { createChatEgress } from '../../services/api/src/privacy/task-egress.ts';
import { PrivacyError } from '../../packages/privacy/errors.mjs';

const QUESTION = '稻田里的稗草怎么识别？';

const ITEM = retrievalItem({
  id: '2c0d4a30-6d9b-4f5b-9d70-5c1b2b0a7f11',
  title: '合成资料甲：稗草的识别（测试替身）',
  body: '稗草的识别要点：合成正文，仅用于回归，不含真实用量建议。',
});

/** 契约 `Job` 的必填键（现读契约，不手抄键名）。 */
const JOB_REQUIRED = loadSchema('Job').required;

/** 码 → 契约状态码（`ERROR_STATUS_MAP` 是唯一权威，不手抄）。 */
function statusOfCode(code) {
  for (const [status, codes] of Object.entries(ERROR_STATUS_MAP)) {
    if (codes.includes(code)) return Number(status);
  }
  return null;
}

/**
 * 外发账本 + 在途守卫**替身**：只实现 `ChatEgress.send` 真正会调用的方法，
 * 并允许在指定位置抛出指定的 `PrivacyError`（其余位置按成功返回）。
 *
 * 记账顺序的记录（`calls`）用于 P4 的正向对照：证明失败确实发生在守卫路径上，
 * 而不是被测试替身回答器提前伪造。
 */
function egressDoubles({ failAt = null, error = null } = {}) {
  const calls = [];
  const ledger = {
    async resolveRecipient(input) {
      calls.push(['resolveRecipient', input]);
      if (failAt === 'resolveRecipient') throw error;
      return 'recipient-synthetic-r71';
    },
    async reserve(input) {
      calls.push(['reserve', input]);
      if (failAt === 'reserve') throw error;
      return { id: '00000000-0000-4000-8f00-0000000000a1', userId: input.userId, objectRevision: input.objectRevision };
    },
    async markSent(exportId) {
      calls.push(['markSent', exportId]);
      if (failAt === 'markSent') throw error;
      return { userId: 'synthetic-owner', objectRevision: 1 };
    },
    async markFailed(exportId, payload) {
      calls.push(['markFailed', exportId, payload]);
    },
  };
  const inFlight = {
    async assertExecutable(input) {
      calls.push(['assertExecutable', input]);
      if (failAt === 'assertExecutable') throw error;
    },
    async saveResult(input) {
      calls.push(['saveResult', input]);
    },
  };
  return { ledger, inFlight, calls };
}

/**
 * 回答器替身：把本轮**原样**交给真实 `ChatEgress.send`（reserve → assertExecutable →
 * markSent → 外发 → saveResult 的生产顺序一行不差），本片不产出任何正文。
 */
function composerOnEgress(egress, { objectId } = {}) {
  return {
    kind: 'live_model',
    note: '测试替身回答器：本轮经真实 ChatEgress.send 派出，失败码由守卫路径决定',
    async compose(input) {
      const context = input.egress;
      assert.ok(context !== undefined, '服务层必须把外发记账上下文交给回答器');
      return egress.send({
        userId: context.userId,
        authEpoch: context.authEpoch,
        objectId: objectId === undefined ? context.objectId : objectId,
        objectRevision: context.objectRevision,
        call: async () => ({ choices: [] }),
        outcomeOf: () => ({ kind: 'answered' }),
      });
    },
  };
}

/** 回答器替身：直接抛出给定的错误（不经过外发口，用于 P3/P4 的"域外/其它分支"行）。 */
function composerThrowing(error) {
  return {
    kind: 'deterministic_guard_only',
    note: '测试替身回答器：直接抛出给定错误（不产出正文、不外发）',
    async compose() {
      throw error;
    },
  };
}

/** 检索端口替身（不查资料库；集合非空，避免走到"无依据不外发"的短路）。 */
function retrievalWith(items) {
  return {
    retrieval: createWiredRetrievalPort({
      note: '测试替身检索端口（不查资料库）',
      read: async (input) => retrievalSet(input.identity.userId, items),
    }),
  };
}

/** 受理一轮（202）并读回作业封套（`GET /jobs/{id}` 的 200）。 */
async function ask(t, { composer, tag }) {
  const fixture = await conversationFixture(t, { injection: { composer, ...retrievalWith([ITEM]) } });
  const conversationId = (await fixture.createConversation({}, { tag })).body.data.id;
  const read = await fixture.call('GET', `${CONVERSATIONS}/${conversationId}`);
  assert.equal(read.status, 200);
  const accepted = await fixture.createTurn(
    conversationId,
    read.body.data.revision,
    { input_type: 'text', text: QUESTION },
    { tag },
  );
  assert.equal(accepted.status, 202, `受理应 202：${JSON.stringify(accepted.body)}`);
  assertJobShape(accepted.body.data);

  const service = fixture.app.conversationService;
  assert.ok(service !== null, '夹具必须装配问答服务');
  const found = await service.findByJobId({ userId: fixture.a.user.id, jobId: accepted.body.data.id });
  assert.notEqual(found, null, '结算后必须能按作业 id 取回轮次');

  // 两个投影点**都直接判**（绕开 `GET /jobs/{id}` 的契约闸门 `registry.assertContractJob`）：
  // 这道闸门本身也会拦住契约外键，但它把违规折成 503，看不出是"哪个键多出来了"；
  // 而这两个断言在任何一层放宽时都会红，并直接指出 `retryable` 不在九键里。
  //   · `jobViewOf`（服务层，202 与读面共用）
  //   · `projectTurnJob`（`answer` 作业源的投影）
  assertJobShape(service.jobViewOf(found.turn, found.answer));
  assertJobShape(projectTurnJob(found.turn, found.answer));

  const job = await fixture.call('GET', `${JOBS}/${accepted.body.data.id}`);
  assert.equal(job.status, 200, `作业读面应 200（码不在契约闭集时这里会是 503）：${JSON.stringify(job.body)}`);
  assertJobShape(job.body.data);
  return job.body.data;
}

/** 作业封套必须是契约 `Job` 的**恰好**九键（多一个 `retryable` 都算契约外字段）。 */
function assertJobShape(job) {
  assert.deepEqual(Object.keys(job).sort(), [...JOB_REQUIRED].sort(), 'Job 键集必须恰好是契约声明的九键');
  assert.equal(
    Object.prototype.hasOwnProperty.call(job, 'retryable'),
    false,
    '作业封套不承载 retryable（契约九键已冻结，GY-R70 G2）',
  );
}

// ---------------------------------------------------------------------------
// P1 四码矩阵
// ---------------------------------------------------------------------------

test('P1 四码矩阵：隐私类失败在作业面保留原码，封套仍恰好九键且无 retryable', async (t) => {
  const rows = [
    {
      name: 'CONSENT_REQUIRED（同意缺失）',
      expected: 'CONSENT_REQUIRED',
      expectedStatus: 403,
      // 与 `services/api/src/privacy/ledger-pg.ts:521` 同码同文案：外发账本解析不到唯一接收方。
      build: () => {
        const doubles = egressDoubles({
          failAt: 'resolveRecipient',
          error: new PrivacyError('CONSENT_REQUIRED', '当前用途授权没有唯一可用接收方（或尚未核验）'),
        });
        const egress = createChatEgress({ ...doubles, executionMode: 'real' });
        return { composer: composerOnEgress(egress), doubles };
      },
    },
    {
      name: 'OBJECT_UNAVAILABLE（对象取不到）',
      expected: 'OBJECT_UNAVAILABLE',
      expectedStatus: 409,
      // 与 `packages/privacy/in-flight.mjs:151` 同码同文案：外发已终态（撤回/取消）后禁止继续执行。
      build: () => {
        const doubles = egressDoubles({
          failAt: 'markSent',
          error: new PrivacyError('OBJECT_UNAVAILABLE', '外发已终态（revoked），禁止继续执行'),
        });
        const egress = createChatEgress({ ...doubles, executionMode: 'real' });
        return { composer: composerOnEgress(egress), doubles };
      },
    },
    {
      name: 'INVALID_REQUEST（对象键非法）',
      expected: 'INVALID_REQUEST',
      expectedStatus: 400,
      // 真路径：`services/api/src/privacy/task-egress.ts` 的 `CHAT_OBJECT_KEY` 校验（含空格即非法），
      // 抛出点在任何账本调用之前 ⇒ 零预留、零外发。
      build: () => {
        const doubles = egressDoubles();
        const egress = createChatEgress({ ...doubles, executionMode: 'real' });
        return { composer: composerOnEgress(egress, { objectId: 'not a valid object key' }), doubles };
      },
    },
    {
      name: 'PROVIDER_UNAVAILABLE（PrivacyError 载体，非 real 模式 fail-closed）',
      expected: 'PROVIDER_UNAVAILABLE',
      expectedStatus: 503,
      // 真路径：`task-egress.ts` 的 `!engaged` 分支。**这一行必须保持原码**（不得因本片改动而漂移）。
      build: () => {
        const doubles = egressDoubles();
        const egress = createChatEgress({ ledger: doubles.ledger, inFlight: doubles.inFlight, executionMode: 'stub' });
        return { composer: composerOnEgress(egress), doubles };
      },
    },
    {
      name: 'PROVIDER_UNAVAILABLE（ApiError 载体，供应商侧失败）',
      expected: 'PROVIDER_UNAVAILABLE',
      expectedStatus: 503,
      build: () => ({
        composer: composerThrowing(new ApiError('PROVIDER_UNAVAILABLE', '供应商不可用（测试替身）', { retryable: true })),
        doubles: null,
      }),
    },
  ];

  // 先构造每一行的外发口/回答器（**每个** `build()` 只调用一次：账本替身的 `calls` 是逐行记账的证据）。
  const built = rows.map((row) => ({ ...row, ...row.build() }));

  const observed = [];
  for (const [index, row] of built.entries()) {
    const job = await ask(t, { composer: row.composer, tag: `p1-${index}` });

    assert.equal(job.state, 'failed', `${row.name}：非超时失败一律 failed`);
    assert.equal(job.error_code, row.expected, `${row.name}：作业面必须保留原码`);
    assert.equal(job.result, null, `${row.name}：失败作业不得携带结果`);
    assert.equal(statusOfCode(row.expected), row.expectedStatus, `${row.name}：该码的契约状态取自同一张表`);
    assertJobShape(job);

    observed.push({ name: row.name, state: job.state, code: job.error_code, status: statusOfCode(job.error_code) });
  }

  // P2 可分流性：四个码在作业面上**同 state、互不相同**；三者的状态码分别是 403/409/400/503。
  // 这一条就是把"客户端能不能分流"写成断言 —— 唯一判据只能是 error_code。
  assert.deepEqual(
    observed.map((row) => row.state),
    ['failed', 'failed', 'failed', 'failed', 'failed'],
    '四码在作业面同 state（FAILED），说明分流判据只能落在 error_code 上',
  );
  const codes = new Set(observed.map((row) => row.code));
  assert.equal(codes.size, 4, `四码必须互不相同，实得：${[...codes].join(',')}`);
  assert.deepEqual(
    [...codes].sort(),
    ['CONSENT_REQUIRED', 'INVALID_REQUEST', 'OBJECT_UNAVAILABLE', 'PROVIDER_UNAVAILABLE'],
    '四码集合必须与派单点名的四码逐字一致',
  );
  assert.deepEqual(
    observed.map((row) => row.status),
    [403, 409, 400, 503, 503],
    '每码的 HTTP 语义（403 授权 / 409 对象 / 400 请求 / 503 供应商）必须是契约里那一档',
  );

  // P4 正向对照：失败确实发生在守卫路径上（不是回答器伪造的码）。
  const consent = built[0].doubles;
  assert.deepEqual(
    consent.calls.map((call) => call[0]),
    ['resolveRecipient'],
    'CONSENT_REQUIRED 必须发生在预留之前：零预留、零外发',
  );
  const unavailable = built[1].doubles;
  assert.deepEqual(
    unavailable.calls.map((call) => call[0]),
    ['resolveRecipient', 'reserve', 'assertExecutable', 'markSent'],
    'OBJECT_UNAVAILABLE 必须发生在 markSent 上（执行前重查通过后才到授权边界）',
  );
  assert.equal(
    unavailable.calls.some((call) => call[0] === 'markFailed'),
    false,
    'markSent 抛出发生在 ChatEgress.send 的 try 之外 ⇒ 不得被写回成「已失败记账」的假象',
  );
  const invalid = built[2].doubles;
  assert.deepEqual(invalid.calls, [], '对象键非法必须挡在任何账本调用之前（零预留、零外发）');
});

// ---------------------------------------------------------------------------
// P3 未被波及：折叠口径本身没有放宽
// ---------------------------------------------------------------------------

test('P3 未被波及：域外异常仍一律折成 PROVIDER_UNAVAILABLE（折叠口径未被放宽）', async (t) => {
  const cases = [
    {
      name: '普通 Error（无 code）',
      error: new Error('域外异常（测试替身）'),
    },
    {
      name: '第三方错误对象自带闭集码（鸭子类型）',
      // 这一行是**负空间**断言：证明本片没有把 `settleCodeOf` 放宽成"任意 {code} 形状"，
      // 只认 `ApiError` / `PrivacyError` 两个类。若有人日后改成鸭子类型，这一行立刻变红。
      error: Object.assign(new Error('第三方 SDK 错误（测试替身）'), { code: 'CONSENT_REQUIRED' }),
    },
    {
      name: 'PrivacyError 携带契约闭集外的码',
      // `isErrorCode` 守卫仍在：闭集外的码不得进作业封套（否则 `GET /jobs/{id}` 的
      // `assertContractJob` 会 503，等于把"读不到"当成失败原因）。
      error: new PrivacyError('NOT_A_CONTRACT_CODE', '闭集外的码（测试替身）'),
    },
  ];

  for (const [index, row] of cases.entries()) {
    const job = await ask(t, { composer: composerThrowing(row.error), tag: `p3-${index}` });
    assert.equal(job.state, 'failed', `${row.name}：失败仍如实落 failed`);
    assert.equal(job.error_code, 'PROVIDER_UNAVAILABLE', `${row.name}：域外异常仍一律折叠`);
    assertJobShape(job);
  }
});

// ---------------------------------------------------------------------------
// P4 未被波及：ApiError 分支与 PROVIDER_TIMEOUT 的状态映射
// ---------------------------------------------------------------------------

test('P4 未被波及：ApiError 分支不变（PROVIDER_UNAVAILABLE 仍是该码，PROVIDER_TIMEOUT 仍落 timed_out）', async (t) => {
  const codeCase = await ask(t, {
    composer: composerThrowing(new ApiError('PROVIDER_UNAVAILABLE', '供应商不可用（测试替身）', { retryable: false })),
    tag: 'p4-code',
  });
  assert.equal(codeCase.state, 'failed');
  assert.equal(codeCase.error_code, 'PROVIDER_UNAVAILABLE');
  assertJobShape(codeCase);

  // 超时是**唯一**映射到 `timed_out` 的码：`state` 不因本片改动而漂移。
  const timeout = await ask(t, {
    composer: composerThrowing(new ApiError('PROVIDER_TIMEOUT', '供应商超时（测试替身）', { retryable: true })),
    tag: 'p4-timeout',
  });
  assert.equal(timeout.state, 'timed_out', 'PROVIDER_TIMEOUT 必须落 timed_out（不是 failed）');
  assert.equal(timeout.error_code, 'PROVIDER_TIMEOUT');
  assertJobShape(timeout);
});
