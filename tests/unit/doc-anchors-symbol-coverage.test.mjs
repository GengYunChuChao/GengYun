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
 *   ⑨ 同一行有多条锚点、多个紧邻符号时，符号**按行内出现顺序一一配位**（一个符号只属于一条锚点）：
 *      夹心写法（锚点、符号、锚点）里那个符号不许被两条锚点同时认领（C23）；符号比锚点少时，
 *      多出来的锚点退回「同行没有紧邻符号」只计数、不判红（C24）；这条规则不许把提交号重新拉回符号位（C25）。
 *   ⑩ 这一面另有一条**回归闸门**参数 `--symbol-coverage-verification`（off／count／strict，缺省 `count`，
 *      与 `--symbol-coverage` 三档互不影响）：`strict` ＋ `--strict` 时读
 *      `tools/doc-anchors-symbol-coverage-verification-baseline.json`，只判「不在区间／UNDECLARED 的**计数**
 *      比基线变大」（REGRESSION ⇒ exit 1）；计数变小只打 STALE 提示跑写模式收紧、**不判红**（verification 面
 *      仍在收敛期，逐条钉会隔夜过期）；`paired ≠ OK ＋ 不在区间 ＋ UNDECLARED` 打 INCONSISTENT ⇒ exit 1。
 *      `count` 档既有的两行读数字面一字不动（C26），判红只在 strict 档（C27），收敛不判红（C28），
 *      `off` 连读数一起关、写模式落盘（C29）。
 *   ⑪ 另有一条**产物开关** `--symbol-coverage-report=<路径>`（缺省不写文件、既有 stdout 零漂移）：把两面
 *      逐条明细写成稳定排序（doc → 行号 → target → symbol，**码位序**）的 JSON，`items` 条数恒等于同次
 *      运行读数里的 `outOfRange + undeclared`，三个子档（`SYMBOL_NOT_IN_RANGE`／`ZERO_HIT`／`NO_DECLARATION`）
 *      分类可得；与 `--symbol-coverage=off`／基线生成**互斥并报错**（不给「以为写了其实没写」留缝）（C30–C33）。
 *   ⑫ 2026-11-05 补的两条**候选筛选**口径（只改「候选位上的东西算不算候选」，不动任何判定档）：
 *      ⑧ 候选位上的非标识符（汉语短语／路径片段／JSON 值／带括号的调用）与语言保留字（`delete`／`return`）
 *      在**抽候选之前**丢掉，只记一格「候选过滤 N 条」（C34）；⑨ 语言内建／全局对象的方法访问
 *      （`Array.isArray`／`Promise.all`）单列 `BUILTIN` 档，只计数、不判红、不进 UNDECLARED（C35）；
 *      ⑧ 的反向守卫：符号真实存在、只是落在调用／注册位的那批**不许**被顺手滤掉（仍判 UNDECLARED）（C36）。
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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SYMBOL_COVERAGE_ADJACENCY,
  SYMBOL_COVERAGE_LIST_SEPARATORS,
  SYMBOL_COVERAGE_NO_DECLARATION,
  SYMBOL_COVERAGE_NOT_IN_RANGE,
  SYMBOL_COVERAGE_OK,
  SYMBOL_COVERAGE_OUT_OF_RANGE,
  SYMBOL_COVERAGE_POSITIONAL_MARKERS,
  SYMBOL_COVERAGE_SLACK,
  SYMBOL_COVERAGE_UNDECLARED,
  SYMBOL_COVERAGE_VERIFICATION_SCOPE,
  SYMBOL_COVERAGE_ZERO_HIT,
  collectSymbolCoverage,
  main,
  renderSymbolCoverageReport,
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
      'SYMBOL-COVERAGE-SCOPE: 作用域 docs/architecture/**（1 份文档、锚点 1 条）——配成对 1 条；同行没有紧邻符号 0 条、两侧等距不猜 0 条、路径找不到或不唯一 0 条、候选过滤 0 条、语言内建 0 条（这五格只计数，不进上面两档）；作用域外（历史取证页等）只计数：锚点 1 条、配成对 1 条——OK 0、符号不在区间 1、UNDECLARED 0（0 命中 0／非声明行 0）',
      'SCOPE 行逐字不变：verification 页照旧只算进「作用域外」那一段（影子账不搬家、合计不变）；末两格（候选过滤／语言内建）是 2026-11-05 新增的只计数格，位置在「路径找不到或不唯一」之后',
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

test('C23 一行两锚点 + 两符号 ⇒ 按出现顺序一一配位（夹心符号不许被两条锚点同时认领）', () => {
  // 真实形状（`docs/verification/gy-i23-latency-capacity-local-20261020.md:195`）：
  // 「`…report.mjs:62`（`FORBIDDEN_ASSERTABLE_PATTERNS`）与 `…report.mjs:291` 声明的 `validateClaims`」——
  // 中间那个符号对左边锚点是「右邻」（间距 1）、对右边锚点又是「左邻」（间距 3），而右边锚点自己的符号
  // 在 6 字符外。改前每条锚点各自挑最近，于是两个锚点**同时**认领中间那个符号：`alphaHandler` 被算到
  // `beta.ts` 头上，判出一条假 `UNDECLARED`（符号在 `beta.ts` 里 0 命中），正确的文档看起来像写错了。
  // 口径 ⑦：符号按行内出现顺序一一配位，一个符号只属于一条锚点。
  withFixture(
    {
      'services/api/src/alpha.ts': sourceWith('alphaHandler'),
      'services/api/src/beta.ts': sourceWith('betaHandler'),
      'docs/architecture/sandwich.md':
        '# 夹心\n\n- 形态闸门在 `services/api/src/alpha.ts:2`（`alphaHandler`）与 `services/api/src/beta.ts:2` 声明的 `betaHandler`（两处都成立）。\n',
    },
    root => {
      const { judged, misses } = coverageOf(root);
      assert.equal(judged.anchors, 2);
      assert.equal(judged.paired, 2, '两条锚点各配自己的符号：改前右锚点抢左符号，这里会判出 1 条 UNDECLARED');
      assert.equal(judged.ok, 2, '两条都要判 OK（两个符号都声明在自己那个文件的第 1 行，块 1-3 盖住 :2）');
      assert.equal(judged.undeclared, 0, '`alphaHandler` 若被配给 `beta.ts` 就是 1 条 ZERO_HIT——那正是本片要消掉的噪声');
      assert.equal(judged.outOfRange, 0);
      assert.equal(judged.ambiguous, 0, '这里两侧间距不等（1 / 3 / 6），不该落进「等距不猜」');
      assert.deepEqual(misses, [], '配位正确 ⇒ 明细必须为空');
    },
  );
});

