// 跑的是什么：`docs/architecture/admin-console-capability-map.md` §2.2「视图侧调用点」表里的
// `<operationId>@<行号>` 调用点 claim 闸门。这是该表第一次被机器判定——在此之前，
// `tools/verify-doc-anchors.mjs` 与 `tests/unit/doc-anchor-relocation-identity.test.mjs` 都只认
// 「文件名.扩展名:行号」形态，`op@行` 一个都抽不到，于是这张表从 `68dec742` 的 33/33 正确
// 一路烂到 9/33 正确、12 个「行数」读数陈旧，没有任何一处会红。
//
// ── 实际有几种写法（2026-11-01 在 §2.2 上实测，解析器全部支持）───────────────
// 形态 1（实测 33 处物理调用点 / 34 条 op 级 claim，本表主体）：三列表行
//     | apps/admin/src/views/AccountsView.vue（726） | listAdminUsers@70、suspendUser@226 | 2 |
//   页面与「行数」在第一列（全角括号），operation 与行号在第二列以 `@` 连接、多条以 `、`
//   分隔；另有 `approvePost/rejectPost@303（同一处 `submitPostReview`）` 这种「两个 op
//   共用同一行」的写法，`/` 两侧各算一条 op 级 claim（所以 33 处 = 34 条 op 级 claim）。
// 形态 2（实测 7 条）：§2.2 表尾散文里的冒号形式
//     `apps/admin/src/views/SourcesView.vue:360`
//   这种写法 `verify-doc-anchors` 能覆盖「文件存在 + 行号在范围内」，但覆盖不了「这行是不是
//   该 op 的调用点」；本闸门对它的判据是「先按句子把锚点绑到它点名的那条 operation，再复用
//   形态 1 的严格判据」（见下）。
// 形态 3（实测 0 条）：内联裸页面名 + `@` 或 `:`
//     `AccountsView.vue@97`、`AccountsView@97`、`AccountsView.vue:97`
//   §2.2 里现在一处都没有，但解析器照样支持——哪天有人用这种写法新加一条 claim，它会被抽到
//   并走机械判据，不会被静默跳过（`§2.2 解析出的 claim 总数`下限也会因此抬升）。
//
// ── 判据分层（2026-11-01 对抗审查后收紧；旧版只问「这一行里出现过该函数名」）────────
// 机械判据（全部 claim）：页面文件存在、行号在 1..=行数、目标行非空且非纯标点。
// 严格语义判据（形态 1，携带 operationId 的 claim）：目标**代码行**（注释/字符串已用
//   `scanSource` 抹成空格，避免「注释里提了一句函数名」蒙混过关）必须是该 operation 的
//   client function 的**调用**——即行内出现 `<fn>(`（允许 `<fn>  (` 这种空白），仅仅出现名字
//   不算（`import { fetchAccountsPage } …` 行、多行 import 的续行 `submitPostReview,`、模板里
//   的 `<code>editCategory</code>` 散文行含名字但不是调用，必须判红）；名字取自
//   `tools/lib/admin-capability-map.mjs` 的源码派生读数 `rows[].evidenceFunctions`，不是手抄表；
//   并且该页面必须在该 operation 的入口视图集合 `rows[].uiEntryViews` 里——即「这个页面确实
//   import 并调用了这个 client function」。
// 散文锚点判据（形态 2/3，不携带 operationId）：先从左到右扫同一行，把反引号里点名的
//   operationId（必须能在源码派生的 46 个 operation 里找到）记为「当前句的 subject」，遇到
//   句子级分隔符（`，` `,` `；` `;` `。`）清空；每个锚点继承它左边最近的 subject 集合，然后
//   复用严格语义判据：目标行必须是这些 subject 的 client function **调用**，且该页面是它的
//   入口视图。这条判据取代了原来的 `allFunctions`（全库 47 个 fn 的并集）+ 特征词表
//   `['fetch(', 'request(', '@click', 'handler']`——那套写法实测放过了「指到 `@click="signOut"`
//   的退出登录按钮」与「指到另一个 operation 的 `publishSource(` 调用行」，等于不判。
//   同一句点名多条 operation 时取**交集**（2026-11-01 第二轮审查 N3）：只判「并集里任一命中」
//   会让「往句子里多写一个反引号 op 名」这种纯文本编辑把锚点放宽，所以改成「该句点名的每条
//   operation 都必须被这一行背书」；交集为空（点名的 op 之间没有共同的 client function）直接
//   判红并说明原因。现文档里唯一的「一句两 op」是 `approvePost` 与 `rejectPost`，两者共用
//   `submitPostReview`，交集非空，照常通过。
//
// ── 反空转：下面 6 条「变异必须红」的回归用例 ─────────────────────────────────
// 判据本身也要有判据。`tests/unit/admin-console-capability-op-claims.test.mjs` 里最后 6 个
// test 在**内存里**把文档文本改坏（不写盘、不碰被跟踪的文档），断言判据逐条报红：
//   M12b：把表内 30/33 处物理调用点指到同页 import 行 ⇒ 严格语义判据必须逐条红（旧判据下
//         全绿：文档从此一条真调用点都不剩，闸门还报 7/7 pass）。
//   M8  ：单条 `listAdminUsers@70` → 同页 import 行 ⇒ 必须红。
//   M10 ：单条 claim → 模板里 `<code>fn</code>` 的散文行 ⇒ 必须红。
//   M15b/M17b：散文锚点 → `@click="signOut"` 的按钮行 / → 另一个 operation 的调用行 ⇒ 必须红。
//   N3  ：同一句里多点名一个 operation ⇒ 该句全部锚点必须红（旧「并集」判据下全绿：往句子里
//         多写一个反引号 op 名就能把锚点放宽）。
//   B3  ：把 §2.2 某页拆成两行、两行各写一个不同的行数读数（一行留旧的错数）⇒ 行数判据与
//         「每页只允许一行」的结构断言必须红（旧实现用 `Map` 以页面名为键，后行覆盖前行，
//         错数那一行永远不会被判，五道门禁全绿）。
//
// ── 这份文件自己也不「防篡改」──────────────────────────────────────────────
// 「三道锁」（`EXEMPTIONS` 条数、`EXEMPTION_BASELINE`、`FROZEN.strictJudgedClaims`）是**评审
// 可见性**设计，不是防篡改：三个常量就在同一屏，同时改三处仍然能 exit 0（2026-11-01 第二轮
// 审查实测）。它要保证的是「想放行必须留下三行以上的 diff，评审一眼能看见」，不是「改不动」。
// 同理，`FROZEN` 的其它计数也只挡「整段删表/改写法」这类空转，挡不住精心构造的等价重写。
//
// ── 豁免表 ──────────────────────────────────────────────────────────────────
// 严格语义判据的唯一逃生口是下面 `EXEMPTIONS`：**冻结常量数组**，每条必须写 `op` 与
// `reason`，且条数只许减不许增（`EXEMPTION_BASELINE`）。当前为空：34 条 op 级 claim 全部可判，
// 没有一条需要豁免。加豁免 = 改这个文件 + 抬 baseline，diff 里一定看得见。
//
// ── 覆盖范围的边界（别把「§2.2 有闸门」读成「全页都有闸门」）──────────────────
// 本闸门只覆盖 §2.2 这 30 个 operation 的调用点行号与 §2.2 表内 12 个页面的行数读数。能力图
// 共 46 个 operation，其余 16 个的入口由 `node tools/verify-admin-capability-map.mjs --check`
// 的 §0 标记块重算。`docs/architecture/` 里其它 `.vue` 读数都不在本闸门内，2026-11-01 第二轮
// 审查实测仍在的量级：§3 视图行数表 14/16 条陈旧、§3 link 按钮表 link 侧 6/6 条锚点指错
// （其中 `SourcesView.vue:469` 指到空行）、§0 第 17 行复用同一个坏锚、§5「缺 scope」表两处
// （`SourcesView.vue:14` 是注释行、`:366` 是 `}`）、§5 第 7 条三处 session 锚点陈旧——合计约
// 14 个陈旧行数读数 + 11 个指错的 `.vue` 锚点。原因是结构性的：`tools/verify-doc-anchors.mjs`
// 的锚点扩展名表 `ANCHOR_EXTENSIONS` 与符号源码扩展名表 `SYMBOL_SOURCE_EXTENSIONS` 都没有
// `vue`，结构上判不到，要覆盖只能另立闸门（就是这份文件）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildCapabilityMap,
  loadSources,
  scanSource,
} from '../../tools/lib/admin-capability-map.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOC_PATH = 'docs/architecture/admin-console-capability-map.md';
const VIEW_ROOT = 'apps/admin/src/views';

