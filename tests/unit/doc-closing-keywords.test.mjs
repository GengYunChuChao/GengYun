/**
 * 文档关单关键字闸门：`docs/**`（排除归档）＋ 根级说明 ＋ `.github/**` 里**不得**出现
 * 可被 GitHub 解析的关单关键字字面串（形如「关键字 + 编号」相邻）。
 *
 * 事故（2026-10-23）：`#496` 的合并说明里带出字面串 ⇒ GitHub 把关联 issue **自动关掉**了。
 * 那串来自 `docs/verification/gy-i17-closeout-20261023.md` 的三处「引述指挥裁定」——
 * 原意只是**引用措辞**，在 GitHub 眼里却等于「请关闭」。裁定见
 * `.pg17/ruling-r33-closing-keyword-hazard-20261023.md`（仓外，不随 PR 提交）。
 * 核心教训：**「引用」也是「指令」**，所以关键字的引用写法必须破坏它与编号的相邻性。
 *
 * 判据（是 assert，⛔ 不是 warn）：
 *   ① **全扫描面 0 命中**；命中就打印 `文件:行:列 → 命中片段` ＋ 整改建议，并由 `node --test` 判红。
 *   ② **检测器正控制**：裁定 §2.1 列出的每种形式（含大小写、半角／全角冒号、无分隔写法）都必须判红；
 *      裁定允许的引用写法（`` `关键字`＋`#N` ``、「关单前置：`#N`」、「`Refs #N`」）一个都不许判红。
 *      没有 ②，「0 命中」可能只是检测器瞎了（假绿），这就是本文件存在的理由。
 *   ③ **扫描面自检**：文档数下限、`docs/archive/**` 确实被排除、事故源文件确实在扫描面内 ——
 *      防止有人改一行路径之后「扫了个寂寞」还报绿。
 *
 * 扫描面（写死，避免误伤）：
 *   - `docs/**`，**排除 `docs/archive/**`**（归档是历史快照，按裁定 §2.3 不改写）；
 *   - 根级 `README.md`、`AGENTS.md` 及根级其它 `*.md`／`*.txt`；
 *   - `.github/**`（PR 模板与 workflow 的注释同样会被人整段贴进 PR 正文）。
 *   ⛔ 不扫 `tests/**`、`services/**`、`apps/**`、`miniprogram/**`：本闸门只管「会被整段贴进 PR
 *   正文／合并说明的文本」，不去管代码与夹具里的普通字符串（那属别的切片）。
 *   ⚠ 本文件自身不在扫描面内；即便如此，源码里也**故意不写出**「关键字 + 编号」的连续字面串
 *   （样本用 `keyword + ' #17'` 拼），这样将来即使有人把扫描面扩到 `tests/**` 也不会自咬。
 *
 * 已知非目标：不覆盖 `repository_dispatch`／API 关单等形态，只覆盖 GitHub 在 PR 正文与
 * commit message 里会解析的两种引用（`#N` 与 issue／pull 的完整 URL）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根：由本文件位置推出（`tests/unit/` → `../..`），⛔ 不用 `process.cwd()`（与仓内其它守卫同口径）。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * GitHub 在 PR 正文／commit message 里会解析的关单关键字。
 *
 * 比裁定 §2.1 明列的 7 个形式**多两个**（裸 `fix`／`resolve`）：它们同样是 GitHub 认的关键字，
 * 漏掉等于留洞。⛔ 不要为了「少红几条」把这张表缩短；要放宽先改裁定。
 */
const CLOSING_KEYWORDS = ['close', 'closes', 'closed', 'fix', 'fixes', 'fixed', 'resolve', 'resolves', 'resolved'];

/** 关键字与编号之间的分隔：GitHub 允许 0..n 个空白、可选一个冒号（含全角 `：`）。 */
const SEPARATOR = String.raw`[\s:：]*`;

/** 引用形态：`#17` 或 issue／pull 的完整 URL（GitHub 两种都认）。 */
const REFERENCE = String.raw`(?:#\d+|https?:\/\/(?:www\.)?github\.com\/[^\s/]+\/[^\s/]+\/(?:issues|pull)\/\d+)`;

/**
 * 检测器本体。
 * - `(?<![\w-])` 前置边界：`forecloses`／`unclosed` 这类英文词尾不算关键字（不误伤散文）；
 * - `gi`：大小写不敏感（全小写的写法一样会关单）＋ 逐行 `matchAll`。
 */
const CLOSING_PATTERN = new RegExp(
  String.raw`(?<![\w-])(?:${CLOSING_KEYWORDS.join('|')})${SEPARATOR}${REFERENCE}`,
  'gi',
);

/** 只读这些扩展名的文本；图片／二进制一律不读（`docs/` 下有 100+ png/jpg）。 */
const TEXT_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.mdx',
  '.txt',
  '.yml',
  '.yaml',
  '.json',
  '.jsonl',
  '.html',
  '.htm',
  '.css',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.py',
  '.patch',
  '.diff',
  '.log',
]);

