/**
 * docs/research 机械结构看守（v2）
 * ------------------------------------------------------------
 * 用途：把 `docs/research/README.md` 的人工约定（命名、十项字段、逐项来源）变成
 * **可复算的断言**，接在 `npm run test:docs` 的第二段，并由
 * `.github/workflows/development-docs.yml` 在 CI 里跑同一条命令。没有它 README
 * 只是散文：少写一项「引入成本」、四条来源全堆在同一项技术下、把字段藏进代码围栏，
 * 人眼看不出，CI 也不会红。
 *
 * 本脚本是**纯静态**校验：只读文件，不起服务、不联网、不写任何文件、零依赖。
 *
 * 判据（对应 README §2／§3／§4 与裁定 `ruling-research-gate-v2-20261018.md`）：
 *  1) 文件名 `YYYY-MM-DD-<主题>.md`：日期必须是真实日历日期（2026-02-30 不算），
 *     主题只用小写字母／数字／连字符。
 *  2) 记录级四项（每条记录都要）：
 *     - `检索日期：YYYY-MM-DD`，且与**文件名日期一致**；
 *     - `检索方式：` 或 `检索词` 出现（未用检索词时须写明直接抓取）；
 *     - ≥2 条**去重后**的 http(s) 来源 URL（去重按 `host+path` 归一：丢 fragment／query、
 *       去尾斜杠、host 与 path 转小写。只差 `#a`／`#b` 的两个地址算同一条）；
 *     - 来源版本或提交：`v?\d+\.\d+\.\d+`、40 位十六进制 SHA，或紧邻 `commit`／`sha`／`tag`
 *       标签的 7–40 位十六进制。裸的 7 位十六进制（例如 `1048576`）**不算**——
 *       它更可能是体积／行数读数，而不是版本。
 *  3) 正文范围：**围栏代码块（``` 或 ~~~）与 HTML 注释（`<!-- -->`）内的字段与 URL
 *     一律不计入**。理由：注释和围栏是给人看的草稿／命令，不是记录的证据面；否则
 *     把「引入成本」写进围栏、把来源写在注释里就能骗过门禁。
 *  4) 完整记录 vs 最短记录（裁定 §2）：
 *     - **完整记录**＝出现 `## N <技术>` 技术段，或出现七项字段表（`| 字段 | 含义 |`
 *       或任何一列逐字是七项之一的表）⇒ **每项技术各 7 字段** ＋ 记录级四项；
 *     - **最短记录**＝无上述结构（README §7 的内部工具片）⇒ 记录级四项 ＋ ≥2 来源 ＋
 *       决定与理由。
 *     七项字段**不绑定形状**：写成 `- 字段：值` 列表、写成表格、表格的字段列在第几列
 *     都认（按单元格逐字比对，容忍 `（…）` 括注）。
 *  5) 来源**按项**计数，不是记录级总数：
 *     - 完整记录：每个技术段（含其 `### 检索来源` 子表）去重后 ≥2 条 URL。四项技术
 *       各 1 条（总数 4）不通过——这正是 v1 的漏洞；
 *     - 最短记录：若出现带「技术」列的表，则**按行**核（该行 URL ∪ 路径段等于该项名的
 *       记录内其它 URL）；否则按整条记录核 ≥2 条。
 *  6) 技术段里若出现不是七项之一的字段名（例如混入「备注」）⇒ 失败。
 *  7) 历史文件（R10 制度之前落地的 `gy-i03-*`）只能登记进 `legacy-allowlist.json`
 *     并钉死内容哈希：未登记的历史文件、登记了却已不存在的文件、哈希对不上的文件
 *     ⇒ 全部失败。白名单**只收 `gy-i03-*`**：拿白名单给新记录开后门（例如登记
 *     `my-notes.md`）⇒ 失败。历史记录不得改写，只有登记与钉住这一条路。
 *  8) `未取得` 是 README §3 明文允许的取值（查不到就写未取得，不得用记忆替代），
 *     本脚本**不作失败**判定。
 *
 * 哈希口径（跨平台可复现）：allowlist 里的 sha256 一律对 **LF 归一化（CRLF→LF）后的
 * UTF-8 字节**计算。本仓库 `core.autocrlf=true` 且没有 `.gitattributes`：工作区检出是
 * CRLF、CI（ubuntu）检出是 LF。若按工作区原始字节算，**同一个提交**在两个平台会算出
 * 两个哈希，门禁就成了平台囚徒（AGENTS.md §5.2 的"跨平台不可复现"判罚款）。
 *
 * 退出码：0＝全部通过；1＝有失败；2＝用法错误／目录不存在／目录里没有 README.md。
 * 「空目录」必须报错：路径写错却让整条门禁静默通过，是最坏的一种假绿。
 *
 * 运行：node tools/verify-research-records.mjs [目录]   （默认 docs/research）
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根：由本文件位置推出（tools/ → ..），⛔ 不用 process.cwd()。 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DIR = 'docs/research';
const README_NAME = 'README.md';
const ALLOWLIST_NAME = 'legacy-allowlist.json';
const HASH_METHOD = 'sha256-utf8-lf-normalized';
const NAME_PATTERN = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
/** 白名单只收基线既有的 `gy-i03-*` 历史文件，别的一律不收。 */
const LEGACY_PATTERN = /^gy-i03-[A-Za-z0-9._-]+\.(?:md|json)$/u;
const USAGE = `用法：node tools/verify-research-records.mjs [目录]（默认 ${DEFAULT_DIR}）`;

