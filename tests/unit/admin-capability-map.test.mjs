import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AdminCapabilityMapError,
  DEFAULT_FLOORS,
  DOC_BEGIN,
  DOC_END,
  assertNonVacuous,
  buildCapabilityMap,
  buildOperations,
  loadSources,
  parseAdminRoutes,
  parseDocBlock,
  renderSummaryLine,
} from '../../tools/lib/admin-capability-map.mjs';
import { main } from '../../tools/verify-admin-capability-map.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 工具读的八个入口（相对仓根）。负例只拷这些，避免整仓复制。 */
const SOURCE_PATHS = [
  'services/api/src/routes/admin.ts',
  'services/api/src/admin/families.ts',
  'services/api/src/admin/ops/service.ts',
  'services/api/src/admin/audit/catalog.ts',
  'services/api/src/admin/posts/service.ts',
  'packages/contracts/operations.json',
  'docs/architecture/admin-console-capability-map.md',
  'apps/admin/src',
];

/**
 * UI 侧真实缺口：**当前为空**。
 *
 * 2026-10-28 之前这里是 `['grantAdministratorScope', 'revokeAdministratorScope']`——两条授/撤权
 * 写面只有 operationId 常量、没有客户端函数，因此没有入口。GY-R68 把
 * `apps/admin/src/lib/administrator-scope-api.mjs` 与 `AdministratorsView.vue` 的调用链接上之后，
 * 46 条 operation 全部有入口。
 *
 * 这个常量是**断言**，不是注释：它和 `noUiEntryList` 双向对拍（多一条少一条都红）。
 * 清单清空不等于判据放宽——哪天有人把入口拆掉，这里必须先被显式改回来，闸门才会重新变绿。
 */
const KNOWN_NO_UI_ENTRY = [];

