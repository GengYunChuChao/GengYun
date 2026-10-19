// GY-I22（#22）· `PROVIDER_UNAVAILABLE` 的 `retryable` 口径**仓库级静态守卫**。
//
// 为什么要静态守卫（#233 的真实教训）：口径原文写在 `services/api/src/errors.ts` 的 `ApiError` 注释里
// （「能力未装配／未接线造成的 `PROVIDER_UNAVAILABLE` 一律 false，只有瞬时类才可 true」），但**每个调用点
// 各自写字面量** ⇒ 「全站统一」那一轮仍有 9 处漏改，且没有任何测试会红。本文件把那句口径变成可执行的清单。
//
// 规则（受控范围内）：
//   - 找出所有 `new ApiError(...)` / `new PrivacyError(...)`，其**第 1 参**含字符串字面量 `'PROVIDER_UNAVAILABLE'`；
//   - 第 3 参 `options.retryable` 只允许：① 缺省 ② 字面量 `false`；
//   - 其余（字面量 `true` 或任何非字面表达式）必须命中下方 `ALLOWED_RETRYABLE` 条目：逐字节钉住表达式文本、
//     钉住消息字面量、且**必须写理由**。
//
// 因此：把任一 `false` 改回 `true`、把分类器调用换成字面量、或新增一个未登记的 `retryable: true` 站点 ⇒ 本文件必红。
// 反过来，**删掉**某个站点或改其表达式文本时白名单条目会变成「未被命中」⇒ 同样必红（白名单不会腐烂）。
//
// 受控范围：`services/api/src/{db,privacy,conversations}/**`。派单建议里还提到 `synthesis/`，但 @54ce029
// 下**没有**该目录（外发合成实现在 `services/api/src/privacy/synthesis-egress.ts`，已被范围内覆盖）。
//
// 本文件只钉**结构**（谁在写 retryable、写成什么），不重复钉行为；行为断言在
// `tests/unit/error-retryable-behavior.test.mjs`，口径注释原文见 `services/api/src/errors.ts:28-40`。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const API_SRC = join(ROOT, 'services', 'api', 'src');
const SCOPE_DIRS = ['db', 'privacy', 'conversations'];
const ERROR_CLASSES = new Set(['ApiError', 'PrivacyError']);
const UNAVAILABLE = 'PROVIDER_UNAVAILABLE';

const normalize = (text) => text.replace(/\s+/g, ' ').trim();

/**
 * 白名单：受控范围内**允许**出现「非 `false` 的 retryable」的全部站点。
 *
 * 每条都必须给出 `reason`——没有理由的白名单等于把守卫关掉；`retryable` 必须与源码表达式**逐字节**相同
 * （改分类器实现会立刻红，逼下一任作者重新走判定）；`message` 是错误消息字面量的子串（站点定位用，
 * 不参与行为断言）。条目**未被命中**同样失败，所以站点消失后必须同步删条目。
 */
const ALLOWED_RETRYABLE = [
  {
    file: 'services/api/src/db/catalog.ts',
    retryable: 'isTransientDatabaseError(error)',
    message: '主页资料数据库暂不可用',
    reason:
      '主页资料读面：超时/连接层/管理员干预/串行化冲突是瞬时态（同一请求稍后重试确实可能成功）；'
      + '配置与权限类由同一分类器返回 false（口径见 errors.ts:28-40、分类器见 db/pool.ts）。',
  },
  {
    file: 'services/api/src/db/catalog.ts',
    retryable: 'isTransientDatabaseError(error)',
    message: '登记资料数据库暂不可用',
    reason:
      '登记资料读面：与同文件 readHomePreviews 同一分类器（状态码保留既有 503 不变，只订正 retryable 分档），'
      + '避免同一文件出现两套策略。',
  },
  {
    file: 'services/api/src/conversations/store-pg.ts',
    retryable: 'isTransientDatabaseError(error)',
    message: '问答数据库暂不可用',
    reason:
      '问答库事务的 catch-all：57014/55P03 已在上方单独映射为 PROVIDER_TIMEOUT；此处只放行瞬时类，'
      + '42501/3D000/28P01/42P01/42883 与无法归类的驱动错误一律 false。',
  },
  {
    file: 'services/api/src/privacy/deletion-requests-pg.ts',
    retryable: 'true',
    message: '注销受理暂不可用',
    reason:
      '注销受理的瞬时类分支（08xxx/53xxx/57P0x/40001/40P01）：同一请求稍后重试确实可能成功；'
      + '同一 mapDeletionError 的其余分支（42501/42883/无法归类）已改为 false。',
  },
  {
    file: 'services/api/src/db/source-lifecycle.ts',
    retryable: 'unknown || isTransientDatabaseError(error)',
    message: '来源操作结果未确认，请使用同一操作编号核对后重试',
    reason:
      '结果未知（无 code / ECONNRESET / EPIPE / ETIMEDOUT）⇒ 用同一操作编号核对后重试是设计内的恢复路径（瞬时 ⇒ true）；'
      + '已归类的 PROVIDER_UNAVAILABLE 不再无条件 true，改由同一分类器分档。'
      + '（这一处是**守卫实测**发现的第 10 处同类漏改：派单只列了 9 处，复审判定漏了它。）',
  },
  {
    file: 'services/api/src/privacy/ledger-pg.ts',
    retryable: 'true',
    message: '外发账本暂不可用',
    reason:
      '既有合法瞬时分支（mapPgError 的 08/53/57P0/40001/40P01 档，见该文件 73-81 行注释）；'
      + '本片不改它，登记在此以免守卫误报——它的分档正是本片其它站点的先例。',
  },
];

