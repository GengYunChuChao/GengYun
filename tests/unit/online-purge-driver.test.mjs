// GY-R28 · W6（#19）· 在线数据 7 日到期清除驱动 · **纯逻辑**单测（不连库、不读系统时钟）
//
// 本文件只验证 `services/api/src/privacy/online-purge-driver.ts` 的判定与编排：
//   [1] 到期边界（恰好等于 cutoff / 早 1 秒 / 晚 1 秒）与「未到期绝不清」；
//   [2] 批量上限（超出 limit 的请求留给下一轮，且顺序确定；`remaining` 如实递减）；
//   [3] 失败不阻塞（单模块抛错 / 返回非法形状都只影响该行，同请求其余模块与后续请求照跑）；
//   [4] 幂等重跑（已清过 ⇒ 第二轮全落 `already_purged`、`rowsPurged` 仍为 0）；
//   [5] `--dry-run` 一次都不碰库；
//   [6] 每个成功行写证据（`sha256:` 摘要，稳定 / 不撞 / 不含主体标识）；
//   [7] 读数口径：成功 + 跳过 + 失败 ≡ 处理请求数；报告文本不含 `user_id`；
//   [8] 参数与 SQL 口径（`--limit` 非法即抛、候选 SQL 按 `online_due_at <= cutoff` 且不排除 `blocked`）；
//   [9] **批次推进**（[P1] 监工 1021/1806）：超过 `limit` 的到期集合连跑即可全部处理，且不伪造 completed。
//
// 真库臂在 `tests/integration/online-purge-pg.mjs`（未取得 PG 二进制 ⇒ 77 跳过）。

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_ONLINE_PURGE_BATCH_LIMIT,
  DEFAULT_ONLINE_PURGE_MAX_BATCHES,
  MAX_ONLINE_PURGE_BATCH_LIMIT,
  MAX_ONLINE_PURGE_MAX_BATCHES,
  ONLINE_PURGE_DRIVER_ERROR_CODES,
  ONLINE_PURGE_DUE_COUNT_SQL,
  ONLINE_PURGE_DUE_SQL,
  ONLINE_PURGE_EVIDENCE_VERSION,
  ONLINE_PURGE_SKIP_REASONS,
  cursorAfterCandidate,
  drainDueOnlineDeletions,
  formatOnlinePurgeReport,
  listDueOnlineDeletions,
  normalizeOnlinePurgeCursor,
  normalizeOnlinePurgeLimit,
  normalizeOnlinePurgeMaxBatches,
  onlinePurgeEvidenceRef,
  onlinePurgeExitCode,
  runOnlinePurgeBatch,
  sanitizeOnlinePurgeErrorCode,
} from '../../services/api/src/privacy/online-purge-driver.ts';

const CUTOFF = '2026-10-21T00:00:00.000Z';
const CUTOFF_MS = Date.parse(CUTOFF);
const ONE_SECOND = 1000;
const MODULES = ['favorites', 'history', 'messages', 'conversations'];

/** 造一个到期候选：`offsetMs` 是 `online_due_at` 相对 cutoff 的偏移（负 = 已到期）。 */
function candidate(index, offsetMs = -ONE_SECOND) {
  return {
    requestId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    userId: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
    onlineDueAt: new Date(CUTOFF_MS + offsetMs).toISOString(),
  };
}

/** 记录每次调用的假端口；`handler` 缺省时四域各清 2 行。 */
function fakePort(handler) {
  const calls = [];
  return {
    calls,
    async purgeModule(input) {
      calls.push(input);
      if (handler === undefined) return { removed: 2, idempotency: 1 };
      return handler(input, calls.length - 1);
    },
  };
}

// ---------------------------------------------------------------- [1] 到期边界

test('[1] 到期是闭区间：恰好等于 cutoff 与早 1 秒都清，晚 1 秒一行都不碰', async () => {
  const atCutoff = candidate(1, 0);
  const before = candidate(2, -ONE_SECOND);
  const after = candidate(3, ONE_SECOND);
  const port = fakePort();

  const report = await runOnlinePurgeBatch({
    cutoff: CUTOFF,
    limit: 10,
    requests: [atCutoff, before, after],
    totalDue: 3,
    dryRun: false,
    modules: MODULES,
    purge: port,
  });

  assert.equal(report.processed, 3, '三个候选都要被看到（未到期的也要落 skip，而不是静默丢掉）');
  assert.equal(report.succeeded, 2);
  assert.equal(report.skipped, 1);
  assert.equal(report.skipReasons[ONLINE_PURGE_SKIP_REASONS.NOT_DUE], 1);
  // 未到期的那一个请求，四域**一次都没被调用**。
  const afterCalls = port.calls.filter((call) => call.requestId === after.requestId);
  assert.equal(afterCalls.length, 0, '未到期绝不清：候选里的未到期请求不能触发任何清理');
});

test('[1b] 到期时刻不可解析 ⇒ 既不猜着清、也不谎称干净（全模块记 RESULT_INVALID）', async () => {
  const broken = { ...candidate(1), onlineDueAt: '2026-10-21T00:00:00' }; // 裸本地时间
  const port = fakePort();

  const report = await runOnlinePurgeBatch({
    cutoff: CUTOFF,
    limit: 10,
    requests: [broken],
    totalDue: 1,
    dryRun: false,
    modules: MODULES,
    purge: port,
  });

  assert.equal(port.calls.length, 0);
  assert.equal(report.failed, 1);
  assert.equal(report.failures.length, MODULES.length);
  for (const row of report.failures) {
    assert.equal(row.errorCode, ONLINE_PURGE_DRIVER_ERROR_CODES.RESULT_INVALID);
  }
});

