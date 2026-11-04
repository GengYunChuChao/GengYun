// 契约台账 blocker 散文锚点真值测试（GY-R77 片）
//
// 洞：`docs/architecture/contract-status.json` 里每条 operation/dimension 的 `evidence[]` 有结构化
// 的 `path`/`symbol`/`lines`，已被 `node tools/verify-contract-status.mjs` 严格校验；但同一台账的
// **散文**（`operations[].blocker`、`dimensions[].blocker`、`dimensions[].source_anchor`）里大量
// 写着 `` `services/api/src/app.ts:2508` `` 这类「文件:行号」锚点，**没有任何工具校验它们**。
// 结果是散文锚点静默漂移：文件搬了、块下移了，散文还指着旧行号，读者照着翻过去只会看到无关代码
// （历史实测至少 6 处：ocrPersistencePool 2508→2546、durableDeletionRequests 1602-1605→1989-1992、
// backupPurgeWiring 1616-1623→2009-2016、registerConsentRoutes 2445-2448→2483-2486、
// createPostgresMediaStore 1413-1416→1303-1306，以及本片修的 listMessages 一族 802-806/1126-1130）
// 与 `verify-doc-anchors.mjs` 对 markdown 的判据（BROKEN/OUT_OF_RANGE/SUSPECT）不同，JSON 里的
// 散文锚点既不是 markdown 也不是契约 `lines`，两头都漏 ⇒ 本文件补这道闸。
//
// 判据（三类，全部给出可诊断文案：owner + 字段 + 锚点原文 + 期望 vs 实际）：
//   T1 文件存在：锚点 path 在仓库里存在（防止文件改名/删除后散文继续引用幽灵路径）；
//   T2 行号在界内：起点与终点都判 `1 <= line <= 文件行数`（行数以 node 的 `split('\n')` 口径算，
//      与 PowerShell `Measure-Object -Line` 的 CRLF 口径不同，两者不要混用）；
//   T3 不落在「空行 / 纯闭合括号 / 纯注释」：这正是历史 SUSPECT 的形态——锚点写对了文件、
//      也在界内，但那几行只有 `});`、空行或注释，指过去等于没指。
//
// 两条收敛口径（避免把正确锚点判红）：
//   · 区间锚点 `A-B` 只判**起点行**是实质代码，另要求 `[A,B]` 内至少存在一行实质内容；终点行
//     天然常是 `});`/`);`/`}`（例如 `services/api/src/app.ts:2483-2486` 的收尾就是 `});`），
//     把终点也判「不许纯括号」会把正确锚点判红。
//   · 逗号写法 `path:line,line` 的每个数字都是「一个点」，逐点判。
//
// 白名单：只允许「该锚点指的就是文件末尾的收束括号」这类确有必要的情形，且每条必须写理由；
// **为空是首选**（当前为空）。白名单不是放宽判据的口子：条目必须被某条真实违规命中，否则判红。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STATUS_JSON = join(ROOT, 'docs', 'architecture', 'contract-status.json');

// 进判据的散文字段（2026-11-04 按结构盘点：operation 只有 `blocker` 是散文，`scope` 是权限串；
// dimension 多一段 `source_anchor`。`status_definitions` 是无锚点说明）。
const PROSE_FIELDS = ['operations[].blocker', 'dimensions[].blocker', 'dimensions[].source_anchor'];

// 仓库内目录开头才算锚点：`http://…`、`#123`、`0039_xxx.sql`、`app.ts:802`（无目录前缀的相对说法）
// 一律**不**进来。路径必须以字母数字/_/- 收尾，避免把后随标点吞进来。
const ANCHOR_RE =
  /(?<![\w./-])((?:services|apps|packages|tools|tests|docs|miniprogram|deploy|scripts)\/[A-Za-z0-9_@./-]*[A-Za-z0-9_-]):(\d+)(?:[-–](\d+))?((?:\s*[,，]\s*\d+)*)/g;

// 显式白名单：`{ owner, anchor, reason }`，reason 必填。为空是首选。
const ANCHOR_WHITELIST = [];

const status = JSON.parse(readFileSync(STATUS_JSON, 'utf8'));

