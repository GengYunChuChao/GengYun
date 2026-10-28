/**
 * CI 门禁：`.github/workflows/engineering-shell.yml` 必须有 `retention-gates` job，且该 job **真跑**
 * `npm run verify:purge-schedule`（数据保留／到期清除的**调度层**门禁）。
 *
 * 为什么需要它（接线前实测，读数见下面每条失败信息）：
 *  1. 门禁本体是完整的：`tools/verify-purge-schedule.mjs`（10 项判据、906 行）能过、
 *     `package.json` 也挂了 `verify:purge-schedule`，但 `.github/workflows/` 15 份 workflow 里
 *     `verify:purge-schedule` **0 命中** ⇒ 它只能靠人记得在本地跑。本片的全部目的就是堵这一条：
 *     「从靠人记得跑」变成「CI 每次都跑」。
 *  2. 既有单测只测工具自身：`tests/unit/verify-purge-schedule.test.mjs`（523 行）用
 *     `--root` 夹具做正臂＋负控制，**不改 workflow 就永远不会红** ⇒ 删掉 CI 那一整段 job，
 *     全仓测试照样全绿。这与 `tests/unit/ci-contract-status-gate.test.mjs` 记录的是**同一类缺口**
 *     （那次是契约台账校验器「存在、能过、但没有入口」），所以这里也照它立一条守卫。
 *  3. 后果是具体的：`deploy/purge-schedule/*.timer` 是「到期清除」唯一的时钟（删掉它们，
 *     在线 7 日／备份 30 日到期就没人叫醒）；`services/api/src/**` 里 `setInterval(` 的计数是
 *     「无进程内调度器」唯一的机械判据（塞一个进去＝多副本重复执行＋与真库臂抢同一批行）。
 *     这两件事目前**只有**这个脚本在判。
 *
 * 纯静态：只 `readFileSync` 读 workflow / `package.json` 三份文本。
 * ⛔ 不引入 `yaml` 依赖（按缩进逐行解析）、不联网、不 spawn 子进程、不写任何文件。
 *
 * 钉住的六条：
 *  1) `retention-gates` job 里**恰好一条**命令为 `npm run verify:purge-schedule` 的 step；
 *  2) 该 job（job 级）与那一步（step 级）都不带软失败构造（`if:` / `continue-on-error:` /
 *     行尾 `|| true` / `set +e` / `exit 0`）——它们都会让「门禁红了」仍被判绿；
 *  3) 该 job **不碰真库**：所有 `run:` 命令里不得出现 `tests/integration/`、`GY_PG_BIN`、
 *     `initdb` / `pg_ctl` / `psql`、`image: postgres`…，job 里也不得有 `services:`。
 *     真库臂属于 `real-pg-integration.yml`（缺 `GY_PG_BIN` 时按约定 exit 77 跳过）；
 *     把它拖进「无需 PG」的这一层，会让本 job 在没有库的 runner 上必然红或被跳过。
 *  4) 入口**同源且不可绕过**：`on.pull_request` 不带 `paths` 过滤（否则不是「每次 PR」）；
 *     `package.json` 的 `verify:purge-schedule` 必须原样指向 `node tools/verify-purge-schedule.mjs`，
 *     且不带 `--root` / `--dir`（带上就能把 CI 指向一棵夹具树，在假仓库上永远绿）。
 *  5) 反向控制：删掉那条 `run:`、把它写成 shell 注释、换成别的 npm script、加 `if: false`、
 *     加 `continue-on-error: true`、塞一条真库命令、给 `pull_request:` 加 `paths` 过滤 —— 七种变异
 *     都必须让对应判据红并点名。
 *  6) 闸门自己吃的**历史**也钉住：跑单测的 `unit` job 的 `actions/checkout` 必须 `with.fetch-depth: 0`
 *     （改成 1／删掉都必须红）。为什么它也在本文件：这是同一类「假绿通道」——`tests/unit/doc-anchor-
 *     relocation-identity.test.mjs` 靠 `git merge-base HEAD origin/main` 取 base，`fetch-depth: 1` 时
 *     取不到就只能 SKIP，而 **SKIP 也是 exit 0**；第一轮实测把那一行删掉后，全仓 `ci-*.test.mjs`
 *     100 条**仍然全绿**，等于没人守。
 *
 * 刻意**不做**（不冒充能力）：不判断 `deploy/purge-schedule/**` 的判据本身是否合理
 * （那是 `tools/verify-purge-schedule.mjs` 的职责，`tests/unit/verify-purge-schedule.test.mjs` 已覆盖）；
 * 本文件只保证「那颗校验器真的在 CI 上每次 PR 被跑」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根：由本文件位置推出（tests/unit/ → ../..），⛔ 不用 `process.cwd()`（与仓内其它 ci-*.test.mjs 同口径）。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
/** 主门禁工作流（本仓没有 `ci.yml`；分层 CI 落在这一份上，见其文件头注释）。 */
const WORKFLOW_FILE = '.github/workflows/engineering-shell.yml';
const JOB_ID = 'retention-gates';
/**
 * 判据 ⑥ 的作用域：**跑单测的那个 job**（本仓叫 `unit`，`name: unit-tests`）。
 * 它跑 `npm run test:unit`，其中 `tests/unit/doc-anchor-relocation-identity.test.mjs` 要用
 * `git merge-base HEAD origin/main` 取 base；`actions/checkout` 默认 `fetch-depth: 1` 时取不到 ⇒ 那条闸门
 * 在 CI 上 SKIP（exit 0）＝空跑。故本 job 的 checkout 必须显式 `fetch-depth: 0`。
 */