test('[1c] cutoff 与到期时刻必须是 Date 或带时区 ISO：裸本地时间直接抛 TypeError', async () => {
  const port = fakePort();
  await assert.rejects(
    runOnlinePurgeBatch({
      cutoff: '2026-10-21T00:00:00',
      limit: 10,
      requests: [],
      totalDue: 0,
      dryRun: false,
      modules: MODULES,
      purge: port,
    }),
    /带时区的 ISO-8601/,
  );
});

// ---------------------------------------------------------------- [2] 批量上限

test('[2] 批量上限：超出 limit 的请求留给下一轮，且 remaining 如实递减', async () => {
  const requests = [candidate(1), candidate(2), candidate(3)];
  const port = fakePort();

  const report = await runOnlinePurgeBatch({
    cutoff: CUTOFF,
    limit: 2,
    requests,
    totalDue: 3,
    dryRun: false,
    modules: MODULES,
    purge: port,
  });

  assert.equal(report.processed, 2);
  assert.equal(report.succeeded, 2);
  assert.equal(report.remaining, 1, 'totalDue 3 减去本轮 2 ⇒ 还剩 1');
  // 第三个请求一次都没被碰过。
  assert.equal(port.calls.filter((call) => call.requestId === requests[2].requestId).length, 0);
  // 顺序＝入参顺序（候选 SQL 已按 (online_due_at, id) 排序，驱动不再洗牌）。
  const firstTouch = port.calls.slice(0, MODULES.length).map((call) => call.requestId);
  assert.deepEqual([...new Set(firstTouch)], [requests[0].requestId]);
});

test('[2b] 上限归一：非法/超顶一律抛 RangeError，不夹取、不默认', () => {
  assert.equal(normalizeOnlinePurgeLimit(200), 200);
  assert.equal(normalizeOnlinePurgeLimit('50'), 50);
  assert.equal(normalizeOnlinePurgeLimit(MAX_ONLINE_PURGE_BATCH_LIMIT), MAX_ONLINE_PURGE_BATCH_LIMIT);
  for (const bad of ['abc', '5.5', '2e3', '', ' 0', 0, -1, 1.5, NaN, MAX_ONLINE_PURGE_BATCH_LIMIT + 1]) {
    assert.throws(() => normalizeOnlinePurgeLimit(bad), RangeError, `应拒绝 ${String(bad)}`);
  }
  assert.equal(DEFAULT_ONLINE_PURGE_BATCH_LIMIT, 200);
});

test('[2c] 必需模块闭集为空 ⇒ 拒绝跑（空闭集会让「什么都没清」冒充干净）', async () => {
  await assert.rejects(
    runOnlinePurgeBatch({
      cutoff: CUTOFF,
      limit: 10,
      requests: [candidate(1)],
      totalDue: 1,
      dryRun: false,
      modules: [],
      purge: fakePort(),
    }),
    RangeError,
  );
});

// ---------------------------------------------------------------- [3] 失败不阻塞

test('[3] 单模块抛错只影响该行：同请求其余模块照清、后续请求照跑，已成功的证据保留', async () => {
  const requests = [candidate(1), candidate(2)];
  const port = fakePort(async (input) => {
    if (input.requestId === requests[0].requestId && input.module === 'history') {
      const error = new Error('replica down');
      error.code = 'STORE_UNREACHABLE';
      throw error;
    }
    return { removed: 3, idempotency: 1 };
  });

  const report = await runOnlinePurgeBatch({
    cutoff: CUTOFF,
    limit: 10,
    requests,
    totalDue: 2,
    dryRun: false,
    modules: MODULES,
    purge: port,
  });

  assert.equal(report.failed, 1, '第一个请求整体记失败');
  assert.equal(report.succeeded, 1, '第二个请求不受影响');
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0].module, 'history');
  assert.equal(report.failures[0].errorCode, 'STORE_UNREACHABLE');
  // 第一个请求另外三个模块的证据**照样在**（每个成功行写证据，不因同请求有失败就丢弃）。
  const evidenceForFirst = report.evidence.filter((row) => row.requestId === requests[0].requestId);
  assert.deepEqual(
    evidenceForFirst.map((row) => row.module).sort(),
    ['conversations', 'favorites', 'messages'],
  );
  assert.equal(report.rowsPurged, 3 * 3 + 3 * 4 - 0, '第一个请求 3 行 + 第二个请求 12 行');
  assert.equal(onlinePurgeExitCode(report), 1);
});

test('[3b] 端口抛出的非安全错误码折叠成 DRIVER_EXCEPTION（原文不进报告）', async () => {
  const port = fakePort(async () => {
    const error = new Error('connect ECONNREFUSED 10.0.0.7:5432');
    error.code = 'ECONNREFUSED';
    throw error;
  });

  const report = await runOnlinePurgeBatch({
    cutoff: CUTOFF,
    limit: 10,
    requests: [candidate(1)],
    totalDue: 1,
    dryRun: false,
    modules: ['favorites'],
    purge: port,
  });

  assert.equal(report.failures[0].errorCode, ONLINE_PURGE_DRIVER_ERROR_CODES.DRIVER_EXCEPTION);
  const text = formatOnlinePurgeReport(report).join('\n');
  assert.ok(!text.includes('ECONNREFUSED'), '报告不能泄露驱动原文（可能带主机/端口）');
  assert.ok(!text.includes('10.0.0.7'));
});