function scopeFiles() {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        walk(path);
      } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        files.push(path);
      }
    }
  };
  for (const dir of SCOPE_DIRS) walk(join(API_SRC, dir));
  return files.sort();
}

/** 收集一个节点下的字符串字面量（含无替换模板字面量）。 */
function stringLiteralsIn(node) {
  const found = [];
  const visit = (child) => {
    if (ts.isStringLiteralLike(child)) found.push(child.text);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function retryableOf(call) {
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

/** 扫描一个源码文件的全部 `ApiError`/`PrivacyError` 站点，返回**违规**（非 false 的 retryable）清单。 */
export function scanSource(fileName, text) {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
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

function scanTree() {
  const files = scopeFiles();
  const violations = [];
  for (const path of files) {
    const file = relative(ROOT, path).split('\\').join('/');
    violations.push(...scanSource(file, readFileSync(path, 'utf8')));
  }
  return { files, violations };
}

test('受控范围非空（路径写错时不许静默通过）', () => {
  const { files, violations } = scanTree();
  for (const dir of SCOPE_DIRS) {
    assert.equal(
      files.some((path) => path.includes(`${join('services', 'api', 'src', dir)}`)),
      true,
      `受控范围 services/api/src/${dir} 下没有扫到任何 .ts`,
    );
  }
  // 20 是 @54ce029 实测值的下界（受控三目录共 30+ 个 .ts）；只防「范围被清空」这类失效。
  assert.ok(files.length >= 20, `受控范围只扫到 ${files.length} 个 .ts，疑似路径失配`);
  assert.ok(violations.length > 0, '受控范围内一个站点都没扫到，守卫形同虚设');
});

test('受控范围内每一处非 false 的 retryable 都必须命中白名单（逐字节 + 有理由 + 不腐烂）', () => {
  const { violations } = scanTree();
  const remaining = [...violations];
  for (const allowed of ALLOWED_RETRYABLE) {
    assert.equal(
      typeof allowed.reason === 'string' && allowed.reason.trim().length > 0,
      true,
      `白名单条目缺理由：${allowed.file} ${allowed.message}`,
    );
    const index = remaining.findIndex(
      (item) => item.file === allowed.file
        && item.retryable === allowed.retryable
        && item.messages.some((message) => message.includes(allowed.message)),
    );
    assert.notEqual(
      index,
      -1,
      `白名单条目未被命中（站点被删/表达式被改？请同步删条目）：${allowed.file} retryable=${allowed.retryable} message≈${allowed.message}`,
    );
    remaining.splice(index, 1);
  }
  assert.deepEqual(
    remaining.map((item) => `${item.file}:${item.line} ${item.errorClass} retryable=${item.retryable}`),
    [],
    '受控范围内出现未登记的 `retryable` 站点：按 `services/api/src/errors.ts:28-40` 判定后要么改成 false，要么登记白名单并写理由',
  );
});

test('守卫自检：合成样本上「true / 非字面表达式」必红，「false / 缺省」必绿（证明扫描器非空转）', () => {
  const scan = (body) => scanSource('synthetic.ts', body);

  assert.deepEqual(scan(`throw new ApiError('PROVIDER_UNAVAILABLE', '未接线', { retryable: false });`), []);
  assert.deepEqual(scan(`throw new ApiError('PROVIDER_UNAVAILABLE', '未接线');`), []);
  assert.deepEqual(scan(`throw new PrivacyError('PROVIDER_TIMEOUT', '超时', { retryable: true });`), []);

  const literalTrue = scan(`throw new ApiError('PROVIDER_UNAVAILABLE', '未接线', { retryable: true });`);
  assert.equal(literalTrue.length, 1);
  assert.equal(literalTrue[0].retryable, 'true');
  assert.deepEqual(literalTrue[0].messages, ['未接线']);

  const dynamic = scan(`throw new ApiError('PROVIDER_UNAVAILABLE', '未接线', {\n  retryable: classify(error),\n});`);
  assert.equal(dynamic.length, 1);
  assert.equal(dynamic[0].retryable, 'classify(error)');

  // 条件表达式里的 `PROVIDER_UNAVAILABLE`（catalog 的形态）也必须被识别。
  const conditional = scan(`throw new ApiError(flag ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE', 'x', { retryable: true });`);
  assert.equal(conditional.length, 1);
});
