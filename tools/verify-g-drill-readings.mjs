#!/usr/bin/env node
/**
 * G 片（GY-R68-G）· **机器可复算闸门**：把证据页里的标记块与「从树现场重算出来的块」整块比对。
 *
 * 两种模式：
 *   `--check`（默认）  重算 → 与文档标记块**逐行比对（规范化之后）** → 不一致 **exit 1** 并点名第一处差异
 *   `--update`          只重写标记块内部（块外散文一个字都不碰），读数取自 `readings.json`
 *   `--live`            只重算「可复算类」（静态闸门那 11 条）并与块里的 exit / 读数逐条对照
 *
 * 八条判据（每条都能单独红、且报错**点名**）：
 *   1 标记块唯一            2 整块逐行比对（规范化后） 3 出处双向（命令 ↔ package.json/workflow）
 *   4 反空转下界（>=）       5 算术自洽              6 一次性读数三件套（sha/host/ISO 且 sha 是 HEAD 祖先）
 *   7 不许写「CI 已绿」      8 真空项显式化（未跑：原因）
 *
 * 判据 2 内部再按**读数分档**判（分档表在 `tools/lib/g-drill-readings.mjs`）：
 *   · 稳定型（workflow / job / 演练命令数 / 页面数）——**精确相等**，两种口径都一样；
 *   · 生长型（测试文件数、五条 glob 的分文件数、脚本数、真库臂数）——**下界语义**：
 *     `--tolerant-growth`（默认）下允许「文档值 < 重算值」（main 前进的必然结果）并逐行打印「滞后 N」；
 *     `--strict-growth` 要求精确相等；`文档值 > 重算值`（冒进）在两种口径下都红——防注水的主牙齿。
 *     `--update` 一律写**精确**重算值（新生成的块不带滞后）。
 *
 * ⛔ 期望值**不得**来自任何已提交的 JSON 或文档自身：可复算类每次从树重算，一次性类只校形状。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DOC_PATH,
  DRILL_PLAN,
  GDrillError,
  armCoverageProblems,
  arithmeticProblems,
  assertNonVacuous,
  ciGreenProblems,
  collectSources,
  computeTreeReadings,
  coverageProblems,
  diffDrillBlock,
  growthLag,
  makeRow,
  oneShotProblems,
  parseDrillBlock,
  plannedCommands,
  readingsProblems,
  renderDifference,
  renderDrillBlock,
  rowCommandProblems,
  traceCommand,
  vacuousProblems,
} from './lib/g-drill-readings.mjs';
import { runDrillPlan, readSha } from './collect-g-drill.mjs';

export const TOOL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = [
  '用法：node tools/verify-g-drill-readings.mjs [--check|--update|--live] [--root <树>] [--doc <路径>] [--readings <路径>]',
  '',
  '  --check（默认） 重算并整块逐行比对（CRLF→LF、去行尾空白、去尾部空行之后）；不一致 exit 1',
  '  --update        用 <readings.json> 重写标记块内部（块外不动）；块里写**精确**重算值',
  '  --live          只重算「可复算类」（静态闸门 11 条）并对照块里的 exit / 读数',
  '  --root <目录>    被检查的树（夹具树做负例时用；默认本脚本所在仓库根）',
  '  --doc <路径>     证据页路径（默认 <root>/' + DOC_PATH + '）',
  '  --readings <路径> 演练读数 JSON（默认 $env:TEMP\\gy-g-drill\\<sha>\\readings.json）',
  '',
  '生长型读数的两种口径（`--check` 用；分档见 tools/lib/g-drill-readings.mjs 的 STABLE_READINGS / GROWTH_READINGS）：',
  '  --tolerant-growth（默认） 生长型读数（测试文件数 / 五条 glob 的分文件数 / 脚本数 / 真库臂数）按**下界**判：',
  '                            文档值 <= 重算值即成立；滞后**逐行打印**「滞后 N」，不静默；',
  '                            稳定型读数（workflow / job / 演练命令数 / 页面数）仍要求**精确相等**。',
  '                            两种口径下，「文档值 > 重算值」（冒进）都红——这是防注水的主牙齿。',
  '  --strict-growth           只允许精确：生长型读数也必须与重算值逐字相等。',
  '',
  '退出码：0 = 全部判据通过（`--live` 下还要求没有任何静态闸门被跳过）；',
  '        1 = 至少一条判据红（输出会点名是哪条、哪一行）；',
  '        2 = 仅 `--live`：有静态闸门因环境缺失没跑成（按 SKIP 计——这不是通过，看末行点名了几条）。',
].join('\n');

/** 判据名（报错文案与单测断言共用这一份，避免两边措辞漂）。 */
export const CRITERIA = Object.freeze({
  1: '标记块唯一',
  2: '整块逐行比对（规范化后）',
  3: '出处双向（命令 ↔ package.json/workflow）',
  4: '反空转下界（>=）',
  5: '算术自洽',
  6: '一次性读数三件套（sha/host/ISO，sha 须为 HEAD 祖先）',
  7: '不许写「CI 已绿」',
  8: '真空项显式化（未跑：原因）',
});

