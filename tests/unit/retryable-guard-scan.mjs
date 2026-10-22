// GY-I22 / R31 · `retryable` 静态判据的**唯一实现**（共享扫描器）。
//
// 为什么单独一个文件：同一套判据现在被两处使用，两处必须**逐字节**同源，⛔ 不许各写一套：
//   - `tests/unit/error-retryable-static-guard.test.mjs`：受控域内「`PROVIDER_UNAVAILABLE` 的 `retryable`
//     只许 false/缺省」+「catch 兜底恒 true 必须登记」；
//   - `tests/unit/retryable-fallback-inventory.test.mjs`：全仓「catch 兜底恒 true」清单与实况对账。
//
// 判据一（`scanProviderUnavailableSites`，= #22 原判据，逐行搬来不改语义）：
//   找出所有 `new ApiError(...)` / `new PrivacyError(...)`，其**第 1 参**含字符串字面量 `'PROVIDER_UNAVAILABLE'`；
//   第 3 参 `retryable` 只允许 ① 缺省 ② 字面量 `false`；其余（字面量 `true` 或任何非字面表达式）＝ 违规。
//
// 判据二（`scanFallbackClaims`，R31 新增）：「兜底恒 `retryable: true`」形状。
//   站点（population，只认 catch 通道）：
//     a) 对象字面量里名为 `retryable` 的成员，**物理上位于某个 `catch` 块内**；或
//     b) 位于「本文件某个 `catch` 块调用过的函数」内的 `retryable` 成员（错误映射函数；跨文件映射不在此列，
//        见证据页「判据边界」）。
//   `retryable: false` 不入清单（它不是「声称可重试」）；缺省不入清单（缺省＝false，见 errors.ts）。
//   判据 `judgement`：
//     - `has`：值不是字面量 `true`（计算表达式，如 `isTransientDatabaseError(error)`、`error.retryable`、
//       `failClosedRetryableFor(cause)`），或字面量 `true` 处于**具名条件**分支内（`if` 的 then 分支、
//       `switch` 的非 `default` case、三元的两臂）；
//     - `none`：字面量 `true` 且从站点到所在函数之间**没有任何具名条件祖先**（含 `else {…}` 残差分支、
//       `default:` 残差分支）⇒ 这一处是「其余一切情况都算可重试」的兜底，即本片要抓的形状。
//   这正是 `services/api/src/errors.ts:28-40` 的反面：确定性失败（含「无法归类」）不得声称可重试。
//
// 判据边界（写进证据页，不假装覆盖）：只认 catch 通道 ⇒ 普通函数里的无条件 `{ retryable: true }`
// （如 `media/service.ts` 的 `withKeyClaim` 幂等冲突分支）不在本判据的 population 内。
import ts from 'typescript';

export const UNAVAILABLE = 'PROVIDER_UNAVAILABLE';
export const ERROR_CLASSES = new Set(['ApiError', 'PrivacyError']);

export const normalize = (text) => text.replace(/\s+/g, ' ').trim();

const FUNCTION_LIKE = [
  ts.isFunctionDeclaration,
  ts.isFunctionExpression,
  ts.isArrowFunction,
  ts.isMethodDeclaration,
  ts.isConstructorDeclaration,
  ts.isGetAccessorDeclaration,
  ts.isSetAccessorDeclaration,
];

const isFunctionLike = (node) => FUNCTION_LIKE.some((check) => check(node));

/** 收集一个节点下的字符串字面量（含无替换模板字面量）。 */
export function stringLiteralsIn(node) {
  const found = [];
  const visit = (child) => {
    if (ts.isStringLiteralLike(child)) found.push(child.text);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

/** 站点所在函数的可读名字（匿名箭头取被赋值的变量/属性名，兜底 `<anonymous>`）。 */
export function functionNameAt(node) {
  let current = node;
  let carried = null;
  while (current !== undefined) {
    if (isFunctionLike(current)) {
      if (current.name !== undefined && ts.isIdentifier(current.name)) return current.name.text;
      if (carried !== null) return carried;
      const parent = current.parent;
      if (parent !== undefined && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
        return parent.name.text;
      }
      if (parent !== undefined && (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent))) {
        return parent.name.getText();
      }
      return '<anonymous>';
    }
    if (
      carried === null
      && current.parent !== undefined
      && (ts.isPropertyAssignment(current.parent) || ts.isPropertyDeclaration(current.parent))
      && current.parent.initializer === current
    ) {
      carried = current.parent.name.getText();
    }
    current = current.parent;
  }
  return '<module>';
}

/** 从对象字面量（`new ApiError` 的第 3 参）里读 `retryable`。 */
export function retryableOf(call) {
  const third = call.arguments?.[2];
  if (third === undefined) return { kind: 'default' };
  if (!ts.isObjectLiteralExpression(third)) return { kind: 'opaque', text: normalize(third.getText()) };
  for (const property of third.properties) {
    const name = property.name;
    const named = name !== undefined && ts.isIdentifier(name) && name.text === 'retryable';
    if (ts.isShorthandPropertyAssignment(property) && named) {
      return { kind: 'opaque', text: normalize(property.getText()) };
    }
    if (!ts.isPropertyAssignment(property) || !named) continue;
    const initializer = property.initializer;
    if (initializer.kind === ts.SyntaxKind.FalseKeyword) return { kind: 'false' };
    if (initializer.kind === ts.SyntaxKind.TrueKeyword) return { kind: 'true', text: 'true' };
    return { kind: 'opaque', text: normalize(initializer.getText()) };
  }
  return { kind: 'default' };
}

const scriptKindOf = (fileName) =>
  /\.(m|c)?jsx?$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;

function parse(fileName, text) {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true, scriptKindOf(fileName));
}

