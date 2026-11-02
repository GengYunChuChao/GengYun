import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AdminCapabilityMapError,
  DOC_BEGIN,
  DOC_END,
  SOURCE_PATHS,
  VERDICTS,
  buildCapabilityMap,
  buildOperations,
  compareDocBlock,
  compareReadings,
  loadSources,
  normalizePathTemplate,
  parseAdminRoutes,
  parseDocBlock,
  parseRouteRegistrations,
  renderSummaryLine,
} from '../../tools/lib/admin-capability-map.mjs';

/**
 * R72「扫描面」用例（T1–T6）。
 *
 * 这一份**不复用** `admin-capability-map.test.mjs` 的任何辅助函数，也不复用 `parseAdminRoutes`
 * 当判据（T1 用第二套写法自己数一遍），目的只有一个：让「扫描面只读了 `admin.ts`」这种回归
 * 不可能靠同源自证混过去——R72 之前闸门全绿正是因为这个：能力图数 46 条（`admin.ts`），
 * 路由目录里 admin 面实际 49 条（多出的 3 条 auth 在 `admin-auth.ts`），契约 admin 面也是 49 条。
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCES = loadSources(REPO_ROOT);
const MAP = buildCapabilityMap(SOURCES);
const ROWS = MAP.rows;
const README_DIR = resolve(REPO_ROOT, 'docs/architecture');

function readRepoFile(relative) {
  return readFileSync(resolve(REPO_ROOT, relative), 'utf8');
}

function repoPathExists(relative) {
  return existsSync(resolve(REPO_ROOT, relative));
}

/** `services/api/src/routes/` 下的路由文件，按文件名排序（与工具自己的口径一致）。 */
function listRouteFiles() {
  const root = resolve(REPO_ROOT, SOURCE_PATHS.routesRoot);
  return readdirSync(root)
    .filter(name => name.endsWith('.ts'))
    .sort()
    .map(name => `${SOURCE_PATHS.routesRoot}/${name}`);
}

/**
 * T1 的第二套写法：不用工具的词法器、不做括号配平、不查 `families.ts`，
 * 只认「`app.<method>(` + 紧邻的字符串/模板字面量」这一条形状，再看字面量里有没有 `/admin` **路径段**。
 *
 * 独立性是这份用例的全部价值：它和 `parseAdminRoutes` 的实现没有任何共享代码，
 * 所以两边数出同一个数才有意义（同源自证会把「两边一起漏掉 3 条」判成绿）。
 */
const INDEPENDENT_REGISTRATION = /\bapp\s*\.\s*(get|post|put|patch|delete|head|options)\s*\(\s*(?:`[^`]*`|'[^']*'|"[^"]*")/g;

function independentAdminFaceRegistrations(text) {
  const registrations = [];
  let match = INDEPENDENT_REGISTRATION.exec(text);
  while (match !== null) {
    const statement = match[0];
    const quoteAt = statement.search(/[`'"]/);
    const body = statement.slice(quoteAt + 1, statement.length - 1);
    // `/admin` 必须是路径段：`/api/v1/administrators`（用户面）不算 admin 面。
    if (/\/admin(?:\/|$)/.test(body)) {
      registrations.push({
        method: match[1].toUpperCase(),
        path: body,
        line: text.slice(0, match.index).split('\n').length,
      });
    }
    match = INDEPENDENT_REGISTRATION.exec(text);
  }
  return registrations;
}

function rowOf(operationId) {
  const row = ROWS.find(candidate => candidate.operationId === operationId);
  assert.ok(row, `能力图里没有 ${operationId} 这一行`);
  return row;
}

function keyOf(method, path) {
  return `${String(method).toUpperCase()} ${normalizePathTemplate(path)}`;
}

// --- 夹具：T3 用合成源码证明「认不出就抛」，不靠真实树 ---------------------------------------

const FIXTURE_DEPENDENCIES = {
  familiesSource: SOURCES.familiesSource,
  opsScopeSource: SOURCES.opsScopeSource,
  scopeConstantSources: SOURCES.scopeConstantSources,
};

