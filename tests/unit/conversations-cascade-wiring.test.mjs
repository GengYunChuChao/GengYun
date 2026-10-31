// GY-I12（#12 AC②）R72 片：**删轮次时的语音转写清理接线**
// （`services/api/src/conversations/cascade-wiring.ts`）。
//
// 本文件只驱动适配器本身（零 app、零真库、零真实语音域）：语音域用**记录型替身**，
// 断言的是「按 `transcription_ref` 分派到哪个口、用哪个 revision、失败如何折叠」。
// 不重复驱动 `conversations/service.ts` 的删除顺序（那条由 `tests/unit/conversation-*.test.mjs`
// 与 HTTP 臂覆盖），也不假装覆盖真库上的软删语义。
//
// 授权口径（派单 §2.1/§3，一条都不能放宽）：
//   - `null` / 未知类型 ⇒ 转写腿不动语音域；处置由**外发腿**决定（恒 `unwired`）；
//   - `NOT_FOUND`（读或删）⇒ `cleaned`（目标已不在，无可级联）；
//   - `REVISION_CONFLICT` ⇒ 重读 + 重试**一次**；仍冲突 ⇒ `failed`；
//   - 其它错误 ⇒ `failed` + `onError` 恰好一次；**绝不向上抛**；
//   - 成功路径的处置**绝不能**是 `initiated`（外发腿没接，谎报就是造假）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../../services/api/src/errors.ts';
import {
  TURN_CASCADE_IDEMPOTENCY_PREFIX,
  createConversationCascadePort,
  turnCascadeIdempotencyKey,
} from '../../services/api/src/conversations/cascade-wiring.ts';

const USER = '00000000-0000-4000-8a00-0000000000a1';
const CONVERSATION = '00000000-0000-4000-8b00-0000000000b1';
const TURN = '00000000-0000-4000-8c00-0000000000c1';
const TRANSCRIPTION = '00000000-0000-4000-8d00-0000000000d1';

const apiError = (code) => new ApiError(code, `synthetic ${code}`);

/**
 * 记录型替身：只记**调用顺序与入参**，不做任何 I/O。
 *
 * - `revisions`：第 n 次 `getTranscription` 返回的 revision（末项重复使用）；
 * - `getErrors` / `deleteOutcomes`：按第 n 次调用抛错（`null`/缺省 = 成功）。
 */
function speechFixture({ revisions = [3], getErrors = [], deleteOutcomes = [] } = {}) {
  const calls = { get: [], delete: [] };
  const api = {
    async getTranscription(input) {
      calls.get.push(input);
      const failure = getErrors[calls.get.length - 1];
      if (failure !== undefined && failure !== null) throw failure;
      const revision = revisions[Math.min(calls.get.length - 1, revisions.length - 1)];
      return { id: input.transcriptionId, revision };
    },
    async deleteTranscription(input) {
      calls.delete.push(input);
      const failure = deleteOutcomes[calls.delete.length - 1];
      if (failure !== undefined && failure !== null) throw failure;
      return { accepted: true };
    },
  };
  return { calls, api };
}

/** 一条「语音轮次」的级联请求（`transcription_ref` 是服务端写入的快照：revision=9 已过期）。 */
function request(overrides = {}) {
  return {
    userId: USER,
    conversationId: CONVERSATION,
    turnId: TURN,
    transcriptionRef: { type: 'transcription', id: TRANSCRIPTION, revision: 9 },
    answerId: null,
    ...overrides,
  };
}

/** 装配「已接线端口 + 故障观测口」，返回端口与观测记录。 */
function portWith(fixture) {
  const errors = [];
  const port = createConversationCascadePort({
    speech: fixture.api,
    onError: (error, detail) => errors.push({ error, detail }),
  });
  return { port, errors };
}

// ===========================================================================
// 1. 无音频可级联 / 未知目标类型：转写腿零调用，处置由外发腿决定（unwired）
// ===========================================================================

test('1) transcriptionRef: null ⇒ 处置 unwired（外发腿），deleteTranscription 零调用', async () => {
  const fixture = speechFixture();
  const { port, errors } = portWith(fixture);

  const outcome = await port.initiate(request({ transcriptionRef: null }));

  assert.equal(outcome.disposition, 'unwired', '外发腿恒 unsupported ⇒ 整体如实为 unwired');
  assert.notEqual(outcome.disposition, 'initiated', '⛔ 不得因为"没有音频"就谎称级联已完成');
  assert.notEqual(outcome.disposition, 'failed', '⛔ 无音频不是失败');
  assert.equal(fixture.calls.delete.length, 0, '没有转写可删 ⇒ deleteTranscription 必须零调用');
  assert.equal(fixture.calls.get.length, 0, '没有转写可读 ⇒ getTranscription 也必须零调用');
  assert.deepEqual(errors, [], '这不是错误路径 ⇒ onError 不得被调');

  // 未知目标类型：同样不碰语音域，但必须**如实披露为未接线**，而不是 cleaned 也不是 failed。
  const unknown = speechFixture();
  const unknownPort = portWith(unknown);
  const unknownOutcome = await unknownPort.port.initiate(
    request({ transcriptionRef: { type: 'media', id: TRANSCRIPTION, revision: 1 } }),
  );
  assert.equal(unknownOutcome.disposition, 'unwired', '未知目标类型 ⇒ unsupported ⇒ unwired（不猜该删哪张表）');
  assert.equal(unknown.calls.get.length, 0);
  assert.equal(unknown.calls.delete.length, 0);
  assert.deepEqual(unknownPort.errors, []);
});

