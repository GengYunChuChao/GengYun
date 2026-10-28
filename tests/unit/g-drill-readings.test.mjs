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
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_FLOORS,
  DRILL_PLAN,
  PG_ARM_NOT_RUN_REASON,
  REAL_PG_GATE_TEST,
  SCOPE_NOTES,
  UNIT_GLOB_DIRS,
  arithmeticProblems,
  ciGreenProblems,
  compareDrillBlock,
  computeTreeReadings,
  collectSources,
  makeRow,
  markerLines,
  normalizeDrillBlock,
  oneShotProblems,
  parseDrillBlock,
  parseReadoutTap,
  parseRows,
  parseTapSummary,
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

/** 造夹具树。返回 `{root, docText}`：`docText` 是一份**与树一致**的证据页（基线，check 应绿）。 */
function buildFixture() {
  const root = mkdtempSync(join(tmpdir(), 'gy-g-drill-fixture-'));
  // 1) 真库臂清单：直接复制真文件（⛔ 不复写它的基线；只借它的「臂清单」这一段形状）。
  mkdirSync(join(root, 'tests', 'unit'), { recursive: true });
  copyFileSync(join(REPO_ROOT, 'tests', 'unit', 'ci-real-pg-readings-gates.test.mjs'), join(root, 'tests', 'unit', 'ci-real-pg-readings-gates.test.mjs'));
  const arms = realPgArms(root);
  assert.ok(arms.length > 0, '夹具树里读不到真库臂清单');

  // 2) package.json 与 workflow。
  writeFixtureFile(join(root, 'package.json'), `${JSON.stringify({ name: 'fixture', scripts: fixtureScripts() }, null, 2)}\n`);
  for (const [name, text] of Object.entries(workflowTexts(arms))) {
    writeFixtureFile(join(root, '.github', 'workflows', name), text);
  }

  // 3) 出处要用到的占位文件（traceCommand 要求路径记号真实存在）。
  for (const path of [
    'tools/run-python.mjs',
    'tools/validate_development_docs.py',
    'tools/validate_contracts.py',
    'tools/test_contracts.py',
    'tools/validate_openapi_standard.py',
    'tools/placeholder.py',
    'tools/verify-research-records.mjs',
    'tools/verify-contract-status.mjs',
    'tools/verify-doc-anchors.mjs',
    'tools/verify-admin-capability-map.mjs',
    'tools/verify-purge-schedule.mjs',
    'tools/verify-migrations-unique.mjs',
    'tools/openapi-route-parity.mjs',
    'tests/failmatrix/run.mjs',
    'tests/ui-unified-states.test.mjs',
    'tests/demo-ui-components.test.mjs',
    ...DRILL_PLAN.map((entry) => entry.command)
      .map((command) => command.split(/\s+/).find((token) => token.startsWith('tests/')) ?? '')
      .filter((token) => token !== ''),
    ...arms,
  ]) {
    writeFixtureFile(join(root, String(path).replace(/\//g, '\\')), '// fixture stub\n');
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
  return { root, docText, tree, arms };
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
describe('真仓自检（只读，不写盘）', () => {
  it('`node tools/verify-g-drill-readings.mjs --check` 在真仓上 exit 0', () => {
    const result = spawnSync(process.execPath, ['tools/verify-g-drill-readings.mjs', '--check'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(result.status, 0, `--check 在真仓上红了：\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
    assert.match(String(result.stdout), /八条判据全过/);
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
