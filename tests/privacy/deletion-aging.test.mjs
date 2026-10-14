/**
 * GY-I19（#19）· 删除任务「在线 7 日 / 备份 30 日」到期模块单测。
 *
 * 覆盖面（对齐切片验收）：
 *   1. 正常到期（到期 + 完成 + 证据 ⇒ completed；到期未做 ⇒ due）；
 *   2. **未到期不得 completed**（即使声称 completed 且带证据）；
 *   3. **失败必须带可判别原因码**（白名单码透出；非白名单折叠；未完成时原因码必非空）；
 *   4. **第 7 日 / 第 30 日当天边界**（闭区间：`now === due_at` 算到期，差 1ms 不算）；
 *   5. **幂等**（同入参同输出、入参不被修改、结果冻结）。
 *
 * 另含「不另起一套」的交叉校验：本模块算出的到期时刻与已合并的
 * `packages/privacy/deletion.mjs::createDeletionRegistry()` 逐毫秒一致。
 *
 * 本文件落在 `npm run test:unit` 的 glob（`tests/{unit,privacy,media,reference,moderation}/*.test.mjs`）内。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGING_REASON_CODES,
  BACKUP_RETENTION_MS,
  MS_PER_DAY,
  ONLINE_RETENTION_MS,
  deletionAgingDeadlines,
  evaluateDeletionAging,
} from '../../services/api/src/privacy/deletion-aging.ts';
import { createDeletionRegistry } from '../../packages/privacy/deletion.mjs';
import { HANDLER_STATES } from '../../packages/privacy/constants.mjs';

const T = '2026-10-01T00:00:00.000Z';
const T_MS = Date.parse(T);
const DAY7 = '2026-10-08T00:00:00.000Z';
const DAY30 = '2026-10-31T00:00:00.000Z';

const THREE_STATES = ['pending', 'due', 'failed'];

test('期限口径：在线 7 日 / 备份 30 日，且与已合并删除协议逐毫秒一致（不另起一套）', () => {
  assert.equal(ONLINE_RETENTION_MS, 7 * 24 * 60 * 60 * 1000);
  assert.equal(BACKUP_RETENTION_MS, 30 * 24 * 60 * 60 * 1000);
  assert.equal(ONLINE_RETENTION_MS, 7 * MS_PER_DAY);
  assert.equal(BACKUP_RETENTION_MS, 30 * MS_PER_DAY);

  const deadlines = deletionAgingDeadlines(T);
  assert.equal(deadlines.requested_at, T);
  assert.equal(deadlines.online_due_at, DAY7);
  assert.equal(deadlines.backup_due_at, DAY30);

  // 交叉校验：既有协议（GY-I27）在同一 requestedAt 上写出的 onlineDueAt/backupDueAt 必须相同。
  const registry = createDeletionRegistry({ now: () => new Date(T_MS) });
  const request = registry.createDeletionRequest({ generation: 1 });
  assert.equal(request.onlineDueAt.toISOString(), deadlines.online_due_at);
  assert.equal(request.backupDueAt.toISOString(), deadlines.backup_due_at);

  // 阶段状态闭集也只读复用既有常量（onlineState/backupState 的取值闭集）。
  assert.deepEqual([...HANDLER_STATES], ['pending', 'running', 'completed', 'blocked']);
});

test('正常到期 + 完成证据齐全 ⇒ completed；到期未做 ⇒ due 且未完成', () => {
  const done = evaluateDeletionAging({
    requestedAt: T,
    phase: 'online',
    now: DAY7,
    recordedState: 'completed',
    evidenceRef: 'media:online-purged:3',
  });
  assert.equal(done.is_due, true);
  assert.equal(done.online_due, true);
  assert.equal(done.backup_due, false, '在线到期时备份尚未到期');
  assert.equal(done.state, 'due');
  assert.equal(done.completed, true);
  assert.equal(done.settled, true);
  assert.equal(done.reason_code, null);
  assert.equal(done.remaining_ms, 0);
  assert.equal(done.online_due_at, DAY7);
  assert.equal(done.backup_due_at, DAY30);

  // 到期但尚未执行：到期 ≠ 完成。
  const pendingWork = evaluateDeletionAging({
    requestedAt: T,
    phase: 'online',
    now: DAY30,
    recordedState: 'pending',
  });
  assert.equal(pendingWork.is_due, true);
  assert.equal(pendingWork.backup_due, true);
  assert.equal(pendingWork.completed, false);
  assert.equal(pendingWork.settled, false);
  assert.equal(pendingWork.state, 'due');
  assert.equal(pendingWork.reason_code, AGING_REASON_CODES.DUE_NOT_EXECUTED);

  const running = evaluateDeletionAging({
    requestedAt: T,
    phase: 'backup',
    now: DAY30,
    recordedState: 'running',
  });
  assert.equal(running.state, 'due');
  assert.equal(running.completed, false);
  assert.equal(running.reason_code, AGING_REASON_CODES.DUE_IN_PROGRESS);
});

test('铁律 1：未到期不得返回 completed（即便声称 completed 且带证据）', () => {
  for (const [phase, now] of [
    ['online', new Date(T_MS + ONLINE_RETENTION_MS - 1).toISOString()],
    ['backup', new Date(T_MS + BACKUP_RETENTION_MS - 1).toISOString()],
    ['backup', DAY7], // 在线已到期时备份仍未到期
  ]) {
    const result = evaluateDeletionAging({
      requestedAt: T,
      phase,
      now,
      recordedState: 'completed',
      evidenceRef: 'media:online-purged:3',
    });
    assert.equal(result.is_due, false, `${phase}@${now} 应为未到期`);
    assert.equal(result.state, 'pending');
    assert.equal(result.completed, false, `${phase}@${now} 未到期不得 completed`);
    assert.equal(result.settled, false);
    assert.equal(result.reason_code, AGING_REASON_CODES.NOT_DUE);
    assert.ok(result.remaining_ms > 0);
    assert.equal(result.online_due, phase === 'online' ? false : Date.parse(now) >= Date.parse(DAY7));
  }

  // 到期但声称完成却**没有证据** ⇒ 仍不得 completed（不得谎称完成）。
  const noEvidence = evaluateDeletionAging({
    requestedAt: T,
    phase: 'online',
    now: DAY7,
    recordedState: 'completed',
    evidenceRef: '   ',
  });
  assert.equal(noEvidence.state, 'due');
  assert.equal(noEvidence.completed, false);
  assert.equal(noEvidence.reason_code, AGING_REASON_CODES.DUE_NO_EVIDENCE);
});

test('铁律 2：失败必须带可判别原因码；非白名单自由文本被折叠且不透出', () => {
  // 白名单内的既有失败码：原样透出，可判别。
  const whitelisted = evaluateDeletionAging({
    requestedAt: T,
    phase: 'online',
    now: DAY7,
    recordedState: 'blocked',
    errorCode: 'STORE_UNREACHABLE',
  });
  assert.equal(whitelisted.state, 'failed');
  assert.equal(whitelisted.completed, false);
  assert.equal(whitelisted.settled, true);
  assert.equal(whitelisted.reason_code, 'STORE_UNREACHABLE');
  assert.equal(whitelisted.recorded_error_code, 'STORE_UNREACHABLE');

  // 非白名单自由文本：折叠为固定分类，output 里不得出现原文。
  const folded = evaluateDeletionAging({
    requestedAt: T,
    phase: 'online',
    now: DAY7,
    recordedState: 'blocked',
    errorCode: 'RAW_SDK_TEXT_should_not_leak',
  });
  assert.equal(folded.state, 'failed');
  assert.equal(folded.completed, false);
  assert.equal(folded.reason_code, AGING_REASON_CODES.PHASE_FAILED);
  assert.equal(folded.recorded_error_code, null);
  assert.equal(JSON.stringify(folded).includes('RAW_SDK_TEXT'), false, '自由文本不得透出');

  // 有失败信号但没有错误码 ⇒ 仍给出可判别原因码。
  const blockedNoCode = evaluateDeletionAging({
    requestedAt: T,
    phase: 'backup',
    now: DAY30,
    recordedState: 'blocked',
  });
  assert.equal(blockedNoCode.state, 'failed');
  assert.equal(blockedNoCode.reason_code, AGING_REASON_CODES.PHASE_BLOCKED);

  // 未到期也带失败码：失败信号优先于"未到期"，但同样不得 completed。
  const failedEarly = evaluateDeletionAging({
    requestedAt: T,
    phase: 'online',
    now: T,
    recordedState: 'pending',
    errorCode: 'PROVIDER_TIMEOUT',
  });
  assert.equal(failedEarly.is_due, false);
  assert.equal(failedEarly.state, 'failed');
  assert.equal(failedEarly.completed, false);
  assert.equal(failedEarly.reason_code, 'PROVIDER_TIMEOUT');
});

test('铁律 2/3 合并：completed === false 时 reason_code 必非空；三态取值闭集', () => {
  const matrix = [];
  for (const phase of ['online', 'backup']) {
    for (const now of [T, DAY7, DAY30]) {
      for (const recordedState of ['pending', 'running', 'completed', 'blocked']) {
        for (const evidenceRef of [null, '', 'ev']) {
          matrix.push({ requestedAt: T, phase, now, recordedState, evidenceRef });
        }
      }
    }
  }
  assert.equal(matrix.length, 2 * 3 * 4 * 3);
  for (const input of matrix) {
    const result = evaluateDeletionAging(input);
    assert.ok(THREE_STATES.includes(result.state), `state 必须属闭集：${result.state}`);
    if (result.completed) {
      assert.equal(result.reason_code, null, 'completed 时不应有原因码');
      assert.equal(result.is_due, true, '未到期不得 completed');
    } else {
      assert.equal(typeof result.reason_code, 'string');
      assert.ok(result.reason_code.length > 0, 'completed===false 必须带可判别原因码');
    }
    assert.equal(result.settled, result.completed || result.state === 'failed');
  }
});

test('第 7 日 / 第 30 日当天边界：闭区间（当天即到期，差 1ms 为未到期）', () => {
  const at = (ms, phase, recordedState = 'pending') =>
    evaluateDeletionAging({ requestedAt: T, phase, now: ms, recordedState });

  // 在线：第 7 日当天那一刻起算到期。
  assert.equal(at(T_MS + ONLINE_RETENTION_MS - 1, 'online').is_due, false);
  assert.equal(at(T_MS + ONLINE_RETENTION_MS - 1, 'online').reason_code, AGING_REASON_CODES.NOT_DUE);
  assert.equal(at(T_MS + ONLINE_RETENTION_MS, 'online').is_due, true);
  assert.equal(at(T_MS + ONLINE_RETENTION_MS, 'online').due_at, DAY7);

  // 备份：第 30 日当天那一刻起算到期。
  assert.equal(at(T_MS + BACKUP_RETENTION_MS - 1, 'backup').is_due, false);
  assert.equal(at(T_MS + BACKUP_RETENTION_MS, 'backup').is_due, true);
  assert.equal(at(T_MS + BACKUP_RETENTION_MS, 'backup').due_at, DAY30);

  // 当天两个标志各自独立：第 7 日 online_due=true / backup_due=false；差 1ms 两个都 false。
  const day7 = at(T_MS + ONLINE_RETENTION_MS, 'online');
  assert.deepEqual([day7.online_due, day7.backup_due], [true, false]);
  const beforeDay7 = at(T_MS + ONLINE_RETENTION_MS - 1, 'online');
  assert.deepEqual([beforeDay7.online_due, beforeDay7.backup_due], [false, false]);

  // 边界当天的行为可直接写进"完成"判定：当天 + 证据 ⇒ completed。
  const boundaryDone = at(T_MS + ONLINE_RETENTION_MS, 'online', 'completed');
  assert.equal(boundaryDone.completed, false, '无证据仍不得完成');
  const boundaryDoneWithEvidence = evaluateDeletionAging({
    requestedAt: T,
    phase: 'online',
    now: T_MS + ONLINE_RETENTION_MS,
    recordedState: 'completed',
    evidenceRef: 'ev',
  });
  assert.equal(boundaryDoneWithEvidence.completed, true);
});

test('幂等：同入参同输出、入参不被修改、结果冻结、纯函数无副作用', () => {
  const input = Object.freeze({
    requestedAt: T,
    phase: 'online',
    now: DAY7,
    recordedState: 'completed',
    evidenceRef: 'ev-online',
  });
  const first = evaluateDeletionAging(input);
  const second = evaluateDeletionAging(input);
  assert.deepEqual(second, first);
  assert.equal(JSON.stringify(second), JSON.stringify(first));
  assert.ok(Object.isFrozen(first));

  // 同一入参在真实时钟推进后（仍显式传 now）结果不变 —— 结果只由入参决定。
  const third = evaluateDeletionAging({ ...input });
  assert.deepEqual(third, first);
  // 入参对象未被修改（冻结对象若被写入会抛错，这里再逐字段核对）。
  assert.deepEqual(input, {
    requestedAt: T,
    phase: 'online',
    now: DAY7,
    recordedState: 'completed',
    evidenceRef: 'ev-online',
  });

  // 期限计算同样幂等且不抛。
  assert.deepEqual(deletionAgingDeadlines(T), deletionAgingDeadlines(T));
  assert.deepEqual(deletionAgingDeadlines(T_MS), deletionAgingDeadlines(T));
  assert.deepEqual(deletionAgingDeadlines(new Date(T_MS)), deletionAgingDeadlines(T));
  assert.ok(Object.isFrozen(deletionAgingDeadlines(T)));

  // 显式 now 不同 ⇒ 结果确定性地不同（不是随机/缓存）。
  const later = evaluateDeletionAging({ ...input, now: DAY30 });
  assert.equal(later.backup_due, true);
  assert.notDeepEqual(later, first);
});

test('fail-closed：不可信入参一律不得 completed，且带 AGING_INPUT_INVALID 原因码', () => {
  const cases = [
    ['phase 非法', { requestedAt: T, phase: 'both', now: DAY7 }],
    ['phase 缺失', { requestedAt: T, phase: undefined, now: DAY7 }],
    ['非严格 ISO 串', { requestedAt: '2026/10/01 00:00:00', phase: 'online', now: DAY7 }],
    ['无时区 ISO 串', { requestedAt: '2026-10-01T00:00:00', phase: 'online', now: DAY7 }],
    ['requestedAt 缺失', { phase: 'online', now: DAY7 }],
    ['requestedAt 晚于 now', { requestedAt: DAY30, phase: 'online', now: T }],
    ['now 非法', { requestedAt: T, phase: 'online', now: 'not-a-time' }],
    ['NaN 时间戳', { requestedAt: Number.NaN, phase: 'online', now: T_MS }],
    ['Date 无效', { requestedAt: new Date('nope'), phase: 'online', now: T_MS }],
    ['recordedState 不在闭集', { requestedAt: T, phase: 'online', now: DAY7, recordedState: 'done' }],
  ];
  for (const [label, input] of cases) {
    const result = evaluateDeletionAging(input);
    assert.equal(result.completed, false, `${label}：不得 completed`);
    assert.equal(result.state, 'failed', `${label}：应为失败三态`);
    assert.equal(result.settled, true, `${label}：不可信入参不可静默通过`);
    assert.equal(result.reason_code, AGING_REASON_CODES.INPUT_INVALID, label);
    assert.equal(result.online_due, false);
    assert.equal(result.backup_due, false);
    assert.equal(result.remaining_ms, null);
    assert.equal(typeof result.detail, 'string');
    assert.ok(result.detail.length > 0);
  }

  // 正向：毫秒时间戳与 Date 入参与 ISO 串等价。
  const byIso = evaluateDeletionAging({ requestedAt: T, phase: 'online', now: DAY7 });
  assert.deepEqual(evaluateDeletionAging({ requestedAt: T_MS, phase: 'online', now: Date.parse(DAY7) }), byIso);
  assert.deepEqual(
    evaluateDeletionAging({ requestedAt: new Date(T_MS), phase: 'online', now: new Date(Date.parse(DAY7)) }),
    byIso,
  );
});