function makeTempTree(t) {
  const root = mkdtempSync(join(tmpdir(), 'capmap-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const relative of SOURCE_PATHS) {
    cpSync(join(REPO_ROOT, relative), join(root, relative), { recursive: true });
  }
  return root;
}

/** 跑 CLI 并收集输出（不 spawn 子进程：`main` 直接返回退出码）。 */
function runCli(argv) {
  const lines = [];
  const errors = [];
  const code = main(argv, {
    log: message => lines.push(String(message)),
    error: message => errors.push(String(message)),
  });
  return { code, stdout: lines.join('\n'), stderr: errors.join('\n') };
}

function editFile(root, relative, transform) {
  const path = join(root, relative);
  const original = readFileSync(path, 'utf8');
  const updated = transform(original);
  assert.notEqual(updated, original, `负例前提不成立：${relative} 没有被改动`);
  writeFileSync(path, updated, 'utf8');
}

function rowOf(map, operationId) {
  const row = map.rows.find(entry => entry.operationId === operationId);
  assert.ok(row, `能力图里没有 ${operationId}`);
  return row;
}

test('正向：入口判定是逐 operation 的，缺口清单与文档标记块双向对拍', () => {
  const map = buildCapabilityMap(loadSources(REPO_ROOT));
  const doc = readFileSync(join(REPO_ROOT, 'docs/architecture/admin-console-capability-map.md'), 'utf8');
  const block = parseDocBlock(doc);
  assert.equal(block.found, true, '文档里没有标记块');

  // ① 文档登记的无入口清单 == 重算的无入口清单（多一条少一条都红）
  const documented = block.values.get('noUiEntryList');
  const recomputed = map.summary.noUiEntryList.length === 0 ? '（空）' : map.summary.noUiEntryList.join(', ');
  assert.equal(documented, recomputed, '文档登记的 noUiEntryList 与重算不一致');
  assert.equal(block.values.get('noUiEntry'), String(map.summary.noUiEntry));
  assert.equal(block.values.get('withUiEntry'), String(map.summary.withUiEntry));

  // ② 真实缺口就是那两条（不是族级统计的副作用）
  assert.deepEqual([...map.summary.noUiEntryList].sort(), [...KNOWN_NO_UI_ENTRY].sort());
  assert.equal(map.summary.withUiEntry, map.summary.totalOps - KNOWN_NO_UI_ENTRY.length);
  assert.equal(map.summary.deadButtons, 0, `死按钮：${map.summary.deadButtonList.join(', ')}`);

  // ③ 每条 operation 的裁决与入口视图必须自洽
  for (const row of map.rows) {
    assert.ok(['ui-entry', 'no-ui-entry', 'dead-button'].includes(row.verdict), `未知 verdict：${row.verdict}`);
    assert.equal(typeof row.scope, 'string');
    assert.ok(row.scope.length > 0, `${row.operationId} 的 scope 解析成空串`);
    assert.ok(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(row.method), `${row.operationId} 方法异常：${row.method}`);
    assert.ok(row.path.startsWith('/admin/'), `${row.operationId} 路径异常：${row.path}`);
    if (row.verdict === 'ui-entry') {
      assert.ok(row.uiEntryViews.length > 0, `${row.operationId} 判成有入口，却没有任何入口视图`);
      assert.ok(row.evidenceFunctions.length > 0, `${row.operationId} 判成有入口，却没有任何 path 证据函数`);
    } else {
      assert.deepEqual(row.uiEntryViews, [], `${row.operationId} 判成无入口，却挂着入口视图`);
    }
  }
});

test('正向：入口归属到具体视图，不同 operation 落在各自该在的视图上', () => {
  const map = buildCapabilityMap(loadSources(REPO_ROOT));

  // posts 族 5 条并非同一个视图：hidePost 在 PostTakedownView，其余 4 条在 ModerationQueueView。
  // 族级判定会把 5 条算成同一个集合 —— 这条断言就是「逐 operation」与「逐族」的分水岭。
  assert.deepEqual(rowOf(map, 'hidePost').uiEntryViews, ['apps/admin/src/views/PostTakedownView.vue']);
  for (const operationId of ['listAdminPosts', 'getAdminPost', 'approvePost', 'rejectPost']) {
    assert.deepEqual(rowOf(map, operationId).uiEntryViews, ['apps/admin/src/views/ModerationQueueView.vue'], operationId);
  }

  // 内容四族的入口必须包含各自的视图；`ContentAdminView` 只是 tab 容器，不该出现在入口集合里。
  // 集合可以多成员：`apps/admin/src/views/KnowledgeAdminView.vue:218` 真的调了 `listSources`
  // （来源选择器），所以它同时是 `listAdminSources` 的入口——这是真实调用，不是串味。
  const contentExpectations = [
    ['listAdminRegistration', 'apps/admin/src/views/RegistrationAdminView.vue'],
    ['listAdminRestriction', 'apps/admin/src/views/RestrictionAdminView.vue'],
    ['listAdminSources', 'apps/admin/src/views/SourcesView.vue'],
    ['listAdminKnowledge', 'apps/admin/src/views/KnowledgeAdminView.vue'],
  ];
  for (const [operationId, view] of contentExpectations) {
    const views = rowOf(map, operationId).uiEntryViews;
    assert.ok(views.includes(view), `${operationId} 的入口里没有 ${view}：${views.join(', ')}`);
    assert.ok(!views.includes('apps/admin/src/views/ContentAdminView.vue'), `${operationId} 把 tab 容器当成了入口`);
  }

  // 真缺口的行没有任何入口视图
  for (const operationId of KNOWN_NO_UI_ENTRY) {
    assert.deepEqual(rowOf(map, operationId).uiEntryViews, [], operationId);
  }
});

test('正向：文档标记块与重算一致（--check 绿）', () => {
  const result = runCli(['--check']);
  assert.equal(result.code, 0, `--check 应为 0，实际 ${result.code}：${result.stderr}`);
  assert.match(result.stdout, /totalOps=\d+/, '汇总行没打印出来');
});

test('反空转：解析面必须过下界，否则拒绝判绿', () => {
  const map = buildCapabilityMap(loadSources(REPO_ROOT));
  assertNonVacuous(map); // 真实树过下界
  assert.ok(map.summary.totalOps >= DEFAULT_FLOORS.totalOps);
  assert.ok(map.summary.uiRefFiles >= DEFAULT_FLOORS.uiRefFiles);
  assert.ok(map.summary.uiEntryViews >= DEFAULT_FLOORS.uiEntryViews);
  assert.ok(map.summary.operationsWithEvidence >= DEFAULT_FLOORS.operationsWithEvidence);

  // 把 UI 面挖空 ⇒ 必须抛错，而不是「两边都是 0 ⇒ 相等 ⇒ 绿」
  const scrubbed = buildCapabilityMap({ ...loadSources(REPO_ROOT), ui: [] });
  assert.equal(scrubbed.summary.uiRefFiles, 0);
  assert.equal(scrubbed.summary.withUiEntry, 0);
  assert.throws(() => assertNonVacuous(scrubbed), AdminCapabilityMapError);
});

test('反空转：解析不出来的路由必须抛错，不许静默返回空集合', () => {
  const prefix = 'export function registerAdminRoutes(app, guards) {\n';
  // 用 String.fromCharCode 拼反引号与 `${`，避免测试文件自身的模板转义把样例改样
  const tick = String.fromCharCode(96);
  const open = `${String.fromCharCode(36)}{`;
  const unresolved = `${prefix}  app.get(${tick}${open}MYSTERY}/admin/x${tick}, { preHandler: [guards.requireScope('a:read')] }, async () => {});\n}\n`;
  assert.throws(() => parseAdminRoutes(unresolved), AdminCapabilityMapError);

  const noScope = `${prefix}  const ghost = methodOf(services.ops, 'ghostOp');\n  app.get(${tick}${open}API_PREFIX}/admin/ghost${tick}, { preHandler: [guards.requireAdmin, guards.requireScope(OPS_SCOPES.ghostOp)] }, async (request, reply) => send(reply, await ghost(callerOf(request))), );\n}\n`;
  const real = loadSources(REPO_ROOT);
  assert.throws(
    () =>
      buildOperations({
        adminSource: noScope,
        familiesSource: real.familiesSource,
        opsScopeSource: real.opsScopeSource,
        scopeConstantSources: real.scopeConstantSources,
      }),
    AdminCapabilityMapError,
  );
});

test('负例一：删掉注册资料的视图与挂载 ⇒ --check 变红并点名 listAdminRegistration', t => {
  const root = makeTempTree(t);
  // 删视图文件本身 + 从 ContentAdminView 摘掉挂载：注册族就不再有任何入口
  rmSync(join(root, 'apps/admin/src/views/RegistrationAdminView.vue'), { force: true });
  editFile(root, 'apps/admin/src/views/ContentAdminView.vue', text => text.replace(/^.*<RegistrationAdminView\b.*\n/m, ''));

  const result = runCli(['--check', '--root', root]);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.code, 1, `删掉入口后 --check 应为 1，实际 ${result.code}\n${output}`);
  assert.match(output, /listAdminRegistration/, '红报告没有点名受影响的 operation');
  assert.match(output, /文档写 .*重算/, '红报告没有给出「文档写 X，重算 Y」');
});

