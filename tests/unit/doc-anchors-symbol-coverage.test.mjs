/**
 * `SYMBOL-COVERAGE`（符号覆盖读数）的守卫。
 *
 * 缺口（为什么需要这个文件）：`--symbol=strict` 只判「锚点行是不是代码行」，
 * 不证明同一行写着的符号名**还在那个文件里、且还落在锚点区间**。于是文档里
 * `` `services/api/src/app.ts:2508` 的 `ocrPersistencePool` ``（真实声明在 2546 行）
 * 照样全绿——行号落进了别的函数体，符号名却继续被当成「实现就在这几行」的证据。
 * `tools/verify-doc-anchors.mjs` 新增的 `collectSymbolCoverage()` 就是补这个洞的读数。
 *
 * 本文件钉住这几件事（缺任一条，这条判据都可能退化成「扫了个寂寞」「永远红」或「白名单」）：
 *   ① 符号命中且声明块覆盖锚点 ⇒ `OK`（不能把正常写法判成问题）；
 *   ② 符号在目标文件里 0 命中、或出现过但没有一处是声明行 ⇒ `UNDECLARED`
 *      （子档 `ZERO_HIT`／`NO_DECLARATION`；**只计数、不判红**，但必须一直可见）；
 *   ③ 符号在目标文件里**有**声明行、但既不覆盖锚点也不在锚点 ±5 行内 ⇒ `OUT_OF_RANGE`（判红）；
 *   ④ 同一行没有紧邻符号 ⇒ **不配对**（配对口径收紧的代价必须显式计数，不许静默少扫）；
 *   ⑤ 两段之间夹着`依次`／`分别`这类按位对应标记 ⇒ 不配对（右边那串符号按位置对应左边那串锚点）。
 * 另外用子进程钉住「缺省 `count` 模式不改变退出码」：这条判据是 WARN，先观察一轮，
 * 只有显式 `--symbol-coverage=strict`（且 `--strict`）才会判红。
 *
 * 2026-11-04「判红面只对目标文件里有声明行的符号生效」（工具文件头第 ④ 条）落地后，本文件相应调整了两处
 * 既有期望，改动都写在对应用例的注释里：C2 由 `NOT_FOUND`（判红）改为 `UNDECLARED`／`ZERO_HIT`（只计数），
 * C7 的判红夹具换成「有声明但行号漂走」的形状。**这不是放宽已能判定的判定面**：有声明行的符号照样走
 * OK／OUT_OF_RANGE（C1／C3／C11），声明在别处的符号落 `UNDECLARED`（C12）——按新口径它不是**这个文件**的
 * 符号，要判它得先给配对器一个「符号属于哪个文件」的依据，这条读数没有那个依据，猜测只会把正确的文档判红。
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
  SYMBOL_COVERAGE_NO_DECLARATION,
  SYMBOL_COVERAGE_OK,
  SYMBOL_COVERAGE_OUT_OF_RANGE,
  SYMBOL_COVERAGE_POSITIONAL_MARKERS,
  SYMBOL_COVERAGE_SLACK,
  SYMBOL_COVERAGE_UNDECLARED,
  SYMBOL_COVERAGE_ZERO_HIT,
  collectSymbolCoverage,
  main,
} from '../../tools/verify-doc-anchors.mjs';
import { symbolDeclarationLines } from '../../tools/lib/anchor-resolve.mjs';

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

/** 子进程实跑工具（退出码只能从进程拿，进程内 `main()` 不落 exit code）。 */
function runTool(root, extraArgs = []) {
  const result = spawnSync(process.execPath, [TOOL, '--root', root, '--scan', 'docs/architecture', ...extraArgs], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return { status: result.status, text: `${result.stdout ?? ''}${result.stderr ?? ''}` };
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
      assert.equal(judged.undeclared, 0);
      assert.equal(judged.outOfRange, 0);
      assert.deepEqual(misses, [], 'OK 的配对不进明细');
    },
  );
});

