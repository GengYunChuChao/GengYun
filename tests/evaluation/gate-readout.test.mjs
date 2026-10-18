// GY-I21：评估链读数断言（`tools/evaluation/verify-gate-readout.mjs`）的回归测试。
// 目的：① 三参模式的旧读数断言**逐字不变**（8 条字面量、退出码、输出文案）；
// ② 四参模式新增的结构化断言**真的会红**，且红在具体字段上，不是"红得不明不白"；
// ③ 参数个数错误仍是 exit 2，别把"用法错"混成"读数不符"。
// 夹具一律写系统临时目录并由 `after()` 删除；⛔ 不改仓内任何文件、不起服务、不联网。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SPECS, verifyReadout } from '../../tools/evaluation/verify-gate-readout.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOOL = join(REPO_ROOT, 'tools', 'evaluation', 'verify-gate-readout.mjs');
const BASE = mkdtempSync(join(tmpdir(), 'gy-gate-readout-'));

after(() => rmSync(BASE, { recursive: true, force: true }));

/** 8 条约定读数：与三参模式下必须逐字命中的字面量、以及它们的归属文件。 */
const FROZEN_READOUTS = [
  { label: 'run-evaluation', text: 'not_evaluated' },
  { label: 'run-evaluation', text: '"isRealEvaluation": false' },
  { label: 'run-evaluation', text: '样本缺口桶：16/17 未达标' },
  { label: 'freeze-real-samples --verify', text: '复算核对' },
  { label: 'freeze-real-samples --verify', text: '冻结=通过' },
  { label: 'freeze-real-samples --verify', text: '覆盖绑定：通过' },
  { label: 'validate-evaluation-samples', text: '样本索引：' },
  { label: 'validate-evaluation-samples', text: '校验结果：通过（无错误）' },
];

const OLD_PASS_LINE = 'PASS 读数断言：三份输出全部命中约定读数（绿只表示读数与约定一致，不表示真实评估成立）';
const OLD_USAGE_LINE =
  '用法：node tools/evaluation/verify-gate-readout.mjs <run-evaluation.log> <freeze-real-samples.log> <validate-evaluation-samples.log>';

/** 17 个缺口桶、其中 16 桶缺样本——与 CI 里真实报告的缺口桶读数同形（16/17）。 */
const GAPS = Array.from({ length: 17 }, (_, index) => ({
  bucket: `bucket_${String(index + 1).padStart(2, '0')}`,
  required: 2,
  present: index === 0 ? 2 : 1,
  missing: index === 0 ? 0 : 1,
}));

/** 报告夹具：只保留结构化断言真正读的字段，形状与 `run-evaluation.mjs` 的真实报告一致。 */
const REPORT = {
  schemaVersion: '1.0.0',
  dataKind: 'weeds',
  isRealEvaluation: false,
  frozenVerified: true,
  tasks: {
    weed_photo: { sampleCount: 0, gateStatus: 'not_evaluated' },
    label_ocr: { sampleCount: 0, gateStatus: 'not_evaluated' },
  },
  gaps: GAPS,
  warnings: [],
};

/** 只用来造"日志命中 16/17、报告却是另一种缺口结构"的隔离夹具。 */
const SMALL_REPORT = {
  ...REPORT,
  gaps: [
    { bucket: 'species_nettle_group', required: 1, present: 0, missing: 1 },
    { bucket: 'species_lambsquarters', required: 3, present: 1, missing: 2 },
    { bucket: 'species_shortawn_foxtail', required: 2, present: 2, missing: 0 },
  ],
};

/**
 * 造一组夹具：run-evaluation 日志（内含 `report` 的 pretty JSON ＋ 缺口桶行）、freeze 与 validate 日志、报告文件。
 * 日志与报告分开给，是为了造"日志仍命中约定字面量、只有报告变了"的隔离用例——
 * 否则红的可能是旧的 8 条字面量断言，测不到新增的结构化断言。
 */
function makeFixture(
  name,
  { report = REPORT, reportFile = null, reportText = null, gapLine = '样本缺口桶：16/17 未达标', runLogText = null } = {},
) {
  const dir = join(BASE, name);
  mkdirSync(dir, { recursive: true });
  const runLog = runLogText ?? `${JSON.stringify(report, null, 2)}\n${gapLine}\n`;
  const paths = {
    runLog: join(dir, 'run-evaluation.log'),
    freezeLog: join(dir, 'freeze-real-samples.log'),
    validateLog: join(dir, 'validate-evaluation-samples.log'),
    report: join(dir, 'run-evaluation-report.json'),
  };
  writeFileSync(paths.runLog, runLog, 'utf8');
  writeFileSync(paths.freezeLog, '复算核对（17 条逐条对账）\n冻结=通过（recordCount=17）\n覆盖绑定：通过\n', 'utf8');
  writeFileSync(paths.validateLog, '样本索引：17 条\n校验结果：通过（无错误）\n', 'utf8');
  writeFileSync(paths.report, reportText ?? `${JSON.stringify(reportFile ?? report, null, 2)}\n`, 'utf8');
  return paths;
}

