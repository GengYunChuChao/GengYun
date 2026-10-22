/**
 * GY-I24 交付材料索引门禁的**严格性**回归：表格行级覆盖 + `N/N` 计数一致。
 *
 * 为什么要这份测试（2026-10-18 审查实测同一份门禁的两个洞）：
 *   ① 索引页的 `N/N` 覆盖计数根本没人核 —— 把 `29/29` 改成 `30/30`、`30/31`，门禁照样 exit 0；
 *   ② 覆盖判定是「页面里随便哪一行同时含 ✅ 和该路径」—— 删掉 §2 某个文件的专用表格行后，
 *      §4 说明句 / §1 交叉引用里还写着这个路径且带 ✅，判据依然绿，等于「正文提一句就算收录」；
 *   ③ 覆盖判定只查「整行任意处含 ✅」—— 把该行的 ✅ 挪到中间列、核验列写成 `❌ 未核验`，
 *      门禁照样 exit 0 / 15/15（2026-10-18 复审实测）⇒ 判据必须落到**末列（核验列）列位**上。
 *
 * 做法：在 `os.tmpdir()` 下铺一个**能跑门禁的镜像仓**（工具 + 索引页 + `deploy/**` + 固定路径输入 +
 * migrations + 索引相对链接目标），先证明一字不改时全绿，再逐条把索引页改坏，要求门禁 exit 1、
 * FAIL **恰好 1 条**且落在覆盖判据上（多出别的 FAIL 说明红的原因不是本次判据，那条反例就失效了）。
 * 镜像跑完连失败路径一起删净。
 *
 * ⚠️ 与 `release-materials-index.test.mjs`（另一片在改）的分工：那份测「门禁整体行为 + 门禁输出被
 * 页面如实引用」，这份只测「覆盖判据的严格性」，不读页面 §4 的读数表，因此两边改动能各自独立成立。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { resolveGateBash } from './bash-resolver.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOOL = 'tools/verify-release-materials.mjs';
const INDEX = 'docs/verification/gy-i24-release-materials-index-20261017.md';
const MIGRATIONS = 'services/api/db/migrations';

/**
 * 门禁里的 `bash -n` 由**子进程的 PATH** 解析 `bash`。本机 `bash` 是 WSL 存根（只打印
 * 「wsl: 检测到 localhost 代理配置…」并返回 1），于是本文件 6 条全红——红的不是覆盖判据，
 * 是「bash 是哪一个」。这里显式解析真 bash（`GY_BASH` 优先）并把它的目录前置进子进程 PATH；
 * 一个真 bash 都没有时**显式 skip 并打印指路**，⛔ 不静默 pass、⛔ 不改判据。
 */
const BASH = resolveGateBash();

/** 没有可用 bash ⇒ skip（带可操作提示）。返回 false 时调用方必须 return，不能继续断言。 */
function requireBash(t) {
  if (BASH.available) {
    t.diagnostic(`门禁用 bash = ${BASH.path}`);
    return true;
  }
  t.diagnostic(BASH.hint);
  t.skip(`无可用 bash，跳过门禁实跑：${BASH.attempts.map((a) => `${a.candidate}（${a.reason}）`).join('；')}`);
  return false;
}

/** 覆盖判据要覆盖的在册文件数（镜像会断言与真实仓库一致）。 */
const DEPLOY_FILES = git(ROOT, ['ls-files', 'deploy'])
  .split('\n').map((s) => s.trim()).filter((s) => s !== '');
const N = DEPLOY_FILES.length;

/** 镜像内的原始索引页文本（每条反例跑完都恢复成它）。 */
let ORIGINAL = '';
let mirror = '';

function git(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
    .stdout ?? '';
}

// --------------------------------------------------------------------------- 表格行内省
// 测试侧自带一份**独立于工具实现**的最小解析：只用来在夹具里定位「某路径的专用表格行」，
// 以及证明「删了表行之后正文里还写着这个路径」。故意不 import 工具里的实现，避免测试跟着实现一起错。

/** 按未转义的 `|` 把表格行切成 { head:'|', cell:首列原文, tail:'| …' }。 */
function splitFirstCell(line) {
  const start = line.indexOf('|');
  let i = start + 1;
  while (i < line.length && !(line[i] === '|' && line[i - 1] !== '\\')) i += 1;
  return { head: line.slice(0, start + 1), cell: line.slice(start + 1, i), tail: line.slice(i) };
}

