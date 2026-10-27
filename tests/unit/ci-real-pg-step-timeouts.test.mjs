/**
 * GY-R67-D03 · 真库 CI 的「step 封顶」与「job 级超时」的**账目**守卫。
 *
 * 背景：`.github/workflows/real-pg-integration.yml` 自己声明的运行纪律是「每个真库臂 step 各自封顶
 * `timeout-minutes: 5`（本机实测整臂 ≈ 40 s，5 分钟是它自己的封顶），⛔ 不靠 job 级 15 分钟兜底——
 * 那会把『这一步卡死』混成『job 超时』」。只要有一个臂 step 忘了写封顶，这条纪律就当场失效：它卡死时
 * 只能等 job 级超时，红的位置也就从「哪一步卡死」退化成「job 超时」，读数与失败不可区分。
 * 与此同时 job 级数值必须**晚于**「本 job 内各 step 封顶之和 + 前置余量」——否则「某步封顶还没到、
 * job 就先被杀」这类组合照样会把责任错记到 job 头上。
 *
 * 本文件只做**结构/账目**判据（不读臂的断言内容，不代替臂本身，也不读臂脚本）：
 *   ① 每个 `run:` 里出现 `tests/integration/` 的 step 都必须有显式 step 级 `timeout-minutes`，
 *      且取值 = 臂的纪律常量 `ARM_STEP_TIMEOUT_MINUTES`（写别的值等于单方面放宽这一步的封顶）；
 *   ①b 每个 job 里**所有** step（不只是臂）都必须有 step 级 `timeout-minutes`，且取值满足各自的纪律常量：
 *      `uses: actions/*` = `ACTION_STEP_TIMEOUT_MINUTES`、`npm ci` = `NPM_CI_STEP_TIMEOUT_MINUTES`、
 *      其它 `run:` step ≤ `MAX_STEP_TIMEOUT_MINUTES`（臂那 5 分钟归判据① 判，本判据不重复报）。
 *      R68 之前 checkout / setup-node / `npm ci` 三条前置**没有任何封顶**：那三条是最容易卡在网络上的一组，
 *      一旦卡死，红的位置就退回「job 超时」，判据① 只管臂、管不到它们。`npm ci` 的真实耗时见常量
 *      `NPM_CI_STEP_TIMEOUT_MINUTES` 上的实测引用（run `40547840506`：2.0 s / 1.0 s / 2.0 s）；
 *   ①c 每个臂 step 的 `run:` 里必须**恰一个** `tests/integration/*.mjs`——两个臂塞进同一步时封顶仍是
 *      一条 5 分钟、Σ 与臂数都不变，判据① ② 都看不见（见 `armScriptCountProblems`）；
 *   ② 每个 job 的 job 级 `timeout-minutes` ≥ 本 job 内 `Σ step 封顶 + PREFIX_RESERVE_MINUTES`；
 *   ③ 每个 job 头顶注释里的算式必须与文件实测一致（形如 `封顶之和 185 + 前置余量 10 = job 级 195`）——
 *      本条正是这次账目对不上的病灶：注释写着「五条臂各 5 = 33 ⇒ 35」，而文件里其实有六条臂。
 *   ④ 扫描面自证：解析出的 job 集合必须等于 `jobs:` 段里的全部 job 键（否则判据① ② 会空转成绿）；
 *      并钉住反空转下界（全文 step 数 ≥ `MIN_TOTAL_STEPS`、每个 job ≥ `MIN_STEPS_PER_JOB`、
 *      每个 job 至少解析出一条 `uses: actions/*`）——解析器塌一半时判据①b 的覆盖面会静默缩小；
 *   ⑥ 相对抗性（对抗审查 M8／W6／N1）：**声明侧（`declaredJobKeys`）故意比解析器宽**——四种合法
 *      但严格键正则读不到的写法（行尾注释 `key: # …`、双引号键 `"key":`、单引号键 `'key':`、
 *      点号键 `key.with.dots:`、引号内空格 `"key with space":`），必须让判据④ 红并点名；
 *      同时钉住「宽的那一侧不能自阉割」：判据④ 是 `deepEqual(…, [])`，光靠它会漏掉「永远返回空」的阉割。
 *      两边一旦共用同一条键正则，`deepEqual` 就退化成同义反复，判据④ 等于没写（实测逃逸：5/5 全绿）。
 *
 * 三个数字**一律现场解析重算**，不硬编码「14 条臂 / 35 分钟」这类可漂移的量：臂 step 数、Σ封顶、
 * job 级数值都从 workflow 文本里读出来再算账。唯一写死的常量是**纪律本身**——每个臂 5 分钟、
 * `uses: actions/*` 5 分钟、`npm ci` 15 分钟、其它 `run:` step ≤ 15 分钟，以及 job 级的显式常量余量 10 分钟。
 *
 * ⚠️ `PREFIX_RESERVE_MINUTES` 的**语义已变**（R68）：从前它是「checkout / setup-node / `npm ci` 这三条
 *    无封顶前置的合计上限」，现在三条前置已各自封顶（5 + 5 + 15 = 25）并计入 Σ，这 10 分钟与任何一条
 *    前置的实际上限都无关，只是给 job 级留的纯常量余量（判据② 用它算下界，注释里仍逐字写「前置余量 10」）。
 *
 * ⛔ 本文件不把 job 名集合写成硬编码登记表：判据① ② 对**文件里出现的每个 job** 泛化生效，
 *    新增一个 job 会自动被同一套账目约束；再把 job 名单钉死只会让「加一个 job」变成假红
 *    （而 `tests/unit/ci-unwired-declaration-reasons.test.mjs` 已负责「job 名必须真存在于 yml」那一面）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** 被守卫的 workflow（本片只动这一份）。 */
export const WORKFLOW_RELATIVE = '.github/workflows/real-pg-integration.yml';

/** 每个真库臂 step 自己的封顶（分钟）：纪律常量，不是从文件里读的。 */
export const ARM_STEP_TIMEOUT_MINUTES = 5;

