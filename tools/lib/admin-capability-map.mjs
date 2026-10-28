/**
 * 后台能力图的机器重算核心：从源码结构里数出「服务端注册了哪些 admin 面」「UI 有没有入口」。
 *
 * 为什么需要它：`docs/architecture/admin-console-capability-map.md` 里那两句读数
 * （「12 个后端有面、UI 无入口」「`apps/admin/src` 全树对 `/admin/registrations` 的引用数为 0」）
 * 已经被代码证伪——注册/限制两页早就实现了。散文读数靠人复写必然腐烂，本模块把它变成
 * **可重算 + 可判红**的事实：解析源码结构，输出每面一行的判定表与汇总，供
 * `tools/verify-admin-capability-map.mjs` 写回文档、在 CI 里逐项比对。
 *
 * 解析口径（**结构优先**，不是整文件正则一把抓）：
 *   1. 词法层先切出「注释区间」与「字符串区间」，把注释与字符串内容替换成空格（保留换行 ⇒
 *      行号不漂）得到 `code` 掩码。所有结构正则只跑在 `code` 上，路径字面量只在字符串区间里读。
 *   2. 服务端面：在 `code` 上找 `app.<method>(`，从 `(` 做括号配平切出**整条注册语句**，
 *      第一实参里的模板字面量给出路径；语句里 `<familyVar>.<slot>(` 给出 operationId
 *      （经 `families.ts` 的 `operations` 表映射），`<familyVar>.readGuards|writeGuards` 给出 scope；
 *      非家族语句用 `const <v> = methodOf(services.<dom>, '<operationId>')` 绑定表定 operationId，
 *      `requireScope(<expr>)` 定 scope（字面量 / `OPS_SCOPES.<k>` / 大写常量）。
 *   3. UI 入口：**不认「视图里出现过这个路径字符串」**——视图里的路径几乎全是 label、注释、
 *      导航文案（注册页 17 处命中全是这种），按字面量判定会把「删掉视图」判成绿的。
 *      入口判据是**调用链**：`.vue` 的 import 名字 → `lib/*.mjs` 里某个函数体引用了该族路径
 *      （字面量或 `*_PATH` 常量）。文件级「引用」另算一列（`uiFiles`），供人核查，不参与入口判定。
 *      ⚠ 这条判据只证明「有调用链」，**不证明「调用点可达」**：客户端函数真发 `POST`、但只在
 *      永不被调用的死代码里被调一次，同样算入口（实测变异：`noUiEntry 2→1` 而能力没变）。
 *      因此 `noUiEntry` 只能当**缺口下界**（真缺口 ≥ 报出来的数）：`noUiEntry === 0` 不等于
 *      「能力齐」，只等于「本扫描器没看见缺口」——别把它读成验收结论。
 *
 * 失败模式：任何一处解析不出来（路径模板未解析、operationId 对不上、scope 解析不出、
 * 扫出来 0 条），一律抛 `AdminCapabilityMapError`——**绝不静默返回空集合**，否则「空集合 ⇒
 * 一切相等 ⇒ 闸门永远绿」就成了一条假绿通道。
 *
 * 纯函数：零依赖、不联网、不读 git、不写盘（只在本仓库目录里读源码与契约）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/** 解析失败一律抛这个，调用方据此判红（而不是「读到空就通过」）。 */
export class AdminCapabilityMapError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AdminCapabilityMapError';
  }
}

/** `API_PREFIX` 在 `services/api/src/routes/admin.ts` 里的实参值（本工具只读，不改）。 */
export const API_PREFIX = '/api/v1';

/** 判定三档；`dead-button` = UI 引用了、路由与契约里都没有的路径。 */
export const VERDICTS = Object.freeze(['ui-entry', 'no-ui-entry', 'dead-button']);

/** 文档标记块（`--update` 只重写块内，块外散文由人负责）。 */
export const DOC_BEGIN = '<!-- admin-capability-map:begin -->';
export const DOC_END = '<!-- admin-capability-map:end -->';
/** 空名单在文档里的写法（`--check` 按同一字面量比对）。 */
export const EMPTY_LIST = '（空）';

/** 源码与文档的相对路径（相对仓库根）。 */
export const SOURCE_PATHS = Object.freeze({
  adminRoutes: 'services/api/src/routes/admin.ts',
  families: 'services/api/src/admin/families.ts',
  opsScopes: 'services/api/src/admin/ops/service.ts',
  auditCatalog: 'services/api/src/admin/audit/catalog.ts',
  postService: 'services/api/src/admin/posts/service.ts',
  contractOperations: 'packages/contracts/operations.json',
  doc: 'docs/architecture/admin-console-capability-map.md',
  uiRoot: 'apps/admin/src',
});

/** 家族槽位 → `FamilyDescriptor.operations` 的键（`read` 槽对应 `list`）。 */
const FAMILY_SLOT_TO_OPERATION_KEY = Object.freeze({
  read: 'list',
  create: 'create',
  get: 'get',
  edit: 'edit',
  publish: 'publish',
  withdraw: 'withdraw',
});

const HTTP_METHODS = Object.freeze(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
const UI_FILE_SUFFIXES = Object.freeze(['.mjs', '.ts', '.vue']);

// ---------------------------------------------------------------- 词法层

/**
 * 单遍扫出注释区间与字符串区间，并给出两份等长文本：
 *   `code`      —— 注释与字符串内容都替换成空格（换行保留），供结构正则使用；
 *   `text`      —— 原文（返回值里直接给调用方）。
 * 字符串区间带 `contentStart/contentEnd`，路径字面量只在这段里读。
 */
export function scanSource(text) {
  const length = text.length;
  const code = text.split('');
  const strings = [];
  const comments = [];
  let i = 0;
  while (i < length) {
    const char = text[i];
    const next = i + 1 < length ? text[i + 1] : '';
    if (char === '/' && next === '/') {
      const start = i;
      while (i < length && text[i] !== '\n') i += 1;
      comments.push({ start, end: i });
    } else if (char === '/' && next === '*') {
      const start = i;
      i += 2;
      while (i < length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i = Math.min(length, i + 2);
      comments.push({ start, end: i });
    } else if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      const start = i;
      i += 1;
      while (i < length) {
        if (text[i] === '\\') {
          i += 2;
          continue;
        }
        if (text[i] === quote) {
          i += 1;
          break;
        }
        if (quote !== '`' && text[i] === '\n') break; // 未闭合的单行字符串：到此为止
        i += 1;
      }
      const end = Math.min(i, length);
      const closed = text[end - 1] === quote;
      strings.push({
        start,
        end,
        quote,
        contentStart: start + 1,
        contentEnd: closed ? end - 1 : end,
      });
    } else {
      i += 1;
    }
  }
  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) if (code[k] !== '\n') code[k] = ' ';
  };
  for (const span of comments) blank(span.start, span.end);
  for (const span of strings) blank(span.start, span.end);
  return { text, code: code.join(''), strings, comments };
}

/** 行号索引：`lineOf(index)` 返回 1 基行号。 */
export function makeLineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') starts.push(i + 1);
  return {
    lineOf(index) {
      let low = 0;
      let high = starts.length - 1;
      while (low < high) {
        const mid = (low + high + 1) >> 1;
        if (starts[mid] <= index) low = mid;
        else high = mid - 1;
      }
      return low + 1;
    },
  };
}

function isInComment(comments, index) {
  for (const span of comments) if (index >= span.start && index < span.end) return true;
  return false;
}

