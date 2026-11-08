/**
 * 真库臂（`tests/failmatrix/run-real.mjs`）`--require-no-different` 的单测。
 *
 * 为什么需要这个文件：2026-11-07 的对抗性审查把「本 PR 新断言在 CI 里永远不会让流水线变红」
 * 判成 P1 —— 真库臂的退出码只由 `not_runnable > 0` 决定（`run-real.mjs:1477-1481` 那个
 * `return 1`），`different > 0` 时照旧 `return 0`（`:1483`）。R89 给这条臂补
 * `--require-no-different`，把「有差异」变成可选失败判据。本文件钉住它的四格语义，
 * 外加「关掉开关时既有行为逐字未变」这条回归线。
 *
 * 为什么直接 import `tests/failmatrix/require-no-different.mjs`、不 import `run-real.mjs`：
 * 后者的最后一行是顶层 `process.exitCode = await main();`，一 import 就会真起一个一次性
 * PG 17 簇。判据抽在纯模块里，单测因此零数据库依赖（缺 `GY_PG_BIN` 的机器上也能跑）。
 *
 * 判据（全部现场跑，零硬编码计数以外的期望）：
 *   ① 开关开 + `different > 0` ⇒ 1，且 stderr 一行 FAIL 里含计数与受影响用例 id；
 *   ② 开关开 + `different = 0` ⇒ 0（本开关不因为「没有差异」判红）；
 *   ③ 开关关 + `different > 0` ⇒ 0（既有行为未变：退出码仍只由 `not_runnable` 决定）；
 *   ④ 开关开 + `notRunnable > 0` 且没给 `--require-no-not-runnable` ⇒ 仍只按 different 判（互不吞）；
 *   ⑤ id 多于 10 个时只列 10 个并写「等 N 条」；
 *   ⑥ 参数拼错 `--require-no-diff` ⇒ 与既有非法参数行为一致：`parseArgs()` 顶层 throw，exit 1；
 *   ⑦ `--require-no-different` 被 `parseArgs()` 接受：解析器不崩、直接走到起簇（看 `[pg] bin=`/`[pg] dataDir=` 正向标记）；
 *   ⑧ 结构契约：新内容全在文件末尾，`run-real.mjs` 既有 1518 行一格没动。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  differentFailureMessage,
  requireFlagField,
  shouldFailOnDifferent,
} from '../failmatrix/require-no-different.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUN_REAL = join(ROOT, 'tests', 'failmatrix', 'run-real.mjs');
const MODULE_RELATIVE = 'tests/failmatrix/require-no-different.mjs';
/** `run-real.mjs` 在 R89 之前的行数：本片只许**追加**，不许把既有行往下推（docs 里有行号锚点）。 */
const PRE_R89_LINES = 1518;

/** 逐条读数的替身：只有 `verdict === 'different'` 的 id 进 FAIL 文案。 */
function rowsOf(ids) {
  const rows = ids.map((id) => ({ id, verdict: 'different' }));
  return rows;
}

/** 接管 `console.error`，把 `shouldFailOnDifferent()` 打出去的那行 FAIL 原样收下来。 */
function captureStderr(run) {
  const original = console.error;
  const lines = [];
  console.error = (...args) => { lines.push(args.map(String).join(' ')); };
  try {
    return { code: run(), text: lines.join('\n') };
  } finally {
    console.error = original;
  }
}

/** 真库臂的 `--require-no-different` 缺省是**关**：`parseArgs()` 里 `requireNoDifferent: false`。 */
const SWITCH_OFF = Object.freeze({ requireNoNotRunnable: false, requireNoDifferent: false });
const SWITCH_ON = Object.freeze({ requireNoNotRunnable: false, requireNoDifferent: true });

// ---------------------------------------------------------------------------
// ① 开关开 + different > 0 ⇒ 1，且 FAIL 行含计数与用例 id
// ---------------------------------------------------------------------------
test('开关打开 + different > 0 ⇒ 返回 1，stderr 一行 FAIL 含计数与受影响用例 id', () => {
  const rows = rowsOf(['C4-12', 'C4-15', 'C5-09']);
  const { code, text } = captureStderr(() => shouldFailOnDifferent(SWITCH_ON, { different: 3, notRunnable: 0 }, rows));
  assert.equal(code, 1, '开关打开且 different > 0 必须判红（否则这条开关在 CI 里等于没有）');
  assert.match(text, /FAIL：--require-no-different 下有 3 条 different/, `FAIL 行必须带计数：\n${text}`);
  for (const id of ['C4-12', 'C4-15', 'C5-09']) {
    assert.ok(text.includes(id), `FAIL 行必须点名受影响用例 ${id}：\n${text}`);
  }
  assert.match(text, /different 不是通过/, 'FAIL 行必须写清 different 不是通过（与 not_runnable 那条同风格）');
  // 「一行」是文案要求：真库臂的日志已经很长，失败原因不该再铺成多行。
  assert.equal(text.trim().split('\n').length, 1, `FAIL 必须是单行：\n${text}`);
});

