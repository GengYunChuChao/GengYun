// R31 · 「测试里写死 `源文件:行号`」的扫描器（守卫与被改写用例共用）。
//
// 为什么单独成模块：守卫（`test-line-anchors-guard.test.mjs`）要报「哪一行、锚的是什么、目标文件
// 现在还剩几行」；被改写的用例要「按源码实时算行号」。两边必须用**同一套**判定，否则守卫绿而判据
// 已经脆了、或者反过来。
//
// ── 判定口径（四层过滤，逐层收窄）─────────────────────────────────────────────
//
// 1. **形状**：`<path>.<ext>:<line>` 或 `<path>.<ext>:<line>-<endLine>`，ext ∈ ANCHOR_EXTENSIONS。
//    `path` 可带目录（`services/api/src/profile/service.ts:61`），也可只有裸文件名尾巴
//    （`profile/service.ts:61`，靠「唯一后缀」解析到真实文件）。正则字面量里的转义写法
//    （`services\/api\/src\/routes\/ocr\.ts:2-8`）同样算 —— 它匹配的仍是「输出文本里的行号」。
//
// 2. **注释里的命中一律不算**：注释不会因为源码改行而变红，只是可能过期，属文档卫生。
//    把 149 条注释算进来会让豁免清单膨胀到两百条，守卫就废了 —— 这正是
//    `migration-pin-guard.test.mjs` 里「豁免一多守卫就会被顺手加一条拖垮」那条教训。
//
// 3. **幻影锚点不算**：目标文件不存在，或行号超过目标文件当前行数。它们不是「写死了一个真实坐标」，
//    而是负控制（`ledger-pg.ts:99999`「源码里根本没有这一行」）或合成夹具（`nc1-fake-store-pg.ts:3`）。
//
// 4. **文字位置不算**：剩下的「真实坐标」还要看它落在什么位置：
//      * `assert-operand` —— `assert.*` 的**判定实参**（不是最后那个消息实参）。行号漂移 ⇒ 断言红。**必须改**。
//      * `registry-ref` —— 对象 / 表条目里 `ref:` 的值（豁免表、插值登记表）。行号漂移 ⇒ stale ⇒ 红。**必须改**。
//      * `regex-anchor` —— 正则字面量里的转义锚点。它存在的唯一目的就是匹配「输出里的行号」，
//        行号一漂移就匹配不上 ⇒ 红。**必须改或登记**。
//      * `prose` —— 只出现在失败消息、`reason`/`why`/`label` 文案、`note()`/`say()` 日志里。
//        行号漂移**不会**变红（只是文字过期）。本片把它记进清点表，但**不拦**：否则每写一句
//        「口径见 errors.ts:28-40」都要来登记一次豁免，守卫会被噪音淹没。
//
// 只有前三类位置会判红；`prose` 与 `comment` / `phantom` 只进清点读数。
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根（本文件在 `tests/unit/` 下）。 */
export const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** 判定为「源码」的扩展名：只有这些才可能「源代码改行」。
 *
 * 刻意**不含** `.md` / `.json`：契约 JSON 由生成器整段重排（`openapi.json` 每次重生成行号必变），
 * 文档行号是「引用出处」而不是「语句站点」，两者要的治理方式不同（见证据页「下一批」）。
 */
export const ANCHOR_EXTENSIONS = ['ts', 'tsx', 'mts', 'cts', 'mjs', 'cjs', 'js', 'jsx', 'sql', 'vue'];

/** 判红的位置类型。 */
export const BLOCKING_POSITIONS = ['assert-operand', 'registry-ref', 'regex-anchor'];

const SEG_CODE = 0;
const SEG_STRING = 1;
const SEG_TEMPLATE = 2;
const SEG_REGEX = 3;
const SEG_COMMENT = 4;

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;

