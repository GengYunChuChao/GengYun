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
 *   ② 每个 job 的 job 级 `timeout-minutes` ≥ 本 job 内 `Σ step 封顶 + PREFIX_RESERVE_MINUTES`；
 *   ③ 每个 job 头顶注释里的算式必须与文件实测一致（形如 `封顶之和 160 + 前置余量 10 = job 级 170`）——
 *      本条正是这次账目对不上的病灶：注释写着「五条臂各 5 = 33 ⇒ 35」，而文件里其实有六条臂。
 *   ④ 扫描面自证：解析出的 job 集合必须等于 `jobs:` 段里的全部 job 键（否则判据① ② 会空转成绿）；
 *   ⑥ 相对抗性（对抗审查 M8／W6／N1）：**声明侧（`declaredJobKeys`）故意比解析器宽**——四种合法
 *      但严格键正则读不到的写法（行尾注释 `key: # …`、双引号键 `"key":`、单引号键 `'key':`、
 *      点号键 `key.with.dots:`、引号内空格 `"key with space":`），必须让判据④ 红并点名；
 *      同时钉住「宽的那一侧不能自阉割」：判据④ 是 `deepEqual(…, [])`，光靠它会漏掉「永远返回空」的阉割。
 *      两边一旦共用同一条键正则，`deepEqual` 就退化成同义反复，判据④ 等于没写（实测逃逸：5/5 全绿）。
 *
 * 三个数字**一律现场解析重算**，不硬编码「14 条臂 / 35 分钟」这类可漂移的量：臂 step 数、Σ封顶、
 * job 级数值都从 workflow 文本里读出来再算账。唯一写死的常量是**纪律本身**——每个臂 5 分钟、
 * 前置显式预留 10 分钟（checkout / setup-node / `npm ci` 这三条无封顶前置的合计上限）。
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

/** 前置显式预留（分钟）：checkout / setup-node / `npm ci` 这三条**无封顶**前置 step 的合计上限。 */
export const PREFIX_RESERVE_MINUTES = 10;

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
    steps.push({
      name: nameMatch === null || nameMatch === undefined ? null : nameMatch[1].trim(),
      timeout: timeoutMatch === null ? null : Number(timeoutMatch[1]),
      integrationScript: scriptMatch === null ? null : scriptMatch[1],
      lineNumber: lineOffset + from + 1,
    });
  }
  return steps;
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
  for (const job of parsed) {
    if (job.steps.length === 0) problems.push(`job \`${job.id}\` 解析不出任何 step ⇒ 判据② 的 Σ 会恒为 0`);
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

test('① 每个跑 `tests/integration/*.mjs` 的 step 都有自己的 5 分钟封顶', () => {
  assert.deepEqual(
    armTimeoutProblems(readWorkflow()),
    [],
    '真库臂 step 缺 step 级封顶：卡死时只能等 job 级超时，「这一步卡死」会被读成「job 超时」',
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

test('⑤ 判别力自证：删封顶／把封顶改成 120／把 job 级调小／删 job 级，四种变异都必须红', () => {
  const text = readWorkflow();

  const withoutCap = replaceStepTimeout(text, '第三方删除库层语义', null);
  assert.notEqual(withoutCap, text, '自证前提：删封顶必须真的改动了文本');
  const missing = armTimeoutProblems(withoutCap);
  assert.equal(missing.length, 1, `删掉一条步封顶必须正好报一处：${missing.join(' / ')}`);
  assert.ok(missing[0].includes('real-pg-17-11'), `报错必须打出 job 名：${missing[0]}`);
  assert.ok(missing[0].includes('第三方删除库层语义'), `报错必须打出 step 名：${missing[0]}`);

  const widened = replaceStepTimeout(text, '第三方删除库层语义', '        timeout-minutes: 120');
  const widenedProblems = armTimeoutProblems(widened);
  assert.equal(widenedProblems.length, 1, `把封顶改成 120 必须正好报一处：${widenedProblems.join(' / ')}`);
  assert.ok(widenedProblems[0].includes('120'), `报错必须打出实测值：${widenedProblems[0]}`);

  const crampedJob = replaceJobTimeout(text, 'real-pg-admin-write-17-11', '    timeout-minutes: 35');
  assert.notEqual(crampedJob, text, '自证前提：job 级数值必须真的被改动');
  const cramped = jobBudgetProblems(crampedJob);
  assert.equal(cramped.length, 1, `把 job 级调小到 Σ封顶附近必须正好报一处：${cramped.join(' / ')}`);
  assert.ok(cramped[0].includes('real-pg-admin-write-17-11'), `报错必须打出 job 名：${cramped[0]}`);
  assert.ok(cramped[0].includes('35'), `报错必须打出两边数字：${cramped[0]}`);

  const noJobTimeout = replaceJobTimeout(text, 'real-pg-admin-read-17-11', null);
  assert.equal(jobBudgetProblems(noJobTimeout).length, 1, '删掉 job 级超时必须正好报一处');

  // 注释与实测脱钩也算红：把 job 级数值改大但不改注释 ⇒ 判据③ 必须响。
  const driftedComment = replaceJobTimeout(text, 'real-pg-admin-read-17-11', '    timeout-minutes: 90');
  const driftProblems = commentArithmeticProblems(driftedComment);
  assert.equal(driftProblems.length, 1, `注释与实测脱钩必须正好报一处：${driftProblems.join(' / ')}`);
  assert.ok(driftProblems[0].includes('封顶之和 15 + 前置余量 10 = job 级 90'), `报错必须给出应有的算式：${driftProblems[0]}`);
});