function buildFixtureOperations({ routes, contractOperations = [], file = 'services/api/src/routes/admin-widgets.ts' }) {
  return buildOperations({
    routeSources: [{ file, text: routes }],
    contractOperations,
    ...FIXTURE_DEPENDENCIES,
  });
}

/** 源码里没有 operationId 任何字面形态、契约里也没有这条 method+path。 */
const UNKNOWN_SHAPE_ROUTES = [
  'export function registerWidgetRoutes(app) {',
  '  app.get(`${API_PREFIX}/admin/widgets`, async () => ({ ok: true }));',
  '}',
  '',
].join('\n');

/** 派单里那条 `advanceReport` 的形状：注册处只写 `deps.ops.<id>`，operationId 只在契约里有一份。 */
const DEPS_OPS_ROUTES = [
  'export function registerReportRoutes(app, deps) {',
  "  app.post(`${API_PREFIX}/admin/reports/{id}/disposition`, { preHandler: [guards.requireAdmin, guards.requireScope('reports:write')] }, async (request) => {",
  '    return deps.ops.advanceReport.bind(deps.ops)(request.body);',
  '  });',
  '}',
  '',
].join('\n');

const PUBLIC_FALLBACK_ROUTES = [
  'export function registerAuthProbeRoutes(app) {',
  '  app.post(`${API_PREFIX}/admin/auth/probe`, async () => ({ ok: true }));',
  '}',
  '',
].join('\n');

const GUARDED_WITHOUT_SCOPE_ROUTES = [
  'export function registerGuardProbeRoutes(app, guards) {',
  '  app.post(`${API_PREFIX}/admin/auth/probe`, { preHandler: [guards.requireAdmin] }, async () => ({ ok: true }));',
  '}',
  '',
].join('\n');

const contractEntry = (id, method, path, scope) => ({ id, method, path, scope, version_required: 'v1' });

// --- T1 扫描面 -----------------------------------------------------------------------------

test('T1 扫描面是 routes 目录里全部 admin 面注册：独立第二套写法复算，不再只有 admin.ts', () => {
  const files = listRouteFiles();
  assert.ok(files.length >= 2, `routes 目录里应有多个路由文件，实际 ${files.length}`);

  const perFile = new Map(
    files.map(file => [file, independentAdminFaceRegistrations(readRepoFile(file))]),
  );
  const independentTotal = [...perFile.values()].reduce((sum, list) => sum + list.length, 0);
  const adminTsOnly = perFile.get(SOURCE_PATHS.adminRoutes);
  assert.ok(adminTsOnly, '独立写法没在 admin.ts 里数出注册，说明这套写法本身失效了');

  // ① 独立写法与工具的口径必须一致（同源自证的替代品）
  assert.equal(
    independentTotal,
    MAP.summary.totalOps,
    `独立写法数出 ${independentTotal} 条，能力图 ${MAP.summary.totalOps} 条`,
  );

  // ② 扫描面确实比单文件宽：admin.ts 之外的注册被数进来了
  assert.equal(adminTsOnly.length, 46, `admin.ts 里应是 46 条注册，实际 ${adminTsOnly.length}`);
  assert.deepEqual(
    parseAdminRoutes(SOURCES.adminSource, { file: SOURCE_PATHS.adminRoutes }).map(route => keyOf(route.method, route.path)),
    MAP.rows
      .filter(row => row.routeFile === SOURCE_PATHS.adminRoutes)
      .map(row => keyOf(row.method, row.path)),
    'admin.ts 单文件视图与能力图里落在 admin.ts 的行不一致',
  );
  assert.ok(
    independentTotal > adminTsOnly.length,
    `扫描面没有扩大：独立写法 ${independentTotal} 条 = admin.ts 单文件 ${adminTsOnly.length} 条`,
  );

  // ③ 有注册的文件集合 == 能力图里出现过的 routeFile 集合
  const filesWithRegistrations = [...perFile.entries()]
    .filter(([, list]) => list.length > 0)
    .map(([file]) => file)
    .sort();
  const filesInMap = [...new Set(ROWS.map(row => row.routeFile))].sort();
  assert.deepEqual(filesInMap, filesWithRegistrations, '能力图的 routeFile 集合与独立写法的命中文件对不上');

  // ④ 每一行的 routeFile:routeLine 都真指向一条 `app.<method>(` 注册
  for (const row of ROWS) {
    const line = readRepoFile(row.routeFile).split('\n')[row.routeLine - 1] ?? '';
    assert.match(
      line,
      new RegExp(`\\bapp\\s*\\.\\s*${row.method.toLowerCase()}\\s*\\(`),
      `${row.operationId} 的 routeLine 没指向注册语句：${row.routeFile}:${row.routeLine} → ${line.trim()}`,
    );
  }

  // ⑤ 被漏掉的那 3 条 auth 必须在能力图里，且都来自 admin-auth.ts
  const authOps = ['loginAdmin', 'getAdminSession', 'logoutAdmin'];
  for (const operationId of authOps) {
    assert.equal(rowOf(operationId).routeFile, 'services/api/src/routes/admin-auth.ts', operationId);
  }
  assert.deepEqual(
    ROWS.filter(row => row.routeFile === 'services/api/src/routes/admin-auth.ts').map(row => row.operationId).sort(),
    [...authOps].sort(),
  );
});