test('负例二：改文档标记块里的数字 ⇒ --check 变红并给出「文档写 X，重算 Y」', t => {
  const root = makeTempTree(t);
  editFile(root, 'docs/architecture/admin-console-capability-map.md', doc => {
    const actual = parseDocBlock(doc).values.get('totalOps');
    assert.ok(actual, '标记块里没有 totalOps');
    return doc.replace(new RegExp(`\\| totalOps \\| ${actual} \\|`), '| totalOps | 42 |');
  });

  const result = runCli(['--check', '--root', root]);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.code, 1);
  assert.match(output, /文档写 42，重算 46/, output);
});

test('负例三：标记块缺失 ⇒ --check 变红（不许默默放过）', t => {
  const root = makeTempTree(t);
  editFile(root, 'docs/architecture/admin-console-capability-map.md', doc => {
    assert.ok(doc.includes(DOC_BEGIN) && doc.includes(DOC_END), '负例前提不成立：文档里没有标记块');
    return doc.replace(DOC_BEGIN, '').replace(DOC_END, '');
  });

  const result = runCli(['--check', '--root', root]);
  assert.equal(result.code, 1);
  assert.match(`${result.stdout}\n${result.stderr}`, /标记块/);
});

test('负例四（判别力）：删掉 posts 族的真入口视图 ⇒ 变红，且只损失被删的那 4 条', t => {
  const root = makeTempTree(t);
  rmSync(join(root, 'apps/admin/src/views/ModerationQueueView.vue'), { force: true });
  editFile(root, 'apps/admin/src/App.vue', text => text.replace(/^.*<ModerationQueueView\b.*\n/m, ''));

  const result = runCli(['--check', '--root', root]);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.code, 1, `--check 应为 1\n${output}`);
  for (const operationId of ['listAdminPosts', 'getAdminPost', 'approvePost', 'rejectPost']) {
    assert.match(output, new RegExp(operationId), `红报告没有点名 ${operationId}`);
  }
  // hidePost 仍在 PostTakedownView 上，不该被牵连
  assert.doesNotMatch(output, /hidePost/, 'hidePost 有独立入口，不该出现在缺口清单里');
});