/** README §3 技术七项，逐字比对（允许字段名后紧跟 `（…）` 括注）。 */
const TECHNICAL_FIELDS = [
  '现用版本',
  '上游维护状态',
  '可复用部分',
  '许可证与署名',
  '兼容性',
  '引入成本',
  '决定'
];

/**
 * 「来源版本或提交」的强判据。裸 7 位十六进制不满足：`1048576` 也是 7 位十六进制，
 * 但它通常是体积读数，把它当版本号等于放行一条没有版本证据的记录。
 */
const STRONG_VERSION =
  /(?:\bv?\d+\.\d+\.\d+\b|\b[0-9a-f]{40}\b|\b(?:commit|sha|tag)\b[^\n]{0,24}?\b[0-9a-f]{7,40}\b)/iu;

/** 列表形态的字段行：`- 现用版本（证据命令）：…`、`1. 决定：…`、`- **决定：**…`。 */
const LIST_FIELD = new RegExp(
  `^\\s*(?:[-*+]|\\d+[.)])\\s+(${TECHNICAL_FIELDS.join('|')})(?:（[^）]*）|\\([^)]*\\))?\\s*[：:]\\s*`,
  'u'
);

/** LF 归一化后的 sha256：丢掉 CR、保留 LF，再对字节哈希。 */
function lfNormalizedSha256(buffer) {
  const bytes = Buffer.alloc(buffer.length);
  let cursor = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0x0d && buffer[index + 1] === 0x0a) continue;
    bytes[cursor] = buffer[index];
    cursor += 1;
  }
  return createHash('sha256').update(bytes.subarray(0, cursor)).digest('hex');
}

function isRealDate(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/**
 * 屏蔽围栏代码块与 HTML 注释：把其中的非换行字符替换成空格，**保留行号与换行布局**，
 * 这样后续的表格／行号／字段判定都不必为"被屏蔽的正文"补一套分支。
 * 未闭合的围栏／注释按"一直到文末都屏蔽"处理：宁可让记录因为缺字段而失败，
 * 也不能让一段没写完的围栏把后面的字段与来源吞掉之后还判通过。
 */
function maskIgnoredRegions(text) {
  const lines = text.split(/\r?\n/u);
  const masked = [];
  let fence = null;
  for (const line of lines) {
    const opener = /^\s*(`{3,}|~{3,})/u.exec(line);
    if (fence === null && opener !== null) {
      fence = { char: opener[1][0], length: opener[1].length };
      masked.push(' '.repeat(line.length));
      continue;
    }
    if (fence !== null) {
      const closer = /^\s*(`{3,}|~{3,})\s*$/u.exec(line);
      if (closer !== null && closer[1][0] === fence.char && closer[1].length >= fence.length) {
        fence = null;
      }
      masked.push(' '.repeat(line.length));
      continue;
    }
    masked.push(line);
  }

  let result = masked.join('\n');
  result = result.replace(/<!--[\s\S]*?-->/gu, (block) => block.replace(/[^\n]/gu, ' '));
  const dangling = result.indexOf('<!--');
  if (dangling !== -1) {
    result = result.slice(0, dangling) + result.slice(dangling).replace(/[^\n]/gu, ' ');
  }
  return result;
}

