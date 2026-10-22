/**
 * GY-R31 · #24 发版 runbook 门禁的**回归**：证明「必备小节＋命令块＋无占位符」这三条判据真会红。
 *
 * 为什么需要这份测试：同一份门禁在 `release-materials-index*.test.mjs` 里只被正向跑过一次
 * （「改坏索引页 ⇒ 覆盖判据红」）。而本轮新增的第 16 项判的是**另一份文件**（发版 runbook）的
 * **内容完整性**，正向实跑永远绿 —— 判据写松、写死、只认文件名，都能把「照做就能发版」变成
 * 「文件存在即算」。所以这里逐条把 runbook 改坏，要求门禁 exit 1、FAIL **恰好 1 条**且点名原因。
 *
 * 做法：在 `os.tmpdir()` 下铺一个能跑门禁的镜像仓（工具本体 + 索引页 + `deploy/**` + 门禁按固定
 * 路径读的文件 + migrations + 索引相对链接目标，其中包含 runbook 本身），先证一字不改时全绿，
 * 再逐条改坏 runbook 跑门禁。镜像跑完连失败路径一起删净；⛔ 不改仓内任何文件。
 *
 * ⚠️ 分工：本文件**不重复实现**判据，只驱动 `tools/verify-release-materials.mjs`。
 * 判据的唯一定义在工具源码里（`runbookProblems()`），否则测试跟着实现一起错时两边都发现不了。
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

/** 被判据约束的 runbook（与工具里的 `RUNBOOK` 常量同值；改一处必须同步另一处）。 */
const RUNBOOK = 'docs/release/runbook-20261022.md';

/** 与工具里的 `RUNBOOK_MIN_COMMAND_BLOCKS` 同值。反例 D/E 靠它算「要削掉几个块」。 */
const MIN_COMMAND_BLOCKS = 14;

/** 判据名（工具里的 check 名称）。FAIL 行必须以它开头，否则红的不是这一项。 */
const GATE_NAME = '发版 runbook 可按步骤执行';

/**
 * 门禁里的 `bash -n` 由**子进程的 PATH** 解析 `bash`。本机 `bash` 是 WSL 存根（只打印
 * 「wsl: 检测到 localhost 代理配置…」并返回 1），于是镜像里的门禁会先在 CVM 脚本那项红——
 * 红的不是本文件要测的判据。这里显式解析真 bash（`GY_BASH` 优先）并把它前置进子进程 PATH；
 * 一个真 bash 都没有时**显式 skip 并打印指路**，⛔ 不静默 pass、⛔ 不改判据。
 */
const BASH = resolveGateBash();

function requireBash(t) {
  if (BASH.available) {
    t.diagnostic(`门禁用 bash = ${BASH.path}`);
    return true;
  }
  t.diagnostic(BASH.hint);
  t.skip(`无可用 bash，跳过门禁实跑：${BASH.attempts.map((a) => `${a.candidate}（${a.reason}）`).join('；')}`);
  return false;
}

function git(cwd, args) {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 0, `git ${args.join(' ')} 失败：${run.stderr ?? ''}`);
  return run.stdout ?? '';
}

// --------------------------------------------------------------------------- runbook 结构内省
// 测试侧自带一份**独立于工具实现**的最小围栏解析：只用来在夹具里定位「某一节」「第 N 个命令块」，
// 以及构造「把命令块掏空」的改法。故意不 import 工具里的实现，避免跟着实现一起错。