/** 从 `open`（值为左括号的下标）起做括号配平，返回对应右括号下标；配不平返回 -1。 */
function matchBracket(code, open, left = '(', right = ')') {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    const char = code[i];
    if (char === left) depth += 1;
    else if (char === right) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 把 `[start, end)` 按深度 0 的逗号切成若干区间（跳过字符串内容已由 `code` 保证）。 */
function splitTopLevel(code, start, end) {
  const parts = [];
  let depth = 0;
  let from = start;
  for (let i = start; i < end; i += 1) {
    const char = code[i];
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth -= 1;
    else if (char === ',' && depth === 0) {
      parts.push([from, i]);
      from = i + 1;
    }
  }
  parts.push([from, end]);
  return parts;
}

/** 读 `<key>: '<value>'` 形式的键值对（只认起始引号落在字符串区间里的那些）。 */
function readStringPairs(scanned, start, end) {
  const pairs = new Map();
  const body = scanned.text.slice(start, end);
  const pattern = /([A-Za-z_$][\w$]*)\s*:\s*'/g;
  let match = pattern.exec(body);
  while (match) {
    const quoteAt = start + match.index + match[0].length - 1;
    if (!isInComment(scanned.comments, quoteAt)) {
      const span = scanned.strings.find(candidate => candidate.start === quoteAt);
      if (span) pairs.set(match[1], scanned.text.slice(span.contentStart, span.contentEnd));
    }
    match = pattern.exec(body);
  }
  return pairs;
}

/** 读 `const|export const <name> = '<value>'` 形式的常量（在原文上定位，注释里的命中剔除）。 */
function readStringConsts(scanned) {
  const consts = new Map();
  const pattern = /\b(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?=')/g;
  let match = pattern.exec(scanned.text);
  while (match) {
    const quoteAt = match.index + match[0].length;
    if (!isInComment(scanned.comments, match.index)) {
      const span = scanned.strings.find(candidate => candidate.start === quoteAt);
      if (span) consts.set(match[1], scanned.text.slice(span.contentStart, span.contentEnd));
    }
    match = pattern.exec(scanned.text);
  }
  return consts;
}

// ---------------------------------------------------------------- 服务端：路由与家族

/**
 * 解析 `services/api/src/routes/admin.ts` 里注册的每条 admin 路由。
 * 返回 `[{ method, registeredPath, path, line, start, end }]`（`path` 把 `:id` 归一成 `{id}`）。
 */
export function parseAdminRoutes(source, { file = SOURCE_PATHS.adminRoutes } = {}) {
  const scanned = scanSource(source);
  const lines = makeLineIndex(source);
  const routes = [];
  const pattern = new RegExp(`\\bapp\\s*\\.\\s*(${HTTP_METHODS.join('|')})\\s*\\(`, 'g');
  let match = pattern.exec(scanned.code);
  while (match) {
    const open = match.index + match[0].length - 1;
    const close = matchBracket(scanned.code, open);
    if (close < 0) {
      throw new AdminCapabilityMapError(
        `${file}:${lines.lineOf(match.index)} 的 app.${match[1]}(…) 括号配不平，无法切出注册语句`,
      );
    }
    const args = splitTopLevel(scanned.code, open + 1, close);
    const [pathFrom, pathTo] = args[0] ?? [open + 1, close];
    const span = scanned.strings.find(
      candidate => candidate.start >= pathFrom && candidate.start < pathTo,
    );
    if (!span) {
      throw new AdminCapabilityMapError(
        `${file}:${lines.lineOf(match.index)} 的 app.${match[1]}(…) 第一实参不是字符串/模板字面量，无法读出路由路径`,
      );
    }
    const raw = scanned.text.slice(span.contentStart, span.contentEnd);
    const registeredPath = resolveRoutePath(raw, file, lines.lineOf(match.index));
    routes.push({
      method: match[1].toUpperCase(),
      registeredPath,
      path: normalizePathTemplate(registeredPath),
      line: lines.lineOf(match.index),
      start: match.index,
      end: close + 1,
      raw,
    });
    match = pattern.exec(scanned.code);
  }
  if (routes.length === 0) {
    throw new AdminCapabilityMapError(
      `${file}: 一条 app.<method>(…) 都没扫到——解析器与源码形状脱节，拒绝返回空集合`,
    );
  }
  const seen = new Set();
  for (const route of routes) {
    const key = `${route.method} ${route.path}`;
    if (seen.has(key)) {
      throw new AdminCapabilityMapError(`${file}:${route.line} 重复注册 ${key}`);
    }
    seen.add(key);
  }
  return routes;
}

/** 把 `${API_PREFIX}/admin/x` 还原成 `/admin/x`；解析不出就抛错（不猜）。 */
function resolveRoutePath(raw, file, line) {
  const withPrefix = raw.replace(/\$\{\s*API_PREFIX\s*\}/g, API_PREFIX);
  // 只认 `${API_PREFIX}`：别的插值一律判红。否则 `${MYSTERY}/admin/x` 会被截成 `/admin/x`，
  // 静默把一条来路不明的路由算进能力图——那正是这道闸门最不该犯的错。
  if (withPrefix.includes('${')) {
    throw new AdminCapabilityMapError(
      `${file}:${line} 的路由模板含无法解析的插值（只认 \${API_PREFIX}）：${raw}`,
    );
  }
  const at = withPrefix.indexOf('/admin');
  if (at < 0) {
    throw new AdminCapabilityMapError(`${file}:${line} 的路由模板里没有 /admin 路径：${raw}`);
  }
  const sliced = withPrefix.slice(at);
  if (sliced.includes('${')) {
    throw new AdminCapabilityMapError(`${file}:${line} 的路由模板未解析（含 ${'${'}…}）：${raw}`);
  }
  const cleaned = sliced.replace(/[?#].*$/, '').replace(/\/+$/, '');
  if (cleaned === '') throw new AdminCapabilityMapError(`${file}:${line} 的路由路径为空：${raw}`);
  return cleaned;
}

/** `/admin/jobs/:id/cancel` → `/admin/jobs/{id}/cancel`（与契约里的写法对齐）。 */
export function normalizePathTemplate(path) {
  return path.replace(/:([A-Za-z_$][\w$]*)/g, '{$1}');
}

/** 路径所属族 = `/admin/<第一段>`。 */
export function familyOfPath(path) {
  const match = /^\/admin\/([^/{}]+)/.exec(path);
  return match ? match[1] : null;
}

/** 解析 `families.ts` 的四个 `FamilyDescriptor`（含 `FAMILIES` 汇总）。 */
export function parseFamilyDescriptors(source, { file = SOURCE_PATHS.families } = {}) {
  const scanned = scanSource(source);
  const lines = makeLineIndex(source);
  const descriptors = new Map();
  const pattern = /\bexport\s+const\s+([A-Za-z_$][\w$]*)\s*:\s*FamilyDescriptor\s*=\s*\{/g;
  let match = pattern.exec(scanned.code);
  while (match) {
    const open = match.index + match[0].length - 1;
    const close = matchBracket(scanned.code, open, '{', '}');
    if (close < 0) {
      throw new AdminCapabilityMapError(
        `${file}:${lines.lineOf(match.index)} 的 ${match[1]} 描述符花括号配不平`,
      );
    }
    const fields = readStringPairs(scanned, open, close);
    const operationsAt = scanned.code.indexOf('operations', open);
    let operations = new Map();
    if (operationsAt >= 0 && operationsAt < close) {
      const braceOpen = scanned.code.indexOf('{', operationsAt);
      const braceClose = matchBracket(scanned.code, braceOpen, '{', '}');
      if (braceOpen < 0 || braceClose < 0 || braceClose > close) {
        throw new AdminCapabilityMapError(
          `${file}:${lines.lineOf(operationsAt)} 的 ${match[1]}.operations 花括号配不平`,
        );
      }
      operations = readStringPairs(scanned, braceOpen, braceClose);
    }
    for (const key of ['family', 'path', 'readScope', 'writeScope']) {
      if (!fields.has(key)) {
        throw new AdminCapabilityMapError(`${file}:${lines.lineOf(match.index)} 的 ${match[1]} 缺 ${key}`);
      }
    }
    if (operations.size !== Object.keys(FAMILY_SLOT_TO_OPERATION_KEY).length) {
      throw new AdminCapabilityMapError(
        `${file}:${lines.lineOf(match.index)} 的 ${match[1]}.operations 应有 6 个槽位，实得 ${operations.size}`,
      );
    }
    descriptors.set(match[1], {
      constName: match[1],
      family: fields.get('family'),
      path: fields.get('path'),
      readScope: fields.get('readScope'),
      writeScope: fields.get('writeScope'),
      operations: Object.fromEntries(operations),
      line: lines.lineOf(match.index),
    });
    match = pattern.exec(scanned.code);
  }
  if (descriptors.size === 0) {
    throw new AdminCapabilityMapError(
      `${file}: 一个 FamilyDescriptor 都没扫到——解析器与源码形状脱节，拒绝返回空集合`,
    );
  }
  return descriptors;
}

/** 解析 `OPS_SCOPES = Object.freeze({ … })`。 */
export function parseOpsScopes(source, { file = SOURCE_PATHS.opsScopes } = {}) {
  const scanned = scanSource(source);
  const lines = makeLineIndex(source);
  const at = new RegExp('\\bOPS_SCOPES\\b\\s*[:=]').exec(scanned.code);
  if (!at) throw new AdminCapabilityMapError(`${file}: 找不到 OPS_SCOPES 定义`);
  const open = scanned.code.indexOf('{', at.index);
  const close = matchBracket(scanned.code, open, '{', '}');
  if (open < 0 || close < 0) throw new AdminCapabilityMapError(`${file}: OPS_SCOPES 花括号配不平`);
  const scopes = readStringPairs(scanned, open, close);
  if (scopes.size === 0) {
    throw new AdminCapabilityMapError(`${file}:${lines.lineOf(at.index)} OPS_SCOPES 解析出 0 条`);
  }
  return Object.fromEntries(scopes);
}

/** 收集若干文件里的 `export const <NAME> = '<value>'` 常量（scope 常量用）。 */
export function parseScopeConstants(sources) {
  const constants = new Map();
  for (const [file, source] of Object.entries(sources)) {
    const scanned = scanSource(source);
    void file;
    for (const [name, value] of readStringConsts(scanned)) {
      if (/^[a-z][a-z_]*:[a-z][a-z_]*$/.test(value)) constants.set(name, value);
    }
  }
  if (constants.size === 0) {
    throw new AdminCapabilityMapError('一个 scope 常量都没扫到（期望 AUDIT_LOG_SCOPE 之类）');
  }
  return constants;
}

/**
 * 把路由 + 家族描述符 + scope 表拼成 operation 行。
 * `[{ operationId, method, path, registeredPath, scope, family, routeFile, routeLine }]`
 */
export function buildOperations({
  adminSource,
  familiesSource,
  opsScopeSource,
  scopeConstantSources = {},
  adminFile = SOURCE_PATHS.adminRoutes,
  familiesFile = SOURCE_PATHS.families,
}) {
  const routes = parseAdminRoutes(adminSource, { file: adminFile });
  const descriptors = parseFamilyDescriptors(familiesSource, { file: familiesFile });
  const opsScopes = parseOpsScopes(opsScopeSource);
  const scopeConstants = parseScopeConstants(scopeConstantSources);
  const scanned = scanSource(adminSource);
  const lines = makeLineIndex(adminSource);

  // `const sources = familyOps(SOURCE_FAMILY);`
  const familyVars = new Map();
  const familyVarPattern = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*familyOps\(\s*([A-Za-z_$][\w$]*)\s*\)/g;
  let match = familyVarPattern.exec(scanned.code);
  while (match) {
    const descriptor = descriptors.get(match[2]);
    if (!descriptor) {
      throw new AdminCapabilityMapError(
        `${adminFile}:${lines.lineOf(match.index)} 的 familyOps(${match[2]}) 找不到对应描述符`,
      );
    }
    familyVars.set(match[1], descriptor);
    match = familyVarPattern.exec(scanned.code);
  }

  // `const listCategories = methodOf(services.ops, 'listAdminCategories');`
  const opVars = new Map();
  const opVarPattern = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*methodOf\(\s*services\.[A-Za-z_$][\w$]*\s*,\s*'/g;
  match = opVarPattern.exec(scanned.text);
  while (match) {
    if (!isInComment(scanned.comments, match.index)) {
      const quoteAt = match.index + match[0].length - 1;
      const span = scanned.strings.find(candidate => candidate.start === quoteAt);
      if (!span) {
        throw new AdminCapabilityMapError(
          `${adminFile}:${lines.lineOf(match.index)} 的 methodOf(…) operationId 读不出来`,
        );
      }
      opVars.set(match[1], scanned.text.slice(span.contentStart, span.contentEnd));
    }
    match = opVarPattern.exec(scanned.text);
  }

  const operations = routes.map(route => {
    const block = scanned.code.slice(route.start, route.end);
    const familyVar = [...familyVars.keys()].find(
      name => new RegExp(`\\b${name}\\s*\\.\\s*[A-Za-z_$][\\w$]*\\s*\\(`).test(block),
    );
    if (familyVar) {
      const descriptor = familyVars.get(familyVar);
      const slotPattern = new RegExp(
        `\\b${familyVar}\\s*\\.\\s*(${Object.keys(FAMILY_SLOT_TO_OPERATION_KEY).join('|')})\\s*\\(`,
      );
      const slot = slotPattern.exec(block);
      if (!slot) {
        throw new AdminCapabilityMapError(
          `${adminFile}:${route.line} 用了 ${familyVar} 但认不出槽位调用（read/create/get/edit/publish/withdraw）`,
        );
      }
      const operationId = descriptor.operations[FAMILY_SLOT_TO_OPERATION_KEY[slot[1]]];
      if (!operationId) {
        throw new AdminCapabilityMapError(
          `${adminFile}:${route.line} 的槽位 ${slot[1]} 在 ${descriptor.constName}.operations 里没有对应 operationId`,
        );
      }
      const guardsPattern = new RegExp(`\\b${familyVar}\\s*\\.\\s*(read|write)Guards\\b`);
      const guards = guardsPattern.exec(block);
      if (!guards) {
        throw new AdminCapabilityMapError(
          `${adminFile}:${route.line} 用了 ${familyVar} 但认不出 readGuards/writeGuards`,
        );
      }
      const scope = guards[1] === 'read' ? descriptor.readScope : descriptor.writeScope;
      assertScope(scope, `${adminFile}:${route.line} ${operationId}`);
      return {
        operationId,
        method: route.method,
        path: route.path,
        registeredPath: route.registeredPath,
        scope,
        family: descriptor.family,
        routeFile: adminFile,
        routeLine: route.line,
      };
    }

    const opVar = [...opVars.keys()].find(name => new RegExp(`\\b${name}\\s*\\(`).test(block));
    if (!opVar) {
      throw new AdminCapabilityMapError(
        `${adminFile}:${route.line}（${route.method} ${route.path}）既没有家族槽位调用、也没有 methodOf 绑定，认不出 operationId`,
      );
    }
    const operationId = opVars.get(opVar);
    const scopeCall = /requireScope\s*\(/.exec(block);
    if (!scopeCall) {
      throw new AdminCapabilityMapError(
        `${adminFile}:${route.line}（${route.method} ${route.path}）没有 requireScope(…)，无法判定 scope`,
      );
    }
    const scopeOpen = scopeCall.index + scopeCall[0].length - 1;
    const scopeClose = matchBracket(block, scopeOpen);
    if (scopeClose < 0) {
      throw new AdminCapabilityMapError(`${adminFile}:${route.line} 的 requireScope(…) 括号配不平`);
    }
    const scopeArgument = adminSource
      .slice(route.start + scopeOpen + 1, route.start + scopeClose)
      .trim();
    const scope = resolveScopeExpression(scopeArgument, { opsScopes, scopeConstants, line: route.line, adminFile });
    return {
      operationId,
      method: route.method,
      path: route.path,
      registeredPath: route.registeredPath,
      scope,
      family: familyOfPath(route.path) ?? 'unknown',
      routeFile: adminFile,
      routeLine: route.line,
    };
  });

  const ids = new Set();
  for (const operation of operations) {
    if (!operation.operationId) {
      throw new AdminCapabilityMapError(`${adminFile}:${operation.routeLine} 的 operationId 为空`);
    }
    if (ids.has(operation.operationId)) {
      throw new AdminCapabilityMapError(
        `${adminFile}:${operation.routeLine} 的 operationId ${operation.operationId} 重复注册`,
      );
    }
    ids.add(operation.operationId);
  }
  return operations;
}

function resolveScopeExpression(expression, { opsScopes, scopeConstants, line, adminFile }) {
  const literal = /^'([^']*)'$/.exec(expression);
  if (literal) {
    assertScope(literal[1], `${adminFile}:${line}`);
    return literal[1];
  }
  const opsScope = /^OPS_SCOPES\.([A-Za-z_$][\w$]*)$/.exec(expression);
  if (opsScope) {
    const value = opsScopes[opsScope[1]];
    if (!value) {
      throw new AdminCapabilityMapError(
        `${adminFile}:${line} 的 requireScope(OPS_SCOPES.${opsScope[1]}) 在 OPS_SCOPES 里查不到`,
      );
    }
    return value;
  }
  const constant = /^[A-Z][A-Z0-9_]*$/.exec(expression);
  if (constant) {
    const value = scopeConstants.get(expression);
    if (!value) {
      throw new AdminCapabilityMapError(
        `${adminFile}:${line} 的 requireScope(${expression}) 常量值查不到（不在已知 scope 常量表里）`,
      );
    }
    return value;
  }
  throw new AdminCapabilityMapError(
    `${adminFile}:${line} 的 requireScope(${expression}) 形态未知，拒绝猜 scope`,
  );
}

function assertScope(scope, where) {
  if (typeof scope !== 'string' || !/^[a-z][a-z_]*:[a-z][a-z_]*$/.test(scope)) {
    throw new AdminCapabilityMapError(`${where} 的 scope 不合法：${JSON.stringify(scope)}`);
  }
}

// ---------------------------------------------------------------- UI 侧

/** `.vue` 只把 `<script>` 段当可扫描区（模板/样式里的文案不算代码）。 */
export function scriptOnlyMask(text, file) {
  if (!file.endsWith('.vue')) return text;
  const mask = text.split('').map(char => (char === '\n' ? '\n' : ' '));
  const pattern = /<script\b[^>]*>([\s\S]*?)<\/script>/g;
  let match = pattern.exec(text);
  let found = 0;
  while (match) {
    found += 1;
    const start = match.index + match[0].indexOf('>') + 1;
    const end = start + match[1].length;
    for (let i = start; i < end; i += 1) mask[i] = text[i];
    match = pattern.exec(text);
  }
  if (found === 0) {
    throw new AdminCapabilityMapError(`${file}: <script> 段没找到，无法扫描视图的调用链`);
  }
  return mask.join('');
}

/**
 * 从一段文本里读出所有 `/admin/<family>…` **HTTP 路径**字面量（只看字符串区间）。
 *
 * 为什么还要判「像不像 HTTP 路径」：`apps/admin/src` 里大量注释与元数据写着
 * `services/api/src/admin/human-review.ts:68-89` 这种**文件路径**，它的 `/admin/` 片段与
 * 真实请求路径同形。若不区分，死按钮列表会凭空长出 `/admin/human-review`、`/admin/ops`。
 * 判据：`/admin` 前一个字符不是路径字符（即前文不是 `src`、`api` 这类目录名），
 * 除非前文正好以 `/api/v1` 结尾（`/api/v1/admin/x` 是该放行的写法）。
 */
export function collectAdminPathLiterals(text, file) {
  const scanned = scanSource(text);
  const lines = makeLineIndex(text);
  const found = [];
  for (const span of scanned.strings) {
    const content = text.slice(span.contentStart, span.contentEnd);
    const pattern = /\/admin\/([A-Za-z0-9_-]+)/g;
    let match = pattern.exec(content);
    while (match) {
      const prefix = content.slice(0, match.index);
      const previous = prefix.slice(-1);
      const afterVersionPrefix = prefix.endsWith(`${API_PREFIX}/`) || prefix.endsWith(`${API_PREFIX}`);
      if (/[A-Za-z0-9_.-]/.test(previous) && !afterVersionPrefix) {
        match = pattern.exec(content);
        continue;
      }
      found.push({
        path: `/admin/${match[1]}`,
        family: match[1],
        line: lines.lineOf(span.contentStart + match.index),
        file,
      });
      match = pattern.exec(content);
    }
  }
  return found;
}

/** 顶层声明切块：`function|export function|const|export const|async function` 开头的行。 */
function topLevelBlocks(scanned, file) {
  const lines = makeLineIndex(scanned.text);
  const pattern = /^(?:export\s+)?(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)\s*\(|const\s+([A-Za-z_$][\w$]*)\s*=|let\s+([A-Za-z_$][\w$]*)\s*=|class\s+([A-Za-z_$][\w$]*))/gm;
  const blocks = [];
  let match = pattern.exec(scanned.code);
  while (match) {
    const name = match[1] ?? match[2] ?? match[3] ?? match[4];
    blocks.push({
      name,
      exported: /^export\s/.test(match[0]),
      start: match.index,
      line: lines.lineOf(match.index),
      file,
    });
    match = pattern.exec(scanned.code);
  }
  for (let i = 0; i < blocks.length; i += 1) {
    blocks[i].end = i + 1 < blocks.length ? blocks[i + 1].start : scanned.code.length;
  }
  return blocks;
}

// ================================================================ 词法小工具

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 原始文本上的顶层切分（识别单引号 / 双引号 / 模板字面量与 `{}`、`()`、`[]` 嵌套）。
 * 结构判定不能用 `code` 掩码做——掩码里的字符串已经变成空格，形参名、属性名会一起丢掉。
 */
function splitRaw(text, separator = ',') {
  const parts = [];
  const stack = [];
  let depth = 0;
  let templateBraces = 0;
  let pieceStart = 0;
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    const top = stack[stack.length - 1];
    if (top === "'" || top === '"') {
      if (char === '\\') { i += 2; continue; }
      if (char === top) stack.pop();
      i += 1;
      continue;
    }
    if (top === '`' && templateBraces === 0) {
      if (char === '\\') { i += 2; continue; }
      if (char === '`') stack.pop();
      else if (char === '$' && text[i + 1] === '{') { templateBraces = 1; i += 2; continue; }
      i += 1;
      continue;
    }
    if (char === "'" || char === '"') { stack.push(char); i += 1; continue; }
    if (char === '`') { stack.push('`'); i += 1; continue; }
    if (templateBraces > 0) {
      if (char === '{') templateBraces += 1;
      else if (char === '}') templateBraces -= 1;
      i += 1;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth -= 1;
    else if (depth === 0 && char === separator) {
      parts.push(text.slice(pieceStart, i));
      pieceStart = i + 1;
    }
    i += 1;
  }
  const tail = text.slice(pieceStart);
  if (tail.trim() !== '' || parts.length > 0) parts.push(tail);
  return parts.filter(part => part.trim() !== '');
}

/** 函数体起点（签名右括号之后）：形参默认值不算语句，避免 `mode = ''` 被当成赋值。 */
function fnBodyStart(fn) {
  return typeof fn.bodyStart === 'number' ? fn.bodyStart : fn.start;
}

/** 原始文本上从 `(` 找配对的 `)`。 */
function matchParenRaw(text, openAt) {
  const stack = [];
  let templateBraces = 0;
  for (let i = openAt; i < text.length; i += 1) {
    const char = text[i];
    const top = stack[stack.length - 1];
    if (top === "'" || top === '"') {
      if (char === '\\') { i += 1; continue; }
      if (char === top) stack.pop();
      continue;
    }
    if (top === '`' && templateBraces === 0) {
      if (char === '\\') { i += 1; continue; }
      if (char === '`') stack.pop();
      else if (char === '$' && text[i + 1] === '{') { templateBraces = 1; i += 1; }
      continue;
    }
    if (char === "'" || char === '"' || char === '`') { stack.push(char); continue; }
    if (templateBraces > 0) {
      if (char === '{') templateBraces += 1;
      else if (char === '}') templateBraces -= 1;
      continue;
    }
    if (char === '(') stack.push('(');
    else if (char === ')') {
      stack.pop();
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/** `code` 掩码上的语句结尾：优先深度 0 的 `;`，其次深度 0 的换行。 */
function statementEnd(code, start, limit) {
  let depth = 0;
  let newlineAt = -1;
  for (let i = start; i < limit; i += 1) {
    const char = code[i];
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth -= 1;
    else if (depth === 0 && char === ';') return i;
    else if (depth === 0 && char === '\n' && newlineAt < 0) newlineAt = i;
  }
  return newlineAt < 0 ? limit : newlineAt;
}

/** 形参表：既支持对象解构（`{ a, b = null }`），也支持位置参数（`baseUrl, path, options = {}`）。 */
function parseSignature(masked, blockStart, blockEnd) {
  const openAt = masked.indexOf('(', blockStart);
  if (openAt < 0 || openAt >= blockEnd) return { destructured: false, params: [] };
  const closeAt = matchParenRaw(masked, openAt);
  if (closeAt < 0 || closeAt > blockEnd) return { destructured: false, params: [], closeAt: -1 };
  const inner = masked.slice(openAt + 1, closeAt).trim();
  const destructured = inner.startsWith('{');
  const body = destructured ? inner.slice(1, inner.lastIndexOf('}')) : inner;
  const params = [];
  for (const piece of splitRaw(body)) {
    const text = piece.trim();
    if (text === '' || text.startsWith('...')) continue;
    const equation = text.indexOf('=');
    const rawName = (equation < 0 ? text : text.slice(0, equation)).trim();
    if (!/^[A-Za-z_$][\w$]*$/.test(rawName)) continue;
    params.push({ name: rawName, defaultValue: equation < 0 ? null : text.slice(equation + 1).trim() });
  }
  return { destructured, params, closeAt };
}

/** 对象字面量的顶层属性 → Map(prop → 表达式文本)。 */
function parseObjectLiteral(text) {
  const props = new Map();
  const inner = text.trim().replace(/^\{/, '').replace(/\}$/, '');
  for (const piece of splitRaw(inner)) {
    const entry = piece.trim();
    if (entry === '' || entry.startsWith('...')) continue;
    const colon = entry.indexOf(':');
    if (colon < 0) {
      if (/^[A-Za-z_$][\w$]*$/.test(entry)) props.set(entry, entry);
      continue;
    }
    const key = entry.slice(0, colon).trim();
    if (/^[A-Za-z_$][\w$]*$/.test(key)) props.set(key, entry.slice(colon + 1).trim());
  }
  return props;
}

/** 对象字面量里是否有「来源未知」的展开（`{ ...options }`）：这类字面量缺的属性可能是有的。 */
function hasUnresolvedSpread(text) {
  if (typeof text !== 'string' || !text.trim().startsWith('{')) return false;
  const inner = text.trim().replace(/^\{/, '').replace(/\}$/, '');
  for (const piece of splitRaw(inner)) {
    const entry = piece.trim();
    if (!entry.startsWith('...')) continue;
    const source = entry.slice(3).trim();
    if (!/^[A-Za-z_$][\w$]*$/.test(source)) return true;
    // `...常量名` 也当作未知：模块里的常量值不是对象字面量就不展开。
    if (!/^[A-Z_][A-Z0-9_]*$/.test(source)) return true;
  }
  return false;
}

function isPathValue(value) {
  return typeof value === 'string' && /^(?:\/api\/v1)?\/admin(?:\/|$)/.test(value);
}

const ABSENT = Object.freeze({ kind: 'absent' });
/** 「可能有、也可能没有」的值：调用点用 `{...options}` 展开时，属性表里看不到的键。
 *
 * 它渲染成带 \u0001 前缀的段，由 urlEvidenceFor 展开成「含该段」与「不含该段」两种路径模板，
 * 这样 `getSource({id})` 既认领 `GET /admin/sources/{id}`，也不会把 list 的读取算掉。
 */
function maybeValue(name) {
  return { kind: 'maybe', name };
}
const BASE = Object.freeze({ kind: 'base' });
const BASE_NAME_PATTERN = /^(?:base|baseUrl|apiBase|apiBaseUrl|API_BASE_URL|apiPrefix|API_PREFIX|prefix)$/;
const FETCH_CALLEES = new Set(['fetch', 'fetchImpl', 'doFetch', 'doFetchImpl', 'doFetchJson']);

function unknownValue(name) {
  return { kind: 'unknown', name };
}

function renderValue(value) {
  if (value.kind === 'str') return value.value;
  if (value.kind === 'base') return '\u0000';
  if (value.kind === 'absent') return '';
  // 调用的返回值：没有字符串证据时退化成段占位（`{normalizePostId}`），而不是整段消失——
  // 否则 `${normalizedId}` 会把路径段吞掉，变成 `/admin/posts/hide` 这种错路径。
  if (value.kind === 'call') return value.name ? `{${value.name}}` : '';
  if (value.kind === 'maybe') return `\u0001{${value.name}}`;
  return `{${value.name}}`;
}

/**
 * 把求值出来的原始 URL 收敛成 `/admin/...` 路径模板：去掉 base 前缀、查询串与多余斜杠。
 * 认不出 `/admin` 就返回 `null`——**不猜**。这同时是 M1 类「常量改名重构」的护栏：
 * `ADMIN_ROOT_PATH='/admin'` 与 `/posts` 会先拼成 `/admin/posts` 再收敛，不会退回族名匹配。
 */
export function finalizeUrlPath(raw) {
  if (typeof raw !== 'string' || raw === '') return null;
  let text = raw;
  const baseAt = text.lastIndexOf('\u0000');
  if (baseAt >= 0) text = text.slice(baseAt + 1);
  text = text.split('?')[0];
  text = text.replace(/\/{2,}/g, '/');
  if (!/^\/admin(?:\/|$)/.test(text)) return null;
  text = text.replace(/\/+$/, '');
  return text === '' ? '/admin' : text;
}

/**
 * 把「可能有」的路径段展开成两种模板：含该段、不含该段。
 *
 * `fetchFamilyItem` 的 `buildFamilyUrl(baseUrl, path, { id })` 里 `id` 来自调用点的
 * `{...options, id}`，静态看不到 —— 于是同一份证据既可能是 `/admin/sources/{id}`（有 id），
 * 也可能退化成 `/admin/sources`。两种都保留，交由 operation 级的段比较去认领。
 */
export function expandOptionalSegments(raw) {
  if (typeof raw !== 'string' || raw === '') return [];
  if (!raw.includes('\u0001')) return [raw];
  const segments = raw.split('/');
  const keep = segments.map(segment => (segment.includes('\u0001') ? segment.split('\u0001').join('') : segment));
  const drop = segments.filter(segment => !segment.includes('\u0001'));
  const variants = [];
  for (const variant of [keep.join('/'), drop.join('/')]) {
    const trimmed = variant.replace(/\/{2,}/g, '/');
    if (trimmed !== '' && !variants.includes(trimmed)) variants.push(trimmed);
  }
  return variants;
}

// ================================================================ 模块图 + 符号求值

/** 从 `from` 解析相对 import 到仓内文件路径（非相对依赖一律返回 null）。 */
function resolveSpecifier(fromFile, specifier, modules) {
  if (!specifier.startsWith('.')) return null;
  const segments = fromFile.split('/').slice(0, -1);
  for (const piece of specifier.split('/')) {
    if (piece === '' || piece === '.') continue;
    if (piece === '..') segments.pop();
    else segments.push(piece);
  }
  const candidate = segments.join('/');
  return modules.has(candidate) ? candidate : null;
}

function buildModules(files) {
  const modules = new Map();
  for (const { path: file, text } of files) {
    const masked = scriptOnlyMask(text, file);
    const scanned = scanSource(masked);
    // 模板区 = 去掉 `<script>` 段之后的文本（判「视图是否真的被挂载」用）。
    const template = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, chunk => chunk.replace(/[^\n]/g, ' '));
    modules.set(file, {
      file,
      text,
      masked,
      template,
      scanned,
      blocks: topLevelBlocks(scanned, file),
      imports: readImports(scanned, masked, file),
      functions: new Map(),
      literals: new Set(
        scanned.strings
          .filter(span => span.quote !== '`')
          .map(span => masked.slice(span.contentStart, span.contentEnd)),
      ),
    });
  }
  for (const module of modules.values()) {
    for (const block of module.blocks) {
      const head = module.scanned.code.slice(block.start, block.start + 200);
      const isFunction = /\bfunction\b/.test(head) || /=\s*(?:async\s+)?\(/.test(head) || /=\s*async\b/.test(head);
      if (!isFunction || module.functions.has(block.name)) continue;
      const signature = parseSignature(module.masked, block.start, module.scanned.code.length);
      module.functions.set(block.name, {
        name: block.name,
        exported: block.exported,
        start: block.start,
        end: block.end,
        line: block.line,
        module,
        params: signature.params,
        destructured: signature.destructured,
        bodyStart: signature.closeAt >= 0 ? signature.closeAt + 1 : block.start,
      });
    }
  }
  return modules;
}

function createEvaluator(modules) {
  const constCache = new Map();

  /** 只在「声明处 + import 边」上找常量值；找不到就是 null，绝不按名字跨模块借光。 */
  function resolveConst(file, name, seen = new Set()) {
    const key = `${file}#${name}`;
    if (constCache.has(key)) return constCache.get(key);
    if (seen.has(key)) return null;
    seen.add(key);
    const module = modules.get(file);
    if (!module) return null;
    const pattern = new RegExp(`(?:^|\\n)[ \\t]*(?:export[ \\t]+)?const[ \\t]+${escapeRegExp(name)}[ \\t]*=`, 'g');
    const match = pattern.exec(module.scanned.code);
    let value = null;
    if (match) {
      const start = match.index + match[0].length;
      const end = statementEnd(module.scanned.code, start, module.scanned.code.length);
      const expression = module.masked.slice(start, end).trim().replace(/;$/, '');
      const literal = /^'([^']*)'$/.exec(expression) ?? /^"([^"]*)"$/.exec(expression);
      if (literal) value = literal[1];
      else if (/^[A-Za-z_$][\w$]*$/.test(expression)) {
        value = resolveConst(file, expression, seen) ?? resolveImported(file, name, seen);
      } else {
        value = foldConstExpression(file, expression, seen);
      }
    }
    if (value === null) value = resolveImported(file, name, seen);
    constCache.set(key, value);
    return value;
  }

  /**
   * 由别的常量拼出来的常量：`const POSTS_PATH = ADMIN_ROOT_PATH + '/posts'` 或
   * 用模板拼出来的常量（`${ADMIN_ROOT_PATH}` + `/posts`）。纯改名/拆常量的重构不该让闸门变红，
   * 所以这里只做「字面量 / 常量名 / 字面量模板」三件事的拼接，不把整个表达式丢进 evaluator
   * （evaluator 带帧语义，用它折算常量会把同名局部变量的求值上下文搅乱）。
   */
  function foldConstExpression(file, expression, seen) {
    const pieces = splitRaw(expression, '+');
    if (pieces.length > 1) {
      let out = '';
      for (const piece of pieces) {
        const part = piece.trim();
        const literal = /^'([^']*)'$/.exec(part) ?? /^"([^"]*)"$/.exec(part);
        if (literal) { out += literal[1]; continue; }
        if (/^[A-Za-z_$][\w$]*$/.test(part)) {
          const value = resolveConst(file, part, seen);
          if (typeof value !== 'string') return null;
          out += value;
          continue;
        }
        return null;
      }
      return out;
    }
    const template = /^`([\s\S]*)`$/.exec(expression);
    if (!template) return null;
    let out = '';
    const body = template[1];
    let index = 0;
    let cursor = 0;
    while (index < body.length) {
      if (body[index] === '$' && body[index + 1] === '{') {
        const close = body.indexOf('}', index + 2);
        if (close < 0) return null;
        out += body.slice(cursor, index);
        const name = body.slice(index + 2, close).trim();
        if (!/^[A-Za-z_$][\w$]*$/.test(name)) return null;
        const value = resolveConst(file, name, seen);
        if (typeof value !== 'string') return null;
        out += value;
        index = close + 1;
        cursor = index;
        continue;
      }
      index += 1;
    }
    return out + body.slice(cursor);
  }

  function resolveImported(file, name, seen) {
    const module = modules.get(file);
    if (!module) return null;
    for (const statement of module.imports) {
      for (const binding of statement.names) {
        if (binding.local !== name) continue;
        const target = resolveSpecifier(file, statement.specifier, modules);
        if (!target) continue;
        return resolveConst(target, binding.imported, seen);
      }
    }
    return null;
  }

  function makeFrame(module, fn, bindings) {
    return { module, fn, bindings: bindings ?? new Map() };
  }

  /** 调用点 → 新帧：实参按形参名/位置绑定（缺省 `null` 视为「没有」）。 */
  function frameForCall(calleeModule, callee, argsText, callerFrame) {
    const bindings = new Map();
    const args = argsText === null ? [] : splitRaw(argsText);
    if (callee.destructured) {
      const first = args[0];
      const props = first && first.trim().startsWith('{') ? parseObjectLiteral(first) : new Map();
      const spread = hasUnresolvedSpread(first);
      for (const param of callee.params) {
        if (props.has(param.name)) {
          bindings.set(param.name, { kind: 'expr', text: props.get(param.name), frame: callerFrame });
        } else {
          bindings.set(param.name, spread ? maybeValue(param.name) : ABSENT);
        }
      }
    } else {
      callee.params.forEach((param, index) => {
        if (args[index] !== undefined) {
          bindings.set(param.name, { kind: 'expr', text: args[index].trim(), frame: callerFrame });
        } else {
          bindings.set(param.name, ABSENT);
        }
      });
    }
    return makeFrame(calleeModule, callee, bindings);
  }

  /** 表达式 → 值片段（`{kind:'str'|'base'|'absent'|'unknown'|'call'}`）。 */
  function evaluate(text, frame, depth = 0) {
    if (depth > 8) return unknownValue('depth');
    const source = text.trim();
    if (source === '') return ABSENT;
    const pieces = splitRaw(source, '+');
    if (pieces.length > 1) {
      let out = '';
      for (const piece of pieces) {
        const value = evaluate(piece, frame, depth + 1);
        if (value.kind === 'absent') continue;
        out += renderValue(value);
      }
      return { kind: 'str', value: out };
    }
    const single = source.replace(/^\(([\s\S]*)\)$/, '$1').trim();
    if (single !== source) return evaluate(single, frame, depth + 1);

    if (single.startsWith('`') && single.endsWith('`') && single.length > 1) {
      const body = single.slice(1, -1);
      let out = '';
      let cursor = 0;
      let index = 0;
      while (index < body.length) {
        const char = body[index];
        if (char === '\\') { index += 2; continue; }
        if (char === '$' && body[index + 1] === '{') {
          out += body.slice(cursor, index);
          let braceDepth = 1;
          let scan = index + 2;
          while (scan < body.length && braceDepth > 0) {
            if (body[scan] === '{') braceDepth += 1;
            else if (body[scan] === '}') braceDepth -= 1;
            if (braceDepth === 0) break;
            scan += 1;
          }
          const expression = body.slice(index + 2, scan);
          const value = evaluate(expression, frame, depth + 1);
          if (value.kind !== 'absent') out += renderValue(value);
          index = scan + 1;
          cursor = index;
          continue;
        }
        index += 1;
      }
      out += body.slice(cursor);
      return { kind: 'str', value: out };
    }

    const literal = /^'([^']*)'$/.exec(single) ?? /^"([^"]*)"$/.exec(single);
    if (literal) return { kind: 'str', value: literal[1] };

    // 对象字面量：保留文本与当时的帧，供 `request.url` / `request.method` 这类取属性使用。
    if (single.startsWith('{') && single.endsWith('}')) return { kind: 'obj', text: single, frame };

    const call = /^([A-Za-z_$][\w$]*)\s*\(([\s\S]*)\)$/.exec(single);
    if (call) {
      const name = call[1];
      const inner = call[2];
      if (name === 'normalizeBaseUrl') return BASE;
      if (name === 'encodeURIComponent' || name === 'String') return evaluate(inner, frame, depth + 1);
      const callee = frame.module.functions.get(name);
      if (callee) {
        const calleeFrame = frameForCall(frame.module, callee, inner, frame);
        const text = returnedText(frame.module, callee, calleeFrame, depth + 1);
        if (text !== null) return { kind: 'str', value: text };
        return { kind: 'call', name, frame: calleeFrame, fn: callee, module: frame.module };
      }
      return unknownValue(name);
    }

    const member = /^([A-Za-z_$][\w$]*)\s*(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)$/.exec(single);
    if (member) {
      const root = resolveIdentifier(member[1], frame, depth);
      if (root.kind === 'absent') return ABSENT;
      if (root.kind === 'maybe') return maybeValue(member[2]);
      if (root.kind === 'call') return objectProperty(root, member[2], depth);
      if (root.kind === 'obj') {
        const props = parseObjectLiteral(root.text);
        if (props.has(member[2])) return evaluate(props.get(member[2]), root.frame, depth + 1);
        return ABSENT;
      }
      const binding = frame.bindings.get(member[1]);
      if (binding && binding.kind === 'expr' && binding.text.trim().startsWith('{')) {
        // 对象字面量里根本没有这个属性 ⇒ 该属性只在某些调用下才有（如 fetchFamilyPage 不传 id），
        // 于是依赖它的路径段是「有条件追加」，整段算 absent，不能渲染成假通配。
        const props = parseObjectLiteral(binding.text);
        if (props.has(member[2])) return evaluate(props.get(member[2]), binding.frame, depth + 1);
        return ABSENT;
      }
      return unknownValue(member[2]);
    }

    if (/^[A-Za-z_$][\w$]*$/.test(single)) return resolveIdentifier(single, frame, depth);
    return unknownValue(single.slice(0, 24));
  }

  /** 同模块函数「返回的字符串」：`return \`...\`` 或 `return url`（url 由多次 `+=` 累加）。 */
  function returnedText(module, fn, calleeFrame, depth) {
    if (depth > 8) return null;
    const code = module.scanned.code;
    let braces = 0;
    let index = fnBodyStart(fn);
    while (index < fn.end) {
      const char = code[index];
      if (char === '{') braces += 1;
      else if (char === '}') braces -= 1;
      else if (braces === 1 && code.startsWith('return', index) && !/[A-Za-z0-9_$]/.test(code[index - 1] ?? '')) {
        const start = index + 'return'.length;
        const end = statementEnd(code, start, fn.end);
        const expression = module.masked.slice(start, end).trim().replace(/;$/, '');
        if (expression !== '') {
          const value = evaluate(expression, calleeFrame, depth + 1);
          if (value.kind === 'str' && (value.value.includes('\u0000') || value.value.includes('/admin'))) {
            return value.value;
          }
        }
        index = end;
        continue;
      }
      index += 1;
    }
    return null;
  }

  /** 从「调用结果」里取对象属性（`buildHidePostRequest(...)` 的 `method: 'POST'`）。 */
  function objectProperty(reference, property, depth) {
    const { module, fn, frame } = reference;
    const body = module.masked.slice(fnBodyStart(fn), fn.end);
    const pattern = new RegExp(`\\b${escapeRegExp(property)}\\s*:\\s*`, 'g');
    let match = pattern.exec(body);
    while (match) {
      const start = fnBodyStart(fn) + match.index + match[0].length;
      const end = statementEnd(module.scanned.code, start, fn.end);
      const text = module.masked.slice(start, end).trim().replace(/,$/, '');
      const value = evaluate(text, frame, depth + 1);
      if (value.kind !== 'absent') return value;
      match = pattern.exec(body);
    }
    const accumulated = accumulate(frame, property);
    if (accumulated !== null) return { kind: 'str', value: accumulated };
    const local = localAssignment(frame, property);
    if (local !== null) return evaluate(local, frame, depth + 1);
    return ABSENT;
  }

  function resolveIdentifier(name, frame, depth = 0) {
    const binding = frame.bindings.get(name);
    if (binding) {
      if (binding.kind === 'absent') return ABSENT;
      if (binding.kind === 'maybe') return binding;
      return evaluate(binding.text, binding.frame, depth + 1);
    }
    const constant = resolveConst(frame.module.file, name);
    if (typeof constant === 'string') return { kind: 'str', value: constant };
    const destructuredFrom = destructuredLocal(frame, name);
    if (destructuredFrom !== null) {
      const base = evaluate(destructuredFrom, frame, depth + 1);
      if (base.kind === 'call') return objectProperty(base, name, depth + 1);
      if (base.kind === 'obj') {
        const props = parseObjectLiteral(base.text);
        if (props.has(name)) return evaluate(props.get(name), base.frame, depth + 1);
      }
      return ABSENT;
    }
    // URL 变量通常是「声明一次 + 多次 `+=`」拼出来的，整段累加才还原得出路径。
    const accumulated = accumulate(frame, name);
    if (accumulated !== null && (accumulated.includes('\u0000') || accumulated.includes('/admin'))) {
      return { kind: 'str', value: accumulated };
    }
    const assigned = localAssignment(frame, name);
    if (assigned !== null) return evaluate(assigned, frame, depth + 1);
    if (BASE_NAME_PATTERN.test(name)) return BASE;
    if (frame.fn && frame.fn.params.some(param => param.name === name)) return unknownValue(name);
    if (frame.module.functions.has(name)) return unknownValue(name);
    return unknownValue(name);
  }

  /** 从 `=` 之后跳到真正的表达式起点：只在原始文本上跳空白。
   *
   * 必须在 masked（含字符串）上跳，不能在 code 掩码上跳——掩码里的模板字面量是一串空格，
   * `\s*` 会把它整段吃掉，于是 `let url = \`${base}${path}\`;` 被切出空表达式。
   */
  function skipWhitespace(module, index, limit) {
    let cursor = index;
    while (cursor < limit && /\s/.test(module.masked[cursor])) cursor += 1;
    return cursor;
  }

  /** `const { request } = built;` → 返回 `built` 的文本（属性名支持 `a: b` 别名）。 */
  function destructuredLocal(frame, name) {
    const code = frame.module.scanned.code;
    const pattern = /\b(?:const|let|var)\s*\{([^}]*)\}\s*=(?![=>])/g;
    pattern.lastIndex = fnBodyStart(frame.fn);
    let match = pattern.exec(code);
    while (match && match.index < frame.fn.end) {
      const names = match[1]
        .split(',')
        .map(piece => piece.trim())
        .filter(piece => piece !== '')
        .map(piece => {
          const colon = piece.indexOf(':');
          return (colon < 0 ? piece : piece.slice(colon + 1)).trim();
        });
      if (names.includes(name)) {
        const start = skipWhitespace(frame.module, match.index + match[0].length, frame.fn.end);
        const end = statementEnd(code, start, frame.fn.end);
        return frame.module.masked.slice(start, end).trim().replace(/;$/, '');
      }
      match = pattern.exec(code);
    }
    return null;
  }

  /** 函数体内某标识符最后一次赋值表达式（`requestUrl = buildX(...)`）。 */
  function localAssignment(frame, name) {
    const code = frame.module.scanned.code;
    const pattern = new RegExp(`\\b${escapeRegExp(name)}\\s*=(?![=>])`, 'g');
    pattern.lastIndex = fnBodyStart(frame.fn);
    let match = pattern.exec(code);
    let last = null;
    while (match && match.index < frame.fn.end) {
      const start = skipWhitespace(frame.module, match.index + match[0].length, frame.fn.end);
      const end = statementEnd(code, start, frame.fn.end);
      last = frame.module.masked.slice(start, end).trim();
      match = pattern.exec(code);
    }
    return last;
  }

  /** `let u = a; u += b;` → 逐段求值拼接（`+=` 的表达式求值为「没有」时跳过）。 */
  function accumulate(frame, name) {
    const code = frame.module.scanned.code;
    const pattern = new RegExp(`\\b${escapeRegExp(name)}\\s*\\+?=(?![=>])`, 'g');
    pattern.lastIndex = fnBodyStart(frame.fn);
    let out = '';
    let found = false;
    let match = pattern.exec(code);
    while (match && match.index < frame.fn.end) {
      const start = skipWhitespace(frame.module, match.index + match[0].length, frame.fn.end);
      const end = statementEnd(code, start, frame.fn.end);
      const expression = frame.module.masked.slice(start, end).trim();
      const value = evaluate(expression, frame, 1);
      if (value.kind !== 'absent') out += renderValue(value);
      found = true;
      match = pattern.exec(code);
    }
    return found ? out : null;
  }

  /** HTTP 方法：字面量、`request.method`、或经同模块构造函数取回的 `method:` 字面量。 */
  function methodOf(text, frame, depth = 0) {
    if (depth > 6) return null;
    const source = (text ?? '').trim();
    if (source === '') return null;
    if (source.startsWith('{')) {
      const props = parseObjectLiteral(source);
      return props.has('method') ? methodOf(props.get('method'), frame, depth + 1) : null;
    }
    const literal = /^'([A-Z]+)'$/.exec(source) ?? /^"([A-Z]+)"$/.exec(source);
    if (literal) return literal[1];
    const member = /^([A-Za-z_$][\w$]*)\s*(?:\?\.|\.)\s*(?:method|Method)$/.exec(source);
    if (member) {
      const root = resolveIdentifier(member[1], frame, depth + 1);
      if (root.kind === 'call') {
        const found = /method\s*:\s*'([A-Z]+)'/.exec(root.module.masked.slice(fnBodyStart(root.fn), root.fn.end));
        return found ? found[1] : null;
      }
      if (root.kind === 'obj') {
        const props = parseObjectLiteral(root.text);
        return props.has('method') ? methodOf(props.get('method'), root.frame, depth + 1) : null;
      }
      const binding = frame.bindings.get(member[1]);
      if (binding && binding.kind === 'expr') return methodOf(binding.text, binding.frame, depth + 1);
      const assigned = localAssignment(frame, member[1]);
      if (assigned !== null) return methodOf(assigned, frame, depth + 1);
      return null;
    }
    if (/^[A-Za-z_$][\w$]*$/.test(source)) {
      const binding = frame.bindings.get(source);
      if (binding && binding.kind === 'expr') return methodOf(binding.text, binding.frame, depth + 1);
      const assigned = localAssignment(frame, source);
      if (assigned !== null) return methodOf(assigned, frame, depth + 1);
      return null;
    }
    const objectCall = /^([A-Za-z_$][\w$]*)\s*\(/.exec(source);
    if (objectCall) {
      const callee = frame.module.functions.get(objectCall[1]);
      if (callee) {
        const found = /method\s*:\s*'([A-Z]+)'/.exec(frame.module.masked.slice(callee.start, callee.end));
        return found ? found[1] : null;
      }
    }
    return null;
  }

  return { evaluate, accumulate, methodOf, resolveConst, makeFrame, frameForCall };
}

/**
 * 函数体里是不是「真的发了 HTTP」：直接调 `fetch`，或调本函数内绑给 fetch 的别名
 * （`const doFetch = fetchImpl ?? globalThis.fetch;`），或第二个实参是一份带
 * `method:` + `headers|credentials|body|signal` 的请求描述对象。
 */
function isHttpAlias(module, fn, name) {
  const code = module.scanned.code;
  const pattern = new RegExp(`\\b(?:const|let|var)\\s+${escapeRegExp(name)}\\s*=`);
  pattern.lastIndex = fnBodyStart(fn);
  const match = pattern.exec(code);
  if (!match || match.index >= fn.end) return false;
  const start = match.index + match[0].length;
  const end = statementEnd(code, start, fn.end);
  return /\bfetchImpl\b|\bfetch\b/.test(module.masked.slice(start, end));
}

function looksLikeHttpCall(secondArgText) {
  if (typeof secondArgText !== 'string') return false;
  return /\bmethod\s*:/.test(secondArgText) && /\b(headers|credentials|body|signal)\b/.test(secondArgText);
}

/** 从函数体里找出所有 HTTP 调用点：`{ args, line }`。 */
function fetchCallSites(module, fn) {
  const sites = [];
  const code = module.scanned.code;
  const pattern = /\b([A-Za-z_$][\w$]*)\s*\(/g;
  pattern.lastIndex = fnBodyStart(fn);
  let match = pattern.exec(code);
  while (match && match.index < fn.end) {
    const name = match[1];
    const openAt = match.index + match[0].length - 1;
    const closeAt = matchParenRaw(module.masked, openAt);
    if (closeAt > 0 && closeAt <= fn.end) {
      const inner = module.masked.slice(openAt + 1, closeAt);
      const args = splitRaw(inner);
      const httpish =
        FETCH_CALLEES.has(name) || isHttpAlias(module, fn, name) || looksLikeHttpCall(args[1]);
      if (httpish) sites.push({ args, line: makeLineIndex(module.masked).lineOf(openAt) });
    }
    match = pattern.exec(code);
  }
  return sites;
}

/** 函数体内对同模块其它函数的调用点（用于 `fetchFamilyPage` / `buildXUrl` 这类中转）。 */
function localCallSites(module, fn) {
  const sites = [];
  const code = module.scanned.code;
  const pattern = /\b([A-Za-z_$][\w$]*)\s*\(/g;
  pattern.lastIndex = fnBodyStart(fn);
  let match = pattern.exec(code);
  while (match && match.index < fn.end) {
    const name = match[1];
    const callee = module.functions.get(name);
    if (callee && callee !== fn) {
      const openAt = match.index + match[0].length - 1;
      const closeAt = matchParenRaw(module.masked, openAt);
      if (closeAt > 0 && closeAt <= fn.end) sites.push({ callee, args: module.masked.slice(openAt + 1, closeAt) });
    }
    match = pattern.exec(code);
  }
  return sites;
}

/** 一个 client function 的 URL 证据：`[{ method, pattern, line }]`（含同模块中转函数里的 fetch）。 */
function urlEvidenceFor(modules, evaluator, module, fn) {
  const out = [];
  const visited = new Set();
  const walk = (targetModule, targetFn, frame, depth) => {
    if (depth > 4 || visited.has(`${targetModule.file}#${targetFn.name}`)) return;
    visited.add(`${targetModule.file}#${targetFn.name}`);
    for (const site of fetchCallSites(targetModule, targetFn)) {
      const urlRaw = evaluator.evaluate(site.args[0] ?? '', frame);
      const method = evaluator.methodOf(site.args[1] ?? '', frame) ?? 'GET';
      for (const variant of expandOptionalSegments(renderValue(urlRaw))) {
        const pattern = finalizeUrlPath(variant);
        if (!pattern || !method) continue;
        out.push({ method, pattern, line: site.line, fn: targetFn.name });
      }
    }
    for (const site of localCallSites(targetModule, targetFn)) {
      const calleeFrame = evaluator.frameForCall(targetModule, site.callee, site.args, frame);
      walk(targetModule, site.callee, calleeFrame, depth + 1);
    }
    visited.delete(`${targetModule.file}#${targetFn.name}`);
  };
  walk(module, fn, evaluator.makeFrame(module, fn, new Map()), 0);
  return out;
}

function patternMatches(pattern, operationPath) {
  const left = pattern.split('/');
  const right = operationPath.split('/');
  if (left.length !== right.length) return false;
  const wildcards = [];
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] === right[i]) continue;
    const leftParam = /^\{[\w$.]+\}$/.test(left[i]);
    const rightParam = /^\{[\w$.]+\}$/.test(right[i]);
    if (leftParam && rightParam) continue;
    if (rightParam) continue;
    if (leftParam) {
      wildcards.push(right[i]);
      continue;
    }
    return false;
  }
  return { wildcards };
}

/** 路径证据 → 一组 operation：字面段必须一致；`{x}` 通配段按「同模块字面量」收敛。 */
function operationsForEvidence(evidence, operations, module) {
  const matched = new Set();
  for (const entry of evidence) {
    for (const operation of operations) {
      if (operation.method !== entry.method) continue;
      const result = patternMatches(entry.pattern, operation.path);
      if (result === false) continue;
      const suspicious = result.wildcards.filter(value => !module.literals.has(value));
      if (suspicious.length > 0) continue;
      matched.add(operation.operationId);
    }
  }
  return matched;
}

/**
 * 扫 UI 面，**按 operation** 给结论：
 * - 一个 operation 有入口 ⇔ 存在一个「被视图 import 且真的调用」的 client function，
 *   而该函数自身携带这个 operation 的 method+path 证据；
 * - 视图还必须挂在 `App.vue`（或容器视图的 tab）的挂载链上，否则不算入口。
 */
export function scanUiSurface(files, options = {}) {
  const operations = options.operations ?? [];
  const modules = buildModules(files);
  const evaluator = createEvaluator(modules);

  /** 文件级族证据（死按钮与「引用文件数」用）。 */
  const fileEvidence = new Map();
  const pathConsts = new Map();
  for (const module of modules.values()) {
    const families = new Map();
    for (const literal of collectAdminPathLiterals(module.masked, module.file)) {
      if (!families.has(literal.family)) families.set(literal.family, []);
      families.get(literal.family).push(literal.line);
    }
    const constPattern = /(?:^|\n)[ \t]*(?:export[ \t]+)?const[ \t]+([A-Za-z_$][\w$]*)[ \t]*=[ \t]*(?=['"])/g;
    let match = constPattern.exec(module.scanned.code);
    while (match) {
      const start = match.index + match[0].length;
      const end = statementEnd(module.scanned.code, start, module.scanned.code.length);
      const value = module.masked.slice(start, end).trim().replace(/;$/, '');
      const text = /^'([^']*)'$/.exec(value) ?? /^"([^"]*)"$/.exec(value);
      const literal = text ? /^\/admin\/([A-Za-z0-9_-]+)$/.exec(text[1]) : null;
      if (literal) pathConsts.set(`${module.file}#${match[1]}`, literal[1]);
      match = constPattern.exec(module.scanned.code);
    }
    for (const [key, family] of pathConsts) {
      const [ownerFile, name] = key.split('#');
      if (ownerFile !== module.file) continue;
      const pattern = new RegExp(`\\b${escapeRegExp(name)}\\b`, 'g');
      const lines = makeLineIndex(module.masked);
      let hit = pattern.exec(module.scanned.text);
      while (hit) {
        const inComment = isInComment(module.scanned.comments, hit.index);
        const inPlainString = module.scanned.strings.some(
          span => span.quote !== '`' && hit.index >= span.contentStart && hit.index < span.contentEnd,
        );
        const before = module.scanned.text.slice(Math.max(0, hit.index - 12), hit.index);
        if (!inComment && !inPlainString && !/\bconst\s+$/.test(before)) {
          if (!families.has(family)) families.set(family, []);
          families.get(family).push(lines.lineOf(hit.index));
        }
        hit = pattern.exec(module.scanned.text);
      }
    }
    fileEvidence.set(module.file, families);
  }

  /** client function（`lib/*.mjs` 顶层函数）→ 它背书的 operation 集合。 */
  const clientOps = new Map();
  const clientEvidence = new Map();
  for (const module of modules.values()) {
    if (!module.file.includes('/lib/')) continue;
    for (const fn of module.functions.values()) {
      if (!fn.exported) continue;
      const evidence = urlEvidenceFor(modules, evaluator, module, fn);
      const ops = operationsForEvidence(evidence, operations, module);
      clientOps.set(`${module.file}#${fn.name}`, ops);
      clientEvidence.set(`${module.file}#${fn.name}`, evidence);
    }
  }

  /** 视图 → 真正调用到的 client function → operation。 */
  const viewOps = new Map();
  const viewCallchain = new Map();
  const unreachable = [];
  const reachable = computeReachableModules(modules);
  for (const module of modules.values()) {
    if (!module.file.endsWith('.vue')) continue;
    const code = module.scanned.code;
    const ops = new Set();
    const callchain = new Map();
    for (const statement of module.imports) {
      const target = resolveSpecifier(module.file, statement.specifier, modules);
      if (!target) continue;
      for (const binding of statement.names) {
        const key = `${target}#${binding.imported}`;
        if (!clientOps.has(key)) continue;
        const callPattern = new RegExp(`\\b${escapeRegExp(binding.local)}\\s*\\(`, 'g');
        callPattern.lastIndex = statement.index ?? 0;
        const called = callPattern.exec(code);
        if (!called) continue;
        for (const operationId of clientOps.get(key)) {
          ops.add(operationId);
          if (!callchain.has(operationId)) callchain.set(operationId, new Set());
          callchain.get(operationId).add(binding.local);
        }
      }
    }
    viewOps.set(module.file, ops);
    viewCallchain.set(module.file, callchain);
    if (ops.size > 0 && !reachable.has(module.file)) unreachable.push(module.file);
  }

  /** operation → 入口视图（只算可达视图）。 */
  const entryOps = new Map();
  for (const [file, ops] of viewOps) {
    if (!reachable.has(file)) continue;
    for (const operationId of ops) {
      if (!entryOps.has(operationId)) entryOps.set(operationId, new Set());
      entryOps.get(operationId).add(file);
    }
  }

  /** 「有 admin 路径证据的文件数」：族级证据（字面量/常量）与「客户端函数已解析出 admin URL」的并集。 */
  const evidenceFiles = new Set();
  for (const [file, families] of fileEvidence) {
    if (families.size > 0) evidenceFiles.add(file);
  }
  for (const [key, ops] of clientOps) {
    if (ops.size > 0) evidenceFiles.add(key.split('#')[0]);
  }

  return {
    files: [...modules.keys()].sort(),
    modules,
    fileEvidence,
    clientOps,
    clientEvidence,
    viewOps,
    viewCallchain,
    entryOps,
    reachable,
    uiRefFiles: evidenceFiles.size,
    unreachableViews: unreachable.sort(),
  };
}

/**
 * 挂载链：从 `apps/admin/src/App.vue` 出发，只有「父视图模板里出现 `<子组件>` 标签」才算挂上。
 * 只 import 不挂载（模板里没有标签）不算入口——`App.vue` 摘掉一行 `v-else-if` 就该红。
 */
export function computeReachableModules(modules) {
  const root = 'apps/admin/src/App.vue';
  const reachable = new Set();
  if (!modules.has(root)) return reachable;
  const queue = [root];
  reachable.add(root);
  while (queue.length > 0) {
    const current = queue.shift();
    const module = modules.get(current);
    if (!module) continue;
    for (const statement of module.imports) {
      const target = resolveSpecifier(current, statement.specifier, modules);
      if (!target || reachable.has(target)) continue;
      for (const binding of statement.names) {
        const kebab = binding.local.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
        const tagPattern = new RegExp(`<\\s*(?:${escapeRegExp(binding.local)}|${escapeRegExp(kebab)})\\b`);
        if (tagPattern.test(module.template)) {
          reachable.add(target);
          queue.push(target);
          break;
        }
      }
    }
  }
  return reachable;
}

function readImports(scanned, masked, file) {
  const lines = makeLineIndex(masked);
  const imports = [];
  const pattern = /\bimport\s+(?:([A-Za-z_$][\w$]*)\s*(?:,\s*)?)?(?:\{([^}]*)\})?\s*from\s*['"]([^'"]*)['"]/g;
  let match = pattern.exec(scanned.text);
  while (match) {
    if (!isInComment(scanned.comments, match.index)) {
      const names = [];
      if (match[1]) names.push({ imported: match[1], local: match[1] });
      if (match[2]) {
        for (const piece of match[2].split(',')) {
          const trimmed = piece.trim();
          if (trimmed === '') continue;
          const alias = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(trimmed);
          if (alias) names.push({ imported: alias[1], local: alias[2] });
          else names.push({ imported: trimmed, local: trimmed });
        }
      }
      imports.push({
        names,
        specifier: match[3],
        line: lines.lineOf(match.index),
        index: match.index,
        end: match.index + match[0].length,
        file,
      });
    }
    match = pattern.exec(scanned.text);
  }
  return imports;
}

