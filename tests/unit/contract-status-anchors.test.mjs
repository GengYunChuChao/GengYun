// 证据锚点（符号）校验的行为测试：全部夹具都建在系统临时目录里，不读写仓内台账。
// 覆盖四档：① 仓内台账正控制 ② 路径不存在判红 ③ 行号越界判红 ④ 无锚点只计不可核不判红；
// 另加锚点区间/容差、锚点缺失判红、锚点字段形状、语义错误时 --write-doc 不写盘。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderStatusTables } from '../../tools/contract-status-core.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const STATUS_FILE = 'docs/architecture/contract-status.json';
const DOC_FILE = 'docs/architecture/contract-implementation-status.md';
const STORE = 'services/api/src/jobs/store.ts';
// 行号是夹具的一部分：getJob 声明在第 3 行、listJobs 第 7 行、JOB_LIMIT 第 11 行、removeJob 第 12 行。
const STORE_SOURCE = [
  '// 合成夹具：只用于锚点校验，不代表真实实现。',
  '',
  'export function getJob(id) {',
  '  return id === undefined ? null : id;',
  '}',
  '',
  'export function listJobs() {',
  '  return [];',
  '}',
  '',
  'export const JOB_LIMIT = 100;',
  'export function removeJob(id) {',
  '  return id !== undefined;',
  '}',
  '',
].join('\n');
const DIMENSION_KEYS = ['error_codes', 'pagination', 'versioning', 'idempotency', 'source_kind', 'execution_modes', 'cancel', 'timeout'];

const fixture = t => {
  const root = mkdtempSync(join(tmpdir(), 'gy-contract-anchors-'));
  t.after(() => {
    assert.ok(root.startsWith(tmpdir()), `夹具应位于临时目录内：${root}`);
    rmSync(root, { recursive: true, force: true });
  });
  const put = (path, content) => {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  };
  mkdirSync(join(root, 'tools'), { recursive: true });
  for (const name of ['verify-contract-status.mjs', 'contract-status-core.mjs', 'lib/anchor-resolve.mjs']) {
    mkdirSync(dirname(join(root, 'tools', name)), { recursive: true });
    copyFileSync(join(ROOT, 'tools', name), join(root, 'tools', name));
  }
  put('services/api/src/app.ts', '');
  put('services/api/src/routes/fixture.ts', '// 夹具：没有任何注册声明。\n');
  put(STORE, STORE_SOURCE);
  put('packages/contracts/operations.json', JSON.stringify({
    contract_version: 'anchors-test',
    operations: [{ id: 'getJob', method: 'get', path: '/jobs/{id}' }],
  }, null, 2));
  // 8 条横切维度的证据也是纯行号（无锚点），用来核对「无锚点不可核」的计数口径。
  const status = evidence => ({
    contract_version: 'anchors-test',
    operations: [{
      id: 'getJob', method: 'get', path: '/jobs/{id}', route_mounted: false,
      status: 'partial', blocker: '夹具：只验证引用形状', evidence,
    }],
    dimensions: DIMENSION_KEYS.map(key => ({
      key, title: `夹具维度 ${key}`, source_anchor: `夹具：${key} 无来源`,
      status: 'partial', blocker: '夹具：只验证引用形状',
      evidence: [{ path: STORE, lines: '3-5' }],
    })),
  });
  // 写台账并把对照表渲染成与之一致；需要制造表格漂移的用例再单独改文档。
  const apply = (evidence, { syncDocument = true } = {}) => {
    const value = status(evidence);
    put(STATUS_FILE, JSON.stringify(value, null, 2));
    if (syncDocument) put(DOC_FILE, `# 夹具\n\n${renderStatusTables(value)}\n\n尾部\n`);
    return value;
  };
  const run = (args = []) => spawnSync(process.execPath, ['tools/verify-contract-status.mjs', ...args], { cwd: root, encoding: 'utf8' });
  return { root, put, apply, run };
};

const ANCHOR_LINE = /PASS: 证据锚点 (\d+) 条引用自带锚点（区间内 (\d+) 条 \+ 仅整文件 (\d+) 条）；无锚点不可核 (\d+) 条（纯行号 (\d+) \+ 无行号源文件 (\d+) \+ 无用例名 (\d+)），只计数不判红/;

