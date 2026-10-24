/**
 * GY-I22 证据表生成器 · 「不许悄悄改写归档快照」的负控制。
 *
 * 为什么有这个文件：`tools/i22-failmatrix-evidence-table.mjs` 原来默认写
 * `docs/verification/gy-i22-failmatrix-20261022.md`——那是 R29 建页的**归档快照**（表格 168 行 /
 * 负控制 23 条）。`EXPECTED` 校正到 230 / 26 之后，裸跑 `--write` 会**无报错**把那份快照重写成
 * 230 行。拦截必须能被机械证伪，所以这里真跑子进程、真读文件字节，不 mock：
 *
 *   1. 正控制：工件自洽 + 目标页是普通页 ⇒ `--write` 真的写盘、exit 0（证明守卫不是「永远红」）；
 *   2. 负控制（本片核心）：`EXPECTED` 与工件不一致 ⇒ `--write` **不写盘**且 exit 1
 *      （写盘已挪到对账 `problems` 判定之后）；
 *   3. 负控制：真实归档页在「裸 `--write`」「显式 `--page=`」「再加 `--i-know-this-rewrites-archive`」
 *      三种调用下都**不被改写**——最后一种因为页内条数（168）≠ `EXPECTED`（230）同样被拒；
 *   3'. 负控制：归档页的**路径别名**（`docs/verification/./x.md`、`docs/verification/../verification/x.md`、
 *      `DOCS/verification/x.md`）修复前全部能从 `rel === ARCHIVE_PAGE` 的字符串比较里溜过去，EXIT 0
 *      把快照从 168 / 23 改写成 230 / 26；现在按**文件身份**（`dev` + `ino`）判定，三种写法都必须
 *      exit 1、字节不变。别名用例在夹具树里跑（夹具树里有一份归档页的**副本**），真仓库那份只做
 *      字节只读断言，顺带保证测试自身不会把归档页留成脏状态；
 *   3''. 负控制：`--page=../outside.md` 这类**越界目标**修复前 EXIT 0 能改仓库外文件；现在包含性
 *      校验早于读文件，仓库外的受害者文件必须一个字节都不变；
 *   3'''. 负控制：归档页的**硬链接**别名（`fs.linkSync` 造同一 inode 的第二个目录项）修复前 EXIT 0
 *      就能整页改写（对照性审查实测）：`realpathSync.native` 归一的是路径、归不了文件身份。现在
 *      `samePath` 比 `dev` + `ino`，硬链接必须 exit 1、归档页 sha256 不变。无权建硬链接的环境
 *      （某些 POSIX / 容器 / 非 NTFS）`t.skip`，不假绿；
 *   3''''. 负控制：`--matrix=` / `--nc=` 越出仓库，或工件缺失，必须**单行**拒绝（exit 1，stderr 不许
 *      出现 node 栈）——与 `--write` 侧的「拒绝写入：目标不在仓库内」口径对齐。
 *   4. 负控制：目标页缺生成器标记 ⇒ 拒绝写入且不写盘。
 *
 * 为什么用临时树：生成器的 `ROOT` 由脚本自身位置推导，`--matrix=` / `--nc=` / `--page=` 都按该
 * `ROOT` 解析相对路径（绝对路径解析不了是既有行为，本测试不碰）。所以夹具树 = 把工具原样复制到
 * `<tmp>/tools/`，工件放 `<tmp>/tests/failmatrix/.artifacts/`，目标页放 `<tmp>/docs/`。
 * 真仓库里只有第 3 组会真的打开归档页——而且只读断言它一个字节都没变。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOOL = path.join(ROOT, 'tools', 'i22-failmatrix-evidence-table.mjs');
/** R29 归档快照页：本测试要求它在任何 `--write` 组合下都不被改写。 */
const ARCHIVE_PAGE = 'docs/verification/gy-i22-failmatrix-20261022.md';

/** 带两对生成器标记的普通目标页（内容故意是占位，写盘后必须被替换掉）。 */
const PAGE_FIXTURE = [
  '# 夹具页（证据表生成器）',
  '',
  '<!-- BEGIN:MATRIX-TABLE -->',
  '（待生成）',
  '<!-- END:MATRIX-TABLE -->',
  '',
  '<!-- BEGIN:NEGATIVE-CONTROL-TABLE -->',
  '（待生成）',
  '<!-- END:NEGATIVE-CONTROL-TABLE -->',
  '',
].join('\n');