// --- T2 契约对齐 ---------------------------------------------------------------------------

test('T2 能力图与契约 admin 面逐条对齐（method+path 双向，不许多也不许少）', () => {
  const contractAdminOps = SOURCES.contractOperations
    .filter(entry => /\/admin(?:\/|$)/.test(entry.path))
    .map(entry => ({ operationId: entry.id, key: keyOf(entry.method, entry.path), scope: entry.scope }));

  const mapKeys = new Map(ROWS.map(row => [keyOf(row.method, row.path), row]));
  const contractKeys = new Map(contractAdminOps.map(entry => [entry.key, entry]));

  const missingInMap = [...contractKeys.keys()].filter(key => !mapKeys.has(key));
  const missingInContract = [...mapKeys.keys()].filter(key => !contractKeys.has(key));
  assert.deepEqual(missingInMap, [], `契约有、能力图没有的 admin 面：${missingInMap.join(', ')}`);
  assert.deepEqual(missingInContract, [], `能力图有、契约没有的 admin 面：${missingInContract.join(', ')}`);

  // 大小写不敏感：契约里写 `post`，路由里写 `app.post`，归一后是同一条
  assert.equal(contractKeys.size, contractAdminOps.length, '契约 admin 面里有重复的 method+path');
  assert.equal(MAP.summary.totalOps, contractKeys.size);

  // 逐条核对 operationId 与 scope（契约是 scope 的真相源：3 条 auth 全靠它）
  for (const [key, row] of mapKeys) {
    const entry = contractKeys.get(key);
    assert.equal(row.operationId, entry.operationId, `${key} 的 operationId 与契约不一致`);
    if (row.scope !== 'public') assert.equal(row.scope, entry.scope, `${key} 的 scope 与契约不一致`);
  }

  // 认不出 admin 面的危险就在这一侧：契约里 `/reports/{id}` 是**用户面**，不能混进来
  assert.ok(
    SOURCES.contractOperations.some(entry => entry.path === '/reports/{id}' && entry.id === 'getOwnReport'),
    '契约里应当有用户面的 getOwnReport（/reports/{id}）——这条不该被算进 admin 面',
  );
  assert.ok(!mapKeys.has('GET /reports/{id}'), '/reports/{id} 是用户面，不该出现在 admin 能力图里');
});

// --- T3 认不出就抛 -------------------------------------------------------------------------