test('[3c] 端口返回非法形状（负数/非整数）⇒ RESULT_INVALID，不当成 0 行', async () => {
  const port = fakePort(async () => ({ removed: -1, idempotency: 0 }));
  const report = await runOnlinePurgeBatch({
    cutoff: CUTOFF,
    limit: 10,
    requests: [candidate(1)],
    totalDue: 1,
    dryRun: false,
    modules: ['favorites'],
    purge: port,
  });
  assert.equal(report.failed, 1);
  assert.equal(report.failures[0].errorCode, ONLINE_PURGE_DRIVER_ERROR_CODES.RESULT_INVALID);
  assert.equal(report.rowsPurged, 0);
});

test('[3d] 安全错误码集合原样保留', () => {
  assert.equal(sanitizeOnlinePurgeErrorCode('STORE_REJECTED'), 'STORE_REJECTED');
  assert.equal(sanitizeOnlinePurgeErrorCode('EVIDENCE_REQUIRED'), 'EVIDENCE_REQUIRED');
  assert.equal(sanitizeOnlinePurgeErrorCode('42P01'), ONLINE_PURGE_DRIVER_ERROR_CODES.DRIVER_EXCEPTION);
  assert.equal(sanitizeOnlinePurgeErrorCode(undefined), ONLINE_PURGE_DRIVER_ERROR_CODES.DRIVER_EXCEPTION);
});

// ---------------------------------------------------------------- [4] 幂等

test('[4] 幂等重跑：第一轮清 4 行，第二轮同样候选集全落 already_purged 且 rowsPurged 归零', async () => {
  const requests = [candidate(1), candidate(2)];

  const firstPort = fakePort(async (input) => ({ removed: input.module === 'messages' ? 0 : 2, idempotency: 0 }));
  const first = await runOnlinePurgeBatch({
    cutoff: CUTOFF,
    limit: 10,
    requests,
    totalDue: 2,
    dryRun: false,
    modules: MODULES,
    purge: firstPort,
  });
  assert.equal(first.succeeded, 2);
  assert.equal(first.rowsPurged, 2 * 3 * 2);

  // 第二轮：库里的行已经没了 ⇒ 四域都返回 0 行 0 台账。
  const secondPort = fakePort(async () => ({ removed: 0, idempotency: 0 }));
  const second = await runOnlinePurgeBatch({
    cutoff: CUTOFF,
    limit: 10,
    requests,
    totalDue: 2,
    dryRun: false,
    modules: MODULES,
    purge: secondPort,
  });

  assert.equal(second.processed, 2);
  assert.equal(second.succeeded, 0, '第二轮不能有任何「成功」');
  assert.equal(second.skipped, 2);
  assert.equal(second.skipReasons[ONLINE_PURGE_SKIP_REASONS.ALREADY_PURGED], 2);
  assert.equal(second.rowsPurged, 0, '幂等的可核对读数：再跑一次清 0 行');
  assert.equal(second.idempotencyPurged, 0);
  assert.equal(onlinePurgeExitCode(second), 0, '重复跑是干净退出，不是失败');
  assert.equal(secondPort.calls.length, 2 * MODULES.length, '第二轮仍逐模块问过库（不是凭状态位跳过）');
});

test('[4b] 只有幂等台账有行（正文 0 行）也算清理成功，不算 already_purged', async () => {
  const port = fakePort(async (input) =>
    input.module === 'favorites' ? { removed: 0, idempotency: 3 } : { removed: 0, idempotency: 0 },
  );
  const report = await runOnlinePurgeBatch({
    cutoff: CUTOFF,
    limit: 10,
    requests: [candidate(1)],
    totalDue: 1,
    dryRun: false,
    modules: MODULES,
    purge: port,
  });
  assert.equal(report.succeeded, 1);
  assert.equal(report.rowsPurged, 0);
  assert.equal(report.idempotencyPurged, 3);
});

// ---------------------------------------------------------------- [5] dry-run

test('[5] --dry-run：只列到期请求，端口一次都不调用', async () => {
  const port = fakePort();
  const report = await runOnlinePurgeBatch({
    cutoff: CUTOFF,
    limit: 10,
    requests: [candidate(1), candidate(2)],
    totalDue: 2,
    dryRun: true,
    modules: MODULES,
    purge: port,
  });

  assert.equal(port.calls.length, 0, 'dry-run 不许碰库');
  assert.equal(report.dryRun, true);
  assert.equal(report.skipped, 2);
  assert.equal(report.skipReasons[ONLINE_PURGE_SKIP_REASONS.DRY_RUN], 2);
  assert.equal(report.rowsPurged, 0);
  assert.equal(onlinePurgeExitCode(report), 0);
});

// ---------------------------------------------------------------- [6] 证据

test('[6] 每个成功行一条 sha256 证据：稳定、随输入变化、不含主体标识', () => {
  const base = { requestId: '00000000-0000-4000-8000-000000000001', module: 'favorites', removed: 3, idempotency: 1 };
  const a = onlinePurgeEvidenceRef(base);
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
  assert.equal(a, onlinePurgeEvidenceRef({ ...base }), '同输入必须同证据（可复算）');
  assert.notEqual(a, onlinePurgeEvidenceRef({ ...base, removed: 4 }));
  assert.notEqual(a, onlinePurgeEvidenceRef({ ...base, idempotency: 0 }));
  assert.notEqual(a, onlinePurgeEvidenceRef({ ...base, module: 'history' }));
  assert.notEqual(
    a,
    onlinePurgeEvidenceRef({ ...base, requestId: '00000000-0000-4000-8000-000000000002' }),
  );
  assert.ok(!a.includes(base.requestId), '证据是摘要，不内嵌 request_id 原文');
  assert.equal(ONLINE_PURGE_EVIDENCE_VERSION, 'gengyun/online-purge/v1');
});

