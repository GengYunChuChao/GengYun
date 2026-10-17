/**
 * GY-I10 阶段 2b · 标签 OCR 的**经真实装配的 app** + 本机回环真实 HTTP 集成回归。
 *
 * 与阶段 2a 的差别（本片的关键变化）：
 * - 2a 时 `app.ts` 尚未装配 OCR 路由，只能在测试内**自建应用**再注册插件；
 * - 2b 起 `app.ts` 已装配 `registerOcrRoutes(app, config, { guards })`（app.ts 只加两行），
 *   因此本脚本改为打**真实装配**：同一个 `buildApp` 同时提供鉴权、错误封套、404、
 *   `ajv removeAdditional:false` 与 OCR 路由；**测试内不再注册路由**（唯一例外见组 3d）。
 *
 * 边界（如实标注，不得外推）：
 * - 只用本机回环（127.0.0.1，随机端口）；**不发起任何外网请求**、**不连接任何数据库**（内存 store）。
 * - 身份是**合成**的：stub 模式经真实 `POST /api/v1/auth/wechat`（替身身份提供者）登录；
 *   real 模式实例按 `AuthStore` 公开 API **直接播种会话**（real 模式不允许替身登录，故不登录）。
 * - real 模式的配置用**合成占位值**（`REAL_ENV`）通过 `loadConfig` 的 real 校验；
 *   这些值**不是真实凭据**，且 `DATABASE_URL` 指向一个**永不连接**的本地地址。
 * - OCR 提供者是**明确标注的替身**（stub 分桶）或 real 的 **fail-closed** 实现；**不是真实供应商**。
 * - **标签类真实样本为 0** ⇒ 本脚本不产生、不声称任何准确率。
 *
 * 运行：`node tests/integration/ocr-http.mjs`（退出码 0 表示通过；任何断言失败以非 0 退出并打印原始断言）
 */
import assert from 'node:assert/strict';
// r7 运行期钉子：自测里逐形态在**子进程**里真跑 `--registry-probe=<id>`（见 `registryProbeForms`）。
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire, isBuiltin, registerHooks } from 'node:module';
// r7 形态钉子：`import { createRequire as cr } from 'node:module'` 这类**静态 import 别名**同样是运行期一条
//   真实路径 ⇒ 这里真写一条别名导入，供 `registryProbeForms` 的 `static-import-alias` 在子进程里真跑（非"模拟"）。
import { createRequire as createRequireViaStaticImport } from 'node:module';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';

// ⚠ r7：受护文件的**全部**应用侧依赖改为「下方 `registerHooks` 生效之后」动态装载。
//   实测理由：ESM 静态 import 在本模块任何语句执行**之前**求值 ⇒ 若在此静态装载，受护文件的引用图会
//   先于登记器被解析/缓存，登记器只能看到 `app.ts` 的**直接**边、看不到下一层（覆盖不完整，复审 blocking ①的根因同类）。
//   改为动态装载后：登记器在**任何**应用侧模块解析/装载之前生效 ⇒ `app.ts` 的**整张引用图**都被登记。

// ───────────────────────── TS AST 判据（r4 路线）─────────────────────────
// `typescript@5.9.3` 是本仓 devDependency（下方 require 即为"可解析"的自证）。
// 用 `createRequire` 取 CJS 导出，避免 ESM/CJS 互操作差异 ⇒ 用**解析器**判定结构，不做文本正则。
const require = createRequire(import.meta.url);
const ts = require('typescript');

// ═══════════════ r7 主判据：受护文件的**运行期装载登记** ═══════════════
// 立法依据：静态形状表**不可能穷举** JS 的调用/别名/间接空间（本片已连吃 7 轮同族返修）⇒ 主判据改为运行期登记：
// 用 `node:module` 的 `registerHooks`（Node ≥22.15；本机 v24.16.0）在**本脚本自己的运行期**拦截**每一次**
// 模块解析/装载，把「specifier → 最终模块 URL + 装载者（parentURL）」登记进集合；脚本收尾断言：
//   「从受护文件 `app.ts` 可达的装载中，没有任何 OCR 域模块（`services/api/src/ocr/service.ts` 白名单除外）」。
// 分工：**本登记是主判据**（判「运行期真的装载了什么」）；TS AST 判据降为**启发式**（判「源码里写了什么形状」），
// 其无法判定的形状一律进 `unjudged` 清单并在正常路径打印（fail-closed，不沉默）。
// ⛔ 不得退化成「登记器从不登记 ⇒ 恒绿」：正控制（下方先装载无害模块 ⇒ 集合里必须出现它）+ 负控制
//   （子进程逐形态**真装载** OCR 域模块 ⇒ 断言必须红）在自测里逐条钉死（见 `registryProbeForms`）。
const moduleLoadRegistry = { entries: [], edges: new Map() };
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    moduleLoadRegistry.entries.push({ hook: 'resolve', specifier, url: result.url, parentUrl: context.parentURL ?? null });
    if (context.parentURL !== undefined) {
      const list = moduleLoadRegistry.edges.get(result.url) ?? [];
      list.push({ parentUrl: context.parentURL, specifier });
      moduleLoadRegistry.edges.set(result.url, list);
    }
    return result;
  },
  load(url, context, nextLoad) {
    moduleLoadRegistry.entries.push({ hook: 'load', specifier: null, url, parentUrl: null });
    return nextLoad(url, context);
  },
});
/** 受护文件 URL：登记图与「从受护文件可达」判定的根。 */
const APP_MODULE_URL = new URL('../../services/api/src/app.ts', import.meta.url).href;
/** 正控制：先装载一个无害的内建模块 ⇒ 下方断言登记集合里必须出现它（否则登记器恒空、判据无意义）。 */
await import('node:os');
// 应用侧依赖一律在登记器生效**之后**动态装载（见上方 ESM 静态 import 的实测理由）⇒ `app.ts` 整张引用图都被登记。
const { buildApp } = await import(APP_MODULE_URL);
const { loadConfig } = await import('../../services/api/src/config.ts');
const { ApiError, buildErrorEnvelope } = await import('../../services/api/src/errors.ts');
const { createMemoryAuthStore } = await import('../../services/api/src/auth/store.ts');
const { hashToken, mintOpaqueToken } = await import('../../services/api/src/auth/tokens.ts');
const { createAuthGuards } = await import('../../services/api/src/auth/middleware.ts');
const { registerOcrRoutes } = await import('../../services/api/src/routes/ocr.ts');
const { createUnwiredReferencePort } = await import('../../services/api/src/ocr/reference.ts');
const { createJobRegistry } = await import('../../services/api/src/jobs/registry.ts');
const { createOcrJobSource } = await import('../../services/api/src/jobs/sources.ts');
const { registerJobRoutes } = await import('../../services/api/src/jobs/routes.ts');
const { collectResultValueIssues } = await import('../../services/api/src/jobs/result-shape.ts');

/** 仓根（从本脚本位置回推：`<root>/tests/integration/`）—— 仅用于把解析结果裁成"仓根相对"。 */
const REPO_ROOT_FOR_PATHS = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** 仓根的 POSIX 形态（r8 fail-closed 判据里做前缀比较用；Windows 上盘符大小写差异由 `normalizeModulePath` 抹平）。 */
const REPO_ROOT_POSIX_PREFIX = normalizeModulePath(REPO_ROOT_FOR_PATHS.replace(/\\/g, '/')).replace(/\/+$/, '');
/** `app.ts` 所在目录：模块说明符按**该目录**解析（与真实装配的解析基准一致）。 */
const APP_SOURCE_DIR = resolvePath(REPO_ROOT_FOR_PATHS, 'services', 'api', 'src');
/** 本域内**唯一**允许被装配路径引用的模块（仓根相对、已归一化，用于比较）。 */
const OCR_SERVICE_MODULE_PATH = normalizeModulePath('services/api/src/ocr/service.ts');
/** 该模块**唯一**允许的值符号（裁定授权的端口工厂）。 */
const OCR_SERVICE_ALLOWED_SYMBOLS = ['createUnwiredOcrTerminalHistoryPort'];
/** 第二道网（裁定保留的四条**原文子串**禁项，走 `appText` 原文）。 */
const OCR_FORBIDDEN_SUBSTRINGS = ['ocr/provider', 'ocr/store', 'ocr/media', 'ocr/reference'];

/** 归一化：percent-decode → 剥 `?`/`#` → `\`→`/` → 去 `.` 段与空段 → 解析 `..` → 大小写不敏感。 */
function normalizeModulePath(specifier) {
  let decoded = specifier;
  try {
    decoded = decodeURIComponent(specifier);
  } catch {
    decoded = specifier;
  }
  const segments = [];
  for (const segment of decoded.split('?')[0].split('#')[0].replace(/\\/g, '/').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') { if (segments.length > 0) segments.pop(); continue; }
    segments.push(segment);
  }
  return segments.join('/').toLowerCase();
}

/** 解析为"仓根相对"的归一化路径；非相对（裸模块）记为 `bare:` 前缀 ⇒ 不属本判据范围。 */
function resolveModuleTarget(specifierText, fromDir) {
  if (specifierText.startsWith('.')) {
    return normalizeModulePath(resolvePath(fromDir, specifierText).slice(REPO_ROOT_FOR_PATHS.length).replace(/\\/g, '/'));
  }
  if (specifierText.startsWith('/')) return normalizeModulePath(specifierText);
  return `bare:${specifierText}`;
}

/**
 * 本域判据（r6 收紧为**任意深度**）：路径里出现 `ocr/` **段**即属 OCR 域
 * ⇒ `./ocr/state.ts` 与 `./ocr/nested/state.ts` 同判（r5 写 `[^/]+$` 只匹配单层，
 * 复审 N6/F 系列实测 `import { X } from './ocr/nested/state.ts'` **0 命中**）。
 * ⚠ 配合"白名单是**全路径**精确"（`services/api/src/ocr/service.ts`）：域内非该模块一律判红。
 */
const isOcrDomainTarget = (target) => /(^|\/)ocr\//.test(target);
const isServiceTarget = (target) => target.endsWith('ocr/service.ts');
const isAllowedOcrModuleTarget = (target) => normalizeModulePath(OCR_SERVICE_MODULE_PATH).endsWith(normalizeModulePath(target));
/**
 * **唯一"剥壳"归一化入口**（r6）：括号 + TS **类型包装**（`as` / 非空断言 `!` / 尖括号断言 `<T>` / `satisfies`）。
 *
 * ⚠ 全文件**只此一处**剥壳：实参侧（`literalText`）、callee 侧（`normalizeCallee`）、别名登记处**都**经它，
 *   不得在别处再写第二套 —— r3/r4 已有一次"同一语义两处各写一套 ⇒ 必然分叉"的教训，r5 又抓出 callee 侧漏剥；
 *   r6 复审再抓出**类型包装**这一整族（W1–W7 静态全 0 违规而运行期真加载）。
 * ⚠ r6 复审实测：`(rq as any)('./ocr/state.ts')` 与 `createRequire(import.meta.url)('./ocr/state.ts')`
 *   在**真实受护文件**里**运行期可达**（`require` 语义 + `services/api/package.json` 的 `"type": "module"`），
 *   故这两族不再只是"静态防腐"，必须收口。
 * ⚠ 本函数**只剥壳**，不判种类、不判 `require`；调用方一律拿**返回值**再判。
 */
const peelShells = (node) => {
  let current = node;
  while (current !== undefined && (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isSatisfiesExpression(current)
  )) current = current.expression;
  return current;
};
/**
 * **唯一"序列归一化"入口**（r6）：`peelShells` + 逗号序列（`(0, require)`、`(0, rq as any)`、`(0, (require))`）。
 * ⚠ callee 侧与**实参侧**共用本函数 ⇒ `require((0, './ocr/state.ts'))` 也不再是盲区（复审 N7/F41）。
 */
const stripSequence = (node) => {
  let current = peelShells(node);
  while (current !== undefined && ts.isBinaryExpression(current)
    && current.operatorToken.kind === ts.SyntaxKind.CommaToken) current = peelShells(current.right);
  return current;
};
/**
 * **唯一 callee 归一化判据**（r6）：动态 `import(...)`、`require(...)`/间接别名调用 `X(...)`、
 * 以及 `createRequire(…)(…)` **当场调用**的**唯一**识别入口。先 `stripSequence`（剥壳 + 剥逗号），
 * 最后**恰好**剩三种之一：
 *   · `ImportKeyword` ⇒ `dynamic-import`；· Identifier ⇒ `identifier`（`require`/登记别名）；
 *   · `CallExpression` ⇒ **递归**判其 callee 是否为 `createRequire` 或登记别名 ⇒ `immediate-require`。
 * ⇒ 覆盖 `import(…)`、`require(…)`、`(require)(…)`、`((require))(…)`、`(0, require)(…)`、`(require as any)(…)`、
 *   `(require!)(…)`、`(0, require as any)(…)`、各类别名（含 `(rq as any)(…)`）、
 *   `createRequire(import.meta.url)(…)`、`(0, createRequire(import.meta.url))(…)`。
 *
 * ⚠ **两侧同源**：不在别处另写一套 —— 调用侧直接复用本函数结果，否则又会分叉出
 *   "别名侧认包装、动态 import 侧不认"这一类不对称漏分支（r5 实测过一次，被自测当场抓红）。
 * ⚠ 递归**只经本函数自身**（唯一入口），深度 = callee 链长度（静态源码、有限）。
 */
const normalizeCallee = (node, requireAliases) => {
  const current = stripSequence(node);
  if (current === undefined) return null;
  if (current.kind === ts.SyntaxKind.ImportKeyword) return { kind: 'dynamic-import' };
  if (ts.isIdentifier(current)) return { kind: 'identifier', name: current.text };
  if (ts.isCallExpression(current)) {
    const inner = normalizeCallee(current.expression, requireAliases);
    if (inner !== null && inner.kind === 'identifier'
      && (inner.name === 'createRequire' || requireAliases.has(inner.name))) {
      return { kind: 'immediate-require', name: inner.name };
    }
  }
  return null;
};
/** callee 的 `require` 语义标签；**不是** require 则返回 null（`import(...)`、域外标识符、其它表达式） */
const requireCalleeLabel = (node, requireAliases) => {
  const callee = normalizeCallee(node, requireAliases);
  if (callee === null) return null;
  if (callee.kind === 'identifier') {
    if (callee.name === 'require') return 'require()';
    return requireAliases.has(callee.name) ? '间接 require()' : null;
  }
  if (callee.kind === 'immediate-require') return '`createRequire(…)` 当场调用';
  return null;
};
const literalText = (node) => {
  // 剥壳 + 剥逗号序列：`require(('./ocr/state.ts'))`、`require('./ocr/state.ts' as any)`、
  // `require((0, './ocr/state.ts'))` 的 `arguments[0]` 都不是裸字面量
  const current = stripSequence(node); // ⚠ 与 callee 侧**同一个**归一化入口（见上）
  // ⚠ 必须按**节点种类**判定，不能只看"有没有 `.text`"：`Identifier` 也有 `.text`
  //   ⇒ 那样会把 `import(someVar)` / `require(someVar)` 误当成字面量 `someVar` 而**静默放行**（r4 实测抓到）。
  if (current === undefined) return null;
  return ts.isStringLiteralLike(current) ? current.text : null;
};

// ─────────── r7：装载登记的归类、断言与「子进程形态探针」───────────
/** 仓根相对（归一化）路径；非 `file:` 或落在仓外 ⇒ `null`。 */
const repoRelativeFromUrl = (url) => {
  if (typeof url !== 'string' || !url.startsWith('file:')) return null;
  try {
    const absolute = fileURLToPath(url);
    if (!absolute.startsWith(REPO_ROOT_FOR_PATHS)) return null;
    return normalizeModulePath(absolute.slice(REPO_ROOT_FOR_PATHS.length).replace(/\\/g, '/'));
  } catch {
    return null;
  }
};
/** 从受护文件 `app.ts` 是否可达该 URL（沿登记到的装载边反向遍历）。 */
const isReachableFromApp = (url) => {
  if (url === APP_MODULE_URL) return true;
  const seen = new Set([url]);
  let frontier = [url];
  while (frontier.length > 0) {
    const next = [];
    for (const current of frontier) {
      for (const edge of moduleLoadRegistry.edges.get(current) ?? []) {
        if (edge.parentUrl === APP_MODULE_URL) return true;
        if (!seen.has(edge.parentUrl)) {
          seen.add(edge.parentUrl);
          next.push(edge.parentUrl);
        }
      }
    }
    frontier = next;
  }
  return false;
};
/** 逐字满足派单要求：打印「经 <哪条路径> 装载了 <specifier> → <URL>」。 */
const describeLoadPath = (parentUrl, specifier, url) => {
  const chain = [];
  let current = parentUrl;
  const seen = new Set();
  while (current !== null && current !== undefined && current !== APP_MODULE_URL && !seen.has(current)) {
    seen.add(current);
    const edges = moduleLoadRegistry.edges.get(current) ?? [];
    const edge = edges.find((candidate) => candidate.parentUrl === APP_MODULE_URL) ?? edges[0];
    if (edge === undefined) break;
    chain.push(edge.specifier);
    current = edge.parentUrl;
  }
  chain.reverse();
  const owner = parentUrl === null || parentUrl === undefined ? '(未知装载者)' : (repoRelativeFromUrl(parentUrl) ?? parentUrl);
  const prefix = parentUrl === APP_MODULE_URL ? 'app.ts' : `app.ts → ${chain.join(' → ')}`;
  return `经 ${prefix}（装载者 ${owner}）装载了 '${specifier}' → ${url}`;
};
/**
 * **冻结基线**（r7，逐条实测量于**未改动**的 `app.ts` 引用图）：本仓装配路径今天合法装载的 **9 条** OCR 域装载边。
 *
 * 为什么必须有基线（实测结论，不得读成"放宽"）：派单的字面要求是「登记集合内**无任何** OCR 域条目」，
 *   但**未改动**的仓库运行期就有 9 条 OCR 域边 —— `app.ts → routes/ocr.ts` 是合法装配，而 `routes/ocr.ts`
 *   静态装载 `../ocr/{service,store,provider,media,reference}.ts`，其中 `service.ts`/`store.ts`/`reference.ts`
 *   又各自装载 `./state.ts` ⇒ 按字面断言会把**未改动**的仓库判红（等于把工具本身做成坏的）。
 *   故判据口径定为**边级**：「**没有任何 OCR 域装载边落在基线之外**」——基线内 9 条＝既有合法装配，
 *   **任何新边一律判红**（fail-closed，不静默）。
 * 为什么是**边**（loader + specifier + target 三元）而不是"目标 URL 白名单"：`app.ts` 自己用
 *   `(rq as any)('./ocr/state.ts')` 装载的是**同一个** `ocr/state.ts`，差别只在**加载者与 specifier**
 *   ⇒ 只有边级口径才能既放过既有装配、又抓住注入（15 形态实测：全部记为 `app.ts` 出发的**新边**）。
 * ⚠ 基线是"当前事实的冻结记录"：合法装配若变化（例如 `routes/ocr.ts` 改引用别的 ocr 模块），本判据会判红并
 *   要求显式更新此表 —— 这是**有意的**（宁可要求人复核，也不静默放过新增的 OCR 域引用）。
 */
const OCR_REGISTRY_BASELINE_EDGES = [
  { loader: 'services/api/src/app.ts', specifier: './ocr/service.ts', target: 'services/api/src/ocr/service.ts' },
  { loader: 'services/api/src/routes/ocr.ts', specifier: '../ocr/service.ts', target: 'services/api/src/ocr/service.ts' },
  { loader: 'services/api/src/routes/ocr.ts', specifier: '../ocr/store.ts', target: 'services/api/src/ocr/store.ts' },
  { loader: 'services/api/src/routes/ocr.ts', specifier: '../ocr/provider.ts', target: 'services/api/src/ocr/provider.ts' },
  { loader: 'services/api/src/routes/ocr.ts', specifier: '../ocr/media.ts', target: 'services/api/src/ocr/media.ts' },
  { loader: 'services/api/src/routes/ocr.ts', specifier: '../ocr/reference.ts', target: 'services/api/src/ocr/reference.ts' },
  { loader: 'services/api/src/ocr/service.ts', specifier: './state.ts', target: 'services/api/src/ocr/state.ts' },
  { loader: 'services/api/src/ocr/store.ts', specifier: './state.ts', target: 'services/api/src/ocr/state.ts' },
  { loader: 'services/api/src/ocr/reference.ts', specifier: './state.ts', target: 'services/api/src/ocr/state.ts' },
];
const OCR_REGISTRY_BASELINE_KEYS = new Set(
  OCR_REGISTRY_BASELINE_EDGES.map((edge) => `${edge.loader}|${edge.specifier}|${edge.target}`),
);
/**
 * r9：基线 **key ⇄ 描述符** 的唯一检索表（**由**上面两份既有常量派生 ⇒ 不新造第二份基线表）。
 * 用途：`collectMissingBaselineEdges` 判红时要点名**丢了哪一条**（loader / specifier / target 三要素）。
 * ⚠ 顺序对齐由**语言规范**保证：`OCR_REGISTRY_BASELINE_KEYS` 是 `OCR_REGISTRY_BASELINE_EDGES.map(…)` 的结果，
 *   Set 的迭代顺序即插入顺序 ⇒ 第 i 个 key 恰对应第 i 条边（不得在此之外另建一张映射表）。
 */
