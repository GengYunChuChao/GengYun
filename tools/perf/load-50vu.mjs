#!/usr/bin/env node
/**
 * GY-I23 · **本机回环 50 并发虚拟用户混合负载**取证脚本（取证工具，⛔ 不是 CI 门禁）。
 *
 * ## 用法（证据页登记的命令原文）
 * ```powershell
 * node tools/perf/load-50vu.mjs --base http://127.0.0.1:3310 --vu 50 --duration 600
 * ```
 * JSON 报告走 **stdout**；人类可读摘要走 **stderr**。
 *
 * ## 口径（规格书 §4／§5）
 * - 50 个并发虚拟用户，**每个用户一条独立合成身份**（`POST /api/v1/auth/wechat`）：避免 50 个 VU
 *   抢同一条 profile 的版本号，把"合法 CAS 冲突"混进错误率；
 * - 混合负载配比**写死在 `--mix` 默认值里并原样输出**：计划配比（`mix.requested`）与实测条数
 *   （`mix.actual`）**分开报**；写入另有 `--write-budget-per-s` 速率闸，超预算的那次请求降级为读并记入
 *   `mix.substituted`（否则 10 分钟会灌进十几万行，反过来污染数据规模声明）；
 * - `errorRate` 分母＝**全部请求**（含丢弃／超时）；`dropped` 与 `drop_reasons` 逐条登记；
 * - 四条现场断言（越权拒绝／无凭据拒绝／同一幂等键不产生第二行／过期 If-Match 必拒）在**加载前**跑，
 *   加载后再核一次"每个用户只有一行 profile"（需要 `--local-dev` 的库通道，否则该条记未取得）；
 * - 资源快照每 30 秒一条（CPU 利用率由 `os.cpus()` 时间差算出；Windows 的 `os.loadavg()` 恒 0 ⇒ 不用它）。
 *
 * ## ⛔ 诚实性红线（规格书 §5 第 2 条）
 * 生成器与被测服务**同机共享 CPU 与 PostgreSQL** ⇒ 读数**偏保守**，只能表述为
 * "本机回环、stub 替身、同机条件下的 50 并发客户端读数"，⛔ **不是**部署容量结论，
 * ⛔ **不代表**外部 AI 容量（issue #23 C7 原文禁止）。
 */
import os from 'node:os';
import { randomUUID } from 'node:crypto';
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
} from './lib/report.mjs';
import { createKeepAliveAgent, createSeededRandom, loginStub, parseJson, timedRequest } from './lib/http.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const DEFAULT_MIX = Object.freeze({
  knowledge_list: 0.45,
  knowledge_detail: 0.15,
  me_profile: 0.15,
  catalog_crops: 0.1,
  history: 0.05,
  profile_put: 0.1,
});

const DEFAULTS = Object.freeze({
  base: 'http://127.0.0.1:3310',
  vu: 50,
  duration: 600,
  mix: null,
  writeBudgetPerS: 20,
  timeoutMs: 10000,
  localDev: '.local/local-dev',
  seed: 20261020,
  out: null,
  baselineSha: null,
  codeSha: null,
  resourceEvery: 30,
});