test('[6b] 报告里的证据条数恒等于「成功模块行」条数', async () => {
  const port = fakePort();
  const report = await runOnlinePurgeBatch({
    cutoff: CUTOFF,
    limit: 10,
    requests: [candidate(1), candidate(2)],
    totalDue: 2,
    dryRun: false,
    modules: MODULES,
    purge: port,
  });
  assert.equal(report.evidence.length, port.calls.length);
  const keys = new Set(report.evidence.map((row) => `${row.requestId}/${row.module}`));
  assert.equal(keys.size, report.evidence.length, '同一 (request, module) 不能出现两条证据');
  for (const row of report.evidence) assert.match(row.evidenceRef, /^sha256:[0-9a-f]{64}$/);
});

// ---------------------------------------------------------------- [7] 读数口径与隐私

test('[7] 读数口径：processed ≡ succeeded + skipped + failed（三轮读法一致）', async () => {
  const requests = [candidate(1), candidate(2), candidate(3, ONE_SECOND)];
  const port = fakePort(async (input) => {
    if (input.requestId === candidate(2).requestId && input.module === 'messages') {
      const error = new Error('boom');
      error.code = 'STORE_REJECTED';
      throw error;
    }
    return { removed: 1, idempotency: 0 };
  });

  const report = await runOnlinePurgeBatch({
    cutoff: CUTOFF,
    limit: 10,
    requests,
    totalDue: 3,
    dryRun: false,
    modules: MODULES,
    purge: port,
  });

  assert.equal(report.processed, 3);
  assert.equal(report.succeeded, 1);
  assert.equal(report.skipped, 1);
  assert.equal(report.failed, 1);
  assert.equal(report.processed, report.succeeded + report.skipped + report.failed);
});

test('[7b] 报告文本不含 user_id、正文或连接串', async () => {
  const requests = [candidate(1)];
  const report = await runOnlinePurgeBatch({
    cutoff: CUTOFF,
    limit: 10,
    requests,
    totalDue: 1,
    dryRun: false,
    modules: MODULES,
    purge: fakePort(),
  });
  const text = formatOnlinePurgeReport(report).join('\n');
  assert.ok(text.includes(requests[0].requestId), '故障排查要能定位到 request_id');
  assert.ok(!text.includes(requests[0].userId), '⛔ 报告不得出现 user_id');
  assert.ok(!text.includes('postgres://'));
});

// ---------------------------------------------------------------- [8] SQL 与候选列举

test('[8] 候选 SQL：按 online_due_at 闭区间取，只排除 completed（不排除 blocked），并带 keyset 游标', () => {
  assert.match(ONLINE_PURGE_DUE_SQL, /online_due_at\s*<=\s*\$1::timestamptz/);
  assert.match(ONLINE_PURGE_DUE_SQL, /state\s*<>\s*'completed'/);
  assert.ok(!/state\s*=\s*'blocked'/.test(ONLINE_PURGE_DUE_SQL), '不排除 blocked 行');
  assert.match(ONLINE_PURGE_DUE_SQL, /ORDER BY date_trunc\('milliseconds', online_due_at\), id/);
  assert.match(ONLINE_PURGE_DUE_SQL, /LIMIT \$2::integer/);
  // [P1] 监工 1021/1806：队首固定 LIMIT 会饿死后批 ⇒ 游标谓词必须进 SQL（`$3` 空 = 从队首）。
  assert.match(ONLINE_PURGE_DUE_SQL, /\$3::timestamptz IS NULL/);
  assert.match(
    ONLINE_PURGE_DUE_SQL,
    /\(date_trunc\('milliseconds', online_due_at\), id\) > \(\$3::timestamptz, \$4::uuid\)/,
  );
  assert.match(ONLINE_PURGE_DUE_COUNT_SQL, /count\(\*\)::integer/);
  assert.ok(!/LIMIT/.test(ONLINE_PURGE_DUE_COUNT_SQL), '总数不能被 limit 截断');
});

test('[8b] listDueOnlineDeletions：一条 cutoff 同时喂候选与总数，行映射为 requestId/userId/onlineDueAt', async () => {
  const seen = [];
  const client = {
    async query(text, values) {
      seen.push({ text, values });
      if (text === ONLINE_PURGE_DUE_COUNT_SQL) return { rows: [{ total: 7 }] };
      return {
        rows: [
          { id: 'r1', user_id: 'u1', online_due_at: '2026-10-20T00:00:00.000Z' },
          { id: 'r2', user_id: 'u2', online_due_at: '2026-10-19T00:00:00.000Z' },
        ],
      };
    },
  };

  const { requests, totalDue } = await listDueOnlineDeletions(client, { cutoff: CUTOFF, limit: 50 });

  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], {
    requestId: 'r1',
    userId: 'u1',
    onlineDueAt: '2026-10-20T00:00:00.000Z',
  });
  assert.equal(totalDue, 7);
  assert.equal(seen.length, 2);
  for (const call of seen) assert.equal(call.values[0], CUTOFF, '两条 SQL 必须用同一个 cutoff');
  assert.equal(seen[0].values[1] ?? seen[1].values[1], 50);
  // 没有游标时两个游标参数都必须是**绑定成 NULL**（不是省略参数：省略会让 `$3` 未定义而报错）。
  assert.equal(seen[0].values[2], null);
  assert.equal(seen[0].values[3], null);
});

