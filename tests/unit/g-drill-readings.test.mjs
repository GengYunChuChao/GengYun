/**
 * G 片（GY-R68-G）· 演练闸门与读数解析器的单测。
 *
 * 关键设计（`--check` 为什么不是同义反复）：
 * 期望值一律**从夹具树现场算出**，文档块只是被比对的对象。所以本单测必须能证明三件事：
 *   1. 夹具树的读数与夹具文档块**故意可以不一致**（M1 改数 / M3 删行 ⇒ 红）；
 *   2. 块外凭空塞进来的命令**拿不到出处**（M2 注水 ⇒ 红，点名「不在 package.json/workflow 文本里」）；
 *   3. 把比较函数改成「文档值 := 重算值」后，**同一条断言必须失效**（M4 同义反复 ⇒ 单测自己红）。
 *
 * 夹具树完全由本文件生成（`$env:TEMP\gy-g-drill-fixture-*`），跑完即删；⛔ 不碰仓库里的文件。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_FLOORS,
  DRILL_PLAN,
  GROWTH_READINGS,
  PG_ARM_NOT_RUN_REASON,
  REAL_PG_GATE_TEST,
  SCOPE_NOTES,
  STABLE_READINGS,
  UNIT_GLOB_DIRS,
  arithmeticProblems,
  ciGreenProblems,
  compareDrillBlock,
  computeTreeReadings,
  collectSources,
  growthLag,
  makeRow,
  markerLines,
  normalizeDrillBlock,
  oneShotProblems,
  parseDrillBlock,
  parseReadoutTap,
  parseRows,
  parseTapSummary,
  pathTokens,
  readingKind,
  readingsOf,
  realPgArms,
  renderDrillBlock,
  renderReadout,
  structureProblems,
  summarizeLog,
  traceCommand,
  vacuousProblems,
} from '../../tools/lib/g-drill-readings.mjs';
import {
  checkDocument,
  environmentFailure,
  liveExitCode,
  liveSuccessMessage,
  rowsFromReadings,
  spliceBlock,
} from '../../tools/verify-g-drill-readings.mjs';
import { readDirty } from '../../tools/collect-g-drill.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 夹具树里的假提交（40 位 hex；`isAncestor` 在夹具里恒为 true）。 */
const FIXTURE_SHA = 'a'.repeat(40);
const FIXTURE_HOST = 'fixture-host';
const FIXTURE_AT = '2026-10-28T00:00:00.000Z';

/** 夹具树里 `package.json` 的 scripts：演练计划里的 `npm run` 名字 + `SCOPE_NOTES` 里的名字，一个不多。 */
function fixtureScripts() {
  const scripts = {
    lint: 'eslint .',
    'test:unit': 'node --test "tests/unit/*.test.mjs" "tests/privacy/*.test.mjs" "tests/media/*.test.mjs" "tests/reference/*.test.mjs" "tests/moderation/*.test.mjs"',
    'test:contract': 'node --test "tests/contract/*.test.mjs"',
    'test:evaluation': 'node --test "tests/evaluation/*.test.mjs"',
    'test:integration:http': 'node --test "tests/integration/*.http.test.mjs"',
    'test:failmatrix': 'node tests/failmatrix/run.mjs',
    'test:docs': 'node tools/run-python.mjs tools/validate_development_docs.py && node tools/verify-research-records.mjs',
    'verify:anchors': 'node tools/verify-contract-status.mjs && node tools/verify-doc-anchors.mjs --strict --symbol=strict --scan docs',
    'verify:capability-map': 'node tools/verify-admin-capability-map.mjs --check',
    'verify:purge-schedule': 'node tools/verify-purge-schedule.mjs',
    'verify:parity': 'node tools/openapi-route-parity.mjs',
  };
  // `SCOPE_NOTES` 里的每个脚本都必须在树里存在，否则判据 3 反向会把它们当成「漏登记」——
  // 但这里**只补名字**（已经有真值的 `test:docs` / `verify:*` 不动，否则出处就断了）。
  for (const note of SCOPE_NOTES) {
    if (typeof scripts[note.script] !== 'string') scripts[note.script] = 'node tools/run-python.mjs tools/placeholder.py';
  }
  return scripts;
}

