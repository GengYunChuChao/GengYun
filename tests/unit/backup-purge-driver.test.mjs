// GY-I19（#19）· 备份副本 30 日到期清除驱动 · **纯逻辑**单测（不连库、不读系统时钟）
//
// 本文件只验证 `services/api/src/privacy/backup-purge-driver.ts` 的判定与编排：
//   [1] 到期边界（恰好等于 cutoff / 早 1 秒 / 晚 1 秒）与「未到期绝不清」；
//   [2] 批量上限（超出 limit 的组留给下一轮，且顺序确定）；
//   [3] 失败不阻塞（单组 blocked / 抛错都只影响该组）；
//   [4] 幂等重跑（成功组已 purged ⇒ 第二轮 0 组）；
//   [5] failed 行默认跳过、`--retry-failed` 显式重排后才清；
//   [6] `--dry-run` 一次都不碰库；
//   [7] 读数口径：成功 + 跳过 + 失败 ≡ 处理组数；输出不含主体 id。
//
// 真库臂在 `tests/integration/backup-copies-purge-pg.mjs`（未取得 PG 二进制 ⇒ 77 跳过）。

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BACKUP_COPY_DUE_GROUPS_SQL,
  BACKUP_COPY_MIXED_GROUPS_SQL,
  BACKUP_PURGE_DRIVER_ERROR_CODES,
  BACKUP_PURGE_DRIVER_SKIP_REASONS,
  DEFAULT_BACKUP_PURGE_BATCH_LIMIT,
  MAX_BACKUP_PURGE_BATCH_LIMIT,
  backupPurgeExitCode,
  formatBackupPurgeReport,
  listDueBackupCopyGroups,
  normalizeBackupPurgeLimit,
  requeueFailedBackupCopyGroup,
  runBackupPurgeBatch,
} from '../../services/api/src/privacy/backup-purge-driver.ts';

const CUTOFF = '2026-10-21T00:00:00.000Z';
const ONE_SECOND = 1000;

/** 造一个「组」：`offsetMs` 是组内**最晚** retention_until 相对 cutoff 的偏移（负=已到期）。 */
function group(index, { offsetMs = -ONE_SECOND, failedRows = 0, rowCount = 1 } = {}) {
  return {
    requestId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    userId: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
    module: 'favorites',
    rowCount,
    pendingRows: rowCount - failedRows,
    failedRows,
    retentionUntil: new Date(Date.parse(CUTOFF) + offsetMs).toISOString(),
  };
}

/** 记录调用的假端口：默认每组的每一次调用都返回 `purged`。 */
function fakePort(handler) {
  const calls = [];
  return {
    calls,
    async purge(input) {
      calls.push(input);
      return handler === undefined
        ? { purged: true, outcome: 'purged', evidenceRef: 'sha256:' + 'a'.repeat(64) }
        : handler(input, calls.length - 1);
    },
  };
}

// ---------------------------------------------------------------------------
// [1] 到期边界：闭区间（相等即到期），早 1 秒到期，晚 1 秒不算
// ---------------------------------------------------------------------------
test('到期边界：恰好等于 cutoff ⇒ 清除；早 1 秒 ⇒ 清除；晚 1 秒 ⇒ 跳过且从不调 purge', async () => {
  const port = fakePort();
  const report = await runBackupPurgeBatch({
    cutoff: CUTOFF,
    groups: [
      group(1, { offsetMs: 0 }), // 恰好等于 now
      group(2, { offsetMs: -ONE_SECOND }), // 早 1 秒
      group(3, { offsetMs: ONE_SECOND }), // 晚 1 秒
    ],
    purge: (input) => port.purge(input),
  });

  assert.deepEqual(port.calls.map((call) => call.requestId), [group(1).requestId, group(2).requestId]);
  assert.equal(report.succeeded, 2);
  assert.equal(report.skipped, 1);
  assert.equal(report.failed, 0);
  assert.equal(report.skipReasons[BACKUP_PURGE_DRIVER_SKIP_REASONS.NOT_DUE], 1);
  assert.equal(report.processed, report.succeeded + report.skipped + report.failed);
});

