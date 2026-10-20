/**
 * GY-I23 · 本机时延／容量取证：**报告 schema + 分位数 + 形态闸门**。
 *
 * ## 这个文件为什么存在（口径，不是工具偏好）
 * 规格书 `.pg17/handoff/i23-capacity-scope-20261020.md` §4.4 列出 14 个字段，"缺一即不可核"；
 * §5 列出十条**诚实性红线**（不得把替身/合成读数当真实能力、不得挑最快样本、不得用单样本
 * 当分位数、不得把 p95 当置信区间、不得引 1000 并发……）。
 *
 * 于是本文件把这两组要求做成**机器可检的结构**：
 * - `validatePerfReport(report)` 缺任一必填字段 ⇒ 红；任一分组有效样本 `n < 30` ⇒ 红
 *   （需求原文「每项≥30次」）；
 * - `reportVerdict(report)` 只有**全部分组**都达最低样本数才返回 `measured`，否则
 *   `insufficient` ⇒ 报告**不可能**在样本不足时被判成 pass；
 * - `claims.assertable` 里出现"达标／符合需求／生产容量"一类**阈值结论词** ⇒ 红
 *   （这些词只能出现在 `not_assertable`）。
 *
 * ## 分位法
 * `percentile()` 用线性插值（等价 numpy 默认 / R type 7）：`h = (n-1)*p`，
 * 取 `x[floor(h)] + (h-floor(h)) * (x[ceil(h)] - x[floor(h)])`。
 * 该方法在证据页与报告 `percentile_method` 字段**逐字登记**，⛔ 不写成"95% 置信区间"。
 *
 * 本文件是纯函数集合：**零网络、零文件写入、模块加载零副作用**（单测可直接 import）。
 */

/** 报告 schema 版本：字段口径变化必须递增，旧报告随之失效。 */
export const PERF_REPORT_SCHEMA_VERSION = 1;

/** 每组最低有效样本数（需求原文「每项≥30次」）。低于此值只能记「未取得」。 */
export const MIN_SAMPLES_PER_GROUP = 30;

/** 分位法标识（写进报告，供复核者判断可比性）。 */
export const PERCENTILE_METHOD = 'linear-interpolation-(n-1)p';

/** 允许的采样模式与连接类别。 */
export const GROUP_MODES = Object.freeze(['serial', 'concurrent']);
export const CONNECTION_CLASSES = Object.freeze(['cold', 'hot']);

/** 允许的报告种类。 */
export const REPORT_KINDS = Object.freeze(['latency-sample', 'load-50vu']);

/** `env_fingerprint` 必填键（缺一项即"不可核"，规格书 §4.4 第 4 项）。 */
export const REQUIRED_ENV_STRING_KEYS = Object.freeze([
  'node',
  'platform',
  'os_release',
  'cpu_model',
  'api_base',
  'execution_mode',
  'pg_version',
]);
export const REQUIRED_ENV_INTEGER_KEYS = Object.freeze([
  'cpu_count',
  'total_memory_bytes',
  'api_port',
  'pg_port',
]);

/**
 * ⛔ 只允许出现在 `claims.not_assertable` 的阈值/能力结论词。
 * 出现于 `assertable` ⇒ 就是在把本机合成读数当条款达标。
 */
export const FORBIDDEN_ASSERTABLE_PATTERNS = Object.freeze([
  /达标/,
  /满足需求/,
  /符合需求/,
  /生产容量/,
  /外部\s*AI\s*容量/,
  /容量已证/,
  /验收通过/,
]);

/** 数据规模统计的固定表清单（`dataScale` 必须可复核，不能只写"小数据"）。 */
export const DATA_SCALE_TABLES = Object.freeze([
  'knowledge_versions',
  'sources',
  'species',
  'crops',
  'regions',
  'single_profiles',
  'users',
  'sessions',
  'posts',
  'community_posts',
]);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isFullSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