/** 围栏切块：返回 `[{ lang, openIndex, closeIndex }]`（行号均为 0 基）。 */
function fenceBlocks(lines) {
  const blocks = [];
  let open = null;
  for (let i = 0; i < lines.length; i += 1) {
    const fence = /^\s*(?:```|~~~)\s*([A-Za-z0-9_-]*)/.exec(lines[i]);
    if (fence === null) continue;
    if (open === null) {
      open = { lang: fence[1].toLowerCase(), openIndex: i, closeIndex: -1 };
    } else {
      blocks.push({ ...open, closeIndex: i });
      open = null;
    }
  }
  return blocks;
}

/** 取某一节的行区间 `[headingIndex, nextHeadingIndex)`；找不到返回 null。 */
function sectionRange(lines, heading) {
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^## /.test(lines[i])) { end = i; break; }
  }
  return { start, end };
}

/** 门禁的 FAIL 行与汇总行。 */
const failLines = (stdout) => stdout.split('\n').filter((line) => line.startsWith('FAIL'));
const summaryOf = (stdout) => /(\d+)\/(\d+) 项通过/.exec(stdout);

/** 跑门禁。 */
const runGate = (cwd) => {
  const run = spawnSync(process.execPath, [TOOL], { cwd, encoding: 'utf8', windowsHide: true, timeout: 180000, env: BASH.env });
  assert.equal(run.error, undefined, `镜像内门禁未能启动：${run.error?.message ?? ''}`);
  return { status: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '' };
};

/**
 * 反例的统一断言：exit≠0、FAIL **恰好 1 条**、该条是本判据且点名 mustInclude。
 * 「恰好 1 条」是关键 —— 多出别的 FAIL 说明镜子没铺全或改动牵连了别的判据，这条反例就没有证明力。
 */
function expectRunbookRed(run, mustInclude) {
  assert.notEqual(run.status, 0, `改坏 runbook 后必须 exit 1；实际 ${run.status}\n${run.stdout}\n${run.stderr}`);
  const fails = failLines(run.stdout);
  assert.equal(fails.length, 1, `只允许本判据这 1 项 FAIL：\n${fails.join('\n') || '(无 FAIL 行)'}\n${run.stdout}`);
  assert.ok(fails[0].startsWith(`FAIL ${GATE_NAME}`), `FAIL 的必须是 runbook 判据：${fails[0]}`);
  for (const piece of mustInclude) {
    assert.ok(fails[0].includes(piece), `FAIL 必须点名「${piece}」：${fails[0]}`);
  }
  const summary = summaryOf(run.stdout);
  assert.ok(summary, `门禁必须跑到汇总行（中途异常中止不算证明力）：\n${run.stdout}`);
  assert.equal(Number(summary[2]) - Number(summary[1]), 1, `恰好 1 项失败：${summary[0]}`);
}

// --------------------------------------------------------------------------- 镜像
let mirror = '';
let ORIGINAL = '';

/** 换掉镜像里的 runbook 跑一次门禁，跑完（含抛错）恢复原文。 */
function gateWithRunbook(mutated) {
  const file = join(mirror, RUNBOOK);
  try {
    assert.notEqual(mutated, ORIGINAL, '夹具必须真的改到 runbook，否则本条反例没有证明力');
    writeFileSync(file, mutated);
    return runGate(mirror);
  } finally {
    writeFileSync(file, ORIGINAL);
  }
}

before(() => {
  mirror = mkdtempSync(join(tmpdir(), 'gy-runbook-guard-'));

  const copy = (path, bytes) => {
    const dest = join(mirror, path);
    mkdirSync(dirname(dest), { recursive: true });
    if (bytes === undefined) copyFileSync(join(ROOT, path), dest);
    else writeFileSync(dest, bytes);
  };
  // `.sh` 取 blob：本机 core.autocrlf=true 时工作区是 CRLF，直接拷会给 LF 判据造假红。
  const copyBlob = (path) => copy(path, git(ROOT, ['cat-file', 'blob', `HEAD:${path}`]));

  copy(TOOL);                                    // ① 工具本体（ROOT 由它自己的位置推出）
  copy(INDEX);                                   // ② 索引页
  for (const path of git(ROOT, ['ls-files', 'deploy']).split('\n').map((s) => s.trim()).filter((s) => s !== '')) {
    if (path.endsWith('.sh')) copyBlob(path);    // ③ deploy/**（覆盖判据的数据源）
    else copy(path);
  }
  for (const path of [                           // ④ 门禁按固定路径读的文件
    'package.json',
    'services/api/src/config.ts',
    'services/api/src/routes/health.ts',
    'services/api/src/db/migrate.ts',
    RUNBOOK,                                     //    被判据约束的 runbook（也是索引链接目标）
  ]) copy(path);

  const MIGRATIONS = 'services/api/db/migrations';            // ⑤ migrations 整目录（门禁 readdirSync 取名字）
  for (const name of readdirSync(join(ROOT, MIGRATIONS))) {
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

  // 让镜像自己成为真 git 仓库：覆盖判据走 `git ls-files deploy`，脚本判据走 `git cat-file blob HEAD:…`。
  // 三条 `-c` 都是为了不依赖本机/CI 的全局 git 配置（autocrlf 会假红、gpgsign 会卡住）。
  git(mirror, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  git(mirror, ['-c', 'core.autocrlf=false', 'add', '-A', '-f']);
  git(mirror, ['-c', 'core.autocrlf=false', '-c', 'user.name=gy-runbook-guard',
    '-c', 'user.email=guard@example.invalid', '-c', 'commit.gpgsign=false',
    'commit', '-q', '-m', 'fixture: GY-R31 发版 runbook 镜像']);

  ORIGINAL = readFileSync(join(mirror, RUNBOOK), 'utf8');
});

after(() => {
  if (mirror === '') return;
  const prefix = resolve(tmpdir()) + sep;
  assert.ok(mirror.startsWith(prefix), `镜像不在系统临时目录里，拒绝删除：${mirror}`);
  rmSync(mirror, { recursive: true, force: true });
});

// --------------------------------------------------------------------------- 正控制
test('正控制：镜像一字不改 ⇒ 门禁全绿，runbook 判据为 PASS', (t) => {
  if (!requireBash(t)) return;
  const run = runGate(mirror);
  assert.equal(run.status, 0, `对照组必须全绿（红了说明镜像没铺全，后面的反例都无效）：\n${run.stdout}\n${run.stderr}`);
  assert.equal(failLines(run.stdout).length, 0, `对照组不得有 FAIL 行：\n${run.stdout}`);
  const pass = run.stdout.split('\n').find((line) => line.startsWith(`PASS ${GATE_NAME}`));
  assert.ok(pass, `runbook 判据必须有 PASS 行：\n${run.stdout}`);
  const summary = summaryOf(run.stdout);
  assert.ok(summary, `对照组必须跑到汇总行：\n${run.stdout}`);
  assert.equal(summary[1], summary[2], `对照组必须全通过：${summary[0]}`);
  t.diagnostic(`正控制: ${summary[0]}；${pass}`);
});

// --------------------------------------------------------------------------- 反例 1
test('反例1：删掉「7 回滚」整节 ⇒ 缺必备小节 点名该节', (t) => {
  if (!requireBash(t)) return;
  const lines = ORIGINAL.split('\n');
  const range = sectionRange(lines, '## 7 回滚');
  assert.ok(range, '夹具前提：runbook 必须有「## 7 回滚」这一节');
  const mutated = [...lines.slice(0, range.start), ...lines.slice(range.end)].join('\n');
  assert.ok(mutated.split('\n').length < lines.length, '夹具必须真的删到行');
  assert.equal(mutated.includes('## 7 回滚'), false, '夹具前提：该节标题必须已不存在');

  const run = gateWithRunbook(mutated);
  expectRunbookRed(run, ['缺必备小节：', '## 7 回滚']);
  t.diagnostic(`反例1: ${failLines(run.stdout)[0]}`);
});

// --------------------------------------------------------------------------- 反例 2
test('反例2：把「6 灰度与放量判据」改名（节还在、名字不对）⇒ 缺必备小节 点名该节', (t) => {
  if (!requireBash(t)) return;
  const heading = '## 6 灰度与放量判据';
  assert.ok(ORIGINAL.includes(heading), `夹具前提：runbook 必须有「${heading}」`);
  // 只改标题文字、正文整段保留：证明判据认的是**标题逐字**，不是「这一带看起来像灰度」。
  const mutated = ORIGINAL.replace(heading, '## 6 灰度放量说明');
  const run = gateWithRunbook(mutated);
  expectRunbookRed(run, ['缺必备小节：', heading]);
  t.diagnostic(`反例2: ${failLines(run.stdout)[0]}`);
});

// --------------------------------------------------------------------------- 反例 3
test('反例3：往命令块里塞占位符 ⇒ 含占位符 点名行号', (t) => {
  if (!requireBash(t)) return;
  const lines = ORIGINAL.split('\n');
  const blocks = fenceBlocks(lines).filter((block) => ['bash', 'sh', 'powershell'].includes(block.lang));
  assert.ok(blocks.length >= MIN_COMMAND_BLOCKS, `夹具前提：runbook 的命令块不少于 ${MIN_COMMAND_BLOCKS} 个；实际 ${blocks.length}`);
  // 塞进**命令块内部**（而不是散文里）：真实执行者复制到的正是这些行。
  const at = blocks[0].openIndex + 1;
  lines[at] = `echo "${'<'}口令文件路径${'>'}"`;
  const mutated = lines.join('\n');

  const run = gateWithRunbook(mutated);
  expectRunbookRed(run, ['含占位符：', `${RUNBOOK}:${at + 1}`]);
  t.diagnostic(`反例3: ${failLines(run.stdout)[0]}`);
});

// --------------------------------------------------------------------------- 反例 4
test('反例4：把第一节以外所有命令块的语言标记改成 text ⇒ 可复制命令块不足', (t) => {
  if (!requireBash(t)) return;
  const lines = ORIGINAL.split('\n');
  const blocks = fenceBlocks(lines);
  const commandIndices = blocks
    .map((block, index) => ({ index, lang: block.lang }))
    .filter((entry) => ['bash', 'sh', 'shell', 'powershell', 'ps1', 'pwsh'].includes(entry.lang));
  // 只留下限减 1 个，其余降级成 text（围栏与内容都不动 ⇒ 只踩「数量」这一条）。
  const keep = MIN_COMMAND_BLOCKS - 1;
  assert.ok(commandIndices.length > keep, `夹具前提：命令块数量必须超过 ${keep}；实际 ${commandIndices.length}`);
  for (const entry of commandIndices.slice(keep)) lines[blocks[entry.index].openIndex] = '```text';
  const mutated = lines.join('\n');

  const run = gateWithRunbook(mutated);
  expectRunbookRed(run, ['可复制命令块不足：', `下限 ${MIN_COMMAND_BLOCKS}`]);
  t.diagnostic(`反例4: ${failLines(run.stdout)[0]}`);
});

// --------------------------------------------------------------------------- 反例 5
test('反例5：把某个命令块掏空成只剩注释 ⇒ 命令块里没有可执行行', (t) => {
  if (!requireBash(t)) return;
  const lines = ORIGINAL.split('\n');
  const block = fenceBlocks(lines).find((entry) => entry.lang === 'bash' && entry.closeIndex - entry.openIndex > 2);
  assert.ok(block, '夹具前提：runbook 必须有一个至少 2 行的 bash 块');
  const body = [];
  for (let i = block.openIndex + 1; i < block.closeIndex; i += 1) body.push('# 这里原本是命令');
  const mutated = [
    ...lines.slice(0, block.openIndex + 1),
    ...body,
    ...lines.slice(block.closeIndex),
  ].join('\n');

  const run = gateWithRunbook(mutated);
  expectRunbookRed(run, ['命令块里没有可执行行']);
  t.diagnostic(`反例5: ${failLines(run.stdout)[0]}`);
});

// =========================================================================== 内容面守卫（2026-10-22 监工 P2）
// 上面五条证明的是「判据真会红」，但它们全都**不检查命令能不能跑**：一块标着 `bash` 的围栏里
// 写 `$env:GY_BASH=…`（PowerShell 赋值）照样全绿，因为 `bash -n` 只校验 `deploy/**/*.sh`。
// 监工在 #473 的 P2 上点到两个真实缺口，这里各钉一条（外加 shell 标注），只钉**可执行性**，
// 不重复门禁已有的「必备小节／命令块数／占位符」三条判据。
//
// ⚠️ 这些守卫读的是**仓内真文件**（不是镜像里那份夹具），所以它们直接对交付物断言。

const RUNBOOK_TEXT = readFileSync(join(ROOT, RUNBOOK), 'utf8');
const RUNBOOK_LINES = RUNBOOK_TEXT.split('\n');

/** 所有围栏按出现顺序成对切块；落单的围栏会被算成闭围栏 ⇒ 守卫3 先用数量自证解析成立。 */
const RUNBOOK_BLOCKS = fenceBlocks(RUNBOOK_LINES);

test('守卫1：凡标 bash 的块不得出现 PowerShell 专有写法（$env: / $PSVersionTable）', () => {
  const bashBlocks = RUNBOOK_BLOCKS.filter((block) => block.lang === 'bash');
  assert.ok(bashBlocks.length > 0, '前提：runbook 应有 bash 块（本次 P2 修的正是 §1.1 那块）');

  const offenders = [];
  for (const block of bashBlocks) {
    for (let i = block.openIndex + 1; i < block.closeIndex; i += 1) {
      // `$env:X` / `$PSVersionTable` 在 bash 里都不是合法取值，而是「像命令的字符串」：
      // 粘进 bash 要么被当成普通赋值静默失效，要么让 `bash -n` 之前就红。两者都不可接受。
      if (/\$env:|\$PSVersionTable/i.test(RUNBOOK_LINES[i])) {
        offenders.push(`${RUNBOOK}:${i + 1}: ${RUNBOOK_LINES[i].trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    `bash 块里出现 PowerShell 写法（bash 不能执行，用户会以为「照着做了」）：
${offenders.join('\n')}`);
});

test('守卫2：探针命令/URL 不得硬编码保留域（.invalid / example.）', () => {
  const offenders = [];
  for (const block of RUNBOOK_BLOCKS) {
    for (let i = block.openIndex + 1; i < block.closeIndex; i += 1) {
      const line = RUNBOOK_LINES[i];
      const urls = line.match(/https?:\/\/[^\s'"`<>()]+/g) ?? [];
      // 只看「真发请求的行」：有 curl，或写了绝对 URL。`*.invalid` 这种 case 模式不是请求。
      if (!/\bcurl\b/.test(line) && urls.length === 0) continue;
      for (const url of urls) {
        const host = url.replace(/^https?:\/\//, '').split('/')[0].split(':')[0].toLowerCase();
        const reserved = host.endsWith('.invalid') || host === 'invalid'
          || host.startsWith('example.') || host.includes('.example.');
        if (reserved) offenders.push(`${RUNBOOK}:${i + 1}: ${host}`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    `探针/请求里写死了保留域（RFC 2606 的 .invalid / example. 永远不会是真实部署，探针必然失败）：
${offenders.join('\n')}`);
});

test('守卫3：每个含命令的代码块必须有 shell 标注（裸围栏一律红）', () => {
  // 三条守卫共用同一份配对解析，所以先把「围栏成对」这条前提自证掉：
  // 有未闭合围栏时，闭围栏会被当成开围栏，后面的语言标记全会错位一格。
  const fenceLines = RUNBOOK_LINES.filter((line) => /^\s*(?:```|~~~)/.test(line)).length;
  assert.ok(fenceLines > 0, '前提：runbook 里必须有代码围栏');
  assert.equal(fenceLines % 2, 0, `围栏必须成对：共 ${fenceLines} 个（奇数说明有未闭合块）`);
  assert.equal(RUNBOOK_BLOCKS.length, fenceLines / 2, '配对切块数必须等于围栏数的一半');

  const unlabeled = RUNBOOK_BLOCKS
    .filter((block) => block.lang === '')
    .filter((block) => {
      for (let i = block.openIndex + 1; i < block.closeIndex; i += 1) {
        const line = RUNBOOK_LINES[i].trim();
        if (line !== '' && !line.startsWith('#')) return true;   // 有可执行行 ⇒ 是命令块
      }
      return false;
    })
    .map((block) => `${RUNBOOK}:${block.openIndex + 1}`);

  assert.deepEqual(unlabeled, [],
    `以下裸围栏（无语言标注）里有命令：执行者无法判断该贴进哪个 shell（bash / powershell）：
${unlabeled.join('\n')}`);
});