/** 解析参数。 */
export function parseArgs(argv) {
  const options = { mode: 'check', root: TOOL_ROOT, doc: null, readings: null, tolerantGrowth: true, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') options.mode = 'check';
    else if (arg === '--update') options.mode = 'update';
    else if (arg === '--live') options.mode = 'live';
    else if (arg === '--tolerant-growth') options.tolerantGrowth = true;
    else if (arg === '--strict-growth') options.tolerantGrowth = false;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--root' || arg === '--doc' || arg === '--readings') {
      const value = argv[i + 1];
      if (!value) throw new GDrillError(`${arg} 需要一个参数`);
      const key = arg.slice(2);
      options[key] = resolve(value);
      i += 1;
    } else if (arg.startsWith('--root=') || arg.startsWith('--doc=') || arg.startsWith('--readings=')) {
      const [key, value] = [arg.slice(2, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)];
      options[key] = resolve(value);
    } else {
      throw new GDrillError(`未知参数：${arg}`);
    }
  }
  return options;
}

/** `git merge-base --is-ancestor <sha> HEAD`：`true` / `false` / `null`＝无法判断（不是 git 仓库等）。 */
export function makeAncestorCheck(root) {
  return (sha) => {
    if (!/^[0-9a-f]{40}$/.test(sha)) return null;
    const result = spawnSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { cwd: root, windowsHide: true });
    if (result.status === 0) return true;
    if (result.status === 1) return false;
    return null;
  };
}