/** 前置显式预留（分钟）：**纯常量余量**。R68 起三条前置已各自封顶并计入 Σ，见文件头 ⚠️ 说明。 */
export const PREFIX_RESERVE_MINUTES = 10;

/** 每条 `uses: actions/*` 前置 action step 自己的封顶（分钟）：纪律常量，不是从文件里读的。 */
export const ACTION_STEP_TIMEOUT_MINUTES = 5;

/**
 * `npm ci` 前置 step 自己的封顶（分钟）：买的是「网络挂死时这一步先红」，不是给正常安装留时间。
 *
 * 实测出处（本仓 CI 记录，非本地估时）：`gh api repos/GengYunChuChao/GengYun/actions/runs/40547840506/jobs`
 * —— 该 run 三个 job 里 `Run npm ci --no-audit --no-fund` 这一步分别耗 **2.0 s / 1.0 s / 2.0 s**
 * （`setup-node` 带 `cache: npm`；同一 run 三个 job 整跑 104.0 s / 56.0 s / 49.0 s、step 数 41 / 12 / 16）。
 * 15 分钟 ≈ 实测的 450–900 倍余量：它兜的是死锁，不是预计耗时。
 * 冷缓存（`cache: npm` 未命中的首次安装）耗时不掌握，但没有任何理由接近 15 分钟量级——真到那个量级，
 * 这一步就该红，而且红在它自己身上、不拖成「job 超时」。给 5 分钟会把偶发慢判成封顶红，给 30 分钟等于没封顶。
 */
export const NPM_CI_STEP_TIMEOUT_MINUTES = 15;

/** 除真库臂以外任何 step 的封顶上界（分钟）：单方面放宽到超过它即红（`npm ci` 就是这条上界）。 */
export const MAX_STEP_TIMEOUT_MINUTES = NPM_CI_STEP_TIMEOUT_MINUTES;

/** 反空转下界：全文现场解析出的 step 总数不得低于它（R68 基线 51 步）。 */
export const MIN_TOTAL_STEPS = 45;

/** 反空转下界：每个 job 至少解析出的 step 数（R68 基线最小的是读 job 的 6 步）。 */
export const MIN_STEPS_PER_JOB = 5;

/**
 * 把整行注释替换成空行（**保留行号**）。判据必须看有效内容：注释里出现的
 * `tests/integration/xxx.mjs` 不能把上一条 `npm ci` step 误判成「真库臂」。
 */
export function blankCommentLines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => (/^\s*#/.test(line) ? '' : line))
    .join('\n');
}

/** 一个 step 的可读标签：优先 `name:`，其次点名的脚本，都没有就报行号。 */
export function stepLabel(step) {
  if (step.name !== null) return step.name;
  if (step.integrationScript !== null) return `(无 name) → tests/integration/${step.integrationScript}`;
  return `(无 name，第 ${step.lineNumber} 行)`;
}

function parseSteps(jobLines, lineOffset) {
  const starts = [];
  jobLines.forEach((line, index) => {
    if (/^ {6}- /.test(line)) starts.push(index);
  });
  const steps = [];
  for (let k = 0; k < starts.length; k += 1) {
    const from = starts[k];
    const to = k + 1 < starts.length ? starts[k + 1] : jobLines.length;
    const chunkLines = jobLines.slice(from, to);
    const chunk = chunkLines.join('\n');
    const nameMatch = /^ {6}- name:\s*(.+)$/.exec(chunkLines[0]) ?? /^ {8}name:\s*(.+)$/m.exec(chunk);
    const timeoutMatch = /^ {8}timeout-minutes:\s*(\d+)\s*$/m.exec(chunk);
    const scriptMatch = /tests\/integration\/([A-Za-z0-9._-]+\.mjs)/.exec(chunk);
    // 同一步里的**全部**臂脚本（判据①c 用）：`chunk` 已由 `parseWorkflow` 抹掉注释行，所以这里
    // 数到的只有 `run:` 里真正会执行的引用，注释里提到别的 `.mjs` 不会把它们算进来。
    const scriptMatches = chunk.match(/tests\/integration\/([A-Za-z0-9._-]+\.mjs)/g) ?? [];
    // 前置 step 的「身份」：`uses:` 的 action 引用，或 `run:` 之后的首行命令（含 `|` 块写法）。
    const usesMatch = /^ {6}- uses:\s*(\S+)\s*$/.exec(chunkLines[0]) ?? /^ {8}uses:\s*(\S+)\s*$/m.exec(chunk);
    const runMatch = /^ {6}- run:\s*(.*)$/.exec(chunkLines[0]) ?? /^ {8}run:\s*(.*)$/m.exec(chunk);
    steps.push({
      name: nameMatch === null || nameMatch === undefined ? null : nameMatch[1].trim(),
      timeout: timeoutMatch === null ? null : Number(timeoutMatch[1]),
      integrationScript: scriptMatch === null ? null : scriptMatch[1],
      integrationScripts: scriptMatches.map((ref) => ref.replace(/^tests\/integration\//, '')),
      uses: usesMatch === null ? null : usesMatch[1],
      runCommand: runMatch === null ? null : runMatch[1].trim(),
      lineNumber: lineOffset + from + 1,
    });
  }
  return steps;
}

/**
 * step 的类别：`arm`（跑 `tests/integration/*.mjs`）/ `action`（`uses:`）/ `npm-ci`（`run: npm ci …`）/
 * `run`（其它命令 step）/ `unknown`。判据①b 按类别选纪律常量，判据① 只认 `arm`。
 */
export function stepKind(step) {
  if (step.integrationScript !== null) return 'arm';
  if (step.uses !== null) return 'action';
  if (step.runCommand !== null && /^npm ci\b/.test(step.runCommand)) return 'npm-ci';
  if (step.runCommand !== null) return 'run';
  return 'unknown';
}

/** 判据①b 的报错标签：`name:` → `uses:` 引用 → `run:` 首行 → 行号（必须能直接指到是哪一步）。 */
export function stepCapLabel(step) {
  if (step.name !== null) return step.name;
  if (step.uses !== null) return `uses: ${step.uses}`;
  if (step.runCommand !== null) return `run: ${step.runCommand}`;
  return `(无 name，第 ${step.lineNumber} 行)`;
}

/** 判据①b：类别 → 纪律常量（分钟）。 */
export function stepCeilingMinutes(kind) {
  if (kind === 'action') return ACTION_STEP_TIMEOUT_MINUTES;
  if (kind === 'npm-ci') return NPM_CI_STEP_TIMEOUT_MINUTES;
  if (kind === 'arm') return ARM_STEP_TIMEOUT_MINUTES;
  return MAX_STEP_TIMEOUT_MINUTES;
}

/**
 * 从 workflow 文本解析出 job 与 step（只认缩进结构，不依赖任何 YAML 依赖——
 * 仓内没有 `yaml` / `js-yaml`，既有守卫同样走文本结构判据）。
 * 返回 `[{ id, lineNumber, jobTimeout, steps }]`，`jobTimeout` 缺省为 `null`。
 */
export function parseWorkflow(rawText) {
  const lines = blankCommentLines(rawText).split(/\r?\n/);
  const jobsAt = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (jobsAt < 0) throw new Error('workflow 里没有 `jobs:` 段');
  const jobs = [];
  for (let index = jobsAt + 1; index < lines.length; index += 1) {
    const key = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(lines[index]);
    if (key === null) continue;
    let end = lines.length;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[cursor])) {
        end = cursor;
        break;
      }
    }
    const jobLines = lines.slice(index, end);
    const jobTimeoutMatch = /^ {4}timeout-minutes:\s*(\d+)\s*$/m.exec(jobLines.join('\n'));
    jobs.push({
      id: key[1],
      lineNumber: index + 1,
      jobTimeout: jobTimeoutMatch === null ? null : Number(jobTimeoutMatch[1]),
      steps: parseSteps(jobLines, index),
    });
    index = end - 1;
  }
  return jobs;
}

