#!/usr/bin/env node
/**
 * 证据页读数闸门：`docs/verification/*.md` 里声明的 failmatrix 读数必须**内部算术自洽**，
 * 引旧基线时必须与旧页那一行的数字**逐字相同**。
 *
 * 为什么要有这个工具：`same 180` 改成 `179` 这种改动，写行号闸门（`verify-doc-anchors`）、
 * 契约闸门（`verify-contract-status`）、`npm run test:docs` 全都照样 exit 0——它们只核
 * 「引用指得到」，不核「读数对不对」。本工具只做读数自身的算术，不猜业务口径：
 * `total` / `same` / `sameWithCheck` / `sameWithShape` / `sameWithEither` / `sameWithNeither` /
 * `different` / `notRunnable` 之间的关系是恒等式，谁把它们改成不自洽，谁就红。
 *
 * 六条判据（缺一条就有一类手改能溜过去）：
 *   ① 总量恒等：`total === same + different + notRunnable`。
 *   ② 判据强度分解：`same === sameWithCheck + sameWithShape + sameWithNeither`（三者同页出现时）；
 *      `sameWithEither === sameWithCheck + sameWithShape`。
 *   ③ 对照组不重复计数：`sameWithCheck + sameWithShape − sameWithEither` 就是「既 check 又 shape」的条数；
 *      页里给了 `both` 就核它，没给就只打印算出来的数（不判红，因为 0 与 unspecified 都合法）。
 *   ④ 逐族加总 = 总量：族表每一列（total/same/check/shape/neither/different/nr）的族值之和
 *      必须等于同页总量那一列；族表带「合计」行时也核「族之和 = 合计」。
 *   ⑤ 对照表增量自洽：有「旧 → 新 → Δ」三列的，`Δ === 新 − 旧`；同页对同一基线（同一份
 *      `docs/verification/<file>.md:<line>`）给出的旧值必须前后一致。
 *   ⑥ 跨页基线一致：页里写「旧基线来自 `docs/verification/<file>.md:<line>`」并在同一句里给了
 *      数字的，就去读那个文件那一行，逐字比对；文件读不到、行号越界、行里没有数字 ⇒ 直接 FAIL。
 *
 * 识别口径（只认 failmatrix 读数，纯日志页一律跳过，不误伤）：
 *   `kv`      一行里 `total=<n>` 且 `same=<n>`（如 `total=180 same=162 ... notRunnable=13`）；
 *   `table`   表头含 条数/total + same + different/not runnable 的普通读数表；
 *   `transposed` 首列是字段名、后面是「本轮 / 旧基线（ref）/ 差」的表（R87 那种对照表）；
 *   `prose`   `180 条 = same 161 / different 3 / not runnable 16` 这种一句话读数；
 *   `sixkeys` 一行里既有 `total / same / sameWithCheck / ...` 的键名清单、又有等长的 `**a / b / ...**` 序列。
 *   页内一条读数都识别不出来 ⇒ 跳过（不算红）。识别出来了但解析不出数字 ⇒ WARN，不静默。
 *
 * 族三元组口径：`C1 37（37/0/0）` / `C1=37(37/0/0)`（failmatrix 合计行的原生形状）按
 * `total（same/different/notRunnable）` 解读。这一条是工具写死的约定，因为它是 run.mjs 合计行
 * 的固定顺序；若某页的口径不同，请在页内写一行图例 `族三元组口径：same/check/shape`
 * （`/` 分隔的字段名），工具会按图例走。
 *
 * 用法：
 *   node tools/verify-reading-pages.mjs                       # 扫 docs/verification
 *   node tools/verify-reading-pages.mjs --scan docs/verification --verbose
 *   node tools/verify-reading-pages.mjs --root <目录>          # 换根（单测夹具用）
 * 输出：逐条 `FAIL: <path>:<line> <原因>`，末行 `PASS: …` / `FAIL: …`，exit 0/1。
 * 只用 node 内置模块；判据函数全部导出，单测直接调 `main()`（可注入 streams，见
 * `tests/unit/verify-reading-pages.test.mjs`）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 仓库根：由本文件位置推出（tools/ → ..），⛔ 不用 `process.cwd()`（与仓内其它闸门同口径）。 */
export const TOOL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 默认扫描面。 */
export const DEFAULT_SCAN = 'docs/verification';

/** 判据编号 → 原因标签，FAIL 行里原样打印，便于按类统计。 */
export const REASONS = {
  TOTAL_IDENTITY: 'TOTAL_IDENTITY',
  SAME_BREAKDOWN: 'SAME_BREAKDOWN',
  EITHER_BREAKDOWN: 'EITHER_BREAKDOWN',
  BOTH_MISMATCH: 'BOTH_MISMATCH',
  FAMILY_SUM: 'FAMILY_SUM',
  DELTA_MISMATCH: 'DELTA_MISMATCH',
  BASELINE_CONFLICT: 'BASELINE_CONFLICT',
  CROSS_PAGE_MISMATCH: 'CROSS_PAGE_MISMATCH',
  CROSS_PAGE_UNREADABLE: 'CROSS_PAGE_UNREADABLE',
  READING_UNREADABLE: 'READING_UNREADABLE',
};