function isIsoWithOffset(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function roundTo(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * 线性插值分位数（`h = (n-1)*p`）。空数组返回 `null`；`p` 取 (0,1]。
 * ⛔ 入参数组**不会被原地排序**（内部先复制）。
 */
export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return null;
  if (!isFiniteNumber(p) || p <= 0 || p > 1) throw new RangeError('percentile: p 必须落在 (0,1]');
  const sorted = [...values].sort((a, b) => a - b);
  const h = (sorted.length - 1) * p;
  const lower = Math.floor(h);
  const upper = Math.min(lower + 1, sorted.length - 1);
  return sorted[lower] + (h - lower) * (sorted[upper] - sorted[lower]);
}

/** 一组耗时样本 → 报告里的 `percentiles` 段（保留 3 位小数，单位毫秒）。 */
export function summarizeDurations(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    return { min_ms: null, p50_ms: null, p90_ms: null, p95_ms: null, max_ms: null, mean_ms: null };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    min_ms: roundTo(sorted[0], 3),
    p50_ms: roundTo(percentile(sorted, 0.5), 3),
    p90_ms: roundTo(percentile(sorted, 0.9), 3),
    p95_ms: roundTo(percentile(sorted, 0.95), 3),
    max_ms: roundTo(sorted[sorted.length - 1], 3),
    mean_ms: roundTo(total / sorted.length, 3),
  };
}

/**
 * `envFingerprint`：缺一项即不可核。
 * 显式传值而非在函数里到处 `os.*`，是为了单测能用固定夹具、也让证据页读数可复算。
 */
export function collectEnvFingerprint({
  node = process.version,
  platform = process.platform,
  osRelease,
  cpuModel,
  cpuCount,
  totalMemoryBytes,
  apiBase,
  apiPort,
  pgPort,
  pgVersion,
  executionMode,
}) {
  return {
    node,
    platform,
    os_release: osRelease ?? null,
    cpu_model: cpuModel ?? null,
    cpu_count: Number.isInteger(cpuCount) ? cpuCount : null,
    total_memory_bytes: Number.isInteger(totalMemoryBytes) ? totalMemoryBytes : null,
    api_base: apiBase ?? null,
    api_port: Number.isInteger(apiPort) ? apiPort : null,
    pg_port: Number.isInteger(pgPort) ? pgPort : null,
    pg_version: pgVersion ?? null,
    execution_mode: executionMode ?? null,
  };
}

/**
 * `dataScale`：把「库内行数 + 可见知识条数」原样记下来。
 *
 * `client` 只需暴露 `query(sql)`（`pg.Client` 兼容），因此单测可传桩对象、**零网络**。
 * 任一张表查不到 ⇒ `measured: false` 并把失败逐条登记（⛔ 不写"约"/"左右"蒙混）。
 */
export async function measureDataScale({ client, visibleKnowledgeRows = null, collectedAt = null }) {
  if (client === null || client === undefined) {
    return {
      measured: false,
      reason: '未提供数据库读数通道（--local-dev 产物不存在）：库内行数未取得',
      rows: {},
      visible_knowledge_rows: Number.isInteger(visibleKnowledgeRows) ? visibleKnowledgeRows : null,
      failures: [],
      collected_at: collectedAt,
    };
  }
  const rows = {};
  const failures = [];
  for (const table of DATA_SCALE_TABLES) {
    try {
      const result = await client.query('SELECT count(*)::bigint AS n FROM public.' + table);
      const value = Number(result?.rows?.[0]?.n);
      if (Number.isInteger(value)) rows[table] = value;
      else failures.push({ table, error: 'count() 未返回整数：' + JSON.stringify(result?.rows?.[0] ?? null) });
    } catch (error) {
      failures.push({ table, error: String(error?.message ?? error) });
    }
  }
  return {
    measured: failures.length === 0,
    reason: failures.length === 0 ? null : '有 ' + failures.length + ' 张表取数失败：见 failures',
    rows,
    visible_knowledge_rows: Number.isInteger(visibleKnowledgeRows) ? visibleKnowledgeRows : null,
    failures,
    collected_at: collectedAt,
  };
}

/** 报告装配：固定字段顺序，避免两个脚本各写一套漂移。 */
export function buildPerfReport(parts) {
  const report = {
    schema_version: PERF_REPORT_SCHEMA_VERSION,
    kind: parts.kind,
    generated_at: parts.generated_at ?? new Date().toISOString(),
    percentile_method: PERCENTILE_METHOD,
    baseline_sha: parts.baseline_sha ?? null,
    code_sha: parts.code_sha ?? null,
    code_state: parts.code_state ?? null,
    commands: parts.commands ?? [],
    env_fingerprint: parts.env_fingerprint ?? {},
    data_scale: parts.data_scale ?? { measured: false, reason: '未采集' },
    substitute: parts.substitute ?? { execution_mode: 'unknown', real_provider_calls: 0, notes: '未声明' },
    within_same_host: parts.within_same_host ?? true,
    warmup_discarded: parts.warmup_discarded ?? 0,
    claims: parts.claims ?? { assertable: [], not_assertable: [] },
    groups: parts.groups ?? [],
    skipped_endpoints: parts.skipped_endpoints ?? [],
    notes: parts.notes ?? [],
  };
  if (parts.load !== undefined) report.load = parts.load;
  if (parts.sampling !== undefined) report.sampling = parts.sampling;
  return report;
}