/** 某个 job 头顶的连续注释块（紧挨着 job 键的那些 `#` 行）。 */
export function commentBlockAbove(rawLines, jobLineNumber) {
  const block = [];
  for (let index = jobLineNumber - 2; index >= 0; index -= 1) {
    const line = rawLines[index];
    if (!/^\s*#/.test(line)) break;
    block.unshift(line.trim());
  }
  return block.join('\n');
}

/** 本 job 内各 step 封顶之和（无封顶 step 记 0）。 */
export function sumStepTimeouts(job) {
  return job.steps.reduce((total, step) => total + (step.timeout ?? 0), 0);
}

/** 判据①：每个真库臂 step 必须有显式的 5 分钟封顶。 */
export function armTimeoutProblems(rawText) {
  const problems = [];
  for (const job of parseWorkflow(rawText)) {
    for (const step of job.steps) {
      if (step.integrationScript === null) continue;
      if (step.timeout === null) {
        problems.push(
          `job \`${job.id}\` · step「${stepLabel(step)}」跑了 tests/integration/${step.integrationScript} `
            + `却没有显式 \`timeout-minutes\`（第 ${step.lineNumber} 行）⇒ 这一步卡死时只能等 job 级超时，`
            + `违反「每个真库臂 step 各自封顶 ${ARM_STEP_TIMEOUT_MINUTES} 分钟」的纪律`,
        );
      } else if (step.timeout !== ARM_STEP_TIMEOUT_MINUTES) {
        problems.push(
          `job \`${job.id}\` · step「${stepLabel(step)}」的 step 级封顶是 ${step.timeout} 分钟，`
            + `与臂的纪律常量 ${ARM_STEP_TIMEOUT_MINUTES} 分钟不一致（第 ${step.lineNumber} 行）`
            + '⇒ 单方面放宽这一步的封顶，账目会在注释里对不上',
        );
      }
    }
  }
  return problems;
}

/**
 * 判据①c：每个真库臂 step 的 `run:` 里必须**恰一个** `tests/integration/*.mjs`。
 *
 * 为什么需要这条：判据① 只判「这一步有 5 分钟封顶」，判据② 按 step 条数算 Σ——于是存在一条逃逸：
 * 把两个臂塞进同一个 step（`node a.mjs && node b.mjs`），封顶仍是**一条** 5 分钟、Σ 封顶与臂数都不变，
 * 账目上完全看不出「本该是两条 5 分钟」；更糟的是两条臂共用同一个封顶，前一条跑满 5 分钟就会把
 * 后一条挤成红，读数上分不清是哪个臂卡死。本仓 39 条臂（31 / 2 / 6）逐条实测都是恰一个 `.mjs`，
 * 所以这条约束不是假想纪律。
 */
export function armScriptCountProblems(rawText) {
  const problems = [];
  for (const job of parseWorkflow(rawText)) {
    for (const step of job.steps) {
      if (step.integrationScripts.length <= 1) continue;
      problems.push(
        `job \`${job.id}\` · step「${stepLabel(step)}」的 \`run:\` 里出现了 ${step.integrationScripts.length} 个 `
          + `\`tests/integration/*.mjs\`（${step.integrationScripts.join(' + ')}，第 ${step.lineNumber} 行）`
          + `⇒ 一个 step 只能跑一个臂：两个臂挤在同一步会共用同一个 ${ARM_STEP_TIMEOUT_MINUTES} 分钟封顶，`
          + 'Σ 封顶与臂数都不变，账目上看不出少算了一条封顶，也分不清是哪个臂卡死',
      );
    }
  }
  return problems;
}

/**
 * 判据①b：**每个 step**（不只是臂）都必须有 step 级封顶，且取值满足各自的纪律常量。
 *
 * 为什么必须泛化到「所有 step」：R68 之前 checkout / setup-node / `npm ci` 三条前置没有任何封顶。
 * 最坏情况下（网络挂死）它们会一直等到 job 级超时：job1 是 170 分钟、job2 25 分钟、job3 45 分钟 ——
 * 「哪一步卡死」在读数上完全消失。给三条前置各自封顶后，job 级才是有意义的算术兜底。
 *
 * 取值纪律：`uses: actions/*` 恰 5、`npm ci` 恰 15、其它 `run:` step ≤ 15（上界 `MAX_STEP_TIMEOUT_MINUTES`）；
 * 臂那「恰 5 分钟」归判据①（`armTimeoutProblems`）判，本判据对 `arm` 只判「有没有」，不重复报取值。
 */
export function stepCapProblems(rawText) {
  const problems = [];
  for (const job of parseWorkflow(rawText)) {
    for (const step of job.steps) {
      const kind = stepKind(step);
      if (step.timeout === null) {
        problems.push(
          `job \`${job.id}\` · step「${stepCapLabel(step)}」没有 step 级 \`timeout-minutes\`（第 ${step.lineNumber} 行）`
            + '⇒ 这一步卡死时只能等 job 级超时，「这一步卡死」会被读成「job 超时」；'
            + '前置 step（`actions/checkout` / `actions/setup-node` / `npm ci`）同样要各自封顶，'
            + `本仓纪律：\`uses: actions/*\` = ${ACTION_STEP_TIMEOUT_MINUTES} 分钟、`
            + `\`npm ci\` = ${NPM_CI_STEP_TIMEOUT_MINUTES} 分钟`,
        );
        continue;
      }
      if (kind === 'arm') continue;
      const ceiling = stepCeilingMinutes(kind);
      const exact = kind === 'action' || kind === 'npm-ci';
      if (exact ? step.timeout !== ceiling : !(step.timeout > 0 && step.timeout <= ceiling)) {
        problems.push(
          `job \`${job.id}\` · step「${stepCapLabel(step)}」的 step 级封顶是 ${step.timeout} 分钟，`
            + `与「${kind}」这类 step 的纪律常量${exact ? '' : '上界'} ${ceiling} 分钟不符（第 ${step.lineNumber} 行）`
            + '⇒ 单方面放宽这一步的封顶，账目会在注释里对不上',
        );
      }
    }
  }
  return problems;
}

/** 判据②：job 级超时必须晚于「本 job 内 Σ step 封顶 + 前置预留」。 */
export function jobBudgetProblems(rawText) {
  const problems = [];
  for (const job of parseWorkflow(rawText)) {
    const capped = job.steps.filter((step) => step.timeout !== null).length;
    const sum = sumStepTimeouts(job);
    const required = sum + PREFIX_RESERVE_MINUTES;
    if (job.jobTimeout === null) {
      problems.push(
        `job \`${job.id}\`：缺 job 级 \`timeout-minutes\`（本 job 的 Σ step 封顶 ${sum} 分钟，`
          + `需要 ≥ ${required}）`,
      );
      continue;
    }
    if (job.jobTimeout < required) {
      problems.push(
        `job \`${job.id}\`：job 级 timeout-minutes = ${job.jobTimeout}，`
          + `但 Σ step 封顶 ${sum}（${capped} 条带封顶 step）+ 前置余量 ${PREFIX_RESERVE_MINUTES} = ${required} `
          + `⇒ job 级会先于某一步自己的封顶触发，把「这一步卡死」混成「job 超时」`,
      );
    }
  }
  return problems;
}

/** 判据③：job 头顶注释里的算式必须与文件实测一致。 */
export function commentArithmeticProblems(rawText) {
  const rawLines = rawText.split(/\r?\n/);
  const problems = [];
  for (const job of parseWorkflow(rawText)) {
    const block = commentBlockAbove(rawLines, job.lineNumber);
    if (block === '') {
      problems.push(`job \`${job.id}\` 头顶没有注释算式（job 级超时的来源必须写在文件里）`);
      continue;
    }
    const sum = sumStepTimeouts(job);
    const expected = `封顶之和 ${sum} + 前置余量 ${PREFIX_RESERVE_MINUTES} = job 级 ${job.jobTimeout}`;
    if (!block.includes(expected)) {
      problems.push(
        `job \`${job.id}\` 头顶注释与文件实测的账目对不上：缺算式「${expected}」`
          + `（实测：${job.steps.length} 个 step、其中 ${job.steps.filter((step) => step.timeout !== null).length} 条带封顶、`
          + `Σ封顶 ${sum}、job 级 ${job.jobTimeout}）`,
      );
    }
  }
  return problems;
}

/**
 * `jobs:` 段里的 job 键——**声明侧**的读法。
 *
 * ⚠️ 这一侧与解析器**不同源**，而且比解析器**宽**（下面四层都是合法 YAML，解析器那条严格键正则都读不到）：
 *   ① 行尾注释：`  key: # 说明`；
 *   ② 双引号键：`  "key":`；
 *   ③ 单引号键：`  'key':`；
 *   ④ 键名带点号：`  key.with.dots:`；键名里带空格只能靠引号：`  "key with space":`。
 * 键名取三个分组里非空的那个：`m[1] || m[2] || m[3]`。
 * 若两边共用同一条严格正则，新增这类 job 就会让两边一起漏读、`deepEqual` 退化成同义反复
 * （对抗审查 M8 的逃逸路径），判据④ 也就白写了；引号键 / 点号键 / 引号内空格是复审逐轮打出的同型逃逸
 * （`yaml` 真解析器对它们 0 error）。
 *
 * 扫描起点：`on:` 段之后、`jobs:` 行之后的**两空格缩进行**——`on:` 下的 `  push:`、job 体内的
 * `    name:` / `    runs-on:`、step 的 `      - run:` 都因缩进不是恰好两格而不会命中。
 */
const DECLARED_JOB_KEY = /^ {2}(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+)):\s*(?:#.*)?$/;

/** 声明侧：`jobs:` 之下的全部 job 键（含键带行尾注释 / 带引号 / 带点号的那些）。 */
export function declaredJobKeys(rawText) {
  const lines = blankCommentLines(rawText).split(/\r?\n/);
  const jobsAt = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  assert.notEqual(jobsAt, -1, 'workflow 里没有 `jobs:` 段 ⇒ 判据 ① ② 会空转成绿');
  const keys = [];
  for (const line of lines.slice(jobsAt + 1)) {
    const matched = DECLARED_JOB_KEY.exec(line);
    if (matched) keys.push(matched[1] || matched[2] || matched[3]);
  }
  return keys;
}

/**
 * 判据④：扫描面自证——解析出的 job 集合必须等于 `jobs:` 段里的**全部** job 键，
 * 且每个 job 都解析出 step、整份文件至少解析出一条真库臂。否则判据①②会空转成绿。
 *
 * ⚠️ 分工（别把这一条当端点 oracle）：本判据是 `assert.deepEqual(scanSurfaceProblems(…), [])`，
 * 所以「`scanSurfaceProblems` 被改成永远返回空」这种阉割同样能让它变绿。钉住这类自阉割的是用例⑥：
 * 它拿变异过的文本喂同一批函数，要求**必须报出问题并点名 job**。改本文件时两条要一起看。
 */
export function scanSurfaceProblems(rawText) {
  const parsed = parseWorkflow(rawText);
  const parsedIds = parsed.map((job) => job.id).sort();
  const declared = [...declaredJobKeys(rawText)].sort();
  const problems = [];
  if (parsedIds.join(',') !== declared.join(',')) {
    const missed = declared.filter((id) => !parsedIds.includes(id));
    problems.push(
      `解析出的 job 集合 [${parsedIds.join(', ')}] 与 \`jobs:\` 段的键 [${declared.join(', ')}] 不一致`
        + `（漏读：${missed.length === 0 ? '无' : missed.join(', ')}）⇒ 判据① ② 会在这个 job 上空转成绿`,
    );
  }
  if (parsed.length < 3) problems.push(`job 数实测 ${parsed.length}，少于 3 ⇒ 解析器可能只读到一半`);
  const arms = parsed.flatMap((job) => job.steps).filter((step) => step.integrationScript !== null);
  if (arms.length < 1) problems.push('一个 `tests/integration/` step 都没解析出来 ⇒ 判据① 失去作用域');
  const totalSteps = parsed.reduce((total, job) => total + job.steps.length, 0);
  if (totalSteps < MIN_TOTAL_STEPS) {
    problems.push(
      `全文只解析出 ${totalSteps} 个 step（反空转下界 ${MIN_TOTAL_STEPS}）`
        + '⇒ 解析器可能只读到一半，判据①b 的覆盖面会静默缩小',
    );
  }
  for (const job of parsed) {
    if (job.steps.length === 0) {
      problems.push(`job \`${job.id}\` 解析不出任何 step ⇒ 判据② 的 Σ 会恒为 0`);
      continue;
    }
    if (job.steps.length < MIN_STEPS_PER_JOB) {
      problems.push(
        `job \`${job.id}\` 只解析出 ${job.steps.length} 个 step（反空转下界 ${MIN_STEPS_PER_JOB}）`
          + '⇒ 这个 job 的 step 解析塌了，判据①/①b 会漏判',
      );
    }
    if (!job.steps.some((step) => step.uses !== null && /^actions\//.test(step.uses))) {
      problems.push(
        `job \`${job.id}\` 里解析不出任何 \`uses: actions/*\` step`
          + '⇒ 判据①b 的「前置 action 必须封顶」在这个 job 上失去作用域',
      );
    }
  }
  return problems;
}

/**
 * 探针：在 `jobs:` 下再插一个 job（内含一条**没有封顶**的真库臂 step），键由 `keyLine` 给出。
 * 它专测「声明侧与解析器是否同源」——四种合法但严格键正则读不到的写法各测一遍：
 *   ① `  d03: # …`（行尾注释）；② `  "d03": # …`（双引号键）；③ `  'd03': # …`（单引号键）；
 *   ④ `  d03.with.dots: # …`（点号键）；⑤ `  "d03 quoted": # …`（引号内空格）。
 * 见判据④ 的说明与用例⑥。
 */
function insertProbeJob(text, keyLine) {
  const lines = text.split(/\r?\n/);
  const jobsAt = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  assert.notEqual(jobsAt, -1, '自证前提：workflow 里必须有 `jobs:` 段');
  const probe = [
    `  ${keyLine}`,
    '    name: probe-d03',
    '    runs-on: ubuntu-24.04',
    '    timeout-minutes: 5',
    '    steps:',
    '      - run: node tests/integration/probe-d03-pg.mjs',
  ];
  lines.splice(jobsAt + 1, 0, ...probe);
  return lines.join('\n');
}

function readWorkflow() {
  return readFileSync(join(ROOT, WORKFLOW_RELATIVE), 'utf8');
}

/** 把一个 step 的封顶行换成 `replacement`（`null` = 删掉那一行）。仅供判别力自证使用。 */
function replaceStepTimeout(text, nameNeedle, replacement) {
  const lines = text.split('\n');
  const at = lines.findIndex((line) => /^ {6}- name:/.test(line) && line.includes(nameNeedle));
  assert.notEqual(at, -1, `自证前提：step「${nameNeedle}」必须存在（否则这条自证测的是空替换）`);
  for (let index = at + 1; index < lines.length && index <= at + 6; index += 1) {
    if (/^ {8}timeout-minutes:/.test(lines[index])) {
      if (replacement === null) lines.splice(index, 1);
      else lines[index] = replacement;
      return lines.join('\n');
    }
  }
  throw new Error(`自证前提：step「${nameNeedle}」没有 step 级封顶行`);
}

/** 把一个 job 的 job 级 `timeout-minutes` 换成 `replacement`（`null` = 删掉那一行）。 */
function replaceJobTimeout(text, jobId, replacement) {
  const lines = text.split('\n');
  const at = lines.findIndex((line) => line === `  ${jobId}:`);
  assert.notEqual(at, -1, `自证前提：job「${jobId}」必须存在`);
  for (let index = at + 1; index < lines.length; index += 1) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[index])) break;
    if (/^ {4}timeout-minutes:/.test(lines[index])) {
      if (replacement === null) lines.splice(index, 1);
      else lines[index] = replacement;
      return lines.join('\n');
    }
  }
  throw new Error(`自证前提：job「${jobId}」没有 job 级 timeout-minutes`);
}