/** 字段的规范顺序：跨页/Δ 比对都按这个顺序走，保证「逐字」是可复现的。 */
const FIELD_ORDER = ['total', 'same', 'check', 'shape', 'either', 'neither', 'different', 'nr', 'both'];

/** 字段 → 页面里的原样名字（打印用）。 */
const FIELD_LABEL = {
  total: 'total',
  same: 'same',
  check: 'sameWithCheck',
  shape: 'sameWithShape',
  either: 'sameWithEither',
  neither: 'sameWithNeither',
  different: 'different',
  nr: 'notRunnable',
  both: 'both',
};

const label = field => FIELD_LABEL[field] ?? field;

/** 表头/单元格文本归一：去反引号、星号、下划线，压空白，转小写。 */
function normalizeLabel(raw) {
  return String(raw ?? '')
    .replace(/[`*]/g, '')
    .replace(/\u00a0/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** 列名 / 字段名 → 规范字段。认不出来的返回 null（不猜）。 */
const ALIASES = new Map([
  ['total', 'total'],
  ['条数', 'total'],
  ['总数', 'total'],
  ['合计', 'total'],
  ['总计', 'total'],
  ['same', 'same'],
  ['samewithcheck', 'check'],
  ['samewithshape', 'shape'],
  ['samewitheither', 'either'],
  ['samewithneither', 'neither'],
  ['二者皆无', 'neither'],
  ['皆无', 'neither'],
  ['different', 'different'],
  ['diff', 'different'],
  ['不同', 'different'],
  ['notrunnable', 'nr'],
  ['not runnable', 'nr'],
  ['not_runnable', 'nr'],
  ['nr', 'nr'],
  ['notrunable', 'nr'],
  ['不可跑', 'nr'],
  ['不可运行', 'nr'],
  ['both', 'both'],
  ['samewithboth', 'both'],
]);

export function canonicalField(raw) {
  const text = normalizeLabel(raw).replace(/[：:]/g, '').trim();
  if (text === '') return null;
  const direct = ALIASES.get(text);
  if (direct !== undefined) return direct;
  // 「二者皆无（sameWithNeither）」这类「中文标签 + 括号里的字段名」。
  const inner = /[（(]([^）)]+)[）)]/.exec(text);
  if (inner !== null) {
    const byInner = ALIASES.get(normalizeLabel(inner[1]).replace(/[：:]/g, '').trim());
    if (byInner !== undefined) return byInner;
  }
  return null;
}

/**
 * 单元格取整：只认「整行就是一个整数 + 可选括注」。
 * `13（fixture 8 / domain-unavailable 5）` ⇒ 13；`+18` / `−5`（U+2212）⇒ 正负号保留；
 * `249 PASS` / `19 check + 27 同形 = 46` ⇒ undefined（复合文本不当成读数，宁可不判也不乱判）。
 */
export function parseCellInt(raw) {
  const text = String(raw ?? '')
    .replace(/[`*]/g, '')
    .trim();
  if (text === '' || text === '—' || text === '–' || text === '-' || text === 'n/a') return undefined;
  const matched = /^([+\-−]?\d+)\s*(?:[（(].*)?$/.exec(text);
  if (matched === null) return undefined;
  return Number(matched[1].replace('−', '-'));
}

/** 行内所有整数（跨页兜底比对用：目标行没有结构化读数时按顺序找数）。 */
export function lineInts(text) {
  return [...String(text).matchAll(/-?\d+/g)].map(m => Number(m[0]));
}

/** 拆一行 markdown 表格（`\|` 不当分隔符）。 */
function splitRow(line) {
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return body.split(/(?<!\\)\|/).map(cell => cell.replace(/\\\|/g, '|').trim());
}

function isTableRow(line) {
  return /^\s*\|/.test(line);
}

function isSeparatorRow(line) {
  return /^\s*\|[\s:|-]+\|?\s*$/.test(line) && line.includes('-');
}

/** 收集 md 表格：表头行 + 数据行（带 1-based 行号）。 */
export function collectTables(lines) {
  const tables = [];
  for (let i = 0; i < lines.length - 1; i += 1) {
    if (!isTableRow(lines[i]) || !isSeparatorRow(lines[i + 1])) continue;
    const rows = [];
    let j = i + 2;
    while (j < lines.length && isTableRow(lines[j]) && !isSeparatorRow(lines[j])) {
      rows.push({ line: j + 1, cells: splitRow(lines[j]) });
      j += 1;
    }
    tables.push({ headerLine: i + 1, header: splitRow(lines[i]), rows });
    i = j - 1;
  }
  return tables;
}

/** 一行里的 `key=value` 读数（`total=` 与 `same=` 至少同时出现才算）。 */
export function extractKvFields(line) {
  const fields = {};
  let any = false;
  for (const matched of String(line).matchAll(/\b([A-Za-z][A-Za-z0-9_]*)\s*=\s*(-?\d+)\b/g)) {
    const field = canonicalField(matched[1]);
    if (field === null) continue;
    if (fields[field] !== undefined) continue;
    fields[field] = Number(matched[2]);
    any = true;
  }
  if (!any) return null;
  if (fields.total === undefined || fields.same === undefined) return null;
  return fields;
}

/**
 * 一句话读数：`180 条 = same 161 / different 3 / not runnable 16`。
 * 一行里可能并列多组（旧读数 + 本页读数），按「下一个 total 起点」切开，返回带偏移的多组。
 */
export function extractProseGroups(line) {
  const text = String(line);
  const matches = [...text.matchAll(/(\d+)\s*条?\s*=\s*same\s+(\d+)/g)];
  const groups = [];
  for (let i = 0; i < matches.length; i += 1) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const segment = text.slice(start, end);
    const fields = { total: Number(matches[i][1]), same: Number(matches[i][2]) };
    const different = /different\s+(\d+)/.exec(segment);
    if (different !== null) fields.different = Number(different[1]);
    const nr = /not[ _]runnable\s+(\d+)/i.exec(segment);
    if (nr !== null) fields.nr = Number(nr[1]);
    groups.push({ index: start, fields });
  }
  return groups;
}