/** 这些紧邻符号之后的 `/` 是正则开头，不是除号。 */
const REGEX_PREFIX_PUNCT = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>', '/',
]);
/** 这些关键字之后的 `/` 是正则开头。 */
const REGEX_PREFIX_WORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else',
  'yield', 'await',
]);

/** `assert.*` 的「消息实参」下标（0 基）：从该下标起是给人看的文案，不参与判定。 */
const ASSERT_MESSAGE_ARG = {
  fail: 0,
  ok: 1,
  notOk: 1,
  ifError: 1,
  equal: 2,
  notEqual: 2,
  strictEqual: 2,
  notStrictEqual: 2,
  deepEqual: 2,
  notDeepEqual: 2,
  deepStrictEqual: 2,
  notDeepStrictEqual: 2,
  match: 2,
  doesNotMatch: 2,
  throws: 2,
  doesNotThrow: 2,
  rejects: 2,
  doesNotReject: 2,
};

/** 这些被调用者的实参全是给人看的文字（日志 / 标签 / 用例名），命中不当判据。 */
const TEXTUAL_CALLEES = new Set([
  'note', 'say', 'log', 'warn', 'info', 'debug', 'error', 'check', 'test', 'it', 'describe', 'console.log',
  'console.warn', 'console.info', 'console.error', 'console.debug',
]);

/** 注册表条目的字段名：这些字段的值是「语句站点」，配套断言会反向核对，漂移即 stale。 */
const REGISTRY_FIELDS = new Set(['ref', 'refs', 'site', 'sites']);

/**
 * 把源码逐字符分类成：代码 / 字符串 / 模板文本 / 正则 / 注释。
 *
 * 为什么不用正则硬扫：本仓测试里有大量「字符串里含 `//`」「正则里含 `/*`」「模板里嵌模板」的写法，
 * 用 `/\/\/.*$/` 去掉注释会把字符串截断，锚点判定就会错行。这个 lexer 足够小（一个循环 + 一个
 * 模板栈），换来的是「注释里的命中绝不误判成代码」这条硬口径。
 *
 * @param {string} source
 * @returns {Uint8Array} 与 source 等长，每字符一个 SEG_* 值
 */
