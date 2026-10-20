/**
 * GY-I23 · 取证报告**形态闸门**单测（纯机械、零网络、零仓库写入）。
 *
 * ## 这个测试在守什么
 * 规格书 `.pg17/handoff/i23-capacity-scope-20261020.md` §4.4 的 14 项字段＋§5 的十条诚实性红线，
 * 在仓内原本**没有任何机器门禁**（`p95` 在代码/测试侧命中 0）。本文件把其中最容易被"顺手放宽"的
 * 几条做成**结构断言**，并带**反向控制**（规则被删掉时测试必须变红，而不是恒绿）：
 *
 * - 反向控制 1：删一个必填字段（`substitute`）⇒ 必红；
 * - 反向控制 2：把 `n < 30` 的报告当 pass ⇒ 必红（且 `verdict` 必须是 `insufficient`）；
 * - 反向控制 3：`data_scale.measured=true` 却不给行数 ⇒ 必红；
 * - 反向控制 4：分位数不单调（p95 > max）⇒ 必红；
 * - 反向控制 5：`error_rate.value` 与 `errors/requests` 对不上 ⇒ 必红；
 * - 反向控制 6：`claims.assertable` 里写"达标"这类阈值结论 ⇒ 必红（只能写进 `not_assertable`）。
 *
 * ⛔ 本测试**不跑压测**、不连任何端口：`tools/perf` 的读数由证据页登记的命令单独取证。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  MIN_SAMPLES_PER_GROUP,
  PERCENTILE_METHOD,
  buildPerfReport,
  collectEnvFingerprint,
  measureDataScale,
  percentile,
  summarizeDurations,
  validatePerfReport,
} from '../../tools/perf/lib/report.mjs';

const EVIDENCE_PAGE = 'docs/verification/gy-i23-latency-capacity-local-20261020.md';
const BASELINE_SHA = 'df043a715e691019e14373181249a5cf51ec9da9';

function validGroup(overrides = {}) {
  return {
    name: 'knowledge_list/hot',
    endpoint: 'GET /api/v1/knowledge?limit=20',
    method: 'GET',
    mode: 'serial',
    connection: 'hot',
    requests: 60,
    n: 60,
    dropped: 0,
    drop_reasons: {},
    percentiles: { min_ms: 1.2, p50_ms: 3.4, p90_ms: 6.1, p95_ms: 7.8, max_ms: 12.5, mean_ms: 4.1 },
    error_rate: { value: 0, errors: 0, requests: 60 },
    bytes: { mean: 1024 },
    ...overrides,
  };
}

function baseParts(overrides = {}) {
  return {
    kind: 'latency-sample',
    generated_at: '2026-10-20T11:00:00.000+08:00',
    baseline_sha: BASELINE_SHA,
    code_sha: BASELINE_SHA,
    code_state: { branch: 'test/gy-i23-perf-evidence', worktree: 'E:/fixture', dirty_files: 0 },
    commands: ['node tools/perf/latency-sample.mjs --base http://127.0.0.1:3310 --n 60 --cold --hot'],
    env_fingerprint: collectEnvFingerprint({
      node: 'v24.16.0',
      platform: 'win32',
      osRelease: '10.0.26100',
      cpuModel: 'fixture-cpu',
      cpuCount: 16,
      totalMemoryBytes: 34359738368,
      apiBase: 'http://127.0.0.1:3310',
      apiPort: 3310,
      pgPort: 55536,
      pgVersion: 'PostgreSQL 17.11',
      executionMode: 'stub',
    }),
    data_scale: {
      measured: true,
      reason: null,
      rows: { knowledge_versions: 0, sources: 0, crops: 4, regions: 102 },
      visible_knowledge_rows: 159,
      failures: [],
      collected_at: '2026-10-20T11:00:00.000+08:00',
    },
    substitute: { execution_mode: 'stub', real_provider_calls: 0, notes: 'stub 隔离替身，零外呼' },
    within_same_host: true,
    warmup_discarded: 5,
    claims: {
      assertable: ['本机回环、stub 替身、合成数据规模条件下的服务端处理耗时分布'],
      not_assertable: ['不构成需求 §6.2 第 5 行的达标判定（无真机、无公网链路）'],
    },
    groups: [validGroup(), validGroup({ name: 'knowledge_list/cold', connection: 'cold' })],
    skipped_endpoints: [],
    notes: [],
    ...overrides,
  };
}

function validLatencyReport(overrides = {}) {
  return buildPerfReport(baseParts(overrides));
}

function validLoadReport(overrides = {}) {
  const report = buildPerfReport({
    ...baseParts({
      kind: 'load-50vu',
      commands: ['node tools/perf/load-50vu.mjs --base http://127.0.0.1:3310 --vu 50 --duration 600'],
      groups: [
        validGroup({ name: 'knowledge_list', endpoint: 'GET /api/v1/knowledge?limit=20', mode: 'concurrent', connection: 'hot', requests: 1000, n: 1000, percentiles: { min_ms: 1, p50_ms: 4, p90_ms: 8, p95_ms: 11, max_ms: 20, mean_ms: 5 }, error_rate: { value: 0, errors: 0, requests: 1000 } }),
        validGroup({ name: 'profile_put', endpoint: 'PUT /api/v1/me/profile', method: 'PUT', mode: 'concurrent', connection: 'hot', requests: 120, n: 120, percentiles: { min_ms: 2, p50_ms: 6, p90_ms: 12, p95_ms: 15, max_ms: 30, mean_ms: 7 }, error_rate: { value: 0, errors: 0, requests: 120 } }),
      ],
    }),
    load: {
      vu: 50,
      duration_s: 600.4,
      mix: { requested: { knowledge_list: 0.5, profile_put: 0.5 }, actual: { knowledge_list: 1000, profile_put: 120 }, substituted: 0 },
      assertions: [
        { name: 'anonymous_read_denied', ok: true, detail: 'GET /api/v1/knowledge 无 Authorization ⇒ 401' },
        { name: 'idempotent_replay_no_second_row', ok: true, detail: 'single_profiles rows=50 distinct_users=50' },
      ],
      resources: { snapshots: [], cpu_pct_mean: 42.5, cpu_pct_max: 71.2, rss_mb_peak: 210.4 },
    },
  });
  return { ...report, ...overrides };
}

test('percentile 用 (n-1)p 线性插值，且不修改入参数组', () => {
  const values = [10, 1, 5, 3, 8];
  const frozen = [...values];
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(percentile([1, 2, 3, 4, 5], 1), 5);
  assert.equal(percentile([], 0.5), null);
  percentile(values, 0.95);
  assert.deepEqual(values, frozen, 'percentile 必须复制后排序，不得原地改写入参');
  assert.throws(() => percentile([1, 2, 3], 0), RangeError);
  assert.throws(() => percentile([1, 2, 3], 1.5), RangeError);
});

test('summarizeDurations 的分位数单调且与分位法一致', () => {
  const samples = Array.from({ length: 100 }, (_, index) => index + 1);
  const summary = summarizeDurations(samples);
  assert.equal(summary.min_ms, 1);
  assert.equal(summary.max_ms, 100);
  assert.equal(summary.p50_ms, percentile(samples, 0.5));
  assert.equal(summary.p95_ms, percentile(samples, 0.95));
  assert.ok(summary.p50_ms <= summary.p90_ms && summary.p90_ms <= summary.p95_ms && summary.p95_ms <= summary.max_ms);
  assert.deepEqual(
    summarizeDurations([]),
    { min_ms: null, p50_ms: null, p90_ms: null, p95_ms: null, max_ms: null, mean_ms: null },
  );
});

test('完整报告通过形态闸门，verdict=measured', () => {
  const report = validLatencyReport();
  const result = validatePerfReport(report);
  assert.deepEqual(result.errors, [], '合法报告不应有任何形态错误');
  assert.equal(result.ok, true);
  assert.equal(result.verdict, 'measured');
  assert.equal(report.percentile_method, PERCENTILE_METHOD);
  assert.equal(result.groups_below_minimum.length, 0);
});

test('反向控制 1：删掉必填字段 substitute ⇒ 必红', () => {
  const report = validLatencyReport();
  delete report.substitute;
  const result = validatePerfReport(report);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((entry) => entry.includes('substitute')), '错误信息必须点名缺失字段：' + result.errors.join(' | '));
});

test('反向控制 2：n<30 的报告不得被判 pass ⇒ 必红且 verdict=insufficient', () => {
  for (const n of [0, 1, 29]) {
    const report = validLatencyReport({
      groups: [validGroup({ n, requests: n, dropped: 60 - n, drop_reasons: { client_timeout: 60 - n }, error_rate: { value: (60 - n) / 60, errors: 60 - n, requests: 60 } })],
    });
    const result = validatePerfReport(report);
    assert.equal(result.ok, false, 'n=' + n + ' 时必须红');
    assert.equal(result.verdict, 'insufficient');
    assert.ok(
      result.errors.some((entry) => entry.includes(String(MIN_SAMPLES_PER_GROUP)) && entry.includes('每项≥30次')),
      '错误信息必须引用最低样本数与需求原文：' + result.errors.join(' | '),
    );
  }
});

test('反向控制 3：data_scale 声明 measured 却不给行数 ⇒ 必红', () => {
  const report = validLatencyReport();
  report.data_scale = { measured: true, rows: {}, visible_knowledge_rows: 159, failures: [] };
  const result = validatePerfReport(report);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((entry) => entry.includes('data_scale.rows')));

  const unmeasured = validLatencyReport();
  unmeasured.data_scale = { measured: false, rows: {}, visible_knowledge_rows: null, failures: [] };
  const unmeasuredResult = validatePerfReport(unmeasured);
  assert.equal(unmeasuredResult.ok, false, 'measured=false 但没写 reason 也必须红');
  assert.ok(unmeasuredResult.errors.some((entry) => entry.includes('data_scale.measured=false')));
});

test('反向控制 4：分位数不单调（p95>max）⇒ 必红', () => {
  const report = validLatencyReport({
    groups: [validGroup({ percentiles: { min_ms: 1, p50_ms: 4, p90_ms: 9, p95_ms: 30, max_ms: 20, mean_ms: 6 } })],
  });
  const result = validatePerfReport(report);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((entry) => entry.includes('不单调')), result.errors.join(' | '));
});

test('反向控制 5：error_rate.value 与 errors/requests 不一致 ⇒ 必红', () => {
  const report = validLatencyReport({
    groups: [validGroup({ error_rate: { value: 0.001, errors: 3, requests: 60 } })],
  });
  const result = validatePerfReport(report);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((entry) => entry.includes('error_rate.value')), result.errors.join(' | '));
});

test('反向控制 6：claims.assertable 写"达标" ⇒ 必红（阈值结论只能进 not_assertable）', () => {
  const report = validLatencyReport({
    claims: {
      assertable: ['本机 /knowledge 查询 p95=7.8ms，满足需求 ≤3 秒要求', '查询性能达标'],
      not_assertable: ['不构成需求 §6.2 第 5 行的达标判定'],
    },
  });
  const result = validatePerfReport(report);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((entry) => entry.includes('claims.assertable')), result.errors.join(' | '));
});

test('SHA／时间戳／命令原文缺失或不合规 ⇒ 必红（判定必须绑定被测代码）', () => {
  const shortSha = validLatencyReport();
  shortSha.code_sha = 'df043a7';
  assert.equal(validatePerfReport(shortSha).ok, false);
  assert.ok(validatePerfReport(shortSha).errors.some((entry) => entry.includes('code_sha')));

  const noOffset = validLatencyReport();
  noOffset.generated_at = '2026-10-20 11:00:00';
  assert.equal(validatePerfReport(noOffset).ok, false);

  const noCommand = validLatencyReport();
  noCommand.commands = [];
  assert.equal(validatePerfReport(noCommand).ok, false);
  assert.ok(validatePerfReport(noCommand).errors.some((entry) => entry.includes('commands')));
});

test('load-50vu 报告：缺断言段／断言不足 2 条 ⇒ 必红', () => {
  const complete = validLoadReport();
  assert.deepEqual(validatePerfReport(complete).errors, []);
  assert.equal(validatePerfReport(complete).verdict, 'measured');

  const noLoad = validLoadReport();
  delete noLoad.load;
  assert.equal(validatePerfReport(noLoad).ok, false);

  const singleAssertion = validLoadReport();
  singleAssertion.load.assertions = [{ name: 'anonymous_read_denied', ok: true, detail: '401' }];
  const result = validatePerfReport(singleAssertion);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((entry) => entry.includes('load.assertions')), result.errors.join(' | '));
});

test('measureDataScale 用桩客户端取数（零网络）：行数为整数，失败逐条登记', async () => {
  const healthy = {
    query: async (sql) => ({ rows: [{ n: sql.includes('public.crops') ? '4' : '0' }] }),
  };
  const scale = await measureDataScale({ client: healthy, visibleKnowledgeRows: 159, collectedAt: '2026-10-20T11:00:00.000+08:00' });
  assert.equal(scale.measured, true);
  assert.equal(scale.rows.crops, 4);
  assert.equal(scale.rows.sources, 0);
  assert.equal(scale.visible_knowledge_rows, 159);
  assert.deepEqual(scale.failures, []);

  const broken = {
    query: async (sql) => {
      if (sql.includes('public.posts')) throw new Error('relation "public.posts" does not exist');
      return { rows: [{ n: '0' }] };
    },
  };
  const brokenScale = await measureDataScale({ client: broken });
  assert.equal(brokenScale.measured, false);
  assert.ok(brokenScale.failures.some((entry) => entry.table === 'posts'), '取数失败必须点名到表');
  assert.ok(String(brokenScale.reason).includes('失败'));

  const unavailable = await measureDataScale({ client: null });
  assert.equal(unavailable.measured, false);
  assert.ok(String(unavailable.reason).includes('未取得'));
});

test('取证脚本与证据页在位，且未把性能数字接成 npm 脚本', () => {
  for (const path of [
    'tools/perf/lib/report.mjs',
    'tools/perf/lib/http.mjs',
    'tools/perf/latency-sample.mjs',
    'tools/perf/load-50vu.mjs',
    EVIDENCE_PAGE,
  ]) {
    assert.ok(existsSync(join(process.cwd(), path)), '缺少交付物：' + path);
  }
  const page = readFileSync(join(process.cwd(), EVIDENCE_PAGE), 'utf8');
  assert.ok(page.includes('node tools/perf/latency-sample.mjs'), '证据页必须登记可直接粘贴复跑的命令原文');
  assert.ok(page.includes('node tools/perf/load-50vu.mjs'), '证据页必须登记容量脚本命令原文');
  assert.ok(page.includes('不关闭'), '证据页必须明写「不关闭 #23」');
  assert.ok(page.includes('未取得'), '证据页必须单列未取得项');
  assert.ok(page.includes('stub') && page.includes('同机'), '证据页必须声明 stub 替身与同机条件');
  assert.ok(!existsSync(join(process.cwd(), 'tests/integration/latency-sample.mjs')), '⛔ 取证脚本不得放进 tests/integration/');

  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
  const perfScripts = Object.keys(pkg.scripts ?? {}).filter((key) => /perf|bench|load|capacity/i.test(key));
  assert.deepEqual(perfScripts, [], '⛔ 不得把性能取证接成 npm 脚本（package.json 正被在飞 PR 占用，且性能数字不得成为 CI 通过条件）');
});