/** 台账里所有「带锚点的散文」条目。 */
function proseEntries(doc) {
  const entries = [];
  for (const op of doc.operations ?? []) {
    if (typeof op.blocker === 'string' && op.blocker !== '') {
      entries.push({
        owner: `operation ${op.id}`,
        field: 'operations[].blocker',
        text: op.blocker,
      });
    }
  }
  for (const dim of doc.dimensions ?? []) {
    if (typeof dim.blocker === 'string' && dim.blocker !== '') {
      entries.push({
        owner: `dimension ${dim.key}`,
        field: 'dimensions[].blocker',
        text: dim.blocker,
      });
    }
    if (typeof dim.source_anchor === 'string' && dim.source_anchor !== '') {
      entries.push({
        owner: `dimension ${dim.key}`,
        field: 'dimensions[].source_anchor',
        text: dim.source_anchor,
      });
    }
  }
  return entries;
}

/** 抽锚点：`path:line`、`path:line-line`、`path:line,line`。 */
function collectAnchors(entry) {
  const out = [];
  for (const match of entry.text.matchAll(ANCHOR_RE)) {
    const [, path, startRaw, endRaw, commaTail] = match;
    const extra = (commaTail ?? '')
      .split(/[,，]/)
      .map((piece) => piece.trim())
      .filter((piece) => piece !== '')
      .map(Number);
    out.push({
      ...entry,
      raw: match[0],
      path,
      start: Number(startRaw),
      end: endRaw === undefined ? null : Number(endRaw),
      extra,
    });
  }
  return out;
}

const ENTRIES = proseEntries(status);
const ANCHORS = ENTRIES.flatMap(collectAnchors);

const lineCache = new Map();
function fileLines(relPath) {
  if (!lineCache.has(relPath)) {
    const abs = join(ROOT, relPath);
    lineCache.set(relPath, existsSync(abs) ? readFileSync(abs, 'utf8').split('\n').length - 1 : null);
  }
  return lineCache.get(relPath);
}

const lineText = (relPath, line) => readFileSync(join(ROOT, relPath), 'utf8').split('\n')[line - 1] ?? '';

// 纯闭合括号：`}`、`});`、`];`、`),`、`],` 之类，trim 后整行就这些字符。
const CLOSER_RE = /^[}\])]+[;,]?$/;

function commentPrefix(relPath) {
  const dot = relPath.lastIndexOf('.');
  const ext = dot === -1 ? '' : relPath.slice(dot).toLowerCase();
  if (ext === '.md' || ext === '.json' || ext === '.txt') return null; // 文档/数据行按正文判
  if (ext === '.sql') return /^(--|\/\*|\*)/;
  if (['.sh', '.bash', '.py', '.ps1', '.yml', '.yaml', '.toml', '.ini', '.conf', '.service', '.env'].includes(ext)) {
    return /^#/;
  }
  return /^(\/\/|\/\*|\*|\*\/)/;
}

function isCommentLine(relPath, text) {
  const pattern = commentPrefix(relPath);
  return pattern === null ? false : pattern.test(text.trim());
}

const isBlank = (text) => text.trim() === '';
const isCloser = (text) => CLOSER_RE.test(text.trim());
/** 实质代码行：非空、非纯闭合括号、非纯注释。 */
const isSubstantive = (relPath, text) => !isBlank(text) && !isCloser(text) && !isCommentLine(relPath, text);

const whitelisted = (anchor) =>
  ANCHOR_WHITELIST.some((item) => item.owner === anchor.owner && item.anchor === anchor.raw);

const formatViolations = (violations) =>
  `${violations.length} 条违规（三类判据见文件头）：\n${violations.map((v) => `  · ${v}`).join('\n')}`;

test('T0 散文字段清册：带仓库内锚点的字段只有 blocker 与 source_anchor', () => {
  const found = new Set();
  const walk = (node, path) => {
    if (typeof node === 'string') {
      ANCHOR_RE.lastIndex = 0;
      if (ANCHOR_RE.test(node)) found.add(path);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, `${path}[]`);
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) walk(value, path === '' ? key : `${path}.${key}`);
    }
  };
  walk(status, '');
  assert.deepEqual(
    [...found].sort(),
    [...PROSE_FIELDS].sort(),
    '带锚点的字段清册变了：新出现的散文字段必须加进 PROSE_FIELDS 并进三类判据，否则它同样是「没人校验的锚点」。',
  );
  assert.ok(ANCHORS.length >= 100, `锚点清册只剩 ${ANCHORS.length} 条：删锚点不是修法，请确认不是把散文写丢了。`);
});

test('T1 文件存在：散文锚点指向的文件必须在仓库里存在', () => {
  const violations = [];
  for (const anchor of ANCHORS) {
    if (whitelisted(anchor)) continue;
    if (existsSync(join(ROOT, anchor.path))) continue;
    violations.push(
      `${anchor.owner} 的 ${anchor.field} 锚点「${anchor.raw}」：文件不存在（期望 \`${anchor.path}\` 在仓库里；` +
        `实际 ${join(ROOT, anchor.path)} 不存在）。片段：「${snippet(anchor)}」`,
    );
  }
  assert.deepEqual(violations, [], formatViolations(violations));
});