export function lexSegments(source) {
  const n = source.length;
  const kind = new Uint8Array(n);
  let i = 0;
  let braceDepth = 0;
  /** 进入过的模板 `${` 在当时的 braceDepth，用来判断哪个 `}` 回到模板文本。 */
  const templateStack = [];
  let templateMode = false;
  /** 上一个有意义的代码记号（符号或标识符），用来消歧 `/` 是正则还是除号。 */
  let prevToken = '';

  const mark = (from, to, value) => {
    for (let k = from; k < to && k < n; k += 1) kind[k] = value;
  };

  while (i < n) {
    if (templateMode) {
      const start = i;
      let interpolation = false;
      while (i < n) {
        const ch = source[i];
        if (ch === '\\') {
          i += 2;
          continue;
        }
        if (ch === '`') {
          i += 1;
          templateMode = false;
          break;
        }
        if (ch === '$' && source[i + 1] === '{') {
          interpolation = true;
          break;
        }
        i += 1;
      }
      // 只标记到这之前的文本：`${` 两个字符本身属于**代码**（花括号要参与深度计数，
      // 否则 `d` 会被插值里的 `}` 带成负数，实参下标就数错了 —— 这是踩过的坑）。
      mark(start, i, SEG_TEMPLATE);
      if (interpolation) {
        templateStack.push(braceDepth);
        braceDepth += 1;
        i += 2;
        templateMode = false;
      }
      prevToken = '`';
      continue;
    }

    const ch = source[i];

    // 注释
    if (ch === '/' && source[i + 1] === '/') {
      const start = i;
      while (i < n && source[i] !== '\n') i += 1;
      mark(start, i, SEG_COMMENT);
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i = Math.min(n, i + 2);
      mark(start, i, SEG_COMMENT);
      continue;
    }

    // 字符串（含 `'` / `"`：单独成段，不算代码）
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const start = i;
      i += 1;
      while (i < n) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i += 1;
          break;
        }
        if (source[i] === '\n') break; // 未闭合：不越过行界，避免污染整个文件
        i += 1;
      }
      mark(start, i, SEG_STRING);
      prevToken = quote;
      continue;
    }

    // 模板字面量起点
    if (ch === '`') {
      i += 1;
      mark(i - 1, i, SEG_TEMPLATE);
      templateMode = true;
      continue;
    }

    // 正则 / 除号
    if (ch === '/') {
      const regexStart = prevToken === '' || REGEX_PREFIX_PUNCT.has(prevToken) || REGEX_PREFIX_WORDS.has(prevToken);
      if (!regexStart) {
        i += 1;
        prevToken = '/';
        continue;
      }
      const start = i;
      i += 1;
      let inClass = false;
      while (i < n) {
        const c = source[i];
        if (c === '\\') {
          i += 2;
          continue;
        }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) {
          i += 1;
          break;
        } else if (c === '\n') break;
        i += 1;
      }
      while (i < n && /[a-z]/.test(source[i])) i += 1; // flags
      mark(start, i, SEG_REGEX);
      prevToken = '/';
      continue;
    }

    // 括号与记号
    if (ch === '{') {
      braceDepth += 1;
      prevToken = '{';
      i += 1;
      continue;
    }
    if (ch === '}') {
      braceDepth -= 1;
      prevToken = '}';
      i += 1;
      if (templateStack.length > 0 && templateStack[templateStack.length - 1] === braceDepth) {
        templateStack.pop();
        templateMode = true;
      }
      continue;
    }

    // 标识符
    if (IDENT_START.test(ch)) {
      const start = i;
      while (i < n && IDENT_PART.test(source[i])) i += 1;
      prevToken = source.slice(start, i);
      continue;
    }

    if (!/\s/.test(ch)) prevToken = ch;
    i += 1;
  }

  return kind;
}

/** 1 基行号（`index` 之前的换行数 + 1）。 */
export function lineAt(source, index) {
  let line = 1;
  for (let k = 0; k < index && k < source.length; k += 1) if (source[k] === '\n') line += 1;
  return line;
}

/** 正则字面量里的 `\/` / `\.` 还原成路径原样；字符串字面量里的 `\\` 也还原。 */
function unescapePath(raw, segment) {
  if (segment === 'regex') return raw.replace(/\\(.)/g, '$1');
  return raw;
}

/**
 * 扫描一段源码里的「`源文件:行号` 字面量」。
 *
 * @param {string} source
 * @param {{extensions?: string[], delimiter?: string}} [options]
 * @returns {Array<{index:number,line:number,path:string,rawPath:string,startLine:number,endLine:number|null,text:string,segment:'literal'|'regex'|'comment'}>}
 */
export function scanAnchors(source, options = {}) {
  const extensions = options.extensions ?? ANCHOR_EXTENSIONS;
  const kind = lexSegments(source);
  // 路径分隔符两侧都可能带转义（正则里的 `\/`、`\.`），所以分隔符写成 `\\?[./]`。
  const extAlternation = extensions.join('|');
  const pattern = new RegExp(
    `([A-Za-z0-9_@$-]+(?:\\\\?[./][A-Za-z0-9_@$-]+)*?\\\\?\\.(?:${extAlternation})):(\\d+)(?:-(\\d+))?`,
    'g',
  );
  const hits = [];
  for (const match of source.matchAll(pattern)) {
    const index = match.index ?? 0;
    const segmentKind = kind[index];
    const segment = segmentKind === SEG_COMMENT ? 'comment'
      : segmentKind === SEG_REGEX ? 'regex' : 'literal';
    hits.push({
      index,
      line: lineAt(source, index),
      path: unescapePath(match[1], segment),
      rawPath: match[1],
      startLine: Number(match[2]),
      endLine: match[3] === undefined ? null : Number(match[3]),
      text: match[0],
      segment,
    });
  }
  return hits;
}