function validateEnvFingerprint(fingerprint, fail) {
  if (!isPlainObject(fingerprint)) {
    fail('env_fingerprint 缺失：Node/PG/OS/CPU/内存/端口 是"可核"的最小集合');
    return;
  }
  for (const key of REQUIRED_ENV_STRING_KEYS) {
    if (!isNonEmptyString(fingerprint[key])) fail(`env_fingerprint.${key} 缺失或为空`);
  }
  for (const key of REQUIRED_ENV_INTEGER_KEYS) {
    const value = fingerprint[key];
    if (!Number.isInteger(value) || value < 0) fail(`env_fingerprint.${key} 必须是 ≥0 的整数（实测值 ${JSON.stringify(value)}）`);
  }
}

function validateDataScale(dataScale, fail) {
  if (!isPlainObject(dataScale)) {
    fail('data_scale 缺失：数据规模是需求 §6.2 表头「待明确的测试条件」之一，必须声明');
    return;
  }
  if (typeof dataScale.measured !== 'boolean') {
    fail('data_scale.measured 必须是布尔');
  } else if (dataScale.measured === true) {
    if (!isPlainObject(dataScale.rows) || Object.keys(dataScale.rows).length === 0) {
      fail('data_scale.measured=true 时必须给出 data_scale.rows（逐表 count(*)）');
    } else {
      for (const [table, count] of Object.entries(dataScale.rows)) {
        if (!Number.isInteger(count) || count < 0) fail(`data_scale.rows.${table} 必须是 ≥0 的整数（实测值 ${JSON.stringify(count)}）`);
      }
    }
    if (!Number.isInteger(dataScale.visible_knowledge_rows) || dataScale.visible_knowledge_rows < 0) {
      fail('data_scale.measured=true 时必须给出 visible_knowledge_rows（读取面可见知识条数，含 seed 合并）');
    }
  } else if (!isNonEmptyString(dataScale.reason)) {
    fail('data_scale.measured=false 时必须写明 reason（未取得数据规模的逐条原因）');
  }
}

function validateSubstitute(substitute, fail) {
  if (!isPlainObject(substitute)) {
    fail('substitute 缺失：必须声明 AI 是 stub 隔离替身还是真实供应商（规格书 §5 第 4 条）');
    return;
  }
  if (!isNonEmptyString(substitute.execution_mode)) fail('substitute.execution_mode 必须是非空字符串（如 stub）');
  if (!Number.isInteger(substitute.real_provider_calls) || substitute.real_provider_calls < 0) {
    fail('substitute.real_provider_calls 必须是 ≥0 的整数（真实供应商调用次数，替身场景应为 0）');
  }
}

function validateClaims(claims, fail) {
  if (!isPlainObject(claims)) {
    fail('claims 缺失：必须逐条写明"能主张什么／不能主张什么"（规格书 §5）');
    return;
  }
  for (const key of ['assertable', 'not_assertable']) {
    if (!Array.isArray(claims[key]) || claims[key].length === 0) {
      fail(`claims.${key} 必须是非空数组`);
      continue;
    }
    for (const [index, entry] of claims[key].entries()) {
      if (!isNonEmptyString(entry)) fail(`claims.${key}[${index}] 必须是非空字符串`);
    }
  }
  if (Array.isArray(claims.assertable)) {
    for (const [index, entry] of claims.assertable.entries()) {
      if (!isNonEmptyString(entry)) continue;
      for (const pattern of FORBIDDEN_ASSERTABLE_PATTERNS) {
        if (pattern.test(entry)) {
          fail(`claims.assertable[${index}] 含阈值/能力结论词 ${pattern}：这类结论只能写进 claims.not_assertable`);
        }
      }
    }
  }
}

