/**
 * 守卫：`tests/**` 里**不许新增**写死 `源文件:行号` 的断言（R31）。
 *
 * 为什么需要这条守卫：2026-10-22 一天之内两次 CI 红都是同一族 —— "代码一改行、测试就红"。
 *   ① `tools/verify-contract-status.mjs` 的证据区间失效（另一片用 `--reanchor` 收口）；
 *   ② `tests/unit/sql-column-coverage.test.mjs` 的 NC6 把 `profile/service.ts:61` 写进断言，
 *      往 `put()` 上加两行变 65 ⇒ 红的是「测试过期」，不是「行为回退」。
 * 机械红最贵的地方不是修一次，而是**每次改业务代码都要陪着改测试**，久了就没人看红字了。
 * 结论：行号必须**算出来**（见 `sql-column-coverage.test.mjs` 的 `siteLine/siteRef`、
 * `contract-status-anchors.test.mjs` 里按夹具内容定位的做法），算不出来的才登记进
 * `line-anchor-allowlist.mjs`，并且每条要写清「为什么不能自动定位」。
 *
 * 判红口径（与扫描器 `line-anchor-scan.mjs` 同一套，不另立一套判据）：
 *   - 只拦「断言判据里的锚点」= `assert.*` 的判定实参 / 登记表 `ref:` 的值 / 正则字面量里的转义锚点；
 *   - 失败消息、`reason:` 文案、日志、注释**不拦**（它们不会因为代码挪行而变红；全拦会给几十条写豁免，
 *     守卫就被噪音拖垮了 —— 这条教训见 `migration-pin-guard.test.mjs` 的 ALLOW 注释）；
 *   - 指向不存在文件 / 行号越界（`…:99999`、合成夹具 `nc*-fake-*`）**不拦**：源码怎么改都不会让它红。
 *
 * 非空证明：本文件自带两组「先证它会红」的探针 —— 见 `守卫自身的非空证明` 两条用例。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { ANCHOR_ALLOWLIST, allowlistKey, hitKey } from './line-anchor-allowlist.mjs';
import {
  ROOT,
  classifyPosition,
  resetSourceCache,
  scanAnchors,
  scanTestFilesForHardcodedAnchors,
} from './line-anchor-scan.mjs';

const GUARD_FILE = 'tests/unit/test-line-anchors-guard.test.mjs';
const ALLOWLIST_FILE = 'tests/unit/line-anchor-allowlist.mjs';
/** 扫描时跳过自己与 allowlist 文件：前者要写探针字面量，后者要写被登记的锚点。 */
const SKIP = [GUARD_FILE, ALLOWLIST_FILE];

const OWNER_SHAPE = /^(?:GY-I\d+|R31)$/;
const ANCHOR_SHAPE = /^[A-Za-z0-9_@$./-]+\.(?:ts|tsx|mts|cts|mjs|cjs|js|jsx|sql|vue):\d+(?:-\d+)?$/;

/** 全仓扫一遍，返回 { blocked, files, ... }（每次都清缓存，探针改仓库后要重读）。 */
function scanRepo(options = {}) {
  resetSourceCache();
  return scanTestFilesForHardcodedAnchors({ skip: options.skip ?? new Set(SKIP), root: options.root });
}

/** 把一条判红命中渲染成 `测试文件:行 → 源文件:行`，方便直接点名。 */
function describe(hit) {
  return `${hit.file}:${hit.line} → ${hitKey('', hit.repoPath, hit.startLine, hit.endLine).slice(2)}`
    + `（${hit.position}${hit.callee === undefined ? '' : ` / ${hit.callee}`}，原文 ${JSON.stringify(hit.text)}）`;
}

test('line-anchors/扫描面非空：确实在扫 tests/**，不是扫了 0 个文件的假绿', () => {
  const result = scanRepo();
  // 假绿的样子：glob 写错 ⇒ 一个文件都没扫 ⇒ "没有违规"。这条先把它堵住。
  assert.ok(result.files >= 200, `扫描文件数只有 ${result.files} 个，明显没扫到 tests/**（口径失效，先修扫描器）`);
  assert.ok(
    result.blocked.length > 0,
    '一条判红点都没扫到 —— 连 allowlist 里那 5 条夹具锚点都不见了，说明判据/路径解析失效（不是"很干净"）',
  );
});

