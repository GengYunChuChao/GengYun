/**
 * `docs/verification/**` 的「注释锚点影子闸门」在**真仓**上的接线测试（R90）。
 *
 * 缺口（为什么需要这个文件）：`tests/unit/verify-verification-comment-anchors.test.mjs` 全部用临时
 * 目录夹具 + 直接调 `main()`，从不在真仓上跑。工具存在但没接线，「CI 全绿」与「工具 EXIT 1」
 * 可以同时成立——`#1133` 之前就是这样：`origin/main` 上工具红 9 条，而 CI 仍是绿的。
 * 本文件把「在仓库根目录上跑整道闸门」变成一条会红的单元测试，因此它靠既有 `unit-tests`
 * 作业的 `tests/unit/*.test.mjs` glob 生效，**不需要**改 `.github/**`。
 *
 * 四条判据（与任务要求一一对应）：
 *   ① 正向（主判据）：仓库根目录跑整道闸门 ⇒ EXIT 0，读数里 `基线外新增 0`、`可收紧 0`；
 *   ② 防「扫了个寂寞」：`本次命中` == 基线条目数，且 `documents` ≥ 300
 *      （docs 目录挪了 / glob 坏了会让工具「扫 0 篇、0 新增、PASS」，那是最糟的假绿）；
 *   ③ 防「永远红」：基线里有、实际已不是注释行的条目默认不改退出码（`--require-no-stale=off`），
 *      只有显式加 `--require-no-stale` 才红；
 *   ④ 负控制：把真仓的一份证据页 + 它引用的源文件复制到临时目录，注入一条指向**注释行**的锚点
 *      ⇒ EXIT 1 并点名；同一条改成指向**行为行** ⇒ EXIT 0。同一临时目录、同一基线，只改目标行。
 *
 * 只读真仓：本文件只 spawn 子进程与读文件；⛔ 不写仓内文件、⛔ 不改基线——① 用基线内容哈希钉死。
 * 工具支持的自定义参数（负控制靠它们做到全落临时目录）：`--root` / `--scan` / `--baseline`
 * / `--accepted` / `--why` / `--write-baseline` / `--require-no-new` / `--no-require-no-new`
 * / `--require-no-stale` / `--help`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractReferences } from '../../tools/verify-doc-anchors.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TOOL = 'tools/verify-verification-comment-anchors.mjs';
const BASELINE = 'tools/verification-comment-anchor-baseline.json';
// 实测约 4 秒（1422 条命中 / 370 篇文档）；给足 60 秒，避免慢机上偶发超时把判据变成噪声。
const GATE_TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 64 * 1024 * 1024;
// 负控制的「真仓形态」：一份真证据页 + 它引用的真源文件，全部按原相对路径复制进临时目录。
const FIXTURE_DOC = 'docs/verification/gy-r28-comment-ops-contract-20261021.md';
// 注入锚点的目标文件：本工具自身（第 2 行是确定的块注释开头，`export const TOOL_ROOT` 是确定的行为行）。
const INJECT_TARGET = 'tools/verify-verification-comment-anchors.mjs';

function runGate(args) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [TOOL, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: GATE_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const text = `${stdout}${stderr}`;
  const elapsedMs = Date.now() - started;
  if (result.error !== undefined && result.error !== null) {
    assert.fail(`闸门子进程未正常结束（${result.error.message}）：${text.slice(-2000)}`);
  }
  return { status: result.status, stdout, stderr, text, elapsedMs };
}

/** 从尾部读数里取四格数字；取不到就返回 null，让调用方的断言给出可读的失败信息。 */
function readGateNumbers(text) {
  const gate = /VERIFICATION-COMMENT-ANCHOR-GATE: 本次命中 (\d+)、基线 (\d+)、基线外新增 (\d+)、可收紧 (\d+)/.exec(text);
  if (gate === null) return null;
  const documents = /documents=(\d+)/.exec(text);
  return {
    hit: Number(gate[1]),
    baseline: Number(gate[2]),
    added: Number(gate[3]),
    stale: Number(gate[4]),
    documents: documents === null ? null : Number(documents[1]),
  };
}

