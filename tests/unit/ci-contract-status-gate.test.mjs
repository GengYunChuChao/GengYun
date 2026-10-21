/**
 * CI 门禁：`.github/workflows/engineering-shell.yml` 的 `contract` job 必须**真跑**
 * `tools/verify-contract-status.mjs`，且不得被改成「软失败」或「自动改写台账」。
 *
 * 为什么需要它（实测事实，逐条读数为本片复核所得，见
 * `docs/verification/gy-r28-contract-status-gate-20261020.md` §1）：
 *  1. 校验器存在、也能过，但**没有入口**：`package.json` 的 `scripts` 里没有任何一条
 *     调用 `verify-contract-status`（0 命中）；`.github/workflows/` 12 份 workflow 里
 *     也没有任何一份提到它（0 命中）。唯一的入口是脚本本体。
 *  2. 既有测试只测工具自身行为：`tests/unit/contract-status-tool.test.mjs`（414 行）
 *     用夹具台账跑 spawn 用例，**不改 workflow 就永远不会红** ⇒ 删掉 CI 那一步，
 *     全仓测试照样全绿。这正是本文件要补的缺口。
 *  3. 后果已经发生过一次：#325 带着 13 处过期行号与一句失实半句进主干，靠对抗性复审
 *     才发现——因为没有任何机械门禁在每次 PR 上跑这条校验。
 *
 * 本文件是**纯静态**检查：只 `fs.readFileSync` 读两份文本（workflow ＋ 校验器）。
 * ⛔ 不引入 `yaml` 依赖（按缩进逐行解析）、不联网、不 `spawn` 子进程、不写任何文件。
 *
 * 钉住的五条（前四条与派单 §2.2 逐条对应，第五条是 §2.1 的位置要求）：
 *  1) `contract` job 里**存在**一条命令恰为 `node tools/verify-contract-status.mjs` 的 step；
 *  2) 该 step **不带** `--write-doc`（CI 里不许自动改写 `docs/architecture/*.md` 台账）；
 *  3) 该 step **不带** `if:` / `continue-on-error` / `|| true`（不许把必跑改成软失败）；
 *  4) 被调用路径**真实存在且非空**；且校验器文本**不含** `--force` / `--skip`
 *     这类会把「未取得」改写成「通过」的开关；
 *  5) 该 step 位于 `- run: npm run test:contract` **之后**（同 job 内）。
 *
 * 刻意不做（见证据页 §6，不冒充能力）：本文件只保证「校验器会在 CI 上被跑」，
 * **不**增加「行号是否命中预期符号」的校验 ⇒ 对「行号错但语法合法」仍无鉴别力。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根：由本文件位置推出（tests/unit/ → ../..），⛔ 不用 `process.cwd()`（与仓内其它 ci-*.test.mjs 同口径）。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW_FILE = '.github/workflows/engineering-shell.yml';
const JOB_ID = 'contract';
/** 本 job 里契约测试的既有那一步；新增的校验步必须排在它之后（派单 §2.1）。 */
const CONTRACT_STEP_COMMAND = 'npm run test:contract';
/** 必须原样出现的那一步（不加任何 flag）。 */
const GATE_COMMAND = 'node tools/verify-contract-status.mjs';
/** 校验器文件（口径：存在、非空、不含「无条件通过」开关）。 */
const GATE_TOOL_FILE = 'tools/verify-contract-status.mjs';
/**
 * 校验器**只**接受这两个 flag（`tools/verify-contract-status.mjs:15-19`：出现任何其它
 * flag 立即打印用法并 `exit 1`）。因此 `--force` / `--skip` 一旦出现在它的文本里，
 * 就意味着有人新加了「无条件通过」分支——那会把门禁变回装饰品。
 */
const UNCONDITIONAL_PASS_FLAGS = Object.freeze(['--force', '--skip']);

/** 读仓库内文本文件；不存在就直接给可操作的失败信息（而不是读文件的 ENONT 堆栈）。 */
function readRepoText(relativePath) {
  const absolute = join(REPO_ROOT, relativePath);
  assert.ok(existsSync(absolute), `仓库里找不到 ${relativePath}（仓库根解析为 ${REPO_ROOT}）`);
  return readFileSync(absolute, 'utf8');
}

/**
 * 按 YAML 缩进切出 `jobs.<jobId>` 这一块，返回半开行区间（0 基）。
 * 只认「两个空格 + 键 + 冒号」的 job 键：本仓 workflow 的 job 一律写在该缩进上，
 * 够用且不必引入 `yaml` 依赖。
 */
