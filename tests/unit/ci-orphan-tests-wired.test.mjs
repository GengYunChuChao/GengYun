/**
 * CI 门禁：`tests/**\/*.test.mjs` 必须「有人跑」——被接线，或进白名单并写明理由（GY-R68）。
 *
 * 缺口（本片实测，基线 `4957b7dd`）：
 *   `package.json` 的 `test:unit` 只有 5 条 glob（`tests/{unit,privacy,media,reference,moderation}/*.test.mjs`），
 *   **`tests/*.test.mjs` 这一层不在任何 glob 里**。`tests/` 顶层 10 个 `*.test.mjs` 里 9 个靠某个
 *   workflow 的 `run:` 点名救回来，剩下的 `tests/demo-ui-components.test.mjs`（按钮／标签的禁用-加载
 *   守卫、搜索的受控 input/confirm/clear、样张宿主回写，3 条用例）在 15 份 workflow 里**0 命中**
 *   ⇒ 它坏成什么样 CI 都不会红，只能靠人肉记得在本地跑。本片把它接进 `engineering-shell.yml` 的
 *   `unit` job（`npm run test:unit` 之后单独一步），并用本守卫把「下一个孤儿」变成结构性红。
 *
 * 判类口径（一个文件只落一类，按此优先级）：
 *   ① COVERED：被**常跑** workflow（`on:` 里没有 `paths` 过滤）的 `run:` **命令文本**点名，
 *      或被这种 workflow 调用的某个 `npm run <script>` 的 `--test` glob ／显式文件覆盖；
 *      —— 两侧都要求「真被跑」：`run:` 只认命令文本，不认注释；npm 侧只认**真被调用的** script
 *      （`package.json` 里写了却没人在 workflow 里 `npm run` 它的 script，不算覆盖——那正是假绿）；
 *   ② CONDITIONAL：只被**带 `paths` 过滤**的 workflow 点名 ⇒ 只有相关路径变更时才跑。本片**不**接线
 *      这类（它们不是没人跑，而是「条件覆盖」），但必须进白名单并写明「哪个 workflow、为什么是条件」；
 *   ③ ORPHAN：两边都没有 ⇒ 必须进白名单，否则本守卫红。
 *
 * 五条判据：
 *   ① 扫描面下界：`tests/**\/*.test.mjs` 实测 **483** 个（含本文件），少于这个数即红（反空转：
 *      「一个文件都没扫到」也能全绿的话，本守卫等于没有）；
 *   ② 非 COVERED 的文件必须在白名单里、且 `reason` 非空 ⇒ 否则红并**逐条点名**文件；
 *   ③ COVERED 的文件**不得**出现在白名单里 ⇒ 出现即红：「这条白名单已过期，删掉它」（某人把它接进
 *      `test:unit` 或某个 workflow 之后，白名单条目就变成了「已解决缺口的历史残留」）；
 *   ④ 白名单里声明了 `workflow` 的条目，必须**仍然**被该 workflow 的 `run:` 点名 ⇒ 否则红
 *      （条件覆盖失效：step 被删了，它其实已经是真孤儿）；
 *   ⑤ 白名单条目指向的文件必须真实存在（改名／删除后条目即红）。
 *   另加反向控制：glob 匹配与 `run:` 点名这两条判据本身有牙齿——用**同一批函数**喂合成文本，
 *   确认「注释掉的 step 不算点名」「shell 注释不算」「`*` 不跨目录」「裸文件名提及不算」。
 *
 * 纯静态：只读 `.github/workflows/**`、根 `package.json` 与 `tests/**` 的文件名清单；
 * ⛔ 不起服务、不连库、不联网、不写任何文件、不新增依赖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根：由本文件位置推出（`tests/unit/` → `../..`），⛔ 不用 `process.cwd()`。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');
const TESTS_DIR = join(REPO_ROOT, 'tests');

/**
 * 扫描面下界：本片实测 `tests/**\/*.test.mjs` = **482** 个既有文件 ＋ 本文件 = **483**。
 * 用实测值做下界（不留余量）：删掉一批用例、或 `tests/` 目录被搬走，都必须先在这里红。
 * 只判「下界」不判「等于」：加新用例不该被这条拦。
 */
