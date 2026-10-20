#!/usr/bin/env node
/**
 * GY-I23 · 本机回环**时延分位数**采样器（取证工具，⛔ 不是 CI 门禁）。
 *
 * ## 用法（证据页登记的命令原文）
 * ```powershell
 * node tools/perf/latency-sample.mjs --base http://127.0.0.1:3310 --n 60 --cold --hot
 * node tools/perf/latency-sample.mjs --base http://127.0.0.1:3310 --n 60 --mode concurrent --concurrency 10 --hot
 * ```
 * JSON 报告走 **stdout**（可重定向落盘）；人类可读摘要走 **stderr**。
 *
 * ## 口径（与规格书 §4 逐字一致）
 * - `n` 是**每个端点 × 每个连接类别**的有效样本数（不是总量）；`--n 60` ⇒ 每格 60 条；
 * - 冷/热分组：`cold`＝一次性连接（`agent:false`），`hot`＝keep-alive 复用；两组**分开算分位数**；
 * - 预热：每组先打 `--warmup` 条（缺省 5）并**显式计入** `warmup_discarded`，⛔ 不静默丢弃；
 * - 丢弃：超时／非 2xx／传输错误 ⇒ 计入 `dropped` + `drop_reasons`，且 `error_rate` 的分母
 *   **含**这些请求（规格书 §4.2）；
 * - 串行与并发**分开报**：`--mode serial` 与 `--mode concurrent` 的数字不可互相引用；
 * - 时延只认 **HTTP 边界**（客户端 `hrtime`），⛔ 不用 `app.inject()` 进程内计时。
 *
 * ## 诚实性（规格书 §5）
 * 本脚本只产出"本机回环、`stub` 隔离替身、合成数据规模"条件下的**服务端处理分位数**：
 * 不含真机、不含 ≥20Mbps／RTT≤100ms 公网链路、不含真实供应商耗时 ⇒ 报告 `claims` 里
 * `not_assertable` 逐条写明，⛔ 不得当需求 §6.2 的达标判定。
 */
import os from 'node:os';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  buildPerfReport,
  collectEnvFingerprint,
  measureDataScale,
  renderHumanSummary,
  summarizeDurations,
  validatePerfReport,
  MIN_SAMPLES_PER_GROUP,
} from './lib/report.mjs';
import { createKeepAliveAgent, loginStub, parseJson, timedRequest } from './lib/http.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const DEFAULTS = Object.freeze({
  base: 'http://127.0.0.1:3310',
  n: 60,
  warmup: 5,
  mode: 'serial',
  concurrency: 10,
  timeoutMs: 5000,
  localDev: '.local/local-dev',
  endpoints: null,
  out: null,
  baselineSha: null,
  codeSha: null,
});

const ENDPOINT_SPECS = Object.freeze([
  { key: 'knowledge_list', label: 'GET /api/v1/knowledge?limit=20', method: 'GET', path: () => '/api/v1/knowledge?limit=20', auth: true },
  { key: 'knowledge_detail', label: 'GET /api/v1/knowledge/:id', method: 'GET', path: (context) => '/api/v1/knowledge/' + context.knowledgeId, auth: true, requires: 'knowledgeId' },
  { key: 'me_profile', label: 'GET /api/v1/me/profile', method: 'GET', path: () => '/api/v1/me/profile', auth: true },
  { key: 'catalog_crops', label: 'GET /api/v1/catalog/crops', method: 'GET', path: () => '/api/v1/catalog/crops', auth: true },
  { key: 'health', label: 'GET /health', method: 'GET', path: () => '/health', auth: false },
]);

function parseArgs(argv) {
  const options = { ...DEFAULTS, cold: false, hot: false, connectionClassesInferred: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error('无法识别的参数：' + token);
    const name = token.slice(2);
    if (name === 'cold' || name === 'hot') {
      options[name] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined) throw new Error('参数 ' + token + ' 缺少取值');
    index += 1;
    switch (name) {
      case 'base': options.base = value; break;
      case 'n': options.n = Number(value); break;
      case 'warmup': options.warmup = Number(value); break;
      case 'mode': options.mode = value; break;
      case 'concurrency': options.concurrency = Number(value); break;
      case 'timeout-ms': options.timeoutMs = Number(value); break;
      case 'local-dev': options.localDev = value; break;
      case 'endpoints': options.endpoints = value.split(',').map((entry) => entry.trim()).filter(Boolean); break;
      case 'out': options.out = value; break;
      case 'baseline-sha': options.baselineSha = value; break;
      case 'code-sha': options.codeSha = value; break;
      default: throw new Error('未知参数：' + token);
    }
  }
  if (!Number.isInteger(options.n) || options.n < MIN_SAMPLES_PER_GROUP) {
    throw new Error('--n 必须是 ≥' + MIN_SAMPLES_PER_GROUP + ' 的整数（需求原文「每项≥30次」）');
  }
  if (!Number.isInteger(options.warmup) || options.warmup < 0) throw new Error('--warmup 必须是 ≥0 的整数');
  if (!['serial', 'concurrent'].includes(options.mode)) throw new Error('--mode 只能是 serial 或 concurrent');
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) throw new Error('--concurrency 必须是 ≥1 的整数');
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error('--timeout-ms 必须是正数');
  if (!options.cold && !options.hot) {
    options.cold = true;
    options.hot = true;
    options.connectionClassesInferred = true;
  }
  return options;
}

