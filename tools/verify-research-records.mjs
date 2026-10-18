/**
 * docs/research 机械结构看守
 * ------------------------------------------------------------
 * 用途：把 `docs/research/README.md` 的人工约定（命名、十项字段、来源）变成
 * **可复算的断言**，接在 `npm run test:docs` 的第二段。没有它 README 只是散文：
 * 少写一项「引入成本」、来源只写一条、检索日期只写在文件名里，人眼看不出，
 * CI 也不会红。
 *
 * 本脚本是**纯静态**校验：只读文件，不起服务、不联网、不写任何文件、零依赖。
 *
 * 判据（与 README §2／§3／§4 对应）：
 *  1) 文件名 `YYYY-MM-DD-<主题>.md`：日期必须是真实日历日期（2026-02-30 不算），
 *     主题只用小写字母／数字／连字符。
 *  2) 记录级四项：
 *     - `检索日期：YYYY-MM-DD`，且与**文件名日期一致**（README §2 把日期定义为
 *       实际检索当天，两处写不一样说明至少有一处是事后补的）；
 *     - `检索方式：` 或 `检索词` 出现（README §4：未用检索词时必须写明直接抓取）；
 *     - ≥2 条**互不相同**的 http(s) 来源 URL（README 要求本轮实抓，不得用记忆替代）；
 *     - 来源版本或提交：`来源版本或提交：` 行，或正文出现版本号 `x.y.z`／7 位以上
 *       十六进制 SHA（README §3 允许把它写在「现用版本（证据命令）」里）。
 *  3) 技术七项：若正文含"字段表"，则表体每一行首列字段名必须逐字属于七项之一，
 *     且七项齐全。"字段表"的识别是 `表头含「字段」＋「含义」` 或 `表体首列出现「现用版本…」`——
 *     只认这两种，是为了不把「技术｜仓库现用｜上游状态｜决定｜来源数」这类总览表、
 *     「#｜URL｜本轮读数」这类来源表误判成字段表。README §7 允许内部工具片只写
 *     **最短记录**（无技术表）⇒ 没有字段表就**不做**此断言，否则会逼着工具片滥竽充数。
 *  4) `未取得` 是 README §3 明文允许的取值（查不到就写未取得，不得用记忆替代），
 *     本脚本**不作失败**判定。
 *  5) 历史文件（R10 制度之前落地的 `gy-i03-*`）只能登记进 `legacy-allowlist.json`
 *     并钉死内容哈希：未登记的历史文件、登记了却已不存在的文件、哈希对不上的文件
 *     ⇒ 全部失败。历史记录不得改写，只有登记与钉住这一条路。
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

/** 抽 http(s) URL，去掉正文/表格里紧贴 URL 的收尾标点，去重。 */
function extractUrls(text) {
  const found = new Set();
  for (const match of text.matchAll(/https?:\/\/[^\s<>()[\]()（）【】"'`，。；：、]+/gu)) {
    let url = match[0];
    while (url.length > 0 && '.,;:!?'.includes(url[url.length - 1])) url = url.slice(0, -1);
    if (url.length > 0) found.add(url);
  }
  return [...found];
}

/** 切表格行；`\|` 视为转义，不切。 */
function splitCells(line) {
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
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

const isTableLine = (line) => /^\s*\|/.test(line);
const isSeparatorLine = (line) => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line);

/** 找 markdown 表格（表头行 ＋ 分隔行 ＋ 表体），记录表体各行的行号。 */
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
    tables.push({ startLine: index + 1, header: splitCells(lines[index]), rows });
    index = cursor - 1;
  }
  return tables;
}

/** 字段名归一：去首尾装饰，去尾部 `（…）` / `(…)` 括注。 */
function normalizeFieldName(cell) {
  return cell
    .trim()
    .replace(/^[*`\s]+/, '')
    .replace(/[*`\s]+$/, '')
    .replace(/（[^）]*）\s*$/u, '')
    .replace(/\([^)]*\)\s*$/, '')
    .trim();
}

function isFieldTable(table) {
  const headerText = table.header.join(' ');
  if (headerText.includes('字段') && headerText.includes('含义')) return true;
  return table.rows.some((row) => normalizeFieldName(row.cells[0] ?? '').startsWith('现用版本'));
}

/** 校验一条记录的全部判据，返回失败原因列表（空数组＝通过）。 */
function inspectRecord(filePath, fileName) {
  const reasons = [];
  const nameMatch = /^(\d{4})-(\d{2})-(\d{2})-/.exec(fileName);
  let fileDate = null;
  if (!nameMatch) {
    reasons.push('文件名不符合 `YYYY-MM-DD-<主题>.md`（主题只用小写字母／数字／连字符）');
  } else if (!isRealDate(nameMatch[1], nameMatch[2], nameMatch[3])) {
    reasons.push(`文件名日期 ${nameMatch[1]}-${nameMatch[2]}-${nameMatch[3]} 不是真实日历日期`);
  } else {
    fileDate = `${nameMatch[1]}-${nameMatch[2]}-${nameMatch[3]}`;
  }

  const text = readFileSync(filePath, 'utf8');

  const retrievalDates = [...text.matchAll(/检索日期\s*[：:]\s*(\d{4})-(\d{2})-(\d{2})/gu)].map(
    (match) => ({ raw: match[0], value: `${match[1]}-${match[2]}-${match[3]}`, parts: match })
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

  if (!/检索方式\s*[：:]/u.test(text) && !/检索词/u.test(text)) {
    reasons.push('缺少记录级字段「检索方式／检索词原文」（未用检索词时须写"直接抓取官方页，未使用检索词"）');
  }

  const urls = extractUrls(text);
  if (urls.length < 2) {
    reasons.push(`来源 URL 少于 2 条互不相同的 http(s) 地址（实际 ${urls.length} 条）`);
  }

  const hasVersionLine = /来源版本或提交\s*[：:]\s*\S/u.test(text);
  const hasVersionNumber = /\b\d+\.\d+\.\d+\b/u.test(text);
  const hasCommitLike = /\b[0-9a-f]{7,40}\b/u.test(text);
  if (!hasVersionLine && !hasVersionNumber && !hasCommitLike) {
    reasons.push('缺少记录级字段「来源版本或提交」（版本号／commit 或 tag SHA）');
  }

  const lines = text.split(/\r?\n/u);
  const fieldTables = parseTables(lines).filter(isFieldTable);
  for (const table of fieldTables) {
    const seen = new Set();
    const unexpected = [];
    for (const row of table.rows) {
      const name = normalizeFieldName(row.cells[0] ?? '');
      if (!TECHNICAL_FIELDS.includes(name)) {
        unexpected.push(`第 ${row.line} 行字段「${name || '（空）'}」不是技术七项之一`);
      } else {
        seen.add(name);
      }
    }
    const missing = TECHNICAL_FIELDS.filter((field) => !seen.has(field));
    if (unexpected.length > 0) reasons.push(...unexpected);
    if (missing.length > 0) {
      reasons.push(`技术字段表（第 ${table.startLine} 行起）缺少：${missing.join('、')}`);
    }
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

  const { files: allowlisted, problems: allowlistProblems } = loadAllowlist(
    join(dirPath, ALLOWLIST_NAME)
  );
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
  console.log(`PASS docs/research 结构校验：命名＋记录级四项＋技术七项＋legacy 钉住`);
  finish(0);
}

main();