test('负例五（可达性）：摘掉 App.vue 的挂载行 ⇒ 变红并点名不可达视图', t => {
  const root = makeTempTree(t);
  editFile(root, 'apps/admin/src/App.vue', text => text.replace(/^.*<AuditLogsView\b.*\n/m, ''));

  const result = runCli(['--check', '--root', root]);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.code, 1, `--check 应为 1\n${output}`);
  assert.match(output, /listAuditLogs/, '红报告没有点名丢入口的 operation');
  assert.match(output, /unreachableViews/, '红报告没有报不可达视图');
});

test('负例六（反假阳性）：只 import 不调用的「路径证据函数」不得造出入口', t => {
  const root = makeTempTree(t);
  // 注入位置：必须选**已经**引用过 posts 族的 lib（`post-takedown-api.mjs`）。
  // 若塞进新文件（或此前不引用 posts 的 `flags-api.mjs`），posts 族的「引用文件数」单元格
  // 会从 3 变 4 —— 那是重算值真的变了，整块比对判红是**正确**的，与本例要测的
  // 「import 了但从不调用 ⇒ 不造出入口」是两件事，混在一起会让负例失去判别力。
  editFile(root, 'apps/admin/src/lib/post-takedown-api.mjs', text => `${text}
export const POSTS_FAMILY_PREFIX = '/admin/posts';

/** 假入口：只为骗过扫描器而存在，视图从不调用。 */
export function sneakyPostDetail(baseUrl, id) {
  return { url: \`\${baseUrl}\${POSTS_FAMILY_PREFIX}/\${id}\`, method: 'GET' };
}
`);
  editFile(root, 'apps/admin/src/views/FlagsView.vue', text =>
    text.replace('</script>', "import { sneakyPostDetail } from '../lib/post-takedown-api.mjs';\n</script>"),
  );

  const result = runCli(['--check', '--root', root]);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.code, 0, `伪造的证据函数不该改变裁决，却红了：\n${output}`);
});

test('负例七（反假阳性）：把 POSTS_PATH 拆成 ADMIN_ROOT_PATH + 模板拼接，读数不得变', t => {
  const root = makeTempTree(t);
  editFile(root, 'apps/admin/src/lib/post-takedown-api.mjs', text => {
    const before = "export const POSTS_PATH = '/admin/posts';";
    assert.ok(text.includes(before), '负例前提不成立：找不到 POSTS_PATH 声明');
    return text.replace(before, "export const ADMIN_ROOT_PATH = '/admin';\nexport const POSTS_PATH = `${ADMIN_ROOT_PATH}/posts`;");
  });

  const result = runCli(['--check', '--root', root]);
  assert.equal(result.code, 0, `纯改名/拆常量重构不该让闸门变红：\n${result.stdout}\n${result.stderr}`);
});