const CHECKOUT_JOB_ID = 'unit';
/** 必须原样出现的那一步；⛔ 不带任何 flag。 */
const GATE_COMMAND = 'npm run verify:purge-schedule';
/** 该命令背后的 `package.json` script 名与入口文件。 */
const NPM_SCRIPT = 'verify:purge-schedule';
const GATE_TOOL_FILE = 'tools/verify-purge-schedule.mjs';
/** 真库臂的判据面：这些 token 一旦出现在本 job 的 `run:` 命令里，本 job 就不再是「无需 PG」。 */
const REAL_PG_TOKENS = Object.freeze([
  'tests/integration/',
  'GY_PG_BIN',
  'initdb',
  'pg_ctl',
  'psql',
  'image: postgres',
  'postgres:17',
  'DATABASE_URL',
  'PGDATABASE',
]);
/**
 * 能把门禁指向「另一棵仓库」的 flag：`--root` 换仓库根、`--dir` 换调度目录。
 * 它们出现在 CI 命令里，校验器就会在一棵夹具/临时树上「通过」——那是最彻底的一种假绿。
 */
const ROOT_REDIRECTING_FLAGS = Object.freeze(['--root', '--dir']);

/** 读仓库内文本文件；不存在就直接给可操作的失败信息（而不是 ENONT 堆栈）。 */
function readRepoText(relativePath) {
  const absolute = join(REPO_ROOT, relativePath);
  assert.ok(existsSync(absolute), `仓库里找不到 ${relativePath}（仓库根解析为 ${REPO_ROOT}）`);
  return readFileSync(absolute, 'utf8');
}

/**
 * 按 YAML 缩进切出 `jobs.<jobId>` 这一块，返回半开行区间（0 基）。
 * 只认「两个空格 + 键 + 冒号」的 job 键：本仓 workflow 的 job 一律写在该缩进上，
 * 够用且不必引入 `yaml` 依赖。
 *
 * 范围只到**下一个 job 键**：块内 `#` 注释（含 `services:` / `GY_PG_BIN` 这类字样）不算内容——
 * 判据要对齐的是「真跑什么」，不是「注释里提到了什么」。
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

/** 取出一个 step 里所有 `run:` 的**命令文本**（内联值 ＋ `|` / `>` 块行拼成一行）。 */
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

/** 切出该 job 的 steps：按「`- ` 的最小缩进」判定 step 边界，返回起始行号（1 基）与命令文本。 */
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

/** 引用调度门禁的 step（判据 ①）。 */
export function gateStepsOf(steps) {
  return steps.filter(step => step.commands.includes(GATE_COMMAND));
}