test('T3 认不出的注册形状一律抛错并指名文件与行号（不给「静默计 0」留后门）', () => {
  // ① 没有家族槽位、没有 methodOf／deps.ops，契约里也查不到 ⇒ 抛，且点名 文件:行号（METHOD path）
  assert.throws(
    () => buildFixtureOperations({ routes: UNKNOWN_SHAPE_ROUTES }),
    error => {
      assert.ok(error instanceof AdminCapabilityMapError, `应当抛 AdminCapabilityMapError，实际 ${error}`);
      assert.match(error.message, /admin-widgets\.ts:2（GET \/admin\/widgets）/, error.message);
      assert.match(error.message, /既没有家族槽位调用、也没有 methodOf／deps\.ops 绑定/, error.message);
      assert.match(error.message, /认不出 operationId/, error.message);
      return true;
    },
  );

  // ② 派单里那条 `advanceReport` 的形状：`deps.ops.<id>` 认得出，但契约里没有这条 ⇒ 抛
  assert.throws(
    () => buildFixtureOperations({ routes: DEPS_OPS_ROUTES }),
    error => {
      assert.ok(error instanceof AdminCapabilityMapError);
      assert.match(error.message, /deps\.ops\.advanceReport/, error.message);
      assert.match(error.message, /契约里没有这条 admin 面 operation/, error.message);
      return true;
    },
  );

  // ③ 同一个形状，契约里有但 method+path 不符 ⇒ 抛（绑定与契约互相校验，不各说各话）
  assert.throws(
    () =>
      buildFixtureOperations({
        routes: DEPS_OPS_ROUTES,
        contractOperations: [contractEntry('advanceReport', 'POST', '/admin/reports/{id}/dismiss', 'reports:write')],
      }),
    error => {
      assert.ok(error instanceof AdminCapabilityMapError);
      assert.match(error.message, /契约里这条 operation 却是 POST \/admin\/reports\/\{id\}\/dismiss/, error.message);
      return true;
    },
  );

  // ④ 有 preHandler 却没有 requireScope，契约把 scope 写成非 public ⇒ 抛（不许猜 scope）
  assert.throws(
    () =>
      buildFixtureOperations({
        routes: GUARDED_WITHOUT_SCOPE_ROUTES,
        contractOperations: [contractEntry('loginAdminProbe', 'POST', '/admin/auth/probe', 'session:read')],
      }),
    error => {
      assert.ok(error instanceof AdminCapabilityMapError);
      assert.match(error.message, /有 preHandler 守卫却没有 requireScope/, error.message);
      return true;
    },
  );

  // ⑤ 完全无守卫、契约又把 scope 写成非 public ⇒ 抛（只有 public 允许无守卫注册）
  assert.throws(
    () =>
      buildFixtureOperations({
        routes: PUBLIC_FALLBACK_ROUTES,
        contractOperations: [contractEntry('loginAdminProbe', 'POST', '/admin/auth/probe', 'session:read')],
      }),
    error => {
      assert.ok(error instanceof AdminCapabilityMapError);
      assert.match(error.message, /只有 public 允许无守卫注册/, error.message);
      return true;
    },
  );

  // ⑥ 契约里同 method+path 命中多条 ⇒ 歧义，拒绝猜
  assert.throws(
    () =>
      buildFixtureOperations({
        routes: PUBLIC_FALLBACK_ROUTES,
        contractOperations: [
          contractEntry('firstProbe', 'POST', '/admin/auth/probe', 'public'),
          contractEntry('secondProbe', 'POST', '/admin/auth/probe', 'public'),
        ],
      }),
    error => {
      assert.ok(error instanceof AdminCapabilityMapError);
      assert.match(error.message, /歧义，拒绝猜/, error.message);
      return true;
    },
  );

  // ⑦ 反向的对照组：同样的注册，契约写明 `scope: public` ⇒ 认得出来（证明 ①②⑤ 的红不是「一律抛」）
  const accepted = buildFixtureOperations({
    routes: PUBLIC_FALLBACK_ROUTES,
    contractOperations: [contractEntry('loginAdminProbe', 'POST', '/admin/auth/probe', 'public')],
  });
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].operationId, 'loginAdminProbe');
  assert.equal(accepted[0].scope, 'public');

  // ⑧ 单个文件的 0 条注册**不**抛（`routes/support.ts` 就是这种辅助模块），但整个扫描面 0 条必须抛
  assert.deepEqual(
    parseRouteRegistrations('export function notARoute() {}\n', { file: 'services/api/src/routes/support.ts' }),
    [],
    '单文件 0 条注册不该抛错（目录里混着辅助模块是常态）',
  );
  assert.throws(
    () =>
      buildOperations({
        routeSources: [{ file: 'services/api/src/routes/support.ts', text: 'export function notARoute() {}\n' }],
        contractOperations: [contractEntry('loginAdminProbe', 'POST', '/admin/auth/probe', 'public')],
        ...FIXTURE_DEPENDENCIES,
      }),
    error => {
      assert.ok(error instanceof AdminCapabilityMapError);
      assert.match(error.message, /一条 admin 面注册都没认出来/, error.message);
      return true;
    },
  );
});