/**
 * 把一个**无 `name:` 的前置 step**（`- uses: actions/checkout@…` / `- run: npm ci …`）的封顶行
 * 换成 `replacement`（`null` = 删掉那一行）。仅供判别力自证使用；`jobId` 限定在单个 job 内，
 * 因为 `- run: npm ci …` 在三个 job 里逐字相同。
 */
function replacePrefixStepTimeout(text, jobId, needle, replacement) {
  const lines = text.split('\n');
  const jobAt = lines.findIndex((line) => line === `  ${jobId}:`);
  assert.notEqual(jobAt, -1, `自证前提：job「${jobId}」必须存在`);
  let end = lines.length;
  for (let index = jobAt + 1; index < lines.length; index += 1) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[index])) { end = index; break; }
  }
  let at = -1;
  for (let index = jobAt + 1; index < end; index += 1) {
    if (/^ {6}- (uses|run):/.test(lines[index]) && lines[index].includes(needle)) { at = index; break; }
  }
  assert.notEqual(at, -1, `自证前提：job「${jobId}」里必须有前置 step「${needle}」（否则这条自证测的是空替换）`);
  for (let index = at + 1; index < end && index <= at + 6; index += 1) {
    if (/^ {8}timeout-minutes:/.test(lines[index])) {
      if (replacement === null) lines.splice(index, 1);
      else lines[index] = replacement;
      return lines.join('\n');
    }
  }
  throw new Error(`自证前提：job「${jobId}」的前置 step「${needle}」没有 step 级封顶行`);
}