test('负例八（整块比对）：删掉逐 operation / 族表的一整行 ⇒ --check 必须变红并指出第一处差异', t => {
  const root = makeTempTree(t);
  editFile(root, 'docs/architecture/admin-console-capability-map.md', doc => {
    assert.ok(
      doc.includes('| administrators | /admin/administrators | 6 |'),
      '负例前提不成立：族表里没有 administrators 那一行',
    );
    // 读数表一行不动 —— 只删下表的一行：这正是「只比读数」时漏掉的假绿通道。
    // （逐 operation 表在 R68 之后是空的：46 条全部有入口，所以这里改删族表一行。）
    return doc.replace(/^\| administrators \|.*\n/m, '');
  });

  const result = runCli(['--check', '--root', root]);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.code, 1, `删掉族表一行后 --check 应为 1（整块比对），实际 ${result.code}\n${output}`);
  assert.match(output, /整块与重算不一致/, '红报告没有说明这是整块比对失败');
  assert.match(output, /第一处差异在 .*admin-console-capability-map\.md:\d+/, '红报告没有给出文档行号');
  assert.match(output, /重算：.*\| administrators \| \/admin\/administrators \| 6 \|/, '红报告没有贴出重算侧原文');
  assert.match(output, /文档：.*\| audit-events \|/, '红报告没有贴出文档侧原文');
});

/**
 * M2b 的注入素材：一条**携带真实 method+path 证据**的 client 函数。
 *
 * 与「负例六」的关键差别：`sneakyPostDetail` 的路径段 `id` 不是模块字面量，
 * `operationsForEvidence()` 会把它当可疑通配段整条丢掉——于是那条假入口在更早的分支
 * 就被筛掉，根本走不到 `if (!called) continue;`（≈ `tools/lib/admin-capability-map.mjs:1604`）
 * 这一步。这里复用 `admin-administrators.mjs` 里**已经成立**的证据形态
 * （`${ADMINISTRATORS_PATH}/${id}/scopes` ⇒ `/admin/administrators/{id}/scopes`），
 * 只把方法换成 POST，于是这条函数确实背书 `grantAdministratorScope`。
 *
 * 注入点刻意选 `admin-administrators.mjs`（该文件本来就有 admin 路径证据）：`uiRefFiles`
 * 不变，用例里的差异就只剩「有没有真的调用」这一件事。
 */
const PROBE_ENTRY_FUNCTION = 'grantScopeEntryProbe';
const PROBE_ENTRY_LIB = 'apps/admin/src/lib/admin-administrators.mjs';
const PROBE_ENTRY_VIEW = 'apps/admin/src/views/AdministratorsView.vue';

/**
 * 把真实视图里的授/撤权**调用**抹掉（import 与函数体都留着，只把调用点换成等价占位）。
 *
 * 作用：造一个**已知缺口**给「负例九／十」用。R68 之后真实树里 46 条 operation 全部有入口，
 * 这两条守卫如果还指着真实树，`base.summary.noUiEntryList.includes(gap)` 就不成立、
 * 前提断言会直接红 —— 但判据本身（光 import 不算入口 / 真调用才算）仍必须被钉住。
 * 所以改成「先人造缺口，再在同一个副本上做 import-only / called 的对照」，
 * 两次 map 的差异仍然只剩「有没有真的调用」这一件事。
 */
function sourcesWithoutRealScopeWriteCalls() {
  const sources = loadSources(REPO_ROOT);
  let stripped = 0;
  const ui = sources.ui.map(file => {
    if (file.path !== PROBE_ENTRY_VIEW) return file;
    const text = file.text
      .replace(/\bgrantAdministratorScope\(request\)/g, () => {
        stripped += 1;
        return 'Promise.resolve(request)';
      })
      .replace(/\brevokeAdministratorScope\(request\)/g, () => {
        stripped += 1;
        return 'Promise.resolve(request)';
      });
    return { ...file, text };
  });
  assert.equal(stripped, 2, `造缺口失败：${PROBE_ENTRY_VIEW} 里应有两处真实调用（授、撤各一处），实际抹掉 ${stripped} 处`);
  return { ...sources, ui };
}