function readBaselineBook(root = ROOT) {
  return JSON.parse(readFileSync(join(root, BASELINE), 'utf8'));
}

function hashOfBaseline() {
  return createHash('sha256').update(readFileSync(join(ROOT, BASELINE))).digest('hex');
}

// 真仓整道闸门只跑一次（约 4 秒），① 与 ② 共用同一次读数，避免单元作业里白白多跑 4 秒。
let repoRunCache = null;
function repoRun() {
  if (repoRunCache === null) repoRunCache = runGate([]);
  return repoRunCache;
}

test('① 真仓正控制：仓库根跑整道闸门 EXIT 0，基线外新增 0、可收紧 0', () => {
  const before = hashOfBaseline();
  const run = repoRun();
  const after = hashOfBaseline();

  assert.equal(run.status, 0, `闸门在真仓上应 EXIT 0，实际 EXIT ${run.status}：\n${run.text.slice(-4000)}`);
  assert.doesNotMatch(run.text, /VERIFICATION-COMMENT-ANCHOR-FAIL/, '不应出现 FAIL 行');
  assert.doesNotMatch(run.text, /^ERR: /m, '不应出现 ERR 行');
  assert.doesNotMatch(run.text, /^NEW\s/m, '不应有基线外新增的 NEW 行');

  const numbers = readGateNumbers(run.text);
  assert.notEqual(numbers, null, `读数行缺失：\n${run.text.slice(-2000)}`);
  assert.equal(numbers.added, 0, '基线外新增应为 0');
  assert.equal(numbers.stale, 0, '可收紧条目应为 0');
  assert.match(run.text, /--require-no-new=on/, '默认应开启 --require-no-new');
  assert.match(run.text, /--require-no-stale=off/, '默认应关闭 --require-no-stale（判据三的前提）');
  assert.match(run.text, /VERIFICATION-COMMENT-ANCHOR-PASS: 基线内 \d+ 条注释锚点只告警，没有基线外新增/);

  // ⛔ 不许改真基线：跑完内容哈希不变（`--write-baseline` 只有显式传参才写盘）。
  assert.equal(after, before, '跑闸门不得改动 tools/verification-comment-anchor-baseline.json');
});

test('② 防「扫了个寂寞」：本次命中 == 基线条目数，documents ≥ 300', () => {
  const numbers = readGateNumbers(repoRun().text);
  assert.notEqual(numbers, null, '读数行缺失');
  const book = readBaselineBook();
  const entries = Array.isArray(book.entries) ? book.entries.length : -1;

  assert.ok(entries > 0, `基线应有条目：${entries}`);
  assert.equal(numbers.baseline, entries, '读数里的基线数应等于基线 JSON 条目数');
  // 命中数 == 基线条目数：配合 ① 的「新增 0 / 可收紧 0」，等价于「基线每一条都还在本次扫描里被命中」。
  // 若 docs 目录挪了、glob 坏了，工具会扫 0 篇、命中 0、PASS——这条会把那种假绿钉死。
  assert.equal(numbers.hit, entries, `本次命中（${numbers.hit}）应等于基线条目数（${entries}）`);

  assert.notEqual(numbers.documents, null, '读数里应有 documents=');
  assert.ok(numbers.documents >= 300, `扫描文档数应 ≥ 300，实际 ${numbers.documents}`);
  // 扫描面与基线规模一致的另一面：基线自己声明的 scope 就是被扫的那一面。
  assert.equal(book.scope, 'docs/verification/**/*.md', `基线 scope 应为 docs/verification/**/*.md：${book.scope}`);
});

