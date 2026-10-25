/**
 * 保留期常量**四处取值必须相等**（7 日／30 日）的交叉校验单测。
 *
 * ## 为什么需要这一片
 * 「在线个人数据／私有原媒体7日内删除，备份30日内滚动清理」（`docs/implementation-requirements.md:278`）
 * 在仓里落成四处数值：
 *   ① `packages/privacy/deletion.mjs:15-16`　`ONLINE_HOURS = 7 * 24` / `BACKUP_HOURS = 30 * 24`
 *      —— **模块私有、未导出**（该文件只导出 `SAFE_ERROR_CODES` 与 `createDeletionRegistry`）；
 *   ② `packages/privacy/backup-retention.mjs:40,43`　`ONLINE_RETENTION_DAYS = 7` / `BACKUP_RETENTION_DAYS = 30`
 *      —— 该文件 `:29-36` 自承是第三处声明；
 *   ③ `services/api/src/privacy/deletion-aging.ts:60,62`　同样两个天口径常量；
 *   ④ `packages/privacy/retention-policy.mjs:142`　`public.sessions` 的 `retentionDays: 30`
 *      —— 语义近似的独立取值，靠 `:149-152` 的 `why` 说辞（「回溯窗口与『备份30日内滚动清理』对齐」）
 *      与备份窗口对齐，**与上面三个常量没有任何代码级联系**。
 *
 * 既有防线各守一段，却不守**彼此相等**：`tests/privacy/deletion.test.mjs` 把 ① 的派生值钉在
 * 168h／720h，`tests/unit/backup-retention.test.mjs` 把 ② ③ 互钉、并把 ① 反查成毫秒。
 * 于是「只改一处」（例如把 ② 的 30 改成 45，或把 ④ 的 30 改成 31）不会有任何用例变红 ——
 * 那正是四份副本各自漂移的形状。本文件**只**补这条相等判据。
 *
 * ## 口径
 * - **只加测试**：不改任何生产常量、不改任何既有文件。
 * - ① 无法 import（见上），因此沿用既有单测的「派生值反查」手法：让 `createDeletionRegistry()`
 *   受理一次注销请求，用 `onlineDueAt - requestedAt` 反算出它**实际生效**的小时口径，再与 ②③ 的
 *   天口径 × 24 逐项比对。反查不是妥协：它测的是行为而不是字面量，把 ① 改成任何别的数都会红。
 * - 绝对数（168h／720h）不在这里重复钉一遍 —— `tests/privacy/deletion.test.mjs` 与
 *   `tests/unit/backup-retention.test.mjs` 已经各钉过。本文件的判据是**跨副本相等**。
 * - 刻意**不纳入** `services/api/src/auth/tokens.ts` 的 `USER_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60`：
 *   那是「登录会话有效期」，不是「注销后的保留期」，数值相同纯属巧合；钉在一起会把两个独立的
 *   设计决定焊死（改会话时长不该被留存期用例拦下，反之亦然）。
 *
 * ## 反向控制
 * 两条判据各自自带「先证它会红」：把**判据函数本身**用错值（6 天／8 天／31 天）各调一次，
 * 断言它确实抛错；同时用真值调一次证明它不是「永远抛错」。⛔ 不通过临时改写生产常量来制造红。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDeletionRegistry } from '../../packages/privacy/deletion.mjs';
import {
  BACKUP_RETENTION_DAYS,
  MS_PER_DAY,
  ONLINE_RETENTION_DAYS,
} from '../../packages/privacy/backup-retention.mjs';
import { RETENTION_POLICY } from '../../packages/privacy/retention-policy.mjs';
import {
  BACKUP_RETENTION_DAYS as AGING_BACKUP_RETENTION_DAYS,
  MS_PER_DAY as AGING_MS_PER_DAY,
  ONLINE_RETENTION_DAYS as AGING_ONLINE_RETENTION_DAYS,
} from '../../services/api/src/privacy/deletion-aging.ts';

/** 一天的小时数（「天口径 × 24」里的那个 24，只在 `MS_PER_DAY` 桥核对后使用）。 */
const HOURS_PER_DAY = 24;
/** 一小时的毫秒数。 */
const MS_PER_HOUR = 60 * 60 * 1000;
/** 固定受理时刻（UTC）：判定只依赖入参，不写死「今天」。 */
const ACCEPTED_AT = '2026-10-18T00:00:00.000Z';

/**
 * 天口径 → 小时口径。`deletion.mjs` 里写死的就是 `7 * 24` / `30 * 24`，本函数是它的等价形状；
 * 「反向控制 A」会拿它配错值调用一次，断言判据确实会红。
 */
function hoursFromDays(days) {
  return days * HOURS_PER_DAY;
}

