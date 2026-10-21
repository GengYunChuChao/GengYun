// R28-S92 · 真库脚本「本片迁移必须是末位」判据的**仓库级静态守卫**。
//
// 为什么需要它（同一类判据把 main 弄红过两次，`#341` / `#347` 各修一次）：
//
//   - `tests/integration/ocr-jobs-pg.mjs:256`（`#331` 引入）曾写：
//       assert.equal(names[names.length - 1], MIGRATION, `本片迁移必须是当前末位（现场 …）`);
//   - `tests/integration/recognitions-pg.mjs:280`（`#333` 引入）曾写：
//       assert.equal(names[names.length - 1], MIGRATION, `${MIGRATION} 必须是当前最后一条（本片新增的就是末位）`);
//
// 这两条判据把「本片迁移」钉在迁移目录的**末位**上，于是跨 PR 互斥：0025 一落 main，先合的那条
// 就必红（run `39431803337`：`本片迁移必须是当前末位（现场 0025_recognitions_persistence.sql）`），
// 谁后合谁红。`#341` / `#347` 采用的正确形态是**与位置无关**的三条结构不变量：
//
//   ① 版本序列 `1..max` 连续无缺号；② `MIGRATION_COUNT === LAST_VERSION_NUMBER`；③ 清单必须含 `MIGRATION`。
//
// 这三种不变量对「新增迁移」自动放行（新增 0026 只是把 max 变大、count 同步变大），对「发现器静默
// 漏项／编号错位」变红。本文件把这个口径变成可执行的清单，扫面是 `tests/integration/*.mjs` 全部文件。
//
// 三类要抓的形态（命中即红，逐条打印 `文件:行` 与命中原文）：
//
//   D1 `last-index`：取末位索引参与断言 —— `names[names.length - 1]`、`files[files.length - 1]`、
//      `x[x.length - 1]`（空格写不写都算）。**故意不加「迁移上下文」过滤**：`applied[applied.length - 1]`
//      这类判据的同一行里往往一个「迁移」字都没有，加了关键词过滤就会漏。宁可让下一个
//      `rows[rows.length - 1]` 也来登记一次豁免，也不要放过真 pin。
//   D2 `last-value`：取末位值 —— `.at(-1)` / `.slice(-1)` / `.pop()`，**并且**该命中所在的**断言语句**
//      里出现迁移词（`MIGRATION` / `migration` / `迁移`）。断言语句的边界是「最近的 `assert` 行 → 以
//      `);` 收尾的那一行」，所以多行排版的断言也被覆盖，而不用 ±N 行的模糊窗口（按行窗口会因为
//      相邻行里一条 `db/migrations/xxx.sql` 路径就把路由断言误判进来，实测踩过）。
//      为什么这里要加迁移词过滤：`routes.at(-1)` / `f.requests.at(-1)` 在本仓有 9 处正当代码，全是
//      路由与调用记录的末项，不加过滤就得登记 9 条噪音豁免，豁免一多守卫就会被「顺手加一条」拖垮。
//   D3 `last-wording`：文案判据 —— 字符串里出现 `必须是当前末位` / `必须是当前最后一条` /
//      `必须是最后一条迁移`。不加过滤：这句话要么是 pin 的失败消息，要么是「为什么不再这样断言」
//      的禁止性注释（现在 `ocr-jobs-pg.mjs` / `recognitions-pg.mjs` 各有一条），后者必须登记豁免。
//
// 豁免清单 `ALLOW` **逐条写理由**，而且**反向也断言**：豁免条目没有命中任何一处 ⇒ 同样判红
// （「白名单不会腐烂」）——删掉被豁免的注释或改掉被豁免的表达式文本时，必须同步删条目。
//
// 本文件只钉**结构**（谁在读迁移清单的末位），不连数据库、不跑迁移；行为断言留在各真库脚本里。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCAN_DIR = join(ROOT, 'tests', 'integration');

/** 取末位索引：`<anything>[<anything>.length - 1]`，空格可有可无。 */
const LAST_INDEX = /\[[^\[\]\n]*\.length\s*-\s*1\s*\]/;
/** 取末位值：`.at(-1)` / `.slice(-1)` / `.pop()`（后者单独一类，避免与 `.at()` 混在一条正则里）。 */
const LAST_VALUE = [/\.at\(\s*-1\s*\)/, /\.slice\(\s*-1\s*\)/, /\.pop\(\s*\)/];
/** 文案判据：三个短语各自可定位，报告里能写出命中的是哪一个。 */
const LAST_WORDING = [
  { phrase: '必须是当前末位', pattern: /必须是当前末位/ },
  { phrase: '必须是当前最后一条', pattern: /必须是当前最后一条/ },
  { phrase: '必须是最后一条迁移', pattern: /必须是最后一条迁移/ },
];

