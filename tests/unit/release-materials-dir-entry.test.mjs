/**
 * GY-R34：发布物料索引里的**目录条目**不得被判成「空文件」——单条判据的回归。
 *
 * 缺陷（2026-10-23 定位到行）：`tools/verify-release-materials.mjs` 判空只写了
 * `statSync(p).size === 0`。索引页正文里有目录写法（真页 §4 那句「R32 另增
 * `deploy/purge-schedule/` 下 5 件」，5 个 blob 确实在目录里），而 **Windows 上目录的
 * `st.size` 恒为 0** ⇒ 本机把整个目录报成「空文件：deploy/purge-schedule/」；
 * Linux 上目录 size 非 0，同一条判据在 CI 里一直绿。同一棵树两个结论，本机
 * `release-materials-index-strict` / `release-runbook-guard` 两份套件的正控制随之恒红。
 *
 * 修法（最小）：**先判目录再判 size** —— 普通文件才用 `size === 0` 判空；目录放行并在读数里
 * 单列为「目录 N 个」，不混进文件计数；目录存在但 `readdir` 为空则报「空目录」而不是静默放行
 * （真把目录清空了是问题，不能因为「目录不算空文件」就一起放过）；`stat` 拿不到（不存在、
 * `a.txt/` 这种 ENOTDIR、权限）沿用原来「算不通过」的判定，不放宽。
 *
 * 夹具为什么是**合成小仓**（而不是像两份既有套件那样镜像整仓）：本文件只钉「被索引条目
 * 非空」这一条判据的行级读数，需要的是对目录/空文件/缺失/空目录四种输入做**可控**替换；
 * 整仓镜像每次跑门禁要 5 个 `.sh` 的 `bash -n`（本机 ~6s/次），且红起来分不清是判据还是
 * 环境。整仓全绿由 `release-materials-index-strict.test.mjs` 与 `release-runbook-guard.test.mjs`
 * 的正控制负责，这里不重复。夹具里的固定输入（env 模板、migrate.ts、health.ts、runbook）
 * 都按门禁要求写成最小可解析形态，让门禁能跑到汇总行，不中途抛「工具自身异常」。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOOL = 'tools/verify-release-materials.mjs';
const INDEX = 'docs/verification/gy-i24-release-materials-index-20261017.md';
const RUNBOOK = 'docs/release/runbook-20261022.md';

/** 本文件唯一钉住的判据名（门禁 `check()` 的名字，改名字这里必须同步改）。 */
const CHECK = '被索引文件全部非空';

/** 索引里的目录条目①（反引号写法，真页正文就是这条，带尾斜杠）。 */
const DIR_ENTRY = 'deploy/purge-schedule/';
/** 目录里的一个文件：证明「目录非空」，并参与覆盖判据的 `N/N` 计数。 */
const DIR_FILE = 'deploy/purge-schedule/README.md';
/** 索引里的目录条目②（Markdown 链接写法）：两种抽取路径都别把目录判成空文件。 */
const LINKED_DIR = 'deploy/evidence/';
/** 普通非空文件：反例 1/2 的改坏对象（截空 ⇒ 仍要红；删掉 ⇒ 仍要红）。 */
const PLAIN_FILE = 'deploy/ok.txt';
/** 反例 3 用的空目录：只能在工作区造（git 不跟踪空目录），因此单独造 + 单独删。 */
const EMPTY_DIR = 'deploy/void-dir/';

let mirror = '';
let ORIGINAL_INDEX = '';

/** 测得的门禁输出行：`PASS/FAIL <judge> — <detail>`。 */
function judgeLine(stdout) {
  const line = stdout.split('\n').find((l) => l === `PASS ${CHECK}` || l.startsWith(`PASS ${CHECK} —`)
    || l === `FAIL ${CHECK}` || l.startsWith(`FAIL ${CHECK} —`));
  return line ?? '';
}

const verdictOf = (line) => (line.startsWith('PASS ') ? 'PASS' : line.startsWith('FAIL ') ? 'FAIL' : '（无该判据行）');
const detailOf = (line) => (line.includes(' — ') ? line.slice(line.indexOf(' — ') + 3) : '');

function runGate() {
  const run = spawnSync(process.execPath, [TOOL], { cwd: mirror, encoding: 'utf8', windowsHide: true, timeout: 120000 });
  assert.equal(run.error, undefined, `夹具内门禁未能启动：${run.error?.message ?? ''}`);
  const stdout = run.stdout ?? '';
  const line = judgeLine(stdout);
  assert.notEqual(line, '', `门禁没有输出「${CHECK}」这一行（判据被改名/门禁中途异常？）：\n${stdout}\n${run.stderr ?? ''}`);
  return { status: run.status, stdout, line, detail: detailOf(line) };
}

function git(args) {
  const run = spawnSync('git', args, { cwd: mirror, encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 0, `夹具 git ${args.join(' ')} 失败：${run.stderr ?? ''}`);
  return run.stdout ?? '';
}

const put = (path, content) => {
  const dest = join(mirror, path);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, content);
};

