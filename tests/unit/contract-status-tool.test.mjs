import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  scanMountedRoutes, mountedMismatches, runtimeMountedRoutes, evidenceWithinRepository,
  renderStatusTables, replaceStatusTables,
  routeDeclarations, declarationSegments, assertionArgumentRanges, operationMentions,
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
  for (const name of ['verify-contract-status.mjs', 'contract-status-core.mjs', 'contract-status-runtime.mjs', 'lib/anchor-resolve.mjs']) {
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

test('证据项指向真实存在的目录时必须受控失败（不得崩溃），改为常规文件后通过', t => {
  const { root, put } = fixture(t);
  for (const name of ['verify-contract-status.mjs', 'contract-status-core.mjs', 'contract-status-runtime.mjs', 'lib/anchor-resolve.mjs']) {
    put('tools/' + name, '');
    copyFileSync(join(ROOT, 'tools', name), join(root, 'tools', name));
  }
  const op = { id: 'getJob', method: 'get', path: '/jobs/{id}' };
  const fileEvidence = [{ path: 'services/api/src/app.ts', lines: '1-3' }];
  const status = {
    contract_version: 'test', operations: [{ ...op, route_mounted: true, status: 'partial', evidence: [{ path: 'services/api/src/jobs' }], blocker: '仅局部实现' }],
    dimensions: ['error_codes', 'pagination', 'versioning', 'idempotency', 'source_kind', 'execution_modes', 'cancel', 'timeout'].map(key => ({ key, title: key, status: 'partial', source_anchor: 'test', evidence: fileEvidence, blocker: 'test scope' })),
  };
  put('packages/contracts/operations.json', JSON.stringify({ contract_version: 'test', operations: [op] }));
  const save = () => put('docs/architecture/contract-status.json', JSON.stringify(status));
  save();
  const docPath = join(root, 'docs/architecture/contract-implementation-status.md');
  put('docs/architecture/contract-implementation-status.md', 'prefix\n' + renderStatusTables(status) + '\nsuffix');
  const run = (...flags) => spawnSync(process.execPath, [join(root, 'tools/verify-contract-status.mjs'), ...flags], { encoding: 'utf8' });
  // 靶心前提：夹具里的 services/api/src/jobs 是**真实存在的目录**，不是一个缺失路径。
  assert.equal(statSync(join(root, 'services/api/src/jobs')).isDirectory(), true);
  const before = readFileSync(docPath, 'utf8');
  const rejected = run('--write-doc');
  assert.equal(rejected.status, 1);
  assert.equal(rejected.signal, null);
  assert.match(rejected.stderr, /证据文件不存在或不是文件 services\/api\/src\/jobs/);
  assert.match(rejected.stderr, /FAIL: 契约实现状态对照校验未通过（1 项）/);
  // 崩溃泄漏守门：目录不得走成未捕获异常（旧版是 EISDIR 栈，退出码同样是 1）。
  assert.doesNotMatch(rejected.stderr + rejected.stdout, /EISDIR|node:fs:/);
  // 受控失败 ⇒ 中文对照表不得被改写。
  assert.equal(readFileSync(docPath, 'utf8'), before);
  // 正控制：同一位置改为指向真实常规文件 ⇒ 通过（证明上面的红来自"是目录"，不是夹具别处出错）。
  status.operations[0].evidence = fileEvidence;
  save();
  const accepted = run('--write-doc');
  assert.equal(accepted.status, 0);
  assert.match(accepted.stdout, /中文表格一致/);
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

test('实际 buildApp 注册清单与当前契约表一致；消息与社区均已接线', () => {
  const status = JSON.parse(readFileSync(join(ROOT, 'docs/architecture/contract-status.json')));
  const operations = JSON.parse(readFileSync(join(ROOT, 'packages/contracts/operations.json'))).operations;
  const mounted = runtimeMountedRoutes(ROOT, operations);
  assert.deepEqual(mountedMismatches(status.operations, mounted), []);
  assert.deepEqual([...mounted].sort(), [...scanMountedRoutes(ROOT).mounted].sort());
  for (const key of ['post /recognitions', 'post /ocr', 'post /speech/transcriptions', 'post /speech/synthesis']) assert.ok(mounted.has(key), key);
  // 已交付的后台、三个消息端点与 GY-I15 的 17 条社区端点必须装配。
  for (const key of ['get /admin/sources', 'get /messages', 'get /messages/unread-count', 'put /messages/{id}/read']) {
    assert.equal(mounted.has(key), true, key);
  }
  for (const key of ['get /posts', 'post /posts', 'get /posts/{id}', 'patch /posts/{id}', 'delete /posts/{id}',
    'get /posts/{id}/comments', 'post /posts/{id}/comments', 'get /comments/{id}', 'patch /comments/{id}',
    'delete /comments/{id}', 'get /posts/{id}/like', 'put /posts/{id}/like', 'delete /posts/{id}/like',
    'put /comments/{id}/like', 'delete /comments/{id}/like', 'post /reports', 'get /reports/{id}']) {
    assert.equal(mounted.has(key), true, key);
  }
  // `hidePost` 属 #18，仍由后台路由装配（不是社区路由）。
  assert.equal(mounted.has('post /admin/posts/{id}/hide'), true);
});

// —— evidence 语义校验：负控制（草稿 4 类变异，两臂各一）与正控制（真实台账两臂 PASS） ——
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const OCR_ROUTE_SOURCE = [
  'export function registerOcr(app) {',
  '  app.post(',
  '    `${API_PREFIX}/ocr`,',
  '    async request => {',
  '      const created = await ready().createOCR(actorOf(request));',
  '      return created;',
  '    },',
  '  );',
  '',
  '  app.get(',
  '    `${API_PREFIX}/ocr/:id`,',
  '    async request => {',
  '      const found = await ready().getOCR(actorOf(request));',
  '      return found;',
  '    },',
  '  );',
  '',
  '  app.delete(',
  '    `${API_PREFIX}/ocr/:id`,',
  '    async request => {',
  '      await ready().deleteOCR(actorOf(request));',
  '      return null;',
  '    },',
  '  );',
  '}',
].join('\n') + '\n';
const OCR_ASSERTION_SOURCE = "test('OCR 主流程', async () => {\n  assert.equal(created.status, 202, 'createOCR 契约规定 202');\n  assert.equal(deleted.status, 202, 'deleteOCR 契约规定 202');\n});\n";

function semanticFixture(t) {
  const { root, put } = fixture(t);
  for (const name of ['verify-contract-status.mjs', 'contract-status-core.mjs', 'contract-status-runtime.mjs', 'lib/anchor-resolve.mjs']) {
    put('tools/' + name, '');
    copyFileSync(join(ROOT, 'tools', name), join(root, 'tools', name));
  }
  // 只看 OCR 路由：清空夹具 app.ts，避免 jobs 路由被装配后与对照表不符。
  put('services/api/src/app.ts', '');
  put('services/api/src/routes/ocr.ts', OCR_ROUTE_SOURCE);
  put('tests/integration/ocr-http.mjs', OCR_ASSERTION_SOURCE);
  const evidence = [{ path: 'services/api/src/app.ts', lines: '1-1' }];
  const op = (id, method, path, items) => ({ id, method, path, route_mounted: false, status: 'partial', evidence: items, blocker: '仅局部实现' });
  const route = 'services/api/src/routes/ocr.ts';
  const docPath = join(root, 'docs/architecture/contract-implementation-status.md');
  const status = {
    contract_version: 'test',
    operations: [
      op('createOCR', 'post', '/ocr', [{ path: route, lines: '2-8' }, { test: 'tests/integration/ocr-http.mjs', name: 'createOCR 契约规定 202' }]),
      op('getOCR', 'get', '/ocr/{id}', [{ path: route, lines: '10-16' }]),
      op('deleteOCR', 'delete', '/ocr/{id}', [{ path: route, lines: '18-24' }]),
    ],
    dimensions: ['error_codes', 'pagination', 'versioning', 'idempotency', 'source_kind', 'execution_modes', 'cancel', 'timeout'].map(key => ({ key, title: key, status: 'partial', source_anchor: 'test', evidence, blocker: 'test scope' })),
  };
  put('packages/contracts/operations.json', JSON.stringify({
    contract_version: 'test',
    operations: status.operations.map(({ id, method, path }) => ({ id, method, path })),
  }));
  const save = () => put('docs/architecture/contract-status.json', JSON.stringify(status));
  // 渲染当前 status，保证「表格已同步」这个前提本身成立；漂移另有一条独立的失败路径。
  const setDoc = content => put('docs/architecture/contract-implementation-status.md', content);
  const syncDoc = (value = status) => {
    const content = 'prefix\n' + renderStatusTables(value) + '\nsuffix';
    setDoc(content);
    return content;
  };
  const run = (...flags) => spawnSync(process.execPath, [join(root, 'tools/verify-contract-status.mjs'), ...flags], { encoding: 'utf8' });
  save();
  const pristineDoc = syncDoc();
  return { status, save, syncDoc, setDoc, run, docPath, pristineDoc };
}

// 两臂都必须红：plain 直接拦；--write-doc 同样拦且不得写盘（否则错误区间会被固化进对照表）。
// 阶段 1 让表格保持同步，证明语义错误可以被独立看见；阶段 2 让表格陈旧，证明写盘被拒绝。
function assertSemanticFailure(t, expected) {
  const { status, save, syncDoc, setDoc, run, docPath, pristineDoc } = semanticFixture(t);
  expected.mutate(status);
  save();
  const syncedDoc = syncDoc();
  const plain = run();
  assert.equal(plain.status, 1, '表格已同步时语义错误仍必须让 plain 臂失败');
  assert.match(plain.stderr, expected.error);
  assert.match(plain.stderr, /形状错误 0 \/ 语义错误 \d+ \/ 表格漂移 0/);
  assert.doesNotMatch(plain.stdout, /中文表格一致/, '语义失败时不得输出表格一致');
  const syncedWrite = run('--write-doc');
  assert.equal(syncedWrite.status, 1, '--write-doc 不得把语义错误同步成通过');
  assert.equal(readFileSync(docPath, 'utf8'), syncedDoc);
  setDoc(pristineDoc);
  const before = sha256(docPath);
  const stalePlain = run();
  assert.equal(stalePlain.status, 1);
  assert.match(stalePlain.stderr, expected.error);
  assert.match(stalePlain.stderr, /形状错误 0 \/ 语义错误 \d+ \/ 表格漂移 1/, '语义错误与表格漂移分开计数，互不冒充');
  const write = run('--write-doc');
  assert.equal(write.status, 1, '--write-doc 不得把语义错误同步成通过');
  assert.match(write.stderr, expected.error);
  assert.match(write.stderr, /中文对照表与 JSON 不一致；因存在语义错误，--write-doc 未写盘/);
  assert.equal(sha256(docPath), before, '--write-doc 语义失败时不得写盘');
  assert.equal(readFileSync(docPath, 'utf8'), pristineDoc);
  assert.doesNotMatch(`${plain.stdout}${write.stdout}`, /中文表格一致/);
}

test('语义负控制：区间指向同文件另一操作的注册块，两臂都失败且不写盘', t => {
  assertSemanticFailure(t, {
    mutate: status => { status.operations.find(op => op.id === 'getOCR').evidence[0].lines = '2-8'; },
    error: /getOCR: services\/api\/src\/routes\/ocr\.ts:2-8 区间覆盖的是 post \/ocr 的注册块，与 get \/ocr\/\{id\} 不符/,
  });
});

test('语义负控制：两条操作区间互换，两臂都失败且不写盘', t => {
  assertSemanticFailure(t, {
    mutate: status => {
      const get = status.operations.find(op => op.id === 'getOCR');
      const del = status.operations.find(op => op.id === 'deleteOCR');
      [get.evidence[0].lines, del.evidence[0].lines] = [del.evidence[0].lines, get.evidence[0].lines];
    },
    error: /deleteOCR: services\/api\/src\/routes\/ocr\.ts:10-16 区间覆盖的是 get \/ocr\/\{id\} 的注册块，与 delete \/ocr\/\{id\} 不符/,
  });
});

test('语义负控制：区间放宽到整文件，两臂都失败且不写盘', t => {
  assertSemanticFailure(t, {
    mutate: status => { status.operations.find(op => op.id === 'getOCR').evidence[0].lines = '1-25'; },
    error: /getOCR: services\/api\/src\/routes\/ocr\.ts:1-25 区间等于整个文件，无法定位具体实现/,
  });
});

test('语义负控制：片段换成同文件另一操作的断言原文，两臂都失败且不写盘', t => {
  assertSemanticFailure(t, {
    mutate: status => { status.operations.find(op => op.id === 'getOCR').evidence.push({ test: 'tests/integration/ocr-http.mjs', name: 'deleteOCR 契约规定 202' }); },
    error: /getOCR: tests\/integration\/ocr-http\.mjs 片段「deleteOCR 契约规定 202」取自 deleteOCR 的断言，与 getOCR 不符/,
  });
});

// 区间只覆盖另一个操作的处理体（未覆盖整块）时，旧实现会当成「无法机械判定」而放行；
// 这是可证伪的错位（落在别人的注册块里），必须与「覆盖整块」同等判错。
test('语义负控制：区间落在另一操作的注册块内但未覆盖整块，两臂都失败且不写盘', t => {
  assertSemanticFailure(t, {
    mutate: status => { status.operations.find(op => op.id === 'createOCR').evidence[0].lines = '11-13'; },
    error: /createOCR: services\/api\/src\/routes\/ocr\.ts:11-13 区间落在 get \/ocr\/\{id\} 的注册块内，未覆盖任何本操作注册块，与 post \/ocr 不符/,
  });
});

// 跨块分支（covered.length >= 2）的看守：区间从 2 行起、完整覆盖两个注册块。
test('语义负控制：区间从上一操作起跨越两个注册块，两臂都失败且不写盘', t => {
  assertSemanticFailure(t, {
    mutate: status => { status.operations.find(op => op.id === 'getOCR').evidence[0].lines = '2-16'; },
    error: /getOCR: services\/api\/src\/routes\/ocr\.ts:2-16 区间跨越 2 个操作注册块（post \/ocr、get \/ocr\/\{id\}）/,
  });
});

test('语义正控制：夹具台账两臂通过，可核与不可核分开计数', t => {
  const { run, docPath } = semanticFixture(t);
  const plain = run();
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /形状错误 0 项；语义错误 0 项/);
  assert.match(plain.stdout, /语义可核 3 条区间 \+ 1 条片段；不可核 0 条区间 \+ 0 条片段/);
  assert.match(plain.stdout, /PASS: 中文表格一致/);
  const before = sha256(docPath);
  const write = run('--write-doc');
  assert.equal(write.status, 0, write.stderr);
  assert.equal(sha256(docPath), before);
  assert.doesNotMatch(write.stdout, /SYNC: /);
});

test('语义正控制：真实台账 plain 臂通过且零误报', () => {
  const result = spawnSync(process.execPath, [join(ROOT, 'tools/verify-contract-status.mjs')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /形状错误 0 项；语义错误 0 项/);
  assert.match(result.stdout, /语义可核 \d+ 条区间 \+ \d+ 条片段；不可核 \d+ 条区间 \+ \d+ 条片段/);
  assert.match(result.stdout, /PASS: 中文表格一致/);
});

test('语义正控制：真实台账 --write-doc 臂不改写文档', () => {
  const docPath = join(ROOT, 'docs/architecture/contract-implementation-status.md');
  const before = sha256(docPath);
  const result = spawnSync(process.execPath, [join(ROOT, 'tools/verify-contract-status.mjs'), '--write-doc'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(sha256(docPath), before);
  assert.doesNotMatch(result.stdout, /SYNC: /);
});

test('语义辅助：注册块归属、断言实参范围与操作 id 边界', () => {
  const declarations = routeDeclarations(OCR_ROUTE_SOURCE);
  assert.deepEqual(declarations.map(item => `${item.method} ${item.path} ${item.line}`), ['post /ocr 2', 'get /ocr/{id} 10', 'delete /ocr/{id} 18']);
  const segments = declarationSegments(OCR_ROUTE_SOURCE, declarations);
  assert.deepEqual(segments.map(segment => `${segment.from}-${segment.to} ${segment.routes.join('、')}`), [
    '2-8 post /ocr', '10-16 get /ocr/{id}', '18-25 delete /ocr/{id}',
  ]);
  const ranges = assertionArgumentRanges(OCR_ASSERTION_SOURCE);
  assert.equal(ranges.length, 2);
  const snippetAt = OCR_ASSERTION_SOURCE.indexOf('deleteOCR 契约规定 202');
  assert.ok(ranges.some(([start, end]) => start <= snippetAt && snippetAt < end));
  assert.equal(OCR_ASSERTION_SOURCE.slice(ranges[0][0], ranges[0][1] + 1).includes('createOCR 契约规定 202'), true);
  assert.deepEqual(operationMentions('deleteOCR 契约规定 202', ['createOCR', 'getOCR', 'deleteOCR', 'verifyOCR']), ['deleteOCR']);
  assert.deepEqual(operationMentions('verifyOcr 200', ['verifyOCR', 'getOCR']), ['verifyOCR']);
  assert.deepEqual(operationMentions('unlikePosts', ['likePosts']), []);
});

// ——— runtime 子进程预算（R34 同源第二处）———
// 断言只读「导出的默认预算 / 解析结果」，不做「跑一遍看多久」的计时断言：
// 实测冷启动 `contract-status-runtime.mjs` 单次要 13.566s，旧预算 15000ms 只剩 10% 余量，
// 机器被并发占用时 `spawnSync ... ETIMEDOUT` 就会把整片契约门禁一起打红。
// 用动态 import 而不是新增顶层 import 行：本文件被 `docs/**` 的行号锚点引用（195/381/389），
// 顶部多插一行会让 `node tools/verify-doc-anchors.mjs --strict` 判定锚点漂到空行。
const TIMEOUT_ENV='GY_CONTRACT_STATUS_TIMEOUT_MS';
const coreModule=()=>import('../../tools/contract-status-core.mjs');
const budgetFor=async value=>{
  const core=await coreModule();
  return core.runtimeTimeoutMs(value===undefined?{}:{[TIMEOUT_ENV]:value});
};

test('runtime 子进程默认预算 ≥ 60000ms', async () => {
  const core=await coreModule();
  assert.equal(typeof core.DEFAULT_RUNTIME_TIMEOUT_MS,'number','必须导出默认预算常量供断言');
  assert.ok(Number.isSafeInteger(core.DEFAULT_RUNTIME_TIMEOUT_MS));
  assert.ok(core.DEFAULT_RUNTIME_TIMEOUT_MS>=60000,
    `默认预算 ${core.DEFAULT_RUNTIME_TIMEOUT_MS}ms 低于 60000ms，冷启动 13.566s 只剩 10% 余量`);
  // 环境变量未设置（含空串）时解析结果就是默认值。
  assert.equal(await budgetFor(),core.DEFAULT_RUNTIME_TIMEOUT_MS);
  assert.equal(await budgetFor(''),core.DEFAULT_RUNTIME_TIMEOUT_MS);
});

test('GY_CONTRACT_STATUS_TIMEOUT_MS 覆盖生效，且调用点真的把解析结果交给子进程', async () => {
  assert.equal(await budgetFor('1234'),1234);
  assert.equal(await budgetFor(' 45000 '),45000);
  const source=readFileSync(join(ROOT,'tools/contract-status-core.mjs'),'utf8');
  // 接线断言：解析结果必须真的进 execFileSync，不能只导出一个没人用的常量。
  assert.match(source,/timeout:\s*runtimeTimeoutMs\(\)/,'runtimeMountedRoutes 必须用 runtimeTimeoutMs() 作为子进程预算');
  assert.doesNotMatch(source,/timeout:\s*15000\b/,'不得残留写死的 15000ms 子进程预算');
});

test('GY_CONTRACT_STATUS_TIMEOUT_MS 非法值回退默认：stderr 说明，不抛栈', async () => {
  const core=await coreModule();
  const notes=[];
  const write=process.stderr.write;
  process.stderr.write=chunk=>{notes.push(String(chunk));return true;};
  try{
    for(const value of ['abc','0','-5','1e3','12.5','0x10','60000ms','   ']){
      assert.equal(await budgetFor(value),core.DEFAULT_RUNTIME_TIMEOUT_MS,`非法值 ${JSON.stringify(value)} 必须回退默认`);
    }
  }finally{process.stderr.write=write;}
  const text=notes.join('');
  assert.match(text,/GY_CONTRACT_STATUS_TIMEOUT_MS/,'回退时必须在 stderr 说明是哪个变量');
  assert.doesNotMatch(text,/\n\s+at /,'非法值只需说明，不得抛异常栈');
});