test('C24 一行两锚点 + 一个符号 ⇒ 一条配位、另一条退回「同行没有紧邻符号」（只计数、不判红）', () => {
  // 符号比锚点少时不许「一符号多配」：改前两条锚点都抢 `alphaHandler`，右锚点（`beta.ts`）稳定产出
  // 一条 `UNDECLARED／ZERO_HIT`。口径 ⑦ 让距离最近的那条（左锚点，间距 1）拿走符号，右锚点退回
  // 「同行没有紧邻符号」——只进那一格计数，不新增档位、不判红、不改 strict 的判红面。
  withFixture(
    {
      'services/api/src/alpha.ts': sourceWith('alphaHandler'),
      'services/api/src/beta.ts': sourceWith('betaHandler'),
      'docs/architecture/one-symbol.md':
        '# 一个符号\n\n- 实现见 `services/api/src/alpha.ts:2`（`alphaHandler`）见 `services/api/src/beta.ts:2`。\n',
    },
    root => {
      const { judged, misses, red } = coverageOf(root);
      assert.equal(judged.anchors, 2, '两条锚点都要扫到（不配对 ≠ 没扫到）');
      assert.equal(judged.paired, 1, '一个符号只配一条锚点');
      assert.equal(judged.ok, 1, '配对的是左锚点（间距 1）：右锚点的文件里没有 `alphaHandler`，若它抢到就是 UNDECLARED');
      assert.equal(judged.undeclared, 0);
      assert.equal(judged.outOfRange, 0);
      assert.equal(judged.unpaired, 1, '落选的锚点必须显式计数，不许静默少扫');
      assert.deepEqual(misses, []);
      assert.deepEqual(red, []);
    },
  );
});

test('C25 口径 ⑦ 不许把提交号拉回符号位：同一行「括注哈希 + 两条锚点」仍只配出正常那一对', () => {
  // 与 C21 同一形状，但同行还有一条会抢符号的锚点（`alpha.ts:2`）：它的左邻是 `（=`+哈希`）`，
  // 右邻是「；同句」隔开的 `alphaHandler`（列举分隔符挡掉）。哈希若被当成符号，左锚点就会配给
  // `de2aa3c6`（目标文件里 0 命中 ⇒ UNDECLARED），于是这条用例同时钉住两件事：
  // ⑧ 提交号不是符号、⑨ 一一配位不许把它绕回来。
  withFixture(
    {
      'services/api/src/alpha.ts': sourceWith('alphaHandler'),
      'services/api/src/beta.ts': sourceWith('alphaHandler'),
      'docs/architecture/hash-pair.md':
        '# 哈希配位\n\n- 合并 `upstream/main`（=`de2aa3c6`）见 `services/api/src/alpha.ts:2`；同句 `alphaHandler` 在 `services/api/src/beta.ts:2` 覆盖成立。\n',
    },
    root => {
      const { judged, misses } = coverageOf(root);
      assert.equal(judged.anchors, 2);
      assert.equal(judged.paired, 1, '只有 `alphaHandler` 那条配成对：哈希不是符号，左锚点退回计数');
      assert.equal(judged.ok, 1, '`alphaHandler` 声明在 `beta.ts` 第 1 行，块 1-3 盖住 :2 ⇒ OK');
      assert.equal(judged.undeclared, 0, '哈希若被拉回符号位，这里就是 1 条 ZERO_HIT');
      assert.equal(judged.unpaired, 1, '左锚点（`alpha.ts:2`）退回「同行没有紧邻符号」');
      assert.deepEqual(misses, []);
    },
  );
});

// —— verification 面的回归闸门（`--symbol-coverage-verification=off|count|strict`） ——————————
/** 闸门的扫描面：`docs/verification/**` 不在 `docs/architecture` 里，两面都要显式带上。 */
const GATE_SCAN = ['docs/architecture', 'docs/verification'];

/**
 * 子进程实跑，**stdout 与 stderr 分开收**：C26 要逐字比 stdout（新参数一开口多打一行就不叫零漂移），
 * 混进 WARN 或 FAIL 块会让「逐字相同」这条断言失去意义。
 */
