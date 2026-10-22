/**
 * 守卫：仓库文本文件的行尾必须是 LF —— **零 CR**（GY-R31，收口 `#469` 的副作用，`Refs #469`）。
 *
 * 为什么要这条：`#469` 合入 main 时把 `docs/architecture/contract-implementation-status.md`
 * 整份从 LF 翻成 CRLF（实测 main 侧 0 CR、`#469` 侧 200 CR / 200 行）。仓库当时没有
 * `.gitattributes`，而本机**生效**的 `core.autocrlf` 是 `false`（仓库级 `false` 覆盖机器级
 * `D:/Git/etc/gitconfig` 的 `true`；实测 `git config --get core.autocrlf` ⇒ `false`），
 * 于是这个副作用**不会自愈**，并且：
 *   ① 之后每张动该台账的 PR 都跟它产生「全文 1 块」的假冲突，review 里看不到真实改动；
 *   ② `node tools/verify-contract-status.mjs --write-doc` 用 `writeFileSync(path, 字符串)` 落盘，
 *      字符串是 `\n` 拼的 ⇒ 谁跑一次门禁谁把它翻回 LF，再产生一次 200 行全红 diff；
 *   ③ 纯 CRLF 的文件上，`git diff` 的「改了哪几行」这个信号本身失效。
 * 判据放在这里而不是靠人肉自觉：**读字节**，不读文本、不做 `Get-Content` 式的往返判断
 * （后者按行读再拼回去，CR 早就被吃掉了，永远判绿）。
 *
 * ## 扫描面 ＝ 全仓 9 类文本扩展名（2026-10-22 补面）
 *
 * 原扫描面只有 `docs/**\/*.md` ＋ `tools/*.mjs` ＋ `packages/**\/*.mjs` ＝ 397 个文件，而
 * **本片自己规范化过的** `README.md` / `AGENTS.md` / `services/api/src/routes/community.ts` /
 * `tests/unit/gy-i22-message-parity.test.mjs`（743 个 CR，全仓最大的一个）**都不在面内** ——
 * 修好了却没人守，回归不会变红。现在按**扩展名**扫全仓，见 `SCAN_EXTS`。
 *
 * ### 扫描面 ≠ 归一化面（别把它读成「全仓强制 LF」）
 *
 * `.gitattributes` 只声明了 **5 类**扩展名（`*.md` / `*.mjs` / `*.ts` / `*.json` / `*.yml` ⇒
 * `text eol=lf`），**那才是 git 真的会转换的面**。`SCAN_EXTS` 里的 `.sql` / `.js` / `.cjs` / `.py`
 * 是**同类文本、但未声明**：它们不会被 git 转换（根 `.gitattributes` 没有 `text=auto`，未声明
 * 扩展名一律原样存取），扫它们只为「早发现漂移」；补声明要连带 `git add --renormalize`，另开一片。
 * 反向也有一条边界：`.wxml` / `.wxss` / `.sh` / `.ps1` / `.vue` / `.html` 同样是文本，但**不在**
 * 扫描面内（不在本片范围；要扩就改 `SCAN_EXTS` 一行）。
 *
 * ⚠ 不可转换的证据快照（实测，不是推测）：`docs/verification/assets/i07-wechat-main8932ba5-pr80b5a6468/`
 * 与 `docs/verification/assets/local-knowledge-native-20261011/` 各自带一份
 * `.gitattributes`（`* -text whitespace=cr-at-eol`），把证据快照钉成**原样存取**。这两处目录里的
 * `.log` / `.cjs` / `.mjs` **本来就含 CR**（字节级证据，必须原样），所以用 `SCAN_EXCLUDE_PREFIXES`
 * 把它们显式排掉 —— 靠「碰巧没扫到」是不行的。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根：由本文件位置推出（`tests/unit/` → `../..`），⛔ 不用 `process.cwd()`。 */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * 扫描面：**按扩展名**扫全仓。前 5 类 ＝ `.gitattributes` 已声明（git 真会转换）；
 * 后 4 类 ＝ 同类文本、未声明（git 不转换，本守卫只负责早发现漂移）。
 *
 * 写成显式清单而不是 `*` 或 `text=auto` 式的自动探测：扩面必须改这一行，边界一眼可读，
 * 也不会有哪条 `**` 顺手把图片/证据快照卷进来。
 */
export const SCAN_EXTS = Object.freeze(['.md', '.mjs', '.ts', '.json', '.yml', '.sql', '.js', '.cjs', '.py']);

/** 遍历时整目录跳过：版本库自身与依赖（两者都不是仓库文本）。 */
export const SCAN_SKIP_DIRS = Object.freeze(['.git', 'node_modules']);

