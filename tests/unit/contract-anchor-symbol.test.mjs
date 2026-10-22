// 符号形态锚点（`locator: {symbol, file?}`）的行为测试：夹具建在系统临时目录里，不读写仓内台账。
// 覆盖：① 正例（解析出的区间 = 隶属块，且台账里没有行号数字，--write-doc 渲染 `path#符号`）；
// ② 负控制 1（符号不存在 ⇒ 形状错误 exit 1，不降级成「不可核」）；
// ③ 负控制 2（同名符号出现两次 ⇒ AMBIGUOUS 且列出两个候选）；
// ④ 负控制 3（核心价值证明：同一份台账、同一棵树，只在 app.ts 头部插行 ——
//    行号形态条目变红、符号形态条目仍绿）。
// 夹具用的 app.ts 是**真实**的 services/api/src/app.ts（原样复制），不是合成片段：
// 漂移读数要能对得上仓里的那一份，否则证明不了这条台账项在真实文件上的行为。
//
// 负控制 3 的实测（2026-10-22，origin/main = 489804e4，仓内 app.ts 1928 行）：
//   `const accountDeletionWired` 在第 1825 行，`registerAccountDeletionRoutes(app, …)` 的块到第 1833 行。
//   头部插 10 行后：首命中漂到 1835，区间仍写 `1825-1833`，**恰好**落在容差边界（1833 + 2 = 1835）⇒ 仍绿；
//   插 11 行（1836 > 1835）⇒ 红（exit 1，语义错误 1 条）；符号形态在 0／10／11 行下都绿，解析值同步漂移。
//   所以本文件把「变红所需的位移」按当前文件算出来（`shiftToRed`），不写死 10/11：
//   插 10 行那格单独断言符号形态仍绿（派单要求的读数据此可复现），行号形态的红用 shiftToRed 断言。
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
const APP_PATH = 'services/api/src/app.ts';
const ROUTE_FILE = 'services/api/src/routes/fixture.ts';
const APP_SOURCE = readFileSync(join(ROOT, APP_PATH), 'utf8');
const DIMENSION_KEYS = ['error_codes', 'pagination', 'versioning', 'idempotency', 'source_kind', 'execution_modes', 'cancel', 'timeout'];

// 真实文件里这一条台账项的位置：锚点文本所在行、装配块首行与末行。
const appLines = APP_SOURCE.split('\n');
const anchorLine = appLines.findIndex(line => line.includes('const accountDeletionWired')) + 1;
const callLine = appLines.findIndex(line => line.includes('registerAccountDeletionRoutes(app')) + 1;
let blockEnd = 0;
for (let index = callLine; index <= appLines.length; index += 1) {
  if (appLines[index - 1].trim() === '});') { blockEnd = index; break; }
}
assert.ok(anchorLine > 0 && callLine > 0 && blockEnd >= callLine, '真实 app.ts 里应能找到 accountDeletionWired 装配块');

const shiftLines = (source, count) => Array.from({ length: count }, (_, index) => `// 漂移夹具第 ${index + 1} 行：模拟另一张 PR 在 app.ts 头部插入 ${count} 行`).join('\n') + (count > 0 ? '\n' : '') + source;
// 行号形态「变红」所需的最小头部插入行数：首命中 = anchorLine + k，要越过区间终点 + 容差 2。
const shiftToRed = blockEnd + 3 - anchorLine;