const isTableRow = (line) => /^\s*\|/.test(line);

/** 首列 → 路径（去链接/反引号/空白/前导 `../`）。 */
function cellPath(cell) {
  return cell.replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1').replace(/`/g, '').trim()
    .replace(/^(?:\.\.\/)+/, '').replace(/^\.\//, '');
}

const firstCellPath = (line) => (isTableRow(line) ? cellPath(splitFirstCell(line).cell) : '');

/** 索引页里「首列就是 path」的那几行（正常情况下恰好 1 行）。 */
const ownRows = (text, path) => text.split('\n').filter((line) => firstCellPath(line) === path);

const GATE_NAME = /^FAIL 索引覆盖 deploy\/ 全部在册文件/;

// --------------------------------------------------------------------------- 镜像
const runGate = (cwd) => {
  const run = spawnSync(process.execPath, [TOOL], { cwd, encoding: 'utf8', windowsHide: true, timeout: 180000, env: BASH.env });
  assert.equal(run.error, undefined, `镜像内门禁未能启动：${run.error?.message ?? ''}`);
  return { status: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '' };
};

/** 门禁的 FAIL 行与汇总行。 */
const failLines = (stdout) => stdout.split('\n').filter((line) => line.startsWith('FAIL'));
const summaryOf = (stdout) => /(\d+)\/(\d+) 项通过/.exec(stdout);

/**
 * 反例的统一断言：exit≠0、FAIL 恰好 1 条、且该条是覆盖判据并按 mustInclude 点名原因。
 * 「恰好 1 条」是关键 —— 多出别的 FAIL 就说明镜子没铺全或改动牵连了别的判据，这条反例没有证明力。
 */
function expectCoverageRed(run, mustInclude) {
  assert.notEqual(run.status, 0, `改坏索引页后必须 exit 1；实际 ${run.status}\n${run.stdout}\n${run.stderr}`);
  const fails = failLines(run.stdout);
  assert.equal(fails.length, 1, `只允许覆盖判据这 1 项 FAIL：\n${fails.join('\n') || '(无 FAIL 行)'}\n${run.stdout}`);
  assert.match(fails[0], GATE_NAME, `FAIL 的必须是覆盖判据：${fails[0]}`);
  for (const piece of mustInclude) {
    assert.ok(fails[0].includes(piece), `FAIL 必须点名「${piece}」：${fails[0]}`);
  }
  const summary = summaryOf(run.stdout);
  assert.ok(summary, `门禁必须跑到汇总行（中途异常中止不算证明力）：\n${run.stdout}`);
  assert.equal(Number(summary[2]) - Number(summary[1]), 1, `恰好 1 项失败：${summary[0]}`);
}

/** 换掉镜像里的索引页跑一次门禁，跑完（含抛错）恢复原文。 */
function gateWithIndex(mutated) {
  const file = join(mirror, INDEX);
  try {
    assert.notEqual(mutated, ORIGINAL, '夹具必须真的改到索引页，否则本条反例没有证明力');
    writeFileSync(file, mutated);
    return runGate(mirror);
  } finally {
    writeFileSync(file, ORIGINAL);
  }
}

before(() => {
  mirror = mkdtempSync(join(tmpdir(), 'gy-relidx-strict-'));

  const copy = (path, bytes) => {
    const dest = join(mirror, path);
    mkdirSync(dirname(dest), { recursive: true });
    if (bytes === undefined) copyFileSync(join(ROOT, path), dest);
    else writeFileSync(dest, bytes);
  };
  // `.sh` 取 blob：本机 core.autocrlf=true 时工作区是 CRLF，直接拷会给 LF 判据造假红。
  const copyBlob = (path) => copy(path, git(ROOT, ['cat-file', 'blob', `HEAD:${path}`]));

  copy(TOOL);                                    // ① 工具本体（ROOT 由它自己的位置推出）
  copy(INDEX);                                   // ② 索引页：先按原样铺，对照组要用它
  for (const path of DEPLOY_FILES) {             // ③ deploy/**（覆盖判据的数据源）
    if (path.endsWith('.sh')) copyBlob(path);
    else copy(path);
  }
  for (const path of [                           // ④ 门禁按固定路径读的文件
    'package.json',
    'services/api/src/config.ts',                //    （它 import 不到 ./contract.ts 时门禁走正则兜底，结果等价）
    'services/api/src/routes/health.ts',
    'services/api/src/db/migrate.ts'
  ]) copy(path);
  for (const name of readdirSync(join(ROOT, MIGRATIONS))) {          // ⑤ migrations 整目录（门禁用 readdirSync 取名字）
    if (/^\d{4}_.*\.sql$/.test(name)) copy(`${MIGRATIONS}/${name}`);
  }
  for (const name of readdirSync(join(ROOT, `${MIGRATIONS}/rollback`))) {
    if (/^\d{4}_.*\.down\.sql$/.test(name)) copy(`${MIGRATIONS}/rollback/${name}`);
  }
  for (const target of readFileSync(join(ROOT, INDEX), 'utf8').matchAll(/\]\(([^)]+)\)/g)) {  // ⑥ 索引相对链接目标
    const link = target[1];
    if (/^[a-z]+:|^#/.test(link)) continue;
    const [pathPart] = link.split('#');
    if (pathPart === '') continue;
    const source = resolve(ROOT, dirname(INDEX), pathPart);
    const rel = relative(ROOT, source);
    assert.ok(rel !== '' && !rel.startsWith('..'), `索引链接不得指向仓外：${link}`);
    if (statSync(source).isDirectory()) mkdirSync(join(mirror, rel), { recursive: true });
    else copy(rel);
  }

  // 让镜像自己成为真 git 仓库：覆盖判据走 `git ls-files deploy`，脚本 LF 判据走 `git cat-file blob HEAD:…`。
  // 三条 `-c` 都是为了不依赖本机/CI 的全局 git 配置（autocrlf 会假红、gpgsign 会卡住）。
  git(mirror, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  git(mirror, ['-c', 'core.autocrlf=false', 'add', '-A', '-f']);
  git(mirror, ['-c', 'core.autocrlf=false', '-c', 'user.name=gy-relidx-strict',
    '-c', 'user.email=strict@example.invalid', '-c', 'commit.gpgsign=false',
    'commit', '-q', '-m', 'fixture: GY-I24 索引页镜像']);

  const mirrored = git(mirror, ['ls-files', 'deploy']).split('\n').filter((s) => s.trim() !== '').length;
  assert.equal(mirrored, N, '镜像的 deploy 在册数必须与真实仓库一致，否则红的原因就不是改动了');

  ORIGINAL = readFileSync(join(mirror, INDEX), 'utf8');
});

after(() => {
  if (mirror === '') return;
  const prefix = resolve(tmpdir()) + sep;
  assert.ok(mirror.startsWith(prefix), `镜像不在系统临时目录里，拒绝删除：${mirror}`);
  rmSync(mirror, { recursive: true, force: true });
});

// --------------------------------------------------------------------------- 正控制
test('正控制：镜像一字不改 ⇒ 门禁全绿，且计数确实被读到', (t) => {
  if (!requireBash(t)) return;
  const run = runGate(mirror);
  assert.equal(run.status, 0, `对照组必须全绿（红了说明镜像没铺全，后面的反例都无效）：\n${run.stdout}\n${run.stderr}`);
  assert.equal(failLines(run.stdout).length, 0, `对照组不得有 FAIL 行：\n${run.stdout}`);

  const summary = summaryOf(run.stdout);
  assert.ok(summary, `对照组必须跑到汇总行：\n${run.stdout}`);
  assert.equal(summary[1], summary[2], `对照组必须全通过：${summary[0]}`);

  // 计数不是「不判即绿」：PASS 明细里必须带页面上的 N/N，证明这一项真的读到了计数。
  const pass = run.stdout.split('\n').find((line) => /^PASS 索引覆盖 deploy\/ 全部在册文件/.test(line));
  assert.ok(pass, `覆盖判据必须有 PASS 行：\n${run.stdout}`);
  assert.ok(pass.includes(`${N} 个文件全部在索引表行中`), `覆盖判据必须报在册数：${pass}`);
  assert.ok(pass.includes(`覆盖计数 ${N}/${N}`), `覆盖判据必须报计数读数：${pass}`);
  t.diagnostic(`正控制: ${summary[0]}；${pass}`);
});

// --------------------------------------------------------------------------- 反例 1
test('反例1：删掉表格专用行（§4 正文/交叉引用仍写着该路径）⇒ 未索引 点名', (t) => {
  if (!requireBash(t)) return;
  // 选这个文件是因为它除了自己那行之外，还被 §1 的 service-settings 行交叉引用（且带 ✅）。
  const target = `deploy/cloudrun/env.placeholder.json`;
  const rows = ownRows(ORIGINAL, target);
  assert.equal(rows.length, 1, `夹具前提：${target} 必须恰好有一行专用表格行；实际 ${rows.length}`);

  const kept = ORIGINAL.split('\n').filter((line) => line !== rows[0]);
  assert.equal(ORIGINAL.split('\n').length - kept.length, 1, '夹具必须删到且只删到 1 行');
  const mutated = kept.join('\n');

  // 反例的证明力所在：删掉表行后，页面里**仍然**有「表格行 + ✅ + 该路径」——这正是旧判据被绕过的地方。
  const fooled = mutated.split('\n').filter((line) => isTableRow(line) && line.includes('✅') && line.includes(target));
  assert.ok(fooled.length >= 1, `夹具前提：正文/交叉引用里必须仍写着 ${target}（否则反例证明不了旧判据会被骗）`);
  assert.equal(ownRows(mutated, target).length, 0, '夹具前提：新判据下已没有任何行首列等于该路径');

  // 把旧判据（「任意一行含 ✅ 且含该路径」，2026-10-18 修掉的版本）原样跑一遍，要求它在这份改坏的页面上
  // **仍然判绿**：否则这条反例就没打在真正的盲区上，红也说明不了修复了什么。
  const oldRuleMissing = DEPLOY_FILES.filter((path) =>
    !mutated.split('\n').some((line) => isTableRow(line) && line.includes('✅') && line.includes(path)));
  assert.deepEqual(oldRuleMissing, [], `旧判据本该被骗过：${oldRuleMissing.join(', ')}`);

  const run = gateWithIndex(mutated);
  expectCoverageRed(run, ['未索引：', target]);
  t.diagnostic(`反例1: ${failLines(run.stdout)[0]}`);
});

// --------------------------------------------------------------------------- 反例 2
test('反例2：覆盖计数被改（29/30、28/28）⇒ 计数不符', (t) => {
  if (!requireBash(t)) return;
  // 旧工具根本不读这处数字（审查实测 30/30、30/31 全绿），所以这里没有「旧判据」可回放：
  // 本条证明的是新增的计数一致性判据本身有牙。
  const countLine = ORIGINAL.split('\n').find((line) =>
    isTableRow(line) && line.includes('覆盖') && line.includes('deploy/') && /\d+\s*\/\s*\d+/.test(line));
  assert.ok(countLine, '夹具前提：索引页必须有一行同时写「覆盖」「deploy/」「N/N」');
  assert.ok(countLine.includes(`${N}/${N}`), `夹具前提：计数行必须写 ${N}/${N}；实际：${countLine}`);

  // (a) 分母写错：审查实测过的形状（29/30 曾照样绿）。
  const denominatorWrong = gateWithIndex(ORIGINAL.replace(countLine, countLine.replace(`${N}/${N}`, `${N}/${N + 1}`)));
  expectCoverageRed(denominatorWrong, ['覆盖计数不符', `${N}/${N + 1} ≠ 在册 ${N}`]);
  t.diagnostic(`反例2a: ${failLines(denominatorWrong.stdout)[0]}`);

  // (b) 分子分母一起改、内部自洽：审查实测的 `30/30 → 29/29` 就是这个形状，必须也红。
  const selfConsistent = gateWithIndex(ORIGINAL.replace(countLine, countLine.replace(`${N}/${N}`, `${N - 1}/${N - 1}`)));
  expectCoverageRed(selfConsistent, ['覆盖计数不符', `${N - 1}/${N - 1} ≠ 在册 ${N}`]);
  t.diagnostic(`反例2b: ${failLines(selfConsistent.stdout)[0]}`);
});

// --------------------------------------------------------------------------- 反例 3
test('反例3：行内去掉 ✅ ⇒ 未索引 点名', (t) => {
  if (!requireBash(t)) return;
  const target = 'deploy/postgres-cvm/runbook.md';
  const rows = ownRows(ORIGINAL, target);
  assert.equal(rows.length, 1, `夹具前提：${target} 必须恰好有一行专用表格行；实际 ${rows.length}`);
  assert.ok(rows[0].includes('✅'), `夹具前提：该行必须带 ✅；实际：${rows[0]}`);

  const mutated = ORIGINAL.replace(rows[0], rows[0].replace('✅', ''));
  assert.equal(ownRows(mutated, target).length, 1, '路径还在，只是不再标 ✅ —— 判据必须看 ✅ 而不是「出现过」');

  const run = gateWithIndex(mutated);
  expectCoverageRed(run, ['未索引：', target]);
  t.diagnostic(`反例3: ${failLines(run.stdout)[0]}`);
});

// --------------------------------------------------------------------------- 反例 4
test('反例4：把路径写成另一个在册文件 ⇒ 缺行 点名原路径', (t) => {
  if (!requireBash(t)) return;
  const missingPath = 'deploy/cloudrun/local-check.ps1';
  const otherPath = 'deploy/cloudrun/Dockerfile';
  const rows = ownRows(ORIGINAL, missingPath);
  const others = ownRows(ORIGINAL, otherPath);
  assert.equal(rows.length, 1, `夹具前提：${missingPath} 必须恰好有一行专用表格行；实际 ${rows.length}`);
  assert.equal(others.length, 1, `夹具前提：${otherPath} 必须恰好有一行专用表格行；实际 ${others.length}`);

  // 首列（含链接）整体换成另一个在册文件的写法：链接可解析、路径都存在，唯一的问题是「缺了一行」。
  const { head, tail } = splitFirstCell(rows[0]);
  const mutated = ORIGINAL.replace(rows[0], head + splitFirstCell(others[0]).cell + tail);
  assert.equal(ownRows(mutated, missingPath).length, 0, '夹具前提：原路径的专用行必须已不存在');
  assert.equal(ownRows(mutated, otherPath).length, 2, '夹具前提：另一个文件应变成 2 行（重复收录）');

  const run = gateWithIndex(mutated);
  expectCoverageRed(run, ['未索引：', missingPath]);
  t.diagnostic(`反例4: ${failLines(run.stdout)[0]}`);
});

// --------------------------------------------------------------------------- 反例 5
test('反例5：✅ 挪到该行中间列、核验列写 ❌ 未核验 ⇒ 未索引 点名', (t) => {
  if (!requireBash(t)) return;
  // 2026-10-18 复审实测的第三个洞：判据若只查 `row.line.includes('✅')`，把该行的 ✅ 挪到第 2 列、
  // 末列（核验列）改写成 `❌ 未核验`，门禁仍 exit 0 / 15/15 —— 等于「行内标过 ✅ 就算核验过」。
  const target = 'deploy/postgres-cvm/runbook.md';
  const rows = ownRows(ORIGINAL, target);
  assert.equal(rows.length, 1, `夹具前提：${target} 必须恰好有一行专用表格行；实际 ${rows.length}`);

  const { head, cell, tail } = splitFirstCell(rows[0]);
  // tail 形如 `| 第2列 | 第3列 |`：切出中间列与末列（末列 = 核验列）。
  const tailCells = tail.replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/);
  assert.equal(tailCells.length, 2, `夹具前提：该行必须是三列（首列 + 作用列 + 核验列）；实际 tail=「${tail}」`);
  assert.ok(tailCells[1].trim().startsWith('✅'), `夹具前提：核验列原本必须以 ✅ 开头；实际：「${tailCells[1].trim()}」`);

  // ✅ 从核验列挪到中间列，核验列改写为 ❌ —— 首列路径没变、整行仍含 ✅，只是 ✅ 换了列。
  const mutatedRow = `${head}${cell}| ✅ ${tailCells[0].trim()} | ❌ 未核验 |`;
  const mutated = ORIGINAL.replace(rows[0], mutatedRow);
  assert.equal(ownRows(mutated, target).length, 1, '路径还在同一行、只是 ✅ 换了列 —— 判据必须看列位而不是「行内有 ✅」');
  assert.ok(mutatedRow.includes('✅'), `夹具前提：✅ 仍在本行内（旧判据 row.line.includes('✅') 会判绿）：${mutatedRow}`);
  assert.ok(mutatedRow.trimEnd().endsWith('| ❌ 未核验 |'), `夹具前提：核验列必须已写成 ❌ 未核验：${mutatedRow}`);

  const run = gateWithIndex(mutated);
  expectCoverageRed(run, ['未索引：', target]);
  t.diagnostic(`反例5: ${failLines(run.stdout)[0]}`);
});