// ===========================================================================
// 2. happy path：先读**当前** revision（不是快照 9），按 If-Match 软删一次
// ===========================================================================

test('2) happy：读回 revision 3 ⇒ 用 "3" 调 delete 一次 ⇒ 处置仍是 unwired，且端口 kind=wired/available=true', async () => {
  const fixture = speechFixture({ revisions: [3] });
  const { port, errors } = portWith(fixture);

  const outcome = await port.initiate(request());

  assert.equal(port.kind, 'wired', '端口自述必须是已接线');
  assert.equal(port.available, true, '端口可用性必须对调用方可见');
  assert.equal(fixture.calls.get.length, 1, '必须先读当前 revision');
  assert.equal(fixture.calls.delete.length, 1, '恰好一次软删');
  const [deleteInput] = fixture.calls.delete;
  assert.equal(deleteInput.ifMatch, '"3"', 'If-Match 用**当前** revision 3（快照 9 已过期，拿它删必 409）');
  assert.equal(deleteInput.userId, USER, '归属只能取轮次行的 owner，不得来自客户端');
  assert.equal(deleteInput.transcriptionId, TRANSCRIPTION);
  assert.equal(
    deleteInput.idempotencyKey,
    `${TURN_CASCADE_IDEMPOTENCY_PREFIX}${USER}:${TURN}:3`,
    '幂等键确定性：只由 (userId, turnId, revision) 派生',
  );
  assert.equal(outcome.disposition, 'unwired', '转写已清、外发未接 ⇒ 披露仍是 unwired（不是 initiated）');
  assert.notEqual(outcome.disposition, 'initiated');
  assert.deepEqual(errors, [], '成功路径不得触发 onError');
});

// ===========================================================================
// 3. 读不到 = 已经没了（不是"读失败当已清理"）
// ===========================================================================

test('3) 读 NOT_FOUND ⇒ cleaned（不调 delete）', async () => {
  const fixture = speechFixture({ getErrors: [apiError('NOT_FOUND')] });
  const { port, errors } = portWith(fixture);

  const outcome = await port.initiate(request());

  assert.equal(outcome.disposition, 'unwired', '转写腿 cleaned + 外发腿 unsupported ⇒ unwired');
  assert.notEqual(outcome.disposition, 'failed', '⛔ 目标不存在不是失败');
  assert.equal(fixture.calls.delete.length, 0, '读不到就不猜、不蛮删');
  assert.deepEqual(errors, [], 'NOT_FOUND 是正常收敛路径，不进 onError');
});

test('4) delete 抛 NOT_FOUND ⇒ cleaned', async () => {
  const fixture = speechFixture({ revisions: [5], deleteOutcomes: [apiError('NOT_FOUND')] });
  const { port, errors } = portWith(fixture);

  const outcome = await port.initiate(request());

  assert.equal(outcome.disposition, 'unwired');
  assert.notEqual(outcome.disposition, 'failed', '⛔ 删的时候已经没了（并发软删）不得记 failed');
  assert.equal(fixture.calls.delete.length, 1, 'NOT_FOUND 不重试');
  assert.equal(fixture.calls.delete[0].ifMatch, '"5"');
  assert.deepEqual(errors, []);
});

// ===========================================================================
// 5. 冲突：重读 + 重试恰好一次
// ===========================================================================

test('5) REVISION_CONFLICT 一次后成功 ⇒ cleaned（delete 2 次，第二次的 if-match 用新 revision）', async () => {
  const fixture = speechFixture({
    revisions: [3, 4],
    deleteOutcomes: [apiError('REVISION_CONFLICT'), null],
  });
  const { port, errors } = portWith(fixture);

  const outcome = await port.initiate(request());

  assert.equal(outcome.disposition, 'unwired');
  assert.notEqual(outcome.disposition, 'failed', '重试成功后不得仍记 failed');
  assert.equal(fixture.calls.delete.length, 2, '冲突后重试恰好一次');
  assert.equal(fixture.calls.delete[0].ifMatch, '"3"');
  assert.equal(fixture.calls.delete[1].ifMatch, '"4"', '第二次必须用重读后的新 revision（拿旧值重试必然再冲突）');
  assert.equal(fixture.calls.get.length, 2, '冲突后必须重读，不能靠快照');
  assert.notEqual(
    fixture.calls.delete[0].idempotencyKey,
    fixture.calls.delete[1].idempotencyKey,
    'revision 变了幂等键必须跟着变（同键不同 If-Match 会撞 IDEMPOTENCY_CONFLICT）',
  );
  assert.deepEqual(errors, [], '冲突一次后成功不是失败路径');
});

