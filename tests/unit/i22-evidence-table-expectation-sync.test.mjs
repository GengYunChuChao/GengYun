/**
 * #22 证据表生成器的 `EXPECTED` 必须与用例表同源。
 *
 * ## 这条守卫补的空白
 *
 * `tools/i22-failmatrix-evidence-table.mjs` 的 `EXPECTED` 是**手抄快照**，而 `cases.mjs` /
 * `seams.mjs` / `mutations.mjs` 是会长的。四个 PR 陆续加了 `C5-11`/`C5-12`（媒体用途与声明类型）、
 * `C6-12`（带图发帖判 `INPUT_UNCERTAIN`）、`E3-01`/`E3-02`（后台内容写面的版本/引用门槛）之后，
 * 常量还停在 249（`C4: 21` / `C5: 10` / `C6: 11`，没有 `E3` 族、没有 `B7` 批次），于是：
 *
 *   - `node tools/i22-failmatrix-evidence-table.mjs` 拿真实 artifact 对账直接 exit 1
 *     （`总条数 期望 249 条，实际 269 条`、`族 C4 期望 21 条，实际 36 条`…），
 *     「#22 差证据」的闭环路径断在生成器这一步；
 *   - 而 CI 里没有任何东西会因此变红 —— 漂移是**静默**的。生成器自己的 `--write` 保护测的是写盘
 *     与归档页（`i22-failmatrix-evidence-table-guard.test.mjs` 用**按 EXPECTED 造出来的**夹具工件），
 *     它只能证明「工件与常量一致时能写」，证明不了「常量与用例表一致」。
 *
 * 这条测试补的就是后者：常量一改、用例一加，两边对不上就红。
 *
 * ## 口径
 *
 * 与生成器注释里写的三项相加口径完全一致：
 *   - `total` = `CASES.length` + `SEAM_CASES.length`（seam 行也是一行一条用例，`run.mjs` 把它们
 *     一起算进 `totals.total`）；
 *   - `families` / `batches` 是同一批行的分组计数，各自全集必须等于 `total`；
 *   - `negativeControls` = `MUTATIONS.length`。
 *
 * `EXPECTED` 从工具源码里按字面量读取（不 `import`：那个工具的末尾是 `process.exit(main(...))`，
 * 导入即执行 CLI），手法与 `i22-failmatrix-evidence-table-guard.test.mjs` 的 `readExpected()` 一致。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CASES, BATCHES, FAMILIES } from '../failmatrix/cases.mjs';
import { SEAM_CASES, SEAM_FAMILIES } from '../failmatrix/seams.mjs';
import { MUTATIONS } from '../failmatrix/mutations.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOOL = path.join(ROOT, 'tools', 'i22-failmatrix-evidence-table.mjs');

/** 从工具源码读 `EXPECTED` 字面量：只做「给裸键补引号 → JSON.parse」，不 eval 任何代码。 */
function readExpected() {
  const source = readFileSync(TOOL, 'utf8');
  const match = source.match(/const EXPECTED = Object\.freeze\((\{[\s\S]*?\n\})\);/);
  assert.ok(match, '工具里找不到 `const EXPECTED = Object.freeze({…});`：声明被重构了，本测试的读取逻辑需要同步');
  const quoted = match[1]
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
    .replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(quoted);
}

const ALL_CASES = [...CASES, ...SEAM_CASES];

/** 用例表普查：逐族、逐批、合计。生成器与测试必须对着同一份普查。 */
function census() {
  const families = {};
  for (const one of ALL_CASES) families[one.family] = (families[one.family] ?? 0) + 1;
  const batches = {};
  for (const batch of BATCHES) {
    batches[batch.id] = batch.families.reduce((sum, family) => sum + (families[family] ?? 0), 0);
  }
  return { families, batches, total: ALL_CASES.length };
}

test('证据表生成器的 EXPECTED 与用例表普查逐项一致（族 / 批次 / 总条数 / 负控制条数）', () => {
  const expected = readExpected();
  const actual = census();

  assert.equal(
    expected.total,
    actual.total,
    `总条数对不上：EXPECTED ${expected.total}、用例表 ${actual.total}（CASES ${CASES.length} + SEAM ${SEAM_CASES.length}）`,
  );
  assert.deepEqual(
    expected.families,
    actual.families,
    `逐族条数对不上（多了/少了/数错了都要改 EXPECTED）：EXPECTED ${JSON.stringify(expected.families)}、用例表 ${JSON.stringify(actual.families)}`,
  );
  assert.deepEqual(
    expected.batches,
    actual.batches,
    `逐批条数对不上：EXPECTED ${JSON.stringify(expected.batches)}、用例表 ${JSON.stringify(actual.batches)}`,
  );
  assert.equal(
    expected.negativeControls,
    MUTATIONS.length,
    `负控制条数对不上：EXPECTED ${expected.negativeControls}、mutations.mjs ${MUTATIONS.length}`,
  );

  // 分组计数必须真的铺满总数：族求和、批求和各自等于 total，否则「一致」也可能是两个都算错。
  assert.equal(Object.values(actual.families).reduce((a, b) => a + b, 0), actual.total, '逐族求和 ≠ 总条数：有行没归族');
  assert.equal(Object.values(actual.batches).reduce((a, b) => a + b, 0), actual.total, '逐批求和 ≠ 总条数：有行没进批次');
});

test('用例表自身的分组完整性：每个族都有说明、都进且只进一个批次、id 唯一', () => {
  const actual = census();
  const described = { ...FAMILIES, ...SEAM_FAMILIES };

  for (const family of Object.keys(actual.families)) {
    assert.ok(described[family], `族 ${family} 没有说明文字（FAMILIES / SEAM_FAMILIES 里找不到）`);
  }
  for (const family of Object.keys(described)) {
    assert.ok(actual.families[family] > 0, `族 ${family} 有说明但一条用例都没有：说明与用例表已经脱节`);
  }

  const owners = new Map();
  for (const batch of BATCHES) {
    for (const family of batch.families) {
      assert.equal(owners.has(family), false, `族 ${family} 同时挂在批次 ${owners.get(family)} 与 ${batch.id} 上`);
      owners.set(family, batch.id);
    }
  }
  for (const family of Object.keys(actual.families)) {
    assert.ok(owners.has(family), `族 ${family} 没进任何批次（生成器的逐批对账会漏掉它）`);
  }

  const ids = ALL_CASES.map((one) => one.id);
  assert.equal(new Set(ids).size, ids.length, '用例 id 有重复：矩阵里会出现两条同名读数');
});