/** 抽 http(s) URL，去掉正文／表格里紧贴 URL 的收尾标点。 */
function extractUrls(text) {
  const found = [];
  for (const match of text.matchAll(/https?:\/\/[^\s<>()[\]()（）【】"'`，。；：、]+/gu)) {
    let url = match[0];
    while (url.length > 0 && '.,;:!?'.includes(url[url.length - 1])) url = url.slice(0, -1);
    if (url.length > 0) found.push(url);
  }
  return found;
}

/** 去重键：`host+path` 归一（丢 fragment／query、去尾斜杠、转小写）。 */
function urlKey(url) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/u, '');
    return `${parsed.host.toLowerCase()}${path.toLowerCase()}`;
  } catch {
    return url.toLowerCase().replace(/[?#].*$/u, '').replace(/\/+$/u, '');
  }
}

/** 记录／片段内去重后的 URL 键集合。 */
function uniqueUrlKeys(text) {
  return new Set(extractUrls(text).map(urlKey));
}

/** URL 的路径（小写、去尾斜杠）：用来把「按项来源表」的行名与别处的同项页面连起来。 */
function urlPath(url) {
  try {
    return new URL(url).pathname.toLowerCase().replace(/\/+$/u, '');
  } catch {
    return '';
  }
}

/**
 * 路径是否以「斜杠边界」包含该项名：`/package/@babel/parser` 认 `@babel/parser`，
 * 但 `/api/test.html` **不**认 `test`——否则一个泛泛的行名会把无关 URL 全收进来。
 */
function pathMentionsItem(path, item) {
  if (path === '') return false;
  return path === `/${item}` || path.endsWith(`/${item}`) || path.includes(`/${item}/`);
}

/** 切表格行；`\|` 视为转义，不切。 */
function splitCells(line) {
  const body = line.trim().replace(/^\|/u, '').replace(/\|$/u, '');
  const cells = [];
  let current = '';
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === '\\' && body[index + 1] === '|') {
      current += '|';
      index += 1;
      continue;
    }
    if (char === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

const isTableLine = (line) => /^\s*\|/u.test(line);
const isSeparatorLine = (line) => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/u.test(line);

/** 找 markdown 表格（表头行 ＋ 分隔行 ＋ 表体），记录表体各行的**行号**。 */
function parseTables(lines) {
  const tables = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!isTableLine(lines[index])) continue;
    if (!isSeparatorLine(lines[index + 1] ?? '')) continue;
    const rows = [];
    let cursor = index + 2;
    while (cursor < lines.length && isTableLine(lines[cursor])) {
      rows.push({ line: cursor + 1, cells: splitCells(lines[cursor]) });
      cursor += 1;
    }
    tables.push({ startLine: index + 1, endLine: cursor, header: splitCells(lines[index]), rows });
    index = cursor - 1;
  }
  return tables;
}

/** 字段名归一：去首尾装饰，去尾部 `（…）` / `(…)` 括注。 */
function normalizeFieldName(cell) {
  return cell
    .trim()
    .replace(/^[*`\s]+/u, '')
    .replace(/[*`\s]+$/u, '')
    .replace(/（[^）]*）\s*$/u, '')
    .replace(/\([^)]*\)\s*$/u, '')
    .trim();
}

/**
 * 找字段名所在的列：任何一列只要有一个单元格逐字等于七项之一，就认为它是字段列。
 * 按列找而不是"认第 1 列"，是因为 `| # | 项 | 内容 |` 这种把字段放第 2 列的表同样是
 * 合法写法（裁定 §3 第三例：v1 只认第 1 列，缺项照样通过）。
 */
function findFieldColumn(table) {
  let best = -1;
  let bestHits = 0;
  const width = Math.max(table.header.length, ...table.rows.map((row) => row.cells.length));
  for (let column = 0; column < width; column += 1) {
    let hits = 0;
    for (const row of table.rows) {
      if (TECHNICAL_FIELDS.includes(normalizeFieldName(row.cells[column] ?? ''))) hits += 1;
    }
    if (hits > bestHits) {
      best = column;
      bestHits = hits;
    }
  }
  return best;
}

/** 表格是不是「七项字段表」：有字段列，或表头就是 README §3 的 `字段 | 含义` 模板。 */
function isFieldTable(table) {
  if (findFieldColumn(table) >= 0) return true;
  const headerText = table.header.join(' ');
  return headerText.includes('字段') && headerText.includes('含义');
}