// ===========================================================================
// 6. 非冲突错误：如实 failed + onError 一次，绝不外抛
// ===========================================================================

test('6) 非冲突错误 ⇒ 处置 failed、onError 恰好被调 1 次、错误不外抛', async () => {
  const boom = new Error('synthetic db down');
  const fixture = speechFixture({ revisions: [3], deleteOutcomes: [boom] });
  const { port, errors } = portWith(fixture);

  const outcome = await port.initiate(request()).then(
    (value) => value,
    (error) => ({ threw: error }),
  );

  assert.equal(outcome.threw, undefined, '绝不向上抛：级联失败不得把已完成的轮次删除改写成异常');
  assert.equal(outcome.disposition, 'failed', '非冲突错误 ⇒ 如实 failed（不重试、不谎称已清理）');
  assert.notEqual(outcome.disposition, 'unwired', '⛔ 不许把"清理失败"降级成"未接线"掩盖掉');
  assert.equal(fixture.calls.delete.length, 1, '非冲突错误不重试');
  assert.equal(errors.length, 1, 'onError 恰好被调一次');
  assert.equal(errors[0].error, boom, 'onError 必须拿到原始错误（不是包装过的字符串）');
  assert.deepEqual(errors[0].detail, { transcriptionId: TRANSCRIPTION }, '观测细节只带转写 id，不带正文');

  // 读侧的非 NOT_FOUND 错误同形：failed + onError，且绝不调 delete。
  const readBoom = apiError('PROVIDER_UNAVAILABLE');
  const readFixture = speechFixture({ getErrors: [readBoom] });
  const readPort = portWith(readFixture);
  const readOutcome = await readPort.port.initiate(request());
  assert.equal(readOutcome.disposition, 'failed', '读失败（非 404）必须 failed，⛔ 不得当已清理');
  assert.equal(readFixture.calls.delete.length, 0);
  assert.equal(readPort.errors.length, 1);
  assert.equal(readPort.errors[0].error, readBoom);
});

// ===========================================================================
// 7. 幂等键：确定性（无时间戳/随机数），随 revision 变
// ===========================================================================

test('7) 幂等键确定性：同 (userId, turnId, revision) 两次调用同一 key；revision 变则 key 变', async () => {
  const fixture = speechFixture({ revisions: [3, 3] });
  const { port } = portWith(fixture);

  await port.initiate(request());
  await port.initiate(request());

  const [first, second] = fixture.calls.delete;
  assert.equal(first.idempotencyKey, second.idempotencyKey, '同一 (userId, turnId, revision) 必须同键（可幂等去重）');
  assert.equal(
    turnCascadeIdempotencyKey({ userId: USER, turnId: TURN, revision: 3 }),
    first.idempotencyKey,
    '纯函数口径：键 = turn-cascade:<userId>:<turnId>:<revision>',
  );
  assert.match(first.idempotencyKey, /^turn-cascade:[0-9a-f-]{36}:[0-9a-f-]{36}:3$/, '键形状固定，无时间戳/随机数');
  assert.ok(
    first.idempotencyKey.length >= 8 && first.idempotencyKey.length <= 128,
    '落在契约幂等键长度区间（8..128）',
  );

  const moved = turnCascadeIdempotencyKey({ userId: USER, turnId: TURN, revision: 4 });
  assert.notEqual(moved, first.idempotencyKey, 'revision 前进 ⇒ 键必须变（否则重试会撞 IDEMPOTENCY_CONFLICT）');
  assert.notEqual(
    turnCascadeIdempotencyKey({ userId: USER, turnId: TURN, revision: 3 }),
    turnCascadeIdempotencyKey({ userId: USER, turnId: '00000000-0000-4000-8c00-0000000000c2', revision: 3 }),
    'turnId 不同 ⇒ 键不同',
  );
});

// ===========================================================================
// 8. 外发腿没谎报：任何成功路径都不能是 initiated
// ===========================================================================

test('8) 成功后处置绝不能是 initiated（证明外发腿没谎报）', async () => {
  // 三条「转写腿都成功」的路径：无音频 / 直接删成功 / 冲突一次后成功。
  const cases = [
    ['transcriptionRef: null', speechFixture(), { transcriptionRef: null }],
    ['一次删成功', speechFixture({ revisions: [2] }), {}],
    ['冲突后重试成功', speechFixture({ revisions: [1, 2], deleteOutcomes: [apiError('REVISION_CONFLICT')] }), {}],
  ];
  for (const [label, fixture, overrides] of cases) {
    const { port } = portWith(fixture);
    const outcome = await port.initiate(request(overrides));
    assert.equal(outcome.disposition, 'unwired', `${label}：外发腿恒 unsupported ⇒ 只能是 unwired`);
    assert.notEqual(
      outcome.disposition,
      'initiated',
      `${label}：⛔ 成功路径不得披露 initiated —— 外发账本 append-only，本片没有任何"全部清理到位"的证据`,
    );
    assert.match(outcome.note, /unsupported|unwired/, '端口自述必须把外发腿的缺口写清楚');
  }
});