const OCR_REGISTRY_BASELINE_EDGES_BY_KEY = new Map(
  [...OCR_REGISTRY_BASELINE_KEYS].map((key, index) => [key, OCR_REGISTRY_BASELINE_EDGES[index]]),
);
/**
 * r8（阻断 B 返修）：**解析被第三方改写**的 fail-closed 判据。
 *
 * 被审版本（r7c，`8e3b350`）的 `collectOcrRegistryEdges` 以 `if (target === null || !isOcrDomainTarget(target)) continue;`
 * 静默丢弃**一切**非 `file:` / 仓外的解析结果。复审实测（`.pg17/adv-verdict-ocr-guard-runtime-registry-8e3b350.md` §8）：
 * `services/api/src/config.ts` 在装载期抢先注册**第二个** `registerHooks`，把 `app.ts → './routes/ocr.ts'` 的 resolve
 * 改写成 `data:text/javascript;base64,…` ⇒ `repoRelativeFromUrl()` 返回 `null` ⇒ 该边被 `continue` **静默丢弃**
 * ⇒ 护栏 **exit 0 ＋ `PASS 14 组` 全绿（假绿）**。故这里把"目标不是仓内 `file:` URL"从"忽略"改成**判红**。
 *
 * 判据取值（派单口径：`target === null` 的边**一律**计入 findings，内建模块走**显式白名单**）：
 *   「`resolve` 结果**不是仓内 `file:` URL**、且 `specifier` **不是内建模块** ⇒ 判红」（不附加可达性前置条件）。
 * 为什么内建要显式豁免：未改动的仓库运行期本来就有 **82 条**非 `file:` 解析结果（实测全部是 `node:` 内建，如
 * `node:crypto`/`node:fs`/…）⇒ 按字面一律判红会把**未改动**的仓库判红（等于把工具做成坏的，与 r7 基线同一条理由）。
 * 为什么不附加"parentUrl 必须可达"：附加可达性会给「把 `app.ts` 自身的解析改写成 `data:`」这类形状留口子 ——
 * 那时受护引用图整体不可达、可达边集合塌缩为 0，而本判据按"基线之外"计数，塌缩反而**全绿**（实测口径推演）。
 * 判词含 `parentUrl` / `specifier` / `loader` 三要素，并尽量给出"照常应解析到"的期望路径（含是否落 OCR 域）。
 */
const expectedRepoRelativeFromSpecifier = (parentUrl, specifier) => {
  if (typeof specifier !== 'string') return null;
  if (isBuiltin(specifier)) return null; // 内建（`node:fs` / `fs` / `node:fs/promises`）⇒ 合法非 `file:` 目标
  const parentAbsolute = (() => {
    if (typeof parentUrl !== 'string' || !parentUrl.startsWith('file:')) return null;
    try { return fileURLToPath(parentUrl); } catch { return null; }
  })();
  const parentDirectory = parentAbsolute === null ? null : dirname(parentAbsolute);
  if (parentDirectory === null) return null; // 装载者本身不是仓内文件 ⇒ 无从判断"照常会解析到哪里"，不臆断
  let expected = null;
  try {
    expected = normalizeModulePath(resolvePath(parentDirectory, specifier).replace(/\\/g, '/'));
  } catch {
    return null;
  }
  const relative = expected.startsWith(REPO_ROOT_POSIX_PREFIX)
    ? expected.slice(REPO_ROOT_POSIX_PREFIX.length).replace(/^\/+/, '')
    : null;
  return { relative, absolute: expected };
};
/** 登记到的、从受护文件可达的 OCR 域装载**边**（去重，key = loader|specifier|target）；r8 起在最前面并入 fail-closed 命中项。 */
const collectOcrRegistryEdges = (source = moduleLoadRegistry.entries) => {
  const edges = new Map();
  const failClosed = [];
  // r8 自检（复审 §8 建议／派单字面口径）：「同一 `parentUrl` 不得出现重复 resolve 记录」⇒ 出现即 fail-closed。
  //   ⚠ 计数口径必须按 **(parentUrl, specifier) 对**，不能按纯 `parentUrl`：实测未改动仓库里单个 parentUrl 最多有
  //   **78** 条 resolve（同一模块装载多个不同 specifier）⇒ 按纯 parentUrl 计数会大量误报。
  //   ⚠ 判红条件必须再限定为「**同一对解析出不同 URL**」。字面口径（同一对出现 ≥2 次即判红）在**未改动**仓库上
  //   实测误报 **7** 条（原始读数：`…\r8\guard-r8-green-6.txt` —— `node_modules/ajv/**` 与 `node_modules/ajv-formats/**`
  //   在 Fastify schema 编译阶段对同一 (parentUrl, specifier) **幂等重解析**，前后 URL **完全相同**）⇒ 字面口径下收尾
  //   负控制 `assert.equal(registrySummary.failClosedEdges, 0, …)` **不可满足**（等于把工具做成坏的）。
  //   URL 相同的重解析不携带任何"解析被改写"的信号 ⇒ 只计数（`countRepeatResolvePairs`，见汇总行），不判红；
  //   URL 不同则是第二个 `registerHooks` 改写/劫持的确定信号 ⇒ 判红（fail-closed）。
  const resolvedByPair = new Map();
  for (const entry of source) {
    if (entry.specifier === null) continue; // 只看带 specifier 的 resolve 边
    const pairKey = `${String(entry.parentUrl)}|${entry.specifier}`;
    const previousUrls = resolvedByPair.get(pairKey);
    if (previousUrls !== undefined) {
      const previousUrl = [...previousUrls][0];
      if (!previousUrls.has(entry.url)) {
        const loader = repoRelativeFromUrl(entry.parentUrl) ?? String(entry.parentUrl);
        failClosed.push({
          key: `duplicate-resolve|${pairKey}`,
          loader,
          specifier: entry.specifier,
          target: `(重复 resolve：同一 (parentUrl, specifier) 解析出 ${previousUrls.size + 1} 个**不同** URL)`,
          url: entry.url,
          parentUrl: entry.parentUrl,
          expectedTarget: null,
          failClosed: true,
          message: `${describeLoadPath(entry.parentUrl, entry.specifier, entry.url)}（⚠ **重复 resolve 记录**：parentUrl=${String(entry.parentUrl)} specifier='${entry.specifier}' loader=${loader} —— 同一 (parentUrl, specifier) 先解析到 \`${previousUrl}\`、又解析到 \`${entry.url}\`（URL **不一致**）⇒ 装载器被第二个 registerHooks 改写/劫持，判据 fail-closed）`,
        });
      }
    }
    const pairUrls = previousUrls ?? new Set();
    pairUrls.add(entry.url);
    resolvedByPair.set(pairKey, pairUrls);
    const target = repoRelativeFromUrl(entry.url);
    if (target === null) {
      // 派单口径（字面）：`target === null` 的边**一律**计入 findings（fail-closed），只有内建模块走**显式白名单**。
      //   ⚠ 不附加"parentUrl 必须从受护文件可达"：字面口径下**任何**非仓内 `file:` 的解析结果都判红（未改动仓库
      //   实测这类记录 82 条且全部是内建 ⇒ 负控制仍为 0）；附加可达性反而会给"把 app.ts 自身的解析改写成 data:"
      //   这类形状留口子（此时受护引用图整体不可达、边集合塌缩为 0，而按"基线之外"的口径依然全绿）。
      if (isBuiltin(entry.specifier)) continue; // 内建（`node:*` / 裸名）：合法非 `file:` 目标（未改动仓库实测 82 条）
      const loader = repoRelativeFromUrl(entry.parentUrl) ?? String(entry.parentUrl);
      const expectation = expectedRepoRelativeFromSpecifier(entry.parentUrl, entry.specifier);
      const expectedText = expectation === null
        ? '（无法推断"照常应解析到"哪条仓内路径：装载者或 specifier 不构成仓内相对解析）'
        : `照常应解析到${expectation.relative === null ? `仓外路径 \`${expectation.absolute}\`` : `仓内路径 '${expectation.relative}'`}`;
      const ocrDomainNote = expectation !== null && expectation.relative !== null && isOcrDomainTarget(expectation.relative)
        ? '，且该路径**落在 OCR 域**'
        : '';
      failClosed.push({
        key: `unresolved-target|${loader}|${entry.specifier}|${entry.url}`,
        loader,
        specifier: entry.specifier,
        target: `(解析结果非仓内 file: URL ⇒ ${entry.url})`,
        url: entry.url,
        parentUrl: entry.parentUrl,
        expectedTarget: expectation === null ? null : expectation.relative,
        failClosed: true,
        message: `${describeLoadPath(entry.parentUrl, entry.specifier, entry.url)}（⚠ 解析被改写：parentUrl=${String(entry.parentUrl)} specifier='${entry.specifier}' loader=${loader} —— 实际解析结果 \`${entry.url}\` **不是仓内 file: URL**；${expectedText}${ocrDomainNote} ⇒ 判据 fail-closed）`,
      });
      continue;
    }
    if (!isOcrDomainTarget(target)) continue;
    if (entry.parentUrl === null || entry.parentUrl === undefined || !isReachableFromApp(entry.parentUrl)) continue;
    const loader = repoRelativeFromUrl(entry.parentUrl) ?? entry.parentUrl;
    const key = `${loader}|${entry.specifier}|${target}`;
    if (edges.has(key)) continue;
    edges.set(key, { key, loader, specifier: entry.specifier, target, url: entry.url, parentUrl: entry.parentUrl, expectedTarget: null });
  }
  return [...failClosed, ...edges.values()];
};
/**
 * r8 自检的**计数**侧：同一 `(parentUrl, specifier)` 对出现 ≥2 条 resolve 记录的**对数**（不看 URL 是否相同）。
 * 只作透明计数写进汇总行（`幂等重解析`），**不作判红条件** —— 实测未改动仓库在回环 HTTP 阶段就有这类幂等重解析
 * （`node_modules/ajv/**`、`node_modules/ajv-formats/**`，前后 URL 完全相同；原始读数 `…\r8\guard-r8-green-6.txt`）。
 * 判红条件是**同一对解析出不同 URL**（见 `collectOcrRegistryEdges` 的 `duplicate-resolve` 命中项）。
 */
const countRepeatResolvePairs = (source = moduleLoadRegistry.entries) => {
  const seenPairs = new Map();
  let repeats = 0;
  for (const entry of source) {
    if (entry.specifier === null) continue;
    const pairKey = `${String(entry.parentUrl)}|${entry.specifier}`;
    const count = (seenPairs.get(pairKey) ?? 0) + 1;
    seenPairs.set(pairKey, count);
    if (count === 2) repeats += 1;
  }
  return repeats;
};
/** 归类：可达的 OCR 域装载边**剔除冻结基线**后即为违规（可传入**指定登记切片** ⇒ 形态钉子只看"该形态自己"的边）。 */
const collectOcrRegistryFindings = (source = moduleLoadRegistry.entries) => {
  const findings = [];
  for (const edge of collectOcrRegistryEdges(source)) {
    // ⚠ 判据必须看**显式标记** `failClosed`，不能看 `expectedTarget !== null`：重复 resolve 命中项的
    //   `expectedTarget` 本来就是 `null`（它记的是"同一对解析出两个不同 URL"，不是"照常应落 OCR 域"）
    //   ⇒ 按 `expectedTarget` 判会把它当成普通边、把 fail-closed 判词**覆盖成基线文案**（实测踩到，r8 自测抓出）。
    if (edge.failClosed === true) {
      findings.push(edge); // r8 fail-closed（解析被改写/重复 resolve）：一律判红，不参与基线豁免
      continue;
    }
    if (OCR_REGISTRY_BASELINE_KEYS.has(edge.key)) continue;
    findings.push({
      ...edge,
      message: `${describeLoadPath(edge.parentUrl, edge.specifier, edge.url)}（注意：该边**不在** r7 冻结基线的 ${OCR_REGISTRY_BASELINE_EDGES.length} 条合法边内）`,
    });
  }
  return findings;
};
/**
 * r9（复审 r8 非阻塞项 ③）：**基线必须全部命中** —— 主判据只判「基线之外**多出来**的边」，
 *   **不判「基线之内少掉的边」**。
 *
 * 缺陷形状（实测，不是推演）：把任一条基线边从登记集合里剔掉（探针＝本片副本里对
 *   `routes/ocr.ts|../ocr/provider.ts` 一条直接 `continue` 不收集）⇒ 可达边 9→8、基线之外 0、fail-closed 0
 *   ⇒ 旧断言**全绿**，汇总行只是把「冻结基线命中 8 条」当**读数**打印出去，没有任何断言比对 8 ≠ 9
 *   ⇒ **丢掉一条基线边仍然 exit 0（假绿）**。
 *
 * 判据：`OCR_REGISTRY_BASELINE_KEYS` − 命中集合 = ∅。命中集合取主判据**同一份** `collectOcrRegistryEdges`；
 *   fail-closed 命中项**不算**基线命中（它由 r8 判据单独判红，`key` 也与基线 key 不同形状）。
 * ⚠ 只做差集，不新造基线表。
 */
const collectMissingBaselineEdges = (source = moduleLoadRegistry.entries) => {
  const hitKeys = new Set();
  for (const edge of collectOcrRegistryEdges(source)) {
    if (edge.failClosed === true) continue;
    hitKeys.add(edge.key);
  }
  return [...OCR_REGISTRY_BASELINE_KEYS]
    .filter((key) => !hitKeys.has(key))
    .map((key) => ({ key, edge: OCR_REGISTRY_BASELINE_EDGES_BY_KEY.get(key) }));
};
/** 基线丢失项的判词（**点名丢哪一条**：loader → specifier → target ＋ key 原文）。 */
const describeMissingBaselineEdges = (missing) => missing
  .map(({ key, edge }) => `  · ${edge.loader} → '${edge.specifier}' → ${edge.target}（key=${key}）`)
  .join('\n');
/**
 * 主判据断言：**两条鉴别力合并**，作用域比"OCR 域装载边"更宽 ⇒ 判词必须与作用域一致（复审非阻塞 ②）：
 *   · r7 侧（作用域＝**OCR 域装载边**）：从受护文件可达的 OCR 域装载边里，**不得**出现基线之外的新边。
 *   · r8 侧（作用域＝**域无关**）：两类 fail-closed 命中一律判红 ——「解析结果不是仓内 `file:` URL 且
 *     `specifier` 不是内建模块」与「同一 `(parentUrl, specifier)` 解析出**不同** URL」。
 * ⚠ 为什么**不**把 r8 侧收窄到 OCR 域（非阻塞 ② 的二选一，这里选"保留宽判据 ＋ 改文案"）：复审 F3 实测
 *   重复 resolve 先落在 `node_modules/ajv-formats/**` 这类**非 OCR 域**模块上；若按 OCR 域过滤，
 *   「先把非 OCR 模块改写成 `data:`／两个不同 URL，再从那里绕回 OCR 域」这条通道就重新静默放行
 *   ⇒ 收窄会**削弱鉴别力**，故判据保持宽，只把判词改成如实的分项计数。
 */
const assertRegistryClean = (label) => {
  const findings = collectOcrRegistryFindings();
  if (findings.length > 0) {
    const failClosedHits = findings.filter((finding) => finding.failClosed === true);
    const baselineOutsideEdges = findings.filter((finding) => finding.failClosed !== true);
    assert.fail(`OCRREGISTRY: ${label} —— 运行期装载登记抓到 ${findings.length} 条判红项（其中「基线之外的 OCR 域装载边」${baselineOutsideEdges.length} 条 ＋「域无关的 fail-closed 解析命中」${failClosedHits.length} 条；r7 ＋ r8 两条判据）：\n${findings.map((finding) => `  · ${finding.message}`).join('\n')}`);
  }
  return findings.length;
};
/** 登记概况（正常路径打印；含正控制是否成立与基线命中数）。 */
const describeRegistrySummary = () => {
  const resolveCount = moduleLoadRegistry.entries.filter((entry) => entry.hook === 'resolve').length;
  const edges = collectOcrRegistryEdges();
  const failClosedEdges = edges.filter((edge) => edge.failClosed === true);
  const baselineAndNew = edges.filter((edge) => edge.failClosed !== true);
  return {
    resolveCount,
    loadCount: moduleLoadRegistry.entries.length - resolveCount,
    ocrReachableEdges: baselineAndNew.length,
    baselineEdges: baselineAndNew.filter((edge) => OCR_REGISTRY_BASELINE_KEYS.has(edge.key)).length,
    newEdges: baselineAndNew.filter((edge) => !OCR_REGISTRY_BASELINE_KEYS.has(edge.key)).length,
    failClosedEdges: failClosedEdges.length,
    repeatResolvePairs: countRepeatResolvePairs(),
    positiveControl: moduleLoadRegistry.entries.some((entry) => entry.specifier === 'node:os' && entry.url === 'node:os'),
  };
};

/** 形态探针的受护文件（`app.ts`）相对基准：与真实攻击**同一条解析路径**。 */
const OCR_PROBE_SPECIFIER = './ocr/state.ts';
const OCR_PROBE_HARMLESS_SPECIFIER = './contract.ts';
/** r8：取「`app.ts` 真装载 `./ocr/state.ts`」那条**真实登记记录**（两条改写形态钉子以它为基底注入）。 */
const findAppOcrStateEntry = () => {
  const recorded = moduleLoadRegistry.entries.find(
    (entry) => entry.specifier === OCR_PROBE_SPECIFIER && entry.parentUrl === APP_MODULE_URL
      && repoRelativeFromUrl(entry.url) === 'services/api/src/ocr/state.ts',
  );
  if (recorded === undefined) throw new Error('登记器里没有 app.ts → ./ocr/state.ts 的真实记录 ⇒ 该形态钉子无意义');
  return recorded;
};
/**
 * r7 负/正控制形态表（**运行期**等价于「经某条路径装载某个模块」）。
 * 逐条在**子进程**里真跑（`node <本脚本> --registry-probe=<id>`）：`expectViolation: true` ⇒ r7 主判据**必须**判红
 * （exit 1 + `OCRREGISTRY` + specifier 原文）；`expectViolation: false`（对照）⇒ 必须**被登记但不判红**。
 * 每条都先断言「登记器确实登记了该 specifier」（否则是「登记器恒空 ⇒ 恒绿」的退化，判据无意义）⇒ 双向自证。
 * 另有两条**如实固定**的非装载/非可执行形状（`expectLoad: false` / `expectRuntimeError`）：
 *   它们是**运行期事实**的钉子（不是判据盲区，也不冒充"抓住"），防止后人把"这条跑不了"误读成"判据覆盖了"。
 */