test('C2 符号在目标文件里 0 命中 ⇒ UNDECLARED／ZERO_HIT（看得见，但不进判红面）', () => {
  // 口径变化（2026-11-04）：本用例原来断言 `NOT_FOUND` 且 strict 判红。新口径第 ④ 条把「目标文件里没有
  // 该符号的声明行」划到 `UNDECLARED`——改了名／删了实现的文档照样要**看得见**（明细 + 计数），但不再
  // 因为「同一行顺带被反引号框起来的词」把整份文档顶红；判红交给「有声明行却对不上」的 OUT_OF_RANGE。
  withFixture(
    {
      'services/api/src/alpha.ts': sourceWith('alphaHandler'),
      'docs/architecture/missing.md': '# 缺失\n\n- `ghostHandler`（`services/api/src/alpha.ts:2`）已经不存在。\n',
    },
    root => {
      const { judged, misses, red } = coverageOf(root);
      assert.equal(judged.paired, 1);
      assert.equal(judged.undeclared, 1);
      assert.equal(judged.zeroHit, 1, '目标文件里 0 次出现归 ZERO_HIT 子档');
      assert.equal(judged.noDeclaration, 0);
      assert.equal(judged.ok, 0);
      assert.equal(misses.length, 1, '不判红 ≠ 不打印：这条仍要进逐条明细');
      assert.equal(misses[0].symbol, 'ghostHandler');
      assert.equal(misses[0].result, SYMBOL_COVERAGE_UNDECLARED);
      assert.equal(misses[0].detail, SYMBOL_COVERAGE_ZERO_HIT);
      assert.match(misses[0].reason, /出现 0 次/, '理由要说清是「0 次」而不是「不在区间」');
      assert.deepEqual(red, [], 'UNDECLARED 永远不进判红面');
    },
  );
});