/**
 * 索引页夹具：**目录条目（两种写法）+ 目录内文件 + 普通文件 + 覆盖计数**四件，形状照抄真索引页：
 * 目录①是反引号写法（真页 §4 正文就是这种，与正文那句同形 ⇒ 去重后算 1 个），目录②是
 * Markdown 链接写法（另一种抽取路径）——两种写法都得按目录核验，都不能进「空文件」。
 */
const INDEX_ROWS = [
  '# GY-R34 夹具索引页（单测生成，不是真索引）',
  '',
  '> 只为一件事存在：给 `node tools/verify-release-materials.mjs` 的「被索引条目非空」',
  `> 判据喂输入。真索引页在 §4 正文里写过 \`${DIR_ENTRY}\`（5 个 blob 在该目录内）。`,
  '',
  '| 路径 | 作用 | 核验 |',
  '| --- | --- | --- |',
  `| \`${DIR_ENTRY}\` | 调度层**目录**条目（反引号写法，与正文那句同形） | ✅ 在册；目录按目录核验 |`,
  `| [\`../../${DIR_FILE}\`](../../${DIR_FILE}) | 目录里的文件（证明目录非空） | ✅ 在册 |`,
  `| [\`../../${LINKED_DIR}\`](../../${LINKED_DIR}) | 证据**目录**条目（链接写法） | ✅ 在册；目录按目录核验 |`,
  '| [`../../deploy/evidence/probe.sql`](../../deploy/evidence/probe.sql) | 证据目录里的文件 | ✅ 在册 |',
  `| [\`../../${PLAIN_FILE}\`](../../${PLAIN_FILE}) | 普通非空文件（反例改坏对象） | ✅ 在册 |`,
  '| [`../../deploy/cloudrun/Dockerfile`](../../deploy/cloudrun/Dockerfile) | 云托管镜像 | ✅ 在册 |',
  '| [`../../deploy/cloudrun/env.placeholder.json`](../../deploy/cloudrun/env.placeholder.json) | 环境变量模板 | ✅ 在册 |',
  '| 覆盖 deploy/ 在册文件 | 5/5 覆盖（`ok.txt`、`purge-schedule/README.md`、`evidence/probe.sql`、`cloudrun/` 两件） | ✅ 在册 |',
  '',
];

/** 发版 runbook 夹具：10 个必备小节 + 14 个可复制命令块、无占位符（只为让门禁不异常退出）。 */
const RUNBOOK_SECTIONS = [
  '## 0 适用范围与前置', '## 1 发版前检查', '## 2 发版备份', '## 3 迁移执行', '## 4 服务启动与探活',
  '## 5 发布后验证', '## 6 灰度与放量判据', '## 7 回滚', '## 8 值班处置', '## 9 演练记录',
];

function runbookFixture() {
  const lines = ['# 发版 runbook（夹具）', ''];
  RUNBOOK_SECTIONS.forEach((heading, index) => {
    lines.push(heading, '', '```bash', `echo step-${index}`, '```', '');
  });
  for (let i = 0; i < 4; i += 1) {                 // 补到 14 个命令块（门禁下限）
    lines.push(`### 附 ${i + 1}`, '', '```bash', `echo extra-${i}`, '```', '');
  }
  return lines.join('\n');
}

before(() => {
  mirror = mkdtempSync(join(tmpdir(), 'gy-relidx-dir-'));
  // 工具本体：从真仓复制，门禁的 ROOT 由它自己的位置推出 ⇒ 指向夹具根。
  mkdirSync(join(mirror, dirname(TOOL)), { recursive: true });
  copyFileSync(join(ROOT, TOOL), join(mirror, TOOL));

  ORIGINAL_INDEX = INDEX_ROWS.join('\n');
  put(INDEX, ORIGINAL_INDEX);
  put(RUNBOOK, runbookFixture());

  put(DIR_FILE, '调度层总览（夹具）：目录非空的证据。\n');
  put('deploy/evidence/probe.sql', '-- 夹具：证据目录里的探针\n');
  put(PLAIN_FILE, '普通非空文件（夹具）。\n');
  put('deploy/cloudrun/Dockerfile', 'FROM node:22.20.0-alpine\nWORKDIR /app\n');
  put('deploy/cloudrun/env.placeholder.json', `${JSON.stringify({ DATABASE_URL: '' }, null, 2)}\n`);
  put('package.json', `${JSON.stringify({ name: 'gy-relidx-dir-fixture', private: true, engines: { node: '>=22.20.0 <23' } }, null, 2)}\n`);
  put('services/api/src/config.ts', "export const REQUIRED_WHEN_REAL = ['DATABASE_URL'] as const;\n");
  put('services/api/src/routes/health.ts',
    "app.get('/health', async () => ({ checks: [], meta: { execution_mode: 'fixture' } }));\n");
  put('services/api/src/db/migrate.ts',
    "console.error(`未知命令：${command}（支持 up | status | list）`);\n");
  put('services/api/db/migrations/0001_schema.sql', '-- 夹具 0001\n');
  put('services/api/db/migrations/0002_extra.sql', '-- 夹具 0002\n');
  put('services/api/db/migrations/rollback/0002_extra.down.sql', '-- 夹具 0002 down\n');

  // 让夹具自己成为 git 仓库：覆盖判据走 `git ls-files deploy`。
  git(['-c', 'init.defaultBranch=main', 'init', '-q']);
  git(['-c', 'core.autocrlf=false', 'add', '-A', '-f']);
  git(['-c', 'core.autocrlf=false', '-c', 'user.name=gy-relidx-dir',
    '-c', 'user.email=dir@example.invalid', '-c', 'commit.gpgsign=false',
    'commit', '-q', '-m', 'fixture: 目录条目回归']);
});