const fixture = (t, appSource = APP_SOURCE) => {
  const root = mkdtempSync(join(tmpdir(), 'gy-anchor-symbol-'));
  t.after(() => {
    assert.ok(root.startsWith(tmpdir()), `夹具应位于临时目录内：${root}`);
    rmSync(root, { recursive: true, force: true });
  });
  const put = (path, content) => {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  };
  for (const name of ['verify-contract-status.mjs', 'contract-status-core.mjs', 'lib/anchor-resolve.mjs']) {
    mkdirSync(dirname(join(root, 'tools', name)), { recursive: true });
    copyFileSync(join(ROOT, 'tools', name), join(root, 'tools', name));
  }
  put(APP_PATH, appSource);
  put(ROUTE_FILE, '// 夹具：没有任何注册声明。\n');
  put('packages/contracts/operations.json', JSON.stringify({
    contract_version: 'anchor-symbol-test',
    operations: [{ id: 'requestAccountDeletion', method: 'post', path: '/me/account/deletion' }],
  }, null, 2));
  // 台账只有这一条操作 + 8 条横切维度；证据就是被考察的那一条 app.ts 引用。
  const apply = evidence => {
    const value = {
      contract_version: 'anchor-symbol-test',
      operations: [{
        id: 'requestAccountDeletion', method: 'post', path: '/me/account/deletion', route_mounted: false,
        status: 'partial', blocker: '夹具：只验证符号锚点', evidence,
      }],
      dimensions: DIMENSION_KEYS.map(key => ({
        key, title: `夹具维度 ${key}`, source_anchor: `夹具：${key} 无来源`,
        status: 'partial', blocker: '夹具：只验证符号锚点',
        evidence: [{ path: ROUTE_FILE, lines: '1-1' }],
      })),
    };
    put(STATUS_FILE, JSON.stringify(value, null, 2));
    put(DOC_FILE, `# 夹具\n\n${renderStatusTables(value)}\n\n尾部\n`);
    return value;
  };
  const run = (args = []) => spawnSync(process.execPath, ['tools/verify-contract-status.mjs', ...args], { cwd: root, encoding: 'utf8' });
  const ledgerText = () => readFileSync(join(root, STATUS_FILE), 'utf8');
  const documentText = () => readFileSync(join(root, DOC_FILE), 'utf8');
  return { root, put, apply, run, ledgerText, documentText };
};

const symbolEvidence = { path: APP_PATH, symbol: 'accountDeletionWired', locator: { symbol: 'registerAccountDeletionRoutes' } };
const linesEvidence = { path: APP_PATH, symbol: 'accountDeletionWired', lines: `${anchorLine}-${blockEnd}` };
const SYMBOL_LINE = /PASS: 符号形态锚点 1 条（运行时解析，台账里不存行号：services\/api\/src\/app\.ts#registerAccountDeletionRoutes ⇒ (\d+)-(\d+)）/;

test('① 正例：符号形态解析出归属块、台账里不留行号数字、--write-doc 渲染成 path#符号', t => {
  const box = fixture(t);
  box.apply([symbolEvidence]);
  const before = box.ledgerText();
  const result = box.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const matched = SYMBOL_LINE.exec(result.stdout);
  assert.ok(matched, `输出缺少符号形态解析行：\n${result.stdout}`);
  assert.equal(Number(matched[1]), callLine, '解析出的起点应是装配块首行');
  assert.equal(Number(matched[2]), blockEnd, '解析出的终点应是装配块末行');
  // 台账逐字节不变：行号在运行时算，不落盘 ⇒ 值不可能是人手写死的。
  assert.equal(box.ledgerText(), before);
  assert.equal(JSON.parse(before).operations[0].evidence[0].lines, undefined, '这一条证据里不应出现手写行号');
  // 对照表渲染成 `path#符号`，且与 JSON 一致（不是把解析出的数字写进被逐字比对的表格）。
  assert.match(box.documentText(), new RegExp(`${APP_PATH.replaceAll('/', '\\/')}#registerAccountDeletionRoutes`));
  const synced = box.run(['--write-doc']);
  assert.equal(synced.status, 0, synced.stdout + synced.stderr);
  assert.match(synced.stdout, /PASS: 中文表格一致/);
});

test('② 负控制 1：符号不存在 ⇒ 形状错误 exit 1（不降级成「不可核」）', t => {
  const box = fixture(t);
  box.apply([{ path: APP_PATH, symbol: 'accountDeletionWired', locator: { symbol: 'createAccountDeletionWiring' } }]);
  const before = box.ledgerText();
  const result = box.run();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /形状错误 · post \/me\/account\/deletion: services\/api\/src\/app\.ts 的符号锚点「createAccountDeletionWiring」解析失败（MISSING：/);
  assert.match(result.stderr, /\[形状错误 1 \/ 语义错误 0 \/ 表格漂移 0\]/);
  assert.equal(box.ledgerText(), before, '解析失败时不得改动台账');
});