const threeArgs = (paths) => [paths.runLog, paths.freezeLog, paths.validateLog];
const fourArgs = (paths) => [...threeArgs(paths), paths.report];

const runCli = (args) => spawnSync(process.execPath, [TOOL, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });

test('三参模式：三份日志命中全部 8 条约定读数 ⇒ exit 0，且不打任何结构化断言', () => {
  const paths = makeFixture('three-args-ok');
  const result = runCli(threeArgs(paths));
  assert.equal(result.status, 0, `三参必须 exit 0（stderr：${result.stderr}）`);
  const passLines = result.stdout.split('\n').filter((line) => line.startsWith('PASS '));
  assert.equal(passLines.length, 9, `8 条读数 + 1 条总括，实际 ${passLines.length} 条：\n${result.stdout}`);
  assert.ok(result.stdout.includes(OLD_PASS_LINE), '三参的总括行必须逐字保持旧文案');
  assert.ok(!result.stdout.includes('结构化断言'), '三参模式不得读取第 4 个参数、也不得打印结构化断言');
});

test('三参模式：同目录里放着坏报告也不影响（第 4 个参数不传就不读）', () => {
  const paths = makeFixture('three-args-ignores-report', { reportText: '{ 这不是 JSON' });
  const result = runCli(threeArgs(paths));
  assert.equal(result.status, 0, `三参模式不得因为坏报告而红（stderr：${result.stderr}）`);
  assert.ok(!result.stdout.includes('结构化断言'));
});

test('四参模式：报告与日志一致 ⇒ exit 0，并逐项打出结构化 PASS', () => {
  const paths = makeFixture('four-args-ok');
  const result = runCli(fourArgs(paths));
  assert.equal(result.status, 0, `四参必须 exit 0（stdout：${result.stdout}\nstderr：${result.stderr}）`);
  assert.ok(result.stdout.includes('PASS 结构化断言：schemaVersion=1.0.0'));
  assert.ok(result.stdout.includes('PASS 结构化断言：tasks.weed_photo.gateStatus=not_evaluated'));
  assert.ok(result.stdout.includes('PASS 结构化断言：缺口桶 16/17 与报告一致（未达标 16 桶 / 共 17 桶）'));
  assert.match(result.stdout, /PASS 读数断言：三份输出全部命中约定读数，报告结构化断言通过（绿只表示/);
});

test('负控制：报告自陈 isRealEvaluation=true ⇒ exit 1 并点名该字段与实测值', () => {
  const paths = makeFixture('nc-is-real', { reportFile: { ...REPORT, isRealEvaluation: true } });
  const result = runCli(fourArgs(paths));
  assert.equal(result.status, 1, 'isRealEvaluation=true 必须让 job 红');
  assert.ok(
    result.stdout.includes('FAIL 结构化断言：isRealEvaluation 必须是 false（实测 true）'),
    `红因须点名 isRealEvaluation：\n${result.stdout}`,
  );
  assert.ok(result.stdout.includes('FAIL 读数断言：1 条不满足，job 必须红'));
});

test('负控制：某个 task.gateStatus 被记成 pass ⇒ exit 1 并点名到 task 级', () => {
  const report = { ...REPORT, tasks: { ...REPORT.tasks, weed_photo: { sampleCount: 0, gateStatus: 'pass' } } };
  const paths = makeFixture('nc-task-pass', { reportFile: report });
  const result = runCli(fourArgs(paths));
  assert.equal(result.status, 1, 'gateStatus=pass 必须让 job 红');
  assert.ok(
    result.stdout.includes('FAIL 结构化断言：tasks.weed_photo.gateStatus 必须是 "not_evaluated"（实测 "pass"）'),
    `红因须点名到 task：\n${result.stdout}`,
  );
});

test('负控制：日志仍命中「16/17」字面量但报告 gaps 对不上 ⇒ 只有结构化断言红', () => {
  const paths = makeFixture('nc-gap-mismatch', { report: SMALL_REPORT, gapLine: '样本缺口桶：16/17 未达标' });
  const result = runCli(fourArgs(paths));
  assert.equal(result.status, 1, '缺口桶数字对不上必须红');
  assert.ok(
    result.stdout.includes('FAIL 结构化断言：日志缺口桶 16/17 与报告不一致（报告：未达标 2 桶 / 共 3 桶）'),
    `红因须给出两边读数：\n${result.stdout}`,
  );
  assert.ok(
    !result.stdout.includes('FAIL run-evaluation'),
    '字面量仍命中时，红的必须只有结构化断言——否则分不清是读数漂了还是结构变了',
  );
});

test('负控制：日志把缺口桶的 X 改一位（16→15）⇒ exit 1，字面量与结构化两边都红', () => {
  const paths = makeFixture('nc-gap-numerator', { gapLine: '样本缺口桶：15/17 未达标' });
  const result = runCli(fourArgs(paths));
  assert.equal(result.status, 1);
  assert.ok(result.stdout.includes('FAIL run-evaluation: 缺 "样本缺口桶：16/17 未达标"'));
  assert.ok(result.stdout.includes('日志缺口桶 15/17 与报告不一致'));
});

