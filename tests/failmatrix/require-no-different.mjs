/**
 * 真库臂（`tests/failmatrix/run-real.mjs`）`--require-no-different` 的**纯判定**与 FAIL 文案。
 *
 * 为什么单独成文件、而不是直接写在 `run-real.mjs` 里：那个文件的最后一行是顶层
 * `process.exitCode = await main();` —— 它一被 import 就会真起一个一次性 PG 17 簇。
 * 判据抽到这里，单测才能只测判据、绝不去碰数据库（见
 * `tests/unit/failmatrix-require-no-different.test.mjs`）。`run-real.mjs` 那侧既有的行
 * 一行都不许挪：`docs/verification/` 里有一批 `run-real.mjs:<行号>` 锚点按行号引用它。
 *
 * 语义（四格，与 `docs/verification/gy-r89-failmatrix-require-no-different-20261108.md` 一致）：
 *   · 开关**关**（缺省）+ `different > 0` ⇒ 0：既有行为逐字不变，退出码仍只由 `not_runnable` 决定；
 *   · 开关**关**（缺省）+ `different = 0` ⇒ 0；
 *   · 开关**开** + `different = 0` ⇒ 0（本开关不因为「没有差异」判红）；
 *   · 开关**开** + `different > 0` ⇒ 1，并往 stderr 打一行 FAIL（计数 + 最多 10 个用例 id）。
 * 两开关互不吞：本文件**从不读** `not_runnable` —— `--require-no-not-runnable` 的判据原封不动
 * 留在 `run-real.mjs` 主流程里。
 */

/**
 * `parseArgs()` 认的「`--require-no-*` 开关 → `opts` 字段名」映射。两个开关各占一个字段，互不覆盖。
 *
 * @param {string} arg 命令行参数
 * @returns {'requireNoDifferent' | 'requireNoNotRunnable'}
 */
export function requireFlagField(arg) {
  return arg === '--require-no-different' ? 'requireNoDifferent' : 'requireNoNotRunnable';
}

/**
 * `--require-no-different` 打开且 `different > 0` 时的那一行 FAIL 文案；不需要 FAIL 时返回 `null`
 * （开关关着、或 `different` 为 0 —— 判据本身在 `shouldFailOnDifferent()` 里再收一次口）。
 *
 * 用例 id 最多列 10 个，多了写「等 N 条」；N 是**实际条数**，不是被列出来的条数。
 *
 * @param {{ different?: number }} tally 汇总计数（只看 `different`）
 * @param {Array<{ id: string, verdict: string }>} [rows] 逐条读数，只用来取 `verdict === 'different'` 的 id
 * @returns {string | null}
 */
export function differentFailureMessage(tally, rows = []) {
  const different = Number(tally?.different ?? 0);
  if (!Number.isFinite(different) || different <= 0) return null;
  const ids = rows
    .filter((row) => row?.verdict === 'different')
    .map((row) => row.id);
  const shown = ids.slice(0, 10);
  const list = shown.length === 0
    ? '逐条读数里没有 DIFF 行：计数与读数不一致，先查这个'
    : `${shown.join('、')}${ids.length > shown.length ? ` 等 ${ids.length} 条` : ''}`;
  return `FAIL：--require-no-different 下有 ${different} 条 different（${list}）。different 不是通过：它表示真 PG 的实际与期望不一致；本开关把这类差异判成失败（关掉开关时退出码仍只由 not_runnable 决定）。`;
}

/**
 * 本开关的**全部**判据：只看 `opts.requireNoDifferent` 与 `tally.different`，不看 `not_runnable`
 * （两开关互不吞）。返回 1 时已经往 stderr 打过一行 FAIL —— 调用方不要再补文案。
 *
 * @param {{ requireNoDifferent?: boolean }} opts `parseArgs()` 的结果
 * @param {{ different?: number }} tally 汇总计数
 * @param {Array<{ id: string, verdict: string }>} [rows] 逐条读数（只用来列 FAIL 里的 id）
 * @returns {0 | 1} 1 = 因本开关判红
 */
export function shouldFailOnDifferent(opts, tally, rows = []) {
  if (opts?.requireNoDifferent !== true) return 0;
  const message = differentFailureMessage(tally, rows);
  if (message === null) return 0;
  console.error(`\n${message}`);
  return 1;
}