const SCAN_SURFACE_FLOOR = 483;

/**
 * 白名单：**非 COVERED** 的 `*.test.mjs` 必须在这里逐条写明理由。
 *
 * 当前 8 条**全是「条件覆盖」**（判类②）：它们确实被某个 workflow 跑，但那个 workflow 由 `paths`
 * 过滤触发——只有命中列出的路径时才跑，不是每次 PR 都跑。本片按任务口径**不**把它们改成常跑
 * （那会把真凭据／微信工具依赖拖进每个 PR 的门禁面），只把这件事写死在结构里：
 * 哪天有人删掉那条 step，本守卫的判据④就会红，而不是悄悄变成孤儿。
 * 另：`tests/demo-ui-components.test.mjs` 曾经是唯一的真孤儿（判类③），本片已把它接进
 * `engineering-shell.yml` 的 `unit` job ⇒ 它现在必须是 COVERED，**不得**再出现在这里。
 */
const WHITELIST = Object.freeze([
  {
    file: 'tests/ai-config.test.mjs',
    workflow: 'access-verification.yml',
    reason: '条件覆盖：只在 access-verification.yml 的 paths 命中（tools/ai-config.mjs、tools/verify-* 等）时才跑，非每次 PR 必跑',
  },
  {
    file: 'tests/llm-live.test.mjs',
    workflow: 'access-verification.yml',
    reason: '条件覆盖：只在 access-verification.yml 的 paths 命中（tools/verify-llm-live.mjs 等）时才跑，非每次 PR 必跑',
  },
  {
    file: 'tests/local-debug.test.mjs',
    workflow: 'local-wechat.yml',
    reason: '条件覆盖：只在 local-wechat.yml 的 paths 命中（miniprogram/**、project*.json* 等）时才跑，非每次 PR 必跑',
  },
  {
    file: 'tests/tencent-live.test.mjs',
    workflow: 'access-verification.yml',
    reason: '条件覆盖：只在 access-verification.yml 的 paths 命中（tools/verify-tencent-live.mjs 等）时才跑，非每次 PR 必跑',
  },
  {
    file: 'tests/tokenhub-account.test.mjs',
    workflow: 'access-verification.yml',
    reason: '条件覆盖：只在 access-verification.yml 的 paths 命中（tools/verify-tokenhub.mjs 等）时才跑，非每次 PR 必跑',
  },
  {
    file: 'tests/ui-adaptive.test.mjs',
    workflow: 'local-wechat.yml',
    reason: '条件覆盖：只在 local-wechat.yml 的 paths 命中（miniprogram/**、docs/ui-demo/** 等）时才跑，非每次 PR 必跑',
  },
  {
    file: 'tests/ui-demo-align.test.mjs',
    workflow: 'local-wechat.yml',
    reason: '条件覆盖：只在 local-wechat.yml 的 paths 命中（docs/ui-demo/**、miniprogram/** 等）时才跑，非每次 PR 必跑',
  },
  {
    file: 'tests/verify-env.test.mjs',
    workflow: 'access-verification.yml',
    reason: '条件覆盖：只在 access-verification.yml 的 paths 命中（tools/verify-env.mjs、docs/verification/** 等）时才跑，非每次 PR 必跑',
  },
]);

/** 路径统一成正斜杠，跟 workflow／`package.json` 里写的形态对齐（Windows 上不能拿 `\` 比）。 */
function toPosix(value) {
  return value.split('\\').join('/');
}

/** 递归收集 `tests/` 下全部 `*.test.mjs`（含子目录），返回相对仓库根的正斜杠路径。 */
function listTestFiles(dir = TESTS_DIR, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      listTestFiles(abs, acc);
      continue;
    }
    if (entry.name.endsWith('.test.mjs')) acc.push(toPosix(abs.slice(REPO_ROOT.length + 1)));
  }
  return acc.sort();
}

/**
 * glob → RegExp：只支持本仓 `--test` 里实际用到的两种元字符。
 * `*` **不跨目录**（`tests/unit/*.test.mjs` 不匹配 `tests/unit/deep/a.test.mjs`），`**\/` 跨目录。
 */