export function jobBlockOf(source, jobId = JOB_ID) {
  const lines = source.split('\n');
  const start = lines.findIndex(line => line === `  ${jobId}:`);
  if (start === -1) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^ {2}[^\s#][^:]*:\s*$/.test(lines[index]) || /^[^\s]/.test(lines[index])) { end = index; break; }
  }
  return { lines, start, end };
}

/**
 * 取出一个 step 里所有 `run:` 的**命令文本**（内联值 ＋ `|` / `>` 块行拼成一行）。
 * 只读 `run:` 字段，不碰 `name:` / `uses:` / `with:`，避免把说明文字当成命令。
 */
export function runCommandsOf(stepLines) {
  const commands = [];
  for (let index = 0; index < stepLines.length; index += 1) {
    const match = /^\s*(?:- )?run:\s*(.*)$/.exec(stepLines[index]);
    if (!match) continue;
    const inline = match[1].trim();
    if (inline && inline !== '|' && inline !== '>') { commands.push(inline); continue; }
    const keyIndent = /^\s*/.exec(stepLines[index])[0].length;
    const block = [];
    for (let cursor = index + 1; cursor < stepLines.length; cursor += 1) {
      const line = stepLines[cursor];
      if (line.trim() === '') { block.push(''); index = cursor; continue; }
      if (/^\s*/.exec(line)[0].length <= keyIndent) break;
      block.push(line.trim());
      index = cursor;
    }
    commands.push(block.join(' ').trim());
  }
  return commands;
}

/**
 * 切出该 job 的 steps：按「`- ` 的最小缩进」判定 step 边界（本文件里是 6 空格），
 * 返回每步的起始行号（1 基，供错误信息定位）与命令文本。
 */
export function stepsOf(job) {
  const { lines, start, end } = job;
  const dashes = [];
  for (let index = start + 1; index < end; index += 1) {
    const match = /^( +)- (?:name|uses|run):/.exec(lines[index]);
    if (match) dashes.push({ index, indent: match[1].length });
  }
  if (dashes.length === 0) return [];
  const stepsIndent = Math.min(...dashes.map(dash => dash.indent));
  const starts = dashes.filter(dash => dash.indent === stepsIndent).map(dash => dash.index);
  return starts.map((stepStart, position) => {
    const stepEnd = position + 1 < starts.length ? starts[position + 1] : end;
    const stepLines = lines.slice(stepStart, stepEnd);
    return { line: stepStart + 1, lines: stepLines, commands: runCommandsOf(stepLines) };
  });
}

/** 引用校验器的 step（宽松命中：路径带后缀也认得出来，便于 ④ 报「路径不存在」而不是「步骤不存在」）。 */
function gateStepsOf(steps) {
  return steps.filter(step => step.commands.some(command => /node\s+tools\/verify-contract-status[^\s;&|]*/.test(command)));
}

/** 读 workflow 与 job 块；任何一处缺失都给出「文件没了 / job 被改名」的可操作提示。 */
function contractJob() {
  const job = jobBlockOf(readRepoText(WORKFLOW_FILE));
  assert.ok(job, `\`${WORKFLOW_FILE}\` 里找不到 \`${JOB_ID}:\` 这个 job（2 空格缩进）；`
    + '若 job 被改名或嵌套层级变了，本门禁必须同步改 JOB_ID，⛔ 不许直接删掉这条守卫。');
  return job;
}

/**
 * 扫 `contract` job 的软失败构造（三类，缺一类就是一条静默变绿通道）：
 *
 * 1. **job 级**：与 `steps:` 同缩进、且行首无 `- ` 的 `if:` / `continue-on-error:`。
 *    `if: false` 让整个 job 被跳过、`continue-on-error: true` 让 job 失败也判绿 ⇒ 门禁等于没跑。
 * 2. **step 级**：只扫引用校验器的那一步（别的 step 自己软失败，不影响本门禁的结论）。
 * 3. **命令文本**：`|| true`、`set +e`、`exit 0` 三种把非零退出吞掉的写法。
 *
 * 冒号一律允许前置空白：`if :` / `continue-on-error :` 是合法 YAML、语义不变，
 * 只认「冒号紧贴键名」会把它们放过去（仓内同类守卫 `tests/unit/ci-real-pg-wiring.test.mjs`
 * 的 `swallowedFailureHits()` 也是宽容空格的）。
 */
