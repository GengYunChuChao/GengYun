/**
 * 文档手写行号闸门：`docs/**` 里写成 `services/api/src/xxx.ts:17-30` 的引用，代码一动就变成假证据。
 *
 * 这个工具只判**能被机械证伪**的三件事，判不了的一律如实记「不可解析」，不冒充通过：
 *   BROKEN       —— 引用里的路径在仓库里找不到（也没法唯一解析）。
 *   OUT_OF_RANGE —— 路径找到了，但 `起-止` 超出该文件的行数。
 *   SUSPECT      —— 行号合法，可整个区间里没有一行实质内容（全空行／全右括号／全注释）。
 *
 * 为什么**不**用「内容 sha256 全等」当判据：任何合法改代码（加一行日志、改一个错别字）都会让
 * 哈希变红，红的原因与「文档是不是假证据」无关，等于用噪声换掉原有的真信号，最后只能整片关掉。
 * 本工具判的是**结构性**事实（路径在不在、行号在不在文件里、区间里有没有东西），
 * 这些事实只在「文档确实指错了地方」时才变红。内容是否仍然描述同一段实现，属人工判断，
 * 本工具不证明（见 docs/verification/gy-r31-doc-anchors-20261022.md）。
 *
 * 基线：仓内既有文档本来就有历史遗留的行号漂移，全量清零不是本片能做的事。已知问题登记在
 * `tools/doc-anchors-baseline.json`（受版本控制，每条含 path / reason / owner / reference），
 * `--strict` 只报「基线之外新增的」，因此不会因为历史债把门禁钉成永红；反过来，某条基线
 * 修好之后它就「陈旧」了——`tests/unit/doc-anchors-guard.test.mjs` 会点名要求删掉，不让基线悄悄变成免罚名单。
 *
 * 用法：
 *   node tools/verify-doc-anchors.mjs                      # dry-run：全量清单 + 三类计数
 *   node tools/verify-doc-anchors.mjs --strict             # 基线之外有新增才 exit 1
 *   node tools/verify-doc-anchors.mjs --scan docs/reference --scan 'docs/features/**\/*.md'
 *   node tools/verify-doc-anchors.mjs --emit-baseline      # 打印基线 JSON（不写盘）
 *   node tools/verify-doc-anchors.mjs --write-baseline     # 写 tools/doc-anchors-baseline.json
 *   node tools/verify-doc-anchors.mjs --root <目录>        # 指向夹具树（单测用）
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const TOOL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** 默认扫描面：架构文档 + 证据页。用 `--scan` 可加，不改这里也能扩。 */
export const DEFAULT_SCAN_TARGETS = Object.freeze(['docs/architecture', 'docs/verification']);
export const DEFAULT_BASELINE = 'tools/doc-anchors-baseline.json';
export const BROKEN = 'BROKEN';
export const OUT_OF_RANGE = 'OUT_OF_RANGE';
export const SUSPECT = 'SUSPECT';
export const REASONS = Object.freeze([BROKEN, OUT_OF_RANGE, SUSPECT]);

/** 只认这些扩展名：`10.20.0.0:16` 这类 IP／端口不会被误当成「路径:行号」。 */
const ANCHOR_EXTENSIONS = Object.freeze([
  'mjs', 'cjs', 'js', 'jsx', 'ts', 'tsx', 'json', 'jsonc', 'sql',
  'md', 'yml', 'yaml', 'css', 'html', 'py', 'sh', 'ps1', 'toml',
]);
const ANCHOR_PATTERN = new RegExp(
  `(?<![\\w.\\-/])((?:[\\w.\\-]+/)*[\\w.\\-]+\\.(?:${ANCHOR_EXTENSIONS.join('|')})):(\\d+)(?:-(\\d+))?(?!\\d)`,
  'g',
);
/** 遍历仓库建「同名文件」索引时跳过的目录：依赖与产物不是文档该引用的源码证据。 */
const SKIP_DIRECTORIES = new Set([
  'node_modules', '.git', '.pnpm-store', 'dist', 'coverage', '.pg17', '.pgdata',
  '.venv', '__pycache__', '.next', '.cache', '.turbo',
]);

