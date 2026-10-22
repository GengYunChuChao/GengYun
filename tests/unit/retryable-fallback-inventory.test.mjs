// R31（#455 后两个已知缺口之二）· **全仓「兜底恒 `retryable: true`」清单与实况对账**。
//
// 缺口原文：`#455` 落地后，`services/api/src` 里仍有若干「确定性失败却声称可重试」的形状（写手在 #455 回报里
// 点名 synthesis/jobs 一类），但仓库里**没有任何清单**说得清它们在哪、有没有判据、该谁修。本文件把这份清单
// 变成受版本控制的 JSON（`tests/fixtures/retryable-fallbacks.json`），并让它与实况**逐条对账**。
//
// **时点**：清单里的读数是「基线已并入 `#455`（head `0eaf1bde`）」之后的世界 —— 32 处（`has` 31 / `none` 1）。
// `#455` 修掉了两处 admin/ops 兜底，清单因此少了 2 条 `none`；若把本片合到**不含** `#455` 的 main 上，
// 对账会红（那是精确匹配在按设计工作）⇒ 合并顺序要求：**先合 `#455`，再合本片**。
//
// 扫描范围（全仓口径）：
//   - `services/api/src/**/*.ts`（不含 `*.d.ts`）—— 错误封套的生产地；
//   - `miniprogram/**/utils/**/*.js` —— 小程序侧唯一会碰 `retryable` 的层。
//
// 清单条目形状（一条 = 一个站点）：
//   `{ file, line, function, judgement: 'has' | 'none', owner }`
//   - `judgement: 'has'`  = 这一处 `retryable` 有判据（计算表达式，或字面量 `true` 处于具名条件分支内）；
//   - `judgement: 'none'` = 纯兜底：catch 通道上裸 `retryable: true`，没有任何条件为它背书。
//   判据实现（⚠️ 唯一实现，别处不许重写）：`tests/unit/retryable-guard-scan.mjs` 的 `scanFallbackClaims`。
//   判据边界（不假装覆盖，证据页有专节）：只认 catch 通道 ⇒ 普通函数里无条件的 `{ retryable: true }`
//   （如 `media/service.ts` 的 `withKeyClaim` 幂等冲突分支）不在清单里；跨文件错误映射函数也不在
//   （映射函数必须与 catch 同文件）。
//
// 对账规则：**多一处少一处都红**。键是 `文件 + 函数 + 判据 + 序号`（⛔ 不含行号：业务代码上方插一行不该
// 让守卫红；行号只是定位提示，`GY_RETRYABLE_INVENTORY_UPDATE=1` 时重写）。
//
// 更新方式（只允许在**确认过每一处判定**之后跑）：
//   `GY_RETRYABLE_INVENTORY_UPDATE=1 node --test tests/unit/retryable-fallback-inventory.test.mjs`
// 更新会保留旧条目的 `owner`，新增条目按判据给默认责任片（`none` ⇒ `R31`，`has` ⇒ `GY-I22`）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanFallbackClaims } from './retryable-guard-scan.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'retryable-fallbacks.json');
const UPDATE = process.env.GY_RETRYABLE_INVENTORY_UPDATE === '1';

/** 扫描范围：目录 + 扩展名 + 「只看 utils 子目录」+ 防失效下界。 */
const SCOPES = [
  { dir: join(ROOT, 'services', 'api', 'src'), exts: ['.ts'], minFiles: 150 },
  { dir: join(ROOT, 'miniprogram'), exts: ['.js', '.mjs'], under: 'utils', minFiles: 20 },
];

function walk(dir, exts, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walk(path, exts, files);
    } else if (entry.isFile() && exts.some((ext) => entry.name.endsWith(ext)) && !entry.name.endsWith('.d.ts')) {
      files.push(path);
    }
  }
  return files;
}

function scanRepo() {
  const scanned = [];
  const claims = [];
  for (const scope of SCOPES) {
    let files = walk(scope.dir, scope.exts);
    if (scope.under !== undefined) {
      files = files.filter((path) => relative(scope.dir, path).split('\\').includes(scope.under));
    }
    scanned.push({ dir: relative(ROOT, scope.dir).split('\\').join('/'), files: files.length });
    for (const path of files.sort()) {
      const file = relative(ROOT, path).split('\\').join('/');
      claims.push(...scanFallbackClaims(file, readFileSync(path, 'utf8')));
    }
  }
  claims.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
  const counts = { total: claims.length, has: 0, none: 0 };
  for (const claim of claims) counts[claim.judgement] += 1;
  return { scanned, claims, counts };
}