function parseArgs(argv) {
  const options = { ...DEFAULTS };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error('无法识别的参数：' + token);
    const value = argv[index + 1];
    if (value === undefined) throw new Error('参数 ' + token + ' 缺少取值');
    index += 1;
    switch (token.slice(2)) {
      case 'base': options.base = value; break;
      case 'vu': options.vu = Number(value); break;
      case 'duration': options.duration = Number(value); break;
      case 'mix': options.mix = value; break;
      case 'write-budget-per-s': options.writeBudgetPerS = Number(value); break;
      case 'timeout-ms': options.timeoutMs = Number(value); break;
      case 'local-dev': options.localDev = value; break;
      case 'seed': options.seed = Number(value); break;
      case 'out': options.out = value; break;
      case 'baseline-sha': options.baselineSha = value; break;
      case 'code-sha': options.codeSha = value; break;
      case 'resource-every': options.resourceEvery = Number(value); break;
      default: throw new Error('未知参数：' + token);
    }
  }
  if (!Number.isInteger(options.vu) || options.vu < 1) throw new Error('--vu 必须是 ≥1 的整数');
  if (!Number.isFinite(options.duration) || options.duration <= 0) throw new Error('--duration 必须是正数（秒）');
  if (!Number.isFinite(options.writeBudgetPerS) || options.writeBudgetPerS < 0) throw new Error('--write-budget-per-s 必须是 ≥0 的数');
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error('--timeout-ms 必须是正数');
  if (!Number.isInteger(options.resourceEvery) || options.resourceEvery <= 0) throw new Error('--resource-every 必须是 ≥1 的整数');
  options.mix = options.mix === null ? { ...DEFAULT_MIX } : parseMix(options.mix);
  const total = Object.values(options.mix).reduce((sum, weight) => sum + weight, 0);
  if (Math.abs(total - 1) > 1e-9) throw new Error('--mix 权重之和必须等于 1（实测 ' + total + '）');
  return options;
}

function parseMix(text) {
  const mix = {};
  for (const entry of text.split(',')) {
    const [key, weight] = entry.split('=').map((part) => part.trim());
    if (!key || weight === undefined) throw new Error('--mix 片段无法解析：' + entry);
    const value = Number(weight);
    if (!Number.isFinite(value) || value < 0) throw new Error('--mix 权重非法：' + entry);
    mix[key] = value;
  }
  return mix;
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
      // ⚠ 本机一次性开发口令：只用于连库取数，绝不打印、绝不入库（`/.local/` 已在 .gitignore）。
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

function cpuTimes() {
  const cpus = os.cpus() ?? [];
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    for (const value of Object.values(cpu.times)) total += value;
    idle += cpu.times.idle;
  }
  return { idle, total };
}

function memorySnapshot() {
  const usage = process.memoryUsage();
  return {
    rss_mb: Math.round((usage.rss / (1024 * 1024)) * 10) / 10,
    heap_used_mb: Math.round((usage.heapUsed / (1024 * 1024)) * 10) / 10,
  };
}

function classifyFailure(result) {
  if (result.status === 0) {
    if (String(result.error ?? '').startsWith('CLIENT_TIMEOUT')) return 'client_timeout';
    return 'transport_error';
  }
  if (result.status >= 500) return 'server_' + result.status;
  if (result.status >= 400) return 'client_' + result.status;
  return 'unexpected_' + result.status;
}

function pickOp(random, mix) {
  let threshold = random();
  for (const [key, weight] of Object.entries(mix)) {
    if (threshold < weight) return key;
    threshold -= weight;
  }
  return Object.keys(mix)[0];
}