/**
 * 从工具源码里读 `EXPECTED` 字面量（不做二次硬编码：常量一改，夹具自动跟上，不会漂成第二份账）。
 * 只做「给裸键补引号 → JSON.parse」，不 eval 任何代码。
 */
function readExpected() {
  const source = readFileSync(TOOL, 'utf8');
  const match = source.match(/const EXPECTED = Object\.freeze\((\{[\s\S]*?\n\})\);/);
  assert.ok(match, '工具里找不到 `const EXPECTED = Object.freeze({…});`：声明被重构了，本测试的夹具需要同步');
  const quoted = match[1]
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":') // 裸键补引号
    .replace(/,\s*([}\]])/g, '$1'); // 去掉 JSON 不接受的尾逗号
  return JSON.parse(quoted);
}

/** 按 EXPECTED 造一份**自洽**的矩阵机读结果（每条一行、全 PASS）。 */
function buildMatrix(expected) {
  const rows = [];
  for (const [family, count] of Object.entries(expected.families)) {
    for (let index = 1; index <= count; index += 1) {
      rows.push({
        id: `${family}-${String(index).padStart(2, '0')}`,
        family,
        expected: { status: 200, code: `${family}_OK` },
        actual: { status: 200, code: `${family}_OK` },
        verdict: 'PASS',
      });
    }
  }
  return {
    generated_at: 'fixture',
    node: 'fixture',
    base_commit: '0'.repeat(40),
    transport: 'fixture',
    totals: { total: rows.length, pass: rows.length, fail: 0 },
    families: Object.fromEntries(Object.entries(expected.families).map(([family, total]) => [family, { total, fail: 0 }])),
    batches: Object.entries(expected.batches).map(([id, total]) => ({ id, total })),
    rows,
  };
}

/** 按 EXPECTED 造一份**自洽**的负控制机读结果（全 PASS）。 */
function buildNegativeControls(expected) {
  const entries = Array.from({ length: expected.negativeControls }, (_, index) => ({
    id: `NC-${String(index + 1).padStart(2, '0')}`,
    title: '夹具',
    file: 'tools/fixture.mjs',
    watch: ['C1-01'],
    evidence: { sha256_before: { 'tools/fixture.mjs': 'a'.repeat(64) } },
    verdict: 'PASS',
  }));
  return { generated_at: 'fixture', node: 'fixture', total: entries.length, pass: entries.length, fail: 0, entries };
}

/** 建一棵夹具树：工具目录 + 工件目录 + docs 目标页。 */
function makeTree(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'gy-i22-evidence-table-'));
  mkdirSync(path.join(root, 'tools'), { recursive: true });
  mkdirSync(path.join(root, 'tests', 'failmatrix', '.artifacts'), { recursive: true });
  mkdirSync(path.join(root, 'docs'), { recursive: true });
  copyFileSync(TOOL, path.join(root, 'tools', 'i22-failmatrix-evidence-table.mjs'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    tool: path.join(root, 'tools', 'i22-failmatrix-evidence-table.mjs'),
    page: path.join(root, 'docs', 'page.md'),
    writeArtifacts(matrix, nc) {
      writeFileSync(
        path.join(root, 'tests', 'failmatrix', '.artifacts', 'matrix.json'),
        `${JSON.stringify(matrix, null, 2)}\n`,
        'utf8',
      );
      writeFileSync(
        path.join(root, 'tests', 'failmatrix', '.artifacts', 'negative-control.json'),
        `${JSON.stringify(nc, null, 2)}\n`,
        'utf8',
      );
    },
  };
}