/** 判据 ①：job 存在 ⇒ 恰好一条门禁 step。返回问题列表（空＝通过）。 */
export function gateStepProblems(source) {
  const job = jobBlockOf(source, JOB_ID);
  if (!job) {
    return [`\`${WORKFLOW_FILE}\` 里找不到 2 空格缩进的 \`${JOB_ID}:\` job —— `
      + '保留/清理门禁没有任何 CI 入口，只能靠人记得本地跑。'];
  }
  const steps = stepsOf(job);
  if (steps.length === 0) {
    return [`\`${JOB_ID}\` job 解析不出任何 step（\`- name|uses|run:\` 缩进口径可能已失效）`];
  }
  const gate = gateStepsOf(steps);
  if (gate.length === 0) {
    return [`\`${JOB_ID}\` job 里没有 \`${GATE_COMMAND}\` 这一步。该 job 现有命令：`
      + (steps.map(step => `第 ${step.line} 行：${step.commands.join(' ；') || '(无 run)'}`).join(' / '))];
  }
  if (gate.length > 1) {
    return [`\`${GATE_COMMAND}\` 出现了 ${gate.length} 次（第 ${gate.map(step => step.line).join('、')} 行）；`
      + '只保留一条，重复运行会让 CI 时间翻倍并掩盖「哪一步才是门禁」'];
  }
  return [];
}

/**
 * 判据 ②：软失败构造（三类，缺一类就是一条静默变绿通道）：
 * 1. job 级：与 `steps:` 同缩进、且行首无 `- ` 的 `if:` / `continue-on-error:`；
 * 2. step 级：只扫引用门禁的那一步；
 * 3. 命令文本：`|| true`、`set +e`、`exit 0`。
 * 冒号一律允许前置空白（`if :` 是合法 YAML、语义不变）。
 */
export function softFailureProblems(source) {
  const job = jobBlockOf(source, JOB_ID);
  if (!job) return gateStepProblems(source);
  const steps = stepsOf(job);
  const gate = gateStepsOf(steps);
  if (gate.length === 0) return gateStepProblems(source);
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
  for (const step of gate) {
    step.lines.forEach((line, offset) => {
      if (/^\s*(?:-\s+)?if\s*:/.test(line)) hits.push(`第 ${step.line + offset} 行（step 级）有 \`if:\`：${line.trim()}`);
      if (/^\s*(?:-\s+)?continue-on-error\s*:/.test(line)) {
        hits.push(`第 ${step.line + offset} 行（step 级）有 \`continue-on-error:\`：${line.trim()}`);
      }
    });
    for (const command of step.commands) {
      if (/\|\|\s*true\b/.test(command)) hits.push(`第 ${step.line} 行的命令有行尾 \`|| true\`：${command}`);
      if (/(?:^|[\s;&|])set\s+\+e\b/.test(command)) hits.push(`第 ${step.line} 行的命令里有 \`set +e\`：${command}`);
      if (/(?:^|[\s;&|])exit\s+0\b/.test(command)) hits.push(`第 ${step.line} 行的命令里有 \`exit 0\`：${command}`);
    }
  }
  return hits;
}

/**
 * 判据 ③：本 job 的 `run:` 命令里不得出现真库臂的 token，job 里也不得有 `services:`。
 *
 * 只看 `run:` 命令文本（不看注释）：文件里那段「不接 tests/integration/*-purge-pg.mjs」的说明
 * 必须能点名这些 token，否则读的人不知道边界在哪 —— 注释不是命令，同 `ci-real-pg-wiring.test.mjs`
 * 的 `runCommandTextsOf()` 口径。
 */
export function realPgProblems(source) {
  const job = jobBlockOf(source, JOB_ID);
  if (!job) return gateStepProblems(source);
  const steps = stepsOf(job);
  if (steps.length === 0) return [`\`${JOB_ID}\` job 解析不出任何 step（判据 ③ 失去作用域）`];
  const hits = [];
  for (const step of steps) {
    for (const command of step.commands) {
      for (const token of REAL_PG_TOKENS) {
        if (command.includes(token)) {
          hits.push(`第 ${step.line} 行的命令有真库 token \`${token}\`：${command}`);
        }
      }
    }
  }
  const { lines, start, end } = job;
  for (let index = start + 1; index < end; index += 1) {
    if (/^\s*services\s*:/.test(lines[index])) {
      hits.push(`第 ${index + 1} 行给本 job 挂了 \`services:\`（真库臂才需要 PG service）：${lines[index].trim()}`);
    }
  }
  return hits;
}