test('① 每个跑 `tests/integration/*.mjs` 的 step 都有自己的 5 分钟封顶', () => {
  assert.deepEqual(
    armTimeoutProblems(readWorkflow()),
    [],
    '真库臂 step 缺 step 级封顶：卡死时只能等 job 级超时，「这一步卡死」会被读成「job 超时」',
  );
  // 判据①c：一个 step 只许跑一个臂（两个臂挤同一步会共用一条 5 分钟封顶，Σ 与臂数都不变）。
  assert.deepEqual(
    armScriptCountProblems(readWorkflow()),
    [],
    '一个臂 step 的 `run:` 里只能有一个 `tests/integration/*.mjs`：两个臂挤在同一步会让封顶之和少算一条，'
      + '且两条臂共用同一个封顶（前一条跑满 5 分钟就把后一条挤成红）',
  );
});

test('② 每个 job 的 job 级超时 ≥ 本 job 内 Σ step 封顶 + 前置预留', () => {
  assert.deepEqual(
    jobBudgetProblems(readWorkflow()),
    [],
    `job 级超时必须晚于「Σ step 封顶 + 前置余量 ${PREFIX_RESERVE_MINUTES} 分钟」，否则某一步的封顶还没到、job 就先被杀`,
  );
});

test('③ 每个 job 头顶注释里的算式 = 文件实测（臂数 / Σ封顶 / job 级）', () => {
  assert.deepEqual(
    commentArithmeticProblems(readWorkflow()),
    [],
    '注释里的账目必须与文件实测一致：靠人肉记「几条臂 × 几分」正是这次对不上的原因',
  );
});