test('[8f] listDueOnlineDeletions 把游标作为 $3/$4 绑定（毫秒 ISO + 小写 UUID），不改 cutoff/limit 位置', async () => {
  const seen = [];
  const client = {
    async query(text, values) {
      seen.push({ text, values });
      if (text === ONLINE_PURGE_DUE_COUNT_SQL) return { rows: [{ total: 3 }] };
      return { rows: [] };
    },
  };
  const after = {
    afterDueAt: '2026-10-20T00:00:00.500Z',
    afterRequestId: '00000000-0000-4000-8000-00000000000A',
  };
  await listDueOnlineDeletions(client, { cutoff: CUTOFF, limit: 25, after });

  assert.equal(seen[0].values[0], CUTOFF);
  assert.equal(seen[0].values[1], 25);
  assert.equal(seen[0].values[2], '2026-10-20T00:00:00.500Z');
  assert.equal(seen[0].values[3], '00000000-0000-4000-8000-00000000000a', 'UUID 归一成小写');
  // 非法游标不许静默退化成"从队首重来"。
  await assert.rejects(
    listDueOnlineDeletions(client, { cutoff: CUTOFF, limit: 25, after: { afterDueAt: 'now', afterRequestId: 'x' } }),
    /afterDueAt/,
  );
});

test('[8c] listDueOnlineDeletions 也拒绝裸本地时间 cutoff', async () => {
  await assert.rejects(
    listDueOnlineDeletions({ async query() { return { rows: [] }; } }, { cutoff: '2026-10-21 00:00:00', limit: 10 }),
    /带时区的 ISO-8601/,
  );
});

test('[8d] 候选为空时退出码 0（没有到期请求不是失败）', async () => {
  const report = await runOnlinePurgeBatch({
    cutoff: CUTOFF,
    limit: 10,
    requests: [],
    totalDue: 0,
    dryRun: false,
    modules: MODULES,
    purge: fakePort(),
  });
  assert.equal(report.candidates, 0);
  assert.equal(report.processed, 0);
  assert.equal(onlinePurgeExitCode(report), 0);
});

// 回归：node-postgres 对 `timestamptz` 返回的是 **Date**（不是 ISO 字符串）。曾经把行直接
// `String(...)` 化，得到 `Wed Apr 01 2026 …` 这种不带时区的本地写法，于是每一行都被判成
// 「到期时刻不可解析」⇒ 全 failed。真库臂抓到了，单测只用 ISO 字符串时抓不到，故补这条。
test('[8e] 候选行是 Date（pg 对 timestamptz 的返回形状）也能正确排出到期时刻', async () => {
  const client = {
    async query(text) {
      if (text === ONLINE_PURGE_DUE_COUNT_SQL) return { rows: [{ total: 1 }] };
      return { rows: [{ id: 'r1', user_id: 'u1', online_due_at: new Date('2026-10-20T00:00:00.000Z') }] };
    },
  };

  const { requests } = await listDueOnlineDeletions(client, { cutoff: CUTOFF, limit: 10 });
  assert.equal(requests.length, 1);
  const due = requests[0].onlineDueAt;
  const dueMs = due instanceof Date ? due.getTime() : Date.parse(String(due));
  assert.equal(
    dueMs,
    Date.parse('2026-10-20T00:00:00.000Z'),
    'Date 形状必须保留（不得被 String() 成不可解析的本地写法）',
  );

  const report = await runOnlinePurgeBatch({
    cutoff: CUTOFF,
    limit: 10,
    requests,
    totalDue: 1,
    dryRun: false,
    modules: MODULES,
    purge: fakePort(),
  });
  assert.equal(report.failed, 0, 'Date 形状的到期时刻不得被判成不可解析');
  assert.equal(report.succeeded, 1);
  assert.ok(report.rowsPurged > 0, 'Date 形状的候选必须真的走到清理并产出已删行数');
  assert.equal(report.evidence.length, MODULES.length, '每个成功模块一条证据');
});

// ------------------------------------------------- [9] 批次推进（[P1] 监工 1021/1806）

/**
 * 假"到期表"：按 `(online_due_at, id)` 排序，实现与 `ONLINE_PURGE_DUE_SQL` **同语义**的 keyset 分页。
 *
 * 关键点：这些行**永远不会从候选集里消失**（真实库里本驱动不写 `state`，清了也不变 `completed`），
 * 所以它就是饿死场景的忠实模型 —— 只有游标能让下一页取到后面的行。
 */
function fakeDueSource(requests) {
  const rows = [...requests].sort((a, b) => compareKeys(a, b));
  const fetches = [];
  return {
    fetches,
    async fetchPage({ cutoff, limit, after }) {
      fetches.push({ cutoff, limit, after });
      const cutoffMs = Date.parse(cutoff);
      const due = rows.filter((row) => Date.parse(row.onlineDueAt) <= cutoffMs);
      const afterKey =
        after === null ? null : { onlineDueAt: after.afterDueAt, requestId: after.afterRequestId };
      const rest = afterKey === null ? due : due.filter((row) => compareKeys(row, afterKey) > 0);
      return { requests: rest.slice(0, limit), totalDue: due.length };
    },
  };
}

function compareKeys(a, b) {
  const delta = Date.parse(a.onlineDueAt) - Date.parse(b.onlineDueAt);
  if (delta !== 0) return delta;
  const left = a.requestId;
  const right = b.requestId;
  return left === right ? 0 : left < right ? -1 : 1;
}