// --- T4 3 条 auth 的 UI 入口 ---------------------------------------------------------------

test('T4 3 条 auth op 都有入口视图，证据落在 apps/admin/src/auth/session.ts（不是「字面出现」）', () => {
  const expectations = new Map([
    ['loginAdmin', { method: 'POST', path: '/admin/auth/session', scope: 'public', fn: 'signInAdmin' }],
    ['getAdminSession', { method: 'GET', path: '/admin/auth/session', scope: 'session:read', fn: 'loadAdminSession' }],
    ['logoutAdmin', { method: 'POST', path: '/admin/auth/logout', scope: 'session:logout', fn: 'signOutAdmin' }],
  ]);

  const sessionFile = 'apps/admin/src/auth/session.ts';
  for (const [operationId, expected] of expectations) {
    const row = rowOf(operationId);
    assert.equal(row.method, expected.method, operationId);
    assert.equal(row.path, expected.path, operationId);
    assert.equal(row.scope, expected.scope, operationId);
    assert.equal(row.verdict, 'ui-entry', `${operationId} 的判词应当是 ui-entry`);
    assert.ok(VERDICTS.includes(row.verdict));
    assert.ok(row.uiEntryViews.length > 0, `${operationId} 没有任何入口视图：${row.uiEntryViews.join(', ')}`);
    assert.ok(
      row.evidenceFunctions.includes(expected.fn),
      `${operationId} 的 evidenceFunctions 里没有 ${expected.fn}：${row.evidenceFunctions.join(', ')}`,
    );
    assert.ok(row.uiFiles.includes(sessionFile), `${operationId} 的 uiFiles 里没有 ${sessionFile}`);
  }

  // 证据文件真存在，且真用 `API_BASE_URL` 前缀拼出这两条 URL（不是把路径抄在注释里）
  assert.ok(repoPathExists(sessionFile), `${sessionFile} 不存在`);
  const sessionText = readRepoFile(sessionFile);
  assert.match(sessionText, /export const API_BASE_URL/, `${sessionFile} 里没有 API_BASE_URL 常量`);
  for (const suffix of ['/admin/auth/session', '/admin/auth/logout']) {
    assert.ok(sessionText.includes(suffix), `${sessionFile} 里没有 ${suffix}`);
  }
  assert.match(sessionText, /`\$\{API_BASE_URL\}\/admin\/auth\/session`/, 'URL 模板没有把 API_BASE_URL 当常量前缀');

  // 这份客户端**不在** `lib/` 下，视图 import 它时又没有写扩展名：
  // 入口判据要是还按 `lib/` 目录限定、或只认全等 specifier，这 3 条就会变成假缺口。
  assert.ok(!sessionFile.includes('/lib/'), '这份客户端不应位于 lib/ 目录，否则本用例的意图失效');
  assert.equal(repoPathExists(sessionFile.replace(/\.ts$/, '')), false, '去掉扩展名的同名文件不该存在');
  const viewsImportingExtensionless = [...new Set(ROWS.flatMap(row => row.uiEntryViews))]
    .filter(view => readRepoFile(view).includes("from '../auth/session'"));
  assert.ok(
    viewsImportingExtensionless.length > 0,
    '没有视图用无扩展名的 `../auth/session` 引这份客户端——若真如此，扩展名解析那段就该删掉',
  );
});