// ---------------------------------------------------------------- 汇总

/** 从仓库根读源码（只读，不写盘、不联网、不读 git）。 */
export function loadSources(repoRoot) {
  const read = path => readFileSync(join(repoRoot, path), 'utf8');
  const uiFiles = [];
  const walk = dir => {
    for (const entry of readdirSync(dir)) {
      const absolute = join(dir, entry);
      if (statSync(absolute).isDirectory()) walk(absolute);
      else if (UI_FILE_SUFFIXES.some(suffix => entry.endsWith(suffix))) {
        uiFiles.push(relative(repoRoot, absolute).replace(/\\/g, '/'));
      }
    }
  };
  walk(join(repoRoot, SOURCE_PATHS.uiRoot));
  uiFiles.sort();
  const contract = JSON.parse(read(SOURCE_PATHS.contractOperations));
  const contractOperations = Array.isArray(contract) ? contract : contract?.operations;
  if (!Array.isArray(contractOperations) || contractOperations.length === 0) {
    throw new AdminCapabilityMapError(
      `${SOURCE_PATHS.contractOperations}: 契约 operation 清单不是非空数组（也找不到 .operations 数组）`,
    );
  }
  return {
    adminSource: read(SOURCE_PATHS.adminRoutes),
    familiesSource: read(SOURCE_PATHS.families),
    opsScopeSource: read(SOURCE_PATHS.opsScopes),
    scopeConstantSources: {
      [SOURCE_PATHS.auditCatalog]: read(SOURCE_PATHS.auditCatalog),
      [SOURCE_PATHS.postService]: read(SOURCE_PATHS.postService),
    },
    contractOperations,
    docText: read(SOURCE_PATHS.doc),
    ui: uiFiles.map(path => ({ path, text: read(path) })),
  };
}

