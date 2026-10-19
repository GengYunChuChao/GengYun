/**
 * GY-I19 · 逐用户备份副本域的留存判定（`packages/privacy/backup-retention.mjs`）单测。
 *
 * 口径：
 *   - **不写死「今天」**：所有时刻都是本文件顶部的固定常量，判定只依赖入参；
 *   - 重点锁住三条硬不变量：**空集不得当成功**、**非法时间不得放行**、**边界含等于**；
 *   - 另锁「30 天 ≠ 7 天」，防止后续把两个窗口写成同一个数；
 *   - 与既有两处 7/30 声明**交叉校验**（`createDeletionRegistry()` 的小时口径 +
 *     `deletion-aging.ts` 的天口径）——本文件只读它们，不改任何既有文件。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BACKUP_COPY_STATES,
  BACKUP_PURGE_ACTIONS,
  BACKUP_PURGE_REASONS,
  BACKUP_RETENTION_DAYS,
  BACKUP_RETENTION_MS,
  MS_PER_DAY,
  ONLINE_RETENTION_DAYS,
  ONLINE_RETENTION_MS,
  RETENTION_UNIT,
  backupRetentionUntil,
  evaluateBackupPurge,
  onlineRetentionUntil,
  retentionDeadlines,
} from '../../packages/privacy/backup-retention.mjs';
import { createDeletionRegistry } from '../../packages/privacy/deletion.mjs';
import {
  BACKUP_RETENTION_DAYS as AGING_BACKUP_DAYS,
  BACKUP_RETENTION_MS as AGING_BACKUP_MS,
  ONLINE_RETENTION_DAYS as AGING_ONLINE_DAYS,
  ONLINE_RETENTION_MS as AGING_ONLINE_MS,
} from '../../services/api/src/privacy/deletion-aging.ts';

/** 固定受理时刻（UTC）：2026-10-18T00:00:00Z。 */
const ACCEPTED_AT = '2026-10-18T00:00:00.000Z';
/** 在线截止：受理 + 7 天。 */
const ONLINE_DUE = '2026-10-25T00:00:00.000Z';
/** 备份副本截止：受理 + 30 天。 */
const BACKUP_DUE = '2026-11-17T00:00:00.000Z';
/** 备份截止前 1 毫秒（差 1ms 即未到期）。 */
const ONE_MS_BEFORE_BACKUP_DUE = '2026-11-16T23:59:59.999Z';

/** 一条未到期的备份副本行。 */
function pendingCopy(retentionUntil = BACKUP_DUE) {
  return { copyId: 'c-1', subject: 'u-1', state: 'pending_purge', retentionUntil };
}

// ---------------------------------------------------------------------------
// 1 常量口径：7 天与 30 天是**两个不同**的数，且单位是天
// ---------------------------------------------------------------------------

test('常量口径：在线 7 天、备份 30 天，单位为天，且两个窗口不相等', () => {
  assert.equal(ONLINE_RETENTION_DAYS, 7);
  assert.equal(BACKUP_RETENTION_DAYS, 30);
  assert.equal(RETENTION_UNIT, 'day');
  assert.equal(MS_PER_DAY, 86_400_000);
  assert.equal(ONLINE_RETENTION_MS, ONLINE_RETENTION_DAYS * MS_PER_DAY);
  assert.equal(BACKUP_RETENTION_MS, BACKUP_RETENTION_DAYS * MS_PER_DAY);
  // 防「把两个窗口写成同一个数」：30 天必须严格大于 7 天，且差值正好是 23 天。
  assert.notEqual(BACKUP_RETENTION_MS, ONLINE_RETENTION_MS);
  assert.ok(BACKUP_RETENTION_MS > ONLINE_RETENTION_MS, '备份窗口必须长于在线窗口');
  assert.equal(BACKUP_RETENTION_MS - ONLINE_RETENTION_MS, 23 * MS_PER_DAY);
});

test('状态与动作闭集：逐项等于设计文档登记值（多一项/少一项都要红）', () => {
  assert.deepEqual(BACKUP_COPY_STATES, ['pending_purge', 'purged', 'failed']);
  assert.deepEqual(BACKUP_PURGE_ACTIONS, ['none', 'wait', 'purge', 'blocked']);
  assert.deepEqual(
    BACKUP_PURGE_REASONS,
    {
      PURGE_DUE: 'BACKUP_PURGE_DUE',
      WAITING_RETENTION: 'BACKUP_WAITING_RETENTION',
      NO_COPIES: 'BACKUP_NO_COPIES',
      ALL_PURGED: 'BACKUP_ALL_PURGED',
      COPY_FAILED: 'BACKUP_COPY_FAILED',
      INPUT_INVALID: 'BACKUP_INPUT_INVALID',
    },
  );
});

