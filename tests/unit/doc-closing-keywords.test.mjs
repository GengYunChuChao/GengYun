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
 *   ② **检测器正控制**：裁定 §2.1 列出的每种形式（含大小写、半角／全角冒号、无分隔写法）、
 *      跨行形态（关键字在行末、编号在下一行首）、`OWNER/REPO#N`、完整 URL、历史 `GH-N`
 *      都必须判红；裁定允许的引用写法（`` `关键字`＋`#N` ``、「关单前置：`#N`」、「`Refs #N`」）
 *      一个都不许判红。没有 ②，「0 命中」可能只是检测器瞎了（假绿），这就是本文件存在的理由。
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
 * 已知非目标（2026-10-23 如实登记，⛔ 不得写成「已全覆盖」）：
 *   - **PR 正文与 commit message 本身**——本闸门扫的是仓库文件，而本次事故的触发面正是合并说明；
 *     该面只能靠发正文前用同一正则自查（流程工具，非 CI）。
 *   - `repository_dispatch`／GitHub API 关单等非文本形态。
 *   - 子目录 README（`services/api/README.md` 等，当前 27 份）不在扫描面内（`docs/**` 之外）。
 *   已覆盖的引用形态见 `REFERENCE`：`#N`、`OWNER/REPO#N`、issue／pull 完整 URL、历史 `GH-N`；
 *   关键字与编号之间**允许跨一个换行**（见 `SEPARATOR`）。
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

/** 关键字与编号之间的**行内**分隔：GitHub 允许 0..n 个空白、可选一个冒号（含全角 `：`）。 */
const INLINE_SEPARATOR = String.raw`[^\S\r\n:：]*(?:[:：][^\S\r\n]*)?`;

/**
 * 完整分隔：行内分隔 ＋ **最多跨一个换行**。
 *
 * 为什么要跨行（2026-10-23 对抗性审查 P7/P8 实测漏判）：GitHub 的解析作用在正文渲染后的
 * 文本上，markdown 软换行在渲染时就是空格；而本次事故的串本身是在**合并说明**里被搬动／重排
 * 后才触发的 ⇒ 「关键字在行末、编号在下一行首」不可排除，闸门必须取保守侧。
 * ⛔ 只允许**一个**换行：空行分段属于另一段文本，再放宽会把整篇文档连起来，误伤面失控。
 */
const SEPARATOR = String.raw`${INLINE_SEPARATOR}(?:\r?\n${INLINE_SEPARATOR})?`;

/**
 * 引用形态（GitHub 官方文档 `Linking a pull request to an issue` 明列的写法）：
 *   ① `#17`；② `OWNER/REPO#17`（如 `octo-org/octo-repo#100`，审查探针 X1/X2 曾漏判）；
 *   ③ issue／pull 的完整 URL；④ 历史形态 `GH-17`。
 * ④ 的依据弱于前三种（现行文档已不列 `GH-N`），但成本为零、且本仓当前 0 命中，故一并覆盖；
 * 若监工认为超范围，删掉 `|\s*gh-\d+` 这一段即可，其余三类不受影响。
 */
const REFERENCE = String.raw`(?:(?:[\w.-]+\/[\w.-]+)?#\d+|https?:\/\/(?:www\.)?github\.com\/[^\s/]+\/[^\s/]+\/(?:issues|pull)\/\d+|\s*gh-\d+)`;

/**
 * 检测器本体。
 * - `(?<![\w-])` 前置边界：`forecloses`／`unclosed` 这类英文词尾不算关键字（不误伤散文）；
 * - `gi`：大小写不敏感（全小写的写法一样会关单）＋ **整段** `matchAll`（不再逐行匹配，
 *   否则跨行形态永远抓不到；行列改由匹配偏移反算，见 `scanText`）。
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

/** 把跨行命中压成一行，便于在断言信息里逐条点名（`⏎` 代表命中片段里的换行）。 */
function oneLine(text) {
  return text.replace(/\r?\n/g, '⏎');
}

/**
 * **整段**扫描一段文本，返回 `{ line, column, match }`。
 *
 * 判据从「逐行 `matchAll`」改成「整段 `matchAll` ＋ 偏移反算行列」：逐行扫描时
 * 「关键字在行末、编号在下一行首」这种形态**永远抓不到**（对抗性审查 P7/P8 实测漏判）。
 * 行列仍须准确 —— 报告 `文件:行:列` 是给人按图索骥的，行号错了比不报更糟。
 */