/**
 * 判据一：`PROVIDER_UNAVAILABLE` 站点里非 `false` 的 `retryable`。
 * @returns {Array<{file: string, line: number, errorClass: string, function: string, retryable: string, messages: string[]}>}
 */
export function scanProviderUnavailableSites(fileName, text) {
  const source = parse(fileName, text);
  const violations = [];
  const visit = (node) => {
    if (
      ts.isNewExpression(node)
      && ts.isIdentifier(node.expression)
      && ERROR_CLASSES.has(node.expression.text)
    ) {
      const codes = node.arguments?.[0] === undefined ? [] : stringLiteralsIn(node.arguments[0]);
      if (codes.includes(UNAVAILABLE)) {
        const retryable = retryableOf(node);
        if (retryable.kind === 'true' || retryable.kind === 'opaque') {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
          violations.push({
            file: fileName,
            line: line + 1,
            errorClass: node.expression.text,
            function: functionNameAt(node),
            retryable: retryable.text,
            messages: node.arguments?.[1] === undefined ? [] : stringLiteralsIn(node.arguments[1]),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

/** 兼容旧名字（自检用例沿用 `scanSource`）。 */
export const scanSource = scanProviderUnavailableSites;

/** 站点是否处于具名条件里（then 分支 / 非 default case / 三元臂），或纯粹是残差分支。 */
function judgementAt(property) {
  let child = property;
  let current = property.parent;
  while (current !== undefined && !isFunctionLike(current)) {
    if (ts.isIfStatement(current)) {
      if (current.thenStatement === child) return 'has';
      if (current.elseStatement === child && !ts.isIfStatement(child)) return 'none';
    }
    if (ts.isConditionalExpression(current) && (current.whenTrue === child || current.whenFalse === child)) {
      return 'has';
    }
    if (ts.isCaseClause(current)) return 'has';
    if (ts.isDefaultClause(current)) return 'none';
    child = current;
    current = current.parent;
  }
  return 'none';
}

/**
 * 判据二：catch 通道上的 `retryable` 站点，带 `judgement: 'has' | 'none'`。
 * @returns {Array<{file: string, line: number, function: string, judgement: string, retryable: string, messages: string[]}>}
 */
export function scanFallbackClaims(fileName, text) {
  const source = parse(fileName, text);

  // ① 本文件所有 catch 块，以及它们调用过的函数名（错误映射函数）。
  const catchBlocks = new Set();
  const calledFromCatch = new Set();
  const collect = (node) => {
    if (ts.isCatchClause(node)) {
      catchBlocks.add(node.block);
      const markCalls = (child) => {
        if (ts.isCallExpression(child) && ts.isIdentifier(child.expression)) {
          calledFromCatch.add(child.expression.text);
        }
        ts.forEachChild(child, markCalls);
      };
      ts.forEachChild(node.block, markCalls);
    }
    ts.forEachChild(node, collect);
  };
  collect(source);

  const inCatch = (node) => {
    let current = node.parent;
    while (current !== undefined) {
      if (catchBlocks.has(current)) return true;
      current = current.parent;
    }
    return false;
  };

  const inMapper = (node) => {
    let current = node.parent;
    while (current !== undefined) {
      if (isFunctionLike(current)) {
        const name = functionNameAt(current);
        return calledFromCatch.has(name);
      }
      current = current.parent;
    }
    return false;
  };

  const claims = [];
  const visit = (node) => {
    const named = node.name !== undefined && ts.isIdentifier(node.name) && node.name.text === 'retryable';
    if (named && (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node))) {
      const initializer = ts.isPropertyAssignment(node) ? node.initializer : node.name;
      const literalFalse = ts.isPropertyAssignment(node)
        && initializer.kind === ts.SyntaxKind.FalseKeyword;
      if (!literalFalse && (inCatch(node) || inMapper(node))) {
        const literalTrue = ts.isPropertyAssignment(node)
          && initializer.kind === ts.SyntaxKind.TrueKeyword;
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        // 站点定位用的字面量：所在对象字面量本身；若它就是某个 `new XxxError(...)` 的第 3 参，
        // 再并入该错误的第 2 参消息 —— 这样同一行的「ApiError 判据」与「兜底判据」共用一条白名单条目。
        const literals = new Set(ts.isObjectLiteralExpression(node.parent) ? stringLiteralsIn(node.parent) : []);
        const holder = node.parent?.parent;
        if (
          ts.isObjectLiteralExpression(node.parent)
          && holder !== undefined
          && ts.isNewExpression(holder)
          && holder.arguments?.[2] === node.parent
          && holder.arguments?.[1] !== undefined
        ) {
          for (const message of stringLiteralsIn(holder.arguments[1])) literals.add(message);
        }
        claims.push({
          file: fileName,
          line: line + 1,
          function: functionNameAt(node),
          judgement: literalTrue ? judgementAt(node) : 'has',
          retryable: literalTrue ? 'true' : normalize(initializer.getText()),
          messages: [...literals],
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return claims;
}