/** 已知路径宇宙 = 路由路径 ∪ 契约路径（用于判「死按钮」）。 */
export function knownPaths({ operations, contractOperations }) {
  const known = new Set(operations.map(operation => operation.path));
  for (const entry of contractOperations) {
    if (typeof entry?.path === 'string') known.add(normalizePathTemplate(entry.path));
  }
  return known;
}

function pathIsKnown(path, known) {
  if (known.has(path)) return true;
  for (const candidate of known) {
    if (candidate.startsWith(`${path}/`) || path.startsWith(`${candidate}/`)) return true;
  }
  return false;
}

/**
 * 总装：给定源码文本，算出能力图（纯函数，无 IO）。
 * 返回 `{ rows, deadButtons, summary }`。
 */
export function buildCapabilityMap({
  adminSource,
  familiesSource,
  opsScopeSource,
  scopeConstantSources,
  contractOperations,
  ui,
}) {
  const operations = buildOperations({
    adminSource,
    familiesSource,
    opsScopeSource,
    scopeConstantSources,
  });
  const surface = scanUiSurface(ui, { operations });
  const known = knownPaths({ operations, contractOperations });

  const rows = operations.map(operation => {
    const family = operation.family;
    const uiFiles = [];
    let firstRef = null;
    for (const [file, families] of surface.fileEvidence) {
      const lineList = families.get(family);
      if (!lineList || lineList.length === 0) continue;
      uiFiles.push(file);
      const minLine = Math.min(...lineList);
      if (!firstRef || minLine < firstRef.line) firstRef = { file, line: minLine };
    }
    // 行级「引用文件」= 写了这一族路径字面量/常量的文件 ∪ 函数体里解析出这条 operation URL 的文件。
    // 后者让「常量改名/拆开」的纯重构不会把行级引用数抖掉。
    for (const [key, ops] of surface.clientOps) {
      if (!ops.has(operation.operationId)) continue;
      const file = key.split('#')[0];
      if (!uiFiles.includes(file)) uiFiles.push(file);
    }
    uiFiles.sort();
    // 入口判定是**逐 operation** 的：只认「被视图 import 且真的调用、且函数体内带这条
    // operation 的 method+path 证据」的 client function；族级只做汇总展示。
    const views = [...(surface.entryOps.get(operation.operationId) ?? [])].sort();
    const evidenceFns = [...surface.clientOps.entries()]
      .filter(([, ops]) => ops.has(operation.operationId))
      .map(([key]) => key.split('#')[1])
      .sort();
    return {
      operationId: operation.operationId,
      method: operation.method,
      path: operation.path,
      registeredPath: operation.registeredPath,
      scope: operation.scope,
      family,
      routeFile: operation.routeFile,
      routeLine: operation.routeLine,
      uiRefs: uiFiles.length,
      uiFiles,
      uiEntryViews: views,
      evidenceFunctions: evidenceFns,
      firstRef,
      verdict: views.length > 0 ? 'ui-entry' : 'no-ui-entry',
    };
  });

  const deadButtons = [];
  const deadByPath = new Map();
  for (const [file, families] of surface.fileEvidence) {
    for (const [name, lineList] of families) {
      const path = `/admin/${name}`;
      if (pathIsKnown(path, known)) continue;
      const entry = deadByPath.get(path) ?? { path, family: name, files: new Set(), lines: [] };
      entry.files.add(file);
      for (const line of lineList) entry.lines.push({ file, line });
      deadByPath.set(path, entry);
    }
  }
  for (const entry of deadByPath.values()) {
    entry.lines.sort((left, right) => (left.file === right.file ? left.line - right.line : left.file < right.file ? -1 : 1));
    deadButtons.push({
      path: entry.path,
      family: entry.family,
      uiRefs: entry.files.size,
      uiFiles: [...entry.files].sort(),
      firstRef: entry.lines[0],
      verdict: 'dead-button',
    });
  }
  deadButtons.sort((left, right) => (left.path < right.path ? -1 : 1));

  const noUiEntry = rows.filter(row => row.verdict === 'no-ui-entry').map(row => row.operationId);
  const familyOrder = [];
  const familyOps = new Map();
  for (const row of rows) {
    if (!familyOps.has(row.family)) {
      familyOps.set(row.family, []);
      familyOrder.push(row.family);
    }
    familyOps.get(row.family).push(row);
  }
  familyOrder.sort();

  const withEvidence = new Set([...surface.clientOps.values()].flatMap(ops => [...ops]));
  const summary = {
    totalOps: rows.length,
    families: familyOrder.length,
    withUiEntry: rows.length - noUiEntry.length,
    noUiEntry: noUiEntry.length,
    deadButtons: deadButtons.length,
    operationsWithEvidence: withEvidence.size,
    uiEntryViews: new Set([...surface.entryOps.values()].flatMap(set => [...set])).size,
    // 「引用文件数」= 有 admin 路径证据的文件：既包括写了路径字面量/路径常量的文件，
    // 也包括「函数体里能解析出 admin URL」的客户端模块——后者是纯改名/拆常量重构之后
    // 字面量会漂走的地方（如 \POSTS_PATH = \\/posts\\），只数字面量会把
    // 重构误判成「引用减少」。
    uiRefFiles: surface.uiRefFiles,
    unreachableViews: surface.unreachableViews.length,
    unreachableViewsList: surface.unreachableViews,
    noUiEntryList: noUiEntry,
    deadButtonList: deadButtons.map(entry => entry.path).sort(),
    familyOrder,
    familyOps,
    uiFilesScanned: surface.files.length,
  };
  return { rows, deadButtons, summary };
}

