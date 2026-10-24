/**
 * 第一条用户链路端到端（GY-I04 / I05 / I07 / I16，Refs #4 #5 #7 #16）。
 *
 * 干什么：在**原样 API**（`buildApp` 真装配，不 mock 路由）上跑一遍
 *   登录 → 手选作物/地区 → 搜索 → 详情 → 收藏 → 退出
 * 并把每一步的**业务语义**钉住，而不是只看 200：
 *   1) 登录：拿到会话后访问受保护接口成功；会话行按 sha256(令牌) 落库；退出后同一令牌立刻 401 `SESSION_EXPIRED`、
 *      不带上令牌对照 401 `SESSION_REQUIRED`，两者封套同形（仓内冻结口径，见步骤 6 注释）。
 *   2) 手选作物/地区：`/catalog/crops`、`/catalog/regions` 只列出**库内已登记且与目录文件一致**的项；
 *      `PUT /me/profile` 写入后 `GET /me/profile` 与 `single_profiles` 行同时成立。
 *   3) 搜索：结果只能来自**已登记来源**（`source.id` / `source.version` 与库内 `sources` / `source_versions` 直查一致），
 *      且**装了筛选条件**（换一个不存在的检索词 / 未覆盖地区必须读空 ⇒ 不是把全集当结果返回）。
 *   4) 详情：`/knowledge/:id` 与列表同一投影（`id` / `revision` / 来源版本逐字段相同），ETag 为 `"<revision>"`。
 *   5) 收藏：写入后立刻可读、重复收藏同目标不产生第二行、取消后读空；**PG 直查**校验行落库且属主正确；
 *      另一用户读不到、也删不掉（IDOR 断言，404 与不存在同形）。
 *   6) 退出：会话撤销、令牌失效（401 `SESSION_EXPIRED`），但收藏行**仍按属主保留**（不被登出清掉）。
 *
 * 真库：本脚本**自己起一个一次性 PostgreSQL 17 隔离集群**（initdb + 随机端口 + 独立数据目录），
 * 跑完无论成败都 `pg_ctl stop` 并逐个文件删除数据目录。⚠ 不从外部借库、不写死端口、不动系统 PG。
 *
 * 刻意不做（如实登记，见 docs/verification/gy-user-chain-20261019.md）：
 * - 微信侧身份换取用**桩**（`computeSubjectLookup` 的服务端算法，非真实 openid）：本机无真机、
 *   无正式 AppID/AppSecret ⇒ `sns/jscode2session` 未验证。本脚本证明的是 **API 层链路**。
 * - 不依赖 `APP_KNOWLEDGE_UNVERIFIED_SEED` 之类测试开关：资料行由本脚本按
 *   「来源已登记 + 已核对 + 已发布」的**生产口径**直接写库（与 admin 侧发布后的库内形态一致）。
 * - 会话载体是 `Authorization: Bearer <access_token>`（契约 `Session.access_token`），**不是 Cookie**。
 *
 * 运行：
 *   node tests/integration/user-chain-e2e.mjs
 *
 * 退出码（**跳过 ≠ 通过**）：
 *   0   真库起得来、6 步断言全绿；
 *   77  找不到 PostgreSQL 17（本机没装／没设 `USER_CHAIN_PG_BIN`）⇒ **未取得**，按 POSIX「skipped」惯例给 77；
 *       ⛔ 任何 `&&` 串联、CI、本地一键脚本都会因此变红 —— 这正是本意：一条都没跑的运行不得被读成通过；
 *   其它非 0（通常 1）真失败。
 *   本机开发明知无真库、只想看跳过原因时，可显式加 `--allow-skip`（或 `GY_ALLOW_SKIP=1`）取 0 —— ⛔ 不得用于门禁。
 *
 * 可选环境变量：
 *   USER_CHAIN_PG_BIN      PG 17.11 bin 目录（默认 <repo>/.pg17/pgsql/bin，再回落到 PATH 里的 initdb）
 *   USER_CHAIN_PG_DATADIR  一次性数据目录（默认 <tmpdir>/gengyun-user-chain-pg-<runId>）
 *   USER_CHAIN_PG_KEEP=1   保留数据目录与日志（排障用；默认逐个文件删干净）
 *   GY_ALLOW_SKIP=1        等同 `--allow-skip`：缺真库时把「未取得」降级为 0（仅本机开发）
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, lstatSync, unlinkSync, rmdirSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import pg from 'pg';

import { applyMigrations, discoverMigrations } from '../../services/api/src/db/migrate.ts';
import { createPool } from '../../services/api/src/db/pool.ts';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';
import { computeSubjectLookup, STUB_APP_ID } from '../../services/api/src/auth/wechat.ts';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RUN_ID = `${process.pid}-${Date.now().toString(36)}`;
const STUB_LOGIN_LOOKUP_KEY = 'gengyun-user-chain-e2e-subject-key';
// 缺真库时的出口：默认 77（未取得，不是通过）；只有显式 `--allow-skip` / `GY_ALLOW_SKIP=1` 才降级为 0。
const ALLOW_SKIP = process.argv.includes('--allow-skip') || process.env.GY_ALLOW_SKIP === '1';

// ---------------------------------------------------------------------------
// 读数记账：每一步的 步骤｜请求｜期望｜实测 都记下来，跑完打印成表（可直接贴证据页）。
// ---------------------------------------------------------------------------
let assertionCount = 0;
const rows = [];
function record(step, request, expected) {
  const row = { step, request, expected, actual: '' };
  rows.push(row);
  return {
    actual(value) {
      row.actual = String(value);
    },
  };
}
function ok(condition, message) {
  assertionCount += 1;
  if (!condition) throw new Error(message);
}
function eq(actual, expected, message) {
  assertionCount += 1;
  assert.equal(actual, expected, message);
}
function deepEq(actual, expected, message) {
  assertionCount += 1;
  assert.deepEqual(actual, expected, message);
}
/** 集合比较（顺序无关），失败信息带实测值。 */
function setEq(actual, expected, message) {
  assertionCount += 1;
  assert.deepEqual([...actual].sort(), [...expected].sort(), `${message}；实测 ${JSON.stringify(actual)}`);
}
function masked(token) {
  return typeof token === 'string' ? `${token.length} 字符` : '<非字符串令牌>';
}