test('未到期不动：全部未到期时一个 purge 调用都没有，退出码仍是 0（不是失败）', async () => {
  const port = fakePort();
  const report = await runBackupPurgeBatch({
    cutoff: CUTOFF,
    groups: [group(1, { offsetMs: ONE_SECOND }), group(2, { offsetMs: 86_400_000 })],
    purge: (input) => port.purge(input),
  });
  assert.equal(port.calls.length, 0, '未到期的组不得进入清除路径（端口一次都不该被调）');
  assert.equal(report.succeeded, 0);
  assert.equal(report.skipped, 2);
  assert.equal(backupPurgeExitCode(report), 0);
});

// ---------------------------------------------------------------------------
// [2] 批量上限
// ---------------------------------------------------------------------------
test('批量上限：limit=2 时只处理前 2 组，剩余计入 remaining（下一轮再取）', async () => {
  const groups = [group(1, { offsetMs: -3000 }), group(2, { offsetMs: -2000 }), group(3, { offsetMs: -1000 }), group(4)];
  const port = fakePort();
  const report = await runBackupPurgeBatch({
    cutoff: CUTOFF,
    groups,
    limit: 2,
    totalDue: 4,
    purge: (input) => port.purge(input),
  });

  assert.equal(report.processed, 2);
  assert.equal(report.succeeded, 2);
  assert.equal(report.remaining, 2, '库内 4 组待清、本批只处理 2 组 ⇒ 剩余 2 组');
  assert.deepEqual(port.calls.map((call) => call.requestId), [groups[0].requestId, groups[1].requestId], '顺序必须与 SQL 的排序一致（先到期的先处理）');
});

test('批量上限校验：0／负数／小数／超硬顶一律抛错（不静默夹取）', () => {
  assert.equal(normalizeBackupPurgeLimit(undefined), DEFAULT_BACKUP_PURGE_BATCH_LIMIT);
  assert.equal(normalizeBackupPurgeLimit(1), 1);
  assert.equal(normalizeBackupPurgeLimit(MAX_BACKUP_PURGE_BATCH_LIMIT), MAX_BACKUP_PURGE_BATCH_LIMIT);
  for (const bad of [0, -1, 1.5, Number.NaN, MAX_BACKUP_PURGE_BATCH_LIMIT + 1]) {
    assert.throws(() => normalizeBackupPurgeLimit(bad), RangeError, `limit=${String(bad)} 必须被拒`);
  }
});

// ---------------------------------------------------------------------------
// [3] 失败不阻塞
// ---------------------------------------------------------------------------
test('失败不阻塞：第 1 组 blocked、第 2 组抛错，第 3 组照样清除', async () => {
  const port = fakePort((input) => {
    if (input.requestId === group(1).requestId) {
      return { purged: false, outcome: 'blocked', errorCode: 'STORE_UNREACHABLE', reason: '清除事务失败' };
    }
    if (input.requestId === group(2).requestId) {
      throw new Error('端口自己炸了');
    }
    return { purged: true, outcome: 'purged', evidenceRef: 'sha256:' + 'b'.repeat(64) };
  });
  const report = await runBackupPurgeBatch({
    cutoff: CUTOFF,
    groups: [group(1), group(2), group(3)],
    purge: (input) => port.purge(input),
  });

  assert.equal(report.processed, 3);
  assert.equal(report.succeeded, 1, '第 3 组必须照常清除（失败不得阻塞后面的行）');
  assert.equal(report.failed, 2);
  assert.deepEqual(
    report.failures.map((failure) => failure.errorCode),
    ['STORE_UNREACHABLE', BACKUP_PURGE_DRIVER_ERROR_CODES.DRIVER_EXCEPTION],
  );
  assert.equal(backupPurgeExitCode(report), 1);
});

test('端口返回 waiting（复核后仍未到期）⇒ 计跳过，⛔ 不算成功', async () => {
  const report = await runBackupPurgeBatch({
    cutoff: CUTOFF,
    groups: [group(1)],
    purge: async () => ({ purged: false, outcome: 'waiting', reason: 'BACKUP_WAITING_RETENTION' }),
  });
  assert.equal(report.succeeded, 0);
  assert.equal(report.skipped, 1);
  assert.equal(report.failed, 0);
  assert.equal(report.skipReasons[BACKUP_PURGE_DRIVER_SKIP_REASONS.WAITING_RETENTION], 1);
});

test('旧式返回值 {purged:false} 无 outcome ⇒ 按 blocked 计失败（不静默当跳过）', async () => {
  const report = await runBackupPurgeBatch({
    cutoff: CUTOFF,
    groups: [group(1)],
    purge: async () => ({ purged: false }),
  });
  assert.equal(report.failed, 1);
  assert.equal(report.failures[0].errorCode, 'STORE_REJECTED');
});