/**
 * 在真实树的内存副本上注入「带证据的 client 函数」，并让可达视图
 * `AdministratorsView.vue` import 它；`callStatement` 决定视图**是否真的调用**。
 * 返回完整的 sources（`buildCapabilityMap` 直接吃），不落盘、不动 `docs/**`。
 */
function sourcesWithEvidenceCarryingProbe(callStatement, base = loadSources(REPO_ROOT)) {
  const sources = base;
  // 反引号与 `${` 用 fromCharCode 拼，避免测试文件自身的模板转义把被注入的样例改样
  const tick = String.fromCharCode(96);
  const open = `${String.fromCharCode(36)}{`;
  const probe = [
    '',
    '/** 假入口：携带 grantAdministratorScope 的 method + path 证据，视图只 import 不调用。 */',
    `export async function ${PROBE_ENTRY_FUNCTION}(probeArgs = {}) {`,
    '  const doFetch = resolveFetch(probeArgs.fetchImpl);',
    `  const requestUrl = ${tick}${open}normalizeBaseUrl(probeArgs.baseUrl)}${open}ADMINISTRATORS_PATH}/${open}probeArgs.id}/scopes${tick};`,
    "  return doFetch(requestUrl, { method: 'POST', headers: authHeaders(probeArgs.token), credentials: 'omit' });",
    '}',
    '',
  ].join('\n');

  const ui = sources.ui.map(file => {
    if (file.path === PROBE_ENTRY_LIB) return { ...file, text: `${file.text}\n${probe}` };
    if (file.path === PROBE_ENTRY_VIEW) {
      assert.ok(file.text.includes('</script>'), `注入前提不成立：${PROBE_ENTRY_VIEW} 里没有 </script>`);
      const injected = `import { ${PROBE_ENTRY_FUNCTION} } from '../lib/admin-administrators.mjs';\n${callStatement}`;
      return { ...file, text: file.text.replace('</script>', `${injected}\n</script>`) };
    }
    return file;
  });
  return { ...sources, ui };
}

test('负例九（M2b 守卫）：携带真实证据的 client 函数只 import 不调用 ⇒ 该 operation 仍无 UI 入口', () => {
  // 真实树已经 46/46 全有入口（R68 补上了授/撤权入口），先在内存副本里抹掉真实调用造出**已知缺口**，
  // 否则下面的「前提」断言本身就不成立、这条守卫会失去判别力。
  const gapped = sourcesWithoutRealScopeWriteCalls();
  const base = buildCapabilityMap(gapped);
  const gap = 'grantAdministratorScope';
  assert.ok(base.summary.noUiEntryList.includes(gap), `前提不成立：抹掉调用后 ${gap} 仍判有入口，本守卫失去判别力`);

  const map = buildCapabilityMap(sourcesWithEvidenceCarryingProbe('', gapped));
  const row = rowOf(map, gap);

  // ① 证据确实被认到了这条 operation 上：证明本用例走得到「有没有被调用」那个分支
  //    （注入的函数若在 operationsForEvidence() 就被筛掉，下面的断言就变成了空转）。
  assert.ok(
    row.evidenceFunctions.includes(PROBE_ENTRY_FUNCTION),
    `${PROBE_ENTRY_FUNCTION} 没有落在 ${gap} 的路径证据上，本用例会退化成无效守卫：${row.evidenceFunctions.join(', ')}`,
  );
  assert.equal(
    row.evidenceFunctions.length,
    rowOf(base, gap).evidenceFunctions.length + 1,
    '注入的函数没有被算成这条 operation 的路径证据（operation 级计数按「是否已有证据函数」算，注入前这条本来就有真实证据）',
  );

  // ①b 全局证据计数不许动：注入的函数落在一条**本来就有证据**的 operation 上，
  //     所以 `operationsWithEvidence` 应该原地不动。若它跟着 +1，说明这条判据是按
  //     「证据函数条数」在累加、而不是按「这条 operation 有没有证据」——那样「光 import 不算入口」
  //     与「真调用才算入口」两条守卫会同时失去判别力（R68 对抗审查 N3：计数必须落在本行，不能落在全局）。
  assert.equal(
    map.summary.operationsWithEvidence,
    base.summary.operationsWithEvidence,
    '注入的探针让全局证据计数动了：判据按「证据函数条数」累加，而不是按 operation 归属',
  );

  // ② import 不是入口：withUiEntry / noUiEntry / noUiEntryList 一个都不许动
  assert.equal(
    map.summary.withUiEntry,
    base.summary.withUiEntry,
    '只 import 从不调用却被算成了入口 ——「光 import 不算入口」这条判据被掏空了',
  );
  assert.equal(map.summary.noUiEntry, base.summary.noUiEntry, '只 import 未调用却减少了缺口数');
  assert.deepEqual(map.summary.noUiEntryList, base.summary.noUiEntryList, '缺口清单被 import 改写');
  assert.ok(map.summary.noUiEntryList.includes(gap), `${gap} 不在缺口清单里`);
  assert.equal(row.verdict, 'no-ui-entry', `只 import 未调用却判成 ${row.verdict}`);
  assert.deepEqual(row.uiEntryViews, [], `只 import 未调用却挂上了入口视图：${row.uiEntryViews.join(', ')}`);

  // ③ 「引用文件数」不动：本例只测「调用」，不测「哪个文件带了证据」
  assert.equal(map.summary.uiRefFiles, base.summary.uiRefFiles, '注入点选错了：不该改变带 admin 路径证据的文件数');
});