// ---------------------------------------------------------------------------
// 2 与既有两处 7/30 声明同源交叉校验（本文件只读，不改既有文件）
// ---------------------------------------------------------------------------

test('同源交叉校验（小时口径）：deletion.mjs 的 onlineDueAt/backupDueAt 差值等于本模块毫秒常量', () => {
  const registry = createDeletionRegistry({ now: () => new Date(ACCEPTED_AT) });
  const request = registry.createDeletionRequest();
  assert.equal(
    request.onlineDueAt.getTime() - request.requestedAt.getTime(),
    ONLINE_RETENTION_MS,
    '在线窗口若与 deletion.mjs 的 7×24 小时不一致，说明本片多声明了一个不同的数',
  );
  assert.equal(
    request.backupDueAt.getTime() - request.requestedAt.getTime(),
    BACKUP_RETENTION_MS,
    '备份窗口若与 deletion.mjs 的 30×24 小时不一致，说明本片多声明了一个不同的数',
  );
  // 同时确认既有协议算出来的截止时刻与本模块逐字相同。
  assert.equal(request.onlineDueAt.toISOString(), ONLINE_DUE);
  assert.equal(request.backupDueAt.toISOString(), BACKUP_DUE);
});

test('同源交叉校验（天口径）：deletion-aging.ts 的 7/30 与毫秒常量逐值相等', () => {
  assert.equal(AGING_ONLINE_DAYS, ONLINE_RETENTION_DAYS);
  assert.equal(AGING_BACKUP_DAYS, BACKUP_RETENTION_DAYS);
  assert.equal(AGING_ONLINE_MS, ONLINE_RETENTION_MS);
  assert.equal(AGING_BACKUP_MS, BACKUP_RETENTION_MS);
});

// ---------------------------------------------------------------------------
// 3 从受理时间推导期限：UTC ISO-8601，且两条期限不同
// ---------------------------------------------------------------------------

test('onlineRetentionUntil/backupRetentionUntil：从受理时间推导，逐字等于固定期望值', () => {
  assert.equal(onlineRetentionUntil(ACCEPTED_AT), ONLINE_DUE);
  assert.equal(backupRetentionUntil(ACCEPTED_AT), BACKUP_DUE);
  assert.notEqual(onlineRetentionUntil(ACCEPTED_AT), backupRetentionUntil(ACCEPTED_AT));
  assert.equal(
    Date.parse(backupRetentionUntil(ACCEPTED_AT)) - Date.parse(onlineRetentionUntil(ACCEPTED_AT)),
    23 * MS_PER_DAY,
  );
});

test('retentionDeadlines：三项齐全、全部 UTC ISO-8601（末尾 Z），并冻结', () => {
  const deadlines = retentionDeadlines(ACCEPTED_AT);
  assert.deepEqual(deadlines, {
    requested_at: ACCEPTED_AT,
    online_retention_until: ONLINE_DUE,
    backup_retention_until: BACKUP_DUE,
  });
  assert.ok(Object.isFrozen(deadlines));
  for (const value of Object.values(deadlines)) {
    assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, `${value} 必须是 UTC ISO-8601`);
  }
});

test('带时区的等价写法解析成同一时刻（+08:00 与 Z 同日同时刻）', () => {
  assert.equal(onlineRetentionUntil('2026-10-18T08:00:00+08:00'), ONLINE_DUE);
  assert.equal(backupRetentionUntil('2026-10-18T08:00:00+08:00'), BACKUP_DUE);
  // Date 对象与 epoch 毫秒同样接受，且不因「本地时区」而漂移。
  assert.equal(backupRetentionUntil(new Date(ACCEPTED_AT)), BACKUP_DUE);
  assert.equal(backupRetentionUntil(Date.parse(ACCEPTED_AT)), BACKUP_DUE);
});

test('受理时间非法 ⇒ 直接抛错（⛔ 不从不可信时间推导期限）', () => {
  const bad = [
    '2026-10-18T00:00:00', // 裸本地时间：无时区
    '2026-10-18', // 只到日
    'tomorrow',
    '',
    null,
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    {},
    new Date('not-a-date'),
  ];
  for (const value of bad) {
    assert.throws(() => onlineRetentionUntil(value), TypeError, `onlineRetentionUntil 必须拒绝 ${String(value)}`);
    assert.throws(() => backupRetentionUntil(value), TypeError, `backupRetentionUntil 必须拒绝 ${String(value)}`);
    assert.throws(() => retentionDeadlines(value), TypeError, `retentionDeadlines 必须拒绝 ${String(value)}`);
  }
});

