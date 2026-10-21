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
//   [8] 参数与 SQL 口径（`--limit` 非法即抛、候选 SQL 按 `online_due_at <= cutoff` 且不排除 `blocked`）。
//
// 真库臂在 `tests/integration/online-purge-pg.mjs`（未取得 PG 二进制 ⇒ 77 跳过）。

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_ONLINE_PURGE_BATCH_LIMIT,
  MAX_ONLINE_PURGE_BATCH_LIMIT,
  ONLINE_PURGE_DRIVER_ERROR_CODES,
  ONLINE_PURGE_DUE_COUNT_SQL,
  ONLINE_PURGE_DUE_SQL,
  ONLINE_PURGE_EVIDENCE_VERSION,
  ONLINE_PURGE_SKIP_REASONS,
  formatOnlinePurgeReport,
  listDueOnlineDeletions,
  normalizeOnlinePurgeLimit,
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

test('[8] 候选 SQL：按 online_due_at 闭区间取，只排除 completed（不排除 blocked）', () => {
  assert.match(ONLINE_PURGE_DUE_SQL, /online_due_at\s*<=\s*\$1::timestamptz/);
  assert.match(ONLINE_PURGE_DUE_SQL, /state\s*<>\s*'completed'/);
  assert.ok(!/state\s*=\s*'blocked'/.test(ONLINE_PURGE_DUE_SQL), '不排除 blocked 行');
  assert.match(ONLINE_PURGE_DUE_SQL, /ORDER BY online_due_at, id/);
  assert.match(ONLINE_PURGE_DUE_SQL, /LIMIT \$2::integer/);
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