/** 表格式打印（CLI 用）。 */
export function renderTable(map) {
  const header = ['operationId', 'method', 'path', 'scope', 'uiRefs', 'verdict', 'firstRef'];
  const lines = [header.join('\t')];
  for (const row of map.rows) {
    lines.push(
      [
        row.operationId,
        row.method,
        row.path,
        row.scope,
        String(row.uiRefs),
        row.verdict,
        row.firstRef ? `${row.firstRef.file}:${row.firstRef.line}` : '-',
      ].join('\t'),
    );
  }
  if (map.deadButtons.length > 0) {
    lines.push('');
    lines.push('死按钮（UI 引用了，路由与契约里都没有）：');
    for (const entry of map.deadButtons) {
      lines.push(`\t${entry.path}\t${entry.uiRefs}\t${entry.firstRef.file}:${entry.firstRef.line}`);
    }
  }
  const noEntry = map.rows.filter(row => row.verdict === 'no-ui-entry');
  if (noEntry.length > 0) {
    lines.push('');
    lines.push('无 UI 入口的 operation（逐条）：');
    for (const row of noEntry) {
      lines.push(`\t${row.operationId}\t${row.method}\t${row.path}\t${row.scope}`);
    }
  }
  return lines.join('\n');
}

/** 一行汇总（回报/CI 日志用）。 */
export function renderSummaryLine(map) {
  const s = map.summary;
  return [
    `能力图汇总：totalOps=${s.totalOps}`,
    `有入口=${s.withUiEntry}`,
    `无入口=${s.noUiEntry}`,
    `死按钮=${s.deadButtons}`,
    `（带路径证据的 operation ${s.operationsWithEvidence} 个，UI 引用解析 ${s.uiRefFiles}/${s.uiFilesScanned} 文件，入口视图 ${s.uiEntryViews} 个，路径族 ${s.families}）`,
  ].join('，');
}