const REF_RE = /docs\/verification\/([A-Za-z0-9._-]+\.md):(\d+)(?:[-–](\d+))?/g;
const SHORT_REF_RE = /`:(?<start>\d+)(?:[-–](?<end>\d+))?`/g;

/**
 * 一行里的跨页引用：完整路径 `docs/verification/x.md:8`，以及紧跟在后面的简写 `:17-18`
 * （简写继承本行最近一个完整路径）。返回带字符偏移，便于切「同一句」的窗口。
 */
export function extractRefs(line) {
  const text = String(line);
  const refs = [];
  let lastPath = null;
  for (const matched of text.matchAll(REF_RE)) {
    lastPath = `docs/verification/${matched[1]}`;
    refs.push({
      path: lastPath,
      start: Number(matched[2]),
      end: Number(matched[3] ?? matched[2]),
      index: matched.index,
      raw: matched[0],
    });
  }
  if (lastPath !== null) {
    for (const matched of text.matchAll(SHORT_REF_RE)) {
      refs.push({
        path: lastPath,
        start: Number(matched.groups.start),
        end: Number(matched.groups.end ?? matched.groups.start),
        index: matched.index,
        raw: matched[0],
      });
    }
  }
  refs.sort((a, b) => a.index - b.index);
  return refs;
}

/** 引用后面「同一句」的窗口：到下一个 `。` 为止（`；` 不切，读数常写成 `A；B`）。 */
function sentenceWindow(line, from) {
  const text = String(line);
  const stop = text.indexOf('。', from);
  return text.slice(from, stop < 0 ? text.length : stop);
}

/** `旧基线（\`docs/...md:18\`：total/same/diff/nr）` 里 `/` 分隔的字段清单。 */
export function baselineFieldList(raw) {
  const text = String(raw ?? '');
  const paren = /[（(]([^）)]*)[）)]/.exec(text);
  const body = paren === null ? text : paren[1];
  const tail = /[：:]([^：:]*)$/.exec(body);
  const list = (tail === null ? body : tail[1])
    .split('/')
    .map(part => part.trim())
    .filter(part => part !== '');
  if (list.length < 2) return null;
  const fields = list.map(part => canonicalField(part));
  if (fields.some(field => field === null)) return null;
  return fields;
}