/** 读一个文件，读不到返回 `null`。 */
function readIfExists(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** 把「问题清单」包成 `{criterion, message}`（一条判据可能红多处）。 */
function tag(criterion, problems) {
  return problems.map((message) => ({ criterion, name: CRITERIA[criterion], message }));
}

/**
 * **全部八条判据**跑一遍，返回 `{ ok, problems, tree, doc, expected, growth }`。
 * 纯函数（只读树与文档；`isAncestor` 由调用方注入）⇒ 单测可以直接喂夹具树 + 夹具文档。
 *
 * `tolerantGrowth`（默认 `true` = `--tolerant-growth`）：生长型读数按**下界**判、滞后进 `growth`
 * 由 CLI 逐行打印；`false`（`--strict-growth`）要求精确相等。稳定型读数两种模式都要求精确相等。
 */
export function checkDocument({ root, docText, isAncestor = () => null, readings = null, tolerantGrowth = true }) {
  const tree = computeTreeReadings(root);
  const sources = collectSources(root);
  const problems = [];

  // 判据 4：反空转下界（先跑：树都读不全，后面比对没有意义）。
  problems.push(...tag(4, (() => {
    try {
      assertNonVacuous(tree);
      return [];
    } catch (failure) {
      return String(failure.message ?? failure).split('\n');
    }
  })()));

  // 判据 1：标记块唯一（parseDrillBlock 自带）。
  const parsed = parseDrillBlock(docText);
  problems.push(...tag(1, parsed.problems));
  if (parsed.problems.length > 0) {
    return { ok: false, problems, tree, doc: parsed, expected: null, growth: [] };
  }

  // 判据 2：整块逐行比对（规范化之后：CRLF→LF、去行尾空白、去尾部空行）。期望块由「树 + 文档自己的一次性行」渲染——
  // 一次性读数的**具体数字**不能重算（它们本来就不可复算），所以那几行的值从文档取，
  // 格式与顺序由渲染器说了算：块内任何手改（多空格、换行、删行、改表头）都会在这里被抓。
  const expected = renderDrillBlock({ tree, rows: parsed.rows });
  const difference = diffDrillBlock(parsed.block, expected, parsed.startLine, { tolerantGrowth });
  if (difference !== null) problems.push({ criterion: 2, name: CRITERIA[2], message: renderDifference(difference) });
  // 再补一条「单键点名」：整块比对只报第一处，单键比对把每个漂掉的读数都点出来。
  problems.push(...tag(2, readingsProblems(parsed.readings, tree, { tolerantGrowth })));
  const growth = growthLag(parsed.readings, tree);

  // 判据 3：出处双向。
  for (const entry of DRILL_PLAN) {
    const traced = traceCommand(entry.command, sources, root);
    if (!traced.ok) problems.push({ criterion: 3, name: CRITERIA[3], message: `演练计划里的 \`${entry.command}\`：${traced.reason}` });
  }
  for (const row of parsed.rows) {
    const traced = traceCommand(row.command, sources, root);
    if (!traced.ok) problems.push({ criterion: 3, name: CRITERIA[3], message: `文档第 ${parsed.startLine} 行起的块里 \`${row.command}\`：${traced.reason}` });
  }
  for (const note of parsed.notes) {
    const traced = traceCommand(note.entry, sources, root);
    if (!traced.ok) problems.push({ criterion: 3, name: CRITERIA[3], message: `未跑条目 \`${note.entry}\`：${traced.reason}` });
  }
  problems.push(...tag(3, rowCommandProblems(parsed.rows)));
  problems.push(...tag(3, coverageProblems(tree, parsed.block)));
  problems.push(...tag(3, armCoverageProblems(tree, parsed.block)));

  // 判据 5：算术自洽。
  problems.push(...tag(5, arithmeticProblems(tree, parsed.rows)));

  // 判据 6：一次性读数三件套。
  problems.push(...tag(6, oneShotProblems(parsed.rows, { isAncestor })));

  // 判据 7：不许写「CI 已绿」。
  problems.push(...tag(7, ciGreenProblems(parsed.block, parsed.startLine)));

  // 判据 8：真空项显式化。
  problems.push(...tag(8, vacuousProblems(parsed.notes)));

  return { ok: problems.length === 0, problems, tree, doc: parsed, expected, growth };
}

/** 用 `readings.json` 造一次性行（顺序按演练计划；读数文件里少一条就报错，绝不写半张表）。 */
export function rowsFromReadings(readings, { allowPartial = false } = {}) {
  const byCommand = new Map((readings.commands ?? []).map((item) => [item.command, item]));
  const rows = [];
  for (const entry of DRILL_PLAN) {
    const item = byCommand.get(entry.command);
    if (item === undefined) continue;
    rows.push(makeRow({
      command: entry.command,
      exit: item.exit,
      readout: item.readout,
      sha: readings.sha,
      host: readings.host,
      at: readings.startedAt,
    }));
  }
  if (!allowPartial && rows.length !== DRILL_PLAN.length) {
    throw new GDrillError(
      `readings.json 只有 ${rows.length}/${DRILL_PLAN.length} 条命令的读数 ⇒ 拒绝写半张表（先跑完 \`node tools/collect-g-drill.mjs\`，或显式加 --allow-partial）`,
    );
  }
  return rows;
}

/** 把新块拼回文档：**只换 BEGIN..END 之间**，块外一个字节都不动。 */
export function spliceBlock(docText, newBlock) {
  const parsed = parseDrillBlock(docText);
  if (parsed.problems.length > 0) throw new GDrillError(`拒绝改块：${parsed.problems.join('；')}`);
  const lines = String(docText).split(/\r?\n/);
  const before = lines.slice(0, parsed.startLine - 1);
  const after = lines.slice(parsed.endLine);
  return `${[...before, ...newBlock.split('\n'), ...after].join('\n')}`;
}

/** `--update` 的主流程：渲染新块 → 只替换块内 → 写盘。返回新文档文本。 */
export function updateDocumentText({ root, docText, readings, allowPartial = false }) {
  const tree = computeTreeReadings(root);
  const rows = rowsFromReadings(readings, { allowPartial });
  const block = renderDrillBlock({ tree, rows });
  return spliceBlock(docText, block);
}

/**
 * `--live` 现场重跑的日志里出现这些串 ⇒ 是「本机工具链缺失」，**不是**「读数与提交不符」。
 * 典型：本机副本没有 `node_modules`，`npm run lint` 打「未找到本地 TypeScript」，
 * `node tools/openapi-route-parity.mjs` 打 `Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'fastify'`。
 * ⛔ 别把它算成通过：认成环境问题的一律按 **SKIP** 计并点名，全绿文案里会写清几条没跑。
 */
const ENV_FAILURE_MARKERS = Object.freeze([
  '未找到本地',
  'Cannot find module',
  'Cannot find package',
  'ERR_MODULE_NOT_FOUND',
  'npm ERR! missing script',
  'is not recognized',
  'command not found',
  'ENOENT',
]);

/** 从一段日志里认出「环境缺失」：返回命中的标记；没命中返回 `null`。 */
export function environmentFailure(logText) {
  const text = String(logText ?? '');
  for (const marker of ENV_FAILURE_MARKERS) {
    if (text.includes(marker)) return marker;
  }
  return null;
}

/** `--live` 全绿时的文案：静态闸门条数**从 `DRILL_PLAN` 数**（写死会与 `--help` 打架）。 */
export function liveSuccessMessage(skipped = []) {
  const total = DRILL_PLAN.filter((entry) => entry.group === 'static').length;
  if (skipped.length === 0) return `  ✓ --live：可复算类 ${total} 条静态闸门与块里的读数一致`;
  return `  ✓ --live：可复算类 ${total} 条静态闸门，其中 ${total - skipped.length} 条与块里的读数一致；`
    + `${skipped.length} 条**环境缺失、未校验**（${skipped.map((id) => String(id)).join(' / ')}），`
    + '按 SKIP 计——这不是通过，只是没跑';
}

/**
 * `--live` 的退出码：**有 SKIP 就不是 0**。
 * 0 只留给「11 条全跑过且都与块里一致」；环境缺失（没有 `node_modules`、缺解释器等）走 2，
 * 免得 `if (exit 0) → 绿` 的脚本把「lint 没跑」读成「11 条都验过」。判据红仍是 1。
 */
export function liveExitCode(skipped = []) {
  return skipped.length === 0 ? 0 : 2;
}

/** `--live`：只重算「可复算类」（静态闸门那 11 条），与块里的 exit / 读数逐条对照。 */
export function liveProblems({ root, docText, log = () => {} }) {
  const parsed = parseDrillBlock(docText);
  if (parsed.problems.length > 0) return { problems: tag(1, parsed.problems), skipped: [] };
  const staticIds = DRILL_PLAN.filter((entry) => entry.group === 'static').map((entry) => entry.id);
  const readings = runDrillPlan({ root, only: staticIds, log });
  const problems = [];
  const skipped = [];
  const byCommand = new Map(parsed.rows.map((row) => [row.command, row]));
  for (const item of readings.commands) {
    const row = byCommand.get(item.command);
    if (row === undefined) {
      problems.push({ criterion: 6, name: CRITERIA[6], message: `\`${item.command}\` 在块里没有读数行 ⇒ --live 无从对照` });
      continue;
    }
    if (row.exit !== item.exit) {
      // ① 超时（124）：不是「读数不符」，是「没跑完」——单独点名，别混进数据不一致里。
      if (item.exit === 124) {
        problems.push({
          criterion: 6,
          name: CRITERIA[6],
          message: `\`${item.command}\`：现场重算超时（exit 124）⇒ 这不是「读数与提交不符」而是「没跑完」，`
            + '先 `Get-Process node` 清残留进程、再单独重跑这条命令（单条上限见 `collect-g-drill.mjs --timeout`）',
        });
        continue;
      }
      // ② 工具链缺失：本机根本没条件跑（无 node_modules 等），归成环境问题 ⇒ SKIP 并点名。
      const marker = environmentFailure(readIfExists(item.log) ?? '');
      if (marker !== null) {
        skipped.push(item.id);
        log(`  ⤼ ${item.id}：环境缺失（日志命中「${marker}」），未校验（块里 exit ${row.exit}，现场 exit ${item.exit}）`);
        continue;
      }
      problems.push({
        criterion: 6,
        name: CRITERIA[6],
        message: `\`${item.command}\`：块里 exit ${row.exit}，现场重算 exit ${item.exit} ⇒ 读数与提交不符`,
      });
    }
    log(`  ✓ ${item.id}：exit ${item.exit}（块里 ${row.exit}）`);
  }
  return { problems, skipped };
}

/** CLI 主流程：返回退出码。 */
export function main(argv = process.argv.slice(2), { log = console.log, error = console.error } = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (failure) {
    error(String(failure.message ?? failure));
    error(USAGE);
    return 1;
  }
  if (options.help) {
    log(USAGE);
    return 0;
  }
  const root = options.root;
  const docPath = options.doc ?? join(root, DOC_PATH);
  const docText = readIfExists(docPath);
  if (docText === null) {
    error(`找不到证据页：${docPath}（--check 需要它；--update 也不能凭空造块外的散文）`);
    return 1;
  }
  log(`G 片演练闸门 · --${options.mode}`);
  log(`  树：${root}`);
  log(`  文档：${docPath}`);
  log(`  生长型读数口径：${options.tolerantGrowth ? '--tolerant-growth（下界语义，滞后逐行打印）' : '--strict-growth（要求精确相等）'}`);

  if (options.mode === 'update') {
    const readingsPath = options.readings ?? join(tmpdir(), 'gy-g-drill', readSha(root), 'readings.json');
    const raw = readIfExists(readingsPath);
    if (raw === null) {
      error(`找不到读数：${readingsPath}（先跑 \`node tools/collect-g-drill.mjs\`）`);
      return 1;
    }
    let readings;
    try {
      readings = JSON.parse(raw);
    } catch (failure) {
      error(`读数不是合法 JSON：${readingsPath}（${String(failure.message ?? failure)}）`);
      return 1;
    }
    let next;
    try {
      next = updateDocumentText({ root, docText, readings, allowPartial: argv.includes('--allow-partial') });
    } catch (failure) {
      error(String(failure.message ?? failure));
      return 1;
    }
    if (readings.dirty === true) {
      // 采集时工作区不干净 ⇒ 块里的 sha 只代表「检出的是哪个提交」，不代表「代码就在该提交里」。
      log(`  ⚠ 这份读数采集时工作区不干净（${readings.dirtyPaths ?? '?'} 个未提交路径）⇒ 块里的 sha 只代表检出提交；`
        + '证据页必须如实写清这一点，否则读者会把它读成「代码在该提交上」');
    }
    if (next === docText) {
      log('  块内已是最新：一个字节都没变');
      return 0;
    }
    writeFileSync(docPath, next, 'utf8');
    log(`  已重写标记块内部（块外未动）：${docPath}`);
    return 0;
  }

  if (options.mode === 'live') {
    const { problems, skipped } = liveProblems({ root, docText, log });
    if (problems.length === 0) {
      log(liveSuccessMessage(skipped));
      return liveExitCode(skipped);
    }
    error('');
    for (const problem of problems) error(`✗ 判据 ${problem.criterion}（${problem.name}）：${problem.message}`);
    return 1;
  }

  const result = checkDocument({
    root,
    docText,
    isAncestor: makeAncestorCheck(root),
    readings: null,
    tolerantGrowth: options.tolerantGrowth,
  });
  // 生长型读数的滞后**必须可见**（不许静默）：`--tolerant-growth` 下逐行打印「滞后 N」。
  // ⛔ 这些滞后数只进 stdout，**不进文档块**——块里保留的是「当时实测值」，一旦为了让 CI 变绿去改块，
  //    就又变成「手改读数/动锚点」了。
  for (const item of result.growth) {
    log(`  ↳ 生长型读数滞后：${item.key} 文档 ${item.doc} → 重算 ${item.expected}（滞后 ${item.lag}）`);
  }
  if (result.ok) {
    const mode = options.tolerantGrowth ? '--tolerant-growth' : '--strict-growth';
    const tail = options.tolerantGrowth && result.growth.length > 0
      ? `；生长型读数按**下界**判（${mode}），其中 ${result.growth.length} 条滞后已逐行打印`
      : `；读数与树逐字相等（${mode}）`;
    log(`  ✓ 八条判据全过：workflows ${result.tree.workflows} / jobs ${result.tree.workflowJobs} / 演练 ${DRILL_PLAN.length} 条 / 测试文件 ${result.tree.allTestFiles}（glob 合计 ${result.tree.totalTestFiles}）${tail}`);
    return 0;
  }
  error('');
  for (const problem of result.problems) error(`✗ 判据 ${problem.criterion}（${problem.name}）：${problem.message}`);
  error('');
  error(`共 ${result.problems.length} 处问题 ⇒ exit 1`);
  return 1;
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  process.exitCode = main();
}