/** 临时目录里的「真仓副本」：一份真证据页 + 它引用的真源文件 + 注入锚点的目标文件。 */
function makeRepoShapedFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'gy-comment-anchor-gate-'));
  t.after(() => {
    assert.ok(root.startsWith(tmpdir()), `夹具应位于系统临时目录内：${root}`);
    rmSync(root, { recursive: true, force: true });
  });
  const put = (relativePath, content) => {
    const absolute = join(root, relativePath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  };

  const docText = readFileSync(join(ROOT, FIXTURE_DOC), 'utf8');
  put(FIXTURE_DOC, docText);
  // 用工具自己的抽取出口列「这篇页引用了哪些文件」，避免手抄路径；只复制真仓里存在的那些。
  const referenced = [...new Set(extractReferences(docText)
    .filter(reference => reference.fenced !== true)
    .map(reference => reference.target))]
    .filter(target => existsSync(join(ROOT, target)));
  assert.ok(referenced.length >= 1, `${FIXTURE_DOC} 应至少引用一份真仓里存在的文件`);
  for (const target of referenced) put(target, readFileSync(join(ROOT, target)));
  put(INJECT_TARGET, readFileSync(join(ROOT, INJECT_TARGET)));

  const targetLines = readFileSync(join(ROOT, INJECT_TARGET), 'utf8').split(/\r?\n/);
  const commentLine = targetLines.findIndex(line => line.trimStart().startsWith('/**')) + 1;
  const codeLine = targetLines.findIndex(line => /^export const TOOL_ROOT =/.test(line.trim())) + 1;
  assert.ok(commentLine >= 1, `${INJECT_TARGET} 应有文件头块注释（用于「指向注释行」）`);
  assert.ok(codeLine >= 1, `${INJECT_TARGET} 应有 export const TOOL_ROOT（用于「指向行为行」）`);
  assert.notEqual(commentLine, codeLine, '注释行与行为行必须是不同行');
  return { root, referenced, commentLine, codeLine };
}

function appendDocLine(root, relativePath, line) {
  const absolute = join(root, relativePath);
  const text = readFileSync(absolute, 'utf8');
  writeFileSync(absolute, `${text.endsWith('\n') ? text : `${text}\n`}\n${line}\n`);
}

function replaceLastDocLine(root, relativePath, line) {
  const absolute = join(root, relativePath);
  const lines = readFileSync(absolute, 'utf8').split(/\r?\n/);
  lines[lines.length - 2] = line;
  writeFileSync(absolute, lines.join('\n'));
}

/** 在临时目录里写「临时基线」：`--write-baseline` 是工具唯一的写盘入口。 */
function writeFixtureBaseline(root) {
  const written = runGate(['--root', root, '--write-baseline']);
  assert.equal(written.status, 0, `--write-baseline 应 EXIT 0：${written.text.slice(-2000)}`);
  assert.match(written.stdout, /^WRITE: .*写入了 \d+ 条/m);
  return readBaselineBook(root);
}

test('③ 防「永远红」：基线里已不是注释行的条目默认不判红，--require-no-stale 才红', t => {
  assert.match(repoRun().text, /--require-no-stale=off/, '真仓读数应显示 --require-no-stale=off');

  const { root, commentLine } = makeRepoShapedFixture(t);
  const injected = `注入负控制锚点：${INJECT_TARGET}:${commentLine}`;
  appendDocLine(root, FIXTURE_DOC, injected);
  const book = writeFixtureBaseline(root);
  assert.ok(book.entries.length >= 1, '临时基线应有条目');

  // 正控制：临时基线覆盖了全部命中 ⇒ EXIT 0。
  const green = runGate(['--root', root]);
  assert.equal(green.status, 0, `临时基线内应 EXIT 0：${green.text.slice(-2000)}`);
  assert.equal(readGateNumbers(green.text).hit, book.entries.length);

  // 把被引用的那一行从注释改成行为行：基线条目变成「可收紧」，但默认不判红。
  const targetPath = join(root, INJECT_TARGET);
  const lines = readFileSync(targetPath, 'utf8').split(/\r?\n/);
  const original = lines[commentLine - 1];
  assert.match(original, /^\s*\/\*\*/, `第 ${commentLine} 行应是块注释开头：${JSON.stringify(original)}`);
  lines[commentLine - 1] = 'export const STALE_PROBE = 0;';
  writeFileSync(targetPath, lines.join('\n'));

  const warned = runGate(['--root', root]);
  assert.equal(warned.status, 0, `可收紧条目默认不应改退出码：${warned.text.slice(-2000)}`);
  assert.match(warned.text, new RegExp(`^STALE ${FIXTURE_DOC.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\d+ -> ${INJECT_TARGET.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:${commentLine}`, 'm'));
  assert.match(warned.text, /可收紧基线：目标行已不是注释行（疑似已修）/);
  assert.equal(readGateNumbers(warned.text).stale, 1);
  assert.equal(readGateNumbers(warned.text).added, 0);

  // 显式钉死时才红（判据三的另一半：不是「永远红」，而是「默认不红、要红有开关」）。
  const strict = runGate(['--root', root, '--require-no-stale']);
  assert.equal(strict.status, 1, `--require-no-stale 应判红：${strict.text.slice(-2000)}`);
  assert.match(strict.text, /VERIFICATION-COMMENT-ANCHOR-FAIL: 基线有 1 条已不再命中/);
});