test('负控制：日志删掉「样本缺口桶」整行 ⇒ exit 1 并说明无法对账', () => {
  const paths = makeFixture('nc-gap-line-missing', { gapLine: '（本行被删）' });
  const result = runCli(fourArgs(paths));
  assert.equal(result.status, 1);
  assert.ok(
    result.stdout.includes('FAIL 结构化断言：run-evaluation.log 缺「样本缺口桶：X/Y 未达标」这一行'),
    `红因须说明缺行：\n${result.stdout}`,
  );
});

test('负控制：报告 schemaVersion 漂移到 1.0.1 ⇒ exit 1 并点名版本', () => {
  const report = { ...REPORT, schemaVersion: '1.0.1' };
  const paths = makeFixture('nc-schema-version', { reportFile: report });
  const result = runCli(fourArgs(paths));
  assert.equal(result.status, 1);
  assert.ok(result.stdout.includes('FAIL 结构化断言：schemaVersion 必须是 "1.0.0"（实测 "1.0.1"）'));
});

test('负控制：报告不是合法 JSON ⇒ exit 1 并说明解析失败', () => {
  const paths = makeFixture('nc-broken-json', { reportText: '{"schemaVersion": "1.0.0",' });
  const result = runCli(fourArgs(paths));
  assert.equal(result.status, 1);
  assert.ok(result.stdout.includes('FAIL 结构化断言：报告不是合法 JSON'), `红因须说明解析失败：\n${result.stdout}`);
});

test('负控制：报告读不到 ⇒ exit 1 并给出路径', () => {
  const paths = makeFixture('nc-report-missing');
  const result = runCli([...threeArgs(paths), join(BASE, 'nc-report-missing', '不存在.json')]);
  assert.equal(result.status, 1);
  assert.ok(result.stdout.includes('FAIL 结构化断言：读不到报告 JSON'));
});

test('负控制：tasks 为空对象／gaps 为空数组 ⇒ 空集不得当通过', () => {
  const emptyTasks = makeFixture('nc-empty-tasks', { reportFile: { ...REPORT, tasks: {} } });
  const tasksResult = runCli(fourArgs(emptyTasks));
  assert.equal(tasksResult.status, 1, 'tasks 为空等于没有证据');
  assert.ok(tasksResult.stdout.includes('tasks 不是非空对象'));

  const emptyGaps = makeFixture('nc-empty-gaps', { reportFile: { ...REPORT, gaps: [] } });
  const gapsResult = runCli(fourArgs(emptyGaps));
  assert.equal(gapsResult.status, 1, 'gaps 为空等于没有证据');
  assert.ok(gapsResult.stdout.includes('gaps 不是非空数组'));
});

test('参数个数不是 3 或 4 ⇒ exit 2，且首行仍是旧的用法文案', () => {
  const paths = makeFixture('nc-argv');
  for (const args of [threeArgs(paths).slice(0, 2), [...fourArgs(paths), paths.report]]) {
    const result = runCli(args);
    assert.equal(result.status, 2, `参数 ${args.length} 个必须 exit 2（用法错误，不是读数不符）`);
    assert.ok(result.stderr.startsWith(`${OLD_USAGE_LINE}\n`), `用法首行必须逐字保持旧文案：${result.stderr}`);
    assert.equal(result.stdout, '', '用法错误不得往 stdout 打读数');
  }
});

test('零放宽：8 条约定读数与归属文件逐条冻结，禁止被悄悄改成恒真', () => {
  const actual = SPECS.flatMap((spec) => spec.literals.map((item) => ({ label: spec.label, text: item.text })));
  assert.deepEqual(actual, FROZEN_READOUTS, '改动字面量＝改对外承诺，必须先改读数来源并同步本清单');
  for (const spec of SPECS) {
    for (const item of spec.literals) {
      assert.notEqual(item.text, '', '空串字面量等于没有断言');
      assert.ok(item.why && item.why.length > 0, `${JSON.stringify(item.text)} 必须写明为什么必须出现`);
    }
  }
});

test('纯函数形态：verifyReadout 只经 readFile 取数并返回 {exitCode, lines}', () => {
  const paths = makeFixture('pure-function');
  const text = (path) => readFileSync(path, 'utf8');
  const result = verifyReadout(fourArgs(paths), { readFile: text });
  assert.equal(result.exitCode, 0);
  assert.ok(Array.isArray(result.lines));
  assert.ok(result.lines.at(-1).startsWith('PASS 读数断言：三份输出全部命中约定读数，报告结构化断言通过'));

  const broken = verifyReadout(fourArgs(paths), {
    readFile: (path) => (path === paths.report ? 'not json' : text(path)),
  });
  assert.equal(broken.exitCode, 1, '注入坏报告时纯函数必须返回 1');
  assert.ok(broken.lines.some((line) => line.startsWith('FAIL 结构化断言：报告不是合法 JSON')));
});