/** 仓库相对路径（POSIX 分隔符）。 */
export function toPosix(path) {
  return path.split(sep).join('/');
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.cache']);

/** 遍历仓库里的文件（跳过依赖与构建产物），返回 POSIX 相对路径。 */
export function listRepoFiles(root = ROOT) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(join(dir, entry.name));
      } else if (entry.isFile()) {
        files.push(toPosix(relative(root, join(dir, entry.name))));
      }
    }
  };
  walk(root);
  return files;
}

const textCache = new Map();

/** 读文件（带缓存），返回行数。文件不存在 ⇒ null。 */
export function sourceLineCount(repoPath, root = ROOT) {
  const key = `${root}::${repoPath}`;
  if (textCache.has(key)) return textCache.get(key);
  let count = null;
  try {
    textCache.set(key, null);
    const text = readFileSync(join(root, repoPath), 'utf8');
    count = text === '' ? 0 : text.split('\n').length;
    if (text.endsWith('\n')) count -= 1;
    textCache.set(key, count);
  } catch {
    textCache.set(key, null);
  }
  return count;
}

/** 清空缓存（守卫的非空证明里会临时改仓库，行数必须重新读）。 */
export function resetSourceCache() {
  textCache.clear();
}

/**
 * 把锚点里的路径解析成仓库内真实文件。
 *
 * 两级：① 直接当仓库相对路径；② 当「尾巴」在所有仓库文件里找唯一后缀匹配。
 * 只有唯一匹配才认（`store.ts` 这种裸名在本仓有多个同名文件，多匹配 = 歧义，不猜 —— 报 `ambiguous`）。
 *
 * @returns {{repoPath:string}|{ambiguous:string[]}|{missing:true}}
 */
export function resolveAnchorPath(anchorPath, repoFiles) {
  const isSet = repoFiles instanceof Set;
  const has = (file) => (isSet ? repoFiles.has(file) : repoFiles.includes(file));
  if (has(anchorPath)) return { repoPath: anchorPath };
  const files = isSet ? [...repoFiles] : repoFiles;
  const suffix = `/${anchorPath}`;
  const matches = files.filter((file) => file.endsWith(suffix));
  if (matches.length === 1) return { repoPath: matches[0] };
  if (matches.length > 1) return { ambiguous: matches };
  return { missing: true };
}

/** 命中是否落在注释 / 幻影 / 真实坐标。 */
export function classifyAnchor(hit, repoFiles, root = ROOT) {
  if (hit.segment === 'comment') return { kind: 'comment' };
  const resolved = resolveAnchorPath(hit.path, repoFiles);
  if (resolved.missing) return { kind: 'phantom', why: '目标文件不存在' };
  if (resolved.ambiguous) return { kind: 'ambiguous', candidates: resolved.ambiguous };
  const lines = sourceLineCount(resolved.repoPath, root);
  if (lines === null) return { kind: 'phantom', why: '目标文件读不到' };
  if (hit.startLine < 1 || hit.startLine > lines) {
    return { kind: 'phantom', why: `行号 ${hit.startLine} 超过 ${resolved.repoPath} 的 ${lines} 行` };
  }
  if (hit.endLine !== null && hit.endLine > lines) {
    return { kind: 'phantom', why: `区间末行 ${hit.endLine} 超过 ${resolved.repoPath} 的 ${lines} 行` };
  }
  return { kind: 'real', repoPath: resolved.repoPath, lines };
}

/** 跳过空白（不含换行也算跳过）。 */
function skipSpaceBack(source, from, kind) {
  let k = from;
  while (k >= 0 && (/\s/.test(source[k]) || kind[k] === SEG_COMMENT)) k -= 1;
  return k;
}

