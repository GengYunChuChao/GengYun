import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  scanMountedRoutes, mountedMismatches, runtimeMountedRoutes, evidenceWithinRepository,
  renderStatusTables, replaceStatusTables,
} from '../../tools/contract-status-core.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
function fixture(t) {
  const parent = mkdtempSync(join(tmpdir(), 'gy-contract-status-'));
  t.after(() => {
    // Bound recursive cleanup to the temporary directory created by this test.
    assert.equal(dirname(resolve(parent)), resolve(tmpdir()));
    assert.ok(basename(parent).startsWith('gy-contract-status-'));
    rmSync(parent, { recursive: true, force: true });
  });
  const root = join(parent, 'repo');
  const put = (path, value) => {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, value);
  };
  put('services/api/src/app.ts', "import { registerJobs as registerProductJobs } from './jobs/routes.ts';\nimport { registerUnused } from './routes/unused.ts';\nregisterProductJobs(app);\n// registerUnused(app);\n/*\nregisterUnused(app);\n*/\n");
  put('services/api/src/jobs/routes.ts', "export function registerJobs(app) { app.get('/api/v1/jobs/:id', handler); }\n// app.post('/api/v1/comment-route', handler);\n");
  put('services/api/src/routes/unused.ts', "export function registerUnused(app) { app.post('/api/v1/unused', handler); }\n");
  put('services/api/src/routes/shadow.ts', "export function registerJobs(app) { app.get('/api/v1/shadow', handler); }\n");
  return { parent, root, put };
}

test('装配跟随具名导入/别名调用，支持 routes 目录外；注释和未导入文件不计装配', t => {
  const { root } = fixture(t);
  const inventory = scanMountedRoutes(root);
  assert.deepEqual([...inventory.mounted], ['get /jobs/{id}']);
  assert.deepEqual(inventory.unassembled.sort(), ['services/api/src/routes/shadow.ts', 'services/api/src/routes/unused.ts']);
  assert.equal(inventory.locations.get('get /jobs/{id}').path, 'services/api/src/jobs/routes.ts');
  assert.equal(mountedMismatches([{ method: 'get', path: '/jobs/{id}', route_mounted: false }], inventory.mounted).length, 1);
});

test('未知路由模板不能静默忽略为未装配', t => {
  const { root, put } = fixture(t);
  put('services/api/src/jobs/routes.ts', 'export function registerJobs(app) { app.get(`${API_PREFIX}/${unknown}`, handler); }');
  assert.throws(() => scanMountedRoutes(root), /Unresolved route template/);
});