after(() => {
  if (mirror === '') return;
  const prefix = resolve(tmpdir()) + sep;
  assert.ok(mirror.startsWith(prefix), `夹具不在系统临时目录里，拒绝删除：${mirror}`);
  rmSync(mirror, { recursive: true, force: true });
});

// --------------------------------------------------------------------------- 正控制
test('正控制：索引条目指向存在且非空的目录 ⇒ 判据 PASS（本次修复的直接回归）', (t) => {
  const run = runGate();
  // 修复前（只看 size）：Windows 上这一行是「FAIL … 空文件：deploy/purge-schedule/」，Linux 上恰好绿。
  assert.equal(verdictOf(run.line), 'PASS', `非空目录必须放行：${run.line}`);
  assert.ok(run.detail.includes(DIR_ENTRY), `读数必须点名反引号写法的目录：${run.detail}`);
  assert.ok(run.detail.includes(LINKED_DIR), `读数必须点名链接写法的目录：${run.detail}`);
  assert.match(run.detail, /目录 2 个/, `目录要与文件分开计数（反引号 / 链接两种写法各 1 个）：${run.detail}`);
  assert.ok(!run.detail.includes('空文件：'), `目录不得出现在「空文件」里：${run.detail}`);
  t.diagnostic(`正控制: ${run.line}`);
});

// --------------------------------------------------------------------------- 反例 1
test('反例1：索引条目指向普通空文件 ⇒ 仍 FAIL（不能把真空文件也放行）', (t) => {
  const abs = join(mirror, PLAIN_FILE);
  const original = readFileSync(abs);
  try {
    writeFileSync(abs, '');                        // 0 字节普通文件：口径必须仍是「空文件」
    const run = runGate();
    assert.equal(verdictOf(run.line), 'FAIL', `真空文件必须判红：${run.line}`);
    assert.match(run.detail, /空文件：[^；]*deploy\/ok\.txt/, `必须报「空文件」并点名：${run.detail}`);
    t.diagnostic(`反例1: ${run.line}`);
  } finally {
    writeFileSync(abs, original);
  }
});

// --------------------------------------------------------------------------- 反例 2
test('反例2：索引条目指向不存在的路径 ⇒ 仍 FAIL（缺失判定不放宽）', (t) => {
  const abs = join(mirror, PLAIN_FILE);
  const original = readFileSync(abs);
  try {
    rmSync(abs);                                   // 修复前是 `catch ⇒ 算空`，修复后是「缺失」，两者都不通过
    const run = runGate();
    assert.equal(verdictOf(run.line), 'FAIL', `缺失路径必须判红：${run.line}`);
    assert.ok(run.detail.includes(PLAIN_FILE), `必须点名缺失的路径：${run.detail}`);
    assert.match(run.detail, /缺失：[^；]*deploy\/ok\.txt/, `缺失要单列，不能混进「空文件」：${run.detail}`);
    t.diagnostic(`反例2: ${run.line}`);
  } finally {
    writeFileSync(abs, original);
  }
});

// --------------------------------------------------------------------------- 反例 3
test('反例3：目录存在但 readdir 为空 ⇒ FAIL 报「空目录」（不静默放行）', (t) => {
  const emptyDir = join(mirror, EMPTY_DIR);
  mkdirSync(emptyDir, { recursive: true });
  try {
    writeFileSync(join(mirror, INDEX), `${ORIGINAL_INDEX}> 另见空目录 \`${EMPTY_DIR}\`（本行由反例3追加）。\n`);
    const run = runGate();
    assert.equal(verdictOf(run.line), 'FAIL', `空目录必须判红：${run.line}`);
    assert.match(run.detail, /空目录：deploy\/void-dir\//, `必须报「空目录」并点名：${run.detail}`);
    // 同一次运行里，非空目录仍须放行：证明「目录放行」没有被写成「目录一律放过」。
    assert.ok(!run.detail.includes(DIR_ENTRY), `非空目录不该被牵连：${run.detail}`);
    t.diagnostic(`反例3: ${run.line}`);
  } finally {
    writeFileSync(join(mirror, INDEX), ORIGINAL_INDEX);
    rmSync(emptyDir, { recursive: true, force: true });
  }
});