const registryProbeForms = [
  { id: 'direct', title: 'createRequire(app)(…) 直接调用', expectViolation: true, expectSpecifier: OCR_PROBE_SPECIFIER, expectUrlSuffix: '/services/api/src/ocr/state.ts', run: () => createRequire(APP_MODULE_URL)(OCR_PROBE_SPECIFIER) },
  { id: 'call', title: 'rq.call(null, …)', expectViolation: true, expectSpecifier: OCR_PROBE_SPECIFIER, expectUrlSuffix: '/services/api/src/ocr/state.ts', run: () => { const rq = createRequire(APP_MODULE_URL); return rq.call(null, OCR_PROBE_SPECIFIER); } },
  { id: 'apply', title: 'rq.apply(null, [ … ])', expectViolation: true, expectSpecifier: OCR_PROBE_SPECIFIER, expectUrlSuffix: '/services/api/src/ocr/state.ts', run: () => { const rq = createRequire(APP_MODULE_URL); return rq.apply(null, [OCR_PROBE_SPECIFIER]); } },
  { id: 'bind', title: 'rq.bind(null)(…)', expectViolation: true, expectSpecifier: OCR_PROBE_SPECIFIER, expectUrlSuffix: '/services/api/src/ocr/state.ts', run: () => { const rq = createRequire(APP_MODULE_URL); return rq.bind(null)(OCR_PROBE_SPECIFIER); } },
  { id: 'reflect-apply', title: 'Reflect.apply(rq, null, [ … ])', expectViolation: true, expectSpecifier: OCR_PROBE_SPECIFIER, expectUrlSuffix: '/services/api/src/ocr/state.ts', run: () => { const rq = createRequire(APP_MODULE_URL); return Reflect.apply(rq, null, [OCR_PROBE_SPECIFIER]); } },
  { id: 'construct', title: 'new (rq)(…) 构造调用', expectViolation: true, expectSpecifier: OCR_PROBE_SPECIFIER, expectUrlSuffix: '/services/api/src/ocr/state.ts', run: () => { const rq = createRequire(APP_MODULE_URL); return new rq(OCR_PROBE_SPECIFIER); } },
  { id: 'factory-call', title: 'createRequire.call(null, url)(…)', expectViolation: true, expectSpecifier: OCR_PROBE_SPECIFIER, expectUrlSuffix: '/services/api/src/ocr/state.ts', run: () => createRequire.call(null, APP_MODULE_URL)(OCR_PROBE_SPECIFIER) },
  { id: 'factory-apply', title: 'createRequire.apply(null, [url])(…)', expectViolation: true, expectSpecifier: OCR_PROBE_SPECIFIER, expectUrlSuffix: '/services/api/src/ocr/state.ts', run: () => createRequire.apply(null, [APP_MODULE_URL])(OCR_PROBE_SPECIFIER) },
  { id: 'factory-bind-no-load', title: 'createRequire.bind(null, url)(…) —— 实测该形状**不装载**（返回 require 函数本身）', expectViolation: false, expectLoad: false, expectSpecifier: OCR_PROBE_SPECIFIER, expectUrlSuffix: '/services/api/src/ocr/state.ts', run: () => createRequire.bind(null, APP_MODULE_URL)(OCR_PROBE_SPECIFIER) },
  { id: 'factory-comma', title: '(0, createRequire)(url)(…)', expectViolation: true, expectSpecifier: OCR_PROBE_SPECIFIER, expectUrlSuffix: '/services/api/src/ocr/state.ts', run: () => (0, createRequire)(APP_MODULE_URL)(OCR_PROBE_SPECIFIER) },
  { id: 'factory-paren', title: '(createRequire)(url)(…)', expectViolation: true, expectSpecifier: OCR_PROBE_SPECIFIER, expectUrlSuffix: '/services/api/src/ocr/state.ts', run: () => (createRequire)(APP_MODULE_URL)(OCR_PROBE_SPECIFIER) },
  { id: 'factory-nested-comma', title: '((0, createRequire))(url)(…)', expectViolation: true, expectSpecifier: OCR_PROBE_SPECIFIER, expectUrlSuffix: '/services/api/src/ocr/state.ts', run: () => ((0, createRequire))(APP_MODULE_URL)(OCR_PROBE_SPECIFIER) },
  { id: 'namespace', title: "import('node:module') 后的 mod.createRequire(url)(…)", expectViolation: true, expectSpecifier: OCR_PROBE_SPECIFIER, expectUrlSuffix: '/services/api/src/ocr/state.ts', run: async () => { const mod = await import('node:module'); return mod.createRequire(APP_MODULE_URL)(OCR_PROBE_SPECIFIER); } },
  { id: 'namespace-var', title: 'const q2 = mod.createRequire(url); q2(…)', expectViolation: true, expectSpecifier: OCR_PROBE_SPECIFIER, expectUrlSuffix: '/services/api/src/ocr/state.ts', run: async () => { const mod = await import('node:module'); const q2 = mod.createRequire(APP_MODULE_URL); return q2(OCR_PROBE_SPECIFIER); } },
  { id: 'namespace-default', title: 'mod.default.createRequire(url)(…)', expectViolation: true, expectSpecifier: OCR_PROBE_SPECIFIER, expectUrlSuffix: '/services/api/src/ocr/state.ts', run: async () => { const mod = await import('node:module'); return mod.default.createRequire(APP_MODULE_URL)(OCR_PROBE_SPECIFIER); } },
  { id: 'destructure', title: 'const { createRequire: cr } = await import(…); cr(url)(…)', expectViolation: true, expectSpecifier: OCR_PROBE_SPECIFIER, expectUrlSuffix: '/services/api/src/ocr/state.ts', run: async () => { const { createRequire: cr } = await import('node:module'); return cr(APP_MODULE_URL)(OCR_PROBE_SPECIFIER); } },
  { id: 'import-alias', title: 'const { createRequire: cr } = ns; cr(url)(…)', expectViolation: true, expectSpecifier: OCR_PROBE_SPECIFIER, expectUrlSuffix: '/services/api/src/ocr/state.ts', run: async () => { const ns = await import('node:module'); const cr = ns.createRequire; return cr(APP_MODULE_URL)(OCR_PROBE_SPECIFIER); } },
  { id: 'static-import-alias', title: 'import { createRequire as cr } 静态别名; cr(url)(…)', expectViolation: true, expectSpecifier: OCR_PROBE_SPECIFIER, expectUrlSuffix: '/services/api/src/ocr/state.ts', run: () => createRequireViaStaticImport(APP_MODULE_URL)(OCR_PROBE_SPECIFIER) },
  { id: 'default-property', title: 'const cr = ns.default.createRequire; cr(url)(…)', expectViolation: true, expectSpecifier: OCR_PROBE_SPECIFIER, expectUrlSuffix: '/services/api/src/ocr/state.ts', run: async () => { const ns = await import('node:module'); const cr = ns.default.createRequire; return cr(APP_MODULE_URL)(OCR_PROBE_SPECIFIER); } },
  { id: 'handoff-identity', title: '别名经恒等函数转手后调用', expectViolation: true, expectSpecifier: OCR_PROBE_SPECIFIER, expectUrlSuffix: '/services/api/src/ocr/state.ts', run: () => { const rq = createRequire(APP_MODULE_URL); const identity = (value) => value; return identity(rq)(OCR_PROBE_SPECIFIER); } },
  { id: 'handoff-object', title: '别名放进对象再取回调用', expectViolation: true, expectSpecifier: OCR_PROBE_SPECIFIER, expectUrlSuffix: '/services/api/src/ocr/state.ts', run: () => { const rq = createRequire(APP_MODULE_URL); const box = { load: rq }; return box.load(OCR_PROBE_SPECIFIER); } },
  { id: 'handoff-array', title: '别名放进数组再取回调用', expectViolation: true, expectSpecifier: OCR_PROBE_SPECIFIER, expectUrlSuffix: '/services/api/src/ocr/state.ts', run: () => { const rq = createRequire(APP_MODULE_URL); const list = [rq]; return list[0](OCR_PROBE_SPECIFIER); } },
  { id: 'handoff-assertion-chain', title: '(rq as unknown as NodeRequire) 断言链转手后调用', expectViolation: true, expectSpecifier: OCR_PROBE_SPECIFIER, expectUrlSuffix: '/services/api/src/ocr/state.ts', run: () => { const rq = createRequire(APP_MODULE_URL); const f = rq; return f(OCR_PROBE_SPECIFIER); } },
  { id: 'returned', title: '函数返回别名后再调用', expectViolation: true, expectSpecifier: OCR_PROBE_SPECIFIER, expectUrlSuffix: '/services/api/src/ocr/state.ts', run: () => { const make = () => createRequire(APP_MODULE_URL); return make()(OCR_PROBE_SPECIFIER); } },
  { id: 'optional-call', title: 'rq?.(…) 可选调用', expectViolation: true, expectSpecifier: OCR_PROBE_SPECIFIER, expectUrlSuffix: '/services/api/src/ocr/state.ts', run: () => { const rq = createRequire(APP_MODULE_URL); return rq?.(OCR_PROBE_SPECIFIER); } },
  { id: 'deep-comma', title: '(0, (0, rq))(…) 深层逗号序列', expectViolation: true, expectSpecifier: OCR_PROBE_SPECIFIER, expectUrlSuffix: '/services/api/src/ocr/state.ts', run: () => { const rq = createRequire(APP_MODULE_URL); return (0, (0, rq))(OCR_PROBE_SPECIFIER); } },
  { id: 'bound-alias', title: 'const bound = rq.bind(null); bound(…)', expectViolation: true, expectSpecifier: OCR_PROBE_SPECIFIER, expectUrlSuffix: '/services/api/src/ocr/state.ts', run: () => { const rq = createRequire(APP_MODULE_URL); const bound = rq.bind(null); return bound(OCR_PROBE_SPECIFIER); } },
  { id: 'unbound', title: '未绑定 require（`const r = require; r(…)`）—— 本进程里 `require` 由脚本自身定义（`createRequire(import.meta.url)`）⇒ 退化为"以本脚本目录为基准解析 ⇒ 找不到模块"的 `Error`（不装载本域模块；受护文件是 ESM，`require` 未定义 ⇒ 运行期 `ReferenceError`，两者都到不了装载器）', expectViolation: false, expectRuntimeError: 'Error', expectSpecifier: OCR_PROBE_SPECIFIER, expectUrlSuffix: '/services/api/src/ocr/state.ts', run: () => { const r = require; return r(OCR_PROBE_SPECIFIER); } },
  { id: 'unbound-null', title: '`const r = null; r(…)` —— 实测运行期 `TypeError`', expectViolation: false, expectRuntimeError: 'TypeError', expectSpecifier: OCR_PROBE_SPECIFIER, expectUrlSuffix: '/services/api/src/ocr/state.ts', run: () => { const r = null; return r(OCR_PROBE_SPECIFIER); } },
  { id: 'harmless-app-relative', title: '（对照）经别名装载 app 目录下的无害模块', expectViolation: false, expectSpecifier: OCR_PROBE_HARMLESS_SPECIFIER, expectUrlSuffix: '/services/api/src/contract.ts', run: () => createRequire(APP_MODULE_URL)(OCR_PROBE_HARMLESS_SPECIFIER) },
  { id: 'harmless-builtin', title: '（对照）经别名装载内建模块', expectViolation: false, expectSpecifier: 'node:path', expectUrlSuffix: 'node:path', run: () => createRequire(APP_MODULE_URL)('node:path') },
  // ───────── r8（阻断 B 返修）：两条**登记器被改写**的形态钉子 ─────────
  // 为什么是"注入登记记录"而不是"在子进程里真装一个抢跑的 registerHooks"：后者需要往**本脚本之外**写一个模块
  //   才能抢在 `import.meta.url` 之前注册（`node --import=<文件>`），而本片边界是"只改 tests/integration/ocr-http.mjs"
  //   ⇒ 不新增文件。改为在子进程里**真调用**与真实攻击同一条 `registerHooks` 的 `resolve` 钩子（拿真实
  //   `(parentUrl, specifier)`），再按复审实测的 `data:` URL 改写形状注入一条**重复 resolve 记录** ⇒ 走的是
  //   主判据的**同一份** `collectOcrRegistryEdges`/`collectOcrRegistryFindings`，不是另写一套判据。
  {
    id: 'duplicate-resolve-rewrite',
    title: '同一 (parentUrl, specifier) 出现重复 resolve 记录且解析结果不一致（复审 §8：第二个 registerHooks 抢跑改写的登记特征）',
    expectViolation: true,
    expectSpecifier: OCR_PROBE_SPECIFIER,
    expectUrlSuffix: '/services/api/src/ocr/state.ts',
    expectFragment: '重复 resolve 记录',
    run: () => {
      createRequire(APP_MODULE_URL)(OCR_PROBE_SPECIFIER); // 真装载（与 `direct` 形态同一条解析路径）⇒ 登记器里必有该边
      const recorded = findAppOcrStateEntry();
      moduleLoadRegistry.entries.push({ ...recorded, url: 'data:text/javascript;base64,ZHVwbXktZHVwbGljYXRl' });
    },
  },
  {
    id: 'resolve-target-rewritten-nonfile',
    title: '照常落 OCR 域的 specifier 被改写成非仓内 file: URL（复审 §8 实测形状：`app.ts → ./ocr/state.ts` ⇒ `data:text/javascript;base64,…`）',
    expectViolation: true,
    expectSpecifier: OCR_PROBE_SPECIFIER,
    expectUrlSuffix: '/services/api/src/ocr/state.ts',
    expectFragment: '不是仓内 file: URL',
    run: () => {
      createRequire(APP_MODULE_URL)(OCR_PROBE_SPECIFIER); // 真装载（同上）
      const recorded = findAppOcrStateEntry();
      moduleLoadRegistry.entries.push({ ...recorded, url: 'data:text/javascript;base64,ZHVwbXktcmV3cml0dGVu' });
    },
  },
];
/** 子进程形态探针：`node <本脚本> --registry-probe=<id>` ⇒ 真装载 ⇒ 主判据必须抓住（或对照必须不判红）。 */
const registryProbeFormId = (() => {
  const argument = process.argv.slice(2).find((value) => value.startsWith('--registry-probe='));
  return argument === undefined ? null : argument.slice('--registry-probe='.length);
})();
if (registryProbeFormId !== null) {
  const form = registryProbeForms.find((candidate) => candidate.id === registryProbeFormId);
  if (form === undefined) {
    console.error(`PROBE-UNKNOWN ${registryProbeFormId}`);
    process.exit(3);
  }
  let runtimeError = null;
  // ⚠ r7b：钉子只认**该形态自己**新增的登记（`entries` 里先前的边来自本进程的真实装配；受护文件被注入时
  //   那条边也在这里）⇒ 否则「不装载」钉子在**已被注入**的仓库上会误报（实测踩到：`factory-bind-no-load`
  //   因为受护文件自己装载了 `./ocr/state.ts` 而报 `PROBE-UNEXPECTED-LOAD`，把"判据抓到了"混成"钉子坏了"）。
  const entryCountBefore = moduleLoadRegistry.entries.length;
  try {
    await form.run();
  } catch (error) {
    runtimeError = error;
  }
  const ownEntries = moduleLoadRegistry.entries.slice(entryCountBefore);
  if (form.expectRuntimeError !== undefined) {
    const actual = runtimeError === null ? '(无异常)' : runtimeError.constructor.name;
    if (actual !== form.expectRuntimeError) {
      console.error(`PROBE-UNEXPECTED-ERROR ${form.id}（期望 ${form.expectRuntimeError}，实际 ${actual}）`);
      process.exit(5);
    }
    console.log(`PROBE-RUNTIME-${form.expectRuntimeError.toUpperCase()} ${form.id}（如实固定：该形状在运行期就抛 ${actual} ⇒ 到不了装载器，**不是**判据抓到的）`);
    process.exit(0);
  }
  if (runtimeError !== null) {
    console.error(`PROBE-UNEXPECTED-ERROR ${form.id} ${runtimeError.constructor.name}: ${runtimeError.message}`);
    process.exit(6);
  }
  const registered = ownEntries.some(
    (entry) => entry.specifier === form.expectSpecifier && entry.url.endsWith(form.expectUrlSuffix),
  );
  if (form.expectLoad === false) {
    if (registered) {
      console.error(`PROBE-UNEXPECTED-LOAD ${form.id}（期望该形状不装载，却登记到了 ${form.expectSpecifier}）`);
      process.exit(4);
    }
    console.log(`PROBE-NO-LOAD ${form.id}（实测该形状**不装载**目标模块 ⇒ 登记器如实没有该边；运行期事实，不冒充"判据抓住了"）`);
    process.exit(0);
  }
  if (!registered) {
    console.error(`PROBE-UNREGISTERED ${form.id}（登记器没登记 ${form.expectSpecifier} ⇒ 判据无意义）`);
    process.exit(2);
  }
  // 主判据的**同一份**归类逻辑，只喂"该形态自己"的登记切片 ⇒ 钉子与真实攻击走同一条判定。
  const ownFindings = collectOcrRegistryFindings(ownEntries);
  if (form.expectViolation) {
    if (ownFindings.length === 0) {
      console.error(`PROBE-NOT-CAUGHT ${form.id}（期望判红却没有判红）`);
      process.exit(0);
    }
    // ⚠ 必须打印**全部**命中项的判词（不能只打 `ownFindings[0]`）：同一形态可能同时命中多条 fail-closed
    //   判据（实测：`resolve-target-rewritten-nonfile` 会同时命中「重复 resolve」与「解析结果非仓内 file: URL」
    //   —— 先命中的那条会掩盖后一条的理由，自测的判词钉子就永远看不到后一条 ⇒ 实测踩到并改为此处逐条打印）。
    console.error(`OCRREGISTRY: 子进程形态探针 ${form.id} —— 该形态自身在运行期装载了 ${form.expectSpecifier}（OCR 域内且不在 r7 冻结基线的 ${OCR_REGISTRY_BASELINE_EDGES.length} 条合法边内）⇒ 收尾断言必判红（命中 ${ownFindings.length} 条）：\n${ownFindings.map((finding) => `  · ${finding.message}`).join('\n')}`);
    process.exit(1);
  }
  if (ownFindings.length > 0) {
    console.error(`PROBE-UNEXPECTED-LOAD ${form.id}（对照形态却产生了 OCR 域装载边：${ownFindings[0].message}）`);
    process.exit(4);
  }
  console.log(`PROBE-CLEAN ${form.id} findings=0 entries=${moduleLoadRegistry.entries.length} registered=${form.expectSpecifier}`);
  process.exit(0);
}

// r7b：受护文件的引用图**刚刚装载完** ⇒ 立刻先做一次主判据断言（fail-fast）。理由：注入受护文件时应当**第一时间**
//   由主判据本身报出"经 <路径> 装载了 <specifier> → <URL>"，而不是让后续自测钉子以二手现象（形态探针登记不到）报错
//   ——后者的首条失败信息会掩盖真正的归因（实测踩到）。收尾处仍有第二次断言（覆盖请求期才懒加载的边）。
assertRegistryClean('受护文件引用图装载完成后（早于自测与回环 HTTP 回归）');

/**
 * 判据函数：返回**违规清单**（空数组 = 通过）。自测与真实用例走**同一函数** ⇒ 判据退化必被自测抓住。
 *
 * 路线（r4）：`ts.createSourceFile` + 遍历 `ImportDeclaration` / `ExportDeclaration` /
 * 动态 `import()`（`CallExpression` + `ImportKeyword`）/ `require(...)`，取 `moduleSpecifier.text`。
 * 由此**一次性消除**：注释与字符串互相干扰、`%XX` 编码、引号种类、多行、有无分号等**整类**问题。
 *
 * ⚠ **归一化只有一个入口（r6）**：callee 与实参**都**经 `stripSequence`（先剥壳：括号 / `as` /
 *   非空断言 `!` / 尖括号断言 `<T>` / `satisfies`；再剥逗号序列）⇒ `(require as any)(…)`、`(rq!)(…)`、
 *   `(0, require)(…)`、`createRequire(import.meta.url)(…)`、`require('./ocr/state.ts' as any)` 走**同一条**判定。
 *   ⛔ 不得在别处再写第二套形状判定（r3/r4：两处各写一套 ⇒ 必然分叉；r5/r6：先漏 callee 侧、再漏类型包装）。
 *
 * ⚠ **解析失败 fail-closed（r6）**：`ts.createSourceFile` 遇语法错误**不抛异常**，只把诊断留在
 *   `parseDiagnostics` 并返回一棵**残缺 AST** ⇒ 本函数先查诊断，非空**即判红**（`OCRPARSE`，逐条打印原文），
 *   绝不在残缺 AST 上得出"0 违规"的结论（复审 N1 实测：未闭合块注释可让整份文件静默 0 违规）。
 *
 * ⚠ **显式书面取舍（r7 口径；本判据覆盖不到的部分，不得读成"覆盖全部形态"）**：
 *   ① **运行时拼接/插值**：`'./ocr/' + 'service.ts'`、`` `./ocr/${name}.ts` ``（AST 只见表达式，无可核对的字面量）；
 *   ② **非字面量实参**：`require(someVar)`、`require(String('./ocr/state.ts'))`（静态期取不到值）；
 *   ③ **已收口（r7，不再是盲区）**：callee **无法归属**的调用，只要实参是**本域字面量**，一律 `OCRUNJUDGED` 判红
 *      （fail-closed）⇒ `module.require('./ocr/state.ts')`、`globalThis.require(…)`、`eval('require')(…)`、
 *      `require.resolve(…)`、`box.load('./ocr/state.ts')`、`list[0](…)` 这类"看不懂就静默放行"已不存在；
 *   ④ **再转手**：把别名或 `createRequire` 传给别的函数/模块后再调用（跨模块数据流不在本判据内）；
 *   ⑤ 以上未覆盖面在**正常路径**由 stdout 的 `NOTE 判据未覆盖（r7 如实声明）` 逐条打印（见文件尾部）；
 *   ⑥ 本判据针对的是"**显式模块引用**"这一类腐化（本仓 `app.ts` 为静态源码 ⇒ 该目标可达）。
 *   ⑦ **r7 主判据**（运行期装载登记）与"能否用静态形状穷举"**无关**：它拦的是"**真的装载了什么**"，
 *      故 ①②④ 这些静态盲区只要最终发生装载就会被抓住（本函数降为**启发式**，用于早期定位与可读报错）。
 */