// --- T5 白名单 -----------------------------------------------------------------------------

/**
 * 与 `admin-capability-map.test.mjs` 同语义的白名单判据：
 * ① 双向对拍（登记了但能力图没有 / 能力图没有入口但没登记）；
 * ② 登记进来的那一条必须真的零入口（不是「登记了就当它没有」）。
 */
function whitelistProblems({ whitelist, noUiEntryList, rows }) {
  const rowById = new Map(rows.map(row => [row.operationId, row]));
  const problems = [];
  for (const operationId of whitelist) {
    const row = rowById.get(operationId);
    if (!row) {
      problems.push(`登记了 ${operationId}，但能力图里没有这一行`);
      continue;
    }
    if (row.uiEntryViews.length > 0) {
      problems.push(`登记了 ${operationId}，但它有入口视图（${row.uiEntryViews.join(', ')}）`);
    }
    if (!noUiEntryList.includes(operationId)) {
      problems.push(`登记了 ${operationId}，但它不在 noUiEntryList 里`);
    }
  }
  for (const operationId of noUiEntryList) {
    if (!whitelist.includes(operationId)) {
      problems.push(`能力图里 ${operationId} 没有 UI 入口，但白名单没登记`);
    }
  }
  return problems;
}

/** 从既有单测源码里读白名单（独立读一遍，不 import 常量，免得两边一起改而无声）。 */
function readKnownNoUiEntry() {
  const text = readRepoFile('tests/unit/admin-capability-map.test.mjs');
  const match = /const KNOWN_NO_UI_ENTRY = \[([\s\S]*?)\];/.exec(text);
  assert.ok(match, 'tests/unit/admin-capability-map.test.mjs 里找不到 KNOWN_NO_UI_ENTRY 常量');
  return [...match[1].matchAll(/'([^']+)'/g)].map(entry => entry[1]);
}

