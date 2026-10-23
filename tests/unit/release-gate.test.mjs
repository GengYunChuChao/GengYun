/**
 * 发布门禁汇总（`tools/release-gate.mjs`）· 回归。
 *
 * 覆盖交付要求的四条主线：
 *   1. **全过场景** —— 全部通过时退出码 0、`verdict=pass`，报告文件与 stdout 同字节；
 *   2. **注入失败场景** —— 失败时退出码 1，失败项带 `exitCode` 与 ≤3 行「首条关键错误行」，
 *      且**失败后面的步骤不再执行**（首条失败即停）；
 *   3. **`--only` / `--skip` 过滤** —— 只跑点名的项；未知 id、过滤后为空都按**用法错误**退出码 2；
 *   4. **泄漏扫描命中/未命中** —— 在 `os.tmpdir()` 里铺真 git 夹具，命中时四条规则都报、
 *      密钥原文**不出现在 stdout／报告里**（只给掩码），未命中时判 pass 且确实扫过新增行。
 * 另含：大文件/二进制门禁、真库臂默认跳过且带理由、`--list` 产物契约。
 *
 * ⚠️ **夹具字面量必须拆开拼**（`'sk' + '-abc…'`、`'E:' + '\\…'`）：本文件自己也在
 * 「待发布 diff 的新增行」里，写成整串会被本门禁的扫描规则命中 ⇒ 自己扫自己，红得毫无意义。
 * 拆开后**运行时**仍是完整的泄漏样本，扫描面（源码文本）里则没有可命中的整串。
 *
 * 边界：不连云、不连库、不跑真库臂（那要 PG 17 ＋ fixture）；只在临时目录里造夹具，
 * ⛔ 不改仓库内任何文件（报告一律 `--out` 到临时目录）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TOOL = join(ROOT, 'tools', 'release-gate.mjs');

/** 每次运行都在自己的临时目录里收报告，绝不落到仓库工作区。 */
function makeScratch() {
  return mkdtempSync(join(tmpdir(), 'gy-release-gate-'));
}