/** 第 `index` 个到期请求：**index 越大越晚到期**（排序与 index 同序，`index 0` 最早）。 */
function dueRequest(index) {
  return candidate(index, -(100 - index) * ONE_SECOND);
}

test('[9] 上限归一：默认 5、硬顶 200；非法/超顶一律抛 RangeError（不夹取、不默认）', () => {
  assert.equal(DEFAULT_ONLINE_PURGE_MAX_BATCHES, 5);
  assert.equal(MAX_ONLINE_PURGE_MAX_BATCHES, 200);
  for (const ok of [1, 2, 5, '3', ' 7 ']) {
    assert.equal(normalizeOnlinePurgeMaxBatches(ok), Number(String(ok).trim()));
  }
  for (const bad of [0, -1, 1.5, '', ' ', 'abc', '2e3', Number.NaN, Infinity, MAX_ONLINE_PURGE_MAX_BATCHES + 1]) {
    assert.throws(() => normalizeOnlinePurgeMaxBatches(bad), RangeError, `应拒绝 ${String(bad)}`);
  }
});

test('[9a] 游标归一：null 合法；时刻一律归一成毫秒 ISO、UUID 归一成小写；坏形状抛 TypeError', () => {
  assert.equal(normalizeOnlinePurgeCursor(null), null);
  assert.equal(normalizeOnlinePurgeCursor(undefined), null);
  assert.deepEqual(
    normalizeOnlinePurgeCursor({
      afterDueAt: '2026-10-20T00:00:00.123456Z',
      afterRequestId: '00000000-0000-4000-8000-00000000000A',
    }),
    { afterDueAt: '2026-10-20T00:00:00.123Z', afterRequestId: '00000000-0000-4000-8000-00000000000a' },
    '微秒被截到毫秒（与 SQL 里的 date_trunc 同值）',
  );
  assert.deepEqual(
    normalizeOnlinePurgeCursor({
      afterDueAt: new Date('2026-10-20T00:00:00.000Z'),
      afterRequestId: '00000000-0000-4000-8000-00000000000b',
    }),
    { afterDueAt: '2026-10-20T00:00:00.000Z', afterRequestId: '00000000-0000-4000-8000-00000000000b' },
  );
  for (const bad of [42, 'x', [], { afterRequestId: '00000000-0000-4000-8000-00000000000a' }]) {
    assert.throws(() => normalizeOnlinePurgeCursor(bad), TypeError);
  }
  assert.throws(
    () => normalizeOnlinePurgeCursor({ afterDueAt: '2026-10-20 00:00:00', afterRequestId: '00000000-0000-4000-8000-00000000000a' }),
    /带时区的 ISO-8601/,
    '裸本地时间不接受（与 cutoff 同口径）',
  );
  assert.throws(
    () => normalizeOnlinePurgeCursor({ afterDueAt: CUTOFF, afterRequestId: 'not-a-uuid' }),
    /UUID/,
  );
  // 候选 → 游标：就是该行的 (online_due_at, id)。
  assert.deepEqual(cursorAfterCandidate(dueRequest(3)), {
    afterDueAt: dueRequest(3).onlineDueAt,
    afterRequestId: dueRequest(3).requestId,
  });
});

test('[9b] 【饿死闭环】limit=2、5 个到期请求：连跑三轮全部处理完（旧口径只会永远撞队首 A/B）', async () => {
  const all = [dueRequest(0), dueRequest(1), dueRequest(2), dueRequest(3), dueRequest(4)];
  const source = fakeDueSource(all);
  const port = fakePort();
  const runOnce = async (after) =>
    drainDueOnlineDeletions({
      cutoff: CUTOFF,
      limit: 2,
      maxBatches: 1,
      dryRun: false,
      modules: MODULES,
      purge: port,
      after,
      fetchPage: source.fetchPage,
    });

  const round1 = await runOnce(null);
  assert.equal(round1.batches, 1);
  assert.equal(round1.processed, 2);
  assert.equal(round1.succeeded, 2);
  assert.equal(round1.drained, false, '一页用满且没到队尾 ⇒ 没走完一整轮');
  assert.deepEqual(round1.nextCursor, cursorAfterCandidate(all[1]), '游标停在处理到的最后一行（B）');

  const round2 = await runOnce(round1.nextCursor);
  assert.equal(round2.processed, 2);
  assert.deepEqual(round2.nextCursor, cursorAfterCandidate(all[3]), '从 B 之后继续 ⇒ 取到 C/D');

  const round3 = await runOnce(round2.nextCursor);
  assert.equal(round3.processed, 1, '只剩 E：本轮处理 1 条');
  assert.equal(round3.drained, true, '本页不足 limit ⇒ 已到队尾');
  assert.equal(round3.nextCursor, null, '走到队尾 ⇒ 清游标，下一轮从队首重扫');

  // 五条到期请求全部被真的清过（每个请求四域都问过库），没有一条被饿死。
  const touched = new Set(port.calls.map((call) => call.requestId));
  assert.deepEqual(
    [...touched].sort(),
    all.map((row) => row.requestId).sort(),
    '超过 limit 的到期集合连跑后必须全部处理',
  );
  assert.equal(port.calls.length, all.length * MODULES.length);

  // ---- 反证：没有游标时，"每轮都取队首 LIMIT 条"就是饿死本身。----
  const starved = fakePort();
  for (let i = 0; i < 3; i += 1) {
    const page = await source.fetchPage({ cutoff: CUTOFF, limit: 2, after: null });
    await runOnlinePurgeBatch({
      cutoff: CUTOFF,
      limit: 2,
      requests: page.requests,
      totalDue: page.totalDue,
      dryRun: false,
      modules: MODULES,
      purge: starved,
    });
  }
  const starvedIds = new Set(starved.calls.map((call) => call.requestId));
  assert.deepEqual(
    [...starvedIds].sort(),
    [all[0].requestId, all[1].requestId].sort(),
    '反证：不带游标连跑三轮仍只碰到 A/B（C/D/E 永远进不了候选）',
  );
});

