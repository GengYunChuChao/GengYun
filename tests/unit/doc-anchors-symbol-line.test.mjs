/**
 * 符号行判据（`NOT_SYMBOL_LINE`）的定向单测：把「锚点必须落在可识别符号行」这条判据钉在闸门上。
 *
 * 事故（#678 之后实测）：`docs/architecture/admin-console-capability-map.md:75` 写
 * `fetchAccountsPage（apps/admin/src/lib/admin-api.mjs:123）`，而上方插入约 30 行后 `:123`
 * 已经漂进 `export async function fetchAccountsPage` **自己的 JSDoc 中部**——旧判据只看「目标行是不是
 * 实质内容行」，而注释行算实质内容，于是门禁 exit 0，假绿被带进 PR。反向也通：指到 JSDoc 的收尾行
 * （星号加斜杠那一行）照样过。
 *
 * 本文件钉住的五件事（判据改坏成「恒真」「恒假」都必须让它们红）：
 *   ① 锚点落在块注释收尾行 → NOT_SYMBOL_LINE；
 *   ② 锚点落在 JSDoc 中部、且注释里**恰好提到那个符号名** → NOT_SYMBOL_LINE（就是事故的形状：
 *      「注释里出现了符号名」不构成豁免，否则等于把事故本身写成了合法形态）；
 *   ③ 真声明行 → 绿；**声明行带行尾注释**也绿（逐行判定的回归钉：只判「区间落在某个注释跨度里」
 *      会把 `const ONLINE_HOURS = 24 * 7; // …` 判成注释行）；
 *   ④ 空行、纯括号行 → 红（SUSPECT，旧判据已有；新判据不得把它们放过去）；
 *   ⑤ 夹具里一批合法锚点（声明行 / 函数体内的代码行 / 非源码后缀）→ 全绿，不得误伤。
 * 另钉两条边界：注释块**与声明无关**时（文件头/再导出门面）保持绿；文档行**逐字引用**该注释块原文时
 * 保持绿（`comment-cited`）——豁免必须可复核，引文就是证据，不逐字的引用不放行。
 *
 * 再补四条「语义钉子」：原来那 10 例把下面三处实现改坏也全绿（夹具缺口，由审查方的变异证明指出），
 * 所以各钉一条。改坏任一处都必须让本文件红：
 *   ⑥ 引文最短长度门槛（`CITE_MIN_LENGTH`）：恰好 4 个字算引原文 ⇒ 豁免；差一个字符（3 个字）⇒ 仍判红。
 *      门槛被改成 1 时，3 个字的「不写库」会被当成引文 ⇒ ⑥ 红。
 *   ⑦ 引文归属：文档行只出现符号名（哪怕包在反引号里）不算引文 ⇒ 仍判红。实现被放松成
 *      「文档里出现符号名就豁免」时 ⇒ ⑦ 红。
 *   ⑧ 注释块与声明行之间的空行：0／1／2 个空行都仍算「紧贴声明」⇒ 判红。实现被改成
 *      「遇空行即判定 detached」时 ⇒ ⑧ 红。（只钉 0-2；3 个以上属已知未定义区，刻意不钉。）
 *   ⑨ 已知限制（**有意留，待后续片**）：`*&#47;` 之后紧跟另一个 `/**` 时，被引用行落在前一个注释块里，
 *      却因为「块后第一条非空行是注释、不是声明」被判成 `comment-detached` ⇒ 不判红。真实实例在
 *      `docs/` 下存在（相邻块 + 文档逐字引用）。本条**只钉「当前行为 = 不判红」**，不把它当正确语义；
 *      修它会动到「引用注释文案」这条既有合法证据形态，故意留到后续片一起处理。
 *
 * 全部用临时目录夹具 + 直接调 `collectFindings()` / `main()`，⛔ 不 spawn 子进程、不联网、不写仓库内文件。
 * 行号口径：夹具里的行号是本文件自己造的临时文件行号，不是仓库源文件行号；但**不得写进正则字面量**——
 * 形如 `/admin-api\.mjs:4/` 的正则锚点会被守卫 `test-line-anchors-guard.test.mjs`（扫描器
 * `line-anchor-scan.mjs`）判成 `regex-anchor` 并点名（`apps/admin/src/lib/admin-api.mjs:4` 能按唯一后缀
 * 解析到真实文件，所以它连 phantom 豁免都拿不到）。需要断言「读数里带了行号」时一律用 `lineOf()` 现算。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  NOT_SYMBOL_LINE,
  SUSPECT,
  SYMBOL_LINE_SCOPE,
  collectFindings,
  judgeSymbolLine,
  main,
} from '../../tools/verify-doc-anchors.mjs';

/** 在临时目录里搭一棵最小仓库（与 `doc-anchors-guard.test.mjs` 同口径：不解压、不联网、不落仓库内）。 */
function makeFixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'gy-doc-anchors-symbol-line-'));
  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = join(root, relativePath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  return root;
}