/**
 * 反空转下界：解析面必须有分量。
 * 没有这道自证，「解析器与源码形状脱节 ⇒ 扫出空集合 ⇒ 文档 0 == 重算 0 ⇒ 绿灯」就是一条
 * 假绿通道——比读数腐烂更糟，因为它安静。下界取当前实测值的一半左右，留足正常增删空间。
 */
export const DEFAULT_FLOORS = Object.freeze({
  totalOps: 30,
  families: 8,
  uiFilesScanned: 20,
  uiRefFiles: 8,
  uiEntryViews: 5,
  operationsWithEvidence: 20,
});

/** 低于下界就抛错（不是打印警告——警告会被忽略，闸门不会被忽略）。 */
export function assertNonVacuous(map, floors = DEFAULT_FLOORS) {
  const s = map.summary;
  const checks = [
    ['totalOps', s.totalOps, floors.totalOps],
    ['families', s.families, floors.families],
    ['uiFilesScanned', s.uiFilesScanned, floors.uiFilesScanned],
    ['uiRefFiles', s.uiRefFiles, floors.uiRefFiles],
    ['uiEntryViews', s.uiEntryViews, floors.uiEntryViews],
    ['operationsWithEvidence', s.operationsWithEvidence, floors.operationsWithEvidence],
  ];
  const shortfalls = checks.filter(([, actual, floor]) => actual < floor);
  if (shortfalls.length > 0) {
    throw new AdminCapabilityMapError(
      `解析面低于反空转下界（拒绝在「扫到的东西太少」时判绿）：${shortfalls
        .map(([name, actual, floor]) => `${name}=${actual} < ${floor}`)
        .join('，')}`,
    );
  }
}