test('④ 扫描面自证：解析出的 job 集合 = `jobs:` 段里的全部 job 键，且真库臂 step 不为空', () => {
  assert.deepEqual(
    scanSurfaceProblems(readWorkflow()),
    [],
    '解析器漏读 job ⇒ 判据 ① ② 会在那个 job 上静默变绿；判据的扫描面必须自证',
  );
});

test('①b 每个 step（含 checkout / setup-node / `npm ci` 三条前置）都必须有 step 级封顶，且取值合纪律', () => {
  const text = readWorkflow();
  assert.deepEqual(
    stepCapProblems(text),
    [],
    '有 step 没有 step 级封顶 ⇒ 它卡死时只能等 job 级超时，「这一步卡死」被读成「job 超时」',
  );

  // 覆盖自证：判据①b 的扫描面必须真的包含三条前置（否则这条判断会空转成绿）。
  const jobs = parseWorkflow(text);
  const kinds = jobs.flatMap((job) => job.steps.map((step) => [job.id, stepKind(step), step.timeout]));
  for (const job of jobs) {
    const mine = kinds.filter(([id]) => id === job.id);
    assert.equal(
      mine.filter(([, kind]) => kind === 'action').length,
      2,
      `job \`${job.id}\` 必须解析出 2 条 \`uses: actions/*\` 前置（checkout / setup-node），实测 `
        + `${mine.filter(([, kind]) => kind === 'action').length}`,
    );
    assert.equal(
      mine.filter(([, kind]) => kind === 'npm-ci').length,
      1,
      `job \`${job.id}\` 必须解析出 1 条 \`npm ci\` 前置，实测 ${mine.filter(([, kind]) => kind === 'npm-ci').length}`,
    );
    for (const [id, kind, timeout] of mine) {
      if (kind !== 'action' && kind !== 'npm-ci') continue;
      assert.equal(
        timeout,
        stepCeilingMinutes(kind),
        `job \`${id}\` 的 ${kind} step 封顶必须 = ${stepCeilingMinutes(kind)} 分钟，实测 ${timeout}`,
      );
    }
  }
});