// —— 区间内容判据：一行算不算「实质内容」 ——————————————————————————————
// 各家注释标记分开认，否则 markdown 的 `# 标题` 会被当成 python 注释，证据页之间的行号引用全变 SUSPECT。
const COMMENT_PREFIXES = Object.freeze({
  js: ['//', '/*', '*', '*/'],
  sql: ['--'],
  hash: ['#'],
  md: ['<!--', '-->'],
});
const CLOSING_ONLY = /^[}\]\)]+[;,)]*$/;
const JS_LIKE = new Set(['mjs', 'cjs', 'js', 'jsx', 'ts', 'tsx', 'json', 'jsonc', 'css']);
const HASH_LIKE = new Set(['py', 'sh', 'ps1', 'yml', 'yaml', 'toml']);

/** 一份文本的逻辑行（末尾换行不算「多一行」，否则每个文件都白送一条可越界行）。 */
export function splitLines(text) {
  const lines = text.split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.map(line => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

function commentPrefixesOf(extension) {
  if (JS_LIKE.has(extension)) return COMMENT_PREFIXES.js;
  if (HASH_LIKE.has(extension)) return COMMENT_PREFIXES.hash;
  if (extension === 'sql') return COMMENT_PREFIXES.sql;
  if (extension === 'md') return COMMENT_PREFIXES.md;
  return [];
}

/**
 * 实质内容行 = 非空、且不是**纯收尾括号**（`}` / `});` / `];` / `},` 这类）。
 * 与 `tools/verify-contract-status.mjs` 的 `isSubstantiveLine` 同源（那边的 CLOSING_LINE 规则），
 * 一处口径两处用，免得同一个仓库里对「有没有内容」有两种答案。
 *
 * 刻意**不**把注释行算作「无内容」：引用一段判据注释是合法证据形态（例如证据页引用
 * `.github/workflows/*.yml` 里说明不变量的注释），把它判 SUSPECT 只会把 300 多条写对了地方的
 * 引用打成噪声，淹掉真正「指到空白/收尾括号」的假引用。纯注释区间单独计数（只计不判红）。
 */
export function isSubstantiveLine(line) {
  const trimmed = line.trim();
  if (trimmed === '') return false;
  return !CLOSING_ONLY.test(trimmed);
}

/** 注释行（按目标语言认标记：markdown 的 `#` 是标题不是注释，所以必须分语言）。 */
export function isCommentLine(line, extension) {
  const trimmed = line.trim();
  if (trimmed === '') return false;
  return commentPrefixesOf(extension).some(prefix => trimmed.startsWith(prefix));
}

function extensionOf(path) {
  const match = /\.([A-Za-z0-9]+)$/.exec(path);
  return match === null ? '' : match[1].toLowerCase();
}

function isRegularFile(absolute) {
  try {
    return statSync(absolute).isFile();
  } catch {
    return false;
  }
}

function toPosix(path) {
  return path.split(sep).join('/');
}

// —— 扫描面 ——————————————————————————————————————————————————————————
/** `docs/architecture` 这类目录（递归 .md）或 `docs/features/**\/*.md` 这类 glob → 相对路径列表。 */
export function globToRegExp(pattern) {
  const escaped = toPosix(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const body = escaped.replace(/\*\*\/?/g, '§').replace(/\*/g, '[^/]*').replace(/§/g, '.*');
  return new RegExp(`^${body}$`);
}

function walkMarkdown(absoluteDirectory, root) {
  const results = [];
  const stack = [absoluteDirectory];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.github') continue;
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) stack.push(absolute);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(toPosix(relative(root, absolute)));
      }
    }
  }
  return results;
}