function runTool(toolPath, args, cwd) {
  const result = spawnSync(process.execPath, [toolPath, ...args], { cwd, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function sha256Of(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * 往夹具树里放一份归档页的**副本**（原字节照抄真仓库那份）。别名 / 硬链接用例都在副本上跑：
 * 断言的是守卫行为，不是「真仓库那份刚好没被碰」；真仓库那份另由第 3 组做字节只读断言。
 */
function seedArchive(tree) {
  const bytes = readFileSync(path.join(ROOT, ARCHIVE_PAGE), 'utf8');
  const archive = path.join(tree.root, ARCHIVE_PAGE.split('/').join(path.sep));
  mkdirSync(path.dirname(archive), { recursive: true });
  writeFileSync(archive, bytes, 'utf8');
  return { archive, bytes };
}

/** 页内某对生成器标记之间的表格行数（与工具判据一致：以 `| \`` 开头的数据行）。 */
function countRowsBetweenMarkers(page, marker) {
  const begin = `<!-- BEGIN:${marker} -->`;
  const end = `<!-- END:${marker} -->`;
  const start = page.indexOf(begin);
  const stop = page.indexOf(end);
  assert.ok(start >= 0 && stop > start, `页里缺标记 ${begin} … ${end}`);
  return page
    .slice(start + begin.length, stop)
    .split('\n')
    .filter((line) => line.startsWith('| `')).length;
}

test('证据表生成器：工件自洽时 --write 真的写盘（守卫不是永远红）', (t) => {
  const tree = makeTree(t);
  const expected = readExpected();
  tree.writeArtifacts(buildMatrix(expected), buildNegativeControls(expected));
  writeFileSync(tree.page, PAGE_FIXTURE, 'utf8');

  const result = runTool(tree.tool, ['--write', '--page=docs/page.md'], tree.root);
  assert.equal(result.status, 0, `应有 0 退出，实际 ${result.status}：\n${result.stdout}\n${result.stderr}`);
  assert.match(
    result.stdout,
    new RegExp(`自洽：矩阵 ${expected.total} 条全 PASS`),
    `末行自洽读数不对：\n${result.stdout}`,
  );

  const page = readFileSync(tree.page, 'utf8');
  assert.ok(!page.includes('（待生成）'), '占位内容没有被替换：标记之间的内容没写进去');
  assert.equal(
    countRowsBetweenMarkers(page, 'MATRIX-TABLE'),
    expected.total,
    `写进页里的矩阵表行数不是 ${expected.total}`,
  );
  assert.equal(
    countRowsBetweenMarkers(page, 'NEGATIVE-CONTROL-TABLE'),
    expected.negativeControls,
    `写进页里的负控制表行数不是 ${expected.negativeControls}`,
  );
});

test('证据表生成器：EXPECTED 与工件不一致时 --write 不写盘且 exit 1', (t) => {
  const tree = makeTree(t);
  const expected = readExpected();
  const matrix = buildMatrix(expected);
  // 两处人为不一致：总条数 −1、C1 族 −1（真跑少一条用例的形态）。
  matrix.totals.total = expected.total - 1;
  matrix.families.C1.total = expected.families.C1 - 1;
  tree.writeArtifacts(matrix, buildNegativeControls(expected));
  writeFileSync(tree.page, PAGE_FIXTURE, 'utf8');

  const result = runTool(tree.tool, ['--write', '--page=docs/page.md'], tree.root);
  assert.equal(result.status, 1, `对账不一致应 exit 1，实际 ${result.status}：\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, new RegExp(`总条数 期望 ${expected.total} 条，实际 ${expected.total - 1} 条`));
  assert.match(result.stderr, /拒绝写入 docs\/page\.md：对账不通过/);
  assert.equal(readFileSync(tree.page, 'utf8'), PAGE_FIXTURE, '对账不通过却写盘了：写盘必须在对账之后');
});

test('证据表生成器：真实归档快照页在三种 --write 调用下都不被改写', (t) => {
  const archivePath = path.join(ROOT, ARCHIVE_PAGE);
  const before = readFileSync(archivePath, 'utf8');
  // 归档页里矩阵表的行数就是它的基线读数（168），EXPECTED 是 230：两者必须能区分开。
  const archiveRows = countRowsBetweenMarkers(before, 'MATRIX-TABLE');
  const expected = readExpected();
  assert.notEqual(archiveRows, expected.total, '归档页条数与 EXPECTED 相等了：这条负控制的前提变了，需人工复核');

  const cases = [
    { args: ['--write'], note: '裸 --write（没有隐式默认页）' },
    { args: ['--write', `--page=${ARCHIVE_PAGE}`], note: '显式点名归档页' },
    { args: ['--write', `--page=${ARCHIVE_PAGE}`, '--i-know-this-rewrites-archive'], note: '双钥匙都给了' },
  ];
  for (const one of cases) {
    const result = runTool(TOOL, one.args, ROOT);
    assert.equal(result.status, 1, `${one.note} 应 exit 1，实际 ${result.status}：\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /拒绝写入/, `${one.note} 没有打印拒绝原因：\n${result.stderr}`);
    assert.equal(readFileSync(archivePath, 'utf8'), before, `${one.note} 改写了归档快照`);
  }
  // 双钥匙那条必须点明「条数不一致」，否则等于只剩一把钥匙。
  const forced = runTool(TOOL, cases[2].args, ROOT);
  assert.match(forced.stderr, new RegExp(`条数 ${archiveRows} 与 EXPECTED ${expected.total} 不一致`));
});

test('证据表生成器：目标页缺生成器标记时拒绝写入（不写盘）', (t) => {
  const tree = makeTree(t);
  const expected = readExpected();
  tree.writeArtifacts(buildMatrix(expected), buildNegativeControls(expected));
  const markerless = '# 没有标记的页\n\n随便写点东西。\n';
  writeFileSync(tree.page, markerless, 'utf8');

  const result = runTool(tree.tool, ['--write', '--page=docs/page.md'], tree.root);
  assert.equal(result.status, 1, `缺标记应 exit 1，实际 ${result.status}：\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /缺少标记 <!-- BEGIN:MATRIX-TABLE -->/);
  assert.equal(readFileSync(tree.page, 'utf8'), markerless, '缺标记却写盘了');
});

/**
 * 归档页的**路径别名**（审查者实测的漏洞）：修复前归档页保护判的是归一化字符串
 * `rel === ARCHIVE_PAGE`，而 `normalizeRel` 只做 `\`→`/`、剥开头 `./`、剥结尾 `/`，于是
 *
 *   --page=docs/verification/./gy-i22-failmatrix-20261022.md
 *   --page=docs/verification/../verification/gy-i22-failmatrix-20261022.md
 *   --page=DOCS/verification/gy-i22-failmatrix-20261022.md   （Windows 大小写不敏感）
 *
 * 全部 **EXIT 0 且真把归档页从 168 / 23 改写成 230 / 26**。现在判据是**文件身份**（`dev` + `ino`），
 * 三种写法必须与直接点名同一个结果：exit 1、拒绝原因指向归档快照、归档页字节逐字不变。
 */
test('证据表生成器：归档页的路径别名（./、..、大小写）按真实路径比较一律拒绝', (t) => {
  const archivePath = path.join(ROOT, ARCHIVE_PAGE);
  const before = readFileSync(archivePath, 'utf8');
  // 兜底：万一守卫被改坏、真写盘了，先把原字节放回去，别把仓库里的归档页留成脏状态。
  t.after(() => {
    if (readFileSync(archivePath, 'utf8') !== before) writeFileSync(archivePath, before, 'utf8');
  });

  const expected = readExpected();
  assert.notEqual(
    countRowsBetweenMarkers(before, 'MATRIX-TABLE'),
    expected.total,
    '归档页条数与 EXPECTED 相等了：别名负控制的前提变了（那份快照已被改写），需人工复核',
  );

  const dir = ARCHIVE_PAGE.slice(0, ARCHIVE_PAGE.lastIndexOf('/'));
  const name = ARCHIVE_PAGE.slice(ARCHIVE_PAGE.lastIndexOf('/') + 1);
  const aliases = [
    { page: `${dir}/./${name}`, note: '中间插 `./`', archiveBranch: true },
    { page: `${dir}/../verification/${name}`, note: '用 `..` 绕出去再回来', archiveBranch: true },
    {
      // 大小写只在大小写不敏感的文件系统上构成别名；POSIX 上它是**另一个不存在的路径**，
      // 由「读不到目标页」拦住，同样 exit 1、同样不写盘（断言随之放宽到 /拒绝写入/）。
      page: ARCHIVE_PAGE.replace(/^docs\//, 'DOCS/'),
      note: '大写目录别名',
      archiveBranch: process.platform === 'win32' || process.platform === 'darwin',
    },
  ];
  for (const one of aliases) {
    const result = runTool(TOOL, ['--write', `--page=${one.page}`], ROOT);
    assert.equal(result.status, 1, `${one.note}（--page=${one.page}）应 exit 1，实际 ${result.status}：\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /拒绝写入/, `${one.note} 没有打印拒绝原因：\n${result.stderr}`);
    if (one.archiveBranch) {
      assert.match(result.stderr, /拒绝写入归档快照/, `${one.note} 没被识别成归档页（别名绕过了真实路径比较）：\n${result.stderr}`);
    }
    assert.equal(readFileSync(archivePath, 'utf8'), before, `${one.note} 改写了归档快照`);
  }
});

/**
 * 越界目标：修复前 `--page=../outside.md` **EXIT 0**，把仓库外的文件当成证据页改写了。
 * 现在包含性校验（真实路径必须以 `<仓库根><分隔符>` 开头）放在读文件之前，越界目标一律拒绝，
 * 仓库外的受害者文件必须一个字节都不变——而且不存在的越界目标也不许被创建。
 */
test('证据表生成器：目标越出仓库（../outside.md）在打开文件之前就拒绝', (t) => {
  const tree = makeTree(t);
  const expected = readExpected();
  tree.writeArtifacts(buildMatrix(expected), buildNegativeControls(expected));

  const victimName = `gy-i22-outside-${process.pid}-${Date.now()}.md`;
  const victim = path.resolve(tree.root, '..', victimName);
  writeFileSync(victim, PAGE_FIXTURE, 'utf8'); // 仓库外的「受害者页」：带满标记，修复前会被真改写
  t.after(() => rmSync(victim, { force: true }));
  const missing = `${victim}.missing.md`;

  const cases = [
    { page: `../${victimName}`, note: '上一级目录的仓库外文件' },
    { page: `docs/../../${victimName}`, note: '套一层 `docs/` 再用 `..` 越界' },
    { page: `../${victimName}.missing.md`, note: '仓库外不存在的目标' },
  ];
  for (const one of cases) {
    const result = runTool(tree.tool, ['--write', `--page=${one.page}`], tree.root);
    assert.equal(result.status, 1, `${one.note}（--page=${one.page}）应 exit 1，实际 ${result.status}：\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /拒绝写入：目标不在仓库内/, `${one.note} 没打印「目标不在仓库内」：\n${result.stderr}`);
    assert.equal(readFileSync(victim, 'utf8'), PAGE_FIXTURE, `${one.note} 改写了仓库外的文件`);
  }
  assert.ok(!existsSync(missing), '仓库外的 .missing.md 被创建了：越界目标必须在打开文件之前就拒绝');
});

/**
 * 别名用例的**夹具版**：同一棵夹具树里同时有「自洽工件（230 / 26）」和「归档页副本（168 / 23）」，
 * 于是「exit 1」不可能由缺工件造成（缺工件那条另有专项断言），只能是分类为归档页——审查者要的
 * 「同码异因」拆开。三条别名都必须命中 `/拒绝写入归档快照/` 且字节不变。
 */
test('证据表生成器：归档页路径别名（./、..、大小写）在自洽工件下仍一律拒绝', (t) => {
  const tree = makeTree(t);
  const expected = readExpected();
  tree.writeArtifacts(buildMatrix(expected), buildNegativeControls(expected));
  const { archive, bytes } = seedArchive(tree);
  const archiveRows = countRowsBetweenMarkers(bytes, 'MATRIX-TABLE');
  assert.notEqual(archiveRows, expected.total, '归档页副本条数与 EXPECTED 相等了：负控制前提变了，需人工复核');

  const dir = ARCHIVE_PAGE.slice(0, ARCHIVE_PAGE.lastIndexOf('/'));
  const name = ARCHIVE_PAGE.slice(ARCHIVE_PAGE.lastIndexOf('/') + 1);
  const aliases = [
    { page: `${dir}/./${name}`, note: '中间插 `./`', archiveBranch: true },
    { page: `${dir}/../verification/${name}`, note: '用 `..` 绕出去再回来', archiveBranch: true },
    {
      // 大小写只在大小写不敏感的文件系统上构成别名；POSIX 上它是另一个不存在的路径，
      // 由「读不到目标页」拦住（同样 exit 1、同样一个字节不写）。
      page: ARCHIVE_PAGE.replace(/^docs\//, 'DOCS/'),
      note: '大写目录别名',
      archiveBranch: process.platform === 'win32' || process.platform === 'darwin',
    },
  ];
  for (const one of aliases) {
    const result = runTool(tree.tool, ['--write', `--page=${one.page}`], tree.root);
    assert.equal(result.status, 1, `${one.note}（--page=${one.page}）应 exit 1，实际 ${result.status}：\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /拒绝写入/, `${one.note} 没有打印拒绝原因：\n${result.stderr}`);
    if (one.archiveBranch) {
      assert.match(result.stderr, /拒绝写入归档快照/, `${one.note} 没被识别成归档页（别名绕过了文件身份比较）：\n${result.stderr}`);
    }
    assert.equal(readFileSync(archive, 'utf8'), bytes, `${one.note} 改写了归档页副本`);
  }
});

/**
 * 硬链接：同一 inode 的第二个目录项。`realpathSync.native` 归一的是**路径**，归一不了**文件身份**，
 * 所以只比 realpath 的守卫会被它绕过去——审查者实测 `mklink /H h-archive.md <归档页>` 后
 * `--write --page=h-archive.md` exit 0 把 168 / 23 整页改写成 230 / 26。现在比 `dev` + `ino`。
 */
test('证据表生成器：归档页的硬链接别名按文件身份（dev+ino）拒绝', (t) => {
  const tree = makeTree(t);
  const expected = readExpected();
  tree.writeArtifacts(buildMatrix(expected), buildNegativeControls(expected));
  const { archive, bytes } = seedArchive(tree);
  const link = path.join(tree.root, 'h-archive.md');
  try {
    linkSync(archive, link);
  } catch (error) {
    t.skip(`本环境不能建硬链接（${error.code ?? error.message}）：该用例在无法建硬链接的文件系统/容器上跳过，不算通过`);
    return;
  }
  const shaBefore = sha256Of(bytes);
  const rowsBefore = countRowsBetweenMarkers(bytes, 'MATRIX-TABLE');

  const result = runTool(tree.tool, ['--write', '--page=h-archive.md'], tree.root);
  assert.equal(result.status, 1, `硬链接目标应 exit 1，实际 ${result.status}：\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /拒绝写入归档快照/, `硬链接没被识别成归档页（文件身份比较失效）：\n${result.stderr}`);
  const after = readFileSync(archive, 'utf8');
  assert.equal(sha256Of(after), shaBefore, '硬链接把归档页改写了（sha256 变了）');
  assert.equal(countRowsBetweenMarkers(after, 'MATRIX-TABLE'), rowsBefore, '硬链接把归档页的表格行数改掉了');
});

/**
 * 工件侧口径对齐：`--matrix=` / `--nc=` 与 `--page=` 一样按仓库根解析并校验包含性；
 * 读不到时也只打一行（不许把 node 栈甩给只用工具的人）。
 */
test('证据表生成器：--matrix/--nc 越界或缺失时单行拒绝（不打 node 栈）', (t) => {
  const tree = makeTree(t);
  tree.writeArtifacts(buildMatrix(readExpected()), buildNegativeControls(readExpected()));

  const cases = [
    { args: ['--matrix=../outside-matrix.json'], note: '--matrix 相对越界', expect: /拒绝运行：运行结果不在仓库内/ },
    {
      args: [`--nc=${path.join(tree.root, '..', 'outside-nc.json')}`],
      note: '--nc 绝对路径越界',
      expect: /拒绝运行：运行结果不在仓库内/,
    },
  ];
  for (const one of cases) {
    const result = runTool(tree.tool, one.args, tree.root);
    assert.equal(result.status, 1, `${one.note} 应 exit 1，实际 ${result.status}：\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, one.expect, `${one.note} 报错文案不对：\n${result.stderr}`);
    assert.ok(!/\n\s+at /.test(result.stderr), `${one.note} 把 node 栈打出来了：\n${result.stderr}`);
  }

  const empty = makeTree(t);
  const missing = runTool(empty.tool, [], empty.root);
  assert.equal(missing.status, 1, `工件缺失应 exit 1，实际 ${missing.status}：\n${missing.stdout}\n${missing.stderr}`);
  assert.match(missing.stderr, /拒绝运行：读不到运行结果 tests\/failmatrix\/\.artifacts\/matrix\.json/, `工件缺失的报错文案不对：\n${missing.stderr}`);
  assert.ok(!/\n\s+at /.test(missing.stderr), `工件缺失时把 node 栈打出来了：\n${missing.stderr}`);
});