test('⑥ 相对抗性（审查 M8／W6／N1）：声明侧与解析器必须**不同源**——四种「严格键正则读不到的合法写法」都要让判据④ 红并点名', () => {
  // 扫描起点的边界自证：`on:` 段、job 体内的 `name:` / `runs-on:`、step 的 `- run:` 都不得被当成 job 键。
  const fixture = [
    'name: 边界样例',
    'on:',
    '  push:',
    '    branches: [main]',
    'permissions:',
    '  contents: read',
    'jobs:',
    '  "quoted key":',
    "  'single key':",
    '  dotted.key:',
    '    name: inner-name',
    '    runs-on: ubuntu-24.04',
    '    steps:',
    '      - name: some step',
    '        run: echo hi',
    '',
  ].join('\n');
  assert.deepEqual(
    declaredJobKeys(fixture),
    ['quoted key', 'single key', 'dotted.key'],
    '声明侧只能命中 `jobs:` 之后的两空格缩进键：`on:` / `  push:` / `    name:` / `- run:` 都不是 job',
  );
  assert.ok(
    !declaredJobKeys(fixture).some((key) => ['on', 'push', 'name', 'runs-on', 'run', 'steps', 'contents'].includes(key)),
    '声明侧不得把 `on:` / `push:` / `name:` / `- run:` 之类的非 job 行当成 job 键',
  );

  const text = readWorkflow();
  const baselineIds = declaredJobKeys(text);

  // ⛔ 断言只用**数量不变量**（多一个 job / 多一处报错），不绑死探针 job 的名字，探针键还要**避开**文件里
  //    已有的 job 名：否则合法新增一个同名 job 会假红（复审实测：探针名写死成 `d03-extra` 时，
  //    真加一个 `d03-extra` 会让 ⑥ 变红、而别处全绿）。基线本身若有问题也只比增量，不让 ⑥ 变成「文件必须全好」。
  const keyForms = (key) => [
    ['键带行尾注释', `${key}: # probe job（合法 YAML：行尾注释）`, key],
    ['双引号键 + 行尾注释', `"${key}": # probe job（合法 YAML：双引号键）`, key],
    ['单引号键 + 行尾注释', `'${key}': # probe job（合法 YAML：单引号键）`, key],
    ['点号键 + 行尾注释', `${key}.with.dots: # probe job（合法 YAML：键名带点号）`, `${key}.with.dots`],
    ['引号内空格 + 行尾注释', `"${key} quoted": # probe job（合法 YAML：键名含空格）`, `${key} quoted`],
  ];
  let probeKey = 'd03-probe-extra';
  while (keyForms(probeKey).some(([, , jobName]) => baselineIds.includes(jobName))) probeKey += '-x';

  for (const [label, keyLine, jobName] of keyForms(probeKey)) {
    const probe = insertProbeJob(text, keyLine);
    assert.notEqual(probe, text, `自证前提（${label}）：探针 job 必须真的插入文本`);

    // 声明侧必须比基线多看见一个 job 键 —— 这一侧与解析器同源就会在这里当场变红。
    const declared = declaredJobKeys(probe);
    assert.equal(
      declared.length,
      baselineIds.length + 1,
      `自证前提（${label}）：声明侧必须多看见一个 job 键（${jobName}），实测 ${baselineIds.length} → ${declared.length}`
        + ' ⇒ 声明侧与解析器同源，两边会一起漏读（M8／引号键／点号键的逃逸路径：deepEqual 变同义反复）',
    );
    assert.ok(declared.includes(jobName), `自证前提（${label}）：声明侧必须把 ${jobName} 读成 job 键`);

    // 严格解析器读不到它 ⇒ 判据① 会盲，必须由判据④ 顶上（数量不变量，不绑名字）。
    assert.equal(
      parseWorkflow(probe).length,
      parseWorkflow(text).length,
      `自证前提（${label}）：解析器侧保持严格（只认不带引号、不带行尾注释、不带点号的键），探针 job 不应当被解析出来`,
    );

    const scanProblems = scanSurfaceProblems(probe);
    assert.ok(
      scanProblems.some((problem) => problem.includes(jobName)),
      `新增「${label}」的 job 必须被判据④ 抓住并点名（否则判据① 会在它上面静默变绿）：`
        + `${scanProblems.join(' / ')}`,
    );
  }
});