// ---------------------------------------------------------------------------
// [4] 幂等重跑
// ---------------------------------------------------------------------------
test('幂等重跑：成功清过的组从待清集合消失 ⇒ 第二轮 0 组、0 行、退出码 0', async () => {
  // 有状态假库：purge 成功后该组变成「已清」，枚举自然取不到（与 SQL 的 state <> 'purged' 同构）。
  const pending = new Map([group(1), group(2)].map((item) => [item.requestId, item]));
  const purgeCalls = [];
  const purge = async (input) => {
    purgeCalls.push(input.requestId);
    pending.delete(input.requestId);
    return { purged: true, outcome: 'purged', evidenceRef: 'sha256:' + 'c'.repeat(64) };
  };
  const enumerate = () => [...pending.values()].filter((item) => Date.parse(item.retentionUntil) <= Date.parse(CUTOFF));

  const first = await runBackupPurgeBatch({ cutoff: CUTOFF, groups: enumerate(), purge, totalDue: pending.size });
  assert.equal(first.succeeded, 2);
  assert.equal(first.rowsPurged, 2);
  assert.equal(pending.size, 0);

  const second = await runBackupPurgeBatch({ cutoff: CUTOFF, groups: enumerate(), purge });
  assert.equal(second.candidates, 0);
  assert.equal(second.processed, 0);
  assert.equal(second.succeeded, 0);
  assert.equal(second.remaining, 0);
  assert.equal(purgeCalls.length, 2, '第二轮不得再调端口（幂等：不会重复清、不会重复写证据）');
  assert.equal(backupPurgeExitCode(second), 0);
});

// ---------------------------------------------------------------------------
// [5] failed 行的两种口径
// ---------------------------------------------------------------------------
test('failed 行：默认改跳过（不调 purge），退出码 1（链路还有清不掉的副本行）', async () => {
  const port = fakePort();
  const report = await runBackupPurgeBatch({
    cutoff: CUTOFF,
    groups: [group(1, { failedRows: 1 })],
    purge: (input) => port.purge(input),
  });
  assert.equal(port.calls.length, 0, 'has failed 行时不得再调端口（端口只会返回 blocked/STORE_REJECTED）');
  assert.equal(report.skipped, 1);
  assert.equal(report.skipReasons[BACKUP_PURGE_DRIVER_SKIP_REASONS.FAILED_NEEDS_REQUEUE], 1);
  assert.equal(backupPurgeExitCode(report), 1, 'failed 行未处理不是「干净」');
});

test('failed 行：--retry-failed 先重排再清除，重排计数如实报出', async () => {
  const port = fakePort();
  const requeues = [];
  const report = await runBackupPurgeBatch({
    cutoff: CUTOFF,
    groups: [group(1, { failedRows: 1 })],
    retryFailed: true,
    purge: (input) => port.purge(input),
    requeue: async (input) => {
      requeues.push(input.requestId);
      return true;
    },
  });
  assert.deepEqual(requeues, [group(1).requestId]);
  assert.equal(report.requeued, 1);
  assert.equal(report.succeeded, 1);
  assert.equal(backupPurgeExitCode(report), 0);
});

test('failed 行：重排失败 ⇒ 该组失败（REQUEUE_FAILED）且不调 purge；未接重排实现 ⇒ REQUEUE_UNAVAILABLE', async () => {
  const port = fakePort();
  const requeueFailed = await runBackupPurgeBatch({
    cutoff: CUTOFF,
    groups: [group(1, { failedRows: 1 }), group(2)],
    retryFailed: true,
    purge: (input) => port.purge(input),
    requeue: async () => false,
  });
  assert.equal(requeueFailed.failures[0].errorCode, BACKUP_PURGE_DRIVER_ERROR_CODES.REQUEUE_FAILED);
  assert.deepEqual(port.calls.map((call) => call.requestId), [group(2).requestId], '重排失败的组不得进入 purge，后续组照常');

  const noRequeue = await runBackupPurgeBatch({
    cutoff: CUTOFF,
    groups: [group(1, { failedRows: 1 })],
    retryFailed: true,
    purge: (input) => port.purge(input),
  });
  assert.equal(noRequeue.failures[0].errorCode, BACKUP_PURGE_DRIVER_ERROR_CODES.REQUEUE_UNAVAILABLE);
});