/** §2.2 段界：从 `### 2.2` 行到下一个同级标题行之前。 */
const SECTION_HEADING = /^### 2\.2\s/;
const ANY_HEADING = /^###\s/;

/**
 * 实测读数下限（2026-11-01 冻结）。**只许增不许减**：这些数字是把「表被整段删掉/清空/改写成
 * 解析器抽不到的形态」判红的唯一手段。要合法地删一条 claim，必须先改这里，这一笔改动会出现在
 * diff 里、必须被看见。
 */
const FROZEN = Object.freeze({
  /**
   * 形态 1 的**物理**调用点数 = 去重后的 `<视图,行号>` 个数（与表尾「合计 33 处」同口径）。
   * `approvePost/rejectPost@303` 是两个 operation 共用一处，物理上只算 1 处。
   */
  tableClaims: 33,
  /** 形态 1 的 **op 级** claim 数：共用同一行的两个 operation 各算一条 ⇒ 33 + 1 = 34。 */
  opClaims: 34,
  /** 表内出现的不同 operation 数。 */
  distinctOps: 30,
  /** 表内出现的不同页面文件数。 */
  distinctPages: 12,
  /** 形态 2（散文冒号形态）的 claim 数。 */
  inlineClaims: 7,
  /**
   * 真正走过严格语义判据的 op 级 claim 数（防「全部走豁免表」）。
   * 这是豁免逃生的**第三道**兜底：想靠豁免放过一条 claim，只改 `EXEMPTIONS`（+1 条）会触发
   * `EXEMPTION_BASELINE`；再把 `EXEMPTION_BASELINE` 抬到 1 仍会在这里红——因为被豁免的 claim
   * 不进 `judged`，`judged` 从 34 掉到 33。三处都改才能放行一条，那已经是三行 diff，藏不住。
   */
  strictJudgedClaims: 34,
});

/**
 * 豁免表：走不了严格语义判据的 claim，按 operationId 登记。**冻结常量，只许减不许增**。
 * 每条必须带 `op`（operationId）与 `reason`（为什么不判）。
 * 当前为空——理由：34 条 op 级 claim 的 operation 在源码里都有带路径证据的 client function，
 * 且目标行上确实是该函数的调用，判据可判，不需要豁免。
 */
const EXEMPTIONS = Object.freeze([]);

/**
 * 冻结的豁免条数上限（已经是 0）⇒ 任何新增都会红。
 * 注意这不是唯一的锁：放过一条 claim 还要过 `FROZEN.strictJudgedClaims`（见那里的注释），
 * 三处常量同时改才会绿。
 */
const EXEMPTION_BASELINE = 0;

/** 目标行「非纯标点」的判定：至少有一个字母/数字/汉字。 */
const HAS_SUBSTANCE = /[0-9A-Za-z\u4e00-\u9fff]/;

/** 散文锚点绑定：句子级分隔符，碰到就把「当前句点名的 operation」清空。 */
const CLAUSE_BREAK = /[，,；;。]/;

/** 散文里点名 operation 的写法：反引号包起来的裸标识符（`listAuditEvents`）。 */
const BACKTICKED_NAME = /`([A-Za-z][\w$]*)`/g;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 「这一行出现了这个名字」。 */
function namePattern(name) {
  return new RegExp(`\\b${escapeRegExp(name)}\\b`);
}

/**
 * 「这一行**调用**了这个函数」——名字后面必须跟 `(`（允许中间空白）。
 * 这是本闸门与旧版的分水岭：`import { a, fetchAccountsPage } from …`、多行 import 的续行
 * `submitPostReview,`、模板散文 `<code>editCategory</code>` 都只含名字、不含 `(`，一律不算。
 */