/**
 * 判据 ④a：`on.pull_request` 必须**不过滤**。
 * 写成 `pull_request: paths: [...]` / `branches:` 时，改 retention/清理相关文件的 PR 才会跑，
 * 其它 PR 照样在没有门禁的情况下合并 —— 那还是「靠人记得」。
 */
export function pullRequestProblems(source) {
  const lines = source.split('\n');
  const start = lines.findIndex(line => /^ {2}pull_request\s*:\s*$/.test(line));
  if (start === -1) {
    return ['找不到 2 空格缩进的 `  pull_request:` 键（workflow 不在 PR 上跑，门禁等于没有入口；'
      + '若改成 `on: push` 或加了过滤器，本判据必须随之收紧而不是删掉）'];
  }
  const hits = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    if (/^ */.exec(line)[0].length <= 2) break;
    hits.push(`第 ${index + 1} 行给 \`pull_request:\` 加了过滤：${line.trim()}`);
  }
  return hits;
}

/**
 * 判据 ④b：入口同源且不可绕过。
 * `package.json` 的 `verify:purge-schedule` 必须就是 `node tools/verify-purge-schedule.mjs`
 * （运维照着 `npm run verify:purge-schedule` 手动补跑时，与 CI 跑的是同一条命令），
 * 且不带 `--root` / `--dir`（能把 CI 指向一棵夹具树 ⇒ 在假仓库上永远绿）。
 */
export function entryScriptProblems(packageJson) {
  const command = packageJson && packageJson.scripts && packageJson.scripts[NPM_SCRIPT];
  if (typeof command !== 'string' || command.trim() === '') {
    return [
      `\`package.json\` 里没有 \`scripts.${NPM_SCRIPT}\` ⇒ workflow 的 \`${GATE_COMMAND}\` 会以 npm 找不到 script 而红`
      + '（那不是门禁在判，是命令打错了）',
    ];
  }
  const hits = [];
  const normalized = command.trim().replace(/\s+/g, ' ');
  if (normalized !== `node ${GATE_TOOL_FILE}`) {
    hits.push(`\`scripts.${NPM_SCRIPT}\` 是 \`${command}\`，不是 \`node ${GATE_TOOL_FILE}\`；`
      + 'CI 与运维手动补跑必须同源（否则口径改动只会改一边）');
  }
  for (const flag of ROOT_REDIRECTING_FLAGS) {
    if (normalized.includes(flag)) {
      hits.push(`\`scripts.${NPM_SCRIPT}\` 带了 \`${flag}\`：能把校验器指向另一棵仓库/另一个调度目录，`
        + 'CI 就会在一棵夹具树上「通过」（`--root` / `--dir` 只许在测试夹具里用，⛔ 不进 npm script）');
    }
  }
  const absolute = join(REPO_ROOT, GATE_TOOL_FILE);
  if (!existsSync(absolute)) {
    hits.push(`入口 \`${GATE_TOOL_FILE}\` 不存在（仓库根解析为 ${REPO_ROOT}）`);
  } else {
    if (!statSync(absolute).isFile()) hits.push(`入口 \`${GATE_TOOL_FILE}\` 不是常规文件`);
    if (statSync(absolute).size === 0) hits.push(`入口 \`${GATE_TOOL_FILE}\` 是空文件：零字节校验器永远「通过」`);
  }
  return hits;
}