/** 把一页拆成「读数记录 / 族记录 / 跨页引用 / 箭头对 / 备注」。 */
export function extractPage(relPath, text) {
  const lines = String(text).split('\n');
  const records = [];
  const families = [];
  const refs = [];
  const arrows = [];
  const notes = [];

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;

    const kv = extractKvFields(line);
    if (kv !== null) records.push({ path: relPath, line: lineNo, source: 'kv', fields: kv });

    for (const group of extractProseGroups(line)) {
      if (group.fields.different !== undefined || group.fields.nr !== undefined) {
        records.push({ path: relPath, line: lineNo, source: 'prose', fields: group.fields });
      }
    }

    // 六键裸序列：键名清单在代码段里、读数在 `**a / b / ...**` 里。
    const boldSequence = /\*\*\s*(\d+(?:\s*\/\s*\d+){2,})\s*\*\*/.exec(line);
    if (boldSequence !== null) {
      for (const span of line.matchAll(/`([^`]*)`/g)) {
        const tokens = span[1].split('/').map(part => part.trim());
        if (tokens.length < 4) continue;
        const fields = tokens.map(token => canonicalField(token));
        const values = boldSequence[1].split('/').map(part => Number(part.trim()));
        if (fields.some(field => field === null) || fields.length !== values.length) {
          notes.push({ line: lineNo, msg: `六键裸序列（${values.length} 个数）与键名清单（${tokens.length} 个键）对不上，未判` });
          continue;
        }
        const record = {};
        fields.forEach((field, at) => {
          record[field] = values[at];
        });
        records.push({ path: relPath, line: lineNo, source: 'sixkeys', fields: record });
      }
    }

    // 族三元组 / 族单值。
    const legend = /族三元组口径[：:]\s*([A-Za-z0-9/_ ]+)/.exec(line);
    const tripleFields = legend === null
      ? ['same', 'different', 'nr']
      : legend[1].split('/').map(part => canonicalField(part)).filter(field => field !== null);

    for (const matched of line.matchAll(/(C\d+)\s*=(?!=)\s*(\d+)\s*[（(]\s*(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)\s*[)）]/g)) {
      const fields = { total: Number(matched[2]) };
      tripleFields.slice(0, 3).forEach((field, at) => {
        fields[field] = Number(matched[3 + at]);
      });
      families.push({ path: relPath, line: lineNo, group: `line:${lineNo}`, family: matched[1], fields });
    }
    for (const matched of line.matchAll(/(C\d+)\s+(\d+)\s*[（(]\s*(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)\s*[)）]/g)) {
      const fields = { total: Number(matched[2]) };
      tripleFields.slice(0, 3).forEach((field, at) => {
        fields[field] = Number(matched[3 + at]);
      });
      families.push({ path: relPath, line: lineNo, group: `line:${lineNo}`, family: matched[1], fields });
    }
    // `C1 37 · C2 24 · ...`（没有括注的单值族分布）。
    for (const matched of line.matchAll(/(C\d+)\s+(\d+)(?!\d)(?!\s*[（(])(?!\s*\/)/g)) {
      families.push({ path: relPath, line: lineNo, group: `line:${lineNo}`, family: matched[1], fields: { total: Number(matched[2]) } });
    }

    // 旧 → 新（无 Δ 列）的箭头对。
    for (const matched of line.matchAll(/([A-Za-z][A-Za-z0-9]*)\s+(\d+)\s*(?:→|->|⇒)\s*(\d+)/g)) {
      const field = canonicalField(matched[1]);
      if (field === null) continue;
      arrows.push({ path: relPath, line: lineNo, field, old: Number(matched[2]), next: Number(matched[3]) });
    }

    for (const ref of extractRefs(line)) {
      const quoted = extractKvFields(sentenceWindow(line, ref.index + ref.raw.length));
      const prose = extractProseGroups(sentenceWindow(line, ref.index + ref.raw.length))
        .find(group => group.fields.different !== undefined || group.fields.nr !== undefined);
      refs.push({
        path: relPath,
        line: lineNo,
        index: ref.index,
        target: ref.path,
        start: ref.start,
        end: ref.end,
        quoted: quoted ?? (prose === undefined ? null : prose.fields),
      });
    }
  });

  return { path: relPath, lines, records, families, refs, arrows, notes };
}

/** 表格列分类：字段列 / 「本轮」列 / 「旧基线」列（带 ref）/ 「差」列 / 其它。 */
export function classifyColumns(header) {
  return header.map((raw, idx) => {
    const text = String(raw ?? '');
    const field = canonicalField(text);
    if (field !== null) return { idx, text, role: 'field', field };
    if (/差|delta|Δ|δ|增量/i.test(text)) return { idx, text, role: 'delta' };
    if (/本轮|本次|当前|\bnew\b|\bnow\b|after/i.test(text)) return { idx, text, role: 'current' };
    const refs = extractRefs(text);
    if (refs.length > 0 || /旧|基线|previous|\bold\b|before/i.test(text)) {
      return { idx, text, role: 'baseline', ref: refs[0] ?? null, fieldList: baselineFieldList(text) };
    }
    if (idx === 0) return { idx, text, role: 'label' };
    return { idx, text, role: 'other' };
  });
}

const FAMILY_LABELS = new Set(['族', 'family', '分组']);

/** 表格 → 记录：普通读数表、换位对照表、族表。 */
export function extractTableRecords(page, table) {
  const records = [];
  const families = [];
  const groups = [];
  const notes = [];
  const columns = classifyColumns(table.header);
  const fieldColumns = columns.filter(column => column.role === 'field');
  const baselineColumns = columns.filter(column => column.role === 'baseline');
  const hasTotals = fieldColumns.some(column => column.field === 'total') && fieldColumns.some(column => column.field === 'same');
  const isFamilyTable = FAMILY_LABELS.has(normalizeLabel(table.header[0])) && hasTotals;

  const collectFields = row => {
    const fields = {};
    for (const column of fieldColumns) {
      const value = parseCellInt(row.cells[column.idx]);
      if (value !== undefined) fields[column.field] = value;
    }
    return fields;
  };

  /**
   * 「旧基线」列：族表按族名记一串数（总数 + 三元组，字段清单见表头），
   * 换位表按字段名记一个数。记录形状与读数记录分开，消费方见 main。
   */
  const collectBaselines = (row, family) => {
    for (const column of baselineColumns) {
      const values = lineInts(row.cells[column.idx] ?? '');
      if (values.length === 0) continue;
      records.push({
        path: page,
        line: row.line,
        source: 'baseline',
        baseline: {
          columnKey: column.ref === null ? `${page}:col${column.idx}@${table.headerLine}` : `${column.ref.path}:${column.ref.start}`,
          ref: column.ref,
          fieldList: column.fieldList,
          family,
          field: family === null ? canonicalField(row.cells[0]) : null,
          value: values[0],
          values,
        },
      });
    }
  };

  if (isFamilyTable) {
    for (const row of table.rows) {
      const label0 = String(row.cells[0] ?? '').replace(/[`*]/g, '').trim();
      const name = normalizeLabel(label0);
      const fields = collectFields(row);
      if (Object.keys(fields).length === 0) {
        notes.push({ line: row.line, msg: `族行「${label0 || '空'}」一个数字都没解析出来，未判` });
        continue;
      }
      if (name === '合计' || name === '总计' || name === 'total') {
        records.push({ path: page, line: row.line, source: 'table-total', fields });
        groups.push({ path: page, line: row.line, group: `table:${table.headerLine}`, sumRow: fields });
        // 合计行的「旧基线」列是各列之和，族行已逐族核过，这里不重复核（否则会把 180 当某一族的旧值）。
        continue;
      }
      families.push({ path: page, line: row.line, group: `table:${table.headerLine}`, family: label0, fields });
      collectBaselines(row, label0);
    }
    return { records, families, groups, notes };
  }

  if (hasTotals) {
    for (const row of table.rows) {
      const fields = collectFields(row);
      if (fields.total === undefined || fields.same === undefined) {
        notes.push({ line: row.line, msg: '读数表这一行取不出 total/same（复合文本或占位符），未判' });
        continue;
      }
      records.push({ path: page, line: row.line, source: 'table', fields });
      collectBaselines(row, null);
    }
    return { records, families, groups, notes };
  }

  // 换位表：首列是字段名，其余列是「本轮 / 旧基线 / 差」。
  const transposed = table.rows.some(row => canonicalField(row.cells[0]) !== null);
  if (transposed) {
    const current = {};
    const deltas = [];
    const baselines = [];
    for (const row of table.rows) {
      const field = canonicalField(row.cells[0]);
      if (field === null) continue;
      for (const column of columns) {
        if (column.role === 'label' || column.idx === 0) continue;
        const value = parseCellInt(row.cells[column.idx]);
        if (value === undefined) continue;
        if (column.role === 'current') current[field] = value;
        else if (column.role === 'delta') deltas.push({ row, field, delta: value, column });
        else if (column.role === 'baseline') baselines.push({ row, field, value, column });
      }
    }
    if (Object.keys(current).length > 0) {
      records.push({ path: page, line: table.headerLine, source: 'table-transposed', fields: current });
    }
    for (const item of deltas) {
      const base = baselines.find(candidate => candidate.field === item.field);
      if (base === undefined) continue;
      if (current[item.field] === undefined) continue;
      const expected = current[item.field] - base.value;
      if (item.delta !== expected) {
        records.push({
          path: page,
          line: item.row.line,
          source: 'delta',
          mismatch: { field: item.field, delta: item.delta, next: current[item.field], previous: base.value, expected },
        });
      }
    }
    for (const item of baselines) {
      records.push({
        path: page,
        line: item.row.line,
        source: 'baseline',
        baseline: {
          columnKey: item.column.ref === null ? `${page}:col${item.column.idx}@${table.headerLine}` : `${item.column.ref.path}:${item.column.ref.start}`,
          ref: item.column.ref ?? null,
          fieldList: item.column.fieldList ?? null,
          family: null,
          field: item.field,
          value: item.value,
          values: [item.value],
        },
      });
    }
  }
  return { records, families, groups, notes };
}