test('T2 行号在界内：起点与终点都不许超出文件行数', () => {
  const violations = [];
  for (const anchor of ANCHORS) {
    if (whitelisted(anchor)) continue;
    const total = fileLines(anchor.path);
    if (total === null) continue; // 交给 T1 报（避免同一处报两遍）
    const points = [anchor.start, ...(anchor.end === null ? [] : [anchor.end]), ...anchor.extra];
    for (const line of points) {
      if (line >= 1 && line <= total) continue;
      violations.push(
        `${anchor.owner} 的 ${anchor.field} 锚点「${anchor.raw}」：行号越界（期望 1 <= ${line} <= ${total}；` +
          `实际 ${line}${line === total + 1 ? '（恰好是文件末尾换行后的空行号）' : ''}）。片段：「${snippet(anchor)}」`,
      );
    }
  }
  assert.deepEqual(violations, [], formatViolations(violations));
});

test('T3 不落在空行/纯闭合括号/纯注释：锚点起点必须是实质代码', () => {
  const violations = [];
  for (const anchor of ANCHORS) {
    if (whitelisted(anchor)) continue;
    const total = fileLines(anchor.path);
    if (total === null) continue; // T1 报
    if (anchor.start > total) continue; // T2 报
    const points = [anchor.start, ...anchor.extra.filter((line) => line >= 1 && line <= total)];
    let startDead = false;
    for (const line of points) {
      const text = lineText(anchor.path, line);
      if (isSubstantive(anchor.path, text)) continue;
      if (line === anchor.start) startDead = true;
      violations.push(
        `${anchor.owner} 的 ${anchor.field} 锚点「${anchor.raw}」：第 ${line} 行不是实质代码` +
          `（空行/纯闭合括号/纯注释），指过去等于没指 ⇒ 期望该行是代码，实际原文「${text.trim()}」。片段：「${snippet(anchor)}」`,
      );
    }
    // 起点已判红就不再补一条同义文案：整段都没实质内容时上面那条已经说明了问题。
    if (startDead || anchor.end === null || anchor.end > total) continue;
    const substantive = anchor.path.length > 0 && rangeHasSubstance(anchor.path, anchor.start, anchor.end);
    if (!substantive) {
      violations.push(
        `${anchor.owner} 的 ${anchor.field} 锚点「${anchor.raw}」：区间 ${anchor.start}-${anchor.end} 内没有任何实质代码行` +
          `（全为空行/闭合括号/注释）⇒ 期望区间覆盖被引用的代码块。片段：「${snippet(anchor)}」`,
      );
    }
  }
  assert.deepEqual(violations, [], formatViolations(violations));
});

function rangeHasSubstance(relPath, start, end) {
  const lines = readFileSync(join(ROOT, relPath), 'utf8').split('\n');
  for (let line = start; line <= Math.min(end, lines.length); line += 1) {
    if (isSubstantive(relPath, lines[line - 1] ?? '')) return true;
  }
  return false;
}

/** 违规文案里的片段：锚点前后各 24 字，便于在散文里定位。 */
function snippet(anchor) {
  const index = anchor.text.indexOf(anchor.raw);
  const from = Math.max(0, index - 24);
  const to = Math.min(anchor.text.length, index + anchor.raw.length + 24);
  return `${from > 0 ? '…' : ''}${anchor.text.slice(from, to)}${to < anchor.text.length ? '…' : ''}`;
}

test('T4 白名单卫生：每条都要写理由，且必须被真实违规命中', () => {
  const problems = [];
  for (const item of ANCHOR_WHITELIST) {
    if (typeof item.owner !== 'string' || item.owner === '') problems.push(`白名单条目缺 owner：${JSON.stringify(item)}`);
    if (typeof item.anchor !== 'string' || item.anchor === '') problems.push(`白名单条目缺 anchor：${JSON.stringify(item)}`);
    if (typeof item.reason !== 'string' || item.reason.trim().length < 8) {
      problems.push(`白名单条目缺理由（或理由过短）：${JSON.stringify(item)}`);
    }
    if (!ANCHORS.some((anchor) => anchor.owner === item.owner && anchor.raw === item.anchor)) {
      problems.push(`白名单条目已失效（台账里没有这条锚点了，删掉它）：${item.owner} / ${item.anchor}`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});