test('① 正控制：仓内台账 exit 0，锚点统计与台账条目数自洽', () => {
  const result = spawnSync(process.execPath, ['tools/verify-contract-status.mjs'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /PASS: 中文表格一致/);
  const ledger = JSON.parse(readFileSync(join(ROOT, STATUS_FILE), 'utf8'));
  const entries = [...(ledger.operations ?? []), ...(ledger.dimensions ?? [])];
  const total = entries.reduce((sum, entry) => sum + (entry.evidence?.length ?? 0), 0);
  const matched = ANCHOR_LINE.exec(result.stdout);
  assert.ok(matched, `输出缺少锚点统计行：\n${result.stdout}`);
  const [, referenced, inRange, fileOnly, gapTotal, lineOnly, noLines, testNoName] = matched.map(Number);
  assert.equal(referenced + gapTotal, total, '锚点 + 不可核必须覆盖全部证据项');
  assert.equal(inRange + fileOnly, referenced, '区间内 + 仅整文件必须等于自带锚点的条数');
  assert.equal(lineOnly + noLines + testNoName, gapTotal, '不可核三分类必须等于不可核总数');
  // WARN 行只在**还有**无锚点引用时出现（工具口径：gapTotal === 0 不打印）。
  // 因此两个方向都要判：有缺口 ⇒ 必须打印且带 `前 N/M 条：`；零缺口 ⇒ 必须不打印。
  // 本片（R28-S60）把最后 5 条「无用例名」补齐后仓内第一次到 0，旧的「无条件 match WARN」
  // 会在这条正控制上误红；改成双向后，任一侧退化（该打印却不打印 / 不该打印却打印）都会红。
  if (gapTotal > 0) {
    assert.match(result.stdout, /WARN: 无锚点可疑引用前 \d+\/\d+ 条：/);
  } else {
    assert.doesNotMatch(result.stdout, /WARN: 无锚点可疑引用/, '零缺口时不应再打印 WARN 行');
  }
});

test('② 路径不存在 ⇒ 形状错误判红', t => {
  const box = fixture(t);
  box.apply([{ path: 'services/api/src/jobs/missing.ts', lines: '1-2' }]);
  const result = box.run();
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /证据文件不存在或不是文件 services\/api\/src\/jobs\/missing\.ts/);
  assert.match(result.stderr, /形状错误 1 \/ 语义错误 0 \/ 表格漂移 0/);
});

test('③ 行号越界（0 起 / 超文件长度）⇒ 形状错误判红', t => {
  const box = fixture(t);
  box.apply([{ path: STORE, lines: '0-3' }]);
  const zero = box.run();
  assert.equal(zero.status, 1, zero.stdout);
  assert.match(zero.stderr, /lines=0-3 越界/);
  box.apply([{ path: STORE, lines: '999-1000' }]);
  const beyond = box.run();
  assert.equal(beyond.status, 1, beyond.stdout);
  assert.match(beyond.stderr, /lines=999-1000 越界/);
  assert.match(beyond.stderr, /形状错误 1 \/ 语义错误 0 \/ 表格漂移 0/);
});

test('④ 无锚点（纯行号）⇒ 只计不可核、不判红，并列出可疑', t => {
  const box = fixture(t);
  box.apply([{ path: STORE, lines: '3-5' }]);
  const result = box.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /证据锚点 0 条引用自带锚点（区间内 0 条 \+ 仅整文件 0 条）；无锚点不可核 9 条（纯行号 9 \+ 无行号源文件 0 \+ 无用例名 0）/);
  assert.match(result.stdout, new RegExp(`WARN: 无锚点可疑引用前 5/9 条：getJob ${STORE.replaceAll('/', '\\/')}:3-5、`));
  assert.match(result.stdout, /行号区间 9 条（台账直写 9 条 \+ 符号解析 0 条；有实质内容 9 条；整段仅空白\/收尾行 0 条、区间首行为空行 0 条，只计可疑不判红）/);
  assert.equal(result.stderr, '');
});

test('纯行号区间整段仅空白/收尾行 ⇒ 只计可疑、不判红', t => {
  const box = fixture(t);
  box.apply([{ path: STORE, lines: '5-5' }]); // 夹具第 5 行只有一个 `}`
  const result = box.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /行号区间 9 条（台账直写 9 条 \+ 符号解析 0 条；有实质内容 8 条；整段仅空白\/收尾行 1 条、区间首行为空行 0 条，只计可疑不判红）/);
  assert.match(result.stdout, /WARN: 整段无实质内容的前 1\/1 条：getJob services\/api\/src\/jobs\/store\.ts:5-5/);
});

