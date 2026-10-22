/**
 * GY-I15（#15）· R31-S1：举报状态机的**纯函数**用例（不碰存储、不碰 HTTP）。
 *
 * 覆盖的是「缺的那一环」本身：`received → isolated → closed` 的合法转移表、
 * 终态单向门、以及「未知名动作」与「非法转移」两种拒绝原因的区分。
 *
 * 证据边界：本文件只证明状态机**表**的行为；「真的写进了库」由
 * `tests/unit/community-report-disposition.test.mjs`（内存实现）与
 * `tests/integration/community-pg.mjs`（真库 CAS）分别断言。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REPORT_ACTIONS,
  REPORT_STATES,
  describeReportStateMachine,
  isTerminalReportState,
  planReportTransition,
} from '../../services/api/src/community/report-state.ts';

test('状态取值闭集与既有契约/迁移逐值一致：received / isolated / closed', () => {
  assert.deepEqual([...REPORT_STATES], ['received', 'isolated', 'closed']);
  assert.deepEqual([...REPORT_ACTIONS], ['triage', 'resolve', 'reject']);
  // 终态只有一个：closed（received/isolated 都还能往下走）。
  assert.deepEqual(
    REPORT_STATES.filter((state) => isTerminalReportState(state)),
    ['closed'],
  );
});

test('合法转移：received --triage--> isolated；received --resolve/reject--> closed；isolated --resolve--> closed', () => {
  const legal = [
    { from: 'received', action: 'triage', to: 'isolated' },
    { from: 'received', action: 'resolve', to: 'closed' },
    { from: 'received', action: 'reject', to: 'closed' },
    { from: 'isolated', action: 'resolve', to: 'closed' },
  ];
  for (const item of legal) {
    const plan = planReportTransition(item.from, item.action);
    assert.equal(plan.ok, true, `${item.from} --${item.action}--> 应当合法`);
    if (plan.ok) {
      assert.equal(plan.from, item.from);
      assert.equal(plan.action, item.action);
      assert.equal(plan.to, item.to);
    }
  }
});

test('终态单向门：closed 之后没有任何合法动作（TERMINAL_STATE，不是"静默成功"）', () => {
  for (const action of REPORT_ACTIONS) {
    const plan = planReportTransition('closed', action);
    assert.equal(plan.ok, false, `closed --${action}--> 必须被拒绝`);
    if (!plan.ok) assert.equal(plan.reason, 'TERMINAL_STATE');
  }
});

test('非法转移：已隔离的举报不接受 reject（ILLEGAL_TRANSITION，与终态可区分）', () => {
  const plan = planReportTransition('isolated', 'reject');
  assert.equal(plan.ok, false);
  if (!plan.ok) {
    assert.equal(plan.reason, 'ILLEGAL_TRANSITION');
    assert.equal(plan.from, 'isolated');
    assert.equal(plan.action, 'reject');
  }
});

test('未知名动作：UNKNOWN_ACTION（先判动作闭集，再判状态）', () => {
  for (const action of ['', 'approve', 'TRIAGE', 'close']) {
    const plan = planReportTransition('received', action);
    assert.equal(plan.ok, false, `动作 ${JSON.stringify(action)} 必须被拒绝`);
    if (!plan.ok) assert.equal(plan.reason, 'UNKNOWN_ACTION');
  }
});

test('转移表自述与判定逐条一致（用例不复制第二份表）', () => {
  const described = describeReportStateMachine();
  assert.equal(described.length, REPORT_ACTIONS.length);
  for (const rule of described) {
    for (const state of REPORT_STATES) {
      const plan = planReportTransition(state, rule.action);
      const shouldAllow = !isTerminalReportState(state) && rule.from.includes(state);
      assert.equal(
        plan.ok,
        shouldAllow,
        `${state} --${rule.action}--> 期望 ${shouldAllow ? '允许' : '拒绝'}，表 = ${JSON.stringify(rule)}`,
      );
      if (plan.ok) assert.equal(plan.to, rule.to);
    }
  }
});