/** 列表形态的字段行 ⇒ 字段名；不是字段行 ⇒ null。 */
function fieldNameFromListLine(line) {
  const probe = line.replace(/`/gu, '').replace(/\*\*|__/gu, '');
  const match = LIST_FIELD.exec(probe);
  return match === null ? null : match[1];
}

/** 解析标题，算出每一节的结束行（0 基索引），供技术段取范围用。 */
function parseSections(lines) {
  const headings = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s+(.+?)\s*$/u.exec(lines[index]);
    if (match !== null) headings.push({ index, level: match[1].length, title: match[2] });
  }
  const sections = [];
  for (let cursor = 0; cursor < headings.length; cursor += 1) {
    let end = lines.length;
    for (let next = cursor + 1; next < headings.length; next += 1) {
      if (headings[next].level <= headings[cursor].level) {
        end = headings[next].index;
        break;
      }
    }
    sections.push({ ...headings[cursor], end, line: headings[cursor].index + 1 });
  }
  return sections;
}

/**
 * 收集 [from, to] 行号范围内的字段名，并挑出不属于七项的字段名。
 * 只有**表格**能判"多出来的字段名"：列表形态里 `- 备注：…` 与普通叙述无从区分，
 * README 也允许自由行文，所以列表形态只做正向识别（七项缺一即失败）。
 */
function collectFields(lines, tables, from, to) {
  const names = new Set();
  const unexpected = [];
  for (const table of tables) {
    // 闭区间 [from, to]（都是 1 基行号）：段外独立字段表按「它自己」的起止行传进来，
    // 起点行必须算在内，所以用 `<` 而不是 `<=`——早先的 `<=` 会让单行退化区间
    // `[startLine, startLine]` 把表自身排除，于是永远报缺七项。
    if (table.startLine < from || table.startLine > to) continue;
    const column = findFieldColumn(table);
    if (column === -1) continue;
    for (const row of table.rows) {
      const name = normalizeFieldName(row.cells[column] ?? '');
      if (name === '') continue;
      if (!TECHNICAL_FIELDS.includes(name)) {
        unexpected.push(`第 ${row.line} 行的字段「${name}」不属于技术七项`);
        continue;
      }
      names.add(name);
    }
  }
  for (let index = from - 1; index < to && index < lines.length; index += 1) {
    const found = fieldNameFromListLine(lines[index]);
    if (found !== null) names.add(found);
  }
  return { names, unexpected };
}

/**
 * 完整记录的分类**只看标题形状**（裁定 r3 §1）：只要出现 `## N <名称>`（N ≥ 1），
 * 该记录就按完整记录核，不论段内还有没有七项字段或 `### 检索来源` 子标题。
 * 早先按"段内有字段／有来源子标题"判，会把"七项连同来源子表一起删掉"的技术段降级成最短记录
 * 而静默放行（c17），删证据反而变绿——这正是分类必须前置到记录级的原因。
 *
 * 豁免只给**标题整体恰好**是结构性小节的编号节（裁定 r4 §1）：白名单全串锚定，⛔ 不用
 * 「含 检索／来源／决定／复核」这类子串豁免——`## 1 检索`、`## 2 Fastify 检索证据` 里
 * 恰好带这些词，子串豁免会把真技术段整段放过（新的 false-pass）。
 *
 * 编号分隔符按常见 Markdown 写法放宽到 `1`／`1.`／`1、`／`1)`／`1）`（裁定 r4 §2），
 * 否则 `## 1. Fastify` 这种形状差异会漏判成非技术节。
 */
const STRUCTURAL_SECTION_TITLE = /^(?:总览|检索证据总表|未取得项?|复核读数|复核命令)$/u;
const NUMBERED_HEADING = /^(\d+)[.、)）]?\s+(\S.*)$/u;

function isTechnicalSection(section) {
  if (section.level !== 2) return false;
  const match = NUMBERED_HEADING.exec(section.title);
  if (match === null || Number(match[1]) < 1) return false;
  return !STRUCTURAL_SECTION_TITLE.test(match[2]);
}

/** 表头里出现这些词，才算「来源表」；总览表（技术｜仓库现用｜上游状态｜决定）不算。 */
const SOURCE_TABLE_HEADER = /来源|URL|链接|读数|证据/iu;

/** 表格上方的最近标题（用来判断表是否挂在 `### …来源…` 子标题下）。 */
function nearestHeading(lines, startIndex) {
  for (let index = startIndex; index >= 0; index -= 1) {
    const match = /^(#{1,6})\s+(.+?)\s*$/u.exec(lines[index]);
    if (match !== null) return { level: match[1].length, index, title: match[2] };
  }
  return null;
}

/**
 * 是不是来源表（裁定 r3 §3）：表头含 来源／URL／链接／读数／证据，或整张表挂在
 * `### …来源…` 子标题下。只有来源表才做「按行 ≥2 条」；其它表（含带「技术」列的总览表）
 * 不参与按行计数。
 */
function isSourceTable(lines, table) {
  if (SOURCE_TABLE_HEADER.test(table.header.join(' '))) return true;
  const heading = nearestHeading(lines, table.startLine - 2);
  return heading !== null && heading.level >= 3 && /来源/u.test(heading.title);
}

/**
 * 「按项来源」：给**来源表**里带「技术」列的行逐行核来源（裁定 r3 §3）。
 * 一行算几个来源＝该行 URL ∪ 记录里路径段含该项名的 URL——同一项技术的原始页与
 * registry JSON 页往往分属两张表，人眼看的是"这一项有几条来源"，不是"这一格有几条"。
 * 路径段**整段**相等才算（`typescript` 不会命中 `test.html`），避免把无关 URL 收进来。
 * 只有来源表参与：总览表（`| 技术 | 仓库现用 | 上游状态 | 决定 |`）只是列清单，
 * 按行核会把"先列技术清单、再给来源"的合法记录误红（c32）。
 */
function inspectSourceTableRows(text, lines, tables, fail) {
  const allUrls = extractUrls(text);
  for (const table of tables) {
    if (!isSourceTable(lines, table)) continue;
    const column = table.header.findIndex((cell) => /技术/u.test(cell));
    if (column === -1) continue;
    for (const row of table.rows) {
      const label = normalizeFieldName(row.cells[column] ?? '');
      if (label === '') continue;
      const keys = new Set(extractUrls(row.cells.join(' ')).map(urlKey));
      const needle = label.toLowerCase();
      for (const url of allUrls) {
        if (pathMentionsItem(urlPath(url), needle)) keys.add(urlKey(url));
      }
      if (keys.size < 2) {
        fail(`第 ${row.line} 行「${label}」的来源 URL 少于 2 条（按项去重后 ${keys.size} 条）`);
      }
    }
  }
}

/** 校验一条记录的全部判据，返回失败原因列表（空数组＝通过）。 */
function inspectRecord(filePath, fileName) {
  const reasons = [];
  const nameMatch = /^(\d{4})-(\d{2})-(\d{2})-/u.exec(fileName);
  let fileDate = null;
  if (nameMatch === null) {
    reasons.push('文件名不符合 `YYYY-MM-DD-<主题>.md`（主题只用小写字母／数字／连字符）');
  } else if (!isRealDate(nameMatch[1], nameMatch[2], nameMatch[3])) {
    reasons.push(`文件名日期 ${nameMatch[1]}-${nameMatch[2]}-${nameMatch[3]} 不是真实日历日期`);
  } else {
    fileDate = `${nameMatch[1]}-${nameMatch[2]}-${nameMatch[3]}`;
  }

  const masked = maskIgnoredRegions(readFileSync(filePath, 'utf8'));
  const lines = masked.split('\n');
  const tables = parseTables(lines);

  // 记录级字段也认表格形态（`| 检索日期 | 2026-10-18 |`）：把每行拼成 `首列：其余` 再匹配，
  // 这样 README 表格式模板照抄也能过，不会因为"写成表格"就判缺字段。
  const tableRowText = tables
    .flatMap((table) => table.rows.map((row) => `${row.cells[0] ?? ''}：${row.cells.slice(1).join(' ')}`))
    .join('\n');
  const recordLevelText = `${masked}\n${tableRowText}`;

  const retrievalDates = [...recordLevelText.matchAll(/检索日期\s*[：:]\s*(\d{4})-(\d{2})-(\d{2})/gu)].map(
    (match) => ({ value: `${match[1]}-${match[2]}-${match[3]}`, parts: match })
  );
  if (retrievalDates.length === 0) {
    reasons.push('缺少记录级字段「检索日期」（应写成 `检索日期：YYYY-MM-DD`）');
  } else {
    for (const item of retrievalDates) {
      if (!isRealDate(item.parts[1], item.parts[2], item.parts[3])) {
        reasons.push(`「检索日期」${item.value} 不是真实日历日期`);
      } else if (fileDate !== null && item.value !== fileDate) {
        reasons.push(`正文检索日期 ${item.value} 与文件名日期 ${fileDate} 不一致`);
      }
    }
  }

  if (!/检索方式\s*[：:]/u.test(recordLevelText) && !/检索词/u.test(recordLevelText)) {
    reasons.push('缺少记录级字段「检索方式／检索词原文」（未用检索词时须写"直接抓取官方页，未使用检索词"）');
  }

  const versionLines = [...masked.matchAll(/来源版本或提交\s*[：:]\s*([^\n]*)/gu)];
  const versionValueOk = (value) => STRONG_VERSION.test(value) || /未取得/u.test(value);
  const hasVersion =
    versionLines.length > 0 ? versionLines.some((match) => versionValueOk(match[1])) : STRONG_VERSION.test(masked);
  if (!hasVersion) {
    reasons.push(
      '缺少记录级字段「来源版本或提交」（须是 `v?\\d+\\.\\d+\\.\\d+`、40 位 SHA，或 commit／sha／tag 后的 7–40 位十六进制）'
    );
  }

  const fieldTables = tables.filter(isFieldTable);
  const sections = parseSections(lines);
  const technicalSections = sections.filter((section) => isTechnicalSection(section));
  const isComplete = technicalSections.length > 0 || fieldTables.length > 0;

  if (isComplete) {
    for (const section of technicalSections) {
      const { names, unexpected } = collectFields(lines, tables, section.line, section.end);
      reasons.push(...unexpected);
      const missing = TECHNICAL_FIELDS.filter((field) => !names.has(field));
      if (missing.length > 0) {
        reasons.push(`技术项「${section.title}」缺少字段：${missing.join('、')}`);
      }
      const keys = uniqueUrlKeys(lines.slice(section.index, section.end).join('\n'));
      if (keys.size < 2) {
        reasons.push(`技术项「${section.title}」的来源 URL 少于 2 条（去重后 ${keys.size} 条）`);
      }
    }
    for (const table of fieldTables) {
      const insideSection = technicalSections.some(
        (section) => table.startLine > section.line && table.startLine <= section.end
      );
      if (insideSection) continue;
      const { names, unexpected } = collectFields(lines, tables, table.startLine, table.endLine);
      reasons.push(...unexpected);
      const missing = TECHNICAL_FIELDS.filter((field) => !names.has(field));
      if (missing.length > 0) {
        reasons.push(`字段表（第 ${table.startLine} 行起）缺少：${missing.join('、')}`);
      }
    }
    const recordKeys = uniqueUrlKeys(masked);
    if (recordKeys.size < 2) {
      reasons.push(`来源 URL 少于 2 条互不相同的地址（去重后 ${recordKeys.size} 条）`);
    }
  } else {
    const recordKeys = uniqueUrlKeys(masked);
    if (recordKeys.size < 2) {
      reasons.push(`来源 URL 少于 2 条（去重后 ${recordKeys.size} 条）`);
    }
    inspectSourceTableRows(masked, lines, tables, (reason) => reasons.push(reason));
    if (!/决定/u.test(masked)) {
      reasons.push(
        '最短记录缺少「决定」（README §7：检索日期＋检索方式＋来源版本或提交＋≥2 来源＋决定＋理由）'
      );
    }
    if (!/理由/u.test(masked)) reasons.push('最短记录的「决定」缺少理由（README §7：只写结论不算记录）');
  }

  return reasons;
}

/** 读 allowlist；返回 { files, problems }，problems 为空表示清单本身可用。 */
function loadAllowlist(allowlistPath) {
  const problems = [];
  const files = new Map();
  if (!existsSync(allowlistPath)) return { files, problems };

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(allowlistPath, 'utf8'));
  } catch (error) {
    problems.push(`不是合法 JSON：${error.message}`);
    return { files, problems };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    problems.push('顶层必须是对象');
    return { files, problems };
  }
  if (parsed.hashMethod !== HASH_METHOD) {
    problems.push(`hashMethod 必须是 "${HASH_METHOD}"（实际 ${JSON.stringify(parsed.hashMethod)}）`);
  }
  const entries = parsed.files;
  if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) {
    problems.push('`files` 必须是对象');
    return { files, problems };
  }
  for (const [name, entry] of Object.entries(entries)) {
    if (!LEGACY_PATTERN.test(name)) {
      problems.push(`只允许登记基线既有的 gy-i03-* 历史文件（实际 "${name}"）——白名单不是新记录的后门`);
      continue;
    }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      problems.push(`files["${name}"] 必须是对象`);
      continue;
    }
    if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(entry.sha256)) {
      problems.push(`files["${name}"].sha256 必须是 64 位小写十六进制`);
      continue;
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
      problems.push(`files["${name}"].reason 必须写明"为什么它可以不按当前制度校验"`);
      continue;
    }
    files.set(name, entry);
  }
  return { files, problems };
}