test('T5 白名单与 noUiEntryList 双向相等；判据本身能红（本次未登记任何 op）', () => {
  const whitelist = readKnownNoUiEntry();
  const noUiEntryList = MAP.summary.noUiEntryList;

  assert.deepEqual(
    whitelist.slice().sort(),
    noUiEntryList.slice().sort(),
    `白名单 ${JSON.stringify(whitelist)} 与 noUiEntryList ${JSON.stringify(noUiEntryList)} 不一致`,
  );
  assert.deepEqual(whitelistProblems({ whitelist, noUiEntryList, rows: ROWS }), []);
  assert.equal(MAP.summary.noUiEntry, noUiEntryList.length);

  // 本树的事实：49 条全部有入口 ⇒ 白名单必须是空的。
  // 派单 §1.3 要求「白名单恰为 ['advanceReport']、noUiEntry=1」，但那条 admin 面路由
  // （`services/api/src/routes/admin-reports.ts`，`POST /admin/reports/{id}/disposition`）在本基座上
  // 不存在——它只在未合并分支 `feat/gy-r72-report-disposition` 上，契约里也没有这条 operation。
  // 这条用例因此钉的是**不变式**（三处同时不存在或同时存在），而不是某个具体名字：
  // 哪天 reports 路由真的合进来，这里会立刻红，要求把它登记进白名单或补 UI 入口。
  const hasReportsRoute = repoPathExists('services/api/src/routes/admin-reports.ts');
  const hasReportsContract = SOURCES.contractOperations.some(entry => /^\/admin\/reports(?:\/|$)/.test(entry.path));
  const hasReportsRow = ROWS.some(row => row.path.startsWith('/admin/reports'));
  assert.equal(hasReportsRoute, hasReportsContract, 'admin 面 reports 路由与契约条目必须同时存在或同时不存在');
  assert.equal(hasReportsContract, hasReportsRow, '契约里的 admin 面 reports 条目必须与能力图行同时出现');
  assert.deepEqual(
    whitelist,
    [],
    hasReportsRow
      ? '本条此时应登记 advanceReport 等真缺口，而不是留空'
      : '本树没有任何 admin 面 reports 注册，白名单就不该有名字',
  );

  // 判据本身的判别力（夹具）：这三种写法都必须红
  const rowsFixture = [
    { operationId: 'withEntry', uiEntryViews: ['apps/admin/src/views/SomeView.vue'] },
    { operationId: 'gapOp', uiEntryViews: [] },
  ];
  assert.deepEqual(
    whitelistProblems({ whitelist: ['gapOp'], noUiEntryList: ['gapOp'], rows: rowsFixture }),
    [],
    '对照：登记了真缺口应当无问题',
  );
  assert.match(
    whitelistProblems({ whitelist: [], noUiEntryList: ['gapOp'], rows: rowsFixture }).join('\n'),
    /没有 UI 入口，但白名单没登记/,
    '缺口没登记时判据必须报错',
  );
  assert.match(
    whitelistProblems({ whitelist: ['advanceReport'], noUiEntryList: [], rows: rowsFixture }).join('\n'),
    /能力图里没有这一行/,
    '登记了能力图里不存在的名字时判据必须报错',
  );
  assert.match(
    whitelistProblems({ whitelist: ['withEntry'], noUiEntryList: [], rows: rowsFixture }).join('\n'),
    /但它有入口视图/,
    '把有入口的 op 登记成缺口时判据必须报错',
  );
});

// --- T6 三处数字互洽 -----------------------------------------------------------------------

function numbersFromProse(text, pattern) {
  return [...text.matchAll(pattern)].map(match => Number(match[1]));
}