// ---------------------------------------------------------------- 文档标记块

/** 可被闸门重算的读数（键 → 文档里的字面值）。 */
export function readingsOf(map) {
  const s = map.summary;
  const familyOpsLine = s.familyOrder
    .map(family => `${family}=${s.familyOps.get(family).length}`)
    .join(',');
  return {
    totalOps: String(s.totalOps),
    families: String(s.families),
    withUiEntry: String(s.withUiEntry),
    noUiEntry: String(s.noUiEntry),
    deadButtons: String(s.deadButtons),
    operationsWithEvidence: String(s.operationsWithEvidence),
    uiEntryViews: String(s.uiEntryViews),
    uiRefFiles: String(s.uiRefFiles),
    unreachableViews: String(s.unreachableViews),
    familyOps: familyOpsLine,
    noUiEntryList: s.noUiEntryList.length === 0 ? EMPTY_LIST : s.noUiEntryList.join(', '),
    deadButtonList: s.deadButtonList.length === 0 ? EMPTY_LIST : s.deadButtonList.join(', '),
  };
}

/** 生成标记块（含 begin/end 两行）。`--update` 用它整块重写。 */
export function renderDocBlock(map) {
  const readings = readingsOf(map);
  const s = map.summary;
  const listKeys = ['noUiEntryList', 'deadButtonList'];
  const lines = [DOC_BEGIN];
  // 前言段**必须保持一行**：这块的行数是文档里 `docs/verification/**` 若干 `:行号` 锚点的基准，
  // 在块内加行会把 `admin-console-capability-map.md:214` 这类既有锚点顶空（实测会被
  // `verify-doc-anchors --strict` 判 2 条基线外新增 SUSPECT）。要加说明就并进这一行。
  lines.push(
    '> 本块由 `node tools/verify-admin-capability-map.mjs --update` 从源码重算生成（解析 `services/api/src/routes/admin.ts`、`services/api/src/admin/families.ts` 与 `apps/admin/src`），`npm run verify:capability-map` 在 CI 的 `contract` job 里**把整个块逐字节比对**（统一行尾与前后空白后，前言段、读数表、逐 operation 表、族表全在比对范围内），块内手改即红。**块外的散文不受本闸门保护。** ⚠ **`noUiEntry` 只是缺口下界**：入口判据是「视图 import 的客户端函数体里带着这条 operation 的 method+path 证据」，**文本里出现过一次调用就算入口**——哪怕那个函数只在永不被调用的死代码里被调一次（变异实测 `noUiEntry 2→1`，能力没变）；所以 `noUiEntry === 0` 不等于「能力齐」，只等于「扫描器没看见缺口」。',
  );
  lines.push('');
  lines.push('**读数（operation 级）**——`withUiEntry` / `noUiEntry` 数的是 operation，不是族：');
  lines.push('');
  lines.push('| 读数 | 值 |');
  lines.push('| --- | --- |');
  for (const key of Object.keys(readings)) {
    if (listKeys.includes(key)) continue;
    lines.push(`| ${key} | ${readings[key]} |`);
  }
  for (const key of listKeys) lines.push(`| ${key} | ${readings[key]} |`);
  lines.push('');
  const noEntryRows = map.rows.filter(row => row.verdict === 'no-ui-entry');
  lines.push('**无 UI 入口的 operation（逐条）**——由「被视图 import 且真的调用、且函数体内带着这条 operation 的 method+path 证据」判定；族级「有人引用过这个前缀」不算入口：');
  lines.push('');
  if (noEntryRows.length === 0) {
    lines.push(`（空）${s.totalOps} 条 operation 全部有入口。`);
  } else {
    lines.push('| operationId | method | path | scope | 说明 |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const row of noEntryRows) {
      lines.push(
        `| ${row.operationId} | ${row.method} | ${row.path} | ${row.scope} | 无客户端调用链（${
          row.uiRefs === 0 ? '`apps/admin/src` 里连该路径的引用都没有' : `只有 ${row.uiRefs} 个文件引用了 /admin/${row.family} 前缀，但没有可调用到它的函数被视图调用`
        }） |`,
      );
    }
  }
  lines.push('');
  lines.push('**族级汇总**——下表按路径族聚合（同族多条 operation 共用一条路径前缀），只供概览；逐 operation 的入口结论以上两张表为准：');
  lines.push('');
  lines.push('| 路径族 | 路径 | operation 数（族级汇总） | scope | 有入口的视图（族级并集） | 引用文件数 |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const family of s.familyOrder) {
    const familyRows = s.familyOps.get(family);
    const scopes = [...new Set(familyRows.map(row => row.scope))].sort().join(' / ');
    const views = [...new Set(familyRows.flatMap(row => row.uiEntryViews))].sort();
    const refFiles = new Set(familyRows.flatMap(row => row.uiFiles));
    lines.push(
      `| ${family} | /admin/${family} | ${familyRows.length} | ${scopes} | ${
        views.length === 0 ? '（无）' : views.join('<br>')
      } | ${refFiles.size} |`,
    );
  }
  lines.push(DOC_END);
  return lines.join('\n');
}