/**
 * 判据 ⑥：闸门自己吃的「历史」也是判据面 —— `unit` job 的 checkout 必须带足历史。
 *
 * 为什么需要它（第一轮实测，不是假设）：`tests/unit/doc-anchor-relocation-identity.test.mjs`
 * 靠 `git merge-base HEAD origin/main` 取 base；`actions/checkout` 默认 `fetch-depth: 1` 时
 * 这个 merge-base 无解，用例只能靠「CI 自愈 fetch」或直接 SKIP —— **SKIP 也是 exit 0**，
 * 于是这条闸门在 CI 上空转。给 `unit` job 补上 `fetch-depth: 0` 之后，把那一行删掉，
 * 全仓 `tests/unit/ci-*.test.mjs`（100 条）**仍然全绿** —— 也就是没人守。本判据就是那枚钉子。
 *
 * 只认本 job 自己的 `actions/checkout` step，且只读该 step 自己的 `with:`（兄弟 step 的同名键不算）。
 */
export function checkoutDepthProblems(source) {
  const job = jobBlockOf(source, CHECKOUT_JOB_ID);
  if (!job) {
    return [`\`${WORKFLOW_FILE}\` 里找不到 2 空格缩进的 \`${CHECKOUT_JOB_ID}:\` job —— `
      + '跑单测的 job 不见了，`fetch-depth` 判据也就无处附着（本仓 job 键改名时必须同步改这里）'];
  }
  const steps = stepsOf(job);
  const checkouts = steps.filter(step => step.lines.some(line => /^\s*(?:-\s+)?uses\s*:\s*actions\/checkout@/.test(line)));
  if (checkouts.length === 0) {
    return [`\`${CHECKOUT_JOB_ID}\` job（第 ${job.start + 1}–${job.end} 行）里没有 \`uses: actions/checkout@…\` 这一步`];
  }
  const hint = '文档锚点位移闸门需要真 base（`git merge-base HEAD origin/main`）；'
    + '`fetch-depth: 1` 会让它在 CI 上走 SKIP ⇒ 假绿';
  const hits = [];
  for (const step of checkouts) {
    const value = withValueOf(step.lines, 'fetch-depth');
    if (value === null) {
      hits.push(`第 ${step.line} 行的 checkout 没有 \`with.fetch-depth\`（默认就是 1）：${hint}`);
    } else if (!/^0$/.test(value)) {
      hits.push(`第 ${step.line} 行的 checkout 是 \`fetch-depth: ${value}\`，不是 \`0\`：${hint}`);
    }
  }
  return hits;
}