/**
 * 事故形状夹具：`fetchAccountsPage` 的 JSDoc 占 1-5 行、真声明在第 6 行。
 * 第 4 行是「注释里点名了符号」的那一行——旧判据下 4、5、6 三行全绿。
 */
const ADMIN_API = [
  '/**', // 1
  ' * 账号目录读面：只读一页，不写库。', // 2
  ' *', // 3
  ' * `fetchAccountsPage` 出现在注释里也不等于声明行。', // 4
  ' */', // 5
  'export async function fetchAccountsPage({ limit = 20 } = {}) {', // 6
  '  return { limit };', // 7
  '}', // 8
  '', // 9
  'export const LIMIT_DEFAULT = 20;', // 10
  'const ONLINE_HOURS = 24 * 7; // 在线 7×24 小时', // 11
  '' // 12
].join('\n');

/** 第二份夹具：JSDoc 里出现一行纯括号内容（` * }`），以及一行顶层纯括号 `})`。 */
const HANDLERS = [
  '/**', // 1
  ' * 收尾语义示例：', // 2
  ' * }', // 3
  ' */', // 4
  'export function handler() {', // 5
  '  return 1;', // 6
  '}', // 7
  '', // 8
  'const TAIL = 1;', // 9
  '})', // 10
  '' // 11
].join('\n');

/** 第三份夹具：注释块后面跟的是 `import`（不是声明行）⇒ 注释与声明无关，属分节注释。 */
const DETACHED = [
  '/**', // 1
  ' * 媒体域门面：这里只做再导出。', // 2
  ' */', // 3
  "import { passthrough } from './passthrough.mjs';", // 4
  '' // 5
].join('\n');

/** 非源码后缀的夹具：`.sql` 不在 `SYMBOL_SOURCE_EXTENSIONS` 内，判据不适用（不判红）。 */
const SCHEMA = ['-- 迁移脚本：本文件的注释行不是导入锚点', 'CREATE TABLE t (id INT);', ''].join('\n');

const SOURCES = {
  'services/api/src/admin-api.mjs': ADMIN_API,
  'services/api/src/handlers.ts': HANDLERS,
  'services/api/src/detached.ts': DETACHED,
  'packages/db/migrations/0001.sql': SCHEMA
};

/** 基线：空（三条负控制都在 `doc-anchors-guard.test.mjs`，这里只关心符号行判据）。 */
const EMPTY_BASELINE = `${JSON.stringify({ schema_version: 1, entries: [] }, null, 2)}\n`;

const DOCS = {
  // 事故现场：注释中部（点着符号名）、注释收尾行、真声明行、空行。
  'docs/architecture/incident.md': [
    '① 注释中部且注释里点名了符号：`services/api/src/admin-api.mjs:4`。',
    '② 块注释收尾行：`services/api/src/admin-api.mjs:5`。',
    '③ 真声明行：`services/api/src/admin-api.mjs:6`。',
    '④ 空行：`services/api/src/admin-api.mjs:9`。',
    ''
  ].join('\n'),
  // 注释里的纯括号内容行 + 顶层纯括号行。
  'docs/architecture/bracket.md': [
    '① JSDoc 里的纯括号行：`services/api/src/handlers.ts:3`。',
    '② 顶层纯括号行：`services/api/src/handlers.ts:10`。',
    ''
  ].join('\n'),
  // 同一条目标行，但文档行**逐字引用**了注释块里的原文 ⇒ 合法（豁免可复核）。
  'docs/architecture/quote.md': '引用注释原文：「收尾语义示例」——见 `services/api/src/handlers.ts:3`。\n',
  // 分节注释（块后不是声明行）⇒ 合法。
  'docs/architecture/detached.md': '再导出门面：`services/api/src/detached.ts:2`（块注释后面是 import，不是声明）。\n',
  // ⑤ 批量合法锚点：声明行、函数体内代码行、非源码后缀。
  'docs/architecture/legal.md': [
    '声明：`services/api/src/admin-api.mjs:6`。',
    '函数体：`services/api/src/admin-api.mjs:7`。',
    '常量声明：`services/api/src/admin-api.mjs:10`。',
    '声明带行尾注释：`services/api/src/admin-api.mjs:11`。',
    '另一份文件的声明：`services/api/src/handlers.ts:5`。',
    '另一份文件的函数体：`services/api/src/handlers.ts:6`。',
    '常量：`services/api/src/handlers.ts:9`。',
    '非声明但属代码行（import）：`services/api/src/detached.ts:4`。',
    '非源码后缀不判（`.sql`）：`packages/db/migrations/0001.sql:1-2`。',
    ''
  ].join('\n'),
  // 作用域外（历史证据页）：同形状只统计、不判红。
  'docs/verification/history.md': '历史读数页：`services/api/src/handlers.ts:3`（与事故同形状，但按历史证据不追溯）。\n'
};