/** 写一个文件（父目录自动建）。 */
function writeFixtureFile(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

/**
 * 仓内记号 → 夹具里的绝对路径：**先按 `/` 切分再拼**。
 *
 * ⛔ 这里不许出现 `String(token).replace(/\//g, '\\')` 这种「改成 Windows 分隔符」的写法：
 * 在 POSIX runner 上它造出来的是一个**名字里带反斜杠的文件**（`tools\verify-doc-anchors.mjs`），
 * `existsSync(join(root, 'tools/verify-doc-anchors.mjs'))` 永远看不到它 ⇒ CI 上成片报
 * 「点到的 `tools/*.mjs` 不在仓库里（文件不存在）」；而 Windows 的 NTFS 把 `\` 当分隔符，
 * 同一段代码在本机「看起来没问题」。所以路径构造必须在源码层就与平台分隔符无关。
 */
function stubPath(root, token) {
  return join(root, ...String(token).split('/'));
}

/** 去掉注释后的源码：源码层断言只看**代码**，不看散文（注释里会举反例，那是给读者看的）。 */
function codeOnly(source) {
  return String(source)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

/** 一份命令清单里出现的**全部**仓内路径记号（去重、保序）。 */
function referencedPaths(commands) {
  const tokens = new Set();
  for (const command of commands) {
    for (const token of pathTokens(command)) tokens.add(token);
  }
  return [...tokens];
}

/**
 * 夹具里「会被判据 3 对账」的命令面：演练计划 + `package.json` 脚本值 +
 * 每个 workflow 的 `run:` 行 + 真库臂。夹具的占位文件**只按这份清单生成**，
 * 不手抄白名单——这样「夹具自带全部被引用目标」是推导出来的，不是记出来的。
 */
function referencedCommands(scripts, workflows, arms) {
  const commands = [
    ...DRILL_PLAN.map((entry) => entry.command),
    ...Object.values(scripts),
    ...arms.map((arm) => `node ${arm}`),
  ];
  for (const text of Object.values(workflows)) {
    for (const line of String(text).split('\n')) {
      const run = /^\s*- run:\s*(.+)$/.exec(line);
      if (run !== null) commands.push(run[1].trim());
    }
  }
  return commands;
}

/** 造 15 个 workflow：第 1 个承载「出处」文本，其余只贡献 job 数（下限 25）。 */
function workflowTexts(arms) {
  const runLines = [
    '      - run: node --test tests/ui-unified-states.test.mjs',
    '      - run: node --test tests/demo-ui-components.test.mjs',
    '      - run: node tools/run-python.mjs tools/validate_contracts.py',
    '      - run: node tools/run-python.mjs tools/test_contracts.py',
    '      - run: node tools/run-python.mjs tools/validate_openapi_standard.py',
    '      - run: node tools/verify-migrations-unique.mjs --annotations',
    '      - run: node tests/integration/catalog-pg.mjs',
    '      - run: node tests/integration/retention-purge-pg.mjs',
    '      - run: node tests/integration/admin-audit-logs-pg.mjs',
    ...arms.map((arm) => `      - run: node ${arm}`),
  ];
  const drill = [
    'name: fixture-drill',
    'on:',
    '  push:',
    '    branches:',
    '      - main',
    '  paths:',
    "    - 'tests/**.mjs'",
    'jobs:',
    '  static-gates:',
    '    runs-on: ubuntu-24.04',
    '    steps:',
    '      - uses: actions/checkout@v4',
    ...runLines,
    '  real-pg:',
    '    runs-on: ubuntu-24.04',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - run: node tests/integration/catalog-pg.mjs',
    '',
  ].join('\n');
  const texts = { 'fixture-drill.yml': drill };
  for (let index = 1; index <= 14; index += 1) {
    const name = `fixture-extra-${String(index).padStart(2, '0')}.yml`;
    texts[name] = [
      `name: fixture-extra-${index}`,
      'on:',
      '  pull_request:',
      '    branches:',
      '      - main',
      'jobs:',
      `  gate-a-${index}:`,
      '    runs-on: ubuntu-24.04',
      '    steps:',
      '      - run: node --version',
      `  gate-b-${index}:`,
      '    runs-on: ubuntu-24.04',
      '    steps:',
      '      - run: node --version',
      '',
    ].join('\n');
  }
  return texts;
}

/**
 * 造夹具树。返回 `{root, docText, tree, arms, stubs}`：
 * `docText` 是一份**与树一致**的证据页（基线，check 应绿），`stubs` 是夹具自带的被引用目标。
 *
 * `options.omitStubs` 故意少造若干占位（负向用例：判据 3 必须红并点名）；
 * `options.withStubs === false` 造一棵「一个占位都没有」的树（CI 语义的极端版）。
 */
function buildFixture(options = {}) {
  const { omitStubs = [], withStubs = true } = options;
  const root = mkdtempSync(join(tmpdir(), 'gy-g-drill-fixture-'));
  // 1) 真库臂清单：直接复制真文件（⛔ 不复写它的基线；只借它的「臂清单」这一段形状）。
  mkdirSync(join(root, 'tests', 'unit'), { recursive: true });
  copyFileSync(join(REPO_ROOT, 'tests', 'unit', 'ci-real-pg-readings-gates.test.mjs'), join(root, 'tests', 'unit', 'ci-real-pg-readings-gates.test.mjs'));
  const arms = realPgArms(root);
  assert.ok(arms.length > 0, '夹具树里读不到真库臂清单');

  // 2) package.json 与 workflow。
  const scripts = fixtureScripts();
  writeFixtureFile(join(root, 'package.json'), `${JSON.stringify({ name: 'fixture', scripts }, null, 2)}\n`);
  const workflows = workflowTexts(arms);
  for (const [name, text] of Object.entries(workflows)) {
    writeFixtureFile(join(root, '.github', 'workflows', name), text);
  }

  // 3) 夹具树**自带全部被引用目标**：不手抄白名单，直接按命令面解析 `pathTokens()`
  //    （演练计划 + scripts 值 + 每条 workflow 的 `run:` 行 + 真库臂），逐个在夹具根下落成占位文件。
  //    路径由 `stubPath()` 按 `/` 切分构造 ⇒ POSIX 与 Windows 造出的是同一棵树。
  const stubs = referencedPaths(referencedCommands(scripts, workflows, arms));
  if (withStubs) {
    for (const token of stubs) {
      if (omitStubs.includes(token)) continue;
      writeFixtureFile(stubPath(root, token), '// fixture stub\n');
    }
  }

  // 4) 五个 glob 目录凑够 490 个测试文件（判据 4 的下界；五条 glob 的和必须等于总数）。
  const shape = [430, 20, 8, 26, 6];
  UNIT_GLOB_DIRS.forEach((dir, index) => {
    for (let file = 0; file < shape[index]; file += 1) {
      writeFixtureFile(join(root, dir, `case-${String(file).padStart(3, '0')}.test.mjs`), '// fixture test\n');
    }
  });

  // 5) `docs/verification/*.md` 凑够 297 个（判据 4 的下界）。
  for (let file = 0; file < 297; file += 1) {
    writeFixtureFile(join(root, 'docs', 'verification', `page-${String(file).padStart(3, '0')}.md`), '# fixture page\n');
  }

  // 6) 基线文档：块由同一个渲染器生成，树与块**一致**（`--check` 应绿）。
  const tree = computeTreeReadings(root);
  const rows = DRILL_PLAN.map((entry) => makeRow({
    command: entry.command,
    exit: 0,
    readout: entry.kind === 'tap'
      ? 'tests 4 / pass 4 / fail 0 / skipped 0 / todo 0 / 12ms'
      : '耗时 5ms',
    sha: FIXTURE_SHA,
    host: FIXTURE_HOST,
    at: FIXTURE_AT,
  }));
  const block = renderDrillBlock({ tree, rows });
  const docText = [
    '# 夹具证据页',
    '',
    '块外散文：这一段归人写，闸门不碰。',
    '',
    block,
    '',
    '块外散文：结尾。',
    '',
  ].join('\n');
  return { root, docText, tree, arms, stubs };
}

let fixture;

before(() => {
  fixture = buildFixture();
});

after(() => {
  if (fixture?.root) rmSync(fixture.root, { recursive: true, force: true });
});

/** 在夹具上跑八条判据；`isAncestor` 恒 true（夹具不是 git 仓库）。 */
function check(docText, root = fixture.root) {
  return checkDocument({ root, docText, isAncestor: () => true });
}

/** 工具：把文档里的某段文本换成另一段（**不改树**），并保持基线可还原。 */
function mutated(docText, from, to) {
  assert.ok(docText.includes(from), `夹具文档里找不到要替换的片段：${from}`);
  const next = docText.replace(from, to);
  assert.notEqual(next, docText, '替换必须真的改动文档（否则这条变异没有意义）');
  return next;
}

// ─────────────────────────────────────────────────────────────────────────────
describe('夹具基线：树与文档块一致时 --check 必须绿', () => {
  it('八条判据全过（判据 4 的下界由夹具树满足：15 workflow / 30 job / 21 条命令 / 490+ 测试 / 297 页）', () => {
    const result = check(fixture.docText);
    assert.deepEqual(result.problems, [], `基线不该有问题，实际：\n${result.problems.map((item) => `[判据 ${item.criterion}] ${item.message}`).join('\n')}`);
    assert.equal(result.ok, true);
  });

  it('夹具树读数与真仓形状一致：21 条演练命令、15 个 workflow、五个 glob 的合计等于总数', () => {
    const tree = computeTreeReadings(fixture.root);
    assert.equal(DRILL_PLAN.length, 21);
    assert.equal(tree.workflows, 15);
    assert.equal(tree.totalTestFiles, tree.unitGlobUnion);
    assert.ok(tree.totalTestFiles >= 490, `glob 合计 ${tree.totalTestFiles} 不足 490`);
    assert.equal(tree.verificationDocs, 297);
    assert.ok(tree.workflowJobs >= 25, `job 数 ${tree.workflowJobs} 不足 25`);
    assert.deepEqual(tree.warnings, []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('M1 文档改数：块里把总数加 1 ⇒ 判据 2 红并点名 totalTestFiles', () => {
  it('报错原文是「totalTestFiles：文档写 N+1，重算 N」，且整块比对也报第一处差异', () => {
    const base = fixture.tree.totalTestFiles;
    const broken = mutated(fixture.docText, `| totalTestFiles | ${base} |`, `| totalTestFiles | ${base + 1} |`);
    const result = check(broken);
    assert.equal(result.ok, false);
    const messages = result.problems.map((item) => item.message);
    assert.ok(
      messages.some((message) => message === `totalTestFiles：文档写 ${base + 1}，重算 ${base}`),
      `没有点名 totalTestFiles，实际：\n${messages.join('\n')}`,
    );
    assert.ok(messages.some((message) => /^第一处差异：文档第 \d+ 行 vs 重算第 \d+ 行/.test(message)), '整块比对没有报第一处差异');
    assert.ok(result.problems.some((item) => item.criterion === 2));
    // 逐字节还原：基线快照没被这条变异污染。
    assert.equal(check(fixture.docText).ok, true);
  });

  it('单键点名：globFiles.unit 漂了 ⇒ 「globFiles.unit：文档写 N+1，重算 N」', () => {
    const base = fixture.tree.globs[0].files.length;
    const broken = mutated(fixture.docText, `| globFiles.unit | ${base} |`, `| globFiles.unit | ${base + 1} |`);
    const messages = check(broken).problems.map((item) => item.message);
    assert.ok(messages.some((message) => message === `globFiles.unit：文档写 ${base + 1}，重算 ${base}`), messages.join('\n'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('M2 采集注水：某条命令换成 node -e "process.exit(0)"', () => {
  it('判据 3 红并点名「不在 package.json/workflow 文本里」', () => {
    const broken = mutated(
      fixture.docText,
      '`node tools/verify-purge-schedule.mjs`',
      '`node -e "process.exit(0)"`',
    );
    const result = check(broken);
    assert.equal(result.ok, false);
    const messages = result.problems.map((item) => item.message);
    assert.ok(
      messages.some((message) => message.includes('不在 package.json/workflow 文本里')),
      `没有点名注水命令，实际：\n${messages.join('\n')}`,
    );
    assert.ok(result.problems.some((item) => item.criterion === 3));
    assert.ok(messages.some((message) => message.includes('不在演练计划里')), '计划外的命令也必须点名');
  });

  it('正向：计划里每条命令在夹具树里都能找到出处（三处来源之一）', () => {
    const sources = collectSources(fixture.root);
    const failed = [];
    for (const entry of DRILL_PLAN) {
      const traced = traceCommand(entry.command, sources, fixture.root);
      if (!traced.ok) failed.push(`${entry.command} → ${traced.reason}`);
    }
    assert.deepEqual(failed, [], `夹具树里应当每条命令都有出处：\n${failed.join('\n')}`);
    // 出处不只是「存在」：每条至少给出一条具体来源（`package.json#scripts.x` 或 `workflow:行号`）。
    for (const entry of DRILL_PLAN) {
      const traced = traceCommand(entry.command, sources, fixture.root);
      assert.ok(Array.isArray(traced.sources) && traced.sources.length > 0, `${entry.command} 没有给出出处`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('M3 删行：从块里删掉一整行 ⇒ 整块比对 exit 1 并打印第一处差异', () => {
  it('删「workflowJobs」那一行，报「文档第 N 行 vs 重算第 M 行」', () => {
    const block = parseDrillBlock(fixture.docText);
    const lines = fixture.docText.split('\n');
    const target = lines.findIndex((line) => line.startsWith('| workflowJobs |'));
    assert.ok(target > 0);
    const broken = [...lines.slice(0, target), ...lines.slice(target + 1)].join('\n');
    assert.equal(broken.split('\n').length, lines.length - 1);

    const result = check(broken);
    assert.equal(result.ok, false);
    const messages = result.problems.map((item) => item.message);
    const diff = messages.find((message) => message.startsWith('第一处差异：'));
    assert.ok(diff !== undefined, `没有第一处差异文案，实际：\n${messages.join('\n')}`);
    assert.match(diff, new RegExp(`^第一处差异：文档第 ${target + 1} 行 vs 重算第 ${target - block.startLine + 2} 行`));
    assert.ok(diff.includes('| workflowJobs |'));

    // 逐字节还原后必须重新变绿。
    assert.equal(check(fixture.docText).ok, true);
  });

  it('反向：整块比对对「只多一个空格」也红（不是只比数字）', () => {
    const broken = mutated(fixture.docText, '| workflows | 15 |', '|  workflows | 15 |');
    const messages = check(broken).problems.map((item) => item.message);
    assert.ok(messages.some((message) => message.startsWith('第一处差异：')), messages.join('\n'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('M4 同义反复：把比较改成「文档值 := 重算值」后，M1 那条断言必须失效', () => {
  /** 同义反复版判据 2：不再读文档里的数字，直接把重算值写进「文档读数」。 */
  function tautologicalReadingsProblems(docText, tree) {
    const parsed = parseDrillBlock(docText);
    const rewritten = new Map(parsed.readings);
    for (const [key, value] of parsed.readings) rewritten.set(key, value); // 无操作
    // 「文档值 := 重算值」——这就是同义反复：任何文档都会被判成一致。
    const docValue = (key) => tree.totalTestFiles ?? rewritten.get(key);
    return docValue('totalTestFiles') === tree.totalTestFiles ? [] : ['never'];
  }

  it('真实现：文档写 N+1、重算 N ⇒ 报错', () => {
    const base = fixture.tree.totalTestFiles;
    const broken = mutated(fixture.docText, `| totalTestFiles | ${base} |`, `| totalTestFiles | ${base + 1} |`);
    const messages = check(broken).problems.map((item) => item.message);
    assert.ok(messages.includes(`totalTestFiles：文档写 ${base + 1}，重算 ${base}`));
  });

  it('同义反复实现：同一份文档被判成「一致」⇒ 证明真实现不是同义反复', () => {
    const base = fixture.tree.totalTestFiles;
    const broken = mutated(fixture.docText, `| totalTestFiles | ${base} |`, `| totalTestFiles | ${base + 1} |`);
    const tree = computeTreeReadings(fixture.root);
    assert.deepEqual(tautologicalReadingsProblems(broken, tree), [], '同义反复版必须「看不出问题」——这正是它该被单测抓住的地方');
    // 换回真实现，同一份文档立刻红：两条路给出**不同**结论，才说明真实现真的在读文档。
    assert.equal(check(broken).ok, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('读数解析器：日志 → 读数 → Markdown 单元格', () => {
  it('TAP 汇总行取最后一次出现（嵌套 node --test 会打多份）', () => {
    const log = [
      '# tests 3',
      '# pass 3',
      '# fail 0',
      '# skipped 0',
      '# todo 0',
      '# duration_ms 10',
      '# tests 461',
      '# pass 459',
      '# fail 0',
      '# skipped 2',
      '# todo 0',
      '# duration_ms 91234.5',
    ].join('\n');
    const tap = parseTapSummary(log);
    assert.deepEqual(
      { tests: tap.tests, pass: tap.pass, fail: tap.fail, skipped: tap.skipped, todo: tap.todo, durationMs: tap.durationMs },
      { tests: 461, pass: 459, fail: 0, skipped: 2, todo: 0, durationMs: 91234.5 },
    );
  });

  it('没有 TAP 汇总行时返回 null（不许把「耗时」伪装成通过数）', () => {
    assert.equal(parseTapSummary('随便什么日志\n[ALL PASS]\n'), null);
  });

  it('summarizeLog 同时认出 READINGS= 与 [ALL PASS]', () => {
    const summary = summarizeLog('READINGS=8\n[ALL PASS]\n');
    assert.equal(summary.readings, 8);
    assert.equal(summary.allPass, true);
  });

  it('renderReadout 三种形状各自固定，parseReadoutTap 能原样读回', () => {
    const tap = summarizeLog('# tests 4\n# pass 3\n# fail 1\n# skipped 0\n# todo 0\n');
    const tapCell = renderReadout('tap', tap, 1234.4);
    assert.equal(tapCell, 'tests 4 / pass 3 / fail 1 / skipped 0 / todo 0 / 1234ms');
    assert.deepEqual(parseReadoutTap(tapCell), { tests: 4, pass: 3, fail: 1, skipped: 0, todo: 0, durationMs: 1234 });
    assert.equal(renderReadout('gate', summarizeLog(''), 12), '耗时 12ms');
    assert.equal(renderReadout('pg', summarizeLog('READINGS=8\n'), 5), 'READINGS=8 / 5ms');
  });

  it('算术不自洽会红：tests 写成 4 而 pass+fail+skipped+todo = 5', () => {
    const rows = parseRows([
      '#### 一次性实测（不可复算：只存当时值 + sha + 主机 + 时刻）',
      '',
      '| # | 命令 | exit | 读数 | sha | 主机 | 时刻（ISO 8601） |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      `| 1 | \`${DRILL_PLAN[0].command}\` | 0 | tests 4 / pass 5 / fail 0 / skipped 0 / todo 0 / 1ms | \`@ ${FIXTURE_SHA}\` | 本机 fixture-host | ${FIXTURE_AT} |`,
    ].join('\n'));
    const problems = arithmeticProblems(computeTreeReadings(fixture.root), rows);
    assert.ok(problems.some((message) => /算术不自洽：.*tests 4，而 pass 5/.test(message)), problems.join('\n'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('判据 1 / 6 / 7 / 8 各自能单独红（每条都点名）', () => {
  it('判据 1：标记块出现两处 ⇒ 红并报行号', () => {
    const broken = `${fixture.docText}\n<!-- G-DRILL:BEGIN -->\n<!-- G-DRILL:END -->\n`;
    const messages = parseDrillBlock(broken).problems;
    assert.ok(messages.some((message) => /出现 2 处（第 .* 行）/.test(message)), messages.join('\n'));
    assert.ok(check(broken).problems.some((item) => item.criterion === 1));
  });

  it('判据 1：只有一个 END ⇒ 红（缺 BEGIN）', () => {
    const broken = fixture.docText.replace('<!-- G-DRILL:BEGIN -->', '');
    assert.ok(parseDrillBlock(broken).problems.some((message) => message.includes('没有 `<!-- G-DRILL:BEGIN -->`')));
  });

  it('判据 6：sha 不是 40 位 hex ⇒ 红；host 空 / 时刻不是 ISO ⇒ 红', () => {
    const rows = parseRows([
      '#### 一次性实测（不可复算：只存当时值 + sha + 主机 + 时刻）',
      '',
      '| # | 命令 | exit | 读数 | sha | 主机 | 时刻（ISO 8601） |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      `| 1 | \`${DRILL_PLAN[0].command}\` | 0 | 耗时 5ms | \`@ abc123\` | 本机  | 2026-10-28 00:00 |`,
    ].join('\n'));
    const problems = oneShotProblems(rows, { isAncestor: () => true });
    assert.ok(problems.some((message) => /sha 是 `abc123` ⇒ 必须是 40 位小写 hex/.test(message)), problems.join('\n'));
    assert.ok(problems.some((message) => /没有写 host/.test(message)), problems.join('\n'));
    assert.ok(problems.some((message) => /不是 ISO 8601/.test(message)), problems.join('\n'));
  });

  it('判据 6：sha 能解析但不是 HEAD 的祖先 ⇒ 红', () => {
    const rows = DRILL_PLAN.map((entry) => makeRow({
      command: entry.command,
      exit: 0,
      readout: '耗时 1ms',
      sha: 'b'.repeat(40),
      host: 'h',
      at: FIXTURE_AT,
    }));
    const problems = oneShotProblems(rows, { isAncestor: () => false });
    assert.ok(problems.some((message) => /不是 HEAD 的祖先/.test(message)), problems.join('\n'));
  });

  it('判据 7：块里写「通过」但没有 @ sha 与「本机」⇒ 红', () => {
    const messages = ciGreenProblems('| 1 | `npm run test:unit` | 0 | 通过 |', 40);
    assert.ok(messages.some((message) => message.includes('文档第 40 行') && message.includes('「本机」')), messages.join('\n'));
    assert.deepEqual(ciGreenProblems(`| 1 | \`x\` | 0 | 通过 @ ${FIXTURE_SHA} 本机 |`, 1), []);
  });

  it('判据 8：未跑但原因空着 / 原因不在白名单 ⇒ 都红；给了白名单原因 ⇒ 绿', () => {
    const vacuous = vacuousProblems([{ entry: 'node tests/integration/x-pg.mjs', marker: '未跑', reason: '' }]);
    assert.ok(vacuous.some((message) => message.includes('原因空着')), vacuous.join('\n'));
    const vague = vacuousProblems([{ entry: 'node tests/integration/x-pg.mjs', marker: '未跑', reason: '懒得跑' }]);
    assert.ok(vague.some((message) => message.includes('没有落在白名单')), vague.join('\n'));
    assert.deepEqual(vacuousProblems([{ entry: 'node tests/integration/x-pg.mjs', marker: '未跑', reason: PG_ARM_NOT_RUN_REASON }]), []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('反空转补丁（N1）与 --live 归因（B1 / N5）', () => {
  it('N1：`DEFAULT_FLOORS.realPgArms` 有下界；臂数单独出成数值，清空就算得出「实测 0」', () => {
    assert.equal(DEFAULT_FLOORS.realPgArms, 13, '`realPgArms` 必须有下界，否则臂清单变空时判据 4 会静默绿');
    const tree = computeTreeReadings(fixture.root);
    assert.equal(tree.realPgArms, tree.arms.length, '`realPgArms` 必须与臂数组同源');
    assert.ok(tree.realPgArms >= DEFAULT_FLOORS.realPgArms, `夹具臂数 ${tree.realPgArms} 不足下界`);
    // `arms` 是数组、`structureProblems` 只认数值：这里证明「数组空了」确实能变成一条红。
    const problems = structureProblems({ ...tree, arms: [], realPgArms: 0 });
    assert.ok(
      problems.some((message) => message === '反空转下界破了：realPgArms 实测 0 < 下界 13'),
      problems.join('\n'),
    );
  });

  it('N1：臂清单真的解析成 0 条（闸门单测被删）⇒ 判据 4 红，臂覆盖面也点名 0 条', () => {
    const gatePath = join(fixture.root, ...REAL_PG_GATE_TEST.split('/'));
    const saved = readFileSync(gatePath, 'utf8');
    try {
      rmSync(gatePath, { force: true });
      const result = check(fixture.docText);
      assert.equal(result.ok, false, '臂清单为空时必须红，不许静默绿');
      const messages = result.problems.map((item) => item.message);
      assert.ok(result.problems.some((item) => item.criterion === 4), `判据 4 没红：\n${messages.join('\n')}`);
      assert.ok(messages.some((message) => message.includes('realPgArms 实测 0 < 下界 13')), messages.join('\n'));
      assert.ok(messages.some((message) => message.includes('解析真库臂得到 0 条')), messages.join('\n'));
    } finally {
      writeFileSync(gatePath, saved, 'utf8');
    }
    assert.equal(check(fixture.docText).ok, true, '恢复臂清单后基线必须回到绿');
  });

  it('B1：`--live` 的条数从 `DRILL_PLAN` 数出来（11 条），不再写死 12', () => {
    const staticCount = DRILL_PLAN.filter((entry) => entry.group === 'static').length;
    assert.equal(staticCount, 11, '静态闸门就是 11 条（`--help` 与块里都这么写）');
    assert.equal(liveSuccessMessage([]), `  ✓ --live：可复算类 ${staticCount} 条静态闸门与块里的读数一致`);
    const withSkip = liveSuccessMessage(['lint']);
    assert.ok(withSkip.includes('10 条与块里的读数一致'), withSkip);
    assert.ok(withSkip.includes('环境缺失、未校验'), withSkip);
    assert.ok(withSkip.includes('按 SKIP 计'), withSkip);
  });

  it('N5：工具链缺失（无 node_modules）认成环境问题，不当「读数与提交不符」', () => {
    assert.equal(environmentFailure('npm error 未找到本地 TypeScript（缺 node_modules？）'), '未找到本地');
    assert.equal(environmentFailure("Error: Cannot find module 'eslint'"), 'Cannot find module');
    // 没有 node_modules 的副本上，`openapi-route-parity` 打的是「Cannot find package」而不是 module。
    assert.equal(environmentFailure("Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'fastify' imported from app.ts"), 'Cannot find package');
    assert.equal(environmentFailure('tests 1 / pass 1 / fail 0 / skipped 0 / todo 0 / 1ms'), null);
    assert.equal(environmentFailure(''), null);
  });

  it('r2-B2：有 SKIP 时 `--live` 不再 exit 0（0 只留给「一条都没被跳过」）', () => {
    assert.equal(liveExitCode([]), 0, '11 条全跑过才配 0');
    assert.equal(liveExitCode(['lint']), 2, '有一条按 SKIP 计就不是通过');
    assert.equal(liveExitCode(['lint', 'unit']), 2);
    // 文案与退出码必须是同一份事实：末行自己承认「不是通过」，退出码就不能是 0。
    assert.ok(liveSuccessMessage(['lint']).includes('这不是通过'), liveSuccessMessage(['lint']));
  });

  it('r2-B1：`readDirty` 记录采集时工作区干不干净（非 git 目录按干净处理，不抛）', () => {
    assert.deepEqual(readDirty(join(tmpdir(), 'gy-g-drill-not-a-repo')), { dirty: false, paths: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('出处：traceCommand 认三处来源，也认「没有出处」', () => {
  it('npm run <名字> 走 package.json；node <脚本> 走 workflow 文本；注水命令必红', () => {
    const sources = {
      scripts: { 'test:unit': 'node --test "tests/unit/*.test.mjs"' },
      workflows: [{ name: 'x.yml', text: 'jobs:\n  a:\n    steps:\n      - run: node tools/verify-x.mjs\n' }],
      failmatrix: '',
    };
    writeFixtureFile(join(fixture.root, 'tools', 'verify-x.mjs'), '// stub\n');
    assert.deepEqual(traceCommand('npm run test:unit', sources, fixture.root), { ok: true, sources: ['package.json#scripts.test:unit'] });
    const viaWorkflow = traceCommand('node tools/verify-x.mjs', sources, fixture.root);
    assert.equal(viaWorkflow.ok, true);
    assert.deepEqual(viaWorkflow.sources, ['.github/workflows/x.yml:4（run: 文本）']);
    const injected = traceCommand('node -e "process.exit(0)"', sources, fixture.root);
    assert.equal(injected.ok, false);
    assert.ok(injected.reason.includes('不在 package.json/workflow 文本里'), injected.reason);
    const unknown = traceCommand('npm run no-such-script', sources, fixture.root);
    assert.equal(unknown.ok, false);
    assert.ok(unknown.reason.includes('不在 package.json/workflow 文本里'), unknown.reason);
  });

  it('命令点到的脚本在树里不存在 ⇒ 红（不能靠一段文本糊过去）', () => {
    const sources = { scripts: {}, workflows: [{ name: 'y.yml', text: '      - run: node tools/ghost.mjs\n' }], failmatrix: '' };
    const traced = traceCommand('node tools/ghost.mjs', sources, fixture.root);
    assert.equal(traced.ok, false);
    assert.ok(traced.reason.includes('不在仓库里'), traced.reason);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('平台无关：夹具树自带全部被引用目标（判据 3 真的在看磁盘）', () => {
  const LIB_PATH = join(REPO_ROOT, 'tools', 'lib', 'g-drill-readings.mjs');

  it('占位路径按 `/` 切分构造（不许把分隔符改写成平台字面量）', () => {
    // ⚠ 这条**必须**是源码层断言：`replace(/\//g, '\\')` 在 Windows 上语义不可见
    // （NTFS 把 `\` 当分隔符，造出的还是 `tools/…`），行为断言在本机永远绿；
    // 只有 POSIX runner 会把它变成「名字里带反斜杠的文件」⇒ 判据 3 成片红。
    const source = codeOnly(readFileSync(new URL(import.meta.url), 'utf8'));
    assert.equal(
      /\.replace\(\s*\/\\\/\/g\s*,\s*['"]\\\\['"]\s*\)/.test(source),
      false,
      '夹具的占位路径不许把 `/` 改写成 `\\`：POSIX 上那会造出 `tools\\x.mjs` 这种文件名，判据 3 永远找不到',
    );
    // 纯拼接语义自证：记号里的 `/` 就是层级，与平台分隔符无关。
    assert.equal(stubPath('/r', 'a/b/c.mjs').split(sep).join('/'), '/r/a/b/c.mjs');
    assert.equal(stubPath('/r', 'tools/x.mjs').split(sep).join('/'), '/r/tools/x.mjs');
  });

  it('每条被引用命令的每个路径记号都在夹具根下真实存在', () => {
    const tokens = fixture.stubs;
    assert.ok(tokens.length >= 20, `夹具自带的占位太少（${tokens.length} 条）⇒ 判据 3 会被绕空`);
    for (const token of tokens) {
      assert.equal(token.includes('\\'), false, `记号必须是 \`/\` 归一：${token}`);
      assert.equal(existsSync(stubPath(fixture.root, token)), true, `夹具没自带被引用目标：${token}`);
    }
    // 反证：夹具根与 tools/ 下不许出现「名字里带反斜杠」的文件（那正是 CI 上的错法）。
    for (const entry of readdirSync(fixture.root)) {
      assert.equal(entry.includes('\\'), false, `夹具根下出现了带反斜杠的名字：${entry}`);
    }
    for (const entry of readdirSync(join(fixture.root, 'tools'))) {
      assert.equal(entry.includes('\\'), false, `tools/ 下出现了带反斜杠的名字：${entry}`);
    }
  });

  it('lib 里没有隐式根兜底：root 一律由调用方显式传入', () => {
    const source = codeOnly(readFileSync(LIB_PATH, 'utf8'));
    assert.equal(
      source.includes('process.cwd'),
      false,
      'lib 里出现了 process.cwd() 兜底 ⇒ 夹具树与真仓会走同一条隐式回退（判据 3 就可能在错根上「看起来存在」）',
    );
    assert.equal(
      /existsSync\(join\(root, token\)\)/.test(source),
      false,
      '存在性检查必须按 `/` 切分记号：`join(root, ...String(token).split(\'/\'))`',
    );
    // 结构性断言：这些函数必须显式收 root（去掉参数或加默认值都会让 arity 变）。
    assert.equal(traceCommand.length, 3, 'traceCommand 必须显式收 root：(command, sources, root)');
    assert.equal(collectSources.length, 1, 'collectSources 必须显式收 root');
    assert.equal(computeTreeReadings.length, 1, 'computeTreeReadings 必须显式收 root');
    assert.equal(realPgArms.length, 1, 'realPgArms 必须显式收 root');
  });

  it('负向：删掉一个占位 ⇒ 判据 3 必须红并点名该文件（证明检查在看磁盘，不是白名单）', () => {
    const missing = 'tools/verify-doc-anchors.mjs';
    const isolated = buildFixture({ omitStubs: [missing] });
    try {
      assert.equal(existsSync(stubPath(isolated.root, missing)), false, '负向夹具必须真的少这一个文件');
      const result = checkDocument({ root: isolated.root, docText: isolated.docText, isAncestor: () => true });
      assert.equal(result.ok, false, '少了一个被引用目标却仍然绿 ⇒ 判据 3 没在看磁盘');
      const hit = result.problems.find((problem) => problem.criterion === 3 && problem.message.includes(`\`${missing}\``));
      assert.ok(
        hit !== undefined,
        `判据 3 没点名 ${missing}，实际问题：\n${result.problems.map((item) => `[判据 ${item.criterion}] ${item.message}`).join('\n')}`,
      );
      assert.ok(hit.message.includes('不在仓库里'), hit.message);
      // 这条红必须**只**由「夹具缺占位」引起：别的判据一条都不许红。
      assert.deepEqual(
        result.problems.filter((problem) => problem.criterion !== 3).map((item) => `[判据 ${item.criterion}] ${item.message}`),
        [],
      );
    } finally {
      rmSync(isolated.root, { recursive: true, force: true });
    }
  });

  it('负向：一个占位都没有的夹具（CI 语义的极端版）⇒ 判据 3 成片红，文案固定是「不在仓库里」', () => {
    const isolated = buildFixture({ withStubs: false });
    try {
      const result = checkDocument({ root: isolated.root, docText: isolated.docText, isAncestor: () => true });
      assert.equal(result.ok, false, '没有任何被引用目标却仍然绿 ⇒ 存在性检查被绕过了');
      const crit3 = result.problems.filter((problem) => problem.criterion === 3);
      assert.ok(crit3.length >= 10, `判据 3 只红了 ${crit3.length} 条，看不到成片的缺占位`);
      for (const problem of crit3) assert.ok(problem.message.includes('不在仓库里'), problem.message);
      // 读数类判据不受影响：占位文件只解决「出处」，不参与计数。
      assert.deepEqual(result.problems.filter((problem) => problem.criterion === 2), []);
    } finally {
      rmSync(isolated.root, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('--update 只换块内，块外一个字节都不动', () => {
  it('spliceBlock 保留前后散文；rowsFromReadings 缺条时拒绝写半张表', () => {
    const readings = {
      sha: FIXTURE_SHA,
      host: FIXTURE_HOST,
      startedAt: FIXTURE_AT,
      commands: DRILL_PLAN.map((entry) => ({
        command: entry.command,
        exit: 0,
        readout: entry.kind === 'tap' ? 'tests 4 / pass 4 / fail 0 / skipped 0 / todo 0 / 9ms' : '耗时 9ms',
      })),
    };
    assert.equal(rowsFromReadings(readings).length, DRILL_PLAN.length);
    assert.throws(() => rowsFromReadings({ ...readings, commands: readings.commands.slice(0, 3) }), /拒绝写半张表/);

    const tree = computeTreeReadings(fixture.root);
    const block = renderDrillBlock({ tree, rows: rowsFromReadings(readings) });
    const spliced = spliceBlock(fixture.docText, block);
    const before = fixture.docText.split('\n').slice(0, parseDrillBlock(fixture.docText).startLine - 1);
    const after = fixture.docText.split('\n').slice(parseDrillBlock(fixture.docText).endLine);
    assert.deepEqual(spliced.split('\n').slice(0, before.length), before);
    assert.deepEqual(spliced.split('\n').slice(-after.length), after);
    assert.equal(check(spliced).ok, true);
  });

  it('normalizeDrillBlock 把 CRLF 与行尾空白抹平（不然 Windows 上每次检出都「手改」）', () => {
    assert.equal(normalizeDrillBlock('a\r\nb  \r\n\r\n'), 'a\nb');
    assert.equal(compareDrillBlock('a\r\nb', 'a\nb', 7), null);
    assert.match(compareDrillBlock('a\nb', 'a\nc', 7), /^第一处差异：文档第 8 行 vs 重算第 2 行/);
  });

  it('markerLines 报的是 1 基行号；parseDrillBlock 的 startLine/endLine 指向 BEGIN/END 两行', () => {
    const { begins, ends } = markerLines(fixture.docText);
    assert.equal(begins.length, 1);
    assert.equal(ends.length, 1);
    const parsed = parseDrillBlock(fixture.docText);
    assert.equal(fixture.docText.split('\n')[parsed.startLine - 1].trim(), '<!-- G-DRILL:BEGIN -->');
    assert.equal(fixture.docText.split('\n')[parsed.endLine - 1].trim(), '<!-- G-DRILL:END -->');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('生长型读数：下界语义（--tolerant-growth）、防注水与严格口径', () => {
  /** 把块里某几个生长型读数的文档值各减 `drop`（模拟「main 又加了测试文件，页面还没刷新」）。 */
  function dropGrowthValues(docText, drop, keys = ['allTestFiles', 'totalTestFiles', 'unitGlobUnion', 'globFiles.unit']) {
    let next = docText;
    for (const key of keys) {
      const pattern = new RegExp(`\\| ${key.replace(/\./g, '\\.')} \\| (\\d+) \\|`);
      const hit = pattern.exec(next);
      assert.ok(hit !== null, `夹具文档里找不到 \`${key}\` 那一行`);
      next = next.replace(hit[0], `| ${key} | ${Number(hit[1]) - drop} |`);
    }
    return next;
  }

  /** 把块里某个读数的文档值加 `up`（模拟「页面比树里真有的还多」= 注水）。 */
  function bumpReading(docText, key, up = 1) {
    const pattern = new RegExp(`\\| ${key.replace(/\./g, '\\.')} \\| (\\d+) \\|`);
    const hit = pattern.exec(docText);
    assert.ok(hit !== null, `夹具文档里找不到 \`${key}\` 那一行`);
    return docText.replace(hit[0], `| ${key} | ${Number(hit[1]) + up} |`);
  }

  it('分档：稳定型恰为四个，其余全部登记为生长型（新增读数必须分档，不许「未分档」）', () => {
    assert.deepEqual(
      [...STABLE_READINGS].sort(),
      ['drillCommands', 'verificationDocs', 'workflowJobs', 'workflows'].sort(),
      '稳定型就是「workflow / job / 演练命令数 / 页面数」这四个，多一个少一个都要先说清理由',
    );
    const keys = readingsOf(fixture.tree).map((row) => row.key);
    assert.ok(keys.length >= 15, `读数只有 ${keys.length} 条？`);
    for (const key of keys) {
      assert.notEqual(readingKind(key), 'unclassified', `读数 \`${key}\` 没有分档 ⇒ 判据 2 会红`);
    }
    for (const key of GROWTH_READINGS) assert.equal(readingKind(key), 'growth', `${key} 应当是生长型`);
    // 生长型里**不许**混进稳定型：误把 `workflows` 当下界，这条立刻红。
    for (const key of STABLE_READINGS) {
      assert.equal(GROWTH_READINGS.includes(key), false, `\`${key}\` 是稳定型，不许当生长型/下界`);
    }
    for (const key of ['allTestFiles', 'totalTestFiles', 'unitGlobUnion', 'globFiles.unit']) {
      assert.ok(GROWTH_READINGS.includes(key), `\`${key}\` 必须登记为生长型`);
    }
  });

  it('滞后 4 条：--tolerant-growth 绿且逐条给出滞后数；--strict-growth 红并点名', () => {
    const lagged = dropGrowthValues(fixture.docText, 2);
    const tolerant = checkDocument({ root: fixture.root, docText: lagged, isAncestor: () => true });
    assert.deepEqual(
      tolerant.problems.map((item) => `[判据 ${item.criterion}] ${item.message}`),
      [],
      '生长型读数滞后 2 不该判红（那是 main 前进的正常后果）',
    );
    assert.equal(tolerant.ok, true);
    assert.deepEqual(
      tolerant.growth.map((item) => `${item.key} ${item.doc}->${item.expected}(滞后 ${item.lag})`),
      readingsOf(fixture.tree)
        .filter((row) => ['allTestFiles', 'totalTestFiles', 'unitGlobUnion', 'globFiles.unit'].includes(row.key))
        .map((row) => `${row.key} ${row.value - 2}->${row.value}(滞后 2)`),
      '滞后的键、文档值、重算值、滞后数都必须被逐条算出（滞后数要能打印，不许静默）',
    );
    assert.equal(tolerant.problems.filter((item) => item.criterion === 2).length, 0);

    const strict = checkDocument({ root: fixture.root, docText: lagged, isAncestor: () => true, tolerantGrowth: false });
    assert.equal(strict.ok, false, '--strict-growth 下滞后必须红');
    const messages = strict.problems.map((item) => item.message);
    assert.ok(
      messages.some((message) => message.startsWith('allTestFiles：文档写 ') && message.includes('--strict-growth')),
      `--strict-growth 必须点名 allTestFiles 并说明口径，实际：\n${messages.join('\n')}`,
    );
    assert.equal(
      messages.filter((message) => message.startsWith('第一处差异：')).length,
      1,
      '--strict-growth 下整块比对也要报出第一处差异（不许只看单键）',
    );
  });

  it('防注水：文档值 > 重算值 ⇒ 两种口径都红并点名（主牙齿不许松）', () => {
    const base = fixture.tree.allTestFiles;
    const inflated = bumpReading(fixture.docText, 'allTestFiles', 1);
    for (const tolerantGrowth of [true, false]) {
      const result = checkDocument({ root: fixture.root, docText: inflated, isAncestor: () => true, tolerantGrowth });
      assert.equal(result.ok, false, `tolerantGrowth=${tolerantGrowth} 下冒进必须红`);
      assert.ok(
        result.problems.map((item) => item.message).includes(`allTestFiles：文档写 ${base + 1}，重算 ${base}`),
        `没有点名 allTestFiles 冒进：\n${result.problems.map((item) => item.message).join('\n')}`,
      );
      assert.deepEqual(result.growth, [], '冒进不是「滞后」，不许被 growthLag 收进去');
    }
  });

  it('稳定型读数滞后/冒进在两种口径下都红（误把稳定型当下界 ⇒ 这条必红）', () => {
    const shrunk = mutated(fixture.docText, '| workflows | 15 |', '| workflows | 14 |');
    for (const tolerantGrowth of [true, false]) {
      const result = checkDocument({ root: fixture.root, docText: shrunk, isAncestor: () => true, tolerantGrowth });
      assert.equal(result.ok, false, `tolerantGrowth=${tolerantGrowth} 下 workflows 少 1 必须红`);
      assert.ok(
        result.problems.map((item) => item.message).includes('workflows：文档写 14，重算 15'),
        result.problems.map((item) => item.message).join('\n'),
      );
      assert.ok(result.problems.some((item) => item.message.startsWith('第一处差异：')), '整块比对也要红');
      assert.deepEqual(result.growth, [], '稳定型不进 growthLag（它不是「可滞后的生长型」）');
    }
  });

  it('CLI 可观测性：--tolerant-growth 逐行打印「滞后 N」且 exit 0；--strict-growth exit 1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gy-g-drill-doc-'));
    const docPath = join(dir, 'drill.md');
    try {
      writeFileSync(docPath, dropGrowthValues(fixture.docText, 2), 'utf8');
      const run = (extra) => spawnSync(
        process.execPath,
        ['tools/verify-g-drill-readings.mjs', '--check', '--root', fixture.root, '--doc', docPath, ...extra],
        { cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true },
      );
      const tolerant = run([]);
      assert.equal(tolerant.status, 0, `--tolerant-growth 应当 exit 0：\n${tolerant.stdout}\n${tolerant.stderr}`);
      const lagLines = String(tolerant.stdout).split('\n').filter((line) => line.includes('↳'));
      assert.equal(lagLines.length, 4, `应当逐行打印 4 条滞后（不许静默）：\n${tolerant.stdout}`);
      for (const line of lagLines) assert.match(line, /（滞后 2）$/, line);
      assert.match(String(tolerant.stdout), /八条判据全过/);

      const strict = run(['--strict-growth']);
      assert.equal(strict.status, 1, `--strict-growth 应当 exit 1：\n${strict.stdout}`);
      assert.match(String(strict.stderr), /allTestFiles：文档写 \d+，重算 \d+ ⇒ --strict-growth 要求精确相等/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('同一份滞后文档：宽容打印的滞后键与严格点名的键必须完全相等（宽容不许放行别的差异）', () => {
    // 这一条是「真仓自检」两条用例的确定性替身：真仓在本机是 0 条滞后、在 CI 合成树上是 4 条，
    // 分档口径只在「有滞后」时才真的被检验，所以这里用夹具把「有滞后」那一支固定下来。
    const dir = mkdtempSync(join(tmpdir(), 'gy-g-drill-lagkeys-'));
    const docPath = join(dir, 'drill.md');
    try {
      writeFileSync(docPath, dropGrowthValues(fixture.docText, 2), 'utf8');
      const run = (extra) => spawnSync(
        process.execPath,
        ['tools/verify-g-drill-readings.mjs', '--check', '--root', fixture.root, '--doc', docPath, ...extra],
        { cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true },
      );
      const tolerant = run([]);
      assert.equal(tolerant.status, 0, `--tolerant-growth 应当 exit 0：\n${tolerant.stdout}\n${tolerant.stderr}`);
      const lagKeys = String(tolerant.stdout).split('\n')
        .filter((line) => line.includes('↳'))
        .map((line) => (line.match(/↳ 生长型读数滞后：(\S+) /) ?? [])[1])
        .filter(Boolean);
      assert.equal(lagKeys.length, 4, `应当有 4 条滞后键：\n${tolerant.stdout}`);

      const strict = run(['--strict-growth']);
      assert.equal(strict.status, 1, `--strict-growth 应当 exit 1：\n${strict.stdout}`);
      const named = new Set(
        String(strict.stderr).split('\n')
          .map((line) => (line.match(/([A-Za-z][A-Za-z0-9.]*)：文档写 \d+，重算 \d+ ⇒ --strict-growth/) ?? [])[1])
          .filter(Boolean),
      );
      assert.deepEqual([...named].sort(), [...new Set(lagKeys)].sort(), `严格点名的键必须与滞后键一一对应：\n${strict.stderr}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('真仓自检（只读，不写盘）', () => {
  const runCheck = (extra) => spawnSync(process.execPath, ['tools/verify-g-drill-readings.mjs', '--check', ...extra], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });

  it('`node tools/verify-g-drill-readings.mjs --check`（默认 --tolerant-growth）在真仓上 exit 0，且只放行「生长型 + 文档值偏小」的滞后', () => {
    const result = runCheck([]);
    assert.equal(result.status, 0, `--check 在真仓上红了：\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
    assert.match(String(result.stdout), /八条判据全过/);
    assert.match(String(result.stdout), /--tolerant-growth/);
    // ⛔ 不许断言「真仓必须 0 条滞后」：CI 检出的是「本分支 ∪ 最新 main」的合成树，main 每加一个
    // 测试文件 `allTestFiles` 就 +1 ⇒ 合成树上必然有滞后。`#728` 首轮就是这么红的（本机 0 条、
    // CI 4 条），而把断言写成 0 等于要求证据页跟着每个 main 提交手改 —— 那正是本片要消灭的东西。
    // 本用例守的是**放行条件本身**：每一条滞后行都必须是生长型键、文档值严格小于重算值、且
    // 「滞后 N」等于「重算 − 文档」。任何别的差异都不许以滞后形态出现。
    const lagLines = String(result.stdout).split('\n').filter((line) => line.includes('↳'));
    for (const line of lagLines) {
      const matched = line.match(/↳ 生长型读数滞后：(\S+) 文档 (\d+) → 重算 (\d+)（滞后 (\d+)）$/);
      assert.ok(matched, `滞后行格式不符（解析不了的行不许静默放行）：${line}`);
      const [, key, docRaw, expectedRaw, lagRaw] = matched;
      assert.ok(GROWTH_READINGS.includes(key), `只有生长型读数才允许滞后，\`${key}\` 不是：${line}`);
      assert.ok(Number(docRaw) < Number(expectedRaw), `滞后必须是文档值偏小（冒进要红，不许当滞后）：${line}`);
      assert.equal(Number(lagRaw), Number(expectedRaw) - Number(docRaw), `滞后数必须是「重算 − 文档」：${line}`);
    }
    if (lagLines.length > 0) {
      assert.match(String(result.stdout), /生长型读数按\*\*下界\*\*判/, '有滞后时末行必须声明下界口径，不许悄悄过');
    }
  });

  it('`--strict-growth` 与 `--tolerant-growth` 在同一棵树上自洽：宽容只放行滞后，严格点名的键必须与滞后键一一对应', () => {
    const tolerant = runCheck([]);
    const strict = runCheck(['--strict-growth']);
    assert.equal(tolerant.status, 0, `--tolerant-growth 在真仓上红了：\n${tolerant.stdout ?? ''}\n${tolerant.stderr ?? ''}`);
    const lagKeys = String(tolerant.stdout).split('\n')
      .filter((line) => line.includes('↳'))
      .map((line) => (line.match(/↳ 生长型读数滞后：(\S+) /) ?? [])[1])
      .filter(Boolean);
    if (lagKeys.length === 0) {
      // 页与树同一棵树（本机、或合流后恰好没长）⇒ 严格口径也必须过：这就是「闸门没靠宽容口径变绿」。
      assert.equal(strict.status, 0, `零滞后时 --strict-growth 必须也 exit 0：\n${strict.stdout ?? ''}\n${strict.stderr ?? ''}`);
      assert.match(String(strict.stdout), /读数与树逐字相等/);
      return;
    }
    // 有滞后 ⇒ 严格口径必须红，而且**它点名的键集必须与宽容口径打印的滞后键集完全相等**：
    // 多一个就说明宽容口径放行了「滞后以外的差异」，那才是真的变绿；少一个说明滞后没被严格口径看见。
    assert.equal(strict.status, 1, `有 ${lagKeys.length} 条滞后时 --strict-growth 必须 exit 1：\n${strict.stdout ?? ''}`);
    const named = new Set(
      String(strict.stderr).split('\n')
        .map((line) => (line.match(/([A-Za-z][A-Za-z0-9.]*)：文档写 \d+，重算 \d+ ⇒ --strict-growth/) ?? [])[1])
        .filter(Boolean),
    );
    assert.deepEqual(
      [...named].sort(),
      [...new Set(lagKeys)].sort(),
      `严格口径点名的键必须与滞后键一一对应（否则宽容口径放行了别的差异）：\n${strict.stderr ?? ''}`,
    );
  });

  it('真仓的演练计划里每条命令都有出处，且计划本身覆盖 21 条', () => {
    const tree = computeTreeReadings(REPO_ROOT);
    const commands = DRILL_PLAN.map((entry) => entry.command);
    assert.equal(new Set(commands).size, commands.length, '计划里不许有重复命令');
    assert.ok(tree.verifyTestScripts.length > 0);
    // 真库臂闸门单测必须还在（判据 3 的「出处」靠它，本片不复制它的基线）。
    assert.ok(readFileSync(join(REPO_ROOT, 'tests', 'unit', 'ci-real-pg-readings-gates.test.mjs'), 'utf8').includes('READING_GATE_BASELINES'));
  });
});