function softFailureHits(job, gateSteps) {
  const hits = [];
  const { lines, start, end } = job;
  const stepsAt = lines.findIndex((line, index) => index > start && index < end && /^\s*steps\s*:\s*$/.test(line));
  const jobIndent = stepsAt === -1 ? null : /^ */.exec(lines[stepsAt])[0].length;
  if (jobIndent !== null) {
    for (let index = start + 1; index < end; index += 1) {
      if (index === stepsAt) continue;
      const line = lines[index];
      if (/^ */.exec(line)[0].length !== jobIndent) continue;
      if (/^\s*-\s/.test(line)) continue;
      if (/^\s*if\s*:/.test(line)) hits.push(`第 ${index + 1} 行（job 级）有 \`if:\`：${line.trim()}`);
      if (/^\s*continue-on-error\s*:/.test(line)) {
        hits.push(`第 ${index + 1} 行（job 级）有 \`continue-on-error:\`：${line.trim()}`);
      }
    }
  }
  for (const step of gateSteps) {
    step.lines.forEach((line, offset) => {
      if (/^\s*(?:-\s+)?if\s*:/.test(line)) hits.push(`第 ${step.line + offset} 行（step 级）有 \`if:\`：${line.trim()}`);
      if (/^\s*(?:-\s+)?continue-on-error\s*:/.test(line)) {
        hits.push(`第 ${step.line + offset} 行（step 级）有 \`continue-on-error:\`：${line.trim()}`);
      }
    });
    for (const command of step.commands) {
      if (/\|\|\s*true\b/.test(command)) hits.push(`第 ${step.line} 行的命令有行尾 \`|| true\`：${command}`);
      if (/(?:^|[\s;&|])set\s+\+e\b/.test(command)) {
        hits.push(`第 ${step.line} 行的命令里有 \`set +e\`（关掉「失败即停」）：${command}`);
      }
      if (/(?:^|[\s;&|])exit\s+0\b/.test(command)) {
        hits.push(`第 ${step.line} 行的命令里有 \`exit 0\`（把非零退出改写成成功）：${command}`);
      }
    }
  }
  return hits;
}

test('① contract job 里有 `node tools/verify-contract-status.mjs` 这一步', () => {
  const job = contractJob();
  const steps = stepsOf(job);
  assert.ok(steps.length >= 3, `\`${JOB_ID}\` job 只解析出 ${steps.length} 个 step，缩进解析口径可能已失效`);
  const gate = steps.filter(step => step.commands.includes(GATE_COMMAND));
  if (gate.length === 0) {
    const existing = steps.map(step => `第 ${step.line} 行：${step.commands.join(' ；') || '(无 run)'}`).join('\n');
    assert.fail([
      `\`${WORKFLOW_FILE}\` 的 \`${JOB_ID}\` job 里没有 \`${GATE_COMMAND}\` 这一步：`,
      '契约台账校验器（docs/architecture/contract-status.json ↔ 中文对照表）因此不会在 CI 上跑，',
      '台账漂移可以静默进主干。',
      '改法：在同 job 的 `- run: npm run test:contract` 之后追加一行：',
      `      - run: ${GATE_COMMAND}`,
      '⛔ 不要加 `--write-doc`、`--runtime`、`if:`、`continue-on-error` 或行尾 `|| true`。',
      `该 job 现有命令：\n${existing}`,
    ].join('\n'));
  }
  assert.equal(gate.length, 1, `契约校验步出现了 ${gate.length} 次（第 ${gate.map(step => step.line).join('、')} 行）；`
    + '只保留一条，重复运行会让 CI 时间翻倍并掩盖「哪一步才是门禁」。');
});

test('② contract job 里那一步不带 `--write-doc`（CI 不得自动改写台账）', () => {
  const steps = stepsOf(contractJob());
  const gate = gateStepsOf(steps);
  assert.ok(gate.length > 0, `找不到引用 \`tools/verify-contract-status\` 的 step，${WORKFLOW_FILE} 的 ${JOB_ID} job 可能被删空`);
  for (const step of gate) {
    for (const command of step.commands) {
      assert.ok(!command.includes('--write-doc'), [
        `第 ${step.line} 行的契约校验步带了 \`--write-doc\`：\`${command}\``,
        'CI 里带它会让校验器按 JSON 自动重写 docs/architecture/contract-implementation-status.md，',
        '把「表格漂移」就地抹平 ⇒ 门禁失去对台账的约束力（且 PR 会被 CI 自动改脏）。',
        '改法：删掉 `--write-doc`，同步只在人工本地核对后执行。',
      ].join('\n'));
    }
  }
});