/** 归档目录：历史快照按裁定不改写，也不该被本闸门反复点名。 */
const EXCLUDED_PREFIXES = ['docs/archive/'];

/** 根级说明文件：即使将来根目录只剩它们，也必须被扫到。 */
const REQUIRED_ROOT_FILES = ['README.md', 'AGENTS.md'];

/** 递归列出目录下的文本文件（仓库相对 POSIX 路径；符号链接一律跳过，不跟到仓外）。 */
function listTextFiles(directoryRelativePath) {
  const files = [];
  const stack = [directoryRelativePath];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(join(REPO_ROOT, current), { withFileTypes: true });
    } catch {
      continue; // 目录不存在＝该扫描面不存在，由「扫描面自检」那条测试负责把它点出来
    }
    for (const entry of entries) {
      const child = `${current}/${entry.name}`;
      if (entry.isDirectory()) {
        stack.push(child);
        continue;
      }
      // `isFile()` 对符号链接为 false ⇒ 直接跳过，避免顺着链接读到仓外文本。
      if (!entry.isFile()) continue;
      if (!TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      files.push(child);
    }
  }
  return files;
}

/** 根级 `*.md`／`*.txt`（含 `README.md`、`AGENTS.md`）。 */
function listRootTextFiles() {
  const discovered = readdirSync(REPO_ROOT, { withFileTypes: true })
    .filter(entry => entry.isFile() && ['.md', '.txt'].includes(extname(entry.name).toLowerCase()))
    .map(entry => entry.name);
  return [...new Set([...REQUIRED_ROOT_FILES, ...discovered])].filter(name => existsSync(join(REPO_ROOT, name)));
}

/** 扫描面：`docs/**`（排除归档）＋ 根级文本 ＋ `.github/**`，去重排序后返回。 */
function collectScanTargets() {
  const targets = [
    ...listTextFiles('docs').filter(file => !EXCLUDED_PREFIXES.some(prefix => file.startsWith(prefix))),
    ...listRootTextFiles(),
    ...listTextFiles('.github'),
  ];
  return [...new Set(targets)].sort();
}

/** 逐行扫描一段文本，返回 `{ line, column, match }`。 */
function scanText(text) {
  const hits = [];
  const lines = text.split(/\r\n|\r|\n/);
  for (let index = 0; index < lines.length; index += 1) {
    for (const match of lines[index].matchAll(CLOSING_PATTERN)) {
      hits.push({ line: index + 1, column: match.index + 1, match: match[0] });
    }
  }
  return hits;
}

/** 扫描整个扫描面。 */
function scanRepository(targets = collectScanTargets()) {
  const findings = [];
  for (const file of targets) {
    for (const hit of scanText(readFileSync(join(REPO_ROOT, file), 'utf8'))) {
      findings.push({ file, ...hit });
    }
  }
  return findings;
}

/** 整改建议（裁定 §2.1 允许的三种写法）。 */
const REMEDIATION = [
  '整改（裁定 §2.1 允许的写法，⚠ 只破坏「关键字与编号相邻」，⛔ 不得改动任何事实含义）：',
  '  1) 关键字与编号拆开：`关键字`＋`#N`；',
  '  2) 改写成中文前置：关单前置：`#N` ／ 「关闭前置（`#N`）」；',
  '  3) 必须逐字引述原文时：`关键字`＋`#N`，并在同句注明「引述原文，非关单请求」。',
].join('\n');

/** 把命中渲染成「文件:行:列 → 片段 ＋ 建议」，供断言失败信息与人工排错共用。 */
function renderReport(findings) {
  return [
    `文档里出现了可被 GitHub 解析的关单关键字：${findings.length} 处`,
    '（授权／事故背景：.pg17/ruling-r33-closing-keyword-hazard-20261023.md；2026-10-23 #496 合并说明带出该串 ⇒ 关联 issue 被自动关闭）',
    '',
    ...findings.map(finding => `  · ${finding.file}:${finding.line}:${finding.column} → ${finding.match}`),
    '',
    REMEDIATION,
    '',
    '这不是风格问题：GitHub 会在 PR 正文与 commit message 里解析这类字面串，合并说明会继承它，',
    '于是「引用一句裁定」＝「请求关单」。',
  ].join('\n');
}

/** 用 `keyword + ' #17'` 拼样本：源码里不留「关键字 + 编号」的连续字面串（避免将来扩扫描面时自咬）。 */
function sample(keyword, separator = ' ') {
  return `${keyword}${separator}${'#'}17`;
}

