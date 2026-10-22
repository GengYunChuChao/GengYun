// GY-I22（#22）· `PROVIDER_UNAVAILABLE` 的 `retryable` 口径**仓库级静态守卫**。
//
// 为什么要静态守卫（#233 的真实教训）：口径原文写在 `services/api/src/errors.ts` 的 `ApiError` 注释里
// （「能力未装配／未接线造成的 `PROVIDER_UNAVAILABLE` 一律 false，只有瞬时类才可 true」），但**每个调用点
// 各自写字面量** ⇒ 「全站统一」那一轮仍有 9 处漏改，且没有任何测试会红。本文件把那句口径变成可执行的清单。
//
// 规则（受控范围内，两条判据共用一份白名单 `./retryable-guard-allowlist.mjs`、共用一份判据实现
// `./retryable-guard-scan.mjs`，⛔ 不许各写一套）：
//   ① `PROVIDER_UNAVAILABLE` 站点：找出所有 `new ApiError(...)` / `new PrivacyError(...)`，其**第 1 参**含
//      字符串字面量 `'PROVIDER_UNAVAILABLE'`；第 3 参 `options.retryable` 只允许：① 缺省 ② 字面量 `false`；
//      其余（字面量 `true` 或任何非字面表达式）必须命中白名单条目（逐字节钉住表达式文本、钉住消息字面量、
//      且**必须写理由与责任片**）。
//   ② 兜底恒 true（R31 新增）：catch 通道上（catch 块内 / 本文件某个 catch 调用过的映射函数内）的
//      `retryable: true` 若**没有任何具名条件**为它背书（不是 `if` 的 then 分支、不是 `switch` 的非 default
//      case、不是三元的一臂），即为「其余一切情况都算可重试」的兜底 ⇒ 同样必须命中白名单。
//      判据细节见 `retryable-guard-scan.mjs` 的 `scanFallbackClaims`。
//
// 因此：把任一 `false` 改回 `true`、把分类器调用换成字面量、或新增一个未登记的 `retryable: true` 站点 ⇒ 本文件必红。
// 反过来，**删掉**某个站点或改其表达式文本时白名单条目会变成「未被命中」⇒ 同样必红（白名单不会腐烂）。
//
// 受控范围：`services/api/src/{db,privacy,conversations}/**`（#22 原范围）
//   + `services/api/src/{admin/ops,ocr,speech,recognitions,media}/**`（R31 扩域）。
//   扩域理由：#455 落地后暴露的缺口之一 —— 这几处 store/gate 写回「兜底恒 true」不会判红。在基线
//   `d4d48088` 上扩域，实测出 **9 处**既有站点，全部登记进白名单（其中 5 处当时判为真缺陷：2 处 admin/ops
//   兜底恒 true + 3 处 `tablesReady`）。**时点**：本片基线随后并入了 `#455`（head `0eaf1bde`），那 5 处
//   已由 #455 修掉（2 处改为委托共享判据 `flagReadFailure(error)`，3 处改为 `retryable: false` +
//   `details: PROBE_SHAPE_UNKNOWN`），对应的 3 条 `tablesReady` 白名单条目按「不腐烂」规则删除 ⇒ 现存白名单
//   12 条、受控范围内 `judgement: none` 归零。本片自身仍未改业务行为：那 5 处是 #455 的改动，不是本片的。
//   派单建议里还提到 `synthesis/`，但 @54ce029 下**没有**该目录（外发合成实现在
//   `services/api/src/privacy/synthesis-egress.ts`，已被范围内覆盖）。
//
// 本文件只钉**结构**（谁在写 retryable、写成什么、有没有判据），不重复钉行为；行为断言在
// `tests/unit/error-retryable-behavior.test.mjs`，口径注释原文见 `services/api/src/errors.ts:28-40`。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertEntriesWellFormed,
  ALLOWED_RETRYABLE,
  kindsOf,
  matchesAllowed,
} from './retryable-guard-allowlist.mjs';
import {
  scanFallbackClaims,
  scanProviderUnavailableSites,
} from './retryable-guard-scan.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const API_SRC = join(ROOT, 'services', 'api', 'src');
const SCOPE_DIRS = ['db', 'privacy', 'conversations', 'admin/ops', 'ocr', 'speech', 'recognitions', 'media'];

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

function scanTree() {
  const files = scopeFiles();
  const providerUnavailable = [];
  const fallbacks = [];
  for (const path of files) {
    const file = relative(ROOT, path).split('\\').join('/');
    const text = readFileSync(path, 'utf8');
    providerUnavailable.push(...scanProviderUnavailableSites(file, text));
    fallbacks.push(...scanFallbackClaims(file, text));
  }
  const violations = {
    providerUnavailable,
    fallback: fallbacks.filter((claim) => claim.judgement === 'none'),
  };
  return { files, fallbacks, violations };
}