class WriteBudget {
  constructor(perSecond) {
    this.perSecond = perSecond;
    this.tokens = perSecond;
    this.last = Date.now();
  }
  take() {
    if (this.perSecond <= 0) return false;
    const now = Date.now();
    const elapsed = (now - this.last) / 1000;
    if (elapsed > 0) {
      this.tokens = Math.min(this.perSecond, this.tokens + elapsed * this.perSecond);
      this.last = now;
    }
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const random = createSeededRandom(options.seed);
  const agent = createKeepAliveAgent({ maxSockets: options.vu + 8, maxFreeSockets: options.vu + 8 });

  const health = await timedRequest({ baseUrl: options.base, path: '/health', timeoutMs: options.timeoutMs, capture: true });
  if (health.status !== 200) throw new Error('被测 API 不可达：GET /health 返回 ' + health.status + ' ' + (health.error ?? ''));
  const executionMode = parseJson(health.text ?? '')?.meta?.execution_mode ?? 'unknown';
  const apiPort = Number(new URL(options.base).port || '0');

  // ---- 准备：50 条独立合成身份 -------------------------------------------------
  const users = [];
  for (let index = 0; index < options.vu; index += 1) {
    const stamp = Date.now() + '-' + index;
    const login = await loginStub({
      baseUrl: options.base,
      code: 'perf-load-' + stamp,
      idempotencyKey: 'perf-load-login-' + stamp,
      timeoutMs: options.timeoutMs,
    });
    if (!login.ok) throw new Error('第 ' + (index + 1) + ' 个虚拟用户登录失败：status=' + login.status + ' ' + (login.error ?? ''));
    const profile = await timedRequest({
      baseUrl: options.base,
      path: '/api/v1/me/profile',
      headers: { authorization: 'Bearer ' + login.token },
      timeoutMs: options.timeoutMs,
    });
    users.push({ index, token: login.token, etag: profile.headers?.etag ?? null });
  }
  process.stderr.write('[perf] 已建立 ' + users.length + ' 条合成会话（每条独立用户）\n');

  const bearer = (user) => ({ authorization: 'Bearer ' + user.token, connection: 'keep-alive' });
  const jsonHeaders = (user) => ({ ...bearer(user), 'content-type': 'application/json' });

  // ---- 目录/知识基准数据（PUT 需要合法实体；详情端点需要真实 id）------------------
  const crops = await timedRequest({ baseUrl: options.base, path: '/api/v1/catalog/crops', headers: bearer(users[0]), timeoutMs: options.timeoutMs, capture: true });
  const cropId = parseJson(crops.text ?? '')?.data?.items?.[0]?.id ?? null;
  const regions = await timedRequest({ baseUrl: options.base, path: '/api/v1/catalog/regions?parent_code=330100', headers: bearer(users[0]), timeoutMs: options.timeoutMs, capture: true });
  const region = parseJson(regions.text ?? '')?.data?.items?.[0] ?? null;
  const knowledge = await timedRequest({ baseUrl: options.base, path: '/api/v1/knowledge?limit=50', headers: bearer(users[0]), timeoutMs: options.timeoutMs, capture: true });
  const knowledgeIds = (parseJson(knowledge.text ?? '')?.data?.items ?? []).map((item) => item?.id).filter((id) => typeof id === 'string');
  const profileBody = JSON.stringify({
    crop_id: cropId,
    region_code: region?.code ?? null,
    region_catalog_version: region?.catalog_version ?? null,
  });

  // ---- 断言（规格书 §4.3：越权 403/401 + 重复写入不产生第二行）---------------------
  const assertions = [];
  const anonymous = await timedRequest({ baseUrl: options.base, path: '/api/v1/knowledge', timeoutMs: options.timeoutMs, capture: true });
  const anonymousCode = parseJson(anonymous.text ?? '')?.error?.code ?? null;
  assertions.push({
    name: 'anonymous_read_denied',
    ok: anonymous.status === 401 && anonymousCode === 'SESSION_REQUIRED',
    detail: 'GET /api/v1/knowledge 无 Authorization ⇒ status=' + anonymous.status + ' error.code=' + String(anonymousCode),
  });

  const bogus = await timedRequest({
    baseUrl: options.base,
    path: '/api/v1/knowledge',
    headers: { authorization: 'Bearer perf-load-bogus-token' },
    timeoutMs: options.timeoutMs,
    capture: true,
  });
  assertions.push({
    name: 'bogus_token_denied',
    ok: bogus.status === 401,
    detail: 'GET /api/v1/knowledge 带伪造 Bearer ⇒ status=' + bogus.status,
  });

  const replayKey = 'perf-load-replay-' + randomUUID();
  const firstWrite = await timedRequest({
    baseUrl: options.base,
    path: '/api/v1/me/profile',
    method: 'PUT',
    headers: { ...jsonHeaders(users[0]), 'idempotency-key': replayKey, ...(users[0].etag === null ? {} : { 'if-match': users[0].etag }) },
    body: profileBody,
    timeoutMs: options.timeoutMs,
    capture: true,
  });
  const replayWrite = await timedRequest({
    baseUrl: options.base,
    path: '/api/v1/me/profile',
    method: 'PUT',
    headers: { ...jsonHeaders(users[0]), 'idempotency-key': replayKey, ...(users[0].etag === null ? {} : { 'if-match': users[0].etag }) },
    body: profileBody,
    timeoutMs: options.timeoutMs,
    capture: true,
  });
  users[0].etag = replayWrite.headers?.etag ?? firstWrite.headers?.etag ?? users[0].etag;
  const firstRevision = parseJson(firstWrite.text ?? '')?.data?.revision ?? null;
  const replayRevision = parseJson(replayWrite.text ?? '')?.data?.revision ?? null;
  assertions.push({
    name: 'idempotent_replay_single_result',
    ok: firstWrite.status === 200 && replayWrite.status === 200 && firstRevision !== null && firstRevision === replayRevision,
    detail:
      '同一 Idempotency-Key 连发两次 PUT /api/v1/me/profile ⇒ status=' + firstWrite.status + '/' + replayWrite.status +
      ' revision=' + String(firstRevision) + '/' + String(replayRevision),
  });

  const conflictProbe = await timedRequest({
    baseUrl: options.base,
    path: '/api/v1/me/profile',
    method: 'PUT',
    headers: { ...jsonHeaders(users[0]), 'idempotency-key': 'perf-load-conflict-' + randomUUID(), 'if-match': '"999999"' },
    body: profileBody,
    timeoutMs: options.timeoutMs,
    capture: true,
  });
  assertions.push({
    name: 'stale_if_match_rejected',
    ok: conflictProbe.status === 409 && parseJson(conflictProbe.text ?? '')?.error?.code === 'REVISION_CONFLICT',
    detail: 'PUT /api/v1/me/profile 带过期 If-Match ⇒ status=' + conflictProbe.status + ' error.code=' + String(parseJson(conflictProbe.text ?? '')?.error?.code ?? null),
  });

  const pg = await openPgClient(resolve(REPO_ROOT, options.localDev));
  let pgVersion = null;
  const pgRowCounts = async (userId) => {
    if (pg === null) return null;
    const scoped = await pg.client.query('SELECT count(*)::bigint AS rows FROM public.single_profiles WHERE user_id = $1', [userId]);
    const overall = await pg.client.query('SELECT count(*)::bigint AS rows, count(DISTINCT user_id)::bigint AS users FROM public.single_profiles');
    return {
      user_rows: Number(scoped.rows[0].rows),
      rows: Number(overall.rows[0].rows),
      users: Number(overall.rows[0].users),
    };
  };
  if (pg !== null) {
    const versionResult = await pg.client.query('SELECT version() AS v');
    pgVersion = String(versionResult.rows[0].v);
  }
  const replayRows = await pgRowCounts(null);
  assertions.push({
    name: 'idempotent_replay_no_second_row',
    ok: replayRows === null ? false : replayRows.rows === replayRows.users,
    detail:
      replayRows === null
        ? '未取得：--local-dev 库通道不存在，single_profiles 行数未核（⛔ 不得当已核）'
        : 'single_profiles：rows=' + replayRows.rows + ' distinct_users=' + replayRows.users + '（同一用户不得有第二行）',
  });

  // ---- 加载 --------------------------------------------------------------------
  const stats = new Map();
  for (const key of Object.keys(options.mix)) {
    stats.set(key, {
      name: key,
      endpoint: endpointLabel(key),
      method: key === 'profile_put' ? 'PUT' : 'GET',
      mode: 'concurrent',
      connection: 'hot',
      requests: 0,
      errors: 0,
      dropped: 0,
      drop_reasons: {},
      samples: [],
      bytes: 0,
    });
  }
  const budget = new WriteBudget(options.writeBudgetPerS);
  const mixActual = Object.fromEntries(Object.keys(options.mix).map((key) => [key, 0]));
  let substituted = 0;
  let refreshRequests = 0;
  const deadline = Date.now() + options.duration * 1000;
  const snapshots = [];
  let snapshotTimer = null;
  let lastCpu = cpuTimes();
  const takeSnapshot = async () => {
    const current = cpuTimes();
    const totalDelta = current.total - lastCpu.total;
    const idleDelta = current.idle - lastCpu.idle;
    lastCpu = current;
    const memory = memorySnapshot();
    let dbBackends = null;
    if (pg !== null) {
      try {
        const result = await pg.client.query("SELECT count(*)::integer AS n FROM pg_stat_activity WHERE datname='gengyun_local_dev'");
        dbBackends = result.rows[0].n;
      } catch { dbBackends = null; }
    }
    snapshots.push({
      t_s: Math.round((Date.now() - (deadline - options.duration * 1000)) / 1000),
      cpu_pct: totalDelta <= 0 ? null : Math.round((1 - idleDelta / totalDelta) * 1000) / 10,
      rss_mb: memory.rss_mb,
      heap_used_mb: memory.heap_used_mb,
      db_backends: dbBackends,
    });
  };
  await takeSnapshot();
  snapshotTimer = setInterval(() => {
    takeSnapshot().catch(() => {});
  }, options.resourceEvery * 1000);

  const record = (key, result, failure) => {
    const entry = stats.get(key);
    entry.requests += 1;
    mixActual[key] += 1;
    if (failure === null) {
      entry.samples.push(result.elapsedMs);
      entry.bytes += result.bytes ?? 0;
      return true;
    }
    entry.dropped += 1;
    entry.errors += 1;
    entry.drop_reasons[failure] = (entry.drop_reasons[failure] ?? 0) + 1;
    return false;
  };

  async function vuLoop(user) {
    while (Date.now() < deadline) {
      let key = pickOp(random, options.mix);
      if (key === 'profile_put' && !budget.take()) {
        substituted += 1;
        key = 'knowledge_list';
      }
      const entry = stats.get(key);
      let result;
      let failure = null;
      try {
        if (key === 'profile_put') {
          result = await timedRequest({
            baseUrl: options.base,
            path: '/api/v1/me/profile',
            method: 'PUT',
            headers: { ...jsonHeaders(user), 'idempotency-key': 'perf-load-write-' + randomUUID(), ...(user.etag === null ? {} : { 'if-match': user.etag }) },
            body: profileBody,
            agent,
            timeoutMs: options.timeoutMs,
          });
          if (result.status === 200) {
            user.etag = result.headers?.etag ?? user.etag;
          } else {
            // 版本游标失效时刷新一次（不计入分组，见报告 notes）；否则后续写入会连锁 409。
            refreshRequests += 1;
            const refreshed = await timedRequest({ baseUrl: options.base, path: '/api/v1/me/profile', headers: bearer(user), agent, timeoutMs: options.timeoutMs });
            if (refreshed.status === 200) user.etag = refreshed.headers?.etag ?? user.etag;
          }
        } else {
          result = await timedRequest({
            baseUrl: options.base,
            path: opPath(key, user, knowledgeIds),
            headers: bearer(user),
            agent,
            timeoutMs: options.timeoutMs,
          });
        }
      } catch (error) {
        result = { status: 0, elapsedMs: 0, error: 'THROWN: ' + String(error?.message ?? error) };
      }
      if (result.status >= 200 && result.status < 300) {
        record(key, result, null);
      } else {
        failure = classifyFailure(result);
        record(key, result, failure);
      }
      void entry;
    }
  }

  const startedAt = new Date();
  process.stderr.write('[perf] 开始加载：vu=' + options.vu + ' duration_s=' + options.duration + ' mix=' + JSON.stringify(options.mix) + '\n');
  await Promise.all(users.map((user) => vuLoop(user)));
  clearInterval(snapshotTimer);
  await takeSnapshot();
  const endedAt = new Date();
  agent.destroy();

  // ---- 加载后复核 ---------------------------------------------------------------
  const finalRows = await pgRowCounts(null);
  let dataScale;
  try {
    let visibleKnowledgeRows = null;
    if (knowledgeIds.length > 0) {
      let total = 0;
      let cursor = null;
      for (let page = 0; page < 40; page += 1) {
        const path = '/api/v1/knowledge?limit=50' + (cursor === null ? '' : '&cursor=' + encodeURIComponent(cursor));
        const result = await timedRequest({ baseUrl: options.base, path, headers: bearer(users[0]), timeoutMs: options.timeoutMs, capture: true });
        if (result.status !== 200) break;
        const parsed = parseJson(result.text ?? '');
        total += (parsed?.data?.items ?? []).length;
        cursor = parsed?.data?.next_cursor ?? null;
        if (cursor === null) break;
      }
      visibleKnowledgeRows = total;
    }
    dataScale = await measureDataScale({
      client: pg === null ? null : pg.client,
      visibleKnowledgeRows,
      collectedAt: new Date().toISOString(),
    });
  } finally {
    if (pg !== null) await pg.client.end();
  }

  assertions.push({
    name: 'no_duplicate_profile_rows_after_load',
    ok: finalRows === null ? false : finalRows.rows === finalRows.users && finalRows.rows >= 1,
    detail:
      finalRows === null
        ? '未取得：--local-dev 库通道不存在，加载后 single_profiles 行数未核（⛔ 不得当已核）'
        : 'single_profiles：rows=' + finalRows.rows + ' distinct_users=' + finalRows.users + '（每个用户恰一行）',
  });

  const groups = [];
  for (const [key, entry] of stats.entries()) {
    const percentiles = summarizeDurations(entry.samples);
    groups.push({
      name: key,
      endpoint: entry.endpoint,
      method: entry.method,
      mode: entry.mode,
      connection: entry.connection,
      requests: entry.requests,
      n: entry.samples.length,
      dropped: entry.dropped,
      drop_reasons: entry.drop_reasons,
      percentiles,
      error_rate: { value: entry.requests === 0 ? 0 : entry.errors / entry.requests, errors: entry.errors, requests: entry.requests },
      bytes: { mean: entry.samples.length === 0 ? null : Math.round(entry.bytes / entry.samples.length) },
    });
    entry.samples.length = 0;
  }

  const cpuValues = snapshots.map((snapshot) => snapshot.cpu_pct).filter((value) => typeof value === 'number');
  const rssValues = snapshots.map((snapshot) => snapshot.rss_mb).filter((value) => typeof value === 'number');
  const totalRequests = groups.reduce((sum, group) => sum + group.requests, 0);
  const totalErrors = groups.reduce((sum, group) => sum + (group.error_rate?.errors ?? 0), 0);

  const codeState = resolveCodeState(options);
  const argv = ['node', 'tools/perf/load-50vu.mjs', ...process.argv.slice(2)];
  const report = buildPerfReport({
    kind: 'load-50vu',
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
      notes: 'AI 侧为 tools/local-dev 的 stub 隔离替身（零外呼）；混合负载只打 HTTP 读写面，未触发任何真实供应商调用。',
    },
    within_same_host: true,
    warmup_discarded: 0,
    claims: {
      assertable: [
        '在本机回环、' + options.vu + ' 个并发虚拟用户、' + Math.round(options.duration) + ' 秒、数据规模见 data_scale 的条件下，所列端点混合负载的错误率与响应耗时分布实测成立。',
        '错误率分母为全部请求（含丢弃与超时）；每个分组的 n／dropped／drop_reasons 逐条登记。',
        '四条现场断言（无凭据 401／伪造令牌 401／同一幂等键不产生第二行／过期 If-Match 409）在该条件下的实测结果成立。',
      ],
      not_assertable: [
        '不构成需求 §6.2 第 8 行「50 并发 10 分钟、错误率≤1%」的达标判定：生成器与被测服务同机共享 CPU 与 PostgreSQL，读数偏保守且条件不同于验收环境。',
        '不代表生产部署容量或线上并发能力，也不代表外部 AI 容量（issue #23 C7 原文禁止把内部替身压测称外部 AI 容量）。',
        '真实两类识别与语音问答的失败率／时延记未取得（stub 替身零外呼）。',
        '不含真机、不含 ≥20Mbps／RTT≤100ms 公网链路、不含微信渲染与缓存条件。',
        '分位数不是置信区间；未做 bootstrap 区间估计。',
      ],
    },
    groups,
    skipped_endpoints: [
      {
        endpoint: 'GET /api/v1/posts?limit=20（社区域读取）',
        reason: '本机栈社区域未接线：实测 503 PROVIDER_UNAVAILABLE（community 持久层未装配），故混合负载不含社区读写，如实登记而非用替身读数顶替',
      },
    ],
    notes: [
      '混合负载写入有速率闸（--write-budget-per-s=' + options.writeBudgetPerS + '）：超预算的写入降级为读取，降级次数见 load.mix.substituted。',
      '写入失败（非 200）时会额外发一次 GET /me/profile 刷新版本游标；该请求不计入任何分组（见 load.refresh_requests）。',
      '每个虚拟用户一条独立合成身份，故 profile 写入之间不存在合法版本冲突。',
      '本机栈服务端 logger 为 silent（LOG_LEVEL=silent）⇒ 无服务端 responseTime，读数只来自客户端 HTTP 边界。',
    ],
    load: {
      vu: options.vu,
      duration_s: Math.round(((endedAt.getTime() - startedAt.getTime()) / 1000) * 1000) / 1000,
      requested_duration_s: options.duration,
      started_at: startedAt.toISOString(),
      ended_at: endedAt.toISOString(),
      seed: options.seed,
      mix: { requested: options.mix, actual: mixActual, substituted },
      write_budget_per_s: options.writeBudgetPerS,
      refresh_requests: refreshRequests,
      total_requests: totalRequests,
      total_errors: totalErrors,
      assertions,
      resources: {
        snapshots,
        cpu_pct_mean: cpuValues.length === 0 ? null : Math.round((cpuValues.reduce((sum, value) => sum + value, 0) / cpuValues.length) * 10) / 10,
        cpu_pct_max: cpuValues.length === 0 ? null : Math.max(...cpuValues),
        rss_mb_peak: rssValues.length === 0 ? null : Math.max(...rssValues),
        sampling_note: 'CPU 利用率＝全机 os.cpus() 时间差（含压测生成器自身）；Windows 的 os.loadavg() 恒 0，未采用。',
      },
    },
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

function endpointLabel(key) {
  switch (key) {
    case 'knowledge_list': return 'GET /api/v1/knowledge?limit=20';
    case 'knowledge_detail': return 'GET /api/v1/knowledge/:id';
    case 'me_profile': return 'GET /api/v1/me/profile';
    case 'catalog_crops': return 'GET /api/v1/catalog/crops';
    case 'history': return 'GET /api/v1/history';
    case 'profile_put': return 'PUT /api/v1/me/profile';
    default: return key;
  }
}

function opPath(key, user, knowledgeIds) {
  switch (key) {
    case 'knowledge_list': return '/api/v1/knowledge?limit=20';
    case 'knowledge_detail':
      return knowledgeIds.length === 0 ? '/api/v1/knowledge?limit=20' : '/api/v1/knowledge/' + knowledgeIds[user.index % knowledgeIds.length];
    case 'me_profile': return '/api/v1/me/profile';
    case 'catalog_crops': return '/api/v1/catalog/crops';
    case 'history': return '/api/v1/history';
    default: return '/api/v1/knowledge?limit=20';
  }
}

main().catch((error) => {
  process.stderr.write('[perf] 失败：' + (error?.stack ?? error) + '\n');
  process.exitCode = 1;
});