function gitOutput(args) {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function resolveCodeState(options) {
  const baselineSha = options.baselineSha ?? gitOutput(['rev-parse', 'upstream/main']);
  const codeSha = options.codeSha ?? gitOutput(['rev-parse', 'HEAD']);
  const branch = gitOutput(['rev-parse', '--abbrev-ref', 'HEAD']);
  const status = gitOutput(['status', '--porcelain', '-uall']);
  return {
    baseline_sha: baselineSha,
    code_sha: codeSha,
    code_state: {
      branch,
      worktree: REPO_ROOT,
      dirty_files: status === null ? null : status === '' ? 0 : status.split('\n').length,
    },
  };
}

function readLocalDevSettings(localDevDir) {
  const settingsPath = join(localDevDir, 'settings.json');
  const configPath = join(localDevDir, 'private', 'config.json');
  if (!existsSync(settingsPath) || !existsSync(configPath)) return null;
  try {
    return {
      settings: JSON.parse(readFileSync(settingsPath, 'utf8')),
      // ⚠ 本机一次性开发口令：**只用于连库取数，绝不打印、绝不入库**（`/.local/` 已在 .gitignore）。
      credentials: JSON.parse(readFileSync(configPath, 'utf8')),
    };
  } catch {
    return null;
  }
}

async function openPgClient(localDevDir) {
  const loaded = readLocalDevSettings(localDevDir);
  if (loaded === null) return null;
  let pgModule;
  try {
    const repoRequire = createRequire(join(REPO_ROOT, 'package.json'));
    pgModule = repoRequire('pg');
  } catch {
    return null;
  }
  const client = new pgModule.Client({
    host: '127.0.0.1',
    port: loaded.settings.pgPort,
    user: 'gengyun_local_owner',
    password: loaded.credentials.ownerPassword,
    database: 'gengyun_local_dev',
  });
  await client.connect();
  return { client, settings: loaded.settings };
}

/** 用 GET /knowledge 分页数出**读取面可见**的知识条数（含 seed 合并），⛔ 不猜。 */
async function countVisibleKnowledgeRows({ baseUrl, token, timeoutMs }) {
  const headers = { authorization: 'Bearer ' + token };
  let cursor = null;
  let total = 0;
  for (let page = 0; page < 40; page += 1) {
    const path = '/api/v1/knowledge?limit=50' + (cursor === null ? '' : '&cursor=' + encodeURIComponent(cursor));
    const result = await timedRequest({ baseUrl, path, headers, timeoutMs, capture: true });
    if (result.status !== 200) return { ok: false, total, reason: '知识分页在第 ' + (page + 1) + ' 页返回 ' + result.status };
    const parsed = parseJson(result.text ?? '');
    const items = parsed?.data?.items;
    if (!Array.isArray(items)) return { ok: false, total, reason: '第 ' + (page + 1) + ' 页响应体形状不符' };
    total += items.length;
    cursor = parsed?.data?.next_cursor ?? null;
    if (cursor === null || items.length === 0) return { ok: true, total };
  }
  return { ok: false, total, reason: '分页超过 40 页仍未结束（异常）' };
}

function classifyFailure(result) {
  if (result.status === 0) {
    if (String(result.error ?? '').startsWith('CLIENT_TIMEOUT')) return 'client_timeout';
    return 'transport_error';
  }
  if (result.status >= 500) return 'server_' + result.status;
  if (result.status >= 400) return 'client_' + result.status;
  if (result.status < 200 || result.status >= 300) return 'unexpected_' + result.status;
  return null;
}

/** 单端点 × 单连接类别的采样（串行或受限并发）；预热与正式抽样共用同一个连接池。 */
async function sampleGroup({ spec, context, connectionClass, options }) {
  const samples = [];
  const dropReasons = {};
  let dropped = 0;
  let errors = 0;
  let bytesTotal = 0;
  let warmupCounted = 0;
  const agent = connectionClass === 'hot' ? createKeepAliveAgent({ maxSockets: Math.max(8, options.concurrency) }) : false;
  const fire = async () => {
    const result = await timedRequest({
      baseUrl: options.base,
      path: spec.path(context),
      method: spec.method,
      headers: {
        connection: connectionClass === 'cold' ? 'close' : 'keep-alive',
        ...(spec.auth ? { authorization: 'Bearer ' + context.token } : {}),
      },
      agent,
      timeoutMs: options.timeoutMs,
    });
    const failure = classifyFailure(result);
    if (failure === null) {
      samples.push(result.elapsedMs);
      bytesTotal += result.bytes ?? 0;
      return;
    }
    dropped += 1;
    errors += 1;
    dropReasons[failure] = (dropReasons[failure] ?? 0) + 1;
  };
  try {
    for (let index = 0; index < options.warmup; index += 1) {
      await fire();
      warmupCounted += 1;
    }
    // 预热样本不计入正式分组：清空并回收计数（`warmup_discarded` 单独登记）。
    samples.length = 0;
    bytesTotal = 0;
    const warmupDropped = dropped;
    const warmupErrors = errors;
    for (const key of Object.keys(dropReasons)) delete dropReasons[key];
    dropped = 0;
    errors = 0;
    if (options.mode === 'serial') {
      for (let index = 0; index < options.n; index += 1) await fire();
    } else {
      let next = 0;
      const workers = new Array(Math.min(options.concurrency, options.n)).fill(null).map(async () => {
        while (next < options.n) {
          next += 1;
          await fire();
        }
      });
      await Promise.all(workers);
    }
    const requests = options.n;
    return {
      group: {
        name: spec.key + '/' + connectionClass,
        endpoint: spec.label,
        method: spec.method,
        mode: options.mode,
        connection: connectionClass,
        requests,
        n: samples.length,
        dropped,
        drop_reasons: dropReasons,
        percentiles: summarizeDurations(samples),
        error_rate: { value: requests === 0 ? 0 : errors / requests, errors, requests },
        bytes: { mean: samples.length === 0 ? null : Math.round(bytesTotal / samples.length) },
        warmup: { count: warmupCounted, dropped: warmupDropped, errors: warmupErrors },
      },
    };
  } finally {
    if (connectionClass === 'hot') agent.destroy();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const health = await timedRequest({ baseUrl: options.base, path: '/health', timeoutMs: options.timeoutMs, capture: true });
  if (health.status !== 200) {
    throw new Error('被测 API 不可达：GET /health 返回 ' + health.status + ' ' + (health.error ?? ''));
  }
  const executionMode = parseJson(health.text ?? '')?.meta?.execution_mode ?? 'unknown';
  const apiPort = Number(new URL(options.base).port || '0');

  const login = await loginStub({
    baseUrl: options.base,
    code: 'perf-latency-' + Date.now(),
    idempotencyKey: 'perf-latency-login-' + Date.now(),
    timeoutMs: options.timeoutMs,
  });
  if (!login.ok) throw new Error('合成身份登录失败：status=' + login.status + ' ' + (login.error ?? ''));
  const token = login.token;

  const knowledgePage = await timedRequest({
    baseUrl: options.base,
    path: '/api/v1/knowledge?limit=50',
    headers: { authorization: 'Bearer ' + token },
    timeoutMs: options.timeoutMs,
    capture: true,
  });
  const knowledgeIds = (parseJson(knowledgePage.text ?? '')?.data?.items ?? [])
    .map((item) => item?.id)
    .filter((id) => typeof id === 'string');
  const visible = await countVisibleKnowledgeRows({ baseUrl: options.base, token, timeoutMs: options.timeoutMs });

  const pg = await openPgClient(resolve(REPO_ROOT, options.localDev));
  let pgVersion = null;
  let dataScale;
  try {
    if (pg !== null) {
      const versionResult = await pg.client.query('SELECT version() AS v');
      pgVersion = String(versionResult.rows[0].v);
      dataScale = await measureDataScale({
        client: pg.client,
        visibleKnowledgeRows: visible.ok ? visible.total : null,
        collectedAt: new Date().toISOString(),
      });
      if (!visible.ok) {
        dataScale.failures.push({ table: '(api) knowledge 分页', error: visible.reason });
        dataScale.measured = false;
        dataScale.reason = '可见知识条数未取得：' + visible.reason;
      }
    } else {
      dataScale = await measureDataScale({ client: null, visibleKnowledgeRows: visible.ok ? visible.total : null });
    }
  } finally {
    if (pg !== null) await pg.client.end();
  }

  const context = { token, knowledgeId: knowledgeIds[0] ?? null };
  const selected = options.endpoints === null ? ENDPOINT_SPECS : ENDPOINT_SPECS.filter((spec) => options.endpoints.includes(spec.key));
  if (selected.length === 0) throw new Error('--endpoints 未匹配任何已知端点：' + options.endpoints.join(','));
  const connectionClasses = [options.cold ? 'cold' : null, options.hot ? 'hot' : null].filter(Boolean);

  const groups = [];
  const skippedEndpoints = [];
  let warmupDiscarded = 0;
  for (const spec of selected) {
    if (spec.requires !== undefined && context[spec.requires] === null) {
      skippedEndpoints.push({
        endpoint: spec.label,
        reason: '读取面未返回任何知识 id，无法取样详情端点（库内知识表 0 行，列表内容来自 seed 合并，见 data_scale）',
      });
      continue;
    }
    for (const connectionClass of connectionClasses) {
      const { group } = await sampleGroup({ spec, context, connectionClass, options });
      warmupDiscarded += group.warmup.count;
      groups.push(group);
      process.stderr.write('[perf] ' + group.name + ' n=' + group.n + ' dropped=' + group.dropped + ' p95=' + (group.percentiles.p95_ms ?? '未取得') + ' ms\n');
    }
  }

  const codeState = resolveCodeState(options);
  const argv = ['node', 'tools/perf/latency-sample.mjs', ...process.argv.slice(2)];
  const report = buildPerfReport({
    kind: 'latency-sample',
    generated_at: new Date().toISOString(),
    baseline_sha: codeState.baseline_sha,
    code_sha: codeState.code_sha,
    code_state: codeState.code_state,
    commands: [argv.join(' ')],
    env_fingerprint: collectEnvFingerprint({
      osRelease: os.release(),
      cpuModel: os.cpus()?.[0]?.model ?? null,
      cpuCount: os.cpus()?.length ?? null,
      totalMemoryBytes: os.totalmem(),
      apiBase: options.base,
      apiPort,
      pgPort: pg?.settings?.pgPort ?? null,
      pgVersion,
      executionMode,
    }),
    data_scale: dataScale,
    substitute: {
      execution_mode: executionMode,
      real_provider_calls: 0,
      notes: 'AI 侧为 tools/local-dev 的 stub 隔离替身（零外呼）；本脚本只压 HTTP 读写面，未触发任何真实供应商调用。',
    },
    within_same_host: true,
    warmup_discarded: warmupDiscarded,
    claims: {
      assertable: [
        '在本机回环、原生 PostgreSQL、' + executionMode + ' 执行模式、数据规模见 data_scale 的条件下，所列端点在该条件下的服务端处理耗时分布（分位数为客户端 HTTP 边界实测）。',
        '冷连接与 keep-alive 复用两种连接条件下的耗时分布分别成立，两者不可互相引用。',
        '样本为全量保留：n 与 dropped 及 drop_reasons 逐条登记，未挑选最快若干次。',
      ],
      not_assertable: [
        '不构成需求 §6.2 第 5 行「首屏 p95≤2 秒／查询≤3 秒」的达标判定：本机不含真机、不含 ≥20Mbps／RTT≤100ms 公网链路、不含微信渲染。',
        '不代表真实两类识别与语音问答的时延或失败率：本机 AI 为 stub 替身，真实供应商耗时记未取得。',
        '不代表生产部署容量或任何线上并发能力：客户端与被测服务同机，生成器与被测进程共享 CPU 与 PostgreSQL。',
        '分位数不是置信区间：本报告未做 bootstrap 区间估计。',
        '单条读数（如 /health 的 latency_ms）不是分位数，未并入任何分组。',
      ],
    },
    groups,
    skipped_endpoints: skippedEndpoints,
    notes: [
      '抽样脚本与报告生成器位于 tools/perf/，⛔ 未新增 npm 脚本（package.json 正被在飞 PR 占用，避免同段冲突）。',
      options.connectionClassesInferred === true ? '未显式给 --cold/--hot ⇒ 脚本按两者都测执行。' : '连接类别由命令行显式指定。',
      '本机栈服务端 logger 为 silent（tools/local-dev/api.mjs 传 LOG_LEVEL=silent）⇒ 无服务端 responseTime，时延只来自客户端 HTTP 边界。',
    ],
  });

  const validation = validatePerfReport(report);
  const json = JSON.stringify(report, null, 2);
  if (options.out !== null) {
    writeFileSync(resolve(options.out), json + '\n', 'utf8');
    process.stderr.write('[perf] JSON 报告已写入 ' + resolve(options.out) + '\n');
  } else {
    process.stdout.write(json + '\n');
  }
  process.stderr.write(renderHumanSummary(report) + '\n');
  if (!validation.ok) {
    process.stderr.write('[perf] 报告未通过形态闸门：' + validation.errors.length + ' 条问题\n');
    process.exitCode = 3;
  }
}

main().catch((error) => {
  process.stderr.write('[perf] 失败：' + (error?.stack ?? error) + '\n');
  process.exitCode = 1;
});