function scanText(text) {
  const hits = [];
  // 行首偏移表 + 二分查找：命中数少，但文件多（373 份），避免每条命中都从头数换行。
  const lineStarts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') lineStarts.push(index + 1);
  }
  const locate = offset => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (lineStarts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return { line: low + 1, column: offset - lineStarts[low] + 1 };
  };
  for (const match of text.matchAll(CLOSING_PATTERN)) {
    hits.push({ ...locate(match.index), match: match[0] });
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
    ...findings.map(finding => `  · ${finding.file}:${finding.line}:${finding.column} → ${oneLine(finding.match)}`),
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

test('正控制：跨行／`OWNER/REPO#N`／历史 `GH-N` 形态必须判红，且 `行:列` 读数准确', () => {
  // 拼接样本：源码里不留「关键字 + 编号」的连续字面串（将来扩扫描面到 tests/** 也不会自咬）。
  const K = (...parts) => parts.join('');
  const cases = [
    // 对抗性审查 P7 原例：关键字在行末、编号在下一行首
    { name: '跨行 #N', text: `${K('判据：', 'Clos', 'es')}\n${K('#', '99')} 已满足。\n`, line: 1, column: 4 },
    // 对抗性审查 P8 原例：跨行 URL
    { name: '跨行 URL', text: `${K('Clos', 'es')}\nhttps://github.com/o/r/pull/99\n`, line: 1, column: 1 },
    // 对抗性审查 X1 原例：GitHub 官方文档「不同仓库」表格写法
    { name: 'OWNER/REPO#N（Fixes）', text: `${K('Fix', 'es')} octo-org/octo-repo${K('#', '100')}\n`, line: 1, column: 1 },
    // 对抗性审查 X2 原例：本仓 OWNER/REPO#N
    { name: 'OWNER/REPO#N（Closes）', text: `${K('Clos', 'es')} GengYunChuChao/GengYun${K('#', '99')}\n`, line: 1, column: 1 },
    // 对抗性审查 X3/X4：历史 `GH-N` 形态（取舍见文件头 `REFERENCE` 注释）
    { name: 'GH-N（大写）', text: `${K('Clos', 'es')} ${K('GH', '-99')}\n`, line: 1, column: 1 },
    { name: 'GH-N（小写）', text: `${K('clos', 'es')} ${K('gh', '-99')}\n`, line: 1, column: 1 },
    // 跨行 ＋ 冒号 ＋ 缩进：报的必须是「关键字首字符」的行列，不是编号那一行
    { name: '跨行 + 冒号 + 缩进', text: `第一行\n  判据 Resolved:\n   ${K('#', '7')} 结束\n`, line: 2, column: 6 },
  ];
  const failures = [];
  for (const item of cases) {
    const hits = scanText(item.text);
    const ok = hits.length === 1 && hits[0].line === item.line && hits[0].column === item.column;
    if (!ok) {
      const got = hits.map(hit => `${hit.line}:${hit.column} ${oneLine(hit.match)}`).join(' / ') || '无命中';
      failures.push(`${item.name} ⇒ 实得 ${got}（期望 ${item.line}:${item.column} 恰 1 处）`);
    }
  }
  assert.deepEqual(
    failures,
    [],
    [
      '这些形态 GitHub 都会解析（跨行两条为审查实测漏判，`OWNER/REPO#N` 是官方文档原例）：',
      ...failures.map(line => `  · ${line}`),
    ].join('\n'),
  );

  // 反方向的边界：不许为了「多抓」把这两类也算命中，否则闸门变成噪声源。
  const boundaries = [
    { name: '关键字在行末但下一行没有编号', text: `${K('判据：', 'Clos', 'es')}\n下一段没有编号。\n` },
    { name: '空行分段（只允许跨一个换行）', text: `${K('判据：', 'Clos', 'es')}\n\n${K('#', '99')}\n` },
    { name: 'OWNER/REPO 但没有 # 编号', text: `${K('Fix', 'es')} octo-org/octo-repo\n` },
  ];
  for (const boundary of boundaries) {
    assert.deepEqual(
      scanText(boundary.text),
      [],
      `过度匹配（${boundary.name}）：闸门会把合法散文咬成红，维护者只能整体放弃引用`,
    );
  }
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
    findings.map(finding => `${finding.file}:${finding.line}:${finding.column} → ${oneLine(finding.match)}`),
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