/** 取一页的「权威总量」：kv > 普通表 > 换位表 > 六键 > 散文。 */
export function pickAuthoritative(records) {
  const priority = ['kv', 'table', 'table-total', 'table-transposed', 'sixkeys', 'prose'];
  for (const source of priority) {
    const candidates = records.filter(record => record.source === source && record.fields !== undefined);
    if (candidates.length === 0) continue;
    candidates.sort((a, b) => Object.keys(b.fields).length - Object.keys(a.fields).length || a.line - b.line);
    return candidates[0];
  }
  return null;
}

/** 判据 ①②③：单条读数的算术。 */
export function checkRecordArithmetic(record, report) {
  const findings = [];
  const { fields } = record;
  const fail = (reason, detail) => findings.push({ path: record.path, line: record.line, reason, detail });

  if ([fields.total, fields.same, fields.different, fields.nr].every(value => value !== undefined)) {
    const sum = fields.same + fields.different + fields.nr;
    if (sum !== fields.total) {
      fail(REASONS.TOTAL_IDENTITY, `总量不守恒：total ${fields.total} ≠ same ${fields.same} + different ${fields.different} + notRunnable ${fields.nr}（三项合计 ${sum}，差 ${fields.total - sum}）`);
    }
  }

  if ([fields.same, fields.check, fields.shape, fields.neither].every(value => value !== undefined)) {
    const sum = fields.check + fields.shape + fields.neither;
    if (sum !== fields.same) {
      fail(REASONS.SAME_BREAKDOWN, `same 分解不成立：same ${fields.same} ≠ sameWithCheck ${fields.check} + sameWithShape ${fields.shape} + sameWithNeither ${fields.neither}（三项合计 ${sum}，差 ${fields.same - sum}）`);
    }
  } else if ([fields.same, fields.check, fields.shape].every(value => value !== undefined)) {
    const derived = fields.same - fields.check - fields.shape;
    if (derived < 0) {
      fail(REASONS.SAME_BREAKDOWN, `same 分解不成立：same ${fields.same} < sameWithCheck ${fields.check} + sameWithShape ${fields.shape}（派生 sameWithNeither 为负 ${derived}）`);
    } else if (report !== null) {
      report.push(`INFO: ${record.path}:${record.line} sameWithNeither 未给出，派生 ${derived}（= same ${fields.same} − ${fields.check} − ${fields.shape}）`);
    }
  }

  if ([fields.either, fields.check, fields.shape].every(value => value !== undefined)) {
    const sum = fields.check + fields.shape;
    if (fields.either !== sum) {
      fail(REASONS.EITHER_BREAKDOWN, `sameWithEither 分解不成立：sameWithEither ${fields.either} ≠ sameWithCheck ${fields.check} + sameWithShape ${fields.shape}（合计 ${sum}，差 ${fields.either - sum}）`);
    }
    const both = fields.check + fields.shape - fields.either;
    if (fields.both !== undefined) {
      if (fields.both !== both) {
        fail(REASONS.BOTH_MISMATCH, `对照组重复计数：both ${fields.both} ≠ sameWithCheck ${fields.check} + sameWithShape ${fields.shape} − sameWithEither ${fields.either} = ${both}`);
      }
    } else if (report !== null) {
      report.push(`INFO: ${record.path}:${record.line} both 未给出，算出 ${both}（= sameWithCheck ${fields.check} + sameWithShape ${fields.shape} − sameWithEither ${fields.either}）`);
    }
  } else if (report !== null && [fields.check, fields.shape].every(value => value !== undefined)) {
    report.push(`INFO: ${record.path}:${record.line} both 与 sameWithEither 都未给出 ⇒ 「既 check 又 shape」只能确认落在 0..${Math.min(fields.check, fields.shape)}，不判红`);
  }

  return findings;
}