test('T6 散文 / 标记块 / 摘要行三处数字互洽（且散文里的机器读数只能是当前值）', () => {
  const summary = MAP.summary;
  const summaryLine = renderSummaryLine(MAP);

  // ① 摘要行
  const summaryNumbers = {
    totalOps: Number(/totalOps=(\d+)/.exec(summaryLine)?.[1]),
    withUiEntry: Number(/有入口=(\d+)/.exec(summaryLine)?.[1]),
    noUiEntry: Number(/无入口=(\d+)/.exec(summaryLine)?.[1]),
    deadButtons: Number(/死按钮=(\d+)/.exec(summaryLine)?.[1]),
  };
  assert.deepEqual(summaryNumbers, {
    totalOps: summary.totalOps,
    withUiEntry: summary.withUiEntry,
    noUiEntry: summary.noUiEntry,
    deadButtons: summary.deadButtons,
  });
  assert.match(summaryLine, new RegExp(`路径族 ${summary.families}`), summaryLine);
  assert.match(summaryLine, new RegExp(`入口视图 ${summary.uiEntryViews} 个`), summaryLine);

  // ② 标记块（整块逐字节 + 读数表逐项）
  const docText = SOURCES.docText;
  assert.equal(compareDocBlock(docText, MAP), null, '文档标记块与重算不一致（应当跑 --update）');
  const block = parseDocBlock(docText);
  assert.equal(block.found, true);
  assert.deepEqual(compareReadings(block.values, MAP), []);
  for (const key of ['totalOps', 'withUiEntry', 'noUiEntry', 'deadButtons', 'families']) {
    assert.equal(block.values.get(key), String(summary[key]), `块内 ${key} 与摘要不一致`);
  }

  // 标记块的引导句必须仍是一行，且写着新的扫描面（加行会顶空 docs/verification/** 的行号锚点）
  const lines = docText.split('\n');
  const beginLine = lines.indexOf(DOC_BEGIN);
  assert.ok(beginLine >= 0, '找不到标记块起始行');
  assert.match(lines[beginLine + 1], /services\/api\/src\/routes\/\*\.ts/, '引导句没写新的扫描面');
  assert.equal(lines[beginLine + 2], '', '引导句后面应当紧跟空行：引导句只占一行');
  assert.ok(docText.indexOf(DOC_END) > docText.indexOf(DOC_BEGIN));

  // ③ 散文：块内读数以外的机器读数只能是当前值（旧读数必须已经手改掉）
  //    唯一的豁免是**带历史标记的行**（`已过时`／`当时读数`／`旧读数`）：本页 §8 按仓规保留
  //    「说法（来源）｜本页复核结果」里的当期读数，那些数字是历史证据，不能改也不该判红。
  const endAt = docText.indexOf(DOC_END) + DOC_END.length;
  const prose = `${docText.slice(0, docText.indexOf(DOC_BEGIN))}\n${docText.slice(endAt)}`;
  const historicalLine = /已过时|当时读数|旧读数/;
  const proseReadings = new Map(Object.keys(summaryNumbers).map(key => [key, new Set()]));
  for (const line of prose.split('\n')) {
    if (historicalLine.test(line)) continue;
    for (const key of proseReadings.keys()) {
      for (const match of line.matchAll(new RegExp(`\`${key}=(\\d+)\``, 'g'))) {
        proseReadings.get(key).add(Number(match[1]));
      }
    }
  }
  for (const [key, value] of Object.entries(summaryNumbers)) {
    const seen = [...proseReadings.get(key)];
    assert.ok(seen.length > 0, `散文里没有任何 \`${key}=\` 的现行读数（改散文时把机器读数删掉了？）`);
    assert.deepEqual(seen, [value], `散文里的 ${key} 与重算不一致：${seen.join(', ')} vs ${value}`);
  }
  assert.ok(
    prose.includes(`${summary.totalOps} 条 admin 面注册路由，对应 ${summary.totalOps} 个 operationId`),
    '§0 表格里的注册路由条数没跟着重算走',
  );
  assert.ok(
    prose.includes(`${summary.totalOps} 个 operation 全部有 UI 入口（无入口 ${summary.noUiEntry} 条）`),
    '§0 表格里的「全部有 UI 入口」没跟着重算走',
  );
  assert.ok(
    prose.includes(`${summary.totalOps} 个 operationId、${summary.families} 个路径族`),
    '页首那段扫描面描述里的族数与 operation 数没跟着重算走',
  );
  assert.match(prose, new RegExp(`^## 1 服务端已挂的 admin 端点（${summary.totalOps} 条）$`, 'm'));
  assert.ok(
    prose.includes(`${summary.totalOps} 条服务端 operation 中，UI 有入口的 **${summary.withUiEntry}** 条`),
    '§2.3 的覆盖差集没跟着重算走',
  );
  assert.ok(
    prose.includes(`**${summary.totalOps} 条**（机器重算：\`totalOps=${summary.totalOps}\``),
    '§6 三档结论的「已可用」条数没跟着重算走',
  );

  // ④ 索引页（docs/architecture/README.md）同一组读数
  const readmeText = readFileSync(join(README_DIR, 'README.md'), 'utf8');
  assert.ok(
    readmeText.includes(
      `totalOps=${summary.totalOps}\`／\`withUiEntry=${summary.withUiEntry}\`／\`noUiEntry=${summary.noUiEntry}\`／\`deadButtons=${summary.deadButtons}`,
    ),
    'docs/architecture/README.md 的能力图那一行没跟着重算走',
  );
  for (const [key, value] of Object.entries(summaryNumbers)) {
    const seen = numbersFromProse(readmeText, new RegExp(`\`${key}=(\\d+)\``, 'g'));
    assert.deepEqual([...new Set(seen)], [value], `README 里的 ${key} 与重算不一致`);
  }
});