test('负例十（M2b 对照）：同一个函数被调用一次 ⇒ 该 operation 变成有入口，差异只来自「调用」', () => {
  const gapped = sourcesWithoutRealScopeWriteCalls();
  const base = buildCapabilityMap(gapped);
  const gap = 'grantAdministratorScope';
  assert.ok(base.summary.noUiEntryList.includes(gap), `前提不成立：抹掉真实调用后 ${gap} 仍判有入口`);

  const map = buildCapabilityMap(sourcesWithEvidenceCarryingProbe('void grantScopeEntryProbe({});', gapped));
  const row = rowOf(map, gap);

  assert.equal(row.verdict, 'ui-entry', `函数真被调用后仍判成 ${row.verdict}`);
  assert.deepEqual(row.uiEntryViews, [PROBE_ENTRY_VIEW], `入口视图不是 ${PROBE_ENTRY_VIEW}：${row.uiEntryViews.join(', ')}`);
  assert.equal(map.summary.withUiEntry, base.summary.withUiEntry + 1);
  assert.equal(map.summary.noUiEntry, base.summary.noUiEntry - 1);
  assert.ok(!map.summary.noUiEntryList.includes(gap), '被调用的函数已经造出入口，却仍留在缺口清单里');
  assert.ok(
    map.summary.noUiEntryList.includes('revokeAdministratorScope'),
    '另一条真缺口被牵连了：对照组的差异不应扩散',
  );
});

test('--update 只重写标记块，不动块外散文', t => {
  const root = makeTempTree(t);
  const docPath = join(root, 'docs/architecture/admin-console-capability-map.md');
  const doc = readFileSync(docPath, 'utf8');
  const before = doc.slice(0, doc.indexOf(DOC_BEGIN));
  const after = doc.slice(doc.indexOf(DOC_END) + DOC_END.length);

  const result = runCli(['--update', '--root', root]);
  assert.equal(result.code, 0, result.stderr);

  const updated = readFileSync(docPath, 'utf8');
  assert.equal(updated.slice(0, updated.indexOf(DOC_BEGIN)), before);
  assert.equal(updated.slice(updated.indexOf(DOC_END) + DOC_END.length), after);
  assert.equal(runCli(['--check', '--root', root]).code, 0);
});

test('汇总行可直接贴进回报（含四个关键读数）', () => {
  const map = buildCapabilityMap(loadSources(REPO_ROOT));
  const line = renderSummaryLine(map);
  assert.match(line, /totalOps=46/);
  assert.match(line, /有入口=46/);
  assert.match(line, /无入口=0/);
  assert.match(line, /死按钮=0/);
  assert.equal(readdirSync(join(REPO_ROOT, 'tools/lib')).includes('admin-capability-map.mjs'), true);
});