// ---------------------------------------------------------------------------
// ② 开关开 + different === 0 ⇒ 不因本开关变红
// ---------------------------------------------------------------------------
test('开关打开 + different === 0 ⇒ 返回 0（本开关不因为「没有差异」判红），且不打 FAIL', () => {
  const { code, text } = captureStderr(() => shouldFailOnDifferent(SWITCH_ON, { different: 0, notRunnable: 0 }, []));
  assert.equal(code, 0, 'different 为 0 时本开关必须放行');
  assert.equal(text, '', `different 为 0 时不许打 FAIL：\n${text}`);
});

// ---------------------------------------------------------------------------
// ③ 开关关 + different > 0 ⇒ 0：既有行为逐字未变
// ---------------------------------------------------------------------------
test('开关关闭 + different > 0 ⇒ 返回 0：既有行为未变（退出码仍只由 not_runnable 决定）', () => {
  const rows = rowsOf(['C4-12', 'C4-15']);
  const { code, text } = captureStderr(() => shouldFailOnDifferent(SWITCH_OFF, { different: 2, notRunnable: 0 }, rows));
  assert.equal(code, 0, '开关关着时 different > 0 绝不能改退出码（那是 2026-11-07 之前的既有语义）');
  assert.equal(text, '', `开关关着时一个 FAIL 都不许打：\n${text}`);
  // 连 `different` 这个字段都不传（老调用方）也不许炸。
  const legacy = captureStderr(() => shouldFailOnDifferent(SWITCH_OFF, {}));
  assert.equal(legacy.code, 0, '关着开关 + 没有 different 字段时必须仍是 0');
});

// ---------------------------------------------------------------------------
// ④ 两个开关互不吞
// ---------------------------------------------------------------------------
test('开关打开 + notRunnable > 0 且没给 --require-no-not-runnable ⇒ 仍只按 different 判（两开关互不吞）', () => {
  // not_runnable 一大堆、different 为 0 ⇒ 本开关不许越权把 not_runnable 判成红。
  const onlyNotRunnable = captureStderr(
    () => shouldFailOnDifferent(SWITCH_ON, { different: 0, notRunnable: 7 }, []),
  );
  assert.equal(onlyNotRunnable.code, 0, '--require-no-different 不许替 --require-no-not-runnable 判红');
  assert.equal(onlyNotRunnable.text, '', '本开关只该打自己的 FAIL');

  // not_runnable 与 different 同时 > 0 ⇒ 本开关只看 different（它红了，但理由里不许出现 not_runnable）。
  const both = captureStderr(
    () => shouldFailOnDifferent(SWITCH_ON, { different: 2, notRunnable: 7 }, rowsOf(['C1-01', 'C1-02'])),
  );
  assert.equal(both.code, 1);
  assert.match(both.text, /下有 2 条 different/, `计数必须只数 different：\n${both.text}`);
  assert.doesNotMatch(both.text, /not_runnable 条|下有 7 条/, `本开关的 FAIL 不许混进 not_runnable 计数：\n${both.text}`);

  // 反向：只给 --require-no-not-runnable 时，different 再多也不许本开关说话。
  const otherFlagOnly = captureStderr(
    () => shouldFailOnDifferent({ requireNoNotRunnable: true, requireNoDifferent: false }, { different: 9, notRunnable: 0 }),
  );
  assert.equal(otherFlagOnly.code, 0, '--require-no-not-runnable 不许把 different 变成红');
});

// ---------------------------------------------------------------------------
// ⑤ 只列 10 个 id + 「等 N 条」
// ---------------------------------------------------------------------------
test('different 多于 10 条时只列 10 个用例 id，多出来的写「等 N 条」（N = 实际条数）', () => {
  const ids = Array.from({ length: 13 }, (_, index) => `C3-${String(index + 1).padStart(2, '0')}`);
  const message = differentFailureMessage({ different: 13 }, rowsOf(ids));
  assert.ok(message !== null, 'different > 0 必须产出 FAIL 文案');
  assert.match(message, /下有 13 条 different/, `计数必须是 13：\n${message}`);
  for (const id of ids.slice(0, 10)) assert.ok(message.includes(id), `前 10 个 id 必须列出：缺 ${id}\n${message}`);
  for (const id of ids.slice(10)) assert.ok(!message.includes(id), `第 11 个及以后的 id 不许列出：多列了 ${id}\n${message}`);
  assert.match(message, /等 13 条/, `超出部分必须写「等 N 条」（N 是实际条数 13）：\n${message}`);
});