// ---------------------------------------------------------------------------
// [6] dry-run
// ---------------------------------------------------------------------------
test('--dry-run：到期的组全部计 dry_run，端口与重排一次都不被调用', async () => {
  const port = fakePort();
  let requeueCalls = 0;
  const report = await runBackupPurgeBatch({
    cutoff: CUTOFF,
    groups: [group(1), group(2, { failedRows: 1 })],
    dryRun: true,
    retryFailed: true,
    purge: (input) => port.purge(input),
    requeue: async () => {
      requeueCalls += 1;
      return true;
    },
  });
  assert.equal(port.calls.length, 0);
  assert.equal(requeueCalls, 0);
  assert.equal(report.succeeded, 0);
  assert.equal(report.skipped, 2);
  // 带 --retry-failed 时，failed 组在 dry-run 下的预告是「会重排再清」⇒ 计入 dry_run。
  assert.equal(report.skipReasons[BACKUP_PURGE_DRIVER_SKIP_REASONS.DRY_RUN], 2);

  // 不带 --retry-failed 时，同一组必须报 failed_needs_requeue：这才是运维需要看到的信号。
  const withoutRetry = await runBackupPurgeBatch({
    cutoff: CUTOFF,
    groups: [group(2, { failedRows: 1 })],
    dryRun: true,
    purge: (input) => port.purge(input),
  });
  assert.equal(withoutRetry.skipReasons[BACKUP_PURGE_DRIVER_SKIP_REASONS.FAILED_NEEDS_REQUEUE], 1);
  assert.equal(port.calls.length, 0);
});

// ---------------------------------------------------------------------------
// [7] 读数与隐私口径
// ---------------------------------------------------------------------------
test('cutoff 不可解析 ⇒ 抛错（不猜时间、不静默跑空批）', async () => {
  for (const bad of ['2026-10-21T00:00:00', 'not-a-time', '', null]) {
    await assert.rejects(
      () => runBackupPurgeBatch({ cutoff: bad, groups: [], purge: async () => ({ purged: false }) }),
      TypeError,
      `cutoff=${String(bad)} 必须被拒（裸本地时间不接受）`,
    );
  }
});

test('读数：成功+跳过+失败 ≡ 处理组数；剩余 = 库内合计 − 处理；细节行不含主体 id', async () => {
  const port = fakePort((input) =>
    input.requestId === group(2).requestId
      ? { purged: false, outcome: 'blocked', errorCode: 'EVIDENCE_REQUIRED', reason: '无副本清单行' }
      : { purged: true, outcome: 'purged', evidenceRef: 'sha256:' + 'd'.repeat(64) });
  const report = await runBackupPurgeBatch({
    cutoff: CUTOFF,
    groups: [group(1), group(2), group(3, { offsetMs: ONE_SECOND })],
    limit: 3,
    totalDue: 7,
    purge: (input) => port.purge(input),
  });
  assert.equal(report.processed, report.succeeded + report.skipped + report.failed);
  assert.equal(report.processed, 3);
  assert.equal(report.remaining, 4, '库内 7 组、本批处理 3 组 ⇒ 剩余 4 组');

  const text = formatBackupPurgeReport(report).join('\n');
  assert.match(text, /SUMMARY .*processed=3 succeeded=1 skipped=1 failed=1/);
  assert.match(text, /remaining=4/);
  assert.match(text, /exit=1/);
  assert.equal(text.includes(group(1).userId), false, '输出不得含主体 id（只留不透明 request_id 与模块名）');
  assert.equal(text.includes(group(2).requestId), true, '失败行要能靠 request_id + module 定位到库里的行');
});

test('退出码：干净批次 0；有失败组 1；有「部分到期」组 1（不清但必须让人看见）', async () => {
  const clean = await runBackupPurgeBatch({
    cutoff: CUTOFF,
    groups: [group(1)],
    purge: async () => ({ purged: true, outcome: 'purged', evidenceRef: 'sha256:' + 'e'.repeat(64) }),
  });
  assert.equal(backupPurgeExitCode(clean), 0);
  const dirty = await runBackupPurgeBatch({
    cutoff: CUTOFF,
    groups: [group(1)],
    purge: async () => ({ purged: false, outcome: 'blocked', errorCode: 'STORE_UNREACHABLE' }),
  });
  assert.equal(backupPurgeExitCode(dirty), 1);

  const mixed = await runBackupPurgeBatch({
    cutoff: CUTOFF,
    groups: [],
    mixedGroups: 1,
    purge: async () => ({ purged: false }),
  });
  assert.equal(mixed.mixedGroups, 1);
  assert.equal(backupPurgeExitCode(mixed), 1);
  assert.match(formatBackupPurgeReport(mixed).join('\n'), /另发现 1 组「部分到期」/);
});

