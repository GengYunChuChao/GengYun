/**
 * `SYMBOL-COVERAGE`（WARN 级「符号覆盖」统计）的守卫。
 *
 * 缺口（为什么需要这个文件）：`--symbol=strict` 只判「锚点行是不是代码行」，
 * 不证明同一行写着的符号名**还在那个文件里、且还落在锚点区间**。于是文档里
 * `` `services/api/src/app.ts:2508` 的 `ocrPersistencePool` ``（真实声明在 2546 行）
 * 照样全绿——行号落进了别的函数体，符号名却继续被当成「实现就在这几行」的证据。
 * `tools/verify-doc-anchors.mjs` 新增的 `collectSymbolCoverage()` 就是补这个洞的读数。
 *
 * 本文件钉住四件事（缺任一条，这条新判据都可能退化成「扫了个寂寞」或「永远红」）：
 *   ① 符号命中且覆盖锚点 ⇒ `OK`（不能把正常写法判成问题）；
 *   ② 符号在目标文件里 0 命中 ⇒ `NOT_FOUND`；
 *   ③ 符号命中但落在锚点区间外 ⇒ `OUT_OF_RANGE`；
 *   ④ 同一行没有紧邻符号 ⇒ **不配对**（配对口径收紧的代价必须显式计数，不许静默少扫）。
 * 另外用子进程钉住「缺省 `count` 模式不改变退出码」：这条判据是 WARN，先观察一轮，
 * 只有显式 `--symbol-coverage=strict`（且 `--strict`）才会判红。
 *
 * 全部用 `os.tmpdir()` 下的临时仓库夹具，⛔ 不依赖仓内真实文档的当期数字、不联网、
 * 不写仓库内文件。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SYMBOL_COVERAGE_ADJACENCY,
  SYMBOL_COVERAGE_LIST_SEPARATORS,
  SYMBOL_COVERAGE_NOT_FOUND,
  SYMBOL_COVERAGE_OK,
  SYMBOL_COVERAGE_OUT_OF_RANGE,
  SYMBOL_COVERAGE_SLACK,
  collectSymbolCoverage,
  main,
} from '../../tools/verify-doc-anchors.mjs';

/** 仓库根：由本文件位置推出（tests/unit/ → ../..），⛔ 不用 `process.cwd()`。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TOOL = join(REPO_ROOT, 'tools', 'verify-doc-anchors.mjs');

/**
 * 建临时仓库夹具并跑完就删。
 * `files` 的键是仓库相对路径（POSIX 分隔），值是内容；父目录不存在会自动建。
 */