test('纯行号区间首行为空行 ⇒ 只计可疑计数、不判红', t => {
  const box = fixture(t);
  box.apply([{ path: STORE, lines: '2-5' }]); // 第 2 行是空行，第 3-5 行有实现
  const result = box.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /行号区间 9 条（台账直写 9 条 \+ 符号解析 0 条；有实质内容 9 条；整段仅空白\/收尾行 0 条、区间首行为空行 1 条，只计可疑不判红）/);
  assert.doesNotMatch(result.stdout, /WARN: 整段无实质内容/);
});

test('锚点落在引用行范围内（含 ±2 行容差）⇒ 可核计数、exit 0', t => {
  const box = fixture(t);
  const cases = [
    [{ path: STORE, lines: '3-5', symbol: 'getJob' }, '锚点就在区间首行'],
    [{ path: STORE, lines: '5-6', symbol: 'getJob' }, '锚点在区间起点上方 2 行'],
    [{ path: STORE, lines: '9-10', symbol: 'removeJob', anchor: 'removeJob' }, '锚点在区间终点下方 2 行（symbol 与同值 anchor 并存）'],
  ];
  for (const [evidence, reason] of cases) {
    box.apply([evidence]);
    const result = box.run();
    assert.equal(result.status, 0, `${reason}：${result.stderr}`);
    assert.match(result.stdout, /证据锚点 1 条引用自带锚点（区间内 1 条 \+ 仅整文件 0 条）；无锚点不可核 8 条/, reason);
  }
});

test('锚点在文件里但落在引用行范围外 ⇒ 语义错误判红', t => {
  const box = fixture(t);
  box.apply([{ path: STORE, lines: '6-8', symbol: 'getJob' }]);
  const result = box.run();
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /getJob: services\/api\/src\/jobs\/store\.ts:6-8 的锚点「getJob」不在引用行范围内（容差 ±2 行；实际出现在第 3 行）/);
  assert.match(result.stderr, /形状错误 0 \/ 语义错误 1 \/ 表格漂移 0/);
});

test('锚点在引用的文件里根本不存在 ⇒ 形状错误判红', t => {
  const box = fixture(t);
  box.apply([{ path: STORE, lines: '3-5', symbol: 'noSuchSymbol' }]);
  const result = box.run();
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /中找不到锚点「noSuchSymbol」/);
  assert.match(result.stderr, /形状错误 1 \/ 语义错误 0 \/ 表格漂移 0/);
});

test('锚点字段形状非法（空串 / symbol 与 anchor 冲突）⇒ 形状错误判红', t => {
  const box = fixture(t);
  box.apply([{ path: STORE, lines: '3-5', symbol: '   ' }]);
  const blank = box.run();
  assert.equal(blank.status, 1, blank.stdout);
  assert.match(blank.stderr, /的锚点 symbol 必须是非空字符串/);
  box.apply([{ path: STORE, lines: '3-5', symbol: 'getJob', anchor: 'listJobs' }]);
  const conflict = box.run();
  assert.equal(conflict.status, 1, conflict.stdout);
  assert.match(conflict.stderr, /symbol 与 anchor 同给且取值不同/);
  assert.match(conflict.stderr, /形状错误 1 \/ 语义错误 0 \/ 表格漂移 0/);
});

test('锚点语义错误时 --write-doc 不写盘（不把错位引用固化进对照表）', t => {
  const box = fixture(t);
  box.apply([{ path: STORE, lines: '3-5', symbol: 'getJob' }]);
  // 只改 JSON、不动文档：对照表变成过期待同步状态。
  box.apply([{ path: STORE, lines: '6-8', symbol: 'getJob' }], { syncDocument: false });
  const before = readFileSync(join(box.root, DOC_FILE), 'utf8');
  const result = box.run(['--write-doc']);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /因存在语义错误，--write-doc 未写盘/);
  assert.equal(readFileSync(join(box.root, DOC_FILE), 'utf8'), before, '文档不得被写盘');
});