const describe = (item) =>
  `${item.file}:${item.line} ${item.function ?? '?'} retryable=${item.retryable}`;

test('受控范围非空（路径写错时不许静默通过）', () => {
  const { files, fallbacks, violations } = scanTree();
  for (const dir of SCOPE_DIRS) {
    assert.equal(
      files.some((path) => path.includes(join('services', 'api', 'src', dir))),
      true,
      `受控范围 services/api/src/${dir} 下没有扫到任何 .ts`,
    );
  }
  // 72 = @R31 扩域后实测值（旧 3 域 33 + 新 5 域 39）；60 是防「范围被清空」的下界。
  assert.ok(files.length >= 60, `受控范围只扫到 ${files.length} 个 .ts，疑似路径失配`);
  assert.ok(
    violations.providerUnavailable.length > 0,
    '受控范围内一个 PROVIDER_UNAVAILABLE 站点都没扫到，守卫形同虚设',
  );
  assert.ok(fallbacks.length > 0, '受控范围内一个 catch 通道的 retryable 站点都没扫到，第二条判据形同虚设');
});

test('受控范围内每一处非 false 的 retryable 都必须命中白名单（逐字节 + 有理由 + 有责任片 + 不腐烂）', () => {
  const { violations } = scanTree();
  assert.deepEqual(assertEntriesWellFormed(ALLOWED_RETRYABLE), [], '白名单条目本身不合规');

  for (const [kind, sites] of Object.entries(violations)) {
    const remaining = [...sites];
    for (const allowed of ALLOWED_RETRYABLE) {
      if (!kindsOf(allowed).includes(kind)) continue;
      const index = remaining.findIndex((item) => matchesAllowed(allowed, item));
      assert.notEqual(
        index,
        -1,
        `白名单条目未被命中（站点被删/表达式被改？请同步删条目）：kind=${kind} ${allowed.file} `
        + `function=${allowed.function ?? '*'} retryable=${allowed.retryable} message≈${allowed.message ?? '*'}`,
      );
      remaining.splice(index, 1);
    }
    assert.deepEqual(
      remaining.map(describe),
      [],
      kind === 'providerUnavailable'
        ? '受控范围内出现未登记的 `retryable` 站点：按 `services/api/src/errors.ts:28-40` 判定后要么改成 false，要么登记白名单并写理由'
        : '受控范围内出现未登记的「兜底恒 retryable: true」站点（catch 分支里没有判据就声称可重试）：要么给出具体判据（如 isTransientDatabaseError），要么改成 false，要么登记白名单并写理由',
    );
  }
});

test('守卫自检：合成样本上「true / 非字面表达式」必红，「false / 缺省」必绿（证明扫描器非空转）', () => {
  const scan = (body) => scanProviderUnavailableSites('synthetic.ts', body);

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

test('兜底判据自检：catch 里的裸 true 必判 none，有具名条件的 true 与计算表达式必判 has', () => {
  const claims = (body) => scanFallbackClaims('synthetic.ts', body).map((claim) => claim.judgement);

  // ① catch 分支里裸 `retryable: true`（没有判据）⇒ none。
  assert.deepEqual(
    claims(`function f() { try { g(); } catch (e) { return { retryable: true }; } }`),
    ['none'],
  );
  // ② 同一形状写在 catch 调用的映射函数里（ocr/store-pg.ts 的 classify* 形态）⇒ 同样 none。
  assert.deepEqual(
    claims(`function mapIt(e) { return { retryable: true }; }
      function f() { try { g(); } catch (e) { throw mapIt(e); } }`),
    ['none'],
  );
  // ③ `if` 的 then 分支里 ⇒ 有具名条件 ⇒ has。
  assert.deepEqual(
    claims(`function f() { try { g(); } catch (e) { if (e.code === '57014') return { retryable: true }; } }`),
    ['has'],
  );
  // ④ 计算表达式 ⇒ 判据在表达式里 ⇒ has。
  assert.deepEqual(
    claims(`function f() { try { g(); } catch (e) { return { retryable: isTransient(e) }; } }`),
    ['has'],
  );
  // ⑤ `retryable: false` 与「不在 catch 通道上」的裸 true 都不进清单（后者见判据边界）。
  assert.deepEqual(
    claims(`function f() { try { g(); } catch (e) { return { retryable: false }; } }`),
    [],
  );
  assert.deepEqual(claims(`function f() { return { retryable: true }; }`), []);
});
