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
 *   ⑥ `docs/verification/**` 另有一份**只读**读数（`SYMBOL-COVERAGE-VERIFICATION` ＋ `-SCOPE`）：同口径、
 *      但 `off`／`count`／`strict` 三档都**不进退出码**，`strict` 仍只判 `docs/architecture/**`（C15–C17）。
 *   ⑦ 这一面的逐条明细走自己的 `SYMBOL-COVERAGE-VERIFICATION-MISS`：`count`／`strict` 档打印、`off` 档不打、
 *      上限 20 条（与 architecture 那组同上限但**分列**）；塞进 `SYMBOL-COVERAGE-MISS` 就等于改既有读数（C18–C20）。
 *   ⑧ 提交 SHA 形态的候选**不算符号**（整段 7–40 位纯十六进制）：`（=``de2aa3c6``）` 这种括注不再配成对、
 *      也不进 UNDECLARED（C21）；同一位置换成正常标识符则配对照旧成立，规则不许外溢（C22）。
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
  SYMBOL_COVERAGE_VERIFICATION_SCOPE,
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

/**
 * 同上，但扫描面由调用方给：`docs/verification/**` **不在** `--scan docs/architecture` 里，
 * 不显式带上就扫不到那一面（也就测不到新读数）。
 */
function runToolOn(root, scans, extraArgs = []) {
  const args = [TOOL, '--root', root];
  for (const scan of scans) args.push('--scan', scan);
  const result = spawnSync(process.execPath, [...args, ...extraArgs], { cwd: REPO_ROOT, encoding: 'utf8' });
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

test('C15 `docs/verification/**` 的读数独立成行，且 count／strict 都不进退出码', () => {
  // 为什么要单列一面：`docs/verification/**` 是历史取证面（行号按当时的树写、正文自己就写着基线），
  // 先把读数铺开观察；它一旦并进上面那条判红面，整片历史页立刻把 CI 顶红，等于逼人篡改证据语义。
  const fixture = {
    'services/api/src/alpha.ts': sourceWith('alphaHandler'),
    // lateHandler 声明在 21-23 行，锚点写 :2 —— 距离远超 ±5 行 ⇒ 这一面唯一的判红档形状。
    'services/api/src/late.ts': `${'// 留白\n'.repeat(20)}${sourceWith('lateHandler')}`,
    'docs/architecture/within.md': '# 判据面\n\n- `alphaHandler`（`services/api/src/alpha.ts:2`）只做加一。\n',
    'docs/verification/late-page.md': '# 取证\n\n- `lateHandler`（`services/api/src/late.ts:2`）写在这里。\n',
  };
  withFixture(fixture, root => {
    const scans = ['docs/architecture', 'docs/verification'];
    const counted = runToolOn(root, scans);
    assert.equal(counted.status, 0, `verification 面的读数不许改退出码，实际输出：\n${counted.text}`);
    assert.match(
      counted.text,
      /^SYMBOL-COVERAGE: 可判 1 条——OK 1、符号不在区间 0（仅 WARN，不影响 exit code）$/m,
      'architecture 的读数只数 architecture：verification 那条配对混进来就等于改了既有 CI 读数',
    );
    assert.match(
      counted.text,
      /^SYMBOL-COVERAGE-VERIFICATION: 可判 1 条——OK 0、符号不在区间 1（仅 WARN，不影响 exit code）$/m,
      'verification 面必须有自己的读数行，且「符号在但不在区间」要计入 z',
    );
    assert.ok(
      counted.text.includes('SYMBOL-COVERAGE-VERIFICATION-SCOPE: 作用域 docs/verification/**（1 份文档、锚点 1 条）——配成对 1 条：OK 0、符号不在区间 1、UNDECLARED 0（符号 0 命中 0 条、出现过但不是声明行 0 条）'),
      `SCOPE 行要写清文档份数／锚点数／配对数，实际输出：\n${counted.text}`,
    );
    assert.ok(
      counted.text.includes('作用域外（历史取证页等）只计数：锚点 1 条、配成对 1 条——OK 0、符号不在区间 1、UNDECLARED 0（0 命中 0／非声明行 0）'),
      '既有 SCOPE 行的「作用域外」读数必须照旧把 verification 页数进去（影子账不搬家）',
    );
    assert.doesNotMatch(
      counted.text,
      /^SYMBOL-COVERAGE-MISS/m,
      'architecture 那组明细不许出现（本夹具 architecture 面 0 条 miss）；verification 的条目更不许混进去（2026-11-04 起它走自己的 `-VERIFICATION-MISS` 行，见 C18）',
    );

    const upgraded = runToolOn(root, scans, ['--strict', '--symbol-coverage=strict']);
    assert.equal(upgraded.status, 0, `strict 只判 architecture，verification 的 OUT_OF_RANGE 不许顶红：\n${upgraded.text}`);
    assert.match(
      upgraded.text,
      /^SYMBOL-COVERAGE-VERIFICATION: 可判 1 条——OK 0、符号不在区间 1（仅 WARN，不影响 exit code）$/m,
      'strict 档下这一面的后缀也必须照旧写「仅 WARN」（与 architecture 那一行有意不同）',
    );
    assert.doesNotMatch(upgraded.text, /^FAIL: 符号覆盖闸门未通过/m);
  });
});

test('C16 `--symbol-coverage=off` 连 verification 的两行都不打（与 architecture 一致）', () => {
  const fixture = {
    'services/api/src/alpha.ts': sourceWith('alphaHandler'),
    // 夹具里必须有 architecture 面：`--scan` 指向不存在的目录会直接抛「扫描目标不存在」。
    'docs/architecture/within.md': '# 判据面\n\n- `alphaHandler`（`services/api/src/alpha.ts:2`）只做加一。\n',
    'docs/verification/page.md': '# 页\n\n- `alphaHandler`（`services/api/src/alpha.ts:2`）在这里。\n',
  };
  const run = args => {
    const lines = [];
    const code = main(args, { log: line => lines.push(line), error: line => lines.push(line) });
    return { code, lines };
  };
  withFixture(fixture, root => {
    const base = ['--root', root, '--scan', 'docs/architecture', '--scan', 'docs/verification'];
    const counted = run(base);
    assert.equal(counted.code, 0);
    assert.equal(
      counted.lines.some(line => line.startsWith('SYMBOL-COVERAGE-VERIFICATION: 可判 1 条')),
      true,
      '缺省就是 count：verification 的读数行必须照常打（不打就等于这一面没统计）',
    );
    assert.equal(
      counted.lines.some(line => line.startsWith('SYMBOL-COVERAGE-VERIFICATION-SCOPE: 作用域 docs/verification/**')),
      true,
      'SCOPE 行与读数行同进同出',
    );
    const off = run([...base, '--symbol-coverage=off']);
    assert.equal(off.code, 0);
    assert.equal(
      off.lines.some(line => line.startsWith('SYMBOL-COVERAGE')),
      false,
      'off 档连 `SYMBOL-COVERAGE-VERIFICATION*` 都不许出现（关掉统计就是整面不扫，不许留半行）',
    );
  });
  assert.equal(SYMBOL_COVERAGE_VERIFICATION_SCOPE, 'docs/verification/', '统计面钉在这里：换成更宽的面是另一次决策');
});

test('C17 verification 页里「符号在但不在区间」计入 z，但不进 misses／red、也不判红', () => {
  // (c) 的单元版：判据函数层面必须把「计入 z」与「进判红面」分开——两者混在一起时，任何一条历史
  // 取证页的行号漂移都会变成 CI 红（而这一面的基线本来就写在那些页面自己的正文里）。
  const fixture = {
    'services/api/src/late.ts': `${'// 留白\n'.repeat(20)}${sourceWith('lateHandler')}`,
    // 只有锚点、没有紧邻符号：让 architecture 面的 `paired` 保持 0，好把「这一对算在谁头上」钉死。
    'docs/architecture/anchor-only.md': '# 只有锚点\n\n- 见 `services/api/src/late.ts:2` 这一行。\n',
    'docs/verification/late-page.md': '# 取证\n\n- `lateHandler`（`services/api/src/late.ts:2`）写在这里。\n',
  };
  withFixture(fixture, root => {
    const targets = ['docs/architecture', 'docs/verification'];
    const { judged, verification, misses, verificationMisses, red } = collectSymbolCoverage({ root, targets });
    assert.equal(verification.paired, 1);
    assert.equal(verification.outOfRange, 1, '「符号在但不在区间」必须计入 verification 的 z');
    assert.equal(verification.ok, 0);
    assert.equal(verification.documents, 1);
    assert.equal(judged.paired, 0, 'architecture 面不许把 verification 的配对算进来');
    assert.deepEqual(misses, [], 'verification 面只出计数，不进 misses 明细');
    assert.deepEqual(red, [], '判红面（red）与 verification 读数彻底分开');
    // 明细另收一份（2026-11-04）：这一面「能打印」与「会判红」是两件事——`verificationMisses` 只供
    // `SYMBOL-COVERAGE-VERIFICATION-MISS` 打印用，`misses`／`red` 都不认识它。
    assert.equal(verificationMisses.length, 1, '这一面的 miss 另收一份，与 `misses` 并列');
    assert.equal(verificationMisses[0].symbol, 'lateHandler');
    assert.equal(verificationMisses[0].result, SYMBOL_COVERAGE_OUT_OF_RANGE);

    const strictRun = runToolOn(root, targets, ['--strict', '--symbol-coverage=strict']);
    assert.equal(strictRun.status, 0, `verification 的 OUT_OF_RANGE 不许导致 exit 1，实际输出：\n${strictRun.text}`);
    // 口径变化（2026-11-04）：这一面现在**会**打明细，但只走自己的那一行；「不进 misses／red、不改退出码」
    // 三条不变（上面已断言），这里钉住的是「细节归哪一组」——混进 architecture 那组就是改既有读数。
    assert.match(strictRun.text, /^SYMBOL-COVERAGE-VERIFICATION-MISS: 1 条/m, '明细要能打印（上一轮只能人工复刻配对逻辑才拿到清单）');
    assert.doesNotMatch(strictRun.text, /^SYMBOL-COVERAGE-MISS/m, 'verification 的条目不许混进 architecture 那组');
    assert.doesNotMatch(strictRun.text, /^FAIL: 符号覆盖闸门未通过/m, '更不许判红：strict 仍只收紧 architecture');
  });
});

test('C18 verification 面的逐条明细可打印：count 档出现、上限 20 条、排在 architecture 那组之后', () => {
  // 为什么要有这条：汇总行只给 `可判 N 条——OK a、符号不在区间 b`，改文档的人无从下手；上一轮为了拿到
  // 12 条真漂移，只能自己复刻配对逻辑再用五格反算校验。明细必须能打，但**不能**混进 `SYMBOL-COVERAGE-MISS`
  // （那一行的条数、顺序、抽样上限都是既有读数）。
  const many = Array.from({ length: 30 }, (_, index) => `- \`ghost${index}\`（\`services/api/src/alpha.ts:2\`）已不存在。`);
  const fixture = {
    'services/api/src/alpha.ts': sourceWith('alphaHandler'),
    // architecture 面留**一条** miss：用来钉住「两组分列、architecture 那组仍在前」。
    'docs/architecture/one-miss.md': '# 一条\n\n- `ghostArch`（`services/api/src/alpha.ts:2`）已不存在。\n',
    'docs/verification/many.md': `# 多\n\n${many.join('\n')}\n`,
  };
  const run = args => {
    const lines = [];
    const code = main(args, { log: line => lines.push(line), error: line => lines.push(line) });
    return { code, lines };
  };
  withFixture(fixture, root => {
    const base = ['--root', root, '--scan', 'docs/architecture', '--scan', 'docs/verification'];
    const counted = run(base);
    assert.equal(counted.code, 0, 'count 档（缺省）不许因为明细而改退出码');

    const archHeader = counted.lines.findIndex(line => line.startsWith('SYMBOL-COVERAGE-MISS: '));
    const verificationHeader = counted.lines.findIndex(line => line.startsWith('SYMBOL-COVERAGE-VERIFICATION-MISS: '));
    assert.notEqual(archHeader, -1, 'architecture 那组照旧要打（本夹具 1 条）');
    assert.notEqual(verificationHeader, -1, 'verification 那组必须打：这一面的明细就是这条用例来的');
    assert.ok(archHeader < verificationHeader, '新块只能是追加：architecture 那组必须仍排在前面');

    assert.equal(
      counted.lines[archHeader],
      'SYMBOL-COVERAGE-MISS: 1 条「锚点 + 符号」对不上（文档:行 → 锚点（符号：判定；解析器理由））——WARN，逐条抽样；只有 OUT_OF_RANGE 会在 --symbol-coverage=strict 下判红：',
      'architecture 那组的表头与条数不许被 verification 的 30 条带跑（它只数 architecture 面）',
    );
    assert.equal(
      counted.lines[verificationHeader],
      'SYMBOL-COVERAGE-VERIFICATION-MISS: 30 条「锚点 + 符号」对不上（文档:行 → 锚点（符号：判定；解析器理由））——WARN，逐条抽样；本面三档都不判红，strict 仍只判 docs/architecture/**：',
      '表头要带上这一面的真实条数（30 条），而不是 architecture 的 1 条',
    );

    // 只取「两个表头之间」：`STALE-DRIFT` 那类账本行也是 `  · docs/architecture/…` 开头，不夹住会混进来。
    const archEntries = counted.lines
      .slice(archHeader + 1, verificationHeader)
      .filter(line => line.startsWith('  · docs/architecture/'));
    const verificationEntries = counted.lines.slice(verificationHeader + 1).filter(line => line.startsWith('  · docs/verification/'));
    assert.equal(archEntries.length, 1, 'architecture 那组只打自己那条');
    assert.equal(verificationEntries.length, 20, '抽样上限与 architecture 那组一致：20 条（30 条里只打前 20）');
    assert.ok(
      counted.lines.slice(verificationHeader).some(line => line === '  … 另有 10 条未打印（格式同上）'),
      `截断必须显式说明还剩多少条（不许静默少打），实际输出：\n${counted.lines.slice(verificationHeader).join('\n')}`,
    );
    assert.equal(
      counted.lines.filter(line => line.startsWith('  · docs/verification/')).length,
      20,
      '整份输出里 verification 的条目也只许出现 20 条（不许在别处再打一遍）',
    );
  });
});

test('C19 `--symbol-coverage=off` 连 `SYMBOL-COVERAGE-VERIFICATION-MISS` 都不打（同一夹具 count 档打过作对照）', () => {
  const fixture = {
    'services/api/src/alpha.ts': sourceWith('alphaHandler'),
    'docs/architecture/one-miss.md': '# 一条\n\n- `ghostArch`（`services/api/src/alpha.ts:2`）已不存在。\n',
    'docs/verification/page.md': '# 页\n\n- `ghostPage`（`services/api/src/alpha.ts:2`）已不存在。\n',
  };
  const run = args => {
    const lines = [];
    const code = main(args, { log: line => lines.push(line), error: line => lines.push(line) });
    return { code, lines };
  };
  withFixture(fixture, root => {
    const base = ['--root', root, '--scan', 'docs/architecture', '--scan', 'docs/verification'];
    // 对照组：没有它，「off 档没打」也可能只是「本来就没有明细」，测不出开关。
    const counted = run(base);
    assert.equal(
      counted.lines.some(line => line.startsWith('SYMBOL-COVERAGE-VERIFICATION-MISS: 1 条')),
      true,
      'count 档必须先证明这条明细真的会打出来',
    );
    const off = run([...base, '--symbol-coverage=off']);
    assert.equal(off.code, 0, 'off 档同样不改退出码');
    assert.equal(
      off.lines.some(line => line.includes('SYMBOL-COVERAGE-VERIFICATION-MISS')),
      false,
      'off 档整面不扫：连明细行都不许出现（与 `SYMBOL-COVERAGE*` 同进同出）',
    );
    assert.equal(
      off.lines.some(line => line.startsWith('SYMBOL-COVERAGE')),
      false,
      'off 档连读数行都不打（既有口径不变）',
    );
  });
});

test('C20 既有 architecture 四行逐字不变，且新块只追加在末尾', () => {
  // 这条用例的字面串就是 main@212b8ad **改前**的实测输出（改前/改后 `--scan docs` 整份 diff 只有追加）：
  // 一旦有人为了打 verification 明细去动这三/四行的文案、顺序或条数，这里立刻红。
  const fixture = {
    'services/api/src/late.ts': `${'// 留白\n'.repeat(20)}${sourceWith('lateHandler')}`,
    'docs/architecture/drifted.md': '# 漂移\n\n- `lateHandler`（`services/api/src/late.ts:2`）在这里。\n',
    'docs/verification/page.md': '# 取证\n\n- `lateHandler`（`services/api/src/late.ts:2`）写在这里。\n',
  };
  const run = args => {
    const lines = [];
    const code = main(args, { log: line => lines.push(line), error: line => lines.push(line) });
    return { code, lines };
  };
  withFixture(fixture, root => {
    const lines = run(['--root', root, '--scan', 'docs/architecture', '--scan', 'docs/verification']).lines;
    const at = prefix => {
      const index = lines.findIndex(line => line.startsWith(`${prefix}: `));
      assert.notEqual(index, -1, `读数行 ${prefix} 不见了（这条判据等于没跑）`);
      return index;
    };
    assert.equal(
      lines[at('SYMBOL-COVERAGE')],
      'SYMBOL-COVERAGE: 可判 1 条——OK 0、符号不在区间 1（仅 WARN，不影响 exit code）',
      '第一行逐字不变（文案、全角标点、后缀都要对得上）',
    );
    assert.equal(
      lines[at('SYMBOL-COVERAGE-UNDECLARED')],
      'SYMBOL-COVERAGE-UNDECLARED: 0 条（符号在目标文件里没有声明行；不计入 strict 判定，逐条抽样见下）——其中符号 0 命中 0 条、出现过但不是声明行 0 条',
      'UNDECLARED 那行逐字不变',
    );
    assert.equal(
      lines[at('SYMBOL-COVERAGE-SCOPE')],
      'SYMBOL-COVERAGE-SCOPE: 作用域 docs/architecture/**（1 份文档、锚点 1 条）——配成对 1 条；同行没有紧邻符号 0 条、两侧等距不猜 0 条、路径找不到或不唯一 0 条（这三格只计数，不进上面两档）；作用域外（历史取证页等）只计数：锚点 1 条、配成对 1 条——OK 0、符号不在区间 1、UNDECLARED 0（0 命中 0／非声明行 0）',
      'SCOPE 行逐字不变：verification 页照旧只算进「作用域外」那一段（影子账不搬家、合计不变）',
    );
    assert.equal(
      lines[at('SYMBOL-COVERAGE-MISS')],
      'SYMBOL-COVERAGE-MISS: 1 条「锚点 + 符号」对不上（文档:行 → 锚点（符号：判定；解析器理由））——WARN，逐条抽样；只有 OUT_OF_RANGE 会在 --symbol-coverage=strict 下判红：',
      'architecture 明细表头逐字不变（条数只数 architecture 面）',
    );
    // 顺序：architecture 四行 → verification 读数两行 → architecture 明细 → verification 明细。
    const order = [
      'SYMBOL-COVERAGE',
      'SYMBOL-COVERAGE-UNDECLARED',
      'SYMBOL-COVERAGE-SCOPE',
      'SYMBOL-COVERAGE-VERIFICATION',
      'SYMBOL-COVERAGE-VERIFICATION-SCOPE',
      'SYMBOL-COVERAGE-MISS',
      'SYMBOL-COVERAGE-VERIFICATION-MISS',
    ].map(at);
    for (let index = 1; index < order.length; index += 1) {
      assert.ok(order[index - 1] < order[index], `第 ${index} 行（${order[index - 1]}）必须排在 ${order[index]} 之前`);
    }
  });
});

test('C21 提交 SHA 形态的候选不算符号 ⇒ 不配对、不进 MISS／UNDECLARED（同行的正常锚点照判）', () => {
  // 真实形状：`docs/architecture/ai-ops-spec-status.md:31` 写「…合并 `upstream/main`（=`de2aa3c6`）后撤 N02：
  // `docs/architecture/contract-implementation-status.md:166` 已由 #710 改成…」——那个锚点的「紧邻符号」抓到
  // 的是**提交号**，于是稳定产出一条 `UNDECLARED／ZERO_HIT`（提交号当然不在目标文件的源码里）。
  // `docs/architecture/contract-implementation-status.md:42` 的 `bfbe12cd` 同形状。规则见工具里
  // `COVERAGE_COMMIT_HASH_SPAN`：整段就是 7–40 位纯十六进制的片段不算符号。
  withFixture(
    {
      'services/api/src/alpha.ts': sourceWith('alphaHandler'),
      'docs/architecture/commit-sha.md': [
        '# 提交号',
        '',
        // ① 字母开头的哈希（真实误报的形状，改前会配成对 ⇒ UNDECLARED／ZERO_HIT）；
        //    同一行后半段再放一条正常配对，证明这条规则不顺手把旁边的锚点也弄丢。
        //    ⛔ 括注与锚点之间不许夹列举分隔符／按位标记（`，`／`；` 也在清单里）：夹了就会被配对口径 ④／⑤ 先一步
        //    挡掉，这条用例就变成「测 ④」而不是「测提交号规则」了（本用例第一版写成「…N02，见 …」，正是这么失效的）。
        '- 合并 `upstream/main`（=`de2aa3c6`）之后见 `services/api/src/alpha.ts:2` 的覆盖成立；同句 `alphaHandler` 在 `services/api/src/alpha.ts:2` 覆盖成立。',
        // ② 数字开头的十六进制串（`0123abcd`）：它本来也进不了符号位（`COVERAGE_SYMBOL_SPAN` 要求首字符是
        //    字母／`_`／`$`），留在这里是为了钉住「十六进制 = 不是符号」这条口径本身，而不是只钉住它的副作用。
        '- 短哈希 `0123abcd` 后面也跟一条 `services/api/src/alpha.ts:2`。',
        '',
      ].join('\n'),
    },
    root => {
      const { judged, misses } = coverageOf(root);
      assert.equal(judged.anchors, 3, '三条锚点都要被扫到（不配对 ≠ 没扫到）');
      assert.equal(judged.paired, 1, '只有 `alphaHandler` 那条配成对：提交号不是符号，不许当紧邻符号');
      assert.equal(judged.ok, 1, '同一行那条正常配对照旧判 OK（规则只吃掉十六进制）');
      assert.equal(judged.undeclared, 0, '提交号不许再产出 UNDECLARED：这条假配对必须整条消失');
      assert.equal(judged.outOfRange, 0, '更不许因为排掉提交号反而把锚点判成「符号不在区间」');
      assert.equal(judged.unpaired, 2, '两条锚点退回「同行没有紧邻符号」，显式计数、不静默少扫');
      assert.deepEqual(misses, [], '没有配对成功项 ⇒ 明细必须为空（改前这里是一条 de2aa3c6：UNDECLARED）');
    },
  );
});

test('C22 反向保护：同一位置写正常标识符 ⇒ 配对照旧成立（规则只吃掉十六进制）', () => {
  // 与 C21 逐字同构，只把 `（=``de2aa3c6``）` 换成 `（=``createAnswerGuard``）`：位置、距离、括号、
  // 夹字全都一样。它必须照旧配成对并判 OK——否则这条规则就不是「排掉提交号」，而是把「锚点前面
  // 那截括注」整片废掉，C1／C9／C11 那些正常写法会连带退化。
  withFixture(
    {
      'services/api/src/guard.ts': sourceWith('createAnswerGuard'),
      'docs/architecture/normal-symbol.md':
        '# 正常符号\n\n- 合并 `upstream/main`（=`createAnswerGuard`）之后见 `services/api/src/guard.ts:2` 的覆盖成立。\n',
    },
    root => {
      const { judged, misses } = coverageOf(root);
      assert.equal(judged.anchors, 1);
      assert.equal(judged.paired, 1, '`createAnswerGuard` 不是纯十六进制串 ⇒ 必须照旧配成对');
      assert.equal(judged.ok, 1, '配对之后照常判：声明块盖住 :2 ⇒ OK');
      assert.equal(judged.undeclared, 0);
      assert.equal(judged.unpaired, 0, '不许被 C21 那条规则连带排掉（它落在「同行没有紧邻符号」就是回归）');
      assert.deepEqual(misses, []);
    },
  );
});