// ---------------------------------------------------------------------------
// 4 空集不得当成功（本片的核心不变量）
// ---------------------------------------------------------------------------

test('空集：action=none 且 reason=NO_COPIES —— 空登记表不得被读成「已清除」', () => {
  const result = evaluateBackupPurge({ now: BACKUP_DUE, copies: [] });
  assert.equal(result.action, 'none');
  assert.equal(result.reason, BACKUP_PURGE_REASONS.NO_COPIES);
  assert.deepEqual(result.dueCopies, []);
  // 三连否：既不 purge、也不 wait、更不是「清完了」。
  assert.notEqual(result.action, 'purge');
  assert.notEqual(result.action, 'wait');
  assert.notEqual(result.reason, BACKUP_PURGE_REASONS.PURGE_DUE);
});

test('未查存储（copies 缺省／非数组）：blocked + INPUT_INVALID，不当作空集放行', () => {
  for (const copies of [undefined, null, {}, 'none', 0]) {
    const result = evaluateBackupPurge({ now: BACKUP_DUE, copies });
    assert.equal(result.action, 'blocked', `copies=${String(copies)} 必须 blocked`);
    assert.equal(result.reason, BACKUP_PURGE_REASONS.INPUT_INVALID);
    assert.deepEqual(result.dueCopies, []);
  }
  // 连入参整体缺省也不许「默认为无副本 ⇒ 成功」。
  const noArgs = evaluateBackupPurge();
  assert.equal(noArgs.action, 'blocked');
  assert.equal(noArgs.reason, BACKUP_PURGE_REASONS.INPUT_INVALID);
});

// ---------------------------------------------------------------------------
// 5 未到期 / 到期 / 边界含等于
// ---------------------------------------------------------------------------

test('未到期：批次截止前 1 毫秒 ⇒ wait，且不带任何待清副本', () => {
  const result = evaluateBackupPurge({
    now: ONE_MS_BEFORE_BACKUP_DUE,
    copies: [pendingCopy()],
  });
  assert.equal(result.action, 'wait');
  assert.equal(result.reason, BACKUP_PURGE_REASONS.WAITING_RETENTION);
  assert.deepEqual(result.dueCopies, []);
});

test('边界含等于：now === retentionUntil 那一刻即到期 ⇒ purge', () => {
  const result = evaluateBackupPurge({ now: BACKUP_DUE, copies: [pendingCopy()] });
  assert.equal(result.action, 'purge');
  assert.equal(result.reason, BACKUP_PURGE_REASONS.PURGE_DUE);
  assert.equal(result.dueCopies.length, 1);
  assert.equal(result.dueCopies[0].copyId, 'c-1');
});

test('已到期：超过截止后任意时刻 ⇒ purge，且只带到期的那几条', () => {
  const copies = [
    { copyId: 'c-old', state: 'pending_purge', retentionUntil: BACKUP_DUE },
    { copyId: 'c-new', state: 'pending_purge', retentionUntil: '2026-12-01T00:00:00.000Z' },
  ];
  const result = evaluateBackupPurge({ now: '2026-11-20T00:00:00.000Z', copies });
  assert.equal(result.action, 'purge');
  assert.deepEqual(
    result.dueCopies.map((copy) => copy.copyId),
    ['c-old'],
  );
});

test('7 天与 30 天不混轴：7 天时点上备份副本仍未到期', () => {
  // 关键负例：若有人把备份窗口写成 7 天，这条会从 wait 变成 purge 而红。
  const atOnlineDue = evaluateBackupPurge({ now: ONLINE_DUE, copies: [pendingCopy()] });
  assert.equal(atOnlineDue.action, 'wait', '在线到期≠备份到期，备份副本在 7 天时点必须仍在留存期内');

  const atBackupDue = evaluateBackupPurge({ now: BACKUP_DUE, copies: [pendingCopy()] });
  assert.equal(atBackupDue.action, 'purge', '到 30 天那一刻才该清备份副本');
});

// ---------------------------------------------------------------------------
// 6 清除失败 / 非法输入：一律 blocked，⛔ 不得默认放行
// ---------------------------------------------------------------------------