/**
 * 找命中点所在的最内层调用表达式，返回 `{callee, argIndex, open}`。
 *
 * 实现：在**代码段**里向前数括号找配对的 `(`，再读它前面那条标识符链（`assert.deepEqual` 这类）。
 * 括号只在代码段计数 —— 字符串里的 `(` 不会把深度带偏；模板插值的 `${` / `}` 算代码（见 lexer 里的坑注释）。
 *
 * @returns {{callee:string, argIndex:number, open:number}|null}
 */
export function enclosingCall(source, index, kind = lexSegments(source)) {
  let depth = 0;
  let open = -1;
  for (let k = index - 1; k >= 0; k -= 1) {
    const seg = kind[k];
    if (seg === SEG_STRING || seg === SEG_COMMENT || seg === SEG_REGEX || seg === SEG_TEMPLATE) continue;
    const ch = source[k];
    if (ch === ')') depth += 1;
    else if (ch === '(') {
      if (depth === 0) {
        open = k;
        break;
      }
      depth -= 1;
    }
  }
  if (open < 0) return null;

  // 读被调用者：`a.b.c` / `a` / `assert`
  let k = skipSpaceBack(source, open - 1, kind);
  const endName = k + 1;
  let startName = k;
  while (startName >= 0) {
    const ch = source[startName];
    if (IDENT_PART.test(ch) || (ch === '.' && startName > 0)) startName -= 1;
    else break;
  }
  const callee = source.slice(startName + 1, endName);
  if (callee === '') return { callee: '', argIndex: argIndexAt(source, open, index, kind), open };

  // 数实参下标：从 `(` 到命中点之间的顶层逗号数
  return { callee, argIndex: argIndexAt(source, open, index, kind), open };
}

/** 从 `(` 到 `index` 之间的顶层逗号数（字符串/注释/正则/模板文本里的逗号不算）。 */
function argIndexAt(source, open, index, kind) {
  let argIndex = 0;
  let depth = 0;
  for (let q = open + 1; q < index; q += 1) {
    const seg = kind[q];
    if (seg === SEG_STRING || seg === SEG_COMMENT || seg === SEG_REGEX || seg === SEG_TEMPLATE) continue;
    const ch = source[q];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) argIndex += 1;
  }
  return argIndex;
}

/**
 * 调用链（内 → 外）。
 *
 * 为什么不是「最内层一个」：`assert.ok(hit[0].includes('x.ts:12'))` 里最内层是 `.includes(`，
 * 但被判定的锚点其实是 `assert.ok` 的**判定实参**。只取最内层会把本片最关键的那条
 * （`sql-column-coverage.test.mjs` 的 NC5/NC6）判成散文。
 */
export function enclosingCalls(source, index, kind = lexSegments(source)) {
  const chain = [];
  let cursor = index;
  for (let guard = 0; guard < 64; guard += 1) {
    const call = enclosingCall(source, cursor, kind);
    if (call === null) break;
    chain.push(call);
    cursor = call.open;
  }
  return chain;
}

/** 命中点是否紧跟在 `ref:` / `site:` 这类注册表字段名之后（值与字段名之间可隔引号/模板反引号）。 */
export function isRegistryFieldValue(source, index, kind = lexSegments(source)) {
  let k = skipSpaceBack(source, index - 1, kind);
  // 跳过值自己的开引号：`ref: '...'` 里命中的是字符串内容，紧前那个字符是 `'`。
  if (k >= 0 && (source[k] === "'" || source[k] === '"' || source[k] === '`')) {
    k = skipSpaceBack(source, k - 1, kind);
  }
  if (k < 1 || source[k] !== ':') return false;
  k = skipSpaceBack(source, k - 1, kind);
  const endName = k + 1;
  let startName = k;
  while (startName >= 0 && IDENT_PART.test(source[startName])) startName -= 1;
  const field = source.slice(startName + 1, endName);
  return REGISTRY_FIELDS.has(field);
}