/** 判据 ④：族表逐列加总 = 权威总量。 */
export function checkFamilySums(page, families, groups, authoritative, report) {
  const findings = [];
  const byGroup = new Map();
  for (const family of families) {
    if (!byGroup.has(family.group)) byGroup.set(family.group, []);
    byGroup.get(family.group).push(family);
  }
  const sumRows = new Map(groups.map(group => [group.group, group.sumRow]));

  for (const [group, list] of byGroup) {
    const baseline = sumRows.get(group) ?? (authoritative === null ? null : authoritative.fields);
    if (baseline === null) {
      if (report !== null) report.push(`WARN: ${page} 族表 ${group} 有族值但没有可比的总量（同页没有读数总量），只打印不加总`);
      continue;
    }
    for (const field of FIELD_ORDER) {
      const withField = list.filter(family => family.fields[field] !== undefined);
      if (withField.length === 0) continue;
      if (withField.length !== list.length) {
        if (report !== null) report.push(`WARN: ${page} 族表 ${group} 只有 ${withField.length}/${list.length} 个族给了 ${label(field)}，按给出的族加总`);
      }
      const sum = withField.reduce((total, family) => total + family.fields[field], 0);
      if (baseline[field] === undefined) continue;
      if (sum !== baseline[field]) {
        const detail = `${label(field)} 列族值之和 ${sum} ≠ 总量 ${baseline[field]}（差 ${sum - baseline[field]}；${withField.map(family => `${family.family} ${family.fields[field]}`).join(' · ')}）`;
        findings.push({ path: page, line: withField[0].line, reason: REASONS.FAMILY_SUM, detail });
      }
    }
  }
  return findings;
}

/** 判据 ⑤：同一基线的旧值不许前后冲突。 */
export function checkBaselineConflicts(baselines, report) {
  const findings = [];
  const seen = new Map();
  for (const item of baselines) {
    if (item.field === null) continue;
    const key = `${item.columnKey}::${item.field}`;
    if (!seen.has(key)) {
      seen.set(key, item);
      continue;
    }
    const first = seen.get(key);
    if (first.value !== item.value) {
      findings.push({
        path: item.path,
        line: item.line,
        reason: REASONS.BASELINE_CONFLICT,
        detail: `同一基线（${item.columnKey}）的 ${label(item.field)} 旧值前后冲突：${first.path}:${first.line} 记 ${first.value}，本行记 ${item.value}`,
      });
    }
  }
  return findings;
}

/** 判据 ⑤：Δ 列 = 新 − 旧。 */
export function checkDeltas(deltas) {
  return deltas
    .filter(item => item.mismatch !== undefined)
    .map(item => ({
      path: item.path,
      line: item.line,
      reason: REASONS.DELTA_MISMATCH,
      detail: `差列不自洽：${label(item.mismatch.field)} Δ ${item.mismatch.delta} ≠ 新 ${item.mismatch.next} − 旧 ${item.mismatch.previous}（= ${item.mismatch.expected}，差 ${item.mismatch.delta - item.mismatch.expected}）`,
    }));
}

/**
 * 判据 ⑥：把「引用里写的数字」与「被引那一行的数字」逐字比。
 * 优先用目标行自身的结构化读数（kv / 一句话读数）按字段比；目标行没有结构化读数时，
 * 按字段顺序在那行的数字里找（顺序子序列），找不到就红。
 */
export function compareQuotedToLine(quoted, targetLine) {
  const kv = extractKvFields(targetLine);
  const prose = extractProseGroups(targetLine).find(group => group.fields.different !== undefined || group.fields.nr !== undefined);
  const structured = kv ?? prose?.fields ?? null;
  if (structured !== null) {
    for (const field of FIELD_ORDER) {
      if (quoted[field] === undefined) continue;
      if (structured[field] === undefined) continue;
      if (structured[field] !== quoted[field]) {
        return { ok: false, detail: `${label(field)} 被引行记 ${structured[field]}，本页引用 ${quoted[field]}` };
      }
    }
    return { ok: true };
  }
  const ints = lineInts(targetLine);
  if (ints.length === 0) return { ok: false, unreadable: true };
  let cursor = 0;
  for (const field of FIELD_ORDER) {
    if (quoted[field] === undefined) continue;
    const at = ints.indexOf(quoted[field], cursor);
    if (at < 0) {
      return { ok: false, detail: `${label(field)} 引用值 ${quoted[field]} 不在被引行的数字里（该行数字：${ints.join(' / ')}）` };
    }
    cursor = at + 1;
  }
  return { ok: true };
}