test('④ 负控制：真仓形态的临时副本，锚点指向注释行 ⇒ EXIT 1 并点名；改指行为行 ⇒ EXIT 0', t => {
  const { root, referenced, commentLine, codeLine } = makeRepoShapedFixture(t);
  const injected = `注入负控制锚点：${INJECT_TARGET}:${commentLine}`;
  appendDocLine(root, FIXTURE_DOC, injected);
  const book = writeFixtureBaseline(root);
  const entries = book.entries.length;
  assert.ok(entries >= 1, '临时基线应有条目');
  assert.equal(book.entries.some(entry => entry.target === INJECT_TARGET), true,
    `临时基线应包含指向 ${INJECT_TARGET} 的条目`);

  // 起点：临时基线覆盖全部命中 ⇒ EXIT 0，扫描面仍是别处复制来的真证据页。
  const baselineRun = runGate(['--root', root]);
  assert.equal(baselineRun.status, 0, `起点应 EXIT 0：${baselineRun.text.slice(-2000)}`);
  const startNumbers = readGateNumbers(baselineRun.text);
  assert.equal(startNumbers.hit, entries);
  assert.equal(startNumbers.added, 0);
  assert.equal(startNumbers.documents, 1, '临时扫描面应只有这一篇复制来的证据页');
  assert.ok(referenced.length >= 1);

  // 注入一条**新的**指向注释行的锚点 ⇒ 基线外新增 1、EXIT 1、逐条点名。
  const redAnchor = `新增注释锚点：${INJECT_TARGET}:${commentLine}`;
  appendDocLine(root, FIXTURE_DOC, redAnchor);
  const red = runGate(['--root', root]);
  assert.equal(red.status, 1, `指向注释行应 EXIT 1：${red.text.slice(-2000)}`);
  const redNumbers = readGateNumbers(red.text);
  assert.equal(redNumbers.added, 1, '基线外新增应为 1');
  assert.equal(redNumbers.hit, entries + 1);
  const named = new RegExp(`^NEW\\s+${FIXTURE_DOC.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\d+ -> ${INJECT_TARGET.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:${commentLine}\\s`, 'm');
  assert.match(red.text, named, 'NEW 行应点名 doc:line -> target:line');
  assert.match(red.text, /VERIFICATION-COMMENT-ANCHOR-FAIL: 基线外新增 1 条/);
  // 红的那次也没有偷偷改基线。
  assert.equal(readBaselineBook(root).entries.length, entries);

  // 同一个临时目录、同一份基线，只把这条锚点改成指向**行为行** ⇒ EXIT 0。
  const greenAnchor = `新增行为锚点：${INJECT_TARGET}:${codeLine}`;
  replaceLastDocLine(root, FIXTURE_DOC, greenAnchor);
  const green = runGate(['--root', root]);
  assert.equal(green.status, 0, `指向行为行应 EXIT 0：${green.text.slice(-2000)}`);
  const greenNumbers = readGateNumbers(green.text);
  assert.equal(greenNumbers.hit, entries, '命中数应回到基线条目数');
  assert.equal(greenNumbers.added, 0);
  assert.equal(greenNumbers.stale, 0);
  assert.doesNotMatch(green.text, /^NEW /m);
  assert.equal(readBaselineBook(root).entries.length, entries, '绿的那次也没有改基线');
});