/**
 * 判定命中的「位置类型」：`assert-operand` / `registry-ref` / `regex-anchor` / `prose`。
 *
 * 判红位置 = `assert.*` 的判定实参（沿调用链**从内往外**找，见 `enclosingCalls` 的理由）、
 * 注册表 `ref:` 的值、正则字面量里的转义锚点。其余（失败消息、reason 文案、日志）是散文。
 *
 * @returns {{position:string, callee?:string, argIndex?:number}}
 */
export function classifyPosition(source, hit, kind = lexSegments(source)) {
  if (hit.segment === 'regex') return { position: 'regex-anchor' };
  if (isRegistryFieldValue(source, hit.index, kind)) return { position: 'registry-ref' };
  const chain = enclosingCalls(source, hit.index, kind);
  let innermost = null;
  for (const call of chain) {
    const assertMatch = /^assert(?:\.(\w+))?$/.exec(call.callee);
    if (assertMatch === null) {
      innermost ??= call;
      continue;
    }
    const method = assertMatch[1] ?? 'ok';
    const messageArg = ASSERT_MESSAGE_ARG[method] ?? 2;
    if (call.argIndex < messageArg) return { position: 'assert-operand', callee: call.callee, argIndex: call.argIndex };
    // 落在**消息实参**上就到此为止：再往外找会把「回调里的 assert 消息」误判成外层
    // `assert.rejects(fn, matcher)` 的 matcher（踩过的坑）。
    return { position: 'prose', callee: call.callee, argIndex: call.argIndex };
  }
  if (innermost === null) return { position: 'prose' };
  return { position: 'prose', callee: innermost.callee, argIndex: innermost.argIndex };
}

/** `tests/**` 下所有可能含断言的脚本文件。 */
export function listTestFiles(root = ROOT) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(join(dir, entry.name));
      } else if (entry.isFile() && /\.(mjs|cjs|js|ts)$/.test(entry.name)) {
        files.push(toPosix(relative(root, join(dir, entry.name))));
      }
    }
  };
  walk(join(root, 'tests'));
  return files.sort();
}

/**
 * 全仓扫描：把每个命中分类完并汇总。
 *
 * @param {{root?:string, skip?:Set<string>}} [options]
 * @returns {{blocked:Array<object>, prose:Array<object>, comments:number, phantoms:Array<object>, ambiguous:Array<object>, files:number}}
 */
export function scanTestFilesForHardcodedAnchors(options = {}) {
  const root = options.root ?? ROOT;
  const skip = options.skip ?? new Set();
  const repoFiles = new Set(listRepoFiles(root));
  const blocked = [];
  const prose = [];
  const phantoms = [];
  const ambiguous = [];
  let comments = 0;
  const files = listTestFiles(root);
  for (const file of files) {
    if (skip.has(file)) continue;
    const source = readFileSync(join(root, file), 'utf8');
    const kind = lexSegments(source);
    for (const hit of scanAnchors(source)) {
      const verdict = classifyAnchor(hit, repoFiles, root);
      if (verdict.kind === 'comment') {
        comments += 1;
        continue;
      }
      if (verdict.kind === 'phantom') {
        phantoms.push({ file, ...hit, why: verdict.why });
        continue;
      }
      if (verdict.kind === 'ambiguous') {
        ambiguous.push({ file, ...hit, candidates: verdict.candidates });
        continue;
      }
      const position = classifyPosition(source, hit, kind);
      const record = {
        file,
        line: hit.line,
        text: hit.text,
        segment: hit.segment,
        repoPath: verdict.repoPath,
        lines: verdict.lines,
        startLine: hit.startLine,
        endLine: hit.endLine,
        ...position,
      };
      if (BLOCKING_POSITIONS.includes(position.position)) blocked.push(record);
      else prose.push(record);
    }
  }
  return { blocked, prose, comments, phantoms, ambiguous, files: files.length };
}

/** 仓库是否自带 git（`git ls-files` 只是加速，失败不影响正确性）。 */
export function gitTrackedFiles(root = ROOT) {
  try {
    const out = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return out.split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

/** 文件是否存在且是普通文件。 */
export function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