function evaluateOcrImports(sourceText, fromDir) {
  const violations = [];
  const fail = (message) => violations.push(message);
  const requireAliases = new Set(); // `createRequire(…)` 的别名（间接 require）
  const sourceFile = ts.createSourceFile('app.ts', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  // ⚠ **fail-closed（r6，复审 N1）**：`ts.createSourceFile` 遇语法错误**不抛异常**，只把诊断放进
  //   `parseDiagnostics` 并照常返回一棵**残缺 AST** ⇒ 修复前"未闭合注释/残缺语法"会让本判据**静默 0 违规**。
  //   这里**先**查诊断：非空即判红，并把每条诊断原文打印出来（不得在残缺 AST 上下"通过"的结论）。
  for (const diagnostic of sourceFile.parseDiagnostics) {
    const text = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
    fail(`OCRPARSE: app.ts 解析失败（判据拒绝在残缺 AST 上下结论）：${text}`);
  }

  const checkNamedImports = (namedBindings) => {
    if (namedBindings === undefined) return;
    if (ts.isNamespaceImport(namedBindings)) {
      fail('OCRCONTRACT: 不得以 `* as ns` 命名空间导入 ./ocr/service.ts');
      return;
    }
    if (!ts.isNamedImports(namedBindings)) return;
    for (const element of namedBindings.elements) {
      if (element.isTypeOnly === true) continue; // `{ type X }`：运行期擦除
      const name = (element.propertyName ?? element.name).text; // `X as Y` 按**原名**判定
      if (!OCR_SERVICE_ALLOWED_SYMBOLS.includes(name)) {
        fail(`OCRSYMBOL: ./ocr/service.ts 只允许 ${OCR_SERVICE_ALLOWED_SYMBOLS.join('/')}（值符号），实际出现：${name}`);
      }
    }
  };

  const checkNamedExports = (exportClause) => {
    if (ts.isNamespaceExport(exportClause)) {
      fail('OCRCONTRACT: 不得 `export * as ns` 自 ./ocr/service.ts');
      return;
    }
    if (!ts.isNamedExports(exportClause)) return;
    for (const element of exportClause.elements) {
      if (element.isTypeOnly === true) continue;
      const name = (element.propertyName ?? element.name).text;
      if (!OCR_SERVICE_ALLOWED_SYMBOLS.includes(name)) {
        fail(`OCRSYMBOL: ./ocr/service.ts 只允许 ${OCR_SERVICE_ALLOWED_SYMBOLS.join('/')}（值符号），实际出现：${name}`);
      }
    }
  };

  const visit = (node) => {
    // 记录 `const X = createRequire(…)` 产生的**间接 require**（否则 `X('./ocr/state.ts')` 会成为未声明缺口）。
    // ⚠ 初始化表达式**同样经唯一归一化入口 `stripSequence` 剥壳**：`const rq = (createRequire)(…)`、
    //   `const rq = createRequire(…) as NodeRequire`、`const rq = (0, createRequire)(…)` 都必须登记
    //   —— 不得在此另写一套形状判定（r6 复审：类型包装族正是靠"别名 + 包装"绕过静态判据的，见 W1–W7）。
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      // r7（复审 blocking ②）：登记点必须与**别处同源** —— 初始化表达式经唯一入口 `stripSequence` 剥壳**之后**，
      //   callee 还要经**同一个** `normalizeCallee` 归属。旧写法 `ts.isIdentifier(initializer.expression)`
      //   只认"裸 `createRequire`" ⇒ `const rq = (createRequire)(url)`、`(0, createRequire)(url)`、
      //   `((0, createRequire))(url)`、`(createRequire as any)(url)` 全都**不登记**（复审实测 4 种形状全漏）。
      const initializer = stripSequence(node.initializer);
      // 形状 A：`const X = <callee>(…)`，其中 callee 经共用归一化归属为 `createRequire` 或**已登记别名**。
      if (ts.isIdentifier(node.name) && initializer !== undefined && ts.isCallExpression(initializer)) {
        const initializerCallee = normalizeCallee(initializer.expression, requireAliases);
        if (initializerCallee !== null && initializerCallee.kind === 'identifier'
          && (initializerCallee.name === 'createRequire' || requireAliases.has(initializerCallee.name))) {
          requireAliases.add(node.name.text);
        }
      }
      // 形状 B：`const X = <mod>.createRequire`（命名空间属性取值，如 `const cr = ns.createRequire`）。
      if (ts.isIdentifier(node.name) && initializer !== undefined && ts.isPropertyAccessExpression(initializer)
        && initializer.name.text === 'createRequire') {
        requireAliases.add(node.name.text);
      }
      // 形状 C：`const { createRequire: X } = <mod>`（解构取值）。
      if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          if (element.propertyName !== undefined && ts.isIdentifier(element.propertyName)
            && element.propertyName.text === 'createRequire' && ts.isIdentifier(element.name)) {
            requireAliases.add(element.name.text);
          }
        }
      }
    }
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifierNode = node.moduleSpecifier;
      if (specifierNode !== undefined) {
        const text = literalText(specifierNode);
        // r7（复审 blocking ②补丁）：`import { createRequire as cr } from 'node:module'` 这类**静态 import 别名**
        //   也是 createRequire 的一条真实来路 ⇒ 必须登记（否则 `cr('./ocr/state.ts')` 在静态判据里成为缺口）。
        if (ts.isImportDeclaration(node) && text === 'node:module' && node.importClause !== undefined
          && node.importClause.namedBindings !== undefined && ts.isNamedImports(node.importClause.namedBindings)) {
          for (const element of node.importClause.namedBindings.elements) {
            const imported = element.propertyName ?? element.name;
            if (ts.isIdentifier(imported) && imported.text === 'createRequire') requireAliases.add(element.name.text);
          }
        }
        if (text === null) {
          fail('OCRTEXT: 模块说明符不是静态字符串字面量（运行时拼接/插值 ⇒ 无从核对）');
        } else {
          const target = resolveModuleTarget(text, fromDir);
          if (!target.startsWith('bare:') && isOcrDomainTarget(target) && !isAllowedOcrModuleTarget(target)) {
            fail(`OCRMODULE: ./ocr/ 下只允许 service.ts，实际归一化到 ${target}`);
          } else if (!target.startsWith('bare:') && isServiceTarget(target)) {
            if (ts.isImportDeclaration(node)) {
              if (node.isTypeOnly === true) {
                // `import type …`：整句运行期擦除 ⇒ 放行（含 `import type * as`）
              } else if (node.importClause === undefined) {
                fail('OCRSIDEEFFECT: 不得对 ./ocr/service.ts 做副作用导入（无说明符 ⇒ 无法核对装的是什么）');
              } else if (node.importClause.isTypeOnly === true) {
                // 同上：整句擦除
              } else if (node.importClause.name !== undefined) {
                fail('OCRFORM: 不得对 ./ocr/service.ts 使用默认导入');
              } else {
                checkNamedImports(node.importClause.namedBindings);
              }
            } else if (node.isTypeOnly === true) {
              // `export type … from`：擦除
            } else if (node.exportClause === undefined) {
              fail('OCRCONTRACT: 不得 `export *` 自 ./ocr/service.ts');
            } else {
              checkNamedExports(node.exportClause);
            }
          }
        }
      }
    } else if (ts.isCallExpression(node)) {
      // ⚠ callee 侧**必须先归一化**（剥壳 + 剥逗号序列 + 当场调用递归），且与实参侧共用**同一个**入口；
      //   否则 `(require)('./ocr/state.ts')` 的 callee 是 ParenthesizedExpression —— 既不等于 `ImportKeyword`，
      //   也不是 `Identifier` ⇒ **一行括号绕过**（r5 实测）。动态 `import(...)`、`require`、间接别名、
      //   `createRequire(import.meta.url)(…)` **当场调用**全部走**同一** `normalizeCallee`（r6）。
      const callee = normalizeCallee(node.expression, requireAliases);
      const isDynamicImport = callee !== null && callee.kind === 'dynamic-import';
      const requireLabel = requireCalleeLabel(node.expression, requireAliases);
      if (isDynamicImport || requireLabel !== null) {
        const label = isDynamicImport ? '动态 import()' : requireLabel;
      const text = literalText(node.arguments[0]);
      if (text === null) {
        if (isDynamicImport) fail('OCRTEXT: 动态 import() 的参数不是静态字符串字面量（运行时拼接/插值 ⇒ 无从核对）');
      } else {
        // ⚠ **本域判据在此分支与本文件上方的 `ImportDeclaration`/`ExportDeclaration` 分支**逐字同源**：
        // 归一化后指向 `./ocr/**` 且不是 `service.ts` ⇒ 一律 `OCRMODULE`（否则会出现"静态写法判红、
        // 动态写法放行"的**不对称漏分支** —— 复审 F1‴ 实测 `./ocr/state.ts` 的 10 种静态写法全部逃逸）。
        const target = resolveModuleTarget(text, fromDir);
        if (!target.startsWith('bare:') && isOcrDomainTarget(target) && !isAllowedOcrModuleTarget(target)) {
          fail(`OCRMODULE: ./ocr/ 下只允许 service.ts，实际归一化到 ${target}（经 ${label} 引用）`);
        } else if (!target.startsWith('bare:') && isServiceTarget(target)) {
          fail(`OCRDYNAMIC: 不得用 ${label} 引用 ./ocr/service.ts`);
        }
        }
      } else {
        // r7：callee **无法归属**（既不是动态 `import`，也不是 `require`/已知别名/`createRequire(…)` 当场调用）
        //   ⇒ 若其**实参**是 OCR 域字面量，则 fail-closed 判红（`OCRUNJUDGED`），而不是"看不懂就放行"。
        //   依据：复审 blocking ① 的第二族正落在这里 —— `box.load('./ocr/state.ts')`、`list[0](…)`、
        //   `module.require(…)`、`eval('require')(…)`、`require.resolve(…)` 在 r6 全部静默通过。
        //   口径：**只在"实参是本域字面量"时判红**（否则任何 `foo()` 都会变成噪声；`foo('fastify')` 不管）。
        const text = literalText(node.arguments[0]);
        if (text !== null) {
          const target = resolveModuleTarget(text, fromDir);
          if (!target.startsWith('bare:') && isOcrDomainTarget(target)) {
            fail(`OCRUNJUDGED: 调用点的 callee 无法归属（\`${node.expression.getText(sourceFile)}\`），但实参是 OCR 域说明符（归一化到 ${target}）⇒ 无从核对装的是什么，按不通过处理（fail-closed）`);
          }
        }
      }
      // ⚠ **盲区（r7 起收窄为 fail-closed）**：callee 为本判据**不识别**的表达式时，只要实参是 OCR 域字面量，
      //   上面那条 `OCRUNJUDGED` 就会判红（r6 旧行为是"静默不进域检查" ⇒ 复审 blocking ① 借此逃逸）。
      //   仍然**看不到**的只剩两类：①非字面量实参（`require(someVar)`、`String(…)` 包装、拼接/插值）；
      //   ②压根不是"一次调用"的数据流（别名/`createRequire` 转手后再调用）。这两类由 r7 主判据
      //   （运行期装载登记）兜住 —— 无论用什么形状，模块最终都要经装载器 ⇒ 登记集合必然出现该边。
      //   注意：**不得**在此提前 `return`（那会跳过下面的 `ts.forEachChild`，等于放弃整棵子树 —— 静态 `import`
      //   分支之外的所有节点都靠它递归下来）。
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

/** 第二道网：四条**原文子串**禁项；对 `%XX` 拼写**逐说明符**解码后复查一遍。 */
function evaluateForbiddenSubstrings(sourceText) {
  const violations = [];
  for (const forbidden of OCR_FORBIDDEN_SUBSTRINGS) {
    if (sourceText.includes(forbidden)) {
      violations.push(`INCLUDES: 原文命中 ${forbidden}`);
      continue;
    }
    const specifiers = [...sourceText.matchAll(/(?:from\s*|import\s*\(\s*|require\s*\(\s*)(['"`])([^'"`\r\n]*)\1/g)].map((match) => match[2]);
    const decodedHit = specifiers.some((specifier) => {
      try {
        return decodeURIComponent(specifier).includes(forbidden);
      } catch {
        return false;
      }
    });
    if (decodedHit) violations.push(`INCLUDES_DECODED: 解码后命中 ${forbidden}`);
  }
  return violations;
}
// ─────────────────────── TS AST 判据结束 ───────────────────────

const API = '/api/v1';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 契约 `Job` 九键（`additionalProperties:false` ⇒ 键集合必须恰好是这九个）。 */
const JOB_KEYS = ['id', 'revision', 'kind', 'target_ref', 'state', 'deadline_at', 'created_at', 'error_code', 'result'];
/** 契约 `JobState` 七值闭集（逐项抄录）。 */
const JOB_STATES = ['queued', 'running', 'succeeded', 'uncertain', 'failed', 'timed_out', 'cancelled'];
const TERMINAL_STATES = ['succeeded', 'uncertain', 'failed', 'timed_out', 'cancelled'];
/** 识别域替身"正常"分桶的媒体 id（取自 GY-I09 既有集成脚本的同口径常量，用于"不回归"对照）。 */
const RECOGNITION_OK_MEDIA = '11111111-1111-4111-8111-111111111111';

const DOSE_CONDITIONS_COMPLETE = {
  crop_id: 'rice',
  region_code: '330100',
  species_id: 'species_barnyardgrass',
  growth_stage: '3-5叶期',
  planting_method: '移栽',
  use_scene: '水稻田',
};

/** 通过 `loadConfig` 的 real 校验所需的**合成占位**配置（非真实凭据；不连接）。 */
const REAL_ENV = {
  DATABASE_URL: 'postgres://synthetic_local_only@127.0.0.1:5432/gengyun_synthetic_never_connected',
  SESSION_SIGNING_KEY: 'synthetic-not-a-real-signing-key',
  DELETION_LEDGER_KEY: 'synthetic-not-a-real-ledger-key',
  WECHAT_APP_ID: 'synthetic-not-a-real-appid',
  WECHAT_APP_SECRET: 'synthetic-not-a-real-appsecret',
  OBJECT_STORAGE_ENDPOINT: 'https://example.invalid',
  OBJECT_STORAGE_BUCKET: 'synthetic-not-a-real-bucket',
  OBJECT_STORAGE_ACCESS_KEY: 'synthetic-not-a-real-access-key',
  OBJECT_STORAGE_SECRET_KEY: 'synthetic-not-a-real-secret-key',
};

function assertString(value, label) {
  assert.equal(typeof value, 'string', `${label} 必须是 string，实际是 ${typeof value}`);
}

function assertArray(value, label) {
  assert.ok(Array.isArray(value), `${label} 必须是数组，实际是 ${typeof value}`);
  return value;
}

/** 与 `ocr/provider.ts` 的 `bucketOf` 同口径：sha256(media_id) 首字节对 6 取模。 */
const bucketCache = new Map();
function mediaIdForBucket(bucket) {
  if (bucketCache.has(bucket)) return bucketCache.get(bucket);
  for (let attempt = 0; attempt < 500000; attempt += 1) {
    const candidate = randomUUID();
    if (createHash('sha256').update(candidate).digest()[0] % 6 === bucket) {
      bucketCache.set(bucket, candidate);
      return candidate;
    }
  }
  throw new Error(`未能找到分桶 ${bucket} 的媒体 uuid`);
}

let keySeq = 0;
const nextKey = (label = 'ocr-http') => `${label}-${String((keySeq += 1)).padStart(6, '0')}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 真实 HTTP 调用；返回 {status, json, headers}。 */
async function call(base, token, method, path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  // r8（阻断 A 返修）：**显式要求每条回环请求用完即关**，不让 undici 的全局连接池在两次请求之间保留 keep-alive socket。
  //   被审版本（r7c）在本函数里用全局 `fetch`，而组 8 内 31 个 `spawnSync` 子进程探针（见 `registryProbeForms` 循环）
  //   会插入约 **21.9 秒**的空闲窗口；复审实测该窗口后**下一条**请求会复用**已被回收**的 socket ⇒ 随机
  //   `TypeError: fetch failed` / `cause: Error: read ECONNRESET`（`errno: -4077`），且恒在 `PASS 8)` 之后
  //   （三树对照：r6 `4c411e84` 0/10 红、被审树 `8e3b350` 3/10 红、合并预演树 2/3 红）。
  //   为什么选"请求侧显式 `connection: close`"而不是另外三条（取舍理由，逐条对照）：
  //     ② `new Agent({ keepAliveTimeout })` —— 本仓**顶层无 `undici` 依赖**（`require.resolve('undici')` 实测
  //        `MODULE_NOT_FOUND`），要引入新依赖 ⇒ 超出"只改本文件"的返修边界，且给护栏加了包依赖风险；
  //     ③ 探针跑完显式关闭/重建连接池 —— 同样要拿到 undici 的 dispatcher/Agent 句柄（同②的依赖问题），
  //        且"关掉全局池"会影响后续请求的连接复用语义（面更大）；
  //     ④ 对 `ECONNRESET` 一次性重试 —— 会**把红改成绿**：真实回归被 socket 复用掩盖成"重试后通过"，
  //        与"护栏要能判红"的目的一致相反（重试计数还会让"读到几次红"失去意义）。
  //   ① 是在**请求语义**层面消除复用（HTTP/1.1 标准头，Node 内建 fetch/undici 原生支持，零新依赖、零全局副作用），
  //      且不改任何断言 ⇒ 最保守、最小改动。副作用只在本脚本的测试客户端：每次请求新建连接（回环，代价可忽略）。
  headers.connection = 'close';
  const response = await fetch(base + path, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, json: text === '' ? null : JSON.parse(text) };
}

/** 合成登录（stub 模式：code 派生稳定合成身份，不发起外部请求）。 */
async function login(base, code) {
  const response = await call(base, null, 'POST', `${API}/auth/wechat`, {
    headers: { 'idempotency-key': `ocr-http-login-${code}` },
    body: { code },
  });
  assert.equal(response.status, 200, `合成登录应 200，实际 ${response.status}`);
  assertString(response.json.data.access_token, 'login.data.access_token');
  return response.json.data.access_token;
}

/** real 模式：按 AuthStore 公开 API 直接播种会话（real 不允许替身登录）。 */
async function seedSession(authStore, label) {
  const user = await authStore.createUser(`${label}-${randomUUID().replace(/-/g, '')}`);
  const token = mintOpaqueToken();
  await authStore.createSession({
    userId: user.id,
    tokenHashHex: hashToken(token),
    authEpoch: user.authEpoch,
    expiresAt: new Date(Date.now() + 3600 * 1000),
    audience: 'user',
  });
  return token;
}

/** **纯 HTTP** 轮询读回 OCR 记录（OCR 域无 /jobs 路由，故以记录出现与否判定完成）。 */
async function waitForOcr(base, token, ocrId, tries = 200) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const response = await call(base, token, 'GET', `${API}/ocr/${ocrId}`);
    if (response.status === 200) return response.json.data;
    assert.equal(response.status, 404, `等待期间应为 404，实际 ${response.status}`);
    await sleep(5);
  }
  throw new Error(`等待 OCR 记录超时：${ocrId}`);
}

async function createOcr(base, token, mediaId, key = nextKey()) {
  const response = await call(base, token, 'POST', `${API}/ocr`, {
    headers: { 'idempotency-key': key },
    body: { media_id: mediaId, media_revision: 1 },
  });
  return { response, key };
}

/**
 * **纯 HTTP** 轮询**作业读面**到终态（`GET /jobs/{id}`；本片新接线的读面本身就是被测对象）。
 *
 * 每一步都断言 **200**：该 kind 未接线时这里必然是 `404 NOT_FOUND`（与"作业不存在"同形）
 * ⇒ 这条断言就是"接线与否"的红绿分界（撤下 `app.ts` 的注册项 ⇒ 本函数第一轮即失败）。
 */
async function waitForTerminalJob(base, token, jobId, tries = 400) {
  let last = null;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const response = await call(base, token, 'GET', `${API}/jobs/${jobId}`);
    assert.equal(response.status, 200, `GET /jobs/{id} 必须 200（未接线时是 404）：${JSON.stringify(response.json)}`);
    last = response.json.data;
    if (TERMINAL_STATES.includes(last.state)) return last;
    await sleep(5);
  }
  throw new Error(`等待作业终态超时：${jobId}（最后 state=${String(last?.state)}）`);
}

/**
 * **注入式接缝（第一段）**：仅用于"登记库未接线 ⇒ unavailable"这一分支。
 *
 * 产品装配 `app.ts` 只传 `{ guards }`（零端口注入）——这本身是**默认关闭**的安全属性，
 * 但也意味着"真实登记库未接线 ⇒ unavailable"这一分支**无法**经产品装配构造
 * （real 模式下提供者先 fail-closed，HTTP 上根本走不到登记库那一步）。
 * 因此该分支用**路由插件自身的 `deps` 接缝**在本测试内最小化装配；
 * 组 8 已用产品装配的**结构断言**钉住"产品路径不暴露该注入面"。
 * （本文件的**第二段接缝**见 `buildInjectedProviderApp`，只用于构造失败/超时终态与确定性"运行中"。）
 */
function buildInjectedReferenceApp(config, authStore) {
  const app = Fastify({
    logger: false,
    genReqId: () => randomUUID(),
    ajv: { customOptions: { removeAdditional: false } },
  });
  for (const key of ['userId', 'authEpoch', 'role', 'sessionId', 'sessionExpiresAt', 'accountRevision', 'authScopes']) {
    app.decorateRequest(key, null);
  }
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      reply.status(error.status).send(buildErrorEnvelope(error, { request_id: request.id, execution_mode: config.executionMode }));
      return;
    }
    reply.status(500).send({ error: { message: '内部错误', retryable: false, details: [] }, meta: { request_id: request.id } });
  });
  const guards = createAuthGuards({ store: authStore, now: () => new Date() });
  registerOcrRoutes(app, config, { guards, reference: createUnwiredReferencePort() });
  return app;
}

/**
 * **注入式接缝（第二段）**：只用于构造"失败/超时终态"与**确定性**的"运行中"。
 *
 * 为什么必须走接缝：产品装配对 OCR 路由**零端口注入**（只传 `guards`/`consent`/`egress`，组 8 有结构证据），
 * 而替身提供者按 `media_id` 分六个桶、**六桶全部是"已完成"**（没有失败桶）⇒ "失败态"无法经产品装配构造。
 * 本接缝**只**替换**提供者**与 **deadline**，装配件全部复用产品同一套：`registerOcrRoutes`（产品同一函数）
 * + `registerJobRoutes` + 真实注册表（含 `createOcrJobSource`）⇒ 作业读面的分派与契约校验路径与产品装配逐字相同。
 */
function buildInjectedProviderApp(config, authStore, options = {}) {
  const app = Fastify({
    logger: false,
    genReqId: () => randomUUID(),
    ajv: { customOptions: { removeAdditional: false } },
  });
  for (const key of ['userId', 'authEpoch', 'role', 'sessionId', 'sessionExpiresAt', 'accountRevision', 'authScopes']) {
    app.decorateRequest(key, null);
  }
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      reply.status(error.status).send(buildErrorEnvelope(error, { request_id: request.id, execution_mode: config.executionMode }));
      return;
    }
    reply.status(500).send({ error: { message: '内部错误', retryable: false, details: [] }, meta: { request_id: request.id } });
  });
  const guards = createAuthGuards({ store: authStore, now: () => new Date() });
  const service = registerOcrRoutes(app, config, {
    guards,
    provider: options.provider,
    jobDeadlineMs: options.jobDeadlineMs,
  });
  registerJobRoutes(app, config, guards, createJobRegistry([createOcrJobSource(service)]));
  return app;
}

/**
 * 接缝替身提供者（**明确标注的替身**，不触达任何真实供应商）：
 * 按 `media_id` 的 sha256 分桶（与 `ocr/provider.ts` 的 `bucketOf` 同口径）
 *   - 桶 0 ⇒ **悬挂**（永不返回）⇒ 由服务端 deadline 落 `timed_out` + `PROVIDER_TIMEOUT`；
 *   - 桶 1 ⇒ **强制失败** `PROVIDER_OUTCOME_UNKNOWN` ⇒ 落 `failed` + 同一码（非超时失败，刻意与桶 0 分开）；
 *   - 其余桶 ⇒ 抛错（宁可让用例失败，也不静默给出成功）。
 */
function seamProvider() {
  return {
    executionMode: 'stub',
    modelVersion: 'stub-seam-v1',
    available: true,
    unavailableReason: null,
    async extract({ mediaId }) {
      const bucket = createHash('sha256').update(mediaId).digest()[0] % 6;
      if (bucket === 0) return new Promise(() => {});
      if (bucket === 1) return { kind: 'failed', code: 'PROVIDER_OUTCOME_UNKNOWN' };
      throw new Error(`接缝替身只支持桶 0/1，收到桶 ${bucket}`);
    },
  };
}

// ---------------------------------------------------------------- 主流程

const results = [];
function record(group) {
  results.push(group);
  console.log(`  PASS ${group}`);
}

const stubConfig = loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' });

// —— 实例 1：**产品装配**（stub）——绝大多数用例打在它上面 ——
const stubAuthStore = createMemoryAuthStore();
const stubApp = buildApp({ config: stubConfig, store: stubAuthStore });
const stubBase = await stubApp.listen({ host: '127.0.0.1', port: 0 });
const stubCalls = () => stubApp.ocrService.describe().providerCalls;

// —— 实例 2：**产品装配**（real，合成占位配置）——默认关闭的 app 级证据 ——
const realAuthStore = createMemoryAuthStore();
const realConfig = loadConfig({ APP_EXECUTION_MODE: 'real', LOG_LEVEL: 'silent', ...REAL_ENV });
const realApp = buildApp({ config: realConfig, store: realAuthStore });
const realBase = await realApp.listen({ host: '127.0.0.1', port: 0 });

// —— 实例 3：**注入式接缝**（仅用于"登记库未接线"这一分支）——
const seamAuthStore = createMemoryAuthStore();
const seamApp = buildInjectedReferenceApp(stubConfig, seamAuthStore);
const seamBase = await seamApp.listen({ host: '127.0.0.1', port: 0 });
const seamToken = await seedSession(seamAuthStore, 'synthetic-ocr-seam');

// —— 实例 4：**注入式接缝（第二段）**（悬挂/失败提供者 + 1s deadline；仅用于失败态与确定性"运行中"）——
const providerSeamAuthStore = createMemoryAuthStore();
const providerSeamApp = buildInjectedProviderApp(stubConfig, providerSeamAuthStore, {
  provider: seamProvider(),
  jobDeadlineMs: 1000,
});
const providerSeamBase = await providerSeamApp.listen({ host: '127.0.0.1', port: 0 });
const providerSeamToken = await seedSession(providerSeamAuthStore, 'synthetic-ocr-provider-seam');

try {
  console.log('== GY-I10 阶段 2b 真实装配 + 回环 HTTP 集成回归 ==');
  console.log(`  · 产品装配 stub  base=${stubBase}  execution_mode=${stubApp.ocrService.describe().executionMode}`);
  console.log(`  · 产品装配 real  base=${realBase}  execution_mode=${realApp.ocrService.describe().executionMode}`);

  const base = stubBase;
  const tokenA = await login(base, 'synthetic-ocr-a');
  const tokenB = await login(base, 'synthetic-ocr-b');

  // ---- 1) 受理：契约状态码 + 封套形状 + 提供者恰好 1 次调用 ------------------
  {
    const before = stubCalls();
    const { response } = await createOcr(base, tokenA, mediaIdForBucket(0));
    assert.equal(response.status, 202, 'createOCR 契约规定 202');
    const meta = response.json.meta;
    assert.deepEqual(Object.keys(meta).sort(), ['contract_version', 'execution_mode', 'request_id']);
    assert.match(meta.request_id, UUID_RE, 'meta.request_id 应为 uuid');
    assert.equal(meta.contract_version, '1.0.0');
    assert.equal(meta.execution_mode, 'stub');
    const job = response.json.data;
    assert.equal(job.kind, 'ocr');
    assert.equal(job.state, 'queued');
    assert.equal(job.result, null, '受理时不得带出结果');
    assert.equal(job.error_code, null);
    assert.equal(job.target_ref.type, 'ocr');
    assert.match(job.target_ref.id, UUID_RE);
    assertString(job.deadline_at, 'job.deadline_at');
    assertString(job.created_at, 'job.created_at');
    assert.deepEqual(Object.keys(response.json).sort(), ['data', 'meta']);
    assert.deepEqual(
      Object.keys(job).sort(),
      ['created_at', 'deadline_at', 'error_code', 'id', 'kind', 'result', 'revision', 'state', 'target_ref'],
    );
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('etag'), `"${job.revision}"`);
    const ocr = await waitForOcr(base, tokenA, job.target_ref.id);
    assert.equal(ocr.model_version, 'stub-v1', '替身必须如实标注 model_version');
    await stubApp.ocrService.settle();
    assert.equal(stubCalls() - before, 1, '一次受理恰好 1 次提供者调用');
    record('1) createOCR 202 + JobEnvelope/Job 形状 + meta 齐备 + no-store/ETag + 提供者恰好 1 次调用（真实装配）');
  }

  // ---- 9) 正控制：受理 → 完成 → 读回 → 校正 → 落库读回 ----------------------
  {
    const { response } = await createOcr(base, tokenA, mediaIdForBucket(0));
    const job = response.json.data;
    const raw = await waitForOcr(base, tokenA, job.target_ref.id);
    assert.equal(raw.id, job.target_ref.id);
    assert.equal(raw.revision, 1);
    assert.deepEqual(
      Object.keys(raw).sort(),
      ['corrected_fields', 'id', 'model_version', 'raw_fields', 'revision', 'verification'],
    );
    const rawRegistration = raw.raw_fields.registration_number;

    const reread = await call(base, tokenA, 'GET', `${API}/ocr/${raw.id}`);
    assert.equal(reread.status, 200);
    assert.equal(reread.json.meta.contract_version, '1.0.0');
    assert.equal(reread.headers.get('etag'), '"1"');
    assert.equal(reread.headers.get('cache-control'), 'no-store');

    const corrected = await call(base, tokenA, 'PATCH', `${API}/ocr/${raw.id}/correction`, {
      headers: { 'idempotency-key': nextKey('correct'), 'if-match': `"${raw.revision}"` },
      body: {
        corrected_fields: {
          registration_number: 'PD20210002',
          name: '用户手改名称',
          ingredients: [{ name: '乙草胺', content_text: '50', unit_text: '%' }],
          dosage_form: '乳油',
        },
      },
    });
    assert.equal(corrected.status, 200, 'correctOCR 契约规定 200');
    assert.equal(corrected.json.data.revision, 2);
    assert.equal(corrected.json.data.corrected_fields.registration_number, 'PD20210002');
    assert.deepEqual(corrected.json.data.raw_fields, raw.raw_fields, 'HTTP 层 raw_fields 必须原样保留');
    assert.equal(corrected.json.data.raw_fields.registration_number, rawRegistration);
    assert.equal(corrected.headers.get('etag'), '"2"');

    const after = await call(base, tokenA, 'GET', `${API}/ocr/${raw.id}`);
    assert.equal(after.json.data.revision, 2);
    assert.equal(after.json.data.corrected_fields.name, '用户手改名称');
    assert.deepEqual(after.json.data.raw_fields, raw.raw_fields);
    record('9) 正控制 受理→完成→读回→校正（raw/corrected 在 HTTP 层严格分离）→落库读回→ETag 递增');
  }

  // ---- 3) verifyOCR / 登记核对 / dose_cards gate ---------------------------
  {
    const { response } = await createOcr(base, tokenA, mediaIdForBucket(1));
    const ocr = await waitForOcr(base, tokenA, response.json.data.target_ref.id);
    assert.equal(ocr.verification.match_state, 'insufficient');
    assert.notEqual(ocr.verification.match_state, 'matched', 'missing_fields 非空时绝不 matched');
    assert.ok(assertArray(ocr.verification.missing_fields, 'missing_fields').length > 0);

    const { response: matchedCreate } = await createOcr(base, tokenA, mediaIdForBucket(0));
    const matched = await waitForOcr(base, tokenA, matchedCreate.json.data.target_ref.id);
    assert.equal(matched.verification.match_state, 'matched');
    assert.equal(matched.verification.dose_cards.length, 0, '受理时无 conditions ⇒ dose_cards 为空');

    const verified = await call(base, tokenA, 'POST', `${API}/ocr/${matched.id}/verify`, {
      headers: { 'idempotency-key': nextKey('verify'), 'if-match': `"${matched.revision}"` },
      body: { fields: matched.raw_fields, conditions: DOSE_CONDITIONS_COMPLETE },
    });
    assert.equal(verified.status, 200, 'verifyOCR 契约规定 200');
    assert.deepEqual(Object.keys(verified.json).sort(), ['data', 'meta']);
    assert.deepEqual(
      Object.keys(verified.json.data).sort(),
      ['conflict_fields', 'dose_cards', 'match_state', 'missing_fields', 'registration'],
    );
    assert.equal(verified.json.data.match_state, 'matched');
    assert.equal(
      verified.json.data.dose_cards.length,
      0,
      '替身路径结构性不产卡（#7 验收第 3 条：不对模拟记录显示真实用量）',
    );
    assert.equal(verified.headers.get('etag'), '"2"', 'verify 后 ETag 应为记录的新 revision');

    const { response: noMatchCreate } = await createOcr(base, tokenA, mediaIdForBucket(4));
    const noMatch = await waitForOcr(base, tokenA, noMatchCreate.json.data.target_ref.id);
    assert.equal(noMatch.verification.match_state, 'no_match');
    const noMatchVerified = await call(base, tokenA, 'POST', `${API}/ocr/${noMatch.id}/verify`, {
      headers: { 'idempotency-key': nextKey('verify'), 'if-match': `"${noMatch.revision}"` },
      body: { fields: noMatch.raw_fields, conditions: DOSE_CONDITIONS_COMPLETE },
    });
    assert.equal(noMatchVerified.json.data.match_state, 'no_match');
    assert.equal(noMatchVerified.json.data.dose_cards.length, 0);
    record('3) missing_fields 非空 ⇒ insufficient（绝不 matched）；verify 200 形状正确；替身路径 dose_cards 恒为 []；no_match 亦不给卡');
  }

  // ---- 3d) 登记库未接线 ⇒ unavailable（**注入式接缝**，见 buildInjectedReferenceApp）----
  {
    const { response } = await createOcr(seamBase, seamToken, mediaIdForBucket(0));
    const ocr = await waitForOcr(seamBase, seamToken, response.json.data.target_ref.id);
    assert.equal(ocr.verification.match_state, 'unavailable');
    assert.notEqual(ocr.verification.match_state, 'no_match', '登记库不可用不得伪装成 no_match');
    assert.equal(ocr.verification.registration, null);
    assert.equal(ocr.verification.dose_cards.length, 0);
    record('3d) 登记库未接线 ⇒ unavailable（**经路由插件 deps 接缝**；产品装配刻意不暴露该注入面）');
  }

  // ---- 4) 归属：他人 404，且与"不存在"逐字段同形 ---------------------------
  {
    const { response } = await createOcr(base, tokenA, mediaIdForBucket(0));
    const ocrId = response.json.data.target_ref.id;
    await waitForOcr(base, tokenA, ocrId);

    const forbidden = await call(base, tokenB, 'GET', `${API}/ocr/${ocrId}`);
    const missing = await call(base, tokenB, 'GET', `${API}/ocr/${randomUUID()}`);
    assert.equal(forbidden.status, 404, '他人记录必须 404');
    assert.equal(missing.status, 404, '不存在记录必须 404');
    assert.deepEqual(Object.keys(forbidden.json).sort(), ['error', 'meta']);
    assert.deepEqual(Object.keys(forbidden.json.error).sort(), Object.keys(missing.json.error).sort());
    assert.deepEqual(forbidden.json.error, missing.json.error, '越权与不存在的错误体必须逐字段同形');
    assert.equal(forbidden.json.error.code, 'NOT_FOUND');
    assert.match(forbidden.json.meta.request_id, UUID_RE);
    assert.match(missing.json.meta.request_id, UUID_RE);
    assert.notEqual(forbidden.json.meta.request_id, missing.json.meta.request_id);

    const otherPatch = await call(base, tokenB, 'PATCH', `${API}/ocr/${ocrId}/correction`, {
      headers: { 'idempotency-key': nextKey('correct-b'), 'if-match': '"1"' },
      body: { corrected_fields: { registration_number: null, name: null, ingredients: [], dosage_form: null } },
    });
    assert.equal(otherPatch.status, 404);
    const otherDelete = await call(base, tokenB, 'DELETE', `${API}/ocr/${ocrId}`, {
      headers: { 'idempotency-key': nextKey('delete-b'), 'if-match': '"1"' },
    });
    assert.equal(otherDelete.status, 404);
    assert.deepEqual(otherPatch.json.error, missing.json.error);
    assert.deepEqual(otherDelete.json.error, missing.json.error);
    record('4) 归属：他人 GET/PATCH/DELETE 一律 404，且错误体与"不存在"同形（不泄露存在性）');
  }

  // ---- 5) If-Match 三态（契约：缺失428 / 非法400 / 不匹配409） --------------
  {
    const { response } = await createOcr(base, tokenA, mediaIdForBucket(0));
    const ocr = await waitForOcr(base, tokenA, response.json.data.target_ref.id);
    const fields = { registration_number: null, name: null, ingredients: [], dosage_form: null };

    const missingHeader = await call(base, tokenA, 'PATCH', `${API}/ocr/${ocr.id}/correction`, {
      headers: { 'idempotency-key': nextKey('im') },
      body: { corrected_fields: fields },
    });
    assert.equal(missingHeader.status, 428, '缺 If-Match 契约规定 428');
    assert.equal(missingHeader.json.error.code, 'REVISION_REQUIRED');

    const illegal = await call(base, tokenA, 'PATCH', `${API}/ocr/${ocr.id}/correction`, {
      headers: { 'idempotency-key': nextKey('im'), 'if-match': '*' },
      body: { corrected_fields: fields },
    });
    assert.equal(illegal.status, 400, 'If-Match 格式非法契约规定 400（且不允许 *）');
    assert.equal(illegal.json.error.code, 'INVALID_REQUEST');

    const mismatch = await call(base, tokenA, 'PATCH', `${API}/ocr/${ocr.id}/correction`, {
      headers: { 'idempotency-key': nextKey('im'), 'if-match': '"99"' },
      body: { corrected_fields: fields },
    });
    assert.equal(mismatch.status, 409, 'If-Match 不匹配契约规定 409');
    assert.equal(mismatch.json.error.code, 'REVISION_CONFLICT');

    const deleteMissing = await call(base, tokenA, 'DELETE', `${API}/ocr/${ocr.id}`, {
      headers: { 'idempotency-key': nextKey('im') },
    });
    assert.equal(deleteMissing.status, 428);
    const deleteIllegal = await call(base, tokenA, 'DELETE', `${API}/ocr/${ocr.id}`, {
      headers: { 'idempotency-key': nextKey('im'), 'if-match': 'abc' },
    });
    assert.equal(deleteIllegal.status, 400);
    const deleteMismatch = await call(base, tokenA, 'DELETE', `${API}/ocr/${ocr.id}`, {
      headers: { 'idempotency-key': nextKey('im'), 'if-match': '"77"' },
    });
    assert.equal(deleteMismatch.status, 409);
    assert.equal(deleteMismatch.json.error.code, 'REVISION_CONFLICT');
    record('5) If-Match：缺失⇒428／非法(含*)⇒400／不匹配⇒409（PATCH 与 DELETE 各三态）');
  }

  // ---- 5b) deleteOCR 正控制：202 + AckEnvelope --------------------------
  {
    const { response } = await createOcr(base, tokenA, mediaIdForBucket(0));
    const ocr = await waitForOcr(base, tokenA, response.json.data.target_ref.id);
    const deleted = await call(base, tokenA, 'DELETE', `${API}/ocr/${ocr.id}`, {
      headers: { 'idempotency-key': nextKey('del'), 'if-match': `"${ocr.revision}"` },
    });
    assert.equal(deleted.status, 202, 'deleteOCR 契约规定 202');
    assert.deepEqual(Object.keys(deleted.json).sort(), ['data', 'meta']);
    assert.deepEqual(deleted.json.data, { accepted: true }, 'Ack 只含 accepted（additionalProperties:false）');
    assert.equal(deleted.headers.get('etag'), `"${ocr.revision + 1}"`);
    const gone = await call(base, tokenA, 'GET', `${API}/ocr/${ocr.id}`);
    assert.equal(gone.status, 404, '删除后读取必须 404');
    record('5b) deleteOCR 202 + Ack{accepted:true} + no-store/ETag；删除后 GET 404');
  }

  // ---- 6) 幂等：重放 / 异体 / 并发（计数取自服务 describe().providerCalls） ----
  {
    const mediaId = mediaIdForBucket(0);
    const key = nextKey('replay');
    const first = await createOcr(base, tokenA, mediaId, key);
    const second = await createOcr(base, tokenA, mediaId, key);
    assert.equal(second.response.status, 202);
    assert.equal(second.response.json.data.id, first.response.json.data.id, '同键同体必须回放同一任务');
    assert.equal(second.response.json.data.target_ref.id, first.response.json.data.target_ref.id);

    const conflict = await createOcr(base, tokenA, mediaIdForBucket(1), key);
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.response.json.error.code, 'IDEMPOTENCY_CONFLICT');

    // 同键同体**并发**：恰好 1 个任务 + 恰好 1 次提供者调用
    const before = stubCalls();
    const concurrentKey = nextKey('concurrent');
    const attempts = await Promise.all(
      Array.from({ length: 4 }, () =>
        call(base, tokenA, 'POST', `${API}/ocr`, {
          headers: { 'idempotency-key': concurrentKey },
          body: { media_id: mediaId, media_revision: 1 },
        }),
      ),
    );
    const accepted = attempts.filter((item) => item.status === 202);
    const jobIds = new Set(accepted.map((item) => item.json.data.id));
    const ocrIds = new Set(accepted.map((item) => item.json.data.target_ref.id));
    assert.equal(jobIds.size, 1, `并发同键必须收敛到同一任务，实际 ${JSON.stringify([...jobIds])}`);
    assert.equal(ocrIds.size, 1, `并发同键必须收敛到同一 OCR 记录，实际 ${JSON.stringify([...ocrIds])}`);
    for (const attempt of attempts) {
      assert.ok(
        attempt.status === 202 || (attempt.status === 409 && attempt.json.error.code === 'REQUEST_IN_PROGRESS'),
        `并发落败者只能是 409 REQUEST_IN_PROGRESS，实际 ${attempt.status} ${JSON.stringify(attempt.json?.error?.code)}`,
      );
    }
    await waitForOcr(base, tokenA, [...ocrIds][0]);
    await stubApp.ocrService.settle();
    const calls = stubCalls() - before;
    assert.equal(calls, 1, `同键同体并发必须恰好 1 次提供者调用，实际 ${calls}`);
    record(`6) 幂等：同键同体重放⇒同一资源；同键异体⇒409 IDEMPOTENCY_CONFLICT；同键同体 4 路并发⇒同一任务且 describe().providerCalls 恰好 +${calls}`);
  }

  // ---- 7) 请求边界 ------------------------------------------------------
  {
    const mediaId = mediaIdForBucket(0);

    const noKey = await call(base, tokenA, 'POST', `${API}/ocr`, { body: { media_id: mediaId, media_revision: 1 } });
    assert.equal(noKey.status, 400);
    assert.equal(noKey.json.error.code, 'IDEMPOTENCY_KEY_REQUIRED');

    const shortKey = await call(base, tokenA, 'POST', `${API}/ocr`, {
      headers: { 'idempotency-key': 'short' },
      body: { media_id: mediaId, media_revision: 1 },
    });
    assert.equal(shortKey.status, 400);
    assert.equal(shortKey.json.error.code, 'IDEMPOTENCY_KEY_REQUIRED');

    const extraField = await call(base, tokenA, 'POST', `${API}/ocr`, {
      headers: { 'idempotency-key': nextKey('extra') },
      body: { media_id: mediaId, media_revision: 1, user_id: 'forged' },
    });
    assert.equal(extraField.status, 400);
    assert.equal(extraField.json.error.code, 'INVALID_REQUEST');

    const badRevision = await call(base, tokenA, 'POST', `${API}/ocr`, {
      headers: { 'idempotency-key': nextKey('rev') },
      body: { media_id: mediaId, media_revision: 0 },
    });
    assert.equal(badRevision.status, 400);
    assert.equal(badRevision.json.error.code, 'INVALID_REQUEST');

    const badMediaId = await call(base, tokenA, 'POST', `${API}/ocr`, {
      headers: { 'idempotency-key': nextKey('media') },
      body: { media_id: 'not-a-uuid', media_revision: 1 },
    });
    assert.equal(badMediaId.status, 400);
    assert.equal(badMediaId.json.error.code, 'INVALID_REQUEST');

    const noSession = await call(base, null, 'GET', `${API}/ocr/${randomUUID()}`);
    assert.equal(noSession.status, 401);
    assert.equal(noSession.json.error.code, 'SESSION_REQUIRED');
    record('7) 请求边界：缺/过短 Idempotency-Key⇒400 IDEMPOTENCY_KEY_REQUIRED；多余字段/非法 media_id/media_revision⇒400 INVALID_REQUEST；无会话⇒401 SESSION_REQUIRED');
  }

  // ---- 7b) 钉子用例：非 uuid 路径 id ⇒ 400 INVALID_REQUEST（钉住两层分工）----
  {
    // **这条钉住 HTTP 层与服务层的分工，防止未来去掉 params schema 后行为静默翻转。**
    //   分工：**HTTP 层管「格式/形状」** ⇒ 路径 id 非 uuid 时 params schema 先失败 ⇒ 400 INVALID_REQUEST；
    //         **服务层管「存在性/归属/版本」** ⇒ 格式合法但他人/不存在 ⇒ 404、版本不符 ⇒ 409、缺 If-Match ⇒ 428。
    // 阶段 1 服务层对"非 uuid id"给的是 404（UUID_PATTERN 不匹配即视为不存在，以防探测）；
    // 当前 HTTP 层在前 ⇒ 对外 400；**若日后移除 params schema，同一输入会从 400 翻成 404**。
    for (const [method, path] of [
      ['GET', `${API}/ocr/not-a-uuid`],
      ['GET', `${API}/ocr/12345`],
      ['GET', `${API}/ocr/%20`],
    ]) {
      const response = await call(base, tokenA, method, path);
      assert.equal(response.status, 400, `${method} ${path} 非 uuid 路径 id 必须 400（HTTP 层格式判定），实际 ${response.status}`);
      assert.equal(response.json.error.code, 'INVALID_REQUEST', `${method} ${path} 的错误码`);
    }
    const wellFormedMissing = await call(base, tokenA, 'GET', `${API}/ocr/${randomUUID()}`);
    assert.equal(wellFormedMissing.status, 404);
    assert.equal(wellFormedMissing.json.error.code, 'NOT_FOUND');
    record('7b) 钉子·两层分工：非 uuid 路径 id⇒400 INVALID_REQUEST（HTTP 层判格式）；格式合法但不存在⇒404 NOT_FOUND（服务层判存在性）');
  }

  // ---- 8) **产品装配 real 模式**默认关闭：503 / 0 次调用 / 不回退替身 + 结构证据 ----
  {
    const described = realApp.ocrService.describe();
    assert.equal(described.executionMode, 'real', 'real 实例必须如实标注 real');
    assert.equal(described.providerAvailable, false, 'real 缺凭据必须不可用');
    assert.equal(described.modelVersion, 'real-unconfigured');
    assert.notEqual(described.modelVersion, 'stub-v1', '不得静默回退替身');
    assert.equal(described.mediaPort, 'unwired');
    assert.equal(described.referencePort, 'unwired', 'real 下登记库必须未接线');
    assert.equal(described.referenceAvailable, false);
    assert.equal(described.dosePort, 'unwired');
    assert.equal(described.providerCalls, 0, 'real 实例受理前不得有任何提供者调用');

    const realToken = await seedSession(realAuthStore, 'synthetic-ocr-real');
    const rejected = await call(realBase, realToken, 'POST', `${API}/ocr`, {
      headers: { 'idempotency-key': nextKey('real') },
      body: { media_id: mediaIdForBucket(0), media_revision: 1 },
    });
    assert.equal(rejected.status, 503, 'real 缺凭据必须受理前 503');
    assert.equal(rejected.json.error.code, 'PROVIDER_UNAVAILABLE');
    // 新增（原文件此前**零** `retryable` 断言 ⇒ 这是"能力未接线"口径在本面长期无声漂移的缺口）：
    // 「真实 OCR 提供者未接线」需运维改配置，不是时间能解决的 ⇒ 不得声称"重试就会好"。
    assert.equal(
      rejected.json.error.retryable,
      false,
      'OCR 受理面：能力未接线 ⇒ retryable 必须为 false（口径原文见 services/api/src/errors.ts）',
    );
    assert.equal(realApp.ocrService.describe().providerCalls, 0, '受理前 fail-closed 不得调用提供者');
    // 不建任务：换一个键再来一次仍是 503，且调用计数仍为 0。
    const again = await call(realBase, realToken, 'POST', `${API}/ocr`, {
      headers: { 'idempotency-key': nextKey('real') },
      body: { media_id: mediaIdForBucket(0), media_revision: 1 },
    });
    assert.equal(again.status, 503);
    assert.equal(again.json.error.code, 'PROVIDER_UNAVAILABLE');
    // 重试不会好：连第二次请求也如实是 `retryable:false`（不是"第一次没准备好"）。
    assert.equal(
      again.json.error.retryable,
      false,
      'OCR 受理面：同一请求重试后仍不可用 ⇒ 更证明其非瞬时故障，retryable 必须为 false',
    );
    assert.equal(realApp.ocrService.describe().providerCalls, 0);

    // —— 代码层结构证据（"默认关闭"是结构属性，不是约定）——
    const appText = readFileSync(new URL('../../services/api/src/app.ts', import.meta.url), 'utf8');
    const ocrRegistrationLine = appText
      .split(/\r?\n/)
      .find((line) => line.includes('registerOcrRoutes(app, config,'));
    assert.ok(ocrRegistrationLine !== undefined, 'app.ts 必须有 registerOcrRoutes 装配行');
    // 只允许 `guards`（鉴权守卫，本行必填）与两个**隐私域**端口（consent/egress），
    // 以及 `#181`（`b6f8c1b`）新增的 `history` 槽位；
    // 不得出现 provider/store/media/reference/service 等**适配器**端口注入。
    // ⚠ 2026-10-16（GY-I10 作业读面接线片）**既有断言修复**：本断言在基线 `cf9c3c8` 上**本就失败**
    //   （实测原始输出见交接文档）——它写于该行还是简写 `{ guards, … }` 的时代，`guards` 无冒号故不被
    //   正则计入；此后该行改为 `guards: gatedGuards`（全局开关门），`guards` 才被计入。原意（"不得塞入
    //   provider/store/媒体/登记库端口"）不变，故把必填的 `guards` 显式列入白名单，而非放宽其它项。
    // ⚠ 同轮**口径如实登记（不得含糊）**：`history` 为 `#181`（`b6f8c1b`）新增的**识别历史域写入端口**
    //   （端口定义 `app.ts:668-675`：`recordHistoryTerminal` → `appendHistory`），**不是** provider/store/media
    //   泄漏，故同列入白名单；但这使"零端口注入"这一结构属性的口径**实质变宽**——从"只允许隐私域
    //   `consent`/`egress`"变为"隐私域 + 识别历史域写入端口"。本注释**不**主张"零端口注入仍成立"。
    //   下方另补**值断言**：钉住 `guards` 槽位装的确实是 `gatedGuards`（旗标门包装）。
    const ocrInjectedKeys = [...ocrRegistrationLine.matchAll(/([A-Za-z]+):/g)].map((match) => match[1]).sort();
    assert.deepEqual(
      ocrInjectedKeys,
      ['consent', 'egress', 'guards', 'history'].sort(),
      `装配行只允许 guards 槽位、隐私域 consent/egress 端口与识别历史域 history 写入端口；若失败说明装配点被塞入了 provider/store/端口：${ocrRegistrationLine.trim()}`,
    );
    // 值断言（键存在 ≠ 值正确）：`guards` 槽位必须装**旗标门包装后的** `gatedGuards`，不是裸 `guards`
    //   （`\b` 词边界：裸 `guards` 是 `gatedGuards` 的后缀，不能只做子串判断）。
    assert.equal(/\bguards: gatedGuards\b/.test(ocrRegistrationLine), true, `装配行 guards 槽位必须装 gatedGuards（旗标门），实际：${ocrRegistrationLine.trim()}`);
    assert.equal(
      /const gatedGuards = createFlagGatedGuards\(guards, featureFlagGate\);/.test(appText),
      true,
      'app.ts 必须有 gatedGuards 绑定（createFlagGatedGuards(guards, featureFlagGate)）',
    );
    // ⚠ 2026-10-16（指挥裁定 `.pg17/dispatch/ruling-ocr-http-import-guard.md`）**清单收窄（保留意图）**：
    //   原清单含 `'ocr/service'`（写于 `#104`/`8c9ace8`，当时该行还是 `{ guards }` 的**零端口注入**时代）；
    //   `#181`（`b6f8c1b`）为装配 `history` 端口必须在 `app.ts:33`
    //   `import { createUnwiredOcrTerminalHistoryPort, type … } from './ocr/service.ts'`，使整条 `'ocr/service'` 为假红
    //   （**非**适配器泄漏：同域端口工厂所在地，不接触 provider/store/media）。
    //   裁定：**不整条删掉**，收窄为"**只放行 `createUnwiredOcrTerminalHistoryPort` 这一个值符号**"——
    //   既放行 `#181` 必需的那一个 import，又**仍然拦住** `ocr/service` 的**其它符号**（`createOcrService`、
    //   `createOcrServiceForMode`、…）与 `ocr/store`、`ocr/provider`、`ocr/media` 的**任何**引用（含符号级）。
    for (const forbidden of ['ocr/provider', 'ocr/store', 'ocr/media', 'ocr/reference']) {
      assert.equal(appText.includes(forbidden), false, `app.ts 不得 import ${forbidden}（装配路径不得接触适配器）`);
    }
    // **判据式护栏（r4：TS AST 路线）**：用 `ts.createSourceFile` 遍历 AST 取模块说明符，
    // 再用「归一化后是否指向 `ocr/service.ts`」+「值符号白名单（恰 1 个）」判定。
    // 由此**一次性消除**：注释/字符串互相干扰（含字符串里的 `/*`）、`%XX` 百分号编码、引号种类、
    //   多行、有无分号等**整类**问题 —— 判据不再依赖任何排版假设。
    //
    // ⚠ **显式书面取舍（不得读成"覆盖全部形态"）**：本判据**看不到**
    //   ① **运行时拼接**（`'./ocr/' + 'service.ts'`、`` `./ocr/${name}.ts` ``）—— 无字面量可核对，判据看不到；
    //   ② **未登记的间接 require**：`require(someVar)`、经中间模块转出的再引用；
    //      （已覆盖：`const X = createRequire(…)` 登记后的 `X('./ocr/…')`，由 `requireAliases` 追踪）；
    //   ③ **裸 `createRequire(…)` 当场调用**：`createRequire(import.meta.url)('./ocr/state.ts')` ——
    //      **本轮（r5）实测仍未覆盖 ✗**，见判据函数内同内容注释（盲区登记，非放行理由）；
    //   ④ 为何可接受：本仓 `app.ts` 是**静态源码**，本护栏目标是拦"**显式模块引用**"的腐化；
    //      ①–③ 即便写出来也**没有可核对的字面量**或非本仓直接可达，属另一层（运行时/构建期）问题，见交接文档"未取得项"。
    //   ④ 另注：四条 `includes` 走 `appText` **原文子串**，**注释不例外**（`ocr/store` 出现在注释里同样判红）。
    const ocrVerdict = evaluateOcrImports(appText, APP_SOURCE_DIR);
    if (ocrVerdict.length > 0) assert.fail(`app.ts 的 OCR 域模块引用不合规：${ocrVerdict.join(' ｜ ')}`);
    const forbiddenVerdict = evaluateForbiddenSubstrings(appText);
    if (forbiddenVerdict.length > 0) assert.fail(`app.ts 命中禁项子串：${forbiddenVerdict.join(' ｜ ')}`);

    // 判据**自测**（对判据整体做负控制，不只测某条正则）：每例断言"判据必须**恰好**给出 N 条违规"。
    // ⚠ **覆盖范围以实测为准（不得读成"任一判据退化都会失配"）**：本自测覆盖的**具体**退化形态是——
    //   (a) **去掉 percent-decode**（`./ocr/servic%65.ts`、`./ocr/%73ervice.ts` 相关条目失配）；
    //   (b) **把 `fail`/`assert.fail` 语义改回"只收集不判红"**（非法例违规数由 N 掉到 0 ⇒ 失配）；
    //   (c) **删掉 `isOcrDomainTarget` 本域判据**（`./ocr/state.ts` 条目失配）；
    //   (d) **删掉 `require()` 判据**（`require('./ocr/state.ts')` 条目失配）；
    //   (e) **删掉"动态 import 非字面量 ⇒ OCRTEXT"判据**（`await import(someVar)` 条目失配）；
    //   (f) **callee 侧不归一化**（r5 新增：把 callee 判定改回"只认裸 Identifier"，则
    //       `(require)('./ocr/state.ts')` 等 callee 形态负控制全部由 1 掉到 0 ⇒ 失配）。
      //   —— r6 新增（**逐层**撤掉后逐条实测判红，原始输出见交接记录「牙验证注入矩阵」）：
      //   (g) **撤"括号"层**（`ts.isParenthesizedExpression` 恒 false ⇒ 首条失配 `__c1`）；
      //   (h) **撤"`as`"层**（删 `ts.isAsExpression` ⇒ `__r1` 失配）；
      //   (i) **撤"非空断言 `!`"层**（删 `ts.isNonNullExpression` ⇒ `__r3` 失配）；
      //   (j) **撤"尖括号断言 `<T>`"层**（删 `ts.isTypeAssertionExpression` ⇒ `__r8` 失配）；
      //   (k) **撤"`satisfies`"层**（删 `ts.isSatisfiesExpression` ⇒ `__r7` 失配）；
      //   (l) **撤"逗号序列"层**（删 `stripSequence` 的 `CommaToken` 循环 ⇒ `__c3` 失配）；
      //   (m) **撤"当场调用"层**（删 `normalizeCallee` 的 `CallExpression` 递归 ⇒ `__r9` 失配）；
      //   (n) **撤 `parseDiagnostics` fail-closed**（删诊断循环 ⇒ `import { X } from './ocr/` 失配）；
      //   (o) **域判据退回单层**（改回 `/(^|\/)ocr\/[^/]+$/` ⇒ `./ocr/nested/state.ts` 失配）；
      //   (p) **域判据子串化**（改成 `/ocr\//` ⇒ `./xocr/state.ts` 期望 0 却得 1 ⇒ 失配，钉"不误报"）；
      //   (q) **白名单退化**（改成 `target.endsWith('service.ts')` ⇒ `../knowledge/ocr/service.ts` 失配）。
      //   上述 (a)–(q) 均在 `SEL1…SEL5`、r5 的 callee 变异与 r6 的 11 条逐层变异下**实测**被本自测抓住；
      //   **本清单之外的形态未逐一枚举** ✗（例如"整体删掉 `isAllowedOcrModuleTarget`"之类未逐条跑过）。
    // ⇒ 自测条数与下方数组**逐字一致**（改判据必须同步改数组与总数，否则本用例红）。
    const selfTestCases = [
      ["import { createUnwiredOcrTerminalHistoryPort } from './ocr/service.ts';", 0], // 合法 import（唯一允许的值符号）
      ['import { createUnwiredOcrTerminalHistoryPort } from "./ocr/service.ts";', 0], // 双引号
      [`import {${String.fromCharCode(10)}  createUnwiredOcrTerminalHistoryPort,${String.fromCharCode(10)}} from './ocr/service.ts';`, 0], // 多行
      ["import { createUnwiredOcrTerminalHistoryPort } from './ocr/service.ts'", 0],   // 无分号
      ["import { createUnwiredOcrTerminalHistoryPort } from './/ocr/service.ts';", 0], // 冗余空段（同一模块）
      ["import { createUnwiredOcrTerminalHistoryPort } from './ocr/service.ts#probe';", 0], // fragment
      ["import { createUnwiredOcrTerminalHistoryPort } from './ocr/service.ts?probe=1';", 0], // 查询串
      ["import { createUnwiredOcrTerminalHistoryPort } from './ocr/servic%65.ts';", 0],      // 百分号编码（同一模块）
      ["import type * as ocrTypes from './ocr/service.ts';", 0],                     // 全类型擦除
      ["import { type OcrTerminalHistoryInput } from './ocr/service.ts';", 0],       // 内联类型说明符
      ["import { createUnwiredOcrTerminalHistoryPort as portAlias } from './ocr/service.ts';", 0], // 合法符号别名
      ["export { createUnwiredOcrTerminalHistoryPort } from './ocr/service.ts';", 0], // 白名单符号再导出
      ["import { createOcrService } from './ocr/service.ts';", 1],                   // 非白名单值符号
      ["import { createUnwiredOcrTerminalHistoryPort, createOcrService } from './ocr/service.ts';", 1],
      ["import { createOcrService as x } from './ocr/service.ts';", 1],              // 别名按**原名**判
      ["import * as svc from './ocr/service.ts';", 1],                               // 命名空间
      ["import svcDefault from './ocr/service.ts';", 1],                             // 默认导入
      ["import './ocr/service.ts';", 1],                                             // 副作用导入
      ["export * from './ocr/service.ts';", 1],                                      // 再导出通配
      ["export * as ns from './ocr/service.ts';", 1],
      ["export { createOcrService } from './ocr/service.ts';", 1],
      ["await import('./ocr/service.ts');", 1],                                      // 动态 import()
      ['await import(`./ocr/service.ts`);', 1],                                      // 反引号动态 import()
      ["import { createOcrService } from './ocr/%73ervice.ts';", 1],                 // percent-encoded 非法符号
      ["import { createOcrService } from '././ocr/service.ts';", 1],                 // 冗余段 + 非法符号
      ["import { createOcrService } from './/ocr/service.ts';", 1],
      ["import { createOcrService } from './ocr/../ocr/service.ts';", 1],            // `..` 解析
      ["import { createOcrService } from './ocr/service.ts?probe=1';", 1],           // 查询串 + 非法符号
      ["import { createOcrService } from './ocr/service.ts#probe';", 1],             // fragment + 非法符号
      ["import { normalizeLabelFields } from './ocr/state.ts';", 1],                 // 本域其它模块
      ["import { createMemoryOcrStore } from './ocr/%73tore.ts';", 1],               // percent-encoded 禁模块
      ["const __i1 = '/*'; import { createOcrService } from './ocr/service.ts'; const __i2 = '*/';", 1], // 字符串里的 /* 不得吞掉 import
      ["const __m = './ocr/' + 'service.ts';", 0],                                   // 已书面声明：运行时拼接不覆盖
      ["await import('./ocr/state.ts');", 1],                                        // 动态 import：本域其它模块 ⇒ OCRMODE
      ["require('./ocr/state.ts');", 1],                                             // require：本域其它模块 ⇒ OCRMODE
      ["await import(someVar);", 1],                                                 // 动态 import 非字面量 ⇒ OCRTEXT
      ["require('./ocr/service.ts');", 1],                                           // require 指向 service ⇒ OCRDYNAMIC
      // ⚠ r5 新增：**callee 形态**负控制（本组即 callee 盲区的"已修复"凭证；撤掉 `normalizeCallee` 的剥括号
      //   或改回"callee 只认裸 Identifier"⇒ 应红各组全部由 1 掉到 0 ⇒ 立即红）。七条应红已逐例实测。
      ["const __c1 = (require)('./ocr/state.ts');", 1],                              // 单层括号 callee（**本轮原始绕过**）
      ["const __c2 = ((require))('./ocr/state.ts');", 1],                            // 双层括号
      ["const __c3 = (0, require)('./ocr/state.ts');", 1],                           // 逗号表达式 callee
      ["const __c4 = (0, (require))('./ocr/state.ts');", 1],                         // 逗号 + 括号混合
      ["const __c5 = (require)('./ocr/service.ts');", 1],                            // 括号 callee + service ⇒ OCRDYNAMIC
      ["const __c6 = (0, require)('./ocr/service.ts');", 1],                         // 序列式 callee + service ⇒ OCRDYNAMIC
      ["const rq = createRequire(import.meta.url); const __c7 = (rq)('./ocr/state.ts');", 1], // 别名 + 括号 callee
      // ⚠ r5 新增：**callee 形态**正控制（应绿）—— 证明"剥括号"不是"见括号就报"：
      //   同样被剥括号的 callee，只要说明符**不在** OCR 域（域外 bare / 域外内置）就必须 0 条。
      //   撤掉剥括号后这三条仍是 0 ⇒ 它们**不**承担"判据生效"的举证，只承担"不误伤"的举证。
      ["const __g1 = (require)('fastify');", 0],                                     // 括号 callee + 域外 bare
      ["const __g2 = ((require))('node:fs');", 0],                                   // 双括号 callee + 域外内置
      ["const rq2 = createRequire(import.meta.url); const __g3 = (rq2)('fastify');", 0], // 别名 + 括号 callee + 域外 bare
      // ⚠ **不设** `(import)('./ocr/state.ts')` 用例：r5 用 `ts.createSourceFile` 实测（AST dump + parseDiagnostics），
      //   TS 解析器在 `(import)` 处报 "Expression expected."，产出的 callee 是**空文本 Identifier**（不是 `ImportKeyword`），
      //   整个 `(import)(…)` 被解析成"ParenthesizedExpression + 另一条 ExpressionStatement" ⇒ **它根本不是 CallExpression**。
      //   故该形态既非 callee 负控制（写成 1 条期望只会是假红）。⚠ r6 起它由 `parseDiagnostics` **fail-closed**
      //   覆盖：实测该句产出 3 条诊断 ⇒ `OCRPARSE` 判红（判据拒绝在残缺 AST 上得出"0 违规"）。
      //   动态 import 的 callee 只能是**裸** `import` 关键字（`import(…)`），本判据已覆盖其字符串实参。
      // ══ r6 新增（44 条）：阻断 B1/B2 的回归钉子 + 复审 N1/N2/N6/N7 钉子。期望值均为**改后实测**读数 ══
      // ⓐ 阻断 B1：`createRequire` 别名 + **类型包装**（`as any`／`as NodeRequire`／非空断言 `!`／`satisfies`／
      //    尖括号断言／嵌套 `as`／逗号序列）—— 改前静态全 0 **且运行期真加载**（复审 W1–W5 实测）。每层包装
      //    各一条 ⇒ "撤掉该层归一化即红"的牙验证有对应钉子（见交接记录注入矩阵）。
      ["const rq = createRequire(import.meta.url); const __r1 = (rq as any)('./ocr/state.ts');", 1],
      ["const rq = createRequire(import.meta.url); const __r2 = (rq as NodeRequire)('./ocr/state.ts');", 1],
      ["const rq = createRequire(import.meta.url); const __r3 = (rq!)('./ocr/state.ts');", 1],
      ["const rq = createRequire(import.meta.url); const __r4 = ((rq as unknown) as any)('./ocr/state.ts');", 1],
      ["const rq = createRequire(import.meta.url); const __r5 = (0, rq as any)('./ocr/state.ts');", 1],
      ["const rq = createRequire(import.meta.url); const __r6 = (rq as any)('./ocr/service.ts');", 1],
      ["const rq = createRequire(import.meta.url); const __r7 = (rq satisfies NodeRequire)('./ocr/state.ts');", 1],
      ["const rq = createRequire(import.meta.url); const __r8 = (<NodeRequire>rq)('./ocr/state.ts');", 1],
      // ⓑ 阻断 B2：**当场调用** `createRequire(…)`（裸／括号／逗号序列／类型包装），含指向 service 的那条
      //    （改前连 OCRDYNAMIC 都整条绕过）。改前静态 0 且运行期真加载（复审 W6/W7 实测）。
      ["const __r9 = createRequire(import.meta.url)('./ocr/state.ts');", 1],
      ["const __r10 = (createRequire(import.meta.url))('./ocr/state.ts');", 1],
      ["const __r11 = (0, createRequire(import.meta.url))('./ocr/state.ts');", 1],
      ["const __r12 = (createRequire(import.meta.url) as NodeRequire)('./ocr/state.ts');", 1],
      ["const __r13 = createRequire(import.meta.url)('./ocr/service.ts');", 1],
      // ⓒ 裸 `require` 的类型包装族（复审 F18–F27 整族静态 0）—— 与 ⓐ 共用**同一个** `peelShells`。
      ["const __r14 = (require as any)('./ocr/state.ts');", 1],
      ["const __r15 = (require!)('./ocr/state.ts');", 1],
      ["const __r16 = (0, require as any)('./ocr/state.ts');", 1],
      ["const __r17 = ((require as unknown) as any)('./ocr/state.ts');", 1],
      ["const __r18 = ((require as NodeRequire))('./ocr/state.ts');", 1],
      // ⓓ **实参侧**同源归一化（复审 N7/F41/F45/F46/F48）：`as`／`satisfies`／`!`／尖括号断言／逗号序列，
      //    动态 `import()` 与 `require()` 两条通道各覆盖一遍 —— 证明剥壳不是只给 callee 用的补丁。
      ["const __r19 = require('./ocr/state.ts' as any);", 1],
      ["const __r20 = require('./ocr/state.ts' satisfies string);", 1],
      ["const __r21 = require('./ocr/state.ts'!);", 1],
      ["const __r22 = require((0, './ocr/state.ts'));", 1],
      ["const __r23 = require(<any>'./ocr/state.ts');", 1],
      ["const __r24 = import('./ocr/state.ts' as any);", 1],
      ["const __r25 = import((0, './ocr/state.ts'));", 1],
      // ⓔ **解析失败 fail-closed**（复审 N1）：语法错误（未闭合字符串 ⇒ 实测 1 条诊断）⇒ 判红并打印诊断原文。
      //    ⚠ 本用例钉的是"非空诊断 ⇒ 判红"这一语义，不钉诊断**条数**（同源多诊断会逐条判红，例如未闭合块注释
      //    在 typescript@5.9.3 下产出 2 条 ⇒ 2 条违规；条数随 TS 版本可能变化，故不写进断言）。
      ["import { X } from './ocr/", 1],
      // ⓕ N2/N6 钉子：白名单必须是**全路径**精确（`../knowledge/ocr/service.ts` 归一化后不是白名单模块 ⇒ 1，
      //    此条钉死"白名单退化成 `endsWith('service.ts')`"）；域判据按 **`ocr/` 段**匹配且**任意深度**。
      ["import { createUnwiredOcrTerminalHistoryPort } from '../knowledge/ocr/service.ts';", 1],
      ["import { X } from './ocr/nested/state.ts';", 1],
      ["import { X } from '../ocr/state.ts';", 1],
      ["import { normalizeLabelFields } from './knowledge/ocr/state.ts';", 1],
      //    N6 反向钉子：`xocr` **不是** `ocr/` 段 ⇒ 必须 0（钉死"域判据子串化成 `includes('ocr/')`"的误报退化）。
      ["import { X } from './xocr/state.ts';", 0],
      // ⓖ 域外对照：类型包装／当场调用**不得**退化成"见包装就报"（改前改后均 0；撤掉域判据反而会变红）。
      ["const rq = createRequire(import.meta.url); const __z1 = (rq as any)('fastify');", 0],
      ["const rq = createRequire(import.meta.url); const __z2 = (rq as any)('./knowledge/service.ts');", 0],
      ["const __z3 = createRequire(import.meta.url)('node:fs');", 0],
      ["const __z4 = (require as any)('fastify');", 0],
      ["const __z5 = require((0, 'fastify'));", 0],
      //    动态 import 的实参**可静态求值**且域外 ⇒ 0（改前因"非字面量"误判为 OCRTEXT=1；r6 剥壳后按真实
      //    说明符判定 ⇒ 1→0。这是**判据更准**而非放宽：域内的同形态在 ⓓ 仍是 1）。
      ["const __z6 = import('node:fs' as any);", 0],
      ["const rq = createRequire(import.meta.url); const __z7 = (0, rq as any)('./knowledge/service.ts');", 0],
      // ⓗ **判据覆盖边界钉死**（r7 口径：①非字面量实参仍看不到；②"看不懂的 callee + OCR 域字面量"已 fail-closed）。
      //    ⚠ 这些用例把"当前看不到"钉成事实记录：若将来收口，**必须同步改这里的期望值**，不得悄悄放宽。
      //    **仍看不到**（期望 0；与文件尾部 `NOTE 判据未覆盖` 一一对应）—— 实参在静态期取不到字面量，
      //    且子树里**没有**任何"无法归属的 callee + OCR 域字面量"的调用可抓：
      ["const __b4 = require('' + './ocr/state.ts');", 0],
      //    **r7 已收口**（期望 1 = `OCRUNJUDGED`：callee 无法归属 + 实参是本域字面量 ⇒ 按不通过处理，fail-closed）：
      ["const __b1 = module.require('./ocr/state.ts');", 1],
      ["const __b2 = globalThis.require('./ocr/state.ts');", 1],
      ["const __b3 = eval('require')('./ocr/state.ts');", 1],
      ["const __b6 = require.resolve('./ocr/state.ts');", 1],
      //    注：`__b5` 的判红来自**内层** `String('./ocr/state.ts')`（同样"callee 无法归属 + 本域字面量"）
      ["const __b5 = require(String('./ocr/state.ts'));", 1],
      // ⓙ **登记点形状钉子**（r7 修复审 blocking ②：登记点与别处**共用**同一归一化入口 `stripSequence` + `normalizeCallee`）。
      //    这些正是 r6 实测**不登记**的形状（旧写法 `ts.isIdentifier(initializer.expression)` 只认裸 `createRequire`）
      //    ⇒ 旧版下 `rq('./ocr/state.ts')` 因"别名未知"而静默通过；期望 1 = 经 `间接 require()` 判红。
      ["const rq = (createRequire)(import.meta.url); const __n1 = rq('./ocr/state.ts');", 1],
      ["const rq = (0, createRequire)(import.meta.url); const __n2 = rq('./ocr/state.ts');", 1],
      ["const rq = ((0, createRequire))(import.meta.url); const __n3 = rq('./ocr/state.ts');", 1],
      ["const rq = (createRequire as any)(import.meta.url); const __n4 = rq('./ocr/state.ts');", 1],
      ["const rq = createRequire(import.meta.url)!; const __n5 = rq('./ocr/state.ts');", 1],
      ["const rq = <NodeRequire>createRequire(import.meta.url); const __n6 = rq('./ocr/state.ts');", 1],
      ["const cr = ns.createRequire; const __n7 = cr('./ocr/state.ts');", 1],
      ["const { createRequire: cr } = ns; const __n8 = cr('./ocr/state.ts');", 1],
      ["import { createRequire as cr } from 'node:module'; const __n9 = cr('./ocr/state.ts');", 1],
      //    域外对照：登记点扩形**不得**变成"见 `.createRequire` 就报"（`cr('fastify')` 与 deps 注入无关 ⇒ 0）
      ["const cr = ns.createRequire; const __n10 = cr('fastify');", 0],
      ["const rq = (0, createRequire)(import.meta.url); const __n11 = rq('./knowledge/service.ts');", 0],
      // ⓘ **未闭合块注释**（复审点名的 fail-closed 负控制）：注释在**语句位置**未闭合 ⇒ 实测恰好 1 条诊断
      //    （`'*/' expected.`）⇒ 1 条 `OCRPARSE`。⚠ 若把它写成上半句已截断的形状（`const x = /*`），TS 会给出
      //    2 条诊断 ⇒ 2 条违规；本用例刻意选**单诊断**形状以免把诊断条数钉死（条数随 TS 版本可变）。
      ["const __p9 = 1; /* 未闭合块注释", 1],
    ];
    assert.equal(selfTestCases.length, 103, '自测条数必须与被声明的条数逐字一致（改判据即改此处与总数）');
    for (const [source, expectedViolations] of selfTestCases) {
      const verdict = evaluateOcrImports(source, APP_SOURCE_DIR);
      assert.equal(
        verdict.length,
        expectedViolations,
        `判据自测未通过：期望 ${expectedViolations} 条违规，实际 ${verdict.length} 条 —— ${JSON.stringify(source)} ⇒ ${JSON.stringify(verdict)}`,
      );
    }
    // r7 追补：**消息级**钉子（条数钉子无法区分"别名登记生效 ⇒ 经 `间接 require() 引用`"与"callee 无法归属 ⇒
    //   `OCRUNJUDGED`"——两者都是 1 条违规。这里把**判词**也钉死，给 blocking ②（登记点形状）装上真牙）。
    const messageCases = [
      // 登记点经共用归一化入口（`stripSequence` + `normalizeCallee`）后必须归属为**间接 require**：
      ["const rq = (createRequire)(import.meta.url); const __q1 = rq('./ocr/state.ts');", '间接 require()'],
      ["const rq = (0, createRequire)(import.meta.url); const __q2 = rq('./ocr/state.ts');", '间接 require()'],
      ["const rq = (createRequire as any)(import.meta.url); const __q3 = rq('./ocr/state.ts');", '间接 require()'],
      ["const cr = ns.createRequire; const __q4 = cr('./ocr/state.ts');", '间接 require()'],
      ["const { createRequire: cr } = ns; const __q5 = cr('./ocr/state.ts');", '间接 require()'],
      ["import { createRequire as cr } from 'node:module'; const __q6 = cr('./ocr/state.ts');", '间接 require()'],
      // 对照：**无法归属**的 callee（对象属性取值 / 下标取值 / `module.require`）必须判成 `OCRUNJUDGED`（不是"静默放行"）：
      ["const box = { load: require }; const __q7 = box.load('./ocr/state.ts');", 'OCRUNJUDGED'],
      ["const list = [require]; const __q8 = list[0]('./ocr/state.ts');", 'OCRUNJUDGED'],
      ["const __q9 = module.require('./ocr/state.ts');", 'OCRUNJUDGED'],
    ];
    for (const [source, expectedFragment] of messageCases) {
      const verdict = evaluateOcrImports(source, APP_SOURCE_DIR);
      assert.equal(verdict.length, 1, `消息级钉子应恰好 1 条违规：${JSON.stringify(source)} ⇒ ${JSON.stringify(verdict)}`);
      assert.ok(
        verdict[0].includes(expectedFragment),
        `消息级钉子判词不符：期望含 ${expectedFragment}，实际 ${JSON.stringify(verdict[0])} —— ${JSON.stringify(source)}`,
      );
    }
    // r7 追补：**运行期**钉子 —— 逐形态在**子进程**里真装载 OCR 域模块，r7 主判据必须判红（exit=1 + `OCRREGISTRY`
    //   + 被装载的 specifier 原文）；对照形态必须**不**判红（exit=0 + `PROBE-CLEAN`）；两条如实固定的运行期事实
    //   （`expectLoad: false` / `expectRuntimeError`）必须打印对应标记而不是冒充"判据抓住了"。
    //   为什么必须起子进程：本进程的登记集合要如实反映**真实装配**（收尾断言只认它），不能被探针自己装载的边污染。
    let probeCaught = 0;
    for (const form of registryProbeForms) {
      const probe = spawnSync(process.execPath, [fileURLToPath(import.meta.url), `--registry-probe=${form.id}`], { encoding: 'utf8' });
      const combined = `${probe.stdout ?? ''}${probe.stderr ?? ''}`;
      const tailText = combined.slice(-700);
      if (form.expectRuntimeError !== undefined) {
        assert.equal(probe.status, 0, `"运行期先抛 ${form.expectRuntimeError}" 是运行期事实（到不了装载器）⇒ 必须如实退出 0：${form.id} status=${probe.status}；${tailText}`);
        assert.ok(combined.includes(`PROBE-RUNTIME-${form.expectRuntimeError.toUpperCase()}`), `该形态必须打印运行期事实标记：${form.id}；${tailText}`);
        continue;
      }
      if (form.expectLoad === false) {
        assert.equal(probe.status, 0, `"不装载"形态必须如实退出 0（登记器如实没有该边）：${form.id} status=${probe.status}；${tailText}`);
        assert.ok(combined.includes('PROBE-NO-LOAD'), `该形态必须打印 PROBE-NO-LOAD（不得冒充"判据抓住了"）：${form.id}；${tailText}`);
        continue;
      }
      if (form.expectViolation === false) {
        assert.equal(probe.status, 0, `对照形态必须**不**判红：${form.id} status=${probe.status}；${tailText}`);
        assert.ok(combined.includes('PROBE-CLEAN'), `对照形态必须打印 PROBE-CLEAN：${form.id}；${tailText}`);
        continue;
      }
      assert.equal(probe.status, 1, `经 ${form.id} 真装载 OCR 域模块 ⇒ r7 主判据必须判红（exit=1），实际 ${probe.status}；${tailText}`);
      assert.ok(combined.includes('OCRREGISTRY'), `判红消息必须含 OCRREGISTRY：${form.id}；${tailText}`);
      assert.ok(combined.includes(form.expectSpecifier), `判红消息必须打印被装载的 specifier（${form.expectSpecifier}）：${form.id}；${tailText}`);
      if (form.expectFragment !== undefined) {
        assert.ok(combined.includes(form.expectFragment), `r8 fail-closed 判词的判红理由不符：期望含 ${form.expectFragment}：${form.id}；${tailText}`);
      }
      probeCaught += 1;
    }
    console.log(`PASS 判据自测 ${selfTestCases.length} 条（静态启发式逐例核对：应红/应绿）· 消息级钉子 ${messageCases.length} 条 · 运行期探针钉子 ${registryProbeForms.length} 条（子进程真装载：应红 ${probeCaught} 条；对照与运行期事实 ${registryProbeForms.length - probeCaught} 条）`);
    const providerText = readFileSync(new URL('../../services/api/src/ocr/provider.ts', import.meta.url), 'utf8');
    for (const network of ['fetch(', 'node:https', 'node:http', 'undici', 'axios', 'XMLHttpRequest']) {
      assert.equal(providerText.includes(network), false, `OCR 提供者层不得含网络调用：${network}`);
    }
    const realSlice = providerText.slice(
      providerText.indexOf('export function createRealOcrProvider'),
      providerText.indexOf('export function createOcrProvider'),
    );
    assert.ok(realSlice.length > 0, 'real 分支切片应非空');
    assert.equal(realSlice.includes('createStubOcrProvider'), false, 'real 分支不得回退替身');
    record('8) 产品装配 real：受理前 503 PROVIDER_UNAVAILABLE、providerCalls=0、不回退替身（real-unconfigured）；+ 结构证据（app.ts 经 TS AST 核对：OCR 域只引用 service.ts 的 createUnwiredOcrTerminalHistoryPort；不 import store/provider/media/reference；provider.ts 无网络客户端；real 分支无替身回退）');
  }

  // ---- 10) 接线（本片）：OCR 作业经**共享作业读面**可读（此前该 kind 未接线 ⇒ 404）----
  {
    const created = await createOcr(base, tokenA, mediaIdForBucket(0));
    assert.equal(created.response.status, 202, 'createOCR 契约规定 202');
    const accepted = created.response.json.data;
    assert.equal(accepted.kind, 'ocr');
    assert.equal(accepted.state, 'queued');

    // 受理后**立刻**读作业面：本片之前这里是 404 NOT_FOUND（与"作业不存在"同形、不泄露存在性）。
    const early = await call(base, tokenA, 'GET', `${API}/jobs/${accepted.id}`);
    assert.equal(early.status, 200, `GET /jobs/{ocrJobId} 必须 200，实际 ${early.status}：${JSON.stringify(early.json)}`);
    assert.equal(early.headers.get('cache-control'), 'no-store');
    assert.equal(early.json.meta.contract_version, '1.0.0');
    assert.equal(early.json.meta.execution_mode, 'stub');
    const observed = early.json.data;
    assert.deepEqual(Object.keys(observed).sort(), [...JOB_KEYS].sort(), 'Job 键集合必须恰好九个（additionalProperties:false）');
    assert.equal(early.headers.get('etag'), `"${observed.revision}"`, 'ETag 必须是资源 revision 的强 ETag');
    assert.equal(observed.kind, 'ocr');
    assert.equal(observed.id, accepted.id);
    assert.equal(observed.target_ref.type, 'ocr');
    assert.match(observed.target_ref.id, UUID_RE);
    assert.match(observed.id, UUID_RE);
    assert.equal(Number.isNaN(Date.parse(observed.deadline_at)), false);
    assert.equal(Number.isNaN(Date.parse(observed.created_at)), false);
    // **状态可见**（不再是 404）：替身无 I/O，落定极快 ⇒ 这里如实接受"已终态"，
    // 确定性的"运行中"样本由组 12 的悬挂提供者给出；两种情形都必须**可区分**。
    assert.ok(JOB_STATES.includes(observed.state), `state 必须落在契约七值闭集内，实际 ${observed.state}`);
    if (observed.result === null) {
      assert.equal(observed.error_code, null, '非终态读取不得凭空带 error_code');
    } else {
      assert.ok(['succeeded', 'uncertain'].includes(observed.state), 'result 只允许出现在 succeeded/uncertain');
    }

    // 成功路径：经**同一个作业读面**轮询到落定，结果过契约分支镜像（不手抄契约）
    const settled = await waitForTerminalJob(base, tokenA, accepted.id);
    assert.equal(settled.state, 'succeeded', `替身分桶 0 应落 succeeded，实际 ${settled.state}`);
    assert.equal(settled.error_code, null);
    assert.deepEqual(Object.keys(settled.result).sort(), ['kind', 'value']);
    assert.equal(settled.result.kind, 'ocr');
    assert.deepEqual(collectResultValueIssues('ocr', settled.result.value), [], 'result.value 必须过 ocr 分支的契约镜像');
    assert.equal(settled.result.value.model_version, 'stub-v1', '替身必须如实标注 model_version');
    assert.equal(settled.result.value.id, accepted.target_ref.id);
    assert.equal(settled.result.value.revision, settled.target_ref.revision, '作业面 target_ref.revision 必须与记录 revision 一致');

    // 既有记录读面与作业读面对齐（`GET /ocr/{id}` 的既有行为未变）
    const record2 = await call(base, tokenA, 'GET', `${API}/ocr/${accepted.target_ref.id}`);
    assert.equal(record2.status, 200);
    assert.equal(record2.json.data.id, settled.result.value.id);
    assert.equal(record2.json.data.revision, settled.target_ref.revision);

    // 作用域：未登录 ⇒ 401；他人作业与"不存在"逐字段同形 404（不泄露存在性）
    const guestJob = await call(base, null, 'GET', `${API}/jobs/${accepted.id}`);
    assert.equal(guestJob.status, 401);
    assert.equal(guestJob.json.error.code, 'SESSION_REQUIRED');
    const foreignJob = await call(base, tokenB, 'GET', `${API}/jobs/${accepted.id}`);
    const missingJob = await call(base, tokenB, 'GET', `${API}/jobs/${randomUUID()}`);
    assert.equal(foreignJob.status, 404);
    assert.equal(missingJob.status, 404);
    assert.equal(foreignJob.json.error.code, 'NOT_FOUND');
    assert.deepEqual(foreignJob.json.error, missingJob.json.error, '他人作业与不存在必须逐字段同形');
    record(`10) 接线·OCR 作业经 \`GET /jobs/{id}\` 可读：200 + 九键 + kind=ocr + 状态可见（此前 404）；受理后立刻读到 state=${observed.state}；终态 state=${settled.state}/error_code=${String(settled.error_code)}/result.kind=${settled.result.kind} 且过 ocr 契约镜像；与 \`GET /ocr/{id}\` 对齐（revision=${settled.target_ref.revision}）；未登录 401／他人与不存在同形 404`);
  }

  // ---- 11) 本片：OCR 作业可取消（queued/running ⇒ cancelled，revision 恰好 +1，终态不可复活）----
  {
    // 对照（同一次运行内）：识别域经**同一个** `/jobs/{id}` 路由仍可读 ⇒ 证明 404 的消失只来自 OCR 接线。
    const recognition = await call(base, tokenA, 'POST', `${API}/recognitions`, {
      headers: { 'idempotency-key': nextKey('recognitions-regression') },
      body: { media_id: RECOGNITION_OK_MEDIA, media_revision: 1 },
    });
    assert.equal(recognition.status, 202, JSON.stringify(recognition.json));
    const recognitionJob = await waitForTerminalJob(base, tokenA, recognition.json.data.id);
    assert.equal(recognitionJob.kind, 'recognition');
    assert.equal(recognitionJob.state, 'succeeded');

    // 用**悬挂提供者**接缝构造确定的"运行中"作业：它自己跑不完（1s 后 deadline 到期），
    // 取消语义因此可稳定观测，且能顺带证明"迟到的超时结果不复活已取消的作业"。
    const created = await createOcr(providerSeamBase, providerSeamToken, mediaIdForBucket(0), nextKey('cancel-ocr'));
    assert.equal(created.response.status, 202, JSON.stringify(created.response.json));
    const jobId = created.response.json.data.id;
    const before = await call(providerSeamBase, providerSeamToken, 'GET', `${API}/jobs/${jobId}`);
    assert.equal(before.status, 200, '取消前必须先能读到该作业');
    const beforeJob = before.json.data;
    assert.ok(['queued', 'running'].includes(beforeJob.state), `取消前的状态应是 queued/running，实际 ${beforeJob.state}`);
    const cancelKey = nextKey('cancel-ocr-once');

    const cancelled = await call(providerSeamBase, providerSeamToken, 'POST', `${API}/jobs/${jobId}/cancel`, {
      headers: { 'if-match': `"${beforeJob.revision}"`, 'idempotency-key': cancelKey },
    });
    assert.equal(cancelled.status, 200, `OCR 域已接线取消 ⇒ 合法请求必须 200：${JSON.stringify(cancelled.json)}`);
    assert.equal(cancelled.headers.get('cache-control'), 'no-store');
    assert.equal(cancelled.json.meta.contract_version, '1.0.0');
    const cancelledJob = cancelled.json.data;
    assert.deepEqual(Object.keys(cancelledJob).sort(), [...JOB_KEYS].sort(), '取消响应必须是完整 Job 投影（与 GET /jobs/{id} 同构）');
    assert.equal(cancelledJob.kind, 'ocr');
    assert.equal(cancelledJob.state, 'cancelled');
    assert.equal(cancelledJob.error_code, null, '用户主动取消不是失败 ⇒ error_code 必须为 null');
    assert.equal(cancelledJob.result, null, 'cancelled 不产出结果（不得伪造字段）');
    assert.equal(cancelledJob.revision, beforeJob.revision + 1, '取消只允许自增一次 revision');
    assert.equal(cancelledJob.target_ref.id, beforeJob.target_ref.id, '取消不得改目标引用');
    assert.equal(cancelledJob.target_ref.revision, beforeJob.target_ref.revision, '取消不得改目标引用的 revision');
    assert.equal(cancelled.headers.get('etag'), `"${cancelledJob.revision}"`);

    // 同键原样重放 ⇒ 回放首次结果，**不得**再自增（否则"重试"会变成第二次取消）。
    const replay = await call(providerSeamBase, providerSeamToken, 'POST', `${API}/jobs/${jobId}/cancel`, {
      headers: { 'if-match': `"${beforeJob.revision}"`, 'idempotency-key': cancelKey },
    });
    assert.equal(replay.status, 200, JSON.stringify(replay.json));
    assert.equal(replay.json.data.state, 'cancelled');
    assert.equal(replay.json.data.revision, cancelledJob.revision, '幂等重放不得再自增 revision');

    // 已终态再取消（新键 + 当前 revision）⇒ 409 OBJECT_UNAVAILABLE，且状态/revision 不变。
    const again = await call(providerSeamBase, providerSeamToken, 'POST', `${API}/jobs/${jobId}/cancel`, {
      headers: { 'if-match': `"${cancelledJob.revision}"`, 'idempotency-key': nextKey('cancel-ocr-again') },
    });
    assert.equal(again.status, 409, `终态再取消 ⇒ 409 OBJECT_UNAVAILABLE：${JSON.stringify(again.json)}`);
    assert.equal(again.json.error.code, 'OBJECT_UNAVAILABLE');

    // 等过接缝的 1s deadline：迟到的超时结果**不得**复活作业、不得再自增 revision。
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const after = await call(providerSeamBase, providerSeamToken, 'GET', `${API}/jobs/${jobId}`);
    assert.equal(after.status, 200);
    assert.equal(after.json.data.state, 'cancelled', '取消后迟到结果不得复活作业（已终态不可改写）');
    assert.equal(after.json.data.revision, cancelledJob.revision, '取消后迟到结果不得再自增 revision');
    assert.equal(after.headers.get('etag'), `"${cancelledJob.revision}"`);

    // 请求头前置校验仍先答（400/428/400），且**先于**存在性 ⇒ 用随机 uuid 证明次序没有被取消接线打乱。
    const probeId = randomUUID();
    const noKey = await call(providerSeamBase, providerSeamToken, 'POST', `${API}/jobs/${probeId}/cancel`, {
      headers: { 'if-match': '"1"' },
    });
    assert.equal(noKey.status, 400);
    assert.equal(noKey.json.error.code, 'IDEMPOTENCY_KEY_REQUIRED');
    const noVersion = await call(providerSeamBase, providerSeamToken, 'POST', `${API}/jobs/${probeId}/cancel`, {
      headers: { 'idempotency-key': nextKey('cancel-ocr-428') },
    });
    assert.equal(noVersion.status, 428);
    assert.equal(noVersion.json.error.code, 'REVISION_REQUIRED');
    const badVersion = await call(providerSeamBase, providerSeamToken, 'POST', `${API}/jobs/${probeId}/cancel`, {
      headers: { 'if-match': 'abc', 'idempotency-key': nextKey('cancel-ocr-badrev') },
    });
    assert.equal(badVersion.status, 400, JSON.stringify(badVersion.json));
    assert.equal(badVersion.json.error.code, 'INVALID_REQUEST');

    // 越权者也不能取消他人的 OCR 作业（同形 404，而不是先告诉他"存在但不可取消"）
    const owned = await createOcr(base, tokenA, mediaIdForBucket(1));
    assert.equal(owned.response.status, 202, JSON.stringify(owned.response.json));
    const foreignCancel = await call(base, tokenB, 'POST', `${API}/jobs/${owned.response.json.data.id}/cancel`, {
      headers: { 'if-match': '"1"', 'idempotency-key': nextKey('cancel-ocr-b') },
    });
    const missingCancel = await call(base, tokenB, 'POST', `${API}/jobs/${randomUUID()}/cancel`, {
      headers: { 'if-match': '"1"', 'idempotency-key': nextKey('cancel-ocr-missing') },
    });
    assert.equal(foreignCancel.status, 404);
    assert.equal(missingCancel.status, 404);
    assert.equal(foreignCancel.json.error.code, 'NOT_FOUND');
    assert.deepEqual(foreignCancel.json.error, missingCancel.json.error, '他人作业与不存在必须逐字段同形');
    record(`11) 本片·OCR 可取消：\`POST /jobs/{id}/cancel\` ${beforeJob.state}→${cancelledJob.state}，revision ${beforeJob.revision}→${cancelledJob.revision}（恰好 +1）、error_code=null、result=null、九键与 ETag/no-store 同 \`GET /jobs/{id}\`；同键重放仍 revision=${replay.json.data.revision}（不被已自增的 revision 判成 409）；终态再取消 ${again.status} ${again.json.error.code}；过 1s deadline 后仍 state=${after.json.data.state}/revision=${after.json.data.revision}（迟到结果不复活）；缺头 400/428、坏版本 400、越权与不存在同形 404`);
  }

  // ---- 12) 失败可区分（**注入式接缝**：悬挂 / 强制失败；见 buildInjectedProviderApp）----
  {
    // 运行中：悬挂提供者（永不返回）+ 1s deadline ⇒ 作业读面**读得到** queued/running。
    const hung = await createOcr(providerSeamBase, providerSeamToken, mediaIdForBucket(0), nextKey('seam-hang'));
    assert.equal(hung.response.status, 202, JSON.stringify(hung.response.json));
    const hungJob = hung.response.json.data;
    assert.equal(hungJob.state, 'queued');
    const runningRead = await call(providerSeamBase, providerSeamToken, 'GET', `${API}/jobs/${hungJob.id}`);
    assert.equal(runningRead.status, 200, `运行中必须可读（不得与"作业不存在"同形 404）：${JSON.stringify(runningRead.json)}`);
    const running = runningRead.json.data;
    assert.ok(['queued', 'running'].includes(running.state), `运行中状态应是 queued/running，实际 ${running.state}`);
    assert.equal(running.error_code, null, '运行中不得带 error_code');
    assert.equal(running.result, null, '运行中不得带 result');

    // 终态（超时）：同一读面读出 `timed_out` + 契约 `error_code`（悬挂 ⇒ deadline 触发）
    const timedOut = await waitForTerminalJob(providerSeamBase, providerSeamToken, hungJob.id);
    assert.equal(timedOut.state, 'timed_out');
    assert.equal(timedOut.error_code, 'PROVIDER_TIMEOUT', '超时必须带契约 error_code（不得报成无原因）');
    assert.equal(timedOut.result, null, 'timed_out 不得携带 result');
    assert.notEqual(timedOut.state, running.state, '失败/超时不得与"仍在处理"同形（这正是本片要解封的）');
    // 记录面在失败下**仍是 404**（失败不产出记录）⇒ 如实说明"为什么非有作业读面不可"
    const recordGap = await call(providerSeamBase, providerSeamToken, 'GET', `${API}/ocr/${hungJob.target_ref.id}`);
    assert.equal(recordGap.status, 404, '失败/超时在记录面上与"仍在处理"同形（既有事实，本片不改 OCR 域语义）');

    // 强制失败（非超时失败码）：`failed` + 契约 `error_code`，且与 `timed_out` 可区分
    const forced = await createOcr(providerSeamBase, providerSeamToken, mediaIdForBucket(1), nextKey('seam-failed'));
    assert.equal(forced.response.status, 202, JSON.stringify(forced.response.json));
    const failed = await waitForTerminalJob(providerSeamBase, providerSeamToken, forced.response.json.data.id);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.error_code, 'PROVIDER_OUTCOME_UNKNOWN');
    assert.equal(failed.result, null);
    assert.notEqual(failed.state, timedOut.state, 'failed 与 timed_out 必须彼此可区分');
    record(`12) 失败可区分（接缝：悬挂⇒timed_out+PROVIDER_TIMEOUT／强制⇒failed+PROVIDER_OUTCOME_UNKNOWN）：同一 \`GET /jobs/{id}\` 200 且 state/error_code 可见 —— 运行中 state=${running.state}/error_code=${String(running.error_code)}；超时 state=${timedOut.state}/error_code=${String(timedOut.error_code)}；强制失败 state=${failed.state}/error_code=${String(failed.error_code)}；运行中与失败态**不再同形**；记录面在失败下仍 404（如实）`);
  }

  // ───────────────────────── r7 主判据：运行期装载登记（收尾断言） ─────────────────────────
  // 断言「从受护文件 `app.ts` 可达的装载边里，没有任何 OCR 域装载边落在冻结基线之外」。
  // 放在**全部真实装配与回环 HTTP 回归跑完之后**：此时 `app.ts` 的整张引用图都已装载 ⇒ 登记最完整
  //   （每个用例都真跑 HTTP；若某条路径在请求期才装载 OCR 域模块，也会落进登记集合）。
  const registrySummary = describeRegistrySummary();
  const newEdgeCount = assertRegistryClean('收尾（真实装配 + 回环 HTTP 全部跑完）');
  // r8 负控制（**必须为 0**，否则 r8 的 fail-closed 判据就是"把未改动的仓库判红"）：未改动仓库里**不得**有任何
  //   「`specifier` 不是内建却解析出非仓内 `file:` URL」或「同一 (parentUrl, specifier) 解析出**不同** URL」的命中
  //   （实测：非 `file:` 解析结果 82 条**全部**是 `node:` 内建 ⇒ 经 `isBuiltin` 白名单后为 0；幂等重解析对只计数不判红）。
  assert.equal(registrySummary.failClosedEdges, 0, `r8 fail-closed 判据在**未改动**仓库上不得命中（否则是把合法解析判红）：实际 ${registrySummary.failClosedEdges} 条`);
  assert.equal(registrySummary.positiveControl, true, '正控制必须成立：登记集合里必须能看到无害模块 `node:os`（否则是"登记器恒空 ⇒ 恒绿"的退化）');
  // ── r9（复审非阻塞 ③）：**基线 9 条必须全部命中** ──
  // 为什么需要第三条断言：上面两条 + 主判据只覆盖"基线之外**多出来**的边"，**不覆盖"基线之内少掉的边"**。
  //   实测（本片探针，改动前）：剔掉 `routes/ocr.ts → '../ocr/provider.ts'` 一条 ⇒ 可达边 9→8、基线之外 0、
  //   failClosed 0、正控制照旧成立 ⇒ **exit 0 全绿**，汇总行只把「冻结基线命中 8 条」当读数打印，无人比对 ⇒ 假绿。
  //   故这里同时钉住**计数**（`baselineEdges === 基线条数`）与**集合相等**（`基线集合 − 命中集合 = ∅`），
  //   判红时点名**丢的是哪一条**（loader / specifier / target ＋ key 原文）。
  //   ⚠ 还有第三种假绿要堵：**只做差集**时，把基线表缩成空集（或删到 1 条）会让"基线集合 − 命中集合"**恒空**
  //     ⇒ 空表恒绿。故先钉**表本身的条数**（字面量 `9`，即 r7 冻结记录；复审建议
  //     `assert.equal(registrySummary.baselineEdges, 9, …)` 的同义实现）。表若有**有意**变化，必须连这个字面量
  //     一起改 —— 这点"摩擦"是故意的（与主判据"合法装配变化时要求人复核"同口径）。
  assert.equal(
    OCR_REGISTRY_BASELINE_EDGES.length,
    9,
    `r9 基线表本身被改动：r7 冻结记录是 9 条，实际 ${OCR_REGISTRY_BASELINE_EDGES.length} 条（若确为合法装配变化，请连同本断言的 9 一并显式更新）`,
  );
  const missingBaselineEdges = collectMissingBaselineEdges();
  assert.equal(
    registrySummary.baselineEdges,
    OCR_REGISTRY_BASELINE_EDGES.length,
    `r9 基线边命中数不符：冻结基线 ${OCR_REGISTRY_BASELINE_EDGES.length} 条，实际命中 ${registrySummary.baselineEdges} 条（丢 ${missingBaselineEdges.length} 条）：\n${describeMissingBaselineEdges(missingBaselineEdges)}`,
  );
  assert.deepEqual(
    missingBaselineEdges.map(({ edge }) => edge),
    [],
    `r9 基线边**必须全部命中**（缺一条即判红；"基线之外没有新边"不等于"基线之内没少边"）：\n${describeMissingBaselineEdges(missingBaselineEdges)}`,
  );
  console.log(`PASS r7 主判据·运行期装载登记：resolve=${registrySummary.resolveCount} load=${registrySummary.loadCount}；从受护文件可达的 OCR 域装载边=${registrySummary.ocrReachableEdges}（冻结基线命中 ${registrySummary.baselineEdges} 条；基线之外 ${newEdgeCount} 条）；r8 fail-closed 命中 ${registrySummary.failClosedEdges} 条（幂等重解析对 ${registrySummary.repeatResolvePairs} 对，只计数不判红）；正控制 \`node:os\` 已在登记集合中`);
  console.log(`NOTE r7 主判据口径（如实声明，不得读成"放行"）：断言的是「**没有任何 OCR 域装载边落在基线之外**」，而非派单字面的「登记集合内无任何 OCR 域条目」—— 因为**未改动**的仓库运行期本来就有 ${OCR_REGISTRY_BASELINE_EDGES.length} 条合法 OCR 域边（\`app.ts → routes/ocr.ts\` 是合法装配；\`routes/ocr.ts\` 静态装载 \`../ocr/{service,store,provider,media,reference}.ts\`，其中 \`service.ts\`/\`store.ts\`/\`reference.ts\` 又各自装载 \`./state.ts\`）。基线是"当前事实的冻结记录"，**任何新边（含以任意间接形态装载既有 OCR 域模块）一律判红**（fail-closed）；合法装配变化时本判据会判红并要求显式更新基线表（有意如此，宁可要求人复核）。**r9 起再加一条（复审非阻塞 ③）**：上面这条只判「基线之外多出来的边」，**不判「基线之内少掉的边」** —— 实测在副本里剔掉 \`routes/ocr.ts → '../ocr/provider.ts'\` 一条基线边，可达边 9→8、基线之外 0、failClosed 0 ⇒ 仍 exit 0 全绿（本片的假绿探针）。故收尾处另加 \`collectMissingBaselineEdges()\`：「基线集合 − 命中集合 = ∅」，且 \`baselineEdges === 基线条数\`，丢哪一条就点名哪一条（loader / specifier / target ＋ key 原文）。`);
  console.log('NOTE r8 fail-closed（阻断 B 返修，如实声明口径与边界）：被审版本（r7c）以 `if (target === null || !isOcrDomainTarget(target)) continue;` **静默丢弃**一切非仓内 `file:` 的解析结果 —— 复审实测 `services/api/src/config.ts` 在装载期抢先注册第二个 `registerHooks`，把 `app.ts → \'./routes/ocr.ts\'` 改写成 `data:text/javascript;base64,…` ⇒ 该边被丢弃 ⇒ 护栏 exit 0 且 `PASS 14 组` 全绿（**假绿**）。r8 起两条 fail-closed 判据：①**「`resolve` 结果不是仓内 `file:` URL、且 `specifier` 不是内建模块」⇒ 判红**（派单口径：`target === null` 的边一律计入 findings；内建模块经 `isBuiltin` 走**显式白名单**——未改动仓库运行期实测有 82 条 `node:` 解析结果，按字面一律判红会把未改动仓库判红。**不附加**"parentUrl 从受护文件可达"前置条件：附加可达性会给「把 `app.ts` 自身的解析改写成 `data:`」留口子 —— 那时受护引用图整体不可达、可达边集合塌缩为 0，而本判据按"基线之外"计数 ⇒ 塌缩反而**全绿**）；②**「同一 `(parentUrl, specifier)` 解析出**不同** URL」⇒ 判红**（计数口径必须按 (parentUrl, specifier) **对**：实测未改动仓库单个 parentUrl 最多 78 条 resolve ⇒ 按纯 parentUrl 会大量误报；判红条件还必须限定"URL 不一致"—— 字面口径"同一对出现 ≥2 次即判红"在**未改动**仓库上实测误报 7 条（`node_modules/ajv/**`、`ajv-formats/**` 在 Fastify schema 编译阶段**幂等重解析**，前后 URL 完全相同），会使收尾负控制 `failClosedEdges === 0` 不可满足 ⇒ URL 相同的重解析只计数、写进汇总行的"幂等重解析对"）。两条判词都含 `parentUrl` / `specifier` / `loader` 三要素。边界（如实声明）：本判据覆盖的是**经本进程模块装载器**发生的改写；`node --import` 抢跑的第二个 `registerHooks` 若**不改写 URL**（例如只在 `load` 钩子里替换源码）不在本判据范围内（属"不经解析改写"的另一类通道，未取得见证）。');
  console.log('NOTE r7 主判据覆盖边界（如实声明）：登记的是**本脚本自身运行期**真实发生的解析/装载（CJS `require` 与 ESM `import` 两条路径都被拦）；**不覆盖**：①不经模块装载器的路径（直接读文件/`vm`/把源码内联进 `eval`）；②在本进程之外发生的装载（另起进程/子进程）；③**从不装载**的形状（实测 `createRequire.bind(null, url)(spec)` 只返回 require 函数、不装载任何模块 ⇒ 登记器如实没有该边，这不是盲区而是运行期事实）；④`undefined`/`null` 之类的"假 require"（运行期先抛 `ReferenceError`/`TypeError`，到不了装载器）。');

  console.log(`PASS ${results.length} 组：经真实装配的 app（buildApp）+ 本机回环 HTTP；合成身份/替身提供者/内存 store；未联网、未连库、未调真实供应商`);
  console.log('NOTE 未覆盖（如实声明）：小程序 identify 页标签模式与打包白名单、真实 OCR 供应商、真实登记库/用量来源、标签类真实样本 0 ⇒ 不声称任何准确率、真机、PG 持久化');
  console.log('NOTE 非产品装配的两段（均为路由插件 deps 接缝，产品装配刻意零端口注入）：组 3d「登记库未接线 ⇒ unavailable」；组 12「失败/超时终态与确定性运行中」（悬挂/失败提供者 + 1s deadline）');
  // r6：把判据**看不到**的形态在**正常路径**逐条打印（复审要求：只写注释不算 ⇒ 这里进 stdout；与自测数组 ⓗ 组对应）
  console.log('NOTE 启发式判据未覆盖（r7 如实声明；自测数组 ⓗ/ⓙ 组是这些现状的钉死记录）：①实参拼接/插值（`require(\'./ocr/\' + \'state.ts\')`、模板字面量）；②非字面量实参（`require(someVar)`、`require(String(\'./ocr/state.ts\'))` 的**外层**）；③把别名/`createRequire` 再转手传出后再调用。以上三类**本启发式不判红** —— 但它们**都逃不过 r7 主判据**（运行期装载登记）：任何形态只要最终真的装载了模块，登记集合就会出现该边并在收尾断言判红。已收口（不再是盲区）：callee 无法归属 + 本域字面量 ⇒ `OCRUNJUDGED`（`module.require(…)`/`globalThis.require(…)`/`eval(\'require\')(…)`/`require.resolve(…)`/`box.load(…)`/`list[0](…)` 等）；嵌套目录 `./ocr/nested/state.ts` 按 `ocr/` **段**任意深度收口；解析诊断非空整体 fail-closed（`OCRPARSE`）。');
} finally {
  await Promise.allSettled([stubApp.close(), realApp.close(), seamApp.close(), providerSeamApp.close()]);
}