/** 把 `--scan` 的若干目标（目录或 glob）展开成文档相对路径清单，去重排序。 */
export function resolveScanTargets(root, targets = DEFAULT_SCAN_TARGETS) {
  const collected = new Set();
  for (const target of targets) {
    const normalized = toPosix(target).replace(/^\.\//, '').replace(/\/$/, '');
    if (!normalized.includes('*')) {
      const absolute = resolve(root, normalized);
      if (!existsSync(absolute)) {
        throw new Error(`扫描目标不存在：${normalized}（相对扫描根 ${root}）`);
      }
      if (isRegularFile(absolute)) collected.add(toPosix(relative(root, absolute)));
      else for (const file of walkMarkdown(absolute, root)) collected.add(file);
      continue;
    }
    const pattern = globToRegExp(normalized);
    const base = normalized.split('/')[0];
    for (const file of walkMarkdown(resolve(root, base), root)) {
      if (pattern.test(file)) collected.add(file);
    }
  }
  return [...collected].sort();
}

// —— 引用抽取 ——————————————————————————————————————————————————————————
/**
 * 从一份文档里抽出所有 `路径:起-止` 与 `路径:单行`。
 * 返回 `{ reference, raw, target, from, to }`；`to` 单行引用时等于 `from`。
 */
export function extractReferences(text) {
  const lines = text.split('\n');
  const references = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    ANCHOR_PATTERN.lastIndex = 0;
    let match = ANCHOR_PATTERN.exec(line);
    while (match !== null) {
      const prefix = line.slice(Math.max(0, match.index - 3), match.index);
      // URL（`https://host/a.ts:12`）不是仓内路径；`://` 之后的东西一律不认。
      if (!prefix.includes('://')) {
        const raw = match[0];
        const from = Number(match[2]);
        const to = match[3] === undefined ? from : Number(match[3]);
        references.push({
          raw,
          reference: raw.replace(/^\.\//, ''),
          target: match[1].replace(/^\.\//, ''),
          from,
          to,
          docLine: index + 1,
        });
      }
      match = ANCHOR_PATTERN.exec(line);
    }
  }
  return references;
}

// —— 路径解析 ————————————————————————————————————————————————————————
/** 同名文件索引：`service.ts` → 仓库里所有同名文件的相对路径（用于「裸文件名」引用）。 */
export function buildFileNameIndex(root) {
  const index = new Map();
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) stack.push(join(current, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = toPosix(relative(root, join(current, entry.name)));
      const list = index.get(entry.name);
      if (list === undefined) index.set(entry.name, [relativePath]);
      else list.push(relativePath);
    }
  }
  for (const list of index.values()) list.sort();
  return index;
}

/**
 * 解析引用里的路径。四档：resolved / missing（→ BROKEN）/ ambiguous（不可解析，如实计数不判红）。
 * 顺序：① 仓库根相对（`services/api/src/app.ts`，裸 `README.md` 也先按根上那一份算）；
 * ② 相对当前文档所在目录（`../../packages/x.ts`）；③ **唯一后缀匹配**（`messages/store-pg.ts` →
 * `services/api/src/messages/store-pg.ts`、裸 `app.ts` → 全仓唯一的 app.ts）。文档里写相对子路径是
 * 既有习惯，直接判 BROKEN 会把 200 条写对了地方的引用算成「路径不存在」，噪声淹没真问题；
 * 同名多个时无法判断指的是哪一个，记 ambiguous 而不是瞎猜。
 * 注：裸 `README.md:440` 会落到根 README（272 行）而报越界，即使作者心里指的是
 * `deploy/postgres-cvm/README.md:440`——这不是误判，是**引用写得不唯一**：不加目录就没人能复原
 * 它指哪份文件，写全路径才算证据。
 */
export function resolveTarget({ root, docPath, target, fileIndex }) {
  const direct = resolve(root, target);
  if (target.startsWith('..') === false && isRegularFile(direct)) {
    return { status: 'resolved', relative: toPosix(relative(root, direct)) };
  }
  const fromDoc = resolve(root, dirname(docPath), target);
  if (isRegularFile(fromDoc)) return { status: 'resolved', relative: toPosix(relative(root, fromDoc)) };
  const suffix = `/${target}`;
  const candidates = (fileIndex.get(basename(target)) ?? [])
    .filter(candidate => candidate === target || candidate.endsWith(suffix))
    .filter(candidate => isRegularFile(join(root, candidate)));
  if (candidates.length === 1) return { status: 'resolved', relative: candidates[0] };
  if (candidates.length === 0) return { status: 'missing', relative: target };
  return { status: 'ambiguous', relative: target, candidates };
}

// —— 判定 ————————————————————————————————————————————————————————————
/**
 * 单条引用的判定。返回 `{ reason }` 或 `{ reason: null }`（通过），另带 `commentOnly`
 * 作为「引用指到注释块」的提示位（只计数不判红）。
 */
export function classifyReference({ lines, from, to, extension }) {
  if (from < 1 || to < from || to > lines.length) return { reason: OUT_OF_RANGE, lineCount: lines.length };
  const slice = lines.slice(from - 1, to);
  if (!slice.some(line => isSubstantiveLine(line))) return { reason: SUSPECT };
  const commentOnly = slice.every(line => !isSubstantiveLine(line) || isCommentLine(line, extension));
  return { reason: null, commentOnly };
}

/**
 * 全量扫描：返回 `{ findings, stats, unresolved }`。
 * `findings` 每条 = `{ reason, reference, target, path, owner, doc, docLine, detail }`；
 * 同一文档里同一条引用出现多次只记一条（按 doc + reference 去重）。
 */
export function collectFindings({
  root = TOOL_ROOT,
  targets = DEFAULT_SCAN_TARGETS,
  fileIndex = null,
  documents = null,
} = {}) {
  const index = fileIndex ?? buildFileNameIndex(root);
  const files = documents ?? resolveScanTargets(root, targets);
  const fileLines = new Map();
  const findings = [];
  const unresolved = [];
  const seen = new Set();
  const stats = {
    documents: files.length,
    candidates: 0,
    resolved: 0,
    deduped: 0,
    blankStart: 0,
    commentOnly: 0,
    counts: { [BROKEN]: 0, [OUT_OF_RANGE]: 0, [SUSPECT]: 0 },
  };
  const readLines = relativePath => {
    if (!fileLines.has(relativePath)) fileLines.set(relativePath, splitLines(readFileSync(join(root, relativePath), 'utf8')));
    return fileLines.get(relativePath);
  };
  for (const docPath of files) {
    const text = readFileSync(join(root, docPath), 'utf8');
    for (const reference of extractReferences(text)) {
      stats.candidates += 1;
      const resolved = resolveTarget({ root, docPath, target: reference.target, fileIndex: index });
      if (resolved.status !== 'resolved') {
        if (resolved.status === 'ambiguous') {
          // 不可解析≠不存在：如实记账，不冒充 BROKEN，也不静默丢弃。
          unresolved.push({ doc: docPath, docLine: reference.docLine, reference: reference.reference, candidates: resolved.candidates });
          continue;
        }
        const key = `${docPath}|${reference.reference}|${BROKEN}`;
        if (seen.has(key)) { stats.deduped += 1; continue; }
        seen.add(key);
        stats.counts[BROKEN] += 1;
        findings.push({
          reason: BROKEN,
          reference: reference.reference,
          target: reference.target,
          path: resolved.relative,
          owner: ownerOf(reference.target),
          doc: docPath,
          docLine: reference.docLine,
          detail: '路径在仓库里找不到',
        });
        continue;
      }
      stats.resolved += 1;
      const lines = readLines(resolved.relative);
      if (lines[reference.from - 1] !== undefined && lines[reference.from - 1].trim() === '') stats.blankStart += 1;
      const verdict = classifyReference({
        lines,
        from: reference.from,
        to: reference.to,
        extension: extensionOf(resolved.relative),
      });
      if (verdict.reason === null) {
        if (verdict.commentOnly) stats.commentOnly += 1;
        continue;
      }
      const key = `${docPath}|${reference.reference}|${verdict.reason}`;
      if (seen.has(key)) { stats.deduped += 1; continue; }
      seen.add(key);
      stats.counts[verdict.reason] += 1;
      findings.push({
        reason: verdict.reason,
        reference: reference.reference,
        target: reference.target,
        path: resolved.relative,
        owner: ownerOf(resolved.relative),
        doc: docPath,
        docLine: reference.docLine,
        detail: verdict.reason === OUT_OF_RANGE
          ? `行号超出文件行数（该文件 ${verdict.lineCount} 行）`
          : '区间内没有任何实质内容行（全空行／全右括号）',
      });
    }
  }
  findings.sort((left, right) => (
    REASONS.indexOf(left.reason) - REASONS.indexOf(right.reason)
    || left.path.localeCompare(right.path)
    || left.reference.localeCompare(right.reference)
    || left.doc.localeCompare(right.doc)
  ));
  return { findings, stats, unresolved };
}

/** 谁该修：按被引用路径的归属分组，方便派活；判断不了就给 repo。 */
export function ownerOf(targetPath) {
  const path = toPosix(targetPath);
  if (path.startsWith('services/api/src/')) return 'api-server';
  if (path.startsWith('apps/')) return 'admin-web';
  if (path.startsWith('miniprogram/')) return 'miniprogram';
  if (path.startsWith('packages/')) return 'contracts';
  if (path.startsWith('.github/')) return 'ci';
  if (path.startsWith('docs/')) return 'docs';
  if (path.startsWith('tools/')) return 'tooling';
  if (path.startsWith('deploy/')) return 'deploy';
  return 'repo';
}

// —— 基线 ————————————————————————————————————————————————————————————
export const baselineKey = entry => `${entry.path}|${entry.reason}|${entry.reference}`;

/** 读基线；文件不存在按空基线处理（首次落地前的合法状态），坏 JSON 直接抛。 */
export function loadBaseline(root, baselinePath = DEFAULT_BASELINE) {
  const absolute = resolve(root, baselinePath);
  if (!existsSync(absolute)) return { path: baselinePath, entries: [], missing: true };
  const parsed = JSON.parse(readFileSync(absolute, 'utf8'));
  const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
  for (const entry of entries) {
    if (typeof entry.path !== 'string' || typeof entry.reference !== 'string' || typeof entry.reason !== 'string') {
      throw new Error(`基线条目缺字段（需要 path / reason / reference）：${JSON.stringify(entry)}`);
    }
    if (!REASONS.includes(entry.reason)) throw new Error(`基线条目的 reason 不是三类之一：${entry.reason}`);
  }
  return { path: baselinePath, entries, missing: false };
}

/** 把全量 findings 与基线比对：返回新增（未登记）与陈旧（登记了但已不命中）。 */
export function partitionByBaseline(findings, entries) {
  const known = new Map();
  for (const entry of entries) {
    const key = baselineKey(entry);
    known.set(key, (known.get(key) ?? 0) + 1);
  }
  const fresh = [];
  const covered = [];
  for (const finding of findings) {
    const key = baselineKey(finding);
    const remaining = known.get(key) ?? 0;
    if (remaining > 0) {
      known.set(key, remaining - 1);
      covered.push(finding);
    } else {
      fresh.push(finding);
    }
  }
  const stale = [];
  for (const entry of entries) {
    const key = baselineKey(entry);
    const remaining = known.get(key) ?? 0;
    if (remaining > 0) {
      known.set(key, remaining - 1);
      stale.push(entry);
    }
  }
  return { fresh, covered, stale };
}

/** 生成基线 JSON 文本（键序固定，便于 diff 审阅）。 */
export function renderBaseline(findings) {
  const entries = findings.map(finding => ({
    path: finding.path,
    reason: finding.reason,
    owner: finding.owner,
    reference: finding.reference,
  }));
  const document = {
    schema_version: 1,
    note: '文档手写行号的已知遗留（BROKEN／OUT_OF_RANGE／SUSPECT）。--strict 只报本文件之外的**新增**；条目修好后会变「陈旧」，tests/unit/doc-anchors-guard.test.mjs 会点名要求删除。⛔ 不要为了让门禁变绿而把新问题追加进来。',
    generated_by: 'node tools/verify-doc-anchors.mjs --emit-baseline',
    entries,
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

// —— CLI ——————————————————————————————————————————————————————————————
const USAGE = 'usage: node tools/verify-doc-anchors.mjs [--strict] [--scan <目录或glob>]... [--baseline <路径>] [--root <目录>] [--emit-baseline | --write-baseline]';
const KNOWN_FLAGS = new Set(['--strict', '--scan', '--baseline', '--root', '--emit-baseline', '--write-baseline']);
const MAX_PRINTED = 300;

export function parseArgs(argv) {
  const options = { strict: false, scan: [], baseline: DEFAULT_BASELINE, root: TOOL_ROOT, emit: false, write: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const [flag, inline] = argument.includes('=') ? [argument.slice(0, argument.indexOf('=')), argument.slice(argument.indexOf('=') + 1)] : [argument, undefined];
    if (!KNOWN_FLAGS.has(flag)) throw new Error(`未知参数：${argument}\n${USAGE}`);
    const value = () => {
      if (inline !== undefined) return inline;
      index += 1;
      if (index >= argv.length) throw new Error(`${flag} 缺少取值\n${USAGE}`);
      return argv[index];
    };
    if (flag === '--strict') options.strict = true;
    else if (flag === '--emit-baseline') options.emit = true;
    else if (flag === '--write-baseline') options.write = true;
    else if (flag === '--scan') options.scan.push(value());
    else if (flag === '--baseline') options.baseline = value();
    else if (flag === '--root') options.root = resolve(value());
  }
  if (options.emit && options.write) throw new Error('--emit-baseline 与 --write-baseline 只能二选一');
  if (options.scan.length === 0) options.scan = [...DEFAULT_SCAN_TARGETS];
  return options;
}

function describe(finding) {
  return `${finding.reason} ${finding.doc}:${finding.docLine} → ${finding.reference}（${finding.detail}；owner=${finding.owner}）`;
}

export function main(argv = process.argv.slice(2), streams = { log: console.log, error: console.error }) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    streams.error(error.message);
    return 2;
  }
  const { findings, stats, unresolved } = collectFindings({ root: options.root, targets: options.scan });
  if (options.emit) {
    process.stdout.write(renderBaseline(findings));
    return 0;
  }
  if (options.write) {
    const absolute = resolve(options.root, options.baseline);
    writeFileSync(absolute, renderBaseline(findings));
    streams.log(`WRITE: 已写 ${options.baseline}（${findings.length} 条）。基线是**人工裁决**的结果，提交前逐条看过；新问题不要往里加。`);
    return 0;
  }
  const baseline = loadBaseline(options.root, options.baseline);
  const { fresh, covered, stale } = partitionByBaseline(findings, baseline.entries);
  // dry-run 打全量清单（人工排查用）；--strict 只打归纳，失败清单走 stderr——
  // 否则上百条历史遗留会把台账工具的 PASS 行淹掉，看门禁的人反而找不到真信号。
  if (!options.strict) {
    const printed = findings.slice(0, MAX_PRINTED);
    for (const finding of printed) streams.log(describe(finding));
    if (findings.length > printed.length) streams.log(`… 另有 ${findings.length - printed.length} 条未打印（清单同上格式）`);
  }
  printSummary(streams, { stats, unresolved, findings, fresh, covered, stale, baseline, strict: options.strict });
  if (baseline.missing) streams.log(`NOTE: 基线 ${options.baseline} 不存在，按空基线处理（等于所有问题都算新增）。`);
  if (stale.length > 0) {
    streams.log(`STALE: ${stale.length} 条基线已不再命中（引用被修好或路径改名）——删掉这些条目，否则基线会慢慢变成免罚名单：`);
    for (const entry of stale.slice(0, 20)) streams.log(`  · ${entry.reference}（${entry.reason}，owner=${entry.owner ?? '未标'}）`);
  }
  const failure = options.strict && fresh.length > 0;
  if (failure) {
    streams.error(`FAIL: 文档行号闸门未通过（基线之外新增 ${fresh.length} 条）`);
    for (const finding of fresh.slice(0, 40)) streams.error(`  · ${describe(finding)}`);
    return 1;
  }
  if (options.strict) streams.log('PASS: --strict 下没有基线之外的新增（基线内条目只计数、不判红；陈旧条目见 STALE）');
  return 0;
}

function printSummary(streams, { stats, unresolved, findings, fresh, covered, stale, baseline, strict }) {
  const { counts } = stats;
  streams.log(`SCAN: 文档 ${stats.documents} 份；抽出「路径:行号」引用 ${stats.candidates} 条（解析成功 ${stats.resolved} 条、同名多文件无法唯一解析 ${unresolved.length} 条不计红${stats.deduped > 0 ? `、同文档重复 ${stats.deduped} 条已去重` : ''}）`);
  streams.log(`COUNT: BROKEN ${counts[BROKEN]} / OUT_OF_RANGE ${counts[OUT_OF_RANGE]} / SUSPECT ${counts[SUSPECT]}（合计 ${findings.length} 条；另只计数不判红：区间首行为空行 ${stats.blankStart} 条、区间全是注释行 ${stats.commentOnly} 条）`);
  streams.log(`BASELINE: ${baseline.path} 登记 ${baseline.entries.length} 条；本次命中 ${covered.length} 条、基线外新增 ${fresh.length} 条、陈旧 ${stale.length} 条`);
  if (strict) streams.log('MODE: --strict（只在新增加非零时 exit 1）');
  else streams.log('MODE: dry-run（只打印，不判退出码）');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