// ---------------------------------------------------------------------------
// [8] 读库形状（假 client，不需要真 PG）
// ---------------------------------------------------------------------------
test('到期扫描 SQL：候选只在到期行上取，再对整组全部未清行做 max 判定（朴素 HAVING 会退化成空操作）', async () => {
  assert.match(BACKUP_COPY_DUE_GROUPS_SQL, /state <> 'purged'/);
  assert.match(BACKUP_COPY_DUE_GROUPS_SQL, /retention_until <= \$1::timestamptz/);
  assert.match(BACKUP_COPY_DUE_GROUPS_SQL, /HAVING max\(c\.retention_until\) <= \$1::timestamptz/, '整组到期才允许清（部分到期会被端口复核判失败）');
  assert.match(BACKUP_COPY_DUE_GROUPS_SQL, /JOIN cand/);
  assert.match(BACKUP_COPY_MIXED_GROUPS_SQL, /HAVING max\(c\.retention_until\) > \$1::timestamptz/, '部分到期单独计数（只上报不处理）');

  const seen = [];
  const client = {
    async query(text, values) {
      seen.push({ text, values });
      if (text.includes('AS mixed_groups')) return { rows: [{ mixed_groups: 2 }] };
      return {
        rows: [
          {
            request_id: group(1).requestId,
            user_id: group(1).userId,
            module: 'favorites',
            row_count: 2,
            pending_rows: 2,
            failed_rows: 0,
            due_at: new Date(CUTOFF),
            last_retention_until: new Date(Date.parse(CUTOFF) - ONE_SECOND),
            total_due: 5,
          },
        ],
      };
    },
  };
  const { groups, totalDue, mixedGroups } = await listDueBackupCopyGroups(client, { cutoff: CUTOFF, limit: 10 });
  assert.deepEqual(seen[0].values, [CUTOFF, 10]);
  assert.equal(totalDue, 5, '库内合计来自窗口列 total_due，不是本批行数');
  assert.equal(mixedGroups, 2, '部分到期的组数必须如实上报');
  assert.deepEqual(groups[0], {
    requestId: group(1).requestId,
    userId: group(1).userId,
    module: 'favorites',
    rowCount: 2,
    pendingRows: 2,
    failedRows: 0,
    retentionUntil: new Date(Date.parse(CUTOFF) - ONE_SECOND).toISOString(),
  });

  // 期限读不出来 ⇒ 拒绝据此清除（漏清好过误清）。
  await assert.rejects(
    () => listDueBackupCopyGroups({ query: async () => ({ rows: [{ request_id: 'x', user_id: 'y', module: 'm', row_count: 1, pending_rows: 1, failed_rows: 0, last_retention_until: null, total_due: 1 }] }) }, { cutoff: CUTOFF }),
    TypeError,
  );
});

test('显式重排：改到行 ⇒ true；0 行且复核无 failed ⇒ true（并发者已重排）；0 行但仍有 failed ⇒ false', async () => {
  const cutoff = CUTOFF;
  const key = { requestId: group(1).requestId, userId: group(1).userId, module: 'favorites', cutoff };
  const updated = { query: async () => ({ rows: [{ scope: 'favorite' }] }) };
  assert.equal(await requeueFailedBackupCopyGroup(updated, key), true);

  const noopNoFailed = {
    query: async (text) => (text.includes('RETURNING scope') ? { rows: [] } : { rows: [{ failed_rows: 0 }] }),
  };
  assert.equal(await requeueFailedBackupCopyGroup(noopNoFailed, key), true);

  const noopStillFailed = {
    query: async (text) => (text.includes('RETURNING scope') ? { rows: [] } : { rows: [{ failed_rows: 2 }] }),
  };
  assert.equal(await requeueFailedBackupCopyGroup(noopStillFailed, key), false);
});