test('line-anchors/没有未登记的写死源文件:行号：新增即红并点名', () => {
  const result = scanRepo();
  const allowed = new Set(ANCHOR_ALLOWLIST.map((entry) => allowlistKey(entry)));
  const offenders = result.blocked.filter((hit) => !allowed.has(hitKey(hit.file, hit.repoPath, hit.startLine, hit.endLine)));
  assert.deepEqual(
    offenders.map(describe),
    [],
    '断言里不许写死 `源文件:行号`（代码一改行就会假红）。请改成按源码实时定位'
      + '（例如 sql-column-coverage.test.mjs 的 siteLine(siteRef)），确有必要才登记进 line-anchor-allowlist.mjs 并写清理由：\n'
      + offenders.map(describe).join('\n'),
  );
});

test('line-anchors/allowlist 形状：path/anchor/reason/owner 齐全且 owner 合法', () => {
  assert.ok(ANCHOR_ALLOWLIST.length > 0, 'allowlist 不该为空（至少那 5 条夹具锚点在）');
  const seen = new Set();
  for (const entry of ANCHOR_ALLOWLIST) {
    const where = JSON.stringify(entry);
    assert.equal(typeof entry.path, 'string', `allowlist 条目缺 path：${where}`);
    assert.match(entry.path, /^tests\/[\w./-]+\.(?:mjs|cjs|js|ts)$/, `allowlist 的 path 必须是 tests/ 下的脚本：${where}`);
    assert.equal(typeof entry.anchor, 'string', `allowlist 条目缺 anchor：${where}`);
    assert.match(entry.anchor, ANCHOR_SHAPE, `allowlist 的 anchor 必须形如「源文件:行号」或「源文件:起-止」：${where}`);
    assert.equal(typeof entry.reason, 'string', `allowlist 条目缺 reason：${where}`);
    assert.ok(
      (entry.reason ?? '').length >= 20,
      `allowlist 的 reason 要写清「为什么不能自动定位」（一句话，不能空着）：${where}`,
    );
    assert.match(String(entry.owner ?? ''), OWNER_SHAPE, `allowlist 的 owner 必须是 GY-Ixx 或 R31：${where}`);
    const key = allowlistKey(entry);
    assert.ok(!seen.has(key), `allowlist 里重复登记了同一条：${key}`);
    seen.add(key);
  }
});

test('line-anchors/allowlist 不腐烂：每条都必须仍然命中一处判红点（stale 即红）', () => {
  const result = scanRepo();
  const hits = new Set(result.blocked.map((hit) => hitKey(hit.file, hit.repoPath, hit.startLine, hit.endLine)));
  const stale = ANCHOR_ALLOWLIST
    .map((entry) => allowlistKey(entry))
    .filter((key) => !hits.has(key));
  assert.deepEqual(
    stale,
    [],
    'allowlist 里有条目已经不再命中任何「判红位置」的硬编码 —— 白名单不许腐烂成免疫区。'
      + '要么把写法改对了就删掉这条，要么把 anchor 更新成现在真实的形状：\n'
      + stale.join('\n'),
  );
});

test('line-anchors/判据只在断言侧：注释与失败文案里的锚点不拦（否则守卫会被噪音淹没）', () => {
  // 三类位置同一个锚点，只许中间那条判红。
  const source = [
    "// 说明：台账锚点见 services/api/src/profile/service.ts:35", // 注释
    "assert.ok(hit[0].includes('services/api/src/profile/service.ts:35'), '红字必须点名语句站点');", // 判红位置
    "assert.equal(bad, 1, '应当在 services/api/src/profile/service.ts:35 报红');", // 失败文案 = 散文
  ].join('\n');
  const verdicts = scanAnchors(source).map((hit) => ({ line: hit.line, position: classifyPosition(source, hit).position }));
  assert.deepEqual(
    verdicts.map((item) => `${item.line}:${item.position}`),
    ['1:prose', '2:assert-operand', '3:prose'],
    `判据位置分类错了（注释/文案被当成判据，或判据被漏掉）：${JSON.stringify(verdicts)}`,
  );
});