function finish(code) {
  process.exit(code);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.some((item) => item.startsWith('-'))) {
    console.error(`未知选项：${argv.find((item) => item.startsWith('-'))}`);
    console.error(USAGE);
    finish(2);
  }
  if (argv.length > 1) {
    console.error(USAGE);
    finish(2);
  }

  const dirPath = argv.length === 1 ? resolve(argv[0]) : join(ROOT, DEFAULT_DIR);
  if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) {
    console.error(`目标目录不存在或不是目录：${dirPath}`);
    finish(2);
  }

  const names = readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();

  const hasReadme = names.includes(README_NAME);
  const records = names.filter((name) => name !== README_NAME && name !== ALLOWLIST_NAME);
  if (!hasReadme) {
    console.error(`${dirPath} 下没有 ${README_NAME}（制度文件缺失，无法判定校验口径）`);
    finish(2);
  }
  if (records.length === 0) {
    console.error(`${dirPath} 下没有任何研究记录（空目录不能被当作"全部通过"）`);
    finish(2);
  }

  const { files: allowlisted, problems: allowlistProblems } = loadAllowlist(join(dirPath, ALLOWLIST_NAME));
  const failures = [];
  const fail = (name, reasons) => failures.push({ name, reasons });
  if (allowlistProblems.length > 0) fail(ALLOWLIST_NAME, allowlistProblems);

  let passed = 0;
  let legacy = 0;
  for (const name of records) {
    const filePath = join(dirPath, name);
    if (!allowlisted.has(name)) {
      if (!NAME_PATTERN.test(name)) {
        fail(name, [
          '未登记的历史文件：docs/research 只允许 `YYYY-MM-DD-<主题>.md`；',
          '历史记录不得改写，请登记进 legacy-allowlist.json 并钉死 sha256'
        ]);
        continue;
      }
      const reasons = inspectRecord(filePath, name);
      if (reasons.length > 0) {
        fail(name, reasons);
        continue;
      }
      passed += 1;
      console.log(`PASS ${name}`);
      continue;
    }

    const entry = allowlisted.get(name);
    if (NAME_PATTERN.test(name)) {
      fail(name, ['legacy-allowlist.json 不得收容符合当前命名的记录（新记录必须按 README §3 校验）']);
      continue;
    }
    const actual = lfNormalizedSha256(readFileSync(filePath));
    if (actual !== entry.sha256) {
      fail(name, [
        '内容哈希与 legacy-allowlist.json 不一致（历史记录不得改写）',
        `  登记：${entry.sha256}`,
        `  实际：${actual}`
      ]);
      continue;
    }
    legacy += 1;
    console.log(`PASS ${name}（legacy 已钉住）`);
  }

  for (const name of allowlisted.keys()) {
    if (records.includes(name)) continue;
    if (failures.some((failure) => failure.name === ALLOWLIST_NAME)) continue;
    fail(ALLOWLIST_NAME, [`登记的文件不存在：${name}（白名单不得腐烂，请删除或补回文件）`]);
  }

  for (const failure of failures) {
    console.log(`FAIL ${failure.name}`);
    for (const reason of failure.reasons) console.log(`  - ${reason}`);
  }

  console.log(`研究记录校验：${passed} 通过 / ${failures.length} 失败 / ${legacy} legacy 已钉住`);
  if (failures.length > 0) {
    console.error(`FAIL docs/research 结构校验未通过（${failures.length} 个文件）`);
    finish(1);
  }
  console.log('PASS docs/research 结构校验：命名＋记录级四项＋按项来源＋技术七项＋legacy 钉住');
  finish(0);
}

main();