test('[9c] 走到队尾后从队首重扫：第二轮全是 already_purged、rowsPurged=0，且不写任何 completed', async () => {
  const all = [dueRequest(0), dueRequest(1), dueRequest(2)];
  const source = fakeDueSource(all);
  // 第一轮 port 真删（2 行 + 1 台账）；其后四域都 0 行（模拟"在线数据已经没了"）。
  let purged = false;
  const port = fakePort(() => {
    if (!purged) return { removed: 2, idempotency: 1 };
    return { removed: 0, idempotency: 0 };
  });

  const round1 = await drainDueOnlineDeletions({
    cutoff: CUTOFF,
    limit: 2,
    maxBatches: 5,
    dryRun: false,
    modules: MODULES,
    purge: port,
    fetchPage: source.fetchPage,
  });
  // limit=2、3 条到期：第一页 A/B（满页），第二页 C（不足一页）⇒ 已到队尾。
  assert.equal(round1.batches, 2);
  assert.equal(round1.processed, 3);
  assert.equal(round1.succeeded, 3);
  assert.equal(round1.drained, true);
  assert.equal(round1.nextCursor, null);
  assert.ok(round1.rowsPurged > 0);
  purged = true;

  const round2 = await drainDueOnlineDeletions({
    cutoff: CUTOFF,
    limit: 2,
    maxBatches: 5,
    dryRun: false,
    modules: MODULES,
    purge: port,
    fetchPage: source.fetchPage,
    after: round1.nextCursor,
  });
  assert.equal(round2.processed, 3, '下一轮从队首重扫，还是那 3 条');
  assert.equal(round2.skipped, 3);
  assert.equal(round2.skipReasons[ONLINE_PURGE_SKIP_REASONS.ALREADY_PURGED], 3);
  assert.equal(round2.succeeded, 0);
  assert.equal(round2.rowsPurged, 0, '幂等：第二轮一行都不该"清掉"');
  assert.equal(round2.evidence.length, 0, '0 行不留证据（⛔ 不谎称本次干了活）');
  assert.equal(onlinePurgeExitCode(round2), 0);
  // 驱动只删在线行：报告里没有任何"completed/已完成"字样被当作结论输出。
  const text = formatOnlinePurgeReport(round2).join('\n');
  assert.ok(!/completed/.test(text), '不把"只清在线四域"说成整笔完成');
});

test('[9d] 失败行不阻塞推进：A 一直失败，游标照样越过它，本轮就能取到 C/D', async () => {
  const all = [dueRequest(0), dueRequest(1), dueRequest(2), dueRequest(3)];
  const source = fakeDueSource(all);
  const port = fakePort((input) => {
    if (input.requestId === all[0].requestId) {
      const error = new Error('boom');
      error.code = 'STORE_UNREACHABLE';
      throw error;
    }
    return { removed: 1, idempotency: 0 };
  });

  const round1 = await drainDueOnlineDeletions({
    cutoff: CUTOFF,
    limit: 2,
    maxBatches: 1,
    dryRun: false,
    modules: MODULES,
    purge: port,
    fetchPage: source.fetchPage,
  });
  assert.equal(round1.processed, 2);
  assert.equal(round1.failed, 1, 'A 失败只记 A 自己');
  assert.equal(round1.succeeded, 1);
  assert.equal(onlinePurgeExitCode(round1), 1, '有失败行 ⇒ 退出码 1（人会被叫来）');
  assert.deepEqual(round1.nextCursor, cursorAfterCandidate(all[1]), '失败行照样越过游标');

  const round2 = await drainDueOnlineDeletions({
    cutoff: CUTOFF,
    limit: 2,
    maxBatches: 1,
    dryRun: false,
    modules: MODULES,
    purge: port,
    fetchPage: source.fetchPage,
    after: round1.nextCursor,
  });
  assert.deepEqual(
    round2.pages[0].after,
    cursorAfterCandidate(all[1]),
    '第二轮从 B 之后开始，不再原地撞 A',
  );
  const round2Ids = new Set(port.calls.slice(round1.processed * MODULES.length).map((call) => call.requestId));
  assert.deepEqual(
    [...round2Ids].sort(),
    [all[2].requestId, all[3].requestId].sort(),
    '失败行不阻塞：下一轮取到 C/D',
  );
});

test('[9e] 用满 --max-batches 仍未到队尾：drained=false、游标停在本轮最后一行，下一轮接着推', async () => {
  const all = [0, 1, 2, 3, 4, 5].map(dueRequest);
  const source = fakeDueSource(all);
  const port = fakePort();
  const round1 = await drainDueOnlineDeletions({
    cutoff: CUTOFF,
    limit: 2,
    maxBatches: 2,
    dryRun: false,
    modules: MODULES,
    purge: port,
    fetchPage: source.fetchPage,
  });
  assert.equal(round1.batches, 2);
  assert.equal(round1.processed, 4);
  assert.equal(round1.drained, false);
  assert.deepEqual(round1.nextCursor, cursorAfterCandidate(all[3]));
  assert.deepEqual(
    round1.pages.map((page) => page.processed),
    [2, 2],
  );

  const round2 = await drainDueOnlineDeletions({
    cutoff: CUTOFF,
    limit: 2,
    maxBatches: 2,
    dryRun: false,
    modules: MODULES,
    purge: port,
    fetchPage: source.fetchPage,
    after: round1.nextCursor,
  });
  assert.equal(round2.processed, 2, '剩 E/F');
  assert.equal(round2.drained, true, '再翻一页就是空的 ⇒ 走到队尾');
  assert.equal(round2.nextCursor, null);
  const touched = new Set(port.calls.map((call) => call.requestId));
  assert.equal(touched.size, all.length, '六条全部处理过（两轮预算合起来够）');
});