/**
 * 反查 ① 实际生效的小时口径。
 *
 * `ONLINE_HOURS` / `BACKUP_HOURS` 是 `deletion.mjs` 的模块私有常量，import 不到；
 * 唯一的可观测面就是 `createDeletionRequest()` 算出来的两个截止时刻。受理时刻注入固定值
 * ⇒ 与系统时钟无关，重复跑逐位相同。
 */
function deriveDeletionHours() {
  const registry = createDeletionRegistry({ now: () => new Date(ACCEPTED_AT) });
  const request = registry.createDeletionRequest();
  const elapsedHours = (field) => (request[field].getTime() - request.requestedAt.getTime()) / MS_PER_HOUR;
  return {
    onlineHours: elapsedHours('onlineDueAt'),
    backupHours: elapsedHours('backupDueAt'),
  };
}

/**
 * 小时/天两套口径的**唯一**相等判据：小时口径必须严格等于「天口径 × 24」。
 * 反向控制直接调用本函数喂错值 —— 判据本身被证明不是恒真。
 */
function assertHoursParity(label, hours, days) {
  assert.equal(
    hours,
    hoursFromDays(days),
    `${label}：小时口径 ${hours}h 必须等于天口径 ${days} 天 × ${HOURS_PER_DAY}`
      + '（`deletion.mjs` 的 `*= 24` 与天口径必须是同一个数）',
  );
}

/**
 * ④ 与备份窗口的关系：**逐值相等**。
 *
 * 依据是 `retention-policy.mjs:149-152` 的自述：「回溯窗口与『备份30日内滚动清理』对齐，
 * 超窗后无保留义务」——「对齐」在本仓的口径就是同一个数（`:150` 与 `:152` 前后两句都在说这件事）。
 * 若将来设计意图改成「不短于备份窗口」，改这一个函数即可，其它用例不必动。
 */
function assertSessionsRetentionAligned(retentionDays) {
  assert.equal(
    retentionDays,
    BACKUP_RETENTION_DAYS,
    `public.sessions 的回溯窗口 ${retentionDays} 天必须等于备份窗口 ${BACKUP_RETENTION_DAYS} 天`
      + '（`retention-policy.mjs` 的 `why` 自承「与备份30日内滚动清理对齐」）',
  );
}

// ---------------------------------------------------------------------------
// 1 ① 小时口径（反查）× ② 天口径：逐项相等
// ---------------------------------------------------------------------------

test('①deletion.mjs 的私有小时口径与 ②backup-retention.mjs 的天口径逐项相等', () => {
  const derived = deriveDeletionHours();
  // 先证反查本身没被小数污染：168.0001h 这种「接近但不等于」会让下面的等值比对失去意义。
  assert.ok(Number.isInteger(derived.onlineHours), `反查出的在线小时口径必须是整小时：${derived.onlineHours}`);
  assert.ok(Number.isInteger(derived.backupHours), `反查出的备份小时口径必须是整小时：${derived.backupHours}`);
  assertHoursParity('在线保留期', derived.onlineHours, ONLINE_RETENTION_DAYS);
  assertHoursParity('备份保留期', derived.backupHours, BACKUP_RETENTION_DAYS);
});

// ---------------------------------------------------------------------------
// 2 ③ 天口径 × ② 天口径：逐值相等，且接在同一条小时→天链上
// ---------------------------------------------------------------------------

test('③deletion-aging.ts 的天口径与 ② 逐值相等，并与 ① 反查值同链', () => {
  // 「一天」必须两边是同一个数，否则「×24」在 ②③ 算的不是同一件事。
  assert.equal(AGING_MS_PER_DAY, MS_PER_DAY, `deletion-aging.ts 的 MS_PER_DAY ${AGING_MS_PER_DAY} 必须等于 backup-retention.mjs 的 ${MS_PER_DAY}`);
  assert.equal(MS_PER_DAY, HOURS_PER_DAY * MS_PER_HOUR, `本文件的 HOURS_PER_DAY 换算桥必须落在 MS_PER_DAY=${MS_PER_DAY} 上`);

  // 天口径：② ↔ ③
  assert.equal(AGING_ONLINE_RETENTION_DAYS, ONLINE_RETENTION_DAYS, `在线天口径必须相等：${AGING_ONLINE_RETENTION_DAYS} ≠ ${ONLINE_RETENTION_DAYS}`);
  assert.equal(AGING_BACKUP_RETENTION_DAYS, BACKUP_RETENTION_DAYS, `备份天口径必须相等：${AGING_BACKUP_RETENTION_DAYS} ≠ ${BACKUP_RETENTION_DAYS}`);

  // 同一条链：① 反查值 ↔ ③ 天口径（不必经过 ②，避免 ② 成了唯一的中转站）
  const derived = deriveDeletionHours();
  assertHoursParity('在线保留期（经 deletion-aging.ts）', derived.onlineHours, AGING_ONLINE_RETENTION_DAYS);
  assertHoursParity('备份保留期（经 deletion-aging.ts）', derived.backupHours, AGING_BACKUP_RETENTION_DAYS);
});