/** 用 spawnSync 跑工具，拿到退出码 + 原始 stdout/stderr（门禁失败/用法错误都不抛）。 */
function gate(args, cwd = ROOT) {
  const result = spawnSync(process.execPath, [TOOL, ...args], { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** stdout 必须**只有**一个 JSON 对象——这是 CI 解析契约，摘要只能走 stderr。 */
function parseReport(stdout) {
  return JSON.parse(stdout);
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** 造一个真 git 夹具：`main` 上先有一条基线提交，返回基线 SHA 供 `--base` 用。 */
function makeGitFixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'gy-release-gate-repo-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'gate@example.invalid');
  git('config', 'user.name', 'release gate test');
  git('config', 'commit.gpgsign', 'false');
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  git('add', '-A');
  git('commit', '-q', '--no-gpg-sign', '-m', 'baseline');
  return { dir, base: git('rev-parse', 'HEAD'), git };
}

/**
 * 泄漏样本：**运行时**是完整样本，源码里没有可被命中的整串。
 * 四条规则各一条，另加一条不该命中的对照行（普通 URL 与短横线词）。
 * 关键在于夹具是**纯文本文件**（不会执行），所以拼接必须在**本文件**里做，
 * 铺进夹具的那一刻才是完整串：`'sk' + '-abc…'` ⇒ 文件里是 `sk-abc…`。
 */
const RAW_SK = 'sk' + '-abcdefgh12345678';
const RAW_SECRET = 'Secret' + 'Key: "AKIDzzzzzzzzzzzzzzzz"';
const RAW_PEM_HEAD = '-----BEGIN ' + 'RSA PRIVATE KEY-----';
const RAW_PEM_TAIL = '-----END ' + 'RSA PRIVATE KEY-----';
const RAW_PATH = 'E:' + '\\GengYunPrivate\\token.txt';

const LEAKY_FIXTURE = [
  `const key = '${RAW_SK}';`,
  `const secret = '${RAW_SECRET}';`,
  RAW_PEM_HEAD,
  'MIIEowIBAAKCAQEA0000',
  RAW_PEM_TAIL,
  RAW_PATH,
  'const fine = "https://example.invalid/docs";',
].join('\n');

const CLEAN_FIXTURE = [
  'export function add(a, b) {',
  '  return a + b;',
  '}',
  '',
].join('\n');

test('门禁·全过场景：退出码 0、verdict=pass、报告文件与 stdout 同字节', () => {
  const scratch = makeScratch();
  const plan = join(scratch, 'plan.json');
  const out = join(scratch, 'report.json');
  writeJson(plan, {
    gates: [
      { id: 'alpha', title: '第一步', kind: 'command', steps: [{ label: 'ok', command: 'node', args: ['-e', 'process.exit(0)'] }] },
      { id: 'beta', title: '第二步', kind: 'command', steps: [{ label: 'ok', command: 'node', args: ['-e', 'process.exit(0)'] }] },
    ],
  });

  const run = gate(['--root', ROOT, '--plan', plan, '--out', out]);
  assert.equal(run.status, 0, `全过时退出码必须为 0\n${run.stdout}\n${run.stderr}`);

  const report = parseReport(run.stdout);
  assert.equal(report.verdict, 'pass');
  assert.equal(report.exitCode, 0);
  assert.deepEqual(report.counts, { total: 2, passed: 2, failed: 0, skipped: 0 });
  assert.deepEqual(report.gates.map((item) => item.id), ['alpha', 'beta']);
  for (const item of report.gates) {
    assert.equal(item.status, 'passed');
    assert.equal(item.exitCode, 0);
    assert.equal(typeof item.durationMs, 'number');
    assert.ok(item.durationMs >= 0);
    assert.equal(typeof item.command, 'string');
    assert.deepEqual(item.errorLines, []);
  }

  // 落盘内容必须与 stdout **逐字节**一致（CI 读文件、人读 stdout，两者不能漂）。
  assert.equal(readFileSync(out, 'utf8'), run.stdout);
  // 人读摘要不得污染 stdout。
  assert.match(run.stderr, /判定：PASS/);

  rmSync(scratch, { recursive: true, force: true });
});

test('门禁·注入失败：退出码 1、失败项带 exitCode 与 ≤3 行首条关键错误行，后续步骤不再执行', () => {
  const scratch = makeScratch();
  const plan = join(scratch, 'plan.json');
  const out = join(scratch, 'report.json');
  const marker = join(scratch, 'must-not-run.txt');
  writeJson(plan, {
    gates: [
      {
        id: 'alpha',
        title: '注入失败',
        kind: 'command',
        steps: [
          {
            label: 'boom',
            command: 'node',
            args: ['-e', "for (let i = 0; i < 9; i += 1) console.error('noise line ' + i); console.error('BOOM: injected failure'); process.exit(3)"],
          },
          { label: 'after', command: 'node', args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`] },
        ],
      },
    ],
  });

  const run = gate(['--root', ROOT, '--plan', plan, '--out', out]);
  assert.equal(run.status, 1, `有失败项时退出码必须为 1\n${run.stdout}\n${run.stderr}`);

  const report = parseReport(run.stdout);
  assert.equal(report.verdict, 'fail');
  assert.equal(report.exitCode, 1);
  assert.equal(report.counts.failed, 1);

  const gateResult = report.gates[0];
  assert.equal(gateResult.status, 'failed');
  assert.equal(gateResult.exitCode, 3, '必须如实保留被跑命令的退出码');
  assert.ok(gateResult.errorLines.length >= 1 && gateResult.errorLines.length <= 3, `错误行必须 ≤3 行，实际 ${gateResult.errorLines.length}`);
  assert.ok(gateResult.errorLines.some((line) => line.includes('BOOM: injected failure')), `必须含首条关键错误行：${JSON.stringify(gateResult.errorLines)}`);
  assert.equal(existsSync(marker), false, '首条步骤失败后不得继续执行后续步骤');

  assert.match(run.stderr, /\[FAIL\] alpha/);

  rmSync(scratch, { recursive: true, force: true });
});

test('门禁·--only 只跑点名项，--skip 剔除点名项', () => {
  const scratch = makeScratch();
  const plan = join(scratch, 'plan.json');
  writeJson(plan, {
    gates: [
      { id: 'a', kind: 'command', steps: [{ label: 'a', command: 'node', args: ['-e', 'process.exit(0)'] }] },
      { id: 'b', kind: 'command', steps: [{ label: 'b', command: 'node', args: ['-e', 'process.exit(0)'] }] },
      { id: 'c', kind: 'command', steps: [{ label: 'c', command: 'node', args: ['-e', 'process.exit(0)'] }] },
    ],
  });

  const only = gate(['--root', ROOT, '--plan', plan, '--only', 'b', '--out', join(scratch, 'only.json')]);
  assert.equal(only.status, 0, only.stderr);
  assert.deepEqual(parseReport(only.stdout).gates.map((item) => item.id), ['b']);

  const skipped = gate(['--root', ROOT, '--plan', plan, '--skip', 'b', '--out', join(scratch, 'skip.json')]);
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.deepEqual(parseReport(skipped.stdout).gates.map((item) => item.id), ['a', 'c']);

  // 多个 id、逗号分隔。
  const multi = gate(['--root', ROOT, '--plan', plan, '--only', 'c,a', '--out', join(scratch, 'multi.json')]);
  assert.deepEqual(parseReport(multi.stdout).gates.map((item) => item.id), ['c', 'a']);

  rmSync(scratch, { recursive: true, force: true });
});

test('门禁·用法错误（未知 id／过滤后为空／同一项既 only 又 skip）退出码 2，且不产出报告', () => {
  const scratch = makeScratch();
  const plan = join(scratch, 'plan.json');
  writeJson(plan, {
    gates: [{ id: 'a', kind: 'command', steps: [{ label: 'a', command: 'node', args: ['-e', 'process.exit(0)'] }] }],
  });
  const out = join(scratch, 'usage.json');

  const unknown = gate(['--root', ROOT, '--plan', plan, '--only', 'nope', '--out', out]);
  assert.equal(unknown.status, 2, unknown.stderr);
  assert.match(unknown.stderr, /用法错误/);
  assert.equal(unknown.stdout, '', 'usage error 时 stdout 不得输出半个 JSON');
  assert.equal(existsSync(out), false);

  const empty = gate(['--root', ROOT, '--plan', plan, '--skip', 'a', '--out', out]);
  assert.equal(empty.status, 2, empty.stderr);

  const conflict = gate(['--root', ROOT, '--plan', plan, '--only', 'a', '--skip', 'a', '--out', out]);
  assert.equal(conflict.status, 2, conflict.stderr);

  const brokenPlan = join(scratch, 'broken.json');
  writeFileSync(brokenPlan, '{ not json', 'utf8');
  const broken = gate(['--root', ROOT, '--plan', brokenPlan, '--out', out]);
  assert.equal(broken.status, 2, '坏计划文件属用法错误（2），不是门禁失败（1）');
  assert.match(broken.stderr, /不是合法 JSON/);

  rmSync(scratch, { recursive: true, force: true });
});

test('门禁·泄漏扫描命中：四条规则都报，且密钥原文不进 stdout／报告', () => {
  const fixture = makeGitFixture({ 'README.md': '# baseline\n' });
  try {
    writeFileSync(join(fixture.dir, 'leak.txt'), LEAKY_FIXTURE);
    fixture.git('add', '-A');
    fixture.git('commit', '-q', '--no-gpg-sign', '-m', 'leak');

    const out = join(makeScratch(), 'report.json');
    const run = gate(['--root', fixture.dir, '--base', fixture.base, '--only', 'secrets', '--out', out]);
    assert.equal(run.status, 1, `命中时必须退出码 1\n${run.stdout}\n${run.stderr}`);

    const report = parseReport(run.stdout);
    const secrets = report.gates[0];
    assert.equal(secrets.status, 'failed');
    const rules = new Set(secrets.details.hits.map((hit) => hit.rule));
    for (const rule of ['openai-style-key', 'secret-key-assignment', 'private-key-block', 'local-absolute-path']) {
      assert.ok(rules.has(rule), `缺失规则命中：${rule}，实际 ${[...rules].join(',')}`);
    }
    assert.ok(secrets.details.hits.every((hit) => hit.file === 'leak.txt'));
    assert.ok(secrets.details.scannedLines >= 5, '必须先真的扫到新增行（不是空扫通过）');
    assert.ok(secrets.errorLines.length <= 3, '错误行最多 3 行');

    // 反泄：密钥原文（上面的拼装常量，运行期即完整串）既不在 stdout，也不在报告文件里。
    const reportFile = readFileSync(out, 'utf8');
    for (const raw of [RAW_SK, 'AKIDzzzzzzzzzzzzzzzz']) {
      assert.equal(run.stdout.includes(raw), false, `stdout 泄漏了密钥原文：${raw}`);
      assert.equal(reportFile.includes(raw), false, `报告文件泄漏了密钥原文：${raw}`);
    }
    assert.match(run.stdout, /\[redacted\]/, '高敏命中必须给掩码');
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('门禁·泄漏扫描未命中：干净新增文件判 pass，且确实扫过新增行', () => {
  const fixture = makeGitFixture({ 'README.md': '# baseline\n' });
  try {
    writeFileSync(join(fixture.dir, 'clean.mjs'), CLEAN_FIXTURE);
    fixture.git('add', '-A');
    fixture.git('commit', '-q', '--no-gpg-sign', '-m', 'clean');

    const run = gate(['--root', fixture.dir, '--base', fixture.base, '--only', 'secrets', '--out', join(makeScratch(), 'report.json')]);
    assert.equal(run.status, 0, `干净新增必须退出码 0\n${run.stdout}\n${run.stderr}`);
    const secrets = parseReport(run.stdout).gates[0];
    assert.equal(secrets.status, 'passed');
    assert.equal(secrets.exitCode, 0);
    assert.deepEqual(secrets.details.hits, []);
    assert.equal(secrets.details.scannedLines, CLEAN_FIXTURE.split('\n').length - 1);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('门禁·大文件与二进制检查：超阈值、二进制都判失败；白名单扩展名可放行', () => {
  const fixture = makeGitFixture({ 'README.md': '# baseline\n' });
  const scratch = makeScratch();
  try {
    writeFileSync(join(fixture.dir, 'big.txt'), 'x'.repeat(2048));
    writeFileSync(join(fixture.dir, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 4, 5]));
    fixture.git('add', '-A');
    fixture.git('commit', '-q', '--no-gpg-sign', '-m', 'artifacts');

    const out = join(scratch, 'report.json');
    const run = gate(['--root', fixture.dir, '--base', fixture.base, '--only', 'artifacts', '--max-file-bytes', '512', '--out', out]);
    assert.equal(run.status, 1, `大文件/二进制必须判失败\n${run.stdout}\n${run.stderr}`);

    const artifacts = parseReport(run.stdout).gates[0];
    const problems = new Map(artifacts.details.findings.map((finding) => [finding.file, finding.problem]));
    assert.equal(problems.get('big.txt'), 'too-large');
    assert.equal(problems.get('blob.bin'), 'binary');
    assert.ok(artifacts.errorLines.length <= 3);

    // 同一夹具：放行 .bin 且把阈值调大 ⇒ 判 pass（证明不是「一律红」的死门禁）。
    const relaxed = gate([
      '--root', fixture.dir, '--base', fixture.base, '--only', 'artifacts',
      '--max-file-bytes', '4096', '--binary-allow', '.bin', '--out', join(scratch, 'relaxed.json'),
    ]);
    assert.equal(relaxed.status, 0, `白名单放行后必须为 0\n${relaxed.stdout}\n${relaxed.stderr}`);
    assert.deepEqual(parseReport(relaxed.stdout).gates[0].details.findings, []);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('门禁·真库臂默认跳过并带理由（--only pg 不执行命令、退出码 0）', () => {
  const scratch = makeScratch();
  const run = gate(['--root', ROOT, '--only', 'pg', '--out', join(scratch, 'report.json')]);
  assert.equal(run.status, 0, run.stderr);

  const report = parseReport(run.stdout);
  const pg = report.gates[0];
  assert.equal(pg.status, 'skipped');
  assert.equal(pg.exitCode, null);
  assert.equal(pg.command, null);
  assert.match(pg.skipReason, /--pg/, '跳过理由必须写明如何开启');
  assert.match(pg.skipReason, /PostgreSQL/);
  assert.equal(report.counts.skipped, 1);
  assert.equal(report.verdict, 'pass', '跳过不算失败，但必须计入 counts');

  rmSync(scratch, { recursive: true, force: true });
});

test('门禁·产物契约：--list 列六个门禁、--help 退出码 0、包管理器判定写进报告', () => {
  const scratch = makeScratch();
  try {
    const list = gate(['--list']);
    assert.equal(list.status, 0);
    assert.deepEqual(parseReport(list.stdout).gates, ['typecheck', 'unit', 'contract', 'secrets', 'artifacts', 'pg']);

    const help = gate(['--help']);
    assert.equal(help.status, 0);
    assert.equal(help.stdout, '', '帮助只走 stderr，stdout 保持可解析');
    assert.match(help.stderr, /退出码：0 = 全过/);

    // 真仓库判定：本仓没有 pnpm 锁文件/工作区 ⇒ npm workspaces（报告里必须如实写出）。
    const report = parseReport(gate(['--root', ROOT, '--only', 'secrets', '--base', 'HEAD', '--out', join(scratch, 'r.json')]).stdout);
    assert.equal(report.packageManager, 'npm');
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.tool, 'release-gate');
    assert.equal(typeof report.generatedAt, 'string');
    assert.ok(!Number.isNaN(Date.parse(report.generatedAt)));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