function runCli(root, extraArgs = [], scans = GATE_SCAN) {
  const args = [TOOL, '--root', root];
  for (const scan of scans) args.push('--scan', scan);
  const result = spawnSync(process.execPath, [...args, ...extraArgs], { cwd: REPO_ROOT, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * 闸门夹具：verification 面 4 条配对 ＝ OK 1 ＋ 不在区间 2 ＋ UNDECLARED 1——**三个判定格正好铺满配对数**，
 * 这样「读数自校验」那条（`paired === OK ＋ 不在区间 ＋ UNDECLARED`）过得去，测的才是闸门本身。
 * ⛔ 不读仓内真实文档数：那串数字正在收敛（#978／#979／#981／#982 合入后「不在区间」还要降），
 * 把当期数字钉进用例，隔夜就陈旧、还得跟着改基线。
 */
function gateFixture() {
  return {
    'services/api/src/alpha.ts': sourceWith('alphaHandler'),
    // late／later 的声明都在第 21 行：锚点写 :2，距离远超 ±5 行 ⇒ 两条 OUT_OF_RANGE。
    'services/api/src/late.ts': `${'// 留白\n'.repeat(20)}${sourceWith('lateHandler')}`,
    'services/api/src/later.ts': `${'// 留白\n'.repeat(20)}${sourceWith('laterHandler')}`,
    'docs/architecture/within.md': '# 判据面\n\n- `alphaHandler`（`services/api/src/alpha.ts:2`）只做加一。\n',
    'docs/verification/page.md': [
      '# 取证',
      '',
      '- `alphaHandler`（`services/api/src/alpha.ts:2`）成立。',
      '- `lateHandler`（`services/api/src/late.ts:2`）行号漂走。',
      '- `laterHandler`（`services/api/src/later.ts:2`）行号漂走。',
      '- `ghostPage`（`services/api/src/alpha.ts:2`）已不存在。',
      '',
    ].join('\n'),
  };
}

/** 临时基线：路径就是工具缺省值（相对 `--root` 解析），内容由用例给，不读仓内那份。 */
function baselineFixture({ outOfRange, undeclared, paired = 4, baselineMain = '0'.repeat(40) }) {
  const body = {
    note: 'verification 面符号覆盖的回归闸门（只判上升；收敛期不逐条钉）',
    baselineMain,
    outOfRange,
    undeclared,
    paired,
  };
  return { 'tools/doc-anchors-symbol-coverage-verification-baseline.json': `${JSON.stringify(body, null, 2)}\n` };
}

test('C26 `count` 档（缺省）verification 的两行读数字面不变、exit 0（本片零输出漂移的回归防线）', () => {
  // 这条用例是「本片没改既有输出」的证据：新增的是**另一条参数**，它缺省为 `count`，所以既有命令的
  // stdout 必须逐字不变——两行读数的文案、全角标点、`（仅 WARN，不影响 exit code）` 后缀一个都不许动。
  // 一旦有人为了接闸门去改这两行，这条先红，而不是等 CI 的 `SYMBOL-COVERAGE-VERIFICATION` 读数悄悄变脸。
  withFixture(gateFixture(), root => {
    const defaults = runCli(root);
    assert.equal(defaults.status, 0, `缺省档不许改退出码，实际 stderr：\n${defaults.stderr}`);
    const explicit = runCli(root, ['--symbol-coverage-verification=count']);
    assert.equal(explicit.status, 0, `显式 count 同样不许判红，实际 stderr：\n${explicit.stderr}`);
    assert.equal(
      explicit.stdout,
      defaults.stdout,
      '显式写 `=count` 与不写必须逐字相同：缺省就是 count，写了这个开关也不许多打或少打一行',
    );
    assert.match(
      defaults.stdout,
      /^SYMBOL-COVERAGE-VERIFICATION: 可判 3 条——OK 1、符号不在区间 2（仅 WARN，不影响 exit code）$/m,
      '读数行逐字不变（连后缀「仅 WARN」都在：这是既有读数，判红改由另一行新参数负责）',
    );
    assert.ok(
      defaults.stdout.includes(
        'SYMBOL-COVERAGE-VERIFICATION-SCOPE: 作用域 docs/verification/**（1 份文档、锚点 4 条）——配成对 4 条：OK 1、符号不在区间 2、UNDECLARED 1（符号 0 命中 1 条、出现过但不是声明行 0 条）；同行没有紧邻符号 0 条、两侧等距不猜 0 条、路径找不到或不唯一 0 条、候选过滤 0 条、语言内建 0 条（后五格只计数）——本面三档一律不判红，strict 仍只判 docs/architecture/**',
      ),
      `SCOPE 行逐字不变（文案、两段分段、UN·DECLARED 明细都要对得上），实际输出：\n${defaults.stdout}`,
    );
    assert.doesNotMatch(
      defaults.stdout,
      /SYMBOL-COVERAGE-VERIFICATION-(GATE|REGRESSION|STALE|INCONSISTENT|NOTE)/,
      'count 档不许出现闸门的任何一行：那四行只在 `--symbol-coverage-verification=strict` 下才存在',
    );
  });
});

test('C27 `strict` 档：verification 的「不在区间」比基线多 2 ⇒ exit 1 且打 REGRESSION', () => {
  // 「只判上升」的最小形状：基线记 0，本次 2 条 ⇒ 回归。判红要**同时**满足 `--strict` 与
  // `--symbol-coverage-verification=strict`（与 `--symbol-coverage=strict` 的分工一致）。
  withFixture({ ...gateFixture(), ...baselineFixture({ outOfRange: 0, undeclared: 1 }) }, root => {
    const gate = runCli(root, ['--strict', '--symbol-coverage-verification=strict']);
    assert.equal(gate.status, 1, `计数比基线多必须 exit 1（否则这道闸门等于没装），实际 stdout：\n${gate.stdout}`);
    assert.match(
      gate.stdout,
      /^SYMBOL-COVERAGE-VERIFICATION-REGRESSION: 不在区间 0 → 2（基线 0）——/m,
      `要写清「哪一格、从几到几、基线几」，并说明为什么涨了就是回归，实际 stdout：\n${gate.stdout}`,
    );
    assert.doesNotMatch(gate.stdout, /SYMBOL-COVERAGE-VERIFICATION-STALE/, '上升就只报回归，不许同时报「低于基线」');
    assert.match(gate.stderr, /^FAIL: verification 符号覆盖回归闸门未通过/m, '判红的归纳行走 stderr（与既有 FAIL 块同一套）');
    assert.match(gate.stderr, /SYMBOL-COVERAGE-VERIFICATION-REGRESSION/, 'FAIL 块里要带上那条增量的原文');

    // 缺 `--strict`：读数照打、闸门照算，但**不改退出码**（本片只往 CI 那条带 `--strict` 的命令上加开关）。
    const notStrict = runCli(root, ['--symbol-coverage-verification=strict']);
    assert.equal(notStrict.status, 0, `没有 --strict 时闸门不许判红，实际 stdout：\n${notStrict.stdout}`);
    assert.match(notStrict.stdout, /SYMBOL-COVERAGE-VERIFICATION-REGRESSION/, '读数面上照样要看得见这条增量');

    // `--strict` 但这一面停在 count：判据不启用，退出码不许变（既有 CI 行为不受影响）。
    const countMode = runCli(root, ['--strict', '--symbol-coverage-verification=count']);
    assert.equal(countMode.status, 0, `count 档永不改退出码，实际 stderr：\n${countMode.stderr}`);
    assert.doesNotMatch(countMode.stdout, /SYMBOL-COVERAGE-VERIFICATION-REGRESSION/);
  });
});

test('C28 `strict` 档：计数低于基线只打 STALE、不判红（收敛期的有意差异）', () => {
  // verification 面仍在收敛：数字会**自己变小**（既有的取证页被修好、或 #978／#979 那批合入）。
  // 若照 architecture 面的「陈旧条目就判红」办，收敛期每一轮都会无端红一次——所以这里只提示收紧基线。
  withFixture({ ...gateFixture(), ...baselineFixture({ outOfRange: 4, undeclared: 1 }) }, root => {
    const gate = runCli(root, ['--strict', '--symbol-coverage-verification=strict']);
    assert.equal(gate.status, 0, `计数下降不许判红（这是本片与其它基线册的有意差异），实际 stdout：\n${gate.stdout}`);
    assert.match(
      gate.stdout,
      /^SYMBOL-COVERAGE-VERIFICATION-STALE: 不在区间 4 → 2（低于基线 4），可跑 --write-symbol-coverage-verification-baseline 收紧$/m,
      `提示里要给出「从几到几」与收紧命令，实际 stdout：\n${gate.stdout}`,
    );
    assert.doesNotMatch(gate.stdout, /SYMBOL-COVERAGE-VERIFICATION-REGRESSION/, '下降不是回归');
    assert.equal(gate.stderr, '', '不判红就一个字都不许写 stderr');
  });
});

test('C29 `--symbol-coverage-verification=off` 连两行一起关；写模式落盘且 baselineMain 是 40 位 sha', () => {
  withFixture(gateFixture(), root => {
    const off = runCli(root, ['--symbol-coverage-verification=off']);
    assert.equal(off.status, 0);
    assert.doesNotMatch(
      off.stdout,
      /SYMBOL-COVERAGE-VERIFICATION/,
      `off 档一行都不许留（读数、明细、闸门同进同出——留半行就看不出「这一面到底判没判」），实际 stdout：\n${off.stdout}`,
    );
    assert.match(
      off.stdout,
      /^SYMBOL-COVERAGE: 可判 1 条——OK 1、符号不在区间 0（仅 WARN，不影响 exit code）$/m,
      'architecture 那几行照旧：两条参数互不影响，关这一面不许顺手关掉另一面',
    );

    const baselinePath = join(root, 'tools', 'doc-anchors-symbol-coverage-verification-baseline.json');
    assert.equal(existsSync(baselinePath), false, '写模式之前不许有基线（否则测的是「覆盖写」而不是「落盘」）');
    const written = runCli(root, ['--write-symbol-coverage-verification-baseline']);
    assert.equal(written.status, 0, `写模式必须 exit 0，实际 stderr：\n${written.stderr}`);
    assert.match(
      written.stdout,
      /^WRITE: verification 符号覆盖基线已更新（outOfRange=2, undeclared=1, paired=4, baselineMain=[0-9a-f]{40}）$/m,
      `写模式只打这一行 WRITE（读数会淹掉「这次判没判」），实际 stdout：\n${written.stdout}`,
    );
    const parsed = JSON.parse(readFileSync(baselinePath, 'utf8'));
    assert.equal(parsed.outOfRange, 2, '落盘的是**实测**计数，不是抄来的数');
    assert.equal(parsed.undeclared, 1);
    assert.equal(parsed.paired, 4);
    assert.equal(parsed.note, 'verification 面符号覆盖的回归闸门（只判上升；收敛期不逐条钉）', '口径要写进账本：只判上升');
    assert.match(parsed.baselineMain, /^[0-9a-f]{40}$/, 'baselineMain 必须是 40 位 sha：取不到就报错退出，不许写假值');
    assert.equal(parsed.baselineMain, parsed.baselineMain.toLowerCase(), '小写十六进制（与 `git rev-parse` 一致）');

    // 刚写下的基线：当场持平 ⇒ 一行都不多打、exit 0（写模式与判据必须是同一把尺）。
    const gate = runCli(root, ['--strict', '--symbol-coverage-verification=strict']);
    assert.equal(gate.status, 0, `写完立刻跑必须绿，实际 stdout：\n${gate.stdout}`);
    assert.match(
      gate.stdout,
      /^SYMBOL-COVERAGE-VERIFICATION-GATE: 回归闸门已启用/m,
      'strict 档要先自述「这一行是新闸门」——上面两行写着「仅 WARN」，读者否则会以为工具自相矛盾',
    );
    assert.match(gate.stdout, /baselineMain=[0-9a-f]{40}/, 'GATE 行要带上「对着哪棵树量的」');
    assert.doesNotMatch(
      gate.stdout,
      /SYMBOL-COVERAGE-VERIFICATION-(REGRESSION|STALE|INCONSISTENT|NOTE)/,
      '持平就是一句话都不多说：这三个词只在真的升／降／矛盾／缺基线时出现',
    );
  });
});

// —— 机器可读明细报表（`--symbol-coverage-report=<路径>`） ——————————————————————————————
/**
 * 报表夹具：**两面都非空**、三个子档全出现，配对总数也非 0——这样「`items` 条数 ＝ outOfRange ＋
 * undeclared」「两类 kind 都在」「三个子档都在」「按 (doc,line) 升序」几条才都测得到。
 * 面的账：architecture ＝ OK 0 ＋ 不在区间 1 ＋ UNDECLARED 3（ZERO_HIT 2、NO_DECLARATION 1）；
 *        verification ＝ OK 1 ＋ 不在区间 1 ＋ UNDECLARED 1（ZERO_HIT 1）。
 * ⛔ 不读仓内真实文档的计数：那串数字正在收敛，钉进用例隔夜就陈旧。
 */
function reportFixture() {
  return {
    'services/api/src/alpha.ts': sourceWith('alphaHandler'),
    // late.ts 的声明在 21-23 行：锚点写 :2 ⇒ 远超 ±5 行，落 OUT_OF_RANGE（子档 SYMBOL_NOT_IN_RANGE）。
    'services/api/src/late.ts': `${'// 留白\n'.repeat(20)}${sourceWith('lateHandler')}`,
    // beta.ts 里 `gammaFlag` **只出现在第 1 行注释**里（命中 1 次、0 行声明），锚点却写 :22——
    // 距离远超 ±5 行，落不进「符号本身就在区间附近」这条豁免 ⇒ UNDECLARED／NO_DECLARATION。
    'services/api/src/beta.ts': `// gammaFlag 只在注释里出现，不是声明\n${'// 留白\n'.repeat(20)}export const betaValue = 1;\n`,
    // 文件名字典序是 alpha < zulu，但把 zulu 写在前面：排序必须由报表自己做，不能靠遍历顺序碰运气。
    'docs/architecture/zulu.md': [
      '# 乙',
      '',
      '- `lateHandler`（`services/api/src/late.ts:2`）行号漂走。',
      '- `gammaFlag`（`services/api/src/beta.ts:22`）只是注释里的词。',
      '- `missingOne`（`services/api/src/alpha.ts:9`）已不存在。',
      '',
    ].join('\n'),
    'docs/architecture/alpha.md': [
      '# 甲',
      '',
      '- `ghostArch`（`services/api/src/late.ts:2`）已不存在。',
      '',
    ].join('\n'),
    'docs/verification/page.md': [
      '# 取证',
      '',
      '- `alphaHandler`（`services/api/src/alpha.ts:2`）成立。',
      '- `lateHandler`（`services/api/src/late.ts:2`）行号漂走。',
      '- `ghostPage`（`services/api/src/alpha.ts:2`）已不存在。',
      '',
    ].join('\n'),
  };
}

/** 三个子档的取值域：报表里的 `reason` 只能是这三者之一（`kind` 只有两类）。 */
const REPORT_REASONS = new Set([SYMBOL_COVERAGE_NOT_IN_RANGE, SYMBOL_COVERAGE_ZERO_HIT, SYMBOL_COVERAGE_NO_DECLARATION]);

/** `(doc, line)` 升序检查（与报表同口径：doc 在前、行号在后）。 */
function reportItemsAscending(items) {
  return items.every((item, index) => {
    if (index === 0) return true;
    const previous = items[index - 1];
    if (previous.doc !== item.doc) return previous.doc < item.doc;
    return previous.line <= item.line;
  });
}

test('C30 不开 `--symbol-coverage-report` ⇒ 不多打 REPORT 行、不落文件（缺省零副作用）', () => {
  withFixture(reportFixture(), root => {
    const reportPath = join(root, 'out', 'symbol-coverage.json');
    const plain = runCli(root);
    assert.equal(plain.status, 0, `缺省档必须 exit 0，实际 stderr：\n${plain.stderr}`);
    assert.doesNotMatch(
      plain.stdout,
      /SYMBOL-COVERAGE-REPORT/,
      `缺省不许多出这一行：这是本开关在 stdout 上唯一的痕迹，多一行就等于改既有读数，实际 stdout：\n${plain.stdout}`,
    );
    assert.equal(existsSync(join(root, 'out')), false, '缺省连父目录都不许建（`fs` 一次都不该碰）');
    assert.equal(existsSync(reportPath), false, '缺省不写文件');
    // 既有读数照打：本开关缺省 = **完全不存在**，不是「悄悄换了输出」。
    assert.match(
      plain.stdout,
      /^SYMBOL-COVERAGE: 可判 1 条——OK 0、符号不在区间 1（仅 WARN，不影响 exit code）$/m,
      `architecture 那几行照旧，实际 stdout：\n${plain.stdout}`,
    );
    assert.match(
      plain.stdout,
      /^SYMBOL-COVERAGE-VERIFICATION: 可判 2 条——OK 1、符号不在区间 1（仅 WARN，不影响 exit code）$/m,
      `verification 那几行照旧，实际 stdout：\n${plain.stdout}`,
    );
  });
});

test('C31 开了开关 ⇒ 落盘稳定排序的 JSON 明细，条数与同次读数逐格自洽、其余输出一字不动', () => {
  withFixture(reportFixture(), root => {
    // 父目录**故意**不存在：`--symbol-coverage-report=out/…` 不许因为缺目录就失败。
    const reportPath = join(root, 'out', 'symbol-coverage.json');
    const before = runCli(root);
    const run = runCli(root, [`--symbol-coverage-report=${reportPath}`]);
    assert.equal(run.status, 0, `开关不许改退出码（这是产物，不是判据），实际 stderr：\n${run.stderr}`);
    assert.equal(run.status, before.status, '开与不开的退出码必须相同');

    const reportLines = run.stdout.split('\n').filter(line => line.startsWith('SYMBOL-COVERAGE-REPORT: '));
    assert.equal(reportLines.length, 1, `只许多这一行，实际 stdout：\n${run.stdout}`);
    assert.equal(
      reportLines[0],
      `SYMBOL-COVERAGE-REPORT: 已写出 6 条明细（architecture 4 条 ＋ verification 2 条）→ ${reportPath}`,
      '前缀固定、两面条数分开点名、路径是解出来的绝对路径',
    );
    assert.equal(
      run.stdout.replace(`${reportLines[0]}\n`, ''),
      before.stdout,
      '除这一行外 stdout 必须**逐字**相同（开关只加产物，不动读数）',
    );

    assert.equal(existsSync(reportPath), true, '文件必须落盘（父目录不存在时要自动建）');
    const raw = readFileSync(reportPath);
    assert.equal(raw[0], 0x7B, '不带 BOM：第一个字节就是 `{`');
    assert.equal(raw[raw.length - 1], 0x0A, '以换行结尾（`fs.writeFileSync` 写的是补过 `\\n` 的正文）');
    const body = JSON.parse(raw.toString('utf8'));

    assert.equal(body.generatedBy, 'tools/verify-doc-anchors.mjs --symbol-coverage-report');
    assert.deepEqual(body.scan, ['docs/architecture', 'docs/verification'], '扫描面照实记（下家要能复现）');
    assert.equal(body.scanRoot, null, '两个扫描目标 ⇒ `scanRoot` 为 null（单一目标才给字符串，不许忽类型）');

    // ① 与**同一次运行**打出来的读数行逐格对齐（报表的全部意义就是「和上面那几行对得上」）。
    const architectureLine = /^SYMBOL-COVERAGE: 可判 (\d+) 条——OK (\d+)、符号不在区间 (\d+)/m.exec(run.stdout);
    const verificationLine = /^SYMBOL-COVERAGE-VERIFICATION: 可判 (\d+) 条——OK (\d+)、符号不在区间 (\d+)/m.exec(run.stdout);
    assert.notEqual(architectureLine, null, 'architecture 读数行要在');
    assert.notEqual(verificationLine, null, 'verification 读数行要在');
    assert.deepEqual(
      [body.architecture.judged, body.architecture.ok, body.architecture.outOfRange],
      architectureLine.slice(1, 4).map(Number),
      'architecture 三格与 `SYMBOL-COVERAGE:` 行同值',
    );
    assert.deepEqual(
      [body.verification.judged, body.verification.ok, body.verification.outOfRange],
      verificationLine.slice(1, 4).map(Number),
      'verification 三格与 `SYMBOL-COVERAGE-VERIFICATION:` 行同值',
    );
    assert.match(
      run.stdout,
      /UNDECLARED 1（符号 0 命中 1 条、出现过但不是声明行 0 条）/,
      'verification 的 UNDECLARED 子档与 `-SCOPE` 行同值',
    );
    assert.equal(body.verification.undeclaredZeroHit, 1);
    assert.equal(body.verification.undeclaredNonDeclaration, 0);
    assert.ok(
      run.stdout.includes('UNDECLARED: 3 条（符号在目标文件里没有声明行；不计入 strict 判定，逐条抽样见下）——其中符号 0 命中 2 条、出现过但不是声明行 1 条'),
      `architecture 的 UNDECLARED 子档与报表同值（那个 1 就是 NO_DECLARATION），实际 stdout：\n${run.stdout}`,
    );
    assert.equal(body.architecture.undeclaredZeroHit, 2);
    assert.equal(body.architecture.undeclaredNonDeclaration, 1);

    // ② 每面：items 不是抽样，`outOfRange + undeclared` 条一条不少。
    for (const face of [body.architecture, body.verification]) {
      assert.equal(face.judged, face.ok + face.outOfRange, '`judged` 与读数行同口径（ok ＋ outOfRange）');
      assert.equal(
        face.items.length,
        face.outOfRange + face.undeclared,
        '明细条数必须等于 outOfRange ＋ undeclared（这是这张报表存在的理由：不用再复刻配对逻辑）',
      );
      assert.equal(face.undeclaredZeroHit + face.undeclaredNonDeclaration, face.undeclared, '两个子档加起来就是 UNDECLARED');
      assert.ok(reportItemsAscending(face.items), `必须按 (doc, line) 升序：${JSON.stringify(face.items.map(item => [item.doc, item.line]))}`);
      for (const item of face.items) {
        assert.match(item.doc, /^docs\/(architecture|verification)\/[\w./-]+\.md$/, `doc 是仓库相对 posix 路径：${item.doc}`);
        assert.equal(Number.isInteger(item.line) && item.line > 0, true, `line 是正整数：${item.line}`);
        assert.equal(item.target.includes(':'), false, `target 只放文件路径，行号已拆进 from／to：${item.target}`);
        assert.equal(Number.isInteger(item.from) && item.from > 0, true, `from 是正整数：${item.from}`);
        assert.equal(Number.isInteger(item.to) && item.to >= item.from, true, `to ≥ from：${item.from}-${item.to}`);
        assert.equal(item.kind === SYMBOL_COVERAGE_OUT_OF_RANGE || item.kind === SYMBOL_COVERAGE_UNDECLARED, true, `kind 只有两类：${item.kind}`);
        assert.equal(REPORT_REASONS.has(item.reason), true, `reason 只能是三个子档之一：${item.reason}`);
        assert.equal(typeof item.note, 'string', '解析器原话留在 note（哪怕是空串）');
      }
    }

    // ③ 排序与分类的**逐条**期望（顺序、kind、子档一起钉住：单看升序发现不了「子档串了」）。
    const digest = items => items.map(item => `${item.doc}:${item.line}:${item.kind}:${item.reason}`);
    assert.deepEqual(digest(body.architecture.items), [
      'docs/architecture/alpha.md:3:UNDECLARED:ZERO_HIT',
      'docs/architecture/zulu.md:3:OUT_OF_RANGE:SYMBOL_NOT_IN_RANGE',
      'docs/architecture/zulu.md:4:UNDECLARED:NO_DECLARATION',
      'docs/architecture/zulu.md:5:UNDECLARED:ZERO_HIT',
    ], 'architecture 面：doc → 行号升序，OUT_OF_RANGE 补子档 SYMBOL_NOT_IN_RANGE，UNDECLARED 分两档');
    assert.deepEqual(digest(body.verification.items), [
      'docs/verification/page.md:4:OUT_OF_RANGE:SYMBOL_NOT_IN_RANGE',
      'docs/verification/page.md:5:UNDECLARED:ZERO_HIT',
    ], 'verification 面同理（OK 的配对不进明细）');
    assert.deepEqual(
      [...new Set([...body.architecture.items, ...body.verification.items].map(item => item.reason))].sort(),
      [SYMBOL_COVERAGE_NO_DECLARATION, SYMBOL_COVERAGE_NOT_IN_RANGE, SYMBOL_COVERAGE_ZERO_HIT].sort(),
      '三个子档必须都出现（这份夹具就是为「按子档分组批量修」准备的）',
    );

    const drifted = body.verification.items[0];
    assert.deepEqual(
      { target: drifted.target, from: drifted.from, to: drifted.to, symbol: drifted.symbol },
      { target: 'services/api/src/late.ts', from: 2, to: 2, symbol: 'lateHandler' },
      '单行锚点：from ＝ to ＝ 2，符号与目标文件都照实记',
    );
  });
});

test('C32 `--symbol-coverage=off` ＋ 报表开关 ⇒ 用法错误 exit 2、不落文件（报错而非静默忽略）', () => {
  // 为什么选「报错」：`off` 的语义是「这次不做符号覆盖统计」，此时没有明细可写；忽略掉却照样退出 0，
  // 下家会去读上一轮留下的旧文件（或压根不存在的文件），拿旧明细去修新代码——比当场失败贵得多。
  withFixture(reportFixture(), root => {
    const reportPath = join(root, 'out', 'symbol-coverage.json');
    const run = runCli(root, ['--symbol-coverage=off', `--symbol-coverage-report=${reportPath}`]);
    assert.equal(run.status, 2, `参数互斥走 exit 2（与其它用法错误同档），实际 stdout：\n${run.stdout}`);
    assert.match(
      run.stderr,
      /--symbol-coverage-report 与 --symbol-coverage=off 互斥/,
      `报错要说清是哪一对互斥、该怎么办，实际 stderr：\n${run.stderr}`,
    );
    assert.match(run.stderr, /usage: node tools\/verify-doc-anchors\.mjs/, '用法错误带 USAGE（与其它参数校验同一形态）');
    assert.equal(existsSync(reportPath), false, '被拒的组合不许留下文件');
    assert.doesNotMatch(run.stdout, /SYMBOL-COVERAGE-REPORT/, '没写成就不许打「已写出」');
  });
});

test('C33 `renderSymbolCoverageReport` 只重组不重判：乱序输入仍按 (doc,line) 排序、子档补齐、不改调用方数组', () => {
  // 走渲染函数而不是子进程：夹具里文档的遍历顺序与行号本来就是升序，光看 CLI 产物分不出「排过序」还是
  // 「本来就这么巧」。这里手给一份**乱序**明细，排序没实现就必红。
  const misses = [
    {
      doc: 'docs/architecture/zulu.md',
      docLine: 9,
      target: 'services/api/src/late.ts:12-20',
      symbol: 'lateHandler',
      result: SYMBOL_COVERAGE_OUT_OF_RANGE,
      detail: null,
      reason: 'NO_BLOCK：符号在第 12 行是声明但没有块体',
    },
    {
      doc: 'docs/architecture/alpha.md',
      docLine: 7,
      target: 'services/api/src/alpha.ts:3',
      symbol: 'alphaHandler',
      result: SYMBOL_COVERAGE_UNDECLARED,
      detail: SYMBOL_COVERAGE_NO_DECLARATION,
      reason: 'NO_DECLARATION：符号在目标文件里出现 2 次，没有一处是声明行',
    },
    {
      doc: 'docs/architecture/alpha.md',
      docLine: 2,
      target: 'services/api/src/alpha.ts:1',
      symbol: 'ghostHandler',
      result: SYMBOL_COVERAGE_UNDECLARED,
      detail: SYMBOL_COVERAGE_ZERO_HIT,
      reason: 'ZERO_HIT：符号在目标文件里出现 0 次',
    },
  ];
  const coverage = {
    judged: { ok: 1, outOfRange: 1, undeclared: 2, zeroHit: 1, noDeclaration: 1, paired: 4 },
    verification: { ok: 0, outOfRange: 0, undeclared: 0, zeroHit: 0, noDeclaration: 0, paired: 0 },
    misses,
    verificationMisses: [],
  };

  const single = renderSymbolCoverageReport({ coverage, scan: ['docs'] });
  assert.equal(single.endsWith('\n'), true, '正文以换行结尾（写盘直接落字节，不靠调用方补）');
  const body = JSON.parse(single);
  assert.equal(body.scanRoot, 'docs', '单一扫描目标 ⇒ `scanRoot` 就是那个目标（与读数行同口径）');
  assert.deepEqual(body.scan, ['docs']);
  assert.deepEqual(
    body.architecture.items.map(item => `${item.line}:${item.reason}`),
    ['2:ZERO_HIT', '7:NO_DECLARATION', '9:SYMBOL_NOT_IN_RANGE'],
    '按 doc → 行号重排，与输入顺序（9,7,2）无关',
  );
  const ranged = body.architecture.items[2];
  assert.deepEqual(
    { target: ranged.target, from: ranged.from, to: ranged.to },
    { target: 'services/api/src/late.ts', from: 12, to: 20 },
    '`from-to` 拆成两个数（区间锚点不是「把 :12-20 当文件名」）',
  );
  assert.equal(ranged.note, 'NO_BLOCK：符号在第 12 行是声明但没有块体', '解析器原话留在 note（不许被吞掉）');
  assert.equal(ranged.reason, SYMBOL_COVERAGE_NOT_IN_RANGE, '`detail` 为 null 的 OUT_OF_RANGE 补子档 SYMBOL_NOT_IN_RANGE');
  assert.equal(body.architecture.judged, 2, 'judged ＝ ok ＋ outOfRange（与 `SYMBOL-COVERAGE: 可判 N 条` 同口径）');
  assert.equal(body.architecture.paired, 4, 'paired 照搬 tally（下家要能算「明细 ÷ 配对」）');
  assert.equal(body.architecture.items.length, body.architecture.outOfRange + body.architecture.undeclared);
  assert.deepEqual(body.verification.items, [], '这一面没有明细就是空数组（不是 null、不是缺字段）');
  assert.equal(body.verification.outOfRange + body.verification.undeclared, 0);

  const multi = JSON.parse(renderSymbolCoverageReport({ coverage, scan: ['docs/architecture', 'docs/verification'] }));
  assert.equal(multi.scanRoot, null, '多目标 ⇒ null');
  assert.deepEqual(multi.scan, ['docs/architecture', 'docs/verification'], '完整清单落在 scan 里');

  assert.deepEqual(misses.map(item => item.docLine), [9, 7, 2], '渲染是纯函数：不许就地排序调用方给的数组（那份还要给读数行用）');
});

test('C34 候选位上的汉语短语／保留字不算候选：候选过滤 +1、unpaired 增 1、undeclared 不变（口径 ⑧）', () => {
  // 真实形状：`docs/implementation-requirements.md:278` 把 `` `delete` `` 紧挨着写在锚点旁，于是这一对
  // 稳定产出 `UNDECLARED／ZERO_HIT`——目标文件里当然没有「`delete` 的声明行」。这类候选（汉语短语、
  // 路径片段、JSON 值、保留字）**从来不是**任何文件的符号，却在读数里冒充「文档漏写了符号」。
  // 口径 ⑧ 在**抽候选之前**就丢掉它们，只留一格「候选过滤」计数（单位是候选位次，见工具注释）。
  const phrase = '# 短语\n\n- `符号声明块`（`services/api/src/alpha.ts:2`）见下。\n';
  withFixture(
    {
      'services/api/src/alpha.ts': sourceWith('alphaHandler'),
      'docs/architecture/phrase.md': phrase,
    },
    root => {
      const { judged, misses, red } = coverageOf(root);
      assert.equal(judged.anchors, 1, '锚点照样扫到（不配对 ≠ 没扫到）');
      assert.equal(judged.candidatesFiltered, 1, '候选位上的汉语短语记进「候选过滤」');
      assert.equal(judged.paired, 0, '非标识符不是候选 ⇒ 不配成对');
      assert.equal(judged.unpaired, 1, '锚点仍落「同行没有紧邻符号」：这一行确实没写符号（口径 ⑧ 不新增「无候选」档）');
      assert.equal(judged.undeclared, 0, '没配成对就不该冒出 UNDECLARED（改前这段也进不了候选位，读数不许因此变）');
      assert.equal(judged.outOfRange, 0);
      assert.equal(judged.builtin, 0, '汉语短语不是内建 API：不许串档');
      assert.deepEqual(misses, [], '被过滤的候选不进明细（明细只装真的配成对、判不上的）');
      assert.deepEqual(red, []);
      assert.match(
        runTool(root).text,
        /同行没有紧邻符号 1 条、两侧等距不猜 0 条、路径找不到或不唯一 0 条、候选过滤 1 条、语言内建 0 条（这五格只计数，不进上面两档）/,
        'SCOPE 行必须把「候选过滤」摆出来：过滤本身不许变成静默少扫',
      );
    },
  );

  // 保留字那一半（本片唯一**真的**会改判定的形状）：`delete` 是标识符形状，所以改前它会进候选位、
  // 配成对，再因为目标文件里没有它的声明行而落 `UNDECLARED／ZERO_HIT`（本仓 architecture 面 2 条）。
  withFixture(
    {
      'services/api/src/alpha.ts': sourceWith('alphaHandler'),
      'docs/architecture/reserved.md': '# 保留字\n\n- `delete`（`services/api/src/alpha.ts:2`）的语义见下。\n',
    },
    root => {
      const { judged, misses } = coverageOf(root);
      assert.equal(judged.candidatesFiltered, 1, '保留字同样记进「候选过滤」');
      assert.equal(judged.paired, 0, '它不再进候选位（改前会配成对）');
      assert.equal(judged.undeclared, 0, '因此也不再有那条 UNDECLARED／ZERO_HIT');
      assert.equal(judged.unpaired, 1, '退回「同行没有紧邻符号」只计数');
      assert.deepEqual(misses, []);
    },
  );

  // 对照：同一位置换成**以保留字开头**的普通标识符 ⇒ 一个字都不许过滤，照旧判 OK。
  // 没有这一条，`startsWith('delete')` 那种写法的实现也能让上面两段通过。
  withFixture(
    {
      'services/api/src/alpha.ts': sourceWith('deleteAll'),
      'docs/architecture/reserved.md': '# 保留字\n\n- `deleteAll`（`services/api/src/alpha.ts:2`）的语义见下。\n',
    },
    root => {
      const { judged } = coverageOf(root);
      assert.equal(judged.candidatesFiltered, 0, '`deleteAll` 不是保留字：一个字都不该被过滤');
      assert.equal(judged.paired, 1, '照旧配成对');
      assert.equal(judged.ok, 1, '声明覆盖锚点 ⇒ OK（过滤不许外溢到真实符号）');
    },
  );
});

test('C35 候选位上是内建／全局对象的方法访问 ⇒ 单列 `BUILTIN`，不计入 UNDECLARED（口径 ⑨）', () => {
  // `Array.isArray`／`Promise.all` 这类片段 `COVERAGE_SYMBOL_SPAN` 本来就不收（含 `.`），于是锚点落进
  // 「同行没有紧邻符号」——计数不算错，但和「这一行真的没写符号」混在一格，读不出比例（审计时正是
  // 靠人眼才把这一类分出来）。口径 ⑨ 单列 `BUILTIN`：**只计数**，既不判红，也不进 UNDECLARED／OK。
  withFixture(
    {
      'services/api/src/alpha.ts': sourceWith('alphaHandler'),
      'docs/architecture/builtin.md': '# 内建\n\n- `Array.isArray`（`services/api/src/alpha.ts:2`）在入口先挡一层。\n',
    },
    root => {
      const { judged, misses, red } = coverageOf(root);
      assert.equal(judged.anchors, 1);
      assert.equal(judged.builtin, 1, '内建 API 的调用位记进 BUILTIN');
      assert.equal(judged.paired, 0, '它不进候选位（含 `.`，本来也进不了）');
      assert.equal(judged.unpaired, 0, 'BUILTIN 与「同行没有紧邻符号」分开：这一行确实写了符号位');
      assert.equal(judged.undeclared, 0, 'BUILTIN 不计入 UNDECLARED（本片不许把它改判成判据档）');
      assert.equal(judged.outOfRange, 0);
      assert.equal(judged.candidatesFiltered, 0, '内建不是「候选过滤」：它被识别出来单列，不是被丢掉');
      assert.deepEqual(misses, [], 'BUILTIN 不出明细（它不是判定结果）');
      assert.deepEqual(red, [], 'BUILTIN 不判红');
      assert.match(
        runTool(root).text,
        /候选过滤 0 条、语言内建 1 条（这五格只计数，不进上面两档）/,
        'SCOPE 行要有「语言内建」这一格',
      );
      // 锚点守恒：anchors ＝ 配成对 ＋ 同行没有紧邻符号 ＋ 两侧等距 ＋ 路径解析不了 ＋ BUILTIN。
      assert.equal(
        judged.paired + judged.unpaired + judged.ambiguous + judged.unresolved + judged.builtin,
        judged.anchors,
        '五个出口必须铺满锚点数（BUILTIN 是从「同行没有紧邻符号」里搬出来的，不是凭空多出来的）',
      );
    },
  );

  // 对照：同一位置换成**普通标识符**（目标文件里没有）⇒ 照旧 UNDECLARED，不许被 BUILTIN 吃掉。
  withFixture(
    {
      'services/api/src/alpha.ts': sourceWith('alphaHandler'),
      'docs/architecture/builtin.md': '# 内建\n\n- `ghostSymbol`（`services/api/src/alpha.ts:2`）在入口先挡一层。\n',
    },
    root => {
      const { judged } = coverageOf(root);
      assert.equal(judged.builtin, 0, '`ghostSymbol` 不是内建：不许串档');
      assert.equal(judged.undeclared, 1, '普通标识符照旧判 UNDECLARED');
    },
  );
});

test('C36 普通标识符只在目标文件的调用位出现 ⇒ 仍是 UNDECLARED（口径 ⑧ 不许把合法判据一起滤掉）', () => {
  // 这条是 ⑧ 的反向守卫：过滤只认「整段不是标识符」与「整段是保留字」。审计里另有约 115 条是
  // 「符号真实存在、只是写在调用／注册／字面量位」——那批**不许**改判 OK（会削弱判据），也不许被
  // 新的过滤顺手滤掉。这里就是它的最小形状：`requireScope` 在目标文件第 21 行被调用，没有声明行。
  const beta = `${'// 留白\n'.repeat(19)}export function caller(count) {\n  return requireScope(count);\n}\n`;
  withFixture(
    {
      'services/api/src/beta.ts': beta,
      'docs/architecture/callsite.md': '# 调用位\n\n- `requireScope`（`services/api/src/beta.ts:2`）在入口处取作用域。\n',
    },
    root => {
      const { judged, misses, red } = coverageOf(root);
      assert.equal(judged.candidatesFiltered, 0, '`requireScope` 是合法标识符：不许被过滤');
      assert.equal(judged.builtin, 0, '也不是内建 API');
      assert.equal(judged.paired, 1, '照旧配成对（配对器一个字都没动）');
      assert.equal(judged.undeclared, 1, '符号出现过、但没有一处是声明行 ⇒ 仍是 UNDECLARED');
      assert.equal(judged.zeroHit, 0, '它在目标文件里出现过 ⇒ 不是 ZERO_HIT');
      assert.equal(judged.noDeclaration, 1, '子档是「出现过但不是声明行」');
      assert.equal(judged.ok, 0, '⛔ 不许改判 OK：这正是本片明确不许碰的那一格');
      assert.equal(judged.outOfRange, 0);
      assert.deepEqual(red, [], 'UNDECLARED 不进判红面（与既有口径一致）');
      assert.equal(misses.length, 1, '明细里必须看得见它（只计数、但一直可见）');
      assert.equal(misses[0].symbol, 'requireScope');
      assert.equal(misses[0].detail, SYMBOL_COVERAGE_NO_DECLARATION);
      // strict 档照旧 exit 0：UNDECLARED 不判红——守卫不许把「只计数」的档变成红。
      const strict = runTool(root, ['--strict', '--symbol-coverage=strict']);
      assert.equal(strict.status, 0, `UNDECLARED 不判红，实际输出：\n${strict.text}`);
    },
  );
});