// ---------------------------------------------------------------------------
// ⑥ 参数拼错 ⇒ 与既有非法参数行为一致（顶层 throw「未知参数」，exit 1）
// ---------------------------------------------------------------------------
test('参数拼错 --require-no-diff ⇒ 与既有非法参数行为一致：parseArgs 顶层 throw 未知参数，exit 1', (t) => {
  // `run-real.mjs` 的缺 `GY_PG_BIN` 闸门（:53-61）在 `parseArgs()` **之前**，所以要让解析真的跑到，
  // 得给一个「含 initdb」的目录。用临时空文件当 initdb 就够了：解析一 throw，脚本根本走不到起簇。
  const binDir = mkdtempSync(join(tmpdir(), 'gy-r89-dummybin-'));
  writeFileSync(join(binDir, process.platform === 'win32' ? 'initdb.exe' : 'initdb'), '');
  try {
    const result = spawnSync(process.execPath, [RUN_REAL, '--require-no-diff'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, GY_PG_BIN: binDir, GY_ALLOW_SKIP: '' },
      timeout: 60_000,
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    assert.equal(result.status, 1, `拼错的参数必须像既有非法参数一样 exit 1（不是静默忽略、不是 77）：\n${output.slice(-2000)}`);
    assert.match(output, /未知参数：--require-no-diff/, `必须点名那个拼错的参数：\n${output.slice(-2000)}`);
    assert.match(
      output,
      /只支持 --json= \/ --allow-skip \/ --require-no-not-runnable \/ --require-no-different/,
      `报错里的「只支持」清单必须列上新开关：\n${output.slice(-2000)}`,
    );
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ⑦ 开关被 parseArgs 接受（不落到「未知参数」那一支）
// ---------------------------------------------------------------------------
test('--require-no-different 被 parseArgs 接受：解析器不崩、直接走到起簇（真失败 exit 1）', (t) => {
  const binDir = mkdtempSync(join(tmpdir(), 'gy-r89-dummybin-'));
  writeFileSync(join(binDir, process.platform === 'win32' ? 'initdb.exe' : 'initdb'), '');
  try {
    const result = spawnSync(process.execPath, [RUN_REAL, '--require-no-different', '--require-no-not-runnable'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, GY_PG_BIN: binDir, GY_ALLOW_SKIP: '' },
      timeout: 60_000,
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    // 空 initdb 起不了簇 ⇒ 走既有的「其它非 0（通常 1）真失败」那一支，不是 77（77 只表示缺 GY_PG_BIN）。
    assert.equal(result.status, 1, `应当落在「集群起不来」那一支（exit 1，不是 77）：\n${output.slice(-2000)}`);
    // 正向标记，而不是「没出现某个错误」：`parseArgs()` 是**模块顶层**调用
    // （`const opts = parseArgs(process.argv.slice(2));`），它一返回，主流程才会打
    // `[pg] bin=` / `[pg] dataDir=` 并真的去跑 initdb。所以这两行出现 ⇒ 解析器放行了这个开关。
    // 反过来，`requireFlagField` 未定义会在模块求值阶段当场 ReferenceError，一进 `main()` 都轮不到，
    // 上面那两行一行都不会有 —— 这条断言把「开关被接受、起簇失败」与「解析器自己崩了」分开。
    assert.match(output, /\[pg\] bin=/, `解析器必须放行并进到主流程（缺 [pg] bin= 说明没走到起簇）：\n${output.slice(-2000)}`);
    assert.match(output, /\[pg\] dataDir=/, `主流程必须打出一次性簇的数据目录（缺 [pg] dataDir= 说明没走到起簇）：\n${output.slice(-2000)}`);
    assert.match(output, /真 PG 臂 FAIL/, `空 initdb 必须被主流程报成真失败（不是被解析器吞掉）：\n${output.slice(-2000)}`);
    assert.doesNotMatch(
      output,
      /ReferenceError|is not defined/,
      `解析器不许自己崩掉（ReferenceError 会被误读成「起簇失败」，同一支 exit 1）：\n${output.slice(-2000)}`,
    );
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ⑧ 结构契约：开关名映射、短路行、既有行号一格未动
// ---------------------------------------------------------------------------
test('结构契约：字段映射独立、短路行接在既有 return 处、新内容全在文件末尾（既有 1518 行不动）', () => {
  assert.equal(requireFlagField('--require-no-different'), 'requireNoDifferent');
  assert.equal(requireFlagField('--require-no-not-runnable'), 'requireNoNotRunnable');
  assert.notEqual(
    requireFlagField('--require-no-different'),
    requireFlagField('--require-no-not-runnable'),
    '两个开关必须落在不同字段上，否则会互相覆盖',
  );

  const source = readFileSync(RUN_REAL, 'utf8');
  const lines = source.split('\n');
  // 新增内容全部在末尾：`process.exitCode = await main();` 仍是第 1518 行。
  assert.equal(
    lines[PRE_R89_LINES - 1],
    'process.exitCode = await main();',
    `run-real.mjs 的第 ${PRE_R89_LINES} 行必须仍是顶层 main() 调用（新内容只许追加在它之后）`,
  );
  assert.ok(lines.length > PRE_R89_LINES, '必须有追加内容');
  // 解析行同时认识两个开关，且用同一个字段映射。
  assert.match(
    source,
    /if \(arg === '--require-no-not-runnable' \|\| arg === '--require-no-different'\) \{ out\[requireFlagField\(arg\)\] = true; continue; \}/,
    'parseArgs 必须用同一行、同一映射认识两个 --require-no-* 开关',
  );
  // 主流程的短路点接在既有 not_runnable 判据之后（not_runnable 那条 return 1 一字未动）。
  assert.match(source, /if \(opts\.requireNoNotRunnable && tally\.notRunnable > 0\) \{/, '既有 not_runnable 判据必须原样保留');
  assert.match(source, /return shouldFailOnDifferent\(opts, tally, rows\);/, '主流程必须在 return 0 的位置改判本开关');
  // 文件末尾那句 import 是**故意**放末尾的（ESM 会提升），别被人「顺手」挪到第一行去推平移位。
  assert.ok(
    source.trimEnd().endsWith(`import { requireFlagField, shouldFailOnDifferent } from './${MODULE_RELATIVE.split('/').pop()}';`),
    'run-real.mjs 末尾必须是从 ' + MODULE_RELATIVE + ' 引判据的那一行',
  );
});

// ---------------------------------------------------------------------------
// ⑨ 头部 usage 也要提到新开关（脚本没有 --help，用法块就是文件头注释）
// ---------------------------------------------------------------------------
test('文件头 usage 提到 --require-no-different（脚本没有 --help，用法块是唯一入口说明）', () => {
  const source = readFileSync(RUN_REAL, 'utf8');
  const usage = source.slice(0, source.indexOf('import { execFileSync }'));
  assert.match(usage, /--require-no-different/, `文件头用法块必须写上新开关：\n${usage}`);
  assert.match(usage, /--require-no-not-runnable/, '既有开关的说明不许被删');
});

// ---------------------------------------------------------------------------
// ⑩ `requireFlagField` 对未知参数抛错（不是静默别名）
// ---------------------------------------------------------------------------
test('requireFlagField 对未知参数抛错：不再静默映射成 requireNoNotRunnable', () => {
  // 回归点：早先的 fail-open 写法是 `arg === '--require-no-different' ? … : 'requireNoNotRunnable'`，
  // 任何拼错、或将来新增却漏登记的开关都会被静默当成「另一个开关」跑下去 —— 红/绿错位极难查。
  // 这里钉住「未知 ⇒ 抛」，而不是「未知 ⇒ 某个字段名」。
  assert.throws(
    () => requireFlagField('--require-no-diff'),
    /未知的 --require-no-\* 开关/,
    '拼错的开关必须抛错，不许静默别名',
  );
  assert.throws(
    () => requireFlagField('--require-no-not-runnabl'),
    /未知的 --require-no-\* 开关：--require-no-not-runnabl/,
    '错误信息必须点名那个未知参数',
  );
  // 非开关字符串（含空串）同样不许被接纳：fail-open 时它们会变成 requireNoNotRunnable。
  assert.throws(() => requireFlagField(''), /未知的 --require-no-\* 开关/);
  // 两个真开关仍然按名字返回各自的字段（字段独立性由 ⑧ 再钉一次）。
  assert.equal(requireFlagField('--require-no-different'), 'requireNoDifferent');
  assert.equal(requireFlagField('--require-no-not-runnable'), 'requireNoNotRunnable');
});