test('证据不得读取仓库外、私有目录、环境文件或指向外部的 junction', t => {
  const { parent, root, put } = fixture(t);
  assert.equal(evidenceWithinRepository(root, 'services/api/src/app.ts'), true);
  for (const path of ['../outside.txt', '.local/private.json', '.supervisor/log.txt', 'node_modules/a.ts', '.ENV.local', '.git/config']) {
    assert.equal(evidenceWithinRepository(root, path), false, path);
  }
  const outside = join(parent, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'private.txt'), 'synthetic-private-content');
  put('public/placeholder.txt', '');
  symlinkSync(outside, join(root, 'public/link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(evidenceWithinRepository(root, 'public/link/private.txt'), false);
});

test('中文表格变旧会被发现，同步保留手写正文，不改变人工状态', () => {
  const status = { operations: [{ id: 'a', method: 'get', path: '/a', route_mounted: true, status: 'partial', evidence: [{ path: 'a.ts' }], blocker: '端口未接线' }], dimensions: [] };
  const original = 'prefix\n' + renderStatusTables(status) + '\nsuffix';
  assert.equal(replaceStatusTables(original, status), original);
  status.operations[0].route_mounted = false;
  status.operations[0].blocker = '服务已存在，HTTP 未装配';
  const updated = replaceStatusTables(original, status);
  assert.notEqual(updated, original);
  assert.ok(updated.startsWith('prefix\n'));
  assert.ok(updated.endsWith('\nsuffix'));
  assert.equal(status.operations[0].status, 'partial');
  assert.throws(() => replaceStatusTables('no markers', status), /唯一且成对/);
  assert.throws(() => replaceStatusTables(original + renderStatusTables(status), status), /唯一且成对/);
});

test('CLI 正例及反例：陈旧路由/文档失败，错误时不写表格，显式同步后通过', t => {
  const { root, put } = fixture(t);
  for (const name of ['verify-contract-status.mjs', 'contract-status-core.mjs', 'contract-status-runtime.mjs']) {
    put('tools/' + name, '');
    copyFileSync(join(ROOT, 'tools', name), join(root, 'tools', name));
  }
  const op = { id: 'getJob', method: 'get', path: '/jobs/{id}' };
  const evidence = [{ path: 'services/api/src/app.ts', lines: '1-3' }];
  const status = {
    contract_version: 'test', operations: [{ ...op, route_mounted: true, status: 'partial', evidence, blocker: '仅局部实现' }],
    dimensions: ['error_codes', 'pagination', 'versioning', 'idempotency', 'source_kind', 'execution_modes', 'cancel', 'timeout'].map(key => ({ key, title: key, status: 'partial', source_anchor: 'test', evidence, blocker: 'test scope' })),
  };
  put('packages/contracts/operations.json', JSON.stringify({ contract_version: 'test', operations: [op] }));
  const save = () => put('docs/architecture/contract-status.json', JSON.stringify(status));
  save();
  const docPath = join(root, 'docs/architecture/contract-implementation-status.md');
  put('docs/architecture/contract-implementation-status.md', 'prefix\n' + renderStatusTables(status) + '\nsuffix');
  const run = (...flags) => spawnSync(process.execPath, [join(root, 'tools/verify-contract-status.mjs'), ...flags], { encoding: 'utf8' });
  assert.equal(run().status, 0);
  const original = readFileSync(docPath, 'utf8');
  status.operations[0].route_mounted = false;
  save();
  const badRoute = run('--write-doc');
  assert.equal(badRoute.status, 1);
  assert.match(badRoute.stderr, /actual=true/);
  assert.equal(readFileSync(docPath, 'utf8'), original);
  status.operations[0].route_mounted = true;
  status.operations[0].blocker = '修订后的真实缺口';
  save();
  assert.match(run().stderr, /中文对照表与 JSON 不一致/);
  assert.equal(readFileSync(docPath, 'utf8'), original);
  assert.equal(run('--write-doc').status, 0);
  assert.equal(run().status, 0);
  const synchronized = readFileSync(docPath, 'utf8');
  status.operations[0].evidence = [{ path: 'services/api/src/app.ts', lines: '1-999999' }];
  save();
  assert.match(run('--write-doc').stderr, /越界/);
  assert.equal(readFileSync(docPath, 'utf8'), synchronized);
  put('tests/fixture.mjs', "test('existing case', () => {});");
  status.operations[0].evidence = [{ test: 'tests/fixture.mjs', name: 'nonexistent case' }];
  save();
  assert.match(run().stderr, /找不到用例名/);
  status.operations[0].evidence = [{ path: '../outside.txt' }];
  save();
  assert.match(run('--write-doc').stderr, /证据不在公开仓库源码范围内/);
  status.operations.push({ ...status.operations[0] });
  save();
  assert.match(run().stderr, /重复条目/);
});

test('运行时清除继承配置/凭据与 NODE_OPTIONS；实际注册与静态不一致时不会假通过', t => {
  const { root, parent, put } = fixture(t);
  put('services/api/src/app.ts', `export function buildApp() {
    for (const key of ['DATABASE_URL','RECOGNITION_PROVIDER_KEY','NODE_OPTIONS']) {
      if (process.env[key]) throw Error('inherited configuration');
    }
    return { ready: async () => {}, close: async () => {}, hasRoute: () => false };
  }`);
  put('services/api/src/config.ts', 'export function loadConfig(env) { if (env.APP_EXECUTION_MODE !== "stub") throw Error("not stub"); return {}; }');
  const preload = join(parent, 'poison.cjs');
  writeFileSync(preload, 'throw Error("inherited NODE_OPTIONS preload");');
  const names = ['DATABASE_URL', 'RECOGNITION_PROVIDER_KEY', 'NODE_OPTIONS'];
  const before = names.map(name => process.env[name]);
  try {
    process.env.DATABASE_URL = 'synthetic-not-a-database';
    process.env.RECOGNITION_PROVIDER_KEY = 'synthetic-not-a-credential';
    process.env.NODE_OPTIONS = '--require ' + JSON.stringify(preload);
    const declared = [{ method: 'get', path: '/jobs/{id}', route_mounted: true }];
    const actual = runtimeMountedRoutes(root, declared);
    assert.equal(actual.size, 0);
    assert.equal(mountedMismatches(declared, actual).length, 1);
  } finally {
    names.forEach((name, i) => { if (before[i] === undefined) delete process.env[name]; else process.env[name] = before[i]; });
  }
});

test('实际 buildApp 注册清单与当前契约表一致；未接 HTTP 的社区/消息/后台保持未注册', () => {
  const status = JSON.parse(readFileSync(join(ROOT, 'docs/architecture/contract-status.json')));
  const operations = JSON.parse(readFileSync(join(ROOT, 'packages/contracts/operations.json'))).operations;
  const mounted = runtimeMountedRoutes(ROOT, operations);
  assert.deepEqual(mountedMismatches(status.operations, mounted), []);
  assert.deepEqual([...mounted].sort(), [...scanMountedRoutes(ROOT).mounted].sort());
  for (const key of ['post /recognitions', 'post /ocr', 'post /speech/transcriptions', 'post /speech/synthesis']) assert.ok(mounted.has(key), key);
  // GY-I18 阶段 2（Refs #18）：原 `'get /admin/sources'` 负例已删除 —— 后台 34 条路由已装配
  // （`services/api/src/routes/admin.ts`），该期望被新事实推翻；`/admin/**` 现已**无**未装配的
  // 代表路由（37 条全部装配），故无法替换为其它 admin 负例。社区/消息的负例完整保留。
  for (const key of ['get /posts', 'get /messages']) assert.equal(mounted.has(key), false, key);
});