/** 稳定键：文件 + 函数 + 判据 + 同组序号（⛔ 不含行号）。 */
function keysOf(records) {
  const seen = new Map();
  const keyed = new Map();
  for (const record of records) {
    const base = `${record.file}::${record.function}::${record.judgement}`;
    const ordinal = seen.get(base) ?? 0;
    seen.set(base, ordinal + 1);
    keyed.set(`${base}::${ordinal}`, record);
  }
  return keyed;
}

const label = (record) => `${record.file}:${record.line} ${record.function} [${record.judgement}]`;

function readFixture() {
  return JSON.parse(readFileSync(FIXTURE, 'utf8'));
}

function writeFixture(doc) {
  mkdirSync(dirname(FIXTURE), { recursive: true });
  writeFileSync(FIXTURE, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
}

test('清单范围非空（路径写错时不许静默通过）', () => {
  const { scanned, claims } = scanRepo();
  scanned.forEach((scope, index) => {
    const floor = SCOPES[index].minFiles;
    assert.ok(scope.files >= floor, `${scope.dir} 只扫到 ${scope.files} 个文件，疑似路径失配（下界 ${floor}）`);
  });
  assert.ok(claims.length > 0, '一个 catch 通道的 retryable 站点都没扫到，清单形同虚设');
});

test('清单与实际站点逐条一致（多一处少一处都红）', () => {
  const { scanned, claims, counts } = scanRepo();

  if (UPDATE) {
    // 首次生成时清单还不存在 ⇒ 视为空（不靠 try/catch 吞错：只在文件确实缺失时降级）。
    const previousEntries = existsSync(FIXTURE) ? readFixture().entries : [];
    const previous = keysOf(previousEntries);
    const entries = [...keysOf(claims).entries()].map(([key, claim]) => ({
      file: claim.file,
      line: claim.line,
      function: claim.function,
      judgement: claim.judgement,
      owner: previous.get(key)?.owner ?? (claim.judgement === 'none' ? 'R31' : 'GY-I22'),
    }));
    writeFixture({ version: 1, generatedBy: 'tests/unit/retryable-fallback-inventory.test.mjs', scanned, counts, entries });
    return;
  }

  const doc = readFixture();

  const expected = keysOf(claims);
  const actual = keysOf(doc.entries);

  for (const entry of doc.entries) {
    assert.equal(
      typeof entry.owner === 'string' && /^(GY-I\d+|R31)$/.test(entry.owner),
      true,
      `清单条目缺责任片（owner 须为 GY-Ixx 或 R31）：${entry.file} ${entry.function}`,
    );
    assert.equal(
      entry.judgement === 'has' || entry.judgement === 'none',
      true,
      `清单条目 judgement 非法（只允许 has/none）：${entry.file} ${entry.function}`,
    );
    assert.equal(
      Number.isInteger(entry.line) && entry.line > 0,
      true,
      `清单条目缺行号（定位提示，UPDATE 模式会自动重写）：${entry.file} ${entry.function}`,
    );
  }

  // 「少了哪一处 / 多了哪一处」先判：这是本清单唯一的日常信号，⛔ 不许被统计/范围类断言抢在前面。
  const missing = [...expected.keys()].filter((key) => !actual.has(key));
  const extra = [...actual.keys()].filter((key) => !expected.has(key));

  assert.deepEqual(
    missing.map((key) => label(expected.get(key))),
    [],
    '清单**少了**实际存在的站点：新增 catch 兜底（或给现有站点写入 `retryable: true`）后必须登记并写明判据，⛔ 不许当成没看见',
  );
  assert.deepEqual(
    extra.map((key) => label(actual.get(key))),
    [],
    '清单**多了**实际不存在的条目（站点被删/判据被改/函数改名？）：同步删条目，别让清单腐烂',
  );

  assert.deepEqual(
    doc.counts,
    counts,
    `清单统计与实况不一致：清单 ${JSON.stringify(doc.counts)}，实况 ${JSON.stringify(counts)}`,
  );
  // 范围只钉目录（文件数会随新增源码漂，且不影响判据），统计里已重写为实测值。
  assert.deepEqual(
    doc.scanned.map((scope) => scope.dir),
    scanned.map((scope) => scope.dir),
    '扫描范围与清单里登记的范围不一致（改范围请重跑 UPDATE 模式）',
  );

  // 行号只做提示：真漂了就在证据页留痕并重跑 UPDATE 模式，不在这里判红。
  const drifted = doc.entries.filter((entry) => {
    const key = [...actual.keys()].find((candidate) => actual.get(candidate) === entry);
    const current = key === undefined ? undefined : expected.get(key);
    return current !== undefined && current.line !== entry.line;
  });
  if (drifted.length > 0) {
    console.log(`[inventory] ${drifted.length} 条行号已漂移（不判红，需要时重跑 UPDATE 模式）：`);
    for (const entry of drifted) console.log(`  ${entry.file} 清单第 ${entry.line} 行`);
  }
});