test('⑤ 判别力自证：删封顶（臂／前置）／把封顶改大（臂 120、臂 6、checkout 15）／把 job 级调小／删 job 级／注释脱钩／一步塞两个臂，每一条都必须红', () => {
  const text = readWorkflow();

  // 变异 1：删掉一条**臂**的封顶 ⇒ 判据① 与判据①b 都必须点名它（判据①b 只判「有没有」）。
  const withoutCap = replaceStepTimeout(text, '第三方删除库层语义', null);
  assert.notEqual(withoutCap, text, '自证前提：删封顶必须真的改动了文本');
  const missing = armTimeoutProblems(withoutCap);
  assert.equal(missing.length, 1, `删掉一条步封顶必须正好报一处：${missing.join(' / ')}`);
  assert.ok(missing[0].includes('real-pg-17-11'), `报错必须打出 job 名：${missing[0]}`);
  assert.ok(missing[0].includes('第三方删除库层语义'), `报错必须打出 step 名：${missing[0]}`);
  const missingCapSeen = stepCapProblems(withoutCap);
  assert.equal(missingCapSeen.length, 1, `删掉一条臂封顶必须被判据①b 也点到一处：${missingCapSeen.join(' / ')}`);
  assert.ok(missingCapSeen[0].includes('第三方删除库层语义'), `判据①b 必须打出 step 名：${missingCapSeen[0]}`);

  // 变异 2：把臂的封顶改成 120 ⇒ 判据① 必须报「与 5 不一致」。
  const widened = replaceStepTimeout(text, '第三方删除库层语义', '        timeout-minutes: 120');
  const widenedProblems = armTimeoutProblems(widened);
  assert.equal(widenedProblems.length, 1, `把封顶改成 120 必须正好报一处：${widenedProblems.join(' / ')}`);
  assert.ok(widenedProblems[0].includes('120'), `报错必须打出实测值：${widenedProblems[0]}`);

  // 变异 3：把臂的封顶改成 6（差 1 分钟的「悄悄放宽」）⇒ 判据① 必须红，不能只看「有没有」。
  const sixMinutes = replaceStepTimeout(text, '第三方删除库层语义', '        timeout-minutes: 6');
  const sixProblems = armTimeoutProblems(sixMinutes);
  assert.equal(sixProblems.length, 1, `把臂封顶改成 6 分钟必须正好报一处：${sixProblems.join(' / ')}`);
  assert.ok(sixProblems[0].includes('6 分钟'), `报错必须打出实测值 6 分钟：${sixProblems[0]}`);

  // 变异 4：删掉 job 里 `npm ci` 这条**前置**的封顶 ⇒ 判据①b 必须点名 `run:` 首行（它没有 `name:`）。
  const npmCiUncapped = replacePrefixStepTimeout(text, 'real-pg-17-11', 'run: npm ci', null);
  assert.notEqual(npmCiUncapped, text, '自证前提：`npm ci` 的封顶行必须真的被删掉');
  const npmCiProblems = stepCapProblems(npmCiUncapped);
  assert.equal(npmCiProblems.length, 1, `删掉 \`npm ci\` 的封顶必须正好报一处：${npmCiProblems.join(' / ')}`);
  assert.ok(npmCiProblems[0].includes('real-pg-17-11'), `报错必须打出 job 名：${npmCiProblems[0]}`);
  assert.ok(
    npmCiProblems[0].includes('run: npm ci --no-audit --no-fund'),
    `报错必须打出 step 的 \`run:\` 首行（这条前置没有 name）：${npmCiProblems[0]}`,
  );
  assert.equal(
    armTimeoutProblems(npmCiUncapped).length,
    0,
    '`npm ci` 不是真库臂 ⇒ 判据① 不该管它（两条判据的分工不能混）',
  );

  // 变异 5：删掉 `actions/checkout` 的封顶 ⇒ 判据①b 必须按 `uses:` 引用点名。
  const checkoutUncapped = replacePrefixStepTimeout(text, 'real-pg-admin-write-17-11', 'uses: actions/checkout@', null);
  assert.notEqual(checkoutUncapped, text, '自证前提：checkout 的封顶行必须真的被删掉');
  const checkoutProblems = stepCapProblems(checkoutUncapped);
  assert.equal(checkoutProblems.length, 1, `删掉 checkout 的封顶必须正好报一处：${checkoutProblems.join(' / ')}`);
  assert.ok(
    checkoutProblems[0].includes('uses: actions/checkout@'),
    `报错必须打出 \`uses:\` 引用：${checkoutProblems[0]}`,
  );

  // 变异 6：把 checkout 的封顶放宽到 15 ⇒ 判据①b 必须报「与 5 不符」（不是只看有没有）。
  const checkoutWidened = replacePrefixStepTimeout(text, 'real-pg-admin-read-17-11', 'uses: actions/checkout@', '        timeout-minutes: 15');
  const checkoutWidenedProblems = stepCapProblems(checkoutWidened);
  assert.equal(checkoutWidenedProblems.length, 1, `放宽 checkout 封顶必须正好报一处：${checkoutWidenedProblems.join(' / ')}`);
  assert.ok(checkoutWidenedProblems[0].includes('15 分钟'), `报错必须打出实测值：${checkoutWidenedProblems[0]}`);

  // 变异 7：把 job 级调小到 Σ封顶以下 ⇒ 判据② 必须红并打出两边数字。
  const crampedJob = replaceJobTimeout(text, 'real-pg-admin-write-17-11', '    timeout-minutes: 35');
  assert.notEqual(crampedJob, text, '自证前提：job 级数值必须真的被改动');
  const cramped = jobBudgetProblems(crampedJob);
  assert.equal(cramped.length, 1, `把 job 级调小到 Σ封顶附近必须正好报一处：${cramped.join(' / ')}`);
  assert.ok(cramped[0].includes('real-pg-admin-write-17-11'), `报错必须打出 job 名：${cramped[0]}`);
  assert.ok(cramped[0].includes('35'), `报错必须打出两边数字：${cramped[0]}`);

  // 变异 8：删掉 job 级 ⇒ 判据② 必须红。
  const noJobTimeout = replaceJobTimeout(text, 'real-pg-admin-read-17-11', null);
  assert.equal(jobBudgetProblems(noJobTimeout).length, 1, '删掉 job 级超时必须正好报一处');

  // 变异 9：注释与实测脱钩也算红：把 job 级数值改大但不改注释 ⇒ 判据③ 必须响。
  const driftedComment = replaceJobTimeout(text, 'real-pg-admin-read-17-11', '    timeout-minutes: 90');
  const driftProblems = commentArithmeticProblems(driftedComment);
  assert.equal(driftProblems.length, 1, `注释与实测脱钩必须正好报一处：${driftProblems.join(' / ')}`);
  assert.ok(driftProblems[0].includes('封顶之和 40 + 前置余量 10 = job 级 90'), `报错必须给出应有的算式：${driftProblems[0]}`);

  // 变异 10：把两个臂塞进同一个 step（封顶仍是一条 5 分钟、Σ 与臂数都不变）⇒ 判据①c 必须点名。
  //          这一步正是判据① 与判据② 都看不见的逃逸：① 只看「有没有封顶」、② 只按 step 条数求和。
  const doubleArms = text
    .split('\n')
    .map((line) => (line.includes('node tests/integration/community-pg.mjs')
      ? `${line} && node tests/integration/messages-pg.mjs`
      : line))
    .join('\n');
  assert.notEqual(doubleArms, text, '自证前提：双臂注入必须真的改动了文本');
  const doubleProblems = armScriptCountProblems(doubleArms);
  assert.equal(doubleProblems.length, 1, `一步塞两个臂必须正好报一处：${doubleProblems.join(' / ')}`);
  assert.ok(doubleProblems[0].includes('community-pg.mjs'), `报错必须打出两个臂脚本：${doubleProblems[0]}`);
  assert.ok(doubleProblems[0].includes('messages-pg.mjs'), `报错必须打出两个臂脚本：${doubleProblems[0]}`);
  assert.equal(armTimeoutProblems(doubleArms).length, 0, '双臂那一步自身仍带 5 分钟封顶 ⇒ 判据① 看不见它（所以要有①c）');
  assert.equal(jobBudgetProblems(doubleArms).length, 0, 'Σ 封顶与臂数都没变 ⇒ 判据② 也看不见它（所以要有①c）');
});