/** 去掉 YAML 标量两侧的引号（`0` / `'0'` / `"0"` 一律当同一个值；YAML 解析后本来也都是 0）。 */
function unquoteYamlScalar(value) {
  return String(value).replace(/^['"]|['"]$/g, '').trim();
}

/**
 * 读一个 step 的 `with:` 映射里某个键的值（未出现返回 null）。
 * 两种写法都认：块（`with:` 换行 + 缩进子键）与行内流式映射（`with: { a: 1, b: 2 }`）。
 * 只在该 step 自己的行区间里找 —— 兄弟 step 的 `with:` 不许被算进来。
 */
function withValueOf(stepLines, key) {
  const keyPattern = new RegExp(`^\\s*${key}\\s*:\\s*(.*)$`);
  for (let index = 0; index < stepLines.length; index += 1) {
    const line = stepLines[index];
    const inline = /^\s*(?:-\s+)?with\s*:\s*\{(.*)\}\s*$/.exec(line);
    if (inline) {
      for (const pair of inline[1].split(',')) {
        const match = new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`).exec(pair);
        if (match) return unquoteYamlScalar(match[1]);
      }
      continue;
    }
    if (!/^\s*(?:-\s+)?with\s*:\s*$/.test(line)) continue;
    const withIndent = /^\s*/.exec(line)[0].length;
    for (let cursor = index + 1; cursor < stepLines.length; cursor += 1) {
      const child = stepLines[cursor];
      if (child.trim() === '' || /^\s*#/.test(child)) continue;
      if (/^\s*/.exec(child)[0].length <= withIndent) break;
      const match = keyPattern.exec(child);
      if (match) return unquoteYamlScalar(match[1]);
    }
  }
  return null;
}

/** 六种内存变异的公共入口：只改文本，不写盘。 */
function mutate(transform) {
  const original = readRepoText(WORKFLOW_FILE);
  const mutated = transform(original);
  assert.notEqual(mutated, original, '变异必须真的改到文本（否则反向控制是空转）');
  return mutated;
}

test('① `retention-gates` job 里有且只有一条 `npm run verify:purge-schedule`', () => {
  const source = readRepoText(WORKFLOW_FILE);
  const problems = gateStepProblems(source);
  assert.deepEqual(problems, [], [
    '保留/清理门禁不在 CI 上跑（或接线被打断）：',
    ...problems.map(problem => `  · ${problem}`),
    '改法：在 `.github/workflows/engineering-shell.yml` 里保留 `retention-gates` job，并让它含一行',
    `      - run: ${GATE_COMMAND}`,
    '⛔ 不要加 `if:` / `continue-on-error` / 行尾 `|| true`／`--root`；也不要把它挪进 real-pg workflow。',
  ].join('\n'));

  // 反空转：job 与 step 必须真解析到，否则「无问题」只是没扫到东西。
  const job = jobBlockOf(source);
  assert.ok(job, `\`${WORKFLOW_FILE}\` 里找不到 \`${JOB_ID}:\``);
  assert.ok(stepsOf(job).length >= 2, '`retention-gates` 只解析出 1 个 step，缩进口径或 job 结构可能已变');
  assert.ok(gateStepsOf(stepsOf(job))[0].commands.includes(GATE_COMMAND), '解析出的门禁 step 不含契约命令');
});

test('② job 级与 step 级都不带软失败构造', () => {
  const problems = softFailureProblems(readRepoText(WORKFLOW_FILE));
  assert.deepEqual(problems, [], [
    `保留/清理门禁被改成了软失败（${problems.length} 处）：`,
    ...problems.map(problem => `  · ${problem}`),
    '以上任一构造都会让「校验失败」仍被判绿 —— 门禁等于没有。',
  ].join('\n'));
});

test('③ 本 job 不跑任何真库命令（真库臂属于 real-pg-integration.yml）', () => {
  const source = readRepoText(WORKFLOW_FILE);
  const problems = realPgProblems(source);
  assert.deepEqual(problems, [], [
    `\`${JOB_ID}\` job 混进了真库臂的东西（${problems.length} 处）：`,
    ...problems.map(problem => `  · ${problem}`),
    '真库脚本缺 `GY_PG_BIN` 时按约定 exit 77 跳过、装 PG 17 要额外几十秒，且 `services.postgres` 只有',
    '`real-pg-integration.yml` 的 `real-pg-17.11` job 有 ⇒ 拖进这一层只会让「无需 PG」的 PR 检查红或空转。',
  ].join('\n'));

  // 反空转：同一个检测器在真库 workflow 上必须命中，否则判据 ③ 可能是「永远空」的检测器。
  const realPg = readRepoText('.github/workflows/real-pg-integration.yml');
  const probe = runCommandsOf(realPg.split('\n'));
  const probeHits = probe.filter(command => REAL_PG_TOKENS.some(token => command.includes(token)));
  assert.ok(probeHits.length >= 1, '真库 workflow 的命令里一个真库 token 都扫不到 ⇒ 判据 ③ 的检测器是死的');
});

test('④ `on.pull_request` 不过滤；入口同源且带不上 `--root`／`--dir`', () => {
  const pullProblems = pullRequestProblems(readRepoText(WORKFLOW_FILE));
  assert.deepEqual(pullProblems, [], [
    '保留/清理门禁不是「每次 PR 都跑」：',
    ...pullProblems.map(problem => `  · ${problem}`),
  ].join('\n'));

  const packageJson = JSON.parse(readRepoText('package.json'));
  const entryProblems = entryScriptProblems(packageJson);
  assert.deepEqual(entryProblems, [], [
    '`verify:purge-schedule` 入口被改得不再是「真仓库的同一颗校验器」：',
    ...entryProblems.map(problem => `  · ${problem}`),
  ].join('\n'));

  // 反空转：同一份 package.json 里其它 script（例如 lint）必须被判为「不同源」，证明判据能红。
  assert.ok(
    entryScriptProblems({ scripts: { [NPM_SCRIPT]: 'node tools/lint-workspaces.mjs' } }).length >= 1,
    '换一个入口文件也必须报错（否则 ④b 只认「有没有这条 script」）',
  );
});

test('⑤ 反向控制：删命令／写成注释／换脚本／加 `if:`／加 `continue-on-error:`／塞真库命令／给 PR 加过滤，七种变异都必须红', () => {
  const baseline = readRepoText(WORKFLOW_FILE);
  assert.deepEqual(gateStepProblems(baseline), []);
  assert.deepEqual(softFailureProblems(baseline), []);
  assert.deepEqual(realPgProblems(baseline), []);

  // (1) 整行删掉 ⇒ 判据 ① 必须红并点名 job。
  const deleted = mutate(source => source.split('\n').filter(line => line.trim() !== `- run: ${GATE_COMMAND}`).join('\n'));
  const deletedProblems = gateStepProblems(deleted);
  assert.equal(deletedProblems.length, 1, `删掉门禁步后必须正好报一处问题：${deletedProblems.join(' / ')}`);
  assert.ok(deletedProblems[0].includes(JOB_ID), '失败信息必须点名 job');

  // (2) 写成 shell 注释 ⇒ 注释不是命令，① 必须红（同 ci-real-pg-wiring 的 `runCommandTextsOf` 口径）。
  const commented = mutate(source => source.replace(`      - run: ${GATE_COMMAND}`, `      # - run: ${GATE_COMMAND}`));
  assert.equal(gateStepProblems(commented).length, 1, '把门禁步改成注释也必须红');

  // (3) 换成别的 npm script ⇒ ① 必须红。
  const swapped = mutate(source => source.replace(`      - run: ${GATE_COMMAND}`, '      - run: npm run lint'));
  assert.equal(gateStepProblems(swapped).length, 1, '把门禁命令换成 `npm run lint` 也必须红');

  // (4) 给那一步加 `if:` ⇒ ② 必须红。
  const conditional = mutate(source => source.replace(
    `      - run: ${GATE_COMMAND}`,
    `      - run: ${GATE_COMMAND}\n        if: \${{ github.event_name == 'push' }}`,
  ));
  assert.equal(softFailureProblems(conditional).length, 1, '给门禁步加 `if:` 也必须红');

  // (5) 给那一步加 `continue-on-error: true` ⇒ ② 必须红（且要点到位）。
  const soft = mutate(source => source.replace(
    `      - run: ${GATE_COMMAND}`,
    `      - run: ${GATE_COMMAND}\n        continue-on-error: true`,
  ));
  const softProblems = softFailureProblems(soft);
  assert.equal(softProblems.length, 1, `加 \`continue-on-error: true\` 后必须正好报一处：${softProblems.join(' / ')}`);
  assert.ok(softProblems[0].includes('continue-on-error'), '失败信息必须点名字段');

  // (6) 塞一条真库命令 ⇒ ③ 必须红并点名 token（证明「不碰真库」这条真的在判）。
  const realDb = mutate(source => source.replace(
    `      - run: ${GATE_COMMAND}`,
    `      - run: ${GATE_COMMAND}\n      - run: node tests/integration/online-purge-pg.mjs`,
  ));
  const realDbProblems = realPgProblems(realDb);
  assert.equal(realDbProblems.length, 1, `塞真库命令后必须正好报一处：${realDbProblems.join(' / ')}`);
  assert.ok(realDbProblems[0].includes('tests/integration/'), '失败信息必须点名那个 token');

  // (7) 给 `pull_request:` 加 `paths` 过滤 ⇒ ④a 必须红（「不是每次 PR」）。
  const filtered = mutate(source => source.replace('  pull_request:\n', "  pull_request:\n    paths:\n      - 'docs/**'\n"));
  const filteredProblems = pullRequestProblems(filtered);
  assert.ok(filteredProblems.length >= 1, '给 `pull_request:` 加 paths 过滤也必须红（现在是绿的）');
  assert.ok(filteredProblems.some(problem => problem.includes('paths')), '失败信息必须点名被加的那个过滤键');
});

test('⑥ `unit` job 的 checkout 带 `fetch-depth: 0`（否则文档锚点位移闸门在 CI 上 SKIP ⇒ 假绿）', () => {
  const source = readRepoText(WORKFLOW_FILE);
  const problems = checkoutDepthProblems(source);
  assert.deepEqual(problems, [], [
    `\`${CHECKOUT_JOB_ID}\` job 的 checkout 没给足历史（${problems.length} 处）：`,
    ...problems.map(problem => `  · ${problem}`),
    '改法：在 `.github/workflows/engineering-shell.yml` 的 `unit` job 里，给 `actions/checkout` 那一步写：',
    '        with:',
    '          fetch-depth: 0',
    '⛔ 不要改成 `1`／删掉：那条闸门会拿不到 base，退化成 SKIP（exit 0）＝空跑。',
  ].join('\n'));

  // 反空转：job 与 checkout step 必须真解析到，否则「无问题」只是没扫到东西。
  const job = jobBlockOf(source, CHECKOUT_JOB_ID);
  assert.ok(job, `\`${WORKFLOW_FILE}\` 里找不到 \`${CHECKOUT_JOB_ID}:\` job`);
  const steps = stepsOf(job);
  assert.ok(steps.length >= 3, `\`${CHECKOUT_JOB_ID}\` job 只解析出 ${steps.length} 个 step，缩进口径或 job 结构可能已变`);
  const checkout = steps.find(step => step.lines.some(line => /uses\s*:\s*actions\/checkout@/.test(line)));
  assert.ok(checkout, `\`${CHECKOUT_JOB_ID}\` job 里解析不出 \`actions/checkout\` step`);
  assert.equal(withValueOf(checkout.lines, 'fetch-depth'), '0', 'checkout step 自己的 `with.fetch-depth` 必须读成 0');

  // 反向控制：改成 1／整行删掉／换成行内 `with: {…}` 三种改法，前两种必须红、行内写法必须照样认。
  const shallow = mutate(text => text.replace(/^( *)(fetch-depth: 0)$/m, '$1fetch-depth: 1'));
  const shallowProblems = checkoutDepthProblems(shallow);
  assert.equal(shallowProblems.length, 1, `把 \`fetch-depth: 0\` 改成 1 必须正好报一处：${shallowProblems.join(' / ')}`);
  assert.match(shallowProblems[0], /fetch-depth: 1/, '失败信息必须点名被改成 1 的那个值');
  assert.match(shallowProblems[0], /假绿/, '失败信息必须说清后果（SKIP ⇒ 假绿）');
  assert.match(shallowProblems[0], /git merge-base HEAD origin\/main/, '失败信息必须点出闸门的取 base 方式');

  const dropped = mutate(text => text.split('\n').filter(line => line.trim() !== 'fetch-depth: 0').join('\n'));
  const droppedProblems = checkoutDepthProblems(dropped);
  assert.equal(droppedProblems.length, 1, `整行删掉 \`fetch-depth: 0\` 必须正好报一处：${droppedProblems.join(' / ')}`);
  assert.match(droppedProblems[0], /没有 `with\.fetch-depth`/, '缺键时的文案必须点明「没有这个键（默认 1）」');

  const inline = mutate(text => text.replace(
    /^( *)with:\n( *persist-credentials: false\n)(?: *#.*\n)*( *fetch-depth: 0\n)/m,
    '$1with: { persist-credentials: false, fetch-depth: 0 }\n',
  ));
  assert.deepEqual(checkoutDepthProblems(inline), [], '行内流式 `with: { … }` 写法也必须认出 `fetch-depth: 0`');

  // 反向控制 2：兄弟 job／兄弟 step 上的 `fetch-depth: 0` 不许蒙过本判据（用一份最小合成 workflow 定范围）。
  const scoped = [
    'jobs:',
    '  docs:',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '        with:',
    '          fetch-depth: 0',
    '  unit:',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '        with:',
    '          persist-credentials: false',
    '      - uses: actions/setup-node@v4',
    '        with:',
    '          cache: npm',
    '          fetch-depth: 0',
  ].join('\n');
  const scopedProblems = checkoutDepthProblems(scoped);
  assert.equal(scopedProblems.length, 1, `只有别的 job／别的 step 带 fetch-depth 时必须仍红：${scopedProblems.join(' / ')}`);
  assert.match(scopedProblems[0], /第 9 行/, '必须点名 `unit` job 自己那一步（第 9 行）的 checkout');
});
