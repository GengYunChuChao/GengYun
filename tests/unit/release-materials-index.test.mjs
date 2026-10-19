/**
 * GY-I24 交付材料索引 · 回归：门禁工具可跑、索引与仓库事实一致。
 *
 * 分层：
 *   1. 门禁工具 `tools/verify-release-materials.mjs` 实跑退出码 0、无 FAIL 行；
 *   2. 索引声明的**当前读数**与文件系统一致（迁移数／down 数／deploy 文件数）——
 *      仓库事实前进（如新增迁移）而索引没更新时，本文件先红，逼着同步索引；
 *   3. 索引必须载明边界（Refs #24、不关闭整项、离线核验不代表验收）；
 *   4. **反向回归**：把索引页**改错**（在仓外临时副本里少一行在册记录）后，门禁必须转红并
 *      点名「未索引」。只有正向实跑（第 1 条）时，判据写松/写死的门禁永远绿，谁也发现不了。
 *
 * 边界：本文件不部署、不连云、不连库；只读仓库事实。第 4 条只在 `os.tmpdir()` 下铺镜像，
 * ⛔ 不改仓内任何文件（含 `docs/`）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const INDEX = 'docs/verification/gy-i24-release-materials-index-20261017.md';
const TOOL = 'tools/verify-release-materials.mjs';
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

test('门禁·离线核验工具实跑通过（退出码 0、无 FAIL）', () => {
  const run = spawnSync(process.execPath, [TOOL], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(run.status, 0, `工具退出码必须为 0\n${run.stdout}\n${run.stderr}`);
  assert.equal(/^FAIL/m.test(run.stdout), false, '不得有 FAIL 行');
  const passCount = (run.stdout.match(/^PASS/gm) || []).length;
  assert.ok(passCount >= 10, `至少 10 项 PASS，实际 ${passCount}`);
  assert.match(run.stdout, /离线文档核验；不代表部署、云端或运行期已验收/, '汇总行必须声明不代表验收');
});

test('索引·当前读数与文件系统一致（迁移/down/deploy 文件数）', () => {
  const migrations = readdirSync(join(ROOT, 'services/api/db/migrations'))
    .filter((n) => /^\d{4}_.*\.sql$/.test(n));
  const downs = readdirSync(join(ROOT, 'services/api/db/migrations/rollback'))
    .filter((n) => /^\d{4}_.*\.down\.sql$/.test(n));
  const deployFiles = spawnSync('git', ['ls-files', 'deploy'], { cwd: ROOT, encoding: 'utf8' })
    .stdout.split('\n').filter((s) => s.trim() !== '');

  const index = read(INDEX);
  // 索引必须写明当前数量（写成长文档句，允许灵活表述，但数字必须在）
  assert.ok(index.includes(`**${migrations.length}** 个`) || index.includes(`${migrations.length} 个`),
    `索引必须写明当前迁移数 ${migrations.length}`);
  assert.ok(index.includes(`${downs.length} 个`), `索引必须写明当前 down 数 ${downs.length}`);
  // 两择一都**派生**自当前在册数：① 门禁 PASS 明细原句；② 索引 §4 的 `N/N` 计数行。
  // ⛔ 不得再写死任何数字（旧写法 `${deployFiles.length}/29` 把左半边派生、右半边钉死；
  //    deploy 从 29 涨到 30 后这一择一恒假，只剩「数字对不上却看不出来」的哑弹）。
  assert.ok(index.includes(`${deployFiles.length} 个文件全部在索引表行中`)
    || index.includes(`${deployFiles.length}/${deployFiles.length}`),
  `索引必须与 deploy 在册文件数 ${deployFiles.length} 一致（期望「${deployFiles.length} 个文件全部在索引表行中」或「${deployFiles.length}/${deployFiles.length}」）`);
  // 结构性不变量：down 覆盖 0002..N、无 0001
  assert.equal(downs.some((n) => n.startsWith('0001_')), false, '不得存在 0001 的 down 脚本');
  assert.equal(downs.length, migrations.length - 1, 'down 数必须等于迁移数减一（无 0001）');
});

test('门禁·bash 调用不得传入文件路径（Windows/WSL 路径解释分歧的根因）', () => {
  // 监工在 WSL 下实测：把 join(ROOT, script) 的 Windows 路径传给 bash -n，5/5 「找不到文件」
  // （MSYS bash 吃 D:\…、WSL 只吃 /mnt/d/…、Linux CI 吃 /…）。修法是把 blob 内容喂 stdin。
  // 本条把该形态钉住：工具里对 bash 的调用只能是 ['-n'] + input，不得出现路径参数。
  const source = read(TOOL);
  assert.ok(/execFileSync\('bash',\s*\['-n'\],\s*\{\s*input:/.test(source),
    'bash -n 必须改用 stdin 喂入（blob 内容），不得传文件路径');
  assert.equal(/execFileSync\('bash',\s*\['-n',/.test(source), false,
    '不得再给 bash 传文件路径参数');
  assert.ok(/git cat-file blob/.test(source) || /cat-file/.test(source),
    '语法检查的内容必须取自提交 blob（与 LF 判据同源，避免工作区 CRLF 假红）');
});

test('索引·载明边界：Refs #24、不关闭整项、离线核验不代表验收', () => {
  const index = read(INDEX);
  assert.ok(index.includes('Refs #24'), '必须使用 Refs #24');
  assert.ok(index.includes('不关闭整项'), '必须声明不关闭整项 issue');
  assert.ok(index.includes('未推送、未建 PR、未改 main'), '必须声明写手边界');
  assert.ok(index.includes('离线核验**不能**覆盖') || index.includes('离线核验不能覆盖'), '必须列出离线不能覆盖项');
  // 误报排除的教训必须留在文档里（autocrlf 工作区假象）
  assert.ok(index.includes('core.autocrlf'), '必须记录 LF 判据查 blob 的原因');
});

// ---------------------------------------------------------------------------
// 反向回归的夹具：门禁工具把 ROOT 钉死在**自己所在目录的上一级**（没有 `--root` 之类的入口），
// 所以「把索引页改错再跑门禁」只能在**仓外**做一份最小仓库镜像（真 git 仓库 + `deploy/**` +
// 索引页 + 工具本体）再实跑工具。
//
// 镜像的分寸：门禁会**按固定路径**读的东西全铺（漏一件就会多一项 FAIL），并在断言里收紧成
// 「**恰好 1 项 FAIL** 且就是覆盖判据」——多出来的 FAIL 说明镜像没铺全，本条会直接红，
// 不会静默变成「红得莫名其妙但看起来通过了」。
// ---------------------------------------------------------------------------

/** git 调用（只读仓事实，或对镜像自己的仓下手）。子命令失败即抛错，不静默吞。 */
function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