test('line-anchors/守卫自身的非空证明：临时插一条假硬编码 ⇒ 红并点名；删掉 ⇒ 绿', (t) => {
  // 在**临时目录**里造一个最小仓库（真源码原样复制过去），这样不碰本仓 tests/。
  const tempRoot = mkdtempSync(join(tmpdir(), 'gy-line-anchor-guard-'));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));
  const writeInto = (relPath, content) => {
    mkdirSync(dirname(join(tempRoot, relPath)), { recursive: true });
    writeFileSync(join(tempRoot, relPath), content, 'utf8');
  };
  copyFileSync(join(ROOT, 'services/api/src/profile/service.ts'), (() => {
    mkdirSync(join(tempRoot, 'services/api/src/profile'), { recursive: true });
    return join(tempRoot, 'services/api/src/profile/service.ts');
  })());
  const PROBE_FILE = 'tests/unit/probe-hardcoded-anchor.test.mjs';
  const probeSource = [
    "import assert from 'node:assert/strict';",
    '',
    // 故意写死真源码的行号：这正是禁止形状（行号本该由 siteLine 现算）。
    "assert.ok(hit[0].includes('services/api/src/profile/service.ts:35'), '红字必须点名语句站点');",
    '',
  ].join('\n');
  writeInto(PROBE_FILE, probeSource);

  const red = scanRepo({ root: tempRoot, skip: new Set() });
  const offenders = red.blocked.map(describe);
  assert.equal(red.blocked.length, 1, `探针没有被判红（守卫是空转的！）：${JSON.stringify(red.blocked)}`);
  assert.equal(offenders[0].startsWith(`${PROBE_FILE}:3 → `), true, `判红必须点名探针文件的 文件:行，实际：${offenders[0]}`);
  assert.ok(offenders[0].includes('services/api/src/profile/service.ts:35'), `判红必须点名被写死的源文件:行号，实际：${offenders[0]}`);

  // 删掉 ⇒ 同一棵树必须回绿（证明红的成因就是那条锚点，不是别的）。
  rmSync(join(tempRoot, PROBE_FILE), { force: true });
  const green = scanRepo({ root: tempRoot, skip: new Set() });
  assert.deepEqual(green.blocked.map(describe), [], '删掉探针后应该一条都不剩');
  console.log(`[line-anchors] 非空证明：探针判红 → ${offenders[0]}`);
});

test('line-anchors/守卫自身的非空证明：allowlist 不是通配符（换个测试文件写同样的锚点仍然红）', (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'gy-line-anchor-guard-wildcard-'));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));
  const copy = (relPath) => {
    mkdirSync(dirname(join(tempRoot, relPath)), { recursive: true });
    copyFileSync(join(ROOT, relPath), join(tempRoot, relPath));
  };
  // 把 allowlist 已登记的那条锚点（ocr.ts:2-8）**原封不动**写进另一个测试文件。
  copy('services/api/src/routes/ocr.ts');
  const PROBE_FILE = 'tests/unit/probe-reuse-allowlisted-anchor.test.mjs';
  mkdirSync(dirname(join(tempRoot, PROBE_FILE)), { recursive: true });
  writeFileSync(
    join(tempRoot, PROBE_FILE),
    [
      "import assert from 'node:assert/strict';",
      '',
      "assert.match(stderr, /getOCR: services\\/api\\/src\\/routes\\/ocr\\.ts:2-8 覆盖的是别的块/);",
      '',
    ].join('\n'),
    'utf8',
  );
  // 真 allowlist 一起带上：它只按「测试文件 + anchor」精确匹配，所以这条不该被放行。
  const result = scanRepo({ root: tempRoot, skip: new Set() });
  const allowed = new Set(ANCHOR_ALLOWLIST.map((entry) => allowlistKey(entry)));
  const uncovered = result.blocked.filter(
    (hit) => !allowed.has(hitKey(hit.file, hit.repoPath, hit.startLine, hit.endLine)),
  );
  assert.equal(uncovered.length, 1, `allowlist 被当成了通配符（换个测试文件也放行）：${JSON.stringify(result.blocked)}`);
  assert.equal(uncovered[0].file, PROBE_FILE, `判红必须点名新文件，实际：${describe(uncovered[0])}`);
});