// ---------------------------------------------------------------------------
// 3 ④ retention-policy.mjs 的 sessions 日历保留期：与备份窗口钉住相等
// ---------------------------------------------------------------------------

test('④retention-policy.mjs 的 sessions retentionDays 与备份窗口钉住相等', () => {
  // 按**表名**定位而不是按下标：策略表排序一变，下标就会指向另一张表，用例会假绿。
  const sessionsRows = RETENTION_POLICY.filter((entry) => entry.table === 'public.sessions');
  assert.equal(sessionsRows.length, 1, `public.sessions 在策略表里必须恰好一行：${sessionsRows.length}`);
  const sessions = sessionsRows[0];

  // 对照物先钉住：30 天约束的必须是「过期后按 expires_at 整行删除」这件事本身。
  assert.equal(sessions.ageColumn, 'expires_at', `sessions 的年龄列是 ${sessions.ageColumn}，30 天的对照物变了`);
  assert.equal(sessions.disposition, 'delete', `sessions 的处理方式是 ${sessions.disposition}，30 天的对照物变了`);

  assertSessionsRetentionAligned(sessions.retentionDays);
});

// ---------------------------------------------------------------------------
// 4 反向控制：判据不是恒真（⛔ 不临时改写生产常量，只把判据函数喂错值）
// ---------------------------------------------------------------------------

test('反向控制 A：小时/天等值判据在 6 天／8 天／31 天时确实会红', () => {
  const derived = deriveDeletionHours();

  // 正控：真值必须过 —— 否则下面的抛错可能只是「判据永远抛错」。
  assert.doesNotThrow(() => assertHoursParity('在线保留期', derived.onlineHours, ONLINE_RETENTION_DAYS));
  assert.doesNotThrow(() => assertHoursParity('备份保留期', derived.backupHours, BACKUP_RETENTION_DAYS));

  // 反控 1（天口径改成 6 天 = 把 ① 写成 6 * 24）：派生值与真值必须不等，判据必须抛错。
  const sixDays = ONLINE_RETENTION_DAYS - 1;
  assert.notEqual(hoursFromDays(sixDays), derived.onlineHours, `6 天派生出的 ${hoursFromDays(sixDays)}h 不该等于真实在线口径`);
  assert.throws(
    () => assertHoursParity('在线保留期', derived.onlineHours, sixDays),
    { name: 'AssertionError' },
    '天口径少一天时判据必须红',
  );

  // 反控 2（小时口径改成 8 天）：判据同样必须红。
  const eightDaysHours = hoursFromDays(ONLINE_RETENTION_DAYS + 1);
  assert.notEqual(eightDaysHours, derived.onlineHours, `8 天派生出的 ${eightDaysHours}h 不该等于真实在线口径`);
  assert.throws(
    () => assertHoursParity('在线保留期', eightDaysHours, ONLINE_RETENTION_DAYS),
    { name: 'AssertionError' },
    '小时口径多出 24h 时判据必须红',
  );

  // 反控 3（备份口径换成 31 天／29 天）：两侧各错一次都必须红。
  assert.notEqual(hoursFromDays(BACKUP_RETENTION_DAYS + 1), derived.backupHours, '31 天派生值不该等于真实备份口径');
  assert.throws(
    () => assertHoursParity('备份保留期', hoursFromDays(BACKUP_RETENTION_DAYS + 1), BACKUP_RETENTION_DAYS),
    { name: 'AssertionError' },
    '把备份小时口径临时改成 31 天时判据必须红',
  );
  assert.throws(
    () => assertHoursParity('备份保留期', derived.backupHours, BACKUP_RETENTION_DAYS - 1),
    { name: 'AssertionError' },
    '把备份天口径临时改成 29 天时判据必须红',
  );
});

test('反向控制 B：sessions 判据在 29 天／31 天时确实会红', () => {
  // 正控：真值必须过。
  assert.doesNotThrow(() => assertSessionsRetentionAligned(BACKUP_RETENTION_DAYS));

  // 反控：往上偏一天（31）、往下偏一天（29）都必须红 —— 「对齐」是等式，不是不等式。
  assert.throws(
    () => assertSessionsRetentionAligned(BACKUP_RETENTION_DAYS + 1),
    { name: 'AssertionError' },
    '把 sessions 临时改成 31 天时判据必须红',
  );
  assert.throws(
    () => assertSessionsRetentionAligned(BACKUP_RETENTION_DAYS - 1),
    { name: 'AssertionError' },
    '把 sessions 临时改成 29 天时判据必须红',
  );
});