/** `assert`（含 `assert.equal` / `assert.ok` / `assert.match` …）：断言的起点。 */
const ASSERTION_CONTEXT = /\bassert\b/;
/** 迁移词：`MIGRATION` / `migration` / 「迁移」。只有 D2 用它压噪音，D1/D3 不用。 */
const MIGRATION_CONTEXT = /MIGRATION|migration|迁移/;
/** 断言语句的收尾：以 `);` 结束的行（多行排版的 assert 最后一行也是这个形状）。 */
const ASSERTION_END = /\)\s*;\s*$/;
/** 找断言起点最多回溯几行、找收尾行最多前进几行（只是上限，不是「上下文窗口」）。 */
const CONTEXT_LINES = 2;

/**
 * 豁免清单：受控范围内**允许**出现的命中，逐条写清「为什么它不是迁移末位判据」。
 *
 * 字段：`file`（`tests/integration/` 下的文件名）、`category`（D1/D2/D3 的类别名）、
 * `pattern`（对**命中行 trim 后**的文本求匹配；必须窄到不会覆盖另一处代码）、`why`（理由）。
 *
 * 条目未被命中 ⇒ 本条测试同样判红：改表达式文本、删注释之后必须同步删条目。
 */
const ALLOW = [
  {
    file: 'account-suspend-pg.mjs',
    category: 'last-index',
    pattern: /目录最大号 \$\{versions\[versions\.length - 1\]\} 与本脚本无关/,
    why: 'note() 的字符串插值：只是把迁移目录的「最大号」打印进日志，紧接着写的就是「与本脚本无关」。'
      + '本脚本的 setup 只应用 0001–0017（`name < MIGRATION` 过滤），与目录最大号解耦，不参与任何断言。',
  },
  {
    file: 'account-suspend-pg.mjs',
    category: 'last-index',
    pattern: /assert\.equal\(applied\[applied\.length - 1\], '0017'/,
    why: '断言的是**本脚本自己 setup 的固定窗口**末项，不是迁移目录末位：`applied` 由「所有 < 0017 的版本」'
      + '再手动 push 0017 构成，上一行的 deepEqual 已把 0001–0017 逐项钉住；目录再加 0018+ 也还是 0001–0017，'
      + '恒真不会随新迁移变红。属冗余断言（可后续切片删掉），不是末位判据。',
  },
  {
    file: 'admin-accounts-read-pg.mjs',
    category: 'last-index',
    pattern: /目录最大号 \$\{versions\[versions\.length - 1\]\}，现算/,
    why: 'note() 的字符串插值：打印迁移目录最大号（且注明「现算」），让真库日志能看出当时目录里到哪一号；'
      + '不参与断言，也不与 MIGRATION 比较。',
  },
  {
    file: 'admin-flags-pg.mjs',
    category: 'last-index',
    pattern: /最大号 \$\{versions\[versions\.length - 1\]\}/,
    why: 'note() 的消息模板参数：把目录最大号写进「与 discoverMigrations() 逐项一致」的日志行；'
      + '是字符串内容，不是断言左值。',
  },
  {
    file: 'messages-pg.mjs',
    category: 'last-index',
    pattern: /末项 \$\{versions\[versions\.length - 1\]\}/,
    why: 'note() 的字符串插值：打印「末项 = 目录最大号」供人读；同一条 note 的正题是「版本号无重复且严格递增」，'
      + '不含「本片迁移必须是末位」这类判据。',
  },
  {
    file: 'ocr-jobs-pg.mjs',
    category: 'wording',
    pattern: /^\/\/ ⛔ 这里\*\*不再\*\*断言「本片迁移必须是当前末位」/,
    why: '禁止性注释（`#341` 的修复说明）：它写的正是「这里不再这样断言」，并记下 run 39431803337 的红字原文。'
      + '注释不可能成为判据，登记它只是为了让「这句话为什么还出现在文件里」有据可查。',
  },
  {
    file: 'ocr-jobs-pg.mjs',
    category: 'wording',
    pattern: /^\/\/\s+（run 39431803337/,
    why: '同上一条注释的第 4 行：引用 CI run 号与当年的失败消息原文，属于事故留痕，不是判据。',
  },
  {
    file: 'recognitions-pg.mjs',
    category: 'wording',
    pattern: /^\/\/ ⛔ 这里\*\*不再\*\*断言「本片迁移必须是当前末位」/,
    why: '禁止性注释（`#347` 的修复说明）：说明「0001..0025 是本片现状，后续切片必然追加更大版本号」，'
      + '正是本条判据被解除的理由。注释不是判据。',
  },
];

/**
 * 取命中行所在的**断言语句**文本；命中不在任何断言语句里 ⇒ `null`。
 *
 * 规则（只为 D2 服务）：往回最多 `CONTEXT_LINES` 行找最近的 `assert` 当语句起点；单行断言到此为止，
 * 多行断言则往后最多 `CONTEXT_LINES` 行，一直到以 `);` 收尾的那一行。起点与命中之间若已经出现
 * 以 `);` 收尾的行，说明那是**上一条**已经结束的断言，命中不属于任何断言语句。
 *
 * @param {string[]} lines 源码按行切分的结果
 * @param {number} index 命中行下标
 * @returns {string|null}
 */
function assertionStatement(lines, index) {
  const floor = Math.max(0, index - CONTEXT_LINES);
  let start = -1;
  for (let i = index; i >= floor; i -= 1) {
    if (ASSERTION_CONTEXT.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  if (start === index) {
    if (ASSERTION_END.test(lines[index])) return lines[index];
  } else {
    for (let i = start; i < index; i += 1) if (ASSERTION_END.test(lines[i])) return null;
  }
  const ceiling = Math.min(lines.length - 1, index + CONTEXT_LINES);
  let end = index;
  for (let i = index; i <= ceiling; i += 1) {
    end = i;
    if (ASSERTION_END.test(lines[i])) break;
  }
  return lines.slice(start, end + 1).join('\n');
}

/**
 * 在内存里检测一段文本（夹具与真实文件共用同一套判据）。
 *
 * @param {string} source 源码文本
 * @param {{ file?: string }} [options] 仅用于读数定位
 * @returns {Array<{ file: string, line: number, category: string, text: string, phrase?: string }>}
 */
function detectHits(source, { file = '<memory>' } = {}) {
  const lines = source.split(/\r?\n/);
  const hits = [];
  lines.forEach((line, index) => {
    const statement = assertionStatement(lines, index);
    const migrationAssertion = statement !== null && MIGRATION_CONTEXT.test(statement);

    if (LAST_INDEX.test(line)) {
      hits.push({ file, line: index + 1, category: 'last-index', text: line.trim() });
    }

    const valueForm = LAST_VALUE.find((pattern) => pattern.test(line));
    if (valueForm && migrationAssertion) {
      hits.push({ file, line: index + 1, category: 'last-value', text: line.trim() });
    }

    const wording = LAST_WORDING.find((entry) => entry.pattern.test(line));
    if (wording) {
      hits.push({ file, line: index + 1, category: 'wording', text: line.trim(), phrase: wording.phrase });
    }
  });
  return hits;
}

/**
 * 扫描 `dir` 顶层的全部 `.mjs`。
 *
 * 「什么都没扫到」与「扫到了但一行断言都没有」都必须抛错：否则守卫会因为扫了个空目录而变绿。
 */
function scanDirectory(dir) {
  const files = readdirSync(dir).filter((name) => name.endsWith('.mjs')).sort();
  if (files.length === 0) {
    throw new Error(`扫描面为空：${dir} 下没有任何 .mjs —— 拒绝在「什么都没扫到」的情况下变绿`);
  }
  const hits = [];
  let lineCount = 0;
  let assertionLineCount = 0;
  for (const file of files) {
    const text = readFileSync(join(dir, file), 'utf8');
    const lines = text.split(/\r?\n/);
    lineCount += lines.length;
    assertionLineCount += lines.filter((line) => ASSERTION_CONTEXT.test(line)).length;
    hits.push(...detectHits(text, { file }));
  }
  if (lineCount === 0) {
    throw new Error(`解析出 0 行：${dir}（扫描面可能是空文件集合）`);
  }
  if (assertionLineCount === 0) {
    throw new Error(`解析出的断言行数为 0：${dir} —— 扫描面里已经没有真库脚本了，守卫会假绿`);
  }
  return { files, hits, lineCount, assertionLineCount };
}

/** 命中分派：返回「未登记」与「已失效豁免」两个清单，都必须是空的。 */
function triage(hits, allow) {
  const violations = [];
  const used = new Set();
  for (const hit of hits) {
    const index = allow.findIndex(
      (entry) => entry.file === hit.file && entry.category === hit.category && entry.pattern.test(hit.text),
    );
    if (index === -1) violations.push(hit);
    else used.add(index);
  }
  const stale = allow.filter((_, index) => !used.has(index));
  return { violations, stale };
}

const describeHit = (hit) => `tests/integration/${hit.file}:${hit.line} [${hit.category}] ${hit.text}`;

/** 正确形态的三条结构不变量（与 `#341`/`#347` 落地后的写法等价），用来证明 f5 是「可绿的形态」。 */
function invariantProblems(versions) {
  const problems = [];
  const max = Math.max(...versions);
  const seen = new Set(versions);
  const missing = [];
  for (let version = 1; version <= max; version += 1) if (!seen.has(version)) missing.push(version);
  if (missing.length > 0) problems.push(`版本 1..${max} 缺号：${missing.join(',')}`);
  if (new Set(versions).size !== versions.length) problems.push('版本号有重复');
  if (versions.length !== max) problems.push(`迁移总数 ${versions.length} ≠ 最大版本号 ${max}`);
  return problems;
}

// ---------------------------------------------------------------------------
// 0. 扫描面：文件数、行数、以及「真的看见了历史两站点」
// ---------------------------------------------------------------------------
test('扫描面是 tests/integration/*.mjs 的全部文件，且必须真的看见历史两站点', () => {
  const { files, lineCount, assertionLineCount } = scanDirectory(SCAN_DIR);
  console.log(`[scan] 文件 ${files.length} 个（实测，不写死数量），行 ${lineCount} 行，断言行 ${assertionLineCount} 行`);
  assert.ok(files.length > 30, `扫描面只剩 ${files.length} 个 .mjs（期望 > 30）：扫描面或目录结构变了`);
  assert.ok(lineCount > 0, '扫到 0 行');
  assert.ok(assertionLineCount > 0, '扫到的文件里一行 assert 都没有：守卫会假绿');
  for (const name of ['ocr-jobs-pg.mjs', 'recognitions-pg.mjs']) {
    assert.ok(files.includes(name), `扫描面必须含 ${name}（两次事故的现场）`);
  }
});

// ---------------------------------------------------------------------------
// 1. 主断言：现存脚本里没有未登记的「迁移末位」判据
// ---------------------------------------------------------------------------
test('现存 tests/integration/*.mjs 里没有未登记的「迁移末位」判据', () => {
  const { files, hits } = scanDirectory(SCAN_DIR);
  const { violations, stale } = triage(hits, ALLOW);

  console.log(`[scan] 文件 ${files.length} 个；命中 ${hits.length} 条；豁免 ${ALLOW.length} 条；未登记 ${violations.length} 条；失效豁免 ${stale.length} 条`);
  for (const hit of hits) {
    const allowed = !violations.includes(hit);
    console.log(`  ${allowed ? '[allow]' : '[NEW  ]'} ${describeHit(hit)}`);
  }

  assert.deepEqual(
    violations.map(describeHit),
    [],
    `发现未登记的「迁移末位」判据（命中原文见下）：\n${violations.map((hit) => `  ${describeHit(hit)}`).join('\n')}`,
  );
  assert.deepEqual(
    stale.map((entry) => `${entry.file} ${entry.category} ${entry.pattern}`),
    [],
    '豁免清单里有条目没命中任何一处（陈旧豁免，删掉它以免守卫躺平）',
  );
});

// ---------------------------------------------------------------------------
// 2. 五条内存夹具：f1–f4 必红在预期断言上，f5 正控制必绿
// ---------------------------------------------------------------------------
// f1 / f2 是**从 git 历史里抄回来的原文**（`622448d^` 与 `74ca5e8^`，逐字节一致）。
const F1 = '  assert.equal(names[names.length - 1], MIGRATION, `本片迁移必须是当前末位（现场 ${names[names.length - 1]}）`);';
const F2 = '  assert.equal(names[names.length - 1], MIGRATION, `${MIGRATION} 必须是当前最后一条（本片新增的就是末位）`);';

test('f1（#341 改前的写法）必须红在 last-index 与 wording 上', () => {
  const hits = detectHits(F1, { file: 'f1' });
  console.log(`[f1] ${hits.length} 条：${hits.map((hit) => `${hit.line}:${hit.category}`).join(', ')}`);
  assert.ok(hits.some((hit) => hit.category === 'last-index'), 'f1 未被 last-index 抓住');
  assert.ok(hits.some((hit) => hit.category === 'wording' && hit.phrase === '必须是当前末位'), 'f1 未被 wording 抓住');
  assert.equal(hits[0].line, 1, 'f1 必须定位到第 1 行');
});

test('f2（#347 改前的写法）必须红在 last-index 与 wording 上', () => {
  const hits = detectHits(F2, { file: 'f2' });
  console.log(`[f2] ${hits.length} 条：${hits.map((hit) => `${hit.line}:${hit.category}`).join(', ')}`);
  assert.ok(hits.some((hit) => hit.category === 'last-index'), 'f2 未被 last-index 抓住');
  assert.ok(hits.some((hit) => hit.category === 'wording' && hit.phrase === '必须是当前最后一条'), 'f2 未被 wording 抓住');
});

test('f3（.at(-1) 版本）必须红在 last-value 上', () => {
  const source = [
    '  // 迁移三连：结构不变量（本片新增迁移 0026 后必须仍成立）',
    '  const names = discovered.map((migration) => migration.filename);',
    '  assert.equal(names.at(-1), MIGRATION, `本片迁移必须是当前末位（现场 ${names.at(-1)}）`);',
  ].join('\n');
  const hits = detectHits(source, { file: 'f3' });
  console.log(`[f3] ${hits.length} 条：${hits.map((hit) => `${hit.line}:${hit.category}`).join(', ')}`);
  assert.ok(
    hits.some((hit) => hit.category === 'last-value' && hit.line === 3),
    'f3 未被 last-value 抓住（第 3 行）',
  );
});

test('f4（.slice(-1)[0] 与 .pop() 版本）必须红在 last-value 上', () => {
  const source = [
    "  assert.deepEqual(names.slice(-1), [MIGRATION], '本片迁移必须是当前末位');",
    '  assert.equal(names.pop(), MIGRATION, `本片迁移必须是当前末位（弹出的是最后一条迁移）`);',
  ].join('\n');
  const hits = detectHits(source, { file: 'f4' });
  console.log(`[f4] ${hits.length} 条：${hits.map((hit) => `${hit.line}:${hit.category}`).join(', ')}`);
  for (const line of [1, 2]) {
    assert.ok(
      hits.some((hit) => hit.category === 'last-value' && hit.line === line),
      `f4 第 ${line} 行未被 last-value 抓住`,
    );
  }
});

test('f5（正控制：正确形态）必须 0 命中，且对「新增 0026」自动放行', () => {
  const source = [
    '  const discovered = discoverMigrations();',
    '  const numbers = discovered.map((migration) => Number(migration.version));',
    '  const max = Math.max(...numbers);',
    '  const missing = [];',
    '  for (let expected = 1; expected <= max; expected += 1) {',
    "    if (!numbers.includes(expected)) missing.push(String(expected).padStart(4, '0'));",
    '  }',
    '  assert.deepEqual(missing, [], `迁移版本号必须在 1..${max} 上连续无缺号`);',
    '  assert.equal(discovered.length, max, `迁移总数必须等于最大版本号（count=${discovered.length}，max=${max}）`);',
    '  const names = discovered.map((migration) => migration.filename);',
    '  assert.ok(names.includes(MIGRATION), `迁移清单必须含 ${MIGRATION}`);',
  ].join('\n');
  const hits = detectHits(source, { file: 'f5' });
  console.log(`[f5] ${hits.length} 条命中（期望 0）`);
  assert.deepEqual(hits.map(describeHit), [], 'f5 是正确形态，检测器不该命中它');

  const versions = Array.from({ length: 26 }, (_, index) => index + 1);
  assert.deepEqual(invariantProblems(versions), [], '0001..0026 连续无缺号、count === max，必须判绿');
  assert.notDeepEqual(invariantProblems([1, 2, 4]), [], '缺 0003 必须判红');
  assert.notDeepEqual(invariantProblems([1, 2, 2]), [], '版本号重复必须判红');
  assert.notDeepEqual(invariantProblems([1, 2, 3, 3]), [], '重复 + count ≠ max 必须判红');
});

// ---------------------------------------------------------------------------
// 3. 自检：把两次事故的修前原文喂进去，必须被抓（这就是守卫存在的理由）
// ---------------------------------------------------------------------------
test('自检：把 #341 / #347 修前的原文喂进去，两段都必须被抓', () => {
  const cases = [
    {
      label: '#341（ocr-jobs-pg.mjs:256，622448d 之前）',
      source: F1,
      wording: '必须是当前末位',
    },
    {
      label: '#347（recognitions-pg.mjs:280，74ca5e8 之前）',
      source: F2,
      wording: '必须是当前最后一条',
    },
  ];
  for (const item of cases) {
    const hits = detectHits(item.source, { file: item.label });
    const categories = hits.map((hit) => hit.category);
    console.log(`[history] ${item.label} ⇒ ${categories.join(', ')}`);
    assert.ok(categories.includes('last-index'), `${item.label} 必须被 last-index 抓住`);
    assert.ok(
      hits.some((hit) => hit.category === 'wording' && hit.phrase === item.wording),
      `${item.label} 必须被 wording「${item.wording}」抓住`,
    );
    // 红字必须带得出原文，否则下一任作者只看到「有一条命中」却不知道命中了什么。
    assert.ok(
      hits.some((hit) => hit.text === item.source.trim()),
      `${item.label} 的命中行必须原样回显原文`,
    );
  }
});

test('文案判据的三个短语各自可达（含现存代码里还没有出现的那一个）', () => {
  const phrases = ['必须是当前末位', '必须是当前最后一条', '必须是最后一条迁移'];
  for (const phrase of phrases) {
    const hits = detectHits(`  assert.ok(ok, '本片迁移${phrase}');`, { file: 'phrase' });
    assert.ok(
      hits.some((hit) => hit.category === 'wording' && hit.phrase === phrase),
      `文案判据抓不到「${phrase}」`,
    );
  }
});

// ---------------------------------------------------------------------------
// 4. 判据边界：D1 不过滤空格写法；D2 只放行「非迁移」的末值断言
// ---------------------------------------------------------------------------
test('D1 对空格写法都要命中，且不该漏掉无空格的紧凑写法', () => {
  const variants = [
    'assert.equal(names[names.length - 1], MIGRATION);',
    'assert.equal(names[names.length-1], MIGRATION);',
    'assert.equal(files[files.length -1], MIGRATION);',
    'assert.equal(x[x.length - 1], MIGRATION);',
  ];
  for (const line of variants) {
    const hits = detectHits(`  ${line}`, { file: 'variant' });
    assert.ok(hits.some((hit) => hit.category === 'last-index'), `D1 漏掉了：${line}`);
  }
});

test('D2 的上下文过滤：迁移末值必抓，路由/调用记录的末值不误报', () => {
  const migrationScoped = detectHits('  assert.equal(names.at(-1), MIGRATION, `首条迁移不是本片迁移`);', { file: 'd2a' });
  assert.equal(migrationScoped.filter((hit) => hit.category === 'last-value').length, 1, '迁移末值必须被抓');

  const routing = detectHits("  assert.equal(routes.at(-1), '/pages/login/login');", { file: 'd2b' });
  assert.equal(routing.length, 0, `路由末项不该命中：${routing.map(describeHit).join(', ')}`);

  const nonAssert = detectHits('  const last = discovered.at(-1);', { file: 'd2c' });
  assert.equal(nonAssert.length, 0, '非断言上下文不该命中');
});

// ---------------------------------------------------------------------------
// 5. 守卫自身的反向断言：扫不到文件 / 解析出 0 断言行都必须红
// ---------------------------------------------------------------------------
test('守卫自身反向断言：空目录与「没有断言行」的目录都必须抛错', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'gy-migration-pin-guard-'));
  try {
    assert.throws(() => scanDirectory(scratch), /扫描面为空/, '空目录必须抛错，不能静默变绿');
    writeFileSync(join(scratch, 'no-assert.mjs'), 'export const nothing = 1;\n', 'utf8');
    assert.throws(() => scanDirectory(scratch), /断言行数为 0/, '没有断言的目录必须抛错');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