function globToRegExp(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === '*') {
      if (glob[i + 1] === '*') {
        source += '(?:.*/)?';
        i += 1;
        if (glob[i + 1] === '/') i += 1;
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

/**
 * 解析一份 workflow 的**文本**，只取两样东西：
 *   · `runs`：每个 `run:` step 的**命令文本**（单行 `run: xxx` 与 `run: |`／`run: >` 块标量的正文
 *     都算；`#` 开头的 YAML 注释行不算，块标量里的 `#` shell 注释行同样不算）＋ 行号；
 *   · `hasPaths`：这份 workflow 的触发是否被 `paths`／`paths-ignore` 过滤过（＝条件覆盖）。
 * 刻意不引 YAML 解析器（本仓 unit 层不新增依赖，口径同 `ci-real-pg-wiring.test.mjs`）。
 */
function parseWorkflow(text) {
  const lines = text.split(/\r?\n/);
  const runs = [];
  let hasPaths = false;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const trimmed = raw.trimStart();
    if (trimmed.startsWith('#')) continue;
    if (/^paths(-ignore)?:/.test(trimmed)) hasPaths = true;
    const match = /^(\s*)(?:-\s*)?run:\s*(.*)$/.exec(raw);
    if (!match) continue;
    const indent = match[1].length;
    const rest = match[2].trim();
    if (rest === '' || /^[|>][+-]?$/.test(rest)) {
      for (let j = i + 1; j < lines.length; j += 1) {
        const body = lines[j];
        if (body.trim() === '') continue;
        if (body.length - body.trimStart().length <= indent) break;
        const bodyTrimmed = body.trim();
        if (bodyTrimmed.startsWith('#')) continue;
        runs.push({ line: j + 1, text: bodyTrimmed });
      }
    } else {
      runs.push({ line: i + 1, text: rest.replace(/^['"]|['"]$/g, '') });
    }
  }
  return { runs, hasPaths };
}

/**
 * 一段命令文本里是否**点名**了这个文件。
 * 按空白／引号切词，只认「整词相等」或「带 `*` 且 glob 命中」——裸文件名提及（少写目录、
 * 写成 `demo-ui-components` 之类）不算点名，这是「点名」与「文案里提过一句」的分界。
 */
function namesFile(commandText, file) {
  return commandText
    .split(/[\s"'`;|&()]+/)
    .filter(Boolean)
    .some((token) => token === file || (token.includes('*') && globToRegExp(token).test(file)));
}

/** 一份 workflow 里被 `npm run <script>` 调用过的 script 名（`npm test` 也算 `test`）。 */
function invokedScriptNames(runs) {
  const names = new Set();
  for (const run of runs) {
    const pattern = /npm\s+run\s+([A-Za-z0-9:_-]+)/g;
    let match;
    while ((match = pattern.exec(run.text)) !== null) names.add(match[1]);
    if (/\bnpm\s+test\b/.test(run.text)) names.add('test');
  }
  return names;
}

/**
 * 覆盖模型：根 `package.json` 里**带 `--test` 目标**的 script（glob 或显式文件）
 * ＋ 15 份 workflow 的 `run:` 命令文本与触发条件。
 */
function loadCoverageModel() {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  const scriptTargets = new Map();
  for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
    const targets = String(command)
      .split(/\s+/)
      .map((token) => token.replace(/^['"]|['"]$/g, ''))
      .filter((token) => token.endsWith('.test.mjs'));
    if (targets.length > 0) scriptTargets.set(name, targets);
  }
  const workflows = readdirSync(WORKFLOW_DIR)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort()
    .map((name) => {
      const { runs, hasPaths } = parseWorkflow(readFileSync(join(WORKFLOW_DIR, name), 'utf8'));
      return { name, runs, hasPaths, invokes: invokedScriptNames(runs) };
    });
  return { scriptTargets, workflows };
}

const MODEL = loadCoverageModel();

/**
 * 判类：返回 `{ status, evidence }`，`evidence` 是「谁在跑它」的可读证据（红的时候直接贴给人看）。
 * `model` 可注入 —— 反向控制用合成模型喂**同一批**判据函数，避免「正向断言绿、反向控制另写一套」。
 */
function classify(file, model = MODEL) {
  const coveredBy = [];
  const conditionalBy = [];
  for (const workflow of model.workflows) {
    const bucket = workflow.hasPaths ? conditionalBy : coveredBy;
    for (const run of workflow.runs) {
      if (namesFile(run.text, file)) bucket.push(`${workflow.name} 的 run: 第 ${run.line} 行`);
    }
    for (const script of workflow.invokes) {
      for (const pattern of model.scriptTargets.get(script) ?? []) {
        const hit = pattern.includes('*') ? globToRegExp(pattern).test(file) : pattern === file;
        if (hit) bucket.push(`${workflow.name} 调用的 \`npm run ${script}\`（\`${pattern}\`）`);
      }
    }
  }
  if (coveredBy.length > 0) return { status: 'COVERED', evidence: coveredBy };
  if (conditionalBy.length > 0) return { status: 'CONDITIONAL', evidence: conditionalBy };
  return { status: 'ORPHAN', evidence: [] };
}

/** 白名单索引：文件 → 条目。 */
const WHITELIST_BY_FILE = new Map(WHITELIST.map((entry) => [entry.file, entry]));

test('① 扫描面下界：tests/**/*.test.mjs 不少于实测读数（反空转）', () => {
  const files = listTestFiles();
  assert.ok(
    files.length >= SCAN_SURFACE_FLOOR,
    `扫描面缩水：本片实测 ${SCAN_SURFACE_FLOOR} 个 tests/**/*.test.mjs，现在只扫到 ${files.length} 个。`
    + '\n本守卫靠「扫到的文件清单」判覆盖；扫描面塌了它就只会空转全绿，所以先在这条红。',
  );
});

test('② 白名单之外的孤儿用例 ⇒ 红并点名', () => {
  const offenders = [];
  for (const file of listTestFiles()) {
    const { status, evidence } = classify(file);
    const isCovered = status === 'COVERED';
    const entry = WHITELIST_BY_FILE.get(file);
    if (isCovered) continue;
    if (entry) {
      assert.ok(
        typeof entry.reason === 'string' && entry.reason.trim() !== '',
        `白名单条目缺理由：\`${file}\`。白名单的作用是把「为什么它没人跑／只条件跑」写死在结构里，`
        + '空理由等于把缺口藏起来；请补一句可核对的原因。',
      );
      continue;
    }
    offenders.push(`\`${file}\`（判类 ${status}${evidence.length ? `，唯一证据：${evidence.join('；')}` : ''}）`);
  }
  assert.deepEqual(
    offenders,
    [],
    '以下 `*.test.mjs` 既没被任何 workflow 的 `run:` 点名、也不在任何 `--test` glob 里，'
    + `且不在白名单（共 ${offenders.length} 个）：\n  - ${offenders.join('\n  - ')}\n`
    + '修法二选一：'
    + '\n  (a) 接线：跑一遍 `node --test <file>`，绿了就在 `engineering-shell.yml` 的 `unit` job 里'
    + '加一步 `run: node --test <file>`（⛔ 别改 `test:unit` 的 glob，那会牵动别人的 PR 与本地习惯）；'
    + '\n  (b) 进白名单：在 `WHITELIST` 里加 `{ file, workflow?, reason }` 写明为什么它不该每次 PR 都跑。',
  );
});

test('③ 白名单不得过期：已接线（COVERED）的文件必须从白名单里删掉', () => {
  const stale = [];
  for (const entry of WHITELIST) {
    const { status, evidence } = classify(entry.file);
    if (status === 'COVERED') {
      stale.push(`\`${entry.file}\` 已被常跑覆盖（${evidence[0]}）——这条白名单已过期，删掉它`);
    }
  }
  assert.deepEqual(
    stale,
    [],
    `白名单里有 ${stale.length} 条已过期（缺口已经不存在了，留着它会让后来人以为还有缺口）：\n  - ${stale.join('\n  - ')}`,
  );
});

test('④ 条件覆盖的白名单条目必须仍然成立，且指向的文件必须存在', () => {
  const files = new Set(listTestFiles());
  const problems = [];
  for (const entry of WHITELIST) {
    if (!files.has(entry.file)) {
      problems.push(`\`${entry.file}\` 不在扫描面里（文件被改名或删除？）——删掉这条白名单`);
      continue;
    }
    if (!entry.workflow) continue;
    const workflow = MODEL.workflows.find((candidate) => candidate.name === entry.workflow);
    if (!workflow) {
      problems.push(`\`${entry.file}\` 声明的 workflow \`${entry.workflow}\` 不存在——改指向或删掉这条白名单`);
      continue;
    }
    const stillNamed = workflow.runs.some((run) => namesFile(run.text, entry.file));
    if (!stillNamed) {
      problems.push(`\`${entry.file}\` 已不再被 \`${entry.workflow}\` 的 \`run:\` 点名——条件覆盖失效，它现在是真孤儿`);
    }
  }
  assert.deepEqual(
    problems,
    [],
    `白名单有 ${problems.length} 条与事实不符：\n  - ${problems.join('\n  - ')}\n`
    + '这些条目此前的作用是「登记条件覆盖」；step 被删掉之后它们会掩盖一个真孤儿。',
  );
});

test('⑤ 反向控制：glob 匹配与 run: 点名这两条判据本身有牙齿', () => {
  // `*` 不跨目录：`tests/unit/*.test.mjs` 不能把子目录里的用例也算成覆盖。
  assert.equal(globToRegExp('tests/unit/*.test.mjs').test('tests/unit/a.test.mjs'), true);
  assert.equal(globToRegExp('tests/unit/*.test.mjs').test('tests/unit/deep/a.test.mjs'), false);
  // 注释掉的 step 不算点名；真正在跑的那一步算。
  const commented = parseWorkflow([
    'jobs:',
    '  a:',
    '    steps:',
    '      # - run: node --test tests/ghost.test.mjs',
    '      - run: node --test tests/live.test.mjs',
    '',
  ].join('\n'));
  assert.equal(commented.runs.some((run) => namesFile(run.text, 'tests/ghost.test.mjs')), false);
  assert.equal(commented.runs.some((run) => namesFile(run.text, 'tests/live.test.mjs')), true);
  // 块标量里的 shell 注释同样不算点名。
  const block = parseWorkflow([
    'jobs:',
    '  a:',
    '    steps:',
    '      - run: |',
    '          # node --test tests/ghost.test.mjs',
    '          node --test tests/live.test.mjs',
    '',
  ].join('\n'));
  assert.equal(block.runs.some((run) => namesFile(run.text, 'tests/ghost.test.mjs')), false);
  assert.equal(block.runs.some((run) => namesFile(run.text, 'tests/live.test.mjs')), true);
  // 判类三档都能各自命中，且 `paths` 过滤的 workflow 只产出 CONDITIONAL。
  const synthetic = {
    scriptTargets: new Map([['test:demo', ['tests/demo/*.test.mjs']]]),
    workflows: [
      { name: 'always.yml', hasPaths: false, runs: [{ line: 1, text: 'node --test tests/named.test.mjs' }], invokes: new Set(['test:demo']) },
      { name: 'gated.yml', hasPaths: true, runs: [{ line: 2, text: 'node --test tests/gated.test.mjs' }], invokes: new Set() },
    ],
  };
  assert.equal(classify('tests/named.test.mjs', synthetic).status, 'COVERED');
  assert.equal(classify('tests/demo/globbed.test.mjs', synthetic).status, 'COVERED');
  assert.equal(classify('tests/gated.test.mjs', synthetic).status, 'CONDITIONAL');
  assert.equal(classify('tests/nobody.test.mjs', synthetic).status, 'ORPHAN');
  // `package.json` 里写了 glob 但没人在 workflow 里 `npm run` 它 ⇒ 不算覆盖（这正是本片要防的假绿）。
  const orphanScript = {
    scriptTargets: new Map([['test:unused', ['tests/demo/*.test.mjs']]]),
    workflows: [{ name: 'always.yml', hasPaths: false, runs: [], invokes: new Set() }],
  };
  assert.equal(classify('tests/demo/globbed.test.mjs', orphanScript).status, 'ORPHAN');
});