function validateGroups(groups, fail) {
  if (!Array.isArray(groups) || groups.length === 0) {
    fail('groups 不能为空：至少要有 1 个已测端点分组');
    return;
  }
  for (const [index, group] of groups.entries()) {
    const label = `groups[${index}]` + (isPlainObject(group) && isNonEmptyString(group.name) ? '(' + group.name + ')' : '');
    if (!isPlainObject(group)) {
      fail(label + ' 必须是对象');
      continue;
    }
    if (!isNonEmptyString(group.name)) fail(label + '.name 必须是非空字符串');
    if (!isNonEmptyString(group.endpoint)) fail(label + '.endpoint 必须是非空字符串（例如 GET /api/v1/knowledge）');
    if (!isNonEmptyString(group.method) || !/^[A-Z]+$/.test(group.method)) fail(label + '.method 必须是全大写 HTTP 方法');
    if (!GROUP_MODES.includes(group.mode)) fail(label + '.mode 必须是 serial 或 concurrent');
    if (!CONNECTION_CLASSES.includes(group.connection) && group.connection !== 'n/a') {
      fail(label + '.connection 必须是 cold / hot / n/a（冷热必须分组，不得合并）');
    }
    if (!Number.isInteger(group.n)) {
      fail(label + '.n 必须是整数（有效样本数）');
    } else if (group.n < MIN_SAMPLES_PER_GROUP) {
      fail(
        label + '.n=' + group.n + ' 低于最低有效样本数 ' + MIN_SAMPLES_PER_GROUP +
          '（需求原文「每项≥30次」）⇒ 该组只能记「未取得」，不得判 pass',
      );
    }
    if (!Number.isInteger(group.dropped) || group.dropped < 0) fail(label + '.dropped 必须是 ≥0 的整数');
    if (!isPlainObject(group.drop_reasons)) {
      fail(label + '.drop_reasons 必须是对象：丢弃即「未取得」，必须逐条给原因');
    } else {
      for (const [reason, count] of Object.entries(group.drop_reasons)) {
        if (!Number.isInteger(count) || count < 0) fail(`${label}.drop_reasons.${reason} 必须是 ≥0 的整数`);
      }
    }
    if (!Number.isInteger(group.requests)) {
      fail(label + '.requests 必须是整数（含丢弃的总请求数）');
    } else if (Number.isInteger(group.n) && Number.isInteger(group.dropped) && group.requests !== group.n + group.dropped) {
      fail(`${label}.requests 必须等于 n + dropped（${group.n} + ${group.dropped} ≠ ${group.requests}）`);
    }
    const percentiles = group.percentiles;
    if (!isPlainObject(percentiles)) {
      fail(label + '.percentiles 缺失（必须含 min_ms/p50_ms/p90_ms/p95_ms/max_ms）');
    } else {
      const keys = ['min_ms', 'p50_ms', 'p90_ms', 'p95_ms', 'max_ms'];
      for (const key of keys) {
        if (!isFiniteNumber(percentiles[key]) || percentiles[key] < 0) {
          fail(`${label}.percentiles.${key} 必须是 ≥0 的有限数（实测值 ${JSON.stringify(percentiles[key])}）`);
        }
      }
      if (keys.every((key) => isFiniteNumber(percentiles[key]))) {
        const ordered = keys.map((key) => percentiles[key]);
        for (let position = 1; position < ordered.length; position += 1) {
          if (ordered[position] < ordered[position - 1]) {
            fail(`${label}.percentiles 不单调：必须 min_ms ≤ p50_ms ≤ p90_ms ≤ p95_ms ≤ max_ms`);
            break;
          }
        }
      }
    }
    const errorRate = group.error_rate;
    if (!isPlainObject(errorRate)) {
      fail(label + '.error_rate 缺失（必须含 value/errors/requests，分母含丢弃请求）');
    } else {
      if (!Number.isInteger(errorRate.errors) || errorRate.errors < 0) fail(label + '.error_rate.errors 必须是 ≥0 的整数');
      if (!Number.isInteger(errorRate.requests) || errorRate.requests < 0) fail(label + '.error_rate.requests 必须是 ≥0 的整数');
      if (!isFiniteNumber(errorRate.value) || errorRate.value < 0 || errorRate.value > 1) {
        fail(label + '.error_rate.value 必须落在 [0,1]');
      }
      if (Number.isInteger(errorRate.requests) && Number.isInteger(errorRate.errors) && isFiniteNumber(errorRate.value)) {
        if (Number.isInteger(group.requests) && errorRate.requests !== group.requests) {
          fail(`${label}.error_rate.requests 必须等于该组总请求数 ${group.requests}`);
        }
        const derived = errorRate.requests === 0 ? 0 : errorRate.errors / errorRate.requests;
        if (Math.abs(errorRate.value - derived) > 1e-9) {
          fail(`${label}.error_rate.value=${errorRate.value} 与 errors/requests=${derived} 不一致（分母口径必须写清）`);
        }
      }
    }
  }
}