test('failed 行 ⇒ blocked（即使同时存在到期行，也不得报「清完了」）', () => {
  const copies = [
    { copyId: 'c-due', state: 'pending_purge', retentionUntil: BACKUP_DUE },
    { copyId: 'c-failed', state: 'failed', retentionUntil: BACKUP_DUE },
  ];
  const result = evaluateBackupPurge({ now: BACKUP_DUE, copies });
  assert.equal(result.action, 'blocked');
  assert.equal(result.reason, BACKUP_PURGE_REASONS.COPY_FAILED);
  assert.deepEqual(result.dueCopies, [], 'blocked 时不得同时返回「可清」清单');
});

test('非法输入放行检测：now/retentionUntil 不可解析、state 未知、行不是对象 ⇒ 一律 blocked', () => {
  const cases = [
    { now: '2026-11-17T00:00:00', copies: [pendingCopy()] }, // now 裸本地时间
    { now: 'soon', copies: [pendingCopy()] },
    { now: null, copies: [pendingCopy()] },
    { now: Number.NaN, copies: [pendingCopy()] },
    { now: BACKUP_DUE, copies: [{ state: 'pending_purge', retentionUntil: '2026-13-01T00:00:00.000Z' }] },
    { now: BACKUP_DUE, copies: [{ state: 'pending_purge', retentionUntil: '2026-11-17' }] },
    { now: BACKUP_DUE, copies: [{ state: 'pending_purge', retentionUntil: null }] },
    { now: BACKUP_DUE, copies: [{ state: 'pending_purge' }] },
    { now: BACKUP_DUE, copies: [{ state: 'pending', retentionUntil: BACKUP_DUE }] }, // 状态不在闭集
    { now: BACKUP_DUE, copies: [{ state: 'PURGED', retentionUntil: BACKUP_DUE }] }, // 大小写不符也不放行
    { now: BACKUP_DUE, copies: [null] },
    { now: BACKUP_DUE, copies: ['pending_purge'] },
  ];
  for (const input of cases) {
    const result = evaluateBackupPurge(input);
    assert.equal(result.action, 'blocked', `必须 blocked：${JSON.stringify(input)}`);
    assert.equal(result.reason, BACKUP_PURGE_REASONS.INPUT_INVALID, `必须 INPUT_INVALID：${JSON.stringify(input)}`);
    assert.deepEqual(result.dueCopies, []);
  }
});

test('全 purged ⇒ none/ALL_PURGED（本次无事可做，也不伪造新证据）', () => {
  const copies = [
    { copyId: 'c-1', state: 'purged', retentionUntil: BACKUP_DUE },
    { copyId: 'c-2', state: 'purged', retentionUntil: BACKUP_DUE },
  ];
  const result = evaluateBackupPurge({ now: '2026-12-31T00:00:00.000Z', copies });
  assert.equal(result.action, 'none');
  assert.equal(result.reason, BACKUP_PURGE_REASONS.ALL_PURGED);
  assert.notEqual(result.reason, BACKUP_PURGE_REASONS.NO_COPIES);
});

test('purged 行不阻塞未到期行：purged + 未到期 ⇒ wait', () => {
  const copies = [
    { copyId: 'c-done', state: 'purged', retentionUntil: '2026-10-01T00:00:00.000Z' },
    pendingCopy(),
  ];
  const result = evaluateBackupPurge({ now: ONLINE_DUE, copies });
  assert.equal(result.action, 'wait');
  assert.equal(result.reason, BACKUP_PURGE_REASONS.WAITING_RETENTION);
});

// ---------------------------------------------------------------------------
// 7 返回形状：恰好三个键、冻结、dueCopies 是副本（不污染入参）
// ---------------------------------------------------------------------------

test('返回形状：恰好 {action,dueCopies,reason} 三键且冻结，dueCopies 是副本', () => {
  const source = pendingCopy();
  const result = evaluateBackupPurge({ now: BACKUP_DUE, copies: [source] });
  assert.deepEqual(Object.keys(result).sort(), ['action', 'dueCopies', 'reason']);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.dueCopies));
  assert.ok(Object.isFrozen(result.dueCopies[0]));
  assert.notEqual(result.dueCopies[0], source, '不得把入参对象直接交出去（调用方改它就会污染判定输入）');
  assert.deepEqual(result.dueCopies[0], source);
});

test('判定是纯函数：同一入参重复调用逐字同值，且不改写入参', () => {
  const copies = [pendingCopy()];
  const snapshot = structuredClone(copies);
  const first = evaluateBackupPurge({ now: BACKUP_DUE, copies });
  const second = evaluateBackupPurge({ now: BACKUP_DUE, copies });
  assert.deepEqual(first, second);
  assert.deepEqual(copies, snapshot, '判定不得修改传入的副本行');
});