/**
 * 显式排除（仓库相对路径前缀）。`docs/verification/assets/**` 是证据快照：`-text` 原样存取，
 * 里面的 `.log` / `.cjs` / `.mjs` **本来就含 CR**，是字节级证据，不是待修的行尾。
 * 排除写在这里（而不是靠「碰巧没扫到」）⇒ 将来给 `SCAN_EXTS` 加扩展名也不会把它们卷进来。
 */
export const SCAN_EXCLUDE_PREFIXES = Object.freeze(['docs/verification/assets/']);

/** 逐字节数行尾：返回 `{ cr, crlf, loneCr, lf, bytes }`。⛔ 不解码成字符串再数。 */
export function countLineEndings(buffer) {
  let cr = 0;
  let crlf = 0;
  let loneCr = 0;
  let lf = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    const byte = buffer[index];
    if (byte === 0x0d) {
      cr += 1;
      if (buffer[index + 1] === 0x0a) crlf += 1;
      else loneCr += 1;
    } else if (byte === 0x0a) {
      lf += 1;
    }
  }
  return { cr, crlf, loneCr, lf, bytes: buffer.length };
}

/** 相对仓库根的展示用路径（统一 `/`，Windows 上 `\` 不混进断言文案）。 */
function displayPath(absolutePath, root) {
  const normalizedRoot = resolve(root).replace(/\\/g, '/');
  const normalizedPath = resolve(absolutePath).replace(/\\/g, '/');
  return normalizedPath.startsWith(`${normalizedRoot}/`)
    ? normalizedPath.slice(normalizedRoot.length + 1)
    : normalizedPath;
}

/**
 * 扫出扫描面里的文件（绝对路径，稳定排序，已剔除 `SCAN_SKIP_DIRS` 与 `SCAN_EXCLUDE_PREFIXES`）。
 * 仓库根不存在 ⇒ 抛错（宁可红，不要静默扫 0 个文件）。
 *
 * 遍历只走真正的目录（`Dirent.isDirectory()`）：符号链接/junction（npm workspaces 会造）一律不跟进，
 * 所以既不会跨进别的工作树，也不会递归成环。
 */
export function collectScopeFiles({
  root = ROOT,
  exts = SCAN_EXTS,
  skipDirs = SCAN_SKIP_DIRS,
  exclude = SCAN_EXCLUDE_PREFIXES,
} = {}) {
  if (!statSync(root).isDirectory()) {
    throw new Error(`仓库根 ${root} 不是目录（口径失效，先修扫描器，别让它静默扫 0 个文件）`);
  }
  const found = [];
  const walk = (absoluteDir) => {
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
      const absolute = join(absoluteDir, entry.name);
      const relative = displayPath(absolute, root);
      if (entry.isDirectory()) {
        if (skipDirs.includes(entry.name)) continue;
        if (exclude.some((prefix) => `${relative}/`.startsWith(prefix))) continue;
        walk(absolute);
      } else if (entry.isFile() && exts.some((ext) => entry.name.endsWith(ext))) {
        if (exclude.some((prefix) => relative.startsWith(prefix))) continue;
        found.push(absolute);
      }
    }
  };
  walk(root);
  return found.sort();
}

/**
 * 判定函数（导出，供负控制与后续守卫复用）：逐个文件读**字节**，返回
 * `{ scanned, violations }`，`violations` 里每项 `{ path, cr, crlf, loneCr, lf }`。
 * 只读、无副作用；不缓存（负控制在 tmpdir 里现造现判）。
 */
export function judgeEol(files, { root = ROOT } = {}) {
  const scanned = [];
  const violations = [];
  for (const file of files) {
    const stats = countLineEndings(readFileSync(file));
    const path = displayPath(file, root);
    scanned.push({ path, ...stats });
    if (stats.cr > 0) violations.push({ path, ...stats });
  }
  const describe = (entry) => `${entry.path}（CR=${entry.cr}：CRLF ${entry.crlf} + 孤立 CR ${entry.loneCr}，LF=${entry.lf}）`;
  return {
    scanned,
    violations,
    summary: violations.length === 0 ? '零 CR' : violations.map(describe).join('；'),
  };
}