test('③ contract job（job 级）与那一步（step 级）都不带软失败构造', () => {
  const job = contractJob();
  const gate = gateStepsOf(stepsOf(job));
  assert.ok(gate.length > 0, `找不到引用 \`tools/verify-contract-status\` 的 step，${WORKFLOW_FILE} 的 ${JOB_ID} job 可能被删空`);
  const hits = softFailureHits(job, gate);
  assert.deepEqual(hits, [], [
    `契约校验被改成了软失败（${hits.length} 处）：`,
    ...hits.map(hit => `  · ${hit}`),
    '以上任一构造都会让「校验失败」仍被判绿——门禁等于没有。',
    'job 级 `if:` 会整块跳过该 job，job 级 `continue-on-error:` 会让整个 job 失败也判绿；step 级同名字段等价于没跑。',
    `改法：那一步只留 \`- run: ${GATE_COMMAND}\`；job 与 step 都别加 \`if:\` / \`continue-on-error:\`，`
      + '命令里别写行尾 `|| true`、`set +e` 或 `exit 0`。',
  ].join('\n'));
});

test('④ 被调用路径真实存在且非空；校验器不含 `--force` / `--skip` 这类无条件通过开关', () => {
  const job = contractJob();
  const jobLines = job.lines.slice(job.start + 1, job.end);
  const referenced = [...new Set(jobLines.flatMap(line => (
    [...line.matchAll(/node\s+(tools\/verify-contract-status[^\s;&|`'"]*)/g)].map(match => match[1])
  )))];
  assert.ok(referenced.length > 0, `\`${JOB_ID}\` job 里没有任何 \`node tools/verify-contract-status…\` 调用；`
    + `改法：加回 \`- run: ${GATE_COMMAND}\`。`);
  for (const relativePath of referenced) {
    const absolute = join(REPO_ROOT, relativePath);
    assert.ok(existsSync(absolute), [
      `workflow 里调用的是 \`${relativePath}\`，但仓库里没有这个文件（仓库根解析为 ${REPO_ROOT}）。`,
      '这正是「钉了一个不存在的路径」：workflow 看起来有检查，实际 CI 会因找不到脚本而红/或指向别处。',
      `改法：把那一步写回 \`${GATE_COMMAND}\`（⛔ 不改名、不指向 .bak / 临时脚本）。`,
    ].join('\n'));
    assert.ok(statSync(absolute).isFile(), `\`${relativePath}\` 不是常规文件（目录/符号链接/设备）`);
    assert.ok(statSync(absolute).size > 0, `\`${relativePath}\` 是空文件：零字节校验器永远「通过」，等于门禁被掏空`);
  }
  const toolSource = readRepoText(referenced[0]);
  for (const flag of UNCONDITIONAL_PASS_FLAGS) {
    assert.ok(!toolSource.includes(flag), [
      `\`${referenced[0]}\` 里出现了 \`${flag}\` 子串，说明有人新加了「无条件通过」类开关。`,
      '该文件 process.argv 段目前只认 `--runtime` / `--write-doc`（其它 flag 直接 exit 1）；',
      '新增 `--force` / `--skip` 一类开关会让门禁在需要它红的时候保持绿。',
      '保守判据：本断言只查子串，不解析 CLI（把「flag 怎么拼」写成解析器只会多一个脆弱面）。',
      '若确实要加新 flag，必须同时给出「它不会把未取得改成通过」的理由，并同步改本断言与证据页。',
    ].join('\n'));
  }
});

test('⑤ 契约校验步排在 `npm run test:contract` 之后（同 job 内，派单 §2.1 的位置要求）', () => {
  const steps = stepsOf(contractJob());
  const contractIndex = steps.findIndex(step => step.commands.includes(CONTRACT_STEP_COMMAND));
  const gateIndex = steps.findIndex(step => step.commands.includes(GATE_COMMAND));
  assert.ok(contractIndex >= 0, `\`${JOB_ID}\` job 里找不到 \`- run: ${CONTRACT_STEP_COMMAND}\`；`
    + '它被删/改名说明 job 被改坏，先修回再谈新增 step。');
  assert.ok(gateIndex >= 0, `\`${JOB_ID}\` job 里找不到 \`- run: ${GATE_COMMAND}\`（见失败 ①）`);
  assert.ok(gateIndex > contractIndex, [
    `契约校验步排在第 ${steps[gateIndex].line} 行，却在 \`${CONTRACT_STEP_COMMAND}\`（第 ${steps[contractIndex].line} 行）之前。`,
    '先跑契约测试、再核对台账，失败时报错才属于「台账与契约表不一致」而不是「契约测试挂了」。',
    `改法：把 \`      - run: ${GATE_COMMAND}\` 挪到 test:contract 之后。`,
  ].join('\n'));
});