/** 整块比对的归一化：行尾统一成 `\n`、去掉首尾空白（缩进/尾随空行不判红，内容一字不差才绿）。 */
export function normalizeDocBlock(text) {
  return String(text).replace(/\r\n?/g, '\n').trim();
}

/**
 * **整块**比对：文档里 `begin…end`（含两行标记）vs `renderDocBlock(map)`。
 *
 * 为什么不是只比读数表：块内的逐 operation 表「说明」列、族表「有入口的视图（族级并集）」列同样是
 * 重算值，只比读数会让「删掉一行」「把说明改成已有 UI 入口」这类手改全绿（实测 D3–D6 四项全 exit 0）。
 *
 * 返回 `null` 表示逐字节相等；否则返回第一处差异（`line` = 文档里的绝对行号，1 起）。
 */
export function compareDocBlock(docText, map) {
  const beginAt = docText.indexOf(DOC_BEGIN);
  const endAt = docText.indexOf(DOC_END);
  if (beginAt < 0 || endAt < beginAt) {
    return { missingBlock: true, line: null, documented: null, expected: null };
  }
  const blockFirstLine = docText.slice(0, beginAt).split('\n').length;
  const documentedLines = normalizeDocBlock(docText.slice(beginAt, endAt + DOC_END.length)).split('\n');
  const expectedLines = normalizeDocBlock(renderDocBlock(map)).split('\n');
  const lineCount = Math.max(documentedLines.length, expectedLines.length);
  for (let index = 0; index < lineCount; index += 1) {
    if (documentedLines[index] === expectedLines[index]) continue;
    return {
      missingBlock: false,
      line: blockFirstLine + index,
      documented: documentedLines[index] ?? null,
      expected: expectedLines[index] ?? null,
    };
  }
  return null;
}

/** 从文档里切出标记块并解析「| 读数 | 值 |」那张表（`--check` 另做整块比对，见 `compareDocBlock`）。 */
export function parseDocBlock(docText) {
  const beginAt = docText.indexOf(DOC_BEGIN);
  const endAt = docText.indexOf(DOC_END);
  if (beginAt < 0 || endAt < 0) return { found: false, values: new Map(), raw: null };
  if (endAt < beginAt) return { found: false, values: new Map(), raw: null };
  const raw = docText.slice(beginAt + DOC_BEGIN.length, endAt);
  const values = new Map();
  const headerAt = raw.indexOf('| 读数 | 值 |');
  const table = headerAt < 0 ? raw : raw.slice(headerAt);
  for (const line of table.split('\n')) {
    if (line.trim() === '') {
      if (values.size > 0) break;
      continue;
    }
    const row = /^\|\s*([A-Za-z][\w]*)\s*\|\s*(.*?)\s*\|\s*$/.exec(line);
    if (!row || row[1] === '读数') continue;
    values.set(row[1], row[2]);
  }
  return { found: true, values, raw };
}

/** 逐项比对：文档值 vs 重算值。不一致时附「示例 operation」便于定位。 */
export function compareReadings(docValues, map) {
  const readings = readingsOf(map);
  const exampleFor = key => {
    if (key === 'noUiEntry' || key === 'noUiEntryList') return map.summary.noUiEntryList[0] ?? map.rows[0]?.operationId;
    if (key === 'deadButtons' || key === 'deadButtonList') return map.deadButtons[0]?.path ?? map.rows[0]?.operationId;
    if (key === 'familyOps') return map.summary.familyOrder[0] ?? map.rows[0]?.operationId;
    if (key === 'operationsWithEvidence') {
      return map.rows.find(row => row.evidenceFunctions.length > 0)?.operationId ?? map.rows[0]?.operationId;
    }
    if (key === 'unreachableViews') return map.summary.unreachableViewsList[0] ?? '（无不可达视图）';
    return map.rows[0]?.operationId;
  };
  const mismatches = [];
  for (const [key, actual] of Object.entries(readings)) {
    const documented = docValues.has(key) ? docValues.get(key) : undefined;
    if (documented === actual) continue;
    mismatches.push({
      key,
      documented: documented === undefined ? '（缺行）' : documented,
      actual,
      exampleOperation: exampleFor(key),
    });
  }
  return mismatches;
}