test('③ 负控制 2：同名符号出现两次 ⇒ AMBIGUOUS 且列出两个候选', t => {
  const duplicate = `${APP_SOURCE}\nexport function registerAccountDeletionRoutes(app, config) {\n  return app;\n}\n`;
  const box = fixture(t, duplicate);
  box.apply([symbolEvidence]);
  const result = box.run();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const duplicateLines = duplicate.split('\n');
  const copyLine = duplicateLines.findIndex(line => line.startsWith('export function registerAccountDeletionRoutes')) + 1;
  assert.match(result.stderr, /解析失败（AMBIGUOUS：符号落在 2 个不同归属块（候选 /);
  assert.match(result.stderr, new RegExp(`候选 ${callLine}-${blockEnd}、${copyLine}-${copyLine + 2}`));
  assert.match(result.stderr, new RegExp(`命中行 ${callLine}、${copyLine}`));
});

test('④ 负控制 3（核心价值证明）：只在 app.ts 头部插行 —— 行号形态变红、符号形态仍绿', t => {
  // 同一份台账、同一棵树：两条台账项只差锚点形状。
  const withShift = shift => fixture(t, shiftLines(APP_SOURCE, shift));

  // (a) 派单字面值 +10 行：符号形态仍绿，且解析值跟着漂 10 行。
  const ten = withShift(10);
  ten.apply([symbolEvidence]);
  const tenSymbol = ten.run();
  assert.equal(tenSymbol.status, 0, `+10 行时符号形态必须仍绿：${tenSymbol.stdout}${tenSymbol.stderr}`);
  assert.match(tenSymbol.stdout, new RegExp(`app\\.ts#registerAccountDeletionRoutes ⇒ ${callLine + 10}-${blockEnd + 10}`));

  // (b) 同一棵树换成行号形态：+10 行时靠 ±2 容差仍在边界内（首命中 blockEnd+2），
  //     再加 1 行即越过边界 ⇒ exit 1，且命中条目点名 requestAccountDeletion。
  const tenLines = withShift(10);
  tenLines.apply([linesEvidence]);
  const boundary = tenLines.run();
  assert.equal(boundary.status, 0, '±2 容差边界：首命中正好等于区间终点 + 2');
  const red = withShift(shiftToRed);
  red.apply([linesEvidence]);
  const redLines = red.run();
  assert.equal(redLines.status, 1, redLines.stdout);
  // 行号从真实源码现算（`anchorLine`／`blockEnd`），不在断言里写死 `源文件:行号`。
  assert.match(redLines.stderr, new RegExp(`语义错误 · requestAccountDeletion: services\\/api\\/src\\/app\\.ts:${anchorLine}-${blockEnd} 的锚点「accountDeletionWired」不在引用行范围内`));
  assert.match(redLines.stderr, /\[形状错误 0 \/ 语义错误 1 \/ 表格漂移 0\]/);

  // (c) 同一棵 +shiftToRed 行的树，换成符号形态 ⇒ 仍绿（漂移被运行时解析吸收）。
  const redSymbol = withShift(shiftToRed);
  redSymbol.apply([symbolEvidence]);
  const tolerant = redSymbol.run();
  assert.equal(tolerant.status, 0, `+${shiftToRed} 行时符号形态必须仍绿：${tolerant.stdout}${tolerant.stderr}`);
  assert.match(tolerant.stdout, new RegExp(`app\\.ts#registerAccountDeletionRoutes ⇒ ${callLine + shiftToRed}-${blockEnd + shiftToRed}`));
  assert.match(tolerant.stdout, /PASS: 中文表格一致/);
});

test('⑤ 形状：lines 与 locator 同时给 / locator 带未知字段 ⇒ 形状错误', t => {
  const box = fixture(t);
  box.apply([{ ...symbolEvidence, lines: `${anchorLine}-${blockEnd}` }]);
  const both = box.run();
  assert.equal(both.status, 1, both.stdout);
  assert.match(both.stderr, /同时给了 lines 与 locator，锚点两种形态只能二选一/);
  box.apply([{ path: APP_PATH, symbol: 'accountDeletionWired', locator: { symbol: 'registerAccountDeletionRoutes', file: APP_PATH } }]);
  const okFile = box.run();
  assert.equal(okFile.status, 0, `locator.file 显式给出同一文件应可用：${okFile.stdout}${okFile.stderr}`);
  box.apply([{ path: APP_PATH, symbol: 'accountDeletionWired', locator: { symbol: 'registerAccountDeletionRoutes', range: '1-2' } }]);
  const unknown = box.run();
  assert.equal(unknown.status, 1, unknown.stdout);
  assert.match(unknown.stderr, /locator 出现未知字段 range（只认 symbol 与 file）/);
});