/** 建仓外临时目录并登记清理；删除前校验它确实直属于系统临时目录（递归删除不许赌）。 */
function makeTempRoot(t) {
  const dir = mkdtempSync(join(tmpdir(), 'gy-relidx-gate-'));
  t.after(() => {
    assert.equal(resolve(dirname(dir)), resolve(tmpdir()), '临时目录必须直属于系统临时目录');
    assert.ok(basename(dir).startsWith('gy-relidx-gate-'), '临时目录名必须带夹具前缀');
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** 索引页里的相对链接目标（去掉 `#锚点`；跳过 `http:` 之类与 `#` 开头的纯锚点）。 */
function indexLinkTargets(text) {
  return [...text.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1])
    .filter((target) => !/^[a-z]+:|^#/.test(target))
    .map((target) => target.split('#')[0])
    .filter((pathPart) => pathPart !== '');
}

test('反向回归·索引页少一行在册记录 ⇒ 门禁转红并点名未索引（同一镜像不改则全绿）', (t) => {
  const dir = makeTempRoot(t);
  const deployFiles = git(ROOT, ['ls-files', 'deploy']).split('\n').map((s) => s.trim()).filter((s) => s !== '');

  // ---- 夹具：删掉 `deploy/README.md` 那条索引表行 = 索引页少一条在册记录（§4 的 `N/N` 计数随之失实）。
  // ⛔ 不写死行号：按「表格行 + ✅ + 该路径」三条件定位，索引改排版也不会误删别的行。
  const original = read(INDEX).replace(/\r\n/g, '\n');
  const keptLines = original.split('\n').filter((line) =>
    !(line.trim().startsWith('|') && line.includes('✅') && line.includes('deploy/README.md')));
  assert.equal(original.split('\n').length - keptLines.length, 1, '夹具必须删到且只删到 1 行');
  const mutated = keptLines.join('\n');
  assert.notEqual(mutated, original, '夹具必须真的改到索引页内容，否则本条没有证明力');

  // ---- 铺镜像。`.sh` 取 blob：本机 core.autocrlf=true，工作区是 CRLF，直接拷会给 LF 判据造假红。
  const mirrorCopy = (p, bytes) => {
    const dest = join(dir, p);
    mkdirSync(dirname(dest), { recursive: true });
    if (bytes === undefined) copyFileSync(join(ROOT, p), dest);
    else writeFileSync(dest, bytes);
  };
  const mirrorBlob = (p) => mirrorCopy(p, git(ROOT, ['cat-file', 'blob', `HEAD:${p}`]));

  mirrorCopy(TOOL);                       // ① 工具本体：ROOT 由它自己的位置推出
  mirrorCopy(INDEX);                      //    索引页：先按原样铺（对照组要用它）
  for (const p of deployFiles) {          // ② deploy/**（覆盖判据的数据源）
    if (p.endsWith('.sh')) mirrorBlob(p);
    else mirrorCopy(p);
  }
  for (const p of [                        // ③ 门禁按固定路径读的文件（④⑤ 之外的全部）
    'package.json',
    'services/api/src/config.ts',
    'services/api/src/routes/health.ts',
    'services/api/src/db/migrate.ts'
  ]) mirrorCopy(p);

  const migrationsDir = 'services/api/db/migrations';   // ④ 门禁 readdirSync 取名字，需要整目录
  for (const name of readdirSync(join(ROOT, migrationsDir)).filter((n) => /^\d{4}_.*\.sql$/.test(n))) {
    mirrorCopy(`${migrationsDir}/${name}`);
  }
  for (const name of readdirSync(join(ROOT, `${migrationsDir}/rollback`)).filter((n) => /^\d{4}_.*\.down\.sql$/.test(n))) {
    mirrorCopy(`${migrationsDir}/rollback/${name}`);
  }
  for (const target of indexLinkTargets(original)) {     // ⑤ 索引相对链接目标（链接判据只查存在性）
    const source = resolve(ROOT, dirname(INDEX), target);
    const rel = relative(ROOT, source);
    assert.ok(rel !== '' && !rel.startsWith('..'), `索引链接不得指向仓外：${target}`);
    if (statSync(source).isDirectory()) mkdirSync(join(dir, rel), { recursive: true });
    else mirrorCopy(rel);
  }

  // ---- 让镜像自己成为真 git 仓库：覆盖判据走 `git ls-files deploy`，脚本判据走 `git cat-file blob HEAD:…`。
  // 三条 `-c` 都是为了不依赖本机/CI 的全局 git 配置（autocrlf 会让 LF 判据假红、gpgsign 会让 commit 卡住）。
  git(dir, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  git(dir, ['-c', 'core.autocrlf=false', 'add', '-A', '-f']);
  git(dir, ['-c', 'core.autocrlf=false', '-c', 'user.name=gy-relidx-fixture',
    '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
    'commit', '-q', '-m', 'fixture: 索引页少一行在册记录']);
  assert.equal(git(dir, ['ls-files', 'deploy']).split('\n').filter((s) => s.trim() !== '').length,
    deployFiles.length, '镜像的 deploy 在册数必须与真实仓库一致（否则 FAIL 的原因就不是本次改动了）');

  // ---- 断言一（对照组）：镜像**一字不改**时门禁必须全绿。
  // 没有这一步，「改错后转红」可能红在镜像没铺全（少铺一个文件就是一项 FAIL），而不是红在改动上。
  const runGate = () => {
    const run = spawnSync(process.execPath, [TOOL], { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 120000 });
    assert.equal(run.error, undefined, `镜像内门禁未能启动：${run.error?.message ?? ''}`);
    return { status: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '' };
  };
  const green = runGate();
  assert.equal(green.status, 0, `对照组必须全绿（红了说明镜像没铺全，本条无效）：\n${green.stdout}\n${green.stderr}`);
  assert.equal(/^FAIL/m.test(green.stdout), false, `对照组不得有 FAIL 行：\n${green.stdout}`);
  const greenSummary = /(\d+)\/(\d+) 项通过/.exec(green.stdout);
  assert.ok(greenSummary, `对照组必须跑到汇总行：\n${green.stdout}`);
  assert.equal(greenSummary[1], greenSummary[2], `对照组必须全通过：${greenSummary[0]}`);

  // ---- 断言二（实验组）：只改索引页——少一条在册记录（§4 的 `N/N` 计数随之失实），
  // 门禁读的是文件而非 blob，所以不必重新提交；其余输入与对照组完全一致。
  writeFileSync(join(dir, INDEX), mutated);
  const red = runGate();
  const stdout = red.stdout;
  assert.notEqual(red.status, 0, `索引页少一行后门禁必须转红；实际退出码 ${red.status}\n${stdout}\n${red.stderr}`);
  const failLines = stdout.split('\n').filter((line) => line.startsWith('FAIL'));
  assert.equal(failLines.length, 1,
    `必须只有覆盖判据这 1 项 FAIL（更多说明 FAIL 另有其因，本条就不再有证明力）：\n${failLines.join('\n') || '(无 FAIL 行)'}\n${stdout}`);
  assert.match(failLines[0], /索引覆盖 deploy\/ 全部在册文件/, `FAIL 的必须是覆盖判据：${failLines[0]}`);
  assert.ok(failLines[0].includes('未索引：deploy/README.md'), `覆盖判据必须点名被删掉的那条：${failLines[0]}`);
  const summary = /(\d+)\/(\d+) 项通过/.exec(stdout);
  assert.ok(summary, `门禁必须跑到汇总行（中途异常中止不算证明力）:\n${stdout}`);
  assert.equal(Number(summary[2]) - Number(summary[1]), 1, `恰好 1 项失败：${summary[0]}`);
});