test('[9f] 合并读数：跨页累计 processed/succeeded/skipped/failed/证据，remaining 如实递减', async () => {
  const all = [dueRequest(0), dueRequest(1), dueRequest(2)];
  const source = fakeDueSource(all);
  // A/B 真删、C 已经清过（0 行）⇒ 跨页出现两种结论。
  const port = fakePort((input) => {
    if (input.requestId === all[2].requestId) return { removed: 0, idempotency: 0 };
    return { removed: 3, idempotency: 1 };
  });
  const report = await drainDueOnlineDeletions({
    cutoff: CUTOFF,
    limit: 2,
    maxBatches: 5,
    dryRun: false,
    modules: MODULES,
    purge: port,
    fetchPage: source.fetchPage,
  });

  assert.equal(report.processed, report.succeeded + report.skipped + report.failed);
  assert.equal(report.processed, 3);
  assert.equal(report.succeeded, 2);
  assert.equal(report.skipped, 1);
  assert.equal(report.skipReasons[ONLINE_PURGE_SKIP_REASONS.ALREADY_PURGED], 1);
  assert.equal(report.rowsPurged, 24, 'A/B 各 4 域 × 3 行');
  assert.equal(report.idempotencyPurged, 8, 'A/B 各 4 域 × 1 台账行');
  assert.equal(report.evidence.length, 2 * MODULES.length, '证据按成功请求计，跳过请求不留证据');
  assert.equal(report.remaining, 0, 'totalDue(3) - processed(3)');
  assert.equal(report.totalDue, 3);

  const lines = formatOnlinePurgeReport(report);
  const text = lines.join('\n');
  assert.match(text, /批次 2/);
  assert.match(text, /已到队尾/);
  assert.ok(!text.includes('11111111-1111-4111-8111'), '报告不得出现 user_id');
  assert.ok(!/postgres(ql)?:\/\//.test(text), '报告不得出现连接串');
  // 普通（非 drain）报告不应多打批次行。
  const plain = await runOnlinePurgeBatch({
    cutoff: CUTOFF,
    limit: 2,
    requests: all,
    totalDue: 3,
    dryRun: false,
    modules: MODULES,
    purge: fakePort(),
  });
  assert.ok(!/批次/.test(formatOnlinePurgeReport(plain).join('\n')));
});

test('[9g] 无法推进就不推进：到期时刻不可解析时本轮停下（不原地打转、不跳着走）', async () => {
  const broken = { requestId: dueRequest(0).requestId, userId: 'u', onlineDueAt: 'not-a-time' };
  // 用假页直接喂一行坏行（真实的 SQL 会用 `online_due_at <= cutoff` 把它筛掉，这里要单测"驱动自己判"）。
  const report = await drainDueOnlineDeletions({
    cutoff: CUTOFF,
    limit: 1,
    maxBatches: 5,
    dryRun: false,
    modules: MODULES,
    purge: fakePort(),
    fetchPage: async () => ({ requests: [broken], totalDue: 1 }),
  });
  assert.equal(report.batches, 1, '只跑一页就停');
  assert.equal(report.failed, 1);
  assert.equal(report.drained, false, '没走到队尾');
  assert.equal(report.nextCursor, null, '做不出可信游标 ⇒ 不假装推进');
  assert.equal(report.pages[0].nextAfter, null);
});

test('[9h] 单轮内所有页共用同一个 cutoff（不逐页重新读钟）', async () => {
  const all = [0, 1, 2].map(dueRequest);
  const source = fakeDueSource(all);
  await drainDueOnlineDeletions({
    cutoff: CUTOFF,
    limit: 1,
    maxBatches: 5,
    dryRun: false,
    modules: MODULES,
    purge: fakePort(),
    fetchPage: source.fetchPage,
  });
  const cutoffs = new Set(source.fetches.map((fetch) => fetch.cutoff));
  assert.equal(cutoffs.size, 1, '一轮只有一个 cutoff');
  assert.equal([...cutoffs][0], CUTOFF);
  assert.equal(source.fetches.length, 4, '3 页 + 1 次空页探测（第 3 页不满 limit 时不多查）');
});

test('[9i] --dry-run 的 drain：逐页只列不删，游标语义与真跑一致（CLI 不落盘）', async () => {
  const all = [0, 1, 2].map(dueRequest);
  const source = fakeDueSource(all);
  const port = fakePort();
  const report = await drainDueOnlineDeletions({
    cutoff: CUTOFF,
    limit: 2,
    maxBatches: 5,
    dryRun: true,
    modules: MODULES,
    purge: port,
    fetchPage: source.fetchPage,
  });
  assert.equal(port.calls.length, 0, 'dry-run 一次都不碰库');
  assert.equal(report.processed, 3);
  assert.equal(report.skipped, 3);
  assert.equal(report.skipReasons[ONLINE_PURGE_SKIP_REASONS.DRY_RUN], 3);
  assert.equal(report.rowsPurged, 0);
  assert.equal(report.drained, true);
});