// ---------------------------------------------------------------------------
// 一次性 PG 17 集群
// ---------------------------------------------------------------------------
function resolvePgBin() {
  const configured = process.env.USER_CHAIN_PG_BIN;
  const candidates = configured
    ? [configured]
    : [join(REPO_ROOT, '.pg17', 'pgsql', 'bin'), ...(process.env.PATH ?? '').split(delimiter).filter((dir) => dir !== '')];
  for (const dir of candidates) {
    if (existsSync(join(dir, 'initdb.exe')) || existsSync(join(dir, 'initdb'))) return dir;
  }
  return null;
}
/** `initdb` / `pg_ctl` 在 Windows 带 `.exe`；只按 bin 目录拼名，不写死后缀。 */
function pgTool(binDir, name) {
  return join(binDir, existsSync(join(binDir, `${name}.exe`)) ? `${name}.exe` : name);
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function run(bin, args) {
  return execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
/**
 * ⛔ `pg_ctl` 绝不能给管道：它派生的 postgres 守护进程会继承管道句柄，父进程永远等不到 EOF ⇒ 挂死。
 * （同仓 `docs/verification/gy-i24-restore-drill-local-20261018.md:45` 记过这个坑。）改用 `stdio: 'ignore'` + 就绪轮询。
 */
function runDetached(bin, args) {
  execFileSync(bin, args, { stdio: 'ignore' });
}
async function waitForReady(connectionString, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    const probe = new pg.Client({ connectionString, connectionTimeoutMillis: 1000 });
    try {
      await probe.connect();
      await probe.query('SELECT 1');
      await probe.end();
      return;
    } catch (error) {
      lastError = error;
      await probe.end().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(`pg_ctl start 后 ${timeoutMs} ms 内连不上 ${connectionString}：${lastError?.message ?? 'unknown'}`);
}
/** 逐个文件删除（⛔ 不用递归删除；工作树内 node_modules 有指向源码的联接，递归删会掏空源码）。 */
function removeTreeByEntry(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (lstatSync(full).isDirectory()) removeTreeByEntry(full);
    else unlinkSync(full);
  }
  rmdirSync(dir);
}

// ---------------------------------------------------------------------------
// 库内夹具：来源已登记 → 版本已核对 → 知识行已发布（与 admin 发布后的库内形态一致）
// ---------------------------------------------------------------------------
const FIXTURE = {
  knowledgeId: '6f1a2b3c-4d5e-5f60-8a71-9b2c3d4e5f60',
  knowledgeRowId: '7a2b3c4d-5e6f-5071-9b82-ac3d4e5f6071',
  sourceId: '8b3c4d5e-6f70-5182-ac93-bd4e5f607182',
  sourceVersionId: '9c4d5e6f-7081-5293-bda4-ce5f60718293',
  adminId: 'ad4c5e6f-7081-5293-bda4-ce5f60718293',
  sourceTitle: '水稻田杂草防除技术指导意见（端到端夹具来源，非真实发布方）',
  sourceUrl: 'https://e2e.invalid/user-chain/source',
  publisher: '端到端测试夹具（不代表任何真实机构）',
  sourceVersion: 'e2e-2026.10.19',
  cropId: 'crop_rice',
  regionCode: '330100',
  regionCatalogVersion: 'mca-xzqh-2023',
  searchTerm: '稗草',
  title: '水稻田稗草防除要点（端到端夹具，非真实资料）',
};

async function seedFixture(owner) {
  const seedSql = (name) => readFileSync(new URL(`../../db/seeds/${name}`, import.meta.url), 'utf8');
  await owner.query(seedSql('seed_reference.sql'));
  // `catalog_read.current_verified_sources` 只在「数据集模式＝real + 已接入数据库」时才放行 ⇒ 置真口径。
  await owner.query("UPDATE knowledge_dataset_config SET value='real', mode='real' WHERE key='active_mode'");
  await owner.query("UPDATE knowledge_dataset_config SET value='true', mode='real' WHERE key='database_connected'");
  // 已核对来源需要 admin_accounts 行（`source_versions.reviewed_by` 外键）。
  await owner.query(
    `INSERT INTO admin_accounts (id, login_name, credential_hash)
     VALUES ($1::uuid, 'user-chain-e2e-reviewer', 'not-a-real-credential') ON CONFLICT (id) DO NOTHING`,
    [FIXTURE.adminId],
  );
  await owner.query(
    `INSERT INTO sources (id, title, canonical_url, publisher, source_kind, evidence_kind)
     VALUES ($1::uuid, $2, $3, $4, 'verified_seed', 'mixed') ON CONFLICT (id) DO NOTHING`,
    [FIXTURE.sourceId, FIXTURE.sourceTitle, FIXTURE.sourceUrl, FIXTURE.publisher],
  );
  await owner.query(
    `INSERT INTO source_versions (id, source_id, version, content_hash, locator, retrieved_at, valid_from, validity, review_status, reviewed_by, reviewed_at)
     VALUES ($1::uuid, $2::uuid, $3, repeat('a', 64), $4, clock_timestamp() - interval '2 days',
             clock_timestamp() - interval '2 days', 'valid', 'verified', $5::uuid, clock_timestamp() - interval '1 day')
     ON CONFLICT (id) DO NOTHING`,
    [FIXTURE.sourceVersionId, FIXTURE.sourceId, FIXTURE.sourceVersion, FIXTURE.sourceUrl, FIXTURE.adminId],
  );
  await owner.query('UPDATE sources SET current_version_id=$2::uuid WHERE id=$1::uuid', [FIXTURE.sourceId, FIXTURE.sourceVersionId]);
  await owner.query(
    `INSERT INTO knowledge_versions (id, knowledge_id, revision, title, body, type, source_version_id, crop_ids, species_ids, region_codes, visibility)
     VALUES ($1::uuid, $2::uuid, 1, $3, $4, 'species', $5::uuid,
             '["crop_rice"]'::jsonb, '["species_barnyardgrass"]'::jsonb, '["330100"]'::jsonb, 'published')
     ON CONFLICT (id) DO NOTHING`,
    [
      FIXTURE.knowledgeRowId,
      FIXTURE.knowledgeId,
      FIXTURE.title,
      '本行为端到端测试夹具，用于验证「搜索/详情只能读到已登记来源的已发布资料」这条读面约束；不构成任何真实农艺建议。稗草为常见稻田杂草。',
      FIXTURE.sourceVersionId,
    ],
  );
}

// ---------------------------------------------------------------------------
// HTTP 客户端（只用全局 fetch，回环 127.0.0.1）
// ---------------------------------------------------------------------------
function client(origin) {
  return async function request(method, path, options = {}) {
    const headers = {};
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
    Object.assign(headers, options.headers ?? {});
    const response = await fetch(`${origin}${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();
    let body = null;
    try {
      body = text === '' ? null : JSON.parse(text);
    } catch {
      body = { raw: text };
    }
    return {
      status: response.status,
      body,
      etag: response.headers.get('etag'),
      cacheControl: response.headers.get('cache-control'),
    };
  };
}
const errorCodeOf = (response) => response.body?.error?.code ?? null;
const errorShapeOf = (response) =>
  response.body === null || typeof response.body !== 'object'
    ? null
    : { top: Object.keys(response.body).sort(), error: Object.keys(response.body.error ?? {}).sort() };

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  const pgBin = resolvePgBin();
  if (pgBin === null) {
    console.log('SKIP real PG17 user chain: 未找到 PostgreSQL 17 的 bin 目录（设 USER_CHAIN_PG_BIN，或把 initdb 放进 PATH）。');
    console.log('     本次运行没有起库、没有跑链路 —— 不是通过，也不是失败。');
    if (ALLOW_SKIP) {
      console.log('EXITCODE=0（--allow-skip / GY_ALLOW_SKIP=1 已显式授权：仅本机开发，⛔ 不得接进门禁）。');
      return 0;
    }
    console.log('EXITCODE=77 表示未取得，不是通过（POSIX 惯例 skipped；本机明知无真库时可显式加 --allow-skip 取 0）。');
    return 77;
  }
  const dataDir = process.env.USER_CHAIN_PG_DATADIR ?? join(tmpdir(), `gengyun-user-chain-pg-${RUN_ID}`);
  const keep = process.env.USER_CHAIN_PG_KEEP === '1';
  const logFile = join(dirname(dataDir), `gengyun-user-chain-pg-${RUN_ID}.log`);
  const port = await freePort();
  const connectionString = `postgres://postgres@127.0.0.1:${port}/postgres`;
  const startedAt = Date.now();

  let app = null;
  let pool = null;
  let owner = null;
  let clusterUp = false;
  let serverVersion = '';

  console.log(`[pg] bin=${pgBin}`);
  console.log(`[pg] dataDir=${dataDir} port=${port}`);
  try {
    if (existsSync(dataDir)) throw new Error(`数据目录已存在，拒绝复用（请删掉或换 USER_CHAIN_PG_DATADIR）：${dataDir}`);
    mkdirSync(dirname(dataDir), { recursive: true });
    run(pgTool(pgBin, 'initdb'), ['-D', dataDir, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--locale=C']);
    // `-l <log>` 把 postgres 的 stdout/stderr 重定向到文件：⛔ 不要让守护进程继承本进程的管道句柄（会永久挂住）。
    runDetached(pgTool(pgBin, 'pg_ctl'), ['-D', dataDir, '-l', logFile, '-w', '-t', '60', '-o', `-p ${port} -c listen_addresses=127.0.0.1`, 'start']);
    clusterUp = true;
    // `pg_ctl` 与它派生的 postgres 都不给我们任何输出，就绪与否以「能不能连上」为准。
    await waitForReady(connectionString, 60000);

    owner = new pg.Client({ connectionString });
    await owner.connect();
    serverVersion = (await owner.query('SHOW server_version')).rows[0].server_version;
    ok(/^17\./.test(serverVersion), `必须是 PostgreSQL 17.x，实测 ${serverVersion}`);
    console.log(`[pg] server_version=${serverVersion}`);
    eq((await owner.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'")).rows[0].n, 0, '一次性集群必须是空库');

    const migrations = discoverMigrations();
    ok(migrations.length >= 18, `迁移数量异常：${migrations.length}`);
    const first = await applyMigrations(owner, migrations);
    eq(first.applied.length, migrations.length, '首次迁移必须全部落地');
    eq((await applyMigrations(owner, migrations)).applied.length, 0, '重复迁移必须是 no-op');
    console.log(`[pg] migrations=${first.applied.length}（重复应用 0 条）`);
    await seedFixture(owner);

    pool = createPool(connectionString);
    const config = {
      ...loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
      // 真库 + 真模式：收藏/历史/资料读面都走 PG 实现（`app.ts` 只在 real + pool 时接 PG store）。
      executionMode: 'real',
      requiresRealCredentials: true,
    };
    app = buildApp({
      config,
      pool,
      now: () => new Date(),
      // ⚠ 身份换取用桩：本机无真机、无正式 AppID ⇒ `sns/jscode2session` 未验证；算法与仓内合成模式同源。
      wechat: {
        async exchange(code) {
          return { subjectLookupHex: computeSubjectLookup(STUB_LOGIN_LOOKUP_KEY, STUB_APP_ID, `stub:${code}`) };
        },
      },
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const origin = app.listeningOrigin;
    const request = client(origin);
    console.log(`[api] ${origin} execution_mode=${config.executionMode} favorites_pg=${app.favoritesService !== null}`);

    // ---- 1 登录 -----------------------------------------------------------
    const loginCode = `chain-${RUN_ID}`;
    const step1 = record('1 登录', 'POST /api/v1/auth/wechat', '200 + 会话令牌；令牌可访问受保护接口');
    const login = await request('POST', '/api/v1/auth/wechat', {
      body: { code: loginCode },
      headers: { 'idempotency-key': randomUUID() },
    });
    eq(login.status, 200, `登录必须 200，实测 ${login.status}：${JSON.stringify(login.body)}`);
    eq(login.body.meta.execution_mode, 'real', '登录响应 meta.execution_mode 必须是 real（真库口径）');
    eq(login.cacheControl, 'no-store', '登录响应必须 no-store');
    const token = login.body.data.access_token;
    ok(typeof token === 'string' && token.length >= 32, '登录必须下发 access_token');
    ok(typeof login.body.data.expires_at === 'string', '登录必须下发 expires_at');
    eq(login.etag, `"${login.body.data.revision}"`, `登录 ETag 必须是 "<revision>"，实测 ${login.etag}`);
    const session = await request('GET', '/api/v1/auth/session', { token });
    eq(session.status, 200, '登录后受保护接口必须成功');
    eq(session.body.data.audience, 'user', '会话受众必须是 user');
    const me = await request('GET', '/api/v1/me/profile', { token });
    eq(me.status, 200, '登录后 /me/profile 必须 200（受保护接口）');
    eq(me.body.data.revision, 1, '新账号档案必须是空档案 revision=1');

    // 会话落库：按 sha256(令牌) 直查（不只看响应）。
    const sessionRows = (
      await owner.query(
        "SELECT s.id, s.user_id, s.audience, s.revoked_at FROM public.sessions s WHERE s.token_hash = decode($1,'hex')",
        [hashToken(token)],
      )
    ).rows;
    eq(sessionRows.length, 1, '令牌摘要必须在 sessions 表恰好命中 1 行');
    eq(sessionRows[0].audience, 'user', '会话受众必须落库为 user');
    eq(sessionRows[0].revoked_at, null, '新会话不得已撤销');
    const userId = sessionRows[0].user_id;
    const sessionId = sessionRows[0].id;
    ok(/^[0-9a-f-]{36}$/.test(userId), 'users.id 必须是 uuid');
    step1.actual(`200；access_token=${masked(token)}；/auth/session=200 受众 user；/me/profile=200 revision=1；sessions 命中 1 行`);

    // ---- 2 手选作物/地区 --------------------------------------------------
    const step2 = record(
      '2 手选作物/地区',
      'GET /catalog/crops、GET /catalog/regions、PUT /me/profile',
      '只出现库内已登记项；写入后读回一致',
    );
    const crops = await request('GET', '/api/v1/catalog/crops', { token });
    eq(crops.status, 200, '作物目录必须 200');
    eq(crops.cacheControl, 'no-store', '作物目录必须 no-store');
    const rice = (crops.body.data.items ?? []).find((item) => item.id === FIXTURE.cropId);
    ok(rice !== undefined, `作物目录必须含 ${FIXTURE.cropId}（实测 ${JSON.stringify(crops.body.data.items?.map((i) => i.id))}）`);
    eq(rice.name, '水稻', '作物名必须与 catalog 文件一致');
    const regions = await request('GET', '/api/v1/catalog/regions?parent_code=330000&limit=50', { token });
    eq(regions.status, 200, '地区目录必须 200');
    const hangzhou = (regions.body.data.items ?? []).find((item) => item.code === FIXTURE.regionCode);
    ok(hangzhou !== undefined, `地区目录必须含 ${FIXTURE.regionCode}`);
    eq(hangzhou.catalog_version, FIXTURE.regionCatalogVersion, '地区目录版本必须与库内一致');
    // 反向控制：把库里某作物停用 ⇒ 目录必须立刻不再列出它（证明列表读的是库内登记，不是静态文件全集）。
    await owner.query("UPDATE public.crops SET active=false WHERE id='crop_corn'");
    const cropsAfter = await request('GET', '/api/v1/catalog/crops', { token });
    setEq(
      cropsAfter.body.data.items.map((item) => item.id),
      crops.body.data.items.map((item) => item.id).filter((id) => id !== 'crop_corn'),
      '停用的作物必须从目录消失',
    );
    await owner.query("UPDATE public.crops SET active=true WHERE id='crop_corn'");

    const put = await request('PUT', '/api/v1/me/profile', {
      token,
      headers: { 'idempotency-key': randomUUID(), 'if-match': '"1"' },
      body: { crop_id: FIXTURE.cropId, region_code: FIXTURE.regionCode, region_catalog_version: FIXTURE.regionCatalogVersion },
    });
    eq(put.status, 200, `选定作物/地区必须 200，实测 ${put.status}：${JSON.stringify(put.body)}`);
    eq(put.body.data.crop_id, FIXTURE.cropId, '档案 crop_id 必须为所选作物');
    eq(put.body.data.region_code, FIXTURE.regionCode, '档案 region_code 必须为所选地区');
    eq(put.body.data.revision, 2, '首次写入后档案 revision 必须为 2');
    eq(put.etag, '"2"', `档案 ETag 必须是 "2"，实测 ${put.etag}`);
    const reread = await request('GET', '/api/v1/me/profile', { token });
    eq(reread.body.data.crop_id, FIXTURE.cropId, '读回档案必须与写入一致');
    const profileRows = (
      await owner.query(
        'SELECT crop_id, region_code, region_catalog_version, revision FROM public.single_profiles WHERE user_id=$1::uuid',
        [userId],
      )
    ).rows;
    eq(profileRows.length, 1, '档案必须落库 1 行');
    eq(profileRows[0].region_catalog_version, FIXTURE.regionCatalogVersion, '库内档案地区版本必须一致');
    step2.actual(
      `作物=${rice.id}/${rice.name}；地区=${hangzhou.code}/${hangzhou.name}@${hangzhou.catalog_version}；PUT→revision=2；库内档案 1 行`,
    );

    // ---- 3 搜索 -----------------------------------------------------------
    const searchPath = `/api/v1/knowledge?crop_id=${FIXTURE.cropId}&region_code=${FIXTURE.regionCode}&q=${encodeURIComponent(FIXTURE.searchTerm)}`;
    const step3 = record('3 搜索', `GET ${searchPath}`, '只命中已登记来源的已发布资料；换词/换地区必须读空');
    const search = await request('GET', searchPath, { token });
    eq(search.status, 200, `搜索必须 200，实测 ${search.status}：${JSON.stringify(search.body)}`);
    eq(search.cacheControl, 'no-store', '搜索必须 no-store');
    eq(search.etag, null, '列表不得带 ETag（只有详情带）');
    const items = search.body.data.items ?? [];
    eq(items.length, 1, `按作物+地区+检索词必须恰好命中夹具 1 条，实测 ${items.length}：${JSON.stringify(items.map((i) => i.id))}`);
    const hit = items[0];
    eq(hit.id, FIXTURE.knowledgeId, '命中行 id 必须是夹具 knowledge_id');
    eq(hit.source.id, FIXTURE.sourceId, '命中行来源 id 必须是已登记来源');
    eq(hit.source.version, FIXTURE.sourceVersion, '命中行来源版本必须是已核对版本');
    // 来源直查：响应里的来源必须真在库里（不是拼出来的）。
    const registered = (
      await owner.query(
        `SELECT s.id, sv.version, sv.review_status, sv.validity
           FROM public.sources s
           JOIN public.source_versions sv ON sv.source_id=s.id AND sv.id=s.current_version_id
          WHERE s.id=$1::uuid`,
        [hit.source.id],
      )
    ).rows;
    eq(registered.length, 1, '响应里的来源必须在 sources 表存在且为 current_version');
    eq(registered[0].version, hit.source.version, '来源版本必须与库内 current_version 一致');
    eq(registered[0].review_status, 'verified', '来源版本必须已核对');
    eq(registered[0].validity, 'valid', '来源版本必须有效');
    // 装筛选：换一个库里不存在的检索词 ⇒ 必须读空（证明不是把全集当结果）。
    const empty = await request('GET', `/api/v1/knowledge?crop_id=${FIXTURE.cropId}&q=${encodeURIComponent('绝无此词-zzz-9147')}`, { token });
    eq(empty.status, 200, '空结果搜索也必须 200');
    eq((empty.body.data.items ?? []).length, 0, '不存在的检索词必须读空（筛选真的生效）');
    // 装筛选：换一个不含该资料的地区 ⇒ 必须读空。
    const otherRegion = await request('GET', `/api/v1/knowledge?region_code=330200&q=${encodeURIComponent(FIXTURE.searchTerm)}`, { token });
    eq((otherRegion.body.data.items ?? []).length, 0, '换到未覆盖地区必须读空');
    step3.actual(
      `items=1 id=${hit.id}；source=${hit.source.id}@${hit.source.version}（库内 verified/valid）；不存在检索词→0；330200→0`,
    );

    // ---- 4 详情 -----------------------------------------------------------
    const step4 = record(
      '4 详情',
      `GET /api/v1/knowledge/${FIXTURE.knowledgeId}`,
      '200；字段与列表一致（id/revision/来源版本）；ETag="<revision>"',
    );
    const detail = await request('GET', `/api/v1/knowledge/${hit.id}`, { token });
    eq(detail.status, 200, `详情必须 200，实测 ${detail.status}：${JSON.stringify(detail.body)}`);
    eq(detail.cacheControl, 'no-store', '详情必须 no-store');
    eq(detail.etag, `"${detail.body.data.revision}"`, `详情 ETag 必须是 "<revision>"，实测 ${detail.etag}`);
    for (const field of ['id', 'revision', 'type', 'title', 'body', 'reference_state']) {
      eq(detail.body.data[field], hit[field], `详情 ${field} 必须与列表逐字段一致`);
    }
    deepEq(detail.body.data.source, hit.source, '详情 source 必须与列表逐字段一致');
    const knowledgeRows = (
      await owner.query('SELECT knowledge_id, revision, visibility FROM public.knowledge_versions WHERE knowledge_id=$1::uuid', [hit.id])
    ).rows;
    eq(knowledgeRows.length, 1, '知识行必须落库 1 行');
    eq(knowledgeRows[0].visibility, 'published', '知识行必须是已发布');
    eq(knowledgeRows[0].revision, detail.body.data.revision, '库内 revision 必须与响应一致');
    // 不存在必须 404 同形（不泄漏存在性）。
    const missing = await request('GET', `/api/v1/knowledge/${randomUUID()}`, { token });
    eq(missing.status, 404, '不存在的资料必须 404');
    eq(errorCodeOf(missing), 'NOT_FOUND', '不存在的资料必须是 NOT_FOUND');
    step4.actual(
      `200 ETag=${detail.etag}；6 字段 + source 与列表一致；库内 published revision=${knowledgeRows[0].revision}；不存在→404 NOT_FOUND`,
    );

    // ---- 5 收藏 -----------------------------------------------------------
    const favoriteBody = { target_ref: { type: 'species', id: hit.id, revision: detail.body.data.revision } };
    const step5 = record(
      '5 收藏',
      'POST/GET/DELETE /api/v1/favorites + PG 直查 + IDOR',
      '写入即可读；同目标幂等不产生第二行；取消后读空；属主正确；他人读不到删不掉',
    );
    const created = await request('POST', '/api/v1/favorites', {
      token,
      body: favoriteBody,
      headers: { 'idempotency-key': randomUUID() },
    });
    eq(created.status, 201, `收藏创建必须 201，实测 ${created.status}：${JSON.stringify(created.body)}`);
    const favoriteId = created.body.data.id;
    ok(/^[0-9a-f-]{36}$/.test(favoriteId), '收藏必须返回 uuid id');
    deepEq(created.body.data.target_ref, favoriteBody.target_ref, '收藏回显的 target_ref 必须与请求一致');
    const listed = await request('GET', '/api/v1/favorites', { token });
    eq(listed.status, 200, '收藏列表必须 200');
    eq(listed.cacheControl, 'no-store', '收藏列表必须 no-store');
    deepEq((listed.body.data.items ?? []).map((item) => item.id), [favoriteId], '写入后必须立刻可读');
    // PG 直查：行真的落库，且属主正确。
    const favoriteRows = (
      await owner.query(
        'SELECT id, owner_id, target_type, target_id, target_revision, revision FROM public.favorites WHERE id=$1::uuid',
        [favoriteId],
      )
    ).rows;
    eq(favoriteRows.length, 1, '收藏必须落库 1 行');
    eq(favoriteRows[0].owner_id, userId, '收藏属主必须是当前登录用户');
    eq(favoriteRows[0].target_type, 'species', '库内 target_type 必须一致');
    eq(favoriteRows[0].target_id, hit.id, '库内 target_id 必须是被收藏资料');
    eq(favoriteRows[0].target_revision, detail.body.data.revision, '库内 target_revision 必须是详情 revision');
    // 幂等：同目标再收藏一次（**换一个幂等键**，走 store 层 duplicate 分支）⇒ 同 id、库里仍 1 行。
    const again = await request('POST', '/api/v1/favorites', {
      token,
      body: favoriteBody,
      headers: { 'idempotency-key': randomUUID() },
    });
    eq(again.status, 201, '重复收藏必须稳定返回（201）');
    eq(again.body.data.id, favoriteId, '重复收藏必须返回同一个收藏 id（不产生第二行）');
    eq(
      (await owner.query('SELECT count(*)::int AS n FROM public.favorites WHERE owner_id=$1::uuid', [userId])).rows[0].n,
      1,
      '重复收藏后库里必须仍只有 1 行',
    );
    // IDOR：另一个用户读不到，也删不掉（404 与不存在同形）。
    const otherLogin = await request('POST', '/api/v1/auth/wechat', {
      body: { code: `intruder-${RUN_ID}` },
      headers: { 'idempotency-key': randomUUID() },
    });
    eq(otherLogin.status, 200, '第二个用户必须能登录');
    const otherToken = otherLogin.body.data.access_token;
    const otherList = await request('GET', '/api/v1/favorites', { token: otherToken });
    eq(otherList.status, 200, '另一用户列表必须 200');
    eq((otherList.body.data.items ?? []).length, 0, '另一用户必须读不到他人收藏（IDOR）');
    const stolenDelete = await request('DELETE', `/api/v1/favorites/${favoriteId}`, {
      token: otherToken,
      headers: { 'if-match': `"${favoriteRows[0].revision}"`, 'idempotency-key': randomUUID() },
    });
    eq(stolenDelete.status, 404, `另一用户删他人收藏必须 404，实测 ${stolenDelete.status}`);
    eq(errorCodeOf(stolenDelete), 'NOT_FOUND', '另一用户删他人收藏必须是 NOT_FOUND');
    eq(
      (await owner.query('SELECT count(*)::int AS n FROM public.favorites WHERE id=$1::uuid', [favoriteId])).rows[0].n,
      1,
      '越权删除失败后行必须还在',
    );
    // 取消：if-match 缺失必须 428，正确 revision 必须 200，之后读空、库里 0 行。
    const noMatch = await request('DELETE', `/api/v1/favorites/${favoriteId}`, {
      token,
      headers: { 'idempotency-key': randomUUID() },
    });
    eq(noMatch.status, 428, `缺 If-Match 必须 428，实测 ${noMatch.status}`);
    eq(errorCodeOf(noMatch), 'REVISION_REQUIRED', '缺 If-Match 必须是 REVISION_REQUIRED');
    const removed = await request('DELETE', `/api/v1/favorites/${favoriteId}`, {
      token,
      headers: { 'if-match': `"${favoriteRows[0].revision}"`, 'idempotency-key': randomUUID() },
    });
    eq(removed.status, 200, `取消收藏必须 200，实测 ${removed.status}：${JSON.stringify(removed.body)}`);
    eq(removed.body.data.accepted, true, '取消收藏必须 accepted=true');
    eq((await request('GET', '/api/v1/favorites', { token })).body.data.items.length, 0, '取消后列表必须读空');
    eq(
      (await owner.query('SELECT count(*)::int AS n FROM public.favorites WHERE id=$1::uuid', [favoriteId])).rows[0].n,
      0,
      '取消后库里必须 0 行',
    );
    // 再收藏一次，留给「退出不清收藏」这条断言。
    const recreate = await request('POST', '/api/v1/favorites', {
      token,
      body: favoriteBody,
      headers: { 'idempotency-key': randomUUID() },
    });
    eq(recreate.status, 201, '取消后可再次收藏');
    const keptId = recreate.body.data.id;
    ok(keptId !== undefined && keptId !== favoriteId, '再次收藏必须是一行新记录（旧行已取消）');
    step5.actual(
      `201 id=${favoriteId}；列表 1 条；PG 1 行属主=登录用户；重复收藏同 id→PG 仍 1 行；他人列表 0/删除 404 NOT_FOUND；缺 If-Match→428；取消→200 后 0 行；再收藏→${keptId}`,
    );

    // ---- 6 退出 -----------------------------------------------------------
    const step6 = record(
      '6 退出',
      'POST /api/v1/auth/logout → 同一令牌复验受保护接口（再补一次「不带上令牌」的对照）',
      '200 accepted；同一令牌立刻 401 SESSION_EXPIRED（凭据仍在、会话已失效）且各面同形；不带上令牌对照 401 SESSION_REQUIRED 同形；收藏行仍按属主保留',
    );
    const logout = await request('POST', '/api/v1/auth/logout', { token, headers: { 'idempotency-key': randomUUID() } });
    eq(logout.status, 200, `退出必须 200，实测 ${logout.status}：${JSON.stringify(logout.body)}`);
    eq(logout.body.data.accepted, true, '退出必须 accepted=true');
    const revokedRows = (await owner.query('SELECT revoked_at FROM public.sessions WHERE id=$1::uuid', [sessionId])).rows;
    eq(revokedRows.length, 1, '会话行必须存在');
    ok(revokedRows[0].revoked_at !== null, '退出后 sessions.revoked_at 必须写入');
    /*
     * 401 码口径（与仓内冻结语义一致，不是放宽）：
     *   - 不带凭据 ⇒ `SESSION_REQUIRED`（`services/api/src/auth/middleware.ts:53-60`）；
     *   - 带凭据但会话已撤销/已过期 ⇒ `SESSION_EXPIRED`（`services/api/src/auth/middleware.ts:74-80`）。
     * 已被 `tests/unit/auth-routes.test.mjs:211`（「退出登录：撤销当前会话后同一令牌立即失效（401 SESSION_EXPIRED）」）
     * 与 `tests/unit/gy-i22-session-inflight-cross-module.test.mjs:286`（「全部 16 个面一致 401 SESSION_EXPIRED」）固化。
     * 契约 `services/api/src/contract.ts:16` 亦把 401 定义为 `SESSION_REQUIRED` / `SESSION_EXPIRED` 两码。
     * ⇒ 退出后断言「令牌确实失效」＝ 401 + SESSION_EXPIRED 全face同形；再用「不带上令牌」对照证明两码可辨且封套同形。
     */
    const afterSession = await request('GET', '/api/v1/auth/session', { token });
    eq(afterSession.status, 401, `退出后同一令牌必须 401，实测 ${afterSession.status}`);
    eq(errorCodeOf(afterSession), 'SESSION_EXPIRED', '退出后同一令牌必须是 SESSION_EXPIRED（凭据仍在、会话已撤销）');
    const afterProtected = [
      ['/me/profile', await request('GET', '/api/v1/me/profile', { token })],
      ['/favorites', await request('GET', '/api/v1/favorites', { token })],
      ['/knowledge/{id}', await request('GET', `/api/v1/knowledge/${hit.id}`, { token })],
      ['/catalog/crops', await request('GET', '/api/v1/catalog/crops', { token })],
    ];
    for (const [name, response] of afterProtected) {
      eq(response.status, 401, `退出后 ${name} 必须 401，实测 ${response.status}`);
      eq(errorCodeOf(response), 'SESSION_EXPIRED', `退出后 ${name} 必须是 SESSION_EXPIRED`);
    }
    // 「同形」：所有受保护面回同一封套 / 同一错误码集合（不按路由泄漏细节）。
    const shapes = [afterSession, ...afterProtected.map(([, response]) => response)].map(errorShapeOf);
    eq(new Set(shapes.map((shape) => JSON.stringify(shape))).size, 1, `退出后各受保护面的 401 必须同形，实测 ${JSON.stringify(shapes)}`);
    // 对照：完全不带上令牌 ⇒ 401 SESSION_REQUIRED，且封套与上面**同形**（证明两码同族、可分辨）。
    const anonymous = [
      ['/auth/session', await request('GET', '/api/v1/auth/session', {})],
      ['/me/profile', await request('GET', '/api/v1/me/profile', {})],
      ['/favorites', await request('GET', '/api/v1/favorites', {})],
      ['/catalog/crops', await request('GET', '/api/v1/catalog/crops', {})],
    ];
    for (const [name, response] of anonymous) {
      eq(response.status, 401, `不带上令牌 ${name} 必须 401，实测 ${response.status}`);
      eq(errorCodeOf(response), 'SESSION_REQUIRED', `不带上令牌 ${name} 必须是 SESSION_REQUIRED`);
    }
    const anonymousShape = errorShapeOf(anonymous[0][1]);
    eq(JSON.stringify(anonymousShape), JSON.stringify(shapes[0]), `「未带凭据」与「会话已失效」的 401 封套必须同形，实测 ${JSON.stringify([shapes[0], anonymousShape])}`);
    // 收藏不被登出清掉：行仍在，且属主仍是原用户。
    const keptRows = (await owner.query('SELECT owner_id, target_id FROM public.favorites WHERE id=$1::uuid', [keptId])).rows;
    eq(keptRows.length, 1, '退出后收藏行必须仍在库里（不被登出清掉）');
    eq(keptRows[0].owner_id, userId, '退出后收藏属主必须不变');
    eq(keptRows[0].target_id, hit.id, '退出后收藏目标必须不变');
    step6.actual(
      '200 accepted；revoked_at 已写；/auth/session、/me/profile、/favorites、/knowledge/{id}、/catalog/crops 全 401 SESSION_EXPIRED 且封套同形；不带上令牌对照全 401 SESSION_REQUIRED 且封套同形；收藏行仍在且属主不变',
    );

    const elapsed = Date.now() - startedAt;
    console.log('\n步骤｜请求｜期望｜实测');
    for (const row of rows) console.log(`${row.step}｜${row.request}｜${row.expected}｜${row.actual}`);
    console.log(
      `\nPASS 用户链路端到端：${assertionCount} 条断言，${rows.length} 步，耗时 ${elapsed} ms（PostgreSQL ${serverVersion} / ${origin}）`,
    );
    return 0;
  } catch (error) {
    const elapsed = Date.now() - startedAt;
    console.log(`\nFAIL 用户链路端到端：${error?.message ?? error}（已跑 ${assertionCount} 条断言，${elapsed} ms）`);
    for (const row of rows) console.log(`${row.step}｜${row.request}｜${row.expected}｜${row.actual}`);
    if (existsSync(logFile)) {
      const log = readFileSync(logFile, 'utf8');
      if (log.trim() !== '') console.log(`\n--- postgres log (${logFile}) 末 25 行 ---\n${log.split('\n').slice(-25).join('\n')}`);
    }
    return 1;
  } finally {
    if (app !== null) await app.close().catch(() => {});
    if (pool !== null) await pool.end().catch(() => {});
    if (owner !== null) await owner.end().catch(() => {});
    if (clusterUp) {
      try {
        runDetached(pgTool(pgBin, 'pg_ctl'), ['-D', dataDir, '-m', 'fast', '-w', '-t', '60', 'stop']);
      } catch (error) {
        console.log(`[pg] 停止失败（需人工确认）：${error?.message ?? error}`);
      }
    }
    if (!keep) {
      try {
        removeTreeByEntry(dataDir);
        if (existsSync(logFile)) unlinkSync(logFile);
        console.log('[pg] 一次性集群已停止，数据目录已逐个文件删除');
      } catch (error) {
        console.log(`[pg] 数据目录清理失败（需人工确认）：${error?.message ?? error}`);
      }
    } else {
      console.log(`[pg] USER_CHAIN_PG_KEEP=1：保留 ${dataDir}`);
    }
  }
}

process.exitCode = await main();