/** 把仓库相对路径换成打印用的 posix 形式。 */
function displayPath(root, absolute) {
  const rel = relative(root, absolute);
  if (rel === '' || rel.startsWith('..')) return absolute;
  return rel.split(sep).join('/');
}

function readPage(root, relPath) {
  const absolute = isAbsolute(relPath) ? relPath : join(root, relPath);
  const text = readFileSync(absolute, 'utf8');
  return extractPage(relPath.split(/[\\/]/).join('/'), text);
}

/** 收集扫描面：目录 ⇒ 该目录下 `*.md`（不递归）；文件 ⇒ 只扫这一个。 */
export function collectPages(root, targets) {
  const pages = [];
  for (const target of targets) {
    const absolute = isAbsolute(target) ? target : resolve(root, target);
    const info = statSync(absolute);
    if (info.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) {
        if (!name.endsWith('.md')) continue;
        pages.push(displayPath(root, join(absolute, name)));
      }
    } else {
      pages.push(displayPath(root, absolute));
    }
  }
  return [...new Set(pages)].sort();
}

const USAGE = 'usage: node tools/verify-reading-pages.mjs [--scan <目录或文件>]... [--root <目录>] [--verbose]';

export function parseArgs(argv) {
  const options = { scan: [], root: TOOL_ROOT, verbose: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--verbose') {
      options.verbose = true;
      continue;
    }
    if (flag === '--help' || flag === '-h') {
      options.help = true;
      continue;
    }
    if (flag === '--scan' || flag === '--root') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${flag} 需要一个值（${USAGE}）`);
      i += 1;
      if (flag === '--root') options.root = resolve(value);
      else options.scan.push(value);
      continue;
    }
    throw new Error(`未知参数 ${flag}（${USAGE}）`);
  }
  if (options.scan.length === 0) options.scan.push(DEFAULT_SCAN);
  return options;
}

/**
 * 主流程：扫面 → 逐页抽取 → 六条判据 → 打印。
 * `streams` 可注入（单测用），返回值就是进程退出码。
 */
export function main(argv = process.argv.slice(2), streams = { log: console.log, error: console.error }) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    streams.error(`FAIL: ${error.message}`);
    return 1;
  }
  if (options.help === true) {
    streams.log(USAGE);
    return 0;
  }

  const root = options.root;
  const report = [];
  const findings = [];
  const pages = collectPages(root, options.scan);
  const analyses = new Map();
  const analysisOf = relPath => {
    if (!analyses.has(relPath)) analyses.set(relPath, readPage(root, relPath));
    return analyses.get(relPath);
  };

  const identified = [];
  const skipped = [];
  const allBaselines = [];
  const allDeltas = [];

  for (const page of pages) {
    let analysis;
    try {
      analysis = analysisOf(page);
    } catch (error) {
      findings.push({ path: page, line: 1, reason: REASONS.READING_UNREADABLE, detail: `读不了这页：${String(error.message).split('\n')[0]}` });
      continue;
    }

    const tableResults = collectTables(analysis.lines).map(table => extractTableRecords(page, table));
    const records = [...analysis.records];
    const families = [...analysis.families];
    const groups = [];
    for (const result of tableResults) {
      records.push(...result.records);
      families.push(...result.families);
      groups.push(...result.groups);
      for (const note of result.notes) report.push(`WARN: ${page}:${note.line} ${note.msg}`);
    }
    for (const note of analysis.notes) report.push(`WARN: ${page}:${note.line} ${note.msg}`);

    const readingRecords = records.filter(record => record.fields !== undefined);
    // 只有能识别出「总量」的页面才算读数页；纯日志 / 只有族分布没有总量的页面跳过。
    if (readingRecords.length === 0) {
      skipped.push(page);
      if (families.length > 0) report.push(`INFO: ${page} 有 ${families.length} 条族读数但没有总量，按跳过处理`);
      continue;
    }
    identified.push({ page, records: readingRecords.length, families: families.length });

    for (const record of readingRecords) findings.push(...checkRecordArithmetic(record, report));

    const authoritative = pickAuthoritative(readingRecords);
    findings.push(...checkFamilySums(page, families, groups, authoritative, report));

    const baselines = records.filter(record => record.source === 'baseline').map(record => ({
      path: record.path,
      line: record.line,
      ...record.baseline,
    }));
    allBaselines.push(...baselines);
    allDeltas.push(...records.filter(record => record.source === 'delta'));

    // 判据 ⑤ 的前半 + 跨页（基线列的旧值 vs 被引那一页）。
    for (const baseline of baselines) {
      if (baseline.ref === null) continue;
      const targetAnalysis = (() => {
        try {
          return analysisOf(baseline.ref.path);
        } catch (error) {
          findings.push({
            path: page,
            line: baseline.line,
            reason: REASONS.CROSS_PAGE_UNREADABLE,
            detail: `旧基线文件读不到：${baseline.ref.path}（${String(error.message).split('\n')[0]}）`,
          });
          return null;
        }
      })();
      if (targetAnalysis === null) continue;
      const targetText = targetAnalysis.lines[baseline.ref.start - 1];
      if (targetText === undefined) {
        findings.push({
          path: page,
          line: baseline.line,
          reason: REASONS.CROSS_PAGE_UNREADABLE,
          detail: `旧基线行号越界：${baseline.ref.path}:${baseline.ref.start} 只有 ${targetAnalysis.lines.length} 行`,
        });
        continue;
      }
      if (baseline.family !== null) {
        if (baseline.fieldList === null) {
          report.push(`WARN: ${page}:${baseline.line} 族基线列没写字段清单（形如 total/same/diff/nr），${baseline.family} 的跨页比对跳过`);
          continue;
        }
        const targetFamily = targetAnalysis.families.find(family => normalizeLabel(family.family) === normalizeLabel(baseline.family));
        if (targetFamily === undefined) {
          report.push(`WARN: ${page}:${baseline.line} 被引页 ${baseline.ref.path}:${baseline.ref.start} 里没有 ${baseline.family} 的族读数，跨页族比对跳过`);
          continue;
        }
        baseline.fieldList.forEach((field, at) => {
          if (baseline.values[at] === undefined) return;
          if (targetFamily.fields[field] === undefined) return;
          if (targetFamily.fields[field] !== baseline.values[at]) {
            findings.push({
              path: page,
              line: baseline.line,
              reason: REASONS.CROSS_PAGE_MISMATCH,
              detail: `${baseline.family} 的 ${label(field)}：${baseline.ref.path}:${baseline.ref.start} 记 ${targetFamily.fields[field]}，本页引用 ${baseline.values[at]}`,
            });
          }
        });
        continue;
      }
      const quoted = { [baseline.field]: baseline.value };
      const compared = compareQuotedToLine(quoted, targetText);
      if (compared.unreadable === true) {
        findings.push({
          path: page,
          line: baseline.line,
          reason: REASONS.CROSS_PAGE_UNREADABLE,
          detail: `旧基线行里读不到数字：${baseline.ref.path}:${baseline.ref.start}`,
        });
      } else if (compared.ok === false) {
        findings.push({
          path: page,
          line: baseline.line,
          reason: REASONS.CROSS_PAGE_MISMATCH,
          detail: `跨页基线不符：${baseline.ref.path}:${baseline.ref.start} ${compared.detail}`,
        });
      }
    }

    // 判据 ⑥：散文里「旧页 ...:8 记的是 ...」这种引用。
    for (const ref of analysis.refs) {
      if (ref.quoted === null) continue;
      let targetAnalysis;
      try {
        targetAnalysis = analysisOf(ref.target);
      } catch (error) {
        findings.push({
          path: page,
          line: ref.line,
          reason: REASONS.CROSS_PAGE_UNREADABLE,
          detail: `旧基线文件读不到：${ref.target}（${String(error.message).split('\n')[0]}）`,
        });
        continue;
      }
      let matched = false;
      let lastProblem = null;
      for (let lineNo = ref.start; lineNo <= Math.min(ref.end, targetAnalysis.lines.length); lineNo += 1) {
        const compared = compareQuotedToLine(ref.quoted, targetAnalysis.lines[lineNo - 1]);
        if (compared.ok === true) {
          matched = true;
          break;
        }
        lastProblem = compared.unreadable === true
          ? { reason: REASONS.CROSS_PAGE_UNREADABLE, detail: `旧基线行里读不到数字：${ref.target}:${lineNo}` }
          : { reason: REASONS.CROSS_PAGE_MISMATCH, detail: `跨页基线不符：${ref.target}:${lineNo} ${compared.detail}` };
      }
      if (matched) continue;
      findings.push({
        path: page,
        line: ref.line,
        reason: lastProblem === null ? REASONS.CROSS_PAGE_UNREADABLE : lastProblem.reason,
        detail: lastProblem === null ? `旧基线引用的行不存在：${ref.target}:${ref.start}` : lastProblem.detail,
      });
    }
  }

  findings.push(...checkBaselineConflicts(allBaselines, report));
  findings.push(...checkDeltas(allDeltas));

  findings.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1));

  for (const line of report) streams.log(line);
  if (options.verbose) {
    for (const page of identified) streams.log(`  · ${page.page} 识别：读数 ${page.records} 条、族 ${page.families} 条`);
  }

  const summary = `识别 ${identified.length} 页 / 跳过 ${skipped.length} 页（扫描面 ${pages.length} 页：${options.scan.join('、')}）`;
  if (findings.length === 0) {
    streams.log(`PASS: ${summary}——读数六条判据全部自洽（①总量恒等 ②same 分解 ③对照组不重复计数 ④族加总 ⑤Δ/基线 ⑥跨页逐字）`);
    return 0;
  }
  for (const finding of findings) {
    streams.error(`FAIL: ${finding.path}:${finding.line} ${finding.reason} ${finding.detail}`);
  }
  streams.error(`FAIL: 读数闸门未通过（${findings.length} 条；${summary}）`);
  return 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
