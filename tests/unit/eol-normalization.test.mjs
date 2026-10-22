/**
 * 守卫：仓库文本文件的行尾必须是 LF —— **零 CR**（GY-R31，收口 `#469` 的副作用，`Refs #469`）。
 *
 * 为什么要这条：`#469` 合入 main 时把 `docs/architecture/contract-implementation-status.md`
 * 整份从 LF 翻成 CRLF（实测 main 侧 0 CR、`#469` 侧 200 CR / 200 行）。仓库当时没有
 * `.gitattributes`、`core.autocrlf=false`，于是这个副作用**不会自愈**，并且：
 *   ① 之后每张动该台账的 PR 都跟它产生「全文 1 块」的假冲突，review 里看不到真实改动；
 *   ② `node tools/verify-contract-status.mjs --write-doc` 用 `writeFileSync(path, 字符串)` 落盘，
 *      字符串是 `\n` 拼的 ⇒ 谁跑一次门禁谁把它翻回 LF，再产生一次 200 行全红 diff；
 *   ③ 纯 CRLF 的文件上，`git diff` 的「改了哪几行」这个信号本身失效。
 * 判据放在这里而不是靠人肉自觉：**读字节**，不读文本、不做 `Get-Content` 式的往返判断
 * （后者按行读再拼回去，CR 早就被吃掉了，永远判绿）。
 *
 * 判红口径：`docs/**\/*.md`、`tools/*.mjs`、`packages/**\/*.mjs` 里任何一个字节 `0x0D` 都算违规
 * （不论它是 CRLF 的一半还是孤立 CR —— 两种都会污染 diff）。判定函数 `judgeEol` 导出，
 * 负控制与后续守卫复用同一套判据，不另立一套。
 *
 * ⚠ 边界（实测，不是推测）：`docs/verification/assets/i07-wechat-main8932ba5-pr80b5a6468/`
 * 和 `docs/verification/assets/local-knowledge-native-20261011/` 各自带一份
 * `.gitattributes`（`* -text whitespace=cr-at-eol`），把证据快照钉成**原样存取**。
 * 本守卫不扫这些目录里的 `.log`/`.cjs`/`.mjs`（不在扫描面内），并且这两个目录下**没有 `.md`**
 * （实测 0 个），所以「docs/**\/*.md 零 CR」与「证据快照字节不动」两条不打架。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根：由本文件位置推出（`tests/unit/` → `../..`），⛔ 不用 `process.cwd()`。 */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * 扫描面。写成「目录 + 是否递归 + 扩展名」而不是 glob 字符串，是为了不引第三方依赖，
 * 也为了让 `collectScopeFiles` 的边界一眼可读（新增面必须改这里，不会被一条 `**` 顺手放大）。
 */
export const SCAN_SCOPE = Object.freeze([
  Object.freeze({ dir: 'docs', recursive: true, ext: '.md' }),
  Object.freeze({ dir: 'tools', recursive: false, ext: '.mjs' }),
  Object.freeze({ dir: 'packages', recursive: true, ext: '.mjs' }),
]);

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

/** 扫出扫描面里的文件（绝对路径，稳定排序）。目录不存在 ⇒ 抛错（宁可红，不要静默少扫）。 */
export function collectScopeFiles({ root = ROOT, scope = SCAN_SCOPE } = {}) {
  const found = [];
  const walk = (absoluteDir, ext) => {
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
      const absolute = join(absoluteDir, entry.name);
      if (entry.isDirectory()) walk(absolute, ext);
      else if (entry.isFile() && entry.name.endsWith(ext)) found.push(absolute);
    }
  };
  for (const { dir, recursive, ext } of scope) {
    const absoluteDir = join(root, dir);
    if (!statSync(absoluteDir).isDirectory()) {
      throw new Error(`扫描面 ${dir} 不是目录（口径失效，先修扫描器，别让它静默扫 0 个文件）`);
    }
    if (recursive) walk(absoluteDir, ext);
    else {
      for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(ext)) found.push(join(absoluteDir, entry.name));
      }
    }
  }
  return found.sort();
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

test('eol/扫描面非空：真的扫到了 docs + tools + packages，不是扫 0 个文件的假绿', () => {
  const files = collectScopeFiles();
  // 假绿的样子：目录名写错 ⇒ 一个文件都没扫 ⇒ "零 CR"。先把它堵死。
  assert.ok(files.length >= 350, `扫描面只有 ${files.length} 个文件，明显没扫全（口径失效，先修 collectScopeFiles）`);
  const rel = files.map((file) => displayPath(file, ROOT));
  assert.ok(rel.some((path) => path.startsWith('docs/') && path.endsWith('.md')), '扫描面里没有 docs/**/*.md');
  assert.ok(rel.some((path) => path.startsWith('tools/') && path.endsWith('.mjs')), '扫描面里没有 tools/*.mjs');
  assert.ok(rel.some((path) => path.startsWith('packages/') && path.endsWith('.mjs')), '扫描面里没有 packages/**/*.mjs');
  // `tools/*.mjs` 是**不递归**的：把子目录里的文件也算进来会让这条面名不副实。
  assert.ok(rel.every((path) => !path.startsWith('tools/') || path.split('/').length === 2), 'tools 面被递归扫了，口径与文档不符');
});

test('eol/docs/**/*.md + tools/*.mjs + packages/**/*.mjs 零 CR（含 0x0D 即违规）', () => {
  const result = judgeEol(collectScopeFiles());
  assert.equal(result.violations.length, 0, `存在 CR 行尾（会被 git 视作整块改写）：${result.summary}`);
  // 反向自检：判绿必须建立在"确实读了字节"上，扫描面里每个文件都读到了。
  assert.equal(result.scanned.length, collectScopeFiles().length);
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

test('eol/.gitattributes 确实声明了这五类文本为 eol=lf，且没有 text=auto', () => {
  // 没有 `.gitattributes` 正是 `#469` 副作用不自愈的根因；这条把"声明本身"也钉住，
  // 免得后来人删掉它、换个目录跑一次门禁，CRLF 又悄悄回来。
  const attributes = readFileSync(join(ROOT, '.gitattributes'), 'utf8');
  const rules = attributes
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  for (const pattern of ['*.md', '*.mjs', '*.ts', '*.json', '*.yml']) {
    assert.ok(
      rules.some((rule) => rule.split(/\s+/u)[0] === pattern && /\beol=lf\b/u.test(rule)),
      `.gitattributes 缺少「${pattern} text eol=lf」`,
    );
  }
  assert.ok(!rules.some((rule) => /text=auto/u.test(rule)), '.gitattributes 不许写 text=auto（会把图片/证据快照误判成文本）');
});