test('正控制：裁定 §2.1 的每种关键字形式（大小写／冒号／全角冒号／无分隔）都必须判红', () => {
  const separators = [' ', '  ', '\t', ':', ': ', '：', '： ', ''];
  const missed = [];
  for (const keyword of CLOSING_KEYWORDS) {
    for (const variant of [keyword, keyword.toUpperCase(), keyword[0].toUpperCase() + keyword.slice(1)]) {
      for (const separator of separators) {
        const text = `判据：${sample(variant, separator)} 前置已满足。\n`;
        const hits = scanText(text);
        if (hits.length !== 1) missed.push({ text: text.trim(), hits });
      }
    }
  }
  assert.deepEqual(
    missed,
    [],
    [
      '检测器漏判（漏哪一种，哪一种就会重新触发自动关单）：',
      ...missed.map(item => `  · ${item.text} ⇒ 命中 ${item.hits.length} 次`),
    ].join('\n'),
  );

  // URL 形态同样会被 GitHub 解析，不能只查 `#N`。
  const urlForm = `${'Clos'}${'es'} https://github.com/GengYunChuChao/GengYun/issues/17\n`;
  assert.equal(scanText(urlForm).length, 1, 'issue／pull 的完整 URL 形态也必须判红（GitHub 两种引用都认）');
});

test('正控制：裁定允许的引用写法一个都不许判红（闸门不得把合规写法咬成红）', () => {
  const allowed = [
    '`' + 'Closes' + '`＋`#17`', // 裁定首选形式：关键字与编号被反引号＋全角加号隔开
    '`' + 'Closes' + '`＋`#17` 的前置：A ＋ G3',
    '关单前置：`#17`',
    '「关闭前置（`#17`）」',
    '`Refs #17`',
    'Refs #17',
    '口径 `Refs #17`；未完成部分不写关单关键字。',
    '`' + 'Closes' + '`　`#17`', // 裁定 §2.1 允许的「全角分隔」写法
    // 边界：关键词出现在别的词里不算（英文散文常见）。样本同样用拼接生成，源码里不留连续字面串。
    `${[['fore', 'closes'], ['un', 'closed'], ['pre', 'fix']]
      .map(([prefix, keyword]) => `${prefix}${keyword} ${'#'}17`)
      .join(' 与 ')} 都不是关键字（词尾不算）。`,
  ];
  const falsePositives = allowed.filter(line => scanText(line).length > 0);
  assert.deepEqual(
    falsePositives.map(line => `${line} ⇒ ${JSON.stringify(scanText(line))}`),
    [],
    '闸门把裁定允许的写法判成了违规：合规写法被咬 ⇒ 维护者只能放弃引用，判据退化成噪声',
  );
});

test('全扫描面 0 命中：docs/**（排除 archive）＋ 根级说明 ＋ .github/** 不得出现字面关单关键字', () => {
  const targets = collectScanTargets();
  const findings = scanRepository(targets);
  assert.deepEqual(
    findings.map(finding => `${finding.file}:${finding.line}:${finding.column} → ${finding.match}`),
    [],
    renderReport(findings),
  );
  // 顺带把读数打出来（绿的时候也能证明「扫的是真文件」，不是空集）。
  assert.ok(targets.length > 0, '扫描面为空：路径口径被改坏了');
});

test('扫描面自检：文档数下限、archive 被排除、事故源文件在面内（防「扫了个寂寞」）', () => {
  const targets = collectScanTargets();
  const docsTargets = targets.filter(file => file.startsWith('docs/'));
  const markdownTargets = docsTargets.filter(file => file.endsWith('.md'));

  assert.ok(
    markdownTargets.length >= 250,
    `只扫到 ${markdownTargets.length} 份 docs markdown（基线 765b6a31 上实测 304 份）：扫描面被改坏了，绿了也不算数`,
  );
  assert.ok(targets.includes('README.md'), '根级 README.md 必须在扫描面内');
  assert.ok(targets.includes('AGENTS.md'), '根级 AGENTS.md 必须在扫描面内');
  assert.ok(
    targets.some(file => file.startsWith('.github/')),
    '.github/** 必须在扫描面内（PR 模板与 workflow 注释同样会被人贴进 PR 正文）',
  );
  assert.deepEqual(
    targets.filter(file => file.startsWith('docs/archive/')),
    [],
    'docs/archive/** 属历史快照，按裁定 §2.3 不改写，也不该被本闸门点名',
  );

  // 事故源文件必须在面内：它一旦滑出扫描面，这类串就又能原样漏过去。
  const accidentSource = 'docs/verification/gy-i17-closeout-20261023.md';
  assert.ok(targets.includes(accidentSource), `${accidentSource} 必须在扫描面内（2026-10-23 误关单的串就来自它）`);

  // 事故源文件里那三处「引述裁定」的写法必须已经按裁定 §2.1 拆开（本片改写的落点）。
  const accidentText = readFileSync(join(REPO_ROOT, accidentSource), 'utf8');
  assert.equal(scanText(accidentText).length, 0, '事故源文件里仍有字面关单关键字');
  const splitQuotation = '`' + 'Closes' + '`＋`#17`';
  assert.ok(
    accidentText.includes(splitQuotation),
    `事故源文件必须保留「${splitQuotation}」这种引述写法（改写只破坏相邻性，⛔ 不得删掉被引述的事实）`,
  );
  assert.ok(
    accidentText.includes('引述原文，非关单请求'),
    '逐字引述处必须同句注明「引述原文，非关单请求」（裁定 §2.1 第 3 种允许写法）',
  );
});