function callPattern(name) {
  return new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`);
}

function fail(lines, header) {
  assert.equal(lines.length, 0, `${header}\n${lines.join('\n')}`);
}

/** `wc -l` 口径：换行符个数（文件以换行结尾时等于行数）。 */
function countLines(text) {
  const breaks = (text.match(/\n/g) ?? []).length;
  return text.endsWith('\n') ? breaks : breaks + 1;
}

function readLines(relative) {
  return readFileSync(join(REPO_ROOT, relative), 'utf8').split('\n');
}

/** 定位 §2.2 段：返回 0 基的 [start, end) 与文档行号（1 基）。 */
function locateSection(docLines) {
  const start = docLines.findIndex(line => SECTION_HEADING.test(line));
  assert.notEqual(start, -1, `${DOC_PATH}: 找不到 §2.2 标题（/^### 2\\.2\\s/）`);
  let end = docLines.length;
  for (let i = start + 1; i < docLines.length; i += 1) {
    if (ANY_HEADING.test(docLines[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

/** 拆三列表行；不是表行返回 null。 */
function splitRow(line) {
  if (!line.startsWith('|')) return null;
  const trimmed = line.replace(/\s+$/, '');
  if (!trimmed.endsWith('|')) return null;
  const cells = trimmed.split('|').slice(1, -1).map(cell => cell.trim());
  return cells.length === 3 ? cells : null;
}

const PAGE_CELL = /^([^\s（]+)\s*（(\d+)）$/;
const OP_AT_LINE = /([A-Za-z][\w$]*(?:\s*\/\s*[A-Za-z][\w$]*)*)@(\d+)/g;
const INLINE_CLAIM = /([A-Za-z][\w$./-]*?(?:\.(?:vue|ts|js|mjs|cjs)|[A-Za-z][\w$]*View))[@:](\d+)/g;

/**
 * 把一行散文里的 `page:line` 锚点绑到「这句话点名的 operation」上。
 *
 * 做法：从左到右扫两种事件——反引号里点名的 operationId（且必须能在源码派生的 operation 表里
 * 找到，`submitPostReview` 这种函数名会被忽略）、`page:line` 锚点。锚点继承「它左边最近一次
 * 句子分隔符之后」出现过的 operationId 集合：
 *   `listAuditEvents` 被 4 处调用（A:66、B:360、C:367、D:207）
 *   ⇒ 4 个锚点的 subject 都是 {listAuditEvents}（锚点之间只隔 `、`，不分隔）
 *   `approvePost` 与 `rejectPost` 共用一处 `submitPostReview`（MQV:303）
 *   ⇒ subject 是 {approvePost, rejectPost}（两者共用同一个 client function，判据取并集）
 * 返回 `{ page, line, ops }`。
 */
function bindInlineAnchors(raw, index) {
  const events = [];
  for (const match of raw.matchAll(BACKTICKED_NAME)) {
    if (!index.has(match[1])) continue;
    events.push({ at: match.index, end: match.index + match[0].length, op: match[1] });
  }
  for (const match of raw.matchAll(INLINE_CLAIM)) {
    events.push({
      at: match.index,
      end: match.index + match[0].length,
      anchor: { page: match[1], line: Number(match[2]) },
    });
  }
  events.sort((left, right) => left.at - right.at);

  const bound = [];
  const anchors = [];
  let cursor = 0;
  for (const event of events) {
    if (CLAUSE_BREAK.test(raw.slice(cursor, event.at))) bound.length = 0;
    if (event.anchor) anchors.push({ ...event.anchor, ops: [...bound] });
    else bound.push(event.op);
    cursor = event.end;
  }
  return anchors;
}

/**
 * 抽 §2.2 里的全部调用点 claim。
 * 返回 `{ claims, inline, pageRows, totalRow }`；`claims` 是形态 1（带 op），`inline` 是形态 2/3
 * （带它绑定到的 `ops`），`pageRows` 是**逐行**的页面行数读数（数组，不是 `Map`——用 `Map`
 * 以页面名为键时，同页第二行会覆盖第一行，被覆盖那一行的行数读数永远不会被判；审查实测
 * 「同页拆两行、一行留旧错数」能让五道门禁全绿）。
 */
function parseClaims(docLines, section) {
  const claims = [];
  const inline = [];
  const pageRows = [];
  let totalRow = null;

  for (let i = section.start; i < section.end; i += 1) {
    const docLine = i + 1;
    const raw = docLines[i];
    const cells = splitRow(raw);
    const isTable = cells !== null;
    const isSeparator = isTable && cells.every(cell => /^:?-{3,}:?$/.test(cell));
    const isHeader = isTable && cells[0] === '页面（行数）';

    if (isTable && !isSeparator && !isHeader) {
      if (cells[0] === '合计') {
        const total = /(\d+)\s*$/.exec(cells[2]);
        totalRow = { docLine, opsText: cells[1], total: total ? Number(total[1]) : null };
        continue;
      }
      const pageCell = PAGE_CELL.exec(cells[0]);
      assert.ok(
        pageCell,
        `${DOC_PATH}:${docLine}: §2.2 表行的第一列不是「页面路径（行数）」，解析不了：${cells[0]}`,
      );
      const page = pageCell[1];
      const declaredLines = Number(pageCell[2]);
      pageRows.push({ docLine, page, declaredLines });
      const found = [...cells[1].matchAll(OP_AT_LINE)];
      assert.ok(
        found.length > 0,
        `${DOC_PATH}:${docLine}: §2.2 表行抽不到任何 <operationId>@<行号>：${cells[1]}`,
      );
      const rowCount = Number(cells[2]);
      assert.equal(
        found.length,
        rowCount,
        `${DOC_PATH}:${docLine}: 该行「计数」列写 ${rowCount}，实际抽出 ${found.length} 条 op@行`,
      );
      for (const match of found) {
        for (const op of match[1].split('/').map(name => name.trim())) {
          claims.push({ docLine, page, op, line: Number(match[2]), rawCell: cells[1] });
        }
      }
      continue;
    }

    if (isTable) continue;

    for (const anchor of bindInlineAnchors(raw, inlineIndex)) {
      inline.push({ docLine, page: anchor.page, line: anchor.line, ops: anchor.ops, raw });
    }
  }

  return { claims, inline, pageRows, totalRow };
}

const codeCache = new Map();

/** 取页面文件的原文行与「代码行」（注释/字符串已抹掉，行号对齐）。 */
function loadPage(page) {
  const relative = page.includes('/') ? page : `${VIEW_ROOT}/${page}`;
  if (codeCache.has(relative)) return codeCache.get(relative);
  const absolute = join(REPO_ROOT, relative);
  const entry = existsSync(absolute)
    ? (() => {
        const text = readFileSync(absolute, 'utf8');
        return {
          relative,
          text,
          lines: text.split('\n'),
          code: scanSource(text).code.split('\n'),
          lineCount: countLines(text),
        };
      })()
    : { relative, missing: true };
  codeCache.set(relative, entry);
  return entry;
}

/** 源码派生的 operationId → { functions, views }（不手抄，跟随客户端函数改名）。 */
function buildOperationIndex() {
  const map = buildCapabilityMap(loadSources(REPO_ROOT));
  const index = new Map();
  for (const row of map.rows) {
    index.set(row.operationId, {
      functions: [...new Set(row.evidenceFunctions)].sort(),
      views: [...new Set(row.uiEntryViews)].sort(),
    });
  }
  return index;
}

const inlineIndex = buildOperationIndex();
const docLines = readLines(DOC_PATH);
const section = locateSection(docLines);
const { claims, inline, pageRows, totalRow } = parseClaims(docLines, section);
const branch = (() => {
  const begin = docLines.findIndex(line => line.includes('<!-- admin-capability-map:begin -->'));
  const end = docLines.findIndex(line => line.includes('<!-- admin-capability-map:end -->'));
  return { begin, end, insideGeneratedBlock: begin !== -1 && begin < section.start && section.end <= end };
})();

/** 机械判据：返回问题列表（空 = 通过）。 */
function judgeMechanical(claimsToJudge, inlineToJudge, loader) {
  const problems = [];
  for (const claim of [...claimsToJudge, ...inlineToJudge]) {
    const page = loader(claim.page);
    const where = `${DOC_PATH}:${claim.docLine} → ${claim.page}:${claim.line}`;
    if (page.missing) {
      problems.push(`${where}: 页面文件不存在（${page.relative}）`);
      continue;
    }
    if (!Number.isInteger(claim.line) || claim.line < 1 || claim.line > page.lineCount) {
      problems.push(`${where}: 行号越界（该文件 ${page.lineCount} 行）`);
      continue;
    }
    const text = page.lines[claim.line - 1] ?? '';
    if (text.trim() === '') {
      problems.push(`${where}: 目标行是空行`);
    } else if (!HAS_SUBSTANCE.test(text)) {
      problems.push(`${where}: 目标行只有标点：${JSON.stringify(text.slice(0, 60))}`);
    }
  }
  return problems;
}

/** 严格语义判据（形态 1）：返回 `{ problems, judged }`。 */
function judgeStrict(claimsToJudge, index, loader) {
  const exempted = new Set(EXEMPTIONS.map(entry => entry.op));
  const problems = [];
  const judged = [];

  for (const claim of claimsToJudge) {
    const where = `${DOC_PATH}:${claim.docLine} → ${claim.page}:${claim.line} (${claim.op})`;
    if (exempted.has(claim.op)) continue;
    const entry = index.get(claim.op);
    if (!entry) {
      problems.push(`${where}: 源码里找不到这个 operationId（改过名或表里写错）`);
      continue;
    }
    if (entry.functions.length === 0) {
      problems.push(
        `${where}: 该 operation 没有「函数体里带 method+path 证据」的 client function，` +
          `严格语义判据无从判定（要么补 client 封装，要么登记豁免并说明理由）`,
      );
      continue;
    }
    const page = loader(claim.page);
    if (page.missing) {
      problems.push(`${where}: 页面文件不存在`);
      continue;
    }
    const codeLine = page.code[claim.line - 1] ?? '';
    const hit = entry.functions.filter(name => callPattern(name).test(codeLine));
    const text = page.lines[claim.line - 1] ?? '';
    judged.push({ claim, hit });
    if (hit.length === 0) {
      problems.push(
        `${where}: 目标行不是该 op 的调用点——本行没有调用任何 client function ` +
          `[${entry.functions.join(', ')}]（只出现名字不算，必须是 \`fn(\`）；` +
          `原文=${JSON.stringify(text.trim().slice(0, 120))}`,
      );
      continue;
    }
    if (!entry.views.includes(page.relative)) {
      problems.push(
        `${where}: 目标行确实调了 ${hit.join('/')}，但 ${page.relative} 不在该 op 的入口视图里` +
          `（源码派生 ${entry.views.join(', ') || '空'}）——要么这一行调到的函数背书的是别的 op`,
      );
    }
  }

  return { problems, judged };
}

/** 散文锚点判据（形态 2/3）：锚点先绑到所在句子点名的 operation，再按严格判据判。 */
function judgeInlineAnchors(inlineToJudge, index, loader) {
  const problems = [];
  for (const claim of inlineToJudge) {
    const where = `${DOC_PATH}:${claim.docLine} → ${claim.page}:${claim.line}`;
    if (claim.ops.length === 0) {
      problems.push(
        `${where}: 锚点所在句子里没有点名任何 operation（要写成 \`<operationId>\` 才能判它是不是` +
          `调用点）——这种锚点等于没有判据，先补 operation 名`,
      );
      continue;
    }
    const unknown = claim.ops.filter(op => !index.has(op));
    if (unknown.length > 0) {
      problems.push(`${where}: 源码里找不到这些 operationId（${unknown.join(', ')}）——改过名或散文里写错`);
      continue;
    }
    // 同句多条 operation ⇒ 取**交集**（每条 op 的 client function 集合的交）。旧实现取并集，
    // 于是「往句子里多写一个反引号 op 名」这种纯文本编辑就能把锚点放宽（审查实测：往
    // `listAuditEvents` 那句里再点一个 `publishSource`，锚点照样绿）。
    let functions = [...new Set(index.get(claim.ops[0]).functions)];
    for (const op of claim.ops.slice(1)) {
      const own = new Set(index.get(op).functions);
      functions = functions.filter(name => own.has(name));
    }
    if (functions.length === 0) {
      const each = claim.ops.map(op => `${op}:[${index.get(op).functions.join(', ') || '空'}]`);
      problems.push(
        `${where}: 这句话点名了多条 operation（${claim.ops.join(', ')}），它们没有共同的 client ` +
          `function（${each.join(' ')}）——锚点判不了：取并集会让「多写一个 op 名」把锚点放宽，` +
          `所以这里取交集，交集为空就判红`,
      );
      continue;
    }
    const page = loader(claim.page);
    if (page.missing) continue; // 机械判据已经报过
    if (!Number.isInteger(claim.line) || claim.line < 1 || claim.line > page.lineCount) continue;
    const codeLine = page.code[claim.line - 1] ?? '';
    const text = page.lines[claim.line - 1] ?? '';
    const hit = functions.filter(name => callPattern(name).test(codeLine));
    if (hit.length === 0) {
      problems.push(
        `${where}: 目标行不是「${claim.ops.join(' / ')}」的调用点——本行没有调用 ` +
          `[${functions.join(', ')}]（只出现名字不算，必须是 \`fn(\`）；` +
          `原文=${JSON.stringify(text.trim().slice(0, 120))}`,
      );
      continue;
    }
    // 与上面的交集同口径：这句话点名的**每条** operation 都必须被这一行背书（函数名出现在
    // 调用里 + 该页面是它的入口视图），只被其中一条背书不算。
    const notBacked = claim.ops.filter(op => {
      const entry = index.get(op);
      return !(
        entry.functions.some(name => hit.includes(name)) && entry.views.includes(page.relative)
      );
    });
    if (notBacked.length > 0) {
      problems.push(
        `${where}: 目标行调了 ${hit.join('/')}，但没有被「${notBacked.join(' / ')}」背书：` +
          `${page.relative} 不是这些 operation 的入口视图、或这一行调到的函数背书的是别的 op——` +
          `要么这一行调到的是另一个 operation 的调用点`,
      );
    }
  }
  return problems;
}

/**
 * 行数读数判据：**逐行**判（`pageRows` 是数组）。返回问题列表。
 *
 * 早前这里是 `for (const [page, info] of pages)`，`pages` 是 `Map`：同页出现两行时后行覆盖
 * 前行，被覆盖那一行的读数**永远不判**。审查把 Accounts 拆成 `（649）`+`（726）` 两行、再删
 * 一个空行保持文档行数不变，就得到「文档同时印着两个矛盾读数、五道门禁全绿」。改成数组逐行判
 * 之后，两行都会拿去和源码实际行数比，错的那行必红。
 */
function judgeLineCounts(pageRows, loader) {
  const problems = [];
  for (const row of pageRows) {
    const loaded = loader(row.page);
    if (loaded.missing) {
      problems.push(`${DOC_PATH}:${row.docLine}: ${row.page} 文件不存在，行数无从核对`);
      continue;
    }
    if (loaded.lineCount !== row.declaredLines) {
      problems.push(
        `${DOC_PATH}:${row.docLine}: ${row.page} 写「（${row.declaredLines}）」，实际 ${loaded.lineCount} 行`,
      );
    }
  }
  return problems;
}

/**
 * 结构断言：§2.2 每个视图只允许出现一行。
 *
 * 这是上面「逐行判」的配套——逐行判只能保证「每一行都拿去比」，还得禁止「同一页写两行、其中
 * 一行写对的」这种叠罗汉：两行都判过、都对得上源码时，读者仍会看到两份读数（其中一份是旧的）。
 * 唯一性 + 逐行比对一起，才等于「这一页的行数读数只有一个，且等于源码实际行数」。
 */
function judgePageUniqueness(pageRows) {
  const seen = new Map();
  const problems = [];
  for (const row of pageRows) {
    const first = seen.get(row.page);
    if (!first) {
      seen.set(row.page, row);
      continue;
    }
    problems.push(
      `${DOC_PATH}:${row.docLine}: ${row.page} 在 §2.2 里出现了两行` +
        `（另一行在 ${DOC_PATH}:${first.docLine}）——每个视图只允许一行，` +
        `否则其中一行的行数读数会绕过逐行比对`,
    );
  }
  return problems;
}

// ── 变异辅助（只改内存里的文本，不写盘、不碰被跟踪的文档）─────────────────────

/** 解析一段（可能是变异过的）文档行。 */
function parseDocument(lines) {
  const parsedSection = locateSection(lines);
  return { section: parsedSection, ...parseClaims(lines, parsedSection) };
}

/**
 * 变异辅助用的「这一行是不是某个 client function 的调用」——刻意**不复用** `callPattern`。
 * 下面 4 条回归用例要证明的是「判据本身有没有挡住假绿」，所以挑变异目标时必须按真语义
 * （`fn(`）去选「含名字但不是调用」的行；否则判据一旦被改回旧的 `\bname\b`，挑目标的逻辑会
 * 跟着一起退化，用例连变异都造不出来，那时红的是用例自己、而不是判据。
 */
function strictCallSite(line, functions) {
  return functions.some(name => new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`).test(line));
}

/**
 * 在页面里找「含 client function 名、但不是该函数调用」的行（1 基行号）。
 * 优先 import 行（`import { … fetchAccountsPage … } from …`），再退到多行 import 的续行
 * （`submitPostReview,`），最后才是模板/其它行——这三类正是旧判据的假绿通道。
 */
function findNonCallNameLines(page, functions) {
  const imports = [];
  const continuations = [];
  const others = [];
  for (let i = 0; i < page.code.length; i += 1) {
    const line = page.code[i];
    const named = functions.filter(name => namePattern(name).test(line));
    if (named.length === 0) continue;
    if (strictCallSite(line, functions)) continue; // 真调用点，不算假绿通道
    const candidate = { line: i + 1, named };
    if (/^\s*import\b/.test(line)) imports.push(candidate);
    else if (/^[A-Za-z_$][\w$]*,?$/.test(line.trim())) continuations.push(candidate);
    else others.push(candidate);
  }
  return [...imports, ...continuations, ...others];
}

/** 把 claim 按物理 `<页面,行号>` 归并（`approvePost/rejectPost@303` 是同一处）。 */
function physicalGroups(claimsToGroup) {
  const groups = new Map();
  for (const claim of claimsToGroup) {
    const key = `${claim.page}@${claim.line}`;
    if (!groups.has(key)) {
      groups.set(key, { page: claim.page, line: claim.line, docLine: claim.docLine, claims: [] });
    }
    groups.get(key).claims.push(claim);
  }
  return [...groups.values()];
}

/** 把文档里某行的 `@<from>` 改写成 `@<to>`，返回新的行数组（原数组不变）。 */
function retargetDocLine(lines, docLine, from, to) {
  return lines.map((line, i) => {
    if (i + 1 !== docLine) return line;
    return line.replace(`@${from}`, `@${to}`);
  });
}

/** 把文档里某行的 `<page>:<from>` 改写成 `<page>:<to>`，返回新的行数组（原数组不变）。 */
function retargetInlineAnchor(lines, docLine, page, from, to) {
  return lines.map((line, i) => {
    if (i + 1 !== docLine) return line;
    return line.replace(`${page}:${from}`, `${page}:${to}`);
  });
}

// ── 现有文档的常绿断言 ──────────────────────────────────────────────────────

test('§2.2 段落定位正确，且它不在 <!-- admin-capability-map:begin/end --> 生成块内', () => {
  assert.ok(section.end > section.start, '§2.2 段为空');
  assert.equal(
    branch.insideGeneratedBlock,
    false,
    `§2.2 落在生成块内（block ${branch.begin + 1}..${branch.end + 1}）⇒ 不许手改，必须改 ` +
      `tools/lib/admin-capability-map.mjs 后用 node tools/verify-admin-capability-map.mjs --update 重生成`,
  );
});

test('§2.2 能解析出 claim，且数量不低于冻结下限（反空转）', () => {
  const physical = new Set(claims.map(claim => `${claim.page}@${claim.line}`));
  assert.ok(
    physical.size >= FROZEN.tableClaims,
    `§2.2 表内的物理调用点只有 ${physical.size} 处，低于冻结下限 ${FROZEN.tableClaims}（只许增不许减）`,
  );
  assert.ok(
    claims.length >= FROZEN.opClaims,
    `§2.2 表内的 op 级 claim 只有 ${claims.length} 条，低于冻结下限 ${FROZEN.opClaims}`,
  );
  assert.ok(
    inline.length >= FROZEN.inlineClaims,
    `§2.2 散文里的 page:line claim 只有 ${inline.length} 条，低于冻结下限 ${FROZEN.inlineClaims}`,
  );
  const distinctOps = new Set(claims.map(claim => claim.op));
  assert.ok(
    distinctOps.size >= FROZEN.distinctOps,
    `§2.2 表内不同 operation 只有 ${distinctOps.size} 个，低于冻结下限 ${FROZEN.distinctOps}`,
  );
  const distinctPages = new Set([...claims, ...inline].map(claim => claim.page));
  assert.ok(
    distinctPages.size >= FROZEN.distinctPages,
    `§2.2 解析出的不同页面文件只有 ${distinctPages.size} 个，低于冻结下限 ${FROZEN.distinctPages}`,
  );
  assert.ok(totalRow, '§2.2 少了「合计」行');
  assert.equal(
    totalRow.total,
    physical.size,
    `§2.2 合计行写 ${totalRow.total} 处，实际抽出 ${physical.size} 处物理调用点（去重后）`,
  );
  const unbound = inline.filter(claim => claim.ops.length === 0);
  assert.deepEqual(
    unbound.map(claim => `${claim.page}:${claim.line}`),
    [],
    '散文锚点里有点名不到 operation 的（见下面的散文锚点判据）',
  );
});

test('机械判据：页面文件存在、行号在 1..=行数、目标行非空且非纯标点', () => {
  const problems = judgeMechanical(claims, inline, loadPage);
  fail(problems, `机械判据失败 ${problems.length} 条：`);
});

test('严格语义判据：表内 op@行 必须是该 operation 的 client 调用点（`fn(`），且页面是该 op 的入口视图', () => {
  const { problems, judged } = judgeStrict(claims, inlineIndex, loadPage);
  fail(problems, `严格语义判据失败 ${problems.length} 条：`);

  assert.ok(
    judged.length >= 1,
    '没有任何一条 claim 真的进过严格语义判据——判据被豁免表旁路了',
  );

  assert.ok(
    judged.length >= FROZEN.strictJudgedClaims,
    `严格语义判据只判了 ${judged.length} 条，低于冻结下限 ${FROZEN.strictJudgedClaims}`,
  );

  const exempted = new Set(EXEMPTIONS.map(entry => entry.op));
  const exemptClaims = claims.filter(claim => exempted.has(claim.op));
  assert.ok(
    exemptClaims.length <= EXEMPTION_BASELINE,
    `豁免表放过了 ${exemptClaims.length} 条 claim，超过冻结上限 ${EXEMPTION_BASELINE}（只许减不许增）`,
  );
});

test('散文锚点判据：page:line 必须绑到同句点名的 operation，且是该 op 的 client 调用点（`fn(`）', () => {
  const problems = judgeInlineAnchors(inline, inlineIndex, loadPage);
  fail(problems, `散文锚点判据失败 ${problems.length} 条：`);
});

test('豁免表只许减不许增：条数 ≤ 冻结上限，且每条必须带 op 与非空 reason', () => {
  assert.ok(
    EXEMPTIONS.length <= EXEMPTION_BASELINE,
    `豁免表有 ${EXEMPTIONS.length} 条，超过冻结上限 ${EXEMPTION_BASELINE}（只许减不许增）`,
  );

  const seen = new Set();
  const problems = [];
  for (const entry of EXEMPTIONS) {
    if (typeof entry?.op !== 'string' || entry.op.trim() === '') {
      problems.push(`豁免条目缺 op：${JSON.stringify(entry)}`);
      continue;
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim().length < 10) {
      problems.push(`豁免条目 ${entry.op} 的 reason 缺失或过短（要写清为什么不判）：${JSON.stringify(entry.reason)}`);
    }
    if (seen.has(entry.op)) problems.push(`豁免条目 ${entry.op} 重复登记`);
    seen.add(entry.op);
    if (!claims.some(claim => claim.op === entry.op)) {
      problems.push(`豁免条目 ${entry.op} 悬空：§2.2 表里没有这个 operation 的 claim`);
    }
  }
  fail(problems, `豁免表元数据不合格 ${problems.length} 条：`);
});

test('行数列（N）与该页面文件的实际 LF 行数一致', () => {
  const problems = judgeLineCounts(pageRows, loadPage);
  fail(problems, `行数列陈旧 ${problems.length} 条：`);
});

test('§2.2 每个视图只允许一行：行数读数必须唯一（防「同页拆两行」叠罗汉）', () => {
  const problems = judgePageUniqueness(pageRows);
  fail(problems, `§2.2 同页重复行 ${problems.length} 条：`);

  const pages = pageRows.map(row => row.page);
  assert.equal(
    new Set(pages).size,
    pageRows.length,
    `§2.2 有 ${pageRows.length} 行页面读数但只有 ${new Set(pages).size} 个不同页面——` +
      `每个视图只允许一行，行数读数必须唯一`,
  );
});

// ── 判据自己的判据：4 条「变异必须红」的回归用例 ────────────────────────────
// 这 4 条对应 2026-11-01 对抗审查里存活的变异（M12b / M8 / M10 / M15b+M17b）。全部在内存里
// 改文档文本，不写盘、不改被跟踪的文件；断言「变异之后判据必须报红，且报错指到被改的那一处」。

test('回归 M12b：把表内多数 claim 指到同页 import 行，严格语义判据必须逐条报红', () => {
  const groups = physicalGroups(claims);
  const used = new Set();
  const targets = new Map();

  for (const group of groups) {
    const functions = [...new Set(group.claims.flatMap(claim => inlineIndex.get(claim.op)?.functions ?? []))];
    if (functions.length === 0) continue;
    const page = loadPage(group.page);
    if (page.missing) continue;
    const candidates = findNonCallNameLines(page, functions);
    const pick =
      candidates.find(candidate => !used.has(`${page.relative}:${candidate.line}`)) ?? candidates[0];
    if (!pick || pick.line === group.line) continue;
    used.add(`${page.relative}:${pick.line}`);
    targets.set(`${group.page}@${group.line}`, pick.line);
  }

  const changedGroups = groups.filter(group => targets.has(`${group.page}@${group.line}`));
  const changedClaims = changedGroups.reduce((sum, group) => sum + group.claims.length, 0);
  assert.ok(
    changedClaims >= 25,
    `变异没造出来：只改到 ${changedClaims} 条 op 级 claim（要求 ≥ 25，即 33 处里的绝大多数）`,
  );

  let mutated = docLines;
  for (const group of changedGroups) {
    mutated = retargetDocLine(
      mutated,
      group.docLine,
      group.line,
      targets.get(`${group.page}@${group.line}`),
    );
  }

  const mutatedParsed = parseDocument(mutated);
  assert.equal(mutatedParsed.claims.length, claims.length, '变异改变了 claim 条数，测试前提不成立');
  assert.notDeepEqual(mutated, docLines, '变异没生效：文档文本与原来一模一样');

  const { problems } = judgeStrict(mutatedParsed.claims, inlineIndex, loadPage);
  assert.equal(
    problems.length,
    changedClaims,
    `把 ${changedClaims} 条 claim 指到同页 import 行（名字在、但不是调用）后，严格语义判据应当` +
      `逐条报红；实际只报 ${problems.length} 条：\n${problems.join('\n') || '（一条都没报，闸门被绕过了）'}`,
  );
});

test('回归 M8：把单条 claim 指到同页 import 行，严格语义判据必须红', () => {
  const claim = claims.find(entry => entry.op === 'listAdminUsers');
  assert.ok(claim, '§2.2 表里找不到 listAdminUsers 的 claim');
  const page = loadPage(claim.page);
  assert.equal(page.missing, undefined, `${claim.page} 不存在`);
  const candidates = findNonCallNameLines(page, inlineIndex.get('listAdminUsers').functions);
  const target = candidates[0];
  assert.ok(target, `${claim.page} 里找不到「含 fetchAccountsPage 但不是调用」的行，测试前提不成立`);
  assert.notEqual(target.line, claim.line, '挑中的行就是真调用点，测试前提不成立');

  const mutated = retargetDocLine(docLines, claim.docLine, claim.line, target.line);
  assert.notDeepEqual(mutated, docLines, '变异没生效');

  const mutatedParsed = parseDocument(mutated);
  const { problems } = judgeStrict(mutatedParsed.claims, inlineIndex, loadPage);
  const expected = `${claim.page}:${target.line}`;
  assert.equal(
    problems.length,
    1,
    `把 ${claim.op}@${claim.line} 指到 import 行 ${expected} 之后应恰好 1 条红；实际 ${problems.length} 条：\n` +
      `${problems.join('\n') || '（一条都没报，闸门被绕过了）'}`,
  );
  assert.ok(problems[0].includes(expected), `报错没指到 ${expected}：${problems[0]}`);
});

test('回归 M10：把单条 claim 指到模板里 <code>fn</code> 的散文行，严格语义判据必须红', () => {
  let subject = null;
  for (const claim of claims) {
    const entry = inlineIndex.get(claim.op);
    if (!entry || entry.functions.length === 0) continue;
    const page = loadPage(claim.page);
    if (page.missing) continue;
    for (let i = 0; i < page.code.length; i += 1) {
      const line = page.code[i];
      const named = entry.functions.filter(name =>
        new RegExp(`<code>\\s*${escapeRegExp(name)}\\s*</code>`).test(line),
      );
      if (named.length === 0) continue;
      if (strictCallSite(line, entry.functions)) continue;
      subject = { claim, page, target: { line: i + 1, named } };
      break;
    }
    if (subject) break;
  }
  assert.ok(
    subject,
    '找不到「模板里 <code>clientFn</code> 散文行」的样本（这一条防的是模板散文冒充调用点），测试前提不成立',
  );

  const { claim, page, target } = subject;
  const mutated = retargetDocLine(docLines, claim.docLine, claim.line, target.line);
  assert.notDeepEqual(mutated, docLines, '变异没生效');

  const mutatedParsed = parseDocument(mutated);
  const { problems } = judgeStrict(mutatedParsed.claims, inlineIndex, loadPage);
  const expected = `${page.relative}:${target.line}`;
  assert.equal(
    problems.length,
    1,
    `把 ${claim.op}@${claim.line} 指到模板散文行 ${expected} 之后应恰好 1 条红；实际 ${problems.length} 条：\n` +
      `${problems.join('\n') || '（一条都没报，闸门被绕过了）'}`,
  );
  assert.ok(problems[0].includes(expected), `报错没指到 ${expected}：${problems[0]}`);
});

test('回归 M15b/M17b：散文锚点指到 @click 按钮行、或指到另一个 operation 的调用行，都必须红', () => {
  const allFunctions = new Set([...inlineIndex.values()].flatMap(entry => entry.functions));
  const failures = [];
  const cases = [];

  // (a) 指到带 `@click` 的按钮行（旧判据里 `@click` 是「调用点特征」token，于是全绿）
  const auditAnchor = inline.find(
    claim => claim.ops.length === 1 && claim.ops[0] === 'listAuditEvents',
  );
  assert.ok(auditAnchor, '找不到绑定到 listAuditEvents 的散文锚点，测试前提不成立');
  const auditPage = loadPage(auditAnchor.page);
  const clickTarget = (() => {
    for (let i = 0; i < auditPage.code.length; i += 1) {
      const line = auditPage.code[i];
      if (!/@click/.test(line)) continue;
      if (strictCallSite(line, inlineIndex.get('listAuditEvents').functions)) continue;
      return i + 1;
    }
    return null;
  })();
  assert.ok(clickTarget, `${auditAnchor.page} 里找不到带 @click 且不调该 op 的行，测试前提不成立`);
  assert.notEqual(clickTarget, auditAnchor.line, '挑中的行就是锚点原值，测试前提不成立');
  cases.push({
    label: `散文锚点 → @click 按钮行（${auditAnchor.page}:${clickTarget}）`,
    docLines: retargetInlineAnchor(docLines, auditAnchor.docLine, auditAnchor.page, auditAnchor.line, clickTarget),
    expected: `${auditAnchor.page}:${clickTarget}`,
  });

  // (b) 指到另一个 operation 的调用行（旧判据用全库 47 个 fn 的并集，于是全绿）
  const sourcesAnchor = inline.find(
    claim => claim.ops.length === 1 && claim.ops[0] === 'listAdminSources',
  );
  assert.ok(sourcesAnchor, '找不到绑定到 listAdminSources 的散文锚点，测试前提不成立');
  const sourcesPage = loadPage(sourcesAnchor.page);
  const foreignCall = (() => {
    for (let i = 0; i < sourcesPage.code.length; i += 1) {
      const line = sourcesPage.code[i];
      if (strictCallSite(line, inlineIndex.get('listAdminSources').functions)) continue;
      const called = [...allFunctions].filter(name => strictCallSite(line, [name]));
      if (called.length > 0) return { line: i + 1, called };
    }
    return null;
  })();
  assert.ok(foreignCall, `${sourcesAnchor.page} 里找不到「另一个 operation 的调用行」，测试前提不成立`);
  assert.notEqual(foreignCall.line, sourcesAnchor.line, '挑中的行就是锚点原值，测试前提不成立');
  cases.push({
    label:
      `散文锚点 → 另一个 op 的调用行（${sourcesAnchor.page}:${foreignCall.line}，调 ${foreignCall.called.join('/')}）`,
    docLines: retargetInlineAnchor(
      docLines,
      sourcesAnchor.docLine,
      sourcesAnchor.page,
      sourcesAnchor.line,
      foreignCall.line,
    ),
    expected: `${sourcesAnchor.page}:${foreignCall.line}`,
  });

  for (const item of cases) {
    const parsed = parseDocument(item.docLines);
    const problems = judgeInlineAnchors(parsed.inline, inlineIndex, loadPage);
    if (problems.length !== 1 || !problems[0].includes(item.expected)) {
      failures.push(
        `${item.label}：期望恰好 1 条红且指到 ${item.expected}，实际 ${problems.length} 条` +
          `${problems.length > 0 ? `：${problems.join(' | ')}` : '（变异存活，判据没挡住）'}`,
      );
    }
  }

  assert.deepEqual(failures, [], `散文锚点变异必须报红：\n${failures.join('\n')}`);
});

test('回归 N3：同一句里多点名一个 operation，该句的全部锚点必须红（判据取交集，不是并集）', () => {
  const anchor = inline.find(claim => claim.ops.length === 1 && claim.ops[0] === 'listAuditEvents');
  assert.ok(anchor, '找不到绑定到 listAuditEvents 的散文锚点，测试前提不成立');

  const clauseAnchors = inline.filter(
    claim => claim.docLine === anchor.docLine && claim.ops.includes('listAuditEvents'),
  );
  assert.ok(
    clauseAnchors.length >= 2,
    `同句里绑定到 listAuditEvents 的锚点只有 ${clauseAnchors.length} 条，测不出「放宽整句」的效果`,
  );

  const inject = 'publishSource';
  const ownFunctions = inlineIndex.get(inject)?.functions ?? [];
  const baseFunctions = inlineIndex.get('listAuditEvents').functions;
  assert.ok(ownFunctions.length > 0, `${inject} 没有 client function，测试前提不成立`);
  assert.equal(
    baseFunctions.filter(name => ownFunctions.includes(name)).length,
    0,
    '两个 op 有共同的 client function，交集不为空，测不出「并集 vs 交集」的差别',
  );

  const needle = '`listAuditEvents` 被 4 处调用';
  const sourceLine = docLines[anchor.docLine - 1];
  assert.ok(
    sourceLine.includes(needle),
    `§2.2 那行散文的写法变了（找不到「${needle}」），先更新这条用例的变异点`,
  );

  // 变异：只在同一句里多点名一个反引号 op 名，锚点一个都不改——旧「并集」判据下这句照样全绿。
  const mutated = docLines.map((line, i) =>
    i === anchor.docLine - 1
      ? line.replace(needle, `\`listAuditEvents\` 与 \`${inject}\` 被 4 处调用`)
      : line,
  );
  assert.notDeepEqual(mutated, docLines, '变异没生效：文档文本与原来一模一样');

  const parsed = parseDocument(mutated);
  const rebound = parsed.inline.filter(
    claim => claim.docLine === anchor.docLine && claim.ops.includes(inject),
  );
  assert.equal(
    rebound.length,
    clauseAnchors.length,
    `变异后应当有 ${clauseAnchors.length} 个锚点绑到 {listAuditEvents, ${inject}}，实际 ${rebound.length} 个`,
  );

  const problems = judgeInlineAnchors(parsed.inline, inlineIndex, loadPage);
  assert.equal(
    problems.length,
    clauseAnchors.length,
    `同句多点名一个没有共同 client function 的 operation 之后，这一句的 ${clauseAnchors.length} 个锚点` +
      `必须全部判红（旧「并集」判据下是 0 条）；实际 ${problems.length} 条：\n` +
      `${problems.join('\n') || '（一条都没报：往句子里多写一个 op 名就能把锚点放宽）'}`,
  );
  for (const claim of clauseAnchors) {
    const where = `${claim.page}:${claim.line}`;
    assert.ok(
      problems.some(problem => problem.includes(where)),
      `报错没指到 ${where}：\n${problems.join('\n')}`,
    );
  }
});

test('回归 B3：同页拆两行、两行各写一个行数读数，行数判据与唯一性断言必须红（旧 Map 实现会放行）', () => {
  const target = pageRows.find(row => row.page.endsWith('/AccountsView.vue'));
  assert.ok(target, '§2.2 里找不到 AccountsView.vue 的行数读数，测试前提不成立');

  const loaded = loadPage(target.page);
  assert.equal(loaded.missing, undefined, `${target.page} 不存在`);
  assert.equal(
    loaded.lineCount,
    target.declaredLines,
    `${target.page} 的行数读数在真实文档里已经不准（写 ${target.declaredLines}，实际 ${loaded.lineCount}），` +
      `先修好它，否则这条用例分不清红的是变异还是既有陈旧`,
  );

  const wrongLines = loaded.lineCount - 77; // 726 − 77 = 649，正是审查用的那个旧错数
  const rowClaims = claims.filter(claim => claim.docLine === target.docLine);
  assert.equal(
    rowClaims.length,
    2,
    `这一行应当有 2 条 op 级 claim（实际出发 ${rowClaims.length} 条），拆行变异要求两行各留一条`,
  );

  const left = `| ${target.page}（${wrongLines}） | ${rowClaims[0].op}@${rowClaims[0].line} | 1 |`;
  const right = `| ${target.page}（${target.declaredLines}） | ${rowClaims[1].op}@${rowClaims[1].line} | 1 |`;
  assert.notEqual(left, right, '拆出来的两行一样，变异没意义');

  // 拆行 + 删掉表后那个空行 ⇒ 文档总行数不变。这是这次攻击成立的条件：总行数一变，
  // 外部文档锚点会先漂移，闸门靠别的原因红，就分不清是不是行数判据挡住了。
  const totalRowIndex = docLines.findIndex(line => line.startsWith('| 合计'));
  assert.notEqual(totalRowIndex, -1, '§2.2 找不到「合计」行，测试前提不成立');
  const blankIndex = totalRowIndex + 1;
  assert.equal(docLines[blankIndex].trim(), '', '「合计」行下面不是空行，变异点要重挑');

  const mutated = [];
  for (let i = 0; i < docLines.length; i += 1) {
    if (i === blankIndex) continue;
    if (i === target.docLine - 1) {
      mutated.push(left, right);
      continue;
    }
    mutated.push(docLines[i]);
  }

  assert.equal(
    mutated.length,
    docLines.length,
    `拆行把文档行数从 ${docLines.length} 变成 ${mutated.length}，这次攻击的前提（总行数不变）不成立`,
  );

  const parsed = parseDocument(mutated);
  assert.equal(
    parsed.claims.length,
    claims.length,
    `拆行改变了 op 级 claim 条数（${claims.length} → ${parsed.claims.length}），测试前提不成立——` +
      `这次攻击的特征恰恰是「claim 数、物理点数、不同页面数全都不变」`,
  );
  assert.equal(
    new Set(parsed.claims.map(claim => `${claim.page}@${claim.line}`)).size,
    new Set(claims.map(claim => `${claim.page}@${claim.line}`)).size,
    '拆行改变了物理调用点数，测试前提不成立',
  );
  assert.equal(parsed.pageRows.length, pageRows.length + 1, '拆行没生效');

  const duplicates = judgePageUniqueness(parsed.pageRows);
  assert.equal(
    duplicates.length,
    1,
    `同一页出现两行之后，「每个视图只允许一行」应当恰好报 1 条红；实际 ${duplicates.length} 条：\n` +
      `${duplicates.join('\n') || '（一条都没报，闸门被绕过了）'}`,
  );
  assert.ok(
    duplicates[0].includes(target.page),
    `唯一性报错没指到 ${target.page}：${duplicates[0]}`,
  );

  const counts = judgeLineCounts(parsed.pageRows, loadPage);
  assert.equal(
    counts.length,
    1,
    `两行里有一行写着旧错数 ${wrongLines}（另一行是准的 ${target.declaredLines}），逐行比对应当恰好` +
      `报 1 条红；实际 ${counts.length} 条：\n${counts.join('\n') || '（一条都没报，闸门被绕过了）'}`,
  );
  assert.ok(
    counts[0].includes(String(wrongLines)),
    `行数报错没指到错的那一行（${wrongLines}）：${counts[0]}`,
  );
});