test('C3 符号有声明但不在锚点区间 ⇒ OUT_OF_RANGE（行号漂走的正是这个形状）', () => {
  // gammaHandler 声明在第 1 行（块 1-3），文档却把锚点写到 :30：符号在文件里找得到，但不在那几行。
  const padding = '// 留白\n'.repeat(40);
  withFixture(
    {
      'services/api/src/beta.ts': `${sourceWith('betaHandler')}${padding}`,
      'docs/architecture/drifted.md': '# 漂移\n\n- `betaHandler`（`services/api/src/beta.ts:30`）在这里。\n',
    },
    root => {
      const { judged, misses, red } = coverageOf(root);
      assert.equal(judged.paired, 1);
      assert.equal(judged.outOfRange, 1);
      assert.equal(judged.undeclared, 0, '有声明行的符号绝不许落进 UNDECLARED');
      assert.equal(misses.length, 1);
      assert.equal(misses[0].result, SYMBOL_COVERAGE_OUT_OF_RANGE);
      assert.equal(red.length, 1, 'OUT_OF_RANGE 是判红面');
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
  // 夹具用「有声明但行号漂走」的配对（OUT_OF_RANGE）：这才是新口径下的判红档，用它才能证明
  // 「开关真的咬得住」。原来这条用的是 0 命中的 ghostHandler，按第 ④ 条已归 UNDECLARED（见 C2）。
  const fixture = {
    'services/api/src/alpha.ts': `${sourceWith('betaHandler')}${'// 留白\n'.repeat(40)}`,
    'docs/architecture/warn-only.md': '# 只警告\n\n- `betaHandler`（`services/api/src/alpha.ts:30`）在别处。\n',
  };
  withFixture(fixture, root => {
    const counted = runTool(root);
    assert.equal(counted.status, 0, `缺省 --symbol-coverage=count 下必须 exit 0，实际输出：\n${counted.text}`);
    assert.match(
      counted.text,
      /^SYMBOL-COVERAGE: 可判 1 条——OK 0、符号不在区间 1（仅 WARN，不影响 exit code）$/m,
      '统计行必须在（文案与数字都要对得上，缺了就等于这条判据没跑）',
    );
    assert.match(
      counted.text,
      /^SYMBOL-COVERAGE-UNDECLARED: 0 条（符号在目标文件里没有声明行；不计入 strict 判定，逐条抽样见下）——其中符号 0 命中 0 条、出现过但不是声明行 0 条$/m,
      'UNDECLARED 那一行必须常驻（0 条也要打），否则「没判」和「没扫」分不清',
    );
    assert.match(counted.text, /betaHandler：OUT_OF_RANGE/m, 'count 模式仍要逐条打印明细');

    // 同一个夹具、显式升级成 strict：这时它**才**判红（证明开关真的咬得住，不是永远绿）。
    const upgraded = runTool(root, ['--strict', '--symbol-coverage=strict']);
    assert.equal(upgraded.status, 1, `--symbol-coverage=strict 必须判红，实际输出：\n${upgraded.text}`);
    assert.match(upgraded.text, /^FAIL: 符号覆盖闸门未通过/m, 'strict 判红时要点名判据与条目');
    assert.match(upgraded.text, /betaHandler：OUT_OF_RANGE/m, '判红正文要带上符号名与判定，否则没法照着改');
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
      defaulted.lines.some(line => line.startsWith('SYMBOL-COVERAGE: 可判 0 条')),
      true,
      '不传 --symbol-coverage 时缺省就是 count，必须照样打读数',
    );
    assert.equal(
      defaulted.lines.some(line => line.startsWith('SYMBOL-COVERAGE-UNDECLARED: 1 条')),
      true,
      'UNDECLARED 桶在 count／strict 两种模式下都要可见',
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
  assert.equal(SYMBOL_COVERAGE_OUT_OF_RANGE, 'OUT_OF_RANGE');
  assert.equal(SYMBOL_COVERAGE_UNDECLARED, 'UNDECLARED');
  assert.equal(SYMBOL_COVERAGE_ZERO_HIT, 'ZERO_HIT');
  assert.equal(SYMBOL_COVERAGE_NO_DECLARATION, 'NO_DECLARATION');
  assert.equal(new Set([SYMBOL_COVERAGE_OK, SYMBOL_COVERAGE_OUT_OF_RANGE, SYMBOL_COVERAGE_UNDECLARED]).size, 3, '三档判定值不许重名，否则读数会串档');
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
      // 口径变化（2026-11-04）：ghostHandler 0 命中，按第 ④ 条落 UNDECLARED 只计数（原来判 NOT_FOUND）。
      assert.equal(judged.undeclared, 1, '只有左项那个真不存在的符号该记 UNDECLARED');
      assert.equal(judged.ok, 1, '右项该配到自己的 alphaHandler 并判 OK');
      assert.equal(misses.length, 1, '配错时这里会是 2 条（ghostHandler 被配给两个锚点）');
      assert.equal(misses[0].symbol, 'ghostHandler');
      assert.equal(misses[0].result, SYMBOL_COVERAGE_UNDECLARED);
    },
  );
});

test('C10 符号在目标文件里出现过、但不是声明行 ⇒ UNDECLARED／NO_DECLARATION，strict 不判红', () => {
  // 真实形状：文档同一行顺带把字段名／动词框起来（`set_flag`、`third_party_state`、`delete`）。
  // 这些词在目标文件里确实**出现**（对象字面量属性、SQL 关键字），但没有一处是声明行，所以
  // `symbolDeclarationLines` 为空 ⇒ UNDECLARED。它与 ZERO_HIT 分开打，因为修法不同：这一档不是
  // 「符号写错了」，而是「这个配对本来就不该被判」。
  const fixture = {
    // `set_flag` 只作为对象字面量属性出现（第 2 行）——有意不把 `NAME:` 当声明（见 anchor-resolve 注释）。
    'apps/admin/src/lib/audit-events.mjs': `export const registry = {\n  set_flag: true,\n};\n${'// 留白\n'.repeat(40)}`,
    'docs/architecture/noisy.md':
      '# 噪声\n\n- 审计事件里有 `set_flag`（`apps/admin/src/lib/audit-events.mjs:30`）这一档。\n',
  };
  withFixture(fixture, root => {
    const { judged, misses, red } = coverageOf(root);
    assert.equal(judged.paired, 1);
    assert.equal(judged.undeclared, 1);
    assert.equal(judged.noDeclaration, 1, '出现过但没有声明行 ⇒ NO_DECLARATION 子档');
    assert.equal(judged.zeroHit, 0);
    assert.equal(judged.outOfRange, 0, '没有声明行就不是「声明漂走」，不许判红');
    assert.equal(misses[0].result, SYMBOL_COVERAGE_UNDECLARED);
    assert.equal(misses[0].detail, SYMBOL_COVERAGE_NO_DECLARATION);
    assert.match(misses[0].reason, /出现 1 次，没有一处是声明行/);
    assert.deepEqual(red, [], 'UNDECLARED 不进判红面');

    const strictRun = runTool(root, ['--strict', '--symbol-coverage=strict']);
    assert.equal(strictRun.status, 0, `UNDECLARED 在 strict 下必须仍然 exit 0，实际输出：\n${strictRun.text}`);
    assert.match(strictRun.text, /set_flag：UNDECLARED/m, '不判红也要逐条可见，否则噪声会变成静默漏扫');
    assert.doesNotMatch(strictRun.text, /^FAIL: 符号覆盖闸门未通过/m);
  });
});

test('C11 符号有声明但离锚点 > 5 行 ⇒ OUT_OF_RANGE，strict 判红（判定面不许被第 ④ 条吃掉）', () => {
  // 与 C3 不同侧：声明在锚点**之后**（第 21 行，块 21-23），锚点写 :2 —— 距离远超 ±5 行。
  const fixture = {
    'services/api/src/late.ts': `${'// 留白\n'.repeat(20)}${sourceWith('lateHandler')}`,
    'docs/architecture/late.md': '# 迟到\n\n- `lateHandler`（`services/api/src/late.ts:2`）在这里。\n',
  };
  withFixture(fixture, root => {
    const { judged, misses, red } = coverageOf(root);
    assert.equal(judged.paired, 1);
    assert.equal(judged.outOfRange, 1, '有声明行 ⇒ 落在 OUT_OF_RANGE，不许归 UNDECLARED');
    assert.equal(judged.undeclared, 0);
    assert.equal(misses[0].result, SYMBOL_COVERAGE_OUT_OF_RANGE);
    assert.equal(red.length, 1);

    const strictRun = runTool(root, ['--strict', '--symbol-coverage=strict']);
    assert.equal(strictRun.status, 1, `有声明却不在 ±${SYMBOL_COVERAGE_SLACK} 行内必须判红，实际输出：\n${strictRun.text}`);
    assert.match(strictRun.text, /^FAIL: 符号覆盖闸门未通过/m);
    assert.match(strictRun.text, /lateHandler：OUT_OF_RANGE/m);
  });
});

test('C12 声明在另一个文件 ⇒ 目标文件里 0 命中 ⇒ UNDECLARED／ZERO_HIT，strict 不判红', () => {
  // 任务书原稿设想「声明在另一文件」仍判 ZERO_HIT 红。落地时按第 ④ 条改为 UNDECLARED：本读数只看得见
  // 「目标文件里有没有这个符号的声明行」，没有「符号属于哪个文件」的依据；把「目标文件里 0 次出现」
  // 一律判红，等于让 `:1` 这种合法的「跨文件引用符号」写成永红（这也正是 2026-11-04 那 16 条里的 7 条）。
  // 要判跨文件声明的漂移，得先给配对器一个身份线索（另开一片），不在本判据里猜。
  withFixture(
    {
      'services/api/src/alpha.ts': sourceWith('alphaHandler'),
      'services/api/src/beta.ts': sourceWith('betaHandler'),
      'docs/architecture/cross-file.md':
        '# 跨文件\n\n- `betaHandler`（`services/api/src/alpha.ts:2`）真实声明在另一个文件。\n',
    },
    root => {
      const { judged, misses, red } = coverageOf(root);
      assert.equal(judged.paired, 1);
      assert.equal(judged.undeclared, 1);
      assert.equal(judged.zeroHit, 1, '目标文件（alpha.ts）里 betaHandler 0 次出现');
      assert.equal(judged.outOfRange, 0);
      assert.equal(misses[0].result, SYMBOL_COVERAGE_UNDECLARED);
      assert.deepEqual(red, []);

      const strictRun = runTool(root, ['--strict', '--symbol-coverage=strict']);
      assert.equal(strictRun.status, 0, `UNDECLARED 不许把 strict 顶红，实际输出：\n${strictRun.text}`);
    },
  );
});

test('C13 两段之间夹着`依次是`⇒ 不配对（按位列举只按位置对，不许就近抓）', () => {
  // `docs/architecture/admin-console-capability-map.md:246` 的真实形状：四个锚点连写，后面用
  // 「（依次是 `a`／`b`／`c`）」按位置列出符号。`:443` 紧邻的 `grantAdministratorScope` 其实属于
  // `:436`，就近配对会把它判成 OUT_OF_RANGE（而它在目标文件里是真声明）。
  assert.equal(
    SYMBOL_COVERAGE_POSITIONAL_MARKERS.includes('依次'),
    true,
    '按位对应标记必须含「依次」，否则这条规则对中文台账失效',
  );
  withFixture(
    {
      'services/api/src/alpha.ts': sourceWith('alphaHandler'),
      'docs/architecture/positional.md':
        '# 按位\n\n- 四条在 `services/api/src/alpha.ts:2`、`services/api/src/alpha.ts:3`（依次是 `alphaHandler`／`betaHandler`）\n',
    },
    root => {
      const { judged } = coverageOf(root);
      assert.equal(judged.paired, 0, '按位列举不产生紧邻配对');
      assert.equal(judged.unpaired, 2, '两个锚点都要记进「同行没有紧邻符号」，不许静默消失');
      assert.equal(judged.ok, 0);
      assert.equal(judged.outOfRange, 0);
    },
  );
});

test('C14 声明形态清单（`symbolDeclarationLines`）：认哪些、有意不认哪些', () => {
  // `UNDECLARED` 是判据层面的语义划分，靠的就是「目标文件里有没有声明行」这一问。这份清单被人手改窄
  // 一档，整片噪声就会回流成判红；改宽一档（例如认对象属性 `NAME:`），正确的文档会被判 OUT_OF_RANGE。
  // 所以逐形态钉住，行号写死（每行一个形态，改行序就要改断言）。
  const text = [
    'export function foo(a) {', // 1
    'async function bar() {', // 2
    'const baz = 1;', // 3
    'let qux;', // 4
    'var quux = 1;', // 5
    'class Cls {', // 6
    'interface Iface {', // 7
    'type Alias = string;', // 8
    'enum Color {', // 9
    'const enum Flag {', // 10
    'CREATE OR REPLACE FUNCTION sql_fn()', // 11
    'create table if not exists sql_tbl (', // 12
    '  prop: 1,', // 13
    'export { inner as outer }', // 14
    '  doWork(1);', // 15
  ].join('\n');
  const expect = (symbol, lines) => assert.deepEqual(symbolDeclarationLines(text, symbol), lines, `符号 ${symbol}`);
  expect('foo', [1]);
  expect('bar', [2]);
  expect('baz', [3]);
  expect('qux', [4], '`let qux;` 这种裸声明必须认（VARIABLE_DECLARATION_LOOSE）');
  expect('quux', [5]);
  expect('Cls', [6]);
  expect('Iface', [7]);
  expect('Alias', [8]);
  expect('Color', [9], '`enum NAME` 要认（declarationName 不认这一档）');
  expect('Flag', [10], '`const enum NAME` 要认（不许被 const 的半截匹配吃掉）');
  expect('sql_fn', [11], 'SQL `CREATE OR REPLACE FUNCTION` 要认');
  expect('sql_tbl', [12], 'SQL `create table if not exists`（小写）要认');
  expect('prop', [], '对象字面量属性 `NAME:` **有意不认**（见 anchor-resolve 注释：没有自己的块体）');
  expect('outer', [], '`export { a as b }` 的别名 **有意不认**（别名不是声明）');
  expect('doWork', [15], '已知宽松处：整行 `NAME(...)` 的调用也算声明行——只会让判红面更大，不会更小');
  expect('nope', []);
  expect('', [], '空符号不许当成「处处都是声明」');
});