const FIXTURE = { ...SOURCES, ...DOCS, 'tools/doc-anchors-baseline.json': EMPTY_BASELINE };

/** 跑一次全量扫描（两份扫描目标都进来，才能覆盖「作用域外只统计」那条）。 */
function scan(files = FIXTURE) {
  const root = makeFixture(files);
  try {
    const result = collectFindings({ root, targets: ['docs/architecture', 'docs/verification'] });
    return { root, ...result };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

const referencesOf = (findings, reason) =>
  findings.filter(finding => finding.reason === reason).map(finding => finding.reference).sort();

/**
 * 夹具里的行号一律现算（1 基；找不到返回 0）。
 *
 * 存在的理由：断言「读数里给出了正确行号」时若把行号写进正则字面量（`/…admin-api\.mjs:4/`），
 * 守卫 `test-line-anchors-guard.test.mjs` 会把它判成 `regex-anchor`（硬编码 `源文件:行号`）并点名红掉——
 * 夹具里那行插一个空行，判据本身没变，测试就先红了。现算之后行号漂移只会让断言说真话。
 */
function lineOf(text, pattern) {
  const index = String(text).split('\n').findIndex(raw => pattern.test(raw));
  return index < 0 ? 0 : index + 1;
}

/** 只放本用例关心的那份源码 + 那几份文档的最小夹具（`docs/verification` 必须存在，否则扫描目标会响）。 */
function scanOnly(files) {
  return scan({
    ...files,
    'docs/verification/placeholder.md': '历史读数页占位：本用例不关心作用域外读数。\n',
    'tools/doc-anchors-baseline.json': EMPTY_BASELINE
  });
}

test('① 锚点落在块注释收尾行（` */`）⇒ NOT_SYMBOL_LINE', () => {
  const { findings } = scan();
  const flagged = findings.filter(finding => finding.reason === NOT_SYMBOL_LINE && finding.reference === 'services/api/src/admin-api.mjs:5');
  assert.equal(flagged.length, 1, '指向块注释收尾行的锚点必须判红（旧判据把它当实质内容行放过）');
  assert.equal(flagged[0].doc, 'docs/architecture/incident.md');
  // 报错要能一眼改对：说清该往哪一行改。
  assert.match(flagged[0].detail, /第 1-5 行的注释/, '读数必须给出注释块的行区间');
  assert.match(
    flagged[0].detail,
    /该注释块后面的声明行是 services\/api\/src\/admin-api\.mjs:6（fetchAccountsPage）/,
    '读数必须给出「该注释块后面的声明行是 path:N」，否则维护者还得自己回文件里找'
  );
});

test('② 锚点落在 JSDoc 中部、注释里恰好提到符号名 ⇒ NOT_SYMBOL_LINE（事故形状）', () => {
  const { findings } = scan();
  // 行号从夹具现算：写进正则字面量就会被守卫判成「硬编码 源文件:行号」（regex-anchor）而红，
  // 于是「行号漂了」和「判据坏了」分不清。现算之后这条断言只对判据负责。
  const mentionLine = lineOf(ADMIN_API, /^\s*\*.*fetchAccountsPage/);
  const declarationLine = lineOf(ADMIN_API, /^export async function fetchAccountsPage/);
  assert.ok(mentionLine > 1 && declarationLine > mentionLine, '夹具必须真的是事故形状：点名符号的注释行在前，真声明行在后');
  const reference = `services/api/src/admin-api.mjs:${mentionLine}`;
  const flagged = findings.filter(finding => finding.reason === NOT_SYMBOL_LINE && finding.reference === reference);
  assert.equal(flagged.length, 1, '「注释里出现了符号名」不构成豁免——否则事故本身就是合法形态');
  // 被指的那一行必须真的是提到符号名的注释行（否则测的不是事故形状）。
  assert.match(ADMIN_API.split('\n')[mentionLine - 1], /^\s*\*.*fetchAccountsPage/, '被指的那一行必须是提到符号名的注释行（否则测的不是事故形状）');
  // 读数要能一眼改对：必须点出该注释块后面的真声明行（行号同样现算）。
  assert.match(
    flagged[0].detail,
    new RegExp(`该注释块后面的声明行是 services/api/src/admin-api\\.mjs:${declarationLine}（fetchAccountsPage）`),
    `读数必须给出「该注释块后面的声明行是 path:N」，实际：${flagged[0].detail}`
  );
  // 同一份文档里的真声明行不得陪绑。
  assert.equal(
    findings.some(finding => finding.reference === `services/api/src/admin-api.mjs:${declarationLine}`),
    false,
    '真声明行被同一条判据判红，说明判据在误伤'
  );
});

test('③ 真声明行 ⇒ 绿；声明行带行尾注释也绿（逐行判定的回归钉）', () => {
  const { findings, stats } = scan();
  const legal = [
    'services/api/src/admin-api.mjs:6',
    'services/api/src/admin-api.mjs:10',
    'services/api/src/admin-api.mjs:11',
    'services/api/src/handlers.ts:5'
  ];
  for (const reference of legal) {
    assert.equal(findings.some(finding => finding.reference === reference), false, `${reference} 是声明行，不得判红`);
  }
  assert.ok(stats.symbol.code >= legal.length, '声明行必须计入「落代码行」');
});

test('④ 空行 / 纯括号行 ⇒ 红（空行与 `})` 走 SUSPECT，注释内纯括号行走 NOT_SYMBOL_LINE）', () => {
  const { findings } = scan();
  const suspicious = referencesOf(findings, SUSPECT);
  assert.deepEqual(
    suspicious,
    ['services/api/src/admin-api.mjs:9', 'services/api/src/handlers.ts:10'],
    '空行与顶层纯括号行必须判红（旧判据的 SUSPECT 不得被新判据放行）'
  );
  assert.equal(
    findings.some(finding => finding.reason === NOT_SYMBOL_LINE && finding.reference === 'services/api/src/handlers.ts:3'),
    true,
    '注释块里的 ` * }` 行同样是注释行，必须按 NOT_SYMBOL_LINE 判红'
  );
});

test('⑤ 夹具里一批合法锚点全绿，且不误伤非源码后缀', () => {
  const { findings, stats } = scan();
  const legalReferences = [
    'services/api/src/admin-api.mjs:6',
    'services/api/src/admin-api.mjs:7',
    'services/api/src/admin-api.mjs:10',
    'services/api/src/admin-api.mjs:11',
    'services/api/src/handlers.ts:5',
    'services/api/src/handlers.ts:6',
    'services/api/src/handlers.ts:9',
    'services/api/src/detached.ts:4',
    'services/api/src/detached.ts:2',
    'packages/db/migrations/0001.sql:1-2'
  ];
  for (const reference of legalReferences) {
    assert.equal(findings.some(finding => finding.reference === reference), false, `${reference} 被误判，说明判据在误伤`);
  }
  // 判红的恰好是三条：注释中部、注释收尾行、注释里的纯括号行。
  assert.deepEqual(
    referencesOf(findings, NOT_SYMBOL_LINE),
    ['services/api/src/admin-api.mjs:4', 'services/api/src/admin-api.mjs:5', 'services/api/src/handlers.ts:3'],
    'NOT_SYMBOL_LINE 的判红面必须精确，多一条就是误伤、少一条就是漏判'
  );
  // `.sql` 不在源码后缀白名单里 ⇒ 不判定（不得静默按「不是符号行」判红）。
  assert.equal(stats.symbol.inScope, stats.symbol.code + stats.symbol.detached + stats.symbol.cited + stats.symbol.attached);
});

test('豁免必须可复核：逐字引用注释原文 ⇒ 绿；不逐字 ⇒ 红（同一条目标行两种命运）', () => {
  const { findings, stats } = scan();
  const target = 'services/api/src/handlers.ts:3';
  assert.equal(
    findings.some(finding => finding.reason === NOT_SYMBOL_LINE && finding.reference === target && finding.doc === 'docs/architecture/quote.md'),
    false,
    '文档行逐字引用了该注释块里的文字，属「引用注释文案」这一合法证据形态'
  );
  assert.equal(
    findings.some(finding => finding.reason === NOT_SYMBOL_LINE && finding.reference === target && finding.doc === 'docs/architecture/bracket.md'),
    true,
    '同一条目标行，没引原文就必须判红——豁免的依据是引文，不是目标行本身'
  );
  assert.equal(stats.symbol.cited, 1, '逐字引用要单独计数，便于事后复核豁免有多少条');
});

test('边界：作用域只到 `docs/architecture/**`，历史证据页同形状只统计不判红', () => {
  const { findings, stats } = scan();
  assert.equal(SYMBOL_LINE_SCOPE, 'docs/architecture/');
  assert.equal(
    findings.some(finding => finding.doc === 'docs/verification/history.md'),
    false,
    '历史读数页按 ANCHOR_DRIFT 的同一语义「历史证据不跟当前树改写」，不判红'
  );
  assert.equal(stats.symbol.outside, 1, '作用域外同形状必须如实计数，否则这条边界会变成隐形豁免');
});

test('判据本体与闸门同源：`judgeSymbolLine` 四档状态可区分，且只有 comment-attached 判红', () => {
  const lines = ADMIN_API.split('\n');
  const verdict = (from, to) =>
    judgeSymbolLine({
      docPath: 'docs/architecture/incident.md',
      docLineText: DOCS['docs/architecture/incident.md'].split('\n')[from - 1] ?? '',
      target: 'services/api/src/admin-api.mjs',
      text: ADMIN_API,
      lines,
      from,
      to
    });
  assert.equal(verdict(4, 4).status, 'comment-attached');
  assert.equal(verdict(5, 5).status, 'comment-attached');
  assert.equal(verdict(6, 6).status, 'code');
  assert.equal(verdict(7, 7).status, 'code');
  assert.equal(verdict(11, 11).status, 'code', '声明行带行尾注释仍是代码行');
  // 分节注释：块后不是声明行。
  const detachedLines = DETACHED.split('\n');
  assert.equal(
    judgeSymbolLine({
      docPath: 'docs/architecture/detached.md',
      docLineText: DOCS['docs/architecture/detached.md'],
      target: 'services/api/src/detached.ts',
      text: DETACHED,
      lines: detachedLines,
      from: 2,
      to: 2
    }).status,
    'comment-detached'
  );
});

test('CLI：事故形状在 --strict 下 exit 1，且失败清单给出「应改到哪一行」', () => {
  const root = makeFixture(FIXTURE);
  try {
    const stdout = [];
    const stderr = [];
    const code = main(
      ['--strict', '--root', root, '--scan', 'docs/architecture', '--scan', 'docs/verification', '--baseline', 'tools/doc-anchors-baseline.json'],
      { log: line => stdout.push(line), error: line => stderr.push(line) }
    );
    const text = [...stdout, ...stderr].join('\n');
    assert.equal(code, 1, '基线外新增必须 exit 1');
    assert.match(text, /COUNT: .*NOT_SYMBOL_LINE 3/, '读数行要报出 NOT_SYMBOL_LINE 的条数');
    assert.match(text, /SYMBOL-LINE: 作用域 docs\/architecture\/\*\*/, '读数行要报出判据作用域与四档分布');
    assert.match(text, /该注释块后面的声明行是 services\/api\/src\/admin-api\.mjs:6/, '失败清单要给出重锚目标行');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI：把事故锚点改到真声明行后 exit 0（判据不得「永远红」）', () => {
  const fixed = {
    ...FIXTURE,
    'docs/architecture/incident.md': [
      '① 真声明行：`services/api/src/admin-api.mjs:6`。',
      '② 函数体：`services/api/src/admin-api.mjs:7`。',
      ''
    ].join('\n'),
    'docs/architecture/bracket.md': '顶层纯括号行不进来（它是 SUSPECT，不在本判据覆盖面内）：`services/api/src/handlers.ts:5`。\n',
    'docs/verification/history.md': DOCS['docs/verification/history.md']
  };
  const root = makeFixture(fixed);
  try {
    const stdout = [];
    const stderr = [];
    const code = main(
      ['--strict', '--root', root, '--scan', 'docs/architecture', '--scan', 'docs/verification', '--baseline', 'tools/doc-anchors-baseline.json'],
      { log: line => stdout.push(line), error: line => stderr.push(line) }
    );
    const text = [...stdout, ...stderr].join('\n');
    assert.equal(code, 0, `修好之后必须 exit 0，实际读数：\n${text}`);
    assert.match(text, /COUNT: .*NOT_SYMBOL_LINE 0/);
    assert.match(text, /PASS: --strict 下没有基线之外的新增/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ⑥⑦⑧⑨：补上审查方用变异证明点出的夹具缺口。
// 原来那 10 例把下面三处实现改坏也全绿，说明这三处语义没有钉子；各补一条，改坏即红。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⑥ 的夹具：注释里同时写着 4 字短语「只读一页」与 3 字短语「不写库」。
 * 文档行逐字引用 4 字 ⇒ 豁免（`comment-cited`）；引用 3 字 ⇒ 差一个字符，仍判红。
 */
const CITATION = [
  '/**',
  ' * 账号目录读面：只读一页，不写库。',
  ' */',
  'export const READ_ONLY = true;',
  ''
].join('\n');

/** ⑦ 的夹具：注释里没有任何「文档会逐字引用」的成分，文档行只点到符号名本身。 */
const SYMBOL_ONLY = [
  '/**',
  ' * 只读账号目录，不写库。',
  ' */',
  'export async function listAccounts() {}',
  ''
].join('\n');

/**
 * ⑧ 的夹具：三块文档注释，块后分别隔 `gaps` 个空行，然后才是真声明行。
 * 行号与空行数都由构造过程返回，测试里不写死。
 */
function blankLineFixture(gaps) {
  const names = ['alpha', 'beta', 'gamma'];
  const lines = [];
  const commentLines = [];
  gaps.forEach((gap, index) => {
    lines.push('/**');
    commentLines.push(lines.length + 1); // 注释正文行（` * 块 X：…`）的行号，1 基
    lines.push(` * 块 ${'ABC'[index]}：块后隔 ${gap} 个空行。`);
    lines.push(' */');
    for (let padding = 0; padding < gap; padding += 1) lines.push('');
    lines.push(`export const ${names[index]} = ${index + 1};`);
  });
  lines.push('');
  return { text: lines.join('\n'), commentLines, gaps };
}

/**
 * ⑨ 的夹具（**已知限制，不是正确语义**）：一个注释块的收尾（星号加斜杠）之后紧跟另一个注释块的开头。
 * 前块后面第一条非空行是注释而不是声明，归属被判 `comment-detached`，于是前块里的锚点**不判红**。
 */
const ADJACENT = [
  '/**',
  ' * 前一个块：说明为什么这么写。',
  ' */',
  '/**',
  ' * 后一个块：紧跟着再写一条。',
  ' */',
  'export const ZETA = 1;',
  ''
].join('\n');

test('⑥ 引文最短长度门槛：4 个字算引注释原文（豁免），差一个字符（3 个字）仍判红', () => {
  const atThreshold = '只读一页';
  const oneShort = '不写库';
  assert.equal([...atThreshold].length, 4, '夹具：恰达门槛的引文必须是 4 个字');
  assert.equal([...oneShort].length, 3, '夹具：差一个字符的引文必须是 3 个字');
  const mentionLine = lineOf(CITATION, /^\s*\*.*只读一页/);
  assert.ok(mentionLine > 1, '夹具：提到这两个短语的注释行必须存在');
  const reference = `services/api/src/citation.ts:${mentionLine}`;
  const { findings, stats } = scanOnly({
    'services/api/src/citation.ts': CITATION,
    'docs/architecture/cite-at-threshold.md': `引用注释原文：「${atThreshold}」——\`services/api/src/citation.ts:${mentionLine}\`。\n`,
    'docs/architecture/cite-one-short.md': `引用注释原文：「${oneShort}」——\`services/api/src/citation.ts:${mentionLine}\`。\n`
  });
  assert.deepEqual(
    findings.filter(finding => finding.reason === NOT_SYMBOL_LINE).map(finding => finding.doc),
    ['docs/architecture/cite-one-short.md'],
    '4 字引文是「逐字引用注释文案」⇒ 豁免；3 字不够长 ⇒ 仍判红（门槛被改成 1 就会把 3 个字的短语也当成引文放行）'
  );
  assert.equal(
    findings.some(finding => finding.reason === NOT_SYMBOL_LINE && finding.reference === reference),
    true,
    '被判红的那条必须正是上面这一行（不是别的行凑数）'
  );
  assert.equal(stats.symbol.cited, 1, '恰好一条按「逐字引用注释文案」放行');
  assert.equal(stats.symbol.attached, 1, '差一个字符的那条必须落回「落在文档注释里」');
});

test('⑦ 引文归属：文档行只出现符号名（不是注释原文的子串）不构成豁免', () => {
  const mentionLine = lineOf(SYMBOL_ONLY, /^\s*\*.*不写库/);
  assert.ok(mentionLine > 1, '夹具：注释正文行必须存在');
  const docLine = `说明：\`listAccounts\` 落在这段 JSDoc 里也照样判红——\`services/api/src/symbol-only.ts:${mentionLine}\`。`;
  assert.ok(docLine.includes('listAccounts'), '夹具：文档行里必须出现符号名（这正是「宽松豁免」的诱因）');
  assert.equal(docLine.includes('只读账号目录'), false, '夹具：文档行不得包含注释原文，否则测的是「引文豁免」而不是「只提符号名」');
  const { findings, stats } = scanOnly({
    'services/api/src/symbol-only.ts': SYMBOL_ONLY,
    'docs/architecture/symbol-name-only.md': `${docLine}\n`
  });
  const flagged = findings.filter(finding => finding.reason === NOT_SYMBOL_LINE);
  assert.equal(
    flagged.length,
    1,
    '仅出现符号名不足以豁免：豁免的判据是「引文是注释块原文的子串」，不是「文档提到了这个符号」'
  );
  assert.equal(stats.symbol.cited, 0, '这一条不得被算成「逐字引用注释文案」');
});

test('⑧ 注释块与声明行之间 0／1／2 个空行仍算「紧贴声明」⇒ 判红', () => {
  const blank = blankLineFixture([0, 1, 2]);
  assert.deepEqual(blank.gaps, [0, 1, 2], '夹具：三块的空行数必须是 0／1／2（3 个以上属已知未定义区，刻意不钉）');
  const doc = blank.commentLines
    .map((line, index) => `块 ${'ABC'[index]} 的注释行（块后隔 ${blank.gaps[index]} 个空行）：\`services/api/src/blank-lines.ts:${line}\`。`)
    .join('\n');
  const { findings } = scanOnly({
    'services/api/src/blank-lines.ts': blank.text,
    'docs/architecture/blank-lines.md': `${doc}\n`
  });
  assert.deepEqual(
    referencesOf(findings, NOT_SYMBOL_LINE),
    blank.commentLines.map(line => `services/api/src/blank-lines.ts:${line}`).sort(),
    '0／1／2 个空行后面都是真声明行 ⇒ 三条都必须判红；把「允许空行」改成「遇空行即判定 detached」就会全部漏过去'
  );
});

test('⑨ 已知限制（有意留，待后续片）：相邻注释块让前块里的锚点判成 detached ⇒ 不判红', () => {
  const anchored = lineOf(ADJACENT, /^\s*\*.*前一个块/);
  assert.ok(anchored > 1, '夹具：前一个块的注释正文行必须存在');
  const { findings, stats } = scanOnly({
    'services/api/src/adjacent.ts': ADJACENT,
    'docs/architecture/adjacent-comments.md': `前一个块里的注释行：\`services/api/src/adjacent.ts:${anchored}\`。\n`
  });
  // 已知限制（非正确语义）：前块收尾后紧跟另一个注释块，「块后第一条非空行」是注释而不是声明，
  // 归属被判 comment-detached，闸门放行。真实实例在 `docs/` 下存在（相邻块 + 文档逐字引用）。
  // 这里只钉「当前行为 = 不判红」；后续片把相邻块一起处理时，这条要改成钉红。
  assert.deepEqual(referencesOf(findings, NOT_SYMBOL_LINE), [], '当前行为：不判红（已知限制，见文件头 ⑨）——不是「判对了」');
  assert.equal(stats.symbol.detached, 1, '它走的是 detached 这一档，不是 attached');
  assert.equal(stats.symbol.attached, 0, '不得被误算成「落在文档注释里」');
});