function validateSkippedEndpoints(skipped, fail) {
  if (skipped === undefined) return;
  if (!Array.isArray(skipped)) {
    fail('skipped_endpoints 必须是数组');
    return;
  }
  for (const [index, entry] of skipped.entries()) {
    if (!isPlainObject(entry)) {
      fail(`skipped_endpoints[${index}] 必须是对象`);
      continue;
    }
    if (!isNonEmptyString(entry.endpoint)) fail(`skipped_endpoints[${index}].endpoint 必须是非空字符串`);
    if (!isNonEmptyString(entry.reason)) fail(`skipped_endpoints[${index}].reason 必须写明未取得原因`);
  }
}

function validateLoad(load, fail) {
  if (!isPlainObject(load)) {
    fail('load-50vu 报告必须含 load 段（vu / duration_s / mix / assertions / resources）');
    return;
  }
  if (!Number.isInteger(load.vu) || load.vu < 1) fail('load.vu 必须是 ≥1 的整数（并发虚拟用户数）');
  if (!isFiniteNumber(load.duration_s) || load.duration_s <= 0) fail('load.duration_s 必须是正数（实测秒）');
  if (!isPlainObject(load.mix)) {
    fail('load.mix 必须记录混合负载配比（requested / actual 请求数）');
  } else {
    if (!isPlainObject(load.mix.requested)) fail('load.mix.requested 缺失（计划配比）');
    if (!isPlainObject(load.mix.actual)) fail('load.mix.actual 缺失（实测请求条数，必须与计划分开报）');
  }
  if (!Array.isArray(load.assertions) || load.assertions.length < 2) {
    fail('load.assertions 至少要有 2 条（越权拒绝 + 重复写入不产生第二行，规格书 §4.3）');
  } else {
    for (const [index, assertion] of load.assertions.entries()) {
      if (!isPlainObject(assertion)) {
        fail(`load.assertions[${index}] 必须是对象`);
        continue;
      }
      if (!isNonEmptyString(assertion.name)) fail(`load.assertions[${index}].name 必须是非空字符串`);
      if (typeof assertion.ok !== 'boolean') fail(`load.assertions[${index}].ok 必须是布尔（true=通过 / false=失败）`);
      if (!isNonEmptyString(assertion.detail)) fail(`load.assertions[${index}].detail 必须写明实测读数`);
    }
  }
}

/**
 * 报告形态闸门。返回 `{ok, errors, verdict, groups_below_minimum}`。
 * `ok === true` 才允许把该报告当"可核读数"引用。
 */