function withFixture(files, body) {
  const root = mkdtempSync(join(tmpdir(), 'gy-symbol-coverage-'));
  try {
    for (const [relative, content] of Object.entries(files)) {
      const absolute = join(root, ...relative.split('/'));
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, content, 'utf8');
    }
    return body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** 只扫架构面的覆盖读数：作用域固定 `docs/architecture/**`，其余面只计数。 */
function coverageOf(root) {
  return collectSymbolCoverage({ root, targets: ['docs/architecture'] });
}

/** 一行源码里 `name` 声明在第 `line` 行（其余行留空，方便把命中与「区间」错开）。 */
function sourceWith(name) {
  return `export function ${name}(count) {\n  return count + 1;\n}\n`;
}

test('C1 符号命中且声明块覆盖锚点区间 ⇒ OK（正常写法不许被判成问题）', () => {
  withFixture(
    {
      'services/api/src/alpha.ts': sourceWith('alphaHandler'),
      // 锚点 :2 落在 alphaHandler 的块体（1-3 行）里 ⇒ 覆盖成立。
      'docs/architecture/covered.md': '# 覆盖\n\n- `alphaHandler`（`services/api/src/alpha.ts:2`）只做加一。\n',
    },
    root => {
      const { judged, misses } = coverageOf(root);
      assert.equal(judged.paired, 1, '同一行里「符号 + 紧邻锚点」必须配成一对');
      assert.equal(judged.ok, 1);
      assert.equal(judged.notFound, 0);
      assert.equal(judged.outOfRange, 0);
      assert.deepEqual(misses, [], 'OK 的配对不进明细');
    },
  );
});

test('C2 符号在目标文件里 0 命中 ⇒ NOT_FOUND（改了名/删了实现必须看得见）', () => {
  withFixture(
    {
      'services/api/src/alpha.ts': sourceWith('alphaHandler'),
      'docs/architecture/missing.md': '# 缺失\n\n- `ghostHandler`（`services/api/src/alpha.ts:2`）已经不存在。\n',
    },
    root => {
      const { judged, misses } = coverageOf(root);
      assert.equal(judged.paired, 1);
      assert.equal(judged.notFound, 1);
      assert.equal(judged.ok, 0);
      assert.equal(misses.length, 1);
      assert.equal(misses[0].symbol, 'ghostHandler');
      assert.equal(misses[0].result, SYMBOL_COVERAGE_NOT_FOUND);
    },
  );
});

test('C3 符号命中但不在锚点区间 ⇒ OUT_OF_RANGE（行号漂走的正是这个形状）', () => {
  // betaHandler 声明在第 1 行（块 1-3），文档却把锚点写到 :30：符号在文件里找得到，但不在那几行。
  const padding = '// 留白\n'.repeat(40);
  withFixture(
    {
      'services/api/src/beta.ts': `${sourceWith('betaHandler')}${padding}`,
      'docs/architecture/drifted.md': '# 漂移\n\n- `betaHandler`（`services/api/src/beta.ts:30`）在这里。\n',
    },
    root => {
      const { judged, misses } = coverageOf(root);
      assert.equal(judged.paired, 1);
      assert.equal(judged.outOfRange, 1);
      assert.equal(judged.notFound, 0);
      assert.equal(misses.length, 1);
      assert.equal(misses[0].result, SYMBOL_COVERAGE_OUT_OF_RANGE);
    },
  );
});

test('C4 同一行没有符号 ⇒ 不配对（只数进「同行没有紧邻符号」，不当判据）', () => {
  withFixture(
    {
      'services/api/src/alpha.ts': sourceWith('alphaHandler'),
      'docs/architecture/anchor-only.md': '# 只有锚点\n\n- 实现见 `services/api/src/alpha.ts:2`，另有说明 `见上文`。\n',
    },
    root => {
      const { judged, misses } = coverageOf(root);
      assert.equal(judged.anchors, 1, '锚点本身要计数（否则「没配对」和「没扫到」分不清）');
      assert.equal(judged.paired, 0);
      assert.equal(judged.unpaired, 1);
      assert.deepEqual(misses, []);
    },
  );
});

test('C5 符号离锚点太远（> 相邻上限）⇒ 不配对，宁可少扫也不猜', () => {
  const filler = '这一行先说别的：'.repeat(3); // 远超 SYMBOL_COVERAGE_ADJACENCY 个字符
  withFixture(
    {
      'services/api/src/alpha.ts': sourceWith('alphaHandler'),
      'docs/architecture/far.md': `# 太远\n\n- \`alphaHandler\` ${filler}\`services/api/src/alpha.ts:2\`。\n`,
    },
    root => {
      const { judged } = coverageOf(root);
      assert.equal(judged.paired, 0, `间距超过 ${SYMBOL_COVERAGE_ADJACENCY} 个字符不许配对`);
      assert.equal(judged.unpaired, 1);
    },
  );
});

test('C6 两侧等距 ⇒ 不猜（记 ambiguous，既不进 OK 也不进 OUT_OF_RANGE）', () => {
  withFixture(
    {
      // 两侧各留一个空格：`alphaHandler` 与 `betaHandler` 到锚点的距离一样近。
      'services/api/src/alpha.ts': sourceWith('alphaHandler'),
      'docs/architecture/tie.md': '# 等距\n\n- `alphaHandler` `services/api/src/alpha.ts:2` `betaHandler`\n',
    },
    root => {
      const { judged } = coverageOf(root);
      assert.equal(judged.ambiguous, 1);
      assert.equal(judged.paired, 0);
      assert.equal(judged.ok, 0);
      assert.equal(judged.outOfRange, 0);
    },
  );
});

test('C7 缺省 `count` 模式不改变退出码：判据照常出读数，但 exit 0（子进程实跑）', () => {
  const fixture = {
    'services/api/src/alpha.ts': sourceWith('alphaHandler'),
    // 这条配对是 NOT_FOUND：缺省模式下它只能出现在 WARN 读数里，不许把退出码顶成 1。
    'docs/architecture/warn-only.md': '# 只警告\n\n- `ghostHandler`（`services/api/src/alpha.ts:2`）已不存在。\n',
  };
  withFixture(fixture, root => {
    const counted = spawnSync(process.execPath, [TOOL, '--root', root, '--scan', 'docs/architecture'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    const countedText = `${counted.stdout ?? ''}${counted.stderr ?? ''}`;
    assert.equal(counted.status, 0, `缺省 --symbol-coverage=count 下必须 exit 0，实际输出：\n${countedText}`);
    assert.match(
      countedText,
      /^SYMBOL-COVERAGE: 可判 1 条——OK 0、符号 0 命中 1、符号不在区间 0（仅 WARN，不影响 exit code）$/m,
      '统计行必须在（文案与数字都要对得上，缺了就等于这条判据没跑）',
    );

    // 同一个夹具、显式升级成 strict：这时它**才**判红（证明开关真的咬得住，不是永远绿）。
    const upgraded = spawnSync(
      process.execPath,
      [TOOL, '--root', root, '--scan', 'docs/architecture', '--strict', '--symbol-coverage=strict'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    const upgradedText = `${upgraded.stdout ?? ''}${upgraded.stderr ?? ''}`;
    assert.equal(upgraded.status, 1, `--symbol-coverage=strict 必须判红，实际输出：\n${upgradedText}`);
    assert.match(upgradedText, /^FAIL: 符号覆盖闸门未通过/m, 'strict 判红时要点名判据与条目');
    assert.match(upgradedText, /ghostHandler：NOT_FOUND/m, '判红正文要带上符号名与判定，否则没法照着改');
  });
});

test('C8 缺省值就是 count（照样出读数）；`--symbol-coverage=off` 才完全不打这一行', () => {
  const fixture = {
    'services/api/src/alpha.ts': sourceWith('alphaHandler'),
    'docs/architecture/mode.md': '# 模式\n\n- `ghostHandler`（`services/api/src/alpha.ts:2`）已不存在。\n',
  };
  const run = args => {
    const lines = [];
    const code = main(args, { log: line => lines.push(line), error: line => lines.push(line) });
    return { code, lines };
  };
  withFixture(fixture, root => {
    const base = ['--root', root, '--scan', 'docs/architecture'];
    const defaulted = run(base);
    assert.equal(defaulted.code, 0, '缺省模式不许因为这条 WARN 而变红');
    assert.equal(
      defaulted.lines.some(line => line.startsWith('SYMBOL-COVERAGE: 可判 1 条')),
      true,
      '不传 --symbol-coverage 时缺省就是 count，必须照样打读数',
    );

    const off = run([...base, '--symbol-coverage=off']);
    assert.equal(off.code, 0);
    assert.equal(
      off.lines.some(line => line.startsWith('SYMBOL-COVERAGE')),
      false,
      '--symbol-coverage=off 必须完全不扫（连 SCOPE 行都不打）',
    );
  });
  assert.equal(SYMBOL_COVERAGE_SLACK, 5, '覆盖容差是「锚点 ±5 行」，升级/收紧要显式改这个常量');
  assert.equal(SYMBOL_COVERAGE_OK, 'OK');
  assert.equal(SYMBOL_COVERAGE_NOT_FOUND, 'NOT_FOUND');
  assert.equal(SYMBOL_COVERAGE_OUT_OF_RANGE, 'OUT_OF_RANGE');
});

test('C9 列举串（`anchor 的 symbol、anchor 的 symbol`）不许把左项符号配给右项锚点', () => {
  // 这是台账里最常见的写法，也是本判据第一版最大的假阳性来源：
  // 「`alpha.ts:1162` 的 `createTtsProvider`、`alpha.ts:1176` 的 `createSynthesisMediaPort(...)`」——
  // 右项锚点离左项符号只有 1 字符（中间就一个 `、`），离自己的符号有 3 字符（中间是「 的 」）。
  // 只按字符距离取最近就会配错，于是**正确的文档**被判 OUT_OF_RANGE（见
  // `docs/architecture/contract-implementation-status.md:97` 的真实误报）。
  assert.equal(
    SYMBOL_COVERAGE_LIST_SEPARATORS.includes('、'),
    true,
    '列举分隔符清单必须含中文顿号，否则这条规则对中文台账整片失效',
  );
  withFixture(
    {
      'services/api/src/alpha.ts': sourceWith('alphaHandler'),
      'docs/architecture/listed.md':
        '# 列举\n\n- `services/api/src/alpha.ts:2` 的 `ghostHandler`、`services/api/src/alpha.ts:2` 的 `alphaHandler`\n',
    },
    root => {
      const { judged, misses } = coverageOf(root);
      assert.equal(judged.paired, 2, '两个锚点各配各自紧邻的符号');
      assert.equal(judged.notFound, 1, '只有左项那个真不存在的符号该判 NOT_FOUND');
      assert.equal(judged.ok, 1, '右项该配到自己的 alphaHandler 并判 OK');
      assert.equal(misses.length, 1, '配错时这里会是 2 条（ghostHandler 被配给两个锚点）');
      assert.equal(misses[0].symbol, 'ghostHandler');
      assert.equal(misses[0].result, SYMBOL_COVERAGE_NOT_FOUND);
    },
  );
});