/** 造一个临时目录 + 文件，跑完自动删（负控制专用）。 */
function withTempFile(name, content, run) {
  const dir = mkdtempSync(join(tmpdir(), 'gy-eol-guard-'));
  try {
    const file = join(dir, name);
    writeFileSync(file, content);
    return run(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 读根 `.gitattributes` 的规则行（去注释、去空行、trim）。 */
function readAttributeRules() {
  return readFileSync(join(ROOT, '.gitattributes'), 'utf8')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

test('eol/扫描面非空：全仓 9 类文本都真的扫到了，不是扫 0 个文件的假绿', () => {
  const files = collectScopeFiles();
  // 假绿的样子：目录/扩展名写错 ⇒ 一个文件都没扫 ⇒ "零 CR"。先把它堵死。
  assert.ok(files.length >= 1300, `扫描面只有 ${files.length} 个文件，明显没扫全（口径失效，先修 collectScopeFiles）`);
  const rel = files.map((file) => displayPath(file, ROOT));
  // 2026-10-22 补面的核心：本片亲自规范化过的四个文件必须在面内（原先全都不在）。
  for (const anchor of [
    'README.md',
    'AGENTS.md',
    'services/api/src/routes/community.ts',
    'tests/unit/gy-i22-message-parity.test.mjs',
  ]) {
    assert.ok(rel.includes(anchor), `扫描面里没有 ${anchor}（本片规范化过它，漏扫＝守卫对自己修过的文件失明）`);
  }
  // 9 类扩展名各自至少命中一次（补面没生效就会在这里红）。
  for (const ext of SCAN_EXTS) {
    assert.ok(rel.some((path) => path.endsWith(ext)), `扫描面里一个 ${ext} 都没有（扩面没生效）`);
  }
  // 排除面必须真的生效：快照目录一个文件都不许进面。
  assert.equal(
    rel.filter((path) => path.startsWith('docs/verification/assets/')).length,
    0,
    '证据快照目录漏进了扫描面（它们含 CR 是设计如此，会把守卫变成永久假红）',
  );
  // 依赖目录与版本库自身不许进面（否则会扫到几万条第三方文件，读数失去意义）。
  assert.equal(rel.filter((path) => path.startsWith('node_modules/') || path.split('/').includes('node_modules')).length, 0, 'node_modules 漏进扫描面');
  assert.equal(rel.filter((path) => path.split('/').includes('.git')).length, 0, '.git 漏进扫描面');
});

test('eol/扫描面零 CR（含 0x0D 即违规）', () => {
  const files = collectScopeFiles();
  const result = judgeEol(files);
  assert.equal(result.violations.length, 0, `存在 CR 行尾（会被 git 视作整块改写）：${result.summary}`);
  // 反向自检：判绿必须建立在"确实读了字节"上，扫描面里每个文件都读到了。
  assert.equal(result.scanned.length, files.length);
  assert.ok(result.scanned.every((entry) => entry.bytes > 0), '扫描面里有 0 字节文件，读数不可信');
});

test('负控制：tmpdir 里造一个带 CRLF 的 md，同一个判定函数必须报出违规', () => {
  const content = '# 负控制：这份是 CRLF\n\n- 第一行\n- 第二行\n';
  const crlf = content.replace(/\n/g, '\r\n');
  withTempFile('crlf-sample.md', crlf, (file) => {
    const result = judgeEol([file], { root: dirname(file) });
    assert.equal(result.violations.length, 1, `负控制没红 ⇒ 判定函数是橡皮图章（读到的 CR=${result.scanned[0].cr}）`);
    const [violation] = result.violations;
    assert.equal(violation.path, 'crlf-sample.md');
    assert.equal(violation.cr, 4, `应数出 4 个 CR，实际 ${violation.cr}`);
    assert.equal(violation.crlf, 4);
    assert.equal(violation.loneCr, 0);
    assert.equal(violation.lf, 4);
    // 同一份内容换成 LF ⇒ 必须判绿：证明红的是行尾，不是这段文字。
    const lfFile = join(dirname(file), 'lf-sample.md');
    writeFileSync(lfFile, content);
    const clean = judgeEol([lfFile], { root: dirname(file) });
    assert.deepEqual(clean.violations, [], 'LF 版本也被判红 ⇒ 判据认错了东西');
  });
});

test('负控制：孤立 CR（CR 后面不跟 LF）同样判红，且与 CRLF 分开计数', () => {
  withTempFile('lone-cr.md', '正文一\r正文二\n正文三\r\n', (file) => {
    const result = judgeEol([file], { root: dirname(file) });
    assert.equal(result.violations.length, 1);
    const [violation] = result.violations;
    assert.equal(violation.cr, 2, `孤立 CR 也要数：实际 ${violation.cr}`);
    assert.equal(violation.crlf, 1);
    assert.equal(violation.loneCr, 1);
    assert.equal(violation.lf, 2);
  });
});

test('负控制：排除前缀与跳过目录真的会把路径剔掉（否则「扫了但没扫到」无法自证）', () => {
  // 造一棵临时树：`keep/a.md` 在面内；`assets/b.md` 被前缀剔掉；`node_modules/c.md` 被目录名剔掉。
  const dir = mkdtempSync(join(tmpdir(), 'gy-eol-scope-'));
  try {
    mkdirSync(join(dir, 'keep'), { recursive: true });
    mkdirSync(join(dir, 'assets'), { recursive: true });
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    writeFileSync(join(dir, 'keep', 'a.md'), 'a\n');
    writeFileSync(join(dir, 'assets', 'b.md'), 'b\n');
    writeFileSync(join(dir, 'node_modules', 'c.md'), 'c\n');
    const rel = collectScopeFiles({ root: dir, exclude: ['assets/'] }).map((file) => displayPath(file, dir));
    assert.deepEqual(rel, ['keep/a.md'], `排除面/跳过目录没生效：实际 ${JSON.stringify(rel)}`);
    // 不传 exclude ⇒ `assets/b.md` 会进来（证明剔掉它的是 exclusion，不是扫描器漏读）。
    const withoutExclude = collectScopeFiles({ root: dir, exclude: [] }).map((file) => displayPath(file, dir));
    assert.deepEqual(withoutExclude.sort(), ['assets/b.md', 'keep/a.md'], `exclude 未生效时读数应含 assets/b.md：实际 ${JSON.stringify(withoutExclude)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('eol/.gitattributes 确实声明了这五类文本为 eol=lf，且没有 text=auto', () => {
  // 没有 `.gitattributes` 正是 `#469` 副作用不自愈的根因；这条把"声明本身"也钉住，
  // 免得后来人删掉它、换个目录跑一次门禁，CRLF 又悄悄回来。
  const rules = readAttributeRules();
  for (const pattern of ['*.md', '*.mjs', '*.ts', '*.json', '*.yml']) {
    assert.ok(
      rules.some((rule) => rule.split(/\s+/u)[0] === pattern && /\beol=lf\b/u.test(rule)),
      `.gitattributes 缺少「${pattern} text eol=lf」`,
    );
  }
  assert.ok(!rules.some((rule) => /text=auto/u.test(rule)), '.gitattributes 不许写 text=auto（会把图片/证据快照误判成文本）');
});

test('eol/证据快照不会被行尾转换：子目录 `-text` 仍在位，且里面有含 CR 的快照', () => {
  // 快照不被转换**不靠**根 `eol=lf`，靠的是更深一层的 `* -text`（属性优先级：深目录胜）。
  // 这条把「深一层还在位」钉住：谁删掉那两份 `.gitattributes`，根规则就会重新匹配到该目录的
  // `*.mjs`（`executed-service.mjs`，1 个 CR ⇒ 实测会被转换），`.log`/`.cjs` 不匹配任何根规则；
  // 图片从未被任何规则匹配（`git check-attr` 空输出）。实测现在是 `text: unset`。
  const assetDirs = [
    'docs/verification/assets/i07-wechat-main8932ba5-pr80b5a6468',
    'docs/verification/assets/local-knowledge-native-20261011',
  ];
  for (const dir of assetDirs) {
    const file = join(ROOT, dir, '.gitattributes');
    assert.ok(existsSync(file), `${dir}/.gitattributes 不见了 ⇒ 该目录的 *.mjs 快照会被根 eol=lf 重新匹配（实测会转换）`);
    const rules = readFileSync(file, 'utf8')
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));
    assert.ok(
      rules.some((rule) => rule.startsWith('*') && /(^|\s)-text(\s|$)/u.test(rule)),
      `${dir}/.gitattributes 里的 \`* -text\` 没了`,
    );
  }
  // 排除面不是装饰：快照里确实还有带 CR 的文本（若哪天它们被"顺手修好"，说明字节级证据被动过，
  // 那时这条会红 —— 这正是我们想要的告警，而不是让它静默变成 0）。
  const snapshotTexts = assetDirs.flatMap((dir) =>
    readdirSync(join(ROOT, dir), { withFileTypes: true })
      .filter((entry) => entry.isFile() && ['.log', '.cjs', '.mjs'].some((ext) => entry.name.endsWith(ext)))
      .map((entry) => join(dir, entry.name)),
  );
  const withCr = snapshotTexts.filter((file) => countLineEndings(readFileSync(join(ROOT, file))).cr > 0);
  assert.ok(
    snapshotTexts.length > 0 && withCr.length > 0,
    `快照里应仍有含 CR 的文本（实测 ${withCr.length}/${snapshotTexts.length}），排除面才有存在理由`,
  );
  // 这些路径一律不在扫描面内。
  const scanned = new Set(collectScopeFiles().map((file) => displayPath(file, ROOT)));
  assert.equal(withCr.filter((file) => scanned.has(file)).length, 0, '含 CR 的快照进了扫描面 ⇒ 守卫会永久假红');
});