export function validatePerfReport(report) {
  const errors = [];
  const fail = (message) => errors.push(message);
  if (!isPlainObject(report)) {
    return { ok: false, errors: ['报告必须是 JSON 对象'], verdict: 'insufficient', groups_below_minimum: [] };
  }
  if (report.schema_version !== PERF_REPORT_SCHEMA_VERSION) {
    fail(`schema_version 必须是 ${PERF_REPORT_SCHEMA_VERSION}（实测值 ${JSON.stringify(report.schema_version)}）`);
  }
  if (!REPORT_KINDS.includes(report.kind)) fail(`kind 必须是 ${REPORT_KINDS.join(' / ')}（实测值 ${JSON.stringify(report.kind)}）`);
  for (const key of ['baseline_sha', 'code_sha']) {
    if (!isFullSha(report[key])) {
      fail(`${key} 必须是 40 位小写十六进制提交 SHA（实测值 ${JSON.stringify(report[key])}）—— 判定必须绑定被测代码`);
    }
  }
  if (!isIsoWithOffset(report.generated_at)) fail('generated_at 必须是带时区偏移的 ISO 时间串（如 2026-10-20T11:00:00.000+08:00）');
  if (!Array.isArray(report.commands) || report.commands.length === 0 || report.commands.some((entry) => !isNonEmptyString(entry))) {
    fail('commands 必须是非空字符串数组：命令原文要能直接粘贴复跑');
  }
  if (report.percentile_method !== PERCENTILE_METHOD) {
    fail(`percentile_method 必须是 ${PERCENTILE_METHOD}（实测值 ${JSON.stringify(report.percentile_method)}）`);
  }
  validateEnvFingerprint(report.env_fingerprint, fail);
  validateDataScale(report.data_scale, fail);
  validateSubstitute(report.substitute, fail);
  validateClaims(report.claims, fail);
  if (typeof report.within_same_host !== 'boolean') fail('within_same_host 必须是布尔（客户端与被测服务是否同机）');
  if (!Number.isInteger(report.warmup_discarded) || report.warmup_discarded < 0) {
    fail('warmup_discarded 必须是 ≥0 的整数（预热丢弃次数必须显式记录，⛔ 不得静默丢弃）');
  }
  validateGroups(report.groups, fail);
  validateSkippedEndpoints(report.skipped_endpoints, fail);
  if (report.kind === 'load-50vu') validateLoad(report.load, fail);

  const groups = Array.isArray(report.groups) ? report.groups.filter(isPlainObject) : [];
  const groupsBelowMinimum = groups
    .filter((group) => !Number.isInteger(group.n) || group.n < MIN_SAMPLES_PER_GROUP)
    .map((group) => ({ name: String(group.name ?? ''), n: group.n ?? null }));
  const verdict = groupsBelowMinimum.length === 0 && groups.length > 0 ? 'measured' : 'insufficient';
  return { ok: errors.length === 0, errors, verdict, groups_below_minimum: groupsBelowMinimum };
}

/** 供 stderr 人类摘要用的一行读数（缺值一律显示 `未取得`，⛔ 不补 0）。 */
function formatMs(value) {
  return isFiniteNumber(value) ? value.toFixed(1) + ' ms' : '未取得';
}

function formatRate(errorRate) {
  if (!isPlainObject(errorRate) || !isFiniteNumber(errorRate.value)) return '未取得';
  return (errorRate.value * 100).toFixed(3) + '%（' + errorRate.errors + '/' + errorRate.requests + '）';
}

/** 人类可读摘要（写 stderr；JSON 报告走 stdout／--out 文件）。 */
export function renderHumanSummary(report) {
  const lines = [];
  lines.push('[perf] kind=' + report.kind + ' schema=' + report.schema_version + ' at ' + report.generated_at);
  lines.push('[perf] baseline_sha=' + report.baseline_sha + ' code_sha=' + report.code_sha);
  lines.push('[perf] execution_mode=' + (report.substitute?.execution_mode ?? '未取得') + ' real_provider_calls=' + (report.substitute?.real_provider_calls ?? '未取得'));
  const dataScale = report.data_scale ?? {};
  lines.push('[perf] data_scale: measured=' + String(dataScale.measured) + ' visible_knowledge_rows=' + JSON.stringify(dataScale.visible_knowledge_rows ?? null));
  if (isPlainObject(dataScale.rows)) {
    lines.push('[perf] data_scale rows: ' + Object.entries(dataScale.rows).map(([table, count]) => table + '=' + count).join(' '));
  }
  for (const group of Array.isArray(report.groups) ? report.groups : []) {
    const percentiles = group.percentiles ?? {};
    lines.push(
      '[perf] ' + group.endpoint + ' [' + group.mode + '/' + group.connection + '] n=' + group.n +
        ' dropped=' + group.dropped + ' p50=' + formatMs(percentiles.p50_ms) + ' p95=' + formatMs(percentiles.p95_ms) +
        ' max=' + formatMs(percentiles.max_ms) + ' err=' + formatRate(group.error_rate),
    );
  }
  const validation = validatePerfReport(report);
  lines.push('[perf] verdict=' + validation.verdict + ' schema_ok=' + String(validation.ok));
  for (const skipped of Array.isArray(report.skipped_endpoints) ? report.skipped_endpoints : []) {
    lines.push('[perf] 未取得：' + skipped.endpoint + ' —— ' + skipped.reason);
  }
  for (const error of validation.errors) lines.push('[perf][schema] ' + error);
  return lines.join('\n');
}
